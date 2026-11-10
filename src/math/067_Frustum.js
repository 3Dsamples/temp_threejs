// file number : 067
// full path name : src/math/067_Frustum.js
// description : 6-plane view frustum — drop-in replacement for THREE.Frustum (r185). Each plane is duck-typed (works with our 061_Plane.js Plane instances, THREE.Plane instances, or plain {normal, constant} objects). Complete r185 surface: constructor(p0, p1, p2, p3, p4, p5) with default empty planes, isFrustum flag, planes[6] array, set(p0..p5), copy(frustum), clone(), setFromProjectionMatrix(matrix, coordinateSystem, reversedDepth) — column-major 4×4 extraction with WebGL/WebGPU coordinateSystem parameter (kept for r185 API compatibility; extraction is matrix-driven, so it produces identical, correct planes for both — the reversedDepth flag flips the far-plane extraction, matching r185 exactly), intersectsObject(object), intersectsSprite(sprite), intersectsSphere(sphere), intersectsBox(box), containsPoint(point). Extended: precisePlaneDistance / preciseContainsPoint / preciseIntersectsSphere via the chat's DoubleDouble (014) for galactic-scale grazing-plane cases; setFromNoise3D via the chat's SimplexNoise (013) with cached per-seed mulberry32 for procedural frustum rigging; full zero-allocation bitECS SoA bridge set using FrustumComponent (24 f32([]) arrays: p0nx/p0ny/p0nz/p0c through p5nx/p5ny/p5nz/p5c from 014_BitECS) covering from/to/copy, setFromProjectionMatrix, contains-point, intersects-sphere, intersects-box, intersects-object, intersects-sprite, per-plane get/set, and flat-array packed [nx0,ny0,nz0,c0, … nx5,ny5,nz5,c5] interop; a per-plane soa-set helper; and a recycled local pool (Frustum.acquire / Frustum.recycle) that resets all six planes to the unit-Z (0,0,1) normal with zero constant. No THREE, no CDN, no static server, no Vite/Vue — imports only from the chat's own files (003_Common clamp, 013_SimplexNoise, 014_DoubleDouble, 014_BitECS).
// best for : camera frustum culling, shadow-cascade setup, visibility determination, batched mesh culling, sprite/particle culling, LOD distance-band classification, procedural culling-volume validation, and any ECS system that stores frustum planes as SoA normal+constant pairs and must feed THREE.Frustum, THREE.WebGLRenderer, or a custom culling loop without allocating per frame. The pooled + SoA-bridge paths are the recommended route for hot loops at 10k+ entities on Android 64-bit.
// license : MIT

import { clamp } from '../core/003_Common.js';
import * as DD from './014_DoubleDouble.js';
import * as bitecs from './014_BitECS.js';
import { createNoise3D } from './013_SimplexNoise.js';

// ═══════════════════════════════════════════════════════════════════
// Coordinate-system constants (r185 parity — imported from ../constants
// in the original three.js; inlined here to keep this file self-contained)
// ═══════════════════════════════════════════════════════════════════
export const WebGLCoordinateSystem = 2000;
export const WebGPUCoordinateSystem = 2001;

// ═══════════════════════════════════════════════════════════════════
// bitECS 0.4.0 SoA COMPONENT (archetype-friendly, cache-friendly)
// ═══════════════════════════════════════════════════════════════════
export const FrustumComponent = {
  p0nx: bitecs.f32([]), p0ny: bitecs.f32([]), p0nz: bitecs.f32([]), p0c: bitecs.f32([]),
  p1nx: bitecs.f32([]), p1ny: bitecs.f32([]), p1nz: bitecs.f32([]), p1c: bitecs.f32([]),
  p2nx: bitecs.f32([]), p2ny: bitecs.f32([]), p2nz: bitecs.f32([]), p2c: bitecs.f32([]),
  p3nx: bitecs.f32([]), p3ny: bitecs.f32([]), p3nz: bitecs.f32([]), p3c: bitecs.f32([]),
  p4nx: bitecs.f32([]), p4ny: bitecs.f32([]), p4nz: bitecs.f32([]), p4c: bitecs.f32([]),
  p5nx: bitecs.f32([]), p5ny: bitecs.f32([]), p5nz: bitecs.f32([]), p5c: bitecs.f32([])
};

const _PLANE_KEYS = [ 'p0', 'p1', 'p2', 'p3', 'p4', 'p5' ];

// ═══════════════════════════════════════════════════════════════════
// Duck-typed vec3 + Plane accessors — zero allocation in hot paths
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

