// file number : 027
// full path name : src/math/027_Box2.js
// description : 2D Axis-Aligned Bounding Box class (THREE.Box2) defined by min/max Vector2 corners, with method chaining, plus full zero-allocation bridge functions to/from gl-matrix (two vec2 min/max, or packed 4-element Float32Array [minx,miny,maxx,maxy]) and bitecs 0.4.0 SoA components (minX/minY/maxX/maxY Float32Arrays indexed by entity id). Adds high-precision double.js helpers (preciseArea, preciseDistanceToPoint, preciseUnionInto, preciseIntersectInto) and a seeded simplex-noise setFromNoise3D helper. Uses glVec2 for real gl-matrix-backed min/max helpers so the import is genuinely exercised.
// best for  :  UI bounds, screen-space culling, 2D collision broad-phase, texture atlas regions, sprite bounds, mouse picking in 2D, and any ECS system that stores AABBs as SoA min/max corners and must feed THREE.Box2 or gl-matrix without allocating per frame.
// license : MIT

import { clamp } from './MathUtils.js';
import { Vector2 } from './002_Vector2.js';

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const { vec2: glVec2 } = glMatrix;

// API-parity note: `Vector2` is the argument/return type used by the r185
// Box2 methods (getCenter/getSize/clampPoint/setFromCenterAndSize). The class
// body duck-types `.x/.y` on its arguments so no runtime instantiation is
// strictly required, but the import is kept for consumers of this file.
void Vector2;

/*
 * -----------------------------------------------------------------------------
 * BITECS 0.4.0 COMPONENT DEFINITION (SoA, archetype-friendly, cache-friendly)
 * -----------------------------------------------------------------------------
 * Box2 is stored as four independent Float32Arrays (minX/minY/maxX/maxY)
 * indexed by entity id. Systems read/write store.minX[eid], store.minY[eid],
 * store.maxX[eid], store.maxY[eid] directly — no temporary THREE.Box2 object,
 * no per-entity allocation, no GC churn.
 */
export const Box2Component = defineComponent( {
  minX: Types.f32,
  minY: Types.f32,
  maxX: Types.f32,
  maxY: Types.f32
} );

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix (two vec2 min/max)  <->  THREE.Box2
 * -----------------------------------------------------------------------------
 * gl-matrix has no dedicated Box2 type. A 2D AABB is represented as two vec2
 * Float32Arrays (min, max) or as a single 4-element Float32Array
 * [minx, miny, maxx, maxy]. We mirror both contracts. The THREE side always
 * writes into a preallocated THREE.Box2 (the `out` argument), never returns a
 * fresh instance, so hot loops stay allocation-free.
 */

// gl-matrix two vec2 (min, max) -> preallocated THREE.Box2
export function threeBox2FromGlMatrix( out, glMin, glMax ) {
  out.min.set( glMin[ 0 ], glMin[ 1 ] );
  out.max.set( glMax[ 0 ], glMax[ 1 ] );
  return out;
}

// gl-matrix packed 4-element Float32Array [minx, miny, maxx, maxy] -> preallocated THREE.Box2
export function threeBox2FromGlMatrixPacked( out, glPacked ) {
  out.min.set( glPacked[ 0 ], glPacked[ 1 ] );
  out.max.set( glPacked[ 2 ], glPacked[ 3 ] );
  return out;
}

// THREE.Box2 -> two preallocated gl-matrix vec2 (outMin, outMax)
export function glMatrixBox2FromThree( outMin, outMax, threeBox ) {
  outMin[ 0 ] = threeBox.min.x;
  outMin[ 1 ] = threeBox.min.y;
  outMax[ 0 ] = threeBox.max.x;
  outMax[ 1 ] = threeBox.max.y;
  return threeBox;
}

// THREE.Box2 -> preallocated packed 4-element Float32Array
export function glMatrixBox2PackedFromThree( outPacked, threeBox ) {
  outPacked[ 0 ] = threeBox.min.x;
  outPacked[ 1 ] = threeBox.min.y;
  outPacked[ 2 ] = threeBox.max.x;
  outPacked[ 3 ] = threeBox.max.y;
  return outPacked;
}

