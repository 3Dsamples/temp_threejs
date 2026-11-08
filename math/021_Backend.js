// file number : 021
// full path name : src/math/021_Backend.js
// description : High-performance Backend module rewritten from @scenesystems/effect-math Backend (pure-JS compute backend abstraction) without the Effect dependency. Provides a pluggable backend registry with pure-JS reference kernels for vectors, dense matrices (row-major Float64Array), and sparse CSR matrices; BLAS-lite operations (dot, axpy, gemv, gemm), matrix utilities (transpose, identity, copy, scale, add, mul), sparse mat-vec, linear solvers (LU with partial pivoting, Cholesky), and shape/dtype validation. Full policy-aware wrappers with strict/relaxed precision + diagnostics; zero-allocation hot paths via buffer pools; DoubleDouble-aware high-precision variants (dotDD, gemvDD) for galactic-scale numerics. Uses Constants (EPSILON, PRECISION) and 003_Common/014_DoubleDouble from the engine core. Backend interface shape: { id, capabilities, matVec, matMat, transpose, solveLU, solveCholesky, dot, axpy, sparseMatVec }. Register additional backends (WASM/GPU) at runtime.
// best for : Physics solvers, PBR light-transport stages, camera rigs, constraint solving, procedural terrain differentiation, entity transform pipelines, and any linear-algebra intensive subsystem requiring swappable accelerators on Android 64-bit.
// license : MIT

import { EPSILON } from '../core/003_Common.js';
import { PRECISION } from '../core/002_Constants.js';
import * as DD from './014_DoubleDouble.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'BackendDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'BackendDomainViolationError';
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
// DTYPE
// ============================================================================
const F64 = typeof Float64Array !== 'undefined' ? Float64Array : Array;

function makeArray(n) {
  return new F64(n);
}

function makeArrayZero(n) {
  const a = new F64(n);
  if (a instanceof Array) {
    for (let i = 0; i < n; i++) a[i] = 0;
  }
  return a;
}

// ============================================================================
// DENSE MATRIX (row-major)
// ============================================================================
export function DenseMatrix(rows, cols, data) {
  this.rows = rows;
  this.cols = cols;
  this.data = data || makeArrayZero(rows * cols);
}

export function denseCreate(rows, cols) {
  return new DenseMatrix(rows, cols, makeArrayZero(rows * cols));
}

export function denseIdentity(n) {
  const out = denseCreate(n, n);
  for (let i = 0; i < n; i++) out.data[i * n + i] = 1;
  return out;
}

export function denseCopy(m) {
  return new DenseMatrix(m.rows, m.cols, makeArray(m.data.length).fill ? Float64Array.from(m.data) : m.data.slice());
}

export function denseTranspose(m) {
  const out = denseCreate(m.cols, m.rows);
  const r = m.rows;
  const c = m.cols;
  const src = m.data;
  const dst = out.data;
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      dst[j * r + i] = src[i * c + j];
    }
  }
  return out;
}

export function denseScale(m, s) {
  const out = denseCreate(m.rows, m.cols);
  const src = m.data;
  const dst = out.data;
  const n = src.length;
  for (let i = 0; i < n; i++) dst[i] = src[i] * s;
  return out;
}

export function denseAdd(a, b) {
  if (a.rows !== b.rows || a.cols !== b.cols) {
    throw new DomainViolationError('denseAdd', 'shape mismatch');
  }
  const out = denseCreate(a.rows, a.cols);
  const n = a.data.length;
  for (let i = 0; i < n; i++) out.data[i] = a.data[i] + b.data[i];
  return out;
}

// ============================================================================
// BLAS-LITE KERNELS (zero-allocation hot paths)
// ============================================================================

export function dot(a, b) {
  const n = a.length;
  let acc = 0;
  for (let i = 0; i < n; i++) acc += a[i] * b[i];
  return acc;
}

export function dotDD(a, b) {
  let acc = [0, 0];
  for (let i = 0; i < a.length; i++) {
    const p = DD.twoProduct(a[i], b[i]);
    acc = DD.add(acc, p);
  }
  return acc;
}

export function axpy(y, a, x) {
  const n = y.length;
  for (let i = 0; i < n; i++) y[i] += a * x[i];
  return y;
}

export function axpyDD(y, a, x) {
  const ad = DD.fromDouble(a);
  for (let i = 0; i < y.length; i++) {
    const prod = DD.multiply(ad, DD.fromDouble(x[i]));
    const sum = DD.add([0, y[i]], prod);
    y[i] = DD.toDouble(sum);
  }
  return y;
}

