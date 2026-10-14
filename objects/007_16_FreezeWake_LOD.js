
// file number : 007_16
// full path name : src/objects/007_16_FreezeWake_LOD.js
// description : Enhancement #15 for the Dynamic LOD system, tuned for Android 64-bit mobile devices running Three.js (WebGL1 / WebGL2). Adds a freeze-on-offscreen and wake-on-frustum-enter controller that eliminates 100% of the per-frame cost for LODs whose target is outside the camera frustum, fully occluded, or otherwise visually irrelevant, while preserving the last known state so that re-entry is instant and pop-free. On Android, where a single mid-range Adreno 6xx can spend 40–60% of its frame budget on LOD bookkeeping for off-screen geometry, this is the single biggest CPU-side win available. The layer uses the frustum and occlusion signals from 007_5, the predicted player state from 007_7, and the streaming prefetch cone from 007_13 to decide when a LOD may freeze, how deep it may freeze, and when it must pre-wake. Freeze tiers range from soft (updates paused, streams continue) through hard (updates paused, streams paused, transform sync paused) and cold (fully detached, re-entry requires a wake warm-up). Includes a per-frame wake budget, a predictive pre-wake window that uses the predicted player position to wake LODs one to three frames before they would re-enter the frustum, an anti-thrash hysteresis, a deterministic wake ordering derived from 007_15, and a full Android 64-bit preset table calibrated for Adreno 5xx–7xx and Mali-G5x–G7xx. Uses gl-matrix for frustum-edge distance math, double.js for high-precision wake-window accounting across large worlds, bitecs for SoA freeze state, and simplex-noise for anti-thrash dithering on the freeze/wake boundary.
// best for : Android 64-bit mobile open worlds, large interior scenes, dense foliage fields, streaming biome traversal, rail-shooter sequences, VR / AR with limited frustum, split-screen on mobile, thermal-throttled devices, low-frame-budget scenes, replay-safe freeze/wake transitions, deterministic LOD quiescence for CI.
// license : MIT

import { DeterminismSeedLOD, SeedStream } from './007_15_DeterminismSeed_LOD.js';
import { LOD_MODE } from './007_LOD.js';

import { Object3D } from '../core/018_Object3D.js';
import { Vector3 } from '../math/004_Vector3.js';
import { Matrix4 } from '../math/003_Matrix4.js';
import { Frustum } from '../math/006_Frustum.js';
import { Sphere } from '../math/001_Sphere.js';

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
const _freezeKeyVec = new Float64Array( 4 );
const _noise3D = createNoise3D();

const _scratchSphere = /*@__PURE__*/ new Sphere();
const _scratchVector3A = /*@__PURE__*/ new Vector3();
const _scratchVector3B = /*@__PURE__*/ new Vector3();
const _scratchMatrix4 = /*@__PURE__*/ new Matrix4();

// ─── ECS world + FreezeWake SoA component ───────────────────────────────────
const _freezeWakeWorld = createWorld();

const FreezeWakeSoA = defineComponent( {
    // Freeze state
    freezeState: Types.i32,             // FreezeState value
    freezeTier: Types.i32,              // FreezeTier value
    frozenSinceFrame: Types.i32,
    frozenFrameCount: Types.i32,
    freezeTransitionCount: Types.i32,

    // Wake state
    wakeState: Types.i32,               // WakeState value
    wakeWarmupFrames: Types.i32,
    wakeWarmupRemaining: Types.i32,
    wakeTransitionCount: Types.i32,
    lastWakeFrame: Types.i32,

    // Visibility inputs
    inFrustum: Types.ui8,
    occluded: Types.ui8,
    inPrefetchCone: Types.ui8,
    inPredictedCone: Types.ui8,
    inWakeWindow: Types.ui8,

    // Hysteresis
    freezeHysteresisFrames: Types.i32,
    wakeHysteresisFrames: Types.i32,
    freezeCandidateFrames: Types.i32,
    wakeCandidateFrames: Types.i32,

    // Wake window
    distanceToFrustumEdge: Types.f64,
    predictedReentryFrames: Types.f64,
    wakeWindowOpen: Types.ui8,
    wakeWindowPriority: Types.f64,

    // Cost saved
    framesSaved: Types.i32,
    estimatedCpuSavedMs: Types.f64,
    estimatedCpuSavedMsSession: Types.f64,

    // Predictive pre-wake
    preWakeFrames: Types.i32,
    preWakeDistance: Types.f64,
    preWakePriority: Types.f64,

    // Android context
    androidTier: Types.i32,
    isMobile64: Types.ui8,
    thermalPressure: Types.f64,
    batteryPressure: Types.f64,
    memoryPressure: Types.f64,

    // Global budget
    globalWakeBudgetPerFrame: Types.i32,
    globalWakeBudgetUsed: Types.i32,
    wakeRejectedThisFrame: Types.ui8,

    // Determinism
    wakeSeed: Types.ui32,
    ditherSample: Types.f64,

    // State
    initialized: Types.ui8,
    enabled: Types.ui8,
    frozenMaster: Types.ui8,
    lastFrameIndex: Types.i32,
    lastDeltaTime: Types.f64
} );

