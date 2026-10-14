// file number : 008
// full path name : src/math/008_Euler.js
// description : Euler angles class (THREE.Euler) with order string, getters/setters that fire the onChange callback, plus full zero-allocation bridge functions to/from gl-matrix (radian triplet + order string) and bitecs 0.4.0 SoA components (x/y/z Float32Arrays + orderCode Uint8Array indexed by entity id). Uses warn from the official three.js r185 utils.js. Adds high-precision double.js helpers (preciseAngleTo, preciseLerpInto) and a seeded simplex-noise setFromNoise3D helper that fills an Euler rotation from three noise samples.
// best for  :  Human-readable rotation authoring, animation keyframes, editor gizmos, and ECS systems that store rotation as three angles per entity and must feed Object3D.rotation or Quaternion.setFromEuler without allocating per frame.
// license : MIT

import { warn } from 'https://raw.githubusercontent.com/mrdoob/three.js/r185/src/utils.js';
import { clamp } from './MathUtils.js';
import { Quaternion } from './004_Quaternion.js';
import { Matrix4 } from './007_Matrix4.js';

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const { quat: glQuat } = glMatrix;

/*
 * -----------------------------------------------------------------------------
 * ORDER CODE MAPPING (bitecs cannot store strings, so order is a Uint8Array)
 * -----------------------------------------------------------------------------
 * 0 = 'XYZ'  1 = 'YXZ'  2 = 'ZXY'  3 = 'ZYX'  4 = 'YZX'  5 = 'XZY'
 */
const _orderToCode = { 'XYZ': 0, 'YXZ': 1, 'ZXY': 2, 'ZYX': 3, 'YZX': 4, 'XZY': 5 };
const _codeToOrder = [ 'XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY' ];

/*
 * -----------------------------------------------------------------------------
 * BITECS 0.4.0 COMPONENT DEFINITION (SoA, archetype-friendly, cache-friendly)
 * -----------------------------------------------------------------------------
 * Euler is stored as three independent Float32Arrays (x/y/z) plus one
 * Uint8Array (orderCode) indexed by entity id. Systems read/write
 * store.x[eid], store.y[eid], store.z[eid], store.orderCode[eid] directly —
 * no temporary object, no per-entity allocation, no GC churn.
 */
export const EulerComponent = defineComponent( {
  x: Types.f32,
  y: Types.f32,
  z: Types.f32,
  orderCode: Types.u8
} );

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix (radian triplet + order string)  <->  THREE.Euler
 * -----------------------------------------------------------------------------
 * gl-matrix has no dedicated Euler type; an Euler is just three radians plus
 * an intrinsic order string ('xyz' lowercase). We mirror that contract and
 * convert the order string to the THREE uppercase form (or vice versa) once
 * per call — never inside a per-entity loop unless the caller asks for it.
 */

// gl-matrix Euler (xRad, yRad, zRad, order) -> preallocated THREE.Euler
export function threeEulerFromGlMatrix( out, xRad, yRad, zRad, order = 'xyz' ) {
  out._x = xRad;
  out._y = yRad;
  out._z = zRad;
  out._order = order.toUpperCase();
  return out;
}

// THREE.Euler -> write directly into three caller-owned floats + order string.
// Returns the order string; the caller passes a 3-element Float32Array for xyz.
export function glMatrixEulerFromThree( outXYZ, threeEuler ) {
  outXYZ[ 0 ] = threeEuler._x;
  outXYZ[ 1 ] = threeEuler._y;
  outXYZ[ 2 ] = threeEuler._z;
  return threeEuler._order.toLowerCase();
}

// gl-matrix Euler -> write directly into a bitecs entity's SoA component.
export function bitecsEulerFromGlMatrix( eid, xRad, yRad, zRad, order = 'xyz', store = EulerComponent ) {
  store.x[ eid ] = xRad;
  store.y[ eid ] = yRad;
  store.z[ eid ] = zRad;
  store.orderCode[ eid ] = _orderToCode[ order.toUpperCase() ] ?? 0;
  return eid;
}

