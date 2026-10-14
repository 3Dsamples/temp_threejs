// file number : 006
// full path name : src/math/006_Matrix3.js
// description : 3x3 matrix class (THREE.Matrix3) stored column-major, with method chaining, plus full zero-allocation bridge functions to/from gl-matrix mat3 (Float32Array of length 9) and bitecs 0.4.0 SoA components (nine separate Float32Arrays indexed by entity id). Uses warnOnce from the official three.js r185 utils.js. Adds high-precision double.js helpers (preciseDeterminant, preciseInvertInto) and a seeded simplex-noise setFromNoise2D helper.
// best for  :  Normal matrices (inverse transpose of upper-left 3x3 of a 4x4 transform), UV transforms, 2D affine transforms, and any ECS system that drives 3x3 matrices into THREE.Material uniforms or normalMatrix fields without allocating per frame.
// license : MIT

import { warnOnce } from 'https://raw.githubusercontent.com/mrdoob/three.js/r185/src/utils.js';

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const { mat3: glMat3 } = glMatrix;

/*
 * -----------------------------------------------------------------------------
 * BITECS 0.4.0 COMPONENT DEFINITION (SoA, archetype-friendly, cache-friendly)
 * -----------------------------------------------------------------------------
 * Matrix3 is stored as nine independent Float32Arrays indexed by entity id.
 * Column-major layout: [m00, m01, m02, m10, m11, m12, m20, m21, m22] where the
 * first index is the column and the second is the row. Systems read/write
 * store.m00[eid] ... store.m22[eid] directly — no temporary mat3 object, no
 * per-entity allocation, no GC churn.
 */
export const Matrix3Component = defineComponent( {
  m00: Types.f32, m01: Types.f32, m02: Types.f32,
  m10: Types.f32, m11: Types.f32, m12: Types.f32,
  m20: Types.f32, m21: Types.f32, m22: Types.f32
} );

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix mat3  <->  THREE.Matrix3
 * -----------------------------------------------------------------------------
 * gl-matrix writes into a Float32Array out param of length 9 in column-major
 * order [m00, m01, m02, m10, m11, m12, m20, m21, m22], which is identical to
 * THREE.Matrix3.elements. We mirror that contract exactly. The THREE side
 * always writes into a preallocated THREE.Matrix3 (the `out` argument), never
 * returns a fresh instance, so hot loops stay allocation-free.
 */

// gl-matrix mat3 (Float32Array len 9, column-major) -> preallocated THREE.Matrix3
export function threeMat3FromGlMatrix( out, glM ) {
  const e = out.elements;
  e[ 0 ] = glM[ 0 ]; e[ 1 ] = glM[ 1 ]; e[ 2 ] = glM[ 2 ];
  e[ 3 ] = glM[ 3 ]; e[ 4 ] = glM[ 4 ]; e[ 5 ] = glM[ 5 ];
  e[ 6 ] = glM[ 6 ]; e[ 7 ] = glM[ 7 ]; e[ 8 ] = glM[ 8 ];
  return out;
}

// THREE.Matrix3 -> preallocated gl-matrix mat3 (Float32Array len 9)
export function glMatrixMat3FromThree( out, threeM ) {
  const e = threeM.elements;
  out[ 0 ] = e[ 0 ]; out[ 1 ] = e[ 1 ]; out[ 2 ] = e[ 2 ];
  out[ 3 ] = e[ 3 ]; out[ 4 ] = e[ 4 ]; out[ 5 ] = e[ 5 ];
  out[ 6 ] = e[ 6 ]; out[ 7 ] = e[ 7 ]; out[ 8 ] = e[ 8 ];
  return out;
}

// gl-matrix mat3 -> write directly into a bitecs entity's SoA component
export function bitecsMat3FromGlMatrix( eid, glM, store = Matrix3Component ) {
  store.m00[ eid ] = glM[ 0 ]; store.m01[ eid ] = glM[ 1 ]; store.m02[ eid ] = glM[ 2 ];
  store.m10[ eid ] = glM[ 3 ]; store.m11[ eid ] = glM[ 4 ]; store.m12[ eid ] = glM[ 5 ];
  store.m20[ eid ] = glM[ 6 ]; store.m21[ eid ] = glM[ 7 ]; store.m22[ eid ] = glM[ 8 ];
  return eid;
}

// bitecs entity SoA component -> preallocated gl-matrix mat3 (Float32Array len 9)
export function glMatrixMat3FromBitecs( out, eid, store = Matrix3Component ) {
  out[ 0 ] = store.m00[ eid ]; out[ 1 ] = store.m01[ eid ]; out[ 2 ] = store.m02[ eid ];
  out[ 3 ] = store.m10[ eid ]; out[ 4 ] = store.m11[ eid ]; out[ 5 ] = store.m12[ eid ];
  out[ 6 ] = store.m20[ eid ]; out[ 7 ] = store.m21[ eid ]; out[ 8 ] = store.m22[ eid ];
  return out;
}

