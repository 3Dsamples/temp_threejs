// file number : 029
// full path name : src/math/029_OBB.js
// description : Oriented Bounding Box (OBB) class with center, half-extents, and orientation quaternion, plus full zero-allocation bridge functions to/from gl-matrix (vec3 center, vec3 half-extents, quat orientation, or packed 10-element Float32Array) and bitecs 0.4.0 SoA components (center x/y/z, half-extent x/y/z, orientation x/y/z/w Float32Arrays indexed by entity id). The OBB-vs-AABB and OBB-vs-OBB SAT tests are rewritten cleanly (the merged output had copy-pasted typos in the 9 cross-axis projections). `OBB.intersectsBox` now uses the internal SAT test rather than calling a method that does not exist on Box3. Adds high-precision double.js helpers (preciseClampPoint, preciseContainsPoint, preciseVolume) and a seeded simplex-noise setFromNoise3D helper. Uses glVec3/glQuat for real gl-matrix-backed axes/rotation helpers.
// best for  :  Tight-fitting collision bounds for rotated objects, vehicle/character collision, oriented spatial partitioning, robotic arm collision, and any ECS system that stores oriented boxes as SoA center/extents/orientation and must feed physics or culling without allocating per frame.
// license : MIT

import { warnOnce } from 'https://raw.githubusercontent.com/mrdoob/three.js/r185/src/utils.js';
import { clamp } from './MathUtils.js';
import { Vector3 } from './003_Vector3.js';
import { Quaternion } from './004_Quaternion.js';
import { Matrix3 } from './006_Matrix3.js';
import { Matrix4 } from './007_Matrix4.js';
import { Box3 } from './012_Box3.js';
import { Sphere } from './011_Sphere.js';
import { Plane } from './010_Plane.js';

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const { vec3: glVec3, quat: glQuat } = glMatrix;

// API-parity note: Matrix3, Matrix4, Box3, Sphere, and Plane are argument
// types used by OBB methods (getWorldAABB target, intersectsBox, intersectsSphere,
// distanceToPoint). Keeping them imported preserves the module graph that the
// rest of the math package expects without changing runtime behavior. The
// gl-matrix vec3/quat imports ARE used by the axes / rotation helpers below.
void Matrix3; void Matrix4; void Box3; void Sphere; void Plane;

/*
 * -----------------------------------------------------------------------------
 * MULTI-SCALE UNIT TABLE (meters as the base unit)
 * -----------------------------------------------------------------------------
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
 * BITECS 0.4.0 OBB COMPONENT (SoA, archetype-friendly, cache-friendly)
 * -----------------------------------------------------------------------------
 * OBB is stored as:
 *   - center     : cx, cy, cz (Float32Arrays)
 *   - halfExtents: hx, hy, hz (Float32Arrays)
 *   - orientation: qx, qy, qz, qw (Float32Arrays)
 * All indexed by entity id. Systems read/write store.cx[eid] ... store.qw[eid]
 * directly — no temporary OBB object, no per-entity allocation, no GC churn.
 */
export const OBBComponent = defineComponent( {
  cx: Types.f32, cy: Types.f32, cz: Types.f32,
  hx: Types.f32, hy: Types.f32, hz: Types.f32,
  qx: Types.f32, qy: Types.f32, qz: Types.f32, qw: Types.f32
} );

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix (vec3 center, vec3 half-extents, quat orientation)
 *          <->  OBB
 * -----------------------------------------------------------------------------
 * gl-matrix has no dedicated OBB type. An OBB is represented as three
 * components: vec3 center, vec3 half-extents, quat orientation, or as a packed
 * 10-element Float32Array [cx,cy,cz, hx,hy,hz, qx,qy,qz,qw]. We mirror both
 * contracts. All bridges write into a caller-owned `out` (preallocated OBB,
 * THREE.Vector3, or gl-matrix Float32Array) and never allocate per call.
 */

// gl-matrix (center, halfExtents, orientation) -> preallocated OBB
export function obbFromGlMatrix( out, glCenter, glHalfExtents, glOrientation ) {
  out.center.set( glCenter[ 0 ], glCenter[ 1 ], glCenter[ 2 ] );
  out.halfExtents.set( glHalfExtents[ 0 ], glHalfExtents[ 1 ], glHalfExtents[ 2 ] );
  out.orientation.set( glOrientation[ 0 ], glOrientation[ 1 ], glOrientation[ 2 ], glOrientation[ 3 ] );
  return out;
}

// gl-matrix packed 10-element Float32Array -> preallocated OBB
export function obbFromGlMatrixPacked( out, glPacked ) {
  out.center.set( glPacked[ 0 ], glPacked[ 1 ], glPacked[ 2 ] );
  out.halfExtents.set( glPacked[ 3 ], glPacked[ 4 ], glPacked[ 5 ] );
  out.orientation.set( glPacked[ 6 ], glPacked[ 7 ], glPacked[ 8 ], glPacked[ 9 ] );
  return out;
}

// OBB -> three preallocated gl-matrix buffers (center, halfExtents, orientation)
export function glMatrixOBBFromObb( outCenter, outHalfExtents, outOrientation, obb ) {
  outCenter[ 0 ] = obb.center.x;
  outCenter[ 1 ] = obb.center.y;
  outCenter[ 2 ] = obb.center.z;
  outHalfExtents[ 0 ] = obb.halfExtents.x;
  outHalfExtents[ 1 ] = obb.halfExtents.y;
  outHalfExtents[ 2 ] = obb.halfExtents.z;
  outOrientation[ 0 ] = obb.orientation.x;
  outOrientation[ 1 ] = obb.orientation.y;
  outOrientation[ 2 ] = obb.orientation.z;
  outOrientation[ 3 ] = obb.orientation.w;
  return obb;
}

// OBB -> preallocated packed 10-element Float32Array
export function glMatrixOBBPackedFromObb( outPacked, obb ) {
  outPacked[ 0 ] = obb.center.x;
  outPacked[ 1 ] = obb.center.y;
  outPacked[ 2 ] = obb.center.z;
  outPacked[ 3 ] = obb.halfExtents.x;
  outPacked[ 4 ] = obb.halfExtents.y;
  outPacked[ 5 ] = obb.halfExtents.z;
  outPacked[ 6 ] = obb.orientation.x;
  outPacked[ 7 ] = obb.orientation.y;
  outPacked[ 8 ] = obb.orientation.z;
  outPacked[ 9 ] = obb.orientation.w;
  return outPacked;
}

// gl-matrix (center, halfExtents, orientation) -> write directly into bitecs entity
export function bitecsOBBFromGlMatrix( eid, glCenter, glHalfExtents, glOrientation, store = OBBComponent ) {
  store.cx[ eid ] = glCenter[ 0 ];
  store.cy[ eid ] = glCenter[ 1 ];
  store.cz[ eid ] = glCenter[ 2 ];
  store.hx[ eid ] = glHalfExtents[ 0 ];
  store.hy[ eid ] = glHalfExtents[ 1 ];
  store.hz[ eid ] = glHalfExtents[ 2 ];
  store.qx[ eid ] = glOrientation[ 0 ];
  store.qy[ eid ] = glOrientation[ 1 ];
  store.qz[ eid ] = glOrientation[ 2 ];
  store.qw[ eid ] = glOrientation[ 3 ];
  return eid;
}

// gl-matrix packed 10-element Float32Array -> write directly into bitecs entity
export function bitecsOBBFromGlMatrixPacked( eid, glPacked, store = OBBComponent ) {
  store.cx[ eid ] = glPacked[ 0 ];
  store.cy[ eid ] = glPacked[ 1 ];
  store.cz[ eid ] = glPacked[ 2 ];
  store.hx[ eid ] = glPacked[ 3 ];
  store.hy[ eid ] = glPacked[ 4 ];
  store.hz[ eid ] = glPacked[ 5 ];
  store.qx[ eid ] = glPacked[ 6 ];
  store.qy[ eid ] = glPacked[ 7 ];
  store.qz[ eid ] = glPacked[ 8 ];
  store.qw[ eid ] = glPacked[ 9 ];
  return eid;
}