export function gemv(y, A, x) {
  const r = A.rows;
  const c = A.cols;
  const data = A.data;
  const xa = x;
  for (let i = 0; i < r; i++) {
    const base = i * c;
    let acc = 0;
    for (let j = 0; j < c; j++) acc += data[base + j] * xa[j];
    y[i] = acc;
  }
  return y;
}

export function gemvDD(y, A, x) {
  const r = A.rows;
  const c = A.cols;
  const data = A.data;
  const xd = new Array(c);
  for (let j = 0; j < c; j++) xd[j] = DD.fromDouble(x[j]);
  for (let i = 0; i < r; i++) {
    let acc = [0, 0];
    const base = i * c;
    for (let j = 0; j < c; j++) {
      acc = DD.add(acc, DD.multiply(DD.fromDouble(data[base + j]), xd[j]));
    }
    y[i] = DD.toDouble(acc);
  }
  return y;
}

export function gemm(C, A, B) {
  const ar = A.rows;
  const ac = A.cols;
  const bc = B.cols;
  if (ac !== B.rows) throw new DomainViolationError('gemm', 'shape mismatch');
  if (C.rows !== ar || C.cols !== bc) throw new DomainViolationError('gemm', 'output shape mismatch');
  const ad = A.data;
  const bd = B.data;
  const cd = C.data;
  for (let i = 0; i < ar; i++) {
    const cbase = i * bc;
    for (let j = 0; j < bc; j++) {
      cd[cbase + j] = 0;
    }
    for (let k = 0; k < ac; k++) {
      const aik = ad[i * ac + k];
      const bbase = k * bc;
      for (let j = 0; j < bc; j++) {
        cd[cbase + j] += aik * bd[bbase + j];
      }
    }
  }
  return C;
}

// ============================================================================
// SPARSE MATRIX (CSR)
// ============================================================================
export function SparseCSR(rows, cols, rowPtr, colIdx, values) {
  this.rows = rows;
  this.cols = cols;
  this.rowPtr = rowPtr;
  this.colIdx = colIdx;
  this.values = values;
}

export function sparseCreate(rows, cols) {
  return new SparseCSR(
    rows,
    cols,
    new Uint32Array(rows + 1),
    new Uint32Array(0),
    new F64(0)
  );
}

export function sparseMatVec(y, A, x) {
  const r = A.rows;
  const rp = A.rowPtr;
  const ci = A.colIdx;
  const v = A.values;
  for (let i = 0; i < r; i++) {
    let acc = 0;
    const start = rp[i];
    const end = rp[i + 1];
    for (let k = start; k < end; k++) {
      acc += v[k] * x[ci[k]];
    }
    y[i] = acc;
  }
  return y;
}

// ============================================================================
// LINEAR SOLVERS
// ============================================================================

export function solveLU(A, b) {
  const n = A.rows;
  if (A.cols !== n) throw new DomainViolationError('solveLU', 'must be square');
  if (b.length !== n) throw new DomainViolationError('solveLU', 'b size mismatch');

  const M = new F64(n * n);
  const src = A.data;
  for (let i = 0; i < n * n; i++) M[i] = src[i];

  const x = new F64(n);
  const piv = new Int32Array(n);
  for (let i = 0; i < n; i++) piv[i] = i;

  // LU decomposition with partial pivoting
  for (let k = 0; k < n; k++) {
    let maxVal = 0;
    let maxRow = k;
    for (let i = k; i < n; i++) {
      const v = Math.abs(M[i * n + k]);
      if (v > maxVal) {
        maxVal = v;
        maxRow = i;
      }
    }
    if (maxVal < EPSILON) {
      return null;
    }
    if (maxRow !== k) {
      // swap rows
      for (let j = 0; j < n; j++) {
        const tmp = M[k * n + j];
        M[k * n + j] = M[maxRow * n + j];
        M[maxRow * n + j] = tmp;
      }
      const tmpP = piv[k];
      piv[k] = piv[maxRow];
      piv[maxRow] = tmpP;
    }
    const pivot = M[k * n + k];
    for (let i = k + 1; i < n; i++) {
      const factor = M[i * n + k] / pivot;
      M[i * n + k] = factor;
      for (let j = k + 1; j < n; j++) {
        M[i * n + j] -= factor * M[k * n + j];
      }
    }
  }

  const y = new F64(n);
  for (let i = 0; i < n; i++) y[i] = b[piv[i]];
  for (let i = 1; i < n; i++) {
    let acc = y[i];
    for (let j = 0; j < i; j++) acc -= M[i * n + j] * y[j];
    y[i] = acc;
  }
  for (let i = n - 1; i >= 0; i--) {
    let acc = y[i];
    for (let j = i + 1; j < n; j++) acc -= M[i * n + j] * x[j];
    x[i] = acc / M[i * n + i];
  }
  return x;
}

