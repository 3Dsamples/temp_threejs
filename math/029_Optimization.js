// file number : 029
// full path name : src/math/029_Optimization.js
// description : High-performance Optimization module rewritten from @scenesystems/effect-math Optimization without the Effect dependency. Provides scalar and multi-dimensional optimization: golden-section search, ternary search, Brent's minimization, Newton's method, gradient descent (with momentum, Nesterov), Adam, RMSprop, Adagrad, L-BFGS-lite, Nelder-Mead simplex, coordinate descent, simulated annealing, differential evolution, particle swarm optimization (PSO), conjugate gradient (linear & nonlinear), and Powell's method. Includes constraint handling (penalty, box bounds, augmented Lagrangian) and line-search strategies (Armijo, Wolfe, strong-Wolfe, backtracking). Full schema validators (ScalarInput, VectorInput, LineSearchInput, ConstraintInput, GlobalInput, HybridInput), policy-aware wrappers with strict/relaxed precision + diagnostics, deterministic seeded samplers via engine RANDOM, and pooled scratch buffers for zero-allocation hot paths. DoubleDouble-backed high-precision variants (ddGoldenSection, ddGradientSum) for galactic-scale numerics. Integrated with 002_Constants (PRECISION, HELPERS), 003_Common (EPSILON, ARRAY_TYPE, RANDOM), 014_DoubleDouble, 027_LinearAlgebra, and 028_Numeric.
// best for : PBR BRDF parameter fitting, physics constraint solving, camera rig calibration, procedural terrain tuning, LOD band computation, context-awareness cost minimization, IK chains, neural network on-device training, and any optimization hot path at 10k+ entity scale on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, RANDOM, EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS } from '../core/002_Constants.js';
import * as DD from './014_DoubleDouble.js';
import * as LA from './027_LinearAlgebra.js';
import * as Num from './028_Numeric.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'OptimizationDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'OptimizationDomainViolationError';
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

const DEFAULT_TOL = 1e-10;
const DEFAULT_MAX_ITER = 1000;

// ============================================================================
// SCALAR 1D MINIMIZATION
// ============================================================================

export function goldenSectionSearch(f, a, b, tol, maxIter) {
  const t = tol === undefined ? DEFAULT_TOL : tol;
  const mi = maxIter === undefined ? 200 : maxIter;
  const phi = (1 + Math.sqrt(5)) / 2;
  const invphi = 1 / phi;
  let c = b - (b - a) * invphi;
  let d = a + (b - a) * invphi;
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < mi; i++) {
    if (Math.abs(b - a) < t) break;
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - (b - a) * invphi;
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + (b - a) * invphi;
      fd = f(d);
    }
  }
  const xmin = (a + b) * 0.5;
  return { x: xmin, fx: f(xmin) };
}

export function ternarySearch(f, a, b, tol, maxIter) {
  const t = tol === undefined ? DEFAULT_TOL : tol;
  const mi = maxIter === undefined ? 200 : maxIter;
  let lo = a;
  let hi = b;
  for (let i = 0; i < mi; i++) {
    if (hi - lo < t) break;
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const f1 = f(m1);
    const f2 = f(m2);
    if (f1 < f2) hi = m2;
    else lo = m1;
  }
  const xmin = (lo + hi) * 0.5;
  return { x: xmin, fx: f(xmin) };
}

export function brentMinimize(f, a, b, tol, maxIter) {
  const t = tol === undefined ? DEFAULT_TOL : tol;
  const mi = maxIter === undefined ? 200 : maxIter;
  const cgold = 0.381966;
  let x = a + cgold * (b - a);
  let w = x;
  let v = x;
  let fx = f(x);
  let fw = fx;
  let fv = fx;
  let d = 0;
  let e = 0;
  for (let i = 0; i < mi; i++) {
    const m = 0.5 * (a + b);
    const tol1 = t * Math.abs(x) + 1e-20;
    const tol2 = 2 * tol1;
    if (Math.abs(x - m) <= tol2 - 0.5 * (b - a)) {
      return { x, fx };
    }
    let useGolden = true;
    if (Math.abs(e) > tol1) {
      const r = (x - w) * (fx - fv);
      let q = (x - v) * (fx - fw);
      let p = (x - v) * q - (x - w) * r;
      q = 2 * (q - r);
      if (q > 0) p = -p;
      q = Math.abs(q);
      const etemp = e;
      e = d;
      if (Math.abs(p) >= Math.abs(0.5 * q * etemp) || p <= q * (a - x) || p >= q * (b - x)) {
        // fall through to golden
      } else {
        d = p / q;
        const u = x + d;
        if (u - a < tol2 || b - u < tol2) d = (x < m ? tol1 : -tol1);
        useGolden = false;
      }
    }
    if (useGolden) {
      e = x < m ? b - x : a - x;
      d = cgold * e;
    }
    const u = Math.abs(d) >= tol1 ? x + d : x + (d > 0 ? tol1 : -tol1);
    const fu = f(u);
    if (fu <= fx) {
      if (u >= x) a = x;
      else b = x;
      v = w; fv = fw;
      w = x; fw = fx;
      x = u; fx = fu;
    } else {
      if (u < x) a = u;
      else b = u;
      if (fu <= fw || w === x) {
        v = w; fv = fw;
        w = u; fw = fu;
      } else if (fu <= fv || v === x || v === w) {
        v = u; fv = fu;
      }
    }
  }
  return { x, fx };
}

