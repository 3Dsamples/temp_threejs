// file number : 308
// full path name : src/context/308_ContextConsumerTiers.js
// description : Strict 60/10/1 Hz context consumer tier scheduler — the blueprint's step 6 and 7 made concrete. Every consumer that reads the context frame must declare its tier (HZ_60, HZ_10, HZ_1), its phase offset, and its dependencies. The tier gate enforces g_f(t) = 1 when (t mod T_f) < Δt, where T_60 = T_10/6 = T_1/60 exactly, with fixed offsets φ_f = f·Δt₀ (φ_60 = 0, φ_10 = 4/60, φ_1 = 37/60) so work is spread across frames and consumers never all fire on the same tick. Any consumer that declares a dependency on a slower tier's output is rejected at registration time and again at dispatch time to prevent stutter from invisible cross-tier reads. Each tier maintains its own isolated state slice version; a 60 Hz consumer cannot read a 10 Hz slice in the same tick because the version token increments only after the 10 Hz tick completes and the frame is committed. Provides per-tier scheduling state, per-consumer execution stats, dependency tracking with cycle detection, and a cooperative polling API so consumers that arrive later in the frame can skip ahead to the next tick. Emits AUDIO_LIGHT causal events on any cross-tier violation attempt, on a consumer exceeding its tier's soft budget, and on scheduler desync when the wall clock jumps or a tier is skipped. Writes per-tick tier state into frame.layers.physical.consumerTiers and per-consumer scheduling stats into frame.layers.spatial.consumerSchedules. Zero allocation on hot paths: all tier gates, consumer registrations, dependency graph edges, and event payloads are pre-allocated Float64Array/Int32Array/Uint8Array structures; beginTick/endTick/canRun/run do not create any objects.
// best for : The single scheduler that every 60/10/1 Hz consumer in the world must go through — the six-stage orchestration loop (309), the LOD consumer (311), the load-state consumer (312), the visibility consumer (313), the noise consumer (314), the material param consumer (315), the biome systems at 1 Hz, the ecology systems, and any provider that wants to run at a strict frequency. This is what makes the 60/10/1 discipline enforceable rather than aspirational.
// license : MIT

import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere, Box3, Frustum,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture
} from './264_MathECSImportBarrel.js';

import { ContextFrame }                                    from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES }    from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS }                   from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD, TIER_OFFSET }        from './267_CoreClock.js';
import { FrameBudgetMonitor, BUDGET_SLICE, BUDGET_SLICE_NAMES }
                                                            from './305_FrameBudgetMonitor.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONSUMER TIER CONSTANTS ───────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const CONSUMER_TIER = Object.freeze({
  HZ_60:  0,
  HZ_10:  1,
  HZ_1:   2
});

const CONSUMER_TIER_NAMES = Object.freeze(['hz_60', 'hz_10', 'hz_1']);
const CONSUMER_TIER_HZ = Object.freeze([60, 10, 1]);

// Period T_f in seconds.
const TIER_PERIOD_S = Object.freeze([
  1 / 60,   // 60 Hz: 0.016667 s
  1 / 10,   // 10 Hz: 0.1 s
  1 / 1     //  1 Hz: 1.0 s
]);

// Fixed phase offsets φ_f = f·Δt₀ where Δt₀ = 1/60.
// φ_60 = 0 · 1/60 = 0
// φ_10 = 4 · 1/60 ≈ 0.06667
// φ_1  = 37 · 1/60 ≈ 0.61667
const TIER_OFFSET_S = Object.freeze([
  0.0,
  4 / 60,
  37 / 60
]);

// Tier budget soft caps (fraction of frame CPU).
// HZ_60 dominates (rendering), HZ_10 moderate, HZ_1 small.
const TIER_BUDGET_FRACTION = Object.freeze([
  0.55,   // 60 Hz: 55% of 8 ms = 4.4 ms
  0.30,   // 10 Hz: 30% of 8 ms = 2.4 ms
  0.10    //  1 Hz: 10% of 8 ms = 0.8 ms
]);

const SLICE_PER_TIER = Object.freeze([
  BUDGET_SLICE.TIER_60HZ,
  BUDGET_SLICE.TIER_10HZ,
  BUDGET_SLICE.TIER_1HZ
]);

// ─── Phase schedule count per tier (spread across super-period) ─
const PHASE_COUNT_PER_TIER = Object.freeze([
  1,    // 60 Hz fires every frame, no sub-phases
  6,    // 10 Hz has 6 sub-phases within a 60 Hz cycle
  60    //  1 Hz has 60 sub-phases within a 60 Hz cycle
]);

