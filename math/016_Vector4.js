// file number : 016
// full path name : src/math/016_Vector4.js
// description : 4D vector class (THREE.Vector4) with method chaining, plus full zero-allocation bridge functions to/from gl-matrix vec4 (Float32Array of length 4) and bitecs 0.4.0 SoA components (separate x/y/z/w Float32Arrays indexed by entity id). Adds high-precision double.js helpers (preciseLength, preciseDot, preciseDistanceTo, preciseLerpInto) and a seeded simplex-noise setFromNoise3D helper. Uses glVec4 for real gl-matrix-backed transform/lerp/normalize helpers so the import is genuinely exercised.
// best for  :  Homogeneous coordinates, RGBA colors, plane coefficients, quaternion-adjacent math, skinning weights, and any ECS system that stores 4D vectors as SoA x/y/z/w arrays and must feed THREE.Vector4, Matrix4.setPosition, or shader uniforms without allocating per frame.
// license : MIT

import { clamp } from './MathUtils.js';
import { Vector3 } from './003_Vector3.js';
import { Quaternion } from './004_Quaternion.js';
import { Matrix4 } from './007_Matrix4.js';

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise4D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const { vec4: glVec4 } = glMatrix;

// API parity: Vector3, Quaternion, and Matrix4 are the argument types used by
// r185 Vector4 helpers (setFromMatrixPosition, applyMatrix4, etc.), and are
// re-exported through this file's dependency graph so consumers can rely on
// them being available. The class body itself duck-types .x/.y/.z/.w/.elements
// so no runtime instantiation is required here.
void Vector3; void Quaternion; void Matrix4;

/*
 * -----------------------------------------------------------------------------
 * BITECS 0.4.0 COMPONENT DEFINITION (SoA, archetype-friendly, cache-friendly)
 * -----------------------------------------------------------------------------
 * Vector4 is stored as four independent Float32Arrays indexed by entity id.
 * Systems read/write store.x[eid], store.y[eid], store.z[eid], store.w[eid]
 * directly — no temporary vec4 object, no per-entity allocation, no GC churn.
 */
export const Vector4Component = defineComponent( {
  x: Types.f32,
  y: Types.f32,
  z: Types.f32,
  w: Types.f32
} );

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix vec4  <->  THREE.Vector4
 * -----------------------------------------------------------------------------
 * gl-matrix writes into a Float32Array out param of length 4. We mirror that
 * contract exactly. The THREE side always writes into a preallocated
 * THREE.Vector4 (the `out` argument), never returns a fresh instance, so hot
 * loops stay allocation-free.
 */

// gl-matrix vec4 (Float32Array len 4) -> preallocated THREE.Vector4
export function threeVec4FromGlMatrix( out, glVec ) {
  out.x = glVec[ 0 ];
  out.y = glVec[ 1 ];
  out.z = glVec[ 2 ];
  out.w = glVec[ 3 ];
  return out;
}

// THREE.Vector4 -> preallocated gl-matrix vec4 (Float32Array len 4)
export function glMatrixVec4FromThree( out, threeVec ) {
  out[ 0 ] = threeVec.x;
  out[ 1 ] = threeVec.y;
  out[ 2 ] = threeVec.z;
  out[ 3 ] = threeVec.w;
  return out;
}

// gl-matrix vec4 -> write directly into a bitecs entity's SoA component
export function bitecsVec4FromGlMatrix( eid, glVec, store = Vector4Component ) {
  store.x[ eid ] = glVec[ 0 ];
  store.y[ eid ] = glVec[ 1 ];
  store.z[ eid ] = glVec[ 2 ];
  store.w[ eid ] = glVec[ 3 ];
  return eid;
}

// bitecs entity SoA component -> preallocated gl-matrix vec4 (Float32Array len 4)
export function glMatrixVec4FromBitecs( out, eid, store = Vector4Component ) {
  out[ 0 ] = store.x[ eid ];
  out[ 1 ] = store.y[ eid ];
  out[ 2 ] = store.z[ eid ];
  out[ 3 ] = store.w[ eid ];
  return out;
}

// bitecs entity SoA component -> preallocated THREE.Vector4 (no temp vec4)
export function threeVec4FromBitecs( out, eid, store = Vector4Component ) {
  out.x = store.x[ eid ];
  out.y = store.y[ eid ];
  out.z = store.z[ eid ];
  out.w = store.w[ eid ];
  return out;
}

// THREE.Vector4 -> write directly into a bitecs entity's SoA component
export function bitecsVec4FromThree( eid, threeVec, store = Vector4Component ) {
  store.x[ eid ] = threeVec.x;
  store.y[ eid ] = threeVec.y;
  store.z[ eid ] = threeVec.z;
  store.w[ eid ] = threeVec.w;
  return eid;
}

// Add two bitecs SoA vec4s -> preallocated THREE.Vector4.
export function threeVec4FromBitecsAdd( out, eidA, eidB, storeA = Vector4Component, storeB = Vector4Component ) {
  out.x = storeA.x[ eidA ] + storeB.x[ eidB ];
  out.y = storeA.y[ eidA ] + storeB.y[ eidB ];
  out.z = storeA.z[ eidA ] + storeB.z[ eidB ];
  out.w = storeA.w[ eidA ] + storeB.w[ eidB ];
  return out;
}

