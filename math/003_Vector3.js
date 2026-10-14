// file number : 003
// full path name : src/math/003_Vector3.js
// description : 3D vector class (THREE.Vector3) with method chaining, plus full zero-allocation bridge functions to/from gl-matrix vec3 (Float32Array of length 3) and bitecs 0.4.0 SoA components (separate x/y/z Float32Arrays indexed by entity id). Adds high-precision double.js helpers (preciseLength, preciseDistanceTo, preciseLerpInto) and a seeded simplex-noise setFromNoise3D helper. applyEuler and applyAxisAngle are implemented with inline quaternion math so the file stays free of circular Quaternion imports while actually producing correct rotations.
// best for  :  Position, direction, normal, scale, velocity, force, ray, and every 3D transform in the engine. Also the canonical bridge target for ECS systems that must move SoA data into scene-graph objects without allocating per frame.
// license : MIT

import { clamp } from './MathUtils.js';

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const { vec3: glVec3 } = glMatrix;

/*
 * -----------------------------------------------------------------------------
 * BITECS 0.4.0 COMPONENT DEFINITION (SoA, archetype-friendly, cache-friendly)
 * -----------------------------------------------------------------------------
 * Vector3 is stored as three independent Float32Arrays indexed by entity id.
 * Systems read/write store.x[eid], store.y[eid], store.z[eid] directly — no
 * temporary vec3 object, no per-entity allocation, no per-frame garbage.
 */
export const Vector3Component = defineComponent( {
  x: Types.f32,
  y: Types.f32,
  z: Types.f32
} );

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix vec3  <->  THREE.Vector3
 * -----------------------------------------------------------------------------
 * gl-matrix always writes into an `out` Float32Array; we mirror that contract.
 * The THREE side always writes into a preallocated THREE.Vector3 (the `out`
 * argument), never returns a fresh instance, so hot loops stay allocation-free.
 */

// gl-matrix vec3 (Float32Array len 3) -> preallocated THREE.Vector3
export function threeVec3FromGlMatrix( out, glVec ) {
  out.x = glVec[ 0 ];
  out.y = glVec[ 1 ];
  out.z = glVec[ 2 ];
  return out;
}

// THREE.Vector3 -> preallocated gl-matrix vec3 (Float32Array len 3)
export function glMatrixVec3FromThree( out, threeVec ) {
  out[ 0 ] = threeVec.x;
  out[ 1 ] = threeVec.y;
  out[ 2 ] = threeVec.z;
  return out;
}

// gl-matrix vec3 -> write directly into a bitecs entity's SoA component
export function bitecsVec3FromGlMatrix( eid, glVec, store = Vector3Component ) {
  store.x[ eid ] = glVec[ 0 ];
  store.y[ eid ] = glVec[ 1 ];
  store.z[ eid ] = glVec[ 2 ];
  return eid;
}

// bitecs entity SoA component -> preallocated gl-matrix vec3 (Float32Array len 3)
export function glMatrixVec3FromBitecs( out, eid, store = Vector3Component ) {
  out[ 0 ] = store.x[ eid ];
  out[ 1 ] = store.y[ eid ];
  out[ 2 ] = store.z[ eid ];
  return out;
}

// bitecs entity SoA component -> preallocated THREE.Vector3 (no temp vec3)
export function threeVec3FromBitecs( out, eid, store = Vector3Component ) {
  out.x = store.x[ eid ];
  out.y = store.y[ eid ];
  out.z = store.z[ eid ];
  return out;
}

// THREE.Vector3 -> write directly into a bitecs entity's SoA component
export function bitecsVec3FromThree( eid, threeVec, store = Vector3Component ) {
  store.x[ eid ] = threeVec.x;
  store.y[ eid ] = threeVec.y;
  store.z[ eid ] = threeVec.z;
  return eid;
}

// bitecs SoA (A + B) -> preallocated THREE.Vector3, no temp vec3 allocation
export function threeVec3FromBitecsAdd( out, eid, storeA, storeB ) {
  out.x = storeA.x[ eid ] + storeB.x[ eid ];
  out.y = storeA.y[ eid ] + storeB.y[ eid ];
  out.z = storeA.z[ eid ] + storeB.z[ eid ];
  return out;
}