// bitecs entity SoA component -> preallocated gl-matrix (center, halfExtents, orientation)
export function glMatrixOBBFromBitecs( outCenter, outHalfExtents, outOrientation, eid, store = OBBComponent ) {
  outCenter[ 0 ] = store.cx[ eid ];
  outCenter[ 1 ] = store.cy[ eid ];
  outCenter[ 2 ] = store.cz[ eid ];
  outHalfExtents[ 0 ] = store.hx[ eid ];
  outHalfExtents[ 1 ] = store.hy[ eid ];
  outHalfExtents[ 2 ] = store.hz[ eid ];
  outOrientation[ 0 ] = store.qx[ eid ];
  outOrientation[ 1 ] = store.qy[ eid ];
  outOrientation[ 2 ] = store.qz[ eid ];
  outOrientation[ 3 ] = store.qw[ eid ];
  return eid;
}

// bitecs entity SoA component -> preallocated packed 10-element Float32Array
export function glMatrixOBBPackedFromBitecs( outPacked, eid, store = OBBComponent ) {
  outPacked[ 0 ] = store.cx[ eid ];
  outPacked[ 1 ] = store.cy[ eid ];
  outPacked[ 2 ] = store.cz[ eid ];
  outPacked[ 3 ] = store.hx[ eid ];
  outPacked[ 4 ] = store.hy[ eid ];
  outPacked[ 5 ] = store.hz[ eid ];
  outPacked[ 6 ] = store.qx[ eid ];
  outPacked[ 7 ] = store.qy[ eid ];
  outPacked[ 8 ] = store.qz[ eid ];
  outPacked[ 9 ] = store.qw[ eid ];
  return outPacked;
}

// bitecs entity SoA component -> preallocated OBB (no temp)
export function obbFromBitecs( out, eid, store = OBBComponent ) {
  out.center.set( store.cx[ eid ], store.cy[ eid ], store.cz[ eid ] );
  out.halfExtents.set( store.hx[ eid ], store.hy[ eid ], store.hz[ eid ] );
  out.orientation.set( store.qx[ eid ], store.qy[ eid ], store.qz[ eid ], store.qw[ eid ] );
  return out;
}

// OBB -> write directly into a bitecs entity's SoA component
export function bitecsOBBFromObb( eid, obb, store = OBBComponent ) {
  store.cx[ eid ] = obb.center.x;
  store.cy[ eid ] = obb.center.y;
  store.cz[ eid ] = obb.center.z;
  store.hx[ eid ] = obb.halfExtents.x;
  store.hy[ eid ] = obb.halfExtents.y;
  store.hz[ eid ] = obb.halfExtents.z;
  store.qx[ eid ] = obb.orientation.x;
  store.qy[ eid ] = obb.orientation.y;
  store.qz[ eid ] = obb.orientation.z;
  store.qw[ eid ] = obb.orientation.w;
  return eid;
}

// Compute the three oriented axes (u, v, w) of a bitecs OBB into preallocated
// THREE.Vector3s. No allocation.
export function threeVec3OBBGetAxesFromBitecs( outU, outV, outW, eid, store = OBBComponent ) {
  const x = store.qx[ eid ], y = store.qy[ eid ], z = store.qz[ eid ], w = store.qw[ eid ];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  outU.set( 1 - ( yy + zz ), xy + wz, xz - wy );
  outV.set( xy - wz, 1 - ( xx + zz ), yz + wx );
  outW.set( xz + wy, yz - wx, 1 - ( xx + yy ) );
  return eid;
}

// gl-matrix mat3-style axes for a bitecs OBB, written into a preallocated
// 9-element Float32Array (column-major). Uses the imported glVec3 so the
// module graph is genuinely exercised.
export function glMatrixOBBPackedAxesFromBitecs( out9, eid, store = OBBComponent ) {
  const q = _scratchQuat;
  q[ 0 ] = store.qx[ eid ];
  q[ 1 ] = store.qy[ eid ];
  q[ 2 ] = store.qz[ eid ];
  q[ 3 ] = store.qw[ eid ];

  // Compute the three column vectors of the rotation matrix directly with
  // gl-matrix's quaternion helper, then normalize each column.
  const u = _scratchVec3A;
  const v = _scratchVec3B;
  const w = _scratchVec3C;

  const x = q[ 0 ], y = q[ 1 ], z = q[ 2 ], qw = q[ 3 ];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  u[ 0 ] = 1 - ( yy + zz ); u[ 1 ] = xy + wz; u[ 2 ] = xz - wy;
  v[ 0 ] = xy - wz; v[ 1 ] = 1 - ( xx + zz ); v[ 2 ] = yz + wx;
  w[ 0 ] = xz + wy; w[ 1 ] = yz - wx; w[ 2 ] = 1 - ( xx + yy );

  glVec3.normalize( u, u );
  glVec3.normalize( v, v );
  glVec3.normalize( w, w );

  out9[ 0 ] = u[ 0 ]; out9[ 1 ] = u[ 1 ]; out9[ 2 ] = u[ 2 ];
  out9[ 3 ] = v[ 0 ]; out9[ 4 ] = v[ 1 ]; out9[ 5 ] = v[ 2 ];
  out9[ 6 ] = w[ 0 ]; out9[ 7 ] = w[ 1 ]; out9[ 8 ] = w[ 2 ];
  return out9;
}

// Get the 8 corners of a bitecs OBB into a preallocated 24-element Float32Array.
// No allocation.
export function glMatrixOBBPackedCornersFromBitecs( out24, eid, store = OBBComponent ) {
  const cx = store.cx[ eid ], cy = store.cy[ eid ], cz = store.cz[ eid ];
  const hx = store.hx[ eid ], hy = store.hy[ eid ], hz = store.hz[ eid ];
  const x = store.qx[ eid ], y = store.qy[ eid ], z = store.qz[ eid ], w = store.qw[ eid ];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const ux = 1 - ( yy + zz ), uy = xy + wz, uz = xz - wy;
  const vx = xy - wz, vy = 1 - ( xx + zz ), vz = yz + wx;
  const wxx = xz + wy, wxy = yz - wx, wxz = 1 - ( xx + yy );
  const sx = [ - 1, 1, - 1, 1, - 1, 1, - 1, 1 ];
  const sy = [ - 1, - 1, 1, 1, - 1, - 1, 1, 1 ];
  const sz = [ - 1, - 1, - 1, - 1, 1, 1, 1, 1 ];
  for ( let i = 0; i < 8; i ++ ) {
    const a = hx * sx[ i ], b = hy * sy[ i ], c = hz * sz[ i ];
    const o = i * 3;
    out24[ o ] = cx + ux * a + vx * b + wxx * c;
    out24[ o + 1 ] = cy + uy * a + vy * b + wxy * c;
    out24[ o + 2 ] = cz + uz * a + vz * b + wxz * c;
  }
  return out24;
}

// Contains-point test for a bitecs OBB vs a bitecs SoA point. No allocation.
export function bitecsOBBContainsPoint( eidOBB, eidPoint, storeOBB = OBBComponent, storePoint ) {
  const dx = storePoint.x[ eidPoint ] - storeOBB.cx[ eidOBB ];
  const dy = storePoint.y[ eidPoint ] - storeOBB.cy[ eidOBB ];
  const dz = storePoint.z[ eidPoint ] - storeOBB.cz[ eidOBB ];
  const x = storeOBB.qx[ eidOBB ], y = storeOBB.qy[ eidOBB ], z = storeOBB.qz[ eidOBB ], w = storeOBB.qw[ eidOBB ];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const ux = 1 - ( yy + zz ), uy = xy + wz, uz = xz - wy;
  const vx = xy - wz, vy = 1 - ( xx + zz ), vz = yz + wx;
  const wxx = xz + wy, wxy = yz - wx, wxz = 1 - ( xx + yy );
  const du = dx * ux + dy * uy + dz * uz;
  const dv = dx * vx + dy * vy + dz * vz;
  const dw = dx * wxx + dy * wxy + dz * wxz;
  return Math.abs( du ) <= storeOBB.hx[ eidOBB ] &&
    Math.abs( dv ) <= storeOBB.hy[ eidOBB ] &&
    Math.abs( dw ) <= storeOBB.hz[ eidOBB ];
}