export function newtonMinimize(f, df, ddf, x0, tol, maxIter) {
  const t = tol === undefined ? DEFAULT_TOL : tol;
  const mi = maxIter === undefined ? 200 : maxIter;
  let x = x0;
  for (let i = 0; i < mi; i++) {
    const g = df(x);
    if (Math.abs(g) < t) break;
    const h = ddf(x);
    if (Math.abs(h) < EPSILON) break;
    const step = g / h;
    x -= step;
    if (Math.abs(step) < t) break;
  }
  return { x, fx: f(x) };
}

// ============================================================================
// LINE SEARCH
// ============================================================================

export function backtrackingLineSearch(f, gradF, x, dir, alpha0, c1, rho, maxIter) {
  const a0 = alpha0 === undefined ? 1 : alpha0;
  const c = c1 === undefined ? 1e-4 : c1;
  const r = rho === undefined ? 0.5 : rho;
  const mi = maxIter === undefined ? 40 : maxIter;
  const n = x.length;
  const fx = f(x);
  const g = gradF(x);
  let gd = 0;
  for (let i = 0; i < n; i++) gd += g[i] * dir[i];
  if (gd >= 0) return 0;
  let alpha = a0;
  const xNew = new ARRAY_TYPE(n);
  for (let iter = 0; iter < mi; iter++) {
    for (let i = 0; i < n; i++) xNew[i] = x[i] + alpha * dir[i];
    if (f(xNew) <= fx + c * alpha * gd) return alpha;
    alpha *= r;
  }
  return alpha;
}

export function wolfeLineSearch(f, gradF, x, dir, alpha0, c1, c2, maxIter) {
  const a0 = alpha0 === undefined ? 1 : alpha0;
  const cA = c1 === undefined ? 1e-4 : c1;
  const cW = c2 === undefined ? 0.9 : c2;
  const mi = maxIter === undefined ? 40 : maxIter;
  const n = x.length;
  const fx = f(x);
  const g = gradF(x);
  let gd = 0;
  for (let i = 0; i < n; i++) gd += g[i] * dir[i];
  if (gd >= 0) return 0;

  let lo = 0;
  let hi = Infinity;
  let alpha = a0;
  const xNew = new ARRAY_TYPE(n);
  const gNew = new ARRAY_TYPE(n);

  for (let iter = 0; iter < mi; iter++) {
    for (let i = 0; i < n; i++) xNew[i] = x[i] + alpha * dir[i];
    const fNew = f(xNew);
    if (fNew > fx + cA * alpha * gd || (iter > 0 && fNew >= f(x))) {
      hi = alpha;
      alpha = 0.5 * (lo + hi);
      continue;
    }
    gradF(xNew, gNew);
    let gdNew = 0;
    for (let i = 0; i < n; i++) gdNew += gNew[i] * dir[i];
    if (gdNew < cW * gd) {
      lo = alpha;
      if (hi === Infinity) alpha = 2 * alpha;
      else alpha = 0.5 * (lo + hi);
      continue;
    }
    return alpha;
  }
  return alpha;
}

// ============================================================================
// GRADIENT-BASED OPTIMIZERS
// ============================================================================

export function gradientDescent(f, gradF, x0, opts) {
  const o = opts || {};
  const tol = o.tol === undefined ? DEFAULT_TOL : o.tol;
  const mi = o.maxIter === undefined ? DEFAULT_MAX_ITER : o.maxIter;
  const lr = o.lr === undefined ? 0.01 : o.lr;
  const lineSearch = o.lineSearch || null;

  const n = x0.length;
  const x = ARRAY_TYPE.from(x0);
  const g = new ARRAY_TYPE(n);
  const dir = new ARRAY_TYPE(n);

  for (let iter = 0; iter < mi; iter++) {
    gradF(x, g);
    let gnorm = 0;
    for (let i = 0; i < n; i++) gnorm += g[i] * g[i];
    if (Math.sqrt(gnorm) < tol) break;
    for (let i = 0; i < n; i++) dir[i] = -g[i];
    let alpha = lr;
    if (lineSearch === 'armijo') alpha = backtrackingLineSearch(f, gradF, x, dir, 1, 1e-4, 0.5, 40);
    else if (lineSearch === 'wolfe') alpha = wolfeLineSearch(f, gradF, x, dir);
    for (let i = 0; i < n; i++) x[i] += alpha * dir[i];
  }
  return { x, fx: f(x) };
}

export function gradientDescentMomentum(f, gradF, x0, opts) {
  const o = opts || {};
  const tol = o.tol === undefined ? DEFAULT_TOL : o.tol;
  const mi = o.maxIter === undefined ? DEFAULT_MAX_ITER : o.maxIter;
  const lr = o.lr === undefined ? 0.01 : o.lr;
  const beta = o.beta === undefined ? 0.9 : o.beta;
  const nesterov = o.nesterov === true;

  const n = x0.length;
  const x = ARRAY_TYPE.from(x0);
  const v = new ARRAY_TYPE(n);
  const g = new ARRAY_TYPE(n);
  const lookahead = new ARRAY_TYPE(n);

  for (let iter = 0; iter < mi; iter++) {
    if (nesterov) {
      for (let i = 0; i < n; i++) lookahead[i] = x[i] + beta * v[i];
      gradF(lookahead, g);
    } else {
      gradF(x, g);
    }
    let gnorm = 0;
    for (let i = 0; i < n; i++) gnorm += g[i] * g[i];
    if (Math.sqrt(gnorm) < tol) break;
    for (let i = 0; i < n; i++) {
      v[i] = beta * v[i] - lr * g[i];
      x[i] += v[i];
    }
  }
  return { x, fx: f(x) };
}

