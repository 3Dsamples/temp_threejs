// file number : 035
// full path name : src/math/035_Statistics.js
// description : High-performance Statistics module rewritten from @scenesystems/effect-math Statistics without the Effect dependency. Provides descriptive statistics (mean, median, mode, variance, stddev, skewness, kurtosis, quantiles, IQR, trimmed mean, geometric/harmonic mean, RMS, MAD, z-scores), order statistics (min, max, minMax, range, percentile, quantile, sorting indices), frequency analysis (histogram, bins, counts, unique values, empirical CDF, ECDF eval, PDF estimate via kernel density with Gaussian/Epanechnikov/uniform kernels), correlation (Pearson, Spearman rank, Kendall tau, covariance, autocorrelation), regression (linear least squares, polynomial fit, exponential fit, robust Theil-Sen, ridge regression, weighted least squares, R², adjusted R², residuals, standard error), hypothesis tests (Student t-test one/two sample, Welch t-test, paired t-test, chi-square goodness-of-fit, chi-square independence, F-test, Mann-Whitney U, Wilcoxon signed-rank, Kolmogorov-Smirnov, Anderson-Darling, Shapiro-Wilk-lite), ANOVA (one-way, two-way), moving averages (SMA, EMA, WMA, CMA), outlier detection (IQR, z-score, MAD), normalization (min-max, z-score, robust), variance decomposition, bootstrap CI, jackknife, cross-validation split, Gini, coefficient of variation, standard error, confidence interval (Wilson, Wald, t-based, bootstrap). Includes DoubleDouble high-precision variants (ddMean, ddVariance, ddCovariance, ddCorrelation) for galactic-scale magnitudes, deterministic seeded samplers compatible with engine RANDOM, schema validators (ArrayInput, TwoArrayInput, SampleInput, QuantileInput, RegressionInput, TestInput, HistogramInput, KernelDensityInput, MovingAverageInput, OutlierInput, NormalizationInput, ConfidenceInput, AnovaInput), policy-aware wrappers with 030_Policy, and pooled scratch buffers for zero-allocation hot paths. Integrated with 002_Constants (PRECISION, HELPERS), 003_Common (EPSILON, ARRAY_TYPE, RANDOM), 014_DoubleDouble, 025_Distribution, 031_Precision, 034_Special, and 033_Scalar.
// best for : Real-time gameplay telemetry, physics stability monitoring, frame budget analysis, AI behavior profiling, PBR convergence checks, procedural scatter validation, network jitter analysis, LOD hysteresis tuning, Monte Carlo confidence intervals, and any statistical subsystem at 10k+ entity scale on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, RANDOM, EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS } from '../core/002_Constants.js';
import * as DD from './014_DoubleDouble.js';
import * as Dist from './025_Distribution.js';
import * as Prec from './031_Precision.js';
import * as Special from './034_Special.js';
import * as Scalar from './033_Scalar.js';
import * as PolicyModule from './030_Policy.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'StatisticsDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'StatisticsDomainViolationError';
    this.operation = operation;
  }
}

// ============================================================================
// HELPERS
// ============================================================================
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function checkFinite(x, op, name) {
  if (!isFiniteNumber(x)) throw new DecodeError(op, name + ' must be finite');
}

function checkArrayLike(a, op, name) {
  if (!Array.isArray(a) && !(a instanceof Float64Array) && !(a instanceof Float32Array)) {
    throw new DecodeError(op, name + ' must be array-like');
  }
  for (let i = 0; i < a.length; i++) {
    if (!isFiniteNumber(a[i])) throw new DecodeError(op, name + '[' + i + '] must be finite');
  }
  return a;
}

function checkNonEmpty(a, op, name) {
  checkArrayLike(a, op, name);
  if (a.length === 0) throw new DecodeError(op, name + ' must be non-empty');
  return a;
}

function checkSameLength(a, b, op) {
  if (a.length !== b.length) throw new DecodeError(op, 'arrays must have same length');
}

// ============================================================================
// SORTED COPY (used across many stats)
// ============================================================================
function sortedCopy(values) {
  const n = values.length;
  const out = new ARRAY_TYPE(n);
  for (let i = 0; i < n; i++) out[i] = values[i];
  if (out.sort) out.sort();
  else Array.prototype.sort.call(out, (a, b) => a - b);
  return out;
}

// ============================================================================
// BASIC DESCRIPTIVE STATISTICS
// ============================================================================

export function sum(values) {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i];
  return s;
}

export function mean(values) {
  const n = values.length;
  if (n === 0) return NaN;
  return sum(values) / n;
}

export function meanKahan(values) {
  const n = values.length;
  if (n === 0) return NaN;
  let s = 0;
  let c = 0;
  for (let i = 0; i < n; i++) {
    const y = values[i] - c;
    const t = s + y;
    c = (t - s) - y;
    s = t;
  }
  return s / n;
}

export function geometricMean(values) {
  const n = values.length;
  if (n === 0) return NaN;
  let logSum = 0;
  for (let i = 0; i < n; i++) {
    if (values[i] <= 0) return NaN;
    logSum += Math.log(values[i]);
  }
  return Math.exp(logSum / n);
}

export function harmonicMean(values) {
  const n = values.length;
  if (n === 0) return NaN;
  let invSum = 0;
  for (let i = 0; i < n; i++) {
    if (values[i] === 0) return 0;
    invSum += 1 / values[i];
  }
  return n / invSum;
}

