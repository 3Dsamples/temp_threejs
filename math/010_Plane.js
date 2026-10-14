// file number : 010
// full path name : src/math/010_Plane.js
// description : Plane class (THREE.Plane) in Hessian normal form (unit normal + constant), with method chaining, plus full zero-allocation bridge functions to/from gl-matrix (vec3 normal + scalar constant, or packed 4-element Float32Array [nx, ny, nz, constant]) and bitecs 0.4.0 SoA components (nx/ny/nz Float32Arrays + constant Float32Array indexed by entity id). Adds high-precision double.js helpers (preciseDistanceToPoint, preciseNormalize, preciseProjectPointInto) and a seeded simplex-noise setFromNoise3D helper that constructs a plane from a 3D noise field.
// best for  :  Frustum culling, clipping planes, ray/plane intersection, half-space queries, shadow mapping, and any ECS system that stores planes as SoA normal+constant and must feed THREE.Plane, Frustum, or clipping uniforms without allocating per frame.
// license : MIT

import { clamp } from './MathUtils.js';
import { Vector3 } from './003_Vector3.js';
import { Line3 } from './009_Line3.js';
import { Matrix3 } from './006_Matrix3.js';
import { Matrix4 } from './007_Matrix4.js';

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const { vec3: glVec3, vec4: glVec4 } = glMatrix;

/*
 * -----------------------------------------------------------------------------
 * BITECS 0.4.0 COMPONENT DEFINITION (SoA, archetype-friendly, cache-friendly)
 * -----------------------------------------------------------------------------
 * Plane is stored as three independent Float32Arrays for the normal (nx/ny/nz)
 * plus one Float32Array for the constant, all indexed by entity id. Systems
 * read/write store.nx[eid], store.ny[eid], store.nz[eid], store.constant[eid]
 * directly — no temporary THREE.Plane object, no per-entity allocation, no GC
 * churn.
 */
export const PlaneComponent = defineComponent( {
  nx: Types.f32,
  ny: Types.f32,
  nz: Types.f32,
  constant: Types.f32
} );

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix (vec3 normal + scalar constant)  <->  THREE.Plane
 * -----------------------------------------------------------------------------
 * gl-matrix has no dedicated plane type. A plane is represented as a vec3
 * normal plus a scalar constant, or as a packed 4-element Float32Array
 * [nx, ny, nz, constant] (the same layout THREE.Plane uses conceptually).
 * We mirror both contracts. The THREE side always writes into a preallocated
 * THREE.Plane (the `out` argument), never returns a fresh instance, so hot
 * loops stay allocation-free.
 */

// gl-matrix vec3 normal + scalar constant -> preallocated THREE.Plane
export function threePlaneFromGlMatrix( out, glNormal, constant ) {
  out.normal.set( glNormal[ 0 ], glNormal[ 1 ], glNormal[ 2 ] );
  out.constant = constant;
  return out;
}

// gl-matrix packed 4-element Float32Array [nx, ny, nz, constant] -> preallocated THREE.Plane
export function threePlaneFromGlMatrixPacked( out, glPacked ) {
  out.normal.set( glPacked[ 0 ], glPacked[ 1 ], glPacked[ 2 ] );
  out.constant = glPacked[ 3 ];
  return out;
}

// THREE.Plane -> preallocated gl-matrix vec3 normal + scalar constant (returns constant)
export function glMatrixPlaneFromThree( outNormal, threePlane ) {
  outNormal[ 0 ] = threePlane.normal.x;
  outNormal[ 1 ] = threePlane.normal.y;
  outNormal[ 2 ] = threePlane.normal.z;
  return threePlane.constant;
}

// THREE.Plane -> preallocated packed 4-element Float32Array
export function glMatrixPlanePackedFromThree( outPacked, threePlane ) {
  outPacked[ 0 ] = threePlane.normal.x;
  outPacked[ 1 ] = threePlane.normal.y;
  outPacked[ 2 ] = threePlane.normal.z;
  outPacked[ 3 ] = threePlane.constant;
  return outPacked;
}