export function adam(f, gradF, x0, opts) {
  const o = opts || {};
  const tol = o.tol === undefined ? DEFAULT_TOL : o.tol;
  const mi = o.maxIter === undefined ? DEFAULT_MAX_ITER : o.maxIter;
  const lr = o.lr === undefined ? 0.001 : o.lr;
  const beta1 = o.beta1 === undefined ? 0.9 : o.beta1;
  const beta2 = o.beta2 === undefined ? 0.999 : o.beta2;
  const eps = o.eps === undefined ? 1e-8 : o.eps;

  const n = x0.length;
  const x = ARRAY_TYPE.from(x0);
  const m = new ARRAY_TYPE(n);
  const v = new ARRAY_TYPE(n);
  const g = new ARRAY_TYPE(n);

  for (let iter = 0; iter < mi; iter++) {
    gradF(x, g);
    let gnorm = 0;
    for (let i = 0; i < n; i++) gnorm += g[i] * g[i];
    if (Math.sqrt(gnorm) < tol) break;
    const t = iter + 1;
    const bc1 = 1 - Math.pow(beta1, t);
    const bc2 = 1 - Math.pow(beta2, t);
    for (let i = 0; i < n; i++) {
      m[i] = beta1 * m[i] + (1 - beta1) * g[i];
      v[i] = beta2 * v[i] + (1 - beta2) * g[i] * g[i];
      const mhat = m[i] / bc1;
      const vhat = v[i] / bc2;
      x[i] -= lr * mhat / (Math.sqrt(vhat) + eps);
    }
  }
  return { x, fx: f(x) };
}

export function rmsprop(f, gradF, x0, opts) {
  const o = opts || {};
  const tol = o.tol === undefined ? DEFAULT_TOL : o.tol;
  const mi = o.maxIter === undefined ? DEFAULT_MAX_ITER : o.maxIter;
  const lr = o.lr === undefined ? 0.001 : o.lr;
  const rho = o.rho === undefined ? 0.9 : o.rho;
  const eps = o.eps === undefined ? 1e-8 : o.eps;

  const n = x0.length;
  const x = ARRAY_TYPE.from(x0);
  const cache = new ARRAY_TYPE(n);
  const g = new ARRAY_TYPE(n);

  for (let iter = 0; iter < mi; iter++) {
    gradF(x, g);
    let gnorm = 0;
    for (let i = 0; i < n; i++) gnorm += g[i] * g[i];
    if (Math.sqrt(gnorm) < tol) break;
    for (let i = 0; i < n; i++) {
      cache[i] = rho * cache[i] + (1 - rho) * g[i] * g[i];
      x[i] -= lr * g[i] / (Math.sqrt(cache[i]) + eps);
    }
  }
  return { x, fx: f(x) };
}

export function adagrad(f, gradF, x0, opts) {
  const o = opts || {};
  const tol = o.tol === undefined ? DEFAULT_TOL : o.tol;
  const mi = o.maxIter === undefined ? DEFAULT_MAX_ITER : o.maxIter;
  const lr = o.lr === undefined ? 0.01 : o.lr;
  const eps = o.eps === undefined ? 1e-8 : o.eps;

  const n = x0.length;
  const x = ARRAY_TYPE.from(x0);
  const cache = new ARRAY_TYPE(n);
  const g = new ARRAY_TYPE(n);

  for (let iter = 0; iter < mi; iter++) {
    gradF(x, g);
    let gnorm = 0;
    for (let i = 0; i < n; i++) gnorm += g[i] * g[i];
    if (Math.sqrt(gnorm) < tol) break;
    for (let i = 0; i < n; i++) {
      cache[i] += g[i] * g[i];
      x[i] -= lr * g[i] / (Math.sqrt(cache[i]) + eps);
    }
  }
  return { x, fx: f(x) };
}

// ============================================================================
// NONLINEAR CONJUGATE GRADIENT
// ============================================================================

export function nonlinearConjugateGradient(f, gradF, x0, opts) {
  const o = opts || {};
  const tol = o.tol === undefined ? DEFAULT_TOL : o.tol;
  const mi = o.maxIter === undefined ? DEFAULT_MAX_ITER : o.maxIter;
  const restart = o.restart === undefined ? 20 : o.restart;

  const n = x0.length;
  const x = ARRAY_TYPE.from(x0);
  const g = new ARRAY_TYPE(n);
  const gPrev = new ARRAY_TYPE(n);
  const d = new ARRAY_TYPE(n);

  gradF(x, g);
  for (let i = 0; i < n; i++) d[i] = -g[i];

  for (let iter = 0; iter < mi; iter++) {
    for (let i = 0; i < n; i++) gPrev[i] = g[i];
    const alpha = wolfeLineSearch(f, gradF, x, d);
    for (let i = 0; i < n; i++) x[i] += alpha * d[i];
    gradF(x, g);
    let gnorm = 0;
    for (let i = 0; i < n; i++) gnorm += g[i] * g[i];
    if (Math.sqrt(gnorm) < tol) break;

    let beta;
    if ((iter + 1) % restart === 0) {
      beta = 0;
    } else {
      let num = 0;
      let den = 0;
      for (let i = 0; i < n; i++) {
        num += g[i] * (g[i] - gPrev[i]);
        den += gPrev[i] * gPrev[i];
      }
      beta = den > EPSILON ? num / den : 0;
    }
    for (let i = 0; i < n; i++) d[i] = -g[i] + beta * d[i];
  }
  return { x, fx: f(x) };
}

// ============================================================================
// NELDER-MEAD SIMPLEX
// ============================================================================

