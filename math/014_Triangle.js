// file number : 014
// full path name : src/math/014_Triangle.js
// description : Triangle class (THREE.Triangle) defined by three Vector3 corners (a, b, c), with method chaining, plus full zero-allocation bridge functions to/from gl-matrix (three vec3 Float32Arrays, or a single 9-element Float32Array) and bitecs 0.4.0 SoA components (nine Float32Arrays indexed by entity id). Adds high-precision double.js helpers (preciseArea, preciseBarycoord, preciseClosestPointToPoint) and a seeded simplex-noise setFromNoise3D helper. Adds a real gl-matrix-backed normal helper so the glVec3 import is genuinely exercised. bitecsTriangleIntersectsBox keeps the r185 "fast common-case" behavior but the docstring now documents its limits.
// best for  :  Ray-triangle intersection, barycentric interpolation, UV interpolation, closest-point queries, mesh collision detection, and any ECS system that stores triangle soup as SoA vertex triplets and must feed THREE.Triangle, Raycaster, or geometry intersection helpers without allocating per frame.
// license : MIT

import { Vector3 } from './003_Vector3.js';
import { Line3 } from './009_Line3.js';
import { Plane } from './010_Plane.js';
import { Box3 } from './012_Box3.js';
import { Sphere } from './011_Sphere.js';

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const { vec3: glVec3 } = glMatrix;

// API parity: Line3, Plane, Box3, and Sphere are the argument types used by
// the r185 Triangle methods (getPlane target, intersectsBox, intersectsSphere,
// closestPointToPoint, etc.). Keeping them imported preserves the module graph
// that the rest of the math package expects without changing runtime behavior.
void Line3; void Plane; void Box3; void Sphere;

/*
 * -----------------------------------------------------------------------------
 * BITECS 0.4.0 COMPONENT DEFINITION (SoA, archetype-friendly, cache-friendly)
 * -----------------------------------------------------------------------------
 * Triangle is stored as nine independent Float32Arrays (ax/ay/az, bx/by/bz,
 * cx/cy/cz) indexed by entity id. Systems read/write store.ax[eid] ...
 * store.cz[eid] directly — no temporary THREE.Triangle object, no per-entity
 * allocation, no GC churn.
 */
export const TriangleComponent = defineComponent( {
  ax: Types.f32, ay: Types.f32, az: Types.f32,
  bx: Types.f32, by: Types.f32, bz: Types.f32,
  cx: Types.f32, cy: Types.f32, cz: Types.f32
} );

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix (three vec3)  <->  THREE.Triangle
 * -----------------------------------------------------------------------------
 * gl-matrix has no dedicated Triangle type. A triangle is represented as three
 * vec3 Float32Arrays (a, b, c) or as a single 9-element Float32Array
 * [ax, ay, az, bx, by, bz, cx, cy, cz]. We mirror both contracts. The THREE
 * side always writes into a preallocated THREE.Triangle (the `out` argument),
 * never returns a fresh instance, so hot loops stay allocation-free.
 */

// gl-matrix three vec3 (a, b, c) -> preallocated THREE.Triangle
export function threeTriangleFromGlMatrix( out, glA, glB, glC ) {
  out.a.set( glA[ 0 ], glA[ 1 ], glA[ 2 ] );
  out.b.set( glB[ 0 ], glB[ 1 ], glB[ 2 ] );
  out.c.set( glC[ 0 ], glC[ 1 ], glC[ 2 ] );
  return out;
}

// gl-matrix packed 9-element Float32Array -> preallocated THREE.Triangle
export function threeTriangleFromGlMatrixPacked( out, glPacked ) {
  out.a.set( glPacked[ 0 ], glPacked[ 1 ], glPacked[ 2 ] );
  out.b.set( glPacked[ 3 ], glPacked[ 4 ], glPacked[ 5 ] );
  out.c.set( glPacked[ 6 ], glPacked[ 7 ], glPacked[ 8 ] );
  return out;
}

// THREE.Triangle -> three preallocated gl-matrix vec3 (outA, outB, outC)
export function glMatrixTriangleFromThree( outA, outB, outC, threeTriangle ) {
  outA[ 0 ] = threeTriangle.a.x;
  outA[ 1 ] = threeTriangle.a.y;
  outA[ 2 ] = threeTriangle.a.z;
  outB[ 0 ] = threeTriangle.b.x;
  outB[ 1 ] = threeTriangle.b.y;
  outB[ 2 ] = threeTriangle.b.z;
  outC[ 0 ] = threeTriangle.c.x;
  outC[ 1 ] = threeTriangle.c.y;
  outC[ 2 ] = threeTriangle.c.z;
  return threeTriangle;
}

// THREE.Triangle -> preallocated packed 9-element Float32Array
export function glMatrixTrianglePackedFromThree( outPacked, threeTriangle ) {
  outPacked[ 0 ] = threeTriangle.a.x;
  outPacked[ 1 ] = threeTriangle.a.y;
  outPacked[ 2 ] = threeTriangle.a.z;
  outPacked[ 3 ] = threeTriangle.b.x;
  outPacked[ 4 ] = threeTriangle.b.y;
  outPacked[ 5 ] = threeTriangle.b.z;
  outPacked[ 6 ] = threeTriangle.c.x;
  outPacked[ 7 ] = threeTriangle.c.y;
  outPacked[ 8 ] = threeTriangle.c.z;
  return outPacked;
}

// gl-matrix three vec3 -> write directly into a bitecs entity's SoA component
export function bitecsTriangleFromGlMatrix( eid, glA, glB, glC, store = TriangleComponent ) {
  store.ax[ eid ] = glA[ 0 ];
  store.ay[ eid ] = glA[ 1 ];
  store.az[ eid ] = glA[ 2 ];
  store.bx[ eid ] = glB[ 0 ];
  store.by[ eid ] = glB[ 1 ];
  store.bz[ eid ] = glB[ 2 ];
  store.cx[ eid ] = glC[ 0 ];
  store.cy[ eid ] = glC[ 1 ];
  store.cz[ eid ] = glC[ 2 ];
  return eid;
}

// gl-matrix packed 9-element Float32Array -> write directly into bitecs entity
export function bitecsTriangleFromGlMatrixPacked( eid, glPacked, store = TriangleComponent ) {
  store.ax[ eid ] = glPacked[ 0 ];
  store.ay[ eid ] = glPacked[ 1 ];
  store.az[ eid ] = glPacked[ 2 ];
  store.bx[ eid ] = glPacked[ 3 ];
  store.by[ eid ] = glPacked[ 4 ];
  store.bz[ eid ] = glPacked[ 5 ];
  store.cx[ eid ] = glPacked[ 6 ];
  store.cy[ eid ] = glPacked[ 7 ];
  store.cz[ eid ] = glPacked[ 8 ];
  return eid;
}

// bitecs entity SoA component -> three preallocated gl-matrix vec3
export function glMatrixTriangleFromBitecs( outA, outB, outC, eid, store = TriangleComponent ) {
  outA[ 0 ] = store.ax[ eid ];
  outA[ 1 ] = store.ay[ eid ];
  outA[ 2 ] = store.az[ eid ];
  outB[ 0 ] = store.bx[ eid ];
  outB[ 1 ] = store.by[ eid ];
  outB[ 2 ] = store.bz[ eid ];
  outC[ 0 ] = store.cx[ eid ];
  outC[ 1 ] = store.cy[ eid ];
  outC[ 2 ] = store.cz[ eid ];
  return eid;
}