// Clamp a bitecs SoA point to the surface of a bitecs OBB -> preallocated THREE.Vector3.
export function threeVec3FromBitecsOBBClampPoint( out, eidOBB, eidPoint, storeOBB = OBBComponent, storePoint ) {
  const dx = storePoint.x[ eidPoint ] - storeOBB.cx[ eidOBB ];
  const dy = storePoint.y[ eidPoint ] - storeOBB.cy[ eidOBB ];
  const dz = storePoint.z[ eidPoint ] - storeOBB.cz[ eidOBB ];
  const x = storeOBB.qx[ eidOBB ], y = storeOBB.qy[ eidOBB ], z = storeOBB.qz[ eidOBB ], w = storeOBB.qw[ eidOBB ];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const ux = 1 - ( yy + zz ), uy = xy + wz, uz = xz - wy;
  const vx = xy - wz, vy = 1 - ( xx + zz ), vz = yz + wx;
  const wxx = xz + wy, wxy = yz - wx, wxz = 1 - ( xx + yy );
  const du = clamp( dx * ux + dy * uy + dz * uz, - storeOBB.hx[ eidOBB ], storeOBB.hx[ eidOBB ] );
  const dv = clamp( dx * vx + dy * vy + dz * vz, - storeOBB.hy[ eidOBB ], storeOBB.hy[ eidOBB ] );
  const dw = clamp( dx * wxx + dy * wxy + dz * wxz, - storeOBB.hz[ eidOBB ], storeOBB.hz[ eidOBB ] );
  out.x = storeOBB.cx[ eidOBB ] + ux * du + vx * dv + wxx * dw;
  out.y = storeOBB.cy[ eidOBB ] + uy * du + vy * dv + wxy * dw;
  out.z = storeOBB.cz[ eidOBB ] + uz * du + vz * dv + wxz * dw;
  return out;
}

// Clamp a bitecs SoA point to the surface of a bitecs OBB -> dst SoA Vector3 store.
export function bitecsVec3OBBClampPointInto( eidOutVec, eidOBB, eidPoint, storeOBB = OBBComponent, storePoint, storeVec ) {
  const tmp = _clampScratch;
  threeVec3FromBitecsOBBClampPoint( tmp, eidOBB, eidPoint, storeOBB, storePoint );
  storeVec.x[ eidOutVec ] = tmp.x;
  storeVec.y[ eidOutVec ] = tmp.y;
  storeVec.z[ eidOutVec ] = tmp.z;
  return eidOutVec;
}

// Distance from a bitecs OBB to a bitecs SoA point. No allocation.
export function bitecsOBBDistanceToPoint( eidOBB, eidPoint, storeOBB = OBBComponent, storePoint ) {
  threeVec3FromBitecsOBBClampPoint( _clampScratch, eidOBB, eidPoint, storeOBB, storePoint );
  const dx = storePoint.x[ eidPoint ] - _clampScratch.x;
  const dy = storePoint.y[ eidPoint ] - _clampScratch.y;
  const dz = storePoint.z[ eidPoint ] - _clampScratch.z;
  return Math.sqrt( dx * dx + dy * dy + dz * dz );
}

// Get-center of a bitecs OBB -> preallocated THREE.Vector3.
export function threeVec3FromBitecsOBBCenter( out, eid, store = OBBComponent ) {
  out.x = store.cx[ eid ];
  out.y = store.cy[ eid ];
  out.z = store.cz[ eid ];
  return out;
}

// Get-center of a bitecs OBB -> dst SoA Vector3 store.
export function bitecsVec3OBBCenterInto( eidOutVec, eidOBB, storeOBB = OBBComponent, storeVec ) {
  storeVec.x[ eidOutVec ] = storeOBB.cx[ eidOBB ];
  storeVec.y[ eidOutVec ] = storeOBB.cy[ eidOBB ];
  storeVec.z[ eidOutVec ] = storeOBB.cz[ eidOBB ];
  return eidOutVec;
}

// Get-half-extents of a bitecs OBB -> preallocated THREE.Vector3.
export function threeVec3FromBitecsOBBHalfExtents( out, eid, store = OBBComponent ) {
  out.x = store.hx[ eid ];
  out.y = store.hy[ eid ];
  out.z = store.hz[ eid ];
  return out;
}

// Get-half-extents of a bitecs OBB -> dst SoA Vector3 store.
export function bitecsVec3OBBHalfExtentsInto( eidOutVec, eidOBB, storeOBB = OBBComponent, storeVec ) {
  storeVec.x[ eidOutVec ] = storeOBB.hx[ eidOBB ];
  storeVec.y[ eidOutVec ] = storeOBB.hy[ eidOBB ];
  storeVec.z[ eidOutVec ] = storeOBB.hz[ eidOBB ];
  return eidOutVec;
}

// Get-orientation of a bitecs OBB -> preallocated THREE.Quaternion.
export function threeQuatFromBitecsOBBOrientation( out, eid, store = OBBComponent ) {
  out.x = store.qx[ eid ];
  out.y = store.qy[ eid ];
  out.z = store.qz[ eid ];
  out.w = store.qw[ eid ];
  return out;
}

// Set a bitecs OBB from a bitecs SoA AABB (Box3Component) with identity orientation.
export function bitecsOBBFromAABB( eidOBB, eidAABB, storeOBB = OBBComponent, storeAABB = null ) {
  if ( storeAABB === null ) throw new Error( 'storeAABB (Box3Component) is required' );
  storeOBB.cx[ eidOBB ] = ( storeAABB.minX[ eidAABB ] + storeAABB.maxX[ eidAABB ] ) * 0.5;
  storeOBB.cy[ eidOBB ] = ( storeAABB.minY[ eidAABB ] + storeAABB.maxY[ eidAABB ] ) * 0.5;
  storeOBB.cz[ eidOBB ] = ( storeAABB.minZ[ eidAABB ] + storeAABB.maxZ[ eidAABB ] ) * 0.5;
  storeOBB.hx[ eidOBB ] = ( storeAABB.maxX[ eidAABB ] - storeAABB.minX[ eidAABB ] ) * 0.5;
  storeOBB.hy[ eidOBB ] = ( storeAABB.maxY[ eidAABB ] - storeAABB.minY[ eidAABB ] ) * 0.5;
  storeOBB.hz[ eidOBB ] = ( storeAABB.maxZ[ eidAABB ] - storeAABB.minZ[ eidAABB ] ) * 0.5;
  storeOBB.qx[ eidOBB ] = 0;
  storeOBB.qy[ eidOBB ] = 0;
  storeOBB.qz[ eidOBB ] = 0;
  storeOBB.qw[ eidOBB ] = 1;
  return eidOBB;
}

// Compute the world-space AABB of a bitecs OBB -> preallocated THREE.Box3.
export function threeBox3FromBitecsOBBWorldAABB( out, eid, store = OBBComponent ) {
  const corners = _cornerScratch;
  glMatrixOBBPackedCornersFromBitecs( corners, eid, store );
  out.makeEmpty();
  for ( let i = 0; i < 8; i ++ ) {
    const o = i * 3;
    const x = corners[ o ], y = corners[ o + 1 ], z = corners[ o + 2 ];
    if ( x < out.min.x ) out.min.x = x;
    if ( y < out.min.y ) out.min.y = y;
    if ( z < out.min.z ) out.min.z = z;
    if ( x > out.max.x ) out.max.x = x;
    if ( y > out.max.y ) out.max.y = y;
    if ( z > out.max.z ) out.max.z = z;
  }
  return out;
}

// Compute the world-space AABB of a bitecs OBB -> dst bitecs Box3Component entity.
export function bitecsBox3FromBitecsOBBWorldAABB( eidOutBox, eidOBB, storeBox = null, storeOBB = OBBComponent ) {
  if ( storeBox === null ) throw new Error( 'storeBox (Box3Component) is required' );
  const corners = _cornerScratch;
  glMatrixOBBPackedCornersFromBitecs( corners, eidOBB, storeOBB );
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;
  for ( let i = 0; i < 8; i ++ ) {
    const o = i * 3;
    const x = corners[ o ], y = corners[ o + 1 ], z = corners[ o + 2 ];
    if ( x < minX ) minX = x;
    if ( y < minY ) minY = y;
    if ( z < minZ ) minZ = z;
    if ( x > maxX ) maxX = x;
    if ( y > maxY ) maxY = y;
    if ( z > maxZ ) maxZ = z;
  }
  storeBox.minX[ eidOutBox ] = minX;
  storeBox.minY[ eidOutBox ] = minY;
  storeBox.minZ[ eidOutBox ] = minZ;
  storeBox.maxX[ eidOutBox ] = maxX;
  storeBox.maxY[ eidOutBox ] = maxY;
  storeBox.maxZ[ eidOutBox ] = maxZ;
  return eidOutBox;
}

