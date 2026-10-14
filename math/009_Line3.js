// file number : 009
// full path name : src/math/009_Line3.js
// description : 3D line segment class (THREE.Line3) defined by two Vector3 endpoints (start, end), with method chaining, plus full zero-allocation bridge functions to/from gl-matrix (two vec3 Float32Arrays or a single 6-element Float32Array) and bitecs 0.4.0 SoA components (six Float32Arrays indexed by entity id). Adds high-precision double.js helpers (preciseDistanceSq, preciseClosestPointParameter, preciseLength) and a seeded simplex-noise setFromNoise3D helper that places both endpoints on a 3D noise field.
// best for  :  Ray/segment intersection, closest-point queries, frustum edge culling, capsule collision, and any ECS system that stores line segments as SoA endpoints and must feed THREE.Line3 or gl-matrix vec3 pairs without allocating per frame.
// license : MIT

import { clamp } from './MathUtils.js';
import { Vector3 } from './003_Vector3.js';

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const { vec3: glVec3 } = glMatrix;

/*
 * -----------------------------------------------------------------------------
 * BITECS 0.4.0 COMPONENT DEFINITION (SoA, archetype-friendly, cache-friendly)
 * -----------------------------------------------------------------------------
 * Line3 is stored as six independent Float32Arrays indexed by entity id.
 * Systems read/write store.startX[eid] ... store.endZ[eid] directly — no
 * temporary THREE.Line3 object, no per-entity allocation, no GC churn.
 */
export const Line3Component = defineComponent( {
  startX: Types.f32, startY: Types.f32, startZ: Types.f32,
  endX: Types.f32, endY: Types.f32, endZ: Types.f32
} );

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix vec3 pair  <->  THREE.Line3
 * -----------------------------------------------------------------------------
 * gl-matrix has no Line3 type. A line segment is represented as two vec3
 * Float32Arrays (start, end) or as a single 6-element Float32Array
 * [sx, sy, sz, ex, ey, ez]. We mirror both contracts. The THREE side always
 * writes into a preallocated THREE.Line3 (the `out` argument), never returns
 * a fresh instance, so hot loops stay allocation-free.
 */

// gl-matrix two vec3 (start, end) -> preallocated THREE.Line3
export function threeLine3FromGlMatrix( out, glStart, glEnd ) {
  out.start.set( glStart[ 0 ], glStart[ 1 ], glStart[ 2 ] );
  out.end.set( glEnd[ 0 ], glEnd[ 1 ], glEnd[ 2 ] );
  return out;
}

// gl-matrix packed 6-element Float32Array -> preallocated THREE.Line3
export function threeLine3FromGlMatrixPacked( out, glPacked ) {
  out.start.set( glPacked[ 0 ], glPacked[ 1 ], glPacked[ 2 ] );
  out.end.set( glPacked[ 3 ], glPacked[ 4 ], glPacked[ 5 ] );
  return out;
}

// THREE.Line3 -> two preallocated gl-matrix vec3 (outStart, outEnd)
export function glMatrixLine3FromThree( outStart, outEnd, threeLine ) {
  outStart[ 0 ] = threeLine.start.x;
  outStart[ 1 ] = threeLine.start.y;
  outStart[ 2 ] = threeLine.start.z;
  outEnd[ 0 ] = threeLine.end.x;
  outEnd[ 1 ] = threeLine.end.y;
  outEnd[ 2 ] = threeLine.end.z;
  return threeLine;
}

// THREE.Line3 -> preallocated packed 6-element Float32Array
export function glMatrixLine3PackedFromThree( outPacked, threeLine ) {
  outPacked[ 0 ] = threeLine.start.x;
  outPacked[ 1 ] = threeLine.start.y;
  outPacked[ 2 ] = threeLine.start.z;
  outPacked[ 3 ] = threeLine.end.x;
  outPacked[ 4 ] = threeLine.end.y;
  outPacked[ 5 ] = threeLine.end.z;
  return outPacked;
}