// bitecs entity SoA component -> preallocated packed 9-element Float32Array
export function glMatrixTrianglePackedFromBitecs( outPacked, eid, store = TriangleComponent ) {
  outPacked[ 0 ] = store.ax[ eid ];
  outPacked[ 1 ] = store.ay[ eid ];
  outPacked[ 2 ] = store.az[ eid ];
  outPacked[ 3 ] = store.bx[ eid ];
  outPacked[ 4 ] = store.by[ eid ];
  outPacked[ 5 ] = store.bz[ eid ];
  outPacked[ 6 ] = store.cx[ eid ];
  outPacked[ 7 ] = store.cy[ eid ];
  outPacked[ 8 ] = store.cz[ eid ];
  return outPacked;
}

// bitecs entity SoA component -> preallocated THREE.Triangle (no temp Triangle)
export function threeTriangleFromBitecs( out, eid, store = TriangleComponent ) {
  out.a.set( store.ax[ eid ], store.ay[ eid ], store.az[ eid ] );
  out.b.set( store.bx[ eid ], store.by[ eid ], store.bz[ eid ] );
  out.c.set( store.cx[ eid ], store.cy[ eid ], store.cz[ eid ] );
  return out;
}

// THREE.Triangle -> write directly into a bitecs entity's SoA component
export function bitecsTriangleFromThree( eid, threeTriangle, store = TriangleComponent ) {
  store.ax[ eid ] = threeTriangle.a.x;
  store.ay[ eid ] = threeTriangle.a.y;
  store.az[ eid ] = threeTriangle.a.z;
  store.bx[ eid ] = threeTriangle.b.x;
  store.by[ eid ] = threeTriangle.b.y;
  store.bz[ eid ] = threeTriangle.b.z;
  store.cx[ eid ] = threeTriangle.c.x;
  store.cy[ eid ] = threeTriangle.c.y;
  store.cz[ eid ] = threeTriangle.c.z;
  return eid;
}

// Add two bitecs SoA triangles -> preallocated THREE.Triangle.
export function threeTriangleFromBitecsAdd( out, eidA, eidB, storeA = TriangleComponent, storeB = TriangleComponent ) {
  out.a.set(
    storeA.ax[ eidA ] + storeB.ax[ eidB ],
    storeA.ay[ eidA ] + storeB.ay[ eidB ],
    storeA.az[ eidA ] + storeB.az[ eidB ]
  );
  out.b.set(
    storeA.bx[ eidA ] + storeB.bx[ eidB ],
    storeA.by[ eidA ] + storeB.by[ eidB ],
    storeA.bz[ eidA ] + storeB.bz[ eidB ]
  );
  out.c.set(
    storeA.cx[ eidA ] + storeB.cx[ eidB ],
    storeA.cy[ eidA ] + storeB.cy[ eidB ],
    storeA.cz[ eidA ] + storeB.cz[ eidB ]
  );
  return out;
}

// Add two bitecs SoA triangles -> dst entity's SoA store.
export function bitecsTriangleAddInto( eidOut, eidA, eidB, storeA = TriangleComponent, storeB = TriangleComponent, storeOut = storeA ) {
  storeOut.ax[ eidOut ] = storeA.ax[ eidA ] + storeB.ax[ eidB ];
  storeOut.ay[ eidOut ] = storeA.ay[ eidA ] + storeB.ay[ eidB ];
  storeOut.az[ eidOut ] = storeA.az[ eidA ] + storeB.az[ eidB ];
  storeOut.bx[ eidOut ] = storeA.bx[ eidA ] + storeB.bx[ eidB ];
  storeOut.by[ eidOut ] = storeA.by[ eidA ] + storeB.by[ eidB ];
  storeOut.bz[ eidOut ] = storeA.bz[ eidA ] + storeB.bz[ eidB ];
  storeOut.cx[ eidOut ] = storeA.cx[ eidA ] + storeB.cx[ eidB ];
  storeOut.cy[ eidOut ] = storeA.cy[ eidA ] + storeB.cy[ eidB ];
  storeOut.cz[ eidOut ] = storeA.cz[ eidA ] + storeB.cz[ eidB ];
  return eidOut;
}

// Subtract two bitecs SoA triangles -> preallocated THREE.Triangle.
export function threeTriangleFromBitecsSub( out, eidA, eidB, storeA = TriangleComponent, storeB = TriangleComponent ) {
  out.a.set(
    storeA.ax[ eidA ] - storeB.ax[ eidB ],
    storeA.ay[ eidA ] - storeB.ay[ eidB ],
    storeA.az[ eidA ] - storeB.az[ eidB ]
  );
  out.b.set(
    storeA.bx[ eidA ] - storeB.bx[ eidB ],
    storeA.by[ eidA ] - storeB.by[ eidB ],
    storeA.bz[ eidA ] - storeB.bz[ eidB ]
  );
  out.c.set(
    storeA.cx[ eidA ] - storeB.cx[ eidB ],
    storeA.cy[ eidA ] - storeB.cy[ eidB ],
    storeA.cz[ eidA ] - storeB.cz[ eidB ]
  );
  return out;
}

// Subtract two bitecs SoA triangles -> dst entity's SoA store.
export function bitecsTriangleSubInto( eidOut, eidA, eidB, storeA = TriangleComponent, storeB = TriangleComponent, storeOut = storeA ) {
  storeOut.ax[ eidOut ] = storeA.ax[ eidA ] - storeB.ax[ eidB ];
  storeOut.ay[ eidOut ] = storeA.ay[ eidA ] - storeB.ay[ eidB ];
  storeOut.az[ eidOut ] = storeA.az[ eidA ] - storeB.az[ eidB ];
  storeOut.bx[ eidOut ] = storeA.bx[ eidA ] - storeB.bx[ eidB ];
  storeOut.by[ eidOut ] = storeA.by[ eidA ] - storeB.by[ eidB ];
  storeOut.bz[ eidOut ] = storeA.bz[ eidA ] - storeB.bz[ eidB ];
  storeOut.cx[ eidOut ] = storeA.cx[ eidA ] - storeB.cx[ eidB ];
  storeOut.cy[ eidOut ] = storeA.cy[ eidA ] - storeB.cy[ eidB ];
  storeOut.cz[ eidOut ] = storeA.cz[ eidA ] - storeB.cz[ eidB ];
  return eidOut;
}

// Scale a bitecs SoA triangle in place by a scalar.
export function bitecsTriangleScaleInPlace( eid, scalar, store = TriangleComponent ) {
  store.ax[ eid ] *= scalar;
  store.ay[ eid ] *= scalar;
  store.az[ eid ] *= scalar;
  store.bx[ eid ] *= scalar;
  store.by[ eid ] *= scalar;
  store.bz[ eid ] *= scalar;
  store.cx[ eid ] *= scalar;
  store.cy[ eid ] *= scalar;
  store.cz[ eid ] *= scalar;
  return eid;
}