export function solveCholesky(A, b) {
  const n = A.rows;
  if (A.cols !== n) throw new DomainViolationError('solveCholesky', 'must be square');
  if (b.length !== n) throw new DomainViolationError('solveCholesky', 'b size mismatch');

  const L = new F64(n * n);
  const src = A.data;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) sum += L[i * n + k] * L[j * n + k];
      if (i === j) {
        const v = src[i * n + i] - sum;
        if (v <= 0) return null;
        L[i * n + j] = Math.sqrt(v);
      } else {
        L[i * n + j] = (src[i * n + j] - sum) / L[j * n + j];
      }
    }
  }

  const y = new F64(n);
  for (let i = 0; i < n; i++) {
    let acc = b[i];
    for (let j = 0; j < i; j++) acc -= L[i * n + j] * y[j];
    y[i] = acc / L[i * n + i];
  }
  const x = new F64(n);
  for (let i = n - 1; i >= 0; i--) {
    let acc = y[i];
    for (let j = i + 1; j < n; j++) acc -= L[j * n + i] * x[j];
    x[i] = acc / L[i * n + i];
  }
  return x;
}

// ============================================================================
// SHAPE / DTYPE VALIDATORS
// ============================================================================

function validateMatrix(name, m) {
  if (!m || typeof m !== 'object') throw new DecodeError(name, 'matrix required');
  if (typeof m.rows !== 'number' || typeof m.cols !== 'number') throw new DecodeError(name, 'rows/cols required');
  if (m.rows <= 0 || m.cols <= 0) throw new DecodeError(name, 'rows/cols must be positive');
  if (!m.data || typeof m.data.length !== 'number') throw new DecodeError(name, 'data required');
  if (m.data.length !== m.rows * m.cols) throw new DecodeError(name, 'data length mismatch');
  return m;
}

export const MatVecInput = Object.freeze({
  make(A, x) {
    return { A, x };
  },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('matVec', 'Expected {A, x}');
    validateMatrix('matVec', input.A);
    if (!Array.isArray(input.x) && !(input.x instanceof Float64Array) && !(input.x instanceof Float32Array)) {
      throw new DecodeError('matVec', 'x must be array-like');
    }
    if (input.x.length !== input.A.cols) throw new DecodeError('matVec', 'x length mismatch');
    for (let i = 0; i < input.x.length; i++) {
      if (!isFiniteNumber(input.x[i])) throw new DecodeError('matVec', 'x[' + i + '] must be finite');
    }
    return input;
  }
});

export const MatMatInput = Object.freeze({
  make(A, B) {
    return { A, B };
  },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('matMat', 'Expected {A, B}');
    validateMatrix('matMat', input.A);
    validateMatrix('matMat', input.B);
    if (input.A.cols !== input.B.rows) throw new DecodeError('matMat', 'inner dim mismatch');
    return input;
  }
});

export const SolveInput = Object.freeze({
  make(A, b) {
    return { A, b };
  },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('solve', 'Expected {A, b}');
    validateMatrix('solve', input.A);
    if (input.A.rows !== input.A.cols) throw new DecodeError('solve', 'A must be square');
    if (!Array.isArray(input.b) && !(input.b instanceof Float64Array) && !(input.b instanceof Float32Array)) {
      throw new DecodeError('solve', 'b must be array-like');
    }
    if (input.b.length !== input.A.rows) throw new DecodeError('solve', 'b length mismatch');
    return input;
  }
});

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================

export function matVecValidated(input) {
  const d = MatVecInput.decode(input);
  const y = makeArrayZero(d.A.rows);
  gemv(y, d.A, d.x);
  return y;
}

export function matMatValidated(input) {
  const d = MatMatInput.decode(input);
  const C = denseCreate(d.A.rows, d.B.cols);
  gemm(C, d.A, d.B);
  return C;
}

export function solveLUValidated(input) {
  const d = SolveInput.decode(input);
  return solveLU(d.A, d.b);
}

export function solveCholeskyValidated(input) {
  const d = SolveInput.decode(input);
  return solveCholesky(d.A, d.b);
}

// ============================================================================
// POLICY-AWARE OPERATIONS
// ============================================================================

export function matVecWithPolicies(A, x, policy) {
  return policyCustom(
    'Backend.matVecWithPolicies',
    () => {
      const y = makeArrayZero(A.rows);
      gemv(y, A, x);
      return y;
    },
    (r) => isFiniteArray(r),
    (msg) => new DomainViolationError('matVecWithPolicies', msg),
    (r) => ({ rows: A.rows, cols: A.cols, outLen: r.length }),
    policy
  );
}

