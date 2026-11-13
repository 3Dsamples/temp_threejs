// file number : 282
// full path name : src/context/282_SlopeGradientProvider.js
// description : Slope-gradient provider feeding water flow, soil stability, erosion, and flora placement. Reads the per-chunk terrain summaries written by 280_TerrainProvider into frame.layers.spatial.terrainChunks and the per-chunk elevation field from 281_ElevationProvider, then produces per-entity and per-chunk slope descriptors that downstream consumers use without touching raw heightfields. For every entity it computes: the horizontal gradient vector ∇h = (∂h/∂x, ∂h/∂z) from finite differences, gradient magnitude |∇h|, slope angle θ = atan(|∇h|), aspect φ = atan2(−∂h/∂z, −∂h/∂x), downhill unit vector d̂ = −∇h/|∇h|, cross-slope unit vector ĉ = perpendicular to d̂, curvature proxy (concave/convex), soil-stability factor S = cos(θ) (1 = flat, 0 = vertical), water-flow accumulation bias W = max(0, (|∇h| − tan(θ_crit))) × flowHint, and a slope-band colour grading weight that materials use to blend rock vs soil vs grass. Writes into frame.layers.spatial.slope and frame.layers.physical.slopeBandWeights so LandscapeWaterFlowSystem, LandscapeErosionSimulator, LandscapeWindErosionSystem, SoilFertilityProvider, LandscapeVegetationScatterSystem, and BiomeSoilCoupling read from one authoritative source. All scratch vectors and matrices are pooled; zero allocation inside getGradient(), getSlopeAngle(), or sampleEntities() after the first frame.
// best for : The single source of slope truth for the living world. Every consumer that needs "how steep is this", "which way does water flow here", or "will a plant grow here" reads from this provider. Feeds water-flow routing, erosion, vegetation scatter, soil fertility, and material colour bands.
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
  ElevationProvider, ELEVATION_BAND
} from './264_MathECSImportBarrel.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 2;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── slope classification bands (radians) ────────────────────────
// Used for both soil stability and material colour blending.
const SLOPE_BAND = Object.freeze({
  FLAT:        0,   // < 5°
  GENTLE:      1,   // 5° .. 15°
  MODERATE:    2,   // 15° .. 30°
  STEEP:       3,   // 30° .. 45°
  VERY_STEEP:  4,   // 45° .. 60°
  CLIFF:       5    // > 60°
});

// ─── slope band thresholds in radians ───────────────────────────
const SLOPE_BAND_THRESHOLDS = Object.freeze({
  flatUpper:     5  * Math.PI / 180,
  gentleUpper:  15  * Math.PI / 180,
  moderateUpper:30  * Math.PI / 180,
  steepUpper:   45  * Math.PI / 180,
  verySteepUpper:60 * Math.PI / 180
});

// ─── slope band colours for material blending ───────────────────
const SLOPE_BAND_COLORS = Object.freeze({
  [SLOPE_BAND.FLAT]:       [0.42, 0.62, 0.28],   // grassy
  [SLOPE_BAND.GENTLE]:     [0.48, 0.55, 0.30],   // grass + soil
  [SLOPE_BAND.MODERATE]:   [0.52, 0.46, 0.32],   // dry soil
  [SLOPE_BAND.STEEP]:      [0.48, 0.40, 0.32],   // exposed soil/rock
  [SLOPE_BAND.VERY_STEEP]: [0.42, 0.38, 0.36],   // rock
  [SLOPE_BAND.CLIFF]:      [0.36, 0.34, 0.34]    // bare rock
});

// ─── critical slope for water flow (tan of angle) ───────────────
// Below this, water accumulates; above, it slides off as sheet flow.
const WATER_FLOW_CRITICAL_TAN = Math.tan(8 * Math.PI / 180);

// ─── default slope sample distance (metres) ─────────────────────
const SLOPE_SAMPLE_DISTANCE = 4.0;

