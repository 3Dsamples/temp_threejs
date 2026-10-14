
// file number : 007_8
// full path name : src/objects/007_8_LODBiasResolutionScale_LOD.js
// description : Enhancement #10 for the Dynamic LOD system. Adds render-target-scale-aware LOD bias so that dynamic resolution scaling, DLSS / FSR / TAA upscaling, and supersampling all feed back into the density target automatically. When the renderer drops to 0.7× internal resolution, every mesh can afford to reduce density proportionally, saving roughly 51% of vertex cost with no perceptible quality loss at the final upscaled output. When the renderer supersamples (1.5× or 2.0×), density is raised so the extra pixels are actually used. Includes an adaptive controller that watches frame time and nudges resolution scale to hit a target frame budget, per-material scale floors, scale-transition smoothing, and a resolution-epoch ledger for deterministic replay. Uses gl-matrix for pixel-density math, double.js for high-precision scale accounting across very large resolution changes, bitecs for SoA scale state, and simplex-noise for anti-flicker dithering during scale transitions.
// best for : Dynamic resolution scaling, DLSS / FSR / XeSS integration, TAA upscaling, temporal supersampling, VR (per-eye render scale), split-screen (per-viewport scale), GPU-bound scenes, mobile / handheld frame-budget enforcement, headless deterministic captures at fixed scale.
// license : MIT

import { PlayerPredictivePositionLOD } from './007_7_PlayerPredictivePosition_LOD.js';
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
const _noise3D = createNoise3D();

// ─── ECS world + ResolutionScale SoA component ──────────────────────────────
const _scaleWorld = createWorld();

const ResolutionScaleSoA = defineComponent( {
    // Current and target resolution scales (linear, 1.0 = native)
    currentScale: Types.f64,
    targetScale: Types.f64,
    previousScale: Types.f64,

    // Render target dimensions
    nativeWidth: Types.f64,
    nativeHeight: Types.f64,
    effectiveWidth: Types.f64,
    effectiveHeight: Types.f64,

    // Upscaling method
    upscaleMethod: Types.i32,           // 0 = none, 1 = DLSS, 2 = FSR, 3 = XeSS, 4 = TAA-U, 5 = bilinear
    upscaleQualityFactor: Types.f64,    // effective quality multiplier from the upscaler
    upscaleSharpness: Types.f64,        // 0..1, affects perceived detail retention

    // Per-LOD bias
    lodBias: Types.f64,                 // user-authored bias multiplier
    adaptiveBias: Types.f64,            // computed bias from scale
    materialScaleFloor: Types.f64,      // never drop below this density multiplier
    materialScaleCeiling: Types.f64,    // never exceed this density multiplier
    scaleBiasWeight: Types.f64,         // how strongly scale affects density (0..1)
    pixelDensityWeight: Types.f64,      // weight of raw pixel density in the bias

    // Adaptive controller state
    adaptiveEnabled: Types.ui8,
    targetFrameTimeMs: Types.f64,
    currentFrameTimeMs: Types.f64,
    frameTimeEMA: Types.f64,
    resolutionEpoch: Types.i32,
    lastEpochFrame: Types.i32,

    // Transition smoothing
    transitionSmoothing: Types.f64,
    transitionDither: Types.f64,

    // State
    frozen: Types.ui8,
    lastFrameIndex: Types.i32,
    lastDeltaTime: Types.f64
} );

// ─── Upscaling method constants ─────────────────────────────────────────────
const UpscaleMethod = Object.freeze( {
    NONE: 0,
    DLSS: 1,
    FSR: 2,
    XESS: 3,
    TAA_UPSCALE: 4,
    BILINEAR: 5
} );

