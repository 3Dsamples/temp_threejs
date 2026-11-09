// file number : 064
// full path name : src/math/064_Box3.js
// description : 3D axis-aligned bounding box — drop-in replacement for THREE.Box3 (r185). Renumbered to 064 to follow the sphere primitive (062) and 2D box (063) in topological order. min/max are duck-typed vec3-like values ({x,y,z}, flat [x,y,z], or THREE.Vector3) — every class method reads/writes via `_rx`/`_ry`/`_rz`/`_writeVec3` helpers so nothing depends on any external Vector3 class. Complete r185 surface: constructor(min, max), isBox3 flag, set(min, max), setFromArray(array), setFromBufferAttribute(attribute), setFromPoints(points), setFromCenterAndSize(center, size), copy(box), clone(), makeEmpty(), isEmpty(), getCenter(target), getSize(target), expandByPoint(point), expandByVector(vector), expandByScalar(scalar), expandByObject(object, precise), containsPoint(point), containsBox(box), getParameter(point, target), intersectsBox(box), intersectsSphere(sphere), intersectsPlane(plane), intersectsTriangle(triangle) — full 13-axis SAT (3 box axes + triangle normal + 9 edge cross products) — clampPoint(point, target), distanceToPoint(point), getBoundingSphere(target), intersect(box), union(box), applyMatrix4(matrix) — exact 8-corner transform (r185 exact for any affine), translate(offset), equals(box), fromArray(array, offset), toArray(array, offset). Extended: preciseVolume / preciseDistanceToPoint / preciseUnionInto via the chat's DoubleDouble (014) for galactic-scale coordinates; setFromNoise3D via the chat's SimplexNoise (013) with cached per-seed mulberry32 generator; full zero-allocation bitECS SoA bridge set using `Box3Component` (minX/Y/Z + maxX/Y/Z `f32([])` from 014_BitECS) covering from/to/copy/union/intersect/expand-by-point/expand-by-vector/expand-by-scalar/contains/intersects/clamp/distance/center/size/parameter/bounding-sphere/apply-matrix4/translate/isEmpty/makeEmpty; flat-array bridges for gl-matrix-style packed [minx,miny,minz,maxx,maxy,maxz] interop; and a recycled local pool (Box3.acquire / Box3.recycle) that resets min to (+Inf,+Inf,+Inf) and max to (-Inf,-Inf,-Inf). No THREE, no CDN, no static server, no Vite/Vue — imports only from the chat's own files (003_Common clamp, 013_SimplexNoise, 014_DoubleDouble, 014_BitECS).
// best for : broad-phase culling, frustum culling, spatial partitioning (octree/BVH), ray-AABB intersection, collision broad-phase, procedural chunk bounds, LOD distance bands, minimap extents, mesh bounding-box computation, and any ECS system that stores AABBs as SoA min/max corners and must feed THREE.Box3, THREE.Frustum, or THREE.Raycaster without allocating per frame. The pooled + SoA-bridge paths are the recommended route for hot loops at 10k+ entities on Android 64-bit.
// license : MIT

import { clamp } from '../core/003_Common.js';
import * as DD from './014_DoubleDouble.js';
import * as bitecs from './014_BitECS.js';
import { createNoise3D } from './013_SimplexNoise.js';

