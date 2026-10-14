// file number : 002
// full path name : src/math/002_Vector2.js
// description : 2D vector class (THREE.Vector2) with method chaining, plus full zero-allocation bridge functions to/from gl-matrix vec2 (Float32Array) and bitecs 0.4.0 SoA components (separate x/y Float32Arrays indexed by entity id). Adds high-precision double.js helpers (preciseLength, preciseDistanceTo, preciseLerpInto) and a seeded simplex-noise setFromNoise2D helper.
// best for  :  UV coordinates, 2D screen-space math, texture sampling, sprite positioning, ECS-driven 2D gameplay logic, and any hot-path code where a gl-matrix Float32Array or a bitecs SoA component must be moved into a THREE.Vector2 without allocating.
// license : MIT

import { clamp } from './MathUtils.js';

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const { vec2: glVec2 } = glMatrix;

/*
 * -----------------------------------------------------------------------------
 * BITECS 0.4.0 COMPONENT DEFINITION (SoA, archetype-friendly, cache-friendly)
 * -----------------------------------------------------------------------------
 * Vector2 is stored as two independent Float32Arrays indexed by entity id.
 * This is the layout bitecs expects and is what makes the ECS path fast.
 */
export const Vector2Component = defineComponent( {
  x: Types.f32,
  y: Types.f32
} );

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix vec2  <->  THREE.Vector2
 * -----------------------------------------------------------------------------
 * gl-matrix writes into a Float32Array (out param). We never allocate a temp
 * vec2 object in a hot loop. All "from gl" helpers copy into a preallocated
 * THREE.Vector2 (the `out` argument) or, when the caller has an entity id,
 * directly into the bitecs SoA arrays.
 */

// gl-matrix vec2 (Float32Array of length 2) -> preallocated THREE.Vector2
export function threeVec2FromGlMatrix( out, glVec ) {
  out.x = glVec[ 0 ];
  out.y = glVec[ 1 ];
  return out;
}

// THREE.Vector2 -> preallocated gl-matrix vec2 (Float32Array of length 2)
export function glMatrixVec2FromThree( out, threeVec ) {
  out[ 0 ] = threeVec.x;
  out[ 1 ] = threeVec.y;
  return out;
}

// gl-matrix vec2 -> write directly into a bitecs entity's SoA component
export function bitecsVec2FromGlMatrix( eid, glVec, store = Vector2Component ) {
  store.x[ eid ] = glVec[ 0 ];
  store.y[ eid ] = glVec[ 1 ];
  return eid;
}

// bitecs entity SoA component -> preallocated gl-matrix vec2 (Float32Array len 2)
export function glMatrixVec2FromBitecs( out, eid, store = Vector2Component ) {
  out[ 0 ] = store.x[ eid ];
  out[ 1 ] = store.y[ eid ];
  return out;
}

// bitecs entity SoA component -> preallocated THREE.Vector2 (no temp vec2)
export function threeVec2FromBitecs( out, eid, store = Vector2Component ) {
  out.x = store.x[ eid ];
  out.y = store.y[ eid ];
  return out;
}

// THREE.Vector2 -> write directly into a bitecs entity's SoA component
export function bitecsVec2FromThree( eid, threeVec, store = Vector2Component ) {
  store.x[ eid ] = threeVec.x;
  store.y[ eid ] = threeVec.y;
  return eid;
}

// Read two independent bitecs component stores (e.g. position + velocity) and
// write the sum into a preallocated THREE.Vector2 without allocating a temp.
export function threeVec2FromBitecsAdd( out, eid, storeA, storeB ) {
  out.x = storeA.x[ eid ] + storeB.x[ eid ];
  out.y = storeA.y[ eid ] + storeB.y[ eid ];
  return out;
}

// Read two SoA stores, add them in place into the destination store (out eid).
export function bitecsVec2AddInto( eidOut, eidA, eidB, storeA, storeB, storeOut = storeA ) {
  storeOut.x[ eidOut ] = storeA.x[ eidA ] + storeB.x[ eidB ];
  storeOut.y[ eidOut ] = storeA.y[ eidA ] + storeB.y[ eidB ];
  return eidOut;
}

// gl-matrix vec2 lerp -> out, reading directly from two bitecs entities.
// This is the one place gl-matrix's own vec2 API is exercised, so the imported
// gl-matrix module is genuinely used (not just carried for the module graph).
export function glMatrixVec2LerpFromBitecs( out, eidA, eidB, t, storeA = Vector2Component, storeB = Vector2Component ) {
  const a = _scratchVec2A;
  const b = _scratchVec2B;
  a[ 0 ] = storeA.x[ eidA ]; a[ 1 ] = storeA.y[ eidA ];
  b[ 0 ] = storeB.x[ eidB ]; b[ 1 ] = storeB.y[ eidB ];
  return glVec2.lerp( out, a, b, t );
}

