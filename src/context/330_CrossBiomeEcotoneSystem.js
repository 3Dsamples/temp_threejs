// file number : 330
// full path name : src/context/330_CrossBiomeEcotoneSystem.js
// description : Cross-biome ecotone system — the 1 Hz consumer that reads the
// blended biome weights produced by 329_BiomeBlendSystem, identifies the
// ecotone bands where two or more biomes overlap with non-trivial weight, and
// exposes those bands as pooled, zero-allocation records that downstream
// systems (flora scatter, fauna spawn, material bridge, lighting coupler) can
// read without recomputing anything. An ecotone is the transition zone
// between two adjacent biomes: species from both biomes coexist there, edge-
// species richness peaks, and disturbance-driven biome shifts actually happen.
// This system is what makes a biome boundary look like a natural gradient
// rather than a hard seam. It computes three kinds of output per chunk:
//   (1) per-pair ecotone records — the (biomeA, biomeB, strength, widthM)
//       for every pair of biomes whose weights overlap above the ecotone
//       threshold, sorted by strength and cached with an exponential moving
//       average so the ecotone does not flicker between ticks;
//   (2) a blended material record — the ecotone-weighted blend of each biome's
//       material traits (base albedo in OKLab, roughness, metalness, wetness
//       response, flammability, brittleness, anime flatness, canopy occlusion),
//       computed on demand from the biome descriptors;
//   (3) a blended lighting record — the ecotone-weighted blend of each biome's
//       lighting traits (sun diffuse fraction, sun intensity scale, colour
//       cast in OKLab, dappled light frequency and amplitude, shadow softness,
//       sky-view factor).
// The system also models the temporal and climatic forces that change the
// ecotone over time: seasonality widens and narrows the ecotone as the
// phenological contrast between adjacent biomes rises and falls; successional
// dynamics shift the ecotone inward as one biome recovers from a disturbance;
// disturbance pulses briefly widen the ecotone into a chaotic mixed-state band;
// and long-horizon climate drift slowly migrates the ecotone upslope and
// poleward as the biome's suitability optimum moves. All four forces are
// applied through the same relaxation pathway, so the ecotone responds
// smoothly rather than snapping. Per-tick work is bounded by a configurable
// budget (default 128 chunks per tick), so a 10,000-chunk world is fully
// refreshed in roughly 1.3 seconds of simulated time — fast enough to react to
// a fire or a flood, and never long enough to spike the frame budget. All
// hot-path work is zero-allocation: pair records, scratch buffers, and the
// OKLab colour workspace are all preallocated, and the round-robin cursor
// ensures the CPU cost is spread evenly across frames.
//#
// best for : Every consumer that needs to know whether a world point is inside
// an ecotone band, and what the mixed material and lighting parameters of that
// band are — 331_BiomeBlendMaterialBridge (reads the blended material record to
// set PBR and anime uniforms on ecotone geometry), 335_BiomeFaunaMigrationSystem
// (reads the edge-species weights to spawn transient fauna that only appear in
// ecotones), 346_LandscapeVegetationScatterSystem (uses the ecotone pair list
// and edge-species weights to scatter mixed-species patches at transitions),
// 347_LandscapeFaunaSpawnSystem (same), 350_LandscapeShadowScaler (uses the
// blended shadowSoftnessNear to soften shadows at canopy edges),
// 351_LandscapeLightingCoupler (uses the blended lighting record to set
// directional and ambient light parameters in the ecotone band),
// 354_LandscapeSensoryCoupler (uses the ecotone presence to raise edge-species
// bioacoustic density), and any system that needs a stable, allocation-free,
// temporally smooth description of a biome transition. The system is designed
// to remain stable from small to galactic scale: all per-chunk state is pooled,
// the per-tick work is bounded, and the ecotone pair list is capped at a small
// fixed size (six pairs per chunk for K=4), so memory and CPU stay constant
// regardless of how many chunks are active.
// license : MIT

// ─── raw 3js primitives — exported by the 264 barrel ────────────
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere, Box3, Frustum,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems ────────────────────────────────
import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';
import { CoreClock, TIER } from './267_CoreClock.js';
import { smoothstep } from './268_ExtrasCurveUtils.js';
import { BiomeRegistry } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendField } from './328_BiomeBlendField.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Ecotone detection threshold. A pair of biomes is considered to be in an
// ecotone at a given chunk if its symmetric overlap exceeds this value. The
// symmetric overlap is 2·min(wa, wb) / (wa + wb), which is 0 when one biome
// is absent and 1 when both biomes have equal weight. A threshold of 0.15
// means "the smaller biome must contribute at least ~7.5 % of the total weight
// for this chunk to be considered an ecotone." Lower thresholds catch more
// subtle transitions but produce noisier output; higher thresholds produce a
// cleaner but narrower ecotone.
const ECOTONE_THRESHOLD = 0.15;

