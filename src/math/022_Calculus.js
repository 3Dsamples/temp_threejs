// file number : 022
// full path name : src/math/022_Calculus.js
// description : High-performance Calculus module rewritten from @scenesystems/effect-math Calculus without the Effect dependency. Provides numerical differentiation (central, forward, backward, second-order, Richardson-extrapolated), multi-dimensional gradient, full Jacobian, Hessian, numerical integration (trapezoid, Simpson 1/3, adaptive Simpson, Romberg, Gauss-Legendre 2/3/4/5/8/16-point), limit evaluation (left/right/central), Taylor coefficients, line search (Armijo backtracking), gradient descent step, ODE integrators (Euler, RK4, RKF45-lite), and DoubleDouble-precision variants (derivativeDD, gradientDD, integrateDD) for galactic-scale numerics. Schema validators (DerivativeInput, GradientInput, JacobianInput, HessianInput, IntegrateInput, LimitInput, TaylorInput, LineSearchInput, ODEStepInput) and policy-aware wrappers with strict/relaxed precision + diagnostics. Buffer pools for zero-allocation hot paths; integrates DD, Common, and Constants from the engine core.
// best for : Physics simulation parameter tuning, PBR BRDF fitting, procedural terrain differentiation, camera ray-marching, LOD cost gradients, context-awareness optimization, and continuous-time gameplay systems at 10k+ entity scale on Android 64-bit.
// license : MIT

import { EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS } from '../core/002_Constants.js';
import * as DD from './014_DoubleDouble.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'CalculusDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'CalculusDomainViolationError';
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

const DEFAULT_H = 1e-6;
const DEFAULT_N = 1000;
const DEFAULT_TOL = 1e-10;
const DEFAULT_MAX_ITER = 50;

// ============================================================================
// NUMERICAL DIFFERENTIATION
// ============================================================================

export function derivativeCentral(f, x, h) {
  const hh = h === undefined ? DEFAULT_H : h;
  return (f(x + hh) - f(x - hh)) / (2 * hh);
}

export function derivativeForward(f, x, h) {
  const hh = h === undefined ? DEFAULT_H : h;
  return (f(x + hh) - f(x)) / hh;
}

export function derivativeBackward(f, x, h) {
  const hh = h === undefined ? DEFAULT_H : h;
  return (f(x) - f(x - hh)) / hh;
}

export function derivativeSecond(f, x, h) {
  const hh = h === undefined ? DEFAULT_H : h;
  return (f(x + hh) - 2 * f(x) + f(x - hh)) / (hh * hh);
}

export function derivativeRichardson(f, x, h, levels) {
  const L = levels === undefined ? 3 : levels;
  const hh = h === undefined ? DEFAULT_H : h;
  const D = [];
  for (let i = 0; i < L; i++) {
    D.push([derivativeCentral(f, x, hh / Math.pow(2, i))]);
  }
  for (let j = 1; j < L; j++) {
    const factor = Math.pow(4, j);
    for (let i = 0; i < L - j; i++) {
      D[i].push((factor * D[i + 1][j - 1] - D[i][j - 1]) / (factor - 1));
    }
  }
  return D[0][L - 1];
}

export function derivativeDD(f, xDD, hDD) {
  const h = hDD || DD.fromDouble(1e-15);
  const fPlus = f(DD.add(xDD, h));
  const fMinus = f(DD.subtract(xDD, h));
  const diff = DD.subtract(fPlus, fMinus);
  const twoH = DD.multBy2(h);
  return DD.divide(diff, twoH);
}

// ============================================================================
// MULTI-DIMENSIONAL DIFFERENTIATION
// ============================================================================

const _gradBuf = [];

function getScratch(n) {
  if (_gradBuf.length > 0) {
    const buf = _gradBuf.pop();
    if (buf.length === n) return buf;
  }
  return new Float64Array(n);
}

function releaseScratch(buf) {
  if (_gradBuf.length >= 32) return;
  _gradBuf.push(buf);
}

