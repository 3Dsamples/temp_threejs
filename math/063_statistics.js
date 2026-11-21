//File number : 063
// File : src/math/063_statistics.js
//Description : Complete statistics system — descriptive (mean, variance, standard deviation, median, mode, quantiles, IQR, MAD, skewness, kurtosis, weighted mean/variance), covariance / correlation (Pearson, Spearman, Kendall), distribution fitting and sampling (normal, uniform, exponential, log-normal, gamma, beta, chi-square, Student-t, F, Poisson, binomial, Dirichlet), PDF / CDF / inverse-CDF for the continuous distributions, hypothesis tests (one- and two-sample t, chi-square, F, Kolmogorov-Smirnov, Mann-Whitney U, ANOVA), linear / polynomial / weighted / ridge / multiple regression with residual analysis, logistic regression (batch-fit via gradient descent), time-series analysis (moving average, EMA, EWMA, autocorrelation, cross-correlation, AR(1) fit, seasonal decomposition), histogram and kernel density estimation (Gaussian / Epanechnikov kernels), reservoir sampling primitives, and domain helpers for procedural scatter statistics, HDR color statistics, orbital motion analysis, and animation curve fea
ture extraction. Every routine has a synchronous SOA batch version plus a chunked async variant that yields via `scheduler.yield()` for 1M+ element runs on Android 64-bit. All scratch state is pooled, and buffers use `000_Math_module.js` precision mode (Float16/Float32/Float64 live-swap).
//####
//Best for : 3d graphics — procedural scatter diagnostics (nearest-neighbor mean/variance on 1M+ asteroids), terrain heightfield statistics, HDR color histogram and tone-mapping analysis, animation curve feature extraction (mean velocity, variance for motion-blending weights), IK joint trajectory statistics for blending, orbital resonance analysis via autocorrelation, motion-capture data fitting with polynomial regression, Monte Carlo confidence intervals for procedural generation, importance-sampling weight verification, and any per-frame statistics pipeline that must run on Android 64-bit without blocking the UI thread.
//License : MIT

// ============================================================================
// Directive Prologues
// ============================================================================

"use strict";

// ============================================================================
// Import
// ============================================================================

const M                     = require("./000_Math_module.js");
const NumericalStability    = require("./036_numerical-stability.js");
const Approximation         = require("./054_approximation.js");
const SpecialFunctions      = require("./055_special-functions.js");
const Sampling              = require("./053_sampling.js");

const common          = M.common;
const getArrayType    = M.getArrayType;
const onPrecisionChange = M.onPrecisionChange;

// ============================================================================
// Export Declarations
// ============================================================================

// ---- Descriptive statistics ----
exports.mean              = mean;
exports.variance          = variance;
exports.stdDev            = stdDev;
exports.median            = median;
exports.mode              = mode;
exports.quantile          = quantile;
exports.iqr               = iqr;
exports.min               = min;
exports.max               = max;
exports.range             = rangeOf;
exports.mad               = mad;
exports.skewness          = skewness;
exports.kurtosis          = kurtosis;
exports.weightedMean      = weightedMean;
exports.weightedVariance  = weightedVariance;

// ---- Covariance / correlation ----
exports.covariance        = covariance;
exports.correlation       = correlation;
exports.spearmanCorrelation = spearmanCorrelation;
exports.kendallCorrelation  = kendallCorrelation;
exports.autocorrelation     = autocorrelation;
exports.crossCorrelation    = crossCorrelation;

// ---- Continuous distributions ----
exports.normalPDF         = normalPDF;
exports.normalCDF         = normalCDF;
exports.normalInverseCDF  = normalInverseCDF;
exports.normalSample      = normalSample;
exports.uniformPDF        = uniformPDF;
exports.uniformCDF        = uniformCDF;
exports.uniformSample     = uniformSample;
exports.exponentialPDF    = exponentialPDF;
exports.exponentialCDF    = exponentialCDF;
exports.exponentialSample = exponentialSample;
exports.logNormalPDF      = logNormalPDF;
exports.logNormalSample   = logNormalSample;
exports.gammaPDF          = gammaPDF;
exports.gammaSample       = gammaSample;
exports.betaPDF           = betaPDF;
exports.betaSample        = betaSample;
exports.chiSquarePDF      = chiSquarePDF;
exports.chiSquareSample   = chiSquareSample;
exports.studentTPDF       = studentTPDF;
exports.studentTSample    = studentTSample;
exports.fPDF              = fPDF;
exports.fSample           = fSample;

// ---- Discrete distributions ----
exports.poissonPMF        = poissonPMF;
exports.poissonSample     = poissonSample;
exports.binomialPMF       = binomialPMF;
exports.binomialSample    = binomialSample;
exports.bernoulliSample   = bernoulliSample;

// ---- Multivariate ----
exports.dirichletSample   = dirichletSample;

// ---- Hypothesis tests ----
exports.tTestOneSample    = tTestOneSample;
exports.tTestTwoSample    = tTestTwoSample;
exports.chiSquareTest     = chiSquareTest;
exports.fTest             = fTest;
exports.ksTest            = ksTest;
exports.mannWhitneyU      = mannWhitneyU;
exports.anova             = anova;

// ---- Regression ----
exports.linearRegression         = linearRegression;
exports.polynomialRegression     = polynomialRegression;
exports.weightedLinearRegression = weightedLinearRegression;
exports.ridgeRegression          = ridgeRegression;
exports.multipleLinearRegression = multipleLinearRegression;
exports.logisticRegression       = logisticRegression;
exports.rSquared                 = rSquared;
exports.adjustedRSquared         = adjustedRSquared;

// ---- Time series ----
exports.movingAverage            = movingAverage;
exports.exponentialMovingAverage = exponentialMovingAverage;
exports.ewma                     = exponentialMovingAverage;
exports.arModel                  = arModel;
exports.seasonalDecompose        = seasonalDecompose;

// ---- Histogram / KDE ----
exports.histogram                = histogram;
exports.kernelDensityEstimate    = kernelDensityEstimate;
exports.epanechnikovKernel       = epanechnikovKernel;
exports.gaussianKernel           = gaussianKernel;

// ---- Reservoir sampling ----
exports.reservoirSample          = reservoirSample;

// ---- Domain helpers ----
exports.scatterStats             = scatterStats;
exports.colorStats               = colorStats;
exports.orbitalStats             = orbitalStats;
exports.animationStats           = animationStats;
exports.ikStats                  = ikStats;

// ---- SOA (sync) ----
exports.soaMean                  = soaMean;
exports.soaVariance              = soaVariance;
exports.soaStdDev                = soaStdDev;
exports.soaMin                   = soaMin;
exports.soaMax                   = soaMax;
exports.soaMedian                = soaMedian;
exports.soaQuantile              = soaQuantile;
exports.soaSkewness              = soaSkewness;
exports.soaKurtosis              = soaKurtosis;
exports.soaHistogram             = soaHistogram;
exports.soaCovariance            = soaCovariance;
exports.soaCorrelation           = soaCorrelation;
exports.soaMovingAverage         = soaMovingAverage;
exports.soaAutocorrelation       = soaAutocorrelation;

// ---- SOA (chunked async) ----
exports.soaMeanChunked           = soaMeanChunked;
exports.soaVarianceChunked       = soaVarianceChunked;
exports.soaHistogramChunked      = soaHistogramChunked;
exports.soaCovarianceChunked     = soaCovarianceChunked;
exports.soaCorrelationChunked    = soaCorrelationChunked;
exports.soaMedianChunked         = soaMedianChunked;

