// file number : 060
// full path name : src/math/060_Line3.js
// description : 3D line-segment primitive — drop-in replacement for THREE.Line3 (r185). Defined by two Vector3-like endpoints (start, end) that are duck-typed to accept any {x,y,z} object, THREE.Vector3, or flat [x,y,z] array. Full r185 surface: constructor(start, end), set(start, end), copy(line), clone(), getCenter(target), delta(target), distanceSq(), distance(), at(t, target), closestPointToPointParameter(point, clampToLine), closestPointToPoint(point, clampToLine, target), applyMatrix4(matrix), equals(line). Extended: preciseLengthSq / preciseLength / preciseClosestPointParameter / preciseDistanceSqToPoint via the chat's DoubleDouble module (014) for galactic-scale endpoints; setFromNoise3D via the chat's SimplexNoise (013) with a cached per-seed mulberry32 generator; full zero-allocation bitECS SoA bridge set (from/to/add/sub/lerp/scale in-place, length/lengthSq, closest-point param, at(t), delta) using f32([]) SoA arrays from 014_BitECS; three.js-style flat-array bridges for direct buffer interop; a recycled local pool (Line3.acquire / Line3.recycle) that resets both endpoints to zero; and `disposeNoise3DCache()` for cache cleanup. No THREE, no CDN, no static server, no Vite/Vue — imports only from the chat's own files (003_Common clamp, 013_SimplexNoise, 014_DoubleDouble, 014_BitECS).
// best for : ray/segment intersection, closest-point queries, frustum edge culling, capsule collision, procedural spawn alignment, and any ECS system that stores line segments as SoA endpoints and must feed THREE.Line3 or gl-matrix-style buffers without allocating per frame. The pooled variant is the recommended path for hot loops iterating over 10k+ entities.
// license : MIT

import { clamp } from '../core/003_Common.js';
import * as DD from './014_DoubleDouble.js';
import * as bitecs from './014_BitECS.js';
import { createNoise3D } from './013_SimplexNoise.js';

// ═══════════════════════════════════════════════════════════════════
// bitECS 0.4.0 SoA COMPONENT (archetype-friendly, cache-friendly)
// ═══════════════════════════════════════════════════════════════════
export const Line3Component = {
  startX: bitecs.f32([]),
  startY: bitecs.f32([]),
  startZ: bitecs.f32([]),
  endX:   bitecs.f32([]),
  endY:   bitecs.f32([]),
  endZ:   bitecs.f32([])
};

// ═══════════════════════════════════════════════════════════════════
// Module-scoped helpers — zero allocation in hot paths
// ═══════════════════════════════════════════════════════════════════

function _readX( v ) {
  return v.x !== undefined ? v.x : v[ 0 ];
}
function _readY( v ) {
  return v.y !== undefined ? v.y : v[ 1 ];
}
function _readZ( v ) {
  return v.z !== undefined ? v.z : v[ 2 ];
}

// Writes into a target that may be a THREE.Vector3 (has .set), a plain
// {x,y,z}, or a flat typed array. Returns the target.
function _writeVec3( v, x, y, z ) {
  if ( v && typeof v.set === 'function' ) {
    v.set( x, y, z );
    return v;
  }
  if ( v ) {
    v.x = x;
    v.y = y;
    v.z = z;
    return v;
  }
  return { x, y, z };
}

// Copies source values into target, honoring target's .copy() if present.
function _copyVec3Into( target, source ) {
  const x = _readX( source );
  const y = _readY( source );
  const z = _readZ( source );
  if ( target && typeof target.copy === 'function' && source && typeof source.x === 'number' ) {
    // Fast path: both are THREE.Vector3-like with .copy/.x/.y/.z
    target.x = x;
    target.y = y;
    target.z = z;
    return target;
  }
  return _writeVec3( target, x, y, z );
}

// Produces a plain {x,y,z} default endpoint.
function _vec3( x = 0, y = 0, z = 0 ) {
  return { x, y, z };
}

// Unwraps a THREE.Matrix4 (has .elements) or accepts a flat array directly.
function _matrixElements( m ) {
  return ( m != null && m.elements !== undefined ) ? m.elements : m;
}