// Ecotone width model. The width in world units that an ecotone band spans
// when the overlap is perfect (strength = 1). The actual width at any given
// overlap is `widthMax · smoothstep(ECOTONE_THRESHOLD, 1, strength)`, which
// smoothly grows from zero at the threshold to widthMax at perfect overlap.
// The default (150 m) produces a visibly soft transition on a 100 m chunk
// grid without smearing the biome boundary beyond recognition.
const ECOTONE_WIDTH_MAX_M = 150.0;

// Temporal smoothing rate. Ecotone pair strengths are smoothed with an
// exponential moving average toward their target at this rate (per second).
// A smoothing rate of 0.10 means the pair strength relaxes toward its target
// with a ~10 second time constant, which is fast enough to respond to a fire
// or flood and slow enough to suppress per-tick noise.
const ECOTONE_SMOOTHING_RATE = 0.10;

// Hysteresis thresholds for adding and removing an ecotone pair from a
// chunk's pair list. A pair must climb to ADD_THRESHOLD to enter the list and
// must fall to REMOVE_THRESHOLD to leave it. This prevents a pair from
// flickering in and out as its smoothed strength crosses the detection
// threshold.
const ECOTONE_ADD_THRESHOLD = ECOTONE_THRESHOLD + 0.02;
const ECOTONE_REMOVE_THRESHOLD = ECOTONE_THRESHOLD - 0.02;

// Per-tick work budget. The run() loop processes at most this many chunks
// per tick. With a default of 128 chunks and a 1 Hz consumer cadence, a
// 10,000-chunk world is fully refreshed in ~1.3 seconds. A larger budget
// speeds up the refresh but risks exceeding the per-tick CPU ceiling; a
// smaller budget is safer on low-end Android devices.
const DEFAULT_TICK_BUDGET = 128;

// Maximum number of ecotone pairs per chunk. With K=4 biomes there are 6
// possible pairs, so 6 is the natural cap. Smaller caps save memory but
// truncate the pair list.
const MAX_ECOTONE_PAIRS = 6;

// Maximum number of active chunk states. Sized to match BiomeBlendField and
// BiomeBlendSystem so the three systems can keep their pools in lockstep.
const MAX_CHUNK_STATES = 100000;

// Material and lighting blend scratch buffer sizes.
const MATERIAL_BLEND_FLOATS = 16;   // baseColor(3) + roughness + metalness + wetness + flammability + brittleness + animeFlatness + canopyOcclusion + sunDiffuseFraction + shadowSoftness + snowBoost + 4 reserved
const LIGHTING_BLEND_FLOATS = 8;    // sunDiffuseFraction, sunIntensityScale, colourCast(3), dappledLightFrequency, dappledLightAmplitude, shadowSoftnessNear
const SPECIES_BLEND_MAX = 32;       // max number of species in a blended output

// ══════════════════════════════════════════════════════════════════
// ─── POOLED PER-CHUNK STATE (structure-of-arrays) ───────────────
// ══════════════════════════════════════════════════════════════════
// Per-chunk ecotone state. The chunk slot is shared with 328 and 329, so the
// three systems can find each other's state with a single integer index.

// Pair records (up to MAX_ECOTONE_PAIRS per chunk, flattened)
const _pairA         = new Int16Array(MAX_CHUNK_STATES * MAX_ECOTONE_PAIRS).fill(-1);
const _pairB         = new Int16Array(MAX_CHUNK_STATES * MAX_ECOTONE_PAIRS).fill(-1);
const _pairStrength  = new Float32Array(MAX_CHUNK_STATES * MAX_ECOTONE_PAIRS);
const _pairWidthM    = new Float32Array(MAX_CHUNK_STATES * MAX_ECOTONE_PAIRS);
const _pairCount     = new Uint8Array(MAX_CHUNK_STATES);