// ─── Tunables specific to resolution scale bias ─────────────────────────────
const ResolutionScaleDefaults = {
    // Default render scale when the host does not provide one.
    defaultScale: 1.0,

    // Minimum and maximum allowed render scale.
    minScale: 0.4,
    maxScale: 2.0,

    // Weight of the resolution-scale bias on the final density target, in [0, 1].
    // 0 = ignore scale, 1 = scale fully drives density adjustment.
    scaleBiasWeight: 0.7,

    // Weight of raw pixel density in the bias (secondary factor).
    pixelDensityWeight: 0.3,

    // Density floor per material. Alpha-tested and transparent materials need
    // higher minimums; opaque hard-surface materials can go lower.
    materialScaleFloor: 0.45,
    materialScaleCeiling: 1.75,

    // Smoothing factor for scale transitions (0..1). Higher = snappier.
    transitionSmoothing: 0.25,

    // Dither amplitude applied during scale transitions to avoid banding.
    transitionDither: 0.02,

    // Quality factors for known upscalers. These reduce the effective
    // resolution penalty because the upscaler reconstructs detail.
    upscaleQualityFactor: {
        [ UpscaleMethod.NONE ]: 1.0,
        [ UpscaleMethod.DLSS ]: 1.35,
        [ UpscaleMethod.FSR ]: 1.20,
        [ UpscaleMethod.XESS ]: 1.25,
        [ UpscaleMethod.TAA_UPSCALE ]: 1.15,
        [ UpscaleMethod.BILINEAR ]: 1.0
    },

    // Adaptive controller: target frame time in milliseconds.
    targetFrameTimeMs: 16.67,   // 60 FPS

    // Adaptive controller: how aggressively to adjust scale (0..1).
    adaptiveResponse: 0.08,

    // Adaptive controller: EMA smoothing factor for frame time.
    frameTimeSmoothing: 0.15,

    // Adaptive controller: minimum number of frames between scale adjustments.
    minFramesBetweenAdjustments: 30,

    // Deterministic seed base.
    determinismSeed: 0x27D4EB2F,

    // Resolution epoch length (frames) for deterministic replay.
    resolutionEpochFrames: 60
};

