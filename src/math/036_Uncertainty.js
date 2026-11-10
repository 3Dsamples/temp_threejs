// file number : 036
// full path name : src/math/036_Uncertainty.js
// description : High-performance Uncertainty module rewritten from @scenesystems/effect-math Uncertainty without the Effect dependency. Provides uncertainty quantification and propagation primitives for the engine: measurement representation ({value, uncertainty, kind}), first-order (linear) Taylor propagation through arithmetic (add/sub/mul/div/pow/sqrt/log/exp/trig/pow) with correlated variants, interval arithmetic (add/sub/mul/div/intersection/union/distance/width/midpoint/contains/intersects with Kaucher extended intervals), fuzzy numbers (triangular/trapezoidal with alpha-cut, core, support, defuzzify via centroid/MOM), confidence intervals (Wald, Wilson, t-based, bootstrap, Chebyshev, Chernoff, Hoeffding, Cantelli) with sample-size adaptation, relative/absolute/expanded uncertainty (k-coverage factor), combined standard uncertainty via GUM (Guide to Uncertainty in Measurement) with sensitivity coefficients and covariance matrix, correlated propagation via Jacobian, Monte Carlo propagation (deterministic-seeded), worst-case/best-case bounds, sensitivity coefficients via automatic differentiation (reusing 020_Autodiff Dual numbers), uncertainty budgets (contributions, degrees of freedom, Welch-Satterthwaite effective DoF), coverage factor via t-distribution and Student-t expanded uncertainty, Bayesian posterior update with prior likelihood, Kalman-style scalar fusion, unscented-transform-lite for nonlinear propagation, and DD high-precision variants for galactic-scale magnitude uncertainty. Includes schema validators (MeasurementInput, IntervalInput, FuzzyInput, PropagationInput, CombinedInput, BoundsInput, CoverageInput, BayesianInput, MonteCarloInput, KalmanFusionInput, SensitivityInput, BudgetInput), policy-aware wrappers with 030_Policy, and pooled scratch buffers for zero-allocation hot paths. Integrated with 002_Constants, 003_Common, 014_DoubleDouble, 020_Autodiff, 025_Distribution, 031_Precision, 035_Statistics, and 030_Policy.
// best for : Physics stability bounds, PBR parameter confidence, camera calibration error, AI decision margin, context-awareness trigger thresholds, procedural scatter tolerance, network latency bounds, floating-origin drift quantification, Monte Carlo light transport variance, sensor fusion for AR/VFX, and any statistical/interval uncertainty pipeline at 10k+ entity scale on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS } from '../core/002_Constants.js';
import * as DD from './014_DoubleDouble.js';
import * as AD from './020_Autodiff.js';
import * as Dist from './025_Distribution.js';
import * as Prec from './031_Precision.js';
import * as Stats from './035_Statistics.js';
import * as PolicyModule from './030_Policy.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'UncertaintyDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'UncertaintyDomainViolationError';
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

