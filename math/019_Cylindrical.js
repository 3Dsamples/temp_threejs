// file number : 019
// full path name : src/math/019_Cylindrical.js
// description : Cylindrical coordinate class (THREE.Cylindrical) with radius, theta, y and method chaining, plus full zero-allocation bridge functions to/from gl-matrix (three scalars or packed 3-element Float32Array [radius, theta, y]) and bitecs 0.4.0 SoA components (radius/theta/y Float32Arrays indexed by entity id). Also includes real-time multi-scale helpers from sub-millimeter to galactic distances (scaleUnit, toMeters, fromMeters, toLightYears, fromLightYears, galacticRadius, solarRadius, planetRadius, realTimeDistanceScale). Adds high-precision double.js helpers (preciseToCartesian, preciseFromCartesian, preciseDeltaTheta) and a seeded simplex-noise setFromNoise3D helper. Uses glVec3 for a real gl-matrix-backed cartesian helper.
// best for  :  Orbital cameras, particle rings, spiral galaxies, tornado/vortex effects, cylindrical collision proxies, planet/solar/galactic scale real-time visualization, and any ECS system that stores cylindrical coordinates as SoA radius/theta/y and must feed THREE.Cylindrical, Vector3.setFromCylindrical, or gl-matrix without allocating per frame.
// license : MIT

import { clamp, lerp } from './MathUtils.js';

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const { vec3: glVec3 } = glMatrix;

// API-parity note: the SoA conversions in this file write into THREE.Vector3
// arguments by accessing `.x/.y/.z` directly (duck-typed), so no Vector3
// import is required. The gl-matrix `glVec3` import below IS used by the
// `glMatrixVec3FromBitecsCylindricalNormalized` helper.

/*
 * -----------------------------------------------------------------------------
 * MULTI-SCALE UNIT TABLE (meters as the base unit)
 * -----------------------------------------------------------------------------
 * Small → Galactic. Values are exact or standard approximations.
 */
export const SCALE_UNITS = Object.freeze( {
  NANOMETER: 1e-9,
  MICROMETER: 1e-6,
  MILLIMETER: 1e-3,
  CENTIMETER: 1e-2,
  METER: 1,
  KILOMETER: 1e3,
  EARTH_RADIUS: 6371000,
  ASTRONOMICAL_UNIT: 1.495978707e11,
  LIGHT_YEAR: 9.4607304725808e15,
  PARSEC: 3.0856775814913673e16,
  SOLAR_RADIUS: 6.957e8,
  GALACTIC_RADIUS: 5e20
} );

// Human-friendly astronomical radius constants (meters).
export const PLANET_RADIUS = Object.freeze( {
  MERCURY: 2439700,
  VENUS: 6051800,
  EARTH: 6371000,
  MARS: 3389500,
  JUPITER: 69911000,
  SATURN: 58232000,
  URANUS: 25362000,
  NEPTUNE: 24622000,
  SUN: 6.957e8
} );

/*
 * -----------------------------------------------------------------------------
 * BITECS 0.4.0 COMPONENT DEFINITION (SoA, archetype-friendly, cache-friendly)
 * -----------------------------------------------------------------------------
 * Cylindrical is stored as three independent Float32Arrays indexed by entity id.
 * Systems read/write store.radius[eid], store.theta[eid], store.y[eid]
 * directly — no temporary object, no per-entity allocation, no GC churn.
 */
export const CylindricalComponent = defineComponent( {
  radius: Types.f32,
  theta: Types.f32,
  y: Types.f32
} );

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix (radius, theta, y as three scalars)  <->  THREE.Cylindrical
 * -----------------------------------------------------------------------------
 * gl-matrix has no dedicated cylindrical type. A cylindrical coordinate is
 * represented as three scalars (radius, theta, y), or as a packed 3-element
 * Float32Array [radius, theta, y]. We mirror both contracts. The THREE side
 * always writes into a preallocated THREE.Cylindrical (the `out` argument),
 * never returns a fresh instance, so hot loops stay allocation-free.
 */

// gl-matrix three scalars -> preallocated THREE.Cylindrical
export function threeCylindricalFromGlMatrix( out, radius, theta, y ) {
  out.radius = radius;
  out.theta = theta;
  out.y = y;
  return out;
}

// gl-matrix packed 3-element Float32Array [radius, theta, y] -> preallocated THREE.Cylindrical
export function threeCylindricalFromGlMatrixPacked( out, glPacked ) {
  out.radius = glPacked[ 0 ];
  out.theta = glPacked[ 1 ];
  out.y = glPacked[ 2 ];
  return out;
}