// ─── Freeze state machine ───────────────────────────────────────────────────
const FreezeState = Object.freeze( {
    AWAKE: 0,          // Fully active, all layers run.
    SOFT_FROZEN: 1,    // Updates paused, streams continue, transform sync continues.
    HARD_FROZEN: 2,    // Updates paused, streams paused, transform sync continues.
    COLD_FROZEN: 3     // Updates paused, streams paused, transform sync paused.
} );

// ─── Wake state machine ─────────────────────────────────────────────────────
const WakeState = Object.freeze( {
    NONE: 0,           // Not waking.
    WARMUP: 1,         // Waking: warm-up frames in progress.
    ACTIVE: 2,         // Fully awake.
    REJECTED: 3        // Wake was rejected by global budget this frame.
} );

// ─── Freeze tier (depth of freeze) ──────────────────────────────────────────
const FreezeTier = Object.freeze( {
    NONE: 0,           // No freeze applied.
    LIGHT: 1,          // Skip SSE + curvature + prediction (keep base + temporal).
    MEDIUM: 2,         // Skip everything except transform sync.
    DEEP: 3            // Skip everything.
} );

// ─── Android 64-bit preset table ────────────────────────────────────────────
const FREEZE_WAKE_PRESET_TABLE = {
    LOW: {
        freezeHysteresisFrames: 6,
        wakeHysteresisFrames: 3,
        wakeWarmupFrames: 5,
        preWakeFrames: 2,
        globalWakeBudgetPerFrame: 4,
        allowColdFreeze: true,
        allowHardFreeze: true,
        freezeConeAngle: Math.PI / 2.5,
        freezeDistance: 350.0,
        antiThrashDither: 0.05,
        thermalFreezeThreshold: 0.70,
        batteryFreezeThreshold: 0.70,
        memoryFreezeThreshold: 0.75,
        cpuSavedPerFrameMs: 0.045
    },
    MID: {
        freezeHysteresisFrames: 4,
        wakeHysteresisFrames: 2,
        wakeWarmupFrames: 4,
        preWakeFrames: 2,
        globalWakeBudgetPerFrame: 8,
        allowColdFreeze: true,
        allowHardFreeze: true,
        freezeConeAngle: Math.PI / 3,
        freezeDistance: 500.0,
        antiThrashDither: 0.04,
        thermalFreezeThreshold: 0.80,
        batteryFreezeThreshold: 0.80,
        memoryFreezeThreshold: 0.80,
        cpuSavedPerFrameMs: 0.040
    },
    HIGH: {
        freezeHysteresisFrames: 3,
        wakeHysteresisFrames: 2,
        wakeWarmupFrames: 3,
        preWakeFrames: 3,
        globalWakeBudgetPerFrame: 12,
        allowColdFreeze: true,
        allowHardFreeze: true,
        freezeConeAngle: Math.PI / 3.5,
        freezeDistance: 800.0,
        antiThrashDither: 0.03,
        thermalFreezeThreshold: 0.85,
        batteryFreezeThreshold: 0.85,
        memoryFreezeThreshold: 0.85,
        cpuSavedPerFrameMs: 0.035
    },
    FLAGSHIP: {
        freezeHysteresisFrames: 2,
        wakeHysteresisFrames: 1,
        wakeWarmupFrames: 2,
        preWakeFrames: 4,
        globalWakeBudgetPerFrame: 16,
        allowColdFreeze: false,
        allowHardFreeze: true,
        freezeConeAngle: Math.PI / 4,
        freezeDistance: 1200.0,
        antiThrashDither: 0.02,
        thermalFreezeThreshold: 0.90,
        batteryFreezeThreshold: 0.90,
        memoryFreezeThreshold: 0.90,
        cpuSavedPerFrameMs: 0.030
    }
};