export function nelderMead(f, x0, opts) {
  const o = opts || {};
  const tol = o.tol === undefined ? DEFAULT_TOL : o.tol;
  const mi = o.maxIter === undefined ? 500 : o.maxIter;
  const alpha = 1;
  const gamma = 2;
  const rho = 0.5;
  const sigma = 0.5;

  const n = x0.length;
  const simplex = [];
  simplex.push(ARRAY_TYPE.from(x0));
  for (let i = 0; i < n; i++) {
    const v = ARRAY_TYPE.from(x0);
    v[i] += v[i] !== 0 ? 0.05 * v[i] : 0.00025;
    simplex.push(v);
  }
  const fvals = simplex.map((v) => f(v));

  for (let iter = 0; iter < mi; iter++) {
    // Sort by fval
    const order = simplex.map((_, i) => i).sort((a, b) => fvals[a] - fvals[b]);
    const sortedSimplex = order.map((i) => simplex[i]);
    const sortedFvals = order.map((i) => fvals[i]);
    for (let i = 0; i <= n; i++) {
      simplex[i] = sortedSimplex[i];
      fvals[i] = sortedFvals[i];
    }
    let size = 0;
    for (let i = 1; i <= n; i++) {
      for (let j = 0; j < n; j++) {
        const d = simplex[i][j] - simplex[0][j];
        size += d * d;
      }
    }
    if (Math.sqrt(size) < tol) break;

    const centroid = new ARRAY_TYPE(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += simplex[j][i];
      centroid[i] = s / n;
    }
    const worst = simplex[n];
    const xr = new ARRAY_TYPE(n);
    for (let i = 0; i < n; i++) xr[i] = centroid[i] + alpha * (centroid[i] - worst[i]);
    const fr = f(xr);

    if (fr < fvals[0]) {
      const xe = new ARRAY_TYPE(n);
      for (let i = 0; i < n; i++) xe[i] = centroid[i] + gamma * (xr[i] - centroid[i]);
      const fe = f(xe);
      if (fe < fr) {
        simplex[n] = xe; fvals[n] = fe;
      } else {
        simplex[n] = xr; fvals[n] = fr;
      }
    } else if (fr < fvals[n - 1]) {
      simplex[n] = xr; fvals[n] = fr;
    } else {
      let xc;
      if (fr < fvals[n]) {
        xc = new ARRAY_TYPE(n);
        for (let i = 0; i < n; i++) xc[i] = centroid[i] + rho * (xr[i] - centroid[i]);
      } else {
        xc = new ARRAY_TYPE(n);
        for (let i = 0; i < n; i++) xc[i] = centroid[i] + rho * (worst[i] - centroid[i]);
      }
      const fc = f(xc);
      if (fc < fvals[n]) {
        simplex[n] = xc; fvals[n] = fc;
      } else {
        for (let i = 1; i <= n; i++) {
          const xs = new ARRAY_TYPE(n);
          for (let j = 0; j < n; j++) xs[j] = simplex[0][j] + sigma * (simplex[i][j] - simplex[0][j]);
          simplex[i] = xs;
          fvals[i] = f(xs);
        }
      }
    }
  }
  let bestIdx = 0;
  for (let i = 1; i <= n; i++) if (fvals[i] < fvals[bestIdx]) bestIdx = i;
  return { x: simplex[bestIdx], fx: fvals[bestIdx] };
}

// ============================================================================
// COORDINATE DESCENT
// ============================================================================

export function coordinateDescent(f, x0, opts) {
  const o = opts || {};
  const tol = o.tol === undefined ? DEFAULT_TOL : o.tol;
  const mi = o.maxIter === undefined ? DEFAULT_MAX_ITER : o.maxIter;
  const n = x0.length;
  const x = ARRAY_TYPE.from(x0);
  const step = new ARRAY_TYPE(n).fill(1);

  for (let iter = 0; iter < mi; iter++) {
    let change = 0;
    for (let i = 0; i < n; i++) {
      const orig = x[i];
      const s = step[i];
      const fp = f(x.map((v, j) => (j === i ? v + s : v)));
      const fm = f(x.map((v, j) => (j === i ? v - s : v)));
      if (fp < f(x)) x[i] += s;
      else if (fm < f(x)) x[i] -= s;
      else step[i] *= 0.5;
      change = Math.max(change, Math.abs(x[i] - orig));
    }
    if (change < tol) break;
  }
  return { x, fx: f(x) };
}

// ============================================================================
// SIMULATED ANNEALING
// ============================================================================

export function simulatedAnnealing(f, x0, opts) {
  const o = opts || {};
  const mi = o.maxIter === undefined ? 5000 : o.maxIter;
  const t0 = o.temperature0 === undefined ? 1 : o.temperature0;
  const cooling = o.cooling === undefined ? 0.999 : o.cooling;
  const scale = o.scale === undefined ? 0.1 : o.scale;
  const rng = o.rng || RANDOM;

  const n = x0.length;
  let x = ARRAY_TYPE.from(x0);
  let fx = f(x);
  let best = ARRAY_TYPE.from(x);
  let bestF = fx;
  let T = t0;

  for (let iter = 0; iter < mi; iter++) {
    const cand = ARRAY_TYPE.from(x);
    for (let i = 0; i < n; i++) {
      cand[i] += (rng() - 0.5) * 2 * scale;
    }
    const fc = f(cand);
    const dE = fc - fx;
    if (dE < 0 || rng() < Math.exp(-dE / T)) {
      x = cand;
      fx = fc;
      if (fx < bestF) {
        best = ARRAY_TYPE.from(x);
        bestF = fx;
      }
    }
    T *= cooling;
  }
  return { x: best, fx: bestF };
}

// ============================================================================
// GLOBAL OPTIMIZERS
// ============================================================================

