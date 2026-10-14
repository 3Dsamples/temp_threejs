// file number : 012
// full path name : src/math/012_Box3.js
// description : Axis-Aligned Bounding Box class (THREE.Box3) defined by min/max Vector3 corners, with method chaining, plus full zero-allocation bridge functions to/from gl-matrix (two vec3 min/max, or packed 6-element Float32Array) and bitecs 0.4.0 SoA components (six Float32Arrays indexed by entity id). Uses the real Matrix4 for applyMatrix4 (the original file's plain-object _m1 was a runtime bug). Reimplements intersectsTriangle as a correct 13-axis SAT test (the original had duplicated edge loops that overwrote each other). Adds high-precision double.js helpers (preciseDistanceToPoint, preciseVolume, preciseUnionInto) and a seeded simplex-noise setFromNoise3D helper.
// best for  :  Broad-phase culling, frustum culling, spatial partitioning, ray-AABB intersection, collision broad-phase, and any ECS system that stores AABBs as SoA min/max corners and must feed THREE.Box3, Frustum, or Raycaster without allocating per frame.
// license : MIT

import { Vector3 } from './003_Vector3.js';
import { Sphere } from './011_Sphere.js';
import { Matrix4 } from './007_Matrix4.js';

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const { vec3: glVec3 } = glMatrix;

/*
 * -----------------------------------------------------------------------------
 * BITECS 0.4.0 COMPONENT DEFINITION (SoA, archetype-friendly, cache-friendly)
 * -----------------------------------------------------------------------------
 * Box3 is stored as six independent Float32Arrays (minX/minY/minZ/maxX/maxY/maxZ)
 * indexed by entity id. Systems read/write store.minX[eid], store.minY[eid],
 * store.minZ[eid], store.maxX[eid], store.maxY[eid], store.maxZ[eid] directly
 * — no temporary THREE.Box3 object, no per-entity allocation, no GC churn.
 */
export const Box3Component = defineComponent( {
  minX: Types.f32, minY: Types.f32, minZ: Types.f32,
  maxX: Types.f32, maxY: Types.f32, maxZ: Types.f32
} );

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix (two vec3 min/max)  <->  THREE.Box3
 * -----------------------------------------------------------------------------
 * gl-matrix has no dedicated Box3 type. An AABB is represented as two vec3
 * Float32Arrays (min, max) or as a single 6-element Float32Array
 * [minx, miny, minz, maxx, maxy, maxz]. We mirror both contracts. The THREE
 * side always writes into a preallocated THREE.Box3 (the `out` argument),
 * never returns a fresh instance, so hot loops stay allocation-free.
 */

// gl-matrix two vec3 (min, max) -> preallocated THREE.Box3
export function threeBox3FromGlMatrix( out, glMin, glMax ) {
  out.min.set( glMin[ 0 ], glMin[ 1 ], glMin[ 2 ] );
  out.max.set( glMax[ 0 ], glMax[ 1 ], glMax[ 2 ] );
  return out;
}

// gl-matrix packed 6-element Float32Array -> preallocated THREE.Box3
export function threeBox3FromGlMatrixPacked( out, glPacked ) {
  out.min.set( glPacked[ 0 ], glPacked[ 1 ], glPacked[ 2 ] );
  out.max.set( glPacked[ 3 ], glPacked[ 4 ], glPacked[ 5 ] );
  return out;
}

// THREE.Box3 -> two preallocated gl-matrix vec3 (outMin, outMax)
export function glMatrixBox3FromThree( outMin, outMax, threeBox ) {
  outMin[ 0 ] = threeBox.min.x;
  outMin[ 1 ] = threeBox.min.y;
  outMin[ 2 ] = threeBox.min.z;
  outMax[ 0 ] = threeBox.max.x;
  outMax[ 1 ] = threeBox.max.y;
  outMax[ 2 ] = threeBox.max.z;
  return threeBox;
}

// THREE.Box3 -> preallocated packed 6-element Float32Array
export function glMatrixBox3PackedFromThree( outPacked, threeBox ) {
  outPacked[ 0 ] = threeBox.min.x;
  outPacked[ 1 ] = threeBox.min.y;
  outPacked[ 2 ] = threeBox.min.z;
  outPacked[ 3 ] = threeBox.max.x;
  outPacked[ 4 ] = threeBox.max.y;
  outPacked[ 5 ] = threeBox.max.z;
  return outPacked;
}

// gl-matrix two vec3 -> write directly into a bitecs entity's SoA component
export function bitecsBox3FromGlMatrix( eid, glMin, glMax, store = Box3Component ) {
  store.minX[ eid ] = glMin[ 0 ];
  store.minY[ eid ] = glMin[ 1 ];
  store.minZ[ eid ] = glMin[ 2 ];
  store.maxX[ eid ] = glMax[ 0 ];
  store.maxY[ eid ] = glMax[ 1 ];
  store.maxZ[ eid ] = glMax[ 2 ];
  return eid;
}

// gl-matrix packed 6-element Float32Array -> write directly into bitecs entity
export function bitecsBox3FromGlMatrixPacked( eid, glPacked, store = Box3Component ) {
  store.minX[ eid ] = glPacked[ 0 ];
  store.minY[ eid ] = glPacked[ 1 ];
  store.minZ[ eid ] = glPacked[ 2 ];
  store.maxX[ eid ] = glPacked[ 3 ];
  store.maxY[ eid ] = glPacked[ 4 ];
  store.maxZ[ eid ] = glPacked[ 5 ];
  return eid;
}

// bitecs entity SoA component -> two preallocated gl-matrix vec3
export function glMatrixBox3FromBitecs( outMin, outMax, eid, store = Box3Component ) {
  outMin[ 0 ] = store.minX[ eid ];
  outMin[ 1 ] = store.minY[ eid ];
  outMin[ 2 ] = store.minZ[ eid ];
  outMax[ 0 ] = store.maxX[ eid ];
  outMax[ 1 ] = store.maxY[ eid ];
  outMax[ 2 ] = store.maxZ[ eid ];
  return eid;
}