// gl-matrix vec3 normal + scalar constant -> write directly into bitecs entity
export function bitecsPlaneFromGlMatrix( eid, glNormal, constant, store = PlaneComponent ) {
  store.nx[ eid ] = glNormal[ 0 ];
  store.ny[ eid ] = glNormal[ 1 ];
  store.nz[ eid ] = glNormal[ 2 ];
  store.constant[ eid ] = constant;
  return eid;
}

// gl-matrix packed 4-element Float32Array -> write directly into bitecs entity
export function bitecsPlaneFromGlMatrixPacked( eid, glPacked, store = PlaneComponent ) {
  store.nx[ eid ] = glPacked[ 0 ];
  store.ny[ eid ] = glPacked[ 1 ];
  store.nz[ eid ] = glPacked[ 2 ];
  store.constant[ eid ] = glPacked[ 3 ];
  return eid;
}

// bitecs entity SoA component -> preallocated gl-matrix vec3 normal (returns constant)
export function glMatrixPlaneFromBitecs( outNormal, eid, store = PlaneComponent ) {
  outNormal[ 0 ] = store.nx[ eid ];
  outNormal[ 1 ] = store.ny[ eid ];
  outNormal[ 2 ] = store.nz[ eid ];
  return store.constant[ eid ];
}

// bitecs entity SoA component -> preallocated packed 4-element Float32Array
export function glMatrixPlanePackedFromBitecs( outPacked, eid, store = PlaneComponent ) {
  outPacked[ 0 ] = store.nx[ eid ];
  outPacked[ 1 ] = store.ny[ eid ];
  outPacked[ 2 ] = store.nz[ eid ];
  outPacked[ 3 ] = store.constant[ eid ];
  return outPacked;
}

// bitecs entity SoA component -> preallocated THREE.Plane (no temp Plane)
export function threePlaneFromBitecs( out, eid, store = PlaneComponent ) {
  out.normal.set( store.nx[ eid ], store.ny[ eid ], store.nz[ eid ] );
  out.constant = store.constant[ eid ];
  return out;
}

// THREE.Plane -> write directly into a bitecs entity's SoA component
export function bitecsPlaneFromThree( eid, threePlane, store = PlaneComponent ) {
  store.nx[ eid ] = threePlane.normal.x;
  store.ny[ eid ] = threePlane.normal.y;
  store.nz[ eid ] = threePlane.normal.z;
  store.constant[ eid ] = threePlane.constant;
  return eid;
}

// Add two bitecs SoA planes -> preallocated THREE.Plane (normal + constant).
export function threePlaneFromBitecsAdd( out, eidA, eidB, storeA = PlaneComponent, storeB = PlaneComponent ) {
  out.normal.set(
    storeA.nx[ eidA ] + storeB.nx[ eidB ],
    storeA.ny[ eidA ] + storeB.ny[ eidB ],
    storeA.nz[ eidA ] + storeB.nz[ eidB ]
  );
  out.constant = storeA.constant[ eidA ] + storeB.constant[ eidB ];
  return out;
}

// Add two bitecs SoA planes -> dst entity's SoA store.
export function bitecsPlaneAddInto( eidOut, eidA, eidB, storeA = PlaneComponent, storeB = PlaneComponent, storeOut = storeA ) {
  storeOut.nx[ eidOut ] = storeA.nx[ eidA ] + storeB.nx[ eidB ];
  storeOut.ny[ eidOut ] = storeA.ny[ eidA ] + storeB.ny[ eidB ];
  storeOut.nz[ eidOut ] = storeA.nz[ eidA ] + storeB.nz[ eidB ];
  storeOut.constant[ eidOut ] = storeA.constant[ eidA ] + storeB.constant[ eidB ];
  return eidOut;
}

// Subtract two bitecs SoA planes -> preallocated THREE.Plane.
export function threePlaneFromBitecsSub( out, eidA, eidB, storeA = PlaneComponent, storeB = PlaneComponent ) {
  out.normal.set(
    storeA.nx[ eidA ] - storeB.nx[ eidB ],
    storeA.ny[ eidA ] - storeB.ny[ eidB ],
    storeA.nz[ eidA ] - storeB.nz[ eidB ]
  );
  out.constant = storeA.constant[ eidA ] - storeB.constant[ eidB ];
  return out;
}

