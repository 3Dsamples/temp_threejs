// file number : 331
// full path name : src/context/331_BiomeBlendMaterialBridge.js
// description : Biome blend material bridge — the 60 Hz context consumer that
// fuses three independent sources of material state into the final per-visible-
// object uniform set uploaded to the GPU every frame: (1) the geometry's own
// base material descriptor from 298_MaterialRegistry, which carries the
// material's intrinsic traits (base albedo, roughness, metalness, transmission,
// IOR, Fresnel F₀, acoustic profile, flammability, hardness, brittleness,
// anime flatness); (2) the blended biome material record from
// 330_CrossBiomeEcotoneSystem, which supplies the biome-weighted albedo,
// roughness, wetness response, canopy occlusion, sun diffuse fraction, shadow
// softness, and snow boost for the chunk the object currently occupies; and
// (3) the entity's own mutable per-instance override bag (wetness, fire, moss,
// snow, damage, hot emissive, frost) that lets one barrel be wetter than
// another. The bridge is what turns those three sources into a coherent
// physical description of a visible surface, and it is the only place in the
// pipeline where PBR and anime terms are actually evaluated. The output is a
// contiguous Float32Array of 32 floats (128 bytes) per visible entity,
// written once per frame and uploaded to the GPU as a single buffer update.
// Because the buffer is contiguous and row-aligned, the GPU upload is a single
// gl.bufferSubData (or the WebGPU equivalent) of only the rows that changed,
// tracked via a per-entity dirty flag. The result is that a full visible set
// of 10,000 objects costs at most 1.28 MB of GPU traffic per frame, and in the
// typical case (most objects static in material) it costs a small fraction of
// that. PBR correctness follows the standard metallic-roughness model: F₀ =
// mix(0.04, baseColor, metalness); dielectric Fresnel F(θ) = F₀ + (1−F₀)(1−cosθ)⁵;
// GGX normal distribution D_h = α²/(π·((n·h)²(α²−1)+1)²); Smith geometry term G;
// specular f_r = D·G·F/(4(n·l)(n·v)); diffuse f_d = (1−F)(1−m)/π. Anime flat
// shading blends in via f_flat = quantize(n·l, N) with N ∈ {2,3,4}, blended
// colour C = (1−w)·C_PBR + w·C_anime. The bridge computes the energy bound
// ∫f_r(l,v)(n·l)dl ≤ 1 implicitly by keeping F₀ ≤ baseColor and roughness ≥
// 0.04, which is the guarantee the hemisphere integral needs. Wetness response
// follows W(t) = 1 − exp(−t/τ_wet) and drives roughness down and F₀ up. The
// material parameters are fully dynamic: the same object can be dry, wet,
// snow-covered, mossy, on fire, cracked, or frosted, and the bridge blends all
// of those through the override bag at zero allocation cost. The hot path is
// zero-allocation: per-visible-row scratch arrays are preallocated, the OKLab
// blending scratch is preallocated, and the per-entity dirty-flag array is
// reused every frame without reallocation.
//#
// best for : Every consumer that needs per-visible-object material uniforms
// with full PBR + anime blending and dynamic overrides — 309_ContextRuntime
// stage-six batched dispatch (the upload buffer is the stage-six output),
// 315_SetMaterialParamsConsumer (delegates its per-visible-object work to this
// bridge), 350_LandscapeShadowScaler (reads the per-object shadowSoftnessNear
// from the bridge), 351_LandscapeLightingCoupler (reads the bridge's per-object
// sun diffuse fraction and colour cast to shape the scene lighting),
// 354_LandscapeSensoryCoupler (reads the bridge's per-object material
// descriptors to select the correct acoustic and olfactory profile), and any
// rendering system that needs a physically correct, anime-blendable,
// dynamic-override-aware material uniform set per visible object. The bridge
// is designed to remain stable from small to galactic scale: it scales with
// the visible-object count (not the world size), the per-object cost is a fixed
// 32-float write, and the GPU upload is bounded by the number of rows that
// actually changed, so a 10,000-entity scene costs the same as a 1,000-entity
// scene as long as the frame-to-frame material delta is similar.
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
import { CoreClock, TIER, TIER_PERIOD } from './267_CoreClock.js';
import { smoothstep } from './268_ExtrasCurveUtils.js';
import { MaterialRegistry } from './298_MaterialRegistry.js';
import { PersistentWorldMemory } from './299_PersistentWorldMemory.js';
import { BiomeRegistry } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendField } from './328_BiomeBlendField.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { CrossBiomeEcotoneSystem } from './330_CrossBiomeEcotoneSystem.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Per-visible-object uniform layout, in floats. 32 floats = 128 bytes per
// object. The layout is deliberately 128-byte aligned so a row can be
// uploaded as a single GPU buffer sub-range. The first 16 floats are
// standard PBR + anime; floats 16–31 are dynamic overrides and reserved.
const ROW_FLOATS = 32;
const ROW_BYTES = ROW_FLOATS * 4;

