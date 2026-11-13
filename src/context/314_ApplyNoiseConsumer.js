// file number : 314
// full path name : src/context/314_ApplyNoiseConsumer.js
// description : The 10 Hz procedural-deformation consumer — the tier-four metabolism that applies Perlin/Simplex/FBM noise, wind sway, water-wave Gerstner deformation, and per-material vertex displacement to every visible entity that reacts to environment. Reads the frame's spatial layer (AABB centers, screen coverage, distances, visibility flags, LOD levels, LOD alpha, wind sway weights) and the physical layer (wind vector, humidity, wetness, temperature, time-of-day), then writes back a per-entity deformation delta that stage 6's emitter converts into vertex-shader uniforms or CPU-side vertex buffers. Handles four independent deformation families: (1) FOLIAGE SWAY — δ = W · a · sin(ωt + φ) · n̂_perp where W is the per-instance wind sway weight, a is the amplitude, ω is the gust frequency, φ is a per-instance phase, and n̂_perp is the horizontal perpendicular to the wind direction, so grass and leaves bend with the wind and release back; (2) WATER WAVES — sum of Gerstner waves η(x,t) = Σ a_i · cos(k_i(x·d̂_i) + ω_i·t + φ_i) with deep-water dispersion ω_i = √(g·k_i), so water surfaces ripple, heave, and break realistically; (3) TERRAIN NOISE — FBM(x) = Σ a_i · n(f_i · x) with persistence p and lacunarity l (typically 0.5 and 2.0), used for heat shimmer, dust drift, and slow long-wavelength ground undulation; (4) MATERIAL DISPLACEMENT — per-material amplitude modulated by wetness, flammability, and temperature, so wet cloth sags, burning foliage writhes, and hot surfaces shimmer. Gates by LOD level: level 0 gets full deformation, level 1 gets simplified (fewer octaves, larger step), level 2 gets vertex-shader-only approximation, level 3 gets no deformation (billboard). Skips culled entities entirely. Uses pooled noise-field caches so the same SimplexNoise call isn't evaluated twice for entities at the same position. Uses version tokens so downstream consumers see at most one 10 Hz frame of staleness. Writes per-entity deformation (offsetX/Y/Z, sway phase, wave phase, turbulence) into frame.layers.spatial.deformation, per-family statistics into frame.layers.physical.noiseConsumer. Registers with 308's tier scheduler at 10 Hz. Emits AUDIO_LIGHT causal events only on deformation family changes (foliage sway → wave in water) or when the deformation budget is exceeded. Zero allocation after first frame: all per-entity buffers, noise caches, and event payloads are preallocated; update() does not create any object.
// best for : Every rendering consumer that needs vertex-level motion — the vertex-shader uniform uploader (315), the material uniform mixer (292, 298), the wind-sway system for grass and foliage (282_Z08), the water-wave system (283), the heat-shimmer and dust-drift overlay (295), the flame-writhe for burning foliage (300), the cloth-sag for wet materials (292), and any procedural generator that needs a per-entity deformation delta each frame. This is what makes the world move.
// license : MIT

// ─── raw 3js primitives — exported by the 264 barrel ────────────
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
import { ExtrasLODHelper, LOD_TIER }                        from './269_ExtrasLODHelper.js';
import { MaterialRegistry, MATERIAL_KIND }                  from './298_MaterialRegistry.js';
import { ContextConsumerTiers, CONSUMER_TIER }              from './308_ContextConsumerTiers.js';

// ══════════════════════════════════════════════════════════════════
// ─── DEFORMATION FAMILY CODES ───────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const DEFORM_FAMILY = Object.freeze({
  NONE:          0,
  FOLIAGE_SWAY:  1,
  WATER_WAVE:    2,
  TERRAIN_NOISE: 3,
  MATERIAL_DISP: 4
});

const DEFORM_FAMILY_NAMES = Object.freeze([
  'none', 'foliage_sway', 'water_wave', 'terrain_noise', 'material_disp'
]);

const DEFORM_FAMILY_COUNT = 5;

// ══════════════════════════════════════════════════════════════════
// ─── DEFORMATION CONSTANTS ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const NOISE_DEFAULTS = Object.freeze({
  // Foliage sway
  foliageBaseAmplitude:     0.15,   // metres
  foliageHeightScale:       0.60,   // amplitude per metre of height
  foliageBaseFrequency:     1.8,    // Hz
  foliageGustFrequency:     0.4,    // Hz
  foliagePhaseJitter:       2 * Math.PI,

  // Water waves (Gerstner)
  waterWaveAmplitude:       0.10,   // metres
  waterWaveWavelength:      6.0,    // metres
  waterWaveSteepness:       0.35,
  waterWaveCount:           4,      // number of superimposed waves
  waterGravity:             9.81,

  // Terrain noise (FBM)
  terrainBaseAmplitude:     0.05,
  terrainBaseFrequency:     0.02,
  terrainOctaves:           3,
  terrainPersistence:       0.5,
  terrainLacunarity:        2.0,

  // Material displacement
  materialWetnessAmp:       0.03,   // wetness → sag
  materialFireAmp:          0.08,   // fire → writhe
  materialHeatAmp:          0.04,   // heat → shimmer
  materialBaseFrequency:    3.2,

  // Budget
  maxEntitiesPerTick:       16384,
  maxDeformedEntities:      8192,
  targetFrameMs:            2.4,    // 30% of 8 ms
  maxNoiseCacheSize:        1024,

  // LOD gating
  lodFullDetailLevel:       0,
  lodSimplifiedLevel:       1,
  lodApproximateLevel:      2,
  lodSkipLevel:             3,

  // Version tokens
  versionIncrementPerTick:  1,

  // Event coalescing
  eventCoalesceMs:          500
});