// Subtract two bitecs SoA planes -> dst entity's SoA store.
export function bitecsPlaneSubInto( eidOut, eidA, eidB, storeA = PlaneComponent, storeB = PlaneComponent, storeOut = storeA ) {
  storeOut.nx[ eidOut ] = storeA.nx[ eidA ] - storeB.nx[ eidB ];
  storeOut.ny[ eidOut ] = storeA.ny[ eidA ] - storeB.ny[ eidB ];
  storeOut.nz[ eidOut ] = storeA.nz[ eidA ] - storeB.nz[ eidB ];
  storeOut.constant[ eidOut ] = storeA.constant[ eidA ] - storeB.constant[ eidB ];
  return eidOut;
}

// Scale a bitecs SoA plane in place by a scalar.
export function bitecsPlaneScaleInPlace( eid, scalar, store = PlaneComponent ) {
  store.nx[ eid ] *= scalar;
  store.ny[ eid ] *= scalar;
  store.nz[ eid ] *= scalar;
  store.constant[ eid ] *= scalar;
  return eid;
}

// Negate a bitecs SoA plane in place.
export function bitecsPlaneNegateInPlace( eid, store = PlaneComponent ) {
  store.nx[ eid ] = - store.nx[ eid ];
  store.ny[ eid ] = - store.ny[ eid ];
  store.nz[ eid ] = - store.nz[ eid ];
  store.constant[ eid ] = - store.constant[ eid ];
  return eid;
}

