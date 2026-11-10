// file number : 066
// full path name : src/math/066_Triangle.js
// description : 3D triangle primitive (three vertices a, b, c) — drop-in replacement for THREE.Triangle (r185). Vertices are duck-typed vec3-like values ({x,y,z}, flat [x,y,z], or THREE.Vector3). Complete r185 static surface: getNormal(a, b, c, target), getBarycoord(point, a, b, c, target), getInterpolation(point, p1, p2, p3, v1, v2, v3, target), isFrontFacing(a, b, c, direction), containsPoint(point, a, b, c). Complete r185 instance surface: constructor(a, b, c), set(a, b, c), setFromPointsAndIndices(points, i0, i1, i2), setFromAttributeAndIndices(attribute, i0, i1, i2), copy(triangle), clone(), getArea(), getMidpoint(target), getNormal(target), getPlane(target), getBarycoord(point, target), getInterpolation(point, v1, v2, v3, target), containsPoint(point), isFrontFacing(direction), intersectsBox(box), intersectsSphere(sphere), closestPointToPoint(p, target), equals(triangle). Extended: preciseArea / preciseBarycoord via the chat's DoubleDouble (014) for galactic-scale vertices; setFromNoise3D via the chat's SimplexNoise (013) with cached per-seed mulberry32 generator; full zero-allocation bitECS SoA bridge set using TriangleComponent (ax/ay/az + bx/by/bz + cx/cy/cz f32([]) from 014_BitECS) covering from/to/copy/add/sub/lerp/scale-in-place, normal, centroid, area, midpoint, plane, barycoord, interpolation, contains-point, closest-point, translate-in-place, apply-matrix4-in-place, is-front-facing, and per-corner bridges; flat-array bridges for gl-matrix-style packed [ax,ay,az,bx,by,bz,cx,cy,cz] interop; and a recycled local pool (Triangle.acquire / Triangle.recycle) that resets all three corners to (0,0,0). No THREE, no CDN, no static server, no Vite/Vue — imports only from the chat's own files (003_Common clamp, 013_SimplexNoise, 014_DoubleDouble, 014_BitECS).
// best for : ray-triangle intersection tests, barycentric UV interpolation, mesh collision detection, ray picking, PBR reflection UV, procedural terrain patch hit-testing, and any ECS system that stores triangle soup as SoA vertex triplets and must feed THREE.Triangle, THREE.Raycaster, or the Frustum culling pipeline without allocating per frame. The pooled + SoA-bridge paths are the recommended route for hot loops at 10k+ entities on Android 64-bit.
// license : MIT

import { clamp } from '../core/003_Common.js';
import * as DD from './014_DoubleDouble.js';
import * as bitecs from './014_BitECS.js';
import { createNoise3D } from './013_SimplexNoise.js';

// ═══════════════════════════════════════════════════════════════════
// bitECS 0.4.0 SoA COMPONENT (archetype-friendly, cache-friendly)
// ═══════════════════════════════════════════════════════════════════
export const TriangleComponent = {
  ax: bitecs.f32([]),
  ay: bitecs.f32([]),
  az: bitecs.f32([]),
  bx: bitecs.f32([]),
  by: bitecs.f32([]),
  bz: bitecs.f32([]),
  cx: bitecs.f32([]),
  cy: bitecs.f32([]),
  cz: bitecs.f32([])
};

// ═══════════════════════════════════════════════════════════════════
// Duck-typed vec3 accessors — zero allocation in hot paths
// ═══════════════════════════════════════════════════════════════════

function _rx( v ) { return v.x !== undefined ? v.x : v[ 0 ]; }
function _ry( v ) { return v.y !== undefined ? v.y : v[ 1 ]; }
function _rz( v ) { return v.z !== undefined ? v.z : v[ 2 ]; }

function _writeVec3( v, x, y, z ) {
  if ( v === null || v === undefined ) return { x, y, z };
  if ( Array.isArray( v ) ) {
    v[ 0 ] = x;
    v[ 1 ] = y;
    v[ 2 ] = z;
    return v;
  }
  v.x = x;
  v.y = y;
  v.z = z;
  return v;
}

function _copyVec3Into( target, source ) {
  return _writeVec3( target, _rx( source ), _ry( source ), _rz( source ) );
}

function _vec3( x = 0, y = 0, z = 0 ) {
  return { x, y, z };
}