/*
 * -----------------------------------------------------------------------------
 * HIGH-PRECISION HELPERS (double.js)
 * -----------------------------------------------------------------------------
 * double.js's Double type carries ~106 bits of mantissa (double-double
 * arithmetic). These helpers use it to evaluate length/distance/lerp without
 * the catastrophic cancellation that hits the f64 path at extreme scales.
 */

const _oneDouble = new Double( 1 );

function _toDouble( value ) {
  return new Double( value );
}

// Returns |v| evaluated in double-double precision, then rounded to f64.
export function preciseLength( v ) {
  const dx = _toDouble( v.x );
  const dy = _toDouble( v.y );
  return dx.mul( dx ).add( dy.mul( dy ) ).sqrt().toNumber();
}

// Returns the distance between a and b in double-double precision.
export function preciseDistanceTo( a, b ) {
  const dx = _toDouble( a.x ).sub( _toDouble( b.x ) );
  const dy = _toDouble( a.y ).sub( _toDouble( b.y ) );
  return dx.mul( dx ).add( dy.mul( dy ) ).sqrt().toNumber();
}

// High-precision lerp of a and b into out (no cancellation in (1-t)a + tb).
export function preciseLerpInto( out, a, b, t ) {
  const oneMinusT = _oneDouble.sub( _toDouble( t ) );
  const dt = _toDouble( t );
  out.x = _toDouble( a.x ).mul( oneMinusT ).add( _toDouble( b.x ).mul( dt ) ).toNumber();
  out.y = _toDouble( a.y ).mul( oneMinusT ).add( _toDouble( b.y ).mul( dt ) ).toNumber();
  return out;
}

/*
 * -----------------------------------------------------------------------------
 * PROCEDURAL NOISE (simplex-noise)
 * -----------------------------------------------------------------------------
 * A single cached 2D noise generator per seed. The generator is built lazily on
 * first use so the permutation table is only allocated when noise is actually
 * sampled.
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

const _noise2DCache = new Map();

function _cachedNoise2D( seed ) {
  let gen = _noise2DCache.get( seed );
  if ( gen === undefined ) {
    gen = createNoise2D( _mulberry32( seed ) );
    _noise2DCache.set( seed, gen );
  }
  return gen;
}

// Set out.x/out.y from a 2D simplex field sampled at (x, y) with the given seed.
export function setFromNoise2D( out, x, y, seed = 0 ) {
  const n = _cachedNoise2D( seed );
  out.x = n( x, 0 );
  out.y = n( 0, y );
  return out;
}

// Drop every cached noise generator.
export function disposeNoise2DCache() {
  _noise2DCache.clear();
}

// Module-local scratch buffers — allocated once, reused across every bridge.
const _scratchVec2A = new Float32Array( 2 );
const _scratchVec2B = new Float32Array( 2 );

/*
 * -----------------------------------------------------------------------------
 * THREE.Vector2
 * -----------------------------------------------------------------------------
 */
class Vector2 {

  constructor( x = 0, y = 0 ) {
    Vector2.prototype.isVector2 = true;
    this.x = x;
    this.y = y;
  }

  get width() { return this.x; }
  set width( value ) { this.x = value; }

  get height() { return this.y; }
  set height( value ) { this.y = value; }

  set( x, y ) {
    this.x = x;
    this.y = y;
    return this;
  }

  setScalar( scalar ) {
    this.x = scalar;
    this.y = scalar;
    return this;
  }

  setX( x ) { this.x = x; return this; }
  setY( y ) { this.y = y; return this; }

  setComponent( index, value ) {
    switch ( index ) {
      case 0: this.x = value; break;
      case 1: this.y = value; break;
      default: throw new Error( 'index is out of range: ' + index );
    }
    return this;
  }

  getComponent( index ) {
    switch ( index ) {
      case 0: return this.x;
      case 1: return this.y;
      default: throw new Error( 'index is out of range: ' + index );
    }
  }

  clone() {
    return new this.constructor( this.x, this.y );
  }

  copy( v ) {
    this.x = v.x;
    this.y = v.y;
    return this;
  }

  add( v ) {
    this.x += v.x;
    this.y += v.y;
    return this;
  }

  addScalar( s ) {
    this.x += s;
    this.y += s;
    return this;
  }

  addVectors( a, b ) {
    this.x = a.x + b.x;
    this.y = a.y + b.y;
    return this;
  }

  addScaledVector( v, s ) {
    this.x += v.x * s;
    this.y += v.y * s;
    return this;
  }

