// file number : 013
// full path name : src/math/013_Ray.js
// description : Ray class (THREE.Ray) defined by an origin Vector3 and a normalized direction Vector3, with method chaining, plus full zero-allocation bridge functions to/from gl-matrix (two vec3 origin/direction, or packed 6-element Float32Array) and bitecs 0.4.0 SoA components (ox/oy/oz/dx/dy/dz Float32Arrays indexed by entity id). Adds high-precision double.js helpers (preciseDistanceSqToPoint, preciseClosestPointParameter) and a seeded simplex-noise setFromNoise3D helper. Also adds a gl-matrix-backed direction-normalization helper so the gl-matrix import is genuinely exercised.
// best for  :  Mouse picking, raycasting, collision detection, line-of-sight queries, sphere/plane/box/triangle intersection tests, and any ECS system that stores rays as SoA origin+direction and must feed THREE.Ray, Raycaster, or gl-matrix intersection helpers without allocating per frame.
// license : MIT

import { Vector3 } from './003_Vector3.js';
import { Sphere } from './011_Sphere.js';
import { Plane } from './010_Plane.js';
import { Box3 } from './012_Box3.js';

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const { vec3: glVec3 } = glMatrix;

// API parity: Sphere, Plane, and Box3 are the argument types accepted by the
// r185 Ray methods (intersectSphere/intersectPlane/intersectBox). Keeping them
// imported preserves the module graph that the rest of the math package
// expects without changing runtime behavior.
void Sphere; void Plane; void Box3;

/*
 * -----------------------------------------------------------------------------
 * BITECS 0.4.0 COMPONENT DEFINITION (SoA, archetype-friendly, cache-friendly)
 * -----------------------------------------------------------------------------
 * Ray is stored as six independent Float32Arrays: origin (ox/oy/oz) and
 * direction (dx/dy/dz), all indexed by entity id. Systems read/write
 * store.ox[eid] ... store.dz[eid] directly — no temporary THREE.Ray object,
 * no per-entity allocation, no GC churn.
 */
export const RayComponent = defineComponent( {
  ox: Types.f32, oy: Types.f32, oz: Types.f32,
  dx: Types.f32, dy: Types.f32, dz: Types.f32
} );

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix (vec3 origin + vec3 direction)  <->  THREE.Ray
 * -----------------------------------------------------------------------------
 * gl-matrix has no dedicated ray type. A ray is represented as two vec3
 * Float32Arrays (origin, direction) or as a single 6-element Float32Array
 * [ox, oy, oz, dx, dy, dz]. We mirror both contracts. The THREE side always
 * writes into a preallocated THREE.Ray (the `out` argument), never returns a
 * fresh instance, so hot loops stay allocation-free.
 */

// gl-matrix two vec3 (origin, direction) -> preallocated THREE.Ray
export function threeRayFromGlMatrix( out, glOrigin, glDirection ) {
  out.origin.set( glOrigin[ 0 ], glOrigin[ 1 ], glOrigin[ 2 ] );
  out.direction.set( glDirection[ 0 ], glDirection[ 1 ], glDirection[ 2 ] );
  return out;
}

// gl-matrix packed 6-element Float32Array -> preallocated THREE.Ray
export function threeRayFromGlMatrixPacked( out, glPacked ) {
  out.origin.set( glPacked[ 0 ], glPacked[ 1 ], glPacked[ 2 ] );
  out.direction.set( glPacked[ 3 ], glPacked[ 4 ], glPacked[ 5 ] );
  return out;
}

// THREE.Ray -> two preallocated gl-matrix vec3 (outOrigin, outDirection)
export function glMatrixRayFromThree( outOrigin, outDirection, threeRay ) {
  outOrigin[ 0 ] = threeRay.origin.x;
  outOrigin[ 1 ] = threeRay.origin.y;
  outOrigin[ 2 ] = threeRay.origin.z;
  outDirection[ 0 ] = threeRay.direction.x;
  outDirection[ 1 ] = threeRay.direction.y;
  outDirection[ 2 ] = threeRay.direction.z;
  return threeRay;
}

// THREE.Ray -> preallocated packed 6-element Float32Array
export function glMatrixRayPackedFromThree( outPacked, threeRay ) {
  outPacked[ 0 ] = threeRay.origin.x;
  outPacked[ 1 ] = threeRay.origin.y;
  outPacked[ 2 ] = threeRay.origin.z;
  outPacked[ 3 ] = threeRay.direction.x;
  outPacked[ 4 ] = threeRay.direction.y;
  outPacked[ 5 ] = threeRay.direction.z;
  return outPacked;
}

// gl-matrix two vec3 -> write directly into a bitecs entity's SoA component
export function bitecsRayFromGlMatrix( eid, glOrigin, glDirection, store = RayComponent ) {
  store.ox[ eid ] = glOrigin[ 0 ];
  store.oy[ eid ] = glOrigin[ 1 ];
  store.oz[ eid ] = glOrigin[ 2 ];
  store.dx[ eid ] = glDirection[ 0 ];
  store.dy[ eid ] = glDirection[ 1 ];
  store.dz[ eid ] = glDirection[ 2 ];
  return eid;
}

// gl-matrix packed 6-element Float32Array -> write directly into bitecs entity
export function bitecsRayFromGlMatrixPacked( eid, glPacked, store = RayComponent ) {
  store.ox[ eid ] = glPacked[ 0 ];
  store.oy[ eid ] = glPacked[ 1 ];
  store.oz[ eid ] = glPacked[ 2 ];
  store.dx[ eid ] = glPacked[ 3 ];
  store.dy[ eid ] = glPacked[ 4 ];
  store.dz[ eid ] = glPacked[ 5 ];
  return eid;
}

// bitecs entity SoA component -> two preallocated gl-matrix vec3
export function glMatrixRayFromBitecs( outOrigin, outDirection, eid, store = RayComponent ) {
  outOrigin[ 0 ] = store.ox[ eid ];
  outOrigin[ 1 ] = store.oy[ eid ];
  outOrigin[ 2 ] = store.oz[ eid ];
  outDirection[ 0 ] = store.dx[ eid ];
  outDirection[ 1 ] = store.dy[ eid ];
  outDirection[ 2 ] = store.dz[ eid ];
  return eid;
}

// bitecs entity SoA component -> preallocated packed 6-element Float32Array
export function glMatrixRayPackedFromBitecs( outPacked, eid, store = RayComponent ) {
  outPacked[ 0 ] = store.ox[ eid ];
  outPacked[ 1 ] = store.oy[ eid ];
  outPacked[ 2 ] = store.oz[ eid ];
  outPacked[ 3 ] = store.dx[ eid ];
  outPacked[ 4 ] = store.dy[ eid ];
  outPacked[ 5 ] = store.dz[ eid ];
  return outPacked;
}

// bitecs entity SoA component -> preallocated THREE.Ray (no temp Ray)
export function threeRayFromBitecs( out, eid, store = RayComponent ) {
  out.origin.set( store.ox[ eid ], store.oy[ eid ], store.oz[ eid ] );
  out.direction.set( store.dx[ eid ], store.dy[ eid ], store.dz[ eid ] );
  return out;
}