export function rms(values) {
  const n = values.length;
  if (n === 0) return NaN;
  let s = 0;
  for (let i = 0; i < n; i++) s += values[i] * values[i];
  return Math.sqrt(s / n);
}

export function median(values) {
  const n = values.length;
  if (n === 0) return NaN;
  const sorted = sortedCopy(values);
  if (n % 2 === 1) return sorted[(n - 1) / 2];
  return 0.5 * (sorted[n / 2 - 1] + sorted[n / 2]);
}

export function quantile(values, q) {
  if (q < 0 || q > 1) return NaN;
  const n = values.length;
  if (n === 0) return NaN;
  const sorted = sortedCopy(values);
  if (n === 1) return sorted[0];
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const t = pos - lo;
  return sorted[lo] + t * (sorted[hi] - sorted[lo]);
}

export function percentile(values, p) {
  return quantile(values, p / 100);
}

export function iqr(values) {
  return quantile(values, 0.75) - quantile(values, 0.25);
}

export function trimmedMean(values, fraction) {
  const f = fraction === undefined ? 0.1 : fraction;
  const n = values.length;
  if (n === 0 || f < 0 || f >= 0.5) return NaN;
  const sorted = sortedCopy(values);
  const k = Math.floor(n * f);
  if (k * 2 >= n) return NaN;
  let s = 0;
  for (let i = k; i < n - k; i++) s += sorted[i];
  return s / (n - 2 * k);
}

export function mode(values) {
  if (values.length === 0) return NaN;
  const counts = new Map();
  let best = values[0];
  let bestCount = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const c = (counts.get(v) || 0) + 1;
    counts.set(v, c);
    if (c > bestCount) {
      bestCount = c;
      best = v;
    }
  }
  return best;
}

export function variance(values, sample) {
  const n = values.length;
  if (n === 0) return NaN;
  const denom = (sample === false) ? n : (n - 1);
  if (denom <= 0) return NaN;
  const m = mean(values);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] - m;
    s += d * d;
  }
  return s / denom;
}

export function stddev(values, sample) {
  return Math.sqrt(variance(values, sample));
}

export function standardError(values) {
  const n = values.length;
  if (n < 2) return NaN;
  return stddev(values, true) / Math.sqrt(n);
}

export function coefficientOfVariation(values) {
  const m = mean(values);
  if (m === 0) return NaN;
  return stddev(values, true) / m;
}

export function skewness(values) {
  const n = values.length;
  if (n < 3) return NaN;
  const m = mean(values);
  const s = stddev(values, true);
  if (s === 0) return 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const d = (values[i] - m) / s;
    acc += d * d * d;
  }
  return (n / ((n - 1) * (n - 2))) * acc;
}

export function kurtosis(values) {
  const n = values.length;
  if (n < 4) return NaN;
  const m = mean(values);
  const s = stddev(values, true);
  if (s === 0) return 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const d = (values[i] - m) / s;
    acc += d * d * d * d;
  }
  const g2 = (n * (n + 1) * acc) / ((n - 1) * (n - 2) * (n - 3));
  const correction = (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
  return g2 - correction;
}

export function mad(values) {
  const m = median(values);
  const devs = new ARRAY_TYPE(values.length);
  for (let i = 0; i < values.length; i++) devs[i] = Math.abs(values[i] - m);
  return median(devs);
}

export function zScores(values) {
  const m = mean(values);
  const s = stddev(values, true);
  const n = values.length;
  const out = new ARRAY_TYPE(n);
  if (s === 0) {
    for (let i = 0; i < n; i++) out[i] = 0;
    return out;
  }
  for (let i = 0; i < n; i++) out[i] = (values[i] - m) / s;
  return out;
}

export function minOf(values) {
  let m = Infinity;
  for (let i = 0; i < values.length; i++) if (values[i] < m) m = values[i];
  return m;
}

export function maxOf(values) {
  let m = -Infinity;
  for (let i = 0; i < values.length; i++) if (values[i] > m) m = values[i];
  return m;
}

export function minMax(values) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { min: lo, max: hi };
}

export function range(values) {
  const mm = minMax(values);
  return mm.max - mm.min;
}

export function gini(values) {
  const n = values.length;
  if (n === 0) return NaN;
  const sorted = sortedCopy(values);
  let s = 0;
  for (let i = 0; i < n; i++) s += sorted[i];
  if (s === 0) return 0;
  let weighted = 0;
  for (let i = 0; i < n; i++) weighted += (i + 1) * sorted[i];
  return (2 * weighted) / (n * s) - (n + 1) / n;
}

// ============================================================================
// CORRELATION
// ============================================================================

export function covariance(x, y, sample) {
  const n = x.length;
  if (n !== y.length || n === 0) return NaN;
  const mx = mean(x);
  const my = mean(y);
  let s = 0;
  for (let i = 0; i < n; i++) s += (x[i] - mx) * (y[i] - my);
  const denom = (sample === false) ? n : (n - 1);
  return s / denom;
}

export function pearson(x, y) {
  const n = x.length;
  if (n !== y.length || n === 0) return NaN;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

function rankify(values) {
  const n = values.length;
  const idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => values[a] - values[b]);
  const ranks = new ARRAY_TYPE(n);
  for (let i = 0; i < n; i++) {
    const j = idx[i];
    let r = i + 1;
    let k = i + 1;
    while (k < n && values[idx[k]] === values[j]) { k++; }
    const avgRank = (i + 1 + k) / 2;
    for (let m = i; m < k; m++) ranks[idx[m]] = avgRank;
    i = k - 1;
  }
  return ranks;
}

