// file number : 027
// full path name : src/math/027_LinearAlgebra.js
// description : High-performance Linear Algebra module rewritten from @scenesystems/effect-math LinearAlgebra without the Effect dependency. Provides dense matrix type (row-major Float64Array), basic vector ops (dot, cross, norm, normalize, project, reflect), matrix ops (multiply, transpose, add, subtract, scale, trace, frobenius), decompositions (LU with partial pivoting, QR Householder, Cholesky, SVD via one-sided Jacobi, symmetric eigendecomposition via cyclic Jacobi, general eigenvalues via QR iteration), solvers (linear system, least squares, pseudo-inverse), norms and condition numbers (1-norm, inf-norm, 2-norm, Frobenius, cond), rank and null space via rank-revealing QR, matrix log/exp/sqrt via eigendecomposition, polynomial characteristic coefficients via Faddeev-LeVerrier, and DoubleDouble high-precision variants (ddDot, ddMatVec, ddDet, ddSolve) for galactic-scale numerics. Includes schema validators (VectorInput, MatrixInput, SolveInput, DecomposeInput, LeastSquaresInput, NormInput, RankInput) with strict/relaxed policy wrappers. Pooled scratch buffers for zero-allocation hot paths. Integrated with 002_Constants (PRECISION), 003_Common (EPSILON, ARRAY_TYPE), 006_Vec3, 007_Vec4, 009_Mat3, 010_Mat4, 014_DoubleDouble, and 021_Backend.
// best for : Rigid body dynamics, constraint solvers, IK chains, camera calibration, PBR tangent-space basis, SVD for procedural mesh analysis, PCA on vertex data, least-squares fits, physics shape analysis, and any heavy linear-algebra subsystem at 10k+ entity scale on Android 64-bit.
// license : MIT

import { EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS } from '../core/002_Constants.js';
import * as DD from './014_DoubleDouble.js';
import * as vec3 from './006_Vec3.js';
import * as vec4 from './007_Vec4.js';
import * as mat3 from './009_Mat3.js';
import * as mat4 from './010_Mat4.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'LinearAlgebraDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'LinearAlgebraDomainViolationError';
    this.operation = operation;
  }
}

// ============================================================================
// POLICY
// ============================================================================
const DEFAULT_POLICY = Object.freeze({
  precision: 'strict',
  diagnostics: 'disabled'
});

function resolvePolicy(policy) {
  if (!policy) return DEFAULT_POLICY;
  return {
    precision: policy.precision === 'relaxed' ? 'relaxed' : 'strict',
    diagnostics: policy.diagnostics === 'enabled' ? 'enabled' : 'disabled'
  };
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isFiniteArray(arr) {
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) return false;
  }
  return true;
}

function policyScalar(operation, compute, makeError, annotate, policy) {
  const p = resolvePolicy(policy);
  const t0 = p.diagnostics === 'enabled' && typeof performance !== 'undefined' ? performance.now() : 0;
  const result = compute();
  if (p.precision === 'strict' && !isFiniteNumber(result)) {
    throw makeError('strict precision rejected non-finite result');
  }
  if (p.diagnostics === 'enabled') {
    const dt = typeof performance !== 'undefined' ? performance.now() - t0 : 0;
    const info = annotate ? annotate(result) : {};
    info.precision = p.precision;
    info.elapsedMs = dt;
    // eslint-disable-next-line no-console
    console.log(`[${operation}]`, info);
  }
  return result;
}

function policyCustom(operation, compute, isValid, makeError, annotate, policy) {
  const p = resolvePolicy(policy);
  const t0 = p.diagnostics === 'enabled' && typeof performance !== 'undefined' ? performance.now() : 0;
  const result = compute();
  if (p.precision === 'strict' && !isValid(result)) {
    throw makeError('strict precision rejected invalid result');
  }
  if (p.diagnostics === 'enabled') {
    const dt = typeof performance !== 'undefined' ? performance.now() - t0 : 0;
    const info = annotate ? annotate(result) : {};
    info.precision = p.precision;
    info.elapsedMs = dt;
    // eslint-disable-next-line no-console
    console.log(`[${operation}]`, info);
  }
  return result;
}

// ============================================================================
// DENSE MATRIX (row-major)
// ============================================================================
const F64 = typeof Float64Array !== 'undefined' ? Float64Array : Array;

export function Matrix(rows, cols, data) {
  this.rows = rows;
  this.cols = cols;
  this.data = data || new F64(rows * cols);
}

export function matrixCreate(rows, cols) {
  return new Matrix(rows, cols, new F64(rows * cols));
}

export function matrixFromArray(rows, cols, arr) {
  if (arr.length !== rows * cols) throw new DecodeError('matrix', 'data length mismatch');
  const m = new Matrix(rows, cols, new F64(rows * cols));
  for (let i = 0; i < arr.length; i++) m.data[i] = arr[i];
  return m;
}