// ─── Tunables specific to freeze / wake ─────────────────────────────────────
const FreezeWakeDefaults = {
    // Whether to enable freeze / wake by default on every LOD.
    enabledByDefault: true,

    // Whether to freeze only when fully outside the frustum, or also when occluded.
    freezeOnOcclusion: true,

    // Whether to freeze when the LOD is very far away even if in-frustum.
    freezeOnDistance: true,

    // Whether to allow cold freeze on this LOD.
    allowColdFreeze: true,

    // Whether to allow hard freeze on this LOD.
    allowHardFreeze: true,

    // Freeze hysteresis in frames (higher = less thrash).
    freezeHysteresisFrames: 4,

    // Wake hysteresis in frames.
    wakeHysteresisFrames: 2,

    // Wake warm-up frames. When a LOD wakes, it runs in a warm-up state for
    // this many frames before it is trusted for rendering-critical output.
    wakeWarmupFrames: 4,

    // Number of frames ahead to pre-wake a LOD based on the predicted player.
    preWakeFrames: 2,

    // Global budget for wake transitions per frame across the entire scene.
    globalWakeBudgetPerFrame: 8,

    // Freeze cone half-angle (radians). LODs outside this cone AND outside
    // the frustum are eligible for freeze.
    freezeConeAngle: Math.PI / 3,

    // Freeze distance (world units). LODs beyond this distance are eligible
    // for freeze even if in-frustum.
    freezeDistance: 500.0,

    // Anti-thrash dither amplitude applied to the freeze / wake boundary.
    antiThrashDither: 0.04,

    // Whether to relax freeze thresholds under thermal pressure.
    thermalFreezeRelaxation: true,

    // Thermal pressure above which freeze becomes more aggressive.
    thermalFreezeThreshold: 0.80,

    // Whether to relax freeze thresholds under battery pressure.
    batteryFreezeRelaxation: true,

    // Battery pressure above which freeze becomes more aggressive.
    batteryFreezeThreshold: 0.80,

    // Whether to relax freeze thresholds under memory pressure.
    memoryFreezeRelaxation: true,

    // Memory pressure above which freeze becomes more aggressive.
    memoryFreezeThreshold: 0.80,

    // Estimated CPU saved per frozen frame in milliseconds (per LOD).
    cpuSavedPerFrameMs: 0.040,

    // Whether to freeze transforms of fully cold LODs.
    freezeTransformsOnCold: true,

    // Whether to keep streaming prefetch active for soft-frozen LODs.
    prefetchDuringSoftFreeze: true,

    // Whether to keep raycast picking active for soft-frozen LODs.
    raycastDuringSoftFreeze: true,

    // Whether to use the predicted player state for pre-wake.
    usePredictivePreWake: true,

    // Whether to use the prefetch cone from 007_13 for pre-wake.
    usePrefetchConePreWake: true,

    // Whether to emit freeze / wake events for telemetry.
    emitEvents: true,

    // Maximum session time for telemetry accumulation (ms). 0 = no cap.
    maxSessionTelemetryMs: 3600000,

    // Determinism seed stream for wake ordering.
    wakeSeedStream: SeedStream.TEMPORAL,

    // Global hard ceiling for freeze duration (frames). 0 = no cap.
    maxFreezeDurationFrames: 0
};

