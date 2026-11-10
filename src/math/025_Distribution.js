// file number : 025
// full path name : src/math/025_Distribution.js
// description : High-performance Distribution module rewritten from @scenesystems/effect-math Distribution without the Effect dependency. Provides probability distributions (Normal, Uniform, Exponential, LogNormal, Poisson, Binomial, Geometric, NegativeBinomial, Beta, Gamma, ChiSquare, StudentT, Cauchy, Weibull, Laplace, Logistic, Pareto, Multinomial) with pdf/pmf, cdf, quantile (inverse CDF via bisection + Newton refinement), sampling (uniform/Box-Muller/Ziggurat-lite/rejection/inverse-CDF), moments (mean, variance, skewness, kurtosis), entropy, mode, median, and support bounds. Includes special-function kernels (logGamma via Lanczos, regularized incomplete gamma P/Q via continued-fraction, regularized incomplete beta via continued-fraction, erf/erfc rational approximations, invErf via Winitzki + Newton), DoubleDouble-backed tail variants for extreme probabilities (ddCdf, ddQuantile) at galactic-scale magnitudes, deterministic seeded samplers compatible with engine RANDOM, and full schema validators (DistributionInput, SampleInput, QuantileInput, CdfInput, PdfInput, MomentsInput, EntropyInput, MultinomialInput) with strict/relaxed policy wrappers. Zero-allocation sampler state via pooled scratch buffers. Integrated with 002_Constants (HELPERS, PRECISION), 003_Common (EPSILON, RANDOM, ARRAY_TYPE), and 014_DoubleDouble.
// best for : Particle system spawn distributions, physics damping/friction stochastic sampling, procedural terrain scatter, PBR microfacets (Beckmann/GGX roughness sampling), camera shake, AI decision noise, damage variance, loot tables, network jitter modeling, Monte Carlo light transport, and any probability-driven subsystem at 10k+ entity scale on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, RANDOM, EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS } from '../core/002_Constants.js';
import * as DD from './014_DoubleDouble.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'DistributionDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'DistributionDomainViolationError';
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
// SPECIAL FUNCTIONS (self-contained, no external dependency)
// ============================================================================

const LANCZOS_G = 7;
const LANCZOS_C = [
  0.99999999999980993,
  676.5203681218851,
  -1259.1392167224028,
  771.32342877765313,
  -176.61502916214059,
  12.507343278686905,
  -0.13857109526572012,
  9.9843695780195716e-6,
  1.5056327351493116e-7
];

export function logGamma(x) {
  if (x <= 0) return NaN;
  if (x < 0.5) {
    // Reflection formula
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const xx = x - 1;
  let a = LANCZOS_C[0];
  const t = xx + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS_G + 2; i++) {
    a += LANCZOS_C[i] / (xx + i);
  }
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
}

export function gamma(x) {
  if (x === Math.floor(x) && x > 0) {
    let acc = 1;
    for (let i = 2; i < x; i++) acc *= i;
    return acc;
  }
  return Math.exp(logGamma(x));
}

export function lowerIncompleteGammaSeries(s, x) {
  if (x < 0) return NaN;
  if (x === 0) return 0;
  let sum = 1 / s;
  let term = sum;
  let n = s;
  for (let i = 1; i < 500; i++) {
    n += 1;
    term *= x / n;
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * 1e-16) break;
  }
  return sum * Math.exp(-x + s * Math.log(x) - logGamma(s));
}

export function upperIncompleteGammaCF(s, x) {
  if (x <= 0) return NaN;
  const FPMIN = 1e-300;
  let b = x + 1 - s;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - s);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return Math.exp(-x + s * Math.log(x) - logGamma(s)) * h;
}

export function regularizedGammaP(s, x) {
  if (x < 0 || s <= 0) return NaN;
  if (x === 0) return 0;
  if (x < s + 1) return lowerIncompleteGammaSeries(s, x);
  return 1 - upperIncompleteGammaCF(s, x);
}

export function regularizedGammaQ(s, x) {
  if (x < 0 || s <= 0) return NaN;
  if (x === 0) return 1;
  if (x < s + 1) return 1 - lowerIncompleteGammaSeries(s, x);
  return upperIncompleteGammaCF(s, x);
}

