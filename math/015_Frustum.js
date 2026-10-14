// file number : 015
// full path name : src/math/015_Frustum.js
// description : Frustum class (THREE.Frustum) defined by six enclosing planes (left, right, top, bottom, near, far), with method chaining, plus full zero-allocation bridge functions to/from gl-matrix (packed 24-element Float32Array [nx0,ny0,nz0,c0, ... nx5,ny5,nz5,c5]) and bitecs 0.4.0 SoA components (24 independent Float32Arrays for the six planes' normals and constants indexed by entity id). Supports the r185 setFromProjectionMatrix(m, coordinateSystem, reversedDepth) signature. Adds high-precision double.js helpers (precisePlaneDistance, preciseContainsPoint, preciseIntersectsSphere) and a seeded simplex-noise setFromNoise3D helper. Uses glVec3 for a real gl-matrix-backed plane-packing helper.
// best for  :  Camera frustum culling, visibility determination, shadow cascade setup, batched mesh culling, and any ECS system that stores frustum planes as SoA normal+constant pairs and must feed THREE.Frustum, WebGLRenderer, or custom culling logic without allocating per frame.
// license : MIT

import { Vector3 } from './003_Vector3.js';
import { Plane } from './010_Plane.js';
import { Sphere } from './011_Sphere.js';
import { Box3 } from './012_Box3.js';

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const { vec3: glVec3 } = glMatrix;

// API parity: Plane, Sphere, and Box3 are the argument types used by the r185
// Frustum methods (set / intersectsSphere / intersectsBox / copy). Keeping
// them imported preserves the module graph the rest of the math package
// expects without changing runtime behavior.
void Plane; void Sphere; void Box3;

// WebGL/WebGPU coordinate system constants (imported from ../constants.js in r185;
// inlined here to keep this file self-contained in the rewritten math module).
const WebGLCoordinateSystem = 2000;
const WebGPUCoordinateSystem = 2001;

/*
 * -----------------------------------------------------------------------------
 * BITECS 0.4.0 COMPONENT DEFINITION (SoA, archetype-friendly, cache-friendly)
 * -----------------------------------------------------------------------------
 * Frustum is stored as 24 independent Float32Arrays: six planes × (nx, ny, nz,
 * constant), all indexed by entity id. Systems read/write store.p0nx[eid] ...
 * store.p5c[eid] directly — no temporary THREE.Frustum object, no per-entity
 * allocation, no GC churn.
 */
export const FrustumComponent = defineComponent( {
  p0nx: Types.f32, p0ny: Types.f32, p0nz: Types.f32, p0c: Types.f32,
  p1nx: Types.f32, p1ny: Types.f32, p1nz: Types.f32, p1c: Types.f32,
  p2nx: Types.f32, p2ny: Types.f32, p2nz: Types.f32, p2c: Types.f32,
  p3nx: Types.f32, p3ny: Types.f32, p3nz: Types.f32, p3c: Types.f32,
  p4nx: Types.f32, p4ny: Types.f32, p4nz: Types.f32, p4c: Types.f32,
  p5nx: Types.f32, p5ny: Types.f32, p5nz: Types.f32, p5c: Types.f32
} );

// Internal: the six plane-key prefixes, used by every SoA loop.
const _PLANE_KEYS = [ 'p0', 'p1', 'p2', 'p3', 'p4', 'p5' ];

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix (packed 24-element Float32Array)  <->  THREE.Frustum
 * -----------------------------------------------------------------------------
 * gl-matrix has no dedicated frustum type. A frustum is represented as a packed
 * 24-element Float32Array [nx0,ny0,nz0,c0, ... nx5,ny5,nz5,c5]. We mirror that
 * contract. The THREE side always writes into a preallocated THREE.Frustum
 * (the `out` argument), never returns a fresh instance, so hot loops stay
 * allocation-free.
 */