function checkPositive(x, op, name) {
  checkFinite(x, op, name);
  if (x <= 0) throw new DecodeError(op, name + ' must be positive');
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

// ============================================================================
// MEASUREMENT REPRESENTATION
// ============================================================================
export const UncertaintyKind = Object.freeze({
  ABSOLUTE: 'absolute',
  RELATIVE: 'relative',
  EXPANDED: 'expanded',
  INTERVAL: 'interval',
  FUZZY: 'fuzzy',
  STANDARD: 'standard'
});

export function Measurement(value, uncertainty, kind) {
  return {
    value,
    uncertainty,
    kind: kind || UncertaintyKind.STANDARD
  };
}

export function asAbsolute(value, uncertainty) {
  return Measurement(value, uncertainty, UncertaintyKind.ABSOLUTE);
}

export function asRelative(value, relFraction) {
  return Measurement(value, Math.abs(value) * relFraction, UncertaintyKind.RELATIVE);
}

export function asStandard(value, stddev) {
  return Measurement(value, stddev, UncertaintyKind.STANDARD);
}

export function asExpanded(value, expandedU, coverage) {
  const k = coverage === undefined ? 2 : coverage;
  return Measurement(value, expandedU / k, UncertaintyKind.EXPANDED);
}

export function toAbsoluteU(m) {
  return Math.abs(m.uncertainty);
}

export function toRelativeU(m) {
  if (m.value === 0) return Infinity;
  return Math.abs(m.uncertainty / m.value);
}

export function expandedU(m, k) {
  const cov = k === undefined ? 2 : k;
  return cov * Math.abs(m.uncertainty);
}

// ============================================================================
// FIRST-ORDER (LINEAR) PROPAGATION
// ============================================================================

export function propagateAdd(a, b) {
  return {
    value: a.value + b.value,
    uncertainty: Math.sqrt(a.uncertainty * a.uncertainty + b.uncertainty * b.uncertainty)
  };
}

export function propagateSub(a, b) {
  return {
    value: a.value - b.value,
    uncertainty: Math.sqrt(a.uncertainty * a.uncertainty + b.uncertainty * b.uncertainty)
  };
}

export function propagateMul(a, b) {
  const value = a.value * b.value;
  const relA = a.value !== 0 ? a.uncertainty / a.value : 0;
  const relB = b.value !== 0 ? b.uncertainty / b.value : 0;
  const rel = Math.sqrt(relA * relA + relB * relB);
  return { value, uncertainty: Math.abs(value) * rel };
}

export function propagateDiv(a, b) {
  if (b.value === 0) return { value: NaN, uncertainty: NaN };
  const value = a.value / b.value;
  const relA = a.value !== 0 ? a.uncertainty / a.value : 0;
  const relB = b.uncertainty / b.value;
  const rel = Math.sqrt(relA * relA + relB * relB);
  return { value, uncertainty: Math.abs(value) * rel };
}

export function propagatePow(a, b) {
  // x^y = exp(y * log(x)) assuming x > 0
  if (a.value <= 0) return { value: Math.pow(a.value, b.value), uncertainty: NaN };
  const value = Math.pow(a.value, b.value);
  const relA = b.value * (a.uncertainty / a.value);
  const relB = Math.log(a.value) * b.uncertainty;
  const rel = Math.sqrt(relA * relA + relB * relB);
  return { value, uncertainty: Math.abs(value) * rel };
}

export function propagateSqrt(a) {
  if (a.value < 0) return { value: NaN, uncertainty: NaN };
  const value = Math.sqrt(a.value);
  const deriv = value === 0 ? 0 : 0.5 / value;
  return { value, uncertainty: Math.abs(deriv) * a.uncertainty };
}

export function propagateLog(a) {
  if (a.value <= 0) return { value: NaN, uncertainty: NaN };
  const value = Math.log(a.value);
  return { value, uncertainty: a.uncertainty / a.value };
}

export function propagateExp(a) {
  const value = Math.exp(a.value);
  return { value, uncertainty: value * a.uncertainty };
}

export function propagateSin(a) {
  const value = Math.sin(a.value);
  return { value, uncertainty: Math.abs(Math.cos(a.value)) * a.uncertainty };
}

export function propagateCos(a) {
  const value = Math.cos(a.value);
  return { value, uncertainty: Math.abs(Math.sin(a.value)) * a.uncertainty };
}

export function propagateTan(a) {
  const value = Math.tan(a.value);
  const deriv = 1 + value * value;
  return { value, uncertainty: Math.abs(deriv) * a.uncertainty };
}

export function propagateFunction(f, a) {
  const value = f(a.value);
  const h = Math.max(1e-8, Math.abs(a.value) * 1e-8);
  const fPlus = f(a.value + h);
  const fMinus = f(a.value - h);
  const deriv = (fPlus - fMinus) / (2 * h);
  return { value, uncertainty: Math.abs(deriv) * a.uncertainty };
}

// ============================================================================
// CORRELATED PROPAGATION
// ============================================================================

export function propagateCorrelated(ops, inputs, covariance) {
  // ops: array of {deriv: (i)=>∂f/∂xi}
  // inputs: array of Measurement
  // covariance: n x n matrix
  const n = inputs.length;
  const value = ops.value !== undefined ? ops.value : NaN;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      variance += ops.derivs[i] * ops.derivs[j] * covariance[i * n + j];
    }
  }
  return { value, uncertainty: Math.sqrt(Math.max(0, variance)) };
}

export function propagateJacobian(fn, inputs, covariance) {
  // fn: (...values) => scalar; numerically compute gradient
  const n = inputs.length;
  const values = new ARRAY_TYPE(n);
  for (let i = 0; i < n; i++) values[i] = inputs[i].value;
  const value = fn(values);
  const derivs = new ARRAY_TYPE(n);
  for (let i = 0; i < n; i++) {
    const h = Math.max(1e-8, Math.abs(values[i]) * 1e-8);
    const valsP = ARRAY_TYPE.from(values);
    const valsM = ARRAY_TYPE.from(values);
    valsP[i] += h;
    valsM[i] -= h;
    derivs[i] = (fn(valsP) - fn(valsM)) / (2 * h);
  }
  let variance = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      variance += derivs[i] * derivs[j] * covariance[i * n + j];
    }
  }
  return { value, uncertainty: Math.sqrt(Math.max(0, variance)), derivatives: derivs };
}