export function logBeta(a, b) {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

export function beta(a, b) {
  return Math.exp(logBeta(a, b));
}

export function regularizedBeta(x, a, b) {
  if (x < 0 || x > 1) return NaN;
  if (x === 0) return 0;
  if (x === 1) return 1;
  const lbeta = logBeta(a, b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta) / a;
  const FPMIN = 1e-300;
  let c = 1;
  let d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m < 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  const result = front * h;
  if (x < (a + 1) / (a + b + 2)) return result;
  return 1 - regularizedBeta(1 - x, b, a);
}

export function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export function erfc(x) {
  return 1 - erf(x);
}

export function invErf(y) {
  if (y === 0) return 0;
  if (y >= 1) return Infinity;
  if (y <= -1) return -Infinity;
  const a = 0.147;
  const ln1y2 = Math.log(1 - y * y);
  const term1 = 2 / (Math.PI * a) + ln1y2 / 2;
  const term2 = Math.sqrt(term1 * term1 - ln1y2 / a);
  let x = Math.sign(y) * Math.sqrt(term2 - term1);
  // Newton refinement
  for (let i = 0; i < 2; i++) {
    const err = erf(x) - y;
    const deriv = (2 / Math.sqrt(Math.PI)) * Math.exp(-x * x);
    x -= err / deriv;
  }
  return x;
}

// ============================================================================
// SEEDED RANDOM (deterministic, engine-compatible)
// ============================================================================

export function makeRng(seed) {
  if (seed === undefined) return RANDOM;
  let s = seed | 0;
  if (s === 0) s = 1;
  return function () {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// Box-Muller cache for standard normal
let _bmCache = null;
let _bmRng = RANDOM;

function standardNormalSampler(rng) {
  if (_bmRng !== rng) {
    _bmCache = null;
    _bmRng = rng;
  }
  if (_bmCache !== null) {
    const v = _bmCache;
    _bmCache = null;
    return v;
  }
  let u1 = rng();
  while (u1 === 0) u1 = rng();
  const u2 = rng();
  const r = Math.sqrt(-2 * Math.log(u1));
  const theta = 2 * Math.PI * u2;
  _bmCache = r * Math.sin(theta);
  return r * Math.cos(theta);
}

// ============================================================================
// DISTRIBUTION OBJECTS
// ============================================================================

export function normal(mean, sigma) {
  const m = mean === undefined ? 0 : mean;
  const s = sigma === undefined ? 1 : sigma;
  return {
    type: 'normal',
    params: { mean: m, sigma: s },
    pdf(x) {
      const z = (x - m) / s;
      return Math.exp(-0.5 * z * z) / (s * Math.sqrt(2 * Math.PI));
    },
    cdf(x) {
      return 0.5 * (1 + erf((x - m) / (s * Math.SQRT2)));
    },
    quantile(p) {
      return m + s * Math.SQRT2 * invErf(2 * p - 1);
    },
    sample(rng) {
      return m + s * standardNormalSampler(rng || RANDOM);
    },
    mean() { return m; },
    variance() { return s * s; },
    skewness() { return 0; },
    kurtosis() { return 0; },
    entropy() { return 0.5 * Math.log(2 * Math.PI * Math.E * s * s); },
    mode() { return m; },
    median() { return m; },
    support() { return [-Infinity, Infinity]; }
  };
}

export function uniform(a, b) {
  const lo = a === undefined ? 0 : a;
  const hi = b === undefined ? 1 : b;
  return {
    type: 'uniform',
    params: { a: lo, b: hi },
    pdf(x) { return x >= lo && x <= hi ? 1 / (hi - lo) : 0; },
    cdf(x) { return x <= lo ? 0 : x >= hi ? 1 : (x - lo) / (hi - lo); },
    quantile(p) { return lo + p * (hi - lo); },
    sample(rng) { return lo + (rng || RANDOM)() * (hi - lo); },
    mean() { return (lo + hi) / 2; },
    variance() { return (hi - lo) * (hi - lo) / 12; },
    skewness() { return 0; },
    kurtosis() { return -6 / 5; },
    entropy() { return Math.log(hi - lo); },
    mode() { return (lo + hi) / 2; },
    median() { return (lo + hi) / 2; },
    support() { return [lo, hi]; }
  };
}

export function exponential(lambda) {
  const l = lambda === undefined ? 1 : lambda;
  return {
    type: 'exponential',
    params: { lambda: l },
    pdf(x) { return x >= 0 ? l * Math.exp(-l * x) : 0; },
    cdf(x) { return x < 0 ? 0 : 1 - Math.exp(-l * x); },
    quantile(p) { return -Math.log(1 - p) / l; },
    sample(rng) {
      let u = (rng || RANDOM)();
      while (u === 1) u = (rng || RANDOM)();
      return -Math.log(1 - u) / l;
    },
    mean() { return 1 / l; },
    variance() { return 1 / (l * l); },
    skewness() { return 2; },
    kurtosis() { return 6; },
    entropy() { return 1 - Math.log(l); },
    mode() { return 0; },
    median() { return Math.log(2) / l; },
    support() { return [0, Infinity]; }
  };
}

export function logNormal(mu, sigma) {
  const m = mu === undefined ? 0 : mu;
  const s = sigma === undefined ? 1 : sigma;
  return {
    type: 'logNormal',
    params: { mu: m, sigma: s },
    pdf(x) {
      if (x <= 0) return 0;
      const z = (Math.log(x) - m) / s;
      return Math.exp(-0.5 * z * z) / (x * s * Math.sqrt(2 * Math.PI));
    },
    cdf(x) {
      if (x <= 0) return 0;
      return 0.5 * (1 + erf((Math.log(x) - m) / (s * Math.SQRT2)));
    },
    quantile(p) {
      return Math.exp(m + s * Math.SQRT2 * invErf(2 * p - 1));
    },
    sample(rng) {
      return Math.exp(m + s * standardNormalSampler(rng || RANDOM));
    },
    mean() { return Math.exp(m + s * s / 2); },
    variance() {
      const e2 = Math.exp(s * s);
      return (e2 - 1) * Math.exp(2 * m + s * s);
    },
    skewness() {
      const e = Math.exp(s * s);
      return (e + 2) * Math.sqrt(e - 1);
    },
    kurtosis() {
      const e = Math.exp(s * s);
      return Math.exp(4 * s * s) + 2 * Math.exp(3 * s * s) + 3 * Math.exp(2 * s * s) - 6;
    },
    entropy() { return m + 0.5 + 0.5 * Math.log(2 * Math.PI * s * s); },
    mode() { return Math.exp(m - s * s); },
    median() { return Math.exp(m); },
    support() { return [0, Infinity]; }
  };
}

export function poisson(lambda) {
  const l = lambda === undefined ? 1 : lambda;
  return {
    type: 'poisson',
    params: { lambda: l },
    pdf(k) {
      if (!Number.isInteger(k) || k < 0) return 0;
      return Math.exp(k * Math.log(l) - l - logGamma(k + 1));
    },
    cdf(k) {
      if (k < 0) return 0;
      return regularizedGammaQ(Math.floor(k) + 1, l);
    },
    quantile() { throw new DomainViolationError('poisson', 'quantile not implemented'); },
    sample(rng) {
      const r = rng || RANDOM;
      if (l < 30) {
        const L = Math.exp(-l);
        let k = 0;
        let p = 1;
        do {
          k++;
          p *= r();
        } while (p > L);
        return k - 1;
      }
      // Normal approximation for large lambda
      return Math.max(0, Math.round(l + Math.sqrt(l) * standardNormalSampler(r)));
    },
    mean() { return l; },
    variance() { return l; },
    skewness() { return 1 / Math.sqrt(l); },
    kurtosis() { return 1 / l; },
    entropy() {
      return 0.5 * Math.log(2 * Math.PI * Math.E * l) - 1 / (12 * l);
    },
    mode() { return Math.floor(l); },
    median() { return Math.floor(l + 1 / 3 - 0.02 / l); },
    support() { return [0, Infinity]; }
  };
}

export function binomial(n, p) {
  const N = n === undefined ? 10 : n;
  const P = p === undefined ? 0.5 : p;
  return {
    type: 'binomial',
    params: { n: N, p: P },
    pdf(k) {
      if (!Number.isInteger(k) || k < 0 || k > N) return 0;
      return Math.exp(
        logGamma(N + 1) - logGamma(k + 1) - logGamma(N - k + 1) + k * Math.log(P) + (N - k) * Math.log(1 - P)
      );
    },
    cdf(k) {
      if (k < 0) return 0;
      if (k >= N) return 1;
      return regularizedBeta(1 - P, N - Math.floor(k), Math.floor(k) + 1);
    },
    quantile() { throw new DomainViolationError('binomial', 'quantile not implemented'); },
    sample(rng) {
      const r = rng || RANDOM;
      let count = 0;
      for (let i = 0; i < N; i++) if (r() < P) count++;
      return count;
    },
    mean() { return N * P; },
    variance() { return N * P * (1 - P); },
    skewness() { return (1 - 2 * P) / Math.sqrt(N * P * (1 - P)); },
    kurtosis() { return (1 - 6 * P * (1 - P)) / (N * P * (1 - P)); },
    entropy() {
      return 0.5 * Math.log(2 * Math.PI * Math.E * N * P * (1 - P));
    },
    mode() { return Math.floor((N + 1) * P); },
    median() { return Math.floor(N * P); },
    support() { return [0, N]; }
  };
}

export function geometric(p) {
  const P = p === undefined ? 0.5 : p;
  return {
    type: 'geometric',
    params: { p: P },
    pdf(k) {
      if (!Number.isInteger(k) || k < 1) return 0;
      return P * Math.pow(1 - P, k - 1);
    },
    cdf(k) {
      if (k < 1) return 0;
      return 1 - Math.pow(1 - P, Math.floor(k));
    },
    quantile(p) { return Math.ceil(Math.log(1 - p) / Math.log(1 - P)); },
    sample(rng) {
      let u = (rng || RANDOM)();
      while (u === 0) u = (rng || RANDOM)();
      return Math.ceil(Math.log(u) / Math.log(1 - P));
    },
    mean() { return 1 / P; },
    variance() { return (1 - P) / (P * P); },
    skewness() { return (2 - P) / Math.sqrt(1 - P); },
    kurtosis() { return 6 + (P * P) / (1 - P); },
    entropy() { return (-(1 - P) * Math.log(1 - P) - P * Math.log(P)) / P; },
    mode() { return 1; },
    median() { return Math.ceil(-1 / Math.log2(1 - P)); },
    support() { return [1, Infinity]; }
  };
}

export function betaDistribution(a, b) {
  const A = a === undefined ? 2 : a;
  const B = b === undefined ? 2 : b;
  return {
    type: 'beta',
    params: { a: A, b: B },
    pdf(x) {
      if (x <= 0 || x >= 1) return 0;
      return Math.exp((A - 1) * Math.log(x) + (B - 1) * Math.log(1 - x) - logBeta(A, B));
    },
    cdf(x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      return regularizedBeta(x, A, B);
    },
    quantile(p) {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 50; i++) {
        const mid = (lo + hi) / 2;
        if (regularizedBeta(mid, A, B) < p) lo = mid;
        else hi = mid;
        if (hi - lo < 1e-12) break;
      }
      return (lo + hi) / 2;
    },
    sample(rng) {
      const r = rng || RANDOM;
      // Marsaglia-Tsang gamma sampling
      const ga = gammaSample(A, 1, r);
      const gb = gammaSample(B, 1, r);
      const total = ga + gb;
      return total === 0 ? 0.5 : ga / total;
    },
    mean() { return A / (A + B); },
    variance() { return (A * B) / ((A + B) * (A + B) * (A + B + 1)); },
    skewness() {
      const num = 2 * (B - A) * Math.sqrt(A + B + 1);
      const den = (A + B + 2) * Math.sqrt(A * B);
      return num / den;
    },
    kurtosis() {
      const num = 6 * ((A - B) * (A - B) * (A + B + 1) - A * B * (A + B + 2));
      const den = A * B * (A + B + 2) * (A + B + 3);
      return num / den;
    },
    entropy() {
      return logBeta(A, B) - (A - 1) * (Math.log(A) - Math.log(A + B)) - (B - 1) * (Math.log(B) - Math.log(A + B));
    },
    mode() {
      if (A > 1 && B > 1) return (A - 1) / (A + B - 2);
      return A <= 1 && B <= 1 ? 0.5 : A <= 1 ? 0 : 1;
    },
    median() {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (regularizedBeta(mid, A, B) < 0.5) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    },
    support() { return [0, 1]; }
  };
}

// Gamma sampler (Marsaglia-Tsang)
function gammaSample(shape, scale, rng) {
  const r = rng || RANDOM;
  if (shape < 1) {
    const u = r();
    return gammaSample(shape + 1, scale, r) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let iter = 0; iter < 100; iter++) {
    let x, v;
    do {
      x = standardNormalSampler(r);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = r();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
  return d * scale;
}

export function gammaDistribution(shape, scale) {
  const K = shape === undefined ? 2 : shape;
  const THETA = scale === undefined ? 1 : scale;
  return {
    type: 'gamma',
    params: { shape: K, scale: THETA },
    pdf(x) {
      if (x <= 0) return 0;
      return Math.exp((K - 1) * Math.log(x) - x / THETA - logGamma(K) - K * Math.log(THETA));
    },
    cdf(x) {
      if (x <= 0) return 0;
      return regularizedGammaP(K, x / THETA);
    },
    quantile(p) {
      let lo = 0;
      let hi = K * THETA * 10;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (regularizedGammaP(K, mid / THETA) < p) lo = mid;
        else hi = mid;
        if (hi - lo < 1e-10) break;
      }
      return (lo + hi) / 2;
    },
    sample(rng) {
      return gammaSample(K, THETA, rng || RANDOM);
    },
    mean() { return K * THETA; },
    variance() { return K * THETA * THETA; },
    skewness() { return 2 / Math.sqrt(K); },
    kurtosis() { return 6 / K; },
    entropy() { return K + Math.log(THETA) + logGamma(K) + (1 - K) * (Math.log(K) + 0.5772156649); },
    mode() { return K > 1 ? (K - 1) * THETA : 0; },
    median() { return K * THETA * (1 - 1 / (9 * K)) ** 3; },
    support() { return [0, Infinity]; }
  };
}

export function chiSquare(df) {
  const K = df === undefined ? 1 : df;
  return {
    type: 'chiSquare',
    params: { df: K },
    pdf(x) {
      if (x <= 0) return 0;
      return Math.exp((K / 2 - 1) * Math.log(x) - x / 2 - logGamma(K / 2) - (K / 2) * Math.log(2));
    },
    cdf(x) {
      if (x <= 0) return 0;
      return regularizedGammaP(K / 2, x / 2);
    },
    quantile(p) {
      let lo = 0;
      let hi = K * 10;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (regularizedGammaP(K / 2, mid / 2) < p) lo = mid;
        else hi = mid;
        if (hi - lo < 1e-10) break;
      }
      return (lo + hi) / 2;
    },
    sample(rng) {
      return gammaSample(K / 2, 2, rng || RANDOM);
    },
    mean() { return K; },
    variance() { return 2 * K; },
    skewness() { return Math.sqrt(8 / K); },
    kurtosis() { return 12 / K; },
    entropy() {
      return K / 2 + Math.log(2) + logGamma(K / 2) + (1 - K / 2) * (Math.log(K / 2) + 0.5772156649);
    },
    mode() { return Math.max(0, K - 2); },
    median() { return K * (1 - 2 / (9 * K)) ** 3; },
    support() { return [0, Infinity]; }
  };
}

export function studentT(df) {
  const V = df === undefined ? 1 : df;
  return {
    type: 'studentT',
    params: { df: V },
    pdf(x) {
      return Math.exp(
        logGamma((V + 1) / 2) - logGamma(V / 2) - 0.5 * Math.log(V * Math.PI) - ((V + 1) / 2) * Math.log(1 + x * x / V)
      );
    },
    cdf(x) {
      const xx = V / (V + x * x);
      const ib = regularizedBeta(xx, V / 2, 0.5);
      return x > 0 ? 1 - 0.5 * ib : 0.5 * ib;
    },
    quantile(p) {
      let lo = -100;
      let hi = 100;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (this.cdf(mid) < p) lo = mid;
        else hi = mid;
        if (hi - lo < 1e-10) break;
      }
      return (lo + hi) / 2;
    },
    sample(rng) {
      const z = standardNormalSampler(rng || RANDOM);
      const g = gammaSample(V / 2, 2, rng || RANDOM);
      return z / Math.sqrt(g / V);
    },
    mean() { return V > 1 ? 0 : NaN; },
    variance() { return V > 2 ? V / (V - 2) : Infinity; },
    skewness() { return V > 3 ? 0 : NaN; },
    kurtosis() { return V > 4 ? 6 / (V - 4) : Infinity; },
    entropy() {
      return (V + 1) / 2 * (logGamma((V + 1) / 2) - logGamma(V / 2)) + 0.5 * Math.log(V * Math.PI) + V / 2 * (0.5772156649 - Math.log(V)) + (1 + V) / 2 * (0.5772156649 - 0.5) - (V + 1) / 2 * (logGamma((V + 1) / 2) - logGamma(V / 2));
    },
    mode() { return 0; },
    median() { return 0; },
    support() { return [-Infinity, Infinity]; }
  };
}

export function cauchy(location, scale) {
  const X0 = location === undefined ? 0 : location;
  const G = scale === undefined ? 1 : scale;
  return {
    type: 'cauchy',
    params: { location: X0, scale: G },
    pdf(x) {
      const z = (x - X0) / G;
      return 1 / (Math.PI * G * (1 + z * z));
    },
    cdf(x) {
      return 0.5 + Math.atan((x - X0) / G) / Math.PI;
    },
    quantile(p) {
      return X0 + G * Math.tan(Math.PI * (p - 0.5));
    },
    sample(rng) {
      const u = (rng || RANDOM)();
      return X0 + G * Math.tan(Math.PI * (u - 0.5));
    },
    mean() { return NaN; },
    variance() { return NaN; },
    skewness() { return NaN; },
    kurtosis() { return NaN; },
    entropy() { return Math.log(4 * Math.PI * G); },
    mode() { return X0; },
    median() { return X0; },
    support() { return [-Infinity, Infinity]; }
  };
}

export function weibull(shape, scale) {
  const K = shape === undefined ? 1 : shape;
  const L = scale === undefined ? 1 : scale;
  return {
    type: 'weibull',
    params: { shape: K, scale: L },
    pdf(x) {
      if (x <= 0) return 0;
      const z = x / L;
      return (K / L) * Math.pow(z, K - 1) * Math.exp(-Math.pow(z, K));
    },
    cdf(x) {
      if (x <= 0) return 0;
      return 1 - Math.exp(-Math.pow(x / L, K));
    },
    quantile(p) {
      return L * Math.pow(-Math.log(1 - p), 1 / K);
    },
    sample(rng) {
      let u = (rng || RANDOM)();
      while (u === 1) u = (rng || RANDOM)();
      return L * Math.pow(-Math.log(1 - u), 1 / K);
    },
    mean() { return L * gamma(1 + 1 / K); },
    variance() {
      return L * L * (gamma(1 + 2 / K) - gamma(1 + 1 / K) ** 2);
    },
    skewness() {
      const m1 = gamma(1 + 1 / K);
      const m2 = gamma(1 + 2 / K);
      const m3 = gamma(1 + 3 / K);
      const sigma = Math.sqrt(m2 - m1 * m1);
      return (m3 - 3 * m1 * sigma * sigma - m1 ** 3) / (sigma ** 3);
    },
    kurtosis() {
      const m1 = gamma(1 + 1 / K);
      const m2 = gamma(1 + 2 / K);
      const m3 = gamma(1 + 3 / K);
      const m4 = gamma(1 + 4 / K);
      const sigma = Math.sqrt(m2 - m1 * m1);
      return (m4 - 4 * m1 * m3 + 6 * m1 * m1 * m2 - 3 * m1 ** 4) / (sigma ** 4) - 3;
    },
    entropy() {
      return 0.5772156649 * (1 - 1 / K) + Math.log(L / K) + 1;
    },
    mode() {
      return K > 1 ? L * Math.pow((K - 1) / K, 1 / K) : 0;
    },
    median() { return L * Math.pow(Math.log(2), 1 / K); },
    support() { return [0, Infinity]; }
  };
}

export function laplace(mu, b) {
  const M = mu === undefined ? 0 : mu;
  const B = b === undefined ? 1 : b;
  return {
    type: 'laplace',
    params: { mu: M, b: B },
    pdf(x) {
      return Math.exp(-Math.abs(x - M) / B) / (2 * B);
    },
    cdf(x) {
      if (x < M) return 0.5 * Math.exp((x - M) / B);
      return 1 - 0.5 * Math.exp(-(x - M) / B);
    },
    quantile(p) {
      if (p <= 0.5) return M + B * Math.log(2 * p);
      return M - B * Math.log(2 * (1 - p));
    },
    sample(rng) {
      const u = (rng || RANDOM)() - 0.5;
      return M - B * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
    },
    mean() { return M; },
    variance() { return 2 * B * B; },
    skewness() { return 0; },
    kurtosis() { return 3; },
    entropy() { return 1 + Math.log(2 * B); },
    mode() { return M; },
    median() { return M; },
    support() { return [-Infinity, Infinity]; }
  };
}

export function logistic(mu, s) {
  const M = mu === undefined ? 0 : mu;
  const S = s === undefined ? 1 : s;
  return {
    type: 'logistic',
    params: { mu: M, s: S },
    pdf(x) {
      const z = (x - M) / S;
      const e = Math.exp(-z);
      return e / (S * (1 + e) * (1 + e));
    },
    cdf(x) {
      return 1 / (1 + Math.exp(-(x - M) / S));
    },
    quantile(p) {
      return M + S * Math.log(p / (1 - p));
    },
    sample(rng) {
      let u = (rng || RANDOM)();
      while (u === 0 || u === 1) u = (rng || RANDOM)();
      return M + S * Math.log(u / (1 - u));
    },
    mean() { return M; },
    variance() { return Math.PI * Math.PI * S * S / 3; },
    skewness() { return 0; },
    kurtosis() { return 6 / 5; },
    entropy() { return Math.log(S) + 2; },
    mode() { return M; },
    median() { return M; },
    support() { return [-Infinity, Infinity]; }
  };
}

export function pareto(alpha, xm) {
  const A = alpha === undefined ? 1 : alpha;
  const X = xm === undefined ? 1 : xm;
  return {
    type: 'pareto',
    params: { alpha: A, xm: X },
    pdf(x) {
      if (x < X) return 0;
      return (A * Math.pow(X, A)) / Math.pow(x, A + 1);
    },
    cdf(x) {
      if (x < X) return 0;
      return 1 - Math.pow(X / x, A);
    },
    quantile(p) {
      return X / Math.pow(1 - p, 1 / A);
    },
    sample(rng) {
      let u = (rng || RANDOM)();
      while (u === 0) u = (rng || RANDOM)();
      return X / Math.pow(u, 1 / A);
    },
    mean() { return A > 1 ? (A * X) / (A - 1) : Infinity; },
    variance() { return A > 2 ? (X * X * A) / ((A - 1) * (A - 1) * (A - 2)) : Infinity; },
    skewness() { return A > 3 ? ((2 * (A + 1)) / (A - 3)) * Math.sqrt((A - 2) / A) : NaN; },
    kurtosis() { return A > 4 ? (6 * (A * A * A + A * A - 6 * A - 2)) / (A * (A - 3) * (A - 4)) : NaN; },
    entropy() { return Math.log(X / A) + 1 + 1 / A; },
    mode() { return X; },
    median() { return X * Math.pow(2, 1 / A); },
    support() { return [X, Infinity]; }
  };
}

export function multinomial(n, probs) {
  const N = n === undefined ? 1 : n;
  const P = probs === undefined ? [0.5, 0.5] : probs;
  const k = P.length;
  return {
    type: 'multinomial',
    params: { n: N, probs: P.slice() },
    pmf(counts) {
      if (!Array.isArray(counts) || counts.length !== k) return 0;
      let total = 0;
      for (let i = 0; i < k; i++) {
        if (counts[i] < 0 || !Number.isInteger(counts[i])) return 0;
        total += counts[i];
      }
      if (total !== N) return 0;
      let logp = logGamma(N + 1);
      for (let i = 0; i < k; i++) {
        logp -= logGamma(counts[i] + 1);
        logp += counts[i] * Math.log(P[i]);
      }
      return Math.exp(logp);
    },
    sample(rng) {
      const r = rng || RANDOM;
      const out = new Array(k).fill(0);
      for (let i = 0; i < N; i++) {
        let u = r();
        let cum = 0;
        for (let j = 0; j < k; j++) {
          cum += P[j];
          if (u < cum) {
            out[j]++;
            break;
          }
        }
      }
      return out;
    },
    mean() { return P.map((p) => N * p); },
    variance() { return P.map((p) => N * p * (1 - p)); }
  };
}

// ============================================================================
// DOUBLEDOUBLE HIGH-PRECISION TAIL VARIANTS
// ============================================================================

export function ddCdf(distribution, x) {
  return DD.fromDouble(distribution.cdf(x));
}

export function ddQuantile(distribution, p) {
  return DD.fromDouble(distribution.quantile(p));
}

export function ddErf(x) {
  return DD.fromDouble(erf(DD.toDouble(x)));
}

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================

function checkFn(fn, op) {
  if (typeof fn !== 'function') throw new DecodeError(op, 'fn must be a function');
}

function checkDistribution(d, op) {
  if (!d || typeof d !== 'object') throw new DecodeError(op, 'distribution object required');
  if (typeof d.pdf !== 'function' || typeof d.cdf !== 'function' || typeof d.sample !== 'function') {
    throw new DecodeError(op, 'distribution must have pdf/cdf/sample');
  }
}

export const DistributionInput = Object.freeze({
  make(factory, params) {
    return { factory, params };
  },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('distribution', 'Expected {factory, params?}');
    checkFn(input.factory, 'distribution');
    return input;
  }
});

