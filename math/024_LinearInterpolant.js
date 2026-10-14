// file number : 024
// full path name : src/math/024_LinearInterpolant.js
// description : LinearInterpolant class (THREE.LinearInterpolant) extending Interpolant with simple two-key linear blending. Adds zero-allocation bridge helpers that bind a bitecs 0.4.0 InterpolantTrackComponent to a LinearInterpolant using shared pools, and read/write gl-matrix vec3/vec4/quat results without allocating. Uses double.js for high-precision linear evaluation and simplex-noise for procedural track generation.
// best for  :  Keyframe animation between adjacent samples, color gradient sampling, path following, ECS-driven linear tracks, physics interpolation, and any hot loop that must evaluate a linear segment over SoA data without allocating.
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
// same module graph as the linear interpolant bridges. The gl-matrix vec3/vec4/
// quat imports ARE used by the interpolation helpers below.

/*
 * -----------------------------------------------------------------------------
 * THREE.LinearInterpolant (r185)
 * -----------------------------------------------------------------------------
 * Simple two-key linear blend. `interpolate_(i1, t0, t, t1)` uses
 * `weight1 = (t - t0) / (t1 - t0)` and `weight0 = 1 - weight1`.
 */
class LinearInterpolant extends Interpolant {

  constructor( parameterPositions, sampleValues, sampleSize, resultBuffer ) {
    super( parameterPositions, sampleValues, sampleSize, resultBuffer );
  }

  interpolate_( i1, t0, t, t1 ) {

    const result = this.resultBuffer;
    const values = this.sampleValues;
    const stride = this.valueSize;

    const offset1 = i1 * stride;
    const offset0 = offset1 - stride;

    const weight1 = ( t - t0 ) / ( t1 - t0 );
    const weight0 = 1 - weight1;

    for ( let i = 0; i !== stride; ++ i ) {
      result[ i ] = values[ offset0 + i ] * weight0 + values[ offset1 + i ] * weight1;
    }

    return result;

  }

}

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix vec3 / vec4  <->  THREE.LinearInterpolant resultBuffer
 * -----------------------------------------------------------------------------
 * LinearInterpolant inherits the same resultBuffer contract as Interpolant,
 * so the bridge helpers are re-used. The wrappers below are direct aliases.
 */

// LinearInterpolant resultBuffer (stride 3) -> preallocated THREE.Vector3
export function threeVec3FromLinearInterpolant( out, interpolant ) {
  return threeVec3FromInterpolant( out, interpolant );
}

// LinearInterpolant resultBuffer (stride 4) -> preallocated THREE.Vector4
export function threeVec4FromLinearInterpolant( out, interpolant ) {
  return threeVec4FromInterpolant( out, interpolant );
}

// LinearInterpolant resultBuffer (stride 3) -> preallocated gl-matrix vec3
export function glMatrixVec3FromLinearInterpolant( out, interpolant ) {
  return glMatrixVec3FromInterpolant( out, interpolant );
}

// LinearInterpolant resultBuffer (stride 4) -> preallocated gl-matrix vec4
export function glMatrixVec4FromLinearInterpolant( out, interpolant ) {
  return glMatrixVec4FromInterpolant( out, interpolant );
}

// LinearInterpolant resultBuffer (stride 4) -> preallocated gl-matrix quat
export function glMatrixQuatFromLinearInterpolant( out, interpolant ) {
  return glMatrixQuatFromInterpolant( out, interpolant );
}

// gl-matrix vec3 -> LinearInterpolant resultBuffer (writes in place)
export function linearInterpolantFromGlMatrixVec3( interpolant, glVec ) {
  return interpolantFromGlMatrixVec3( interpolant, glVec );
}

// gl-matrix vec4 / quat -> LinearInterpolant resultBuffer (writes in place)
export function linearInterpolantFromGlMatrixVec4( interpolant, glVec ) {
  return interpolantFromGlMatrixVec4( interpolant, glVec );
}

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: bitecs InterpolantTrackComponent  <->  THREE.LinearInterpolant
 * -----------------------------------------------------------------------------
 * The track descriptor is identical to Interpolant's. LinearInterpolant only
 * differs in how it blends the two adjacent sample slots per stride.
 */

// Bind a LinearInterpolant to a bitecs entity's track (no copy, subarray views).
export function bitecsLinearInterpolantBindFromTrack( interpolant, eid, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return bitecsInterpolantBindFromTrack( interpolant, eid, store, pools );
}

// Evaluate a bitecs-bound LinearInterpolant at t into a THREE.Vector3 (stride 3).
export function threeVec3FromBitecsLinearInterpolantEvaluate( out, interpolant, eid, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return threeVec3FromBitecsInterpolantEvaluate( out, interpolant, eid, t, store, pools );
}

// Evaluate a bitecs-bound LinearInterpolant at t into a THREE.Vector4 (stride 4).
export function threeVec4FromBitecsLinearInterpolantEvaluate( out, interpolant, eid, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return threeVec4FromBitecsInterpolantEvaluate( out, interpolant, eid, t, store, pools );
}