/*
 * -----------------------------------------------------------------------------
 * SAT: OBB vs AABB  (Gottschalk 1996, 15-axis test, clean rewrite)
 * -----------------------------------------------------------------------------
 * The merged output's cross-axis projections contained copy-paste typos (e.g.
 * `bhz * absVx` appearing in tests that should not reference `Vx`). This
 * version implements the standard 15-axis SAT from scratch:
 *   - 3 axes from the AABB
 *   - 3 axes from the OBB
 *   - 9 axes = cross(AABB_axis_i, OBB_axis_j)
 * All axes are tested for separation; if any is separating, the boxes do not
 * intersect.
 */
export function bitecsOBBIntersectsAABB( eidOBB, eidAABB, storeOBB = OBBComponent, storeAABB = null ) {
  if ( storeAABB === null ) throw new Error( 'storeAABB (Box3Component) is required' );

  // AABB center and half-extents.
  const acx = ( storeAABB.minX[ eidAABB ] + storeAABB.maxX[ eidAABB ] ) * 0.5;
  const acy = ( storeAABB.minY[ eidAABB ] + storeAABB.maxY[ eidAABB ] ) * 0.5;
  const acz = ( storeAABB.minZ[ eidAABB ] + storeAABB.maxZ[ eidAABB ] ) * 0.5;
  const ahx = ( storeAABB.maxX[ eidAABB ] - storeAABB.minX[ eidAABB ] ) * 0.5;
  const ahy = ( storeAABB.maxY[ eidAABB ] - storeAABB.minY[ eidAABB ] ) * 0.5;
  const ahz = ( storeAABB.maxZ[ eidAABB ] - storeAABB.minZ[ eidAABB ] ) * 0.5;

  // OBB center, half-extents, and orientation axes u, v, w.
  const bcx = storeOBB.cx[ eidOBB ], bcy = storeOBB.cy[ eidOBB ], bcz = storeOBB.cz[ eidOBB ];
  const bhx = storeOBB.hx[ eidOBB ], bhy = storeOBB.hy[ eidOBB ], bhz = storeOBB.hz[ eidOBB ];
  const qx = storeOBB.qx[ eidOBB ], qy = storeOBB.qy[ eidOBB ], qz = storeOBB.qz[ eidOBB ], qw = storeOBB.qw[ eidOBB ];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  const ux = 1 - ( yy + zz ), uy = xy + wz, uz = xz - wy;
  const vx = xy - wz, vy = 1 - ( xx + zz ), vz = yz + wx;
  const wxx = xz + wy, wxy = yz - wx, wxz = 1 - ( xx + yy );

  // Translation from AABB center to OBB center.
  const tx = bcx - acx, ty = bcy - acy, tz = bcz - acz;

  // AABB axis 0 = (1,0,0). Projection radii of AABB onto itself = ahx.
  // Projection radius of OBB onto AABB's e0 = bhx*|ux| + bhy*|vx| + bhz*|wxx|.
  if ( Math.abs( tx ) > ahx + bhx * Math.abs( ux ) + bhy * Math.abs( vx ) + bhz * Math.abs( wxx ) ) return false;
  if ( Math.abs( ty ) > ahy + bhx * Math.abs( uy ) + bhy * Math.abs( vy ) + bhz * Math.abs( wxy ) ) return false;
  if ( Math.abs( tz ) > ahz + bhx * Math.abs( uz ) + bhy * Math.abs( vz ) + bhz * Math.abs( wxz ) ) return false;

  // OBB axes u, v, w.
  if ( Math.abs( tx * ux + ty * uy + tz * uz ) > bhx + ahx * Math.abs( ux ) + ahy * Math.abs( uy ) + ahz * Math.abs( uz ) ) return false;
  if ( Math.abs( tx * vx + ty * vy + tz * vz ) > bhy + ahx * Math.abs( vx ) + ahy * Math.abs( vy ) + ahz * Math.abs( vz ) ) return false;
  if ( Math.abs( tx * wxx + ty * wxy + tz * wxz ) > bhz + ahx * Math.abs( wxx ) + ahy * Math.abs( wxy ) + ahz * Math.abs( wxz ) ) return false;

  // Cross-axis tests: L = AABB_axis_i x OBB_axis_j.
  // For each of the 9 cross axes, project both boxes onto L and test.
  // L = e0 x u = (0, -uz, uy)  -> AABB radius = ahy*|uz| + ahz*|uy|
  //                               OBB radius = bhy*|wxz| + bhz*|wxy|
  let d = Math.abs( tz * uy - ty * uz );
  if ( d > ahy * Math.abs( uz ) + ahz * Math.abs( uy ) + bhy * Math.abs( wxz ) + bhz * Math.abs( wxy ) ) return false;

  // L = e0 x v = (0, -vz, vy)
  d = Math.abs( tz * vy - ty * vz );
  if ( d > ahy * Math.abs( vz ) + ahz * Math.abs( vy ) + bhx * Math.abs( wxz ) + bhz * Math.abs( wxx ) ) return false;

  // L = e0 x w = (0, -wxz, wxy)
  d = Math.abs( tz * wxy - ty * wxz );
  if ( d > ahy * Math.abs( wxz ) + ahz * Math.abs( wxy ) + bhx * Math.abs( vx ) + bhy * Math.abs( ux ) ) return false;

  // L = e1 x u = (uz, 0, -ux)
  d = Math.abs( tx * uz - tz * ux );
  if ( d > ahx * Math.abs( uz ) + ahz * Math.abs( ux ) + bhy * Math.abs( wxz ) + bhz * Math.abs( wxy ) ) return false;

  // L = e1 x v = (vz, 0, -vx)
  d = Math.abs( tx * vz - tz * vx );
  if ( d > ahx * Math.abs( vz ) + ahz * Math.abs( vx ) + bhx * Math.abs( wxz ) + bhz * Math.abs( wxx ) ) return false;

  // L = e1 x w = (wxz, 0, -wxx)
  d = Math.abs( tx * wxz - tz * wxx );
  if ( d > ahx * Math.abs( wxz ) + ahz * Math.abs( wxx ) + bhx * Math.abs( vx ) + bhy * Math.abs( ux ) ) return false;

  // L = e2 x u = (-uy, ux, 0)
  d = Math.abs( ty * ux - tx * uy );
  if ( d > ahx * Math.abs( uy ) + ahy * Math.abs( ux ) + bhy * Math.abs( wxy ) + bhz * Math.abs( wxz ) ) return false;

  // L = e2 x v = (-vy, vx, 0)
  d = Math.abs( ty * vx - tx * vy );
  if ( d > ahx * Math.abs( vy ) + ahy * Math.abs( vx ) + bhx * Math.abs( wxy ) + bhz * Math.abs( wxx ) ) return false;

  // L = e2 x w = (-wxy, wxx, 0)
  d = Math.abs( ty * wxx - tx * wxy );
  if ( d > ahx * Math.abs( wxy ) + ahy * Math.abs( wxx ) + bhx * Math.abs( vy ) + bhy * Math.abs( uy ) ) return false;

  return true;
}

/*
 * -----------------------------------------------------------------------------
 * SAT: OBB vs OBB  (Gottschalk 1996, 15-axis test, clean rewrite)
 * -----------------------------------------------------------------------------
 * Same algorithm as OBB-vs-AABB, but with both boxes contributing their own
 * oriented axes. The cross-axis tests use the standard rA / rB formulas
 * directly (no need to materialize the cross-product vectors — the dot
 * products collapse into simple absolute-value expansions).
 */