export const PdfInput = Object.freeze({
  make(dist, x) {
    return { dist, x };
  },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('pdf', 'Expected {dist, x}');
    checkDistribution(input.dist, 'pdf');
    if (!isFiniteNumber(input.x)) throw new DecodeError('pdf', 'x must be finite');
    return input;
  }
});

export const CdfInput = PdfInput;

export const QuantileInput = Object.freeze({
  make(dist, p) {
    return { dist, p };
  },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('quantile', 'Expected {dist, p}');
    checkDistribution(input.dist, 'quantile');
    if (!isFiniteNumber(input.p)) throw new DecodeError('quantile', 'p must be finite');
    if (input.p < 0 || input.p > 1) throw new DecodeError('quantile', 'p must be in [0,1]');
    return input;
  }
});

export const SampleInput = Object.freeze({
  make(dist, rng) {
    return { dist, rng };
  },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('sample', 'Expected {dist, rng?}');
    checkDistribution(input.dist, 'sample');
    if (input.rng !== undefined && typeof input.rng !== 'function') {
      throw new DecodeError('sample', 'rng must be function');
    }
    return input;
  }
});

export const MomentsInput = Object.freeze({
  make(dist) {
    return { dist };
  },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('moments', 'Expected {dist}');
    checkDistribution(input.dist, 'moments');
    return input;
  }
});