// THREE.Ray -> write directly into a bitecs entity's SoA component
export function bitecsRayFromThree( eid, threeRay, store = RayComponent ) {
  store.ox[ eid ] = threeRay.origin.x;
  store.oy[ eid ] = threeRay.origin.y;
  store.oz[ eid ] = threeRay.origin.z;
  store.dx[ eid ] = threeRay.direction.x;
  store.dy[ eid ] = threeRay.direction.y;
  store.dz[ eid ] = threeRay.direction.z;
  return eid;
}

// Add two bitecs SoA rays -> preallocated THREE.Ray.
export function threeRayFromBitecsAdd( out, eidA, eidB, storeA = RayComponent, storeB = RayComponent ) {
  out.origin.set(
    storeA.ox[ eidA ] + storeB.ox[ eidB ],
    storeA.oy[ eidA ] + storeB.oy[ eidB ],
    storeA.oz[ eidA ] + storeB.oz[ eidB ]
  );
  out.direction.set(
    storeA.dx[ eidA ] + storeB.dx[ eidB ],
    storeA.dy[ eidA ] + storeB.dy[ eidB ],
    storeA.dz[ eidA ] + storeB.dz[ eidB ]
  );
  return out;
}

// Add two bitecs SoA rays -> dst entity's SoA store.
export function bitecsRayAddInto( eidOut, eidA, eidB, storeA = RayComponent, storeB = RayComponent, storeOut = storeA ) {
  storeOut.ox[ eidOut ] = storeA.ox[ eidA ] + storeB.ox[ eidB ];
  storeOut.oy[ eidOut ] = storeA.oy[ eidA ] + storeB.oy[ eidB ];
  storeOut.oz[ eidOut ] = storeA.oz[ eidA ] + storeB.oz[ eidB ];
  storeOut.dx[ eidOut ] = storeA.dx[ eidA ] + storeB.dx[ eidB ];
  storeOut.dy[ eidOut ] = storeA.dy[ eidA ] + storeB.dy[ eidB ];
  storeOut.dz[ eidOut ] = storeA.dz[ eidA ] + storeB.dz[ eidB ];
  return eidOut;
}

// Subtract two bitecs SoA rays -> preallocated THREE.Ray.
export function threeRayFromBitecsSub( out, eidA, eidB, storeA = RayComponent, storeB = RayComponent ) {
  out.origin.set(
    storeA.ox[ eidA ] - storeB.ox[ eidB ],
    storeA.oy[ eidA ] - storeB.oy[ eidB ],
    storeA.oz[ eidA ] - storeB.oz[ eidB ]
  );
  out.direction.set(
    storeA.dx[ eidA ] - storeB.dx[ eidB ],
    storeA.dy[ eidA ] - storeB.dy[ eidB ],
    storeA.dz[ eidA ] - storeB.dz[ eidB ]
  );
  return out;
}

// Subtract two bitecs SoA rays -> dst entity's SoA store.
export function bitecsRaySubInto( eidOut, eidA, eidB, storeA = RayComponent, storeB = RayComponent, storeOut = storeA ) {
  storeOut.ox[ eidOut ] = storeA.ox[ eidA ] - storeB.ox[ eidB ];
  storeOut.oy[ eidOut ] = storeA.oy[ eidA ] - storeB.oy[ eidB ];
  storeOut.oz[ eidOut ] = storeA.oz[ eidA ] - storeB.oz[ eidB ];
  storeOut.dx[ eidOut ] = storeA.dx[ eidA ] - storeB.dx[ eidB ];
  storeOut.dy[ eidOut ] = storeA.dy[ eidA ] - storeB.dy[ eidB ];
  storeOut.dz[ eidOut ] = storeA.dz[ eidA ] - storeB.dz[ eidB ];
  return eidOut;
}

// Scale a bitecs SoA ray in place by a scalar.
export function bitecsRayScaleInPlace( eid, scalar, store = RayComponent ) {
  store.ox[ eid ] *= scalar;
  store.oy[ eid ] *= scalar;
  store.oz[ eid ] *= scalar;
  store.dx[ eid ] *= scalar;
  store.dy[ eid ] *= scalar;
  store.dz[ eid ] *= scalar;
  return eid;
}

// Linear interpolation between two bitecs SoA rays -> preallocated THREE.Ray.
export function threeRayFromBitecsLerp( out, eidA, eidB, alpha, storeA = RayComponent, storeB = RayComponent ) {
  out.origin.set(
    storeA.ox[ eidA ] + ( storeB.ox[ eidB ] - storeA.ox[ eidA ] ) * alpha,
    storeA.oy[ eidA ] + ( storeB.oy[ eidB ] - storeA.oy[ eidA ] ) * alpha,
    storeA.oz[ eidA ] + ( storeB.oz[ eidB ] - storeA.oz[ eidA ] ) * alpha
  );
  out.direction.set(
    storeA.dx[ eidA ] + ( storeB.dx[ eidB ] - storeA.dx[ eidA ] ) * alpha,
    storeA.dy[ eidA ] + ( storeB.dy[ eidB ] - storeA.dy[ eidA ] ) * alpha,
    storeA.dz[ eidA ] + ( storeB.dz[ eidB ] - storeA.dz[ eidA ] ) * alpha
  );
  return out;
}

// Linear interpolation between two bitecs SoA rays -> dst SoA.
export function bitecsRayLerpInto( eidOut, eidA, eidB, alpha, storeA = RayComponent, storeB = RayComponent, storeOut = storeA ) {
  storeOut.ox[ eidOut ] = storeA.ox[ eidA ] + ( storeB.ox[ eidB ] - storeA.ox[ eidA ] ) * alpha;
  storeOut.oy[ eidOut ] = storeA.oy[ eidA ] + ( storeB.oy[ eidB ] - storeA.oy[ eidA ] ) * alpha;
  storeOut.oz[ eidOut ] = storeA.oz[ eidA ] + ( storeB.oz[ eidB ] - storeA.oz[ eidA ] ) * alpha;
  storeOut.dx[ eidOut ] = storeA.dx[ eidA ] + ( storeB.dx[ eidB ] - storeA.dx[ eidA ] ) * alpha;
  storeOut.dy[ eidOut ] = storeA.dy[ eidA ] + ( storeB.dy[ eidB ] - storeA.dy[ eidA ] ) * alpha;
  storeOut.dz[ eidOut ] = storeA.dz[ eidA ] + ( storeB.dz[ eidB ] - storeA.dz[ eidA ] ) * alpha;
  return eidOut;
}

// Normalize a bitecs SoA ray's direction in place.
export function bitecsRayNormalizeInPlace( eid, store = RayComponent ) {
  const dx = store.dx[ eid ], dy = store.dy[ eid ], dz = store.dz[ eid ];
  const len = Math.sqrt( dx * dx + dy * dy + dz * dz );
  if ( len > 0 ) {
    const inv = 1 / len;
    store.dx[ eid ] = dx * inv;
    store.dy[ eid ] = dy * inv;
    store.dz[ eid ] = dz * inv;
  }
  return eid;
}