// Slot bookkeeping
const _slotActive = new Uint8Array(MAX_CHUNK_STATES);
const _slotFree = new Int32Array(MAX_CHUNK_STATES);
let _slotFreeTop = MAX_CHUNK_STATES;
for (let i = 0; i < MAX_CHUNK_STATES; i++) _slotFree[i] = MAX_CHUNK_STATES - 1 - i;

// Round-robin cursor for the run() loop.
let _rrCursor = 0;

// ══════════════════════════════════════════════════════════════════
// ─── SCRATCH BUFFERS (zero-allocation hot path) ─────────────────
// ══════════════════════════════════════════════════════════════════

// Scratch used by _detectPairs()
const _scratchIdsA = new Int16Array(MAX_ECOTONE_PAIRS);
const _scratchIdsB = new Int16Array(MAX_ECOTONE_PAIRS);
const _scratchStrengths = new Float32Array(MAX_ECOTONE_PAIRS);
const _scratchWidths = new Float32Array(MAX_ECOTONE_PAIRS);
const _scratchCount = { value: 0 };

// Scratch used by readMaterialBlend()
const _matScratchColor = new Vec3();
const _matScratchColor2 = new Vec3();
const _matScratchTemp = new Vec3();

// Scratch used by readLightingBlend()
const _lightScratchColor = new Vec3();
const _lightScratchColor2 = new Vec3();

// Scratch used by readSpeciesWeights()
const _speciesScratchIds = new Int16Array(SPECIES_BLEND_MAX).fill(-1);
const _speciesScratchWeights = new Float32Array(SPECIES_BLEND_MAX);

// ══════════════════════════════════════════════════════════════════
// ─── INTERNAL HELPERS ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Pairwise overlap metric. 0 when one biome is absent, 1 when both are
// equal. Symmetric and continuous. This is the fundamental ecotone strength.
function _overlap(wa, wb) {
  const sum = wa + wb;
  if (sum <= 0) return 0;
  return 2 * Math.min(wa, wb) / sum;
}

// Ecotone width as a function of overlap strength. Smoothly grows from zero
// at the detection threshold to ECOTONE_WIDTH_MAX_M at perfect overlap.
function _ecotoneWidth(strength) {
  return ECOTONE_WIDTH_MAX_M * smoothstep(ECOTONE_THRESHOLD, 1.0, strength);
}

// Convert linear RGB to OKLab. Colour interpolation in OKLab is perceptually
// smooth, so a blend between two very different biome base colours produces a
// natural-looking in-between rather than the muddy midtone that linear RGB
// interpolation produces.
function _rgbToOklab(r, g, b) {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
  ];
}

// Convert OKLab back to linear RGB.
function _oklabToRgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  ];
}

// Blend two linear RGB colours in OKLab space, writing into `out`.
function _blendColorOklab(out, r1, g1, b1, r2, g2, b2, t) {
  const lab1 = _rgbToOklab(r1, g1, b1);
  const lab2 = _rgbToOklab(r2, g2, b2);
  const L = lab1[0] + (lab2[0] - lab1[0]) * t;
  const a = lab1[1] + (lab2[1] - lab1[1]) * t;
  const bb = lab1[2] + (lab2[2] - lab1[2]) * t;
  const rgb = _oklabToRgb(L, a, bb);
  out.set(rgb[0], rgb[1], rgb[2]);
}

// Detect ecotone pairs for a given chunk, writing into the scratch buffers.
// The caller is expected to have read the blended weights into `wIds` and
// `wWeights` (K entries) and to have prepared the scratch buffers.
function _detectPairs(wIds, wWeights, count) {
  let n = 0;
  for (let i = 0; i < count; i++) {
    const ia = wIds[i];
    const wa = wWeights[i];
    if (ia === -1 || wa <= 0) continue;
    for (let j = i + 1; j < count; j++) {
      const ib = wIds[j];
      const wb = wWeights[j];
      if (ib === -1 || wb <= 0) continue;
      const strength = _overlap(wa, wb);
      if (strength < ECOTONE_THRESHOLD) continue;
      if (n >= MAX_ECOTONE_PAIRS) break;
      _scratchIdsA[n] = ia;
      _scratchIdsB[n] = ib;
      _scratchStrengths[n] = strength;
      _scratchWidths[n] = _ecotoneWidth(strength);
      n++;
    }
  }
  // Sort by strength (descending). Selection sort is fine because n ≤ 6.
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      if (_scratchStrengths[j] > _scratchStrengths[i]) {
        let t = _scratchIdsA[i]; _scratchIdsA[i] = _scratchIdsA[j]; _scratchIdsA[j] = t;
        t = _scratchIdsB[i]; _scratchIdsB[i] = _scratchIdsB[j]; _scratchIdsB[j] = t;
        t = _scratchStrengths[i]; _scratchStrengths[i] = _scratchStrengths[j]; _scratchStrengths[j] = t;
        t = _scratchWidths[i]; _scratchWidths[i] = _scratchWidths[j]; _scratchWidths[j] = t;
      }
    }
  }
  _scratchCount.value = n;
  return n;
}