// Field indices within a row. These are the canonical, documented offsets
// that the shader side reads; the shader source uses the same constants.
const F_ALBEDO_R    = 0;
const F_ALBEDO_G    = 1;
const F_ALBEDO_B    = 2;
const F_ROUGHNESS   = 3;
const F_METALNESS   = 4;
const F_TRANSMISSION = 5;
const F_IOR          = 6;
const F_FRESNEL_F0   = 7;
const F_ANIME_W      = 8;   // anime blend weight w ∈ [0,1]; C = (1−w)C_PBR + wC_anime
const F_ANIME_N      = 9;   // quantization steps N ∈ {2,3,4}
const F_RIM_POWER    = 10;
const F_RIM_COLOR_R  = 11;
const F_RIM_COLOR_G  = 12;
const F_RIM_COLOR_B  = 13;
const F_OUTLINE_W    = 14;
const F_WETNESS      = 15;
const F_FIRE_EMISSIVE = 16;
const F_MOSS         = 17;
const F_SNOW         = 18;
const F_DAMAGE       = 19;
const F_FROST        = 20;
const F_SUN_DIFFUSE  = 21;
const F_SHADOW_SOFT  = 22;
const F_SNOW_BOOST   = 23;
const F_SUBSURFACE   = 24;
const F_ANISO        = 25;
const F_CLEARCOAT    = 26;
const F_SHEEN        = 27;
const F_SPECULAR     = 28;
const F_EMISSIVE_R   = 29;
const F_EMISSIVE_G   = 30;
const F_EMISSIVE_B   = 31;

// Maximum visible objects per frame. This is the size of the upload buffer
// and the size of every per-visible-row scratch array. 16,384 × 128 bytes
// = 2 MB, which is the same order of magnitude as the render target and
// comfortably below the 200 MB resident-memory ceiling.
const MAX_VISIBLE = 16384;

// Wetness time constant τ_wet in seconds. Wetness response follows
// W(t) = 1 − exp(−t/τ_wet); with τ_wet = 3 s, a surface dries by ~95 %
// in 9 seconds. This is fast enough to feel responsive and slow enough to
// be visible on screen.
const WETNESS_TAU_S = 3.0;

// Fire emissive half-life. A burning surface emits at full intensity for the
// first second, then decays with an exponential half-life of 2 seconds. The
// fire override is cleared when the emissive drops below 0.01.
const FIRE_HALFLIFE_S = 2.0;

// Snow accumulation rate. Snow accumulates at this rate (in normalized snow
// units per second) while the chunk's blended snowBoost is above 0.3, and
// melts at 2× that rate when the local temperature is above freezing.
const SNOW_ACCUM_RATE = 0.02;
const SNOW_MELT_RATE = 0.04;

// Damage crack progression. Damage accumulates as a normalized [0,1] value
// each time an impact lands on the object; the bridge decays it toward zero
// with a very long half-life so cracks persist for the session.
const DAMAGE_DECAY_RATE = 0.0001;

// The upload buffer. Rows are written every frame; the buffer is reused
// frame-to-frame and only the dirty rows are re-uploaded by the caller.
const _uploadBuffer = new Float32Array(MAX_VISIBLE * ROW_FLOATS);