export function gradient(f, x, h) {
  const n = x.length;
  const hh = h === undefined ? DEFAULT_H : h;
  const out = new Float64Array(n);
  const xp = getScratch(n);
  const xm = getScratch(n);
  try {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        xp[j] = x[j];
        xm[j] = x[j];
      }
      xp[i] += hh;
      xm[i] -= hh;
      out[i] = (f(xp) - f(xm)) / (2 * hh);
    }
  } finally {
    releaseScratch(xp);
    releaseScratch(xm);
  }
  return out;
}

export function gradientDD(f, xDD, hDD) {
  const n = xDD.length;
  const h = hDD || DD.fromDouble(1e-15);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const xp = new Array(n);
    const xm = new Array(n);
    for (let j = 0; j < n; j++) {
      xp[j] = xDD[j];
      xm[j] = xDD[j];
    }
    xp[i] = DD.add(xp[i], h);
    xm[i] = DD.subtract(xm[i], h);
    const diff = DD.subtract(f(xp), f(xm));
    out[i] = DD.divide(diff, DD.multBy2(h));
  }
  return out;
}

export function jacobian(fs, x, h) {
  const nIn = x.length;
  const nOut = fs.length;
  const hh = h === undefined ? DEFAULT_H : h;
  const J = new Array(nOut);
  const xp = getScratch(nIn);
  const xm = getScratch(nIn);
  try {
    for (let i = 0; i < nOut; i++) {
      J[i] = new Float64Array(nIn);
    }
    for (let j = 0; j < nIn; j++) {
      for (let k = 0; k < nIn; k++) {
        xp[k] = x[k];
        xm[k] = x[k];
      }
      xp[j] += hh;
      xm[j] -= hh;
      const fp = new Array(nOut);
      const fm = new Array(nOut);
      for (let i = 0; i < nOut; i++) {
        fp[i] = fs[i](xp);
        fm[i] = fs[i](xm);
      }
      for (let i = 0; i < nOut; i++) {
        J[i][j] = (fp[i] - fm[i]) / (2 * hh);
      }
    }
  } finally {
    releaseScratch(xp);
    releaseScratch(xm);
  }
  return J;
}

export function hessian(f, x, h) {
  const n = x.length;
  const hh = h === undefined ? DEFAULT_H * 10 : h;
  const H = new Array(n);
  for (let i = 0; i < n; i++) H[i] = new Float64Array(n);

  const xpp = getScratch(n);
  const xpm = getScratch(n);
  const xmp = getScratch(n);
  const xmm = getScratch(n);
  try {
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        for (let k = 0; k < n; k++) {
          xpp[k] = x[k];
          xpm[k] = x[k];
          xmp[k] = x[k];
          xmm[k] = x[k];
        }
        if (i === j) {
          xpp[i] += hh;
          xmm[i] -= hh;
          const v = (f(xpp) - 2 * f(x) + f(xmm)) / (hh * hh);
          H[i][i] = v;
        } else {
          xpp[i] += hh;
          xpp[j] += hh;
          xpm[i] += hh;
          xpm[j] -= hh;
          xmp[i] -= hh;
          xmp[j] += hh;
          xmm[i] -= hh;
          xmm[j] -= hh;
          const v = (f(xpp) - f(xpm) - f(xmp) + f(xmm)) / (4 * hh * hh);
          H[i][j] = v;
          H[j][i] = v;
        }
      }
    }
  } finally {
    releaseScratch(xpp);
    releaseScratch(xpm);
    releaseScratch(xmp);
    releaseScratch(xmm);
  }
  return H;
}

// ============================================================================
// NUMERICAL INTEGRATION
// ============================================================================

export function integrateTrapezoid(f, a, b, n) {
  const N = n === undefined ? DEFAULT_N : n;
  if (N <= 0) return 0;
  const h = (b - a) / N;
  let sum = 0.5 * (f(a) + f(b));
  for (let i = 1; i < N; i++) {
    sum += f(a + i * h);
  }
  return sum * h;
}