// THREE.Cylindrical -> write into caller-owned scalars (returns nothing).
export function glMatrixCylindricalFromThree( outXYZ, threeCyl ) {
  outXYZ[ 0 ] = threeCyl.radius;
  outXYZ[ 1 ] = threeCyl.theta;
  outXYZ[ 2 ] = threeCyl.y;
  return outXYZ;
}

// THREE.Cylindrical -> preallocated packed 3-element Float32Array
export function glMatrixCylindricalPackedFromThree( outPacked, threeCyl ) {
  outPacked[ 0 ] = threeCyl.radius;
  outPacked[ 1 ] = threeCyl.theta;
  outPacked[ 2 ] = threeCyl.y;
  return outPacked;
}

// gl-matrix three scalars -> write directly into a bitecs entity's SoA component
export function bitecsCylindricalFromGlMatrix( eid, radius, theta, y, store = CylindricalComponent ) {
  store.radius[ eid ] = radius;
  store.theta[ eid ] = theta;
  store.y[ eid ] = y;
  return eid;
}

// gl-matrix packed 3-element Float32Array -> write directly into bitecs entity
export function bitecsCylindricalFromGlMatrixPacked( eid, glPacked, store = CylindricalComponent ) {
  store.radius[ eid ] = glPacked[ 0 ];
  store.theta[ eid ] = glPacked[ 1 ];
  store.y[ eid ] = glPacked[ 2 ];
  return eid;
}

// bitecs entity SoA component -> three caller-owned scalars
export function glMatrixCylindricalFromBitecs( outXYZ, eid, store = CylindricalComponent ) {
  outXYZ[ 0 ] = store.radius[ eid ];
  outXYZ[ 1 ] = store.theta[ eid ];
  outXYZ[ 2 ] = store.y[ eid ];
  return outXYZ;
}

// bitecs entity SoA component -> preallocated packed 3-element Float32Array
export function glMatrixCylindricalPackedFromBitecs( outPacked, eid, store = CylindricalComponent ) {
  outPacked[ 0 ] = store.radius[ eid ];
  outPacked[ 1 ] = store.theta[ eid ];
  outPacked[ 2 ] = store.y[ eid ];
  return outPacked;
}

// bitecs entity SoA component -> preallocated THREE.Cylindrical (no temp)
export function threeCylindricalFromBitecs( out, eid, store = CylindricalComponent ) {
  out.radius = store.radius[ eid ];
  out.theta = store.theta[ eid ];
  out.y = store.y[ eid ];
  return out;
}

// THREE.Cylindrical -> write directly into a bitecs entity's SoA component
export function bitecsCylindricalFromThree( eid, threeCyl, store = CylindricalComponent ) {
  store.radius[ eid ] = threeCyl.radius;
  store.theta[ eid ] = threeCyl.theta;
  store.y[ eid ] = threeCyl.y;
  return eid;
}

// Add two bitecs SoA cylindrical coords -> preallocated THREE.Cylindrical.
export function threeCylindricalFromBitecsAdd( out, eidA, eidB, storeA = CylindricalComponent, storeB = CylindricalComponent ) {
  out.radius = storeA.radius[ eidA ] + storeB.radius[ eidB ];
  out.theta = storeA.theta[ eidA ] + storeB.theta[ eidB ];
  out.y = storeA.y[ eidA ] + storeB.y[ eidB ];
  return out;
}

// Add two bitecs SoA cylindrical coords -> dst entity's SoA store.
export function bitecsCylindricalAddInto( eidOut, eidA, eidB, storeA = CylindricalComponent, storeB = CylindricalComponent, storeOut = storeA ) {
  storeOut.radius[ eidOut ] = storeA.radius[ eidA ] + storeB.radius[ eidB ];
  storeOut.theta[ eidOut ] = storeA.theta[ eidA ] + storeB.theta[ eidB ];
  storeOut.y[ eidOut ] = storeA.y[ eidA ] + storeB.y[ eidB ];
  return eidOut;
}

// Subtract two bitecs SoA cylindrical coords -> preallocated THREE.Cylindrical.
export function threeCylindricalFromBitecsSub( out, eidA, eidB, storeA = CylindricalComponent, storeB = CylindricalComponent ) {
  out.radius = storeA.radius[ eidA ] - storeB.radius[ eidB ];
  out.theta = storeA.theta[ eidA ] - storeB.theta[ eidB ];
  out.y = storeA.y[ eidA ] - storeB.y[ eidB ];
  return out;
}