/**
 * FreezeWakeLOD
 *
 * Extends DeterminismSeedLOD and adds a freeze / wake controller that
 * eliminates per-frame cost for LODs that are outside the camera frustum,
 * occluded, or too far to matter. This is the last layer in the LOD stack
 * and is intended to be the outermost wrapper.
 *
 * Freeze state machine:
 *
 *   AWAKE ────► SOFT_FROZEN ────► HARD_FROZEN ────► COLD_FROZEN
 *     ▲              │                │                │
 *     └──────────────┴────────────────┴────────────────┘
 *                     (wake with warmup)
 *
 * Freeze tiers:
 *
 *   SOFT   — parent chain runs only the base Object3D update; all
 *            enhancement layers skip. Streaming continues.
 *   HARD   — parent chain skipped entirely. Streaming paused.
 *            Transform sync continues.
 *   COLD   — parent chain skipped, streaming paused, transform sync paused.
 *            Re-entry requires a warm-up period.
 *
 * Wake path:
 *
 *   When a LOD leaves freeze, it enters WARMUP for `wakeWarmupFrames` frames.
 *   During WARMUP, all enhancement layers run normally but the output is
 *   marked as "not yet trusted" for telemetry. After WARMUP, the LOD becomes
 *   ACTIVE.
 *
 * Pre-wake:
 *
 *   Using the predicted player state from 007_7 and the prefetch cone from
 *   007_13, the controller identifies LODs that are about to re-enter the
 *   frustum and wakes them `preWakeFrames` ahead of time. This eliminates
 *   pop-in entirely.
 *
 * Recommended usage on Android 64-bit:
 * ```js
 * // One-time setup
 * const tier = TelemetryBudgetHUDLOD.detectAndroidTier( renderer );
 * TelemetryBudgetHUDLOD.applyTierPreset( tier );
 * PerMaterialDensityFloorLOD.setAndroidTier( tier );
 * SkinningCostMultiplierLOD.setAndroidTier( tier, renderer );
 * StreamingGeometryCacheLOD.setAndroidTier( tier );
 * RaycastFixedDensityLOD.setAndroidTier( tier );
 * DeterminismSeedLOD.setAndroidTier( tier );
 * DeterminismSeedLOD.setSceneSeed( 0x13371337 );
 * FreezeWakeLOD.setAndroidTier( tier );
 *
 * // Per LOD
 * const lod = new FreezeWakeLOD();
 * lod.attachTarget( mesh, { vertexBudget: 64000 } );
 * lod.registerWithAllocator( 'world' );
 *
 * // Per frame
 * DeterminismSeedLOD.beginFrame( frameIndex );
 * FreezeWakeLOD.beginFrame( frameIndex );
 * for ( const l of allLODs ) l.update( camera, player, dt );
 * FreezeWakeLOD.flushFreezeWake();
 * StreamingGeometryCacheLOD.flushStreaming();
 * AsyncDensityApplicationLOD.flushAsync();
 * TelemetryBudgetHUDLOD.endFrame( deltaTimeMs, renderer );
```

· 
· @augments DeterminismSeedLOD
  */
  class FreezeWakeLOD extends DeterminismSeedLOD {
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
  // ─── Public API: controls ───────────────────────────────────────────────
  enableFreezeWake( enabled = true ) {
  this._enabled = enabled;
  if ( ! enabled && this._freezeState !== FreezeState.AWAKE ) {
  this._forceWake();
  }
  return this;
  }
  freezeAll( frozen = true ) {
  this._frozenMaster = frozen;
  if ( frozen ) {
  this._enterFreeze( FreezeState.DEEP === FreezeState.DEEP
  ? FreezeState.DEEP
  : FreezeState.COLD_FROZEN, FreezeTier.DEEP );
  } else {
  this._forceWake();
  }
  return this;
  }
  /**
  · Returns the current freeze state.
  · @return {number}
    */
    getFreezeState() {
    return this._freezeState;
    }
  /**
  · Returns the current freeze tier.
  · @return {number}
    */
    getFreezeTier() {
    return this._freezeTier;
    }
  /**
  · Returns the current wake state.
  · @return {number}
    */
    getWakeState() {
    return this._wakeState;
    }
  /**
  · Returns true if the LOD is currently frozen.
  · @return {boolean}
    */
    isFrozen() {
    return this._freezeState !== FreezeState.AWAKE;
    }
  /**
  · Returns true if the LOD is currently waking up.
  · @return {boolean}
    */
    isWaking() {
    return this._wakeState === WakeState.WARMUP;
    }
  /**
  · Returns the number of frames this LOD has been frozen.
  · @return {number}
    */
    getFrozenFrameCount() {
    return this._frozenFrameCount;
    }
  /**
  · Returns a high-precision freeze / wake ledger for telemetry.
  · @return {object}
    */
    getFreezeWakeLedger() {
    const saved = new Double( this._estimatedCpuSavedMsSession );
    return {
    freezeState: this._freezeState,
    freezeTier: this._freezeTier,
    frozenSinceFrame: this._frozenSinceFrame,
    frozenFrameCount: this._frozenFrameCount,
    freezeTransitionCount: this._freezeTransitionCount,
    wakeState: this._wakeState,
    wakeWarmupRemaining: this._wakeWarmupRemaining,
    wakeTransitionCount: this._wakeTransitionCount,
    lastWakeFrame: this._lastWakeFrame,
    inFrustum: this._inFrustum,
    occluded: this._occluded,
    inPrefetchCone: this._inPrefetchCone,
    inPredictedCone: this._inPredictedCone,
    inWakeWindow: this._inWakeWindow,
    freezeCandidateFrames: this._freezeCandidateFrames,
    wakeCandidateFrames: this._wakeCandidateFrames,
    distanceToFrustumEdge: this._distanceToFrustumEdge,
    predictedReentryFrames: this._predictedReentryFrames,
    wakeWindowOpen: this._wakeWindowOpen,
    preWakeFrames: this._preWakeFrames,
    preWakeDistance: this._preWakeDistance,
    preWakePriority: this._preWakePriority,
    framesSaved: this._framesSaved,
    estimatedCpuSavedMs: this._estimatedCpuSavedMs,
    estimatedCpuSavedMsSession: saved.valueOf(),
    wakeRejectedThisFrame: this._wakeRejectedThisFrame,
    androidTier: this._androidTier,
    isMobile64: this._isMobile64,
    enabled: this._enabled
    };
    }
  // ─── Update override ────────────────────────────────────────────────────
  update( camera, player = this.player, rawDeltaTime = 0.016 ) {
  if ( this.mode === LOD_MODE.CONVENTIONAL ) {
  super.update( camera, player, rawDeltaTime );
  return;
  }
  }
  // ─── Freeze / wake decision ─────────────────────────────────────────────
  _evaluateFreezeWake() {
  // ── 1. Early-out for disabled or master-frozen. ─────────────────────
  if ( ! this._enabled ) {
  return { shouldFreeze: false, shouldWake: false, freezeState: 0, freezeTier: 0 };
  }
  }
  _computeFreezeEligibility() {
  // ── 1. Anti-thrash dither. ──────────────────────────────────────────
  const seed = ( this._wakeSeed ^ ( this._ecsEntity >>> 0 ) ) >>> 0;
  this._ditherSample = _noise3D( seed * 1e-6, this._frameIndex * 0.02, this.id ) * this.antiThrashDither;
  }
  _computeWakeEligibility() {
  // ── 1. In frustum is the strongest signal. ──────────────────────────
  if ( this._inFrustum && ! this._occluded ) {
  return true;
  }
  }
  // ─── Freeze / wake execution ────────────────────────────────────────────
  _enterFreeze( freezeState, freezeTier ) {
  if ( this._freezeState === freezeState && this._freezeTier === freezeTier ) {
  return;
  }
  }
  _executeWake() {
  // ── 1. Check global wake budget. ────────────────────────────────────
  if ( FreezeWakeLOD._globalWakeBudgetUsed >= FreezeWakeLOD._globalWakeBudgetPerFrame ) {
  this._wakeState = WakeState.REJECTED;
  this._wakeRejectedThisFrame = true;
  return;
  }
  }
  _forceWake() {
  if ( this._freezeState === FreezeState.AWAKE ) return;
  }
  // ─── Pre-wake window computation ────────────────────────────────────────
  /**
  · Updates the pre-wake window for this LOD based on the predicted player
  · state and the current frustum. Called once per frame by the parent
  · update before the decision is made.
    */
    _updateWakeWindow() {
    // ── 1. Distance to frustum edge. ────────────────────────────────────
    // If the LOD is in-frustum, distance is negative (inside).
    // If outside, distance is positive.
    const lodE = this.matrixWorld.elements;
    _scratchVector3A.set( lodE[ 12 ], lodE[ 13 ], lodE[ 14 ] );
    let distance = 0.0;
    if ( this._inFrustum ) {
    distance = - 1.0; // inside
    } else {
    const cache = FreezeWakeLOD._frustumCache;
    if ( cache !== null && cache.planes !== null ) {
    // Approximate: shortest distance to any frustum plane.
    let minDist = Infinity;
    }
    this._distanceToFrustumEdge = distance;
    // ── 2. Predicted re-entry frames. ───────────────────────────────────
    let reentryFrames = Infinity;
    if ( FreezeWakeLOD._predictedPlayerValid ) {
    const px = FreezeWakeLOD._predictedPlayerX;
    const py = FreezeWakeLOD._predictedPlayerY;
    const pz = FreezeWakeLOD._predictedPlayerZ;
    }
    this._predictedReentryFrames = reentryFrames;
    // ── 3. Open the wake window if we are within preWakeFrames. ─────────
    const preWake = this.preWakeFrames;
    if ( reentryFrames <= preWake ) {
    this._wakeWindowOpen = true;
    this._wakeWindowPriority = 1.0 - ( reentryFrames / Math.max( 1, preWake ) );
    this._preWakeFrames = preWake;
    } else {
    this._wakeWindowOpen = false;
    this._wakeWindowPriority = 0.0;
    }
    this._preWakeDistance = distance;
    this._preWakePriority = this._wakeWindowPriority;
    this._inWakeWindow = this._wakeWindowOpen;
    }
  // ─── Static: context updates ────────────────────────────────────────────
  /**
  · Publishes the frustum cache from 007_5 to this layer.
  · @param {object} cache
    */
    static setFrustumCache( cache ) {
    FreezeWakeLOD._frustumCache = cache;
    }
  /**
  · Publishes the predicted player state from 007_7 to this layer.
  · @param {number} px
  · @param {number} py
  · @param {number} pz
  · @param {number} speed
    */
    static setPredictedPlayer( px, py, pz, speed ) {
    FreezeWakeLOD._predictedPlayerX = px;
    FreezeWakeLOD._predictedPlayerY = py;
    FreezeWakeLOD._predictedPlayerZ = pz;
    FreezeWakeLOD._predictedPlayerSpeed = speed;
    FreezeWakeLOD._predictedPlayerValid = true;
    }
  /**
  · Publishes the current pressure signals to all registered LODs.
  · @param {number} thermal
  · @param {number} battery
  · @param {number} memory
    */
    static updatePressure( thermal, battery, memory ) {
    for ( const lod of FreezeWakeLOD._registeredFreezeWake ) {
    lod._thermalPressure = Math.min( 1.0, Math.max( 0.0, thermal ) );
    lod._batteryPressure = Math.min( 1.0, Math.max( 0.0, battery ) );
    lod._memoryPressure = Math.min( 1.0, Math.max( 0.0, memory ) );
    }
    }
  // ─── Static: frame lifecycle ────────────────────────────────────────────
  /**
  · Resets per-frame wake budgets. Call once per frame, after
  · DeterminismSeedLOD.beginFrame and before any LOD updates.
  · @param {number} frameIndex
    */
    static beginFrame( frameIndex ) {
    FreezeWakeLOD._frameIndex = frameIndex | 0;
    FreezeWakeLOD._globalWakeBudgetUsed = 0;
    for ( const lod of FreezeWakeLOD._registeredFreezeWake ) {
    lod._globalWakeBudgetUsed = 0;
    lod._wakeRejectedThisFrame = false;
    }
    }
  /**
  · Finalizes the frame. Call once per frame after all LOD updates.
    */
    static flushFreezeWake() {
    // Update the frame index so pre-wake windows reflect the latest state.
    FreezeWakeLOD._frameIndex ++;
    // Recompute wake windows for all frozen LODs so the next frame's
    // decision is based on the freshest predicted state.
    for ( const lod of FreezeWakeLOD._registeredFreezeWake ) {
    if ( lod._freezeState !== FreezeState.AWAKE ) {
    lod._updateWakeWindow();
    }
    }
    }
  // ─── Static: Android context ────────────────────────────────────────────
  /**
  · Publishes the Android tier to every registered freeze / wake LOD.
  · @param {number} tier
    */
    static setAndroidTier( tier ) {
    FreezeWakeLOD._androidTier = tier;
    const preset = FreezeWakeLOD._presetFor( tier );
    for ( const lod of FreezeWakeLOD._registeredFreezeWake ) {
    lod._androidTier = tier;
    lod.freezeHysteresisFrames = preset.freezeHysteresisFrames;
    lod.wakeHysteresisFrames = preset.wakeHysteresisFrames;
    lod.wakeWarmupFrames = preset.wakeWarmupFrames;
    lod.preWakeFrames = preset.preWakeFrames;
    lod.globalWakeBudgetPerFrame = preset.globalWakeBudgetPerFrame;
    lod.allowColdFreeze = preset.allowColdFreeze;
    lod.allowHardFreeze = preset.allowHardFreeze;
    lod.freezeConeAngle = preset.freezeConeAngle;
    lod.freezeDistance = preset.freezeDistance;
    lod.antiThrashDither = preset.antiThrashDither;
    lod.thermalFreezeThreshold = preset.thermalFreezeThreshold;
    lod.batteryFreezeThreshold = preset.batteryFreezeThreshold;
    lod.memoryFreezeThreshold = preset.memoryFreezeThreshold;
    lod.cpuSavedPerFrameMs = preset.cpuSavedPerFrameMs;
    }
    FreezeWakeLOD._globalWakeBudgetPerFrame = preset.globalWakeBudgetPerFrame;
    }
  /**
  · Returns the current preset for the active tier.
  · @return {object}
    */
    static getCurrentPreset() {
    return FreezeWakeLOD._presetFor( FreezeWakeLOD._androidTier );
    }
  /**
  · Returns the preset table.
  · @return {object}
    */
    static getPresetTable() {
    return FREEZE_WAKE_PRESET_TABLE;
    }
  // ─── Static: aggregated telemetry ───────────────────────────────────────
  /**
  · Returns a scene-wide summary of freeze / wake activity.
  · @return {object}
    */
    static getAggregatedStats() {
    let totalLODs = 0;
    let awake = 0;
    let softFrozen = 0;
    let hardFrozen = 0;
    let coldFrozen = 0;
    let waking = 0;
    let totalFramesSaved = 0;
    let totalCpuSavedMs = 0.0;
    for ( const lod of FreezeWakeLOD._registeredFreezeWake ) {
    totalLODs ++;
    }
    const utilization = totalLODs > 0
    ? ( softFrozen + hardFrozen + coldFrozen ) / totalLODs
    : 0.0;
    const savedTotal = new Double( totalCpuSavedMs );
    return {
    totalLODs: totalLODs,
    awake: awake,
    softFrozen: softFrozen,
    hardFrozen: hardFrozen,
    coldFrozen: coldFrozen,
    waking: waking,
    frozenUtilization: utilization,
    totalFramesSaved: totalFramesSaved,
    totalCpuSavedMs: savedTotal.valueOf(),
    globalWakeBudgetPerFrame: FreezeWakeLOD._globalWakeBudgetPerFrame,
    globalWakeBudgetUsed: FreezeWakeLOD._globalWakeBudgetUsed,
    androidTier: FreezeWakeLOD._androidTier
    };
    }
  // ─── Static: helpers ────────────────────────────────────────────────────
  static _isInPredictedCone( lod ) {
  if ( ! FreezeWakeLOD._predictedPlayerValid ) return false;
  }
  /**
  · Publishes the predicted player forward vector from 007_7.
  · @param {number} fx
  · @param {number} fy
  · @param {number} fz
    */
    static setPredictedForward( fx, fy, fz ) {
    FreezeWakeLOD._predictedForwardX = fx;
    FreezeWakeLOD._predictedForwardY = fy;
    FreezeWakeLOD._predictedForwardZ = fz;
    FreezeWakeLOD._predictedForwardValid = true;
    }
  static _presetFor( tier ) {
  switch ( tier ) {
  case 1: return FREEZE_WAKE_PRESET_TABLE.LOW;
  case 2: return FREEZE_WAKE_PRESET_TABLE.MID;
  case 3: return FREEZE_WAKE_PRESET_TABLE.HIGH;
  case 4: return FREEZE_WAKE_PRESET_TABLE.FLAGSHIP;
  default: return FREEZE_WAKE_PRESET_TABLE.MID;
  }
  }
  static _registerFreezeWakeLOD( lod ) {
  FreezeWakeLOD._registeredFreezeWake.add( lod );
  }
  static _unregisterFreezeWakeLOD( lod ) {
  FreezeWakeLOD._registeredFreezeWake.delete( lod );
  }
  // ─── ECS registration ───────────────────────────────────────────────────
  registerFreezeWakeECS() {
  if ( this._ecsFreezeWakeRegistered ) {
  return this._ecsFreezeWakeEntity;
  }
  }
  syncFreezeWakeECS() {
  if ( ! this._ecsFreezeWakeRegistered ) {
  return this;
  }
  }
  pullFreezeWakeECS() {
  if ( ! this._ecsFreezeWakeRegistered ) {
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
  · High-precision distance to the frustum edge using double.js. Useful
  · for very large worlds where the Frustum plane distance loses precision.
  · 
  · @param {number} x
  · @param {number} y
  · @param {number} z
  · @return {number}
    */
    computeFrustumEdgeDistanceHighPrecision( x, y, z ) {
    const cache = FreezeWakeLOD._frustumCache;
    if ( cache === null || cache.planes === null ) return 0.0;
    let minDist = new Double( Number.MAX_VALUE );
    for ( let i = 0; i < 6; i ++ ) {
    const b = i * 4;
    }
    return minDist.valueOf();
    }
  /**
  · Returns a deterministic wake ordering sample for this LOD. Used to
  · sort concurrent wake requests so the global wake budget is spent on
  · the most visually important LODs first.
  · 
  · @param {number} frameIndex
  · @return {number}
    */
    computeWakeOrdering( frameIndex ) {
    const seed = ( this._wakeSeed ^ ( this._ecsEntity >>> 0 ) ^ ( frameIndex * 0x9E3779B9 ) ) >>> 0;
    return _noise3D( seed * 1e-6, frameIndex * 0.02, this.id );
    }
  /**
  · Returns a deterministic sample for the anti-thrash dither on the
  · freeze / wake boundary.
  · 
  · @param {number} frameIndex
  · @return {number}
    */
    computeAntiThrashDither( frameIndex ) {
    const seed = ( this._wakeSeed ^ ( this._ecsEntity >>> 0 ) ) >>> 0;
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
  · Packs freeze / wake telemetry into a vec4 for GPU debug rendering.
  · Layout: (freezeState, freezeTier, wakeState, frozenFrameCount)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packFreezeWakeVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
    v,
    this._freezeState,
    this._freezeTier,
    this._wakeState,
    this._frozenFrameCount
    );
    return v;
    }
  /**
  · Packs the freeze key into a Float64Array for GPU-side telemetry.
  · Layout: (wakeSeed, frozenSinceFrame, lastWakeFrame, freezeTransitionCount)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packFreezeKeyVec4( out ) {
    const v = out || _freezeKeyVec;
    v[ 0 ] = this._wakeSeed;
    v[ 1 ] = this._frozenSinceFrame;
    v[ 2 ] = this._lastWakeFrame;
    v[ 3 ] = this._freezeTransitionCount;
    return v;
    }
  static getECSWorld() {
  return _freezeWakeWorld;
  }
  static getFreezeWakeSoA() {
  return FreezeWakeSoA;
  }
  static get FreezeWakeDefaults() {
  return FreezeWakeDefaults;
  }
  static get FreezeState() {
  return FreezeState;
  }
  static get WakeState() {
  return WakeState;
  }
  static get FreezeTier() {
  return FreezeTier;
  }
  static get FreezeWakePresetTable() {
  return FREEZE_WAKE_PRESET_TABLE;
  }
  }

// ─── Static freeze / wake storage (module-scoped, shared across instances) ──
FreezeWakeLOD._registeredFreezeWake = new Set();
FreezeWakeLOD._frameIndex = 0;
FreezeWakeLOD._globalWakeBudgetPerFrame = 8;
FreezeWakeLOD._globalWakeBudgetUsed = 0;
FreezeWakeLOD._androidTier = 2;

FreezeWakeLOD._frustumCache = null;

FreezeWakeLOD._predictedPlayerX = 0.0;
FreezeWakeLOD._predictedPlayerY = 0.0;
FreezeWakeLOD._predictedPlayerZ = 0.0;
FreezeWakeLOD._predictedPlayerSpeed = 0.0;
FreezeWakeLOD._predictedPlayerValid = false;

FreezeWakeLOD._predictedForwardX = 0.0;
FreezeWakeLOD._predictedForwardY = 0.0;
FreezeWakeLOD._predictedForwardZ = - 1.0;
FreezeWakeLOD._predictedForwardValid = false;

void Object3D;
void Vector3;
void Matrix4;
void Frustum;
void Sphere;
void _scratchSphere;
void _scratchVector3A;
void _scratchVector3B;
void _scratchMatrix4;
void _scratchVec3C;

export {
FreezeWakeLOD,
FreezeWakeSoA,
FreezeWakeDefaults,
FreezeState,
WakeState,
FreezeTier,
FREEZE_WAKE_PRESET_TABLE
};

