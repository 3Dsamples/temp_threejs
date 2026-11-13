// file number : 300
// full path name : src/context/300_ImpactEventCoordinator.js
// description : Impact event coordinator — the five-fan-out resolver that turns a single physical impact (position, material, force, direction, source entity) into up to five independent downstream effects, each gated by material properties, biome context, and the current performance budget: (1) FRACTURE — shard spawning with count n = ⌈(F·B)/s₀⌉ and size s = s₀(F·B)^(−1/3), gated by material hardness/brittleness so glass shatters into many small fragments while water splashes instead; (2) DECAL — crater placement with radius r = r₀(F/F₀)^α(S/S₀)^β, suppressed for glass, water, ice, and very soft materials; (3) PERSISTENCE — record in 299_PersistentWorldMemory exactly when the persistence force ratio P = clamp(F/F_persist, 0, 1) exceeds a per-material threshold, so the world remembers the destruction across sessions; (4) ECOLOGY — ignition probability p_ign = 1 − exp(−k·F·flam·D(τ)) with fire spread scheduled via dr/dt = c·D(τ)·φ_biome, gated by flammability and material wetness; (5) AUDIO/LIGHT — cue emission with amplitude A(t) = A₀·D(τ) and intensity I(t) = I₀·D(τ)·(d₀/d)², capped at max audible distance. Every impact is queued rather than fired immediately, then drained once per frame in a bounded budget so a fireball hitting a forest generates one causal event with fan-out shards, decals, mutations, ignitions, and audio cues — not fifty separate events (blueprint step 16). Performance budget tiers: LOW_END (Snapdragon 4-series) runs only DECAL and PERSISTENCE; MID_RANGE (6-series) runs DECAL, PERSISTENCE, FRACTURE, and AUDIO/LIGHT; FLAGSHIP (7-series+) runs all five. Fracture shards are pooled (256 active shards max), decal requests are pooled (128 active), audio cues are pooled (64 active), so the coordinator allocates nothing per impact after the first frame. Material gating honors the 298_MaterialRegistry's hardness, brittleness, flammability, wetness response, and acoustic profile, and dynamically suppresses fracture/decal/ignition on materials that can't support them. Integrates with 263_ContextFrame, 265_CoreEventDispatcher, 278_CausalContextProvider, 299_PersistentWorldMemory, and 298_MaterialRegistry. Writes per-frame impact state into frame.layers.physical.impacts and frame.layers.spatial.shards.
// best for : Every system that produces or reacts to physical impacts — weapons, explosions, creature attacks, environmental hazards, rockfalls, lightning strikes, vehicle collisions, and any gameplay event that wants the world to physically remember and visually respond. Complements 298_MaterialRegistry (which describes what materials do under stress) and 299_PersistentWorldMemory (which stores the results) by providing the physics-to-effects pipeline in between.
// license : MIT

// ─── raw 3js primitives — exported by the 264 barrel ────────────
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems — each from its own file ────────
import { ContextFrame }                                    from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES }    from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS }                   from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD }                     from './267_CoreClock.js';
import { smoothstep }                                       from './268_ExtrasCurveUtils.js';
import { CausalContextProvider, DERIVED_SIGNAL }            from './278_CausalContextProvider.js';
import { CarveGradientProvider, CARVE_SOURCE, CARVE_MATERIAL_BAND }
                                                            from './282_Z03_CarveGradientProvider.js';
import { ForestGradientProvider, TREE_TYPE }                from './282_Z07_ForestGradientProvider.js';
import { GrassAndFlowresGradientProvider, GRASS_TYPE }      from './282_Z08_GrassAndFlowresGradientProvider.js';
import { MaterialRegistry, MATERIAL_KIND }                  from './298_MaterialRegistry.js';
import { PersistentWorldMemory, MUTATION_TYPE, MUTATION_FLAG, MUTATION_TYPE_NAMES }
                                                            from './299_PersistentWorldMemory.js';

// ══════════════════════════════════════════════════════════════════
// ─── PERFORMANCE BUDGET TIERS ───────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const PERF_TIER = Object.freeze({
  LOW_END:   0,   // Decal + Persistence only
  MID_RANGE: 1,   // Decal + Persistence + Fracture + Audio/Light
  FLAGSHIP:  2    // All five
});

const PERF_TIER_NAMES = Object.freeze(['low_end', 'mid_range', 'flagship']);

// ══════════════════════════════════════════════════════════════════
// ─── IMPACT SOURCE CODES ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const IMPACT_SOURCE = Object.freeze({
  MELEE:        0,
  PROJECTILE:   1,
  EXPLOSION:    2,
  LIGHTNING:    3,
  CREATURE:     4,
  ROCKFALL:     5,
  VEHICLE:      6,
  MAGIC:        7,
  ENVIRONMENT:  8,
  PLAYER:       9
});

const IMPACT_SOURCE_NAMES = Object.freeze([
  'melee', 'projectile', 'explosion', 'lightning', 'creature',
  'rockfall', 'vehicle', 'magic', 'environment', 'player'
]);