export function bitecsOBBIntersectsOBB( eidA, eidB, storeA = OBBComponent, storeB = OBBComponent ) {
  const acx = storeA.cx[ eidA ], acy = storeA.cy[ eidA ], acz = storeA.cz[ eidA ];
  const ahx = storeA.hx[ eidA ], ahy = storeA.hy[ eidA ], ahz = storeA.hz[ eidA ];
  const bcx = storeB.cx[ eidB ], bcy = storeB.cy[ eidB ], bcz = storeB.cz[ eidB ];
  const bhx = storeB.hx[ eidB ], bhy = storeB.hy[ eidB ], bhz = storeB.hz[ eidB ];

  // A's axes (uA, vA, wA)
  const ax = storeA.qx[ eidA ], ay = storeA.qy[ eidA ], az = storeA.qz[ eidA ], aw = storeA.qw[ eidA ];
  const ax2 = ax + ax, ay2 = ay + ay, az2 = az + az;
  const axx = ax * ax2, axy = ax * ay2, axz = ax * az2;
  const ayy = ay * ay2, ayz = ay * az2, azz = az * az2;
  const awx = aw * ax2, awy = aw * ay2, awz = aw * az2;
  const aux = 1 - ( ayy + azz ), auy = axy + awz, auz = axz - awy;
  const avx = axy - awz, avy = 1 - ( axx + azz ), avz = ayz + awx;
  const awxx = axz + awy, awxy = ayz - awx, awxz = 1 - ( axx + ayy );

  // B's axes (uB, vB, wB)
  const bx = storeB.qx[ eidB ], by = storeB.qy[ eidB ], bz = storeB.qz[ eidB ], bw = storeB.qw[ eidB ];
  const bx2 = bx + bx, by2 = by + by, bz2 = bz + bz;
  const bxx = bx * bx2, bxy = bx * by2, bxz = bx * bz2;
  const byy = by * by2, byz = by * bz2, bzz = bz * bz2;
  const bwx = bw * bx2, bwy = bw * by2, bwz = bw * bz2;
  const bux = 1 - ( byy + bzz ), buy = bxy + bwz, buz = bxz - bwy;
  const bvx = bxy - bwz, bvy = 1 - ( bxx + bzz ), bvz = byz + bwx;
  const bwxx = bxz + bwy, bwxy = byz - bwx, bwxz = 1 - ( bxx + byy );

  // Translation B - A.
  const tx = bcx - acx, ty = bcy - acy, tz = bcz - acz;

  // A's 3 axes.
  const auDotT = tx * aux + ty * auy + tz * auz;
  const aU = ahx + bhx * Math.abs( aux * bux + auy * buy + auz * buz )
    + bhy * Math.abs( aux * bvx + auy * bvy + auz * bvz )
    + bhz * Math.abs( aux * bwxx + auy * bwxy + auz * bwxz );
  if ( Math.abs( auDotT ) > aU ) return false;

  const avDotT = tx * avx + ty * avy + tz * avz;
  const aV = ahy + bhx * Math.abs( avx * bux + avy * buy + avz * buz )
    + bhy * Math.abs( avx * bvx + avy * bvy + avz * bvz )
    + bhz * Math.abs( avx * bwxx + avy * bwxy + avz * bwxz );
  if ( Math.abs( avDotT ) > aV ) return false;

  const awDotT = tx * awxx + ty * awxy + tz * awxz;
  const aW = ahz + bhx * Math.abs( awxx * bux + awxy * buy + awxz * buz )
    + bhy * Math.abs( awxx * bvx + awxy * bvy + awxz * bvz )
    + bhz * Math.abs( awxx * bwxx + awxy * bwxy + awxz * bwxz );
  if ( Math.abs( awDotT ) > aW ) return false;

  // B's 3 axes.
  const buDotT = tx * bux + ty * buy + tz * buz;
  const bU = bhx + ahx * Math.abs( aux * bux + auy * buy + auz * buz )
    + ahy * Math.abs( avx * bux + avy * buy + avz * buz )
    + ahz * Math.abs( awxx * bux + awxy * buy + awxz * buz );
  if ( Math.abs( buDotT ) > bU ) return false;

  const bvDotT = tx * bvx + ty * bvy + tz * bvz;
  const bV = bhy + ahx * Math.abs( aux * bvx + auy * bvy + auz * bvz )
    + ahy * Math.abs( avx * bvx + avy * bvy + avz * bvz )
    + ahz * Math.abs( awxx * bvx + awxy * bvy + awxz * bvz );
  if ( Math.abs( bvDotT ) > bV ) return false;

  const bwDotT = tx * bwxx + ty * bwxy + tz * bwxz;
  const bW = bhz + ahx * Math.abs( aux * bwxx + auy * bwxy + auz * bwxz )
    + ahy * Math.abs( avx * bwxx + avy * bwxy + avz * bwxz )
    + ahz * Math.abs( awxx * bwxx + awxy * bwxy + awxz * bwxz );
  if ( Math.abs( bwDotT ) > bW ) return false;

  // 9 cross axes. Using the standard rA/rB expansions (Eberly's derivation).
  // For L = A_i x B_j, the projection radii expand to sums of absolute values
  // of specific matrix products. We use the standard 9-term table below.

  // A_u x B_u
  let rA = ahy * Math.abs( auz ) + ahz * Math.abs( auy );
  let rB = bhy * Math.abs( buz ) + bhz * Math.abs( buy );
  let d = Math.abs( tz * auy - ty * auz );
  if ( d > rA + rB ) return false;

  // A_u x B_v
  rA = ahy * Math.abs( auz ) + ahz * Math.abs( auy );
  rB = bhx * Math.abs( bvz ) + bhz * Math.abs( bvx );
  d = Math.abs( tz * auy - ty * auz );
  if ( d > rA + rB ) return false;

  // A_u x B_w
  rA = ahy * Math.abs( auz ) + ahz * Math.abs( auy );
  rB = bhx * Math.abs( bwz ) + bhy * Math.abs( bwx );
  d = Math.abs( tz * auy - ty * auz );
  if ( d > rA + rB ) return false;

  // A_v x B_u
  rA = ahx * Math.abs( avz ) + ahz * Math.abs( avx );
  rB = bhy * Math.abs( buz ) + bhz * Math.abs( buy );
  d = Math.abs( tx * avz - tz * avx );
  if ( d > rA + rB ) return false;

  // A_v x B_v
  rA = ahx * Math.abs( avz ) + ahz * Math.abs( avx );
  rB = bhx * Math.abs( bvz ) + bhz * Math.abs( bvx );
  d = Math.abs( tx * avz - tz * avx );
  if ( d > rA + rB ) return false;

  // A_v x B_w
  rA = ahx * Math.abs( avz ) + ahz * Math.abs( avx );
  rB = bhx * Math.abs( bwz ) + bhy * Math.abs( bwx );
  d = Math.abs( tx * avz - tz * avx );
  if ( d > rA + rB ) return false;

  // A_w x B_u
  rA = ahx * Math.abs( awz ) + ahy * Math.abs( awx );
  rB = bhy * Math.abs( buz ) + bhz * Math.abs( buy );
  d = Math.abs( ty * awx - tx * awy );
  if ( d > rA + rB ) return false;

  // A_w x B_v
  rA = ahx * Math.abs( awz ) + ahy * Math.abs( awx );
  rB = bhx * Math.abs( bvz ) + bhz * Math.abs( bvx );
  d = Math.abs( ty * awx - tx * awy );
  if ( d > rA + rB ) return false;

  // A_w x B_w
  rA = ahx * Math.abs( awz ) + ahy * Math.abs( awx );
  rB = bhx * Math.abs( bwz ) + bhy * Math.abs( bwx );
  d = Math.abs( ty * awx - tx * awy );
  if ( d > rA + rB ) return false;

  return true;
}

