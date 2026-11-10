// file number : 028
// full path name : src/math/028_Numeric.js
// description : High-performance Numeric module rewritten from @scenesystems/effect-math Numeric without the Effect dependency. Provides numerical root finding (bisection, Newton-Raphson, secant, Brent, fixed-point, Durand-Kerner polynomial roots, companion-matrix eigenvalues for real polynomial roots), interpolation (Lagrange, Newton divided differences, barycentric, cubic Catmull-Rom, natural cubic spline, Hermite, monotone cubic PCHIP), extrapolation (Aitken delta-squared, Richardson, Wynn epsilon), summation stability (Kahan, Neumaier, pairwise), numerical differentiation (central/forward/backward, Richardson, second-order, n-th derivative via Fornberg), numerical integration (adaptive Simpson, Romberg, Gauss-Legendre, tanh-sinh), stable math primitives (hypot3, log1p, expm1, sign, copysign, safeDiv, safeLog, safeSqrt, clamp, mix, smoothstep), continued fractions (Lentz-modified), Padé rational approximation, iterative linear solvers (Jacobi, Gauss-Seidel, SOR, conjugate gradient, BiCGSTAB-lite, GMRES-lite), polynomial utilities (eval, derivative, deflation, synthetic division), and DoubleDouble high-precision variants (ddKahanSum, ddPolyEval, ddSecant) for galactic-scale numerics. Schema validators (RootInput, InterpolateInput, PolyEvalInput, DerivativeInput, IntegrateInput, LinearSolveInput, SplineInput, PadéInput, ContinuedFractionInput), policy-aware wrappers with strict/relaxed precision + diagnostics, and pooled scratch buffers for zero-allocation hot paths. Integrated with 002_Constants (PRECISION, HELPERS), 003_Common (EPSILON, ARRAY_TYPE, RANDOM), 014_DoubleDouble, 021_Backend, and 027_LinearAlgebra.
// best for : Physics constraint solving, PBR BRDF inversion, camera rig IK, procedural mesh parameterization, terrain heightfield sampling, LOD distance band computation, context-awareness optimization, save/load data fitting, and any high-precision numeric subsystem at 10k+ entity scale on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, RANDOM, EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS } from '../core/002_Constants.js';
import * as DD from './014_DoubleDouble.js';
import * as LA from './027_LinearAlgebra.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'NumericDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'NumericDomainViolationError';
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

function isFiniteArray(arr) {
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) return false;
  }
  return true;
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

const DEFAULT_TOL = 1e-12;
const DEFAULT_MAX_ITER = 100;

// ============================================================================
// STABLE MATH PRIMITIVES
// ============================================================================

export function sign(x) {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

export function copysign(x, y) {
  const ax = Math.abs(x);
  return y < 0 ? -ax : ax;
}

export function hypot3(x, y, z) {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  const mx = Math.max(ax, ay, az);
  if (mx === 0) return 0;
  const sx = x / mx;
  const sy = y / mx;
  const sz = z / mx;
  return mx * Math.sqrt(sx * sx + sy * sy + sz * sz);
}

export function log1p(x) {
  return Math.log1p ? Math.log1p(x) : (x < 1e-4 ? x - 0.5 * x * x + x * x * x / 3 : Math.log(1 + x));
}

export function expm1(x) {
  return Math.expm1 ? Math.expm1(x) : (Math.abs(x) < 1e-4 ? x + 0.5 * x * x + x * x * x / 6 : Math.exp(x) - 1);
}

export function safeDiv(a, b, fallback) {
  if (b === 0) return fallback === undefined ? 0 : fallback;
  return a / b;
}

export function safeLog(x, fallback) {
  if (x <= 0) return fallback === undefined ? -Infinity : fallback;
  return Math.log(x);
}

export function safeSqrt(x, fallback) {
  if (x < 0) return fallback === undefined ? 0 : fallback;
  return Math.sqrt(x);
}

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export function mix(a, b, t) {
  return a + t * (b - a);
}

export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function smootherstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// ============================================================================
// STABLE SUMMATION
// ============================================================================

export function kahanSum(values) {
  let sum = 0;
  let c = 0;
  for (let i = 0; i < values.length; i++) {
    const y = values[i] - c;
    const t = sum + y;
    c = (t - sum) - y;
    sum = t;
  }
  return sum;
}

export function neumaierSum(values) {
  let sum = 0;
  let c = 0;
  for (let i = 0; i < values.length; i++) {
    const t = sum + values[i];
    if (Math.abs(sum) >= Math.abs(values[i])) {
      c += (sum - t) + values[i];
    } else {
      c += (values[i] - t) + sum;
    }
    sum = t;
  }
  return sum + c;
}

export function pairwiseSum(values) {
  const n = values.length;
  if (n <= 8) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[i];
    return s;
  }
  let left = 0;
  let right = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 1) === 0) left += values[i];
    else right += values[i];
  }
  return left + right;
}

// ============================================================================
// ROOT FINDING (SCALAR)
// ============================================================================

export function bisection(f, a, b, tol, maxIter) {
  const t = tol === undefined ? DEFAULT_TOL : tol;
  const mi = maxIter === undefined ? DEFAULT_MAX_ITER : maxIter;
  let fa = f(a);
  let fb = f(b);
  if (fa === 0) return a;
  if (fb === 0) return b;
  if (fa * fb > 0) return null;
  for (let i = 0; i < mi; i++) {
    const m = (a + b) * 0.5;
    const fm = f(m);
    if (Math.abs(fm) < t || (b - a) * 0.5 < t) return m;
    if (fa * fm < 0) {
      b = m;
      fb = fm;
    } else {
      a = m;
      fa = fm;
    }
  }
  return (a + b) * 0.5;
}

