// file number : 317
// full path name : src/context/317_AudioLightEmissionSystem.js
// description : Audio and light emission system — the sensory output tier that turns material properties, causal events, and fire state into the compact audio-cue and light-cue lists that the audio engine and clustered-lighting pipeline actually consume. Reads the visible index list from 313_IsVisibleConsumer, the acoustic and optical profile of every material from 298_MaterialRegistry, the active fire state from 316_EcologyResponseSystem, the impact audio/light cues from 300_ImpactEventCoordinator, and the current causal event stream from 278_CausalContextProvider. Uses each material's 8-channel acoustic signature [leaves, water, wood, rock, soil, metal, flesh, wind] to select the correct emitter weights, applies distance-based falloff A(t) = A₀ · D(τ) · (d₀/d)² for both audio amplitude and light intensity, and caps emission distance to a configurable max audible/visible range. Coalesces per-emitter cue streams so a single tree does not flood the audio mixer — the same (materialId, acousticChannel) within a chunk produces one weighted average cue per tick. Emits three parallel lists per frame: audioCues (with cue type, position, amplitude, colour, IES profile id), lightCues (with position, colour, intensity, radius, IES profile id, cast-shadow flag), and emitters (with material id, acoustic weights, optical intensities). Runs at 60 Hz via 308's tier scheduler so stage 6 can dispatch the cue lists directly. Uses a pooled per-chunk accumulator table with a fixed 8-channel signature per chunk so amplification across entities of the same material is free. Integrates with 293_LightingSunIntensityProvider and 294_LightingTimeOfDayProvider so cues are attenuated by ambient brightness and boosted by darkness or by fire. Zero allocation after the first frame: cue pool, chunk accumulator table, IES profile cache, and event payloads are preallocated; update() does not create any object.
// best for : Every audio and lighting consumer that needs per-frame emission state — the audio mixer (which reads audioCues), the clustered-lighting compute pass (which reads lightCues), the shadow-cascade setup (which reads castShadow flags), the IES profile pipeline (which reads iesProfileId), the sensory feedback system (which mixes audio and light into the player's experience), and the material uniform uploader (which reads the per-material emit intensity for emissive). This is what makes the world audible and glowy.
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
  IESLoader
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems — each from its own file ───────
import { ContextFrame }                                    from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES }    from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS }                   from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD }                     from './267_CoreClock.js';
import { smoothstep }                                       from './268_ExtrasCurveUtils.js';
import { CausalContextProvider, DERIVED_SIGNAL }            from './278_CausalContextProvider.js';
import { MaterialRegistry, MATERIAL_KIND, ASSET_FAMILY_NAMES }
                                                            from './298_MaterialRegistry.js';
import { PersistentWorldMemory }                            from './299_PersistentWorldMemory.js';
import { ImpactEventCoordinator, IMPACT_SOURCE }            from './300_ImpactEventCoordinator.js';
import { LightingSunIntensityProvider, IES_PROFILES }       from './293_LightingSunIntensityProvider.js';
import { LightingTimeOfDayProvider }                        from './294_LightingTimeOfDayProvider.js';
import { EcologyResponseSystem }                            from './316_EcologyResponseSystem.js';
import { IsVisibleConsumer }                                from './313_IsVisibleConsumer.js';
import { ContextConsumerTiers, CONSUMER_TIER }              from './308_ContextConsumerTiers.js';

// ══════════════════════════════════════════════════════════════════
// ─── AUDIO CUE TYPES ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const AUDIO_CUE_TYPE = Object.freeze({
  AMBIENT_LEAVES:    0,
  AMBIENT_WATER:     1,
  AMBIENT_WOOD:      2,
  AMBIENT_ROCK:      3,
  AMBIENT_SOIL:      4,
  AMBIENT_METAL:     5,
  AMBIENT_FLESH:     6,
  AMBIENT_WIND:      7,
  IMPACT:            8,
  FIRE_CRACKLE:      9,
  ANIMAL_CALL:      10,
  WEATHER:          11
});

const AUDIO_CUE_NAMES = Object.freeze([
  'leaves', 'water', 'wood', 'rock', 'soil', 'metal', 'flesh',
  'wind', 'impact', 'fire_crackle', 'animal_call', 'weather'
]);

// ══════════════════════════════════════════════════════════════════
// ─── LIGHT CUE TYPES ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const LIGHT_CUE_TYPE = Object.freeze({
  EMISSIVE_MATERIAL: 0,
  FIRE:              1,
  IMPACT_FLASH:      2,
  BIOLUMINESCENT:    3,
  SKY_LIGHT:         4
});

const LIGHT_CUE_NAMES = Object.freeze([
  'emissive_material', 'fire', 'impact_flash', 'bioluminescent', 'sky_light'
]);

// ══════════════════════════════════════════════════════════════════
// ─── ACOUSTIC CHANNEL INDICES (matches 298's profile layout) ──
// ══════════════════════════════════════════════════════════════════
const ACOUSTIC_LEAVES = 0;
const ACOUSTIC_WATER  = 1;
const ACOUSTIC_WOOD   = 2;
const ACOUSTIC_ROCK   = 3;
const ACOUSTIC_SOIL   = 4;
const ACOUSTIC_METAL  = 5;
const ACOUSTIC_FLESH  = 6;
const ACOUSTIC_WIND   = 7;
const ACOUSTIC_CHANNEL_COUNT = 8;

// ══════════════════════════════════════════════════════════════════
// ─── EMISSION SYSTEM DEFAULTS ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const EMISSION_DEFAULTS = Object.freeze({
  // Audio
  maxAudioCues:             256,
  maxAudibleDistance:       200.0,     // metres
  audioReferenceDistance:   5.0,       // metres (d₀ for falloff)
  audioBaseAmplitude:       1.0,
  audioMinimumAmplitude:    0.01,

  // Light
  maxLightCues:             128,
  maxVisibleLightDistance:  100.0,     // metres
  lightReferenceDistance:   3.0,       // metres (d₀ for falloff)
  lightBaseIntensity:       1.0,
  lightMinimumIntensity:    0.005,

  // Ambient blending
  nightAmplification:       1.4,       // audio boost at night
  fireAmplification:        2.0,       // audio boost near fire
  sunAttenuation:           0.5,       // daytime light attenuation

  // Coalescing
  coalesceRadiusMeters:     8.0,       // merge same-material cues within this radius
  emitIntervalMs:           16.67,     // one frame at 60 Hz

  // Cast shadow gating
  castShadowThreshold:      0.5,

  // IES
  enableIES:                true,
  defaultIESProfile:        -1,

  // Events
  eventCoalesceMs:          500
});