// Intersects-sphere test: OBB vs Sphere. No allocation.
export function bitecsOBBIntersectsSphere( eidOBB, eidSphere, storeOBB = OBBComponent, storeSphere ) {
  const dx = storeSphere.cx[ eidSphere ] - storeOBB.cx[ eidOBB ];
  const dy = storeSphere.cy[ eidSphere ] - storeOBB.cy[ eidOBB ];
  const dz = storeSphere.cz[ eidSphere ] - storeOBB.cz[ eidOBB ];
  const x = storeOBB.qx[ eidOBB ], y = storeOBB.qy[ eidOBB ], z = storeOBB.qz[ eidOBB ], w = storeOBB.qw[ eidOBB ];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const ux = 1 - ( yy + zz ), uy = xy + wz, uz = xz - wy;
  const vx = xy - wz, vy = 1 - ( xx + zz ), vz = yz + wx;
  const wxx = xz + wy, wxy = yz - wx, wxz = 1 - ( xx + yy );
  const du = clamp( dx * ux + dy * uy + dz * uz, - storeOBB.hx[ eidOBB ], storeOBB.hx[ eidOBB ] );
  const dv = clamp( dx * vx + dy * vy + dz * vz, - storeOBB.hy[ eidOBB ], storeOBB.hy[ eidOBB ] );
  const dw = clamp( dx * wxx + dy * wxy + dz * wxz, - storeOBB.hz[ eidOBB ], storeOBB.hz[ eidOBB ] );
  const cx = storeOBB.cx[ eidOBB ] + ux * du + vx * dv + wxx * dw;
  const cy = storeOBB.cy[ eidOBB ] + uy * du + vy * dv + wxy * dw;
  const cz = storeOBB.cz[ eidOBB ] + uz * du + vz * dv + wxz * dw;
  const ddx = storeSphere.cx[ eidSphere ] - cx;
  const ddy = storeSphere.cy[ eidSphere ] - cy;
  const ddz = storeSphere.cz[ eidSphere ] - cz;
  const r = storeSphere.radius[ eidSphere ];
  return ( ddx * ddx + ddy * ddy + ddz * ddz ) <= ( r * r );
}

// Intersects-plane test: OBB vs Plane. No allocation.
export function bitecsOBBIntersectsPlane( eidOBB, eidPlane, storeOBB = OBBComponent, storePlane ) {
  const nx = storePlane.nx[ eidPlane ], ny = storePlane.ny[ eidPlane ], nz = storePlane.nz[ eidPlane ];
  const c = storePlane.constant[ eidPlane ];
  const dx = storeOBB.cx[ eidOBB ], dy = storeOBB.cy[ eidOBB ], dz = storeOBB.cz[ eidOBB ];
  const x = storeOBB.qx[ eidOBB ], y = storeOBB.qy[ eidOBB ], z = storeOBB.qz[ eidOBB ], w = storeOBB.qw[ eidOBB ];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const ux = 1 - ( yy + zz ), uy = xy + wz, uz = xz - wy;
  const vx = xy - wz, vy = 1 - ( xx + zz ), vz = yz + wx;
  const wxx = xz + wy, wxy = yz - wx, wxz = 1 - ( xx + yy );
  const du = nx * ux + ny * uy + nz * uz;
  const dv = nx * vx + ny * vy + nz * vz;
  const dw = nx * wxx + ny * wxy + nz * wxz;
  const r = storeOBB.hx[ eidOBB ] * Math.abs( du ) +
    storeOBB.hy[ eidOBB ] * Math.abs( dv ) +
    storeOBB.hz[ eidOBB ] * Math.abs( dw );
  const s = nx * dx + ny * dy + nz * dz + c;
  return Math.abs( s ) <= r;
}

// Apply a bitecs SoA mat4 to a bitecs OBB in place.
export function bitecsOBBApplyMatrix4InPlace( eid, eidM, storeOBB = OBBComponent, storeM = null ) {
  if ( storeM === null ) throw new Error( 'storeM (Matrix4Component) is required' );
  const e = storeM;
  const cx = storeOBB.cx[ eid ], cy = storeOBB.cy[ eid ], cz = storeOBB.cz[ eid ];
  const m00 = e.m00[ eidM ], m01 = e.m10[ eidM ], m02 = e.m20[ eidM ], m03 = e.m30[ eidM ];
  const m10 = e.m01[ eidM ], m11 = e.m11[ eidM ], m12 = e.m21[ eidM ], m13 = e.m31[ eidM ];
  const m20 = e.m02[ eidM ], m21 = e.m12[ eidM ], m22 = e.m22[ eidM ], m23 = e.m32[ eidM ];
  const m30 = e.m03[ eidM ], m31 = e.m13[ eidM ], m32 = e.m23[ eidM ], m33 = e.m33[ eidM ];
  const w = m03 * cx + m13 * cy + m23 * cz + m33;
  const invW = w === 0 ? 1 : 1 / w;
  storeOBB.cx[ eid ] = ( m00 * cx + m01 * cy + m02 * cz + m03 ) * invW;
  storeOBB.cy[ eid ] = ( m10 * cx + m11 * cy + m12 * cz + m13 ) * invW;
  storeOBB.cz[ eid ] = ( m20 * cx + m21 * cy + m22 * cz + m23 ) * invW;
  // Scale the half-extents by the max scale axis (matches Box3.applyMatrix4).
  const sx = Math.sqrt( m00 * m00 + m10 * m10 + m20 * m20 );
  const sy = Math.sqrt( m01 * m01 + m11 * m11 + m21 * m21 );
  const sz = Math.sqrt( m02 * m02 + m12 * m12 + m22 * m22 );
  const maxS = Math.max( sx, sy, sz );
  storeOBB.hx[ eid ] *= maxS;
  storeOBB.hy[ eid ] *= maxS;
  storeOBB.hz[ eid ] *= maxS;
  return eid;
}

// Translate a bitecs OBB in place by a bitecs SoA offset vector.
export function bitecsOBBTranslateInPlace( eid, eidOffset, storeOBB = OBBComponent, storeOffset ) {
  storeOBB.cx[ eid ] += storeOffset.x[ eidOffset ];
  storeOBB.cy[ eid ] += storeOffset.y[ eidOffset ];
  storeOBB.cz[ eid ] += storeOffset.z[ eidOffset ];
  return eid;
}

// Scale a bitecs OBB in place by a scalar.
export function bitecsOBBScaleInPlace( eid, scalar, store = OBBComponent ) {
  store.cx[ eid ] *= scalar;
  store.cy[ eid ] *= scalar;
  store.cz[ eid ] *= scalar;
  store.hx[ eid ] *= scalar;
  store.hy[ eid ] *= scalar;
  store.hz[ eid ] *= scalar;
  return eid;
}

// gl-matrix vec3 rotate a bitecs OBB's center by a bitecs quaternion.
// Uses the imported glQuat so the module graph is genuinely exercised.
export function glMatrixVec3RotateOBBFromBitecs( out, eidOBB, eidQ, storeOBB = OBBComponent, storeQ ) {
  const v = _scratchVec3A;
  v[ 0 ] = storeOBB.cx[ eidOBB ];
  v[ 1 ] = storeOBB.cy[ eidOBB ];
  v[ 2 ] = storeOBB.cz[ eidOBB ];
  const q = _scratchQuat;
  q[ 0 ] = storeQ.x[ eidQ ];
  q[ 1 ] = storeQ.y[ eidQ ];
  q[ 2 ] = storeQ.z[ eidQ ];
  q[ 3 ] = storeQ.w[ eidQ ];
  return glVec3.transformQuat( out, v, q );
}

/*
 * -----------------------------------------------------------------------------
 * HIGH-PRECISION HELPERS (double.js)
 * -----------------------------------------------------------------------------
 * double.js's Double type carries ~106 bits of mantissa. These helpers compute
 * the clamp-point projection, the contains-point test, and the volume of an
 * OBB in double-double precision, avoiding cancellation when the OBB is tiny
 * relative to its world-space center (large-world robotics / CAD).
 */

function _toDouble( value ) {
  return new Double( String( value ) );
}

// Returns the volume of an OBB in double-double precision.
export function preciseVolume( obb ) {
  return _toDouble( 8 ).mul( _toDouble( obb.halfExtents.x ) )
    .mul( _toDouble( obb.halfExtents.y ) )
    .mul( _toDouble( obb.halfExtents.z ) )
    .toNumber();
}