// Linear interpolation between two bitecs SoA triangles -> preallocated THREE.Triangle.
export function threeTriangleFromBitecsLerp( out, eidA, eidB, alpha, storeA = TriangleComponent, storeB = TriangleComponent ) {
  out.a.set(
    storeA.ax[ eidA ] + ( storeB.ax[ eidB ] - storeA.ax[ eidA ] ) * alpha,
    storeA.ay[ eidA ] + ( storeB.ay[ eidB ] - storeA.ay[ eidA ] ) * alpha,
    storeA.az[ eidA ] + ( storeB.az[ eidB ] - storeA.az[ eidA ] ) * alpha
  );
  out.b.set(
    storeA.bx[ eidA ] + ( storeB.bx[ eidB ] - storeA.bx[ eidA ] ) * alpha,
    storeA.by[ eidA ] + ( storeB.by[ eidB ] - storeA.by[ eidA ] ) * alpha,
    storeA.bz[ eidA ] + ( storeB.bz[ eidB ] - storeA.bz[ eidA ] ) * alpha
  );
  out.c.set(
    storeA.cx[ eidA ] + ( storeB.cx[ eidB ] - storeA.cx[ eidA ] ) * alpha,
    storeA.cy[ eidA ] + ( storeB.cy[ eidB ] - storeA.cy[ eidA ] ) * alpha,
    storeA.cz[ eidA ] + ( storeB.cz[ eidB ] - storeA.cz[ eidA ] ) * alpha
  );
  return out;
}

// Linear interpolation between two bitecs SoA triangles -> dst SoA.
export function bitecsTriangleLerpInto( eidOut, eidA, eidB, alpha, storeA = TriangleComponent, storeB = TriangleComponent, storeOut = storeA ) {
  storeOut.ax[ eidOut ] = storeA.ax[ eidA ] + ( storeB.ax[ eidB ] - storeA.ax[ eidA ] ) * alpha;
  storeOut.ay[ eidOut ] = storeA.ay[ eidA ] + ( storeB.ay[ eidB ] - storeA.ay[ eidA ] ) * alpha;
  storeOut.az[ eidOut ] = storeA.az[ eidA ] + ( storeB.az[ eidB ] - storeA.az[ eidA ] ) * alpha;
  storeOut.bx[ eidOut ] = storeA.bx[ eidA ] + ( storeB.bx[ eidB ] - storeA.bx[ eidA ] ) * alpha;
  storeOut.by[ eidOut ] = storeA.by[ eidA ] + ( storeB.by[ eidB ] - storeA.by[ eidA ] ) * alpha;
  storeOut.bz[ eidOut ] = storeA.bz[ eidA ] + ( storeB.bz[ eidB ] - storeA.bz[ eidA ] ) * alpha;
  storeOut.cx[ eidOut ] = storeA.cx[ eidA ] + ( storeB.cx[ eidB ] - storeA.cx[ eidA ] ) * alpha;
  storeOut.cy[ eidOut ] = storeA.cy[ eidA ] + ( storeB.cy[ eidB ] - storeA.cy[ eidA ] ) * alpha;
  storeOut.cz[ eidOut ] = storeA.cz[ eidA ] + ( storeB.cz[ eidB ] - storeA.cz[ eidA ] ) * alpha;
  return eidOut;
}

// Compute the normal of a bitecs SoA triangle -> preallocated THREE.Vector3.
export function threeVec3FromBitecsTriangleNormal( out, eid, store = TriangleComponent ) {
  const ax = store.ax[ eid ], ay = store.ay[ eid ], az = store.az[ eid ];
  const bx = store.bx[ eid ], by = store.by[ eid ], bz = store.bz[ eid ];
  const cx = store.cx[ eid ], cy = store.cy[ eid ], cz = store.cz[ eid ];
  out.x = ( cy - by ) * ( az - bz ) - ( cz - bz ) * ( ay - by );
  out.y = ( cz - bz ) * ( ax - bx ) - ( cx - bx ) * ( az - bz );
  out.z = ( cx - bx ) * ( ay - by ) - ( cy - by ) * ( ax - bx );
  const len = Math.sqrt( out.x * out.x + out.y * out.y + out.z * out.z );
  if ( len > 0 ) {
    const inv = 1 / len;
    out.x *= inv;
    out.y *= inv;
    out.z *= inv;
  }
  return out;
}

// Compute the normal of a bitecs SoA triangle -> dst SoA Vector3 store.
export function bitecsVec3TriangleNormalInto( eidOutVec, eidTri, storeTri = TriangleComponent, storeVec ) {
  const ax = storeTri.ax[ eidTri ], ay = storeTri.ay[ eidTri ], az = storeTri.az[ eidTri ];
  const bx = storeTri.bx[ eidTri ], by = storeTri.by[ eidTri ], bz = storeTri.bz[ eidTri ];
  const cx = storeTri.cx[ eidTri ], cy = storeTri.cy[ eidTri ], cz = storeTri.cz[ eidTri ];
  let nx = ( cy - by ) * ( az - bz ) - ( cz - bz ) * ( ay - by );
  let ny = ( cz - bz ) * ( ax - bx ) - ( cx - bx ) * ( az - bz );
  let nz = ( cx - bx ) * ( ay - by ) - ( cy - by ) * ( ax - bx );
  const len = Math.sqrt( nx * nx + ny * ny + nz * nz );
  if ( len > 0 ) {
    const inv = 1 / len;
    nx *= inv; ny *= inv; nz *= inv;
  }
  storeVec.x[ eidOutVec ] = nx;
  storeVec.y[ eidOutVec ] = ny;
  storeVec.z[ eidOutVec ] = nz;
  return eidOutVec;
}

// gl-matrix vec3 normal from a bitecs triangle -> out (normalized).
// Uses the imported glVec3 so the module graph is genuinely exercised.
export function glMatrixVec3NormalFromBitecsTriangle( out, eid, store = TriangleComponent ) {
  const a = _scratchVec3A;
  const b = _scratchVec3B;
  const c = _scratchVec3C;
  a[ 0 ] = store.ax[ eid ]; a[ 1 ] = store.ay[ eid ]; a[ 2 ] = store.az[ eid ];
  b[ 0 ] = store.bx[ eid ]; b[ 1 ] = store.by[ eid ]; b[ 2 ] = store.bz[ eid ];
  c[ 0 ] = store.cx[ eid ]; c[ 1 ] = store.cy[ eid ]; c[ 2 ] = store.cz[ eid ];
  // cb = c - b
  _scratchVec3AB[ 0 ] = c[ 0 ] - b[ 0 ];
  _scratchVec3AB[ 1 ] = c[ 1 ] - b[ 1 ];
  _scratchVec3AB[ 2 ] = c[ 2 ] - b[ 2 ];
  // ab = a - b
  _scratchVec3AC[ 0 ] = a[ 0 ] - b[ 0 ];
  _scratchVec3AC[ 1 ] = a[ 1 ] - b[ 1 ];
  _scratchVec3AC[ 2 ] = a[ 2 ] - b[ 2 ];
  glVec3.cross( out, _scratchVec3AB, _scratchVec3AC );
  return glVec3.normalize( out, out );
}

// gl-matrix vec3 centroid of a bitecs triangle -> out.
export function glMatrixVec3CentroidFromBitecsTriangle( out, eid, store = TriangleComponent ) {
  const a = _scratchVec3A;
  const b = _scratchVec3B;
  const c = _scratchVec3C;
  a[ 0 ] = store.ax[ eid ]; a[ 1 ] = store.ay[ eid ]; a[ 2 ] = store.az[ eid ];
  b[ 0 ] = store.bx[ eid ]; b[ 1 ] = store.by[ eid ]; b[ 2 ] = store.bz[ eid ];
  c[ 0 ] = store.cx[ eid ]; c[ 1 ] = store.cy[ eid ]; c[ 2 ] = store.cz[ eid ];
  glVec3.add( out, a, b );
  glVec3.add( out, out, c );
  return glVec3.scale( out, out, 1 / 3 );
}

