// file number : 063
// full path name : src/math/063_Box2.js
// description : 2D axis-aligned bounding box — drop-in replacement for THREE.Box2 (r185). Renumbered to 063 to supersede the earlier 027_Box2 draft and stay in topological order after 062_Sphere. min/max are duck-typed vec2-like values ({x,y}, flat [x,y], or THREE.Vector2 instances) — every class method reads/writes via `_rx`/`_ry`/`_writeVec2` helpers so nothing depends on any external Vector2 class. Complete r185 surface: constructor(min, max), isBox2 flag, set(min, max), setFromPoints(points), setFromCenterAndSize(center, size), copy(box), clone(), makeEmpty(), isEmpty(), getCenter(target), getSize(target), expandByPoint(point), expandByVector(vector), expandByScalar(scalar), containsPoint(point), containsBox(box), getParameter(point, target), intersectsBox(box), clampPoint(point, target), distanceToPoint(point), intersect(box), union(box), translate(offset), equals(box), fromArray(array, offset), toArray(array, offset). Extended: preciseArea / preciseDistanceToPoint / preciseUnionInto / preciseIntersectInto via the chat's DoubleDouble (014) for galactic-scale 2D coordinates; setFromNoise3D via the chat's SimplexNoise (013) with cached per-seed mulberry32 generator; full zero-allocation bitECS SoA bridge set using `Box2Component` (minX/minY/maxX/maxY `f32([])` from 014_BitECS) covering from/to/copy/union/intersect/expand-by-point/expand-by-vector/expand-by-scalar/contains/intersects/clamp/distance/center/size/parameter/translate/isEmpty/makeEmpty; flat-array bridges for gl-matrix-style packed [minx,miny,maxx,maxy] interop; and a recycled local pool (Box2.acquire / Box2.recycle) that resets min to (+Inf,+Inf) and max to (-Inf,-Inf). No THREE, no CDN, no static server, no Vite/Vue — imports only from the chat's own files (003_Common clamp, 013_SimplexNoise, 014_DoubleDouble, 014_BitECS).
// best for : UI bounds, screen-space culling, 2D collision broad-phase, texture-atlas regions, sprite/quad bounds, mouse picking in 2D, procedural UI panel placement, minimap extents, and any ECS system that stores 2D AABBs as SoA min/max corners and must feed THREE.Box2 or a flat-packed buffer without allocating per frame. The pooled + SoA-bridge paths are the recommended route for hot loops at 10k+ entities on Android 64-bit.
// license : MIT

import { clamp } from '../core/003_Common.js';
import * as DD from './014_DoubleDouble.js';
import * as bitecs from './014_BitECS.js';
import { createNoise3D } from './013_SimplexNoise.js';

// ═══════════════════════════════════════════════════════════════════
// bitECS 0.4.0 SoA COMPONENT (archetype-friendly, cache-friendly)
// ═══════════════════════════════════════════════════════════════════
export const Box2Component = {
  minX: bitecs.f32([]),
  minY: bitecs.f32([]),
  maxX: bitecs.f32([]),
  maxY: bitecs.f32([])
};

// ═══════════════════════════════════════════════════════════════════
// Duck-typed vec2 accessors — zero allocation in hot paths
// ═══════════════════════════════════════════════════════════════════

function _rx( v ) { return v.x !== undefined ? v.x : v[ 0 ]; }
function _ry( v ) { return v.y !== undefined ? v.y : v[ 1 ]; }

function _writeVec2( v, x, y ) {
  if ( v === null || v === undefined ) return { x, y };
  if ( Array.isArray( v ) ) {
    v[ 0 ] = x;
    v[ 1 ] = y;
    return v;
  }
  v.x = x;
  v.y = y;
  return v;
}

function _copyVec2Into( target, source ) {
  return _writeVec2( target, _rx( source ), _ry( source ) );
}

function _vec2( x = 0, y = 0 ) {
  return { x, y };
}

// ────────────── noise cache ──────────────
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

// Scratch vec2s reused by flat-array bridges
const _scratchVec2A = new Float32Array( 2 );
const _scratchVec2B = new Float32Array( 2 );

// ═══════════════════════════════════════════════════════════════════
// class Box2
// ═══════════════════════════════════════════════════════════════════
class Box2 {

  constructor( min, max ) {
    this.isBox2 = true;
    this.min = min !== undefined ? min : _vec2( Infinity, Infinity );
    this.max = max !== undefined ? max : _vec2( -Infinity, -Infinity );
  }

