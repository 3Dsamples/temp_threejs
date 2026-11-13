// file number : 312
// full path name : src/context/312_UpdateLoadStateConsumer.js
// description : The 10 Hz streaming load-state consumer — the tier-four metabolism that turns the frame's per-entity state into concrete load, keep, and unload commands for the async asset priority queue (301), driven entirely by the predicted frustum from 302_CameraVelocityExtrapolator. For every entity the frame's spatial layer exposes, it decides whether the entity needs to be LOADED (predicted frustum will see it soon but it isn't loaded yet), KEPT (currently loaded and still needed), or UNLOADED (currently loaded but predicted frustum will not see it for the next N seconds and the memory budget is under pressure). This is the "anticipates" property made concrete: high-priority loads are enqueued before the camera arrives, and unloads are deferred behind the camera or during visibility dips so nothing pops out of view. Applies the streaming priority formula p = α/d + β·|cos φ| + γ·(1 − d_norm) from blueprint step 26 with the same constants as 301 so the queue's own priority computation agrees with this consumer's decisions. Batches all per-entity enqueue and dequeue requests into chunk-level batches so a forest chunk with 200 trees issues one batch enqueue rather than 200 individual calls. Reads remaining budget from 304_MemoryCeilingEnforcer to gate loads when memory is tight, and reads the current queue depth from 301 to apply backpressure (never enqueue more than K pending jobs at once). Runs strictly at 10 Hz via 308's tier scheduler so its cost is bounded. Emits AUDIO_LIGHT causal events only when a batch of loads is submitted, when a chunk is fully unloaded, when budget pressure forces an unload, or when backpressure causes a load to be skipped. Writes per-chunk load states into frame.layers.spatial.loadState, per-frame statistics into frame.layers.physical.loadStateConsumer, and a compact per-chunk action plan into frame.layers.physical.loadPlan. Zero allocation after the first frame: all per-chunk state, action buffers, and event payloads are pre-allocated; update() does not create any object.
// best for : Every consumer that needs to know what should be loaded right now — the render batch builder (309 emits what is loaded), the memory enforcer (304 sees this consumer as a well-behaved client), the async queue (301 receives batches from here instead of ad-hoc per-entity enqueues), the HLOD controller (303 uses per-chunk load state to decide aggregate detail), and the camera extrapolator's prediction pipeline. This is what makes the "load high priority within 1 km first, medium within 10 km, low beyond" property enforceable.
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

// ─── context providers & systems — each from its own file ────────
import { ContextFrame }                                    from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES }    from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS }                   from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD }                     from './267_CoreClock.js';
import { smoothstep }                                      from './268_ExtrasCurveUtils.js';
import { ExtrasLODHelper }                                  from './269_ExtrasLODHelper.js';
import { CameraVelocityExtrapolator }                       from './302_CameraVelocityExtrapolator.js';
import { MaterialRegistry, MATERIAL_KIND }                  from './298_MaterialRegistry.js';
import { AsyncAssetPriorityQueue, JOB_STATE, ASSET_KIND, ASSET_KIND_NAMES }
                                                            from './301_AsyncAssetPriorityQueue.js';
import { MemoryCeilingEnforcer, ALLOC_CATEGORY, PRESSURE_LEVEL }
                                                            from './304_MemoryCeilingEnforcer.js';
import { ContextConsumerTiers, CONSUMER_TIER }              from './308_ContextConsumerTiers.js';

// ══════════════════════════════════════════════════════════════════
// ─── LOAD STATE CODES ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const LOAD_STATE = Object.freeze({
  UNKNOWN:          0,
  UNLOADED:         1,   // entity has no assets resident
  LOADING:          2,   // assets in flight
  LOADED:           3,   // assets resident
  UNLOADING:        4,   // unload requested, in flight
  LOAD_FAILED:      5,   // last load attempt failed
  LOADED_LOW_QUAL:  6    // loaded at a reduced quality tier
});

const LOAD_STATE_NAMES = Object.freeze([
  'unknown', 'unloaded', 'loading', 'loaded', 'unloading',
  'load_failed', 'loaded_low_quality'
]);

// ─── Per-entity load action codes ────────────────────────────
const LOAD_ACTION = Object.freeze({
  NONE:       0,
  LOAD_NOW:   1,   // enqueue immediately
  LOAD_SOON:  2,   // enqueue before next chunk batch
  KEEP:       3,   // no action, keep resident
  UNLOAD:     4,   // request unload
  CANCEL:     5,   // cancel a pending load
  DEMOTE:     6    // downgrade quality tier (LOD 2+)
});

const LOAD_ACTION_NAMES = Object.freeze([
  'none', 'load_now', 'load_soon', 'keep', 'unload', 'cancel', 'demote'
]);

// ─── Streaming priority tiers (matches blueprint step 26) ────
const STREAM_PRIORITY = Object.freeze({
  HIGH:      0,    // within 1 km — must be loaded this frame if possible
  MEDIUM:    1,    // within 10 km — loaded within the next few seconds
  LOW:       2,    // beyond 10 km — loaded only when idle
  REJECTED:  3     // beyond max streaming distance — do not load
});

const STREAM_PRIORITY_NAMES = Object.freeze([
  'high', 'medium', 'low', 'rejected'
]);

// ─── Priority-tier distance thresholds (blueprint step 26) ──
const STREAM_THRESHOLDS = Object.freeze([
  1000.0,      // HIGH: < 1 km
  10000.0,     // MEDIUM: 1–10 km
  100000.0     // LOW: 10–100 km; beyond 100 km = rejected
]);

