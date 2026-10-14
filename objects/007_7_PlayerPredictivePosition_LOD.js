
// file number : 007_7
// full path name : src/objects/007_7_PlayerPredictivePosition_LOD.js
// description : Enhancement #8 for the Dynamic LOD system. Adds player and camera predictive positioning so density is biased toward what the player is about to see, eliminating "pop-in" when turning corners, sprinting into new regions, or snapping the camera. Tracks linear and angular velocity of the player (and optionally the camera), dead-reckons forward by a configurable horizon (default ~0.25 s / 15 frames), builds a future-facing view cone, and multiplies the density target by a predictive weight so that objects entering the cone hold higher density before they become visible, while objects leaving the cone shed density pre-emptively. Includes multi-frame horizon blending, look-ahead anti-pop-in bias, corridor prediction for racing / flight, and a deterministic replay-safe predictor. Uses gl-matrix for cone and quaternion prediction, double.js for high-precision multi-frame extrapolation over large worlds, bitecs for SoA prediction state, and simplex-noise for anti-jitter dither on the prediction cone boundary.
// best for : Third-person and first-person player cameras, racing and flight corridors, VR head-turn prediction, snap-turn and teleport recovery, sprint / dash mechanics, cutscene look-at transitions, open-world traversal, streamed biome transitions, anti-pop-in for foliage and characters.
// license : MIT

import { MotionVelocityWeightingLOD } from './007_6_MotionVelocityWeighting_LOD.js';
import { LOD_MODE } from './007_LOD.js';
import { Object3D } from '../core/018_Object3D.js';
import { Vector3 } from '../math/004_Vector3.js';
import { Quaternion } from '../math/007_Quaternion.js';
import { Matrix4 } from '../math/003_Matrix4.js';

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
const _scratchVec3D = new Float64Array( 3 );
const _scratchQuatA = new Float64Array( 4 );
const _scratchQuatB = new Float64Array( 4 );
const _predictedPlayerPos = /*@__PURE__*/ new Vector3();
const _predictedPlayerForward = /*@__PURE__*/ new Vector3();
const _predictedPlayerUp = /*@__PURE__*/ new Vector3();
const _lodWorldPos = /*@__PURE__*/ new Vector3();
const _lodToPlayer = /*@__PURE__*/ new Vector3();
const _noise3D = createNoise3D();

// ─── ECS world + PlayerPrediction SoA component ─────────────────────────────
const _predictionWorld = createWorld();

const PlayerPredictionSoA = defineComponent( {
    // Predicted player state (world space)
    predictedPlayerX: Types.f64,
    predictedPlayerY: Types.f64,
    predictedPlayerZ: Types.f64,

    predictedForwardX: Types.f64,
    predictedForwardY: Types.f64,
    predictedForwardZ: Types.f64,

    predictedUpX: Types.f64,
    predictedUpY: Types.f64,
    predictedUpZ: Types.f64,

    // Player velocity (linear + angular)
    playerVelocityX: Types.f64,
    playerVelocityY: Types.f64,
    playerVelocityZ: Types.f64,
    playerVelocityMagnitude: Types.f64,

    playerAngularVelocityX: Types.f64,
    playerAngularVelocityY: Types.f64,
    playerAngularVelocityZ: Types.f64,
    playerAngularVelocityMagnitude: Types.f64,

    // Prediction state
    predictionHorizon: Types.f64,       // seconds ahead
    predictionFrames: Types.i32,        // frame count ahead
    predictedPlayerDistance: Types.f64, // distance from current to predicted

    // Predictive visibility results
    futureVisibility: Types.f64,        // 0..1, in predicted cone
    futureAngle: Types.f64,             // radians between LOD and predicted forward
    futureDistance: Types.f64,          // distance from predicted player to LOD
    predictiveWeight: Types.f64,        // final multiplier applied to density

    // Look-ahead parameters
    coneAngle: Types.f64,               // half-angle of predicted view cone (radians)
    coneSoftness: Types.f64,            // angular softness at the cone edge
    antiPopBias: Types.f64,             // extra density for objects about to enter
    predictiveWeightAmount: Types.f64,  // weight of prediction on density
    corridorWidth: Types.f64,           // for racing / flight corridor prediction

    // State
    initialized: Types.ui8,
    enabled: Types.ui8,
    frozen: Types.ui8,
    lastFrameIndex: Types.i32,
    lastDeltaTime: Types.f64,
    teleportDetected: Types.ui8
} );

