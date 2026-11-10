// file number : 065
// full path name : src/math/065_Ray.js
// description : 3D ray primitive (origin + normalized direction) — drop-in replacement for THREE.Ray (r185). origin and direction are duck-typed vec3-like values ({x,y,z}, flat [x,y,z], or THREE.Vector3). Complete r185 surface: constructor(origin, direction), set(origin, direction), copy(ray), clone(), at(t, target), lookAt(v), recast(t), closestPointToPoint(point, target), distanceToPoint(point), distanceSqToPoint(point), distanceSqToSegment(v0, v1, optionalPointOnRay, optionalPointOnSegment), intersectSphere(sphere, target), intersectsSphere(sphere), distanceToPlane(plane), intersectPlane(plane, target), intersectsPlane(plane), intersectBox(box, target), intersectsBox(box), intersectTriangle(a, b, c, backfaceCulling, target), applyMatrix4(matrix), equals(ray). Extended: preciseClosestPointParameter / preciseDistanceSqToPoint / preciseDistanceToPoint via the chat's DoubleDouble (014) for galactic-scale origin; setFromNoise3D via the chat's SimplexNoise (013) with cached per-seed mulberry32 generator; full zero-allocation bitECS SoA bridge set using RayComponent (ox/oy/oz + dx/dy/dz f32([]) from 014_BitECS) covering from/to/copy/at/closest-point/distance/closest-point-parameter/intersects-sphere/intersects-plane/intersects-box/intersects-triangle/normalize-in-place/apply-matrix4-in-place; flat-array bridges for gl-matrix-style packed [ox,oy,oz,dx,dy,dz] interop; and a recycled local pool (Ray.acquire / Ray.recycle) that resets origin to (0,0,0) and direction to (0,0,-1). No THREE, no CDN, no static server, no Vite/Vue — imports only from the chat's own files (003_Common clamp, 013_SimplexNoise, 014_DoubleDouble, 014_BitECS).
// best for : mouse picking, raycasting, line-of-sight queries, ray-sphere/plane/box/triangle intersection tests, capsule-cast broad-phase, PBR reflection/refraction rays, procedural spawn sightlines, and any ECS system that stores rays as SoA origin+direction and must feed THREE.Ray, THREE.Raycaster, or the Frustum culling pipeline without allocating per frame. The pooled + SoA-bridge paths are the recommended route for hot loops at 10k+ entities on Android 64-bit.
// license : MIT

import { clamp } from '../core/003_Common.js';
import * as DD from './014_DoubleDouble.js';
import * as bitecs from './014_BitECS.js';
import { createNoise3D } from './013_SimplexNoise.js';

