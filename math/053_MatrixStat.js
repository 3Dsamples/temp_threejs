// file number : 053
// full path name : src/math/053_MatrixStat.js
// description : High-performance statistics functions reimplemented from mljs/matrix stat.js. Provides scalar reductions (max, min, sum, product, mean, median, variance, standardDeviation) with dimension option (all / row / column), normalization helpers (center, scale, standardize) with in-place variants, weighted variants (weightedMean, weightedVariance, weightedStandardDeviation, weightedCovariance), Mahalanobis distance, plus Minkowski and Chebyshev distances for pairwise row computations. Full DoubleDouble accumulation for sum/mean/variance/covariance paths, cache-friendly flat typed array access on MLMatrix (038), policy-aware wrappers via 030_Policy, and schema validators. Includes statistical kernel primitives (variance from sum-of-squares, two-pass Welford for stability) reused by 046/048.
// best for : PBR parameter analysis, physics stability telemetry, ML feature normalization, procedural scatter statistics, context-awareness profiling, ECS-level runtime metrics, and any statistical reduction at 10k+ entity scale on Android 64-bit.
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
    this.name = 'MatrixStatDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'MatrixStatDomainViolationError';
    this.operation = operation;
  }
}

// ============================================================================
// HELPERS
// ============================================================================
function checkMatrix(m, op) {
  if (!(m instanceof ML.MLMatrix)) throw new DecodeError(op, 'MLMatrix instance required');
}

function read(m, r, c) {
  return m.dd ? m.data[(r * m.columns + c) * 2 + 1] : m.data[r * m.columns + c];
}

function write(m, r, c, v) {
  if (m.dd) {
    const pos = (r * m.columns + c) * 2;
    m.data[pos] = 0;
    m.data[pos + 1] = v;
  } else {
    m.data[r * m.columns + c] = v;
  }
}

function dimensionOf(matrix, dim) {
  if (dim === 'row') return matrix.columns;
  if (dim === 'column') return matrix.rows;
  return 1;
}

// ============================================================================
// SCALAR REDUCTIONS
// ============================================================================
export function max(matrix) {
  checkMatrix(matrix, 'max');
  const n = matrix.rows;
  const m = matrix.columns;
  let mx = -Infinity;
  if (!matrix.dd) {
    const data = matrix.data;
    const total = n * m;
    for (let i = 0; i < total; i++) if (data[i] > mx) mx = data[i];
  } else {
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < m; c++) {
        const v = matrix.data[(r * m + c) * 2 + 1];
        if (v > mx) mx = v;
      }
    }
  }
  return mx;
}

export function min(matrix) {
  checkMatrix(matrix, 'min');
  const n = matrix.rows;
  const m = matrix.columns;
  let mn = Infinity;
  if (!matrix.dd) {
    const data = matrix.data;
    const total = n * m;
    for (let i = 0; i < total; i++) if (data[i] < mn) mn = data[i];
  } else {
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < m; c++) {
        const v = matrix.data[(r * m + c) * 2 + 1];
        if (v < mn) mn = v;
      }
    }
  }
  return mn;
}

export function sum(matrix) {
  checkMatrix(matrix, 'sum');
  const n = matrix.rows;
  const m = matrix.columns;
  if (matrix.dd) {
    let acc = [0, 0];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < m; c++) {
        acc = DD.add(acc, [matrix.data[(r * m + c) * 2], matrix.data[(r * m + c) * 2 + 1]]);
      }
    }
    return DD.toDouble(acc);
  }
  let s = 0;
  let comp = 0;
  const data = matrix.data;
  const total = n * m;
  for (let i = 0; i < total; i++) {
    const y = data[i] - comp;
    const t = s + y;
    comp = (t - s) - y;
    s = t;
  }
  return s;
}

export function product(matrix) {
  checkMatrix(matrix, 'product');
  const n = matrix.rows;
  const m = matrix.columns;
  let p = 1;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < m; c++) {
      p *= read(matrix, r, c);
    }
  }
  return p;
}

