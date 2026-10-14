
// file number : 007_13
// full path name : src/objects/007_13_StreamingGeometryCache_LOD.js
// description : Enhancement #16 for the Dynamic LOD system, tuned for Android 64-bit mobile devices running Three.js (WebGL1 / WebGL2). Adds an out-of-core streaming geometry cache that stores simplified LOD meshes on-device (IndexedDB / OPFS / Cache API with graceful fallback) and streams them in and out of GPU memory under strict mobile memory budgets. Each geometry receives an LRU keyed set of density tiers (12.5%, 25%, 50%, 75%, 100%) so the LOD system can switch tiers without waiting for procedural regeneration. Predictive prefetch uses player and camera motion to warm tiers just before they are needed, and eviction is driven by Android memory pressure, thermal state, battery level, and per-tier storage caps calibrated for Adreno 5xx–7xx and Mali-G5x–G7xx. Includes a shared cache across all LODs of the same geometry, deterministic replay-safe eviction ordering, a cold-tier procedural fallback, and a background decode path that never blocks the main thread. Uses gl-matrix for cache key hashing and prefetch cone math, double.js for high-precision byte accounting across hundreds of MB of cached geometry, bitecs for SoA cache state, and simplex-noise for deterministic eviction jitter that prevents thundering-herd cache misses.
// best for : Android 64-bit mobile open worlds, streamed biomes, procedural terrain tiers, dense foliage instancing with cached simplified meshes, character LOD chain caching, mobile AR / VR streaming, thermal-throttled devices, battery-aware streaming, low-storage devices, deterministic capture / replay, non-blocking GPU upload.
// license : MIT

import { SkinningCostMultiplierLOD } from './007_12_SkinningCostMultiplier_LOD.js';
import { LOD_MODE } from './007_LOD.js';

import { BufferGeometry } from '../core/019_BufferGeometry.js';
import { BufferAttribute } from '../core/020_BufferAttribute.js';
import { InterleavedBufferAttribute } from '../core/021_InterleavedBufferAttribute.js';
import { Object3D } from '../core/018_Object3D.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchMat4 = new Float64Array( 16 );
const _scratchVec4 = new Float64Array( 4 );
const _scratchVec3A = new Float64Array( 3 );
const _scratchVec3B = new Float64Array( 3 );
const _scratchVec3C = new Float64Array( 3 );
const _cacheKeyVec = new Float64Array( 4 );
const _noise3D = createNoise3D();

// ─── ECS world + StreamingCache SoA component ───────────────────────────────
const _streamingWorld = createWorld();

const StreamingCacheSoA = defineComponent( {
    // Geometry identity
    geometryId: Types.i32,
    geometryUuidHash: Types.i32,
    geometryKey: Types.i32,

    // Cache tier state
    currentTier: Types.i32,            // 0=12.5%, 1=25%, 2=50%, 3=75%, 4=100%
    targetTier: Types.i32,
    tierCount: Types.i32,
    tierResident: Types.ui8,           // 1 = target tier already in RAM
    tierRequested: Types.ui8,          // 1 = in-flight request
    tierEvicted: Types.ui8,            // 1 = recently evicted

    // Tier residency bitmask (bit i = tier i resident)
    residencyMask: Types.ui32,
    inflightMask: Types.ui32,
    requestedMask: Types.ui32,

    // Byte accounting
    bytesPerTier0: Types.f64,
    bytesPerTier1: Types.f64,
    bytesPerTier2: Types.f64,
    bytesPerTier3: Types.f64,
    bytesPerTier4: Types.f64,
    bytesResident: Types.f64,
    bytesInflight: Types.f64,

    // Mobile budget
    mobileByteBudget: Types.f64,
    deviceByteBudget: Types.f64,
    budgetUtilization: Types.f64,

    // Storage backend
    storageBackend: Types.i32,         // 0=none, 1=indexedDB, 2=OPFS, 3=cacheAPI, 4=memory
    storageAvailable: Types.ui8,
    storagePersistent: Types.ui8,

    // Prefetch
    prefetchScore: Types.f64,
    prefetchDistance: Types.f64,
    prefetchInCone: Types.ui8,
    prefetchPriority: Types.f64,

    // Eviction
    lastAccessFrame: Types.i32,
    lastEvictionFrame: Types.i32,
    accessCount: Types.i32,
    evictionCount: Types.i32,
    missCount: Types.i32,
    hitCount: Types.i32,

    // Android context
    androidTier: Types.i32,
    thermalPressure: Types.f64,
    batteryPressure: Types.f64,
    memoryPressure: Types.f64,
    isMobile64: Types.ui8,

    // State
    initialized: Types.ui8,
    enabled: Types.ui8,
    frozen: Types.ui8,
    lastFrameIndex: Types.i32,
    lastDeltaTime: Types.f64,
    ditherSample: Types.f64
} );