// bitecs SoA (A - B) -> preallocated THREE.Vector3
export function threeVec3FromBitecsSub( out, eid, storeA, storeB ) {
  out.x = storeA.x[ eid ] - storeB.x[ eid ];
  out.y = storeA.y[ eid ] - storeB.y[ eid ];
  out.z = storeA.z[ eid ] - storeB.z[ eid ];
  return out;
}

// Read two SoA stores and write their sum into a third entity in the dst store.
export function bitecsVec3AddInto( eidOut, eidA, eidB, storeA, storeB, storeOut = storeA ) {
  storeOut.x[ eidOut ] = storeA.x[ eidA ] + storeB.x[ eidB ];
  storeOut.y[ eidOut ] = storeA.y[ eidA ] + storeB.y[ eidB ];
  storeOut.z[ eidOut ] = storeA.z[ eidA ] + storeB.z[ eidB ];
  return eidOut;
}

// Read two SoA stores and write their difference into a third entity in dst store.
export function bitecsVec3SubInto( eidOut, eidA, eidB, storeA, storeB, storeOut = storeA ) {
  storeOut.x[ eidOut ] = storeA.x[ eidA ] - storeB.x[ eidB ];
  storeOut.y[ eidOut ] = storeA.y[ eidA ] - storeB.y[ eidB ];
  storeOut.z[ eidOut ] = storeA.z[ eidA ] - storeB.z[ eidB ];
  return eidOut;
}

// Scale a bitecs SoA component in place by a scalar.
export function bitecsVec3ScaleInPlace( eid, scalar, store = Vector3Component ) {
  store.x[ eid ] *= scalar;
  store.y[ eid ] *= scalar;
  store.z[ eid ] *= scalar;
  return eid;
}

// Normalize a bitecs SoA component in place (zero-length vectors stay zero).
export function bitecsVec3NormalizeInPlace( eid, store = Vector3Component ) {
  const x = store.x[ eid ], y = store.y[ eid ], z = store.z[ eid ];
  const len = Math.sqrt( x * x + y * y + z * z );
  if ( len > 0 ) {
    const inv = 1 / len;
    store.x[ eid ] = x * inv;
    store.y[ eid ] = y * inv;
    store.z[ eid ] = z * inv;
  }
  return eid;
}

// dot(A, B) for two bitecs SoA entities (same or different stores).
export function bitecsVec3Dot( eidA, eidB, storeA = Vector3Component, storeB = Vector3Component ) {
  return storeA.x[ eidA ] * storeB.x[ eidB ] +
    storeA.y[ eidA ] * storeB.y[ eidB ] +
    storeA.z[ eidA ] * storeB.z[ eidB ];
}

// cross(A, B) -> write into a third entity in storeOut (default: storeA).
export function bitecsVec3CrossInto( eidOut, eidA, eidB, storeA = Vector3Component, storeB = Vector3Component, storeOut = storeA ) {
  const ax = storeA.x[ eidA ], ay = storeA.y[ eidA ], az = storeA.z[ eidA ];
  const bx = storeB.x[ eidB ], by = storeB.y[ eidB ], bz = storeB.z[ eidB ];
  storeOut.x[ eidOut ] = ay * bz - az * by;
  storeOut.y[ eidOut ] = az * bx - ax * bz;
  storeOut.z[ eidOut ] = ax * by - ay * bx;
  return eidOut;
}

// Squared distance between two bitecs SoA entities.
export function bitecsVec3DistanceToSquared( eidA, eidB, storeA = Vector3Component, storeB = Vector3Component ) {
  const dx = storeA.x[ eidA ] - storeB.x[ eidB ];
  const dy = storeA.y[ eidA ] - storeB.y[ eidB ];
  const dz = storeA.z[ eidA ] - storeB.z[ eidB ];
  return dx * dx + dy * dy + dz * dz;
}

// Distance between two bitecs SoA entities.
export function bitecsVec3DistanceTo( eidA, eidB, storeA = Vector3Component, storeB = Vector3Component ) {
  return Math.sqrt( bitecsVec3DistanceToSquared( eidA, eidB, storeA, storeB ) );
}

// Linear interpolation between two bitecs SoA entities -> preallocated THREE.Vector3.
export function threeVec3FromBitecsLerp( out, eidA, eidB, alpha, storeA = Vector3Component, storeB = Vector3Component ) {
  out.x = storeA.x[ eidA ] + ( storeB.x[ eidB ] - storeA.x[ eidA ] ) * alpha;
  out.y = storeA.y[ eidA ] + ( storeB.y[ eidB ] - storeA.y[ eidA ] ) * alpha;
  out.z = storeA.z[ eidA ] + ( storeB.z[ eidB ] - storeA.z[ eidA ] ) * alpha;
  return out;
}