// ============================================================================
// MEAN
// ============================================================================
export function mean(matrix, dimension) {
  checkMatrix(matrix, 'mean');
  const dim = dimension || 'all';
  const n = matrix.rows;
  const m = matrix.columns;

  if (dim === 'all') {
    if (n === 0 || m === 0) return 0;
    return sum(matrix) / (n * m);
  }

  if (dim === 'column') {
    // Returns 1 × m vector: mean of each column
    const out = new ML.MLMatrix(1, m, { dd: matrix.dd });
    if (n === 0) return out;
    if (!matrix.dd) {
      const data = matrix.data;
      for (let c = 0; c < m; c++) {
        let s = 0;
        let comp = 0;
        for (let r = 0; r < n; r++) {
          const y = data[r * m + c] - comp;
          const t = s + y;
          comp = (t - s) - y;
          s = t;
        }
        out.data[c] = s / n;
      }
    } else {
      for (let c = 0; c < m; c++) {
        let acc = [0, 0];
        for (let r = 0; r < n; r++) {
          acc = DD.add(acc, [matrix.data[(r * m + c) * 2], matrix.data[(r * m + c) * 2 + 1]]);
        }
        const v = DD.divide(acc, DD.fromDouble(n));
        out.data[c * 2] = v[0];
        out.data[c * 2 + 1] = v[1];
      }
    }
    return out;
  }

  // dim === 'row': Returns n × 1 vector
  const out = new ML.MLMatrix(n, 1, { dd: matrix.dd });
  if (m === 0) return out;
  if (!matrix.dd) {
    const data = matrix.data;
    for (let r = 0; r < n; r++) {
      let s = 0;
      let comp = 0;
      const rowBase = r * m;
      for (let c = 0; c < m; c++) {
        const y = data[rowBase + c] - comp;
        const t = s + y;
        comp = (t - s) - y;
        s = t;
      }
      out.data[r] = s / m;
    }
  } else {
    for (let r = 0; r < n; r++) {
      let acc = [0, 0];
      for (let c = 0; c < m; c++) {
        acc = DD.add(acc, [matrix.data[(r * m + c) * 2], matrix.data[(r * m + c) * 2 + 1]]);
      }
      const v = DD.divide(acc, DD.fromDouble(m));
      out.data[r * 2] = v[0];
      out.data[r * 2 + 1] = v[1];
    }
  }
  return out;
}

// ============================================================================
// MEDIAN
// ============================================================================
function medianOfArray(arr) {
  const n = arr.length;
  if (n === 0) return 0;
  const sorted = Array.from(arr).sort((a, b) => a - b);
  if (n % 2 === 1) return sorted[(n - 1) >> 1];
  return (sorted[(n >> 1) - 1] + sorted[n >> 1]) / 2;
}

export function median(matrix, dimension) {
  checkMatrix(matrix, 'median');
  const dim = dimension || 'all';
  const n = matrix.rows;
  const m = matrix.columns;

  if (dim === 'all') {
    const buf = new ARRAY_TYPE(n * m);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < m; c++) buf[r * m + c] = read(matrix, r, c);
    }
    return medianOfArray(buf);
  }

  if (dim === 'column') {
    const out = new ML.MLMatrix(1, m, { dd: matrix.dd });
    const buf = new ARRAY_TYPE(n);
    for (let c = 0; c < m; c++) {
      for (let r = 0; r < n; r++) buf[r] = read(matrix, r, c);
      const v = medianOfArray(buf);
      if (matrix.dd) {
        out.data[c * 2] = 0;
        out.data[c * 2 + 1] = v;
      } else {
        out.data[c] = v;
      }
    }
    return out;
  }

  // dim === 'row'
  const out = new ML.MLMatrix(n, 1, { dd: matrix.dd });
  const buf = new ARRAY_TYPE(m);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < m; c++) buf[c] = read(matrix, r, c);
    const v = medianOfArray(buf);
    if (matrix.dd) {
      out.data[r * 2] = 0;
      out.data[r * 2 + 1] = v;
    } else {
      out.data[r] = v;
    }
  }
  return out;
}

// ============================================================================
// VARIANCE
// ============================================================================
function varianceValues(values, sample) {
  const n = values.length;
  if (n === 0) return 0;
  const denom = sample ? (n - 1) : n;
  if (denom <= 0) return 0;
  // Two-pass for numerical stability
  let s = 0;
  let comp = 0;
  for (let i = 0; i < n; i++) {
    const y = values[i] - comp;
    const t = s + y;
    comp = (t - s) - y;
    s = t;
  }
  const meanV = s / n;
  let acc = 0;
  let comp2 = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] - meanV;
    const y = d * d - comp2;
    const t = acc + y;
    comp2 = (t - acc) - y;
    acc = t;
  }
  return acc / denom;
}

