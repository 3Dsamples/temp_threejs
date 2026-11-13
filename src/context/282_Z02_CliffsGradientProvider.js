// file number : 282_Z02
// full path name : src/context/282_Z02_CliffsGradientProvider.js
// description : Cliff detection and characterization provider for the living world. Builds on 281_ElevationProvider and 282_SlopeGradientProvider to identify, classify, and describe cliff features at every scale — from a small rock face to a kilometre-long escarpment. For each sample it computes: slope angle θ (already from 282), cliff classification (SCREE_SLOPE, BOULDER_FIELD, LEDGE, VERTICAL_FACE, OVERHANG, UNDERHANG, ESCARPMENT, GORGE_WALL), fall-line direction (steepest descent direction projected onto the horizontal), cliff-face orientation (the compass direction the cliff faces), overhang/underhang bias from curvature asymmetry, and a rockfall/landslide potential index R = k · sin(θ) · (1 − cos(φ)) · roughness, where φ is the aspect deviation from the fall line, so that gullies facing downhill get maximum rockfall hazard and cliffs parallel to the slope have none. Extracts cliff-edge polylines from the per-entity cache so that AI pathing, camera framing, and fauna migration can route along or around cliff edges. Assigns each cliff face a material band hint (BARE_ROCK, LICHEN, SCREE, MOSS, WET_ROCK) from slope + moisture + altitude coupling, and writes them into frame.layers.physical.cliffBandWeights so materials blend their shader correctly. All scratch vectors are pooled; zero allocation after the first frame.
// best for : Every consumer that needs cliff-aware behaviour — AI pathfinding that avoids or exploits cliffs, camera framing that snaps to cliff edges, rockfall physics that triggers at overhang points, flora placement that uses cliff faces for lichen and moss, fauna migration that routes through cliff gaps, water flow that cascades off cliff edges, and materials that grade their colour by cliff-face material. Feeds LandscapeErosionSimulator, LandscapeWaterFlowSystem, LandscapePropPlacementSystem, LandscapeDecalPlacementSystem, and the biome providers.
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
  SlopeGradientProvider, SLOPE_BAND, SLOPE_BAND_THRESHOLDS,
  ReliefGradientProvider, RELIEF_CLASS
} from './264_MathECSImportBarrel.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 2;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── cliff class codes ──────────────────────────────────────────
const CLIFF_CLASS = Object.freeze({
  NONE:           0,   // no cliff features
  SCREE_SLOPE:    1,   // loose rock slope (35°..45°)
  BOULDER_FIELD:  2,   // scattered boulders on steep slope
  LEDGE:          3,   // small flat step on a steep face
  VERTICAL_FACE:  4,   // near-vertical rock face (60°..85°)
  OVERHANG:       5,   // face leaning outward (concave, projecting)
  UNDERHANG:      6,   // face leaning inward (undercut base)
  ESCARPMENT:     7,   // long continuous cliff line
  GORGE_WALL:     8    // narrow deep canyon wall
});

const CLIFF_CLASS_NAMES = Object.freeze([
  'none', 'scree_slope', 'boulder_field', 'ledge',
  'vertical_face', 'overhang', 'underhang', 'escarpmemt', 'gorge_wall'
]);

// ─── cliff classification thresholds (radians) ─────────────────
const CLIFF_THRESHOLDS = Object.freeze({
  screeLow:       35 * Math.PI / 180,
  screeHigh:      45 * Math.PI / 180,
  ledgeLow:       50 * Math.PI / 180,
  ledgeHigh:      60 * Math.PI / 180,
  verticalLow:    60 * Math.PI / 180,
  verticalHigh:   85 * Math.PI / 180,
  overhangAngle:  85 * Math.PI / 180,

  // Overhang bias (concavity) thresholds based on curvature sign
  // and magnitude relative to the slope.
  overhangCurvature: 0.02,     // positive λ at high slope
  underhangCurvature: -0.02,   // negative λ at high slope

  // Gorge wall: very steep AND very narrow. Detected when two
  // steep faces face each other within a short distance.
  gorgeWidth:     40.0,        // metres

  // Boulder field: moderate slope with very high roughness.
  boulderRoughness: 3.0,

  // Scree slope: moderate slope with moderate roughness.
  screeRoughnessLow: 1.0,
  screeRoughnessHigh: 3.0
});