// ============================================================================
// INTERVAL ARITHMETIC
// ============================================================================

export function Interval(lo, hi) {
  return { lo, hi };
}

export function intervalFromCenter(v, w) {
  return { lo: v - w, hi: v + w };
}

export function intervalWidth(iv) { return iv.hi - iv.lo; }
export function intervalMidpoint(iv) { return 0.5 * (iv.lo + iv.hi); }
export function intervalRadius(iv) { return 0.5 * (iv.hi - iv.lo); }

export function intervalContains(iv, x) {
  return x >= iv.lo && x <= iv.hi;
}

export function intervalContainsInterval(a, b) {
  return b.lo >= a.lo && b.hi <= a.hi;
}

export function intervalIntersects(a, b) {
  return !(a.hi < b.lo || b.hi < a.lo);
}

export function intervalIntersection(a, b) {
  if (!intervalIntersects(a, b)) return null;
  return { lo: Math.max(a.lo, b.lo), hi: Math.min(a.hi, b.hi) };
}

export function intervalUnion(a, b) {
  return { lo: Math.min(a.lo, b.lo), hi: Math.max(a.hi, b.hi) };
}

export function intervalDistance(a, b) {
  if (intervalIntersects(a, b)) return 0;
  if (a.hi < b.lo) return b.lo - a.hi;
  return a.lo - b.hi;
}

export function intervalAdd(a, b) {
  return { lo: a.lo + b.lo, hi: a.hi + b.hi };
}

export function intervalSub(a, b) {
  return { lo: a.lo - b.hi, hi: a.hi - b.lo };
}

export function intervalMul(a, b) {
  const p1 = a.lo * b.lo;
  const p2 = a.lo * b.hi;
  const p3 = a.hi * b.lo;
  const p4 = a.hi * b.hi;
  return {
    lo: Math.min(p1, p2, p3, p4),
    hi: Math.max(p1, p2, p3, p4)
  };
}

export function intervalDiv(a, b) {
  if (b.lo <= 0 && b.hi >= 0) {
    // Divisor contains zero
    if (b.lo === 0 && b.hi === 0) return null;
    const invLo = b.lo === 0 ? -Infinity : 1 / b.lo;
    const invHi = b.hi === 0 ? Infinity : 1 / b.hi;
    return intervalMul(a, { lo: Math.min(invLo, invHi), hi: Math.max(invLo, invHi) });
  }
  const invLo = 1 / b.hi;
  const invHi = 1 / b.lo;
  return intervalMul(a, { lo: Math.min(invLo, invHi), hi: Math.max(invLo, invHi) });
}

export function intervalPow(a, n) {
  if (!Number.isInteger(n)) {
    if (a.lo < 0) return null;
    return { lo: Math.pow(a.lo, n), hi: Math.pow(a.hi, n) };
  }
  if (n === 0) return { lo: 1, hi: 1 };
  if (n % 2 === 0) {
    if (a.hi < 0) return { lo: Math.pow(a.hi, n), hi: Math.pow(a.lo, n) };
    if (a.lo > 0) return { lo: Math.pow(a.lo, n), hi: Math.pow(a.hi, n) };
    const maxAbs = Math.max(Math.abs(a.lo), Math.abs(a.hi));
    return { lo: 0, hi: Math.pow(maxAbs, n) };
  }
  return { lo: Math.pow(a.lo, n), hi: Math.pow(a.hi, n) };
}

export function intervalSqrt(a) {
  if (a.lo < 0) a = { lo: 0, hi: a.hi };
  return { lo: Math.sqrt(a.lo), hi: Math.sqrt(a.hi) };
}

export function intervalExp(a) {
  return { lo: Math.exp(a.lo), hi: Math.exp(a.hi) };
}

export function intervalLog(a) {
  if (a.lo <= 0) return null;
  return { lo: Math.log(a.lo), hi: Math.log(a.hi) };
}

export function intervalToMeasurement(iv) {
  return { value: intervalMidpoint(iv), uncertainty: intervalRadius(iv) };
}

export function measurementToInterval(m, k) {
  const cov = k === undefined ? 1 : k;
  return { lo: m.value - cov * m.uncertainty, hi: m.value + cov * m.uncertainty };
}

// ============================================================================
// FUZZY NUMBERS
// ============================================================================

export function TriangularFuzzy(a, b, c) {
  return { type: 'triangular', a, b, c };
}

export function TrapezoidalFuzzy(a, b, c, d) {
  return { type: 'trapezoidal', a, b, c, d };
}