// ---- Pools ----
exports.StatsScratch             = StatsScratch;
exports.createStatsScratchPool   = createStatsScratchPool;
exports.acquireStatsScratch      = acquireStatsScratch;
exports.releaseStatsScratch      = releaseStatsScratch;

// ---- Batch ----
exports.StatsBatchState          = StatsBatchState;
exports.createStatsBatch         = createStatsBatch;

// ---- Namespaces ----
exports.namespace = {};

// ============================================================================
// Global Declarations
// ============================================================================

// (module is stateless — all mutable state lives in pools / per-instance)

// ============================================================================
// Type Declarations
// ============================================================================

/**
 * @typedef {Object} LinearRegressionResult
 * @property {number} slope
 * @property {number} intercept
 * @property {number} r2
 * @property {number} standardError
 */

/**
 * @typedef {Object} TTestResult
 * @property {number} t
 * @property {number} df
 * @property {number} pValue
 */

/**
 * @typedef {Object} KSTestResult
 * @property {number} d
 * @property {number} pValue
 */

/**
 * @typedef {Object} DistributionParams
 * @property {number} [mean=0]
 * @property {number} [stdDev=1]
 * @property {number} [rate=1]
 * @property {number} [min=0]
 * @property {number} [max=1]
 * @property {number} [shape]
 * @property {number} [scale]
 */

// ============================================================================
// Variable Declarations
// ============================================================================

const PI          = Math.PI;
const TAU         = PI * 2;
const SQRT_2      = Math.SQRT2;
const SQRT_2PI    = Math.sqrt(TAU);
const INV_SQRT_2PI = 1 / SQRT_2PI;
const LOG_SQRT_2PI = 0.5 * Math.log(TAU);
const EULER_GAMMA = 0.5772156649015329;
const EPSILON     = 1e-12;

// Scratch pool for hot-path buffers
const _statsScratchPool = common.createPool(
  function () {
    const T = getArrayType();
    return {
      a: new T(256),
      b: new T(256),
      c: new T(256),
      size: 256,
      _attached: false
    };
  },
  8,
  function (s) {
    if (s.a) s.a.fill(0);
    if (s.b) s.b.fill(0);
    if (s.c) s.c.fill(0);
  }
);

// Attach ensure method once per pooled entry
(function warmStatsScratch() {
  const pool = _statsScratchPool;
  const orig = pool.acquire.bind(pool);
  pool.acquire = function () {
    const s = orig();
    if (!s._attached) {
      s._attached = true;
      s.ensure = function (n) {
        if (n <= this.size) return this;
        const T = getArrayType();
        this.size = n;
        this.a = new T(n);
        this.b = new T(n);
        this.c = new T(n);
        return this;
      };
    }
    return s;
  };
})();

// ============================================================================
// Function Declarations — Descriptive statistics
// ============================================================================

function mean(data, n) {
  n = n === undefined ? data.length : n;
  if (n === 0) return 0;
  return NumericalStability.neumaierSum(data, n) / n;
}

function variance(data, n) {
  n = n === undefined ? data.length : n;
  if (n < 2) return 0;
  const m = mean(data, n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const d = data[i] - m;
    acc += d * d;
  }
  return acc / (n - 1);
}

function stdDev(data, n) { return Math.sqrt(variance(data, n)); }

function median(data, n) {
  n = n === undefined ? data.length : n;
  if (n === 0) return 0;
  const T = getArrayType();
  const copy = new T(n);
  for (let i = 0; i < n; i++) copy[i] = data[i];
  // Use Array.prototype.sort on a copy for small n — for large n use quickselect
  const arr = Array.prototype.slice.call(copy);
  arr.sort((a, b) => a - b);
  if (n % 2 === 1) return arr[(n - 1) >> 1];
  return (arr[n / 2 - 1] + arr[n / 2]) * 0.5;
}

function quantile(data, n, q) {
  n = n === undefined ? data.length : n;
  if (n === 0) return 0;
  if (q <= 0) return min(data, n);
  if (q >= 1) return max(data, n);
  const arr = Array.prototype.slice.call(data.subarray ? data.subarray(0, n) : data.slice(0, n));
  arr.sort((a, b) => a - b);
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  return arr[lo] * (1 - frac) + arr[hi] * frac;
}

function iqr(data, n) {
  n = n === undefined ? data.length : n;
  return quantile(data, n, 0.75) - quantile(data, n, 0.25);
}

function mode(data, n) {
  n = n === undefined ? data.length : n;
  if (n === 0) return 0;
  const counts = new Map();
  let best = data[0], bestCount = 0;
  for (let i = 0; i < n; i++) {
    const v = data[i];
    const c = (counts.get(v) || 0) + 1;
    counts.set(v, c);
    if (c > bestCount) { bestCount = c; best = v; }
  }
  return best;
}

function min(data, n) {
  n = n === undefined ? data.length : n;
  let m = Infinity;
  for (let i = 0; i < n; i++) if (data[i] < m) m = data[i];
  return m;
}

function max(data, n) {
  n = n === undefined ? data.length : n;
  let m = -Infinity;
  for (let i = 0; i < n; i++) if (data[i] > m) m = data[i];
  return m;
}

function rangeOf(data, n) {
  n = n === undefined ? data.length : n;
  return max(data, n) - min(data, n);
}

function mad(data, n) {
  n = n === undefined ? data.length : n;
  if (n === 0) return 0;
  const m = median(data, n);
  const T = getArrayType();
  const devs = new T(n);
  for (let i = 0; i < n; i++) devs[i] = Math.abs(data[i] - m);
  return median(devs, n);
}

function skewness(data, n) {
  n = n === undefined ? data.length : n;
  if (n < 3) return 0;
  const m = mean(data, n);
  const s = stdDev(data, n);
  if (s === 0) return 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const d = (data[i] - m) / s;
    acc += d * d * d;
  }
  return n / ((n - 1) * (n - 2)) * acc;
}

function kurtosis(data, n) {
  n = n === undefined ? data.length : n;
  if (n < 4) return 0;
  const m = mean(data, n);
  const s = stdDev(data, n);
  if (s === 0) return 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const d = (data[i] - m) / s;
    acc += d * d * d * d;
  }
  const k = n * (n + 1) / ((n - 1) * (n - 2) * (n - 3)) * acc;
  const correction = 3 * (n - 1) * (n - 1) / ((n - 2) * (n - 3));
  return k - correction;
}

function weightedMean(data, weights, n) {
  n = n === undefined ? data.length : n;
  let sumW = 0, sumWX = 0;
  for (let i = 0; i < n; i++) {
    sumW += weights[i];
    sumWX += data[i] * weights[i];
  }
  return sumW > 0 ? sumWX / sumW : 0;
}

function weightedVariance(data, weights, n) {
  n = n === undefined ? data.length : n;
  const m = weightedMean(data, weights, n);
  let sumW = 0, acc = 0;
  for (let i = 0; i < n; i++) {
    const d = data[i] - m;
    acc += weights[i] * d * d;
    sumW += weights[i];
  }
  return sumW > 0 ? acc / sumW : 0;
}

// ============================================================================
// Function Declarations — Covariance / correlation
// ============================================================================

function covariance(a, b, n) {
  n = n === undefined ? a.length : n;
  if (n < 2) return 0;
  const ma = mean(a, n);
  const mb = mean(b, n);
  let acc = 0;
  for (let i = 0; i < n; i++) acc += (a[i] - ma) * (b[i] - mb);
  return acc / (n - 1);
}

