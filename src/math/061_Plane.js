// file number : 061
// full path name : src/math/061_Plane.js
// description : Plane primitive in Hessian normal form (unit normal + constant) — drop-in replacement for THREE.Plane (r185). Normal is a duck-typed Vector3-like ({x,y,z} or flat array), constant is a scalar, and the r185 convention `normal · point + constant = 0` is preserved (so positive distance means "in front of" the plane). Complete r185 surface: constructor(normal, constant), set(normal, constant), setComponents(x,y,z,w), setFromNormalAndCoplanarPoint(normal, point), setFromCoplanarPoints(a, b, c), copy(plane), normalize(), negate(), distanceToPoint(point), distanceToSphere(sphere), projectPoint(point, target), intersectLine(line, target), intersectsLine(line), intersectsBox(box), intersectsSphere(sphere), coplanarPoint(target), applyMatrix4(matrix, optionalNormalMatrix), translate(offset), equals(plane), clone(). Extended: preciseDistanceToPoint / preciseNormalize / preciseProjectPointInto using the chat's DoubleDouble (014) for galactic-scale signed distances; setFromNoise3D via the chat's SimplexNoise (013) with cached per-seed mulberry32 generator; full zero-allocation bitECS SoA bridge set (from/to/add/sub/scale-in-place/negate-in-place/normalize-in-place, distanceToPoint, distanceToSphere, project-point) using f32([]) SoA arrays from 014_BitECS; flat-array and duck-typed interop everywhere; line–plane intersection helper returning `{ t, point }` or `null`; frustum plane extraction helper from a 4x4 matrix (caller supplies side index 0..5 and gets the packed [nx,ny,nz,c]); and a recycled local pool (Plane.acquire / Plane.recycle) that resets the normal to (1,0,0) and the constant to 0. No THREE, no CDN, no static server, no Vite/Vue — imports only from the chat's own files (003_Common clamp, 013_SimplexNoise, 014_DoubleDouble, 014_BitECS).
// best for : frustum culling, clipping planes, ray/plane intersection, half-space queries, shadow-map planes, PBR reflection planes, and any ECS system that stores planes as SoA normal+constant and must feed THREE.Plane, THREE.Frustum, or shader clipping uniforms without allocating per frame. The pooled variant is the recommended path for hot loops iterating over 10k+ entities.
// license : MIT

import { clamp } from '../core/003_Common.js';
import * as DD from './014_DoubleDouble.js';
import * as bitecs from './014_BitECS.js';
import { createNoise3D } from './013_SimplexNoise.js';