// bitecs entity SoA component -> three caller-owned floats + order string.
export function glMatrixEulerFromBitecs( outXYZ, eid, store = EulerComponent ) {
  outXYZ[ 0 ] = store.x[ eid ];
  outXYZ[ 1 ] = store.y[ eid ];
  outXYZ[ 2 ] = store.z[ eid ];
  return _codeToOrder[ store.orderCode[ eid ] ] ?? 'XYZ';
}

// bitecs entity SoA component -> preallocated THREE.Euler (no temp object)
export function threeEulerFromBitecs( out, eid, store = EulerComponent ) {
  out._x = store.x[ eid ];
  out._y = store.y[ eid ];
  out._z = store.z[ eid ];
  out._order = _codeToOrder[ store.orderCode[ eid ] ] ?? 'XYZ';
  return out;
}

// THREE.Euler -> write directly into a bitecs entity's SoA component
export function bitecsEulerFromThree( eid, threeEuler, store = EulerComponent ) {
  store.x[ eid ] = threeEuler._x;
  store.y[ eid ] = threeEuler._y;
  store.z[ eid ] = threeEuler._z;
  store.orderCode[ eid ] = _orderToCode[ threeEuler._order ] ?? 0;
  return eid;
}

// Add two bitecs SoA Euler components -> preallocated THREE.Euler.
export function threeEulerFromBitecsAdd( out, eidA, eidB, storeA = EulerComponent, storeB = EulerComponent ) {
  out._x = storeA.x[ eidA ] + storeB.x[ eidB ];
  out._y = storeA.y[ eidA ] + storeB.y[ eidB ];
  out._z = storeA.z[ eidA ] + storeB.z[ eidB ];
  out._order = _codeToOrder[ storeA.orderCode[ eidA ] ] ?? 'XYZ';
  return out;
}

// Add two bitecs SoA Euler components -> dst entity's SoA store.
export function bitecsEulerAddInto( eidOut, eidA, eidB, storeA = EulerComponent, storeB = EulerComponent, storeOut = storeA ) {
  storeOut.x[ eidOut ] = storeA.x[ eidA ] + storeB.x[ eidB ];
  storeOut.y[ eidOut ] = storeA.y[ eidA ] + storeB.y[ eidB ];
  storeOut.z[ eidOut ] = storeA.z[ eidA ] + storeB.z[ eidB ];
  storeOut.orderCode[ eidOut ] = storeA.orderCode[ eidA ];
  return eidOut;
}

// Subtract two bitecs SoA Euler components -> preallocated THREE.Euler.
export function threeEulerFromBitecsSub( out, eidA, eidB, storeA = EulerComponent, storeB = EulerComponent ) {
  out._x = storeA.x[ eidA ] - storeB.x[ eidB ];
  out._y = storeA.y[ eidA ] - storeB.y[ eidB ];
  out._z = storeA.z[ eidA ] - storeB.z[ eidB ];
  out._order = _codeToOrder[ storeA.orderCode[ eidA ] ] ?? 'XYZ';
  return out;
}

// Subtract two bitecs SoA Euler components -> dst entity's SoA store.
export function bitecsEulerSubInto( eidOut, eidA, eidB, storeA = EulerComponent, storeB = EulerComponent, storeOut = storeA ) {
  storeOut.x[ eidOut ] = storeA.x[ eidA ] - storeB.x[ eidB ];
  storeOut.y[ eidOut ] = storeA.y[ eidA ] - storeB.y[ eidB ];
  storeOut.z[ eidOut ] = storeA.z[ eidA ] - storeB.z[ eidB ];
  storeOut.orderCode[ eidOut ] = storeA.orderCode[ eidA ];
  return eidOut;
}

// Scale a bitecs SoA Euler component in place by a scalar.
export function bitecsEulerScaleInPlace( eid, scalar, store = EulerComponent ) {
  store.x[ eid ] *= scalar;
  store.y[ eid ] *= scalar;
  store.z[ eid ] *= scalar;
  return eid;
}