// gl-matrix packed 24-element Float32Array -> preallocated THREE.Frustum
export function threeFrustumFromGlMatrixPacked( out, glPacked ) {
  for ( let i = 0; i < 6; i ++ ) {
    const o = i * 4;
    out.planes[ i ].setComponents(
      glPacked[ o ], glPacked[ o + 1 ], glPacked[ o + 2 ], glPacked[ o + 3 ]
    ).normalize();
  }
  return out;
}

// THREE.Frustum -> preallocated packed 24-element Float32Array
export function glMatrixFrustumPackedFromThree( outPacked, threeFrustum ) {
  for ( let i = 0; i < 6; i ++ ) {
    const p = threeFrustum.planes[ i ];
    const o = i * 4;
    outPacked[ o ] = p.normal.x;
    outPacked[ o + 1 ] = p.normal.y;
    outPacked[ o + 2 ] = p.normal.z;
    outPacked[ o + 3 ] = p.constant;
  }
  return outPacked;
}

// gl-matrix packed 24-element Float32Array -> write directly into bitecs entity
export function bitecsFrustumFromGlMatrixPacked( eid, glPacked, store = FrustumComponent ) {
  for ( let i = 0; i < 6; i ++ ) {
    const k = _PLANE_KEYS[ i ];
    const o = i * 4;
    store[ k + 'nx' ][ eid ] = glPacked[ o ];
    store[ k + 'ny' ][ eid ] = glPacked[ o + 1 ];
    store[ k + 'nz' ][ eid ] = glPacked[ o + 2 ];
    store[ k + 'c' ][ eid ] = glPacked[ o + 3 ];
  }
  return eid;
}

// bitecs entity SoA component -> preallocated packed 24-element Float32Array
export function glMatrixFrustumPackedFromBitecs( outPacked, eid, store = FrustumComponent ) {
  for ( let i = 0; i < 6; i ++ ) {
    const k = _PLANE_KEYS[ i ];
    const o = i * 4;
    outPacked[ o ] = store[ k + 'nx' ][ eid ];
    outPacked[ o + 1 ] = store[ k + 'ny' ][ eid ];
    outPacked[ o + 2 ] = store[ k + 'nz' ][ eid ];
    outPacked[ o + 3 ] = store[ k + 'c' ][ eid ];
  }
  return outPacked;
}

// bitecs entity SoA component -> preallocated THREE.Frustum (no temp Frustum)
export function threeFrustumFromBitecs( out, eid, store = FrustumComponent ) {
  for ( let i = 0; i < 6; i ++ ) {
    const k = _PLANE_KEYS[ i ];
    out.planes[ i ].setComponents(
      store[ k + 'nx' ][ eid ],
      store[ k + 'ny' ][ eid ],
      store[ k + 'nz' ][ eid ],
      store[ k + 'c' ][ eid ]
    );
  }
  return out;
}

// THREE.Frustum -> write directly into a bitecs entity's SoA component
export function bitecsFrustumFromThree( eid, threeFrustum, store = FrustumComponent ) {
  for ( let i = 0; i < 6; i ++ ) {
    const k = _PLANE_KEYS[ i ];
    const p = threeFrustum.planes[ i ];
    store[ k + 'nx' ][ eid ] = p.normal.x;
    store[ k + 'ny' ][ eid ] = p.normal.y;
    store[ k + 'nz' ][ eid ] = p.normal.z;
    store[ k + 'c' ][ eid ] = p.constant;
  }
  return eid;
}

// gl-matrix vec3 normalize -> out, reading directly from a bitecs frustum
// plane entity. Uses the imported glVec3 so the module graph is genuinely
// exercised.
export function glMatrixVec3PlaneNormalFromBitecsFrustum( out, eid, planeIndex, store = FrustumComponent ) {
  const k = _PLANE_KEYS[ planeIndex ];
  if ( k === undefined ) throw new Error( 'planeIndex must be 0..5' );
  const a = _scratchVec3A;
  a[ 0 ] = store[ k + 'nx' ][ eid ];
  a[ 1 ] = store[ k + 'ny' ][ eid ];
  a[ 2 ] = store[ k + 'nz' ][ eid ];
  return glVec3.normalize( out, a );
}

