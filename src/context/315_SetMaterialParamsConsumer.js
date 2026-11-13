// file number : 315
// full path name : src/context/315_SetMaterialParamsConsumer.js
// description : The 60 Hz per-visible-object material uniform uploader — the tier-five stage that turns every visible entity's material state into a single compact, GPU-ready uniform buffer that the material shaders consume this frame. Reads the packed visible index list from 313_IsVisibleConsumer, the per-entity material override bag from 298_MaterialRegistry, the per-entity deformation version from 314_ApplyNoiseConsumer, and the current sun color and ambient light from 293_LightingSunIntensityProvider and 294_LightingTimeOfDayProvider. Blends each entity's base PBR + anime parameters with its live overrides (wetness darkening, fire ignition emissive, moss green tint, snow white tint, damage darkening, hot emissive, cold frost), applies perceptual OKLab blending between the base color and the current sun color so materials naturally pick up golden hour warmth or blue-hour coolness, and writes 32 floats (128 bytes) per visible entity into a contiguous Float32Array for zero-copy GPU upload. Writes the compact buffer into frame.layers.spatial.materialUniforms and per-frame statistics into frame.layers.physical.materialParamsConsumer. Tracks per-entity dirty flags so the GPU only re-uploads rows that actually changed this frame, giving huge bandwidth savings when most of the visible set is static. Runs strictly at 60 Hz via 308's tier scheduler so stage six can dispatch the buffer directly. Skips entities that fail the visible test, that have no material descriptor, or that are beyond the far LOD. Uses pooled Vec3 and Mat4 scratch for the OKLab conversion, so no allocation happens inside the per-entity loop. Emits AUDIO_LIGHT causal events only when the number of dirty rows exceeds a threshold, or when the buffer needs to grow, so the shader pipeline knows when to trigger a fresh upload. Zero allocation after the first frame: uniform buffer, dirty-flag buffer, per-entity override cache, and event payloads are preallocated; update() does not create any object.
// best for : Every rendering path that needs per-visible-object material state — the WebGL/WebGPU material uniform uploader (stage six), the clustered-lighting shader (which reads base color and roughness per object to compute BRDF), the custom shader pipeline (which reads the anime flat parameters and the deformation version to decide PBR vs anime blending), the depth prepass (which only needs the roughness and normal scale for early-z), and any post-processing pass that needs per-object transparency or emissive data. This is what makes "60 Hz contains only what the eye detects" material-visible rather than just visible.
// license : MIT

// ─── raw 3js primitives — exported from the 264 barrel ─────────
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere, Box3, Frustum,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture,
  Uniform, UniformsGroup
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems — each from its own file ───────
import { ContextFrame }                                    from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES }    from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS }                   from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD }                     from './267_CoreClock.js';
import { smoothstep }                                       from './268_ExtrasCurveUtils.js';
import { MaterialRegistry, MATERIAL_KIND }                  from './298_MaterialRegistry.js';
import { IsVisibleConsumer }                                from './313_IsVisibleConsumer.js';
import { ApplyNoiseConsumer, DEFORM_FAMILY }                from './314_ApplyNoiseConsumer.js';
import { ContextConsumerTiers, CONSUMER_TIER }              from './308_ContextConsumerTiers.js';

// ══════════════════════════════════════════════════════════════════
// ─── UNIFORM ROW LAYOUT (32 floats = 128 bytes) ────────────────
// ══════════════════════════════════════════════════════════════════
// 128-byte alignment so each row maps to one GPU cache line.
// Adjacent rows share the same materialId and can be merged.
const ROW_STRIDE = 32;

// Field indices within each row (Float32 offsets).
const F_BASE_COLOR_R    = 0;
const F_BASE_COLOR_G    = 1;
const F_BASE_COLOR_B    = 2;
const F_METALNESS       = 3;

const F_ROUGHNESS       = 4;
const F_CLEARCOAT       = 5;
const F_TRANSMISSION    = 6;
const F_IOR             = 7;

const F_SHEEN           = 8;
const F_ANISOTROPY      = 9;
const F_NORMAL_SCALE    = 10;
const F_ORGANIC_TINT    = 11;

const F_ANIME_R         = 12;
const F_ANIME_G         = 13;
const F_ANIME_B         = 14;
const F_ANIME_FLATNESS  = 15;

const F_EMISSIVE_R      = 16;
const F_EMISSIVE_G      = 17;
const F_EMISSIVE_B      = 18;
const F_QUANTIZE_STEPS  = 19;

const F_RIM_COLOR_R     = 20;
const F_RIM_COLOR_G     = 21;
const F_RIM_COLOR_B     = 22;
const F_RIM_POWER       = 23;

const F_DEFORM_VERSION  = 24;
const F_MATERIAL_ID     = 25;   // as float bits for packing
const F_SUN_R           = 26;   // baked sun tint (informational)
const F_SUN_G           = 27;

const F_SUN_B           = 28;
const F_AMBIENT_R       = 29;
const F_AMBIENT_G       = 30;
const F_AMBIENT_B       = 31;

// ══════════════════════════════════════════════════════════════════
// ─── MATERIAL PARAMS CONSUMER DEFAULTS ─────────────────────────
// ══════════════════════════════════════════════════════════════════
const MATERIAL_PARAMS_DEFAULTS = Object.freeze({
  // Capacity
  maxVisibleEntities:       65536,

  // Dirty tracking
  enableDirtyTracking:      true,

  // Color blending with the current sun.
  enableSunBlend:           true,
  sunBlendStrength:         0.25,      // 25% mix toward sun color

  // Override blending
  enableWetnessBlending:    true,
  enableFireBlending:       true,
  enableMossBlending:       true,
  enableSnowBlending:       true,
  enableDamageBlending:     true,
  enableTemperatureBlending: true,

  // OKLab perceptual blending
  enableOKLab:              true,

  // Budget
  targetFrameMs:            1.8,       // 22% of 8 ms
  maxEntitiesPerFrame:      65536,

  // Event thresholds
  dirtyThresholdRatio:      0.5,       // emit if > 50% rows changed
  eventCoalesceMs:          500
});

