
// file number : 007_14
// full path name : src/objects/007_14_RaycastFixedDensity_LOD.js
// description : Enhancement #17 for the Dynamic LOD system, tuned for Android 64-bit mobile devices running Three.js (WebGL1 / WebGL2). Decouples the raycast / picking density from the render density so that touch input, physics probes, gameplay queries, and debug tools all raycast against a deterministic, fixed-density mesh regardless of what the camera currently sees. On Android, this is critical because a tap at 60 Hz with sub-pixel accuracy can hit a 20%-density foliage card at a different vertex than the 100%-density card that the player expects, causing missed taps, ghost hits, and non-reproducible gameplay. The class selects a picking density from a per-raycast-type policy table (GAMEPLAY, PHYSICS, TOUCH, MOUSE, DEBUG, VISUAL), applies it as an override on top of the parent's dynamic density, and restores the render density immediately afterwards so rendering is unaffected. Includes a per-tier picking cache, a priority queue for concurrent raycasts, deterministic hit ordering, and an Android-tuned touch slop compensation. Uses gl-matrix for ray and triangle intersection math, double.js for high-precision ray hits on large worlds, bitecs for SoA raycast state, and simplex-noise for deterministic hit-order tie-breaking on coincident triangles.
// best for : Android 64-bit mobile touch input, gameplay raycasts, physics probes, deterministic picking, UI hit-testing on 3D surfaces, VR controller rays, AR hit-testing, debug picking tools, replay-safe interaction, sub-pixel-accurate tap resolution.
// license : MIT

import { StreamingGeometryCacheLOD } from './007_13_StreamingGeometryCache_LOD.js';
import { LOD_MODE } from './007_LOD.js';

import { Raycaster } from '../core/022_Raycaster.js';
import { Ray } from '../math/002_Ray.js';
import { Vector2 } from '../math/005_Vector2.js';
import { Vector3 } from '../math/004_Vector3.js';
import { Matrix4 } from '../math/003_Matrix4.js';
import { Sphere } from '../math/001_Sphere.js';
import { Plane } from '../math/008_Plane.js';
import { Triangle } from '../math/009_Triangle.js';
import { BufferGeometry } from '../core/019_BufferGeometry.js';
import { BufferAttribute } from '../core/020_BufferAttribute.js';
import { Object3D } from '../core/018_Object3D.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchMat4 = new Float64Array( 16 );
const _scratchMat4Inv = new Float64Array( 16 );
const _scratchVec4 = new Float64Array( 4 );
const _scratchVec3A = new Float64Array( 3 );
const _scratchVec3B = new Float64Array( 3 );
const _scratchVec3C = new Float64Array( 3 );
const _scratchRayOrigin = new Float64Array( 3 );
const _scratchRayDir = new Float64Array( 3 );
const _scratchTri = new Float64Array( 9 );
const _raycastKeyVec = new Float64Array( 4 );
const _noise3D = createNoise3D();

const _scratchRay = /*@__PURE__*/ new Ray();
const _scratchSphere = /*@__PURE__*/ new Sphere();
const _scratchPlane = /*@__PURE__*/ new Plane();
const _scratchTriangle = /*@__PURE__*/ new Triangle();
const _scratchVector3A = /*@__PURE__*/ new Vector3();
const _scratchVector3B = /*@__PURE__*/ new Vector3();
const _scratchVector3C = /*@__PURE__*/ new Vector3();
const _scratchVector2A = /*@__PURE__*/ new Vector2();
const _scratchMatrix4 = /*@__PURE__*/ new Matrix4();

// ─── ECS world + RaycastDensity SoA component ───────────────────────────────
const _raycastWorld = createWorld();