export function matMatWithPolicies(A, B, policy) {
  return policyCustom(
    'Backend.matMatWithPolicies',
    () => {
      const C = denseCreate(A.rows, B.cols);
      gemm(C, A, B);
      return C;
    },
    (m) => isFiniteArray(m.data),
    (msg) => new DomainViolationError('matMatWithPolicies', msg),
    (m) => ({ rows: m.rows, cols: m.cols }),
    policy
  );
}

export function solveLUWithPolicies(A, b, policy) {
  return policyCustom(
    'Backend.solveLUWithPolicies',
    () => solveLU(A, b),
    (r) => r === null || isFiniteArray(r),
    (msg) => new DomainViolationError('solveLUWithPolicies', msg),
    (r) => ({ status: r === null ? 'singular' : 'ok', size: r ? r.length : 0 }),
    policy
  );
}

export function solveCholeskyWithPolicies(A, b, policy) {
  return policyCustom(
    'Backend.solveCholeskyWithPolicies',
    () => solveCholesky(A, b),
    (r) => r === null || isFiniteArray(r),
    (msg) => new DomainViolationError('solveCholeskyWithPolicies', msg),
    (r) => ({ status: r === null ? 'not_positive_definite' : 'ok', size: r ? r.length : 0 }),
    policy
  );
}

export function dotWithPolicies(a, b, policy) {
  return policyScalar(
    'Backend.dotWithPolicies',
    () => dot(a, b),
    (msg) => new DomainViolationError('dotWithPolicies', msg),
    (r) => ({ n: a.length, result: String(r) }),
    policy
  );
}

// ============================================================================
// BACKEND REGISTRY
// ============================================================================

const _backends = new Map();

export function createPureJSBackend() {
  return {
    id: 'pure-js-f64',
    capabilities: Object.freeze({
      dtypes: ['f64'],
      dense: true,
      sparse: true,
      lu: true,
      cholesky: true,
      dd: true
    }),
    dot,
    dotDD,
    axpy,
    axpyDD,
    gemv,
    gemvDD,
    gemm,
    sparseMatVec,
    transpose: denseTranspose,
    scale: denseScale,
    add: denseAdd,
    identity: denseIdentity,
    solveLU,
    solveCholesky
  };
}

export function registerBackend(backend) {
  if (!backend || typeof backend !== 'object' || typeof backend.id !== 'string') return false;
  _backends.set(backend.id, backend);
  return true;
}

export function getBackend(id) {
  return _backends.get(id) || null;
}

export function listBackends() {
  return Array.from(_backends.keys());
}

export function setDefaultBackend(id) {
  const b = _backends.get(id);
  if (!b) return false;
  _defaultBackendId = id;
  return true;
}

let _defaultBackendId = 'pure-js-f64';

export function getDefaultBackend() {
  return _backends.get(_defaultBackendId) || null;
}

// Register the built-in backend
registerBackend(createPureJSBackend());

// ============================================================================
// POOL (zero-allocation dense buffers)
// ============================================================================

const _densePool = [];
const _MAX_DENSE_POOL = 32;

export function poolAcquireDense(rows, cols) {
  if (_densePool.length > 0) {
    const entry = _densePool.pop();
    if (entry.rows === rows && entry.cols === cols) return entry;
  }
  return denseCreate(rows, cols);
}

export function poolReleaseDense(m) {
  if (_densePool.length >= _MAX_DENSE_POOL) return;
  _densePool.push(m);
}

export function poolReset() {
  _densePool.length = 0;
}

export function poolSize() {
  return _densePool.length;
}

// ============================================================================
// EXPORTS
// ============================================================================

export { EPSILON, PRECISION, DD };

export default {
  DecodeError,
  DomainViolationError,
  DenseMatrix,
  SparseCSR,
  denseCreate,
  denseIdentity,
  denseCopy,
  denseTranspose,
  denseScale,
  denseAdd,
  sparseCreate,
  sparseMatVec,
  dot,
  dotDD,
  axpy,
  axpyDD,
  gemv,
  gemvDD,
  gemm,
  solveLU,
  solveCholesky,
  MatVecInput,
  MatMatInput,
  SolveInput,
  matVecValidated,
  matMatValidated,
  solveLUValidated,
  solveCholeskyValidated,
  matVecWithPolicies,
  matMatWithPolicies,
  solveLUWithPolicies,
  solveCholeskyWithPolicies,
  dotWithPolicies,
  createPureJSBackend,
  registerBackend,
  getBackend,
  listBackends,
  setDefaultBackend,
  getDefaultBackend,
  poolAcquireDense,
  poolReleaseDense,
  poolReset,
  poolSize
};