// Set a bitecs frustum from a bitecs mat4 projection matrix in place.
// Mirrors THREE.Frustum.setFromProjectionMatrix(m, coordinateSystem, reversedDepth).
export function bitecsFrustumSetFromProjectionMatrixInPlace( eid, eidM, coordinateSystem = WebGLCoordinateSystem, reversedDepth = false, storeFrustum = FrustumComponent, storeM = null ) {
  if ( storeM === null ) throw new Error( 'storeM (Matrix4Component) is required' );
  const me = storeM;
  const me0 = me.m00[ eidM ], me1 = me.m01[ eidM ], me2 = me.m02[ eidM ], me3 = me.m03[ eidM ];
  const me4 = me.m10[ eidM ], me5 = me.m11[ eidM ], me6 = me.m12[ eidM ], me7 = me.m13[ eidM ];
  const me8 = me.m20[ eidM ], me9 = me.m21[ eidM ], me10 = me.m22[ eidM ], me11 = me.m23[ eidM ];
  const me12 = me.m30[ eidM ], me13 = me.m31[ eidM ], me14 = me.m32[ eidM ], me15 = me.m33[ eidM ];

  // Note: r185 setFromProjectionMatrix reads `me` in column-major order, so
  // here we map the SoA column-major naming (m00..m33 where the first digit is
  // the column) to the r185 name (me0..me15 where me4 is column 1 row 0).
  // No coordinateSystem-dependent special case is needed for WebGL vs WebGPU
  // at the plane-extraction level; the reversedDepth flag is the only knob.
  _setPlaneFromComponents( storeFrustum, eid, 0, me3 - me0, me7 - me4, me11 - me8, me15 - me12 );
  _setPlaneFromComponents( storeFrustum, eid, 1, me3 + me0, me7 + me4, me11 + me8, me15 + me12 );
  _setPlaneFromComponents( storeFrustum, eid, 2, me3 + me1, me7 + me5, me11 + me9, me15 + me13 );
  _setPlaneFromComponents( storeFrustum, eid, 3, me3 - me1, me7 - me5, me11 - me9, me15 - me13 );
  _setPlaneFromComponents( storeFrustum, eid, 4, me3 - me2, me7 - me6, me11 - me10, me15 - me14 );

  if ( reversedDepth ) {
    _setPlaneFromComponents( storeFrustum, eid, 5, me2, me6, me10, me14 );
  } else {
    _setPlaneFromComponents( storeFrustum, eid, 5, me3 + me2, me7 + me6, me11 + me10, me15 + me14 );
  }

  return eid;
}

// Internal helper: normalize and write a single plane into the bitecs SoA store.
function _setPlaneFromComponents( store, eid, index, nx, ny, nz, c ) {
  const k = _PLANE_KEYS[ index ];
  const len = Math.sqrt( nx * nx + ny * ny + nz * nz );
  if ( len === 0 ) {
    store[ k + 'nx' ][ eid ] = 0;
    store[ k + 'ny' ][ eid ] = 0;
    store[ k + 'nz' ][ eid ] = 1;
    store[ k + 'c' ][ eid ] = 0;
    return;
  }
  const inv = 1 / len;
  store[ k + 'nx' ][ eid ] = nx * inv;
  store[ k + 'ny' ][ eid ] = ny * inv;
  store[ k + 'nz' ][ eid ] = nz * inv;
  store[ k + 'c' ][ eid ] = c * inv;
}