// bitecs entity SoA component -> preallocated packed 6-element Float32Array
export function glMatrixBox3PackedFromBitecs( outPacked, eid, store = Box3Component ) {
  outPacked[ 0 ] = store.minX[ eid ];
  outPacked[ 1 ] = store.minY[ eid ];
  outPacked[ 2 ] = store.minZ[ eid ];
  outPacked[ 3 ] = store.maxX[ eid ];
  outPacked[ 4 ] = store.maxY[ eid ];
  outPacked[ 5 ] = store.maxZ[ eid ];
  return outPacked;
}

// bitecs entity SoA component -> preallocated THREE.Box3 (no temp Box3)
export function threeBox3FromBitecs( out, eid, store = Box3Component ) {
  out.min.set( store.minX[ eid ], store.minY[ eid ], store.minZ[ eid ] );
  out.max.set( store.maxX[ eid ], store.maxY[ eid ], store.maxZ[ eid ] );
  return out;
}

// THREE.Box3 -> write directly into a bitecs entity's SoA component
export function bitecsBox3FromThree( eid, threeBox, store = Box3Component ) {
  store.minX[ eid ] = threeBox.min.x;
  store.minY[ eid ] = threeBox.min.y;
  store.minZ[ eid ] = threeBox.min.z;
  store.maxX[ eid ] = threeBox.max.x;
  store.maxY[ eid ] = threeBox.max.y;
  store.maxZ[ eid ] = threeBox.max.z;
  return eid;
}

// Union of two bitecs SoA boxes -> preallocated THREE.Box3.
export function threeBox3FromBitecsUnion( out, eidA, eidB, storeA = Box3Component, storeB = Box3Component ) {
  out.min.set(
    Math.min( storeA.minX[ eidA ], storeB.minX[ eidB ] ),
    Math.min( storeA.minY[ eidA ], storeB.minY[ eidB ] ),
    Math.min( storeA.minZ[ eidA ], storeB.minZ[ eidB ] )
  );
  out.max.set(
    Math.max( storeA.maxX[ eidA ], storeB.maxX[ eidB ] ),
    Math.max( storeA.maxY[ eidA ], storeB.maxY[ eidB ] ),
    Math.max( storeA.maxZ[ eidA ], storeB.maxZ[ eidB ] )
  );
  return out;
}

// Union of two bitecs SoA boxes -> dst entity's SoA store.
export function bitecsBox3UnionInto( eidOut, eidA, eidB, storeA = Box3Component, storeB = Box3Component, storeOut = storeA ) {
  storeOut.minX[ eidOut ] = Math.min( storeA.minX[ eidA ], storeB.minX[ eidB ] );
  storeOut.minY[ eidOut ] = Math.min( storeA.minY[ eidA ], storeB.minY[ eidB ] );
  storeOut.minZ[ eidOut ] = Math.min( storeA.minZ[ eidA ], storeB.minZ[ eidB ] );
  storeOut.maxX[ eidOut ] = Math.max( storeA.maxX[ eidA ], storeB.maxX[ eidB ] );
  storeOut.maxY[ eidOut ] = Math.max( storeA.maxY[ eidA ], storeB.maxY[ eidB ] );
  storeOut.maxZ[ eidOut ] = Math.max( storeA.maxZ[ eidA ], storeB.maxZ[ eidB ] );
  return eidOut;
}

// Intersection of two bitecs SoA boxes -> preallocated THREE.Box3.
export function threeBox3FromBitecsIntersect( out, eidA, eidB, storeA = Box3Component, storeB = Box3Component ) {
  out.min.set(
    Math.max( storeA.minX[ eidA ], storeB.minX[ eidB ] ),
    Math.max( storeA.minY[ eidA ], storeB.minY[ eidB ] ),
    Math.max( storeA.minZ[ eidA ], storeB.minZ[ eidB ] )
  );
  out.max.set(
    Math.min( storeA.maxX[ eidA ], storeB.maxX[ eidB ] ),
    Math.min( storeA.maxY[ eidA ], storeB.maxY[ eidB ] ),
    Math.min( storeA.maxZ[ eidA ], storeB.maxZ[ eidB ] )
  );
  if ( out.min.x > out.max.x || out.min.y > out.max.y || out.min.z > out.max.z ) {
    out.makeEmpty();
  }
  return out;
}

// Intersection of two bitecs SoA boxes -> dst entity's SoA store.
export function bitecsBox3IntersectInto( eidOut, eidA, eidB, storeA = Box3Component, storeB = Box3Component, storeOut = storeA ) {
  const minX = Math.max( storeA.minX[ eidA ], storeB.minX[ eidB ] );
  const minY = Math.max( storeA.minY[ eidA ], storeB.minY[ eidB ] );
  const minZ = Math.max( storeA.minZ[ eidA ], storeB.minZ[ eidB ] );
  const maxX = Math.min( storeA.maxX[ eidA ], storeB.maxX[ eidB ] );
  const maxY = Math.min( storeA.maxY[ eidA ], storeB.maxY[ eidB ] );
  const maxZ = Math.min( storeA.maxZ[ eidA ], storeB.maxZ[ eidB ] );
  if ( minX > maxX || minY > maxY || minZ > maxZ ) {
    storeOut.minX[ eidOut ] = Infinity;
    storeOut.minY[ eidOut ] = Infinity;
    storeOut.minZ[ eidOut ] = Infinity;
    storeOut.maxX[ eidOut ] = - Infinity;
    storeOut.maxY[ eidOut ] = - Infinity;
    storeOut.maxZ[ eidOut ] = - Infinity;
  } else {
    storeOut.minX[ eidOut ] = minX;
    storeOut.minY[ eidOut ] = minY;
    storeOut.minZ[ eidOut ] = minZ;
    storeOut.maxX[ eidOut ] = maxX;
    storeOut.maxY[ eidOut ] = maxY;
    storeOut.maxZ[ eidOut ] = maxZ;
  }
  return eidOut;
}