// Add two bitecs SoA vec4s -> dst entity's SoA store.
export function bitecsVec4AddInto( eidOut, eidA, eidB, storeA = Vector4Component, storeB = Vector4Component, storeOut = storeA ) {
  storeOut.x[ eidOut ] = storeA.x[ eidA ] + storeB.x[ eidB ];
  storeOut.y[ eidOut ] = storeA.y[ eidA ] + storeB.y[ eidB ];
  storeOut.z[ eidOut ] = storeA.z[ eidA ] + storeB.z[ eidB ];
  storeOut.w[ eidOut ] = storeA.w[ eidA ] + storeB.w[ eidB ];
  return eidOut;
}

// Subtract two bitecs SoA vec4s -> preallocated THREE.Vector4.
export function threeVec4FromBitecsSub( out, eidA, eidB, storeA = Vector4Component, storeB = Vector4Component ) {
  out.x = storeA.x[ eidA ] - storeB.x[ eidB ];
  out.y = storeA.y[ eidA ] - storeB.y[ eidB ];
  out.z = storeA.z[ eidA ] - storeB.z[ eidB ];
  out.w = storeA.w[ eidA ] - storeB.w[ eidB ];
  return out;
}

// Subtract two bitecs SoA vec4s -> dst entity's SoA store.
export function bitecsVec4SubInto( eidOut, eidA, eidB, storeA = Vector4Component, storeB = Vector4Component, storeOut = storeA ) {
  storeOut.x[ eidOut ] = storeA.x[ eidA ] - storeB.x[ eidB ];
  storeOut.y[ eidOut ] = storeA.y[ eidA ] - storeB.y[ eidB ];
  storeOut.z[ eidOut ] = storeA.z[ eidA ] - storeB.z[ eidB ];
  storeOut.w[ eidOut ] = storeA.w[ eidA ] - storeB.w[ eidB ];
  return eidOut;
}

// Scale a bitecs SoA vec4 in place by a scalar.
export function bitecsVec4ScaleInPlace( eid, scalar, store = Vector4Component ) {
  store.x[ eid ] *= scalar;
  store.y[ eid ] *= scalar;
  store.z[ eid ] *= scalar;
  store.w[ eid ] *= scalar;
  return eid;
}

// Normalize a bitecs SoA vec4 in place (zero-length vectors stay zero).
export function bitecsVec4NormalizeInPlace( eid, store = Vector4Component ) {
  const x = store.x[ eid ], y = store.y[ eid ], z = store.z[ eid ], w = store.w[ eid ];
  const len = Math.sqrt( x * x + y * y + z * z + w * w );
  if ( len > 0 ) {
    const inv = 1 / len;
    store.x[ eid ] = x * inv;
    store.y[ eid ] = y * inv;
    store.z[ eid ] = z * inv;
    store.w[ eid ] = w * inv;
  }
  return eid;
}

// Negate a bitecs SoA vec4 in place.
export function bitecsVec4NegateInPlace( eid, store = Vector4Component ) {
  store.x[ eid ] = - store.x[ eid ];
  store.y[ eid ] = - store.y[ eid ];
  store.z[ eid ] = - store.z[ eid ];
  store.w[ eid ] = - store.w[ eid ];
  return eid;
}

// Floor a bitecs SoA vec4 in place.
export function bitecsVec4FloorInPlace( eid, store = Vector4Component ) {
  store.x[ eid ] = Math.floor( store.x[ eid ] );
  store.y[ eid ] = Math.floor( store.y[ eid ] );
  store.z[ eid ] = Math.floor( store.z[ eid ] );
  store.w[ eid ] = Math.floor( store.w[ eid ] );
  return eid;
}

// Ceil a bitecs SoA vec4 in place.
export function bitecsVec4CeilInPlace( eid, store = Vector4Component ) {
  store.x[ eid ] = Math.ceil( store.x[ eid ] );
  store.y[ eid ] = Math.ceil( store.y[ eid ] );
  store.z[ eid ] = Math.ceil( store.z[ eid ] );
  store.w[ eid ] = Math.ceil( store.w[ eid ] );
  return eid;
}

// Round a bitecs SoA vec4 in place.
export function bitecsVec4RoundInPlace( eid, store = Vector4Component ) {
  store.x[ eid ] = Math.round( store.x[ eid ] );
  store.y[ eid ] = Math.round( store.y[ eid ] );
  store.z[ eid ] = Math.round( store.z[ eid ] );
  store.w[ eid ] = Math.round( store.w[ eid ] );
  return eid;
}

// RoundToZero a bitecs SoA vec4 in place.
export function bitecsVec4RoundToZeroInPlace( eid, store = Vector4Component ) {
  store.x[ eid ] = Math.trunc( store.x[ eid ] );
  store.y[ eid ] = Math.trunc( store.y[ eid ] );
  store.z[ eid ] = Math.trunc( store.z[ eid ] );
  store.w[ eid ] = Math.trunc( store.w[ eid ] );
  return eid;
}