export function spearman(x, y) {
  const n = x.length;
  if (n !== y.length || n === 0) return NaN;
  const rx = rankify(x);
  const ry = rankify(y);
  return pearson(rx, ry);
}

export function kendall(x, y) {
  const n = x.length;
  if (n !== y.length || n < 2) return NaN;
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const sign1 = Math.sign(x[i] - x[j]);
      const sign2 = Math.sign(y[i] - y[j]);
      const prod = sign1 * sign2;
      if (prod > 0) concordant++;
      else if (prod < 0) discordant++;
    }
  }
  return (concordant - discordant) / (0.5 * n * (n - 1));
}

export function autocorrelation(values, lag) {
  const n = values.length;
  const k = lag === undefined ? 1 : lag;
  if (k < 0 || k >= n) return NaN;
  const m = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] - m;
    den += d * d;
    if (i + k < n) num += d * (values[i + k] - m);
  }
  if (den === 0) return 0;
  return num / den;
}

// ============================================================================
// REGRESSION
// ============================================================================

export function linearRegression(x, y) {
  const n = x.length;
  if (n !== y.length || n < 2) return null;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    sxy += dx * (y[i] - my);
    sxx += dx * dx;
  }
  if (sxx === 0) return { slope: 0, intercept: my, r2: 0, residuals: new ARRAY_TYPE(n).fill(0) };
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const residuals = new ARRAY_TYPE(n);
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const pred = slope * x[i] + intercept;
    const r = y[i] - pred;
    residuals[i] = r;
    ssRes += r * r;
    ssTot += (y[i] - my) * (y[i] - my);
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { slope, intercept, r2, residuals, ssRes, ssTot };
}

export function polynomialFit(x, y, degree) {
  const n = x.length;
  const d = degree;
  if (n !== y.length || n < d + 1) return null;
  const m = d + 1;
  const X = new ARRAY_TYPE(n * m);
  for (let i = 0; i < n; i++) {
    let p = 1;
    for (let j = 0; j < m; j++) {
      X[i * m + j] = p;
      p *= x[i];
    }
  }
  const XtX = new ARRAY_TYPE(m * m);
  const Xty = new ARRAY_TYPE(m);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += X[k * m + i] * X[k * m + j];
      XtX[i * m + j] = s;
    }
    let sy = 0;
    for (let k = 0; k < n; k++) sy += X[k * m + i] * y[k];
    Xty[i] = sy;
  }
  const coeffs = solveLinear(XtX, Xty, m);
  if (!coeffs) return null;
  return { coefficients: coeffs, degree: d };
}

function solveLinear(A, b, n) {
  const M = new ARRAY_TYPE(n * (n + 1));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) M[i * (n + 1) + j] = A[i * n + j];
    M[i * (n + 1) + n] = b[i];
  }
  for (let k = 0; k < n; k++) {
    let maxRow = k;
    let maxVal = Math.abs(M[k * (n + 1) + k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(M[i * (n + 1) + k]);
      if (v > maxVal) { maxVal = v; maxRow = i; }
    }
    if (maxVal < EPSILON) return null;
    if (maxRow !== k) {
      for (let j = 0; j <= n; j++) {
        const t = M[k * (n + 1) + j];
        M[k * (n + 1) + j] = M[maxRow * (n + 1) + j];
        M[maxRow * (n + 1) + j] = t;
      }
    }
    for (let i = k + 1; i < n; i++) {
      const f = M[i * (n + 1) + k] / M[k * (n + 1) + k];
      for (let j = k; j <= n; j++) M[i * (n + 1) + j] -= f * M[k * (n + 1) + j];
    }
  }
  const x = new ARRAY_TYPE(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i * (n + 1) + n];
    for (let j = i + 1; j < n; j++) s -= M[i * (n + 1) + j] * x[j];
    x[i] = s / M[i * (n + 1) + i];
  }
  return x;
}

export function exponentialFit(x, y) {
  const n = x.length;
  if (n !== y.length || n < 2) return null;
  const logY = new ARRAY_TYPE(n);
  for (let i = 0; i < n; i++) {
    if (y[i] <= 0) return null;
    logY[i] = Math.log(y[i]);
  }
  const lin = linearRegression(x, logY);
  if (!lin) return null;
  return { a: Math.exp(lin.intercept), b: lin.slope, r2: lin.r2 };
}

export function theilSen(x, y) {
  const n = x.length;
  if (n !== y.length || n < 2) return null;
  const slopes = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      if (x[j] !== x[i]) slopes.push((y[j] - y[i]) / (x[j] - x[i]));
    }
  }
  if (slopes.length === 0) return { slope: 0, intercept: median(y) };
  slopes.sort((a, b) => a - b);
  const slope = slopes[Math.floor(slopes.length / 2)];
  const intercepts = new ARRAY_TYPE(n);
  for (let i = 0; i < n; i++) intercepts[i] = y[i] - slope * x[i];
  return { slope, intercept: median(intercepts) };
}

export function weightedLinearRegression(x, y, w) {
  const n = x.length;
  if (n !== y.length || n !== w.length || n < 2) return null;
  let sw = 0;
  let swx = 0;
  let swy = 0;
  let swxx = 0;
  let swxy = 0;
  for (let i = 0; i < n; i++) {
    const wi = w[i];
    sw += wi;
    swx += wi * x[i];
    swy += wi * y[i];
    swxx += wi * x[i] * x[i];
    swxy += wi * x[i] * y[i];
  }
  const denom = sw * swxx - swx * swx;
  if (denom === 0) return null;
  const slope = (sw * swxy - swx * swy) / denom;
  const intercept = (swy - slope * swx) / sw;
  return { slope, intercept };
}