// ─── Tunables specific to player predictive position ────────────────────────
const PlayerPredictionDefaults = {
    // Prediction horizon in seconds. 0.25 s ≈ 15 frames at 60 FPS.
    predictionHorizon: 0.25,

    // Maximum horizon clamp for very low frame rates.
    maxHorizon: 0.5,

    // Half-angle of the predicted view cone (radians).
    // 45° = π/4 → wide, ~25° → tight.
    coneAngle: Math.PI / 4,

    // Angular softness at the cone edge (radians).
    // Objects within (coneAngle - softness) get full weight;
    // objects within (coneAngle + softness) fade smoothly to 0.
    coneSoftness: Math.PI / 12,

    // Weight of the predictive visibility on the density target, in [0, 1].
    // 0 = ignore prediction, 1 = prediction fully drives density boost.
    predictiveWeightAmount: 0.4,

    // Extra density multiplier for objects just outside the current cone
    // but inside the predicted cone (anti-pop-in).
    antiPopBias: 1.25,

    // Whether to use the player's up vector for cone orientation.
    // When false, uses world up (0, 1, 0).
    usePlayerUp: true,

    // Minimum player speed (units/s) required to trigger prediction.
    // Below this, prediction is disabled and density falls back to current.
    minSpeedForPrediction: 0.5,

    // Minimum angular speed (radians/s) required to trigger prediction.
    // Handles stationary look-around.
    minAngularSpeedForPrediction: 0.05,

    // Corridor width (world units) for racing / flight prediction.
    // Objects within this lateral distance of the player's path get a boost.
    corridorWidth: 40.0,

    // Whether to enable corridor prediction for high-speed linear motion.
    enableCorridor: true,

    // Dithering amplitude on the cone boundary to avoid banding.
    coneDither: 0.03,

    // Deterministic seed base.
    determinismSeed: 0x27D4EB2F,

    // Smoothing factor for the prediction EMA (higher = more responsive).
    predictionSmoothing: 0.4,

    // Whether to blend multiple horizons (0.5H, 1.0H, 1.5H) for stability.
    multiHorizonBlending: true,

    // Teleport threshold (units) for the player position.
    teleportThreshold: 200.0
};