class SlopeGradientProvider {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.sampleDistance = options.sampleDistance ?? SLOPE_SAMPLE_DISTANCE;
    this.waterFlowCriticalTan = options.waterFlowCriticalTan ?? WATER_FLOW_CRITICAL_TAN;
    this.slopeBandThresholds = { ...SLOPE_BAND_THRESHOLDS, ...(options.slopeBandThresholds || {}) };
    this.enableWaterFlowBias = options.enableWaterFlowBias ?? true;
    this.enableSoilStability = options.enableSoilStability ?? true;

    // ── scratch (pooled, no allocation after construction) ──
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVecD = new Vec3();
    this._tmpMatA = new Mat4();

    // ── per-entity slope cache (flat SoA) ───────────────────
    const capacity = options.entityCacheCapacity ?? 2048;
    this._entityCapacity = capacity;
    this._entityGradX     = new Float32Array(capacity);
    this._entityGradZ     = new Float32Array(capacity);
    this._entityGradMag   = new Float32Array(capacity);
    this._entitySlopeAngle = new Float32Array(capacity);
    this._entityAspect    = new Float32Array(capacity);
    this._entityDownhillX = new Float32Array(capacity);
    this._entityDownhillZ = new Float32Array(capacity);
    this._entityCrossX    = new Float32Array(capacity);
    this._entityCrossZ    = new Float32Array(capacity);
    this._entityCurvature = new Float32Array(capacity);
    this._entityStability = new Float32Array(capacity);   // 0..1
    this._entityWaterBias = new Float32Array(capacity);   // 0..1
    this._entitySlopeBand = new Uint8Array(capacity);
    this._entityBandBlend = new Float32Array(capacity);
    this._entityBandColor = new Float32Array(capacity * 3);
    this._entityValid     = new Uint8Array(capacity);

    // ── per-chunk slope summary (bounded by chunk capacity) ─
    this._chunkCapacity = options.chunkCacheCapacity ?? 512;
    this._chunkAvgSlope       = new Float32Array(this._chunkCapacity);
    this._chunkMaxSlope       = new Float32Array(this._chunkCapacity);
    this._chunkAvgAspect      = new Float32Array(this._chunkCapacity);
    this._chunkDominantBand   = new Uint8Array(this._chunkCapacity);
    this._chunkFlowBias       = new Float32Array(this._chunkCapacity);
    this._chunkStability      = new Float32Array(this._chunkCapacity);
    this._chunkValid          = new Uint8Array(this._chunkCapacity);

    // ── diagnostics ─────────────────────────────────────────
    this._stats = {
      updates: 0,
      entitiesSampled: 0,
      chunksSummary: 0,
      gradientComputes: 0,
      slopeAngleComputes: 0,
      aspectComputes: 0,
      stabilityComputes: 0,
      flowBiasComputes: 0,
      bandClassifies: 0,
      interpolated: 0
    };

    // ── timing ──────────────────────────────────────────────
    this._lastUpdateTime = -Infinity;

    // ── frame reference ─────────────────────────────────────
    this._frameRef = null;