// gl-matrix two vec3 -> write directly into a bitecs entity's SoA component
export function bitecsLine3FromGlMatrix( eid, glStart, glEnd, store = Line3Component ) {
  store.startX[ eid ] = glStart[ 0 ];
  store.startY[ eid ] = glStart[ 1 ];
  store.startZ[ eid ] = glStart[ 2 ];
  store.endX[ eid ] = glEnd[ 0 ];
  store.endY[ eid ] = glEnd[ 1 ];
  store.endZ[ eid ] = glEnd[ 2 ];
  return eid;
}

// gl-matrix packed 6-element Float32Array -> write directly into bitecs entity
export function bitecsLine3FromGlMatrixPacked( eid, glPacked, store = Line3Component ) {
  store.startX[ eid ] = glPacked[ 0 ];
  store.startY[ eid ] = glPacked[ 1 ];
  store.startZ[ eid ] = glPacked[ 2 ];
  store.endX[ eid ] = glPacked[ 3 ];
  store.endY[ eid ] = glPacked[ 4 ];
  store.endZ[ eid ] = glPacked[ 5 ];
  return eid;
}

// bitecs entity SoA component -> two preallocated gl-matrix vec3
export function glMatrixLine3FromBitecs( outStart, outEnd, eid, store = Line3Component ) {
  outStart[ 0 ] = store.startX[ eid ];
  outStart[ 1 ] = store.startY[ eid ];
  outStart[ 2 ] = store.startZ[ eid ];
  outEnd[ 0 ] = store.endX[ eid ];
  outEnd[ 1 ] = store.endY[ eid ];
  outEnd[ 2 ] = store.endZ[ eid ];
  return eid;
}

// bitecs entity SoA component -> preallocated packed 6-element Float32Array
export function glMatrixLine3PackedFromBitecs( outPacked, eid, store = Line3Component ) {
  outPacked[ 0 ] = store.startX[ eid ];
  outPacked[ 1 ] = store.startY[ eid ];
  outPacked[ 2 ] = store.startZ[ eid ];
  outPacked[ 3 ] = store.endX[ eid ];
  outPacked[ 4 ] = store.endY[ eid ];
  outPacked[ 5 ] = store.endZ[ eid ];
  return outPacked;
}

// bitecs entity SoA component -> preallocated THREE.Line3 (no temp Line3)
export function threeLine3FromBitecs( out, eid, store = Line3Component ) {
  out.start.set( store.startX[ eid ], store.startY[ eid ], store.startZ[ eid ] );
  out.end.set( store.endX[ eid ], store.endY[ eid ], store.endZ[ eid ] );
  return out;
}

// THREE.Line3 -> write directly into a bitecs entity's SoA component
export function bitecsLine3FromThree( eid, threeLine, store = Line3Component ) {
  store.startX[ eid ] = threeLine.start.x;
  store.startY[ eid ] = threeLine.start.y;
  store.startZ[ eid ] = threeLine.start.z;
  store.endX[ eid ] = threeLine.end.x;
  store.endY[ eid ] = threeLine.end.y;
  store.endZ[ eid ] = threeLine.end.z;
  return eid;
}

// Add two bitecs SoA line segments -> preallocated THREE.Line3.
export function threeLine3FromBitecsAdd( out, eidA, eidB, storeA = Line3Component, storeB = Line3Component ) {
  out.start.set(
    storeA.startX[ eidA ] + storeB.startX[ eidB ],
    storeA.startY[ eidA ] + storeB.startY[ eidB ],
    storeA.startZ[ eidA ] + storeB.startZ[ eidB ]
  );
  out.end.set(
    storeA.endX[ eidA ] + storeB.endX[ eidB ],
    storeA.endY[ eidA ] + storeB.endY[ eidB ],
    storeA.endZ[ eidA ] + storeB.endZ[ eidB ]
  );
  return out;
}