  set( min, max ) {
    _copyVec2Into( this.min, min );
    _copyVec2Into( this.max, max );
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
    const cx = _rx( center );
    const cy = _ry( center );
    const hx = _rx( size ) * 0.5;
    const hy = _ry( size ) * 0.5;
    _writeVec2( this.min, cx - hx, cy - hy );
    _writeVec2( this.max, cx + hx, cy + hy );
    return this;
  }

  copy( box ) {
    _copyVec2Into( this.min, box.min );
    _copyVec2Into( this.max, box.max );
    return this;
  }

  clone() {
    return new this.constructor(
      _vec2( _rx( this.min ), _ry( this.min ) ),
      _vec2( _rx( this.max ), _ry( this.max ) )
    );
  }

  makeEmpty() {
    _writeVec2( this.min, Infinity, Infinity );
    _writeVec2( this.max, -Infinity, -Infinity );
    return this;
  }

  isEmpty() {
    return _rx( this.max ) < _rx( this.min ) || _ry( this.max ) < _ry( this.min );
  }

  getCenter( target ) {
    if ( target === undefined ) target = _vec2();
    if ( this.isEmpty() ) return _writeVec2( target, 0, 0 );
    return _writeVec2(
      target,
      ( _rx( this.min ) + _rx( this.max ) ) * 0.5,
      ( _ry( this.min ) + _ry( this.max ) ) * 0.5
    );
  }

  getSize( target ) {
    if ( target === undefined ) target = _vec2();
    if ( this.isEmpty() ) return _writeVec2( target, 0, 0 );
    return _writeVec2(
      target,
      _rx( this.max ) - _rx( this.min ),
      _ry( this.max ) - _ry( this.min )
    );
  }

  expandByPoint( point ) {
    _writeVec2(
      this.min,
      Math.min( _rx( this.min ), _rx( point ) ),
      Math.min( _ry( this.min ), _ry( point ) )
    );
    _writeVec2(
      this.max,
      Math.max( _rx( this.max ), _rx( point ) ),
      Math.max( _ry( this.max ), _ry( point ) )
    );
    return this;
  }

  expandByVector( vector ) {
    _writeVec2( this.min, _rx( this.min ) - _rx( vector ), _ry( this.min ) - _ry( vector ) );
    _writeVec2( this.max, _rx( this.max ) + _rx( vector ), _ry( this.max ) + _ry( vector ) );
    return this;
  }

  expandByScalar( scalar ) {
    _writeVec2( this.min, _rx( this.min ) - scalar, _ry( this.min ) - scalar );
    _writeVec2( this.max, _rx( this.max ) + scalar, _ry( this.max ) + scalar );
    return this;
  }

  containsPoint( point ) {
    return _rx( point ) >= _rx( this.min ) && _rx( point ) <= _rx( this.max )
        && _ry( point ) >= _ry( this.min ) && _ry( point ) <= _ry( this.max );
  }

  containsBox( box ) {
    return _rx( box.min ) >= _rx( this.min ) && _rx( box.max ) <= _rx( this.max )
        && _ry( box.min ) >= _ry( this.min ) && _ry( box.max ) <= _ry( this.max );
  }

  getParameter( point, target ) {
    if ( target === undefined ) target = _vec2();
    return _writeVec2(
      target,
      ( _rx( point ) - _rx( this.min ) ) / ( _rx( this.max ) - _rx( this.min ) ),
      ( _ry( point ) - _ry( this.min ) ) / ( _ry( this.max ) - _ry( this.min ) )
    );
  }

  intersectsBox( box ) {
    return ! (
      _rx( box.max ) < _rx( this.min ) || _rx( box.min ) > _rx( this.max ) ||
      _ry( box.max ) < _ry( this.min ) || _ry( box.min ) > _ry( this.max )
    );
  }

  clampPoint( point, target ) {
    if ( target === undefined ) target = _vec2();
    return _writeVec2(
      target,
      clamp( _rx( point ), _rx( this.min ), _rx( this.max ) ),
      clamp( _ry( point ), _ry( this.min ), _ry( this.max ) )
    );
  }

  distanceToPoint( point ) {
    const cx = clamp( _rx( point ), _rx( this.min ), _rx( this.max ) );
    const cy = clamp( _ry( point ), _ry( this.min ), _ry( this.max ) );
    const dx = _rx( point ) - cx;
    const dy = _ry( point ) - cy;
    return Math.sqrt( dx * dx + dy * dy );
  }

