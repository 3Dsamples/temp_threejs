// file number : 282_Z01
// full path name : src/context/282_Z01_ReliefGradientProvider.js
// description : Relief (landform) gradient provider that classifies macro-scale terrain relief shapes — peaks, ridges, saddles, plateaus, valleys, basins, channels, and flat plains — for the living world. Builds directly on 281_ElevationProvider and 282_SlopeGradientProvider: it reads the elevation field and slope descriptors from those providers (or from frame.layers.spatial.terrainChunks when they are not attached), then performs a Hessian eigen-analysis of the heightfield at each sample point to determine the principal curvatures (λ₁ ≥ λ₂), their principal directions, and the resulting relief class. Classification rules: both λ < 0 → PEAK (local maximum); both λ > 0 → BASIN (local minimum); λ₁ > 0, λ₂ < 0 → SADDLE; strongly negative λ₂ with weak λ₁ → RIDGE (crest with ridge-line direction from the eigenvector of λ₁); strongly positive λ₂ with weak λ₁ → VALLEY/CHANNEL (with valley-line direction); both near zero with strong gradient → SLOPE; both near zero with weak gradient → FLAT. Every classification is also given a relief-strength scalar (0..1) and a prominence estimate that consumers use to weight the feature. Writes per-entity relief descriptors into frame.layers.spatial.relief (reliefClass, principalCurvatureMax, principalCurvatureMin, reliefStrength, prominence, ridgeDirection, valleyDirection, peakPositionHint) and per-chunk relief summaries into frame.layers.spatial.reliefChunks. This is the foundation for realistic ridge-line pathing, water-channel routing, panoramic viewpoint detection, wind-exposure classification, biome assignment, and both flora and fauna placement. All scratch vectors are pooled; no allocation after the first frame.
// best for : Every consumer that needs macro-scale terrain landform understanding — biome assignment (ridges = alpine, valleys = temperate, basins = wetland, plateaus = grassland), water routing (valley lines feed LandscapeWaterFlowSystem), wind exposure (ridge crests get maximum wind, valleys get shelter), flora placement (ridges get rock plants, valleys get water plants, saddles get transitional flora), fauna migration routes (ridges and valleys are natural corridors), and camera framing (peaks and saddle saddles are landmarks). This provider turns a heightfield into a structured landform map.
// license : MIT

import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision,
  ContextFrame, CoreClock, CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES,
  TemporalContextProvider, WEATHER,
  CausalContextProvider, DERIVED_SIGNAL,
  CoreLayers, LAYER, LAYER_MASKS,
  smoothstep,
  TerrainProvider, BIOME_HINT,
  ElevationProvider, ELEVATION_BAND,
  SlopeGradientProvider, SLOPE_BAND, SLOPE_BAND_THRESHOLDS
} from './264_MathECSImportBarrel.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 2;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── relief class codes ─────────────────────────────────────────
const RELIEF_CLASS = Object.freeze({
  UNKNOWN:   0,
  PEAK:      1,   // local maximum
  RIDGE:     2,   // convex crest line
  SADDLE:    3,   // one concave, one convex axis (mountain pass)
  PLATEAU:   4,   // broad flat high area
  SLOPE:     5,   // uniform gradient, no curvature
  VALLEY:    6,   // concave channel line
  BASIN:     7,   // local minimum (bowl, lakebed, sink)
  CHANNEL:   8,   // narrow valley (ravine, gorge)
  FLAT:      9    // flat plain
});

const RELIEF_CLASS_NAMES = Object.freeze([
  'unknown', 'peak', 'ridge', 'saddle', 'plateau',
  'slope', 'valley', 'basin', 'channel', 'flat'
]);

// ─── classification thresholds (all in units where h is metres, d is metres) ─
const RELIEF_THRESHOLDS = Object.freeze({
  // Curvature magnitude below which the surface is considered flat in
  // that principal direction (metres per square metre).
  curvatureFlat:         0.005,
  curvatureStrong:       0.020,
  // Hessian anisotropy below which the surface is considered equally
  // curved in both directions (isotropic peak/basin).
  anisotropyIsotropic:   0.30,
  // Gradient magnitude below which flat-or-slope classification
  // collapses to FLAT (m/m).
  gradFlatThreshold:     0.02,
  // Gradient magnitude above which SLOPE is preferred over FLAT (m/m).
  gradSlopeThreshold:    0.10,
  // Minimum height above local mean to be considered a peak.
  peakProminenceMin:     5.0,        // metres
  // Minimum depth below local mean to be considered a basin.
  basinProminenceMin:    5.0,        // metres
  // Ridge crest: λ₂ must be less than −curvatureStrong and |λ₁| small.
  ridgeCrestRatio:       0.50,
  // Valley channel: λ₁ must be greater than +curvatureStrong and |λ₂| small.
  valleyCrestRatio:      0.50
});