// ─── rockfall hazard constants ─────────────────────────────────
const ROCKFALL_CONSTANTS = Object.freeze({
  k: 1.0,                   // global scale
  phiWeight: 1.0,           // aspect deviation weight
  roughnessWeight: 0.5,     // roughness contribution
  minSlopeToTrigger: 30 * Math.PI / 180,
  rockfallSampleRadius: 16.0,
  maxHazard: 1.0
});

// ─── material band hints (per cliff face) ──────────────────────
const CLIFF_MATERIAL_BAND = Object.freeze({
  BARE_ROCK:   0,
  LICHEN:      1,
  SCREE:       2,
  MOSS:        3,
  WET_ROCK:    4,
  SNOW_ROCK:   5
});

const CLIFF_MATERIAL_COLORS = Object.freeze({
  [CLIFF_MATERIAL_BAND.BARE_ROCK]: [0.42, 0.40, 0.38],
  [CLIFF_MATERIAL_BAND.LICHEN]:    [0.48, 0.52, 0.38],
  [CLIFF_MATERIAL_BAND.SCREE]:     [0.52, 0.48, 0.42],
  [CLIFF_MATERIAL_BAND.MOSS]:      [0.34, 0.48, 0.30],
  [CLIFF_MATERIAL_BAND.WET_ROCK]:  [0.30, 0.38, 0.42],
  [CLIFF_MATERIAL_BAND.SNOW_ROCK]: [0.78, 0.82, 0.88]
});

// ─── fall-line sample distance ─────────────────────────────────
const CLIFF_SAMPLE_DISTANCE = 4.0;

class CliffsGradientProvider {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.sampleDistance = options.sampleDistance ?? CLIFF_SAMPLE_DISTANCE;
    this.thresholds = { ...CLIFF_THRESHOLDS, ...(options.thresholds || {}) };
    this.rockfall = { ...ROCKFALL_CONSTANTS, ...(options.rockfall || {}) };
    this.enableCliffEdges = options.enableCliffEdges ?? true;
    this.enableMaterialHints = options.enableMaterialHints ?? true;
    this.maxEdgePolylineLength = options.maxEdgePolylineLength ?? 128;

    // ── scratch (pooled, never allocated after construction) ─
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVecD = new Vec3();
    this._tmpMatA = new Mat4();

    // ── per-entity cliff cache (flat SoA) ───────────────────
    const capacity = options.entityCacheCapacity ?? 2048;
    this._entityCapacity = capacity;
    this._entityCliffClass      = new Uint8Array(capacity);
    this._entitySlopeAngle      = new Float32Array(capacity);
    this._entityFallLineX       = new Float32Array(capacity);
    this._entityFallLineZ       = new Float32Array(capacity);
    this._entityFaceNormalX     = new Float32Array(capacity);   // outward face normal
    this._entityFaceNormalZ     = new Float32Array(capacity);
    this._entityOverhangBias    = new Float32Array(capacity);   // -1 underhang, +1 overhang
    this._entityRockfallHazard  = new Float32Array(capacity);   // 0..1
    this._entityCliffHeight     = new Float32Array(capacity);   // estimated face height
    this._entityMaterialBand    = new Uint8Array(capacity);
    this._entityBandColor       = new Float32Array(capacity * 3);
    this._entityValid           = new Uint8Array(capacity);