function correlation(a, b, n) {
  n = n === undefined ? a.length : n;
  if (n < 2) return 0;
  const ma = mean(a, n);
  const mb = mean(b, n);
  let sab = 0, sa2 = 0, sb2 = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db;
    sa2 += da * da;
    sb2 += db * db;
  }
  const denom = Math.sqrt(sa2 * sb2);
  return denom > 0 ? sab / denom : 0;
}

/**
 * Spearman rank correlation — monotone relationship, robust to outliers.
 * O(n log n) via sorting.
 */
function spearmanCorrelation(a, b, n) {
  n = n === undefined ? a.length : n;
  if (n < 2) return 0;
  const rankA = _rank(a, n);
  const rankB = _rank(b, n);
  return correlation(rankA, rankB, n);
}

function _rank(data, n) {
  const T = getArrayType();
  const idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((i, j) => data[i] - data[j]);
  const out = new T(n);
  for (let r = 0; r < n; r++) {
    // handle ties
    let end = r;
    while (end + 1 < n && data[idx[end + 1]] === data[idx[r]]) end++;
    const avgRank = (r + end) * 0.5 + 1;
    for (let k = r; k <= end; k++) out[idx[k]] = avgRank;
    r = end;
  }
  return out;
}

/**
 * Kendall tau correlation — concordant vs discordant pairs, O(n²).
 * For 1M+ use the SOA batch version or chunked async.
 */
function kendallCorrelation(a, b, n) {
  n = n === undefined ? a.length : n;
  if (n < 2) return 0;
  let concordant = 0, discordant = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = a[i] - a[j];
      const dy = b[i] - b[j];
      const prod = dx * dy;
      if (prod > 0) concordant++;
      else if (prod < 0) discordant++;
    }
  }
  return (concordant - discordant) / (0.5 * n * (n - 1));
}

function autocorrelation(data, n, maxLag) {
  n = n === undefined ? data.length : n;
  maxLag = maxLag === undefined ? Math.min(n - 1, Math.floor(n / 4)) : maxLag;
  const T = getArrayType();
  const out = new T(maxLag);
  const m = mean(data, n);
  let denom = 0;
  for (let i = 0; i < n; i++) {
    const d = data[i] - m;
    denom += d * d;
  }
  if (denom === 0) return out;
  for (let lag = 1; lag <= maxLag; lag++) {
    let acc = 0;
    for (let i = 0; i < n - lag; i++) {
      acc += (data[i] - m) * (data[i + lag] - m);
    }
    out[lag - 1] = acc / denom;
  }
  return out;
}

function crossCorrelation(a, b, n, maxLag) {
  n = n === undefined ? a.length : n;
  maxLag = maxLag === undefined ? Math.min(n - 1, Math.floor(n / 4)) : maxLag;
  const T = getArrayType();
  const out = new T(2 * maxLag + 1);
  const ma = mean(a, n);
  const mb = mean(b, n);
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sa += da * da;
    sb += db * db;
  }
  const denom = Math.sqrt(sa * sb);
  if (denom === 0) return out;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const j = i + lag;
      if (j >= 0 && j < n) acc += (a[i] - ma) * (b[j] - mb);
    }
    out[lag + maxLag] = acc / denom;
  }
  return out;
}

// ============================================================================
// Function Declarations — Continuous distributions
// ============================================================================

function normalPDF(x, mu, sigma) {
  mu = mu || 0;
  sigma = sigma === undefined ? 1 : sigma;
  if (sigma <= 0) return 0;
  const z = (x - mu) / sigma;
  return INV_SQRT_2PI / sigma * Math.exp(-0.5 * z * z);
}

function normalCDF(x, mu, sigma) {
  mu = mu || 0;
  sigma = sigma === undefined ? 1 : sigma;
  return 0.5 * (1 + SpecialFunctions.erf((x - mu) / (sigma * SQRT_2)));
}

function normalInverseCDF(p, mu, sigma) {
  mu = mu || 0;
  sigma = sigma === undefined ? 1 : sigma;
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  return mu + sigma * SQRT_2 * SpecialFunctions.erfinv(2 * p - 1);
}

function normalSample(mu, sigma, rng) {
  mu = mu || 0;
  sigma = sigma === undefined ? 1 : sigma;
  rng = rng || Math.random;
  // Box-Muller
  const u1 = rng(), u2 = rng();
  return mu + sigma * Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(TAU * u2);
}

function uniformPDF(x, a, b) {
  a = a || 0;
  b = b === undefined ? 1 : b;
  return x >= a && x <= b ? 1 / (b - a) : 0;
}

function uniformCDF(x, a, b) {
  a = a || 0;
  b = b === undefined ? 1 : b;
  if (x < a) return 0;
  if (x > b) return 1;
  return (x - a) / (b - a);
}

function uniformSample(a, b, rng) {
  a = a || 0;
  b = b === undefined ? 1 : b;
  return a + (rng || Math.random)() * (b - a);
}

function exponentialPDF(x, rate) {
  rate = rate === undefined ? 1 : rate;
  return x >= 0 ? rate * Math.exp(-rate * x) : 0;
}

function exponentialCDF(x, rate) {
  rate = rate === undefined ? 1 : rate;
  return x >= 0 ? 1 - Math.exp(-rate * x) : 0;
}

function exponentialSample(rate, rng) {
  rate = rate === undefined ? 1 : rate;
  return -Math.log(1 - (rng || Math.random)()) / rate;
}

function logNormalPDF(x, mu, sigma) {
  mu = mu || 0;
  sigma = sigma === undefined ? 1 : sigma;
  if (x <= 0) return 0;
  const lx = Math.log(x);
  const z = (lx - mu) / sigma;
  return INV_SQRT_2PI / (x * sigma) * Math.exp(-0.5 * z * z);
}

function logNormalSample(mu, sigma, rng) {
  return Math.exp(normalSample(mu, sigma, rng));
}

function gammaPDF(x, shape, scale) {
  shape = shape === undefined ? 1 : shape;
  scale = scale === undefined ? 1 : scale;
  if (x <= 0) return 0;
  return Math.exp((shape - 1) * Math.log(x) - x / scale - SpecialFunctions.lgamma(shape) - shape * Math.log(scale));
}

/**
 * Marsaglia & Tsang gamma sampler. Works for shape < 1 via boosting.
 */
