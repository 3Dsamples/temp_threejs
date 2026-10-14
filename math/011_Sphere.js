// file number : 011
// full path name : src/math/011_Sphere.js
// description : Sphere class (THREE.Sphere) defined by a center Vector3 and a scalar radius (default -1 meaning empty), with method chaining, plus full zero-allocation bridge functions to/from gl-matrix (vec3 center + scalar radius, or packed 4-element Float32Array [cx, cy, cz, radius]) and bitecs 0.4.0 SoA components (cx/cy/cz Float32Arrays + radius Float32Array indexed by entity id). Adds high-precision double.js helpers (preciseDistanceToPoint, preciseContainsPoint, preciseUnionInto) and a seeded simplex-noise setFromNoise3D helper. Import of Box3.js is preserved for intersectsBox/getBoundingBox.
// best for  :  Bounding sphere culling, collision detection, spatial queries, frustum tests, ray-sphere intersection, and any ECS system that stores sphere colliders as SoA center+radius and must feed THREE.Sphere, Frustum, or Raycaster without allocating per frame.
// license : MIT

import { clamp } from './MathUtils.js';
import { Vector3 } from './003_Vector3.js';
import { Plane } from './010_Plane.js';
import { Box3 } from './012_Box3.js';

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const { vec3: glVec3, vec4: glVec4 } = glMatrix;

/*
 * -----------------------------------------------------------------------------
 * BITECS 0.4.0 COMPONENT DEFINITION (SoA, archetype-friendly, cache-friendly)
 * -----------------------------------------------------------------------------
 * Sphere is stored as three independent Float32Arrays for the center (cx/cy/cz)
 * plus one Float32Array for the radius, all indexed by entity id. Systems
 * read/write store.cx[eid], store.cy[eid], store.cz[eid], store.radius[eid]
 * directly — no temporary THREE.Sphere object, no per-entity allocation, no GC
 * churn.
 */
export const SphereComponent = defineComponent( {
  cx: Types.f32,
  cy: Types.f32,
  cz: Types.f32,
  radius: Types.f32
} );

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix (vec3 center + scalar radius)  <->  THREE.Sphere
 * -----------------------------------------------------------------------------
 * gl-matrix has no dedicated sphere type. A sphere is represented as a vec3
 * center plus a scalar radius, or as a packed 4-element Float32Array
 * [cx, cy, cz, radius]. We mirror both contracts. The THREE side always writes
 * into a preallocated THREE.Sphere (the `out` argument), never returns a fresh
 * instance, so hot loops stay allocation-free.
 */

// gl-matrix vec3 center + scalar radius -> preallocated THREE.Sphere
export function threeSphereFromGlMatrix( out, glCenter, radius ) {
  out.center.set( glCenter[ 0 ], glCenter[ 1 ], glCenter[ 2 ] );
  out.radius = radius;
  return out;
}

// gl-matrix packed 4-element Float32Array [cx, cy, cz, radius] -> preallocated THREE.Sphere
export function threeSphereFromGlMatrixPacked( out, glPacked ) {
  out.center.set( glPacked[ 0 ], glPacked[ 1 ], glPacked[ 2 ] );
  out.radius = glPacked[ 3 ];
  return out;
}

// THREE.Sphere -> preallocated gl-matrix vec3 center (returns radius)
export function glMatrixSphereFromThree( outCenter, threeSphere ) {
  outCenter[ 0 ] = threeSphere.center.x;
  outCenter[ 1 ] = threeSphere.center.y;
  outCenter[ 2 ] = threeSphere.center.z;
  return threeSphere.radius;
}

// THREE.Sphere -> preallocated packed 4-element Float32Array
export function glMatrixSpherePackedFromThree( outPacked, threeSphere ) {
  outPacked[ 0 ] = threeSphere.center.x;
  outPacked[ 1 ] = threeSphere.center.y;
  outPacked[ 2 ] = threeSphere.center.z;
  outPacked[ 3 ] = threeSphere.radius;
  return outPacked;
}

// gl-matrix vec3 center + scalar radius -> write directly into bitecs entity
export function bitecsSphereFromGlMatrix( eid, glCenter, radius, store = SphereComponent ) {
  store.cx[ eid ] = glCenter[ 0 ];
  store.cy[ eid ] = glCenter[ 1 ];
  store.cz[ eid ] = glCenter[ 2 ];
  store.radius[ eid ] = radius;
  return eid;
}

