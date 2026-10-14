
// file number : 007_9
// full path name : src/objects/007_9_AsyncDensityApplication_LOD.js
// description : Enhancement #11 for the Dynamic LOD system. Adds an asynchronous density application pipeline so procedural generators, remeshers, and heavy geometry adapters no longer block the main thread when the LOD system requests a density change. Jobs are queued per target, coalesced by request id, dispatched to a worker pool (module worker by default, WASM-compatible), and applied on the main thread only when the result returns. Supports per-frame apply budget, priority ordering, stale-request cancellation, deterministic replay-safe coalescing, back-pressure signaling, and graceful fallback to synchronous application when no worker pool is available. Uses gl-matrix for packing job payloads into transferable arrays, double.js for high-precision timing telemetry, bitecs for SoA job queue state, and simplex-noise for deterministic coalescing jitter that prevents thundering-herd dispatch on the same target.
// best for : Procedural generation pipelines, runtime remeshing, GPU-to-CPU readback targets, heavy geometry adapters, streaming biome tessellation, WASM-backed generators, worker-based mesh simplification, non-blocking LOD streaming, mobile / low-end hosts where main-thread stalls are unacceptable.
// license : MIT

import { LODBiasResolutionScaleLOD } from './007_8_LODBiasResolutionScale_LOD.js';
import { LOD_MODE } from './007_LOD.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchMat4 = new Float64Array( 16 );
const _scratchVec4 = new Float64Array( 4 );
const _scratchVec3A = new Float64Array( 3 );
const _noise3D = createNoise3D();

// ─── ECS world + AsyncDensity SoA component ─────────────────────────────────
const _asyncWorld = createWorld();

const AsyncDensitySoA = defineComponent( {
    // Queue state
    pendingJobs: Types.i32,
    inflightJobs: Types.i32,
    appliedJobs: Types.i32,
    failedJobs: Types.i32,
    cancelledJobs: Types.i32,
    coalescedJobs: Types.i32,

    // Budget state
    applyBudgetPerFrame: Types.i32,
    applyBudgetUsedThisFrame: Types.i32,
    dispatchBudgetPerFrame: Types.i32,
    dispatchBudgetUsedThisFrame: Types.i32,

    // Timing telemetry
    lastDispatchTimeMs: Types.f64,
    lastApplyTimeMs: Types.f64,
    avgRoundTripMs: Types.f64,
    avgRoundTripEMA: Types.f64,
    maxRoundTripMs: Types.f64,

    // Back-pressure
    backPressure: Types.f64,            // 0..1, 1 = saturated
    saturated: Types.ui8,
    fallbackSync: Types.ui8,            // 1 = no worker pool, apply synchronously

    // Determinism / replay
    lastRequestId: Types.i32,
    lastAppliedRequestId: Types.i32,
    determinismSeed: Types.i32,

    // State flags
    initialized: Types.ui8,
    enabled: Types.ui8,
    frozen: Types.ui8,
    lastFrameIndex: Types.i32,
    lastDeltaTime: Types.f64
} );

// ─── Async job lifecycle states ─────────────────────────────────────────────
const JobState = Object.freeze( {
    QUEUED: 0,
    DISPATCHED: 1,
    APPLIED: 2,
    FAILED: 3,
    CANCELLED: 4,
    COALESCED: 5
} );

// ─── Tunables specific to async density application ─────────────────────────
const AsyncDensityDefaults = {
    // Maximum number of jobs dispatched to workers per frame.
    dispatchBudgetPerFrame: 4,

    // Maximum number of results applied on the main thread per frame.
    applyBudgetPerFrame: 8,

    // Maximum number of in-flight jobs before back-pressure kicks in.
    maxInflightJobs: 32,

    // Maximum queue depth before coalescing starts dropping older requests.
    maxQueueDepth: 128,

    // Whether to coalesce multiple pending requests for the same target into
    // a single dispatch. Enabled by default; keeps the queue shallow.
    coalesceByTarget: true,

    // Whether to cancel in-flight jobs when a newer request supersedes them.
    cancelStaleInflight: true,

    // Whether to allow synchronous fallback when no worker pool exists.
    allowSyncFallback: true,

    // Worker pool size. 0 = auto-detect (navigator.hardwareConcurrency - 1).
    workerPoolSize: 0,

    // Timeout for a single worker job (milliseconds). 0 = no timeout.
    jobTimeoutMs: 2500,

    // EMA smoothing factor for round-trip time telemetry.
    roundTripSmoothing: 0.2,

    // Deterministic seed base for coalescing jitter.
    determinismSeed: 0x27D4EB2D,

    // Whether to send priority hints to the worker pool.
    usePriorityQueue: true,

    // Maximum number of times a job is retried after failure.
    maxRetries: 1
};