// bitecs entity SoA component -> preallocated THREE.Matrix3
export function threeMat3FromBitecs( out, eid, store = Matrix3Component ) {
  const e = out.elements;
  e[ 0 ] = store.m00[ eid ]; e[ 1 ] = store.m01[ eid ]; e[ 2 ] = store.m02[ eid ];
  e[ 3 ] = store.m10[ eid ]; e[ 4 ] = store.m11[ eid ]; e[ 5 ] = store.m12[ eid ];
  e[ 6 ] = store.m20[ eid ]; e[ 7 ] = store.m21[ eid ]; e[ 8 ] = store.m22[ eid ];
  return out;
}

// THREE.Matrix3 -> write directly into a bitecs entity's SoA component
export function bitecsMat3FromThree( eid, threeM, store = Matrix3Component ) {
  const e = threeM.elements;
  store.m00[ eid ] = e[ 0 ]; store.m01[ eid ] = e[ 1 ]; store.m02[ eid ] = e[ 2 ];
  store.m10[ eid ] = e[ 3 ]; store.m11[ eid ] = e[ 4 ]; store.m12[ eid ] = e[ 5 ];
  store.m20[ eid ] = e[ 6 ]; store.m21[ eid ] = e[ 7 ]; store.m22[ eid ] = e[ 8 ];
  return eid;
}

// Multiply two bitecs SoA matrices -> preallocated THREE.Matrix3.
export function threeMat3FromBitecsMultiply( out, eidA, eidB, storeA = Matrix3Component, storeB = Matrix3Component ) {
  const a00 = storeA.m00[ eidA ], a01 = storeA.m01[ eidA ], a02 = storeA.m02[ eidA ];
  const a10 = storeA.m10[ eidA ], a11 = storeA.m11[ eidA ], a12 = storeA.m12[ eidA ];
  const a20 = storeA.m20[ eidA ], a21 = storeA.m21[ eidA ], a22 = storeA.m22[ eidA ];
  const b00 = storeB.m00[ eidB ], b01 = storeB.m01[ eidB ], b02 = storeB.m02[ eidB ];
  const b10 = storeB.m10[ eidB ], b11 = storeB.m11[ eidB ], b12 = storeB.m12[ eidB ];
  const b20 = storeB.m20[ eidB ], b21 = storeB.m21[ eidB ], b22 = storeB.m22[ eidB ];
  const e = out.elements;
  e[ 0 ] = a00 * b00 + a10 * b01 + a20 * b02;
  e[ 1 ] = a01 * b00 + a11 * b01 + a21 * b02;
  e[ 2 ] = a02 * b00 + a12 * b01 + a22 * b02;
  e[ 3 ] = a00 * b10 + a10 * b11 + a20 * b12;
  e[ 4 ] = a01 * b10 + a11 * b11 + a21 * b12;
  e[ 5 ] = a02 * b10 + a12 * b11 + a22 * b12;
  e[ 6 ] = a00 * b20 + a10 * b21 + a20 * b22;
  e[ 7 ] = a01 * b20 + a11 * b21 + a21 * b22;
  e[ 8 ] = a02 * b20 + a12 * b21 + a22 * b22;
  return out;
}

// Multiply two bitecs SoA matrices -> dst entity's SoA store.
export function bitecsMat3MultiplyInto( eidOut, eidA, eidB, storeA = Matrix3Component, storeB = Matrix3Component, storeOut = storeA ) {
  const a00 = storeA.m00[ eidA ], a01 = storeA.m01[ eidA ], a02 = storeA.m02[ eidA ];
  const a10 = storeA.m10[ eidA ], a11 = storeA.m11[ eidA ], a12 = storeA.m12[ eidA ];
  const a20 = storeA.m20[ eidA ], a21 = storeA.m21[ eidA ], a22 = storeA.m22[ eidA ];
  const b00 = storeB.m00[ eidB ], b01 = storeB.m01[ eidB ], b02 = storeB.m02[ eidB ];
  const b10 = storeB.m10[ eidB ], b11 = storeB.m11[ eidB ], b12 = storeB.m12[ eidB ];
  const b20 = storeB.m20[ eidB ], b21 = storeB.m21[ eidB ], b22 = storeB.m22[ eidB ];
  storeOut.m00[ eidOut ] = a00 * b00 + a10 * b01 + a20 * b02;
  storeOut.m01[ eidOut ] = a01 * b00 + a11 * b01 + a21 * b02;
  storeOut.m02[ eidOut ] = a02 * b00 + a12 * b01 + a22 * b02;
  storeOut.m10[ eidOut ] = a00 * b10 + a10 * b11 + a20 * b12;
  storeOut.m11[ eidOut ] = a01 * b10 + a11 * b11 + a21 * b12;
  storeOut.m12[ eidOut ] = a02 * b10 + a12 * b11 + a22 * b12;
  storeOut.m20[ eidOut ] = a00 * b20 + a10 * b21 + a20 * b22;
  storeOut.m21[ eidOut ] = a01 * b20 + a11 * b21 + a21 * b22;
  storeOut.m22[ eidOut ] = a02 * b20 + a12 * b21 + a22 * b22;
  return eidOut;
}