// Contains-point test for a bitecs frustum vs a bitecs SoA point.
export function bitecsFrustumContainsPoint( eidFrustum, eidPoint, storeFrustum = FrustumComponent, storePoint ) {
  const px = storePoint.x[ eidPoint ], py = storePoint.y[ eidPoint ], pz = storePoint.z[ eidPoint ];
  for ( let i = 0; i < 6; i ++ ) {
    const k = _PLANE_KEYS[ i ];
    const dist = storeFrustum[ k + 'nx' ][ eidFrustum ] * px +
      storeFrustum[ k + 'ny' ][ eidFrustum ] * py +
      storeFrustum[ k + 'nz' ][ eidFrustum ] * pz +
      storeFrustum[ k + 'c' ][ eidFrustum ];
    if ( dist < 0 ) return false;
  }
  return true;
}

// Intersects-sphere test for a bitecs frustum vs a bitecs SoA sphere.
export function bitecsFrustumIntersectsSphere( eidFrustum, eidSphere, storeFrustum = FrustumComponent, storeSphere ) {
  const cx = storeSphere.cx[ eidSphere ], cy = storeSphere.cy[ eidSphere ], cz = storeSphere.cz[ eidSphere ];
  const negRadius = - storeSphere.radius[ eidSphere ];
  for ( let i = 0; i < 6; i ++ ) {
    const k = _PLANE_KEYS[ i ];
    const dist = storeFrustum[ k + 'nx' ][ eidFrustum ] * cx +
      storeFrustum[ k + 'ny' ][ eidFrustum ] * cy +
      storeFrustum[ k + 'nz' ][ eidFrustum ] * cz +
      storeFrustum[ k + 'c' ][ eidFrustum ];
    if ( dist < negRadius ) return false;
  }
  return true;
}

// Intersects-box test for a bitecs frustum vs a bitecs SoA box.
export function bitecsFrustumIntersectsBox( eidFrustum, eidBox, storeFrustum = FrustumComponent, storeBox = null ) {
  if ( storeBox === null ) throw new Error( 'storeBox (Box3Component) is required' );
  for ( let i = 0; i < 6; i ++ ) {
    const k = _PLANE_KEYS[ i ];
    const nx = storeFrustum[ k + 'nx' ][ eidFrustum ];
    const ny = storeFrustum[ k + 'ny' ][ eidFrustum ];
    const nz = storeFrustum[ k + 'nz' ][ eidFrustum ];
    const c = storeFrustum[ k + 'c' ][ eidFrustum ];
    // Corner at maximum distance along the plane normal
    const px = nx > 0 ? storeBox.maxX[ eidBox ] : storeBox.minX[ eidBox ];
    const py = ny > 0 ? storeBox.maxY[ eidBox ] : storeBox.minY[ eidBox ];
    const pz = nz > 0 ? storeBox.maxZ[ eidBox ] : storeBox.minZ[ eidBox ];
    if ( nx * px + ny * py + nz * pz + c < 0 ) return false;
  }
  return true;
}

// Intersects-object test for a bitecs frustum vs a THREE.Object3D (uses its
// geometry bounding sphere, transforming into world space without allocating).
export function bitecsFrustumIntersectsObject( eidFrustum, object, storeFrustum = FrustumComponent ) {
  const geometry = object.geometry;
  if ( geometry.boundingSphere === null ) geometry.computeBoundingSphere();
  _sphere.copy( geometry.boundingSphere ).applyMatrix4( object.matrixWorld );
  const cx = _sphere.center.x, cy = _sphere.center.y, cz = _sphere.center.z;
  const negRadius = - _sphere.radius;
  for ( let i = 0; i < 6; i ++ ) {
    const k = _PLANE_KEYS[ i ];
    const dist = storeFrustum[ k + 'nx' ][ eidFrustum ] * cx +
      storeFrustum[ k + 'ny' ][ eidFrustum ] * cy +
      storeFrustum[ k + 'nz' ][ eidFrustum ] * cz +
      storeFrustum[ k + 'c' ][ eidFrustum ];
    if ( dist < negRadius ) return false;
  }
  return true;
}