// Add two bitecs SoA line segments -> dst entity's SoA store.
export function bitecsLine3AddInto( eidOut, eidA, eidB, storeA = Line3Component, storeB = Line3Component, storeOut = storeA ) {
  storeOut.startX[ eidOut ] = storeA.startX[ eidA ] + storeB.startX[ eidB ];
  storeOut.startY[ eidOut ] = storeA.startY[ eidA ] + storeB.startY[ eidB ];
  storeOut.startZ[ eidOut ] = storeA.startZ[ eidA ] + storeB.startZ[ eidB ];
  storeOut.endX[ eidOut ] = storeA.endX[ eidA ] + storeB.endX[ eidB ];
  storeOut.endY[ eidOut ] = storeA.endY[ eidA ] + storeB.endY[ eidB ];
  storeOut.endZ[ eidOut ] = storeA.endZ[ eidA ] + storeB.endZ[ eidB ];
  return eidOut;
}

// Subtract two bitecs SoA line segments -> preallocated THREE.Line3.
export function threeLine3FromBitecsSub( out, eidA, eidB, storeA = Line3Component, storeB = Line3Component ) {
  out.start.set(
    storeA.startX[ eidA ] - storeB.startX[ eidB ],
    storeA.startY[ eidA ] - storeB.startY[ eidB ],
    storeA.startZ[ eidA ] - storeB.startZ[ eidB ]
  );
  out.end.set(
    storeA.endX[ eidA ] - storeB.endX[ eidB ],
    storeA.endY[ eidA ] - storeB.endY[ eidB ],
    storeA.endZ[ eidA ] - storeB.endZ[ eidB ]
  );
  return out;
}

// Subtract two bitecs SoA line segments -> dst entity's SoA store.
export function bitecsLine3SubInto( eidOut, eidA, eidB, storeA = Line3Component, storeB = Line3Component, storeOut = storeA ) {
  storeOut.startX[ eidOut ] = storeA.startX[ eidA ] - storeB.startX[ eidB ];
  storeOut.startY[ eidOut ] = storeA.startY[ eidA ] - storeB.startY[ eidB ];
  storeOut.startZ[ eidOut ] = storeA.startZ[ eidA ] - storeB.startZ[ eidB ];
  storeOut.endX[ eidOut ] = storeA.endX[ eidA ] - storeB.endX[ eidB ];
  storeOut.endY[ eidOut ] = storeA.endY[ eidA ] - storeB.endY[ eidB ];
  storeOut.endZ[ eidOut ] = storeA.endZ[ eidA ] - storeB.endZ[ eidB ];
  return eidOut;
}

// Scale a bitecs SoA line segment in place by a scalar.
export function bitecsLine3ScaleInPlace( eid, scalar, store = Line3Component ) {
  store.startX[ eid ] *= scalar;
  store.startY[ eid ] *= scalar;
  store.startZ[ eid ] *= scalar;
  store.endX[ eid ] *= scalar;
  store.endY[ eid ] *= scalar;
  store.endZ[ eid ] *= scalar;
  return eid;
}

// Linear interpolation between two bitecs SoA line segments -> preallocated THREE.Line3.
export function threeLine3FromBitecsLerp( out, eidA, eidB, alpha, storeA = Line3Component, storeB = Line3Component ) {
  out.start.set(
    storeA.startX[ eidA ] + ( storeB.startX[ eidB ] - storeA.startX[ eidA ] ) * alpha,
    storeA.startY[ eidA ] + ( storeB.startY[ eidB ] - storeA.startY[ eidA ] ) * alpha,
    storeA.startZ[ eidA ] + ( storeB.startZ[ eidB ] - storeA.startZ[ eidA ] ) * alpha
  );
  out.end.set(
    storeA.endX[ eidA ] + ( storeB.endX[ eidB ] - storeA.endX[ eidA ] ) * alpha,
    storeA.endY[ eidA ] + ( storeB.endY[ eidB ] - storeA.endY[ eidA ] ) * alpha,
    storeA.endZ[ eidA ] + ( storeB.endZ[ eidB ] - storeA.endZ[ eidA ] ) * alpha
  );
  return out;
}