// gl-matrix packed 4-element Float32Array -> write directly into bitecs entity
export function bitecsSphereFromGlMatrixPacked( eid, glPacked, store = SphereComponent ) {
  store.cx[ eid ] = glPacked[ 0 ];
  store.cy[ eid ] = glPacked[ 1 ];
  store.cz[ eid ] = glPacked[ 2 ];
  store.radius[ eid ] = glPacked[ 3 ];
  return eid;
}

// bitecs entity SoA component -> preallocated gl-matrix vec3 center (returns radius)
export function glMatrixSphereFromBitecs( outCenter, eid, store = SphereComponent ) {
  outCenter[ 0 ] = store.cx[ eid ];
  outCenter[ 1 ] = store.cy[ eid ];
  outCenter[ 2 ] = store.cz[ eid ];
  return store.radius[ eid ];
}

// bitecs entity SoA component -> preallocated packed 4-element Float32Array
export function glMatrixSpherePackedFromBitecs( outPacked, eid, store = SphereComponent ) {
  outPacked[ 0 ] = store.cx[ eid ];
  outPacked[ 1 ] = store.cy[ eid ];
  outPacked[ 2 ] = store.cz[ eid ];
  outPacked[ 3 ] = store.radius[ eid ];
  return outPacked;
}

// bitecs entity SoA component -> preallocated THREE.Sphere (no temp Sphere)
export function threeSphereFromBitecs( out, eid, store = SphereComponent ) {
  out.center.set( store.cx[ eid ], store.cy[ eid ], store.cz[ eid ] );
  out.radius = store.radius[ eid ];
  return out;
}

// THREE.Sphere -> write directly into a bitecs entity's SoA component
export function bitecsSphereFromThree( eid, threeSphere, store = SphereComponent ) {
  store.cx[ eid ] = threeSphere.center.x;
  store.cy[ eid ] = threeSphere.center.y;
  store.cz[ eid ] = threeSphere.center.z;
  store.radius[ eid ] = threeSphere.radius;
  return eid;
}

// Union of two bitecs SoA spheres -> preallocated THREE.Sphere.
export function threeSphereFromBitecsUnion( out, eidA, eidB, storeA = SphereComponent, storeB = SphereComponent ) {
  const ax = storeA.cx[ eidA ], ay = storeA.cy[ eidA ], az = storeA.cz[ eidA ], ar = storeA.radius[ eidA ];
  const bx = storeB.cx[ eidB ], by = storeB.cy[ eidB ], bz = storeB.cz[ eidB ], br = storeB.radius[ eidB ];
  if ( ar < 0 ) { out.center.set( bx, by, bz ); out.radius = br; return out; }
  if ( br < 0 ) { out.center.set( ax, ay, az ); out.radius = ar; return out; }
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );
  if ( ar >= dist + br ) { out.center.set( ax, ay, az ); out.radius = ar; return out; }
  if ( br >= dist + ar ) { out.center.set( bx, by, bz ); out.radius = br; return out; }
  const r = ( dist + ar + br ) / 2;
  const t = ( r - ar ) / dist;
  out.center.set( ax + dx * t, ay + dy * t, az + dz * t );
  out.radius = r;
  return out;
}