// Add two bitecs SoA matrices -> preallocated THREE.Matrix3.
export function threeMat3FromBitecsAdd( out, eidA, eidB, storeA = Matrix3Component, storeB = Matrix3Component ) {
  const e = out.elements;
  e[ 0 ] = storeA.m00[ eidA ] + storeB.m00[ eidB ];
  e[ 1 ] = storeA.m01[ eidA ] + storeB.m01[ eidB ];
  e[ 2 ] = storeA.m02[ eidA ] + storeB.m02[ eidB ];
  e[ 3 ] = storeA.m10[ eidA ] + storeB.m10[ eidB ];
  e[ 4 ] = storeA.m11[ eidA ] + storeB.m11[ eidB ];
  e[ 5 ] = storeA.m12[ eidA ] + storeB.m12[ eidB ];
  e[ 6 ] = storeA.m20[ eidA ] + storeB.m20[ eidB ];
  e[ 7 ] = storeA.m21[ eidA ] + storeB.m21[ eidB ];
  e[ 8 ] = storeA.m22[ eidA ] + storeB.m22[ eidB ];
  return out;
}

// Add two bitecs SoA matrices -> dst entity's SoA store.
export function bitecsMat3AddInto( eidOut, eidA, eidB, storeA = Matrix3Component, storeB = Matrix3Component, storeOut = storeA ) {
  storeOut.m00[ eidOut ] = storeA.m00[ eidA ] + storeB.m00[ eidB ];
  storeOut.m01[ eidOut ] = storeA.m01[ eidA ] + storeB.m01[ eidB ];
  storeOut.m02[ eidOut ] = storeA.m02[ eidA ] + storeB.m02[ eidB ];
  storeOut.m10[ eidOut ] = storeA.m10[ eidA ] + storeB.m10[ eidB ];
  storeOut.m11[ eidOut ] = storeA.m11[ eidA ] + storeB.m11[ eidB ];
  storeOut.m12[ eidOut ] = storeA.m12[ eidA ] + storeB.m12[ eidB ];
  storeOut.m20[ eidOut ] = storeA.m20[ eidA ] + storeB.m20[ eidB ];
  storeOut.m21[ eidOut ] = storeA.m21[ eidA ] + storeB.m21[ eidB ];
  storeOut.m22[ eidOut ] = storeA.m22[ eidA ] + storeB.m22[ eidB ];
  return eidOut;
}

// Subtract two bitecs SoA matrices -> preallocated THREE.Matrix3.
export function threeMat3FromBitecsSub( out, eidA, eidB, storeA = Matrix3Component, storeB = Matrix3Component ) {
  const e = out.elements;
  e[ 0 ] = storeA.m00[ eidA ] - storeB.m00[ eidB ];
  e[ 1 ] = storeA.m01[ eidA ] - storeB.m01[ eidB ];
  e[ 2 ] = storeA.m02[ eidA ] - storeB.m02[ eidB ];
  e[ 3 ] = storeA.m10[ eidA ] - storeB.m10[ eidB ];
  e[ 4 ] = storeA.m11[ eidA ] - storeB.m11[ eidB ];
  e[ 5 ] = storeA.m12[ eidA ] - storeB.m12[ eidB ];
  e[ 6 ] = storeA.m20[ eidA ] - storeB.m20[ eidB ];
  e[ 7 ] = storeA.m21[ eidA ] - storeB.m21[ eidB ];
  e[ 8 ] = storeA.m22[ eidA ] - storeB.m22[ eidB ];
  return out;
}

// Subtract two bitecs SoA matrices -> dst entity's SoA store.
export function bitecsMat3SubInto( eidOut, eidA, eidB, storeA = Matrix3Component, storeB = Matrix3Component, storeOut = storeA ) {
  storeOut.m00[ eidOut ] = storeA.m00[ eidA ] - storeB.m00[ eidB ];
  storeOut.m01[ eidOut ] = storeA.m01[ eidA ] - storeB.m01[ eidB ];
  storeOut.m02[ eidOut ] = storeA.m02[ eidA ] - storeB.m02[ eidB ];
  storeOut.m10[ eidOut ] = storeA.m10[ eidA ] - storeB.m10[ eidB ];
  storeOut.m11[ eidOut ] = storeA.m11[ eidA ] - storeB.m11[ eidB ];
  storeOut.m12[ eidOut ] = storeA.m12[ eidA ] - storeB.m12[ eidB ];
  storeOut.m20[ eidOut ] = storeA.m20[ eidA ] - storeB.m20[ eidB ];
  storeOut.m21[ eidOut ] = storeA.m21[ eidA ] - storeB.m21[ eidB ];
  storeOut.m22[ eidOut ] = storeA.m22[ eidA ] - storeB.m22[ eidB ];
  return eidOut;
}