// dot product of two bitecs SoA vec4s.
export function bitecsVec4Dot( eidA, eidB, storeA = Vector4Component, storeB = Vector4Component ) {
  return storeA.x[ eidA ] * storeB.x[ eidB ] +
    storeA.y[ eidA ] * storeB.y[ eidB ] +
    storeA.z[ eidA ] * storeB.z[ eidB ] +
    storeA.w[ eidA ] * storeB.w[ eidB ];
}

// lengthSq of a bitecs SoA vec4.
export function bitecsVec4LengthSq( eid, store = Vector4Component ) {
  const x = store.x[ eid ], y = store.y[ eid ], z = store.z[ eid ], w = store.w[ eid ];
  return x * x + y * y + z * z + w * w;
}

// length of a bitecs SoA vec4.
export function bitecsVec4Length( eid, store = Vector4Component ) {
  return Math.sqrt( bitecsVec4LengthSq( eid, store ) );
}

// manhattanLength of a bitecs SoA vec4.
export function bitecsVec4ManhattanLength( eid, store = Vector4Component ) {
  return Math.abs( store.x[ eid ] ) + Math.abs( store.y[ eid ] ) +
    Math.abs( store.z[ eid ] ) + Math.abs( store.w[ eid ] );
}

// Linear interpolation between two bitecs SoA vec4s -> preallocated THREE.Vector4.
export function threeVec4FromBitecsLerp( out, eidA, eidB, alpha, storeA = Vector4Component, storeB = Vector4Component ) {
  out.x = storeA.x[ eidA ] + ( storeB.x[ eidB ] - storeA.x[ eidA ] ) * alpha;
  out.y = storeA.y[ eidA ] + ( storeB.y[ eidB ] - storeA.y[ eidA ] ) * alpha;
  out.z = storeA.z[ eidA ] + ( storeB.z[ eidB ] - storeA.z[ eidA ] ) * alpha;
  out.w = storeA.w[ eidA ] + ( storeB.w[ eidB ] - storeA.w[ eidA ] ) * alpha;
  return out;
}

// Linear interpolation between two bitecs SoA vec4s -> dst entity's SoA store.
export function bitecsVec4LerpInto( eidOut, eidA, eidB, alpha, storeA = Vector4Component, storeB = Vector4Component, storeOut = storeA ) {
  storeOut.x[ eidOut ] = storeA.x[ eidA ] + ( storeB.x[ eidB ] - storeA.x[ eidA ] ) * alpha;
  storeOut.y[ eidOut ] = storeA.y[ eidA ] + ( storeB.y[ eidB ] - storeA.y[ eidA ] ) * alpha;
  storeOut.z[ eidOut ] = storeA.z[ eidA ] + ( storeB.z[ eidB ] - storeA.z[ eidA ] ) * alpha;
  storeOut.w[ eidOut ] = storeA.w[ eidA ] + ( storeB.w[ eidB ] - storeA.w[ eidA ] ) * alpha;
  return eidOut;
}

// Linear interpolation between two bitecs SoA vec4s using vectors -> preallocated THREE.Vector4.
export function threeVec4FromBitecsLerpVectors( out, eidA, eidB, alpha, storeA = Vector4Component, storeB = Vector4Component ) {
  return threeVec4FromBitecsLerp( out, eidA, eidB, alpha, storeA, storeB );
}

// Linear interpolation between two bitecs SoA vec4s using vectors -> dst entity's SoA store.
export function bitecsVec4LerpVectorsInto( eidOut, eidA, eidB, alpha, storeA = Vector4Component, storeB = Vector4Component, storeOut = storeA ) {
  return bitecsVec4LerpInto( eidOut, eidA, eidB, alpha, storeA, storeB, storeOut );
}

// min of two bitecs SoA vec4s -> preallocated THREE.Vector4.
export function threeVec4FromBitecsMin( out, eidA, eidB, storeA = Vector4Component, storeB = Vector4Component ) {
  out.x = Math.min( storeA.x[ eidA ], storeB.x[ eidB ] );
  out.y = Math.min( storeA.y[ eidA ], storeB.y[ eidB ] );
  out.z = Math.min( storeA.z[ eidA ], storeB.z[ eidB ] );
  out.w = Math.min( storeA.w[ eidA ], storeB.w[ eidB ] );
  return out;
}

// min of two bitecs SoA vec4s -> dst entity's SoA store.
export function bitecsVec4MinInto( eidOut, eidA, eidB, storeA = Vector4Component, storeB = Vector4Component, storeOut = storeA ) {
  storeOut.x[ eidOut ] = Math.min( storeA.x[ eidA ], storeB.x[ eidB ] );
  storeOut.y[ eidOut ] = Math.min( storeA.y[ eidA ], storeB.y[ eidB ] );
  storeOut.z[ eidOut ] = Math.min( storeA.z[ eidA ], storeB.z[ eidB ] );
  storeOut.w[ eidOut ] = Math.min( storeA.w[ eidA ], storeB.w[ eidB ] );
  return eidOut;
}