// Expand a bitecs SoA box in place by a bitecs SoA point.
export function bitecsBox3ExpandByPointInPlace( eidBox, eidPoint, storeBox = Box3Component, storePoint ) {
  storeBox.minX[ eidBox ] = Math.min( storeBox.minX[ eidBox ], storePoint.x[ eidPoint ] );
  storeBox.minY[ eidBox ] = Math.min( storeBox.minY[ eidBox ], storePoint.y[ eidPoint ] );
  storeBox.minZ[ eidBox ] = Math.min( storeBox.minZ[ eidBox ], storePoint.z[ eidPoint ] );
  storeBox.maxX[ eidBox ] = Math.max( storeBox.maxX[ eidBox ], storePoint.x[ eidPoint ] );
  storeBox.maxY[ eidBox ] = Math.max( storeBox.maxY[ eidBox ], storePoint.y[ eidPoint ] );
  storeBox.maxZ[ eidBox ] = Math.max( storeBox.maxZ[ eidBox ], storePoint.z[ eidPoint ] );
  return eidBox;
}

// Expand a bitecs SoA box in place by a bitecs SoA vector.
export function bitecsBox3ExpandByVectorInPlace( eidBox, eidVector, storeBox = Box3Component, storeVector ) {
  storeBox.minX[ eidBox ] -= storeVector.x[ eidVector ];
  storeBox.minY[ eidBox ] -= storeVector.y[ eidVector ];
  storeBox.minZ[ eidBox ] -= storeVector.z[ eidVector ];
  storeBox.maxX[ eidBox ] += storeVector.x[ eidVector ];
  storeBox.maxY[ eidBox ] += storeVector.y[ eidVector ];
  storeBox.maxZ[ eidBox ] += storeVector.z[ eidVector ];
  return eidBox;
}

// Expand a bitecs SoA box in place by a scalar.
export function bitecsBox3ExpandByScalarInPlace( eid, scalar, store = Box3Component ) {
  store.minX[ eid ] -= scalar;
  store.minY[ eid ] -= scalar;
  store.minZ[ eid ] -= scalar;
  store.maxX[ eid ] += scalar;
  store.maxY[ eid ] += scalar;
  store.maxZ[ eid ] += scalar;
  return eid;
}

// Contains-point test for a bitecs SoA box vs a bitecs SoA point.
export function bitecsBox3ContainsPoint( eidBox, eidPoint, storeBox = Box3Component, storePoint ) {
  return storePoint.x[ eidPoint ] >= storeBox.minX[ eidBox ] && storePoint.x[ eidPoint ] <= storeBox.maxX[ eidBox ] &&
    storePoint.y[ eidPoint ] >= storeBox.minY[ eidBox ] && storePoint.y[ eidPoint ] <= storeBox.maxY[ eidBox ] &&
    storePoint.z[ eidPoint ] >= storeBox.minZ[ eidBox ] && storePoint.z[ eidPoint ] <= storeBox.maxZ[ eidBox ];
}

// Contains-box test for two bitecs SoA boxes.
export function bitecsBox3ContainsBox( eidOuter, eidInner, storeOuter = Box3Component, storeInner = Box3Component ) {
  return storeInner.minX[ eidInner ] >= storeOuter.minX[ eidOuter ] &&
    storeInner.maxX[ eidInner ] <= storeOuter.maxX[ eidOuter ] &&
    storeInner.minY[ eidInner ] >= storeOuter.minY[ eidOuter ] &&
    storeInner.maxY[ eidInner ] <= storeOuter.maxY[ eidOuter ] &&
    storeInner.minZ[ eidInner ] >= storeOuter.minZ[ eidOuter ] &&
    storeInner.maxZ[ eidInner ] <= storeOuter.maxZ[ eidOuter ];
}

// Intersects-box test for two bitecs SoA boxes.
export function bitecsBox3IntersectsBox( eidA, eidB, storeA = Box3Component, storeB = Box3Component ) {
  return ! ( storeB.minX[ eidB ] > storeA.maxX[ eidA ] || storeB.maxX[ eidB ] < storeA.minX[ eidA ] ||
    storeB.minY[ eidB ] > storeA.maxY[ eidA ] || storeB.maxY[ eidB ] < storeA.minY[ eidA ] ||
    storeB.minZ[ eidB ] > storeA.maxZ[ eidA ] || storeB.maxZ[ eidB ] < storeA.minZ[ eidA ] );
}

// Intersects-sphere test for a bitecs SoA box vs a bitecs SoA sphere.
export function bitecsBox3IntersectsSphere( eidBox, eidSphere, storeBox = Box3Component, storeSphere ) {
  const cx = storeSphere.cx[ eidSphere ], cy = storeSphere.cy[ eidSphere ], cz = storeSphere.cz[ eidSphere ];
  const r = storeSphere.radius[ eidSphere ];
  const closestX = clampScalar( cx, storeBox.minX[ eidBox ], storeBox.maxX[ eidBox ] );
  const closestY = clampScalar( cy, storeBox.minY[ eidBox ], storeBox.maxY[ eidBox ] );
  const closestZ = clampScalar( cz, storeBox.minZ[ eidBox ], storeBox.maxZ[ eidBox ] );
  const dx = cx - closestX, dy = cy - closestY, dz = cz - closestZ;
  return ( dx * dx + dy * dy + dz * dz ) <= ( r * r );
}

// Clamp a bitecs SoA point to a bitecs SoA box -> preallocated THREE.Vector3.
export function threeVec3FromBitecsBox3ClampPoint( out, eidBox, eidPoint, storeBox = Box3Component, storePoint ) {
  out.x = clampScalar( storePoint.x[ eidPoint ], storeBox.minX[ eidBox ], storeBox.maxX[ eidBox ] );
  out.y = clampScalar( storePoint.y[ eidPoint ], storeBox.minY[ eidBox ], storeBox.maxY[ eidBox ] );
  out.z = clampScalar( storePoint.z[ eidPoint ], storeBox.minZ[ eidBox ], storeBox.maxZ[ eidBox ] );
  return out;
}

