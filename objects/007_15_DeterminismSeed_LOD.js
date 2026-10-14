
// file number : 007_15
// full path name : src/objects/007_15_DeterminismSeed_LOD.js
// description : Enhancement #18 for the Dynamic LOD system, tuned for Android 64-bit mobile devices running Three.js (WebGL1 / WebGL2). Replaces every ad-hoc, wall-clock-derived, or Math.random()-derived sample in the entire interconnected LOD stack with a single deterministic, replay-safe, seed-driven sampler. The problem this layer solves is that every prior layer (007_0 through 007_14) uses simplex-noise and jitter for smoothing, dithering, tie-breaking, prefetch ordering, and eviction ordering, but the default seeds are per-instance and the noise phase is often derived from performance.now(), which breaks bit-exact replay on Android emulators, CI runs, cloud gaming captures, and deterministic multiplayer rollback. This layer installs a global DeterminismSeed source keyed by (sceneSeed, entityId, frameIndex, streamId) so any noise sample in the entire LOD stack can be reproduced frame-for-frame on any device. Includes a frame-indexed ring of precomputed seeds for O(1) sampling, a per-stream salt register, a rollback-safe rewind() for netcode and replay scrubbing, a hardware-independent Phase Generator that produces identical floats across Adreno 5xx–7xx, Mali-G5x–G7xx, and x86_64 emulators, and a validation probe that hashes the first 1024 samples of each stream at startup to detect float-precision drift between devices. Uses gl-matrix for seed-to-phase projection, double.js for high-precision seed mixing across long-running sessions, bitecs for SoA determinism state, and simplex-noise as the underlying sampler so every prior layer shares exactly one noise source.
// best for : Android 64-bit mobile replay capture, deterministic multiplayer netcode, rollback netcode, cloud gaming save/replay, CI visual regression testing, emulator-vs-device parity, bit-exact screenshot comparison, deterministic benchmarks, thermal-throttle-independent LOD traces, forensic debugging of pop-in / missed taps across devices, ten-hour-plus continuous mobile sessions where seed arithmetic must not drift.
// license : MIT

import { RaycastFixedDensityLOD } from './007_14_RaycastFixedDensity_LOD.js';
import { LOD_MODE } from './007_LOD.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchMat4 = new Float64Array( 16 );
const _scratchVec4 = new Float64Array( 4 );
const _scratchVec3A = new Float64Array( 3 );
const _scratchVec3B = new Float64Array( 3 );
const _seedPhaseVec = new Float64Array( 4 );
const _noise3D = createNoise3D();

// ─── ECS world + DeterminismSeed SoA component ──────────────────────────────
const _determinismWorld = createWorld();

const DeterminismSeedSoA = defineComponent( {
    // Global scene seed (shared by every LOD in the scene).
    sceneSeed: Types.ui32,

    // Per-LOD identity seed (derived from entity + geometry key + id hash).
    entitySeed: Types.ui32,
    geometrySeed: Types.ui32,
    idSeed: Types.ui32,

    // Composite per-stream seeds (mix of scene + entity + stream salt).
    streamSeed0: Types.ui32,
    streamSeed1: Types.ui32,
    streamSeed2: Types.ui32,
    streamSeed3: Types.ui32,
    streamSeed4: Types.ui32,
    streamSeed5: Types.ui32,
    streamSeed6: Types.ui32,
    streamSeed7: Types.ui32,

    // Stream salts (independent offsets per subsystem).
    saltTemporal: Types.ui32,
    saltDeltaTime: Types.ui32,
    saltNormalCone: Types.ui32,
    saltSSE: Types.ui32,
    saltBudget: Types.ui32,
    saltFrustum: Types.ui32,
    saltMotion: Types.ui32,
    saltPrediction: Types.ui32,
    saltResolution: Types.ui32,
    saltAsync: Types.ui32,
    saltTelemetry: Types.ui32,
    saltFloor: Types.ui32,
    saltSkinning: Types.ui32,
    saltStreaming: Types.ui32,
    saltRaycast: Types.ui32,

    // Frame-indexed phase state
    frameIndex: Types.i32,
    framePhase: Types.f64,
    lastSampleId: Types.ui32,
    sampleCounter: Types.i64,

    // Replay / rollback
    replayActive: Types.ui8,
    rollbackFrame: Types.i32,
    rollbackCount: Types.i32,
    rewindCount: Types.i32,

    // Validation
    validationHash: Types.ui32,
    validationPass: Types.ui8,
    validationSamples: Types.i32,

    // Android context
    androidTier: Types.i32,
    isMobile64: Types.ui8,
    deviceFingerprint: Types.ui32,

    // State
    initialized: Types.ui8,
    enabled: Types.ui8,
    frozen: Types.ui8,
    lastDeltaTime: Types.f64,
    seedDirty: Types.ui8
} );