function gammaSample(shape, scale, rng) {
  shape = shape === undefined ? 1 : shape;
  scale = scale === undefined ? 1 : scale;
  rng = rng || Math.random;
  if (shape < 1) {
    // Boost
    const u = rng();
    return gammaSample(shape + 1, scale, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do {
      x = normalSample(0, 1, rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

function betaPDF(x, a, b) {
  a = a === undefined ? 1 : a;
  b = b === undefined ? 1 : b;
  if (x <= 0 || x >= 1) return 0;
  const lnB = SpecialFunctions.lnBeta(a, b);
  return Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - lnB);
}

/** Beta sampler via two gamma draws: X ~ Γ(a,1), Y ~ Γ(b,1), X/(X+Y). */
function betaSample(a, b, rng) {
  const x = gammaSample(a, 1, rng);
  const y = gammaSample(b, 1, rng);
  return x / (x + y);
}

function chiSquarePDF(x, df) {
  df = df === undefined ? 1 : df;
  return gammaPDF(x, df / 2, 2);
}

function chiSquareSample(df, rng) {
  return gammaSample(df / 2, 2, rng);
}

function studentTPDF(x, df) {
  df = df === undefined ? 1 : df;
  const c = Math.exp(SpecialFunctions.lgamma((df + 1) / 2) - SpecialFunctions.lgamma(df / 2)) / Math.sqrt(df * PI);
  return c * Math.pow(1 + x * x / df, -(df + 1) / 2);
}

function studentTSample(df, rng) {
  rng = rng || Math.random;
  const z = normalSample(0, 1, rng);
  const chi = chiSquareSample(df, rng);
  return z / Math.sqrt(chi / df);
}

function fPDF(x, df1, df2) {
  if (x <= 0) return 0;
  df1 = df1 === undefined ? 1 : df1;
  df2 = df2 === undefined ? 1 : df2;
  const num = Math.pow(df1 * x, df1) * Math.pow(df2, df2);
  const den = Math.pow(df1 * x + df2, df1 + df2);
  return Math.sqrt(num / den) / (x * SpecialFunctions.beta(df1 / 2, df2 / 2));
}

function fSample(df1, df2, rng) {
  const u = chiSquareSample(df1, rng);
  const v = chiSquareSample(df2, rng);
  return (u / df1) / (v / df2);
}

// ============================================================================
// Function Declarations — Discrete distributions
// ============================================================================

function poissonPMF(k, lambda) {
  lambda = lambda === undefined ? 1 : lambda;
  if (k < 0 || !Number.isInteger(k)) return 0;
  return Math.exp(k * Math.log(lambda) - lambda - SpecialFunctions.lgamma(k + 1));
}

/**
 * Poisson sampler via Knuth's algorithm for small lambda, or via normal
 * approximation for large lambda.
 */
function poissonSample(lambda, rng) {
  lambda = lambda === undefined ? 1 : lambda;
  rng = rng || Math.random;
  if (lambda < 30) {
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= rng(); } while (p > L);
    return k - 1;
  }
  return Math.max(0, Math.round(normalSample(lambda, Math.sqrt(lambda), rng)));
}

function binomialPMF(k, n, p) {
  if (k < 0 || k > n || !Number.isInteger(k)) return 0;
  return Math.exp(SpecialFunctions.lnBinom(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

function binomialSample(n, p, rng) {
  rng = rng || Math.random;
  let k = 0;
  for (let i = 0; i < n; i++) if (rng() < p) k++;
  return k;
}

function bernoulliSample(p, rng) {
  return (rng || Math.random)() < p ? 1 : 0;
}

/**
 * Dirichlet sampler — symmetric or asymmetric concentration vector.
 * `alpha` is an array of concentrations. Writes normalized samples to `out`.
 */
function dirichletSample(alpha, out, rng) {
  const n = alpha.length;
  out = out || new (getArrayType())(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    out[i] = gammaSample(alpha[i], 1, rng);
    sum += out[i];
  }
  if (sum > 0) for (let i = 0; i < n; i++) out[i] /= sum;
  return out;
}

// ============================================================================
// Function Declarations — Hypothesis tests
// ============================================================================

function tTestOneSample(data, n, mu0) {
  n = n === undefined ? data.length : n;
  mu0 = mu0 === undefined ? 0 : mu0;
  const m = mean(data, n);
  const s = stdDev(data, n);
  const se = s / Math.sqrt(n);
  const t = se > 0 ? (m - mu0) / se : 0;
  const df = n - 1;
  // Two-sided p via Student-t CDF
  const p = 2 * (1 - _studentTCDF(Math.abs(t), df));
  return { t: t, df: df, pValue: p };
}

function tTestTwoSample(a, b, nA, nB) {
  nA = nA === undefined ? a.length : nA;
  nB = nB === undefined ? b.length : nB;
  const mA = mean(a, nA);
  const mB = mean(b, nB);
  const vA = variance(a, nA);
  const vB = variance(b, nB);
  const se = Math.sqrt(vA / nA + vB / nB);
  const t = se > 0 ? (mA - mB) / se : 0;
  // Welch's df
  const num = (vA / nA + vB / nB) * (vA / nA + vB / nB);
  const den = (vA / nA) * (vA / nA) / (nA - 1) + (vB / nB) * (vB / nB) / (nB - 1);
  const df = den > 0 ? num / den : nA + nB - 2;
  const p = 2 * (1 - _studentTCDF(Math.abs(t), df));
  return { t: t, df: df, pValue: p };
}

function _studentTCDF(t, df) {
  // Regularized incomplete beta
  const x = df / (df + t * t);
  const ib = SpecialFunctions.incompleteBeta(x, df / 2, 0.5);
  return t > 0 ? 1 - 0.5 * ib : 0.5 * ib;
}

/**
 * Chi-square goodness-of-fit test. `observed` and `expected` arrays
 * (or uniform expected if expected omitted).
 */
function chiSquareTest(observed, n, expected) {
  n = n === undefined ? observed.length : n;
  if (!expected) {
    const sumO = mean(observed, n) * n;
    expected = new Array(n).fill(sumO / n);
  }
  let chi2 = 0;
  for (let i = 0; i < n; i++) {
    const diff = observed[i] - expected[i];
    if (expected[i] > 0) chi2 += diff * diff / expected[i];
  }
  const df = n - 1;
  // p via upper incomplete gamma
  const p = SpecialFunctions.incompleteGammaQ(df / 2, chi2 / 2);
  return { chi2: chi2, df: df, pValue: p };
}

function fTest(a, b, nA, nB) {
  nA = nA === undefined ? a.length : nA;
  nB = nB === undefined ? b.length : nB;
  const vA = variance(a, nA);
  const vB = variance(b, nB);
  const f = vA > vB ? vA / vB : vB / vA;
  const df1 = vA > vB ? nA - 1 : nB - 1;
  const df2 = vA > vB ? nB - 1 : nA - 1;
  // p via incomplete beta
  const x = df1 * f / (df1 * f + df2);
  const p = SpecialFunctions.incompleteBeta(x, df1 / 2, df2 / 2);
  return { f: f, df1: df1, df2: df2, pValue: 1 - p };
}

function ksTest(data, n, cdfFn) {
  n = n === undefined ? data.length : n;
  // Sort data
  const sorted = Array.prototype.slice.call(data.subarray ? data.subarray(0, n) : data.slice(0, n));
  sorted.sort((a, b) => a - b);
  let maxD = 0;
  for (let i = 0; i < n; i++) {
    const xi = sorted[i];
    const fxi = cdfFn(xi);
    const dPlus = (i + 1) / n - fxi;
    const dMinus = fxi - i / n;
    const d = Math.max(Math.abs(dPlus), Math.abs(dMinus));
    if (d > maxD) maxD = d;
  }
  // Approximate p-value via Kolmogorov distribution
  const sqrtN = Math.sqrt(n);
  const lambda = (sqrtN + 0.12 + 0.11 / sqrtN) * maxD;
  let pValue = 0;
  for (let k = 1; k <= 100; k++) {
    const term = 2 * Math.pow(-1, k - 1) * Math.exp(-2 * k * k * lambda * lambda);
    pValue += term;
    if (Math.abs(term) < 1e-12) break;
  }
  pValue = Math.max(0, Math.min(1, pValue));
  return { d: maxD, pValue: pValue };
}

function mannWhitneyU(a, b, nA, nB) {
  nA = nA === undefined ? a.length : nA;
  nB = nB === undefined ? b.length : nB;
  const combined = [];
  for (let i = 0; i < nA; i++) combined.push({ v: a[i], group: 0 });
  for (let i = 0; i < nB; i++) combined.push({ v: b[i], group: 1 });
  combined.sort((x, y) => x.v - y.v);
  // Rank with ties
  const ranks = new Array(combined.length);
  let i = 0;
  while (i < combined.length) {
    let j = i;
    while (j + 1 < combined.length && combined[j + 1].v === combined[i].v) j++;
    const avgRank = (i + j) * 0.5 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }
  let rankSumA = 0;
  for (let i2 = 0; i2 < combined.length; i2++) {
    if (combined[i2].group === 0) rankSumA += ranks[i2];
  }
  const uA = rankSumA - nA * (nA + 1) / 2;
  const uB = nA * nB - uA;
  const u = Math.min(uA, uB);
  const mu = nA * nB / 2;
  const sigma = Math.sqrt(nA * nB * (nA + nB + 1) / 12);
  const z = sigma > 0 ? (u - mu) / sigma : 0;
  const p = 2 * (1 - normalCDF(Math.abs(z), 0, 1));
  return { u: u, z: z, pValue: p };
}

function anova(groups, groupSizes) {
  const k = groups.length;
  let grandSum = 0, grandCount = 0;
  for (let g = 0; g < k; g++) {
    const n = groupSizes ? groupSizes[g] : groups[g].length;
    for (let i = 0; i < n; i++) grandSum += groups[g][i];
    grandCount += n;
  }
  const grandMean = grandSum / grandCount;
  let ssBetween = 0, ssWithin = 0;
  for (let g = 0; g < k; g++) {
    const n = groupSizes ? groupSizes[g] : groups[g].length;
    let groupSum = 0;
    for (let i = 0; i < n; i++) groupSum += groups[g][i];
    const groupMean = groupSum / n;
    ssBetween += n * (groupMean - grandMean) * (groupMean - grandMean);
    for (let i = 0; i < n; i++) {
      const d = groups[g][i] - groupMean;
      ssWithin += d * d;
    }
  }
  const dfBetween = k - 1;
  const dfWithin = grandCount - k;
  const msBetween = dfBetween > 0 ? ssBetween / dfBetween : 0;
  const msWithin = dfWithin > 0 ? ssWithin / dfWithin : 0;
  const f = msWithin > 0 ? msBetween / msWithin : 0;
  // p-value via F distribution
  const x = dfBetween * f / (dfBetween * f + dfWithin);
  const p = 1 - SpecialFunctions.incompleteBeta(x, dfBetween / 2, dfWithin / 2);
  return { f: f, dfBetween: dfBetween, dfWithin: dfWithin, pValue: p };
}

// ============================================================================
// Function Declarations — Regression
// ============================================================================

function linearRegression(x, y, n) {
  n = n === undefined ? x.length : n;
  const mx = mean(x, n);
  const my = mean(y, n);
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  const ssRes = syy - slope * sxy;
  const r2 = syy > 0 ? 1 - ssRes / syy : 0;
  const se = n > 2 ? Math.sqrt(ssRes / (n - 2)) : 0;
  return { slope: slope, intercept: intercept, r2: r2, standardError: se };
}

/**
 * Polynomial regression via normal equations. `degree` ≥ 1.
 * Returns coefficient array (ascending power).
 */
function polynomialRegression(x, y, n, degree) {
  n = n === undefined ? x.length : n;
  degree = degree || 1;
  const m = degree + 1;
  const A = [];
  const b = [];
  for (let i = 0; i < m; i++) {
    A.push(new Float64Array(m));
    b.push(0);
  }
  for (let i = 0; i < n; i++) {
    let xp = 1;
    for (let r = 0; r < m; r++) {
      b[r] += y[i] * xp;
      let xq = xp;
      for (let c = 0; c < m; c++) {
        A[r][c] += xq;
        xq *= x[i];
      }
      xp *= x[i];
    }
  }
  return _solveLinearSystem(A, b);
}

function weightedLinearRegression(x, y, weights, n) {
  n = n === undefined ? x.length : n;
  let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
  for (let i = 0; i < n; i++) {
    const w = weights[i];
    sw += w;
    swx += w * x[i];
    swy += w * y[i];
    swxx += w * x[i] * x[i];
    swxy += w * x[i] * y[i];
  }
  const denom = sw * swxx - swx * swx;
  const slope = denom > 0 ? (sw * swxy - swx * swy) / denom : 0;
  const intercept = sw > 0 ? (swy - slope * swx) / sw : 0;
  return { slope: slope, intercept: intercept };
}

/** Ridge regression — polynomial with L2 regularization. */
function ridgeRegression(x, y, n, degree, lambda) {
  n = n === undefined ? x.length : n;
  degree = degree || 1;
  lambda = lambda || 0.01;
  const m = degree + 1;
  const A = [];
  const b = [];
  for (let i = 0; i < m; i++) {
    A.push(new Float64Array(m));
    b.push(0);
  }
  for (let i = 0; i < n; i++) {
    let xp = 1;
    for (let r = 0; r < m; r++) {
      b[r] += y[i] * xp;
      let xq = xp;
      for (let c = 0; c < m; c++) {
        A[r][c] += xq;
        xq *= x[i];
      }
      xp *= x[i];
    }
  }
  for (let i = 0; i < m; i++) A[i][i] += lambda;
  return _solveLinearSystem(A, b);
}

/**
 * Multiple linear regression via normal equations.
 * `X` is row-major (n × p), `y` is length n. Returns coefficients (length p).
 */
function multipleLinearRegression(X, y, n, p) {
  n = n === undefined ? X.length / p : n;
  p = p === undefined ? X.length / n : p;
  const XtX = [];
  const Xty = [];
  for (let i = 0; i < p; i++) {
    XtX.push(new Float64Array(p));
    Xty.push(0);
  }
  for (let r = 0; r < p; r++) {
    for (let c = 0; c < p; c++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += X[i * p + r] * X[i * p + c];
      XtX[r][c] = sum;
    }
    let sumY = 0;
    for (let i = 0; i < n; i++) sumY += X[i * p + r] * y[i];
    Xty[r] = sumY;
  }
  return _solveLinearSystem(XtX, Xty);
}

/**
 * Logistic regression via gradient descent. `y` is 0/1 labels.
 * Returns `{ weights, intercept, iterations, loss }`.
 */
function logisticRegression(X, y, n, p, options) {
  options = options || {};
  const iterations = options.iterations || 500;
  const lr = options.lr || 0.01;
  const weights = new Float64Array(p);
  let intercept = 0;
  let lastLoss = 0;
  for (let it = 0; it < iterations; it++) {
    const gradW = new Float64Array(p);
    let gradB = 0;
    let loss = 0;
    for (let i = 0; i < n; i++) {
      let z = intercept;
      for (let j = 0; j < p; j++) z += weights[j] * X[i * p + j];
      const phat = 1 / (1 + Math.exp(-z));
      const err = phat - y[i];
      gradB += err;
      for (let j = 0; j < p; j++) gradW[j] += err * X[i * p + j];
      loss += -(y[i] * Math.log(phat + 1e-12) + (1 - y[i]) * Math.log(1 - phat + 1e-12));
    }
    lastLoss = loss / n;
    intercept -= lr * gradB / n;
    for (let j = 0; j < p; j++) weights[j] -= lr * gradW[j] / n;
  }
  return { weights: weights, intercept: intercept, iterations: iterations, loss: lastLoss };
}

function rSquared(yTrue, yPred, n) {
  n = n === undefined ? yTrue.length : n;
  const m = mean(yTrue, n);
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    const dt = yTrue[i] - m;
    const dr = yTrue[i] - yPred[i];
    ssTot += dt * dt;
    ssRes += dr * dr;
  }
  return ssTot > 0 ? 1 - ssRes / ssTot : 0;
}

function adjustedRSquared(r2, n, p) {
  return 1 - (1 - r2) * (n - 1) / (n - p - 1);
}

// ============================================================================
// Function Declarations — Time series
// ============================================================================

function movingAverage(data, n, window, out) {
  n = n === undefined ? data.length : n;
  window = window || 3;
  out = out || new (getArrayType())(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += data[i];
    if (i >= window) sum -= data[i - window];
    out[i] = i >= window - 1 ? sum / window : sum / (i + 1);
  }
  return out;
}

/** Exponential moving average with smoothing factor α ∈ (0,1]. */
function exponentialMovingAverage(data, n, alpha, out) {
  n = n === undefined ? data.length : n;
  alpha = alpha || 0.1;
  out = out || new (getArrayType())(n);
  if (n === 0) return out;
  out[0] = data[0];
  for (let i = 1; i < n; i++) out[i] = alpha * data[i] + (1 - alpha) * out[i - 1];
  return out;
}

/**
 * AR(1) model fit via Yule-Walker. Returns `{ phi, sigma2 }`.
 */
function arModel(data, n) {
  n = n === undefined ? data.length : n;
  const m = mean(data, n);
  let num = 0, den = 0;
  for (let i = 1; i < n; i++) {
    num += (data[i] - m) * (data[i - 1] - m);
    den += (data[i - 1] - m) * (data[i - 1] - m);
  }
  const phi = den > 0 ? num / den : 0;
  let sigma2 = 0;
  for (let i = 1; i < n; i++) {
    const r = (data[i] - m) - phi * (data[i - 1] - m);
    sigma2 += r * r;
  }
  sigma2 = (n - 1) > 0 ? sigma2 / (n - 1) : 0;
  return { phi: phi, sigma2: sigma2, mean: m };
}

/**
 * Seasonal decomposition — splits `data` into trend (moving average),
 * seasonal (period average) and residual components.
 */
function seasonalDecompose(data, n, period) {
  n = n === undefined ? data.length : n;
  period = period || 12;
  const T = getArrayType();
  const trend = movingAverage(data, n, period);
  const seasonal = new T(period);
  for (let i = 0; i < period; i++) {
    let sum = 0, cnt = 0;
    for (let j = i; j < n; j += period) {
      sum += data[j] - trend[j];
      cnt++;
    }
    seasonal[i] = cnt > 0 ? sum / cnt : 0;
  }
  const residual = new T(n);
  for (let i = 0; i < n; i++) {
    residual[i] = data[i] - trend[i] - seasonal[i % period];
  }
  return { trend: trend, seasonal: seasonal, residual: residual };
}

// ============================================================================
// Function Declarations — Histogram / KDE
// ============================================================================

/**
 * Histogram. `bins` is either a count (uniform-width bins) or a
 * Float64Array of bin edges. Returns `{ edges, counts }`.
 */
function histogram(data, n, bins) {
  n = n === undefined ? data.length : n;
  const T = getArrayType();
  let edges;
  if (typeof bins === "number") {
    const minV = min(data, n);
    const maxV = max(data, n);
    const width = (maxV - minV) / bins;
    edges = new T(bins + 1);
    for (let i = 0; i <= bins; i++) edges[i] = minV + i * width;
  } else {
    edges = bins;
  }
  const counts = new T(edges.length - 1);
  for (let i = 0; i < n; i++) {
    const v = data[i];
    for (let b = 0; b < edges.length - 1; b++) {
      if (v >= edges[b] && v < edges[b + 1]) { counts[b]++; break; }
    }
  }
  return { edges: edges, counts: counts };
}

function gaussianKernel(u) { return INV_SQRT_2PI * Math.exp(-0.5 * u * u); }
function epanechnikovKernel(u) { return Math.abs(u) <= 1 ? 0.75 * (1 - u * u) : 0; }

/**
 * Kernel density estimation. Evaluates the KDE at each point in `xs`.
 */
function kernelDensityEstimate(data, n, xs, bandwidth, kernel) {
  n = n === undefined ? data.length : n;
  bandwidth = bandwidth || 1;
  kernel = kernel || gaussianKernel;
  const T = getArrayType();
  const out = new T(xs.length);
  const invBw = 1 / bandwidth;
  for (let i = 0; i < xs.length; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += kernel((xs[i] - data[j]) * invBw);
    out[i] = sum * invBw / n;
  }
  return out;
}

// ============================================================================
// Function Declarations — Reservoir sampling
// ============================================================================

/**
 * Reservoir sampling — sample `k` items from a stream of `n` elements.
 * Writes into `out`; returns number of items actually written.
 */
function reservoirSample(data, n, k, out, rng) {
  rng = rng || Math.random;
  k = Math.min(k, n);
  for (let i = 0; i < k; i++) out[i] = data[i];
  for (let i = k; i < n; i++) {
    const j = (rng() * (i + 1)) | 0;
    if (j < k) out[j] = data[i];
  }
  return k;
}

// ============================================================================
// Function Declarations — Domain helpers
// ============================================================================

/**
 * Scatter statistics — histogram, mean, variance, nearest-neighbor mean of
 * a 3D point set. Useful for validating Poisson-disk scatter.
 */
function scatterStats(positions, n, k) {
  n = n === undefined ? positions.count : n;
  k = k || 1;
  const T = getArrayType();
  const nn = new T(n);
  const px = positions.x, py = positions.y, pz = positions.z;
  for (let i = 0; i < n; i++) {
    let bestD = Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const dx = px[i] - px[j];
      const dy = py[i] - py[j];
      const dz = pz[i] - pz[j];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD) bestD = d2;
    }
    nn[i] = Math.sqrt(bestD);
  }
  return {
    mean: mean(nn, n),
    variance: variance(nn, n),
    minNN: min(nn, n),
    maxNN: max(nn, n),
    pointCount: n
  };
}

/**
 * HDR color statistics — mean, variance, luminance histogram for 1M+ colors.
 */
function colorStats(colors, n, bins) {
  n = n === undefined ? colors.count : n;
  bins = bins || 64;
  const T = getArrayType();
  const lum = new T(n);
  const cx = colors.x, cy = colors.y, cz = colors.z;
  for (let i = 0; i < n; i++) {
    lum[i] = 0.2126 * cx[i] + 0.7152 * cy[i] + 0.0722 * cz[i];
  }
  return {
    meanLuminance: mean(lum, n),
    varianceLuminance: variance(lum, n),
    minLuminance: min(lum, n),
    maxLuminance: max(lum, n),
    histogram: histogram(lum, n, bins)
  };
}

/**
 * Orbital statistics — sampling of positions/velocities for N-body diagnostics.
 */
function orbitalStats(positions, velocities, n) {
  n = n === undefined ? positions.count : n;
  const T = getArrayType();
  const r = new T(n);
  const v = new T(n);
  const px = positions.x, py = positions.y, pz = positions.z;
  const vx = velocities.x, vy = velocities.y, vz = velocities.z;
  for (let i = 0; i < n; i++) {
    r[i] = Math.sqrt(px[i] * px[i] + py[i] * py[i] + pz[i] * pz[i]);
    v[i] = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i]);
  }
  return {
    meanRadius: mean(r, n),
    varianceRadius: variance(r, n),
    meanVelocity: mean(v, n),
    varianceVelocity: variance(v, n),
    specificEnergyMean: mean(new T(n).map((_, i) => 0.5 * v[i] * v[i] - 1 / r[i]), n)
  };
}

/**
 * Animation curve statistics — mean velocity, acceleration variance,
 * and autocorrelation for motion-blend weight selection.
 */
function animationStats(samples, n, maxLag) {
  n = n === undefined ? samples.length : n;
  const T = getArrayType();
  const velocity = new T(Math.max(0, n - 1));
  const acceleration = new T(Math.max(0, n - 2));
  for (let i = 1; i < n; i++) velocity[i - 1] = samples[i] - samples[i - 1];
  for (let i = 2; i < n; i++) acceleration[i - 2] = velocity[i - 1] - velocity[i - 2];
  return {
    meanVelocity: mean(velocity, velocity.length),
    varianceVelocity: variance(velocity, velocity.length),
    meanAcceleration: mean(acceleration, acceleration.length),
    varianceAcceleration: variance(acceleration, acceleration.length),
    autocorrelation: autocorrelation(samples, n, maxLag)
  };
}

/**
 * IK trajectory statistics — path length, curvature, and velocity variance
 * for a joint position track.
 */
function ikStats(track, nSamples) {
  nSamples = nSamples === undefined ? track.length / 3 : nSamples;
  const T = getArrayType();
  const vel = new T(Math.max(0, nSamples - 1));
  const curvature = new T(Math.max(0, nSamples - 2));
  for (let i = 1; i < nSamples; i++) {
    const dx = track[i * 3] - track[(i - 1) * 3];
    const dy = track[i * 3 + 1] - track[(i - 1) * 3 + 1];
    const dz = track[i * 3 + 2] - track[(i - 1) * 3 + 2];
    vel[i - 1] = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  for (let i = 2; i < nSamples; i++) {
    const ax = track[i * 3] - 2 * track[(i - 1) * 3] + track[(i - 2) * 3];
    const ay = track[i * 3 + 1] - 2 * track[(i - 1) * 3 + 1] + track[(i - 2) * 3 + 1];
    const az = track[i * 3 + 2] - 2 * track[(i - 1) * 3 + 2] + track[(i - 2) * 3 + 2];
    curvature[i - 2] = Math.sqrt(ax * ax + ay * ay + az * az);
  }
  let pathLength = 0;
  for (let i = 0; i < vel.length; i++) pathLength += vel[i];
  return {
    pathLength: pathLength,
    meanVelocity: mean(vel, vel.length),
    varianceVelocity: variance(vel, vel.length),
    meanCurvature: mean(curvature, curvature.length),
    varianceCurvature: variance(curvature, curvature.length)
  };
}

// ============================================================================
// Function Declarations — Internal linear solver
// ============================================================================

/** Gaussian elimination with partial pivoting. Returns coefficient array. */
function _solveLinearSystem(A, b) {
  const n = A.length;
  const M = A.map((row) => {
    const r = new Float64Array(n + 1);
    r.set(row);
    return r;
  });
  for (let i = 0; i < n; i++) M[i][n] = b[i];
  for (let k = 0; k < n; k++) {
    let maxRow = k, maxVal = Math.abs(M[k][k]);
    for (let i = k + 1; i < n; i++) {
      if (Math.abs(M[i][k]) > maxVal) { maxVal = Math.abs(M[i][k]); maxRow = i; }
    }
    if (maxVal < EPSILON) continue;
    if (maxRow !== k) { const t = M[k]; M[k] = M[maxRow]; M[maxRow] = t; }
    for (let i = k + 1; i < n; i++) {
      const factor = M[i][k] / M[k][k];
      for (let j = k; j <= n; j++) M[i][j] -= factor * M[k][j];
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = M[i][n];
    for (let j = i + 1; j < n; j++) sum -= M[i][j] * x[j];
    x[i] = Math.abs(M[i][i]) > EPSILON ? sum / M[i][i] : 0;
  }
  return x;
}

// ============================================================================
// Function Declarations — SOA (sync)
// ============================================================================

function soaMean(data, count) {
  count = count === undefined ? data.length : count;
  return mean(data, count);
}

function soaVariance(data, count) {
  count = count === undefined ? data.length : count;
  return variance(data, count);
}

function soaStdDev(data, count) {
  count = count === undefined ? data.length : count;
  return stdDev(data, count);
}

function soaMin(data, count) { return min(data, count); }
function soaMax(data, count) { return max(data, count); }

function soaMedian(data, count) {
  count = count === undefined ? data.length : count;
  return median(data, count);
}

function soaQuantile(data, count, q) {
  count = count === undefined ? data.length : count;
  return quantile(data, count, q);
}

function soaSkewness(data, count) { return skewness(data, count); }
function soaKurtosis(data, count) { return kurtosis(data, count); }

function soaHistogram(data, count, bins) { return histogram(data, count, bins); }

function soaCovariance(a, b, count) {
  count = count === undefined ? a.length : count;
  return covariance(a, b, count);
}

function soaCorrelation(a, b, count) {
  count = count === undefined ? a.length : count;
  return correlation(a, b, count);
}

function soaMovingAverage(data, count, window) {
  count = count === undefined ? data.length : count;
  return movingAverage(data, count, window);
}

function soaAutocorrelation(data, count, maxLag) {
  count = count === undefined ? data.length : count;
  return autocorrelation(data, count, maxLag);
}

// ============================================================================
// Function Declarations — SOA (chunked async)
// ============================================================================

async function _chunked(count, chunkSize, yieldEvery, perChunk) {
  chunkSize  = chunkSize  || common.CHUNK_SIZE;
  yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
  let start = 0, c = 0;
  while (start < count) {
    const end = Math.min(start + chunkSize, count);
    perChunk(start, end);
    start = end;
    if (start >= count) break;
    if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
  }
}

async function soaMeanChunked(data, count, cs, ye) {
  count = count === undefined ? data.length : count;
  // Chunked Neumaier sum
  let sum = 0, c = 0;
  await _chunked(count, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      const x = data[i];
      const t = sum + x;
      if (Math.abs(sum) >= Math.abs(x)) c += (sum - t) + x;
      else c += (x - t) + sum;
      sum = t;
    }
  });
  return (sum + c) / count;
}

async function soaVarianceChunked(data, count, cs, ye) {
  count = count === undefined ? data.length : count;
  const m = await soaMeanChunked(data, count, cs, ye);
  let acc = 0;
  await _chunked(count, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      const d = data[i] - m;
      acc += d * d;
    }
  });
  return count > 1 ? acc / (count - 1) : 0;
}