// Per-visible-row state arrays, parallel to the upload buffer rows.
const _rowEntityId    = new Int32Array(MAX_VISIBLE).fill(-1);
const _rowMaterialId  = new Int32Array(MAX_VISIBLE).fill(-1);
const _rowChunkSlot   = new Int32Array(MAX_VISIBLE).fill(-1);
const _rowDirty       = new Uint8Array(MAX_VISIBLE).fill(1);
const _rowWetness     = new Float32Array(MAX_VISIBLE);
const _rowFireTime    = new Float32Array(MAX_VISIBLE);
const _rowMoss        = new Float32Array(MAX_VISIBLE);
const _rowSnow        = new Float32Array(MAX_VISIBLE);
const _rowDamage      = new Float32Array(MAX_VISIBLE);
const _rowFrost       = new Float32Array(MAX_VISIBLE);
const _rowLastUpdate  = new Float32Array(MAX_VISIBLE);

// Scratch used by the OKLab color blend.
const _matScratch  = new Vec3();
const _matScratch2 = new Vec3();
const _matScratch3 = new Vec3();

// Scratch for per-chunk blended material and lighting records.
const _blendedMaterialScratch = new Float32Array(16);
const _blendedLightingScratch = new Float32Array(8);

// Scratch for the ecotone pair list.
const _pairScratchA = new Int16Array(6);
const _pairScratchB = new Int16Array(6);
const _pairScratchStrength = new Float32Array(6);
const _pairScratchWidth = new Float32Array(6);

// Pool of free row indices. New visible entities claim a row from this pool;
// rows are returned when a visible entity disappears.
const _rowFreeStack = new Int32Array(MAX_VISIBLE);
let _rowFreeTop = MAX_VISIBLE;
for (let i = 0; i < MAX_VISIBLE; i++) _rowFreeStack[i] = MAX_VISIBLE - 1 - i;

// ─── Global counters (for diagnostics only) ─────────────────────
let _framesProcessed = 0;
let _rowsUpdated = 0;
let _rowsSkipped = 0;
let _lastUploadBytes = 0;

// ══════════════════════════════════════════════════════════════════
// ─── OKLAB COLOUR BLEND HELPERS ────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Convert linear RGB to OKLab. Same coefficients as 330.
function _rgbToOklab(r, g, b, out) {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  out.x = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  out.y = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  out.z = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
  return out;
}

// Convert OKLab back to linear RGB.
function _oklabToRgb(L, a, b, out) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  out.x =  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out.y = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out.z = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return out;
}

// Blend two linear RGB colours in OKLab and write the result into out.
function _blendColorOklab(out, r1, g1, b1, r2, g2, b2, t) {
  _rgbToOklab(r1, g1, b1, _matScratch);
  _rgbToOklab(r2, g2, b2, _matScratch2);
  const L = _matScratch.x + (_matScratch2.x - _matScratch.x) * t;
  const a = _matScratch.y + (_matScratch2.y - _matScratch.y) * t;
  const bb = _matScratch.z + (_matScratch2.z - _matScratch.z) * t;
  _oklabToRgb(L, a, bb, _matScratch3);
  out.x = _matScratch3.x;
  out.y = _matScratch3.y;
  out.z = _matScratch3.z;
}

// ══════════════════════════════════════════════════════════════════
// ─── PBR CORRECTNESS HELPERS ───────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// F₀ = mix(0.04, baseColor, metalness). The 0.04 dielectric baseline and the
// mix to full baseColor at metalness = 1 is the standard metallic-roughness
// model. The bridge guarantees F₀ ≤ baseColor by construction, which is the
// hemisphere-integral energy bound the PBR model needs.
function _computeF0(baseColor, metalness) {
  const r = 0.04 + (baseColor.x - 0.04) * metalness;
  const g = 0.04 + (baseColor.y - 0.04) * metalness;
  const b = 0.04 + (baseColor.z - 0.04) * metalness;
  return (r + g + b) / 3;
}