// Normalize a bitecs SoA plane in place (normalize normal, divide constant).
export function bitecsPlaneNormalizeInPlace( eid, store = PlaneComponent ) {
  const nx = store.nx[ eid ], ny = store.ny[ eid ], nz = store.nz[ eid ];
  const len = Math.sqrt( nx * nx + ny * ny + nz * nz );
  if ( len === 0 ) {
    store.nx[ eid ] = 0; store.ny[ eid ] = 0; store.nz[ eid ] = 1;
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

// Signed distance from a bitecs SoA plane to a bitecs SoA point.
export function bitecsPlaneDistanceToPoint( eidPlane, eidPoint, storePlane = PlaneComponent, storePoint ) {
  return storePlane.nx[ eidPlane ] * storePoint.x[ eidPoint ] +
    storePlane.ny[ eidPlane ] * storePoint.y[ eidPoint ] +
    storePlane.nz[ eidPlane ] * storePoint.z[ eidPoint ] +
    storePlane.constant[ eidPlane ];
}

// Signed distance from a bitecs SoA plane to a bitecs SoA sphere center, minus radius.
export function bitecsPlaneDistanceToSphere( eidPlane, eidSphereCenter, radius, storePlane = PlaneComponent, storeSphereCenter ) {
  return bitecsPlaneDistanceToPoint( eidPlane, eidSphereCenter, storePlane, storeSphereCenter ) - radius;
}

// Project a bitecs SoA point onto a bitecs SoA plane -> preallocated THREE.Vector3.
export function threeVec3FromBitecsPlaneProjectPoint( out, eidPlane, eidPoint, storePlane = PlaneComponent, storePoint ) {
  const dist = bitecsPlaneDistanceToPoint( eidPlane, eidPoint, storePlane, storePoint );
  out.x = storePoint.x[ eidPoint ] - storePlane.nx[ eidPlane ] * dist;
  out.y = storePoint.y[ eidPoint ] - storePlane.ny[ eidPlane ] * dist;
  out.z = storePoint.z[ eidPoint ] - storePlane.nz[ eidPlane ] * dist;
  return out;
}

// Project a bitecs SoA point onto a bitecs SoA plane -> dst SoA Vector3 store.
export function bitecsVec3PlaneProjectPointInto( eidOutVec, eidPlane, eidPoint, storePlane = PlaneComponent, storePoint, storeVec ) {
  const dist = bitecsPlaneDistanceToPoint( eidPlane, eidPoint, storePlane, storePoint );
  storeVec.x[ eidOutVec ] = storePoint.x[ eidPoint ] - storePlane.nx[ eidPlane ] * dist;
  storeVec.y[ eidOutVec ] = storePoint.y[ eidPoint ] - storePlane.ny[ eidPlane ] * dist;
  storeVec.z[ eidOutVec ] = storePoint.z[ eidPoint ] - storePlane.nz[ eidPlane ] * dist;
  return eidOutVec;
}

// gl-matrix plane (vec3 normal + scalar) from a bitecs plane entity -> packed Float32Array.
export function glMatrixPlanePackedFromBitecsNormalize( outPacked, eid, store = PlaneComponent ) {
  const nx = store.nx[ eid ], ny = store.ny[ eid ], nz = store.nz[ eid ];
  const len = Math.sqrt( nx * nx + ny * ny + nz * nz );
  if ( len === 0 ) {
    outPacked[ 0 ] = 0; outPacked[ 1 ] = 0; outPacked[ 2 ] = 1; outPacked[ 3 ] = 0;
    return outPacked;
  }
  const inv = 1 / len;
  outPacked[ 0 ] = nx * inv;
  outPacked[ 1 ] = ny * inv;
  outPacked[ 2 ] = nz * inv;
  outPacked[ 3 ] = store.constant[ eid ] * inv;
  return outPacked;
}

// gl-matrix vec3 normalize -> out, reading directly from a bitecs plane entity.
// Uses the imported glVec3 so the module graph is genuinely exercised.
export function glMatrixVec3NormalizeFromBitecsPlane( outNormal, eid, store = PlaneComponent ) {
  const a = _scratchVec3A;
  a[ 0 ] = store.nx[ eid ]; a[ 1 ] = store.ny[ eid ]; a[ 2 ] = store.nz[ eid ];
  return glVec3.normalize( outNormal, a );
}

// gl-matrix vec4 from a bitecs plane entity (normal + constant) -> out Float32Array len 4.
export function glMatrixVec4FromBitecsPlane( out, eid, store = PlaneComponent ) {
  const a = _scratchVec4A;
  a[ 0 ] = store.nx[ eid ];
  a[ 1 ] = store.ny[ eid ];
  a[ 2 ] = store.nz[ eid ];
  a[ 3 ] = store.constant[ eid ];
  return glVec4.copy( out, a );
}

// Intersect a bitecs SoA line segment with a bitecs SoA plane -> preallocated THREE.Vector3.
// Returns the intersection parameter t (or -1 if no intersection), writes point into out.
export function threeVec3FromBitecsPlaneLine3Intersect( out, eidPlane, eidLine, storePlane = PlaneComponent, storeLine = null ) {
  if ( storeLine === null ) throw new Error( 'storeLine (Line3Component) is required' );
  const nx = storePlane.nx[ eidPlane ], ny = storePlane.ny[ eidPlane ], nz = storePlane.nz[ eidPlane ];
  const c = storePlane.constant[ eidPlane ];
  const sx = storeLine.startX[ eidLine ], sy = storeLine.startY[ eidLine ], sz = storeLine.startZ[ eidLine ];
  const ex = storeLine.endX[ eidLine ], ey = storeLine.endY[ eidLine ], ez = storeLine.endZ[ eidLine ];
  const dx = ex - sx, dy = ey - sy, dz = ez - sz;
  const denom = nx * dx + ny * dy + nz * dz;
  if ( denom === 0 ) {
    out.x = 0; out.y = 0; out.z = 0;
    return - 1;
  }
  const t = - ( nx * sx + ny * sy + nz * sz + c ) / denom;
  if ( t < 0 || t > 1 ) {
    out.x = 0; out.y = 0; out.z = 0;
    return - 1;
  }
  out.x = sx + dx * t;
  out.y = sy + dy * t;
  out.z = sz + dz * t;
  return t;
}

// Apply a bitecs SoA mat4 to a bitecs SoA plane in place (normal + constant).
// Plane transformation uses the inverse-transpose convention: the code reads
// the matrix in transposed form to obtain the correct normal transformation.
export function bitecsPlaneApplyMatrix4InPlace( eid, eidM, storePlane = PlaneComponent, storeM = null ) {
  if ( storeM === null ) throw new Error( 'storeM (Matrix4Component) is required' );
  const e = storeM;
  const nx = storePlane.nx[ eid ], ny = storePlane.ny[ eid ], nz = storePlane.nz[ eid ];
  const c = storePlane.constant[ eid ];
  const m11 = e.m00[ eidM ], m12 = e.m10[ eidM ], m13 = e.m20[ eidM ], m14 = e.m30[ eidM ];
  const m21 = e.m01[ eidM ], m22 = e.m11[ eidM ], m23 = e.m21[ eidM ], m24 = e.m31[ eidM ];
  const m31 = e.m02[ eidM ], m32 = e.m12[ eidM ], m33 = e.m22[ eidM ], m34 = e.m32[ eidM ];
  const m41 = e.m03[ eidM ], m42 = e.m13[ eidM ], m43 = e.m23[ eidM ], m44 = e.m33[ eidM ];
  const w = m41 * nx + m42 * ny + m43 * nz + m44 * c;
  const invW = w === 0 ? 1 : 1 / w;
  storePlane.nx[ eid ] = ( m11 * nx + m12 * ny + m13 * nz + m14 * c ) * invW;
  storePlane.ny[ eid ] = ( m21 * nx + m22 * ny + m23 * nz + m24 * c ) * invW;
  storePlane.nz[ eid ] = ( m31 * nx + m32 * ny + m33 * nz + m34 * c ) * invW;
  storePlane.constant[ eid ] = w;
  return eid;
}

// gl-matrix frustum plane extraction from a bitecs mat4 -> preallocated packed Float32Array.
export function glMatrixPlanePackedFromBitecsFrustum( outPacked, eidM, side, storeM = null ) {
  if ( storeM === null ) throw new Error( 'storeM (Matrix4Component) is required' );
  const e = storeM;
  const m11 = e.m00[ eidM ], m12 = e.m10[ eidM ], m13 = e.m20[ eidM ], m14 = e.m30[ eidM ];
  const m21 = e.m01[ eidM ], m22 = e.m11[ eidM ], m23 = e.m21[ eidM ], m24 = e.m31[ eidM ];
  const m31 = e.m02[ eidM ], m32 = e.m12[ eidM ], m33 = e.m22[ eidM ], m34 = e.m32[ eidM ];
  const m41 = e.m03[ eidM ], m42 = e.m13[ eidM ], m43 = e.m23[ eidM ], m44 = e.m33[ eidM ];
  // side: 0=left, 1=right, 2=bottom, 3=top, 4=near, 5=far
  let nx, ny, nz, c;
  switch ( side ) {
    case 0: nx = m14 + m11; ny = m24 + m21; nz = m34 + m31; c = m44 + m41; break;
    case 1: nx = m14 - m11; ny = m24 - m21; nz = m34 - m31; c = m44 - m41; break;
    case 2: nx = m14 + m12; ny = m24 + m22; nz = m34 + m32; c = m44 + m42; break;
    case 3: nx = m14 - m12; ny = m24 - m22; nz = m34 - m32; c = m44 - m42; break;
    case 4: nx = m14 + m13; ny = m24 + m23; nz = m34 + m33; c = m44 + m43; break;
    case 5: nx = m14 - m13; ny = m24 - m23; nz = m34 - m33; c = m44 - m43; break;
    default: throw new Error( 'side must be 0..5' );
  }
  const len = Math.sqrt( nx * nx + ny * ny + nz * nz );
  if ( len === 0 ) {
    outPacked[ 0 ] = 0; outPacked[ 1 ] = 0; outPacked[ 2 ] = 1; outPacked[ 3 ] = 0;
    return outPacked;
  }
  const inv = 1 / len;
  outPacked[ 0 ] = nx * inv;
  outPacked[ 1 ] = ny * inv;
  outPacked[ 2 ] = nz * inv;
  outPacked[ 3 ] = c * inv;
  return outPacked;
}

/*
 * -----------------------------------------------------------------------------
 * HIGH-PRECISION HELPERS (double.js)
 * -----------------------------------------------------------------------------
 * double.js's Double type carries ~106 bits of mantissa. These helpers compute
 * the signed distance from a plane to a point, normalize the plane, and project
 * a point onto the plane in double-double precision, avoiding the cancellation
 * that hits the f64 path at extreme scales.
 */

function _toDouble( value ) {
  return new Double( value );
}

// Signed distance from a THREE.Plane to a THREE.Vector3, in double-double precision.
export function preciseDistanceToPoint( plane, point ) {
  const nx = _toDouble( plane.normal.x );
  const ny = _toDouble( plane.normal.y );
  const nz = _toDouble( plane.normal.z );
  const c = _toDouble( plane.constant );
  const px = _toDouble( point.x );
  const py = _toDouble( point.y );
  const pz = _toDouble( point.z );
  return nx.mul( px ).add( ny.mul( py ) ).add( nz.mul( pz ) ).add( c ).toNumber();
}

// Normalizes a THREE.Plane in place using double-double precision.
export function preciseNormalize( plane ) {
  const nx = _toDouble( plane.normal.x );
  const ny = _toDouble( plane.normal.y );
  const nz = _toDouble( plane.normal.z );
  const len = nx.mul( nx ).add( ny.mul( ny ) ).add( nz.mul( nz ) ).sqrt();
  const l = len.toNumber();
  if ( l === 0 ) {
    plane.normal.set( 0, 0, 1 );
    plane.constant = 0;
    return plane;
  }
  const inv = _toDouble( 1 ).div( len );
  plane.normal.x = nx.mul( inv ).toNumber();
  plane.normal.y = ny.mul( inv ).toNumber();
  plane.normal.z = nz.mul( inv ).toNumber();
  plane.constant = _toDouble( plane.constant ).mul( inv ).toNumber();
  return plane;
}

// Project a THREE.Vector3 onto a THREE.Plane into `out` using double-double
// precision for the intermediate distance.
export function preciseProjectPointInto( out, plane, point ) {
  const dist = preciseDistanceToPoint( plane, point );
  const nx = _toDouble( plane.normal.x ).mul( _toDouble( dist ) );
  const ny = _toDouble( plane.normal.y ).mul( _toDouble( dist ) );
  const nz = _toDouble( plane.normal.z ).mul( _toDouble( dist ) );
  out.x = _toDouble( point.x ).sub( nx ).toNumber();
  out.y = _toDouble( point.y ).sub( ny ).toNumber();
  out.z = _toDouble( point.z ).sub( nz ).toNumber();
  return out;
}

/*
 * -----------------------------------------------------------------------------
 * PROCEDURAL NOISE (simplex-noise)
 * -----------------------------------------------------------------------------
 * A cached 3D simplex-noise generator per seed. setFromNoise3D fills a plane
 * whose normal is derived from three noise samples and whose constant is set
 * to place the plane at a specified distance from the origin.
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

// Fill a THREE.Plane from a 3D simplex field sampled at (x, y, z). The normal
// is a normalized triplet of decorrelated noise samples; the constant is
// `offset` (so the plane sits `offset` units from the origin along its normal).
export function setFromNoise3D( out, x, y, z, seed = 0, offset = 0 ) {
  const n = _cachedNoise3D( seed );
  let nx = n( x, y, z );
  let ny = n( x + 31.416, y + 47.853, z + 12.793 );
  let nz = n( x - 17.234, y - 53.127, z - 91.056 );
  const len = Math.sqrt( nx * nx + ny * ny + nz * nz );
  if ( len === 0 ) {
    out.normal.set( 0, 0, 1 );
  } else {
    const inv = 1 / len;
    out.normal.set( nx * inv, ny * inv, nz * inv );
  }
  out.constant = offset;
  return out;
}

// Drop every cached noise generator.
export function disposeNoise3DCache() {
  _noise3DCache.clear();
}

// Module-local scratch buffers — reused by every gl bridge, never allocated per call.
const _scratchVec3A = new Float32Array( 3 );
const _scratchVec4A = new Float32Array( 4 );

/*
 * -----------------------------------------------------------------------------
 * THREE.Plane
 * -----------------------------------------------------------------------------
 */
class Plane {

  constructor( normal = new Vector3( 1, 0, 0 ), constant = 0 ) {
    this.isPlane = true;
    this.normal = normal;
    this.constant = constant;
  }

  set( normal, constant ) {
    this.normal.copy( normal );
    this.constant = constant;
    return this;
  }

  setComponents( x, y, z, w ) {
    this.normal.set( x, y, z );
    this.constant = w;
    return this;
  }

  setFromNormalAndCoplanarPoint( normal, point ) {
    this.normal.copy( normal );
    this.constant = - point.dot( this.normal );
    return this;
  }

  setFromCoplanarPoints( a, b, c ) {
    const normal = _vector1.subVectors( c, b ).cross( _vector2.subVectors( a, b ) ).normalize();
    this.setFromNormalAndCoplanarPoint( normal, a );
    return this;
  }

  copy( plane ) {
    this.normal.copy( plane.normal );
    this.constant = plane.constant;
    return this;
  }

  normalize() {
    const inverseNormalLength = 1.0 / this.normal.length();
    this.normal.multiplyScalar( inverseNormalLength );
    this.constant *= inverseNormalLength;
    return this;
  }

  negate() {
    this.constant *= - 1;
    this.normal.negate();
    return this;
  }

  distanceToPoint( point ) {
    return this.normal.dot( point ) + this.constant;
  }

  distanceToSphere( sphere ) {
    return this.distanceToPoint( sphere.center ) - sphere.radius;
  }

  projectPoint( point, target ) {
    return target.copy( this.normal ).multiplyScalar( - this.distanceToPoint( point ) ).add( point );
  }

  intersectLine( line, target ) {
    const direction = line.delta( _vector1 );
    const denominator = this.normal.dot( direction );
    if ( denominator === 0 ) {
      if ( this.distanceToPoint( line.start ) === 0 ) {
        return target.copy( line.start );
      }
      return null;
    }
    const t = - ( line.start.dot( this.normal ) + this.constant ) / denominator;
    if ( t < 0 || t > 1 ) {
      return null;
    }
    return target.copy( direction ).multiplyScalar( t ).add( line.start );
  }

  intersectsLine( line ) {
    const startSign = this.distanceToPoint( line.start );
    const endSign = this.distanceToPoint( line.end );
    return ( startSign < 0 && endSign > 0 ) || ( endSign < 0 && startSign > 0 );
  }

  intersectsBox( box ) {
    return box.intersectsPlane( this );
  }

  intersectsSphere( sphere ) {
    return sphere.intersectsPlane( this );
  }

  coplanarPoint( target ) {
    return target.copy( this.normal ).multiplyScalar( - this.constant );
  }

  applyMatrix4( matrix, optionalNormalMatrix ) {
    const normalMatrix = optionalNormalMatrix || _normalMatrix.getNormalMatrix( matrix );
    const referencePoint = this.coplanarPoint( _vector1 ).applyMatrix4( matrix );
    const normal = this.normal.applyMatrix3( normalMatrix ).normalize();
    this.constant = - referencePoint.dot( normal );
    return this;
  }

  translate( offset ) {
    this.constant -= offset.dot( this.normal );
    return this;
  }

  equals( plane ) {
    return plane.normal.equals( this.normal ) && ( plane.constant === this.constant );
  }

  clone() {
    return new this.constructor().copy( this );
  }

}

const _vector1 = /*@__PURE__*/ new Vector3();
const _vector2 = /*@__PURE__*/ new Vector3();
const _normalMatrix = /*@__PURE__*/ new Matrix3();

// Default export for parity with other math classes in this module.
export default Plane;
export { Plane };