// ═══════════════════════════════════════════════════════════════════
// bitECS 0.4.0 SoA COMPONENT (archetype-friendly, cache-friendly)
// ═══════════════════════════════════════════════════════════════════
export const RayComponent = {
  ox: bitecs.f32([]),
  oy: bitecs.f32([]),
  oz: bitecs.f32([]),
  dx: bitecs.f32([]),
  dy: bitecs.f32([]),
  dz: bitecs.f32([])
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

// Scratch vec3s reused by flat-array bridges and distanceSqToSegment
const _scratchA = _vec3();
const _scratchB = _vec3();
const _scratchC = _vec3();
const _scratchD = _vec3();
const _scratchE = _vec3();

// ═══════════════════════════════════════════════════════════════════
// class Ray
// ═══════════════════════════════════════════════════════════════════
class Ray {

  constructor( origin, direction ) {
    this.isRay = true;
    this.origin = origin !== undefined ? origin : _vec3();
    this.direction = direction !== undefined ? direction : _vec3( 0, 0, -1 );
  }

  set( origin, direction ) {
    _copyVec3Into( this.origin, origin );
    _copyVec3Into( this.direction, direction );
    return this;
  }

  copy( ray ) {
    _copyVec3Into( this.origin, ray.origin );
    _copyVec3Into( this.direction, ray.direction );
    return this;
  }

  clone() {
    return new this.constructor(
      _vec3( _rx( this.origin ), _ry( this.origin ), _rz( this.origin ) ),
      _vec3( _rx( this.direction ), _ry( this.direction ), _rz( this.direction ) )
    );
  }

  at( t, target ) {
    if ( target === undefined ) target = _vec3();
    return _writeVec3(
      target,
      _rx( this.origin ) + _rx( this.direction ) * t,
      _ry( this.origin ) + _ry( this.direction ) * t,
      _rz( this.origin ) + _rz( this.direction ) * t
    );
  }

  lookAt( v ) {
    const x = _rx( v ) - _rx( this.origin );
    const y = _ry( v ) - _ry( this.origin );
    const z = _rz( v ) - _rz( this.origin );
    const len = Math.sqrt( x * x + y * y + z * z );
    if ( len === 0 ) {
      _writeVec3( this.direction, 0, 0, 0 );
    } else {
      const inv = 1 / len;
      _writeVec3( this.direction, x * inv, y * inv, z * inv );
    }
    return this;
  }

  recast( t ) {
    this.at( t, this.origin );
    return this;
  }

  closestPointToPoint( point, target ) {
    if ( target === undefined ) target = _vec3();
    const ox = _rx( this.origin ), oy = _ry( this.origin ), oz = _rz( this.origin );
    const dx = _rx( this.direction ), dy = _ry( this.direction ), dz = _rz( this.direction );
    const px = _rx( point ) - ox;
    const py = _ry( point ) - oy;
    const pz = _rz( point ) - oz;
    const d = px * dx + py * dy + pz * dz;
    if ( d < 0 ) {
      return _writeVec3( target, ox, oy, oz );
    }
    return _writeVec3( target, ox + dx * d, oy + dy * d, oz + dz * d );
  }

  distanceToPoint( point ) {
    return Math.sqrt( this.distanceSqToPoint( point ) );
  }

  distanceSqToPoint( point ) {
    const ox = _rx( this.origin ), oy = _ry( this.origin ), oz = _rz( this.origin );
    const dx = _rx( this.direction ), dy = _ry( this.direction ), dz = _rz( this.direction );
    const px = _rx( point ) - ox;
    const py = _ry( point ) - oy;
    const pz = _rz( point ) - oz;
    const d = px * dx + py * dy + pz * dz;
    if ( d < 0 ) {
      const dx0 = _rx( point ) - ox;
      const dy0 = _ry( point ) - oy;
      const dz0 = _rz( point ) - oz;
      return dx0 * dx0 + dy0 * dy0 + dz0 * dz0;
    }
    const cx = ox + dx * d - _rx( point );
    const cy = oy + dy * d - _ry( point );
    const cz = oz + dz * d - _rz( point );
    return cx * cx + cy * cy + cz * cz;
  }

  distanceSqToSegment( v0, v1, optionalPointOnRay, optionalPointOnSegment ) {
    // Ericson, Real-Time Collision Detection, closest point between ray and segment.
    const ax = _rx( v0 ), ay = _ry( v0 ), az = _rz( v0 );
    const bx = _rx( v1 ), by = _ry( v1 ), bz = _rz( v1 );

    // Segment midpoint and direction.
    const scx = ( ax + bx ) * 0.5;
    const scy = ( ay + by ) * 0.5;
    const scz = ( az + bz ) * 0.5;
    let sdx = bx - ax, sdy = by - ay, sdz = bz - az;
    const segLen = Math.sqrt( sdx * sdx + sdy * sdy + sdz * sdz );
    if ( segLen > 0 ) {
      sdx /= segLen; sdy /= segLen; sdz /= segLen;
    }
    const segExtent = segLen * 0.5;

    const ox = _rx( this.origin ), oy = _ry( this.origin ), oz = _rz( this.origin );
    const dx = _rx( this.direction ), dy = _ry( this.direction ), dz = _rz( this.direction );

    const diffX = ox - scx, diffY = oy - scy, diffZ = oz - scz;
    const a01 = -( dx * sdx + dy * sdy + dz * sdz );
    const b0  =  ( diffX * dx + diffY * dy + diffZ * dz );
    const b1  = -( diffX * sdx + diffY * sdy + diffZ * sdz );
    const c   =  diffX * diffX + diffY * diffY + diffZ * diffZ;
    const det = Math.abs( 1 - a01 * a01 );

    let s0 = 0, s1 = 0, sqrDist = 0, extDet = 0;

    if ( det > 0 ) {
      s0 = a01 * b1 - b0;
      s1 = a01 * b0 - b1;
      extDet = segExtent * det;

      if ( s0 >= 0 ) {
        if ( s1 >= -extDet ) {
          if ( s1 <= extDet ) {
            const invDet = 1 / det;
            s0 *= invDet;
            s1 *= invDet;
            sqrDist = s0 * ( s0 + a01 * s1 + 2 * b0 ) + s1 * ( a01 * s0 + s1 + 2 * b1 ) + c;
          } else {
            s1 = segExtent;
            s0 = Math.max( 0, -( a01 * s1 + b0 ) );
            sqrDist = -s0 * s0 + s1 * ( s1 + 2 * b1 ) + c;
          }
        } else {
          s1 = -segExtent;
          s0 = Math.max( 0, -( a01 * s1 + b0 ) );
          sqrDist = -s0 * s0 + s1 * ( s1 + 2 * b1 ) + c;
        }
      } else {
        if ( s1 <= -extDet ) {
          s0 = Math.max( 0, -( -a01 * segExtent + b0 ) );
          s1 = ( s0 > 0 ) ? -segExtent : Math.min( Math.max( -segExtent, -b1 ), segExtent );
          sqrDist = -s0 * s0 + s1 * ( s1 + 2 * b1 ) + c;
        } else if ( s1 <= extDet ) {
          s0 = 0;
          s1 = Math.min( Math.max( -segExtent, -b1 ), segExtent );
          sqrDist = s1 * ( s1 + 2 * b1 ) + c;
        } else {
          s0 = Math.max( 0, -( a01 * segExtent + b0 ) );
          s1 = ( s0 > 0 ) ? segExtent : Math.min( Math.max( -segExtent, -b1 ), segExtent );
          sqrDist = -s0 * s0 + s1 * ( s1 + 2 * b1 ) + c;
        }
      }
    } else {
      s1 = ( a01 > 0 ) ? -segExtent : segExtent;
      s0 = Math.max( 0, -( a01 * s1 + b0 ) );
      sqrDist = -s0 * s0 + s1 * ( s1 + 2 * b1 ) + c;
    }

    if ( optionalPointOnRay ) {
      _writeVec3( optionalPointOnRay, ox + dx * s0, oy + dy * s0, oz + dz * s0 );
    }
    if ( optionalPointOnSegment ) {
      _writeVec3(
        optionalPointOnSegment,
        scx + sdx * s1,
        scy + sdy * s1,
        scz + sdz * s1
      );
    }
    return sqrDist;
  }

  intersectSphere( sphere, target ) {
    if ( target === undefined ) target = _vec3();
    const ox = _rx( this.origin ), oy = _ry( this.origin ), oz = _rz( this.origin );
    const dx = _rx( this.direction ), dy = _ry( this.direction ), dz = _rz( this.direction );
    const cx = _rx( sphere.center ), cy = _ry( sphere.center ), cz = _rz( sphere.center );
    const r = sphere.radius;

    // Solve quadratic in t.
    const lx = cx - ox, ly = cy - oy, lz = cz - oz;
    const tca = lx * dx + ly * dy + lz * dz;
    const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
    const r2 = r * r;
    if ( d2 > r2 ) return null;
    const thc = Math.sqrt( r2 - d2 );
    const t0 = tca - thc;
    const t1 = tca + thc;
    if ( t1 < 0 ) return null;
    if ( t0 < 0 ) return this.at( t1, target );
    return this.at( t0, target );
  }

  intersectsSphere( sphere ) {
    // r185 semantics: r < 0 ⇒ empty (returns false).
    if ( sphere.radius < 0 ) return false;
    const ox = _rx( this.origin ), oy = _ry( this.origin ), oz = _rz( this.origin );
    const dx = _rx( this.direction ), dy = _ry( this.direction ), dz = _rz( this.direction );
    const cx = _rx( sphere.center ), cy = _ry( sphere.center ), cz = _rz( sphere.center );
    const lx = cx - ox, ly = cy - oy, lz = cz - oz;
    const tca = lx * dx + ly * dy + lz * dz;
    const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
    const r = sphere.radius;
    return d2 <= r * r;
  }

  distanceToPlane( plane ) {
    const nx = _rx( plane.normal ), ny = _ry( plane.normal ), nz = _rz( plane.normal );
    const dx = _rx( this.direction ), dy = _ry( this.direction ), dz = _rz( this.direction );
    const denom = nx * dx + ny * dy + nz * dz;
    if ( denom === 0 ) {
      const ox = _rx( this.origin ), oy = _ry( this.origin ), oz = _rz( this.origin );
      const dist = nx * ox + ny * oy + nz * oz + plane.constant;
      return dist === 0 ? 0 : null;
    }
    const ox = _rx( this.origin ), oy = _ry( this.origin ), oz = _rz( this.origin );
    const t = -( ox * nx + oy * ny + oz * nz + plane.constant ) / denom;
    return t >= 0 ? t : null;
  }

  intersectPlane( plane, target ) {
    if ( target === undefined ) target = _vec3();
    const t = this.distanceToPlane( plane );
    if ( t === null ) return null;
    return this.at( t, target );
  }

  intersectsPlane( plane ) {
    const nx = _rx( plane.normal ), ny = _ry( plane.normal ), nz = _rz( plane.normal );
    const ox = _rx( this.origin ), oy = _ry( this.origin ), oz = _rz( this.origin );
    const dx = _rx( this.direction ), dy = _ry( this.direction ), dz = _rz( this.direction );

    const distToPoint = nx * ox + ny * oy + nz * oz + plane.constant;
    if ( distToPoint === 0 ) return true;

    const denom = nx * dx + ny * dy + nz * dz;
    return denom * distToPoint < 0;
  }

  intersectBox( box, target ) {
    if ( target === undefined ) target = _vec3();
    const ox = _rx( this.origin ), oy = _ry( this.origin ), oz = _rz( this.origin );
    const dx = _rx( this.direction ), dy = _ry( this.direction ), dz = _rz( this.direction );

    const invX = dx !== 0 ? 1 / dx : Infinity;
    const invY = dy !== 0 ? 1 / dy : Infinity;
    const invZ = dz !== 0 ? 1 / dz : Infinity;

    const minX = _rx( box.min ), minY = _ry( box.min ), minZ = _rz( box.min );
    const maxX = _rx( box.max ), maxY = _ry( box.max ), maxZ = _rz( box.max );

    let tmin, tmax, tymin, tymax, tzmin, tzmax;
    if ( invX >= 0 ) {
      tmin = ( minX - ox ) * invX;
      tmax = ( maxX - ox ) * invX;
    } else {
      tmin = ( maxX - ox ) * invX;
      tmax = ( minX - ox ) * invX;
    }
    if ( invY >= 0 ) {
      tymin = ( minY - oy ) * invY;
      tymax = ( maxY - oy ) * invY;
    } else {
      tymin = ( maxY - oy ) * invY;
      tymax = ( minY - oy ) * invY;
    }
    if ( tmin > tymax || tymin > tmax ) return null;
    if ( tymin > tmin || tmin !== tmin ) tmin = tymin;
    if ( tymax < tmax || tmax !== tmax ) tmax = tymax;

    if ( invZ >= 0 ) {
      tzmin = ( minZ - oz ) * invZ;
      tzmax = ( maxZ - oz ) * invZ;
    } else {
      tzmin = ( maxZ - oz ) * invZ;
      tzmax = ( minZ - oz ) * invZ;
    }
    if ( tmin > tzmax || tzmin > tmax ) return null;
    if ( tzmin > tmin || tmin !== tmin ) tmin = tzmin;
    if ( tzmax < tmax || tmax !== tmax ) tmax = tzmax;

    if ( tmax < 0 ) return null;
    return this.at( tmin >= 0 ? tmin : tmax, target );
  }

  intersectsBox( box ) {
    return this.intersectBox( box, _scratchA ) !== null;
  }

  intersectTriangle( a, b, c, backfaceCulling, target ) {
    if ( target === undefined ) target = _vec3();
    const ax = _rx( a ), ay = _ry( a ), az = _rz( a );
    const bx = _rx( b ), by = _ry( b ), bz = _rz( b );
    const cx = _rx( c ), cy = _ry( c ), cz = _rz( c );

    // Edge vectors.
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

    // Normal.
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;

    const dx = _rx( this.direction ), dy = _ry( this.direction ), dz = _rz( this.direction );
    let DdN = dx * nx + dy * ny + dz * nz;
    let sign;
    if ( DdN > 0 ) {
      if ( backfaceCulling ) return null;
      sign = 1;
    } else if ( DdN < 0 ) {
      sign = -1;
      DdN = -DdN;
    } else {
      return null;
    }

    const ox = _rx( this.origin ), oy = _ry( this.origin ), oz = _rz( this.origin );
    const diffx = ox - ax, diffy = oy - ay, diffz = oz - az;

    // Cross of diff with e2.
    const cx2 = diffy * e2z - diffz * e2y;
    const cy2 = diffz * e2x - diffx * e2z;
    const cz2 = diffx * e2y - diffy * e2x;
    const DdQxE2 = sign * ( dx * cx2 + dy * cy2 + dz * cz2 );
    if ( DdQxE2 < 0 ) return null;

    // Cross of e1 with diff.
    const cx3 = e1y * diffz - e1z * diffy;
    const cy3 = e1z * diffx - e1x * diffz;
    const cz3 = e1x * diffy - e1y * diffx;
    const DdE1xQ = sign * ( dx * cx3 + dy * cy3 + dz * cz3 );
    if ( DdE1xQ < 0 ) return null;

    if ( DdQxE2 + DdE1xQ > DdN ) return null;

    const QdN = -sign * ( diffx * nx + diffy * ny + diffz * nz );
    if ( QdN < 0 ) return null;

    return this.at( QdN / DdN, target );
  }

  applyMatrix4( matrix ) {
    const m = _matrixElements( matrix );
    // Origin: full transform + w-divide.
    const ox = _rx( this.origin ), oy = _ry( this.origin ), oz = _rz( this.origin );
    const w = m[ 3 ] * ox + m[ 7 ] * oy + m[ 11 ] * oz + m[ 15 ] || 1.0;
    const invW = 1 / w;
    _writeVec3(
      this.origin,
      ( m[ 0 ] * ox + m[ 4 ] * oy + m[ 8 ]  * oz + m[ 12 ] ) * invW,
      ( m[ 1 ] * ox + m[ 5 ] * oy + m[ 9 ]  * oz + m[ 13 ] ) * invW,
      ( m[ 2 ] * ox + m[ 6 ] * oy + m[ 10 ] * oz + m[ 14 ] ) * invW
    );
    // Direction: upper-left 3x3, normalized (r185 `transformDirection`).
    const dx = _rx( this.direction ), dy = _ry( this.direction ), dz = _rz( this.direction );
    let ndx = m[ 0 ] * dx + m[ 4 ] * dy + m[ 8 ]  * dz;
    let ndy = m[ 1 ] * dx + m[ 5 ] * dy + m[ 9 ]  * dz;
    let ndz = m[ 2 ] * dx + m[ 6 ] * dy + m[ 10 ] * dz;
    const len = Math.sqrt( ndx * ndx + ndy * ndy + ndz * ndz );
    if ( len > 0 ) {
      const inv = 1 / len;
      ndx *= inv; ndy *= inv; ndz *= inv;
    }
    _writeVec3( this.direction, ndx, ndy, ndz );
    return this;
  }

  equals( ray ) {
    return _rx( ray.origin ) === _rx( this.origin )
        && _ry( ray.origin ) === _ry( this.origin )
        && _rz( ray.origin ) === _rz( this.origin )
        && _rx( ray.direction ) === _rx( this.direction )
        && _ry( ray.direction ) === _ry( this.direction )
        && _rz( ray.direction ) === _rz( this.direction );
  }

  toArray( array = [], offset = 0 ) {
    array[ offset ]     = _rx( this.origin );
    array[ offset + 1 ] = _ry( this.origin );
    array[ offset + 2 ] = _rz( this.origin );
    array[ offset + 3 ] = _rx( this.direction );
    array[ offset + 4 ] = _ry( this.direction );
    array[ offset + 5 ] = _rz( this.direction );
    return array;
  }

  fromArray( array, offset = 0 ) {
    _writeVec3( this.origin, array[ offset ], array[ offset + 1 ], array[ offset + 2 ] );
    _writeVec3( this.direction, array[ offset + 3 ], array[ offset + 4 ], array[ offset + 5 ] );
    return this;
  }

  // ────────────── pooled instances ──────────────

  static acquire() {
    return _localPool.length > 0 ? _localPool.pop() : new Ray();
  }

  static recycle( ray ) {
    if ( ray instanceof Ray && _localPool.length < LOCAL_POOL_MAX ) {
      _writeVec3( ray.origin, 0, 0, 0 );
      _writeVec3( ray.direction, 0, 0, -1 );
      _localPool.push( ray );
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// BRIDGE: THREE-style <-> flat array (gl-matrix-compatible layout)
// ═══════════════════════════════════════════════════════════════════

export function threeRayFromGlMatrix( out, glOrigin, glDirection ) {
  _writeVec3( out.origin, glOrigin[ 0 ], glOrigin[ 1 ], glOrigin[ 2 ] );
  _writeVec3( out.direction, glDirection[ 0 ], glDirection[ 1 ], glDirection[ 2 ] );
  return out;
}

export function threeRayFromGlMatrixPacked( out, glPacked ) {
  _writeVec3( out.origin, glPacked[ 0 ], glPacked[ 1 ], glPacked[ 2 ] );
  _writeVec3( out.direction, glPacked[ 3 ], glPacked[ 4 ], glPacked[ 5 ] );
  return out;
}

export function glMatrixRayFromThree( outOrigin, outDirection, threeRay ) {
  outOrigin[ 0 ] = _rx( threeRay.origin );
  outOrigin[ 1 ] = _ry( threeRay.origin );
  outOrigin[ 2 ] = _rz( threeRay.origin );
  outDirection[ 0 ] = _rx( threeRay.direction );
  outDirection[ 1 ] = _ry( threeRay.direction );
  outDirection[ 2 ] = _rz( threeRay.direction );
  return threeRay;
}

export function glMatrixRayPackedFromThree( outPacked, threeRay ) {
  outPacked[ 0 ] = _rx( threeRay.origin );
  outPacked[ 1 ] = _ry( threeRay.origin );
  outPacked[ 2 ] = _rz( threeRay.origin );
  outPacked[ 3 ] = _rx( threeRay.direction );
  outPacked[ 4 ] = _ry( threeRay.direction );
  outPacked[ 5 ] = _rz( threeRay.direction );
  return outPacked;
}

// ═══════════════════════════════════════════════════════════════════
// BRIDGE: THREE-style <-> bitECS SoA
// ═══════════════════════════════════════════════════════════════════

export function threeRayFromBitecs( out, eid, store = RayComponent ) {
  _writeVec3( out.origin, store.ox[ eid ], store.oy[ eid ], store.oz[ eid ] );
  _writeVec3( out.direction, store.dx[ eid ], store.dy[ eid ], store.dz[ eid ] );
  return out;
}

export function bitecsRayFromThree( eid, threeRay, store = RayComponent ) {
  store.ox[ eid ] = _rx( threeRay.origin );
  store.oy[ eid ] = _ry( threeRay.origin );
  store.oz[ eid ] = _rz( threeRay.origin );
  store.dx[ eid ] = _rx( threeRay.direction );
  store.dy[ eid ] = _ry( threeRay.direction );
  store.dz[ eid ] = _rz( threeRay.direction );
  return eid;
}

export function bitecsRayFromGlMatrix( eid, glOrigin, glDirection, store = RayComponent ) {
  store.ox[ eid ] = glOrigin[ 0 ];
  store.oy[ eid ] = glOrigin[ 1 ];
  store.oz[ eid ] = glOrigin[ 2 ];
  store.dx[ eid ] = glDirection[ 0 ];
  store.dy[ eid ] = glDirection[ 1 ];
  store.dz[ eid ] = glDirection[ 2 ];
  return eid;
}

export function bitecsRayFromGlMatrixPacked( eid, glPacked, store = RayComponent ) {
  store.ox[ eid ] = glPacked[ 0 ];
  store.oy[ eid ] = glPacked[ 1 ];
  store.oz[ eid ] = glPacked[ 2 ];
  store.dx[ eid ] = glPacked[ 3 ];
  store.dy[ eid ] = glPacked[ 4 ];
  store.dz[ eid ] = glPacked[ 5 ];
  return eid;
}

export function glMatrixRayFromBitecs( outOrigin, outDirection, eid, store = RayComponent ) {
  outOrigin[ 0 ] = store.ox[ eid ];
  outOrigin[ 1 ] = store.oy[ eid ];
  outOrigin[ 2 ] = store.oz[ eid ];
  outDirection[ 0 ] = store.dx[ eid ];
  outDirection[ 1 ] = store.dy[ eid ];
  outDirection[ 2 ] = store.dz[ eid ];
  return eid;
}

export function glMatrixRayPackedFromBitecs( outPacked, eid, store = RayComponent ) {
  outPacked[ 0 ] = store.ox[ eid ];
  outPacked[ 1 ] = store.oy[ eid ];
  outPacked[ 2 ] = store.oz[ eid ];
  outPacked[ 3 ] = store.dx[ eid ];
  outPacked[ 4 ] = store.dy[ eid ];
  outPacked[ 5 ] = store.dz[ eid ];
  return outPacked;
}

export function bitecsRayCopyInto( eidOut, eidIn, storeIn = RayComponent, storeOut = storeIn ) {
  storeOut.ox[ eidOut ] = storeIn.ox[ eidIn ];
  storeOut.oy[ eidOut ] = storeIn.oy[ eidIn ];
  storeOut.oz[ eidOut ] = storeIn.oz[ eidIn ];
  storeOut.dx[ eidOut ] = storeIn.dx[ eidIn ];
  storeOut.dy[ eidOut ] = storeIn.dy[ eidIn ];
  storeOut.dz[ eidOut ] = storeIn.dz[ eidIn ];
  return eidOut;
}

export function bitecsRayAddInto( eidOut, eidA, eidB, storeA = RayComponent, storeB = RayComponent, storeOut = storeA ) {
  storeOut.ox[ eidOut ] = storeA.ox[ eidA ] + storeB.ox[ eidB ];
  storeOut.oy[ eidOut ] = storeA.oy[ eidA ] + storeB.oy[ eidB ];
  storeOut.oz[ eidOut ] = storeA.oz[ eidA ] + storeB.oz[ eidB ];
  storeOut.dx[ eidOut ] = storeA.dx[ eidA ] + storeB.dx[ eidB ];
  storeOut.dy[ eidOut ] = storeA.dy[ eidA ] + storeB.dy[ eidB ];
  storeOut.dz[ eidOut ] = storeA.dz[ eidA ] + storeB.dz[ eidB ];
  return eidOut;
}

export function bitecsRaySubInto( eidOut, eidA, eidB, storeA = RayComponent, storeB = RayComponent, storeOut = storeA ) {
  storeOut.ox[ eidOut ] = storeA.ox[ eidA ] - storeB.ox[ eidB ];
  storeOut.oy[ eidOut ] = storeA.oy[ eidA ] - storeB.oy[ eidB ];
  storeOut.oz[ eidOut ] = storeA.oz[ eidA ] - storeB.oz[ eidB ];
  storeOut.dx[ eidOut ] = storeA.dx[ eidA ] - storeB.dx[ eidB ];
  storeOut.dy[ eidOut ] = storeA.dy[ eidA ] - storeB.dy[ eidB ];
  storeOut.dz[ eidOut ] = storeA.dz[ eidA ] - storeB.dz[ eidB ];
  return eidOut;
}

export function bitecsRayScaleInPlace( eid, scalar, store = RayComponent ) {
  store.ox[ eid ] *= scalar;
  store.oy[ eid ] *= scalar;
  store.oz[ eid ] *= scalar;
  store.dx[ eid ] *= scalar;
  store.dy[ eid ] *= scalar;
  store.dz[ eid ] *= scalar;
  return eid;
}

export function bitecsRayNormalizeInPlace( eid, store = RayComponent ) {
  const dx = store.dx[ eid ], dy = store.dy[ eid ], dz = store.dz[ eid ];
  const len = Math.sqrt( dx * dx + dy * dy + dz * dz );
  if ( len === 0 ) {
    store.dx[ eid ] = 0;
    store.dy[ eid ] = 0;
    store.dz[ eid ] = -1;
    return eid;
  }
  const inv = 1 / len;
  store.dx[ eid ] = dx * inv;
  store.dy[ eid ] = dy * inv;
  store.dz[ eid ] = dz * inv;
  return eid;
}

export function bitecsVec3RayAtInto( eidOutVec, eidRay, t, storeRay = RayComponent, storeVec ) {
  storeVec.x[ eidOutVec ] = storeRay.ox[ eidRay ] + storeRay.dx[ eidRay ] * t;
  storeVec.y[ eidOutVec ] = storeRay.oy[ eidRay ] + storeRay.dy[ eidRay ] * t;
  storeVec.z[ eidOutVec ] = storeRay.oz[ eidRay ] + storeRay.dz[ eidRay ] * t;
  return eidOutVec;
}

export function threeVec3FromBitecsRayAt( out, eid, t, store = RayComponent ) {
  return _writeVec3(
    out,
    store.ox[ eid ] + store.dx[ eid ] * t,
    store.oy[ eid ] + store.dy[ eid ] * t,
    store.oz[ eid ] + store.dz[ eid ] * t
  );
}

export function bitecsRayClosestPointParameter( eidRay, eidPoint, storeRay = RayComponent, storePoint ) {
  const ox = storeRay.ox[ eidRay ], oy = storeRay.oy[ eidRay ], oz = storeRay.oz[ eidRay ];
  const dx = storeRay.dx[ eidRay ], dy = storeRay.dy[ eidRay ], dz = storeRay.dz[ eidRay ];
  const px = storePoint.x[ eidPoint ] - ox;
  const py = storePoint.y[ eidPoint ] - oy;
  const pz = storePoint.z[ eidPoint ] - oz;
  const t = px * dx + py * dy + pz * dz;
  return t < 0 ? 0 : t;
}

export function bitecsVec3RayClosestPointInto( eidOutVec, eidRay, eidPoint, storeRay = RayComponent, storePoint, storeVec ) {
  const t = bitecsRayClosestPointParameter( eidRay, eidPoint, storeRay, storePoint );
  return bitecsVec3RayAtInto( eidOutVec, eidRay, t, storeRay, storeVec );
}

export function threeVec3FromBitecsRayClosestPoint( out, eidRay, eidPoint, storeRay = RayComponent, storePoint ) {
  const t = bitecsRayClosestPointParameter( eidRay, eidPoint, storeRay, storePoint );
  return threeVec3FromBitecsRayAt( out, eidRay, t, storeRay );
}

export function bitecsRayDistanceSqToPoint( eidRay, eidPoint, storeRay = RayComponent, storePoint ) {
  const t = bitecsRayClosestPointParameter( eidRay, eidPoint, storeRay, storePoint );
  const cx = storeRay.ox[ eidRay ] + storeRay.dx[ eidRay ] * t - storePoint.x[ eidPoint ];
  const cy = storeRay.oy[ eidRay ] + storeRay.dy[ eidRay ] * t - storePoint.y[ eidPoint ];
  const cz = storeRay.oz[ eidRay ] + storeRay.dz[ eidRay ] * t - storePoint.z[ eidPoint ];
  return cx * cx + cy * cy + cz * cz;
}

export function bitecsRayDistanceToPoint( eidRay, eidPoint, storeRay = RayComponent, storePoint ) {
  return Math.sqrt( bitecsRayDistanceSqToPoint( eidRay, eidPoint, storeRay, storePoint ) );
}

export function bitecsRayIntersectsSphere( eidRay, eidSphere, storeRay = RayComponent, storeSphere ) {
  if ( storeSphere.radius[ eidSphere ] < 0 ) return false;
  const ox = storeRay.ox[ eidRay ], oy = storeRay.oy[ eidRay ], oz = storeRay.oz[ eidRay ];
  const dx = storeRay.dx[ eidRay ], dy = storeRay.dy[ eidRay ], dz = storeRay.dz[ eidRay ];
  const lx = storeSphere.cx[ eidSphere ] - ox;
  const ly = storeSphere.cy[ eidSphere ] - oy;
  const lz = storeSphere.cz[ eidSphere ] - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  const r = storeSphere.radius[ eidSphere ];
  return d2 <= r * r;
}

export function bitecsRayIntersectsPlane( eidRay, eidPlane, storeRay = RayComponent, storePlane ) {
  const nx = storePlane.nx[ eidPlane ], ny = storePlane.ny[ eidPlane ], nz = storePlane.nz[ eidPlane ];
  const c = storePlane.constant[ eidPlane ];
  const ox = storeRay.ox[ eidRay ], oy = storeRay.oy[ eidRay ], oz = storeRay.oz[ eidRay ];
  const dx = storeRay.dx[ eidRay ], dy = storeRay.dy[ eidRay ], dz = storeRay.dz[ eidRay ];
  const distToPoint = nx * ox + ny * oy + nz * oz + c;
  if ( distToPoint === 0 ) return true;
  const denom = nx * dx + ny * dy + nz * dz;
  return denom * distToPoint < 0;
}

export function bitecsRayIntersectsBox( eidRay, eidBox, storeRay = RayComponent, storeBox ) {
  const ox = storeRay.ox[ eidRay ], oy = storeRay.oy[ eidRay ], oz = storeRay.oz[ eidRay ];
  const dx = storeRay.dx[ eidRay ], dy = storeRay.dy[ eidRay ], dz = storeRay.dz[ eidRay ];
  const invX = dx !== 0 ? 1 / dx : Infinity;
  const invY = dy !== 0 ? 1 / dy : Infinity;
  const invZ = dz !== 0 ? 1 / dz : Infinity;

  let tmin, tmax, tymin, tymax, tzmin, tzmax;
  if ( invX >= 0 ) {
    tmin = ( storeBox.minX[ eidBox ] - ox ) * invX;
    tmax = ( storeBox.maxX[ eidBox ] - ox ) * invX;
  } else {
    tmin = ( storeBox.maxX[ eidBox ] - ox ) * invX;
    tmax = ( storeBox.minX[ eidBox ] - ox ) * invX;
  }
  if ( invY >= 0 ) {
    tymin = ( storeBox.minY[ eidBox ] - oy ) * invY;
    tymax = ( storeBox.maxY[ eidBox ] - oy ) * invY;
  } else {
    tymin = ( storeBox.maxY[ eidBox ] - oy ) * invY;
    tymax = ( storeBox.minY[ eidBox ] - oy ) * invY;
  }
  if ( tmin > tymax || tymin > tmax ) return false;
  if ( tymin > tmin || tmin !== tmin ) tmin = tymin;
  if ( tymax < tmax || tmax !== tmax ) tmax = tymax;

  if ( invZ >= 0 ) {
    tzmin = ( storeBox.minZ[ eidBox ] - oz ) * invZ;
    tzmax = ( storeBox.maxZ[ eidBox ] - oz ) * invZ;
  } else {
    tzmin = ( storeBox.maxZ[ eidBox ] - oz ) * invZ;
    tzmax = ( storeBox.minZ[ eidBox ] - oz ) * invZ;
  }
  if ( tmin > tzmax || tzmin > tmax ) return false;
  if ( tzmin > tmin || tmin !== tmin ) tmin = tzmin;
  if ( tzmax < tmax || tmax !== tmax ) tmax = tzmax;

  return tmax >= 0;
}

export function bitecsRayIntersectsTriangle( eidRay, eidA, eidB, eidC, backfaceCulling, storeRay = RayComponent, storeA, storeB, storeC ) {
  const ax = storeA.x[ eidA ], ay = storeA.y[ eidA ], az = storeA.z[ eidA ];
  const bx = storeB.x[ eidB ], by = storeB.y[ eidB ], bz = storeB.z[ eidB ];
  const cx = storeC.x[ eidC ], cy = storeC.y[ eidC ], cz = storeC.z[ eidC ];

  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;

  const dx = storeRay.dx[ eidRay ], dy = storeRay.dy[ eidRay ], dz = storeRay.dz[ eidRay ];
  let DdN = dx * nx + dy * ny + dz * nz;
  let sign;
  if ( DdN > 0 ) {
    if ( backfaceCulling ) return false;
    sign = 1;
  } else if ( DdN < 0 ) {
    sign = -1;
    DdN = -DdN;
  } else {
    return false;
  }

  const ox = storeRay.ox[ eidRay ], oy = storeRay.oy[ eidRay ], oz = storeRay.oz[ eidRay ];
  const diffx = ox - ax, diffy = oy - ay, diffz = oz - az;

  const cx2 = diffy * e2z - diffz * e2y;
  const cy2 = diffz * e2x - diffx * e2z;
  const cz2 = diffx * e2y - diffy * e2x;
  const DdQxE2 = sign * ( dx * cx2 + dy * cy2 + dz * cz2 );
  if ( DdQxE2 < 0 ) return false;

  const cx3 = e1y * diffz - e1z * diffy;
  const cy3 = e1z * diffx - e1x * diffz;
  const cz3 = e1x * diffy - e1y * diffx;
  const DdE1xQ = sign * ( dx * cx3 + dy * cy3 + dz * cz3 );
  if ( DdE1xQ < 0 ) return false;

  if ( DdQxE2 + DdE1xQ > DdN ) return false;

  const QdN = -sign * ( diffx * nx + diffy * ny + diffz * nz );
  return QdN >= 0;
}

export function bitecsRayApplyMatrix4InPlace( eid, m, storeRay = RayComponent ) {
  const me = _matrixElements( m );
  const ox = storeRay.ox[ eid ], oy = storeRay.oy[ eid ], oz = storeRay.oz[ eid ];
  const w = me[ 3 ] * ox + me[ 7 ] * oy + me[ 11 ] * oz + me[ 15 ] || 1.0;
  const invW = 1 / w;
  storeRay.ox[ eid ] = ( me[ 0 ] * ox + me[ 4 ] * oy + me[ 8 ]  * oz + me[ 12 ] ) * invW;
  storeRay.oy[ eid ] = ( me[ 1 ] * ox + me[ 5 ] * oy + me[ 9 ]  * oz + me[ 13 ] ) * invW;
  storeRay.oz[ eid ] = ( me[ 2 ] * ox + me[ 6 ] * oy + me[ 10 ] * oz + me[ 14 ] ) * invW;

  const dx = storeRay.dx[ eid ], dy = storeRay.dy[ eid ], dz = storeRay.dz[ eid ];
  let ndx = me[ 0 ] * dx + me[ 4 ] * dy + me[ 8 ]  * dz;
  let ndy = me[ 1 ] * dx + me[ 5 ] * dy + me[ 9 ]  * dz;
  let ndz = me[ 2 ] * dx + me[ 6 ] * dy + me[ 10 ] * dz;
  const len = Math.sqrt( ndx * ndx + ndy * ndy + ndz * ndz );
  if ( len > 0 ) {
    const inv = 1 / len;
    ndx *= inv; ndy *= inv; ndz *= inv;
  }
  storeRay.dx[ eid ] = ndx;
  storeRay.dy[ eid ] = ndy;
  storeRay.dz[ eid ] = ndz;
  return eid;
}

export function bitecsRayLookAtInPlace( eid, eidTarget, storeRay = RayComponent, storeTarget ) {
  const x = storeTarget.x[ eidTarget ] - storeRay.ox[ eid ];
  const y = storeTarget.y[ eidTarget ] - storeRay.oy[ eid ];
  const z = storeTarget.z[ eidTarget ] - storeRay.oz[ eid ];
  const len = Math.sqrt( x * x + y * y + z * z );
  if ( len === 0 ) {
    storeRay.dx[ eid ] = 0;
    storeRay.dy[ eid ] = 0;
    storeRay.dz[ eid ] = -1;
    return eid;
  }
  const inv = 1 / len;
  storeRay.dx[ eid ] = x * inv;
  storeRay.dy[ eid ] = y * inv;
  storeRay.dz[ eid ] = z * inv;
  return eid;
}

// ────────────── flat-array helpers on top of bitecs ──────────────

export function glMatrixVec3LerpFromBitecsRays( out, eidA, eidB, t, storeA = RayComponent, storeB = RayComponent ) {
  _scratchA.x = storeA.ox[ eidA ];
  _scratchA.y = storeA.oy[ eidA ];
  _scratchA.z = storeA.oz[ eidA ];
  _scratchB.x = storeB.ox[ eidB ];
  _scratchB.y = storeB.oy[ eidB ];
  _scratchB.z = storeB.oz[ eidB ];
  out[ 0 ] = _scratchA.x + t * ( _scratchB.x - _scratchA.x );
  out[ 1 ] = _scratchA.y + t * ( _scratchB.y - _scratchA.y );
  out[ 2 ] = _scratchA.z + t * ( _scratchB.z - _scratchA.z );
  return out;
}

export function glMatrixVec3DirectionFromBitecsRay( out, eid, store = RayComponent ) {
  const dx = store.dx[ eid ], dy = store.dy[ eid ], dz = store.dz[ eid ];
  const len = Math.sqrt( dx * dx + dy * dy + dz * dz );
  if ( len === 0 ) {
    out[ 0 ] = 0;
    out[ 1 ] = 0;
    out[ 2 ] = -1;
    return out;
  }
  const inv = 1 / len;
  out[ 0 ] = dx * inv;
  out[ 1 ] = dy * inv;
  out[ 2 ] = dz * inv;
  return out;
}

export function glMatrixVec3OriginFromBitecsRay( out, eid, store = RayComponent ) {
  out[ 0 ] = store.ox[ eid ];
  out[ 1 ] = store.oy[ eid ];
  out[ 2 ] = store.oz[ eid ];
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// HIGH-PRECISION (DoubleDouble) HELPERS — galactic-scale origins
// ═══════════════════════════════════════════════════════════════════

export function preciseClosestPointParameter( ray, point ) {
  const dx = DD.fromDouble( _rx( ray.direction ) );
  const dy = DD.fromDouble( _ry( ray.direction ) );
  const dz = DD.fromDouble( _rz( ray.direction ) );
  const px = DD.subtract( DD.fromDouble( _rx( point ) ), DD.fromDouble( _rx( ray.origin ) ) );
  const py = DD.subtract( DD.fromDouble( _ry( point ) ), DD.fromDouble( _ry( ray.origin ) ) );
  const pz = DD.subtract( DD.fromDouble( _rz( point ) ), DD.fromDouble( _rz( ray.origin ) ) );
  return DD.toDouble(
    DD.add(
      DD.add( DD.multiply( px, dx ), DD.multiply( py, dy ) ),
      DD.multiply( pz, dz )
    )
  );
}

export function preciseDistanceSqToPoint( ray, point ) {
  const tRaw = preciseClosestPointParameter( ray, point );
  const t = tRaw < 0 ? 0 : tRaw;
  const ox = DD.fromDouble( _rx( ray.origin ) );
  const oy = DD.fromDouble( _ry( ray.origin ) );
  const oz = DD.fromDouble( _rz( ray.origin ) );
  const dx = DD.fromDouble( _rx( ray.direction ) );
  const dy = DD.fromDouble( _ry( ray.direction ) );
  const dz = DD.fromDouble( _rz( ray.direction ) );
  const tD = DD.fromDouble( t );
  const cx = DD.add( ox, DD.multiply( dx, tD ) );
  const cy = DD.add( oy, DD.multiply( dy, tD ) );
  const cz = DD.add( oz, DD.multiply( dz, tD ) );
  const ex = DD.subtract( DD.fromDouble( _rx( point ) ), cx );
  const ey = DD.subtract( DD.fromDouble( _ry( point ) ), cy );
  const ez = DD.subtract( DD.fromDouble( _rz( point ) ), cz );
  return DD.toDouble(
    DD.add(
      DD.add( DD.multiply( ex, ex ), DD.multiply( ey, ey ) ),
      DD.multiply( ez, ez )
    )
  );
}

export function preciseDistanceToPoint( ray, point ) {
  return Math.sqrt( preciseDistanceSqToPoint( ray, point ) );
}

// ═══════════════════════════════════════════════════════════════════
// PROCEDURAL NOISE — random ray from a 3D simplex field
// ═══════════════════════════════════════════════════════════════════

export function setFromNoise3D( out, x, y, z, seed = 0, originScale = 1 ) {
  const n = _cachedNoise3D( seed );
  _writeVec3(
    out.origin,
    n( x, y, z ) * originScale,
    n( x + 31.416, y + 47.853, z + 12.793 ) * originScale,
    n( x - 17.234, y - 53.127, z - 91.056 ) * originScale
  );
  const dx = n( x + 100.1, y + 200.2, z + 300.3 );
  const dy = n( x - 110.5, y - 210.6, z - 310.7 );
  const dz = n( x + 55.1, y - 66.2, z + 77.3 );
  const len = Math.sqrt( dx * dx + dy * dy + dz * dz );
  if ( len === 0 ) {
    _writeVec3( out.direction, 0, 0, -1 );
  } else {
    const inv = 1 / len;
    _writeVec3( out.direction, dx * inv, dy * inv, dz * inv );
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// Named + default exports
// ═══════════════════════════════════════════════════════════════════
export { Ray };
export default Ray;