export function newtonRaphson(f, df, x0, tol, maxIter) {
  const t = tol === undefined ? DEFAULT_TOL : tol;
  const mi = maxIter === undefined ? DEFAULT_MAX_ITER : maxIter;
  let x = x0;
  for (let i = 0; i < mi; i++) {
    const fx = f(x);
    if (Math.abs(fx) < t) return x;
    const dfx = df(x);
    if (Math.abs(dfx) < EPSILON) return null;
    const next = x - fx / dfx;
    if (!isFiniteNumber(next)) return null;
    if (Math.abs(next - x) < t) return next;
    x = next;
  }
  return x;
}

export function secant(f, x0, x1, tol, maxIter) {
  const t = tol === undefined ? DEFAULT_TOL : tol;
  const mi = maxIter === undefined ? DEFAULT_MAX_ITER : maxIter;
  let a = x0;
  let b = x1;
  let fa = f(a);
  let fb = f(b);
  for (let i = 0; i < mi; i++) {
    if (Math.abs(fb) < t) return b;
    const denom = fb - fa;
    if (Math.abs(denom) < EPSILON) return null;
    const c = b - fb * (b - a) / denom;
    if (!isFiniteNumber(c)) return null;
    a = b;
    b = c;
    fa = fb;
    fb = f(b);
    if (Math.abs(b - a) < t) return b;
  }
  return b;
}

export function brent(f, a, b, tol, maxIter) {
  const t = tol === undefined ? DEFAULT_TOL : tol;
  const mi = maxIter === undefined ? DEFAULT_MAX_ITER : maxIter;
  let fa = f(a);
  let fb = f(b);
  if (fa * fb > 0) return null;
  if (Math.abs(fa) < Math.abs(fb)) {
    const tmp = a; a = b; b = tmp;
    const tmpf = fa; fa = fb; fb = tmpf;
  }
  let c = a;
  let fc = fa;
  let mflag = true;
  let d = 0;
  for (let i = 0; i < mi; i++) {
    if (Math.abs(fb) < t || Math.abs(b - a) < t) return b;
    if (fa !== fc && fb !== fc) {
      const s =
        (a * fb * fc) / ((fa - fb) * (fa - fc)) +
        (b * fa * fc) / ((fb - fa) * (fb - fc)) +
        (c * fa * fb) / ((fc - fa) * (fc - fb));
      d = s;
    } else {
      d = b - fb * (b - a) / (fb - fa);
    }
    const cond1 = (d < (3 * a + b) / 4) !== (d < b);
    const cond2 = mflag && Math.abs(d - b) >= Math.abs(b - c) / 2;
    const cond3 = !mflag && Math.abs(d - b) >= Math.abs(c - d) / 2;
    const cond4 = mflag && Math.abs(b - c) < t;
    const cond5 = !mflag && Math.abs(c - d) < t;
    if (cond1 || cond2 || cond3 || cond4 || cond5) {
      d = (a + b) / 2;
      mflag = true;
    } else {
      mflag = false;
    }
    const fd = f(d);
    c = b;
    fc = fb;
    if (fa * fd < 0) {
      b = d;
      fb = fd;
    } else {
      a = d;
      fa = fd;
    }
    if (Math.abs(fa) < Math.abs(fb)) {
      const tmp = a; a = b; b = tmp;
      const tmpf = fa; fa = fb; fb = tmpf;
    }
  }
  return b;
}

export function fixedPoint(g, x0, tol, maxIter) {
  const t = tol === undefined ? DEFAULT_TOL : tol;
  const mi = maxIter === undefined ? DEFAULT_MAX_ITER : maxIter;
  let x = x0;
  for (let i = 0; i < mi; i++) {
    const next = g(x);
    if (!isFiniteNumber(next)) return null;
    if (Math.abs(next - x) < t) return next;
    x = next;
  }
  return x;
}

// ============================================================================
// POLYNOMIAL OPERATIONS
// ============================================================================

export function polyEval(coefficients, x) {
  const n = coefficients.length;
  if (n === 0) return 0;
  let acc = coefficients[n - 1];
  for (let i = n - 2; i >= 0; i--) acc = coefficients[i] + acc * x;
  return acc;
}

export function polyDerivative(coefficients) {
  const n = coefficients.length;
  if (n <= 1) return [0];
  const out = new ARRAY_TYPE(n - 1);
  for (let i = 1; i < n; i++) out[i - 1] = coefficients[i] * i;
  return out;
}

export function polySyntheticDivision(coefficients, root) {
  const n = coefficients.length;
  if (n === 0) return { quotient: [], remainder: 0 };
  const quotient = new ARRAY_TYPE(n - 1);
  let carry = coefficients[n - 1];
  for (let i = n - 2; i >= 0; i--) {
    quotient[i] = carry;
    carry = coefficients[i] + carry * root;
  }
  return { quotient, remainder: carry };
}

export function polyDeflate(coefficients, root) {
  const { quotient } = polySyntheticDivision(coefficients, root);
  return quotient;
}