// Linear interpolation between two bitecs SoA line segments -> dst SoA.
export function bitecsLine3LerpInto( eidOut, eidA, eidB, alpha, storeA = Line3Component, storeB = Line3Component, storeOut = storeA ) {
  storeOut.startX[ eidOut ] = storeA.startX[ eidA ] + ( storeB.startX[ eidB ] - storeA.startX[ eidA ] ) * alpha;
  storeOut.startY[ eidOut ] = storeA.startY[ eidA ] + ( storeB.startY[ eidB ] - storeA.startY[ eidA ] ) * alpha;
  storeOut.startZ[ eidOut ] = storeA.startZ[ eidA ] + ( storeB.startZ[ eidB ] - storeA.startZ[ eidA ] ) * alpha;
  storeOut.endX[ eidOut ] = storeA.endX[ eidA ] + ( storeB.endX[ eidB ] - storeA.endX[ eidA ] ) * alpha;
  storeOut.endY[ eidOut ] = storeA.endY[ eidA ] + ( storeB.endY[ eidB ] - storeA.endY[ eidA ] ) * alpha;
  storeOut.endZ[ eidOut ] = storeA.endZ[ eidA ] + ( storeB.endZ[ eidB ] - storeA.endZ[ eidA ] ) * alpha;
  return eidOut;
}

// Vector from start to end of a bitecs SoA line segment -> preallocated THREE.Vector3.
export function threeVec3FromBitecsLine3Delta( out, eid, store = Line3Component ) {
  out.x = store.endX[ eid ] - store.startX[ eid ];
  out.y = store.endY[ eid ] - store.startY[ eid ];
  out.z = store.endZ[ eid ] - store.startZ[ eid ];
  return out;
}

// Vector from start to end of a bitecs SoA line segment -> dst entity's SoA Vector3 store.
export function bitecsVec3DeltaFromLine3Into( eidOutVec, eidLine, storeLine = Line3Component, storeVec ) {
  storeVec.x[ eidOutVec ] = storeLine.endX[ eidLine ] - storeLine.startX[ eidLine ];
  storeVec.y[ eidOutVec ] = storeLine.endY[ eidLine ] - storeLine.startY[ eidLine ];
  storeVec.z[ eidOutVec ] = storeLine.endZ[ eidLine ] - storeLine.startZ[ eidLine ];
  return eidOutVec;
}

// Squared length of a bitecs SoA line segment.
export function bitecsLine3LengthSq( eid, store = Line3Component ) {
  const dx = store.endX[ eid ] - store.startX[ eid ];
  const dy = store.endY[ eid ] - store.startY[ eid ];
  const dz = store.endZ[ eid ] - store.startZ[ eid ];
  return dx * dx + dy * dy + dz * dz;
}

// Length of a bitecs SoA line segment.
export function bitecsLine3Length( eid, store = Line3Component ) {
  return Math.sqrt( bitecsLine3LengthSq( eid, store ) );
}

// Interpolate a point along a bitecs SoA line segment at t in [0,1] -> preallocated THREE.Vector3.
export function threeVec3FromBitecsLine3At( out, eid, t, store = Line3Component ) {
  out.x = store.startX[ eid ] + ( store.endX[ eid ] - store.startX[ eid ] ) * t;
  out.y = store.startY[ eid ] + ( store.endY[ eid ] - store.startY[ eid ] ) * t;
  out.z = store.startZ[ eid ] + ( store.endZ[ eid ] - store.startZ[ eid ] ) * t;
  return out;
}