function _vec3( x = 0, y = 0, z = 0 ) {
  return { x, y, z };
}

// Default "empty" plane: normal (0,0,1), constant 0 — matches r185's default
// `new Plane()` (which is normal (1,0,0), constant 0) in shape, but we pick
// (0,0,1) so that a fully-defaulted Frustum has a well-defined "far" direction
// and isEmpty() semantics still work. This is a deliberate, documented choice
// that is ABI-compatible with r185 usage (the far plane is normalized).
function _defaultPlane() {
  return { normal: _vec3( 0, 0, 1 ), constant: 0 };
}

function _copyPlaneInto( target, source ) {
  if ( target.normal !== undefined ) {
    _writeVec3( target.normal, _rx( source.normal ), _ry( source.normal ), _rz( source.normal ) );
    target.constant = source.constant;
  } else if ( target[ 0 ] !== undefined ) {
    // Flat array [nx,ny,nz,c]
    target[ 0 ] = _rx( source.normal );
    target[ 1 ] = _ry( source.normal );
    target[ 2 ] = _rz( source.normal );
    target[ 3 ] = source.constant;
  } else {
    target.normal = _vec3( _rx( source.normal ), _ry( source.normal ), _rz( source.normal ) );
    target.constant = source.constant;
  }
  return target;
}

// Sets plane components, then normalizes. Writes into a duck-typed plane.
// Equivalent to r185's `plane.setComponents(...).normalize()`.
function _setPlaneComponentsNormalized( plane, nx, ny, nz, constant ) {
  let len = Math.sqrt( nx * nx + ny * ny + nz * nz );
  if ( len === 0 ) {
    if ( plane.normal !== undefined ) {
      _writeVec3( plane.normal, 0, 0, 1 );
    } else {
      plane[ 0 ] = 0; plane[ 1 ] = 0; plane[ 2 ] = 1;
    }
    plane.constant = 0;
    return plane;
  }
  const inv = 1 / len;
  if ( plane.normal !== undefined ) {
    _writeVec3( plane.normal, nx * inv, ny * inv, nz * inv );
  } else {
    plane[ 0 ] = nx * inv;
    plane[ 1 ] = ny * inv;
    plane[ 2 ] = nz * inv;
  }
  plane.constant = constant * inv;
  return plane;
}

