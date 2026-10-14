
// file number : 007_3
// full path name : src/objects/007_3_ScreenSpaceError_LOD.js
// description : Enhancement #4 for the Dynamic LOD system. Replaces the FOV-based coverage approximation with a proper geometric Screen-Space Error (SSE) metric — the industry-standard invariant used by Unreal, Unity, and Nanite-style pipelines. SSE is scale-, FOV-, zoom-, and resolution-invariant, so the same mesh at the same apparent pixel error gets the same density regardless of camera parameters or render-target size. Includes adaptive SSE target driven by dynamic resolution scaling, per-object pixel-error budget, and a temporal SSE ledger. Uses gl-matrix for projection math, double.js for high-precision pixel-error accumulation, bitecs for SoA SSE state, and simplex-noise for dithering on the SSE threshold curve.
// best for : FOV-invariant density regulation, zoom-invariant LOD, dynamic resolution scaling, pixel-budget-driven rendering, VR (per-eye SSE), split-screen (per-view SSE), Nanite-style continuous LOD, deterministic visual quality.
// license : MIT

import { NormalConeImportanceLOD } from './007_2_NormalConeImportance_LOD.js';
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
const _scratchVec4A = new Float64Array( 4 );
const _noise3D = createNoise3D();

// ─── ECS world + ScreenSpaceError SoA component ─────────────────────────────
const _sseWorld = createWorld();

const ScreenSpaceErrorSoA = defineComponent( {
    // Per-object geometric inputs
    objectRadius: Types.f64,        // world-space bounding-sphere radius
    geometricError: Types.f64,      // per-object geometric error (world units)

    // Per-view SSE outputs
    currentSSE: Types.f64,          // raw SSE in pixels
    targetSSE: Types.f64,           // desired max SSE (adaptive)
    sseRatio: Types.f64,            // currentSSE / targetSSE
    pixelError: Types.f64,          // instantaneous pixel error estimate
    pixelBudgetUsed: Types.f64,     // fraction of pixel budget consumed

    // Adaptive tuning state
    adaptiveTargetSSE: Types.f64,   // SSE target after adaptive scaling
    baseTargetSSE: Types.f64,       // user-authored base target
    sseBias: Types.f64,             // user bias on SSE

    // Resolution & viewport
    viewportHeight: Types.f64,
    viewportWidth: Types.f64,
    resolutionScale: Types.f64,     // e.g. 0.7 for dynamic resolution

    // Temporal ledger
    lastFrameIndex: Types.i32,
    sseVelocity: Types.f64,
    sseConverged: Types.ui8,
    frozen: Types.ui8
} );

// ─── Tunables specific to screen-space error ────────────────────────────────
const ScreenSpaceErrorDefaults = {
    // Base target SSE in pixels. 1.0 = sub-pixel (ultra quality).
    // Typical values: 1.0 (ultra), 2.0 (high), 4.0 (medium), 8.0 (low).
    baseTargetSSE: 2.0,

    // Minimum and maximum allowed SSE target under adaptive scaling.
    minTargetSSE: 0.5,
    maxTargetSSE: 16.0,

    // How aggressively the target adapts to runtime conditions.
    adaptiveResponse: 0.35,

    // Sensitivity of density to SSE ratio.
    // DensityMultiplier = targetSSE / currentSSE, clamped to [sseFloor, sseCeiling].
    sseFloor: 0.05,
    sseCeiling: 4.0,

    // Fallback geometric error when the object has no bounding sphere.
    fallbackGeometricError: 0.01,

    // Dithering amplitude on the SSE threshold curve (anti-banding).
    thresholdDither: 0.05,

    // Deterministic seed base.
    determinismSeed: 0x165667B1,

    // Viewport height fallback if the renderer does not report one.
    fallbackViewportHeight: 1080
};