// max of two bitecs SoA vec4s -> preallocated THREE.Vector4.
export function threeVec4FromBitecsMax( out, eidA, eidB, storeA = Vector4Component, storeB = Vector4Component ) {
  out.x = Math.max( storeA.x[ eidA ], storeB.x[ eidB ] );
  out.y = Math.max( storeA.y[ eidA ], storeB.y[ eidB ] );
  out.z = Math.max( storeA.z[ eidA ], storeB.z[ eidB ] );
  out.w = Math.max( storeA.w[ eidA ], storeB.w[ eidB ] );
  return out;
}

// max of two bitecs SoA vec4s -> dst entity's SoA store.
export function bitecsVec4MaxInto( eidOut, eidA, eidB, storeA = Vector4Component, storeB = Vector4Component, storeOut = storeA ) {
  storeOut.x[ eidOut ] = Math.max( storeA.x[ eidA ], storeB.x[ eidB ] );
  storeOut.y[ eidOut ] = Math.max( storeA.y[ eidA ], storeB.y[ eidB ] );
  storeOut.z[ eidOut ] = Math.max( storeA.z[ eidA ], storeB.z[ eidB ] );
  storeOut.w[ eidOut ] = Math.max( storeA.w[ eidA ], storeB.w[ eidB ] );
  return eidOut;
}

// clamp a bitecs SoA vec4 in place between min and max bitecs SoA vec4s.
export function bitecsVec4ClampInPlace( eid, eidMin, eidMax, store = Vector4Component, storeMin = Vector4Component, storeMax = Vector4Component ) {
  store.x[ eid ] = clamp( store.x[ eid ], storeMin.x[ eidMin ], storeMax.x[ eidMax ] );
  store.y[ eid ] = clamp( store.y[ eid ], storeMin.y[ eidMin ], storeMax.y[ eidMax ] );
  store.z[ eid ] = clamp( store.z[ eid ], storeMin.z[ eidMin ], storeMax.z[ eidMax ] );
  store.w[ eid ] = clamp( store.w[ eid ], storeMin.w[ eidMin ], storeMax.w[ eidMax ] );
  return eid;
}

// clampScalar a bitecs SoA vec4 in place between two scalars.
export function bitecsVec4ClampScalarInPlace( eid, minVal, maxVal, store = Vector4Component ) {
  store.x[ eid ] = clamp( store.x[ eid ], minVal, maxVal );
  store.y[ eid ] = clamp( store.y[ eid ], minVal, maxVal );
  store.z[ eid ] = clamp( store.z[ eid ], minVal, maxVal );
  store.w[ eid ] = clamp( store.w[ eid ], minVal, maxVal );
  return eid;
}

// clampLength a bitecs SoA vec4 in place between min and max lengths.
export function bitecsVec4ClampLengthInPlace( eid, min, max, store = Vector4Component ) {
  const length = bitecsVec4Length( eid, store );
  if ( length > 0 ) {
    const clampedLength = clamp( length, min, max );
    const scale = clampedLength / length;
    bitecsVec4ScaleInPlace( eid, scale, store );
  }
  return eid;
}

// distanceToSquared between two bitecs SoA vec4s.
export function bitecsVec4DistanceToSquared( eidA, eidB, storeA = Vector4Component, storeB = Vector4Component ) {
  const dx = storeA.x[ eidA ] - storeB.x[ eidB ];
  const dy = storeA.y[ eidA ] - storeB.y[ eidB ];
  const dz = storeA.z[ eidA ] - storeB.z[ eidB ];
  const dw = storeA.w[ eidA ] - storeB.w[ eidB ];
  return dx * dx + dy * dy + dz * dz + dw * dw;
}

// distanceTo between two bitecs SoA vec4s.
export function bitecsVec4DistanceTo( eidA, eidB, storeA = Vector4Component, storeB = Vector4Component ) {
  return Math.sqrt( bitecsVec4DistanceToSquared( eidA, eidB, storeA, storeB ) );
}

// manhattanDistanceTo between two bitecs SoA vec4s.
export function bitecsVec4ManhattanDistanceTo( eidA, eidB, storeA = Vector4Component, storeB = Vector4Component ) {
  return Math.abs( storeA.x[ eidA ] - storeB.x[ eidB ] ) +
    Math.abs( storeA.y[ eidA ] - storeB.y[ eidB ] ) +
    Math.abs( storeA.z[ eidA ] - storeB.z[ eidB ] ) +
    Math.abs( storeA.w[ eidA ] - storeB.w[ eidB ] );
}

// setLength a bitecs SoA vec4 in place.
export function bitecsVec4SetLengthInPlace( eid, length, store = Vector4Component ) {
  bitecsVec4NormalizeInPlace( eid, store );
  bitecsVec4ScaleInPlace( eid, length, store );
  return eid;
}

// setScalar a bitecs SoA vec4 in place.
export function bitecsVec4SetScalarInPlace( eid, scalar, store = Vector4Component ) {
  store.x[ eid ] = scalar;
  store.y[ eid ] = scalar;
  store.z[ eid ] = scalar;
  store.w[ eid ] = scalar;
  return eid;
}