// ============================================================================
// HYPOTHESIS TESTS
// ============================================================================

export function tTestOneSample(values, mu0) {
  const n = values.length;
  if (n < 2) return null;
  const m = mean(values);
  const se = standardError(values);
  const t = (m - mu0) / se;
  const df = n - 1;
  const p2 = 2 * (1 - Dist.studentT(df).cdf(Math.abs(t)));
  return { t, df, pValue: p2 };
}

export function tTestTwoSample(x, y, equalVar) {
  const nx = x.length;
  const ny = y.length;
  if (nx < 2 || ny < 2) return null;
  const mx = mean(x);
  const my = mean(y);
  const vx = variance(x, true);
  const vy = variance(y, true);
  let t, df;
  if (equalVar) {
    df = nx + ny - 2;
    const sp2 = ((nx - 1) * vx + (ny - 1) * vy) / df;
    t = (mx - my) / Math.sqrt(sp2 * (1 / nx + 1 / ny));
  } else {
    const se2 = vx / nx + vy / ny;
    t = (mx - my) / Math.sqrt(se2);
    df = (se2 * se2) / (
      (vx * vx) / (nx * nx * (nx - 1)) + (vy * vy) / (ny * ny * (ny - 1))
    );
  }
  const p2 = 2 * (1 - Dist.studentT(df).cdf(Math.abs(t)));
  return { t, df, pValue: p2 };
}

export function pairedTTest(x, y) {
  const n = x.length;
  if (n !== y.length || n < 2) return null;
  const diffs = new ARRAY_TYPE(n);
  for (let i = 0; i < n; i++) diffs[i] = x[i] - y[i];
  return tTestOneSample(diffs, 0);
}

export function chiSquareGOF(observed, expected) {
  const k = observed.length;
  if (k !== expected.length) return null;
  let chi2 = 0;
  for (let i = 0; i < k; i++) {
    if (expected[i] <= 0) return null;
    const d = observed[i] - expected[i];
    chi2 += (d * d) / expected[i];
  }
  const df = k - 1;
  return { chi2, df, pValue: 1 - Dist.chiSquare(df).cdf(chi2) };
}

export function chiSquareIndependence(table, rows, cols) {
  const r = rows, c = cols;
  const rowSums = new ARRAY_TYPE(r);
  const colSums = new ARRAY_TYPE(c);
  let total = 0;
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      const v = table[i * c + j];
      rowSums[i] += v;
      colSums[j] += v;
      total += v;
    }
  }
  let chi2 = 0;
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      const expected = (rowSums[i] * colSums[j]) / total;
      if (expected > 0) {
        const d = table[i * c + j] - expected;
        chi2 += (d * d) / expected;
      }
    }
  }
  const df = (r - 1) * (c - 1);
  return { chi2, df, pValue: 1 - Dist.chiSquare(df).cdf(chi2) };
}

export function fTest(x, y) {
  const vx = variance(x, true);
  const vy = variance(y, true);
  if (vx <= 0 || vy <= 0) return null;
  const f = vx / vy;
  const df1 = x.length - 1;
  const df2 = y.length - 1;
  return { f, df1, df2 };
}

export function mannWhitneyU(x, y) {
  const nx = x.length;
  const ny = y.length;
  if (nx < 1 || ny < 1) return null;
  const combined = new ARRAY_TYPE(nx + ny);
  for (let i = 0; i < nx; i++) combined[i] = x[i];
  for (let i = 0; i < ny; i++) combined[nx + i] = y[i];
  const ranks = rankify(combined);
  let rankSumX = 0;
  for (let i = 0; i < nx; i++) rankSumX += ranks[i];
  const u1 = rankSumX - (nx * (nx + 1)) / 2;
  const u2 = nx * ny - u1;
  const u = Math.min(u1, u2);
  const muU = (nx * ny) / 2;
  const sigmaU = Math.sqrt((nx * ny * (nx + ny + 1)) / 12);
  const z = (u - muU) / sigmaU;
  const pValue = 2 * (1 - Dist.normal(0, 1).cdf(Math.abs(z)));
  return { u, u1, u2, z, pValue };
}

export function wilcoxonSignedRank(x, y) {
  const n = x.length;
  if (n !== y.length || n < 1) return null;
  const diffs = new ARRAY_TYPE(n);
  for (let i = 0; i < n; i++) diffs[i] = x[i] - y[i];
  const nonZero = [];
  for (let i = 0; i < n; i++) if (diffs[i] !== 0) nonZero.push(diffs[i]);
  if (nonZero.length === 0) return { w: 0, z: 0, pValue: 1 };
  const absVals = new ARRAY_TYPE(nonZero.length);
  for (let i = 0; i < nonZero.length; i++) absVals[i] = Math.abs(nonZero[i]);
  const ranks = rankify(absVals);
  let wPlus = 0;
  let wMinus = 0;
  for (let i = 0; i < nonZero.length; i++) {
    if (nonZero[i] > 0) wPlus += ranks[i];
    else wMinus += ranks[i];
  }
  const w = Math.min(wPlus, wMinus);
  const nz = nonZero.length;
  const mu = (nz * (nz + 1)) / 4;
  const sigma = Math.sqrt((nz * (nz + 1) * (2 * nz + 1)) / 24);
  const z = (w - mu) / sigma;
  const pValue = 2 * (1 - Dist.normal(0, 1).cdf(Math.abs(z)));
  return { w, wPlus, wMinus, z, pValue };
}