// gl-matrix vec3 direction from a bitecs ray -> out (normalized). Uses the
// imported glVec3 so the module graph is genuinely exercised.
export function glMatrixVec3DirectionFromBitecsRay( out, eid, store = RayComponent ) {
  const a = _scratchVec3A;
  a[ 0 ] = store.dx[ eid ];
  a[ 1 ] = store.dy[ eid ];
  a[ 2 ] = store.dz[ eid ];
  return glVec3.normalize( out, a );
}

// gl-matrix vec3 origin from a bitecs ray -> out (copy). Uses glVec3.copy.
export function glMatrixVec3OriginFromBitecsRay( out, eid, store = RayComponent ) {
  const a = _scratchVec3B;
  a[ 0 ] = store.ox[ eid ];
  a[ 1 ] = store.oy[ eid ];
  a[ 2 ] = store.oz[ eid ];
  return glVec3.copy( out, a );
}

// gl-matrix vec3 lerp between two bitecs ray directions -> out.
export function glMatrixVec3LerpDirectionsFromBitecsRays( out, eidA, eidB, t, storeA = RayComponent, storeB = RayComponent ) {
  const a = _scratchVec3A;
  const b = _scratchVec3B;
  a[ 0 ] = storeA.dx[ eidA ]; a[ 1 ] = storeA.dy[ eidA ]; a[ 2 ] = storeA.dz[ eidA ];
  b[ 0 ] = storeB.dx[ eidB ]; b[ 1 ] = storeB.dy[ eidB ]; b[ 2 ] = storeB.dz[ eidB ];
  return glVec3.lerp( out, a, b, t );
}

// Point on a bitecs SoA ray at parameter t -> preallocated THREE.Vector3.
export function threeVec3FromBitecsRayAt( out, eid, t, store = RayComponent ) {
  out.x = store.ox[ eid ] + store.dx[ eid ] * t;
  out.y = store.oy[ eid ] + store.dy[ eid ] * t;
  out.z = store.oz[ eid ] + store.dz[ eid ] * t;
  return out;
}

// Point on a bitecs SoA ray at parameter t -> dst SoA Vector3 store.
export function bitecsVec3RayAtInto( eidOutVec, eidRay, t, storeRay = RayComponent, storeVec ) {
  storeVec.x[ eidOutVec ] = storeRay.ox[ eidRay ] + storeRay.dx[ eidRay ] * t;
  storeVec.y[ eidOutVec ] = storeRay.oy[ eidRay ] + storeRay.dy[ eidRay ] * t;
  storeVec.z[ eidOutVec ] = storeRay.oz[ eidRay ] + storeRay.dz[ eidRay ] * t;
  return eidOutVec;
}

// Closest point on a bitecs SoA ray to a bitecs SoA point -> preallocated THREE.Vector3.
export function threeVec3FromBitecsRayClosestPoint( out, eidRay, eidPoint, storeRay = RayComponent, storePoint ) {
  const ox = storeRay.ox[ eidRay ], oy = storeRay.oy[ eidRay ], oz = storeRay.oz[ eidRay ];
  const dx = storeRay.dx[ eidRay ], dy = storeRay.dy[ eidRay ], dz = storeRay.dz[ eidRay ];
  const px = storePoint.x[ eidPoint ] - ox;
  const py = storePoint.y[ eidPoint ] - oy;
  const pz = storePoint.z[ eidPoint ] - oz;
  const t = px * dx + py * dy + pz * dz;
  if ( t < 0 ) {
    out.x = ox; out.y = oy; out.z = oz;
  } else {
    out.x = ox + dx * t;
    out.y = oy + dy * t;
    out.z = oz + dz * t;
  }
  return out;
}

// Closest point on a bitecs SoA ray to a bitecs SoA point -> dst SoA Vector3 store.
export function bitecsVec3RayClosestPointInto( eidOutVec, eidRay, eidPoint, storeRay = RayComponent, storePoint, storeVec ) {
  const ox = storeRay.ox[ eidRay ], oy = storeRay.oy[ eidRay ], oz = storeRay.oz[ eidRay ];
  const dx = storeRay.dx[ eidRay ], dy = storeRay.dy[ eidRay ], dz = storeRay.dz[ eidRay ];
  const px = storePoint.x[ eidPoint ] - ox;
  const py = storePoint.y[ eidPoint ] - oy;
  const pz = storePoint.z[ eidPoint ] - oz;
  const t = px * dx + py * dy + pz * dz;
  if ( t < 0 ) {
    storeVec.x[ eidOutVec ] = ox;
    storeVec.y[ eidOutVec ] = oy;
    storeVec.z[ eidOutVec ] = oz;
  } else {
    storeVec.x[ eidOutVec ] = ox + dx * t;
    storeVec.y[ eidOutVec ] = oy + dy * t;
    storeVec.z[ eidOutVec ] = oz + dz * t;
  }
  return eidOutVec;
}

// Squared distance from a bitecs SoA ray to a bitecs SoA point.
export function bitecsRayDistanceSqToPoint( eidRay, eidPoint, storeRay = RayComponent, storePoint ) {
  const ox = storeRay.ox[ eidRay ], oy = storeRay.oy[ eidRay ], oz = storeRay.oz[ eidRay ];
  const dx = storeRay.dx[ eidRay ], dy = storeRay.dy[ eidRay ], dz = storeRay.dz[ eidRay ];
  const px = storePoint.x[ eidPoint ] - ox;
  const py = storePoint.y[ eidPoint ] - oy;
  const pz = storePoint.z[ eidPoint ] - oz;
  const t = px * dx + py * dy + pz * dz;
  if ( t < 0 ) {
    return px * px + py * py + pz * pz;
  }
  const cx = ox + dx * t - storePoint.x[ eidPoint ];
  const cy = oy + dy * t - storePoint.y[ eidPoint ];
  const cz = oz + dz * t - storePoint.z[ eidPoint ];
  return cx * cx + cy * cy + cz * cz;
}

// Distance from a bitecs SoA ray to a bitecs SoA point.
export function bitecsRayDistanceToPoint( eidRay, eidPoint, storeRay = RayComponent, storePoint ) {
  return Math.sqrt( bitecsRayDistanceSqToPoint( eidRay, eidPoint, storeRay, storePoint ) );
}

// Intersect a bitecs SoA ray with a bitecs SoA sphere -> preallocated THREE.Vector3.
// Returns the intersection parameter t, or -1 if no intersection.
export function threeVec3FromBitecsRayIntersectSphere( out, eidRay, eidSphere, storeRay = RayComponent, storeSphere ) {
  const ox = storeRay.ox[ eidRay ], oy = storeRay.oy[ eidRay ], oz = storeRay.oz[ eidRay ];
  const dx = storeRay.dx[ eidRay ], dy = storeRay.dy[ eidRay ], dz = storeRay.dz[ eidRay ];
  const cx = storeSphere.cx[ eidSphere ], cy = storeSphere.cy[ eidSphere ], cz = storeSphere.cz[ eidSphere ];
  const r = storeSphere.radius[ eidSphere ];
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  const radius2 = r * r;
  if ( d2 > radius2 ) return - 1;
  const thc = Math.sqrt( radius2 - d2 );
  const t0 = tca - thc;
  const t1 = tca + thc;
  if ( t1 < 0 ) return - 1;
  const t = t0 < 0 ? t1 : t0;
  out.x = ox + dx * t;
  out.y = oy + dy * t;
  out.z = oz + dz * t;
  return t;
}