// Linear interpolation between two bitecs SoA Euler components -> preallocated THREE.Euler.
export function threeEulerFromBitecsLerp( out, eidA, eidB, alpha, storeA = EulerComponent, storeB = EulerComponent ) {
  out._x = storeA.x[ eidA ] + ( storeB.x[ eidB ] - storeA.x[ eidA ] ) * alpha;
  out._y = storeA.y[ eidA ] + ( storeB.y[ eidB ] - storeA.y[ eidA ] ) * alpha;
  out._z = storeA.z[ eidA ] + ( storeB.z[ eidB ] - storeA.z[ eidA ] ) * alpha;
  out._order = _codeToOrder[ storeA.orderCode[ eidA ] ] ?? 'XYZ';
  return out;
}

// Linear interpolation between two bitecs SoA Euler components -> dst SoA.
export function bitecsEulerLerpInto( eidOut, eidA, eidB, alpha, storeA = EulerComponent, storeB = EulerComponent, storeOut = storeA ) {
  storeOut.x[ eidOut ] = storeA.x[ eidA ] + ( storeB.x[ eidB ] - storeA.x[ eidA ] ) * alpha;
  storeOut.y[ eidOut ] = storeA.y[ eidA ] + ( storeB.y[ eidB ] - storeA.y[ eidA ] ) * alpha;
  storeOut.z[ eidOut ] = storeA.z[ eidA ] + ( storeB.z[ eidB ] - storeA.z[ eidA ] ) * alpha;
  storeOut.orderCode[ eidOut ] = storeA.orderCode[ eidA ];
  return eidOut;
}

// dot product of two bitecs SoA Euler components (treats them as 3-vectors).
export function bitecsEulerDot( eidA, eidB, storeA = EulerComponent, storeB = EulerComponent ) {
  return storeA.x[ eidA ] * storeB.x[ eidB ] +
    storeA.y[ eidA ] * storeB.y[ eidB ] +
    storeA.z[ eidA ] * storeB.z[ eidB ];
}

// gl-matrix quat.fromEuler -> write into a bitecs Euler SoA component.
// gl-matrix's fromEuler uses intrinsic ZYX order and expects radians; callers
// who need a different order should use THREE.Quaternion.setFromEuler.
export function bitecsEulerFromGlMatrixQuat( eid, qx, qy, qz, qw, order = 'xyz', store = EulerComponent ) {
  _tmpQuat._x = qx; _tmpQuat._y = qy; _tmpQuat._z = qz; _tmpQuat._w = qw;
  _tmpEuler.setFromQuaternion( _tmpQuat, order.toUpperCase() );
  store.x[ eid ] = _tmpEuler._x;
  store.y[ eid ] = _tmpEuler._y;
  store.z[ eid ] = _tmpEuler._z;
  store.orderCode[ eid ] = _orderToCode[ order.toUpperCase() ] ?? 0;
  return eid;
}

// bitecs Euler SoA component -> gl-matrix quat.fromEuler (out is Float32Array 4).
// Converts radians to degrees exactly once per call.
export function glMatrixQuatFromBitecsEuler( out, eid, store = EulerComponent ) {
  const order = ( _codeToOrder[ store.orderCode[ eid ] ] ?? 'XYZ' ).toLowerCase();
  return glQuat.fromEuler(
    out,
    store.x[ eid ] * 180 / Math.PI,
    store.y[ eid ] * 180 / Math.PI,
    store.z[ eid ] * 180 / Math.PI,
    order
  );
}

// bitecs Euler SoA -> preallocated THREE.Quaternion (uses THREE's exact path).
export function threeQuatFromBitecsEuler( out, eid, store = EulerComponent ) {
  _tmpEuler2._x = store.x[ eid ];
  _tmpEuler2._y = store.y[ eid ];
  _tmpEuler2._z = store.z[ eid ];
  _tmpEuler2._order = _codeToOrder[ store.orderCode[ eid ] ] ?? 'XYZ';
  return out.setFromEuler( _tmpEuler2 );
}

/*
 * -----------------------------------------------------------------------------
 * HIGH-PRECISION HELPERS (double.js)
 * -----------------------------------------------------------------------------
 * double.js's Double type carries ~106 bits of mantissa. These helpers compute
 * the angle between two Euler-triplets and interpolate them in double-double
 * precision, avoiding cancellation when the angles are nearly equal.
 */

function _toDouble( value ) {
  return new Double( value );
}