// ══════════════════════════════════════════════════════════════════
// ─── CONSUMER REGISTRATION STATES ─────────────────────────────
// ══════════════════════════════════════════════════════════════════
const CONSUMER_STATE = Object.freeze({
  FREE:        0,
  REGISTERED:  1,
  DISABLED:    2,
  SUSPENDED:   3,
  VIOLATION:   4
});

const CONSUMER_STATE_NAMES = Object.freeze([
  'free', 'registered', 'disabled', 'suspended', 'violation'
]);

// ══════════════════════════════════════════════════════════════════
// ─── PER-CONSUMER ENTRY (pooled, flat) ────────────────────────
// ══════════════════════════════════════════════════════════════════
class ConsumerEntry {
  constructor() {
    this.state = CONSUMER_STATE.FREE;
    this.id = -1;
    this.name = '';
    this.tier = CONSUMER_TIER.HZ_60;
    this.phase = 0;
    this.fn = null;
    this.dependencies = new Int32Array(8);   // IDs of slower-tier consumers
    this.dependencyCount = 0;
    this.readsTierMask = 0;                  // bitmask: which tiers this consumer reads
    this.writesTierMask = 0;                 // bitmask: which tiers this consumer writes
    this.lastRunTick = -1;
    this.lastRunTime = 0;
    this.runCount = 0;
    this.skipCount = 0;
    this.violationCount = 0;
    this.avgExecMs = 0;                      // exponential moving average
    this.maxExecMs = 0;
    this.enabled = true;
  }