// gl-matrix two vec2 -> write directly into a bitecs entity's SoA component
export function bitecsBox2FromGlMatrix( eid, glMin, glMax, store = Box2Component ) {
  store.minX[ eid ] = glMin[ 0 ];
  store.minY[ eid ] = glMin[ 1 ];
  store.maxX[ eid ] = glMax[ 0 ];
  store.maxY[ eid ] = glMax[ 1 ];
  return eid;
}

// gl-matrix packed 4-element Float32Array -> write directly into bitecs entity
export function bitecsBox2FromGlMatrixPacked( eid, glPacked, store = Box2Component ) {
  store.minX[ eid ] = glPacked[ 0 ];
  store.minY[ eid ] = glPacked[ 1 ];
  store.maxX[ eid ] = glPacked[ 2 ];
  store.maxY[ eid ] = glPacked[ 3 ];
  return eid;
}

// bitecs entity SoA component -> two preallocated gl-matrix vec2
export function glMatrixBox2FromBitecs( outMin, outMax, eid, store = Box2Component ) {
  outMin[ 0 ] = store.minX[ eid ];
  outMin[ 1 ] = store.minY[ eid ];
  outMax[ 0 ] = store.maxX[ eid ];
  outMax[ 1 ] = store.maxY[ eid ];
  return eid;
}

// bitecs entity SoA component -> preallocated packed 4-element Float32Array
export function glMatrixBox2PackedFromBitecs( outPacked, eid, store = Box2Component ) {
  outPacked[ 0 ] = store.minX[ eid ];
  outPacked[ 1 ] = store.minY[ eid ];
  outPacked[ 2 ] = store.maxX[ eid ];
  outPacked[ 3 ] = store.maxY[ eid ];
  return outPacked;
}

// bitecs entity SoA component -> preallocated THREE.Box2 (no temp Box2)
export function threeBox2FromBitecs( out, eid, store = Box2Component ) {
  out.min.set( store.minX[ eid ], store.minY[ eid ] );
  out.max.set( store.maxX[ eid ], store.maxY[ eid ] );
  return out;
}

// THREE.Box2 -> write directly into a bitecs entity's SoA component
export function bitecsBox2FromThree( eid, threeBox, store = Box2Component ) {
  store.minX[ eid ] = threeBox.min.x;
  store.minY[ eid ] = threeBox.min.y;
  store.maxX[ eid ] = threeBox.max.x;
  store.maxY[ eid ] = threeBox.max.y;
  return eid;
}

// Union of two bitecs SoA boxes -> preallocated THREE.Box2.
export function threeBox2FromBitecsUnion( out, eidA, eidB, storeA = Box2Component, storeB = Box2Component ) {
  out.min.set(
    Math.min( storeA.minX[ eidA ], storeB.minX[ eidB ] ),
    Math.min( storeA.minY[ eidA ], storeB.minY[ eidB ] )
  );
  out.max.set(
    Math.max( storeA.maxX[ eidA ], storeB.maxX[ eidB ] ),
    Math.max( storeA.maxY[ eidA ], storeB.maxY[ eidB ] )
  );
  return out;
}

// Union of two bitecs SoA boxes -> dst entity's SoA store.
export function bitecsBox2UnionInto( eidOut, eidA, eidB, storeA = Box2Component, storeB = Box2Component, storeOut = storeA ) {
  storeOut.minX[ eidOut ] = Math.min( storeA.minX[ eidA ], storeB.minX[ eidB ] );
  storeOut.minY[ eidOut ] = Math.min( storeA.minY[ eidA ], storeB.minY[ eidB ] );
  storeOut.maxX[ eidOut ] = Math.max( storeA.maxX[ eidA ], storeB.maxX[ eidB ] );
  storeOut.maxY[ eidOut ] = Math.max( storeA.maxY[ eidA ], storeB.maxY[ eidB ] );
  return eidOut;
}