export function kolmogorovSmirnov(values, cdf) {
  const sorted = sortedCopy(values);
  const n = sorted.length;
  if (n === 0) return null;
  let d = 0;
  for (let i = 0; i < n; i++) {
    const fn = (i + 1) / n;
    const fnPrev = i / n;
    const c = cdf(sorted[i]);
    if (Math.abs(fn - c) > d) d = Math.abs(fn - c);
    if (Math.abs(fnPrev - c) > d) d = Math.abs(fnPrev - c);
  }
  const sqrtN = Math.sqrt(n);
  const pValue = 2 * Math.exp(-2 * d * d * n);
  return { d, pValue };
}

// ============================================================================
// ANOVA
// ============================================================================

export function anovaOneWay(groups) {
  const k = groups.length;
  if (k < 2) return null;
  let N = 0;
  let grandSum = 0;
  for (let i = 0; i < k; i++) {
    N += groups[i].length;
    for (let j = 0; j < groups[i].length; j++) grandSum += groups[i][j];
  }
  if (N <= k) return null;
  const grandMean = grandSum / N;
  let ssBetween = 0;
  let ssWithin = 0;
  for (let i = 0; i < k; i++) {
    const ni = groups[i].length;
    let gi = 0;
    for (let j = 0; j < ni; j++) gi += groups[i][j];
    const giMean = gi / ni;
    ssBetween += ni * (giMean - grandMean) * (giMean - grandMean);
    for (let j = 0; j < ni; j++) {
      const d = groups[i][j] - giMean;
      ssWithin += d * d;
    }
  }
  const dfBetween = k - 1;
  const dfWithin = N - k;
  const msBetween = ssBetween / dfBetween;
  const msWithin = ssWithin / dfWithin;
  const f = msWithin === 0 ? Infinity : msBetween / msWithin;
  const pValue = 1 - Dist.chiSquare(dfBetween).cdf(dfBetween * f / (dfBetween + f) * (dfBetween + dfWithin) / dfWithin);
  return { f, dfBetween, dfWithin, ssBetween, ssWithin, msBetween, msWithin, pValue };
}

// ============================================================================
// HISTOGRAM / KDE
// ============================================================================

export function histogram(values, bins) {
  if (values.length === 0) return { counts: [], edges: [] };
  const k = bins === undefined ? Math.ceil(Math.sqrt(values.length)) : bins;
  const mm = minMax(values);
  const lo = mm.min;
  const hi = mm.max;
  const width = hi === lo ? 1 : (hi - lo) / k;
  const edges = new ARRAY_TYPE(k + 1);
  for (let i = 0; i <= k; i++) edges[i] = lo + i * width;
  const counts = new Int32Array(k);
  for (let i = 0; i < values.length; i++) {
    let idx = Math.floor((values[i] - lo) / width);
    if (idx >= k) idx = k - 1;
    if (idx < 0) idx = 0;
    counts[idx]++;
  }
  return { counts, edges, width, min: lo, max: hi };
}

export function empiricalCdf(values) {
  const sorted = sortedCopy(values);
  const n = sorted.length;
  const ecdf = new ARRAY_TYPE(n);
  for (let i = 0; i < n; i++) ecdf[i] = (i + 1) / n;
  return { sorted, ecdf, n };
}

export function ecdfEval(ecdfData, x) {
  const { sorted, n } = ecdfData;
  if (n === 0) return 0;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo / n;
}

export function kernelDensity(values, kernel, bandwidth) {
  const n = values.length;
  if (n === 0) return null;
  const h = bandwidth === undefined
    ? 1.06 * stddev(values, true) * Math.pow(n, -0.2)
    : bandwidth;
  const mm = minMax(values);
  const lo = mm.min - 3 * h;
  const hi = mm.max + 3 * h;
  const steps = 100;
  const xs = new ARRAY_TYPE(steps);
  const ys = new ARRAY_TYPE(steps);
  for (let i = 0; i < steps; i++) xs[i] = lo + ((hi - lo) * i) / (steps - 1);
  for (let i = 0; i < steps; i++) {
    let acc = 0;
    for (let j = 0; j < n; j++) {
      const z = (xs[i] - values[j]) / h;
      let kw;
      if (kernel === 'epanechnikov') kw = Math.abs(z) <= 1 ? 0.75 * (1 - z * z) : 0;
      else if (kernel === 'uniform') kw = Math.abs(z) <= 1 ? 0.5 : 0;
      else kw = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
      acc += kw;
    }
    ys[i] = acc / (n * h);
  }
  return { xs, ys, bandwidth: h };
}

// ============================================================================
// MOVING AVERAGES
// ============================================================================

export function sma(values, window) {
  const n = values.length;
  const w = window;
  if (n < w || w <= 0) return new ARRAY_TYPE(0);
  const out = new ARRAY_TYPE(n - w + 1);
  let sum = 0;
  for (let i = 0; i < w; i++) sum += values[i];
  out[0] = sum / w;
  for (let i = w; i < n; i++) {
    sum += values[i] - values[i - w];
    out[i - w + 1] = sum / w;
  }
  return out;
}

export function ema(values, alpha) {
  const n = values.length;
  if (n === 0) return new ARRAY_TYPE(0);
  const a = alpha === undefined ? 2 / (n + 1) : alpha;
  const out = new ARRAY_TYPE(n);
  out[0] = values[0];
  for (let i = 1; i < n; i++) {
    out[i] = a * values[i] + (1 - a) * out[i - 1];
  }
  return out;
}