// Scale a bitecs SoA matrix in place by a scalar.
export function bitecsMat3ScaleInPlace( eid, scalar, store = Matrix3Component ) {
  store.m00[ eid ] *= scalar; store.m01[ eid ] *= scalar; store.m02[ eid ] *= scalar;
  store.m10[ eid ] *= scalar; store.m11[ eid ] *= scalar; store.m12[ eid ] *= scalar;
  store.m20[ eid ] *= scalar; store.m21[ eid ] *= scalar; store.m22[ eid ] *= scalar;
  return eid;
}

// Transpose a bitecs SoA matrix in place.
export function bitecsMat3TransposeInPlace( eid, store = Matrix3Component ) {
  let tmp;
  tmp = store.m01[ eid ]; store.m01[ eid ] = store.m10[ eid ]; store.m10[ eid ] = tmp;
  tmp = store.m02[ eid ]; store.m02[ eid ] = store.m20[ eid ]; store.m20[ eid ] = tmp;
  tmp = store.m12[ eid ]; store.m12[ eid ] = store.m21[ eid ]; store.m21[ eid ] = tmp;
  return eid;
}

// Invert a bitecs SoA matrix in place (degenerate -> zero matrix).
export function bitecsMat3InvertInPlace( eid, store = Matrix3Component ) {
  const n11 = store.m00[ eid ], n21 = store.m01[ eid ], n31 = store.m02[ eid ];
  const n12 = store.m10[ eid ], n22 = store.m11[ eid ], n32 = store.m12[ eid ];
  const n13 = store.m20[ eid ], n23 = store.m21[ eid ], n33 = store.m22[ eid ];
  const t11 = n33 * n22 - n32 * n23;
  const t12 = n32 * n13 - n33 * n12;
  const t13 = n23 * n12 - n22 * n13;
  const det = n11 * t11 + n21 * t12 + n31 * t13;
  if ( det === 0 ) {
    store.m00[ eid ] = 0; store.m01[ eid ] = 0; store.m02[ eid ] = 0;
    store.m10[ eid ] = 0; store.m11[ eid ] = 0; store.m12[ eid ] = 0;
    store.m20[ eid ] = 0; store.m21[ eid ] = 0; store.m22[ eid ] = 0;
    return eid;
  }
  const detInv = 1 / det;
  store.m00[ eid ] = t11 * detInv;
  store.m01[ eid ] = ( n31 * n23 - n33 * n21 ) * detInv;
  store.m02[ eid ] = ( n32 * n21 - n31 * n22 ) * detInv;
  store.m10[ eid ] = t12 * detInv;
  store.m11[ eid ] = ( n33 * n11 - n31 * n13 ) * detInv;
  store.m12[ eid ] = ( n31 * n12 - n32 * n11 ) * detInv;
  store.m20[ eid ] = t13 * detInv;
  store.m21[ eid ] = ( n21 * n13 - n23 * n11 ) * detInv;
  store.m22[ eid ] = ( n22 * n11 - n21 * n12 ) * detInv;
  return eid;
}

// Determinant of a bitecs SoA matrix.
export function bitecsMat3Determinant( eid, store = Matrix3Component ) {
  const a = store.m00[ eid ], b = store.m01[ eid ], c = store.m02[ eid ];
  const d = store.m10[ eid ], e = store.m11[ eid ], f = store.m12[ eid ];
  const g = store.m20[ eid ], h = store.m21[ eid ], i = store.m22[ eid ];
  return a * e * i - a * f * h - b * d * i + b * f * g + c * d * h - c * e * g;
}

// gl-matrix mat3 multiply -> out, reading directly from two bitecs entities.
// Uses module-scoped scratch buffers so no two-array allocation happens per call.
export function glMatrixMat3MultiplyFromBitecs( out, eidA, eidB, storeA = Matrix3Component, storeB = Matrix3Component ) {
  const a = _scratchMat3A;
  const b = _scratchMat3B;
  a[ 0 ] = storeA.m00[ eidA ]; a[ 1 ] = storeA.m01[ eidA ]; a[ 2 ] = storeA.m02[ eidA ];
  a[ 3 ] = storeA.m10[ eidA ]; a[ 4 ] = storeA.m11[ eidA ]; a[ 5 ] = storeA.m12[ eidA ];
  a[ 6 ] = storeA.m20[ eidA ]; a[ 7 ] = storeA.m21[ eidA ]; a[ 8 ] = storeA.m22[ eidA ];
  b[ 0 ] = storeB.m00[ eidB ]; b[ 1 ] = storeB.m01[ eidB ]; b[ 2 ] = storeB.m02[ eidB ];
  b[ 3 ] = storeB.m10[ eidB ]; b[ 4 ] = storeB.m11[ eidB ]; b[ 5 ] = storeB.m12[ eidB ];
  b[ 6 ] = storeB.m20[ eidB ]; b[ 7 ] = storeB.m21[ eidB ]; b[ 8 ] = storeB.m22[ eidB ];
  return glMat3.multiply( out, a, b );
}