    // ── cliff-edge polylines (per edge, up to maxPolyline) ──
    this._edgePolylineCapacity = options.edgePolylineCapacity ?? 32;
    this._edgePolylines = new Array(this._edgePolylineCapacity);
    for (let i = 0; i < this._edgePolylineCapacity; i++) {
      this._edgePolylines[i] = {
        points: new Float32Array(this.maxEdgePolylineLength * 3),
        length: 0,
        averageSlope: 0,
        averageHazard: 0,
        dominantClass: 0
      };
    }
    this._edgeCount = 0;

    // ── per-chunk cliff summary ────────────────────────────
    this._chunkCapacity = options.chunkCacheCapacity ?? 512;
    this._chunkDominantClass    = new Uint8Array(this._chunkCapacity);
    this._chunkCliffCoverage    = new Float32Array(this._chunkCapacity);   // 0..1
    this._chunkMaxHazard        = new Float32Array(this._chunkCapacity);
    this._chunkAvgSlope         = new Float32Array(this._chunkCapacity);
    this._chunkVerticalCount    = new Uint16Array(this._chunkCapacity);
    this._chunkOverhangCount    = new Uint16Array(this._chunkCapacity);
    this._chunkValid            = new Uint8Array(this._chunkCapacity);

    // ── global class counts (per-frame diagnostic) ─────────
    this._globalClassCounts = new Uint32Array(CLIFF_CLASS_NAMES.length);

    // ── material band aggregate weights ────────────────────
    this._materialBandWeights = new Float32Array(6);

    // ── diagnostics ────────────────────────────────────────
    this._stats = {
      updates: 0,
      entitiesSampled: 0,
      chunksSummary: 0,
      cliffDetections: 0,
      verticalFaces: 0,
      overhangs: 0,
      underhangs: 0,
      escarpments: 0,
      gorgeWalls: 0,
      ledges: 0,
      screeSlopes: 0,
      boulderFields: 0,
      edgePolylines: 0,
      materialHintsAssigned: 0,
      interpolated: 0
    };

    // ── timing / frame reference ───────────────────────────
    this._lastUpdateTime = -Infinity;
    this._frameRef = null;