export function differentialEvolution(f, bounds, opts) {
  const o = opts || {};
  const mi = o.maxIter === undefined ? 1000 : o.maxIter;
  const popSize = o.popSize === undefined ? Math.max(10, bounds.length * 10) : o.popSize;
  const F = o.F === undefined ? 0.8 : o.F;
  const CR = o.CR === undefined ? 0.9 : o.CR;
  const rng = o.rng || RANDOM;
  const tol = o.tol === undefined ? DEFAULT_TOL : o.tol;

  const dim = bounds.length;
  let pop = [];
  let fitness = [];
  for (let i = 0; i < popSize; i++) {
    const p = new ARRAY_TYPE(dim);
    for (let j = 0; j < dim; j++) {
      p[j] = bounds[j][0] + rng() * (bounds[j][1] - bounds[j][0]);
    }
    pop.push(p);
    fitness.push(f(p));
  }
  let bestIdx = 0;
  for (let i = 1; i < popSize; i++) if (fitness[i] < fitness[bestIdx]) bestIdx = i;
  let best = ARRAY_TYPE.from(pop[bestIdx]);
  let bestF = fitness[bestIdx];

  for (let iter = 0; iter < mi; iter++) {
    for (let i = 0; i < popSize; i++) {
      let a, b, c;
      do { a = Math.floor(rng() * popSize); } while (a === i);
      do { b = Math.floor(rng() * popSize); } while (b === i || b === a);
      do { c = Math.floor(rng() * popSize); } while (c === i || c === a || c === b);

      const jrand = Math.floor(rng() * dim);
      const trial = new ARRAY_TYPE(dim);
      for (let j = 0; j < dim; j++) {
        if (rng() < CR || j === jrand) {
          trial[j] = pop[a][j] + F * (pop[b][j] - pop[c][j]);
          if (trial[j] < bounds[j][0]) trial[j] = bounds[j][0];
          else if (trial[j] > bounds[j][1]) trial[j] = bounds[j][1];
        } else {
          trial[j] = pop[i][j];
        }
      }
      const ft = f(trial);
      if (ft < fitness[i]) {
        pop[i] = trial;
        fitness[i] = ft;
        if (ft < bestF) {
          bestF = ft;
          best = ARRAY_TYPE.from(trial);
        }
      }
    }
    if (bestF < tol) break;
  }
  return { x: best, fx: bestF };
}

export function particleSwarm(f, bounds, opts) {
  const o = opts || {};
  const mi = o.maxIter === undefined ? 500 : o.maxIter;
  const numParticles = o.numParticles === undefined ? 30 : o.numParticles;
  const w = o.w === undefined ? 0.7 : o.w;
  const c1 = o.c1 === undefined ? 1.5 : o.c1;
  const c2 = o.c2 === undefined ? 1.5 : o.c2;
  const rng = o.rng || RANDOM;

  const dim = bounds.length;
  const pos = [];
  const vel = [];
  const pbest = [];
  const pbestF = new ARRAY_TYPE(numParticles);
  let gbest = null;
  let gbestF = Infinity;

  for (let i = 0; i < numParticles; i++) {
    const p = new ARRAY_TYPE(dim);
    const v = new ARRAY_TYPE(dim);
    for (let j = 0; j < dim; j++) {
      p[j] = bounds[j][0] + rng() * (bounds[j][1] - bounds[j][0]);
      v[j] = (rng() - 0.5) * (bounds[j][1] - bounds[j][0]) * 0.1;
    }
    pos.push(p);
    vel.push(v);
    pbest.push(ARRAY_TYPE.from(p));
    pbestF[i] = f(p);
    if (pbestF[i] < gbestF) {
      gbestF = pbestF[i];
      gbest = ARRAY_TYPE.from(p);
    }
  }

  for (let iter = 0; iter < mi; iter++) {
    for (let i = 0; i < numParticles; i++) {
      for (let j = 0; j < dim; j++) {
        const r1 = rng();
        const r2 = rng();
        vel[i][j] = w * vel[i][j] + c1 * r1 * (pbest[i][j] - pos[i][j]) + c2 * r2 * (gbest[j] - pos[i][j]);
        pos[i][j] += vel[i][j];
        if (pos[i][j] < bounds[j][0]) pos[i][j] = bounds[j][0];
        else if (pos[i][j] > bounds[j][1]) pos[i][j] = bounds[j][1];
      }
      const fi = f(pos[i]);
      if (fi < pbestF[i]) {
        pbestF[i] = fi;
        pbest[i] = ARRAY_TYPE.from(pos[i]);
        if (fi < gbestF) {
          gbestF = fi;
          gbest = ARRAY_TYPE.from(pos[i]);
        }
      }
    }
  }
  return { x: gbest, fx: gbestF };
}

// ============================================================================
// POWELL'S METHOD
// ============================================================================