// ─── default sample distance for Hessian computation ────────────
const RELIEF_SAMPLE_DISTANCE = 8.0;

// ─── default relief colour palette for material blending ────────
const RELIEF_COLORS = Object.freeze({
  [RELIEF_CLASS.PEAK]:    [0.85, 0.85, 0.90],   // snowy white
  [RELIEF_CLASS.RIDGE]:   [0.60, 0.58, 0.52],   // rocky grey-brown
  [RELIEF_CLASS.SADDLE]:  [0.55, 0.52, 0.48],   // mixed
  [RELIEF_CLASS.PLATEAU]: [0.55, 0.52, 0.35],   // dry grass
  [RELIEF_CLASS.SLOPE]:   [0.48, 0.55, 0.30],   // mixed grass
  [RELIEF_CLASS.VALLEY]:  [0.42, 0.58, 0.32],   // lush green
  [RELIEF_CLASS.BASIN]:   [0.35, 0.45, 0.35],   // wetland
  [RELIEF_CLASS.CHANNEL]: [0.30, 0.42, 0.32],   // wet gorge
  [RELIEF_CLASS.FLAT]:    [0.48, 0.62, 0.32]    // open grass
});

class ReliefGradientProvider {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.sampleDistance = options.sampleDistance ?? RELIEF_SAMPLE_DISTANCE;
    this.thresholds = { ...RELIEF_THRESHOLDS, ...(options.thresholds || {}) };
    this.enablePeakProminence = options.enablePeakProminence ?? true;
    this.enableBasinProminence = options.enableBasinProminence ?? true;
    this.prominenceSampleRadius = options.prominenceSampleRadius ?? 32.0;

    // ── scratch (pooled, never allocated after construction) ─
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVecD = new Vec3();
    this._tmpMatA = new Mat4();

    // ── per-entity relief cache (flat SoA) ──────────────────
    const capacity = options.entityCacheCapacity ?? 2048;
    this._entityCapacity = capacity;
    this._entityReliefClass      = new Uint8Array(capacity);
    this._entityLambdaMax        = new Float32Array(capacity);   // λ₁ (max principal curvature)
    this._entityLambdaMin        = new Float32Array(capacity);   // λ₂ (min principal curvature)
    this._entityAnisotropy       = new Float32Array(capacity);   // (λ₁ - λ₂) / (|λ₁| + |λ₂| + ε)
    this._entityReliefStrength   = new Float32Array(capacity);   // 0..1
    this._entityProminence       = new Float32Array(capacity);   // metres
    this._entityRidgeDirX        = new Float32Array(capacity);
    this._entityRidgeDirZ        = new Float32Array(capacity);
    this._entityValleyDirX       = new Float32Array(capacity);
    this._entityValleyDirZ       = new Float32Array(capacity);
    this._entityPeakHintX        = new Float32Array(capacity);
    this._entityPeakHintZ        = new Float32Array(capacity);
    this._entityReliefColor      = new Float32Array(capacity * 3);
    this._entityValid            = new Uint8Array(capacity);

    // ── per-chunk relief summary ────────────────────────────
    this._chunkCapacity = options.chunkCacheCapacity ?? 512;
    this._chunkDominantRelief   = new Uint8Array(this._chunkCapacity);
    this._chunkPeakCount        = new Uint16Array(this._chunkCapacity);
    this._chunkRidgeCount       = new Uint16Array(this._chunkCapacity);
    this._chunkValleyCount      = new Uint16Array(this._chunkCapacity);
    this._chunkMaxReliefStrength = new Float32Array(this._chunkCapacity);
    this._chunkMaxProminence    = new Float32Array(this._chunkCapacity);
    this._chunkValid            = new Uint8Array(this._chunkCapacity);