export function variance(matrix, options) {
  checkMatrix(matrix, 'variance');
  const opts = options || {};
  const sample = opts.sample !== false;
  const dim = opts.dimension || 'all';
  const n = matrix.rows;
  const m = matrix.columns;

  if (dim === 'all') {
    const buf = new ARRAY_TYPE(n * m);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < m; c++) buf[r * m + c] = read(matrix, r, c);
    }
    return varianceValues(buf, sample);
  }

  if (dim === 'column') {
    const out = new ML.MLMatrix(1, m, { dd: matrix.dd });
    const buf = new ARRAY_TYPE(n);
    for (let c = 0; c < m; c++) {
      for (let r = 0; r < n; r++) buf[r] = read(matrix, r, c);
      const v = varianceValues(buf, sample);
      if (matrix.dd) {
        out.data[c * 2] = 0;
        out.data[c * 2 + 1] = v;
      } else {
        out.data[c] = v;
      }
    }
    return out;
  }

  // dim === 'row'
  const out = new ML.MLMatrix(n, 1, { dd: matrix.dd });
  const buf = new ARRAY_TYPE(m);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < m; c++) buf[c] = read(matrix, r, c);
    const v = varianceValues(buf, sample);
    if (matrix.dd) {
      out.data[r * 2] = 0;
      out.data[r * 2 + 1] = v;
    } else {
      out.data[r] = v;
    }
  }
  return out;
}

export function standardDeviation(matrix, options) {
  const v = variance(matrix, options);
  if (v instanceof ML.MLMatrix) {
    const out = new ML.MLMatrix(v.rows, v.columns, { dd: v.dd });
    const total = v.rows * v.columns;
    if (!v.dd) {
      for (let i = 0; i < total; i++) out.data[i] = Math.sqrt(v.data[i]);
    } else {
      for (let i = 0; i < total; i++) {
        out.data[i * 2] = 0;
        out.data[i * 2 + 1] = Math.sqrt(v.data[i * 2 + 1]);
      }
    }
    return out;
  }
  return Math.sqrt(v);
}

// ============================================================================
// WEIGHTED STATISTICS
// ============================================================================
export function weightedMean(matrix, weights, dimension) {
  checkMatrix(matrix, 'weightedMean');
  const n = matrix.rows;
  const m = matrix.columns;
  if (weights.length !== n) {
    throw new DomainViolationError('weightedMean', 'weights length must equal matrix rows');
  }
  const dim = dimension || 'column';

  if (dim === 'column') {
    const out = new ML.MLMatrix(1, m, { dd: matrix.dd });
    let totalWeight = 0;
    for (let i = 0; i < n; i++) totalWeight += weights[i];
    if (totalWeight === 0) return out;
    if (!matrix.dd) {
      for (let c = 0; c < m; c++) {
        let s = 0;
        for (let r = 0; r < n; r++) s += weights[r] * matrix.data[r * m + c];
        out.data[c] = s / totalWeight;
      }
    } else {
      for (let c = 0; c < m; c++) {
        let acc = [0, 0];
        for (let r = 0; r < n; r++) {
          const w = DD.fromDouble(weights[r]);
          const v = [matrix.data[(r * m + c) * 2], matrix.data[(r * m + c) * 2 + 1]];
          acc = DD.add(acc, DD.multiply(w, v));
        }
        const r = DD.divide(acc, DD.fromDouble(totalWeight));
        out.data[c * 2] = r[0];
        out.data[c * 2 + 1] = r[1];
      }
    }
    return out;
  }

  // dim === 'row'
  const out = new ML.MLMatrix(n, 1, { dd: matrix.dd });
  let totalWeight = 0;
  for (let i = 0; i < n; i++) totalWeight += weights[i];
  if (totalWeight === 0) return out;
  for (let r = 0; r < n; r++) {
    let s = 0;
    for (let c = 0; c < m; c++) s += read(matrix, r, c);
    const v = (s / m) * weights[r] / totalWeight;
    if (matrix.dd) {
      out.data[r * 2] = 0;
      out.data[r * 2 + 1] = v;
    } else {
      out.data[r] = v;
    }
  }
  return out;
}