// Linear interpolation between two bitecs SoA entities -> dst entity's SoA store.
export function bitecsVec3LerpInto( eidOut, eidA, eidB, alpha, storeA = Vector3Component, storeB = Vector3Component, storeOut = storeA ) {
  storeOut.x[ eidOut ] = storeA.x[ eidA ] + ( storeB.x[ eidB ] - storeA.x[ eidA ] ) * alpha;
  storeOut.y[ eidOut ] = storeA.y[ eidA ] + ( storeB.y[ eidB ] - storeA.y[ eidA ] ) * alpha;
  storeOut.z[ eidOut ] = storeA.z[ eidA ] + ( storeB.z[ eidB ] - storeA.z[ eidA ] ) * alpha;
  return eidOut;
}

// gl-matrix vec3 add -> out, reading directly from two bitecs entities.
export function glMatrixVec3AddFromBitecs( out, eidA, eidB, storeA = Vector3Component, storeB = Vector3Component ) {
  const a = _scratchVec3A;
  const b = _scratchVec3B;
  a[ 0 ] = storeA.x[ eidA ]; a[ 1 ] = storeA.y[ eidA ]; a[ 2 ] = storeA.z[ eidA ];
  b[ 0 ] = storeB.x[ eidB ]; b[ 1 ] = storeB.y[ eidB ]; b[ 2 ] = storeB.z[ eidB ];
  return glVec3.add( out, a, b );
}

// gl-matrix vec3 cross -> out, reading directly from two bitecs entities.
export function glMatrixVec3CrossFromBitecs( out, eidA, eidB, storeA = Vector3Component, storeB = Vector3Component ) {
  const a = _scratchVec3A;
  const b = _scratchVec3B;
  a[ 0 ] = storeA.x[ eidA ]; a[ 1 ] = storeA.y[ eidA ]; a[ 2 ] = storeA.z[ eidA ];
  b[ 0 ] = storeB.x[ eidB ]; b[ 1 ] = storeB.y[ eidB ]; b[ 2 ] = storeB.z[ eidB ];
  return glVec3.cross( out, a, b );
}

// gl-matrix vec3 normalize -> out, reading directly from a bitecs entity.
export function glMatrixVec3NormalizeFromBitecs( out, eid, store = Vector3Component ) {
  const a = _scratchVec3A;
  a[ 0 ] = store.x[ eid ]; a[ 1 ] = store.y[ eid ]; a[ 2 ] = store.z[ eid ];
  return glVec3.normalize( out, a );
}

/*
 * -----------------------------------------------------------------------------
 * HIGH-PRECISION HELPERS (double.js)
 * -----------------------------------------------------------------------------
 * double.js's Double type carries ~106 bits of mantissa. These helpers use it
 * to evaluate length/distance/lerp without the catastrophic cancellation that
 * hits the f64 path at extreme scales (large-world positions, tiny deltas).
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
  return dx.mul( dx ).add( dy.mul( dy ) ).add( dz.mul( dz ) ).sqrt().toNumber();
}

// Returns the distance between a and b in double-double precision.
export function preciseDistanceTo( a, b ) {
  const dx = _toDouble( a.x ).sub( _toDouble( b.x ) );
  const dy = _toDouble( a.y ).sub( _toDouble( b.y ) );
  const dz = _toDouble( a.z ).sub( _toDouble( b.z ) );
  return dx.mul( dx ).add( dy.mul( dy ) ).add( dz.mul( dz ) ).sqrt().toNumber();
}

// High-precision lerp of a and b into out (no cancellation in (1-t)a + tb).
export function preciseLerpInto( out, a, b, t ) {
  const oneMinusT = _oneDouble.sub( _toDouble( t ) );
  const dt = _toDouble( t );
  out.x = _toDouble( a.x ).mul( oneMinusT ).add( _toDouble( b.x ).mul( dt ) ).toNumber();
  out.y = _toDouble( a.y ).mul( oneMinusT ).add( _toDouble( b.y ).mul( dt ) ).toNumber();
  out.z = _toDouble( a.z ).mul( oneMinusT ).add( _toDouble( b.z ).mul( dt ) ).toNumber();
  return out;
}

/*
 * -----------------------------------------------------------------------------
 * PROCEDURAL NOISE (simplex-noise)
 * -----------------------------------------------------------------------------
 * A single cached 3D noise generator per seed. The generator is built lazily on
 * first use so the permutation table is only allocated when noise is sampled.
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

// Set out.x/out.y/out.z from a 3D simplex field sampled at (x, y, z) with seed.
export function setFromNoise3D( out, x, y, z, seed = 0 ) {
  const n = _cachedNoise3D( seed );
  out.x = n( x, y, z );
  out.y = n( x + 31.416, y + 47.853, z + 12.793 );
  out.z = n( x - 17.234, y - 53.127, z - 91.056 );
  return out;
}

// Drop every cached noise generator.
export function disposeNoise3DCache() {
  _noise3DCache.clear();
}

/*
 * -----------------------------------------------------------------------------
 * INLINE QUATERNION MATH
 * -----------------------------------------------------------------------------
 * applyEuler and applyAxisAngle previously delegated to a stub object that
 * simply returned `this`, so both methods were silent no-ops. This version
 * implements the rotation directly, keeping Vector3 free of a Quaternion
 * import (which would create a circular dependency with 004_Quaternion.js).
 */