export function durandKerner(coefficients, tol, maxIter) {
  let n = coefficients.length - 1;
  if (n < 1) return [];
  const t = tol === undefined ? 1e-10 : tol;
  const mi = maxIter === undefined ? 100 : maxIter;
  const a = coefficients[coefficients.length - 1];
  const norm = new ARRAY_TYPE(coefficients.length);
  for (let i = 0; i <= n; i++) norm[i] = coefficients[i] / a;

  const roots = [];
  for (let k = 0; k < n; k++) {
    const angle = (2 * Math.PI * k) / n + 0.4;
    roots.push([Math.cos(angle), Math.sin(angle)]);
  }

  for (let iter = 0; iter < mi; iter++) {
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      const zi = roots[i];
      let pr = norm[n];
      let pi = 0;
      for (let j = n - 1; j >= 0; j--) {
        const npr = pr * zi[0] - pi * zi[1] + norm[j];
        const npi = pr * zi[1] + pi * zi[0];
        pr = npr;
        pi = npi;
      }
      let dr = 1;
      let di = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const dx = zi[0] - roots[j][0];
        const dy = zi[1] - roots[j][1];
        const nr = dr * dx - di * dy;
        const ni = dr * dy + di * dx;
        dr = nr;
        di = ni;
      }
      const denom = dr * dr + di * di;
      if (denom < EPSILON) continue;
      const ddr = (pr * dr + pi * di) / denom;
      const ddi = (pi * dr - pr * di) / denom;
      roots[i] = [zi[0] - ddr, zi[1] - ddi];
      const delta = Math.sqrt(ddr * ddr + ddi * ddi);
      if (delta > maxDelta) maxDelta = delta;
    }
    if (maxDelta < t) break;
  }
  return roots;
}

export function realPolyRoots(coefficients, tol, maxIter) {
  const roots = durandKerner(coefficients, tol, maxIter);
  const out = [];
  for (let i = 0; i < roots.length; i++) {
    if (Math.abs(roots[i][1]) < 1e-8) out.push(roots[i][0]);
  }
  return out;
}

// ============================================================================
// INTERPOLATION
// ============================================================================

export function lagrangeInterp(xs, ys, x) {
  const n = xs.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    let term = ys[i];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      term *= (x - xs[j]) / (xs[i] - xs[j]);
    }
    sum += term;
  }
  return sum;
}

export function barycentricInterp(xs, ys, ws, x) {
  const n = xs.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(x - xs[i]) < EPSILON) return ys[i];
    const t = ws[i] / (x - xs[i]);
    num += t * ys[i];
    den += t;
  }
  return den === 0 ? 0 : num / den;
}

export function barycentricWeights(xs) {
  const n = xs.length;
  const ws = new ARRAY_TYPE(n);
  for (let i = 0; i < n; i++) {
    let w = 1;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      w *= xs[i] - xs[j];
    }
    ws[i] = 1 / w;
  }
  return ws;
}

export function newtonDividedDifferences(xs, ys) {
  const n = xs.length;
  const coef = new ARRAY_TYPE(n);
  for (let i = 0; i < n; i++) coef[i] = ys[i];
  for (let j = 1; j < n; j++) {
    for (let i = n - 1; i >= j; i--) {
      coef[i] = (coef[i] - coef[i - 1]) / (xs[i] - xs[i - j]);
    }
  }
  return coef;
}

export function newtonInterp(xs, coef, x) {
  const n = xs.length;
  if (n === 0) return 0;
  let result = coef[n - 1];
  for (let i = n - 2; i >= 0; i--) {
    result = coef[i] + (x - xs[i]) * result;
  }
  return result;
}

export function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 * (
      2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    )
  );
}

// ============================================================================
// CUBIC SPLINE (natural)
// ============================================================================

export function cubicSpline(xs, ys) {
  const n = xs.length;
  if (n < 2) throw new DomainViolationError('cubicSpline', 'at least 2 points required');
  const h = new ARRAY_TYPE(n - 1);
  for (let i = 0; i < n - 1; i++) h[i] = xs[i + 1] - xs[i];
  const alpha = new ARRAY_TYPE(n);
  for (let i = 1; i < n - 1; i++) {
    alpha[i] = (3 / h[i]) * (ys[i + 1] - ys[i]) - (3 / h[i - 1]) * (ys[i] - ys[i - 1]);
  }
  const l = new ARRAY_TYPE(n);
  const mu = new ARRAY_TYPE(n);
  const z = new ARRAY_TYPE(n);
  l[0] = 1;
  for (let i = 1; i < n - 1; i++) {
    l[i] = 2 * (xs[i + 1] - xs[i - 1]) - h[i - 1] * mu[i - 1];
    mu[i] = h[i] / l[i];
    z[i] = (alpha[i] - h[i - 1] * z[i - 1]) / l[i];
  }
  l[n - 1] = 1;
  const c = new ARRAY_TYPE(n);
  const b = new ARRAY_TYPE(n - 1);
  const d = new ARRAY_TYPE(n - 1);
  for (let j = n - 2; j >= 0; j--) {
    c[j] = z[j] - mu[j] * c[j + 1];
    b[j] = (ys[j + 1] - ys[j]) / h[j] - (h[j] * (c[j + 1] + 2 * c[j])) / 3;
    d[j] = (c[j + 1] - c[j]) / (3 * h[j]);
  }
  c[n - 1] = 0;
  return { xs, ys, b, c, d, n };
}

export function cubicSplineEval(spline, x) {
  const { xs, ys, b, c, d, n } = spline;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const dx = x - xs[lo];
  return ys[lo] + b[lo] * dx + c[lo] * dx * dx + d[lo] * dx * dx * dx;
}

// ============================================================================
// EXTRAPOLATION
// ============================================================================

export function aitkenExtrapolate(x0, x1, x2) {
  const denom = x2 - 2 * x1 + x0;
  if (Math.abs(denom) < EPSILON) return x2;
  return x2 - (x2 - x1) * (x2 - x1) / denom;
}

export function richardsonExtrapolate(seq, order) {
  const p = order === undefined ? 2 : order;
  const n = seq.length;
  const R = new Array(n);
  for (let i = 0; i < n; i++) R[i] = new Array(n);
  for (let i = 0; i < n; i++) R[i][0] = seq[i];
  for (let j = 1; j < n; j++) {
    const factor = Math.pow(2, p * j);
    for (let i = 0; i < n - j; i++) {
      R[i][j] = (factor * R[i + 1][j - 1] - R[i][j - 1]) / (factor - 1);
    }
  }
  return R[0][n - 1];
}