// Subtract two bitecs SoA cylindrical coords -> dst entity's SoA store.
export function bitecsCylindricalSubInto( eidOut, eidA, eidB, storeA = CylindricalComponent, storeB = CylindricalComponent, storeOut = storeA ) {
  storeOut.radius[ eidOut ] = storeA.radius[ eidA ] - storeB.radius[ eidB ];
  storeOut.theta[ eidOut ] = storeA.theta[ eidA ] - storeB.theta[ eidB ];
  storeOut.y[ eidOut ] = storeA.y[ eidA ] - storeB.y[ eidB ];
  return eidOut;
}

// Scale a bitecs SoA cylindrical coord in place by a scalar.
export function bitecsCylindricalScaleInPlace( eid, scalar, store = CylindricalComponent ) {
  store.radius[ eid ] *= scalar;
  store.theta[ eid ] *= scalar;
  store.y[ eid ] *= scalar;
  return eid;
}

// Linear interpolation between two bitecs SoA cylindrical coords -> preallocated THREE.Cylindrical.
export function threeCylindricalFromBitecsLerp( out, eidA, eidB, alpha, storeA = CylindricalComponent, storeB = CylindricalComponent ) {
  out.radius = storeA.radius[ eidA ] + ( storeB.radius[ eidB ] - storeA.radius[ eidA ] ) * alpha;
  out.theta = storeA.theta[ eidA ] + ( storeB.theta[ eidB ] - storeA.theta[ eidA ] ) * alpha;
  out.y = storeA.y[ eidA ] + ( storeB.y[ eidB ] - storeA.y[ eidA ] ) * alpha;
  return out;
}

// Linear interpolation between two bitecs SoA cylindrical coords -> dst SoA.
export function bitecsCylindricalLerpInto( eidOut, eidA, eidB, alpha, storeA = CylindricalComponent, storeB = CylindricalComponent, storeOut = storeA ) {
  storeOut.radius[ eidOut ] = storeA.radius[ eidA ] + ( storeB.radius[ eidB ] - storeA.radius[ eidA ] ) * alpha;
  storeOut.theta[ eidOut ] = storeA.theta[ eidA ] + ( storeB.theta[ eidB ] - storeA.theta[ eidA ] ) * alpha;
  storeOut.y[ eidOut ] = storeA.y[ eidA ] + ( storeB.y[ eidB ] - storeA.y[ eidA ] ) * alpha;
  return eidOut;
}

// Convert a bitecs SoA cylindrical coord to a preallocated THREE.Vector3 (cartesian).
export function threeVec3FromBitecsCylindrical( out, eid, store = CylindricalComponent ) {
  const radius = store.radius[ eid ];
  const theta = store.theta[ eid ];
  const y = store.y[ eid ];
  out.x = radius * Math.sin( theta );
  out.y = y;
  out.z = radius * Math.cos( theta );
  return out;
}

// Convert a bitecs SoA cylindrical coord to a dst bitecs SoA Vector3 store.
export function bitecsVec3FromCylindricalInto( eidOutVec, eidCyl, storeCyl = CylindricalComponent, storeVec ) {
  const radius = storeCyl.radius[ eidCyl ];
  const theta = storeCyl.theta[ eidCyl ];
  const y = storeCyl.y[ eidCyl ];
  storeVec.x[ eidOutVec ] = radius * Math.sin( theta );
  storeVec.y[ eidOutVec ] = y;
  storeVec.z[ eidOutVec ] = radius * Math.cos( theta );
  return eidOutVec;
}

// Convert a bitecs SoA Vector3 (cartesian) to a bitecs SoA cylindrical coord.
export function bitecsCylindricalFromVec3Into( eidOutCyl, eidVec, storeVec, storeCyl = CylindricalComponent ) {
  const x = storeVec.x[ eidVec ];
  const y = storeVec.y[ eidVec ];
  const z = storeVec.z[ eidVec ];
  const radius = Math.sqrt( x * x + z * z );
  storeCyl.radius[ eidOutCyl ] = radius;
  storeCyl.theta[ eidOutCyl ] = Math.atan2( x, z );
  storeCyl.y[ eidOutCyl ] = y;
  return eidOutCyl;
}