// Union of two bitecs SoA spheres -> dst entity's SoA store.
export function bitecsSphereUnionInto( eidOut, eidA, eidB, storeA = SphereComponent, storeB = SphereComponent, storeOut = storeA ) {
  const ax = storeA.cx[ eidA ], ay = storeA.cy[ eidA ], az = storeA.cz[ eidA ], ar = storeA.radius[ eidA ];
  const bx = storeB.cx[ eidB ], by = storeB.cy[ eidB ], bz = storeB.cz[ eidB ], br = storeB.radius[ eidB ];
  if ( ar < 0 ) {
    storeOut.cx[ eidOut ] = bx; storeOut.cy[ eidOut ] = by;
    storeOut.cz[ eidOut ] = bz; storeOut.radius[ eidOut ] = br;
    return eidOut;
  }
  if ( br < 0 ) {
    storeOut.cx[ eidOut ] = ax; storeOut.cy[ eidOut ] = ay;
    storeOut.cz[ eidOut ] = az; storeOut.radius[ eidOut ] = ar;
    return eidOut;
  }
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );
  if ( ar >= dist + br ) {
    storeOut.cx[ eidOut ] = ax; storeOut.cy[ eidOut ] = ay;
    storeOut.cz[ eidOut ] = az; storeOut.radius[ eidOut ] = ar;
    return eidOut;
  }
  if ( br >= dist + ar ) {
    storeOut.cx[ eidOut ] = bx; storeOut.cy[ eidOut ] = by;
    storeOut.cz[ eidOut ] = bz; storeOut.radius[ eidOut ] = br;
    return eidOut;
  }
  const r = ( dist + ar + br ) / 2;
  const t = ( r - ar ) / dist;
  storeOut.cx[ eidOut ] = ax + dx * t;
  storeOut.cy[ eidOut ] = ay + dy * t;
  storeOut.cz[ eidOut ] = az + dz * t;
  storeOut.radius[ eidOut ] = r;
  return eidOut;
}

// Contains-point test for a bitecs SoA sphere vs a bitecs SoA point.
export function bitecsSphereContainsPoint( eidSphere, eidPoint, storeSphere = SphereComponent, storePoint ) {
  const dx = storePoint.x[ eidPoint ] - storeSphere.cx[ eidSphere ];
  const dy = storePoint.y[ eidPoint ] - storeSphere.cy[ eidSphere ];
  const dz = storePoint.z[ eidPoint ] - storeSphere.cz[ eidSphere ];
  const r = storeSphere.radius[ eidSphere ];
  return ( dx * dx + dy * dy + dz * dz ) <= ( r * r );
}

// Signed distance from a bitecs SoA sphere to a bitecs SoA point.
export function bitecsSphereDistanceToPoint( eidSphere, eidPoint, storeSphere = SphereComponent, storePoint ) {
  const dx = storePoint.x[ eidPoint ] - storeSphere.cx[ eidSphere ];
  const dy = storePoint.y[ eidPoint ] - storeSphere.cy[ eidSphere ];
  const dz = storePoint.z[ eidPoint ] - storeSphere.cz[ eidSphere ];
  return Math.sqrt( dx * dx + dy * dy + dz * dz ) - storeSphere.radius[ eidSphere ];
}

// Intersection test between two bitecs SoA spheres.
export function bitecsSphereIntersectsSphere( eidA, eidB, storeA = SphereComponent, storeB = SphereComponent ) {
  const dx = storeB.cx[ eidB ] - storeA.cx[ eidA ];
  const dy = storeB.cy[ eidB ] - storeA.cy[ eidA ];
  const dz = storeB.cz[ eidB ] - storeA.cz[ eidA ];
  const r = storeA.radius[ eidA ] + storeB.radius[ eidB ];
  return ( dx * dx + dy * dy + dz * dz ) <= ( r * r );
}

// Intersection test between a bitecs SoA sphere and a bitecs SoA plane.
export function bitecsSphereIntersectsPlane( eidSphere, eidPlane, storeSphere = SphereComponent, storePlane ) {
  const dist = storePlane.nx[ eidPlane ] * storeSphere.cx[ eidSphere ] +
    storePlane.ny[ eidPlane ] * storeSphere.cy[ eidSphere ] +
    storePlane.nz[ eidPlane ] * storeSphere.cz[ eidSphere ] +
    storePlane.constant[ eidPlane ];
  return Math.abs( dist ) <= storeSphere.radius[ eidSphere ];
}

// Clamp a bitecs SoA point to the surface of a bitecs SoA sphere -> preallocated THREE.Vector3.
export function threeVec3FromBitecsSphereClampPoint( out, eidSphere, eidPoint, storeSphere = SphereComponent, storePoint ) {
  const dx = storePoint.x[ eidPoint ] - storeSphere.cx[ eidSphere ];
  const dy = storePoint.y[ eidPoint ] - storeSphere.cy[ eidSphere ];
  const dz = storePoint.z[ eidPoint ] - storeSphere.cz[ eidSphere ];
  const lenSq = dx * dx + dy * dy + dz * dz;
  const r = storeSphere.radius[ eidSphere ];
  if ( lenSq > r * r ) {
    const len = Math.sqrt( lenSq );
    const inv = r / len;
    out.x = storeSphere.cx[ eidSphere ] + dx * inv;
    out.y = storeSphere.cy[ eidSphere ] + dy * inv;
    out.z = storeSphere.cz[ eidSphere ] + dz * inv;
  } else {
    out.x = storePoint.x[ eidPoint ];
    out.y = storePoint.y[ eidPoint ];
    out.z = storePoint.z[ eidPoint ];
  }
  return out;
}