export function matrixIdentity(n) {
  const m = matrixCreate(n, n);
  for (let i = 0; i < n; i++) m.data[i * n + i] = 1;
  return m;
}

export function matrixClone(m) {
  return new Matrix(m.rows, m.cols, new F64(m.data));
}

export function matrixGet(m, i, j) {
  return m.data[i * m.cols + j];
}

export function matrixSet(m, i, j, v) {
  m.data[i * m.cols + j] = v;
  return m;
}

// ============================================================================
// MATRIX OPERATIONS
// ============================================================================

export function matrixAdd(a, b) {
  if (a.rows !== b.rows || a.cols !== b.cols) throw new DomainViolationError('matrixAdd', 'shape mismatch');
  const out = matrixCreate(a.rows, a.cols);
  for (let i = 0; i < a.data.length; i++) out.data[i] = a.data[i] + b.data[i];
  return out;
}

export function matrixSubtract(a, b) {
  if (a.rows !== b.rows || a.cols !== b.cols) throw new DomainViolationError('matrixSubtract', 'shape mismatch');
  const out = matrixCreate(a.rows, a.cols);
  for (let i = 0; i < a.data.length; i++) out.data[i] = a.data[i] - b.data[i];
  return out;
}

export function matrixScale(a, s) {
  const out = matrixCreate(a.rows, a.cols);
  for (let i = 0; i < a.data.length; i++) out.data[i] = a.data[i] * s;
  return out;
}

export function matrixMultiply(a, b) {
  if (a.cols !== b.rows) throw new DomainViolationError('matrixMultiply', 'inner dim mismatch');
  const n = a.rows;
  const m = b.cols;
  const k = a.cols;
  const out = matrixCreate(n, m);
  const ad = a.data;
  const bd = b.data;
  const od = out.data;
  for (let i = 0; i < n; i++) {
    const ai = i * k;
    const oi = i * m;
    for (let j = 0; j < m; j++) od[oi + j] = 0;
    for (let kk = 0; kk < k; kk++) {
      const aik = ad[ai + kk];
      if (aik === 0) continue;
      const bk = kk * m;
      for (let j = 0; j < m; j++) od[oi + j] += aik * bd[bk + j];
    }
  }
  return out;
}

export function matrixTranspose(a) {
  const out = matrixCreate(a.cols, a.rows);
  for (let i = 0; i < a.rows; i++) {
    for (let j = 0; j < a.cols; j++) {
      out.data[j * a.rows + i] = a.data[i * a.cols + j];
    }
  }
  return out;
}

export function matrixTrace(a) {
  if (a.rows !== a.cols) throw new DomainViolationError('matrixTrace', 'square matrix required');
  let t = 0;
  for (let i = 0; i < a.rows; i++) t += a.data[i * a.cols + i];
  return t;
}

export function matrixFrobenius(a) {
  let s = 0;
  for (let i = 0; i < a.data.length; i++) s += a.data[i] * a.data[i];
  return Math.sqrt(s);
}

export function matrixSubmatrix(a, rowStart, rowEnd, colStart, colEnd) {
  const r = rowEnd - rowStart;
  const c = colEnd - colStart;
  const out = matrixCreate(r, c);
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      out.data[i * c + j] = a.data[(rowStart + i) * a.cols + (colStart + j)];
    }
  }
  return out;
}

export function matrixToArray(a) {
  const out = new Array(a.data.length);
  for (let i = 0; i < a.data.length; i++) out[i] = a.data[i];
  return out;
}

export function matrixFromVec3(v) {
  const m = matrixCreate(3, 1);
  m.data[0] = v[0];
  m.data[1] = v[1];
  m.data[2] = v[2];
  return m;
}

export function matrixFromVec4(v) {
  const m = matrixCreate(4, 1);
  m.data[0] = v[0];
  m.data[1] = v[1];
  m.data[2] = v[2];
  m.data[3] = v[3];
  return m;
}

export function matrixToVec3(v, m) {
  v[0] = m.data[0];
  v[1] = m.data[1];
  v[2] = m.data[2];
  return v;
}

export function matrixToVec4(v, m) {
  v[0] = m.data[0];
  v[1] = m.data[1];
  v[2] = m.data[2];
  v[3] = m.data[3];
  return v;
}

export function matrixFromMat3(m3) {
  const out = matrixCreate(3, 3);
  out.data[0] = m3[0]; out.data[1] = m3[3]; out.data[2] = m3[6];
  out.data[3] = m3[1]; out.data[4] = m3[4]; out.data[5] = m3[7];
  out.data[6] = m3[2]; out.data[7] = m3[5]; out.data[8] = m3[8];
  return out;
}