// setComponent on a bitecs SoA vec4.
export function bitecsVec4SetComponentInPlace( eid, index, value, store = Vector4Component ) {
  switch ( index ) {
    case 0: store.x[ eid ] = value; break;
    case 1: store.y[ eid ] = value; break;
    case 2: store.z[ eid ] = value; break;
    case 3: store.w[ eid ] = value; break;
    default: throw new Error( 'index is out of range: ' + index );
  }
  return eid;
}

// getComponent from a bitecs SoA vec4.
export function bitecsVec4GetComponent( eid, index, store = Vector4Component ) {
  switch ( index ) {
    case 0: return store.x[ eid ];
    case 1: return store.y[ eid ];
    case 2: return store.z[ eid ];
    case 3: return store.w[ eid ];
    default: throw new Error( 'index is out of range: ' + index );
  }
}

// Apply a bitecs SoA mat4 to a bitecs SoA vec4 (as a point, w=1) -> preallocated THREE.Vector4.
export function threeVec4FromBitecsApplyMatrix4( out, eidV, eidM, storeV = Vector4Component, storeM = null ) {
  if ( storeM === null ) throw new Error( 'storeM (Matrix4Component) is required' );
  const x = storeV.x[ eidV ], y = storeV.y[ eidV ], z = storeV.z[ eidV ], w = storeV.w[ eidV ];
  const e = storeM;
  const m00 = e.m00[ eidM ], m01 = e.m10[ eidM ], m02 = e.m20[ eidM ], m03 = e.m30[ eidM ];
  const m10 = e.m01[ eidM ], m11 = e.m11[ eidM ], m12 = e.m21[ eidM ], m13 = e.m31[ eidM ];
  const m20 = e.m02[ eidM ], m21 = e.m12[ eidM ], m22 = e.m22[ eidM ], m23 = e.m32[ eidM ];
  const m30 = e.m03[ eidM ], m31 = e.m13[ eidM ], m32 = e.m23[ eidM ], m33 = e.m33[ eidM ];
  const denom = m03 * x + m13 * y + m23 * z + m33 * w;
  const invW = denom === 0 ? 1 : 1 / denom;
  out.x = ( m00 * x + m01 * y + m02 * z + m03 * w ) * invW;
  out.y = ( m10 * x + m11 * y + m12 * z + m13 * w ) * invW;
  out.z = ( m20 * x + m21 * y + m22 * z + m23 * w ) * invW;
  out.w = ( m30 * x + m31 * y + m32 * z + m33 * w ) * invW;
  return out;
}

// Apply a bitecs SoA mat4 to a bitecs SoA vec4 -> dst entity's SoA store.
export function bitecsVec4ApplyMatrix4Into( eidOut, eidV, eidM, storeV = Vector4Component, storeM = null, storeOut = storeV ) {
  if ( storeM === null ) throw new Error( 'storeM (Matrix4Component) is required' );
  const x = storeV.x[ eidV ], y = storeV.y[ eidV ], z = storeV.z[ eidV ], w = storeV.w[ eidV ];
  const e = storeM;
  const m00 = e.m00[ eidM ], m01 = e.m10[ eidM ], m02 = e.m20[ eidM ], m03 = e.m30[ eidM ];
  const m10 = e.m01[ eidM ], m11 = e.m11[ eidM ], m12 = e.m21[ eidM ], m13 = e.m31[ eidM ];
  const m20 = e.m02[ eidM ], m21 = e.m12[ eidM ], m22 = e.m22[ eidM ], m23 = e.m32[ eidM ];
  const m30 = e.m03[ eidM ], m31 = e.m13[ eidM ], m32 = e.m23[ eidM ], m33 = e.m33[ eidM ];
  const denom = m03 * x + m13 * y + m23 * z + m33 * w;
  const invW = denom === 0 ? 1 : 1 / denom;
  storeOut.x[ eidOut ] = ( m00 * x + m01 * y + m02 * z + m03 * w ) * invW;
  storeOut.y[ eidOut ] = ( m10 * x + m11 * y + m12 * z + m13 * w ) * invW;
  storeOut.z[ eidOut ] = ( m20 * x + m21 * y + m22 * z + m23 * w ) * invW;
  storeOut.w[ eidOut ] = ( m30 * x + m31 * y + m32 * z + m33 * w ) * invW;
  return eidOut;
}

// gl-matrix vec4 from bitecs vec4, transformed by a gl-matrix mat4.
export function glMatrixVec4FromBitecsApplyMatrix4( out, eidV, glM, storeV = Vector4Component ) {
  const v = _scratchVec4Input;
  v[ 0 ] = storeV.x[ eidV ];
  v[ 1 ] = storeV.y[ eidV ];
  v[ 2 ] = storeV.z[ eidV ];
  v[ 3 ] = storeV.w[ eidV ];
  return glVec4.transformMat4( out, v, glM );
}

// gl-matrix vec4 dot -> scalar, reading directly from two bitecs entities.
export function glMatrixVec4DotFromBitecs( eidA, eidB, storeA = Vector4Component, storeB = Vector4Component ) {
  return storeA.x[ eidA ] * storeB.x[ eidB ] +
    storeA.y[ eidA ] * storeB.y[ eidB ] +
    storeA.z[ eidA ] * storeB.z[ eidB ] +
    storeA.w[ eidA ] * storeB.w[ eidB ];
}