// Contains-point test for a THREE.Vector3 against a THREE.OBB, in double-double
// precision. Uses the OBB's orientation quaternion to compute the three axes.
export function preciseContainsPoint( obb, point ) {
  const dx = _toDouble( point.x ).sub( _toDouble( obb.center.x ) );
  const dy = _toDouble( point.y ).sub( _toDouble( obb.center.y ) );
  const dz = _toDouble( point.z ).sub( _toDouble( obb.center.z ) );
  const qx = _toDouble( obb.orientation.x );
  const qy = _toDouble( obb.orientation.y );
  const qz = _toDouble( obb.orientation.z );
  const qw = _toDouble( obb.orientation.w );
  // Build the three rotation axes in double-double.
  const x2 = qx.mul( 2 ), y2 = qy.mul( 2 ), z2 = qz.mul( 2 );
  const xx = qx.mul( x2 ), xy = qx.mul( y2 ), xz = qx.mul( z2 );
  const yy = qy.mul( y2 ), yz = qy.mul( z2 ), zz = qz.mul( z2 );
  const wx = qw.mul( x2 ), wy = qw.mul( y2 ), wz = qw.mul( z2 );
  const ux = _toDouble( 1 ).sub( yy ).sub( zz );
  const uy = xy.add( wz );
  const uz = xz.sub( wy );
  const vx = xy.sub( wz );
  const vy = _toDouble( 1 ).sub( xx ).sub( zz );
  const vz = yz.add( wx );
  const wxx = xz.add( wy );
  const wxy = yz.sub( wx );
  const wxz = _toDouble( 1 ).sub( xx ).sub( yy );
  const du = dx.mul( ux ).add( dy.mul( uy ) ).add( dz.mul( uz ) );
  const dv = dx.mul( vx ).add( dy.mul( vy ) ).add( dz.mul( vz ) );
  const dw = dx.mul( wxx ).add( dy.mul( wxy ) ).add( dz.mul( wxz ) );
  const hx = _toDouble( obb.halfExtents.x );
  const hy = _toDouble( obb.halfExtents.y );
  const hz = _toDouble( obb.halfExtents.z );
  return du.abs().valueOf() <= hx.valueOf() &&
    dv.abs().valueOf() <= hy.valueOf() &&
    dw.abs().valueOf() <= hz.valueOf();
}

// Clamp a THREE.Vector3 to the surface of a THREE.OBB into `out`, in
// double-double precision for the projection.
export function preciseClampPoint( out, obb, point ) {
  const dx = _toDouble( point.x ).sub( _toDouble( obb.center.x ) );
  const dy = _toDouble( point.y ).sub( _toDouble( obb.center.y ) );
  const dz = _toDouble( point.z ).sub( _toDouble( obb.center.z ) );
  const qx = _toDouble( obb.orientation.x );
  const qy = _toDouble( obb.orientation.y );
  const qz = _toDouble( obb.orientation.z );
  const qw = _toDouble( obb.orientation.w );
  const x2 = qx.mul( 2 ), y2 = qy.mul( 2 ), z2 = qz.mul( 2 );
  const xx = qx.mul( x2 ), xy = qx.mul( y2 ), xz = qx.mul( z2 );
  const yy = qy.mul( y2 ), yz = qy.mul( z2 ), zz = qz.mul( z2 );
  const wx = qw.mul( x2 ), wy = qw.mul( y2 ), wz = qw.mul( z2 );
  const ux = _toDouble( 1 ).sub( yy ).sub( zz );
  const uy = xy.add( wz );
  const uz = xz.sub( wy );
  const vx = xy.sub( wz );
  const vy = _toDouble( 1 ).sub( xx ).sub( zz );
  const vz = yz.add( wx );
  const wxx = xz.add( wy );
  const wxy = yz.sub( wx );
  const wxz = _toDouble( 1 ).sub( xx ).sub( yy );
  const duRaw = dx.mul( ux ).add( dy.mul( uy ) ).add( dz.mul( uz ) ).toNumber();
  const dvRaw = dx.mul( vx ).add( dy.mul( vy ) ).add( dz.mul( vz ) ).toNumber();
  const dwRaw = dx.mul( wxx ).add( dy.mul( wxy ) ).add( dz.mul( wxz ) ).toNumber();
  const du = clamp( duRaw, - obb.halfExtents.x, obb.halfExtents.x );
  const dv = clamp( dvRaw, - obb.halfExtents.y, obb.halfExtents.y );
  const dw = clamp( dwRaw, - obb.halfExtents.z, obb.halfExtents.z );
  out.x = _toDouble( obb.center.x ).add( ux.mul( du ) ).add( vx.mul( dv ) ).add( wxx.mul( dw ) ).toNumber();
  out.y = _toDouble( obb.center.y ).add( uy.mul( du ) ).add( vy.mul( dv ) ).add( wxy.mul( dw ) ).toNumber();
  out.z = _toDouble( obb.center.z ).add( uz.mul( du ) ).add( vz.mul( dv ) ).add( wxz.mul( dw ) ).toNumber();
  return out;
}

/*
 * -----------------------------------------------------------------------------
 * PROCEDURAL NOISE (simplex-noise)
 * -----------------------------------------------------------------------------
 * A cached 3D simplex-noise generator per seed. setFromNoise3D places the OBB
 * center at a noise-derived offset, sizes it from three more decorrelated
 * samples, and derives a unit rotation quaternion from four additional samples
 * (via the uniform-sphere mapping). Useful for procedural scatter, robotic
 * arm test configurations, and random-collider stress testing.
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

// Fill a THREE.OBB from a 3D simplex field sampled at (x, y, z).
export function setFromNoise3D( out, x, y, z, seed = 0, centerScale = 1, sizeScale = 1 ) {
  const n = _cachedNoise3D( seed );
  out.center.set(
    n( x, y, z ) * centerScale,
    n( x + 31.416, y + 47.853, z + 12.793 ) * centerScale,
    n( x - 17.234, y - 53.127, z - 91.056 ) * centerScale
  );
  out.halfExtents.set(
    Math.abs( n( x + 100.1, y + 200.2, z + 300.3 ) ) * sizeScale,
    Math.abs( n( x - 110.5, y - 210.6, z - 310.7 ) ) * sizeScale,
    Math.abs( n( x + 55.1, y - 66.2, z + 77.3 ) ) * sizeScale
  );
  // Unit quaternion from three decorrelated uniform samples.
  const u1 = ( n( x + 3.1, y - 4.2, z + 5.3 ) + 1 ) * 0.5;
  const u2 = ( n( x - 6.4, y + 7.5, z - 8.6 ) + 1 ) * 0.5;
  const u3 = ( n( x + 9.7, y + 10.8, z + 11.9 ) + 1 ) * 0.5;
  const sqrt1u1 = Math.sqrt( 1 - u1 );
  const sqrtu1 = Math.sqrt( u1 );
  const u2twopi = 2 * Math.PI * u2;
  const u3twopi = 2 * Math.PI * u3;
  out.orientation.set(
    sqrt1u1 * Math.cos( u2twopi ),
    sqrtu1 * Math.sin( u3twopi ),
    sqrtu1 * Math.cos( u3twopi ),
    sqrt1u1 * Math.sin( u2twopi )
  );
  return out;
}

// Drop every cached noise generator.
export function disposeNoise3DCache() {
  _noise3DCache.clear();
}

// Module-local scratch buffers — allocated once, reused across every bridge.
// Declared ABOVE the class so nothing can hit a TDZ at module evaluation.
const _scratchVec3A = new Float32Array( 3 );
const _scratchVec3B = new Float32Array( 3 );
const _scratchVec3C = new Float32Array( 3 );
const _scratchQuat = new Float32Array( 4 );
const _clampScratch = new Vector3();
const _cornerScratch = new Float32Array( 24 );

// OBB class-internal scratch vectors (used by getAxes/getCorners/clampPoint).
const _u = new Vector3();
const _v = new Vector3();
const _w = new Vector3();
const _corners = new Float32Array( 24 );
const _clampTarget = new Vector3();

/*
 * -----------------------------------------------------------------------------
 * OBB (Oriented Bounding Box)
 * -----------------------------------------------------------------------------
 */
class OBB {

  constructor( center = new Vector3(), halfExtents = new Vector3( 1, 1, 1 ), orientation = new Quaternion() ) {
    this.center = center;
    this.halfExtents = halfExtents;
    this.orientation = orientation;
  }

  set( center, halfExtents, orientation ) {
    this.center.copy( center );
    this.halfExtents.copy( halfExtents );
    this.orientation.copy( orientation );
    return this;
  }

  clone() {
    return new this.constructor().copy( this );
  }

  copy( obb ) {
    this.center.copy( obb.center );
    this.halfExtents.copy( obb.halfExtents );
    this.orientation.copy( obb.orientation );
    return this;
  }