export function matrixFromMat4(m4) {
  const out = matrixCreate(4, 4);
  out.data[0] = m4[0];  out.data[1] = m4[4];  out.data[2] = m4[8];  out.data[3] = m4[12];
  out.data[4] = m4[1];  out.data[5] = m4[5];  out.data[6] = m4[9];  out.data[7] = m4[13];
  out.data[8] = m4[2];  out.data[9] = m4[6];  out.data[10] = m4[10]; out.data[11] = m4[14];
  out.data[12] = m4[3]; out.data[13] = m4[7]; out.data[14] = m4[11]; out.data[15] = m4[15];
  return out;
}

export function matrixToMat4(out4, m) {
  out4[0] = m.data[0];  out4[4] = m.data[1];  out4[8] = m.data[2];  out4[12] = m.data[3];
  out4[1] = m.data[4];  out4[5] = m.data[5];  out4[9] = m.data[6];  out4[13] = m.data[7];
  out4[2] = m.data[8];  out4[6] = m.data[9];  out4[10] = m.data[10]; out4[14] = m.data[11];
  out4[3] = m.data[12]; out4[7] = m.data[13]; out4[11] = m.data[14]; out4[15] = m.data[15];
  return out4;
}

// ============================================================================
// VECTOR OPS ON MATRIX COLUMNS
// ============================================================================

export function vectorDot(a, b) {
  const n = a.length;
  let acc = 0;
  for (let i = 0; i < n; i++) acc += a[i] * b[i];
  return acc;
}

export function vectorCross(out, a, b) {
  out[0] = a[1] * b[2] - a[2] * b[1];
  out[1] = a[2] * b[0] - a[0] * b[2];
  out[2] = a[0] * b[1] - a[1] * b[0];
  return out;
}

export function vectorNorm(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s);
}

export function vectorNormalize(out, a) {
  const n = vectorNorm(a);
  if (n === 0) {
    for (let i = 0; i < a.length; i++) out[i] = 0;
    return out;
  }
  const inv = 1 / n;
  for (let i = 0; i < a.length; i++) out[i] = a[i] * inv;
  return out;
}

export function vectorProject(out, a, b) {
  const bb = vectorDot(b, b);
  if (bb === 0) return null;
  const s = vectorDot(a, b) / bb;
  for (let i = 0; i < a.length; i++) out[i] = b[i] * s;
  return out;
}

export function vectorReflect(out, a, n) {
  const d = vectorDot(a, n);
  for (let i = 0; i < a.length; i++) out[i] = a[i] - 2 * d * n[i];
  return out;
}

// ============================================================================
// LU DECOMPOSITION (partial pivoting)
// ============================================================================

export function luDecompose(a) {
  if (a.rows !== a.cols) throw new DomainViolationError('luDecompose', 'square required');
  const n = a.rows;
  const LU = matrixClone(a);
  const piv = new Int32Array(n);
  for (let i = 0; i < n; i++) piv[i] = i;

  for (let k = 0; k < n; k++) {
    let maxVal = 0;
    let maxRow = k;
    for (let i = k; i < n; i++) {
      const v = Math.abs(LU.data[i * n + k]);
      if (v > maxVal) {
        maxVal = v;
        maxRow = i;
      }
    }
    if (maxVal < EPSILON) return null;
    if (maxRow !== k) {
      for (let j = 0; j < n; j++) {
        const tmp = LU.data[k * n + j];
        LU.data[k * n + j] = LU.data[maxRow * n + j];
        LU.data[maxRow * n + j] = tmp;
      }
      const tp = piv[k];
      piv[k] = piv[maxRow];
      piv[maxRow] = tp;
    }
    const pivot = LU.data[k * n + k];
    for (let i = k + 1; i < n; i++) {
      const f = LU.data[i * n + k] / pivot;
      LU.data[i * n + k] = f;
      for (let j = k + 1; j < n; j++) {
        LU.data[i * n + j] -= f * LU.data[k * n + j];
      }
    }
  }
  return { LU, piv };
}

export function luSolve(decomp, b) {
  const n = decomp.LU.rows;
  const { LU, piv } = decomp;
  const y = new F64(n);
  for (let i = 0; i < n; i++) y[i] = b[piv[i]];
  for (let i = 1; i < n; i++) {
    let acc = y[i];
    for (let j = 0; j < i; j++) acc -= LU.data[i * n + j] * y[j];
    y[i] = acc;
  }
  const x = new F64(n);
  for (let i = n - 1; i >= 0; i--) {
    let acc = y[i];
    for (let j = i + 1; j < n; j++) acc -= LU.data[i * n + j] * x[j];
    x[i] = acc / LU.data[i * n + i];
  }
  return x;
}

