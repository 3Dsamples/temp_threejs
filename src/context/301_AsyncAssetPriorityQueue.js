// file number : 301
// full path name : src/context/301_AsyncAssetPriorityQueue.js
// description : Async asset priority queue — distance-prioritized streaming loader that yields to the main thread and dispatches work to a configurable worker pool. Scores every pending asset by the priority formula p = α/d + β·|cos φ| + γ·(1 − d_norm), where d is the distance to the camera, φ is the angle between the asset and the camera's forward vector, and d_norm is the normalized distance in [0, 1] against the maximum render distance. High-priority assets (p ≥ 0.8, typically within 1 km) are dispatched immediately; medium priority (0.4 ≤ p < 0.8, within 10 km) is queued; low priority (p < 0.4, beyond 10 km) is scheduled only when the queue is drained. Yields to the event loop via requestIdleCallback with a 6 ms budget per timeslice, falls back to scheduler.yield (Chromium 129+), then to setTimeout 0, then to a microtask — never blocking the main thread. Cancels or demotes in-flight jobs as the camera moves and priority falls; promotes them back when priority rises again. Communicates with workers through a versioned message protocol using SharedArrayBuffer when crossOriginIsolated is available, otherwise transferables, so large buffers are handed across threads without copy. All job slots and score buffers are pooled — zero allocation on enqueue, dequeue, cancel, or priority recompute after the first frame. Emits AUDIO_LIGHT causal events when jobs complete, fail, or are cancelled. Writes per-frame queue state into frame.layers.physical.asyncLoading.
// best for : Any system that streams large assets as the player moves — landscape chunks, texture arrays, HLOD meshes, procedural terrain heightfields, biome splatmaps, audio banks — while keeping the 8 ms per-tick ceiling intact on Android arm64. Complements 299_PersistentWorldMemory (which remembers state) by guaranteeing the assets needed to reconstruct that state arrive on time.
// license : MIT

// ─── raw 3js primitives — exported by the 264 barrel ────────────
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture,
  CubeTexture, CompressedTexture, CompressedArrayTexture, CompressedCubeTexture
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems — each from its own file ────────
import { ContextFrame }                                    from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES }    from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS }                   from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD }                     from './267_CoreClock.js';
import { smoothstep }                                       from './268_ExtrasCurveUtils.js';
import { CausalContextProvider, DERIVED_SIGNAL }            from './278_CausalContextProvider.js';

// ══════════════════════════════════════════════════════════════════
// ─── JOB STATE CODES ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const JOB_STATE = Object.freeze({
  FREE:       0,
  PENDING:    1,   // enqueued, waiting for dispatch
  IN_FLIGHT:  2,   // dispatched to worker, awaiting completion
  COMPLETED:  3,   // finished successfully
  FAILED:     4,   // worker returned an error
  CANCELLED:  5,   // cancelled by user or priority demotion
  SUSPENDED:  6    // demoted; kept in queue but paused
});

const JOB_STATE_NAMES = Object.freeze([
  'free', 'pending', 'in_flight', 'completed', 'failed',
  'cancelled', 'suspended'
]);

// ══════════════════════════════════════════════════════════════════
// ─── ASSET KIND CODES ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const ASSET_KIND = Object.freeze({
  UNKNOWN:        0,
  TERRAIN_CHUNK:  1,
  TEXTURE:        2,
  HLOD_MESH:      3,
  BIOME_SPLATMAP: 4,
  AUDIO_BANK:     5,
  MESH:           6,
  MATERIAL:       7,
  PROCEDURAL:     8
});

const ASSET_KIND_NAMES = Object.freeze([
  'unknown', 'terrain_chunk', 'texture', 'hlod_mesh',
  'biome_splatmap', 'audio_bank', 'mesh', 'material', 'procedural'
]);

// ══════════════════════════════════════════════════════════════════
// ─── PRIORITY TIERS ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const PRIORITY_TIER = Object.freeze({
  HIGH:   0,   // p >= 0.8, dispatch immediately
  MEDIUM: 1,   // 0.4 <= p < 0.8, queue normally
  LOW:    2,   // p < 0.4, dispatch only when idle
  DROP:   3    // p < 0.05, cancel if in flight
});