// Angle between two Euler-triplets interpreted as 3-vectors (radians).
export function preciseAngleTo( a, b ) {
  const ax = _toDouble( a._x ), ay = _toDouble( a._y ), az = _toDouble( a._z );
  const bx = _toDouble( b._x ), by = _toDouble( b._y ), bz = _toDouble( b._z );
  const dot = ax.mul( bx ).add( ay.mul( by ) ).add( az.mul( bz ) ).toNumber();
  const la2 = ax.mul( ax ).add( ay.mul( ay ) ).add( az.mul( az ) ).toNumber();
  const lb2 = bx.mul( bx ).add( by.mul( by ) ).add( bz.mul( bz ) ).toNumber();
  const denom = Math.sqrt( la2 * lb2 );
  if ( denom === 0 ) return Math.PI / 2;
  return Math.acos( clamp( dot / denom, - 1, 1 ) );
}

// High-precision lerp of two Euler triplets into out.
export function preciseLerpInto( out, a, b, t ) {
  const oneMinusT = _toDouble( 1 ).sub( _toDouble( t ) );
  const dt = _toDouble( t );
  out._x = _toDouble( a._x ).mul( oneMinusT ).add( _toDouble( b._x ).mul( dt ) ).toNumber();
  out._y = _toDouble( a._y ).mul( oneMinusT ).add( _toDouble( b._y ).mul( dt ) ).toNumber();
  out._z = _toDouble( a._z ).mul( oneMinusT ).add( _toDouble( b._z ).mul( dt ) ).toNumber();
  out._order = a._order;
  return out;
}

/*
 * -----------------------------------------------------------------------------
 * PROCEDURAL NOISE (simplex-noise)
 * -----------------------------------------------------------------------------
 * A cached 3D simplex-noise generator per seed. setFromNoise3D fills an Euler
 * rotation from three noise samples (each sample maps [-1,1] -> [-π,π]), so
 * the same (x, y, z) always produces the same rotation for a given seed.
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
// Each of the three Euler angles is sampled from a decorrelated offset.
export function setFromNoise3D( out, x, y, z, seed = 0, order = 'XYZ' ) {
  const n = _cachedNoise3D( seed );
  out._x = n( x, y, z ) * Math.PI;
  out._y = n( x + 31.416, y + 47.853, z + 12.793 ) * Math.PI;
  out._z = n( x - 17.234, y - 53.127, z - 91.056 ) * Math.PI;
  out._order = order;
  return out;
}

// Drop every cached noise generator.
export function disposeNoise3DCache() {
  _noise3DCache.clear();
}

/*
 * -----------------------------------------------------------------------------
 * THREE.Euler
 * -----------------------------------------------------------------------------
 */
class Euler {

  constructor( x = 0, y = 0, z = 0, order = Euler.DEFAULT_ORDER ) {
    this.isEuler = true;
    this._x = x;
    this._y = y;
    this._z = z;
    this._order = order;
  }

  get x() { return this._x; }
  set x( value ) { this._x = value; this._onChangeCallback(); }

  get y() { return this._y; }
  set y( value ) { this._y = value; this._onChangeCallback(); }

  get z() { return this._z; }
  set z( value ) { this._z = value; this._onChangeCallback(); }

  get order() { return this._order; }
  set order( value ) { this._order = value; this._onChangeCallback(); }

  set( x, y, z, order = this._order ) {
    this._x = x;
    this._y = y;
    this._z = z;
    this._order = order;
    this._onChangeCallback();
    return this;
  }

  clone() {
    return new this.constructor( this._x, this._y, this._z, this._order );
  }

  copy( euler ) {
    this._x = euler._x;
    this._y = euler._y;
    this._z = euler._z;
    this._order = euler._order;
    this._onChangeCallback();
    return this;
  }