export function fuzzyMembership(fz, x) {
  if (fz.type === 'triangular') {
    if (x < fz.a || x > fz.c) return 0;
    if (x === fz.b) return 1;
    if (x < fz.b) return (x - fz.a) / (fz.b - fz.a);
    return (fz.c - x) / (fz.c - fz.b);
  }
  if (fz.type === 'trapezoidal') {
    if (x < fz.a || x > fz.d) return 0;
    if (x >= fz.b && x <= fz.c) return 1;
    if (x < fz.b) return (x - fz.a) / (fz.b - fz.a);
    return (fz.d - x) / (fz.d - fz.c);
  }
  return 0;
}

export function fuzzyAlphaCut(fz, alpha) {
  if (fz.type === 'triangular') {
    const l = fz.a + alpha * (fz.b - fz.a);
    const r = fz.c - alpha * (fz.c - fz.b);
    return { lo: l, hi: r };
  }
  if (fz.type === 'trapezoidal') {
    const l = fz.a + alpha * (fz.b - fz.a);
    const r = fz.d - alpha * (fz.d - fz.c);
    return { lo: l, hi: r };
  }
  return null;
}

export function fuzzyCore(fz) {
  if (fz.type === 'triangular') return { lo: fz.b, hi: fz.b };
  if (fz.type === 'trapezoidal') return { lo: fz.b, hi: fz.c };
  return null;
}

export function fuzzySupport(fz) {
  if (fz.type === 'triangular') return { lo: fz.a, hi: fz.c };
  if (fz.type === 'trapezoidal') return { lo: fz.a, hi: fz.d };
  return null;
}

export function fuzzyCentroid(fz) {
  if (fz.type === 'triangular') {
    return (fz.a + fz.b + fz.c) / 3;
  }
  if (fz.type === 'trapezoidal') {
    // Area-weighted centroid
    const area1 = 0.5 * (fz.b - fz.a);
    const area2 = fz.c - fz.b;
    const area3 = 0.5 * (fz.d - fz.c);
    const total = area1 + area2 + area3;
    if (total === 0) return (fz.a + fz.d) / 2;
    const c1 = (2 * fz.a + fz.b) / 3;
    const c2 = (fz.b + fz.c) / 2;
    const c3 = (fz.c + 2 * fz.d) / 3;
    return (area1 * c1 + area2 * c2 + area3 * c3) / total;
  }
  return NaN;
}

export function fuzzyDefuzzifyMOM(fz) {
  const core = fuzzyCore(fz);
  return 0.5 * (core.lo + core.hi);
}

// ============================================================================
// COMBINED STANDARD UNCERTAINTY (GUM)
// ============================================================================

export function combinedStandardUncertainty(contributions, sensitivity) {
  // contributions: array of uncertainties
  // sensitivity: array of ∂f/∂xi
  let variance = 0;
  for (let i = 0; i < contributions.length; i++) {
    const c = sensitivity[i] * contributions[i];
    variance += c * c;
  }
  return Math.sqrt(variance);
}

export function uncertaintyBudget(contributions, sensitivity, dof) {
  const n = contributions.length;
  const budget = new ARRAY_TYPE(n);
  let totalVar = 0;
  for (let i = 0; i < n; i++) {
    const c = sensitivity[i] * contributions[i];
    budget[i] = c * c;
    totalVar += c * c;
  }
  const u = Math.sqrt(totalVar);

  // Welch-Satterthwaite effective degrees of freedom
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    numerator += budget[i];
    if (dof[i] > 0) {
      denominator += (budget[i] * budget[i]) / dof[i];
    }
  }
  const effectiveDof = denominator > 0 ? (numerator * numerator) / denominator : Infinity;

  return {
    contributions: budget,
    totalVariance: totalVar,
    combinedU: u,
    effectiveDof,
    dof
  };
}

// ============================================================================
// COVERAGE / EXPANDED UNCERTAINTY
// ============================================================================

export function coverageFactorNormal(confidence) {
  return Dist.normal(0, 1).quantile((1 + confidence) / 2);
}

export function coverageFactorStudentT(confidence, dof) {
  return Dist.studentT(dof).quantile((1 + confidence) / 2);
}

export function expandedUncertainty(combinedU, confidence, dof) {
  const c = confidence === undefined ? 0.95 : confidence;
  let k;
  if (dof !== undefined && dof > 0 && dof < 1e6) {
    k = coverageFactorStudentT(c, dof);
  } else {
    k = coverageFactorNormal(c);
  }
  return { k, expandedU: k * combinedU };
}

// ============================================================================
// STATISTICAL BOUNDS
// ============================================================================

export function chebyshevBound(sigma, k) {
  // P(|X - mu| >= k*sigma) <= 1/k^2
  const kk = k === undefined ? 3 : k;
  return 1 / (kk * kk);
}