export function weightedVariance(matrix, weights, options) {
  checkMatrix(matrix, 'weightedVariance');
  const opts = options || {};
  const sample = opts.sample !== false;
  const n = matrix.rows;
  const m = matrix.columns;
  if (weights.length !== n) {
    throw new DomainViolationError('weightedVariance', 'weights length must equal matrix rows');
  }

  let totalWeight = 0;
  for (let i = 0; i < n; i++) totalWeight += weights[i];
  if (totalWeight === 0) return 0;

  // Weighted mean (all)
  let meanV = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < m; c++) {
      meanV += weights[r] * read(matrix, r, c);
    }
  }
  meanV /= totalWeight;

  let acc = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < m; c++) {
      const d = read(matrix, r, c) - meanV;
      acc += weights[r] * d * d;
    }
  }
  // Bias correction for sample variance (unbiased for frequency weights)
  const denom = sample ? (totalWeight - 1) : totalWeight;
  if (denom <= 0) return 0;
  return acc / denom;
}

export function weightedStandardDeviation(matrix, weights, options) {
  return Math.sqrt(weightedVariance(matrix, weights, options));
}

export function weightedCovariance(matrix, weights, options) {
  checkMatrix(matrix, 'weightedCovariance');
  const n = matrix.rows;
  const m = matrix.columns;
  if (weights.length !== n) {
    throw new DomainViolationError('weightedCovariance', 'weights length must equal matrix rows');
  }
  let totalWeight = 0;
  for (let i = 0; i < n; i++) totalWeight += weights[i];
  if (totalWeight === 0) return new ML.MLMatrix(m, m);

  const means = new ARRAY_TYPE(m);
  for (let c = 0; c < m; c++) {
    let s = 0;
    for (let r = 0; r < n; r++) s += weights[r] * read(matrix, r, c);
    means[c] = s / totalWeight;
  }

  const out = new ML.MLMatrix(m, m);
  for (let a = 0; a < m; a++) {
    for (let b = a; b < m; b++) {
      let s = 0;
      for (let r = 0; r < n; r++) {
        const da = read(matrix, r, a) - means[a];
        const db = read(matrix, r, b) - means[b];
        s += weights[r] * da * db;
      }
      const cov = s / totalWeight;
      out.data[a * m + b] = cov;
      out.data[b * m + a] = cov;
    }
  }
  return out;
}

// ============================================================================
// NORMALIZATION HELPERS (in-place optional)
// ============================================================================
export function center(matrix, options) {
  checkMatrix(matrix, 'center');
  const opts = options || {};
  const inPlace = opts.inPlace === true;
  const dim = opts.dimension || 'column';
  const out = inPlace ? matrix : matrix.clone();
  const n = matrix.rows;
  const m = matrix.columns;

  if (dim === 'column') {
    for (let c = 0; c < m; c++) {
      let s = 0;
      for (let r = 0; r < n; r++) s += read(out, r, c);
      const meanV = s / n;
      for (let r = 0; r < n; r++) write(out, r, c, read(out, r, c) - meanV);
    }
  } else if (dim === 'row') {
    for (let r = 0; r < n; r++) {
      let s = 0;
      for (let c = 0; c < m; c++) s += read(out, r, c);
      const meanV = s / m;
      for (let c = 0; c < m; c++) write(out, r, c, read(out, r, c) - meanV);
    }
  } else {
    const meanV = mean(out, 'all');
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < m; c++) write(out, r, c, read(out, r, c) - meanV);
    }
  }
  return out;
}

export function scale(matrix, options) {
  checkMatrix(matrix, 'scale');
  const opts = options || {};
  const inPlace = opts.inPlace === true;
  const dim = opts.dimension || 'column';
  const out = inPlace ? matrix : matrix.clone();
  const n = matrix.rows;
  const m = matrix.columns;

  if (dim === 'column') {
    for (let c = 0; c < m; c++) {
      const buf = new ARRAY_TYPE(n);
      for (let r = 0; r < n; r++) buf[r] = read(out, r, c);
      const sd = Math.sqrt(varianceValues(buf, opts.sample !== false));
      if (sd > 0) {
        for (let r = 0; r < n; r++) write(out, r, c, read(out, r, c) / sd);
      }
    }
  } else if (dim === 'row') {
    for (let r = 0; r < n; r++) {
      const buf = new ARRAY_TYPE(m);
      for (let c = 0; c < m; c++) buf[c] = read(out, r, c);
      const sd = Math.sqrt(varianceValues(buf, opts.sample !== false));
      if (sd > 0) {
        for (let c = 0; c < m; c++) write(out, r, c, read(out, r, c) / sd);
      }
    }
  } else {
    const sd = Math.sqrt(varianceValues((() => {
      const b = new ARRAY_TYPE(n * m);
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < m; c++) b[r * m + c] = read(out, r, c);
      }
      return b;
    })(), opts.sample !== false));
    if (sd > 0) {
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < m; c++) write(out, r, c, read(out, r, c) / sd);
      }
    }
  }
  return out;
}