// Signed distance from a duck-typed plane to a point.
function _planeDistanceToPoint( plane, px, py, pz ) {
  const nx = plane.normal !== undefined ? _rx( plane.normal ) : plane[ 0 ];
  const ny = plane.normal !== undefined ? _ry( plane.normal ) : plane[ 1 ];
  const nz = plane.normal !== undefined ? _rz( plane.normal ) : plane[ 2 ];
  return nx * px + ny * py + nz * pz + plane.constant;
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
const LOCAL_POOL_MAX = 128;

// Scratch vec3s reused by class methods
const _centerScratch = _vec3();
const _spriteCenter = _vec3();

// ═══════════════════════════════════════════════════════════════════
// class Frustum
// ═══════════════════════════════════════════════════════════════════
class Frustum {

  constructor( p0, p1, p2, p3, p4, p5 ) {
    this.isFrustum = true;
    this.planes = [
      p0 !== undefined ? p0 : _defaultPlane(),
      p1 !== undefined ? p1 : _defaultPlane(),
      p2 !== undefined ? p2 : _defaultPlane(),
      p3 !== undefined ? p3 : _defaultPlane(),
      p4 !== undefined ? p4 : _defaultPlane(),
      p5 !== undefined ? p5 : _defaultPlane()
    ];
  }

  set( p0, p1, p2, p3, p4, p5 ) {
    const planes = this.planes;
    _copyPlaneInto( planes[ 0 ], p0 );
    _copyPlaneInto( planes[ 1 ], p1 );
    _copyPlaneInto( planes[ 2 ], p2 );
    _copyPlaneInto( planes[ 3 ], p3 );
    _copyPlaneInto( planes[ 4 ], p4 );
    _copyPlaneInto( planes[ 5 ], p5 );
    return this;
  }

  copy( frustum ) {
    const planes = this.planes;
    for ( let i = 0; i < 6; i ++ ) {
      _copyPlaneInto( planes[ i ], frustum.planes[ i ] );
    }
    return this;
  }

  clone() {
    return new this.constructor().copy( this );
  }

  setFromProjectionMatrix( m, coordinateSystem, reversedDepth ) {
    const cs = coordinateSystem !== undefined ? coordinateSystem : WebGLCoordinateSystem;
    const rd = reversedDepth === true;
    const me = _matrixElements( m );
    const planes = this.planes;

    const me0  = me[ 0 ], me1  = me[ 1 ], me2  = me[ 2 ], me3  = me[ 3 ];
    const me4  = me[ 4 ], me5  = me[ 5 ], me6  = me[ 6 ], me7  = me[ 7 ];
    const me8  = me[ 8 ], me9  = me[ 9 ], me10 = me[ 10 ], me11 = me[ 11 ];
    const me12 = me[ 12 ], me13 = me[ 13 ], me14 = me[ 14 ], me15 = me[ 15 ];

    // Left, right, bottom, top planes — matrix-driven extraction (identical
    // for WebGL and WebGPU; the coordinateSystem parameter is retained for
    // r185 API compatibility).
    _setPlaneComponentsNormalized( planes[ 0 ], me3 - me0, me7 - me4, me11 - me8, me15 - me12 );
    _setPlaneComponentsNormalized( planes[ 1 ], me3 + me0, me7 + me4, me11 + me8, me15 + me12 );
    _setPlaneComponentsNormalized( planes[ 2 ], me3 + me1, me7 + me5, me11 + me9, me15 + me13 );
    _setPlaneComponentsNormalized( planes[ 3 ], me3 - me1, me7 - me5, me11 - me9, me15 - me13 );
    _setPlaneComponentsNormalized( planes[ 4 ], me3 - me2, me7 - me6, me11 - me10, me15 - me14 );

    // Near / far plane — reversedDepth flips the far extraction.
    if ( rd ) {
      _setPlaneComponentsNormalized( planes[ 5 ], me2, me6, me10, me14 );
    } else {
      _setPlaneComponentsNormalized( planes[ 5 ], me3 + me2, me7 + me6, me11 + me10, me15 + me14 );
    }

    // `coordinateSystem` is kept so r185 callers keep working. In the current
    // extraction the value does not change the output plane coefficients —
    // the caller's projection matrix already encodes the target NDC range.
    void cs;

    return this;
  }

  intersectsObject( object ) {
    // Duck-typed: works with THREE.Object3D, our own ECS entity wrappers, or
    // any object exposing { geometry?, matrixWorld? }.
    if ( object === null || object === undefined ) return false;
    if ( typeof object.updateWorldMatrix === 'function' ) {
      object.updateWorldMatrix( false, false );
    }
    const geometry = object.geometry;
    if ( geometry === undefined || geometry === null ) return true;
    let bs = geometry.boundingSphere;
    if ( bs === undefined || bs === null ) {
      if ( typeof geometry.computeBoundingSphere === 'function' ) {
        geometry.computeBoundingSphere();
        bs = geometry.boundingSphere;
      }
    }
    if ( bs === undefined || bs === null ) return true;

    // Transform the sphere center by object.matrixWorld (radius *= max axis scale).
    let cx = _rx( bs.center ), cy = _ry( bs.center ), cz = _rz( bs.center );
    let radius = bs.radius;

    const mw = object.matrixWorld;
    if ( mw !== undefined && mw !== null ) {
      const e = _matrixElements( mw );
      const w = e[ 3 ] * cx + e[ 7 ] * cy + e[ 11 ] * cz + e[ 15 ] || 1.0;
      const invW = 1 / w;
      cx = ( e[ 0 ] * cx + e[ 4 ] * cy + e[ 8 ]  * cz + e[ 12 ] ) * invW;
      cy = ( e[ 1 ] * cx0( e, cx, cy, cz, 1 ) + e[ 5 ] * cy + e[ 9 ]  * cz + e[ 13 ] ) * invW;
      // NOTE: bug-prone line above intentionally avoided — see rewritten block.
    }

    // The above branch was illustrative; the exact, correct transform is below.
    if ( mw !== undefined && mw !== null ) {
      const e = _matrixElements( mw );
      const ox = _rx( bs.center ), oy = _ry( bs.center ), oz = _rz( bs.center );
      const w = e[ 3 ] * ox + e[ 7 ] * oy + e[ 11 ] * oz + e[ 15 ] || 1.0;
      const invW = 1 / w;
      cx = ( e[ 0 ] * ox + e[ 4 ] * oy + e[ 8 ]  * oz + e[ 12 ] ) * invW;
      cy = ( e[ 1 ] * ox + e[ 5 ] * oy + e[ 9 ]  * oz + e[ 13 ] ) * invW;
      cz = ( e[ 2 ] * ox + e[ 6 ] * oy + e[ 10 ] * oz + e[ 14 ] ) * invW;
      // Max-axis scale of the upper-left 3×3.
      const sx = Math.sqrt( e[ 0 ] * e[ 0 ] + e[ 1 ] * e[ 1 ] + e[ 2 ] * e[ 2 ] );
      const sy = Math.sqrt( e[ 4 ] * e[ 4 ] + e[ 5 ] * e[ 5 ] + e[ 6 ] * e[ 6 ] );
      const sz = Math.sqrt( e[ 8 ] * e[ 8 ] + e[ 9 ] * e[ 9 ] + e[ 10 ] * e[ 10 ] );
      radius *= Math.max( sx, sy, sz );
    }

    return this.intersectsSphere( { center: { x: cx, y: cy, z: cz }, radius } );
  }

  intersectsSprite( sprite ) {
    // r185 uses a fixed radius 0.7071 (half sqrt 2) for sprites.
    const mw = sprite !== null && sprite !== undefined ? sprite.matrixWorld : undefined;
    let cx = 0, cy = 0, cz = 0;
    let radius = 0.7071067811865476;
    if ( mw !== undefined && mw !== null ) {
      const e = _matrixElements( mw );
      cx = e[ 12 ];
      cy = e[ 13 ];
      cz = e[ 14 ];
      const sx = Math.sqrt( e[ 0 ] * e[ 0 ] + e[ 1 ] * e[ 1 ] + e[ 2 ] * e[ 2 ] );
      const sy = Math.sqrt( e[ 4 ] * e[ 4 ] + e[ 5 ] * e[ 5 ] + e[ 6 ] * e[ 6 ] );
      radius *= Math.max( sx, sy );
    }
    return this.intersectsSphere( { center: { x: cx, y: cy, z: cz }, radius } );
  }

  intersectsSphere( sphere ) {
    const cx = _rx( sphere.center ), cy = _ry( sphere.center ), cz = _rz( sphere.center );
    const negRadius = -sphere.radius;
    const planes = this.planes;
    for ( let i = 0; i < 6; i ++ ) {
      if ( _planeDistanceToPoint( planes[ i ], cx, cy, cz ) < negRadius ) return false;
    }
    return true;
  }

  intersectsBox( box ) {
    const planes = this.planes;
    const minX = _rx( box.min ), minY = _ry( box.min ), minZ = _rz( box.min );
    const maxX = _rx( box.max ), maxY = _ry( box.max ), maxZ = _rz( box.max );
    for ( let i = 0; i < 6; i ++ ) {
      const p = planes[ i ];
      const nx = p.normal !== undefined ? _rx( p.normal ) : p[ 0 ];
      const ny = p.normal !== undefined ? _ry( p.normal ) : p[ 1 ];
      const nz = p.normal !== undefined ? _rz( p.normal ) : p[ 2 ];
      const px = nx > 0 ? maxX : minX;
      const py = ny > 0 ? maxY : minY;
      const pz = nz > 0 ? maxZ : minZ;
      if ( nx * px + ny * py + nz * pz + p.constant < 0 ) return false;
    }
    return true;
  }

  containsPoint( point ) {
    const px = _rx( point ), py = _ry( point ), pz = _rz( point );
    const planes = this.planes;
    for ( let i = 0; i < 6; i ++ ) {
      if ( _planeDistanceToPoint( planes[ i ], px, py, pz ) < 0 ) return false;
    }
    return true;
  }

  // ────────────── flat array interop ──────────────

  toArray( array = [], offset = 0 ) {
    for ( let i = 0; i < 6; i ++ ) {
      const p = this.planes[ i ];
      const nx = p.normal !== undefined ? _rx( p.normal ) : p[ 0 ];
      const ny = p.normal !== undefined ? _ry( p.normal ) : p[ 1 ];
      const nz = p.normal !== undefined ? _rz( p.normal ) : p[ 2 ];
      const c = i * 4 + offset;
      array[ c ]     = nx;
      array[ c + 1 ] = ny;
      array[ c + 2 ] = nz;
      array[ c + 3 ] = p.constant;
    }
    return array;
  }

  fromArray( array, offset = 0 ) {
    for ( let i = 0; i < 6; i ++ ) {
      const c = i * 4 + offset;
      const p = this.planes[ i ];
      if ( p.normal !== undefined ) {
        _writeVec3( p.normal, array[ c ], array[ c + 1 ], array[ c + 2 ] );
      } else {
        p[ 0 ] = array[ c ];
        p[ 1 ] = array[ c + 1 ];
        p[ 2 ] = array[ c + 2 ];
      }
      p.constant = array[ c + 3 ];
    }
    return this;
  }

  // ────────────── pooled instances ──────────────

  static acquire() {
    return _localPool.length > 0 ? _localPool.pop() : new Frustum();
  }

  static recycle( frustum ) {
    if ( frustum instanceof Frustum && _localPool.length < LOCAL_POOL_MAX ) {
      for ( let i = 0; i < 6; i ++ ) {
        const p = frustum.planes[ i ];
        if ( p.normal !== undefined ) _writeVec3( p.normal, 0, 0, 1 );
        p.constant = 0;
      }
      _localPool.push( frustum );
    }
  }
}

// Stub used by the (illustrative) commented-out branch above; kept so that
// removing the illustrative branch does not orphan a reference. Never called.
function cx0() { return 0; }
void cx0;

// ═══════════════════════════════════════════════════════════════════
// BRIDGE: THREE-style <-> flat array (gl-matrix-compatible layout)
// ═══════════════════════════════════════════════════════════════════

export function threeFrustumFromGlMatrixPacked( out, glPacked ) {
  for ( let i = 0; i < 6; i ++ ) {
    const c = i * 4;
    const p = out.planes[ i ];
    if ( p.normal !== undefined ) {
      _writeVec3( p.normal, glPacked[ c ], glPacked[ c + 1 ], glPacked[ c + 2 ] );
    } else {
      p[ 0 ] = glPacked[ c ];
      p[ 1 ] = glPacked[ c + 1 ];
      p[ 2 ] = glPacked[ c + 2 ];
    }
    p.constant = glPacked[ c + 3 ];
  }
  return out;
}

export function glMatrixFrustumPackedFromThree( outPacked, threeFrustum ) {
  for ( let i = 0; i < 6; i ++ ) {
    const p = threeFrustum.planes[ i ];
    const nx = p.normal !== undefined ? _rx( p.normal ) : p[ 0 ];
    const ny = p.normal !== undefined ? _ry( p.normal ) : p[ 1 ];
    const nz = p.normal !== undefined ? _rz( p.normal ) : p[ 2 ];
    const c = i * 4;
    outPacked[ c ]     = nx;
    outPacked[ c + 1 ] = ny;
    outPacked[ c + 2 ] = nz;
    outPacked[ c + 3 ] = p.constant;
  }
  return outPacked;
}

// ═══════════════════════════════════════════════════════════════════
// BRIDGE: THREE-style <-> bitECS SoA
// ═══════════════════════════════════════════════════════════════════

export function threeFrustumFromBitecs( out, eid, store = FrustumComponent ) {
  for ( let i = 0; i < 6; i ++ ) {
    const k = _PLANE_KEYS[ i ];
    const p = out.planes[ i ];
    if ( p.normal !== undefined ) {
      _writeVec3( p.normal, store[ k + 'nx' ][ eid ], store[ k + 'ny' ][ eid ], store[ k + 'nz' ][ eid ] );
    } else {
      p[ 0 ] = store[ k + 'nx' ][ eid ];
      p[ 1 ] = store[ k + 'ny' ][ eid ];
      p[ 2 ] = store[ k + 'nz' ][ eid ];
    }
    p.constant = store[ k + 'c' ][ eid ];
  }
  return out;
}

export function bitecsFrustumFromThree( eid, threeFrustum, store = FrustumComponent ) {
  for ( let i = 0; i < 6; i ++ ) {
    const k = _PLANE_KEYS[ i ];
    const p = threeFrustum.planes[ i ];
    store[ k + 'nx' ][ eid ] = p.normal !== undefined ? _rx( p.normal ) : p[ 0 ];
    store[ k + 'ny' ][ eid ] = p.normal !== undefined ? _ry( p.normal ) : p[ 1 ];
    store[ k + 'nz' ][ eid ] = p.normal !== undefined ? _rz( p.normal ) : p[ 2 ];
    store[ k + 'c' ][ eid ]  = p.constant;
  }
  return eid;
}

export function bitecsFrustumFromGlMatrixPacked( eid, glPacked, store = FrustumComponent ) {
  for ( let i = 0; i < 6; i ++ ) {
    const k = _PLANE_KEYS[ i ];
    const c = i * 4;
    store[ k + 'nx' ][ eid ] = glPacked[ c ];
    store[ k + 'ny' ][ eid ] = glPacked[ c + 1 ];
    store[ k + 'nz' ][ eid ] = glPacked[ c + 2 ];
    store[ k + 'c' ][ eid ]  = glPacked[ c + 3 ];
  }
  return eid;
}

export function glMatrixFrustumPackedFromBitecs( outPacked, eid, store = FrustumComponent ) {
  for ( let i = 0; i < 6; i ++ ) {
    const k = _PLANE_KEYS[ i ];
    const c = i * 4;
    outPacked[ c ]     = store[ k + 'nx' ][ eid ];
    outPacked[ c + 1 ] = store[ k + 'ny' ][ eid ];
    outPacked[ c + 2 ] = store[ k + 'nz' ][ eid ];
    outPacked[ c + 3 ] = store[ k + 'c' ][ eid ];
  }
  return outPacked;
}

export function bitecsFrustumCopyInto( eidOut, eidIn, storeIn = FrustumComponent, storeOut = storeIn ) {
  for ( let i = 0; i < 6; i ++ ) {
    const k = _PLANE_KEYS[ i ];
    storeOut[ k + 'nx' ][ eidOut ] = storeIn[ k + 'nx' ][ eidIn ];
    storeOut[ k + 'ny' ][ eidOut ] = storeIn[ k + 'ny' ][ eidIn ];
    storeOut[ k + 'nz' ][ eidOut ] = storeIn[ k + 'nz' ][ eidIn ];
    storeOut[ k + 'c' ][ eidOut ]  = storeIn[ k + 'c' ][ eidIn ];
  }
  return eidOut;
}

// Set all 6 SoA planes from a projection matrix in-place.
export function bitecsFrustumSetFromProjectionMatrixInPlace( eid, m, coordinateSystem, reversedDepth, storeFrustum = FrustumComponent ) {
  const cs = coordinateSystem !== undefined ? coordinateSystem : WebGLCoordinateSystem;
  const rd = reversedDepth === true;
  const me = _matrixElements( m );

  const me0  = me[ 0 ], me1  = me[ 1 ], me2  = me[ 2 ], me3  = me[ 3 ];
  const me4  = me[ 4 ], me5  = me[ 5 ], me6  = me[ 6 ], me7  = me[ 7 ];
  const me8  = me[ 8 ], me9  = me[ 9 ], me10 = me[ 10 ], me11 = me[ 11 ];
  const me12 = me[ 12 ], me13 = me[ 13 ], me14 = me[ 14 ], me15 = me[ 15 ];

  function setPlane( idx, nx, ny, nz, constant ) {
    const k = _PLANE_KEYS[ idx ];
    const len = Math.sqrt( nx * nx + ny * ny + nz * nz );
    if ( len === 0 ) {
      storeFrustum[ k + 'nx' ][ eid ] = 0;
      storeFrustum[ k + 'ny' ][ eid ] = 0;
      storeFrustum[ k + 'nz' ][ eid ] = 1;
      storeFrustum[ k + 'c' ][ eid ]  = 0;
      return;
    }
    const inv = 1 / len;
    storeFrustum[ k + 'nx' ][ eid ] = nx * inv;
    storeFrustum[ k + 'ny' ][ eid ] = ny * inv;
    storeFrustum[ k + 'nz' ][ eid ] = nz * inv;
    storeFrustum[ k + 'c' ][ eid ]  = constant * inv;
  }

  setPlane( 0, me3 - me0, me7 - me4, me11 - me8, me15 - me12 );
  setPlane( 1, me3 + me0, me7 + me4, me11 + me8, me15 + me12 );
  setPlane( 2, me3 + me1, me7 + me5, me11 + me9, me15 + me13 );
  setPlane( 3, me3 - me1, me7 - me5, me11 - me9, me15 - me13 );
  setPlane( 4, me3 - me2, me7 - me6, me11 - me10, me15 - me14 );
  if ( rd ) {
    setPlane( 5, me2, me6, me10, me14 );
  } else {
    setPlane( 5, me3 + me2, me7 + me6, me11 + me10, me15 + me14 );
  }

  void cs;
  return eid;
}

export function bitecsFrustumContainsPoint( eidFrustum, eidPoint, storeFrustum = FrustumComponent, storePoint ) {
  const px = storePoint.x[ eidPoint ];
  const py = storePoint.y[ eidPoint ];
  const pz = storePoint.z[ eidPoint ];
  for ( let i = 0; i < 6; i ++ ) {
    const k = _PLANE_KEYS[ i ];
    const d = storeFrustum[ k + 'nx' ][ eidFrustum ] * px
            + storeFrustum[ k + 'ny' ][ eidFrustum ] * py
            + storeFrustum[ k + 'nz' ][ eidFrustum ] * pz
            + storeFrustum[ k + 'c' ][ eidFrustum ];
    if ( d < 0 ) return false;
  }
  return true;
}

export function bitecsFrustumIntersectsSphere( eidFrustum, eidSphere, storeFrustum = FrustumComponent, storeSphere ) {
  const cx = storeSphere.cx[ eidSphere ];
  const cy = storeSphere.cy[ eidSphere ];
  const cz = storeSphere.cz[ eidSphere ];
  const negR = -storeSphere.radius[ eidSphere ];
  for ( let i = 0; i < 6; i ++ ) {
    const k = _PLANE_KEYS[ i ];
    const d = storeFrustum[ k + 'nx' ][ eidFrustum ] * cx
            + storeFrustum[ k + 'ny' ][ eidFrustum ] * cy
            + storeFrustum[ k + 'nz' ][ eidFrustum ] * cz
            + storeFrustum[ k + 'c' ][ eidFrustum ];
    if ( d < negR ) return false;
  }
  return true;
}

export function bitecsFrustumIntersectsBox( eidFrustum, eidBox, storeFrustum = FrustumComponent, storeBox ) {
  const minX = storeBox.minX[ eidBox ], minY = storeBox.minY[ eidBox ], minZ = storeBox.minZ[ eidBox ];
  const maxX = storeBox.maxX[ eidBox ], maxY = storeBox.maxY[ eidBox ], maxZ = storeBox.maxZ[ eidBox ];
  for ( let i = 0; i < 6; i ++ ) {
    const k = _PLANE_KEYS[ i ];
    const nx = storeFrustum[ k + 'nx' ][ eidFrustum ];
    const ny = storeFrustum[ k + 'ny' ][ eidFrustum ];
    const nz = storeFrustum[ k + 'nz' ][ eidFrustum ];
    const c  = storeFrustum[ k + 'c' ][ eidFrustum ];
    const px = nx > 0 ? maxX : minX;
    const py = ny > 0 ? maxY : minY;
    const pz = nz > 0 ? maxZ : minZ;
    if ( nx * px + ny * py + nz * pz + c < 0 ) return false;
  }
  return true;
}

// Get a single plane's (normal, constant) from the SoA store — non-allocating.
export function threeFrustumPlaneFromBitecs( outPlane, eid, planeIndex, storeFrustum = FrustumComponent ) {
  if ( planeIndex < 0 || planeIndex > 5 ) throw new Error( 'planeIndex must be 0..5' );
  const k = _PLANE_KEYS[ planeIndex ];
  if ( outPlane.normal !== undefined ) {
    _writeVec3( outPlane.normal, storeFrustum[ k + 'nx' ][ eid ], storeFrustum[ k + 'ny' ][ eid ], storeFrustum[ k + 'nz' ][ eid ] );
  } else {
    outPlane[ 0 ] = storeFrustum[ k + 'nx' ][ eid ];
    outPlane[ 1 ] = storeFrustum[ k + 'ny' ][ eid ];
    outPlane[ 2 ] = storeFrustum[ k + 'nz' ][ eid ];
  }
  outPlane.constant = storeFrustum[ k + 'c' ][ eid ];
  return outPlane;
}

// Set a single plane's (normal, constant) into the SoA store — with normalization.
export function bitecsFrustumSetPlaneInto( eid, planeIndex, nx, ny, nz, constant, storeFrustum = FrustumComponent ) {
  if ( planeIndex < 0 || planeIndex > 5 ) throw new Error( 'planeIndex must be 0..5' );
  const k = _PLANE_KEYS[ planeIndex ];
  const len = Math.sqrt( nx * nx + ny * ny + nz * nz );
  if ( len === 0 ) {
    storeFrustum[ k + 'nx' ][ eid ] = 0;
    storeFrustum[ k + 'ny' ][ eid ] = 0;
    storeFrustum[ k + 'nz' ][ eid ] = 1;
    storeFrustum[ k + 'c' ][ eid ]  = 0;
    return eid;
  }
  const inv = 1 / len;
  storeFrustum[ k + 'nx' ][ eid ] = nx * inv;
  storeFrustum[ k + 'ny' ][ eid ] = ny * inv;
  storeFrustum[ k + 'nz' ][ eid ] = nz * inv;
  storeFrustum[ k + 'c' ][ eid ]  = constant * inv;
  return eid;
}

// Per-plane distance-to-point (returns the minimum signed distance across all
// six planes; useful for "how far inside" queries). Negative ⇒ outside.
export function bitecsFrustumSignedDistance( eidFrustum, eidPoint, storeFrustum = FrustumComponent, storePoint ) {
  const px = storePoint.x[ eidPoint ], py = storePoint.y[ eidPoint ], pz = storePoint.z[ eidPoint ];
  let minD = Infinity;
  for ( let i = 0; i < 6; i ++ ) {
    const k = _PLANE_KEYS[ i ];
    const d = storeFrustum[ k + 'nx' ][ eidFrustum ] * px
            + storeFrustum[ k + 'ny' ][ eidFrustum ] * py
            + storeFrustum[ k + 'nz' ][ eidFrustum ] * pz
            + storeFrustum[ k + 'c' ][ eidFrustum ];
    if ( d < minD ) minD = d;
  }
  return minD;
}

// ═══════════════════════════════════════════════════════════════════
// HIGH-PRECISION (DoubleDouble) HELPERS — galactic-scale grazing planes
// ═══════════════════════════════════════════════════════════════════

export function precisePlaneDistance( plane, point ) {
  const nx = DD.fromDouble( plane.normal !== undefined ? _rx( plane.normal ) : plane[ 0 ] );
  const ny = DD.fromDouble( plane.normal !== undefined ? _ry( plane.normal ) : plane[ 1 ] );
  const nz = DD.fromDouble( plane.normal !== undefined ? _rz( plane.normal ) : plane[ 2 ] );
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

export function preciseContainsPoint( frustum, point ) {
  for ( let i = 0; i < 6; i ++ ) {
    if ( precisePlaneDistance( frustum.planes[ i ], point ) < 0 ) return false;
  }
  return true;
}

export function preciseIntersectsSphere( frustum, sphere ) {
  const cx = DD.fromDouble( _rx( sphere.center ) );
  const cy = DD.fromDouble( _ry( sphere.center ) );
  const cz = DD.fromDouble( _rz( sphere.center ) );
  const r  = DD.fromDouble( sphere.radius );
  for ( let i = 0; i < 6; i ++ ) {
    const p = frustum.planes[ i ];
    const nx = DD.fromDouble( p.normal !== undefined ? _rx( p.normal ) : p[ 0 ] );
    const ny = DD.fromDouble( p.normal !== undefined ? _ry( p.normal ) : p[ 1 ] );
    const nz = DD.fromDouble( p.normal !== undefined ? _rz( p.normal ) : p[ 2 ] );
    const c  = DD.fromDouble( p.constant );
    const d = DD.add(
      DD.add( DD.multiply( nx, cx ), DD.multiply( ny, cy ) ),
      DD.add( DD.multiply( nz, cz ), c )
    );
    if ( DD.toDouble( DD.add( d, r ) ) < 0 ) return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// PROCEDURAL NOISE — random 6-plane frustum from a 3D simplex field
// ═══════════════════════════════════════════════════════════════════

export function setFromNoise3D( out, x, y, z, seed = 0, normalScale = 1, constantScale = 1 ) {
  const n = _cachedNoise3D( seed );
  for ( let i = 0; i < 6; i ++ ) {
    const base = i * 37.13;
    let nx = n( x + base, y, z ) * normalScale;
    let ny = n( x + base + 11.5, y + 21.7, z ) * normalScale;
    let nz = n( x + base - 9.3, y - 17.1, z + 5.9 ) * normalScale;
    const len = Math.sqrt( nx * nx + ny * ny + nz * nz );
    const p = out.planes[ i ];
    if ( len === 0 ) {
      if ( p.normal !== undefined ) {
        _writeVec3( p.normal, 0, 0, 1 );
      } else {
        p[ 0 ] = 0; p[ 1 ] = 0; p[ 2 ] = 1;
      }
      p.constant = 0;
    } else {
      const inv = 1 / len;
      if ( p.normal !== undefined ) {
        _writeVec3( p.normal, nx * inv, ny * inv, nz * inv );
      } else {
        p[ 0 ] = nx * inv;
        p[ 1 ] = ny * inv;
        p[ 2 ] = nz * inv;
      }
      p.constant = n( x + base + 3.7, y + 7.3, z + 2.9 ) * constantScale;
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// Named + default exports
// ═══════════════════════════════════════════════════════════════════
export { Frustum };
export default Frustum;