  setFromRotationMatrix( m, order = this._order, update = true ) {
    const te = m.elements;
    const m11 = te[ 0 ], m12 = te[ 4 ], m13 = te[ 8 ];
    const m21 = te[ 1 ], m22 = te[ 5 ], m23 = te[ 9 ];
    const m31 = te[ 2 ], m32 = te[ 6 ], m33 = te[ 10 ];

    switch ( order ) {
      case 'XYZ':
        this._y = Math.asin( clamp( m13, - 1, 1 ) );
        if ( Math.abs( m13 ) < 0.9999999 ) {
          this._x = Math.atan2( - m23, m33 );
          this._z = Math.atan2( - m12, m11 );
        } else {
          this._x = Math.atan2( m32, m22 );
          this._z = 0;
        }
        break;
      case 'YXZ':
        this._x = Math.asin( - clamp( m23, - 1, 1 ) );
        if ( Math.abs( m23 ) < 0.9999999 ) {
          this._y = Math.atan2( m13, m33 );
          this._z = Math.atan2( m21, m22 );
        } else {
          this._y = Math.atan2( - m31, m11 );
          this._z = 0;
        }
        break;
      case 'ZXY':
        this._x = Math.asin( clamp( m32, - 1, 1 ) );
        if ( Math.abs( m32 ) < 0.9999999 ) {
          this._y = Math.atan2( - m31, m33 );
          this._z = Math.atan2( - m12, m22 );
        } else {
          this._y = 0;
          this._z = Math.atan2( m21, m11 );
        }
        break;
      case 'ZYX':
        this._y = Math.asin( - clamp( m31, - 1, 1 ) );
        if ( Math.abs( m31 ) < 0.9999999 ) {
          this._x = Math.atan2( m32, m33 );
          this._z = Math.atan2( m21, m11 );
        } else {
          this._x = 0;
          this._z = Math.atan2( - m12, m22 );
        }
        break;
      case 'YZX':
        this._z = Math.asin( clamp( m21, - 1, 1 ) );
        if ( Math.abs( m21 ) < 0.9999999 ) {
          this._x = Math.atan2( - m23, m22 );
          this._y = Math.atan2( - m31, m11 );
        } else {
          this._x = 0;
          this._y = Math.atan2( m13, m33 );
        }
        break;
      case 'XZY':
        this._z = Math.asin( - clamp( m12, - 1, 1 ) );
        if ( Math.abs( m12 ) < 0.9999999 ) {
          this._x = Math.atan2( m32, m22 );
          this._y = Math.atan2( m13, m11 );
        } else {
          this._x = Math.atan2( - m23, m33 );
          this._y = 0;
        }
        break;
      default:
        warn( 'Euler: .setFromRotationMatrix() encountered an unknown order: ' + order );
    }

    this._order = order;
    if ( update === true ) this._onChangeCallback();
    return this;
  }

  setFromQuaternion( q, order = this._order, update = true ) {
    _matrix.makeRotationFromQuaternion( q );
    return this.setFromRotationMatrix( _matrix, order, update );
  }

  setFromVector3( v, order = this._order ) {
    return this.set( v.x, v.y, v.z, order );
  }

  reorder( newOrder ) {
    _quaternion.setFromEuler( this );
    return this.setFromQuaternion( _quaternion, newOrder );
  }

  equals( euler ) {
    return ( euler._x === this._x ) &&
      ( euler._y === this._y ) &&
      ( euler._z === this._z ) &&
      ( euler._order === this._order );
  }

  fromArray( array ) {
    this._x = array[ 0 ];
    this._y = array[ 1 ];
    this._z = array[ 2 ];
    if ( array[ 3 ] !== undefined ) this._order = array[ 3 ];
    this._onChangeCallback();
    return this;
  }

  toArray( array = [], offset = 0 ) {
    array[ offset ] = this._x;
    array[ offset + 1 ] = this._y;
    array[ offset + 2 ] = this._z;
    array[ offset + 3 ] = this._order;
    return array;
  }

  _onChange( callback ) {
    this._onChangeCallback = callback;
    return this;
  }

  _onChangeCallback() {}

  *[ Symbol.iterator ]() {
    yield this._x;
    yield this._y;
    yield this._z;
    yield this._order;
  }

}

Euler.DEFAULT_ORDER = 'XYZ';

const _matrix = /*@__PURE__*/ new Matrix4();
const _quaternion = /*@__PURE__*/ new Quaternion();
const _tmpQuat = /*@__PURE__*/ new Quaternion();
const _tmpEuler = /*@__PURE__*/ new Euler();
const _tmpEuler2 = /*@__PURE__*/ new Euler();

// Default export for parity with other math classes in this module.
export default Euler;
export { Euler };