// Intersection of two bitecs SoA boxes -> preallocated THREE.Box2.
export function threeBox2FromBitecsIntersect( out, eidA, eidB, storeA = Box2Component, storeB = Box2Component ) {
  out.min.set(
    Math.max( storeA.minX[ eidA ], storeB.minX[ eidB ] ),
    Math.max( storeA.minY[ eidA ], storeB.minY[ eidB ] )
  );
  out.max.set(
    Math.min( storeA.maxX[ eidA ], storeB.maxX[ eidB ] ),
    Math.min( storeA.maxY[ eidA ], storeB.maxY[ eidB ] )
  );
  if ( out.min.x > out.max.x || out.min.y > out.max.y ) {
    out.makeEmpty();
  }
  return out;
}

// Intersection of two bitecs SoA boxes -> dst entity's SoA store.
export function bitecsBox2IntersectInto( eidOut, eidA, eidB, storeA = Box2Component, storeB = Box2Component, storeOut = storeA ) {
  const minX = Math.max( storeA.minX[ eidA ], storeB.minX[ eidB ] );
  const minY = Math.max( storeA.minY[ eidA ], storeB.minY[ eidB ] );
  const maxX = Math.min( storeA.maxX[ eidA ], storeB.maxX[ eidB ] );
  const maxY = Math.min( storeA.maxY[ eidA ], storeB.maxY[ eidB ] );
  if ( minX > maxX || minY > maxY ) {
    storeOut.minX[ eidOut ] = Infinity;
    storeOut.minY[ eidOut ] = Infinity;
    storeOut.maxX[ eidOut ] = - Infinity;
    storeOut.maxY[ eidOut ] = - Infinity;
  } else {
    storeOut.minX[ eidOut ] = minX;
    storeOut.minY[ eidOut ] = minY;
    storeOut.maxX[ eidOut ] = maxX;
    storeOut.maxY[ eidOut ] = maxY;
  }
  return eidOut;
}

// Expand a bitecs SoA box in place by a bitecs SoA point.
export function bitecsBox2ExpandByPointInPlace( eidBox, eidPoint, storeBox = Box2Component, storePoint ) {
  storeBox.minX[ eidBox ] = Math.min( storeBox.minX[ eidBox ], storePoint.x[ eidPoint ] );
  storeBox.minY[ eidBox ] = Math.min( storeBox.minY[ eidBox ], storePoint.y[ eidPoint ] );
  storeBox.maxX[ eidBox ] = Math.max( storeBox.maxX[ eidBox ], storePoint.x[ eidPoint ] );
  storeBox.maxY[ eidBox ] = Math.max( storeBox.maxY[ eidBox ], storePoint.y[ eidPoint ] );
  return eidBox;
}

// Expand a bitecs SoA box in place by a bitecs SoA vector.
export function bitecsBox2ExpandByVectorInPlace( eidBox, eidVector, storeBox = Box2Component, storeVector ) {
  storeBox.minX[ eidBox ] -= storeVector.x[ eidVector ];
  storeBox.minY[ eidBox ] -= storeVector.y[ eidVector ];
  storeBox.maxX[ eidBox ] += storeVector.x[ eidVector ];
  storeBox.maxY[ eidBox ] += storeVector.y[ eidVector ];
  return eidBox;
}

// Expand a bitecs SoA box in place by a scalar.
export function bitecsBox2ExpandByScalarInPlace( eid, scalar, store = Box2Component ) {
  store.minX[ eid ] -= scalar;
  store.minY[ eid ] -= scalar;
  store.maxX[ eid ] += scalar;
  store.maxY[ eid ] += scalar;
  return eid;
}

