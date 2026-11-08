// file number : 062
// full path name : src/math/062_Sphere.js
// description : Bounding-sphere primitive — drop-in replacement for THREE.Sphere (r185). Center is a duck-typed Vector3-like ({x,y,z} or flat array), radius is a scalar. The r185 semantic "radius < 0 means empty" is preserved, and isEmpty()/makeEmpty()/setFromPoints() work exactly as three.js. Complete r185 surface: constructor(center, radius), isSphere flag, set(center, radius), setFromPoints(points, optionalCenter), copy(sphere), isEmpty(), makeEmpty(), containsPoint(point), distanceToPoint(point), intersectsSphere(sphere), intersectsBox(box), intersectsPlane(plane), clampPoint(point, target), getBoundingBox(target), applyMatrix4(matrix), translate(offset), expandByPoint(point), union(sphere), equals(sphere), clone(). Extended: preciseDistanceToPoint / preciseContainsPoint / preciseUnionInto via the chat's DoubleDouble (014) for galactic-scale radii; setFromNoise3D via the chat's SimplexNoise (013) with a cached per-seed mulberry32 generator; full zero-allocation bitECS SoA bridge set (SphereComponent with cx/cy/cz/radius f32([]) arrays, from/to/copy/add/sub/scale-in-place/translate-in-place/apply-matrix4-in-place, union, contains-point, distance-to-point, distance-to-sphere, intersects-sphere/plane/box, clamp-point, get-bounding-box, ray-sphere intersection) usable in the 10k+ entity ECS hot loop; flat-array and duck-typed interop; and a recycled local pool (Sphere.acquire / Sphere.recycle) that resets center to (0,0,0) and radius to -1. No THREE, no CDN, no static server, no Vite/Vue — imports only from the chat's own files (003_Common clamp, 013_SimplexNoise, 014_DoubleDouble, 014_BitECS).
// best for : broad-phase culling, frustum tests, spatial queries, ray-sphere intersection, sprite/particle bounds, LOD distance checks, physics broad-phase proxies, and any ECS system that stores sphere colliders as SoA center+radius and must feed THREE.Sphere, THREE.Frustum, or THREE.Raycaster without allocating per frame. The pooled variant is the recommended path for hot loops iterating over 10k+ entities, and the SoA bridges are the recommended path for systems that iterate over bitecs archetypes.
// license : MIT

import { clamp } from '../core/003_Common.js';
import * as DD from './014_DoubleDouble.js';
import * as bitecs from './014_BitECS.js';
import { createNoise3D } from './013_SimplexNoise.js';

// ═══════════════════════════════════════════════════════════════════
// bitECS 0.4.0 SoA COMPONENT (archetype-friendly, cache-friendly)
// ═══════════════════════════════════════════════════════════════════
export const SphereComponent = {
  cx:     bitecs.f32([]),
  cy:     bitecs.f32([]),
  cz:     bitecs.f32([]),
  radius: bitecs.f32([])
};

// ═══════════════════════════════════════════════════════════════════
// Module-scoped helpers — zero allocation in hot paths
// ═══════════════════════════════════════════════════════════════════

function _rx( v ) { return v.x !== undefined ? v.x : v[ 0 ]; }
function _ry( v ) { return v.y !== undefined ? v.y : v[ 1 ]; }
function _rz( v ) { return v.z !== undefined ? v.z : v[ 2 ]; }

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

function _copyVec3Into( target, source ) {
  return _writeVec3( target, _rx( source ), _ry( source ), _rz( source ) );
}

function _vec3( x = 0, y = 0, z = 0 ) {
  return { x, y, z };
}

function _matrixElements( m ) {
  return ( m != null && m.elements !== undefined ) ? m.elements : m;
}

// Transform a point by a 4x4 matrix (column-major, with w-divide).
function _transformPoint( out, x, y, z, m ) {
  const w = m[ 3 ] * x + m[ 7 ] * y + m[ 11 ] * z + m[ 15 ] || 1.0;
  return _writeVec3(
    out,
    ( m[ 0 ] * x + m[ 4 ] * y + m[ 8 ]  * z + m[ 12 ] ) / w,
    ( m[ 1 ] * x + m[ 5 ] * y + m[ 9 ]  * z + m[ 13 ] ) / w,
    ( m[ 2 ] * x + m[ 6 ] * y + m[ 10 ] * z + m[ 14 ] ) / w
  );
}