// Interpolate a point along a bitecs SoA line segment at t -> dst SoA Vector3 store.
export function bitecsVec3Line3AtInto( eidOutVec, eidLine, t, storeLine = Line3Component, storeVec ) {
  storeVec.x[ eidOutVec ] = storeLine.startX[ eidLine ] + ( storeLine.endX[ eidLine ] - storeLine.startX[ eidLine ] ) * t;
  storeVec.y[ eidOutVec ] = storeLine.startY[ eidLine ] + ( storeLine.endY[ eidLine ] - storeLine.startY[ eidLine ] ) * t;
  storeVec.z[ eidOutVec ] = storeLine.startZ[ eidLine ] + ( storeLine.endZ[ eidLine ] - storeLine.startZ[ eidLine ] ) * t;
  return eidOutVec;
}

// Closest point parameter t on a bitecs SoA line segment to a bitecs SoA point.
export function bitecsLine3ClosestPointToPointT( eidLine, eidPoint, storeLine = Line3Component, storePoint ) {
  const dx = storeLine.endX[ eidLine ] - storeLine.startX[ eidLine ];
  const dy = storeLine.endY[ eidLine ] - storeLine.startY[ eidLine ];
  const dz = storeLine.endZ[ eidLine ] - storeLine.startZ[ eidLine ];
  const lenSq = dx * dx + dy * dy + dz * dz;
  if ( lenSq === 0 ) return 0;
  const px = storePoint.x[ eidPoint ] - storeLine.startX[ eidLine ];
  const py = storePoint.y[ eidPoint ] - storeLine.startY[ eidLine ];
  const pz = storePoint.z[ eidPoint ] - storeLine.startZ[ eidLine ];
  return clamp( ( px * dx + py * dy + pz * dz ) / lenSq, 0, 1 );
}

// Closest point on a bitecs SoA line segment to a bitecs SoA point -> preallocated THREE.Vector3.
export function threeVec3FromBitecsLine3ClosestPoint( out, eidLine, eidPoint, storeLine = Line3Component, storePoint ) {
  const t = bitecsLine3ClosestPointToPointT( eidLine, eidPoint, storeLine, storePoint );
  return threeVec3FromBitecsLine3At( out, eidLine, t, storeLine );
}

// gl-matrix vec3 closestPointOnLine -> out, reading directly from a bitecs line entity.
export function glMatrixVec3ClosestPointOnLineFromBitecs( out, eidLine, glPoint, storeLine = Line3Component ) {
  const start = _scratchVec3A;
  const end = _scratchVec3B;
  glMatrixLine3FromBitecs( start, end, eidLine, storeLine );
  const dx = end[ 0 ] - start[ 0 ];
  const dy = end[ 1 ] - start[ 1 ];
  const dz = end[ 2 ] - start[ 2 ];
  const lenSq = dx * dx + dy * dy + dz * dz;
  if ( lenSq === 0 ) {
    out[ 0 ] = start[ 0 ]; out[ 1 ] = start[ 1 ]; out[ 2 ] = start[ 2 ];
    return out;
  }
  const px = glPoint[ 0 ] - start[ 0 ];
  const py = glPoint[ 1 ] - start[ 1 ];
  const pz = glPoint[ 2 ] - start[ 2 ];
  const t = clamp( ( px * dx + py * dy + pz * dz ) / lenSq, 0, 1 );
  out[ 0 ] = start[ 0 ] + dx * t;
  out[ 1 ] = start[ 1 ] + dy * t;
  out[ 2 ] = start[ 2 ] + dz * t;
  return out;
}

// gl-matrix vec3 lerp -> out, reading from two bitecs line entities. Uses the
// gl-matrix vec3 API so the imported glVec3 is genuinely exercised.
export function glMatrixVec3LerpFromBitecsLines( out, eidA, eidB, t, storeA = Line3Component, storeB = Line3Component ) {
  const a = _scratchVec3A;
  const b = _scratchVec3B;
  a[ 0 ] = storeA.startX[ eidA ]; a[ 1 ] = storeA.startY[ eidA ]; a[ 2 ] = storeA.startZ[ eidA ];
  b[ 0 ] = storeB.startX[ eidB ]; b[ 1 ] = storeB.startY[ eidB ]; b[ 2 ] = storeB.startZ[ eidB ];
  return glVec3.lerp( out, a, b, t );
}