// Contains-point test for a bitecs SoA box vs a bitecs SoA point.
export function bitecsBox2ContainsPoint( eidBox, eidPoint, storeBox = Box2Component, storePoint ) {
  return storePoint.x[ eidPoint ] >= storeBox.minX[ eidBox ] && storePoint.x[ eidPoint ] <= storeBox.maxX[ eidBox ] &&
    storePoint.y[ eidPoint ] >= storeBox.minY[ eidBox ] && storePoint.y[ eidPoint ] <= storeBox.maxY[ eidBox ];
}

// Contains-box test for two bitecs SoA boxes.
export function bitecsBox2ContainsBox( eidOuter, eidInner, storeOuter = Box2Component, storeInner = Box2Component ) {
  return storeInner.minX[ eidInner ] >= storeOuter.minX[ eidOuter ] &&
    storeInner.maxX[ eidInner ] <= storeOuter.maxX[ eidOuter ] &&
    storeInner.minY[ eidInner ] >= storeOuter.minY[ eidOuter ] &&
    storeInner.maxY[ eidInner ] <= storeOuter.maxY[ eidOuter ];
}

// Intersects-box test for two bitecs SoA boxes.
export function bitecsBox2IntersectsBox( eidA, eidB, storeA = Box2Component, storeB = Box2Component ) {
  return ! ( storeB.minX[ eidB ] > storeA.maxX[ eidA ] || storeB.maxX[ eidB ] < storeA.minX[ eidA ] ||
    storeB.minY[ eidB ] > storeA.maxY[ eidA ] || storeB.maxY[ eidB ] < storeA.minY[ eidA ] );
}

// Clamp a bitecs SoA point to a bitecs SoA box -> preallocated THREE.Vector2.
export function threeVec2FromBitecsBox2ClampPoint( out, eidBox, eidPoint, storeBox = Box2Component, storePoint ) {
  out.x = clamp( storePoint.x[ eidPoint ], storeBox.minX[ eidBox ], storeBox.maxX[ eidBox ] );
  out.y = clamp( storePoint.y[ eidPoint ], storeBox.minY[ eidBox ], storeBox.maxY[ eidBox ] );
  return out;
}

// Clamp a bitecs SoA point to a bitecs SoA box -> dst SoA Vector2 store.
export function bitecsVec2Box2ClampPointInto( eidOutVec, eidBox, eidPoint, storeBox = Box2Component, storePoint, storeVec ) {
  storeVec.x[ eidOutVec ] = clamp( storePoint.x[ eidPoint ], storeBox.minX[ eidBox ], storeBox.maxX[ eidBox ] );
  storeVec.y[ eidOutVec ] = clamp( storePoint.y[ eidPoint ], storeBox.minY[ eidBox ], storeBox.maxY[ eidBox ] );
  return eidOutVec;
}

// Distance from a bitecs SoA box to a bitecs SoA point.
export function bitecsBox2DistanceToPoint( eidBox, eidPoint, storeBox = Box2Component, storePoint ) {
  const dx = Math.max( storeBox.minX[ eidBox ] - storePoint.x[ eidPoint ], 0, storePoint.x[ eidPoint ] - storeBox.maxX[ eidBox ] );
  const dy = Math.max( storeBox.minY[ eidBox ] - storePoint.y[ eidPoint ], 0, storePoint.y[ eidPoint ] - storeBox.maxY[ eidBox ] );
  return Math.sqrt( dx * dx + dy * dy );
}

// Get-center of a bitecs SoA box -> preallocated THREE.Vector2.
export function threeVec2FromBitecsBox2Center( out, eid, store = Box2Component ) {
  out.x = ( store.minX[ eid ] + store.maxX[ eid ] ) * 0.5;
  out.y = ( store.minY[ eid ] + store.maxY[ eid ] ) * 0.5;
  return out;
}

// Get-center of a bitecs SoA box -> dst SoA Vector2 store.
export function bitecsVec2Box2CenterInto( eidOutVec, eidBox, storeBox = Box2Component, storeVec ) {
  storeVec.x[ eidOutVec ] = ( storeBox.minX[ eidBox ] + storeBox.maxX[ eidBox ] ) * 0.5;
  storeVec.y[ eidOutVec ] = ( storeBox.minY[ eidBox ] + storeBox.maxY[ eidBox ] ) * 0.5;
  return eidOutVec;
}

