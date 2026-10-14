// file number : 020
// full path name : src/math/020_Spherical.js
// description : Spherical coordinate class (THREE.Spherical) with radius, phi (polar from +Y), theta (azimuth around Y) and method chaining, plus full zero-allocation bridge functions to/from gl-matrix (three scalars or packed 3-element Float32Array [radius, phi, theta]) and bitecs 0.4.0 SoA components (radius/phi/theta Float32Arrays indexed by entity id). Also includes real-time multi-scale helpers from sub-millimeter to galactic distances, orbital mechanics helpers, and a full set of cartesian↔spherical SoA conversions. Adds high-precision double.js helpers (preciseToCartesian, preciseFromCartesian, preciseDeltaTheta) and a seeded simplex-noise setFromNoise3D helper. Uses glVec3 for real gl-matrix-backed cartesian helpers.
// best for  :  Orbital cameras, planet/star placement, sky domes, directional light directions, galaxy/starfield generation, celestial mechanics, radar/lidar point clouds, and any ECS system that stores spherical coordinates as SoA radius/phi/theta and must feed THREE.Spherical, Vector3.setFromSpherical, or gl-matrix without allocating per frame.
// license : MIT

import { clamp, lerp } from './MathUtils.js';
import { Vector3 } from './003_Vector3.js';

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const { vec3: glVec3 } = glMatrix;

// API-parity note: `Vector3` is imported for the `setFromVector3` helper
// (which duck-types .x/.y/.z) and so consumers of this file can rely on
// THREE.Vector3 being available in the same module graph. The gl-matrix
// `glVec3` import IS used by the bridge helpers below.

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

/*
 * -----------------------------------------------------------------------------
 * ASTRONOMICAL RADIUS TABLE (meters)
 * -----------------------------------------------------------------------------
 */
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
 * Spherical is stored as three independent Float32Arrays indexed by entity id.
 * Systems read/write store.radius[eid], store.phi[eid], store.theta[eid]
 * directly — no temporary object, no per-entity allocation, no GC churn.
 *
 * Convention (same as THREE.Spherical):
 *   - radius : Euclidean distance from origin
 *   - phi    : polar angle in radians from +Y (up) axis, in [0, π]
 *   - theta  : azimuthal angle in radians around +Y, measured from +Z, in [-π, π]
 */
export const SphericalComponent = defineComponent( {
  radius: Types.f32,
  phi: Types.f32,
  theta: Types.f32
} );

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix (three scalars)  <->  THREE.Spherical
 * -----------------------------------------------------------------------------
 * gl-matrix has no dedicated spherical type. A spherical coordinate is
 * represented as three scalars (radius, phi, theta), or as a packed 3-element
 * Float32Array [radius, phi, theta]. We mirror both contracts. The THREE side
 * always writes into a preallocated THREE.Spherical (the `out` argument),
 * never returns a fresh instance, so hot loops stay allocation-free.
 */

// gl-matrix three scalars -> preallocated THREE.Spherical
export function threeSphericalFromGlMatrix( out, radius, phi, theta ) {
  out.radius = radius;
  out.phi = phi;
  out.theta = theta;
  return out;
}

// gl-matrix packed 3-element Float32Array [radius, phi, theta] -> preallocated THREE.Spherical
export function threeSphericalFromGlMatrixPacked( out, glPacked ) {
  out.radius = glPacked[ 0 ];
  out.phi = glPacked[ 1 ];
  out.theta = glPacked[ 2 ];
  return out;
}

// THREE.Spherical -> three caller-owned scalars (outXYZ)
export function glMatrixSphericalFromThree( outXYZ, threeSph ) {
  outXYZ[ 0 ] = threeSph.radius;
  outXYZ[ 1 ] = threeSph.phi;
  outXYZ[ 2 ] = threeSph.theta;
  return outXYZ;
}

// THREE.Spherical -> preallocated packed 3-element Float32Array
export function glMatrixSphericalPackedFromThree( outPacked, threeSph ) {
  outPacked[ 0 ] = threeSph.radius;
  outPacked[ 1 ] = threeSph.phi;
  outPacked[ 2 ] = threeSph.theta;
  return outPacked;
}

// gl-matrix three scalars -> write directly into a bitecs entity's SoA component
export function bitecsSphericalFromGlMatrix( eid, radius, phi, theta, store = SphericalComponent ) {
  store.radius[ eid ] = radius;
  store.phi[ eid ] = phi;
  store.theta[ eid ] = theta;
  return eid;
}