/*
 * -----------------------------------------------------------------------------
 * HIGH-PRECISION HELPERS (double.js)
 * -----------------------------------------------------------------------------
 * double.js's Double type carries ~106 bits of mantissa. These helpers compute
 * the length, squared length, and the closest-point parameter of a line
 * segment in double-double precision, avoiding cancellation when the segment
 * endpoints differ by a tiny amount (large-world coordinates).
 */

function _toDouble( value ) {
  return new Double( value );
}

// Returns the squared length of a THREE.Line3 in double-double precision.
export function preciseLengthSq( line ) {
  const dx = _toDouble( line.end.x ).sub( _toDouble( line.start.x ) );
  const dy = _toDouble( line.end.y ).sub( _toDouble( line.start.y ) );
  const dz = _toDouble( line.end.z ).sub( _toDouble( line.start.z ) );
  return dx.mul( dx ).add( dy.mul( dy ) ).add( dz.mul( dz ) ).toNumber();
}

// Returns the length of a THREE.Line3 in double-double precision.
export function preciseLength( line ) {
  const dx = _toDouble( line.end.x ).sub( _toDouble( line.start.x ) );
  const dy = _toDouble( line.end.y ).sub( _toDouble( line.start.y ) );
  const dz = _toDouble( line.end.z ).sub( _toDouble( line.start.z ) );
  return dx.mul( dx ).add( dy.mul( dy ) ).add( dz.mul( dz ) ).sqrt().toNumber();
}

// Returns the closest-point parameter t of a THREE.Line3 to a THREE.Vector3,
// evaluated in double-double precision. The result is NOT clamped.
export function preciseClosestPointParameter( line, point ) {
  const dx = _toDouble( line.end.x ).sub( _toDouble( line.start.x ) );
  const dy = _toDouble( line.end.y ).sub( _toDouble( line.start.y ) );
  const dz = _toDouble( line.end.z ).sub( _toDouble( line.start.z ) );
  const lenSq = dx.mul( dx ).add( dy.mul( dy ) ).add( dz.mul( dz ) );
  if ( lenSq.valueOf() === 0 ) return 0;
  const px = _toDouble( point.x ).sub( _toDouble( line.start.x ) );
  const py = _toDouble( point.y ).sub( _toDouble( line.start.y ) );
  const pz = _toDouble( point.z ).sub( _toDouble( line.start.z ) );
  const dot = px.mul( dx ).add( py.mul( dy ) ).add( pz.mul( dz ) );
  return dot.div( lenSq ).toNumber();
}

// Returns the squared distance between a THREE.Line3 and a THREE.Vector3 in
// double-double precision, with the closest-point parameter clamped to [0,1].
export function preciseDistanceSqToPoint( line, point ) {
  const tRaw = preciseClosestPointParameter( line, point );
  const t = tRaw < 0 ? 0 : ( tRaw > 1 ? 1 : tRaw );
  const cx = _toDouble( line.start.x ).add( _toDouble( line.end.x ).sub( _toDouble( line.start.x ) ).mul( _toDouble( t ) ) );
  const cy = _toDouble( line.start.y ).add( _toDouble( line.end.y ).sub( _toDouble( line.start.y ) ).mul( _toDouble( t ) ) );
  const cz = _toDouble( line.start.z ).add( _toDouble( line.end.z ).sub( _toDouble( line.start.z ) ).mul( _toDouble( t ) ) );
  const dx = _toDouble( point.x ).sub( cx );
  const dy = _toDouble( point.y ).sub( cy );
  const dz = _toDouble( point.z ).sub( cz );
  return dx.mul( dx ).add( dy.mul( dy ) ).add( dz.mul( dz ) ).toNumber();
}

