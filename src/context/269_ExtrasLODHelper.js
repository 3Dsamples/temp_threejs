// file number : 269
// full path name : src/context/269_ExtrasLODHelper.js
// description : Hierarchical LOD helper implementing level index l = floor(log_R(d/d0)), threshold d_l = d0 * R^l, and smooth alpha weight alpha = smoothstep(d_l, d_l+1, d). Provides hysteresis-gated discrete switching to eliminate popping at boundaries, per-object LOD selection with cached thresholds, material/lighting LOD blending (PBR-to-anime interpolation, shadow cascade scaling, emissive intensity attenuation), and context-frame integration for batch LOD evaluation. All scratch vectors are pooled; computeLevel() and computeAlpha() allocate nothing.
// best for : Driving HLOD transitions across km/10km/100km/1000km chunks, smoothly fading PBR-to-anime material parameters by distance, scaling shadow cascades and light intensity per LOD tier, and feeding the UpdateLODConsumer at 10 Hz without per-frame garbage-collection pressure.
// license : MIT

import {
  Vec3,
  Mat4,
  Quat,
  Precision,
  ContextFrame,
  CoreClock,
  CoreLayers,
  LAYER,
  smoothstep,
  CurveMaterialBlender,
  acquireCurve,
  releaseAllCurves
} from './264_MathECSImportBarrel.js';

// ─── default LOD configuration ────────────────────────────────────
const LOD_DEFAULTS = Object.freeze({
  d0: 10,            // base distance in world units
  R: 10,             // ratio between adjacent levels (log base)
  levels: 4,         // number of discrete levels (0..levels-1)
  hysteresis: 0.05,  // 5% hysteresis band to prevent flickering
  smoothBand: 0.15   // 15% of level width used for smooth fade
});

// ─── three-level semantic mapping for the living blueprint ───────
const LOD_TIER = Object.freeze({
  HIGH: 0,       // < 1 km: full geometry, PBR, full shadows
  SIMPLIFIED: 1, // 1–100 km: reduced geometry, simplified PBR
  BILLBOARD: 2,  // > 100 km: billboard or particle
  CULLED: 3      // beyond render distance: skipped entirely
});

class ExtrasLODHelper {
  constructor(options = {}) {
    this.d0 = options.d0 ?? LOD_DEFAULTS.d0;
    this.R = options.R ?? LOD_DEFAULTS.R;
    this.maxLevels = options.maxLevels ?? LOD_DEFAULTS.levels;
    this.hysteresis = options.hysteresis ?? LOD_DEFAULTS.hysteresis;
    this.smoothBand = options.smoothBand ?? LOD_DEFAULTS.smoothBand;

    // Precomputed thresholds: d_l = d0 * R^l
    this._thresholds = new Float64Array(this.maxLevels);
    this._logR = Math.log(this.R);
    this._rebuildThresholds();

    // Cached per-object current level (for hysteresis).
    this._currentLevel = new Int32Array(options.capacity ?? 4096);
    this._currentLevelCount = this._currentLevel.length;

    // Material/lighting blender reused from curve utils.
    this._materialBlender = new CurveMaterialBlender();

    // Scratch vectors and matrices (pooled).
    this._tmpA = new Vec3();
    this._tmpB = new Vec3();
    this._tmpC = new Vec3();
    this._tmpMat = new Mat4();

    // Diagnostic counters.
    this._stats = {
      levelQueries: 0,
      smoothQueries: 0,
      hysteresisHits: 0
    };
  }

  // ── threshold rebuild ──────────────────────────────────────────
  _rebuildThresholds() {
    let d = this.d0;
    for (let i = 0; i < this.maxLevels; i++) {
      this._thresholds[i] = d;
      d *= this.R;
    }
  }

  // ── core formula: ℓ = ⌊log_R(d/d₀)⌋ ──────────────────────────
  // Returns the integer level index clamped to [0, maxLevels-1].
  // Uses the precomputed log base; one log + one floor, no division.
  computeLevel(distance) {
    this._stats.levelQueries++;
    if (distance <= this.d0) return 0;
    const level = Math.floor(Math.log(distance / this.d0) / this._logR);
    return level < 0 ? 0 : (level >= this.maxLevels ? this.maxLevels - 1 : level);
  }

  // ── threshold accessor ─────────────────────────────────────────
  computeThreshold(level) {
    const clamped = Math.min(Math.max(level, 0), this.maxLevels - 1);
    return this.d0 * Math.pow(this.R, clamped);
  }

  // ── smooth alpha: α = smoothstep(d_ℓ, d_ℓ+1, d) ──────────────
  // Returns a value in [0,1] indicating blend weight toward the next level.
  computeAlpha(distance, level) {
    this._stats.smoothQueries++;
    const clamped = Math.min(Math.max(level, 0), this.maxLevels - 2);
    const dLow = this._thresholds[clamped];
    const dHigh = this._thresholds[clamped + 1];
    return smoothstep(dLow, dHigh, distance);
  }