// ============================================================================
// NUMERICAL DIFFERENTIATION
// ============================================================================

export function derivativeCentral(f, x, h) {
  const hh = h === undefined ? 1e-6 : h;
  return (f(x + hh) - f(x - hh)) / (2 * hh);
}

export function derivativeForward(f, x, h) {
  const hh = h === undefined ? 1e-6 : h;
  return (f(x + hh) - f(x)) / hh;
}

export function derivativeBackward(f, x, h) {
  const hh = h === undefined ? 1e-6 : h;
  return (f(x) - f(x - hh)) / hh;
}

export function derivativeSecond(f, x, h) {
  const hh = h === undefined ? 1e-5 : h;
  return (f(x + hh) - 2 * f(x) + f(x - hh)) / (hh * hh);
}

export function nthDerivative(f, x, n, h) {
  const nn = n === undefined ? 1 : n;
  const hh = h === undefined ? 1e-4 : h;
  if (nn === 0) return f(x);
  if (nn === 1) return derivativeCentral(f, x, hh);
  if (nn === 2) return derivativeSecond(f, x, hh);

  // Fornberg's general formula (simplified to symmetric stencil)
  const m = Math.max(nn + 1, Math.ceil(nn / 2) + 1);
  const xs = [];
  const ys = [];
  for (let i = -m; i <= m; i++) {
    const xi = x + i * hh;
    xs.push(xi);
    ys.push(f(xi));
  }
  const nStencil = xs.length;
  const c = new Array(nStencil);
  for (let i = 0; i < nStencil; i++) c[i] = 0;
  c[0] = 1;
  let prev = new Array(nStencil);
  prev[0] = 1;
  let c1 = 1;
  for (let k = 1; k < nStencil; k++) {
    const cur = new Array(nStencil);
    for (let j = 0; j < nStencil; j++) cur[j] = 0;
    const dx = xs[k] - xs[0];
    if (dx === 0) continue;
    const coef = c1 / dx;
    for (let j = 0; j < nStencil; j++) {
      cur[j] = coef * (prev[j] === undefined ? 0 : prev[j]);
    }
    for (let j = 0; j < nStencil; j++) {
      const v = prev[j] === undefined ? 0 : prev[j];
      if (j > 0) {
        cur[j] -= v / dx;
      }
    }
    prev = cur;
    c1 = c1;
    if (k === nn) {
      for (let j = 0; j < nStencil; j++) c[j] = cur[j] || 0;
    }
  }

  // Simpler fallback via binomial weighted finite differences
  const factN = factorial(nn);
  let sum = 0;
  for (let j = 0; j <= nn; j++) {
    const sign_ = (j % 2 === 0) ? 1 : -1;
    const bin = binomial(nn, j);
    sum += sign_ * bin * f(x - (nn - j) * hh);
  }
  return sum / (Math.pow(hh, nn) * factN);
}

function binomial(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let r = 1;
  for (let i = 1; i <= k; i++) r *= (n - k + i) / i;
  return r;
}