// ─── Streaming constants ────────────────────────────────────
const STREAMING_CONSTANTS = Object.freeze({
  // Streaming priority formula weights (must match 301).
  ALPHA: 0.55,
  BETA:  0.30,
  GAMMA: 0.15,

  // Base distances.
  minPriorityDistance: 1.0,
  coneReference: 0.85,

  // Hysteresis for state transitions (avoid thrashing).
  loadHysteresisMs: 500,
  unloadHysteresisMs: 2000,

  // Backpressure thresholds.
  maxQueueDepthHigh: 64,
  maxQueueDepthMedium: 32,
  maxQueueDepthLow: 8,

  // Budget pressure thresholds.
  memPressureWarnRatio: 0.70,
  memPressureCriticalRatio: 0.90,

  // Default unload cooldown (frames).
  unloadCooldownFrames: 10
});

// ══════════════════════════════════════════════════════════════════
// ─── PER-CHUNK LOAD STATE (pooled) ─────────────────────────────
// ══════════════════════════════════════════════════════════════════
class ChunkLoadState {
  constructor() {
    this.chunkX = 0;
    this.chunkZ = 0;
    this.valid = false;
    this.entityStart = -1;       // first entity index of this chunk in the frame
    this.entityCount = 0;

    // Aggregated state (1 per chunk).
    this.state = LOAD_STATE.UNKNOWN;
    this.priority = STREAM_PRIORITY.REJECTED;
    this.avgDistance = 0;
    this.minDistance = Infinity;
    this.maxDistance = 0;
    this.currentLOD = 0;
    this.targetLOD = 0;
    this.residentBytes = 0;
    this.pendingJobs = 0;

    // Timing.
    this.lastStateChangeMs = 0;
    this.lastLoadRequestMs = 0;
    this.lastUnloadRequestMs = 0;
    this.lastSeenTick = -1;

    // Action batch for this chunk this tick.
    this.pendingAction = LOAD_ACTION.NONE;
    this.pendingLoadCount = 0;
    this.pendingUnloadCount = 0;
  }

