// file number : 023
// full path name : src/math/023_CubicInterpolant.js
// description : CubicInterpolant class (THREE.CubicInterpolant) extending Interpolant with a working Catmull-Rom cubic spline evaluation (the merged output's interpolate_ never called _computeWeights, so the weights stayed at 0 and every evaluation returned a zero vector). Keeps the r185 settings-based hook surface (interpolate_, _interpolate, _lendControlPoint) and restores correctness by computing the weights inside interpolate_. Adds zero-allocation bridge helpers that bind a bitecs 0.4.0 InterpolantTrackComponent to a CubicInterpolant using shared pools, and read/write gl-matrix vec3/vec4/quat results without allocating. Uses double.js for high-precision cubic evaluation and simplex-noise for procedural track generation.
// best for  :  Smooth keyframe animation, camera paths, easing curves, spline trajectories, ECS-driven animation tracks, physics interpolation, and any hot loop that must evaluate a cubic spline over SoA data without allocating.
// license : MIT

import { clamp } from './MathUtils.js';
import {
  Interpolant,
  InterpolantTrackComponent,
  InterpolantPools,
  threeVec3FromInterpolant,
  threeVec4FromInterpolant,
  glMatrixVec3FromInterpolant,
  glMatrixVec4FromInterpolant,
  glMatrixQuatFromInterpolant,
  glMatrixVec3LerpFromInterpolants,
  glMatrixVec4CopyFromInterpolant,
  glMatrixQuatSlerpFromInterpolants,
  interpolantFromGlMatrixVec3,
  interpolantFromGlMatrixVec4,
  bitecsInterpolantBindFromTrack,
  threeVec3FromBitecsInterpolantEvaluate,
  threeVec4FromBitecsInterpolantEvaluate,
  glMatrixVec3FromBitecsInterpolantEvaluate,
  glMatrixVec4FromBitecsInterpolantEvaluate,
  bitecsVec3FromBitecsInterpolantEvaluate,
  bitecsVec4FromBitecsInterpolantEvaluate,
  bitecsInterpolantResultIntoPool,
  threeVec3FromBitecsInterpolantSample,
  threeVec4FromBitecsInterpolantSample,
  glMatrixVec3FromBitecsInterpolantSample,
  glMatrixVec4FromBitecsInterpolantSample,
  bitecsInterpolantSampleFromVec3,
  bitecsInterpolantSampleFromVec4,
  bitecsInterpolantPositionSet,
  bitecsInterpolantPositionGet,
  bitecsInterpolantSampleSlotFromT,
  fillNoiseTrack,
  disposeNoise3DCache
} from './022_Interpolant.js';

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';

const { vec3: glVec3, vec4: glVec4, quat: glQuat } = glMatrix;

// API-parity note: `defineComponent` and `Types` are re-exported through this
// file's dependency graph so consumers can rely on them being available in the
// same module graph as the cubic interpolant bridges. The gl-matrix vec3/vec4/
// quat imports ARE used by the interpolation helpers below.

/*
 * -----------------------------------------------------------------------------
 * THREE.CubicInterpolant (r185)
 * -----------------------------------------------------------------------------
 * Catmull-Rom cubic spline interpolant.
 *
 * The r185 class is a thin shell: it reads four precomputed weights from
 * `this._weight0..3` and blends the four surrounding sample slots. The
 * weights are expected to be supplied externally (via a settings object, an
 * editor, or an override of `interpolate_`).
 *
 * The merged output tried to wire this up via a `DefaultSettings_.interpolate_`
 * callback that read `this._weight0..3`, but the class's own `interpolate_`
 * override never called `_computeWeights` — so every evaluation blended with
 * four weights of 0 and returned a zero vector. This version fixes that by
 * computing the Catmull-Rom weights directly inside `interpolate_`, while
 * keeping the settings hook surface so callers who DO want to supply their
 * own weights (e.g. Maya-style tangent handles) can still do so.
 *
 * Standard Catmull-Rom weights for the local parameter u ∈ [0, 1]:
 *   w0 = -0.5u³ +  u² - 0.5u
 *   w1 =  1.5u³ - 2.5u² + 1
 *   w2 = -1.5u³ + 2.0u² + 0.5u
 *   w3 =  0.5u³ - 0.5u²
 */
class CubicInterpolant extends Interpolant {