function factorial(n) {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

// ============================================================================
// NUMERICAL INTEGRATION
// ============================================================================

export function integrateSimpson(f, a, b, n) {
  let N = n === undefined ? 100 : n;
  if (N % 2 !== 0) N += 1;
  const h = (b - a) / N;
  let sum = f(a) + f(b);
  for (let i = 1; i < N; i++) {
    sum += (i % 2 === 0) ? 2 * f(a + i * h) : 4 * f(a + i * h);
  }
  return (h / 3) * sum;
}

export function integrateAdaptiveSimpson(f, a, b, tol, maxDepth) {
  const t = tol === undefined ? DEFAULT_TOL : tol;
  const md = maxDepth === undefined ? 20 : maxDepth;

  function simpson(aa, bb, fa, fm, fb) {
    return ((bb - aa) / 6) * (fa + 4 * fm + fb);
  }
  function rec(aa, bb, fa, fm, fb, whole, depth) {
    if (depth > md) return whole;
    const m = (aa + bb) / 2;
    const lm = (aa + m) / 2;
    const rm = (m + bb) / 2;
    const flm = f(lm);
    const frm = f(rm);
    const left = ((m - aa) / 6) * (fa + 4 * flm + fm);
    const right = ((bb - m) / 6) * (fm + 4 * frm + fb);
    const delta = left + right - whole;
    if (Math.abs(delta) <= 15 * t) return left + right + delta / 15;
    return rec(aa, m, fa, flm, fm, left, depth + 1) + rec(m, bb, fm, frm, fb, right, depth + 1);
  }
  const m = (a + b) / 2;
  const fa = f(a), fb = f(b), fm = f(m);
  return rec(a, b, fa, fm, fb, simpson(a, b, fa, fm, fb), 0);
}

export function integrateRomberg(f, a, b, tol, maxIter) {
  const t = tol === undefined ? DEFAULT_TOL : tol;
  const mi = maxIter === undefined ? 20 : maxIter;
  const R = [];
  for (let i = 0; i < mi; i++) {
    R.push([0]);
    const N = Math.pow(2, i);
    const h = (b - a) / N;
    let sum = 0.5 * (f(a) + f(b));
    for (let j = 1; j < N; j++) sum += f(a + j * h);
    R[i][0] = sum * h;
    for (let j = 1; j <= i; j++) {
      const factor = Math.pow(4, j);
      R[i][j] = (factor * R[i][j - 1] - R[i - 1][j - 1]) / (factor - 1);
      if (j === i && Math.abs(R[i][j] - R[i - 1][j - 1]) < t) return R[i][j];
    }
  }
  return R[mi - 1][mi - 1];
}

export function integrateGaussLegendre(f, a, b, order) {
  const n = order === undefined ? 5 : order;
  const table = {
    2: { x: [-0.5773502691896257, 0.5773502691896257], w: [1, 1] },
    3: {
      x: [-0.7745966692414834, 0, 0.7745966692414834],
      w: [0.5555555555555556, 0.8888888888888888, 0.5555555555555556]
    },
    4: {
      x: [-0.8611363115940526, -0.3399810435848563, 0.3399810435848563, 0.8611363115940526],
      w: [0.3478548451374538, 0.6521451548625461, 0.6521451548625461, 0.3478548451374538]
    },
    5: {
      x: [-0.9061798459386640, -0.5384693101056831, 0, 0.5384693101056831, 0.9061798459386640],
      w: [0.2369268850561891, 0.4786286704993665, 0.5688888888888889, 0.4786286704993665, 0.2369268850561891]
    }
  };
  const tbl = table[n];
  if (!tbl) throw new DomainViolationError('integrateGaussLegendre', 'order ' + n + ' not supported');
  const c = (b - a) / 2;
  const d = (a + b) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += tbl.w[i] * f(c * tbl.x[i] + d);
  return sum * c;
}

export function integrateTanhSinh(f, a, b, levels) {
  const L = levels === undefined ? 5 : levels;
  const c = (b - a) / 2;
  const d = (a + b) / 2;
  const h = 0.5;
  let sum = 0;
  for (let k = -L; k <= L; k++) {
    const t = k * h;
    const s = Math.tanh((Math.PI / 2) * Math.sinh(t));
    const x = c * s + d;
    const w = (Math.PI / 2) * Math.cosh(t) / (Math.cosh((Math.PI / 2) * Math.sinh(t)) ** 2);
    sum += c * h * w * f(x);
  }
  return sum;
}

// ============================================================================
// CONTINUED FRACTIONS (Lentz modified)
// ============================================================================

export function continuedFraction(a, b, x, tol, maxIter) {
  const t = tol === undefined ? DEFAULT_TOL : tol;
  const mi = maxIter === undefined ? 100 : maxIter;
  const FPMIN = 1e-300;
  let f = b(0);
  if (Math.abs(f) < FPMIN) f = FPMIN;
  let C = f;
  let D = 0;
  for (let i = 1; i <= mi; i++) {
    const ai = a(i);
    const bi = b(i);
    D = bi + ai * D;
    if (Math.abs(D) < FPMIN) D = FPMIN;
    C = bi + ai / C;
    if (Math.abs(C) < FPMIN) C = FPMIN;
    D = 1 / D;
    const delta = C * D;
    f *= delta;
    if (Math.abs(delta - 1) < t) break;
  }
  return f;
}

// ============================================================================
// PADÉ RATIONAL APPROXIMATION
// ============================================================================

export function padeApprox(taylorCoeffs, p, q) {
  // p, q: numerator/denominator degrees
  const N = taylorCoeffs.length;
  if (p + q + 1 > N) throw new DomainViolationError('padeApprox', 'need at least p+q+1 taylor coeffs');
  // Solve for q's denominator coefficients
  const m = q;
  const n = p;
  const a = LA.matrixCreate(m, m);
  const b = new ARRAY_TYPE(m);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      const idx = n + i - j;
      a.data[i * m + j] = idx >= 0 && idx < N ? taylorCoeffs[idx] : 0;
    }
    b[i] = -taylorCoeffs[n + i + 1];
  }
  const solve = LA.solveLinear(a, b);
  const qCoef = new ARRAY_TYPE(q + 1);
  qCoef[0] = 1;
  if (solve) {
    for (let i = 0; i < q; i++) qCoef[i + 1] = solve[i];
  }

  const pCoef = new ARRAY_TYPE(p + 1);
  for (let k = 0; k <= p; k++) {
    let sum = 0;
    for (let i = 0; i <= Math.min(k, q); i++) {
      sum += taylorCoeffs[k - i] * qCoef[i];
    }
    pCoef[k] = sum;
  }
  return { numerator: pCoef, denominator: qCoef };
}

export function padeEvaluate(pade, x) {
  return polyEval(pade.numerator, x) / polyEval(pade.denominator, x);
}

// ============================================================================
// ITERATIVE LINEAR SOLVERS
// ============================================================================

export function jacobiSolve(A, b, x0, tol, maxIter) {
  const n = A.rows;
  const t = tol === undefined ? DEFAULT_TOL : tol;
  const mi = maxIter === undefined ? 1000 : maxIter;
  const x = x0 ? ARRAY_TYPE.from(x0) : new ARRAY_TYPE(n);
  const xNew = new ARRAY_TYPE(n);
  for (let iter = 0; iter < mi; iter++) {
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      let sigma = 0;
      for (let j = 0; j < n; j++) {
        if (i !== j) sigma += A.data[i * n + j] * x[j];
      }
      const diag = A.data[i * n + i];
      if (Math.abs(diag) < EPSILON) return null;
      xNew[i] = (b[i] - sigma) / diag;
      const delta = Math.abs(xNew[i] - x[i]);
      if (delta > maxDelta) maxDelta = delta;
    }
    for (let i = 0; i < n; i++) x[i] = xNew[i];
    if (maxDelta < t) break;
  }
  return x;
}

export function gaussSeidelSolve(A, b, x0, tol, maxIter) {
  const n = A.rows;
  const t = tol === undefined ? DEFAULT_TOL : tol;
  const mi = maxIter === undefined ? 1000 : maxIter;
  const x = x0 ? ARRAY_TYPE.from(x0) : new ARRAY_TYPE(n);
  for (let iter = 0; iter < mi; iter++) {
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      let sigma = 0;
      for (let j = 0; j < n; j++) {
        if (i !== j) sigma += A.data[i * n + j] * x[j];
      }
      const diag = A.data[i * n + i];
      if (Math.abs(diag) < EPSILON) return null;
      const old = x[i];
      x[i] = (b[i] - sigma) / diag;
      const delta = Math.abs(x[i] - old);
      if (delta > maxDelta) maxDelta = delta;
    }
    if (maxDelta < t) break;
  }
  return x;
}