export function luDeterminant(decomp) {
  const n = decomp.LU.rows;
  let det = 1;
  let swaps = 0;
  for (let i = 0; i < n; i++) det *= decomp.LU.data[i * n + i];
  for (let i = 0; i < n; i++) if (decomp.piv[i] !== i) swaps++;
  return (swaps % 2 === 0) ? det : -det;
}

// ============================================================================
// QR DECOMPOSITION (Householder)
// ============================================================================

export function qrDecompose(a) {
  const m = a.rows;
  const n = a.cols;
  const Q = matrixIdentity(m);
  const R = matrixClone(a);
  const v = new F64(m);

  const minMN = Math.min(m, n);
  for (let k = 0; k < minMN; k++) {
    let norm = 0;
    for (let i = k; i < m; i++) norm += R.data[i * n + k] * R.data[i * n + k];
    norm = Math.sqrt(norm);
    if (norm < EPSILON) continue;
    const alpha = R.data[k * n + k] > 0 ? -norm : norm;
    for (let i = 0; i < m; i++) v[i] = 0;
    v[k] = R.data[k * n + k] - alpha;
    for (let i = k + 1; i < m; i++) v[i] = R.data[i * n + k];
    let vnorm = 0;
    for (let i = k; i < m; i++) vnorm += v[i] * v[i];
    if (vnorm < EPSILON * EPSILON) continue;
    vnorm = Math.sqrt(vnorm);
    const inv = 1 / vnorm;
    for (let i = k; i < m; i++) v[i] *= inv;

    for (let j = k; j < n; j++) {
      let dot = 0;
      for (let i = k; i < m; i++) dot += v[i] * R.data[i * n + j];
      for (let i = k; i < m; i++) R.data[i * n + j] -= 2 * dot * v[i];
    }
    for (let j = 0; j < m; j++) {
      let dot = 0;
      for (let i = k; i < m; i++) dot += v[i] * Q.data[j * m + i];
      for (let i = k; i < m; i++) Q.data[j * m + i] -= 2 * dot * v[i];
    }
  }

  return { Q: matrixTranspose(Q), R };
}

// ============================================================================
// CHOLESKY DECOMPOSITION
// ============================================================================

export function choleskyDecompose(a) {
  if (a.rows !== a.cols) throw new DomainViolationError('choleskyDecompose', 'square required');
  const n = a.rows;
  const L = matrixCreate(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) sum += L.data[i * n + k] * L.data[j * n + k];
      if (i === j) {
        const v = a.data[i * n + i] - sum;
        if (v <= 0) return null;
        L.data[i * n + j] = Math.sqrt(v);
      } else {
        L.data[i * n + j] = (a.data[i * n + j] - sum) / L.data[j * n + j];
      }
    }
  }
  return { L };
}

export function choleskySolve(decomp, b) {
  const n = decomp.L.rows;
  const L = decomp.L;
  const y = new F64(n);
  for (let i = 0; i < n; i++) {
    let acc = b[i];
    for (let j = 0; j < i; j++) acc -= L.data[i * n + j] * y[j];
    y[i] = acc / L.data[i * n + i];
  }
  const x = new F64(n);
  for (let i = n - 1; i >= 0; i--) {
    let acc = y[i];
    for (let j = i + 1; j < n; j++) acc -= L.data[j * n + i] * x[j];
    x[i] = acc / L.data[i * n + i];
  }
  return x;
}

// ============================================================================
// EIGENDECOMPOSITION (symmetric, cyclic Jacobi)
// ============================================================================