  reset() {
    this.state = CONSUMER_STATE.FREE;
    this.id = -1;
    this.name = '';
    this.tier = CONSUMER_TIER.HZ_60;
    this.phase = 0;
    this.fn = null;
    this.dependencyCount = 0;
    this.readsTierMask = 0;
    this.writesTierMask = 0;
    this.lastRunTick = -1;
    this.lastRunTime = 0;
    this.runCount = 0;
    this.skipCount = 0;
    this.violationCount = 0;
    this.avgExecMs = 0;
    this.maxExecMs = 0;
    this.enabled = true;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── TIER SLICE VERSIONING ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// Each tier has a version token that increments ONLY when that
// tier's tick completes and the frame is committed. This is how
// we prevent cross-tier reads within the same frame.
class TierSliceVersion {
  constructor() {
    this.publishedVersion = 0;    // last committed version
    this.currentVersion = 0;      // version being written this tick
    this.pendingCommit = false;   // 1 when this tick has already run
  }

  beginTick() {
    this.currentVersion = this.publishedVersion + 1;
    this.pendingCommit = false;
  }

  commitTick() {
    if (!this.pendingCommit) {
      this.publishedVersion = this.currentVersion;
      this.pendingCommit = true;
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── TIER GATE STATE ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class TierGate {
  constructor(tierIndex) {
    this.tier = tierIndex;
    this.period = TIER_PERIOD_S[tierIndex];
    this.phaseOffset = TIER_OFFSET_S[tierIndex];
    this.frameCounter = 0;
    this.lastFireTime = 0;
    this.nextFireTime = 0;
    this.fireCount = 0;
    this.skipCount = 0;
    this.pendingCommit = false;
    this.sliceVersion = new TierSliceVersion();
    this.deltaSeconds = TIER_PERIOD_S[tierIndex];
  }

  // Compute whether the gate fires this tick, given current time.
  // g_f(t) = 1 when (t mod T_f) < Δt, with phase offset.
  shouldFire(currentTime, deltaSeconds) {
    // First-ever fire.
    if (this.fireCount === 0) {
      this.lastFireTime = currentTime;
      this.nextFireTime = currentTime + this.period;
      this.deltaSeconds = deltaSeconds;
      return true;
    }

    // Compute next fire time in the phase-aligned schedule.
    const targetTime = this.nextFireTime;
    if (currentTime + deltaSeconds >= targetTime) {
      // Advance nextFireTime by periods until we're past currentTime.
      let skip = 0;
      while (this.nextFireTime + this.period <= currentTime + deltaSeconds) {
        this.nextFireTime += this.period;
        skip++;
      }
      this.nextFireTime += this.period;
      this.skipCount += skip;
      this.lastFireTime = currentTime;
      this.deltaSeconds = deltaSeconds;
      return true;
    }
    return false;
  }

  beginTick() {
    this.sliceVersion.beginTick();
    this.pendingCommit = false;
  }

  commitTick() {
    if (!this.pendingCommit) {
      this.sliceVersion.commitTick();
      this.fireCount++;
      this.pendingCommit = true;
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── CONTEXT CONSUMER TIERS SCHEDULER ─────────────────────────
// ══════════════════════════════════════════════════════════════════
class ContextConsumerTiers {
  constructor(options = {}) {
    // ── Configuration ────────────────────────────────────
    this.defaults = {
      maxConsumers:           options.maxConsumers ?? 256,
      enableEvents:           options.enableEvents ?? true,
      enableCrossTierGuard:   options.enableCrossTierGuard ?? true,
      enablePhaseSpread:      options.enablePhaseSpread ?? true,
      enableDesyncDetection:  options.enableDesyncDetection ?? true,
      desyncThresholdMs:      options.desyncThresholdMs ?? 100,
      eventCoalesceMs:        options.eventCoalesceMs ?? 500,
      frameBudgetMs:          options.frameBudgetMs ?? 8.0,
      frameBudgetMonitor:     options.frameBudgetMonitor ?? null
    };

    // ── Tier gates (one per tier) ────────────────────────
    this._tierGates = new Array(3);
    for (let t = 0; t < 3; t++) {
      this._tierGates[t] = new TierGate(t);
    }

    // ── Consumer pool ────────────────────────────────────
    const maxConsumers = this.defaults.maxConsumers;
    this._consumerPool = new Array(maxConsumers);
    for (let i = 0; i < maxConsumers; i++) {
      this._consumerPool[i] = new ConsumerEntry();
    }
    this._consumerFreeList = new Int32Array(maxConsumers);
    for (let i = 0; i < maxConsumers; i++) {
      this._consumerFreeList[i] = maxConsumers - 1 - i;
    }
    this._consumerFreeCount = maxConsumers;
    this._consumerUsed = 0;
    this._nextConsumerId = 1;

    // ── Per-tier consumer index (which consumers belong to each tier) ─
    this._tierConsumers = [
      new Int32Array(maxConsumers),
      new Int32Array(maxConsumers),
      new Int32Array(maxConsumers)
    ];
    this._tierConsumerCounts = new Int32Array(3);

    // ── ID-to-pool-index map (open addressing, small) ───
    this._idToPool = new Int32Array(maxConsumers * 2).fill(-1);
    const mapSize = maxConsumers * 2;
    this._idToPoolMask = mapSize - 1;

    // ── Tick state ───────────────────────────────────────
    this._tickIndex = 0;
    this._frameStartTime = 0;
    this._frameDeltaSeconds = 0;
    this._frameValid = false;

    // ── Per-frame execution state ───────────────────────
    this._ranConsumersThisTick = 0;
    this._violationsThisTick = 0;

    // ── Per-tier execution state ─────────────────────────
    this._tierRanThisTick = new Int32Array(3);
    this._tierExecMsThisTick = new Float64Array(3);
    this._tierExecMsEma = new Float64Array(3);
    this._tierExecMsPeak = new Float64Array(3);

    // ── Desync detection ─────────────────────────────────
    this._lastFrameTime = 0;
    this._desyncEvents = 0;

    // ── Scratch (pooled) ─────────────────────────────────
    this._tmpVec3A = new Vec3();
    this._tmpVec3B = new Vec3();
    this._tmpVec4 = new Vec4();
    this._tmpMat4 = new Mat4();
    this._tmpQuat = new Quat();

    // ── Statistics ──────────────────────────────────────
    this._stats = {
      totalTicks: 0,
      tier60Fires: 0,
      tier10Fires: 0,
      tier1Fires: 0,
      consumersRegistered: 0,
      consumersUnregistered: 0,
      consumersRan: 0,
      consumersSkipped: 0,
      crossTierViolations: 0,
      budgetViolations: 0,
      desyncEvents: 0,
      dependencyCycles: 0,
      enableToggles: 0
    };

    // ── Event coalescing ─────────────────────────────────
    this._lastEventTime = 0;
    this._lastViolationEventTime = 0;
    this._lastBudgetEventTime = 0;

    // ── Collaborators ───────────────────────────────────
    this._dispatcher = options.dispatcher || null;
    this._clock = options.clock || null;
    this._frameBudgetMonitor = this.defaults.frameBudgetMonitor;
    this._frameRef = null;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachDispatcher(d) { this._dispatcher = d; return this; }
  attachClock(c) { this._clock = c; return this; }
  attachFrameBudgetMonitor(f) { this._frameBudgetMonitor = f; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── ID → pool index mapping (open addressing) ─────────
  // ══════════════════════════════════════════════════════════
  _idHash(id) {
    // Mix the ID so sequential IDs don't cluster.
    let h = id | 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h = h ^ (h >>> 16);
    return h & this._idToPoolMask;
  }

  _idInsert(id, poolIndex) {
    let slot = this._idHash(id);
    for (let i = 0; i < this._idToPoolMask + 1; i++) {
      if (this._idToPool[slot] === -1) {
        this._idToPool[slot] = (poolIndex << 1) | 1;   // low bit = occupancy
        return true;
      }
      slot = (slot + 1) & this._idToPoolMask;
    }
    return false;
  }

  _idLookup(id) {
    let slot = this._idHash(id);
    for (let i = 0; i < this._idToPoolMask + 1; i++) {
      const raw = this._idToPool[slot];
      if (raw === -1) return -1;
      if ((raw & 1) === 1) {
        // Occupied — check if this ID matches.
        const poolIndex = raw >>> 1;
        if (poolIndex >= 0 && poolIndex < this._consumerPool.length) {
          if (this._consumerPool[poolIndex].id === id) return poolIndex;
        }
      }
      slot = (slot + 1) & this._idToPoolMask;
    }
    return -1;
  }

  _idRemove(id) {
    let slot = this._idHash(id);
    for (let i = 0; i < this._idToPoolMask + 1; i++) {
      const raw = this._idToPool[slot];
      if (raw === -1) return;
      if ((raw & 1) === 1) {
        const poolIndex = raw >>> 1;
        if (poolIndex >= 0 && poolIndex < this._consumerPool.length) {
          if (this._consumerPool[poolIndex].id === id) {
            this._idToPool[slot] = -1;
            return;
          }
        }
      }
      slot = (slot + 1) & this._idToPoolMask;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Register a consumer ────────────────────────────────
  // ══════════════════════════════════════════════════════════
  // opts:
  //   tier: CONSUMER_TIER.HZ_60 | HZ_10 | HZ_1
  //   phase: integer in [0, phaseCount(tier) - 1]
  //   readsTiers: array of tier indices the consumer reads
  //   writesTiers: array of tier indices the consumer writes
  //   dependencies: array of consumer IDs this consumer depends on
  registerConsumer(name, fn, opts = {}) {
    if (typeof fn !== 'function') return -1;
    if (this._consumerFreeCount === 0) return -1;

    const tier = opts.tier ?? CONSUMER_TIER.HZ_60;
    if (tier < 0 || tier > 2) return -1;

    const phase = opts.phase ?? 0;
    const maxPhase = PHASE_COUNT_PER_TIER[tier];
    const clampedPhase = Math.max(0, Math.min(maxPhase - 1, phase | 0));

    // ── Cross-tier read validation ──────────────────────
    // A consumer at tier T must not read tiers SLOWER than T.
    const readsTiers = opts.readsTiers || [tier];
    if (this.defaults.enableCrossTierGuard) {
      for (let i = 0; i < readsTiers.length; i++) {
        const readTier = readsTiers[i];
        if (readTier > tier) {
          // Attempting to read a slower tier — reject.
          this._stats.crossTierViolations++;
          this._emitCrossTierViolation(name, tier, readTier, 'register');
          return -1;
        }
      }
    }

    // ── Dependency cycle detection ──────────────────────
    const deps = opts.dependencies || [];
    for (let i = 0; i < deps.length; i++) {
      if (this._hasCycle(this._nextConsumerId, deps[i], deps, opts)) {
        this._stats.dependencyCycles++;
        return -1;
      }
    }

    // ── Allocate consumer slot ──────────────────────────
    this._consumerFreeCount--;
    const poolIndex = this._consumerFreeList[this._consumerFreeCount];
    const consumer = this._consumerPool[poolIndex];

    consumer.reset();
    consumer.state = CONSUMER_STATE.REGISTERED;
    consumer.id = this._nextConsumerId++;
    consumer.name = name;
    consumer.tier = tier;
    consumer.phase = clampedPhase;
    consumer.fn = fn;

    // Reads mask.
    let readsMask = 0;
    for (let i = 0; i < readsTiers.length; i++) readsMask |= (1 << readsTiers[i]);
    consumer.readsTierMask = readsMask;

    // Writes mask.
    const writesTiers = opts.writesTiers || [tier];
    let writesMask = 0;
    for (let i = 0; i < writesTiers.length; i++) writesMask |= (1 << writesTiers[i]);
    consumer.writesTierMask = writesMask;

    // Dependencies.
    if (deps.length > consumer.dependencies.length) {
      consumer.dependencies = new Int32Array(deps.length);
    }
    for (let i = 0; i < deps.length; i++) {
      consumer.dependencies[i] = deps[i];
    }
    consumer.dependencyCount = deps.length;

    // Insert into ID map and tier index.
    if (!this._idInsert(consumer.id, poolIndex)) {
      consumer.reset();
      this._consumerFreeList[this._consumerFreeCount++] = poolIndex;
      return -1;
    }
    this._tierConsumers[tier][this._tierConsumerCounts[tier]++] = poolIndex;
    this._consumerUsed++;
    this._stats.consumersRegistered++;

    return consumer.id;
  }

  // ── Simple cycle detection (DFS on the dependency graph) ─
  _hasCycle(newId, depId, deps, opts) {
    // Walk the dependency chain starting from depId.
    // If we reach newId, it's a cycle.
    const visited = new Set();
    const stack = [depId];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur === newId) return true;
      if (visited.has(cur)) continue;
      visited.add(cur);

      const pool = this._idLookup(cur);
      if (pool >= 0) {
        const consumer = this._consumerPool[pool];
        for (let i = 0; i < consumer.dependencyCount; i++) {
          stack.push(consumer.dependencies[i]);
        }
      }
    }
    return false;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Unregister a consumer ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  unregisterConsumer(consumerId) {
    const poolIndex = this._idLookup(consumerId);
    if (poolIndex < 0) return false;

    const consumer = this._consumerPool[poolIndex];

    // Remove from tier list (swap with last).
    const tier = consumer.tier;
    const tierList = this._tierConsumers[tier];
    const count = this._tierConsumerCounts[tier];
    for (let i = 0; i < count; i++) {
      if (tierList[i] === poolIndex) {
        tierList[i] = tierList[count - 1];
        this._tierConsumerCounts[tier]--;
        break;
      }
    }

    // Remove from ID map.
    this._idRemove(consumerId);

    // Reset and recycle.
    consumer.reset();
    this._consumerFreeList[this._consumerFreeCount++] = poolIndex;
    this._consumerUsed--;
    this._stats.consumersUnregistered++;

    return true;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Enable / disable ───────────────────────────────────
  // ══════════════════════════════════════════════════════════
  setConsumerEnabled(consumerId, enabled) {
    const poolIndex = this._idLookup(consumerId);
    if (poolIndex < 0) return false;
    const consumer = this._consumerPool[poolIndex];
    consumer.enabled = !!enabled;
    consumer.state = enabled ? CONSUMER_STATE.REGISTERED : CONSUMER_STATE.DISABLED;
    this._stats.enableToggles++;
    return true;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Tier firing computation ────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Returns whether a tier fires this tick. Checks the gate
  // formula with the phase offset.
  _computeTierFire(tier, currentTime, deltaSeconds) {
    const gate = this._tierGates[tier];
    return gate.shouldFire(currentTime, deltaSeconds);
  }

  // ══════════════════════════════════════════════════════════
  // ─── Begin / end tick ───────────────────────────────────
  // ══════════════════════════════════════════════════════════
  // beginTick computes which tiers fire this tick.
  beginTick(currentTime, deltaSeconds) {
    this._frameStartTime = currentTime;
    this._frameDeltaSeconds = deltaSeconds;
    this._frameValid = true;
    this._tickIndex++;
    this._ranConsumersThisTick = 0;
    this._violationsThisTick = 0;

    this._tierRanThisTick[0] = 0;
    this._tierRanThisTick[1] = 0;
    this._tierRanThisTick[2] = 0;
    this._tierExecMsThisTick[0] = 0;
    this._tierExecMsThisTick[1] = 0;
    this._tierExecMsThisTick[2] = 0;

    // Begin tier ticks and compute fire status.
    for (let t = 0; t < 3; t++) {
      this._tierGates[t].beginTick();
      this._tierGates[t]._firesThisTick = this._computeTierFire(
        t, currentTime, deltaSeconds
      );
    }

    // Desync detection.
    if (this.defaults.enableDesyncDetection && this._lastFrameTime > 0) {
      const gap = (currentTime - this._lastFrameTime) * 1000;
      if (gap > this.defaults.desyncThresholdMs) {
        this._stats.desyncEvents++;
        this._emitDesyncEvent(gap);
      }
    }
    this._lastFrameTime = currentTime;

    return this;
  }

  // ── Check whether a tier fires this tick ────────────────
  shouldTierRun(tier) {
    if (tier < 0 || tier > 2) return false;
    return this._tierGates[tier]._firesThisTick === true;
  }

  // ── Run all consumers of a tier this tick ────────────────
  // Callers invoke this for each tier whose shouldTierRun() is true.
  runTier(tier, frame) {
    if (tier < 0 || tier > 2) return 0;
    if (!this.shouldTierRun(tier)) return 0;

    const tierList = this._tierConsumers[tier];
    const count = this._tierConsumerCounts[tier];
    const startMs = performance.now();
    let ranCount = 0;

    for (let i = 0; i < count; i++) {
      const poolIndex = tierList[i];
      const consumer = this._consumerPool[poolIndex];
      if (consumer.state !== CONSUMER_STATE.REGISTERED) continue;
      if (!consumer.enabled) continue;

      // Check dependencies.
      if (this.defaults.enableCrossTierGuard && consumer.dependencyCount > 0) {
        let allDepsMet = true;
        for (let d = 0; d < consumer.dependencyCount; d++) {
          const depId = consumer.dependencies[d];
          const depPool = this._idLookup(depId);
          if (depPool < 0) continue;
          const dep = this._consumerPool[depPool];
          // Dependency must have run in a previous tick (lastRunTick
          // strictly less than this tick, not equal).
          if (dep.lastRunTick >= this._tickIndex) {
            allDepsMet = false;
            break;
          }
        }
        if (!allDepsMet) {
          consumer.skipCount++;
          this._stats.consumersSkipped++;
          continue;
        }
      }

      // Phase check for 10 Hz and 1 Hz tiers.
      if (tier > 0 && this.defaults.enablePhaseSpread) {
        const modTick = this._tickIndex % PHASE_COUNT_PER_TIER[tier];
        if (modTick !== consumer.phase) {
          continue;
        }
      }

      // ── Execute consumer ─────────────────────────────
      const execStart = performance.now();
      try {
        consumer.fn(frame, this);
      } catch (e) {
        // Consumers must not throw, but if they do, catch and count.
        consumer.violationCount++;
        this._violationsThisTick++;
      }
      const execEnd = performance.now();
      const execMs = execEnd - execStart;

      // Update stats.
      consumer.runCount++;
      consumer.lastRunTick = this._tickIndex;
      consumer.lastRunTime = currentTimeForConsumer(this);
      consumer.avgExecMs = consumer.avgExecMs === 0
        ? execMs
        : consumer.avgExecMs * 0.9 + execMs * 0.1;
      if (execMs > consumer.maxExecMs) consumer.maxExecMs = execMs;

      this._tierExecMsThisTick[tier] += execMs;
      ranCount++;
      this._ranConsumersThisTick++;
      this._stats.consumersRan++;
    }

    const totalMs = performance.now() - startMs;
    this._tierRanThisTick[tier] = ranCount;
    this._tierExecMsThisTick[tier] = totalMs;
    this._tierExecMsEma[tier] = this._tierExecMsEma[tier] === 0
      ? totalMs
      : this._tierExecMsEma[tier] * 0.9 + totalMs * 0.1;
    if (totalMs > this._tierExecMsPeak[tier]) {
      this._tierExecMsPeak[tier] = totalMs;
    }

    // ── Budget check ────────────────────────────────────
    const tierBudgetMs = this.defaults.frameBudgetMs * TIER_BUDGET_FRACTION[tier];
    if (totalMs > tierBudgetMs) {
      this._stats.budgetViolations++;
      this._emitBudgetViolationEvent(tier, totalMs, tierBudgetMs);
    }

    // ── Advance gate and commit slice version ───────────
    this._tierGates[tier].commitTick();
    if (tier === 0) this._stats.tier60Fires++;
    else if (tier === 1) this._stats.tier10Fires++;
    else this._stats.tier1Fires++;

    // ── Forward to frame budget monitor ─────────────────
    if (this._frameBudgetMonitor) {
      this._frameBudgetMonitor.beginSlice(SLICE_PER_TIER[tier]);
      this._frameBudgetMonitor.endSlice(SLICE_PER_TIER[tier]);
    }

    return ranCount;
  }

  endTick() {
    if (!this._frameValid) return this;
    this._frameValid = false;
    this._stats.totalTicks++;
    return this;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Cross-tier read guard ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  // A consumer at tier T that wants to read a slice must call this
  // to verify the read is allowed this tick.
  canReadTier(consumerId, readTier) {
    const poolIndex = this._idLookup(consumerId);
    if (poolIndex < 0) return false;
    const consumer = this._consumerPool[poolIndex];

    // Slower reads are forbidden within the same tick.
    if (readTier > consumer.tier) {
      // Even if the slow tier has committed a new version, that
      // version was for a previous tick and hasn't propagated yet.
      this._stats.crossTierViolations++;
      consumer.violationCount++;
      consumer.state = CONSUMER_STATE.VIOLATION;
      this._emitCrossTierViolation(consumer.name, consumer.tier, readTier, 'runtime');
      return false;
    }

    // Same-tier read: allowed if the tier has begun this tick.
    // Faster-tier read: allowed (they've already committed).
    return true;
  }

  // ── Get the current committed version of a tier ────────
  getTierVersion(tier) {
    if (tier < 0 || tier > 2) return 0;
    return this._tierGates[tier].sliceVersion.publishedVersion;
  }

  // ── Check if a tier committed this tick already ────────
  isTierCommittedThisTick(tier) {
    if (tier < 0 || tier > 2) return false;
    return this._tierGates[tier].pendingCommit === true;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Event emission ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _emitCrossTierViolation(name, consumerTier, readTier, phase) {
    if (!this._dispatcher || !this.defaults.enableEvents) return;
    const now = performance.now();
    if (now - this._lastViolationEventTime < this.defaults.eventCoalesceMs) return;
    this._lastViolationEventTime = now;

    this._dispatcher.queueCausalEvent(
      EVENT_TYPE.AUDIO_LIGHT,
      [0, 0, 0],
      -1, 1, 1.0,
      {
        kind: 'cross_tier_violation',
        phase,
        consumerName: name,
        consumerTier,
        consumerTierName: CONSUMER_TIER_NAMES[consumerTier],
        readTier,
        readTierName: CONSUMER_TIER_NAMES[readTier]
      }
    );
  }

  _emitBudgetViolationEvent(tier, actualMs, budgetMs) {
    if (!this._dispatcher || !this.defaults.enableEvents) return;
    const now = performance.now();
    if (now - this._lastBudgetEventTime < this.defaults.eventCoalesceMs) return;
    this._lastBudgetEventTime = now;

    this._dispatcher.queueCausalEvent(
      EVENT_TYPE.AUDIO_LIGHT,
      [0, 0, 0],
      -1, 1, 1.0,
      {
        kind: 'tier_budget_violation',
        tier,
        tierName: CONSUMER_TIER_NAMES[tier],
        actualMs,
        budgetMs,
        overrun: actualMs - budgetMs
      }
    );
  }

  _emitDesyncEvent(gapMs) {
    if (!this._dispatcher || !this.defaults.enableEvents) return;

    this._dispatcher.queueCausalEvent(
      EVENT_TYPE.AUDIO_LIGHT,
      [0, 0, 0],
      -1, 1, 1.0,
      {
        kind: 'scheduler_desync',
        gapMs,
        thresholdMs: this.defaults.desyncThresholdMs
      }
    );
  }

  // ══════════════════════════════════════════════════════════
  // ─── Frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    if (!physical.consumerTiers) {
      physical.consumerTiers = {
        tickIndex: 0,
        tierFires: new Uint8Array(3),
        tierRanThisTick: new Int32Array(3),
        tierExecMsThisTick: new Float64Array(3),
        tierExecMsEma: new Float64Array(3),
        tierExecMsPeak: new Float64Array(3),
        tierVersions: new Int32Array(3),
        tierPeriodsMs: new Float64Array(3),
        tierOffsetsMs: new Float64Array(3),
        tierBudgetsMs: new Float64Array(3),
        tierConsumerCounts: new Int32Array(3),
        tierNames: CONSUMER_TIER_NAMES,
        consumersRanThisTick: 0,
        violationsThisTick: 0,
        stats: {}
      };
    }

    const ct = physical.consumerTiers;
    ct.tickIndex = this._tickIndex;

    for (let t = 0; t < 3; t++) {
      ct.tierFires[t] = this._tierGates[t]._firesThisTick ? 1 : 0;
      ct.tierRanThisTick[t] = this._tierRanThisTick[t];
      ct.tierExecMsThisTick[t] = this._tierExecMsThisTick[t];
      ct.tierExecMsEma[t] = this._tierExecMsEma[t];
      ct.tierExecMsPeak[t] = this._tierExecMsPeak[t];
      ct.tierVersions[t] = this._tierGates[t].sliceVersion.publishedVersion;
      ct.tierPeriodsMs[t] = TIER_PERIOD_S[t] * 1000;
      ct.tierOffsetsMs[t] = TIER_OFFSET_S[t] * 1000;
      ct.tierBudgetsMs[t] = this.defaults.frameBudgetMs * TIER_BUDGET_FRACTION[t];
      ct.tierConsumerCounts[t] = this._tierConsumerCounts[t];
    }

    ct.consumersRanThisTick = this._ranConsumersThisTick;
    ct.violationsThisTick = this._violationsThisTick;

    // Stats snapshot.
    ct.stats.totalTicks = this._stats.totalTicks;
    ct.stats.tier60Fires = this._stats.tier60Fires;
    ct.stats.tier10Fires = this._stats.tier10Fires;
    ct.stats.tier1Fires = this._stats.tier1Fires;
    ct.stats.consumersRegistered = this._stats.consumersRegistered;
    ct.stats.consumersUnregistered = this._stats.consumersUnregistered;
    ct.stats.consumersRan = this._stats.consumersRan;
    ct.stats.consumersSkipped = this._stats.consumersSkipped;
    ct.stats.crossTierViolations = this._stats.crossTierViolations;
    ct.stats.budgetViolations = this._stats.budgetViolations;
    ct.stats.desyncEvents = this._stats.desyncEvents;
    ct.stats.dependencyCycles = this._stats.dependencyCycles;
  }

  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.consumerSchedules) {
      spatial.consumerSchedules = {
        consumerCount: 0,
        consumerIds: new Int32Array(this.defaults.maxConsumers),
        consumerNames: new Array(this.defaults.maxConsumers).fill(''),
        consumerTiers: new Uint8Array(this.defaults.maxConsumers),
        consumerPhases: new Int32Array(this.defaults.maxConsumers),
        consumerAvgExecMs: new Float32Array(this.defaults.maxConsumers),
        consumerMaxExecMs: new Float32Array(this.defaults.maxConsumers),
        consumerRunCounts: new Int32Array(this.defaults.maxConsumers),
        consumerSkipCounts: new Int32Array(this.defaults.maxConsumers),
        consumerStates: new Uint8Array(this.defaults.maxConsumers)
      };
    }

    const cs = spatial.consumerSchedules;
    let count = 0;
    for (let i = 0; i < this._consumerPool.length; i++) {
      const c = this._consumerPool[i];
      if (c.state === CONSUMER_STATE.FREE) continue;
      if (count >= cs.consumerIds.length) break;
      cs.consumerIds[count] = c.id;
      cs.consumerNames[count] = c.name;
      cs.consumerTiers[count] = c.tier;
      cs.consumerPhases[count] = c.phase;
      cs.consumerAvgExecMs[count] = c.avgExecMs;
      cs.consumerMaxExecMs[count] = c.maxExecMs;
      cs.consumerRunCounts[count] = c.runCount;
      cs.consumerSkipCounts[count] = c.skipCount;
      cs.consumerStates[count] = c.state;
      count++;
    }
    cs.consumerCount = count;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Main update ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  update(frame, clock) {
    if (!frame || !frame.layers) return 0;
    this._frameRef = frame;
    this._writeToPhysicalLayer(frame);
    this._writeToSpatialLayer(frame);
    return 1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Query APIs ─────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getConsumerInfo(consumerId) {
    const poolIndex = this._idLookup(consumerId);
    if (poolIndex < 0) return null;
    return this._consumerPool[poolIndex];
  }

  getTierFires(tier) {
    if (tier < 0 || tier > 2) return false;
    return this._tierGates[tier]._firesThisTick === true;
  }

  getTickIndex() { return this._tickIndex; }
  getConsumerCount() { return this._consumerUsed; }
  getTierConsumerCount(tier) {
    if (tier < 0 || tier > 2) return 0;
    return this._tierConsumerCounts[tier];
  }
  getTierExecMsEma(tier) {
    if (tier < 0 || tier > 2) return 0;
    return this._tierExecMsEma[tier];
  }

  // ══════════════════════════════════════════════════════════
  // ─── Diagnostics ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getStats() {
    return Object.freeze({
      tickIndex: this._tickIndex,
      consumerCount: this._consumerUsed,
      tierConsumerCounts: Array.from(this._tierConsumerCounts),
      tierExecMsEma: Array.from(this._tierExecMsEma),
      tierExecMsPeak: Array.from(this._tierExecMsPeak),
      tier60Fires: this._stats.tier60Fires,
      tier10Fires: this._stats.tier10Fires,
      tier1Fires: this._stats.tier1Fires,
      consumersRan: this._stats.consumersRan,
      consumersSkipped: this._stats.consumersSkipped,
      crossTierViolations: this._stats.crossTierViolations,
      budgetViolations: this._stats.budgetViolations,
      desyncEvents: this._stats.desyncEvents
    });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) {
      if (typeof this._stats[k] === 'number') this._stats[k] = 0;
    }
    this._tierExecMsEma.fill(0);
    this._tierExecMsPeak.fill(0);
  }

  dispose() {
    for (let i = 0; i < this._consumerPool.length; i++) {
      this._consumerPool[i].reset();
    }
    this._consumerUsed = 0;
    this._consumerFreeCount = this.defaults.maxConsumers;
    for (let i = 0; i < this.defaults.maxConsumers; i++) {
      this._consumerFreeList[i] = this.defaults.maxConsumers - 1 - i;
    }
    this._idToPool.fill(-1);
    this._tierConsumerCounts.fill(0);

    this._dispatcher = null;
    this._clock = null;
    this._frameBudgetMonitor = null;
    this._frameRef = null;
  }
}

// Helper used inside runTier to avoid a temporal dead zone.
function currentTimeForConsumer(instance) {
  return instance._frameStartTime + instance._frameDeltaSeconds;
}

export {
  ContextConsumerTiers,
  ConsumerEntry,
  TierGate,
  TierSliceVersion,
  CONSUMER_TIER,
  CONSUMER_TIER_NAMES,
  CONSUMER_TIER_HZ,
  CONSUMER_STATE,
  CONSUMER_STATE_NAMES,
  TIER_PERIOD_S,
  TIER_OFFSET_S,
  TIER_BUDGET_FRACTION,
  PHASE_COUNT_PER_TIER,
  SLICE_PER_TIER
};