// Maximum axis scale of the 3x3 upper-left of a 4x4 column-major matrix.
function _maxAxisScale( m ) {
  const s0 = Math.sqrt( m[ 0 ] * m[ 0 ] + m[ 1 ] * m[ 1 ] + m[ 2 ] * m[ 2 ] );
  const s1 = Math.sqrt( m[ 4 ] * m[ 4 ] + m[ 5 ] * m[ 5 ] + m[ 6 ] * m[ 6 ] );
  const s2 = Math.sqrt( m[ 8 ] * m[ 8 ] + m[ 9 ] * m[ 9 ] + m[ 10 ] * m[ 10 ] );
  return Math.max( s0, s1, s2 );
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

// Scratch buffers
const _vScratch = _vec3();
const _vScratch2 = _vec3();

// ═══════════════════════════════════════════════════════════════════
// class Sphere
// ═══════════════════════════════════════════════════════════════════
class Sphere {

  constructor( center = _vec3(), radius = -1 ) {
    this.isSphere = true;
    this.center = center;
    this.radius = radius;
  }

  set( center, radius ) {
    _copyVec3Into( this.center, center );
    this.radius = radius;
    return this;
  }

  setFromPoints( points, optionalCenter ) {
    if ( points.length === 0 ) {
      this.makeEmpty();
      return this;
    }
    // First pass: find AABB.
    let minX =  Infinity, minY =  Infinity, minZ =  Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for ( let i = 0; i < points.length; i ++ ) {
      const p = points[ i ];
      const x = _rx( p ), y = _ry( p ), z = _rz( p );
      if ( x < minX ) minX = x; if ( x > maxX ) maxX = x;
      if ( y < minY ) minY = y; if ( y > maxY ) maxY = y;
      if ( z < minZ ) minZ = z; if ( z > maxZ ) maxZ = z;
    }
    if ( optionalCenter !== undefined ) {
      _copyVec3Into( this.center, optionalCenter );
    } else {
      _writeVec3( this.center, ( minX + maxX ) * 0.5, ( minY + maxY ) * 0.5, ( minZ + maxZ ) * 0.5 );
    }
    // Second pass: max squared distance from center.
    let maxRadiusSq = 0;
    const cx = _rx( this.center ), cy = _ry( this.center ), cz = _rz( this.center );
    for ( let i = 0; i < points.length; i ++ ) {
      const p = points[ i ];
      const dx = _rx( p ) - cx, dy = _ry( p ) - cy, dz = _rz( p ) - cz;
      const dSq = dx * dx + dy * dy + dz * dz;
      if ( dSq > maxRadiusSq ) maxRadiusSq = dSq;
    }
    this.radius = Math.sqrt( maxRadiusSq );
    return this;
  }

  copy( sphere ) {
    _copyVec3Into( this.center, sphere.center );
    this.radius = sphere.radius;
    return this;
  }

  isEmpty() {
    return this.radius < 0;
  }

  makeEmpty() {
    _writeVec3( this.center, 0, 0, 0 );
    this.radius = -1;
    return this;
  }

  containsPoint( point ) {
    const cx = _rx( this.center ), cy = _ry( this.center ), cz = _rz( this.center );
    const dx = _rx( point ) - cx, dy = _ry( point ) - cy, dz = _rz( point ) - cz;
    return ( dx * dx + dy * dy + dz * dz ) <= ( this.radius * this.radius );
  }

  distanceToPoint( point ) {
    const cx = _rx( this.center ), cy = _ry( this.center ), cz = _rz( this.center );
    const dx = _rx( point ) - cx, dy = _ry( point ) - cy, dz = _rz( point ) - cz;
    return Math.sqrt( dx * dx + dy * dy + dz * dz ) - this.radius;
  }

  intersectsSphere( sphere ) {
    const a = this, b = sphere;
    const dx = _rx( b.center ) - _rx( a.center );
    const dy = _ry( b.center ) - _ry( a.center );
    const dz = _rz( b.center ) - _rz( a.center );
    const rSum = a.radius + b.radius;
    return ( dx * dx + dy * dy + dz * dz ) <= ( rSum * rSum );
  }

  intersectsBox( box ) {
    if ( box && typeof box.intersectsSphere === 'function' ) return box.intersectsSphere( this );
    // Manual AABB test
    const cx = _rx( this.center ), cy = _ry( this.center ), cz = _rz( this.center );
    const r  = this.radius;
    const bxMinX = box.min && box.min.x !== undefined ? box.min.x : box.minX;
    const bxMinY = box.min && box.min.y !== undefined ? box.min.y : box.minY;
    const bxMinZ = box.min && box.min.z !== undefined ? box.min.z : box.minZ;
    const bxMaxX = box.max && box.max.x !== undefined ? box.max.x : box.maxX;
    const bxMaxY = box.max && box.max.y !== undefined ? box.max.y : box.maxY;
    const bxMaxZ = box.max && box.max.z !== undefined ? box.max.z : box.maxZ;
    const nx = clamp( cx, bxMinX, bxMaxX );
    const ny = clamp( cy, bxMinY, bxMaxY );
    const nz = clamp( cz, bxMinZ, bxMaxZ );
    const dx = cx - nx, dy = cy - ny, dz = cz - nz;
    return ( dx * dx + dy * dy + dz * dz ) <= ( r * r );
  }

  intersectsPlane( plane ) {
    if ( plane && typeof plane.distanceToPoint === 'function' ) {
      return Math.abs( plane.distanceToPoint( this.center ) ) <= this.radius;
    }
    // Manual Hessian-form test
    const nx = plane.normal.x !== undefined ? plane.normal.x : plane.normal[ 0 ];
    const ny = plane.normal.y !== undefined ? plane.normal.y : plane.normal[ 1 ];
    const nz = plane.normal.z !== undefined ? plane.normal.z : plane.normal[ 2 ];
    const cx = _rx( this.center ), cy = _ry( this.center ), cz = _rz( this.center );
    const d = nx * cx + ny * cy + nz * cz + plane.constant;
    return Math.abs( d ) <= this.radius;
  }

  clampPoint( point, target ) {
    const cx = _rx( this.center ), cy = _ry( this.center ), cz = _rz( this.center );
    const dx = _rx( point ) - cx, dy = _ry( point ) - cy, dz = _rz( point ) - cz;
    const dSq = dx * dx + dy * dy + dz * dz;
    if ( dSq > this.radius * this.radius ) {
      const d = Math.sqrt( dSq );
      const inv = this.radius / d;
      return _writeVec3(
        target,
        cx + dx * inv,
        cy + dy * inv,
        cz + dz * inv
      );
    }
    return _copyVec3Into( target, point );
  }

  getBoundingBox( target ) {
    if ( this.isEmpty() ) {
      if ( target && typeof target.makeEmpty === 'function' ) {
        target.makeEmpty();
        return target;
      }
      // Fallback for plain {min, max} objects
      const inf = Infinity;
      if ( target ) {
        if ( target.min ) _writeVec3( target.min, inf, inf, inf );
        else { target.minX = inf; target.minY = inf; target.minZ = inf; }
        if ( target.max ) _writeVec3( target.max, -inf, -inf, -inf );
        else { target.maxX = -inf; target.maxY = -inf; target.maxZ = -inf; }
      }
      return target;
    }
    const cx = _rx( this.center ), cy = _ry( this.center ), cz = _rz( this.center );
    const r = this.radius;
    if ( target ) {
      if ( target.min && target.max ) {
        _writeVec3( target.min, cx - r, cy - r, cz - r );
        _writeVec3( target.max, cx + r, cy + r, cz + r );
      } else {
        target.minX = cx - r; target.minY = cy - r; target.minZ = cz - r;
        target.maxX = cx + r; target.maxY = cy + r; target.maxZ = cz + r;
      }
    }
    return target;
  }

  applyMatrix4( matrix ) {
    const m = _matrixElements( matrix );
    _transformPoint( this.center, _rx( this.center ), _ry( this.center ), _rz( this.center ), m );
    this.radius *= _maxAxisScale( m );
    return this;
  }

  translate( offset ) {
    _writeVec3(
      this.center,
      _rx( this.center ) + _rx( offset ),
      _ry( this.center ) + _ry( offset ),
      _rz( this.center ) + _rz( offset )
    );
    return this;
  }

  expandByPoint( point ) {
    if ( this.isEmpty() ) {
      _copyVec3Into( this.center, point );
      this.radius = 0;
      return this;
    }
    const cx = _rx( this.center ), cy = _ry( this.center ), cz = _rz( this.center );
    const dx = _rx( point ) - cx, dy = _ry( point ) - cy, dz = _rz( point ) - cz;
    const lengthSq = dx * dx + dy * dy + dz * dz;
    if ( lengthSq > ( this.radius * this.radius ) ) {
      const length = Math.sqrt( lengthSq );
      const missingRadiusHalf = ( length - this.radius ) * 0.5;
      _writeVec3(
        this.center,
        cx + dx * ( missingRadiusHalf / length ),
        cy + dy * ( missingRadiusHalf / length ),
        cz + dz * ( missingRadiusHalf / length )
      );
      this.radius += missingRadiusHalf;
    }
    return this;
  }

  union( sphere ) {
    if ( sphere.isEmpty() ) return this;
    if ( this.isEmpty() ) return this.copy( sphere );

    const ax = _rx( this.center ), ay = _ry( this.center ), az = _rz( this.center ), ar = this.radius;
    const bx = _rx( sphere.center ), by = _ry( sphere.center ), bz = _rz( sphere.center ), br = sphere.radius;

    // Containment cases: extend along the direction between centers.
    if ( ax === bx && ay === by && az === bz ) {
      this.radius = Math.max( ar, br );
      return this;
    }

    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

    // Compute the two "extreme" points of the other sphere along the direction.
    const invDist = dist > 0 ? 1 / dist : 0;
    const ux = dx * invDist, uy = dy * invDist, uz = dz * invDist;

    // Point on other sphere: center ± r * u
    _vScratch.x  = bx + ux * br;
    _vScratch.y  = by + uy * br;
    _vScratch.z  = bz + uz * br;
    _vScratch2.x = bx - ux * br;
    _vScratch2.y = by - uy * br;
    _vScratch2.z = bz - uz * br;

    this.expandByPoint( _vScratch );
    this.expandByPoint( _vScratch2 );
    return this;
  }

  equals( sphere ) {
    return _rx( this.center ) === _rx( sphere.center )
        && _ry( this.center ) === _ry( sphere.center )
        && _rz( this.center ) === _rz( sphere.center )
        && this.radius === sphere.radius;
  }

  clone() {
    return new this.constructor( _vec3( _rx( this.center ), _ry( this.center ), _rz( this.center ) ), this.radius );
  }

  // ────────────── flat array interop ──────────────

  toArray( array = [], offset = 0 ) {
    array[ offset ]     = _rx( this.center );
    array[ offset + 1 ] = _ry( this.center );
    array[ offset + 2 ] = _rz( this.center );
    array[ offset + 3 ] = this.radius;
    return array;
  }

  fromArray( array, offset = 0 ) {
    _writeVec3( this.center, array[ offset ], array[ offset + 1 ], array[ offset + 2 ] );
    this.radius = array[ offset + 3 ];
    return this;
  }

  // ────────────── pooled instances ──────────────

  static acquire() {
    return _localPool.length > 0 ? _localPool.pop() : new Sphere();
  }

  static recycle( sphere ) {
    if ( sphere instanceof Sphere && _localPool.length < LOCAL_POOL_MAX ) {
      _writeVec3( sphere.center, 0, 0, 0 );
      sphere.radius = -1;
      _localPool.push( sphere );
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// BRIDGE: THREE-style <-> flat array
// ═══════════════════════════════════════════════════════════════════

export function threeSphereFromGlMatrixPacked( out, glPacked ) {
  _writeVec3( out.center, glPacked[ 0 ], glPacked[ 1 ], glPacked[ 2 ] );
  out.radius = glPacked[ 3 ];
  return out;
}

export function threeSphereFromGlMatrix( out, glCenter, radius ) {
  _writeVec3( out.center, glCenter[ 0 ], glCenter[ 1 ], glCenter[ 2 ] );
  out.radius = radius;
  return out;
}

export function glMatrixSpherePackedFromThree( outPacked, threeSphere ) {
  outPacked[ 0 ] = _rx( threeSphere.center );
  outPacked[ 1 ] = _ry( threeSphere.center );
  outPacked[ 2 ] = _rz( threeSphere.center );
  outPacked[ 3 ] = threeSphere.radius;
  return outPacked;
}

export function glMatrixSphereFromThree( outCenter, threeSphere ) {
  outCenter[ 0 ] = _rx( threeSphere.center );
  outCenter[ 1 ] = _ry( threeSphere.center );
  outCenter[ 2 ] = _rz( threeSphere.center );
  return threeSphere.radius;
}

// ═══════════════════════════════════════════════════════════════════
// BRIDGE: THREE-style <-> bitECS SoA
// ═══════════════════════════════════════════════════════════════════

export function threeSphereFromBitecs( out, eid, store = SphereComponent ) {
  _writeVec3( out.center, store.cx[ eid ], store.cy[ eid ], store.cz[ eid ] );
  out.radius = store.radius[ eid ];
  return out;
}

export function bitecsSphereFromThree( eid, threeSphere, store = SphereComponent ) {
  store.cx[ eid ]     = _rx( threeSphere.center );
  store.cy[ eid ]     = _ry( threeSphere.center );
  store.cz[ eid ]     = _rz( threeSphere.center );
  store.radius[ eid ] = threeSphere.radius;
  return eid;
}

export function bitecsSphereFromGlMatrixPacked( eid, glPacked, store = SphereComponent ) {
  store.cx[ eid ]     = glPacked[ 0 ];
  store.cy[ eid ]     = glPacked[ 1 ];
  store.cz[ eid ]     = glPacked[ 2 ];
  store.radius[ eid ] = glPacked[ 3 ];
  return eid;
}

export function glMatrixSpherePackedFromBitecs( outPacked, eid, store = SphereComponent ) {
  outPacked[ 0 ] = store.cx[ eid ];
  outPacked[ 1 ] = store.cy[ eid ];
  outPacked[ 2 ] = store.cz[ eid ];
  outPacked[ 3 ] = store.radius[ eid ];
  return outPacked;
}

export function glMatrixSphereFromBitecs( outCenter, eid, store = SphereComponent ) {
  outCenter[ 0 ] = store.cx[ eid ];
  outCenter[ 1 ] = store.cy[ eid ];
  outCenter[ 2 ] = store.cz[ eid ];
  return store.radius[ eid ];
}

export function bitecsSphereCopyInto( eidOut, eidIn, storeIn = SphereComponent, storeOut = storeIn ) {
  storeOut.cx[ eidOut ]     = storeIn.cx[ eidIn ];
  storeOut.cy[ eidOut ]     = storeIn.cy[ eidIn ];
  storeOut.cz[ eidOut ]     = storeIn.cz[ eidIn ];
  storeOut.radius[ eidOut ] = storeIn.radius[ eidIn ];
  return eidOut;
}

export function bitecsSphereAddInto( eidOut, eidA, eidB, storeA = SphereComponent, storeB = SphereComponent, storeOut = storeA ) {
  storeOut.cx[ eidOut ]     = storeA.cx[ eidA ]     + storeB.cx[ eidB ];
  storeOut.cy[ eidOut ]     = storeA.cy[ eidA ]     + storeB.cy[ eidB ];
  storeOut.cz[ eidOut ]     = storeA.cz[ eidA ]     + storeB.cz[ eidB ];
  storeOut.radius[ eidOut ] = storeA.radius[ eidA ] + storeB.radius[ eidB ];
  return eidOut;
}

export function bitecsSphereSubInto( eidOut, eidA, eidB, storeA = SphereComponent, storeB = SphereComponent, storeOut = storeA ) {
  storeOut.cx[ eidOut ]     = storeA.cx[ eidA ]     - storeB.cx[ eidB ];
  storeOut.cy[ eidOut ]     = storeA.cy[ eidA ]     - storeB.cy[ eidB ];
  storeOut.cz[ eidOut ]     = storeA.cz[ eidA ]     - storeB.cz[ eidB ];
  storeOut.radius[ eidOut ] = storeA.radius[ eidA ] - storeB.radius[ eidB ];
  return eidOut;
}

export function bitecsSphereScaleInPlace( eid, scalar, store = SphereComponent ) {
  store.cx[ eid ]     *= scalar;
  store.cy[ eid ]     *= scalar;
  store.cz[ eid ]     *= scalar;
  store.radius[ eid ] *= scalar;
  return eid;
}

export function bitecsSphereTranslateInPlace( eid, eidOffset, storeSphere = SphereComponent, storeOffset ) {
  storeSphere.cx[ eid ] += storeOffset.x[ eidOffset ];
  storeSphere.cy[ eid ] += storeOffset.y[ eidOffset ];
  storeSphere.cz[ eid ] += storeOffset.z[ eidOffset ];
  return eid;
}

export function bitecsSphereUnionInto( eidOut, eidA, eidB, storeA = SphereComponent, storeB = SphereComponent, storeOut = storeA ) {
  const ar = storeA.radius[ eidA ];
  const br = storeB.radius[ eidB ];
  const ax = storeA.cx[ eidA ], ay = storeA.cy[ eidA ], az = storeA.cz[ eidA ];
  const bx = storeB.cx[ eidB ], by = storeB.cy[ eidB ], bz = storeB.cz[ eidB ];

  // Handle empties.
  if ( ar < 0 ) {
    storeOut.cx[ eidOut ] = bx; storeOut.cy[ eidOut ] = by;
    storeOut.cz[ eidOut ] = bz; storeOut.radius[ eidOut ] = br;
    return eidOut;
  }
  if ( br < 0 ) {
    storeOut.cx[ eidOut ] = ax; storeOut.cy[ eidOut ] = ay;
    storeOut.cz[ eidOut ] = az; storeOut.radius[ eidOut ] = ar;
    return eidOut;
  }

  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

  // Containment cases.
  if ( ar >= dist + br ) {
    storeOut.cx[ eidOut ] = ax; storeOut.cy[ eidOut ] = ay;
    storeOut.cz[ eidOut ] = az; storeOut.radius[ eidOut ] = ar;
    return eidOut;
  }
  if ( br >= dist + ar ) {
    storeOut.cx[ eidOut ] = bx; storeOut.cy[ eidOut ] = by;
    storeOut.cz[ eidOut ] = bz; storeOut.radius[ eidOut ] = br;
    return eidOut;
  }

  // General case: expand A to encompass the two extreme points of B.
  // Result center: A + dir * (r - ar); result radius: r = (dist + ar + br) / 2.
  const r = ( dist + ar + br ) * 0.5;
  if ( dist > 0 ) {
    const t = ( r - ar ) / dist;
    storeOut.cx[ eidOut ] = ax + dx * t;
    storeOut.cy[ eidOut ] = ay + dy * t;
    storeOut.cz[ eidOut ] = az + dz * t;
  } else {
    storeOut.cx[ eidOut ] = ax;
    storeOut.cy[ eidOut ] = ay;
    storeOut.cz[ eidOut ] = az;
  }
  storeOut.radius[ eidOut ] = r;
  return eidOut;
}

export function bitecsSphereContainsPoint( eidSphere, eidPoint, storeSphere = SphereComponent, storePoint ) {
  const dx = storePoint.x[ eidPoint ] - storeSphere.cx[ eidSphere ];
  const dy = storePoint.y[ eidPoint ] - storeSphere.cy[ eidSphere ];
  const dz = storePoint.z[ eidPoint ] - storeSphere.cz[ eidSphere ];
  const r  = storeSphere.radius[ eidSphere ];
  return ( dx * dx + dy * dy + dz * dz ) <= ( r * r );
}

export function bitecsSphereDistanceToPoint( eidSphere, eidPoint, storeSphere = SphereComponent, storePoint ) {
  const dx = storePoint.x[ eidPoint ] - storeSphere.cx[ eidSphere ];
  const dy = storePoint.y[ eidPoint ] - storeSphere.cy[ eidSphere ];
  const dz = storePoint.z[ eidPoint ] - storeSphere.cz[ eidSphere ];
  return Math.sqrt( dx * dx + dy * dy + dz * dz ) - storeSphere.radius[ eidSphere ];
}

export function bitecsSphereIntersectsSphere( eidA, eidB, storeA = SphereComponent, storeB = SphereComponent ) {
  const dx = storeB.cx[ eidB ] - storeA.cx[ eidA ];
  const dy = storeB.cy[ eidB ] - storeA.cy[ eidA ];
  const dz = storeB.cz[ eidB ] - storeA.cz[ eidA ];
  const r  = storeA.radius[ eidA ] + storeB.radius[ eidB ];
  return ( dx * dx + dy * dy + dz * dz ) <= ( r * r );
}

export function bitecsSphereIntersectsPlane( eidSphere, eidPlane, storeSphere = SphereComponent, storePlane ) {
  const d = storePlane.nx[ eidPlane ] * storeSphere.cx[ eidSphere ]
          + storePlane.ny[ eidPlane ] * storeSphere.cy[ eidSphere ]
          + storePlane.nz[ eidPlane ] * storeSphere.cz[ eidSphere ]
          + storePlane.constant[ eidPlane ];
  return Math.abs( d ) <= storeSphere.radius[ eidSphere ];
}

export function bitecsSphereIntersectsBox( eidSphere, eidBox, storeSphere = SphereComponent, storeBox = null ) {
  if ( storeBox === null ) throw new Error( 'storeBox (Box3Component) is required' );
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

export function bitecsVec3SphereClampPointInto( eidOutVec, eidSphere, eidPoint, storeSphere = SphereComponent, storePoint, storeVec ) {
  const dx = storePoint.x[ eidPoint ] - storeSphere.cx[ eidSphere ];
  const dy = storePoint.y[ eidPoint ] - storeSphere.cy[ eidSphere ];
  const dz = storePoint.z[ eidPoint ] - storeSphere.cz[ eidSphere ];
  const dSq = dx * dx + dy * dy + dz * dz;
  const r = storeSphere.radius[ eidSphere ];
  if ( dSq > r * r ) {
    const d = Math.sqrt( dSq );
    const inv = r / d;
    storeVec.x[ eidOutVec ] = storeSphere.cx[ eidSphere ] + dx * inv;
    storeVec.y[ eidOutVec ] = storeSphere.cy[ eidSphere ] + dy * inv;
    storeVec.z[ eidOutVec ] = storeSphere.cz[ eidSphere ] + dz * inv;
  } else {
    storeVec.x[ eidOutVec ] = storePoint.x[ eidPoint ];
    storeVec.y[ eidOutVec ] = storePoint.y[ eidPoint ];
    storeVec.z[ eidOutVec ] = storePoint.z[ eidPoint ];
  }
  return eidOutVec;
}

export function bitecsBox3SphereBoundingBoxInto( eidBoxOut, eidSphere, storeBox = null, storeSphere = SphereComponent ) {
  if ( storeBox === null ) throw new Error( 'storeBox (Box3Component) is required' );
  if ( storeSphere.radius[ eidSphere ] < 0 ) {
    storeBox.minX[ eidBoxOut ] =  Infinity; storeBox.minY[ eidBoxOut ] =  Infinity; storeBox.minZ[ eidBoxOut ] =  Infinity;
    storeBox.maxX[ eidBoxOut ] = -Infinity; storeBox.maxY[ eidBoxOut ] = -Infinity; storeBox.maxZ[ eidBoxOut ] = -Infinity;
    return eidBoxOut;
  }
  const cx = storeSphere.cx[ eidSphere ], cy = storeSphere.cy[ eidSphere ], cz = storeSphere.cz[ eidSphere ];
  const r = storeSphere.radius[ eidSphere ];
  storeBox.minX[ eidBoxOut ] = cx - r;
  storeBox.minY[ eidBoxOut ] = cy - r;
  storeBox.minZ[ eidBoxOut ] = cz - r;
  storeBox.maxX[ eidBoxOut ] = cx + r;
  storeBox.maxY[ eidBoxOut ] = cy + r;
  storeBox.maxZ[ eidBoxOut ] = cz + r;
  return eidBoxOut;
}

export function bitecsSphereApplyMatrix4InPlace( eid, m, storeSphere = SphereComponent ) {
  // m: 16-element column-major matrix (or THREE.Matrix4 with .elements).
  const me = _matrixElements( m );
  const cx = storeSphere.cx[ eid ], cy = storeSphere.cy[ eid ], cz = storeSphere.cz[ eid ];
  const w = me[ 3 ] * cx + me[ 7 ] * cy + me[ 11 ] * cz + me[ 15 ] || 1.0;
  storeSphere.cx[ eid ] = ( me[ 0 ] * cx + me[ 4 ] * cy + me[ 8 ]  * cz + me[ 12 ] ) / w;
  storeSphere.cy[ eid ] = ( me[ 1 ] * cx + me[ 5 ] * cy + me[ 9 ]  * cz + me[ 13 ] ) / w;
  storeSphere.cz[ eid ] = ( me[ 2 ] * cx + me[ 6 ] * cy + me[ 10 ] * cz + me[ 14 ] ) / w;
  storeSphere.radius[ eid ] *= _maxAxisScale( me );
  return eid;
}

export function bitecsSphereRayIntersect( eidSphere, ox, oy, oz, dx, dy, dz, storeSphere = SphereComponent ) {
  // Returns the smallest non-negative t, or -1 if no hit.
  const cx = storeSphere.cx[ eidSphere ];
  const cy = storeSphere.cy[ eidSphere ];
  const cz = storeSphere.cz[ eidSphere ];
  const r  = storeSphere.radius[ eidSphere ];
  if ( r < 0 ) return -1;
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  const d2  = lx * lx + ly * ly + lz * lz - tca * tca;
  const r2  = r * r;
  if ( d2 > r2 ) return -1;
  const thc = Math.sqrt( r2 - d2 );
  const t0 = tca - thc;
  const t1 = tca + thc;
  if ( t1 < 0 ) return -1;
  return t0 >= 0 ? t0 : t1;
}

// ═══════════════════════════════════════════════════════════════════
// HIGH-PRECISION (DoubleDouble) HELPERS
// ═══════════════════════════════════════════════════════════════════

export function preciseDistanceToPoint( sphere, point ) {
  const dx = DD.subtract( DD.fromDouble( _rx( point ) ), DD.fromDouble( _rx( sphere.center ) ) );
  const dy = DD.subtract( DD.fromDouble( _ry( point ) ), DD.fromDouble( _ry( sphere.center ) ) );
  const dz = DD.subtract( DD.fromDouble( _rz( point ) ), DD.fromDouble( _rz( sphere.center ) ) );
  const dist = DD.sqrt(
    DD.add(
      DD.add( DD.multiply( dx, dx ), DD.multiply( dy, dy ) ),
      DD.multiply( dz, dz )
    )
  );
  return DD.toDouble( DD.subtract( dist, DD.fromDouble( sphere.radius ) ) );
}

export function preciseContainsPoint( sphere, point ) {
  const dx = DD.subtract( DD.fromDouble( _rx( point ) ), DD.fromDouble( _rx( sphere.center ) ) );
  const dy = DD.subtract( DD.fromDouble( _ry( point ) ), DD.fromDouble( _ry( sphere.center ) ) );
  const dz = DD.subtract( DD.fromDouble( _rz( point ) ), DD.fromDouble( _rz( sphere.center ) ) );
  const distSq = DD.add(
    DD.add( DD.multiply( dx, dx ), DD.multiply( dy, dy ) ),
    DD.multiply( dz, dz )
  );
  const rSq = DD.multiply( DD.fromDouble( sphere.radius ), DD.fromDouble( sphere.radius ) );
  return DD.toDouble( DD.subtract( distSq, rSq ) ) <= 0;
}

export function preciseUnionInto( out, a, b ) {
  if ( a.radius < 0 ) {
    _copyVec3Into( out.center, b.center );
    out.radius = b.radius;
    return out;
  }
  if ( b.radius < 0 ) {
    _copyVec3Into( out.center, a.center );
    out.radius = a.radius;
    return out;
  }
  // Same-center case
  if ( _rx( a.center ) === _rx( b.center ) && _ry( a.center ) === _ry( b.center ) && _rz( a.center ) === _rz( b.center ) ) {
    _copyVec3Into( out.center, a.center );
    out.radius = Math.max( a.radius, b.radius );
    return out;
  }
  // Compute the union sphere in double-double.
  const dxDD = DD.subtract( DD.fromDouble( _rx( b.center ) ), DD.fromDouble( _rx( a.center ) ) );
  const dyDD = DD.subtract( DD.fromDouble( _ry( b.center ) ), DD.fromDouble( _ry( a.center ) ) );
  const dzDD = DD.subtract( DD.fromDouble( _rz( b.center ) ), DD.fromDouble( _rz( a.center ) ) );
  const dist = DD.toDouble(
    DD.sqrt(
      DD.add(
        DD.add( DD.multiply( dxDD, dxDD ), DD.multiply( dyDD, dyDD ) ),
        DD.multiply( dzDD, dzDD )
      )
    )
  );
  if ( a.radius >= dist + b.radius ) {
    _copyVec3Into( out.center, a.center );
    out.radius = a.radius;
    return out;
  }
  if ( b.radius >= dist + a.radius ) {
    _copyVec3Into( out.center, b.center );
    out.radius = b.radius;
    return out;
  }
  const r = ( dist + a.radius + b.radius ) * 0.5;
  const t = dist > 0 ? ( r - a.radius ) / dist : 0;
  _writeVec3(
    out.center,
    _rx( a.center ) + ( _rx( b.center ) - _rx( a.center ) ) * t,
    _ry( a.center ) + ( _ry( b.center ) - _ry( a.center ) ) * t,
    _rz( a.center ) + ( _rz( b.center ) - _rz( a.center ) ) * t
  );
  out.radius = r;
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// PROCEDURAL NOISE — random sphere from a 3D simplex field
// ═══════════════════════════════════════════════════════════════════

export function setFromNoise3D( out, x, y, z, seed = 0, centerScale = 1, radiusScale = 0.5 ) {
  const n = _cachedNoise3D( seed );
  _writeVec3(
    out.center,
    n( x, y, z ) * centerScale,
    n( x + 31.416, y + 47.853, z + 12.793 ) * centerScale,
    n( x - 17.234, y - 53.127, z - 91.056 ) * centerScale
  );
  out.radius = Math.abs( n( x + 100.1, y + 200.2, z + 300.3 ) ) * radiusScale;
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// Named + default exports
// ═══════════════════════════════════════════════════════════════════
export { Sphere };
export default Sphere;