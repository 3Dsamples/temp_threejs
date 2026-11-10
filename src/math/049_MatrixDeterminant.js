// file number : 049
// full path name : src/math/049_MatrixDeterminant.js
// description : High-performance Determinant module reimplemented from mljs/matrix dc/determinant.js and stat.js. Provides fast closed-form determinants for 1x1, 2x2, 3x3, 4x4 with unrolled inner loops, and LU-decomposition-based determinant for arbitrary size n with partial pivoting (reuses 040_MatrixLU). Supports DoubleDouble high-precision accumulation for small sizes and DD LU for large. Includes pre-check for square matrices, singularity detection, and policy-aware wrappers via 030_Policy. Uses cache-friendly flat typed array access on MLMatrix (038).
// best for : PBR Jacobian singularity checks, physics constraint stability, ML model validation, mesh orientation sign, procedural mesh winding, and any determinant-based pipeline at 10k+ entity scale on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS } from '../core/002_Constants.js';
import * as DD from './014_DoubleDouble.js';
import * as ML from './038_MatrixML.js';
import * as LU from './040_MatrixLU.js';
import * as PolicyModule from './030_Policy.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'MatrixDeterminantDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'MatrixDeterminantDomainViolationError';
    this.operation = operation;
  }
}

// ============================================================================
// HELPERS
// ============================================================================
function checkMatrix(m, op) {
  if (!(m instanceof ML.MLMatrix)) throw new DecodeError(op, 'MLMatrix instance required');
}

// ============================================================================
// DETERMINANT (main dispatcher)
// ============================================================================
export function determinant(matrix) {
  checkMatrix(matrix, 'determinant');
  if (!matrix.isSquare()) throw new DomainViolationError('determinant', 'Matrix must be square');
  const n = matrix.rows;

  if (n === 0) return 1;
  if (n === 1) return _det1(matrix);
  if (n === 2) return _det2(matrix);
  if (n === 3) return _det3(matrix);
  if (n === 4) return _det4(matrix);
  return _detLU(matrix);
}

// ============================================================================
// SMALL-SIZE CLOSED FORMS
// ============================================================================
function _det1(m) {
  return m.dd ? m.data[1] : m.data[0];
}

function _det2(m) {
  if (m.dd) {
    const a = [m.data[0], m.data[1]];
    const b = [m.data[2], m.data[3]];
    const c = [m.data[4], m.data[5]];
    const d = [m.data[6], m.data[7]];
    return DD.toDouble(DD.subtract(DD.multiply(a, d), DD.multiply(b, c)));
  }
  const data = m.data;
  return data[0] * data[3] - data[2] * data[1];
}

function _det3(m) {
  if (m.dd) {
    const A = (i, j) => [m.data[(i * 3 + j) * 2], m.data[(i * 3 + j) * 2 + 1]];
    const a = A(0, 0), b = A(0, 1), c = A(0, 2);
    const d = A(1, 0), e = A(1, 1), f = A(1, 2);
    const g = A(2, 0), h = A(2, 1), i = A(2, 2);
    const term1 = DD.multiply(a, DD.subtract(DD.multiply(e, i), DD.multiply(f, h)));
    const term2 = DD.multiply(b, DD.subtract(DD.multiply(d, i), DD.multiply(f, g)));
    const term3 = DD.multiply(c, DD.subtract(DD.multiply(d, h), DD.multiply(e, g)));
    return DD.toDouble(DD.add(DD.subtract(term1, term2), term3));
  }
  const d = m.data;
  const a = d[0], b = d[1], c = d[2];
  const e = d[3], f = d[4], g = d[5];
  const h = d[6], i = d[7], j = d[8];
  return a * (f * j - g * i) - b * (e * j - g * h) + c * (e * i - f * h);
}

function _det4(m) {
  if (m.dd) {
    const A = (r, c) => [m.data[(r * 4 + c) * 2], m.data[(r * 4 + c) * 2 + 1]];
    // Laplace expansion along first row using 3x3 minors (DD)
    let acc = [0, 0];
    for (let col = 0; col < 4; col++) {
      const elem = A(0, col);
      const minor = _det3DD(
        A(1, 0), A(1, 1), A(1, 2), A(1, 3),
        A(2, 0), A(2, 1), A(2, 2), A(2, 3),
        A(3, 0), A(3, 1), A(3, 2), A(3, 3),
        col
      );
      const term = DD.multiply(elem, minor);
      acc = (col % 2 === 0) ? DD.add(acc, term) : DD.subtract(acc, term);
    }
    return DD.toDouble(acc);
  }
  const d = m.data;
  const a0 = d[0], a1 = d[1], a2 = d[2], a3 = d[3];
  const b0 = d[4], b1 = d[5], b2 = d[6], b3 = d[7];
  const c0 = d[8], c1 = d[9], c2 = d[10], c3 = d[11];
  const e0 = d[12], e1 = d[13], e2 = d[14], e3 = d[15];

  const m00 = b1 * (c2 * e3 - c3 * e2) - b2 * (c1 * e3 - c3 * e1) + b3 * (c1 * e2 - c2 * e1);
  const m01 = b0 * (c2 * e3 - c3 * e2) - b2 * (c0 * e3 - c3 * e0) + b3 * (c0 * e2 - c2 * e0);
  const m02 = b0 * (c1 * e3 - c3 * e1) - b1 * (c0 * e3 - c3 * e0) + b3 * (c0 * e1 - c1 * e0);
  const m03 = b0 * (c1 * e2 - c2 * e1) - b1 * (c0 * e2 - c2 * e0) + b2 * (c0 * e1 - c1 * e0);

  return a0 * m00 - a1 * m01 + a2 * m02 - a3 * m03;
}