// Rotate this vector by an Euler-angle-like object with x/y/z/order fields.
// Euler angles are assumed to be in radians. Order defaults to 'XYZ'.
function _applyEulerToVector( v, euler ) {
  const x = euler.x !== undefined ? euler.x : ( euler._x !== undefined ? euler._x : 0 );
  const y = euler.y !== undefined ? euler.y : ( euler._y !== undefined ? euler._y : 0 );
  const z = euler.z !== undefined ? euler.z : ( euler._z !== undefined ? euler._z : 0 );
  const order = euler.order || euler._order || 'XYZ';

  // Build quaternion components directly from Euler angles per order.
  const c1 = Math.cos( x / 2 ), c2 = Math.cos( y / 2 ), c3 = Math.cos( z / 2 );
  const s1 = Math.sin( x / 2 ), s2 = Math.sin( y / 2 ), s3 = Math.sin( z / 2 );
  let qx, qy, qz, qw;
  switch ( order ) {
    case 'XYZ':
      qx = s1 * c2 * c3 + c1 * s2 * s3;
      qy = c1 * s2 * c3 - s1 * c2 * s3;
      qz = c1 * c2 * s3 + s1 * s2 * c3;
      qw = c1 * c2 * c3 - s1 * s2 * s3;
      break;
    case 'YXZ':
      qx = s1 * c2 * c3 + c1 * s2 * s3;
      qy = c1 * s2 * c3 - s1 * c2 * s3;
      qz = c1 * c2 * s3 - s1 * s2 * c3;
      qw = c1 * c2 * c3 + s1 * s2 * s3;
      break;
    case 'ZXY':
      qx = s1 * c2 * c3 - c1 * s2 * s3;
      qy = c1 * s2 * c3 + s1 * c2 * s3;
      qz = c1 * c2 * s3 + s1 * s2 * c3;
      qw = c1 * c2 * c3 - s1 * s2 * s3;
      break;
    case 'ZYX':
      qx = s1 * c2 * c3 - c1 * s2 * s3;
      qy = c1 * s2 * c3 + s1 * c2 * s3;
      qz = c1 * c2 * s3 - s1 * s2 * c3;
      qw = c1 * c2 * c3 + s1 * s2 * s3;
      break;
    case 'YZX':
      qx = s1 * c2 * c3 + c1 * s2 * s3;
      qy = c1 * s2 * c3 + s1 * c2 * s3;
      qz = c1 * c2 * s3 - s1 * s2 * c3;
      qw = c1 * c2 * c3 - s1 * s2 * s3;
      break;
    case 'XZY':
      qx = s1 * c2 * c3 - c1 * s2 * s3;
      qy = c1 * s2 * c3 - s1 * c2 * s3;
      qz = c1 * c2 * s3 + s1 * s2 * c3;
      qw = c1 * c2 * c3 + s1 * s2 * s3;
      break;
    default:
      qx = 0; qy = 0; qz = 0; qw = 1;
  }

  // Apply the quaternion to the vector (v' = q * v * q^-1).
  const vx = v.x, vy = v.y, vz = v.z;
  const ix = qw * vx + qy * vz - qz * vy;
  const iy = qw * vy + qz * vx - qx * vz;
  const iz = qw * vz + qx * vy - qy * vx;
  const iw = - qx * vx - qy * vy - qz * vz;
  v.x = ix * qw + iw * - qx + iy * - qz - iz * - qy;
  v.y = iy * qw + iw * - qy + iz * - qx - ix * - qz;
  v.z = iz * qw + iw * - qz + ix * - qy - iy * - qx;
  return v;
}