/**
 * AsyncDensityApplicationLOD
 *
 * Extends LODBiasResolutionScaleLOD and wraps density application in an
 * asynchronous job pipeline. The public contract is unchanged: calling
 * `setDensity(d)` or a geometry draw-range update still happens, but the
 * actual heavy work (procedural remesh, WASM simplification, GPU readback)
 * is offloaded to a worker pool and re-applied on the main thread when
 * the result is ready.
 *
 * Pipeline per frame:
 *
 *   1. Parent chain computes a fresh target density.
 *   2. If the delta is small, apply synchronously (cheap path).
 *   3. Otherwise, queue a job keyed by target identity.
 *   4. Drain dispatch budget: send queued jobs to workers.
 *   5. Drain apply budget: apply completed results on the main thread.
 *   6. Update telemetry, back-pressure, and saturation flags.
 *
 * When no worker pool is available (e.g. headless CI, no Worker support),
 * the class falls back to synchronous application if `allowSyncFallback`
 * is true, so existing behavior is preserved.
 *
 * Worker protocol (module worker):
 *   postMessage({ type: 'density', requestId, targetId, density, payload })
 *   worker → main: postMessage({ type: 'density-result', requestId, density, buffer })
 *
 * Recommended usage:
 * ```js
 * const lod = new AsyncDensityApplicationLOD();
 * lod.attachTarget( proceduralTerrain, { vertexBudget: 250000 } );
 * lod.registerWithAllocator( 'world' );
 *
 * // Optional: install a custom worker factory
 * AsyncDensityApplicationLOD.setWorkerFactory( () => new Worker(
 *     new URL( './density.worker.js', import.meta.url ),
 *     { type: 'module' }
 * ) );
 *
 * // Per frame
 * AsyncDensityApplicationLOD.beginFrame( frameIndex );
 * for ( const l of allLODs ) l.update( camera, player, dt );
 * AsyncDensityApplicationLOD.flushAsync();
```

· 
· @augments LODBiasResolutionScaleLOD
  */
  class AsyncDensityApplicationLOD extends LODBiasResolutionScaleLOD {
  constructor() {
  super();
  }
  // ─── Public API ───────────────────────────────────────────────────────────
  /**
  · Enables or disables async density application on this LOD. When disabled,
  · density changes fall through to synchronous application.
  · @param {boolean} [enabled=true]
  · @return {AsyncDensityApplicationLOD}
    */
    enableAsync( enabled = true ) {
    this._enabled = enabled;
    return this;
    }
  /**
  · Freezes async dispatch and apply. Parent chain still runs.
  · @param {boolean} [frozen=true]
  · @return {AsyncDensityApplicationLOD}
    */
    freezeAsync( frozen = true ) {
    this._asyncFrozen = frozen;
    return this;
    }
  /**
  · Returns true if a job is currently queued or in flight.
  · @return {boolean}
    */
    isBusy() {
    return this._pendingJob !== null || this._inflightJob !== null;
    }
  /**
  · Returns the current back-pressure level in [0, 1].
  · @return {number}
    */
    getBackPressure() {
    return this._backPressure;
    }
  /**
  · Returns true if the LOD is saturated and further density changes will
  · be deferred until the queue drains.
  · @return {boolean}
    */
    isSaturated() {
    return this._saturated;
    }
  /**
  · Returns a high-precision async ledger for telemetry.
  · @return {object}
    */
    getAsyncLedger() {
    const rtt = new Double( this._avgRoundTripMs );
    const inflight = new Double( this._inflightJobs );
    const max = new Double( Math.max( 1, this.maxInflightJobs ) );
    return {
    pendingJobs: this._pendingJobs,
    inflightJobs: this._inflightJobs,
    appliedJobs: this._appliedJobs,
    failedJobs: this._failedJobs,
    cancelledJobs: this._cancelledJobs,
    coalescedJobs: this._coalescedJobs,
    avgRoundTripMs: rtt.valueOf(),
    avgRoundTripEMA: this._avgRoundTripEMA,
    maxRoundTripMs: this._maxRoundTripMs,
    backPressure: this._backPressure,
    saturated: this._saturated,
    fallbackSync: this._fallbackSync,
    inflightRatio: inflight.div( max ).valueOf(),
    lastRequestId: this._lastRequestId,
    lastAppliedRequestId: this._lastAppliedRequestId
    };
    }
  // ─── Update override ──────────────────────────────────────────────────────
  /**
  · Overrides LODBiasResolutionScaleLOD.update. Runs the full parent chain,
  · then decides whether the density change should be applied synchronously
  · (small delta or no workers) or queued asynchronously.
  · 
  · @param {Camera} camera
  · @param {Object3D} [player]
  · @param {number} [rawDeltaTime]
    */
    update( camera, player = this.player, rawDeltaTime = 0.016 ) {
    if ( this.mode === LOD_MODE.CONVENTIONAL ) {
    super.update( camera, player, rawDeltaTime );
    return;
    }
    this._lastDeltaTime = rawDeltaTime;
    // ── 1. Parent chain computes the final target density. ──────────────
    super.update( camera, player, rawDeltaTime );
    if ( ! this._enabled || this._asyncFrozen ) {
    // Async disabled: fall through to the parent's sync path.
    this._applyDensitySynchronously();
    this.syncAsyncECS();
    return;
    }
    // ── 2. Decide sync vs. async. ───────────────────────────────────────
    const targetDensity = this._dynamicDensity;
    const lastApplied = this._lastAppliedDensityValue;
    const delta = Math.abs( targetDensity - lastApplied );
    const syncThreshold = 0.02;
    if ( delta < syncThreshold ) {
    // Small delta: apply synchronously, no need for the queue.
    this._applyDensitySynchronously();
    this.syncAsyncECS();
    return;
    }
    // ── 3. Back-pressure check. ─────────────────────────────────────────
    if ( this._saturated ) {
    // Do not queue new jobs while saturated; keep the last value.
    this.syncAsyncECS();
    return;
    }
    // ── 4. Queue an async job. ──────────────────────────────────────────
    this._enqueueJob( targetDensity );
    this.syncAsyncECS();
    }
  // ─── Job queueing ────────────────────────────────────────────────────────
  _enqueueJob( density ) {
  const targetId = this._ecsEntity;
  }
  _computeCoalesceJitter() {
  const seed = ( this.determinismSeed ^ ( this._ecsEntity >>> 0 ) ) >>> 0;
  return _noise3D( seed * 1e-6, this._frameIndex * 0.05, this.id ) * 2.0;
  }
  // ─── Synchronous application (fallback path) ────────────────────────────
  _applyDensitySynchronously() {
  const target = this.target;
  if ( target === null ) return;
  }
  // ─── Static async scheduler ──────────────────────────────────────────────
  /**
  · Resets per-frame budgets. Called once per frame by the host, before
  · any LOD updates.
  · @param {number} frameIndex
    */
    static beginFrame( frameIndex ) {
    AsyncDensityApplicationLOD._frameIndex = frameIndex;
    for ( const lod of AsyncDensityApplicationLOD._registeredAsync ) {
    lod._applyBudgetUsedThisFrame = 0;
    lod._dispatchBudgetUsedThisFrame = 0;
    }
    }
  /**
  · Drains the dispatch and apply budgets. Called once per frame by the host,
  · after all LOD updates.
    */
    static flushAsync() {
    const S = AsyncDensityApplicationLOD;
    // ── 1. Ensure the worker pool is initialized. ───────────────────────
    if ( S._workerPool === null && ! S._poolUnavailable ) {
    S._initWorkerPool();
    }
    // ── 2. Drain dispatch budget. ───────────────────────────────────────
    if ( S._workerPool !== null && S._workerPool.length > 0 ) {
    S._drainDispatch();
    }
    // ── 3. Drain apply budget from completed results. ───────────────────
    S._drainApply();
    // ── 4. Update back-pressure telemetry on each registered LOD. ───────
    for ( const lod of S._registeredAsync ) {
    S._updateBackPressure( lod );
    }
    }
  static _drainDispatch() {
  const S = AsyncDensityApplicationLOD;
  const queue = S._globalQueue;
  const pool = S._workerPool;
  }
  static _drainApply() {
  const S = AsyncDensityApplicationLOD;
  const results = S._completedResults;
  }
  static _applyResultToLOD( lod, result ) {
  const target = lod.target;
  if ( target === null ) return false;
  }
  // ─── Worker pool management ──────────────────────────────────────────────
  static _initWorkerPool() {
  const S = AsyncDensityApplicationLOD;
  }
  static _findFreeWorker() {
  const pool = AsyncDensityApplicationLOD._workerPool;
  if ( pool === null ) return - 1;
  for ( let i = 0; i < pool.length; i ++ ) {
  if ( ! pool[ i ].busy ) return i;
  }
  return - 1;
  }
  static _freeWorker( index ) {
  const pool = AsyncDensityApplicationLOD._workerPool;
  if ( pool === null || index < 0 || index >= pool.length ) return;
  pool[ index ].busy = false;
  pool[ index ].currentRequestId = - 1;
  }
  static _dispatchToWorker( workerIndex, job ) {
  const S = AsyncDensityApplicationLOD;
  const slot = S._workerPool[ workerIndex ];
  slot.busy = true;
  slot.currentRequestId = job.requestId;
  }
  static _onWorkerMessage( ev, workerIndex ) {
  const S = AsyncDensityApplicationLOD;
  const msg = ev.data;
  if ( msg === undefined || msg === null ) return;
  if ( msg.type !== 'density-result' ) return;
  }
  static _onWorkerError( err, workerIndex ) {
  const S = AsyncDensityApplicationLOD;
  const slot = S._workerPool !== null ? S._workerPool[ workerIndex ] : null;
  const requestId = slot !== null ? slot.currentRequestId : - 1;
  }
  static _cancelInflight( requestId ) {
  const S = AsyncDensityApplicationLOD;
  const job = S._globalQueueByRequestId.get( requestId );
  if ( job !== undefined ) {
  S._globalQueueByRequestId.delete( requestId );
  }
  // Mark the request as cancelled; results will be discarded on arrival.
  S._cancelledRequestIds.add( requestId );
  }
  static _resolveLODByRequestId( requestId ) {
  const S = AsyncDensityApplicationLOD;
  if ( S._cancelledRequestIds.has( requestId ) ) {
  S._cancelledRequestIds.delete( requestId );
  return null;
  }
  }
  static _updateBackPressure( lod ) {
  const inflight = lod._inflightJobs;
  const maxInflight = Math.max( 1, lod.maxInflightJobs );
  }
  static _registerAsyncLOD( lod ) {
  AsyncDensityApplicationLOD._registeredAsync.add( lod );
  }
  static _unregisterAsyncLOD( lod ) {
  AsyncDensityApplicationLOD._registeredAsync.delete( lod );
  AsyncDensityApplicationLOD._globalQueue = AsyncDensityApplicationLOD._globalQueue.filter( ( j ) => j.lod !== lod );
  }
  // ─── Public static configuration ─────────────────────────────────────────
  /**
  · Installs a custom worker factory. The factory must return a Worker-like
  · object with postMessage, onmessage, and onerror.
  · @param {Function|null} factory
    */
    static setWorkerFactory( factory ) {
    AsyncDensityApplicationLOD._workerFactory = factory;
    AsyncDensityApplicationLOD._workerPool = null;
    AsyncDensityApplicationLOD._poolUnavailable = false;
    }
  /**
  · Sets the worker pool size. 0 = auto-detect.
  · @param {number} size
    */
    static setWorkerPoolSize( size ) {
    AsyncDensityApplicationLOD._workerPoolSize = Math.max( 0, size | 0 );
    AsyncDensityApplicationLOD._workerPool = null;
    AsyncDensityApplicationLOD._poolUnavailable = false;
    }
  /**
  · Returns the current worker pool statistics.
  · @return {object}
    */
    static getWorkerPoolStats() {
    const S = AsyncDensityApplicationLOD;
    const pool = S._workerPool;
    if ( pool === null ) {
    return {
    available: false,
    poolUnavailable: S._poolUnavailable,
    size: 0,
    busy: 0,
    idle: 0
    };
    }
    let busy = 0;
    for ( const slot of pool ) if ( slot.busy ) busy ++;
    return {
    available: true,
    poolUnavailable: false,
    size: pool.length,
    busy: busy,
    idle: pool.length - busy
    };
    }
  /**
  · Returns the global async queue statistics.
  · @return {object}
    */
    static getGlobalQueueStats() {
    const S = AsyncDensityApplicationLOD;
    return {
    queued: S._globalQueue.length,
    inflight: S._globalQueueByRequestId.size,
    completed: S._completedResults.length,
    cancelled: S._cancelledRequestIds.size,
    registeredLODs: S._registeredAsync.size
    };
    }
  static _nowMs() {
  if ( typeof performance !== 'undefined' && typeof performance.now === 'function' ) {
  return performance.now();
  }
  return Date.now();
  }
  // ─── ECS registration ──────────────────────────────────────────────────────
  registerAsyncECS() {
  if ( this._ecsAsyncRegistered ) {
  return this._ecsAsyncEntity;
  }
  }
  syncAsyncECS() {
  if ( ! this._ecsAsyncRegistered ) {
  return this;
  }
  }
  pullAsyncECS() {
  if ( ! this._ecsAsyncRegistered ) {
  return this;
  }
  }
  // ─── Copy / JSON ──────────────────────────────────────────────────────────
  copy( source ) {
  super.copy( source );
  }
  toJSON( meta ) {
  const data = super.toJSON( meta );
  }
  // ─── gl-matrix / double.js / simplex-noise utilities ───────────────────────
  multiplyMat4GL( out, a, b ) {
  glMatrix.mat4.multiply( out || _scratchMat4, a, b );
  return out || _scratchMat4;
  }
  /**
  · High-precision round-trip time computation using double.js. Useful
  · when the timing span is very large or when chaining many samples.
  · @param {number} dispatchedAt
  · @param {number} appliedAt
  · @return {number}
    */
    computeRoundTripHighPrecision( dispatchedAt, appliedAt ) {
    const a = new Double( appliedAt );
    const b = new Double( dispatchedAt );
    return a.sub( b ).valueOf();
    }
  /**
  · Returns a deterministic coalesce jitter for this LOD. Used to avoid
  · thundering-herd dispatch when many LODs coalesce in the same frame.
  · @param {number} frameIndex
  · @return {number}
    */
    computeCoalesceJitter( frameIndex ) {
    const seed = ( this.determinismSeed ^ ( this._ecsEntity >>> 0 ) ) >>> 0;
    return _noise3D( seed * 1e-6, frameIndex * 0.05, this.id ) * 2.0;
    }
  packHeaderVec4( out ) {
  const v = out || _scratchVec4;
  glMatrix.vec4.set(
  v,
  this.matrixAutoUpdate ? 1 : 0,
  this.matrixWorldAutoUpdate ? 1 : 0,
  this.visible ? 1 : 0,
  this.children.length
  );
  return v;
  }
  /**
  · Packs async telemetry into a vec4 for GPU debug rendering.
  · Layout: (pendingJobs, inflightJobs, backPressure, lastRequestId)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packAsyncVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
    v,
    this._pendingJobs,
    this._inflightJobs,
    this._backPressure,
    this._lastRequestId
    );
    return v;
    }
  /**
  · Packs the async job payload into a transferable Float64Array. The
  · layout mirrors gl-matrix conventions so a worker can read it directly.
  · Layout: (requestId, targetId, density, frameIndex, determinismSeed)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packJobPayload( out ) {
    const v = out || new Float64Array( 5 );
    v[ 0 ] = this._lastRequestId;
    v[ 1 ] = this._ecsEntity;
    v[ 2 ] = this._dynamicDensity;
    v[ 3 ] = this._frameIndex;
    v[ 4 ] = this.determinismSeed;
    return v;
    }
  static getECSWorld() {
  return _asyncWorld;
  }
  static getAsyncSoA() {
  return AsyncDensitySoA;
  }
  static get AsyncDensityDefaults() {
  return AsyncDensityDefaults;
  }
  static get JobState() {
  return JobState;
  }
  }

// ─── Static async storage (module-scoped, shared across all instances) ──────
AsyncDensityApplicationLOD._registeredAsync = new Set();
AsyncDensityApplicationLOD._globalQueue = [];
AsyncDensityApplicationLOD._globalQueueByRequestId = new Map();
AsyncDensityApplicationLOD._completedResults = [];
AsyncDensityApplicationLOD._cancelledRequestIds = new Set();

AsyncDensityApplicationLOD._workerPool = null;
AsyncDensityApplicationLOD._workerFactory = null;
AsyncDensityApplicationLOD._workerPoolSize = 0;
AsyncDensityApplicationLOD._poolUnavailable = false;
AsyncDensityApplicationLOD._frameIndex = 0;
AsyncDensityApplicationLOD._usePriorityQueue = AsyncDensityDefaults.usePriorityQueue;

export {
AsyncDensityApplicationLOD,
AsyncDensitySoA,
AsyncDensityDefaults,
JobState
};