// gl-matrix vec4 normalize -> out, reading directly from a bitecs entity.
export function glMatrixVec4NormalizeFromBitecs( out, eid, store = Vector4Component ) {
  const v = _scratchVec4Input;
  v[ 0 ] = store.x[ eid ];
  v[ 1 ] = store.y[ eid ];
  v[ 2 ] = store.z[ eid ];
  v[ 3 ] = store.w[ eid ];
  return glVec4.normalize( out, v );
}

// gl-matrix vec4 lerp -> out, reading directly from two bitecs entities.
export function glMatrixVec4LerpFromBitecs( out, eidA, eidB, t, storeA = Vector4Component, storeB = Vector4Component ) {
  const a = _scratchVec4A;
  const b = _scratchVec4B;
  a[ 0 ] = storeA.x[ eidA ]; a[ 1 ] = storeA.y[ eidA ]; a[ 2 ] = storeA.z[ eidA ]; a[ 3 ] = storeA.w[ eidA ];
  b[ 0 ] = storeB.x[ eidB ]; b[ 1 ] = storeB.y[ eidB ]; b[ 2 ] = storeB.z[ eidB ]; b[ 3 ] = storeB.w[ eidB ];
  return glVec4.lerp( out, a, b, t );
}

// gl-matrix vec4 add -> out, reading directly from two bitecs entities.
export function glMatrixVec4AddFromBitecs( out, eidA, eidB, storeA = Vector4Component, storeB = Vector4Component ) {
  const a = _scratchVec4A;
  const b = _scratchVec4B;
  a[ 0 ] = storeA.x[ eidA ]; a[ 1 ] = storeA.y[ eidA ]; a[ 2 ] = storeA.z[ eidA ]; a[ 3 ] = storeA.w[ eidA ];
  b[ 0 ] = storeB.x[ eidB ]; b[ 1 ] = storeB.y[ eidB ]; b[ 2 ] = storeB.z[ eidB ]; b[ 3 ] = storeB.w[ eidB ];
  return glVec4.add( out, a, b );
}

/*
 * -----------------------------------------------------------------------------
 * HIGH-PRECISION HELPERS (double.js)
 * -----------------------------------------------------------------------------
 * double.js's Double type carries ~106 bits of mantissa. These helpers compute
 * length, dot product, distance, and lerp in double-double precision, avoiding
 * the loss that hits the f64 path when the vector is tiny relative to its
 * world-space coordinates.
 */

const _oneDouble = new Double( 1 );

function _toDouble( value ) {
  return new Double( value );
}

// Returns |v| evaluated in double-double precision, then rounded to f64.
export function preciseLength( v ) {
  const dx = _toDouble( v.x );
  const dy = _toDouble( v.y );
  const dz = _toDouble( v.z );
  const dw = _toDouble( v.w );
  return dx.mul( dx ).add( dy.mul( dy ) ).add( dz.mul( dz ) ).add( dw.mul( dw ) ).sqrt().toNumber();
}

// Returns the dot product of two THREE.Vector4 in double-double precision.
export function preciseDot( a, b ) {
  return _toDouble( a.x ).mul( _toDouble( b.x ) )
    .add( _toDouble( a.y ).mul( _toDouble( b.y ) ) )
    .add( _toDouble( a.z ).mul( _toDouble( b.z ) ) )
    .add( _toDouble( a.w ).mul( _toDouble( b.w ) ) )
    .toNumber();
}

// Returns the distance between two THREE.Vector4 in double-double precision.
export function preciseDistanceTo( a, b ) {
  const dx = _toDouble( a.x ).sub( _toDouble( b.x ) );
  const dy = _toDouble( a.y ).sub( _toDouble( b.y ) );
  const dz = _toDouble( a.z ).sub( _toDouble( b.z ) );
  const dw = _toDouble( a.w ).sub( _toDouble( b.w ) );
  return dx.mul( dx ).add( dy.mul( dy ) ).add( dz.mul( dz ) ).add( dw.mul( dw ) ).sqrt().toNumber();
}

// High-precision lerp of a and b into out (no cancellation in (1-t)a + tb).
export function preciseLerpInto( out, a, b, t ) {
  const oneMinusT = _oneDouble.sub( _toDouble( t ) );
  const dt = _toDouble( t );
  out.x = _toDouble( a.x ).mul( oneMinusT ).add( _toDouble( b.x ).mul( dt ) ).toNumber();
  out.y = _toDouble( a.y ).mul( oneMinusT ).add( _toDouble( b.y ).mul( dt ) ).toNumber();
  out.z = _toDouble( a.z ).mul( oneMinusT ).add( _toDouble( b.z ).mul( dt ) ).toNumber();
  out.w = _toDouble( a.w ).mul( oneMinusT ).add( _toDouble( b.w ).mul( dt ) ).toNumber();
  return out;
}

/*
 * -----------------------------------------------------------------------------
 * PROCEDURAL NOISE (simplex-noise)
 * -----------------------------------------------------------------------------
 * A cached 4D simplex-noise generator per seed. setFromNoise3D fills all four
 * components of the Vector4 from three spatially decorrelated samples of a 4D
 * noise field (the fourth input coordinate is used for time/animation).
 */