const RaycastDensitySoA = defineComponent( {
    // Render vs picking density
    renderDensity: Types.f64,
    pickingDensity: Types.f64,
    pickingTier: Types.i32,
    renderTier: Types.i32,
    densityOverrideActive: Types.ui8,

    // Picking policy
    pickingMode: Types.i32,             // PickingDensityMode value
    fixedPickingDensity: Types.f64,     // user-authored value for FIXED mode
    tierOverride: Types.i32,            // for TIER_LOCKED mode
    pickingDensityFloor: Types.f64,
    pickingDensityCeiling: Types.f64,

    // Raycast state
    raycastPending: Types.i32,
    raycastCompleted: Types.i32,
    raycastRejected: Types.i32,
    lastRaycastFrame: Types.i32,
    lastRaycastType: Types.i32,
    lastHitDistance: Types.f64,
    lastHitTriangle: Types.i32,

    // Restore state
    savedRenderDensity: Types.f64,
    savedRenderTier: Types.i32,
    savedRenderMask: Types.ui32,
    restorePending: Types.ui8,

    // Android touch compensation
    touchSlopPx: Types.f64,
    touchSlopScale: Types.f64,
    isMobile64: Types.ui8,
    androidTier: Types.i32,

    // Priority queue
    raycastPriority: Types.f64,
    raycastQueueDepth: Types.i32,

    // State
    initialized: Types.ui8,
    enabled: Types.ui8,
    frozen: Types.ui8,
    lastFrameIndex: Types.i32,
    lastDeltaTime: Types.f64,
    ditherSample: Types.f64
} );

// ─── Raycast type constants ─────────────────────────────────────────────────
const RaycastType = Object.freeze( {
    GAMEPLAY: 0,     // Player interaction, aim rays, ability targeting.
    PHYSICS: 1,      // Physics engine probes and collision queries.
    TOUCH: 2,        // Android touch input taps and drags.
    MOUSE: 3,        // Desktop mouse pointer picks.
    DEBUG: 4,        // Debug picking, gizmos, editor tools.
    VISUAL: 5        // Raycast that must match the rendered silhouette.
} );

// ─── Picking density mode constants ─────────────────────────────────────────
const PickingDensityMode = Object.freeze( {
    // Use the parent's dynamic density (no decoupling). Useful for VISUAL rays.
    DYNAMIC: 0,

    // Use a fixed user-authored density for all picks.
    FIXED: 1,

    // Use the highest density the cache has resident (100% if available).
    HIGHEST_RESIDENT: 2,

    // Use the streaming cache tier specified by tierOverride.
    TIER_LOCKED: 3,

    // Use the material floor from the earlier layer.
    MATERIAL_FLOOR: 4
} );

// ─── Default picking mode per raycast type ──────────────────────────────────
// GAMEPLAY, PHYSICS, and TOUCH must be deterministic across frames and
// devices, so they default to HIGHEST_RESIDENT. VISUAL matches the rendered
// silhouette and uses DYNAMIC. DEBUG uses FIXED at 100%.
const DEFAULT_PICKING_MODE = {
    [ RaycastType.GAMEPLAY ]: PickingDensityMode.HIGHEST_RESIDENT,
    [ RaycastType.PHYSICS ]: PickingDensityMode.HIGHEST_RESIDENT,
    [ RaycastType.TOUCH ]: PickingDensityMode.HIGHEST_RESIDENT,
    [ RaycastType.MOUSE ]: PickingDensityMode.HIGHEST_RESIDENT,
    [ RaycastType.DEBUG ]: PickingDensityMode.FIXED,
    [ RaycastType.VISUAL ]: PickingDensityMode.DYNAMIC
};