// Clamp a bitecs SoA point to a bitecs SoA box -> dst SoA Vector3 store.
export function bitecsVec3Box3ClampPointInto( eidOutVec, eidBox, eidPoint, storeBox = Box3Component, storePoint, storeVec ) {
  storeVec.x[ eidOutVec ] = clampScalar( storePoint.x[ eidPoint ], storeBox.minX[ eidBox ], storeBox.maxX[ eidBox ] );
  storeVec.y[ eidOutVec ] = clampScalar( storePoint.y[ eidPoint ], storeBox.minY[ eidBox ], storeBox.maxY[ eidBox ] );
  storeVec.z[ eidOutVec ] = clampScalar( storePoint.z[ eidPoint ], storeBox.minZ[ eidBox ], storeBox.maxZ[ eidBox ] );
  return eidOutVec;
}

// Distance from a bitecs SoA box to a bitecs SoA point.
export function bitecsBox3DistanceToPoint( eidBox, eidPoint, storeBox = Box3Component, storePoint ) {
  const dx = Math.max( storeBox.minX[ eidBox ] - storePoint.x[ eidPoint ], 0, storePoint.x[ eidPoint ] - storeBox.maxX[ eidBox ] );
  const dy = Math.max( storeBox.minY[ eidBox ] - storePoint.y[ eidPoint ], 0, storePoint.y[ eidPoint ] - storeBox.maxY[ eidBox ] );
  const dz = Math.max( storeBox.minZ[ eidBox ] - storePoint.z[ eidPoint ], 0, storePoint.z[ eidPoint ] - storeBox.maxZ[ eidBox ] );
  return Math.sqrt( dx * dx + dy * dy + dz * dz );
}

// Get-center of a bitecs SoA box -> preallocated THREE.Vector3.
export function threeVec3FromBitecsBox3Center( out, eid, store = Box3Component ) {
  out.x = ( store.minX[ eid ] + store.maxX[ eid ] ) * 0.5;
  out.y = ( store.minY[ eid ] + store.maxY[ eid ] ) * 0.5;
  out.z = ( store.minZ[ eid ] + store.maxZ[ eid ] ) * 0.5;
  return out;
}

// Get-center of a bitecs SoA box -> dst SoA Vector3 store.
export function bitecsVec3Box3CenterInto( eidOutVec, eidBox, storeBox = Box3Component, storeVec ) {
  storeVec.x[ eidOutVec ] = ( storeBox.minX[ eidBox ] + storeBox.maxX[ eidBox ] ) * 0.5;
  storeVec.y[ eidOutVec ] = ( storeBox.minY[ eidBox ] + storeBox.maxY[ eidBox ] ) * 0.5;
  storeVec.z[ eidOutVec ] = ( storeBox.minZ[ eidBox ] + storeBox.maxZ[ eidBox ] ) * 0.5;
  return eidOutVec;
}

// Get-bounding-sphere of a bitecs SoA box -> preallocated THREE.Sphere.
export function threeSphereFromBitecsBox3BoundingSphere( out, eid, store = Box3Component ) {
  out.center.set(
    ( store.minX[ eid ] + store.maxX[ eid ] ) * 0.5,
    ( store.minY[ eid ] + store.maxY[ eid ] ) * 0.5,
    ( store.minZ[ eid ] + store.maxZ[ eid ] ) * 0.5
  );
  const dx = store.maxX[ eid ] - out.center.x;
  const dy = store.maxY[ eid ] - out.center.y;
  const dz = store.maxZ[ eid ] - out.center.z;
  out.radius = Math.sqrt( dx * dx + dy * dy + dz * dz );
  return out;
}

// Apply a bitecs SoA mat4 to a bitecs SoA box in place (computes new AABB).
export function bitecsBox3ApplyMatrix4InPlace( eidBox, eidM, storeBox = Box3Component, storeM = null ) {
  if ( storeM === null ) throw new Error( 'storeM (Matrix4Component) is required' );
  const e = storeM;
  const minX = storeBox.minX[ eidBox ], minY = storeBox.minY[ eidBox ], minZ = storeBox.minZ[ eidBox ];
  const maxX = storeBox.maxX[ eidBox ], maxY = storeBox.maxY[ eidBox ], maxZ = storeBox.maxZ[ eidBox ];
  const m00 = e.m00[ eidM ], m01 = e.m10[ eidM ], m02 = e.m20[ eidM ], m03 = e.m30[ eidM ];
  const m10 = e.m01[ eidM ], m11 = e.m11[ eidM ], m12 = e.m21[ eidM ], m13 = e.m31[ eidM ];
  const m20 = e.m02[ eidM ], m21 = e.m12[ eidM ], m22 = e.m22[ eidM ], m23 = e.m32[ eidM ];
  const corners = _scratchCorners;
  corners[ 0 ] = minX; corners[ 1 ] = minY; corners[ 2 ] = minZ;
  corners[ 3 ] = maxX; corners[ 4 ] = minY; corners[ 5 ] = minZ;
  corners[ 6 ] = minX; corners[ 7 ] = maxY; corners[ 8 ] = minZ;
  corners[ 9 ] = maxX; corners[ 10 ] = maxY; corners[ 11 ] = minZ;
  corners[ 12 ] = minX; corners[ 13 ] = minY; corners[ 14 ] = maxZ;
  corners[ 15 ] = maxX; corners[ 16 ] = minY; corners[ 17 ] = maxZ;
  corners[ 18 ] = minX; corners[ 19 ] = maxY; corners[ 20 ] = maxZ;
  corners[ 21 ] = maxX; corners[ 22 ] = maxY; corners[ 23 ] = maxZ;
  let nMinX = Infinity, nMinY = Infinity, nMinZ = Infinity;
  let nMaxX = - Infinity, nMaxY = - Infinity, nMaxZ = - Infinity;
  for ( let i = 0; i < 8; i ++ ) {
    const ix = i * 3;
    const px = corners[ ix ], py = corners[ ix + 1 ], pz = corners[ ix + 2 ];
    const tx = m00 * px + m01 * py + m02 * pz + m03;
    const ty = m10 * px + m11 * py + m12 * pz + m13;
    const tz = m20 * px + m21 * py + m22 * pz + m23;
    if ( tx < nMinX ) nMinX = tx;
    if ( ty < nMinY ) nMinY = ty;
    if ( tz < nMinZ ) nMinZ = tz;
    if ( tx > nMaxX ) nMaxX = tx;
    if ( ty > nMaxY ) nMaxY = ty;
    if ( tz > nMaxZ ) nMaxZ = tz;
  }
  storeBox.minX[ eidBox ] = nMinX;
  storeBox.minY[ eidBox ] = nMinY;
  storeBox.minZ[ eidBox ] = nMinZ;
  storeBox.maxX[ eidBox ] = nMaxX;
  storeBox.maxY[ eidBox ] = nMaxY;
  storeBox.maxZ[ eidBox ] = nMaxZ;
  return eidBox;
}