export function symmetricEigen(a, maxIter, tol) {
  if (a.rows !== a.cols) throw new DomainViolationError('symmetricEigen', 'square required');
  const n = a.rows;
  const A = matrixClone(a);
  const V = matrixIdentity(n);
  const mi = maxIter === undefined ? 100 : maxIter;
  const t = tol === undefined ? EPSILON * 100 : tol;

  for (let iter = 0; iter < mi; iter++) {
    let off = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) off += A.data[i * n + j] * A.data[i * n + j];
    }
    if (Math.sqrt(off) < t) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = A.data[p * n + q];
        if (Math.abs(apq) < t) continue;
        const app = A.data[p * n + p];
        const aqq = A.data[q * n + q];
        const theta = (aqq - app) / (2 * apq);
        const tSign = theta >= 0 ? 1 : -1;
        const tVal = tSign / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(tVal * tVal + 1);
        const s = tVal * c;

        for (let k = 0; k < n; k++) {
          const akp = A.data[k * n + p];
          const akq = A.data[k * n + q];
          A.data[k * n + p] = c * akp - s * akq;
          A.data[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A.data[p * n + k];
          const aqk = A.data[q * n + k];
          A.data[p * n + k] = c * apk - s * aqk;
          A.data[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V.data[k * n + p];
          const vkq = V.data[k * n + q];
          V.data[k * n + p] = c * vkp - s * vkq;
          V.data[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const values = new F64(n);
  for (let i = 0; i < n; i++) values[i] = A.data[i * n + i];
  return { values, vectors: V };
}

// ============================================================================
// SVD (one-sided Jacobi)
// ============================================================================

export function svdDecompose(a, maxIter, tol) {
  const m = a.rows;
  const n = a.cols;
  const A = matrixClone(a);
  const V = matrixIdentity(n);
  const mi = maxIter === undefined ? 100 : maxIter;
  const t = tol === undefined ? EPSILON * 100 : tol;

  for (let iter = 0; iter < mi; iter++) {
    let off = 0;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        let apq = 0, app = 0, aqq = 0;
        for (let i = 0; i < m; i++) {
          const aip = A.data[i * n + p];
          const aiq = A.data[i * n + q];
          app += aip * aip;
          aqq += aiq * aiq;
          apq += aip * aiq;
        }
        off += apq * apq;
        if (Math.abs(apq) < t * Math.sqrt(app * aqq)) continue;
        const tau = (aqq - app) / (2 * apq);
        const tSign = tau >= 0 ? 1 : -1;
        const tVal = tSign / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
        const c = 1 / Math.sqrt(1 + tVal * tVal);
        const s = c * tVal;
        for (let i = 0; i < m; i++) {
          const aip = A.data[i * n + p];
          const aiq = A.data[i * n + q];
          A.data[i * n + p] = c * aip - s * aiq;
          A.data[i * n + q] = s * aip + c * aiq;
        }
        for (let i = 0; i < n; i++) {
          const vip = V.data[i * n + p];
          const viq = V.data[i * n + q];
          V.data[i * n + p] = c * vip - s * viq;
          V.data[i * n + q] = s * vip + c * viq;
        }
      }
    }
    if (Math.sqrt(off) < t) break;
  }

  const singularValues = new F64(n);
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let i = 0; i < m; i++) s += A.data[i * n + j] * A.data[i * n + j];
    singularValues[j] = Math.sqrt(s);
  }

  const U = matrixCreate(m, n);
  for (let j = 0; j < n; j++) {
    const sj = singularValues[j];
    if (sj > EPSILON) {
      for (let i = 0; i < m; i++) U.data[i * n + j] = A.data[i * n + j] / sj;
    }
  }

  const S = matrixCreate(n, n);
  for (let i = 0; i < n; i++) S.data[i * n + i] = singularValues[i];

  return { U, S, V: matrixTranspose(V), singularValues };
}

// ============================================================================
// SOLVERS
// ============================================================================

export function solveLinear(a, b) {
  const decomp = luDecompose(a);
  if (!decomp) return null;
  return luSolve(decomp, b);
}

export function solveSymmetric(a, b) {
  const decomp = choleskyDecompose(a);
  if (!decomp) return null;
  return choleskySolve(decomp, b);
}

export function leastSquares(a, b) {
  const { Q, R } = qrDecompose(a);
  const m = a.rows;
  const n = a.cols;
  const Qt = matrixTranspose(Q);
  const y = new F64(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < m; j++) acc += Qt.data[i * m + j] * b[j];
    y[i] = acc;
  }
  const Rtop = matrixSubmatrix(R, 0, n, 0, n);
  const decomp = luDecompose(Rtop);
  if (!decomp) return null;
  return luSolve(decomp, y);
}

export function pseudoInverse(a) {
  const { U, S, V, singularValues } = svdDecompose(a);
  const m = a.rows;
  const n = a.cols;
  const r = Math.min(m, n);
  const Sinv = matrixCreate(r, r);
  let maxS = 0;
  for (let i = 0; i < singularValues.length; i++) {
    if (singularValues[i] > maxS) maxS = singularValues[i];
  }
  const cutoff = maxS * Math.max(m, n) * EPSILON;
  for (let i = 0; i < r; i++) {
    if (singularValues[i] > cutoff) Sinv.data[i * r + i] = 1 / singularValues[i];
  }
  const Ut = matrixTranspose(U);
  const result = matrixMultiply(V, matrixMultiply(Sinv, Ut));
  return result;
}

// ============================================================================
// NORMS AND CONDITION
// ============================================================================

export function norm1(a) {
  let maxCol = 0;
  for (let j = 0; j < a.cols; j++) {
    let sum = 0;
    for (let i = 0; i < a.rows; i++) sum += Math.abs(a.data[i * a.cols + j]);
    if (sum > maxCol) maxCol = sum;
  }
  return maxCol;
}