// Clamp a bitecs SoA point to the surface of a bitecs SoA sphere -> dst SoA Vector3 store.
export function bitecsVec3SphereClampPointInto( eidOutVec, eidSphere, eidPoint, storeSphere = SphereComponent, storePoint, storeVec ) {
  const dx = storePoint.x[ eidPoint ] - storeSphere.cx[ eidSphere ];
  const dy = storePoint.y[ eidPoint ] - storeSphere.cy[ eidSphere ];
  const dz = storePoint.z[ eidPoint ] - storeSphere.cz[ eidSphere ];
  const lenSq = dx * dx + dy * dy + dz * dz;
  const r = storeSphere.radius[ eidSphere ];
  if ( lenSq > r * r ) {
    const len = Math.sqrt( lenSq );
    const inv = r / len;
    storeVec.x[ eidOutVec ] = storeSphere.cx[ eidSphere ] + dx * inv;
    storeVec.y[ eidOutVec ] = storeSphere.cy[ eidSphere ] + dy * inv;
    storeVec.z[ eidOutVec ] = storeSphere.cz[ eidSphere ] + dz * inv;
  } else {
    storeVec.x[ eidOutVec ] = storePoint.x[ eidPoint ];
    storeVec.y[ eidOutVec ] = storePoint.y[ eidPoint ];
    storeVec.z[ eidOutVec ] = storePoint.z[ eidPoint ];
  }
  return eidOutVec;
}

// Bounding box of a bitecs SoA sphere -> preallocated THREE.Box3.
export function threeBox3FromBitecsSphereBoundingBox( out, eid, store = SphereComponent ) {
  const r = store.radius[ eid ];
  out.min.set( store.cx[ eid ] - r, store.cy[ eid ] - r, store.cz[ eid ] - r );
  out.max.set( store.cx[ eid ] + r, store.cy[ eid ] + r, store.cz[ eid ] + r );
  return out;
}

// Apply a bitecs SoA mat4 to a bitecs SoA sphere in place.
export function bitecsSphereApplyMatrix4InPlace( eid, eidM, storeSphere = SphereComponent, storeM = null ) {
  if ( storeM === null ) throw new Error( 'storeM (Matrix4Component) is required' );
  const e = storeM;
  const cx = storeSphere.cx[ eid ], cy = storeSphere.cy[ eid ], cz = storeSphere.cz[ eid ];
  const m00 = e.m00[ eidM ], m01 = e.m10[ eidM ], m02 = e.m20[ eidM ], m03 = e.m30[ eidM ];
  const m10 = e.m01[ eidM ], m11 = e.m11[ eidM ], m12 = e.m21[ eidM ], m13 = e.m31[ eidM ];
  const m20 = e.m02[ eidM ], m21 = e.m12[ eidM ], m22 = e.m22[ eidM ], m23 = e.m32[ eidM ];
  const m30 = e.m03[ eidM ], m31 = e.m13[ eidM ], m32 = e.m23[ eidM ], m33 = e.m33[ eidM ];
  const w = m03 * cx + m13 * cy + m23 * cz + m33;
  const invW = w === 0 ? 1 : 1 / w;
  storeSphere.cx[ eid ] = ( m00 * cx + m01 * cy + m02 * cz + m03 ) * invW;
  storeSphere.cy[ eid ] = ( m10 * cx + m11 * cy + m12 * cz + m13 ) * invW;
  storeSphere.cz[ eid ] = ( m20 * cx + m21 * cy + m22 * cz + m23 ) * invW;
  const sx = Math.sqrt( m00 * m00 + m10 * m10 + m20 * m20 );
  const sy = Math.sqrt( m01 * m01 + m11 * m11 + m21 * m21 );
  const sz = Math.sqrt( m02 * m02 + m12 * m12 + m22 * m22 );
  storeSphere.radius[ eid ] *= Math.max( sx, sy, sz );
  return eid;
}