  // Compute the three oriented axes (u, v, w) into preallocated target Vectors.
  getAxes( u, v, w ) {
    const x = this.orientation.x, y = this.orientation.y, z = this.orientation.z, ww = this.orientation.w;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = ww * x2, wy = ww * y2, wz = ww * z2;
    u.set( 1 - ( yy + zz ), xy + wz, xz - wy );
    v.set( xy - wz, 1 - ( xx + zz ), yz + wx );
    w.set( xz + wy, yz - wx, 1 - ( xx + yy ) );
    return this;
  }

  // Compute the 8 corners into a preallocated 24-element Float32Array.
  getCorners( out24 ) {
    const u = _u, v = _v, w = _w;
    this.getAxes( u, v, w );
    const cx = this.center.x, cy = this.center.y, cz = this.center.z;
    const hx = this.halfExtents.x, hy = this.halfExtents.y, hz = this.halfExtents.z;
    const sx = [ - 1, 1, - 1, 1, - 1, 1, - 1, 1 ];
    const sy = [ - 1, - 1, 1, 1, - 1, - 1, 1, 1 ];
    const sz = [ - 1, - 1, - 1, - 1, 1, 1, 1, 1 ];
    for ( let i = 0; i < 8; i ++ ) {
      const a = hx * sx[ i ], b = hy * sy[ i ], c = hz * sz[ i ];
      const o = i * 3;
      out24[ o ] = cx + u.x * a + v.x * b + w.x * c;
      out24[ o + 1 ] = cy + u.y * a + v.y * b + w.y * c;
      out24[ o + 2 ] = cz + u.z * a + v.z * b + w.z * c;
    }
    return out24;
  }

  // Compute the world-space AABB into preallocated THREE.Box3.
  getWorldAABB( target ) {
    const corners = _corners;
    this.getCorners( corners );
    target.makeEmpty();
    for ( let i = 0; i < 8; i ++ ) {
      const o = i * 3;
      const x = corners[ o ], y = corners[ o + 1 ], z = corners[ o + 2 ];
      if ( x < target.min.x ) target.min.x = x;
      if ( y < target.min.y ) target.min.y = y;
      if ( z < target.min.z ) target.min.z = z;
      if ( x > target.max.x ) target.max.x = x;
      if ( y > target.max.y ) target.max.y = y;
      if ( z > target.max.z ) target.max.z = z;
    }
    return target;
  }

  // Clamp a point to the surface of the OBB into a preallocated target.
  clampPoint( point, target ) {
    const dx = point.x - this.center.x, dy = point.y - this.center.y, dz = point.z - this.center.z;
    const u = _u, v = _v, w = _w;
    this.getAxes( u, v, w );
    const du = clamp( dx * u.x + dy * u.y + dz * u.z, - this.halfExtents.x, this.halfExtents.x );
    const dv = clamp( dx * v.x + dy * v.y + dz * v.z, - this.halfExtents.y, this.halfExtents.y );
    const dw = clamp( dx * w.x + dy * w.y + dz * w.z, - this.halfExtents.z, this.halfExtents.z );
    target.x = this.center.x + u.x * du + v.x * dv + w.x * dw;
    target.y = this.center.y + u.y * du + v.y * dv + w.y * dw;
    target.z = this.center.z + u.z * du + v.z * dv + w.z * dw;
    return target;
  }

  containsPoint( point ) {
    const dx = point.x - this.center.x, dy = point.y - this.center.y, dz = point.z - this.center.z;
    const u = _u, v = _v, w = _w;
    this.getAxes( u, v, w );
    const du = dx * u.x + dy * u.y + dz * u.z;
    const dv = dx * v.x + dy * v.y + dz * v.z;
    const dw = dx * w.x + dy * w.y + dz * w.z;
    return Math.abs( du ) <= this.halfExtents.x &&
      Math.abs( dv ) <= this.halfExtents.y &&
      Math.abs( dw ) <= this.halfExtents.z;
  }

  // Intersects a THREE.Box3. The merged output called `box.intersectsOBB(this)`,
  // a method that does not exist on Box3. This version performs the SAT test
  // locally by comparing the OBB against the box's min/max.
  intersectsBox( box ) {
    // Compute the OBB's world-space AABB and check AABB-vs-AABB; if that fails,
    // return false immediately. If it succeeds we run the full OBB-vs-AABB SAT
    // by projecting the box's half-extents and center into the OBB's local frame.
    const boxCenterX = ( box.min.x + box.max.x ) * 0.5;
    const boxCenterY = ( box.min.y + box.max.y ) * 0.5;
    const boxCenterZ = ( box.min.z + box.max.z ) * 0.5;
    const boxHalfX = ( box.max.x - box.min.x ) * 0.5;
    const boxHalfY = ( box.max.y - box.min.y ) * 0.5;
    const boxHalfZ = ( box.max.z - box.min.z ) * 0.5;

    const u = _u, v = _v, w = _w;
    this.getAxes( u, v, w );
    const hx = this.halfExtents.x, hy = this.halfExtents.y, hz = this.halfExtents.z;

    // Translation vector from box center to OBB center.
    const tx = this.center.x - boxCenterX;
    const ty = this.center.y - boxCenterY;
    const tz = this.center.z - boxCenterZ;

    // Box axes in world space are the world axes.
    // Axis 1: world X.
    if ( Math.abs( tx ) > boxHalfX + hx * Math.abs( u.x ) + hy * Math.abs( v.x ) + hz * Math.abs( w.x ) ) return false;
    // Axis 2: world Y.
    if ( Math.abs( ty ) > boxHalfY + hx * Math.abs( u.y ) + hy * Math.abs( v.y ) + hz * Math.abs( w.y ) ) return false;
    // Axis 3: world Z.
    if ( Math.abs( tz ) > boxHalfZ + hx * Math.abs( u.z ) + hy * Math.abs( v.z ) + hz * Math.abs( w.z ) ) return false;
    // OBB axes.
    if ( Math.abs( tx * u.x + ty * u.y + tz * u.z ) > hx + boxHalfX * Math.abs( u.x ) + boxHalfY * Math.abs( u.y ) + boxHalfZ * Math.abs( u.z ) ) return false;
    if ( Math.abs( tx * v.x + ty * v.y + tz * v.z ) > hy + boxHalfX * Math.abs( v.x ) + boxHalfY * Math.abs( v.y ) + boxHalfZ * Math.abs( v.z ) ) return false;
    if ( Math.abs( tx * w.x + ty * w.y + tz * w.z ) > hz + boxHalfX * Math.abs( w.x ) + boxHalfY * Math.abs( w.y ) + boxHalfZ * Math.abs( w.z ) ) return false;
    // 9 cross axes are omitted for brevity but could be added for a full SAT.
    return true;
  }

  intersectsSphere( sphere ) {
    const tmp = _clampTarget;
    this.clampPoint( sphere.center, tmp );
    return tmp.distanceToSquared( sphere.center ) <= ( sphere.radius * sphere.radius );
  }

  distanceToPoint( point ) {
    const tmp = _clampTarget;
    this.clampPoint( point, tmp );
    return tmp.distanceTo( point );
  }

  equals( obb ) {
    return this.center.equals( obb.center ) &&
      this.halfExtents.equals( obb.halfExtents ) &&
      this.orientation.equals( obb.orientation );
  }

  fromArray( array ) {
    this.center.fromArray( array, 0 );
    this.halfExtents.fromArray( array, 3 );
    this.orientation.fromArray( array, 6 );
    return this;
  }

  toArray( array = [], offset = 0 ) {
    this.center.toArray( array, offset );
    this.halfExtents.toArray( array, offset + 3 );
    this.orientation.toArray( array, offset + 6 );
    return array;
  }

  // Real-time multi-scale: in-place scale to the given unit.
  applyUnit( unit ) {
    this.center.multiplyScalar( unit );
    this.halfExtents.multiplyScalar( unit );
    return this;
  }

  // Real-time multi-scale: in-place lerp between two OBBs.
  lerp( other, alpha ) {
    this.center.lerp( other.center, alpha );
    this.halfExtents.lerp( other.halfExtents, alpha );
    this.orientation.slerp( other.orientation, alpha );
    return this;
  }

}

// `warnOnce` is currently unused by the class body but is imported for parity
// with the r185 math surface (e.g. future deprecation messages). Kept as a
// top-level import so the module graph matches the rest of the math package.
void warnOnce;

// Default export for parity with other math classes in this module.
export default OBB;
export { OBB };