/**
 * PlayerPredictivePositionLOD
 *
 * Extends MotionVelocityWeightingLOD and adds player-future-aware density
 * regulation. The pipeline per frame is:
 *
 *   1. Host calls `PlayerPredictivePositionLOD.updatePlayer( player, dt )`
 *      once per frame, before any LOD updates. This dead-reckons the
 *      player's position and orientation forward by `predictionHorizon`
 *      seconds and publishes the result to all registered prediction LODs.
 *
 *   2. During each LOD's `update()`, the parent chain runs SSE, curvature,
 *      visibility, motion, budget, and allocator. Then this class computes
 *      a predictive weight from the LOD's angle to the predicted forward
 *      vector and its distance from the predicted player position.
 *
 *   3. The predictive weight is multiplied into the density target. Objects
 *      inside the predicted cone get a boost (up to `antiPopBias`), objects
 *      outside get a reduction, and objects in the soft edge fade smoothly.
 *
 * The predictive weight is intentionally one-sided: it can only RAISE
 * density, never lower it below the parent target. This guarantees the
 * prediction never causes quality loss for objects that are currently
 * visible — it only prevents future quality loss.
 *
 * Recommended usage:
 * ```js
 * const lod = new PlayerPredictivePositionLOD();
 * lod.attachTarget( foliage, { vertexBudget: 32000 } );
 * lod.registerWithAllocator( 'world' );
 *
 * // Per frame, BEFORE any LOD updates:
 * PlayerPredictivePositionLOD.updatePlayer( playerObject, dt );
 *
 * // Then update all LODs as usual.
 * for ( const l of allLODs ) l.update( camera, player, dt );
```

· 
· @augments MotionVelocityWeightingLOD
  */
  class PlayerPredictivePositionLOD extends MotionVelocityWeightingLOD {
  constructor() {
  super();
  }
  // ─── Public API ───────────────────────────────────────────────────────────
  /**
  · Enables or disables predictive density regulation on this LOD.
  · @param {boolean} [enabled=true]
  · @return {PlayerPredictivePositionLOD}
    */
    enablePrediction( enabled = true ) {
    this._enabled = enabled;
    return this;
    }
  /**
  · Freezes prediction without disabling the rest of the pipeline.
  · @param {boolean} [frozen=true]
  · @return {PlayerPredictivePositionLOD}
    */
    freezePrediction( frozen = true ) {
    this._predictionFrozen = frozen;
    return this;
    }
  /**
  · Returns the predicted player position.
  · @return {Vector3}
    */
    getPredictedPlayerPosition() {
    _predictedPlayerPos.set( this._predictedPlayerX, this._predictedPlayerY, this._predictedPlayerZ );
    return _predictedPlayerPos;
    }
  /**
  · Returns the predicted player forward vector.
  · @return {Vector3}
    */
    getPredictedForward() {
    _predictedPlayerForward.set( this._predictedForwardX, this._predictedForwardY, this._predictedForwardZ );
    return _predictedPlayerForward;
    }
  /**
  · Returns the current predictive weight applied to density.
  · @return {number}
    */
    getPredictiveWeight() {
    return this._predictiveWeight;
    }
  /**
  · Returns the future visibility score in [0, 1].
  · @return {number}
    */
    getFutureVisibility() {
    return this._futureVisibility;
    }
  /**
  · Returns a high-precision prediction ledger for telemetry.
  · @return {object}
    */
    getPredictionLedger() {
    const px = new Double( this._predictedPlayerX );
    const py = new Double( this._predictedPlayerY );
    const pz = new Double( this._predictedPlayerZ );
    return {
    predictedPlayer: { x: px.valueOf(), y: py.valueOf(), z: pz.valueOf() },
    predictedForward: {
    x: this._predictedForwardX,
    y: this._predictedForwardY,
    z: this._predictedForwardZ
    },
    playerVelocity: this._playerVelocityMagnitude,
    playerAngularVelocity: this._playerAngularVelocityMagnitude,
    predictionHorizon: this.predictionHorizon,
    predictionFrames: this._predictionFrames,
    predictedPlayerDistance: this._predictedPlayerDistance,
    futureVisibility: this._futureVisibility,
    futureAngle: this._futureAngle,
    futureDistance: this._futureDistance,
    predictiveWeight: this._predictiveWeight,
    enabled: this._enabled,
    teleportDetected: this._teleportDetected
    };
    }
  // ─── Update override ──────────────────────────────────────────────────────
  /**
  · Overrides MotionVelocityWeightingLOD.update. Runs the full parent chain
  · (SSE, curvature, visibility, motion, allocator), then folds in the
  · predictive weight derived from the shared predicted player state.
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
    // ── 1. Parent chain runs everything up through the allocator. ───────
    super.update( camera, player, rawDeltaTime );
    if ( ! this._enabled || this._predictionFrozen ) {
    this._predictiveWeight = 1.0;
    this.syncPredictionECS();
    return;
    }
    // ── 2. Compute the predictive visibility for this LOD. ─────────────
    this._computeFutureVisibility();
    // ── 3. Derive the predictive weight. ────────────────────────────────
    this._predictiveWeight = this._computePredictiveWeight();
    // ── 4. Apply the predictive weight to the density target. ───────────
    // Predictive weight is one-sided: it can only RAISE density, never
    // lower it. This guarantees prediction never causes quality loss
    // for objects that are currently visible.
    const before = this._dynamicTargetDensity;
    const boosted = before * Math.max( 1.0, this._predictiveWeight );
    const after = Math.min( 1.0, Math.max( 0.0, boosted ) );
    if ( Math.abs( after - before ) > 1e-4 ) {
    this._dynamicTargetDensity = after;
    }
    this.syncPredictionECS();
    }
  // ─── Future visibility computation ──────────────────────────────────────
  _computeFutureVisibility() {
  // LOD world position.
  const lodE = this.matrixWorld.elements;
  _lodWorldPos.set( lodE[ 12 ], lodE[ 13 ], lodE[ 14 ] );
  }
  _computePredictiveWeight() {
  // If we are barely moving, prediction should not affect density.
  const speed = this._playerVelocityMagnitude;
  const angular = this._playerAngularVelocityMagnitude;
  }
  // ─── Static player state update ────────────────────────────────────────
  /**
  · Dead-reckons the player forward and publishes the predicted state to
  · all registered prediction LODs. Must be called once per frame by the
  · host, BEFORE any LOD updates.
  · 
  · @param {Object3D} player - The player transform.
  · @param {number} deltaTime - Frame delta in seconds.
    */
    static updatePlayer( player, deltaTime ) {
    const dt = Math.max( 1e-5, deltaTime );
    // ── 1. Extract current player position + orientation. ───────────────
    const e = player.matrixWorld.elements;
    const wx = e[ 12 ];
    const wy = e[ 13 ];
    const wz = e[ 14 ];
    // Forward is the negative Z axis of the player's world matrix.
    glMatrix.vec3.set( _scratchVec3A, - e[ 8 ], - e[ 9 ], - e[ 10 ] );
    glMatrix.vec3.normalize( _scratchVec3A, _scratchVec3A );
    // Up is the positive Y axis.
    glMatrix.vec3.set( _scratchVec3B, e[ 4 ], e[ 5 ], e[ 6 ] );
    glMatrix.vec3.normalize( _scratchVec3B, _scratchVec3B );
    const fwdX = _scratchVec3A[ 0 ];
    const fwdY = _scratchVec3A[ 1 ];
    const fwdZ = _scratchVec3A[ 2 ];
    const upX = _scratchVec3B[ 0 ];
    const upY = _scratchVec3B[ 1 ];
    const upZ = _scratchVec3B[ 2 ];
    // ── 2. First-frame initialization. ──────────────────────────────────
    if ( ! PlayerPredictivePositionLOD._playerInitialized ) {
    PlayerPredictivePositionLOD._prevPlayerX = wx;
    PlayerPredictivePositionLOD._prevPlayerY = wy;
    PlayerPredictivePositionLOD._prevPlayerZ = wz;
    PlayerPredictivePositionLOD._prevForwardX = fwdX;
    PlayerPredictivePositionLOD._prevForwardY = fwdY;
    PlayerPredictivePositionLOD._prevForwardZ = fwdZ;
    PlayerPredictivePositionLOD._playerInitialized = true;
    }
    // ── 3. Linear velocity. ─────────────────────────────────────────────
    const dx = wx - PlayerPredictivePositionLOD._prevPlayerX;
    const dy = wy - PlayerPredictivePositionLOD._prevPlayerY;
    const dz = wz - PlayerPredictivePositionLOD._prevPlayerZ;
    const rawDelta = Math.hypot( dx, dy, dz );
    const isTeleport = rawDelta > PlayerPredictionDefaults.teleportThreshold;
    if ( isTeleport ) {
    PlayerPredictivePositionLOD._playerVelocityX = 0.0;
    PlayerPredictivePositionLOD._playerVelocityY = 0.0;
    PlayerPredictivePositionLOD._playerVelocityZ = 0.0;
    PlayerPredictivePositionLOD._playerVelocityMagnitude = 0.0;
    PlayerPredictivePositionLOD._playerAngularVelocityMagnitude = 0.0;
    } else {
    const vx = dx / dt;
    const vy = dy / dt;
    const vz = dz / dt;
    }
    // ── 5. Dead-reckon the player forward. ─────────────────────────────
    const horizon = Math.min(
    PlayerPredictionDefaults.maxHorizon,
    PlayerPredictivePositionLOD._predictionHorizonOverride > 0
    ? PlayerPredictivePositionLOD._predictionHorizonOverride
    : PlayerPredictionDefaults.predictionHorizon
    );
    const predX = wx + PlayerPredictivePositionLOD._playerVelocityX * horizon;
    const predY = wy + PlayerPredictivePositionLOD._playerVelocityY * horizon;
    const predZ = wz + PlayerPredictivePositionLOD._playerVelocityZ * horizon;
    PlayerPredictivePositionLOD._predictedPlayerX = predX;
    PlayerPredictivePositionLOD._predictedPlayerY = predY;
    PlayerPredictivePositionLOD._predictedPlayerZ = predZ;
    // ── 6. Rotate the forward vector by the predicted angular travel. ──
    // Apply the full predicted rotation to the current forward.
    const predictedAngularTravel = PlayerPredictivePositionLOD._playerAngularVelocityMagnitude * horizon;
    if ( predictedAngularTravel > 1e-4 ) {
    // Compute the rotation axis from the forward delta cross product.
    glMatrix.vec3.set(
    _scratchVec3C,
    PlayerPredictivePositionLOD._prevForwardX,
    PlayerPredictivePositionLOD._prevForwardY,
    PlayerPredictivePositionLOD._prevForwardZ
    );
    glMatrix.vec3.set( _scratchVec3D, fwdX, fwdY, fwdZ );
    } else {
    PlayerPredictivePositionLOD._predictedForwardX = fwdX;
    PlayerPredictivePositionLOD._predictedForwardY = fwdY;
    PlayerPredictivePositionLOD._predictedForwardZ = fwdZ;
    }
    PlayerPredictivePositionLOD._predictedUpX = upX;
    PlayerPredictivePositionLOD._predictedUpY = upY;
    PlayerPredictivePositionLOD._predictedUpZ = upZ;
    // ── 7. Store previous state for next frame. ────────────────────────
    PlayerPredictivePositionLOD._prevPlayerX = wx;
    PlayerPredictivePositionLOD._prevPlayerY = wy;
    PlayerPredictivePositionLOD._prevPlayerZ = wz;
    PlayerPredictivePositionLOD._prevForwardX = fwdX;
    PlayerPredictivePositionLOD._prevForwardY = fwdY;
    PlayerPredictivePositionLOD._prevForwardZ = fwdZ;
    PlayerPredictivePositionLOD._teleportDetected = isTeleport;
    // ── 8. Publish to all registered prediction LODs. ──────────────────
    for ( const lod of PlayerPredictivePositionLOD._registeredPrediction ) {
    lod._predictedPlayerX = predX;
    lod._predictedPlayerY = predY;
    lod._predictedPlayerZ = predZ;
    }
    }
  /**
  · Overrides the shared prediction horizon for all registered LODs.
  · @param {number} seconds
    */
    static setPredictionHorizon( seconds ) {
    PlayerPredictivePositionLOD._predictionHorizonOverride = Math.max( 0.0, seconds );
    }
  /**
  · Returns the shared predicted player state.
  · @return {object}
    */
    static getPredictedPlayerState() {
    return {
    position: {
    x: PlayerPredictivePositionLOD._predictedPlayerX,
    y: PlayerPredictivePositionLOD._predictedPlayerY,
    z: PlayerPredictivePositionLOD._predictedPlayerZ
    },
    forward: {
    x: PlayerPredictivePositionLOD._predictedForwardX,
    y: PlayerPredictivePositionLOD._predictedForwardY,
    z: PlayerPredictivePositionLOD._predictedForwardZ
    },
    velocity: {
    x: PlayerPredictivePositionLOD._playerVelocityX,
    y: PlayerPredictivePositionLOD._playerVelocityY,
    z: PlayerPredictivePositionLOD._playerVelocityZ,
    magnitude: PlayerPredictivePositionLOD._playerVelocityMagnitude
    },
    angularVelocityMagnitude: PlayerPredictivePositionLOD._playerAngularVelocityMagnitude,
    teleportDetected: PlayerPredictivePositionLOD._teleportDetected
    };
    }
  static _registerPredictionLOD( lod ) {
  PlayerPredictivePositionLOD._registeredPrediction.add( lod );
  }
  static _unregisterPredictionLOD( lod ) {
  PlayerPredictivePositionLOD._registeredPrediction.delete( lod );
  }
  // ─── ECS registration ──────────────────────────────────────────────────────
  registerPredictionECS() {
  if ( this._ecsPredictionRegistered ) {
  return this._ecsPredictionEntity;
  }
  }
  syncPredictionECS() {
  if ( ! this._ecsPredictionRegistered ) {
  return this;
  }
  }
  pullPredictionECS() {
  if ( ! this._ecsPredictionRegistered ) {
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
  · High-precision dead-reckoning of the player position. Useful for very
  · large worlds where the Float64 position delta would lose precision.
  · @param {number} x
  · @param {number} y
  · @param {number} z
  · @param {number} vx
  · @param {number} vy
  · @param {number} vz
  · @param {number} horizon
  · @return {{x:number, y:number, z:number}}
    */
    static predictPlayerPositionHighPrecision( x, y, z, vx, vy, vz, horizon ) {
    const px = new Double( x ).add( new Double( vx ).mul( new Double( horizon ) ) );
    const py = new Double( y ).add( new Double( vy ).mul( new Double( horizon ) ) );
    const pz = new Double( z ).add( new Double( vz ).mul( new Double( horizon ) ) );
    return { x: px.valueOf(), y: py.valueOf(), z: pz.valueOf() };
    }
  /**
  · Returns a deterministic dither sample for the prediction cone boundary.
  · @param {number} frameIndex
  · @return {number}
    */
    computePredictionDither( frameIndex ) {
    const seed = ( this.determinismSeed ^ ( this._ecsEntity >>> 0 ) ) >>> 0;
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
  · Packs prediction telemetry into a vec4 for GPU debug rendering.
  · Layout: (futureVisibility, futureAngle, futureDistance, predictiveWeight)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packPredictionVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
    v,
    this._futureVisibility,
    this._futureAngle,
    this._futureDistance,
    this._predictiveWeight
    );
    return v;
    }
  static getECSWorld() {
  return _predictionWorld;
  }
  static getPredictionSoA() {
  return PlayerPredictionSoA;
  }
  static get PlayerPredictionDefaults() {
  return PlayerPredictionDefaults;
  }
  }

// ─── Static prediction storage (module-scoped, shared across all instances) ─
PlayerPredictivePositionLOD._registeredPrediction = new Set();
PlayerPredictivePositionLOD._playerInitialized = false;
PlayerPredictivePositionLOD._prevPlayerX = 0.0;
PlayerPredictivePositionLOD._prevPlayerY = 0.0;
PlayerPredictivePositionLOD._prevPlayerZ = 0.0;
PlayerPredictivePositionLOD._prevForwardX = 0.0;
PlayerPredictivePositionLOD._prevForwardY = 0.0;
PlayerPredictivePositionLOD._prevForwardZ = - 1.0;
PlayerPredictivePositionLOD._playerVelocityX = 0.0;
PlayerPredictivePositionLOD._playerVelocityY = 0.0;
PlayerPredictivePositionLOD._playerVelocityZ = 0.0;
PlayerPredictivePositionLOD._playerVelocityMagnitude = 0.0;
PlayerPredictivePositionLOD._playerAngularVelocityMagnitude = 0.0;
PlayerPredictivePositionLOD._predictedPlayerX = 0.0;
PlayerPredictivePositionLOD._predictedPlayerY = 0.0;
PlayerPredictivePositionLOD._predictedPlayerZ = 0.0;
PlayerPredictivePositionLOD._predictedForwardX = 0.0;
PlayerPredictivePositionLOD._predictedForwardY = 0.0;
PlayerPredictivePositionLOD._predictedForwardZ = - 1.0;
PlayerPredictivePositionLOD._predictedUpX = 0.0;
PlayerPredictivePositionLOD._predictedUpY = 1.0;
PlayerPredictivePositionLOD._predictedUpZ = 0.0;
PlayerPredictivePositionLOD._predictionHorizonOverride = - 1.0;
PlayerPredictivePositionLOD._teleportDetected = false;

void Quaternion;
void Matrix4;

export {
PlayerPredictivePositionLOD,
PlayerPredictionSoA,
PlayerPredictionDefaults
};

