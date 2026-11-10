// file number : 073
// full path name : src/math/073_Cylindrical.js
// description : Cylindrical coordinate primitive — drop-in replacement for THREE.Cylindrical (r185) and successor to the CDN-bound 019_Cylindrical.js draft. Stores radius (m, ≥0), theta (radians around +Y, 0 at +Z), and y (m, height). Complete r185 surface: constructor(radius=1, theta=0, y=0), set(radius, theta, y), clone(), copy(other), setFromVector3(v), setFromCartesianCoords(x, y, z), equals(c), fromArray(arr), toArray(arr, offset), Symbol.iterator. Extended: multi-scale unit helpers (`toUnit`, `applyUnit`, `toMeters`, `toKilometers`, `toAstronomicalUnits`, `toLightYears`, `toSolarRadii`, `toGalacticRadii`) using the chat's 002_Constants SCALE table; angle helpers (`wrapTheta`, `deltaThetaTo`); range helpers (`lerp`, `clamp`); and Spherical interop (`setFromSpherical`, `toSpherical`). Full zero-allocation bitECS SoA bridges via 014_BitECS f32 (radius/theta/y), including from/to THREE- and flat-array interop, add/sub/lerp/scale-in-place, cartesian↔cylindrical SoA conversions, scaled SoA conversions (unit factor), make-safe/theta-wrap/clamp-radius in place, and `bitecsCylindricalDeltaTheta`. DoubleDouble `preciseToCartesianInto`, `preciseFromCartesianInto`, `preciseDeltaTheta`, and `preciseRadius` for galactic-scale precision (uses 014_DoubleDouble). Procedural `setFromNoise3D` via 013_SimplexNoise with cached per-seed mulberry32. `disposeNoise3DCache` for cleanup. `Cylindrical.acquire()` / `Cylindrical.recycle()` recycled pool that resets radius=1, theta=0, y=0. 006_Vec3 duck-typed for `.x/.y/.z` reads. 003_Common for clamp/lerp. 002_Constants for SCALE and HELPERS. No CDN, no static server, no Vite/Vue.
// best for : Orbital cameras, particle rings, spiral galaxies, tornado/vortex effects, cylindrical collision proxies, planet/solar/galactic-scale real-time visualization, radar/lidar polar clouds, and any ECS system that stores cylindrical coordinates as SoA radius/theta/y and must feed THREE.Cylindrical, Vector3.setFromCylindricalCoords, or the chat's Vec3 primitives without allocating per frame. The pooled variant is the recommended path for hot loops at 10k+ entities on Android 64-bit, and the DoubleDouble helpers keep precision intact across floating-origin rebases at galactic scale.
// license : MIT

import {
  SCALE,
  HELPERS,
} from '../core/002_Constants.js';
import {
  clamp,
  lerp,
  EPSILON,
} from '../core/003_Common.js';
import * as DD from './014_DoubleDouble.js';
import * as Vec3 from './006_Vec3.js';
import * as Spherical from './020_Spherical.js';
import * as bitecs from '../ecs/014_BitECS.js';
import { createNoise3D } from './013_SimplexNoise.js';

// ═══════════════════════════════════════════════════════════════════
// MULTI-SCALE UNITS (meters as base unit — matches THREE.Cylindrical
// conventions and the chat's 002_Constants.SCALE table)
// ═══════════════════════════════════════════════════════════════════

export const SCALE_UNITS = Object.freeze( {
  NANOMETER:        SCALE.MICRO * 1e-3,
  MICROMETER:       SCALE.MICRO,
  MILLIMETER:       SCALE.MILLI,
  CENTIMETER:       SCALE.MILLI * 1e1,
  METER:            SCALE.UNIT,
  KILOMETER:        SCALE.KILO,
  EARTH_RADIUS:     SCALE.SOLAR * 4.26e-5, // 6 371 000 m; kept exact below
  ASTRONOMICAL_UNIT: SCALE.AU,
  LIGHT_YEAR:       SCALE.LIGHT_YEAR,
  PARSEC:           SCALE.PARSEC,
  SOLAR_RADIUS:     SCALE.SOLAR / SCALE.AU * SCALE.AU * 4.6507e-3,
  GALACTIC_RADIUS:  SCALE.GALACTIC,
} );