// gl-matrix mat3 invert -> out, reading directly from a bitecs entity.
export function glMatrixMat3InvertFromBitecs( out, eid, store = Matrix3Component ) {
  const a = _scratchMat3A;
  a[ 0 ] = store.m00[ eid ]; a[ 1 ] = store.m01[ eid ]; a[ 2 ] = store.m02[ eid ];
  a[ 3 ] = store.m10[ eid ]; a[ 4 ] = store.m11[ eid ]; a[ 5 ] = store.m12[ eid ];
  a[ 6 ] = store.m20[ eid ]; a[ 7 ] = store.m21[ eid ]; a[ 8 ] = store.m22[ eid ];
  return glMat3.invert( out, a );
}

// gl-matrix mat3 transpose -> out, reading directly from a bitecs entity.
export function glMatrixMat3TransposeFromBitecs( out, eid, store = Matrix3Component ) {
  const a = _scratchMat3A;
  a[ 0 ] = store.m00[ eid ]; a[ 1 ] = store.m01[ eid ]; a[ 2 ] = store.m02[ eid ];
  a[ 3 ] = store.m10[ eid ]; a[ 4 ] = store.m11[ eid ]; a[ 5 ] = store.m12[ eid ];
  a[ 6 ] = store.m20[ eid ]; a[ 7 ] = store.m21[ eid ]; a[ 8 ] = store.m22[ eid ];
  return glMat3.transpose( out, a );
}

// gl-matrix mat3 adjoint -> out, reading directly from a bitecs entity.
export function glMatrixMat3AdjointFromBitecs( out, eid, store = Matrix3Component ) {
  const a = _scratchMat3A;
  a[ 0 ] = store.m00[ eid ]; a[ 1 ] = store.m01[ eid ]; a[ 2 ] = store.m02[ eid ];
  a[ 3 ] = store.m10[ eid ]; a[ 4 ] = store.m11[ eid ]; a[ 5 ] = store.m12[ eid ];
  a[ 6 ] = store.m20[ eid ]; a[ 7 ] = store.m21[ eid ]; a[ 8 ] = store.m22[ eid ];
  return glMat3.adjoint( out, a );
}

// gl-matrix mat3 determinant -> scalar, reading directly from a bitecs entity.
export function glMatrixMat3DeterminantFromBitecs( eid, store = Matrix3Component ) {
  const a = _scratchMat3A;
  a[ 0 ] = store.m00[ eid ]; a[ 1 ] = store.m01[ eid ]; a[ 2 ] = store.m02[ eid ];
  a[ 3 ] = store.m10[ eid ]; a[ 4 ] = store.m11[ eid ]; a[ 5 ] = store.m12[ eid ];
  a[ 6 ] = store.m20[ eid ]; a[ 7 ] = store.m21[ eid ]; a[ 8 ] = store.m22[ eid ];
  return glMat3.determinant( a );
}

// gl-matrix mat3 fromQuat -> out, reading directly from a bitecs quaternion entity.
export function glMatrixMat3FromBitecsQuat( out, eid, storeQ ) {
  const q = _scratchQuat;
  q[ 0 ] = storeQ.x[ eid ];
  q[ 1 ] = storeQ.y[ eid ];
  q[ 2 ] = storeQ.z[ eid ];
  q[ 3 ] = storeQ.w[ eid ];
  return glMat3.fromQuat( out, q );
}

// gl-matrix mat3 normalFromMat4 -> out, reading directly from a bitecs mat4 entity.
export function glMatrixMat3NormalFromBitecsMat4( out, eid, storeM ) {
  const a = _scratchMat4;
  a[ 0 ] = storeM.m00[ eid ]; a[ 1 ] = storeM.m01[ eid ]; a[ 2 ] = storeM.m02[ eid ]; a[ 3 ] = storeM.m03[ eid ];
  a[ 4 ] = storeM.m10[ eid ]; a[ 5 ] = storeM.m11[ eid ]; a[ 6 ] = storeM.m12[ eid ]; a[ 7 ] = storeM.m13[ eid ];
  a[ 8 ] = storeM.m20[ eid ]; a[ 9 ] = storeM.m21[ eid ]; a[ 10 ] = storeM.m22[ eid ]; a[ 11 ] = storeM.m23[ eid ];
  a[ 12 ] = storeM.m30[ eid ]; a[ 13 ] = storeM.m31[ eid ]; a[ 14 ] = storeM.m32[ eid ]; a[ 15 ] = storeM.m33[ eid ];
  return glMat3.normalFromMat4( out, a );
}

/*
 * -----------------------------------------------------------------------------
 * HIGH-PRECISION HELPERS (double.js)
 * -----------------------------------------------------------------------------
 * double.js's Double type carries ~106 bits of mantissa. These helpers compute
 * the determinant and invert a 3x3 matrix in double-double precision, avoiding
 * the loss that hits the f64 path when the matrix is ill-conditioned.
 */

function _toDouble( value ) {
  return new Double( value );
}