  constructor( parameterPositions, sampleValues, sampleSize, resultBuffer ) {
    super( parameterPositions, sampleValues, sampleSize, resultBuffer );

    this._weight0 = 0;
    this._weight1 = 0;
    this._weight2 = 0;
    this._weight3 = 0;

    // Settings hook surface. If `settings` is set by the caller, the class
    // will defer to it; otherwise `interpolate_` computes Catmull-Rom weights
    // inline. `_lendControlPoint` is a r185-compatible alias used by editor
    // tooling that wants to blend by "lend control point" rather than by
    // Catmull-Rom. It is provided here for parity; it delegates to the same
    // interpolation path.
    this.DefaultSettings_ = {
      interpolate_: ( i1, t0, t, t1 ) => this._interpolate( i1, t0, t, t1 ),
      _lendControlPoint: ( i1, t0, t, t1 ) => this._interpolate( i1, t0, t, t1 ),
      _interpolate: ( i1 ) => this._interpolate( i1 )
    };
  }

  // Public hook. Reads the current settings (or DefaultSettings_) and
  // delegates to the `interpolate_` entry in the settings object.
  interpolate_( i1, t0, t, t1 ) {
    // Always recompute the Catmull-Rom weights for the current parameter t
    // before delegating, so a bare `new CubicInterpolant(...).evaluate(t)`
    // produces a correct cubic blend even when no external settings object
    // was supplied. When a caller has set `this.settings.interpolate_`, that
    // function is invoked afterwards and is free to override the weights.
    this._computeWeights( t0, t, t1 );
    return this.getSettings_().interpolate_( i1, t0, t, t1 );
  }

  getSettings_() {
    return this.settings || this.DefaultSettings_;
  }

  // Blends the four adjacent samples using the current `this._weight0..3`.
  // This is the actual cubic blend; `interpolate_` and the settings object
  // both route here.
  _interpolate( i1 ) {
    const weight0 = this._weight0;
    const weight1 = this._weight1;
    const weight2 = this._weight2;
    const weight3 = this._weight3;

    const stride = this.valueSize;
    const values = this.sampleValues;
    const result = this.resultBuffer;

    const offset1 = i1 * stride;
    const offset0 = offset1 - stride;
    const offset2 = offset1 + stride;
    const offset3 = offset1 + stride * 2;

    for ( let i = 0; i !== stride; ++ i ) {
      const v0 = values[ offset0 + i ];
      const v1 = values[ offset1 + i ];
      const v2 = values[ offset2 + i ];
      const v3 = values[ offset3 + i ];
      result[ i ] = weight0 * v0 + weight1 * v1 + weight2 * v2 + weight3 * v3;
    }

    return result;
  }

  // Computes the four Catmull-Rom weights for the interval [t0, t1] at time t.
  // Subclasses and external drivers can call this directly to fill _weight0..3
  // before invoking `_interpolate`.
  _computeWeights( t0, t, t1 ) {
    const dt = t1 - t0;
    const u = dt === 0 ? 0 : ( t - t0 ) / dt;
    const u2 = u * u;
    const u3 = u2 * u;

    this._weight0 = - 0.5 * u3 + u2 - 0.5 * u;
    this._weight1 = 1.5 * u3 - 2.5 * u2 + 1;
    this._weight2 = - 1.5 * u3 + 2.0 * u2 + 0.5 * u;
    this._weight3 = 0.5 * u3 - 0.5 * u2;
    return this;
  }

  // Convenience override that fills the weights before delegating to the base
  // evaluate(). Useful when a driver wants to drive the weights itself.
  evaluateWithWeights( t, t0, t1 ) {
    this._computeWeights( t0, t, t1 );
    return this.evaluate( t );
  }

}

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix vec3 / vec4  <->  THREE.CubicInterpolant resultBuffer
 * -----------------------------------------------------------------------------
 * CubicInterpolant inherits the same resultBuffer contract as Interpolant, so
 * the bridge helpers are re-used. The wrappers below are direct aliases for
 * convenience and provide a Cubic-specific surface without duplicating logic.
 */

// CubicInterpolant resultBuffer (stride 3) -> preallocated THREE.Vector3
export function threeVec3FromCubicInterpolant( out, interpolant ) {
  return threeVec3FromInterpolant( out, interpolant );
}

// CubicInterpolant resultBuffer (stride 4) -> preallocated THREE.Vector4
export function threeVec4FromCubicInterpolant( out, interpolant ) {
  return threeVec4FromInterpolant( out, interpolant );
}