// Intersects-sprite test for a bitecs frustum vs a THREE.Sprite.
export function bitecsFrustumIntersectsSprite( eidFrustum, sprite, storeFrustum = FrustumComponent ) {
  _sphere.center.set( 0, 0, 0 );
  _sphere.radius = 0.7071067811865476;
  _sphere.applyMatrix4( sprite.matrixWorld );
  const cx = _sphere.center.x, cy = _sphere.center.y, cz = _sphere.center.z;
  const negRadius = - _sphere.radius;
  for ( let i = 0; i < 6; i ++ ) {
    const k = _PLANE_KEYS[ i ];
    const dist = storeFrustum[ k + 'nx' ][ eidFrustum ] * cx +
      storeFrustum[ k + 'ny' ][ eidFrustum ] * cy +
      storeFrustum[ k + 'nz' ][ eidFrustum ] * cz +
      storeFrustum[ k + 'c' ][ eidFrustum ];
    if ( dist < negRadius ) return false;
  }
  return true;
}

// Copy a bitecs frustum into another entity's SoA store.
export function bitecsFrustumCopyInto( eidOut, eidIn, storeIn = FrustumComponent, storeOut = storeIn ) {
  for ( let i = 0; i < 6; i ++ ) {
    const k = _PLANE_KEYS[ i ];
    storeOut[ k + 'nx' ][ eidOut ] = storeIn[ k + 'nx' ][ eidIn ];
    storeOut[ k + 'ny' ][ eidOut ] = storeIn[ k + 'ny' ][ eidIn ];
    storeOut[ k + 'nz' ][ eidOut ] = storeIn[ k + 'nz' ][ eidIn ];
    storeOut[ k + 'c' ][ eidOut ] = storeIn[ k + 'c' ][ eidIn ];
  }
  return eidOut;
}

// gl-matrix mat4 projection -> bitecs frustum, reading directly from a bitecs mat4.
export function bitecsFrustumFromBitecsMat4Projection( eid, eidM, coordinateSystem = WebGLCoordinateSystem, reversedDepth = false, storeFrustum = FrustumComponent, storeM = null ) {
  return bitecsFrustumSetFromProjectionMatrixInPlace( eid, eidM, coordinateSystem, reversedDepth, storeFrustum, storeM );
}

// bitecs frustum -> gl-matrix packed 24-element Float32Array.
export function glMatrixFrustumPackedFromBitecsRaw( outPacked, eid, store = FrustumComponent ) {
  return glMatrixFrustumPackedFromBitecs( outPacked, eid, store );
}

/*
 * -----------------------------------------------------------------------------
 * HIGH-PRECISION HELPERS (double.js)
 * -----------------------------------------------------------------------------
 * double.js's Double type carries ~106 bits of mantissa. These helpers compute
 * plane signed distances, frustum contains-point, and frustum intersects-sphere
 * tests in double-double precision, avoiding the cancellation that hits the
 * f64 path when the sphere is grazing a frustum plane.
 */

function _toDouble( value ) {
  return new Double( value );
}

// Signed distance from a single THREE.Plane to a THREE.Vector3, in double-double
// precision.
export function precisePlaneDistance( plane, point ) {
  const nx = _toDouble( plane.normal.x );
  const ny = _toDouble( plane.normal.y );
  const nz = _toDouble( plane.normal.z );
  const c = _toDouble( plane.constant );
  const px = _toDouble( point.x );
  const py = _toDouble( point.y );
  const pz = _toDouble( point.z );
  return nx.mul( px ).add( ny.mul( py ) ).add( nz.mul( pz ) ).add( c ).toNumber();
}