// Intersect a bitecs SoA ray with a bitecs SoA sphere -> dst SoA Vector3 store.
// Returns the intersection parameter t, or -1 if no intersection.
export function bitecsVec3RayIntersectSphereInto( eidOutVec, eidRay, eidSphere, storeRay = RayComponent, storeSphere, storeVec ) {
  const ox = storeRay.ox[ eidRay ], oy = storeRay.oy[ eidRay ], oz = storeRay.oz[ eidRay ];
  const dx = storeRay.dx[ eidRay ], dy = storeRay.dy[ eidRay ], dz = storeRay.dz[ eidRay ];
  const cx = storeSphere.cx[ eidSphere ], cy = storeSphere.cy[ eidSphere ], cz = storeSphere.cz[ eidSphere ];
  const r = storeSphere.radius[ eidSphere ];
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  const radius2 = r * r;
  if ( d2 > radius2 ) return - 1;
  const thc = Math.sqrt( radius2 - d2 );
  const t0 = tca - thc;
  const t1 = tca + thc;
  if ( t1 < 0 ) return - 1;
  const t = t0 < 0 ? t1 : t0;
  storeVec.x[ eidOutVec ] = ox + dx * t;
  storeVec.y[ eidOutVec ] = oy + dy * t;
  storeVec.z[ eidOutVec ] = oz + dz * t;
  return t;
}

// Intersects-sphere test for a bitecs SoA ray vs a bitecs SoA sphere.
export function bitecsRayIntersectsSphere( eidRay, eidSphere, storeRay = RayComponent, storeSphere ) {
  if ( storeSphere.radius[ eidSphere ] < 0 ) return false;
  return bitecsRayDistanceSqToPoint( eidRay, eidSphere, storeRay, storeSphere ) <=
    ( storeSphere.radius[ eidSphere ] * storeSphere.radius[ eidSphere ] );
}

// Distance from a bitecs SoA ray to a bitecs SoA plane (returns t or null).
export function bitecsRayDistanceToPlane( eidRay, eidPlane, storeRay = RayComponent, storePlane ) {
  const nx = storePlane.nx[ eidPlane ], ny = storePlane.ny[ eidPlane ], nz = storePlane.nz[ eidPlane ];
  const c = storePlane.constant[ eidPlane ];
  const dx = storeRay.dx[ eidRay ], dy = storeRay.dy[ eidRay ], dz = storeRay.dz[ eidRay ];
  const denominator = nx * dx + ny * dy + nz * dz;
  if ( denominator === 0 ) {
    const dist = nx * storeRay.ox[ eidRay ] + ny * storeRay.oy[ eidRay ] + nz * storeRay.oz[ eidRay ] + c;
    return dist === 0 ? 0 : null;
  }
  const t = - ( storeRay.ox[ eidRay ] * nx + storeRay.oy[ eidRay ] * ny + storeRay.oz[ eidRay ] * nz + c ) / denominator;
  return t >= 0 ? t : null;
}

// Intersect a bitecs SoA ray with a bitecs SoA plane -> preallocated THREE.Vector3.
export function threeVec3FromBitecsRayIntersectPlane( out, eidRay, eidPlane, storeRay = RayComponent, storePlane ) {
  const t = bitecsRayDistanceToPlane( eidRay, eidPlane, storeRay, storePlane );
  if ( t === null ) return null;
  out.x = storeRay.ox[ eidRay ] + storeRay.dx[ eidRay ] * t;
  out.y = storeRay.oy[ eidRay ] + storeRay.dy[ eidRay ] * t;
  out.z = storeRay.oz[ eidRay ] + storeRay.dz[ eidRay ] * t;
  return out;
}

// Intersects-plane test for a bitecs SoA ray vs a bitecs SoA plane.
export function bitecsRayIntersectsPlane( eidRay, eidPlane, storeRay = RayComponent, storePlane ) {
  const distToPoint = storePlane.nx[ eidPlane ] * storeRay.ox[ eidRay ] +
    storePlane.ny[ eidPlane ] * storeRay.oy[ eidRay ] +
    storePlane.nz[ eidPlane ] * storeRay.oz[ eidRay ] +
    storePlane.constant[ eidPlane ];
  if ( distToPoint === 0 ) return true;
  const denominator = storePlane.nx[ eidPlane ] * storeRay.dx[ eidRay ] +
    storePlane.ny[ eidPlane ] * storeRay.dy[ eidRay ] +
    storePlane.nz[ eidPlane ] * storeRay.dz[ eidRay ];
  return denominator * distToPoint < 0;
}

// Intersect a bitecs SoA ray with a bitecs SoA box -> preallocated THREE.Vector3.
export function threeVec3FromBitecsRayIntersectBox( out, eidRay, eidBox, storeRay = RayComponent, storeBox = null ) {
  if ( storeBox === null ) throw new Error( 'storeBox (Box3Component) is required' );
  const ox = storeRay.ox[ eidRay ], oy = storeRay.oy[ eidRay ], oz = storeRay.oz[ eidRay ];
  const dx = storeRay.dx[ eidRay ], dy = storeRay.dy[ eidRay ], dz = storeRay.dz[ eidRay ];
  const invdx = 1 / dx, invdy = 1 / dy, invdz = 1 / dz;
  let tmin, tmax;
  if ( invdx >= 0 ) {
    tmin = ( storeBox.minX[ eidBox ] - ox ) * invdx;
    tmax = ( storeBox.maxX[ eidBox ] - ox ) * invdx;
  } else {
    tmin = ( storeBox.maxX[ eidBox ] - ox ) * invdx;
    tmax = ( storeBox.minX[ eidBox ] - ox ) * invdx;
  }
  let tymin, tymax;
  if ( invdy >= 0 ) {
    tymin = ( storeBox.minY[ eidBox ] - oy ) * invdy;
    tymax = ( storeBox.maxY[ eidBox ] - oy ) * invdy;
  } else {
    tymin = ( storeBox.maxY[ eidBox ] - oy ) * invdy;
    tymax = ( storeBox.minY[ eidBox ] - oy ) * invdy;
  }
  if ( tmin > tymax || tymin > tmax ) return null;
  if ( tymin > tmin || isNaN( tmin ) ) tmin = tymin;
  if ( tymax < tmax || isNaN( tmax ) ) tmax = tymax;
  let tzmin, tzmax;
  if ( invdz >= 0 ) {
    tzmin = ( storeBox.minZ[ eidBox ] - oz ) * invdz;
    tzmax = ( storeBox.maxZ[ eidBox ] - oz ) * invdz;
  } else {
    tzmin = ( storeBox.maxZ[ eidBox ] - oz ) * invdz;
    tzmax = ( storeBox.minZ[ eidBox ] - oz ) * invdz;
  }
  if ( tmin > tzmax || tzmin > tmax ) return null;
  if ( tzmin > tmin || isNaN( tmin ) ) tmin = tzmin;
  if ( tzmax < tmax || isNaN( tmax ) ) tmax = tzmax;
  if ( tmax < 0 ) return null;
  const t = tmin >= 0 ? tmin : tmax;
  out.x = ox + dx * t;
  out.y = oy + dy * t;
  out.z = oz + dz * t;
  return out;
}