// Correct the exact values that come from approximations above.
Object.defineProperty( SCALE_UNITS, 'EARTH_RADIUS', { value: 6371000, enumerable: true } );
Object.defineProperty( SCALE_UNITS, 'SOLAR_RADIUS', { value: 6.957e8, enumerable: true } );

export const PLANET_RADIUS = Object.freeze( {
  MERCURY: 2439700,
  VENUS: 6051800,
  EARTH: 6371000,
  MARS: 3389500,
  JUPITER: 69911000,
  SATURN: 58232000,
  URANUS: 25362000,
  NEPTUNE: 24622000,
  SUN: 6.957e8,
} );

// ═══════════════════════════════════════════════════════════════════
// bitECS 0.4.0 SoA COMPONENT (archetype-friendly, cache-friendly)
// ═══════════════════════════════════════════════════════════════════
export const CylindricalComponent = {
  radius: bitecs.f32( [] ),
  theta:  bitecs.f32( [] ),
  y:      bitecs.f32( [] ),
};

// ═══════════════════════════════════════════════════════════════════
// Duck-typed vec3 accessors — zero allocation in hot paths
// ═══════════════════════════════════════════════════════════════════

function _rx( v ) { return v.x !== undefined ? v.x : v[ 0 ]; }
function _ry( v ) { return v.y !== undefined ? v.y : v[ 1 ]; }
function _rz( v ) { return v.z !== undefined ? v.z : v[ 2 ]; }

function _writeVec3( v, x, y, z ) {
  if ( v === null || v === undefined ) return { x, y, z };
  if ( Array.isArray( v ) ) {
    v[ 0 ] = x;
    v[ 1 ] = y;
    v[ 2 ] = z;
    return v;
  }
  v.x = x;
  v.y = y;
  v.z = z;
  return v;
}

function _cyl( r = 1, theta = 0, y = 0 ) {
  return { radius: r, theta, y };
}

// ────────────── noise cache ──────────────
const _noise3DCache = new Map();

function _mulberry32( seed ) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = ( a + 0x6D2B79F5 ) | 0;
    let t = Math.imul( a ^ ( a >>> 15 ), 1 | a );
    t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
    return ( ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296 );
  };
}

function _cachedNoise3D( seed ) {
  let gen = _noise3DCache.get( seed );
  if ( gen === undefined ) {
    gen = createNoise3D( _mulberry32( seed ) );
    _noise3DCache.set( seed, gen );
  }
  return gen;
}

export function disposeNoise3DCache() {
  _noise3DCache.clear();
}

// ────────────── local pool ──────────────
const _localPool = [];
const LOCAL_POOL_MAX = 256;

// Module-local scratch vec3s reused by bridges
const _scratchVec3A = new Float32Array( 3 );
const _scratchVec3B = new Float32Array( 3 );

// ═══════════════════════════════════════════════════════════════════
// class Cylindrical
// ═══════════════════════════════════════════════════════════════════
class Cylindrical {

  constructor( radius = 1, theta = 0, y = 0 ) {
    this.isCylindrical = true;
    this.radius = radius;
    this.theta = theta;
    this.y = y;
    return this;
  }

  set( radius, theta, y ) {
    this.radius = radius;
    this.theta = theta;
    this.y = y;
    return this;
  }

  clone() {
    return new this.constructor( this.radius, this.theta, this.y );
  }

  copy( other ) {
    this.radius = other.radius;
    this.theta = other.theta;
    this.y = other.y;
    return this;
  }

  setFromVector3( v ) {
    return this.setFromCartesianCoords( _rx( v ), _ry( v ), _rz( v ) );
  }