async function soaHistogramChunked(data, count, bins, cs, ye) {
  count = count === undefined ? data.length : count;
  const T = getArrayType();
  let edges;
  if (typeof bins === "number") {
    // First pass: min/max
    let mn = Infinity, mx = -Infinity;
    await _chunked(count, cs, ye, (s, e) => {
      for (let i = s; i < e; i++) {
        if (data[i] < mn) mn = data[i];
        if (data[i] > mx) mx = data[i];
      }
    });
    const width = (mx - mn) / bins;
    edges = new T(bins + 1);
    for (let i = 0; i <= bins; i++) edges[i] = mn + i * width;
  } else {
    edges = bins;
  }
  const counts = new T(edges.length - 1);
  await _chunked(count, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      const v = data[i];
      for (let b = 0; b < edges.length - 1; b++) {
        if (v >= edges[b] && v < edges[b + 1]) { counts[b]++; break; }
      }
    }
  });
  return { edges: edges, counts: counts };
}

async function soaCovarianceChunked(a, b, count, cs, ye) {
  count = count === undefined ? a.length : count;
  const ma = await soaMeanChunked(a, count, cs, ye);
  const mb = await soaMeanChunked(b, count, cs, ye);
  let acc = 0;
  await _chunked(count, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) acc += (a[i] - ma) * (b[i] - mb);
  });
  return count > 1 ? acc / (count - 1) : 0;
}