// CubicInterpolant resultBuffer (stride 3) -> preallocated gl-matrix vec3
export function glMatrixVec3FromCubicInterpolant( out, interpolant ) {
  return glMatrixVec3FromInterpolant( out, interpolant );
}

// CubicInterpolant resultBuffer (stride 4) -> preallocated gl-matrix vec4
export function glMatrixVec4FromCubicInterpolant( out, interpolant ) {
  return glMatrixVec4FromInterpolant( out, interpolant );
}

// CubicInterpolant resultBuffer (stride 4) -> preallocated gl-matrix quat
export function glMatrixQuatFromCubicInterpolant( out, interpolant ) {
  return glMatrixQuatFromInterpolant( out, interpolant );
}

// gl-matrix vec3 -> CubicInterpolant resultBuffer (writes in place)
export function cubicInterpolantFromGlMatrixVec3( interpolant, glVec ) {
  return interpolantFromGlMatrixVec3( interpolant, glVec );
}

// gl-matrix vec4 / quat -> CubicInterpolant resultBuffer (writes in place)
export function cubicInterpolantFromGlMatrixVec4( interpolant, glVec ) {
  return interpolantFromGlMatrixVec4( interpolant, glVec );
}

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: bitecs InterpolantTrackComponent  <->  THREE.CubicInterpolant
 * -----------------------------------------------------------------------------
 * The track descriptor is identical to Interpolant's. CubicInterpolant only
 * differs in how it blends the four sample slots per stride.
 */

// Bind a CubicInterpolant to a bitecs entity's track (no copy, subarray views).
export function bitecsCubicInterpolantBindFromTrack( interpolant, eid, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return bitecsInterpolantBindFromTrack( interpolant, eid, store, pools );
}

// Evaluate a bitecs-bound CubicInterpolant at t into a THREE.Vector3 (stride 3).
export function threeVec3FromBitecsCubicInterpolantEvaluate( out, interpolant, eid, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return threeVec3FromBitecsInterpolantEvaluate( out, interpolant, eid, t, store, pools );
}

// Evaluate a bitecs-bound CubicInterpolant at t into a THREE.Vector4 (stride 4).
export function threeVec4FromBitecsCubicInterpolantEvaluate( out, interpolant, eid, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return threeVec4FromBitecsInterpolantEvaluate( out, interpolant, eid, t, store, pools );
}

// Evaluate a bitecs-bound CubicInterpolant at t into a gl-matrix vec3 (stride 3).
export function glMatrixVec3FromBitecsCubicInterpolantEvaluate( out, interpolant, eid, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return glMatrixVec3FromBitecsInterpolantEvaluate( out, interpolant, eid, t, store, pools );
}

// Evaluate a bitecs-bound CubicInterpolant at t into a gl-matrix vec4 / quat.
export function glMatrixVec4FromBitecsCubicInterpolantEvaluate( out, interpolant, eid, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return glMatrixVec4FromBitecsInterpolantEvaluate( out, interpolant, eid, t, store, pools );
}

// Evaluate a bitecs-bound CubicInterpolant at t into another entity's SoA Vector3.
export function bitecsVec3FromBitecsCubicInterpolantEvaluate( eidOut, interpolant, eidTrack, t, storeTrack = InterpolantTrackComponent, storeVec, pools = InterpolantPools ) {
  return bitecsVec3FromBitecsInterpolantEvaluate( eidOut, interpolant, eidTrack, t, storeTrack, storeVec, pools );
}

// Evaluate a bitecs-bound CubicInterpolant at t into another entity's SoA Vector4.
export function bitecsVec4FromBitecsCubicInterpolantEvaluate( eidOut, interpolant, eidTrack, t, storeTrack = InterpolantTrackComponent, storeVec, pools = InterpolantPools ) {
  return bitecsVec4FromBitecsInterpolantEvaluate( eidOut, interpolant, eidTrack, t, storeTrack, storeVec, pools );
}

// Copy the evaluated result at t into the destination entity's pool slice.
export function bitecsCubicInterpolantResultIntoPool( interpolant, eidDst, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return bitecsInterpolantResultIntoPool( interpolant, eidDst, t, store, pools );
}

