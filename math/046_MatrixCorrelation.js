// file number : 046
// full path name : src/math/046_MatrixCorrelation.js
// description : High-performance Pearson correlation matrix reimplemented from mljs/matrix stat.js (correlation). Computes the pairwise Pearson correlation matrix from an m×n data matrix (rows = observations, columns = variables). Returns a symmetric n×n matrix with unit diagonal. Works on the flat typed array backing of MLMatrix (038) with cache-friendly two-pass loops. Supports DoubleDouble precision for high-accuracy accumulation, policy-aware wrappers via 030_Policy, and schema validators. Uses the stable mean/stddev kernel from 053_MatrixStat.
// best for : Feature correlation analysis, PCA pre-processing, physics constraint coupling analysis, PBR covariance fitting, AI sensor stream correlation, procedural scatter validation, and any correlation-based pipeline at 10k+ entity scale on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS } from '../core/002_Constants.js';
import * as DD from './014_DoubleDouble.js';
import * as ML from './038_MatrixML.js';
import * as PolicyModule from './030_Policy.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'MatrixCorrelationDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'MatrixCorrelationDomainViolationError';
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
// CORRELATION MATRIX
// ============================================================================
export function correlation(matrix, options) {
  checkMatrix(matrix, 'correlation');
  const opts = options || {};
  const useDD = opts.dd === true || matrix.dd;
  const m = matrix.rows;
  const n = matrix.columns;

  if (m < 2) {
    throw new DomainViolationError('correlation', 'At least 2 rows required');
  }

  const out = new ML.MLMatrix(n, n, { dd: false });
  const outData = out.data;

  const means = new ARRAY_TYPE(n);
  const stds = new ARRAY_TYPE(n);

  if (!useDD) {
    // Two-pass: compute means, then stds, then correlations
    for (let j = 0; j < n; j++) {
      let sum = 0;
      for (let i = 0; i < m; i++) sum += matrix.data[i * n + j];
      means[j] = sum / m;
    }
    for (let j = 0; j < n; j++) {
      let s = 0;
      const mj = means[j];
      for (let i = 0; i < m; i++) {
        const d = matrix.data[i * n + j] - mj;
        s += d * d;
      }
      stds[j] = Math.sqrt(s / m);
    }
    for (let a = 0; a < n; a++) {
      outData[a * n + a] = 1;
      for (let b = a + 1; b < n; b++) {
        let s = 0;
        const ma = means[a];
        const mb = means[b];
        for (let i = 0; i < m; i++) {
          s += (matrix.data[i * n + a] - ma) * (matrix.data[i * n + b] - mb);
        }
        const cov = s / m;
        const denom = stds[a] * stds[b];
        const r = denom > 0 ? cov / denom : 0;
        outData[a * n + b] = r;
        outData[b * n + a] = r;
      }
    }
    return out;
  }

  // DD high-precision accumulation
  for (let j = 0; j < n; j++) {
    let sum = [0, 0];
    for (let i = 0; i < m; i++) {
      sum = DD.add(sum, DD.fromDouble(matrix.dd
        ? matrix.data[(i * n + j) * 2 + 1]
        : matrix.data[i * n + j]));
    }
    means[j] = DD.toDouble(DD.divide(sum, DD.fromDouble(m)));
  }
  for (let j = 0; j < n; j++) {
    let s = [0, 0];
    const mj = means[j];
    for (let i = 0; i < m; i++) {
      const v = matrix.dd ? matrix.data[(i * n + j) * 2 + 1] : matrix.data[i * n + j];
      const d = DD.subtract(DD.fromDouble(v), DD.fromDouble(mj));
      s = DD.add(s, DD.multiply(d, d));
    }
    stds[j] = DD.toDouble(DD.sqrt(DD.divide(s, DD.fromDouble(m))));
  }
  for (let a = 0; a < n; a++) {
    outData[a * n + a] = 1;
    for (let b = a + 1; b < n; b++) {
      let s = [0, 0];
      const ma = means[a];
      const mb = means[b];
      for (let i = 0; i < m; i++) {
        const va = matrix.dd ? matrix.data[(i * n + a) * 2 + 1] : matrix.data[i * n + a];
        const vb = matrix.dd ? matrix.data[(i * n + b) * 2 + 1] : matrix.data[i * n + b];
        const da = DD.subtract(DD.fromDouble(va), DD.fromDouble(ma));
        const db = DD.subtract(DD.fromDouble(vb), DD.fromDouble(mb));
        s = DD.add(s, DD.multiply(da, db));
      }
      const cov = DD.divide(s, DD.fromDouble(m));
      const denom = DD.multiply(DD.fromDouble(stds[a]), DD.fromDouble(stds[b]));
      const r = DD.toDouble(denom) > 0 ? DD.toDouble(DD.divide(cov, denom)) : 0;
      outData[a * n + b] = r;
      outData[b * n + a] = r;
    }
  }
  return out;
}