// Rotate this vector about an arbitrary unit axis by `angle` radians.
function _applyAxisAngleToVector( v, axis, angle ) {
  const ax = axis.x !== undefined ? axis.x : axis[ 0 ];
  const ay = axis.y !== undefined ? axis.y : axis[ 1 ];
  const az = axis.z !== undefined ? axis.z : axis[ 2 ];

  const halfAngle = angle / 2;
  const s = Math.sin( halfAngle );
  const qx = ax * s;
  const qy = ay * s;
  const qz = az * s;
  const qw = Math.cos( halfAngle );

  const vx = v.x, vy = v.y, vz = v.z;
  const ix = qw * vx + qy * vz - qz * vy;
  const iy = qw * vy + qz * vx - qx * vz;
  const iz = qw * vz + qx * vy - qy * vx;
  const iw = - qx * vx - qy * vy - qz * vz;
  v.x = ix * qw + iw * - qx + iy * - qz - iz * - qy;
  v.y = iy * qw + iw * - qy + iz * - qx - ix * - qz;
  v.z = iz * qw + iw * - qz + ix * - qy - iy * - qx;
  return v;
}

// Module-local scratch buffers — allocated once, reused across every bridge.
const _scratchVec3A = new Float32Array( 3 );
const _scratchVec3B = new Float32Array( 3 );

/*
 * -----------------------------------------------------------------------------
 * THREE.Vector3
 * -----------------------------------------------------------------------------
 */
class Vector3 {

  constructor( x = 0, y = 0, z = 0 ) {
    Vector3.prototype.isVector3 = true;
    this.x = x;
    this.y = y;
    this.z = z;
  }