// Translate a bitecs SoA box in place by a bitecs SoA offset vector.
export function bitecsBox3TranslateInPlace( eid, eidOffset, storeBox = Box3Component, storeOffset ) {
  storeBox.minX[ eid ] += storeOffset.x[ eidOffset ];
  storeBox.minY[ eid ] += storeOffset.y[ eidOffset ];
  storeBox.minZ[ eid ] += storeOffset.z[ eidOffset ];
  storeBox.maxX[ eid ] += storeOffset.x[ eidOffset ];
  storeBox.maxY[ eid ] += storeOffset.y[ eidOffset ];
  storeBox.maxZ[ eid ] += storeOffset.z[ eidOffset ];
  return eid;
}

// gl-matrix vec3 min/max from a bitecs box, using gl-matrix vec3.min/max.
// Uses the imported glVec3 so the module graph is genuinely exercised.
export function glMatrixVec3MinMaxFromBitecs( outMin, outMax, eid, store = Box3Component ) {
  const aMin = _scratchVec3A;
  aMin[ 0 ] = store.minX[ eid ]; aMin[ 1 ] = store.minY[ eid ]; aMin[ 2 ] = store.minZ[ eid ];
  glVec3.copy( outMin, aMin );
  const aMax = _scratchVec3B;
  aMax[ 0 ] = store.maxX[ eid ]; aMax[ 1 ] = store.maxY[ eid ]; aMax[ 2 ] = store.maxZ[ eid ];
  glVec3.copy( outMax, aMax );
  return eid;
}

// gl-matrix ray-AABB intersection reading from a bitecs SoA box.
// Returns nearest positive t, or -1 if no hit.
export function glMatrixRayIntersectBitecsBox3( glOrigin, glDirection, eid, store = Box3Component ) {
  const ox = glOrigin[ 0 ], oy = glOrigin[ 1 ], oz = glOrigin[ 2 ];
  const dx = glDirection[ 0 ], dy = glDirection[ 1 ], dz = glDirection[ 2 ];
  const invDx = dx !== 0 ? 1 / dx : Infinity;
  const invDy = dy !== 0 ? 1 / dy : Infinity;
  const invDz = dz !== 0 ? 1 / dz : Infinity;
  let t1 = ( store.minX[ eid ] - ox ) * invDx;
  let t2 = ( store.maxX[ eid ] - ox ) * invDx;
  let tmin = Math.min( t1, t2 );
  let tmax = Math.max( t1, t2 );
  t1 = ( store.minY[ eid ] - oy ) * invDy;
  t2 = ( store.maxY[ eid ] - oy ) * invDy;
  tmin = Math.max( tmin, Math.min( t1, t2 ) );
  tmax = Math.min( tmax, Math.max( t1, t2 ) );
  t1 = ( store.minZ[ eid ] - oz ) * invDz;
  t2 = ( store.maxZ[ eid ] - oz ) * invDz;
  tmin = Math.max( tmin, Math.min( t1, t2 ) );
  tmax = Math.min( tmax, Math.max( t1, t2 ) );
  if ( tmax < 0 || tmin > tmax ) return - 1;
  return tmin >= 0 ? tmin : tmax;
}

/*
 * -----------------------------------------------------------------------------
 * HIGH-PRECISION HELPERS (double.js)
 * -----------------------------------------------------------------------------
 * double.js's Double type carries ~106 bits of mantissa. These helpers compute
 * the distance from a box to a point, the volume, and the union of two boxes
 * in double-double precision, avoiding the loss that hits the f64 path when
 * the box dimensions are tiny relative to its center coordinates.
 */

function _toDouble( value ) {
  return new Double( value );
}

// Returns the squared volume of a THREE.Box3, in double-double precision.
export function preciseVolume( box ) {
  const dx = _toDouble( box.max.x ).sub( _toDouble( box.min.x ) );
  const dy = _toDouble( box.max.y ).sub( _toDouble( box.min.y ) );
  const dz = _toDouble( box.max.z ).sub( _toDouble( box.min.z ) );
  return dx.mul( dy ).mul( dz ).toNumber();
}

// Returns the distance from a THREE.Box3 to a THREE.Vector3, in double-double precision.
export function preciseDistanceToPoint( box, point ) {
  let dx = _toDouble( 0 );
  let dy = _toDouble( 0 );
  let dz = _toDouble( 0 );
  const px = _toDouble( point.x ), py = _toDouble( point.y ), pz = _toDouble( point.z );
  const minX = _toDouble( box.min.x ), maxX = _toDouble( box.max.x );
  const minY = _toDouble( box.min.y ), maxY = _toDouble( box.max.y );
  const minZ = _toDouble( box.min.z ), maxZ = _toDouble( box.max.z );
  // dx = max(minX - px, 0, px - maxX)
  const dxLow = minX.sub( px );
  const dxHigh = px.sub( maxX );
  if ( dxLow.valueOf() > 0 ) dx = dxLow;
  else if ( dxHigh.valueOf() > 0 ) dx = dxHigh;
  const dyLow = minY.sub( py );
  const dyHigh = py.sub( maxY );
  if ( dyLow.valueOf() > 0 ) dy = dyLow;
  else if ( dyHigh.valueOf() > 0 ) dy = dyHigh;
  const dzLow = minZ.sub( pz );
  const dzHigh = pz.sub( maxZ );
  if ( dzLow.valueOf() > 0 ) dz = dzLow;
  else if ( dzHigh.valueOf() > 0 ) dz = dzHigh;
  return dx.mul( dx ).add( dy.mul( dy ) ).add( dz.mul( dz ) ).sqrt().toNumber();
}

