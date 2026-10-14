// file number : 007
// full path name : src/math/007_Matrix4.js
// description : 4x4 matrix class (THREE.Matrix4) stored column-major, with method chaining, plus full zero-allocation bridge functions to/from gl-matrix mat4 (Float32Array of length 16) and bitecs 0.4.0 SoA components (sixteen separate Float32Arrays indexed by entity id). Constructor no longer reads arguments (r185 behavior). Includes determinantAffine() optimization from r185. Uses warnOnce from the official three.js r185 utils.js. Adds high-precision double.js helpers (preciseDeterminant, preciseDeterminantAffine, preciseInvertInto) and a seeded simplex-noise setFromNoise4D helper that fills a rotation matrix from four noise samples.
// best for  :  Model transforms, view/projection matrices, normal matrices, skinned mesh bone matrices, and any ECS system that drives 4x4 transforms directly into Object3D.matrix, Camera.matrixWorld, or shader uniforms without allocating per frame.
// license : MIT

import { warnOnce } from 'https://raw.githubusercontent.com/mrdoob/three.js/r185/src/utils.js';
import { Vector3 } from './003_Vector3.js';
import { Quaternion } from './004_Quaternion.js';

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise4D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const { mat4: glMat4 } = glMatrix;

// WebGL/WebGPU coordinate system constants (imported from ../constants.js in r185;
// inlined here to keep this file self-contained in the rewritten math module).
const WebGLCoordinateSystem = 2000;
const WebGPUCoordinateSystem = 2001;

/*
 * -----------------------------------------------------------------------------
 * BITECS 0.4.0 COMPONENT DEFINITION (SoA, archetype-friendly, cache-friendly)
 * -----------------------------------------------------------------------------
 * Matrix4 is stored as sixteen independent Float32Arrays indexed by entity id.
 * Column-major layout: elements[0..3] is column 0, [4..7] is column 1, etc.
 * Naming: mC R where C = column index (0-3), R = row index (0-3).
 * Systems read/write store.m00[eid] ... store.m33[eid] directly — no temporary
 * mat4 object, no per-entity allocation, no GC churn.
 */
export const Matrix4Component = defineComponent( {
  m00: Types.f32, m01: Types.f32, m02: Types.f32, m03: Types.f32,
  m10: Types.f32, m11: Types.f32, m12: Types.f32, m13: Types.f32,
  m20: Types.f32, m21: Types.f32, m22: Types.f32, m23: Types.f32,
  m30: Types.f32, m31: Types.f32, m32: Types.f32, m33: Types.f32
} );

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix mat4  <->  THREE.Matrix4
 * -----------------------------------------------------------------------------
 * gl-matrix writes into a Float32Array out param of length 16 in column-major
 * order, identical to THREE.Matrix4.elements. We mirror that contract exactly.
 * The THREE side always writes into a preallocated THREE.Matrix4 (the `out`
 * argument), never returns a fresh instance, so hot loops stay allocation-free.
 */

// gl-matrix mat4 (Float32Array len 16, column-major) -> preallocated THREE.Matrix4
export function threeMat4FromGlMatrix( out, glM ) {
  const e = out.elements;
  for ( let i = 0; i < 16; i ++ ) e[ i ] = glM[ i ];
  return out;
}

// THREE.Matrix4 -> preallocated gl-matrix mat4 (Float32Array len 16)
export function glMatrixMat4FromThree( out, threeM ) {
  const e = threeM.elements;
  for ( let i = 0; i < 16; i ++ ) out[ i ] = e[ i ];
  return out;
}

// gl-matrix mat4 -> write directly into a bitecs entity's SoA component
export function bitecsMat4FromGlMatrix( eid, glM, store = Matrix4Component ) {
  store.m00[ eid ] = glM[ 0 ]; store.m01[ eid ] = glM[ 1 ];
  store.m02[ eid ] = glM[ 2 ]; store.m03[ eid ] = glM[ 3 ];
  store.m10[ eid ] = glM[ 4 ]; store.m11[ eid ] = glM[ 5 ];
  store.m12[ eid ] = glM[ 6 ]; store.m13[ eid ] = glM[ 7 ];
  store.m20[ eid ] = glM[ 8 ]; store.m21[ eid ] = glM[ 9 ];
  store.m22[ eid ] = glM[ 10 ]; store.m23[ eid ] = glM[ 11 ];
  store.m30[ eid ] = glM[ 12 ]; store.m31[ eid ] = glM[ 13 ];
  store.m32[ eid ] = glM[ 14 ]; store.m33[ eid ] = glM[ 15 ];
  return eid;
}

// bitecs entity SoA component -> preallocated gl-matrix mat4 (Float32Array len 16)
export function glMatrixMat4FromBitecs( out, eid, store = Matrix4Component ) {
  out[ 0 ] = store.m00[ eid ]; out[ 1 ] = store.m01[ eid ];
  out[ 2 ] = store.m02[ eid ]; out[ 3 ] = store.m03[ eid ];
  out[ 4 ] = store.m10[ eid ]; out[ 5 ] = store.m11[ eid ];
  out[ 6 ] = store.m12[ eid ]; out[ 7 ] = store.m13[ eid ];
  out[ 8 ] = store.m20[ eid ]; out[ 9 ] = store.m21[ eid ];
  out[ 10 ] = store.m22[ eid ]; out[ 11 ] = store.m23[ eid ];
  out[ 12 ] = store.m30[ eid ]; out[ 13 ] = store.m31[ eid ];
  out[ 14 ] = store.m32[ eid ]; out[ 15 ] = store.m33[ eid ];
  return out;
}

// bitecs entity SoA component -> preallocated THREE.Matrix4 (no temp mat4)
export function threeMat4FromBitecs( out, eid, store = Matrix4Component ) {
  const e = out.elements;
  e[ 0 ] = store.m00[ eid ]; e[ 1 ] = store.m01[ eid ];
  e[ 2 ] = store.m02[ eid ]; e[ 3 ] = store.m03[ eid ];
  e[ 4 ] = store.m10[ eid ]; e[ 5 ] = store.m11[ eid ];
  e[ 6 ] = store.m12[ eid ]; e[ 7 ] = store.m13[ eid ];
  e[ 8 ] = store.m20[ eid ]; e[ 9 ] = store.m21[ eid ];
  e[ 10 ] = store.m22[ eid ]; e[ 11 ] = store.m23[ eid ];
  e[ 12 ] = store.m30[ eid ]; e[ 13 ] = store.m31[ eid ];
  e[ 14 ] = store.m32[ eid ]; e[ 15 ] = store.m33[ eid ];
  return out;
}

// THREE.Matrix4 -> write directly into a bitecs entity's SoA component
export function bitecsMat4FromThree( eid, threeM, store = Matrix4Component ) {
  const e = threeM.elements;
  store.m00[ eid ] = e[ 0 ]; store.m01[ eid ] = e[ 1 ];
  store.m02[ eid ] = e[ 2 ]; store.m03[ eid ] = e[ 3 ];
  store.m10[ eid ] = e[ 4 ]; store.m11[ eid ] = e[ 5 ];
  store.m12[ eid ] = e[ 6 ]; store.m13[ eid ] = e[ 7 ];
  store.m20[ eid ] = e[ 8 ]; store.m21[ eid ] = e[ 9 ];
  store.m22[ eid ] = e[ 10 ]; store.m23[ eid ] = e[ 11 ];
  store.m30[ eid ] = e[ 12 ]; store.m31[ eid ] = e[ 13 ];
  store.m32[ eid ] = e[ 14 ]; store.m33[ eid ] = e[ 15 ];
  return eid;
}