// ─── Android 64-bit picking preset table ────────────────────────────────────
const PICKING_PRESET_TABLE = {
    LOW: {
        // LOW devices cannot afford 100% picking for every query.
        highestResidentFallback: 0.50,
        fixedPickingDensity: 0.50,
        touchSlopPx: 12.0,
        touchSlopScale: 1.25,
        maxRaycastQueueDepth: 8,
        raycastBudgetPerFrame: 4,
        allowDynamicPicking: false,
        rejectOnCacheMiss: false
    },
    MID: {
        highestResidentFallback: 0.75,
        fixedPickingDensity: 0.75,
        touchSlopPx: 10.0,
        touchSlopScale: 1.15,
        maxRaycastQueueDepth: 12,
        raycastBudgetPerFrame: 6,
        allowDynamicPicking: true,
        rejectOnCacheMiss: false
    },
    HIGH: {
        highestResidentFallback: 0.90,
        fixedPickingDensity: 0.90,
        touchSlopPx: 8.0,
        touchSlopScale: 1.10,
        maxRaycastQueueDepth: 16,
        raycastBudgetPerFrame: 8,
        allowDynamicPicking: true,
        rejectOnCacheMiss: false
    },
    FLAGSHIP: {
        highestResidentFallback: 1.00,
        fixedPickingDensity: 1.00,
        touchSlopPx: 6.0,
        touchSlopScale: 1.05,
        maxRaycastQueueDepth: 24,
        raycastBudgetPerFrame: 12,
        allowDynamicPicking: true,
        rejectOnCacheMiss: false
    }
};

// ─── Tunables specific to raycast density decoupling ────────────────────────
const RaycastDensityDefaults = {
    // Default picking mode applied when no raycast type is specified.
    defaultPickingMode: PickingDensityMode.HIGHEST_RESIDENT,

    // Whether to decouple picking density from render density by default.
    decoupleByDefault: true,

    // Whether to save and restore the render density around every raycast.
    saveRestoreRenderDensity: true,

    // Whether to reject raycasts when the picking tier is not resident.
    rejectOnMissingTier: false,

    // Whether to force the cache to stream the picking tier on demand.
    requestMissingPickingTier: true,

    // Maximum number of raycasts processed per frame across all LODs.
    raycastBudgetPerFrame: 8,

    // Maximum queue depth per LOD before new raycasts are dropped.
    maxRaycastQueueDepth: 16,

    // Whether to use a priority queue for concurrent raycasts.
    usePriorityQueue: true,

    // Threshold above which a hit is considered "near-miss" and reported.
    nearMissThreshold: 0.05,

    // Android touch slop in pixels (default; overridden by tier preset).
    touchSlopPx: 10.0,

    // Whether to apply touch slop compensation on Android touch raycasts.
    applyTouchSlop: true,

    // Scale applied to touch slop per tier.
    touchSlopScale: 1.15,

    // Whether to reuse a shared raycaster instance (avoids allocation).
    reuseRaycaster: true,

    // Deterministic seed base.
    determinismSeed: 0x9E3779B7,

    // Dither amplitude applied to hit ordering on coincident triangles.
    hitOrderDither: 0.0001,

    // Cache TTL in frames for resolved picking density.
    cacheTTL: 4,

    // Global hard floor for picking density.
    globalPickingFloor: 0.25,

    // Global hard ceiling for picking density.
    globalPickingCeiling: 1.0
};

