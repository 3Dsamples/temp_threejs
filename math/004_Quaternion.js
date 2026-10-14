// file number : 004
// full path name : src/math/004_Quaternion.js
// description : Quaternion class (THREE.Quaternion) with method chaining, plus full zero-allocation bridge functions to/from gl-matrix quat (Float32Array of length 4) and bitecs 0.4.0 SoA components (separate x/y/z/w Float32Arrays indexed by entity id). Adds high-precision double.js helpers (preciseDot, preciseLength, preciseAngleTo) and a seeded simplex-noise rotation-field helper setFromNoise3D.
// best for  :  Rotations, orientation, slerp-based animation, camera look-at, physics-driven angular motion, ECS-driven rotation components that must be copied into Object3D.quaternion without allocating per frame.
// license : MIT

import { clamp, lerp } from './MathUtils.js';

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const { quat: glQuat } = glMatrix;

/*
 * -----------------------------------------------------------------------------
 * BITECS 0.4.0 COMPONENT DEFINITION (SoA, archetype-friendly, cache-friendly)
 * -----------------------------------------------------------------------------
 * Quaternion is stored as four independent Float32Arrays indexed by entity id.
 * Systems read/write store.x[eid], store.y[eid], store.z[eid], store.w[eid]
 * directly — no temporary quat object, no per-entity allocation, no GC churn.
 */
export const QuaternionComponent = defineComponent( {
  x: Types.f32,
  y: Types.f32,
  z: Types.f32,
  w: Types.f32
} );

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix quat  <->  THREE.Quaternion
 * -----------------------------------------------------------------------------
 * gl-matrix writes into a Float32Array out param of length 4 in the order
 * [x, y, z, w]. We mirror that contract exactly. The THREE side always writes
 * into a preallocated THREE.Quaternion (the `out` argument), never returns a
 * fresh instance, so hot loops stay allocation-free.
 */

// gl-matrix quat (Float32Array len 4: x,y,z,w) -> preallocated THREE.Quaternion
export function threeQuatFromGlMatrix( out, glQ ) {
  out.x = glQ[ 0 ];
  out.y = glQ[ 1 ];
  out.z = glQ[ 2 ];
  out.w = glQ[ 3 ];
  return out;
}

// THREE.Quaternion -> preallocated gl-matrix quat (Float32Array len 4)
export function glMatrixQuatFromThree( out, threeQ ) {
  out[ 0 ] = threeQ.x;
  out[ 1 ] = threeQ.y;
  out[ 2 ] = threeQ.z;
  out[ 3 ] = threeQ.w;
  return out;
}

// gl-matrix quat -> write directly into a bitecs entity's SoA component
export function bitecsQuatFromGlMatrix( eid, glQ, store = QuaternionComponent ) {
  store.x[ eid ] = glQ[ 0 ];
  store.y[ eid ] = glQ[ 1 ];
  store.z[ eid ] = glQ[ 2 ];
  store.w[ eid ] = glQ[ 3 ];
  return eid;
}

// bitecs entity SoA component -> preallocated gl-matrix quat (Float32Array len 4)
export function glMatrixQuatFromBitecs( out, eid, store = QuaternionComponent ) {
  out[ 0 ] = store.x[ eid ];
  out[ 1 ] = store.y[ eid ];
  out[ 2 ] = store.z[ eid ];
  out[ 3 ] = store.w[ eid ];
  return out;
}

// bitecs entity SoA component -> preallocated THREE.Quaternion (no temp quat)
export function threeQuatFromBitecs( out, eid, store = QuaternionComponent ) {
  out.x = store.x[ eid ];
  out.y = store.y[ eid ];
  out.z = store.z[ eid ];
  out.w = store.w[ eid ];
  return out;
}

// THREE.Quaternion -> write directly into a bitecs entity's SoA component
export function bitecsQuatFromThree( eid, threeQ, store = QuaternionComponent ) {
  store.x[ eid ] = threeQ.x;
  store.y[ eid ] = threeQ.y;
  store.z[ eid ] = threeQ.z;
  store.w[ eid ] = threeQ.w;
  return eid;
}