// ─── Storage backend constants ──────────────────────────────────────────────
const StorageBackend = Object.freeze( {
    NONE: 0,
    INDEXED_DB: 1,
    OPFS: 2,
    CACHE_API: 3,
    MEMORY: 4
} );

// ─── Tier constants ─────────────────────────────────────────────────────────
const TIER_DENSITIES = Object.freeze( [ 0.125, 0.25, 0.5, 0.75, 1.0 ] );
const TIER_COUNT = TIER_DENSITIES.length;

// ─── Per-tier mobile byte budget (bytes) ────────────────────────────────────
// Calibrated for Android 64-bit mobile GPUs. Values are total resident
// geometry bytes across the entire scene. LOW devices get very tight caps
// to avoid GC thrash; FLAGSHIP devices can hold much more.
const MOBILE_BYTE_BUDGET = {
    LOW: 32 * 1024 * 1024,      //  32 MB
    MID: 96 * 1024 * 1024,      //  96 MB
    HIGH: 224 * 1024 * 1024,    // 224 MB
    FLAGSHIP: 384 * 1024 * 1024 // 384 MB
};

// ─── Per-tier prefetch and eviction tunables ────────────────────────────────
const STREAMING_PRESET_TABLE = {
    LOW: {
        maxInflightRequests: 2,
        prefetchConeAngle: Math.PI / 5,
        prefetchRadius: 40.0,
        prefetchDistanceWeight: 0.7,
        prefetchPriorityThreshold: 0.55,
        evictionAggressiveness: 0.85,
        maxEvictionsPerFrame: 4,
        maxRequestsPerFrame: 1,
        maxDecodesPerFrame: 1,
        minTierResidentFrames: 30,
        missPenalty: 1.8,
        cachePersistLevels: 2
    },
    MID: {
        maxInflightRequests: 4,
        prefetchConeAngle: Math.PI / 4,
        prefetchRadius: 60.0,
        prefetchDistanceWeight: 0.6,
        prefetchPriorityThreshold: 0.45,
        evictionAggressiveness: 0.7,
        maxEvictionsPerFrame: 6,
        maxRequestsPerFrame: 2,
        maxDecodesPerFrame: 2,
        minTierResidentFrames: 20,
        missPenalty: 1.5,
        cachePersistLevels: 3
    },
    HIGH: {
        maxInflightRequests: 6,
        prefetchConeAngle: Math.PI / 3.5,
        prefetchRadius: 90.0,
        prefetchDistanceWeight: 0.5,
        prefetchPriorityThreshold: 0.35,
        evictionAggressiveness: 0.55,
        maxEvictionsPerFrame: 8,
        maxRequestsPerFrame: 3,
        maxDecodesPerFrame: 3,
        minTierResidentFrames: 12,
        missPenalty: 1.3,
        cachePersistLevels: 4
    },
    FLAGSHIP: {
        maxInflightRequests: 8,
        prefetchConeAngle: Math.PI / 3,
        prefetchRadius: 140.0,
        prefetchDistanceWeight: 0.4,
        prefetchPriorityThreshold: 0.25,
        evictionAggressiveness: 0.45,
        maxEvictionsPerFrame: 12,
        maxRequestsPerFrame: 4,
        maxDecodesPerFrame: 4,
        minTierResidentFrames: 8,
        missPenalty: 1.15,
        cachePersistLevels: 5
    }
};

