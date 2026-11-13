// file number : 316
// full path name : src/context/316_EcologyResponseSystem.js
// description : Ecology response system — the 1 Hz fire and vegetation-spread driver that turns causal ignition events into scheduled, physics-motivated fire spread across the living world. Reads IGNITE_CANDIDATE signals from 278_CausalContextProvider, applies the blueprint ignition probability formula p_ign = 1 − exp(−k · F · flam · D(τ)) where F is the impact force, flam is the material flammability, and D(τ) is the causal decay curve, then schedules spread with dr/dt = c · D(τ) · φ_biome where φ_biome is the per-biome flammability weight. Tracks active fires per chunk with per-cell fire intensity in [0,1], suppresses spread on wet (wetness ≥ 0.7) or non-flammable (flam < 0.1) materials, and integrates environmental modifiers so rain extinguishes, wind accelerates spread along the wind direction, and cold temperature slows it. Converts active fires into emissive physical.fireEmissive contributions for the clustered-lighting pass and into render-batch particle spawns for stage six. Uses a pooled active-fire array (fixed capacity 4096) and a per-chunk fire-cell grid so a single forest fire does not allocate per-frame. Emits AUDIO_LIGHT causal events only on fire start, spread to a new cell, or full extinction, so the audio/lighting pipeline does not flood from micro-updates. Registers with 308's tier scheduler at 1 Hz (phase 0). Writes per-chunk fire state into frame.layers.spatial.ecologyFire and per-frame statistics into frame.layers.physical.ecologyResponse.
// best for : Every consumer that needs to know what is burning, how intensely, and where the fire will spread next — the emissive lighting pipeline (fireEmissive contributions), the sensory provider (smoke and warmth cues), the flora and fauna spawners (post-fire regrowth), the persistent world memory (fire scars stored as mutations), and the material uniform uploader (ember emissive boost for burning materials).
// license : MIT

// ─── raw 3js primitives — exported from the 264 barrel ─────────
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere, Box3, Frustum,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems — each from its own file ───────
import { ContextFrame }                                    from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES }    from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS }                   from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD }                     from './267_CoreClock.js';
import { smoothstep }                                       from './268_ExtrasCurveUtils.js';
import { CausalContextProvider, DERIVED_SIGNAL }            from './278_CausalContextProvider.js';
import { MaterialRegistry, MATERIAL_KIND }                  from './298_MaterialRegistry.js';
import { PersistentWorldMemory, MUTATION_TYPE, MUTATION_FLAG }
                                                            from './299_PersistentWorldMemory.js';
import { ContextConsumerTiers, CONSUMER_TIER }              from './308_ContextConsumerTiers.js';

// ══════════════════════════════════════════════════════════════════
// ─── ECOLOGY RESPONSE CONSTANTS ────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const ECOLOGY_DEFAULTS = Object.freeze({
  // Fire capacity
  maxActiveFires:           4096,
  maxFireCellsPerChunk:     64,
  maxChunksTracked:         512,

  // Ignition physics
  ignitionCoefficient:      0.05,      // k in p_ign = 1 - exp(-k·F·flam·D)
  ignitionMinForce:         15.0,
  ignitionBaseChance:       0.05,

  // Spread physics
  spreadCoefficient:        0.35,      // c in dr/dt = c·D(τ)·φ_biome
  spreadRadiusBase:         4.0,       // metres
  spreadRadiusMax:          20.0,
  spreadTimeSeconds:        10.0,      // total spread duration per blueprint

  // Extinguish
  wetnessExtinguishThreshold: 0.7,
  rainExtinguishRate:       0.5,
  baseExtinguishRate:       0.02,
  coldExtinguishTemp:       -5.0,

  // Biome flammability weights (0 = never burns, 1 = extremely flammable)
  biomeFlammability: Object.freeze({
    forest:        1.00,
    grassland:     0.85,
    temperate:     0.70,
    savanna:       0.75,
    taiga:         0.60,
    tropical:      0.55,
    alpine:        0.30,
    tundra:        0.20,
    desert:        0.15,
    freshwater:    0.05,
    marine:        0.00
  }),

  // Wind acceleration
  windSpreadFactor:         0.15,      // per m/s of wind speed
  windDirectionWeight:      0.6,       // 0 = omni, 1 = strictly along wind

  // Fire visual/lighting
  fireEmissivePerIntensity: 3.5,
  fireLightColor:           [1.00, 0.45, 0.10],
  fireLightMaxRadius:       12.0,

  // Event thresholds
  eventCoalesceMs:          1000
});

// ══════════════════════════════════════════════════════════════════
// ─── FIRE CELL STATE ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const FIRE_CELL_FREE     = 0;
const FIRE_CELL_IGNITING = 1;
const FIRE_CELL_BURNING  = 2;
const FIRE_CELL_SMOLDERING = 3;
const FIRE_CELL_EXTINGUISHED = 4;