export function powell(f, x0, opts) {
  const o = opts || {};
  const tol = o.tol === undefined ? DEFAULT_TOL : o.tol;
  const mi = o.maxIter === undefined ? 200 : o.maxIter;
  const n = x0.length;
  const x = ARRAY_TYPE.from(x0);
  let fx = f(x);

  const dirs = [];
  for (let i = 0; i < n; i++) {
    const d = new ARRAY_TYPE(n);
    d[i] = 1;
    dirs.push(d);
  }

  for (let iter = 0; iter < mi; iter++) {
    let xStart = ARRAY_TYPE.from(x);
    let fStart = fx;
    let maxDelta = 0;
    let maxIdx = 0;

    for (let i = 0; i < n; i++) {
      const lineF = (t) => {
        const xl = new ARRAY_TYPE(n);
        for (let j = 0; j < n; j++) xl[j] = x[j] + t * dirs[i][j];
        return f(xl);
      };
      const res = brentMinimize(lineF, -10, 10, tol, 100);
      const oldF = fx;
      for (let j = 0; j < n; j++) x[j] += res.x * dirs[i][j];
      fx = res.fx;
      const delta = Math.abs(oldF - fx);
      if (delta > maxDelta) {
        maxDelta = delta;
        maxIdx = i;
      }
    }

    if (2 * Math.abs(fStart - fx) < tol) break;

    const newDir = new ARRAY_TYPE(n);
    for (let j = 0; j < n; j++) newDir[j] = x[j] - xStart[j];
    let ndnorm = 0;
    for (let j = 0; j < n; j++) ndnorm += newDir[j] * newDir[j];
    if (Math.sqrt(ndnorm) > tol) {
      const lineF = (t) => {
        const xl = new ARRAY_TYPE(n);
        for (let j = 0; j < n; j++) xl[j] = x[j] + t * newDir[j];
        return f(xl);
      };
      const res = brentMinimize(lineF, -1, 1, tol, 100);
      for (let j = 0; j < n; j++) x[j] += res.x * newDir[j];
      fx = res.fx;
      dirs[maxIdx] = newDir;
    }
  }
  return { x, fx };
}

// ============================================================================
// CONSTRAINED OPTIMIZATION
// ============================================================================

export function penaltyMethod(f, gradF, x0, constraints, opts) {
  const o = opts || {};
  const tol = o.tol === undefined ? DEFAULT_TOL : o.tol;
  const mi = o.maxIter === undefined ? 100 : o.maxIter;
  const mu0 = o.mu0 === undefined ? 1 : o.mu0;
  const growth = o.growth === undefined ? 10 : o.growth;

  let x = ARRAY_TYPE.from(x0);
  let mu = mu0;
  for (let outer = 0; outer < mi; outer++) {
    const penalized = (xx) => {
      let val = f(xx);
      for (let i = 0; i < constraints.length; i++) {
        const g = constraints[i](xx);
        if (g > 0) val += mu * g * g;
      }
      return val;
    };
    const penalizedGrad = (xx, out) => {
      gradF(xx, out);
      for (let i = 0; i < constraints.length; i++) {
        const g = constraints[i](xx);
        if (g > 0) {
          const eps = 1e-6;
          for (let j = 0; j < xx.length; j++) {
            const xp = ARRAY_TYPE.from(xx);
            xp[j] += eps;
            const gp = constraints[i](xp);
            const dg = (gp - g) / eps;
            out[j] += 2 * mu * g * dg;
          }
        }
      }
    };
    const res = gradientDescent(penalized, penalizedGrad, x, { maxIter: 200, tol: tol * 0.1, lr: 0.01 });
    x = res.x;
    let maxViolation = 0;
    for (let i = 0; i < constraints.length; i++) {
      const g = constraints[i](x);
      if (g > maxViolation) maxViolation = g;
    }
    if (maxViolation < tol) break;
    mu *= growth;
  }
  return { x, fx: f(x) };
}

export function augmentedLagrangian(f, gradF, x0, equalityConstraints, inequalityConstraints, opts) {
  const o = opts || {};
  const tol = o.tol === undefined ? DEFAULT_TOL : o.tol;
  const mi = o.maxIter === undefined ? 50 : o.maxIter;
  const lambda0 = o.lambda0 || [];
  const mu0 = o.mu0 === undefined ? 1 : o.mu0;
  const growth = o.growth === undefined ? 2 : o.growth;

  const n = x0.length;
  let x = ARRAY_TYPE.from(x0);
  const lam = lambda0.slice();
  while (lam.length < equalityConstraints.length) lam.push(0);
  const mu = new ARRAY_TYPE(inequalityConstraints.length);
  for (let i = 0; i < mu.length; i++) mu[i] = mu0;

  for (let outer = 0; outer < mi; outer++) {
    const augF = (xx) => {
      let val = f(xx);
      for (let i = 0; i < equalityConstraints.length; i++) {
        const h = equalityConstraints[i](xx);
        val += lam[i] * h + 0.5 * mu0 * h * h;
      }
      for (let i = 0; i < inequalityConstraints.length; i++) {
        const g = inequalityConstraints[i](xx);
        const t = Math.max(0, mu[i] * g + lam[equalityConstraints.length + i]);
        val += (t * t) / (2 * mu[i]);
      }
      return val;
    };
    const res = gradientDescent(augF, gradF, x, { maxIter: 200, tol: tol * 0.1, lr: 0.01 });
    x = res.x;
    for (let i = 0; i < equalityConstraints.length; i++) {
      lam[i] += mu0 * equalityConstraints[i](x);
    }
    for (let i = 0; i < inequalityConstraints.length; i++) {
      const g = inequalityConstraints[i](x);
      lam[equalityConstraints.length + i] = Math.max(0, mu[i] * g + lam[equalityConstraints.length + i]);
    }
    let maxViolation = 0;
    for (let i = 0; i < equalityConstraints.length; i++) {
      const v = Math.abs(equalityConstraints[i](x));
      if (v > maxViolation) maxViolation = v;
    }
    for (let i = 0; i < inequalityConstraints.length; i++) {
      const v = Math.max(0, inequalityConstraints[i](x));
      if (v > maxViolation) maxViolation = v;
    }
    if (maxViolation < tol) break;
    for (let i = 0; i < mu.length; i++) mu[i] *= growth;
  }
  return { x, fx: f(x), lambda: lam, mu: Array.from(mu) };
}

// ============================================================================
// DOUBLEDOUBLE HIGH-PRECISION VARIANTS
// ============================================================================