// Multiply two bitecs SoA matrices -> preallocated THREE.Matrix4.
export function threeMat4FromBitecsMultiply( out, eidA, eidB, storeA = Matrix4Component, storeB = Matrix4Component ) {
  const a00 = storeA.m00[ eidA ], a01 = storeA.m01[ eidA ], a02 = storeA.m02[ eidA ], a03 = storeA.m03[ eidA ];
  const a10 = storeA.m10[ eidA ], a11 = storeA.m11[ eidA ], a12 = storeA.m12[ eidA ], a13 = storeA.m13[ eidA ];
  const a20 = storeA.m20[ eidA ], a21 = storeA.m21[ eidA ], a22 = storeA.m22[ eidA ], a23 = storeA.m23[ eidA ];
  const a30 = storeA.m30[ eidA ], a31 = storeA.m31[ eidA ], a32 = storeA.m32[ eidA ], a33 = storeA.m33[ eidA ];
  const b00 = storeB.m00[ eidB ], b01 = storeB.m01[ eidB ], b02 = storeB.m02[ eidB ], b03 = storeB.m03[ eidB ];
  const b10 = storeB.m10[ eidB ], b11 = storeB.m11[ eidB ], b12 = storeB.m12[ eidB ], b13 = storeB.m13[ eidB ];
  const b20 = storeB.m20[ eidB ], b21 = storeB.m21[ eidB ], b22 = storeB.m22[ eidB ], b23 = storeB.m23[ eidB ];
  const b30 = storeB.m30[ eidB ], b31 = storeB.m31[ eidB ], b32 = storeB.m32[ eidB ], b33 = storeB.m33[ eidB ];
  const e = out.elements;
  e[ 0 ] = a00 * b00 + a10 * b01 + a20 * b02 + a30 * b03;
  e[ 1 ] = a01 * b00 + a11 * b01 + a21 * b02 + a31 * b03;
  e[ 2 ] = a02 * b00 + a12 * b01 + a22 * b02 + a32 * b03;
  e[ 3 ] = a03 * b00 + a13 * b01 + a23 * b02 + a33 * b03;
  e[ 4 ] = a00 * b10 + a10 * b11 + a20 * b12 + a30 * b13;
  e[ 5 ] = a01 * b10 + a11 * b11 + a21 * b12 + a31 * b13;
  e[ 6 ] = a02 * b10 + a12 * b11 + a22 * b12 + a32 * b13;
  e[ 7 ] = a03 * b10 + a13 * b11 + a23 * b12 + a33 * b13;
  e[ 8 ] = a00 * b20 + a10 * b21 + a20 * b22 + a30 * b23;
  e[ 9 ] = a01 * b20 + a11 * b21 + a21 * b22 + a31 * b23;
  e[ 10 ] = a02 * b20 + a12 * b21 + a22 * b22 + a32 * b23;
  e[ 11 ] = a03 * b20 + a13 * b21 + a23 * b22 + a33 * b23;
  e[ 12 ] = a00 * b30 + a10 * b31 + a20 * b32 + a30 * b33;
  e[ 13 ] = a01 * b30 + a11 * b31 + a21 * b32 + a31 * b33;
  e[ 14 ] = a02 * b30 + a12 * b31 + a22 * b32 + a32 * b33;
  e[ 15 ] = a03 * b30 + a13 * b31 + a23 * b32 + a33 * b33;
  return out;
}

// Multiply two bitecs SoA matrices -> dst entity's SoA store.
export function bitecsMat4MultiplyInto( eidOut, eidA, eidB, storeA = Matrix4Component, storeB = Matrix4Component, storeOut = storeA ) {
  const a00 = storeA.m00[ eidA ], a01 = storeA.m01[ eidA ], a02 = storeA.m02[ eidA ], a03 = storeA.m03[ eidA ];
  const a10 = storeA.m10[ eidA ], a11 = storeA.m11[ eidA ], a12 = storeA.m12[ eidA ], a13 = storeA.m13[ eidA ];
  const a20 = storeA.m20[ eidA ], a21 = storeA.m21[ eidA ], a22 = storeA.m22[ eidA ], a23 = storeA.m23[ eidA ];
  const a30 = storeA.m30[ eidA ], a31 = storeA.m31[ eidA ], a32 = storeA.m32[ eidA ], a33 = storeA.m33[ eidA ];
  const b00 = storeB.m00[ eidB ], b01 = storeB.m01[ eidB ], b02 = storeB.m02[ eidB ], b03 = storeB.m03[ eidB ];
  const b10 = storeB.m10[ eidB ], b11 = storeB.m11[ eidB ], b12 = storeB.m12[ eidB ], b13 = storeB.m13[ eidB ];
  const b20 = storeB.m20[ eidB ], b21 = storeB.m21[ eidB ], b22 = storeB.m22[ eidB ], b23 = storeB.m23[ eidB ];
  const b30 = storeB.m30[ eidB ], b31 = storeB.m31[ eidB ], b32 = storeB.m32[ eidB ], b33 = storeB.m33[ eidB ];
  storeOut.m00[ eidOut ] = a00 * b00 + a10 * b01 + a20 * b02 + a30 * b03;
  storeOut.m01[ eidOut ] = a01 * b00 + a11 * b01 + a21 * b02 + a31 * b03;
  storeOut.m02[ eidOut ] = a02 * b00 + a12 * b01 + a22 * b02 + a32 * b03;
  storeOut.m03[ eidOut ] = a03 * b00 + a13 * b01 + a23 * b02 + a33 * b03;
  storeOut.m10[ eidOut ] = a00 * b10 + a10 * b11 + a20 * b12 + a30 * b13;
  storeOut.m11[ eidOut ] = a01 * b10 + a11 * b11 + a21 * b12 + a31 * b13;
  storeOut.m12[ eidOut ] = a02 * b10 + a12 * b11 + a22 * b12 + a32 * b13;
  storeOut.m13[ eidOut ] = a03 * b10 + a13 * b11 + a23 * b12 + a33 * b13;
  storeOut.m20[ eidOut ] = a00 * b20 + a10 * b21 + a20 * b22 + a30 * b23;
  storeOut.m21[ eidOut ] = a01 * b20 + a11 * b21 + a21 * b22 + a31 * b23;
  storeOut.m22[ eidOut ] = a02 * b20 + a12 * b21 + a22 * b22 + a32 * b23;
  storeOut.m23[ eidOut ] = a03 * b20 + a13 * b21 + a23 * b22 + a33 * b23;
  storeOut.m30[ eidOut ] = a00 * b30 + a10 * b31 + a20 * b32 + a30 * b33;
  storeOut.m31[ eidOut ] = a01 * b30 + a11 * b31 + a21 * b32 + a31 * b33;
  storeOut.m32[ eidOut ] = a02 * b30 + a12 * b31 + a22 * b32 + a32 * b33;
  storeOut.m33[ eidOut ] = a03 * b30 + a13 * b31 + a23 * b32 + a33 * b33;
  return eidOut;
}

// Invert a bitecs SoA matrix in place (degenerate -> zero matrix).
export function bitecsMat4InvertInPlace( eid, store = Matrix4Component ) {
  const n11 = store.m00[ eid ], n21 = store.m01[ eid ], n31 = store.m02[ eid ], n41 = store.m03[ eid ];
  const n12 = store.m10[ eid ], n22 = store.m11[ eid ], n32 = store.m12[ eid ], n42 = store.m13[ eid ];
  const n13 = store.m20[ eid ], n23 = store.m21[ eid ], n33 = store.m22[ eid ], n43 = store.m23[ eid ];
  const n14 = store.m30[ eid ], n24 = store.m31[ eid ], n34 = store.m32[ eid ], n44 = store.m33[ eid ];
  const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
  const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
  const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
  const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;
  const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
  if ( det === 0 ) {
    store.m00[ eid ] = 0; store.m01[ eid ] = 0; store.m02[ eid ] = 0; store.m03[ eid ] = 0;
    store.m10[ eid ] = 0; store.m11[ eid ] = 0; store.m12[ eid ] = 0; store.m13[ eid ] = 0;
    store.m20[ eid ] = 0; store.m21[ eid ] = 0; store.m22[ eid ] = 0; store.m23[ eid ] = 0;
    store.m30[ eid ] = 0; store.m31[ eid ] = 0; store.m32[ eid ] = 0; store.m33[ eid ] = 0;
    return eid;
  }
  const detInv = 1 / det;
  store.m00[ eid ] = t11 * detInv;
  store.m01[ eid ] = ( n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44 ) * detInv;
  store.m02[ eid ] = ( n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44 ) * detInv;
  store.m03[ eid ] = ( n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43 ) * detInv;
  store.m10[ eid ] = t12 * detInv;
  store.m11[ eid ] = ( n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44 ) * detInv;
  store.m12[ eid ] = ( n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44 ) * detInv;
  store.m13[ eid ] = ( n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43 ) * detInv;
  store.m20[ eid ] = t13 * detInv;
  store.m21[ eid ] = ( n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44 ) * detInv;
  store.m22[ eid ] = ( n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44 ) * detInv;
  store.m23[ eid ] = ( n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43 ) * detInv;
  store.m30[ eid ] = t14 * detInv;
  store.m31[ eid ] = ( n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34 ) * detInv;
  store.m32[ eid ] = ( n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34 ) * detInv;
  store.m33[ eid ] = ( n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33 ) * detInv;
  return eid;
}