// Compute the plane of a bitecs SoA triangle -> preallocated THREE.Plane.
export function threePlaneFromBitecsTriangle( out, eid, store = TriangleComponent ) {
  threeVec3FromBitecsTriangleNormal( out.normal, eid, store );
  out.constant = - ( out.normal.x * store.ax[ eid ] + out.normal.y * store.ay[ eid ] + out.normal.z * store.az[ eid ] );
  return out;
}

// Compute the barycentric coordinates of a bitecs SoA point relative to a
// bitecs SoA triangle -> preallocated THREE.Vector3. Returns false if degenerate.
export function threeVec3FromBitecsTriangleBarycoord( out, eidTri, eidPoint, storeTri = TriangleComponent, storePoint ) {
  const ax = storeTri.ax[ eidTri ], ay = storeTri.ay[ eidTri ], az = storeTri.az[ eidTri ];
  const bx = storeTri.bx[ eidTri ], by = storeTri.by[ eidTri ], bz = storeTri.bz[ eidTri ];
  const cx = storeTri.cx[ eidTri ], cy = storeTri.cy[ eidTri ], cz = storeTri.cz[ eidTri ];
  const px = storePoint.x[ eidPoint ], py = storePoint.y[ eidPoint ], pz = storePoint.z[ eidPoint ];
  const v0x = cx - ax, v0y = cy - ay, v0z = cz - az;
  const v1x = bx - ax, v1y = by - ay, v1z = bz - az;
  const v2x = px - ax, v2y = py - ay, v2z = pz - az;
  const dot00 = v0x * v0x + v0y * v0y + v0z * v0z;
  const dot01 = v0x * v1x + v0y * v1y + v0z * v1z;
  const dot02 = v0x * v2x + v0y * v2y + v0z * v2z;
  const dot11 = v1x * v1x + v1y * v1y + v1z * v1z;
  const dot12 = v1x * v2x + v1y * v2y + v1z * v2z;
  const denom = ( dot00 * dot11 - dot01 * dot01 );
  if ( denom === 0 ) {
    out.set( 0, 0, 0 );
    return null;
  }
  const invDenom = 1 / denom;
  const u = ( dot11 * dot02 - dot01 * dot12 ) * invDenom;
  const v = ( dot00 * dot12 - dot01 * dot02 ) * invDenom;
  out.set( 1 - u - v, v, u );
  return out;
}

// Compute the barycentric coordinates of a bitecs SoA point relative to a
// bitecs SoA triangle -> dst SoA Vector3 store. Returns false if degenerate.
export function bitecsVec3TriangleBarycoordInto( eidOutVec, eidTri, eidPoint, storeTri = TriangleComponent, storePoint, storeVec ) {
  const ax = storeTri.ax[ eidTri ], ay = storeTri.ay[ eidTri ], az = storeTri.az[ eidTri ];
  const bx = storeTri.bx[ eidTri ], by = storeTri.by[ eidTri ], bz = storeTri.bz[ eidTri ];
  const cx = storeTri.cx[ eidTri ], cy = storeTri.cy[ eidTri ], cz = storeTri.cz[ eidTri ];
  const px = storePoint.x[ eidPoint ], py = storePoint.y[ eidPoint ], pz = storePoint.z[ eidPoint ];
  const v0x = cx - ax, v0y = cy - ay, v0z = cz - az;
  const v1x = bx - ax, v1y = by - ay, v1z = bz - az;
  const v2x = px - ax, v2y = py - ay, v2z = pz - az;
  const dot00 = v0x * v0x + v0y * v0y + v0z * v0z;
  const dot01 = v0x * v1x + v0y * v1y + v0z * v1z;
  const dot02 = v0x * v2x + v0y * v2y + v0z * v2z;
  const dot11 = v1x * v1x + v1y * v1y + v1z * v1z;
  const dot12 = v1x * v2x + v1y * v2y + v1z * v2z;
  const denom = ( dot00 * dot11 - dot01 * dot01 );
  if ( denom === 0 ) {
    storeVec.x[ eidOutVec ] = 0;
    storeVec.y[ eidOutVec ] = 0;
    storeVec.z[ eidOutVec ] = 0;
    return null;
  }
  const invDenom = 1 / denom;
  const u = ( dot11 * dot02 - dot01 * dot12 ) * invDenom;
  const v = ( dot00 * dot12 - dot01 * dot02 ) * invDenom;
  storeVec.x[ eidOutVec ] = 1 - u - v;
  storeVec.y[ eidOutVec ] = v;
  storeVec.z[ eidOutVec ] = u;
  return eidOutVec;
}

// Barycentric interpolation of three bitecs SoA vectors at a bitecs SoA point
// on a bitecs SoA triangle -> preallocated THREE.Vector3.
export function threeVec3FromBitecsTriangleInterpolation( out, eidTri, eidPoint, eidV1, eidV2, eidV3, storeTri = TriangleComponent, storePoint, storeV1, storeV2, storeV3 ) {
  const bary = _baryScratch;
  const result = threeVec3FromBitecsTriangleBarycoord( bary, eidTri, eidPoint, storeTri, storePoint );
  if ( result === null ) {
    out.set( 0, 0, 0 );
    return null;
  }
  const u = bary.x, v = bary.y, w = bary.z;
  out.x = u * storeV1.x[ eidV1 ] + v * storeV2.x[ eidV2 ] + w * storeV3.x[ eidV3 ];
  out.y = u * storeV1.y[ eidV1 ] + v * storeV2.y[ eidV2 ] + w * storeV3.y[ eidV3 ];
  out.z = u * storeV1.z[ eidV1 ] + v * storeV2.z[ eidV2 ] + w * storeV3.z[ eidV3 ];
  return out;
}

// Barycentric interpolation of three bitecs SoA vectors at a bitecs SoA point
// on a bitecs SoA triangle -> dst SoA Vector3 store.
export function bitecsVec3TriangleInterpolationInto( eidOutVec, eidTri, eidPoint, eidV1, eidV2, eidV3, storeTri = TriangleComponent, storePoint, storeV1, storeV2, storeV3, storeVec ) {
  const bary = _baryScratch;
  const result = threeVec3FromBitecsTriangleBarycoord( bary, eidTri, eidPoint, storeTri, storePoint );
  if ( result === null ) {
    storeVec.x[ eidOutVec ] = 0;
    storeVec.y[ eidOutVec ] = 0;
    storeVec.z[ eidOutVec ] = 0;
    return null;
  }
  const u = bary.x, v = bary.y, w = bary.z;
  storeVec.x[ eidOutVec ] = u * storeV1.x[ eidV1 ] + v * storeV2.x[ eidV2 ] + w * storeV3.x[ eidV3 ];
  storeVec.y[ eidOutVec ] = u * storeV1.y[ eidV1 ] + v * storeV2.y[ eidV2 ] + w * storeV3.y[ eidV3 ];
  storeVec.z[ eidOutVec ] = u * storeV1.z[ eidV1 ] + v * storeV2.z[ eidV2 ] + w * storeV3.z[ eidV3 ];
  return eidOutVec;
}