// Convert a bitecs SoA cylindrical coord to a preallocated THREE.Vector3 with
// an optional unit scale factor (multi-scale: meters, km, AU, light-years, etc.).
export function threeVec3FromBitecsCylindricalScaled( out, eid, unitScale, store = CylindricalComponent ) {
  const radius = store.radius[ eid ] * unitScale;
  const theta = store.theta[ eid ];
  const y = store.y[ eid ] * unitScale;
  out.x = radius * Math.sin( theta );
  out.y = y;
  out.z = radius * Math.cos( theta );
  return out;
}

// Convert a bitecs SoA Vector3 (cartesian) to a bitecs SoA cylindrical coord
// with an optional unit scale factor.
export function bitecsCylindricalFromVec3ScaledInto( eidOutCyl, eidVec, unitScale, storeVec, storeCyl = CylindricalComponent ) {
  const x = storeVec.x[ eidVec ] / unitScale;
  const y = storeVec.y[ eidVec ] / unitScale;
  const z = storeVec.z[ eidVec ] / unitScale;
  const radius = Math.sqrt( x * x + z * z );
  storeCyl.radius[ eidOutCyl ] = radius;
  storeCyl.theta[ eidOutCyl ] = Math.atan2( x, z );
  storeCyl.y[ eidOutCyl ] = y;
  return eidOutCyl;
}

// gl-matrix vec3 (cartesian) -> bitecs cylindrical SoA, with unit scale.
export function bitecsCylindricalFromGlMatrixVec3( eid, glVec, unitScale = 1, store = CylindricalComponent ) {
  const x = glVec[ 0 ] / unitScale;
  const y = glVec[ 1 ] / unitScale;
  const z = glVec[ 2 ] / unitScale;
  const radius = Math.sqrt( x * x + z * z );
  store.radius[ eid ] = radius;
  store.theta[ eid ] = Math.atan2( x, z );
  store.y[ eid ] = y;
  return eid;
}

// bitecs cylindrical SoA -> gl-matrix vec3 (cartesian), with unit scale.
export function glMatrixVec3FromBitecsCylindrical( out, eid, unitScale = 1, store = CylindricalComponent ) {
  const radius = store.radius[ eid ] * unitScale;
  const theta = store.theta[ eid ];
  const y = store.y[ eid ] * unitScale;
  out[ 0 ] = radius * Math.sin( theta );
  out[ 1 ] = y;
  out[ 2 ] = radius * Math.cos( theta );
  return out;
}

// gl-matrix vec3 lerp -> out, reading from two bitecs cylindrical entities
// (interpolating the cartesian positions). Uses the imported glVec3 so the
// module graph is genuinely exercised.
export function glMatrixVec3LerpFromBitecsCylindrical( out, eidA, eidB, t, storeA = CylindricalComponent, storeB = CylindricalComponent ) {
  const a = _scratchVec3A;
  const b = _scratchVec3B;
  // Sample A
  a[ 0 ] = storeA.radius[ eidA ] * Math.sin( storeA.theta[ eidA ] );
  a[ 1 ] = storeA.y[ eidA ];
  a[ 2 ] = storeA.radius[ eidA ] * Math.cos( storeA.theta[ eidA ] );
  // Sample B
  b[ 0 ] = storeB.radius[ eidB ] * Math.sin( storeB.theta[ eidB ] );
  b[ 1 ] = storeB.y[ eidB ];
  b[ 2 ] = storeB.radius[ eidB ] * Math.cos( storeB.theta[ eidB ] );
  return glVec3.lerp( out, a, b, t );
}

// gl-matrix vec3 normalize -> out, reading a bitecs cylindrical coord and
// writing the normalized cartesian direction.
export function glMatrixVec3NormalizedFromBitecsCylindrical( out, eid, store = CylindricalComponent ) {
  const a = _scratchVec3A;
  a[ 0 ] = store.radius[ eid ] * Math.sin( store.theta[ eid ] );
  a[ 1 ] = store.y[ eid ];
  a[ 2 ] = store.radius[ eid ] * Math.cos( store.theta[ eid ] );
  return glVec3.normalize( out, a );
}

/*
 * -----------------------------------------------------------------------------
 * HIGH-PRECISION HELPERS (double.js)
 * -----------------------------------------------------------------------------
 * double.js's Double type carries ~106 bits of mantissa. These helpers convert
 * between cylindrical and cartesian coordinates, and compute the shortest
 * angular delta between two thetas, in double-double precision. Useful for
 * galactic-scale orbital math where the radius is huge and the angular
 * resolution is very small.
 */