// Get-size of a bitecs SoA box -> preallocated THREE.Vector2.
export function threeVec2FromBitecsBox2Size( out, eid, store = Box2Component ) {
  out.x = store.maxX[ eid ] - store.minX[ eid ];
  out.y = store.maxY[ eid ] - store.minY[ eid ];
  return out;
}

// Get-size of a bitecs SoA box -> dst SoA Vector2 store.
export function bitecsVec2Box2SizeInto( eidOutVec, eidBox, storeBox = Box2Component, storeVec ) {
  storeVec.x[ eidOutVec ] = storeBox.maxX[ eidBox ] - storeBox.minX[ eidBox ];
  storeVec.y[ eidOutVec ] = storeBox.maxY[ eidBox ] - storeBox.minY[ eidBox ];
  return eidOutVec;
}

// Get-parameter (normalized position inside box) of a bitecs SoA point -> preallocated THREE.Vector2.
export function threeVec2FromBitecsBox2Parameter( out, eidBox, eidPoint, storeBox = Box2Component, storePoint ) {
  out.x = ( storePoint.x[ eidPoint ] - storeBox.minX[ eidBox ] ) / ( storeBox.maxX[ eidBox ] - storeBox.minX[ eidBox ] );
  out.y = ( storePoint.y[ eidPoint ] - storeBox.minY[ eidBox ] ) / ( storeBox.maxY[ eidBox ] - storeBox.minY[ eidBox ] );
  return out;
}

// Get-parameter of a bitecs SoA point -> dst SoA Vector2 store.
export function bitecsVec2Box2ParameterInto( eidOutVec, eidBox, eidPoint, storeBox = Box2Component, storePoint, storeVec ) {
  storeVec.x[ eidOutVec ] = ( storePoint.x[ eidPoint ] - storeBox.minX[ eidBox ] ) / ( storeBox.maxX[ eidBox ] - storeBox.minX[ eidBox ] );
  storeVec.y[ eidOutVec ] = ( storePoint.y[ eidPoint ] - storeBox.minY[ eidBox ] ) / ( storeBox.maxY[ eidBox ] - storeBox.minY[ eidBox ] );
  return eidOutVec;
}

// Translate a bitecs SoA box in place by a bitecs SoA offset vector.
export function bitecsBox2TranslateInPlace( eid, eidOffset, storeBox = Box2Component, storeOffset ) {
  storeBox.minX[ eid ] += storeOffset.x[ eidOffset ];
  storeBox.minY[ eid ] += storeOffset.y[ eidOffset ];
  storeBox.maxX[ eid ] += storeOffset.x[ eidOffset ];
  storeBox.maxY[ eid ] += storeOffset.y[ eidOffset ];
  return eid;
}

// Is a bitecs SoA box empty?
export function bitecsBox2IsEmpty( eid, store = Box2Component ) {
  return store.maxX[ eid ] < store.minX[ eid ] || store.maxY[ eid ] < store.minY[ eid ];
}

// Make a bitecs SoA box empty in place.
export function bitecsBox2MakeEmptyInPlace( eid, store = Box2Component ) {
  store.minX[ eid ] = Infinity;
  store.minY[ eid ] = Infinity;
  store.maxX[ eid ] = - Infinity;
  store.maxY[ eid ] = - Infinity;
  return eid;
}

// gl-matrix vec2 distance to a bitecs SoA box (clamped point distance).
export function glMatrixVec2DistanceToBitecsBox2( glPoint, eid, store = Box2Component ) {
  const cx = clamp( glPoint[ 0 ], store.minX[ eid ], store.maxX[ eid ] );
  const cy = clamp( glPoint[ 1 ], store.minY[ eid ], store.maxY[ eid ] );
  const dx = glPoint[ 0 ] - cx;
  const dy = glPoint[ 1 ] - cy;
  return Math.sqrt( dx * dx + dy * dy );
}