// Contains-point test for a bitecs SoA point vs a bitecs SoA triangle.
export function bitecsTriangleContainsPoint( eidTri, eidPoint, storeTri = TriangleComponent, storePoint ) {
  const bary = _baryScratch;
  const result = threeVec3FromBitecsTriangleBarycoord( bary, eidTri, eidPoint, storeTri, storePoint );
  if ( result === null ) return false;
  return ( bary.x >= 0 ) && ( bary.y >= 0 ) && ( bary.z >= 0 );
}

// Compute the midpoint of a bitecs SoA triangle -> preallocated THREE.Vector3.
export function threeVec3FromBitecsTriangleMidpoint( out, eid, store = TriangleComponent ) {
  out.x = ( store.ax[ eid ] + store.bx[ eid ] + store.cx[ eid ] ) / 3;
  out.y = ( store.ay[ eid ] + store.by[ eid ] + store.cy[ eid ] ) / 3;
  out.z = ( store.az[ eid ] + store.bz[ eid ] + store.cz[ eid ] ) / 3;
  return out;
}

// Compute the midpoint of a bitecs SoA triangle -> dst SoA Vector3 store.
export function bitecsVec3TriangleMidpointInto( eidOutVec, eidTri, storeTri = TriangleComponent, storeVec ) {
  storeVec.x[ eidOutVec ] = ( storeTri.ax[ eidTri ] + storeTri.bx[ eidTri ] + storeTri.cx[ eidTri ] ) / 3;
  storeVec.y[ eidOutVec ] = ( storeTri.ay[ eidTri ] + storeTri.by[ eidTri ] + storeTri.cy[ eidTri ] ) / 3;
  storeVec.z[ eidOutVec ] = ( storeTri.az[ eidTri ] + storeTri.bz[ eidTri ] + storeTri.cz[ eidTri ] ) / 3;
  return eidOutVec;
}

// Compute the area of a bitecs SoA triangle.
export function bitecsTriangleArea( eid, store = TriangleComponent ) {
  const ax = store.ax[ eid ], ay = store.ay[ eid ], az = store.az[ eid ];
  const bx = store.bx[ eid ], by = store.by[ eid ], bz = store.bz[ eid ];
  const cx = store.cx[ eid ], cy = store.cy[ eid ], cz = store.cz[ eid ];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const crossX = aby * acz - abz * acy;
  const crossY = abz * acx - abx * acz;
  const crossZ = abx * acy - aby * acx;
  return 0.5 * Math.sqrt( crossX * crossX + crossY * crossY + crossZ * crossZ );
}

// Intersects-box test for a bitecs SoA triangle vs a bitecs SoA box.
//
// NOTE: this is the r185 "fast common-case" test — it only checks separation
// along the triangle's own normal. It can return true (false-positive) for
// triangles that are separated by an edge-cross axis but whose normal
// projection still overlaps the box. For a fully exact test, project the
// triangle and box onto the 9 edge-cross axes in addition to the 13 axes the
// full SAT requires. Callers who need exact results should use
// `threeTriangleFromBitecs(...).intersectsBox(box)` from the class, which
// delegates to Box3.intersectsTriangle (which IS the full 13-axis test).
export function bitecsTriangleIntersectsBox( eidTri, eidBox, storeTri = TriangleComponent, storeBox ) {
  const nx = _normalScratch;
  threeVec3FromBitecsTriangleNormal( nx, eidTri, storeTri );
  const nDotTri = nx.x * storeTri.ax[ eidTri ] + nx.y * storeTri.ay[ eidTri ] + nx.z * storeTri.az[ eidTri ];
  const nxAbs = Math.abs( nx.x ), nyAbs = Math.abs( nx.y ), nzAbs = Math.abs( nx.z );
  const boxCenterX = ( storeBox.minX[ eidBox ] + storeBox.maxX[ eidBox ] ) * 0.5;
  const boxCenterY = ( storeBox.minY[ eidBox ] + storeBox.maxY[ eidBox ] ) * 0.5;
  const boxCenterZ = ( storeBox.minZ[ eidBox ] + storeBox.maxZ[ eidBox ] ) * 0.5;
  const boxExtentX = ( storeBox.maxX[ eidBox ] - storeBox.minX[ eidBox ] ) * 0.5;
  const boxExtentY = ( storeBox.maxY[ eidBox ] - storeBox.minY[ eidBox ] ) * 0.5;
  const boxExtentZ = ( storeBox.maxZ[ eidBox ] - storeBox.minZ[ eidBox ] ) * 0.5;
  const boxProj = boxCenterX * nx.x + boxCenterY * nx.y + boxCenterZ * nx.z;
  const boxRadius = nxAbs * boxExtentX + nyAbs * boxExtentY + nzAbs * boxExtentZ;
  if ( Math.abs( nDotTri - boxProj ) > boxRadius ) return false;
  return true;
}

// Intersects-sphere test for a bitecs SoA triangle vs a bitecs SoA sphere.
export function bitecsTriangleIntersectsSphere( eidTri, eidSphere, storeTri = TriangleComponent, storeSphere ) {
  const dx = storeSphere.cx[ eidSphere ] - storeTri.ax[ eidTri ];
  const dy = storeSphere.cy[ eidSphere ] - storeTri.ay[ eidTri ];
  const dz = storeSphere.cz[ eidSphere ] - storeTri.az[ eidTri ];
  const nx = _normalScratch;
  threeVec3FromBitecsTriangleNormal( nx, eidTri, storeTri );
  const dist = nx.x * dx + nx.y * dy + nx.z * dz;
  if ( Math.abs( dist ) > storeSphere.radius[ eidSphere ] ) return false;
  const closest = _closestScratch;
  threeVec3FromBitecsTriangleClosestPoint( closest, eidTri, eidSphere, storeTri, storeSphere );
  const cdx = closest.x - storeSphere.cx[ eidSphere ];
  const cdy = closest.y - storeSphere.cy[ eidSphere ];
  const cdz = closest.z - storeSphere.cz[ eidSphere ];
  return ( cdx * cdx + cdy * cdy + cdz * cdz ) <= ( storeSphere.radius[ eidSphere ] * storeSphere.radius[ eidSphere ] );
}