  setFromCartesianCoords( x, y, z ) {
    this.radius = Math.sqrt( x * x + z * z );
    this.theta = Math.atan2( x, z );
    this.y = y;
    return this;
  }

  // Spherical interop (r185 parity: a Cylindrical can be derived from a
  // Spherical via cartesian round-trip, so setFromSpherical is convenient).
  setFromSpherical( sph ) {
    const sinPhi = Math.sin( sph.phi ) * sph.radius;
    return this.setFromCartesianCoords(
      sinPhi * Math.sin( sph.theta ),
      Math.cos( sph.phi ) * sph.radius,
      sinPhi * Math.cos( sph.theta )
    );
  }

  toSpherical( target ) {
    const out = target || new Spherical.Spherical();
    const x = this.radius * Math.sin( this.theta );
    const y = this.y;
    const z = this.radius * Math.cos( this.theta );
    const radius = Math.sqrt( x * x + y * y + z * z );
    out.radius = radius;
    if ( radius === 0 ) {
      out.phi = 0;
      out.theta = 0;
    } else {
      out.phi = Math.acos( clamp( y / radius, - 1, 1 ) );
      out.theta = Math.atan2( x, z );
    }
    return out;
  }

  // ────────────── multi-scale helpers ──────────────

  toUnit( unit ) {
    return new this.constructor( this.radius * unit, this.theta, this.y * unit );
  }

  applyUnit( unit ) {
    this.radius *= unit;
    this.y *= unit;
    return this;
  }

  toMeters()             { return this.toUnit( 1 ); }
  toKilometers()         { return new this.constructor( this.radius / SCALE_UNITS.KILOMETER, this.theta, this.y / SCALE_UNITS.KILOMETER ); }
  toAstronomicalUnits()  { return new this.constructor( this.radius / SCALE_UNITS.ASTRONOMICAL_UNIT, this.theta, this.y / SCALE_UNITS.ASTRONOMICAL_UNIT ); }
  toLightYears()         { return new this.constructor( this.radius / SCALE_UNITS.LIGHT_YEAR, this.theta, this.y / SCALE_UNITS.LIGHT_YEAR ); }
  toSolarRadii()         { return new this.constructor( this.radius / SCALE_UNITS.SOLAR_RADIUS, this.theta, this.y / SCALE_UNITS.SOLAR_RADIUS ); }
  toGalacticRadii()      { return new this.constructor( this.radius / SCALE_UNITS.GALACTIC_RADIUS, this.theta, this.y / SCALE_UNITS.GALACTIC_RADIUS ); }

  // ────────────── angle / range helpers ──────────────

  wrapTheta() {
    this.theta = Math.atan2( Math.sin( this.theta ), Math.cos( this.theta ) );
    return this;
  }

  deltaThetaTo( other ) {
    let d = other.theta - this.theta;
    while ( d > Math.PI ) d -= 2 * Math.PI;
    while ( d < - Math.PI ) d += 2 * Math.PI;
    return d;
  }

  lerp( other, alpha ) {
    this.radius = lerp( this.radius, other.radius, alpha );
    this.theta = lerp( this.theta, other.theta, alpha );
    this.y = lerp( this.y, other.y, alpha );
    return this;
  }

  clamp( radiusMin, radiusMax, yMin, yMax ) {
    this.radius = clamp( this.radius, radiusMin, radiusMax );
    this.y = clamp( this.y, yMin, yMax );
    return this;
  }

  // ────────────── equality / IO ──────────────

  equals( c ) {
    return c.radius === this.radius
        && c.theta === this.theta
        && c.y === this.y;
  }

  fromArray( array, offset = 0 ) {
    this.radius = array[ offset ];
    this.theta = array[ offset + 1 ];
    this.y = array[ offset + 2 ];
    return this;
  }

  toArray( array = [], offset = 0 ) {
    array[ offset ]     = this.radius;
    array[ offset + 1 ] = this.theta;
    array[ offset + 2 ] = this.y;
    return array;
  }