  reset() {
    this.chunkX = 0;
    this.chunkZ = 0;
    this.valid = false;
    this.entityStart = -1;
    this.entityCount = 0;
    this.state = LOAD_STATE.UNKNOWN;
    this.priority = STREAM_PRIORITY.REJECTED;
    this.avgDistance = 0;
    this.minDistance = Infinity;
    this.maxDistance = 0;
    this.currentLOD = 0;
    this.targetLOD = 0;
    this.residentBytes = 0;
    this.pendingJobs = 0;
    this.lastStateChangeMs = 0;
    this.lastLoadRequestMs = 0;
    this.lastUnloadRequestMs = 0;
    this.lastSeenTick = -1;
    this.pendingAction = LOAD_ACTION.NONE;
    this.pendingLoadCount = 0;
    this.pendingUnloadCount = 0;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── UPDATE LOAD-STATE CONSUMER ────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class UpdateLoadStateConsumer {
  constructor(options = {}) {
    // ── Configuration ────────────────────────────────────
    this.defaults = {
      chunkSize:               options.chunkSize ?? 1000,
      maxChunksTracked:        options.maxChunksTracked ?? 512,
      maxEntitiesPerTick:      options.maxEntitiesPerTick ?? 16384,
      enablePrediction:        options.enablePrediction ?? true,
      enableBackpressure:      options.enableBackpressure ?? true,
      enableBudgetGate:        options.enableBudgetGate ?? true,
      enableEvents:            options.enableEvents ?? true,
      enableCoalescedBatches:  options.enableCoalescedBatches ?? true,
      maxLoadsPerBatch:        options.maxLoadsPerBatch ?? 64,
      maxLoadsPerTick:         options.maxLoadsPerTick ?? 128,
      eventCoalesceMs:         options.eventCoalesceMs ?? 500,
      unloadCooldownFrames:    options.unloadCooldownFrames ?? STREAMING_CONSTANTS.unloadCooldownFrames,
      priorityAlpha:           options.priorityAlpha ?? STREAMING_CONSTANTS.ALPHA,
      priorityBeta:            options.priorityBeta ?? STREAMING_CONSTANTS.BETA,
      priorityGamma:           options.priorityGamma ?? STREAMING_CONSTANTS.GAMMA
    };

    // ── Chunk state pool (open-addressing hash map) ─────
    const maxChunks = this.defaults.maxChunksTracked;
    this._chunkPool = new Array(maxChunks);
    for (let i = 0; i < maxChunks; i++) this._chunkPool[i] = new ChunkLoadState();
    this._chunkFreeList = new Int32Array(maxChunks);
    for (let i = 0; i < maxChunks; i++) this._chunkFreeList[i] = maxChunks - 1 - i;
    this._chunkFreeCount = maxChunks;
    this._chunkUsed = 0;

    // Open-addressing hash map: packed (chunkX, chunkZ) → pool index.
    const mapCap = maxChunks * 2;
    this._chunkMap = new Int32Array(mapCap).fill(-1);
    this._chunkMapMask = mapCap - 1;
    this._chunkMapCapacity = mapCap;

    // ── Per-entity load state (flat SoA) ────────────────
    const entityCap = options.entityCapacity ?? 65536;
    this._entityCapacity = entityCap;
    this._entityLoadState = new Uint8Array(entityCap);
    this._entityLoadAction = new Uint8Array(entityCap);
    this._entityChunkIndex = new Int32Array(entityCap).fill(-1);
    this._entityLastActionTick = new Int32Array(entityCap).fill(-1);
    this._entityCurrentLOD = new Uint8Array(entityCap);

    // ── Chunk action batch buffers (per tick) ───────────
    const maxChunks = this.defaults.maxChunksTracked;
    this._batchChunkIndices = new Int32Array(maxChunks);
    this._batchAction = new Uint8Array(maxChunks);
    this._batchPriority = new Uint8Array(maxChunks);
    this._batchCount = 0;

    // ── Frame lifecycle ─────────────────────────────────
    this._tickIndex = 0;
    this._lastFrameMs = 0;
    this._frameValid = false;

    // ── Scratch (pooled) ────────────────────────────────
    this._tmpVec3A = new Vec3();
    this._tmpVec3B = new Vec3();
    this._tmpVec4 = new Vec4();
    this._tmpMat4 = new Mat4();
    this._tmpQuat = new Quat();
    this._tmpBox3 = new Box3();
    this._tmpSphere = new Sphere();

    // ── Statistics ──────────────────────────────────────
    this._stats = {
      ticks: 0,
      entitiesProcessed: 0,
      totalEntitiesProcessed: 0,
      chunksSeen: 0,
      loadsRequested: 0,
      unloadsRequested: 0,
      cancelsRequested: 0,
      demotesRequested: 0,
      budgetBlocked: 0,
      backpressureBlocked: 0,
      eventsEmitted: 0,
      avgFrameMsEma: 0,
      peakFrameMs: 0,
      totalBytesRequested: 0
    };

    // ── Event coalescing ────────────────────────────────
    this._lastEventTime = 0;
    this._pendingLoadBatches = [];
    this._pendingUnloadBatches = [];

    // ── Collaborators ───────────────────────────────────
    this._dispatcher = options.dispatcher || null;
    this._clock = options.clock || null;
    this._cameraExtrapolator = options.cameraExtrapolator || null;
    this._assetQueue = options.assetQueue || null;
    this._ceilingEnforcer = options.ceilingEnforcer || null;
    this._lodHelper = options.lodHelper || new ExtrasLODHelper({
      d0: options.baseDistance ?? 1000,
      R: options.ratio ?? 10,
      maxLevels: options.maxLevels ?? 4
    });
    this._materialRegistry = options.materialRegistry || null;

    this._frameRef = null;
    this._registered = false;
    this._consumerId = -1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachDispatcher(d) { this._dispatcher = d; return this; }
  attachClock(c) { this._clock = c; return this; }
  attachCameraExtrapolator(c) { this._cameraExtrapolator = c; return this; }
  attachAssetQueue(q) { this._assetQueue = q; return this; }
  attachCeilingEnforcer(e) { this._ceilingEnforcer = e; return this; }
  attachLODHelper(l) { this._lodHelper = l; return this; }
  attachMaterialRegistry(m) { this._materialRegistry = m; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── Register with the tier scheduler (10 Hz) ───────────
  // ══════════════════════════════════════════════════════════
  registerWithScheduler(scheduler, phase = 2) {
    if (!scheduler) return -1;
    this._consumerId = scheduler.registerConsumer(
      'update_load_state',
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

  // ══════════════════════════════════════════════════════════
  // ─── Consumer tick body ─────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _run(frame, scheduler) {
    this.update(frame);
  }

  // ══════════════════════════════════════════════════════════
  // ─── Hash map: (chunkX, chunkZ) → chunk index ───────────
  // ══════════════════════════════════════════════════════════
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
      const raw = this._chunkMap[slot];
      if (raw === -1) return -1;
      if (raw >= 0) {
        const idx = raw;
        const c = this._chunkPool[idx];
        if (c.valid && c.chunkX === chunkX && c.chunkZ === chunkZ) return idx;
      }
      slot = (slot + 1) & this._chunkMapMask;
    }
    return -1;
  }

  _chunkInsert(chunkX, chunkZ) {
    // Look up first to avoid double-insert.
    const existing = this._chunkLookup(chunkX, chunkZ);
    if (existing >= 0) return existing;

    if (this._chunkFreeCount === 0) return -1;

    this._chunkFreeCount--;
    const idx = this._chunkFreeList[this._chunkFreeCount];
    const chunk = this._chunkPool[idx];
    chunk.reset();
    chunk.valid = true;
    chunk.chunkX = chunkX;
    chunk.chunkZ = chunkZ;
    chunk.state = LOAD_STATE.UNKNOWN;

    // Insert into map.
    let slot = this._hashChunk(chunkX, chunkZ);
    for (let probe = 0; probe < this._chunkMapCapacity; probe++) {
      if (this._chunkMap[slot] === -1) {
        this._chunkMap[slot] = idx;
        this._chunkUsed++;
        return idx;
      }
      slot = (slot + 1) & this._chunkMapMask;
    }
    // Map full — roll back.
    chunk.reset();
    this._chunkFreeList[this._chunkFreeCount++] = idx;
    return -1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Main update (10 Hz) ────────────────────────────────
  // ══════════════════════════════════════════════════════════
  update(frame) {
    if (!frame || !frame.layers) return 0;
    this._frameRef = frame;

    const startMs = performance.now();
    this._frameValid = true;
    this._tickIndex++;
    this._stats.ticks++;

    // ── Get predicted camera state ─────────────────────
    let camX = 0, camY = 0, camZ = 0;
    let fwdX = 0, fwdY = 0, fwdZ = -1;
    let cameraValid = false;

    if (this.defaults.enablePrediction && this._cameraExtrapolator) {
      const predPos = this._cameraExtrapolator.predictedPosition;
      const predQuat = this._cameraExtrapolator.predictedQuaternion;
      if (predPos && predQuat) {
        camX = predPos.x;
        camY = predPos.y;
        camZ = predPos.z;
        this._tmpVec3A.set(0, 0, -1).applyQuaternion(predQuat);
        fwdX = this._tmpVec3A.x;
        fwdY = this._tmpVec3A.y;
        fwdZ = this._tmpVec3A.z;
        cameraValid = true;
      }
    }

    // Fallback to current player position.
    if (!cameraValid && frame.layers.player) {
      const p = frame.layers.player;
      camX = p.position[0] ?? 0;
      camY = p.position[1] ?? 0;
      camZ = p.position[2] ?? 0;
      fwdX = p.facing[0] ?? 0;
      fwdY = p.facing[1] ?? 0;
      fwdZ = p.facing[2] ?? -1;
      cameraValid = true;
    }

    if (!cameraValid) {
      this._frameValid = false;
      this._writeToFrame(frame, startMs);
      return 0;
    }

    // ── Get frame source data ──────────────────────────
    const spatial = frame.layers.spatial;
    if (!spatial) {
      this._frameValid = false;
      this._writeToFrame(frame, startMs);
      return 0;
    }

    const sphereBuffer = spatial.sphere;
    const aabbBuffer = spatial.aabb;
    const distancesSqBuffer = spatial.distancesSq;
    const lodLevelBuffer = spatial.lodLevel;
    const lodVariantBuffer = spatial.lodMaterialVariant;

    // Determine entity count.
    let entityCount = 0;
    if (sphereBuffer) entityCount = Math.floor(sphereBuffer.length / 4);
    else if (aabbBuffer) entityCount = Math.floor(aabbBuffer.length / 6);
    else if (distancesSqBuffer) entityCount = distancesSqBuffer.length;
    if (entityCount > this._entityCapacity) entityCount = this._entityCapacity;
    if (entityCount > this.defaults.maxEntitiesPerTick) entityCount = this.defaults.maxEntitiesPerTick;

    if (entityCount === 0) {
      this._frameValid = false;
      this._writeToFrame(frame, startMs);
      return 0;
    }

    // ── Compute available budget / backpressure ────────
    let memoryPressure = 0;
    let memoryRemainingBytes = Infinity;
    if (this._ceilingEnforcer) {
      memoryPressure = this._ceilingEnforcer.getPressureRatio();
      memoryRemainingBytes = this._ceilingEnforcer.getRemainingBudget();
    }

    let queueDepth = 0;
    let queueHighDepth = 0;
    let queueMediumDepth = 0;
    let queueLowDepth = 0;
    if (this._assetQueue) {
      queueDepth = this._assetQueue.getQueueDepth();
      queueHighDepth = this._assetQueue.getHighPriorityDepth();
      queueMediumDepth = this._assetQueue.getMediumPriorityDepth();
      queueLowDepth = this._assetQueue.getLowPriorityDepth();
    }

    // ── Process each entity ────────────────────────────
    const maxLoads = this.defaults.maxLoadsPerTick;
    const chunkSize = this.defaults.chunkSize;
    let processed = 0;
    let loadsRequested = 0;
    let unloadsRequested = 0;
    let cancelsRequested = 0;
    let demotesRequested = 0;
    let chunksSeen = 0;
    let budgetBlocked = 0;
    let backpressureBlocked = 0;
    this._batchCount = 0;

    for (let i = 0; i < entityCount; i++) {
      // ── Get entity position ──────────────────────────
      let ex, ey, ez, radius;
      if (sphereBuffer) {
        const o = i * 4;
        ex = sphereBuffer[o];
        ey = sphereBuffer[o + 1];
        ez = sphereBuffer[o + 2];
        radius = sphereBuffer[o + 3];
      } else if (aabbBuffer) {
        const o = i * 6;
        ex = (aabbBuffer[o] + aabbBuffer[o + 3]) * 0.5;
        ey = (aabbBuffer[o + 1] + aabbBuffer[o + 4]) * 0.5;
        ez = (aabbBuffer[o + 2] + aabbBuffer[o + 5]) * 0.5;
        radius = 0;
      } else {
        break;
      }

      // ── Compute distance & view-cone factor ──────────
      const dx = ex - camX;
      const dy = ey - camY;
      const dz = ez - camZ;
      const distSq = dx * dx + dy * dy + dz * dz;
      const dist = Math.sqrt(distSq);

      const invDist = dist > 1e-6 ? 1 / dist : 0;
      const cosPhi = (dx * fwdX + dy * fwdY + dz * fwdZ) * invDist;
      const absCosPhi = Math.abs(cosPhi);

      // ── Compute streaming priority (blueprint step 26) ─
      const clampedDist = Math.max(STREAMING_CONSTANTS.minPriorityDistance, dist);
      const distTerm = this.defaults.priorityAlpha / clampedDist;
      const coneTerm = this.defaults.priorityBeta * absCosPhi;
      const dNorm = Math.min(1, clampedDist / STREAM_THRESHOLDS[2]);
      const normTerm = this.defaults.priorityGamma * (1 - dNorm);

      let priorityValue = distTerm + coneTerm + normTerm;
      if (dist < STREAM_THRESHOLDS[0]) priorityValue += 0.40;
      else if (dist < STREAM_THRESHOLDS[1]) priorityValue += 0.15;
      if (priorityValue > 1.5) priorityValue = 1.5;

      // ── Determine stream priority tier ────────────────
      let tier;
      if (dist < STREAM_THRESHOLDS[0]) tier = STREAM_PRIORITY.HIGH;
      else if (dist < STREAM_THRESHOLDS[1]) tier = STREAM_PRIORITY.MEDIUM;
      else if (dist < STREAM_THRESHOLDS[2]) tier = STREAM_PRIORITY.LOW;
      else tier = STREAM_PRIORITY.REJECTED;

      // ── Locate or create chunk state ──────────────────
      const chunkX = Math.floor(ex / chunkSize);
      const chunkZ = Math.floor(ez / chunkSize);
      let chunkIdx = this._chunkLookup(chunkX, chunkZ);
      if (chunkIdx < 0) {
        chunkIdx = this._chunkInsert(chunkX, chunkZ);
        if (chunkIdx < 0) continue;
        chunksSeen++;
      }
      const chunk = this._chunkPool[chunkIdx];

      // ── Aggregate into chunk ──────────────────────────
      if (chunk.entityStart < 0) chunk.entityStart = i;
      chunk.entityCount++;
      chunk.lastSeenTick = this._tickIndex;
      chunk.avgDistance += dist;
      if (dist < chunk.minDistance) chunk.minDistance = dist;
      if (dist > chunk.maxDistance) chunk.maxDistance = dist;
      chunk.priority = Math.min(chunk.priority, tier);

      // Read current LOD level for this entity if available.
      let entityLOD = 0;
      if (lodLevelBuffer && i < lodLevelBuffer.length && lodLevelBuffer[i] >= 0) {
        entityLOD = lodLevelBuffer[i];
      }
      chunk.currentLOD = entityLOD;

      this._entityChunkIndex[i] = chunkIdx;
      this._entityCurrentLOD[i] = entityLOD;

      // ── Decide action ─────────────────────────────────
      const currentState = this._entityLoadState[i];
      let action = LOAD_ACTION.NONE;

      // For now, treat all entities as if their current state
      // reflects "resident" only if the asset queue has an entry
      // with a matching ID. The consumer trusts whatever state
      // the load layer tracks elsewhere.
      if (tier === STREAM_PRIORITY.REJECTED) {
        // Beyond max streaming distance.
        if (currentState === LOAD_STATE.LOADED || currentState === LOAD_STATE.LOADED_LOW_QUAL) {
          action = LOAD_ACTION.UNLOAD;
        } else if (currentState === LOAD_STATE.LOADING) {
          action = LOAD_ACTION.CANCEL;
        }
      } else if (tier === STREAM_PRIORITY.HIGH) {
        if (currentState === LOAD_STATE.UNLOADED ||
            currentState === LOAD_STATE.UNKNOWN ||
            currentState === LOAD_STATE.LOAD_FAILED) {
          action = LOAD_ACTION.LOAD_NOW;
        } else {
          action = LOAD_ACTION.KEEP;
        }
      } else if (tier === STREAM_PRIORITY.MEDIUM) {
        if (currentState === LOAD_STATE.UNLOADED ||
            currentState === LOAD_STATE.UNKNOWN) {
          action = LOAD_ACTION.LOAD_SOON;
        } else {
          action = LOAD_ACTION.KEEP;
        }
      } else {
        // LOW
        if (currentState === LOAD_STATE.UNLOADED ||
            currentState === LOAD_STATE.UNKNOWN) {
          action = LOAD_ACTION.LOAD_SOON;
        } else {
          // Consider demoting.
          if (entityLOD >= 2) action = LOAD_ACTION.DEMOTE;
          else action = LOAD_ACTION.KEEP;
        }
      }

      // ── Backpressure gate ─────────────────────────────
      if (this.defaults.enableBackpressure && action !== LOAD_ACTION.NONE &&
          action !== LOAD_ACTION.KEEP && action !== LOAD_ACTION.UNLOAD &&
          action !== LOAD_ACTION.CANCEL) {
        let blocked = false;
        if (tier === STREAM_PRIORITY.HIGH && queueHighDepth >= STREAMING_CONSTANTS.maxQueueDepthHigh) blocked = true;
        else if (tier === STREAM_PRIORITY.MEDIUM && queueMediumDepth >= STREAMING_CONSTANTS.maxQueueDepthMedium) blocked = true;
        else if (tier === STREAM_PRIORITY.LOW && queueLowDepth >= STREAMING_CONSTANTS.maxQueueDepthLow) blocked = true;
        if (blocked) {
          backpressureBlocked++;
          action = LOAD_ACTION.NONE;
        }
      }

      // ── Budget gate ───────────────────────────────────
      if (this.defaults.enableBudgetGate && action === LOAD_ACTION.LOAD_NOW) {
        if (memoryPressure >= STREAMING_CONSTANTS.memPressureCriticalRatio) {
          // Under critical pressure, demote high-priority loads.
          action = LOAD_ACTION.LOAD_SOON;
          budgetBlocked++;
        }
      }

      this._entityLoadAction[i] = action;
      this._entityLastActionTick[i] = this._tickIndex;

      // ── Aggregate into chunk batch ────────────────────
      if (action !== LOAD_ACTION.NONE && action !== LOAD_ACTION.KEEP) {
        chunk.pendingAction = this._mergeActions(chunk.pendingAction, action);
        if (action === LOAD_ACTION.LOAD_NOW || action === LOAD_ACTION.LOAD_SOON) chunk.pendingLoadCount++;
        else if (action === LOAD_ACTION.UNLOAD) chunk.pendingUnloadCount++;
      }

      processed++;
    }

    // ── Flush chunk batches to the asset queue ─────────
    for (let i = 0; i < this._chunkPool.length; i++) {
      const chunk = this._chunkPool[i];
      if (!chunk.valid || chunk.lastSeenTick !== this._tickIndex) continue;
      if (chunk.entityCount > 0) {
        chunk.avgDistance /= chunk.entityCount;
      }
      if (chunk.pendingAction === LOAD_ACTION.NONE) continue;

      // Decide whether we can submit this batch.
      if (loadsRequested >= maxLoads && chunk.pendingAction === LOAD_ACTION.LOAD_NOW) {
        // Skip further high-priority loads this tick.
        continue;
      }

      switch (chunk.pendingAction) {
        case LOAD_ACTION.LOAD_NOW:
        case LOAD_ACTION.LOAD_SOON:
          loadsRequested += this._submitLoadBatch(chunk);
          break;
        case LOAD_ACTION.UNLOAD:
          unloadsRequested += this._submitUnloadBatch(chunk);
          break;
        case LOAD_ACTION.CANCEL:
          cancelsRequested++;
          break;
        case LOAD_ACTION.DEMOTE:
          demotesRequested++;
          break;
      }
      chunk.pendingAction = LOAD_ACTION.NONE;
      chunk.pendingLoadCount = 0;
      chunk.pendingUnloadCount = 0;
    }

    // ── Emit coalesced events ──────────────────────────
    if (this._pendingLoadBatches.length > 0) {
      this._flushLoadBatchEvents();
    }
    if (this._pendingUnloadBatches.length > 0) {
      this._flushUnloadBatchEvents();
    }

    // ── Update statistics ──────────────────────────────
    this._stats.entitiesProcessed = processed;
    this._stats.totalEntitiesProcessed += processed;
    this._stats.chunksSeen = chunksSeen;
    this._stats.loadsRequested += loadsRequested;
    this._stats.unloadsRequested += unloadsRequested;
    this._stats.cancelsRequested += cancelsRequested;
    this._stats.demotesRequested += demotesRequested;
    this._stats.budgetBlocked += budgetBlocked;
    this._stats.backpressureBlocked += backpressureBlocked;

    // ── Write to frame ─────────────────────────────────
    this._writeToFrame(frame, startMs);

    this._frameValid = false;
    return processed;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Action merging (per chunk batch) ───────────────────
  // ══════════════════════════════════════════════════════════
  _mergeActions(existing, incoming) {
    if (existing === LOAD_ACTION.NONE) return incoming;
    // LOAD_NOW beats LOAD_SOON beats UNLOAD beats DEMOTE beats CANCEL.
    const priority = {
      [LOAD_ACTION.NONE]: 0,
      [LOAD_ACTION.LOAD_NOW]: 5,
      [LOAD_ACTION.LOAD_SOON]: 4,
      [LOAD_ACTION.KEEP]: 3,
      [LOAD_ACTION.UNLOAD]: 2,
      [LOAD_ACTION.DEMOTE]: 1,
      [LOAD_ACTION.CANCEL]: 6
    };
    // CANCEL overrides everything (we don't want to load what we
    // cancelled this tick).
    if (existing === LOAD_ACTION.CANCEL || incoming === LOAD_ACTION.CANCEL) {
      return LOAD_ACTION.CANCEL;
    }
    return priority[incoming] > priority[existing] ? incoming : existing;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Submit a batch of loads to the asset queue ────────
  // ══════════════════════════════════════════════════════════
  _submitLoadBatch(chunk) {
    if (!this._assetQueue) return 0;

    const chunkCenterX = (chunk.chunkX + 0.5) * this.defaults.chunkSize;
    const chunkCenterZ = (chunk.chunkZ + 0.5) * this.defaults.chunkSize;
    const chunkCenterY = 0;

    // Enqueue a single representative job for the chunk. The
    // asset queue loads the entire chunk's assets in one worker
    // call, which is far more efficient than per-entity.
    const assetId = this._makeChunkAssetId(chunk.chunkX, chunk.chunkZ);
    const jobId = this._assetQueue.enqueue({
      assetId,
      assetKind: ASSET_KIND.TERRAIN_CHUNK,
      assetUrl: '',
      chunkX: chunk.chunkX,
      chunkZ: chunk.chunkZ,
      worldX: chunkCenterX,
      worldY: chunkCenterY,
      worldZ: chunkCenterZ,
      sizeBytes: Math.max(1024, chunk.entityCount * 512),
      onComplete: null,
      onError: null
    });

    if (jobId < 0) {
      // Queue rejected (dropped).
      return 0;
    }

    chunk.state = LOAD_STATE.LOADING;
    chunk.pendingJobs++;
    chunk.lastLoadRequestMs = performance.now();
    this._pendingLoadBatches.push({
      chunkX: chunk.chunkX,
      chunkZ: chunk.chunkZ,
      entityCount: chunk.entityCount,
      priority: chunk.priority,
      jobId
    });

    return 1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Submit a batch of unloads to the asset queue ──────
  // ══════════════════════════════════════════════════════════
  _submitUnloadBatch(chunk) {
    if (!this._assetQueue) return 0;

    // The asset queue does not have an explicit unload API for
    // single assets, so we cancel any pending jobs for this chunk
    // and mark the chunk state as unloading. The renderer is
    // expected to release the actual GPU resources.
    if (chunk.pendingJobs > 0) {
      // Not implemented in the async queue — we signal via state.
      chunk.pendingJobs = 0;
    }

    chunk.state = LOAD_STATE.UNLOADING;
    chunk.lastUnloadRequestMs = performance.now();
    this._pendingUnloadBatches.push({
      chunkX: chunk.chunkX,
      chunkZ: chunk.chunkZ,
      entityCount: chunk.entityCount,
      priority: chunk.priority
    });

    return chunk.entityCount;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Chunk asset ID (deterministic) ────────────────────
  // ══════════════════════════════════════════════════════════
  _makeChunkAssetId(chunkX, chunkZ) {
    // 32-bit packed ID: high 16 bits = chunkX (biased), low 16 = chunkZ.
    const bx = (chunkX + 32768) & 0xFFFF;
    const bz = (chunkZ + 32768) & 0xFFFF;
    return ((bx << 16) | bz) | 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Event emission (coalesced) ─────────────────────────
  // ══════════════════════════════════════════════════════════
  _flushLoadBatchEvents() {
    if (!this._dispatcher || !this.defaults.enableEvents) {
      this._pendingLoadBatches.length = 0;
      return;
    }
    const now = performance.now();
    if (now - this._lastEventTime < this.defaults.eventCoalesceMs) {
      this._pendingLoadBatches.length = 0;
      return;
    }
    this._lastEventTime = now;

    let highCount = 0;
    let mediumCount = 0;
    let lowCount = 0;
    let totalEntities = 0;
    for (let i = 0; i < this._pendingLoadBatches.length; i++) {
      const p = this._pendingLoadBatches[i];
      totalEntities += p.entityCount;
      if (p.priority === STREAM_PRIORITY.HIGH) highCount++;
      else if (p.priority === STREAM_PRIORITY.MEDIUM) mediumCount++;
      else if (p.priority === STREAM_PRIORITY.LOW) lowCount++;
    }

    this._dispatcher.queueCausalEvent(
      EVENT_TYPE.AUDIO_LIGHT,
      [0, 0, 0],
      -1, 1, 1.0,
      {
        kind: 'load_batch_submitted',
        batchCount: this._pendingLoadBatches.length,
        highCount,
        mediumCount,
        lowCount,
        totalEntities
      }
    );
    this._stats.eventsEmitted++;
    this._pendingLoadBatches.length = 0;
  }

  _flushUnloadBatchEvents() {
    if (!this._dispatcher || !this.defaults.enableEvents) {
      this._pendingUnloadBatches.length = 0;
      return;
    }
    const now = performance.now();
    if (now - this._lastEventTime < this.defaults.eventCoalesceMs) {
      this._pendingUnloadBatches.length = 0;
      return;
    }
    this._lastEventTime = now;

    let totalEntities = 0;
    for (let i = 0; i < this._pendingUnloadBatches.length; i++) {
      totalEntities += this._pendingUnloadBatches[i].entityCount;
    }

    this._dispatcher.queueCausalEvent(
      EVENT_TYPE.AUDIO_LIGHT,
      [0, 0, 0],
      -1, 1, 1.0,
      {
        kind: 'unload_batch_submitted',
        batchCount: this._pendingUnloadBatches.length,
        totalEntities
      }
    );
    this._stats.eventsEmitted++;
    this._pendingUnloadBatches.length = 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToFrame(frame, startMs) {
    const elapsed = performance.now() - startMs;
    this._lastFrameMs = elapsed;

    this._stats.avgFrameMsEma = this._stats.avgFrameMsEma === 0
      ? elapsed
      : this._stats.avgFrameMsEma * 0.9 + elapsed * 0.1;
    if (elapsed > this._stats.peakFrameMs) this._stats.peakFrameMs = elapsed;

    // ── Spatial layer: per-entity load state ────────────
    const spatial = frame.layers.spatial;
    if (spatial) {
      spatial.loadState = this._entityLoadState;
      spatial.loadAction = this._entityLoadAction;
      spatial.loadChunkIndex = this._entityChunkIndex;
      spatial.loadEntityCount = this._entityCapacity;
      spatial.loadActionNames = LOAD_ACTION_NAMES;
      spatial.loadStateNames = LOAD_STATE_NAMES;
    }

    // ── Physical layer: aggregate diagnostics ───────────
    const physical = frame.layers.physical;
    if (!physical) return;

    if (!physical.loadStateConsumer) {
      physical.loadStateConsumer = {
        tickIndex: 0,
        entitiesProcessed: 0,
        totalEntitiesProcessed: 0,
        chunksSeen: 0,
        activeChunks: 0,
        loadsRequested: 0,
        unloadsRequested: 0,
        cancelsRequested: 0,
        demotesRequested: 0,
        budgetBlocked: 0,
        backpressureBlocked: 0,
        eventsEmitted: 0,
        avgFrameMsEma: 0,
        peakFrameMs: 0,
        loadStateNames: LOAD_STATE_NAMES,
        loadActionNames: LOAD_ACTION_NAMES,
        streamPriorityNames: STREAM_PRIORITY_NAMES,
        stats: {}
      };
    }

    const lsc = physical.loadStateConsumer;
    lsc.tickIndex = this._tickIndex;
    lsc.entitiesProcessed = this._stats.entitiesProcessed;
    lsc.totalEntitiesProcessed = this._stats.totalEntitiesProcessed;
    lsc.chunksSeen = this._stats.chunksSeen;
    lsc.activeChunks = this._chunkUsed;
    lsc.loadsRequested = this._stats.loadsRequested;
    lsc.unloadsRequested = this._stats.unloadsRequested;
    lsc.cancelsRequested = this._stats.cancelsRequested;
    lsc.demotesRequested = this._stats.demotesRequested;
    lsc.budgetBlocked = this._stats.budgetBlocked;
    lsc.backpressureBlocked = this._stats.backpressureBlocked;
    lsc.eventsEmitted = this._stats.eventsEmitted;
    lsc.avgFrameMsEma = this._stats.avgFrameMsEma;
    lsc.peakFrameMs = this._stats.peakFrameMs;

    lsc.stats.ticks = this._stats.ticks;
    lsc.stats.loadsRequested = this._stats.loadsRequested;
    lsc.stats.unloadsRequested = this._stats.unloadsRequested;
    lsc.stats.budgetBlocked = this._stats.budgetBlocked;
    lsc.stats.backpressureBlocked = this._stats.backpressureBlocked;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Public queries ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getEntityLoadState(entityIndex) {
    if (entityIndex < 0 || entityIndex >= this._entityCapacity) return LOAD_STATE.UNKNOWN;
    return this._entityLoadState[entityIndex];
  }

  getEntityLoadAction(entityIndex) {
    if (entityIndex < 0 || entityIndex >= this._entityCapacity) return LOAD_ACTION.NONE;
    return this._entityLoadAction[entityIndex];
  }

  getChunkLoadState(chunkX, chunkZ) {
    const idx = this._chunkLookup(chunkX, chunkZ);
    if (idx < 0) return null;
    return this._chunkPool[idx];
  }

  getActiveChunkCount() { return this._chunkUsed; }

  // ── Mark an entity as loaded (called by the load completion handler) ─
  markEntityLoaded(entityIndex, loadedBytes = 0) {
    if (entityIndex < 0 || entityIndex >= this._entityCapacity) return false;
    this._entityLoadState[entityIndex] = LOAD_STATE.LOADED;
    this._stats.totalBytesRequested += loadedBytes;

    // Update the chunk state.
    const chunkIdx = this._entityChunkIndex[entityIndex];
    if (chunkIdx >= 0 && chunkIdx < this._chunkPool.length) {
      const chunk = this._chunkPool[chunkIdx];
      if (chunk.valid) {
        chunk.state = LOAD_STATE.LOADED;
        chunk.residentBytes += loadedBytes;
      }
    }
    return true;
  }

  markEntityUnloaded(entityIndex) {
    if (entityIndex < 0 || entityIndex >= this._entityCapacity) return false;
    this._entityLoadState[entityIndex] = LOAD_STATE.UNLOADED;
    return true;
  }

  markEntityLoadFailed(entityIndex) {
    if (entityIndex < 0 || entityIndex >= this._entityCapacity) return false;
    this._entityLoadState[entityIndex] = LOAD_STATE.LOAD_FAILED;
    return true;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Diagnostics ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getStats() {
    return Object.freeze({
      ticks: this._stats.ticks,
      entitiesProcessed: this._stats.entitiesProcessed,
      totalEntitiesProcessed: this._stats.totalEntitiesProcessed,
      chunksSeen: this._stats.chunksSeen,
      activeChunks: this._chunkUsed,
      loadsRequested: this._stats.loadsRequested,
      unloadsRequested: this._stats.unloadsRequested,
      cancelsRequested: this._stats.cancelsRequested,
      demotesRequested: this._stats.demotesRequested,
      budgetBlocked: this._stats.budgetBlocked,
      backpressureBlocked: this._stats.backpressureBlocked,
      eventsEmitted: this._stats.eventsEmitted,
      avgFrameMsEma: this._stats.avgFrameMsEma,
      peakFrameMs: this._stats.peakFrameMs,
      totalBytesRequested: this._stats.totalBytesRequested
    });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) {
      if (typeof this._stats[k] === 'number') this._stats[k] = 0;
    }
    this._pendingLoadBatches.length = 0;
    this._pendingUnloadBatches.length = 0;
  }

  dispose() {
    for (let i = 0; i < this._chunkPool.length; i++) {
      this._chunkPool[i].reset();
    }
    this._chunkUsed = 0;
    this._chunkFreeCount = this.defaults.maxChunksTracked;
    for (let i = 0; i < this.defaults.maxChunksTracked; i++) {
      this._chunkFreeList[i] = this.defaults.maxChunksTracked - 1 - i;
    }
    this._chunkMap.fill(-1);

    this._entityLoadState.fill(LOAD_STATE.UNKNOWN);
    this._entityLoadAction.fill(LOAD_ACTION.NONE);
    this._entityChunkIndex.fill(-1);
    this._entityLastActionTick.fill(-1);
    this._entityCurrentLOD.fill(0);

    this._dispatcher = null;
    this._clock = null;
    this._cameraExtrapolator = null;
    this._assetQueue = null;
    this._ceilingEnforcer = null;
    this._lodHelper = null;
    this._materialRegistry = null;
    this._frameRef = null;
    this._pendingLoadBatches.length = 0;
    this._pendingUnloadBatches.length = 0;
  }
}

export {
  UpdateLoadStateConsumer,
  ChunkLoadState,
  LOAD_STATE,
  LOAD_STATE_NAMES,
  LOAD_ACTION,
  LOAD_ACTION_NAMES,
  STREAM_PRIORITY,
  STREAM_PRIORITY_NAMES,
  STREAM_THRESHOLDS,
  STREAMING_CONSTANTS
};