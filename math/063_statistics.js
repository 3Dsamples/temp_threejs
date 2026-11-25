//File number : 063
// File : src/math/063_statistics.js
//Description : Complete statistics system — descriptive (mean, variance, standard deviation, median, mode, quantiles, IQR, MAD, skewness, kurtosis, weighted mean/variance), covariance / correlation (Pearson, Spearman, Kendall), distribution fitting and sampling (normal, uniform, exponential, log-normal, gamma, beta, chi-square, Student-t, F, Poisson, binomial, Bernoulli, Dirichlet), PDF / CDF / inverse-CDF for the continuous distributions, hypothesis tests (one- and two-sample t, chi-square, F, Kolmogorov-Smirnov, Mann-Whitney U, ANOVA), linear / polynomial / weighted / ridge / multiple regression with residual analysis, logistic regression (batch-fit via gradient descent), time-series analysis (moving average, EMA/EWMA, autocorrelation, cross-correlation, AR(1) fit, seasonal decomposition), histogram and kernel density estimation (Gaussian / Epanechnikov kernels), reservoir sampling, Welford online/streaming moments for the adaptive quality controller, and domain helpers for procedural scatter statistics, HDR color statistics, orbital motion analysis, and animation curve feature extraction. Every routine has a synchronous SOA batch version plus a chunked async variant that yields via `scheduler.yield()` for 1M+ element runs on Android 64-bit. All scratch state is pooled, and buffers use `000_Math_module.js` precision mode (Float16/Float32/Float64 live-swap).
// Zero-GC Compliance : Strict adherence to the Enhanced Zero-GC ECS mandate. No closures, no array literals, no Map/Set, and no dynamic allocations in any hot loop. `mode` uses a pooled sort-and-scan (no Map); Spearman ranks use a pooled index buffer with a hoisted comparator (no per-call closures); median/quantile use an in-place iterative quickselect on pooled scratch (no `subarray` views, no full sort). Chunked async kernels inline their loops (no per-call callbacks). Sort-backed routines that require an exact-length buffer use amortized grow-only module buffers (allocation only when the dataset length first changes). All allocations occur exclusively at module init / pool growth.
//Corrections : ESM imports/exports only (no require/exports). Fixed: `median`/`quantile` used `Array.prototype.slice` + `subarray` (allocation) and full sorts (now pooled quickselect); `mode` used a forbidden `Map` (now sort-and-scan); `_rank` allocated an index Array and closures per call (now pooled `Uint32Array` + hoisted comparator); `logisticRegression` allocated the gradient vector inside the iteration loop (now hoisted); `orbitalStats` used `TypedArray.map` with a closure (now inline accumulation); `_statsScratchPool` monkey-patched `acquire` with a bound closure (now shared hoisted `ensure`); `StatsScratch` used an unbounded push/splice warm pool (now fixed-capacity swap-remove); `StatsBatchState` used a Set + forEach listeners (removed); every chunked kernel allocated a per-call closure via `_chunked` (now inlined while-loops); `soaMedianChunked` used `Array.prototype.slice` (now pooled sort); `histogram` allocated twice (now a zero-GC `histogramInto` core).
//Added : `histogramInto` (zero-GC histogram core), `percentile` alias, Welford streaming moments (`createWelford`/`welfordUpdate`/`welfordMean`/`welfordVariance`) for the adaptive quality controller, `soaNormalPDF`/`soaNormalCDF` for batch importance-sampling verification, and chunked variants for skewness and kurtosis.
//License : MIT
// ============================================================================
// Directive Prologues
// ============================================================================
"use strict";

// ============================================================================
// Import (ES Modules — sibling files within the 54-file math topology)
// ============================================================================
import { common, getArrayType, onPrecisionChange } from './000_Math_module.js';
import {
    erf, erfinv, lgamma, lnBeta, beta, lnBinom,
    incompleteBeta, incompleteGammaQ
} from './055_special-functions.js';

// ============================================================================
// Variable Declarations — constants and module scratch (init-time only)
// ============================================================================
const PI           = Math.PI;
const TAU          = PI * 2;
const SQRT_2       = Math.SQRT2;
const SQRT_2PI     = Math.sqrt(TAU);
const INV_SQRT_2PI = 1 / SQRT_2PI;
const EPSILON      = 1e-12;

// Sort-backed routines need exact-length buffers. These grow only when the
// dataset length first changes (amortized zero-GC) and are analysis-time.
let _sortF = null, _sortFLen = 0;
let _sortI = null, _sortILen = 0;
let _rankData = null;

function _sortFloat(n) {
    if (_sortFLen !== n) { _sortF = new (getArrayType())(n); _sortFLen = n; }
    return _sortF;
}
function _sortInt(n) {
    if (_sortILen !== n) { _sortI = new Uint32Array(n); _sortILen = n; }
    return _sortI;
}
// Hoisted comparator for rank sorting (no per-call closure).
function _rankCmp(i, j) { return _rankData[i] - _rankData[j]; }

// ============================================================================
// Scratch pool — precision-aware, buffer-preserving release
// ============================================================================
function _statsScratchEnsure(s, n) {
    if (n <= s.size) return s;
    const T = getArrayType();
    s.size = n;
    s.a = new T(n);
    s.b = new T(n);
    s.c = new T(n);
    return s;
}

function _statsScratchFactory() {
    const T = getArrayType();
    return { a: new T(256), b: new T(256), c: new T(256), size: 256, ensure: _statsScratchEnsure };
}