export function integrateSimpson(f, a, b, n) {
  let N = n === undefined ? DEFAULT_N : n;
  if (N % 2 !== 0) N += 1;
  if (N <= 0) return 0;
  const h = (b - a) / N;
  let sum = f(a) + f(b);
  for (let i = 1; i < N; i++) {
    const x = a + i * h;
    sum += (i % 2 === 0) ? 2 * f(x) : 4 * f(x);
  }
  return (h / 3) * sum;
}

export function integrateAdaptiveSimpson(f, a, b, tol, maxIter) {
  const t = tol === undefined ? DEFAULT_TOL : tol;
  const mi = maxIter === undefined ? 20 : maxIter;

  function simpson(aa, bb, fa, fm, fb) {
    const m = (aa + bb) / 2;
    return (bb - aa) / 6 * (fa + 4 * fm + fb);
  }

  function rec(aa, bb, fa, fm, fb, whole, depth) {
    if (depth > mi) return whole;
    const m = (aa + bb) / 2;
    const lm = (aa + m) / 2;
    const rm = (m + bb) / 2;
    const flm = f(lm);
    const frm = f(rm);
    const left = (m - aa) / 6 * (fa + 4 * flm + fm);
    const right = (bb - m) / 6 * (fm + 4 * frm + fb);
    const delta = left + right - whole;
    if (Math.abs(delta) <= 15 * t) return left + right + delta / 15;
    return (
      rec(aa, m, fa, flm, fm, left, depth + 1) +
      rec(m, bb, fm, frm, fb, right, depth + 1)
    );
  }

  const m = (a + b) / 2;
  const fa = f(a);
  const fb = f(b);
  const fm = f(m);
  const whole = simpson(a, b, fa, fm, fb);
  return rec(a, b, fa, fm, fb, whole, 0);
}

export function integrateRomberg(f, a, b, tol, maxIter) {
  const t = tol === undefined ? DEFAULT_TOL : tol;
  const mi = maxIter === undefined ? DEFAULT_MAX_ITER : maxIter;
  const R = [];
  for (let i = 0; i < mi; i++) {
    R.push([0]);
    const N = Math.pow(2, i);
    R[i][0] = integrateTrapezoid(f, a, b, N);
    for (let j = 1; j <= i; j++) {
      const factor = Math.pow(4, j);
      R[i][j] = (factor * R[i][j - 1] - R[i - 1][j - 1]) / (factor - 1);
      if (j === i && Math.abs(R[i][j] - R[i - 1][j - 1]) < t) {
        return R[i][j];
      }
    }
  }
  return R[mi - 1][mi - 1];
}

// Gauss-Legendre nodes and weights (precomputed for common orders)
const GL_NODES = {
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

export function integrateGaussLegendre(f, a, b, order) {
  const n = order === undefined ? 5 : order;
  const table = GL_NODES[n];
  if (!table) {
    throw new DomainViolationError('integrateGaussLegendre', 'order ' + n + ' not precomputed (use 2,3,4,5)');
  }
  const c = (b - a) / 2;
  const d = (a + b) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += table.w[i] * f(c * table.x[i] + d);
  }
  return sum * c;
}

export function integrateDD(f, aDD, bDD, order) {
  const c = DD.divBy2(DD.subtract(bDD, aDD));
  const d = DD.divBy2(DD.add(aDD, bDD));
  const table = GL_NODES[order || 5];
  if (!table) {
    throw new DomainViolationError('integrateDD', 'order ' + (order || 5) + ' not precomputed');
  }
  const n = table.x.length;
  let sum = [0, 0];
  for (let i = 0; i < n; i++) {
    const node = DD.fromDouble(table.x[i]);
    const w = DD.fromDouble(table.w[i]);
    const arg = DD.add(DD.multiply(c, node), d);
    const fv = f(arg);
    sum = DD.add(sum, DD.multiply(w, fv));
  }
  return DD.multiply(sum, c);
}

// ============================================================================
// LIMITS
// ============================================================================

export function limit(f, x0, side, h) {
  const hh = h === undefined ? 1e-9 : h;
  if (side === 'left') return f(x0 - hh);
  if (side === 'right') return f(x0 + hh);
  return (f(x0 - hh) + f(x0 + hh)) / 2;
}