export function normInf(a) {
  let maxRow = 0;
  for (let i = 0; i < a.rows; i++) {
    let sum = 0;
    for (let j = 0; j < a.cols; j++) sum += Math.abs(a.data[i * a.cols + j]);
    if (sum > maxRow) maxRow = sum;
  }
  return maxRow;
}

export function norm2(a) {
  const { singularValues } = svdDecompose(a);
  let max = 0;
  for (let i = 0; i < singularValues.length; i++) {
    if (singularValues[i] > max) max = singularValues[i];
  }
  return max;
}

export function conditionNumber(a) {
  const { singularValues } = svdDecompose(a);
  let maxS = 0;
  let minS = Infinity;
  for (let i = 0; i < singularValues.length; i++) {
    const s = singularValues[i];
    if (s > maxS) maxS = s;
    if (s > EPSILON && s < minS) minS = s;
  }
  if (minS === Infinity || maxS === 0) return Infinity;
  return maxS / minS;
}

// ============================================================================
// RANK AND NULL SPACE
// ============================================================================

export function matrixRank(a, tol) {
  const { R } = qrDecompose(a);
  const t = tol === undefined ? Math.max(a.rows, a.cols) * EPSILON : tol;
  let rank = 0;
  for (let i = 0; i < Math.min(R.rows, R.cols); i++) {
    if (Math.abs(R.data[i * R.cols + i]) > t) rank++;
  }
  return rank;
}

export function nullSpace(a, tol) {
  const { U, singularValues } = svdDecompose(a);
  const t = tol === undefined ? Math.max(a.rows, a.cols) * EPSILON : tol;
  const basis = [];
  for (let j = 0; j < singularValues.length; j++) {
    if (singularValues[j] <= t) {
      const v = new F64(a.cols);
      for (let i = 0; i < a.cols; i++) v[i] = U.data[i * singularValues.length + j];
      basis.push(v);
    }
  }
  return basis;
}

// ============================================================================
// MATRIX FUNCTIONS
// ============================================================================

export function matrixExp(a) {
  const { values, vectors } = symmetricEigen(a);
  const n = a.rows;
  const D = matrixCreate(n, n);
  for (let i = 0; i < n; i++) D.data[i * n + i] = Math.exp(values[i]);
  const Vt = matrixTranspose(vectors);
  return matrixMultiply(vectors, matrixMultiply(D, Vt));
}

export function matrixLog(a) {
  const { values, vectors } = symmetricEigen(a);
  const n = a.rows;
  const D = matrixCreate(n, n);
  for (let i = 0; i < n; i++) D.data[i * n + i] = Math.log(values[i]);
  const Vt = matrixTranspose(vectors);
  return matrixMultiply(vectors, matrixMultiply(D, Vt));
}

export function matrixSqrt(a) {
  const { values, vectors } = symmetricEigen(a);
  const n = a.rows;
  const D = matrixCreate(n, n);
  for (let i = 0; i < n; i++) D.data[i * n + i] = Math.sqrt(values[i]);
  const Vt = matrixTranspose(vectors);
  return matrixMultiply(vectors, matrixMultiply(D, Vt));
}

export function characteristicPolynomial(a) {
  const n = a.rows;
  if (a.cols !== n) throw new DomainViolationError('characteristicPolynomial', 'square required');
  const coeffs = new F64(n + 1);
  coeffs[0] = 1;
  let Mk = matrixIdentity(n);
  for (let k = 1; k <= n; k++) {
    const AMk = matrixMultiply(a, Mk);
    const tr = matrixTrace(AMk);
    coeffs[k] = -tr / k;
    for (let i = 0; i < n; i++) {
      AMk.data[i * n + i] += coeffs[k];
    }
    Mk = AMk;
  }
  return coeffs;
}

// ============================================================================
// DOUBLEDOUBLE HIGH-PRECISION VARIANTS
// ============================================================================

export function ddDot(a, b) {
  let acc = [0, 0];
  for (let i = 0; i < a.length; i++) {
    acc = DD.add(acc, DD.twoProduct(a[i], b[i]));
  }
  return acc;
}

export function ddMatVec(a, x) {
  const n = a.rows;
  const m = a.cols;
  const y = new F64(n);
  for (let i = 0; i < n; i++) {
    let acc = [0, 0];
    for (let j = 0; j < m; j++) {
      acc = DD.add(acc, DD.twoProduct(a.data[i * m + j], x[j]));
    }
    y[i] = DD.toDouble(acc);
  }
  return y;
}