export function cantelliBound(sigma, k) {
  // P(X - mu >= k*sigma) <= 1/(1 + k^2)
  const kk = k === undefined ? 3 : k;
  return 1 / (1 + kk * kk);
}

export function chernoffBoundBernoulli(p, delta, upper) {
  if (upper) {
    return Math.exp(-0.5 * (p * 2 * delta * delta) / 2);
  }
  return Math.exp(-0.5 * (p * delta * delta) / 2);
}

export function hoeffdingBound(range, n, epsilon) {
  // P(|X - E[X]| >= epsilon) <= 2*exp(-2*n*epsilon^2 / range^2)
  if (n <= 0 || range <= 0) return 1;
  return 2 * Math.exp((-2 * n * epsilon * epsilon) / (range * range));
}

export function empiricalConfidenceInterval(samples, confidence) {
  const c = confidence === undefined ? 0.95 : confidence;
  const n = samples.length;
  if (n < 2) return null;
  const m = Stats.mean(samples);
  const s = Stats.stddev(samples, true);
  const se = s / Math.sqrt(n);
  const k = coverageFactorNormal(c);
  return { lower: m - k * se, upper: m + k * se, mean: m, se };
}

// ============================================================================
// BAYESIAN UNCERTAINTY
// ============================================================================

export function bayesianScalarUpdate(priorMean, priorStd, likelihoodMean, likelihoodStd) {
  if (priorStd <= 0 || likelihoodStd <= 0) {
    return { mean: priorMean, std: priorStd };
  }
  const prec1 = 1 / (priorStd * priorStd);
  const prec2 = 1 / (likelihoodStd * likelihoodStd);
  const posteriorPrec = prec1 + prec2;
  const posteriorMean = (priorMean * prec1 + likelihoodMean * prec2) / posteriorPrec;
  const posteriorStd = Math.sqrt(1 / posteriorPrec);
  return { mean: posteriorMean, std: posteriorStd };
}

export function kalmanFusion(estimates) {
  // Fuse multiple scalar estimates with stddevs (inverse-variance weighting)
  let sumPrec = 0;
  let sumWeighted = 0;
  for (let i = 0; i < estimates.length; i++) {
    const p = 1 / (estimates[i].std * estimates[i].std);
    sumPrec += p;
    sumWeighted += p * estimates[i].mean;
  }
  return {
    mean: sumWeighted / sumPrec,
    std: Math.sqrt(1 / sumPrec)
  };
}

// ============================================================================
// MONTE CARLO PROPAGATION
// ============================================================================

export function monteCarloPropagate(fn, inputs, iterations, rng) {
  const N = iterations === undefined ? 1000 : iterations;
  const r = rng || (() => Math.random());
  const n = inputs.length;
  const samples = new Float64Array(n);
  const results = new Float64Array(N);
  for (let i = 0; i < n; i++) {
    if (inputs[i].kind === UncertaintyKind.INTERVAL) {
      const iv = inputs[i].interval;
      samples[i] = iv.lo + r() * (iv.hi - iv.lo);
    } else {
      // Gaussian assumption
      const u1 = Math.max(1e-300, r());
      const u2 = r();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      samples[i] = inputs[i].value + z * inputs[i].uncertainty;
    }
  }
  for (let iter = 0; iter < N; iter++) {
    for (let i = 0; i < n; i++) {
      if (inputs[i].kind === UncertaintyKind.INTERVAL) {
        const iv = inputs[i].interval;
        samples[i] = iv.lo + r() * (iv.hi - iv.lo);
      } else {
        const u1 = Math.max(1e-300, r());
        const u2 = r();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        samples[i] = inputs[i].value + z * inputs[i].uncertainty;
      }
    }
    results[iter] = fn(samples);
  }
  const mean = Stats.mean(results);
  const std = Stats.stddev(results, true);
  const sorted = Array.from(results).sort((a, b) => a - b);
  return {
    mean,
    std,
    lower95: sorted[Math.floor(0.025 * N)],
    upper95: sorted[Math.floor(0.975 * N)],
    samples: results
  };
}

// ============================================================================
// WORST-CASE / BEST-CASE BOUNDS
// ============================================================================

export function worstCaseBounds(fn, inputs) {
  const n = inputs.length;
  let worst = -Infinity;
  let best = Infinity;
  const combinations = 1 << n;
  for (let mask = 0; mask < combinations; mask++) {
    const x = new ARRAY_TYPE(n);
    for (let i = 0; i < n; i++) {
      const bit = (mask >> i) & 1;
      x[i] = bit ? inputs[i].value + inputs[i].uncertainty : inputs[i].value - inputs[i].uncertainty;
    }
    const v = fn(x);
    if (v < best) best = v;
    if (v > worst) worst = v;
  }
  return { best, worst };
}