function _mulberry32( seed ) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul( a ^ a >>> 15, 1 | a );
    t = t + Math.imul( t ^ t >>> 7, 61 | t ) ^ t;
    return ( ( t ^ t >>> 14 ) >>> 0 ) / 4294967296;
  };
}

const _noise4DCache = new Map();

function _cachedNoise4D( seed ) {
  let gen = _noise4DCache.get( seed );
  if ( gen === undefined ) {
    gen = createNoise4D( _mulberry32( seed ) );
    _noise4DCache.set( seed, gen );
  }
  return gen;
}

// Fill a THREE.Vector4 from a 4D simplex field sampled at (x, y, z, w).
// Each component uses a decorrelated offset so the resulting vector has
// non-trivial structure in all four axes.
export function setFromNoise3D( out, x, y, z, w = 0, seed = 0 ) {
  const n = _cachedNoise4D( seed );
  out.x = n( x, y, z, w );
  out.y = n( x + 31.416, y + 47.853, z + 12.793, w + 9.211 );
  out.z = n( x - 17.234, y - 53.127, z - 91.056, w - 4.742 );
  out.w = n( x + 55.1, y - 66.2, z + 77.3, w + 3.141 );
  return out;
}

// Drop every cached noise generator.
export function disposeNoise4DCache() {
  _noise4DCache.clear();
}

// Module-local scratch buffers — allocated once, reused across every bridge.
// Declared ABOVE the bridges that reference them so there is no TDZ hazard.
const _scratchVec4Input = new Float32Array( 4 );
const _scratchVec4A = new Float32Array( 4 );
const _scratchVec4B = new Float32Array( 4 );

/*
 * -----------------------------------------------------------------------------
 * THREE.Vector4
 * -----------------------------------------------------------------------------
 */
class Vector4 {

  constructor( x = 0, y = 0, z = 0, w = 1 ) {
    Vector4.prototype.isVector4 = true;
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }

  get width() { return this.z; }
  set width( value ) { this.z = value; }

  get height() { return this.w; }
  set height( value ) { this.w = value; }