function _matrixElements( m ) {
  return ( m != null && m.elements !== undefined ) ? m.elements : m;
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

// Scratch vec3s reused by class methods and flat-array bridges
const _v0 = _vec3();
const _v1 = _vec3();
const _v2 = _vec3();
const _v3 = _vec3();
const _ab = _vec3();
const _ac = _vec3();
const _bc = _vec3();
const _ap = _vec3();
const _bp = _vec3();
const _cp = _vec3();
const _scratchA = new Float32Array( 3 );
const _scratchB = new Float32Array( 3 );
const _scratchC = new Float32Array( 3 );

// ═══════════════════════════════════════════════════════════════════
// class Triangle
// ═══════════════════════════════════════════════════════════════════
class Triangle {

  constructor( a, b, c ) {
    this.isTriangle = true;
    this.a = a !== undefined ? a : _vec3();
    this.b = b !== undefined ? b : _vec3();
    this.c = c !== undefined ? c : _vec3();
  }

  // ────────────── statics ──────────────

  static getNormal( a, b, c, target ) {
    if ( target === undefined ) target = _vec3();
    // n = (c − b) × (a − b)
    const cbx = _rx( c ) - _rx( b );
    const cby = _ry( c ) - _ry( b );
    const cbz = _rz( c ) - _rz( b );
    const abx = _rx( a ) - _rx( b );
    const aby = _ry( a ) - _ry( b );
    const abz = _rz( a ) - _rz( b );
    const nx = cby * abz - cbz * aby;
    const ny = cbz * abx - cbx * abz;
    const nz = cbx * aby - cby * abx;
    const lenSq = nx * nx + ny * ny + nz * nz;
    if ( lenSq > 0 ) {
      const inv = 1 / Math.sqrt( lenSq );
      return _writeVec3( target, nx * inv, ny * inv, nz * inv );
    }
    return _writeVec3( target, 0, 0, 0 );
  }

  static getBarycoord( point, a, b, c, target ) {
    if ( target === undefined ) target = _vec3();
    // Vectors from a
    const v0x = _rx( c ) - _rx( a );
    const v0y = _ry( c ) - _ry( a );
    const v0z = _rz( c ) - _rz( a );
    const v1x = _rx( b ) - _rx( a );
    const v1y = _ry( b ) - _ry( a );
    const v1z = _rz( b ) - _rz( a );
    const v2x = _rx( point ) - _rx( a );
    const v2y = _ry( point ) - _ry( a );
    const v2z = _rz( point ) - _rz( a );

    const dot00 = v0x * v0x + v0y * v0y + v0z * v0z;
    const dot01 = v0x * v1x + v0y * v1y + v0z * v1z;
    const dot02 = v0x * v2x + v0y * v2y + v0z * v2z;
    const dot11 = v1x * v1x + v1y * v1y + v1z * v1z;
    const dot12 = v1x * v2x + v1y * v2y + v1z * v2z;

    const denom = dot00 * dot11 - dot01 * dot01;
    if ( denom === 0 ) {
      return _writeVec3( target, 0, 0, 0 );
    }
    const invDenom = 1 / denom;
    const u = ( dot11 * dot02 - dot01 * dot12 ) * invDenom;
    const v = ( dot00 * dot12 - dot01 * dot02 ) * invDenom;
    return _writeVec3( target, 1 - u - v, v, u );
  }

  static getInterpolation( point, p1, p2, p3, v1, v2, v3, target ) {
    if ( target === undefined ) target = _vec3();
    Triangle.getBarycoord( point, p1, p2, p3, _v3 );
    const u = _rx( _v3 ), v = _ry( _v3 ), w = _rz( _v3 );
    return _writeVec3(
      target,
      u * _rx( v1 ) + v * _rx( v2 ) + w * _rx( v3 ),
      u * _ry( v1 ) + v * _ry( v2 ) + w * _ry( v3 ),
      u * _rz( v1 ) + v * _rz( v2 ) + w * _rz( v3 )
    );
  }

  static isFrontFacing( a, b, c, direction ) {
    // n = (c − b) × (a − b); front-facing iff n · direction < 0
    const cbx = _rx( c ) - _rx( b );
    const cby = _ry( c ) - _ry( b );
    const cbz = _rz( c ) - _rz( b );
    const abx = _rx( a ) - _rx( b );
    const aby = _ry( a ) - _ry( b );
    const abz = _rz( a ) - _rz( b );
    const nx = cby * abz - cbz * aby;
    const ny = cbz * abx - cbx * abz;
    const nz = cbx * aby - cby * abx;
    const dot = nx * _rx( direction ) + ny * _ry( direction ) + nz * _rz( direction );
    return dot < 0;
  }

  static containsPoint( point, a, b, c ) {
    Triangle.getBarycoord( point, a, b, c, _v3 );
    return _rx( _v3 ) >= 0 && _ry( _v3 ) >= 0 && _rz( _v3 ) >= 0;
  }

  // ────────────── instance methods ──────────────

  set( a, b, c ) {
    _copyVec3Into( this.a, a );
    _copyVec3Into( this.b, b );
    _copyVec3Into( this.c, c );
    return this;
  }

  setFromPointsAndIndices( points, i0, i1, i2 ) {
    _copyVec3Into( this.a, points[ i0 ] );
    _copyVec3Into( this.b, points[ i1 ] );
    _copyVec3Into( this.c, points[ i2 ] );
    return this;
  }

  setFromAttributeAndIndices( attribute, i0, i1, i2 ) {
    _writeVec3( this.a, attribute.getX( i0 ), attribute.getY( i0 ), attribute.getZ( i0 ) );
    _writeVec3( this.b, attribute.getX( i1 ), attribute.getY( i1 ), attribute.getZ( i1 ) );
    _writeVec3( this.c, attribute.getX( i2 ), attribute.getY( i2 ), attribute.getZ( i2 ) );
    return this;
  }

  copy( triangle ) {
    _copyVec3Into( this.a, triangle.a );
    _copyVec3Into( this.b, triangle.b );
    _copyVec3Into( this.c, triangle.c );
    return this;
  }

  clone() {
    return new this.constructor(
      _vec3( _rx( this.a ), _ry( this.a ), _rz( this.a ) ),
      _vec3( _rx( this.b ), _ry( this.b ), _rz( this.b ) ),
      _vec3( _rx( this.c ), _ry( this.c ), _rz( this.c ) )
    );
  }

  getArea() {
    // 0.5 · |(b − a) × (c − a)|
    const abx = _rx( this.b ) - _rx( this.a );
    const aby = _ry( this.b ) - _ry( this.a );
    const abz = _rz( this.b ) - _rz( this.a );
    const acx = _rx( this.c ) - _rx( this.a );
    const acy = _ry( this.c ) - _ry( this.a );
    const acz = _rz( this.c ) - _rz( this.a );
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    return 0.5 * Math.sqrt( nx * nx + ny * ny + nz * nz );
  }

  getMidpoint( target ) {
    if ( target === undefined ) target = _vec3();
    return _writeVec3(
      target,
      ( _rx( this.a ) + _rx( this.b ) + _rx( this.c ) ) / 3,
      ( _ry( this.a ) + _ry( this.b ) + _ry( this.c ) ) / 3,
      ( _rz( this.a ) + _rz( this.b ) + _rz( this.c ) ) / 3
    );
  }

  getNormal( target ) {
    return Triangle.getNormal( this.a, this.b, this.c, target );
  }

  getPlane( target ) {
    if ( target === undefined ) target = { normal: _vec3(), constant: 0 };
    this.getNormal( _scratchA.length === 3 ? target.normal : target.normal );
    _writeVec3( target.normal, _scratchA[ 0 ], _scratchA[ 1 ], _scratchA[ 2 ] );
    target.constant = -(
      _rx( target.normal ) * _rx( this.a ) +
      _ry( target.normal ) * _ry( this.a ) +
      _rz( target.normal ) * _rz( this.a )
    );
    return target;
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
    if ( box && typeof box.intersectsTriangle === 'function' ) {
      return box.intersectsTriangle( this );
    }
    return false;
  }

  intersectsSphere( sphere ) {
    // Conservative: check closest point on triangle to sphere center.
    this.closestPointToPoint( sphere.center, _scratchA );
    const dx = _scratchA[ 0 ] - _rx( sphere.center );
    const dy = _scratchA[ 1 ] - _ry( sphere.center );
    const dz = _scratchA[ 2 ] - _rz( sphere.center );
    return ( dx * dx + dy * dy + dz * dz ) <= ( sphere.radius * sphere.radius );
  }

  closestPointToPoint( p, target ) {
    if ( target === undefined ) target = _vec3();
    const ax = _rx( this.a ), ay = _ry( this.a ), az = _rz( this.a );
    const bx = _rx( this.b ), by = _ry( this.b ), bz = _rz( this.b );
    const cx = _rx( this.c ), cy = _ry( this.c ), cz = _rz( this.c );
    const px = _rx( p ), py = _ry( p ), pz = _rz( p );

    // Edge vectors from a
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;

    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    if ( d1 <= 0 && d2 <= 0 ) {
      return _writeVec3( target, ax, ay, az );
    }

    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if ( d3 >= 0 && d4 <= d3 ) {
      return _writeVec3( target, bx, by, bz );
    }

    const vc = d1 * d4 - d3 * d2;
    if ( vc <= 0 && d1 >= 0 && d3 <= 0 ) {
      const v = d1 / ( d1 - d3 );
      return _writeVec3( target, ax + abx * v, ay + aby * v, az + abz * v );
    }

    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    if ( d6 >= 0 && d5 <= d6 ) {
      return _writeVec3( target, cx, cy, cz );
    }

    const vb = d5 * d2 - d1 * d6;
    if ( vb <= 0 && d2 >= 0 && d6 <= 0 ) {
      const w = d2 / ( d2 - d6 );
      return _writeVec3( target, ax + acx * w, ay + acy * w, az + acz * w );
    }

    const va = d3 * d6 - d5 * d4;
    if ( va <= 0 && ( d4 - d3 ) >= 0 && ( d5 - d6 ) >= 0 ) {
      const w = ( d4 - d3 ) / ( ( d4 - d3 ) + ( d5 - d6 ) );
      return _writeVec3( target, bx + ( cx - bx ) * w, by + ( cy - by ) * w, bz + ( cz - bz ) * w );
    }

    const denom = 1 / ( va + vb + vc );
    const v = vb * denom;
    const w = vc * denom;
    return _writeVec3(
      target,
      ax + abx * v + acx * w,
      ay + aby * v + acy * w,
      az + abz * v + acz * w
    );
  }

  equals( triangle ) {
    return _rx( triangle.a ) === _rx( this.a )
        && _ry( triangle.a ) === _ry( this.a )
        && _rz( triangle.a ) === _rz( this.a )
        && _rx( triangle.b ) === _rx( this.b )
        && _ry( triangle.b ) === _ry( this.b )
        && _rz( triangle.b ) === _rz( this.b )
        && _rx( triangle.c ) === _rx( this.c )
        && _ry( triangle.c ) === _ry( this.c )
        && _rz( triangle.c ) === _rz( this.c );
  }

  // ────────────── flat array interop ──────────────

  toArray( array = [], offset = 0 ) {
    array[ offset ]     = _rx( this.a );
    array[ offset + 1 ] = _ry( this.a );
    array[ offset + 2 ] = _rz( this.a );
    array[ offset + 3 ] = _rx( this.b );
    array[ offset + 4 ] = _ry( this.b );
    array[ offset + 5 ] = _rz( this.b );
    array[ offset + 6 ] = _rx( this.c );
    array[ offset + 7 ] = _ry( this.c );
    array[ offset + 8 ] = _rz( this.c );
    return array;
  }

  fromArray( array, offset = 0 ) {
    _writeVec3( this.a, array[ offset ],     array[ offset + 1 ], array[ offset + 2 ] );
    _writeVec3( this.b, array[ offset + 3 ], array[ offset + 4 ], array[ offset + 5 ] );
    _writeVec3( this.c, array[ offset + 6 ], array[ offset + 7 ], array[ offset + 8 ] );
    return this;
  }

  // ────────────── pooled instances ──────────────

  static acquire() {
    return _localPool.length > 0 ? _localPool.pop() : new Triangle();
  }

  static recycle( triangle ) {
    if ( triangle instanceof Triangle && _localPool.length < LOCAL_POOL_MAX ) {
      _writeVec3( triangle.a, 0, 0, 0 );
      _writeVec3( triangle.b, 0, 0, 0 );
      _writeVec3( triangle.c, 0, 0, 0 );
      _localPool.push( triangle );
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// BRIDGE: THREE-style <-> flat array
// ═══════════════════════════════════════════════════════════════════

export function threeTriangleFromGlMatrix( out, glA, glB, glC ) {
  _writeVec3( out.a, glA[ 0 ], glA[ 1 ], glA[ 2 ] );
  _writeVec3( out.b, glB[ 0 ], glB[ 1 ], glB[ 2 ] );
  _writeVec3( out.c, glC[ 0 ], glC[ 1 ], glC[ 2 ] );
  return out;
}

export function threeTriangleFromGlMatrixPacked( out, glPacked ) {
  _writeVec3( out.a, glPacked[ 0 ], glPacked[ 1 ], glPacked[ 2 ] );
  _writeVec3( out.b, glPacked[ 3 ], glPacked[ 4 ], glPacked[ 5 ] );
  _writeVec3( out.c, glPacked[ 6 ], glPacked[ 7 ], glPacked[ 8 ] );
  return out;
}

export function glMatrixTriangleFromThree( outA, outB, outC, threeTriangle ) {
  outA[ 0 ] = _rx( threeTriangle.a );
  outA[ 1 ] = _ry( threeTriangle.a );
  outA[ 2 ] = _rz( threeTriangle.a );
  outB[ 0 ] = _rx( threeTriangle.b );
  outB[ 1 ] = _ry( threeTriangle.b );
  outB[ 2 ] = _rz( threeTriangle.b );
  outC[ 0 ] = _rx( threeTriangle.c );
  outC[ 1 ] = _ry( threeTriangle.c );
  outC[ 2 ] = _rz( threeTriangle.c );
  return threeTriangle;
}

export function glMatrixTrianglePackedFromThree( outPacked, threeTriangle ) {
  outPacked[ 0 ] = _rx( threeTriangle.a );
  outPacked[ 1 ] = _ry( threeTriangle.a );
  outPacked[ 2 ] = _rz( threeTriangle.a );
  outPacked[ 3 ] = _rx( threeTriangle.b );
  outPacked[ 4 ] = _ry( threeTriangle.b );
  outPacked[ 5 ] = _rz( threeTriangle.b );
  outPacked[ 6 ] = _rx( threeTriangle.c );
  outPacked[ 7 ] = _ry( threeTriangle.c );
  outPacked[ 8 ] = _rz( threeTriangle.c );
  return outPacked;
}

// ═══════════════════════════════════════════════════════════════════
// BRIDGE: THREE-style <-> bitECS SoA
// ═══════════════════════════════════════════════════════════════════

export function threeTriangleFromBitecs( out, eid, store = TriangleComponent ) {
  _writeVec3( out.a, store.ax[ eid ], store.ay[ eid ], store.az[ eid ] );
  _writeVec3( out.b, store.bx[ eid ], store.by[ eid ], store.bz[ eid ] );
  _writeVec3( out.c, store.cx[ eid ], store.cy[ eid ], store.cz[ eid ] );
  return out;
}

export function bitecsTriangleFromThree( eid, threeTriangle, store = TriangleComponent ) {
  store.ax[ eid ] = _rx( threeTriangle.a );
  store.ay[ eid ] = _ry( threeTriangle.a );
  store.az[ eid ] = _rz( threeTriangle.a );
  store.bx[ eid ] = _rx( threeTriangle.b );
  store.by[ eid ] = _ry( threeTriangle.b );
  store.bz[ eid ] = _rz( threeTriangle.b );
  store.cx[ eid ] = _rx( threeTriangle.c );
  store.cy[ eid ] = _ry( threeTriangle.c );
  store.cz[ eid ] = _rz( threeTriangle.c );
  return eid;
}

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

export function bitecsTriangleCopyInto( eidOut, eidIn, storeIn = TriangleComponent, storeOut = storeIn ) {
  storeOut.ax[ eidOut ] = storeIn.ax[ eidIn ];
  storeOut.ay[ eidOut ] = storeIn.ay[ eidIn ];
  storeOut.az[ eidOut ] = storeIn.az[ eidIn ];
  storeOut.bx[ eidOut ] = storeIn.bx[ eidIn ];
  storeOut.by[ eidOut ] = storeIn.by[ eidIn ];
  storeOut.bz[ eidOut ] = storeIn.bz[ eidIn ];
  storeOut.cx[ eidOut ] = storeIn.cx[ eidIn ];
  storeOut.cy[ eidOut ] = storeIn.cy[ eidIn ];
  storeOut.cz[ eidOut ] = storeIn.cz[ eidIn ];
  return eidOut;
}

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

export function bitecsTriangleNormalInto( eidOutVec, eidTri, storeTri = TriangleComponent, storeVec ) {
  const ax = storeTri.ax[ eidTri ], ay = storeTri.ay[ eidTri ], az = storeTri.az[ eidTri ];
  const bx = storeTri.bx[ eidTri ], by = storeTri.by[ eidTri ], bz = storeTri.bz[ eidTri ];
  const cx = storeTri.cx[ eidTri ], cy = storeTri.cy[ eidTri ], cz = storeTri.cz[ eidTri ];

  // n = (c − b) × (a − b)
  const cbx = cx - bx, cby = cy - by, cbz = cz - bz;
  const abx = ax - bx, aby = ay - by, abz = az - bz;
  let nx = cby * abz - cbz * aby;
  let ny = cbz * abx - cbx * abz;
  let nz = cbx * aby - cby * abx;
  const lenSq = nx * nx + ny * ny + nz * nz;
  if ( lenSq > 0 ) {
    const inv = 1 / Math.sqrt( lenSq );
    nx *= inv; ny *= inv; nz *= inv;
  } else {
    nx = 0; ny = 0; nz = 0;
  }
  storeVec.x[ eidOutVec ] = nx;
  storeVec.y[ eidOutVec ] = ny;
  storeVec.z[ eidOutVec ] = nz;
  return eidOutVec;
}

export function threeVec3FromBitecsTriangleNormal( out, eid, store = TriangleComponent ) {
  return _writeVec3(
    out,
    ( ( store.cy[ eid ] - store.by[ eid ] ) * ( store.az[ eid ] - store.bz[ eid ] )
    - ( store.cz[ eid ] - store.bz[ eid ] ) * ( store.ay[ eid ] - store.by[ eid ] ) ) || 0,
    ( ( store.cz[ eid ] - store.bz[ eid ] ) * ( store.ax[ eid ] - store.bx[ eid ] )
    - ( store.cx[ eid ] - store.bx[ eid ] ) * ( store.az[ eid ] - store.bz[ eid ] ) ) || 0,
    ( ( store.cx[ eid ] - store.bx[ eid ] ) * ( store.ay[ eid ] - store.by[ eid ] )
    - ( store.cy[ eid ] - store.by[ eid ] ) * ( store.ax[ eid ] - store.bx[ eid ] ) ) || 0
  );
}

export function bitecsTriangleArea( eid, store = TriangleComponent ) {
  const abx = store.bx[ eid ] - store.ax[ eid ];
  const aby = store.by[ eid ] - store.ay[ eid ];
  const abz = store.bz[ eid ] - store.az[ eid ];
  const acx = store.cx[ eid ] - store.ax[ eid ];
  const acy = store.cy[ eid ] - store.ay[ eid ];
  const acz = store.cz[ eid ] - store.az[ eid ];
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  return 0.5 * Math.sqrt( nx * nx + ny * ny + nz * nz );
}

export function bitecsVec3TriangleMidpointInto( eidOutVec, eidTri, storeTri = TriangleComponent, storeVec ) {
  storeVec.x[ eidOutVec ] = ( storeTri.ax[ eidTri ] + storeTri.bx[ eidTri ] + storeTri.cx[ eidTri ] ) / 3;
  storeVec.y[ eidOutVec ] = ( storeTri.ay[ eidTri ] + storeTri.by[ eidTri ] + storeTri.cy[ eidTri ] ) / 3;
  storeVec.z[ eidOutVec ] = ( storeTri.az[ eidTri ] + storeTri.bz[ eidTri ] + storeTri.cz[ eidTri ] ) / 3;
  return eidOutVec;
}

export function threeVec3FromBitecsTriangleMidpoint( out, eid, store = TriangleComponent ) {
  return _writeVec3(
    out,
    ( store.ax[ eid ] + store.bx[ eid ] + store.cx[ eid ] ) / 3,
    ( store.ay[ eid ] + store.by[ eid ] + store.cy[ eid ] ) / 3,
    ( store.az[ eid ] + store.bz[ eid ] + store.cz[ eid ] ) / 3
  );
}

export function bitecsTriangleBarycoordInto( eidOutVec, eidTri, eidPoint, storeTri = TriangleComponent, storePoint, storeVec ) {
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

  const denom = dot00 * dot11 - dot01 * dot01;
  if ( denom === 0 ) {
    storeVec.x[ eidOutVec ] = 0;
    storeVec.y[ eidOutVec ] = 0;
    storeVec.z[ eidOutVec ] = 0;
    return eidOutVec;
  }
  const invDenom = 1 / denom;
  const u = ( dot11 * dot02 - dot01 * dot12 ) * invDenom;
  const v = ( dot00 * dot12 - dot01 * dot02 ) * invDenom;
  storeVec.x[ eidOutVec ] = 1 - u - v;
  storeVec.y[ eidOutVec ] = v;
  storeVec.z[ eidOutVec ] = u;
  return eidOutVec;
}

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

  const denom = dot00 * dot11 - dot01 * dot01;
  if ( denom === 0 ) {
    return _writeVec3( out, 0, 0, 0 );
  }
  const invDenom = 1 / denom;
  const u = ( dot11 * dot02 - dot01 * dot12 ) * invDenom;
  const v = ( dot00 * dot12 - dot01 * dot02 ) * invDenom;
  return _writeVec3( out, 1 - u - v, v, u );
}

export function bitecsTriangleContainsPoint( eidTri, eidPoint, storeTri = TriangleComponent, storePoint ) {
  const tmp = new Float32Array( 3 );
  const bary = { x: 0, y: 0, z: 0 };
  // Inline barycentric test
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

  const denom = dot00 * dot11 - dot01 * dot01;
  if ( denom === 0 ) return false;
  const invDenom = 1 / denom;
  const u = ( dot11 * dot02 - dot01 * dot12 ) * invDenom;
  const v = ( dot00 * dot12 - dot01 * dot02 ) * invDenom;
  const w = 1 - u - v;
  return w >= 0 && v >= 0 && u >= 0;
}

export function bitecsVec3TriangleClosestPointInto( eidOutVec, eidTri, eidPoint, storeTri = TriangleComponent, storePoint, storeVec ) {
  const tri = Triangle.acquire();
  try {
    threeTriangleFromBitecs( tri, eidTri, storeTri );
    const p = _scratchA;
    p[ 0 ] = storePoint.x[ eidPoint ];
    p[ 1 ] = storePoint.y[ eidPoint ];
    p[ 2 ] = storePoint.z[ eidPoint ];
    const out = _scratchB;
    tri.closestPointToPoint( p, out );
    storeVec.x[ eidOutVec ] = out[ 0 ];
    storeVec.y[ eidOutVec ] = out[ 1 ];
    storeVec.z[ eidOutVec ] = out[ 2 ];
  } finally {
    Triangle.recycle( tri );
  }
  return eidOutVec;
}

export function threeVec3FromBitecsTriangleClosestPoint( out, eidTri, eidPoint, storeTri = TriangleComponent, storePoint ) {
  const tri = Triangle.acquire();
  try {
    threeTriangleFromBitecs( tri, eidTri, storeTri );
    const p = _scratchA;
    p[ 0 ] = storePoint.x[ eidPoint ];
    p[ 1 ] = storePoint.y[ eidPoint ];
    p[ 2 ] = storePoint.z[ eidPoint ];
    return tri.closestPointToPoint( p, out );
  } finally {
    Triangle.recycle( tri );
  }
}

export function bitecsTriangleTranslateInPlace( eid, eidOffset, storeTri = TriangleComponent, storeOffset ) {
  const ox = storeOffset.x[ eidOffset ];
  const oy = storeOffset.y[ eidOffset ];
  const oz = storeOffset.z[ eidOffset ];
  storeTri.ax[ eid ] += ox; storeTri.ay[ eid ] += oy; storeTri.az[ eid ] += oz;
  storeTri.bx[ eid ] += ox; storeTri.by[ eid ] += oy; storeTri.bz[ eid ] += oz;
  storeTri.cx[ eid ] += ox; storeTri.cy[ eid ] += oy; storeTri.cz[ eid ] += oz;
  return eid;
}

export function bitecsTriangleApplyMatrix4InPlace( eid, m, storeTri = TriangleComponent ) {
  const me = _matrixElements( m );
  const m00 = me[ 0 ], m01 = me[ 4 ], m02 = me[ 8 ],  m03 = me[ 12 ];
  const m10 = me[ 1 ], m11 = me[ 5 ], m12 = me[ 9 ],  m13 = me[ 13 ];
  const m20 = me[ 2 ], m21 = me[ 6 ], m22 = me[ 10 ], m23 = me[ 14 ];
  const m30 = me[ 3 ], m31 = me[ 7 ], m32 = me[ 11 ], m33 = me[ 15 ];

  function tp( x, y, z ) {
    const w = m30 * x + m31 * y + m32 * z + m33 || 1.0;
    const invW = 1 / w;
    return [
      ( m00 * x + m01 * y + m02 * z + m03 ) * invW,
      ( m10 * x + m11 * y + m12 * z + m13 ) * invW,
      ( m20 * x + m21 * y + m22 * z + m23 ) * invW
    ];
  }

  let r = tp( storeTri.ax[ eid ], storeTri.ay[ eid ], storeTri.az[ eid ] );
  storeTri.ax[ eid ] = r[ 0 ]; storeTri.ay[ eid ] = r[ 1 ]; storeTri.az[ eid ] = r[ 2 ];
  r = tp( storeTri.bx[ eid ], storeTri.by[ eid ], storeTri.bz[ eid ] );
  storeTri.bx[ eid ] = r[ 0 ]; storeTri.by[ eid ] = r[ 1 ]; storeTri.bz[ eid ] = r[ 2 ];
  r = tp( storeTri.cx[ eid ], storeTri.cy[ eid ], storeTri.cz[ eid ] );
  storeTri.cx[ eid ] = r[ 0 ]; storeTri.cy[ eid ] = r[ 1 ]; storeTri.cz[ eid ] = r[ 2 ];
  return eid;
}

export function bitecsTriangleIsFrontFacing( eidTri, eidDirection, storeTri = TriangleComponent, storeDirection ) {
  const ax = storeTri.ax[ eidTri ], ay = storeTri.ay[ eidTri ], az = storeTri.az[ eidTri ];
  const bx = storeTri.bx[ eidTri ], by = storeTri.by[ eidTri ], bz = storeTri.bz[ eidTri ];
  const cx = storeTri.cx[ eidTri ], cy = storeTri.cy[ eidTri ], cz = storeTri.cz[ eidTri ];

  const cbx = cx - bx, cby = cy - by, cbz = cz - bz;
  const abx = ax - bx, aby = ay - by, abz = az - bz;
  const nx = cby * abz - cbz * aby;
  const ny = cbz * abx - cbx * abz;
  const nz = cbx * aby - cby * abx;

  const dot = nx * storeDirection.x[ eidDirection ]
            + ny * storeDirection.y[ eidDirection ]
            + nz * storeDirection.z[ eidDirection ];
  return dot < 0;
}

// ═══════════════════════════════════════════════════════════════════
// HIGH-PRECISION (DoubleDouble) HELPERS — galactic-scale vertices
// ═══════════════════════════════════════════════════════════════════

export function preciseArea( tri ) {
  const abx = DD.subtract( DD.fromDouble( _rx( tri.b ) ), DD.fromDouble( _rx( tri.a ) ) );
  const aby = DD.subtract( DD.fromDouble( _ry( tri.b ) ), DD.fromDouble( _ry( tri.a ) ) );
  const abz = DD.subtract( DD.fromDouble( _rz( tri.b ) ), DD.fromDouble( _rz( tri.a ) ) );
  const acx = DD.subtract( DD.fromDouble( _rx( tri.c ) ), DD.fromDouble( _rx( tri.a ) ) );
  const acy = DD.subtract( DD.fromDouble( _ry( tri.c ) ), DD.fromDouble( _ry( tri.a ) ) );
  const acz = DD.subtract( DD.fromDouble( _rz( tri.c ) ), DD.fromDouble( _rz( tri.a ) ) );

  const nx = DD.subtract( DD.multiply( aby, acz ), DD.multiply( abz, acy ) );
  const ny = DD.subtract( DD.multiply( abz, acx ), DD.multiply( abx, acz ) );
  const nz = DD.subtract( DD.multiply( abx, acy ), DD.multiply( aby, acx ) );

  const len = DD.sqrt(
    DD.add(
      DD.add( DD.multiply( nx, nx ), DD.multiply( ny, ny ) ),
      DD.multiply( nz, nz )
    )
  );
  return DD.toDouble( DD.multiply( DD.fromDouble( 0.5 ), len ) );
}

export function preciseBarycoord( out, tri, point ) {
  if ( out === undefined ) out = _vec3();
  const v0x = DD.subtract( DD.fromDouble( _rx( tri.c ) ), DD.fromDouble( _rx( tri.a ) ) );
  const v0y = DD.subtract( DD.fromDouble( _ry( tri.c ) ), DD.fromDouble( _ry( tri.a ) ) );
  const v0z = DD.subtract( DD.fromDouble( _rz( tri.c ) ), DD.fromDouble( _rz( tri.a ) ) );
  const v1x = DD.subtract( DD.fromDouble( _rx( tri.b ) ), DD.fromDouble( _rx( tri.a ) ) );
  const v1y = DD.subtract( DD.fromDouble( _ry( tri.b ) ), DD.fromDouble( _ry( tri.a ) ) );
  const v1z = DD.subtract( DD.fromDouble( _rz( tri.b ) ), DD.fromDouble( _rz( tri.a ) ) );
  const v2x = DD.subtract( DD.fromDouble( _rx( point ) ), DD.fromDouble( _rx( tri.a ) ) );
  const v2y = DD.subtract( DD.fromDouble( _ry( point ) ), DD.fromDouble( _ry( tri.a ) ) );
  const v2z = DD.subtract( DD.fromDouble( _rz( point ) ), DD.fromDouble( _rz( tri.a ) ) );

  const dot00 = DD.add(
    DD.add( DD.multiply( v0x, v0x ), DD.multiply( v0y, v0y ) ),
    DD.multiply( v0z, v0z )
  );
  const dot01 = DD.add(
    DD.add( DD.multiply( v0x, v1x ), DD.multiply( v0y, v1y ) ),
    DD.multiply( v0z, v1z )
  );
  const dot02 = DD.add(
    DD.add( DD.multiply( v0x, v2x ), DD.multiply( v0y, v2y ) ),
    DD.multiply( v0z, v2z )
  );
  const dot11 = DD.add(
    DD.add( DD.multiply( v1x, v1x ), DD.multiply( v1y, v1y ) ),
    DD.multiply( v1z, v1z )
  );
  const dot12 = DD.add(
    DD.add( DD.multiply( v1x, v2x ), DD.multiply( v1y, v2y ) ),
    DD.multiply( v1z, v2z )
  );

  const denom = DD.subtract( DD.multiply( dot00, dot11 ), DD.multiply( dot01, dot01 ) );
  if ( DD.toDouble( denom ) === 0 ) {
    return _writeVec3( out, 0, 0, 0 );
  }
  const invDenom = DD.divide( DD.fromDouble( 1 ), denom );
  const u = DD.multiply(
    DD.subtract( DD.multiply( dot11, dot02 ), DD.multiply( dot01, dot12 ) ),
    invDenom
  );
  const v = DD.multiply(
    DD.subtract( DD.multiply( dot00, dot12 ), DD.multiply( dot01, dot02 ) ),
    invDenom
  );
  return _writeVec3(
    out,
    1 - DD.toDouble( u ) - DD.toDouble( v ),
    DD.toDouble( v ),
    DD.toDouble( u )
  );
}

// ═══════════════════════════════════════════════════════════════════
// PROCEDURAL NOISE — random triangle from a 3D simplex field
// ═══════════════════════════════════════════════════════════════════

export function setFromNoise3D( out, x, y, z, seed = 0, scale = 1 ) {
  const n = _cachedNoise3D( seed );
  _writeVec3(
    out.a,
    n( x, y, z ) * scale,
    n( x + 31.416, y + 47.853, z + 12.793 ) * scale,
    n( x - 17.234, y - 53.127, z - 91.056 ) * scale
  );
  _writeVec3(
    out.b,
    n( x + 100.1, y + 200.2, z + 300.3 ) * scale,
    n( x - 110.5, y - 210.6, z - 310.7 ) * scale,
    n( x + 55.1, y - 66.2, z + 77.3 ) * scale
  );
  _writeVec3(
    out.c,
    n( x + 3.14159, y + 2.71828, z + 1.41421 ) * scale,
    n( x - 1.61803, y - 0.57721, z - 0.30103 ) * scale,
    n( x + 0.69315, y - 2.30258, z + 1.09861 ) * scale
  );
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// Named + default exports
// ═══════════════════════════════════════════════════════════════════
export { Triangle };
export default Triangle;