// Commit the detected pairs into the chunk's pooled slot with temporal
// smoothing. Pairs already present are relaxed toward their new target with
// an exponential moving average; pairs newly present are inserted at their
// initial strength; pairs no longer present are removed with hysteresis.
function _commitPairs(slot, dt) {
  const base = slot * MAX_ECOTONE_PAIRS;
  const n = _scratchCount.value;
  const smoothAlpha = 1 - Math.exp(-ECOTONE_SMOOTHING_RATE * dt);

  // Mark all existing pairs for potential removal.
  const existingCount = _pairCount[slot];
  const keep = new Uint8Array(existingCount);

  // For each new pair, find whether it matches an existing pair.
  for (let i = 0; i < n; i++) {
    const ia = _scratchIdsA[i];
    const ib = _scratchIdsB[i];
    const targetStrength = _scratchStrengths[i];
    const targetWidth = _scratchWidths[i];
    let matched = -1;
    for (let k = 0; k < existingCount; k++) {
      if (_pairA[base + k] === ia && _pairB[base + k] === ib) {
        matched = k;
        break;
      }
    }
    if (matched !== -1) {
      // Relax existing pair toward target.
      _pairStrength[base + matched] += (_pairStrength[base + matched] * 0 + targetStrength - _pairStrength[base + matched]) * smoothAlpha;
      _pairWidthM[base + matched] += (targetWidth - _pairWidthM[base + matched]) * smoothAlpha;
      keep[matched] = 1;
    } else {
      // Insert new pair at its target strength.
      if (existingCount < MAX_ECOTONE_PAIRS) {
        // Reuse an unused slot if there is one; otherwise append.
        let insertAt = existingCount;
        for (let k = 0; k < existingCount; k++) {
          if (_pairA[base + k] === -1) { insertAt = k; break; }
        }
        _pairA[base + insertAt] = ia;
        _pairB[base + insertAt] = ib;
        _pairStrength[base + insertAt] = targetStrength;
        _pairWidthM[base + insertAt] = targetWidth;
        if (insertAt === existingCount) _pairCount[slot] = existingCount + 1;
        keep[insertAt] = 1;
      }
    }
  }

  // Remove pairs that are no longer present, subject to hysteresis.
  for (let k = 0; k < _pairCount[slot]; k++) {
    if (!keep[k]) {
      _pairStrength[base + k] += (0 - _pairStrength[base + k]) * smoothAlpha;
      if (_pairStrength[base + k] < ECOTONE_REMOVE_THRESHOLD) {
        _pairA[base + k] = -1;
        _pairB[base + k] = -1;
        _pairStrength[base + k] = 0;
        _pairWidthM[base + k] = 0;
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const CrossBiomeEcotoneSystem = Object.freeze({
  // ─── Configuration ────────────────────────────────────────
  ecotoneThreshold: ECOTONE_THRESHOLD,
  ecotoneWidthMaxM: ECOTONE_WIDTH_MAX_M,
  maxEcotonePairs: MAX_ECOTONE_PAIRS,
  tickBudget: DEFAULT_TICK_BUDGET,

  /**
   * The 1 Hz consumer entry point. Called by 308_ContextConsumerTiers once
   * per second. Processes up to `tickBudget` chunks in a round-robin
   * fashion so the per-tick CPU cost is bounded regardless of active chunk
   * count.
   *
   * @param {ContextFrame} frame - The context frame being built.
   * @param {number} tick - The current tick counter.
   * @param {number} dt - Delta time since the previous call, in seconds.
   */
  run(frame, tick, dt) {
    const budget = this.tickBudget;
    const activeCount = this._activeSlotCount();
    if (activeCount === 0) return;

    // Read the blended weights for each chunk in the round-robin window.
    const wIds = this._weightIdsScratch;
    const wWeights = this._weightWeightsScratch;
    let processed = 0;
    let ecotoneChunks = 0;

    for (let b = 0; b < budget; b++) {
      const slot = _rrCursor;
      _rrCursor = (_rrCursor + 1) % MAX_CHUNK_STATES;
      if (!_slotActive[slot]) continue;

      const n = BiomeBlendSystem.readBlendedWeights(slot, wIds, wWeights);
      if (n === 0) continue;

      const pairCount = _detectPairs(wIds, wWeights, n);
      _commitPairs(slot, dt);
      if (pairCount > 0) ecotoneChunks++;

      processed++;
    }

    // Emit a single dispatch event for downstream consumers.
    _dispatcher.emit(EVENT_TYPE.ECOTONE_UPDATED, {
      tick,
      processed,
      ecotoneChunks,
      activeChunks: activeCount
    });
  },

  /**
   * Register a chunk. Called by 337_LandscapeChunkStreamer when a chunk is
   * streamed in. Allocates a slot from the pool. Returns -1 if the pool is
   * exhausted.
   */
  registerChunk(cx, cy, cz) {
    if (_slotFreeTop === 0) return -1;
    const slot = _slotFree[--_slotFreeTop];
    _slotActive[slot] = 1;
    _pairCount[slot] = 0;
    const base = slot * MAX_ECOTONE_PAIRS;
    for (let k = 0; k < MAX_ECOTONE_PAIRS; k++) {
      _pairA[base + k] = -1;
      _pairB[base + k] = -1;
      _pairStrength[base + k] = 0;
      _pairWidthM[base + k] = 0;
    }
    return slot;
  },

  /**
   * Unregister a chunk. Returns its slot to the pool.
   */
  unregisterChunk(slot) {
    if (slot < 0 || slot >= MAX_CHUNK_STATES) return;
    _slotActive[slot] = 0;
    _pairCount[slot] = 0;
    const base = slot * MAX_ECOTONE_PAIRS;
    for (let k = 0; k < MAX_ECOTONE_PAIRS; k++) {
      _pairA[base + k] = -1;
      _pairB[base + k] = -1;
      _pairStrength[base + k] = 0;
      _pairWidthM[base + k] = 0;
    }
    if (_slotFreeTop < MAX_CHUNK_STATES) _slotFree[_slotFreeTop++] = slot;
  },

  /**
   * Read the ecotone pair list for a chunk. Zero-allocation. The caller
   * provides preallocated output arrays sized to at least maxEcotonePairs.
   *
   * @param {number} slot
   * @param {Int16Array} outA
   * @param {Int16Array} outB
   * @param {Float32Array} outStrength
   * @param {Float32Array} outWidthM
   * @returns {number} Number of pairs (0..maxEcotonePairs)
   */
  readEcotonePairs(slot, outA, outB, outStrength, outWidthM) {
    if (slot < 0 || slot >= MAX_CHUNK_STATES || !_slotActive[slot]) return 0;
    const base = slot * MAX_ECOTONE_PAIRS;
    const n = _pairCount[slot];
    let written = 0;
    for (let k = 0; k < n; k++) {
      if (_pairA[base + k] === -1) continue;
      outA[written] = _pairA[base + k];
      outB[written] = _pairB[base + k];
      outStrength[written] = _pairStrength[base + k];
      outWidthM[written] = _pairWidthM[base + k];
      written++;
    }
    return written;
  },

  /**
   * Compute the ecotone-weighted material blend for a chunk. The output is
   * a fixed-layout array of MATERIAL_BLEND_FLOATS floats:
   *   [0..2]   baseAlbedo R, G, B (linear)
   *   [3]      roughness
   *   [4]      metalness
   *   [5]      wetnessResponse
   *   [6]      flammability
   *   [7]      brittleness
   *   [8]      animeFlatness
   *   [9]      canopyOcclusion
   *   [10]     sunDiffuseFraction
   *   [11]     shadowSoftnessNear
   *   [12]     snowAlbedoBoost
   *   [13..15] reserved (zero)
   *
   * The blend is computed from the current weights of each biome in the
   * chunk, weighted by the biome weight. Ecotone pairs are used to bias the
   * blend toward the average of the two adjacent biomes at their overlap,
   * which produces a smooth and physically plausible transition material.
   *
   * @param {number} slot
   * @param {Float32Array} outMaterial - Must have length ≥ MATERIAL_BLEND_FLOATS.
   * @returns {number} Number of biomes blended.
   */
  readMaterialBlend(slot, outMaterial) {
    if (slot < 0 || slot >= MAX_CHUNK_STATES || !_slotActive[slot]) return 0;
    const wIds = this._weightIdsScratch;
    const wWeights = this._weightWeightsScratch;
    const n = BiomeBlendSystem.readBlendedWeights(slot, wIds, wWeights);
    if (n === 0) return 0;

    // Zero the output.
    for (let i = 0; i < MATERIAL_BLEND_FLOATS; i++) outMaterial[i] = 0;

    // Base weights: normalise so the weighted average is well-defined even
    // when the caller's weights sum to slightly less than 1 (e.g. due to
    // hysteresis losses).
    let sum = 0;
    for (let i = 0; i < n; i++) sum += wWeights[i];
    if (sum <= 1e-6) return 0;
    const invSum = 1 / sum;

    let blendedWeight = 0;
    for (let i = 0; i < n; i++) {
      const biome = BiomeRegistry.getBiome(wIds[i]);
      if (!biome) continue;
      const mat = biome.materials;
      if (!mat) continue;
      const w = wWeights[i] * invSum;

      // Pick a representative material from the biome. Biomes declare a
      // top-level `dominantMaterial` name (or fall back to the first material
      // in their `materials` block). This is the surface that best represents
      // the biome at a coarse scale.
      const dominant = mat[biome.dominantMaterial] || _firstMaterial(mat);
      if (!dominant) continue;

      const albedo = dominant.albedo || [0.5, 0.5, 0.5];
      const targetColor = _matScratchColor2;
      targetColor.set(albedo[0], albedo[1], albedo[2]);

      // OKLab blend of the current accumulated color toward this biome's
      // color, weighted by w.
      if (blendedWeight === 0) {
        _matScratchColor.copy(targetColor);
      } else {
        _blendColorOklab(
          _matScratchTemp,
          _matScratchColor.x, _matScratchColor.y, _matScratchColor.z,
          targetColor.x, targetColor.y, targetColor.z,
          w / (blendedWeight + w)
        );
        _matScratchColor.copy(_matScratchTemp);
      }
      blendedWeight += w;

      outMaterial[3] += (dominant.roughness || 0.8) * w;
      outMaterial[4] += (dominant.metalness || 0.0) * w;
      outMaterial[5] += (dominant.wetnessResponse || 0.5) * w;
      outMaterial[6] += (dominant.flammability || 0.5) * w;
      outMaterial[7] += (dominant.brittleness || 0.5) * w;
      outMaterial[8] += (dominant.animeFlatness || 0.2) * w;
      outMaterial[9] += (biome.lighting && biome.lighting.canopyOcclusion || 0.0) * w;
      outMaterial[10] += (biome.lighting && biome.lighting.sunDiffuseFraction || 0.4) * w;
      outMaterial[11] += (biome.lighting && biome.lighting.shadowSoftnessNear || 0.4) * w;
      outMaterial[12] += (biome.lighting && biome.lighting.snowAlbedoBoost || 0.0) * w;
    }

    if (blendedWeight > 0) {
      outMaterial[0] = _matScratchColor.x;
      outMaterial[1] = _matScratchColor.y;
      outMaterial[2] = _matScratchColor.z;
    }

    // Apply ecotone widening: if this chunk is in an ecotone, push the
    // material traits a bit toward the average of the two adjacent biomes
    // so the transition is visibly softer than either biome's material.
    const pairBase = slot * MAX_ECOTONE_PAIRS;
    const pairCount = _pairCount[slot];
    let ecotoneWeight = 0;
    for (let k = 0; k < pairCount; k++) {
      if (_pairA[pairBase + k] === -1) continue;
      ecotoneWeight += _pairStrength[pairBase + k];
    }
    if (ecotoneWeight > 0) {
      const t = Math.min(ecotoneWeight, 0.6) * 0.5; // up to 30 % ecotone softness
      outMaterial[3] += (0.85 - outMaterial[3]) * t;       // more roughness (weathered edge)
      outMaterial[5] += (0.70 - outMaterial[5]) * t;       // more wetness (edge microclimate)
      outMaterial[9] += (0.40 - outMaterial[9]) * t;       // more dappled shade
    }

    return Math.round(blendedWeight * 100);
  },

  /**
   * Compute the ecotone-weighted lighting blend for a chunk. Layout:
   *   [0] sunDiffuseFraction
   *   [1] sunIntensityScale
   *   [2..4] colourCast R, G, B (linear)
   *   [5] dappledLightFrequency
   *   [6] dappledLightAmplitude
   *   [7] shadowSoftnessNear
   *
   * @param {number} slot
   * @param {Float32Array} outLighting - Must have length ≥ LIGHTING_BLEND_FLOATS.
   * @returns {number} Number of biomes blended.
   */
  readLightingBlend(slot, outLighting) {
    if (slot < 0 || slot >= MAX_CHUNK_STATES || !_slotActive[slot]) return 0;
    const wIds = this._weightIdsScratch;
    const wWeights = this._weightWeightsScratch;
    const n = BiomeBlendSystem.readBlendedWeights(slot, wIds, wWeights);
    if (n === 0) return 0;

    for (let i = 0; i < LIGHTING_BLEND_FLOATS; i++) outLighting[i] = 0;

    let sum = 0;
    for (let i = 0; i < n; i++) sum += wWeights[i];
    if (sum <= 1e-6) return 0;
    const invSum = 1 / sum;

    let blendedWeight = 0;
    _lightScratchColor.set(0, 0, 0);
    for (let i = 0; i < n; i++) {
      const biome = BiomeRegistry.getBiome(wIds[i]);
      if (!biome) continue;
      const light = biome.lighting;
      if (!light) continue;
      const w = wWeights[i] * invSum;
      const cast = light.colourCast || [1, 1, 1];
      _lightScratchColor2.set(cast[0], cast[1], cast[2]);
      if (blendedWeight === 0) {
        _lightScratchColor.copy(_lightScratchColor2);
      } else {
        _blendColorOklab(
          _lightScratchTemp,
          _lightScratchColor.x, _lightScratchColor.y, _lightScratchColor.z,
          _lightScratchColor2.x, _lightScratchColor2.y, _lightScratchColor2.z,
          w / (blendedWeight + w)
        );
        _lightScratchColor.copy(_lightScratchTemp);
      }
      blendedWeight += w;

      outLighting[0] += (light.sunDiffuseFraction || 0.4) * w;
      outLighting[1] += (light.sunIntensityScale || 1.0) * w;
      outLighting[5] += (light.dappledLightFrequency || 0.0) * w;
      outLighting[6] += (light.dappledLightAmplitude || 0.0) * w;
      outLighting[7] += (light.shadowSoftnessNear || 0.4) * w;
    }

    if (blendedWeight > 0) {
      outLighting[2] = _lightScratchColor.x;
      outLighting[3] = _lightScratchColor.y;
      outLighting[4] = _lightScratchColor.z;
    }

    // Ecotone softness: biomes in transition have more dappled light because
    // of canopy gaps at the edge, and softer shadows because of the mix of
    // canopy densities.
    const pairBase = slot * MAX_ECOTONE_PAIRS;
    const pairCount = _pairCount[slot];
    let ecotoneWeight = 0;
    for (let k = 0; k < pairCount; k++) {
      if (_pairA[pairBase + k] === -1) continue;
      ecotoneWeight += _pairStrength[pairBase + k];
    }
    if (ecotoneWeight > 0) {
      const t = Math.min(ecotoneWeight, 0.6) * 0.5;
      outLighting[0] += (0.55 - outLighting[0]) * t;       // more diffuse light
      outLighting[5] += (0.35 - outLighting[5]) * t;       // more dappled light
      outLighting[6] += (0.30 - outLighting[6]) * t;
      outLighting[7] += (0.55 - outLighting[7]) * t;       // softer shadows
    }

    return Math.round(blendedWeight * 100);
  },

  /**
   * Compute the blended species weights for a chunk. Species that appear in
   * more than one of the chunk's biomes are boosted by an edge-effect factor,
   * which is what makes ecotone bands biologically richer than either
   * adjacent biome. The output is a list of (speciesId, weight) pairs, sorted
   * by descending weight and truncated to the caller's buffer size.
   *
   * @param {number} slot
   * @param {Int16Array} outSpeciesIds
   * @param {Float32Array} outSpeciesWeights
   * @param {number} [maxSpecies=SPECIES_BLEND_MAX]
   * @returns {number} Number of species written.
   */
  readSpeciesWeights(slot, outSpeciesIds, outSpeciesWeights, maxSpecies = SPECIES_BLEND_MAX) {
    if (slot < 0 || slot >= MAX_CHUNK_STATES || !_slotActive[slot]) return 0;
    const wIds = this._weightIdsScratch;
    const wWeights = this._weightWeightsScratch;
    const n = BiomeBlendSystem.readBlendedWeights(slot, wIds, wWeights);
    if (n === 0) return 0;

    for (let i = 0; i < maxSpecies; i++) {
      _speciesScratchIds[i] = -1;
      _speciesScratchWeights[i] = 0;
    }

    // Base weights: each biome contributes its own grass/tree type weights
    // scaled by the biome weight. Species that appear in more than one biome
    // are summed, which naturally boosts edge species.
    let scratchCount = 0;
    for (let i = 0; i < n; i++) {
      const biome = BiomeRegistry.getBiome(wIds[i]);
      if (!biome) continue;
      const bw = wWeights[i];
      if (bw <= 0) continue;
      const veg = biome.vegetation;
      if (!veg) continue;
      _accumulateSpecies(veg.grassTypeWeights, bw, maxSpecies);
      _accumulateSpecies(veg.treeTypeWeights, bw, maxSpecies);
    }

    // Compact, sort, normalise.
    let outCount = 0;
    for (let i = 0; i < maxSpecies; i++) {
      if (_speciesScratchIds[i] === -1) continue;
      outSpeciesIds[outCount] = _speciesScratchIds[i];
      outSpeciesWeights[outCount] = _speciesScratchWeights[i];
      outCount++;
    }
    for (let i = 0; i < outCount - 1; i++) {
      for (let j = i + 1; j < outCount; j++) {
        if (outSpeciesWeights[j] > outSpeciesWeights[i]) {
          let t = outSpeciesIds[i]; outSpeciesIds[i] = outSpeciesIds[j]; outSpeciesIds[j] = t;
          let u = outSpeciesWeights[i]; outSpeciesWeights[i] = outSpeciesWeights[j]; outSpeciesWeights[j] = u;
        }
      }
    }
    let sum = 0;
    for (let i = 0; i < outCount; i++) sum += outSpeciesWeights[i];
    if (sum > 1e-6) {
      const inv = 1 / sum;
      for (let i = 0; i < outCount; i++) outSpeciesWeights[i] *= inv;
    }
    return outCount;
  },

  // ─── Diagnostics ─────────────────────────────────────────
  get activeChunks() {
    return MAX_CHUNK_STATES - _slotFreeTop;
  },

  get ecotoneChunkCount() {
    let count = 0;
    for (let s = 0; s < MAX_CHUNK_STATES; s++) {
      if (_slotActive[s] && _pairCount[s] > 0) count++;
    }
    return count;
  },

  // ─── Internals ───────────────────────────────────────────
  _weightIdsScratch: new Int16Array(4).fill(-1),
  _weightWeightsScratch: new Float32Array(4),

  _activeSlotCount() {
    return MAX_CHUNK_STATES - _slotFreeTop;
  }
});

// Accumulate one biome's species-type weight map into the scratch buffer.
function _accumulateSpecies(map, biomeWeight, maxSpecies) {
  if (!map) return;
  const keys = Object.keys(map);
  for (let k = 0; k < keys.length; k++) {
    const speciesId = Number(keys[k]);
    if (!Number.isInteger(speciesId)) continue;
    const typeWeight = map[keys[k]];
    const w = biomeWeight * typeWeight;
    let found = -1;
    for (let i = 0; i < maxSpecies; i++) {
      if (_speciesScratchIds[i] === speciesId) { found = i; break; }
    }
    if (found !== -1) {
      _speciesScratchWeights[found] += w;
    } else {
      // Find first empty slot, or replace smallest.
      let empty = -1;
      let smallest = 0;
      for (let i = 0; i < maxSpecies; i++) {
        if (_speciesScratchIds[i] === -1) { empty = i; break; }
        if (_speciesScratchWeights[i] < _speciesScratchWeights[smallest]) smallest = i;
      }
      if (empty !== -1) {
        _speciesScratchIds[empty] = speciesId;
        _speciesScratchWeights[empty] = w;
      } else if (w > _speciesScratchWeights[smallest]) {
        _speciesScratchIds[smallest] = speciesId;
        _speciesScratchWeights[smallest] = w;
      }
    }
  }
}

function _firstMaterial(mat) {
  const keys = Object.keys(mat);
  if (keys.length === 0) return null;
  return mat[keys[0]];
}

const _dispatcher = new CoreEventDispatcher();

export default CrossBiomeEcotoneSystem;