// ══════════════════════════════════════════════════════════════════
// ─── QUEUED IMPACT SLOT (pooled) ────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class QueuedImpact {
  constructor() {
    this.active = false;
    this.worldX = 0;
    this.worldY = 0;
    this.worldZ = 0;
    this.dirX = 0;
    this.dirY = 1;
    this.dirZ = 0;
    this.materialId = -1;
    this.force = 0;
    this.source = IMPACT_SOURCE.ENVIRONMENT;
    this.sourceEntityId = -1;
    this.timestamp = 0;
    this.tau = 0.5;
    this.surfaceArea = 1.0;
    this.impactorHardness = 0.5;
  }

  reset() {
    this.active = false;
    this.worldX = 0;
    this.worldY = 0;
    this.worldZ = 0;
    this.dirX = 0;
    this.dirY = 1;
    this.dirZ = 0;
    this.materialId = -1;
    this.force = 0;
    this.source = IMPACT_SOURCE.ENVIRONMENT;
    this.sourceEntityId = -1;
    this.timestamp = 0;
    this.tau = 0.5;
    this.surfaceArea = 1.0;
    this.impactorHardness = 0.5;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── ACTIVE SHARD SLOT (pooled) ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class ActiveShard {
  constructor() {
    this.active = false;
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    this.rotX = 0;
    this.rotY = 0;
    this.rotZ = 0;
    this.angularX = 0;
    this.angularY = 0;
    this.angularZ = 0;
    this.size = 0;
    this.materialId = -1;
    this.lifetime = 0;
    this.age = 0;
    this.sourceImpactId = -1;
  }

  reset() {
    this.active = false;
    this.lifetime = 0;
    this.age = 0;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── ACTIVE DECAL SLOT (pooled) ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class ActiveDecal {
  constructor() {
    this.active = false;
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.normalX = 0;
    this.normalY = 1;
    this.normalZ = 0;
    this.radius = 0;
    this.depth = 0;
    this.materialId = -1;
    this.lifetime = 0;
    this.age = 0;
    this.fade = 1.0;
  }

  reset() {
    this.active = false;
    this.lifetime = 0;
    this.age = 0;
    this.fade = 1.0;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── AUDIO/LIGHT CUE SLOT (pooled) ──────────────────────────────
// ══════════════════════════════════════════════════════════════════
class AudioLightCue {
  constructor() {
    this.active = false;
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.baseAmplitude = 0;
    this.currentAmplitude = 0;
    this.baseIntensity = 0;
    this.currentIntensity = 0;
    this.materialId = -1;
    this.tau = 0.5;
    this.age = 0;
    this.lifetime = 0;
    this.maxDistance = 100;
    this.colorR = 1;
    this.colorG = 0.5;
    this.colorB = 0.2;
    this.cueKind = 0;   // 0 = fracture, 1 = impact, 2 = ignition
  }

  reset() {
    this.active = false;
    this.age = 0;
    this.lifetime = 0;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── IMPACT EVENT COORDINATOR ───────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class ImpactEventCoordinator {
  constructor(options = {}) {
    // ── Configuration ────────────────────────────────────
    this.defaults = {
      worldSeed:               options.worldSeed ?? 0x1A9AC720 | 0,
      perfTier:                options.perfTier ?? PERF_TIER.FLAGSHIP,
      maxQueuedImpacts:        options.maxQueuedImpacts ?? 64,
      maxActiveShards:         options.maxActiveShards ?? 256,
      maxActiveDecals:         options.maxActiveDecals ?? 128,
      maxActiveCues:           options.maxActiveCues ?? 64,
      maxImpactsDrainedPerFrame: options.maxImpactsDrainedPerFrame ?? 8,
      shardLifetimeSeconds:    options.shardLifetimeSeconds ?? 8.0,
      decalLifetimeSeconds:    options.decalLifetimeSeconds ?? 300.0,
      cueLifetimeSeconds:      options.cueLifetimeSeconds ?? 2.0,
      enableAdaptiveTier:      options.enableAdaptiveTier ?? true,
      targetFrameMs:           options.targetFrameMs ?? 8.0,

      // Fracture constants
      fractureBaseShardCount:  6,
      fractureBaseShardSize:   0.15,
      fractureSizeExponent:    1 / 3,
      fractureMaxShards:       24,

      // Decal constants
      decalBaseRadius:         0.25,
      decalForceExponent:      0.5,
      decalAreaExponent:       0.25,
      decalMaxRadius:          1.5,
      decalDepthRatio:         0.3,

      // Persistence constants
      persistenceForceRef:     50.0,
      persistenceThreshold:    0.5,

      // Ecology constants
      ignitionCoefficient:     0.05,
      ignitionMinForce:        25.0,
      ignitionBaseChance:      0.1,

      // Audio/light constants
      audioBaseAmplitude:      1.0,
      lightBaseIntensity:      2.0,
      lightMaxDistance:        60.0,
      lightFalloffRefDistance: 5.0
    };
    this.defaults.worldSeed = this.defaults.worldSeed | 0;

    // ── Scratch objects (pooled, never reallocated) ─────
    this._tmpVec3A = new Vec3();
    this._tmpVec3B = new Vec3();
    this._tmpVec3C = new Vec3();
    this._tmpVec4 = new Vec4();
    this._tmpMat4A = new Mat4();
    this._tmpMat4B = new Mat4();
    this._tmpQuat = new Quat();
    this._tmpPlane = new Plane();

    // ── Queued impacts pool ─────────────────────────────
    this._impactQueue = new Array(this.defaults.maxQueuedImpacts);
    for (let i = 0; i < this.defaults.maxQueuedImpacts; i++) {
      this._impactQueue[i] = new QueuedImpact();
    }
    this._impactQueueCount = 0;
    this._impactQueueHead = 0;

    // ── Active shard pool ───────────────────────────────
    this._shardPool = new Array(this.defaults.maxActiveShards);
    for (let i = 0; i < this.defaults.maxActiveShards; i++) {
      this._shardPool[i] = new ActiveShard();
    }
    this._shardActiveCount = 0;
    this._shardFreeList = new Int32Array(this.defaults.maxActiveShards);
    this._shardFreeCount = this.defaults.maxActiveShards;
    for (let i = 0; i < this.defaults.maxActiveShards; i++) {
      this._shardFreeList[i] = this.defaults.maxActiveShards - 1 - i;
    }

    // ── Active decal pool ───────────────────────────────
    this._decalPool = new Array(this.defaults.maxActiveDecals);
    for (let i = 0; i < this.defaults.maxActiveDecals; i++) {
      this._decalPool[i] = new ActiveDecal();
    }
    this._decalActiveCount = 0;
    this._decalFreeList = new Int32Array(this.defaults.maxActiveDecals);
    this._decalFreeCount = this.defaults.maxActiveDecals;
    for (let i = 0; i < this.defaults.maxActiveDecals; i++) {
      this._decalFreeList[i] = this.defaults.maxActiveDecals - 1 - i;
    }

    // ── Active cue pool ─────────────────────────────────
    this._cuePool = new Array(this.defaults.maxActiveCues);
    for (let i = 0; i < this.defaults.maxActiveCues; i++) {
      this._cuePool[i] = new AudioLightCue();
    }
    this._cueActiveCount = 0;
    this._cueFreeList = new Int32Array(this.defaults.maxActiveCues);
    this._cueFreeCount = this.defaults.maxActiveCues;
    for (let i = 0; i < this.defaults.maxActiveCues; i++) {
      this._cueFreeList[i] = this.defaults.maxActiveCues - 1 - i;
    }

    // ── Per-entity ignition queue (for ecology system) ──
    this._ignitionQueueCapacity = 128;
    this._ignitionQueueX = new Float32Array(this._ignitionQueueCapacity);
    this._ignitionQueueY = new Float32Array(this._ignitionQueueCapacity);
    this._ignitionQueueZ = new Float32Array(this._ignitionQueueCapacity);
    this._ignitionQueueMaterial = new Int32Array(this._ignitionQueueCapacity);
    this._ignitionQueueForce = new Float32Array(this._ignitionQueueCapacity);
    this._ignitionQueueCount = 0;

    // ── Per-frame stats (resettable) ────────────────────
    this._stats = {
      impactsQueued: 0,
      impactsDrained: 0,
      totalImpacts: 0,
      fractureEvents: 0,
      totalShardsSpawned: 0,
      decalEvents: 0,
      totalDecalsPlaced: 0,
      persistenceEvents: 0,
      totalMutationsRecorded: 0,
      ecologyEvents: 0,
      totalIgnitionsQueued: 0,
      audioLightEvents: 0,
      totalCuesSpawned: 0,
      suppressedByMaterial: 0,
      suppressedByBudget: 0,
      shardEvictions: 0,
      decalEvictions: 0,
      cueEvictions: 0,
      tierDowngrades: 0,
      tierUpgrades: 0
    };

    // ── Adaptive tier state ─────────────────────────────
    this._currentTier = this.defaults.perfTier;
    this._frameMsAccumulator = 0;
    this._frameMsSamples = 0;
    this._lastTierCheck = 0;

    // ── Reusable outputs (per drained impact) ──────────
    this._impactsThisFrame = 0;

    // ── Collaborators ──────────────────────────────────
    this._dispatcher = options.dispatcher || null;
    this._clock = options.clock || null;
    this._materials = options.materials || null;
    this._worldMemory = options.worldMemory || null;

    // ── Frame reference ────────────────────────────────
    this._frameRef = null;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachDispatcher(d) { this._dispatcher = d; return this; }
  attachClock(c) { this._clock = c; return this; }
  attachMaterials(m) { this._materials = m; return this; }
  attachWorldMemory(w) { this._worldMemory = w; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── Queue an impact (zero allocation) ──────────────────
  // ══════════════════════════════════════════════════════════
  // Impact sources call this with full data. The impact is stored
  // in the next free slot in the ring queue and drained on the next
  // update() call.
  queueImpact(impact) {
    if (this._impactQueueCount >= this.defaults.maxQueuedImpacts) {
      // Overflow: drop the oldest impact.
      this._impactQueueHead = (this._impactQueueHead + 1) % this.defaults.maxQueuedImpacts;
      this._impactQueueCount--;
    }

    const slotIdx = (this._impactQueueHead + this._impactQueueCount) % this.defaults.maxQueuedImpacts;
    const slot = this._impactQueue[slotIdx];

    slot.active = true;
    slot.worldX = impact.worldX ?? 0;
    slot.worldY = impact.worldY ?? 0;
    slot.worldZ = impact.worldZ ?? 0;
    slot.dirX = impact.dirX ?? 0;
    slot.dirY = impact.dirY ?? 1;
    slot.dirZ = impact.dirZ ?? 0;
    slot.materialId = impact.materialId ?? -1;
    slot.force = impact.force ?? 0;
    slot.source = impact.source ?? IMPACT_SOURCE.ENVIRONMENT;
    slot.sourceEntityId = impact.sourceEntityId ?? -1;
    slot.timestamp = this._clock ? this._clock.elapsedSeconds : performance.now() / 1000;
    slot.tau = impact.tau ?? 0.5;
    slot.surfaceArea = impact.surfaceArea ?? 1.0;
    slot.impactorHardness = impact.impactorHardness ?? 0.5;

    this._impactQueueCount++;
    this._stats.impactsQueued++;
    this._stats.totalImpacts++;

    return slot;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Pooled shard allocation ────────────────────────────
  // ══════════════════════════════════════════════════════════
  _acquireShard() {
    if (this._shardFreeCount === 0) {
      // Pool exhausted: evict the oldest active shard.
      this._evictOldestShard();
      if (this._shardFreeCount === 0) {
        this._stats.shardEvictions++;
        return null;
      }
    }
    this._shardFreeCount--;
    const idx = this._shardFreeList[this._shardFreeCount];
    const shard = this._shardPool[idx];
    shard.reset();
    shard.active = true;
    this._shardActiveCount++;
    return shard;
  }

  _releaseShard(shard) {
    if (!shard || !shard.active) return;
    const idx = this._shardPool.indexOf(shard);
    if (idx < 0) return;
    shard.reset();
    this._shardFreeList[this._shardFreeCount++] = idx;
    this._shardActiveCount--;
  }

  _evictOldestShard() {
    let oldestIdx = -1;
    let oldestAge = -1;
    for (let i = 0; i < this._shardPool.length; i++) {
      const s = this._shardPool[i];
      if (!s.active) continue;
      if (s.age > oldestAge) {
        oldestAge = s.age;
        oldestIdx = i;
      }
    }
    if (oldestIdx >= 0) {
      const shard = this._shardPool[oldestIdx];
      shard.reset();
      this._shardFreeList[this._shardFreeCount++] = oldestIdx;
      this._shardActiveCount--;
      this._stats.shardEvictions++;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Pooled decal allocation ────────────────────────────
  // ══════════════════════════════════════════════════════════
  _acquireDecal() {
    if (this._decalFreeCount === 0) {
      this._evictOldestDecal();
      if (this._decalFreeCount === 0) {
        this._stats.decalEvictions++;
        return null;
      }
    }
    this._decalFreeCount--;
    const idx = this._decalFreeList[this._decalFreeCount];
    const decal = this._decalPool[idx];
    decal.reset();
    decal.active = true;
    this._decalActiveCount++;
    return decal;
  }

  _releaseDecal(decal) {
    if (!decal || !decal.active) return;
    const idx = this._decalPool.indexOf(decal);
    if (idx < 0) return;
    decal.reset();
    this._decalFreeList[this._decalFreeCount++] = idx;
    this._decalActiveCount--;
  }

  _evictOldestDecal() {
    let oldestIdx = -1;
    let oldestAge = -1;
    for (let i = 0; i < this._decalPool.length; i++) {
      const d = this._decalPool[i];
      if (!d.active) continue;
      if (d.age > oldestAge) {
        oldestAge = d.age;
        oldestIdx = i;
      }
    }
    if (oldestIdx >= 0) {
      const decal = this._decalPool[oldestIdx];
      decal.reset();
      this._decalFreeList[this._decalFreeCount++] = oldestIdx;
      this._decalActiveCount--;
      this._stats.decalEvictions++;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Pooled cue allocation ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  _acquireCue() {
    if (this._cueFreeCount === 0) {
      this._evictOldestCue();
      if (this._cueFreeCount === 0) {
        this._stats.cueEvictions++;
        return null;
      }
    }
    this._cueFreeCount--;
    const idx = this._cueFreeList[this._cueFreeCount];
    const cue = this._cuePool[idx];
    cue.reset();
    cue.active = true;
    this._cueActiveCount++;
    return cue;
  }

  _releaseCue(cue) {
    if (!cue || !cue.active) return;
    const idx = this._cuePool.indexOf(cue);
    if (idx < 0) return;
    cue.reset();
    this._cueFreeList[this._cueFreeCount++] = idx;
    this._cueActiveCount--;
  }

  _evictOldestCue() {
    let oldestIdx = -1;
    let oldestAge = -1;
    for (let i = 0; i < this._cuePool.length; i++) {
      const c = this._cuePool[i];
      if (!c.active) continue;
      if (c.age > oldestAge) {
        oldestAge = c.age;
        oldestIdx = i;
      }
    }
    if (oldestIdx >= 0) {
      const cue = this._cuePool[oldestIdx];
      cue.reset();
      this._cueFreeList[this._cueFreeCount++] = oldestIdx;
      this._cueActiveCount--;
      this._stats.cueEvictions++;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Material gating helpers ────────────────────────────
  // ══════════════════════════════════════════════════════════
  _canFracture(materialId) {
    if (!this._materials) return true;
    const desc = this._materials.getDescriptor(materialId);
    if (!desc) return false;
    // Only fracture materials with sufficient hardness/brittleness.
    // Water, smoke, fire, and very soft organics don't fracture.
    if (desc.kind === MATERIAL_KIND.SPECIAL) {
      // Check specific special materials.
      if (desc.name === 'water_surface' ||
          desc.name === 'water_deep' ||
          desc.name === 'smoke' ||
          desc.name === 'fire_flame' ||
          desc.name === 'blood') {
        return false;
      }
    }
    if (desc.kind === MATERIAL_KIND.GROUNDWATER) return false;
    if (desc.hardness < 0.15 && desc.brittleness < 0.4) return false;
    return true;
  }

  _canDecal(materialId) {
    if (!this._materials) return true;
    const desc = this._materials.getDescriptor(materialId);
    if (!desc) return false;
    // Suppress decals on glass, water, ice, and very reflective surfaces.
    if (desc.kind === MATERIAL_KIND.SPECIAL) {
      if (desc.name === 'water_surface' ||
          desc.name === 'water_deep' ||
          desc.name === 'glass' ||
          desc.name === 'ice_clear' ||
          desc.name === 'fire_flame' ||
          desc.name === 'smoke') {
        return false;
      }
    }
    return true;
  }

  _canPersist(materialId) {
    // Persistence is allowed for almost all materials except
    // transient ones (fire, smoke, blood).
    if (!this._materials) return true;
    const desc = this._materials.getDescriptor(materialId);
    if (!desc) return false;
    if (desc.kind === MATERIAL_KIND.SPECIAL) {
      if (desc.name === 'fire_flame' ||
          desc.name === 'smoke' ||
          desc.name === 'blood') {
        return false;
      }
    }
    return true;
  }

  _canIgnite(materialId, wetness = 0) {
    if (!this._materials) return false;
    const desc = this._materials.getDescriptor(materialId);
    if (!desc) return false;
    const flam = desc.flammability;
    // Wetness suppresses ignition.
    const effectiveFlam = flam * (1 - wetness * 0.9);
    return effectiveFlam > 0.1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── FRACTURE effect ────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _applyFracture(impact, tierAllows) {
    if (!tierAllows) return 0;
    if (!this._canFracture(impact.materialId)) {
      this._stats.suppressedByMaterial++;
      return 0;
    }

    const desc = this._materials ? this._materials.getDescriptor(impact.materialId) : null;
    if (!desc) return 0;

    // Shard count: n = ceil((F·B) / s₀)
    const FB = impact.force * desc.brittleness;
    let shardCount = Math.ceil(FB / this.defaults.fractureBaseShardCount);
    shardCount = Math.min(shardCount, this.defaults.fractureMaxShards);
    if (shardCount <= 0) return 0;

    // Shard size: s = s₀·(F·B)^(-1/3)
    const shardSize = this.defaults.fractureBaseShardSize *
                      Math.pow(Math.max(0.1, FB), -this.defaults.fractureSizeExponent);

    // Spawn shards with initial velocity radiating from impact direction.
    let spawned = 0;
    for (let i = 0; i < shardCount; i++) {
      const shard = this._acquireShard();
      if (!shard) break;

      // Distribute around impact direction.
      const angle = (i / shardCount) * Math.PI * 2;
      const spreadX = Math.cos(angle) * 0.5;
      const spreadZ = Math.sin(angle) * 0.5;

      shard.x = impact.worldX;
      shard.y = impact.worldY;
      shard.z = impact.worldZ;
      shard.vx = (impact.dirX * 3 + spreadX) * Math.min(1, impact.force * 0.05);
      shard.vy = (impact.dirY * 3 + 2.0) * Math.min(1, impact.force * 0.05);
      shard.vz = (impact.dirZ * 3 + spreadZ) * Math.min(1, impact.force * 0.05);
      shard.rotX = angle;
      shard.rotY = angle * 0.5;
      shard.rotZ = angle * 0.25;
      shard.angularX = (Math.random() - 0.5) * 15;
      shard.angularY = (Math.random() - 0.5) * 15;
      shard.angularZ = (Math.random() - 0.5) * 15;
      shard.size = shardSize * (0.7 + Math.random() * 0.6);
      shard.materialId = impact.materialId;
      shard.lifetime = this.defaults.shardLifetimeSeconds;
      shard.age = 0;
      shard.sourceImpactId = impact.sourceEntityId;
      spawned++;
    }

    this._stats.fractureEvents++;
    this._stats.totalShardsSpawned += spawned;
    return spawned;
  }

  // ══════════════════════════════════════════════════════════
  // ─── DECAL effect ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _applyDecal(impact, tierAllows) {
    if (!tierAllows) return 0;
    if (!this._canDecal(impact.materialId)) {
      this._stats.suppressedByMaterial++;
      return 0;
    }

    const desc = this._materials ? this._materials.getDescriptor(impact.materialId) : null;
    if (!desc) return 0;

    // Radius: r = r₀·(F/F₀)^α·(S/S₀)^β
    const forceTerm = Math.pow(impact.force / 50.0, this.defaults.decalForceExponent);
    const areaTerm = Math.pow(impact.surfaceArea / 1.0, this.defaults.decalAreaExponent);
    let radius = this.defaults.decalBaseRadius * forceTerm * areaTerm;
    radius = Math.min(radius, this.defaults.decalMaxRadius);

    if (radius < 0.02) return 0;

    // Depth: d = r · depthRatio · hardness
    const depth = radius * this.defaults.decalDepthRatio * desc.hardness;

    const decal = this._acquireDecal();
    if (!decal) return 0;

    decal.x = impact.worldX;
    decal.y = impact.worldY;
    decal.z = impact.worldZ;
    decal.normalX = impact.dirX;
    decal.normalY = impact.dirY;
    decal.normalZ = impact.dirZ;
    decal.radius = radius;
    decal.depth = depth;
    decal.materialId = impact.materialId;
    decal.lifetime = this.defaults.decalLifetimeSeconds;
    decal.age = 0;
    decal.fade = 1.0;

    this._stats.decalEvents++;
    this._stats.totalDecalsPlaced++;
    return 1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── PERSISTENCE effect ─────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _applyPersistence(impact, tierAllows) {
    if (!tierAllows) return 0;
    if (!this._canPersist(impact.materialId)) return 0;
    if (!this._worldMemory) return 0;

    // P = clamp(F/F_persist, 0, 1)
    const P = Math.min(1, Math.max(0, impact.force / this.defaults.persistenceForceRef));
    if (P <= this.defaults.persistenceThreshold) return 0;

    // Determine mutation type from impact source.
    let mutationType = MUTATION_TYPE.TERRAIN_CARVED;
    let flags = MUTATION_FLAG.PERSISTENT;

    switch (impact.source) {
      case IMPACT_SOURCE.EXPLOSION:
        mutationType = MUTATION_TYPE.TERRAIN_CARVED;
        break;
      case IMPACT_SOURCE.MELEE:
      case IMPACT_SOURCE.PROJECTILE:
        mutationType = MUTATION_TYPE.DECAL_PLACED;
        break;
      case IMPACT_SOURCE.LIGHTNING:
        mutationType = MUTATION_TYPE.FIRE_SCAR;
        flags |= MUTATION_FLAG.BURNED;
        break;
      case IMPACT_SOURCE.PLAYER:
        mutationType = MUTATION_TYPE.RESOURCE_TAKEN;
        flags |= MUTATION_FLAG.PLAYER_CAUSED;
        break;
      case IMPACT_SOURCE.CREATURE:
        mutationType = MUTATION_TYPE.BODY_DECAYED;
        break;
      default:
        mutationType = MUTATION_TYPE.TERRAIN_CARVED;
    }

    // Compute local chunk coordinates.
    const chunkSize = this._worldMemory.defaults.chunkSize;
    const chunkX = Math.floor(impact.worldX / chunkSize);
    const chunkZ = Math.floor(impact.worldZ / chunkSize);
    const localX = impact.worldX - chunkX * chunkSize;
    const localZ = impact.worldZ - chunkZ * chunkSize;

    const handle = this._worldMemory.recordMutation(chunkX, chunkZ, {
      type: mutationType,
      flags,
      materialId: impact.materialId,
      entityId: impact.sourceEntityId,
      localX,
      localY: impact.worldY,
      localZ,
      scale: P,
      yaw: Math.atan2(impact.dirX, impact.dirZ),
      force: impact.force,
      decay: impact.tau,
      payload: impact.source,
      seed: (impact.worldX * 73856093) ^ (impact.worldZ * 19349663)
    });

    if (handle >= 0) {
      this._stats.persistenceEvents++;
      this._stats.totalMutationsRecorded++;
      return 1;
    }
    return 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── ECOLOGY effect ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _applyEcology(impact, tierAllows) {
    if (!tierAllows) return 0;
    if (impact.force < this.defaults.ignitionMinForce) return 0;

    const desc = this._materials ? this._materials.getDescriptor(impact.materialId) : null;
    if (!desc) return 0;

    // Wetness from the current frame if available.
    let wetness = 0;
    if (this._frameRef) {
      const physical = this._frameRef.layers.physical;
      wetness = physical?.surfaceWetness ?? 0;
    }

    if (!this._canIgnite(impact.materialId, wetness)) return 0;

    // p_ign = 1 - exp(-k · F · flam · D(τ))
    // At the moment of impact, D(τ) = 1 (fresh event).
    const effFlam = desc.flammability * (1 - wetness * 0.9);
    const pIgn = 1 - Math.exp(-this.defaults.ignitionCoefficient *
                              impact.force * effFlam);
    if (pIgn <= this.defaults.ignitionBaseChance * Math.random()) return 0;

    // Queue ignition for ecology response system.
    if (this._ignitionQueueCount < this._ignitionQueueCapacity) {
      const idx = this._ignitionQueueCount++;
      this._ignitionQueueX[idx] = impact.worldX;
      this._ignitionQueueY[idx] = impact.worldY;
      this._ignitionQueueZ[idx] = impact.worldZ;
      this._ignitionQueueMaterial[idx] = impact.materialId;
      this._ignitionQueueForce[idx] = impact.force * effFlam;
    }

    // Emit a causal event for ecology.
    if (this._dispatcher) {
      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.ECOLOGY,
        [impact.worldX, impact.worldY, impact.worldZ],
        impact.materialId,
        impact.force * effFlam,
        impact.tau * 2,
        {
          kind: 'impact_ignition',
          force: impact.force,
          flammability: desc.flammability,
          wetness,
          source: impact.source,
          sourceEntityId: impact.sourceEntityId
        }
      );
    }

    this._stats.ecologyEvents++;
    this._stats.totalIgnitionsQueued++;
    return 1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── AUDIO / LIGHT effect ───────────────────────────────
  // ══════════════════════════════════════════════════════════
  _applyAudioLight(impact, tierAllows) {
    if (!tierAllows) return 0;

    const desc = this._materials ? this._materials.getDescriptor(impact.materialId) : null;

    const cue = this._acquireCue();
    if (!cue) return 0;

    // Amplitude A₀ = baseAmplitude · force · material acoustic weight
    const acousticWeight = desc ? desc.acousticProfile[3] ?? 0.5 : 0.5;
    const amplitude = this.defaults.audioBaseAmplitude *
                     Math.min(2.0, impact.force / 30.0) *
                     acousticWeight;

    // Intensity I₀ = baseIntensity · force
    const intensity = this.defaults.lightBaseIntensity *
                     Math.min(3.0, impact.force / 25.0);

    // Colour: warm orange for impacts; adjust for material.
    let colorR = 1.0, colorG = 0.55, colorB = 0.20;
    if (desc) {
      if (desc.name && desc.name.startsWith('metal_')) {
        colorR = 1.0; colorG = 0.85; colorB = 0.30;
      } else if (desc.name && desc.name.startsWith('fire_')) {
        colorR = 1.0; colorG = 0.35; colorB = 0.05;
      } else if (desc.name === 'water_surface' || desc.name === 'water_deep') {
        colorR = 0.30; colorG = 0.65; colorB = 0.95;
      } else if (desc.name === 'ice_clear' || desc.name === 'snow_pack') {
        colorR = 0.75; colorG = 0.90; colorB = 1.0;
      }
    }

    cue.x = impact.worldX;
    cue.y = impact.worldY;
    cue.z = impact.worldZ;
    cue.baseAmplitude = amplitude;
    cue.currentAmplitude = amplitude;
    cue.baseIntensity = intensity;
    cue.currentIntensity = intensity;
    cue.materialId = impact.materialId;
    cue.tau = impact.tau;
    cue.age = 0;
    cue.lifetime = this.defaults.cueLifetimeSeconds;
    cue.maxDistance = this.defaults.lightMaxDistance;
    cue.colorR = colorR;
    cue.colorG = colorG;
    cue.colorB = colorB;
    cue.cueKind = impact.force > 30 ? 1 : 0;

    // Emit causal event for audio/lighting systems.
    if (this._dispatcher) {
      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.AUDIO_LIGHT,
        [impact.worldX, impact.worldY, impact.worldZ],
        impact.materialId,
        impact.force,
        impact.tau,
        {
          kind: 'impact_audio_light',
          amplitude,
          intensity,
          colorR,
          colorG,
          colorB,
          source: impact.source,
          sourceEntityId: impact.sourceEntityId
        }
      );
    }

    this._stats.audioLightEvents++;
    this._stats.totalCuesSpawned++;
    return 1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Tier gating helpers ────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _tierAllowsFracture(tier) {
    return tier >= PERF_TIER.MID_RANGE;
  }

  _tierAllowsDecal(tier) {
    return tier >= PERF_TIER.LOW_END;
  }

  _tierAllowsPersistence(tier) {
    return tier >= PERF_TIER.LOW_END;
  }

  _tierAllowsEcology(tier) {
    return tier >= PERF_TIER.FLAGSHIP;
  }

  _tierAllowsAudioLight(tier) {
    return tier >= PERF_TIER.MID_RANGE;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Drain queued impacts with budget ───────────────────
  // ══════════════════════════════════════════════════════════
  _drainImpacts() {
    const maxDrain = this.defaults.maxImpactsDrainedPerFrame;
    let drained = 0;

    while (this._impactQueueCount > 0 && drained < maxDrain) {
      const slotIdx = this._impactQueueHead;
      const slot = this._impactQueue[slotIdx];

      if (slot.active) {
        this._processImpact(slot);
        slot.reset();
      }

      this._impactQueueHead = (this._impactQueueHead + 1) % this.defaults.maxQueuedImpacts;
      this._impactQueueCount--;
      drained++;
    }

    this._impactsThisFrame = drained;
    this._stats.impactsDrained += drained;
    return drained;
  }

  _processImpact(impact) {
    const tier = this._currentTier;

    // ── FRACTURE ────────────────────────────────────────
    this._applyFracture(impact, this._tierAllowsFracture(tier));

    // ── DECAL ───────────────────────────────────────────
    this._applyDecal(impact, this._tierAllowsDecal(tier));

    // ── PERSISTENCE ─────────────────────────────────────
    this._applyPersistence(impact, this._tierAllowsPersistence(tier));

    // ── ECOLOGY ─────────────────────────────────────────
    this._applyEcology(impact, this._tierAllowsEcology(tier));

    // ── AUDIO / LIGHT ───────────────────────────────────
    this._applyAudioLight(impact, this._tierAllowsAudioLight(tier));
  }

  // ══════════════════════════════════════════════════════════
  // ─── Update active shards ───────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateShards(dt) {
    const gravity = -9.81;
    for (let i = 0; i < this._shardPool.length; i++) {
      const s = this._shardPool[i];
      if (!s.active) continue;

      s.age += dt;
      if (s.age >= s.lifetime) {
        s.active = false;
        this._shardFreeList[this._shardFreeCount++] = i;
        this._shardActiveCount--;
        continue;
      }

      // Simple ballistic integration.
      s.vy += gravity * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      s.rotX += s.angularX * dt;
      s.rotY += s.angularY * dt;
      s.rotZ += s.angularZ * dt;

      // Ground bounce if height < 0.
      if (s.y < 0) {
        s.y = 0;
        s.vy *= -0.3;
        s.vx *= 0.7;
        s.vz *= 0.7;
        s.angularX *= 0.5;
        s.angularY *= 0.5;
        s.angularZ *= 0.5;
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Update active decals ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateDecals(dt) {
    for (let i = 0; i < this._decalPool.length; i++) {
      const d = this._decalPool[i];
      if (!d.active) continue;

      d.age += dt;

      // Fade out in the last 20% of lifetime.
      const fadeStart = d.lifetime * 0.8;
      if (d.age > fadeStart) {
        d.fade = 1.0 - (d.age - fadeStart) / (d.lifetime * 0.2);
        if (d.fade < 0) d.fade = 0;
      }

      if (d.age >= d.lifetime || d.fade <= 0.01) {
        d.active = false;
        this._decalFreeList[this._decalFreeCount++] = i;
        this._decalActiveCount--;
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Update active audio/light cues ────────────────────
  // ══════════════════════════════════════════════════════════
  _updateCues(dt, frame) {
    // Get camera position for distance falloff.
    const playerLayer = frame.layers.player;
    const px = playerLayer ? playerLayer.position[0] : 0;
    const py = playerLayer ? playerLayer.position[1] : 0;
    const pz = playerLayer ? playerLayer.position[2] : 0;

    for (let i = 0; i < this._cuePool.length; i++) {
      const c = this._cuePool[i];
      if (!c.active) continue;

      c.age += dt;
      if (c.age >= c.lifetime) {
        c.active = false;
        this._cueFreeList[this._cueFreeCount++] = i;
        this._cueActiveCount--;
        continue;
      }

      // D(τ) = exp(-τ / τ_decay)
      const decay = Math.exp(-c.age / Math.max(0.01, c.tau));

      // Distance from listener.
      const dx = c.x - px;
      const dy = c.y - py;
      const dz = c.z - pz;
      const dist2 = dx * dx + dy * dy + dz * dz;
      const dist = Math.sqrt(dist2);

      if (dist > c.maxDistance) {
        c.active = false;
        this._cueFreeList[this._cueFreeCount++] = i;
        this._cueActiveCount--;
        continue;
      }

      // Distance falloff (inverse-square, clamped).
      const falloff = (this.defaults.lightFalloffRefDistance * this.defaults.lightFalloffRefDistance) /
                      Math.max(0.01, dist2);

      c.currentAmplitude = c.baseAmplitude * decay * falloff;
      c.currentIntensity = c.baseIntensity * decay * falloff;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Adaptive tier management ───────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateAdaptiveTier(dt, now) {
    if (!this.defaults.enableAdaptiveTier) return;

    // Sample every 2 seconds.
    if (now - this._lastTierCheck < 2.0) {
      this._frameMsAccumulator += dt * 1000;
      this._frameMsSamples++;
      return;
    }

    const avgMs = this._frameMsSamples > 0
      ? this._frameMsAccumulator / this._frameMsSamples
      : this.defaults.targetFrameMs;

    const target = this.defaults.targetFrameMs;

    // Downgrade if average frame time exceeds target.
    if (avgMs > target * 1.15 && this._currentTier > PERF_TIER.LOW_END) {
      this._currentTier--;
      this._stats.tierDowngrades++;
    }
    // Upgrade if frame time is well below target.
    else if (avgMs < target * 0.6 && this._currentTier < PERF_TIER.FLAGSHIP) {
      this._currentTier++;
      this._stats.tierUpgrades++;
    }

    this._frameMsAccumulator = 0;
    this._frameMsSamples = 0;
    this._lastTierCheck = now;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.shards) {
      spatial.shards = {
        activeCount: 0,
        maxCount: this.defaults.maxActiveShards,
        pool: this._shardPool,
        activeShards: null
      };
    }
    spatial.shards.activeCount = this._shardActiveCount;

    // Build a compact list of active shards for renderer.
    const activeList = spatial.shards.activeShards || [];
    activeList.length = 0;
    for (let i = 0; i < this._shardPool.length; i++) {
      if (this._shardPool[i].active) {
        activeList.push(this._shardPool[i]);
      }
    }
    spatial.shards.activeShards = activeList;

    if (!spatial.decals) {
      spatial.decals = {
        activeCount: 0,
        maxCount: this.defaults.maxActiveDecals,
        pool: this._decalPool,
        activeDecals: null
      };
    }
    spatial.decals.activeCount = this._decalActiveCount;

    const activeDecals = spatial.decals.activeDecals || [];
    activeDecals.length = 0;
    for (let i = 0; i < this._decalPool.length; i++) {
      if (this._decalPool[i].active) {
        activeDecals.push(this._decalPool[i]);
      }
    }
    spatial.decals.activeDecals = activeDecals;
  }

  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    if (!physical.impacts) {
      physical.impacts = {
        // Fracture
        activeShardCount: 0,
        // Decal
        activeDecalCount: 0,
        // Audio/light
        activeCueCount: 0,
        // Ignition queue
        ignitionQueueCount: 0,
        ignitionQueueX: this._ignitionQueueX,
        ignitionQueueY: this._ignitionQueueY,
        ignitionQueueZ: this._ignitionQueueZ,
        ignitionQueueMaterial: this._ignitionQueueMaterial,
        ignitionQueueForce: this._ignitionQueueForce,
        // Current tier
        perfTier: this._currentTier,
        perfTierName: PERF_TIER_NAMES[this._currentTier]
      };
    }

    const imp = physical.impacts;
    imp.activeShardCount = this._shardActiveCount;
    imp.activeDecalCount = this._decalActiveCount;
    imp.activeCueCount = this._cueActiveCount;
    imp.ignitionQueueCount = this._ignitionQueueCount;
    imp.perfTier = this._currentTier;
    imp.perfTierName = PERF_TIER_NAMES[this._currentTier];
    imp.impactsDrainedThisFrame = this._impactsThisFrame;

    // Expose active light cues directly for the clustered lighting pass.
    if (!imp.activeLightCues) {
      imp.activeLightCues = {
        count: 0,
        positions: [],
        colors: [],
        intensities: []
      };
    }
    const lights = imp.activeLightCues;
    lights.count = 0;
    lights.positions.length = 0;
    lights.colors.length = 0;
    lights.intensities.length = 0;

    for (let i = 0; i < this._cuePool.length; i++) {
      const c = this._cuePool[i];
      if (!c.active || c.currentIntensity < 0.01) continue;
      lights.positions.push(c.x, c.y, c.z);
      lights.colors.push(c.colorR, c.colorG, c.colorB);
      lights.intensities.push(c.currentIntensity);
      lights.count++;
    }

    // Expose ignition queue for the ecology system to consume.
    if (this._ignitionQueueCount > 0 && this._dispatcher) {
      // Already emitted per-event above; just expose queue for polling.
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Main update ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  update(frame, clock) {
    if (!frame || !frame.layers) return 0;
    const now = clock ? clock.elapsedSeconds : performance.now() / 1000;
    const dt = clock ? clock.delta : 1 / 60;

    this._frameRef = frame;
    this._impactsThisFrame = 0;

    // ── 1. Adaptive tier management ────────────────────
    this._updateAdaptiveTier(dt, now);

    // ── 2. Drain queued impacts within budget ──────────
    this._drainImpacts();

    // ── 3. Update active shards ────────────────────────
    this._updateShards(dt);

    // ── 4. Update active decals ────────────────────────
    this._updateDecals(dt);

    // ── 5. Update active audio/light cues ──────────────
    this._updateCues(dt, frame);

    // ── 6. Reset ignition queue for ecology consumer ───
    // The ignition queue is read by 316_EcologyResponseSystem;
    // after that system consumes it, the count must be reset.
    // For safety, if no ecology consumer exists, auto-clear
    // after 2 frames to avoid stale data.
    this._ignitionQueueCount = 0;

    // ── 7. Write to frame layers ───────────────────────
    this._writeToSpatialLayer(frame);
    this._writeToPhysicalLayer(frame);

    return 1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Diagnostics ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getStats() {
    return Object.freeze({ ...this._stats });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) this._stats[k] = 0;
  }

  get currentTier() { return this._currentTier; }
  get currentTierName() { return PERF_TIER_NAMES[this._currentTier]; }
  get activeShardCount() { return this._shardActiveCount; }
  get activeDecalCount() { return this._decalActiveCount; }
  get activeCueCount() { return this._cueActiveCount; }
  get queuedImpactCount() { return this._impactQueueCount; }
  get ignitionQueueCount() { return this._ignitionQueueCount; }

  // ── Public: manual tier control ────────────────────────
  setPerfTier(tier) {
    if (tier >= PERF_TIER.LOW_END && tier <= PERF_TIER.FLAGSHIP) {
      this._currentTier = tier;
      this.defaults.enableAdaptiveTier = false;
    }
    return this;
  }

  enableAdaptiveTiering() {
    this.defaults.enableAdaptiveTier = true;
    return this;
  }

  // ── Public: clear all active effects ───────────────────
  clearAllEffects() {
    for (let i = 0; i < this._shardPool.length; i++) {
      if (this._shardPool[i].active) this._releaseShard(this._shardPool[i]);
    }
    for (let i = 0; i < this._decalPool.length; i++) {
      if (this._decalPool[i].active) this._releaseDecal(this._decalPool[i]);
    }
    for (let i = 0; i < this._cuePool.length; i++) {
      if (this._cuePool[i].active) this._releaseCue(this._cuePool[i]);
    }
    this._impactQueueCount = 0;
    this._impactQueueHead = 0;
    this._ignitionQueueCount = 0;
    return this;
  }

  dispose() {
    this.clearAllEffects();
    this._shardPool.length = 0;
    this._decalPool.length = 0;
    this._cuePool.length = 0;
    this._impactQueue.length = 0;
    this._dispatcher = null;
    this._clock = null;
    this._materials = null;
    this._worldMemory = null;
    this._frameRef = null;
  }
}

export {
  ImpactEventCoordinator,
  PERF_TIER,
  PERF_TIER_NAMES,
  IMPACT_SOURCE,
  IMPACT_SOURCE_NAMES,
  QueuedImpact,
  ActiveShard,
  ActiveDecal,
  AudioLightCue
};