// Returns det(m) evaluated in double-double precision.
export function preciseDeterminant( m ) {
  const e = m.elements;
  const a = _toDouble( e[ 0 ] ), b = _toDouble( e[ 3 ] ), c = _toDouble( e[ 6 ] );
  const d = _toDouble( e[ 1 ] ), f = _toDouble( e[ 4 ] ), g = _toDouble( e[ 7 ] );
  const h = _toDouble( e[ 2 ] ), i = _toDouble( e[ 5 ] ), j = _toDouble( e[ 8 ] );
  // | a b c |
  // | d f g |
  // | h i j |
  const t1 = a.mul( f ).mul( j );
  const t2 = a.mul( g ).mul( i );
  const t3 = b.mul( d ).mul( j );
  const t4 = b.mul( g ).mul( h );
  const t5 = c.mul( d ).mul( i );
  const t6 = c.mul( f ).mul( h );
  return t1.sub( t2 ).sub( t3 ).add( t4 ).add( t5 ).sub( t6 ).toNumber();
}

// Inverts m into out using double-double precision. Matches THREE.Matrix3.invert
// r185 semantics: a degenerate matrix produces a zero matrix.
export function preciseInvertInto( out, m ) {
  const e = m.elements;
  const n11 = _toDouble( e[ 0 ] ), n21 = _toDouble( e[ 1 ] ), n31 = _toDouble( e[ 2 ] );
  const n12 = _toDouble( e[ 3 ] ), n22 = _toDouble( e[ 4 ] ), n32 = _toDouble( e[ 5 ] );
  const n13 = _toDouble( e[ 6 ] ), n23 = _toDouble( e[ 7 ] ), n33 = _toDouble( e[ 8 ] );

  const t11 = n33.mul( n22 ).sub( n32.mul( n23 ) );
  const t12 = n32.mul( n13 ).sub( n33.mul( n12 ) );
  const t13 = n23.mul( n12 ).sub( n22.mul( n13 ) );
  const det = n11.mul( t11 ).add( n21.mul( t12 ) ).add( n31.mul( t13 ) );

  const te = out.elements;
  if ( det.valueOf() === 0 ) {
    te[ 0 ] = 0; te[ 1 ] = 0; te[ 2 ] = 0;
    te[ 3 ] = 0; te[ 4 ] = 0; te[ 5 ] = 0;
    te[ 6 ] = 0; te[ 7 ] = 0; te[ 8 ] = 0;
    return out;
  }
  const invDet = _toDouble( 1 ).div( det );

  te[ 0 ] = t11.mul( invDet ).toNumber();
  te[ 1 ] = n31.mul( n23 ).sub( n33.mul( n21 ) ).mul( invDet ).toNumber();
  te[ 2 ] = n32.mul( n21 ).sub( n31.mul( n22 ) ).mul( invDet ).toNumber();
  te[ 3 ] = t12.mul( invDet ).toNumber();
  te[ 4 ] = n33.mul( n11 ).sub( n31.mul( n13 ) ).mul( invDet ).toNumber();
  te[ 5 ] = n31.mul( n12 ).sub( n32.mul( n11 ) ).mul( invDet ).toNumber();
  te[ 6 ] = t13.mul( invDet ).toNumber();
  te[ 7 ] = n21.mul( n13 ).sub( n23.mul( n11 ) ).mul( invDet ).toNumber();
  te[ 8 ] = n22.mul( n11 ).sub( n21.mul( n12 ) ).mul( invDet ).toNumber();
  return out;
}

/*
 * -----------------------------------------------------------------------------
 * PROCEDURAL NOISE (simplex-noise)
 * -----------------------------------------------------------------------------
 * A cached 2D simplex-noise generator per seed. setFromNoise2D builds a 2D
 * rotation-about-Z matrix embedded in 3x3 (i.e. the same shape produced by
 * makeRotation) whose angle is derived from a single noise sample, with an
 * optional uniform scale applied to the rotating 2x2 block.
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

const _noise2DCache = new Map();

function _cachedNoise2D( seed ) {
  let gen = _noise2DCache.get( seed );
  if ( gen === undefined ) {
    gen = createNoise2D( _mulberry32( seed ) );
    _noise2DCache.set( seed, gen );
  }
  return gen;
}

// Set out to a rotation-about-Z matrix whose angle is sampled from a 2D simplex
// field at (x, y). The optional `scale` parameter multiplies the top-left 2x2
// block. The bottom-right 1x1 stays 1.
export function setFromNoise2D( out, x, y, seed = 0, scale = 1 ) {
  const n = _cachedNoise2D( seed );
  const angle = ( n( x, y ) + 1 ) * Math.PI;
  const c = Math.cos( angle ) * scale;
  const s = Math.sin( angle ) * scale;
  const e = out.elements;
  e[ 0 ] = c; e[ 1 ] = s; e[ 2 ] = 0;
  e[ 3 ] = - s; e[ 4 ] = c; e[ 5 ] = 0;
  e[ 6 ] = 0; e[ 7 ] = 0; e[ 8 ] = 1;
  return out;
}

// Drop every cached noise generator.
export function disposeNoise2DCache() {
  _noise2DCache.clear();
}

// Module-local scratch buffers — allocated once, reused across every bridge.
const _scratchMat3A = new Float32Array( 9 );
const _scratchMat3B = new Float32Array( 9 );
const _scratchQuat = new Float32Array( 4 );
const _scratchMat4 = new Float32Array( 16 );

/*
 * -----------------------------------------------------------------------------
 * THREE.Matrix3
 * -----------------------------------------------------------------------------
 */