// Transforms v by m and writes into out (which may equal v).
function _transformVec3ByMatrix4( out, v, m ) {
  const x = _readX( v );
  const y = _readY( v );
  const z = _readZ( v );
  let w = m[ 3 ] * x + m[ 7 ] * y + m[ 11 ] * z + m[ 15 ];
  w = w || 1.0;
  _writeVec3(
    out,
    ( m[ 0 ] * x + m[ 4 ] * y + m[ 8 ] * z + m[ 12 ] ) / w,
    ( m[ 1 ] * x + m[ 5 ] * y + m[ 9 ] * z + m[ 13 ] ) / w,
    ( m[ 2 ] * x + m[ 6 ] * y + m[ 10 ] * z + m[ 14 ] ) / w
  );
  return out;
}

// ────────────── noise generator cache (per seed) ──────────────

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

// ═══════════════════════════════════════════════════════════════════
// class Line3
// ═══════════════════════════════════════════════════════════════════
class Line3 {

  constructor( start = _vec3(), end = _vec3() ) {
    this.isLine3 = true;
    this.start = start;
    this.end = end;
  }

  set( start, end ) {
    _copyVec3Into( this.start, start );
    _copyVec3Into( this.end, end );
    return this;
  }

  copy( line ) {
    _copyVec3Into( this.start, line.start );
    _copyVec3Into( this.end, line.end );
    return this;
  }

  clone() {
    return new this.constructor().copy( this );
  }

  getCenter( target ) {
    if ( target === undefined ) target = _vec3();
    const sx = _readX( this.start ), sy = _readY( this.start ), sz = _readZ( this.start );
    const ex = _readX( this.end ),   ey = _readY( this.end ),   ez = _readZ( this.end );
    return _writeVec3( target, ( sx + ex ) * 0.5, ( sy + ey ) * 0.5, ( sz + ez ) * 0.5 );
  }

  delta( target ) {
    if ( target === undefined ) target = _vec3();
    const sx = _readX( this.start ), sy = _readY( this.start ), sz = _readZ( this.start );
    const ex = _readX( this.end ),   ey = _readY( this.end ),   ez = _readZ( this.end );
    return _writeVec3( target, ex - sx, ey - sy, ez - sz );
  }

  distanceSq() {
    const sx = _readX( this.start ), sy = _readY( this.start ), sz = _readZ( this.start );
    const ex = _readX( this.end ),   ey = _readY( this.end ),   ez = _readZ( this.end );
    const dx = ex - sx, dy = ey - sy, dz = ez - sz;
    return dx * dx + dy * dy + dz * dz;
  }

  distance() {
    return Math.sqrt( this.distanceSq() );
  }

  at( t, target ) {
    if ( target === undefined ) target = _vec3();
    const sx = _readX( this.start ), sy = _readY( this.start ), sz = _readZ( this.start );
    const ex = _readX( this.end ),   ey = _readY( this.end ),   ez = _readZ( this.end );
    return _writeVec3(
      target,
      sx + t * ( ex - sx ),
      sy + t * ( ey - sy ),
      sz + t * ( ez - sz )
    );
  }

  closestPointToPointParameter( point, clampToLine ) {
    const sx = _readX( this.start ), sy = _readY( this.start ), sz = _readZ( this.start );
    const ex = _readX( this.end ),   ey = _readY( this.end ),   ez = _readZ( this.end );
    const px = _readX( point ) - sx;
    const py = _readY( point ) - sy;
    const pz = _readZ( point ) - sz;
    const dx = ex - sx, dy = ey - sy, dz = ez - sz;
    const startEnd2 = dx * dx + dy * dy + dz * dz;
    if ( startEnd2 === 0 ) return 0;
    const startEnd_startP = dx * px + dy * py + dz * pz;
    let t = startEnd_startP / startEnd2;
    if ( clampToLine ) {
      t = clamp( t, 0, 1 );
    }
    return t;
  }

  closestPointToPoint( point, clampToLine, target ) {
    const t = this.closestPointToPointParameter( point, clampToLine );
    if ( target === undefined ) target = _vec3();
    return this.at( t, target );
  }

  applyMatrix4( matrix ) {
    const me = _matrixElements( matrix );
    _transformVec3ByMatrix4( this.start, this.start, me );
    _transformVec3ByMatrix4( this.end, this.end, me );
    return this;
  }

  equals( line ) {
    const a = this.start, b = line.start;
    if ( _readX( a ) !== _readX( b ) || _readY( a ) !== _readY( b ) || _readZ( a ) !== _readZ( b ) ) return false;
    const c = this.end, d = line.end;
    return _readX( c ) === _readX( d ) && _readY( c ) === _readY( d ) && _readZ( c ) === _readZ( d );
  }