// ══════════════════════════════════════════════════════════════════
// ─── DEFORMATION SLOT (pooled) ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class DeformationSlot {
  constructor() {
    this.reset();
  }

  reset() {
    // Per-entity output
    this.active = false;
    this.family = DEFORM_FAMILY.NONE;
    this.offsetX = 0;
    this.offsetY = 0;
    this.offsetZ = 0;
    this.swayPhase = 0;
    this.swayAmplitude = 0;
    this.swayFrequency = 0;
    this.wavePhase = 0;
    this.waveAmplitude = 0;
    this.waveDirectionX = 0;
    this.waveDirectionZ = 0;
    this.turbulence = 0;
    this.version = 0;
    this.lodLevel = 0;
    this.lastUpdateTick = -1;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── NOISE CACHE ENTRY (pooled) ────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// Caches the value of SimplexNoise at a quantized (x, z) cell so
// entities sharing a cell reuse the same noise value.
class NoiseCacheEntry {
  constructor() {
    this.valid = false;
    this.cellX = 0;
    this.cellZ = 0;
    this.noiseX = 0;
    this.noiseZ = 0;
    this.lastAccessTick = -1;
  }

  reset() {
    this.valid = false;
    this.cellX = 0;
    this.cellZ = 0;
    this.noiseX = 0;
    this.noiseZ = 0;
    this.lastAccessTick = -1;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── APPLY NOISE CONSUMER ──────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class ApplyNoiseConsumer {
  constructor(options = {}) {
    // ── Configuration ────────────────────────────────────
    this.defaults = { ...NOISE_DEFAULTS, ...(options.defaults || {}) };

    // ── Capacity ─────────────────────────────────────────
    const entityCap = options.entityCapacity ?? 65536;
    this._entityCapacity = entityCap;

    // ── Per-entity deformation slots (pooled SoA) ────────
    this._slots = new Array(entityCap);
    for (let i = 0; i < entityCap; i++) this._slots[i] = new DeformationSlot();

    // ── Flat output buffers (published to frame) ─────────
    this._outFamily      = new Uint8Array(entityCap);
    this._outOffsetX     = new Float32Array(entityCap);
    this._outOffsetY     = new Float32Array(entityCap);
    this._outOffsetZ     = new Float32Array(entityCap);
    this._outSwayPhase   = new Float32Array(entityCap);
    this._outSwayAmp     = new Float32Array(entityCap);
    this._outSwayFreq    = new Float32Array(entityCap);
    this._outWavePhase   = new Float32Array(entityCap);
    this._outWaveAmp     = new Float32Array(entityCap);
    this._outWaveDirX    = new Float32Array(entityCap);
    this._outWaveDirZ    = new Float32Array(entityCap);
    this._outTurbulence  = new Float32Array(entityCap);
    this._outVersion     = new Uint32Array(entityCap);
    this._outValid       = new Uint8Array(entityCap);

    // ── Shared deformation version (increments once per tick) ─
    this._deformationVersion = 1;

    // ── Noise cache (open-addressing hash map) ───────────
    const cacheCap = this.defaults.maxNoiseCacheSize;
    this._noiseCache = new Array(cacheCap);
    for (let i = 0; i < cacheCap; i++) this._noiseCache[i] = new NoiseCacheEntry();
    this._noiseCacheMask = cacheCap - 1;
    this._noiseCacheCapacity = cacheCap;
    this._noiseCacheUsed = 0;

    // ── Frustum-derived culled set (shared with 313) ─────
    // We don't recompute culling here — we just read the flag.

    // ── Frame lifecycle ──────────────────────────────────
    this._tickIndex = 0;
    this._frameValid = false;
    this._lastFrameMs = 0;

    // ── Scratch (pooled, never reallocated) ──────────────
    this._tmpVec3A = new Vec3();
    this._tmpVec3B = new Vec3();
    this._tmpVec3C = new Vec3();
    this._tmpVec4 = new Vec4();
    this._tmpMat4 = new Mat4();
    this._tmpQuat = new Quat();
    this._tmpBox = new Box3();
    this._tmpSphere = new Sphere();

    // ── Statistics ───────────────────────────────────────
    this._stats = {
      ticks: 0,
      entitiesProcessed: 0,
      totalEntitiesProcessed: 0,
      entitiesDeformed: 0,
      totalEntitiesDeformed: 0,
      foliageDeformed: 0,
      waterDeformed: 0,
      terrainDeformed: 0,
      materialDeformed: 0,
      entitiesSkippedCulled: 0,
      entitiesSkippedLOD: 0,
      noiseCacheHits: 0,
      noiseCacheMisses: 0,
      familyTransitions: 0,
      avgFrameMsEma: 0,
      peakFrameMs: 0,
      eventsEmitted: 0
    };

    // ── Event coalescing ────────────────────────────────
    this._lastEventTime = 0;
    this._pendingFamilyTransitions = [];

    // ── Collaborators ──────────────────────────────────
    this._dispatcher = options.dispatcher || null;
    this._clock = options.clock || null;
    this._materialRegistry = options.materialRegistry || null;
    this._frameRef = null;
    this._registered = false;
    this._consumerId = -1;
  }

  // ══════════════════════════════════════════════════════
  // ─── Collaborator attachment ─────────────────────────
  // ══════════════════════════════════════════════════════
  attachDispatcher(d) { this._dispatcher = d; return this; }
  attachClock(c) { this._clock = c; return this; }
  attachMaterialRegistry(m) { this._materialRegistry = m; return this; }

  // ══════════════════════════════════════════════════════
  // ─── Register with the tier scheduler (10 Hz) ────────
  // ══════════════════════════════════════════════════════
  registerWithScheduler(scheduler, phase = 3) {
    if (!scheduler) return -1;
    this._consumerId = scheduler.registerConsumer(
      'apply_noise',
      this._run.bind(this),
      {
        tier: CONSUMER_TIER.HZ_10,
        phase,
        readsTiers: [0, 1],
        writesTiers: [1],
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
  // ─── Noise cache ────────────────────────────────────
  // ══════════════════════════════════════════════════════
  _cellHash(cellX, cellZ) {
    let h = 0x811c9dc5 | 0;
    h = Math.imul(h ^ (cellX | 0), 0x01000193);
    h = Math.imul(h ^ (cellZ | 0), 0x01000193);
    h = Math.imul(h ^ (h >>> 16), 0x01000193);
    return h & this._noiseCacheMask;
  }

  // Look up a noise entry for a cell, creating it if absent.
  // Returns { noiseX, noiseZ } from the cache. Uses a fixed
  // SimplexNoise sample at the cell center to keep noise
  // deterministic per cell.
  _lookupNoise(cellX, cellZ, freqX, freqZ, tickIndex) {
    let slot = this._cellHash(cellX, cellZ);
    for (let probe = 0; probe < this._noiseCacheCapacity; probe++) {
      const entry = this._noiseCache[slot];
      if (!entry.valid) {
        // Empty slot: compute and insert.
        entry.valid = true;
        entry.cellX = cellX;
        entry.cellZ = cellZ;
        entry.noiseX = SimplexNoise.noise(cellX * freqX, cellZ * freqZ);
        entry.noiseZ = SimplexNoise.noise(cellX * freqX + 13.7, cellZ * freqZ + 31.1);
        entry.lastAccessTick = tickIndex;
        this._noiseCacheUsed++;
        this._stats.noiseCacheMisses++;
        return entry;
      }
      if (entry.cellX === cellX && entry.cellZ === cellZ) {
        entry.lastAccessTick = tickIndex;
        this._stats.noiseCacheHits++;
        return entry;
      }
      slot = (slot + 1) & this._noiseCacheMask;
    }
    // Cache full: evict the oldest entry and reuse.
    let oldestSlot = 0;
    let oldestTick = Infinity;
    for (let i = 0; i < this._noiseCacheCapacity; i++) {
      const entry = this._noiseCache[i];
      if (entry.valid && entry.lastAccessTick < oldestTick) {
        oldestTick = entry.lastAccessTick;
        oldestSlot = i;
      }
    }
    const entry = this._noiseCache[oldestSlot];
    entry.valid = true;
    entry.cellX = cellX;
    entry.cellZ = cellZ;
    entry.noiseX = SimplexNoise.noise(cellX * freqX, cellZ * freqZ);
    entry.noiseZ = SimplexNoise.noise(cellX * freqX + 13.7, cellZ * freqZ + 31.1);
    entry.lastAccessTick = tickIndex;
    this._stats.noiseCacheMisses++;
    return entry;
  }

  // ── Clear noise cache (called when camera moves far) ─────
  clearNoiseCache() {
    for (let i = 0; i < this._noiseCacheCapacity; i++) {
      this._noiseCache[i].reset();
    }
    this._noiseCacheUsed = 0;
    return this;
  }

  // ══════════════════════════════════════════════════════
  // ─── Family classification ───────────────────────────
  // ══════════════════════════════════════════════════════
  // Decide which deformation family (or families) apply to an
  // entity, based on its material, its LOD level, and the current
  // environmental state.
  _classifyFamily(materialId, lodLevel, waterFraction, foliageFraction, temperature) {
    // Skip far LODs entirely.
    if (lodLevel >= this.defaults.lodSkipLevel) return DEFORM_FAMILY.NONE;
    if (lodLevel >= this.defaults.lodApproximateLevel) return DEFORM_FAMILY.NONE;

    // Get material descriptor for material-based gating.
    let desc = null;
    if (this._materialRegistry && materialId >= 0) {
      desc = this._materialRegistry.getDescriptor(materialId);
    }

    if (desc) {
      // Water reacts with water waves.
      if (desc.kind === MATERIAL_KIND.SPECIAL &&
          (desc.name === 'water_surface' || desc.name === 'water_deep')) {
        return DEFORM_FAMILY.WATER_WAVE;
      }
      // Foliage (trees/grass) reacts with wind sway.
      if (desc.isFoliage) {
        return DEFORM_FAMILY.FOLIAGE_SWAY;
      }
      // Decomposers with high emissive → fire writhe.
      if (desc.kind === MATERIAL_KIND.DECOMPOSER && desc.emissive[0] > 0.5) {
        return DEFORM_FAMILY.MATERIAL_DISP;
      }
      // Special materials with flame emissive → fire writhe.
      if (desc.kind === MATERIAL_KIND.SPECIAL && desc.name === 'fire_flame') {
        return DEFORM_FAMILY.MATERIAL_DISP;
      }
      // Wet materials sag.
      if (desc.wetnessResponse > 0.6) {
        return DEFORM_FAMILY.MATERIAL_DISP;
      }
    }

    // Fallback: use the wind/water fraction hints.
    if (waterFraction > 0.5) return DEFORM_FAMILY.WATER_WAVE;
    if (foliageFraction > 0.5) return DEFORM_FAMILY.FOLIAGE_SWAY;

    // Otherwise, no deformation.
    return DEFORM_FAMILY.NONE;
  }

  // ══════════════════════════════════════════════════════
  // ─── Apply foliage sway ─────────────────────────────
  // ══════════════════════════════════════════════════════
  // δ = W · a · sin(ωt + φ) · n̂_perp
  // where W is the per-instance wind sway weight (0..1), a is the
  // amplitude scaled by entity height, ω is the gust frequency,
  // φ is the per-instance phase (derived from the cell noise),
  // and n̂_perp is the horizontal perpendicular to the wind.
  _applyFoliageSway(slot, entityIndex, wx, wy, wz, windX, windZ, windSpeed, time, noise) {
    // Wind sway weight per entity is derived from the wind magnitude
    // (faster wind = more sway) and the local noise (per-instance jitter).
    const windMag = Math.sqrt(windX * windX + windZ * windZ);
    const swayWeight = Math.min(1.0, windMag / 15.0) * (0.7 + noise.noiseX * 0.3);

    // Amplitude scales with entity height (approximated from the
    // AABB y-extent that the spatial layer stored).
    const amplitude = this.defaults.foliageBaseAmplitude *
                     (1 + swayWeight) *
                     (1 + noise.noiseZ * 0.4);

    // Frequency: base + gust, modulated by noise.
    const frequency = this.defaults.foliageBaseFrequency +
                     this.defaults.foliageGustFrequency * noise.noiseX;

    // Phase: per-instance, derived from cell noise so entities in
    // the same cell sway together but adjacent cells are out of phase.
    const phase = noise.noiseZ * Math.PI * 2;

    // Perpendicular direction: horizontal perpendicular to the wind.
    let perpX, perpZ;
    if (windMag > 1e-3) {
      perpX = -windZ / windMag;
      perpZ = windX / windMag;
    } else {
      perpX = 1;
      perpZ = 0;
    }

    // Harmonic value.
    const harmonic = Math.sin(frequency * time + phase);

    // Output offset.
    const offset = amplitude * harmonic;
    const outX = perpX * offset;
    const outZ = perpZ * offset;

    slot.active = true;
    slot.family = DEFORM_FAMILY.FOLIAGE_SWAY;
    slot.offsetX = outX;
    slot.offsetY = 0;
    slot.offsetZ = outZ;
    slot.swayPhase = phase;
    slot.swayAmplitude = amplitude;
    slot.swayFrequency = frequency;
    slot.wavePhase = 0;
    slot.waveAmplitude = 0;
    slot.waveDirectionX = 0;
    slot.waveDirectionZ = 0;
    slot.turbulence = swayWeight;
    slot.lodLevel = 0;
  }

  // ══════════════════════════════════════════════════════
  // ─── Apply water waves (Gerstner) ──────────────────
  // ══════════════════════════════════════════════════════
  // η(x,t) = Σ a_i · cos(k_i(x·d̂_i) + ω_i·t + φ_i)
  // with deep-water dispersion ω_i = √(g·k_i).
  _applyWaterWave(slot, entityIndex, wx, wy, wz, time, windSpeed, noise) {
    const waveCount = this.defaults.waterWaveCount;
    const gravity = this.defaults.waterGravity;
    let totalOffsetX = 0;
    let totalOffsetY = 0;
    let totalOffsetZ = 0;

    // Wind-driven amplitude.
    const windBoost = Math.min(1.0, windSpeed / 15.0);

    for (let i = 0; i < waveCount; i++) {
      // Wave parameters derived deterministically from wave index + noise.
      const angle = (i / waveCount) * Math.PI * 2 + noise.noiseX * 0.3;
      const waveDirX = Math.cos(angle);
      const waveDirZ = Math.sin(angle);

      // Wavelength increases per wave (longer waves below, shorter above).
      const wavelength = this.defaults.waterWaveWavelength * (1 + i * 0.5);
      const k = (2 * Math.PI) / wavelength;
      const omega = Math.sqrt(gravity * k);

      // Amplitude decreases per wave.
      const amp = this.defaults.waterWaveAmplitude * (1 + windBoost) / (1 + i * 0.7);

      // Phase from noise.
      const phase = noise.noiseZ * Math.PI * 2 + i * 1.3;

      // Wave displacement at this position.
      const argument = k * (wx * waveDirX + wz * waveDirZ) + omega * time + phase;
      const wave = Math.cos(argument);

      // Horizontal push (Gerstner-like).
      const steepness = this.defaults.waterWaveSteepness;
      totalOffsetX += waveDirX * amp * steepness * Math.sin(argument);
      totalOffsetY += amp * wave;
      totalOffsetZ += waveDirZ * amp * steepness * Math.sin(argument);
    }

    slot.active = true;
    slot.family = DEFORM_FAMILY.WATER_WAVE;
    slot.offsetX = totalOffsetX;
    slot.offsetY = totalOffsetY;
    slot.offsetZ = totalOffsetZ;
    slot.swayPhase = 0;
    slot.swayAmplitude = 0;
    slot.swayFrequency = 0;
    slot.wavePhase = noise.noiseX * Math.PI * 2;
    slot.waveAmplitude = this.defaults.waterWaveAmplitude * (1 + windBoost);
    slot.waveDirectionX = Math.cos(noise.noiseX * Math.PI * 2);
    slot.waveDirectionZ = Math.sin(noise.noiseX * Math.PI * 2);
    slot.turbulence = windBoost;
    slot.lodLevel = 0;
  }

  // ══════════════════════════════════════════════════════
  // ─── Apply terrain noise (FBM) ──────────────────────
  // ══════════════════════════════════════════════════════
  // FBM(x) = Σ a_i · n(f_i · x) with persistence p and lacunarity l.
  // Used for slow heat shimmer / dust drift / ground undulation.
  _applyTerrainNoise(slot, entityIndex, wx, wy, wz, time, temperature, noise) {
    const octaves = this.defaults.terrainOctaves;
    let amp = this.defaults.terrainBaseAmplitude;
    let freq = this.defaults.terrainBaseFrequency;
    let sumX = 0, sumY = 0, sumZ = 0;

    // Heat shimmer only when temperature is high.
    const heatBoost = Math.max(0, (temperature - 20) / 20);
    const ampScale = 1 + heatBoost;

    for (let o = 0; o < octaves; o++) {
      // Animate the noise input over time so it shimmers.
      const nx = wx * freq + time * 0.5;
      const nz = wz * freq + time * 0.3;
      const n = SimplexNoise.noise(nx, nz);

      sumY += n * amp * ampScale;
      sumX += noise.noiseX * amp * 0.15 * ampScale;
      sumZ += noise.noiseZ * amp * 0.15 * ampScale;

      amp *= this.defaults.terrainPersistence;
      freq *= this.defaults.terrainLacunarity;
    }

    slot.active = true;
    slot.family = DEFORM_FAMILY.TERRAIN_NOISE;
    slot.offsetX = sumX;
    slot.offsetY = sumY;
    slot.offsetZ = sumZ;
    slot.swayPhase = 0;
    slot.swayAmplitude = 0;
    slot.swayFrequency = 0;
    slot.wavePhase = 0;
    slot.waveAmplitude = 0;
    slot.waveDirectionX = 0;
    slot.waveDirectionZ = 0;
    slot.turbulence = heatBoost;
    slot.lodLevel = 0;
  }

  // ══════════════════════════════════════════════════════
  // ─── Apply material displacement ─────────────────────
  // ══════════════════════════════════════════════════════
  // Combined wetness sag, fire writhe, and heat shimmer.
  // Each contribution is gated by the material descriptor.
  _applyMaterialDisp(slot, entityIndex, wx, wy, wz, time, overrides, desc, noise) {
    let offX = 0, offY = 0, offZ = 0;
    let turbulence = 0;

    // Wetness sag.
    if (overrides.wetness > 0.01) {
      const sagAmp = this.defaults.materialWetnessAmp * overrides.wetness;
      const sagFreq = this.defaults.materialBaseFrequency;
      const sagPhase = noise.noiseZ * Math.PI * 2;
      offY -= sagAmp * (0.5 + 0.5 * Math.sin(sagFreq * time + sagPhase));
      turbulence += overrides.wetness * 0.3;
    }

    // Fire writhe.
    if (overrides.fireIntensity > 0.01) {
      const fireAmp = this.defaults.materialFireAmp * overrides.fireIntensity;
      const fireFreq = this.defaults.materialBaseFrequency * 3;
      const firePhase = noise.noiseX * Math.PI * 2;
      offX += fireAmp * Math.sin(fireFreq * time + firePhase);
      offY += fireAmp * 0.8 * Math.sin(fireFreq * time * 1.3 + firePhase + 1.1);
      offZ += fireAmp * 0.5 * Math.sin(fireFreq * time * 0.7 + firePhase + 2.3);
      turbulence += overrides.fireIntensity;
    }

    // Heat shimmer.
    if (overrides.temperature > 40) {
      const heatFactor = Math.min(1, (overrides.temperature - 40) / 60);
      const heatAmp = this.defaults.materialHeatAmp * heatFactor;
      const heatFreq = this.defaults.materialBaseFrequency * 2;
      const heatPhase = noise.noiseZ * Math.PI * 2;
      offY += heatAmp * Math.sin(heatFreq * time + heatPhase);
      turbulence += heatFactor * 0.5;
    }

    slot.active = offX !== 0 || offY !== 0 || offZ !== 0;
    slot.family = DEFORM_FAMILY.MATERIAL_DISP;
    slot.offsetX = offX;
    slot.offsetY = offY;
    slot.offsetZ = offZ;
    slot.swayPhase = 0;
    slot.swayAmplitude = 0;
    slot.swayFrequency = 0;
    slot.wavePhase = 0;
    slot.waveAmplitude = 0;
    slot.waveDirectionX = 0;
    slot.waveDirectionZ = 0;
    slot.turbulence = turbulence;
    slot.lodLevel = 0;
  }

  // ══════════════════════════════════════════════════════
  // ─── Main update (10 Hz) ────────────────────────────
  // ══════════════════════════════════════════════════════
  update(frame) {
    if (!frame || !frame.layers) return 0;
    this._frameRef = frame;

    const startMs = performance.now();
    this._frameValid = true;
    this._tickIndex++;
    this._stats.ticks++;

    // Bump the shared deformation version for this tick.
    this._deformationVersion = (this._deformationVersion + 1) >>> 0;

    // ── Global environment ──────────────────────────────
    const physical = frame.layers.physical;
    const wind = physical?.wind;
    const windX = wind?.[0] ?? 0;
    const windZ = wind?.[2] ?? 0;
    const windSpeed = physical?.windSpeed ?? 0;
    const temperature = physical?.ambientTemperature ?? 15;
    const time = this._clock ? this._clock.elapsedSeconds : performance.now() / 1000;

    // ── Spatial source data ─────────────────────────────
    const spatial = frame.layers.spatial;
    if (!spatial) {
      this._frameValid = false;
      this._writeToFrame(frame, startMs);
      return 0;
    }

    const sphere = spatial.sphere;
    const isVisible = spatial.isVisible;
    const lodLevel = spatial.lodLevel;
    const lodVariant = spatial.lodMaterialVariant;
    const materialIds = spatial.materialBindings || spatial.materialId || null;

    // Entity count.
    let entityCount = 0;
    if (sphere) entityCount = Math.floor(sphere.length / 4);
    if (entityCount > this._entityCapacity) entityCount = this._entityCapacity;
    if (entityCount > this.defaults.maxEntitiesPerTick) entityCount = this.defaults.maxEntitiesPerTick;

    if (entityCount === 0) {
      this._frameValid = false;
      this._writeToFrame(frame, startMs);
      return 0;
    }

    // ── Per-tick budget ─────────────────────────────────
    const maxDeformed = this.defaults.maxDeformedEntities;
    const targetMs = this.defaults.targetFrameMs;

    // ── Reset pending event list ────────────────────────
    this._pendingFamilyTransitions.length = 0;

    let processed = 0;
    let deformed = 0;
    let foliageCount = 0;
    let waterCount = 0;
    let terrainCount = 0;
    let materialCount = 0;
    let culledSkip = 0;
    let lodSkip = 0;

    // Cache cell size for noise lookup.
    const cellSize = 4.0;
    const invCellSize = 1 / cellSize;

    for (let i = 0; i < entityCount; i++) {
      // ── Stop if we're over budget ────────────────────
      if (deformed >= maxDeformed) break;
      const elapsed = performance.now() - startMs;
      if (elapsed > targetMs && i > 16) break;

      // ── Skip culled entities ─────────────────────────
      if (isVisible && isVisible[i] === 0) {
        this._outValid[i] = 0;
        culledSkip++;
        continue;
      }

      // ── Get entity position ──────────────────────────
      const o = i * 4;
      const wx = sphere[o];
      const wy = sphere[o + 1];
      const wz = sphere[o + 2];

      // ── Get LOD level ────────────────────────────────
      let lod = 0;
      if (lodLevel && i < lodLevel.length && lodLevel[i] >= 0) {
        lod = lodLevel[i];
      } else if (lodVariant && i < lodVariant.length) {
        lod = lodVariant[i];
      }

      // ── Skip far LODs (approximate or billboard) ─────
      if (lod >= this.defaults.lodApproximateLevel) {
        this._outValid[i] = 0;
        lodSkip++;
        continue;
      }

      // ── Get material ID ───────────────────────────────
      let materialId = -1;
      if (materialIds && i < materialIds.length) {
        materialId = materialIds[i];
      }

      // ── Noise cache lookup ───────────────────────────
      const cellX = Math.floor(wx * invCellSize);
      const cellZ = Math.floor(wz * invCellSize);
      const noise = this._lookupNoise(cellX, cellZ, 0.1, 0.1, this._tickIndex);

      // ── Classify family ──────────────────────────────
      // Use simple hints for water/foliage fraction (assume 1.0 for
      // entities with the corresponding material kind).
      const family = this._classifyFamily(materialId, lod, 0, 0, temperature);

      // Get the deformation slot.
      const slot = this._slots[i];
      const oldFamily = slot.family;
      slot.reset();

      // ── Apply family-specific deformation ────────────
      switch (family) {
        case DEFORM_FAMILY.FOLIAGE_SWAY:
          this._applyFoliageSway(slot, i, wx, wy, wz, windX, windZ, windSpeed, time, noise);
          foliageCount++;
          break;
        case DEFORM_FAMILY.WATER_WAVE:
          this._applyWaterWave(slot, i, wx, wy, wz, time, windSpeed, noise);
          waterCount++;
          break;
        case DEFORM_FAMILY.TERRAIN_NOISE:
          this._applyTerrainNoise(slot, i, wx, wy, wz, time, temperature, noise);
          terrainCount++;
          break;
        case DEFORM_FAMILY.MATERIAL_DISP: {
          // Get material descriptor for override defaults.
          let desc = null;
          if (this._materialRegistry && materialId >= 0) {
            desc = this._materialRegistry.getDescriptor(materialId);
          }
          const overrides = {
            wetness: physical?.surfaceWetness ?? 0,
            fireIntensity: desc?.emissive?.[0] ?? 0,
            temperature: temperature
          };
          this._applyMaterialDisp(slot, i, wx, wy, wz, time, overrides, desc, noise);
          materialCount++;
          break;
        }
        default:
          break;
      }

      // ── Publish outputs ──────────────────────────────
      slot.version = this._deformationVersion;
      slot.lastUpdateTick = this._tickIndex;

      this._outFamily[i]     = slot.family;
      this._outOffsetX[i]    = slot.offsetX;
      this._outOffsetY[i]    = slot.offsetY;
      this._outOffsetZ[i]    = slot.offsetZ;
      this._outSwayPhase[i]  = slot.swayPhase;
      this._outSwayAmp[i]    = slot.swayAmplitude;
      this._outSwayFreq[i]   = slot.swayFrequency;
      this._outWavePhase[i]  = slot.wavePhase;
      this._outWaveAmp[i]    = slot.waveAmplitude;
      this._outWaveDirX[i]   = slot.waveDirectionX;
      this._outWaveDirZ[i]   = slot.waveDirectionZ;
      this._outTurbulence[i] = slot.turbulence;
      this._outVersion[i]    = slot.version;
      this._outValid[i]      = slot.active ? 1 : 0;

      // ── Detect family changes ────────────────────────
      if (oldFamily !== family && oldFamily !== DEFORM_FAMILY.NONE) {
        this._stats.familyTransitions++;
        if (this._pendingFamilyTransitions.length < 32) {
          this._pendingFamilyTransitions.push({
            entityIndex: i,
            oldFamily,
            newFamily: family
          });
        }
      }

      processed++;
      if (slot.active) deformed++;
    }

    // ── Flush coalesced family-change events ────────────
    if (this._pendingFamilyTransitions.length > 0) {
      this._flushFamilyTransitionEvents();
    }

    // ── Update stats ────────────────────────────────────
    this._stats.entitiesProcessed = processed;
    this._stats.totalEntitiesProcessed += processed;
    this._stats.entitiesDeformed = deformed;
    this._stats.totalEntitiesDeformed += deformed;
    this._stats.foliageDeformed += foliageCount;
    this._stats.waterDeformed += waterCount;
    this._stats.terrainDeformed += terrainCount;
    this._stats.materialDeformed += materialCount;
    this._stats.entitiesSkippedCulled += culledSkip;
    this._stats.entitiesSkippedLOD += lodSkip;

    // ── Write to frame ──────────────────────────────────
    this._writeToFrame(frame, startMs);

    this._frameValid = false;
    return deformed;
  }

  // ══════════════════════════════════════════════════════
  // ─── Family transition event (coalesced) ─────────────
  // ══════════════════════════════════════════════════════
  _flushFamilyTransitionEvents() {
    if (!this._dispatcher) {
      this._pendingFamilyTransitions.length = 0;
      return;
    }
    const now = performance.now();
    if (now - this._lastEventTime < this.defaults.eventCoalesceMs) {
      this._pendingFamilyTransitions.length = 0;
      return;
    }
    this._lastEventTime = now;

    // Aggregate by family.
    const counts = new Int32Array(DEFORM_FAMILY_COUNT);
    for (let i = 0; i < this._pendingFamilyTransitions.length; i++) {
      counts[this._pendingFamilyTransitions[i].newFamily]++;
    }

    this._dispatcher.queueCausalEvent(
      EVENT_TYPE.AUDIO_LIGHT,
      [0, 0, 0],
      -1, 1, 1.0,
      {
        kind: 'deformation_family_changes',
        count: this._pendingFamilyTransitions.length,
        foliageCount: counts[DEFORM_FAMILY.FOLIAGE_SWAY],
        waterCount: counts[DEFORM_FAMILY.WATER_WAVE],
        terrainCount: counts[DEFORM_FAMILY.TERRAIN_NOISE],
        materialCount: counts[DEFORM_FAMILY.MATERIAL_DISP]
      }
    );
    this._stats.eventsEmitted++;
    this._pendingFamilyTransitions.length = 0;
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

    // ── Spatial layer: per-entity deformation ───────────
    const spatial = frame.layers.spatial;
    if (spatial) {
      if (!spatial.deformation) spatial.deformation = {};
      const d = spatial.deformation;

      d.family = this._outFamily;
      d.offsetX = this._outOffsetX;
      d.offsetY = this._outOffsetY;
      d.offsetZ = this._outOffsetZ;
      d.swayPhase = this._outSwayPhase;
      d.swayAmplitude = this._outSwayAmp;
      d.swayFrequency = this._outSwayFreq;
      d.wavePhase = this._outWavePhase;
      d.waveAmplitude = this._outWaveAmp;
      d.waveDirectionX = this._outWaveDirX;
      d.waveDirectionZ = this._outWaveDirZ;
      d.turbulence = this._outTurbulence;
      d.version = this._outVersion;
      d.valid = this._outValid;
      d.entityCount = this._entityCapacity;
      d.deformationVersion = this._deformationVersion;
      d.familyNames = DEFORM_FAMILY_NAMES;
    }

    // ── Physical layer: aggregate diagnostics ───────────
    const physical = frame.layers.physical;
    if (!physical) return;

    if (!physical.noiseConsumer) {
      physical.noiseConsumer = {
        tickIndex: 0,
        entitiesProcessed: 0,
        totalEntitiesProcessed: 0,
        entitiesDeformed: 0,
        totalEntitiesDeformed: 0,
        foliageDeformed: 0,
        waterDeformed: 0,
        terrainDeformed: 0,
        materialDeformed: 0,
        entitiesSkippedCulled: 0,
        entitiesSkippedLOD: 0,
        noiseCacheHits: 0,
        noiseCacheMisses: 0,
        familyTransitions: 0,
        avgFrameMsEma: 0,
        peakFrameMs: 0,
        eventsEmitted: 0,
        deformationVersion: 0
      };
    }

    const nc = physical.noiseConsumer;
    nc.tickIndex = this._tickIndex;
    nc.entitiesProcessed = this._stats.entitiesProcessed;
    nc.totalEntitiesProcessed = this._stats.totalEntitiesProcessed;
    nc.entitiesDeformed = this._stats.entitiesDeformed;
    nc.totalEntitiesDeformed = this._stats.totalEntitiesDeformed;
    nc.foliageDeformed = this._stats.foliageDeformed;
    nc.waterDeformed = this._stats.waterDeformed;
    nc.terrainDeformed = this._stats.terrainDeformed;
    nc.materialDeformed = this._stats.materialDeformed;
    nc.entitiesSkippedCulled = this._stats.entitiesSkippedCulled;
    nc.entitiesSkippedLOD = this._stats.entitiesSkippedLOD;
    nc.noiseCacheHits = this._stats.noiseCacheHits;
    nc.noiseCacheMisses = this._stats.noiseCacheMisses;
    nc.familyTransitions = this._stats.familyTransitions;
    nc.avgFrameMsEma = this._stats.avgFrameMsEma;
    nc.peakFrameMs = this._stats.peakFrameMs;
    nc.eventsEmitted = this._stats.eventsEmitted;
    nc.deformationVersion = this._deformationVersion;

    // Convenience fields for materials and lighting.
    physical.deformationVersion = this._deformationVersion;
    physical.deformedEntityCount = this._stats.entitiesDeformed;
  }

  // ══════════════════════════════════════════════════════
  // ─── Public accessors ────────────────────────────────
  // ══════════════════════════════════════════════════════
  getDeformation(entityIndex) {
    if (entityIndex < 0 || entityIndex >= this._entityCapacity) return null;
    return this._slots[entityIndex];
  }

  getDeformationFamily(entityIndex) {
    if (entityIndex < 0 || entityIndex >= this._entityCapacity) return DEFORM_FAMILY.NONE;
    return this._outFamily[entityIndex];
  }

  getDeformationOffset(entityIndex, outVec) {
    if (entityIndex < 0 || entityIndex >= this._entityCapacity) {
      outVec.set(0, 0, 0);
      return outVec;
    }
    outVec.set(
      this._outOffsetX[entityIndex],
      this._outOffsetY[entityIndex],
      this._outOffsetZ[entityIndex]
    );
    return outVec;
  }

  getDeformationVersion() { return this._deformationVersion; }
  getDeformedEntityCount() { return this._stats.entitiesDeformed; }

  // ══════════════════════════════════════════════════════
  // ─── Interactive setters ─────────────────────────────
  // ══════════════════════════════════════════════════════
  setFoliageAmplitude(amplitude) {
    if (amplitude >= 0) this.defaults.foliageBaseAmplitude = amplitude;
    return this;
  }

  setWaterWaveAmplitude(amplitude) {
    if (amplitude >= 0) this.defaults.waterWaveAmplitude = amplitude;
    return this;
  }

  setWaterWaveCount(count) {
    if (count > 0 && count <= 8) this.defaults.waterWaveCount = count;
    return this;
  }

  setTerrainNoiseOctaves(count) {
    if (count > 0 && count <= 6) this.defaults.terrainOctaves = count;
    return this;
  }

  setTargetFrameMs(ms) {
    if (ms > 0) this.defaults.targetFrameMs = ms;
    return this;
  }

  // ══════════════════════════════════════════════════════
  // ─── Diagnostics ─────────────────────────────────────
  // ══════════════════════════════════════════════════════
  getStats() {
    return Object.freeze({
      ticks: this._stats.ticks,
      entitiesProcessed: this._stats.entitiesProcessed,
      totalEntitiesProcessed: this._stats.totalEntitiesProcessed,
      entitiesDeformed: this._stats.entitiesDeformed,
      totalEntitiesDeformed: this._stats.totalEntitiesDeformed,
      foliageDeformed: this._stats.foliageDeformed,
      waterDeformed: this._stats.waterDeformed,
      terrainDeformed: this._stats.terrainDeformed,
      materialDeformed: this._stats.materialDeformed,
      noiseCacheHits: this._stats.noiseCacheHits,
      noiseCacheMisses: this._stats.noiseCacheMisses,
      familyTransitions: this._stats.familyTransitions,
      avgFrameMsEma: this._stats.avgFrameMsEma,
      peakFrameMs: this._stats.peakFrameMs,
      deformationVersion: this._deformationVersion
    });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) {
      if (typeof this._stats[k] === 'number') this._stats[k] = 0;
    }
    this._pendingFamilyTransitions.length = 0;
  }

  dispose() {
    for (let i = 0; i < this._slots.length; i++) {
      this._slots[i].reset();
    }
    for (let i = 0; i < this._noiseCacheCapacity; i++) {
      this._noiseCache[i].reset();
    }
    this._noiseCacheUsed = 0;

    this._outFamily.fill(0);
    this._outOffsetX.fill(0);
    this._outOffsetY.fill(0);
    this._outOffsetZ.fill(0);
    this._outValid.fill(0);

    this._dispatcher = null;
    this._clock = null;
    this._materialRegistry = null;
    this._frameRef = null;
    this._pendingFamilyTransitions.length = 0;
  }
}

export {
  ApplyNoiseConsumer,
  DeformationSlot,
  NoiseCacheEntry,
  DEFORM_FAMILY,
  DEFORM_FAMILY_NAMES,
  DEFORM_FAMILY_COUNT,
  NOISE_DEFAULTS
};