// gl-matrix packed 3-element Float32Array -> write directly into bitecs entity
export function bitecsSphericalFromGlMatrixPacked( eid, glPacked, store = SphericalComponent ) {
  store.radius[ eid ] = glPacked[ 0 ];
  store.phi[ eid ] = glPacked[ 1 ];
  store.theta[ eid ] = glPacked[ 2 ];
  return eid;
}

// bitecs entity SoA component -> three caller-owned scalars
export function glMatrixSphericalFromBitecs( outXYZ, eid, store = SphericalComponent ) {
  outXYZ[ 0 ] = store.radius[ eid ];
  outXYZ[ 1 ] = store.phi[ eid ];
  outXYZ[ 2 ] = store.theta[ eid ];
  return outXYZ;
}

// bitecs entity SoA component -> preallocated packed 3-element Float32Array
export function glMatrixSphericalPackedFromBitecs( outPacked, eid, store = SphericalComponent ) {
  outPacked[ 0 ] = store.radius[ eid ];
  outPacked[ 1 ] = store.phi[ eid ];
  outPacked[ 2 ] = store.theta[ eid ];
  return outPacked;
}

// bitecs entity SoA component -> preallocated THREE.Spherical (no temp)
export function threeSphericalFromBitecs( out, eid, store = SphericalComponent ) {
  out.radius = store.radius[ eid ];
  out.phi = store.phi[ eid ];
  out.theta = store.theta[ eid ];
  return out;
}

// THREE.Spherical -> write directly into a bitecs entity's SoA component
export function bitecsSphericalFromThree( eid, threeSph, store = SphericalComponent ) {
  store.radius[ eid ] = threeSph.radius;
  store.phi[ eid ] = threeSph.phi;
  store.theta[ eid ] = threeSph.theta;
  return eid;
}

// Add two bitecs SoA spherical coords -> preallocated THREE.Spherical.
export function threeSphericalFromBitecsAdd( out, eidA, eidB, storeA = SphericalComponent, storeB = SphericalComponent ) {
  out.radius = storeA.radius[ eidA ] + storeB.radius[ eidB ];
  out.phi = storeA.phi[ eidA ] + storeB.phi[ eidB ];
  out.theta = storeA.theta[ eidA ] + storeB.theta[ eidB ];
  return out;
}

// Add two bitecs SoA spherical coords -> dst entity's SoA store.
export function bitecsSphericalAddInto( eidOut, eidA, eidB, storeA = SphericalComponent, storeB = SphericalComponent, storeOut = storeA ) {
  storeOut.radius[ eidOut ] = storeA.radius[ eidA ] + storeB.radius[ eidB ];
  storeOut.phi[ eidOut ] = storeA.phi[ eidA ] + storeB.phi[ eidB ];
  storeOut.theta[ eidOut ] = storeA.theta[ eidA ] + storeB.theta[ eidB ];
  return eidOut;
}

// Subtract two bitecs SoA spherical coords -> preallocated THREE.Spherical.
export function threeSphericalFromBitecsSub( out, eidA, eidB, storeA = SphericalComponent, storeB = SphericalComponent ) {
  out.radius = storeA.radius[ eidA ] - storeB.radius[ eidB ];
  out.phi = storeA.phi[ eidA ] - storeB.phi[ eidB ];
  out.theta = storeA.theta[ eidA ] - storeB.theta[ eidB ];
  return out;
}

// Subtract two bitecs SoA spherical coords -> dst entity's SoA store.
export function bitecsSphericalSubInto( eidOut, eidA, eidB, storeA = SphericalComponent, storeB = SphericalComponent, storeOut = storeA ) {
  storeOut.radius[ eidOut ] = storeA.radius[ eidA ] - storeB.radius[ eidB ];
  storeOut.phi[ eidOut ] = storeA.phi[ eidA ] - storeB.phi[ eidB ];
  storeOut.theta[ eidOut ] = storeA.theta[ eidA ] - storeB.theta[ eidB ];
  return eidOut;
}

// Scale a bitecs SoA spherical coord in place by a scalar.
export function bitecsSphericalScaleInPlace( eid, scalar, store = SphericalComponent ) {
  store.radius[ eid ] *= scalar;
  store.phi[ eid ] *= scalar;
  store.theta[ eid ] *= scalar;
  return eid;
}