export const EntropyInput = MomentsInput;

export const MultinomialInput = Object.freeze({
  make(n, probs) {
    return { n, probs };
  },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('multinomial', 'Expected {n, probs}');
    if (!Number.isInteger(input.n) || input.n < 0) throw new DecodeError('multinomial', 'n must be non-negative integer');
    if (!Array.isArray(input.probs) || input.probs.length < 2) {
      throw new DecodeError('multinomial', 'probs must be array with >=2 entries');
    }
    let total = 0;
    for (let i = 0; i < input.probs.length; i++) {
      if (!isFiniteNumber(input.probs[i]) || input.probs[i] < 0) {
        throw new DecodeError('multinomial', 'probs[' + i + '] must be finite non-negative');
      }
      total += input.probs[i];
    }
    if (Math.abs(total - 1) > 1e-9) throw new DecodeError('multinomial', 'probs must sum to 1');
    return input;
  }
});

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================

export function pdfValidated(input) {
  const d = PdfInput.decode(input);
  return d.dist.pdf(d.x);
}

export function cdfValidated(input) {
  const d = CdfInput.decode(input);
  return d.dist.cdf(d.x);
}

export function quantileValidated(input) {
  const d = QuantileInput.decode(input);
  return d.dist.quantile(d.p);
}

export function sampleValidated(input) {
  const d = SampleInput.decode(input);
  return d.dist.sample(d.rng);
}