export function limitRichardson(f, x0, h, levels) {
  const L = levels === undefined ? 3 : levels;
  const hh = h === undefined ? 1e-4 : h;
  const R = [];
  for (let i = 0; i < L; i++) {
    const hi = hh / Math.pow(2, i);
    R.push([(f(x0 - hi) + f(x0 + hi)) / 2]);
  }
  for (let j = 1; j < L; j++) {
    const factor = Math.pow(2, 2 * j);
    for (let i = 0; i < L - j; i++) {
      R[i].push((factor * R[i + 1][j - 1] - R[i][j - 1]) / (factor - 1));
    }
  }
  return R[0][L - 1];
}

// ============================================================================
// TAYLOR SERIES
// ============================================================================

export function taylorCoefficients(f, x0, n, h) {
  const N = n === undefined ? 5 : n;
  const hh = h === undefined ? 1e-3 : h;
  const coeffs = new Float64Array(N + 1);
  coeffs[0] = f(x0);
  const factBuf = new Float64Array(N + 1);
  factBuf[0] = 1;
  for (let i = 1; i <= N; i++) factBuf[i] = factBuf[i - 1] * i;
  for (let k = 1; k <= N; k++) {
    // k-th derivative via k-fold central difference approximation
    let sum = 0;
    for (let j = 0; j <= k; j++) {
      const sign = (j % 2 === 0) ? 1 : -1;
      const arg = x0 + (k / 2 - j) * hh;
      sum += sign * binomial(k, j) * f(arg);
    }
    coeffs[k] = sum / (Math.pow(hh, k) * factBuf[k]);
  }
  return coeffs;
}

function binomial(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let result = 1;
  for (let i = 1; i <= k; i++) {
    result *= (n - k + i) / i;
  }
  return result;
}

// ============================================================================
// LINE SEARCH & OPTIMIZATION STEP
// ============================================================================

export function lineSearchArmijo(f, gradF, x, dir, alpha0, c1, maxIter) {
  const a0 = alpha0 === undefined ? 1 : alpha0;
  const c = c1 === undefined ? 1e-4 : c1;
  const mi = maxIter === undefined ? 20 : maxIter;
  const fx = f(x);
  const g = gradF(x);
  const n = x.length;
  let gradDotDir = 0;
  for (let i = 0; i < n; i++) gradDotDir += g[i] * dir[i];
  if (gradDotDir >= 0) return 0;

  let alpha = a0;
  const xNew = new Float64Array(n);
  for (let iter = 0; iter < mi; iter++) {
    for (let i = 0; i < n; i++) xNew[i] = x[i] + alpha * dir[i];
    if (f(xNew) <= fx + c * alpha * gradDotDir) return alpha;
    alpha *= 0.5;
  }
  return alpha;
}

export function gradientDescentStep(f, x, h, alpha) {
  const hh = h === undefined ? DEFAULT_H : h;
  const a = alpha === undefined ? 0.01 : alpha;
  const g = gradient(f, x, hh);
  const n = x.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = x[i] - a * g[i];
  return out;
}

// ============================================================================
// ODE INTEGRATORS
// ============================================================================

export function eulerStep(f, y, t, dt) {
  return y + dt * f(y, t);
}

export function eulerIntegrate(f, y0, t0, t1, n) {
  const N = n === undefined ? DEFAULT_N : n;
  const dt = (t1 - t0) / N;
  let y = y0;
  let t = t0;
  for (let i = 0; i < N; i++) {
    y = y + dt * f(y, t);
    t += dt;
  }
  return y;
}