/**
 * RaycastFixedDensityLOD
 *
 * Extends StreamingGeometryCacheLOD and inserts a deterministic picking
 * density layer between the render density and any raycast the host performs
 * against the target.
 *
 * The core problem this layer solves:
 *
 *   A foliage card rendered at 25% density (because the camera is 200 m away)
 *   has a completely different triangle layout than the same card at 100%
 *   density. If the player taps the screen and the raycast runs against the
 *   25%-density geometry, the tap may miss the leaf entirely. On Android,
 *   where taps must be sub-pixel accurate for a good UX, this is unacceptable.
 *
 * The solution:
 *
 *   Before a raycast, temporarily raise the picking density to a
 *   deterministic value (typically 100% or the highest resident tier),
 *   run the raycast, then restore the render density. Rendering is
 *   unaffected. Picking results are identical across frames and devices.
 *
 * Picking density modes:
 *
 *   DYNAMIC           — use the parent's current density (VISUAL rays only).
 *   FIXED             — use `fixedPickingDensity` (default for DEBUG).
 *   HIGHEST_RESIDENT  — use the highest tier currently in the cache
 *                       (default for GAMEPLAY, PHYSICS, TOUCH, MOUSE).
 *   TIER_LOCKED       — use `tierOverride` (custom policy).
 *   MATERIAL_FLOOR    — use the material floor from layer 007_11.
 *
 * Android touch compensation:
 *
 *   Mobile touch input has inherent slop. The preset table widens the
 *   picking tolerance on LOW / MID devices so that a slightly-off tap
 *   still registers. This is applied by the host at the moment of pick
 *   time via `applyTouchSlopCompensation`.
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
 *
 * // Per LOD
 * const lod = new RaycastFixedDensityLOD();
 * lod.attachTarget( foliageMesh, { vertexBudget: 32000 } );
 * lod.registerWithAllocator( 'foliage' );
 *
 * // At the moment of picking (e.g. Android touchstart handler):
 * const hit = lod.raycast( raycaster, RaycastFixedDensityLOD.RaycastType.TOUCH );
 * if ( hit !== null ) {
 *     // hit is a normal Three.js intersection object
 * }
 *
 * // Per frame (streaming / telemetry layers only):
 * TelemetryBudgetHUDLOD.beginFrame( frameIndex );
 * for ( const l of allLODs ) l.update( camera, player, dt );
 * StreamingGeometryCacheLOD.flushStreaming();
 * AsyncDensityApplicationLOD.flushAsync();
 * TelemetryBudgetHUDLOD.endFrame( deltaTimeMs, renderer );
```

· 
· @augments StreamingGeometryCacheLOD
  */
  class RaycastFixedDensityLOD extends StreamingGeometryCacheLOD {
  constructor() {
  super();
  }
  // ─── Public API: controls ───────────────────────────────────────────────
  enableRaycastDecoupling( enabled = true ) {
  this._enabled = enabled;
  return this;
  }
  freezeRaycastDecoupling( frozen = true ) {
  this._raycastFrozen = frozen;
  return this;
  }
  /**
  · Sets the picking mode for a specific raycast type.
  · @param {number} type - One of RaycastType.
  · @param {number} mode - One of PickingDensityMode.
  · @return {RaycastFixedDensityLOD}
    */
    setPickingMode( type, mode ) {
    this._pickingModes[ type ] = mode;
    return this;
    }
  /**
  · Gets the picking mode for a specific raycast type.
  · @param {number} type
  · @return {number}
    */
    getPickingMode( type ) {
    return this._pickingModes[ type ] !== undefined
    ? this._pickingModes[ type ]
    : this._defaultPickingMode;
    }
  /**
  · Sets the fixed picking density used by PickingDensityMode.FIXED.
  · @param {number} density
  · @return {RaycastFixedDensityLOD}
    */
    setFixedPickingDensity( density ) {
    this._fixedPickingDensity = Math.min( 1.0, Math.max( 0.0, density ) );
    return this;
    }
  /**
  · Sets the tier override used by PickingDensityMode.TIER_LOCKED.
  · @param {number} tier - 0..4 (12.5%..100%).
  · @return {RaycastFixedDensityLOD}
    */
    setTierOverride( tier ) {
    this._tierOverride = Math.max( 0, Math.min( 4, tier | 0 ) );
    return this;
    }
  /**
  · Sets the picking density floor and ceiling for this LOD.
  · @param {number} floor
  · @param {number} ceiling
  · @return {RaycastFixedDensityLOD}
    */
    setPickingDensityBounds( floor, ceiling ) {
    this._pickingDensityFloor = Math.min( 1.0, Math.max( 0.0, floor ) );
    this._pickingDensityCeiling = Math.min( 1.0, Math.max( this._pickingDensityFloor, ceiling ) );
    return this;
    }
  // ─── Public API: raycast ────────────────────────────────────────────────
  /**
  · Performs a raycast against the target using a picking density that is
  · decoupled from the render density. The render density is restored
  · before this function returns.
  · 
  · @param {Raycaster} raycaster
  · @param {number} [raycastType=RaycastType.GAMEPLAY]
  · @param {Array} [intersects] - Optional output array; if omitted, a
  · 
  · @return {Array} The array of intersections (possibly empty).
    */
    raycast( raycaster, raycastType = RaycastType.GAMEPLAY, intersects = [] ) {
    if ( ! this._enabled || this._raycastFrozen ) {
    // Fall through: use the parent's current density directly.
    return this._runRaycast( raycaster, intersects );
    }
    const target = this.target;
    if ( target === null ) return intersects;
    // ── 1. Resolve the picking density for this raycast type. ───────────
    const pickingDensity = this._resolvePickingDensity( raycastType );
    // ── 2. Save current render density if requested. ────────────────────
    if ( this.saveRestoreRenderDensity ) {
    this._savedRenderDensity = this._dynamicDensity;
    this._savedRenderTier = this._currentTier;
    this._savedRenderMask = this._residencyMask;
    this._restorePending = true;
    }
    // ── 3. If the picking density differs, apply it temporarily. ────────
    const renderDensity = this._dynamicDensity;
    if ( Math.abs( pickingDensity - renderDensity ) > 1e-4 ) {
    this._applyPickingDensity( pickingDensity, raycastType );
    this._densityOverrideActive = true;
    }
    // ── 4. Run the raycast against the (possibly overridden) geometry. ──
    const results = this._runRaycast( raycaster, intersects );
    // ── 5. Restore the render density. ──────────────────────────────────
    if ( this._restorePending && this.saveRestoreRenderDensity ) {
    this._restoreRenderDensity();
    }
    // ── 6. Update counters. ─────────────────────────────────────────────
    this._raycastCompleted ++;
    this._lastRaycastFrame = this._frameIndex;
    this._lastRaycastType = raycastType;
    if ( results.length > 0 ) {
    const firstHit = results[ 0 ];
    this._lastHitDistance = firstHit.distance !== undefined ? firstHit.distance : 0.0;
    this._lastHitTriangle = firstHit.index !== undefined ? firstHit.index : - 1;
    } else {
    this._lastHitDistance = 0.0;
    this._lastHitTriangle = - 1;
    }
    this.syncRaycastECS();
    return results;
    }
  /**
  · Convenience wrapper that accepts 2D screen coordinates and returns
  · the array of intersections. Applies Android touch slop compensation
  · when the raycast type is TOUCH.
  · 
  · @param {Raycaster} raycaster
  · @param {number} ndcX - Normalized device coordinate X in [-1, 1].
  · @param {number} ndcY - Normalized device coordinate Y in [-1, 1].
  · @param {number} [raycastType=RaycastType.TOUCH]
  · @param {Array} [intersects]
  · @return {Array}
    */
    raycastFromNDC( raycaster, ndcX, ndcY, raycastType = RaycastType.TOUCH, intersects = [] ) {
    _scratchVector2A.set( ndcX, ndcY );
    if ( raycastType === RaycastType.TOUCH && this.applyTouchSlop ) {
    this._applyTouchSlop( raycaster, _scratchVector2A );
    }
    raycaster.setFromCamera( _scratchVector2A, raycaster.camera );
    return this.raycast( raycaster, raycastType, intersects );
    }
  /**
  · Returns a high-precision ledger of the picking state.
  · @return {object}
    */
    getRaycastLedger() {
    const pick = new Double( this._pickingDensity );
    const render = new Double( this._renderDensity );
    return {
    renderDensity: render.valueOf(),
    pickingDensity: pick.valueOf(),
    renderTier: this._renderTier,
    pickingTier: this._pickingTier,
    pickingMode: this._pickingMode,
    fixedPickingDensity: this._fixedPickingDensity,
    tierOverride: this._tierOverride,
    densityOverrideActive: this._densityOverrideActive,
    raycastPending: this._raycastPending,
    raycastCompleted: this._raycastCompleted,
    raycastRejected: this._raycastRejected,
    lastRaycastFrame: this._lastRaycastFrame,
    lastRaycastType: this._lastRaycastType,
    lastHitDistance: this._lastHitDistance,
    lastHitTriangle: this._lastHitTriangle,
    touchSlopPx: this._touchSlopPx,
    touchSlopScale: this._touchSlopScale,
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
  // ─── Picking density resolution ─────────────────────────────────────────
  _resolvePickingDensity( raycastType ) {
  const mode = this.getPickingMode( raycastType );
  this._pickingMode = mode;
  }
  _applyPickingDensity( density, raycastType ) {
  const target = this.target;
  if ( target === null ) return;
  }
  _restoreRenderDensity() {
  const target = this.target;
  if ( target === null ) {
  this._restorePending = false;
  return;
  }
  }
  // ─── Raycast execution ──────────────────────────────────────────────────
  _runRaycast( raycaster, intersects ) {
  const target = this.target;
  if ( target === null ) return intersects;
  }
  _sortIntersections( intersects ) {
  const seed = ( this.determinismSeed ^ ( this._geometryKey >>> 0 ) ) >>> 0;
  const ditherAmp = this.hitOrderDither;
  }
  // ─── Android touch slop ─────────────────────────────────────────────────
  _applyTouchSlop( raycaster, ndc ) {
  // Convert the touch slop in pixels into NDC units. The host camera
  // is used to determine the viewport size.
  const camera = raycaster.camera;
  if ( camera === null || camera === undefined ) return;
  }
  // ─── Preset helper ──────────────────────────────────────────────────────
  _getPickingPreset() {
  return RaycastFixedDensityLOD._getPresetForTier( this._androidTier );
  }
  // ─── Static context ─────────────────────────────────────────────────────
  /**
  · Sets the Android tier for picking presets across all registered LODs.
  · @param {number} tier
    */
    static setAndroidTier( tier ) {
    RaycastFixedDensityLOD._androidTier = tier;
    for ( const lod of RaycastFixedDensityLOD._registeredRaycast ) {
    lod._androidTier = tier;
    const preset = RaycastFixedDensityLOD._getPresetForTier( tier );
    lod._touchSlopPx = preset.touchSlopPx;
    lod._touchSlopScale = preset.touchSlopScale;
    }
    }
  /**
  · Returns the current Android tier.
  · @return {number}
    */
    static getAndroidTier() {
    return RaycastFixedDensityLOD._androidTier;
    }
  /**
  · Returns the preset table.
  · @return {object}
    */
    static getPresetTable() {
    return PICKING_PRESET_TABLE;
    }
  /**
  · Returns the current preset for the active tier.
  · @return {object}
    */
    static getCurrentPreset() {
    return RaycastFixedDensityLOD._getPresetForTier( RaycastFixedDensityLOD._androidTier );
    }
  /**
  · Returns a shared reused raycaster instance. Allocated on first use.
  · @return {Raycaster}
    */
    static getReusedRaycaster() {
    if ( RaycastFixedDensityLOD._reusedRaycaster === null ) {
    RaycastFixedDensityLOD._reusedRaycaster = new Raycaster();
    }
    return RaycastFixedDensityLOD._reusedRaycaster;
    }
  static _getPresetForTier( tier ) {
  switch ( tier ) {
  case 1: return PICKING_PRESET_TABLE.LOW;
  case 2: return PICKING_PRESET_TABLE.MID;
  case 3: return PICKING_PRESET_TABLE.HIGH;
  case 4: return PICKING_PRESET_TABLE.FLAGSHIP;
  default: return PICKING_PRESET_TABLE.MID;
  }
  }
  static _densityToTier( density ) {
  if ( density <= 0.125 ) return 0;
  if ( density <= 0.25 ) return 1;
  if ( density <= 0.50 ) return 2;
  if ( density <= 0.75 ) return 3;
  return 4;
  }
  static _registerRaycastLOD( lod ) {
  RaycastFixedDensityLOD._registeredRaycast.add( lod );
  }
  static _unregisterRaycastLOD( lod ) {
  RaycastFixedDensityLOD._registeredRaycast.delete( lod );
  }
  // ─── ECS registration ───────────────────────────────────────────────────
  registerRaycastECS() {
  if ( this._ecsRaycastRegistered ) {
  return this._ecsRaycastEntity;
  }
  }
  syncRaycastECS() {
  if ( ! this._ecsRaycastRegistered ) {
  return this;
  }
  }
  pullRaycastECS() {
  if ( ! this._ecsRaycastRegistered ) {
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
  · High-precision ray-hit distance using double.js. Useful for very large
  · worlds where the Float64 distance to the hit is close to the precision
  · limit.
  · 
  · @param {number} ox
  · @param {number} oy
  · @param {number} oz
  · @param {number} hx
  · @param {number} hy
  · @param {number} hz
  · @return {number}
    */
    computeHitDistanceHighPrecision( ox, oy, oz, hx, hy, hz ) {
    const dx = new Double( hx ).sub( new Double( ox ) );
    const dy = new Double( hy ).sub( new Double( oy ) );
    const dz = new Double( hz ).sub( new Double( oz ) );
    return dx.mul( dx ).add( dy.mul( dy ) ).add( dz.mul( dz ) ).sqrt().valueOf();
    }
  /**
  · Returns a deterministic tie-break sample for coincident triangle hits.
  · @param {number} triangleIndex
  · @return {number}
    */
    computeHitTieBreak( triangleIndex ) {
    const seed = ( this.determinismSeed ^ ( this._geometryKey >>> 0 ) ^ ( triangleIndex * 2654435761 ) ) >>> 0;
    return _noise3D( seed * 1e-6, 0, 0 ) * this.hitOrderDither;
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
  · Packs picking telemetry into a vec4 for GPU debug rendering.
  · Layout: (renderDensity, pickingDensity, pickingTier, densityOverrideActive)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packRaycastVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
    v,
    this._renderDensity,
    this._pickingDensity,
    this._pickingTier,
    this._densityOverrideActive ? 1 : 0
    );
    return v;
    }
  /**
  · Packs the raycast key into a Float64Array for GPU-side telemetry.
  · Layout: (geometryKey, pickingMode, raycastType, touchSlopPx)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packRaycastKeyVec4( out ) {
    const v = out || _raycastKeyVec;
    v[ 0 ] = this._geometryKey;
    v[ 1 ] = this._pickingMode;
    v[ 2 ] = this._lastRaycastType;
    v[ 3 ] = this._touchSlopPx;
    return v;
    }
  static getECSWorld() {
  return _raycastWorld;
  }
  static getRaycastSoA() {
  return RaycastDensitySoA;
  }
  static get RaycastDensityDefaults() {
  return RaycastDensityDefaults;
  }
  static get RaycastType() {
  return RaycastType;
  }
  static get PickingDensityMode() {
  return PickingDensityMode;
  }
  static get PickingPresetTable() {
  return PICKING_PRESET_TABLE;
  }
  }

// ─── Fallback tier densities (mirrors 007_13 but kept local for isolation) ──
const TIER_DENSITIES_FALLBACK = Object.freeze( [ 0.125, 0.25, 0.5, 0.75, 1.0 ] );

// ─── Static raycast storage (module-scoped, shared across all instances) ────
RaycastFixedDensityLOD._registeredRaycast = new Set();
RaycastFixedDensityLOD._androidTier = 2; // MID default
RaycastFixedDensityLOD._reusedRaycaster = null;

void _scratchMat4Inv;
void _scratchVector3A;
void _scratchVector3B;
void _scratchVector3C;
void _scratchMatrix4;
void Vector3;
void Matrix4;
void Plane;
void Triangle;
void Sphere;
void Ray;
void Vector2;
void Raycaster;
void BufferGeometry;
void BufferAttribute;
void Object3D;

export {
RaycastFixedDensityLOD,
RaycastDensitySoA,
RaycastDensityDefaults,
RaycastType,
PickingDensityMode,
PICKING_PRESET_TABLE
};