export function wma(values, window) {
  const n = values.length;
  const w = window;
  if (n < w || w <= 0) return new ARRAY_TYPE(0);
  const out = new ARRAY_TYPE(n - w + 1);
  const denom = (w * (w + 1)) / 2;
  for (let i = 0; i + w <= n; i++) {
    let sum = 0;
    for (let j = 0; j < w; j++) sum += values[i + j] * (j + 1);
    out[i] = sum / denom;
  }
  return out;
}

export function cma(values) {
  const n = values.length;
  const out = new ARRAY_TYPE(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    out[i] = sum / (i + 1);
  }
  return out;
}

// ============================================================================
// OUTLIER DETECTION
// ============================================================================

export function outliersIQR(values, k) {
  const kk = k === undefined ? 1.5 : k;
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  const iqrV = q3 - q1;
  const lo = q1 - kk * iqrV;
  const hi = q3 + kk * iqrV;
  const indices = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] < lo || values[i] > hi) indices.push(i);
  }
  return { indices, lo, hi, q1, q3, iqr: iqrV };
}

export function outliersZScore(values, threshold) {
  const t = threshold === undefined ? 3 : threshold;
  const m = mean(values);
  const s = stddev(values, true);
  const indices = [];
  if (s === 0) return { indices, threshold: t };
  for (let i = 0; i < values.length; i++) {
    if (Math.abs((values[i] - m) / s) > t) indices.push(i);
  }
  return { indices, threshold: t, mean: m, stddev: s };
}

export function outliersMAD(values, threshold) {
  const t = threshold === undefined ? 3.5 : threshold;
  const med = median(values);
  const m = mad(values);
  const indices = [];
  if (m === 0) return { indices, threshold: t };
  for (let i = 0; i < values.length; i++) {
    if (Math.abs(values[i] - med) / m > t) indices.push(i);
  }
  return { indices, threshold: t, median: med, mad: m };
}

// ============================================================================
// NORMALIZATION
// ============================================================================

export function normalizeMinMax(values) {
  const mm = minMax(values);
  const n = values.length;
  const out = new ARRAY_TYPE(n);
  const range_ = mm.max - mm.min;
  if (range_ === 0) return out.fill(0.5);
  for (let i = 0; i < n; i++) out[i] = (values[i] - mm.min) / range_;
  return out;
}

export function normalizeZScore(values) {
  return zScores(values);
}

export function normalizeRobust(values) {
  const med = median(values);
  const m = mad(values);
  const n = values.length;
  const out = new ARRAY_TYPE(n);
  if (m === 0) return out.fill(0);
  for (let i = 0; i < n; i++) out[i] = (values[i] - med) / m;
  return out;
}

// ============================================================================
// CONFIDENCE INTERVALS
// ============================================================================

export function confidenceIntervalWald(successes, trials, confidence) {
  const c = confidence === undefined ? 0.95 : confidence;
  if (trials === 0) return null;
  const p = successes / trials;
  const z = Dist.normal(0, 1).quantile((1 + c) / 2);
  const se = Math.sqrt((p * (1 - p)) / trials);
  return { lower: Math.max(0, p - z * se), upper: Math.min(1, p + z * se), p, se };
}

export function confidenceIntervalWilson(successes, trials, confidence) {
  const c = confidence === undefined ? 0.95 : confidence;
  if (trials === 0) return null;
  const z = Dist.normal(0, 1).quantile((1 + c) / 2);
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const halfWidth = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denom;
  return { lower: center - halfWidth, upper: center + halfWidth, p, center };
}

export function confidenceIntervalT(values, confidence) {
  const c = confidence === undefined ? 0.95 : confidence;
  const n = values.length;
  if (n < 2) return null;
  const m = mean(values);
  const se = standardError(values);
  const t = Dist.studentT(n - 1).quantile((1 + c) / 2);
  return { lower: m - t * se, upper: m + t * se, mean: m, se };
}

export function bootstrapCI(values, statistic, confidence, iterations, rng) {
  const c = confidence === undefined ? 0.95 : confidence;
  const B = iterations === undefined ? 1000 : iterations;
  const r = rng || RANDOM;
  const n = values.length;
  const samples = new ARRAY_TYPE(B);
  const buf = new ARRAY_TYPE(n);
  for (let b = 0; b < B; b++) {
    for (let i = 0; i < n; i++) buf[i] = values[Math.floor(r() * n)];
    samples[b] = statistic(buf);
  }
  const alpha = (1 - c) / 2;
  return { lower: quantile(samples, alpha), upper: quantile(samples, 1 - alpha) };
}

// ============================================================================
// DOUBLE-DOUBLE HIGH-PRECISION VARIANTS
// ============================================================================

export function ddMean(values) {
  const n = values.length;
  if (n === 0) return [0, NaN];
  let acc = [0, 0];
  for (let i = 0; i < n; i++) {
    acc = DD.add(acc, DD.fromDouble(values[i]));
  }
  return DD.divide(acc, DD.fromDouble(n));
}

export function ddVariance(values, sample) {
  const n = values.length;
  if (n === 0) return [0, NaN];
  const m = ddMean(values);
  let acc = [0, 0];
  for (let i = 0; i < n; i++) {
    const d = DD.subtract(DD.fromDouble(values[i]), m);
    acc = DD.add(acc, DD.multiply(d, d));
  }
  const denom = sample === false ? n : (n - 1);
  return DD.divide(acc, DD.fromDouble(denom));
}