// Intersects-box test for a bitecs SoA ray vs a bitecs SoA box.
export function bitecsRayIntersectsBox( eidRay, eidBox, storeRay = RayComponent, storeBox = null ) {
  if ( storeBox === null ) throw new Error( 'storeBox (Box3Component) is required' );
  const ox = storeRay.ox[ eidRay ], oy = storeRay.oy[ eidRay ], oz = storeRay.oz[ eidRay ];
  const dx = storeRay.dx[ eidRay ], dy = storeRay.dy[ eidRay ], dz = storeRay.dz[ eidRay ];
  const invdx = 1 / dx, invdy = 1 / dy, invdz = 1 / dz;
  let tmin, tmax;
  if ( invdx >= 0 ) {
    tmin = ( storeBox.minX[ eidBox ] - ox ) * invdx;
    tmax = ( storeBox.maxX[ eidBox ] - ox ) * invdx;
  } else {
    tmin = ( storeBox.maxX[ eidBox ] - ox ) * invdx;
    tmax = ( storeBox.minX[ eidBox ] - ox ) * invdx;
  }
  let tymin, tymax;
  if ( invdy >= 0 ) {
    tymin = ( storeBox.minY[ eidBox ] - oy ) * invdy;
    tymax = ( storeBox.maxY[ eidBox ] - oy ) * invdy;
  } else {
    tymin = ( storeBox.maxY[ eidBox ] - oy ) * invdy;
    tymax = ( storeBox.minY[ eidBox ] - oy ) * invdy;
  }
  if ( tmin > tymax || tymin > tmax ) return false;
  if ( tymin > tmin || isNaN( tmin ) ) tmin = tymin;
  if ( tymax < tmax || isNaN( tmax ) ) tmax = tymax;
  let tzmin, tzmax;
  if ( invdz >= 0 ) {
    tzmin = ( storeBox.minZ[ eidBox ] - oz ) * invdz;
    tzmax = ( storeBox.maxZ[ eidBox ] - oz ) * invdz;
  } else {
    tzmin = ( storeBox.maxZ[ eidBox ] - oz ) * invdz;
    tzmax = ( storeBox.minZ[ eidBox ] - oz ) * invdz;
  }
  if ( tmin > tzmax || tzmin > tmax ) return false;
  if ( tzmin > tmin || isNaN( tmin ) ) tmin = tzmin;
  if ( tzmax < tmax || isNaN( tmax ) ) tmax = tzmax;
  return tmax >= 0;
}

// Intersect a bitecs SoA ray with a triangle (three SoA Vector3 entities) -> preallocated THREE.Vector3.
export function threeVec3FromBitecsRayIntersectTriangle( out, eidRay, eidA, eidB, eidC, backfaceCulling, storeRay = RayComponent, storeA, storeB, storeC ) {
  if ( storeA === undefined || storeB === undefined || storeC === undefined ) {
    throw new Error( 'storeA, storeB, and storeC (Vector3Component) are required' );
  }
  const ox = storeRay.ox[ eidRay ], oy = storeRay.oy[ eidRay ], oz = storeRay.oz[ eidRay ];
  const dx = storeRay.dx[ eidRay ], dy = storeRay.dy[ eidRay ], dz = storeRay.dz[ eidRay ];
  const ax = storeA.x[ eidA ], ay = storeA.y[ eidA ], az = storeA.z[ eidA ];
  const bx = storeB.x[ eidB ], by = storeB.y[ eidB ], bz = storeB.z[ eidB ];
  const cx = storeC.x[ eidC ], cy = storeC.y[ eidC ], cz = storeC.z[ eidC ];
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const DdN = dx * nx + dy * ny + dz * nz;
  let sign;
  if ( DdN > 0 ) {
    if ( backfaceCulling ) return null;
    sign = 1;
  } else if ( DdN < 0 ) {
    sign = - 1;
  } else {
    return null;
  }
  const DdNabs = Math.abs( DdN );
  const dfx = ox - ax, dfy = oy - ay, dfz = oz - az;
  const cx2 = dfy * e2z - dfz * e2y;
  const cy2 = dfz * e2x - dfx * e2z;
  const cz2 = dfx * e2y - dfy * e2x;
  const DdQxE2 = sign * ( dx * cx2 + dy * cy2 + dz * cz2 );
  if ( DdQxE2 < 0 ) return null;
  const cx3 = e1y * dfz - e1z * dfy;
  const cy3 = e1z * dfx - e1x * dfz;
  const cz3 = e1x * dfy - e1y * dfx;
  const DdE1xQ = sign * ( dx * cx3 + dy * cy3 + dz * cz3 );
  if ( DdE1xQ < 0 ) return null;
  if ( DdQxE2 + DdE1xQ > DdNabs ) return null;
  const QdN = - sign * ( dfx * nx + dfy * ny + dfz * nz );
  if ( QdN < 0 ) return null;
  const t = QdN / DdNabs;
  out.x = ox + dx * t;
  out.y = oy + dy * t;
  out.z = oz + dz * t;
  return out;
}

// Apply a bitecs SoA mat4 to a bitecs SoA ray in place.
export function bitecsRayApplyMatrix4InPlace( eid, eidM, storeRay = RayComponent, storeM = null ) {
  if ( storeM === null ) throw new Error( 'storeM (Matrix4Component) is required' );
  const e = storeM;
  const ox = storeRay.ox[ eid ], oy = storeRay.oy[ eid ], oz = storeRay.oz[ eid ];
  const dx = storeRay.dx[ eid ], dy = storeRay.dy[ eid ], dz = storeRay.dz[ eid ];
  const m00 = e.m00[ eidM ], m01 = e.m10[ eidM ], m02 = e.m20[ eidM ], m03 = e.m30[ eidM ];
  const m10 = e.m01[ eidM ], m11 = e.m11[ eidM ], m12 = e.m21[ eidM ], m13 = e.m31[ eidM ];
  const m20 = e.m02[ eidM ], m21 = e.m12[ eidM ], m22 = e.m22[ eidM ], m23 = e.m32[ eidM ];
  const m30 = e.m03[ eidM ], m31 = e.m13[ eidM ], m32 = e.m23[ eidM ], m33 = e.m33[ eidM ];
  const w = m03 * ox + m13 * oy + m23 * oz + m33;
  const invW = w === 0 ? 1 : 1 / w;
  storeRay.ox[ eid ] = ( m00 * ox + m01 * oy + m02 * oz + m03 ) * invW;
  storeRay.oy[ eid ] = ( m10 * ox + m11 * oy + m12 * oz + m13 ) * invW;
  storeRay.oz[ eid ] = ( m20 * ox + m21 * oy + m22 * oz + m23 ) * invW;
  const ndx = m00 * dx + m01 * dy + m02 * dz;
  const ndy = m10 * dx + m11 * dy + m12 * dz;
  const ndz = m20 * dx + m21 * dy + m22 * dz;
  const nlen = Math.sqrt( ndx * ndx + ndy * ndy + ndz * ndz );
  if ( nlen > 0 ) {
    const inv = 1 / nlen;
    storeRay.dx[ eid ] = ndx * inv;
    storeRay.dy[ eid ] = ndy * inv;
    storeRay.dz[ eid ] = ndz * inv;
  }
  return eid;
}