  toArray( array = [], offset = 0 ) {
    array[ offset ]     = _readX( this.start );
    array[ offset + 1 ] = _readY( this.start );
    array[ offset + 2 ] = _readZ( this.start );
    array[ offset + 3 ] = _readX( this.end );
    array[ offset + 4 ] = _readY( this.end );
    array[ offset + 5 ] = _readZ( this.end );
    return array;
  }

  fromArray( array, offset = 0 ) {
    _writeVec3( this.start, array[ offset ], array[ offset + 1 ], array[ offset + 2 ] );
    _writeVec3( this.end,   array[ offset + 3 ], array[ offset + 4 ], array[ offset + 5 ] );
    return this;
  }

  // ────────────── pooled instances ──────────────

  static acquire() {
    return _localPool.length > 0 ? _localPool.pop() : new Line3();
  }

  static recycle( line ) {
    if ( line instanceof Line3 && _localPool.length < LOCAL_POOL_MAX ) {
      _writeVec3( line.start, 0, 0, 0 );
      _writeVec3( line.end,   0, 0, 0 );
      _localPool.push( line );
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// BRIDGE: THREE-style <-> flat arrays (gl-matrix compatible)
// ═══════════════════════════════════════════════════════════════════

export function threeLine3FromGlMatrixPacked( out, glPacked ) {
  _writeVec3( out.start, glPacked[ 0 ], glPacked[ 1 ], glPacked[ 2 ] );
  _writeVec3( out.end,   glPacked[ 3 ], glPacked[ 4 ], glPacked[ 5 ] );
  return out;
}

export function threeLine3FromGlMatrix( out, glStart, glEnd ) {
  _writeVec3( out.start, glStart[ 0 ], glStart[ 1 ], glStart[ 2 ] );
  _writeVec3( out.end,   glEnd[ 0 ],   glEnd[ 1 ],   glEnd[ 2 ] );
  return out;
}

export function glMatrixLine3PackedFromThree( outPacked, threeLine ) {
  outPacked[ 0 ] = _readX( threeLine.start );
  outPacked[ 1 ] = _readY( threeLine.start );
  outPacked[ 2 ] = _readZ( threeLine.start );
  outPacked[ 3 ] = _readX( threeLine.end );
  outPacked[ 4 ] = _readY( threeLine.end );
  outPacked[ 5 ] = _readZ( threeLine.end );
  return outPacked;
}

export function glMatrixLine3FromThree( outStart, outEnd, threeLine ) {
  outStart[ 0 ] = _readX( threeLine.start );
  outStart[ 1 ] = _readY( threeLine.start );
  outStart[ 2 ] = _readZ( threeLine.start );
  outEnd[ 0 ] = _readX( threeLine.end );
  outEnd[ 1 ] = _readY( threeLine.end );
  outEnd[ 2 ] = _readZ( threeLine.end );
  return threeLine;
}

// ═══════════════════════════════════════════════════════════════════
// BRIDGE: THREE-style <-> bitECS SoA
// ═══════════════════════════════════════════════════════════════════

export function threeLine3FromBitecs( out, eid, store = Line3Component ) {
  _writeVec3( out.start, store.startX[ eid ], store.startY[ eid ], store.startZ[ eid ] );
  _writeVec3( out.end,   store.endX[ eid ],   store.endY[ eid ],   store.endZ[ eid ] );
  return out;
}

export function bitecsLine3FromThree( eid, threeLine, store = Line3Component ) {
  store.startX[ eid ] = _readX( threeLine.start );
  store.startY[ eid ] = _readY( threeLine.start );
  store.startZ[ eid ] = _readZ( threeLine.start );
  store.endX[ eid ]   = _readX( threeLine.end );
  store.endY[ eid ]   = _readY( threeLine.end );
  store.endZ[ eid ]   = _readZ( threeLine.end );
  return eid;
}

export function bitecsLine3FromGlMatrixPacked( eid, glPacked, store = Line3Component ) {
  store.startX[ eid ] = glPacked[ 0 ];
  store.startY[ eid ] = glPacked[ 1 ];
  store.startZ[ eid ] = glPacked[ 2 ];
  store.endX[ eid ]   = glPacked[ 3 ];
  store.endY[ eid ]   = glPacked[ 4 ];
  store.endZ[ eid ]   = glPacked[ 5 ];
  return eid;
}

export function glMatrixLine3PackedFromBitecs( outPacked, eid, store = Line3Component ) {
  outPacked[ 0 ] = store.startX[ eid ];
  outPacked[ 1 ] = store.startY[ eid ];
  outPacked[ 2 ] = store.startZ[ eid ];
  outPacked[ 3 ] = store.endX[ eid ];
  outPacked[ 4 ] = store.endY[ eid ];
  outPacked[ 5 ] = store.endZ[ eid ];
  return outPacked;
}

export function glMatrixLine3FromBitecs( outStart, outEnd, eid, store = Line3Component ) {
  outStart[ 0 ] = store.startX[ eid ];
  outStart[ 1 ] = store.startY[ eid ];
  outStart[ 2 ] = store.startZ[ eid ];
  outEnd[ 0 ] = store.endX[ eid ];
  outEnd[ 1 ] = store.endY[ eid ];
  outEnd[ 2 ] = store.endZ[ eid ];
  return eid;
}

export function bitecsLine3CopyInto( eidOut, eidIn, storeIn = Line3Component, storeOut = storeIn ) {
  storeOut.startX[ eidOut ] = storeIn.startX[ eidIn ];
  storeOut.startY[ eidOut ] = storeIn.startY[ eidIn ];
  storeOut.startZ[ eidOut ] = storeIn.startZ[ eidIn ];
  storeOut.endX[ eidOut ]   = storeIn.endX[ eidIn ];
  storeOut.endY[ eidOut ]   = storeIn.endY[ eidIn ];
  storeOut.endZ[ eidOut ]   = storeIn.endZ[ eidIn ];
  return eidOut;
}

export function bitecsLine3AddInto( eidOut, eidA, eidB, storeA = Line3Component, storeB = Line3Component, storeOut = storeA ) {
  storeOut.startX[ eidOut ] = storeA.startX[ eidA ] + storeB.startX[ eidB ];
  storeOut.startY[ eidOut ] = storeA.startY[ eidA ] + storeB.startY[ eidB ];
  storeOut.startZ[ eidOut ] = storeA.startZ[ eidA ] + storeB.startZ[ eidB ];
  storeOut.endX[ eidOut ]   = storeA.endX[ eidA ]   + storeB.endX[ eidB ];
  storeOut.endY[ eidOut ]   = storeA.endY[ eidA ]   + storeB.endY[ eidB ];
  storeOut.endZ[ eidOut ]   = storeA.endZ[ eidA ]   + storeB.endZ[ eidB ];
  return eidOut;
}

export function bitecsLine3SubInto( eidOut, eidA, eidB, storeA = Line3Component, storeB = Line3Component, storeOut = storeA ) {
  storeOut.startX[ eidOut ] = storeA.startX[ eidA ] - storeB.startX[ eidB ];
  storeOut.startY[ eidOut ] = storeA.startY[ eidA ] - storeB.startY[ eidB ];
  storeOut.startZ[ eidOut ] = storeA.startZ[ eidA ] - storeB.startZ[ eidB ];
  storeOut.endX[ eidOut ]   = storeA.endX[ eidA ]   - storeB.endX[ eidB ];
  storeOut.endY[ eidOut ]   = storeA.endY[ eidA ]   - storeB.endY[ eidB ];
  storeOut.endZ[ eidOut ]   = storeA.endZ[ eidA ]   - storeB.endZ[ eidB ];
  return eidOut;
}

export function bitecsLine3ScaleInPlace( eid, scalar, store = Line3Component ) {
  store.startX[ eid ] *= scalar;
  store.startY[ eid ] *= scalar;
  store.startZ[ eid ] *= scalar;
  store.endX[ eid ]   *= scalar;
  store.endY[ eid ]   *= scalar;
  store.endZ[ eid ]   *= scalar;
  return eid;
}

export function bitecsLine3LerpInto( eidOut, eidA, eidB, alpha, storeA = Line3Component, storeB = Line3Component, storeOut = storeA ) {
  storeOut.startX[ eidOut ] = storeA.startX[ eidA ] + ( storeB.startX[ eidB ] - storeA.startX[ eidA ] ) * alpha;
  storeOut.startY[ eidOut ] = storeA.startY[ eidA ] + ( storeB.startY[ eidB ] - storeA.startY[ eidA ] ) * alpha;
  storeOut.startZ[ eidOut ] = storeA.startZ[ eidA ] + ( storeB.startZ[ eidB ] - storeA.startZ[ eidA ] ) * alpha;
  storeOut.endX[ eidOut ]   = storeA.endX[ eidA ]   + ( storeB.endX[ eidB ]   - storeA.endX[ eidA ]   ) * alpha;
  storeOut.endY[ eidOut ]   = storeA.endY[ eidA ]   + ( storeB.endY[ eidB ]   - storeA.endY[ eidA ]   ) * alpha;
  storeOut.endZ[ eidOut ]   = storeA.endZ[ eidA ]   + ( storeB.endZ[ eidB ]   - storeA.endZ[ eidA ]   ) * alpha;
  return eidOut;
}

export function bitecsLine3LengthSq( eid, store = Line3Component ) {
  const dx = store.endX[ eid ] - store.startX[ eid ];
  const dy = store.endY[ eid ] - store.startY[ eid ];
  const dz = store.endZ[ eid ] - store.startZ[ eid ];
  return dx * dx + dy * dy + dz * dz;
}

export function bitecsLine3Length( eid, store = Line3Component ) {
  return Math.sqrt( bitecsLine3LengthSq( eid, store ) );
}

export function bitecsLine3AtInto( eidOutVec, eidLine, t, storeLine = Line3Component, storeVec ) {
  storeVec.x[ eidOutVec ] = storeLine.startX[ eidLine ] + ( storeLine.endX[ eidLine ] - storeLine.startX[ eidLine ] ) * t;
  storeVec.y[ eidOutVec ] = storeLine.startY[ eidLine ] + ( storeLine.endY[ eidLine ] - storeLine.startY[ eidLine ] ) * t;
  storeVec.z[ eidOutVec ] = storeLine.startZ[ eidLine ] + ( storeLine.endZ[ eidLine ] - storeLine.startZ[ eidLine ] ) * t;
  return eidOutVec;
}

export function bitecsLine3DeltaInto( eidOutVec, eidLine, storeLine = Line3Component, storeVec ) {
  storeVec.x[ eidOutVec ] = storeLine.endX[ eidLine ] - storeLine.startX[ eidLine ];
  storeVec.y[ eidOutVec ] = storeLine.endY[ eidLine ] - storeLine.startY[ eidLine ];
  storeVec.z[ eidOutVec ] = storeLine.endZ[ eidLine ] - storeLine.startZ[ eidLine ];
  return eidOutVec;
}

export function bitecsLine3ClosestPointParameter( eidLine, eidPoint, storeLine = Line3Component, storePoint ) {
  const sx = storeLine.startX[ eidLine ];
  const sy = storeLine.startY[ eidLine ];
  const sz = storeLine.startZ[ eidLine ];
  const dx = storeLine.endX[ eidLine ] - sx;
  const dy = storeLine.endY[ eidLine ] - sy;
  const dz = storeLine.endZ[ eidLine ] - sz;
  const lenSq = dx * dx + dy * dy + dz * dz;
  if ( lenSq === 0 ) return 0;
  const px = storePoint.x[ eidPoint ] - sx;
  const py = storePoint.y[ eidPoint ] - sy;
  const pz = storePoint.z[ eidPoint ] - sz;
  return clamp( ( px * dx + py * dy + pz * dz ) / lenSq, 0, 1 );
}

export function bitecsLine3ClosestPointInto( eidOutVec, eidLine, eidPoint, storeLine = Line3Component, storePoint, storeVec ) {
  const t = bitecsLine3ClosestPointParameter( eidLine, eidPoint, storeLine, storePoint );
  return bitecsLine3AtInto( eidOutVec, eidLine, t, storeLine, storeVec );
}

export function threeVec3FromBitecsLine3At( out, eidLine, t, store = Line3Component ) {
  return _writeVec3(
    out,
    store.startX[ eidLine ] + ( store.endX[ eidLine ] - store.startX[ eidLine ] ) * t,
    store.startY[ eidLine ] + ( store.endY[ eidLine ] - store.startY[ eidLine ] ) * t,
    store.startZ[ eidLine ] + ( store.endZ[ eidLine ] - store.startZ[ eidLine ] ) * t
  );
}

export function threeVec3FromBitecsLine3ClosestPoint( out, eidLine, eidPoint, storeLine = Line3Component, storePoint ) {
  const t = bitecsLine3ClosestPointParameter( eidLine, eidPoint, storeLine, storePoint );
  return threeVec3FromBitecsLine3At( out, eidLine, t, storeLine );
}

// ═══════════════════════════════════════════════════════════════════
// HIGH-PRECISION (DoubleDouble) HELPERS — for galactic-scale endpoints
// ═══════════════════════════════════════════════════════════════════

export function preciseLengthSq( line ) {
  const dx = DD.subtract( DD.fromDouble( _readX( line.end ) ), DD.fromDouble( _readX( line.start ) ) );
  const dy = DD.subtract( DD.fromDouble( _readY( line.end ) ), DD.fromDouble( _readY( line.start ) ) );
  const dz = DD.subtract( DD.fromDouble( _readZ( line.end ) ), DD.fromDouble( _readZ( line.start ) ) );
  return DD.toDouble(
    DD.add(
      DD.add( DD.multiply( dx, dx ), DD.multiply( dy, dy ) ),
      DD.multiply( dz, dz )
    )
  );
}

export function preciseLength( line ) {
  return Math.sqrt( preciseLengthSq( line ) );
}

export function preciseClosestPointParameter( line, point ) {
  const sx = DD.fromDouble( _readX( line.start ) );
  const sy = DD.fromDouble( _readY( line.start ) );
  const sz = DD.fromDouble( _readZ( line.start ) );
  const dx = DD.subtract( DD.fromDouble( _readX( line.end ) ), sx );
  const dy = DD.subtract( DD.fromDouble( _readY( line.end ) ), sy );
  const dz = DD.subtract( DD.fromDouble( _readZ( line.end ) ), sz );
  const lenSq = DD.add(
    DD.add( DD.multiply( dx, dx ), DD.multiply( dy, dy ) ),
    DD.multiply( dz, dz )
  );
  if ( DD.toDouble( lenSq ) === 0 ) return 0;
  const px = DD.subtract( DD.fromDouble( _readX( point ) ), sx );
  const py = DD.subtract( DD.fromDouble( _readY( point ) ), sy );
  const pz = DD.subtract( DD.fromDouble( _readZ( point ) ), sz );
  const dot = DD.add(
    DD.add( DD.multiply( px, dx ), DD.multiply( py, dy ) ),
    DD.multiply( pz, dz )
  );
  return DD.toDouble( DD.divide( dot, lenSq ) );
}

export function preciseDistanceSqToPoint( line, point ) {
  const tRaw = preciseClosestPointParameter( line, point );
  const t = clamp( tRaw, 0, 1 );
  const sx = DD.fromDouble( _readX( line.start ) );
  const sy = DD.fromDouble( _readY( line.start ) );
  const sz = DD.fromDouble( _readZ( line.start ) );
  const dx = DD.subtract( DD.fromDouble( _readX( line.end ) ), sx );
  const dy = DD.subtract( DD.fromDouble( _readY( line.end ) ), sy );
  const dz = DD.subtract( DD.fromDouble( _readZ( line.end ) ), sz );
  const tD = DD.fromDouble( t );
  const cx = DD.add( sx, DD.multiply( dx, tD ) );
  const cy = DD.add( sy, DD.multiply( dy, tD ) );
  const cz = DD.add( sz, DD.multiply( dz, tD ) );
  const ex = DD.subtract( DD.fromDouble( _readX( point ) ), cx );
  const ey = DD.subtract( DD.fromDouble( _readY( point ) ), cy );
  const ez = DD.subtract( DD.fromDouble( _readZ( point ) ), cz );
  return DD.toDouble(
    DD.add(
      DD.add( DD.multiply( ex, ex ), DD.multiply( ey, ey ) ),
      DD.multiply( ez, ez )
    )
  );
}

// ═══════════════════════════════════════════════════════════════════
// PROCEDURAL NOISE — sample two endpoints from a 3D simplex field
// ═══════════════════════════════════════════════════════════════════

export function setFromNoise3D( out, x, y, z, seed = 0, scale = 1, offset = 1 ) {
  const n = _cachedNoise3D( seed );
  _writeVec3(
    out.start,
    n( x, y, z ) * scale,
    n( x + 31.416, y + 47.853, z + 12.793 ) * scale,
    n( x - 17.234, y - 53.127, z - 91.056 ) * scale
  );
  _writeVec3(
    out.end,
    n( x + offset, y, z ) * scale,
    n( x + 31.416 + offset, y + 47.853, z + 12.793 ) * scale,
    n( x - 17.234 + offset, y - 53.127, z - 91.056 ) * scale
  );
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// Named + default exports
// ═══════════════════════════════════════════════════════════════════
export { Line3 };
export default Line3;