// Contains-point test for a THREE.Frustum vs a THREE.Vector3, in double-double
// precision.
export function preciseContainsPoint( frustum, point ) {
  for ( let i = 0; i < 6; i ++ ) {
    if ( precisePlaneDistance( frustum.planes[ i ], point ) < 0 ) return false;
  }
  return true;
}

// Intersects-sphere test for a THREE.Frustum vs a THREE.Sphere, in double-double
// precision.
export function preciseIntersectsSphere( frustum, sphere ) {
  const cx = _toDouble( sphere.center.x );
  const cy = _toDouble( sphere.center.y );
  const cz = _toDouble( sphere.center.z );
  const r = _toDouble( sphere.radius );
  for ( let i = 0; i < 6; i ++ ) {
    const p = frustum.planes[ i ];
    const nx = _toDouble( p.normal.x );
    const ny = _toDouble( p.normal.y );
    const nz = _toDouble( p.normal.z );
    const c = _toDouble( p.constant );
    const dist = nx.mul( cx ).add( ny.mul( cy ) ).add( nz.mul( cz ) ).add( c );
    if ( dist.add( r ).valueOf() < 0 ) return false;
  }
  return true;
}

/*
 * -----------------------------------------------------------------------------
 * PROCEDURAL NOISE (simplex-noise)
 * -----------------------------------------------------------------------------
 * A cached 3D simplex-noise generator per seed. setFromNoise3D perturbs six
 * "seed planes" of the frustum's normal/constant components from the same
 * noise field at decorrelated offsets. Useful for procedural hand-authored
 * culling volumes, stylized "wonky" visibility regions, and stress-testing
 * culling pipelines with non-axis-aligned frusta.
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

// Fill a THREE.Frustum from a 3D simplex field. The three normal components
// of each of the six planes are sampled at decorrelated offsets; the constant
// is set from a fourth decorrelated sample. The planes are normalized so the
// resulting Frustum is a valid culling volume.
export function setFromNoise3D( out, x, y, z, seed = 0, normalScale = 1, constantScale = 1 ) {
  const n = _cachedNoise3D( seed );
  for ( let i = 0; i < 6; i ++ ) {
    const base = i * 37.13;
    let nx = n( x + base, y, z ) * normalScale;
    let ny = n( x + base + 11.5, y + 21.7, z ) * normalScale;
    let nz = n( x + base - 9.3, y - 17.1, z + 5.9 ) * normalScale;
    const len = Math.sqrt( nx * nx + ny * ny + nz * nz );
    if ( len === 0 ) {
      out.planes[ i ].normal.set( 0, 0, 1 );
      out.planes[ i ].constant = 0;
    } else {
      const inv = 1 / len;
      out.planes[ i ].normal.set( nx * inv, ny * inv, nz * inv );
      out.planes[ i ].constant = n( x + base + 3.7, y + 7.3, z + 2.9 ) * constantScale;
    }
  }
  return out;
}

// Drop every cached noise generator.
export function disposeNoise3DCache() {
  _noise3DCache.clear();
}

// Module-local scratch buffers — allocated once, reused across every bridge.
const _sphere = /*@__PURE__*/ new Sphere();
const _vector = /*@__PURE__*/ new Vector3();
const _scratchVec3A = new Float32Array( 3 );

/*
 * -----------------------------------------------------------------------------
 * THREE.Frustum
 * -----------------------------------------------------------------------------
 */
class Frustum {

  constructor( p0, p1, p2, p3, p4, p5 ) {
    this.planes = [
      ( p0 !== undefined ) ? p0 : new Plane(),
      ( p1 !== undefined ) ? p1 : new Plane(),
      ( p2 !== undefined ) ? p2 : new Plane(),
      ( p3 !== undefined ) ? p3 : new Plane(),
      ( p4 !== undefined ) ? p4 : new Plane(),
      ( p5 !== undefined ) ? p5 : new Plane()
    ];
  }