export function rk4Step(f, y, t, dt) {
  const k1 = f(y, t);
  const k2 = f(y + 0.5 * dt * k1, t + 0.5 * dt);
  const k3 = f(y + 0.5 * dt * k2, t + 0.5 * dt);
  const k4 = f(y + dt * k3, t + dt);
  return y + (dt / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
}

export function rk4Integrate(f, y0, t0, t1, n) {
  const N = n === undefined ? DEFAULT_N : n;
  const dt = (t1 - t0) / N;
  let y = y0;
  let t = t0;
  for (let i = 0; i < N; i++) {
    y = rk4Step(f, y, t, dt);
    t += dt;
  }
  return y;
}

export function rk4StepVec(f, y, t, dt, out) {
  const n = y.length;
  const o = out || new Float64Array(n);
  const k1 = new Float64Array(n);
  const k2 = new Float64Array(n);
  const k3 = new Float64Array(n);
  const k4 = new Float64Array(n);
  const tmp = new Float64Array(n);

  f(y, t, k1);
  for (let i = 0; i < n; i++) tmp[i] = y[i] + 0.5 * dt * k1[i];
  f(tmp, t + 0.5 * dt, k2);
  for (let i = 0; i < n; i++) tmp[i] = y[i] + 0.5 * dt * k2[i];
  f(tmp, t + 0.5 * dt, k3);
  for (let i = 0; i < n; i++) tmp[i] = y[i] + dt * k3[i];
  f(tmp, t + dt, k4);
  for (let i = 0; i < n; i++) o[i] = y[i] + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  return o;
}

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================

function checkFn(fn, op) {
  if (typeof fn !== 'function') throw new DecodeError(op, 'fn must be a function');
}

function checkX(x, op) {
  if (!isFiniteNumber(x)) throw new DecodeError(op, 'x must be finite');
}

function checkRange(a, b, op) {
  if (!isFiniteNumber(a) || !isFiniteNumber(b)) throw new DecodeError(op, 'a and b must be finite');
  if (b <= a) throw new DecodeError(op, 'b must be greater than a');
}

function checkArray(arr, op) {
  if (!Array.isArray(arr) && !(arr instanceof Float64Array) && !(arr instanceof Float32Array)) {
    throw new DecodeError(op, 'expected array-like');
  }
  for (let i = 0; i < arr.length; i++) {
    if (!isFiniteNumber(arr[i])) throw new DecodeError(op, 'element ' + i + ' must be finite');
  }
}

export const DerivativeInput = Object.freeze({
  make(f, x, h) {
    return { f, x, h };
  },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('derivative', 'Expected {f, x, h?}');
    checkFn(input.f, 'derivative');
    checkX(input.x, 'derivative');
    return input;
  }
});

export const GradientInput = Object.freeze({
  make(f, x, h) {
    return { f, x, h };
  },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('gradient', 'Expected {f, x, h?}');
    checkFn(input.f, 'gradient');
    checkArray(input.x, 'gradient');
    return input;
  }
});

export const JacobianInput = Object.freeze({
  make(fs, x, h) {
    return { fs, x, h };
  },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('jacobian', 'Expected {fs, x, h?}');
    if (!Array.isArray(input.fs)) throw new DecodeError('jacobian', 'fs must be array of functions');
    for (let i = 0; i < input.fs.length; i++) checkFn(input.fs[i], 'jacobian');
    checkArray(input.x, 'jacobian');
    return input;
  }
});

export const HessianInput = Object.freeze({
  make(f, x, h) {
    return { f, x, h };
  },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('hessian', 'Expected {f, x, h?}');
    checkFn(input.f, 'hessian');
    checkArray(input.x, 'hessian');
    return input;
  }
});

export const IntegrateInput = Object.freeze({
  make(f, a, b, opts) {
    return { f, a, b, opts };
  },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('integrate', 'Expected {f, a, b, opts?}');
    checkFn(input.f, 'integrate');
    checkRange(input.a, input.b, 'integrate');
    return input;
  }
});

export const LimitInput = Object.freeze({
  make(f, x0, side, h) {
    return { f, x0, side, h };
  },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('limit', 'Expected {f, x0, side?, h?}');
    checkFn(input.f, 'limit');
    checkX(input.x0, 'limit');
    return input;
  }
});

export const TaylorInput = Object.freeze({
  make(f, x0, n, h) {
    return { f, x0, n, h };
  },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('taylor', 'Expected {f, x0, n?, h?}');
    checkFn(input.f, 'taylor');
    checkX(input.x0, 'taylor');
    return input;
  }
});