// Transpose a bitecs SoA matrix in place.
export function bitecsMat4TransposeInPlace( eid, store = Matrix4Component ) {
  let tmp;
  tmp = store.m01[ eid ]; store.m01[ eid ] = store.m10[ eid ]; store.m10[ eid ] = tmp;
  tmp = store.m02[ eid ]; store.m02[ eid ] = store.m20[ eid ]; store.m20[ eid ] = tmp;
  tmp = store.m03[ eid ]; store.m03[ eid ] = store.m30[ eid ]; store.m30[ eid ] = tmp;
  tmp = store.m12[ eid ]; store.m12[ eid ] = store.m21[ eid ]; store.m21[ eid ] = tmp;
  tmp = store.m13[ eid ]; store.m13[ eid ] = store.m31[ eid ]; store.m31[ eid ] = tmp;
  tmp = store.m23[ eid ]; store.m23[ eid ] = store.m32[ eid ]; store.m32[ eid ] = tmp;
  return eid;
}

// Determinant of a bitecs SoA matrix.
export function bitecsMat4Determinant( eid, store = Matrix4Component ) {
  const n11 = store.m00[ eid ], n21 = store.m01[ eid ], n31 = store.m02[ eid ], n41 = store.m03[ eid ];
  const n12 = store.m10[ eid ], n22 = store.m11[ eid ], n32 = store.m12[ eid ], n42 = store.m13[ eid ];
  const n13 = store.m20[ eid ], n23 = store.m21[ eid ], n33 = store.m22[ eid ], n43 = store.m23[ eid ];
  const n14 = store.m30[ eid ], n24 = store.m31[ eid ], n34 = store.m32[ eid ], n44 = store.m33[ eid ];
  const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
  const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
  const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
  const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;
  return n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
}

// Affine determinant (faster, assumes last row is [0,0,0,1]).
export function bitecsMat4DeterminantAffine( eid, store = Matrix4Component ) {
  const n11 = store.m00[ eid ], n12 = store.m01[ eid ], n13 = store.m02[ eid ];
  const n21 = store.m10[ eid ], n22 = store.m11[ eid ], n23 = store.m12[ eid ];
  const n31 = store.m20[ eid ], n32 = store.m21[ eid ], n33 = store.m22[ eid ];
  return n11 * ( n22 * n33 - n23 * n32 ) -
    n12 * ( n21 * n33 - n23 * n31 ) +
    n13 * ( n21 * n32 - n22 * n31 );
}

// Scale a bitecs SoA matrix in place by a scalar.
export function bitecsMat4ScaleInPlace( eid, scalar, store = Matrix4Component ) {
  for ( let i = 0; i < 4; i ++ ) {
    for ( let j = 0; j < 4; j ++ ) {
      store[ 'm' + i + j ][ eid ] *= scalar;
    }
  }
  return eid;
}

// Decompose a bitecs SoA matrix into position, quaternion, and scale SoA
// components. Writes directly into the three destination stores — no temp.
export function bitecsMat4DecomposeInto( eidSrc, eidPos, eidQuat, eidScale, storeM = Matrix4Component, storePos, storeQuat, storeScale ) {
  const te = storeM;
  let sx = Math.sqrt( te.m00[ eidSrc ] * te.m00[ eidSrc ] + te.m01[ eidSrc ] * te.m01[ eidSrc ] + te.m02[ eidSrc ] * te.m02[ eidSrc ] );
  const sy = Math.sqrt( te.m10[ eidSrc ] * te.m10[ eidSrc ] + te.m11[ eidSrc ] * te.m11[ eidSrc ] + te.m12[ eidSrc ] * te.m12[ eidSrc ] );
  const sz = Math.sqrt( te.m20[ eidSrc ] * te.m20[ eidSrc ] + te.m21[ eidSrc ] * te.m21[ eidSrc ] + te.m22[ eidSrc ] * te.m22[ eidSrc ] );

  // Handle negative determinant (flip one axis)
  if ( sx * sy * sz < 0 ) {
    if ( sx < 0 ) { sx = - sx; } else if ( sy < 0 ) { sy = - sy; } else { sz = - sz; }
  }

  const invSX = 1 / sx, invSY = 1 / sy, invSZ = 1 / sz;

  const m11 = te.m00[ eidSrc ] * invSX, m12 = te.m01[ eidSrc ] * invSX, m13 = te.m02[ eidSrc ] * invSX;
  const m21 = te.m10[ eidSrc ] * invSY, m22 = te.m11[ eidSrc ] * invSY, m23 = te.m12[ eidSrc ] * invSY;
  const m31 = te.m20[ eidSrc ] * invSZ, m32 = te.m21[ eidSrc ] * invSZ, m33 = te.m22[ eidSrc ] * invSZ;

  const trace = m11 + m22 + m33;
  const q = storeQuat;
  if ( trace > 0 ) {
    const s = 0.5 / Math.sqrt( trace + 1.0 );
    q.w[ eidQuat ] = 0.25 / s;
    q.x[ eidQuat ] = ( m32 - m23 ) * s;
    q.y[ eidQuat ] = ( m13 - m31 ) * s;
    q.z[ eidQuat ] = ( m21 - m12 ) * s;
  } else if ( m11 > m22 && m11 > m33 ) {
    const s = 2.0 * Math.sqrt( 1.0 + m11 - m22 - m33 );
    q.w[ eidQuat ] = ( m32 - m23 ) / s;
    q.x[ eidQuat ] = 0.25 * s;
    q.y[ eidQuat ] = ( m12 + m21 ) / s;
    q.z[ eidQuat ] = ( m13 + m31 ) / s;
  } else if ( m22 > m33 ) {
    const s = 2.0 * Math.sqrt( 1.0 + m22 - m11 - m33 );
    q.w[ eidQuat ] = ( m13 - m31 ) / s;
    q.x[ eidQuat ] = ( m12 + m21 ) / s;
    q.y[ eidQuat ] = 0.25 * s;
    q.z[ eidQuat ] = ( m23 + m32 ) / s;
  } else {
    const s = 2.0 * Math.sqrt( 1.0 + m33 - m11 - m22 );
    q.w[ eidQuat ] = ( m21 - m12 ) / s;
    q.x[ eidQuat ] = ( m13 + m31 ) / s;
    q.y[ eidQuat ] = ( m23 + m32 ) / s;
    q.z[ eidQuat ] = 0.25 * s;
  }

  storePos.x[ eidPos ] = te.m30[ eidSrc ];
  storePos.y[ eidPos ] = te.m31[ eidSrc ];
  storePos.z[ eidPos ] = te.m32[ eidSrc ];

  storeScale.x[ eidScale ] = sx;
  storeScale.y[ eidScale ] = sy;
  storeScale.z[ eidScale ] = sz;
  return eidSrc;
}

// Compose a bitecs SoA matrix from position, quaternion, and scale SoA
// components. Reads directly from the three source stores — no temp.
export function bitecsMat4ComposeFrom( eidOut, eidPos, eidQuat, eidScale, storeM = Matrix4Component, storePos, storeQuat, storeScale ) {
  const x = storeQuat.x[ eidQuat ], y = storeQuat.y[ eidQuat ], z = storeQuat.z[ eidQuat ], w = storeQuat.w[ eidQuat ];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const sx = storeScale.x[ eidScale ], sy = storeScale.y[ eidScale ], sz = storeScale.z[ eidScale ];

  storeM.m00[ eidOut ] = ( 1 - ( yy + zz ) ) * sx;
  storeM.m01[ eidOut ] = ( xy + wz ) * sx;
  storeM.m02[ eidOut ] = ( xz - wy ) * sx;
  storeM.m03[ eidOut ] = 0;
  storeM.m10[ eidOut ] = ( xy - wz ) * sy;
  storeM.m11[ eidOut ] = ( 1 - ( xx + zz ) ) * sy;
  storeM.m12[ eidOut ] = ( yz + wx ) * sy;
  storeM.m13[ eidOut ] = 0;
  storeM.m20[ eidOut ] = ( xz + wy ) * sz;
  storeM.m21[ eidOut ] = ( yz - wx ) * sz;
  storeM.m22[ eidOut ] = ( 1 - ( xx + yy ) ) * sz;
  storeM.m23[ eidOut ] = 0;
  storeM.m30[ eidOut ] = storePos.x[ eidPos ];
  storeM.m31[ eidOut ] = storePos.y[ eidPos ];
  storeM.m32[ eidOut ] = storePos.z[ eidPos ];
  storeM.m33[ eidOut ] = 1;
  return eidOut;
}

// gl-matrix mat4 multiply -> out, reading directly from two bitecs entities.
export function glMatrixMat4MultiplyFromBitecs( out, eidA, eidB, storeA = Matrix4Component, storeB = Matrix4Component ) {
  const a = _scratchMat4A;
  const b = _scratchMat4B;
  glMatrixMat4FromBitecs( a, eidA, storeA );
  glMatrixMat4FromBitecs( b, eidB, storeB );
  return glMat4.multiply( out, a, b );
}