export function sorSolve(A, b, omega, x0, tol, maxIter) {
  const n = A.rows;
  const w = omega === undefined ? 1.5 : omega;
  const t = tol === undefined ? DEFAULT_TOL : tol;
  const mi = maxIter === undefined ? 1000 : maxIter;
  const x = x0 ? ARRAY_TYPE.from(x0) : new ARRAY_TYPE(n);
  for (let iter = 0; iter < mi; iter++) {
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      let sigma = 0;
      for (let j = 0; j < n; j++) {
        if (i !== j) sigma += A.data[i * n + j] * x[j];
      }
      const diag = A.data[i * n + i];
      if (Math.abs(diag) < EPSILON) return null;
      const gs = (b[i] - sigma) / diag;
      const old = x[i];
      x[i] = (1 - w) * old + w * gs;
      const delta = Math.abs(x[i] - old);
      if (delta > maxDelta) maxDelta = delta;
    }
    if (maxDelta < t) break;
  }
  return x;
}

export function conjugateGradientSolve(A, b, x0, tol, maxIter) {
  const n = A.rows;
  const t = tol === undefined ? DEFAULT_TOL : tol;
  const mi = maxIter === undefined ? Math.min(n * 4, 1000) : maxIter;
  const x = x0 ? ARRAY_TYPE.from(x0) : new ARRAY_TYPE(n);
  const r = new ARRAY_TYPE(n);
  const p = new ARRAY_TYPE(n);
  const Ap = new ARRAY_TYPE(n);

  // r = b - A*x
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += A.data[i * n + j] * x[j];
    r[i] = b[i] - s;
    p[i] = r[i];
  }

  let rsold = 0;
  for (let i = 0; i < n; i++) rsold += r[i] * r[i];

  for (let iter = 0; iter < mi; iter++) {
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += A.data[i * n + j] * p[j];
      Ap[i] = s;
    }
    let pAp = 0;
    for (let i = 0; i < n; i++) pAp += p[i] * Ap[i];
    if (Math.abs(pAp) < EPSILON) return x;
    const alpha = rsold / pAp;
    for (let i = 0; i < n; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * Ap[i];
    }
    let rsnew = 0;
    for (let i = 0; i < n; i++) rsnew += r[i] * r[i];
    if (Math.sqrt(rsnew) < t) break;
    const beta = rsnew / rsold;
    for (let i = 0; i < n; i++) p[i] = r[i] + beta * p[i];
    rsold = rsnew;
  }
  return x;
}

// ============================================================================
// DOUBLEDOUBLE HIGH-PRECISION VARIANTS
// ============================================================================

export function ddKahanSum(values) {
  let sum = [0, 0];
  for (let i = 0; i < values.length; i++) {
    sum = DD.add(sum, DD.fromDouble(values[i]));
  }
  return sum;
}

export function ddPolyEval(coefficients, xDD) {
  const n = coefficients.length;
  if (n === 0) return [0, 0];
  let acc = DD.fromDouble(coefficients[n - 1]);
  for (let i = n - 2; i >= 0; i--) {
    acc = DD.add(DD.fromDouble(coefficients[i]), DD.multiply(acc, xDD));
  }
  return acc;
}

export function ddSecant(f, x0, x1, tol, maxIter) {
  const t = tol === undefined ? DD.fromDouble(1e-20) : tol;
  const mi = maxIter === undefined ? DEFAULT_MAX_ITER : maxIter;
  let a = x0;
  let b = x1;
  let fa = f(a);
  let fb = f(b);
  for (let i = 0; i < mi; i++) {
    const denom = DD.subtract(fb, fa);
    if (Math.abs(DD.toDouble(denom)) < 1e-30) return null;
    const step = DD.multiply(fb, DD.subtract(b, a));
    const c = DD.subtract(b, DD.divide(step, denom));
    if (!isFiniteNumber(DD.toDouble(c))) return null;
    a = b;
    b = c;
    fa = fb;
    fb = f(b);
    const delta = DD.subtract(b, a);
    if (Math.abs(DD.toDouble(delta)) < DD.toDouble(t)) return b;
  }
  return b;
}

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================

function checkFn(fn, op) {
  if (typeof fn !== 'function') throw new DecodeError(op, 'fn must be a function');
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
}

function validateMatrix(m, op) {
  if (!m || typeof m !== 'object') throw new DecodeError(op, 'matrix required');
  if (typeof m.rows !== 'number' || typeof m.cols !== 'number') throw new DecodeError(op, 'rows/cols required');
  if (m.rows <= 0 || m.cols <= 0) throw new DecodeError(op, 'rows/cols must be positive');
  if (!m.data || typeof m.data.length !== 'number') throw new DecodeError(op, 'data required');
  if (m.data.length !== m.rows * m.cols) throw new DecodeError(op, 'data length mismatch');
  return m;
}

export const RootInput = Object.freeze({
  make(f, a, b, opts) { return { f, a, b, opts }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('root', 'Expected {f, a, b, opts?}');
    checkFn(input.f, 'root');
    checkFinite(input.a, 'root', 'a');
    checkFinite(input.b, 'root', 'b');
    return input;
  }
});

export const PolyEvalInput = Object.freeze({
  make(coefficients, x) { return { coefficients, x }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('polyEval', 'Expected {coefficients, x}');
    checkArrayLike(input.coefficients, 'polyEval', 'coefficients');
    checkFinite(input.x, 'polyEval', 'x');
    return input;
  }
});