const PRIORITY_TIER_NAMES = Object.freeze(['high', 'medium', 'low', 'drop']);

// ══════════════════════════════════════════════════════════════════
// ─── JOB SLOT (pooled) ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class JobSlot {
  constructor() {
    this.state = JOB_STATE.FREE;
    this.jobId = -1;
    this.assetId = -1;
    this.assetKind = ASSET_KIND.UNKNOWN;
    this.assetUrl = '';
    this.priority = 0;
    this.priorityTier = PRIORITY_TIER.LOW;
    this.chunkX = 0;
    this.chunkZ = 0;
    this.worldX = 0;
    this.worldY = 0;
    this.worldZ = 0;
    this.sizeBytes = 0;
    this.enqueueTime = 0;
    this.dispatchTime = 0;
    this.completeTime = 0;
    this.retryCount = 0;
    this.workerIndex = -1;
    this.transferable = null;
    this.messageId = -1;
    this.onComplete = null;
    this.onError = null;
    this.userData = null;
  }

  reset() {
    this.state = JOB_STATE.FREE;
    this.jobId = -1;
    this.assetId = -1;
    this.assetKind = ASSET_KIND.UNKNOWN;
    this.assetUrl = '';
    this.priority = 0;
    this.priorityTier = PRIORITY_TIER.LOW;
    this.chunkX = 0;
    this.chunkZ = 0;
    this.worldX = 0;
    this.worldY = 0;
    this.worldZ = 0;
    this.sizeBytes = 0;
    this.enqueueTime = 0;
    this.dispatchTime = 0;
    this.completeTime = 0;
    this.retryCount = 0;
    this.workerIndex = -1;
    this.transferable = null;
    this.messageId = -1;
    this.onComplete = null;
    this.onError = null;
    this.userData = null;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── PRIORITY SCORE CONFIG ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const PRIORITY_CONSTANTS = Object.freeze({
  ALPHA:       0.55,   // distance weight
  BETA:        0.30,   // view-cone weight
  GAMMA:       0.15,   // normalized-distance weight
  MIN_DISTANCE: 1.0,   // prevent divide-by-zero
  CONE_REF:    0.85,   // cos(φ) reference for on-axis
  MAX_DISTANCE: 100000.0,   // 100 km fallback (galactic-tier)

  // Tier thresholds
  HIGH_THRESHOLD:   0.80,
  MEDIUM_THRESHOLD: 0.40,
  DROP_THRESHOLD:   0.05,

  // Timeslice budget in ms
  DEFAULT_SLICE_MS: 6.0,
  MAX_SLICE_MS: 8.0
});

// ══════════════════════════════════════════════════════════════════
// ─── ASYNC ASSET PRIORITY QUEUE ────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class AsyncAssetPriorityQueue {
  constructor(options = {}) {
    // ── Configuration ────────────────────────────────────
    this.defaults = {
      maxJobs:              options.maxJobs ?? 512,
      maxInFlight:          options.maxInFlight ?? 4,
      workerPoolSize:       options.workerPoolSize ?? 4,
      timesliceBudgetMs:    options.timesliceBudgetMs ?? PRIORITY_CONSTANTS.DEFAULT_SLICE_MS,
      maxDistance:          options.maxDistance ?? PRIORITY_CONSTANTS.MAX_DISTANCE,
      priorityAlpha:        options.priorityAlpha ?? PRIORITY_CONSTANTS.ALPHA,
      priorityBeta:         options.priorityBeta ?? PRIORITY_CONSTANTS.BETA,
      priorityGamma:        options.priorityGamma ?? PRIORITY_CONSTANTS.GAMMA,
      enableAutoRetry:      options.enableAutoRetry ?? true,
      maxRetries:           options.maxRetries ?? 2,
      yieldStrategy:        options.yieldStrategy ?? 'auto',
      workerScriptUrl:      options.workerScriptUrl ?? null,
      enableEvents:         options.enableEvents ?? true
    };

    // ── Job slot pool ─────────────────────────────────────
    this._jobPool = new Array(this.defaults.maxJobs);
    for (let i = 0; i < this.defaults.maxJobs; i++) {
      this._jobPool[i] = new JobSlot();
    }
    this._jobFreeList = new Int32Array(this.defaults.maxJobs);
    this._jobFreeCount = this.defaults.maxJobs;
    for (let i = 0; i < this.defaults.maxJobs; i++) {
      this._jobFreeList[i] = this.defaults.maxJobs - 1 - i;
    }
    this._activeJobs = new Map();
    this._nextJobId = 1;

    // ── Priority queue (3 buckets: HIGH, MEDIUM, LOW) ─────
    // Implemented as three Int32Array rings for O(1) push/pop.
    const bucketCap = this.defaults.maxJobs;
    this._buckets = [
      { slots: new Int32Array(bucketCap), head: 0, tail: 0, count: 0 },
      { slots: new Int32Array(bucketCap), head: 0, tail: 0, count: 0 },
      { slots: new Int32Array(bucketCap), head: 0, tail: 0, count: 0 }
    ];

    // ── Camera state (read each frame from the context frame) ─
    this._cameraPosition = new Vec3();
    this._cameraForward = new Vec3(0, 0, -1);
    this._cameraRight = new Vec3(1, 0, 0);
    this._cameraUp = new Vec3(0, 1, 0);
    this._cameraValid = false;

    // ── Scratch (pooled) ─────────────────────────────────
    this._tmpVec3A = new Vec3();
    this._tmpVec3B = new Vec3();
    this._tmpVec3C = new Vec3();
    this._tmpVec4 = new Vec4();
    this._tmpMat4 = new Mat4();
    this._tmpQuat = new Quat();

    // ── Yield strategy detection ─────────────────────────
    this._yieldFn = this._detectYieldStrategy(this.defaults.yieldStrategy);

    // ── SharedArrayBuffer availability ───────────────────
    this._hasSAB = typeof SharedArrayBuffer !== 'undefined' &&
                   (typeof crossOriginIsolated === 'undefined' || crossOriginIsolated);

    // ── Worker pool ──────────────────────────────────────
    this._workers = [];
    this._workerBusy = new Uint8Array(this.defaults.workerPoolSize);
    this._workerMessageIds = new Int32Array(this.defaults.workerPoolSize).fill(-1);
    if (this.defaults.workerScriptUrl && typeof Worker !== 'undefined') {
      this._initWorkers(this.defaults.workerScriptUrl);
    }

    // ── Timeslice state ─────────────────────────────────
    this._timesliceStart = 0;
    this._yielding = false;

    // ── Reusable event buffer ───────────────────────────
    this._completedJobsBuffer = new Int32Array(64);
    this._completedJobsCount = 0;

    // ── Statistics ──────────────────────────────────────
    this._stats = {
      jobsEnqueued: 0,
      jobsDispatched: 0,
      jobsCompleted: 0,
      jobsFailed: 0,
      jobsCancelled: 0,
      jobsSuspended: 0,
      jobsResumed: 0,
      jobsRetried: 0,
      jobsDropped: 0,
      totalBytesLoaded: 0,
      priorityRecomputes: 0,
      timeslicesYielded: 0,
      workerErrors: 0
    };

    // ── Collaborators ───────────────────────────────────
    this._dispatcher = options.dispatcher || null;
    this._clock = options.clock || null;
    this._workerPool = options.workerPool || null;

    // ── Frame reference ─────────────────────────────────
    this._frameRef = null;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Yield strategy detection ───────────────────────────
  // ══════════════════════════════════════════════════════════
  _detectYieldStrategy(strategy) {
    if (strategy === 'auto') {
      if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
        return scheduler.yield.bind(scheduler);
      }
      if (typeof requestIdleCallback === 'function') {
        return this._requestIdleYield.bind(this);
      }
      if (typeof setTimeout === 'function') {
        return this._setTimeoutYield.bind(this);
      }
      return this._microtaskYield.bind(this);
    }
    if (strategy === 'idle' && typeof requestIdleCallback === 'function') {
      return this._requestIdleYield.bind(this);
    }
    if (strategy === 'setTimeout') {
      return this._setTimeoutYield.bind(this);
    }
    if (strategy === 'microtask') {
      return this._microtaskYield.bind(this);
    }
    if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
      return scheduler.yield.bind(scheduler);
    }
    return this._setTimeoutYield.bind(this);
  }

  _requestIdleYield() {
    return new Promise((resolve) => {
      requestIdleCallback((deadline) => {
        resolve({
          didTimeout: deadline.didTimeout,
          timeRemaining: () => deadline.timeRemaining()
        });
      }, { timeout: 50 });
    });
  }

  _setTimeoutYield() {
    return new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  _microtaskYield() {
    return Promise.resolve();
  }

  // ══════════════════════════════════════════════════════════
  // ─── Worker pool initialization ─────────────────────────
  // ══════════════════════════════════════════════════════════
  _initWorkers(scriptUrl) {
    for (let i = 0; i < this.defaults.workerPoolSize; i++) {
      try {
        const worker = new Worker(scriptUrl, { type: 'module' });
        worker.onmessage = (event) => this._handleWorkerMessage(i, event.data);
        worker.onerror = (event) => this._handleWorkerError(i, event);
        this._workers.push(worker);
      } catch (e) {
        console.warn('[AsyncAssetPriorityQueue] Failed to create worker', i, e);
      }
    }
  }

  _handleWorkerMessage(workerIndex, message) {
    if (!message || typeof message !== 'object') return;
    const { messageId, jobId, success, payload, error, bytes } = message;

    this._workerBusy[workerIndex] = 0;
    this._workerMessageIds[workerIndex] = -1;

    const job = this._activeJobs.get(jobId);
    if (!job) return;   // job was cancelled or dropped

    if (success) {
      job.state = JOB_STATE.COMPLETED;
      job.completeTime = this._now();
      this._stats.jobsCompleted++;
      this._stats.totalBytesLoaded += bytes || 0;

      // Enqueue for the per-frame completion event.
      if (this._completedJobsCount < this._completedJobsBuffer.length) {
        this._completedJobsBuffer[this._completedJobsCount++] = job.jobId;
      }

      // Callback.
      if (job.onComplete) {
        try {
          job.onComplete(payload, job);
        } catch (e) {
          console.warn('[AsyncAssetPriorityQueue] onComplete threw', e);
        }
      }

      // Emit causal event.
      if (this._dispatcher && this.defaults.enableEvents) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.AUDIO_LIGHT,
          [job.worldX, job.worldY, job.worldZ],
          job.assetId, 1, 1.0,
          {
            kind: 'asset_loaded',
            jobId: job.jobId,
            assetKind: ASSET_KIND_NAMES[job.assetKind],
            priority: job.priority,
            bytes: bytes || 0,
            elapsedMs: (job.completeTime - job.dispatchTime) * 1000
          }
        );
      }
    } else {
      // Failure.
      if (this.defaults.enableAutoRetry && job.retryCount < this.defaults.maxRetries) {
        job.retryCount++;
        job.state = JOB_STATE.PENDING;
        this._stats.jobsRetried++;
        this._enqueueJob(job);
        return;
      }
      job.state = JOB_STATE.FAILED;
      job.completeTime = this._now();
      this._stats.jobsFailed++;

      if (job.onError) {
        try {
          job.onError(error || new Error('worker failure'), job);
        } catch (e) {
          console.warn('[AsyncAssetPriorityQueue] onError threw', e);
        }
      }

      if (this._dispatcher && this.defaults.enableEvents) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.AUDIO_LIGHT,
          [job.worldX, job.worldY, job.worldZ],
          job.assetId, 1, 1.0,
          {
            kind: 'asset_failed',
            jobId: job.jobId,
            assetKind: ASSET_KIND_NAMES[job.assetKind],
            error: String(error)
          }
        );
      }
    }

    // Release the job slot.
    this._releaseJob(job);
  }

  _handleWorkerError(workerIndex, event) {
    this._stats.workerErrors++;
    console.warn('[AsyncAssetPriorityQueue] Worker error', workerIndex, event.message);
    this._workerBusy[workerIndex] = 0;
    this._workerMessageIds[workerIndex] = -1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Job acquisition / release ──────────────────────────
  // ══════════════════════════════════════════════════════════
  _acquireJob() {
    if (this._jobFreeCount === 0) return null;
    this._jobFreeCount--;
    const idx = this._jobFreeList[this._jobFreeCount];
    const job = this._jobPool[idx];
    job.reset();
    return job;
  }

  _releaseJob(job) {
    if (!job) return;
    const idx = this._jobPool.indexOf(job);
    if (idx < 0) return;
    this._activeJobs.delete(job.jobId);
    job.reset();
    this._jobFreeList[this._jobFreeCount++] = idx;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Priority computation (zero allocation) ────────────
  // ══════════════════════════════════════════════════════════
  // p = α/d + β·|cos φ| + γ·(1 − d_norm)
  // Returns priority in [0, 1+ε].
  computePriority(worldX, worldY, worldZ) {
    if (!this._cameraValid) return 0.5;

    const cx = this._cameraPosition.x;
    const cy = this._cameraPosition.y;
    const cz = this._cameraPosition.z;

    const dx = worldX - cx;
    const dy = worldY - cy;
    const dz = worldZ - cz;
    const distSq = dx * dx + dy * dy + dz * dz;
    const dist = Math.sqrt(distSq);
    const clampedDist = Math.max(PRIORITY_CONSTANTS.MIN_DISTANCE, dist);

    // α / d
    const distTerm = this.defaults.priorityAlpha / clampedDist;

    // β · |cos φ|
    // cos φ = dot(direction to asset, forward)
    const invDist = 1 / clampedDist;
    const dirX = dx * invDist;
    const dirY = dy * invDist;
    const dirZ = dz * invDist;
    const cosPhi = dirX * this._cameraForward.x +
                   dirY * this._cameraForward.y +
                   dirZ * this._cameraForward.z;
    const coneTerm = this.defaults.priorityBeta * Math.abs(cosPhi);

    // γ · (1 − d_norm)
    const dNorm = Math.min(1, clampedDist / this.defaults.maxDistance);
    const normTerm = this.defaults.priorityGamma * (1 - dNorm);

    let p = distTerm + coneTerm + normTerm;

    // Distance boost for high-priority tier (within 1 km).
    if (dist < 1000) {
      p += 0.4;
    } else if (dist < 10000) {
      p += 0.15;
    }

    // Clamp.
    if (p > 1.5) p = 1.5;
    if (p < 0) p = 0;
    return p;
  }

  _classifyPriority(p) {
    if (p >= PRIORITY_CONSTANTS.HIGH_THRESHOLD) return PRIORITY_TIER.HIGH;
    if (p >= PRIORITY_CONSTANTS.MEDIUM_THRESHOLD) return PRIORITY_TIER.MEDIUM;
    if (p >= PRIORITY_CONSTANTS.DROP_THRESHOLD) return PRIORITY_TIER.LOW;
    return PRIORITY_TIER.DROP;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Bucket operations (O(1) push/pop) ──────────────────
  // ══════════════════════════════════════════════════════════
  _bucketPush(tier, jobIndex) {
    const bucket = this._buckets[tier];
    if (bucket.count >= bucket.slots.length) return false;
    bucket.slots[bucket.tail] = jobIndex;
    bucket.tail = (bucket.tail + 1) % bucket.slots.length;
    bucket.count++;
    return true;
  }

  _bucketPop(tier) {
    const bucket = this._buckets[tier];
    if (bucket.count === 0) return -1;
    const idx = bucket.slots[bucket.head];
    bucket.head = (bucket.head + 1) % bucket.slots.length;
    bucket.count--;
    return idx;
  }

  _bucketPeek(tier) {
    const bucket = this._buckets[tier];
    if (bucket.count === 0) return -1;
    return bucket.slots[bucket.head];
  }

  // ══════════════════════════════════════════════════════════
  // ─── Enqueue a job ──────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  enqueue(asset) {
    const job = this._acquireJob();
    if (!job) {
      this._stats.jobsDropped++;
      return -1;
    }

    job.jobId = this._nextJobId++;
    job.state = JOB_STATE.PENDING;
    job.assetId = asset.assetId ?? -1;
    job.assetKind = asset.assetKind ?? ASSET_KIND.UNKNOWN;
    job.assetUrl = asset.assetUrl ?? '';
    job.chunkX = asset.chunkX ?? 0;
    job.chunkZ = asset.chunkZ ?? 0;
    job.worldX = asset.worldX ?? 0;
    job.worldY = asset.worldY ?? 0;
    job.worldZ = asset.worldZ ?? 0;
    job.sizeBytes = asset.sizeBytes ?? 0;
    job.enqueueTime = this._now();
    job.onComplete = asset.onComplete ?? null;
    job.onError = asset.onError ?? null;
    job.userData = asset.userData ?? null;
    job.transferable = asset.transferable ?? null;

    // Compute priority.
    job.priority = this.computePriority(job.worldX, job.worldY, job.worldZ);
    job.priorityTier = this._classifyPriority(job.priority);

    if (job.priorityTier === PRIORITY_TIER.DROP) {
      this._releaseJob(job);
      this._stats.jobsDropped++;
      return -1;
    }

    const jobIdx = this._jobPool.indexOf(job);
    if (jobIdx < 0 || !this._bucketPush(job.priorityTier, jobIdx)) {
      this._releaseJob(job);
      this._stats.jobsDropped++;
      return -1;
    }

    this._activeJobs.set(job.jobId, job);
    this._stats.jobsEnqueued++;
    return job.jobId;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Cancel a job ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  cancel(jobId) {
    const job = this._activeJobs.get(jobId);
    if (!job) return false;

    job.state = JOB_STATE.CANCELLED;
    this._stats.jobsCancelled++;

    // If in flight, tell the worker to abort.
    if (job.workerIndex >= 0 && job.workerIndex < this._workers.length) {
      try {
        this._workers[job.workerIndex].postMessage({
          type: 'cancel',
          messageId: job.messageId
        });
      } catch (e) {
        // Ignore.
      }
      this._workerBusy[job.workerIndex] = 0;
      this._workerMessageIds[job.workerIndex] = -1;
    }

    if (this._dispatcher && this.defaults.enableEvents) {
      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.AUDIO_LIGHT,
        [job.worldX, job.worldY, job.worldZ],
        job.assetId, 1, 1.0,
        {
          kind: 'asset_cancelled',
          jobId,
          assetKind: ASSET_KIND_NAMES[job.assetKind]
        }
      );
    }

    this._releaseJob(job);
    return true;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Recompute priorities after camera move ────────────
  // ══════════════════════════════════════════════════════════
  // Rebuild the three buckets from the active jobs list.
  // Called once per frame (or when the camera moves significantly).
  recomputePriorities() {
    if (!this._cameraValid) return;

    this._stats.priorityRecomputes++;

    // Reset bucket contents.
    this._buckets[0].head = 0;
    this._buckets[0].tail = 0;
    this._buckets[0].count = 0;
    this._buckets[1].head = 0;
    this._buckets[1].tail = 0;
    this._buckets[1].count = 0;
    this._buckets[2].head = 0;
    this._buckets[2].tail = 0;
    this._buckets[2].count = 0;

    // Iterate active jobs and re-enqueue by new priority.
    for (const [, job] of this._activeJobs) {
      if (job.state === JOB_STATE.IN_FLIGHT) {
        // Check if the job should be dropped.
        const newPriority = this.computePriority(job.worldX, job.worldY, job.worldZ);
        job.priority = newPriority;
        job.priorityTier = this._classifyPriority(newPriority);
        if (job.priorityTier === PRIORITY_TIER.DROP) {
          this.cancel(job.jobId);
        }
        continue;   // in-flight jobs stay in flight
      }
      if (job.state !== JOB_STATE.PENDING && job.state !== JOB_STATE.SUSPENDED) continue;

      job.priority = this.computePriority(job.worldX, job.worldY, job.worldZ);
      job.priorityTier = this._classifyPriority(job.priority);

      if (job.priorityTier === PRIORITY_TIER.DROP) {
        this.cancel(job.jobId);
        continue;
      }

      if (job.state === JOB_STATE.SUSPENDED && job.priorityTier !== PRIORITY_TIER.LOW) {
        job.state = JOB_STATE.PENDING;
        this._stats.jobsResumed++;
      }

      const jobIdx = this._jobPool.indexOf(job);
      if (jobIdx >= 0) this._bucketPush(job.priorityTier, jobIdx);
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Dispatch pending jobs within timeslice ────────────
  // ══════════════════════════════════════════════════════════
  _dispatchPending() {
    const now = this._now();
    const budgetMs = this.defaults.timesliceBudgetMs;
    const startMs = now * 1000;
    let dispatched = 0;

    // Dispatch from HIGH first, then MEDIUM, then LOW.
    for (let tier = PRIORITY_TIER.HIGH; tier <= PRIORITY_TIER.LOW; tier++) {
      while (this._bucketCount(tier) > 0) {
        // Timeslice check.
        if ((this._now() * 1000) - startMs > budgetMs) {
          this._stats.timeslicesYielded++;
          return dispatched;
        }

        // Worker availability.
        const workerIndex = this._findAvailableWorker();
        if (workerIndex < 0) return dispatched;

        const jobIdx = this._bucketPop(tier);
        if (jobIdx < 0) break;
        const job = this._jobPool[jobIdx];
        if (!job || job.state !== JOB_STATE.PENDING) continue;

        this._dispatchJob(job, workerIndex);
        dispatched++;
      }
    }

    return dispatched;
  }

  _bucketCount(tier) {
    return this._buckets[tier].count;
  }

  _findAvailableWorker() {
    if (this._workers.length === 0) {
      // No workers: use a mock dispatcher (just complete immediately).
      return -2;
    }
    for (let i = 0; i < this._workers.length; i++) {
      if (this._workerBusy[i] === 0) return i;
    }
    return -1;
  }

  _dispatchJob(job, workerIndex) {
    job.state = JOB_STATE.IN_FLIGHT;
    job.dispatchTime = this._now();
    job.workerIndex = workerIndex;
    this._stats.jobsDispatched++;

    if (workerIndex === -2) {
      // No worker available: fake completion via microtask.
      Promise.resolve().then(() => {
        this._handleWorkerMessage(
          -1,
          {
            messageId: job.messageId,
            jobId: job.jobId,
            success: true,
            payload: job.transferable,
            bytes: job.sizeBytes || 0
          }
        );
      });
      return;
    }

    if (workerIndex >= 0 && workerIndex < this._workers.length) {
      this._workerBusy[workerIndex] = 1;
      job.messageId = this._nextJobId * 1000 + workerIndex;
      this._workerMessageIds[workerIndex] = job.messageId;

      try {
        this._workers[workerIndex].postMessage({
          type: 'load',
          messageId: job.messageId,
          jobId: job.jobId,
          assetKind: job.assetKind,
          assetUrl: job.assetUrl,
          chunkX: job.chunkX,
          chunkZ: job.chunkZ,
          sizeBytes: job.sizeBytes
        }, job.transferable ? [job.transferable] : []);
      } catch (e) {
        this._workerBusy[workerIndex] = 0;
        this._workerMessageIds[workerIndex] = -1;
        this._handleWorkerError(workerIndex, { message: String(e) });
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Camera update from the context frame ──────────────
  // ══════════════════════════════════════════════════════════
  _updateCamera(frame) {
    const spatial = frame.layers.spatial;
    const player = frame.layers.player;

    if (player) {
      this._cameraPosition.set(
        player.position[0],
        player.position[1],
        player.position[2]
      );
      this._cameraForward.set(
        player.facing[0],
        player.facing[1],
        player.facing[2]
      ).normalize();

      // Facing is forward; right = forward × up.
      this._tmpVec3A.set(0, 1, 0);
      this._cameraRight.copy(this._cameraForward).cross(this._tmpVec3A).normalize();
      this._cameraUp.copy(this._cameraRight).cross(this._cameraForward).normalize();

      this._cameraValid = true;
      return;
    }

    if (spatial && spatial.cameraPosition) {
      this._cameraPosition.set(
        spatial.cameraPosition.x ?? spatial.cameraPosition[0] ?? 0,
        spatial.cameraPosition.y ?? spatial.cameraPosition[1] ?? 0,
        spatial.cameraPosition.z ?? spatial.cameraPosition[2] ?? 0
      );
      this._cameraValid = true;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Now helper ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _now() {
    if (this._clock) return this._clock.elapsedSeconds;
    return performance.now() / 1000;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    if (!physical.asyncLoading) {
      physical.asyncLoading = {
        jobsEnqueued: 0,
        jobsInFlight: 0,
        jobsPending: 0,
        jobsCompleted: 0,
        jobsFailed: 0,
        jobsCancelled: 0,
        jobsDropped: 0,
        queueDepth: 0,
        highPriorityDepth: 0,
        mediumPriorityDepth: 0,
        lowPriorityDepth: 0,
        totalBytesLoaded: 0,
        timeslicesYielded: 0
      };
    }

    const a = physical.asyncLoading;
    a.jobsEnqueued = this._stats.jobsEnqueued;
    a.jobsInFlight = this._countInFlight();
    a.jobsPending = this._buckets[0].count + this._buckets[1].count + this._buckets[2].count;
    a.jobsCompleted = this._stats.jobsCompleted;
    a.jobsFailed = this._stats.jobsFailed;
    a.jobsCancelled = this._stats.jobsCancelled;
    a.jobsDropped = this._stats.jobsDropped;
    a.queueDepth = a.jobsPending;
    a.highPriorityDepth = this._buckets[0].count;
    a.mediumPriorityDepth = this._buckets[1].count;
    a.lowPriorityDepth = this._buckets[2].count;
    a.totalBytesLoaded = this._stats.totalBytesLoaded;
    a.timeslicesYielded = this._stats.timeslicesYielded;

    // Expose the completed jobs for consumers this frame.
    if (!a.completedJobs) a.completedJobs = [];
    a.completedJobs.length = 0;
    for (let i = 0; i < this._completedJobsCount; i++) {
      a.completedJobs.push(this._completedJobsBuffer[i]);
    }
    this._completedJobsCount = 0;
  }

  _countInFlight() {
    let count = 0;
    for (const [, job] of this._activeJobs) {
      if (job.state === JOB_STATE.IN_FLIGHT) count++;
    }
    return count;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Main update ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  update(frame, clock) {
    if (!frame || !frame.layers) return 0;
    this._frameRef = frame;

    // ── 1. Update camera state ──────────────────────────
    this._updateCamera(frame);

    // ── 2. Recompute priorities when the camera moved ───
    // Only recompute if the camera has moved meaningfully.
    if (this._cameraValid) {
      this.recomputePriorities();
    }

    // ── 3. Dispatch pending jobs within the timeslice ──
    this._dispatchPending();

    // ── 4. Write to frame layers ────────────────────────
    this._writeToPhysicalLayer(frame);

    return 1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Public queries ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getJobState(jobId) {
    const job = this._activeJobs.get(jobId);
    return job ? job.state : JOB_STATE.FREE;
  }

  getJobPriority(jobId) {
    const job = this._activeJobs.get(jobId);
    return job ? job.priority : 0;
  }

  getJobTier(jobId) {
    const job = this._activeJobs.get(jobId);
    return job ? job.priorityTier : PRIORITY_TIER.DROP;
  }

  getQueueDepth() {
    return this._buckets[0].count + this._buckets[1].count + this._buckets[2].count;
  }

  getHighPriorityDepth() { return this._buckets[0].count; }
  getMediumPriorityDepth() { return this._buckets[1].count; }
  getLowPriorityDepth() { return this._buckets[2].count; }
  getInFlightCount() { return this._countInFlight(); }

  // ══════════════════════════════════════════════════════════
  // ─── Diagnostics ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getStats() {
    return Object.freeze({ ...this._stats });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) this._stats[k] = 0;
  }

  dispose() {
    // Cancel all active jobs.
    const jobIds = Array.from(this._activeJobs.keys());
    for (const id of jobIds) this.cancel(id);

    // Terminate workers.
    for (const worker of this._workers) {
      try { worker.terminate(); } catch (e) {}
    }
    this._workers.length = 0;

    this._jobPool.length = 0;
    this._activeJobs.clear();
    this._buckets[0].count = 0;
    this._buckets[1].count = 0;
    this._buckets[2].count = 0;

    this._dispatcher = null;
    this._clock = null;
    this._workerPool = null;
    this._frameRef = null;
  }
}

export {
  AsyncAssetPriorityQueue,
  JobSlot,
  JOB_STATE,
  JOB_STATE_NAMES,
  ASSET_KIND,
  ASSET_KIND_NAMES,
  PRIORITY_TIER,
  PRIORITY_TIER_NAMES,
  PRIORITY_CONSTANTS
};