  intersect( box ) {
    _writeVec2(
      this.min,
      Math.max( _rx( this.min ), _rx( box.min ) ),
      Math.max( _ry( this.min ), _ry( box.min ) )
    );
    _writeVec2(
      this.max,
      Math.min( _rx( this.max ), _rx( box.max ) ),
      Math.min( _ry( this.max ), _ry( box.max ) )
    );
    if ( this.isEmpty() ) this.makeEmpty();
    return this;
  }

  union( box ) {
    _writeVec2(
      this.min,
      Math.min( _rx( this.min ), _rx( box.min ) ),
      Math.min( _ry( this.min ), _ry( box.min ) )
    );
    _writeVec2(
      this.max,
      Math.max( _rx( this.max ), _rx( box.max ) ),
      Math.max( _ry( this.max ), _ry( box.max ) )
    );
    return this;
  }

  translate( offset ) {
    _writeVec2( this.min, _rx( this.min ) + _rx( offset ), _ry( this.min ) + _ry( offset ) );
    _writeVec2( this.max, _rx( this.max ) + _rx( offset ), _ry( this.max ) + _ry( offset ) );
    return this;
  }

  equals( box ) {
    return _rx( box.min ) === _rx( this.min ) && _ry( box.min ) === _ry( this.min )
        && _rx( box.max ) === _rx( this.max ) && _ry( box.max ) === _ry( this.max );
  }

  fromArray( array, offset = 0 ) {
    _writeVec2( this.min, array[ offset ],     array[ offset + 1 ] );
    _writeVec2( this.max, array[ offset + 2 ], array[ offset + 3 ] );
    return this;
  }

  toArray( array = [], offset = 0 ) {
    array[ offset ]     = _rx( this.min );
    array[ offset + 1 ] = _ry( this.min );
    array[ offset + 2 ] = _rx( this.max );
    array[ offset + 3 ] = _ry( this.max );
    return array;
  }

  // ────────────── pooled instances ──────────────

  static acquire() {
    return _localPool.length > 0 ? _localPool.pop() : new Box2();
  }