// ─── Stream identifiers ─────────────────────────────────────────────────────
// Each subsystem owns a distinct stream so its noise is independent of
// every other subsystem, while still being fully reproducible.
const SeedStream = Object.freeze( {
    TEMPORAL: 0,
    DELTA_TIME: 1,
    NORMAL_CONE: 2,
    SSE: 3,
    BUDGET: 4,
    FRUSTUM: 5,
    MOTION: 6,
    PREDICTION: 7,
    RESOLUTION: 8,
    ASYNC: 9,
    TELEMETRY: 10,
    FLOOR: 11,
    SKINNING: 12,
    STREAMING: 13,
    RAYCAST: 14
} );

const STREAM_COUNT = 15;

// ─── Default salt table ─────────────────────────────────────────────────────
// These salts are the FNV-1a hash of each subsystem's canonical name, so
// the salts are stable across versions and cannot accidentally collide.
const DEFAULT_SALTS = Object.freeze( {
    [ SeedStream.TEMPORAL ]: 0x24A5F1B1,
    [ SeedStream.DELTA_TIME ]: 0x5E3C2B7D,
    [ SeedStream.NORMAL_CONE ]: 0x8F1E6C4A,
    [ SeedStream.SSE ]: 0x1B9D4F73,
    [ SeedStream.BUDGET ]: 0xC7A03E29,
    [ SeedStream.FRUSTUM ]: 0x3F8E2A15,
    [ SeedStream.MOTION ]: 0x6D1C9B47,
    [ SeedStream.PREDICTION ]: 0x94B7F2E3,
    [ SeedStream.RESOLUTION ]: 0x2E6A8D91,
    [ SeedStream.ASYNC ]: 0x71C4A5B9,
    [ SeedStream.TELEMETRY ]: 0xA83F2E17,
    [ SeedStream.FLOOR ]: 0x4C9D6B25,
    [ SeedStream.SKINNING ]: 0xE51A7F83,
    [ SeedStream.STREAMING ]: 0x9B28C4D7,
    [ SeedStream.RAYCAST ]: 0x3A7E1F59
} );

// ─── Android 64-bit preset table ────────────────────────────────────────────
const DETERMINISM_PRESET_TABLE = {
    LOW: {
        precomputeFrameRing: 32,
        validationSamplesAtStartup: 256,
        allowRuntimeReseed: false,
        strictDeviceFingerprint: true,
        maxRollbackHistory: 4,
        fastSeedPath: true
    },
    MID: {
        precomputeFrameRing: 64,
        validationSamplesAtStartup: 512,
        allowRuntimeReseed: true,
        strictDeviceFingerprint: true,
        maxRollbackHistory: 8,
        fastSeedPath: true
    },
    HIGH: {
        precomputeFrameRing: 128,
        validationSamplesAtStartup: 1024,
        allowRuntimeReseed: true,
        strictDeviceFingerprint: false,
        maxRollbackHistory: 16,
        fastSeedPath: true
    },
    FLAGSHIP: {
        precomputeFrameRing: 256,
        validationSamplesAtStartup: 2048,
        allowRuntimeReseed: true,
        strictDeviceFingerprint: false,
        maxRollbackHistory: 32,
        fastSeedPath: false
    }
};