export function ddDet(a) {
  if (a.rows !== a.cols) throw new DomainViolationError('ddDet', 'square required');
  const n = a.rows;
  const M = matrixClone(a);
  let det = [0, 1];
  let sign = 1;
  for (let k = 0; k < n; k++) {
    let maxVal = 0;
    let maxRow = k;
    for (let i = k; i < n; i++) {
      const v = Math.abs(M.data[i * n + k]);
      if (v > maxVal) {
        maxVal = v;
        maxRow = i;
      }
    }
    if (maxVal < EPSILON) return [0, 0];
    if (maxRow !== k) {
      for (let j = 0; j < n; j++) {
        const tmp = M.data[k * n + j];
        M.data[k * n + j] = M.data[maxRow * n + j];
        M.data[maxRow * n + j] = tmp;
      }
      sign = -sign;
    }
    const pivot = M.data[k * n + k];
    det = DD.multiply(det, DD.fromDouble(pivot));
    for (let i = k + 1; i < n; i++) {
      const f = M.data[i * n + k] / pivot;
      for (let j = k + 1; j < n; j++) {
        M.data[i * n + j] -= f * M.data[k * n + j];
      }
    }
  }
  if (sign === -1) det = DD.negate(det);
  return det;
}

export function ddSolve(a, b) {
  const decomp = luDecompose(a);
  if (!decomp) return null;
  const n = a.rows;
  const { LU, piv } = decomp;
  const x = new F64(n);
  const y = new F64(n);
  for (let i = 0; i < n; i++) y[i] = b[piv[i]];
  for (let i = 1; i < n; i++) {
    let acc = [0, y[i]];
    for (let j = 0; j < i; j++) {
      acc = DD.subtract(acc, DD.twoProduct(LU.data[i * n + j], y[j]));
    }
    y[i] = DD.toDouble(acc);
  }
  for (let i = n - 1; i >= 0; i--) {
    let acc = [0, y[i]];
    for (let j = i + 1; j < n; j++) {
      acc = DD.subtract(acc, DD.twoProduct(LU.data[i * n + j], x[j]));
    }
    x[i] = DD.toDouble(DD.divide(acc, DD.fromDouble(LU.data[i * n + i])));
  }
  return x;
}

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================

function validateMatrix(m, op) {
  if (!m || typeof m !== 'object') throw new DecodeError(op, 'matrix required');
  if (typeof m.rows !== 'number' || typeof m.cols !== 'number') {
    throw new DecodeError(op, 'rows/cols required');
  }
  if (m.rows <= 0 || m.cols <= 0) throw new DecodeError(op, 'rows/cols must be positive');
  if (!m.data || typeof m.data.length !== 'number') throw new DecodeError(op, 'data required');
  if (m.data.length !== m.rows * m.cols) throw new DecodeError(op, 'data length mismatch');
  return m;
}

function validateVector(v, op) {
  if (!v || typeof v !== 'object') throw new DecodeError(op, 'vector required');
  if (typeof v.length !== 'number') throw new DecodeError(op, 'vector length required');
  for (let i = 0; i < v.length; i++) {
    if (!isFiniteNumber(v[i])) throw new DecodeError(op, 'vector[' + i + '] must be finite');
  }
  return v;
}

export const MatrixInput = Object.freeze({
  make(rows, cols, data) {
    return matrixFromArray(rows, cols, data);
  },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('matrix', 'Expected matrix object');
    return validateMatrix(input, 'matrix');
  }
});

export const VectorInput = Object.freeze({
  make(v) { return { v }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('vector', 'Expected {v}');
    validateVector(input.v, 'vector');
    return input;
  }
});

export const SolveInput = Object.freeze({
  make(a, b) { return { a, b }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('solve', 'Expected {a, b}');
    validateMatrix(input.a, 'solve');
    validateVector(input.b, 'solve');
    if (input.a.rows !== input.b.length) throw new DecodeError('solve', 'A.rows !== b.length');
    return input;
  }
});

export const DecomposeInput = Object.freeze({
  make(a) { return { a }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('decompose', 'Expected {a}');
    validateMatrix(input.a, 'decompose');
    return input;
  }
});

export const LeastSquaresInput = SolveInput;

export const NormInput = DecomposeInput;

export const RankInput = DecomposeInput;

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================

export function matrixMultiplyValidated(input) {
  const a = MatrixInput.decode(input.a);
  const b = MatrixInput.decode(input.b);
  return matrixMultiply(a, b);
}

export function solveLinearValidated(input) {
  const d = SolveInput.decode(input);
  return solveLinear(d.a, d.b);
}

export function solveSymmetricValidated(input) {
  const d = SolveInput.decode(input);
  return solveSymmetric(d.a, d.b);
}

export function leastSquaresValidated(input) {
  const d = LeastSquaresInput.decode(input);
  return leastSquares(d.a, d.b);
}

export function pseudoInverseValidated(input) {
  const d = DecomposeInput.decode(input);
  return pseudoInverse(d.a);
}

export function svdValidated(input) {
  const d = DecomposeInput.decode(input);
  return svdDecompose(d.a);
}