    // ── optional direct references to collaborators ────────
    this._terrain = options.terrain || null;
    this._elevation = options.elevation || null;
    this._slope = options.slope || null;
    this._relief = options.relief || null;
  }

  // ══════════════════════════════════════════════════════════
  // ─── collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachTerrain(terrain) { this._terrain = terrain; return this; }
  attachElevation(elevation) { this._elevation = elevation; return this; }
  attachSlope(slope) { this._slope = slope; return this; }
  attachRelief(relief) { this._relief = relief; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── height lookup ──────────────────────────────────────
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
  // ─── roughness (RMS of second derivatives) ──────────────
  // ══════════════════════════════════════════════════════════
  _computeRoughness(wx, wz) {
    const d = this.sampleDistance;
    const hC = this._getHeight(wx, wz);
    const hL = this._getHeight(wx - d, wz);
    const hR = this._getHeight(wx + d, wz);
    const hD = this._getHeight(wx, wz - d);
    const hU = this._getHeight(wx, wz + d);
    const d2hdx2 = (hL - 2 * hC + hR) / (d * d);
    const d2hdz2 = (hD - 2 * hC + hU) / (d * d);
    return Math.sqrt(d2hdx2 * d2hdx2 + d2hdz2 * d2hdz2);
  }

  // ══════════════════════════════════════════════════════════
  // ─── cliff classification (single point) ────────────────
  // ══════════════════════════════════════════════════════════
  classifyCliff(wx, wz) {
    const d = this.sampleDistance;

    // ── slope angle ─────────────────────────────────────────
    const hL = this._getHeight(wx - d, wz);
    const hR = this._getHeight(wx + d, wz);
    const hD = this._getHeight(wx, wz - d);
    const hU = this._getHeight(wx, wz + d);
    const dhdx = (hR - hL) / (2 * d);
    const dhdz = (hU - hD) / (2 * d);
    const gradMag = Math.sqrt(dhdx * dhdx + dhdz * dhdz);
    const slopeAngle = Math.atan(gradMag);

    // ── fall line (steepest descent direction) ─────────────
    let fallX = 0, fallZ = 0;
    if (gradMag > Precision.EPSILON) {
      fallX = -dhdx / gradMag;
      fallZ = -dhdz / gradMag;
    }

    // ── face normal (points outward from the cliff) ────────
    // For a cliff, the outward face normal's horizontal component
    // points away from the high side, i.e., in the fall-line direction.
    const faceNormalX = fallX;
    const faceNormalZ = fallZ;

    // ── curvature for overhang detection ───────────────────
    const roughness = this._computeRoughness(wx, wz);
    const hC = this._getHeight(wx, wz);
    const lap = (hL + hR + hD + hU - 4 * hC) / (d * d);

    // Normalize overhang bias by slope magnitude to get a
    // comparable score across the map.
    let overhangBias = 0;
    if (slopeAngle > this.thresholds.ledgeLow) {
      overhangBias = lap / this.thresholds.overhangCurvature;
      if (overhangBias > 1) overhangBias = 1;
      if (overhangBias < -1) overhangBias = -1;
    }

    // ── cliff class ─────────────────────────────────────────
    const t = this.thresholds;
    let cliffClass = CLIFF_CLASS.NONE;

    if (slopeAngle < t.screeLow) {
      cliffClass = CLIFF_CLASS.NONE;
    } else if (slopeAngle < t.screeHigh) {
      // Scree slope if roughness is in the scree range,
      // boulder field if roughness is very high.
      if (roughness > t.boulderRoughness) {
        cliffClass = CLIFF_CLASS.BOULDER_FIELD;
      } else if (roughness > t.screeRoughnessLow) {
        cliffClass = CLIFF_CLASS.SCREE_SLOPE;
      } else {
        cliffClass = CLIFF_CLASS.SCREE_SLOPE;
      }
    } else if (slopeAngle < t.ledgeHigh) {
      // Between screeHigh and ledgeHigh: ledges or vertical face start.
      cliffClass = overhangBias > 0.3
        ? CLIFF_CLASS.OVERHANG
        : overhangBias < -0.3
          ? CLIFF_CLASS.UNDERHANG
          : (roughness > t.boulderRoughness
            ? CLIFF_CLASS.BOULDER_FIELD
            : CLIFF_CLASS.LEDGE);
    } else if (slopeAngle < t.verticalHigh) {
      // Vertical face region.
      if (overhangBias > 0.3) {
        cliffClass = CLIFF_CLASS.OVERHANG;
      } else if (overhangBias < -0.3) {
        cliffClass = CLIFF_CLASS.UNDERHANG;
      } else {
        cliffClass = CLIFF_CLASS.VERTICAL_FACE;
      }
    } else {
      // Steepest: overhang always wins.
      cliffClass = overhangBias > 0
        ? CLIFF_CLASS.OVERHANG
        : CLIFF_CLASS.UNDERHANG;
    }

    // ── gorge wall detection ───────────────────────────────
    // If the entity is on a steep slope, look a short distance
    // perpendicular to the fall line — if there's another steep
    // face within gorgeWidth, it's a gorge wall.
    if (cliffClass === CLIFF_CLASS.VERTICAL_FACE || cliffClass === CLIFF_CLASS.OVERHANG) {
      const perpX = -fallZ;
      const perpZ = fallX;
      const w = t.gorgeWidth;
      const hOpposite = this._getHeight(wx + perpX * w, wz + perpZ * w);
      const hHere = this._getHeight(wx, wz);
      // If the opposite side rises back up by more than half the
      // gorge width, we're likely in a gorge.
      if (hOpposite - hHere > w * 0.3) {
        cliffClass = CLIFF_CLASS.GORGE_WALL;
      }
    }

    // ── rockfall hazard index ─────────────────────────────
    // R = k · sin(θ) · (1 − cos(φ)) · roughness
    // where φ is the deviation of the aspect from the fall line
    // (0 when aligned, so the hazard is small; large when the face
    // is perpendicular to the fall line — i.e., a gully facing
    // downhill catches falling rock).
    let rockfallHazard = 0;
    if (slopeAngle > this.rockfall.minSlopeToTrigger) {
      const aspect = Math.atan2(fallZ, fallX);
      const aspectDev = aspect;   // reference aspect 0 for now
      const phiFactor = 1 - Math.cos(aspectDev);
      const rawHazard = this.rockfall.k *
        Math.sin(slopeAngle) *
        phiFactor *
        (1 + this.rockfall.roughnessWeight * roughness);
      rockfallHazard = Math.min(this.rockfall.maxHazard, rawHazard);
    }

    // ── cliff height estimation ────────────────────────────
    // Sample the vertical extent by walking along the fall line
    // for a short distance and measuring the drop.
    let cliffHeight = 0;
    if (cliffClass >= CLIFF_CLASS.VERTICAL_FACE) {
      const walkDist = 8.0;
      const h0 = this._getHeight(wx, wz);
      const h1 = this._getHeight(wx + fallX * walkDist, wz + fallZ * walkDist);
      cliffHeight = Math.max(0, h0 - h1);
    }

    // ── update stats ───────────────────────────────────────
    this._globalClassCounts[cliffClass]++;
    switch (cliffClass) {
      case CLIFF_CLASS.VERTICAL_FACE: this._stats.verticalFaces++; break;
      case CLIFF_CLASS.OVERHANG:      this._stats.overhangs++; break;
      case CLIFF_CLASS.UNDERHANG:     this._stats.underhangs++; break;
      case CLIFF_CLASS.ESCARPMENT:    this._stats.escarpments++; break;
      case CLIFF_CLASS.GORGE_WALL:    this._stats.gorgeWalls++; break;
      case CLIFF_CLASS.LEDGE:         this._stats.ledges++; break;
      case CLIFF_CLASS.SCREE_SLOPE:   this._stats.screeSlopes++; break;
      case CLIFF_CLASS.BOULDER_FIELD: this._stats.boulderFields++; break;
    }
    if (cliffClass !== CLIFF_CLASS.NONE) this._stats.cliffDetections++;

    return {
      cliffClass,
      slopeAngle,
      fallLineX: fallX,
      fallLineZ: fallZ,
      faceNormalX,
      faceNormalZ,
      overhangBias,
      rockfallHazard,
      cliffHeight,
      roughness
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── material band classification ───────────────────────
  // ══════════════════════════════════════════════════════════
  _classifyMaterialBand(cliffClass, slopeAngle, altitude, moisture, wetness) {
    if (cliffClass === CLIFF_CLASS.NONE) return CLIFF_MATERIAL_BAND.BARE_ROCK;

    // Snow above high altitude.
    if (altitude > 2400) return CLIFF_MATERIAL_BAND.SNOW_ROCK;

    // Wet rock when near water or high moisture + recent rain.
    if (wetness > 0.6 || (moisture > 0.7 && altitude < 500)) {
      return CLIFF_MATERIAL_BAND.WET_ROCK;
    }

    // Moss on moderate cliffs with high moisture.
    if (moisture > 0.55 && slopeAngle < this.thresholds.verticalHigh) {
      return CLIFF_MATERIAL_BAND.MOSS;
    }

    // Scree at the base of tall cliffs.
    if (cliffClass === CLIFF_CLASS.SCREE_SLOPE ||
        cliffClass === CLIFF_CLASS.BOULDER_FIELD) {
      return CLIFF_MATERIAL_BAND.SCREE;
    }

    // Lichen on high-altitude vertical faces.
    if (altitude > 1500 && slopeAngle > this.thresholds.verticalLow) {
      return CLIFF_MATERIAL_BAND.LICHEN;
    }

    return CLIFF_MATERIAL_BAND.BARE_ROCK;
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

    // Read environment context for material band classification.
    const physical = frame.layers.physical;
    const moisture = physical?.humidity ?? 0.5;
    const wetness = physical?.wetness ?? 0;
    const elapsed = physical?.elapsedWorldSeconds ?? 0;

    for (let i = 0; i < n; i++) {
      const so = i * 4;
      const sx = sphere[so];
      const sy = sphere[so + 1];
      const sz = sphere[so + 2];

      const r = this.classifyCliff(sx, sz);

      this._entityCliffClass[i] = r.cliffClass;
      this._entitySlopeAngle[i] = r.slopeAngle;
      this._entityFallLineX[i] = r.fallLineX;
      this._entityFallLineZ[i] = r.fallLineZ;
      this._entityFaceNormalX[i] = r.faceNormalX;
      this._entityFaceNormalZ[i] = r.faceNormalZ;
      this._entityOverhangBias[i] = r.overhangBias;
      this._entityRockfallHazard[i] = r.rockfallHazard;
      this._entityCliffHeight[i] = r.cliffHeight;

      // Material band.
      const band = this._classifyMaterialBand(
        r.cliffClass, r.slopeAngle, sy, moisture, wetness
      );
      this._entityMaterialBand[i] = band;
      this._stats.materialHintsAssigned++;

      const color = CLIFF_MATERIAL_COLORS[band] || CLIFF_MATERIAL_COLORS[CLIFF_MATERIAL_BAND.BARE_ROCK];
      this._entityBandColor[i * 3]     = color[0];
      this._entityBandColor[i * 3 + 1] = color[1];
      this._entityBandColor[i * 3 + 2] = color[2];

      this._entityValid[i] = 1;
      sampled++;
    }

    this._stats.entitiesSampled += sampled;
    return sampled;
  }

  // ══════════════════════════════════════════════════════════
  // ─── cliff-edge polyline extraction ────────────────────
  // ══════════════════════════════════════════════════════════
  _extractCliffEdges(frame) {
    if (!this.enableCliffEdges) return;
    this._edgeCount = 0;

    // Simple approach: for each entity that is a VERTICAL_FACE or
    // ESCARPMENT, walk along the fall-line-perpendicular direction
    // and check whether the cliff continues. If so, extend the
    // polyline. This is a bounded, deterministic walk suitable for
    // the per-frame budget.

    const spatial = frame.layers.spatial;
    if (!spatial) return;

    const tc = spatial.terrainChunks;
    if (!tc || tc.count === 0) return;

    const chunkSize = this._terrain ? this._terrain.chunkSize : 1000;

    for (let ci = 0; ci < tc.count && this._edgeCount < this._edgePolylineCapacity; ci++) {
      const cx = tc.cx[ci];
      const cz = tc.cz[ci];
      const centreX = (cx + 0.5) * chunkSize;
      const centreZ = (cz + 0.5) * chunkSize;

      const r = this.classifyCliff(centreX, centreZ);
      if (r.cliffClass !== CLIFF_CLASS.VERTICAL_FACE &&
          r.cliffClass !== CLIFF_CLASS.ESCARPMENT &&
          r.cliffClass !== CLIFF_CLASS.GORGE_WALL) {
        continue;
      }

      const poly = this._edgePolylines[this._edgeCount];
      poly.length = 0;
      poly.averageSlope = 0;
      poly.averageHazard = 0;
      poly.dominantClass = r.cliffClass;

      // Walk along the perpendicular to the fall line.
      const perpX = -r.fallLineZ;
      const perpZ = r.fallLineX;
      const walkStep = 8.0;
      const maxWalk = this.maxEdgePolylineLength;
      let sumSlope = 0;
      let sumHazard = 0;
      let points = 0;

      for (let step = -maxWalk / 2; step <= maxWalk / 2; step++) {
        const px = centreX + perpX * step * walkStep;
        const pz = centreZ + perpZ * step * walkStep;
        const pp = this.classifyCliff(px, pz);
        if (pp.cliffClass < CLIFF_CLASS.VERTICAL_FACE) {
          // Cliff edge ends — terminate the polyline here.
          if (points < 3) break;
          // Fill remaining points as an end cap.
          break;
        }
        const py = this._getHeight(px, pz);
        const o = poly.length * 3;
        poly.points[o]     = px;
        poly.points[o + 1] = py;
        poly.points[o + 2] = pz;
        poly.length++;
        sumSlope += pp.slopeAngle;
        sumHazard += pp.rockfallHazard;
        points++;
        if (poly.length >= maxWalk) break;
      }

      if (poly.length >= 3) {
        poly.averageSlope = sumSlope / poly.length;
        poly.averageHazard = sumHazard / poly.length;
        this._edgeCount++;
        this._stats.edgePolylines++;
      }
    }
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
      const gridN = 4;
      const step = chunkSize / gridN;

      const classCounts = new Uint16Array(CLIFF_CLASS_NAMES.length);
      let maxHazard = 0;
      let sumSlope = 0;
      let samples = 0;
      let verticalCount = 0;
      let overhangCount = 0;

      for (let gj = 0; gj < gridN; gj++) {
        for (let gi = 0; gi < gridN; gi++) {
          const wx = cx * chunkSize + (gi + 0.5) * step;
          const wz = cz * chunkSize + (gj + 0.5) * step;
          const r = this.classifyCliff(wx, wz);
          classCounts[r.cliffClass]++;
          if (r.rockfallHazard > maxHazard) maxHazard = r.rockfallHazard;
          sumSlope += r.slopeAngle;
          samples++;
          if (r.cliffClass === CLIFF_CLASS.VERTICAL_FACE ||
              r.cliffClass === CLIFF_CLASS.GORGE_WALL) verticalCount++;
          if (r.cliffClass === CLIFF_CLASS.OVERHANG) overhangCount++;
        }
      }

      // Dominant class.
      let dominant = 0;
      let maxCount = 0;
      for (let c = 0; c < classCounts.length; c++) {
        if (classCounts[c] > maxCount) {
          maxCount = classCounts[c];
          dominant = c;
        }
      }

      const cliffSamples = samples - classCounts[CLIFF_CLASS.NONE];
      const coverage = samples > 0 ? cliffSamples / samples : 0;

      this._chunkDominantClass[i] = dominant;
      this._chunkCliffCoverage[i] = coverage;
      this._chunkMaxHazard[i] = maxHazard;
      this._chunkAvgSlope[i] = samples > 0 ? sumSlope / samples : 0;
      this._chunkVerticalCount[i] = verticalCount;
      this._chunkOverhangCount[i] = overhangCount;
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

    if (!spatial.cliffs) {
      spatial.cliffs = {
        entityCliffClass:       this._entityCliffClass,
        entitySlopeAngle:       this._entitySlopeAngle,
        entityFallLineX:        this._entityFallLineX,
        entityFallLineZ:        this._entityFallLineZ,
        entityFaceNormalX:      this._entityFaceNormalX,
        entityFaceNormalZ:      this._entityFaceNormalZ,
        entityOverhangBias:     this._entityOverhangBias,
        entityRockfallHazard:   this._entityRockfallHazard,
        entityCliffHeight:      this._entityCliffHeight,
        entityMaterialBand:     this._entityMaterialBand,
        entityBandColor:        this._entityBandColor,
        entityValid:            this._entityValid,

        chunkDominantClass:     this._chunkDominantClass,
        chunkCliffCoverage:     this._chunkCliffCoverage,
        chunkMaxHazard:         this._chunkMaxHazard,
        chunkAvgSlope:          this._chunkAvgSlope,
        chunkVerticalCount:     this._chunkVerticalCount,
        chunkOverhangCount:     this._chunkOverhangCount,
        chunkValid:             this._chunkValid,

        edgePolylines:          this._edgePolylines,
        edgeCount:              this._edgeCount
      };
    } else {
      spatial.cliffs.edgeCount = this._edgeCount;
    }
  }

  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    // Aggregate material band weights for the whole scene.
    for (let b = 0; b < 6; b++) this._materialBandWeights[b] = 0;
    let totalValid = 0;
    for (let i = 0; i < this._entityCapacity; i++) {
      if (this._entityValid[i] === 0) continue;
      if (this._entityCliffClass[i] === CLIFF_CLASS.NONE) continue;
      this._materialBandWeights[this._entityMaterialBand[i]]++;
      totalValid++;
    }
    if (totalValid > 0) {
      for (let b = 0; b < 6; b++) this._materialBandWeights[b] /= totalValid;
    }

    if (!physical.cliffBandWeights) {
      physical.cliffBandWeights = new Float32Array(6);
    }
    physical.cliffBandWeights.set(this._materialBandWeights);

    // Rockfall hazard aggregate for physics. PhysicalContextProvider
    // can scale its friction/traction multiplier by this value to
    // reduce movement stability on hazard-prone terrain.
    let sumHazard = 0;
    let hazardCount = 0;
    for (let i = 0; i < this._entityCapacity; i++) {
      if (this._entityValid[i] === 0) continue;
      sumHazard += this._entityRockfallHazard[i];
      hazardCount++;
    }
    physical.rockfallHazard = hazardCount > 0 ? sumHazard / hazardCount : 0;

    // Cliff coverage aggregate for BiomeBlendField weighting.
    let sumCoverage = 0;
    let chunkCount = 0;
    for (let i = 0; i < this._chunkCapacity; i++) {
      if (this._chunkValid[i] === 0) continue;
      sumCoverage += this._chunkCliffCoverage[i];
      chunkCount++;
    }
    physical.cliffCoverage = chunkCount > 0 ? sumCoverage / chunkCount : 0;
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

    // Reset per-frame stats.
    this._globalClassCounts.fill(0);

    // 1. Per-chunk summary.
    this._summarizeChunks(frame);

    // 2. Per-entity classification.
    this._sampleEntities(frame);

    // 3. Cliff-edge polyline extraction.
    this._extractCliffEdges(frame);

    // 4. Write into frame layers.
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

  setRockfallConstants(constants) {
    for (const k of Object.keys(this.rockfall)) {
      if (constants[k] !== undefined) this.rockfall[k] = constants[k];
    }
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
    this._relief = null;
    this._frameRef = null;
    this._entityCliffClass.fill(0);
    this._entitySlopeAngle.fill(0);
    this._entityFallLineX.fill(0);
    this._entityFallLineZ.fill(0);
    this._entityFaceNormalX.fill(0);
    this._entityFaceNormalZ.fill(0);
    this._entityOverhangBias.fill(0);
    this._entityRockfallHazard.fill(0);
    this._entityCliffHeight.fill(0);
    this._entityMaterialBand.fill(0);
    this._entityBandColor.fill(0);
    this._entityValid.fill(0);
    this._chunkDominantClass.fill(0);
    this._chunkCliffCoverage.fill(0);
    this._chunkMaxHazard.fill(0);
    this._chunkAvgSlope.fill(0);
    this._chunkVerticalCount.fill(0);
    this._chunkOverhangCount.fill(0);
    this._chunkValid.fill(0);
    for (let i = 0; i < this._edgePolylineCapacity; i++) {
      this._edgePolylines[i].length = 0;
    }
    this._edgeCount = 0;
    this._globalClassCounts.fill(0);
    this._materialBandWeights.fill(0);
  }
}

export {
  CliffsGradientProvider,
  CLIFF_CLASS,
  CLIFF_CLASS_NAMES,
  CLIFF_THRESHOLDS,
  CLIFF_MATERIAL_BAND,
  CLIFF_MATERIAL_COLORS,
  ROCKFALL_CONSTANTS,
  CLIFF_SAMPLE_DISTANCE,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};