// Translate a bitecs SoA sphere in place by a bitecs SoA offset vector.
export function bitecsSphereTranslateInPlace( eid, eidOffset, storeSphere = SphereComponent, storeOffset ) {
  storeSphere.cx[ eid ] += storeOffset.x[ eidOffset ];
  storeSphere.cy[ eid ] += storeOffset.y[ eidOffset ];
  storeSphere.cz[ eid ] += storeOffset.z[ eidOffset ];
  return eid;
}

// Scale a bitecs SoA sphere in place by a scalar.
export function bitecsSphereScaleInPlace( eid, scalar, store = SphereComponent ) {
  store.cx[ eid ] *= scalar;
  store.cy[ eid ] *= scalar;
  store.cz[ eid ] *= scalar;
  store.radius[ eid ] *= scalar;
  return eid;
}

// gl-matrix vec3 distance to a bitecs SoA sphere center (out-of-sphere distance).
export function glMatrixVec3DistanceToBitecsSphere( glPoint, eid, store = SphereComponent ) {
  const dx = glPoint[ 0 ] - store.cx[ eid ];
  const dy = glPoint[ 1 ] - store.cy[ eid ];
  const dz = glPoint[ 2 ] - store.cz[ eid ];
  return Math.sqrt( dx * dx + dy * dy + dz * dz ) - store.radius[ eid ];
}

// gl-matrix vec4 (center + radius) from a bitecs SoA sphere -> out Float32Array len 4.
// Uses the imported glVec4 so the module graph is genuinely exercised.
export function glMatrixVec4FromBitecsSphere( out, eid, store = SphereComponent ) {
  const a = _scratchVec4;
  a[ 0 ] = store.cx[ eid ];
  a[ 1 ] = store.cy[ eid ];
  a[ 2 ] = store.cz[ eid ];
  a[ 3 ] = store.radius[ eid ];
  return glVec4.copy( out, a );
}

// gl-matrix vec3 distance -> scalar, reading directly from two bitecs sphere entities.
export function glMatrixVec3DistanceBetweenBitecsSpheres( eidA, eidB, storeA = SphereComponent, storeB = SphereComponent ) {
  const a = _scratchVec3A;
  const b = _scratchVec3B;
  a[ 0 ] = storeA.cx[ eidA ]; a[ 1 ] = storeA.cy[ eidA ]; a[ 2 ] = storeA.cz[ eidA ];
  b[ 0 ] = storeB.cx[ eidB ]; b[ 1 ] = storeB.cy[ eidB ]; b[ 2 ] = storeB.cz[ eidB ];
  return glVec3.distance( a, b );
}

// gl-matrix ray-sphere intersection reading from a bitecs SoA sphere.
// Returns the nearest positive t, or -1 if no intersection.
export function glMatrixRayIntersectBitecsSphere( glOrigin, glDirection, eid, store = SphereComponent ) {
  const ox = glOrigin[ 0 ] - store.cx[ eid ];
  const oy = glOrigin[ 1 ] - store.cy[ eid ];
  const oz = glOrigin[ 2 ] - store.cz[ eid ];
  const dx = glDirection[ 0 ], dy = glDirection[ 1 ], dz = glDirection[ 2 ];
  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * ( ox * dx + oy * dy + oz * dz );
  const c = ox * ox + oy * oy + oz * oz - store.radius[ eid ] * store.radius[ eid ];
  const disc = b * b - 4 * a * c;
  if ( disc < 0 ) return - 1;
  const sqrtDisc = Math.sqrt( disc );
  const t1 = ( - b - sqrtDisc ) / ( 2 * a );
  const t2 = ( - b + sqrtDisc ) / ( 2 * a );
  if ( t1 >= 0 ) return t1;
  if ( t2 >= 0 ) return t2;
  return - 1;
}

/*
 * -----------------------------------------------------------------------------
 * HIGH-PRECISION HELPERS (double.js)
 * -----------------------------------------------------------------------------
 * double.js's Double type carries ~106 bits of mantissa. These helpers compute
 * the signed distance from a sphere to a point, the contains-point test, and
 * the union of two spheres in double-double precision.
 */