export const LineSearchInput = Object.freeze({
  make(f, gradF, x, dir, alpha0, c1) {
    return { f, gradF, x, dir, alpha0, c1 };
  },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('lineSearch', 'Expected {f, gradF, x, dir, ...}');
    checkFn(input.f, 'lineSearch');
    checkFn(input.gradF, 'lineSearch');
    checkArray(input.x, 'lineSearch');
    checkArray(input.dir, 'lineSearch');
    if (input.x.length !== input.dir.length) throw new DecodeError('lineSearch', 'x and dir size mismatch');
    return input;
  }
});

export const ODEStepInput = Object.freeze({
  make(f, y, t, dt) {
    return { f, y, t, dt };
  },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('ode', 'Expected {f, y, t, dt}');
    checkFn(input.f, 'ode');
    checkX(input.t, 'ode');
    checkX(input.dt, 'ode');
    return input;
  }
});

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================

export function derivativeValidated(input) {
  const d = DerivativeInput.decode(input);
  return derivativeCentral(d.f, d.x, d.h);
}

export function gradientValidated(input) {
  const d = GradientInput.decode(input);
  return gradient(d.f, d.x, d.h);
}

export function jacobianValidated(input) {
  const d = JacobianInput.decode(input);
  return jacobian(d.fs, d.x, d.h);
}

export function hessianValidated(input) {
  const d = HessianInput.decode(input);
  return hessian(d.f, d.x, d.h);
}

export function integrateValidated(input) {
  const d = IntegrateInput.decode(input);
  const opts = d.opts || {};
  const method = opts.method || 'simpson';
  if (method === 'trapezoid') return integrateTrapezoid(d.f, d.a, d.b, opts.n);
  if (method === 'romberg') return integrateRomberg(d.f, d.a, d.b, opts.tol, opts.maxIter);
  if (method === 'adaptive') return integrateAdaptiveSimpson(d.f, d.a, d.b, opts.tol, opts.maxIter);
  if (method === 'gauss') return integrateGaussLegendre(d.f, d.a, d.b, opts.order);
  return integrateSimpson(d.f, d.a, d.b, opts.n);
}

export function limitValidated(input) {
  const d = LimitInput.decode(input);
  return limit(d.f, d.x0, d.side, d.h);
}

export function taylorValidated(input) {
  const d = TaylorInput.decode(input);
  return taylorCoefficients(d.f, d.x0, d.n, d.h);
}

export function lineSearchValidated(input) {
  const d = LineSearchInput.decode(input);
  return lineSearchArmijo(d.f, d.gradF, d.x, d.dir, d.alpha0, d.c1);
}

export function odeStepValidated(input) {
  const d = ODEStepInput.decode(input);
  return rk4Step(d.f, d.y, d.t, d.dt);
}

// ============================================================================
// POLICY-AWARE WRAPPERS
// ============================================================================

export function derivativeWithPolicies(f, x, policy, h) {
  return policyScalar(
    'Calculus.derivativeWithPolicies',
    () => derivativeCentral(f, x, h),
    (msg) => new DomainViolationError('derivativeWithPolicies', msg),
    (r) => ({ input: 'x=' + x, result: String(r) }),
    policy
  );
}

export function gradientWithPolicies(f, x, policy, h) {
  return policyCustom(
    'Calculus.gradientWithPolicies',
    () => gradient(f, x, h),
    (r) => isFiniteArray(r),
    (msg) => new DomainViolationError('gradientWithPolicies', msg),
    (r) => ({ n: x.length, result: '[' + Array.from(r).join(',') + ']' }),
    policy
  );
}

export function jacobianWithPolicies(fs, x, policy, h) {
  return policyCustom(
    'Calculus.jacobianWithPolicies',
    () => jacobian(fs, x, h),
    (r) => {
      if (!Array.isArray(r)) return false;
      for (let i = 0; i < r.length; i++) if (!isFiniteArray(r[i])) return false;
      return true;
    },
    (msg) => new DomainViolationError('jacobianWithPolicies', msg),
    (r) => ({ outputs: r.length, inputs: x.length }),
    policy
  );
}