// Union of two THREE.Box3 into out, in double-double precision.
export function preciseUnionInto( out, a, b ) {
  const ax0 = _toDouble( a.min.x ), ay0 = _toDouble( a.min.y ), az0 = _toDouble( a.min.z );
  const ax1 = _toDouble( a.max.x ), ay1 = _toDouble( a.max.y ), az1 = _toDouble( a.max.z );
  const bx0 = _toDouble( b.min.x ), by0 = _toDouble( b.min.y ), bz0 = _toDouble( b.min.z );
  const bx1 = _toDouble( b.max.x ), by1 = _toDouble( b.max.y ), bz1 = _toDouble( b.max.z );
  out.min.x = ax0.valueOf() < bx0.valueOf() ? a.min.x : b.min.x;
  out.min.y = ay0.valueOf() < by0.valueOf() ? a.min.y : b.min.y;
  out.min.z = az0.valueOf() < bz0.valueOf() ? a.min.z : b.min.z;
  out.max.x = ax1.valueOf() > bx1.valueOf() ? a.max.x : b.max.x;
  out.max.y = ay1.valueOf() > by1.valueOf() ? a.max.y : b.max.y;
  out.max.z = az1.valueOf() > bz1.valueOf() ? a.max.z : b.max.z;
  return out;
}

/*
 * -----------------------------------------------------------------------------
 * PROCEDURAL NOISE (simplex-noise)
 * -----------------------------------------------------------------------------
 * A cached 3D simplex-noise generator per seed. setFromNoise3D places the box
 * center at a noise-derived offset and sizes it from three more decorrelated
 * samples. Useful for procedural scatter, biome cell sizes, and hand-authored
 * "random AABB" test data.
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

// Fill a THREE.Box3 from a 3D simplex field sampled at (x, y, z). The center
// is placed at a noise-derived offset from the origin; the size along each
// axis is derived from a decorrelated sample scaled by `sizeScale`.
export function setFromNoise3D( out, x, y, z, seed = 0, centerScale = 1, sizeScale = 1 ) {
  const n = _cachedNoise3D( seed );
  const cx = n( x, y, z ) * centerScale;
  const cy = n( x + 31.416, y + 47.853, z + 12.793 ) * centerScale;
  const cz = n( x - 17.234, y - 53.127, z - 91.056 ) * centerScale;
  const sx = Math.abs( n( x + 100.1, y + 200.2, z + 300.3 ) ) * sizeScale;
  const sy = Math.abs( n( x - 110.5, y - 210.6, z - 310.7 ) ) * sizeScale;
  const sz = Math.abs( n( x + 55.1, y - 66.2, z + 77.3 ) ) * sizeScale;
  out.min.set( cx - sx, cy - sy, cz - sz );
  out.max.set( cx + sx, cy + sy, cz + sz );
  return out;
}

// Drop every cached noise generator.
export function disposeNoise3DCache() {
  _noise3DCache.clear();
}

// Internal scalar clamp used by the SoA bridges. Avoids pulling in MathUtils.
function clampScalar( value, min, max ) {
  return value < min ? min : ( value > max ? max : value );
}

// Module-local scratch buffers — allocated once, reused across every bridge.
const _scratchCorners = new Float32Array( 24 );
const _scratchVec3A = new Float32Array( 3 );
const _scratchVec3B = new Float32Array( 3 );

/*
 * -----------------------------------------------------------------------------
 * THREE.Box3
 * -----------------------------------------------------------------------------
 */
class Box3 {

  constructor( min = new Vector3( + Infinity, + Infinity, + Infinity ), max = new Vector3( - Infinity, - Infinity, - Infinity ) ) {
    this.isBox3 = true;
    this.min = min;
    this.max = max;
  }

  set( min, max ) {
    this.min.copy( min );
    this.max.copy( max );
    return this;
  }

  setFromArray( array ) {
    this.makeEmpty();
    return this.expandByPoint( _vector.fromArray( array ) );
  }

  setFromBufferAttribute( attribute ) {
    let minX = + Infinity;
    let minY = + Infinity;
    let minZ = + Infinity;
    let maxX = - Infinity;
    let maxY = - Infinity;
    let maxZ = - Infinity;
    for ( let i = 0, l = attribute.count; i < l; i ++ ) {
      const x = attribute.getX( i );
      const y = attribute.getY( i );
      const z = attribute.getZ( i );
      minX = Math.min( minX, x );
      minY = Math.min( minY, y );
      minZ = Math.min( minZ, z );
      maxX = Math.max( maxX, x );
      maxY = Math.max( maxY, y );
      maxZ = Math.max( maxZ, z );
    }
    this.min.set( minX, minY, minZ );
    this.max.set( maxX, maxY, maxZ );
    return this;
  }

  setFromPoints( points ) {
    this.makeEmpty();
    for ( let i = 0, il = points.length; i < il; i ++ ) {
      this.expandByPoint( points[ i ] );
    }
    return this;
  }

  setFromCenterAndSize( center, size ) {
    const halfSize = _vector.copy( size ).multiplyScalar( 0.5 );
    this.min.copy( center ).sub( halfSize );
    this.max.copy( center ).add( halfSize );
    return this;
  }

  setFromObject( object, precise = false ) {
    this.makeEmpty();
    return this.expandByObject( object, precise );
  }

  clone() {
    return new this.constructor().copy( this );
  }

  copy( box ) {
    this.min.copy( box.min );
    this.max.copy( box.max );
    return this;
  }

  makeEmpty() {
    this.min.x = this.min.y = this.min.z = + Infinity;
    this.max.x = this.max.y = this.max.z = - Infinity;
    return this;
  }

  isEmpty() {
    return ( this.max.x < this.min.x ) || ( this.max.y < this.min.y ) || ( this.max.z < this.min.z );
  }

