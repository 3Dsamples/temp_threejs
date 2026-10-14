
// file number : 007_6
// full path name : src/objects/007_6_MotionVelocityWeighting_LOD.js
// description : Enhancement #7 for the Dynamic LOD system. Adds world-space motion / velocity weighting so that fast-moving objects retain density longer than static ones. Temporal aliasing (shimmer, crawling edges, TAA ghosting) is far more visible on moving geometry than on a static wall, so a static wall at 200 m can drop to 20% density while a sprinting character at the same distance holds 80%. Velocity is computed from `matrixWorld` deltas using gl-matrix, smoothed with an exponential moving average, and folded into the density target as a multiplicative weight. Includes linear / angular velocity, jerk (acceleration) compensation, motion-blur coupling, and a per-object motion importance ledger. Uses double.js for high-precision velocity accumulation across large worlds, bitecs for SoA motion state, and simplex-noise for anti-shimmer dither on the velocity threshold curve.
// best for : Fast-moving characters, vehicles, projectiles, camera-relative motion, animated foliage in wind, physics-driven objects, TAA-friendly density regulation, motion-blur-coupled LOD, VR (head-motion weighting), sprint / flight / racing scenes.
// license : MIT

import { FrustumOcclusionCacheLOD } from './007_5_FrustumOcclusionCache_LOD.js';
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
const _scratchVec3C = new Float64Array( 3 );
const _scratchQuatA = new Float64Array( 4 );
const _scratchQuatB = new Float64Array( 4 );
const _noise3D = createNoise3D();

// ─── ECS world + MotionVelocity SoA component ───────────────────────────────
const _motionWorld = createWorld();

const MotionVelocitySoA = defineComponent( {
    // Previous world position (for delta computation)
    prevWorldX: Types.f64,
    prevWorldY: Types.f64,
    prevWorldZ: Types.f64,

    // Raw velocity (units / second)
    velocityX: Types.f64,
    velocityY: Types.f64,
    velocityZ: Types.f64,
    velocityMagnitude: Types.f64,

    // Smoothed velocity (EMA)
    smoothedVelocityX: Types.f64,
    smoothedVelocityY: Types.f64,
    smoothedVelocityZ: Types.f64,
    smoothedVelocityMagnitude: Types.f64,

    // Angular velocity (radians / second)
    angularVelocityX: Types.f64,
    angularVelocityY: Types.f64,
    angularVelocityZ: Types.f64,
    angularVelocityMagnitude: Types.f64,

    // Jerk (units / second^3) for acceleration compensation
    jerkMagnitude: Types.f64,

    // Motion-derived importance in [0, 1]
    motionImportance: Types.f64,
    motionWeight: Types.f64,          // user-authored weight
    motionBlurCoupling: Types.f64,    // how strongly motion blur is accounted for
    motionFloor: Types.f64,           // minimum density multiplier
    motionCeiling: Types.f64,         // maximum density multiplier
    velocitySaturation: Types.f64,    // velocity at which importance saturates

    // State
    initialized: Types.ui8,
    lastFrameIndex: Types.i32,
    lastDeltaTime: Types.f64,
    frozen: Types.ui8,
    teleportDetected: Types.ui8
} );

// ─── Tunables specific to motion / velocity weighting ───────────────────────
const MotionVelocityDefaults = {
    // Velocity magnitude (units/s) at which motion importance saturates to 1.
    velocitySaturation: 12.0,

    // Minimum density multiplier for a perfectly static object.
    motionFloor: 1.0,   // 1.0 = no additional boost; static objects are unaffected

    // Maximum density multiplier for a fast-moving object.
    motionCeiling: 1.6,

    // Weight of motion importance on the final density target, in [0, 1].
    // 0 = ignore motion, 1 = motion fully drives density boost.
    motionWeight: 0.5,

    // Exponential moving average smoothing factor for velocity.
    // Higher = more responsive, lower = smoother. Range (0, 1].
    velocitySmoothing: 0.35,

    // Whether to compensate for angular velocity (rotating objects alias too).
    angularCompensation: true,

    // Weight of angular velocity in the combined motion importance.
    angularWeight: 0.35,

    // Whether to compensate for jerk (rapid acceleration changes).
    jerkCompensation: true,

    // Weight of jerk in the combined motion importance.
    jerkWeight: 0.15,

    // Whether to fold the camera's own velocity into the object's relative
    // motion. If the camera is moving fast, everything looks fast.
    relativeToCamera: true,

    // Threshold above which a position delta is treated as a teleport
    // (e.g. object reseated by gameplay) rather than real motion.
    teleportThreshold: 100.0,

    // Dithering amplitude applied to the velocity threshold curve.
    thresholdDither: 0.02,

    // Deterministic seed base.
    determinismSeed: 0xC2B2AE35,

    // Whether to couple motion importance to motion blur strength.
    motionBlurCoupling: 0.0,

    // Motion blur strength for coupling (0 = off, 1 = full compensation).
    motionBlurStrength: 0.0
};