// ─── Tunables specific to streaming cache ───────────────────────────────────
const StreamingCacheDefaults = {
    // Storage backend preference order. First available wins.
    backendPreference: [ StorageBackend.OPFS, StorageBackend.INDEXED_DB, StorageBackend.CACHE_API, StorageBackend.MEMORY ],

    // Whether to attempt to request persistent storage.
    requestPersistence: true,

    // Per-geometry tier persistence: how many lower tiers to persist on disk.
    // Higher values trade disk space for faster warm loading.
    persistTierCount: 3,

    // Whether to allow procedural fallback when the cache misses.
    allowProceduralFallback: true,

    // Fraction of the byte budget above which eviction triggers.
    evictionStartFraction: 0.85,

    // Fraction of the byte budget at which eviction becomes critical.
    evictionCriticalFraction: 0.95,

    // Whether to prefetch based on camera forward cone.
    enableCameraPrefetch: true,

    // Whether to prefetch based on player motion direction.
    enablePlayerPrefetch: true,

    // Whether to prefetch based on predicted player position from 007_7.
    enablePredictedPrefetch: true,

    // Whether to prefetch based on previous frame's LOD tier transitions.
    enableHistoricalPrefetch: true,

    // Multi-frame smoothing on prefetch priority.
    prefetchSmoothing: 0.25,

    // Deterministic seed base.
    determinismSeed: 0xC2B2AE3D,

    // Cache key hash salt (used to differentiate scene IDs).
    cacheKeySalt: 0x9E3779B1,

    // Whether to relax stream under thermal pressure.
    thermalThrottleStream: true,

    // Thermal pressure above which streaming pauses new requests.
    thermalPauseThreshold: 0.85,

    // Whether to relax stream under battery pressure.
    batteryThrottleStream: true,

    // Battery pressure above which streaming pauses new requests.
    batteryPauseThreshold: 0.85,

    // Whether to relax stream under memory pressure.
    memoryThrottleStream: true,

    // Memory pressure above which streaming evicts aggressively.
    memoryEvictThreshold: 0.75,

    // Whether to share the cache across LODs of the same geometry.
    shareAcrossLODs: true,

    // Whether to warm-load the target tier at attach time.
    warmLoadOnAttach: true,

    // Timeout for a single storage request (ms).
    storageTimeoutMs: 3000,

    // Number of retries on storage failure.
    storageRetries: 2,

    // Whether to emit events for hits / misses / evictions.
    emitEvents: true
};