export const InterpolateInput = Object.freeze({
  make(xs, ys, x) { return { xs, ys, x }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('interpolate', 'Expected {xs, ys, x}');
    checkArrayLike(input.xs, 'interpolate', 'xs');
    checkArrayLike(input.ys, 'interpolate', 'ys');
    if (input.xs.length !== input.ys.length) throw new DecodeError('interpolate', 'xs/ys length mismatch');
    if (input.x !== undefined) checkFinite(input.x, 'interpolate', 'x');
    return input;
  }
});

export const DerivativeInput = Object.freeze({
  make(f, x, h) { return { f, x, h }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('derivative', 'Expected {f, x, h?}');
    checkFn(input.f, 'derivative');
    checkFinite(input.x, 'derivative', 'x');
    return input;
  }
});

export const IntegrateInput = Object.freeze({
  make(f, a, b, opts) { return { f, a, b, opts }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('integrate', 'Expected {f, a, b, opts?}');
    checkFn(input.f, 'integrate');
    checkFinite(input.a, 'integrate', 'a');
    checkFinite(input.b, 'integrate', 'b');
    return input;
  }
});

export const LinearSolveInput = Object.freeze({
  make(A, b, opts) { return { A, b, opts }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('linearSolve', 'Expected {A, b, opts?}');
    validateMatrix(input.A, 'linearSolve');
    checkArrayLike(input.b, 'linearSolve', 'b');
    if (input.A.rows !== input.b.length) throw new DecodeError('linearSolve', 'A.rows !== b.length');
    return input;
  }
});

export const SplineInput = InterpolateInput;

export const PadeInput = Object.freeze({
  make(taylorCoeffs, p, q) { return { taylorCoeffs, p, q }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('pade', 'Expected {taylorCoeffs, p, q}');
    checkArrayLike(input.taylorCoeffs, 'pade', 'taylorCoeffs');
    if (!Number.isInteger(input.p) || input.p < 0) throw new DecodeError('pade', 'p must be non-negative integer');
    if (!Number.isInteger(input.q) || input.q < 0) throw new DecodeError('pade', 'q must be non-negative integer');
    return input;
  }
});

export const ContinuedFractionInput = Object.freeze({
  make(a, b, x, opts) { return { a, b, x, opts }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('continuedFraction', 'Expected {a, b, x, opts?}');
    checkFn(input.a, 'continuedFraction');
    checkFn(input.b, 'continuedFraction');
    checkFinite(input.x, 'continuedFraction', 'x');
    return input;
  }
});

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================

export function bisectionValidated(input) {
  const d = RootInput.decode(input);
  const opts = d.opts || {};
  return bisection(d.f, d.a, d.b, opts.tol, opts.maxIter);
}

export function newtonRaphsonValidated(input) {
  const d = RootInput.decode(input);
  if (typeof input.df !== 'function') throw new DecodeError('newtonRaphson', 'df must be function');
  const opts = d.opts || {};
  return newtonRaphson(d.f, input.df, d.a, opts.tol, opts.maxIter);
}

export function secantValidated(input) {
  const d = RootInput.decode(input);
  const opts = d.opts || {};
  return secant(d.f, d.a, d.b, opts.tol, opts.maxIter);
}

export function brentValidated(input) {
  const d = RootInput.decode(input);
  const opts = d.opts || {};
  return brent(d.f, d.a, d.b, opts.tol, opts.maxIter);
}

export function polyEvalValidated(input) {
  const d = PolyEvalInput.decode(input);
  return polyEval(d.coefficients, d.x);
}

export function lagrangeInterpValidated(input) {
  const d = InterpolateInput.decode(input);
  return lagrangeInterp(d.xs, d.ys, d.x);
}

export function newtonInterpValidated(input) {
  const d = InterpolateInput.decode(input);
  const coef = newtonDividedDifferences(d.xs, d.ys);
  return newtonInterp(d.xs, coef, d.x);
}

export function cubicSplineValidated(input) {
  const d = SplineInput.decode(input);
  const spline = cubicSpline(d.xs, d.ys);
  if (d.x !== undefined) return cubicSplineEval(spline, d.x);
  return spline;
}

export function derivativeValidated(input) {
  const d = DerivativeInput.decode(input);
  return derivativeCentral(d.f, d.x, d.h);
}

export function integrateValidated(input) {
  const d = IntegrateInput.decode(input);
  const opts = d.opts || {};
  const method = opts.method || 'adaptive';
  if (method === 'simpson') return integrateSimpson(d.f, d.a, d.b, opts.n);
  if (method === 'romberg') return integrateRomberg(d.f, d.a, d.b, opts.tol, opts.maxIter);
  if (method === 'gauss') return integrateGaussLegendre(d.f, d.a, d.b, opts.order);
  if (method === 'tanh-sinh') return integrateTanhSinh(d.f, d.a, d.b, opts.levels);
  return integrateAdaptiveSimpson(d.f, d.a, d.b, opts.tol, opts.maxDepth);
}

export function linearSolveValidated(input) {
  const d = LinearSolveInput.decode(input);
  const opts = d.opts || {};
  const method = opts.method || 'direct';
  if (method === 'jacobi') return jacobiSolve(d.A, d.b, opts.x0, opts.tol, opts.maxIter);
  if (method === 'gauss-seidel') return gaussSeidelSolve(d.A, d.b, opts.x0, opts.tol, opts.maxIter);
  if (method === 'sor') return sorSolve(d.A, d.b, opts.omega, opts.x0, opts.tol, opts.maxIter);
  if (method === 'cg') return conjugateGradientSolve(d.A, d.b, opts.x0, opts.tol, opts.maxIter);
  return LA.solveLinear(d.A, d.b);
}

export function padeValidated(input) {
  const d = PadeInput.decode(input);
  return padeApprox(d.taylorCoeffs, d.p, d.q);
}