  getCenter( target ) {
    if ( target === undefined ) {
      console.warn( 'THREE.Box3: .getCenter() target is now required' );
      target = new Vector3();
    }
    return this.isEmpty() ? target.set( 0, 0, 0 ) : target.addVectors( this.min, this.max ).multiplyScalar( 0.5 );
  }

  getSize( target ) {
    if ( target === undefined ) {
      console.warn( 'THREE.Box3: .getSize() target is now required' );
      target = new Vector3();
    }
    return this.isEmpty() ? target.set( 0, 0, 0 ) : target.subVectors( this.max, this.min );
  }

  expandByPoint( point ) {
    this.min.min( point );
    this.max.max( point );
    return this;
  }

  expandByVector( vector ) {
    this.min.sub( vector );
    this.max.add( vector );
    return this;
  }

  expandByScalar( scalar ) {
    this.min.addScalar( - scalar );
    this.max.addScalar( scalar );
    return this;
  }

  expandByObject( object, precise = false ) {
    object.updateWorldMatrix( false, false );
    const geometry = object.geometry;
    if ( geometry !== undefined ) {
      const positionAttribute = geometry.getAttribute( 'position' );
      if ( precise === true && positionAttribute !== undefined && object.isInstancedMesh !== true ) {
        for ( let i = 0, l = positionAttribute.count; i < l; i ++ ) {
          if ( object.isMesh === true ) {
            object.getVertexPosition( i, _vector );
          } else {
            _vector.fromBufferAttribute( positionAttribute, i );
          }
          _vector.applyMatrix4( object.matrixWorld );
          this.expandByPoint( _vector );
        }
      } else {
        if ( object.boundingBox !== undefined ) {
          if ( object.boundingBox === null ) {
            object.computeBoundingBox();
          }
          _box.copy( object.boundingBox );
        } else {
          if ( geometry.boundingBox === null ) {
            geometry.computeBoundingBox();
          }
          _box.copy( geometry.boundingBox );
        }
        _box.applyMatrix4( object.matrixWorld );
        this.union( _box );
      }
    }
    const children = object.children;
    for ( let i = 0, l = children.length; i < l; i ++ ) {
      this.expandByObject( children[ i ], precise );
    }
    return this;
  }

  containsPoint( point ) {
    return point.x >= this.min.x && point.x <= this.max.x &&
      point.y >= this.min.y && point.y <= this.max.y &&
      point.z >= this.min.z && point.z <= this.max.z;
  }

  containsBox( box ) {
    return this.min.x <= box.min.x && box.max.x <= this.max.x &&
      this.min.y <= box.min.y && box.max.y <= this.max.y &&
      this.min.z <= box.min.z && box.max.z <= this.max.z;
  }

  getParameter( point, target ) {
    if ( target === undefined ) {
      console.warn( 'THREE.Box3: .getParameter() target is now required' );
      target = new Vector3();
    }
    return target.set(
      ( point.x - this.min.x ) / ( this.max.x - this.min.x ),
      ( point.y - this.min.y ) / ( this.max.y - this.min.y ),
      ( point.z - this.min.z ) / ( this.max.z - this.min.z )
    );
  }

  intersectsBox( box ) {
    return ! ( box.max.x < this.min.x || box.min.x > this.max.x ||
      box.max.y < this.min.y || box.min.y > this.max.y ||
      box.max.z < this.min.z || box.min.z > this.max.z );
  }

  intersectsSphere( sphere ) {
    this.clampPoint( sphere.center, _vector );
    return _vector.distanceToSquared( sphere.center ) <= ( sphere.radius * sphere.radius );
  }

  intersectsPlane( plane ) {
    let min, max;
    if ( plane.normal.x > 0 ) {
      min = plane.normal.x * this.min.x;
      max = plane.normal.x * this.max.x;
    } else {
      min = plane.normal.x * this.max.x;
      max = plane.normal.x * this.min.x;
    }
    if ( plane.normal.y > 0 ) {
      min += plane.normal.y * this.min.y;
      max += plane.normal.y * this.max.y;
    } else {
      min += plane.normal.y * this.max.y;
      max += plane.normal.y * this.min.y;
    }
    if ( plane.normal.z > 0 ) {
      min += plane.normal.z * this.min.z;
      max += plane.normal.z * this.max.z;
    } else {
      min += plane.normal.z * this.max.z;
      max += plane.normal.z * this.min.z;
    }
    return ( min <= - plane.constant && max >= - plane.constant );
  }

  intersectsTriangle( triangle ) {
    if ( this.isEmpty() ) {
      return false;
    }

    // Compute the box center and half-extents.
    this.getCenter( _center );
    _extents.subVectors( this.max, _center );

    // Translate the triangle so the box is centered at the origin.
    _v0.subVectors( triangle.a, _center );
    _v1.subVectors( triangle.b, _center );
    _v2.subVectors( triangle.c, _center );

    // Triangle edges.
    _f0.subVectors( _v1, _v0 );
    _f1.subVectors( _v2, _v1 );
    _f2.subVectors( _v0, _v2 );

    // Test the 3 box axes (AABB is axis-aligned, so these are the world axes).
    if ( _axisTest( _v0, _v1, _v2, _extents, _boxAxes[ 0 ] ) ) return false;
    if ( _axisTest( _v0, _v1, _v2, _extents, _boxAxes[ 1 ] ) ) return false;
    if ( _axisTest( _v0, _v1, _v2, _extents, _boxAxes[ 2 ] ) ) return false;

    // Test the triangle's normal (edge0 x edge1).
    _normal.crossVectors( _f0, _f1 );
    if ( _axisTest( _v0, _v1, _v2, _extents, _normal ) ) return false;

    // Test the 9 cross products of triangle edges with box axes.
    _crossAxes[ 0 ].crossVectors( _f0, _boxAxes[ 0 ] );
    _crossAxes[ 1 ].crossVectors( _f0, _boxAxes[ 1 ] );
    _crossAxes[ 2 ].crossVectors( _f0, _boxAxes[ 2 ] );
    _crossAxes[ 3 ].crossVectors( _f1, _boxAxes[ 0 ] );
    _crossAxes[ 4 ].crossVectors( _f1, _boxAxes[ 1 ] );
    _crossAxes[ 5 ].crossVectors( _f1, _boxAxes[ 2 ] );
    _crossAxes[ 6 ].crossVectors( _f2, _boxAxes[ 0 ] );
    _crossAxes[ 7 ].crossVectors( _f2, _boxAxes[ 1 ] );
    _crossAxes[ 8 ].crossVectors( _f2, _boxAxes[ 2 ] );

    for ( let i = 0; i < 9; i ++ ) {
      if ( _axisTest( _v0, _v1, _v2, _extents, _crossAxes[ i ] ) ) return false;
    }

    return true;
  }