    // ── per-class distribution of relief features (for stats) ──
    this._globalClassCounts = new Uint32Array(RELIEF_CLASS_NAMES.length);

    // ── diagnostics ────────────────────────────────────────
    this._stats = {
      updates: 0,
      entitiesSampled: 0,
      chunksSummary: 0,
      hessianComputes: 0,
      eigenvalueComputes: 0,
      prominenceComputes: 0,
      peaksDetected: 0,
      ridgesDetected: 0,
      valleysDetected: 0,
      basinsDetected: 0,
      saddlesDetected: 0,
      plateausDetected: 0,
      flatsDetected: 0,
      channelsDetected: 0,
      slopesDetected: 0,
      interpolated: 0
    };

    // ── timing / frame reference ───────────────────────────
    this._lastUpdateTime = -Infinity;
    this._frameRef = null;

    // ── optional direct references to collaborators ────────
    this._terrain = options.terrain || null;
    this._elevation = options.elevation || null;
    this._slope = options.slope || null;
  }

  // ══════════════════════════════════════════════════════════
  // ─── collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachTerrain(terrain) { this._terrain = terrain; return this; }
  attachElevation(elevation) { this._elevation = elevation; return this; }
  attachSlope(slope) { this._slope = slope; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── height lookup (delegation chain) ────────────────────
  // ══════════════════════════════════════════════════════════
  _getHeight(wx, wz, lod = 0) {
    if (this._elevation) return this._elevation.getElevation(wx, wz, lod);
    if (this._terrain) return this._terrain.getHeight(wx, wz, lod);
    const tc = this._frameRef?.layers?.spatial?.terrainChunks;
    if (!tc || tc.count === 0) return 0;
    return this._interpolateFromChunks(tc, wx, wz);
  }

  _interpolateFromChunks(tc, wx, wz) {
    const chunkSize = this._terrain ? this._terrain.chunkSize : 1000;
    const cx = Math.floor(wx / chunkSize);
    const cz = Math.floor(wz / chunkSize);
    let wSum = 0, hSum = 0;
    for (let i = 0; i < tc.count; i++) {
      const dcx = tc.cx[i] - cx;
      const dcz = tc.cz[i] - cz;
      const d2 = dcx * dcx + dcz * dcz + 1e-6;
      if (d2 > 4) continue;
      const w = 1.0 / d2;
      const avg = (tc.minY[i] + tc.maxY[i]) * 0.5;
      hSum += avg * w;
      wSum += w;
      this._stats.interpolated++;
    }
    return wSum > 0 ? hSum / wSum : 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Hessian + eigen-analysis ────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Computes ∂²h/∂x², ∂²h/∂z², ∂²h/∂x∂z via central differences on
  // a 3x3 neighbourhood, then solves the 2x2 symmetric eigenvalue
  // problem to get the principal curvatures λ₁ ≥ λ₂ and their
  // principal directions.
  _computeHessian(wx, wz) {
    this._stats.hessianComputes++;
    const d = this.sampleDistance;
    const invd2 = 1 / (d * d);
    const inv4d2 = 1 / (4 * d * d);

    const h00 = this._getHeight(wx - d, wz - d);
    const h01 = this._getHeight(wx,     wz - d);
    const h02 = this._getHeight(wx + d, wz - d);
    const h10 = this._getHeight(wx - d, wz);
    const h11 = this._getHeight(wx,     wz);
    const h12 = this._getHeight(wx + d, wz);
    const h20 = this._getHeight(wx - d, wz + d);
    const h21 = this._getHeight(wx,     wz + d);
    const h22 = this._getHeight(wx + d, wz + d);

    const hxx = (h12 - 2 * h11 + h10) * invd2;
    const hzz = (h21 - 2 * h11 + h01) * invd2;
    const hxz = (h22 - h20 - h02 + h00) * inv4d2;

    return { hxx, hzz, hxz, h11 };
  }

  // Solves the 2x2 symmetric eigenvalue problem:
  //   [hxx  hxz] [v]      [v]
  //   [hxz  hzz] [w] = λ [w]
  // λ₁ ≥ λ₂, v₁ → eigenvector of λ₁, v₂ → eigenvector of λ₂.
  _solveEigen(hxx, hzz, hxz) {
    this._stats.eigenvalueComputes++;
    const trace = hxx + hzz;
    const diff = hxx - hzz;
    const disc = Math.sqrt(diff * diff / 4 + hxz * hxz);
    const lambdaMax = trace / 2 + disc;
    const lambdaMin = trace / 2 - disc;

    // Eigenvectors: for a 2x2 symmetric matrix the eigenvector for
    // λ is (hxz, λ - hxx) normalized, or (λ - hzz, hxz) if hxz ≈ 0.
    let vMaxX, vMaxZ, vMinX, vMinZ;
    if (Math.abs(hxz) > 1e-6) {
      vMaxX = hxz;
      vMaxZ = lambdaMax - hxx;
      const magMax = Math.sqrt(vMaxX * vMaxX + vMaxZ * vMaxZ) || 1;
      vMaxX /= magMax;
      vMaxZ /= magMax;

      vMinX = -vMaxZ;
      vMinZ = vMaxX;
    } else {
      // Diagonal matrix: eigenvectors are (1,0) and (0,1).
      if (hxx >= hzz) {
        vMaxX = 1; vMaxZ = 0;
        vMinX = 0; vMinZ = 1;
      } else {
        vMaxX = 0; vMaxZ = 1;
        vMinX = 1; vMinZ = 0;
      }
    }

    return {
      lambdaMax, lambdaMin,
      vMaxX, vMaxZ,
      vMinX, vMinZ
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── prominence estimation ───────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Simple ring-based prominence: sample heights at a fixed radius
  // around the point and take the minimum as the "key col" estimate.
  // Real topographic prominence uses the col between a peak and the
  // next higher peak; this simplified version is fast enough for
  // per-frame use and gives a stable relative ordering.
  _computeProminence(wx, wz, centreHeight) {
    this._stats.prominenceComputes++;
    const r = this.prominenceSampleRadius;
    let minRing = Infinity;
    const angles = 8;
    for (let i = 0; i < angles; i++) {
      const a = (i / angles) * 2 * Math.PI;
      const h = this._getHeight(
        wx + Math.cos(a) * r,
        wz + Math.sin(a) * r
      );
      if (h < minRing) minRing = h;
    }
    if (minRing === Infinity) return 0;
    return Math.max(0, centreHeight - minRing);
  }

  // ══════════════════════════════════════════════════════════
  // ─── relief classification (single point) ────────────────
  // ══════════════════════════════════════════════════════════
  classifyRelief(wx, wz) {
    const hess = this._computeHessian(wx, wz);
    const eig = this._solveEigen(hess.hxx, hess.hzz, hess.hxz);
    const lam1 = eig.lambdaMax;
    const lam2 = eig.lambdaMin;

    // Gradient magnitude (already computed in Hessian via h11).
    const d = this.sampleDistance;
    const hL = this._getHeight(wx - d, wz);
    const hR = this._getHeight(wx + d, wz);
    const hD = this._getHeight(wx, wz - d);
    const hU = this._getHeight(wx, wz + d);
    const dhdx = (hR - hL) / (2 * d);
    const dhdz = (hU - hD) / (2 * d);
    const gradMag = Math.sqrt(dhdx * dhdx + dhdz * dhdz);

    const t = this.thresholds;
    const anisotropy = (Math.abs(lam1) + Math.abs(lam2)) > 1e-9
      ? (Math.abs(lam1) - Math.abs(lam2)) / (Math.abs(lam1) + Math.abs(lam2))
      : 0;

    let reliefClass = RELIEF_CLASS.UNKNOWN;

    if (Math.abs(lam1) < t.curvatureFlat && Math.abs(lam2) < t.curvatureFlat) {
      // Nearly flat in both directions.
      if (gradMag < t.gradFlatThreshold) {
        reliefClass = RELIEF_CLASS.FLAT;
      } else {
        reliefClass = RELIEF_CLASS.SLOPE;
      }
    } else if (anisotropy > 1 - t.anisotropyIsotropic) {
      // Strongly anisotropic: one curvature dominates.
      if (Math.abs(lam2) < Math.abs(lam1) * t.ridgeCrestRatio) {
        // λ₁ dominates. If λ₁ > 0 → convex in the strong direction → RIDGE.
        // If λ₁ < 0 → concave in the strong direction → VALLEY.
        reliefClass = lam1 > 0 ? RELIEF_CLASS.RIDGE : RELIEF_CLASS.VALLEY;
        // Very strong narrow valley → CHANNEL.
        if (reliefClass === RELIEF_CLASS.VALLEY && Math.abs(lam1) > t.curvatureStrong * 2) {
          reliefClass = RELIEF_CLASS.CHANNEL;
        }
      } else if (Math.abs(lam1) < Math.abs(lam2) * t.valleyCrestRatio) {
        // λ₂ dominates (rare given λ₁ ≥ λ₂, but can happen for very
        // shallow saddles).
        reliefClass = lam2 > 0 ? RELIEF_CLASS.RIDGE : RELIEF_CLASS.VALLEY;
      } else {
        reliefClass = RELIEF_CLASS.SLOPE;
      }
    } else {
      // Isotropic or mixed curvature: use signs of both eigenvalues.
      const strong1 = Math.abs(lam1) > t.curvatureStrong;
      const strong2 = Math.abs(lam2) > t.curvatureStrong;

      if (lam1 > 0 && lam2 > 0 && strong2) {
        reliefClass = RELIEF_CLASS.BASIN;
      } else if (lam1 < 0 && lam2 < 0 && strong2) {
        reliefClass = RELIEF_CLASS.PEAK;
      } else if (lam1 > 0 && lam2 < 0) {
        reliefClass = RELIEF_CLASS.SADDLE;
      } else if (lam1 > 0 && lam2 < t.curvatureFlat) {
        reliefClass = RELIEF_CLASS.SLOPE;
      } else if (strong1 && lam1 < 0) {
        reliefClass = RELIEF_CLASS.PEAK;
      } else {
        reliefClass = RELIEF_CLASS.SLOPE;
      }
    }

    // Plateau: broad nearly-flat area at high altitude. Detected by
    // weak curvature + moderate gradient + high elevation.
    if (reliefClass === RELIEF_CLASS.FLAT && hess.h11 > 500) {
      reliefClass = RELIEF_CLASS.PLATEAU;
    }

    // Prominence for peaks and basins.
    let prominence = 0;
    if ((reliefClass === RELIEF_CLASS.PEAK && this.enablePeakProminence) ||
        (reliefClass === RELIEF_CLASS.BASIN && this.enableBasinProminence)) {
      prominence = this._computeProminence(wx, wz, hess.h11);
      if (reliefClass === RELIEF_CLASS.PEAK && prominence < t.peakProminenceMin) {
        // Weak prominence peak becomes ridge/slope.
        reliefClass = gradMag > t.gradSlopeThreshold ? RELIEF_CLASS.RIDGE : RELIEF_CLASS.SLOPE;
      }
      if (reliefClass === RELIEF_CLASS.BASIN && prominence < t.basinProminenceMin) {
        reliefClass = gradMag > t.gradSlopeThreshold ? RELIEF_CLASS.SLOPE : RELIEF_CLASS.FLAT;
      }
    }

    // ── record stats ───────────────────────────────────────
    if (reliefClass >= 0 && reliefClass < this._globalClassCounts.length) {
      this._globalClassCounts[reliefClass]++;
    }
    switch (reliefClass) {
      case RELIEF_CLASS.PEAK:    this._stats.peaksDetected++; break;
      case RELIEF_CLASS.RIDGE:   this._stats.ridgesDetected++; break;
      case RELIEF_CLASS.SADDLE:  this._stats.saddlesDetected++; break;
      case RELIEF_CLASS.PLATEAU: this._stats.plateausDetected++; break;
      case RELIEF_CLASS.SLOPE:   this._stats.slopesDetected++; break;
      case RELIEF_CLASS.VALLEY:  this._stats.valleysDetected++; break;
      case RELIEF_CLASS.BASIN:   this._stats.basinsDetected++; break;
      case RELIEF_CLASS.CHANNEL: this._stats.channelsDetected++; break;
      case RELIEF_CLASS.FLAT:    this._stats.flatsDetected++; break;
    }

    // ── relief strength 0..1 ────────────────────────────────
    const strengthDenom = t.curvatureStrong * 2;
    const reliefStrength = Math.min(1, (Math.abs(lam1) + Math.abs(lam2)) / strengthDenom);

    return {
      reliefClass,
      lambdaMax: lam1,
      lambdaMin: lam2,
      anisotropy,
      reliefStrength,
      prominence,
      gradMag,
      ridgeDirX: eig.vMaxX,
      ridgeDirZ: eig.vMaxZ,
      valleyDirX: eig.vMinX,
      valleyDirZ: eig.vMinZ,
      height: hess.h11
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── per-entity sampling ─────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _sampleEntities(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial || !spatial.sphere) return 0;

    const sphere = spatial.sphere;
    const n = Math.min(sphere.length / 4, this._entityCapacity);
    let sampled = 0;

    for (let i = 0; i < n; i++) {
      const so = i * 4;
      const sx = sphere[so];
      const sz = sphere[so + 2];

      const r = this.classifyRelief(sx, sz);

      this._entityReliefClass[i] = r.reliefClass;
      this._entityLambdaMax[i] = r.lambdaMax;
      this._entityLambdaMin[i] = r.lambdaMin;
      this._entityAnisotropy[i] = r.anisotropy;
      this._entityReliefStrength[i] = r.reliefStrength;
      this._entityProminence[i] = r.prominence;

      // For RIDGE, the ridge-line direction is along the eigenvector
      // of λ₁ (the strong convex axis). For VALLEY/CHANNEL, the valley
      // line is along the eigenvector of λ₁ (which is strongly concave).
      if (r.reliefClass === RELIEF_CLASS.RIDGE) {
        this._entityRidgeDirX[i] = r.ridgeDirX;
        this._entityRidgeDirZ[i] = r.ridgeDirZ;
        this._entityValleyDirX[i] = 0;
        this._entityValleyDirZ[i] = 0;
      } else if (r.reliefClass === RELIEF_CLASS.VALLEY || r.reliefClass === RELIEF_CLASS.CHANNEL) {
        this._entityValleyDirX[i] = r.ridgeDirX;
        this._entityValleyDirZ[i] = r.ridgeDirZ;
        this._entityRidgeDirX[i] = 0;
        this._entityRidgeDirZ[i] = 0;
      } else {
        this._entityRidgeDirX[i] = 0;
        this._entityRidgeDirZ[i] = 0;
        this._entityValleyDirX[i] = 0;
        this._entityValleyDirZ[i] = 0;
      }

      // Peak hint: for PEAK, record the surface normal's horizontal
      // component (which points away from the peak).
      if (r.reliefClass === RELIEF_CLASS.PEAK) {
        // The strong principal direction for a peak points toward the
        // axis of greatest curvature descent.
        this._entityPeakHintX[i] = -r.ridgeDirX;
        this._entityPeakHintZ[i] = -r.ridgeDirZ;
      } else {
        this._entityPeakHintX[i] = 0;
        this._entityPeakHintZ[i] = 0;
      }

      // Colour band.
      const color = RELIEF_COLORS[r.reliefClass] || RELIEF_COLORS[RELIEF_CLASS.SLOPE];
      this._entityReliefColor[i * 3]     = color[0];
      this._entityReliefColor[i * 3 + 1] = color[1];
      this._entityReliefColor[i * 3 + 2] = color[2];
      this._entityValid[i] = 1;

      sampled++;
    }

    this._stats.entitiesSampled += sampled;
    return sampled;
  }

  // ══════════════════════════════════════════════════════════
  // ─── per-chunk summary ───────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _summarizeChunks(frame) {
    const tc = frame.layers.spatial?.terrainChunks;
    if (!tc || tc.count === 0) return;

    const count = Math.min(tc.count, this._chunkCapacity);
    const chunkSize = this._terrain ? this._terrain.chunkSize : 1000;

    for (let i = 0; i < count; i++) {
      const cx = tc.cx[i];
      const cz = tc.cz[i];
      const centreX = (cx + 0.5) * chunkSize;
      const centreZ = (cz + 0.5) * chunkSize;

      // Sample a grid of relief points across the chunk.
      const gridN = 5;
      const step = chunkSize / gridN;
      const classCounts = new Uint16Array(RELIEF_CLASS_NAMES.length);
      let maxStrength = 0;
      let maxProminence = 0;

      for (let gj = 0; gj < gridN; gj++) {
        for (let gi = 0; gi < gridN; gi++) {
          const wx = cx * chunkSize + (gi + 0.5) * step;
          const wz = cz * chunkSize + (gj + 0.5) * step;
          const r = this.classifyRelief(wx, wz);
          classCounts[r.reliefClass]++;
          if (r.reliefStrength > maxStrength) maxStrength = r.reliefStrength;
          if (r.prominence > maxProminence) maxProminence = r.prominence;
        }
      }

      // Dominant relief class.
      let dominant = 0;
      let maxCount = 0;
      for (let c = 0; c < classCounts.length; c++) {
        if (classCounts[c] > maxCount) {
          maxCount = classCounts[c];
          dominant = c;
        }
      }

      this._chunkDominantRelief[i] = dominant;
      this._chunkPeakCount[i] = classCounts[RELIEF_CLASS.PEAK];
      this._chunkRidgeCount[i] = classCounts[RELIEF_CLASS.RIDGE];
      this._chunkValleyCount[i] = classCounts[RELIEF_CLASS.VALLEY] + classCounts[RELIEF_CLASS.CHANNEL];
      this._chunkMaxReliefStrength[i] = maxStrength;
      this._chunkMaxProminence[i] = maxProminence;
      this._chunkValid[i] = 1;

      this._stats.chunksSummary++;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── frame writes ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.relief) {
      spatial.relief = {
        entityReliefClass:    this._entityReliefClass,
        entityLambdaMax:      this._entityLambdaMax,
        entityLambdaMin:      this._entityLambdaMin,
        entityAnisotropy:     this._entityAnisotropy,
        entityReliefStrength: this._entityReliefStrength,
        entityProminence:     this._entityProminence,
        entityRidgeDirX:      this._entityRidgeDirX,
        entityRidgeDirZ:      this._entityRidgeDirZ,
        entityValleyDirX:     this._entityValleyDirX,
        entityValleyDirZ:     this._entityValleyDirZ,
        entityPeakHintX:      this._entityPeakHintX,
        entityPeakHintZ:      this._entityPeakHintZ,
        entityReliefColor:    this._entityReliefColor,
        entityValid:          this._entityValid,
        chunkDominantRelief:  this._chunkDominantRelief,
        chunkPeakCount:       this._chunkPeakCount,
        chunkRidgeCount:      this._chunkRidgeCount,
        chunkValleyCount:     this._chunkValleyCount,
        chunkMaxReliefStrength: this._chunkMaxReliefStrength,
        chunkMaxProminence:   this._chunkMaxProminence,
        chunkValid:           this._chunkValid
      };
    }

    // Also expose top peaks/ridges/valleys for downstream pathing.
    if (!spatial.landmarks) {
      spatial.landmarks = {
        peaks: [],
        ridges: [],
        valleys: [],
        saddles: [],
        maxPeaks: 32,
        maxRidges: 64,
        maxValleys: 64,
        maxSaddles: 32
      };
    }
    this._extractLandmarks(spatial.landmarks);
  }

  _extractLandmarks(landmarks) {
    landmarks.peaks.length = 0;
    landmarks.ridges.length = 0;
    landmarks.valleys.length = 0;
    landmarks.saddles.length = 0;

    for (let i = 0; i < this._entityCapacity; i++) {
      if (this._entityValid[i] === 0) continue;
      const cls = this._entityReliefClass[i];

      if (cls === RELIEF_CLASS.PEAK && landmarks.peaks.length < landmarks.maxPeaks) {
        landmarks.peaks.push({
          entityIdx: i,
          prominence: this._entityProminence[i],
          strength: this._entityReliefStrength[i]
        });
      } else if (cls === RELIEF_CLASS.RIDGE && landmarks.ridges.length < landmarks.maxRidges) {
        landmarks.ridges.push({
          entityIdx: i,
          directionX: this._entityRidgeDirX[i],
          directionZ: this._entityRidgeDirZ[i],
          strength: this._entityReliefStrength[i]
        });
      } else if ((cls === RELIEF_CLASS.VALLEY || cls === RELIEF_CLASS.CHANNEL) &&
                 landmarks.valleys.length < landmarks.maxValleys) {
        landmarks.valleys.push({
          entityIdx: i,
          directionX: this._entityValleyDirX[i],
          directionZ: this._entityValleyDirZ[i],
          strength: this._entityReliefStrength[i]
        });
      } else if (cls === RELIEF_CLASS.SADDLE && landmarks.saddles.length < landmarks.maxSaddles) {
        landmarks.saddles.push({
          entityIdx: i,
          strength: this._entityReliefStrength[i]
        });
      }
    }

    // Sort peaks by prominence descending (in-place, short list).
    landmarks.peaks.sort((a, b) => b.prominence - a.prominence);
  }

  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    // Aggregate relief distribution for materials.
    if (!physical.reliefDistribution) {
      physical.reliefDistribution = new Float32Array(RELIEF_CLASS_NAMES.length);
    }
    let totalValid = 0;
    for (let i = 0; i < RELIEF_CLASS_NAMES.length; i++) {
      physical.reliefDistribution[i] = 0;
    }
    for (let i = 0; i < this._entityCapacity; i++) {
      if (this._entityValid[i] === 0) continue;
      physical.reliefDistribution[this._entityReliefClass[i]] += 1;
      totalValid++;
    }
    if (totalValid > 0) {
      for (let i = 0; i < RELIEF_CLASS_NAMES.length; i++) {
        physical.reliefDistribution[i] /= totalValid;
      }
    }

    // Ridge vs valley balance: > 0.5 = ridge-dominant, < 0.5 = valley-dominant.
    // Consumed by BiomeBlendField and materials for erosion vs deposition bias.
    physical.reliefBalance =
      (physical.reliefDistribution[RELIEF_CLASS.RIDGE] + physical.reliefDistribution[RELIEF_CLASS.PEAK]) -
      (physical.reliefDistribution[RELIEF_CLASS.VALLEY] + physical.reliefDistribution[RELIEF_CLASS.CHANNEL]);
  }

  // ══════════════════════════════════════════════════════════
  // ─── main update ─────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  update(frame, clock) {
    if (!frame || !frame.layers) return 0;
    const now = clock ? clock.elapsedSeconds : performance.now() / 1000;
    if (now - this._lastUpdateTime < PROVIDER_INTERVAL) return 0;
    this._lastUpdateTime = now;
    this._frameRef = frame;

    // Reset per-class stats (per frame).
    this._globalClassCounts.fill(0);

    // 1. Per-chunk relief summary.
    this._summarizeChunks(frame);

    // 2. Per-entity relief classification.
    this._sampleEntities(frame);

    // 3. Write into frame layers.
    this._writeToSpatialLayer(frame);
    this._writeToPhysicalLayer(frame);

    this._stats.updates++;
    return 1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── interactive setters ─────────────────────────────────
  // ══════════════════════════════════════════════════════════
  setSampleDistance(distance) {
    if (distance > 0) this.sampleDistance = distance;
    return this;
  }

  setThresholds(thresholds) {
    for (const k of Object.keys(this.thresholds)) {
      if (thresholds[k] !== undefined) this.thresholds[k] = thresholds[k];
    }
    return this;
  }

  setProminenceRadius(radius) {
    if (radius > 0) this.prominenceSampleRadius = radius;
    return this;
  }

  // ══════════════════════════════════════════════════════════
  // ─── diagnostics ─────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getStats() {
    return Object.freeze({ ...this._stats });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) this._stats[k] = 0;
  }

  dispose() {
    this._terrain = null;
    this._elevation = null;
    this._slope = null;
    this._frameRef = null;
    this._entityReliefClass.fill(0);
    this._entityLambdaMax.fill(0);
    this._entityLambdaMin.fill(0);
    this._entityAnisotropy.fill(0);
    this._entityReliefStrength.fill(0);
    this._entityProminence.fill(0);
    this._entityRidgeDirX.fill(0);
    this._entityRidgeDirZ.fill(0);
    this._entityValleyDirX.fill(0);
    this._entityValleyDirZ.fill(0);
    this._entityPeakHintX.fill(0);
    this._entityPeakHintZ.fill(0);
    this._entityReliefColor.fill(0);
    this._entityValid.fill(0);
    this._chunkDominantRelief.fill(0);
    this._chunkPeakCount.fill(0);
    this._chunkRidgeCount.fill(0);
    this._chunkValleyCount.fill(0);
    this._chunkMaxReliefStrength.fill(0);
    this._chunkMaxProminence.fill(0);
    this._chunkValid.fill(0);
    this._globalClassCounts.fill(0);
  }
}

export {
  ReliefGradientProvider,
  RELIEF_CLASS,
  RELIEF_CLASS_NAMES,
  RELIEF_THRESHOLDS,
  RELIEF_COLORS,
  RELIEF_SAMPLE_DISTANCE,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};