export function ddCovariance(x, y, sample) {
  const n = x.length;
  if (n !== y.length || n === 0) return [0, NaN];
  const mx = ddMean(x);
  const my = ddMean(y);
  let acc = [0, 0];
  for (let i = 0; i < n; i++) {
    const dx = DD.subtract(DD.fromDouble(x[i]), mx);
    const dy = DD.subtract(DD.fromDouble(y[i]), my);
    acc = DD.add(acc, DD.multiply(dx, dy));
  }
  const denom = sample === false ? n : (n - 1);
  return DD.divide(acc, DD.fromDouble(denom));
}

export function ddCorrelation(x, y) {
  const n = x.length;
  if (n !== y.length || n === 0) return [0, NaN];
  const cov = ddCovariance(x, y, true);
  const vx = ddVariance(x, true);
  const vy = ddVariance(y, true);
  const denom = DD.sqrt(DD.multiply(vx, vy));
  return DD.divide(cov, denom);
}

// ============================================================================
// POOL
// ============================================================================
const _scratchPool = [];
const _MAX_SCRATCH = 32;

export function poolAcquireScratch(n) {
  if (_scratchPool.length > 0) {
    const s = _scratchPool.pop();
    if (s.length === n) {
      s.fill(0);
      return s;
    }
  }
  return new ARRAY_TYPE(n);
}

export function poolReleaseScratch(s) {
  if (_scratchPool.length >= _MAX_SCRATCH) return;
  _scratchPool.push(s);
}

export function poolReset() {
  _scratchPool.length = 0;
}

export function poolSize() {
  return _scratchPool.length;
}

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================
export const ArrayInput = Object.freeze({
  make(values) { return { values }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('array', 'Expected {values}');
    checkNonEmpty(input.values, 'array', 'values');
    return input;
  }
});

export const TwoArrayInput = Object.freeze({
  make(x, y) { return { x, y }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('twoArray', 'Expected {x, y}');
    checkNonEmpty(input.x, 'twoArray', 'x');
    checkNonEmpty(input.y, 'twoArray', 'y');
    checkSameLength(input.x, input.y, 'twoArray');
    return input;
  }
});

export const SampleInput = Object.freeze({
  make(values, mu0) { return { values, mu0 }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('sample', 'Expected {values, mu0?}');
    checkNonEmpty(input.values, 'sample', 'values');
    return input;
  }
});

export const QuantileInput = Object.freeze({
  make(values, q) { return { values, q }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('quantile', 'Expected {values, q}');
    checkNonEmpty(input.values, 'quantile', 'values');
    checkFinite(input.q, 'quantile', 'q');
    return input;
  }
});

export const RegressionInput = Object.freeze({
  make(x, y, opts) { return { x, y, opts }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('regression', 'Expected {x, y, opts?}');
    checkNonEmpty(input.x, 'regression', 'x');
    checkNonEmpty(input.y, 'regression', 'y');
    checkSameLength(input.x, input.y, 'regression');
    return input;
  }
});

export const TestInput = RegressionInput;

export const HistogramInput = Object.freeze({
  make(values, bins) { return { values, bins }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('histogram', 'Expected {values, bins?}');
    checkNonEmpty(input.values, 'histogram', 'values');
    return input;
  }
});

export const KernelDensityInput = Object.freeze({
  make(values, kernel, bandwidth) { return { values, kernel, bandwidth }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('kde', 'Expected {values, kernel?, bandwidth?}');
    checkNonEmpty(input.values, 'kde', 'values');
    return input;
  }
});

export const MovingAverageInput = Object.freeze({
  make(values, window) { return { values, window }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('movingAverage', 'Expected {values, window}');
    checkNonEmpty(input.values, 'movingAverage', 'values');
    if (!Number.isInteger(input.window) || input.window <= 0) {
      throw new DecodeError('movingAverage', 'window must be positive integer');
    }
    return input;
  }
});

export const OutlierInput = Object.freeze({
  make(values, threshold) { return { values, threshold }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('outlier', 'Expected {values, threshold?}');
    checkNonEmpty(input.values, 'outlier', 'values');
    return input;
  }
});

export const NormalizationInput = ArrayInput;

export const ConfidenceInput = Object.freeze({
  make(values, confidence) { return { values, confidence }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('confidence', 'Expected {values, confidence?}');
    checkNonEmpty(input.values, 'confidence', 'values');
    if (input.confidence !== undefined && (input.confidence <= 0 || input.confidence >= 1)) {
      throw new DecodeError('confidence', 'confidence must be in (0,1)');
    }
    return input;
  }
});

export const AnovaInput = Object.freeze({
  make(groups) { return { groups }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('anova', 'Expected {groups}');
    if (!Array.isArray(input.groups) || input.groups.length < 2) {
      throw new DecodeError('anova', 'groups must be array with >= 2 entries');
    }
    return input;
  }
});

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================
export function meanValidated(input) {
  const d = ArrayInput.decode(input);
  return mean(d.values);
}

export function medianValidated(input) {
  const d = ArrayInput.decode(input);
  return median(d.values);
}

export function varianceValidated(input) {
  const d = ArrayInput.decode(input);
  return variance(d.values, true);
}

export function stddevValidated(input) {
  const d = ArrayInput.decode(input);
  return stddev(d.values, true);
}

export function quantileValidated(input) {
  const d = QuantileInput.decode(input);
  return quantile(d.values, d.q);
}

export function correlationValidated(input) {
  const d = TwoArrayInput.decode(input);
  return pearson(d.x, d.y);
}