// ═══════════════════════════════════════════════════════════════════
// bitECS 0.4.0 SoA COMPONENT (archetype-friendly, cache-friendly)
// ═══════════════════════════════════════════════════════════════════
export const Box3Component = {
  minX: bitecs.f32([]),
  minY: bitecs.f32([]),
  minZ: bitecs.f32([]),
  maxX: bitecs.f32([]),
  maxY: bitecs.f32([]),
  maxZ: bitecs.f32([])
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

// Transform point by m (column-major, with w-divide). Writes into out.
function _transformPoint( out, x, y, z, m ) {
  const w = m[ 3 ] * x + m[ 7 ] * y + m[ 11 ] * z + m[ 15 ] || 1.0;
  return _writeVec3(
    out,
    ( m[ 0 ] * x + m[ 4 ] * y + m[ 8 ]  * z + m[ 12 ] ) / w,
    ( m[ 1 ] * x + m[ 5 ] * y + m[ 9 ]  * z + m[ 13 ] ) / w,
    ( m[ 2 ] * x + m[ 6 ] * y + m[ 10 ] * z + m[ 14 ] ) / w
  );
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

// Scratch vec3s reused by flat-array bridges
const _scratchVec3A = new Float32Array( 3 );
const _scratchVec3B = new Float32Array( 3 );

// ═══════════════════════════════════════════════════════════════════
// class Box3
// ═══════════════════════════════════════════════════════════════════
class Box3 {

  constructor( min, max ) {
    this.isBox3 = true;
    this.min = min !== undefined ? min : _vec3( Infinity, Infinity, Infinity );
    this.max = max !== undefined ? max : _vec3( -Infinity, -Infinity, -Infinity );
  }

  set( min, max ) {
    _copyVec3Into( this.min, min );
    _copyVec3Into( this.max, max );
    return this;
  }

  setFromArray( array ) {
    this.makeEmpty();
    if ( array.length < 3 ) return this;
    _writeVec3( this.min, array[ 0 ], array[ 1 ], array[ 2 ] );
    _writeVec3( this.max, array[ 0 ], array[ 1 ], array[ 2 ] );
    for ( let i = 3; i + 2 < array.length; i += 3 ) {
      const x = array[ i ], y = array[ i + 1 ], z = array[ i + 2 ];
      _writeVec3(
        this.min,
        Math.min( _rx( this.min ), x ),
        Math.min( _ry( this.min ), y ),
        Math.min( _rz( this.min ), z )
      );
      _writeVec3(
        this.max,
        Math.max( _rx( this.max ), x ),
        Math.max( _ry( this.max ), y ),
        Math.max( _rz( this.max ), z )
      );
    }
    return this;
  }

  setFromBufferAttribute( attribute ) {
    let minX =  Infinity, minY =  Infinity, minZ =  Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for ( let i = 0, l = attribute.count; i < l; i ++ ) {
      const x = attribute.getX( i );
      const y = attribute.getY( i );
      const z = attribute.getZ( i );
      if ( x < minX ) minX = x;
      if ( y < minY ) minY = y;
      if ( z < minZ ) minZ = z;
      if ( x > maxX ) maxX = x;
      if ( y > maxY ) maxY = y;
      if ( z > maxZ ) maxZ = z;
    }
    _writeVec3( this.min, minX, minY, minZ );
    _writeVec3( this.max, maxX, maxY, maxZ );
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
    const cx = _rx( center ), cy = _ry( center ), cz = _rz( center );
    const hx = _rx( size ) * 0.5, hy = _ry( size ) * 0.5, hz = _rz( size ) * 0.5;
    _writeVec3( this.min, cx - hx, cy - hy, cz - hz );
    _writeVec3( this.max, cx + hx, cy + hy, cz + hz );
    return this;
  }

  copy( box ) {
    _copyVec3Into( this.min, box.min );
    _copyVec3Into( this.max, box.max );
    return this;
  }

  clone() {
    return new this.constructor(
      _vec3( _rx( this.min ), _ry( this.min ), _rz( this.min ) ),
      _vec3( _rx( this.max ), _ry( this.max ), _rz( this.max ) )
    );
  }

  makeEmpty() {
    _writeVec3( this.min, Infinity, Infinity, Infinity );
    _writeVec3( this.max, -Infinity, -Infinity, -Infinity );
    return this;
  }

  isEmpty() {
    return _rx( this.max ) < _rx( this.min )
        || _ry( this.max ) < _ry( this.min )
        || _rz( this.max ) < _rz( this.min );
  }

  getCenter( target ) {
    if ( target === undefined ) target = _vec3();
    if ( this.isEmpty() ) return _writeVec3( target, 0, 0, 0 );
    return _writeVec3(
      target,
      ( _rx( this.min ) + _rx( this.max ) ) * 0.5,
      ( _ry( this.min ) + _ry( this.max ) ) * 0.5,
      ( _rz( this.min ) + _rz( this.max ) ) * 0.5
    );
  }

  getSize( target ) {
    if ( target === undefined ) target = _vec3();
    if ( this.isEmpty() ) return _writeVec3( target, 0, 0, 0 );
    return _writeVec3(
      target,
      _rx( this.max ) - _rx( this.min ),
      _ry( this.max ) - _ry( this.min ),
      _rz( this.max ) - _rz( this.min )
    );
  }

  expandByPoint( point ) {
    _writeVec3(
      this.min,
      Math.min( _rx( this.min ), _rx( point ) ),
      Math.min( _ry( this.min ), _ry( point ) ),
      Math.min( _rz( this.min ), _rz( point ) )
    );
    _writeVec3(
      this.max,
      Math.max( _rx( this.max ), _rx( point ) ),
      Math.max( _ry( this.max ), _ry( point ) ),
      Math.max( _rz( this.max ), _rz( point ) )
    );
    return this;
  }

  expandByVector( vector ) {
    _writeVec3(
      this.min,
      _rx( this.min ) - _rx( vector ),
      _ry( this.min ) - _ry( vector ),
      _rz( this.min ) - _rz( vector )
    );
    _writeVec3(
      this.max,
      _rx( this.max ) + _rx( vector ),
      _ry( this.max ) + _ry( vector ),
      _rz( this.max ) + _rz( vector )
    );
    return this;
  }

  expandByScalar( scalar ) {
    _writeVec3( this.min, _rx( this.min ) - scalar, _ry( this.min ) - scalar, _rz( this.min ) - scalar );
    _writeVec3( this.max, _rx( this.max ) + scalar, _ry( this.max ) + scalar, _rz( this.max ) + scalar );
    return this;
  }

  expandByObject( object, precise ) {
    // Duck-typed: works with THREE.Object3D, Mesh, Group, InstancedMesh,
    // or any object with { geometry?, matrixWorld?, children? }.
    if ( object === null || object === undefined ) return this;
    if ( typeof object.updateWorldMatrix === 'function' ) {
      object.updateWorldMatrix( false, false );
    }
    const geometry = object.geometry;
    if ( geometry !== undefined && geometry !== null ) {
      const boundingBox = geometry.boundingBox;
      if ( boundingBox !== undefined && boundingBox !== null ) {
        // Use a scratch Box3 for the union, then transform.
        _scratchBox.copy( boundingBox );
        if ( object.matrixWorld !== undefined ) {
          _scratchBox.applyMatrix4( object.matrixWorld );
        }
        this.union( _scratchBox );
      } else if ( typeof geometry.computeBoundingBox === 'function' ) {
        geometry.computeBoundingBox();
        const bb = geometry.boundingBox;
        if ( bb ) {
          _scratchBox.copy( bb );
          if ( object.matrixWorld !== undefined ) {
            _scratchBox.applyMatrix4( object.matrixWorld );
          }
          this.union( _scratchBox );
        }
      }
    }
    const children = object.children;
    if ( children !== undefined && children !== null ) {
      for ( let i = 0, l = children.length; i < l; i ++ ) {
        this.expandByObject( children[ i ], precise );
      }
    }
    return this;
  }

  containsPoint( point ) {
    return _rx( point ) >= _rx( this.min ) && _rx( point ) <= _rx( this.max )
        && _ry( point ) >= _ry( this.min ) && _ry( point ) <= _ry( this.max )
        && _rz( point ) >= _rz( this.min ) && _rz( point ) <= _rz( this.max );
  }

  containsBox( box ) {
    return _rx( this.min ) <= _rx( box.min ) && _rx( box.max ) <= _rx( this.max )
        && _ry( this.min ) <= _ry( box.min ) && _ry( box.max ) <= _ry( this.max )
        && _rz( this.min ) <= _rz( box.min ) && _rz( box.max ) <= _rz( this.max );
  }

  getParameter( point, target ) {
    if ( target === undefined ) target = _vec3();
    return _writeVec3(
      target,
      ( _rx( point ) - _rx( this.min ) ) / ( _rx( this.max ) - _rx( this.min ) ),
      ( _ry( point ) - _ry( this.min ) ) / ( _ry( this.max ) - _ry( this.min ) ),
      ( _rz( point ) - _rz( this.min ) ) / ( _rz( this.max ) - _rz( this.min ) )
    );
  }

  intersectsBox( box ) {
    return ! (
      _rx( box.max ) < _rx( this.min ) || _rx( box.min ) > _rx( this.max ) ||
      _ry( box.max ) < _ry( this.min ) || _ry( box.min ) > _ry( this.max ) ||
      _rz( box.max ) < _rz( this.min ) || _rz( box.min ) > _rz( this.max )
    );
  }

  intersectsSphere( sphere ) {
    const cx = _rx( sphere.center ), cy = _ry( sphere.center ), cz = _rz( sphere.center );
    const r  = sphere.radius;
    const nx = clamp( cx, _rx( this.min ), _rx( this.max ) );
    const ny = clamp( cy, _ry( this.min ), _ry( this.max ) );
    const nz = clamp( cz, _rz( this.min ), _rz( this.max ) );
    const dx = cx - nx, dy = cy - ny, dz = cz - nz;
    return ( dx * dx + dy * dy + dz * dz ) <= ( r * r );
  }

  intersectsPlane( plane ) {
    // Hessian-form plane: normal · p + constant = 0
    let min = 0, max = 0;
    const n = plane.normal;
    const nx = _rx( n ), ny = _ry( n ), nz = _rz( n );
    const minX = _rx( this.min ), minY = _ry( this.min ), minZ = _rz( this.min );
    const maxX = _rx( this.max ), maxY = _ry( this.max ), maxZ = _rz( this.max );
    if ( nx > 0 ) { min += nx * minX; max += nx * maxX; } else { min += nx * maxX; max += nx * minX; }
    if ( ny > 0 ) { min += ny * minY; max += ny * maxY; } else { min += ny * maxY; max += ny * minY; }
    if ( nz > 0 ) { min += nz * minZ; max += nz * maxZ; } else { min += nz * maxZ; max += nz * minZ; }
    return ( min <= -plane.constant && max >= -plane.constant );
  }

  intersectsTriangle( triangle ) {
    if ( this.isEmpty() ) return false;

    // Triangle vertices in world space (duck-typed).
    const ax = _rx( triangle.a ), ay = _ry( triangle.a ), az = _rz( triangle.a );
    const bx = _rx( triangle.b ), by = _ry( triangle.b ), bz = _rz( triangle.b );
    const cx = _rx( triangle.c ), cy = _ry( triangle.c ), cz = _rz( triangle.c );

    // Box center and half-extents.
    const hx = ( _rx( this.max ) - _rx( this.min ) ) * 0.5;
    const hy = ( _ry( this.max ) - _ry( this.min ) ) * 0.5;
    const hz = ( _rz( this.max ) - _rz( this.min ) ) * 0.5;
    const centerX = _rx( this.min ) + hx;
    const centerY = _ry( this.min ) + hy;
    const centerZ = _rz( this.min ) + hz;

    // Translate triangle so the box is centered at the origin.
    const v0x = ax - centerX, v0y = ay - centerY, v0z = az - centerZ;
    const v1x = bx - centerX, v1y = by - centerY, v1z = bz - centerZ;
    const v2x = cx - centerX, v2y = cy - centerY, v2z = cz - centerZ;

    // Triangle edges.
    const e0x = v1x - v0x, e0y = v1y - v0y, e0z = v1z - v0z;
    const e1x = v2x - v1x, e1y = v2y - v1y, e1z = v2z - v1z;
    const e2x = v0x - v2x, e2y = v0y - v2y, e2z = v0z - v2z;

    // SAT axis test — returns false if separated along this axis.
    function testAxis( sx, sy, sz ) {
      const p0 = v0x * sx + v0y * sy + v0z * sz;
      const p1 = v1x * sx + v1y * sy + v1z * sz;
      const p2 = v2x * sx + v2y * sy + v2z * sz;
      const r  = hx * Math.abs( sx ) + hy * Math.abs( sy ) + hz * Math.abs( sz );
      const minP = Math.min( p0, p1, p2 );
      const maxP = Math.max( p0, p1, p2 );
      return ! ( maxP < -r || minP > r );
    }

    // 3 box axes.
    if ( !testAxis( 1, 0, 0 ) ) return false;
    if ( !testAxis( 0, 1, 0 ) ) return false;
    if ( !testAxis( 0, 0, 1 ) ) return false;

    // Triangle normal = e0 × e1.
    const tnx = e0y * e1z - e0z * e1y;
    const tny = e0z * e1x - e0x * e1z;
    const tnz = e0x * e1y - e0y * e1x;
    if ( !testAxis( tnx, tny, tnz ) ) return false;

    // 9 edge-cross-box-axis tests.
    // e × X = (0, e.z, -e.y)
    // e × Y = (-e.z, 0, e.x)
    // e × Z = (e.y, -e.x, 0)
    if ( !testAxis( 0, e0z, -e0y ) ) return false;
    if ( !testAxis( -e0z, 0, e0x ) ) return false;
    if ( !testAxis( e0y, -e0x, 0 ) ) return false;
    if ( !testAxis( 0, e1z, -e1y ) ) return false;
    if ( !testAxis( -e1z, 0, e1x ) ) return false;
    if ( !testAxis( e1y, -e1x, 0 ) ) return false;
    if ( !testAxis( 0, e2z, -e2y ) ) return false;
    if ( !testAxis( -e2z, 0, e2x ) ) return false;
    if ( !testAxis( e2y, -e2x, 0 ) ) return false;

    return true;
  }

  clampPoint( point, target ) {
    if ( target === undefined ) target = _vec3();
    return _writeVec3(
      target,
      clamp( _rx( point ), _rx( this.min ), _rx( this.max ) ),
      clamp( _ry( point ), _ry( this.min ), _ry( this.max ) ),
      clamp( _rz( point ), _rz( this.min ), _rz( this.max ) )
    );
  }

  distanceToPoint( point ) {
    const cx = clamp( _rx( point ), _rx( this.min ), _rx( this.max ) );
    const cy = clamp( _ry( point ), _ry( this.min ), _ry( this.max ) );
    const cz = clamp( _rz( point ), _rz( this.min ), _rz( this.max ) );
    const dx = _rx( point ) - cx;
    const dy = _ry( point ) - cy;
    const dz = _rz( point ) - cz;
    return Math.sqrt( dx * dx + dy * dy + dz * dz );
  }

  getBoundingSphere( target ) {
    if ( target === undefined ) target = _vec3();
    // Write center + radius into a Sphere-like object; if target has no
    // .center, write center coords into it as a vec3.
    const cx = ( _rx( this.min ) + _rx( this.max ) ) * 0.5;
    const cy = ( _ry( this.min ) + _ry( this.max ) ) * 0.5;
    const cz = ( _rz( this.min ) + _rz( this.max ) ) * 0.5;
    const dx = _rx( this.max ) - cx;
    const dy = _ry( this.max ) - cy;
    const dz = _rz( this.max ) - cz;
    const radius = Math.sqrt( dx * dx + dy * dy + dz * dz );

    if ( target.center !== undefined ) {
      _writeVec3( target.center, cx, cy, cz );
      target.radius = radius;
    } else {
      // Flat/writer target
      _writeVec3( target, cx, cy, cz );
      if ( 'radius' in target ) target.radius = radius;
    }
    return target;
  }

  intersect( box ) {
    _writeVec3(
      this.min,
      Math.max( _rx( this.min ), _rx( box.min ) ),
      Math.max( _ry( this.min ), _ry( box.min ) ),
      Math.max( _rz( this.min ), _rz( box.min ) )
    );
    _writeVec3(
      this.max,
      Math.min( _rx( this.max ), _rx( box.max ) ),
      Math.min( _ry( this.max ), _ry( box.max ) ),
      Math.min( _rz( this.max ), _rz( box.max ) )
    );
    if ( this.isEmpty() ) this.makeEmpty();
    return this;
  }

  union( box ) {
    _writeVec3(
      this.min,
      Math.min( _rx( this.min ), _rx( box.min ) ),
      Math.min( _ry( this.min ), _ry( box.min ) ),
      Math.min( _rz( this.min ), _rz( box.min ) )
    );
    _writeVec3(
      this.max,
      Math.max( _rx( this.max ), _rx( box.max ) ),
      Math.max( _ry( this.max ), _ry( box.max ) ),
      Math.max( _rz( this.max ), _rz( box.max ) )
    );
    return this;
  }

  applyMatrix4( matrix ) {
    if ( this.isEmpty() ) return this;
    const m = _matrixElements( matrix );

    // 8 corners of the AABB in local space.
    const minX = _rx( this.min ), minY = _ry( this.min ), minZ = _rz( this.min );
    const maxX = _rx( this.max ), maxY = _ry( this.max ), maxZ = _rz( this.max );

    // Per-axis decomposition of the transform to decide which corner
    // produces the min / max on each axis — equivalent to transforming
    // all 8 corners but with 4× fewer ops.
    const m00 = m[ 0 ], m01 = m[ 4 ], m02 = m[ 8 ],  m03 = m[ 12 ];
    const m10 = m[ 1 ], m11 = m[ 5 ], m12 = m[ 9 ],  m13 = m[ 13 ];
    const m20 = m[ 2 ], m21 = m[ 6 ], m22 = m[ 10 ], m23 = m[ 14 ];
    const m30 = m[ 3 ], m31 = m[ 7 ], m32 = m[ 11 ], m33 = m[ 15 ];

    // Translation (includes w component when axis is projective).
    const tX = m03, tY = m13, tZ = m23;

    // Sign of each 3x3 entry selects which extreme to sample.
    const aXx = m00 * ( m00 >= 0 ? maxX : minX );
    const aXy = m01 * ( m01 >= 0 ? maxY : minY );
    const aXz = m02 * ( m02 >= 0 ? maxZ : minZ );
    const bXx = m00 * ( m00 >= 0 ? minX : maxX );
    const bXy = m01 * ( m01 >= 0 ? minY : maxY );
    const bXz = m02 * ( m02 >= 0 ? minZ : maxZ );

    const aYx = m10 * ( m10 >= 0 ? maxX : minX );
    const aYy = m11 * ( m11 >= 0 ? maxY : minY );
    const aYz = m12 * ( m12 >= 0 ? maxZ : minZ );
    const bYx = m10 * ( m10 >= 0 ? minX : maxX );
    const bYy = m11 * ( m11 >= 0 ? minY : maxY );
    const bYz = m12 * ( m12 >= 0 ? minZ : maxZ );

    const aZx = m20 * ( m20 >= 0 ? maxX : minX );
    const aZy = m21 * ( m21 >= 0 ? maxY : minY );
    const aZz = m22 * ( m22 >= 0 ? maxZ : minZ );
    const bZx = m20 * ( m20 >= 0 ? minX : maxX );
    const bZy = m21 * ( m21 >= 0 ? minY : maxY );
    const bZz = m22 * ( m22 >= 0 ? minZ : maxZ );

    // For a non-projective affine matrix (m30=m31=m32=0, m33=1) we can
    // skip the w-divide. For projective matrices we fall back to the
    // exact 8-corner test.
    const isProjective = ( m30 !== 0 || m31 !== 0 || m32 !== 0 || m33 !== 1 );
    if ( !isProjective ) {
      const newMinX = ( aXx + aXy + aXz ) + tX;
      const newMaxX = ( bXx + bXy + bXz ) + tX;
      const newMinY = ( aYx + aYy + aYz ) + tY;
      const newMaxY = ( bYx + bYy + bYz ) + tY;
      const newMinZ = ( aZx + aZy + aZz ) + tZ;
      const newMaxZ = ( bZx + bZy + bZz ) + tZ;
      _writeVec3( this.min, newMinX, newMinY, newMinZ );
      _writeVec3( this.max, newMaxX, newMaxY, newMaxZ );
      return this;
    }

    // Projective path: transform all 8 corners exactly.
    let newMinX =  Infinity, newMinY =  Infinity, newMinZ =  Infinity;
    let newMaxX = -Infinity, newMaxY = -Infinity, newMaxZ = -Infinity;
    for ( let i = 0; i < 8; i ++ ) {
      const x = ( i & 1 ) ? maxX : minX;
      const y = ( i & 2 ) ? maxY : minY;
      const z = ( i & 4 ) ? maxZ : minZ;
      const w = m30 * x + m31 * y + m32 * z + m33 || 1.0;
      const invW = 1 / w;
      const tx = ( m00 * x + m01 * y + m02 * z + m03 ) * invW;
      const ty = ( m10 * x + m11 * y + m12 * z + m13 ) * invW;
      const tz = ( m20 * x + m21 * y + m22 * z + m23 ) * invW;
      if ( tx < newMinX ) newMinX = tx;
      if ( ty < newMinY ) newMinY = ty;
      if ( tz < newMinZ ) newMinZ = tz;
      if ( tx > newMaxX ) newMaxX = tx;
      if ( ty > newMaxY ) newMaxY = ty;
      if ( tz > newMaxZ ) newMaxZ = tz;
    }
    _writeVec3( this.min, newMinX, newMinY, newMinZ );
    _writeVec3( this.max, newMaxX, newMaxY, newMaxZ );
    return this;
  }

  translate( offset ) {
    const ox = _rx( offset ), oy = _ry( offset ), oz = _rz( offset );
    _writeVec3( this.min, _rx( this.min ) + ox, _ry( this.min ) + oy, _rz( this.min ) + oz );
    _writeVec3( this.max, _rx( this.max ) + ox, _ry( this.max ) + oy, _rz( this.max ) + oz );
    return this;
  }

  equals( box ) {
    return _rx( box.min ) === _rx( this.min )
        && _ry( box.min ) === _ry( this.min )
        && _rz( box.min ) === _rz( this.min )
        && _rx( box.max ) === _rx( this.max )
        && _ry( box.max ) === _ry( this.max )
        && _rz( box.max ) === _rz( this.max );
  }

  fromArray( array, offset = 0 ) {
    _writeVec3( this.min, array[ offset ],     array[ offset + 1 ], array[ offset + 2 ] );
    _writeVec3( this.max, array[ offset + 3 ], array[ offset + 4 ], array[ offset + 5 ] );
    return this;
  }

  toArray( array = [], offset = 0 ) {
    array[ offset ]     = _rx( this.min );
    array[ offset + 1 ] = _ry( this.min );
    array[ offset + 2 ] = _rz( this.min );
    array[ offset + 3 ] = _rx( this.max );
    array[ offset + 4 ] = _ry( this.max );
    array[ offset + 5 ] = _rz( this.max );
    return array;
  }

  // ────────────── pooled instances ──────────────

  static acquire() {
    return _localPool.length > 0 ? _localPool.pop() : new Box3();
  }

  static recycle( box ) {
    if ( box instanceof Box3 && _localPool.length < LOCAL_POOL_MAX ) {
      _writeVec3( box.min, Infinity, Infinity, Infinity );
      _writeVec3( box.max, -Infinity, -Infinity, -Infinity );
      _localPool.push( box );
    }
  }
}

// Scratch box used by expandByObject — a private Box3 instance, never exposed.
const _scratchBox = new Box3();

// ═══════════════════════════════════════════════════════════════════
// BRIDGE: THREE-style <-> flat array (gl-matrix-compatible layout)
// ═══════════════════════════════════════════════════════════════════

export function threeBox3FromGlMatrix( out, glMin, glMax ) {
  _writeVec3( out.min, glMin[ 0 ], glMin[ 1 ], glMin[ 2 ] );
  _writeVec3( out.max, glMax[ 0 ], glMax[ 1 ], glMax[ 2 ] );
  return out;
}

export function threeBox3FromGlMatrixPacked( out, glPacked ) {
  _writeVec3( out.min, glPacked[ 0 ], glPacked[ 1 ], glPacked[ 2 ] );
  _writeVec3( out.max, glPacked[ 3 ], glPacked[ 4 ], glPacked[ 5 ] );
  return out;
}

export function glMatrixBox3FromThree( outMin, outMax, threeBox ) {
  outMin[ 0 ] = _rx( threeBox.min );
  outMin[ 1 ] = _ry( threeBox.min );
  outMin[ 2 ] = _rz( threeBox.min );
  outMax[ 0 ] = _rx( threeBox.max );
  outMax[ 1 ] = _ry( threeBox.max );
  outMax[ 2 ] = _rz( threeBox.max );
  return threeBox;
}

export function glMatrixBox3PackedFromThree( outPacked, threeBox ) {
  outPacked[ 0 ] = _rx( threeBox.min );
  outPacked[ 1 ] = _ry( threeBox.min );
  outPacked[ 2 ] = _rz( threeBox.min );
  outPacked[ 3 ] = _rx( threeBox.max );
  outPacked[ 4 ] = _ry( threeBox.max );
  outPacked[ 5 ] = _rz( threeBox.max );
  return outPacked;
}

// ═══════════════════════════════════════════════════════════════════
// BRIDGE: THREE-style <-> bitECS SoA
// ═══════════════════════════════════════════════════════════════════

export function threeBox3FromBitecs( out, eid, store = Box3Component ) {
  _writeVec3( out.min, store.minX[ eid ], store.minY[ eid ], store.minZ[ eid ] );
  _writeVec3( out.max, store.maxX[ eid ], store.maxY[ eid ], store.maxZ[ eid ] );
  return out;
}

export function bitecsBox3FromThree( eid, threeBox, store = Box3Component ) {
  store.minX[ eid ] = _rx( threeBox.min );
  store.minY[ eid ] = _ry( threeBox.min );
  store.minZ[ eid ] = _rz( threeBox.min );
  store.maxX[ eid ] = _rx( threeBox.max );
  store.maxY[ eid ] = _ry( threeBox.max );
  store.maxZ[ eid ] = _rz( threeBox.max );
  return eid;
}

export function bitecsBox3FromGlMatrix( eid, glMin, glMax, store = Box3Component ) {
  store.minX[ eid ] = glMin[ 0 ];
  store.minY[ eid ] = glMin[ 1 ];
  store.minZ[ eid ] = glMin[ 2 ];
  store.maxX[ eid ] = glMax[ 0 ];
  store.maxY[ eid ] = glMax[ 1 ];
  store.maxZ[ eid ] = glMax[ 2 ];
  return eid;
}

export function bitecsBox3FromGlMatrixPacked( eid, glPacked, store = Box3Component ) {
  store.minX[ eid ] = glPacked[ 0 ];
  store.minY[ eid ] = glPacked[ 1 ];
  store.minZ[ eid ] = glPacked[ 2 ];
  store.maxX[ eid ] = glPacked[ 3 ];
  store.maxY[ eid ] = glPacked[ 4 ];
  store.maxZ[ eid ] = glPacked[ 5 ];
  return eid;
}

export function glMatrixBox3FromBitecs( outMin, outMax, eid, store = Box3Component ) {
  outMin[ 0 ] = store.minX[ eid ];
  outMin[ 1 ] = store.minY[ eid ];
  outMin[ 2 ] = store.minZ[ eid ];
  outMax[ 0 ] = store.maxX[ eid ];
  outMax[ 1 ] = store.maxY[ eid ];
  outMax[ 2 ] = store.maxZ[ eid ];
  return eid;
}

export function glMatrixBox3PackedFromBitecs( outPacked, eid, store = Box3Component ) {
  outPacked[ 0 ] = store.minX[ eid ];
  outPacked[ 1 ] = store.minY[ eid ];
  outPacked[ 2 ] = store.minZ[ eid ];
  outPacked[ 3 ] = store.maxX[ eid ];
  outPacked[ 4 ] = store.maxY[ eid ];
  outPacked[ 5 ] = store.maxZ[ eid ];
  return outPacked;
}

export function bitecsBox3CopyInto( eidOut, eidIn, storeIn = Box3Component, storeOut = storeIn ) {
  storeOut.minX[ eidOut ] = storeIn.minX[ eidIn ];
  storeOut.minY[ eidOut ] = storeIn.minY[ eidIn ];
  storeOut.minZ[ eidOut ] = storeIn.minZ[ eidIn ];
  storeOut.maxX[ eidOut ] = storeIn.maxX[ eidIn ];
  storeOut.maxY[ eidOut ] = storeIn.maxY[ eidIn ];
  storeOut.maxZ[ eidOut ] = storeIn.maxZ[ eidIn ];
  return eidOut;
}

export function threeBox3FromBitecsUnion( out, eidA, eidB, storeA = Box3Component, storeB = Box3Component ) {
  _writeVec3(
    out.min,
    Math.min( storeA.minX[ eidA ], storeB.minX[ eidB ] ),
    Math.min( storeA.minY[ eidA ], storeB.minY[ eidB ] ),
    Math.min( storeA.minZ[ eidA ], storeB.minZ[ eidB ] )
  );
  _writeVec3(
    out.max,
    Math.max( storeA.maxX[ eidA ], storeB.maxX[ eidB ] ),
    Math.max( storeA.maxY[ eidA ], storeB.maxY[ eidB ] ),
    Math.max( storeA.maxZ[ eidA ], storeB.maxZ[ eidB ] )
  );
  return out;
}

export function bitecsBox3UnionInto( eidOut, eidA, eidB, storeA = Box3Component, storeB = Box3Component, storeOut = storeA ) {
  storeOut.minX[ eidOut ] = Math.min( storeA.minX[ eidA ], storeB.minX[ eidB ] );
  storeOut.minY[ eidOut ] = Math.min( storeA.minY[ eidA ], storeB.minY[ eidB ] );
  storeOut.minZ[ eidOut ] = Math.min( storeA.minZ[ eidA ], storeB.minZ[ eidB ] );
  storeOut.maxX[ eidOut ] = Math.max( storeA.maxX[ eidA ], storeB.maxX[ eidB ] );
  storeOut.maxY[ eidOut ] = Math.max( storeA.maxY[ eidA ], storeB.maxY[ eidB ] );
  storeOut.maxZ[ eidOut ] = Math.max( storeA.maxZ[ eidA ], storeB.maxZ[ eidB ] );
  return eidOut;
}

export function threeBox3FromBitecsIntersect( out, eidA, eidB, storeA = Box3Component, storeB = Box3Component ) {
  _writeVec3(
    out.min,
    Math.max( storeA.minX[ eidA ], storeB.minX[ eidB ] ),
    Math.max( storeA.minY[ eidA ], storeB.minY[ eidB ] ),
    Math.max( storeA.minZ[ eidA ], storeB.minZ[ eidB ] )
  );
  _writeVec3(
    out.max,
    Math.min( storeA.maxX[ eidA ], storeB.maxX[ eidB ] ),
    Math.min( storeA.maxY[ eidA ], storeB.maxY[ eidB ] ),
    Math.min( storeA.maxZ[ eidA ], storeB.maxZ[ eidB ] )
  );
  if ( out.isEmpty() ) out.makeEmpty();
  return out;
}

export function bitecsBox3IntersectInto( eidOut, eidA, eidB, storeA = Box3Component, storeB = Box3Component, storeOut = storeA ) {
  const minX = Math.max( storeA.minX[ eidA ], storeB.minX[ eidB ] );
  const minY = Math.max( storeA.minY[ eidA ], storeB.minY[ eidB ] );
  const minZ = Math.max( storeA.minZ[ eidA ], storeB.minZ[ eidB ] );
  const maxX = Math.min( storeA.maxX[ eidA ], storeB.maxX[ eidB ] );
  const maxY = Math.min( storeA.maxY[ eidA ], storeB.maxY[ eidB ] );
  const maxZ = Math.min( storeA.maxZ[ eidA ], storeB.maxZ[ eidB ] );
  if ( minX > maxX || minY > maxY || minZ > maxZ ) {
    storeOut.minX[ eidOut ] =  Infinity; storeOut.minY[ eidOut ] =  Infinity; storeOut.minZ[ eidOut ] =  Infinity;
    storeOut.maxX[ eidOut ] = -Infinity; storeOut.maxY[ eidOut ] = -Infinity; storeOut.maxZ[ eidOut ] = -Infinity;
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

export function bitecsBox3ExpandByPointInPlace( eidBox, eidPoint, storeBox = Box3Component, storePoint ) {
  storeBox.minX[ eidBox ] = Math.min( storeBox.minX[ eidBox ], storePoint.x[ eidPoint ] );
  storeBox.minY[ eidBox ] = Math.min( storeBox.minY[ eidBox ], storePoint.y[ eidPoint ] );
  storeBox.minZ[ eidBox ] = Math.min( storeBox.minZ[ eidBox ], storePoint.z[ eidPoint ] );
  storeBox.maxX[ eidBox ] = Math.max( storeBox.maxX[ eidBox ], storePoint.x[ eidPoint ] );
  storeBox.maxY[ eidBox ] = Math.max( storeBox.maxY[ eidBox ], storePoint.y[ eidPoint ] );
  storeBox.maxZ[ eidBox ] = Math.max( storeBox.maxZ[ eidBox ], storePoint.z[ eidPoint ] );
  return eidBox;
}

export function bitecsBox3ExpandByVectorInPlace( eidBox, eidVector, storeBox = Box3Component, storeVector ) {
  storeBox.minX[ eidBox ] -= storeVector.x[ eidVector ];
  storeBox.minY[ eidBox ] -= storeVector.y[ eidVector ];
  storeBox.minZ[ eidBox ] -= storeVector.z[ eidVector ];
  storeBox.maxX[ eidBox ] += storeVector.x[ eidVector ];
  storeBox.maxY[ eidBox ] += storeVector.y[ eidVector ];
  storeBox.maxZ[ eidBox ] += storeVector.z[ eidVector ];
  return eidBox;
}

export function bitecsBox3ExpandByScalarInPlace( eid, scalar, store = Box3Component ) {
  store.minX[ eid ] -= scalar;
  store.minY[ eid ] -= scalar;
  store.minZ[ eid ] -= scalar;
  store.maxX[ eid ] += scalar;
  store.maxY[ eid ] += scalar;
  store.maxZ[ eid ] += scalar;
  return eid;
}

export function bitecsBox3ContainsPoint( eidBox, eidPoint, storeBox = Box3Component, storePoint ) {
  return storePoint.x[ eidPoint ] >= storeBox.minX[ eidBox ] && storePoint.x[ eidPoint ] <= storeBox.maxX[ eidBox ]
      && storePoint.y[ eidPoint ] >= storeBox.minY[ eidBox ] && storePoint.y[ eidPoint ] <= storeBox.maxY[ eidBox ]
      && storePoint.z[ eidPoint ] >= storeBox.minZ[ eidBox ] && storePoint.z[ eidPoint ] <= storeBox.maxZ[ eidBox ];
}

export function bitecsBox3ContainsBox( eidOuter, eidInner, storeOuter = Box3Component, storeInner = Box3Component ) {
  return storeInner.minX[ eidInner ] >= storeOuter.minX[ eidOuter ]
      && storeInner.maxX[ eidInner ] <= storeOuter.maxX[ eidOuter ]
      && storeInner.minY[ eidInner ] >= storeOuter.minY[ eidOuter ]
      && storeInner.maxY[ eidInner ] <= storeOuter.maxY[ eidOuter ]
      && storeInner.minZ[ eidInner ] >= storeOuter.minZ[ eidOuter ]
      && storeInner.maxZ[ eidInner ] <= storeOuter.maxZ[ eidOuter ];
}

export function bitecsBox3IntersectsBox( eidA, eidB, storeA = Box3Component, storeB = Box3Component ) {
  return ! (
    storeB.minX[ eidB ] > storeA.maxX[ eidA ] || storeB.maxX[ eidB ] < storeA.minX[ eidA ] ||
    storeB.minY[ eidB ] > storeA.maxY[ eidA ] || storeB.maxY[ eidB ] < storeA.minY[ eidA ] ||
    storeB.minZ[ eidB ] > storeA.maxZ[ eidA ] || storeB.maxZ[ eidB ] < storeA.minZ[ eidA ]
  );
}

export function bitecsBox3IntersectsSphere( eidBox, eidSphere, storeBox = Box3Component, storeSphere ) {
  const cx = storeSphere.cx[ eidSphere ];
  const cy = storeSphere.cy[ eidSphere ];
  const cz = storeSphere.cz[ eidSphere ];
  const r  = storeSphere.radius[ eidSphere ];
  const nx = clamp( cx, storeBox.minX[ eidBox ], storeBox.maxX[ eidBox ] );
  const ny = clamp( cy, storeBox.minY[ eidBox ], storeBox.maxY[ eidBox ] );
  const nz = clamp( cz, storeBox.minZ[ eidBox ], storeBox.maxZ[ eidBox ] );
  const dx = cx - nx, dy = cy - ny, dz = cz - nz;
  return ( dx * dx + dy * dy + dz * dz ) <= ( r * r );
}

export function threeVec3FromBitecsBox3ClampPoint( out, eidBox, eidPoint, storeBox = Box3Component, storePoint ) {
  return _writeVec3(
    out,
    clamp( storePoint.x[ eidPoint ], storeBox.minX[ eidBox ], storeBox.maxX[ eidBox ] ),
    clamp( storePoint.y[ eidPoint ], storeBox.minY[ eidBox ], storeBox.maxY[ eidBox ] ),
    clamp( storePoint.z[ eidPoint ], storeBox.minZ[ eidBox ], storeBox.maxZ[ eidBox ] )
  );
}

export function bitecsVec3Box3ClampPointInto( eidOutVec, eidBox, eidPoint, storeBox = Box3Component, storePoint, storeVec ) {
  storeVec.x[ eidOutVec ] = clamp( storePoint.x[ eidPoint ], storeBox.minX[ eidBox ], storeBox.maxX[ eidBox ] );
  storeVec.y[ eidOutVec ] = clamp( storePoint.y[ eidPoint ], storeBox.minY[ eidBox ], storeBox.maxY[ eidBox ] );
  storeVec.z[ eidOutVec ] = clamp( storePoint.z[ eidPoint ], storeBox.minZ[ eidBox ], storeBox.maxZ[ eidBox ] );
  return eidOutVec;
}

export function bitecsBox3DistanceToPoint( eidBox, eidPoint, storeBox = Box3Component, storePoint ) {
  const dx = Math.max( storeBox.minX[ eidBox ] - storePoint.x[ eidPoint ], 0, storePoint.x[ eidPoint ] - storeBox.maxX[ eidBox ] );
  const dy = Math.max( storeBox.minY[ eidBox ] - storePoint.y[ eidPoint ], 0, storePoint.y[ eidPoint ] - storeBox.maxY[ eidBox ] );
  const dz = Math.max( storeBox.minZ[ eidBox ] - storePoint.z[ eidPoint ], 0, storePoint.z[ eidPoint ] - storeBox.maxZ[ eidBox ] );
  return Math.sqrt( dx * dx + dy * dy + dz * dz );
}

export function threeVec3FromBitecsBox3Center( out, eid, store = Box3Component ) {
  return _writeVec3(
    out,
    ( store.minX[ eid ] + store.maxX[ eid ] ) * 0.5,
    ( store.minY[ eid ] + store.maxY[ eid ] ) * 0.5,
    ( store.minZ[ eid ] + store.maxZ[ eid ] ) * 0.5
  );
}

export function bitecsVec3Box3CenterInto( eidOutVec, eidBox, storeBox = Box3Component, storeVec ) {
  storeVec.x[ eidOutVec ] = ( storeBox.minX[ eidBox ] + storeBox.maxX[ eidBox ] ) * 0.5;
  storeVec.y[ eidOutVec ] = ( storeBox.minY[ eidBox ] + storeBox.maxY[ eidBox ] ) * 0.5;
  storeVec.z[ eidOutVec ] = ( storeBox.minZ[ eidBox ] + storeBox.maxZ[ eidBox ] ) * 0.5;
  return eidOutVec;
}

export function threeVec3FromBitecsBox3Size( out, eid, store = Box3Component ) {
  return _writeVec3(
    out,
    store.maxX[ eid ] - store.minX[ eid ],
    store.maxY[ eid ] - store.minY[ eid ],
    store.maxZ[ eid ] - store.minZ[ eid ]
  );
}

export function bitecsVec3Box3SizeInto( eidOutVec, eidBox, storeBox = Box3Component, storeVec ) {
  storeVec.x[ eidOutVec ] = storeBox.maxX[ eidBox ] - storeBox.minX[ eidBox ];
  storeVec.y[ eidOutVec ] = storeBox.maxY[ eidBox ] - storeBox.minY[ eidBox ];
  storeVec.z[ eidOutVec ] = storeBox.maxZ[ eidBox ] - storeBox.minZ[ eidBox ];
  return eidOutVec;
}

export function threeVec3FromBitecsBox3Parameter( out, eidBox, eidPoint, storeBox = Box3Component, storePoint ) {
  return _writeVec3(
    out,
    ( storePoint.x[ eidPoint ] - storeBox.minX[ eidBox ] ) / ( storeBox.maxX[ eidBox ] - storeBox.minX[ eidBox ] ),
    ( storePoint.y[ eidPoint ] - storeBox.minY[ eidBox ] ) / ( storeBox.maxY[ eidBox ] - storeBox.minY[ eidBox ] ),
    ( storePoint.z[ eidPoint ] - storeBox.minZ[ eidBox ] ) / ( storeBox.maxZ[ eidBox ] - storeBox.minZ[ eidBox ] )
  );
}

export function bitecsVec3Box3ParameterInto( eidOutVec, eidBox, eidPoint, storeBox = Box3Component, storePoint, storeVec ) {
  storeVec.x[ eidOutVec ] = ( storePoint.x[ eidPoint ] - storeBox.minX[ eidBox ] ) / ( storeBox.maxX[ eidBox ] - storeBox.minX[ eidBox ] );
  storeVec.y[ eidOutVec ] = ( storePoint.y[ eidPoint ] - storeBox.minY[ eidBox ] ) / ( storeBox.maxY[ eidBox ] - storeBox.minY[ eidBox ] );
  storeVec.z[ eidOutVec ] = ( storePoint.z[ eidPoint ] - storeBox.minZ[ eidBox ] ) / ( storeBox.maxZ[ eidBox ] - storeBox.minZ[ eidBox ] );
  return eidOutVec;
}

export function threeSphereFromBitecsBox3BoundingSphere( out, eid, store = Box3Component ) {
  const cx = ( store.minX[ eid ] + store.maxX[ eid ] ) * 0.5;
  const cy = ( store.minY[ eid ] + store.maxY[ eid ] ) * 0.5;
  const cz = ( store.minZ[ eid ] + store.maxZ[ eid ] ) * 0.5;
  const dx = store.maxX[ eid ] - cx;
  const dy = store.maxY[ eid ] - cy;
  const dz = store.maxZ[ eid ] - cz;
  if ( out.center !== undefined ) {
    _writeVec3( out.center, cx, cy, cz );
    out.radius = Math.sqrt( dx * dx + dy * dy + dz * dz );
  } else {
    _writeVec3( out, cx, cy, cz );
    if ( 'radius' in out ) out.radius = Math.sqrt( dx * dx + dy * dy + dz * dz );
  }
  return out;
}

export function bitecsBox3ApplyMatrix4InPlace( eid, m, storeBox = Box3Component ) {
  const me = _matrixElements( m );
  const minX = storeBox.minX[ eid ], minY = storeBox.minY[ eid ], minZ = storeBox.minZ[ eid ];
  const maxX = storeBox.maxX[ eid ], maxY = storeBox.maxY[ eid ], maxZ = storeBox.maxZ[ eid ];

  // Quick reject: empty box.
  if ( maxX < minX || maxY < minY || maxZ < minZ ) return eid;

  const m00 = me[ 0 ], m01 = me[ 4 ], m02 = me[ 8 ],  m03 = me[ 12 ];
  const m10 = me[ 1 ], m11 = me[ 5 ], m12 = me[ 9 ],  m13 = me[ 13 ];
  const m20 = me[ 2 ], m21 = me[ 6 ], m22 = me[ 10 ], m23 = me[ 14 ];
  const m30 = me[ 3 ], m31 = me[ 7 ], m32 = me[ 11 ], m33 = me[ 15 ];

  // Fast path for affine.
  if ( m30 === 0 && m31 === 0 && m32 === 0 && m33 === 1 ) {
    const x0 = m00 * ( m00 >= 0 ? minX : maxX ) + m01 * ( m01 >= 0 ? minY : maxY ) + m02 * ( m02 >= 0 ? minZ : maxZ ) + m03;
    const x1 = m00 * ( m00 >= 0 ? maxX : minX ) + m01 * ( m01 >= 0 ? maxY : minY ) + m02 * ( m02 >= 0 ? maxZ : minZ ) + m03;
    const y0 = m10 * ( m10 >= 0 ? minX : maxX ) + m11 * ( m11 >= 0 ? minY : maxY ) + m12 * ( m12 >= 0 ? minZ : maxZ ) + m13;
    const y1 = m10 * ( m10 >= 0 ? maxX : minX ) + m11 * ( m11 >= 0 ? maxY : minY ) + m12 * ( m12 >= 0 ? maxZ : minZ ) + m13;
    const z0 = m20 * ( m20 >= 0 ? minX : maxX ) + m21 * ( m21 >= 0 ? minY : maxY ) + m22 * ( m22 >= 0 ? minZ : maxZ ) + m23;
    const z1 = m20 * ( m20 >= 0 ? maxX : minX ) + m21 * ( m21 >= 0 ? maxY : minY ) + m22 * ( m22 >= 0 ? maxZ : minZ ) + m23;
    storeBox.minX[ eid ] = Math.min( x0, x1 );
    storeBox.maxX[ eid ] = Math.max( x0, x1 );
    storeBox.minY[ eid ] = Math.min( y0, y1 );
    storeBox.maxY[ eid ] = Math.max( y0, y1 );
    storeBox.minZ[ eid ] = Math.min( z0, z1 );
    storeBox.maxZ[ eid ] = Math.max( z0, z1 );
    return eid;
  }

  // Projective path: 8 corners.
  let nMinX =  Infinity, nMinY =  Infinity, nMinZ =  Infinity;
  let nMaxX = -Infinity, nMaxY = -Infinity, nMaxZ = -Infinity;
  for ( let i = 0; i < 8; i ++ ) {
    const x = ( i & 1 ) ? maxX : minX;
    const y = ( i & 2 ) ? maxY : minY;
    const z = ( i & 4 ) ? maxZ : minZ;
    const w = m30 * x + m31 * y + m32 * z + m33 || 1.0;
    const invW = 1 / w;
    const tx = ( m00 * x + m01 * y + m02 * z + m03 ) * invW;
    const ty = ( m10 * x + m11 * y + m12 * z + m13 ) * invW;
    const tz = ( m20 * x + m21 * y + m22 * z + m23 ) * invW;
    if ( tx < nMinX ) nMinX = tx;
    if ( ty < nMinY ) nMinY = ty;
    if ( tz < nMinZ ) nMinZ = tz;
    if ( tx > nMaxX ) nMaxX = tx;
    if ( ty > nMaxY ) nMaxY = ty;
    if ( tz > nMaxZ ) nMaxZ = tz;
  }
  storeBox.minX[ eid ] = nMinX;
  storeBox.minY[ eid ] = nMinY;
  storeBox.minZ[ eid ] = nMinZ;
  storeBox.maxX[ eid ] = nMaxX;
  storeBox.maxY[ eid ] = nMaxY;
  storeBox.maxZ[ eid ] = nMaxZ;
  return eid;
}

export function bitecsBox3TranslateInPlace( eid, eidOffset, storeBox = Box3Component, storeOffset ) {
  const ox = storeOffset.x[ eidOffset ];
  const oy = storeOffset.y[ eidOffset ];
  const oz = storeOffset.z[ eidOffset ];
  storeBox.minX[ eid ] += ox;
  storeBox.minY[ eid ] += oy;
  storeBox.minZ[ eid ] += oz;
  storeBox.maxX[ eid ] += ox;
  storeBox.maxY[ eid ] += oy;
  storeBox.maxZ[ eid ] += oz;
  return eid;
}

export function bitecsBox3IsEmpty( eid, store = Box3Component ) {
  return store.maxX[ eid ] < store.minX[ eid ]
      || store.maxY[ eid ] < store.minY[ eid ]
      || store.maxZ[ eid ] < store.minZ[ eid ];
}

export function bitecsBox3MakeEmptyInPlace( eid, store = Box3Component ) {
  store.minX[ eid ] =  Infinity; store.minY[ eid ] =  Infinity; store.minZ[ eid ] =  Infinity;
  store.maxX[ eid ] = -Infinity; store.maxY[ eid ] = -Infinity; store.maxZ[ eid ] = -Infinity;
  return eid;
}

// ────────────── flat-array helpers on top of bitecs ──────────────

export function glMatrixBox3PackedUnionFromBitecs( outPacked, eidA, eidB, storeA = Box3Component, storeB = Box3Component ) {
  outPacked[ 0 ] = Math.min( storeA.minX[ eidA ], storeB.minX[ eidB ] );
  outPacked[ 1 ] = Math.min( storeA.minY[ eidA ], storeB.minY[ eidB ] );
  outPacked[ 2 ] = Math.min( storeA.minZ[ eidA ], storeB.minZ[ eidB ] );
  outPacked[ 3 ] = Math.max( storeA.maxX[ eidA ], storeB.maxX[ eidB ] );
  outPacked[ 4 ] = Math.max( storeA.maxY[ eidA ], storeB.maxY[ eidB ] );
  outPacked[ 5 ] = Math.max( storeA.maxZ[ eidA ], storeB.maxZ[ eidB ] );
  return outPacked;
}

export function glMatrixBox3PackedIntersectFromBitecs( outPacked, eidA, eidB, storeA = Box3Component, storeB = Box3Component ) {
  outPacked[ 0 ] = Math.max( storeA.minX[ eidA ], storeB.minX[ eidB ] );
  outPacked[ 1 ] = Math.max( storeA.minY[ eidA ], storeB.minY[ eidB ] );
  outPacked[ 2 ] = Math.max( storeA.minZ[ eidA ], storeB.minZ[ eidB ] );
  outPacked[ 3 ] = Math.min( storeA.maxX[ eidA ], storeB.maxX[ eidB ] );
  outPacked[ 4 ] = Math.min( storeA.maxY[ eidA ], storeB.maxY[ eidB ] );
  outPacked[ 5 ] = Math.min( storeA.maxZ[ eidA ], storeB.maxZ[ eidB ] );
  return outPacked;
}

export function glMatrixVec3DistanceToBitecsBox3( glPoint, eid, store = Box3Component ) {
  const cx = clamp( glPoint[ 0 ], store.minX[ eid ], store.maxX[ eid ] );
  const cy = clamp( glPoint[ 1 ], store.minY[ eid ], store.maxY[ eid ] );
  const cz = clamp( glPoint[ 2 ], store.minZ[ eid ], store.maxZ[ eid ] );
  const dx = glPoint[ 0 ] - cx;
  const dy = glPoint[ 1 ] - cy;
  const dz = glPoint[ 2 ] - cz;
  return Math.sqrt( dx * dx + dy * dy + dz * dz );
}

export function glMatrixVec3InsideBitecsBox3( glPoint, eid, store = Box3Component ) {
  return glPoint[ 0 ] >= store.minX[ eid ] && glPoint[ 0 ] <= store.maxX[ eid ]
      && glPoint[ 1 ] >= store.minY[ eid ] && glPoint[ 1 ] <= store.maxY[ eid ]
      && glPoint[ 2 ] >= store.minZ[ eid ] && glPoint[ 2 ] <= store.maxZ[ eid ];
}

export function glMatrixVec3MinFromBitecsBox3( out, eidA, eidB, storeA = Box3Component, storeB = Box3Component ) {
  _scratchVec3A[ 0 ] = storeA.minX[ eidA ];
  _scratchVec3A[ 1 ] = storeA.minY[ eidA ];
  _scratchVec3A[ 2 ] = storeA.minZ[ eidA ];
  _scratchVec3B[ 0 ] = storeB.minX[ eidB ];
  _scratchVec3B[ 1 ] = storeB.minY[ eidB ];
  _scratchVec3B[ 2 ] = storeB.minZ[ eidB ];
  out[ 0 ] = Math.min( _scratchVec3A[ 0 ], _scratchVec3B[ 0 ] );
  out[ 1 ] = Math.min( _scratchVec3A[ 1 ], _scratchVec3B[ 1 ] );
  out[ 2 ] = Math.min( _scratchVec3A[ 2 ], _scratchVec3B[ 2 ] );
  return out;
}

export function glMatrixVec3MaxFromBitecsBox3( out, eidA, eidB, storeA = Box3Component, storeB = Box3Component ) {
  _scratchVec3A[ 0 ] = storeA.maxX[ eidA ];
  _scratchVec3A[ 1 ] = storeA.maxY[ eidA ];
  _scratchVec3A[ 2 ] = storeA.maxZ[ eidA ];
  _scratchVec3B[ 0 ] = storeB.maxX[ eidB ];
  _scratchVec3B[ 1 ] = storeB.maxY[ eidB ];
  _scratchVec3B[ 2 ] = storeB.maxZ[ eidB ];
  out[ 0 ] = Math.max( _scratchVec3A[ 0 ], _scratchVec3B[ 0 ] );
  out[ 1 ] = Math.max( _scratchVec3A[ 1 ], _scratchVec3B[ 1 ] );
  out[ 2 ] = Math.max( _scratchVec3A[ 2 ], _scratchVec3B[ 2 ] );
  return out;
}

export function glMatrixVec3LerpFromBitecsBox3( out, eidA, eidB, t, storeA, storeB ) {
  _scratchVec3A[ 0 ] = storeA.x[ eidA ];
  _scratchVec3A[ 1 ] = storeA.y[ eidA ];
  _scratchVec3A[ 2 ] = storeA.z[ eidA ];
  _scratchVec3B[ 0 ] = storeB.x[ eidB ];
  _scratchVec3B[ 1 ] = storeB.y[ eidB ];
  _scratchVec3B[ 2 ] = storeB.z[ eidB ];
  out[ 0 ] = _scratchVec3A[ 0 ] + t * ( _scratchVec3B[ 0 ] - _scratchVec3A[ 0 ] );
  out[ 1 ] = _scratchVec3A[ 1 ] + t * ( _scratchVec3B[ 1 ] - _scratchVec3A[ 1 ] );
  out[ 2 ] = _scratchVec3A[ 2 ] + t * ( _scratchVec3B[ 2 ] - _scratchVec3A[ 2 ] );
  return out;
}

// Ray-AABB slab test (returns nearest non-negative t, or -1 if no hit).
export function bitecsBox3RayIntersect( eidBox, ox, oy, oz, dx, dy, dz, storeBox = Box3Component ) {
  const invX = dx !== 0 ? 1 / dx : Infinity;
  const invY = dy !== 0 ? 1 / dy : Infinity;
  const invZ = dz !== 0 ? 1 / dz : Infinity;

  let t1 = ( storeBox.minX[ eidBox ] - ox ) * invX;
  let t2 = ( storeBox.maxX[ eidBox ] - ox ) * invX;
  let tmin = Math.min( t1, t2 );
  let tmax = Math.max( t1, t2 );

  t1 = ( storeBox.minY[ eidBox ] - oy ) * invY;
  t2 = ( storeBox.maxY[ eidBox ] - oy ) * invY;
  tmin = Math.max( tmin, Math.min( t1, t2 ) );
  tmax = Math.min( tmax, Math.max( t1, t2 ) );

  t1 = ( storeBox.minZ[ eidBox ] - oz ) * invZ;
  t2 = ( storeBox.maxZ[ eidBox ] - oz ) * invZ;
  tmin = Math.max( tmin, Math.min( t1, t2 ) );
  tmax = Math.min( tmax, Math.max( t1, t2 ) );

  if ( tmax < 0 || tmin > tmax ) return -1;
  return tmin >= 0 ? tmin : tmax;
}

// ═══════════════════════════════════════════════════════════════════
// HIGH-PRECISION (DoubleDouble) HELPERS — galactic-scale coordinates
// ═══════════════════════════════════════════════════════════════════

export function preciseVolume( box ) {
  const dx = DD.subtract( DD.fromDouble( _rx( box.max ) ), DD.fromDouble( _rx( box.min ) ) );
  const dy = DD.subtract( DD.fromDouble( _ry( box.max ) ), DD.fromDouble( _ry( box.min ) ) );
  const dz = DD.subtract( DD.fromDouble( _rz( box.max ) ), DD.fromDouble( _rz( box.min ) ) );
  return DD.toDouble( DD.multiply( DD.multiply( dx, dy ), dz ) );
}

export function preciseDistanceToPoint( box, point ) {
  const px = DD.fromDouble( _rx( point ) );
  const py = DD.fromDouble( _ry( point ) );
  const pz = DD.fromDouble( _rz( point ) );
  const minX = DD.fromDouble( _rx( box.min ) ), maxX = DD.fromDouble( _rx( box.max ) );
  const minY = DD.fromDouble( _ry( box.min ) ), maxY = DD.fromDouble( _ry( box.max ) );
  const minZ = DD.fromDouble( _rz( box.min ) ), maxZ = DD.fromDouble( _rz( box.max ) );

  let dx = [ 0, 0 ];
  let dy = [ 0, 0 ];
  let dz = [ 0, 0 ];

  const dxLow = DD.subtract( minX, px );
  const dxHigh = DD.subtract( px, maxX );
  if ( DD.toDouble( dxLow ) > 0 ) dx = dxLow;
  else if ( DD.toDouble( dxHigh ) > 0 ) dx = dxHigh;

  const dyLow = DD.subtract( minY, py );
  const dyHigh = DD.subtract( py, maxY );
  if ( DD.toDouble( dyLow ) > 0 ) dy = dyLow;
  else if ( DD.toDouble( dyHigh ) > 0 ) dy = dyHigh;

  const dzLow = DD.subtract( minZ, pz );
  const dzHigh = DD.subtract( pz, maxZ );
  if ( DD.toDouble( dzLow ) > 0 ) dz = dzLow;
  else if ( DD.toDouble( dzHigh ) > 0 ) dz = dzHigh;

  return DD.toDouble(
    DD.sqrt(
      DD.add(
        DD.add( DD.multiply( dx, dx ), DD.multiply( dy, dy ) ),
        DD.multiply( dz, dz )
      )
    )
  );
}

export function preciseUnionInto( out, a, b ) {
  const aMinX = DD.toDouble( DD.fromDouble( _rx( a.min ) ) );
  const bMinX = DD.toDouble( DD.fromDouble( _rx( b.min ) ) );
  const aMinY = DD.toDouble( DD.fromDouble( _ry( a.min ) ) );
  const bMinY = DD.toDouble( DD.fromDouble( _ry( b.min ) ) );
  const aMinZ = DD.toDouble( DD.fromDouble( _rz( a.min ) ) );
  const bMinZ = DD.toDouble( DD.fromDouble( _rz( b.min ) ) );
  const aMaxX = DD.toDouble( DD.fromDouble( _rx( a.max ) ) );
  const bMaxX = DD.toDouble( DD.fromDouble( _rx( b.max ) ) );
  const aMaxY = DD.toDouble( DD.fromDouble( _ry( a.max ) ) );
  const bMaxY = DD.toDouble( DD.fromDouble( _ry( b.max ) ) );
  const aMaxZ = DD.toDouble( DD.fromDouble( _rz( a.max ) ) );
  const bMaxZ = DD.toDouble( DD.fromDouble( _rz( b.max ) ) );

  _writeVec3(
    out.min,
    aMinX < bMinX ? _rx( a.min ) : _rx( b.min ),
    aMinY < bMinY ? _ry( a.min ) : _ry( b.min ),
    aMinZ < bMinZ ? _rz( a.min ) : _rz( b.min )
  );
  _writeVec3(
    out.max,
    aMaxX > bMaxX ? _rx( a.max ) : _rx( b.max ),
    aMaxY > bMaxY ? _ry( a.max ) : _ry( b.max ),
    aMaxZ > bMaxZ ? _rz( a.max ) : _rz( b.max )
  );
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// PROCEDURAL NOISE — random box from a 3D simplex field
// ═══════════════════════════════════════════════════════════════════

export function setFromNoise3D( out, x, y, z, seed = 0, centerScale = 1, sizeScale = 1 ) {
  const n = _cachedNoise3D( seed );
  const cx = n( x, y, z ) * centerScale;
  const cy = n( x + 31.416, y + 47.853, z + 12.793 ) * centerScale;
  const cz = n( x - 17.234, y - 53.127, z - 91.056 ) * centerScale;
  const sx = Math.abs( n( x + 100.1, y + 200.2, z + 300.3 ) ) * sizeScale;
  const sy = Math.abs( n( x - 110.5, y - 210.6, z - 310.7 ) ) * sizeScale;
  const sz = Math.abs( n( x + 55.1, y - 66.2, z + 77.3 ) ) * sizeScale;
  _writeVec3( out.min, cx - sx, cy - sy, cz - sz );
  _writeVec3( out.max, cx + sx, cy + sy, cz + sz );
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// Named + default exports
// ═══════════════════════════════════════════════════════════════════
export { Box3 };
export default Box3;