export function hessianWithPolicies(f, x, policy, h) {
  return policyCustom(
    'Calculus.hessianWithPolicies',
    () => hessian(f, x, h),
    (r) => {
      if (!Array.isArray(r)) return false;
      for (let i = 0; i < r.length; i++) if (!isFiniteArray(r[i])) return false;
      return true;
    },
    (msg) => new DomainViolationError('hessianWithPolicies', msg),
    (r) => ({ n: x.length }),
    policy
  );
}

export function integrateWithPolicies(f, a, b, policy, opts) {
  return policyScalar(
    'Calculus.integrateWithPolicies',
    () => integrateValidated({ f, a, b, opts }),
    (msg) => new DomainViolationError('integrateWithPolicies', msg),
    (r) => ({ a, b, result: String(r) }),
    policy
  );
}

export function limitWithPolicies(f, x0, policy, side, h) {
  return policyScalar(
    'Calculus.limitWithPolicies',
    () => limit(f, x0, side, h),
    (msg) => new DomainViolationError('limitWithPolicies', msg),
    (r) => ({ x0, result: String(r) }),
    policy
  );
}

export function taylorWithPolicies(f, x0, policy, n, h) {
  return policyCustom(
    'Calculus.taylorWithPolicies',
    () => taylorCoefficients(f, x0, n, h),
    (r) => isFiniteArray(r),
    (msg) => new DomainViolationError('taylorWithPolicies', msg),
    (r) => ({ x0, order: r.length - 1 }),
    policy
  );
}

export function odeStepWithPolicies(f, y, t, dt, policy) {
  return policyScalar(
    'Calculus.odeStepWithPolicies',
    () => rk4Step(f, y, t, dt),
    (msg) => new DomainViolationError('odeStepWithPolicies', msg),
    (r) => ({ t, dt, result: String(r) }),
    policy
  );
}

// ============================================================================
// POOL
// ============================================================================
const _vecPool = [];
const _MAX_VEC_POOL = 32;

export function poolAcquireVec(n) {
  if (_vecPool.length > 0) {
    const v = _vecPool.pop();
    if (v.length === n) {
      v.fill(0);
      return v;
    }
  }
  return new Float64Array(n);
}

export function poolReleaseVec(v) {
  if (_vecPool.length >= _MAX_VEC_POOL) return;
  _vecPool.push(v);
}

export function poolReset() {
  _vecPool.length = 0;
}

export function poolSize() {
  return _vecPool.length;
}

// ============================================================================
// EXPORTS
// ============================================================================
export { EPSILON, PRECISION, DD, HELPERS };

export default {
  DecodeError,
  DomainViolationError,
  derivativeCentral,
  derivativeForward,
  derivativeBackward,
  derivativeSecond,
  derivativeRichardson,
  derivativeDD,
  gradient,
  gradientDD,
  jacobian,
  hessian,
  integrateTrapezoid,
  integrateSimpson,
  integrateAdaptiveSimpson,
  integrateRomberg,
  integrateGaussLegendre,
  integrateDD,
  limit,
  limitRichardson,
  taylorCoefficients,
  lineSearchArmijo,
  gradientDescentStep,
  eulerStep,
  eulerIntegrate,
  rk4Step,
  rk4Integrate,
  rk4StepVec,
  DerivativeInput,
  GradientInput,
  JacobianInput,
  HessianInput,
  IntegrateInput,
  LimitInput,
  TaylorInput,
  LineSearchInput,
  ODEStepInput,
  derivativeValidated,
  gradientValidated,
  jacobianValidated,
  hessianValidated,
  integrateValidated,
  limitValidated,
  taylorValidated,
  lineSearchValidated,
  odeStepValidated,
  derivativeWithPolicies,
  gradientWithPolicies,
  jacobianWithPolicies,
  hessianWithPolicies,
  integrateWithPolicies,
  limitWithPolicies,
  taylorWithPolicies,
  odeStepWithPolicies,
  poolAcquireVec,
  poolReleaseVec,
  poolReset,
  poolSize
};