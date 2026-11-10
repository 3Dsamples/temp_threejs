// file number : 048
// full path name : src/math/048_MatrixCovariance.js
// description : High-performance dedicated Covariance module reimplemented from mljs/matrix stat.js covariance section. Provides sample and population covariance for MLMatrix data, matrix-wise covariance (pairwise columns), vector-to-vector covariance, weighted covariance, incremental/online covariance (Welford), and shrinkage covariance (Ledoit-Wolf-lite). Works on the flat typed array backing of MLMatrix (038) with cache-friendly two-pass loops and DoubleDouble high-precision accumulation. Includes policy-aware wrappers via 030_Policy and schema validators.
// best for : PCA pre-processing, PBR covariance analysis, physics constraint coupling, portfolio-style risk aggregation, AI sensor fusion, and any covariance-driven pipeline at 10k+ entity scale on Android 64-bit.
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
    this.name = 'MatrixCovarianceDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'MatrixCovarianceDomainViolationError';
    this.operation = operation;
  }
}

// ============================================================================
// HELPERS
// ============================================================================
function checkMatrix(m, op) {
  if (!(m instanceof ML.MLMatrix)) throw new DecodeError(op, 'MLMatrix instance required');
}

function valueAt(m, i, j) {
  return m.dd ? m.data[(i * m.columns + j) * 2 + 1] : m.data[i * m.columns + j];
}

// ============================================================================
// MATRIX COVARIANCE (pairwise columns)
// ============================================================================
export function covariance(matrix, options) {
  checkMatrix(matrix, 'covariance');
  const opts = options || {};
  const sample = opts.sample !== false;
  const useDD = opts.dd === true || matrix.dd;
  const m = matrix.rows;
  const n = matrix.columns;
  if (m < 2) throw new DomainViolationError('covariance', 'At least 2 rows required');
  const denom = sample ? m - 1 : m;

  const out = new ML.MLMatrix(n, n);
  const outData = out.data;
  const means = new ARRAY_TYPE(n);

  if (!useDD) {
    const data = matrix.data;
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let i = 0; i < m; i++) s += data[i * n + j];
      means[j] = s / m;
    }
    for (let a = 0; a < n; a++) {
      const ma = means[a];
      for (let b = a; b < n; b++) {
        const mb = means[b];
        let s = 0;
        for (let i = 0; i < m; i++) {
          s += (data[i * n + a] - ma) * (data[i * n + b] - mb);
        }
        const cov = s / denom;
        outData[a * n + b] = cov;
        outData[b * n + a] = cov;
      }
    }
    return out;
  }

  for (let j = 0; j < n; j++) {
    let acc = [0, 0];
    for (let i = 0; i < m; i++) {
      acc = DD.add(acc, DD.fromDouble(valueAt(matrix, i, j)));
    }
    means[j] = DD.toDouble(DD.divide(acc, DD.fromDouble(m)));
  }
  for (let a = 0; a < n; a++) {
    const ma = DD.fromDouble(means[a]);
    for (let b = a; b < n; b++) {
      const mb = DD.fromDouble(means[b]);
      let acc = [0, 0];
      for (let i = 0; i < m; i++) {
        const da = DD.subtract(DD.fromDouble(valueAt(matrix, i, a)), ma);
        const db = DD.subtract(DD.fromDouble(valueAt(matrix, i, b)), mb);
        acc = DD.add(acc, DD.multiply(da, db));
      }
      const cov = DD.toDouble(DD.divide(acc, DD.fromDouble(denom)));
      outData[a * n + b] = cov;
      outData[b * n + a] = cov;
    }
  }
  return out;
}

// ============================================================================
// VECTOR-TO-VECTOR COVARIANCE (two column vectors of same length)
// ============================================================================
export function covarianceVectors(x, y, options) {
  checkMatrix(x, 'covarianceVectors');
  checkMatrix(y, 'covarianceVectors');
  const opts = options || {};
  const sample = opts.sample !== false;
  const useDD = opts.dd === true || x.dd || y.dd;
  const m = x.rows;
  if (y.rows !== m) throw new DomainViolationError('covarianceVectors', 'vectors must have same length');
  if (m < 2) throw new DomainViolationError('covarianceVectors', 'At least 2 elements required');
  const denom = sample ? m - 1 : m;

  if (!useDD) {
    let sx = 0, sy = 0;
    for (let i = 0; i < m; i++) {
      sx += valueAt(x, i, 0);
      sy += valueAt(y, i, 0);
    }
    const mx = sx / m;
    const my = sy / m;
    let s = 0;
    for (let i = 0; i < m; i++) {
      s += (valueAt(x, i, 0) - mx) * (valueAt(y, i, 0) - my);
    }
    return s / denom;
  }

  let accX = [0, 0], accY = [0, 0];
  for (let i = 0; i < m; i++) {
    accX = DD.add(accX, DD.fromDouble(valueAt(x, i, 0)));
    accY = DD.add(accY, DD.fromDouble(valueAt(y, i, 0)));
  }
  const mxDD = DD.divide(accX, DD.fromDouble(m));
  const myDD = DD.divide(accY, DD.fromDouble(m));
  let acc = [0, 0];
  for (let i = 0; i < m; i++) {
    const dx = DD.subtract(DD.fromDouble(valueAt(x, i, 0)), mxDD);
    const dy = DD.subtract(DD.fromDouble(valueAt(y, i, 0)), myDD);
    acc = DD.add(acc, DD.multiply(dx, dy));
  }
  return DD.toDouble(DD.divide(acc, DD.fromDouble(denom)));
}