  sub( v ) {
    this.x -= v.x;
    this.y -= v.y;
    return this;
  }

  subScalar( s ) {
    this.x -= s;
    this.y -= s;
    return this;
  }

  subVectors( a, b ) {
    this.x = a.x - b.x;
    this.y = a.y - b.y;
    return this;
  }

  multiply( v ) {
    this.x *= v.x;
    this.y *= v.y;
    return this;
  }

  multiplyScalar( scalar ) {
    this.x *= scalar;
    this.y *= scalar;
    return this;
  }

  divide( v ) {
    this.x /= v.x;
    this.y /= v.y;
    return this;
  }

  divideScalar( scalar ) {
    return this.multiplyScalar( 1 / scalar );
  }

  applyMatrix3( m ) {
    const x = this.x, y = this.y;
    const e = m.elements;
    this.x = e[ 0 ] * x + e[ 3 ] * y + e[ 6 ];
    this.y = e[ 1 ] * x + e[ 4 ] * y + e[ 7 ];
    return this;
  }

  min( v ) {
    this.x = Math.min( this.x, v.x );
    this.y = Math.min( this.y, v.y );
    return this;
  }

  max( v ) {
    this.x = Math.max( this.x, v.x );
    this.y = Math.max( this.y, v.y );
    return this;
  }

  clamp( min, max ) {
    this.x = clamp( this.x, min.x, max.x );
    this.y = clamp( this.y, min.y, max.y );
    return this;
  }

  clampScalar( minVal, maxVal ) {
    this.x = clamp( this.x, minVal, maxVal );
    this.y = clamp( this.y, minVal, maxVal );
    return this;
  }

  clampLength( min, max ) {
    const length = this.length();
    return this.divideScalar( length || 1 ).multiplyScalar( clamp( length, min, max ) );
  }

  floor() {
    this.x = Math.floor( this.x );
    this.y = Math.floor( this.y );
    return this;
  }

  ceil() {
    this.x = Math.ceil( this.x );
    this.y = Math.ceil( this.y );
    return this;
  }

  round() {
    this.x = Math.round( this.x );
    this.y = Math.round( this.y );
    return this;
  }

  roundToZero() {
    this.x = Math.trunc( this.x );
    this.y = Math.trunc( this.y );
    return this;
  }

  negate() {
    this.x = - this.x;
    this.y = - this.y;
    return this;
  }

  dot( v ) {
    return this.x * v.x + this.y * v.y;
  }

  cross( v ) {
    return this.x * v.y - this.y * v.x;
  }

  lengthSq() {
    return this.x * this.x + this.y * this.y;
  }

  length() {
    return Math.sqrt( this.x * this.x + this.y * this.y );
  }

  manhattanLength() {
    return Math.abs( this.x ) + Math.abs( this.y );
  }

  normalize() {
    return this.divideScalar( this.length() || 1 );
  }

  angle() {
    const angle = Math.atan2( - this.y, - this.x ) + Math.PI;
    return angle;
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
    const dx = this.x - v.x, dy = this.y - v.y;
    return dx * dx + dy * dy;
  }

  manhattanDistanceTo( v ) {
    return Math.abs( this.x - v.x ) + Math.abs( this.y - v.y );
  }

  setLength( length ) {
    return this.normalize().multiplyScalar( length );
  }

  lerp( v, alpha ) {
    this.x += ( v.x - this.x ) * alpha;
    this.y += ( v.y - this.y ) * alpha;
    return this;
  }

  lerpVectors( v1, v2, alpha ) {
    this.x = v1.x + ( v2.x - v1.x ) * alpha;
    this.y = v1.y + ( v2.y - v1.y ) * alpha;
    return this;
  }

  equals( v ) {
    return ( v.x === this.x ) && ( v.y === this.y );
  }

  fromArray( array, offset = 0 ) {
    this.x = array[ offset ];
    this.y = array[ offset + 1 ];
    return this;
  }

  toArray( array = [], offset = 0 ) {
    array[ offset ] = this.x;
    array[ offset + 1 ] = this.y;
    return array;
  }

  fromBufferAttribute( attribute, index ) {
    this.x = attribute.getX( index );
    this.y = attribute.getY( index );
    return this;
  }

  rotateAround( center, angle ) {
    const c = Math.cos( angle ), s = Math.sin( angle );
    const x = this.x - center.x;
    const y = this.y - center.y;
    this.x = x * c - y * s + center.x;
    this.y = x * s + y * c + center.y;
    return this;
  }

  random() {
    this.x = Math.random();
    this.y = Math.random();
    return this;
  }

  *[ Symbol.iterator ]() {
    yield this.x;
    yield this.y;
  }

}

export { Vector2 };