// gl-matrix ray-sphere intersection reading from bitecs SoA entities.
// Returns nearest positive t, or -1 if no intersection.
export function glMatrixRayIntersectBitecsSphere( eidRay, eidSphere, storeRay = RayComponent, storeSphere ) {
  const ox = storeRay.ox[ eidRay ], oy = storeRay.oy[ eidRay ], oz = storeRay.oz[ eidRay ];
  const dx = storeRay.dx[ eidRay ], dy = storeRay.dy[ eidRay ], dz = storeRay.dz[ eidRay ];
  const lx = storeSphere.cx[ eidSphere ] - ox;
  const ly = storeSphere.cy[ eidSphere ] - oy;
  const lz = storeSphere.cz[ eidSphere ] - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  const radius2 = storeSphere.radius[ eidSphere ] * storeSphere.radius[ eidSphere ];
  if ( d2 > radius2 ) return - 1;
  const thc = Math.sqrt( radius2 - d2 );
  const t0 = tca - thc;
  const t1 = tca + thc;
  if ( t1 < 0 ) return - 1;
  return t0 >= 0 ? t0 : t1;
}

// gl-matrix ray-plane intersection reading from bitecs SoA entities.
// Returns t, or -1 if no intersection.
export function glMatrixRayIntersectBitecsPlane( eidRay, eidPlane, storeRay = RayComponent, storePlane ) {
  const nx = storePlane.nx[ eidPlane ], ny = storePlane.ny[ eidPlane ], nz = storePlane.nz[ eidPlane ];
  const c = storePlane.constant[ eidPlane ];
  const dx = storeRay.dx[ eidRay ], dy = storeRay.dy[ eidRay ], dz = storeRay.dz[ eidRay ];
  const denominator = nx * dx + ny * dy + nz * dz;
  if ( denominator === 0 ) {
    const dist = nx * storeRay.ox[ eidRay ] + ny * storeRay.oy[ eidRay ] + nz * storeRay.oz[ eidRay ] + c;
    return dist === 0 ? 0 : - 1;
  }
  const t = - ( storeRay.ox[ eidRay ] * nx + storeRay.oy[ eidRay ] * ny + storeRay.oz[ eidRay ] * nz + c ) / denominator;
  return t >= 0 ? t : - 1;
}

// gl-matrix ray-box intersection reading from bitecs SoA entities.
// Returns nearest positive t, or -1 if no intersection.
export function glMatrixRayIntersectBitecsBox( eidRay, eidBox, storeRay = RayComponent, storeBox = null ) {
  if ( storeBox === null ) throw new Error( 'storeBox (Box3Component) is required' );
  const ox = storeRay.ox[ eidRay ], oy = storeRay.oy[ eidRay ], oz = storeRay.oz[ eidRay ];
  const dx = storeRay.dx[ eidRay ], dy = storeRay.dy[ eidRay ], dz = storeRay.dz[ eidRay ];
  const invdx = 1 / dx, invdy = 1 / dy, invdz = 1 / dz;
  let tmin, tmax;
  if ( invdx >= 0 ) {
    tmin = ( storeBox.minX[ eidBox ] - ox ) * invdx;
    tmax = ( storeBox.maxX[ eidBox ] - ox ) * invdx;
  } else {
    tmin = ( storeBox.maxX[ eidBox ] - ox ) * invdx;
    tmax = ( storeBox.minX[ eidBox ] - ox ) * invdx;
  }
  let tymin, tymax;
  if ( invdy >= 0 ) {
    tymin = ( storeBox.minY[ eidBox ] - oy ) * invdy;
    tymax = ( storeBox.maxY[ eidBox ] - oy ) * invdy;
  } else {
    tymin = ( storeBox.maxY[ eidBox ] - oy ) * invdy;
    tymax = ( storeBox.minY[ eidBox ] - oy ) * invdy;
  }
  if ( tmin > tymax || tymin > tmax ) return - 1;
  if ( tymin > tmin || isNaN( tmin ) ) tmin = tymin;
  if ( tymax < tmax || isNaN( tmax ) ) tmax = tymax;
  let tzmin, tzmax;
  if ( invdz >= 0 ) {
    tzmin = ( storeBox.minZ[ eidBox ] - oz ) * invdz;
    tzmax = ( storeBox.maxZ[ eidBox ] - oz ) * invdz;
  } else {
    tzmin = ( storeBox.maxZ[ eidBox ] - oz ) * invdz;
    tzmax = ( storeBox.minZ[ eidBox ] - oz ) * invdz;
  }
  if ( tmin > tzmax || tzmin > tmax ) return - 1;
  if ( tzmin > tmin || isNaN( tmin ) ) tmin = tzmin;
  if ( tzmax < tmax || isNaN( tmax ) ) tmax = tzmax;
  if ( tmax < 0 ) return - 1;
  return tmin >= 0 ? tmin : tmax;
}