// ============================================================================
// SPEARMAN RANK CORRELATION
// ============================================================================
function rankColumn(matrix, col) {
  const m = matrix.rows;
  const n = matrix.columns;
  const idx = new Array(m);
  for (let i = 0; i < m; i++) idx[i] = i;
  idx.sort((a, b) => {
    const va = matrix.dd ? matrix.data[(a * n + col) * 2 + 1] : matrix.data[a * n + col];
    const vb = matrix.dd ? matrix.data[(b * n + col) * 2 + 1] : matrix.data[b * n + col];
    return va - vb;
  });
  const ranks = new ARRAY_TYPE(m);
  let i = 0;
  while (i < m) {
    const v = matrix.dd ? matrix.data[(idx[i] * n + col) * 2 + 1] : matrix.data[idx[i] * n + col];
    let j = i + 1;
    while (j < m) {
      const vj = matrix.dd ? matrix.data[(idx[j] * n + col) * 2 + 1] : matrix.data[idx[j] * n + col];
      if (vj !== v) break;
      j++;
    }
    const avg = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) ranks[idx[k]] = avg;
    i = j;
  }
  return ranks;
}

export function spearmanCorrelation(matrix, options) {
  checkMatrix(matrix, 'spearmanCorrelation');
  const opts = options || {};
  const m = matrix.rows;
  const n = matrix.columns;
  if (m < 2) throw new DomainViolationError('spearmanCorrelation', 'At least 2 rows required');

  const ranked = new ML.MLMatrix(m, n);
  for (let j = 0; j < n; j++) {
    const r = rankColumn(matrix, j);
    for (let i = 0; i < m; i++) ranked.data[i * n + j] = r[i];
  }
  return correlation(ranked, opts);
}

// ============================================================================
// KENDALL TAU CORRELATION (pairwise tau-b)
// ============================================================================
export function kendallCorrelation(matrix, options) {
  checkMatrix(matrix, 'kendallCorrelation');
  const m = matrix.rows;
  const n = matrix.columns;
  if (m < 2) throw new DomainViolationError('kendallCorrelation', 'At least 2 rows required');

  const out = new ML.MLMatrix(n, n);
  const outData = out.data;
  for (let a = 0; a < n; a++) {
    outData[a * n + a] = 1;
    for (let b = a + 1; b < n; b++) {
      let concordant = 0;
      let discordant = 0;
      let tieA = 0;
      let tieB = 0;
      for (let i = 0; i < m - 1; i++) {
        const vai = matrix.dd ? matrix.data[(i * n + a) * 2 + 1] : matrix.data[i * n + a];
        const vbi = matrix.dd ? matrix.data[(i * n + b) * 2 + 1] : matrix.data[i * n + b];
        for (let j = i + 1; j < m; j++) {
          const vaj = matrix.dd ? matrix.data[(j * n + a) * 2 + 1] : matrix.data[j * n + a];
          const vbj = matrix.dd ? matrix.data[(j * n + b) * 2 + 1] : matrix.data[j * n + b];
          const da = vaj - vai;
          const db = vbj - vbi;
          if (da === 0 && db === 0) continue;
          if (da === 0) tieA++;
          else if (db === 0) tieB++;
          else if ((da > 0 && db > 0) || (da < 0 && db < 0)) concordant++;
          else discordant++;
        }
      }
      const n0 = (concordant + discordant + tieA);
      const n1 = (concordant + discordant + tieB);
      const denom = Math.sqrt(n0 * n1);
      const tau = denom > 0 ? (concordant - discordant) / denom : 0;
      outData[a * n + b] = tau;
      outData[b * n + a] = tau;
    }
  }
  return out;
}