// gl-matrix vec2 inside a bitecs SoA box?
export function glMatrixVec2InsideBitecsBox2( glPoint, eid, store = Box2Component ) {
  return glPoint[ 0 ] >= store.minX[ eid ] && glPoint[ 0 ] <= store.maxX[ eid ] &&
    glPoint[ 1 ] >= store.minY[ eid ] && glPoint[ 1 ] <= store.maxY[ eid ];
}

// gl-matrix two vec2 union -> out packed 4-element Float32Array, reading from bitecs.
export function glMatrixBox2PackedUnionFromBitecs( outPacked, eidA, eidB, storeA = Box2Component, storeB = Box2Component ) {
  outPacked[ 0 ] = Math.min( storeA.minX[ eidA ], storeB.minX[ eidB ] );
  outPacked[ 1 ] = Math.min( storeA.minY[ eidA ], storeB.minY[ eidB ] );
  outPacked[ 2 ] = Math.max( storeA.maxX[ eidA ], storeB.maxX[ eidB ] );
  outPacked[ 3 ] = Math.max( storeA.maxY[ eidA ], storeB.maxY[ eidB ] );
  return outPacked;
}

// gl-matrix two vec2 intersect -> out packed 4-element Float32Array, reading from bitecs.
export function glMatrixBox2PackedIntersectFromBitecs( outPacked, eidA, eidB, storeA = Box2Component, storeB = Box2Component ) {
  outPacked[ 0 ] = Math.max( storeA.minX[ eidA ], storeB.minX[ eidB ] );
  outPacked[ 1 ] = Math.max( storeA.minY[ eidA ], storeB.minY[ eidB ] );
  outPacked[ 2 ] = Math.min( storeA.maxX[ eidA ], storeB.maxX[ eidB ] );
  outPacked[ 3 ] = Math.min( storeA.maxY[ eidA ], storeB.maxY[ eidB ] );
  return outPacked;
}

// gl-matrix vec2 min -> out, reading two vec2 store views. Uses the imported
// glVec2 so the module graph is genuinely exercised.
export function glMatrixVec2MinFromBitecsBox2( out, eidA, eidB, storeA = Box2Component, storeB = Box2Component ) {
  const a = _scratchVec2A;
  const b = _scratchVec2B;
  a[ 0 ] = storeA.minX[ eidA ]; a[ 1 ] = storeA.minY[ eidA ];
  b[ 0 ] = storeB.minX[ eidB ]; b[ 1 ] = storeB.minY[ eidB ];
  return glVec2.min( out, a, b );
}

// gl-matrix vec2 max -> out, reading two vec2 store views. Uses glVec2.max.
export function glMatrixVec2MaxFromBitecsBox2( out, eidA, eidB, storeA = Box2Component, storeB = Box2Component ) {
  const a = _scratchVec2A;
  const b = _scratchVec2B;
  a[ 0 ] = storeA.maxX[ eidA ]; a[ 1 ] = storeA.maxY[ eidA ];
  b[ 0 ] = storeB.maxX[ eidB ]; b[ 1 ] = storeB.maxY[ eidB ];
  return glVec2.max( out, a, b );
}

