// file number : 051
// full path name : src/math/051_MatrixPseudoInverse.js
// description : High-performance Moore-Penrose pseudo-inverse reimplemented from mljs/matrix stat.js pseudoInverse and related utilities. Uses the SVD (042_MatrixSVD) path for the general case, with a fast inverse path for square full-rank matrices (via 040_MatrixLU) and a rank-truncation parameter (rcond) to control numerical cutoff of small singular values. Provides pseudoInverse, pseudoInverse with rcond, rank computation, condition number, and a solve helper via pseudo-inverse (least-squares fallback). Works on the flat typed array backing of MLMatrix (038). Supports DoubleDouble accumulation and policy-aware wrappers via 030_Policy, plus schema validators.
// best for : Least-squares regression, underdetermined/overdetermined systems, ML feature projections, PBR model fitting, camera calibration, physics constraint Jacobian solvers, and any pseudo-inverse pipeline at 10k+ entity scale on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS } from '../core/002_Constants.js';
import * as DD from './014_DoubleDouble.js';
import * as ML from './038_MatrixML.js';
import * as LU from './040_MatrixLU.js';
import * as SVD from './042_MatrixSVD.js';
import * as PolicyModule from './030_Policy.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'MatrixPseudoInverseDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'MatrixPseudoInverseDomainViolationError';
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
// FAST INVERSE VIA LU (square, non-singular)
// ============================================================================
export function inverseLU(matrix) {
  checkMatrix(matrix, 'inverseLU');
  if (!matrix.isSquare()) throw new DomainViolationError('inverseLU', 'Matrix must be square');
  const decomp = new LU.LuDecomposition(matrix);
  if (decomp.isSingular()) return null;
  const n = matrix.rows;
  const eye = ML.MLMatrix.eye(n, matrix.dd);
  return decomp.solve(eye);
}

// ============================================================================
// MOORE-PENROSE PSEUDO-INVERSE (SVD-based)
// ============================================================================
export function pseudoInverse(matrix, options) {
  checkMatrix(matrix, 'pseudoInverse');
  const opts = options || {};
  const useFastLU = opts.fastLU !== false;

  // Fast path for square full-rank matrices
  if (useFastLU && matrix.isSquare()) {
    const inv = inverseLU(matrix);
    if (inv) return inv;
  }

  const rcond = opts.rcond;
  const svd = new SVD.SingularValueDecomposition(matrix);
  return pseudoInverseFromSVD(svd, rcond, matrix.dd);
}

export function pseudoInverseFromSVD(svd, rcond, dd) {
  const m = svd.m;
  const n = svd.n;
  const s = svd.s;
  const U = svd.U;
  const V = svd.V;
  const nu = U.columns;

  // Determine tolerance for singular value cutoff
  const cutoff = rcond !== undefined
    ? rcond
    : Math.max(m, n) * (s.length > 0 ? s[0] : 0) * EPSILON;

  // Build S+ (pseudo-inverse of diagonal S)
  const Sp = new ARRAY_TYPE(nu);
  for (let i = 0; i < s.length && i < nu; i++) {
    Sp[i] = s[i] > cutoff ? 1 / s[i] : 0;
  }

  // Compute V * S+ * U^T  (shape n x m)
  // Step 1: V * (S+ scaled rows) — scale V's columns by Sp
  // Step 2: multiply by U^T

  const out = new ML.MLMatrix(n, m, { dd: dd || U.dd || V.dd });

  const useDD = out.dd;
  if (!useDD) {
    const vData = V.data;
    const uData = U.data;
    const outData = out.data;
    const nuLocal = nu;
    // out = V * diag(Sp) * U^T
    // out[i,j] = sum_k V[i,k] * Sp[k] * U[j,k]
    for (let i = 0; i < n; i++) {
      const vRowBase = i * n;
      for (let j = 0; j < m; j++) {
        let sum = 0;
        const uRowBase = j * nuLocal;
        for (let k = 0; k < nuLocal; k++) {
          sum += vData[vRowBase + k] * Sp[k] * uData[uRowBase + k];
        }
        outData[i * m + j] = sum;
      }
    }
  } else {
    const vData = V.data;
    const uData = U.data;
    const outData = out.data;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        let acc = [0, 0];
        for (let k = 0; k < nu; k++) {
          if (Sp[k] === 0) continue;
          const vPos = (i * n + k) * 2;
          const uPos = (j * nu + k) * 2;
          const v = V.dd ? [vData[vPos], vData[vPos + 1]] : [0, vData[i * n + k]];
          const u = U.dd ? [uData[uPos], uData[uPos + 1]] : [0, uData[j * nu + k]];
          const prod = DD.multiply(DD.multiply(v, DD.fromDouble(Sp[k])), u);
          acc = DD.add(acc, prod);
        }
        const pos = (i * m + j) * 2;
        outData[pos] = acc[0];
        outData[pos + 1] = acc[1];
      }
    }
  }

  return out;
}

// ============================================================================
// SOLVE VIA PSEUDO-INVERSE (least-squares)
// ============================================================================
export function solveWithPseudoInverse(A, B, options) {
  checkMatrix(A, 'solveWithPseudoInverse');
  checkMatrix(B, 'solveWithPseudoInverse');
  if (A.rows !== B.rows) {
    throw new DomainViolationError('solveWithPseudoInverse', 'A.rows must equal B.rows');
  }
  const Ap = pseudoInverse(A, options);
  return Ap.mmul(B);
}