// ============================================================================
// WEIGHTED COVARIANCE
// ============================================================================
export function weightedCovariance(matrix, weights, options) {
  checkMatrix(matrix, 'weightedCovariance');
  if (!Array.isArray(weights) && !(weights instanceof Float64Array) && !(weights instanceof Float32Array)) {
    throw new DecodeError('weightedCovariance', 'weights must be array-like');
  }
  const m = matrix.rows;
  const n = matrix.columns;
  if (weights.length !== m) {
    throw new DomainViolationError('weightedCovariance', 'weights length must equal rows');
  }
  let totalWeight = 0;
  for (let i = 0; i < m; i++) totalWeight += weights[i];
  if (totalWeight <= 0) throw new DomainViolationError('weightedCovariance', 'weights must sum > 0');

  const out = new ML.MLMatrix(n, n);
  const outData = out.data;
  const means = new ARRAY_TYPE(n);
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let i = 0; i < m; i++) s += weights[i] * valueAt(matrix, i, j);
    means[j] = s / totalWeight;
  }
  for (let a = 0; a < n; a++) {
    for (let b = a; b < n; b++) {
      let s = 0;
      for (let i = 0; i < m; i++) {
        const da = valueAt(matrix, i, a) - means[a];
        const db = valueAt(matrix, i, b) - means[b];
        s += weights[i] * da * db;
      }
      const cov = s / totalWeight;
      outData[a * n + b] = cov;
      outData[b * n + a] = cov;
    }
  }
  return out;
}

// ============================================================================
// INCREMENTAL / ONLINE COVARIANCE (Welford)
// ============================================================================
export class OnlineCovariance {
  constructor(nColumns) {
    this.n = nColumns;
    this.count = 0;
    this.mean = new ARRAY_TYPE(nColumns);
    this.m2 = new ARRAY_TYPE(nColumns * nColumns);
  }

  update(sample) {
    if (sample.length !== this.n) throw new DomainViolationError('update', 'sample length mismatch');
    this.count++;
    const k = this.count;
    const delta = new ARRAY_TYPE(this.n);
    for (let i = 0; i < this.n; i++) delta[i] = sample[i] - this.mean[i];
    for (let i = 0; i < this.n; i++) this.mean[i] += delta[i] / k;
    for (let i = 0; i < this.n; i++) {
      for (let j = 0; j < this.n; j++) {
        this.m2[i * this.n + j] += delta[i] * (sample[j] - this.mean[j]);
      }
    }
  }

  covarianceMatrix(sample) {
    const isSample = sample !== false;
    const denom = isSample ? (this.count - 1) : this.count;
    const out = new ML.MLMatrix(this.n, this.n);
    if (denom <= 0) return out;
    for (let i = 0; i < this.n * this.n; i++) out.data[i] = this.m2[i] / denom;
    return out;
  }

  mean() {
    const out = ML.MLMatrix.rowVector(this.n, this.mean);
    return out;
  }

  variance() {
    const out = new ARRAY_TYPE(this.n);
    for (let i = 0; i < this.n; i++) {
      out[i] = this.count > 1 ? this.m2[i * this.n + i] / (this.count - 1) : 0;
    }
    return out;
  }

  reset() {
    this.count = 0;
    this.mean.fill(0);
    this.m2.fill(0);
  }
}

// ============================================================================
// SHRINKAGE COVARIANCE (Ledoit-Wolf-lite)
// ============================================================================
export function shrinkageCovariance(matrix, lambda, options) {
  checkMatrix(matrix, 'shrinkageCovariance');
  const L = lambda === undefined ? 0.1 : lambda;
  if (L < 0 || L > 1) throw new DomainViolationError('shrinkageCovariance', 'lambda must be in [0,1]');
  const S = covariance(matrix, options);
  const n = S.columns;
  // Shrink toward scaled identity
  let trace = 0;
  for (let i = 0; i < n; i++) trace += S.data[i * n + i];
  const targetDiag = trace / n;

  const out = new ML.MLMatrix(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) out.data[i * n + j] = (1 - L) * S.data[i * n + j] + L * targetDiag;
      else out.data[i * n + j] = (1 - L) * S.data[i * n + j];
    }
  }
  return out;
}

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================
export const CovarianceInput = Object.freeze({
  make(matrix, options) { return { matrix, options }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('covariance', 'Expected {matrix, options?}');
    checkMatrix(input.matrix, 'covariance');
    return input;
  }
});