function _det3DD(
  a00, a01, a02, a03,
  a10, a11, a12, a13,
  a20, a21, a22, a23,
  skipCol
) {
  const vals = [];
  const pushRow = (r0, r1, r2, r3) => {
    const row = [r0, r1, r2, r3];
    for (let i = 0; i < 4; i++) {
      if (i !== skipCol) vals.push(row[i]);
    }
  };
  pushRow(a00, a01, a02, a03);
  pushRow(a10, a11, a12, a13);
  pushRow(a20, a21, a22, a23);
  const [p, q, r, s, t, u, v, w, x] = vals;
  const t1 = DD.multiply(p, DD.subtract(DD.multiply(t, x), DD.multiply(u, w)));
  const t2 = DD.multiply(q, DD.subtract(DD.multiply(s, x), DD.multiply(u, v)));
  const t3 = DD.multiply(r, DD.subtract(DD.multiply(s, w), DD.multiply(t, v)));
  return DD.add(DD.subtract(t1, t2), t3);
}

// ============================================================================
// LU-BASED DETERMINANT (n >= 5)
// ============================================================================
function _detLU(m) {
  const decomp = new LU.LuDecomposition(m);
  return decomp.determinant;
}

// ============================================================================
// SINGULARITY CHECK (fast)
// ============================================================================
export function isSingular(matrix, tolerance) {
  checkMatrix(matrix, 'isSingular');
  if (!matrix.isSquare()) throw new DomainViolationError('isSingular', 'Matrix must be square');
  const det = determinant(matrix);
  const tol = tolerance === undefined ? EPSILON : tolerance;
  return Math.abs(det) < tol;
}

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================
export const DeterminantInput = Object.freeze({
  make(matrix) { return { matrix }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('determinant', 'Expected {matrix}');
    checkMatrix(input.matrix, 'determinant');
    if (!input.matrix.isSquare()) throw new DecodeError('determinant', 'Matrix must be square');
    return input;
  }
});

export const SingularityInput = Object.freeze({
  make(matrix, tolerance) { return { matrix, tolerance }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('isSingular', 'Expected {matrix, tolerance?}');
    checkMatrix(input.matrix, 'isSingular');
    if (!input.matrix.isSquare()) throw new DecodeError('isSingular', 'Matrix must be square');
    if (input.tolerance !== undefined && (typeof input.tolerance !== 'number' || input.tolerance < 0)) {
      throw new DecodeError('isSingular', 'tolerance must be non-negative number');
    }
    return input;
  }
});

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================
export function determinantValidated(input) {
  const d = DeterminantInput.decode(input);
  return determinant(d.matrix);
}

export function isSingularValidated(input) {
  const d = SingularityInput.decode(input);
  return isSingular(d.matrix, d.tolerance);
}

// ============================================================================
// POLICY-AWARE WRAPPERS
// ============================================================================
function policyScalar(operation, compute, annotate, policy) {
  const pol = PolicyModule.resolvePolicy(policy);
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const result = compute();
  if (pol.precision === PolicyModule.PrecisionMode.STRICT && typeof result === 'number' && !Number.isFinite(result)) {
    throw new DomainViolationError(operation, 'strict precision rejected non-finite result');
  }
  if (pol.diagnostics !== PolicyModule.DiagnosticMode.DISABLED) {
    const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    const info = annotate ? annotate(result) : {};
    info.precision = pol.precision;
    info.elapsedMs = elapsed;
    // eslint-disable-next-line no-console
    console.log(`[${operation}]`, info);
  }
  return result;
}

function policyCustom(operation, compute, isValid, annotate, policy) {
  const pol = PolicyModule.resolvePolicy(policy);
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const result = compute();
  if (pol.precision === PolicyModule.PrecisionMode.STRICT && !isValid(result)) {
    throw new DomainViolationError(operation, 'strict precision rejected invalid result');
  }
  if (pol.diagnostics !== PolicyModule.DiagnosticMode.DISABLED) {
    const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    const info = annotate ? annotate(result) : {};
    info.precision = pol.precision;
    info.elapsedMs = elapsed;
    // eslint-disable-next-line no-console
    console.log(`[${operation}]`, info);
  }
  return result;
}

export function determinantWithPolicies(matrix, policy) {
  return policyScalar(
    'MatrixDeterminant.determinantWithPolicies',
    () => determinant(matrix),
    (r) => ({ n: matrix.rows, result: r }),
    policy
  );
}

export function isSingularWithPolicies(matrix, tolerance, policy) {
  return policyCustom(
    'MatrixDeterminant.isSingularWithPolicies',
    () => isSingular(matrix, tolerance),
    (r) => typeof r === 'boolean',
    (r) => ({ n: matrix.rows, result: r }),
    policy
  );
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default {
  DecodeError,
  DomainViolationError,
  determinant,
  isSingular,
  DeterminantInput,
  SingularityInput,
  determinantValidated,
  isSingularValidated,
  determinantWithPolicies,
  isSingularWithPolicies
};