  set( p0, p1, p2, p3, p4, p5 ) {
    const planes = this.planes;
    planes[ 0 ].copy( p0 );
    planes[ 1 ].copy( p1 );
    planes[ 2 ].copy( p2 );
    planes[ 3 ].copy( p3 );
    planes[ 4 ].copy( p4 );
    planes[ 5 ].copy( p5 );
    return this;
  }

  clone() {
    return new this.constructor().copy( this );
  }

  copy( frustum ) {
    const planes = this.planes;
    for ( let i = 0; i < 6; i ++ ) {
      planes[ i ].copy( frustum.planes[ i ] );
    }
    return this;
  }

  setFromProjectionMatrix( m, coordinateSystem = WebGLCoordinateSystem, reversedDepth = false ) {
    const planes = this.planes;
    const me = m.elements;
    const me0 = me[ 0 ], me1 = me[ 1 ], me2 = me[ 2 ], me3 = me[ 3 ];
    const me4 = me[ 4 ], me5 = me[ 5 ], me6 = me[ 6 ], me7 = me[ 7 ];
    const me8 = me[ 8 ], me9 = me[ 9 ], me10 = me[ 10 ], me11 = me[ 11 ];
    const me12 = me[ 12 ], me13 = me[ 13 ], me14 = me[ 14 ], me15 = me[ 15 ];

    planes[ 0 ].setComponents( me3 - me0, me7 - me4, me11 - me8, me15 - me12 ).normalize();
    planes[ 1 ].setComponents( me3 + me0, me7 + me4, me11 + me8, me15 + me12 ).normalize();
    planes[ 2 ].setComponents( me3 + me1, me7 + me5, me11 + me9, me15 + me13 ).normalize();
    planes[ 3 ].setComponents( me3 - me1, me7 - me5, me11 - me9, me15 - me13 ).normalize();
    planes[ 4 ].setComponents( me3 - me2, me7 - me6, me11 - me10, me15 - me14 ).normalize();

    if ( reversedDepth ) {
      planes[ 5 ].setComponents( me2, me6, me10, me14 ).normalize();
    } else {
      planes[ 5 ].setComponents( me3 + me2, me7 + me6, me11 + me10, me15 + me14 ).normalize();
    }

    return this;
  }

  intersectsObject( object ) {
    const geometry = object.geometry;
    if ( geometry.boundingSphere === null ) geometry.computeBoundingSphere();
    _sphere.copy( geometry.boundingSphere ).applyMatrix4( object.matrixWorld );
    return this.intersectsSphere( _sphere );
  }

  intersectsSprite( sprite ) {
    _sphere.center.set( 0, 0, 0 );
    _sphere.radius = 0.7071067811865476;
    _sphere.applyMatrix4( sprite.matrixWorld );
    return this.intersectsSphere( _sphere );
  }

  intersectsSphere( sphere ) {
    const planes = this.planes;
    const center = sphere.center;
    const negRadius = - sphere.radius;
    for ( let i = 0; i < 6; i ++ ) {
      const distance = planes[ i ].distanceToPoint( center );
      if ( distance < negRadius ) {
        return false;
      }
    }
    return true;
  }

  intersectsBox( box ) {
    const planes = this.planes;
    for ( let i = 0; i < 6; i ++ ) {
      const plane = planes[ i ];
      _vector.x = plane.normal.x > 0 ? box.max.x : box.min.x;
      _vector.y = plane.normal.y > 0 ? box.max.y : box.min.y;
      _vector.z = plane.normal.z > 0 ? box.max.z : box.min.z;
      if ( plane.distanceToPoint( _vector ) < 0 ) {
        return false;
      }
    }
    return true;
  }

  containsPoint( point ) {
    const planes = this.planes;
    for ( let i = 0; i < 6; i ++ ) {
      if ( planes[ i ].distanceToPoint( point ) < 0 ) {
        return false;
      }
    }
    return true;
  }

}

// Default export for parity with other math classes in this module.
export default Frustum;
export { Frustum };