// gl-matrix mat4 invert -> out, reading directly from a bitecs entity.
export function glMatrixMat4InvertFromBitecs( out, eid, store = Matrix4Component ) {
  const a = _scratchMat4A;
  glMatrixMat4FromBitecs( a, eid, store );
  return glMat4.invert( out, a );
}

// gl-matrix mat4 transpose -> out, reading directly from a bitecs entity.
export function glMatrixMat4TransposeFromBitecs( out, eid, store = Matrix4Component ) {
  const a = _scratchMat4A;
  glMatrixMat4FromBitecs( a, eid, store );
  return glMat4.transpose( out, a );
}

// gl-matrix mat4 determinant -> scalar, reading directly from a bitecs entity.
export function glMatrixMat4DeterminantFromBitecs( eid, store = Matrix4Component ) {
  const a = _scratchMat4A;
  glMatrixMat4FromBitecs( a, eid, store );
  return glMat4.determinant( a );
}

// gl-matrix mat4 fromQuat -> out, reading directly from a bitecs quaternion entity.
export function glMatrixMat4FromBitecsQuat( out, eid, storeQ ) {
  const q = _scratchQuat;
  q[ 0 ] = storeQ.x[ eid ]; q[ 1 ] = storeQ.y[ eid ];
  q[ 2 ] = storeQ.z[ eid ]; q[ 3 ] = storeQ.w[ eid ];
  return glMat4.fromQuat( out, q );
}

// gl-matrix mat4 fromRotationTranslation -> out, reading directly from bitecs
// quaternion and position SoA entities.
export function glMatrixMat4FromBitecsRotTrans( out, eidQ, eidP, storeQ, storeP ) {
  const q = _scratchQuat;
  q[ 0 ] = storeQ.x[ eidQ ]; q[ 1 ] = storeQ.y[ eidQ ];
  q[ 2 ] = storeQ.z[ eidQ ]; q[ 3 ] = storeQ.w[ eidQ ];
  const v = _scratchVec3;
  v[ 0 ] = storeP.x[ eidP ]; v[ 1 ] = storeP.y[ eidP ]; v[ 2 ] = storeP.z[ eidP ];
  return glMat4.fromRotationTranslation( out, q, v );
}

// gl-matrix mat4 frustum -> out (caller supplies 6 planes).
export function glMatrixMat4Frustum( out, left, right, bottom, top, near, far ) {
  return glMat4.frustum( out, left, right, bottom, top, near, far );
}

// gl-matrix mat4 perspective -> out.
export function glMatrixMat4Perspective( out, fovy, aspect, near, far ) {
  return glMat4.perspective( out, fovy, aspect, near, far );
}

// gl-matrix mat4 ortho -> out.
export function glMatrixMat4Ortho( out, left, right, bottom, top, near, far ) {
  return glMat4.ortho( out, left, right, bottom, top, near, far );
}

// gl-matrix mat4 lookAt -> out, reading directly from three bitecs vec3 entities.
export function glMatrixMat4LookAtFromBitecs( out, eidEye, eidCenter, eidUp, storeEye, storeCenter, storeUp ) {
  const eye = _scratchVec3;
  eye[ 0 ] = storeEye.x[ eidEye ]; eye[ 1 ] = storeEye.y[ eidEye ]; eye[ 2 ] = storeEye.z[ eidEye ];
  const center = _scratchVec3B;
  center[ 0 ] = storeCenter.x[ eidCenter ]; center[ 1 ] = storeCenter.y[ eidCenter ]; center[ 2 ] = storeCenter.z[ eidCenter ];
  const up = _scratchVec3C;
  up[ 0 ] = storeUp.x[ eidUp ]; up[ 1 ] = storeUp.y[ eidUp ]; up[ 2 ] = storeUp.z[ eidUp ];
  return glMat4.lookAt( out, eye, center, up );
}

/*
 * -----------------------------------------------------------------------------
 * HIGH-PRECISION HELPERS (double.js)
 * -----------------------------------------------------------------------------
 * double.js's Double type carries ~106 bits of mantissa. These helpers compute
 * the determinant and invert a 4x4 matrix in double-double precision, avoiding
 * the loss that hits the f64 path when the matrix is ill-conditioned.
 */

function _toDouble( value ) {
  return new Double( value );
}

// Returns det(m) evaluated in double-double precision.
export function preciseDeterminant( m ) {
  const e = m.elements;
  const n11 = _toDouble( e[ 0 ] ), n21 = _toDouble( e[ 1 ] ), n31 = _toDouble( e[ 2 ] ), n41 = _toDouble( e[ 3 ] );
  const n12 = _toDouble( e[ 4 ] ), n22 = _toDouble( e[ 5 ] ), n32 = _toDouble( e[ 6 ] ), n42 = _toDouble( e[ 7 ] );
  const n13 = _toDouble( e[ 8 ] ), n23 = _toDouble( e[ 9 ] ), n33 = _toDouble( e[ 10 ] ), n43 = _toDouble( e[ 11 ] );
  const n14 = _toDouble( e[ 12 ] ), n24 = _toDouble( e[ 13 ] ), n34 = _toDouble( e[ 14 ] ), n44 = _toDouble( e[ 15 ] );
  const t11 = n23.mul( n34 ).mul( n42 ).sub( n24.mul( n33 ).mul( n42 ) ).add( n24.mul( n32 ).mul( n43 ) ).sub( n22.mul( n34 ).mul( n43 ) ).sub( n23.mul( n32 ).mul( n44 ) ).add( n22.mul( n33 ).mul( n44 ) );
  const t12 = n14.mul( n33 ).mul( n42 ).sub( n13.mul( n34 ).mul( n42 ) ).sub( n14.mul( n32 ).mul( n43 ) ).add( n12.mul( n34 ).mul( n43 ) ).add( n13.mul( n32 ).mul( n44 ) ).sub( n12.mul( n33 ).mul( n44 ) );
  const t13 = n13.mul( n24 ).mul( n42 ).sub( n14.mul( n23 ).mul( n42 ) ).add( n14.mul( n22 ).mul( n43 ) ).sub( n12.mul( n24 ).mul( n43 ) ).sub( n13.mul( n22 ).mul( n44 ) ).add( n12.mul( n23 ).mul( n44 ) );
  const t14 = n14.mul( n23 ).mul( n32 ).sub( n13.mul( n24 ).mul( n32 ) ).sub( n14.mul( n22 ).mul( n33 ) ).add( n12.mul( n24 ).mul( n33 ) ).add( n13.mul( n22 ).mul( n34 ) ).sub( n12.mul( n23 ).mul( n34 ) );
  return n11.mul( t11 ).add( n21.mul( t12 ) ).add( n31.mul( t13 ) ).add( n41.mul( t14 ) ).toNumber();
}

// Affine determinant in double-double precision (assumes last row [0,0,0,1]).
export function preciseDeterminantAffine( m ) {
  const e = m.elements;
  const n11 = _toDouble( e[ 0 ] ), n12 = _toDouble( e[ 4 ] ), n13 = _toDouble( e[ 8 ] );
  const n21 = _toDouble( e[ 1 ] ), n22 = _toDouble( e[ 5 ] ), n23 = _toDouble( e[ 9 ] );
  const n31 = _toDouble( e[ 2 ] ), n32 = _toDouble( e[ 6 ] ), n33 = _toDouble( e[ 10 ] );
  const t1 = n11.mul( n22.mul( n33 ).sub( n23.mul( n32 ) ) );
  const t2 = n12.mul( n21.mul( n33 ).sub( n23.mul( n31 ) ) );
  const t3 = n13.mul( n21.mul( n32 ).sub( n22.mul( n31 ) ) );
  return t1.sub( t2 ).add( t3 ).toNumber();
}