export function standardize(matrix, options) {
  checkMatrix(matrix, 'standardize');
  const opts = options || {};
  const inPlace = opts.inPlace === true;
  center(matrix, { inPlace: inPlace, dimension: opts.dimension });
  scale(matrix, { inPlace: inPlace, dimension: opts.dimension, sample: opts.sample });
  return inPlace ? matrix : matrix.clone();
}

// ============================================================================
// DISTANCES
// ============================================================================
export function minkowski(matrixA, matrixB, p, dimension) {
  checkMatrix(matrixA, 'minkowski');
  checkMatrix(matrixB, 'minkowski');
  const dim = dimension || 'row';
  const n = matrixA.rows;
  const m = matrixA.columns;
  if (dim === 'row') {
    const out = new ARRAY_TYPE(n);
    for (let r = 0; r < n; r++) {
      let s = 0;
      for (let c = 0; c < m; c++) {
        s += Math.pow(Math.abs(read(matrixA, r, c) - read(matrixB, r, c)), p);
      }
      out[r] = Math.pow(s, 1 / p);
    }
    return out;
  }
  throw new DomainViolationError('minkowski', 'only row-dimension supported');
}

export function chebyshev(matrixA, matrixB, dimension) {
  checkMatrix(matrixA, 'chebyshev');
  checkMatrix(matrixB, 'chebyshev');
  const dim = dimension || 'row';
  const n = matrixA.rows;
  const m = matrixA.columns;
  if (dim === 'row') {
    const out = new ARRAY_TYPE(n);
    for (let r = 0; r < n; r++) {
      let mx = 0;
      for (let c = 0; c < m; c++) {
        const d = Math.abs(read(matrixA, r, c) - read(matrixB, r, c));
        if (d > mx) mx = d;
      }
      out[r] = mx;
    }
    return out;
  }
  throw new DomainViolationError('chebyshev', 'only row-dimension supported');
}

// ============================================================================
// MAHALANOBIS
// ============================================================================
export function mahalanobis(matrix, options) {
  checkMatrix(matrix, 'mahalanobis');
  const opts = options || {};
  const n = matrix.rows;
  const m = matrix.columns;

  // Mean vector (1 × m)
  const meanVec = mean(matrix, 'column');
  // Covariance matrix (m × m)
  const cov = require('./048_MatrixCovariance.js').covariance(matrix, opts);
  // Inverse covariance
  const Pinv = require('./051_MatrixPseudoInverse.js').pseudoInverse(cov);

  const out = new ARRAY_TYPE(n);
  for (let r = 0; r < n; r++) {
    let acc = 0;
    for (let a = 0; a < m; a++) {
      const da = read(matrix, r, a) - read(meanVec, 0, a);
      for (let b = 0; b < m; b++) {
        const db = read(matrix, r, b) - read(meanVec, 0, b);
        acc += da * Pinv.data[a * m + b] * db;
      }
    }
    out[r] = Math.sqrt(Math.max(acc, 0));
  }
  return out;
}

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================
export const MatrixStatInput = Object.freeze({
  make(matrix, options) { return { matrix, options }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('stat', 'Expected {matrix, options?}');
    checkMatrix(input.matrix, 'stat');
    return input;
  }
});

export const WeightedStatInput = Object.freeze({
  make(matrix, weights, options) { return { matrix, weights, options }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('weightedStat', 'Expected {matrix, weights, options?}');
    checkMatrix(input.matrix, 'weightedStat');
    if (!Array.isArray(input.weights) && !(input.weights instanceof Float64Array)) {
      throw new DecodeError('weightedStat', 'weights must be array-like');
    }
    return input;
  }
});