async function soaCorrelationChunked(a, b, count, cs, ye) {
  count = count === undefined ? a.length : count;
  const ma = await soaMeanChunked(a, count, cs, ye);
  const mb = await soaMeanChunked(b, count, cs, ye);
  let sab = 0, sa2 = 0, sb2 = 0;
  await _chunked(count, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      const da = a[i] - ma;
      const db = b[i] - mb;
      sab += da * db;
      sa2 += da * da;
      sb2 += db * db;
    }
  });
  const denom = Math.sqrt(sa2 * sb2);
  return denom > 0 ? sab / denom : 0;
}

async function soaMedianChunked(data, count, cs, ye) {
  count = count === undefined ? data.length : count;
  // Copy to temp array, then sort synchronously (still yields during copy)
  const T = getArrayType();
  const copy = new T(count);
  await _chunked(count, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) copy[i] = data[i];
  });
  const arr = Array.prototype.slice.call(copy);
  arr.sort((a, b) => a - b);
  if (count % 2 === 1) return arr[(count - 1) >> 1];
  return (arr[count / 2 - 1] + arr[count / 2]) * 0.5;
}

// ============================================================================
// Function Declarations — Pools
// ============================================================================

function createStatsScratchPool(capacity) {
  return common.createPool(
    function () {
      const T = getArrayType();
      return {
        a: new T(256),
        b: new T(256),
        c: new T(256),
        size: 256,
        _attached: false,
        ensure: function (n) {
          if (n <= this.size) return this;
          const T2 = getArrayType();
          this.size = n;
          this.a = new T2(n);
          this.b = new T2(n);
          this.c = new T2(n);
          return this;
        }
      };
    },
    capacity || 8,
    function (s) {
      if (s.a) s.a.fill(0);
      if (s.b) s.b.fill(0);
      if (s.c) s.c.fill(0);
    }
  );
}