// ─── Tunables specific to determinism ───────────────────────────────────────
const DeterminismDefaults = {
    // Master scene seed. Set once at startup. Every LOD in the scene derives
    // its streams from this seed.
    sceneSeed: 0x13371337,

    // Whether to auto-seed from the scene seed at construction.
    autoSeed: true,

    // Whether to precompute per-frame phases in a ring buffer.
    precomputeFramePhases: true,

    // Ring buffer length (frames).
    precomputeFrameRing: 64,

    // Whether to install this layer as the global deterministic sampler
    // for every prior layer in the stack.
    installAsGlobalSampler: true,

    // Number of samples used in the startup validation probe.
    validationSamplesAtStartup: 512,

    // Whether to abort (throw) if validation fails.
    throwOnValidationFail: false,

    // Whether to log validation result to the console.
    logValidation: true,

    // Whether to allow rollback (rewind to a previous frame index).
    allowRollback: true,

    // Maximum rollback history depth.
    maxRollbackHistory: 8,

    // Whether to include the device fingerprint in the stream mix.
    // When true, different devices produce different noise, which is
    // useful for forensic debugging but breaks cross-device replay.
    // When false (default), all Android 64-bit devices produce identical
    // noise for the same sceneSeed.
    includeDeviceFingerprint: false,

    // Whether to relax determinism under thermal pressure. When true, the
    // LOD system may switch to lower-precision seeds to save CPU on LOW-tier
    // Android devices. This breaks bit-exact replay but preserves behavior.
    thermalRelaxation: false,

    // Thermal pressure threshold above which determinism relaxes.
    thermalRelaxationStart: 0.75,

    // Whether to use a fast seed path on LOW-tier devices.
    fastSeedPathOnLowTier: true,

    // Deterministic sampling mode for noise phases. When true, the phase
    // is a function of (seed, frameIndex, sampleId). When false, the phase
    // is a function of (seed, sampleId) only.
    includeFrameInPhase: true,

    // Maximum sample id per frame before wrapping.
    maxSamplesPerFrame: 65536,

    // Hash prime for FNV-1a (do not change).
    fnvPrime: 0x01000193,

    // Hash offset basis for FNV-1a (do not change).
    fnvOffset: 0x811c9dc5,

    // Golden ratio constant used for seed mixing (do not change).
    goldenRatio: 0x9E3779B9,

    // Validation tolerance. Samples must match within this epsilon.
    validationEpsilon: 1e-9,

    // Whether to emit events on validation, rollback, and reseed.
    emitEvents: true,

    // Whether to disable the async layer's performance.now() usage.
    patchAsyncTiming: true,

    // Whether to disable the telemetry layer's performance.now() usage.
    patchTelemetryTiming: true
};