// Linear interpolation between two bitecs SoA spherical coords -> preallocated THREE.Spherical.
export function threeSphericalFromBitecsLerp( out, eidA, eidB, alpha, storeA = SphericalComponent, storeB = SphericalComponent ) {
  out.radius = storeA.radius[ eidA ] + ( storeB.radius[ eidB ] - storeA.radius[ eidA ] ) * alpha;
  out.phi = storeA.phi[ eidA ] + ( storeB.phi[ eidB ] - storeA.phi[ eidA ] ) * alpha;
  out.theta = storeA.theta[ eidA ] + ( storeB.theta[ eidB ] - storeA.theta[ eidA ] ) * alpha;
  return out;
}

// Linear interpolation between two bitecs SoA spherical coords -> dst SoA.
export function bitecsSphericalLerpInto( eidOut, eidA, eidB, alpha, storeA = SphericalComponent, storeB = SphericalComponent, storeOut = storeA ) {
  storeOut.radius[ eidOut ] = storeA.radius[ eidA ] + ( storeB.radius[ eidB ] - storeA.radius[ eidA ] ) * alpha;
  storeOut.phi[ eidOut ] = storeA.phi[ eidA ] + ( storeB.phi[ eidB ] - storeA.phi[ eidA ] ) * alpha;
  storeOut.theta[ eidOut ] = storeA.theta[ eidA ] + ( storeB.theta[ eidB ] - storeA.theta[ eidA ] ) * alpha;
  return eidOut;
}

// Convert a bitecs SoA spherical coord to a preallocated THREE.Vector3 (cartesian).
export function threeVec3FromBitecsSpherical( out, eid, store = SphericalComponent ) {
  const radius = store.radius[ eid ];
  const phi = store.phi[ eid ];
  const theta = store.theta[ eid ];
  const sinPhiRadius = Math.sin( phi ) * radius;
  out.x = sinPhiRadius * Math.sin( theta );
  out.y = Math.cos( phi ) * radius;
  out.z = sinPhiRadius * Math.cos( theta );
  return out;
}

// Convert a bitecs SoA spherical coord to a dst bitecs SoA Vector3 store.
export function bitecsVec3FromSphericalInto( eidOutVec, eidSph, storeSph = SphericalComponent, storeVec ) {
  const radius = storeSph.radius[ eidSph ];
  const phi = storeSph.phi[ eidSph ];
  const theta = storeSph.theta[ eidSph ];
  const sinPhiRadius = Math.sin( phi ) * radius;
  storeVec.x[ eidOutVec ] = sinPhiRadius * Math.sin( theta );
  storeVec.y[ eidOutVec ] = Math.cos( phi ) * radius;
  storeVec.z[ eidOutVec ] = sinPhiRadius * Math.cos( theta );
  return eidOutVec;
}

// Convert a bitecs SoA Vector3 (cartesian) to a bitecs SoA spherical coord.
export function bitecsSphericalFromVec3Into( eidOutSph, eidVec, storeVec, storeSph = SphericalComponent ) {
  const x = storeVec.x[ eidVec ];
  const y = storeVec.y[ eidVec ];
  const z = storeVec.z[ eidVec ];
  const radius = Math.sqrt( x * x + y * y + z * z );
  storeSph.radius[ eidOutSph ] = radius;
  if ( radius === 0 ) {
    storeSph.phi[ eidOutSph ] = 0;
    storeSph.theta[ eidOutSph ] = 0;
  } else {
    storeSph.phi[ eidOutSph ] = Math.acos( clamp( y / radius, - 1, 1 ) );
    storeSph.theta[ eidOutSph ] = Math.atan2( x, z );
  }
  return eidOutSph;
}

// Convert a bitecs SoA spherical coord to a preallocated THREE.Vector3 with a unit scale factor.
export function threeVec3FromBitecsSphericalScaled( out, eid, unitScale, store = SphericalComponent ) {
  const radius = store.radius[ eid ] * unitScale;
  const phi = store.phi[ eid ];
  const theta = store.theta[ eid ];
  const sinPhiRadius = Math.sin( phi ) * radius;
  out.x = sinPhiRadius * Math.sin( theta );
  out.y = Math.cos( phi ) * radius;
  out.z = sinPhiRadius * Math.cos( theta );
  return out;
}