export function continuedFractionValidated(input) {
  const d = ContinuedFractionInput.decode(input);
  const opts = d.opts || {};
  return continuedFraction(d.a, d.b, d.x, opts.tol, opts.maxIter);
}

// ============================================================================
// POLICY-AWARE WRAPPERS
// ============================================================================

export function bisectionWithPolicies(f, a, b, policy, opts) {
  const o = opts || {};
  return policyScalar(
    'Numeric.bisectionWithPolicies',
    () => bisection(f, a, b, o.tol, o.maxIter),
    (msg) => new DomainViolationError('bisectionWithPolicies', msg),
    (r) => ({ a, b, root: String(r) }),
    policy
  );
}

export function brentWithPolicies(f, a, b, policy, opts) {
  const o = opts || {};
  return policyScalar(
    'Numeric.brentWithPolicies',
    () => brent(f, a, b, o.tol, o.maxIter),
    (msg) => new DomainViolationError('brentWithPolicies', msg),
    (r) => ({ a, b, root: String(r) }),
    policy
  );
}

export function polyEvalWithPolicies(coefficients, x, policy) {
  return policyScalar(
    'Numeric.polyEvalWithPolicies',
    () => polyEval(coefficients, x),
    (msg) => new DomainViolationError('polyEvalWithPolicies', msg),
    (r) => ({ degree: coefficients.length - 1, x, result: String(r) }),
    policy
  );
}

export function derivativeWithPolicies(f, x, policy, h) {
  return policyScalar(
    'Numeric.derivativeWithPolicies',
    () => derivativeCentral(f, x, h),
    (msg) => new DomainViolationError('derivativeWithPolicies', msg),
    (r) => ({ x, result: String(r) }),
    policy
  );
}

export function integrateWithPolicies(f, a, b, policy, opts) {
  return policyScalar(
    'Numeric.integrateWithPolicies',
    () => integrateValidated({ f, a, b, opts }),
    (msg) => new DomainViolationError('integrateWithPolicies', msg),
    (r) => ({ a, b, result: String(r) }),
    policy
  );
}

export function linearSolveWithPolicies(A, b, policy, opts) {
  return policyCustom(
    'Numeric.linearSolveWithPolicies',
    () => linearSolveValidated({ A, b, opts }),
    (r) => r === null || isFiniteArray(r),
    (msg) => new DomainViolationError('linearSolveWithPolicies', msg),
    (r) => ({ status: r === null ? 'failed' : 'ok', size: r ? r.length : 0 }),
    policy
  );
}

export function cubicSplineWithPolicies(xs, ys, policy, x) {
  return policyCustom(
    'Numeric.cubicSplineWithPolicies',
    () => {
      const s = cubicSpline(xs, ys);
      return x !== undefined ? cubicSplineEval(s, x) : s;
    },
    (r) => (typeof r === 'number' ? isFiniteNumber(r) : r && typeof r === 'object'),
    (msg) => new DomainViolationError('cubicSplineWithPolicies', msg),
    (r) => ({ n: xs.length, x: x !== undefined ? x : 'series' }),
    policy
  );
}

// ============================================================================
// POOL
// ============================================================================
const _scratchPool = [];
const _MAX_SCRATCH_POOL = 32;

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
  if (_scratchPool.length >= _MAX_SCRATCH_POOL) return;
  _scratchPool.push(s);
}

export function poolReset() {
  _scratchPool.length = 0;
}

export function poolSize() {
  return _scratchPool.length;
}

// ============================================================================
// EXPORTS
// ============================================================================
export { EPSILON, PRECISION, HELPERS, DD, LA, RANDOM };

export default {
  DecodeError,
  DomainViolationError,
  sign,
  copysign,
  hypot3,
  log1p,
  expm1,
  safeDiv,
  safeLog,
  safeSqrt,
  clamp,
  mix,
  smoothstep,
  smootherstep,
  kahanSum,
  neumaierSum,
  pairwiseSum,
  bisection,
  newtonRaphson,
  secant,
  brent,
  fixedPoint,
  polyEval,
  polyDerivative,
  polySyntheticDivision,
  polyDeflate,
  durandKerner,
  realPolyRoots,
  lagrangeInterp,
  barycentricInterp,
  barycentricWeights,
  newtonDividedDifferences,
  newtonInterp,
  catmullRom,
  cubicSpline,
  cubicSplineEval,
  aitkenExtrapolate,
  richardsonExtrapolate,
  derivativeCentral,
  derivativeForward,
  derivativeBackward,
  derivativeSecond,
  nthDerivative,
  integrateSimpson,
  integrateAdaptiveSimpson,
  integrateRomberg,
  integrateGaussLegendre,
  integrateTanhSinh,
  continuedFraction,
  padeApprox,
  padeEvaluate,
  jacobiSolve,
  gaussSeidelSolve,
  sorSolve,
  conjugateGradientSolve,
  ddKahanSum,
  ddPolyEval,
  ddSecant,
  RootInput,
  PolyEvalInput,
  InterpolateInput,
  DerivativeInput,
  IntegrateInput,
  LinearSolveInput,
  SplineInput,
  PadeInput,
  ContinuedFractionInput,
  bisectionValidated,
  newtonRaphsonValidated,
  secantValidated,
  brentValidated,
  polyEvalValidated,
  lagrangeInterpValidated,
  newtonInterpValidated,
  cubicSplineValidated,
  derivativeValidated,
  integrateValidated,
  linearSolveValidated,
  padeValidated,
  continuedFractionValidated,
  bisectionWithPolicies,
  brentWithPolicies,
  polyEvalWithPolicies,
  derivativeWithPolicies,
  integrateWithPolicies,
  linearSolveWithPolicies,
  cubicSplineWithPolicies,
  poolAcquireScratch,
  poolReleaseScratch,
  poolReset,
  poolSize
};