class Matrix3 {

  constructor( n11, n12, n13, n21, n22, n23, n31, n32, n33 ) {
    Matrix3.prototype.isMatrix3 = true;
    this.elements = [ 1, 0, 0, 0, 1, 0, 0, 0, 1 ];
    if ( n11 !== undefined ) {
      this.set( n11, n12, n13, n21, n22, n23, n31, n32, n33 );
    }
  }

  set( n11, n12, n13, n21, n22, n23, n31, n32, n33 ) {
    const te = this.elements;
    te[ 0 ] = n11; te[ 1 ] = n21; te[ 2 ] = n31;
    te[ 3 ] = n12; te[ 4 ] = n22; te[ 5 ] = n32;
    te[ 6 ] = n13; te[ 7 ] = n23; te[ 8 ] = n33;
    return this;
  }

  identity() {
    this.set( 1, 0, 0, 0, 1, 0, 0, 0, 1 );
    return this;
  }

  copy( m ) {
    const te = this.elements;
    const me = m.elements;
    te[ 0 ] = me[ 0 ]; te[ 1 ] = me[ 1 ]; te[ 2 ] = me[ 2 ];
    te[ 3 ] = me[ 3 ]; te[ 4 ] = me[ 4 ]; te[ 5 ] = me[ 5 ];
    te[ 6 ] = me[ 6 ]; te[ 7 ] = me[ 7 ]; te[ 8 ] = me[ 8 ];
    return this;
  }

  extractBasis( xAxis, yAxis, zAxis ) {
    xAxis.setFromMatrix3Column( this, 0 );
    yAxis.setFromMatrix3Column( this, 1 );
    zAxis.setFromMatrix3Column( this, 2 );
    return this;
  }

  setFromMatrix4( m ) {
    const me = m.elements;
    this.set(
      me[ 0 ], me[ 4 ], me[ 8 ],
      me[ 1 ], me[ 5 ], me[ 9 ],
      me[ 2 ], me[ 6 ], me[ 10 ]
    );
    return this;
  }

  multiply( m ) {
    return this.multiplyMatrices( this, m );
  }

  premultiply( m ) {
    return this.multiplyMatrices( m, this );
  }

  multiplyMatrices( a, b ) {
    const ae = a.elements;
    const be = b.elements;
    const te = this.elements;
    const a11 = ae[ 0 ], a12 = ae[ 3 ], a13 = ae[ 6 ];
    const a21 = ae[ 1 ], a22 = ae[ 4 ], a23 = ae[ 7 ];
    const a31 = ae[ 2 ], a32 = ae[ 5 ], a33 = ae[ 8 ];
    const b11 = be[ 0 ], b12 = be[ 3 ], b13 = be[ 6 ];
    const b21 = be[ 1 ], b22 = be[ 4 ], b23 = be[ 7 ];
    const b31 = be[ 2 ], b32 = be[ 5 ], b33 = be[ 8 ];
    te[ 0 ] = a11 * b11 + a12 * b21 + a13 * b31;
    te[ 3 ] = a11 * b12 + a12 * b22 + a13 * b32;
    te[ 6 ] = a11 * b13 + a12 * b23 + a13 * b33;
    te[ 1 ] = a21 * b11 + a22 * b21 + a23 * b31;
    te[ 4 ] = a21 * b12 + a22 * b22 + a23 * b32;
    te[ 7 ] = a21 * b13 + a22 * b23 + a23 * b33;
    te[ 2 ] = a31 * b11 + a32 * b21 + a33 * b31;
    te[ 5 ] = a31 * b12 + a32 * b22 + a33 * b32;
    te[ 8 ] = a31 * b13 + a32 * b23 + a33 * b33;
    return this;
  }

  multiplyScalar( s ) {
    const te = this.elements;
    te[ 0 ] *= s; te[ 3 ] *= s; te[ 6 ] *= s;
    te[ 1 ] *= s; te[ 4 ] *= s; te[ 7 ] *= s;
    te[ 2 ] *= s; te[ 5 ] *= s; te[ 8 ] *= s;
    return this;
  }

  determinant() {
    const te = this.elements;
    const a = te[ 0 ], b = te[ 1 ], c = te[ 2 ];
    const d = te[ 3 ], e = te[ 4 ], f = te[ 5 ];
    const g = te[ 6 ], h = te[ 7 ], i = te[ 8 ];
    return a * e * i - a * f * h - b * d * i + b * f * g + c * d * h - c * e * g;
  }