// Inverts m into out using double-double precision. Matches THREE.Matrix4.invert
// r185 semantics: a degenerate matrix produces a zero matrix.
export function preciseInvertInto( out, m ) {
  const e = m.elements;
  const n11 = _toDouble( e[ 0 ] ), n21 = _toDouble( e[ 1 ] ), n31 = _toDouble( e[ 2 ] ), n41 = _toDouble( e[ 3 ] );
  const n12 = _toDouble( e[ 4 ] ), n22 = _toDouble( e[ 5 ] ), n32 = _toDouble( e[ 6 ] ), n42 = _toDouble( e[ 7 ] );
  const n13 = _toDouble( e[ 8 ] ), n23 = _toDouble( e[ 9 ] ), n33 = _toDouble( e[ 10 ] ), n43 = _toDouble( e[ 11 ] );
  const n14 = _toDouble( e[ 12 ] ), n24 = _toDouble( e[ 13 ] ), n34 = _toDouble( e[ 14 ] ), n44 = _toDouble( e[ 15 ] );

  const t11 = n23.mul( n34 ).mul( n42 ).sub( n24.mul( n33 ).mul( n42 ) ).add( n24.mul( n32 ).mul( n43 ) ).sub( n22.mul( n34 ).mul( n43 ) ).sub( n23.mul( n32 ).mul( n44 ) ).add( n22.mul( n33 ).mul( n44 ) );
  const t12 = n14.mul( n33 ).mul( n42 ).sub( n13.mul( n34 ).mul( n42 ) ).sub( n14.mul( n32 ).mul( n43 ) ).add( n12.mul( n34 ).mul( n43 ) ).add( n13.mul( n32 ).mul( n44 ) ).sub( n12.mul( n33 ).mul( n44 ) );
  const t13 = n13.mul( n24 ).mul( n42 ).sub( n14.mul( n23 ).mul( n42 ) ).add( n14.mul( n22 ).mul( n43 ) ).sub( n12.mul( n24 ).mul( n43 ) ).sub( n13.mul( n22 ).mul( n44 ) ).add( n12.mul( n23 ).mul( n44 ) );
  const t14 = n14.mul( n23 ).mul( n32 ).sub( n13.mul( n24 ).mul( n32 ) ).sub( n14.mul( n22 ).mul( n33 ) ).add( n12.mul( n24 ).mul( n33 ) ).add( n13.mul( n22 ).mul( n34 ) ).sub( n12.mul( n23 ).mul( n34 ) );

  const det = n11.mul( t11 ).add( n21.mul( t12 ) ).add( n31.mul( t13 ) ).add( n41.mul( t14 ) );

  const te = out.elements;
  if ( det.valueOf() === 0 ) {
    for ( let i = 0; i < 16; i ++ ) te[ i ] = 0;
    return out;
  }
  const detInv = _toDouble( 1 ).div( det );

  te[ 0 ] = t11.mul( detInv ).toNumber();
  te[ 1 ] = n24.mul( n33 ).mul( n41 ).sub( n23.mul( n34 ).mul( n41 ) ).sub( n24.mul( n31 ).mul( n43 ) ).add( n21.mul( n34 ).mul( n43 ) ).add( n23.mul( n31 ).mul( n44 ) ).sub( n21.mul( n33 ).mul( n44 ) ).mul( detInv ).toNumber();
  te[ 2 ] = n22.mul( n34 ).mul( n41 ).sub( n24.mul( n32 ).mul( n41 ) ).add( n24.mul( n31 ).mul( n42 ) ).sub( n21.mul( n34 ).mul( n42 ) ).sub( n22.mul( n31 ).mul( n44 ) ).add( n21.mul( n32 ).mul( n44 ) ).mul( detInv ).toNumber();
  te[ 3 ] = n23.mul( n32 ).mul( n41 ).sub( n22.mul( n33 ).mul( n41 ) ).sub( n23.mul( n31 ).mul( n42 ) ).add( n21.mul( n33 ).mul( n42 ) ).add( n22.mul( n31 ).mul( n43 ) ).sub( n21.mul( n32 ).mul( n43 ) ).mul( detInv ).toNumber();
  te[ 4 ] = t12.mul( detInv ).toNumber();
  te[ 5 ] = n13.mul( n34 ).mul( n41 ).sub( n14.mul( n33 ).mul( n41 ) ).add( n14.mul( n31 ).mul( n43 ) ).sub( n11.mul( n34 ).mul( n43 ) ).sub( n13.mul( n31 ).mul( n44 ) ).add( n11.mul( n33 ).mul( n44 ) ).mul( detInv ).toNumber();
  te[ 6 ] = n14.mul( n32 ).mul( n41 ).sub( n12.mul( n34 ).mul( n41 ) ).sub( n14.mul( n31 ).mul( n42 ) ).add( n11.mul( n34 ).mul( n42 ) ).add( n12.mul( n31 ).mul( n44 ) ).sub( n11.mul( n32 ).mul( n44 ) ).mul( detInv ).toNumber();
  te[ 7 ] = n12.mul( n33 ).mul( n41 ).sub( n13.mul( n32 ).mul( n41 ) ).add( n13.mul( n31 ).mul( n42 ) ).sub( n11.mul( n33 ).mul( n42 ) ).sub( n12.mul( n31 ).mul( n43 ) ).add( n11.mul( n32 ).mul( n43 ) ).mul( detInv ).toNumber();
  te[ 8 ] = t13.mul( detInv ).toNumber();
  te[ 9 ] = n14.mul( n23 ).mul( n41 ).sub( n13.mul( n24 ).mul( n41 ) ).sub( n14.mul( n21 ).mul( n43 ) ).add( n11.mul( n24 ).mul( n43 ) ).add( n13.mul( n21 ).mul( n44 ) ).sub( n11.mul( n23 ).mul( n44 ) ).mul( detInv ).toNumber();
  te[ 10 ] = n12.mul( n24 ).mul( n41 ).sub( n14.mul( n22 ).mul( n41 ) ).add( n14.mul( n21 ).mul( n42 ) ).sub( n11.mul( n24 ).mul( n42 ) ).sub( n12.mul( n21 ).mul( n44 ) ).add( n11.mul( n22 ).mul( n44 ) ).mul( detInv ).toNumber();
  te[ 11 ] = n13.mul( n22 ).mul( n41 ).sub( n12.mul( n23 ).mul( n41 ) ).sub( n13.mul( n21 ).mul( n42 ) ).add( n11.mul( n23 ).mul( n42 ) ).add( n12.mul( n21 ).mul( n43 ) ).sub( n11.mul( n22 ).mul( n43 ) ).mul( detInv ).toNumber();
  te[ 12 ] = t14.mul( detInv ).toNumber();
  te[ 13 ] = n13.mul( n24 ).mul( n31 ).sub( n14.mul( n23 ).mul( n31 ) ).add( n14.mul( n21 ).mul( n33 ) ).sub( n11.mul( n24 ).mul( n33 ) ).sub( n13.mul( n21 ).mul( n34 ) ).add( n11.mul( n23 ).mul( n34 ) ).mul( detInv ).toNumber();
  te[ 14 ] = n14.mul( n22 ).mul( n31 ).sub( n12.mul( n24 ).mul( n31 ) ).sub( n14.mul( n21 ).mul( n32 ) ).add( n11.mul( n24 ).mul( n32 ) ).add( n12.mul( n21 ).mul( n34 ) ).sub( n11.mul( n22 ).mul( n34 ) ).mul( detInv ).toNumber();
  te[ 15 ] = n12.mul( n23 ).mul( n31 ).sub( n13.mul( n22 ).mul( n31 ) ).add( n13.mul( n21 ).mul( n32 ) ).sub( n11.mul( n23 ).mul( n32 ) ).sub( n12.mul( n21 ).mul( n33 ) ).add( n11.mul( n22 ).mul( n33 ) ).mul( detInv ).toNumber();
  return out;
}

/*
 * -----------------------------------------------------------------------------
 * PROCEDURAL NOISE (simplex-noise)
 * -----------------------------------------------------------------------------
 * A cached 4D simplex-noise generator per seed. setFromNoise4D builds a valid
 * unit quaternion from four noise samples (via the uniform hypersphere
 * mapping) and writes the corresponding rotation matrix into `out`. The 4th
 * noise coordinate is exposed so callers can animate the field over time.
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

const _noise4DCache = new Map();

function _cachedNoise4D( seed ) {
  let gen = _noise4DCache.get( seed );
  if ( gen === undefined ) {
    gen = createNoise4D( _mulberry32( seed ) );
    _noise4DCache.set( seed, gen );
  }
  return gen;
}

// Set out to a rotation matrix whose axis/angle is derived from a 4D simplex
// field sampled at (x, y, z, w). The `w` coordinate is typically time, so the
// same (x, y, z) can animate smoothly. An optional uniform scale multiplies
// the top-left 3x3 block.
export function setFromNoise4D( out, x, y, z, w, seed = 0, scale = 1 ) {
  const n = _cachedNoise4D( seed );
  const u1 = ( n( x, y, z, w ) + 1 ) * 0.5;
  const u2 = ( n( x + 31.416, y + 47.853, z + 12.793, w + 9.211 ) + 1 ) * 0.5;
  const u3 = ( n( x - 17.234, y - 53.127, z - 91.056, w - 4.742 ) + 1 ) * 0.5;

  // Uniform unit quaternion from three independent uniforms.
  const sqrt1u1 = Math.sqrt( 1 - u1 );
  const sqrtu1 = Math.sqrt( u1 );
  const u2twopi = 2 * Math.PI * u2;
  const u3twopi = 2 * Math.PI * u3;
  const qx = sqrt1u1 * Math.cos( u2twopi );
  const qy = sqrtu1 * Math.sin( u3twopi );
  const qz = sqrtu1 * Math.cos( u3twopi );
  const qw = sqrt1u1 * Math.sin( u2twopi );

  // Build rotation matrix from quaternion, scaled by `scale`.
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;

  const e = out.elements;
  e[ 0 ] = ( 1 - ( yy + zz ) ) * scale;
  e[ 1 ] = ( xy + wz ) * scale;
  e[ 2 ] = ( xz - wy ) * scale;
  e[ 3 ] = 0;
  e[ 4 ] = ( xy - wz ) * scale;
  e[ 5 ] = ( 1 - ( xx + zz ) ) * scale;
  e[ 6 ] = ( yz + wx ) * scale;
  e[ 7 ] = 0;
  e[ 8 ] = ( xz + wy ) * scale;
  e[ 9 ] = ( yz - wx ) * scale;
  e[ 10 ] = ( 1 - ( xx + yy ) ) * scale;
  e[ 11 ] = 0;
  e[ 12 ] = 0;
  e[ 13 ] = 0;
  e[ 14 ] = 0;
  e[ 15 ] = 1;
  return out;
}

// Drop every cached noise generator.
export function disposeNoise4DCache() {
  _noise4DCache.clear();
}

// Module-local scratch buffers — reused by every bridge, never allocated per call.
const _scratchMat4A = new Float32Array( 16 );
const _scratchMat4B = new Float32Array( 16 );
const _scratchQuat = new Float32Array( 4 );
const _scratchVec3 = new Float32Array( 3 );
const _scratchVec3B = new Float32Array( 3 );
const _scratchVec3C = new Float32Array( 3 );

/*
 * -----------------------------------------------------------------------------
 * THREE.Matrix4
 * -----------------------------------------------------------------------------
 */