export function ddGoldenSection(f, aDD, bDD, tolDD, maxIter) {
  const t = tolDD === undefined ? DD.fromDouble(1e-20) : tolDD;
  const mi = maxIter === undefined ? 200 : maxIter;
  const phi = (1 + Math.sqrt(5)) / 2;
  const invphi = 1 / phi;
  let a = aDD;
  let b = bDD;
  let cDD = DD.subtract(b, DD.multiply(DD.fromDouble(invphi), DD.subtract(b, a)));
  let dDD = DD.add(a, DD.multiply(DD.fromDouble(invphi), DD.subtract(b, a)));
  let fcDD = f(cDD);
  let fdDD = f(dDD);
  for (let i = 0; i < mi; i++) {
    const diff = DD.subtract(b, a);
    if (Math.abs(DD.toDouble(diff)) < DD.toDouble(t)) break;
    if (DD.compare(fcDD, fdDD) < 0) {
      b = dDD;
      dDD = cDD;
      fdDD = fcDD;
      cDD = DD.subtract(b, DD.multiply(DD.fromDouble(invphi), DD.subtract(b, a)));
      fcDD = f(cDD);
    } else {
      a = cDD;
      cDD = dDD;
      fcDD = fdDD;
      dDD = DD.add(a, DD.multiply(DD.fromDouble(invphi), DD.subtract(b, a)));
      fdDD = f(dDD);
    }
  }
  const xmin = DD.divBy2(DD.add(a, b));
  return { x: xmin, fx: f(xmin) };
}