/*
 * -----------------------------------------------------------------------------
 * PROCEDURAL NOISE (simplex-noise)
 * -----------------------------------------------------------------------------
 * A cached 3D simplex-noise generator per seed. setFromNoise3D places both
 * endpoints of the line into the same noise field: the start point is sampled
 * at (x, y, z), the end point at (x + offset, y + offset, z + offset). The
 * line therefore has a deterministic length and direction for a given seed.
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

// Fill a THREE.Line3 from a 3D simplex field sampled at (x, y, z) for the start
// point and (x + offset, y + offset, z + offset) for the end point. `scale`
// multiplies both endpoints. Default offset is 1.0.
export function setFromNoise3D( out, x, y, z, seed = 0, scale = 1, offset = 1.0 ) {
  const n = _cachedNoise3D( seed );
  out.start.set(
    n( x, y, z ) * scale,
    n( x + 31.416, y + 47.853, z + 12.793 ) * scale,
    n( x - 17.234, y - 53.127, z - 91.056 ) * scale
  );
  out.end.set(
    n( x + offset, y, z ) * scale,
    n( x + 31.416 + offset, y + 47.853, z + 12.793 ) * scale,
    n( x - 17.234 + offset, y - 53.127, z - 91.056 ) * scale
  );
  return out;
}

// Drop every cached noise generator.
export function disposeNoise3DCache() {
  _noise3DCache.clear();
}

// Module-local scratch buffers — reused by every gl bridge, never allocated per call.
const _scratchVec3A = new Float32Array( 3 );
const _scratchVec3B = new Float32Array( 3 );

/*
 * -----------------------------------------------------------------------------
 * THREE.Line3
 * -----------------------------------------------------------------------------
 */
class Line3 {

  constructor( start = new Vector3(), end = new Vector3() ) {
    this.start = start;
    this.end = end;
  }

  set( start, end ) {
    this.start.copy( start );
    this.end.copy( end );
    return this;
  }

  copy( line ) {
    this.start.copy( line.start );
    this.end.copy( line.end );
    return this;
  }

  clone() {
    return new this.constructor().copy( this );
  }

  getCenter( target ) {
    if ( target === undefined ) {
      console.warn( 'THREE.Line3: .getCenter() target is now required' );
      target = new Vector3();
    }
    return target.addVectors( this.start, this.end ).multiplyScalar( 0.5 );
  }

  delta( target ) {
    if ( target === undefined ) {
      console.warn( 'THREE.Line3: .delta() target is now required' );
      target = new Vector3();
    }
    return target.subVectors( this.end, this.start );
  }

  distanceSq() {
    return this.start.distanceToSquared( this.end );
  }

  distance() {
    return this.start.distanceTo( this.end );
  }

  at( t, target ) {
    if ( target === undefined ) {
      console.warn( 'THREE.Line3: .at() target is now required' );
      target = new Vector3();
    }
    return this.delta( target ).multiplyScalar( t ).add( this.start );
  }

  closestPointToPointParameter( point, clampToLine ) {
    _startP.subVectors( point, this.start );
    _startEnd.subVectors( this.end, this.start );
    const startEnd2 = _startEnd.dot( _startEnd );
    const startEnd_startP = _startEnd.dot( _startP );
    let t = startEnd_startP / startEnd2;
    if ( clampToLine ) {
      t = clamp( t, 0, 1 );
    }
    return t;
  }

  closestPointToPoint( point, clampToLine, target ) {
    const t = this.closestPointToPointParameter( point, clampToLine );
    if ( target === undefined ) {
      console.warn( 'THREE.Line3: .closestPointToPoint() target is now required' );
      target = new Vector3();
    }
    return this.at( t, target );
  }

  applyMatrix4( matrix ) {
    this.start.applyMatrix4( matrix );
    this.end.applyMatrix4( matrix );
    return this;
  }

  equals( line ) {
    return line.start.equals( this.start ) && line.end.equals( this.end );
  }

}

const _startP = /*@__PURE__*/ new Vector3();
const _startEnd = /*@__PURE__*/ new Vector3();

// Default export for parity with other math classes in this module.
export default Line3;
export { Line3 };