class Matrix4 {

  constructor() {
    Matrix4.prototype.isMatrix4 = true;
    this.elements = [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ];
    if ( arguments.length > 0 ) {
      console.error( 'THREE.Matrix4: the constructor no longer reads arguments. use .set() instead.' );
    }
  }

  set( n11, n12, n13, n14, n21, n22, n23, n24, n31, n32, n33, n34, n41, n42, n43, n44 ) {
    const te = this.elements;
    te[ 0 ] = n11; te[ 4 ] = n12; te[ 8 ] = n13; te[ 12 ] = n14;
    te[ 1 ] = n21; te[ 5 ] = n22; te[ 9 ] = n23; te[ 13 ] = n24;
    te[ 2 ] = n31; te[ 6 ] = n32; te[ 10 ] = n33; te[ 14 ] = n34;
    te[ 3 ] = n41; te[ 7 ] = n42; te[ 11 ] = n43; te[ 15 ] = n44;
    return this;
  }

  identity() {
    this.set(
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    );
    return this;
  }

  clone() {
    return new Matrix4().fromArray( this.elements );
  }

  copy( m ) {
    const te = this.elements;
    const me = m.elements;
    te[ 0 ] = me[ 0 ]; te[ 1 ] = me[ 1 ]; te[ 2 ] = me[ 2 ]; te[ 3 ] = me[ 3 ];
    te[ 4 ] = me[ 4 ]; te[ 5 ] = me[ 5 ]; te[ 6 ] = me[ 6 ]; te[ 7 ] = me[ 7 ];
    te[ 8 ] = me[ 8 ]; te[ 9 ] = me[ 9 ]; te[ 10 ] = me[ 10 ]; te[ 11 ] = me[ 11 ];
    te[ 12 ] = me[ 12 ]; te[ 13 ] = me[ 13 ]; te[ 14 ] = me[ 14 ]; te[ 15 ] = me[ 15 ];
    return this;
  }

  copyPosition( m ) {
    const te = this.elements, me = m.elements;
    te[ 12 ] = me[ 12 ];
    te[ 13 ] = me[ 13 ];
    te[ 14 ] = me[ 14 ];
    return this;
  }

  setFromMatrix3( m ) {
    const me = m.elements;
    this.set(
      me[ 0 ], me[ 3 ], me[ 6 ], 0,
      me[ 1 ], me[ 4 ], me[ 7 ], 0,
      me[ 2 ], me[ 5 ], me[ 8 ], 0,
      0, 0, 0, 1
    );
    return this;
  }

  extractBasis( xAxis, yAxis, zAxis ) {
    xAxis.setFromMatrixColumn( this, 0 );
    yAxis.setFromMatrixColumn( this, 1 );
    zAxis.setFromMatrixColumn( this, 2 );
    return this;
  }

  makeBasis( xAxis, yAxis, zAxis ) {
    this.set(
      xAxis.x, yAxis.x, zAxis.x, 0,
      xAxis.y, yAxis.y, zAxis.y, 0,
      xAxis.z, yAxis.z, zAxis.z, 0,
      0, 0, 0, 1
    );
    return this;
  }

  extractRotation( m ) {
    const te = this.elements;
    const me = m.elements;
    const scaleX = 1 / _v1.setFromMatrixColumn( m, 0 ).length();
    const scaleY = 1 / _v1.setFromMatrixColumn( m, 1 ).length();
    const scaleZ = 1 / _v1.setFromMatrixColumn( m, 2 ).length();
    te[ 0 ] = me[ 0 ] * scaleX;
    te[ 1 ] = me[ 1 ] * scaleX;
    te[ 2 ] = me[ 2 ] * scaleX;
    te[ 3 ] = 0;
    te[ 4 ] = me[ 4 ] * scaleY;
    te[ 5 ] = me[ 5 ] * scaleY;
    te[ 6 ] = me[ 6 ] * scaleY;
    te[ 7 ] = 0;
    te[ 8 ] = me[ 8 ] * scaleZ;
    te[ 9 ] = me[ 9 ] * scaleZ;
    te[ 10 ] = me[ 10 ] * scaleZ;
    te[ 11 ] = 0;
    te[ 12 ] = 0;
    te[ 13 ] = 0;
    te[ 14 ] = 0;
    te[ 15 ] = 1;
    return this;
  }

  makeRotationFromEuler( euler ) {
    const te = this.elements;
    const x = euler.x, y = euler.y, z = euler.z;
    const a = Math.cos( x ), b = Math.sin( x );
    const c = Math.cos( y ), d = Math.sin( y );
    const e = Math.cos( z ), f = Math.sin( z );
    if ( euler.order === 'XYZ' ) {
      const ae = a * e, af = a * f, be = b * e, bf = b * f;
      te[ 0 ] = c * e;
      te[ 4 ] = - c * f;
      te[ 8 ] = d;
      te[ 1 ] = af + be * d;
      te[ 5 ] = ae - bf * d;
      te[ 9 ] = - b * c;
      te[ 2 ] = bf - ae * d;
      te[ 6 ] = be + af * d;
      te[ 10 ] = a * c;
    } else if ( euler.order === 'YXZ' ) {
      const ce = c * e, cf = c * f, de = d * e, df = d * f;
      te[ 0 ] = ce + df * b;
      te[ 4 ] = de * b - cf;
      te[ 8 ] = a * d;
      te[ 1 ] = a * f;
      te[ 5 ] = a * e;
      te[ 9 ] = - b;
      te[ 2 ] = cf * b - de;
      te[ 6 ] = df + ce * b;
      te[ 10 ] = a * c;
    } else if ( euler.order === 'ZXY' ) {
      const ce = c * e, cf = c * f, de = d * e, df = d * f;
      te[ 0 ] = ce - df * b;
      te[ 4 ] = - a * f;
      te[ 8 ] = de + cf * b;
      te[ 1 ] = cf + de * b;
      te[ 5 ] = a * e;
      te[ 9 ] = df - ce * b;
      te[ 2 ] = - a * d;
      te[ 6 ] = b;
      te[ 10 ] = a * c;
    } else if ( euler.order === 'ZYX' ) {
      const ae = a * e, af = a * f, be = b * e, bf = b * f;
      te[ 0 ] = c * e;
      te[ 4 ] = be * d - af;
      te[ 8 ] = ae * d + bf;
      te[ 1 ] = c * f;
      te[ 5 ] = bf * d + ae;
      te[ 9 ] = af * d - be;
      te[ 2 ] = - d;
      te[ 6 ] = b * c;
      te[ 10 ] = a * c;
    } else if ( euler.order === 'YZX' ) {
      const ac = a * c, ad = a * d, bc = b * c, bd = b * d;
      te[ 0 ] = c * e;
      te[ 4 ] = bd - ac * f;
      te[ 8 ] = bc * f + ad;
      te[ 1 ] = f;
      te[ 5 ] = a * e;
      te[ 9 ] = - b * e;
      te[ 2 ] = - d * e;
      te[ 6 ] = ad * f + bc;
      te[ 10 ] = ac - bd * f;
    } else if ( euler.order === 'XZY' ) {
      const ac = a * c, ad = a * d, bc = b * c, bd = b * d;
      te[ 0 ] = c * e;
      te[ 4 ] = - f;
      te[ 8 ] = d * e;
      te[ 1 ] = ac * f + bd;
      te[ 5 ] = a * e;
      te[ 9 ] = ad * f - bc;
      te[ 2 ] = bc * f - ad;
      te[ 6 ] = b * e;
      te[ 10 ] = bd * f + ac;
    }
    te[ 3 ] = 0;
    te[ 7 ] = 0;
    te[ 11 ] = 0;
    te[ 12 ] = 0;
    te[ 13 ] = 0;
    te[ 14 ] = 0;
    te[ 15 ] = 1;
    return this;
  }