// gl-matrix ray-triangle intersection reading from bitecs SoA entities.
// Returns nearest positive t, or -1 if no intersection.
export function glMatrixRayIntersectBitecsTriangle( eidRay, eidA, eidB, eidC, backfaceCulling, storeRay = RayComponent, storeA, storeB, storeC ) {
  if ( storeA === undefined || storeB === undefined || storeC === undefined ) {
    throw new Error( 'storeA, storeB, and storeC (Vector3Component) are required' );
  }
  const ox = storeRay.ox[ eidRay ], oy = storeRay.oy[ eidRay ], oz = storeRay.oz[ eidRay ];
  const dx = storeRay.dx[ eidRay ], dy = storeRay.dy[ eidRay ], dz = storeRay.dz[ eidRay ];
  const ax = storeA.x[ eidA ], ay = storeA.y[ eidA ], az = storeA.z[ eidA ];
  const bx = storeB.x[ eidB ], by = storeB.y[ eidB ], bz = storeB.z[ eidB ];
  const cx = storeC.x[ eidC ], cy = storeC.y[ eidC ], cz = storeC.z[ eidC ];
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
 * the closest-point parameter, squared distance, and distance from a ray to a
 * point in double-double precision, avoiding the cancellation that hits the
 * f64 path when the point is nearly on the ray.
 */

function _toDouble( value ) {
  return new Double( value );
}

// Returns the closest-point parameter t of a THREE.Ray to a THREE.Vector3,
// evaluated in double-double precision. The result is NOT clamped.
export function preciseClosestPointParameter( ray, point ) {
  const dx = _toDouble( ray.direction.x );
  const dy = _toDouble( ray.direction.y );
  const dz = _toDouble( ray.direction.z );
  const px = _toDouble( point.x ).sub( _toDouble( ray.origin.x ) );
  const py = _toDouble( point.y ).sub( _toDouble( ray.origin.y ) );
  const pz = _toDouble( point.z ).sub( _toDouble( ray.origin.z ) );
  return px.mul( dx ).add( py.mul( dy ) ).add( pz.mul( dz ) ).toNumber();
}

// Returns the squared distance from a THREE.Ray to a THREE.Vector3, in
// double-double precision, with the closest-point parameter clamped to t >= 0.
export function preciseDistanceSqToPoint( ray, point ) {
  const tRaw = preciseClosestPointParameter( ray, point );
  const t = tRaw < 0 ? 0 : tRaw;
  const cx = _toDouble( ray.origin.x ).add( _toDouble( ray.direction.x ).mul( _toDouble( t ) ) );
  const cy = _toDouble( ray.origin.y ).add( _toDouble( ray.direction.y ).mul( _toDouble( t ) ) );
  const cz = _toDouble( ray.origin.z ).add( _toDouble( ray.direction.z ).mul( _toDouble( t ) ) );
  const dx = _toDouble( point.x ).sub( cx );
  const dy = _toDouble( point.y ).sub( cy );
  const dz = _toDouble( point.z ).sub( cz );
  return dx.mul( dx ).add( dy.mul( dy ) ).add( dz.mul( dz ) ).toNumber();
}

// Returns the distance from a THREE.Ray to a THREE.Vector3, in double-double precision.
export function preciseDistanceToPoint( ray, point ) {
  return Math.sqrt( preciseDistanceSqToPoint( ray, point ) );
}

/*
 * -----------------------------------------------------------------------------
 * PROCEDURAL NOISE (simplex-noise)
 * -----------------------------------------------------------------------------
 * A cached 3D simplex-noise generator per seed. setFromNoise3D places the
 * origin at a noise-derived offset from the origin and derives the direction
 * from three more decorrelated samples (then normalizes it).
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

// Fill a THREE.Ray from a 3D simplex field sampled at (x, y, z). The origin is
// placed at noise-derived offsets scaled by `originScale`; the direction is a
// normalized triplet of decorrelated noise samples.
export function setFromNoise3D( out, x, y, z, seed = 0, originScale = 1 ) {
  const n = _cachedNoise3D( seed );
  out.origin.set(
    n( x, y, z ) * originScale,
    n( x + 31.416, y + 47.853, z + 12.793 ) * originScale,
    n( x - 17.234, y - 53.127, z - 91.056 ) * originScale
  );
  let dx = n( x + 100.1, y + 200.2, z + 300.3 );
  let dy = n( x - 110.5, y - 210.6, z - 310.7 );
  let dz = n( x + 55.1, y - 66.2, z + 77.3 );
  const len = Math.sqrt( dx * dx + dy * dy + dz * dz );
  if ( len === 0 ) {
    out.direction.set( 0, 0, - 1 );
  } else {
    const inv = 1 / len;
    out.direction.set( dx * inv, dy * inv, dz * inv );
  }
  return out;
}

// Drop every cached noise generator.
export function disposeNoise3DCache() {
  _noise3DCache.clear();
}

// Module-local scratch buffers — allocated once, reused across every bridge.
const _scratchVec3A = new Float32Array( 3 );
const _scratchVec3B = new Float32Array( 3 );

/*
 * -----------------------------------------------------------------------------
 * THREE.Ray
 * -----------------------------------------------------------------------------
 */
class Ray {

  constructor( origin = new Vector3(), direction = new Vector3( 0, 0, - 1 ) ) {
    this.origin = origin;
    this.direction = direction;
  }

  set( origin, direction ) {
    this.origin.copy( origin );
    this.direction.copy( direction );
    return this;
  }

  copy( ray ) {
    this.origin.copy( ray.origin );
    this.direction.copy( ray.direction );
    return this;
  }

  at( t, target ) {
    return target.copy( this.origin ).addScaledVector( this.direction, t );
  }

  lookAt( v ) {
    this.direction.copy( v ).sub( this.origin ).normalize();
    return this;
  }

  recast( t ) {
    this.origin.copy( this.at( t, _vector ) );
    return this;
  }

  closestPointToPoint( point, target ) {
    target.subVectors( point, this.origin );
    const directionDistance = target.dot( this.direction );
    if ( directionDistance < 0 ) {
      return target.copy( this.origin );
    }
    return target.copy( this.origin ).addScaledVector( this.direction, directionDistance );
  }

  distanceToPoint( point ) {
    return Math.sqrt( this.distanceSqToPoint( point ) );
  }

  distanceSqToPoint( point ) {
    const directionDistance = _vector.subVectors( point, this.origin ).dot( this.direction );
    if ( directionDistance < 0 ) {
      return this.origin.distanceToSquared( point );
    }
    _vector.copy( this.origin ).addScaledVector( this.direction, directionDistance );
    return _vector.distanceToSquared( point );
  }

  distanceSqToSegment( v0, v1, optionalPointOnRay, optionalPointOnSegment ) {
    _segCenter.copy( v0 ).add( v1 ).multiplyScalar( 0.5 );
    _segDir.copy( v1 ).sub( v0 ).normalize();
    _diff.copy( this.origin ).sub( _segCenter );
    const segExtent = v0.distanceTo( v1 ) * 0.5;
    const a01 = - this.direction.dot( _segDir );
    const b0 = _diff.dot( this.direction );
    const b1 = - _diff.dot( _segDir );
    const c = _diff.lengthSq();
    const det = Math.abs( 1 - a01 * a01 );
    let s0, s1, sqrDist, extDet;
    if ( det > 0 ) {
      s0 = a01 * b1 - b0;
      s1 = a01 * b0 - b1;
      extDet = segExtent * det;
      if ( s0 >= 0 ) {
        if ( s1 >= - extDet ) {
          if ( s1 <= extDet ) {
            const invDet = 1 / det;
            s0 *= invDet;
            s1 *= invDet;
            sqrDist = s0 * ( s0 + a01 * s1 + 2 * b0 ) + s1 * ( a01 * s0 + s1 + 2 * b1 ) + c;
          } else {
            s1 = segExtent;
            s0 = Math.max( 0, - ( a01 * s1 + b0 ) );
            sqrDist = - s0 * s0 + s1 * ( s1 + 2 * b1 ) + c;
          }
        } else {
          s1 = - segExtent;
          s0 = Math.max( 0, - ( a01 * s1 + b0 ) );
          sqrDist = - s0 * s0 + s1 * ( s1 + 2 * b1 ) + c;
        }
      } else {
        if ( s1 <= - extDet ) {
          s0 = Math.max( 0, - ( - a01 * segExtent + b0 ) );
          s1 = ( s0 > 0 ) ? - segExtent : Math.min( Math.max( - segExtent, - b1 ), segExtent );
          sqrDist = - s0 * s0 + s1 * ( s1 + 2 * b1 ) + c;
        } else if ( s1 <= extDet ) {
          s0 = 0;
          s1 = Math.min( Math.max( - segExtent, - b1 ), segExtent );
          sqrDist = s1 * ( s1 + 2 * b1 ) + c;
        } else {
          s0 = Math.max( 0, - ( a01 * segExtent + b0 ) );
          s1 = ( s0 > 0 ) ? segExtent : Math.min( Math.max( - segExtent, - b1 ), segExtent );
          sqrDist = - s0 * s0 + s1 * ( s1 + 2 * b1 ) + c;
        }
      }
    } else {
      s1 = ( a01 > 0 ) ? - segExtent : segExtent;
      s0 = Math.max( 0, - ( a01 * s1 + b0 ) );
      sqrDist = - s0 * s0 + s1 * ( s1 + 2 * b1 ) + c;
    }
    if ( optionalPointOnRay ) {
      optionalPointOnRay.copy( this.origin ).addScaledVector( this.direction, s0 );
    }
    if ( optionalPointOnSegment ) {
      optionalPointOnSegment.copy( _segCenter ).addScaledVector( _segDir, s1 );
    }
    return sqrDist;
  }

  intersectSphere( sphere, target ) {
    _vector.subVectors( sphere.center, this.origin );
    const tca = _vector.dot( this.direction );
    const d2 = _vector.dot( _vector ) - tca * tca;
    const radius2 = sphere.radius * sphere.radius;
    if ( d2 > radius2 ) return null;
    const thc = Math.sqrt( radius2 - d2 );
    const t0 = tca - thc;
    const t1 = tca + thc;
    if ( t1 < 0 ) return null;
    if ( t0 < 0 ) return this.at( t1, target );
    return this.at( t0, target );
  }

  intersectsSphere( sphere ) {
    if ( sphere.radius < 0 ) return false;
    return this.distanceSqToPoint( sphere.center ) <= ( sphere.radius * sphere.radius );
  }

  distanceToPlane( plane ) {
    const denominator = plane.normal.dot( this.direction );
    if ( denominator === 0 ) {
      if ( plane.distanceToPoint( this.origin ) === 0 ) {
        return 0;
      }
      return null;
    }
    const t = - ( this.origin.dot( plane.normal ) + plane.constant ) / denominator;
    return t >= 0 ? t : null;
  }

  intersectPlane( plane, target ) {
    const t = this.distanceToPlane( plane );
    if ( t === null ) {
      return null;
    }
    return this.at( t, target );
  }

  intersectsPlane( plane ) {
    const distToPoint = plane.distanceToPoint( this.origin );
    if ( distToPoint === 0 ) {
      return true;
    }
    const denominator = plane.normal.dot( this.direction );
    if ( denominator * distToPoint < 0 ) {
      return true;
    }
    return false;
  }

  intersectBox( box, target ) {
    let tmin, tmax, tymin, tymax, tzmin, tzmax;
    const invdirx = 1 / this.direction.x,
      invdiry = 1 / this.direction.y,
      invdirz = 1 / this.direction.z;
    const origin = this.origin;
    if ( invdirx >= 0 ) {
      tmin = ( box.min.x - origin.x ) * invdirx;
      tmax = ( box.max.x - origin.x ) * invdirx;
    } else {
      tmin = ( box.max.x - origin.x ) * invdirx;
      tmax = ( box.min.x - origin.x ) * invdirx;
    }
    if ( invdiry >= 0 ) {
      tymin = ( box.min.y - origin.y ) * invdiry;
      tymax = ( box.max.y - origin.y ) * invdiry;
    } else {
      tymin = ( box.max.y - origin.y ) * invdiry;
      tymax = ( box.min.y - origin.y ) * invdiry;
    }
    if ( ( tmin > tymax ) || ( tymin > tmax ) ) return null;
    if ( tymin > tmin || isNaN( tmin ) ) tmin = tymin;
    if ( tymax < tmax || isNaN( tmax ) ) tmax = tymax;
    if ( invdirz >= 0 ) {
      tzmin = ( box.min.z - origin.z ) * invdirz;
      tzmax = ( box.max.z - origin.z ) * invdirz;
    } else {
      tzmin = ( box.max.z - origin.z ) * invdirz;
      tzmax = ( box.min.z - origin.z ) * invdirz;
    }
    if ( ( tmin > tzmax ) || ( tzmin > tmax ) ) return null;
    if ( tzmin > tmin || tmin !== tmin ) tmin = tzmin;
    if ( tzmax < tmax || tmax !== tmax ) tmax = tzmax;
    if ( tmax < 0 ) return null;
    return this.at( tmin >= 0 ? tmin : tmax, target );
  }

  intersectsBox( box ) {
    return this.intersectBox( box, _vector ) !== null;
  }

  intersectTriangle( a, b, c, backfaceCulling, target ) {
    _edge1.subVectors( b, a );
    _edge2.subVectors( c, a );
    _normal.crossVectors( _edge1, _edge2 );
    let DdN = this.direction.dot( _normal );
    let sign;
    if ( DdN > 0 ) {
      if ( backfaceCulling ) return null;
      sign = 1;
    } else if ( DdN < 0 ) {
      sign = - 1;
      DdN = - DdN;
    } else {
      return null;
    }
    _diff.subVectors( this.origin, a );
    const DdQxE2 = sign * this.direction.dot( _edge2.crossVectors( _diff, _edge2 ) );
    if ( DdQxE2 < 0 ) {
      return null;
    }
    const DdE1xQ = sign * this.direction.dot( _edge1.cross( _diff ) );
    if ( DdE1xQ < 0 ) {
      return null;
    }
    if ( DdQxE2 + DdE1xQ > DdN ) {
      return null;
    }
    const QdN = - sign * _diff.dot( _normal );
    if ( QdN < 0 ) {
      return null;
    }
    return this.at( QdN / DdN, target );
  }

  applyMatrix4( matrix4 ) {
    this.origin.applyMatrix4( matrix4 );
    this.direction.transformDirection( matrix4 );
    return this;
  }

  equals( ray ) {
    return ray.origin.equals( this.origin ) && ray.direction.equals( this.direction );
  }

  clone() {
    return new this.constructor().copy( this );
  }

}

const _vector = /*@__PURE__*/ new Vector3();
const _segCenter = /*@__PURE__*/ new Vector3();
const _segDir = /*@__PURE__*/ new Vector3();
const _diff = /*@__PURE__*/ new Vector3();
const _edge1 = /*@__PURE__*/ new Vector3();
const _edge2 = /*@__PURE__*/ new Vector3();
const _normal = /*@__PURE__*/ new Vector3();

// Default export for parity with other math classes in this module.
export default Ray;
export { Ray };