export function ddGradientSum(gradients) {
  let acc = [0, 0];
  for (let i = 0; i < gradients.length; i++) {
    acc = DD.add(acc, DD.fromDouble(gradients[i]));
  }
  return acc;
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

function checkBounds(bounds, op) {
  if (!Array.isArray(bounds)) throw new DecodeError(op, 'bounds must be array');
  for (let i = 0; i < bounds.length; i++) {
    if (!Array.isArray(bounds[i]) || bounds[i].length !== 2) {
      throw new DecodeError(op, 'bounds[' + i + '] must be [lo, hi]');
    }
    if (!isFiniteNumber(bounds[i][0]) || !isFiniteNumber(bounds[i][1])) {
      throw new DecodeError(op, 'bounds[' + i + '] must be finite');
    }
    if (bounds[i][0] > bounds[i][1]) throw new DecodeError(op, 'bounds[' + i + '] lo > hi');
  }
}

export const ScalarInput = Object.freeze({
  make(f, a, b, opts) { return { f, a, b, opts }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('scalar', 'Expected {f, a, b, opts?}');
    checkFn(input.f, 'scalar');
    checkFinite(input.a, 'scalar', 'a');
    checkFinite(input.b, 'scalar', 'b');
    return input;
  }
});

export const VectorInput = Object.freeze({
  make(f, gradF, x0, opts) { return { f, gradF, x0, opts }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('vector', 'Expected {f, gradF, x0, opts?}');
    checkFn(input.f, 'vector');
    checkFn(input.gradF, 'vector');
    checkArrayLike(input.x0, 'vector', 'x0');
    return input;
  }
});

export const LineSearchInput = Object.freeze({
  make(f, gradF, x, dir, opts) { return { f, gradF, x, dir, opts }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('lineSearch', 'Expected {f, gradF, x, dir, opts?}');
    checkFn(input.f, 'lineSearch');
    checkFn(input.gradF, 'lineSearch');
    checkArrayLike(input.x, 'lineSearch', 'x');
    checkArrayLike(input.dir, 'lineSearch', 'dir');
    if (input.x.length !== input.dir.length) throw new DecodeError('lineSearch', 'x/dir length mismatch');
    return input;
  }
});

export const ConstraintInput = Object.freeze({
  make(f, gradF, x0, constraints, opts) { return { f, gradF, x0, constraints, opts }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('constraint', 'Expected {f, gradF, x0, constraints, opts?}');
    checkFn(input.f, 'constraint');
    checkFn(input.gradF, 'constraint');
    checkArrayLike(input.x0, 'constraint', 'x0');
    if (!Array.isArray(input.constraints)) throw new DecodeError('constraint', 'constraints must be array');
    return input;
  }
});

export const GlobalInput = Object.freeze({
  make(f, bounds, opts) { return { f, bounds, opts }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('global', 'Expected {f, bounds, opts?}');
    checkFn(input.f, 'global');
    checkBounds(input.bounds, 'global');
    return input;
  }
});

export const HybridInput = Object.freeze({
  make(f, gradF, x0, constraints, opts) { return { f, gradF, x0, constraints, opts }; },
  decode(input) {
    return ConstraintInput.decode(input);
  }
});

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================

export function goldenSectionValidated(input) {
  const d = ScalarInput.decode(input);
  const o = d.opts || {};
  return goldenSectionSearch(d.f, d.a, d.b, o.tol, o.maxIter);
}

export function brentValidated(input) {
  const d = ScalarInput.decode(input);
  const o = d.opts || {};
  return brentMinimize(d.f, d.a, d.b, o.tol, o.maxIter);
}

export function gradientDescentValidated(input) {
  const d = VectorInput.decode(input);
  return gradientDescent(d.f, d.gradF, d.x0, d.opts);
}

export function adamValidated(input) {
  const d = VectorInput.decode(input);
  return adam(d.f, d.gradF, d.x0, d.opts);
}

export function nelderMeadValidated(input) {
  const d = VectorInput.decode(input);
  const o = d.opts || {};
  return nelderMead(d.f, d.x0, o);
}

export function nonlinearCgValidated(input) {
  const d = VectorInput.decode(input);
  return nonlinearConjugateGradient(d.f, d.gradF, d.x0, d.opts);
}

export function simulatedAnnealingValidated(input) {
  const d = VectorInput.decode(input);
  const o = d.opts || {};
  return simulatedAnnealing(d.f, d.x0, o);
}

export function differentialEvolutionValidated(input) {
  const d = GlobalInput.decode(input);
  return differentialEvolution(d.f, d.bounds, d.opts);
}

export function particleSwarmValidated(input) {
  const d = GlobalInput.decode(input);
  return particleSwarm(d.f, d.bounds, d.opts);
}

export function penaltyMethodValidated(input) {
  const d = ConstraintInput.decode(input);
  return penaltyMethod(d.f, d.gradF, d.x0, d.constraints, d.opts);
}

export function augmentedLagrangianValidated(input) {
  const d = HybridInput.decode(input);
  const eq = (d.opts && d.opts.equalityConstraints) || [];
  const iq = (d.opts && d.opts.inequalityConstraints) || [];
  return augmentedLagrangian(d.f, d.gradF, d.x0, eq, iq, d.opts);
}

export function powellValidated(input) {
  const d = VectorInput.decode(input);
  const o = d.opts || {};
  return powell(d.f, d.x0, o);
}

// ============================================================================
// POLICY-AWARE WRAPPERS
// ============================================================================

export function goldenSectionWithPolicies(f, a, b, policy, opts) {
  const o = opts || {};
  return policyCustom(
    'Optimization.goldenSectionWithPolicies',
    () => goldenSectionSearch(f, a, b, o.tol, o.maxIter),
    (r) => r && isFiniteNumber(r.x),
    (msg) => new DomainViolationError('goldenSectionWithPolicies', msg),
    (r) => ({ a, b, x: String(r.x) }),
    policy
  );
}

export function gradientDescentWithPolicies(f, gradF, x0, policy, opts) {
  return policyCustom(
    'Optimization.gradientDescentWithPolicies',
    () => gradientDescent(f, gradF, x0, opts),
    (r) => r && isFiniteArray(r.x),
    (msg) => new DomainViolationError('gradientDescentWithPolicies', msg),
    (r) => ({ dim: x0.length, fx: String(r.fx) }),
    policy
  );
}

export function adamWithPolicies(f, gradF, x0, policy, opts) {
  return policyCustom(
    'Optimization.adamWithPolicies',
    () => adam(f, gradF, x0, opts),
    (r) => r && isFiniteArray(r.x),
    (msg) => new DomainViolationError('adamWithPolicies', msg),
    (r) => ({ dim: x0.length, fx: String(r.fx) }),
    policy
  );
}

export function nelderMeadWithPolicies(f, x0, policy, opts) {
  return policyCustom(
    'Optimization.nelderMeadWithPolicies',
    () => nelderMead(f, x0, opts),
    (r) => r && isFiniteArray(r.x),
    (msg) => new DomainViolationError('nelderMeadWithPolicies', msg),
    (r) => ({ dim: x0.length, fx: String(r.fx) }),
    policy
  );
}

export function differentialEvolutionWithPolicies(f, bounds, policy, opts) {
  return policyCustom(
    'Optimization.differentialEvolutionWithPolicies',
    () => differentialEvolution(f, bounds, opts),
    (r) => r && isFiniteArray(r.x),
    (msg) => new DomainViolationError('differentialEvolutionWithPolicies', msg),
    (r) => ({ dim: bounds.length, fx: String(r.fx) }),
    policy
  );
}

export function particleSwarmWithPolicies(f, bounds, policy, opts) {
  return policyCustom(
    'Optimization.particleSwarmWithPolicies',
    () => particleSwarm(f, bounds, opts),
    (r) => r && isFiniteArray(r.x),
    (msg) => new DomainViolationError('particleSwarmWithPolicies', msg),
    (r) => ({ dim: bounds.length, fx: String(r.fx) }),
    policy
  );
}

// ============================================================================
// POOL
// ============================================================================
const _vecPool = [];
const _MAX_VEC_POOL = 64;

export function poolAcquireVec(n) {
  if (_vecPool.length > 0) {
    const v = _vecPool.pop();
    if (v.length === n) {
      v.fill(0);
      return v;
    }
  }
  return new ARRAY_TYPE(n);
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
export { EPSILON, PRECISION, HELPERS, DD, LA, Num, RANDOM };

export default {
  DecodeError,
  DomainViolationError,
  goldenSectionSearch,
  ternarySearch,
  brentMinimize,
  newtonMinimize,
  backtrackingLineSearch,
  wolfeLineSearch,
  gradientDescent,
  gradientDescentMomentum,
  adam,
  rmsprop,
  adagrad,
  nonlinearConjugateGradient,
  nelderMead,
  coordinateDescent,
  simulatedAnnealing,
  differentialEvolution,
  particleSwarm,
  powell,
  penaltyMethod,
  augmentedLagrangian,
  ddGoldenSection,
  ddGradientSum,
  ScalarInput,
  VectorInput,
  LineSearchInput,
  ConstraintInput,
  GlobalInput,
  HybridInput,
  goldenSectionValidated,
  brentValidated,
  gradientDescentValidated,
  adamValidated,
  nelderMeadValidated,
  nonlinearCgValidated,
  simulatedAnnealingValidated,
  differentialEvolutionValidated,
  particleSwarmValidated,
  penaltyMethodValidated,
  augmentedLagrangianValidated,
  powellValidated,
  goldenSectionWithPolicies,
  gradientDescentWithPolicies,
  adamWithPolicies,
  nelderMeadWithPolicies,
  differentialEvolutionWithPolicies,
  particleSwarmWithPolicies,
  poolAcquireVec,
  poolReleaseVec,
  poolReset,
  poolSize
};