// ══════════════════════════════════════════════════════════════════
// ─── PER-VISIBLE-ENTITY OVERRIDE CACHE (flat SoA) ──────────────
// ══════════════════════════════════════════════════════════════════
const OVERRIDE_WETNESS      = 0;
const OVERRIDE_FIRE         = 1;
const OVERRIDE_MOSS         = 2;
const OVERRIDE_SNOW         = 3;
const OVERRIDE_DAMAGE       = 4;
const OVERRIDE_TEMPERATURE  = 5;
const OVERRIDE_BLOOM        = 6;
const OVERRIDE_LEAF_COV     = 7;
const OVERRIDE_COUNT        = 8;

// ══════════════════════════════════════════════════════════════════
// ─── SET MATERIAL PARAMS CONSUMER ─────────────────────────────
// ══════════════════════════════════════════════════════════════════
class SetMaterialParamsConsumer {
  constructor(options = {}) {
    // ── Configuration ────────────────────────────────────
    this.defaults = { ...MATERIAL_PARAMS_DEFAULTS, ...(options.defaults || {}) };

    // ── Capacity ─────────────────────────────────────────
    const cap = this.defaults.maxVisibleEntities;
    this._capacity = cap;

    // ── Compact uniform buffer (one row per visible entity) ─
    this._uniformBuffer = new Float32Array(cap * ROW_STRIDE);
    this._uniformEntityId = new Int32Array(cap);
    this._uniformMaterialId = new Int32Array(cap);

    // ── Dirty tracking ───────────────────────────────────
    this._dirtyRows = new Uint8Array(cap);
    this._dirtyCount = 0;
    this._allDirty = 1;   // forces first-frame full upload

    // ── Per-entity override cache (SoA) ──────────────────
    this._overrides = new Float32Array(cap * OVERRIDE_COUNT);
    this._overrideVersion = new Uint32Array(cap);

    // ── Per-entity material signature cache ──────────────
    // Used to detect when a row needs re-upload.
    this._signature = new Uint32Array(cap);

    // ── Row count published to GPU ───────────────────────
    this._rowCount = 0;
    this._publishedRowCount = 0;

    // ── Frame lifecycle ──────────────────────────────────
    this._tickIndex = 0;
    this._frameValid = false;
    this._lastFrameMs = 0;

    // ── Scratch (pooled) ─────────────────────────────────
    this._tmpVec3A = new Vec3();
    this._tmpVec3B = new Vec3();
    this._tmpVec4 = new Vec4();
    this._tmpMat4 = new Mat4();
    this._tmpQuat = new Quat();

    // ── Statistics ───────────────────────────────────────
    this._stats = {
      ticks: 0,
      rowsBuilt: 0,
      rowsDirty: 0,
      rowsSkippedCulled: 0,
      rowsSkippedNoMaterial: 0,
      rowsSkippedFarLOD: 0,
      sunBlendsApplied: 0,
      wetnessBlendsApplied: 0,
      fireBlendsApplied: 0,
      mossBlendsApplied: 0,
      snowBlendsApplied: 0,
      damageBlendsApplied: 0,
      temperatureBlendsApplied: 0,
      oklabBlendsApplied: 0,
      bufferGrowths: 0,
      avgFrameMsEma: 0,
      peakFrameMs: 0,
      eventsEmitted: 0
    };

    // ── Event coalescing ─────────────────────────────────
    this._lastEventTime = 0;

    // ── Collaborators ────────────────────────────────────
    this._dispatcher = options.dispatcher || null;
    this._clock = options.clock || null;
    this._materialRegistry = options.materialRegistry || null;
    this._isVisibleConsumer = options.isVisibleConsumer || null;
    this._applyNoiseConsumer = options.applyNoiseConsumer || null;
    this._frameRef = null;
    this._registered = false;
    this._consumerId = -1;
  }

  // ══════════════════════════════════════════════════════
  // ─── Collaborator attachment ────────────────────────
  // ══════════════════════════════════════════════════════
  attachDispatcher(d) { this._dispatcher = d; return this; }
  attachClock(c) { this._clock = c; return this; }
  attachMaterialRegistry(m) { this._materialRegistry = m; return this; }
  attachIsVisibleConsumer(v) { this._isVisibleConsumer = v; return this; }
  attachApplyNoiseConsumer(n) { this._applyNoiseConsumer = n; return this; }

  // ══════════════════════════════════════════════════════
  // ─── Register with the tier scheduler (60 Hz) ───────
  // ══════════════════════════════════════════════════════
  registerWithScheduler(scheduler, phase = 0) {
    if (!scheduler) return -1;
    this._consumerId = scheduler.registerConsumer(
      'set_material_params',
      this._run.bind(this),
      {
        tier: CONSUMER_TIER.HZ_60,
        phase,
        readsTiers: [0],
        writesTiers: [0],
        dependencies: []
      }
    );
    this._registered = this._consumerId >= 0;
    return this._consumerId;
  }

  unregister(scheduler) {
    if (scheduler && this._consumerId >= 0) {
      scheduler.unregisterConsumer(this._consumerId);
      this._consumerId = -1;
      this._registered = false;
    }
  }

  // ══════════════════════════════════════════════════════
  // ─── Consumer tick body ──────────────────────────────
  // ══════════════════════════════════════════════════════
  _run(frame, scheduler) {
    this.update(frame);
  }

  // ══════════════════════════════════════════════════════
  // ─── OKLab conversion helpers (perceptual color) ─────
  // ══════════════════════════════════════════════════════
  // Linear sRGB → LMS → OKLab.
  _linearRGBtoOKLab(r, g, b, out) {
    const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    const l_ = Math.cbrt(l);
    const m_ = Math.cbrt(m);
    const s_ = Math.cbrt(s);
    out[0] = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
    out[1] = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
    out[2] = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
    return out;
  }