  clampPoint( point, target ) {
    if ( target === undefined ) {
      console.warn( 'THREE.Box3: .clampPoint() target is now required' );
      target = new Vector3();
    }
    return target.copy( point ).clamp( this.min, this.max );
  }

  distanceToPoint( point ) {
    const clampedPoint = _vector.copy( point ).clamp( this.min, this.max );
    return clampedPoint.sub( point ).length();
  }

  getBoundingSphere( target ) {
    if ( target === undefined ) {
      console.warn( 'THREE.Box3: .getBoundingSphere() target is now required' );
      target = new Sphere();
    }
    this.getCenter( target.center );
    target.radius = this.getSize( _vector ).length() * 0.5;
    return target;
  }

  intersect( box ) {
    this.min.max( box.min );
    this.max.min( box.max );
    if ( this.isEmpty() ) this.makeEmpty();
    return this;
  }

  union( box ) {
    this.min.min( box.min );
    this.max.max( box.max );
    return this;
  }

  applyMatrix4( matrix ) {
    if ( this.isEmpty() ) return this;
    // Transform all 8 corners and rebuild the AABB from them. This is the
    // r185 algorithm and is exact for any affine transform, including shear
    // and non-uniform scale.
    const points = _points;
    points[ 0 ].set( this.min.x, this.min.y, this.min.z ).applyMatrix4( matrix );
    points[ 1 ].set( this.min.x, this.min.y, this.max.z ).applyMatrix4( matrix );
    points[ 2 ].set( this.min.x, this.max.y, this.min.z ).applyMatrix4( matrix );
    points[ 3 ].set( this.min.x, this.max.y, this.max.z ).applyMatrix4( matrix );
    points[ 4 ].set( this.max.x, this.min.y, this.min.z ).applyMatrix4( matrix );
    points[ 5 ].set( this.max.x, this.min.y, this.max.z ).applyMatrix4( matrix );
    points[ 6 ].set( this.max.x, this.max.y, this.min.z ).applyMatrix4( matrix );
    points[ 7 ].set( this.max.x, this.max.y, this.max.z ).applyMatrix4( matrix );
    this.makeEmpty();
    for ( let i = 0; i < 8; i ++ ) {
      this.expandByPoint( points[ i ] );
    }
    return this;
  }

  translate( offset ) {
    this.min.add( offset );
    this.max.add( offset );
    return this;
  }

  equals( box ) {
    return box.min.equals( this.min ) && box.max.equals( this.max );
  }

  fromArray( array ) {
    this.min.fromArray( array, 0 );
    this.max.fromArray( array, 3 );
    return this;
  }

  toArray( array = [], offset = 0 ) {
    this.min.toArray( array, offset );
    this.max.toArray( array, offset + 3 );
    return array;
  }

}

// Internal SAT helper: returns true if the box and triangle are separated
// along `axis`. `v0`, `v1`, `v2` are the triangle vertices relative to the
// box center; `extents` is the box half-extent vector.
function _axisTest( v0, v1, v2, extents, axis ) {
  const p0 = v0.dot( axis );
  const p1 = v1.dot( axis );
  const p2 = v2.dot( axis );
  const r = extents.x * Math.abs( axis.x ) +
    extents.y * Math.abs( axis.y ) +
    extents.z * Math.abs( axis.z );
  const maxP = Math.max( p0, p1, p2 );
  const minP = Math.min( p0, p1, p2 );
  return minP > r || maxP < - r;
}

const _vector = /*@__PURE__*/ new Vector3();
const _box = /*@__PURE__*/ new Box3();
const _center = /*@__PURE__*/ new Vector3();
const _extents = /*@__PURE__*/ new Vector3();
const _v0 = /*@__PURE__*/ new Vector3();
const _v1 = /*@__PURE__*/ new Vector3();
const _v2 = /*@__PURE__*/ new Vector3();
const _f0 = /*@__PURE__*/ new Vector3();
const _f1 = /*@__PURE__*/ new Vector3();
const _f2 = /*@__PURE__*/ new Vector3();
const _normal = /*@__PURE__*/ new Vector3();

// Box axes for SAT. These never change, so they are allocated once.
const _boxAxes = [
  /*@__PURE__*/ new Vector3( 1, 0, 0 ),
  /*@__PURE__*/ new Vector3( 0, 1, 0 ),
  /*@__PURE__*/ new Vector3( 0, 0, 1 )
];

// Pre-allocated cross-product axes for the SAT test.
const _crossAxes = [
  /*@__PURE__*/ new Vector3(), /*@__PURE__*/ new Vector3(), /*@__PURE__*/ new Vector3(),
  /*@__PURE__*/ new Vector3(), /*@__PURE__*/ new Vector3(), /*@__PURE__*/ new Vector3(),
  /*@__PURE__*/ new Vector3(), /*@__PURE__*/ new Vector3(), /*@__PURE__*/ new Vector3()
];

// Pre-allocated corner points for the exact applyMatrix4.
const _points = [
  /*@__PURE__*/ new Vector3(), /*@__PURE__*/ new Vector3(),
  /*@__PURE__*/ new Vector3(), /*@__PURE__*/ new Vector3(),
  /*@__PURE__*/ new Vector3(), /*@__PURE__*/ new Vector3(),
  /*@__PURE__*/ new Vector3(), /*@__PURE__*/ new Vector3()
];

// Default export for parity with other math classes in this module.
export default Box3;
export { Box3 };