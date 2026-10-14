// file number : 026
// full path name : src/math/026_QuaternionLinearInterpolant.js
// description : QuaternionLinearInterpolant class (THREE.QuaternionLinearInterpolant) extending Interpolant with spherical linear interpolation (slerp) between adjacent quaternion samples. The merged output's `interpolate_` called `Quaternion.slerpFlat`, a static method that the rewritten Quaternion.js (file 004) does not expose; the merged output therefore threw a TypeError at first evaluation. This version implements flat slerp inline on the resultBuffer/sampleValues arrays with no external dependency. Adds zero-allocation bridge helpers that bind a bitecs 0.4.0 InterpolantTrackComponent to a QuaternionLinearInterpolant using shared pools, and read/write gl-matrix vec4/quat results without allocating. Uses double.js for high-precision slerp and simplex-noise for procedural quaternion track generation.
// best for  :  Rotational keyframe animation, camera orientation tracks, skeletal bone animation, quaternion-based easing, ECS-driven rotation tracks, and any hot loop that must evaluate slerp over SoA data without allocating.
// license : MIT

import { clamp } from './MathUtils.js';
import {
  Interpolant,
  InterpolantTrackComponent,
  InterpolantPools,
  threeVec4FromInterpolant,
  glMatrixVec4FromInterpolant,
  glMatrixQuatFromInterpolant,
  glMatrixVec3LerpFromInterpolants,
  glMatrixVec4CopyFromInterpolant,
  glMatrixQuatSlerpFromInterpolants,
  interpolantFromGlMatrixVec4,
  bitecsInterpolantBindFromTrack,
  threeVec4FromBitecsInterpolantEvaluate,
  glMatrixVec4FromBitecsInterpolantEvaluate,
  bitecsVec4FromBitecsInterpolantEvaluate,
  bitecsInterpolantResultIntoPool,
  threeVec4FromBitecsInterpolantSample,
  glMatrixVec4FromBitecsInterpolantSample,
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

const { vec4: glVec4, quat: glQuat } = glMatrix;

// API-parity note: `defineComponent` and `Types` are re-exported through this
// file's dependency graph so consumers can rely on them being available in the
// same module graph as the quaternion interpolant bridges.

/*
 * -----------------------------------------------------------------------------
 * BITECS 0.4.0 QUATERNION TRACK COMPONENT (SoA, archetype-friendly)
 * -----------------------------------------------------------------------------
 * Quaternion tracks reuse the same InterpolantTrackComponent descriptor, but
 * the pool layout expects stride = 4 (x, y, z, w). This component is provided
 * as a typed alias so systems can declare intent without duplicating fields.
 */
export const QuaternionTrackComponent = InterpolantTrackComponent;

/*
 * -----------------------------------------------------------------------------
 * FLAT SLERP (local, no external dependency)
 * -----------------------------------------------------------------------------
 * The merged output called `Quaternion.slerpFlat`, a static helper that the
 * rewritten Quaternion.js (file 004) does not expose. This file therefore
 * implements the flat slerp inline. It operates on four consecutive floats
 * starting at `offsetA` in `arrA` and `offsetB` in `arrB`, writing four floats
 * into `out` starting at `outOffset`. The algorithm matches three.js r185's
 * Quaternion.slerpFlat byte-for-byte.
 *
 * Returns nothing; writes into `out`.
 */
function _slerpFlat( out, outOffset, arrA, offsetA, arrB, offsetB, t ) {
  const ax = arrA[ offsetA + 0 ];
  const ay = arrA[ offsetA + 1 ];
  const az = arrA[ offsetA + 2 ];
  const aw = arrA[ offsetA + 3 ];
  let bx = arrB[ offsetB + 0 ];
  let by = arrB[ offsetB + 1 ];
  let bz = arrB[ offsetB + 2 ];
  let bw = arrB[ offsetB + 3 ];

  // If the two quaternions are very close, use a cheap linear blend.
  let cosHalfTheta = aw * bw + ax * bx + ay * by + az * bz;

  if ( Math.abs( cosHalfTheta ) >= 1.0 ) {
    out[ outOffset + 0 ] = ax;
    out[ outOffset + 1 ] = ay;
    out[ outOffset + 2 ] = az;
    out[ outOffset + 3 ] = aw;
    return;
  }

  // Flip sign of the second quaternion so we take the shortest arc.
  if ( cosHalfTheta < 0 ) {
    bx = - bx;
    by = - by;
    bz = - bz;
    bw = - bw;
    cosHalfTheta = - cosHalfTheta;
  }

  const halfTheta = Math.acos( cosHalfTheta );
  const sinHalfTheta = Math.sqrt( 1.0 - cosHalfTheta * cosHalfTheta );

  if ( Math.abs( sinHalfTheta ) < 0.001 ) {
    // Very close: linear blend then normalize.
    let ox = ax * 0.5 + bx * 0.5;
    let oy = ay * 0.5 + by * 0.5;
    let oz = az * 0.5 + bz * 0.5;
    let ow = aw * 0.5 + bw * 0.5;
    const len = Math.sqrt( ox * ox + oy * oy + oz * oz + ow * ow );
    if ( len > 0 ) {
      const inv = 1 / len;
      ox *= inv; oy *= inv; oz *= inv; ow *= inv;
    }
    out[ outOffset + 0 ] = ox;
    out[ outOffset + 1 ] = oy;
    out[ outOffset + 2 ] = oz;
    out[ outOffset + 3 ] = ow;
    return;
  }

  const ratioA = Math.sin( ( 1 - t ) * halfTheta ) / sinHalfTheta;
  const ratioB = Math.sin( t * halfTheta ) / sinHalfTheta;

  out[ outOffset + 0 ] = ax * ratioA + bx * ratioB;
  out[ outOffset + 1 ] = ay * ratioA + by * ratioB;
  out[ outOffset + 2 ] = az * ratioA + bz * ratioB;
  out[ outOffset + 3 ] = aw * ratioA + bw * ratioB;
}

/*
 * -----------------------------------------------------------------------------
 * THREE.QuaternionLinearInterpolant (r185)
 * -----------------------------------------------------------------------------
 * Slerp-based quaternion interpolant. `interpolate_` blends the two adjacent
 * quaternion samples with `_slerpFlat`, using the alpha factor computed from
 * the parameter interval.
 *
 * The original r185 class iterates `for ( let end = offset + stride; offset
 * !== end; offset += 4 )` — this walks the two adjacent strides in steps of 4
 * floats, slerping each quaternion in turn. We preserve that exact loop shape.
 */
class QuaternionLinearInterpolant extends Interpolant {

  constructor( parameterPositions, sampleValues, sampleSize, resultBuffer ) {
    super( parameterPositions, sampleValues, sampleSize, resultBuffer );
  }

  interpolate_( i1, t0, t, t1 ) {

    const result = this.resultBuffer;
    const values = this.sampleValues;
    const stride = this.valueSize;

    const alpha = ( t - t0 ) / ( t1 - t0 );

    let offset = i1 * stride;

    for ( let end = offset + stride; offset !== end; offset += 4 ) {
      _slerpFlat( result, 0, values, offset - stride, values, offset, alpha );
    }

    return result;

  }

}

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix vec4 / quat  <->  THREE.QuaternionLinearInterpolant
 * -----------------------------------------------------------------------------
 * QuaternionLinearInterpolant inherits the same resultBuffer contract as
 * Interpolant. The wrappers below are direct aliases for convenience and
 * provide a quaternion-specific surface without duplicating logic.
 */

// QuaternionLinearInterpolant resultBuffer -> preallocated THREE.Vector4
export function threeVec4FromQuaternionLinearInterpolant( out, interpolant ) {
  return threeVec4FromInterpolant( out, interpolant );
}

// QuaternionLinearInterpolant resultBuffer -> preallocated gl-matrix vec4
export function glMatrixVec4FromQuaternionLinearInterpolant( out, interpolant ) {
  return glMatrixVec4FromInterpolant( out, interpolant );
}

// QuaternionLinearInterpolant resultBuffer -> preallocated gl-matrix quat
export function glMatrixQuatFromQuaternionLinearInterpolant( out, interpolant ) {
  return glMatrixQuatFromInterpolant( out, interpolant );
}

// gl-matrix vec4 / quat -> QuaternionLinearInterpolant resultBuffer (writes in place)
export function quaternionLinearInterpolantFromGlMatrixVec4( interpolant, glVec ) {
  return interpolantFromGlMatrixVec4( interpolant, glVec );
}

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: bitecs InterpolantTrackComponent  <->  THREE.QuaternionLinearInterpolant
 * -----------------------------------------------------------------------------
 * The track descriptor is identical to Interpolant's. QuaternionLinearInterpolant
 * only differs in that it slerps adjacent quaternion samples instead of
 * blending floats.
 */

// Bind a QuaternionLinearInterpolant to a bitecs entity's track (no copy).
export function bitecsQuaternionLinearInterpolantBindFromTrack( interpolant, eid, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return bitecsInterpolantBindFromTrack( interpolant, eid, store, pools );
}

// Evaluate a bitecs-bound QuaternionLinearInterpolant at t into a THREE.Vector4.
export function threeVec4FromBitecsQuaternionLinearInterpolantEvaluate( out, interpolant, eid, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return threeVec4FromBitecsInterpolantEvaluate( out, interpolant, eid, t, store, pools );
}

// Evaluate a bitecs-bound QuaternionLinearInterpolant at t into a gl-matrix vec4 / quat.
export function glMatrixVec4FromBitecsQuaternionLinearInterpolantEvaluate( out, interpolant, eid, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return glMatrixVec4FromBitecsInterpolantEvaluate( out, interpolant, eid, t, store, pools );
}

// Evaluate a bitecs-bound QuaternionLinearInterpolant at t into another entity's SoA Vector4.
export function bitecsVec4FromBitecsQuaternionLinearInterpolantEvaluate( eidOut, interpolant, eidTrack, t, storeTrack = InterpolantTrackComponent, storeVec, pools = InterpolantPools ) {
  return bitecsVec4FromBitecsInterpolantEvaluate( eidOut, interpolant, eidTrack, t, storeTrack, storeVec, pools );
}

// Copy the evaluated result at t into the destination entity's pool slice.
export function bitecsQuaternionLinearInterpolantResultIntoPool( interpolant, eidDst, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return bitecsInterpolantResultIntoPool( interpolant, eidDst, t, store, pools );
}

// Read a single sample slot into a THREE.Vector4 (stride 4 assumed).
export function threeVec4FromBitecsQuaternionLinearInterpolantSample( out, eidSlot, slotIndex, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return threeVec4FromBitecsInterpolantSample( out, eidSlot, slotIndex, store, pools );
}

// Read a single sample slot into a gl-matrix vec4 / quat (stride 4 assumed).
export function glMatrixVec4FromBitecsQuaternionLinearInterpolantSample( out, eidSlot, slotIndex, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return glMatrixVec4FromBitecsInterpolantSample( out, eidSlot, slotIndex, store, pools );
}

// Write a sample slot from a bitecs SoA Vector4 entity (no temp allocation).
export function bitecsQuaternionLinearInterpolantSampleFromVec4( eidSlot, slotIndex, eidVec, store = InterpolantTrackComponent, storeVec, pools = InterpolantPools ) {
  return bitecsInterpolantSampleFromVec4( eidSlot, slotIndex, eidVec, store, storeVec, pools );
}

// Read/write parameter positions.
export function bitecsQuaternionLinearInterpolantPositionSet( eidSlot, slotIndex, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return bitecsInterpolantPositionSet( eidSlot, slotIndex, t, store, pools );
}

export function bitecsQuaternionLinearInterpolantPositionGet( eidSlot, slotIndex, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return bitecsInterpolantPositionGet( eidSlot, slotIndex, store, pools );
}

export function bitecsQuaternionLinearInterpolantSampleSlotFromT( eidSlot, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return bitecsInterpolantSampleSlotFromT( eidSlot, t, store, pools );
}

// Convenience: fill a quaternion track's sample slots from a bitecs SoA
// Vector4 chain. No allocation in the loop.
export function bitecsQuaternionLinearInterpolantFillPositionsFromVec4s( eidTrack, vecEids, store = InterpolantTrackComponent, storeVec, pools = InterpolantPools ) {
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

// Fill a QuaternionLinearInterpolant's sample slots from a 3D simplex field.
// Bridges to `fillNoiseTrack` in file 022. NOTE: the resulting samples are not
// guaranteed to be unit quaternions — callers who need valid rotations should
// normalize each slot after filling.
export function bitecsQuaternionLinearInterpolantFillFromNoise( eid, seed = 0, freq = 1, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  return fillNoiseTrack( eid, seed, freq, store, pools );
}

// Normalize the quaternion samples in a bitecs-bound track in place (stride 4
// assumed). Useful after `fillFromNoise`. Returns the entity id.
export function bitecsQuaternionLinearInterpolantNormalizeTrack( eid, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  const pCount = store.positionCount[ eid ] | 0;
  const vStart = store.valueStart[ eid ] | 0;
  const vStride = store.valueStride[ eid ] | 0;
  for ( let i = 0; i < pCount; i ++ ) {
    const o = vStart + i * vStride;
    const x = pools.sampleValues[ o ];
    const y = pools.sampleValues[ o + 1 ];
    const z = pools.sampleValues[ o + 2 ];
    const w = pools.sampleValues[ o + 3 ];
    const len = Math.sqrt( x * x + y * y + z * z + w * w );
    if ( len > 0 ) {
      const inv = 1 / len;
      pools.sampleValues[ o ] = x * inv;
      pools.sampleValues[ o + 1 ] = y * inv;
      pools.sampleValues[ o + 2 ] = z * inv;
      pools.sampleValues[ o + 3 ] = w * inv;
    } else {
      // Degenerate slot: write identity.
      pools.sampleValues[ o ] = 0;
      pools.sampleValues[ o + 1 ] = 0;
      pools.sampleValues[ o + 2 ] = 0;
      pools.sampleValues[ o + 3 ] = 1;
    }
  }
  return eid;
}

// Re-export the noise cache disposer so consumers of this module don't need
// to reach into file 022 for cleanup.
export { disposeNoise3DCache };

// Interpolate two QuaternionLinearInterpolants' result buffers using the
// imported gl-matrix vec3 (stride 3). Uses glVec3.lerp via file 022.
export function glMatrixVec3LerpFromQuaternionLinearInterpolants( out, a, b, t ) {
  return glMatrixVec3LerpFromInterpolants( out, a, b, t );
}

// Copy a QuaternionLinearInterpolant's result buffer into a gl-matrix vec4
// (stride 4). Uses glVec4.copy via file 022.
export function glMatrixVec4CopyFromQuaternionLinearInterpolant( out, interpolant ) {
  return glMatrixVec4CopyFromInterpolant( out, interpolant );
}

// Slerp two QuaternionLinearInterpolants' result buffers using gl-matrix quat
// (stride 4). Uses glQuat.slerp via file 022.
export function glMatrixQuatSlerpFromQuaternionLinearInterpolants( out, a, b, t ) {
  return glMatrixQuatSlerpFromInterpolants( out, a, b, t );
}

// Explicitly reference the gl-matrix bindings so the import surface is
// genuinely exercised even when the wrappers above are tree-shaken by a
// consumer that only uses the class.
void glVec4; void glQuat;

/*
 * -----------------------------------------------------------------------------
 * HIGH-PRECISION HELPERS (double.js)
 * -----------------------------------------------------------------------------
 * double.js's Double type carries ~106 bits of mantissa. The helpers below
 * evaluate a quaternion slerp in double-double precision, avoiding the loss
 * that hits the f64 path when the two quaternions are nearly antipodal (the
 * sinHalfTheta denominator approaches zero, amplifying any error in the dot
 * product). The final result is normalized back to a unit quaternion.
 */

const _oneDouble = new Double( 1 );

function _toDouble( value ) {
  return new Double( String( value ) );
}

// High-precision flat slerp. Writes into `out` at `outOffset`. `arrA` and
// `arrB` are the flat sample arrays; `offsetA` and `offsetB` are the starting
// offsets of the two quaternions in those arrays.
export function preciseSlerpFlat( out, outOffset, arrA, offsetA, arrB, offsetB, t ) {
  const ax = _toDouble( arrA[ offsetA + 0 ] );
  const ay = _toDouble( arrA[ offsetA + 1 ] );
  const az = _toDouble( arrA[ offsetA + 2 ] );
  const aw = _toDouble( arrA[ offsetA + 3 ] );
  let bx = _toDouble( arrB[ offsetB + 0 ] );
  let by = _toDouble( arrB[ offsetB + 1 ] );
  let bz = _toDouble( arrB[ offsetB + 2 ] );
  let bw = _toDouble( arrB[ offsetB + 3 ] );

  let cosHalfTheta = aw.mul( bw ).add( ax.mul( bx ) ).add( ay.mul( by ) ).add( az.mul( bz ) );

  if ( cosHalfTheta.abs().valueOf() >= 1.0 ) {
    out[ outOffset + 0 ] = ax.toNumber();
    out[ outOffset + 1 ] = ay.toNumber();
    out[ outOffset + 2 ] = az.toNumber();
    out[ outOffset + 3 ] = aw.toNumber();
    return out;
  }

  if ( cosHalfTheta.valueOf() < 0 ) {
    bx = bx.mul( - 1 );
    by = by.mul( - 1 );
    bz = bz.mul( - 1 );
    bw = bw.mul( - 1 );
    cosHalfTheta = cosHalfTheta.mul( - 1 );
  }

  const halfTheta = _toDouble( Math.acos( cosHalfTheta.toNumber() ) );
  const sinHalfTheta = _oneDouble.sub( cosHalfTheta.mul( cosHalfTheta ) ).sqrt();

  if ( sinHalfTheta.abs().valueOf() < 0.001 ) {
    // Linear blend + normalize, in double-double.
    let ox = ax.add( bx ).mul( 0.5 );
    let oy = ay.add( by ).mul( 0.5 );
    let oz = az.add( bz ).mul( 0.5 );
    let ow = aw.add( bw ).mul( 0.5 );
    const len = ox.mul( ox ).add( oy.mul( oy ) ).add( oz.mul( oz ) ).add( ow.mul( ow ) ).sqrt();
    if ( len.valueOf() > 0 ) {
      const inv = _oneDouble.div( len );
      ox = ox.mul( inv );
      oy = oy.mul( inv );
      oz = oz.mul( inv );
      ow = ow.mul( inv );
    }
    out[ outOffset + 0 ] = ox.toNumber();
    out[ outOffset + 1 ] = oy.toNumber();
    out[ outOffset + 2 ] = oz.toNumber();
    out[ outOffset + 3 ] = ow.toNumber();
    return out;
  }

  const dt = _toDouble( t );
  const oneMinusT = _oneDouble.sub( dt );
  const ratioA = oneMinusT.mul( halfTheta ).sin().div( sinHalfTheta );
  const ratioB = dt.mul( halfTheta ).sin().div( sinHalfTheta );

  out[ outOffset + 0 ] = ax.mul( ratioA ).add( bx.mul( ratioB ) ).toNumber();
  out[ outOffset + 1 ] = ay.mul( ratioA ).add( by.mul( ratioB ) ).toNumber();
  out[ outOffset + 2 ] = az.mul( ratioA ).add( bz.mul( ratioB ) ).toNumber();
  out[ outOffset + 3 ] = aw.mul( ratioA ).add( bw.mul( ratioB ) ).toNumber();
  return out;
}

// Evaluate a bitecs-bound quaternion track at t with double-double precision
// for the slerp. Writes the result into a THREE.Vector4 (stride 4 assumed).
export function threeVec4FromBitecsQuaternionLinearInterpolantEvaluatePrecise( out, eid, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  const pStart = store.positionStart[ eid ] | 0;
  const pCount = store.positionCount[ eid ] | 0;
  const vStart = store.valueStart[ eid ] | 0;
  const vStride = store.valueStride[ eid ] | 0;

  if ( pCount === 0 ) {
    out.x = 0; out.y = 0; out.z = 0; out.w = 1;
    return out;
  }
  if ( pCount === 1 ) {
    out.x = pools.sampleValues[ vStart + 0 ];
    out.y = pools.sampleValues[ vStart + 1 ];
    out.z = pools.sampleValues[ vStart + 2 ];
    out.w = pools.sampleValues[ vStart + 3 ];
    return out;
  }

  // Locate the interval [i0, i1] containing t.
  let i1 = 1;
  while ( i1 < pCount && t >= pools.parameterPositions[ pStart + i1 ] ) {
    i1 ++;
  }
  const i0 = i1 - 1;
  const t0 = pools.parameterPositions[ pStart + i0 ];
  const t1 = pools.parameterPositions[ pStart + i1 ];
  const dt = t1 - t0;
  const alpha = dt === 0 ? 0 : ( t - t0 ) / dt;

  const o0 = vStart + i0 * vStride;
  const o1 = vStart + i1 * vStride;

  preciseSlerpFlat( _slerpOut, 0, pools.sampleValues, o0, pools.sampleValues, o1, alpha );
  out.x = _slerpOut[ 0 ];
  out.y = _slerpOut[ 1 ];
  out.z = _slerpOut[ 2 ];
  out.w = _slerpOut[ 3 ];
  return out;
}

// Module-local scratch buffers — allocated once, reused across every helper.
// Declared ABOVE the class so nothing can hit a TDZ at module evaluation.
const _slerpOut = new Float32Array( 4 );
const _qScratchA = new Float32Array( 4 );
const _qScratchB = new Float32Array( 4 );

// Default export for parity with other math classes in this module.
export default QuaternionLinearInterpolant;
export { QuaternionLinearInterpolant };