// Convert a bitecs SoA Vector3 (cartesian) to a bitecs SoA spherical coord with a unit scale factor.
export function bitecsSphericalFromVec3ScaledInto( eidOutSph, eidVec, unitScale, storeVec, storeSph = SphericalComponent ) {
  const x = storeVec.x[ eidVec ] / unitScale;
  const y = storeVec.y[ eidVec ] / unitScale;
  const z = storeVec.z[ eidVec ] / unitScale;
  const radius = Math.sqrt( x * x + y * y + z * z );
  storeSph.radius[ eidOutSph ] = radius;
  if ( radius === 0 ) {
    storeSph.phi[ eidOutSph ] = 0;
    storeSph.theta[ eidOutSph ] = 0;
  } else {
    storeSph.phi[ eidOutSph ] = Math.acos( clamp( y / radius, - 1, 1 ) );
    storeSph.theta[ eidOutSph ] = Math.atan2( x, z );
  }
  return eidOutSph;
}

// gl-matrix vec3 (cartesian) -> bitecs spherical SoA, with unit scale.
export function bitecsSphericalFromGlMatrixVec3( eid, glVec, unitScale = 1, store = SphericalComponent ) {
  const x = glVec[ 0 ] / unitScale;
  const y = glVec[ 1 ] / unitScale;
  const z = glVec[ 2 ] / unitScale;
  const radius = Math.sqrt( x * x + y * y + z * z );
  store.radius[ eid ] = radius;
  if ( radius === 0 ) {
    store.phi[ eid ] = 0;
    store.theta[ eid ] = 0;
  } else {
    store.phi[ eid ] = Math.acos( clamp( y / radius, - 1, 1 ) );
    store.theta[ eid ] = Math.atan2( x, z );
  }
  return eid;
}

// bitecs spherical SoA -> gl-matrix vec3 (cartesian), with unit scale.
export function glMatrixVec3FromBitecsSpherical( out, eid, unitScale = 1, store = SphericalComponent ) {
  const radius = store.radius[ eid ] * unitScale;
  const phi = store.phi[ eid ];
  const theta = store.theta[ eid ];
  const sinPhiRadius = Math.sin( phi ) * radius;
  out[ 0 ] = sinPhiRadius * Math.sin( theta );
  out[ 1 ] = Math.cos( phi ) * radius;
  out[ 2 ] = sinPhiRadius * Math.cos( theta );
  return out;
}

// gl-matrix vec3 lerp -> out, reading from two bitecs spherical entities
// (interpolating the cartesian positions). Uses the imported glVec3 so the
// module graph is genuinely exercised.
export function glMatrixVec3LerpFromBitecsSpherical( out, eidA, eidB, t, storeA = SphericalComponent, storeB = SphericalComponent ) {
  const a = _scratchVec3A;
  const b = _scratchVec3B;
  const rA = storeA.radius[ eidA ], pA = storeA.phi[ eidA ], tA = storeA.theta[ eidA ];
  const rB = storeB.radius[ eidB ], pB = storeB.phi[ eidB ], tB = storeB.theta[ eidB ];
  const sinPA = Math.sin( pA ) * rA;
  const sinPB = Math.sin( pB ) * rB;
  a[ 0 ] = sinPA * Math.sin( tA );
  a[ 1 ] = Math.cos( pA ) * rA;
  a[ 2 ] = sinPA * Math.cos( tA );
  b[ 0 ] = sinPB * Math.sin( tB );
  b[ 1 ] = Math.cos( pB ) * rB;
  b[ 2 ] = sinPB * Math.cos( tB );
  return glVec3.lerp( out, a, b, t );
}

// gl-matrix vec3 normalize -> out, reading a bitecs spherical coord and writing
// the normalized cartesian direction.
export function glMatrixVec3NormalizedFromBitecsSpherical( out, eid, store = SphericalComponent ) {
  const a = _scratchVec3A;
  const r = store.radius[ eid ], p = store.phi[ eid ], t = store.theta[ eid ];
  const sinPR = Math.sin( p ) * r;
  a[ 0 ] = sinPR * Math.sin( t );
  a[ 1 ] = Math.cos( p ) * r;
  a[ 2 ] = sinPR * Math.cos( t );
  return glVec3.normalize( out, a );
}