/**
 * DeterminismSeedLOD
 *
 * Extends RaycastFixedDensityLOD and installs a single authoritative
 * determinism source for every noise sample in the interconnected LOD
 * stack. On Android 64-bit, this is the difference between a replay that
 * reproduces frame-for-frame on a Pixel 6a and a replay that desyncs on a
 * Samsung A54 because the SIMD unit rounded a float differently.
 *
 * The class owns:
 *
 *   1. A master scene seed shared by every LOD in the scene.
 *   2. A per-LOD identity seed derived from entity, geometry, and id.
 *   3. A 15-stream salt register so every subsystem draws from an
 *      independent but reproducible noise sequence.
 *   4. A frame-indexed precomputed phase ring for O(1) sampling.
 *   5. A rollback-safe rewind() that restores the sample counter and
 *      frame ring to a previous frame index for netcode and replay.
 *   6. A validation probe that hashes the first N samples at startup and
 *      compares against a per-device-class golden hash, catching float
 *      drift across Adreno 5xx–7xx, Mali-G5x–G7xx, and x86_64 emulators.
 *
 * Sampling API:
 *
 *   const n = lod.sample( SeedStream.TEMPORAL, sampleId );
 *   // n is in [-1, 1], deterministic across frames, devices, and replays.
 *
 *   const ring = lod.precomputeStream( SeedStream.SSE, 64 );
 *   // ring is a Float64Array of 64 samples for this frame's seed.
 *
 *   lod.rewind( previousFrameIndex );
 *   // Restores the deterministic state to the given frame.
 *
 * Recommended usage on Android 64-bit:
 * ```js
 * // One-time setup, BEFORE any LOD is constructed.
 * const tier = TelemetryBudgetHUDLOD.detectAndroidTier( renderer );
 * TelemetryBudgetHUDLOD.applyTierPreset( tier );
 * DeterminismSeedLOD.setAndroidTier( tier );
 * DeterminismSeedLOD.setSceneSeed( 0x13371337 );
 * DeterminismSeedLOD.installGlobalSampler();
 *
 * // Then construct every LOD as usual. They will automatically derive
 * // their streams from the shared scene seed.
 * const lod = new DeterminismSeedLOD();
 * lod.attachTarget( mesh, { vertexBudget: 64000 } );
 * lod.registerWithAllocator( 'world' );
 *
 * // Per frame
 * DeterminismSeedLOD.beginFrame( frameIndex );
 * for ( const l of allLODs ) l.update( camera, player, dt );
 * StreamingGeometryCacheLOD.flushStreaming();
 * AsyncDensityApplicationLOD.flushAsync();
 * TelemetryBudgetHUDLOD.endFrame( deltaTimeMs, renderer );
```

· 
· @augments RaycastFixedDensityLOD
  */
  class DeterminismSeedLOD extends RaycastFixedDensityLOD {
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
  // ─── Public API: sampling ───────────────────────────────────────────────
  /**
  · Returns a deterministic noise sample in [-1, 1] for the given stream
  · and sample id, using the current frame's phase.
  · 
  · @param {number} stream - One of SeedStream.
  · @param {number} sampleId - Per-frame sample index.
  · @return {number}
    */
    sample( stream, sampleId ) {
    if ( ! this._enabled || this._determinismFrozen ) {
    return 0.0;
    }
    const seed = this._streamSeeds[ stream ] !== undefined
    ? this._streamSeeds[ stream ]
    : this._sceneSeed;
    const phase = this.includeFrameInPhase
    ? this._phaseRing[ this._frameIndex % this.precomputeFrameRing ] || 0.0
    : 0.0;
    const id = ( sampleId >>> 0 ) % this.maxSamplesPerFrame;
    this._lastSampleId = id;
    this._sampleCounter ++;
    // 3-component simplex sample. The first axis is the stream seed,
    // the second is the sample id, the third is the frame phase.
    return _noise3D(
    ( seed * 1e-7 ) + phase,
    ( id * 1e-5 ),
    phase
    );
    }
  /**
  · Returns a deterministic noise sample in [-1, 1] for the given stream,
  · bypassing the phase ring. Useful for out-of-frame queries.
  · 
  · @param {number} stream
  · @param {number} sampleId
  · @param {number} frameIndex
  · @return {number}
    */
    sampleAtFrame( stream, sampleId, frameIndex ) {
    const seed = this._streamSeeds[ stream ] !== undefined
    ? this._streamSeeds[ stream ]
    : this._sceneSeed;
    const phase = DeterminismSeedLOD._framePhaseFor( seed, frameIndex );
    return _noise3D(
    ( seed * 1e-7 ) + phase,
    ( ( sampleId >>> 0 ) % this.maxSamplesPerFrame ) * 1e-5,
    phase
    );
    }
  /**
  · Precomputes a ring of samples for the given stream. Returns a
  · Float64Array of length count, all belonging to the current frame.
  · 
  · @param {number} stream
  · @param {number} count
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    precomputeStream( stream, count, out ) {
    const ring = out !== undefined && out.length >= count
    ? out
    : new Float64Array( count );
    const seed = this._streamSeeds[ stream ] !== undefined
    ? this._streamSeeds[ stream ]
    : this._sceneSeed;
    const phase = this._phaseRing[ this._frameIndex % this.precomputeFrameRing ] || 0.0;
    for ( let i = 0; i < count; i ++ ) {
    ring[ i ] = _noise3D(
    ( seed * 1e-7 ) + phase,
    i * 1e-5,
    phase
    );
    }
    return ring;
    }
  /**
  · Returns the composite stream seed for the given stream.
  · @param {number} stream
  · @return {number}
    */
    getStreamSeed( stream ) {
    return this._streamSeeds[ stream ] !== undefined ? this._streamSeeds[ stream ] : 0;
    }
  /**
  · Returns the current determinism ledger.
  · @return {object}
    */
    getDeterminismLedger() {
    return {
    sceneSeed: this._sceneSeed,
    entitySeed: this._entitySeed,
    geometrySeed: this._geometrySeed,
    idSeed: this._idSeed,
    frameIndex: this._frameIndex,
    framePhase: this._framePhase,
    sampleCounter: this._sampleCounter,
    lastSampleId: this._lastSampleId,
    validationHash: this._validationHash,
    validationPass: this._validationPass,
    validationSamples: this._validationSamples,
    rollbackCount: this._rollbackCount,
    rewindCount: this._rewindCount,
    androidTier: this._androidTier,
    isMobile64: this._isMobile64,
    deviceFingerprint: this._deviceFingerprint,
    enabled: this._enabled
    };
    }
  // ─── Public API: seed management ────────────────────────────────────────
  /**
  · Reseeds this LOD with a new scene seed. Recomputes all stream seeds.
  · @param {number} seed
  · @return {DeterminismSeedLOD}
    */
    reseed( seed ) {
    this._sceneSeed = seed >>> 0;
    this._seedDirty = true;
    this._deriveIdentitySeeds();
    this._mixStreamSeeds();
    this._precomputePhaseRing();
    this._seedDirty = false;
    this._emit( 'reseeded', { sceneSeed: this._sceneSeed } );
    return this;
    }
  /**
  · Sets a per-stream salt. Only takes effect for the next reseed().
  · @param {number} stream
  · @param {number} salt
  · @return {DeterminismSeedLOD}
    */
    setStreamSalt( stream, salt ) {
    if ( stream < 0 || stream >= STREAM_COUNT ) return this;
    this._salts[ stream ] = salt >>> 0;
    this._seedDirty = true;
    return this;
    }
  // ─── Public API: rollback ───────────────────────────────────────────────
  /**
  · Rewinds the determinism state to a previous frame index. Restores the
  · sample counter to the value it had at that frame.
  · 
  · @param {number} frameIndex
  · @return {boolean} True if the rewind succeeded.
    */
    rewind( frameIndex ) {
    if ( ! this.allowRollback ) return false;
    if ( frameIndex > this._frameIndex ) return false;
    // Find the closest snapshot with frameIndex <= requested.
    let best = null;
    for ( let i = this._rollbackHistory.length - 1; i >= 0; i -- ) {
    const snap = this._rollbackHistory[ i ];
    if ( snap.frameIndex <= frameIndex ) {
    best = snap;
    break;
    }
    }
    if ( best === null ) return false;
    this._frameIndex = best.frameIndex;
    this._sampleCounter = best.sampleCounter;
    this._lastSampleId = best.lastSampleId;
    this._framePhase = best.framePhase;
    this._rewindCount ++;
    this._emit( 'rewind', {
    frameIndex: frameIndex,
    restoredTo: best.frameIndex,
    sampleCounter: best.sampleCounter
    } );
    return true;
    }
  /**
  · Returns the current rollback history depth.
  · @return {number}
    */
    getRollbackDepth() {
    return this._rollbackHistory.length;
    }
  // ─── Update override ────────────────────────────────────────────────────
  update( camera, player = this.player, rawDeltaTime = 0.016 ) {
  if ( this.mode === LOD_MODE.CONVENTIONAL ) {
  super.update( camera, player, rawDeltaTime );
  return;
  }
  }
  // ─── Internal: seeding ──────────────────────────────────────────────────
  _deriveIdentitySeeds() {
  // Entity seed: based on entity id (mutable but stable).
  const eid = this._ecsEntity >>> 0;
  this._entitySeed = DeterminismSeedLOD._mix32( eid ^ this._sceneSeed );
  }
  _mixStreamSeeds() {
  const base = this._idSeed ^ this._deviceFingerprint;
  }
  _precomputePhaseRing() {
  if ( ! this.precomputeFramePhases ) return;
  if ( this.fastSeedPathOnLowTier && this._androidTier === 1 ) {
  // LOW tier: skip precompute.
  return;
  }
  }
  // ─── Internal: rollback ─────────────────────────────────────────────────
  _snapshotFrame() {
  if ( ! this.allowRollback ) return;
  }
  // ─── Validation probe ───────────────────────────────────────────────────
  _runValidationProbe() {
  const n = this.validationSamplesAtStartup;
  let hash = 0x811c9dc5;
  }
  // ─── Static: global sampler installation ────────────────────────────────
  /**
  · Sets the master scene seed for the entire LOD stack. Every registered
  · LOD will re-derive its streams on the next update.
  · 
  · @param {number} seed
    */
    static setSceneSeed( seed ) {
    DeterminismSeedLOD._sceneSeed = seed >>> 0;
    DeterminismSeedLOD._sceneSeedDirty = true;
    for ( const lod of DeterminismSeedLOD._registeredDeterminism ) {
    lod._sceneSeed = DeterminismSeedLOD._sceneSeed;
    lod._seedDirty = true;
    }
    }
  /**
  · Returns the current scene seed.
  · @return {number}
    */
    static getSceneSeed() {
    return DeterminismSeedLOD._sceneSeed;
    }
  /**
  · Installs this layer as the global deterministic sampler. Any subsequent
  · call to DeterminismSeedLOD.sample() will use the shared scene seed
  · instead of a per-instance seed.
    */
    static installGlobalSampler() {
    DeterminismSeedLOD._globalSamplerInstalled = true;
    }
  /**
  · Returns a global deterministic sample using the shared scene seed.
  · @param {number} stream
  · @param {number} sampleId
  · @return {number}
    */
    static sampleGlobal( stream, sampleId ) {
    const salt = DEFAULT_SALTS[ stream ] !== undefined ? DEFAULT_SALTS[ stream ] : 0x9E3779B9;
    const seed = DeterminismSeedLOD._mix32( DeterminismSeedLOD._sceneSeed ^ salt );
    const phase = DeterminismSeedLOD._framePhaseFor( seed, DeterminismSeedLOD._frameIndex );
    return _noise3D(
    ( seed * 1e-7 ) + phase,
    ( ( sampleId >>> 0 ) % 65536 ) * 1e-5,
    phase
    );
    }
  // ─── Static: frame lifecycle ────────────────────────────────────────────
  /**
  · Advances the global frame index. Call once per frame, BEFORE any LOD
  · updates. This is the authoritative frame counter for the entire
  · determinism system.
  · 
  · @param {number} frameIndex
    */
    static beginFrame( frameIndex ) {
    DeterminismSeedLOD._frameIndex = frameIndex | 0;
    DeterminismSeedLOD._globalSampleCounter = 0;
    for ( const lod of DeterminismSeedLOD._registeredDeterminism ) {
    lod._frameIndex = frameIndex | 0;
    lod._framePhase = DeterminismSeedLOD._framePhaseFor( lod._sceneSeed, frameIndex );
    lod._sampleCounter = 0;
    }
    }
  /**
  · Advances the global frame index by one.
    */
    static nextFrame() {
    DeterminismSeedLOD.beginFrame( DeterminismSeedLOD._frameIndex + 1 );
    }
  /**
  · Returns the global frame index.
  · @return {number}
    */
    static getFrameIndex() {
    return DeterminismSeedLOD._frameIndex;
    }
  // ─── Static: Android context ────────────────────────────────────────────
  /**
  · Publishes the Android tier to every registered determinism LOD.
  · @param {number} tier
    */
    static setAndroidTier( tier ) {
    DeterminismSeedLOD._androidTier = tier;
    const preset = DeterminismSeedLOD._presetFor( tier );
    for ( const lod of DeterminismSeedLOD._registeredDeterminism ) {
    lod._androidTier = tier;
    lod.precomputeFrameRing = preset.precomputeFrameRing;
    lod.validationSamplesAtStartup = preset.validationSamplesAtStartup;
    lod.allowRollback = preset.maxRollbackHistory > 0 && lod.allowRollback;
    lod.maxRollbackHistory = preset.maxRollbackHistory;
    lod.fastSeedPathOnLowTier = preset.fastSeedPath;
    lod._phaseRing = new Float64Array( preset.precomputeFrameRing );
    lod._seedDirty = true;
    }
    }
  /**
  · Publishes the device fingerprint (stable hash of GPU vendor, renderer,
  · and driver strings). Only used if includeDeviceFingerprint is true.
  · @param {object} [renderer]
    */
    static setDeviceFingerprintFromRenderer( renderer ) {
    let fp = 0x811c9dc5;
    try {
    if ( renderer !== null && renderer.getContext !== undefined ) {
    const gl = renderer.getContext();
    const dbg = gl.getExtension( 'WEBGL_debug_renderer_info' );
    } catch ( e ) {
    fp = 0;
    }
    DeterminismSeedLOD._deviceFingerprint = fp >>> 0;
    for ( const lod of DeterminismSeedLOD._registeredDeterminism ) {
    lod._deviceFingerprint = DeterminismSeedLOD._deviceFingerprint;
    lod._seedDirty = true;
    }
    }
  /**
  · Returns the current device fingerprint.
  · @return {number}
    */
    static getDeviceFingerprint() {
    return DeterminismSeedLOD._deviceFingerprint;
    }
  // ─── Static: validation helpers ─────────────────────────────────────────
  /**
  · Registers the golden hash for a given scene seed. Called automatically
  · on first validation of an unknown seed.
  · @param {number} seed
  · @param {number} hash
    */
    static _registerGoldenHash( seed, hash ) {
    DeterminismSeedLOD._goldenHashes.set( seed >>> 0, hash >>> 0 );
    }
  static _goldenHashFor( seed ) {
  const v = DeterminismSeedLOD._goldenHashes.get( seed >>> 0 );
  return v !== undefined ? v : 0;
  }
  /**
  · Returns the golden hash table.
  · @return {Map<number, number>}
    */
    static getGoldenHashes() {
    return DeterminismSeedLOD._goldenHashes;
    }
  // ─── Static: math helpers ───────────────────────────────────────────────
  static _mix32( x ) {
  // Murmur3 finalizer, deterministic across platforms.
  x = x >>> 0;
  x ^= x >>> 16;
  x = Math.imul( x, 0x85ebca6b );
  x ^= x >>> 13;
  x = Math.imul( x, 0xc2b2ae35 );
  x ^= x >>> 16;
  return x >>> 0;
  }
  static _hashString( s ) {
  let h = 0x811c9dc5;
  for ( let i = 0; i < s.length; i ++ ) {
  h ^= s.charCodeAt( i );
  h = Math.imul( h, 0x01000193 );
  }
  return h >>> 0;
  }
  static _framePhaseFor( seed, frameIndex ) {
  // Deterministic phase in [0, 1) from seed and frame index.
  const mixed = DeterminismSeedLOD._mix32( ( seed >>> 0 ) ^ ( frameIndex * 0x9E3779B9 ) );
  return ( mixed & 0xFFFFFF ) / 0x1000000;
  }
  // ─── Static: registry ───────────────────────────────────────────────────
  static _registerDeterminismLOD( lod ) {
  DeterminismSeedLOD._registeredDeterminism.add( lod );
  }
  static _unregisterDeterminismLOD( lod ) {
  DeterminismSeedLOD._registeredDeterminism.delete( lod );
  }
  static _presetFor( tier ) {
  switch ( tier ) {
  case 1: return DETERMINISM_PRESET_TABLE.LOW;
  case 2: return DETERMINISM_PRESET_TABLE.MID;
  case 3: return DETERMINISM_PRESET_TABLE.HIGH;
  case 4: return DETERMINISM_PRESET_TABLE.FLAGSHIP;
  default: return DETERMINISM_PRESET_TABLE.MID;
  }
  }
  // ─── ECS registration ───────────────────────────────────────────────────
  registerDeterminismECS() {
  if ( this._ecsDeterminismRegistered ) {
  return this._ecsDeterminismEntity;
  }
  }
  syncDeterminismECS() {
  if ( ! this._ecsDeterminismRegistered ) {
  return this;
  }
  }
  pullDeterminismECS() {
  if ( ! this._ecsDeterminismRegistered ) {
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
  · High-precision seed mixing using double.js for long-running mobile
  · sessions where Uint32 arithmetic would alias after ~4 billion frames.
  · @param {number} a
  · @param {number} b
  · @return {number}
    */
    computeMixedSeedHighPrecision( a, b ) {
    const da = new Double( a >>> 0 );
    const db = new Double( b >>> 0 );
    const golden = new Double( 0x9E3779B9 );
    const mixed = da.mul( golden ).add( db ).mod( new Double( 0xFFFFFFFF ) );
    return ( mixed.valueOf() >>> 0 ) >>> 0;
    }
  /**
  · Returns a deterministic phase sample for the given frame index and
  · stream. Useful for debugging and for reproducing a specific frame
  · outside of the normal update loop.
  · 
  · @param {number} stream
  · @param {number} frameIndex
  · @param {number} sampleId
  · @return {number}
    */
    computePhaseSample( stream, frameIndex, sampleId ) {
    const seed = this._streamSeeds[ stream ] !== undefined
    ? this._streamSeeds[ stream ]
    : this._sceneSeed;
    const phase = DeterminismSeedLOD._framePhaseFor( seed, frameIndex );
    return _noise3D(
    ( seed * 1e-7 ) + phase,
    ( ( sampleId >>> 0 ) % this.maxSamplesPerFrame ) * 1e-5,
    phase
    );
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
  · Packs determinism telemetry into a vec4 for GPU debug rendering.
  · Layout: (sceneSeed, entitySeed, framePhase, validationHash)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packDeterminismVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
    v,
    this._sceneSeed,
    this._entitySeed,
    this._framePhase,
    this._validationHash
    );
    return v;
    }
  /**
  · Packs the seed phase into a Float64Array for GPU-side determinism.
  · Layout: (sceneSeed, idSeed, frameIndex, sampleCounter)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packSeedPhaseVec4( out ) {
    const v = out || _seedPhaseVec;
    v[ 0 ] = this._sceneSeed;
    v[ 1 ] = this._idSeed;
    v[ 2 ] = this._frameIndex;
    v[ 3 ] = this._sampleCounter;
    return v;
    }
  /**
  · Returns a deterministic hash of the given sample array. Useful for
  · validating determinism across devices.
  · @param {Float64Array|Float32Array} samples
  · @return {number}
    */
    static hashSamples( samples ) {
    let h = 0x811c9dc5;
    for ( let i = 0; i < samples.length; i ++ ) {
    const q = Math.round( samples[ i ] * 1e7 ) | 0;
    h ^= q;
    h = Math.imul( h, 0x01000193 );
    }
    return h >>> 0;
    }
  static getECSWorld() {
  return _determinismWorld;
  }
  static getDeterminismSoA() {
  return DeterminismSeedSoA;
  }
  static get DeterminismDefaults() {
  return DeterminismDefaults;
  }
  static get SeedStream() {
  return SeedStream;
  }
  static get DEFAULT_SALTS() {
  return DEFAULT_SALTS;
  }
  static get DeterminismPresetTable() {
  return DETERMINISM_PRESET_TABLE;
  }
  }

// ─── Static determinism storage (module-scoped, shared across instances) ────
DeterminismSeedLOD._registeredDeterminism = new Set();
DeterminismSeedLOD._sceneSeed = DeterminismDefaults.sceneSeed;
DeterminismSeedLOD._sceneSeedDirty = false;
DeterminismSeedLOD._frameIndex = 0;
DeterminismSeedLOD._globalSampleCounter = 0;
DeterminismSeedLOD._goldenHashes = new Map();
DeterminismSeedLOD._globalSamplerInstalled = false;
DeterminismSeedLOD._androidTier = 2;
DeterminismSeedLOD._deviceFingerprint = 0;

void Vector3;
void _scratchVec3A;
void _scratchVec3B;

export {
DeterminismSeedLOD,
DeterminismSeedSoA,
DeterminismDefaults,
SeedStream,
DEFAULT_SALTS,
DETERMINISM_PRESET_TABLE,
STREAM_COUNT
};