// Evaluate a bitecs-bound LinearInterpolant at t into a gl-matrix vec3 (stride 3).
export function glMatrixVec3FromBitecsLinearInterpolantEvaluate( out, interpolant, eid, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return glMatrixVec3FromBitecsInterpolantEvaluate( out, interpolant, eid, t, store, pools );
}

// Evaluate a bitecs-bound LinearInterpolant at t into a gl-matrix vec4 / quat.
export function glMatrixVec4FromBitecsLinearInterpolantEvaluate( out, interpolant, eid, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return glMatrixVec4FromBitecsInterpolantEvaluate( out, interpolant, eid, t, store, pools );
}

// Evaluate a bitecs-bound LinearInterpolant at t into another entity's SoA Vector3.
export function bitecsVec3FromBitecsLinearInterpolantEvaluate( eidOut, interpolant, eidTrack, t, storeTrack = InterpolantTrackComponent, storeVec, pools = InterpolantPools ) {
  return bitecsVec3FromBitecsInterpolantEvaluate( eidOut, interpolant, eidTrack, t, storeTrack, storeVec, pools );
}

// Evaluate a bitecs-bound LinearInterpolant at t into another entity's SoA Vector4.
export function bitecsVec4FromBitecsLinearInterpolantEvaluate( eidOut, interpolant, eidTrack, t, storeTrack = InterpolantTrackComponent, storeVec, pools = InterpolantPools ) {
  return bitecsVec4FromBitecsInterpolantEvaluate( eidOut, interpolant, eidTrack, t, storeTrack, storeVec, pools );
}

// Copy the evaluated result at t into the destination entity's pool slice.
export function bitecsLinearInterpolantResultIntoPool( interpolant, eidDst, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return bitecsInterpolantResultIntoPool( interpolant, eidDst, t, store, pools );
}

// Read a single sample slot into a THREE.Vector3 (stride 3 assumed).
export function threeVec3FromBitecsLinearInterpolantSample( out, eidSlot, slotIndex, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return threeVec3FromBitecsInterpolantSample( out, eidSlot, slotIndex, store, pools );
}

// Read a single sample slot into a THREE.Vector4 (stride 4 assumed).
export function threeVec4FromBitecsLinearInterpolantSample( out, eidSlot, slotIndex, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return threeVec4FromBitecsInterpolantSample( out, eidSlot, slotIndex, store, pools );
}

// Read a single sample slot into a gl-matrix vec3 (stride 3 assumed).
export function glMatrixVec3FromBitecsLinearInterpolantSample( out, eidSlot, slotIndex, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return glMatrixVec3FromBitecsInterpolantSample( out, eidSlot, slotIndex, store, pools );
}

// Read a single sample slot into a gl-matrix vec4 / quat (stride 4 assumed).
export function glMatrixVec4FromBitecsLinearInterpolantSample( out, eidSlot, slotIndex, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return glMatrixVec4FromBitecsInterpolantSample( out, eidSlot, slotIndex, store, pools );
}

// Write a sample slot from a bitecs SoA Vector3 entity (no temp allocation).
export function bitecsLinearInterpolantSampleFromVec3( eidSlot, slotIndex, eidVec, store = InterpolantTrackComponent, storeVec, pools = InterpolantPools ) {
  return bitecsInterpolantSampleFromVec3( eidSlot, slotIndex, eidVec, store, storeVec, pools );
}

// Write a sample slot from a bitecs SoA Vector4 entity (no temp allocation).
export function bitecsLinearInterpolantSampleFromVec4( eidSlot, slotIndex, eidVec, store = InterpolantTrackComponent, storeVec, pools = InterpolantPools ) {
  return bitecsInterpolantSampleFromVec4( eidSlot, slotIndex, eidVec, store, storeVec, pools );
}

// Read/write parameter positions.
export function bitecsLinearInterpolantPositionSet( eidSlot, slotIndex, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return bitecsInterpolantPositionSet( eidSlot, slotIndex, t, store, pools );
}

export function bitecsLinearInterpolantPositionGet( eidSlot, slotIndex, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return bitecsInterpolantPositionGet( eidSlot, slotIndex, store, pools );
}

export function bitecsLinearInterpolantSampleSlotFromT( eidSlot, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return bitecsInterpolantSampleSlotFromT( eidSlot, t, store, pools );
}