// ══════════════════════════════════════════════════════════════════
// ─── ACTIVE FIRE SLOT (pooled, flat) ──────────────────────────
// ══════════════════════════════════════════════════════════════════
class ActiveFire {
  constructor() {
    this.active = false;
    this.worldX = 0;
    this.worldY = 0;
    this.worldZ = 0;
    this.chunkX = 0;
    this.chunkZ = 0;
    this.cellIndex = -1;
    this.materialId = -1;
    this.intensity = 0;         // 0..1, current burn intensity
    this.ageSeconds = 0;
    this.spreadRadius = 0;
    this.spreadRadiusMax = 0;
    this.lastSpreadTick = -1;
    this.state = FIRE_CELL_FREE;
    this.durationSeconds = 0;   // total expected burn duration
    this.windX = 0;
    this.windZ = 0;
    this.biomeWeight = 1.0;
    this.cellEmissive = 0;      // accumulated emissive for lighting
  }

  reset() {
    this.active = false;
    this.worldX = 0;
    this.worldY = 0;
    this.worldZ = 0;
    this.chunkX = 0;
    this.chunkZ = 0;
    this.cellIndex = -1;
    this.materialId = -1;
    this.intensity = 0;
    this.ageSeconds = 0;
    this.spreadRadius = 0;
    this.spreadRadiusMax = 0;
    this.lastSpreadTick = -1;
    this.state = FIRE_CELL_FREE;
    this.durationSeconds = 0;
    this.windX = 0;
    this.windZ = 0;
    this.biomeWeight = 1.0;
    this.cellEmissive = 0;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── CHUNK FIRE STATE (pooled) ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class ChunkFireState {
  constructor() {
    this.valid = false;
    this.chunkX = 0;
    this.chunkZ = 0;
    this.fireCellCount = 0;
    this.activeFireCount = 0;
    this.aggregateIntensity = 0;
    this.aggregateEmissive = 0;
    this.peakIntensity = 0;
    this.lastActiveTick = -1;
  }

  reset() {
    this.valid = false;
    this.chunkX = 0;
    this.chunkZ = 0;
    this.fireCellCount = 0;
    this.activeFireCount = 0;
    this.aggregateIntensity = 0;
    this.aggregateEmissive = 0;
    this.peakIntensity = 0;
    this.lastActiveTick = -1;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── ECOLOGY RESPONSE SYSTEM ───────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class EcologyResponseSystem {
  constructor(options = {}) {
    // ── Configuration ────────────────────────────────────
    this.defaults = { ...ECOLOGY_DEFAULTS, ...(options.defaults || {}) };
    this.biomeFlammability = { ...this.defaults.biomeFlammability, ...(options.biomeFlammability || {}) };

    // ── Active fire pool ────────────────────────────────
    const fireCap = this.defaults.maxActiveFires;
    this._firePool = new Array(fireCap);
    for (let i = 0; i < fireCap; i++) this._firePool[i] = new ActiveFire();
    this._fireFreeList = new Int32Array(fireCap);
    for (let i = 0; i < fireCap; i++) this._fireFreeList[i] = fireCap - 1 - i;
    this._fireFreeCount = fireCap;
    this._fireActiveCount = 0;

    // ── Chunk fire state pool ───────────────────────────
    const chunkCap = this.defaults.maxChunksTracked;
    this._chunkPool = new Array(chunkCap);
    for (let i = 0; i < chunkCap; i++) this._chunkPool[i] = new ChunkFireState();
    this._chunkFreeList = new Int32Array(chunkCap);
    for (let i = 0; i < chunkCap; i++) this._chunkFreeList[i] = chunkCap - 1 - i;
    this._chunkFreeCount = chunkCap;
    this._chunkUsed = 0;

    // Open-addressing hash map: packed (chunkX, chunkZ) → chunk index.
    const mapCap = chunkCap * 2;
    this._chunkMap = new Int32Array(mapCap).fill(-1);
    this._chunkMapMask = mapCap - 1;
    this._chunkMapCapacity = mapCap;

    // ── Per-chunk fire cell grid ────────────────────────
    // [chunkCap × maxFireCellsPerChunk] intensities
    const cellCap = this.defaults.maxFireCellsPerChunk;
    this._chunkFireCellIntensity = new Float32Array(chunkCap * cellCap);
    this._chunkFireCellState = new Uint8Array(chunkCap * cellCap);
    this._chunkFireCellMaterial = new Int32Array(chunkCap * cellCap);
    this._chunkFireCellAge = new Float32Array(chunkCap * cellCap);

    // ── Pending ignition queue (from causal events) ─────
    this._pendingIgnitions = [];
    this._pendingIgnitionCapacity = 128;

    // ── Per-chunk output buffers (published to frame) ──
    this._chunkFireActive = new Uint8Array(chunkCap);
    this._chunkFireIntensity = new Float32Array(chunkCap);
    this._chunkFireEmissive = new Float32Array(chunkCap);
    this._chunkFireCellCountArr = new Uint16Array(chunkCap);
    this._chunkCX = new Int32Array(chunkCap);
    this._chunkCZ = new Int32Array(chunkCap);

    // ── Fire light sources for clustered lighting ──────
    this._fireLights = {
      count: 0,
      positions: [],
      colors: [],
      intensities: [],
      radii: []
    };

    // ── Frame lifecycle ─────────────────────────────────
    this._tickIndex = 0;
    this._frameValid = false;
    this._lastFrameMs = 0;

    // ── Scratch (pooled) ────────────────────────────────
    this._tmpVec3A = new Vec3();
    this._tmpVec3B = new Vec3();
    this._tmpVec4 = new Vec4();
    this._tmpMat4 = new Mat4();
    this._tmpQuat = new Quat();

    // ── Statistics ──────────────────────────────────────
    this._stats = {
      ticks: 0,
      firesStarted: 0,
      firesExtinguished: 0,
      cellsIgnited: 0,
      spreadsPerformed: 0,
      spreadSuppressedWet: 0,
      spreadSuppressedCold: 0,
      spreadSuppressedUnflammable: 0,
      rainExtinguished: 0,
      ignitionAttempts: 0,
      ignitionSuccesses: 0,
      activeFireCount: 0,
      avgFrameMsEma: 0,
      peakFrameMs: 0,
      eventsEmitted: 0
    };

    // ── Event coalescing ────────────────────────────────
    this._lastEventTime = 0;
    this._pendingEvents = [];

    // ── Collaborators ───────────────────────────────────
    this._dispatcher = options.dispatcher || null;
    this._clock = options.clock || null;
    this._materialRegistry = options.materialRegistry || null;
    this._worldMemory = options.worldMemory || null;
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
  attachWorldMemory(w) { this._worldMemory = w; return this; }

  // ══════════════════════════════════════════════════════
  // ─── Register with the tier scheduler (1 Hz) ────────
  // ══════════════════════════════════════════════════════
  registerWithScheduler(scheduler, phase = 0) {
    if (!scheduler) return -1;
    this._consumerId = scheduler.registerConsumer(
      'ecology_response',
      this._run.bind(this),
      {
        tier: CONSUMER_TIER.HZ_1,
        phase,
        readsTiers: [0, 1, 2],
        writesTiers: [2],
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
  // ─── Chunk hash map ─────────────────────────────────
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

    // Clear the cell grid for this chunk.
    const cellCap = this.defaults.maxFireCellsPerChunk;
    const base = idx * cellCap;
    for (let i = 0; i < cellCap; i++) {
      this._chunkFireCellIntensity[base + i] = 0;
      this._chunkFireCellState[base + i] = FIRE_CELL_FREE;
      this._chunkFireCellMaterial[base + i] = -1;
      this._chunkFireCellAge[base + i] = 0;
    }

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
    let oldestTick = Infinity;
    for (let i = 0; i < this._chunkPool.length; i++) {
      const c = this._chunkPool[i];
      if (!c.valid) continue;
      if (c.lastActiveTick < oldestTick && c.fireCellCount === 0) {
        oldestTick = c.lastActiveTick;
        oldestIdx = i;
      }
    }
    if (oldestIdx >= 0) {
      const chunk = this._chunkPool[oldestIdx];
      // Find and remove from hash map.
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
  // ─── Fire allocation ────────────────────────────────
  // ══════════════════════════════════════════════════════
  _acquireFire() {
    if (this._fireFreeCount === 0) {
      this._evictOldestFire();
      if (this._fireFreeCount === 0) return null;
    }
    this._fireFreeCount--;
    const idx = this._fireFreeList[this._fireFreeCount];
    const fire = this._firePool[idx];
    fire.reset();
    fire.active = true;
    this._fireActiveCount++;
    return fire;
  }

  _releaseFire(fire) {
    if (!fire) return;
    const idx = this._firePool.indexOf(fire);
    if (idx < 0) return;
    fire.reset();
    this._fireFreeList[this._fireFreeCount++] = idx;
    this._fireActiveCount--;
  }

  _evictOldestFire() {
    let oldestIdx = -1;
    let oldestAge = -1;
    for (let i = 0; i < this._firePool.length; i++) {
      const f = this._firePool[i];
      if (!f.active) continue;
      if (f.ageSeconds > oldestAge) {
        oldestAge = f.ageSeconds;
        oldestIdx = i;
      }
    }
    if (oldestIdx >= 0) {
      const fire = this._firePool[oldestIdx];
      fire.reset();
      this._fireFreeList[this._fireFreeCount++] = oldestIdx;
      this._fireActiveCount--;
    }
  }

  // ══════════════════════════════════════════════════════
  // ─── Biome flammability lookup ──────────────────────
  // ══════════════════════════════════════════════════════
  _biomeFlammability(biomeHint) {
    // biomeHint is BIOME_HINT from 280_TerrainProvider.
    // Map biome hint codes to flammability weights.
    switch (biomeHint) {
      case 1: return this.biomeFlammability.tropical || 0.55;   // TROPICAL
      case 2: return this.biomeFlammability.temperate || 0.70;  // TEMPERATE
      case 3: return this.biomeFlammability.taiga || 0.60;      // TAIGA
      case 4: return this.biomeFlammability.grassland || 0.85;  // GRASSLAND
      case 5: return this.biomeFlammability.desert || 0.15;     // DESERT
      case 6: return this.biomeFlammability.tundra || 0.20;     // TUNDRA
      case 7: return this.biomeFlammability.freshwater || 0.05; // FRESHWATER
      case 8: return this.biomeFlammability.marine || 0.00;     // MARINE
      case 9: return this.biomeFlammability.alpine || 0.30;     // ALPINE
      default: return this.biomeFlammability.temperate || 0.70;
    }
  }

  // ══════════════════════════════════════════════════════
  // ─── Ignition processing ────────────────────────────
  // ══════════════════════════════════════════════════════
  _tryIgnite(worldX, worldY, worldZ, materialId, force, decay, biomeHint, wetness) {
    this._stats.ignitionAttempts++;

    // ── Wetness suppression ─────────────────────────────
    if (wetness >= this.defaults.wetnessExtinguishThreshold) {
      this._stats.spreadSuppressedWet++;
      return false;
    }

    // ── Material flammability gate ─────────────────────
    let flam = 0;
    if (this._materialRegistry && materialId >= 0) {
      const desc = this._materialRegistry.getDescriptor(materialId);
      if (desc) flam = desc.flammability;
    }
    if (flam < 0.1) {
      this._stats.spreadSuppressedUnflammable++;
      return false;
    }

    // ── Force gate ──────────────────────────────────────
    if (force < this.defaults.ignitionMinForce) return false;

    // ── p_ign = 1 - exp(-k · F · flam · D(τ)) ──────────
    const k = this.defaults.ignitionCoefficient;
    const pIgn = 1 - Math.exp(-k * force * flam * decay);

    if (Math.random() > pIgn) return false;

    // ── Ignition accepted ──────────────────────────────
    const fire = this._acquireFire();
    if (!fire) return false;

    fire.worldX = worldX;
    fire.worldY = worldY;
    fire.worldZ = worldZ;
    fire.materialId = materialId;
    fire.intensity = 0.3;
    fire.ageSeconds = 0;
    fire.state = FIRE_CELL_IGNITING;
    fire.biomeWeight = this._biomeFlammability(biomeHint);
    fire.spreadRadiusMax = this.defaults.spreadRadiusBase +
                          this.defaults.spreadRadiusMax * fire.biomeWeight * 0.5;
    fire.spreadRadius = 0;
    fire.durationSeconds = this.defaults.spreadTimeSeconds;

    // Assign to chunk.
    const chunkX = Math.floor(worldX / 1000);
    const chunkZ = Math.floor(worldZ / 1000);
    const chunkIdx = this._chunkInsert(chunkX, chunkZ);
    if (chunkIdx >= 0) {
      const chunk = this._chunkPool[chunkIdx];
      chunk.activeFireCount++;
      chunk.lastActiveTick = this._tickIndex;
      fire.chunkX = chunkX;
      fire.chunkZ = chunkZ;
    }

    this._stats.firesStarted++;
    this._stats.ignitionSuccesses++;

    // ── Emit fire-start event ──────────────────────────
    this._enqueueEvent('fire_started', {
      worldX, worldY, worldZ,
      materialId,
      force,
      pIgn,
      biomeWeight: fire.biomeWeight
    });

    // ── Persist the ignition as a fire-scar mutation ───
    if (this._worldMemory) {
      const localX = worldX - chunkX * 1000;
      const localZ = worldZ - chunkZ * 1000;
      this._worldMemory.recordMutation(chunkX, chunkZ, {
        type: MUTATION_TYPE.FIRE_SCAR,
        flags: MUTATION_FLAG.PERSISTENT | MUTATION_FLAG.BURNED,
        materialId,
        localX,
        localY: worldY,
        localZ,
        scale: 1.0,
        force,
        decay: 30.0
      });
    }

    return true;
  }

  // ══════════════════════════════════════════════════════
  // ─── Fire update: spread, extinguish, evolve ────────
  // ══════════════════════════════════════════════════════
  _updateFires(dt, frame) {
    const physical = frame.layers.physical;
    const wind = physical?.wind;
    const windX = wind?.[0] ?? 0;
    const windZ = wind?.[2] ?? 0;
    const windSpeed = Math.sqrt(windX * windX + windZ * windZ);
    const humidity = physical?.humidity ?? 0.5;
    const wetness = physical?.surfaceWetness ?? 0;
    const temperature = physical?.ambientTemperature ?? 15;
    const precipIntensity = physical?.precipitationIntensity ?? 0;

    // ── Extinguish rate scale ───────────────────────────
    let extinguishScale = 1.0;
    if (precipIntensity > 0.5) {
      extinguishScale += this.defaults.rainExtinguishRate * precipIntensity;
      this._stats.rainExtinguished++;
    }
    if (temperature < this.defaults.coldExtinguishTemp) {
      extinguishScale += 0.5;
      this._stats.spreadSuppressedCold++;
    }

    const spreadWindFactor = 1 + windSpeed * this.defaults.windSpreadFactor;

    // ── Iterate active fires ────────────────────────────
    for (let i = 0; i < this._firePool.length; i++) {
      const fire = this._firePool[i];
      if (!fire.active) continue;

      fire.ageSeconds += dt;

      // ── Intensity evolution ─────────────────────────
      if (fire.state === FIRE_CELL_IGNITING) {
        fire.intensity = Math.min(1, fire.intensity + dt * 2.0);
        if (fire.intensity >= 0.8) fire.state = FIRE_CELL_BURNING;
      } else if (fire.state === FIRE_CELL_BURNING) {
        // Slowly weaken over its duration.
        fire.intensity = Math.max(0.2, fire.intensity - dt * 0.05);
      } else if (fire.state === FIRE_CELL_SMOLDERING) {
        fire.intensity = Math.max(0, fire.intensity - dt * 0.1);
      }

      // ── Spread radius growth ────────────────────────
      // dr/dt = c · D(τ) · φ_biome
      const decayFactor = Math.exp(-fire.ageSeconds / fire.durationSeconds);
      const spreadRate = this.defaults.spreadCoefficient *
                        decayFactor *
                        fire.biomeWeight *
                        spreadWindFactor;
      fire.spreadRadius = Math.min(
        fire.spreadRadiusMax,
        fire.spreadRadius + spreadRate * dt
      );

      // Update wind direction for spread.
      fire.windX = windX;
      fire.windZ = windZ;

      // ── Extinguishing ───────────────────────────────
      const extinguishLoss = this.defaults.baseExtinguishRate * extinguishScale * dt;
      fire.intensity = Math.max(0, fire.intensity - extinguishLoss);

      // Wetness can stop a fire completely.
      if (wetness >= this.defaults.wetnessExtinguishThreshold) {
        fire.intensity = Math.max(0, fire.intensity - dt * 0.5);
      }

      // Cold can weaken.
      if (temperature < 0) {
        fire.intensity = Math.max(0, fire.intensity - dt * 0.1);
      }

      // ── Extinguish or spread ────────────────────────
      if (fire.intensity <= 0.01) {
        // Extinguished.
        fire.active = false;
        this._stats.firesExtinguished++;
        this._enqueueEvent('fire_extinguished', {
          worldX: fire.worldX,
          worldY: fire.worldY,
          worldZ: fire.worldZ
        });
        // Update chunk.
        const chunkIdx = this._chunkLookup(fire.chunkX, fire.chunkZ);
        if (chunkIdx >= 0) {
          const chunk = this._chunkPool[chunkIdx];
          if (chunk.activeFireCount > 0) chunk.activeFireCount--;
        }
        continue;
      }

      // ── Attempt spread ──────────────────────────────
      // Only spread if fire has been burning for >1s and hasn't
      // spread this tick already.
      if (fire.state !== FIRE_CELL_IGNITING && fire.ageSeconds > 1 &&
          this._tickIndex - fire.lastSpreadTick >= 1) {
        fire.lastSpreadTick = this._tickIndex;
        this._attemptSpread(fire, frame);
      }

      // ── Accumulate emissive for lighting ────────────
      fire.cellEmissive = fire.intensity * this.defaults.fireEmissivePerIntensity;

      // Update chunk aggregate.
      const chunkIdx = this._chunkLookup(fire.chunkX, fire.chunkZ);
      if (chunkIdx >= 0) {
        const chunk = this._chunkPool[chunkIdx];
        chunk.aggregateIntensity += fire.intensity;
        chunk.aggregateEmissive += fire.cellEmissive;
        if (fire.intensity > chunk.peakIntensity) chunk.peakIntensity = fire.intensity;
        chunk.lastActiveTick = this._tickIndex;
      }
    }
  }

  // ══════════════════════════════════════════════════════
  // ─── Attempt to spread a fire to an adjacent cell ──
  // ══════════════════════════════════════════════════════
  _attemptSpread(fire, frame) {
    // Sample a random adjacent cell at distance = spreadRadius.
    const angle = Math.random() * Math.PI * 2;
    const spreadDist = fire.spreadRadius * (0.5 + Math.random() * 0.5);
    const nx = fire.worldX + Math.cos(angle) * spreadDist;
    const nz = fire.worldZ + Math.sin(angle) * spreadDist;

    // Bias spread direction by wind.
    if (fire.windX !== 0 || fire.windZ !== 0) {
      const windMag = Math.sqrt(fire.windX * fire.windX + fire.windZ * fire.windZ);
      if (windMag > 0.5) {
        const windDirX = fire.windX / windMag;
        const windDirZ = fire.windZ / windMag;
        const bias = this.defaults.windDirectionWeight;
        const biasedX = fire.worldX + (Math.cos(angle) * (1 - bias) + windDirX * bias) * spreadDist;
        const biasedZ = fire.worldZ + (Math.sin(angle) * (1 - bias) + windDirZ * bias) * spreadDist;

        // Try the biased position.
        this._tryIgnite(
          biasedX, fire.worldY, biasedZ,
          fire.materialId, fire.intensity * 50, 0.5,
          -1,  // biome hint unknown; use default
          frame.layers.physical?.surfaceWetness ?? 0
        );
        this._stats.spreadsPerformed++;
        return;
      }
    }

    // Fall back to unbiased spread.
    this._tryIgnite(
      nx, fire.worldY, nz,
      fire.materialId, fire.intensity * 50, 0.5,
      -1,
      frame.layers.physical?.surfaceWetness ?? 0
    );
    this._stats.spreadsPerformed++;
  }

  // ══════════════════════════════════════════════════════
  // ─── Process causal ignitions from the frame ────────
  // ══════════════════════════════════════════════════════
  _processCausalIgnitions(frame) {
    const causal = frame.layers.causal;
    if (!causal || !causal.derivedSignals) return;

    const ds = causal.derivedSignals;
    const count = ds.count;
    const physical = frame.layers.physical;
    const wetness = physical?.surfaceWetness ?? 0;

    for (let i = 0; i < count; i++) {
      if (ds.types[i] !== DERIVED_SIGNAL.IGNITE_CANDIDATE) continue;

      const force = ds.forces[i];
      const decay = ds.decays[i];
      const materialId = ds.materialIds[i];
      const posX = ds.positions[i * 3];
      const posY = ds.positions[i * 3 + 1];
      const posZ = ds.positions[i * 3 + 2];

      this._tryIgnite(posX, posY, posZ, materialId, force, decay, -1, wetness);
    }
  }

  // ══════════════════════════════════════════════════════
  // ─── Build fire light sources for clustered lighting ─
  // ══════════════════════════════════════════════════════
  _buildFireLights() {
    const lights = this._fireLights;
    lights.count = 0;
    lights.positions.length = 0;
    lights.colors.length = 0;
    lights.intensities.length = 0;
    lights.radii.length = 0;

    const [r, g, b] = this.defaults.fireLightColor;
    for (let i = 0; i < this._firePool.length; i++) {
      const fire = this._firePool[i];
      if (!fire.active) continue;
      if (fire.cellEmissive < 0.05) continue;

      lights.positions.push(fire.worldX, fire.worldY + 0.5, fire.worldZ);
      lights.colors.push(r, g, b);
      lights.intensities.push(fire.cellEmissive);
      lights.radii.push(fire.spreadRadius + this.defaults.fireLightMaxRadius * fire.intensity);
      lights.count++;
    }
  }

  // ══════════════════════════════════════════════════════
  // ─── Event queue ─────────────────────────────────────
  // ══════════════════════════════════════════════════════
  _enqueueEvent(kind, payload) {
    this._pendingEvents.push({ kind, payload });
  }

  _flushEvents() {
    if (!this._dispatcher || this._pendingEvents.length === 0) {
      this._pendingEvents.length = 0;
      return;
    }
    const now = performance.now();
    if (now - this._lastEventTime < this.defaults.eventCoalesceMs) {
      this._pendingEvents.length = 0;
      return;
    }
    this._lastEventTime = now;

    // Aggregate by kind.
    let starts = 0, extinguishes = 0;
    for (let i = 0; i < this._pendingEvents.length; i++) {
      const ev = this._pendingEvents[i];
      if (ev.kind === 'fire_started') starts++;
      else if (ev.kind === 'fire_extinguished') extinguishes++;
    }

    if (starts > 0) {
      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.ECOLOGY,
        [0, 0, 0],
        -1, starts * 10, 5.0,
        { kind: 'fire_batch_started', count: starts }
      );
      this._stats.eventsEmitted++;
    }
    if (extinguishes > 0) {
      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.ECOLOGY,
        [0, 0, 0],
        -1, extinguishes * 5, 3.0,
        { kind: 'fire_batch_extinguished', count: extinguishes }
      );
      this._stats.eventsEmitted++;
    }
    this._pendingEvents.length = 0;
  }

  // ══════════════════════════════════════════════════════
  // ─── Main update (1 Hz) ──────────────────────────────
  // ══════════════════════════════════════════════════════
  update(frame) {
    if (!frame || !frame.layers) return 0;
    this._frameRef = frame;

    const startMs = performance.now();
    this._frameValid = true;
    this._tickIndex++;
    this._stats.ticks++;

    // Clear per-frame chunk aggregates (but keep cells).
    for (let i = 0; i < this._chunkPool.length; i++) {
      const chunk = this._chunkPool[i];
      if (!chunk.valid) continue;
      chunk.aggregateIntensity = 0;
      chunk.aggregateEmissive = 0;
    }

    // ── 1. Process new ignitions from causal events ─────
    this._processCausalIgnitions(frame);

    // ── 2. Update all active fires ──────────────────────
    // dt = 1 second since this runs at 1 Hz.
    this._updateFires(1.0, frame);

    // ── 3. Build fire lights for clustered lighting ─────
    this._buildFireLights();

    // ── 4. Flush coalesced events ───────────────────────
    this._flushEvents();

    // ── 5. Update stats ─────────────────────────────────
    this._stats.activeFireCount = this._fireActiveCount;

    // ── 6. Write to frame ───────────────────────────────
    this._writeToFrame(frame, startMs);

    this._frameValid = false;
    return this._fireActiveCount;
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

    // ── Spatial layer: per-chunk fire state ─────────────
    const spatial = frame.layers.spatial;
    if (spatial) {
      if (!spatial.ecologyFire) {
        spatial.ecologyFire = {
          chunkCount: 0,
          chunkCX: this._chunkCX,
          chunkCZ: this._chunkCZ,
          fireActive: this._chunkFireActive,
          fireIntensity: this._chunkFireIntensity,
          fireEmissive: this._chunkFireEmissive,
          fireCellCount: this._chunkFireCellCountArr,
          activeFireTotal: 0,
          fireLights: this._fireLights
        };
      }

      const ef = spatial.ecologyFire;
      ef.chunkCount = 0;
      for (let i = 0; i < this._chunkPool.length; i++) {
        const chunk = this._chunkPool[i];
        if (!chunk.valid) continue;
        this._chunkCX[ef.chunkCount] = chunk.chunkX;
        this._chunkCZ[ef.chunkCount] = chunk.chunkZ;
        this._chunkFireActive[ef.chunkCount] = chunk.activeFireCount > 0 ? 1 : 0;
        this._chunkFireIntensity[ef.chunkCount] = chunk.aggregateIntensity;
        this._chunkFireEmissive[ef.chunkCount] = chunk.aggregateEmissive;
        this._chunkFireCellCountArr[ef.chunkCount] = chunk.fireCellCount;
        ef.chunkCount++;
      }
      ef.activeFireTotal = this._fireActiveCount;
      ef.fireLights = this._fireLights;
    }

    // ── Physical layer: aggregate diagnostics ──────────
    const physical = frame.layers.physical;
    if (!physical) return;

    // Aggregate emissive across all fires for clustered lighting.
    let totalEmissive = 0;
    let totalIntensity = 0;
    for (let i = 0; i < this._firePool.length; i++) {
      const fire = this._firePool[i];
      if (!fire.active) continue;
      totalEmissive += fire.cellEmissive;
      totalIntensity += fire.intensity;
    }
    physical.fireEmissive = totalEmissive;
    physical.fireTotalIntensity = totalIntensity;
    physical.fireActiveCount = this._fireActiveCount;

    if (!physical.ecologyResponse) {
      physical.ecologyResponse = {
        tickIndex: 0,
        firesStarted: 0,
        firesExtinguished: 0,
        cellsIgnited: 0,
        spreadsPerformed: 0,
        spreadSuppressedWet: 0,
        spreadSuppressedCold: 0,
        spreadSuppressedUnflammable: 0,
        rainExtinguished: 0,
        ignitionAttempts: 0,
        ignitionSuccesses: 0,
        activeFireCount: 0,
        totalFireEmissive: 0,
        avgFrameMsEma: 0,
        peakFrameMs: 0,
        eventsEmitted: 0,
        fireLights: this._fireLights
      };
    }

    const e = physical.ecologyResponse;
    e.tickIndex = this._tickIndex;
    e.firesStarted = this._stats.firesStarted;
    e.firesExtinguished = this._stats.firesExtinguished;
    e.cellsIgnited = this._stats.cellsIgnited;
    e.spreadsPerformed = this._stats.spreadsPerformed;
    e.spreadSuppressedWet = this._stats.spreadSuppressedWet;
    e.spreadSuppressedCold = this._stats.spreadSuppressedCold;
    e.spreadSuppressedUnflammable = this._stats.spreadSuppressedUnflammable;
    e.rainExtinguished = this._stats.rainExtinguished;
    e.ignitionAttempts = this._stats.ignitionAttempts;
    e.ignitionSuccesses = this._stats.ignitionSuccesses;
    e.activeFireCount = this._fireActiveCount;
    e.totalFireEmissive = totalEmissive;
    e.avgFrameMsEma = this._stats.avgFrameMsEma;
    e.peakFrameMs = this._stats.peakFrameMs;
    e.eventsEmitted = this._stats.eventsEmitted;
    e.fireLights = this._fireLights;
  }

  // ══════════════════════════════════════════════════════
  // ─── Public queries ──────────────────────────────────
  // ══════════════════════════════════════════════════════
  getActiveFireCount() { return this._fireActiveCount; }

  getFireLights() { return this._fireLights; }

  getChunkFireState(chunkX, chunkZ) {
    const idx = this._chunkLookup(chunkX, chunkZ);
    if (idx < 0) return null;
    return this._chunkPool[idx];
  }

  // ── Manually ignite at a position (for testing / spells) ─
  igniteAt(worldX, worldY, worldZ, materialId, force = 100, wetness = 0) {
    return this._tryIgnite(worldX, worldY, worldZ, materialId, force, 1.0, -1, wetness);
  }

  // ══════════════════════════════════════════════════════
  // ─── Interactive setters ────────────────────────────
  // ══════════════════════════════════════════════════════
  setIgnitionCoefficient(k) {
    if (k > 0) this.defaults.ignitionCoefficient = k;
    return this;
  }

  setSpreadCoefficient(c) {
    if (c > 0) this.defaults.spreadCoefficient = c;
    return this;
  }

  setSpreadTimeSeconds(s) {
    if (s > 0) this.defaults.spreadTimeSeconds = s;
    return this;
  }

  setBiomeFlammability(biome, weight) {
    if (weight >= 0 && weight <= 1) {
      this.biomeFlammability[biome] = weight;
    }
    return this;
  }

  setFireLightColor(r, g, b) {
    this.defaults.fireLightColor = [r, g, b];
    return this;
  }

  // ══════════════════════════════════════════════════════
  // ─── Diagnostics ─────────────────────────────────────
  // ══════════════════════════════════════════════════════
  getStats() {
    return Object.freeze({
      ticks: this._stats.ticks,
      firesStarted: this._stats.firesStarted,
      firesExtinguished: this._stats.firesExtinguished,
      cellsIgnited: this._stats.cellsIgnited,
      spreadsPerformed: this._stats.spreadsPerformed,
      spreadSuppressedWet: this._stats.spreadSuppressedWet,
      spreadSuppressedCold: this._stats.spreadSuppressedCold,
      spreadSuppressedUnflammable: this._stats.spreadSuppressedUnflammable,
      rainExtinguished: this._stats.rainExtinguished,
      ignitionAttempts: this._stats.ignitionAttempts,
      ignitionSuccesses: this._stats.ignitionSuccesses,
      activeFireCount: this._fireActiveCount,
      avgFrameMsEma: this._stats.avgFrameMsEma,
      peakFrameMs: this._stats.peakFrameMs,
      eventsEmitted: this._stats.eventsEmitted
    });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) {
      if (typeof this._stats[k] === 'number') this._stats[k] = 0;
    }
    this._pendingEvents.length = 0;
  }

  // ── Extinguish all fires immediately ───────────────────
  extinguishAll() {
    for (let i = 0; i < this._firePool.length; i++) {
      const fire = this._firePool[i];
      if (fire.active) {
        fire.active = false;
        fire.intensity = 0;
        fire.cellEmissive = 0;
      }
    }
    this._fireActiveCount = 0;
    this._fireFreeCount = this._firePool.length;
    for (let i = 0; i < this._firePool.length; i++) {
      this._fireFreeList[i] = this._firePool.length - 1 - i;
    }
    return this;
  }

  dispose() {
    for (let i = 0; i < this._firePool.length; i++) {
      this._firePool[i].reset();
    }
    this._fireActiveCount = 0;
    this._fireFreeCount = this._firePool.length;
    for (let i = 0; i < this._firePool.length; i++) {
      this._fireFreeList[i] = this._firePool.length - 1 - i;
    }

    for (let i = 0; i < this._chunkPool.length; i++) {
      this._chunkPool[i].reset();
    }
    this._chunkUsed = 0;
    this._chunkFreeCount = this._chunkPool.length;
    for (let i = 0; i < this._chunkPool.length; i++) {
      this._chunkFreeList[i] = this._chunkPool.length - 1 - i;
    }
    this._chunkMap.fill(-1);

    this._chunkFireCellIntensity.fill(0);
    this._chunkFireCellState.fill(0);
    this._chunkFireCellMaterial.fill(-1);
    this._chunkFireCellAge.fill(0);

    this._fireLights.count = 0;
    this._fireLights.positions.length = 0;
    this._fireLights.colors.length = 0;
    this._fireLights.intensities.length = 0;
    this._fireLights.radii.length = 0;

    this._dispatcher = null;
    this._clock = null;
    this._materialRegistry = null;
    this._worldMemory = null;
    this._frameRef = null;
    this._pendingEvents.length = 0;
    this._pendingIgnitions.length = 0;
  }
}

export {
  EcologyResponseSystem,
  ActiveFire,
  ChunkFireState,
  ECOLOGY_DEFAULTS,
  FIRE_CELL_FREE,
  FIRE_CELL_IGNITING,
  FIRE_CELL_BURNING,
  FIRE_CELL_SMOLDERING,
  FIRE_CELL_EXTINGUISHED
};