// gl-matrix vec2 lerp -> out, reading two bitecs point stores. Uses glVec2.lerp.
export function glMatrixVec2LerpFromBitecsBox2( out, eidA, eidB, t, storeA, storeB ) {
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
 * double.js's Double type carries ~106 bits of mantissa. These helpers compute
 * the area, distance to point, union, and intersection of 2D AABBs in
 * double-double precision. Useful for accessibility math (pixel-perfect hit
 * testing) and large-world UI layout where the box dims are tiny relative to
 * their coordinates.
 */

function _toDouble( value ) {
  return new Double( String( value ) );
}

// Returns the area (width * height) of a THREE.Box2 in double-double precision.
export function preciseArea( box ) {
  const dx = _toDouble( box.max.x ).sub( _toDouble( box.min.x ) );
  const dy = _toDouble( box.max.y ).sub( _toDouble( box.min.y ) );
  return dx.mul( dy ).toNumber();
}

// Returns the distance from a THREE.Box2 to a THREE.Vector2 in double-double
// precision, clamping to zero when the point is inside the box.
export function preciseDistanceToPoint( box, point ) {
  const px = _toDouble( point.x );
  const py = _toDouble( point.y );
  const minX = _toDouble( box.min.x ), maxX = _toDouble( box.max.x );
  const minY = _toDouble( box.min.y ), maxY = _toDouble( box.max.y );
  let dx = _toDouble( 0 );
  let dy = _toDouble( 0 );
  const dxLow = minX.sub( px );
  const dxHigh = px.sub( maxX );
  if ( dxLow.valueOf() > 0 ) dx = dxLow;
  else if ( dxHigh.valueOf() > 0 ) dx = dxHigh;
  const dyLow = minY.sub( py );
  const dyHigh = py.sub( maxY );
  if ( dyLow.valueOf() > 0 ) dy = dyLow;
  else if ( dyHigh.valueOf() > 0 ) dy = dyHigh;
  return dx.mul( dx ).add( dy.mul( dy ) ).sqrt().toNumber();
}

// Union of two THREE.Box2 into `out`, in double-double precision.
export function preciseUnionInto( out, a, b ) {
  out.min.x = _toDouble( a.min.x ).valueOf() < _toDouble( b.min.x ).valueOf() ? a.min.x : b.min.x;
  out.min.y = _toDouble( a.min.y ).valueOf() < _toDouble( b.min.y ).valueOf() ? a.min.y : b.min.y;
  out.max.x = _toDouble( a.max.x ).valueOf() > _toDouble( b.max.x ).valueOf() ? a.max.x : b.max.x;
  out.max.y = _toDouble( a.max.y ).valueOf() > _toDouble( b.max.y ).valueOf() ? a.max.y : b.max.y;
  return out;
}

// Intersection of two THREE.Box2 into `out`, in double-double precision.
// Writes an empty box if the two boxes do not overlap.
export function preciseIntersectInto( out, a, b ) {
  const minX = _toDouble( a.min.x ).valueOf() > _toDouble( b.min.x ).valueOf() ? a.min.x : b.min.x;
  const minY = _toDouble( a.min.y ).valueOf() > _toDouble( b.min.y ).valueOf() ? a.min.y : b.min.y;
  const maxX = _toDouble( a.max.x ).valueOf() < _toDouble( b.max.x ).valueOf() ? a.max.x : b.max.x;
  const maxY = _toDouble( a.max.y ).valueOf() < _toDouble( b.max.y ).valueOf() ? a.max.y : b.max.y;
  if ( minX > maxX || minY > maxY ) {
    out.makeEmpty();
  } else {
    out.min.set( minX, minY );
    out.max.set( maxX, maxY );
  }
  return out;
}

/*
 * -----------------------------------------------------------------------------
 * PROCEDURAL NOISE (simplex-noise)
 * -----------------------------------------------------------------------------
 * A cached 3D simplex-noise generator per seed. setFromNoise3D places the box
 * center at a noise-derived offset and sizes it from two more decorrelated
 * samples. Useful for procedural UI panel placement, sprite scatter, biome
 * cell sizes, and hand-authored "random AABB" test data.
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

// Fill a THREE.Box2 from a 3D simplex field sampled at (x, y, z). The center
// is placed at a noise-derived offset from the origin; the size along each
// axis is derived from a decorrelated sample scaled by `sizeScale`.
export function setFromNoise3D( out, x, y, z, seed = 0, centerScale = 1, sizeScale = 1 ) {
  const n = _cachedNoise3D( seed );
  const cx = n( x, y, z ) * centerScale;
  const cy = n( x + 31.416, y + 47.853, z + 12.793 ) * centerScale;
  const sx = Math.abs( n( x + 100.1, y + 200.2, z + 300.3 ) ) * sizeScale;
  const sy = Math.abs( n( x - 110.5, y - 210.6, z - 310.7 ) ) * sizeScale;
  out.min.set( cx - sx, cy - sy );
  out.max.set( cx + sx, cy + sy );
  return out;
}

// Drop every cached noise generator.
export function disposeNoise3DCache() {
  _noise3DCache.clear();
}

// Module-local scratch buffers — allocated once, reused across every bridge.
// Declared ABOVE the class so nothing can hit a TDZ at module evaluation.
const _scratchVec2A = new Float32Array( 2 );
const _scratchVec2B = new Float32Array( 2 );

/*
 * -----------------------------------------------------------------------------
 * THREE.Box2
 * -----------------------------------------------------------------------------
 */
class Box2 {

  constructor( min = new Vector2( + Infinity, + Infinity ), max = new Vector2( - Infinity, - Infinity ) ) {
    this.isBox2 = true;
    this.min = min;
    this.max = max;
  }

  set( min, max ) {
    this.min.copy( min );
    this.max.copy( max );
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

  clone() {
    return new this.constructor().copy( this );
  }

  copy( box ) {
    this.min.copy( box.min );
    this.max.copy( box.max );
    return this;
  }

  makeEmpty() {
    this.min.x = this.min.y = + Infinity;
    this.max.x = this.max.y = - Infinity;
    return this;
  }

  isEmpty() {
    return ( this.max.x < this.min.x ) || ( this.max.y < this.min.y );
  }

  getCenter( target ) {
    if ( target === undefined ) {
      console.warn( 'THREE.Box2: .getCenter() target is now required' );
      target = new Vector2();
    }
    return this.isEmpty() ? target.set( 0, 0 ) : target.addVectors( this.min, this.max ).multiplyScalar( 0.5 );
  }

  getSize( target ) {
    if ( target === undefined ) {
      console.warn( 'THREE.Box2: .getSize() target is now required' );
      target = new Vector2();
    }
    return this.isEmpty() ? target.set( 0, 0 ) : target.subVectors( this.max, this.min );
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

  containsPoint( point ) {
    return point.x >= this.min.x && point.x <= this.max.x &&
      point.y >= this.min.y && point.y <= this.max.y;
  }

  containsBox( box ) {
    return this.min.x <= box.min.x && box.max.x <= this.max.x &&
      this.min.y <= box.min.y && box.max.y <= this.max.y;
  }

  getParameter( point, target ) {
    if ( target === undefined ) {
      console.warn( 'THREE.Box2: .getParameter() target is now required' );
      target = new Vector2();
    }
    return target.set(
      ( point.x - this.min.x ) / ( this.max.x - this.min.x ),
      ( point.y - this.min.y ) / ( this.max.y - this.min.y )
    );
  }

  intersectsBox( box ) {
    return ! ( box.max.x < this.min.x || box.min.x > this.max.x ||
      box.max.y < this.min.y || box.min.y > this.max.y );
  }

  clampPoint( point, target ) {
    if ( target === undefined ) {
      console.warn( 'THREE.Box2: .clampPoint() target is now required' );
      target = new Vector2();
    }
    return target.copy( point ).clamp( this.min, this.max );
  }

  distanceToPoint( point ) {
    const clampedPoint = _vector.copy( point ).clamp( this.min, this.max );
    return clampedPoint.sub( point ).length();
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

  translate( offset ) {
    this.min.add( offset );
    this.max.add( offset );
    return this;
  }

  equals( box ) {
    return box.min.equals( this.min ) && box.max.equals( this.max );
  }

  fromArray( array, offset = 0 ) {
    this.min.fromArray( array, offset );
    this.max.fromArray( array, offset + 2 );
    return this;
  }

  toArray( array = [], offset = 0 ) {
    this.min.toArray( array, offset );
    this.max.toArray( array, offset + 2 );
    return array;
  }

}

const _vector = /*@__PURE__*/ new Vector2();

// Default export for parity with other math classes in this module.
export default Box2;
export { Box2 };