// ============================================================================
// COVARIANCE (paired, sample or population)
// ============================================================================
export function covariance(matrix, options) {
  checkMatrix(matrix, 'covariance');
  const opts = options || {};
  const sample = opts.sample !== false;
  const dd = opts.dd === true || matrix.dd;
  const m = matrix.rows;
  const n = matrix.columns;
  if (m < 2) throw new DomainViolationError('covariance', 'At least 2 rows required');
  const denom = sample ? m - 1 : m;

  const out = new ML.MLMatrix(n, n);
  const outData = out.data;
  const means = new ARRAY_TYPE(n);

  for (let j = 0; j < n; j++) {
    let s = 0;
    if (dd) {
      let acc = [0, 0];
      for (let i = 0; i < m; i++) {
        acc = DD.add(acc, DD.fromDouble(matrix.dd ? matrix.data[(i * n + j) * 2 + 1] : matrix.data[i * n + j]));
      }
      means[j] = DD.toDouble(DD.divide(acc, DD.fromDouble(m)));
    } else {
      for (let i = 0; i < m; i++) s += matrix.data[i * n + j];
      means[j] = s / m;
    }
  }

  for (let a = 0; a < n; a++) {
    for (let b = a; b < n; b++) {
      let s = 0;
      if (dd) {
        let acc = [0, 0];
        for (let i = 0; i < m; i++) {
          const va = matrix.dd ? matrix.data[(i * n + a) * 2 + 1] : matrix.data[i * n + a];
          const vb = matrix.dd ? matrix.data[(i * n + b) * 2 + 1] : matrix.data[i * n + b];
          const da = DD.subtract(DD.fromDouble(va), DD.fromDouble(means[a]));
          const db = DD.subtract(DD.fromDouble(vb), DD.fromDouble(means[b]));
          acc = DD.add(acc, DD.multiply(da, db));
        }
        s = DD.toDouble(DD.divide(acc, DD.fromDouble(denom)));
      } else {
        const ma = means[a];
        const mb = means[b];
        for (let i = 0; i < m; i++) {
          s += (matrix.data[i * n + a] - ma) * (matrix.data[i * n + b] - mb);
        }
        s /= denom;
      }
      outData[a * n + b] = s;
      outData[b * n + a] = s;
    }
  }
  return out;
}

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================
export const CorrelationInput = Object.freeze({
  make(matrix, options) { return { matrix, options }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('correlation', 'Expected {matrix, options?}');
    checkMatrix(input.matrix, 'correlation');
    return input;
  }
});

export const SpearmanInput = CorrelationInput;
export const KendallInput = CorrelationInput;
export const CovarianceInput = CorrelationInput;

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================
export function correlationValidated(input) {
  const d = CorrelationInput.decode(input);
  return correlation(d.matrix, d.options);
}

export function spearmanCorrelationValidated(input) {
  const d = SpearmanInput.decode(input);
  return spearmanCorrelation(d.matrix, d.options);
}

export function kendallCorrelationValidated(input) {
  const d = KendallInput.decode(input);
  return kendallCorrelation(d.matrix, d.options);
}

export function covarianceValidated(input) {
  const d = CovarianceInput.decode(input);
  return covariance(d.matrix, d.options);
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

function isValidCorrelationMatrix(m) {
  if (!(m instanceof ML.MLMatrix)) return false;
  for (let i = 0; i < m.data.length; i++) {
    if (!Number.isFinite(m.data[i])) return false;
  }
  return true;
}

export function correlationWithPolicies(matrix, policy, options) {
  return policyCustom(
    'MatrixCorrelation.correlationWithPolicies',
    () => correlation(matrix, options),
    isValidCorrelationMatrix,
    (m) => ({ rows: m.rows, columns: m.columns }),
    policy
  );
}

export function spearmanCorrelationWithPolicies(matrix, policy, options) {
  return policyCustom(
    'MatrixCorrelation.spearmanCorrelationWithPolicies',
    () => spearmanCorrelation(matrix, options),
    isValidCorrelationMatrix,
    (m) => ({ rows: m.rows, columns: m.columns }),
    policy
  );
}

export function kendallCorrelationWithPolicies(matrix, policy, options) {
  return policyCustom(
    'MatrixCorrelation.kendallCorrelationWithPolicies',
    () => kendallCorrelation(matrix, options),
    isValidCorrelationMatrix,
    (m) => ({ rows: m.rows, columns: m.columns }),
    policy
  );
}

export function covarianceWithPolicies(matrix, policy, options) {
  return policyCustom(
    'MatrixCorrelation.covarianceWithPolicies',
    () => covariance(matrix, options),
    isValidCorrelationMatrix,
    (m) => ({ rows: m.rows, columns: m.columns }),
    policy
  );
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default {
  DecodeError,
  DomainViolationError,
  correlation,
  spearmanCorrelation,
  kendallCorrelation,
  covariance,
  CorrelationInput,
  SpearmanInput,
  KendallInput,
  CovarianceInput,
  correlationValidated,
  spearmanCorrelationValidated,
  kendallCorrelationValidated,
  covarianceValidated,
  correlationWithPolicies,
  spearmanCorrelationWithPolicies,
  kendallCorrelationWithPolicies,
  covarianceWithPolicies
};