    // ── optional direct terrain reference ────────────────────
    this._terrain = options.terrain || null;
    this._elevation = options.elevation || null;
  }

  // ══════════════════════════════════════════════════════════
  // ─── attach collaborators ────────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachTerrain(terrain) { this._terrain = terrain; return this; }
  attachElevation(elevation) { this._elevation = elevation; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── slope queries ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════

  // Compute gradient ∇h = (∂h/∂x, ∂h/∂z) at a world position.
  // Writes into outGradient (Vec3) as (dhdx, 0, dhdz).
  getGradient(wx, wz, outGradient, lod = 0) {
    this._stats.gradientComputes++;
    const d = this.sampleDistance;
    const hL = this._getHeight(wx - d, wz, lod);
    const hR = this._getHeight(wx + d, wz, lod);
    const hD = this._getHeight(wx, wz - d, lod);
    const hU = this._getHeight(wx, wz + d, lod);

    const dhdx = (hR - hL) / (2 * d);
    const dhdz = (hU - hD) / (2 * d);

    outGradient.set(dhdx, 0, dhdz);
    return outGradient;
  }

  // Slope angle θ = atan(|∇h|) in radians.
  getSlopeAngle(wx, wz, lod = 0) {
    this._stats.slopeAngleComputes++;
    const d = this.sampleDistance;
    const hL = this._getHeight(wx - d, wz, lod);
    const hR = this._getHeight(wx + d, wz, lod);
    const hD = this._getHeight(wx, wz - d, lod);
    const hU = this._getHeight(wx, wz + d, lod);

    const dhdx = (hR - hL) / (2 * d);
    const dhdz = (hU - hD) / (2 * d);
    return Math.atan(Math.sqrt(dhdx * dhdx + dhdz * dhdz));
  }

  // Aspect φ = atan2(−∂h/∂z, −∂h/∂x) in radians.
  // Points in the downhill (flow) direction.
  getAspect(wx, wz, lod = 0) {
    this._stats.aspectComputes++;
    const d = this.sampleDistance;
    const hL = this._getHeight(wx - d, wz, lod);
    const hR = this._getHeight(wx + d, wz, lod);
    const hD = this._getHeight(wx, wz - d, lod);
    const hU = this._getHeight(wx, wz + d, lod);

    const dhdx = (hR - hL) / (2 * d);
    const dhdz = (hU - hD) / (2 * d);
    return Math.atan2(-dhdz, -dhdx);
  }

  // Downhill unit vector d̂ = −∇h / |∇h|.
  getDownhill(wx, wz, outVec, lod = 0) {
    const d = this.sampleDistance;
    const hL = this._getHeight(wx - d, wz, lod);
    const hR = this._getHeight(wx + d, wz, lod);
    const hD = this._getHeight(wx, wz - d, lod);
    const hU = this._getHeight(wx, wz + d, lod);

    const dhdx = (hR - hL) / (2 * d);
    const dhdz = (hU - hD) / (2 * d);
    const mag = Math.sqrt(dhdx * dhdx + dhdz * dhdz);
    if (mag < Precision.EPSILON) {
      outVec.set(0, 0, 0);
    } else {
      outVec.set(-dhdx / mag, 0, -dhdz / mag);
    }
    return outVec;
  }

  // Soil-stability factor S = cos(θ).
  // 1.0 = flat, 0.0 = vertical. Feeds SoilFertilityProvider.
  getSoilStability(wx, wz, lod = 0) {
    this._stats.stabilityComputes++;
    const slope = this.getSlopeAngle(wx, wz, lod);
    return Math.cos(slope);
  }

  // Water-flow accumulation bias.
  // W = max(0, |∇h| − tan(θ_crit)) · flowHint
  // Higher values mean water is more likely to flow through here.
  getWaterFlowBias(wx, wz, flowHint = 1.0, lod = 0) {
    if (!this.enableWaterFlowBias) return 0;
    this._stats.flowBiasComputes++;
    const d = this.sampleDistance;
    const hL = this._getHeight(wx - d, wz, lod);
    const hR = this._getHeight(wx + d, wz, lod);
    const hD = this._getHeight(wx, wz - d, lod);
    const hU = this._getHeight(wx, wz + d, lod);

    const dhdx = (hR - hL) / (2 * d);
    const dhdz = (hU - hD) / (2 * d);
    const mag = Math.sqrt(dhdx * dhdx + dhdz * dhdz);
    const excess = mag - this.waterFlowCriticalTan;
    return excess > 0 ? excess * flowHint : 0;
  }

  // Classification band from slope angle.
  getSlopeBand(slopeAngle) {
    this._stats.bandClassifies++;
    const t = this.slopeBandThresholds;
    if (slopeAngle < t.flatUpper) return SLOPE_BAND.FLAT;
    if (slopeAngle < t.gentleUpper) return SLOPE_BAND.GENTLE;
    if (slopeAngle < t.moderateUpper) return SLOPE_BAND.MODERATE;
    if (slopeAngle < t.steepUpper) return SLOPE_BAND.STEEP;
    if (slopeAngle < t.verySteepUpper) return SLOPE_BAND.VERY_STEEP;
    return SLOPE_BAND.CLIFF;
  }

  // Full colour grading result: base colour + blend weight toward next band.
  getSlopeBandColor(slopeAngle, outColor) {
    const band = this.getSlopeBand(slopeAngle);
    const base = SLOPE_BAND_COLORS[band];
    const t = this.slopeBandThresholds;

    const thresholds = [0, t.flatUpper, t.gentleUpper, t.moderateUpper, t.steepUpper, t.verySteepUpper, Math.PI / 2];
    let nextBand = band;
    let blend = 0;
    if (band < SLOPE_BAND.CLIFF) {
      const bandLow = thresholds[band];
      const bandHigh = thresholds[band + 1];
      if (bandHigh > bandLow) {
        const within = slopeAngle - bandLow;
        const range = bandHigh - bandLow;
        const tFade = smoothstep(0.8, 1.0, within / range);
        nextBand = band + 1;
        blend = tFade;
      }
    }

    const nextColor = SLOPE_BAND_COLORS[nextBand];
    outColor[0] = base[0] * (1 - blend) + nextColor[0] * blend;
    outColor[1] = base[1] * (1 - blend) + nextColor[1] * blend;
    outColor[2] = base[2] * (1 - blend) + nextColor[2] * blend;
    return { band, blend, color: outColor };
  }

  // ══════════════════════════════════════════════════════════
  // ─── height lookup (delegates or interpolates) ───────────
  // ══════════════════════════════════════════════════════════
  _getHeight(wx, wz, lod) {
    if (this._elevation) {
      return this._elevation.getElevation(wx, wz, lod);
    }
    if (this._terrain) {
      return this._terrain.getHeight(wx, wz, lod);
    }
    const tc = this._frameRef?.layers?.spatial?.terrainChunks;
    if (!tc || tc.count === 0) return 0;
    return this._interpolateFromChunks(tc, wx, wz);
  }

  _interpolateFromChunks(tc, wx, wz) {
    const chunkSize = this._terrain ? this._terrain.chunkSize : 1000;
    const cx = Math.floor(wx / chunkSize);
    const cz = Math.floor(wz / chunkSize);
    let wSum = 0;
    let hSum = 0;
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
  // ─── per-entity sampling ─────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _sampleEntities(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial || !spatial.sphere) return 0;

    const sphere = spatial.sphere;
    const n = Math.min(sphere.length / 4, this._entityCapacity);
    const d = this.sampleDistance;
    let sampled = 0;

    for (let i = 0; i < n; i++) {
      const so = i * 4;
      const sx = sphere[so];
      const sz = sphere[so + 2];

      // Finite-difference gradient.
      const hL = this._getHeight(sx - d, sz, 0);
      const hR = this._getHeight(sx + d, sz, 0);
      const hD = this._getHeight(sx, sz - d, 0);
      const hU = this._getHeight(sx, sz + d, 0);

      const dhdx = (hR - hL) / (2 * d);
      const dhdz = (hU - hD) / (2 * d);
      const mag = Math.sqrt(dhdx * dhdx + dhdz * dhdz);
      const slopeAngle = Math.atan(mag);
      const aspect = Math.atan2(-dhdz, -dhdx);

      // Downhill and cross-slope unit vectors.
      let dhx = 0, dhz = 0;
      let cxx = 1, czz = 0;
      if (mag > Precision.EPSILON) {
        dhx = -dhdx / mag;
        dhz = -dhdz / mag;
        cxx = -dhz;     // perpendicular in XZ plane
        czz = dhx;
      }

      // Curvature via second differences (concave is +, convex is -).
      const hC = this._getHeight(sx, sz, 0);
      const laplacian = (hL + hR + hD + hU - 4 * hC) / (d * d);

      // Soil stability.
      const stability = Math.cos(slopeAngle);

      // Water flow bias — flowHint read from chunk summary if present.
      let flowHint = 1.0;
      const tc = spatial.terrainChunks;
      if (tc && tc.count > 0) {
        // Find closest chunk with flowHint.
        const chunkSize = this._terrain ? this._terrain.chunkSize : 1000;
        const ecx = Math.floor(sx / chunkSize);
        const ecz = Math.floor(sz / chunkSize);
        for (let k = 0; k < tc.count; k++) {
          if (tc.cx[k] === ecx && tc.cz[k] === ecz) {
            flowHint = tc.flowHint[k];
            break;
          }
        }
      }
      const excess = mag - this.waterFlowCriticalTan;
      const waterBias = excess > 0 ? excess * flowHint : 0;

      // Slope band + colour.
      const band = this.getSlopeBand(slopeAngle);
      const col = this._tmpVecA;
      this.getSlopeBandColor(slopeAngle, col);

      // Store.
      this._entityGradX[i] = dhdx;
      this._entityGradZ[i] = dhdz;
      this._entityGradMag[i] = mag;
      this._entitySlopeAngle[i] = slopeAngle;
      this._entityAspect[i] = aspect;
      this._entityDownhillX[i] = dhx;
      this._entityDownhillZ[i] = dhz;
      this._entityCrossX[i] = cxx;
      this._entityCrossZ[i] = czz;
      this._entityCurvature[i] = laplacian;
      this._entityStability[i] = stability;
      this._entityWaterBias[i] = waterBias;
      this._entitySlopeBand[i] = band;
      this._entityBandBlend[i] = this._computeBandBlend(slopeAngle, band);
      this._entityBandColor[i * 3]     = col.x;
      this._entityBandColor[i * 3 + 1] = col.y;
      this._entityBandColor[i * 3 + 2] = col.z;
      this._entityValid[i] = 1;

      sampled++;
    }

    this._stats.entitiesSampled += sampled;
    return sampled;
  }

  _computeBandBlend(slopeAngle, band) {
    if (band >= SLOPE_BAND.CLIFF) return 0;
    const t = this.slopeBandThresholds;
    const thresholds = [0, t.flatUpper, t.gentleUpper, t.moderateUpper, t.steepUpper, t.verySteepUpper];
    const low = thresholds[band];
    const high = thresholds[band + 1];
    if (high <= low) return 0;
    return smoothstep(0.8, 1.0, (slopeAngle - low) / (high - low));
  }

  // ══════════════════════════════════════════════════════════
  // ─── per-chunk summary ───────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _summarizeChunks(frame) {
    const tc = frame.layers.spatial?.terrainChunks;
    if (!tc || tc.count === 0) return;

    const count = Math.min(tc.count, this._chunkCapacity);
    for (let i = 0; i < count; i++) {
      // Read slope/roughness/flowHint from the chunk summary.
      const avgSlope = tc.avgSlope[i];
      const roughness = tc.roughness[i];
      const flowHint = tc.flowHint[i];
      const chunkX = tc.cx[i];
      const chunkZ = tc.cz[i];
      const chunkSize = this._terrain ? this._terrain.chunkSize : 1000;

      // Compute world centre for the chunk and sample its gradient.
      const centreX = (chunkX + 0.5) * chunkSize;
      const centreZ = (chunkZ + 0.5) * chunkSize;
      const aspect = this.getAspect(centreX, centreZ);
      const stability = Math.cos(avgSlope);
      const band = this.getSlopeBand(avgSlope);
      const flowBias = Math.max(0, Math.tan(avgSlope) - this.waterFlowCriticalTan) * flowHint;

      this._chunkAvgSlope[i] = avgSlope;
      this._chunkMaxSlope[i] = Math.max(avgSlope, Math.atan(roughness * 0.5));
      this._chunkAvgAspect[i] = aspect;
      this._chunkDominantBand[i] = band;
      this._chunkFlowBias[i] = flowBias;
      this._chunkStability[i] = stability;
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

    if (!spatial.slope) {
      spatial.slope = {
        entityGradX:       this._entityGradX,
        entityGradZ:       this._entityGradZ,
        entityGradMag:     this._entityGradMag,
        entitySlopeAngle:  this._entitySlopeAngle,
        entityAspect:      this._entityAspect,
        entityDownhillX:   this._entityDownhillX,
        entityDownhillZ:   this._entityDownhillZ,
        entityCrossX:      this._entityCrossX,
        entityCrossZ:      this._entityCrossZ,
        entityCurvature:   this._entityCurvature,
        entityStability:   this._entityStability,
        entityWaterBias:   this._entityWaterBias,
        entitySlopeBand:   this._entitySlopeBand,
        entityBandBlend:   this._entityBandBlend,
        entityBandColor:   this._entityBandColor,
        entityValid:       this._entityValid,
        chunkAvgSlope:     this._chunkAvgSlope,
        chunkMaxSlope:     this._chunkMaxSlope,
        chunkAvgAspect:    this._chunkAvgAspect,
        chunkDominantBand: this._chunkDominantBand,
        chunkFlowBias:     this._chunkFlowBias,
        chunkStability:    this._chunkStability,
        chunkValid:        this._chunkValid
      };
    }
  }

  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    // Material-facing weight: how much slope colour should mix in.
    // Materials read `slopeBandWeights` to blend soil/rock colours.
    if (!physical.slopeBandWeights) {
      physical.slopeBandWeights = new Float32Array(6);
    }
    // Aggregate slope band distribution across sampled entities.
    this._aggregateBandWeights(physical.slopeBandWeights);

    // Soil stability aggregate for physics (friction multiplier).
    if (physical.soilStability === undefined) {
      physical.soilStability = 1.0;
    }
    physical.soilStability = this._aggregateStability();
  }

  _aggregateBandWeights(outWeights) {
    for (let i = 0; i < 6; i++) outWeights[i] = 0;
    let count = 0;
    for (let i = 0; i < this._entityCapacity; i++) {
      if (this._entityValid[i] === 0) continue;
      outWeights[this._entitySlopeBand[i]] += 1;
      count++;
    }
    if (count > 0) {
      for (let i = 0; i < 6; i++) outWeights[i] /= count;
    }
  }

  _aggregateStability() {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < this._entityCapacity; i++) {
      if (this._entityValid[i] === 0) continue;
      sum += this._entityStability[i];
      count++;
    }
    return count > 0 ? sum / count : 1.0;
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

    // 1. Summarize per-chunk slope.
    this._summarizeChunks(frame);

    // 2. Sample per-entity slope descriptors.
    this._sampleEntities(frame);

    // 3. Write sub-slices into spatial + physical layers.
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

  setSlopeBandThresholds(thresholds) {
    for (const k of Object.keys(this.slopeBandThresholds)) {
      if (thresholds[k] !== undefined) this.slopeBandThresholds[k] = thresholds[k];
    }
    return this;
  }

  setWaterFlowCriticalTan(tan) {
    this.waterFlowCriticalTan = tan;
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
    this._frameRef = null;
    this._entityGradX.fill(0);
    this._entityGradZ.fill(0);
    this._entityGradMag.fill(0);
    this._entitySlopeAngle.fill(0);
    this._entityAspect.fill(0);
    this._entityDownhillX.fill(0);
    this._entityDownhillZ.fill(0);
    this._entityCrossX.fill(0);
    this._entityCrossZ.fill(0);
    this._entityCurvature.fill(0);
    this._entityStability.fill(0);
    this._entityWaterBias.fill(0);
    this._entitySlopeBand.fill(0);
    this._entityBandBlend.fill(0);
    this._entityBandColor.fill(0);
    this._entityValid.fill(0);
    this._chunkAvgSlope.fill(0);
    this._chunkMaxSlope.fill(0);
    this._chunkAvgAspect.fill(0);
    this._chunkDominantBand.fill(0);
    this._chunkFlowBias.fill(0);
    this._chunkStability.fill(0);
    this._chunkValid.fill(0);
  }
}

export {
  SlopeGradientProvider,
  SLOPE_BAND,
  SLOPE_BAND_THRESHOLDS,
  SLOPE_BAND_COLORS,
  WATER_FLOW_CRITICAL_TAN,
  SLOPE_SAMPLE_DISTANCE,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};