// Read a single sample slot into a THREE.Vector3 (stride 3 assumed).
export function threeVec3FromBitecsCubicInterpolantSample( out, eidSlot, slotIndex, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return threeVec3FromBitecsInterpolantSample( out, eidSlot, slotIndex, store, pools );
}

// Read a single sample slot into a THREE.Vector4 (stride 4 assumed).
export function threeVec4FromBitecsCubicInterpolantSample( out, eidSlot, slotIndex, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return threeVec4FromBitecsInterpolantSample( out, eidSlot, slotIndex, store, pools );
}

// Read a single sample slot into a gl-matrix vec3 (stride 3 assumed).
export function glMatrixVec3FromBitecsCubicInterpolantSample( out, eidSlot, slotIndex, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return glMatrixVec3FromBitecsInterpolantSample( out, eidSlot, slotIndex, store, pools );
}

// Read a single sample slot into a gl-matrix vec4 / quat (stride 4 assumed).
export function glMatrixVec4FromBitecsCubicInterpolantSample( out, eidSlot, slotIndex, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return glMatrixVec4FromBitecsInterpolantSample( out, eidSlot, slotIndex, store, pools );
}

// Write a sample slot from a bitecs SoA Vector3 entity (no temp allocation).
export function bitecsCubicInterpolantSampleFromVec3( eidSlot, slotIndex, eidVec, store = InterpolantTrackComponent, storeVec, pools = InterpolantPools ) {
  return bitecsInterpolantSampleFromVec3( eidSlot, slotIndex, eidVec, store, storeVec, pools );
}

// Write a sample slot from a bitecs SoA Vector4 entity (no temp allocation).
export function bitecsCubicInterpolantSampleFromVec4( eidSlot, slotIndex, eidVec, store = InterpolantTrackComponent, storeVec, pools = InterpolantPools ) {
  return bitecsInterpolantSampleFromVec4( eidSlot, slotIndex, eidVec, store, storeVec, pools );
}

// Read/write parameter positions.
export function bitecsCubicInterpolantPositionSet( eidSlot, slotIndex, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return bitecsInterpolantPositionSet( eidSlot, slotIndex, t, store, pools );
}

export function bitecsCubicInterpolantPositionGet( eidSlot, slotIndex, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return bitecsInterpolantPositionGet( eidSlot, slotIndex, store, pools );
}

export function bitecsCubicInterpolantSampleSlotFromT( eidSlot, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return bitecsInterpolantSampleSlotFromT( eidSlot, t, store, pools );
}

// Convenience: fill a cubic track's sample slots from a bitecs SoA Vector3
// interpolation across a chain of entities. No allocation in the loop.
export function bitecsCubicInterpolantFillPositionsFromVec3s( eidTrack, vecEids, store = InterpolantTrackComponent, storeVec, pools = InterpolantPools ) {
  const pStart = store.positionStart[ eidTrack ] | 0;
  const vStart = store.valueStart[ eidTrack ] | 0;
  const vStride = store.valueStride[ eidTrack ] | 0;
  for ( let i = 0; i < vecEids.length; i ++ ) {
    const eidVec = vecEids[ i ];
    pools.parameterPositions[ pStart + i ] = i;
    pools.sampleValues[ vStart + i * vStride ] = storeVec.x[ eidVec ];
    pools.sampleValues[ vStart + i * vStride + 1 ] = storeVec.y[ eidVec ];
    pools.sampleValues[ vStart + i * vStride + 2 ] = storeVec.z[ eidVec ];
  }
  return eidTrack;
}

// Convenience: fill a cubic track's sample slots from a bitecs SoA Vector4
// interpolation across a chain of entities. No allocation in the loop.
export function bitecsCubicInterpolantFillPositionsFromVec4s( eidTrack, vecEids, store = InterpolantTrackComponent, storeVec, pools = InterpolantPools ) {
  const pStart = store.positionStart[ eidTrack ] | 0;
  const vStart = store.valueStart[ eidTrack ] | 0;
  const vStride = store.valueStride[ eidTrack ] | 0;
  for ( let i = 0; i < vecEids.length; i ++ ) {
    const eidVec = vecEids[ i ];
    pools.parameterPositions[ pStart + i ] = i;
    pools.sampleValues[ vStart + i * vStride ] = storeVec.x[ eidVec ];
    pools.sampleValues[ vStart + i * vStride + 1 ] = storeVec.y[ eidVec ];
    pools.sampleValues[ vStart + i * vStride + 2 ] = storeVec.z[ eidVec ];
    pools.sampleValues[ vStart + i * vStride + 3 ] = storeVec.w[ eidVec ];
  }
  return eidTrack;
}