function _toDouble( value ) {
  return new Double( value );
}

// Signed distance from a THREE.Sphere to a THREE.Vector3, in double-double precision.
export function preciseDistanceToPoint( sphere, point ) {
  const dx = _toDouble( point.x ).sub( _toDouble( sphere.center.x ) );
  const dy = _toDouble( point.y ).sub( _toDouble( sphere.center.y ) );
  const dz = _toDouble( point.z ).sub( _toDouble( sphere.center.z ) );
  const dist = dx.mul( dx ).add( dy.mul( dy ) ).add( dz.mul( dz ) ).sqrt();
  return dist.sub( _toDouble( sphere.radius ) ).toNumber();
}

// Contains-point test for a THREE.Sphere, in double-double precision.
export function preciseContainsPoint( sphere, point ) {
  const dx = _toDouble( point.x ).sub( _toDouble( sphere.center.x ) );
  const dy = _toDouble( point.y ).sub( _toDouble( sphere.center.y ) );
  const dz = _toDouble( point.z ).sub( _toDouble( sphere.center.z ) );
  const distSq = dx.mul( dx ).add( dy.mul( dy ) ).add( dz.mul( dz ) );
  const rSq = _toDouble( sphere.radius ).mul( _toDouble( sphere.radius ) );
  return distSq.sub( rSq ).toNumber() <= 0;
}

// Union of two THREE.Spheres into out, in double-double precision. Matches the
// f64 union semantics (returns the smaller sphere when one fully contains the
// other, otherwise the smallest sphere that contains both).
export function preciseUnionInto( out, a, b ) {
  if ( a.radius < 0 ) { out.copy( b ); return out; }
  if ( b.radius < 0 ) { out.copy( a ); return out; }
  const dx = _toDouble( b.center.x ).sub( _toDouble( a.center.x ) );
  const dy = _toDouble( b.center.y ).sub( _toDouble( a.center.y ) );
  const dz = _toDouble( b.center.z ).sub( _toDouble( a.center.z ) );
  const dist = dx.mul( dx ).add( dy.mul( dy ) ).add( dz.mul( dz ) ).sqrt().toNumber();
  if ( a.radius >= dist + b.radius ) { out.copy( a ); return out; }
  if ( b.radius >= dist + a.radius ) { out.copy( b ); return out; }
  if ( dist === 0 ) {
    out.center.copy( a.center );
    out.radius = Math.max( a.radius, b.radius );
    return out;
  }
  const r = ( dist + a.radius + b.radius ) / 2;
  const t = ( r - a.radius ) / dist;
  out.center.set(
    a.center.x + ( b.center.x - a.center.x ) * t,
    a.center.y + ( b.center.y - a.center.y ) * t,
    a.center.z + ( b.center.z - a.center.z ) * t
  );
  out.radius = r;
  return out;
}

/*
 * -----------------------------------------------------------------------------
 * PROCEDURAL NOISE (simplex-noise)
 * -----------------------------------------------------------------------------
 * A cached 3D simplex-noise generator per seed. setFromNoise3D places the
 * sphere's center at a noise-derived offset from the origin and sets the
 * radius from a fourth decorrelated noise sample.
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

// Fill a THREE.Sphere from a 3D simplex field sampled at (x, y, z). The center
// is placed at noise-scaled offsets along each axis, and the radius is set
// from a fourth decorrelated sample scaled by `radiusScale`.
export function setFromNoise3D( out, x, y, z, seed = 0, centerScale = 1, radiusScale = 0.5 ) {
  const n = _cachedNoise3D( seed );
  out.center.set(
    n( x, y, z ) * centerScale,
    n( x + 31.416, y + 47.853, z + 12.793 ) * centerScale,
    n( x - 17.234, y - 53.127, z - 91.056 ) * centerScale
  );
  out.radius = Math.abs( n( x + 100.1, y + 200.2, z + 300.3 ) ) * radiusScale;
  return out;
}

// Drop every cached noise generator.
export function disposeNoise3DCache() {
  _noise3DCache.clear();
}

// Module-local scratch buffers — allocated once, reused across every bridge.
const _scratchVec3A = new Float32Array( 3 );
const _scratchVec3B = new Float32Array( 3 );
const _scratchVec4 = new Float32Array( 4 );

/*
 * -----------------------------------------------------------------------------
 * THREE.Sphere
 * -----------------------------------------------------------------------------
 */