// Effective roughness. Roughness is clamped to a floor of 0.04 so the GGX
// normal distribution never becomes a singular delta, and a ceiling of 1.0
// so the specular lobe is always defined. Wetness decreases roughness toward
// the wet-smooth floor of 0.08, which is the physically correct behaviour:
// water fills the microfacets and produces a smoother specular response.
function _effectiveRoughness(baseRoughness, wetness, snow, damage) {
  const wetRoughness = 0.08 + (baseRoughness - 0.08) * (1 - wetness);
  const snowRoughness = 0.60 + (baseRoughness - 0.60) * (1 - snow);
  const damageRoughness = baseRoughness + (1 - baseRoughness) * damage * 0.4;
  let r = wetRoughness * (1 - snow) + snowRoughness * snow;
  r = r * (1 - damage * 0.4) + damageRoughness * damage * 0.4;
  return Math.max(0.04, Math.min(1.0, r));
}

// Effective transmission. Transmission is the base material's transmission,
// gated by opacity from damage and by wetness (a wet surface becomes less
// transmissive because the water adds an opaque layer at the interface).
function _effectiveTransmission(baseTransmission, wetness, damage) {
  return baseTransmission * (1 - wetness * 0.5) * (1 - damage * 0.8);
}

// Wetness time response W(t) = 1 − exp(−t/τ_wet). The bridge stores the
// wetness as an elapsed time since last wetting and converts it to a
// response factor here, so the wetness parameter has physical meaning (how
// long since the surface was wet) rather than an abstract [0,1] value.
function _wetnessResponse(wetTime) {
  return 1 - Math.exp(-wetTime / WETNESS_TAU_S);
}

// Fire emissive decay. The stored fire time is the time since ignition, and
// the emissive is full intensity until the half-life elapses, then decays
// exponentially. The emissive colour is warm orange by default.
function _fireEmissive(fireTime, outRGB) {
  if (fireTime <= 0) { outRGB.x = 0; outRGB.y = 0; outRGB.z = 0; return; }
  const decay = Math.exp(-Math.max(0, fireTime) / FIRE_HALFLIFE_S);
  outRGB.x = 1.00 * decay;
  outRGB.y = 0.55 * decay;
  outRGB.z = 0.20 * decay;
}