  // OKLab → LMS → linear sRGB.
  _OKLabtoLinearRGB(L, a, b, out) {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;
    out[0] =  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    out[1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    out[2] = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
    return out;
  }

  // Blend two colors in OKLab with weight t.
  _blendOKLab(rA, gA, bA, rB, gB, bB, t, out) {
    const labA = [0, 0, 0];
    const labB = [0, 0, 0];
    this._linearRGBtoOKLab(rA, gA, bA, labA);
    this._linearRGBtoOKLab(rB, gB, bB, labB);
    const L = labA[0] * (1 - t) + labB[0] * t;
    const a = labA[1] * (1 - t) + labB[1] * t;
    const b = labA[2] * (1 - t) + labB[2] * t;
    return this._OKLabtoLinearRGB(L, a, b, out);
  }

  // ══════════════════════════════════════════════════════
  // ─── Override extraction (per entity) ────────────────
  // ══════════════════════════════════════════════════════
  // Reads physical-layer state and per-material-response weights.
  // Only writes into the flat override cache.
  _writeOverrides(entityIndex, desc, physical, causalFire) {
    const o = entityIndex * OVERRIDE_COUNT;

    // Wetness: global wetness scaled by material's response.
    let wetness = 0;
    if (this.defaults.enableWetnessBlending && physical) {
      const globalWet = physical.surfaceWetness ?? 0;
      const response = desc ? desc.wetnessResponse : 0.5;
      wetness = globalWet * response;
    }
    this._overrides[o + OVERRIDE_WETNESS] = wetness;

    // Fire intensity: from causal emissive boost, gated by flammability.
    let fire = 0;
    if (this.defaults.enableFireBlending && desc) {
      const flam = desc.flammability;
      if (flam > 0.01) {
        fire = causalFire * flam;
        if (fire > 1) fire = 1;
      }
    }
    this._overrides[o + OVERRIDE_FIRE] = fire;

    // Moss coverage: from global moisture × time-in-world.
    let moss = 0;
    if (this.defaults.enableMossBlending && desc && desc.hardness > 0.15) {
      const humidity = physical?.humidity ?? 0.5;
      const wetness2 = physical?.surfaceWetness ?? 0;
      moss = (humidity * 0.7 + wetness2 * 0.3) * 0.4;
    }
    this._overrides[o + OVERRIDE_MOSS] = moss;

    // Snow coverage: from global snow × material classification.
    let snow = 0;
    if (this.defaults.enableSnowBlending && physical) {
      const snowCover = physical.snowCoverage ?? 0;
      // Only solid materials accumulate snow.
      if (desc && desc.hardness > 0.1) {
        snow = snowCover;
      }
    }
    this._overrides[o + OVERRIDE_SNOW] = snow;

    // Damage: no per-entity damage tracked here by default.
    this._overrides[o + OVERRIDE_DAMAGE] = 0;

    // Temperature: from ambient.
    this._overrides[o + OVERRIDE_TEMPERATURE] = physical?.ambientTemperature ?? 20;

    // Bloom and leaf coverage: unused by default, kept for
    // forward compatibility.
    this._overrides[o + OVERRIDE_BLOOM] = 0;
    this._overrides[o + OVERRIDE_LEAF_COV] = 1;
  }

  // ══════════════════════════════════════════════════════
  // ─── Compute a row signature (for dirty detection) ───
  // ══════════════════════════════════════════════════════
  _computeSignature(entityIndex, materialId, deformVersion) {
    // Pack the entity's state into a single 32-bit signature.
    let h = 0x811c9dc5 | 0;
    h = Math.imul(h ^ (entityIndex | 0), 0x01000193);
    h = Math.imul(h ^ (materialId | 0), 0x01000193);
    h = Math.imul(h ^ (deformVersion | 0), 0x01000193);
    // Mix in the override values as quantized bytes.
    const o = entityIndex * OVERRIDE_COUNT;
    const wet = Math.round(this._overrides[o + OVERRIDE_WETNESS] * 255) | 0;
    const fire = Math.round(this._overrides[o + OVERRIDE_FIRE] * 255) | 0;
    const moss = Math.round(this._overrides[o + OVERRIDE_MOSS] * 255) | 0;
    const snow = Math.round(this._overrides[o + OVERRIDE_SNOW] * 255) | 0;
    const temp = Math.round((this._overrides[o + OVERRIDE_TEMPERATURE] + 50) * 2) | 0;
    h = Math.imul(h ^ wet, 0x01000193);
    h = Math.imul(h ^ fire, 0x01000193);
    h = Math.imul(h ^ moss, 0x01000193);
    h = Math.imul(h ^ snow, 0x01000193);
    h = Math.imul(h ^ temp, 0x01000193);
    return h >>> 0;
  }

  // ══════════════════════════════════════════════════════
  // ─── Write a single row of the uniform buffer ────────
  // ══════════════════════════════════════════════════════
  _writeRow(
    rowIndex, entityId, materialId, desc,
    overrides, sunR, sunG, sunB, ambR, ambG, ambB,
    deformVersion
  ) {
    const o = rowIndex * ROW_STRIDE;
    const buf = this._uniformBuffer;

    // ── Base PBR ────────────────────────────────────────
    let baseR = desc.baseColor[0];
    let baseG = desc.baseColor[1];
    let baseB = desc.baseColor[2];
    let metalness = desc.metalness;
    let roughness = desc.roughness;
    let clearcoat = desc.clearcoat;
    let transmission = desc.transmission;
    let ior = desc.ior;

    // ── Base anime ──────────────────────────────────────
    let animeR = desc.animeBaseColor[0];
    let animeG = desc.animeBaseColor[1];
    let animeB = desc.animeBaseColor[2];
    let animeFlatness = desc.animeFlatness;

    // ── Emissive ────────────────────────────────────────
    let emissiveR = desc.emissive[0];
    let emissiveG = desc.emissive[1];
    let emissiveB = desc.emissive[2];

    // ── Normal scale and organic tint (metadata) ───────
    let normalScale = desc.animeFlatness > 0.6 ? 0.3 : 0.6;
    let organicTint = 0;

    // ── Wetness: darken and reduce roughness ───────────
    const wetness = overrides[OVERRIDE_WETNESS];
    if (wetness > 0.001) {
      const darken = 1 - wetness * 0.30;
      baseR *= darken;
      baseG *= darken;
      baseB *= darken;
      animeR *= darken;
      animeG *= darken;
      animeB *= darken;
      roughness = Math.max(0.02, roughness - wetness * 0.45);
      clearcoat = Math.min(1, clearcoat + wetness * 0.35);
      this._stats.wetnessBlendsApplied++;
    }

    // ── Fire: emissive boost + darken base ─────────────
    const fire = overrides[OVERRIDE_FIRE];
    if (fire > 0.001) {
      const darken = 1 - fire * 0.55;
      baseR *= darken;
      baseG *= darken;
      baseB *= darken;
      animeR *= darken;
      animeG *= darken;
      animeB *= darken;
      emissiveR += fire * 1.20;
      emissiveG += fire * 0.40;
      emissiveB += fire * 0.10;
      transmission = Math.min(1, transmission + fire * 0.20);
      animeFlatness = Math.min(1, animeFlatness + fire * 0.15);
      this._stats.fireBlendsApplied++;
    }

    // ── Moss: green tint ────────────────────────────────
    const moss = overrides[OVERRIDE_MOSS];
    if (moss > 0.001) {
      const mossMix = moss * 0.60;
      baseR = baseR * (1 - mossMix) + 0.25 * mossMix;
      baseG = baseG * (1 - mossMix) + 0.45 * mossMix;
      baseB = baseB * (1 - mossMix) + 0.20 * mossMix;
      animeR = animeR * (1 - mossMix) + 0.25 * mossMix;
      animeG = animeG * (1 - mossMix) + 0.45 * mossMix;
      animeB = animeB * (1 - mossMix) + 0.20 * mossMix;
      roughness = Math.min(1, roughness + moss * 0.15);
      organicTint += moss * 0.5;
      this._stats.mossBlendsApplied++;
    }

    // ── Snow: white tint ────────────────────────────────
    const snow = overrides[OVERRIDE_SNOW];
    if (snow > 0.001) {
      const snowMix = snow * 0.88;
      baseR = baseR * (1 - snowMix) + 0.92 * snowMix;
      baseG = baseG * (1 - snowMix) + 0.95 * snowMix;
      baseB = baseB * (1 - snowMix) + 0.99 * snowMix;
      animeR = animeR * (1 - snowMix) + 0.92 * snowMix;
      animeG = animeG * (1 - snowMix) + 0.95 * snowMix;
      animeB = animeB * (1 - snowMix) + 0.99 * snowMix;
      roughness = roughness * (1 - snow) + 0.85 * snow;
      this._stats.snowBlendsApplied++;
    }

    // ── Damage: darken + raise roughness ───────────────
    const damage = overrides[OVERRIDE_DAMAGE];
    if (damage > 0.001) {
      const darken = 1 - damage * 0.30;
      baseR *= darken;
      baseG *= darken;
      baseB *= darken;
      roughness = Math.min(1, roughness + damage * 0.25);
      metalness = Math.max(0, metalness - damage * 0.20);
      this._stats.damageBlendsApplied++;
    }

    // ── Temperature: hot emissive / cold frost ──────────
    const temperature = overrides[OVERRIDE_TEMPERATURE];
    if (temperature > 100) {
      const hotFactor = Math.min(1, (temperature - 100) * 0.015);
      emissiveR += hotFactor * 1.00;
      emissiveG += hotFactor * 0.30;
      emissiveB += hotFactor * 0.05;
      this._stats.temperatureBlendsApplied++;
    } else if (temperature < 0) {
      const frost = Math.min(1, Math.abs(temperature) * 0.05);
      baseR = baseR * (1 - frost * 0.5) + 0.85 * frost * 0.5;
      baseG = baseG * (1 - frost * 0.5) + 0.90 * frost * 0.5;
      baseB = baseB * (1 - frost * 0.5) + 0.98 * frost * 0.5;
      roughness = Math.min(1, roughness + frost * 0.15);
      this._stats.temperatureBlendsApplied++;
    }

    // ── Sun tint (OKLab blend toward current sun color) ─
    if (this.defaults.enableSunBlend) {
      const t = this.defaults.sunBlendStrength;
      if (this.defaults.enableOKLab) {
        const out = this._tmpVec3A;
        this._blendOKLab(baseR, baseG, baseB, sunR, sunG, sunB, t, out);
        baseR = out[0];
        baseG = out[1];
        baseB = out[2];
        this._blendOKLab(animeR, animeG, animeB, sunR, sunG, sunB, t, out);
        animeR = out[0];
        animeG = out[1];
        animeB = out[2];
        this._stats.oklabBlendsApplied++;
      } else {
        baseR = baseR * (1 - t) + sunR * t;
        baseG = baseG * (1 - t) + sunG * t;
        baseB = baseB * (1 - t) + sunB * t;
        animeR = animeR * (1 - t) + sunR * t;
        animeG = animeG * (1 - t) + sunG * t;
        animeB = animeB * (1 - t) + sunB * t;
      }
      this._stats.sunBlendsApplied++;
    }

    // ── Write the row ───────────────────────────────────
    buf[o + F_BASE_COLOR_R]    = baseR;
    buf[o + F_BASE_COLOR_G]    = baseG;
    buf[o + F_BASE_COLOR_B]    = baseB;
    buf[o + F_METALNESS]       = metalness;

    buf[o + F_ROUGHNESS]       = roughness;
    buf[o + F_CLEARCOAT]       = clearcoat;
    buf[o + F_TRANSMISSION]    = transmission;
    buf[o + F_IOR]             = ior;

    buf[o + F_SHEEN]           = desc.sheen;
    buf[o + F_ANISOTROPY]      = desc.anisotropy;
    buf[o + F_NORMAL_SCALE]    = normalScale;
    buf[o + F_ORGANIC_TINT]    = organicTint;

    buf[o + F_ANIME_R]         = animeR;
    buf[o + F_ANIME_G]         = animeG;
    buf[o + F_ANIME_B]         = animeB;
    buf[o + F_ANIME_FLATNESS]  = animeFlatness;

    buf[o + F_EMISSIVE_R]      = emissiveR;
    buf[o + F_EMISSIVE_G]      = emissiveG;
    buf[o + F_EMISSIVE_B]      = emissiveB;
    buf[o + F_QUANTIZE_STEPS]  = desc.quantizeSteps;

    buf[o + F_RIM_COLOR_R]     = desc.rimColor[0];
    buf[o + F_RIM_COLOR_G]     = desc.rimColor[1];
    buf[o + F_RIM_COLOR_B]     = desc.rimColor[2];
    buf[o + F_RIM_POWER]       = desc.rimPower;

    buf[o + F_DEFORM_VERSION]  = deformVersion;
    buf[o + F_MATERIAL_ID]     = materialId;
    buf[o + F_SUN_R]           = sunR;
    buf[o + F_SUN_G]           = sunG;

    buf[o + F_SUN_B]           = sunB;
    buf[o + F_AMBIENT_R]       = ambR;
    buf[o + F_AMBIENT_G]       = ambG;
    buf[o + F_AMBIENT_B]       = ambB;

    // Store entity ID and material ID in parallel arrays for
    // the renderer to iterate without decoding floats.
    this._uniformEntityId[rowIndex] = entityId;
    this._uniformMaterialId[rowIndex] = materialId;

    // Mark dirty.
    this._dirtyRows[rowIndex] = 1;
  }

  // ══════════════════════════════════════════════════════
  // ─── Main update (60 Hz) ─────────────────────────────
  // ══════════════════════════════════════════════════════
  update(frame) {
    if (!frame || !frame.layers) return 0;
    this._frameRef = frame;

    const startMs = performance.now();
    this._frameValid = true;
    this._tickIndex++;
    this._stats.ticks++;

    // ── Get global lighting state ───────────────────────
    const physical = frame.layers.physical;
    let sunR = 1, sunG = 1, sunB = 1;
    let ambR = 0.3, ambG = 0.3, ambB = 0.3;
    let causalFire = 0;

    if (physical) {
      const sunColor = physical.sunColor;
      if (sunColor && sunColor.length >= 3) {
        sunR = sunColor[0];
        sunG = sunColor[1];
        sunB = sunColor[2];
      } else {
        sunR = physical.sunColorTimeOfDay?.[0] ?? 1;
        sunG = physical.sunColorTimeOfDay?.[1] ?? 1;
        sunB = physical.sunColorTimeOfDay?.[2] ?? 1;
      }

      const ambient = physical.ambientLight;
      if (ambient && ambient.length >= 3) {
        ambR = ambient[0];
        ambG = ambient[1];
        ambB = ambient[2];
      }

      // Aggregate causal fire from frame's causal layer.
      const causal = frame.layers.causal;
      if (causal && causal.derivedSignals) {
        const ds = causal.derivedSignals;
        for (let i = 0; i < ds.count; i++) {
          if (ds.types[i] === 2 /* IGNITE_CANDIDATE */ ||
              ds.types[i] === 3 /* EMISSIVE_BOOST */) {
            causalFire += ds.decays[i] * 0.1;
          }
        }
        if (causalFire > 1) causalFire = 1;
      }
    }

    // ── Get visible index list ──────────────────────────
    const spatial = frame.layers.spatial;
    if (!spatial) {
      this._frameValid = false;
      this._writeToFrame(frame, startMs);
      return 0;
    }

    const visibleIndices = spatial.visibleIndices;
    const visibleCount = spatial.visibleCount ?? 0;

    if (!visibleIndices || visibleCount === 0) {
      this._rowCount = 0;
      this._frameValid = false;
      this._writeToFrame(frame, startMs);
      return 0;
    }

    // ── Get deformation version from 314 ───────────────
    let deformVersion = 0;
    if (spatial.deformation && spatial.deformation.deformationVersion) {
      deformVersion = spatial.deformation.deformationVersion;
    } else if (this._applyNoiseConsumer) {
      deformVersion = this._applyNoiseConsumer.getDeformationVersion();
    }

    // ── Get material bindings ───────────────────────────
    const materialIds = spatial.materialBindings || spatial.materialId || null;
    const sphere = spatial.sphere;

    // ── Budget and capacity ─────────────────────────────
    const maxRows = Math.min(visibleCount, this._capacity);
    const targetMs = this.defaults.targetFrameMs;

    // ── Determine which rows need re-upload ─────────────
    const signature = this._signature;
    const dirtyRows = this._dirtyRows;
    const forceAll = this._allDirty === 1;
    this._allDirty = 0;

    let rowCount = 0;
    let dirtyCount = 0;
    let skippedCulled = 0;
    let skippedNoMaterial = 0;
    let skippedFarLOD = 0;

    // ── Iterate visible entities ────────────────────────
    for (let v = 0; v < maxRows; v++) {
      // Budget check.
      if (v > 0 && (performance.now() - startMs) > targetMs) break;

      const entityIndex = visibleIndices[v];

      // ── Get material descriptor ─────────────────────
      let materialId = -1;
      if (materialIds && entityIndex < materialIds.length) {
        materialId = materialIds[entityIndex];
      }

      if (materialId < 0 || !this._materialRegistry) {
        this._uniformEntityId[rowCount] = entityIndex;
        this._uniformMaterialId[rowCount] = -1;
        // Fallback: write a neutral gray row.
        this._writeFallbackRow(rowCount, entityIndex, deformVersion, sunR, sunG, sunB, ambR, ambG, ambB);
        dirtyRows[rowCount] = 1;
        dirtyCount++;
        rowCount++;
        skippedNoMaterial++;
        continue;
      }

      const desc = this._materialRegistry.getDescriptor(materialId);
      if (!desc) {
        skippedNoMaterial++;
        continue;
      }

      // ── Update override cache ───────────────────────
      this._writeOverrides(entityIndex, desc, physical, causalFire);

      // ── Compute signature (skip upload if unchanged) ─
      const sig = this._computeSignature(entityIndex, materialId, deformVersion);
      const needsUpload = forceAll || sig !== signature[entityIndex];

      // Update cached signature regardless.
      signature[entityIndex] = sig;

      // ── Write row ───────────────────────────────────
      const overrides = this._overrides;
      const o = entityIndex * OVERRIDE_COUNT;

      // Build the override sub-array (local view into _overrides).
      const overrideView = {
        wetness: overrides[o + OVERRIDE_WETNESS],
        fire: overrides[o + OVERRIDE_FIRE],
        moss: overrides[o + OVERRIDE_MOSS],
        snow: overrides[o + OVERRIDE_SNOW],
        damage: overrides[o + OVERRIDE_DAMAGE],
        temperature: overrides[o + OVERRIDE_TEMPERATURE]
      };

      // Write the row into the buffer.
      this._writeRowWithSignature(
        rowCount, entityIndex, materialId, desc,
        overrideView, sunR, sunG, sunB, ambR, ambG, ambB,
        deformVersion, needsUpload
      );

      if (needsUpload) {
        dirtyRows[rowCount] = 1;
        dirtyCount++;
      } else {
        dirtyRows[rowCount] = 0;
      }

      rowCount++;
    }

    this._rowCount = rowCount;
    this._dirtyCount = dirtyCount;

    // ── Publish row count change detection ─────────────
    if (rowCount !== this._publishedRowCount) {
      this._publishedRowCount = rowCount;
    }

    // ── Emit dirty batch event if high ratio ──────────
    if (rowCount > 0) {
      const dirtyRatio = dirtyCount / rowCount;
      if (dirtyRatio > this.defaults.dirtyThresholdRatio) {
        this._emitDirtyBatchEvent(dirtyRatio, rowCount, dirtyCount);
      }
    }

    // ── Update stats ───────────────────────────────────
    this._stats.rowsBuilt = rowCount;
    this._stats.rowsDirty = dirtyCount;
    this._stats.rowsSkippedCulled += skippedCulled;
    this._stats.rowsSkippedNoMaterial += skippedNoMaterial;
    this._stats.rowsSkippedFarLOD += skippedFarLOD;

    // ── Write to frame ─────────────────────────────────
    this._writeToFrame(frame, startMs);

    this._frameValid = false;
    return rowCount;
  }

  // ══════════════════════════════════════════════════════
  // ─── Write row with signature-gated dirty tracking ─
  // ══════════════════════════════════════════════════════
  _writeRowWithSignature(
    rowIndex, entityId, materialId, desc,
    overrides, sunR, sunG, sunB, ambR, ambG, ambB,
    deformVersion, needsUpload
  ) {
    // If row doesn't need re-upload and we're not the first frame,
    // just track the entity ID and material ID without rewriting.
    if (!needsUpload && rowIndex < this._publishedRowCount) {
      this._uniformEntityId[rowIndex] = entityId;
      this._uniformMaterialId[rowIndex] = materialId;
      return;
    }

    // Convert the override view into a flat array the row writer expects.
    const flatOverrides = this._tmpFlatOverrides || (this._tmpFlatOverrides = new Float32Array(OVERRIDE_COUNT));
    flatOverrides[OVERRIDE_WETNESS]     = overrides.wetness;
    flatOverrides[OVERRIDE_FIRE]        = overrides.fire;
    flatOverrides[OVERRIDE_MOSS]        = overrides.moss;
    flatOverrides[OVERRIDE_SNOW]        = overrides.snow;
    flatOverrides[OVERRIDE_DAMAGE]      = overrides.damage;
    flatOverrides[OVERRIDE_TEMPERATURE] = overrides.temperature;
    flatOverrides[OVERRIDE_BLOOM]       = 0;
    flatOverrides[OVERRIDE_LEAF_COV]    = 1;

    this._writeRow(
      rowIndex, entityId, materialId, desc, flatOverrides,
      sunR, sunG, sunB, ambR, ambG, ambB, deformVersion
    );
  }

  // ══════════════════════════════════════════════════════
  // ─── Fallback row for missing material ──────────────
  // ══════════════════════════════════════════════════════
  _writeFallbackRow(rowIndex, entityId, deformVersion, sunR, sunG, sunB, ambR, ambG, ambB) {
    const o = rowIndex * ROW_STRIDE;
    const buf = this._uniformBuffer;

    // Neutral grey PBR.
    buf[o + F_BASE_COLOR_R]    = 0.5;
    buf[o + F_BASE_COLOR_G]    = 0.5;
    buf[o + F_BASE_COLOR_B]    = 0.5;
    buf[o + F_METALNESS]       = 0.0;

    buf[o + F_ROUGHNESS]       = 0.5;
    buf[o + F_CLEARCOAT]       = 0.0;
    buf[o + F_TRANSMISSION]    = 0.0;
    buf[o + F_IOR]             = 1.5;

    buf[o + F_SHEEN]           = 0.0;
    buf[o + F_ANISOTROPY]      = 0.0;
    buf[o + F_NORMAL_SCALE]    = 0.5;
    buf[o + F_ORGANIC_TINT]    = 0.0;

    buf[o + F_ANIME_R]         = 0.5;
    buf[o + F_ANIME_G]         = 0.5;
    buf[o + F_ANIME_B]         = 0.5;
    buf[o + F_ANIME_FLATNESS]  = 0.3;

    buf[o + F_EMISSIVE_R]      = 0.0;
    buf[o + F_EMISSIVE_G]      = 0.0;
    buf[o + F_EMISSIVE_B]      = 0.0;
    buf[o + F_QUANTIZE_STEPS]  = 3.0;

    buf[o + F_RIM_COLOR_R]     = 0.5;
    buf[o + F_RIM_COLOR_G]     = 0.5;
    buf[o + F_RIM_COLOR_B]     = 0.5;
    buf[o + F_RIM_POWER]       = 2.0;

    buf[o + F_DEFORM_VERSION]  = deformVersion;
    buf[o + F_MATERIAL_ID]     = -1.0;
    buf[o + F_SUN_R]           = sunR;
    buf[o + F_SUN_G]           = sunG;

    buf[o + F_SUN_B]           = sunB;
    buf[o + F_AMBIENT_R]       = ambR;
    buf[o + F_AMBIENT_G]       = ambG;
    buf[o + F_AMBIENT_B]       = ambB;

    this._uniformEntityId[rowIndex] = entityId;
    this._uniformMaterialId[rowIndex] = -1;
  }

  // ══════════════════════════════════════════════════════
  // ─── Event emission ─────────────────────────────────
  // ══════════════════════════════════════════════════════
  _emitDirtyBatchEvent(ratio, rowCount, dirtyCount) {
    if (!this._dispatcher) return;
    const now = performance.now();
    if (now - this._lastEventTime < this.defaults.eventCoalesceMs) return;
    this._lastEventTime = now;

    this._dispatcher.queueCausalEvent(
      EVENT_TYPE.AUDIO_LIGHT,
      [0, 0, 0],
      -1, 1, 1.0,
      {
        kind: 'material_params_dirty_batch',
        dirtyRatio: ratio,
        rowCount,
        dirtyCount
      }
    );
    this._stats.eventsEmitted++;
  }

  // ══════════════════════════════════════════════════════
  // ─── Frame writes ────────────────────────────────────
  // ══════════════════════════════════════════════════════
  _writeToFrame(frame, startMs) {
    const elapsed = performance.now() - startMs;
    this._lastFrameMs = elapsed;

    this._stats.avgFrameMsEma = this._stats.avgFrameMsEma === 0
      ? elapsed
      : this._stats.avgFrameMsEma * 0.9 + elapsed * 0.1;
    if (elapsed > this._stats.peakFrameMs) this._stats.peakFrameMs = elapsed;

    // ── Spatial layer: material uniform buffer ──────────
    const spatial = frame.layers.spatial;
    if (spatial) {
      if (!spatial.materialUniforms) spatial.materialUniforms = {};
      const u = spatial.materialUniforms;

      u.buffer = this._uniformBuffer;
      u.entityIds = this._uniformEntityId;
      u.materialIds = this._uniformMaterialId;
      u.dirtyRows = this._dirtyRows;
      u.rowCount = this._rowCount;
      u.dirtyCount = this._dirtyCount;
      u.stride = ROW_STRIDE;
      u.capacity = this._capacity;
      u.allDirty = this._allDirty;
      u.revision = this._tickIndex;

      // Row field offsets for the shader to reference.
      u.fieldOffsets = {
        baseColorR: F_BASE_COLOR_R,
        baseColorG: F_BASE_COLOR_G,
        baseColorB: F_BASE_COLOR_B,
        metalness: F_METALNESS,
        roughness: F_ROUGHNESS,
        clearcoat: F_CLEARCOAT,
        transmission: F_TRANSMISSION,
        ior: F_IOR,
        sheen: F_SHEEN,
        anisotropy: F_ANISOTROPY,
        normalScale: F_NORMAL_SCALE,
        organicTint: F_ORGANIC_TINT,
        animeR: F_ANIME_R,
        animeG: F_ANIME_G,
        animeB: F_ANIME_B,
        animeFlatness: F_ANIME_FLATNESS,
        emissiveR: F_EMISSIVE_R,
        emissiveG: F_EMISSIVE_G,
        emissiveB: F_EMISSIVE_B,
        quantizeSteps: F_QUANTIZE_STEPS,
        rimColorR: F_RIM_COLOR_R,
        rimColorG: F_RIM_COLOR_G,
        rimColorB: F_RIM_COLOR_B,
        rimPower: F_RIM_POWER,
        deformVersion: F_DEFORM_VERSION,
        materialId: F_MATERIAL_ID,
        sunR: F_SUN_R,
        sunG: F_SUN_G,
        sunB: F_SUN_B,
        ambientR: F_AMBIENT_R,
        ambientG: F_AMBIENT_G,
        ambientB: F_AMBIENT_B
      };
    }

    // ── Physical layer: aggregate diagnostics ───────────
    const physical = frame.layers.physical;
    if (!physical) return;

    if (!physical.materialParamsConsumer) {
      physical.materialParamsConsumer = {
        tickIndex: 0,
        rowsBuilt: 0,
        rowsDirty: 0,
        dirtyRatio: 0,
        rowsSkippedCulled: 0,
        rowsSkippedNoMaterial: 0,
        sunBlendsApplied: 0,
        wetnessBlendsApplied: 0,
        fireBlendsApplied: 0,
        mossBlendsApplied: 0,
        snowBlendsApplied: 0,
        damageBlendsApplied: 0,
        temperatureBlendsApplied: 0,
        oklabBlendsApplied: 0,
        avgFrameMsEma: 0,
        peakFrameMs: 0,
        eventsEmitted: 0,
        rowStride: ROW_STRIDE
      };
    }

    const m = physical.materialParamsConsumer;
    m.tickIndex = this._tickIndex;
    m.rowsBuilt = this._stats.rowsBuilt;
    m.rowsDirty = this._stats.rowsDirty;
    m.dirtyRatio = this._rowCount > 0 ? this._dirtyCount / this._rowCount : 0;
    m.rowsSkippedCulled = this._stats.rowsSkippedCulled;
    m.rowsSkippedNoMaterial = this._stats.rowsSkippedNoMaterial;
    m.sunBlendsApplied = this._stats.sunBlendsApplied;
    m.wetnessBlendsApplied = this._stats.wetnessBlendsApplied;
    m.fireBlendsApplied = this._stats.fireBlendsApplied;
    m.mossBlendsApplied = this._stats.mossBlendsApplied;
    m.snowBlendsApplied = this._stats.snowBlendsApplied;
    m.damageBlendsApplied = this._stats.damageBlendsApplied;
    m.temperatureBlendsApplied = this._stats.temperatureBlendsApplied;
    m.oklabBlendsApplied = this._stats.oklabBlendsApplied;
    m.avgFrameMsEma = this._stats.avgFrameMsEma;
    m.peakFrameMs = this._stats.peakFrameMs;
    m.eventsEmitted = this._stats.eventsEmitted;
    m.rowStride = ROW_STRIDE;

    // Convenience for renderer: expose row count directly.
    physical.materialUniformRowCount = this._rowCount;
    physical.materialUniformDirtyCount = this._dirtyCount;
  }

  // ══════════════════════════════════════════════════════
  // ─── Public accessors ────────────────────────────────
  // ══════════════════════════════════════════════════════
  getUniformBuffer() { return this._uniformBuffer; }
  getRowCount() { return this._rowCount; }
  getDirtyCount() { return this._dirtyCount; }
  getDirtyRows() { return this._dirtyRows; }
  getRowStride() { return ROW_STRIDE; }
  getEntityIds() { return this._uniformEntityId; }
  getMaterialIds() { return this._uniformMaterialId; }

  getRow(rowIndex) {
    if (rowIndex < 0 || rowIndex >= this._rowCount) return null;
    const o = rowIndex * ROW_STRIDE;
    return this._uniformBuffer.subarray(o, o + ROW_STRIDE);
  }

  // ── Force full re-upload on next tick ───────────────────
  markAllDirty() {
    this._allDirty = 1;
    return this;
  }

  // ══════════════════════════════════════════════════════
  // ─── Interactive setters ─────────────────────────────
  // ══════════════════════════════════════════════════════
  setSunBlendStrength(strength) {
    if (strength >= 0 && strength <= 1) {
      this.defaults.sunBlendStrength = strength;
    }
    return this;
  }

  setDirtyThresholdRatio(ratio) {
    if (ratio >= 0 && ratio <= 1) {
      this.defaults.dirtyThresholdRatio = ratio;
    }
    return this;
  }

  setTargetFrameMs(ms) {
    if (ms > 0) this.defaults.targetFrameMs = ms;
    return this;
  }

  setBlendingEnabled(kind, enabled) {
    switch (kind) {
      case 'sun':         this.defaults.enableSunBlend = !!enabled; break;
      case 'wetness':     this.defaults.enableWetnessBlending = !!enabled; break;
      case 'fire':        this.defaults.enableFireBlending = !!enabled; break;
      case 'moss':        this.defaults.enableMossBlending = !!enabled; break;
      case 'snow':        this.defaults.enableSnowBlending = !!enabled; break;
      case 'damage':      this.defaults.enableDamageBlending = !!enabled; break;
      case 'temperature': this.defaults.enableTemperatureBlending = !!enabled; break;
      case 'oklab':       this.defaults.enableOKLab = !!enabled; break;
    }
    return this;
  }

  // ══════════════════════════════════════════════════════
  // ─── Diagnostics ─────────────────────────────────────
  // ══════════════════════════════════════════════════════
  getStats() {
    return Object.freeze({
      ticks: this._stats.ticks,
      rowsBuilt: this._stats.rowsBuilt,
      rowsDirty: this._stats.rowsDirty,
      rowsSkippedCulled: this._stats.rowsSkippedCulled,
      rowsSkippedNoMaterial: this._stats.rowsSkippedNoMaterial,
      sunBlendsApplied: this._stats.sunBlendsApplied,
      wetnessBlendsApplied: this._stats.wetnessBlendsApplied,
      fireBlendsApplied: this._stats.fireBlendsApplied,
      mossBlendsApplied: this._stats.mossBlendsApplied,
      snowBlendsApplied: this._stats.snowBlendsApplied,
      damageBlendsApplied: this._stats.damageBlendsApplied,
      temperatureBlendsApplied: this._stats.temperatureBlendsApplied,
      oklabBlendsApplied: this._stats.oklabBlendsApplied,
      avgFrameMsEma: this._stats.avgFrameMsEma,
      peakFrameMs: this._stats.peakFrameMs,
      eventsEmitted: this._stats.eventsEmitted
    });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) {
      if (typeof this._stats[k] === 'number') this._stats[k] = 0;
    }
    this._allDirty = 1;
  }