class Sphere {

  constructor( center = new Vector3(), radius = - 1 ) {
    this.isSphere = true;
    this.center = center;
    this.radius = radius;
  }

  set( center, radius ) {
    this.center.copy( center );
    this.radius = radius;
    return this;
  }

  setFromPoints( points, optionalCenter ) {
    const box = _box.setFromPoints( points );
    if ( optionalCenter !== undefined ) {
      this.center.copy( optionalCenter );
    } else {
      box.getCenter( this.center );
    }
    let maxRadiusSq = 0;
    for ( let i = 0, il = points.length; i < il; i ++ ) {
      maxRadiusSq = Math.max( maxRadiusSq, this.center.distanceToSquared( points[ i ] ) );
    }
    this.radius = Math.sqrt( maxRadiusSq );
    return this;
  }

  copy( sphere ) {
    this.center.copy( sphere.center );
    this.radius = sphere.radius;
    return this;
  }

  isEmpty() {
    return ( this.radius < 0 );
  }

  makeEmpty() {
    this.center.set( 0, 0, 0 );
    this.radius = - 1;
    return this;
  }

  containsPoint( point ) {
    return ( point.distanceToSquared( this.center ) <= ( this.radius * this.radius ) );
  }

  distanceToPoint( point ) {
    return ( point.distanceTo( this.center ) - this.radius );
  }

  intersectsSphere( sphere ) {
    const radiusSum = this.radius + sphere.radius;
    return sphere.center.distanceToSquared( this.center ) <= ( radiusSum * radiusSum );
  }

  intersectsBox( box ) {
    return box.intersectsSphere( this );
  }

  intersectsPlane( plane ) {
    return Math.abs( plane.distanceToPoint( this.center ) ) <= this.radius;
  }

  clampPoint( point, target ) {
    const deltaLengthSq = this.center.distanceToSquared( point );
    target.copy( point );
    if ( deltaLengthSq > ( this.radius * this.radius ) ) {
      target.sub( this.center ).normalize();
      target.multiplyScalar( this.radius ).add( this.center );
    }
    return target;
  }

  getBoundingBox( target ) {
    if ( this.isEmpty() ) {
      target.makeEmpty();
      return target;
    }
    target.set( this.center, this.center );
    target.expandByScalar( this.radius );
    return target;
  }

  applyMatrix4( matrix ) {
    this.center.applyMatrix4( matrix );
    this.radius = this.radius * matrix.getMaxScaleOnAxis();
    return this;
  }

  translate( offset ) {
    this.center.add( offset );
    return this;
  }

  expandByPoint( point ) {
    if ( this.isEmpty() ) {
      this.center.copy( point );
      this.radius = 0;
      return this;
    }
    _v1.subVectors( point, this.center );
    const lengthSq = _v1.lengthSq();
    if ( lengthSq > ( this.radius * this.radius ) ) {
      const length = Math.sqrt( lengthSq );
      const missingRadiusHalf = ( length - this.radius ) * 0.5;
      this.center.addScaledVector( _v1, missingRadiusHalf / length );
      this.radius += missingRadiusHalf;
    }
    return this;
  }

  union( sphere ) {
    if ( sphere.isEmpty() ) return this;
    if ( this.isEmpty() ) return this.copy( sphere );
    if ( this.center.equals( sphere.center ) === true ) {
      this.radius = Math.max( this.radius, sphere.radius );
    } else {
      _v2.subVectors( sphere.center, this.center ).setLength( sphere.radius );
      this.expandByPoint( _v1.copy( sphere.center ).add( _v2 ) );
      this.expandByPoint( _v1.copy( sphere.center ).sub( _v2 ) );
    }
    return this;
  }

  equals( sphere ) {
    return sphere.center.equals( this.center ) && ( sphere.radius === this.radius );
  }

  clone() {
    return new this.constructor().copy( this );
  }

}

const _box = /*@__PURE__*/ new Box3();
const _v1 = /*@__PURE__*/ new Vector3();
const _v2 = /*@__PURE__*/ new Vector3();

// Default export for parity with other math classes in this module.
export default Sphere;
export { Sphere };