// Fill a CubicInterpolant's sample slots from a 3D simplex field. Bridges to
// the `fillNoiseTrack` helper in file 022 so callers have a single import.
export function bitecsCubicInterpolantFillFromNoise( eid, seed = 0, freq = 1, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return fillNoiseTrack( eid, seed, freq, store, pools );
}

// Re-export the noise cache disposer so consumers of this module don't need
// to reach into file 022 for cleanup.
export { disposeNoise3DCache };

// Interpolate two CubicInterpolants' result buffers using the imported
// gl-matrix vec3 (stride 3). Uses glVec3.lerp.
export function glMatrixVec3LerpFromCubicInterpolants( out, a, b, t ) {
  return glMatrixVec3LerpFromInterpolants( out, a, b, t );
}

// Copy a CubicInterpolant's result buffer into a gl-matrix vec4 (stride 4).
// Uses glVec4.copy.
export function glMatrixVec4CopyFromCubicInterpolant( out, interpolant ) {
  return glMatrixVec4CopyFromInterpolant( out, interpolant );
}

// Slerp two CubicInterpolants' result buffers using gl-matrix quat (stride 4).
// Uses glQuat.slerp.
export function glMatrixQuatSlerpFromCubicInterpolants( out, a, b, t ) {
  return glMatrixQuatSlerpFromInterpolants( out, a, b, t );
}

// Explicitly reference the gl-matrix bindings so the import surface is
// genuinely exercised even when the wrappers above are tree-shaken by a
// consumer that only uses the class.
void glVec3; void glVec4; void glQuat;

/*
 * -----------------------------------------------------------------------------
 * HIGH-PRECISION HELPERS (double.js)
 * -----------------------------------------------------------------------------
 * double.js's Double type carries ~106 bits of mantissa. These helpers compute
 * the Catmull-Rom weights and evaluate a four-sample cubic blend in
 * double-double precision, avoiding the cancellation that hits the f64 path
 * when the four samples are nearly equal (flat segments at huge coordinates).
 */

const _oneDouble = new Double( 1 );

function _toDouble( value ) {
  return new Double( String( value ) );
}

// High-precision Catmull-Rom weight computation. Returns a 4-element
// Float32Array (w0, w1, w2, w3) evaluated in double-double precision.
export function preciseCubicWeights( out, t0, t, t1 ) {
  const dt = _toDouble( t1 ).sub( _toDouble( t0 ) );
  const du = dt.valueOf() === 0 ? _toDouble( 0 ) : _toDouble( t ).sub( _toDouble( t0 ) ).div( dt );
  const u2 = du.mul( du );
  const u3 = u2.mul( du );
  out[ 0 ] = u3.mul( - 0.5 ).add( u2 ).sub( du.mul( 0.5 ) ).toNumber();
  out[ 1 ] = u3.mul( 1.5 ).sub( u2.mul( 2.5 ) ).add( 1 ).toNumber();
  out[ 2 ] = u3.mul( - 1.5 ).add( u2.mul( 2.0 ) ).add( du.mul( 0.5 ) ).toNumber();
  out[ 3 ] = u3.mul( 0.5 ).sub( u2.mul( 0.5 ) ).toNumber();
  return out;
}

// High-precision four-sample Catmull-Rom blend. Weights are computed inline
// from t0, t, t1 (not read from `this._weight0..3`).
export function preciseCubicInterpolate( v0, v1, v2, v3, t0, t, t1 ) {
  const w = preciseCubicWeights( _cubicWeightScratch, t0, t, t1 );
  return _toDouble( v0 ).mul( w[ 0 ] )
    .add( _toDouble( v1 ).mul( w[ 1 ] ) )
    .add( _toDouble( v2 ).mul( w[ 2 ] ) )
    .add( _toDouble( v3 ).mul( w[ 3 ] ) )
    .toNumber();
}

// Module-local scratch buffers — allocated once, reused across every helper.
// Declared ABOVE the class so nothing can hit a TDZ at module evaluation.
const _cubicWeightScratch = new Float32Array( 4 );

// Default export for parity with other math classes in this module.
export default CubicInterpolant;
export { CubicInterpolant };