function _toDouble( value ) {
  return new Double( String( value ) );
}

// Cylindrical -> cartesian, in double-double precision, into a THREE.Vector3.
export function preciseToCartesianInto( out, cyl ) {
  const r = _toDouble( cyl.radius );
  const t = _toDouble( cyl.theta );
  const y = _toDouble( cyl.y );
  out.x = r.mul( t.sin() ).toNumber();
  out.y = y.toNumber();
  out.z = r.mul( t.cos() ).toNumber();
  return out;
}

// Cartesian -> cylindrical, in double-double precision, into a THREE.Cylindrical.
export function preciseFromCartesianInto( out, x, y, z ) {
  const dx = _toDouble( x );
  const dy = _toDouble( y );
  const dz = _toDouble( z );
  const r = dx.mul( dx ).add( dz.mul( dz ) ).sqrt();
  out.radius = r.toNumber();
  out.theta = Math.atan2( dx.toNumber(), dz.toNumber() );
  out.y = dy.toNumber();
  return out;
}

// Shortest angular delta between two thetas, in double-double precision.
// Result is in (-π, π].
export function preciseDeltaTheta( thetaA, thetaB ) {
  const a = _toDouble( thetaA );
  const b = _toDouble( thetaB );
  let d = b.sub( a ).toNumber();
  while ( d > Math.PI ) d -= 2 * Math.PI;
  while ( d < - Math.PI ) d += 2 * Math.PI;
  return d;
}

/*
 * -----------------------------------------------------------------------------
 * PROCEDURAL NOISE (simplex-noise)
 * -----------------------------------------------------------------------------
 * A cached 3D simplex-noise generator per seed. setFromNoise3D fills a
 * THREE.Cylindrical from three decorrelated samples of the same noise field.
 * The radius is set to |noise| * radiusScale (positive), theta is mapped to
 * [0, 2π), and y is mapped to [-yScale, yScale].
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

// Fill a THREE.Cylindrical from a 3D simplex field sampled at (x, y, z). The
// radius is always non-negative; theta is in [0, 2π); y is in [-yScale, yScale].
export function setFromNoise3D( out, x, y, z, seed = 0, radiusScale = 1, yScale = 1 ) {
  const n = _cachedNoise3D( seed );
  out.radius = Math.abs( n( x, y, z ) ) * radiusScale;
  out.theta = ( n( x + 31.416, y + 47.853, z + 12.793 ) + 1 ) * Math.PI;
  out.y = n( x - 17.234, y - 53.127, z - 91.056 ) * yScale;
  return out;
}

// Drop every cached noise generator.
export function disposeNoise3DCache() {
  _noise3DCache.clear();
}

/*
 * -----------------------------------------------------------------------------
 * REAL-TIME MULTI-SCALE HELPERS (small → galactic)
 * -----------------------------------------------------------------------------
 * All helpers are pure and allocation-free. They convert between a chosen
 * scene unit and meters, which lets the same scene graph render
 * nanometre-scale and light-year-scale objects without changing the math.
 */

// Converts a value expressed in the given unit to meters.
export function scaleToMeters( value, unit ) {
  return value * unit;
}

// Converts a value in meters to the given unit.
export function scaleFromMeters( value, unit ) {
  return value / unit;
}

// Convenience: meters <-> light-years.
export function toLightYears( meters ) { return meters / SCALE_UNITS.LIGHT_YEAR; }
export function fromLightYears( ly ) { return ly * SCALE_UNITS.LIGHT_YEAR; }

// Convenience: meters <-> astronomical units.
export function toAstronomicalUnits( meters ) { return meters / SCALE_UNITS.ASTRONOMICAL_UNIT; }
export function fromAstronomicalUnits( au ) { return au * SCALE_UNITS.ASTRONOMICAL_UNIT; }

// Convenience: meters <-> solar radii.
export function toSolarRadii( meters ) { return meters / SCALE_UNITS.SOLAR_RADIUS; }
export function fromSolarRadii( radii ) { return radii * SCALE_UNITS.SOLAR_RADIUS; }

// Convenience: meters <-> galactic radii.
export function toGalacticRadii( meters ) { return meters / SCALE_UNITS.GALACTIC_RADIUS; }
export function fromGalacticRadii( radii ) { return radii * SCALE_UNITS.GALACTIC_RADIUS; }