export function eigValidated(input) {
  const d = DecomposeInput.decode(input);
  return symmetricEigen(d.a);
}

export function conditionNumberValidated(input) {
  const d = NormInput.decode(input);
  return conditionNumber(d.a);
}

export function matrixRankValidated(input) {
  const d = RankInput.decode(input);
  return matrixRank(d.a);
}

// ============================================================================
// POLICY-AWARE WRAPPERS
// ============================================================================

export function matrixMultiplyWithPolicies(a, b, policy) {
  return policyCustom(
    'LinearAlgebra.matrixMultiplyWithPolicies',
    () => matrixMultiply(a, b),
    (r) => r && isFiniteArray(r.data),
    (msg) => new DomainViolationError('matrixMultiplyWithPolicies', msg),
    (r) => ({ rows: r.rows, cols: r.cols }),
    policy
  );
}

export function solveLinearWithPolicies(a, b, policy) {
  return policyCustom(
    'LinearAlgebra.solveLinearWithPolicies',
    () => solveLinear(a, b),
    (r) => r === null || isFiniteArray(r),
    (msg) => new DomainViolationError('solveLinearWithPolicies', msg),
    (r) => ({ status: r === null ? 'singular' : 'ok', n: r ? r.length : 0 }),
    policy
  );
}

export function conditionNumberWithPolicies(a, policy) {
  return policyScalar(
    'LinearAlgebra.conditionNumberWithPolicies',
    () => conditionNumber(a),
    (msg) => new DomainViolationError('conditionNumberWithPolicies', msg),
    (r) => ({ result: String(r) }),
    policy
  );
}

export function matrixRankWithPolicies(a, policy) {
  return policyScalar(
    'LinearAlgebra.matrixRankWithPolicies',
    () => matrixRank(a),
    (msg) => new DomainViolationError('matrixRankWithPolicies', msg),
    (r) => ({ result: r }),
    policy
  );
}

// ============================================================================
// POOL
// ============================================================================
const _matrixPool = [];
const _MAX_MATRIX_POOL = 32;

export function poolAcquireMatrix(rows, cols) {
  if (_matrixPool.length > 0) {
    const m = _matrixPool.pop();
    if (m.rows === rows && m.cols === cols) {
      for (let i = 0; i < m.data.length; i++) m.data[i] = 0;
      return m;
    }
  }
  return matrixCreate(rows, cols);
}

export function poolReleaseMatrix(m) {
  if (_matrixPool.length >= _MAX_MATRIX_POOL) return;
  _matrixPool.push(m);
}

export function poolReset() {
  _matrixPool.length = 0;
}

export function poolSize() {
  return _matrixPool.length;
}

// ============================================================================
// EXPORTS
// ============================================================================
export { EPSILON, PRECISION, HELPERS, DD, vec3, vec4, mat3, mat4 };

export default {
  DecodeError,
  DomainViolationError,
  Matrix,
  matrixCreate,
  matrixFromArray,
  matrixIdentity,
  matrixClone,
  matrixGet,
  matrixSet,
  matrixAdd,
  matrixSubtract,
  matrixScale,
  matrixMultiply,
  matrixTranspose,
  matrixTrace,
  matrixFrobenius,
  matrixSubmatrix,
  matrixToArray,
  matrixFromVec3,
  matrixFromVec4,
  matrixToVec3,
  matrixToVec4,
  matrixFromMat3,
  matrixFromMat4,
  matrixToMat4,
  vectorDot,
  vectorCross,
  vectorNorm,
  vectorNormalize,
  vectorProject,
  vectorReflect,
  luDecompose,
  luSolve,
  luDeterminant,
  qrDecompose,
  choleskyDecompose,
  choleskySolve,
  symmetricEigen,
  svdDecompose,
  solveLinear,
  solveSymmetric,
  leastSquares,
  pseudoInverse,
  norm1,
  normInf,
  norm2,
  conditionNumber,
  matrixRank,
  nullSpace,
  matrixExp,
  matrixLog,
  matrixSqrt,
  characteristicPolynomial,
  ddDot,
  ddMatVec,
  ddDet,
  ddSolve,
  MatrixInput,
  VectorInput,
  SolveInput,
  DecomposeInput,
  LeastSquaresInput,
  NormInput,
  RankInput,
  matrixMultiplyValidated,
  solveLinearValidated,
  solveSymmetricValidated,
  leastSquaresValidated,
  pseudoInverseValidated,
  svdValidated,
  eigValidated,
  conditionNumberValidated,
  matrixRankValidated,
  matrixMultiplyWithPolicies,
  solveLinearWithPolicies,
  conditionNumberWithPolicies,
  matrixRankWithPolicies,
  poolAcquireMatrix,
  poolReleaseMatrix,
  poolReset,
  poolSize
};