/**
 * StreamingGeometryCacheLOD
 *
 * Extends SkinningCostMultiplierLOD and adds a fully asynchronous streaming
 * geometry cache. The class is the last layer in the interconnected LOD
 * stack, sitting on top of the material floor and the skinning cap. Its
 * responsibility is:
 *
 *   1. On attachTarget, register the geometry in a shared cache keyed by
 *      geometry UUID.
 *
 *   2. During update(), resolve a desired tier from the parent's dynamic
 *      density (12.5% / 25% / 50% / 75% / 100%) and request the tier if
 *      not resident.
 *
 *   3. Prefetch upcoming tiers using camera and player motion from
 *      earlier layers (motion, prediction) plus a historical transition
 *      predictor.
 *
 *   4. Evict tiers when the byte budget is exceeded, using an LRU with
 *      priority weighting and deterministic jitter.
 *
 *   5. Respect Android-specific pressure signals (thermal, battery,
 *      memory) by pausing or relaxing streaming.
 *
 * Storage backends are tried in order: OPFS, IndexedDB, Cache API, memory.
 * If no backend is available, the class falls back to procedural
 * generation via the target's `setDensity` callback.
 *
 * Recommended usage on Android 64-bit:
 * ```js
 * // One-time setup
 * const tier = TelemetryBudgetHUDLOD.detectAndroidTier( renderer );
 * TelemetryBudgetHUDLOD.applyTierPreset( tier );
 * PerMaterialDensityFloorLOD.setAndroidTier( tier );
 * SkinningCostMultiplierLOD.setAndroidTier( tier, renderer );
 * StreamingGeometryCacheLOD.setAndroidTier( tier );
 *
 * // Optional: warm the cache at startup
 * await StreamingGeometryCacheLOD.initStorage();
 *
 * // Per LOD
 * const lod = new StreamingGeometryCacheLOD();
 * lod.attachTarget( terrainChunk, { vertexBudget: 250000 } );
 * lod.registerWithAllocator( 'terrain' );
 *
 * // Per frame
 * TelemetryBudgetHUDLOD.beginFrame( frameIndex );
 * for ( const l of allLODs ) l.update( camera, player, dt );
 * StreamingGeometryCacheLOD.flushStreaming();
 * AsyncDensityApplicationLOD.flushAsync();
 * TelemetryBudgetHUDLOD.endFrame( deltaTimeMs, renderer );
```

· 
· @augments SkinningCostMultiplierLOD
  */
  class StreamingGeometryCacheLOD extends SkinningCostMultiplierLOD {
  constructor() {
  super();
  }
  // ─── Public API: events ─────────────────────────────────────────────────
  on( eventType, callback ) {
  let set = this._eventListeners.get( eventType );
  if ( set === undefined ) {
  set = new Set();
  this._eventListeners.set( eventType, set );
  }
  set.add( callback );
  return this;
  }
  off( eventType, callback ) {
  const set = this._eventListeners.get( eventType );
  if ( set !== undefined ) set.delete( callback );
  return this;
  }
  _emit( eventType, payload ) {
  if ( ! this.emitEvents ) return;
  const set = this._eventListeners.get( eventType );
  if ( set === undefined ) return;
  for ( const cb of set ) {
  try { cb( payload ); } catch ( e ) { void e; }
  }
  }
  // ─── Public API: streaming controls ─────────────────────────────────────
  enableStreaming( enabled = true ) {
  this._enabled = enabled;
  return this;
  }
  freezeStreaming( frozen = true ) {
  this._streamFrozen = frozen;
  return this;
  }
  getCurrentTier() {
  return this._currentTier;
  }
  getTargetTier() {
  return this._targetTier;
  }
  getResidentBytes() {
  return this._bytesResident;
  }
  isTierResident( tier ) {
  if ( tier < 0 || tier >= TIER_COUNT ) return false;
  return ( this._residencyMask & ( 1 << tier ) ) !== 0;
  }
  getCacheLedger() {
  const resident = new Double( this._bytesResident );
  const budget = new Double( Math.max( 1, this._deviceByteBudget ) );
  }
  // ─── Update override ────────────────────────────────────────────────────
  update( camera, player = this.player, rawDeltaTime = 0.016 ) {
  if ( this.mode === LOD_MODE.CONVENTIONAL ) {
  super.update( camera, player, rawDeltaTime );
  return;
  }
  }
  // ─── Tier resolution ────────────────────────────────────────────────────
  _ensureTier( tier ) {
  if ( tier < 0 || tier >= TIER_COUNT ) return;
  }
  _requestTier( tier ) {
  const key = this._geometryKey;
  }
  _getTierImportance( tier ) {
  // Higher tiers are more visually important; bias priority accordingly.
  return TIER_DENSITIES[ tier ] * 0.5;
  }
  // ─── Prefetch priority ──────────────────────────────────────────────────
  _computePrefetchPriority() {
  const preset = this._getPreset();
  }
  // ─── Pressure throttling ────────────────────────────────────────────────
  _applyPressureThrottling() {
  const S = StreamingGeometryCacheLOD;
  }
  // ─── Geometry registration ──────────────────────────────────────────────
  attachTarget( target, options = {} ) {
  super.attachTarget( target, options );
  }
  _computeTierBytes( geometry ) {
  // Estimate the memory footprint of each tier based on the geometry's
  // full vertex count and index count. Each vertex is assumed to
  // consume 32 bytes (position 3 × 4 + normal 3 × 4 + uv 2 × 4 + skin
  // and index overhead). Indices consume 4 bytes each.
  let vertexCount = 0;
  }
  _getPreset() {
  const key = SkinningCostMultiplierLOD._tierKey( this._androidTier );
  return STREAMING_PRESET_TABLE[ key ] || STREAMING_PRESET_TABLE.MID;
  }
  // ─── Static storage initialization ──────────────────────────────────────
  /**
  · Initializes the storage backend. Must be awaited before streaming
  · can persist tiers across sessions.
  · 
  · @return {Promise<boolean>} True if a storage backend is available.
    */
    static async initStorage() {
    const S = StreamingGeometryCacheLOD;
    // Try OPFS first.
    if ( S._storageBackend === StorageBackend.NONE ) {
    try {
    if ( typeof navigator !== 'undefined' && navigator.storage !== undefined && navigator.storage.getDirectory !== undefined ) {
    const root = await navigator.storage.getDirectory();
    if ( root !== null ) {
    S._storageBackend = StorageBackend.OPFS;
    S._storageRoot = root;
    S._storageAvailable = true;
    }
    }
    } catch ( e ) {
    S._storageBackend = StorageBackend.NONE;
    }
    }
    // Try IndexedDB.
    if ( S._storageBackend === StorageBackend.NONE ) {
    try {
    if ( typeof indexedDB !== 'undefined' ) {
    const db = await S._openIndexedDB();
    if ( db !== null ) {
    S._storageBackend = StorageBackend.INDEXED_DB;
    S._storageDB = db;
    S._storageAvailable = true;
    }
    }
    } catch ( e ) {
    S._storageBackend = StorageBackend.NONE;
    }
    }
    // Try Cache API.
    if ( S._storageBackend === StorageBackend.NONE ) {
    try {
    if ( typeof caches !== 'undefined' ) {
    const cache = await caches.open( 'threejs-lod-geometry-v1' );
    if ( cache !== undefined ) {
    S._storageBackend = StorageBackend.CACHE_API;
    S._storageCache = cache;
    S._storageAvailable = true;
    }
    }
    } catch ( e ) {
    S._storageBackend = StorageBackend.NONE;
    }
    }
    // Fallback to memory.
    if ( S._storageBackend === StorageBackend.NONE ) {
    S._storageBackend = StorageBackend.MEMORY;
    S._storageAvailable = true;
    }
    // Request persistence if supported.
    if ( StreamingCacheDefaults.requestPersistence ) {
    try {
    if ( typeof navigator !== 'undefined' && navigator.storage !== undefined && navigator.storage.persist !== undefined ) {
    const persisted = await navigator.storage.persist();
    S._storagePersistent = persisted === true;
    }
    } catch ( e ) {
    S._storagePersistent = false;
    }
    }
    return S._storageAvailable;
    }
  static _openIndexedDB() {
  return new Promise( ( resolve ) => {
  try {
  const req = indexedDB.open( 'threejs-lod-geometry-v1', 1 );
  }
  /**
  · Returns the current storage backend.
  · @return {number}
    */
    static getStorageBackend() {
    return StreamingGeometryCacheLOD._storageBackend;
    }
  /**
  · Returns true if persistent storage was granted.
  · @return {boolean}
    */
    static isStoragePersistent() {
    return StreamingGeometryCacheLOD._storagePersistent;
    }
  // ─── Static frame flush ─────────────────────────────────────────────────
  /**
  · Flushes streaming activity for the current frame. Called once per frame
  · by the host, after all LOD updates and before AsyncDensityApplicationLOD.flushAsync().
    */
    static flushStreaming() {
    const S = StreamingGeometryCacheLOD;
    // ── 1. Drain the decode queue. ──────────────────────────────────────
    S._drainDecodeQueue();
    // ── 2. Update byte accounting. ──────────────────────────────────────
    S._updateByteAccounting();
    // ── 3. Evict under pressure. ────────────────────────────────────────
    S._evictUnderBudget();
    // ── 4. Update per-LOD budget utilization. ───────────────────────────
    const globalBudget = S._globalByteBudget;
    if ( globalBudget > 0 ) {
    const util = S._globalBytesResident / globalBudget;
    for ( const lod of S._registeredStreaming ) {
    lod._budgetUtilization = util;
    }
    }
    }
  static _drainDecodeQueue() {
  const S = StreamingGeometryCacheLOD;
  const queue = S._decodeQueue;
  }
  static _resolveTierJob( job ) {
  const S = StreamingGeometryCacheLOD;
  const lod = job.lod;
  const shared = S._sharedCache.get( job.key );
  if ( shared === undefined ) return false;
  }
  static _applyTierToGeometry( lod, tier ) {
  const target = lod.target;
  if ( target === null ) return;
  }
  static _readTierFromStorage( job ) {
  const S = StreamingGeometryCacheLOD;
  const lod = job.lod;
  const tierKey = job.key + ':' + job.tier;
  }
  static _readFromOPFS( key, onComplete ) {
  const S = StreamingGeometryCacheLOD;
  }
  static _readFromIndexedDB( key, onComplete ) {
  const S = StreamingGeometryCacheLOD;
  }
  static _readFromCacheAPI( key, onComplete ) {
  const S = StreamingGeometryCacheLOD;
  }
  // ─── Byte accounting and eviction ───────────────────────────────────────
  static _updateByteAccounting() {
  const S = StreamingGeometryCacheLOD;
  }
  static _evictUnderBudget() {
  const S = StreamingGeometryCacheLOD;
  }
  static _evictBelowBudget( targetBytes, aggressive ) {
  const S = StreamingGeometryCacheLOD;
  }
  // ─── Static context update ──────────────────────────────────────────────
  /**
  · Publishes the current camera matrix and forward vector to all
  · registered streaming LODs. Call once per frame from the host.
  · 
  · @param {Camera} camera
    */
    static updateCamera( camera ) {
    const S = StreamingGeometryCacheLOD;
    if ( camera === null || camera === undefined ) {
    S._cameraForwardValid = false;
    return;
    }
    const e = camera.matrixWorld.elements;
    S._cameraMatrixWorld = e;
    S._cameraForwardX = - e[ 8 ];
    S._cameraForwardY = - e[ 9 ];
    S._cameraForwardZ = - e[ 10 ];
    S._cameraForwardValid = true;
    }
  /**
  · Publishes the current player motion to all registered streaming LODs.
  · @param {number} px
  · @param {number} py
  · @param {number} pz
  · @param {number} vx
  · @param {number} vy
  · @param {number} vz
    */
    static updatePlayer( px, py, pz, vx, vy, vz ) {
    const S = StreamingGeometryCacheLOD;
    S._playerPositionX = px;
    S._playerPositionY = py;
    S._playerPositionZ = pz;
    S._playerVelocityX = vx;
    S._playerVelocityY = vy;
    S._playerVelocityZ = vz;
    S._playerVelocityMagnitude = Math.hypot( vx, vy, vz );
    }
  /**
  · Publishes the predicted player position to all registered streaming LODs.
  · @param {number} px
  · @param {number} py
  · @param {number} pz
    */
    static updatePredictedPlayer( px, py, pz ) {
    const S = StreamingGeometryCacheLOD;
    S._predictedPlayerX = px;
    S._predictedPlayerY = py;
    S._predictedPlayerZ = pz;
    S._predictedPlayerValid = true;
    }
  /**
  · Publishes global pressure signals to all registered streaming LODs.
  · @param {number} thermal
  · @param {number} battery
  · @param {number} memory
    */
    static updatePressure( thermal, battery, memory ) {
    for ( const lod of StreamingGeometryCacheLOD._registeredStreaming ) {
    lod._thermalPressure = Math.min( 1.0, Math.max( 0.0, thermal ) );
    lod._batteryPressure = Math.min( 1.0, Math.max( 0.0, battery ) );
    lod._memoryPressure = Math.min( 1.0, Math.max( 0.0, memory ) );
    }
    }
  /**
  · Publishes the Android tier to all registered streaming LODs.
  · @param {number} tier
    */
    static setAndroidTier( tier ) {
    StreamingGeometryCacheLOD._androidTier = tier;
    StreamingGeometryCacheLOD._globalByteBudget = StreamingGeometryCacheLOD._getTierBudget( tier );
    for ( const lod of StreamingGeometryCacheLOD._registeredStreaming ) {
    lod._androidTier = tier;
    lod._deviceByteBudget = StreamingGeometryCacheLOD._globalByteBudget;
    }
    }
  static _getTierBudget( tier ) {
  switch ( tier ) {
  case 1: return MOBILE_BYTE_BUDGET.LOW;
  case 2: return MOBILE_BYTE_BUDGET.MID;
  case 3: return MOBILE_BYTE_BUDGET.HIGH;
  case 4: return MOBILE_BYTE_BUDGET.FLAGSHIP;
  default: return MOBILE_BYTE_BUDGET.MID;
  }
  }
  static _densityToTier( density ) {
  // Find the highest tier whose density is <= the given density.
  let best = 0;
  for ( let t = 0; t < TIER_COUNT; t ++ ) {
  if ( TIER_DENSITIES[ t ] <= density ) {
  best = t;
  } else {
  break;
  }
  }
  return best;
  }
  /**
  · Returns a snapshot of the shared cache state for telemetry.
  · @return {object}
    */
    static getSharedCacheStats() {
    const S = StreamingGeometryCacheLOD;
    let entryCount = 0;
    let totalBytes = 0.0;
    let totalHits = 0;
    let totalMisses = 0;
    for ( const shared of S._sharedCache.values() ) {
    entryCount ++;
    totalBytes += shared.bytesResident;
    totalHits += shared.accessCount;
    totalMisses += shared.evictionCount;
    }
    return {
    entryCount: entryCount,
    totalBytesResident: totalBytes,
    globalByteBudget: S._globalByteBudget,
    budgetUtilization: S._globalByteBudget > 0 ? totalBytes / S._globalByteBudget : 0.0,
    inflightCount: S._inflightGlobalCount,
    decodeQueueLength: S._decodeQueue.length,
    storageBackend: S._storageBackend,
    storageAvailable: S._storageAvailable,
    storagePersistent: S._storagePersistent,
    streamingActive: S._streamingActive,
    totalHits: totalHits,
    totalMisses: totalMisses
    };
    }
  /**
  · Clears the shared cache.
    */
    static clearSharedCache() {
    const S = StreamingGeometryCacheLOD;
    S._sharedCache.clear();
    S._decodeQueue.length = 0;
    S._globalBytesResident = 0.0;
    S._inflightGlobalCount = 0;
    }
  static _registerStreamingLOD( lod ) {
  StreamingGeometryCacheLOD._registeredStreaming.add( lod );
  }
  static _unregisterStreamingLOD( lod ) {
  StreamingGeometryCacheLOD._registeredStreaming.delete( lod );
  }
  static _hashString( s ) {
  let h = 0x811c9dc5;
  for ( let i = 0; i < s.length; i ++ ) {
  h ^= s.charCodeAt( i );
  h = Math.imul( h, 0x01000193 );
  }
  return h >>> 0;
  }
  static _nowMs() {
  if ( typeof performance !== 'undefined' && typeof performance.now === 'function' ) {
  return performance.now();
  }
  return Date.now();
  }
  // ─── ECS registration ───────────────────────────────────────────────────
  registerStreamingECS() {
  if ( this._ecsStreamingRegistered ) {
  return this._ecsStreamingEntity;
  }
  }
  syncStreamingECS() {
  if ( ! this._ecsStreamingRegistered ) {
  return this;
  }
  }
  pullStreamingECS() {
  if ( ! this._ecsStreamingRegistered ) {
  return this;
  }
  }
  // ─── Copy / JSON ────────────────────────────────────────────────────────
  copy( source ) {
  super.copy( source );
  }
  toJSON( meta ) {
  const data = super.toJSON( meta );
  }
  // ─── gl-matrix / double.js / simplex-noise utilities ────────────────────
  multiplyMat4GL( out, a, b ) {
  glMatrix.mat4.multiply( out || _scratchMat4, a, b );
  return out || _scratchMat4;
  }
  /**
  · High-precision byte accounting for the entire shared cache using
  · double.js. Useful when aggregating hundreds of MB of cached geometry.
  · @return {number}
    */
    static computeTotalBytesHighPrecision() {
    const S = StreamingGeometryCacheLOD;
    let total = new Double( 0 );
    for ( const shared of S._sharedCache.values() ) {
    total = total.add( new Double( shared.bytesResident ) );
    }
    return total.valueOf();
    }
  /**
  · Returns a deterministic dither sample for eviction and prefetch
  · ordering. Prevents thundering-herd cache misses when many LODs
  · request the same tier in the same frame.
  · @param {number} frameIndex
  · @return {number}
    */
    computeStreamingDither( frameIndex ) {
    const seed = ( this.determinismSeed ^ ( this._geometryKey >>> 0 ) ) >>> 0;
    return _noise3D( seed * 1e-6, frameIndex * 0.02, this.id );
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
  · Packs streaming telemetry into a vec4 for GPU debug rendering.
  · Layout: (currentTier, targetTier, residencyMask, inflightMask)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packStreamingVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
    v,
    this._currentTier,
    this._targetTier,
    this._residencyMask,
    this._inflightMask
    );
    return v;
    }
  /**
  · Packs the cache key into a Float64Array for GPU-side telemetry.
  · Layout: (geometryKey, geometryId, geometryUuidHash, cacheKeySalt)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packCacheKeyVec4( out ) {
    const v = out || _cacheKeyVec;
    v[ 0 ] = this._geometryKey;
    v[ 1 ] = this._geometryId;
    v[ 2 ] = this._geometryUuidHash;
    v[ 3 ] = this.cacheKeySalt;
    return v;
    }
  /**
  · Returns a deterministic hash of the geometry UUID suitable for use as
  · a cache key component. Uses gl-matrix hashing for consistency with the
  · prefetch cone math.
  · @param {string} uuid
  · @return {number}
    */
    static hashGeometryUuid( uuid ) {
    return StreamingGeometryCacheLOD._hashString( uuid );
    }
  static getECSWorld() {
  return _streamingWorld;
  }
  static getStreamingSoA() {
  return StreamingCacheSoA;
  }
  static get StreamingCacheDefaults() {
  return StreamingCacheDefaults;
  }
  static get StorageBackend() {
  return StorageBackend;
  }
  static get TierDensities() {
  return TIER_DENSITIES;
  }
  static get MobileByteBudget() {
  return MOBILE_BYTE_BUDGET;
  }
  static get StreamingPresetTable() {
  return STREAMING_PRESET_TABLE;
  }
  }

// ─── Static streaming storage (module-scoped, shared across all instances) ──
StreamingGeometryCacheLOD._registeredStreaming = new Set();
StreamingGeometryCacheLOD._sharedCache = new Map();
StreamingGeometryCacheLOD._decodeQueue = [];

StreamingGeometryCacheLOD._globalBytesResident = 0.0;
StreamingGeometryCacheLOD._globalByteBudget = MOBILE_BYTE_BUDGET.MID;
StreamingGeometryCacheLOD._inflightGlobalCount = 0;
StreamingGeometryCacheLOD._streamingActive = true;

StreamingGeometryCacheLOD._storageBackend = StorageBackend.NONE;
StreamingGeometryCacheLOD._storageAvailable = false;
StreamingGeometryCacheLOD._storagePersistent = false;
StreamingGeometryCacheLOD._storageRoot = null;
StreamingGeometryCacheLOD._storageDB = null;
StreamingGeometryCacheLOD._storageCache = null;

StreamingGeometryCacheLOD._androidTier = 2; // MID default
StreamingGeometryCacheLOD._isMobile64 = false;

// Camera context (updated by updateCamera).
StreamingGeometryCacheLOD._cameraMatrixWorld = new Float64Array( 16 );
StreamingGeometryCacheLOD._cameraForwardX = 0.0;
StreamingGeometryCacheLOD._cameraForwardY = 0.0;
StreamingGeometryCacheLOD._cameraForwardZ = - 1.0;
StreamingGeometryCacheLOD._cameraForwardValid = false;

// Player context (updated by updatePlayer).
StreamingGeometryCacheLOD._playerPositionX = 0.0;
StreamingGeometryCacheLOD._playerPositionY = 0.0;
StreamingGeometryCacheLOD._playerPositionZ = 0.0;
StreamingGeometryCacheLOD._playerVelocityX = 0.0;
StreamingGeometryCacheLOD._playerVelocityY = 0.0;
StreamingGeometryCacheLOD._playerVelocityZ = 0.0;
StreamingGeometryCacheLOD._playerVelocityMagnitude = 0.0;

// Predicted player context (updated by updatePredictedPlayer).
StreamingGeometryCacheLOD._predictedPlayerX = 0.0;
StreamingGeometryCacheLOD._predictedPlayerY = 0.0;
StreamingGeometryCacheLOD._predictedPlayerZ = 0.0;
StreamingGeometryCacheLOD._predictedPlayerValid = false;

void BufferGeometry;
void BufferAttribute;
void InterleavedBufferAttribute;
void Object3D;

export {
StreamingGeometryCacheLOD,
StreamingCacheSoA,
StreamingCacheDefaults,
StorageBackend,
TIER_DENSITIES,
TIER_COUNT,
MOBILE_BYTE_BUDGET,
STREAMING_PRESET_TABLE
};