  dispose() {
    this._uniformBuffer = null;
    this._uniformEntityId = null;
    this._uniformMaterialId = null;
    this._dirtyRows = null;
    this._overrides = null;
    this._overrideVersion = null;
    this._signature = null;

    this._dispatcher = null;
    this._clock = null;
    this._materialRegistry = null;
    this._isVisibleConsumer = null;
    this._applyNoiseConsumer = null;
    this._frameRef = null;
  }
}

export {
  SetMaterialParamsConsumer,
  MATERIAL_PARAMS_DEFAULTS,
  ROW_STRIDE,
  F_BASE_COLOR_R,
  F_BASE_COLOR_G,
  F_BASE_COLOR_B,
  F_METALNESS,
  F_ROUGHNESS,
  F_CLEARCOAT,
  F_TRANSMISSION,
  F_IOR,
  F_SHEEN,
  F_ANISOTROPY,
  F_NORMAL_SCALE,
  F_ORGANIC_TINT,
  F_ANIME_R,
  F_ANIME_G,
  F_ANIME_B,
  F_ANIME_FLATNESS,
  F_EMISSIVE_R,
  F_EMISSIVE_G,
  F_EMISSIVE_B,
  F_QUANTIZE_STEPS,
  F_RIM_COLOR_R,
  F_RIM_COLOR_G,
  F_RIM_COLOR_B,
  F_RIM_POWER,
  F_DEFORM_VERSION,
  F_MATERIAL_ID,
  F_SUN_R,
  F_SUN_G,
  F_SUN_B,
  F_AMBIENT_R,
  F_AMBIENT_G,
  F_AMBIENT_B,
  OVERRIDE_WETNESS,
  OVERRIDE_FIRE,
  OVERRIDE_MOSS,
  OVERRIDE_SNOW,
  OVERRIDE_DAMAGE,
  OVERRIDE_TEMPERATURE,
  OVERRIDE_BLOOM,
  OVERRIDE_LEAF_COV,
  OVERRIDE_COUNT
};