export const MinkowskiInput = Object.freeze({
  make(a, b, p, dimension) { return { a, b, p, dimension }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('minkowski', 'Expected {a, b, p, dimension?}');
    checkMatrix(input.a, 'minkowski');
    checkMatrix(input.b, 'minkowski');
    if (typeof input.p !== 'number' || input.p <= 0) {
      throw new DecodeError('minkowski', 'p must be positive number');
    }
    return input;
  }
});

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================
export function meanValidated(input) {
  const d = MatrixStatInput.decode(input);
  return mean(d.matrix, input.dimension || 'all');
}

export function medianValidated(input) {
  const d = MatrixStatInput.decode(input);
  return median(d.matrix, input.dimension || 'all');
}

export function varianceValidated(input) {
  const d = MatrixStatInput.decode(input);
  return variance(d.matrix, d.options);
}

export function standardDeviationValidated(input) {
  const d = MatrixStatInput.decode(input);
  return standardDeviation(d.matrix, d.options);
}

export function sumValidated(input) {
  const d = MatrixStatInput.decode(input);
  return sum(d.matrix);
}

export function productValidated(input) {
  const d = MatrixStatInput.decode(input);
  return product(d.matrix);
}

export function maxValidated(input) {
  const d = MatrixStatInput.decode(input);
  return max(d.matrix);
}

export function minValidated(input) {
  const d = MatrixStatInput.decode(input);
  return min(d.matrix);
}

export function weightedMeanValidated(input) {
  const d = WeightedStatInput.decode(input);
  return weightedMean(d.matrix, d.weights, input.dimension);
}

export function weightedVarianceValidated(input) {
  const d = WeightedStatInput.decode(input);
  return weightedVariance(d.matrix, d.weights, d.options);
}

export function weightedCovarianceValidated(input) {
  const d = WeightedStatInput.decode(input);
  return weightedCovariance(d.matrix, d.weights, d.options);
}

export function minkowskiValidated(input) {
  const d = MinkowskiInput.decode(input);
  return minkowski(d.a, d.b, d.p, d.dimension);
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

export function meanWithPolicies(matrix, dimension, policy) {
  const dim = dimension || 'all';
  if (dim === 'all') {
    return policyScalar(
      'MatrixStat.meanWithPolicies',
      () => mean(matrix, 'all'),
      (r) => ({ rows: matrix.rows, columns: matrix.columns, result: r }),
      policy
    );
  }
  return policyCustom(
    'MatrixStat.meanWithPolicies',
    () => mean(matrix, dim),
    (m) => m instanceof ML.MLMatrix,
    (m) => ({ rows: m.rows, columns: m.columns }),
    policy
  );
}

export function varianceWithPolicies(matrix, policy, options) {
  return policyCustom(
    'MatrixStat.varianceWithPolicies',
    () => variance(matrix, options),
    (v) => (v instanceof ML.MLMatrix ? v instanceof ML.MLMatrix : typeof v === 'number' && Number.isFinite(v)),
    (v) => (v instanceof ML.MLMatrix ? { rows: v.rows, columns: v.columns } : { result: v }),
    policy
  );
}

export function standardizeWithPolicies(matrix, policy, options) {
  return policyCustom(
    'MatrixStat.standardizeWithPolicies',
    () => standardize(matrix, options || { inPlace: false }),
    (m) => m instanceof ML.MLMatrix,
    (m) => ({ rows: m.rows, columns: m.columns }),
    policy
  );
}

export function mahalanobisWithPolicies(matrix, policy, options) {
  return policyCustom(
    'MatrixStat.mahalanobisWithPolicies',
    () => mahalanobis(matrix, options),
    (r) => r && typeof r.length === 'number',
    (r) => ({ n: matrix.rows, resultLen: r.length }),
    policy
  );
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default {
  DecodeError,
  DomainViolationError,
  max,
  min,
  sum,
  product,
  mean,
  median,
  variance,
  standardDeviation,
  weightedMean,
  weightedVariance,
  weightedStandardDeviation,
  weightedCovariance,
  center,
  scale,
  standardize,
  minkowski,
  chebyshev,
  mahalanobis,
  MatrixStatInput,
  WeightedStatInput,
  MinkowskiInput,
  meanValidated,
  medianValidated,
  varianceValidated,
  standardDeviationValidated,
  sumValidated,
  productValidated,
  maxValidated,
  minValidated,
  weightedMeanValidated,
  weightedVarianceValidated,
  weightedCovarianceValidated,
  minkowskiValidated,
  meanWithPolicies,
  varianceWithPolicies,
  standardizeWithPolicies,
  mahalanobisWithPolicies
};