// Multiply two bitecs SoA quaternions -> preallocated THREE.Quaternion.
export function threeQuatFromBitecsMultiply( out, eidA, eidB, storeA = QuaternionComponent, storeB = QuaternionComponent ) {
  const ax = storeA.x[ eidA ], ay = storeA.y[ eidA ], az = storeA.z[ eidA ], aw = storeA.w[ eidA ];
  const bx = storeB.x[ eidB ], by = storeB.y[ eidB ], bz = storeB.z[ eidB ], bw = storeB.w[ eidB ];
  out.x = ax * bw + aw * bx + ay * bz - az * by;
  out.y = ay * bw + aw * by + az * bx - ax * bz;
  out.z = az * bw + aw * bz + ax * by - ay * bx;
  out.w = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

// Multiply two bitecs SoA quaternions -> dst entity's SoA store (in-place SoA).
export function bitecsQuatMultiplyInto( eidOut, eidA, eidB, storeA = QuaternionComponent, storeB = QuaternionComponent, storeOut = storeA ) {
  const ax = storeA.x[ eidA ], ay = storeA.y[ eidA ], az = storeA.z[ eidA ], aw = storeA.w[ eidA ];
  const bx = storeB.x[ eidB ], by = storeB.y[ eidB ], bz = storeB.z[ eidB ], bw = storeB.w[ eidB ];
  storeOut.x[ eidOut ] = ax * bw + aw * bx + ay * bz - az * by;
  storeOut.y[ eidOut ] = ay * bw + aw * by + az * bx - ax * bz;
  storeOut.z[ eidOut ] = az * bw + aw * bz + ax * by - ay * bx;
  storeOut.w[ eidOut ] = aw * bw - ax * bx - ay * by - az * bz;
  return eidOut;
}

// Normalize a bitecs SoA quaternion in place (degenerate -> identity).
export function bitecsQuatNormalizeInPlace( eid, store = QuaternionComponent ) {
  const x = store.x[ eid ], y = store.y[ eid ], z = store.z[ eid ], w = store.w[ eid ];
  let len = Math.sqrt( x * x + y * y + z * z + w * w );
  if ( len === 0 ) {
    store.x[ eid ] = 0; store.y[ eid ] = 0; store.z[ eid ] = 0; store.w[ eid ] = 1;
  } else {
    len = 1 / len;
    store.x[ eid ] = x * len;
    store.y[ eid ] = y * len;
    store.z[ eid ] = z * len;
    store.w[ eid ] = w * len;
  }
  return eid;
}

// Conjugate a bitecs SoA quaternion in place.
export function bitecsQuatConjugateInPlace( eid, store = QuaternionComponent ) {
  store.x[ eid ] = - store.x[ eid ];
  store.y[ eid ] = - store.y[ eid ];
  store.z[ eid ] = - store.z[ eid ];
  return eid;
}

// Invert a bitecs SoA quaternion in place (assumes normalized).
export function bitecsQuatInvertInPlace( eid, store = QuaternionComponent ) {
  store.x[ eid ] = - store.x[ eid ];
  store.y[ eid ] = - store.y[ eid ];
  store.z[ eid ] = - store.z[ eid ];
  return eid;
}

// Dot product of two bitecs SoA quaternions.
export function bitecsQuatDot( eidA, eidB, storeA = QuaternionComponent, storeB = QuaternionComponent ) {
  return storeA.x[ eidA ] * storeB.x[ eidB ] +
    storeA.y[ eidA ] * storeB.y[ eidB ] +
    storeA.z[ eidA ] * storeB.z[ eidB ] +
    storeA.w[ eidA ] * storeB.w[ eidB ];
}

// Spherical linear interpolation between two bitecs quaternions -> preallocated THREE.Quaternion.
export function threeQuatFromBitecsSlerp( out, eidA, eidB, t, storeA = QuaternionComponent, storeB = QuaternionComponent ) {
  const a = _scratchQuatA;
  const b = _scratchQuatB;
  a[ 0 ] = storeA.x[ eidA ]; a[ 1 ] = storeA.y[ eidA ]; a[ 2 ] = storeA.z[ eidA ]; a[ 3 ] = storeA.w[ eidA ];
  b[ 0 ] = storeB.x[ eidB ]; b[ 1 ] = storeB.y[ eidB ]; b[ 2 ] = storeB.z[ eidB ]; b[ 3 ] = storeB.w[ eidB ];
  glQuat.slerp( _scratchQuatOut, a, b, t );
  out.x = _scratchQuatOut[ 0 ];
  out.y = _scratchQuatOut[ 1 ];
  out.z = _scratchQuatOut[ 2 ];
  out.w = _scratchQuatOut[ 3 ];
  return out;
}

// Spherical linear interpolation between two bitecs quaternions -> dst entity SoA.
export function bitecsQuatSlerpInto( eidOut, eidA, eidB, t, storeA = QuaternionComponent, storeB = QuaternionComponent, storeOut = storeA ) {
  const a = _scratchQuatA;
  const b = _scratchQuatB;
  a[ 0 ] = storeA.x[ eidA ]; a[ 1 ] = storeA.y[ eidA ]; a[ 2 ] = storeA.z[ eidA ]; a[ 3 ] = storeA.w[ eidA ];
  b[ 0 ] = storeB.x[ eidB ]; b[ 1 ] = storeB.y[ eidB ]; b[ 2 ] = storeB.z[ eidB ]; b[ 3 ] = storeB.w[ eidB ];
  glQuat.slerp( _scratchQuatOut, a, b, t );
  storeOut.x[ eidOut ] = _scratchQuatOut[ 0 ];
  storeOut.y[ eidOut ] = _scratchQuatOut[ 1 ];
  storeOut.z[ eidOut ] = _scratchQuatOut[ 2 ];
  storeOut.w[ eidOut ] = _scratchQuatOut[ 3 ];
  return eidOut;
}

// gl-matrix quat slerp -> out, reading directly from two bitecs entities.
export function glMatrixQuatSlerpFromBitecs( out, eidA, eidB, t, storeA = QuaternionComponent, storeB = QuaternionComponent ) {
  const a = _scratchQuatA;
  const b = _scratchQuatB;
  a[ 0 ] = storeA.x[ eidA ]; a[ 1 ] = storeA.y[ eidA ]; a[ 2 ] = storeA.z[ eidA ]; a[ 3 ] = storeA.w[ eidA ];
  b[ 0 ] = storeB.x[ eidB ]; b[ 1 ] = storeB.y[ eidB ]; b[ 2 ] = storeB.z[ eidB ]; b[ 3 ] = storeB.w[ eidB ];
  return glQuat.slerp( out, a, b, t );
}

// gl-matrix quat from axis-angle -> write into a bitecs entity's SoA store.
export function bitecsQuatFromGlMatrixAxisAngle( eid, glAxis, angle, store = QuaternionComponent ) {
  glQuat.setAxisAngle( _scratchQuatOut, glAxis, angle );
  store.x[ eid ] = _scratchQuatOut[ 0 ];
  store.y[ eid ] = _scratchQuatOut[ 1 ];
  store.z[ eid ] = _scratchQuatOut[ 2 ];
  store.w[ eid ] = _scratchQuatOut[ 3 ];
  return eid;
}

// gl-matrix quat from Euler -> write into a bitecs entity's SoA store.
// gl-matrix's fromEuler uses ZYX intrinsic order and expects radians. Callers
// who need a different order should go through THREE.Quaternion.setFromEuler.
export function bitecsQuatFromGlMatrixEuler( eid, x, y, z, store = QuaternionComponent ) {
  glQuat.fromEuler( _scratchQuatOut, x, y, z );
  store.x[ eid ] = _scratchQuatOut[ 0 ];
  store.y[ eid ] = _scratchQuatOut[ 1 ];
  store.z[ eid ] = _scratchQuatOut[ 2 ];
  store.w[ eid ] = _scratchQuatOut[ 3 ];
  return eid;
}

// Rotate a bitecs SoA vec3 (three-component store) by a bitecs SoA quaternion -> preallocated THREE.Vector3.
export function threeVec3FromBitecsQuatRotate( out, eidV, eidQ, storeV, storeQ = QuaternionComponent ) {
  const x = storeV.x[ eidV ], y = storeV.y[ eidV ], z = storeV.z[ eidV ];
  const qx = storeQ.x[ eidQ ], qy = storeQ.y[ eidQ ], qz = storeQ.z[ eidQ ], qw = storeQ.w[ eidQ ];
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = - qx * x - qy * y - qz * z;
  out.x = ix * qw + iw * - qx + iy * - qz - iz * - qy;
  out.y = iy * qw + iw * - qy + iz * - qx - ix * - qz;
  out.z = iz * qw + iw * - qz + ix * - qy - iy * - qx;
  return out;
}

// Rotate a bitecs SoA vec3 (three-component store) by a bitecs SoA quaternion -> dst entity SoA.
export function bitecsVec3QuatRotateInto( eidOutV, eidV, eidQ, storeV, storeQ = QuaternionComponent, storeOutV = storeV ) {
  const x = storeV.x[ eidV ], y = storeV.y[ eidV ], z = storeV.z[ eidV ];
  const qx = storeQ.x[ eidQ ], qy = storeQ.y[ eidQ ], qz = storeQ.z[ eidQ ], qw = storeQ.w[ eidQ ];
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = - qx * x - qy * y - qz * z;
  storeOutV.x[ eidOutV ] = ix * qw + iw * - qx + iy * - qz - iz * - qy;
  storeOutV.y[ eidOutV ] = iy * qw + iw * - qy + iz * - qx - ix * - qz;
  storeOutV.z[ eidOutV ] = iz * qw + iw * - qz + ix * - qy - iy * - qx;
  return eidOutV;
}

/*
 * -----------------------------------------------------------------------------
 * HIGH-PRECISION HELPERS (double.js)
 * -----------------------------------------------------------------------------
 * double.js's Double type carries ~106 bits of mantissa. These helpers evaluate
 * quaternion dot / length / angle without the cancellation that hits the f64
 * path when the two quaternions are nearly antipodal or nearly identical.
 */

function _toDouble( value ) {
  return new Double( value );
}

// Returns q.x*v.x + q.y*v.y + q.z*v.z + q.w*v.w in double-double precision.
export function preciseDot( q, v ) {
  const dx = _toDouble( q.x ).mul( _toDouble( v.x ) );
  const dy = _toDouble( q.y ).mul( _toDouble( v.y ) );
  const dz = _toDouble( q.z ).mul( _toDouble( v.z ) );
  const dw = _toDouble( q.w ).mul( _toDouble( v.w ) );
  return dx.add( dy ).add( dz ).add( dw ).toNumber();
}

// Returns sqrt(q.x^2 + q.y^2 + q.z^2 + q.w^2) in double-double precision.
export function preciseLength( q ) {
  const dx = _toDouble( q.x );
  const dy = _toDouble( q.y );
  const dz = _toDouble( q.z );
  const dw = _toDouble( q.w );
  return dx.mul( dx ).add( dy.mul( dy ) ).add( dz.mul( dz ) ).add( dw.mul( dw ) ).sqrt().toNumber();
}

// Returns the angle between two quaternions in double-double precision.
// Matches THREE.Quaternion.angleTo's formula: 2 * acos(|dot|).
export function preciseAngleTo( a, b ) {
  const dot = preciseDot( a, b );
  const absDot = dot < 0 ? - dot : dot;
  const clamped = absDot > 1 ? 1 : absDot;
  return 2 * Math.acos( clamp( clamped, - 1, 1 ) );
}

/*
 * -----------------------------------------------------------------------------
 * PROCEDURAL NOISE (simplex-noise)
 * -----------------------------------------------------------------------------
 * A cached 3D simplex-noise generator per seed. The generator is built lazily
 * on first use so the permutation table is only allocated when noise is
 * sampled. setFromNoise3D builds a valid unit quaternion from three noise
 * samples via the standard Sh oemake-style sphere-to-quaternion mapping.
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

const _noise3DCache = new Map();

function _cachedNoise3D( seed ) {
  let gen = _noise3DCache.get( seed );
  if ( gen === undefined ) {
    gen = createNoise3D( _mulberry32( seed ) );
    _noise3DCache.set( seed, gen );
  }
  return gen;
}

// Set out from a 3D simplex field sampled at (x, y, z) with the given seed.
// Uses the (u1, u2, u3) -> unit quaternion mapping so the result is always a
// valid rotation regardless of the sampled values.
export function setFromNoise3D( out, x, y, z, seed = 0 ) {
  const n = _cachedNoise3D( seed );
  // Map three noise samples from [-1, 1] to [0, 1] to use as uniform inputs.
  const u1 = ( n( x, y, z ) + 1 ) * 0.5;
  const u2 = ( n( x + 31.416, y + 47.853, z + 12.793 ) + 1 ) * 0.5;
  const u3 = ( n( x - 17.234, y - 53.127, z - 91.056 ) + 1 ) * 0.5;
  const sqrt1u1 = Math.sqrt( 1 - u1 );
  const sqrtu1 = Math.sqrt( u1 );
  const u2twopi = 2 * Math.PI * u2;
  const u3twopi = 2 * Math.PI * u3;
  out.x = sqrt1u1 * Math.cos( u2twopi );
  out.y = sqrtu1 * Math.sin( u3twopi );
  out.z = sqrtu1 * Math.cos( u3twopi );
  out.w = sqrt1u1 * Math.sin( u2twopi );
  return out;
}

// Drop every cached noise generator.
export function disposeNoise3DCache() {
  _noise3DCache.clear();
}

// Module-local scratch buffers — allocated once, reused across every bridge.
const _scratchQuatA = new Float32Array( 4 );
const _scratchQuatB = new Float32Array( 4 );
const _scratchQuatOut = new Float32Array( 4 );

/*
 * -----------------------------------------------------------------------------
 * THREE.Quaternion
 * -----------------------------------------------------------------------------
 */
class Quaternion {

  constructor( x = 0, y = 0, z = 0, w = 1 ) {
    Quaternion.prototype.isQuaternion = true;
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }

  set( x, y, z, w ) {
    if ( w === undefined ) w = this.w;
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }

  clone() {
    return new this.constructor( this.x, this.y, this.z, this.w );
  }

  copy( quaternion ) {
    this.x = quaternion.x;
    this.y = quaternion.y;
    this.z = quaternion.z;
    this.w = quaternion.w;
    return this;
  }

  setFromEuler( euler, update = true ) {
    const x = euler._x, y = euler._y, z = euler._z, order = euler._order;

    const cos = Math.cos;
    const sin = Math.sin;

    const c1 = cos( x / 2 );
    const c2 = cos( y / 2 );
    const c3 = cos( z / 2 );

    const s1 = sin( x / 2 );
    const s2 = sin( y / 2 );
    const s3 = sin( z / 2 );

    switch ( order ) {
      case 'XYZ':
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        break;
      case 'YXZ':
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 - s1 * s2 * c3;
        this.w = c1 * c2 * c3 + s1 * s2 * s3;
        break;
      case 'ZXY':
        this.x = s1 * c2 * c3 - c1 * s2 * s3;
        this.y = c1 * s2 * c3 + s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        break;
      case 'ZYX':
        this.x = s1 * c2 * c3 - c1 * s2 * s3;
        this.y = c1 * s2 * c3 + s1 * c2 * s3;
        this.z = c1 * c2 * s3 - s1 * s2 * c3;
        this.w = c1 * c2 * c3 + s1 * s2 * s3;
        break;
      case 'YZX':
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 + s1 * c2 * s3;
        this.z = c1 * c2 * s3 - s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        break;
      case 'XZY':
        this.x = s1 * c2 * c3 - c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 + s1 * s2 * s3;
        break;
      default:
        console.warn( 'THREE.Quaternion: .setFromEuler() encountered an unknown order: ' + order );
    }

    if ( update === true ) _onChangeCallback();
    return this;
  }

  setFromAxisAngle( axis, angle ) {
    const halfAngle = angle / 2, s = Math.sin( halfAngle );
    this.x = axis.x * s;
    this.y = axis.y * s;
    this.z = axis.z * s;
    this.w = Math.cos( halfAngle );
    _onChangeCallback();
    return this;
  }

  setFromRotationMatrix( m ) {
    const te = m.elements,
      m11 = te[ 0 ], m12 = te[ 4 ], m13 = te[ 8 ],
      m21 = te[ 1 ], m22 = te[ 5 ], m23 = te[ 9 ],
      m31 = te[ 2 ], m32 = te[ 6 ], m33 = te[ 10 ],
      trace = m11 + m22 + m33;

    if ( trace > 0 ) {
      const s = 0.5 / Math.sqrt( trace + 1.0 );
      this.w = 0.25 / s;
      this.x = ( m32 - m23 ) * s;
      this.y = ( m13 - m31 ) * s;
      this.z = ( m21 - m12 ) * s;
    } else if ( m11 > m22 && m11 > m33 ) {
      const s = 2.0 * Math.sqrt( 1.0 + m11 - m22 - m33 );
      this.w = ( m32 - m23 ) / s;
      this.x = 0.25 * s;
      this.y = ( m12 + m21 ) / s;
      this.z = ( m13 + m31 ) / s;
    } else if ( m22 > m33 ) {
      const s = 2.0 * Math.sqrt( 1.0 + m22 - m11 - m33 );
      this.w = ( m13 - m31 ) / s;
      this.x = ( m12 + m21 ) / s;
      this.y = 0.25 * s;
      this.z = ( m23 + m32 ) / s;
    } else {
      const s = 2.0 * Math.sqrt( 1.0 + m33 - m11 - m22 );
      this.w = ( m21 - m12 ) / s;
      this.x = ( m13 + m31 ) / s;
      this.y = ( m23 + m32 ) / s;
      this.z = 0.25 * s;
    }

    _onChangeCallback();
    return this;
  }

  setFromUnitVectors( vFrom, vTo ) {
    let r = vFrom.dot( vTo ) + 1;

    if ( r < Number.EPSILON ) {
      r = 0;
      if ( Math.abs( vFrom.x ) > Math.abs( vFrom.z ) ) {
        this.x = - vFrom.y;
        this.y = vFrom.x;
        this.z = 0;
        this.w = r;
      } else {
        this.x = 0;
        this.y = - vFrom.z;
        this.z = vFrom.y;
        this.w = r;
      }
    } else {
      this.x = vFrom.y * vTo.z - vFrom.z * vTo.y;
      this.y = vFrom.z * vTo.x - vFrom.x * vTo.z;
      this.z = vFrom.x * vTo.y - vFrom.y * vTo.x;
      this.w = r;
    }

    return this.normalize();
  }

  angleTo( q ) {
    return 2 * Math.acos( Math.abs( clamp( this.dot( q ), - 1, 1 ) ) );
  }

  rotateTowards( q, step ) {
    const angle = this.angleTo( q );

    if ( angle === 0 ) return this;

    const t = Math.min( 1, step / angle );

    this.slerp( q, t );

    return this;
  }

  identity() {
    return this.set( 0, 0, 0, 1 );
  }

  invert() {
    return this.conjugate();
  }

  conjugate() {
    this.x *= - 1;
    this.y *= - 1;
    this.z *= - 1;
    _onChangeCallback();
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

  normalize() {
    let l = this.length();

    if ( l === 0 ) {
      this.x = 0;
      this.y = 0;
      this.z = 0;
      this.w = 1;
    } else {
      l = 1 / l;
      this.x = this.x * l;
      this.y = this.y * l;
      this.z = this.z * l;
      this.w = this.w * l;
    }

    _onChangeCallback();
    return this;
  }

  multiply( q ) {
    return this.multiplyQuaternions( this, q );
  }

  premultiply( q ) {
    return this.multiplyQuaternions( q, this );
  }

  multiplyQuaternions( a, b ) {
    const qax = a.x, qay = a.y, qaz = a.z, qaw = a.w;
    const qbx = b.x, qby = b.y, qbz = b.z, qbw = b.w;

    this.x = qax * qbw + qaw * qbx + qay * qbz - qaz * qby;
    this.y = qay * qbw + qaw * qby + qaz * qbx - qax * qbz;
    this.z = qaz * qbw + qaw * qbz + qax * qby - qay * qbx;
    this.w = qaw * qbw - qax * qbx - qay * qby - qaz * qbz;

    _onChangeCallback();
    return this;
  }

  slerp( qb, t ) {
    if ( t === 0 ) return this;
    if ( t === 1 ) return this.copy( qb );

    const x = this.x, y = this.y, z = this.z, w = this.w;

    let cosHalfTheta = w * qb.w + x * qb.x + y * qb.y + z * qb.z;

    if ( cosHalfTheta < 0 ) {
      this.w = - qb.w;
      this.x = - qb.x;
      this.y = - qb.y;
      this.z = - qb.z;
      cosHalfTheta = - cosHalfTheta;
    } else {
      this.copy( qb );
    }

    if ( cosHalfTheta >= 1.0 ) {
      this.w = w;
      this.x = x;
      this.y = y;
      this.z = z;
      return this;
    }

    const sqrSinHalfTheta = 1.0 - cosHalfTheta * cosHalfTheta;

    if ( sqrSinHalfTheta <= Number.EPSILON ) {
      const s = 1 - t;
      this.w = s * w + t * this.w;
      this.x = s * x + t * this.x;
      this.y = s * y + t * this.y;
      this.z = s * z + t * this.z;
      this.normalize();
      _onChangeCallback();
      return this;
    }

    const sinHalfTheta = Math.sqrt( sqrSinHalfTheta );
    const halfTheta = Math.atan2( sinHalfTheta, cosHalfTheta );
    const ratioA = Math.sin( ( 1 - t ) * halfTheta ) / sinHalfTheta;
    const ratioB = Math.sin( t * halfTheta ) / sinHalfTheta;

    this.w = ( w * ratioA + this.w * ratioB );
    this.x = ( x * ratioA + this.x * ratioB );
    this.y = ( y * ratioA + this.y * ratioB );
    this.z = ( z * ratioA + this.z * ratioB );

    _onChangeCallback();
    return this;
  }

  slerpQuaternions( qa, qb, t ) {
    return this.copy( qa ).slerp( qb, t );
  }

  random() {
    const u1 = Math.random();
    const sqrt1u1 = Math.sqrt( 1 - u1 );
    const sqrtu1 = Math.sqrt( u1 );
    const u2 = 2 * Math.PI * Math.random();
    const u3 = 2 * Math.PI * Math.random();
    return this.set(
      sqrt1u1 * Math.cos( u2 ),
      sqrtu1 * Math.sin( u3 ),
      sqrtu1 * Math.cos( u3 ),
      sqrt1u1 * Math.sin( u2 ),
    );
  }

  equals( quaternion ) {
    return ( quaternion.x === this.x ) && ( quaternion.y === this.y ) && ( quaternion.z === this.z ) && ( quaternion.w === this.w );
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

  _onChange( callback ) {
    _onChangeCallback = callback;
    return this;
  }

  *[ Symbol.iterator ]() {
    yield this.x;
    yield this.y;
    yield this.z;
    yield this.w;
  }

}

// `_onChangeCallback` must be declared before the class body executes so the
// methods can safely reference it during module evaluation.
let _onChangeCallback = () => {};

export { Quaternion };