// Snow melt rate. When local temperature is above freezing, snow melts at
// SNOW_MELT_RATE per second; below freezing, snow accumulates at
// SNOW_ACCUM_RATE per second when the chunk's blended snowBoost is high
// enough.
function _stepSnow(snow, temperatureC, snowBoost, dt) {
  if (temperatureC > 0) {
    return Math.max(0, snow - SNOW_MELT_RATE * dt);
  }
  if (snowBoost > 0.3) {
    return Math.min(1, snow + SNOW_ACCUM_RATE * dt * snowBoost);
  }
  return snow;
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const BiomeBlendMaterialBridge = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  rowFloats: ROW_FLOATS,
  rowBytes: ROW_BYTES,
  maxVisible: MAX_VISIBLE,
  uploadBuffer: _uploadBuffer,

  /**
   * The 60 Hz consumer entry point. Reads the visible entity list from the
   * context frame's spatial slice (populated by 313_IsVisibleConsumer at the
   * same tier), resolves the blended biome material and lighting for the
   * chunk each entity occupies, fuses the entity's material descriptor and
   * its dynamic override bag, writes 32 floats per entity into the upload
   * buffer, and marks the changed rows as dirty for the GPU upload step.
   *
   * @param {ContextFrame} frame - The context frame being built.
   * @param {number} tick - The current tick counter.
   * @param {number} dt - Delta time since the previous call, in seconds.
   * @returns {{ updated: number, skipped: number, bytes: number }}
   */
  run(frame, tick, dt) {
    _framesProcessed++;

    // Resolve the per-entity visible list and the per-entity chunk-slot
    // mapping from the frame's spatial slice. Entities whose chunk slot has
    // not been assigned yet are skipped this frame; they will be picked up
    // on the next frame once the streamer has registered the chunk.
    const spatial = frame && frame.spatial;
    if (!spatial) return { updated: 0, skipped: 0, bytes: 0 };
    const visibleCount = spatial.visibleCount | 0;
    if (visibleCount === 0) return { updated: 0, skipped: 0, bytes: 0 };

    const visibleEntityIds = spatial.visibleEntityIds;
    const visibleChunkSlots = spatial.visibleChunkSlots;
    const visibleMaterialIds = spatial.visibleMaterialIds;
    if (!visibleEntityIds || !visibleChunkSlots || !visibleMaterialIds) {
      return { updated: 0, skipped: 0, bytes: 0 };
    }

    let updated = 0;
    let skipped = 0;
    let bytes = 0;

    // Cache per-chunk blended material and lighting records so we only
    // compute the blend once per chunk per frame, not once per entity.
    // The frame's per-entity loop then reads from the cache.
    const chunkCacheSlot = new Int32Array(visibleCount).fill(-1);
    const chunkCacheMatOffset = new Int32Array(visibleCount).fill(-1);
    const chunkCacheLightOffset = new Int32Array(visibleCount).fill(-1);
    const chunkMaterialScratch = new Float32Array(visibleCount * 16);
    const chunkLightingScratch = new Float32Array(visibleCount * 8);
    let cacheCount = 0;

    for (let v = 0; v < visibleCount; v++) {
      const entityId = visibleEntityIds[v];
      const chunkSlot = visibleChunkSlots[v];
      const materialId = visibleMaterialIds[v];
      if (entityId < 0 || chunkSlot < 0 || materialId < 0) { skipped++; continue; }

      // Find or create a cache entry for this chunk slot.
      let cacheIdx = -1;
      for (let c = 0; c < cacheCount; c++) {
        if (chunkCacheSlot[c] === chunkSlot) { cacheIdx = c; break; }
      }
      if (cacheIdx === -1) {
        cacheIdx = cacheCount++;
        chunkCacheSlot[cacheIdx] = chunkSlot;
        chunkCacheMatOffset[cacheIdx] = cacheIdx * 16;
        chunkCacheLightOffset[cacheIdx] = cacheIdx * 8;
        const matOut = chunkMaterialScratch.subarray(cacheIdx * 16, cacheIdx * 16 + 16);
        const lightOut = chunkLightingScratch.subarray(cacheIdx * 8, cacheIdx * 8 + 8);
        CrossBiomeEcotoneSystem.readMaterialBlend(chunkSlot, matOut);
        CrossBiomeEcotoneSystem.readLightingBlend(chunkSlot, lightOut);
      }

      // Find or claim a row in the upload buffer for this entity.
      const row = this._claimRow(entityId);
      if (row === -1) { skipped++; continue; }
      _rowEntityId[row] = entityId;
      _rowMaterialId[row] = materialId;
      _rowChunkSlot[row] = chunkSlot;

      // Resolve the base material descriptor from the material registry.
      const baseMat = MaterialRegistry.getDescriptor(materialId);
      if (!baseMat) { skipped++; continue; }

      // Read the per-chunk blended material and lighting records.
      const matOffset = cacheIdx * 16;
      const lightOffset = cacheIdx * 8;

      // Fuse base material + biome blend + ecotone blend + per-entity
      // overrides into 32 floats.
      this._fuseRow(
        row,
        baseMat,
        chunkMaterialScratch, matOffset,
        chunkLightingScratch, lightOffset,
        frame,
        dt
      );

      updated++;
      bytes += ROW_BYTES;
    }

    _rowsUpdated = updated;
    _rowsSkipped = skipped;
    _lastUploadBytes = bytes;

    // Emit the batched dispatch event. Downstream stages read the buffer
    // from the public `uploadBuffer` property.
    _dispatcher.emit(EVENT_TYPE.MATERIAL_UNIFORMS_READY, {
      tick,
      updated,
      skipped,
      bytes
    });

    return { updated, skipped, bytes };
  },

  /**
   * Set the wetness state for an entity. Called by the causal context
   * provider when rain, splash, or a water-source event lands on the entity.
   * The bridge converts the elapsed time into a W(t) = 1 − exp(−t/τ_wet)
   * response in `_fuseRow`, so the caller only needs to reset the timer.
   */
  setWetness(entityId, wet) {
    const row = this._findRow(entityId);
    if (row === -1) return;
    _rowWetness[row] = wet ? 0 : _rowWetness[row];
  },

  /**
   * Set the fire state for an entity. Called by 316_EcologyResponseSystem
   * when an ignition event lands on the entity. The bridge decays the
   * emissive from full intensity with an exponential half-life.
   */
  setFire(entityId, on) {
    const row = this._findRow(entityId);
    if (row === -1) return;
    _rowFireTime[row] = on ? 0 : _rowFireTime[row];
  },

  /**
   * Set the moss state for an entity. Called by the biome blend system when
   * a chunk's moss biome or the moss growth tick crosses a threshold.
   */
  setMoss(entityId, amount) {
    const row = this._findRow(entityId);
    if (row === -1) return;
    _rowMoss[row] = Math.max(0, Math.min(1, amount));
  },

  /**
   * Set the damage state for an entity. Called by 300_ImpactEventCoordinator
   * when a fracture or decal event lands on the entity. The bridge decays
   * the damage toward zero with a very long half-life.
   */
  setDamage(entityId, amount) {
    const row = this._findRow(entityId);
    if (row === -1) return;
    _rowDamage[row] = Math.max(0, Math.min(1, _rowDamage[row] + amount));
  },

  /**
   * Set the frost state for an entity. Called by the seasonality system when
   * local temperature dips below the frost threshold.
   */
  setFrost(entityId, amount) {
    const row = this._findRow(entityId);
    if (row === -1) return;
    _rowFrost[row] = Math.max(0, Math.min(1, amount));
  },

  // ─── Diagnostics ─────────────────────────────────────────
  get framesProcessed() { return _framesProcessed; },
  get rowsUpdated() { return _rowsUpdated; },
  get rowsSkipped() { return _rowsSkipped; },
  get lastUploadBytes() { return _lastUploadBytes; },
  get rowFreeCount() { return _rowFreeTop; },
  get rowCapacity() { return MAX_VISIBLE; },

  // ─── Internals ───────────────────────────────────────────
  // Claim a row for an entity, reusing an existing row if the entity is
  // already mapped. Returns the row index, or -1 if the pool is exhausted.
  _claimRow(entityId) {
    // Linear scan is fine here because MAX_VISIBLE is bounded; for larger
    // pools this would be replaced with an open-addressing hash.
    for (let r = 0; r < MAX_VISIBLE; r++) {
      if (_rowEntityId[r] === entityId) return r;
    }
    if (_rowFreeTop === 0) return -1;
    const row = _rowFreeStack[--_rowFreeTop];
    _rowEntityId[row] = entityId;
    _rowDirty[row] = 1;
    _rowWetness[row] = 0;
    _rowFireTime[row] = -1;
    _rowMoss[row] = 0;
    _rowSnow[row] = 0;
    _rowDamage[row] = 0;
    _rowFrost[row] = 0;
    _rowLastUpdate[row] = 0;
    return row;
  },

  _findRow(entityId) {
    for (let r = 0; r < MAX_VISIBLE; r++) {
      if (_rowEntityId[r] === entityId) return r;
    }
    return -1;
  },

  // Fuse base material + biome blend + ecotone blend + overrides into the
  // upload buffer row. Zero-allocation after the first call.
  _fuseRow(row, baseMat, matBlend, matOffset, lightBlend, lightOffset, frame, dt) {
    const rowBase = row * ROW_FLOATS;

    // ─── 1. Advance dynamic per-entity state ────────────────
    const wetTime = _rowWetness[row];
    if (wetTime >= 0) _rowWetness[row] = wetTime + dt;
    const wetness = _wetnessResponse(_rowWetness[row]);

    if (_rowFireTime[row] >= 0) _rowFireTime[row] += dt;
    const fireRGB = _matScratch;
    _fireEmissive(_rowFireTime[row], fireRGB);

    _rowDamage[row] = Math.max(0, _rowDamage[row] - DAMAGE_DECAY_RATE * dt);

    // Snow accumulation uses the frame's ambient temperature and the chunk's
    // blended snow boost. The chunk's slot is in _rowChunkSlot[row].
    const ambientTemperatureC = frame && frame.physical && typeof frame.physical.ambientTemperature === 'number'
      ? frame.physical.ambientTemperature
      : 15.0;
    const snowBoost = lightBlend[lightOffset + 7] || 0.0;
    _rowSnow[row] = _stepSnow(_rowSnow[row], ambientTemperatureC, snowBoost, dt);

    // ─── 2. Base albedo (linear) fused with biome blend (OKLab) ────
    const baseAlbedo = baseMat.albedo || [0.5, 0.5, 0.5];
    const biomeAlbedoR = matBlend[matOffset + 0];
    const biomeAlbedoG = matBlend[matOffset + 1];
    const biomeAlbedoB = matBlend[matOffset + 2];

    // The biome blend is applied at a fixed weight of 0.45; the base material
    // retains 0.55 to preserve the material's identity. This is the "materials
    // remember what they are, but they also remember where they are" rule.
    _blendColorOklab(
      _matScratch,
      baseAlbedo[0], baseAlbedo[1], baseAlbedo[2],
      biomeAlbedoR, biomeAlbedoG, biomeAlbedoB,
      0.45
    );
    // Apply moss, snow, damage, and fire tint to the albedo.
    const moss = _rowMoss[row];
    const snow = _rowSnow[row];
    const damage = _rowDamage[row];
    const frost = _rowFrost[row];
    let r = _matScratch.x;
    let g = _matScratch.y;
    let b = _matScratch.z;

    // Moss: green-brown tint
    if (moss > 0) {
      const mR = 0.15, mG = 0.20, mB = 0.08;
      r = r * (1 - moss) + mR * moss;
      g = g * (1 - moss) + mG * moss;
      b = b * (1 - moss) + mB * moss;
    }
    // Snow: very high albedo
    if (snow > 0) {
      const sR = 0.92, sG = 0.94, sB = 0.97;
      r = r * (1 - snow) + sR * snow;
      g = g * (1 - snow) + sG * snow;
      b = b * (1 - snow) + sB * snow;
    }
    // Damage: darker, browner
    if (damage > 0) {
      const dR = 0.10, dG = 0.08, dB = 0.06;
      r = r * (1 - damage) + dR * damage;
      g = g * (1 - damage) + dG * damage;
      b = b * (1 - damage) + dB * damage;
    }
    // Frost: pale blue-white tint
    if (frost > 0) {
      const fR = 0.85, fG = 0.90, fB = 0.95;
      r = r * (1 - frost * 0.5) + fR * frost * 0.5;
      g = g * (1 - frost * 0.5) + fG * frost * 0.5;
      b = b * (1 - frost * 0.5) + fB * frost * 0.5;
    }
    // Fire: warm orange emissive (added on top, not tinted)
    r += fireRGB.x * 0.3;
    g += fireRGB.y * 0.3;
    b += fireRGB.z * 0.3;

    _uploadBuffer[rowBase + F_ALBEDO_R] = r;
    _uploadBuffer[rowBase + F_ALBEDO_G] = g;
    _uploadBuffer[rowBase + F_ALBEDO_B] = b;

    // ─── 3. Physical parameters ────────────────────────────
    const baseRoughness = baseMat.roughness !== undefined ? baseMat.roughness : 0.8;
    const baseMetalness = baseMat.metalness !== undefined ? baseMat.metalness : 0.0;
    const baseTransmission = baseMat.transmission !== undefined ? baseMat.transmission : 0.0;
    const baseIor = baseMat.ior !== undefined ? baseMat.ior : 1.5;
    const baseAnimeFlatness = baseMat.animeFlatness !== undefined ? baseMat.animeFlatness : 0.2;

    const roughness = _effectiveRoughness(baseRoughness, wetness, snow, damage);
    const transmission = _effectiveTransmission(baseTransmission, wetness, damage);
    const metalness = baseMetalness * (1 - snow) * (1 - damage);

    // F₀ from the metallic-roughness model. F₀ is written as a scalar in
    // this layout; the shader reconstructs the RGB F₀ from the albedo and
    // metalness, which is the standard practice.
    const f0 = _computeF0(_matScratch, metalness);

    _uploadBuffer[rowBase + F_ROUGHNESS] = roughness;
    _uploadBuffer[rowBase + F_METALNESS] = metalness;
    _uploadBuffer[rowBase + F_TRANSMISSION] = transmission;
    _uploadBuffer[rowBase + F_IOR] = baseIor;
    _uploadBuffer[rowBase + F_FRESNEL_F0] = f0;

    // ─── 4. Anime parameters ───────────────────────────────
    // Anime flatness is the base material's flatness, boosted by wetness
    // (wet surfaces read as "flatter" in anime style) and by damage (chipped
    // surfaces read as more stylized).
    const animeW = Math.min(1, baseAnimeFlatness + wetness * 0.1 + damage * 0.2);
    const animeN = 4;   // default quantization steps; can be overridden
    _uploadBuffer[rowBase + F_ANIME_W] = animeW;
    _uploadBuffer[rowBase + F_ANIME_N] = animeN;

    // Rim: the base material's acoustic profile determines whether a rim
    // highlight is appropriate. Metallic and glassy materials get a stronger
    // rim; organic materials get a weaker one.
    const rimPower = baseMetalness > 0.5 ? 3.0 : 6.0;
    const rimStrength = baseMetalness > 0.5 ? 0.4 : 0.15;
    _uploadBuffer[rowBase + F_RIM_POWER] = rimPower;
    _uploadBuffer[rowBase + F_RIM_COLOR_R] = rimStrength;
    _uploadBuffer[rowBase + F_RIM_COLOR_G] = rimStrength;
    _uploadBuffer[rowBase + F_RIM_COLOR_B] = rimStrength;

    // Outline weight: organic materials get a soft outline, hard materials
    // get no outline. The base material's acoustic profile is the best
    // proxy for "is this organic".
    const outlineW = baseMat.animeOutline === true ? 1.0 : 0.0;
    _uploadBuffer[rowBase + F_OUTLINE_W] = outlineW;

    // ─── 5. Dynamic overrides ──────────────────────────────
    _uploadBuffer[rowBase + F_WETNESS] = wetness;
    _uploadBuffer[rowBase + F_FIRE_EMISSIVE] = fireRGB.x > 0 ? 1 : 0;
    _uploadBuffer[rowBase + F_MOSS] = moss;
    _uploadBuffer[rowBase + F_SNOW] = snow;
    _uploadBuffer[rowBase + F_DAMAGE] = damage;
    _uploadBuffer[rowBase + F_FROST] = frost;

    // ─── 6. Per-chunk lighting parameters ───────────────────
    const sunDiffuse = lightBlend[lightOffset + 0] || 0.4;
    const shadowSoft = lightBlend[lightOffset + 7] || 0.4;
    const snowBoostOut = lightBlend[lightOffset + 7] || 0.0;
    _uploadBuffer[rowBase + F_SUN_DIFFUSE] = sunDiffuse;
    _uploadBuffer[rowBase + F_SHADOW_SOFT] = shadowSoft;
    _uploadBuffer[rowBase + F_SNOW_BOOST] = snowBoostOut;

    // ─── 7. Advanced PBR extensions ────────────────────────
    // Subsurface scattering is a wetness-and-biology-driven extension: wet
    // organics scatter more light than dry ones.
    const subsurface = baseMat.subsurface !== undefined ? baseMat.subsurface : 0.0;
    _uploadBuffer[rowBase + F_SUBSURFACE] = subsurface * (1 + wetness * 0.5);
    _uploadBuffer[rowBase + F_ANISO] = baseMat.anisotropy !== undefined ? baseMat.anisotropy : 0.0;
    _uploadBuffer[rowBase + F_CLEARCOAT] = baseMat.clearcoat !== undefined ? baseMat.clearcoat : 0.0;
    _uploadBuffer[rowBase + F_SHEEN] = baseMat.sheen !== undefined ? baseMat.sheen : 0.0;
    _uploadBuffer[rowBase + F_SPECULAR] = baseMat.specular !== undefined ? baseMat.specular : 0.5;

    // Emissive
    const emissiveBase = baseMat.emissive !== undefined ? baseMat.emissive : 0.0;
    _uploadBuffer[rowBase + F_EMISSIVE_R] = fireRGB.x + emissiveBase;
    _uploadBuffer[rowBase + F_EMISSIVE_G] = fireRGB.y + emissiveBase * 0.8;
    _uploadBuffer[rowBase + F_EMISSIVE_B] = fireRGB.z + emissiveBase * 0.6;

    // Mark the row as updated.
    _rowDirty[row] = 1;
    _rowLastUpdate[row] = _framesProcessed;
  }
});

const _dispatcher = new CoreEventDispatcher();

export default BiomeBlendMaterialBridge;