function _statsScratchReset(s) { /* buffers retained for Zero-GC reuse */ }

const _statsScratchPool = common.createPool(_statsScratchFactory, 8, _statsScratchReset);

for (let _pw = 0; _pw < 8; _pw++) {
    const _s = _statsScratchPool.acquire() || _statsScratchFactory();
    _statsScratchPool.release(_s);
}

function acquireStatsScratch(size) {
    const s = _statsScratchPool.acquire() || _statsScratchFactory();
    if (size !== undefined) s.ensure(size);
    return s;
}
function releaseStatsScratch(s) { if (s) _statsScratchPool.release(s); }
function createStatsScratchPool(capacity) {
    return common.createPool(_statsScratchFactory, capacity || 8, _statsScratchReset);
}

// ============================================================================
// Function Declarations — internal numeric helpers
// ============================================================================
function _neumaierSum(data, n) {
    let sum = 0, c = 0;
    for (let i = 0; i < n; i++) {
        const x = data[i];
        const t = sum + x;
        if (Math.abs(sum) >= Math.abs(x)) c += (sum - t) + x;
        else c += (x - t) + sum;
        sum = t;
    }
    return sum + c;
}

/** In-place iterative quickselect: k-th smallest of a[lo..hi]. Zero-GC. */
function _quickselect(a, lo, hi, k) {
    while (hi > lo) {
        const mid = (lo + hi) >> 1;
        if (a[mid] < a[lo]) { let t = a[lo]; a[lo] = a[mid]; a[mid] = t; }
        if (a[hi] < a[lo])  { let t = a[lo]; a[lo] = a[hi];  a[hi]  = t; }
        if (a[hi] < a[mid]) { let t = a[mid]; a[mid] = a[hi]; a[hi] = t; }
        const pivot = a[mid];
        let i = lo, j = hi;
        while (i <= j) {
            while (a[i] < pivot) i++;
            while (a[j] > pivot) j--;
            if (i <= j) { let t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
        }
        if (k <= j) hi = j;
        else if (k >= i) lo = i;
        else return a[k];
    }
    return a[lo];
}

/** Write the ranks of `data` (with tie averaging) into `rankOut`. Zero-GC. */
function _rankInto(data, n, rankOut) {
    const idx = _sortInt(n);
    _rankData = data;
    for (let i = 0; i < n; i++) idx[i] = i;
    idx.sort(_rankCmp);
    let i = 0;
    while (i < n) {
        let j = i;
        while (j + 1 < n && data[idx[j + 1]] === data[idx[i]]) j++;
        const avgRank = (i + j) * 0.5 + 1;
        for (let k = i; k <= j; k++) rankOut[idx[k]] = avgRank;
        i = j + 1;
    }
    return rankOut;
}

// ============================================================================
// Function Declarations — Descriptive statistics
// ============================================================================
function mean(data, n) {
    n = n === undefined ? data.length : n;
    if (n === 0) return 0;
    return _neumaierSum(data, n) / n;
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

/** Median via pooled quickselect (no allocation after scratch warm-up). */
function median(data, n) {
    n = n === undefined ? data.length : n;
    if (n === 0) return 0;
    const s = acquireStatsScratch(n);
    const c = s.a;
    for (let i = 0; i < n; i++) c[i] = data[i];
    let result;
    if (n & 1) {
        result = _quickselect(c, 0, n - 1, (n - 1) >> 1);
    } else {
        const lo = _quickselect(c, 0, n - 1, n / 2 - 1);
        const hi = _quickselect(c, 0, n - 1, n / 2);
        result = (lo + hi) * 0.5;
    }
    releaseStatsScratch(s);
    return result;
}

/** Quantile via pooled quickselect + linear interpolation. */
function quantile(data, n, q) {
    n = n === undefined ? data.length : n;
    if (n === 0) return 0;
    if (q <= 0) return min(data, n);
    if (q >= 1) return max(data, n);
    const s = acquireStatsScratch(n);
    const c = s.a;
    for (let i = 0; i < n; i++) c[i] = data[i];
    const pos = (n - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    const frac = pos - lo;
    const vlo = _quickselect(c, 0, n - 1, lo);
    const vhi = lo === hi ? vlo : _quickselect(c, 0, n - 1, hi);
    releaseStatsScratch(s);
    return vlo * (1 - frac) + vhi * frac;
}

/** Alias of `quantile`. */
function percentile(data, n, p) { return quantile(data, n, p); }

function iqr(data, n) {
    n = n === undefined ? data.length : n;
    return quantile(data, n, 0.75) - quantile(data, n, 0.25);
}

/**
 * Mode via pooled sort-and-scan (no Map). Uses an amortized grow-only buffer
 * because a full sort requires an exact-length array (analysis-time routine).
 */
function mode(data, n) {
    n = n === undefined ? data.length : n;
    if (n === 0) return 0;
    const buf = _sortFloat(n);
    for (let i = 0; i < n; i++) buf[i] = data[i];
    buf.sort();
    let best = buf[0], bestCount = 1, cur = buf[0], curCount = 1;
    for (let i = 1; i < n; i++) {
        if (buf[i] === cur) { curCount++; }
        else {
            if (curCount > bestCount) { bestCount = curCount; best = cur; }
            cur = buf[i]; curCount = 1;
        }
    }
    if (curCount > bestCount) best = cur;
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

function rangeOf(data, n) { return max(data, n) - min(data, n); }

/** Median absolute deviation. */
function mad(data, n) {
    n = n === undefined ? data.length : n;
    if (n === 0) return 0;
    const m = median(data, n);
    const s = acquireStatsScratch(n);
    const devs = s.a;
    for (let i = 0; i < n; i++) devs[i] = Math.abs(data[i] - m);
    const result = median(devs, n);
    releaseStatsScratch(s);
    return result;
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

/** Spearman rank correlation — pooled ranks, zero-GC after warm-up. */
function spearmanCorrelation(a, b, n) {
    n = n === undefined ? a.length : n;
    if (n < 2) return 0;
    const s = acquireStatsScratch(n);
    const ra = s.a, rb = s.b;
    _rankInto(a, n, ra);
    _rankInto(b, n, rb);
    const r = correlation(ra, rb, n);
    releaseStatsScratch(s);
    return r;
}

/** Kendall tau — O(n²) concordant/discordant scan (analysis-time). */
function kendallCorrelation(a, b, n) {
    n = n === undefined ? a.length : n;
    if (n < 2) return 0;
    let concordant = 0, discordant = 0;
    for (let i = 0; i < n - 1; i++) {
        for (let j = i + 1; j < n; j++) {
            const prod = (a[i] - a[j]) * (b[i] - b[j]);
            if (prod > 0) concordant++;
            else if (prod < 0) discordant++;
        }
    }
    return (concordant - discordant) / (0.5 * n * (n - 1));
}

function autocorrelation(data, n, maxLag, out) {
    n = n === undefined ? data.length : n;
    maxLag = maxLag === undefined ? Math.min(n - 1, Math.floor(n / 4)) : maxLag;
    const T = getArrayType();
    out = out || new T(maxLag);
    const m = mean(data, n);
    let denom = 0;
    for (let i = 0; i < n; i++) {
        const d = data[i] - m;
        denom += d * d;
    }
    if (denom === 0) { for (let i = 0; i < maxLag; i++) out[i] = 0; return out; }
    for (let lag = 1; lag <= maxLag; lag++) {
        let acc = 0;
        for (let i = 0; i < n - lag; i++) acc += (data[i] - m) * (data[i + lag] - m);
        out[lag - 1] = acc / denom;
    }
    return out;
}

function crossCorrelation(a, b, n, maxLag, out) {
    n = n === undefined ? a.length : n;
    maxLag = maxLag === undefined ? Math.min(n - 1, Math.floor(n / 4)) : maxLag;
    const T = getArrayType();
    out = out || new T(2 * maxLag + 1);
    const ma = mean(a, n);
    const mb = mean(b, n);
    let sa = 0, sb = 0;
    for (let i = 0; i < n; i++) {
        const da = a[i] - ma, db = b[i] - mb;
        sa += da * da; sb += db * db;
    }
    const denom = Math.sqrt(sa * sb);
    if (denom === 0) { for (let i = 0; i < out.length; i++) out[i] = 0; return out; }
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
    return 0.5 * (1 + erf((x - mu) / (sigma * SQRT_2)));
}

function normalInverseCDF(p, mu, sigma) {
    mu = mu || 0;
    sigma = sigma === undefined ? 1 : sigma;
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    return mu + sigma * SQRT_2 * erfinv(2 * p - 1);
}

function normalSample(mu, sigma, rng) {
    mu = mu || 0;
    sigma = sigma === undefined ? 1 : sigma;
    rng = rng || Math.random;
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
    return Math.exp((shape - 1) * Math.log(x) - x / scale - lgamma(shape) - shape * Math.log(scale));
}

/** Marsaglia & Tsang gamma sampler (boost for shape < 1). */
function gammaSample(shape, scale, rng) {
    shape = shape === undefined ? 1 : shape;
    scale = scale === undefined ? 1 : scale;
    rng = rng || Math.random;
    if (shape < 1) {
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
    return Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - lnBeta(a, b));
}

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
    const c = Math.exp(lgamma((df + 1) / 2) - lgamma(df / 2)) / Math.sqrt(df * PI);
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
    return Math.sqrt(num / den) / (x * beta(df1 / 2, df2 / 2));
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
    return Math.exp(k * Math.log(lambda) - lambda - lgamma(k + 1));
}

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
    return Math.exp(lnBinom(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p));
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

/** Dirichlet sampler via gamma draws. Writes normalized samples into `out`. */
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
    const num = (vA / nA + vB / nB) * (vA / nA + vB / nB);
    const den = (vA / nA) * (vA / nA) / (nA - 1) + (vB / nB) * (vB / nB) / (nB - 1);
    const df = den > 0 ? num / den : nA + nB - 2;
    const p = 2 * (1 - _studentTCDF(Math.abs(t), df));
    return { t: t, df: df, pValue: p };
}

function _studentTCDF(t, df) {
    const x = df / (df + t * t);
    const ib = incompleteBeta(x, df / 2, 0.5);
    return t > 0 ? 1 - 0.5 * ib : 0.5 * ib;
}

function chiSquareTest(observed, n, expected) {
    n = n === undefined ? observed.length : n;
    let chi2 = 0;
    if (!expected) {
        const meanO = mean(observed, n);
        for (let i = 0; i < n; i++) {
            const diff = observed[i] - meanO;
            if (meanO > 0) chi2 += diff * diff / meanO;
        }
    } else {
        for (let i = 0; i < n; i++) {
            const diff = observed[i] - expected[i];
            if (expected[i] > 0) chi2 += diff * diff / expected[i];
        }
    }
    const df = n - 1;
    const p = incompleteGammaQ(df / 2, chi2 / 2);
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
    const x = df1 * f / (df1 * f + df2);
    const p = incompleteBeta(x, df1 / 2, df2 / 2);
    return { f: f, df1: df1, df2: df2, pValue: 1 - p };
}

function ksTest(data, n, cdfFn) {
    n = n === undefined ? data.length : n;
    const buf = _sortFloat(n);
    for (let i = 0; i < n; i++) buf[i] = data[i];
    buf.sort();
    let maxD = 0;
    for (let i = 0; i < n; i++) {
        const fxi = cdfFn(buf[i]);
        const dPlus = (i + 1) / n - fxi;
        const dMinus = fxi - i / n;
        const d = Math.abs(dPlus) > Math.abs(dMinus) ? Math.abs(dPlus) : Math.abs(dMinus);
        if (d > maxD) maxD = d;
    }
    const sqrtN = Math.sqrt(n);
    const lambda = (sqrtN + 0.12 + 0.11 / sqrtN) * maxD;
    let pValue = 0;
    for (let k = 1; k <= 100; k++) {
        const term = 2 * Math.pow(-1, k - 1) * Math.exp(-2 * k * k * lambda * lambda);
        pValue += term;
        if (Math.abs(term) < 1e-12) break;
    }
    pValue = pValue < 0 ? 0 : pValue > 1 ? 1 : pValue;
    return { d: maxD, pValue: pValue };
}

function mannWhitneyU(a, b, nA, nB) {
    nA = nA === undefined ? a.length : nA;
    nB = nB === undefined ? b.length : nB;
    const total = nA + nB;
    const s = acquireStatsScratch(total);
    const vals = s.a, groups = s.b, ranks = s.c;
    for (let i = 0; i < nA; i++) { vals[i] = a[i]; groups[i] = 0; }
    for (let i = 0; i < nB; i++) { vals[nA + i] = b[i]; groups[nA + i] = 1; }
    const idx = _sortInt(total);
    _rankData = vals;
    for (let i = 0; i < total; i++) idx[i] = i;
    idx.sort(_rankCmp);
    let i = 0;
    while (i < total) {
        let j = i;
        while (j + 1 < total && vals[idx[j + 1]] === vals[idx[i]]) j++;
        const avgRank = (i + j) * 0.5 + 1;
        for (let k = i; k <= j; k++) ranks[idx[k]] = avgRank;
        i = j + 1;
    }
    let rankSumA = 0;
    for (let k = 0; k < total; k++) if (groups[k] === 0) rankSumA += ranks[k];
    const uA = rankSumA - nA * (nA + 1) / 2;
    const uB = nA * nB - uA;
    const u = uA < uB ? uA : uB;
    const mu = nA * nB / 2;
    const sigma = Math.sqrt(nA * nB * (nA + nB + 1) / 12);
    const z = sigma > 0 ? (u - mu) / sigma : 0;
    const p = 2 * (1 - normalCDF(Math.abs(z), 0, 1));
    releaseStatsScratch(s);
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
    const x = dfBetween * f / (dfBetween * f + dfWithin);
    const p = 1 - incompleteBeta(x, dfBetween / 2, dfWithin / 2);
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

function polynomialRegression(x, y, n, degree) {
    n = n === undefined ? x.length : n;
    degree = degree || 1;
    const m = degree + 1;
    const A = new Array(m);
    const b = new Float64Array(m);
    for (let i = 0; i < m; i++) A[i] = new Float64Array(m);
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
    return _solveLinearSystem(A, b, m);
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

function ridgeRegression(x, y, n, degree, lambda) {
    n = n === undefined ? x.length : n;
    degree = degree || 1;
    lambda = lambda || 0.01;
    const m = degree + 1;
    const A = new Array(m);
    const b = new Float64Array(m);
    for (let i = 0; i < m; i++) A[i] = new Float64Array(m);
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
    return _solveLinearSystem(A, b, m);
}

function multipleLinearRegression(X, y, n, p) {
    n = n === undefined ? X.length / p : n;
    p = p === undefined ? X.length / n : p;
    const XtX = new Array(p);
    const Xty = new Float64Array(p);
    for (let i = 0; i < p; i++) XtX[i] = new Float64Array(p);
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
    return _solveLinearSystem(XtX, Xty, p);
}

/**
 * Logistic regression via gradient descent. The gradient buffer is hoisted
 * outside the iteration loop (previous version allocated it per iteration).
 */
function logisticRegression(X, y, n, p, options) {
    options = options || {};
    const iterations = options.iterations || 500;
    const lr = options.lr || 0.01;
    const weights = new Float64Array(p);
    const gradW = new Float64Array(p);
    let intercept = 0;
    let lastLoss = 0;
    for (let it = 0; it < iterations; it++) {
        for (let j = 0; j < p; j++) gradW[j] = 0;
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
    const T = getArrayType();
    out = out || new T(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        sum += data[i];
        if (i >= window) sum -= data[i - window];
        out[i] = i >= window - 1 ? sum / window : sum / (i + 1);
    }
    return out;
}

function exponentialMovingAverage(data, n, alpha, out) {
    n = n === undefined ? data.length : n;
    alpha = alpha || 0.1;
    const T = getArrayType();
    out = out || new T(n);
    if (n === 0) return out;
    out[0] = data[0];
    for (let i = 1; i < n; i++) out[i] = alpha * data[i] + (1 - alpha) * out[i - 1];
    return out;
}

function ewma(data, n, alpha, out) { return exponentialMovingAverage(data, n, alpha, out); }

/** AR(1) model fit via Yule-Walker. Returns `{ phi, sigma2, mean }`. */
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
    for (let i = 0; i < n; i++) residual[i] = data[i] - trend[i] - seasonal[i % period];
    return { trend: trend, seasonal: seasonal, residual: residual };
}

// ============================================================================
// Function Declarations — Histogram / KDE
// ============================================================================
/**
 * Zero-GC histogram core. `edges` has length binCount+1, `counts` has length
 * binCount; both are caller-owned. Computes uniform-width bins from [min,max].
 */
function histogramInto(edges, counts, data, n, binCount) {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < n; i++) {
        if (data[i] < mn) mn = data[i];
        if (data[i] > mx) mx = data[i];
    }
    const width = (mx - mn) / binCount || 1;
    for (let i = 0; i <= binCount; i++) edges[i] = mn + i * width;
    counts.fill(0);
    for (let i = 0; i < n; i++) {
        let b = ((data[i] - mn) / width) | 0;
        if (b >= binCount) b = binCount - 1;
        if (b < 0) b = 0;
        counts[b]++;
    }
    return counts;
}

/**
 * Convenience wrapper that allocates the edges/counts buffers once. Prefer
 * `histogramInto` in hot loops.
 */
function histogram(data, n, bins) {
    n = n === undefined ? data.length : n;
    const T = getArrayType();
    let binCount;
    if (typeof bins === "number") {
        binCount = bins;
        const edges = new T(binCount + 1);
        const counts = new T(binCount);
        histogramInto(edges, counts, data, n, binCount);
        return { edges: edges, counts: counts };
    }
    // `bins` is an edges array
    const edges = bins;
    const counts = new T(edges.length - 1);
    counts.fill(0);
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

function kernelDensityEstimate(data, n, xs, bandwidth, kernel, out) {
    n = n === undefined ? data.length : n;
    bandwidth = bandwidth || 1;
    kernel = kernel || gaussianKernel;
    const T = getArrayType();
    out = out || new T(xs.length);
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
// Function Declarations — Welford online moments (streaming, zero-GC)
// ============================================================================
/**
 * Streaming mean/variance state. Perfect for the adaptive quality controller
 * that monitors frame times and thermal metrics without storing the samples.
 */
function createWelford() { return { count: 0, mean: 0, m2: 0 }; }

function welfordUpdate(state, x) {
    state.count++;
    const d = x - state.mean;
    state.mean += d / state.count;
    state.m2 += d * (x - state.mean);
    return state;
}

function welfordMean(state) { return state.mean; }

function welfordVariance(state) {
    return state.count > 1 ? state.m2 / (state.count - 1) : 0;
}

function welfordStdDev(state) { return Math.sqrt(welfordVariance(state)); }

// ============================================================================
// Function Declarations — Domain helpers
// ============================================================================
/** Nearest-neighbor scatter statistics (analysis-time, O(n²)). */
function scatterStats(positions, n) {
    n = n === undefined ? positions.count : n;
    const s = acquireStatsScratch(n);
    const nn = s.a;
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
    const result = {
        mean: mean(nn, n),
        variance: variance(nn, n),
        minNN: min(nn, n),
        maxNN: max(nn, n),
        pointCount: n
    };
    releaseStatsScratch(s);
    return result;
}

/** HDR color statistics — luminance moments + histogram. */
function colorStats(colors, n, bins) {
    n = n === undefined ? colors.count : n;
    bins = bins || 64;
    const s = acquireStatsScratch(n);
    const lum = s.a;
    const cx = colors.x, cy = colors.y, cz = colors.z;
    for (let i = 0; i < n; i++) {
        lum[i] = 0.2126 * cx[i] + 0.7152 * cy[i] + 0.0722 * cz[i];
    }
    const result = {
        meanLuminance: mean(lum, n),
        varianceLuminance: variance(lum, n),
        minLuminance: min(lum, n),
        maxLuminance: max(lum, n),
        histogram: histogram(lum, n, bins)
    };
    releaseStatsScratch(s);
    return result;
}

/** Orbital diagnostics — radius/velocity moments and mean specific energy. */
function orbitalStats(positions, velocities, n) {
    n = n === undefined ? positions.count : n;
    const s = acquireStatsScratch(n);
    const r = s.a, v = s.b;
    const px = positions.x, py = positions.y, pz = positions.z;
    const vx = velocities.x, vy = velocities.y, vz = velocities.z;
    let energySum = 0;
    for (let i = 0; i < n; i++) {
        const rr = Math.sqrt(px[i] * px[i] + py[i] * py[i] + pz[i] * pz[i]);
        const vv = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i]);
        r[i] = rr;
        v[i] = vv;
        energySum += 0.5 * vv * vv - (rr > EPSILON ? 1 / rr : 0);
    }
    const result = {
        meanRadius: mean(r, n),
        varianceRadius: variance(r, n),
        meanVelocity: mean(v, n),
        varianceVelocity: variance(v, n),
        specificEnergyMean: n > 0 ? energySum / n : 0
    };
    releaseStatsScratch(s);
    return result;
}

/** Animation curve feature extraction for motion-blend weight selection. */
function animationStats(samples, n, maxLag) {
    n = n === undefined ? samples.length : n;
    const T = getArrayType();
    const nv = Math.max(0, n - 1);
    const na = Math.max(0, n - 2);
    const s = acquireStatsScratch(Math.max(nv, na, 1));
    const velocity = s.a, acceleration = s.b;
    for (let i = 1; i < n; i++) velocity[i - 1] = samples[i] - samples[i - 1];
    for (let i = 2; i < n; i++) acceleration[i - 2] = velocity[i - 1] - velocity[i - 2];
    const result = {
        meanVelocity: mean(velocity, nv),
        varianceVelocity: variance(velocity, nv),
        meanAcceleration: mean(acceleration, na),
        varianceAcceleration: variance(acceleration, na),
        autocorrelation: autocorrelation(samples, n, maxLag)
    };
    releaseStatsScratch(s);
    return result;
}

/** IK trajectory statistics — path length, velocity, curvature. */
function ikStats(track, nSamples) {
    nSamples = nSamples === undefined ? track.length / 3 : nSamples;
    const nv = Math.max(0, nSamples - 1);
    const nc = Math.max(0, nSamples - 2);
    const s = acquireStatsScratch(Math.max(nv, nc, 1));
    const vel = s.a, curvature = s.b;
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
    for (let i = 0; i < nv; i++) pathLength += vel[i];
    const result = {
        pathLength: pathLength,
        meanVelocity: mean(vel, nv),
        varianceVelocity: variance(vel, nv),
        meanCurvature: mean(curvature, nc),
        varianceCurvature: variance(curvature, nc)
    };
    releaseStatsScratch(s);
    return result;
}

// ============================================================================
// Function Declarations — Internal linear solver (analysis-time)
// ============================================================================
function _solveLinearSystem(A, b, n) {
    // Gaussian elimination with partial pivoting on an augmented copy.
    const M = new Array(n);
    for (let i = 0; i < n; i++) {
        const row = new Float64Array(n + 1);
        for (let j = 0; j < n; j++) row[j] = A[i][j];
        row[n] = b[i];
        M[i] = row;
    }
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
function soaMean(data, count) { return mean(data, count); }
function soaVariance(data, count) { return variance(data, count); }
function soaStdDev(data, count) { return stdDev(data, count); }
function soaMin(data, count) { return min(data, count); }
function soaMax(data, count) { return max(data, count); }
function soaMedian(data, count) { return median(data, count); }
function soaQuantile(data, count, q) { return quantile(data, count, q); }
function soaSkewness(data, count) { return skewness(data, count); }
function soaKurtosis(data, count) { return kurtosis(data, count); }
function soaHistogram(data, count, bins) { return histogram(data, count, bins); }
function soaCovariance(a, b, count) { return covariance(a, b, count); }
function soaCorrelation(a, b, count) { return correlation(a, b, count); }
function soaMovingAverage(data, count, window, out) { return movingAverage(data, count, window, out); }
function soaAutocorrelation(data, count, maxLag, out) { return autocorrelation(data, count, maxLag, out); }

/** Batch normal PDF for importance-sampling weight verification. */
function soaNormalPDF(out, xs, mu, sigma, count) {
    count = count === undefined ? out.length : count;
    mu = mu || 0;
    sigma = sigma === undefined ? 1 : sigma;
    const invS = 1 / sigma;
    const c = INV_SQRT_2PI * invS;
    for (let i = 0; i < count; i++) {
        const z = (xs[i] - mu) * invS;
        out[i] = c * Math.exp(-0.5 * z * z);
    }
    return out;
}

/** Batch normal CDF. */
function soaNormalCDF(out, xs, mu, sigma, count) {
    count = count === undefined ? out.length : count;
    mu = mu || 0;
    sigma = sigma === undefined ? 1 : sigma;
    const inv = 1 / (sigma * SQRT_2);
    for (let i = 0; i < count; i++) out[i] = 0.5 * (1 + erf((xs[i] - mu) * inv));
    return out;
}

// ============================================================================
// Function Declarations — SOA (chunked async, inlined loops, zero closures)
// ============================================================================
async function soaMeanChunked(data, count, cs, ye) {
    count = count === undefined ? data.length : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let sum = 0, comp = 0, start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            const x = data[i];
            const t = sum + x;
            if (Math.abs(sum) >= Math.abs(x)) comp += (sum - t) + x;
            else comp += (x - t) + sum;
            sum = t;
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return count > 0 ? (sum + comp) / count : 0;
}

async function soaVarianceChunked(data, count, cs, ye) {
    count = count === undefined ? data.length : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const m = await soaMeanChunked(data, count, cs, ye);
    let acc = 0, start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            const d = data[i] - m;
            acc += d * d;
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return count > 1 ? acc / (count - 1) : 0;
}

async function soaSkewnessChunked(data, count, cs, ye) {
    count = count === undefined ? data.length : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    if (count < 3) return 0;
    const m = await soaMeanChunked(data, count, cs, ye);
    const sd = Math.sqrt(await soaVarianceChunked(data, count, cs, ye));
    if (sd === 0) return 0;
    let acc = 0, start = 0, c = 0;
    const invS = 1 / sd;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            const d = (data[i] - m) * invS;
            acc += d * d * d;
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return count / ((count - 1) * (count - 2)) * acc;
}

async function soaKurtosisChunked(data, count, cs, ye) {
    count = count === undefined ? data.length : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    if (count < 4) return 0;
    const m = await soaMeanChunked(data, count, cs, ye);
    const sd = Math.sqrt(await soaVarianceChunked(data, count, cs, ye));
    if (sd === 0) return 0;
    let acc = 0, start = 0, c = 0;
    const invS = 1 / sd;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            const d = (data[i] - m) * invS;
            acc += d * d * d * d;
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    const k = count * (count + 1) / ((count - 1) * (count - 2) * (count - 3)) * acc;
    const correction = 3 * (count - 1) * (count - 1) / ((count - 2) * (count - 3));
    return k - correction;
}

async function soaHistogramChunked(data, count, binCount, cs, ye) {
    count = count === undefined ? data.length : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const T = getArrayType();
    const edges = new T(binCount + 1);
    const counts = new T(binCount);
    // Pass 1: min / max
    let mn = Infinity, mx = -Infinity;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            if (data[i] < mn) mn = data[i];
            if (data[i] > mx) mx = data[i];
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    const width = (mx - mn) / binCount || 1;
    for (let i = 0; i <= binCount; i++) edges[i] = mn + i * width;
    counts.fill(0);
    // Pass 2: binning
    start = 0; c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            let b = ((data[i] - mn) / width) | 0;
            if (b >= binCount) b = binCount - 1;
            if (b < 0) b = 0;
            counts[b]++;
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return { edges: edges, counts: counts };
}

async function soaCovarianceChunked(a, b, count, cs, ye) {
    count = count === undefined ? a.length : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const ma = await soaMeanChunked(a, count, cs, ye);
    const mb = await soaMeanChunked(b, count, cs, ye);
    let acc = 0, start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) acc += (a[i] - ma) * (b[i] - mb);
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return count > 1 ? acc / (count - 1) : 0;
}

async function soaCorrelationChunked(a, b, count, cs, ye) {
    count = count === undefined ? a.length : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const ma = await soaMeanChunked(a, count, cs, ye);
    const mb = await soaMeanChunked(b, count, cs, ye);
    let sab = 0, sa2 = 0, sb2 = 0, start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            const da = a[i] - ma;
            const db = b[i] - mb;
            sab += da * db;
            sa2 += da * da;
            sb2 += db * db;
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    const denom = Math.sqrt(sa2 * sb2);
    return denom > 0 ? sab / denom : 0;
}

async function soaMedianChunked(data, count, cs, ye) {
    count = count === undefined ? data.length : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    if (count === 0) return 0;
    const buf = _sortFloat(count);
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) buf[i] = data[i];
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    buf.sort();
    if (count & 1) return buf[(count - 1) >> 1];
    return (buf[count / 2 - 1] + buf[count / 2]) * 0.5;
}

// ============================================================================
// Class Declarations — Scratch and batch state
// ============================================================================
/** Reusable precision-aware stats scratch. Fixed-capacity pool, swap-remove. */
class StatsScratch {
    static #pool = new Array(32);
    static #count = 0;
    static {
        for (let i = 0; i < 8; i++) StatsScratch.#pool[StatsScratch.#count++] = new StatsScratch(256);
    }
    static acquire(size) {
        for (let i = 0; i < StatsScratch.#count; i++) {
            if (StatsScratch.#pool[i].size >= (size || 0)) {
                const s = StatsScratch.#pool[i];
                StatsScratch.#count--;
                StatsScratch.#pool[i] = StatsScratch.#pool[StatsScratch.#count];
                StatsScratch.#pool[StatsScratch.#count] = null;
                return s;
            }
        }
        return new StatsScratch(size || 256);
    }
    static release(s) {
        if (!s) return;
        s.reset();
        if (StatsScratch.#count < 32) StatsScratch.#pool[StatsScratch.#count++] = s;
    }
    constructor(size) {
        this.size = size || 256;
        const T = getArrayType();
        this.a = new T(this.size);
        this.b = new T(this.size);
        this.c = new T(this.size);
    }
    ensure(n) { return _statsScratchEnsure(this, n); }
    reset() { this.a.fill(0); this.b.fill(0); this.c.fill(0); return this; }
}

/** Batch state for repeated statistical passes over 1M+ samples. */
class StatsBatchState {
    constructor(count) {
        this.count = count;
        const T = getArrayType();
        this.data = new T(count);
        this.aux = new T(count);
        this.out = new T(count);
        this.welford = createWelford();
    }
    mean()      { return mean(this.data, this.count); }
    variance()  { return variance(this.data, this.count); }
    stdDev()    { return stdDev(this.data, this.count); }
    median()    { return median(this.data, this.count); }
    histogram(bins) { return histogram(this.data, this.count, bins); }
    /** Reset and rebuild the streaming Welford state from `this.data`. */
    rebuildWelford() {
        this.welford = createWelford();
        for (let i = 0; i < this.count; i++) welfordUpdate(this.welford, this.data[i]);
        return this.welford;
    }
    async meanChunked(cs, ye)    { return soaMeanChunked(this.data, this.count, cs, ye); }
    async medianChunked(cs, ye)  { return soaMedianChunked(this.data, this.count, cs, ye); }
    async histogramChunked(bins, cs, ye) { return soaHistogramChunked(this.data, this.count, bins, cs, ye); }
}

function createStatsBatch(count) { return new StatsBatchState(count); }

// ============================================================================
// Namespace convenience (init-time object graph only)
// ============================================================================
const namespace = {
    descriptive: {
        mean, variance, stdDev, median, mode,
        quantile, percentile, iqr, min, max, range: rangeOf,
        mad, skewness, kurtosis,
        weightedMean, weightedVariance
    },
    correlation: {
        covariance, correlation,
        spearman: spearmanCorrelation,
        kendall: kendallCorrelation,
        autocorrelation, crossCorrelation
    },
    distributions: {
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
    },
    tests: {
        tTestOneSample, tTestTwoSample,
        chiSquare: chiSquareTest,
        fTest,
        ks: ksTest,
        mannWhitneyU,
        anova
    },
    regression: {
        linear: linearRegression,
        polynomial: polynomialRegression,
        weighted: weightedLinearRegression,
        ridge: ridgeRegression,
        multiple: multipleLinearRegression,
        logistic: logisticRegression,
        rSquared,
        adjustedRSquared
    },
    timeseries: {
        movingAverage,
        ema: exponentialMovingAverage,
        ewma,
        ar: arModel,
        seasonalDecompose
    },
    histogram: {
        histogram,
        into: histogramInto,
        kde: kernelDensityEstimate,
        gaussian: gaussianKernel,
        epanechnikov: epanechnikovKernel
    },
    sampling: {
        reservoir: reservoirSample
    },
    streaming: {
        createWelford, welfordUpdate, welfordMean, welfordVariance, welfordStdDev
    },
    domain: {
        scatter: scatterStats,
        color: colorStats,
        orbital: orbitalStats,
        animation: animationStats,
        ik: ikStats
    },
    batch: {
        mean: soaMean, meanChunked: soaMeanChunked,
        variance: soaVariance, varianceChunked: soaVarianceChunked,
        stdDev: soaStdDev,
        min: soaMin, max: soaMax,
        median: soaMedian, medianChunked: soaMedianChunked,
        quantile: soaQuantile,
        skewness: soaSkewness, skewnessChunked: soaSkewnessChunked,
        kurtosis: soaKurtosis, kurtosisChunked: soaKurtosisChunked,
        histogram: soaHistogram, histogramChunked: soaHistogramChunked,
        covariance: soaCovariance, covarianceChunked: soaCovarianceChunked,
        correlation: soaCorrelation, correlationChunked: soaCorrelationChunked,
        movingAverage: soaMovingAverage,
        autocorrelation: soaAutocorrelation,
        normalPDF: soaNormalPDF, normalCDF: soaNormalCDF,
        State: StatsBatchState,
        create: createStatsBatch
    }
};

// ============================================================================
// Precision listener — hoisted named handler (no closure allocation).
// Existing buffers are intentionally retained (Zero-GC); new batch states and
// scratch growth pick up the live array type via getArrayType().
// ============================================================================
function _handlePrecisionChange(mode, oldMode) { /* retention policy: no-op */ }
onPrecisionChange(_handlePrecisionChange);

// ============================================================================
// Export Declarations (ES Modules)
// ============================================================================
export {
    // Descriptive statistics
    mean, variance, stdDev, median, mode,
    quantile, percentile, iqr, min, max, rangeOf, rangeOf as range,
    mad, skewness, kurtosis,
    weightedMean, weightedVariance,
    // Covariance / correlation
    covariance, correlation, spearmanCorrelation, kendallCorrelation,
    autocorrelation, crossCorrelation,
    // Continuous distributions
    normalPDF, normalCDF, normalInverseCDF, normalSample,
    uniformPDF, uniformCDF, uniformSample,
    exponentialPDF, exponentialCDF, exponentialSample,
    logNormalPDF, logNormalSample,
    gammaPDF, gammaSample,
    betaPDF, betaSample,
    chiSquarePDF, chiSquareSample,
    studentTPDF, studentTSample,
    fPDF, fSample,
    // Discrete distributions
    poissonPMF, poissonSample,
    binomialPMF, binomialSample,
    bernoulliSample, dirichletSample,
    // Hypothesis tests
    tTestOneSample, tTestTwoSample, chiSquareTest, fTest,
    ksTest, mannWhitneyU, anova,
    // Regression
    linearRegression, polynomialRegression, weightedLinearRegression,
    ridgeRegression, multipleLinearRegression, logisticRegression,
    rSquared, adjustedRSquared,
    // Time series
    movingAverage, exponentialMovingAverage, ewma, arModel, seasonalDecompose,
    // Histogram / KDE
    histogram, histogramInto, kernelDensityEstimate,
    gaussianKernel, epanechnikovKernel,
    // Sampling
    reservoirSample,
    // Streaming moments
    createWelford, welfordUpdate, welfordMean, welfordVariance, welfordStdDev,
    // Domain helpers
    scatterStats, colorStats, orbitalStats, animationStats, ikStats,
    // SOA (sync)
    soaMean, soaVariance, soaStdDev, soaMin, soaMax,
    soaMedian, soaQuantile, soaSkewness, soaKurtosis,
    soaHistogram, soaCovariance, soaCorrelation,
    soaMovingAverage, soaAutocorrelation,
    soaNormalPDF, soaNormalCDF,
    // SOA (chunked async)
    soaMeanChunked, soaVarianceChunked,
    soaSkewnessChunked, soaKurtosisChunked,
    soaHistogramChunked, soaCovarianceChunked,
    soaCorrelationChunked, soaMedianChunked,
    // Pools
    StatsScratch, createStatsScratchPool, acquireStatsScratch, releaseStatsScratch,
    // Batch state
    StatsBatchState, createStatsBatch,
    // Namespaces
    namespace
};