  makeRotationFromQuaternion( q ) {
    return this.compose( _zero, q, _one );
  }

  lookAt( eye, target, up ) {
    const te = this.elements;
    _z.subVectors( eye, target );
    if ( _z.lengthSq() === 0 ) {
      _z.z = 1;
    }
    _z.normalize();
    _x.crossVectors( up, _z );
    if ( _x.lengthSq() === 0 ) {
      if ( Math.abs( up.z ) === 1 ) {
        _z.x += 0.0001;
      } else {
        _z.z += 0.0001;
      }
      _z.normalize();
      _x.crossVectors( up, _z );
    }
    _x.normalize();
    _y.crossVectors( _z, _x );
    te[ 0 ] = _x.x; te[ 4 ] = _y.x; te[ 8 ] = _z.x;
    te[ 1 ] = _x.y; te[ 5 ] = _y.y; te[ 9 ] = _z.y;
    te[ 2 ] = _x.z; te[ 6 ] = _y.z; te[ 10 ] = _z.z;
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
    const a11 = ae[ 0 ], a12 = ae[ 4 ], a13 = ae[ 8 ], a14 = ae[ 12 ];
    const a21 = ae[ 1 ], a22 = ae[ 5 ], a23 = ae[ 9 ], a24 = ae[ 13 ];
    const a31 = ae[ 2 ], a32 = ae[ 6 ], a33 = ae[ 10 ], a34 = ae[ 14 ];
    const a41 = ae[ 3 ], a42 = ae[ 7 ], a43 = ae[ 11 ], a44 = ae[ 15 ];
    const b11 = be[ 0 ], b12 = be[ 4 ], b13 = be[ 8 ], b14 = be[ 12 ];
    const b21 = be[ 1 ], b22 = be[ 5 ], b23 = be[ 9 ], b24 = be[ 13 ];
    const b31 = be[ 2 ], b32 = be[ 6 ], b33 = be[ 10 ], b34 = be[ 14 ];
    const b41 = be[ 3 ], b42 = be[ 7 ], b43 = be[ 11 ], b44 = be[ 15 ];
    te[ 0 ] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
    te[ 4 ] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
    te[ 8 ] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
    te[ 12 ] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;
    te[ 1 ] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
    te[ 5 ] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
    te[ 9 ] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
    te[ 13 ] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;
    te[ 2 ] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
    te[ 6 ] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
    te[ 10 ] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
    te[ 14 ] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;
    te[ 3 ] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
    te[ 7 ] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
    te[ 11 ] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
    te[ 15 ] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;
    return this;
  }

  multiplyScalar( s ) {
    const te = this.elements;
    te[ 0 ] *= s; te[ 4 ] *= s; te[ 8 ] *= s; te[ 12 ] *= s;
    te[ 1 ] *= s; te[ 5 ] *= s; te[ 9 ] *= s; te[ 13 ] *= s;
    te[ 2 ] *= s; te[ 6 ] *= s; te[ 10 ] *= s; te[ 14 ] *= s;
    te[ 3 ] *= s; te[ 7 ] *= s; te[ 11 ] *= s; te[ 15 ] *= s;
    return this;
  }

  determinant() {
    const te = this.elements;
    const n11 = te[ 0 ], n21 = te[ 1 ], n31 = te[ 2 ], n41 = te[ 3 ];
    const n12 = te[ 4 ], n22 = te[ 5 ], n32 = te[ 6 ], n42 = te[ 7 ];
    const n13 = te[ 8 ], n23 = te[ 9 ], n33 = te[ 10 ], n43 = te[ 11 ];
    const n14 = te[ 12 ], n24 = te[ 13 ], n34 = te[ 14 ], n44 = te[ 15 ];
    const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
    const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
    const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
    const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;
    return n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
  }

  determinantAffine() {
    const te = this.elements;
    const n11 = te[ 0 ], n21 = te[ 1 ], n31 = te[ 2 ];
    const n12 = te[ 4 ], n22 = te[ 5 ], n32 = te[ 6 ];
    const n13 = te[ 8 ], n23 = te[ 9 ], n33 = te[ 10 ];
    return n11 * ( n22 * n33 - n23 * n32 ) -
      n12 * ( n21 * n33 - n23 * n31 ) +
      n13 * ( n21 * n32 - n22 * n31 );
  }

  transpose() {
    const te = this.elements;
    let tmp;
    tmp = te[ 1 ]; te[ 1 ] = te[ 4 ]; te[ 4 ] = tmp;
    tmp = te[ 2 ]; te[ 2 ] = te[ 8 ]; te[ 8 ] = tmp;
    tmp = te[ 6 ]; te[ 6 ] = te[ 9 ]; te[ 9 ] = tmp;
    tmp = te[ 3 ]; te[ 3 ] = te[ 12 ]; te[ 12 ] = tmp;
    tmp = te[ 7 ]; te[ 7 ] = te[ 13 ]; te[ 13 ] = tmp;
    tmp = te[ 11 ]; te[ 11 ] = te[ 14 ]; te[ 14 ] = tmp;
    return this;
  }

  setPosition( x, y, z ) {
    const te = this.elements;
    if ( x.isVector3 ) {
      te[ 12 ] = x.x; te[ 13 ] = x.y; te[ 14 ] = x.z;
    } else {
      te[ 12 ] = x; te[ 13 ] = y; te[ 14 ] = z;
    }
    return this;
  }

  invert() {
    const te = this.elements,
      n11 = te[ 0 ], n21 = te[ 1 ], n31 = te[ 2 ], n41 = te[ 3 ],
      n12 = te[ 4 ], n22 = te[ 5 ], n32 = te[ 6 ], n42 = te[ 7 ],
      n13 = te[ 8 ], n23 = te[ 9 ], n33 = te[ 10 ], n43 = te[ 11 ],
      n14 = te[ 12 ], n24 = te[ 13 ], n34 = te[ 14 ], n44 = te[ 15 ],
      t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44,
      t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44,
      t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44,
      t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;
    const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
    if ( det === 0 ) return this.set( 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 );
    const detInv = 1 / det;
    te[ 0 ] = t11 * detInv;
    te[ 1 ] = ( n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44 ) * detInv;
    te[ 2 ] = ( n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44 ) * detInv;
    te[ 3 ] = ( n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43 ) * detInv;
    te[ 4 ] = t12 * detInv;
    te[ 5 ] = ( n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44 ) * detInv;
    te[ 6 ] = ( n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44 ) * detInv;
    te[ 7 ] = ( n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43 ) * detInv;
    te[ 8 ] = t13 * detInv;
    te[ 9 ] = ( n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44 ) * detInv;
    te[ 10 ] = ( n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44 ) * detInv;
    te[ 11 ] = ( n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43 ) * detInv;
    te[ 12 ] = t14 * detInv;
    te[ 13 ] = ( n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34 ) * detInv;
    te[ 14 ] = ( n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34 ) * detInv;
    te[ 15 ] = ( n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33 ) * detInv;
    return this;
  }

  scale( v ) {
    const te = this.elements;
    const x = v.x, y = v.y, z = v.z;
    te[ 0 ] *= x; te[ 4 ] *= y; te[ 8 ] *= z;
    te[ 1 ] *= x; te[ 5 ] *= y; te[ 9 ] *= z;
    te[ 2 ] *= x; te[ 6 ] *= y; te[ 10 ] *= z;
    te[ 3 ] *= x; te[ 7 ] *= y; te[ 11 ] *= z;
    return this;
  }

  getMaxScaleOnAxis() {
    const te = this.elements;
    const scaleXSq = te[ 0 ] * te[ 0 ] + te[ 1 ] * te[ 1 ] + te[ 2 ] * te[ 2 ];
    const scaleYSq = te[ 4 ] * te[ 4 ] + te[ 5 ] * te[ 5 ] + te[ 6 ] * te[ 6 ];
    const scaleZSq = te[ 8 ] * te[ 8 ] + te[ 9 ] * te[ 9 ] + te[ 10 ] * te[ 10 ];
    return Math.sqrt( Math.max( scaleXSq, scaleYSq, scaleZSq ) );
  }