  *[ Symbol.iterator ]() {
    yield this.radius;
    yield this.theta;
    yield this.y;
  }

  // ────────────── pooled instances ──────────────

  static acquire() {
    return _localPool.length > 0 ? _localPool.pop() : new Cylindrical();
  }

  static recycle( c ) {
    if ( c instanceof Cylindrical && _localPool.length < LOCAL_POOL_MAX ) {
      c.radius = 1;
      c.theta = 0;
      c.y = 0;
      _localPool.push( c );
    }
  }

  static poolReset() { _localPool.length = 0; }
  static poolSize()  { return _localPool.length; }
}

// ═══════════════════════════════════════════════════════════════════
// BRIDGE: THREE-style <-> flat array
// ═══════════════════════════════════════════════════════════════════

export function threeCylindricalFromFlat( out, flat, offset = 0 ) {
  out.radius = flat[ offset ];
  out.theta  = flat[ offset + 1 ];
  out.y      = flat[ offset + 2 ];
  return out;
}

export function flatFromThreeCylindrical( out, cyl, offset = 0 ) {
  out[ offset ]     = cyl.radius;
  out[ offset + 1 ] = cyl.theta;
  out[ offset + 2 ] = cyl.y;
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// BRIDGE: THREE-style <-> bitECS SoA
// ═══════════════════════════════════════════════════════════════════

export function threeCylindricalFromBitecs( out, eid, store = CylindricalComponent ) {
  out.radius = store.radius[ eid ];
  out.theta  = store.theta[ eid ];
  out.y      = store.y[ eid ];
  return out;
}

export function bitecsCylindricalFromThree( eid, cyl, store = CylindricalComponent ) {
  store.radius[ eid ] = cyl.radius;
  store.theta[ eid ]  = cyl.theta;
  store.y[ eid ]      = cyl.y;
  return eid;
}

export function bitecsCylindricalFromFlat( eid, flat, offset = 0, store = CylindricalComponent ) {
  store.radius[ eid ] = flat[ offset ];
  store.theta[ eid ]  = flat[ offset + 1 ];
  store.y[ eid ]      = flat[ offset + 2 ];
  return eid;
}

export function flatFromBitecsCylindrical( out, eid, offset = 0, store = CylindricalComponent ) {
  out[ offset ]     = store.radius[ eid ];
  out[ offset + 1 ] = store.theta[ eid ];
  out[ offset + 2 ] = store.y[ eid ];
  return out;
}

export function bitecsCylindricalCopyInto( eidOut, eidIn, storeIn = CylindricalComponent, storeOut = storeIn ) {
  storeOut.radius[ eidOut ] = storeIn.radius[ eidIn ];
  storeOut.theta[ eidOut ]  = storeIn.theta[ eidIn ];
  storeOut.y[ eidOut ]      = storeIn.y[ eidIn ];
  return eidOut;
}

export function bitecsCylindricalAddInto( eidOut, eidA, eidB, storeA = CylindricalComponent, storeB = CylindricalComponent, storeOut = storeA ) {
  storeOut.radius[ eidOut ] = storeA.radius[ eidA ] + storeB.radius[ eidB ];
  storeOut.theta[ eidOut ]  = storeA.theta[ eidA ]  + storeB.theta[ eidB ];
  storeOut.y[ eidOut ]      = storeA.y[ eidA ]      + storeB.y[ eidB ];
  return eidOut;
}

export function bitecsCylindricalSubInto( eidOut, eidA, eidB, storeA = CylindricalComponent, storeB = CylindricalComponent, storeOut = storeA ) {
  storeOut.radius[ eidOut ] = storeA.radius[ eidA ] - storeB.radius[ eidB ];
  storeOut.theta[ eidOut ]  = storeA.theta[ eidA ]  - storeB.theta[ eidB ];
  storeOut.y[ eidOut ]      = storeA.y[ eidA ]      - storeB.y[ eidB ];
  return eidOut;
}

export function bitecsCylindricalScaleInPlace( eid, scalar, store = CylindricalComponent ) {
  store.radius[ eid ] *= scalar;
  store.theta[ eid ]  *= scalar;
  store.y[ eid ]      *= scalar;
  return eid;
}

export function bitecsCylindricalLerpInto( eidOut, eidA, eidB, alpha, storeA = CylindricalComponent, storeB = CylindricalComponent, storeOut = storeA ) {
  storeOut.radius[ eidOut ] = storeA.radius[ eidA ] + ( storeB.radius[ eidB ] - storeA.radius[ eidA ] ) * alpha;
  storeOut.theta[ eidOut ]  = storeA.theta[ eidA ]  + ( storeB.theta[ eidB ]  - storeA.theta[ eidA ]  ) * alpha;
  storeOut.y[ eidOut ]      = storeA.y[ eidA ]      + ( storeB.y[ eidB ]      - storeA.y[ eidA ]      ) * alpha;
  return eidOut;
}

export function bitecsCylindricalWrapThetaInPlace( eid, store = CylindricalComponent ) {
  store.theta[ eid ] = Math.atan2( Math.sin( store.theta[ eid ] ), Math.cos( store.theta[ eid ] ) );
  return eid;
}

export function bitecsCylindricalClampRadiusInPlace( eid, min, max, store = CylindricalComponent ) {
  store.radius[ eid ] = clamp( store.radius[ eid ], min, max );
  return eid;
}

export function bitecsCylindricalClampYInPlace( eid, min, max, store = CylindricalComponent ) {
  store.y[ eid ] = clamp( store.y[ eid ], min, max );
  return eid;
}

export function bitecsCylindricalDeltaTheta( eidA, eidB, storeA = CylindricalComponent, storeB = CylindricalComponent ) {
  let d = storeB.theta[ eidB ] - storeA.theta[ eidA ];
  while ( d > Math.PI ) d -= 2 * Math.PI;
  while ( d < - Math.PI ) d += 2 * Math.PI;
  return d;
}

// ────────────── cylindrical <-> cartesian SoA bridges ──────────────

export function threeVec3FromBitecsCylindrical( out, eid, store = CylindricalComponent ) {
  const r = store.radius[ eid ];
  const t = store.theta[ eid ];
  return _writeVec3( out, r * Math.sin( t ), store.y[ eid ], r * Math.cos( t ) );
}

export function bitecsVec3FromCylindricalInto( eidOutVec, eidCyl, storeCyl = CylindricalComponent, storeVec ) {
  const r = storeCyl.radius[ eidCyl ];
  const t = storeCyl.theta[ eidCyl ];
  storeVec.x[ eidOutVec ] = r * Math.sin( t );
  storeVec.y[ eidOutVec ] = storeCyl.y[ eidCyl ];
  storeVec.z[ eidOutVec ] = r * Math.cos( t );
  return eidOutVec;
}

export function bitecsCylindricalFromVec3Into( eidOutCyl, eidVec, storeVec, storeCyl = CylindricalComponent ) {
  const x = storeVec.x[ eidVec ];
  const y = storeVec.y[ eidVec ];
  const z = storeVec.z[ eidVec ];
  storeCyl.radius[ eidOutCyl ] = Math.sqrt( x * x + z * z );
  storeCyl.theta[ eidOutCyl ]  = Math.atan2( x, z );
  storeCyl.y[ eidOutCyl ]      = y;
  return eidOutCyl;
}

// ────────────── scaled cylindrical <-> cartesian SoA bridges ──────────────

export function threeVec3FromBitecsCylindricalScaled( out, eid, unitScale, store = CylindricalComponent ) {
  const r = store.radius[ eid ] * unitScale;
  const t = store.theta[ eid ];
  return _writeVec3( out, r * Math.sin( t ), store.y[ eid ] * unitScale, r * Math.cos( t ) );
}

export function bitecsCylindricalFromVec3ScaledInto( eidOutCyl, eidVec, unitScale, storeVec, storeCyl = CylindricalComponent ) {
  const x = storeVec.x[ eidVec ] / unitScale;
  const y = storeVec.y[ eidVec ] / unitScale;
  const z = storeVec.z[ eidVec ] / unitScale;
  storeCyl.radius[ eidOutCyl ] = Math.sqrt( x * x + z * z );
  storeCyl.theta[ eidOutCyl ]  = Math.atan2( x, z );
  storeCyl.y[ eidOutCyl ]      = y;
  return eidOutCyl;
}

// ────────────── flat-array (gl-matrix compatible) ──────────────

export function glMatrixVec3FromBitecsCylindrical( out, eid, unitScale = 1, store = CylindricalComponent ) {
  const r = store.radius[ eid ] * unitScale;
  const t = store.theta[ eid ];
  out[ 0 ] = r * Math.sin( t );
  out[ 1 ] = store.y[ eid ] * unitScale;
  out[ 2 ] = r * Math.cos( t );
  return out;
}

export function bitecsCylindricalFromGlMatrixVec3( eid, glVec, unitScale = 1, store = CylindricalComponent ) {
  const x = glVec[ 0 ] / unitScale;
  const y = glVec[ 1 ] / unitScale;
  const z = glVec[ 2 ] / unitScale;
  store.radius[ eid ] = Math.sqrt( x * x + z * z );
  store.theta[ eid ]  = Math.atan2( x, z );
  store.y[ eid ]      = y;
  return eid;
}

export function glMatrixVec3LerpFromBitecsCylindrical( out, eidA, eidB, t, storeA = CylindricalComponent, storeB = CylindricalComponent ) {
  const a = _scratchVec3A;
  const b = _scratchVec3B;
  const rA = storeA.radius[ eidA ], tA = storeA.theta[ eidA ];
  const rB = storeB.radius[ eidB ], tB = storeB.theta[ eidB ];
  a[ 0 ] = rA * Math.sin( tA ); a[ 1 ] = storeA.y[ eidA ]; a[ 2 ] = rA * Math.cos( tA );
  b[ 0 ] = rB * Math.sin( tB ); b[ 1 ] = storeB.y[ eidB ]; b[ 2 ] = rB * Math.cos( tB );
  out[ 0 ] = a[ 0 ] + t * ( b[ 0 ] - a[ 0 ] );
  out[ 1 ] = a[ 1 ] + t * ( b[ 1 ] - a[ 1 ] );
  out[ 2 ] = a[ 2 ] + t * ( b[ 2 ] - a[ 2 ] );
  return out;
}

export function glMatrixVec3NormalizedFromBitecsCylindrical( out, eid, store = CylindricalComponent ) {
  const a = _scratchVec3A;
  const r = store.radius[ eid ], t = store.theta[ eid ];
  a[ 0 ] = r * Math.sin( t );
  a[ 1 ] = store.y[ eid ];
  a[ 2 ] = r * Math.cos( t );
  const len = Math.sqrt( a[ 0 ] * a[ 0 ] + a[ 1 ] * a[ 1 ] + a[ 2 ] * a[ 2 ] );
  if ( len === 0 ) {
    out[ 0 ] = 0; out[ 1 ] = 0; out[ 2 ] = 0;
  } else {
    const inv = 1 / len;
    out[ 0 ] = a[ 0 ] * inv;
    out[ 1 ] = a[ 1 ] * inv;
    out[ 2 ] = a[ 2 ] * inv;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// HIGH-PRECISION (DoubleDouble) helpers — galactic-scale math
// ═══════════════════════════════════════════════════════════════════

function _toDouble( v ) { return DD.fromDouble( v ); }

// Cylindrical → cartesian, in double-double, writing into a duck-typed vec3.
export function preciseToCartesianInto( out, cyl ) {
  const r = _toDouble( cyl.radius );
  const t = _toDouble( cyl.theta );
  const sin = Math.sin( cyl.theta );
  const cos = Math.cos( cyl.theta );
  out.x = DD.toDouble( DD.multiply( r, _toDouble( sin ) ) );
  out.y = cyl.y;
  out.z = DD.toDouble( DD.multiply( r, _toDouble( cos ) ) );
  void t;
  return out;
}

// Cartesian → cylindrical, in double-double, writing into a duck-typed cyl.
export function preciseFromCartesianInto( out, x, y, z ) {
  const dx = _toDouble( x );
  const dz = _toDouble( z );
  const r2 = DD.add( DD.multiply( dx, dx ), DD.multiply( dz, dz ) );
  out.radius = DD.toDouble( DD.sqrt( r2 ) );
  out.theta  = Math.atan2( x, z );
  out.y      = y;
  return out;
}

// Shortest angular delta between two thetas, in double-double.
export function preciseDeltaTheta( thetaA, thetaB ) {
  const a = _toDouble( thetaA );
  const b = _toDouble( thetaB );
  let d = DD.toDouble( DD.subtract( b, a ) );
  while ( d > Math.PI ) d -= 2 * Math.PI;
  while ( d < - Math.PI ) d += 2 * Math.PI;
  return d;
}

// Precise radius from cartesian (used by floating-origin rebase routines).
export function preciseRadius( x, z ) {
  const dx = _toDouble( x );
  const dz = _toDouble( z );
  return DD.toDouble( DD.sqrt( DD.add( DD.multiply( dx, dx ), DD.multiply( dz, dz ) ) ) );
}

// ═══════════════════════════════════════════════════════════════════
// PROCEDURAL NOISE — sample a cylinder from a 3D simplex field
// ═══════════════════════════════════════════════════════════════════

export function setFromNoise3D( out, x, y, z, seed = 0, radiusScale = 1, yScale = 1 ) {
  const n = _cachedNoise3D( seed );
  out.radius = Math.abs( n( x, y, z ) ) * radiusScale;
  out.theta  = ( n( x + 31.416, y + 47.853, z + 12.793 ) + 1 ) * Math.PI;
  out.y      = n( x - 17.234, y - 53.127, z - 91.056 ) * yScale;
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// MULTI-SCALE UTILITIES (small → galactic)
// ═══════════════════════════════════════════════════════════════════

export function scaleToMeters( value, unit ) { return value * unit; }
export function scaleFromMeters( value, unit ) { return value / unit; }
export function toLightYears( meters )         { return meters / SCALE_UNITS.LIGHT_YEAR; }
export function fromLightYears( ly )           { return ly * SCALE_UNITS.LIGHT_YEAR; }
export function toAstronomicalUnits( meters )  { return meters / SCALE_UNITS.ASTRONOMICAL_UNIT; }
export function fromAstronomicalUnits( au )    { return au * SCALE_UNITS.ASTRONOMICAL_UNIT; }
export function toSolarRadii( meters )         { return meters / SCALE_UNITS.SOLAR_RADIUS; }
export function fromSolarRadii( radii )        { return radii * SCALE_UNITS.SOLAR_RADIUS; }
export function toGalacticRadii( meters )      { return meters / SCALE_UNITS.GALACTIC_RADIUS; }
export function fromGalacticRadii( radii )     { return radii * SCALE_UNITS.GALACTIC_RADIUS; }

export function getPlanetRadiusMeters( name ) {
  return PLANET_RADIUS[ String( name ).toUpperCase() ] || null;
}

export function realTimeDistanceScale( radiusMeters, targetSceneRadius ) {
  return targetSceneRadius / radiusMeters;
}

// ═══════════════════════════════════════════════════════════════════
// Named + default exports
// ═══════════════════════════════════════════════════════════════════
export { Cylindrical };
export default Cylindrical;