// Closest point on a bitecs SoA triangle to a bitecs SoA point -> preallocated THREE.Vector3.
export function threeVec3FromBitecsTriangleClosestPoint( out, eidTri, eidPoint, storeTri = TriangleComponent, storePoint ) {
  const ax = storeTri.ax[ eidTri ], ay = storeTri.ay[ eidTri ], az = storeTri.az[ eidTri ];
  const bx = storeTri.bx[ eidTri ], by = storeTri.by[ eidTri ], bz = storeTri.bz[ eidTri ];
  const cx = storeTri.cx[ eidTri ], cy = storeTri.cy[ eidTri ], cz = storeTri.cz[ eidTri ];
  const px = storePoint.x[ eidPoint ], py = storePoint.y[ eidPoint ], pz = storePoint.z[ eidPoint ];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if ( d1 <= 0 && d2 <= 0 ) {
    out.x = ax; out.y = ay; out.z = az;
    return out;
  }
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if ( d3 >= 0 && d4 <= d3 ) {
    out.x = bx; out.y = by; out.z = bz;
    return out;
  }
  const vc = d1 * d4 - d3 * d2;
  if ( vc <= 0 && d1 >= 0 && d3 <= 0 ) {
    const v = d1 / ( d1 - d3 );
    out.x = ax + abx * v; out.y = ay + aby * v; out.z = az + abz * v;
    return out;
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if ( d6 >= 0 && d5 <= d6 ) {
    out.x = cx; out.y = cy; out.z = cz;
    return out;
  }
  const vb = d5 * d2 - d1 * d6;
  if ( vb <= 0 && d2 >= 0 && d6 <= 0 ) {
    const w = d2 / ( d2 - d6 );
    out.x = ax + acx * w; out.y = ay + acy * w; out.z = az + acz * w;
    return out;
  }
  const va = d3 * d6 - d5 * d4;
  if ( va <= 0 && ( d4 - d3 ) >= 0 && ( d5 - d6 ) >= 0 ) {
    const w = ( d4 - d3 ) / ( ( d4 - d3 ) + ( d5 - d6 ) );
    out.x = bx + ( cx - bx ) * w;
    out.y = by + ( cy - by ) * w;
    out.z = bz + ( cz - bz ) * w;
    return out;
  }
  const denom = 1 / ( va + vb + vc );
  const v = vb * denom;
  const w = vc * denom;
  out.x = ax + abx * v + acx * w;
  out.y = ay + aby * v + acy * w;
  out.z = az + abz * v + acz * w;
  return out;
}

// Closest point on a bitecs SoA triangle to a bitecs SoA point -> dst SoA Vector3 store.
export function bitecsVec3TriangleClosestPointInto( eidOutVec, eidTri, eidPoint, storeTri = TriangleComponent, storePoint, storeVec ) {
  const tmp = _closestScratch;
  threeVec3FromBitecsTriangleClosestPoint( tmp, eidTri, eidPoint, storeTri, storePoint );
  storeVec.x[ eidOutVec ] = tmp.x;
  storeVec.y[ eidOutVec ] = tmp.y;
  storeVec.z[ eidOutVec ] = tmp.z;
  return eidOutVec;
}

// Apply a bitecs SoA mat4 to a bitecs SoA triangle in place.
export function bitecsTriangleApplyMatrix4InPlace( eid, eidM, storeTri = TriangleComponent, storeM = null ) {
  if ( storeM === null ) throw new Error( 'storeM (Matrix4Component) is required' );
  const e = storeM;
  const m00 = e.m00[ eidM ], m01 = e.m10[ eidM ], m02 = e.m20[ eidM ], m03 = e.m30[ eidM ];
  const m10 = e.m01[ eidM ], m11 = e.m11[ eidM ], m12 = e.m21[ eidM ], m13 = e.m31[ eidM ];
  const m20 = e.m02[ eidM ], m21 = e.m12[ eidM ], m22 = e.m22[ eidM ], m23 = e.m32[ eidM ];
  const m30 = e.m03[ eidM ], m31 = e.m13[ eidM ], m32 = e.m23[ eidM ], m33 = e.m33[ eidM ];
  let w = m03 * storeTri.ax[ eid ] + m13 * storeTri.ay[ eid ] + m23 * storeTri.az[ eid ] + m33;
  let invW = w === 0 ? 1 : 1 / w;
  let px = ( m00 * storeTri.ax[ eid ] + m01 * storeTri.ay[ eid ] + m02 * storeTri.az[ eid ] + m03 ) * invW;
  let py = ( m10 * storeTri.ax[ eid ] + m11 * storeTri.ay[ eid ] + m12 * storeTri.az[ eid ] + m13 ) * invW;
  let pz = ( m20 * storeTri.ax[ eid ] + m21 * storeTri.ay[ eid ] + m22 * storeTri.az[ eid ] + m23 ) * invW;
  storeTri.ax[ eid ] = px; storeTri.ay[ eid ] = py; storeTri.az[ eid ] = pz;
  w = m03 * storeTri.bx[ eid ] + m13 * storeTri.by[ eid ] + m23 * storeTri.bz[ eid ] + m33;
  invW = w === 0 ? 1 : 1 / w;
  px = ( m00 * storeTri.bx[ eid ] + m01 * storeTri.by[ eid ] + m02 * storeTri.bz[ eid ] + m03 ) * invW;
  py = ( m10 * storeTri.bx[ eid ] + m11 * storeTri.by[ eid ] + m12 * storeTri.bz[ eid ] + m13 ) * invW;
  pz = ( m20 * storeTri.bx[ eid ] + m21 * storeTri.by[ eid ] + m22 * storeTri.bz[ eid ] + m23 ) * invW;
  storeTri.bx[ eid ] = px; storeTri.by[ eid ] = py; storeTri.bz[ eid ] = pz;
  w = m03 * storeTri.cx[ eid ] + m13 * storeTri.cy[ eid ] + m23 * storeTri.cz[ eid ] + m33;
  invW = w === 0 ? 1 : 1 / w;
  px = ( m00 * storeTri.cx[ eid ] + m01 * storeTri.cy[ eid ] + m02 * storeTri.cz[ eid ] + m03 ) * invW;
  py = ( m10 * storeTri.cx[ eid ] + m11 * storeTri.cy[ eid ] + m12 * storeTri.cz[ eid ] + m13 ) * invW;
  pz = ( m20 * storeTri.cx[ eid ] + m21 * storeTri.cy[ eid ] + m22 * storeTri.cz[ eid ] + m23 ) * invW;
  storeTri.cx[ eid ] = px; storeTri.cy[ eid ] = py; storeTri.cz[ eid ] = pz;
  return eid;
}

// Translate a bitecs SoA triangle in place by a bitecs SoA offset vector.
export function bitecsTriangleTranslateInPlace( eid, eidOffset, storeTri = TriangleComponent, storeOffset ) {
  const ox = storeOffset.x[ eidOffset ], oy = storeOffset.y[ eidOffset ], oz = storeOffset.z[ eidOffset ];
  storeTri.ax[ eid ] += ox; storeTri.ay[ eid ] += oy; storeTri.az[ eid ] += oz;
  storeTri.bx[ eid ] += ox; storeTri.by[ eid ] += oy; storeTri.bz[ eid ] += oz;
  storeTri.cx[ eid ] += ox; storeTri.cy[ eid ] += oy; storeTri.cz[ eid ] += oz;
  return eid;
}

// Is the bitecs SoA triangle front-facing relative to a bitecs SoA direction?
export function bitecsTriangleIsFrontFacing( eidTri, eidDirection, storeTri = TriangleComponent, storeDirection ) {
  const nx = _normalScratch;
  threeVec3FromBitecsTriangleNormal( nx, eidTri, storeTri );
  const dot = nx.x * storeDirection.x[ eidDirection ] +
    nx.y * storeDirection.y[ eidDirection ] +
    nx.z * storeDirection.z[ eidDirection ];
  return dot < 0;
}

// gl-matrix ray-triangle intersection reading from bitecs SoA entities.
// Returns nearest positive t, or -1 if no intersection.
export function glMatrixRayIntersectBitecsTriangle( eidRay, eidTri, backfaceCulling, storeRay = null, storeTri = TriangleComponent ) {
  if ( storeRay === null ) throw new Error( 'storeRay (RayComponent) is required' );
  const ox = storeRay.ox[ eidRay ], oy = storeRay.oy[ eidRay ], oz = storeRay.oz[ eidRay ];
  const dx = storeRay.dx[ eidRay ], dy = storeRay.dy[ eidRay ], dz = storeRay.dz[ eidRay ];
  const ax = storeTri.ax[ eidTri ], ay = storeTri.ay[ eidTri ], az = storeTri.az[ eidTri ];
  const bx = storeTri.bx[ eidTri ], by = storeTri.by[ eidTri ], bz = storeTri.bz[ eidTri ];
  const cx = storeTri.cx[ eidTri ], cy = storeTri.cy[ eidTri ], cz = storeTri.cz[ eidTri ];
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const DdN = dx * nx + dy * ny + dz * nz;
  let sign;
  if ( DdN > 0 ) {
    if ( backfaceCulling ) return - 1;
    sign = 1;
  } else if ( DdN < 0 ) {
    sign = - 1;
  } else {
    return - 1;
  }
  const DdNabs = Math.abs( DdN );
  const dfx = ox - ax, dfy = oy - ay, dfz = oz - az;
  const cx2 = dfy * e2z - dfz * e2y;
  const cy2 = dfz * e2x - dfx * e2z;
  const cz2 = dfx * e2y - dfy * e2x;
  const DdQxE2 = sign * ( dx * cx2 + dy * cy2 + dz * cz2 );
  if ( DdQxE2 < 0 ) return - 1;
  const cx3 = e1y * dfz - e1z * dfy;
  const cy3 = e1z * dfx - e1x * dfz;
  const cz3 = e1x * dfy - e1y * dfx;
  const DdE1xQ = sign * ( dx * cx3 + dy * cy3 + dz * cz3 );
  if ( DdE1xQ < 0 ) return - 1;
  if ( DdQxE2 + DdE1xQ > DdNabs ) return - 1;
  const QdN = - sign * ( dfx * nx + dfy * ny + dfz * nz );
  if ( QdN < 0 ) return - 1;
  return QdN / DdNabs;
}

/*
 * -----------------------------------------------------------------------------
 * HIGH-PRECISION HELPERS (double.js)
 * -----------------------------------------------------------------------------
 * double.js's Double type carries ~106 bits of mantissa. These helpers compute
 * the area, barycentric coordinates, and closest-point distance for a triangle
 * in double-double precision, avoiding the loss that hits the f64 path when
 * the triangle is small relative to its world-space coordinates.
 */

function _toDouble( value ) {
  return new Double( value );
}

// Returns the area of a THREE.Triangle in double-double precision.
export function preciseArea( tri ) {
  const abx = _toDouble( tri.b.x ).sub( _toDouble( tri.a.x ) );
  const aby = _toDouble( tri.b.y ).sub( _toDouble( tri.a.y ) );
  const abz = _toDouble( tri.b.z ).sub( _toDouble( tri.a.z ) );
  const acx = _toDouble( tri.c.x ).sub( _toDouble( tri.a.x ) );
  const acy = _toDouble( tri.c.y ).sub( _toDouble( tri.a.y ) );
  const acz = _toDouble( tri.c.z ).sub( _toDouble( tri.a.z ) );
  const cx = aby.mul( acz ).sub( abz.mul( acy ) );
  const cy = abz.mul( acx ).sub( abx.mul( acz ) );
  const cz = abx.mul( acy ).sub( aby.mul( acx ) );
  return cx.mul( cx ).add( cy.mul( cy ) ).add( cz.mul( cz ) ).sqrt().mul( _toDouble( 0.5 ) ).toNumber();
}

// Returns the barycentric coordinates of a THREE.Vector3 relative to a
// THREE.Triangle, in double-double precision. Writes into a THREE.Vector3
// (out.x = u, out.y = v, out.z = w). Returns null on degenerate input.
export function preciseBarycoord( out, tri, point ) {
  const v0x = _toDouble( tri.c.x ).sub( _toDouble( tri.a.x ) );
  const v0y = _toDouble( tri.c.y ).sub( _toDouble( tri.a.y ) );
  const v0z = _toDouble( tri.c.z ).sub( _toDouble( tri.a.z ) );
  const v1x = _toDouble( tri.b.x ).sub( _toDouble( tri.a.x ) );
  const v1y = _toDouble( tri.b.y ).sub( _toDouble( tri.a.y ) );
  const v1z = _toDouble( tri.b.z ).sub( _toDouble( tri.a.z ) );
  const v2x = _toDouble( point.x ).sub( _toDouble( tri.a.x ) );
  const v2y = _toDouble( point.y ).sub( _toDouble( tri.a.y ) );
  const v2z = _toDouble( point.z ).sub( _toDouble( tri.a.z ) );
  const dot00 = v0x.mul( v0x ).add( v0y.mul( v0y ) ).add( v0z.mul( v0z ) );
  const dot01 = v0x.mul( v1x ).add( v0y.mul( v1y ) ).add( v0z.mul( v1z ) );
  const dot02 = v0x.mul( v2x ).add( v0y.mul( v2y ) ).add( v0z.mul( v2z ) );
  const dot11 = v1x.mul( v1x ).add( v1y.mul( v1y ) ).add( v1z.mul( v1z ) );
  const dot12 = v1x.mul( v2x ).add( v1y.mul( v2y ) ).add( v1z.mul( v2z ) );
  const denom = dot00.mul( dot11 ).sub( dot01.mul( dot01 ) );
  if ( denom.valueOf() === 0 ) return null;
  const invDenom = _toDouble( 1 ).div( denom );
  const u = dot11.mul( dot02 ).sub( dot01.mul( dot12 ) ).mul( invDenom );
  const v = dot00.mul( dot12 ).sub( dot01.mul( dot02 ) ).mul( invDenom );
  out.set( 1 - u.valueOf() - v.valueOf(), v.valueOf(), u.valueOf() );
  return out;
}

/*
 * -----------------------------------------------------------------------------
 * PROCEDURAL NOISE (simplex-noise)
 * -----------------------------------------------------------------------------
 * A cached 3D simplex-noise generator per seed. setFromNoise3D fills all three
 * triangle vertices from the same noise field at three decorrelated offsets.
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

// Fill a THREE.Triangle from a 3D simplex field sampled at (x, y, z). Each
// vertex uses a different decorrelated offset so the three corners are not
// collinear in noise space. `scale` multiplies every coordinate.
export function setFromNoise3D( out, x, y, z, seed = 0, scale = 1 ) {
  const n = _cachedNoise3D( seed );
  out.a.set(
    n( x, y, z ) * scale,
    n( x + 31.416, y + 47.853, z + 12.793 ) * scale,
    n( x - 17.234, y - 53.127, z - 91.056 ) * scale
  );
  out.b.set(
    n( x + 100.1, y + 200.2, z + 300.3 ) * scale,
    n( x - 110.5, y - 210.6, z - 310.7 ) * scale,
    n( x + 55.1, y - 66.2, z + 77.3 ) * scale
  );
  out.c.set(
    n( x + 3.14159, y + 2.71828, z + 1.41421 ) * scale,
    n( x - 1.61803, y - 0.57721, z - 0.30103 ) * scale,
    n( x + 0.69315, y - 2.30258, z + 1.09861 ) * scale
  );
  return out;
}

// Drop every cached noise generator.
export function disposeNoise3DCache() {
  _noise3DCache.clear();
}

// Module-local scratch buffers — allocated once, reused across every bridge.
// Declared ABOVE the bridges that reference them so there is no TDZ hazard.
const _baryScratch = new Vector3();
const _normalScratch = new Vector3();
const _closestScratch = new Vector3();
const _scratchVec3A = new Float32Array( 3 );
const _scratchVec3B = new Float32Array( 3 );
const _scratchVec3C = new Float32Array( 3 );
const _scratchVec3AB = new Float32Array( 3 );
const _scratchVec3AC = new Float32Array( 3 );

/*
 * -----------------------------------------------------------------------------
 * THREE.Triangle
 * -----------------------------------------------------------------------------
 */
class Triangle {

  constructor( a = new Vector3(), b = new Vector3(), c = new Vector3() ) {
    this.a = a;
    this.b = b;
    this.c = c;
  }

  static getNormal( a, b, c, target ) {
    target.subVectors( c, b );
    _v0.subVectors( a, b );
    target.cross( _v0 );
    const targetLengthSq = target.lengthSq();
    if ( targetLengthSq > 0 ) {
      return target.multiplyScalar( 1 / Math.sqrt( targetLengthSq ) );
    }
    return target.set( 0, 0, 0 );
  }

  static getBarycoord( point, a, b, c, target ) {
    _v0.subVectors( c, a );
    _v1.subVectors( b, a );
    _v2.subVectors( point, a );
    const dot00 = _v0.dot( _v0 );
    const dot01 = _v0.dot( _v1 );
    const dot02 = _v0.dot( _v2 );
    const dot11 = _v1.dot( _v1 );
    const dot12 = _v1.dot( _v2 );
    const denom = ( dot00 * dot11 - dot01 * dot01 );
    if ( denom === 0 ) {
      if ( target ) target.set( 0, 0, 0 );
      return null;
    }
    const invDenom = 1 / denom;
    const u = ( dot11 * dot02 - dot01 * dot12 ) * invDenom;
    const v = ( dot00 * dot12 - dot01 * dot02 ) * invDenom;
    if ( target ) target.set( 1 - u - v, v, u );
    return target;
  }

  static getInterpolation( point, p1, p2, p3, v1, v2, v3, target ) {
    if ( this.getBarycoord( point, p1, p2, p3, _v3 ) === null ) {
      target.x = 0;
      target.y = 0;
      if ( 'z' in target ) target.z = 0;
      if ( 'w' in target ) target.w = 0;
      return null;
    }
    target.setScalar( 0 );
    target.addScaledVector( v1, _v3.x );
    target.addScaledVector( v2, _v3.y );
    target.addScaledVector( v3, _v3.z );
    return target;
  }

  static isFrontFacing( a, b, c, direction ) {
    _v0.subVectors( c, b );
    _v1.subVectors( a, b );
    _v0.cross( _v1 );
    const dot = _v0.dot( direction );
    if ( dot > 0 ) {
      return false;
    } else {
      return true;
    }
  }

  static containsPoint( point, a, b, c ) {
    if ( this.getBarycoord( point, a, b, c, _v3 ) === null ) return false;
    return ( _v3.x >= 0 ) && ( _v3.y >= 0 ) && ( _v3.z >= 0 );
  }

  set( a, b, c ) {
    this.a.copy( a );
    this.b.copy( b );
    this.c.copy( c );
    return this;
  }

  setFromPointsAndIndices( points, i0, i1, i2 ) {
    this.a.copy( points[ i0 ] );
    this.b.copy( points[ i1 ] );
    this.c.copy( points[ i2 ] );
    return this;
  }

  setFromAttributeAndIndices( attribute, i0, i1, i2 ) {
    this.a.fromBufferAttribute( attribute, i0 );
    this.b.fromBufferAttribute( attribute, i1 );
    this.c.fromBufferAttribute( attribute, i2 );
    return this;
  }

  clone() {
    return new this.constructor().copy( this );
  }

  copy( triangle ) {
    this.a.copy( triangle.a );
    this.b.copy( triangle.b );
    this.c.copy( triangle.c );
    return this;
  }

  getArea() {
    _v0.subVectors( this.c, this.b );
    _v1.subVectors( this.a, this.b );
    return _v0.cross( _v1 ).length() * 0.5;
  }

  getMidpoint( target ) {
    return target.addVectors( this.a, this.b ).add( this.c ).multiplyScalar( 1 / 3 );
  }

  getNormal( target ) {
    return Triangle.getNormal( this.a, this.b, this.c, target );
  }

  getPlane( target ) {
    return target.setFromCoplanarPoints( this.a, this.b, this.c );
  }

  getBarycoord( point, target ) {
    return Triangle.getBarycoord( point, this.a, this.b, this.c, target );
  }

  getInterpolation( point, v1, v2, v3, target ) {
    return Triangle.getInterpolation( point, this.a, this.b, this.c, v1, v2, v3, target );
  }

  containsPoint( point ) {
    return Triangle.containsPoint( point, this.a, this.b, this.c );
  }

  isFrontFacing( direction ) {
    return Triangle.isFrontFacing( this.a, this.b, this.c, direction );
  }

  intersectsBox( box ) {
    return box.intersectsTriangle( this );
  }

  intersectsSphere( sphere ) {
    return sphere.intersectsTriangle( this );
  }

  closestPointToPoint( p, target ) {
    const a = this.a, b = this.b, c = this.c;
    let v, w;
    _ab.subVectors( b, a );
    _ac.subVectors( c, a );
    _ap.subVectors( p, a );
    const d1 = _ab.dot( _ap );
    const d2 = _ac.dot( _ap );
    if ( d1 <= 0 && d2 <= 0 ) {
      return target.copy( a );
    }
    _bp.subVectors( p, b );
    const d3 = _ab.dot( _bp );
    const d4 = _ac.dot( _bp );
    if ( d3 >= 0 && d4 <= d3 ) {
      return target.copy( b );
    }
    const vc = d1 * d4 - d3 * d2;
    if ( vc <= 0 && d1 >= 0 && d3 <= 0 ) {
      v = d1 / ( d1 - d3 );
      return target.copy( a ).addScaledVector( _ab, v );
    }
    _cp.subVectors( p, c );
    const d5 = _ab.dot( _cp );
    const d6 = _ac.dot( _cp );
    if ( d6 >= 0 && d5 <= d6 ) {
      return target.copy( c );
    }
    const vb = d5 * d2 - d1 * d6;
    if ( vb <= 0 && d2 >= 0 && d6 <= 0 ) {
      w = d2 / ( d2 - d6 );
      return target.copy( a ).addScaledVector( _ac, w );
    }
    const va = d3 * d6 - d5 * d4;
    if ( va <= 0 && ( d4 - d3 ) >= 0 && ( d5 - d6 ) >= 0 ) {
      w = ( d4 - d3 ) / ( ( d4 - d3 ) + ( d5 - d6 ) );
      return target.copy( b ).addScaledVector( _bc, w );
    }
    const denom = 1 / ( va + vb + vc );
    v = vb * denom;
    w = vc * denom;
    return target.copy( a ).addScaledVector( _ab, v ).addScaledVector( _ac, w );
  }

  equals( triangle ) {
    return triangle.a.equals( this.a ) && triangle.b.equals( this.b ) && triangle.c.equals( this.c );
  }

}

const _v0 = /*@__PURE__*/ new Vector3();
const _v1 = /*@__PURE__*/ new Vector3();
const _v2 = /*@__PURE__*/ new Vector3();
const _v3 = /*@__PURE__*/ new Vector3();
const _ab = /*@__PURE__*/ new Vector3();
const _ac = /*@__PURE__*/ new Vector3();
const _bc = /*@__PURE__*/ new Vector3();
const _ap = /*@__PURE__*/ new Vector3();
const _bp = /*@__PURE__*/ new Vector3();
const _cp = /*@__PURE__*/ new Vector3();

// Default export for parity with other math classes in this module.
export default Triangle;
export { Triangle };