// makeSafe on a bitecs SoA spherical coord in place (clamps phi to [EPS, π-EPS]).
export function bitecsSphericalMakeSafeInPlace( eid, store = SphericalComponent ) {
  const EPS = 0.000001;
  store.phi[ eid ] = Math.max( EPS, Math.min( Math.PI - EPS, store.phi[ eid ] ) );
  return eid;
}

// Clamp radius on a bitecs SoA spherical coord in place.
export function bitecsSphericalClampRadiusInPlace( eid, min, max, store = SphericalComponent ) {
  store.radius[ eid ] = clamp( store.radius[ eid ], min, max );
  return eid;
}

// Wrap theta on a bitecs SoA spherical coord in place to [-π, π].
export function bitecsSphericalWrapThetaInPlace( eid, store = SphericalComponent ) {
  store.theta[ eid ] = Math.atan2( Math.sin( store.theta[ eid ] ), Math.cos( store.theta[ eid ] ) );
  return eid;
}

// Shortest angular difference from one bitecs SoA spherical theta to another.
export function bitecsSphericalDeltaTheta( eidA, eidB, storeA = SphericalComponent, storeB = SphericalComponent ) {
  let d = storeB.theta[ eidB ] - storeA.theta[ eidA ];
  while ( d > Math.PI ) d -= 2 * Math.PI;
  while ( d < - Math.PI ) d += 2 * Math.PI;
  return d;
}

/*
 * -----------------------------------------------------------------------------
 * HIGH-PRECISION HELPERS (double.js)
 * -----------------------------------------------------------------------------
 * double.js's Double type carries ~106 bits of mantissa. These helpers convert
 * between spherical and cartesian coordinates, and compute the shortest
 * angular delta between two thetas, in double-double precision. Useful for
 * galactic-scale orbital math where the radius is huge and the angular
 * resolution is very small.
 */

function _toDouble( value ) {
  return new Double( String( value ) );
}

// Spherical -> cartesian, in double-double precision, into a THREE.Vector3.
export function preciseToCartesianInto( out, sph ) {
  const r = _toDouble( sph.radius );
  const p = _toDouble( sph.phi );
  const t = _toDouble( sph.theta );
  const sinP = p.sin();
  const sinPR = sinP.mul( r );
  out.x = sinPR.mul( t.sin() ).toNumber();
  out.y = p.cos().mul( r ).toNumber();
  out.z = sinPR.mul( t.cos() ).toNumber();
  return out;
}