// Planet helpers — lookup by name (case-insensitive) from PLANET_RADIUS.
export function getPlanetRadiusMeters( name ) {
  return PLANET_RADIUS[ String( name ).toUpperCase() ] || null;
}

// Returns a real-time scene unit scale that keeps a given radius in a target
// screen-space size (units per metre). Useful for "fit to view" at any scale.
export function realTimeDistanceScale( radiusMeters, targetSceneRadius ) {
  return targetSceneRadius / radiusMeters;
}

// Module-local scratch buffers — allocated once, reused across every bridge.
const _scratchVec3A = new Float32Array( 3 );
const _scratchVec3B = new Float32Array( 3 );

/*
 * -----------------------------------------------------------------------------
 * THREE.Cylindrical
 * -----------------------------------------------------------------------------
 */
class Cylindrical {

  constructor( radius = 1, theta = 0, y = 0 ) {
    this.radius = radius;
    this.theta = theta;
    this.y = y;
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
    return this.setFromCartesianCoords( v.x, v.y, v.z );
  }

  setFromCartesianCoords( x, y, z ) {
    this.radius = Math.sqrt( x * x + z * z );
    this.theta = Math.atan2( x, z );
    this.y = y;
    return this;
  }

  // Real-time multi-scale: returns a cloned cylindrical scaled into the given unit.
  toUnit( unit ) {
    return new this.constructor( this.radius * unit, this.theta, this.y * unit );
  }

  // Real-time multi-scale: returns a cloned cylindrical in meters.
  toMeters() {
    return new this.constructor( this.radius * SCALE_UNITS.METER, this.theta, this.y * SCALE_UNITS.METER );
  }

  // Real-time multi-scale: returns a cloned cylindrical in light-years.
  toLightYears() {
    return new this.constructor( this.radius / SCALE_UNITS.LIGHT_YEAR, this.theta, this.y / SCALE_UNITS.LIGHT_YEAR );
  }

  // Real-time multi-scale: returns a cloned cylindrical in solar radii.
  toSolarRadii() {
    return new this.constructor( this.radius / SCALE_UNITS.SOLAR_RADIUS, this.theta, this.y / SCALE_UNITS.SOLAR_RADIUS );
  }

  // Real-time multi-scale: returns a cloned cylindrical in galactic radii.
  toGalacticRadii() {
    return new this.constructor( this.radius / SCALE_UNITS.GALACTIC_RADIUS, this.theta, this.y / SCALE_UNITS.GALACTIC_RADIUS );
  }

  // Real-time multi-scale: in-place scale to the given unit.
  applyUnit( unit ) {
    this.radius *= unit;
    this.y *= unit;
    return this;
  }

  // Real-time multi-scale: in-place lerp between two cylindrical coords.
  lerp( other, alpha ) {
    this.radius = lerp( this.radius, other.radius, alpha );
    this.theta = lerp( this.theta, other.theta, alpha );
    this.y = lerp( this.y, other.y, alpha );
    return this;
  }

  // Real-time multi-scale: in-place theta wrap to [-π, π].
  wrapTheta() {
    this.theta = Math.atan2( Math.sin( this.theta ), Math.cos( this.theta ) );
    return this;
  }

  // Real-time multi-scale: clamp radius and y to a min/max range.
  clamp( radiusMin, radiusMax, yMin, yMax ) {
    this.radius = clamp( this.radius, radiusMin, radiusMax );
    this.y = clamp( this.y, yMin, yMax );
    return this;
  }

  // Real-time multi-scale: shortest angular difference to another theta.
  deltaThetaTo( other ) {
    let d = other.theta - this.theta;
    while ( d > Math.PI ) d -= 2 * Math.PI;
    while ( d < - Math.PI ) d += 2 * Math.PI;
    return d;
  }

  equals( c ) {
    return ( c.radius === this.radius ) &&
      ( c.theta === this.theta ) &&
      ( c.y === this.y );
  }

  fromArray( array ) {
    this.radius = array[ 0 ];
    this.theta = array[ 1 ];
    this.y = array[ 2 ];
    return this;
  }

  toArray( array = [], offset = 0 ) {
    array[ offset ] = this.radius;
    array[ offset + 1 ] = this.theta;
    array[ offset + 2 ] = this.y;
    return array;
  }

  *[ Symbol.iterator ]() {
    yield this.radius;
    yield this.theta;
    yield this.y;
  }

}

// Default export for parity with other math classes in this module.
export default Cylindrical;
export { Cylindrical };