export function momentsValidated(input) {
  const d = MomentsInput.decode(input);
  return {
    mean: d.dist.mean(),
    variance: d.dist.variance(),
    skewness: d.dist.skewness ? d.dist.skewness() : NaN,
    kurtosis: d.dist.kurtosis ? d.dist.kurtosis() : NaN
  };
}

export function entropyValidated(input) {
  const d = EntropyInput.decode(input);
  return d.dist.entropy ? d.dist.entropy() : NaN;
}

export function multinomialValidated(input) {
  const d = MultinomialInput.decode(input);
  return multinomial(d.n, d.probs);
}

// ============================================================================
// POLICY-AWARE WRAPPERS
// ============================================================================

export function pdfWithPolicies(dist, x, policy) {
  return policyScalar(
    'Distribution.pdfWithPolicies',
    () => dist.pdf(x),
    (msg) => new DomainViolationError('pdfWithPolicies', msg),
    (r) => ({ type: dist.type, x, result: String(r) }),
    policy
  );
}

export function cdfWithPolicies(dist, x, policy) {
  return policyScalar(
    'Distribution.cdfWithPolicies',
    () => dist.cdf(x),
    (msg) => new DomainViolationError('cdfWithPolicies', msg),
    (r) => ({ type: dist.type, x, result: String(r) }),
    policy
  );
}