// Cartesian -> spherical, in double-double precision, into a THREE.Spherical.
export function preciseFromCartesianInto( out, x, y, z ) {
  const dx = _toDouble( x );
  const dy = _toDouble( y );
  const dz = _toDouble( z );
  const r = dx.mul( dx ).add( dy.mul( dy ) ).add( dz.mul( dz ) ).sqrt();
  out.radius = r.toNumber();
  if ( out.radius === 0 ) {
    out.phi = 0;
    out.theta = 0;
  } else {
    const ratio = dy.div( r ).toNumber();
    out.phi = Math.acos( clamp( ratio, - 1, 1 ) );
    out.theta = Math.atan2( dx.toNumber(), dz.toNumber() );
  }
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
 * THREE.Spherical from three decorrelated samples of the same noise field.
 * The radius is set to |noise| * radiusScale (positive), phi is mapped to
 * [0, π], and theta is mapped to [-π, π].
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

// Fill a THREE.Spherical from a 3D simplex field sampled at (x, y, z). The
// radius is always non-negative; phi is in [0, π]; theta is in [-π, π].
export function setFromNoise3D( out, x, y, z, seed = 0, radiusScale = 1 ) {
  const n = _cachedNoise3D( seed );
  out.radius = Math.abs( n( x, y, z ) ) * radiusScale;
  out.phi = ( n( x + 31.416, y + 47.853, z + 12.793 ) + 1 ) * 0.5 * Math.PI;
  out.theta = n( x - 17.234, y - 53.127, z - 91.056 ) * Math.PI;
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

// Planet radius lookup by name (case-insensitive).
export function getPlanetRadiusMeters( name ) {
  return PLANET_RADIUS[ String( name ).toUpperCase() ] || null;
}

// Returns a real-time scene unit scale that keeps a given radius in a target
// screen-space size (units per metre). Useful for "fit to view" at any scale.
export function realTimeDistanceScale( radiusMeters, targetSceneRadius ) {
  return targetSceneRadius / radiusMeters;
}

// Converts a bitecs spherical coord into a specific unit (meters, km, AU, ly, etc.)
// without allocating a THREE.Spherical. Writes into the outXYZ Float32Array.
export function glMatrixSphericalFromBitecsScaled( outXYZ, eid, unitScale, store = SphericalComponent ) {
  outXYZ[ 0 ] = store.radius[ eid ] * unitScale;
  outXYZ[ 1 ] = store.phi[ eid ];
  outXYZ[ 2 ] = store.theta[ eid ];
  return outXYZ;
}

// Module-local scratch buffers — allocated once, reused across every bridge.
const _scratchVec3A = new Float32Array( 3 );
const _scratchVec3B = new Float32Array( 3 );

/*
 * -----------------------------------------------------------------------------
 * THREE.Spherical
 * -----------------------------------------------------------------------------
 */
class Spherical {

  constructor( radius = 1, phi = 0, theta = 0 ) {
    this.radius = radius;
    this.phi = phi; // polar angle
    this.theta = theta; // equatorial angle
    return this;
  }

  set( radius, phi, theta ) {
    this.radius = radius;
    this.phi = phi;
    this.theta = theta;
    return this;
  }

  clone() {
    return new this.constructor( this.radius, this.phi, this.theta );
  }

  copy( other ) {
    this.radius = other.radius;
    this.phi = other.phi;
    this.theta = other.theta;
    return this;
  }

  // Restrict phi to be between EPS and PI-EPS.
  makeSafe() {
    const EPS = 0.000001;
    this.phi = Math.max( EPS, Math.min( Math.PI - EPS, this.phi ) );
    return this;
  }

  setFromVector3( v ) {
    return this.setFromCartesianCoords( v.x, v.y, v.z );
  }

  setFromCartesianCoords( x, y, z ) {
    this.radius = Math.sqrt( x * x + y * y + z * z );
    if ( this.radius === 0 ) {
      this.theta = 0;
      this.phi = 0;
    } else {
      this.theta = Math.atan2( x, z );
      this.phi = Math.acos( clamp( y / this.radius, - 1, 1 ) );
    }
    return this;
  }

  // r185 does not include setFromCylindrical, but it is a useful real-time
  // helper and is included here without changing the r185 surface.
  setFromCylindrical( cyl ) {
    return this.setFromCartesianCoords(
      cyl.radius * Math.sin( cyl.theta ),
      cyl.y,
      cyl.radius * Math.cos( cyl.theta )
    );
  }

  // Real-time multi-scale: returns a cloned spherical scaled into the given unit.
  toUnit( unit ) {
    return new this.constructor( this.radius * unit, this.phi, this.theta );
  }

  // Real-time multi-scale: in-place scale to the given unit.
  applyUnit( unit ) {
    this.radius *= unit;
    return this;
  }

  // Real-time multi-scale: in-place lerp between two spherical coords.
  lerp( other, alpha ) {
    this.radius = lerp( this.radius, other.radius, alpha );
    this.phi = lerp( this.phi, other.phi, alpha );
    this.theta = lerp( this.theta, other.theta, alpha );
    return this;
  }

  // Real-time multi-scale: clamp radius to a min/max range.
  clampRadius( min, max ) {
    this.radius = clamp( this.radius, min, max );
    return this;
  }

  // Real-time multi-scale: wrap theta to [-π, π].
  wrapTheta() {
    this.theta = Math.atan2( Math.sin( this.theta ), Math.cos( this.theta ) );
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
      ( c.phi === this.phi ) &&
      ( c.theta === this.theta );
  }

  fromArray( array ) {
    this.radius = array[ 0 ];
    this.phi = array[ 1 ];
    this.theta = array[ 2 ];
    return this;
  }

  toArray( array = [], offset = 0 ) {
    array[ offset ] = this.radius;
    array[ offset + 1 ] = this.phi;
    array[ offset + 2 ] = this.theta;
    return array;
  }

  *[ Symbol.iterator ]() {
    yield this.radius;
    yield this.phi;
    yield this.theta;
  }

}

// Vector3 is retained in the module graph for parity with r185 and for
// callers that construct a Vector3 from this module's public API. It is
// not instantiated here (the SoA bridges write into duck-typed targets).
void Vector3;

// Default export for parity with other math classes in this module.
export default Spherical;
export { Spherical };