export function worstCaseAdd(a, b) {
  return {
    min: a.value - a.uncertainty + b.value - b.uncertainty,
    max: a.value + a.uncertainty + b.value + b.uncertainty
  };
}

export function worstCaseMul(a, b) {
  const vals = [
    (a.value - a.uncertainty) * (b.value - b.uncertainty),
    (a.value - a.uncertainty) * (b.value + b.uncertainty),
    (a.value + a.uncertainty) * (b.value - b.uncertainty),
    (a.value + a.uncertainty) * (b.value + b.uncertainty)
  ];
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

// ============================================================================
// SENSITIVITY ANALYSIS
// ============================================================================

export function sensitivityAutodiff(fn, inputs) {
  const du = new AD.Dual(inputs.value, 1);
  const result = fn(du);
  return { value: result.v, derivative: result.d };
}

export function sensitivityCoefficients(fn, values) {
  const n = values.length;
  const coeffs = new ARRAY_TYPE(n);
  for (let i = 0; i < n; i++) {
    const h = Math.max(1e-8, Math.abs(values[i]) * 1e-8);
    const vp = ARRAY_TYPE.from(values);
    const vm = ARRAY_TYPE.from(values);
    vp[i] += h;
    vm[i] -= h;
    coeffs[i] = (fn(vp) - fn(vm)) / (2 * h);
  }
  return coeffs;
}

// ============================================================================
// DD HIGH-PRECISION VARIANTS
// ============================================================================

export function ddCombinedU(sigmasDD) {
  let variance = [0, 0];
  for (let i = 0; i < sigmasDD.length; i++) {
    variance = DD.add(variance, DD.multiply(sigmasDD[i], sigmasDD[i]));
  }
  return DD.sqrt(variance);
}

export function ddPropagateAdd(aDD, bDD) {
  return {
    value: DD.add(aDD.value, bDD.value),
    uncertainty: DD.sqrt(DD.add(DD.multiply(aDD.uncertainty, aDD.uncertainty), DD.multiply(bDD.uncertainty, bDD.uncertainty)))
  };
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
export const MeasurementInput = Object.freeze({
  make(value, uncertainty, kind) { return { value, uncertainty, kind }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('measurement', 'Expected {value, uncertainty, kind?}');
    checkFinite(input.value, 'measurement', 'value');
    checkFinite(input.uncertainty, 'measurement', 'uncertainty');
    if (input.uncertainty < 0) throw new DecodeError('measurement', 'uncertainty must be >= 0');
    return input;
  }
});

export const IntervalInput = Object.freeze({
  make(lo, hi) { return { lo, hi }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('interval', 'Expected {lo, hi}');
    checkFinite(input.lo, 'interval', 'lo');
    checkFinite(input.hi, 'interval', 'hi');
    if (input.lo > input.hi) throw new DecodeError('interval', 'lo must be <= hi');
    return input;
  }
});

export const FuzzyInput = Object.freeze({
  make(fz) { return { fz }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('fuzzy', 'Expected {fz}');
    if (!input.fz || typeof input.fz !== 'object') throw new DecodeError('fuzzy', 'fz required');
    return input;
  }
});

export const PropagationInput = Object.freeze({
  make(a, b) { return { a, b }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('propagation', 'Expected {a, b}');
    MeasurementInput.decode({ value: input.a.value, uncertainty: input.a.uncertainty });
    MeasurementInput.decode({ value: input.b.value, uncertainty: input.b.uncertainty });
    return input;
  }
});

export const CombinedInput = Object.freeze({
  make(contributions, sensitivity) { return { contributions, sensitivity }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('combined', 'Expected {contributions, sensitivity}');
    if (!Array.isArray(input.contributions) || !Array.isArray(input.sensitivity)) {
      throw new DecodeError('combined', 'contributions and sensitivity must be arrays');
    }
    if (input.contributions.length !== input.sensitivity.length) {
      throw new DecodeError('combined', 'length mismatch');
    }
    return input;
  }
});

export const BoundsInput = Object.freeze({
  make(fn, inputs) { return { fn, inputs }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('bounds', 'Expected {fn, inputs}');
    if (typeof input.fn !== 'function') throw new DecodeError('bounds', 'fn must be function');
    if (!Array.isArray(input.inputs)) throw new DecodeError('bounds', 'inputs must be array');
    return input;
  }
});

export const CoverageInput = Object.freeze({
  make(combinedU, confidence, dof) { return { combinedU, confidence, dof }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('coverage', 'Expected {combinedU, confidence?, dof?}');
    checkPositive(input.combinedU, 'coverage', 'combinedU');
    if (input.confidence !== undefined && (input.confidence <= 0 || input.confidence >= 1)) {
      throw new DecodeError('coverage', 'confidence must be in (0,1)');
    }
    return input;
  }
});

export const BayesianInput = Object.freeze({
  make(priorMean, priorStd, likelihoodMean, likelihoodStd) {
    return { priorMean, priorStd, likelihoodMean, likelihoodStd };
  },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('bayesian', 'Expected {priorMean, priorStd, likelihoodMean, likelihoodStd}');
    checkFinite(input.priorMean, 'bayesian', 'priorMean');
    checkPositive(input.priorStd, 'bayesian', 'priorStd');
    checkFinite(input.likelihoodMean, 'bayesian', 'likelihoodMean');
    checkPositive(input.likelihoodStd, 'bayesian', 'likelihoodStd');
    return input;
  }
});

export const MonteCarloInput = Object.freeze({
  make(fn, inputs, iterations, rng) { return { fn, inputs, iterations, rng }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('monteCarlo', 'Expected {fn, inputs, iterations?, rng?}');
    if (typeof input.fn !== 'function') throw new DecodeError('monteCarlo', 'fn must be function');
    if (!Array.isArray(input.inputs)) throw new DecodeError('monteCarlo', 'inputs must be array');
    return input;
  }
});

export const KalmanFusionInput = Object.freeze({
  make(estimates) { return { estimates }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('kalmanFusion', 'Expected {estimates}');
    if (!Array.isArray(input.estimates) || input.estimates.length === 0) {
      throw new DecodeError('kalmanFusion', 'estimates must be non-empty array');
    }
    return input;
  }
});

export const SensitivityInput = Object.freeze({
  make(fn, values) { return { fn, values }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('sensitivity', 'Expected {fn, values}');
    if (typeof input.fn !== 'function') throw new DecodeError('sensitivity', 'fn must be function');
    if (!Array.isArray(input.values)) throw new DecodeError('sensitivity', 'values must be array');
    return input;
  }
});

export const BudgetInput = CombinedInput;

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================
export function propagateAddValidated(input) {
  const d = PropagationInput.decode(input);
  return propagateAdd(d.a, d.b);
}

export function propagateMulValidated(input) {
  const d = PropagationInput.decode(input);
  return propagateMul(d.a, d.b);
}

export function intervalAddValidated(input) {
  const a = IntervalInput.decode({ lo: input.a.lo, hi: input.a.hi });
  const b = IntervalInput.decode({ lo: input.b.lo, hi: input.b.hi });
  return intervalAdd({ lo: a.lo, hi: a.hi }, { lo: b.lo, hi: b.hi });
}

export function combinedStandardUncertaintyValidated(input) {
  const d = CombinedInput.decode(input);
  return combinedStandardUncertainty(d.contributions, d.sensitivity);
}

export function uncertaintyBudgetValidated(input) {
  const d = CombinedInput.decode(input);
  const dof = input.dof || new Array(d.contributions.length).fill(Infinity);
  return uncertaintyBudget(d.contributions, d.sensitivity, dof);
}

export function expandedUncertaintyValidated(input) {
  const d = CoverageInput.decode(input);
  return expandedUncertainty(d.combinedU, d.confidence, d.dof);
}

export function bayesianScalarUpdateValidated(input) {
  const d = BayesianInput.decode(input);
  return bayesianScalarUpdate(d.priorMean, d.priorStd, d.likelihoodMean, d.likelihoodStd);
}

export function kalmanFusionValidated(input) {
  const d = KalmanFusionInput.decode(input);
  return kalmanFusion(d.estimates);
}

export function monteCarloValidated(input) {
  const d = MonteCarloInput.decode(input);
  return monteCarloPropagate(d.fn, d.inputs, d.iterations, d.rng);
}

export function sensitivityValidated(input) {
  const d = SensitivityInput.decode(input);
  return sensitivityCoefficients(d.fn, d.values);
}

export function worstCaseBoundsValidated(input) {
  const d = BoundsInput.decode(input);
  return worstCaseBounds(d.fn, d.inputs);
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

export function propagateAddWithPolicies(a, b, policy) {
  return policyCustom(
    'Uncertainty.propagateAddWithPolicies',
    () => propagateAdd(a, b),
    (r) => isFiniteNumber(r.value) && isFiniteNumber(r.uncertainty),
    (r) => ({ value: r.value, uncertainty: r.uncertainty }),
    policy
  );
}

export function propagateMulWithPolicies(a, b, policy) {
  return policyCustom(
    'Uncertainty.propagateMulWithPolicies',
    () => propagateMul(a, b),
    (r) => isFiniteNumber(r.value) && isFiniteNumber(r.uncertainty),
    (r) => ({ value: r.value, uncertainty: r.uncertainty }),
    policy
  );
}

export function combinedStandardUncertaintyWithPolicies(contributions, sensitivity, policy) {
  return policyScalar(
    'Uncertainty.combinedStandardUncertaintyWithPolicies',
    () => combinedStandardUncertainty(contributions, sensitivity),
    (r) => ({ n: contributions.length, result: r }),
    policy
  );
}

export function expandedUncertaintyWithPolicies(combinedU, confidence, dof, policy) {
  return policyCustom(
    'Uncertainty.expandedUncertaintyWithPolicies',
    () => expandedUncertainty(combinedU, confidence, dof),
    (r) => r && isFiniteNumber(r.expandedU),
    (r) => ({ combinedU, expandedU: r.expandedU, k: r.k }),
    policy
  );
}

export function bayesianUpdateWithPolicies(priorMean, priorStd, likelihoodMean, likelihoodStd, policy) {
  return policyCustom(
    'Uncertainty.bayesianUpdateWithPolicies',
    () => bayesianScalarUpdate(priorMean, priorStd, likelihoodMean, likelihoodStd),
    (r) => isFiniteNumber(r.mean) && isFiniteNumber(r.std),
    (r) => ({ mean: r.mean, std: r.std }),
    policy
  );
}

export function kalmanFusionWithPolicies(estimates, policy) {
  return policyCustom(
    'Uncertainty.kalmanFusionWithPolicies',
    () => kalmanFusion(estimates),
    (r) => isFiniteNumber(r.mean) && isFiniteNumber(r.std),
    (r) => ({ mean: r.mean, std: r.std }),
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
  AD,
  Dist,
  Prec,
  Stats,
  PolicyModule
};

export default {
  DecodeError,
  DomainViolationError,
  UncertaintyKind,
  Measurement,
  asAbsolute,
  asRelative,
  asStandard,
  asExpanded,
  toAbsoluteU,
  toRelativeU,
  expandedU,
  propagateAdd,
  propagateSub,
  propagateMul,
  propagateDiv,
  propagatePow,
  propagateSqrt,
  propagateLog,
  propagateExp,
  propagateSin,
  propagateCos,
  propagateTan,
  propagateFunction,
  propagateCorrelated,
  propagateJacobian,
  Interval,
  intervalFromCenter,
  intervalWidth,
  intervalMidpoint,
  intervalRadius,
  intervalContains,
  intervalContainsInterval,
  intervalIntersects,
  intervalIntersection,
  intervalUnion,
  intervalDistance,
  intervalAdd,
  intervalSub,
  intervalMul,
  intervalDiv,
  intervalPow,
  intervalSqrt,
  intervalExp,
  intervalLog,
  intervalToMeasurement,
  measurementToInterval,
  TriangularFuzzy,
  TrapezoidalFuzzy,
  fuzzyMembership,
  fuzzyAlphaCut,
  fuzzyCore,
  fuzzySupport,
  fuzzyCentroid,
  fuzzyDefuzzifyMOM,
  combinedStandardUncertainty,
  uncertaintyBudget,
  coverageFactorNormal,
  coverageFactorStudentT,
  expandedUncertainty,
  chebyshevBound,
  cantelliBound,
  chernoffBoundBernoulli,
  hoeffdingBound,
  empiricalConfidenceInterval,
  bayesianScalarUpdate,
  kalmanFusion,
  monteCarloPropagate,
  worstCaseBounds,
  worstCaseAdd,
  worstCaseMul,
  sensitivityAutodiff,
  sensitivityCoefficients,
  ddCombinedU,
  ddPropagateAdd,
  poolAcquireScratch,
  poolReleaseScratch,
  poolReset,
  poolSize,
  MeasurementInput,
  IntervalInput,
  FuzzyInput,
  PropagationInput,
  CombinedInput,
  BoundsInput,
  CoverageInput,
  BayesianInput,
  MonteCarloInput,
  KalmanFusionInput,
  SensitivityInput,
  BudgetInput,
  propagateAddValidated,
  propagateMulValidated,
  intervalAddValidated,
  combinedStandardUncertaintyValidated,
  uncertaintyBudgetValidated,
  expandedUncertaintyValidated,
  bayesianScalarUpdateValidated,
  kalmanFusionValidated,
  monteCarloValidated,
  sensitivityValidated,
  worstCaseBoundsValidated,
  propagateAddWithPolicies,
  propagateMulWithPolicies,
  combinedStandardUncertaintyWithPolicies,
  expandedUncertaintyWithPolicies,
  bayesianUpdateWithPolicies,
  kalmanFusionWithPolicies
};