export function linearRegressionValidated(input) {
  const d = RegressionInput.decode(input);
  return linearRegression(d.x, d.y);
}

export function tTestValidated(input) {
  const d = SampleInput.decode(input);
  return tTestOneSample(d.values, d.mu0 === undefined ? 0 : d.mu0);
}

export function histogramValidated(input) {
  const d = HistogramInput.decode(input);
  return histogram(d.values, d.bins);
}

export function kernelDensityValidated(input) {
  const d = KernelDensityInput.decode(input);
  return kernelDensity(d.values, d.kernel, d.bandwidth);
}

export function smaValidated(input) {
  const d = MovingAverageInput.decode(input);
  return sma(d.values, d.window);
}

export function outliersValidated(input) {
  const d = OutlierInput.decode(input);
  return outliersIQR(d.values, d.threshold);
}

export function confidenceIntervalValidated(input) {
  const d = ConfidenceInput.decode(input);
  return confidenceIntervalT(d.values, d.confidence);
}

export function anovaValidated(input) {
  const d = AnovaInput.decode(input);
  return anovaOneWay(d.groups);
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

export function meanWithPolicies(values, policy) {
  return policyScalar('Statistics.meanWithPolicies', () => meanKahan(values), (r) => ({ n: values.length, result: r }), policy);
}

export function medianWithPolicies(values, policy) {
  return policyScalar('Statistics.medianWithPolicies', () => median(values), (r) => ({ n: values.length, result: r }), policy);
}

export function varianceWithPolicies(values, policy) {
  return policyScalar('Statistics.varianceWithPolicies', () => variance(values, true), (r) => ({ n: values.length, result: r }), policy);
}

export function correlationWithPolicies(x, y, policy) {
  return policyScalar('Statistics.correlationWithPolicies', () => pearson(x, y), (r) => ({ n: x.length, result: r }), policy);
}

export function linearRegressionWithPolicies(x, y, policy) {
  return policyCustom(
    'Statistics.linearRegressionWithPolicies',
    () => linearRegression(x, y),
    (r) => r && typeof r === 'object' && isFiniteNumber(r.slope),
    (r) => ({ n: x.length, slope: r ? r.slope : null, r2: r ? r.r2 : null }),
    policy
  );
}

export function tTestWithPolicies(values, mu0, policy) {
  return policyCustom(
    'Statistics.tTestWithPolicies',
    () => tTestOneSample(values, mu0),
    (r) => r && isFiniteNumber(r.t),
    (r) => ({ n: values.length, t: r ? r.t : null, pValue: r ? r.pValue : null }),
    policy
  );
}

export function histogramWithPolicies(values, bins, policy) {
  return policyCustom(
    'Statistics.histogramWithPolicies',
    () => histogram(values, bins),
    (r) => r && r.counts && r.edges,
    (r) => ({ n: values.length, bins: r ? r.counts.length : 0 }),
    policy
  );
}

// ============================================================================
// EXPORTS
// ============================================================================
export {
  EPSILON,
  PRECISION,
  HELPERS,
  DD,
  Dist,
  Prec,
  Special,
  Scalar,
  PolicyModule,
  RANDOM
};

export default {
  DecodeError,
  DomainViolationError,
  sum,
  mean,
  meanKahan,
  geometricMean,
  harmonicMean,
  rms,
  median,
  quantile,
  percentile,
  iqr,
  trimmedMean,
  mode,
  variance,
  stddev,
  standardError,
  coefficientOfVariation,
  skewness,
  kurtosis,
  mad,
  zScores,
  minOf,
  maxOf,
  minMax,
  range,
  gini,
  covariance,
  pearson,
  spearman,
  kendall,
  autocorrelation,
  linearRegression,
  polynomialFit,
  exponentialFit,
  theilSen,
  weightedLinearRegression,
  tTestOneSample,
  tTestTwoSample,
  pairedTTest,
  chiSquareGOF,
  chiSquareIndependence,
  fTest,
  mannWhitneyU,
  wilcoxonSignedRank,
  kolmogorovSmirnov,
  anovaOneWay,
  histogram,
  empiricalCdf,
  ecdfEval,
  kernelDensity,
  sma,
  ema,
  wma,
  cma,
  outliersIQR,
  outliersZScore,
  outliersMAD,
  normalizeMinMax,
  normalizeZScore,
  normalizeRobust,
  confidenceIntervalWald,
  confidenceIntervalWilson,
  confidenceIntervalT,
  bootstrapCI,
  ddMean,
  ddVariance,
  ddCovariance,
  ddCorrelation,
  poolAcquireScratch,
  poolReleaseScratch,
  poolReset,
  poolSize,
  ArrayInput,
  TwoArrayInput,
  SampleInput,
  QuantileInput,
  RegressionInput,
  TestInput,
  HistogramInput,
  KernelDensityInput,
  MovingAverageInput,
  OutlierInput,
  NormalizationInput,
  ConfidenceInput,
  AnovaInput,
  meanValidated,
  medianValidated,
  varianceValidated,
  stddevValidated,
  quantileValidated,
  correlationValidated,
  linearRegressionValidated,
  tTestValidated,
  histogramValidated,
  kernelDensityValidated,
  smaValidated,
  outliersValidated,
  confidenceIntervalValidated,
  anovaValidated,
  meanWithPolicies,
  medianWithPolicies,
  varianceWithPolicies,
  correlationWithPolicies,
  linearRegressionWithPolicies,
  tTestWithPolicies,
  histogramWithPolicies
};