  // ── hysteresis-gated discrete level selection ──────────────────
  // Returns the level that should actually be active, preventing
  // flickering when distance hovers around a threshold.
  selectLevel(distance, objectIndex = -1) {
    const rawLevel = this.computeLevel(distance);

    if (objectIndex < 0 || objectIndex >= this._currentLevelCount) {
      return rawLevel;
    }

    const current = this._currentLevel[objectIndex];
    const currentThreshold = this._thresholds[current];
    const nextThreshold = current + 1 < this.maxLevels
      ? this._thresholds[current + 1]
      : Infinity;

    const h = this.hysteresis;
    const lowerBound = currentThreshold * (1 - h);
    const upperBound = nextThreshold * (1 + h);

    // Stay at current level if inside the hysteresis band.
    if (distance >= lowerBound && distance <= upperBound) {
      this._stats.hysteresisHits++;
      return current;
    }

    // Switch down if distance dropped below lower bound.
    if (distance < lowerBound) {
      const newLevel = this.computeLevel(distance);
      this._currentLevel[objectIndex] = newLevel;
      return newLevel;
    }

    // Switch up if distance exceeded upper bound.
    if (distance > upperBound && current + 1 < this.maxLevels) {
      const newLevel = this.computeLevel(distance);
      this._currentLevel[objectIndex] = newLevel;
      return newLevel;
    }

    return current;
  }

  // ── full evaluation with smooth weight and blended material ───
  // Returns a small reusable descriptor (do not retain across frames).
  evaluate(distance, objectIndex, materialParams = null) {
    const level = objectIndex >= 0
      ? this.selectLevel(distance, objectIndex)
      : this.computeLevel(distance);

    const alpha = this.computeAlpha(distance, level);

    // Semantic tier mapping for the three-level LOD.
    let tier;
    if (level === 0) tier = LOD_TIER.HIGH;
    else if (level === 1) tier = LOD_TIER.SIMPLIFIED;
    else if (level < this.maxLevels - 1) tier = LOD_TIER.BILLBOARD;
    else tier = LOD_TIER.CULLED;

    // Material/lighting blend if parameters are supplied.
    let blendedColor = null;
    let quantizeSteps = 3;
    let rimPower = 2;
    let emissiveIntensity = 0;
    let lightIntensity = 1;

    if (materialParams) {
      blendedColor = this._materialBlender.blendPBRAnime(
        alpha, materialParams.pbr, materialParams.anime
      );
      quantizeSteps = this._materialBlender.quantizeSteps;
      rimPower = this._materialBlender.rimPower;
      emissiveIntensity = this._materialBlender.emissiveIntensity;
      lightIntensity = this._materialBlender.lightIntensity;

      // Attenuate emissive and light intensity with LOD tier.
      // Higher LOD (farther) keeps only the cheapest contribution.
      const tierScale = tier === LOD_TIER.HIGH ? 1.0
        : tier === LOD_TIER.SIMPLIFIED ? 0.6
        : tier === LOD_TIER.BILLBOARD ? 0.3
        : 0.0;
      emissiveIntensity *= tierScale;
      lightIntensity *= tierScale;
    }

    // Shadow cascade scaling: high → full, simplified → reduced,
    // billboard → none. The returned integer is the cascade count.
    const shadowCascades = tier === LOD_TIER.HIGH ? 4
      : tier === LOD_TIER.SIMPLIFIED ? 2
      : 0;

    return {
      level,
      alpha,
      tier,
      shadowCascades,
      blendedColor,
      quantizeSteps,
      rimPower,
      emissiveIntensity,
      lightIntensity
    };
  }

  // ── batch evaluation from the context frame ────────────────────
  // Reads distances from the spatial layer and writes level indices
  // into a caller-supplied Int32Array. Returns the number processed.
  evaluateBatch(frame, outLevels, outAlphas, count) {
    if (!frame || !frame.layers || !frame.layers.spatial) return 0;
    const spatial = frame.layers.spatial;
    const distancesSq = spatial.distancesSq;
    if (!distancesSq) return 0;

    const n = Math.min(count, distancesSq.length);
    for (let i = 0; i < n; i++) {
      const dSq = distancesSq[i];
      // Distances are stored squared; take one sqrt only when needed.
      const d = Math.sqrt(dSq);
      const level = this.selectLevel(d, i);
      outLevels[i] = level;
      outAlphas[i] = this.computeAlpha(d, level);
    }
    return n;
  }

  // ── distance-to-LOD mapping for a whole chunk list ────────────
  // Given an array of chunk distances, returns the set of distinct
  // LOD levels that will be active. Useful for HLOD planning.
  distinctLevels(distances) {
    const seen = new Uint8Array(this.maxLevels);
    let count = 0;
    for (let i = 0; i < distances.length; i++) {
      const level = this.computeLevel(distances[i]);
      if (seen[level] === 0) {
        seen[level] = 1;
        count++;
      }
    }
    const out = new Int32Array(count);
    let idx = 0;
    for (let i = 0; i < this.maxLevels; i++) {
      if (seen[i] === 1) out[idx++] = i;
    }
    return out;
  }

  // ── semantic tier helpers ─────────────────────────────────────
  tierForLevel(level) {
    if (level === 0) return LOD_TIER.HIGH;
    if (level === 1) return LOD_TIER.SIMPLIFIED;
    if (level < this.maxLevels - 1) return LOD_TIER.BILLBOARD;
    return LOD_TIER.CULLED;
  }

  // ── diagnostics ───────────────────────────────────────────────
  getStats() {
    return Object.freeze({ ...this._stats });
  }

  resetStats() {
    this._stats.levelQueries = 0;
    this._stats.smoothQueries = 0;
    this._stats.hysteresisHits = 0;
  }

  dispose() {
    this._currentLevel.fill(0);
    this._thresholds.fill(0);
  }
}

export {
  ExtrasLODHelper,
  LOD_DEFAULTS,
  LOD_TIER
};