// ============================================================================
// RANK & CONDITION NUMBER
// ============================================================================
export function rank(matrix, rcond) {
  checkMatrix(matrix, 'rank');
  const svd = new SVD.SingularValueDecomposition(matrix);
  const s = svd.s;
  if (s.length === 0) return 0;
  const cutoff = rcond !== undefined
    ? rcond
    : Math.max(svd.m, svd.n) * s[0] * EPSILON;
  let r = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] > cutoff) r++;
  }
  return r;
}

export function conditionNumber(matrix) {
  checkMatrix(matrix, 'conditionNumber');
  const svd = new SVD.SingularValueDecomposition(matrix);
  const s = svd.s;
  if (s.length === 0) return Infinity;
  const smax = s[0];
  let smin = Infinity;
  for (let i = 0; i < s.length; i++) {
    if (s[i] > EPSILON && s[i] < smin) smin = s[i];
  }
  if (smin === Infinity || smax === 0) return Infinity;
  return smax / smin;
}

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================
export const PseudoInverseInput = Object.freeze({
  make(matrix, options) { return { matrix, options }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('pseudoInverse', 'Expected {matrix, options?}');
    checkMatrix(input.matrix, 'pseudoInverse');
    if (input.options && input.options.rcond !== undefined) {
      if (typeof input.options.rcond !== 'number' || input.options.rcond < 0) {
        throw new DecodeError('pseudoInverse', 'rcond must be non-negative number');
      }
    }
    return input;
  }
});

export const SolvePseudoInput = Object.freeze({
  make(A, B, options) { return { A, B, options }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('solvePseudo', 'Expected {A, B, options?}');
    checkMatrix(input.A, 'solvePseudo');
    checkMatrix(input.B, 'solvePseudo');
    if (input.A.rows !== input.B.rows) {
      throw new DecodeError('solvePseudo', 'A.rows must equal B.rows');
    }
    return input;
  }
});

export const RankInput = Object.freeze({
  make(matrix, rcond) { return { matrix, rcond }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('rank', 'Expected {matrix, rcond?}');
    checkMatrix(input.matrix, 'rank');
    return input;
  }
});

export const ConditionNumberInput = Object.freeze({
  make(matrix) { return { matrix }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('conditionNumber', 'Expected {matrix}');
    checkMatrix(input.matrix, 'conditionNumber');
    return input;
  }
});

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================
export function pseudoInverseValidated(input) {
  const d = PseudoInverseInput.decode(input);
  return pseudoInverse(d.matrix, d.options);
}

export function solveWithPseudoInverseValidated(input) {
  const d = SolvePseudoInput.decode(input);
  return solveWithPseudoInverse(d.A, d.B, d.options);
}

export function rankValidated(input) {
  const d = RankInput.decode(input);
  return rank(d.matrix, d.rcond);
}

export function conditionNumberValidated(input) {
  const d = ConditionNumberInput.decode(input);
  return conditionNumber(d.matrix);
}

// ============================================================================
// POLICY-AWARE WRAPPERS
// ============================================================================
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

function isValidMatrixFinite(m) {
  if (!(m instanceof ML.MLMatrix)) return false;
  for (let i = 0; i < m.data.length; i++) {
    if (!Number.isFinite(m.data[i])) return false;
  }
  return true;
}

export function pseudoInverseWithPolicies(matrix, policy, options) {
  return policyCustom(
    'MatrixPseudoInverse.pseudoInverseWithPolicies',
    () => pseudoInverse(matrix, options),
    isValidMatrixFinite,
    (m) => ({ rows: m.rows, columns: m.columns }),
    policy
  );
}

export function solveWithPseudoInverseWithPolicies(A, B, policy, options) {
  return policyCustom(
    'MatrixPseudoInverse.solveWithPseudoInverseWithPolicies',
    () => solveWithPseudoInverse(A, B, options),
    isValidMatrixFinite,
    (m) => ({ rows: m.rows, columns: m.columns }),
    policy
  );
}

export function rankWithPolicies(matrix, policy, rcond) {
  return policyScalar(
    'MatrixPseudoInverse.rankWithPolicies',
    () => rank(matrix, rcond),
    (r) => ({ rows: matrix.rows, columns: matrix.columns, rank: r }),
    policy
  );
}

export function conditionNumberWithPolicies(matrix, policy) {
  return policyScalar(
    'MatrixPseudoInverse.conditionNumberWithPolicies',
    () => conditionNumber(matrix),
    (r) => ({ rows: matrix.rows, columns: matrix.columns, condition: r }),
    policy
  );
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default {
  DecodeError,
  DomainViolationError,
  inverseLU,
  pseudoInverse,
  pseudoInverseFromSVD,
  solveWithPseudoInverse,
  rank,
  conditionNumber,
  PseudoInverseInput,
  SolvePseudoInput,
  RankInput,
  ConditionNumberInput,
  pseudoInverseValidated,
  solveWithPseudoInverseValidated,
  rankValidated,
  conditionNumberValidated,
  pseudoInverseWithPolicies,
  solveWithPseudoInverseWithPolicies,
  rankWithPolicies,
  conditionNumberWithPolicies
};