// file number : 044
// full path name : src/math/047_MatrixDCUtil.js
// description : High-performance utility functions for matrix decompositions reimplemented from mljs/matrix dc/util.js. Provides in-place square-matrix transpose (`transposeSquareInPlace`) and the numerically stable `hypotenuse` function used by QR, SVD, EVD, and Cholesky. Fully integrated with the flat typed array backing of MLMatrix (038) and supports DoubleDouble precision.
// best for : Cache-friendly in-place transpose for square matrices, numerically stable 2-norm computations in decompositions, and any matrix pipeline that needs these primitives at 10k+ entity scale on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS } from '../core/002_Constants.js';
import * as DD from './014_DoubleDouble.js';
import * as ML from './038_MatrixML.js';

// ============================================================================
// UTILITIES
// ============================================================================

export function transposeSquareInPlace(matrix) {
  if (!(matrix instanceof ML.MLMatrix)) throw new Error('Matrix instance required');
  if (matrix.rows !== matrix.columns) throw new Error('Matrix must be square');
  const data = matrix.data;
  const n = matrix.rows;
  if (matrix.dd) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = (i * n + j) * 2;
        const b = (j * n + i) * 2;
        const t0 = data[a], t1 = data[a + 1];
        data[a] = data[b]; data[a + 1] = data[b + 1];
        data[b] = t0; data[b + 1] = t1;
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const t = data[i * n + j];
        data[i * n + j] = data[j * n + i];
        data[j * n + i] = t;
      }
    }
  }
  return matrix;
}

export function hypotenuse(a, b) {
  let r = 0;
  if (Math.abs(a) > Math.abs(b)) {
    r = b / a;
    return Math.abs(a) * Math.sqrt(1 + r * r);
  }
  if (b !== 0) {
    r = a / b;
    return Math.abs(b) * Math.sqrt(1 + r * r);
  }
  return 0;
}

export function hypotenuse3(a, b, c) {
  let r = 0;
  if (Math.abs(a) > Math.abs(b)) {
    if (Math.abs(a) > Math.abs(c)) {
      r = Math.sqrt(1 + (b / a) ** 2 + (c / a) ** 2);
      return Math.abs(a) * r;
    }
    r = Math.sqrt((a / c) ** 2 + (b / c) ** 2 + 1);
    return Math.abs(c) * r;
  }
  if (Math.abs(b) > Math.abs(c)) {
    r = Math.sqrt((a / b) ** 2 + 1 + (c / b) ** 2);
    return Math.abs(b) * r;
  }
  r = Math.sqrt((a / c) ** 2 + (b / c) ** 2 + 1);
  return Math.abs(c) * r;
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default {
  transposeSquareInPlace,
  hypotenuse,
  hypotenuse3
};