/**
 * LODBiasResolutionScaleLOD
 *
 * Extends PlayerPredictivePositionLOD and folds the renderer's current
 * resolution scale into the density target. The core idea is simple:
 *
 *   If the renderer draws fewer pixels, every mesh needs fewer vertices
 *   to look identical at the final upscaled output.
 *
 * Density multiplier is derived as:
 *
 *   effectiveScale  = currentScale * upscaleQualityFactor
 *   rawBias         = effectiveScale ^ pixelDensityWeight
 *   blended         = 1 + (rawBias - 1) * scaleBiasWeight
 *   finalBias       = clamp( blended, materialScaleFloor, materialScaleCeiling )
 *   target         *= finalBias * userLodBias
 *
 * The `upscaleQualityFactor` term accounts for DLSS / FSR / XeSS reconstructing
 * detail that plain bilinear upscaling would lose, so a 0.7× DLSS render does
 * not need to drop density as aggressively as a 0.7× bilinear render.
 *
 * The adaptive controller optionally watches frame time and nudges the
 * target scale automatically to hit a configured frame budget. This makes
 * the entire LOD system self-tuning under GPU pressure.
 *
 * Recommended usage:
 * ```js
 * const lod = new LODBiasResolutionScaleLOD();
 * lod.attachTarget( mesh, { vertexBudget: 64000 } );
 * lod.registerWithAllocator( 'world' );
 * lod.upscaleMethod = LODBiasResolutionScaleLOD.UpscaleMethod.DLSS;
 * lod.setAdaptiveEnabled( true );
 *
 * // Per frame, host updates the shared scale (once, before any LOD):
 * LODBiasResolutionScaleLOD.updateScale( renderer.getPixelRatio(), renderer.getSize() );
 * LODBiasResolutionScaleLOD.updateFrameTime( deltaTimeMs );
 *
 * // Then update all LODs as usual.
 * for ( const l of allLODs ) l.update( camera, player, dt );
```

· 
· @augments PlayerPredictivePositionLOD
  */
  class LODBiasResolutionScaleLOD extends PlayerPredictivePositionLOD {
  constructor() {
  super();
  }
  // ─── Public API ───────────────────────────────────────────────────────────
  /**
  · Sets the user-authored LOD bias. Applied on top of the adaptive bias.
  · @param {number} bias
  · @return {LODBiasResolutionScaleLOD}
    */
    setLODBias( bias ) {
    this._lodBias = Math.max( 0.1, Math.min( 4.0, bias ) );
    return this;
    }
  /**
  · Enables or disables the adaptive resolution controller.
  · @param {boolean} [enabled=true]
  · @return {LODBiasResolutionScaleLOD}
    */
    setAdaptiveEnabled( enabled = true ) {
    this.adaptiveEnabled = enabled;
    return this;
    }
  /**
  · Freezes resolution-scale bias. Parent layers still run.
  · @param {boolean} [frozen=true]
  · @return {LODBiasResolutionScaleLOD}
    */
    freezeScale( frozen = true ) {
    this._scaleFrozen = frozen;
    return this;
    }
  /**
  · Returns the current resolution scale.
  · @return {number}
    */
    getCurrentScale() {
    return this._currentScale;
    }
  /**
  · Returns the adaptive LOD bias derived from the current scale.
  · @return {number}
    */
    getAdaptiveBias() {
    return this._adaptiveBias;
    }
  /**
  · Returns a high-precision scale ledger for telemetry.
  · @return {object}
    */
    getScaleLedger() {
    const scale = new Double( this._currentScale );
    const bias = new Double( this._adaptiveBias );
    const nativePixels = new Double( this._nativeWidth ).mul( new Double( this._nativeHeight ) );
    const effectivePixels = new Double( this._effectiveWidth ).mul( new Double( this._effectiveHeight ) );
    return {
    currentScale: scale.valueOf(),
    targetScale: this._targetScale,
    previousScale: this._previousScale,
    effectiveBias: bias.valueOf(),
    nativeWidth: this._nativeWidth,
    nativeHeight: this._nativeHeight,
    effectiveWidth: this._effectiveWidth,
    effectiveHeight: this._effectiveHeight,
    nativePixels: nativePixels.valueOf(),
    effectivePixels: effectivePixels.valueOf(),
    pixelRatio: effectivePixels.div( nativePixels.max( new Double( 1 ) ) ).valueOf(),
    upscaleMethod: this.upscaleMethod,
    upscaleQualityFactor: this.upscaleQualityFactor,
    adaptiveEnabled: this.adaptiveEnabled,
    frameTimeEMA: this._frameTimeEMA,
    resolutionEpoch: this._resolutionEpoch
    };
    }
  // ─── Update override ──────────────────────────────────────────────────────
  /**
  · Overrides PlayerPredictivePositionLOD.update. Runs the full parent chain,
  · then folds the resolution-scale-derived bias into the density target.
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
    // ── 1. Pull the shared scale state into this LOD. ───────────────────
    this._currentScale = LODBiasResolutionScaleLOD._currentScale;
    this._targetScale = LODBiasResolutionScaleLOD._targetScale;
    this._previousScale = LODBiasResolutionScaleLOD._previousScale;
    this._nativeWidth = LODBiasResolutionScaleLOD._nativeWidth;
    this._nativeHeight = LODBiasResolutionScaleLOD._nativeHeight;
    this._effectiveWidth = LODBiasResolutionScaleLOD._effectiveWidth;
    this._effectiveHeight = LODBiasResolutionScaleLOD._effectiveHeight;
    this.upscaleMethod = LODBiasResolutionScaleLOD._upscaleMethod;
    this.upscaleQualityFactor = ResolutionScaleDefaults.upscaleQualityFactor[ this.upscaleMethod ] || 1.0;
    // ── 2. Parent chain runs everything up through prediction. ──────────
    super.update( camera, player, rawDeltaTime );
    if ( this._scaleFrozen ) {
    this._adaptiveBias = 1.0;
    this.syncScaleECS();
    return;
    }
    // ── 3. Compute the resolution-scale bias. ───────────────────────────
    this._adaptiveBias = this._computeScaleBias();
    // ── 4. Fold the bias into the density target. ───────────────────────
    const before = this._dynamicTargetDensity;
    let after = before * this._adaptiveBias * this._lodBias;
    after = Math.min( 1.0, Math.max( 0.0, after ) );
    if ( Math.abs( after - before ) > 1e-4 ) {
    this._dynamicTargetDensity = after;
    }
    this.syncScaleECS();
    }
  // ─── Scale bias computation ─────────────────────────────────────────────
  _computeScaleBias() {
  // ── 1. Effective scale = render scale × upscaler quality factor. ────
  const effectiveScale = this._currentScale * this.upscaleQualityFactor;
  }
  // ─── Static scale update ─────────────────────────────────────────────────
  /**
  · Publishes the current renderer scale to all registered resolution-scale
  · LODs. Called once per frame by the host, BEFORE any LOD updates.
  · 
  · @param {number} scale - Render scale in [minScale, maxScale].
  · @param {number} [width] - Native width.
  · @param {number} [height] - Native height.
    */
    static updateScale( scale, width, height ) {
    const clamped = Math.min(
    ResolutionScaleDefaults.maxScale,
    Math.max( ResolutionScaleDefaults.minScale, scale )
    );
    LODBiasResolutionScaleLOD._previousScale = LODBiasResolutionScaleLOD._currentScale;
    LODBiasResolutionScaleLOD._targetScale = clamped;
    // Smooth the current scale toward the target.
    const s = Math.min( 1.0, Math.max( 0.01, ResolutionScaleDefaults.transitionSmoothing ) );
    LODBiasResolutionScaleLOD._currentScale +=
    ( clamped - LODBiasResolutionScaleLOD._currentScale ) * s;
    if ( width !== undefined && height !== undefined ) {
    LODBiasResolutionScaleLOD._nativeWidth = width;
    LODBiasResolutionScaleLOD._nativeHeight = height;
    LODBiasResolutionScaleLOD._effectiveWidth = Math.round( width * LODBiasResolutionScaleLOD._currentScale );
    LODBiasResolutionScaleLOD._effectiveHeight = Math.round( height * LODBiasResolutionScaleLOD._currentScale );
    }
    // Advance the resolution epoch if the scale crossed an epoch boundary.
    const epochSize = ResolutionScaleDefaults.resolutionEpochFrames;
    if ( LODBiasResolutionScaleLOD._frameIndex - LODBiasResolutionScaleLOD._lastEpochFrame >= epochSize ) {
    LODBiasResolutionScaleLOD._resolutionEpoch ++;
    LODBiasResolutionScaleLOD._lastEpochFrame = LODBiasResolutionScaleLOD._frameIndex;
    }
    }
  /**
  · Publishes the current frame time in milliseconds. When adaptive is
  · enabled on any registered LOD, the shared target scale is nudged
  · toward a value that hits targetFrameTimeMs.
  · 
  · @param {number} frameTimeMs
    */
    static updateFrameTime( frameTimeMs ) {
    const dt = Math.max( 0.1, Math.min( 200.0, frameTimeMs ) );
    LODBiasResolutionScaleLOD._currentFrameTimeMs = dt;
    const s = Math.min( 1.0, Math.max( 0.01, ResolutionScaleDefaults.frameTimeSmoothing ) );
    LODBiasResolutionScaleLOD._frameTimeEMA += ( dt - LODBiasResolutionScaleLOD._frameTimeEMA ) * s;
    // Only adjust scale if any registered LOD has adaptive enabled.
    if ( LODBiasResolutionScaleLOD._adaptiveActiveCount > 0 ) {
    LODBiasResolutionScaleLOD._tickAdaptiveScale();
    }
    }
  static _tickAdaptiveScale() {
  const target = ResolutionScaleDefaults.targetFrameTimeMs;
  const current = LODBiasResolutionScaleLOD._frameTimeEMA;
  }
  /**
  · Sets the upscaling method shared across all registered LODs.
  · @param {number} method
    */
    static setUpscaleMethod( method ) {
    LODBiasResolutionScaleLOD._upscaleMethod = method;
    }
  /**
  · Sets the upscale sharpness (0..1) shared across all registered LODs.
  · @param {number} sharpness
    */
    static setUpscaleSharpness( sharpness ) {
    LODBiasResolutionScaleLOD._upscaleSharpness = Math.min( 1.0, Math.max( 0.0, sharpness ) );
    }
  /**
  · Returns the current shared scale state.
  · @return {object}
    */
    static getSharedScaleState() {
    return {
    currentScale: LODBiasResolutionScaleLOD._currentScale,
    targetScale: LODBiasResolutionScaleLOD._targetScale,
    previousScale: LODBiasResolutionScaleLOD._previousScale,
    nativeWidth: LODBiasResolutionScaleLOD._nativeWidth,
    nativeHeight: LODBiasResolutionScaleLOD._nativeHeight,
    effectiveWidth: LODBiasResolutionScaleLOD._effectiveWidth,
    effectiveHeight: LODBiasResolutionScaleLOD._effectiveHeight,
    upscaleMethod: LODBiasResolutionScaleLOD._upscaleMethod,
    upscaleSharpness: LODBiasResolutionScaleLOD._upscaleSharpness,
    frameTimeEMA: LODBiasResolutionScaleLOD._frameTimeEMA,
    resolutionEpoch: LODBiasResolutionScaleLOD._resolutionEpoch
    };
    }
  static _registerScaleLOD( lod ) {
  LODBiasResolutionScaleLOD._registeredScale.add( lod );
  if ( lod.adaptiveEnabled ) {
  LODBiasResolutionScaleLOD._adaptiveActiveCount ++;
  }
  }
  static _unregisterScaleLOD( lod ) {
  if ( LODBiasResolutionScaleLOD._registeredScale.delete( lod ) && lod.adaptiveEnabled ) {
  LODBiasResolutionScaleLOD._adaptiveActiveCount --;
  }
  }
  // ─── ECS registration ──────────────────────────────────────────────────────
  registerScaleECS() {
  if ( this._ecsScaleRegistered ) {
  return this._ecsScaleEntity;
  }
  }
  syncScaleECS() {
  if ( ! this._ecsScaleRegistered ) {
  return this;
  }
  }
  pullScaleECS() {
  if ( ! this._ecsScaleRegistered ) {
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
  · Computes the pixel ratio (effective / native) with double.js for
  · high-precision accounting. Useful when chaining many scale changes.
  · @return {number}
    */
    computePixelRatioHighPrecision() {
    const native = new Double( this._nativeWidth ).mul( new Double( this._nativeHeight ) );
    const effective = new Double( this._effectiveWidth ).mul( new Double( this._effectiveHeight ) );
    return effective.div( native.max( new Double( 1 ) ) ).valueOf();
    }
  /**
  · Returns a deterministic dither sample for the scale transition.
  · @param {number} frameIndex
  · @return {number}
    */
    computeScaleDither( frameIndex ) {
    const seed = ( this.determinismSeed ^ ( this._ecsEntity >>> 0 ) ^ ( this._resolutionEpoch * 73856093 ) ) >>> 0;
    return _noise3D( seed * 1e-6, frameIndex * 0.05, this.id );
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
  · Packs resolution-scale telemetry into a vec4 for GPU debug rendering.
  · Layout: (currentScale, targetScale, adaptiveBias, userLodBias)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packScaleVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
    v,
    this._currentScale,
    this._targetScale,
    this._adaptiveBias,
    this._lodBias
    );
    return v;
    }
  static getECSWorld() {
  return _scaleWorld;
  }
  static getResolutionScaleSoA() {
  return ResolutionScaleSoA;
  }
  static get ResolutionScaleDefaults() {
  return ResolutionScaleDefaults;
  }
  static get UpscaleMethod() {
  return UpscaleMethod;
  }
  }

// ─── Static scale storage (module-scoped, shared across all instances) ──────
LODBiasResolutionScaleLOD._registeredScale = new Set();
LODBiasResolutionScaleLOD._adaptiveActiveCount = 0;
LODBiasResolutionScaleLOD._currentScale = ResolutionScaleDefaults.defaultScale;
LODBiasResolutionScaleLOD._targetScale = ResolutionScaleDefaults.defaultScale;
LODBiasResolutionScaleLOD._previousScale = ResolutionScaleDefaults.defaultScale;
LODBiasResolutionScaleLOD._nativeWidth = 1920;
LODBiasResolutionScaleLOD._nativeHeight = 1080;
LODBiasResolutionScaleLOD._effectiveWidth = 1920;
LODBiasResolutionScaleLOD._effectiveHeight = 1080;
LODBiasResolutionScaleLOD._upscaleMethod = UpscaleMethod.NONE;
LODBiasResolutionScaleLOD._upscaleSharpness = 0.0;
LODBiasResolutionScaleLOD._currentFrameTimeMs = 16.67;
LODBiasResolutionScaleLOD._frameTimeEMA = 16.67;
LODBiasResolutionScaleLOD._resolutionEpoch = 0;
LODBiasResolutionScaleLOD._lastEpochFrame = - 1;
LODBiasResolutionScaleLOD._frameIndex = 0;

export {
LODBiasResolutionScaleLOD,
ResolutionScaleSoA,
ResolutionScaleDefaults,
UpscaleMethod
};