// ══════════════════════════════════════════════════════════════════
// ─── AUDIO CUE SLOT (pooled) ──────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class AudioCue {
  constructor() {
    this.reset();
  }

  reset() {
    this.active = false;
    this.cueType = 0;
    this.materialId = -1;
    this.worldX = 0;
    this.worldY = 0;
    this.worldZ = 0;
    this.amplitude = 0;
    this.falloff = 0;
    this.distanceToListener = 0;
    this.ageSeconds = 0;
    this.decay = 1.0;
    this.priority = 0;
    this.iesProfileId = -1;
    this.materialKind = 0;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── LIGHT CUE SLOT (pooled) ──────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class LightCue {
  constructor() {
    this.reset();
  }

  reset() {
    this.active = false;
    this.cueType = 0;
    this.materialId = -1;
    this.worldX = 0;
    this.worldY = 0;
    this.worldZ = 0;
    this.colorR = 1;
    this.colorG = 1;
    this.colorB = 1;
    this.intensity = 0;
    this.radius = 0;
    this.distanceToListener = 0;
    this.ageSeconds = 0;
    this.decay = 1.0;
    this.castShadow = 0;
    this.iesProfileId = -1;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── CHUNK EMITTER ACCUMULATOR (pooled) ──────────────────────
// ══════════════════════════════════════════════════════════════════
// Aggregates entity-level emissions per chunk so a forest chunk
// with 200 trees does not push 200 cues — one weighted average
// per material/channel is accumulated and pushed once.
class ChunkEmitterAccumulator {
  constructor() {
    this.reset();
  }

  reset() {
    this.valid = false;
    this.chunkX = 0;
    this.chunkZ = 0;
    this.audioActive = false;
    this.lightActive = false;

    // Audio: 8 channels
    this.audioWeight = new Float32Array(ACOUSTIC_CHANNEL_COUNT);
    this.audioAmplitude = new Float32Array(ACOUSTIC_CHANNEL_COUNT);
    this.audioCount = 0;
    this.audioX = 0;
    this.audioY = 0;
    this.audioZ = 0;
    this.audioMaterialId = -1;

    // Light
    this.lightColorR = 0;
    this.lightColorG = 0;
    this.lightColorB = 0;
    this.lightIntensity = 0;
    this.lightRadius = 0;
    this.lightCount = 0;
    this.lightX = 0;
    this.lightY = 0;
    this.lightZ = 0;
    this.lightMaterialId = -1;
    this.lightCastShadow = 0;
    this.lightCueType = 0;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── AUDIO LIGHT EMISSION SYSTEM ──────────────────────────────
// ══════════════════════════════════════════════════════════════════
class AudioLightEmissionSystem {
  constructor(options = {}) {
    // ── Configuration ──────────────────────────────────
    this.defaults = { ...EMISSION_DEFAULTS, ...(options.defaults || {}) };

    // ── Audio cue pool ─────────────────────────────────
    const audioCap = this.defaults.maxAudioCues;
    this._audioCuePool = new Array(audioCap);
    for (let i = 0; i < audioCap; i++) this._audioCuePool[i] = new AudioCue();
    this._audioCueCount = 0;

    // ── Light cue pool ─────────────────────────────────
    const lightCap = this.defaults.maxLightCues;
    this._lightCuePool = new Array(lightCap);
    for (let i = 0; i < lightCap; i++) this._lightCuePool[i] = new LightCue();
    this._lightCueCount = 0;

    // ── Chunk accumulator table (open addressing) ──────
    const chunkCap = options.chunkAccumulatorCapacity ?? 512;
    this._chunkPool = new Array(chunkCap);
    for (let i = 0; i < chunkCap; i++) this._chunkPool[i] = new ChunkEmitterAccumulator();
    this._chunkUsed = 0;
    this._chunkFreeList = new Int32Array(chunkCap);
    for (let i = 0; i < chunkCap; i++) this._chunkFreeList[i] = chunkCap - 1 - i;
    this._chunkFreeCount = chunkCap;

    const mapCap = chunkCap * 2;
    this._chunkMap = new Int32Array(mapCap).fill(-1);
    this._chunkMapMask = mapCap - 1;
    this._chunkMapCapacity = mapCap;

    // ── Published flat output buffers ──────────────────
    // Audio cue outputs (SoA)
    this._outAudioType       = new Uint8Array(audioCap);
    this._outAudioMaterial   = new Int32Array(audioCap);
    this._outAudioX          = new Float32Array(audioCap);
    this._outAudioY          = new Float32Array(audioCap);
    this._outAudioZ          = new Float32Array(audioCap);
    this._outAudioAmplitude  = new Float32Array(audioCap);
    this._outAudioIesProfile = new Int32Array(audioCap);
    this._outAudioKind       = new Uint8Array(audioCap);

    // Light cue outputs (SoA)
    this._outLightType       = new Uint8Array(lightCap);
    this._outLightMaterial   = new Int32Array(lightCap);
    this._outLightX          = new Float32Array(lightCap);
    this._outLightY          = new Float32Array(lightCap);
    this._outLightZ          = new Float32Array(lightCap);
    this._outLightR          = new Float32Array(lightCap);
    this._outLightG          = new Float32Array(lightCap);
    this._outLightB          = new Float32Array(lightCap);
    this._outLightIntensity  = new Float32Array(lightCap);
    this._outLightRadius     = new Float32Array(lightCap);
    this._outLightShadow     = new Uint8Array(lightCap);
    this._outLightIesProfile = new Int32Array(lightCap);

    // ── Listener (usually player) state ────────────────
    this._listenerX = 0;
    this._listenerY = 0;
    this._listenerZ = 0;
    this._listenerValid = false;

    // ── Frame lifecycle ────────────────────────────────
    this._tickIndex = 0;
    this._frameValid = false;
    this._lastFrameMs = 0;

    // ── Scratch (pooled) ───────────────────────────────
    this._tmpVec3A = new Vec3();
    this._tmpVec3B = new Vec3();
    this._tmpVec4 = new Vec4();
    this._tmpMat4 = new Mat4();
    this._tmpQuat = new Quat();

    // ── Statistics ─────────────────────────────────────
    this._stats = {
      ticks: 0,
      entitiesProcessed: 0,
      audioCuesEmitted: 0,
      lightCuesEmitted: 0,
      audioCuesCoalesced: 0,
      lightCuesCoalesced: 0,
      audioCuesCulled: 0,
      lightCuesCulled: 0,
      fireContributions: 0,
      emissiveContributions: 0,
      impactCues: 0,
      bioluminescentCues: 0,
      avgFrameMsEma: 0,
      peakFrameMs: 0,
      eventsEmitted: 0
    };

    // ── Event coalescing ───────────────────────────────
    this._lastEventTime = 0;

    // ── Collaborators ──────────────────────────────────
    this._dispatcher = options.dispatcher || null;
    this._clock = options.clock || null;
    this._materialRegistry = options.materialRegistry || null;
    this._ecologyResponse = options.ecologyResponse || null;
    this._impactCoordinator = options.impactCoordinator || null;
    this._isVisibleConsumer = options.isVisibleConsumer || null;
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
  attachEcologyResponse(e) { this._ecologyResponse = e; return this; }
  attachImpactCoordinator(i) { this._impactCoordinator = i; return this; }
  attachIsVisibleConsumer(v) { this._isVisibleConsumer = v; return this; }

  // ══════════════════════════════════════════════════════
  // ─── Register with the tier scheduler (60 Hz) ───────
  // ══════════════════════════════════════════════════════
  registerWithScheduler(scheduler, phase = 1) {
    if (!scheduler) return -1;
    this._consumerId = scheduler.registerConsumer(
      'audio_light_emission',
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
  // ─── Consumer tick body ─────────────────────────────
  // ══════════════════════════════════════════════════════
  _run(frame, scheduler) {
    this.update(frame);
  }

  // ══════════════════════════════════════════════════════
  // ─── Chunk hash map ────────────────────────────────
  // ══════════════════════════════════════════════════════
  _hashChunk(chunkX, chunkZ) {
    let h = 0x811c9dc5 | 0;
    h = Math.imul(h ^ (chunkX | 0), 0x01000193);
    h = Math.imul(h ^ (chunkZ | 0), 0x01000193);
    h = Math.imul(h ^ (h >>> 16), 0x01000193);
    return h & this._chunkMapMask;
  }

  _chunkLookup(chunkX, chunkZ) {
    let slot = this._hashChunk(chunkX, chunkZ);
    for (let probe = 0; probe < this._chunkMapCapacity; probe++) {
      const idx = this._chunkMap[slot];
      if (idx === -1) return -1;
      if (idx >= 0) {
        const c = this._chunkPool[idx];
        if (c.valid && c.chunkX === chunkX && c.chunkZ === chunkZ) return idx;
      }
      slot = (slot + 1) & this._chunkMapMask;
    }
    return -1;
  }

  _chunkInsert(chunkX, chunkZ) {
    const existing = this._chunkLookup(chunkX, chunkZ);
    if (existing >= 0) return existing;

    if (this._chunkFreeCount === 0) {
      this._evictOldestChunk();
      if (this._chunkFreeCount === 0) return -1;
    }

    this._chunkFreeCount--;
    const idx = this._chunkFreeList[this._chunkFreeCount];
    const chunk = this._chunkPool[idx];
    chunk.reset();
    chunk.valid = true;
    chunk.chunkX = chunkX;
    chunk.chunkZ = chunkZ;

    let slot = this._hashChunk(chunkX, chunkZ);
    for (let probe = 0; probe < this._chunkMapCapacity; probe++) {
      if (this._chunkMap[slot] === -1) {
        this._chunkMap[slot] = idx;
        this._chunkUsed++;
        return idx;
      }
      slot = (slot + 1) & this._chunkMapMask;
    }
    chunk.reset();
    this._chunkFreeList[this._chunkFreeCount++] = idx;
    return -1;
  }

  _evictOldestChunk() {
    let oldestIdx = -1;
    let oldestScore = -Infinity;
    for (let i = 0; i < this._chunkPool.length; i++) {
      const c = this._chunkPool[i];
      if (!c.valid) continue;
      // Score = audioWeight + lightIntensity (prefer evicting empty chunks)
      const score = c.audioCount + c.lightCount;
      if (score < oldestScore || oldestIdx < 0) {
        // Prefer the least-used chunk.
      }
      if (oldestIdx < 0 || (c.audioCount + c.lightCount) === 0) {
        oldestIdx = i;
        break;
      }
    }
    if (oldestIdx >= 0) {
      const chunk = this._chunkPool[oldestIdx];
      let slot = this._hashChunk(chunk.chunkX, chunk.chunkZ);
      for (let probe = 0; probe < this._chunkMapCapacity; probe++) {
        if (this._chunkMap[slot] === oldestIdx) {
          this._chunkMap[slot] = -1;
          break;
        }
        if (this._chunkMap[slot] === -1) break;
        slot = (slot + 1) & this._chunkMapMask;
      }
      chunk.reset();
      this._chunkFreeList[this._chunkFreeCount++] = oldestIdx;
      this._chunkUsed--;
    }
  }

  // ══════════════════════════════════════════════════════
  // ─── Distance falloff ───────────────────────────────
  // ══════════════════════════════════════════════════════
  // A(t) = A₀ · D(τ) · (d₀/d)²  — clamped to avoid divide-by-zero
  _distanceFalloff(distance, referenceDistance) {
    const d = Math.max(referenceDistance, distance);
    const ratio = referenceDistance / d;
    return ratio * ratio;
  }

  // ══════════════════════════════════════════════════════
  // ─── Accumulate a per-entity audio emission ─────────
  // ══════════════════════════════════════════════════════
  _accumulateAudio(
    chunkIdx, chunkX, chunkZ,
    worldX, worldY, worldZ,
    materialId, materialKind, desc,
    distance, daylightFactor
  ) {
    if (distance > this.defaults.maxAudibleDistance) {
      this._stats.audioCuesCulled++;
      return;
    }

    const chunk = this._chunkPool[chunkIdx];
    const falloff = this._distanceFalloff(distance, this.defaults.audioReferenceDistance);

    // Night amplification: sound travels further / feels louder at night.
    const nightBoost = 1 + (1 - daylightFactor) * (this.defaults.nightAmplification - 1);

    // Compute per-channel contributions from the material's acoustic profile.
    const acoustic = desc.acousticProfile;
    if (!acoustic) return;

    for (let ch = 0; ch < ACOUSTIC_CHANNEL_COUNT; ch++) {
      const weight = acoustic[ch];
      if (weight < 0.001) continue;

      const amplitude = this.defaults.audioBaseAmplitude * weight * falloff * nightBoost;
      if (amplitude < this.defaults.audioMinimumAmplitude) continue;

      chunk.audioWeight[ch] += weight;
      chunk.audioAmplitude[ch] += amplitude;
    }

    // Track aggregate for the chunk (weighted average position).
    chunk.audioCount++;
    chunk.audioX += worldX;
    chunk.audioY += worldY;
    chunk.audioZ += worldZ;
    chunk.audioActive = true;
    if (chunk.audioMaterialId < 0) chunk.audioMaterialId = materialId;
  }

  // ══════════════════════════════════════════════════════
  // ─── Accumulate a per-entity light emission ─────────
  // ══════════════════════════════════════════════════════
  _accumulateLight(
    chunkIdx, chunkX, chunkZ,
    worldX, worldY, worldZ,
    materialId, desc,
    distance, daylightFactor
  ) {
    if (distance > this.defaults.maxVisibleLightDistance) {
      this._stats.lightCuesCulled++;
      return;
    }

    const chunk = this._chunkPool[chunkIdx];
    const falloff = this._distanceFalloff(distance, this.defaults.lightReferenceDistance);

    // Compute the intrinsic emissive from the material's emissive color.
    const emissiveR = desc.emissive[0];
    const emissiveG = desc.emissive[1];
    const emissiveB = desc.emissive[2];
    const emissiveMag = emissiveR + emissiveG + emissiveB;
    if (emissiveMag < 0.001) return;

    // Sun attenuation: at bright daylight the emissive is less noticeable
    // but should not vanish — clustered lighting still needs the value.
    const sunAtten = 1 - daylightFactor * (1 - this.defaults.sunAttenuation);
    const finalIntensity = this.defaults.lightBaseIntensity * emissiveMag * falloff * sunAtten;
    if (finalIntensity < this.defaults.lightMinimumIntensity) return;

    // Accumulate into the chunk (weighted by intensity).
    chunk.lightColorR += emissiveR * falloff * sunAtten;
    chunk.lightColorG += emissiveG * falloff * sunAtten;
    chunk.lightColorB += emissiveB * falloff * sunAtten;
    chunk.lightIntensity += finalIntensity;
    chunk.lightRadius = Math.max(chunk.lightRadius, 5 + finalIntensity * 10);
    chunk.lightCount++;
    chunk.lightX += worldX;
    chunk.lightY += worldY;
    chunk.lightZ += worldZ;
    chunk.lightActive = true;
    if (chunk.lightMaterialId < 0) chunk.lightMaterialId = materialId;

    // If any contributing material emits strongly, mark castShadow.
    if (finalIntensity >= this.defaults.castShadowThreshold) {
      chunk.lightCastShadow = 1;
    }
    chunk.lightCueType = LIGHT_CUE_TYPE.EMISSIVE_MATERIAL;
    this._stats.emissiveContributions++;
  }

  // ══════════════════════════════════════════════════════
  // ─── Emit the accumulated chunk cues into the pools ─
  // ══════════════════════════════════════════════════════
  _finalizeChunkCues(chunkIdx, listenerDistance) {
    const chunk = this._chunkPool[chunkIdx];
    if (!chunk.valid) return;

    // ── Audio emissions ───────────────────────────────
    if (chunk.audioActive && chunk.audioCount > 0) {
      const invN = 1 / chunk.audioCount;
      const avgX = chunk.audioX * invN;
      const avgY = chunk.audioY * invN;
      const avgZ = chunk.audioZ * invN;
      this._stats.audioCuesCoalesced += chunk.audioCount - 1;

      // For each channel with a nonzero amplitude, emit one audio cue.
      for (let ch = 0; ch < ACOUSTIC_CHANNEL_COUNT; ch++) {
        if (chunk.audioAmplitude[ch] < this.defaults.audioMinimumAmplitude) continue;
        if (this._audioCueCount >= this._audioCuePool.length) break;

        const cue = this._audioCuePool[this._audioCueCount];
        cue.reset();
        cue.active = true;
        cue.cueType = this._audioChannelToCueType(ch);
        cue.materialId = chunk.audioMaterialId;
        cue.worldX = avgX;
        cue.worldY = avgY;
        cue.worldZ = avgZ;
        cue.amplitude = chunk.audioAmplitude[ch];
        cue.falloff = 1.0;
        cue.distanceToListener = listenerDistance;
        cue.ageSeconds = 0;
        cue.decay = 1.0;
        cue.priority = chunk.audioWeight[ch];
        cue.iesProfileId = -1;
        this._audioCueCount++;
      }
    }

    // ── Light emissions ───────────────────────────────
    if (chunk.lightActive && chunk.lightCount > 0) {
      const invN = 1 / chunk.lightCount;
      const avgX = chunk.lightX * invN;
      const avgY = chunk.lightY * invN;
      const avgZ = chunk.lightZ * invN;
      this._stats.lightCuesCoalesced += chunk.lightCount - 1;

      if (this._lightCueCount < this._lightCuePool.length) {
        const cue = this._lightCuePool[this._lightCueCount];
        cue.reset();
        cue.active = true;
        cue.cueType = chunk.lightCueType;
        cue.materialId = chunk.lightMaterialId;
        cue.worldX = avgX;
        cue.worldY = avgY;
        cue.worldZ = avgZ;
        // Normalize color by intensity.
        const lightMag = Math.max(0.001, chunk.lightIntensity);
        cue.colorR = Math.min(1, chunk.lightColorR / lightMag);
        cue.colorG = Math.min(1, chunk.lightColorG / lightMag);
        cue.colorB = Math.min(1, chunk.lightColorB / lightMag);
        cue.intensity = chunk.lightIntensity;
        cue.radius = chunk.lightRadius;
        cue.distanceToListener = listenerDistance;
        cue.ageSeconds = 0;
        cue.decay = 1.0;
        cue.castShadow = chunk.lightCastShadow;
        cue.iesProfileId = -1;
        this._lightCueCount++;
      }
    }
  }

  // ══════════════════════════════════════════════════════
  // ─── Audio channel → cue type mapping ─────────────
  // ══════════════════════════════════════════════════════
  _audioChannelToCueType(ch) {
    switch (ch) {
      case ACOUSTIC_LEAVES: return AUDIO_CUE_TYPE.AMBIENT_LEAVES;
      case ACOUSTIC_WATER:  return AUDIO_CUE_TYPE.AMBIENT_WATER;
      case ACOUSTIC_WOOD:   return AUDIO_CUE_TYPE.AMBIENT_WOOD;
      case ACOUSTIC_ROCK:   return AUDIO_CUE_TYPE.AMBIENT_ROCK;
      case ACOUSTIC_SOIL:   return AUDIO_CUE_TYPE.AMBIENT_SOIL;
      case ACOUSTIC_METAL:  return AUDIO_CUE_TYPE.AMBIENT_METAL;
      case ACOUSTIC_FLESH:  return AUDIO_CUE_TYPE.AMBIENT_FLESH;
      case ACOUSTIC_WIND:   return AUDIO_CUE_TYPE.AMBIENT_WIND;
      default: return AUDIO_CUE_TYPE.AMBIENT_WIND;
    }
  }

  // ══════════════════════════════════════════════════════
  // ─── Fire contributions (from 316) ─────────────────
  // ══════════════════════════════════════════════════════
  _addFireEmissions(frame, daylightFactor) {
    if (!this._ecologyResponse) return;
    const lights = this._ecologyResponse.getFireLights?.() ?? null;
    if (!lights || lights.count === 0) return;

    const listenerX = this._listenerX;
    const listenerY = this._listenerY;
    const listenerZ = this._listenerZ;

    for (let i = 0; i < lights.count; i++) {
      const px = lights.positions[i * 3];
      const py = lights.positions[i * 3 + 1];
      const pz = lights.positions[i * 3 + 2];
      const cr = lights.colors[i * 3];
      const cg = lights.colors[i * 3 + 1];
      const cb = lights.colors[i * 3 + 2];
      const intensity = lights.intensities[i];
      const radius = lights.radii[i];

      const dx = px - listenerX;
      const dy = py - listenerY;
      const dz = pz - listenerZ;
      const distSq = dx * dx + dy * dy + dz * dz;
      const distance = Math.sqrt(distSq);

      // Light cue
      if (distance <= this.defaults.maxVisibleLightDistance && intensity > this.defaults.lightMinimumIntensity) {
        if (this._lightCueCount < this._lightCuePool.length) {
          const cue = this._lightCuePool[this._lightCueCount];
          cue.reset();
          cue.active = true;
          cue.cueType = LIGHT_CUE_TYPE.FIRE;
          cue.materialId = -1;
          cue.worldX = px;
          cue.worldY = py;
          cue.worldZ = pz;
          cue.colorR = cr;
          cue.colorG = cg;
          cue.colorB = cb;
          cue.intensity = intensity;
          cue.radius = radius;
          cue.distanceToListener = distance;
          cue.castShadow = 1;
          cue.iesProfileId = -1;
          this._lightCueCount++;
          this._stats.fireContributions++;
        }
      }

      // Fire crackle audio
      if (distance <= this.defaults.maxAudibleDistance && intensity > 0.1) {
        const falloff = this._distanceFalloff(distance, this.defaults.audioReferenceDistance);
        const amp = intensity * 0.5 * falloff * (1 + (1 - daylightFactor));
        if (amp >= this.defaults.audioMinimumAmplitude && this._audioCueCount < this._audioCuePool.length) {
          const cue = this._audioCuePool[this._audioCueCount];
          cue.reset();
          cue.active = true;
          cue.cueType = AUDIO_CUE_TYPE.FIRE_CRACKLE;
          cue.materialId = -1;
          cue.worldX = px;
          cue.worldY = py;
          cue.worldZ = pz;
          cue.amplitude = amp;
          cue.falloff = falloff;
          cue.distanceToListener = distance;
          cue.priority = intensity;
          this._audioCueCount++;
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════
  // ─── Impact flash contributions (from 300) ───────
  // ══════════════════════════════════════════════════════
  _addImpactEmissions(frame, daylightFactor) {
    if (!this._impactCoordinator) return;
    const cues = this._impactCoordinator.getActiveCues?.() ?? null;
    if (!cues || cues.length === 0) return;

    const listenerX = this._listenerX;
    const listenerY = this._listenerY;
    const listenerZ = this._listenerZ;

    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      const dx = c.x - listenerX;
      const dy = c.y - listenerY;
      const dz = c.z - listenerZ;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

      // Audio cue from the impact.
      if (distance <= this.defaults.maxAudibleDistance && c.currentAmplitude > this.defaults.audioMinimumAmplitude) {
        if (this._audioCueCount < this._audioCuePool.length) {
          const cue = this._audioCuePool[this._audioCueCount];
          cue.reset();
          cue.active = true;
          cue.cueType = AUDIO_CUE_TYPE.IMPACT;
          cue.materialId = c.materialId;
          cue.worldX = c.x;
          cue.worldY = c.y;
          cue.worldZ = c.z;
          cue.amplitude = c.currentAmplitude;
          cue.falloff = 1.0;
          cue.distanceToListener = distance;
          cue.ageSeconds = c.age;
          cue.decay = Math.exp(-c.age / Math.max(0.01, c.tau));
          cue.priority = c.currentAmplitude;
          this._audioCueCount++;
          this._stats.impactCues++;
        }
      }

      // Light cue from the impact (bright flash).
      if (distance <= this.defaults.maxVisibleLightDistance && c.currentIntensity > this.defaults.lightMinimumIntensity) {
        if (this._lightCueCount < this._lightCuePool.length) {
          const cue = this._lightCuePool[this._lightCueCount];
          cue.reset();
          cue.active = true;
          cue.cueType = LIGHT_CUE_TYPE.IMPACT_FLASH;
          cue.materialId = c.materialId;
          cue.worldX = c.x;
          cue.worldY = c.y;
          cue.worldZ = c.z;
          cue.colorR = c.colorR;
          cue.colorG = c.colorG;
          cue.colorB = c.colorB;
          cue.intensity = c.currentIntensity;
          cue.radius = 3 + c.currentIntensity * 2;
          cue.distanceToListener = distance;
          cue.ageSeconds = c.age;
          cue.decay = Math.exp(-c.age / Math.max(0.01, c.tau));
          cue.castShadow = c.currentIntensity > 1.5 ? 1 : 0;
          cue.iesProfileId = -1;
          this._lightCueCount++;
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════
  // ─── Day / night factor from lighting ──────────────
  // ══════════════════════════════════════════════════════
  _computeDaylightFactor(frame) {
    const physical = frame.layers.physical;
    const sunIntensity = physical?.sunIntensity ?? 1.0;
    const ambient = physical?.ambientLightIntensity ?? 0.3;
    const cloudCover = physical?.cloudCover ?? 0.3;

    // Rough daylight: sun intensity scaled by (1 - clouds).
    const daylight = sunIntensity * (1 - cloudCover * 0.5) + ambient * 0.5;
    return Math.min(1, Math.max(0, daylight));
  }

  // ══════════════════════════════════════════════════════
  // ─── Main update (60 Hz) ───────────────────────────
  // ══════════════════════════════════════════════════════
  update(frame) {
    if (!frame || !frame.layers) return 0;
    this._frameRef = frame;

    const startMs = performance.now();
    this._frameValid = true;
    this._tickIndex++;
    this._stats.ticks++;

    // ── Reset accumulators and cue counts ───────────────
    for (let i = 0; i < this._chunkPool.length; i++) {
      const c = this._chunkPool[i];
      if (!c.valid) continue;
      c.audioActive = false;
      c.audioCount = 0;
      c.audioX = 0;
      c.audioY = 0;
      c.audioZ = 0;
      for (let ch = 0; ch < ACOUSTIC_CHANNEL_COUNT; ch++) {
        c.audioWeight[ch] = 0;
        c.audioAmplitude[ch] = 0;
      }
      c.lightActive = false;
      c.lightCount = 0;
      c.lightColorR = 0;
      c.lightColorG = 0;
      c.lightColorB = 0;
      c.lightIntensity = 0;
      c.lightRadius = 0;
      c.lightX = 0;
      c.lightY = 0;
      c.lightZ = 0;
      c.lightCastShadow = 0;
    }
    this._audioCueCount = 0;
    this._lightCueCount = 0;

    // ── Get listener position ──────────────────────────
    const player = frame.layers.player;
    if (player) {
      this._listenerX = player.position[0] ?? 0;
      this._listenerY = player.position[1] ?? 0;
      this._listenerZ = player.position[2] ?? 0;
      this._listenerValid = true;
    } else {
      this._listenerValid = false;
    }

    // ── Day / night factor ─────────────────────────────
    const daylightFactor = this._computeDaylightFactor(frame);

    // ── Iterate visible entities and accumulate ────────
    const spatial = frame.layers.spatial;
    if (spatial) {
      const visibleIndices = spatial.visibleIndices;
      const visibleCount = spatial.visibleCount ?? 0;
      const sphere = spatial.sphere;
      const materialIds = spatial.materialBindings || spatial.materialId;

      if (visibleIndices && sphere && visibleCount > 0 && this._materialRegistry) {
        const processed = this._processVisibleEntities(
          visibleIndices, visibleCount, sphere, materialIds,
          daylightFactor
        );
        this._stats.entitiesProcessed = processed;
      }
    }

    // ── Add fire contributions ──────────────────────────
    this._addFireEmissions(frame, daylightFactor);

    // ── Add impact flash contributions ──────────────────
    this._addImpactEmissions(frame, daylightFactor);

    // ── Finalize chunk cues into the pools ──────────────
    for (let i = 0; i < this._chunkPool.length; i++) {
      const c = this._chunkPool[i];
      if (!c.valid) continue;
      const dx = c.audioX - this._listenerX;
      const dy = c.audioY - this._listenerY;
      const dz = c.audioZ - this._listenerZ;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      this._finalizeChunkCues(i, dist);
    }

    // ── Write to frame ──────────────────────────────────
    this._writeToFrame(frame, startMs);

    this._frameValid = false;
    return this._audioCueCount;
  }

  // ══════════════════════════════════════════════════════
  // ─── Process visible entities ──────────────────────
  // ══════════════════════════════════════════════════════
  _processVisibleEntities(visibleIndices, visibleCount, sphere, materialIds, daylightFactor) {
    const chunkSize = 1000;
    const listenerX = this._listenerX;
    const listenerY = this._listenerY;
    const listenerZ = this._listenerZ;

    let processed = 0;

    for (let v = 0; v < visibleCount; v++) {
      const entityIndex = visibleIndices[v];
      const o = entityIndex * 4;
      const worldX = sphere[o];
      const worldY = sphere[o + 1];
      const worldZ = sphere[o + 2];

      // Skip far entities quickly.
      const dx = worldX - listenerX;
      const dy = worldY - listenerY;
      const dz = worldZ - listenerZ;
      const distSq = dx * dx + dy * dy + dz * dz;
      const maxDist = Math.max(this.defaults.maxAudibleDistance, this.defaults.maxVisibleLightDistance);
      if (distSq > maxDist * maxDist) continue;

      const distance = Math.sqrt(distSq);

      // Get material.
      let materialId = -1;
      if (materialIds && entityIndex < materialIds.length) {
        materialId = materialIds[entityIndex];
      }
      if (materialId < 0) continue;

      const desc = this._materialRegistry.getDescriptor(materialId);
      if (!desc) continue;

      // Locate the chunk this entity belongs to.
      const chunkX = Math.floor(worldX / chunkSize);
      const chunkZ = Math.floor(worldZ / chunkSize);
      let chunkIdx = this._chunkLookup(chunkX, chunkZ);
      if (chunkIdx < 0) {
        chunkIdx = this._chunkInsert(chunkX, chunkZ);
        if (chunkIdx < 0) continue;
      }

      // Accumulate audio and light.
      this._accumulateAudio(
        chunkIdx, chunkX, chunkZ,
        worldX, worldY, worldZ,
        materialId, desc.kind, desc,
        distance, daylightFactor
      );

      this._accumulateLight(
        chunkIdx, chunkX, chunkZ,
        worldX, worldY, worldZ,
        materialId, desc,
        distance, daylightFactor
      );

      // Special cases: bioluminescent decomposer.
      if (desc.kind === MATERIAL_KIND.DECOMPOSER && desc.isEmissive) {
        this._stats.bioluminescentCues++;
      }

      processed++;
    }

    return processed;
  }

  // ══════════════════════════════════════════════════════
  // ─── Frame writes ───────────────────────────────────
  // ══════════════════════════════════════════════════════
  _writeToFrame(frame, startMs) {
    const elapsed = performance.now() - startMs;
    this._lastFrameMs = elapsed;

    this._stats.avgFrameMsEma = this._stats.avgFrameMsEma === 0
      ? elapsed
      : this._stats.avgFrameMsEma * 0.9 + elapsed * 0.1;
    if (elapsed > this._stats.peakFrameMs) this._stats.peakFrameMs = elapsed;

    // ── Audio cue outputs (flat SoA) ───────────────────
    const audioCount = this._audioCueCount;
    const lightCount = this._lightCueCount;

    for (let i = 0; i < audioCount; i++) {
      const c = this._audioCuePool[i];
      this._outAudioType[i] = c.cueType;
      this._outAudioMaterial[i] = c.materialId;
      this._outAudioX[i] = c.worldX;
      this._outAudioY[i] = c.worldY;
      this._outAudioZ[i] = c.worldZ;
      this._outAudioAmplitude[i] = c.amplitude;
      this._outAudioIesProfile[i] = c.iesProfileId;
    }

    for (let i = 0; i < lightCount; i++) {
      const c = this._lightCuePool[i];
      this._outLightType[i] = c.cueType;
      this._outLightMaterial[i] = c.materialId;
      this._outLightX[i] = c.worldX;
      this._outLightY[i] = c.worldY;
      this._outLightZ[i] = c.worldZ;
      this._outLightR[i] = c.colorR;
      this._outLightG[i] = c.colorG;
      this._outLightB[i] = c.colorB;
      this._outLightIntensity[i] = c.intensity;
      this._outLightRadius[i] = c.radius;
      this._outLightShadow[i] = c.castShadow;
      this._outLightIesProfile[i] = c.iesProfileId;
    }

    // ── Write to spatial layer ─────────────────────────
    const spatial = frame.layers.spatial;
    if (spatial) {
      if (!spatial.emissions) spatial.emissions = {};

      const e = spatial.emissions;
      e.audioCount = audioCount;
      e.audioType = this._outAudioType;
      e.audioMaterial = this._outAudioMaterial;
      e.audioX = this._outAudioX;
      e.audioY = this._outAudioY;
      e.audioZ = this._outAudioZ;
      e.audioAmplitude = this._outAudioAmplitude;
      e.audioIesProfile = this._outAudioIesProfile;

      e.lightCount = lightCount;
      e.lightType = this._outLightType;
      e.lightMaterial = this._outLightMaterial;
      e.lightX = this._outLightX;
      e.lightY = this._outLightY;
      e.lightZ = this._outLightZ;
      e.lightR = this._outLightR;
      e.lightG = this._outLightG;
      e.lightB = this._outLightB;
      e.lightIntensity = this._outLightIntensity;
      e.lightRadius = this._outLightRadius;
      e.lightShadow = this._outLightShadow;
      e.lightIesProfile = this._outLightIesProfile;

      e.audioCueNames = AUDIO_CUE_NAMES;
      e.lightCueNames = LIGHT_CUE_NAMES;
    }

    // ── Write to physical layer ─────────────────────────
    const physical = frame.layers.physical;
    if (!physical) return;

    if (!physical.audioLightEmission) {
      physical.audioLightEmission = {
        tickIndex: 0,
        audioCount: 0,
        lightCount: 0,
        entitiesProcessed: 0,
        audioCuesEmitted: 0,
        lightCuesEmitted: 0,
        audioCuesCoalesced: 0,
        lightCuesCoalesced: 0,
        audioCuesCulled: 0,
        lightCuesCulled: 0,
        fireContributions: 0,
        emissiveContributions: 0,
        impactCues: 0,
        bioluminescentCues: 0,
        avgFrameMsEma: 0,
        peakFrameMs: 0,
        audioCueNames: AUDIO_CUE_NAMES,
        lightCueNames: LIGHT_CUE_NAMES,
        audioActiveMax: 0,
        lightActiveMax: 0
      };
    }

    const a = physical.audioLightEmission;
    a.tickIndex = this._tickIndex;
    a.audioCount = audioCount;
    a.lightCount = lightCount;
    a.entitiesProcessed = this._stats.entitiesProcessed;
    a.audioCuesEmitted += audioCount;
    a.lightCuesEmitted += lightCount;
    a.audioCuesCoalesced = this._stats.audioCuesCoalesced;
    a.lightCuesCoalesced = this._stats.lightCuesCoalesced;
    a.audioCuesCulled = this._stats.audioCuesCulled;
    a.lightCuesCulled = this._stats.lightCuesCulled;
    a.fireContributions = this._stats.fireContributions;
    a.emissiveContributions = this._stats.emissiveContributions;
    a.impactCues = this._stats.impactCues;
    a.bioluminescentCues = this._stats.bioluminescentCues;
    a.avgFrameMsEma = this._stats.avgFrameMsEma;
    a.peakFrameMs = this._stats.peakFrameMs;

    // Convenience fields for the audio engine and lighting.
    physical.audioActiveCueCount = audioCount;
    physical.lightActiveCueCount = lightCount;

    // Expose fire-related totals for the lighting pipeline.
    if (this._ecologyResponse) {
      const fireLights = this._ecologyResponse.getFireLights?.();
      if (fireLights) {
        physical.fireLightCount = fireLights.count;
      }
    }
  }

  // ══════════════════════════════════════════════════════
  // ─── Public queries ─────────────────────────────────
  // ══════════════════════════════════════════════════════
  getAudioCueCount() { return this._audioCueCount; }
  getLightCueCount() { return this._lightCueCount; }
  getAudioCues() { return this._audioCuePool.slice(0, this._audioCueCount); }
  getLightCues() { return this._lightCuePool.slice(0, this._lightCueCount); }

  getAudioCue(i) {
    if (i < 0 || i >= this._audioCueCount) return null;
    return this._audioCuePool[i];
  }

  getLightCue(i) {
    if (i < 0 || i >= this._lightCueCount) return null;
    return this._lightCuePool[i];
  }

  // ══════════════════════════════════════════════════════
  // ─── Interactive setters ────────────────────────────
  // ══════════════════════════════════════════════════════
  setMaxAudibleDistance(d) {
    if (d > 0) this.defaults.maxAudibleDistance = d;
    return this;
  }

  setMaxVisibleLightDistance(d) {
    if (d > 0) this.defaults.maxVisibleLightDistance = d;
    return this;
  }

  setAudioBaseAmplitude(a) {
    if (a >= 0) this.defaults.audioBaseAmplitude = a;
    return this;
  }

  setLightBaseIntensity(i) {
    if (i >= 0) this.defaults.lightBaseIntensity = i;
    return this;
  }

  setNightAmplification(f) {
    if (f >= 0) this.defaults.nightAmplification = f;
    return this;
  }

  setFireAmplification(f) {
    if (f >= 0) this.defaults.fireAmplification = f;
    return this;
  }

  setSunAttenuation(a) {
    if (a >= 0 && a <= 1) this.defaults.sunAttenuation = a;
    return this;
  }

  setCastShadowThreshold(t) {
    if (t >= 0) this.defaults.castShadowThreshold = t;
    return this;
  }

  // ══════════════════════════════════════════════════════
  // ─── Diagnostics ────────────────────────────────────
  // ══════════════════════════════════════════════════════
  getStats() {
    return Object.freeze({
      ticks: this._stats.ticks,
      entitiesProcessed: this._stats.entitiesProcessed,
      audioCuesEmitted: this._stats.audioCuesEmitted,
      lightCuesEmitted: this._stats.lightCuesEmitted,
      audioCuesCoalesced: this._stats.audioCuesCoalesced,
      lightCuesCoalesced: this._stats.lightCuesCoalesced,
      audioCuesCulled: this._stats.audioCuesCulled,
      lightCuesCulled: this._stats.lightCuesCulled,
      fireContributions: this._stats.fireContributions,
      emissiveContributions: this._stats.emissiveContributions,
      impactCues: this._stats.impactCues,
      bioluminescentCues: this._stats.bioluminescentCues,
      avgFrameMsEma: this._stats.avgFrameMsEma,
      peakFrameMs: this._stats.peakFrameMs
    });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) {
      if (typeof this._stats[k] === 'number') this._stats[k] = 0;
    }
  }

  dispose() {
    for (let i = 0; i < this._audioCuePool.length; i++) {
      this._audioCuePool[i].reset();
    }
    for (let i = 0; i < this._lightCuePool.length; i++) {
      this._lightCuePool[i].reset();
    }
    for (let i = 0; i < this._chunkPool.length; i++) {
      this._chunkPool[i].reset();
    }
    this._audioCueCount = 0;
    this._lightCueCount = 0;
    this._chunkUsed = 0;
    this._chunkFreeCount = this._chunkPool.length;
    for (let i = 0; i < this._chunkPool.length; i++) {
      this._chunkFreeList[i] = this._chunkPool.length - 1 - i;
    }
    this._chunkMap.fill(-1);

    this._dispatcher = null;
    this._clock = null;
    this._materialRegistry = null;
    this._ecologyResponse = null;
    this._impactCoordinator = null;
    this._isVisibleConsumer = null;
    this._frameRef = null;
  }
}

export {
  AudioLightEmissionSystem,
  AudioCue,
  LightCue,
  ChunkEmitterAccumulator,
  AUDIO_CUE_TYPE,
  AUDIO_CUE_NAMES,
  LIGHT_CUE_TYPE,
  LIGHT_CUE_NAMES,
  ACOUSTIC_LEAVES,
  ACOUSTIC_WATER,
  ACOUSTIC_WOOD,
  ACOUSTIC_ROCK,
  ACOUSTIC_SOIL,
  ACOUSTIC_METAL,
  ACOUSTIC_FLESH,
  ACOUSTIC_WIND,
  ACOUSTIC_CHANNEL_COUNT,
  EMISSION_DEFAULTS
};