/**
 * ScreenSpaceErrorLOD
 *
 * Extends NormalConeImportanceLOD and replaces the FOV-based coverage
 * heuristic with a rigorous geometric Screen-Space Error metric.
 *
 * The SSE formula used is:
 *
 *   pixelError = ( geometricError * viewportHeight ) / ( 2 * distance * tan( fov / 2 ) )
 *   currentSSE = pixelError * k
 *
 * where:
 *   - geometricError is the object's world-space approximation error
 *     (for a mesh this is typically boundingSphere.radius * sagFactor)
 *   - viewportHeight is the render-target height in pixels
 *   - distance is the world-space distance from the camera to the object
 *   - fov is the camera's vertical field of view in radians
 *   - k is a unit-conversion factor (1.0 by default, since the formula
 *     already yields pixels when geometricError and distance share units)
 *
 * The SSE is invariant to:
 *   - Camera FOV (because fov is in the denominator)
 *   - Camera zoom (folded into the effective fov)
 *   - Render-target resolution (because viewportHeight is in the numerator)
 *   - Object world scale (because geometricError scales with the object)
 *
 * A density multiplier is derived as:
 *
 *   densityMult = clamp( targetSSE / currentSSE, sseFloor, sseCeiling )
 *   newTarget   = parentTarget * densityMult
 *
 * The targetSSE itself adapts to runtime pressure (frame budget, dynamic
 * resolution scale, GPU load) via an adaptive controller.
 *
 * Recommended usage:
 * ```js
 * const lod = new ScreenSpaceErrorLOD();
 * lod.attachTarget( mesh, { vertexBudget: 64000, geometricError: 0.02 } );
 * lod.baseTargetSSE = 2.0;   // 2 pixels of error = high quality
 *
 * function frame( camera, player, dt ) {
 *     lod.viewportHeight = renderer.domElement.height;
 *     lod.resolutionScale = renderer.getPixelRatio();
 *     lod.update( camera, player, dt );
 * }
```

· 
· @augments NormalConeImportanceLOD
  */
  class ScreenSpaceErrorLOD extends NormalConeImportanceLOD {
  constructor() {
  super();
  }
  // ─── Public API ───────────────────────────────────────────────────────────
  /**
  · Overrides attachTarget to also extract geometric error from options
  · or infer it from the geometry bounding sphere.
  · 
  · @param {Object3D} target
  · @param {Object} [options]
  · @param {number} [options.geometricError] - Explicit world-space error.
  · @return {ScreenSpaceErrorLOD}
    */
    attachTarget( target, options = {} ) {
    super.attachTarget( target, options );
    if ( options.geometricError !== undefined ) {
    this._geometricError = options.geometricError;
    } else if ( target !== null && target.geometry !== undefined && target.geometry !== null ) {
    const geom = target.geometry;
    if ( geom.boundingSphere === null ) geom.computeBoundingSphere();
    if ( geom.boundingSphere !== null ) {
    // Default heuristic: 1% of the bounding-sphere radius is the
    // approximation error. This matches the sag factor used by
    // most tile-based LOD systems.
    this._geometricError = Math.max( 1e-6, geom.boundingSphere.radius * 0.01 );
    this._objectRadius = geom.boundingSphere.radius;
    }
    }
    this.syncSSEECS();
    return this;
    }
  /**
  · Sets the target SSE in pixels.
  · @param {number} pixels
  · @return {ScreenSpaceErrorLOD}
    */
    setTargetSSE( pixels ) {
    this.baseTargetSSE = pixels;
    this._targetSSE = pixels;
    this._adaptiveTargetSSE = pixels;
    return this;
    }
  /**
  · Adds a user bias to the SSE (positive = allow more error = lower density).
  · @param {number} bias
  · @return {ScreenSpaceErrorLOD}
    */
    setSSEBias( bias ) {
    this._sseBias = bias;
    return this;
    }
  /**
  · Freezes the SSE-driven density multiplier. Parent layers still run.
  · @param {boolean} [frozen=true]
  · @return {ScreenSpaceErrorLOD}
    */
    freezeSSE( frozen = true ) {
    this._sseFrozen = frozen;
    return this;
    }
  /**
  · Returns the current SSE in pixels.
  · @return {number}
    */
    getCurrentSSE() {
    return this._currentSSE;
    }
  /**
  · Returns the ratio currentSSE / targetSSE.
  · @return {number}
    */
    getSSERatio() {
    return this._sseRatio;
    }
  /**
  · Returns a high-precision snapshot of the SSE pipeline state.
  · @return {object}
    */
    getSSELedger() {
    const cur = new Double( this._currentSSE );
    const tgt = new Double( this._targetSSE );
    const ratio = cur.div( tgt.max( new Double( 1e-9 ) ) );
    return {
    currentSSE: cur.valueOf(),
    targetSSE: tgt.valueOf(),
    ratio: ratio.valueOf(),
    pixelError: this._pixelError,
    pixelBudgetUsed: this._pixelBudgetUsed,
    viewportHeight: this.viewportHeight,
    resolutionScale: this.resolutionScale,
    geometricError: this._geometricError,
    objectRadius: this._objectRadius,
    densityMultiplier: this._computeDensityMultiplier()
    };
    }
  // ─── Update override ──────────────────────────────────────────────────────
  /**
  · Overrides NormalConeImportanceLOD.update. After the parent has computed
  · a fresh density target (already biased by curvature), this method folds
  · in an SSE-derived multiplier so that pixel error drives density.
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
    // ── 1. Compute SSE BEFORE the parent runs. ──────────────────────────
    this._computeSSE( camera );
    // ── 2. Let the parent chain run (temporal + curvature + base). ──────
    super.update( camera, player, rawDeltaTime );
    // ── 3. Apply the SSE-driven density multiplier on top of the target. ─
    if ( this._sseFrozen ) {
    this.syncSSEECS();
    return;
    }
    const mult = this._computeDensityMultiplier();
    const before = this._dynamicTargetDensity;
    let after = before * mult;
    after = Math.min( 1.0, Math.max( 0.0, after ) );
    if ( Math.abs( after - before ) > 1e-4 ) {
    this._dynamicTargetDensity = after;
    }
    // ── 4. Update temporal SSE velocity ledger. ─────────────────────────
    const dt = Math.max( 1e-5, this._lastDeltaTime );
    const prev = this._currentSSE;
    this._sseVelocity = ( this._currentSSE - prev ) / dt;
    this._sseConverged = Math.abs( this._currentSSE - this._adaptiveTargetSSE ) < 0.05;
    this.syncSSEECS();
    }
  // ─── SSE computation ─────────────────────────────────────────────────────
  _computeSSE( camera ) {
  if ( camera === null || camera === undefined ) {
  this._currentSSE = 0.0;
  this._sseRatio = 0.0;
  return;
  }
  }
  _computeDensityMultiplier() {
  // If we are under target SSE, we can afford MORE density.
  // If we are over target SSE, we must REDUCE density.
  //   mult = targetSSE / currentSSE
  const tgt = Math.max( 1e-9, this._targetSSE );
  const cur = Math.max( 1e-9, this._currentSSE );
  }
  // ─── ECS registration ──────────────────────────────────────────────────────
  registerSSEECS() {
  if ( this._ecsSSERegistered ) {
  return this._ecsSSEEntity;
  }
  }
  syncSSEECS() {
  if ( ! this._ecsSSERegistered ) {
  return this;
  }
  }
  pullSSEECS() {
  if ( ! this._ecsSSERegistered ) {
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
  · Projects the object's world-space center to screen space using gl-matrix
  · and returns the pixel-space position. Useful for telemetry and for
  · computing additional importance terms (e.g. distance to screen center).
  · @param {Camera} camera
  · @return {{x:number, y:number, z:number, inFront:boolean}}
    */
    projectToScreen( camera ) {
    const lodE = this.matrixWorld.elements;
    glMatrix.vec3.set( _scratchVec3A, lodE[ 12 ], lodE[ 13 ], lodE[ 14 ] );
    glMatrix.vec4.set( _scratchVec4A, _scratchVec3A[ 0 ], _scratchVec3A[ 1 ], _scratchVec3A[ 2 ], 1.0 );
    const vp = glMatrix.mat4.multiply(
    _scratchMat4,
    camera.projectionMatrix.elements,
    camera.matrixWorldInverse.elements
    );
    glMatrix.vec4.transformMat4( _scratchVec4A, _scratchVec4A, vp );
    const w = _scratchVec4A[ 3 ];
    const inFront = w > 0;
    const ndcX = inFront ? _scratchVec4A[ 0 ] / w : 0;
    const ndcY = inFront ? _scratchVec4A[ 1 ] / w : 0;
    const px = ( ndcX * 0.5 + 0.5 ) * this.viewportWidth;
    const py = ( - ndcY * 0.5 + 0.5 ) * this.viewportHeight;
    void _scratchVec3B;
    return { x: px, y: py, z: w, inFront: inFront };
    }
  /**
  · Returns a high-precision SSE computation using double.js. Useful for
  · objects at extreme distances where float32 loses sub-pixel accuracy.
  · @param {Camera} camera
  · @return {number}
    */
    computeSSEHighPrecision( camera ) {
    const camE = camera.matrixWorld.elements;
    const lodE = this.matrixWorld.elements;
    const dx = new Double( camE[ 12 ] ).sub( new Double( lodE[ 12 ] ) );
    const dy = new Double( camE[ 13 ] ).sub( new Double( lodE[ 13 ] ) );
    const dz = new Double( camE[ 14 ] ).sub( new Double( lodE[ 14 ] ) );
    const distance = dx.mul( dx ).add( dy.mul( dy ) ).add( dz.mul( dz ) ).sqrt().max( new Double( 1e-6 ) );
    let fovY = camera.fov !== undefined ? camera.fov : 60.0;
    if ( camera.zoom !== undefined && camera.zoom > 0 ) fovY = fovY / camera.zoom;
    const tanHalfFov = Math.tan( fovY * Math.PI / 360.0 );
    const effectiveHeight = new Double( this.viewportHeight ).mul( new Double( this.resolutionScale ) );
    return new Double( this._geometricError )
    .mul( effectiveHeight )
    .div( new Double( 2.0 ).mul( distance ).mul( new Double( tanHalfFov ) ) )
    .valueOf();
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
  static getECSWorld() {
  return _sseWorld;
  }
  static getScreenSpaceErrorSoA() {
  return ScreenSpaceErrorSoA;
  }
  static get ScreenSpaceErrorDefaults() {
  return ScreenSpaceErrorDefaults;
  }
  }

export { ScreenSpaceErrorLOD, ScreenSpaceErrorSoA, ScreenSpaceErrorDefaults };