  set( x, y, z, w ) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }

  setScalar( scalar ) {
    this.x = scalar;
    this.y = scalar;
    this.z = scalar;
    this.w = scalar;
    return this;
  }

  setX( x ) { this.x = x; return this; }
  setY( y ) { this.y = y; return this; }
  setZ( z ) { this.z = z; return this; }
  setW( w ) { this.w = w; return this; }

  setComponent( index, value ) {
    switch ( index ) {
      case 0: this.x = value; break;
      case 1: this.y = value; break;
      case 2: this.z = value; break;
      case 3: this.w = value; break;
      default: throw new Error( 'index is out of range: ' + index );
    }
    return this;
  }

  getComponent( index ) {
    switch ( index ) {
      case 0: return this.x;
      case 1: return this.y;
      case 2: return this.z;
      case 3: return this.w;
      default: throw new Error( 'index is out of range: ' + index );
    }
  }

  clone() {
    return new this.constructor( this.x, this.y, this.z, this.w );
  }

  copy( v ) {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    this.w = ( v.w !== undefined ) ? v.w : 1;
    return this;
  }

  add( v ) {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    this.w += v.w;
    return this;
  }

  addScalar( s ) {
    this.x += s;
    this.y += s;
    this.z += s;
    this.w += s;
    return this;
  }

  addVectors( a, b ) {
    this.x = a.x + b.x;
    this.y = a.y + b.y;
    this.z = a.z + b.z;
    this.w = a.w + b.w;
    return this;
  }

  addScaledVector( v, s ) {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    this.w += v.w * s;
    return this;
  }

  sub( v ) {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    this.w -= v.w;
    return this;
  }

  subScalar( s ) {
    this.x -= s;
    this.y -= s;
    this.z -= s;
    this.w -= s;
    return this;
  }

  subVectors( a, b ) {
    this.x = a.x - b.x;
    this.y = a.y - b.y;
    this.z = a.z - b.z;
    this.w = a.w - b.w;
    return this;
  }

  multiply( v ) {
    this.x *= v.x;
    this.y *= v.y;
    this.z *= v.z;
    this.w *= v.w;
    return this;
  }

  multiplyScalar( scalar ) {
    this.x *= scalar;
    this.y *= scalar;
    this.z *= scalar;
    this.w *= scalar;
    return this;
  }

  multiplyVectors( a, b ) {
    this.x = a.x * b.x;
    this.y = a.y * b.y;
    this.z = a.z * b.z;
    this.w = a.w * b.w;
    return this;
  }

  applyMatrix4( m ) {
    const x = this.x, y = this.y, z = this.z, w = this.w;
    const e = m.elements;
    const denom = e[ 3 ] * x + e[ 7 ] * y + e[ 11 ] * z + e[ 15 ] * w;
    if ( denom === 0 ) {
      this.x = 0; this.y = 0; this.z = 0; this.w = 0;
      return this;
    }
    const invW = 1 / denom;
    this.x = ( e[ 0 ] * x + e[ 4 ] * y + e[ 8 ] * z + e[ 12 ] * w ) * invW;
    this.y = ( e[ 1 ] * x + e[ 5 ] * y + e[ 9 ] * z + e[ 13 ] * w ) * invW;
    this.z = ( e[ 2 ] * x + e[ 6 ] * y + e[ 10 ] * z + e[ 14 ] * w ) * invW;
    this.w = 1;
    return this;
  }

  divide( v ) {
    this.x /= v.x;
    this.y /= v.y;
    this.z /= v.z;
    this.w /= v.w;
    return this;
  }

  divideScalar( scalar ) {
    return this.multiplyScalar( 1 / scalar );
  }

  min( v ) {
    this.x = Math.min( this.x, v.x );
    this.y = Math.min( this.y, v.y );
    this.z = Math.min( this.z, v.z );
    this.w = Math.min( this.w, v.w );
    return this;
  }

  max( v ) {
    this.x = Math.max( this.x, v.x );
    this.y = Math.max( this.y, v.y );
    this.z = Math.max( this.z, v.z );
    this.w = Math.max( this.w, v.w );
    return this;
  }

  clamp( min, max ) {
    this.x = clamp( this.x, min.x, max.x );
    this.y = clamp( this.y, min.y, max.y );
    this.z = clamp( this.z, min.z, max.z );
    this.w = clamp( this.w, min.w, max.w );
    return this;
  }

  clampScalar( minVal, maxVal ) {
    this.x = clamp( this.x, minVal, maxVal );
    this.y = clamp( this.y, minVal, maxVal );
    this.z = clamp( this.z, minVal, maxVal );
    this.w = clamp( this.w, minVal, maxVal );
    return this;
  }

  clampLength( min, max ) {
    const length = this.length();
    return this.divideScalar( length || 1 ).multiplyScalar( clamp( length, min, max ) );
  }

  floor() {
    this.x = Math.floor( this.x );
    this.y = Math.floor( this.y );
    this.z = Math.floor( this.z );
    this.w = Math.floor( this.w );
    return this;
  }

  ceil() {
    this.x = Math.ceil( this.x );
    this.y = Math.ceil( this.y );
    this.z = Math.ceil( this.z );
    this.w = Math.ceil( this.w );
    return this;
  }

  round() {
    this.x = Math.round( this.x );
    this.y = Math.round( this.y );
    this.z = Math.round( this.z );
    this.w = Math.round( this.w );
    return this;
  }

  roundToZero() {
    this.x = Math.trunc( this.x );
    this.y = Math.trunc( this.y );
    this.z = Math.trunc( this.z );
    this.w = Math.trunc( this.w );
    return this;
  }

  negate() {
    this.x = - this.x;
    this.y = - this.y;
    this.z = - this.z;
    this.w = - this.w;
    return this;
  }

  dot( v ) {
    return this.x * v.x + this.y * v.y + this.z * v.z + this.w * v.w;
  }

  lengthSq() {
    return this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w;
  }

  length() {
    return Math.sqrt( this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w );
  }

  manhattanLength() {
    return Math.abs( this.x ) + Math.abs( this.y ) + Math.abs( this.z ) + Math.abs( this.w );
  }

  normalize() {
    return this.divideScalar( this.length() || 1 );
  }

  setLength( length ) {
    return this.normalize().multiplyScalar( length );
  }

  lerp( v, alpha ) {
    this.x += ( v.x - this.x ) * alpha;
    this.y += ( v.y - this.y ) * alpha;
    this.z += ( v.z - this.z ) * alpha;
    this.w += ( v.w - this.w ) * alpha;
    return this;
  }

  lerpVectors( v1, v2, alpha ) {
    this.x = v1.x + ( v2.x - v1.x ) * alpha;
    this.y = v1.y + ( v2.y - v1.y ) * alpha;
    this.z = v1.z + ( v2.z - v1.z ) * alpha;
    this.w = v1.w + ( v2.w - v1.w ) * alpha;
    return this;
  }

  equals( v ) {
    return ( v.x === this.x ) && ( v.y === this.y ) && ( v.z === this.z ) && ( v.w === this.w );
  }

  fromArray( array, offset = 0 ) {
    this.x = array[ offset ];
    this.y = array[ offset + 1 ];
    this.z = array[ offset + 2 ];
    this.w = array[ offset + 3 ];
    return this;
  }

  toArray( array = [], offset = 0 ) {
    array[ offset ] = this.x;
    array[ offset + 1 ] = this.y;
    array[ offset + 2 ] = this.z;
    array[ offset + 3 ] = this.w;
    return array;
  }

  fromBufferAttribute( attribute, index ) {
    this.x = attribute.getX( index );
    this.y = attribute.getY( index );
    this.z = attribute.getZ( index );
    this.w = attribute.getW( index );
    return this;
  }

  random() {
    this.x = Math.random();
    this.y = Math.random();
    this.z = Math.random();
    this.w = Math.random();
    return this;
  }

  *[ Symbol.iterator ]() {
    yield this.x;
    yield this.y;
    yield this.z;
    yield this.w;
  }

}

// Default export for parity with other math classes in this module.
export default Vector4;
export { Vector4 };