export const CovarianceVectorsInput = Object.freeze({
  make(x, y, options) { return { x, y, options }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('covarianceVectors', 'Expected {x, y, options?}');
    checkMatrix(input.x, 'covarianceVectors');
    checkMatrix(input.y, 'covarianceVectors');
    return input;
  }
});

export const WeightedCovarianceInput = Object.freeze({
  make(matrix, weights, options) { return { matrix, weights, options }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('weightedCovariance', 'Expected {matrix, weights, options?}');
    checkMatrix(input.matrix, 'weightedCovariance');
    if (!Array.isArray(input.weights) && !(input.weights instanceof Float64Array)) {
      throw new DecodeError('weightedCovariance', 'weights must be array-like');
    }
    return input;
  }
});

export const ShrinkageCovarianceInput = Object.freeze({
  make(matrix, lambda, options) { return { matrix, lambda, options }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('shrinkageCovariance', 'Expected {matrix, lambda?, options?}');
    checkMatrix(input.matrix, 'shrinkageCovariance');
    return input;
  }
});

export const OnlineCovarianceInput = Object.freeze({
  make(nColumns) { return { nColumns }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('onlineCovariance', 'Expected {nColumns}');
    if (!Number.isInteger(input.nColumns) || input.nColumns <= 0) {
      throw new DecodeError('onlineCovariance', 'nColumns must be positive integer');
    }
    return input;
  }
});

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================
export function covarianceValidated(input) {
  const d = CovarianceInput.decode(input);
  return covariance(d.matrix, d.options);
}

export function covarianceVectorsValidated(input) {
  const d = CovarianceVectorsInput.decode(input);
  return covarianceVectors(d.x, d.y, d.options);
}

export function weightedCovarianceValidated(input) {
  const d = WeightedCovarianceInput.decode(input);
  return weightedCovariance(d.matrix, d.weights, d.options);
}

export function shrinkageCovarianceValidated(input) {
  const d = ShrinkageCovarianceInput.decode(input);
  return shrinkageCovariance(d.matrix, d.lambda, d.options);
}

export function onlineCovarianceValidated(input) {
  const d = OnlineCovarianceInput.decode(input);
  return new OnlineCovariance(d.nColumns);
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

function isValidMatrixFinite(m) {
  if (!(m instanceof ML.MLMatrix)) return false;
  for (let i = 0; i < m.data.length; i++) {
    if (!Number.isFinite(m.data[i])) return false;
  }
  return true;
}

export function covarianceWithPolicies(matrix, policy, options) {
  return policyCustom(
    'MatrixCovariance.covarianceWithPolicies',
    () => covariance(matrix, options),
    isValidMatrixFinite,
    (m) => ({ rows: m.rows, columns: m.columns }),
    policy
  );
}

export function covarianceVectorsWithPolicies(x, y, policy, options) {
  return policyCustom(
    'MatrixCovariance.covarianceVectorsWithPolicies',
    () => covarianceVectors(x, y, options),
    (r) => typeof r === 'number' && Number.isFinite(r),
    (r) => ({ result: r }),
    policy
  );
}

export function weightedCovarianceWithPolicies(matrix, weights, policy, options) {
  return policyCustom(
    'MatrixCovariance.weightedCovarianceWithPolicies',
    () => weightedCovariance(matrix, weights, options),
    isValidMatrixFinite,
    (m) => ({ rows: m.rows, columns: m.columns }),
    policy
  );
}

export function shrinkageCovarianceWithPolicies(matrix, lambda, policy, options) {
  return policyCustom(
    'MatrixCovariance.shrinkageCovarianceWithPolicies',
    () => shrinkageCovariance(matrix, lambda, options),
    isValidMatrixFinite,
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
  covariance,
  covarianceVectors,
  weightedCovariance,
  OnlineCovariance,
  shrinkageCovariance,
  CovarianceInput,
  CovarianceVectorsInput,
  WeightedCovarianceInput,
  ShrinkageCovarianceInput,
  OnlineCovarianceInput,
  covarianceValidated,
  covarianceVectorsValidated,
  weightedCovarianceValidated,
  shrinkageCovarianceValidated,
  onlineCovarianceValidated,
  covarianceWithPolicies,
  covarianceVectorsWithPolicies,
  weightedCovarianceWithPolicies,
  shrinkageCovarianceWithPolicies
};