// ═══════════════════════════════════════════════════════════════════
// bitECS 0.4.0 SoA COMPONENT (archetype-friendly, cache-friendly)
// ═══════════════════════════════════════════════════════════════════
export const PlaneComponent = {
  nx:       bitecs.f32([]),
  ny:       bitecs.f32([]),
  nz:       bitecs.f32([]),
  constant: bitecs.f32([])
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

// Applies m to point, dividing by w. Writes into out.
function _transformPoint( out, x, y, z, m ) {
  const w = m[ 3 ] * x + m[ 7 ] * y + m[ 11 ] * z + m[ 15 ] || 1.0;
  return _writeVec3(
    out,
    ( m[ 0 ] * x + m[ 4 ] * y + m[ 8 ]  * z + m[ 12 ] ) / w,
    ( m[ 1 ] * x + m[ 5 ] * y + m[ 9 ]  * z + m[ 13 ] ) / w,
    ( m[ 2 ] * x + m[ 6 ] * y + m[ 10 ] * z + m[ 14 ] ) / w
  );
}

// Applies m as a *direction* (no translation, no w-divide) — used to
// transform a plane's normal by the inverse-transpose of m.
function _transformDirectionNormalized( out, x, y, z, m ) {
  const nx = m[ 0 ] * x + m[ 4 ] * y + m[ 8 ]  * z;
  const ny = m[ 1 ] * x + m[ 5 ] * y + m[ 9 ]  * z;
  const nz = m[ 2 ] * x + m[ 6 ] * y + m[ 10 ] * z;
  const len = Math.sqrt( nx * nx + ny * ny + nz * nz );
  if ( len === 0 ) return _writeVec3( out, 0, 0, 0 );
  const inv = 1 / len;
  return _writeVec3( out, nx * inv, ny * inv, nz * inv );
}

// Reads a 3x3 normal matrix (from THREE.Matrix3) or a 4x4, and produces the
// 3x3 inverse-transpose needed to transform plane normals. Writes into out9
// as a flat 9-array (column-major, matching THREE.Matrix3 layout).
function _computeNormalMatrix( out9, m4 ) {
  // Inverse-transpose of the upper-left 3x3 of m4. m4 is column-major.
  const a00 = m4[ 0 ], a01 = m4[ 4 ], a02 = m4[ 8 ];
  const a10 = m4[ 1 ], a11 = m4[ 5 ], a12 = m4[ 9 ];
  const a20 = m4[ 2 ], a21 = m4[ 6 ], a22 = m4[ 10 ];
  const b01 =  a22 * a11 - a12 * a21;
  const b11 = -a22 * a10 + a12 * a20;
  const b21 =  a21 * a10 - a11 * a20;
  let det = a00 * b01 + a01 * b11 + a02 * b21;
  if ( det === 0 ) {
    out9[ 0 ] = out9[ 1 ] = out9[ 2 ] = out9[ 3 ] = out9[ 4 ] = out9[ 5 ] = out9[ 6 ] = out9[ 7 ] = out9[ 8 ] = 0;
    return out9;
  }
  det = 1 / det;
  // Inverse (untransposed) in row-major
  const i00 =  b01 * det;
  const i01 = (-a22 * a01 + a02 * a21) * det;
  const i02 = ( a12 * a01 - a02 * a11) * det;
  const i10 =  b11 * det;
  const i11 = ( a22 * a00 - a02 * a20) * det;
  const i12 = (-a12 * a00 + a02 * a10) * det;
  const i20 =  b21 * det;
  const i21 = (-a21 * a00 + a01 * a20) * det;
  const i22 = ( a11 * a00 - a01 * a10) * det;
  // Transpose → write as column-major
  out9[ 0 ] = i00; out9[ 1 ] = i10; out9[ 2 ] = i20;
  out9[ 3 ] = i01; out9[ 4 ] = i11; out9[ 5 ] = i21;
  out9[ 6 ] = i02; out9[ 7 ] = i12; out9[ 8 ] = i22;
  return out9;
}

// Applies a 3x3 (column-major) to a direction and normalizes the result.
function _apply3x3Normalized( out, x, y, z, n9 ) {
  const nx = n9[ 0 ] * x + n9[ 3 ] * y + n9[ 6 ] * z;
  const ny = n9[ 1 ] * x + n9[ 4 ] * y + n9[ 7 ] * z;
  const nz = n9[ 2 ] * x + n9[ 5 ] * y + n9[ 8 ] * z;
  const len = Math.sqrt( nx * nx + ny * ny + nz * nz );
  if ( len === 0 ) return _writeVec3( out, 0, 0, 0 );
  const inv = 1 / len;
  return _writeVec3( out, nx * inv, ny * inv, nz * inv );
}

// ────────────── noise generator cache ──────────────
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

// Scratch buffers used by applyMatrix4 / intersectLine / etc.
const _normalMatrixScratch = new Float64Array( 9 );
const _coplanarScratch = _vec3();
const _dirScratch = _vec3();

// ═══════════════════════════════════════════════════════════════════
// class Plane
// ═══════════════════════════════════════════════════════════════════
class Plane {

  constructor( normal = _vec3( 1, 0, 0 ), constant = 0 ) {
    this.isPlane = true;
    this.normal = normal;
    this.constant = constant;
  }

  set( normal, constant ) {
    _copyVec3Into( this.normal, normal );
    this.constant = constant;
    return this;
  }

  setComponents( x, y, z, w ) {
    _writeVec3( this.normal, x, y, z );
    this.constant = w;
    return this;
  }

  setFromNormalAndCoplanarPoint( normal, point ) {
    _copyVec3Into( this.normal, normal );
    this.constant = -( _rx( point ) * _rx( this.normal ) + _ry( point ) * _ry( this.normal ) + _rz( point ) * _rz( this.normal ) );
    return this;
  }

  setFromCoplanarPoints( a, b, c ) {
    const cbx = _rx( c ) - _rx( b ), cby = _ry( c ) - _ry( b ), cbz = _rz( c ) - _rz( b );
    const abx = _rx( a ) - _rx( b ), aby = _ry( a ) - _ry( b ), abz = _rz( a ) - _rz( b );
    let nx = cby * abz - cbz * aby;
    let ny = cbz * abx - cbx * abz;
    let nz = cbx * aby - cby * abx;
    const len = Math.sqrt( nx * nx + ny * ny + nz * nz );
    if ( len === 0 ) {
      _writeVec3( this.normal, 1, 0, 0 );
      this.constant = -_rx( a );
      return this;
    }
    const inv = 1 / len;
    nx *= inv; ny *= inv; nz *= inv;
    _writeVec3( this.normal, nx, ny, nz );
    this.constant = -( nx * _rx( a ) + ny * _ry( a ) + nz * _rz( a ) );
    return this;
  }

  copy( plane ) {
    _copyVec3Into( this.normal, plane.normal );
    this.constant = plane.constant;
    return this;
  }

  normalize() {
    const nx = _rx( this.normal ), ny = _ry( this.normal ), nz = _rz( this.normal );
    const len = Math.sqrt( nx * nx + ny * ny + nz * nz );
    if ( len === 0 ) {
      _writeVec3( this.normal, 1, 0, 0 );
      this.constant = 0;
      return this;
    }
    const inv = 1 / len;
    _writeVec3( this.normal, nx * inv, ny * inv, nz * inv );
    this.constant *= inv;
    return this;
  }

  negate() {
    _writeVec3( this.normal, -_rx( this.normal ), -_ry( this.normal ), -_rz( this.normal ) );
    this.constant = -this.constant;
    return this;
  }

  distanceToPoint( point ) {
    return _rx( this.normal ) * _rx( point )
         + _ry( this.normal ) * _ry( point )
         + _rz( this.normal ) * _rz( point )
         + this.constant;
  }

  distanceToSphere( sphere ) {
    const cx = sphere.center.x !== undefined ? sphere.center.x : sphere.center[ 0 ];
    const cy = sphere.center.y !== undefined ? sphere.center.y : sphere.center[ 1 ];
    const cz = sphere.center.z !== undefined ? sphere.center.z : sphere.center[ 2 ];
    return _rx( this.normal ) * cx + _ry( this.normal ) * cy + _rz( this.normal ) * cz + this.constant - sphere.radius;
  }

  projectPoint( point, target ) {
    const d = this.distanceToPoint( point );
    return _writeVec3(
      target,
      _rx( point ) - _rx( this.normal ) * d,
      _ry( point ) - _ry( this.normal ) * d,
      _rz( point ) - _rz( this.normal ) * d
    );
  }

  intersectLine( line, target ) {
    const dx = _rx( line.end ) - _rx( line.start );
    const dy = _ry( line.end ) - _ry( line.start );
    const dz = _rz( line.end ) - _rz( line.start );
    const denom = _rx( this.normal ) * dx + _ry( this.normal ) * dy + _rz( this.normal ) * dz;
    if ( denom === 0 ) {
      const sd = _rx( this.normal ) * _rx( line.start ) + _ry( this.normal ) * _ry( line.start ) + _rz( this.normal ) * _rz( line.start ) + this.constant;
      if ( sd === 0 ) return _writeVec3( target, _rx( line.start ), _ry( line.start ), _rz( line.start ) );
      return null;
    }
    const t = -( _rx( line.start ) * _rx( this.normal ) + _ry( line.start ) * _ry( this.normal ) + _rz( line.start ) * _rz( this.normal ) + this.constant ) / denom;
    if ( t < 0 || t > 1 ) return null;
    return _writeVec3(
      target,
      _rx( line.start ) + dx * t,
      _ry( line.start ) + dy * t,
      _rz( line.start ) + dz * t
    );
  }

  intersectsLine( line ) {
    const s0 = _rx( this.normal ) * _rx( line.start ) + _ry( this.normal ) * _ry( line.start ) + _rz( this.normal ) * _rz( line.start ) + this.constant;
    const s1 = _rx( this.normal ) * _rx( line.end )   + _ry( this.normal ) * _ry( line.end )   + _rz( this.normal ) * _rz( line.end )   + this.constant;
    return ( s0 < 0 && s1 > 0 ) || ( s1 < 0 && s0 > 0 );
  }

  intersectsBox( box ) {
    // Thin wrapper: use the box's own method if available, else compute.
    if ( box && typeof box.intersectsPlane === 'function' ) return box.intersectsPlane( this );
    // Manual AABB test
    let min = 0, max = 0;
    const nx = _rx( this.normal ), ny = _ry( this.normal ), nz = _rz( this.normal );
    const bxMinX = box.min && box.min.x !== undefined ? box.min.x : box.minX;
    const bxMinY = box.min && box.min.y !== undefined ? box.min.y : box.minY;
    const bxMinZ = box.min && box.min.z !== undefined ? box.min.z : box.minZ;
    const bxMaxX = box.max && box.max.x !== undefined ? box.max.x : box.maxX;
    const bxMaxY = box.max && box.max.y !== undefined ? box.max.y : box.maxY;
    const bxMaxZ = box.max && box.max.z !== undefined ? box.max.z : box.maxZ;
    if ( nx > 0 ) { min += nx * bxMinX; max += nx * bxMaxX; } else { min += nx * bxMaxX; max += nx * bxMinX; }
    if ( ny > 0 ) { min += ny * bxMinY; max += ny * bxMaxY; } else { min += ny * bxMaxY; max += ny * bxMinY; }
    if ( nz > 0 ) { min += nz * bxMinZ; max += nz * bxMaxZ; } else { min += nz * bxMaxZ; max += nz * bxMinZ; }
    return ( min <= -this.constant && max >= -this.constant );
  }

  intersectsSphere( sphere ) {
    const cx = sphere.center.x !== undefined ? sphere.center.x : sphere.center[ 0 ];
    const cy = sphere.center.y !== undefined ? sphere.center.y : sphere.center[ 1 ];
    const cz = sphere.center.z !== undefined ? sphere.center.z : sphere.center[ 2 ];
    const d = _rx( this.normal ) * cx + _ry( this.normal ) * cy + _rz( this.normal ) * cz + this.constant;
    return Math.abs( d ) <= sphere.radius;
  }

  coplanarPoint( target ) {
    return _writeVec3(
      target,
      -this.constant * _rx( this.normal ),
      -this.constant * _ry( this.normal ),
      -this.constant * _rz( this.normal )
    );
  }

  applyMatrix4( matrix, optionalNormalMatrix ) {
    const me = _matrixElements( matrix );
    // Coplanar reference point transformed by the full matrix.
    _coplanarScratch.x = -this.constant * _rx( this.normal );
    _coplanarScratch.y = -this.constant * _ry( this.normal );
    _coplanarScratch.z = -this.constant * _rz( this.normal );
    _transformPoint( _coplanarScratch, _coplanarScratch.x, _coplanarScratch.y, _coplanarScratch.z, me );

    let n9;
    if ( optionalNormalMatrix !== undefined && optionalNormalMatrix !== null ) {
      const nm = optionalNormalMatrix.elements !== undefined ? optionalNormalMatrix.elements : optionalNormalMatrix;
      n9 = nm;
    } else {
      n9 = _computeNormalMatrix( _normalMatrixScratch, me );
    }
    _apply3x3Normalized( this.normal, _rx( this.normal ), _ry( this.normal ), _rz( this.normal ), n9 );
    this.constant = -( _rx( this.normal ) * _coplanarScratch.x + _ry( this.normal ) * _coplanarScratch.y + _rz( this.normal ) * _coplanarScratch.z );
    return this;
  }

  translate( offset ) {
    this.constant -= _rx( offset ) * _rx( this.normal ) + _ry( offset ) * _ry( this.normal ) + _rz( offset ) * _rz( this.normal );
    return this;
  }

  equals( plane ) {
    return _rx( this.normal ) === _rx( plane.normal )
        && _ry( this.normal ) === _ry( plane.normal )
        && _rz( this.normal ) === _rz( plane.normal )
        && this.constant === plane.constant;
  }

  clone() {
    return new this.constructor( _vec3( _rx( this.normal ), _ry( this.normal ), _rz( this.normal ) ), this.constant );
  }

  // ────────────── flat array interop ──────────────

  toArray( array = [], offset = 0 ) {
    array[ offset ]     = _rx( this.normal );
    array[ offset + 1 ] = _ry( this.normal );
    array[ offset + 2 ] = _rz( this.normal );
    array[ offset + 3 ] = this.constant;
    return array;
  }

  fromArray( array, offset = 0 ) {
    _writeVec3( this.normal, array[ offset ], array[ offset + 1 ], array[ offset + 2 ] );
    this.constant = array[ offset + 3 ];
    return this;
  }

  // ────────────── pooled instances ──────────────

  static acquire() {
    return _localPool.length > 0 ? _localPool.pop() : new Plane();
  }

  static recycle( plane ) {
    if ( plane instanceof Plane && _localPool.length < LOCAL_POOL_MAX ) {
      _writeVec3( plane.normal, 1, 0, 0 );
      plane.constant = 0;
      _localPool.push( plane );
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// BRIDGE: THREE-style <-> flat array
// ═══════════════════════════════════════════════════════════════════

export function threePlaneFromGlMatrixPacked( out, glPacked ) {
  _writeVec3( out.normal, glPacked[ 0 ], glPacked[ 1 ], glPacked[ 2 ] );
  out.constant = glPacked[ 3 ];
  return out;
}

export function threePlaneFromGlMatrix( out, glNormal, constant ) {
  _writeVec3( out.normal, glNormal[ 0 ], glNormal[ 1 ], glNormal[ 2 ] );
  out.constant = constant;
  return out;
}

export function glMatrixPlanePackedFromThree( outPacked, threePlane ) {
  outPacked[ 0 ] = _rx( threePlane.normal );
  outPacked[ 1 ] = _ry( threePlane.normal );
  outPacked[ 2 ] = _rz( threePlane.normal );
  outPacked[ 3 ] = threePlane.constant;
  return outPacked;
}

export function glMatrixPlaneFromThree( outNormal, threePlane ) {
  outNormal[ 0 ] = _rx( threePlane.normal );
  outNormal[ 1 ] = _ry( threePlane.normal );
  outNormal[ 2 ] = _rz( threePlane.normal );
  return threePlane.constant;
}

// ═══════════════════════════════════════════════════════════════════
// BRIDGE: THREE-style <-> bitECS SoA
// ═══════════════════════════════════════════════════════════════════

export function threePlaneFromBitecs( out, eid, store = PlaneComponent ) {
  _writeVec3( out.normal, store.nx[ eid ], store.ny[ eid ], store.nz[ eid ] );
  out.constant = store.constant[ eid ];
  return out;
}

export function bitecsPlaneFromThree( eid, threePlane, store = PlaneComponent ) {
  store.nx[ eid ] = _rx( threePlane.normal );
  store.ny[ eid ] = _ry( threePlane.normal );
  store.nz[ eid ] = _rz( threePlane.normal );
  store.constant[ eid ] = threePlane.constant;
  return eid;
}

export function bitecsPlaneFromGlMatrixPacked( eid, glPacked, store = PlaneComponent ) {
  store.nx[ eid ] = glPacked[ 0 ];
  store.ny[ eid ] = glPacked[ 1 ];
  store.nz[ eid ] = glPacked[ 2 ];
  store.constant[ eid ] = glPacked[ 3 ];
  return eid;
}

export function glMatrixPlanePackedFromBitecs( outPacked, eid, store = PlaneComponent ) {
  outPacked[ 0 ] = store.nx[ eid ];
  outPacked[ 1 ] = store.ny[ eid ];
  outPacked[ 2 ] = store.nz[ eid ];
  outPacked[ 3 ] = store.constant[ eid ];
  return outPacked;
}

export function glMatrixPlaneFromBitecs( outNormal, eid, store = PlaneComponent ) {
  outNormal[ 0 ] = store.nx[ eid ];
  outNormal[ 1 ] = store.ny[ eid ];
  outNormal[ 2 ] = store.nz[ eid ];
  return store.constant[ eid ];
}

export function bitecsPlaneCopyInto( eidOut, eidIn, storeIn = PlaneComponent, storeOut = storeIn ) {
  storeOut.nx[ eidOut ] = storeIn.nx[ eidIn ];
  storeOut.ny[ eidOut ] = storeIn.ny[ eidIn ];
  storeOut.nz[ eidOut ] = storeIn.nz[ eidIn ];
  storeOut.constant[ eidOut ] = storeIn.constant[ eidIn ];
  return eidOut;
}

export function bitecsPlaneAddInto( eidOut, eidA, eidB, storeA = PlaneComponent, storeB = PlaneComponent, storeOut = storeA ) {
  storeOut.nx[ eidOut ] = storeA.nx[ eidA ] + storeB.nx[ eidB ];
  storeOut.ny[ eidOut ] = storeA.ny[ eidA ] + storeB.ny[ eidB ];
  storeOut.nz[ eidOut ] = storeA.nz[ eidA ] + storeB.nz[ eidB ];
  storeOut.constant[ eidOut ] = storeA.constant[ eidA ] + storeB.constant[ eidB ];
  return eidOut;
}

export function bitecsPlaneSubInto( eidOut, eidA, eidB, storeA = PlaneComponent, storeB = PlaneComponent, storeOut = storeA ) {
  storeOut.nx[ eidOut ] = storeA.nx[ eidA ] - storeB.nx[ eidB ];
  storeOut.ny[ eidOut ] = storeA.ny[ eidA ] - storeB.ny[ eidB ];
  storeOut.nz[ eidOut ] = storeA.nz[ eidA ] - storeB.nz[ eidB ];
  storeOut.constant[ eidOut ] = storeA.constant[ eidA ] - storeB.constant[ eidB ];
  return eidOut;
}

export function bitecsPlaneScaleInPlace( eid, scalar, store = PlaneComponent ) {
  store.nx[ eid ] *= scalar;
  store.ny[ eid ] *= scalar;
  store.nz[ eid ] *= scalar;
  store.constant[ eid ] *= scalar;
  return eid;
}

export function bitecsPlaneNegateInPlace( eid, store = PlaneComponent ) {
  store.nx[ eid ] = -store.nx[ eid ];
  store.ny[ eid ] = -store.ny[ eid ];
  store.nz[ eid ] = -store.nz[ eid ];
  store.constant[ eid ] = -store.constant[ eid ];
  return eid;
}

export function bitecsPlaneNormalizeInPlace( eid, store = PlaneComponent ) {
  const nx = store.nx[ eid ], ny = store.ny[ eid ], nz = store.nz[ eid ];
  const len = Math.sqrt( nx * nx + ny * ny + nz * nz );
  if ( len === 0 ) {
    store.nx[ eid ] = 1;
    store.ny[ eid ] = 0;
    store.nz[ eid ] = 0;
    store.constant[ eid ] = 0;
    return eid;
  }
  const inv = 1 / len;
  store.nx[ eid ] = nx * inv;
  store.ny[ eid ] = ny * inv;
  store.nz[ eid ] = nz * inv;
  store.constant[ eid ] *= inv;
  return eid;
}

export function bitecsPlaneDistanceToPoint( eidPlane, eidPoint, storePlane = PlaneComponent, storePoint ) {
  return storePlane.nx[ eidPlane ] * storePoint.x[ eidPoint ]
       + storePlane.ny[ eidPlane ] * storePoint.y[ eidPoint ]
       + storePlane.nz[ eidPlane ] * storePoint.z[ eidPoint ]
       + storePlane.constant[ eidPlane ];
}

export function bitecsPlaneDistanceToSphere( eidPlane, eidSphere, storePlane = PlaneComponent, storeSphere ) {
  const cx = storeSphere.cx[ eidSphere ];
  const cy = storeSphere.cy[ eidSphere ];
  const cz = storeSphere.cz[ eidSphere ];
  const d = storePlane.nx[ eidPlane ] * cx + storePlane.ny[ eidPlane ] * cy + storePlane.nz[ eidPlane ] * cz + storePlane.constant[ eidPlane ];
  return d - storeSphere.radius[ eidSphere ];
}

export function bitecsVec3PlaneProjectPointInto( eidOutVec, eidPlane, eidPoint, storePlane = PlaneComponent, storePoint, storeVec ) {
  const d = bitecsPlaneDistanceToPoint( eidPlane, eidPoint, storePlane, storePoint );
  storeVec.x[ eidOutVec ] = storePoint.x[ eidPoint ] - storePlane.nx[ eidPlane ] * d;
  storeVec.y[ eidOutVec ] = storePoint.y[ eidPoint ] - storePlane.ny[ eidPlane ] * d;
  storeVec.z[ eidOutVec ] = storePoint.z[ eidPoint ] - storePlane.nz[ eidPlane ] * d;
  return eidOutVec;
}

export function threeVec3FromBitecsPlaneProjectPoint( out, eidPlane, eidPoint, storePlane = PlaneComponent, storePoint ) {
  const d = bitecsPlaneDistanceToPoint( eidPlane, eidPoint, storePlane, storePoint );
  return _writeVec3(
    out,
    storePoint.x[ eidPoint ] - storePlane.nx[ eidPlane ] * d,
    storePoint.y[ eidPoint ] - storePlane.ny[ eidPlane ] * d,
    storePoint.z[ eidPoint ] - storePlane.nz[ eidPlane ] * d
  );
}

// ────────────── line / plane intersection (bitecs SoA) ──────────────

export function bitecsPlaneLine3Intersect( eidPlane, eidLine, storePlane = PlaneComponent, storeLine = null ) {
  if ( storeLine === null ) throw new Error( 'storeLine (Line3Component) is required' );
  const nx = storePlane.nx[ eidPlane ], ny = storePlane.ny[ eidPlane ], nz = storePlane.nz[ eidPlane ];
  const c = storePlane.constant[ eidPlane ];
  const sx = storeLine.startX[ eidLine ], sy = storeLine.startY[ eidLine ], sz = storeLine.startZ[ eidLine ];
  const dx = storeLine.endX[ eidLine ] - sx, dy = storeLine.endY[ eidLine ] - sy, dz = storeLine.endZ[ eidLine ] - sz;
  const denom = nx * dx + ny * dy + nz * dz;
  if ( denom === 0 ) {
    return ( nx * sx + ny * sy + nz * sz + c === 0 ) ? { t: 0, x: sx, y: sy, z: sz } : null;
  }
  const t = -( nx * sx + ny * sy + nz * sz + c ) / denom;
  if ( t < 0 || t > 1 ) return null;
  return { t, x: sx + dx * t, y: sy + dy * t, z: sz + dz * t };
}

// ────────────── frustum plane extraction from a 4x4 matrix ──────────────

export function bitecsPlaneSetFromFrustumSide( eidPlane, m, side, storePlane = PlaneComponent ) {
  // m: 16-element column-major 4x4 (or THREE.Matrix4 with .elements)
  const me = _matrixElements( m );
  const m00 = me[ 0 ], m01 = me[ 4 ], m02 = me[ 8 ],  m03 = me[ 12 ];
  const m10 = me[ 1 ], m11 = me[ 5 ], m12 = me[ 9 ],  m13 = me[ 13 ];
  const m20 = me[ 2 ], m21 = me[ 6 ], m22 = me[ 10 ], m23 = me[ 14 ];
  const m30 = me[ 3 ], m31 = me[ 7 ], m32 = me[ 11 ], m33 = me[ 15 ];
  let nx, ny, nz, c;
  switch ( side ) {
    case 0: nx = m30 + m00; ny = m31 + m10; nz = m32 + m20; c = m33 + m03; break; // left
    case 1: nx = m30 - m00; ny = m31 - m10; nz = m32 - m20; c = m33 - m03; break; // right
    case 2: nx = m30 + m01; ny = m31 + m11; nz = m32 + m21; c = m33 + m13; break; // bottom
    case 3: nx = m30 - m01; ny = m31 - m11; nz = m32 - m21; c = m33 - m13; break; // top
    case 4: nx = m30 + m02; ny = m31 + m12; nz = m32 + m22; c = m33 + m23; break; // near
    case 5: nx = m30 - m02; ny = m31 - m12; nz = m32 - m22; c = m33 - m23; break; // far
    default: throw new Error( 'side must be 0..5' );
  }
  const len = Math.sqrt( nx * nx + ny * ny + nz * nz );
  if ( len === 0 ) {
    storePlane.nx[ eidPlane ] = 1;
    storePlane.ny[ eidPlane ] = 0;
    storePlane.nz[ eidPlane ] = 0;
    storePlane.constant[ eidPlane ] = 0;
  } else {
    const inv = 1 / len;
    storePlane.nx[ eidPlane ] = nx * inv;
    storePlane.ny[ eidPlane ] = ny * inv;
    storePlane.nz[ eidPlane ] = nz * inv;
    storePlane.constant[ eidPlane ] = c * inv;
  }
  return eidPlane;
}

// ═══════════════════════════════════════════════════════════════════
// HIGH-PRECISION (DoubleDouble) HELPERS
// ═══════════════════════════════════════════════════════════════════

export function preciseDistanceToPoint( plane, point ) {
  const nx = DD.fromDouble( _rx( plane.normal ) );
  const ny = DD.fromDouble( _ry( plane.normal ) );
  const nz = DD.fromDouble( _rz( plane.normal ) );
  const c  = DD.fromDouble( plane.constant );
  const px = DD.fromDouble( _rx( point ) );
  const py = DD.fromDouble( _ry( point ) );
  const pz = DD.fromDouble( _rz( point ) );
  return DD.toDouble(
    DD.add(
      DD.add( DD.multiply( nx, px ), DD.multiply( ny, py ) ),
      DD.add( DD.multiply( nz, pz ), c )
    )
  );
}

export function preciseNormalize( plane ) {
  const nx = DD.fromDouble( _rx( plane.normal ) );
  const ny = DD.fromDouble( _ry( plane.normal ) );
  const nz = DD.fromDouble( _rz( plane.normal ) );
  const len = DD.sqrt(
    DD.add(
      DD.add( DD.multiply( nx, nx ), DD.multiply( ny, ny ) ),
      DD.multiply( nz, nz )
    )
  );
  const lenD = DD.toDouble( len );
  if ( lenD === 0 ) {
    _writeVec3( plane.normal, 1, 0, 0 );
    plane.constant = 0;
    return plane;
  }
  const inv = DD.divide( DD.fromDouble( 1 ), len );
  _writeVec3(
    plane.normal,
    DD.toDouble( DD.multiply( nx, inv ) ),
    DD.toDouble( DD.multiply( ny, inv ) ),
    DD.toDouble( DD.multiply( nz, inv ) )
  );
  plane.constant = DD.toDouble( DD.multiply( DD.fromDouble( plane.constant ), inv ) );
  return plane;
}

export function preciseProjectPointInto( out, plane, point ) {
  const d = preciseDistanceToPoint( plane, point );
  const dD = DD.fromDouble( d );
  const nx = DD.multiply( DD.fromDouble( _rx( plane.normal ) ), dD );
  const ny = DD.multiply( DD.fromDouble( _ry( plane.normal ) ), dD );
  const nz = DD.multiply( DD.fromDouble( _rz( plane.normal ) ), dD );
  return _writeVec3(
    out,
    DD.toDouble( DD.subtract( DD.fromDouble( _rx( point ) ), nx ) ),
    DD.toDouble( DD.subtract( DD.fromDouble( _ry( point ) ), ny ) ),
    DD.toDouble( DD.subtract( DD.fromDouble( _rz( point ) ), nz ) )
  );
}

// ═══════════════════════════════════════════════════════════════════
// PROCEDURAL NOISE — random plane from a 3D simplex field
// ═══════════════════════════════════════════════════════════════════

export function setFromNoise3D( out, x, y, z, seed = 0, offset = 0 ) {
  const n = _cachedNoise3D( seed );
  let nx = n( x, y, z );
  let ny = n( x + 31.416, y + 47.853, z + 12.793 );
  let nz = n( x - 17.234, y - 53.127, z - 91.056 );
  const len = Math.sqrt( nx * nx + ny * ny + nz * nz );
  if ( len === 0 ) {
    _writeVec3( out.normal, 1, 0, 0 );
  } else {
    const inv = 1 / len;
    _writeVec3( out.normal, nx * inv, ny * inv, nz * inv );
  }
  out.constant = offset;
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// Named + default exports
// ═══════════════════════════════════════════════════════════════════
export { Plane };
export default Plane;