// Convenience: fill a linear track's sample slots from a bitecs SoA Vector3
// chain. No allocation in the loop.
export function bitecsLinearInterpolantFillPositionsFromVec3s( eidTrack, vecEids, store = InterpolantTrackComponent, storeVec, pools = InterpolantPools ) {
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

// Convenience: fill a linear track's sample slots from a bitecs SoA Vector4
// chain. No allocation in the loop.
export function bitecsLinearInterpolantFillPositionsFromVec4s( eidTrack, vecEids, store = InterpolantTrackComponent, storeVec, pools = InterpolantPools ) {
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

// Fill a LinearInterpolant's sample slots from a 3D simplex field. Bridges to
// the `fillNoiseTrack` helper in file 022 so callers have a single import.
export function bitecsLinearInterpolantFillFromNoise( eid, seed = 0, freq = 1, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return fillNoiseTrack( eid, seed, freq, store, pools );
}

// Re-export the noise cache disposer so consumers of this module don't need
// to reach into file 022 for cleanup.
export { disposeNoise3DCache };

// Interpolate two LinearInterpolants' result buffers using the imported
// gl-matrix vec3 (stride 3). Uses glVec3.lerp.
export function glMatrixVec3LerpFromLinearInterpolants( out, a, b, t ) {
  return glMatrixVec3LerpFromInterpolants( out, a, b, t );
}

// Copy a LinearInterpolant's result buffer into a gl-matrix vec4 (stride 4).
// Uses glVec4.copy.
export function glMatrixVec4CopyFromLinearInterpolant( out, interpolant ) {
  return glMatrixVec4CopyFromInterpolant( out, interpolant );
}

// Slerp two LinearInterpolants' result buffers using gl-matrix quat (stride 4).
// Uses glQuat.slerp.
export function glMatrixQuatSlerpFromLinearInterpolants( out, a, b, t ) {
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
 * double.js's Double type carries ~106 bits of mantissa. This helper computes
 * the linear blend `(1-t)*v0 + t*v1` in double-double precision, avoiding the
 * cancellation that hits the f64 path when v0 and v1 are nearly equal at huge
 * coordinates (flat segments in large-world animation tracks).
 */

const _oneDouble = new Double( 1 );

function _toDouble( value ) {
  return new Double( String( value ) );
}

// High-precision linear interpolation of two scalar samples at parameter t.
export function preciseLinearInterpolate( v0, v1, t ) {
  const dv0 = _toDouble( v0 );
  const dv1 = _toDouble( v1 );
  const dt = _toDouble( t );
  const oneMinusT = _oneDouble.sub( dt );
  return dv0.mul( oneMinusT ).add( dv1.mul( dt ) ).toNumber();
}

// High-precision linear interpolation between two sample slots of a
// LinearInterpolant's sampleValues buffer, writing the result into its
// resultBuffer. Reads from `interpolant.sampleValues` at offsets `offset0`
// and `offset1` for `stride` components. No allocation.
export function preciseLinearInterpolateBuffer( interpolant, offset0, offset1, stride, weight1 ) {
  const values = interpolant.sampleValues;
  const result = interpolant.resultBuffer;
  const weight0 = 1 - weight1;
  for ( let i = 0; i !== stride; ++ i ) {
    result[ i ] = _toDouble( values[ offset0 + i ] ).mul( _toDouble( weight0 ) )
      .add( _toDouble( values[ offset1 + i ] ).mul( _toDouble( weight1 ) ) )
      .toNumber();
  }
  return result;
}

// Evaluate a bitecs-bound LinearInterpolant at t with double-double precision
// for the two-key blend. Writes the result into a THREE.Vector3 (stride 3).
export function threeVec3FromBitecsLinearInterpolantEvaluatePrecise( out, eid, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  const pStart = store.positionStart[ eid ] | 0;
  const pCount = store.positionCount[ eid ] | 0;
  const vStart = store.valueStart[ eid ] | 0;
  const vStride = store.valueStride[ eid ] | 0;

  // Locate the interval [i1-1, i1] containing t.
  if ( pCount === 0 ) {
    out.x = 0; out.y = 0; out.z = 0;
    return out;
  }
  if ( pCount === 1 ) {
    const o = vStart;
    out.x = pools.sampleValues[ o ];
    out.y = pools.sampleValues[ o + 1 ];
    out.z = pools.sampleValues[ o + 2 ];
    return out;
  }
  let i1 = 1;
  while ( i1 < pCount && t >= pools.parameterPositions[ pStart + i1 ] ) {
    i1 ++;
  }
  const i0 = i1 - 1;
  const t0 = pools.parameterPositions[ pStart + i0 ];
  const t1 = pools.parameterPositions[ pStart + i1 ];
  const dt = t1 - t0;
  const w1 = dt === 0 ? 0 : ( t - t0 ) / dt;
  const w0 = 1 - w1;

  const o0 = vStart + i0 * vStride;
  const o1 = vStart + i1 * vStride;
  for ( let i = 0; i < 3; i ++ ) {
    const r = _toDouble( pools.sampleValues[ o0 + i ] ).mul( _toDouble( w0 ) )
      .add( _toDouble( pools.sampleValues[ o1 + i ] ).mul( _toDouble( w1 ) ) )
      .toNumber();
    if ( i === 0 ) out.x = r;
    else if ( i === 1 ) out.y = r;
    else out.z = r;
  }
  return out;
}

// Module-local scratch buffers — allocated once, reused across every helper.
// Declared ABOVE the class so nothing can hit a TDZ at module evaluation.
const _linearWeightScratch = new Float32Array( 2 );

// Default export for parity with other math classes in this module.
export default LinearInterpolant;
export { LinearInterpolant };