function acquireStatsScratch(size) {
  const s = _statsScratchPool.acquire();
  if (size !== undefined) s.ensure(size);
  return s;
}
function releaseStatsScratch(s) { _statsScratchPool.release(s); }

// ============================================================================
// Class Declarations
// ============================================================================

/**
 * Reusable stats scratch buffer for scalar hot loops.
 */
class StatsScratch {
  static #warm = [];
  static {
    for (let i = 0; i < 8; i++) StatsScratch.#warm.push(new StatsScratch(256));
  }
  static acquire(size) {
    for (let i = 0; i < StatsScratch.#warm.length; i++) {
      if (StatsScratch.#warm[i].size >= (size || 0)) {
        const s = StatsScratch.#warm[i];
        StatsScratch.#warm.splice(i, 1);
        return s;
      }
    }
    return new StatsScratch(size || 256);
  }
  static release(s) { if (s) { s.reset(); StatsScratch.#warm.push(s); } }

  constructor(size) {
    this.size = size || 256;
    const T = getArrayType();
    this.a = new T(this.size);
    this.b = new T(this.size);
    this.c = new T(this.size);
  }

  ensure(n) {
    if (n <= this.size) return this;
    this.size = n;
    const T = getArrayType();
    this.a = new T(n);
    this.b = new T(n);
    this.c = new T(n);
    return this;
  }
  reset() { this.a.fill(0); this.b.fill(0); this.c.fill(0); return this; }
}

/**
 * Batch state — preallocated buffers for repeated statistical passes over
 * 1M+ samples. Re-create after `setPrecision()` to pick up the new type.
 */
class StatsBatchState {
  static #listeners = new Set();
  static {
    onPrecisionChange(function (mode, oldMode) {
      StatsBatchState.#listeners.forEach((cb) => { try { cb(mode, oldMode); } catch (e) {} });
    });
  }

  constructor(count) {
    this.count = count;
    const T = getArrayType();
    this.data = new T(count);
    this.aux = new T(count);
    this.out = new T(count);
  }

  mean()        { return mean(this.data, this.count); }
  variance()    { return variance(this.data, this.count); }
  stdDev()      { return stdDev(this.data, this.count); }
  median()      { return median(this.data, this.count); }
  histogram(bins) { return histogram(this.data, this.count, bins); }

  async meanChunked(cs, ye) { return soaMeanChunked(this.data, this.count, cs, ye); }
  async medianChunked(cs, ye) { return soaMedianChunked(this.data, this.count, cs, ye); }
  async histogramChunked(bins, cs, ye) { return soaHistogramChunked(this.data, this.count, bins, cs, ye); }
}

function createStatsBatch(count) { return new StatsBatchState(count); }

// ============================================================================
// Namespace convenience
// ============================================================================

exports.namespace.descriptive = {
  mean, variance, stdDev, median, mode,
  quantile, iqr, min, max, range: rangeOf,
  mad, skewness, kurtosis,
  weightedMean, weightedVariance
};

exports.namespace.correlation = {
  covariance, correlation,
  spearman: spearmanCorrelation,
  kendall: kendallCorrelation,
  autocorrelation, crossCorrelation
};

exports.namespace.distributions = {
  normalPDF, normalCDF, normalInverseCDF, normalSample,
  uniformPDF, uniformCDF, uniformSample,
  exponentialPDF, exponentialCDF, exponentialSample,
  logNormalPDF, logNormalSample,
  gammaPDF, gammaSample,
  betaPDF, betaSample,
  chiSquarePDF, chiSquareSample,
  studentTPDF, studentTSample,
  fPDF, fSample,
  poissonPMF, poissonSample,
  binomialPMF, binomialSample,
  bernoulliSample,
  dirichletSample
};

exports.namespace.tests = {
  tTestOneSample, tTestTwoSample,
  chiSquare: chiSquareTest,
  fTest,
  ks: ksTest,
  mannWhitneyU,
  anova
};

exports.namespace.regression = {
  linear: linearRegression,
  polynomial: polynomialRegression,
  weighted: weightedLinearRegression,
  ridge: ridgeRegression,
  multiple: multipleLinearRegression,
  logistic: logisticRegression,
  rSquared,
  adjustedRSquared
};

exports.namespace.timeseries = {
  movingAverage,
  ema: exponentialMovingAverage,
  ewma: exponentialMovingAverage,
  ar: arModel,
  seasonalDecompose
};

exports.namespace.histogram = {
  histogram,
  kde: kernelDensityEstimate,
  gaussian: gaussianKernel,
  epanechnikov: epanechnikovKernel
};

exports.namespace.sampling = {
  reservoir: reservoirSample
};

exports.namespace.domain = {
  scatter: scatterStats,
  color: colorStats,
  orbital: orbitalStats,
  animation: animationStats,
  ik: ikStats
};

exports.namespace.batch = {
  mean: soaMean,
  meanChunked: soaMeanChunked,
  variance: soaVariance,
  varianceChunked: soaVarianceChunked,
  stdDev: soaStdDev,
  min: soaMin,
  max: soaMax,
  median: soaMedian,
  medianChunked: soaMedianChunked,
  quantile: soaQuantile,
  skewness: soaSkewness,
  kurtosis: soaKurtosis,
  histogram: soaHistogram,
  histogramChunked: soaHistogramChunked,
  covariance: soaCovariance,
  covarianceChunked: soaCovarianceChunked,
  correlation: soaCorrelation,
  correlationChunked: soaCorrelationChunked,
  movingAverage: soaMovingAverage,
  autocorrelation: soaAutocorrelation,
  State: StatsBatchState,
  create: createStatsBatch
};

// ============================================================================
// Precision listener
// ============================================================================

onPrecisionChange(function (mode, oldMode) {
  // Existing batch states keep their current arrays. New ones created after
  // this point use the new type via getArrayType().
});