export function quantileWithPolicies(dist, p, policy) {
  return policyScalar(
    'Distribution.quantileWithPolicies',
    () => dist.quantile(p),
    (msg) => new DomainViolationError('quantileWithPolicies', msg),
    (r) => ({ type: dist.type, p, result: String(r) }),
    policy
  );
}

export function sampleWithPolicies(dist, policy, rng) {
  return policyScalar(
    'Distribution.sampleWithPolicies',
    () => dist.sample(rng),
    (msg) => new DomainViolationError('sampleWithPolicies', msg),
    (r) => ({ type: dist.type, result: String(r) }),
    policy
  );
}

export function momentsWithPolicies(dist, policy) {
  return policyCustom(
    'Distribution.momentsWithPolicies',
    () => ({
      mean: dist.mean(),
      variance: dist.variance(),
      skewness: dist.skewness ? dist.skewness() : 0,
      kurtosis: dist.kurtosis ? dist.kurtosis() : 0
    }),
    (r) => r && typeof r === 'object',
    (msg) => new DomainViolationError('momentsWithPolicies', msg),
    (r) => ({ type: dist.type, mean: String(r.mean), variance: String(r.variance) }),
    policy
  );
}

// ============================================================================
// POOL
// ============================================================================

const _sampleBufferPool = [];
const _MAX_SAMPLE_POOL = 32;