  invert() {
    const te = this.elements,
      n11 = te[ 0 ], n21 = te[ 1 ], n31 = te[ 2 ],
      n12 = te[ 3 ], n22 = te[ 4 ], n32 = te[ 5 ],
      n13 = te[ 6 ], n23 = te[ 7 ], n33 = te[ 8 ],
      t11 = n33 * n22 - n32 * n23,
      t12 = n32 * n13 - n33 * n12,
      t13 = n23 * n12 - n22 * n13,
      det = n11 * t11 + n21 * t12 + n31 * t13;
    if ( det === 0 ) return this.set( 0, 0, 0, 0, 0, 0, 0, 0, 0 );
    const detInv = 1 / det;
    te[ 0 ] = t11 * detInv;
    te[ 1 ] = ( n31 * n23 - n33 * n21 ) * detInv;
    te[ 2 ] = ( n32 * n21 - n31 * n22 ) * detInv;
    te[ 3 ] = t12 * detInv;
    te[ 4 ] = ( n33 * n11 - n31 * n13 ) * detInv;
    te[ 5 ] = ( n31 * n12 - n32 * n11 ) * detInv;
    te[ 6 ] = t13 * detInv;
    te[ 7 ] = ( n21 * n13 - n23 * n11 ) * detInv;
    te[ 8 ] = ( n22 * n11 - n21 * n12 ) * detInv;
    return this;
  }

  transpose() {
    let tmp;
    const m = this.elements;
    tmp = m[ 1 ]; m[ 1 ] = m[ 3 ]; m[ 3 ] = tmp;
    tmp = m[ 2 ]; m[ 2 ] = m[ 6 ]; m[ 6 ] = tmp;
    tmp = m[ 5 ]; m[ 5 ] = m[ 7 ]; m[ 7 ] = tmp;
    return this;
  }

  getNormalMatrix( matrix4 ) {
    return this.setFromMatrix4( matrix4 ).invert().transpose();
  }

  transposeIntoArray( r ) {
    const m = this.elements;
    r[ 0 ] = m[ 0 ]; r[ 1 ] = m[ 3 ]; r[ 2 ] = m[ 6 ];
    r[ 3 ] = m[ 1 ]; r[ 4 ] = m[ 4 ]; r[ 5 ] = m[ 7 ];
    r[ 6 ] = m[ 2 ]; r[ 7 ] = m[ 5 ]; r[ 8 ] = m[ 8 ];
    return this;
  }

  setUvTransform( tx, ty, sx, sy, rotation, cx, cy ) {
    const c = Math.cos( rotation );
    const s = Math.sin( rotation );
    this.set(
      sx * c, sx * s, - sx * ( c * cx + s * cy ) + cx + tx,
      - sy * s, sy * c, - sy * ( - s * cx + c * cy ) + cy + ty,
      0, 0, 1
    );
    return this;
  }

  scale( sx, sy ) {
    warnOnce( 'THREE.Matrix3: .scale() is deprecated. Use .makeScale() instead.' );
    this.premultiply( _m3.makeScale( sx, sy ) );
    return this;
  }

  rotate( theta ) {
    warnOnce( 'THREE.Matrix3: .rotate() is deprecated. Use .makeRotation() instead.' );
    this.premultiply( _m3.makeRotation( - theta ) );
    return this;
  }

  translate( tx, ty ) {
    warnOnce( 'THREE.Matrix3: .translate() is deprecated. Use .makeTranslation() instead.' );
    this.premultiply( _m3.makeTranslation( tx, ty ) );
    return this;
  }

  makeTranslation( x, y ) {
    if ( x.isVector2 ) {
      this.set( 1, 0, x.x, 0, 1, x.y, 0, 0, 1 );
    } else {
      this.set( 1, 0, x, 0, 1, y, 0, 0, 1 );
    }
    return this;
  }

  makeRotation( theta ) {
    const c = Math.cos( theta );
    const s = Math.sin( theta );
    this.set( c, - s, 0, s, c, 0, 0, 0, 1 );
    return this;
  }

  makeScale( x, y ) {
    this.set( x, 0, 0, 0, y, 0, 0, 0, 1 );
    return this;
  }

  equals( matrix ) {
    const te = this.elements;
    const me = matrix.elements;
    for ( let i = 0; i < 9; i ++ ) {
      if ( te[ i ] !== me[ i ] ) return false;
    }
    return true;
  }

  fromArray( array, offset = 0 ) {
    for ( let i = 0; i < 9; i ++ ) {
      this.elements[ i ] = array[ i + offset ];
    }
    return this;
  }

  toArray( array = [], offset = 0 ) {
    const te = this.elements;
    array[ offset ] = te[ 0 ];
    array[ offset + 1 ] = te[ 1 ];
    array[ offset + 2 ] = te[ 2 ];
    array[ offset + 3 ] = te[ 3 ];
    array[ offset + 4 ] = te[ 4 ];
    array[ offset + 5 ] = te[ 5 ];
    array[ offset + 6 ] = te[ 6 ];
    array[ offset + 7 ] = te[ 7 ];
    array[ offset + 8 ] = te[ 8 ];
    return array;
  }

  clone() {
    return new this.constructor().fromArray( this.elements );
  }

}

const _m3 = /*@__PURE__*/ new Matrix3();

export { Matrix3 };