  set( x, y, z ) {
    if ( z === undefined ) z = this.z;
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  setScalar( scalar ) {
    this.x = scalar;
    this.y = scalar;
    this.z = scalar;
    return this;
  }

  setX( x ) { this.x = x; return this; }
  setY( y ) { this.y = y; return this; }
  setZ( z ) { this.z = z; return this; }

  setComponent( index, value ) {
    switch ( index ) {
      case 0: this.x = value; break;
      case 1: this.y = value; break;
      case 2: this.z = value; break;
      default: throw new Error( 'index is out of range: ' + index );
    }
    return this;
  }

  getComponent( index ) {
    switch ( index ) {
      case 0: return this.x;
      case 1: return this.y;
      case 2: return this.z;
      default: throw new Error( 'index is out of range: ' + index );
    }
  }

  clone() {
    return new this.constructor( this.x, this.y, this.z );
  }

  copy( v ) {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  add( v ) {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }

  addScalar( s ) {
    this.x += s;
    this.y += s;
    this.z += s;
    return this;
  }

  addVectors( a, b ) {
    this.x = a.x + b.x;
    this.y = a.y + b.y;
    this.z = a.z + b.z;
    return this;
  }

  addScaledVector( v, s ) {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }

  sub( v ) {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }

  subScalar( s ) {
    this.x -= s;
    this.y -= s;
    this.z -= s;
    return this;
  }

  subVectors( a, b ) {
    this.x = a.x - b.x;
    this.y = a.y - b.y;
    this.z = a.z - b.z;
    return this;
  }

  multiply( v ) {
    this.x *= v.x;
    this.y *= v.y;
    this.z *= v.z;
    return this;
  }

  multiplyScalar( scalar ) {
    this.x *= scalar;
    this.y *= scalar;
    this.z *= scalar;
    return this;
  }

  multiplyVectors( a, b ) {
    this.x = a.x * b.x;
    this.y = a.y * b.y;
    this.z = a.z * b.z;
    return this;
  }

  applyEuler( euler ) {
    return _applyEulerToVector( this, euler );
  }

  applyAxisAngle( axis, angle ) {
    return _applyAxisAngleToVector( this, axis, angle );
  }

  applyMatrix3( m ) {
    const x = this.x, y = this.y, z = this.z;
    const e = m.elements;
    this.x = e[ 0 ] * x + e[ 3 ] * y + e[ 6 ] * z;
    this.y = e[ 1 ] * x + e[ 4 ] * y + e[ 7 ] * z;
    this.z = e[ 2 ] * x + e[ 5 ] * y + e[ 8 ] * z;
    return this;
  }

  applyNormalMatrix( m ) {
    return this.applyMatrix3( m ).normalize();
  }

  applyMatrix4( m ) {
    const x = this.x, y = this.y, z = this.z;
    const e = m.elements;
    const w = 1 / ( e[ 3 ] * x + e[ 7 ] * y + e[ 11 ] * z + e[ 15 ] );
    this.x = ( e[ 0 ] * x + e[ 4 ] * y + e[ 8 ] * z + e[ 12 ] ) * w;
    this.y = ( e[ 1 ] * x + e[ 5 ] * y + e[ 9 ] * z + e[ 13 ] ) * w;
    this.z = ( e[ 2 ] * x + e[ 6 ] * y + e[ 10 ] * z + e[ 14 ] ) * w;
    return this;
  }

  applyQuaternion( q ) {
    const x = this.x, y = this.y, z = this.z;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = - qx * x - qy * y - qz * z;
    this.x = ix * qw + iw * - qx + iy * - qz - iz * - qy;
    this.y = iy * qw + iw * - qy + iz * - qx - ix * - qz;
    this.z = iz * qw + iw * - qz + ix * - qy - iy * - qx;
    return this;
  }

  project( camera ) {
    return this.applyMatrix4( camera.matrixWorldInverse ).applyMatrix4( camera.projectionMatrix );
  }

  unproject( camera ) {
    return this.applyMatrix4( camera.projectionMatrixInverse ).applyMatrix4( camera.matrixWorld );
  }

  transformDirection( m ) {
    const x = this.x, y = this.y, z = this.z;
    const e = m.elements;
    this.x = e[ 0 ] * x + e[ 4 ] * y + e[ 8 ] * z;
    this.y = e[ 1 ] * x + e[ 5 ] * y + e[ 9 ] * z;
    this.z = e[ 2 ] * x + e[ 6 ] * y + e[ 10 ] * z;
    return this.normalize();
  }

  divide( v ) {
    this.x /= v.x;
    this.y /= v.y;
    this.z /= v.z;
    return this;
  }

  divideScalar( scalar ) {
    return this.multiplyScalar( 1 / scalar );
  }

  min( v ) {
    this.x = Math.min( this.x, v.x );
    this.y = Math.min( this.y, v.y );
    this.z = Math.min( this.z, v.z );
    return this;
  }

  max( v ) {
    this.x = Math.max( this.x, v.x );
    this.y = Math.max( this.y, v.y );
    this.z = Math.max( this.z, v.z );
    return this;
  }

  clamp( min, max ) {
    this.x = clamp( this.x, min.x, max.x );
    this.y = clamp( this.y, min.y, max.y );
    this.z = clamp( this.z, min.z, max.z );
    return this;
  }

  clampScalar( minVal, maxVal ) {
    this.x = clamp( this.x, minVal, maxVal );
    this.y = clamp( this.y, minVal, maxVal );
    this.z = clamp( this.z, minVal, maxVal );
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
    return this;
  }

  ceil() {
    this.x = Math.ceil( this.x );
    this.y = Math.ceil( this.y );
    this.z = Math.ceil( this.z );
    return this;
  }

  round() {
    this.x = Math.round( this.x );
    this.y = Math.round( this.y );
    this.z = Math.round( this.z );
    return this;
  }

  roundToZero() {
    this.x = Math.trunc( this.x );
    this.y = Math.trunc( this.y );
    this.z = Math.trunc( this.z );
    return this;
  }

  negate() {
    this.x = - this.x;
    this.y = - this.y;
    this.z = - this.z;
    return this;
  }

  dot( v ) {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  lengthSq() {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  length() {
    return Math.sqrt( this.x * this.x + this.y * this.y + this.z * this.z );
  }

  manhattanLength() {
    return Math.abs( this.x ) + Math.abs( this.y ) + Math.abs( this.z );
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
    return this;
  }

  lerpVectors( v1, v2, alpha ) {
    this.x = v1.x + ( v2.x - v1.x ) * alpha;
    this.y = v1.y + ( v2.y - v1.y ) * alpha;
    this.z = v1.z + ( v2.z - v1.z ) * alpha;
    return this;
  }

  cross( v ) {
    return this.crossVectors( this, v );
  }

  crossVectors( a, b ) {
    const ax = a.x, ay = a.y, az = a.z;
    const bx = b.x, by = b.y, bz = b.z;
    this.x = ay * bz - az * by;
    this.y = az * bx - ax * bz;
    this.z = ax * by - ay * bx;
    return this;
  }

  projectOnVector( v ) {
    const denominator = v.lengthSq();
    if ( denominator === 0 ) return this.set( 0, 0, 0 );
    const scalar = v.dot( this ) / denominator;
    return this.copy( v ).multiplyScalar( scalar );
  }

  projectOnPlane( planeNormal ) {
    _vector.copy( this ).projectOnVector( planeNormal );
    return this.sub( _vector );
  }

  reflect( normal ) {
    return this.sub( _vector.copy( normal ).multiplyScalar( 2 * this.dot( normal ) ) );
  }

  angleTo( v ) {
    const denominator = Math.sqrt( this.lengthSq() * v.lengthSq() );
    if ( denominator === 0 ) return Math.PI / 2;
    const theta = this.dot( v ) / denominator;
    return Math.acos( clamp( theta, - 1, 1 ) );
  }

  distanceTo( v ) {
    return Math.sqrt( this.distanceToSquared( v ) );
  }

  distanceToSquared( v ) {
    const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
    return dx * dx + dy * dy + dz * dz;
  }

  manhattanDistanceTo( v ) {
    return Math.abs( this.x - v.x ) + Math.abs( this.y - v.y ) + Math.abs( this.z - v.z );
  }

  setFromSpherical( s ) {
    return this.setFromSphericalCoords( s.radius, s.phi, s.theta );
  }

  setFromSphericalCoords( radius, phi, theta ) {
    const sinPhiRadius = Math.sin( phi ) * radius;
    this.x = sinPhiRadius * Math.sin( theta );
    this.y = Math.cos( phi ) * radius;
    this.z = sinPhiRadius * Math.cos( theta );
    return this;
  }

  setFromCylindrical( c ) {
    return this.setFromCylindricalCoords( c.radius, c.theta, c.y );
  }

  setFromCylindricalCoords( radius, theta, y ) {
    this.x = radius * Math.sin( theta );
    this.y = y;
    this.z = radius * Math.cos( theta );
    return this;
  }

  setFromMatrixPosition( m ) {
    const e = m.elements;
    this.x = e[ 12 ];
    this.y = e[ 13 ];
    this.z = e[ 14 ];
    return this;
  }

  setFromMatrixScale( m ) {
    const sx = this.setFromMatrixColumn( m, 0 ).length();
    const sy = this.setFromMatrixColumn( m, 1 ).length();
    const sz = this.setFromMatrixColumn( m, 2 ).length();
    this.x = sx;
    this.y = sy;
    this.z = sz;
    return this;
  }

  setFromMatrixColumn( matrix, index ) {
    return this.fromArray( matrix.elements, index * 4 );
  }

  setFromMatrix3Column( matrix, index ) {
    return this.fromArray( matrix.elements, index * 3 );
  }

  setFromEuler( euler ) {
    this.x = euler._x;
    this.y = euler._y;
    this.z = euler._z;
    return this;
  }

  setFromColor( color ) {
    this.x = color.r;
    this.y = color.g;
    this.z = color.b;
    return this;
  }

  equals( v ) {
    return ( v.x === this.x ) && ( v.y === this.y ) && ( v.z === this.z );
  }

  fromArray( array, offset = 0 ) {
    this.x = array[ offset ];
    this.y = array[ offset + 1 ];
    this.z = array[ offset + 2 ];
    return this;
  }

  toArray( array = [], offset = 0 ) {
    array[ offset ] = this.x;
    array[ offset + 1 ] = this.y;
    array[ offset + 2 ] = this.z;
    return array;
  }

  fromBufferAttribute( attribute, index ) {
    this.x = attribute.getX( index );
    this.y = attribute.getY( index );
    this.z = attribute.getZ( index );
    return this;
  }

  random() {
    this.x = Math.random();
    this.y = Math.random();
    this.z = Math.random();
    return this;
  }

  *[ Symbol.iterator ]() {
    yield this.x;
    yield this.y;
    yield this.z;
  }

}

const _vector = /*@__PURE__*/ new Vector3();

export { Vector3 };