  static recycle( box ) {
    if ( box instanceof Box2 && _localPool.length < LOCAL_POOL_MAX ) {
      _writeVec2( box.min, Infinity, Infinity );
      _writeVec2( box.max, -Infinity, -Infinity );
      _localPool.push( box );
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// BRIDGE: THREE-style <-> flat array (gl-matrix-compatible layout)
// ═══════════════════════════════════════════════════════════════════

export function threeBox2FromGlMatrix( out, glMin, glMax ) {
  _writeVec2( out.min, glMin[ 0 ], glMin[ 1 ] );
  _writeVec2( out.max, glMax[ 0 ], glMax[ 1 ] );
  return out;
}

export function threeBox2FromGlMatrixPacked( out, glPacked ) {
  _writeVec2( out.min, glPacked[ 0 ], glPacked[ 1 ] );
  _writeVec2( out.max, glPacked[ 2 ], glPacked[ 3 ] );
  return out;
}

export function glMatrixBox2FromThree( outMin, outMax, threeBox ) {
  outMin[ 0 ] = _rx( threeBox.min );
  outMin[ 1 ] = _ry( threeBox.min );
  outMax[ 0 ] = _rx( threeBox.max );
  outMax[ 1 ] = _ry( threeBox.max );
  return threeBox;
}

export function glMatrixBox2PackedFromThree( outPacked, threeBox ) {
  outPacked[ 0 ] = _rx( threeBox.min );
  outPacked[ 1 ] = _ry( threeBox.min );
  outPacked[ 2 ] = _rx( threeBox.max );
  outPacked[ 3 ] = _ry( threeBox.max );
  return outPacked;
}

// ═══════════════════════════════════════════════════════════════════
// BRIDGE: THREE-style <-> bitECS SoA
// ═══════════════════════════════════════════════════════════════════

export function threeBox2FromBitecs( out, eid, store = Box2Component ) {
  _writeVec2( out.min, store.minX[ eid ], store.minY[ eid ] );
  _writeVec2( out.max, store.maxX[ eid ], store.maxY[ eid ] );
  return out;
}

export function bitecsBox2FromThree( eid, threeBox, store = Box2Component ) {
  store.minX[ eid ] = _rx( threeBox.min );
  store.minY[ eid ] = _ry( threeBox.min );
  store.maxX[ eid ] = _rx( threeBox.max );
  store.maxY[ eid ] = _ry( threeBox.max );
  return eid;
}

export function bitecsBox2FromGlMatrix( eid, glMin, glMax, store = Box2Component ) {
  store.minX[ eid ] = glMin[ 0 ];
  store.minY[ eid ] = glMin[ 1 ];
  store.maxX[ eid ] = glMax[ 0 ];
  store.maxY[ eid ] = glMax[ 1 ];
  return eid;
}

export function bitecsBox2FromGlMatrixPacked( eid, glPacked, store = Box2Component ) {
  store.minX[ eid ] = glPacked[ 0 ];
  store.minY[ eid ] = glPacked[ 1 ];
  store.maxX[ eid ] = glPacked[ 2 ];
  store.maxY[ eid ] = glPacked[ 3 ];
  return eid;
}

export function glMatrixBox2FromBitecs( outMin, outMax, eid, store = Box2Component ) {
  outMin[ 0 ] = store.minX[ eid ];
  outMin[ 1 ] = store.minY[ eid ];
  outMax[ 0 ] = store.maxX[ eid ];
  outMax[ 1 ] = store.maxY[ eid ];
  return eid;
}

export function glMatrixBox2PackedFromBitecs( outPacked, eid, store = Box2Component ) {
  outPacked[ 0 ] = store.minX[ eid ];
  outPacked[ 1 ] = store.minY[ eid ];
  outPacked[ 2 ] = store.maxX[ eid ];
  outPacked[ 3 ] = store.maxY[ eid ];
  return outPacked;
}

export function bitecsBox2CopyInto( eidOut, eidIn, storeIn = Box2Component, storeOut = storeIn ) {
  storeOut.minX[ eidOut ] = storeIn.minX[ eidIn ];
  storeOut.minY[ eidOut ] = storeIn.minY[ eidIn ];
  storeOut.maxX[ eidOut ] = storeIn.maxX[ eidIn ];
  storeOut.maxY[ eidOut ] = storeIn.maxY[ eidIn ];
  return eidOut;
}

export function threeBox2FromBitecsUnion( out, eidA, eidB, storeA = Box2Component, storeB = Box2Component ) {
  _writeVec2(
    out.min,
    Math.min( storeA.minX[ eidA ], storeB.minX[ eidB ] ),
    Math.min( storeA.minY[ eidA ], storeB.minY[ eidB ] )
  );
  _writeVec2(
    out.max,
    Math.max( storeA.maxX[ eidA ], storeB.maxX[ eidB ] ),
    Math.max( storeA.maxY[ eidA ], storeB.maxY[ eidB ] )
  );
  return out;
}

export function bitecsBox2UnionInto( eidOut, eidA, eidB, storeA = Box2Component, storeB = Box2Component, storeOut = storeA ) {
  storeOut.minX[ eidOut ] = Math.min( storeA.minX[ eidA ], storeB.minX[ eidB ] );
  storeOut.minY[ eidOut ] = Math.min( storeA.minY[ eidA ], storeB.minY[ eidB ] );
  storeOut.maxX[ eidOut ] = Math.max( storeA.maxX[ eidA ], storeB.maxX[ eidB ] );
  storeOut.maxY[ eidOut ] = Math.max( storeA.maxY[ eidA ], storeB.maxY[ eidB ] );
  return eidOut;
}

export function threeBox2FromBitecsIntersect( out, eidA, eidB, storeA = Box2Component, storeB = Box2Component ) {
  _writeVec2(
    out.min,
    Math.max( storeA.minX[ eidA ], storeB.minX[ eidB ] ),
    Math.max( storeA.minY[ eidA ], storeB.minY[ eidB ] )
  );
  _writeVec2(
    out.max,
    Math.min( storeA.maxX[ eidA ], storeB.maxX[ eidB ] ),
    Math.min( storeA.maxY[ eidA ], storeB.maxY[ eidB ] )
  );
  if ( out.isEmpty() ) out.makeEmpty();
  return out;
}

export function bitecsBox2IntersectInto( eidOut, eidA, eidB, storeA = Box2Component, storeB = Box2Component, storeOut = storeA ) {
  const minX = Math.max( storeA.minX[ eidA ], storeB.minX[ eidB ] );
  const minY = Math.max( storeA.minY[ eidA ], storeB.minY[ eidB ] );
  const maxX = Math.min( storeA.maxX[ eidA ], storeB.maxX[ eidB ] );
  const maxY = Math.min( storeA.maxY[ eidA ], storeB.maxY[ eidB ] );
  if ( minX > maxX || minY > maxY ) {
    storeOut.minX[ eidOut ] = Infinity;
    storeOut.minY[ eidOut ] = Infinity;
    storeOut.maxX[ eidOut ] = -Infinity;
    storeOut.maxY[ eidOut ] = -Infinity;
  } else {
    storeOut.minX[ eidOut ] = minX;
    storeOut.minY[ eidOut ] = minY;
    storeOut.maxX[ eidOut ] = maxX;
    storeOut.maxY[ eidOut ] = maxY;
  }
  return eidOut;
}

export function bitecsBox2ExpandByPointInPlace( eidBox, eidPoint, storeBox = Box2Component, storePoint ) {
  storeBox.minX[ eidBox ] = Math.min( storeBox.minX[ eidBox ], storePoint.x[ eidPoint ] );
  storeBox.minY[ eidBox ] = Math.min( storeBox.minY[ eidBox ], storePoint.y[ eidPoint ] );
  storeBox.maxX[ eidBox ] = Math.max( storeBox.maxX[ eidBox ], storePoint.x[ eidPoint ] );
  storeBox.maxY[ eidBox ] = Math.max( storeBox.maxY[ eidBox ], storePoint.y[ eidPoint ] );
  return eidBox;
}

export function bitecsBox2ExpandByVectorInPlace( eidBox, eidVector, storeBox = Box2Component, storeVector ) {
  storeBox.minX[ eidBox ] -= storeVector.x[ eidVector ];
  storeBox.minY[ eidBox ] -= storeVector.y[ eidVector ];
  storeBox.maxX[ eidBox ] += storeVector.x[ eidVector ];
  storeBox.maxY[ eidBox ] += storeVector.y[ eidVector ];
  return eidBox;
}

export function bitecsBox2ExpandByScalarInPlace( eid, scalar, store = Box2Component ) {
  store.minX[ eid ] -= scalar;
  store.minY[ eid ] -= scalar;
  store.maxX[ eid ] += scalar;
  store.maxY[ eid ] += scalar;
  return eid;
}

export function bitecsBox2ContainsPoint( eidBox, eidPoint, storeBox = Box2Component, storePoint ) {
  return storePoint.x[ eidPoint ] >= storeBox.minX[ eidBox ] && storePoint.x[ eidPoint ] <= storeBox.maxX[ eidBox ]
      && storePoint.y[ eidPoint ] >= storeBox.minY[ eidBox ] && storePoint.y[ eidPoint ] <= storeBox.maxY[ eidBox ];
}

export function bitecsBox2ContainsBox( eidOuter, eidInner, storeOuter = Box2Component, storeInner = Box2Component ) {
  return storeInner.minX[ eidInner ] >= storeOuter.minX[ eidOuter ]
      && storeInner.maxX[ eidInner ] <= storeOuter.maxX[ eidOuter ]
      && storeInner.minY[ eidInner ] >= storeOuter.minY[ eidOuter ]
      && storeInner.maxY[ eidInner ] <= storeOuter.maxY[ eidOuter ];
}

export function bitecsBox2IntersectsBox( eidA, eidB, storeA = Box2Component, storeB = Box2Component ) {
  return ! (
    storeB.minX[ eidB ] > storeA.maxX[ eidA ] || storeB.maxX[ eidB ] < storeA.minX[ eidA ] ||
    storeB.minY[ eidB ] > storeA.maxY[ eidA ] || storeB.maxY[ eidB ] < storeA.minY[ eidA ]
  );
}

export function threeVec2FromBitecsBox2ClampPoint( out, eidBox, eidPoint, storeBox = Box2Component, storePoint ) {
  return _writeVec2(
    out,
    clamp( storePoint.x[ eidPoint ], storeBox.minX[ eidBox ], storeBox.maxX[ eidBox ] ),
    clamp( storePoint.y[ eidPoint ], storeBox.minY[ eidBox ], storeBox.maxY[ eidBox ] )
  );
}

export function bitecsVec2Box2ClampPointInto( eidOutVec, eidBox, eidPoint, storeBox = Box2Component, storePoint, storeVec ) {
  storeVec.x[ eidOutVec ] = clamp( storePoint.x[ eidPoint ], storeBox.minX[ eidBox ], storeBox.maxX[ eidBox ] );
  storeVec.y[ eidOutVec ] = clamp( storePoint.y[ eidPoint ], storeBox.minY[ eidBox ], storeBox.maxY[ eidBox ] );
  return eidOutVec;
}

export function bitecsBox2DistanceToPoint( eidBox, eidPoint, storeBox = Box2Component, storePoint ) {
  const dx = Math.max( storeBox.minX[ eidBox ] - storePoint.x[ eidPoint ], 0, storePoint.x[ eidPoint ] - storeBox.maxX[ eidBox ] );
  const dy = Math.max( storeBox.minY[ eidBox ] - storePoint.y[ eidPoint ], 0, storePoint.y[ eidPoint ] - storeBox.maxY[ eidBox ] );
  return Math.sqrt( dx * dx + dy * dy );
}

export function threeVec2FromBitecsBox2Center( out, eid, store = Box2Component ) {
  return _writeVec2(
    out,
    ( store.minX[ eid ] + store.maxX[ eid ] ) * 0.5,
    ( store.minY[ eid ] + store.maxY[ eid ] ) * 0.5
  );
}

export function bitecsVec2Box2CenterInto( eidOutVec, eidBox, storeBox = Box2Component, storeVec ) {
  storeVec.x[ eidOutVec ] = ( storeBox.minX[ eidBox ] + storeBox.maxX[ eidBox ] ) * 0.5;
  storeVec.y[ eidOutVec ] = ( storeBox.minY[ eidBox ] + storeBox.maxY[ eidBox ] ) * 0.5;
  return eidOutVec;
}

export function threeVec2FromBitecsBox2Size( out, eid, store = Box2Component ) {
  return _writeVec2(
    out,
    store.maxX[ eid ] - store.minX[ eid ],
    store.maxY[ eid ] - store.minY[ eid ]
  );
}

export function bitecsVec2Box2SizeInto( eidOutVec, eidBox, storeBox = Box2Component, storeVec ) {
  storeVec.x[ eidOutVec ] = storeBox.maxX[ eidBox ] - storeBox.minX[ eidBox ];
  storeVec.y[ eidOutVec ] = storeBox.maxY[ eidBox ] - storeBox.minY[ eidBox ];
  return eidOutVec;
}

export function threeVec2FromBitecsBox2Parameter( out, eidBox, eidPoint, storeBox = Box2Component, storePoint ) {
  return _writeVec2(
    out,
    ( storePoint.x[ eidPoint ] - storeBox.minX[ eidBox ] ) / ( storeBox.maxX[ eidBox ] - storeBox.minX[ eidBox ] ),
    ( storePoint.y[ eidPoint ] - storeBox.minY[ eidBox ] ) / ( storeBox.maxY[ eidBox ] - storeBox.minY[ eidBox ] )
  );
}

export function bitecsVec2Box2ParameterInto( eidOutVec, eidBox, eidPoint, storeBox = Box2Component, storePoint, storeVec ) {
  storeVec.x[ eidOutVec ] = ( storePoint.x[ eidPoint ] - storeBox.minX[ eidBox ] ) / ( storeBox.maxX[ eidBox ] - storeBox.minX[ eidBox ] );
  storeVec.y[ eidOutVec ] = ( storePoint.y[ eidPoint ] - storeBox.minY[ eidBox ] ) / ( storeBox.maxY[ eidBox ] - storeBox.minY[ eidBox ] );
  return eidOutVec;
}

export function bitecsBox2TranslateInPlace( eid, eidOffset, storeBox = Box2Component, storeOffset ) {
  const ox = storeOffset.x[ eidOffset ];
  const oy = storeOffset.y[ eidOffset ];
  storeBox.minX[ eid ] += ox;
  storeBox.minY[ eid ] += oy;
  storeBox.maxX[ eid ] += ox;
  storeBox.maxY[ eid ] += oy;
  return eid;
}

export function bitecsBox2IsEmpty( eid, store = Box2Component ) {
  return store.maxX[ eid ] < store.minX[ eid ] || store.maxY[ eid ] < store.minY[ eid ];
}

export function bitecsBox2MakeEmptyInPlace( eid, store = Box2Component ) {
  store.minX[ eid ] = Infinity;
  store.minY[ eid ] = Infinity;
  store.maxX[ eid ] = -Infinity;
  store.maxY[ eid ] = -Infinity;
  return eid;
}

// ────────────── flat-array helpers on top of bitecs ──────────────

export function glMatrixBox2PackedUnionFromBitecs( outPacked, eidA, eidB, storeA = Box2Component, storeB = Box2Component ) {
  outPacked[ 0 ] = Math.min( storeA.minX[ eidA ], storeB.minX[ eidB ] );
  outPacked[ 1 ] = Math.min( storeA.minY[ eidA ], storeB.minY[ eidB ] );
  outPacked[ 2 ] = Math.max( storeA.maxX[ eidA ], storeB.maxX[ eidB ] );
  outPacked[ 3 ] = Math.max( storeA.maxY[ eidA ], storeB.maxY[ eidB ] );
  return outPacked;
}

export function glMatrixBox2PackedIntersectFromBitecs( outPacked, eidA, eidB, storeA = Box2Component, storeB = Box2Component ) {
  outPacked[ 0 ] = Math.max( storeA.minX[ eidA ], storeB.minX[ eidB ] );
  outPacked[ 1 ] = Math.max( storeA.minY[ eidA ], storeB.minY[ eidB ] );
  outPacked[ 2 ] = Math.min( storeA.maxX[ eidA ], storeB.maxX[ eidB ] );
  outPacked[ 3 ] = Math.min( storeA.maxY[ eidA ], storeB.maxY[ eidB ] );
  return outPacked;
}

export function glMatrixVec2DistanceToBitecsBox2( glPoint, eid, store = Box2Component ) {
  const cx = clamp( glPoint[ 0 ], store.minX[ eid ], store.maxX[ eid ] );
  const cy = clamp( glPoint[ 1 ], store.minY[ eid ], store.maxY[ eid ] );
  const dx = glPoint[ 0 ] - cx;
  const dy = glPoint[ 1 ] - cy;
  return Math.sqrt( dx * dx + dy * dy );
}

export function glMatrixVec2InsideBitecsBox2( glPoint, eid, store = Box2Component ) {
  return glPoint[ 0 ] >= store.minX[ eid ] && glPoint[ 0 ] <= store.maxX[ eid ]
      && glPoint[ 1 ] >= store.minY[ eid ] && glPoint[ 1 ] <= store.maxY[ eid ];
}

export function glMatrixVec2MinFromBitecsBox2( out, eidA, eidB, storeA = Box2Component, storeB = Box2Component ) {
  _scratchVec2A[ 0 ] = storeA.minX[ eidA ];
  _scratchVec2A[ 1 ] = storeA.minY[ eidA ];
  _scratchVec2B[ 0 ] = storeB.minX[ eidB ];
  _scratchVec2B[ 1 ] = storeB.minY[ eidB ];
  out[ 0 ] = Math.min( _scratchVec2A[ 0 ], _scratchVec2B[ 0 ] );
  out[ 1 ] = Math.min( _scratchVec2A[ 1 ], _scratchVec2B[ 1 ] );
  return out;
}

export function glMatrixVec2MaxFromBitecsBox2( out, eidA, eidB, storeA = Box2Component, storeB = Box2Component ) {
  _scratchVec2A[ 0 ] = storeA.maxX[ eidA ];
  _scratchVec2A[ 1 ] = storeA.maxY[ eidA ];
  _scratchVec2B[ 0 ] = storeB.maxX[ eidB ];
  _scratchVec2B[ 1 ] = storeB.maxY[ eidB ];
  out[ 0 ] = Math.max( _scratchVec2A[ 0 ], _scratchVec2B[ 0 ] );
  out[ 1 ] = Math.max( _scratchVec2A[ 1 ], _scratchVec2B[ 1 ] );
  return out;
}

export function glMatrixVec2LerpFromBitecsBox2( out, eidA, eidB, t, storeA, storeB ) {
  _scratchVec2A[ 0 ] = storeA.x[ eidA ];
  _scratchVec2A[ 1 ] = storeA.y[ eidA ];
  _scratchVec2B[ 0 ] = storeB.x[ eidB ];
  _scratchVec2B[ 1 ] = storeB.y[ eidB ];
  out[ 0 ] = _scratchVec2A[ 0 ] + t * ( _scratchVec2B[ 0 ] - _scratchVec2A[ 0 ] );
  out[ 1 ] = _scratchVec2A[ 1 ] + t * ( _scratchVec2B[ 1 ] - _scratchVec2A[ 1 ] );
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// HIGH-PRECISION (DoubleDouble) HELPERS — galactic-scale 2D coordinates
// ═══════════════════════════════════════════════════════════════════

export function preciseArea( box ) {
  const dx = DD.subtract( DD.fromDouble( _rx( box.max ) ), DD.fromDouble( _rx( box.min ) ) );
  const dy = DD.subtract( DD.fromDouble( _ry( box.max ) ), DD.fromDouble( _ry( box.min ) ) );
  return DD.toDouble( DD.multiply( dx, dy ) );
}

export function preciseDistanceToPoint( box, point ) {
  const px = DD.fromDouble( _rx( point ) );
  const py = DD.fromDouble( _ry( point ) );
  const minX = DD.fromDouble( _rx( box.min ) ), maxX = DD.fromDouble( _rx( box.max ) );
  const minY = DD.fromDouble( _ry( box.min ) ), maxY = DD.fromDouble( _ry( box.max ) );

  let dx = [ 0, 0 ];
  let dy = [ 0, 0 ];

  const dxLow = DD.subtract( minX, px );
  const dxHigh = DD.subtract( px, maxX );
  if ( DD.toDouble( dxLow ) > 0 ) dx = dxLow;
  else if ( DD.toDouble( dxHigh ) > 0 ) dx = dxHigh;

  const dyLow = DD.subtract( minY, py );
  const dyHigh = DD.subtract( py, maxY );
  if ( DD.toDouble( dyLow ) > 0 ) dy = dyLow;
  else if ( DD.toDouble( dyHigh ) > 0 ) dy = dyHigh;

  return DD.toDouble(
    DD.sqrt( DD.add( DD.multiply( dx, dx ), DD.multiply( dy, dy ) ) )
  );
}

export function preciseUnionInto( out, a, b ) {
  const aMinX = DD.fromDouble( _rx( a.min ) ), bMinX = DD.fromDouble( _rx( b.min ) );
  const aMinY = DD.fromDouble( _ry( a.min ) ), bMinY = DD.fromDouble( _ry( b.min ) );
  const aMaxX = DD.fromDouble( _rx( a.max ) ), bMaxX = DD.fromDouble( _rx( b.max ) );
  const aMaxY = DD.fromDouble( _ry( a.max ) ), bMaxY = DD.fromDouble( _ry( b.max ) );
  _writeVec2(
    out.min,
    DD.toDouble( aMinX ) < DD.toDouble( bMinX ) ? _rx( a.min ) : _rx( b.min ),
    DD.toDouble( aMinY ) < DD.toDouble( bMinY ) ? _ry( a.min ) : _ry( b.min )
  );
  _writeVec2(
    out.max,
    DD.toDouble( aMaxX ) > DD.toDouble( bMaxX ) ? _rx( a.max ) : _rx( b.max ),
    DD.toDouble( aMaxY ) > DD.toDouble( bMaxY ) ? _ry( a.max ) : _ry( b.max )
  );
  return out;
}

export function preciseIntersectInto( out, a, b ) {
  const minX = DD.toDouble( DD.fromDouble( _rx( a.min ) ) ) > DD.toDouble( DD.fromDouble( _rx( b.min ) ) ) ? _rx( a.min ) : _rx( b.min );
  const minY = DD.toDouble( DD.fromDouble( _ry( a.min ) ) ) > DD.toDouble( DD.fromDouble( _ry( b.min ) ) ) ? _ry( a.min ) : _ry( b.min );
  const maxX = DD.toDouble( DD.fromDouble( _rx( a.max ) ) ) < DD.toDouble( DD.fromDouble( _rx( b.max ) ) ) ? _rx( a.max ) : _rx( b.max );
  const maxY = DD.toDouble( DD.fromDouble( _ry( a.max ) ) ) < DD.toDouble( DD.fromDouble( _ry( b.max ) ) ) ? _ry( a.max ) : _ry( b.max );
  if ( minX > maxX || minY > maxY ) {
    out.makeEmpty();
  } else {
    _writeVec2( out.min, minX, minY );
    _writeVec2( out.max, maxX, maxY );
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// PROCEDURAL NOISE — random box from a 3D simplex field
// ═══════════════════════════════════════════════════════════════════

export function setFromNoise3D( out, x, y, z, seed = 0, centerScale = 1, sizeScale = 1 ) {
  const n = _cachedNoise3D( seed );
  const cx = n( x, y, z ) * centerScale;
  const cy = n( x + 31.416, y + 47.853, z + 12.793 ) * centerScale;
  const sx = Math.abs( n( x + 100.1, y + 200.2, z + 300.3 ) ) * sizeScale;
  const sy = Math.abs( n( x - 110.5, y - 210.6, z - 310.7 ) ) * sizeScale;
  _writeVec2( out.min, cx - sx, cy - sy );
  _writeVec2( out.max, cx + sx, cy + sy );
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// Named + default exports
// ═══════════════════════════════════════════════════════════════════
export { Box2 };
export default Box2;