/**
 * MotionVelocityWeightingLOD
 *
 * Extends FrustumOcclusionCacheLOD and adds world-space motion importance.
 *
 * Motion importance is computed from three signals:
 *
 *   1. Linear velocity magnitude (units/second)
 *   2. Angular velocity magnitude (radians/second)
 *   3. Jerk magnitude (units/second^3), optionally
 *
 * Each signal is normalized against a saturation constant and combined with
 * a weighted sum. The resulting scalar in [0, 1] is remapped to a density
 * multiplier in [motionFloor, motionCeiling] and multiplied into the target.
 *
 * A teleport guard prevents gameplay reseats (instant position jumps) from
 * being interpreted as extreme velocity. When the delta exceeds
 * `teleportThreshold`, velocity is reset to zero for that frame.
 *
 * If `relativeToCamera` is true, the camera's own world-space velocity is
 * subtracted from the object's velocity so that a static object viewed from
 * a moving camera does not receive a motion boost.
 *
 * Recommended usage:
 * ```js
 * const lod = new MotionVelocityWeightingLOD();
 * lod.attachTarget( characterMesh, { vertexBudget: 96000 } );
 * lod.registerWithAllocator( 'characters', 2.0 );
 *
 * function frame( camera, player, dt ) {
 *     lod.update( camera, player, dt );
 * }
```

· 
· @augments FrustumOcclusionCacheLOD
  */
  class MotionVelocityWeightingLOD extends FrustumOcclusionCacheLOD {
  constructor() {
  super();
  }
  // ─── Public API ───────────────────────────────────────────────────────────
  /**
  · Returns the raw velocity magnitude in units/second.
  · @return {number}
    */
    getVelocityMagnitude() {
    return this._velocityMagnitude;
    }
  /**
  · Returns the smoothed velocity magnitude in units/second.
  · @return {number}
    */
    getSmoothedVelocityMagnitude() {
    return this._smoothedVelocityMagnitude;
    }
  /**
  · Returns the angular velocity magnitude in radians/second.
  · @return {number}
    */
    getAngularVelocityMagnitude() {
    return this._angularVelocityMagnitude;
    }
  /**
  · Returns the current motion importance in [0, 1].
  · @return {number}
    */
    getMotionImportance() {
    return this._motionImportance;
    }
  /**
  · Returns true if the last frame was flagged as a teleport.
  · @return {boolean}
    */
    wasTeleportDetected() {
    return this._teleportDetected;
    }
  /**
  · Freezes motion integration. Velocity is still computed but does not
  · affect the density target.
  · @param {boolean} [frozen=true]
  · @return {MotionVelocityWeightingLOD}
    */
    freezeMotion( frozen = true ) {
    this._motionFrozen = frozen;
    return this;
    }
  /**
  · Manually seeds the velocity state. Useful when spawning an object
  · mid-flight so its initial frame does not see an artificial impulse.
  · @param {number} vx
  · @param {number} vy
  · @param {number} vz
  · @return {MotionVelocityWeightingLOD}
    */
    seedVelocity( vx, vy, vz ) {
    this._velocityX = vx;
    this._velocityY = vy;
    this._velocityZ = vz;
    this._smoothedVelocityX = vx;
    this._smoothedVelocityY = vy;
    this._smoothedVelocityZ = vz;
    this._velocityMagnitude = Math.hypot( vx, vy, vz );
    this._smoothedVelocityMagnitude = this._velocityMagnitude;
    return this;
    }
  /**
  · Returns a high-precision motion ledger for telemetry.
  · @return {object}
    */
    getMotionLedger() {
    const v = new Double( this._velocityMagnitude );
    const sv = new Double( this._smoothedVelocityMagnitude );
    const av = new Double( this._angularVelocityMagnitude );
    const j = new Double( this._jerkMagnitude );
    return {
    velocity: v.valueOf(),
    smoothedVelocity: sv.valueOf(),
    angularVelocity: av.valueOf(),
    jerk: j.valueOf(),
    motionImportance: this._motionImportance,
    teleportDetected: this._teleportDetected,
    motionBlurStrength: this.motionBlurStrength
    };
    }
  // ─── Update override ──────────────────────────────────────────────────────
  /**
  · Overrides FrustumOcclusionCacheLOD.update. Before the parent chain runs,
  · this method recomputes velocity from the current world matrix, updates
  · the EMA and angular state, and derives a motion importance scalar.
  · After the parent chain computes the SSE / visibility / budget target,
  · motion importance is folded in as a multiplicative weight.
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
    const dt = Math.max( 1e-5, rawDeltaTime );
    this._lastDeltaTime = dt;
    this._teleportDetected = false;
    // ── 1. Compute velocity from the current world matrix. ─────────────
    const lodE = this.matrixWorld.elements;
    const wx = lodE[ 12 ];
    const wy = lodE[ 13 ];
    const wz = lodE[ 14 ];
    if ( ! this._initialized ) {
    this._prevWorldX = wx;
    this._prevWorldY = wy;
    this._prevWorldZ = wz;
    this._prevQuatX = this.quaternion.x;
    this._prevQuatY = this.quaternion.y;
    this._prevQuatZ = this.quaternion.z;
    this._prevQuatW = this.quaternion.w;
    this._initialized = true;
    } else {
    const dx = wx - this._prevWorldX;
    const dy = wy - this._prevWorldY;
    const dz = wz - this._prevWorldZ;
    }
    // ── 2. Derive motion importance. ────────────────────────────────────
    this._motionImportance = this._computeMotionImportance();
    // ── 3. Parent chain runs SSE / visibility / budget / allocator. ─────
    super.update( camera, player, rawDeltaTime );
    // ── 4. Fold motion importance into the density target. ──────────────
    if ( this._motionFrozen ) {
    this.syncMotionECS();
    return;
    }
    const boost = this._computeMotionDensityBoost();
    const before = this._dynamicTargetDensity;
    let after = before * boost;
    after = Math.min( 1.0, Math.max( 0.0, after ) );
    if ( Math.abs( after - before ) > 1e-4 ) {
    this._dynamicTargetDensity = after;
    }
    this.syncMotionECS();
    }
  // ─── Motion importance computation ──────────────────────────────────────
  _computeMotionImportance() {
  // ── Linear velocity contribution. ───────────────────────────────────
  const vSat = Math.max( 1e-6, this.velocitySaturation );
  let linear = this._smoothedVelocityMagnitude / vSat;
  linear = Math.min( 1.0, Math.max( 0.0, linear ) );
  }
  _computeMotionDensityBoost() {
  // Base boost from motion importance.
  const base = this.motionFloor +
  ( this.motionCeiling - this.motionFloor ) * this._motionImportance;
  }
  // ─── Camera velocity tracking (static per frame) ────────────────────────
  /**
  · Updates the shared camera velocity used for relative-motion computation.
  · Called once per frame by the host, before any LOD updates.
  · @param {Camera} camera
  · @param {number} deltaTime
    */
    static updateCameraVelocity( camera, deltaTime ) {
    if ( camera === null || camera === undefined ) {
    MotionVelocityWeightingLOD._cameraVelocityX = 0.0;
    MotionVelocityWeightingLOD._cameraVelocityY = 0.0;
    MotionVelocityWeightingLOD._cameraVelocityZ = 0.0;
    return;
    }
    const e = camera.matrixWorld.elements;
    const wx = e[ 12 ];
    const wy = e[ 13 ];
    const wz = e[ 14 ];
    if ( ! MotionVelocityWeightingLOD._cameraInitialized ) {
    MotionVelocityWeightingLOD._prevCameraX = wx;
    MotionVelocityWeightingLOD._prevCameraY = wy;
    MotionVelocityWeightingLOD._prevCameraZ = wz;
    MotionVelocityWeightingLOD._cameraInitialized = true;
    return;
    }
    const dt = Math.max( 1e-5, deltaTime );
    MotionVelocityWeightingLOD._cameraVelocityX = ( wx - MotionVelocityWeightingLOD._prevCameraX ) / dt;
    MotionVelocityWeightingLOD._cameraVelocityY = ( wy - MotionVelocityWeightingLOD._prevCameraY ) / dt;
    MotionVelocityWeightingLOD._cameraVelocityZ = ( wz - MotionVelocityWeightingLOD._prevCameraZ ) / dt;
    MotionVelocityWeightingLOD._prevCameraX = wx;
    MotionVelocityWeightingLOD._prevCameraY = wy;
    MotionVelocityWeightingLOD._prevCameraZ = wz;
    // Publish to all registered motion LODs.
    for ( const lod of MotionVelocityWeightingLOD._registeredMotion ) {
    lod._cameraVelocityX = MotionVelocityWeightingLOD._cameraVelocityX;
    lod._cameraVelocityY = MotionVelocityWeightingLOD._cameraVelocityY;
    lod._cameraVelocityZ = MotionVelocityWeightingLOD._cameraVelocityZ;
    }
    }
  /**
  · Returns the current camera velocity (world units / second).
  · @return {{x:number, y:number, z:number, magnitude:number}}
    */
    static getCameraVelocity() {
    const vx = MotionVelocityWeightingLOD._cameraVelocityX;
    const vy = MotionVelocityWeightingLOD._cameraVelocityY;
    const vz = MotionVelocityWeightingLOD._cameraVelocityZ;
    return { x: vx, y: vy, z: vz, magnitude: Math.hypot( vx, vy, vz ) };
    }
  static _registerMotionLOD( lod ) {
  MotionVelocityWeightingLOD._registeredMotion.add( lod );
  }
  static _unregisterMotionLOD( lod ) {
  MotionVelocityWeightingLOD._registeredMotion.delete( lod );
  }
  // ─── ECS registration ──────────────────────────────────────────────────────
  registerMotionECS() {
  if ( this._ecsMotionRegistered ) {
  return this._ecsMotionEntity;
  }
  }
  syncMotionECS() {
  if ( ! this._ecsMotionRegistered ) {
  return this;
  }
  }
  pullMotionECS() {
  if ( ! this._ecsMotionRegistered ) {
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
  · High-precision velocity computation using double.js. Useful when the
  · object moves across a very large world and float32 position deltas
  · would lose precision.
  · @param {number} x0
  · @param {number} y0
  · @param {number} z0
  · @param {number} x1
  · @param {number} y1
  · @param {number} z1
  · @param {number} dt
  · @return {number}
    */
    computeVelocityHighPrecision( x0, y0, z0, x1, y1, z1, dt ) {
    const dx = new Double( x1 ).sub( new Double( x0 ) );
    const dy = new Double( y1 ).sub( new Double( y0 ) );
    const dz = new Double( z1 ).sub( new Double( z0 ) );
    const d = new Double( Math.max( 1e-9, dt ) );
    return dx.mul( dx ).add( dy.mul( dy ) ).add( dz.mul( dz ) ).sqrt().div( d ).valueOf();
    }
  /**
  · Returns a deterministic dither sample for the velocity threshold curve.
  · @param {number} frameIndex
  · @return {number}
    */
    computeVelocityDither( frameIndex ) {
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
  · Packs motion telemetry into a vec4 for GPU debug rendering.
  · Layout: (velocityMagnitude, angularMagnitude, jerk, motionImportance)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packMotionVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
    v,
    this._velocityMagnitude,
    this._angularVelocityMagnitude,
    this._jerkMagnitude,
    this._motionImportance
    );
    return v;
    }
  static getECSWorld() {
  return _motionWorld;
  }
  static getMotionSoA() {
  return MotionVelocitySoA;
  }
  static get MotionVelocityDefaults() {
  return MotionVelocityDefaults;
  }
  }

// ─── Static motion storage (module-scoped, shared across all instances) ─────
MotionVelocityWeightingLOD._registeredMotion = new Set();
MotionVelocityWeightingLOD._cameraVelocityX = 0.0;
MotionVelocityWeightingLOD._cameraVelocityY = 0.0;
MotionVelocityWeightingLOD._cameraVelocityZ = 0.0;
MotionVelocityWeightingLOD._prevCameraX = 0.0;
MotionVelocityWeightingLOD._prevCameraY = 0.0;
MotionVelocityWeightingLOD._prevCameraZ = 0.0;
MotionVelocityWeightingLOD._cameraInitialized = false;

export {
MotionVelocityWeightingLOD,
MotionVelocitySoA,
MotionVelocityDefaults
};