  makeTranslation( x, y, z ) {
    if ( x.isVector3 ) {
      this.set(
        1, 0, 0, x.x,
        0, 1, 0, x.y,
        0, 0, 1, x.z,
        0, 0, 0, 1
      );
    } else {
      this.set(
        1, 0, 0, x,
        0, 1, 0, y,
        0, 0, 1, z,
        0, 0, 0, 1
      );
    }
    return this;
  }

  makeRotationX( theta ) {
    const c = Math.cos( theta ), s = Math.sin( theta );
    this.set(
      1, 0, 0, 0,
      0, c, - s, 0,
      0, s, c, 0,
      0, 0, 0, 1
    );
    return this;
  }

  makeRotationY( theta ) {
    const c = Math.cos( theta ), s = Math.sin( theta );
    this.set(
      c, 0, s, 0,
      0, 1, 0, 0,
      - s, 0, c, 0,
      0, 0, 0, 1
    );
    return this;
  }

  makeRotationZ( theta ) {
    const c = Math.cos( theta ), s = Math.sin( theta );
    this.set(
      c, - s, 0, 0,
      s, c, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    );
    return this;
  }

  makeRotationAxis( axis, angle ) {
    const c = Math.cos( angle );
    const s = Math.sin( angle );
    const t = 1 - c;
    const x = axis.x, y = axis.y, z = axis.z;
    const tx = t * x, ty = t * y;
    this.set(
      tx * x + c, tx * y - s * z, tx * z + s * y, 0,
      tx * y + s * z, ty * y + c, ty * z - s * x, 0,
      tx * z - s * y, ty * z + s * x, t * z * z + c, 0,
      0, 0, 0, 1
    );
    return this;
  }

  makeScale( x, y, z ) {
    this.set(
      x, 0, 0, 0,
      0, y, 0, 0,
      0, 0, z, 0,
      0, 0, 0, 1
    );
    return this;
  }

  makeShear( xy, xz, yx, yz, zx, zy ) {
    this.set(
      1, yx, zx, 0,
      xy, 1, zy, 0,
      xz, yz, 1, 0,
      0, 0, 0, 1
    );
    return this;
  }

  compose( position, quaternion, scale ) {
    const te = this.elements;
    const x = quaternion._x, y = quaternion._y, z = quaternion._z, w = quaternion._w;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const sx = scale.x, sy = scale.y, sz = scale.z;
    te[ 0 ] = ( 1 - ( yy + zz ) ) * sx;
    te[ 1 ] = ( xy + wz ) * sx;
    te[ 2 ] = ( xz - wy ) * sx;
    te[ 3 ] = 0;
    te[ 4 ] = ( xy - wz ) * sy;
    te[ 5 ] = ( 1 - ( xx + zz ) ) * sy;
    te[ 6 ] = ( yz + wx ) * sy;
    te[ 7 ] = 0;
    te[ 8 ] = ( xz + wy ) * sz;
    te[ 9 ] = ( yz - wx ) * sz;
    te[ 10 ] = ( 1 - ( xx + yy ) ) * sz;
    te[ 11 ] = 0;
    te[ 12 ] = position.x;
    te[ 13 ] = position.y;
    te[ 14 ] = position.z;
    te[ 15 ] = 1;
    return this;
  }

  decompose( position, quaternion, scale ) {
    const te = this.elements;
    let sx = _v1.set( te[ 0 ], te[ 1 ], te[ 2 ] ).length();
    const sy = _v1.set( te[ 4 ], te[ 5 ], te[ 6 ] ).length();
    const sz = _v1.set( te[ 8 ], te[ 9 ], te[ 10 ] ).length();
    if ( this.determinant() < 0 ) sx = - sx;
    position.x = te[ 12 ];
    position.y = te[ 13 ];
    position.z = te[ 14 ];
    _m1.copy( this );
    const invSX = 1 / sx;
    const invSY = 1 / sy;
    const invSZ = 1 / sz;
    _m1.elements[ 0 ] *= invSX;
    _m1.elements[ 1 ] *= invSX;
    _m1.elements[ 2 ] *= invSX;
    _m1.elements[ 4 ] *= invSY;
    _m1.elements[ 5 ] *= invSY;
    _m1.elements[ 6 ] *= invSY;
    _m1.elements[ 8 ] *= invSZ;
    _m1.elements[ 9 ] *= invSZ;
    _m1.elements[ 10 ] *= invSZ;
    quaternion.setFromRotationMatrix( _m1 );
    scale.x = sx;
    scale.y = sy;
    scale.z = sz;
    return this;
  }

  makePerspective( left, right, top, bottom, near, far, coordinateSystem = WebGLCoordinateSystem ) {
    const te = this.elements;
    const x = 2 * near / ( right - left );
    const y = 2 * near / ( top - bottom );
    const a = ( right + left ) / ( right - left );
    const b = ( top + bottom ) / ( top - bottom );
    let c, d;
    if ( coordinateSystem === WebGLCoordinateSystem ) {
      c = - ( far + near ) / ( far - near );
      d = ( - 2 * far * near ) / ( far - near );
    } else if ( coordinateSystem === WebGPUCoordinateSystem ) {
      c = - far / ( far - near );
      d = ( - far * near ) / ( far - near );
    } else {
      throw new Error( 'THREE.Matrix4.makePerspective(): Invalid coordinate system: ' + coordinateSystem );
    }
    te[ 0 ] = x; te[ 4 ] = 0; te[ 8 ] = a; te[ 12 ] = 0;
    te[ 1 ] = 0; te[ 5 ] = y; te[ 9 ] = b; te[ 13 ] = 0;
    te[ 2 ] = 0; te[ 6 ] = 0; te[ 10 ] = c; te[ 14 ] = d;
    te[ 3 ] = 0; te[ 7 ] = 0; te[ 11 ] = - 1; te[ 15 ] = 0;
    return this;
  }

  makeOrthographic( left, right, top, bottom, near, far, coordinateSystem = WebGLCoordinateSystem ) {
    const te = this.elements;
    const w = 1.0 / ( right - left );
    const h = 1.0 / ( top - bottom );
    const p = 1.0 / ( far - near );
    const x = ( right + left ) * w;
    const y = ( top + bottom ) * h;
    let z, zInv;
    if ( coordinateSystem === WebGLCoordinateSystem ) {
      z = ( far + near ) * p;
      zInv = - 2 * p;
    } else if ( coordinateSystem === WebGPUCoordinateSystem ) {
      z = near * p;
      zInv = - 1 * p;
    } else {
      throw new Error( 'THREE.Matrix4.makeOrthographic(): Invalid coordinate system: ' + coordinateSystem );
    }
    te[ 0 ] = 2 * w; te[ 4 ] = 0; te[ 8 ] = 0; te[ 12 ] = - x;
    te[ 1 ] = 0; te[ 5 ] = 2 * h; te[ 9 ] = 0; te[ 13 ] = - y;
    te[ 2 ] = 0; te[ 6 ] = 0; te[ 10 ] = zInv; te[ 14 ] = - z;
    te[ 3 ] = 0; te[ 7 ] = 0; te[ 11 ] = 0; te[ 15 ] = 1;
    return this;
  }

  equals( matrix ) {
    const te = this.elements;
    const me = matrix.elements;
    for ( let i = 0; i < 16; i ++ ) {
      if ( te[ i ] !== me[ i ] ) return false;
    }
    return true;
  }

  fromArray( array, offset = 0 ) {
    for ( let i = 0; i < 16; i ++ ) {
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
    array[ offset + 9 ] = te[ 9 ];
    array[ offset + 10 ] = te[ 10 ];
    array[ offset + 11 ] = te[ 11 ];
    array[ offset + 12 ] = te[ 12 ];
    array[ offset + 13 ] = te[ 13 ];
    array[ offset + 14 ] = te[ 14 ];
    array[ offset + 15 ] = te[ 15 ];
    return array;
  }

}

const _v1 = /*@__PURE__*/ new Vector3();
const _m1 = /*@__PURE__*/ new Matrix4();
const _zero = /*@__PURE__*/ new Vector3( 0, 0, 0 );
const _one = /*@__PURE__*/ new Vector3( 1, 1, 1 );
const _x = /*@__PURE__*/ new Vector3();
const _y = /*@__PURE__*/ new Vector3();
const _z = /*@__PURE__*/ new Vector3();

// Default export for parity with other Matrix classes in this module.
export default Matrix4;
export { Matrix4 };