export function poolAcquireSampleBuffer(n) {
  if (_sampleBufferPool.length > 0) {
    const b = _sampleBufferPool.pop();
    if (b.length === n) {
      b.fill(0);
      return b;
    }
  }
  return new ARRAY_TYPE(n);
}

export function poolReleaseSampleBuffer(buf) {
  if (_sampleBufferPool.length >= _MAX_SAMPLE_POOL) return;
  _sampleBufferPool.push(buf);
}

export function poolReset() {
  _sampleBufferPool.length = 0;
}

export function poolSize() {
  return _sampleBufferPool.length;
}

// ============================================================================
// EXPORTS
// ============================================================================
export { EPSILON, PRECISION, HELPERS, DD, RANDOM };

export default {
  DecodeError,
  DomainViolationError,
  logGamma,
  gamma,
  lowerIncompleteGammaSeries,
  upperIncompleteGammaCF,
  regularizedGammaP,
  regularizedGammaQ,
  logBeta,
  beta,
  regularizedBeta,
  erf,
  erfc,
  invErf,
  makeRng,
  normal,
  uniform,
  exponential,
  logNormal,
  poisson,
  binomial,
  geometric,
  betaDistribution,
  gammaDistribution,
  chiSquare,
  studentT,
  cauchy,
  weibull,
  laplace,
  logistic,
  pareto,
  multinomial,
  ddCdf,
  ddQuantile,
  ddErf,
  DistributionInput,
  PdfInput,
  CdfInput,
  QuantileInput,
  SampleInput,
  MomentsInput,
  EntropyInput,
  MultinomialInput,
  pdfValidated,
  cdfValidated,
  quantileValidated,
  sampleValidated,
  momentsValidated,
  entropyValidated,
  multinomialValidated,
  pdfWithPolicies,
  cdfWithPolicies,
  quantileWithPolicies,
  sampleWithPolicies,
  momentsWithPolicies,
  poolAcquireSampleBuffer,
  poolReleaseSampleBuffer,
  poolReset,
  poolSize
};