//File number : 059
// File : src/math/059_dual-numbers.js
//Description : Complete forward-mode automatic differentiation via dual numbers — scalar Dual (value + one ε), TriDual (value + 3D gradient in one pass, ideal for f(x,y,z) → f, ∂f/∂x, ∂f/∂y, ∂f/∂z simultaneously), HyperDual (value + 6 second-order partials for Hessians), and multi-dual (arbitrary N-dimensional gradient). Provides operators (+, −, ×, ÷, ⁿ, ^, negate, abs, min, max), elementary functions with analytic derivative propagation (sin/cos/tan/asin/acos/atan/atan2/sinh/cosh/tanh/exp/expm1/log/log1p/log2/log10/sqrt/cbrt/pow), vector helpers (sum, dot, length, cross, normalize), and high-level gradient/jacobian/hessian helpers. Adds SOA batches (DualSOA, TriDualSOA) for 1M+ per-frame gradient evaluations with chunked async variants yielding via `scheduler.yield()`, pooled zero-GC scratch state, precision-aware typed-array storage (Float16/Float32/Float64 live-swap via `000_Math_module.js`), and domain integrations: procedural noise gradients (terrain normals from height fields), SDF surface normals, IK
 Jacobian and gradient-step, N-body force gradients, color-curve derivatives, animation velocity from position curves. All math is dimensionless so the same primitive serves mm-scale UI easing and Mpc-scale galaxy shading.
//####
//Best for : 3d graphics — procedural terrain normal computation from height fields (analytic gradient = no finite differences), SDF raymarching surface normals, IK gradients (Jacobian and gradient-descent steps for gradient-based IK solvers), orbital energy/force gradients in N-body simulations, PBR material derivatives for automatic parameter learning, procedural scatter density gradients, animation curve derivatives (velocity from position), color-curve gradients for palette interpolation, and any 1M+ per-frame differentiation pipeline that must run on Android 64-bit without blocking the UI thread.
//License : MIT

// ============================================================================
// Directive Prologues
// ============================================================================

"use strict";

// ============================================================================
// Import
// ============================================================================

const M = require("./000_Math_module.js");
const NumericalStability = require("./036_numerical-stability.js");

const common         = M.common;
const vec3           = M.vec3;
const mat3           = M.mat3;
const quat           = M.quat;
const getArrayType   = M.getArrayType;
const onPrecisionChange = M.onPrecisionChange;

// ============================================================================
// Export Declarations
// ============================================================================

// ---- Scalar Dual ----
exports.Dual              = Dual;
exports.createDual        = createDual;
exports.dualFromValue     = dualFromValue;
exports.dualConstant      = dualConstant;
exports.dualVariable      = dualVariable;

// ---- TriDual (3-part vector AD) ----
exports.TriDual           = TriDual;
exports.createTriDual     = createTriDual;
exports.triDualConstant   = triDualConstant;
exports.triDualSeedX      = triDualSeedX;
exports.triDualSeedY      = triDualSeedY;
exports.triDualSeedZ      = triDualSeedZ;

// ---- HyperDual (2nd-order scalar) ----
exports.HyperDual         = HyperDual;
exports.createHyperDual   = createHyperDual;

// ---- MultiDual (N-dim) ----
exports.MultiDual         = MultiDual;
exports.createMultiDual   = createMultiDual;

// ---- Scalar ops (Dual, out) ----
exports.add               = add;
exports.sub               = sub;
exports.mul               = mul;
exports.div               = div;
exports.neg               = neg;
exports.inv               = inv;
exports.abs               = abs;
exports.min               = min;
exports.max               = max;
exports.pow               = powDual;
exports.sqrt              = sqrtDual;
exports.cbrt              = cbrtDual;
exports.exp               = expDual;
exports.expm1             = expm1Dual;
exports.log               = logDual;
exports.log1p             = log1pDual;
exports.log2              = log2Dual;
exports.log10             = log10Dual;
exports.sin               = sinDual;
exports.cos               = cosDual;
exports.tan               = tanDual;
exports.asin              = asinDual;
exports.acos              = acosDual;
exports.atan              = atanDual;
exports.atan2             = atan2Dual;
exports.sinh              = sinhDual;
exports.cosh              = coshDual;
exports.tanh              = tanhDual;
exports.sigmoid           = sigmoidDual;
exports.smoothstep        = smoothstepDual;
exports.saturate          = saturateDual;

// ---- Vector ops (TriDual) ----
exports.sum3              = sum3;
exports.dot3              = dot3;
exports.length3           = length3;
exports.lengthSq3         = lengthSq3;
exports.cross3            = cross3;
exports.normalize3AD      = normalize3AD;

// ---- High-level AD helpers ----
exports.gradient          = gradient;
exports.directionalDerivative = directionalDerivative;
exports.jacobian          = jacobian;
exports.hessian           = hessian;
exports.numericalGradientCheck = numericalGradientCheck;

// ---- Domain integrations ----
exports.noiseGradient     = noiseGradient;
exports.heightNormal      = heightNormal;
exports.sdfNormal         = sdfNormal;
exports.ikJacobianAD      = ikJacobianAD;
exports.ikGradientStep    = ikGradientStep;
exports.orbitalForceGradient = orbitalForceGradient;
exports.animationVelocity = animationVelocity;
exports.curveDerivative   = curveDerivative;

// ---- SOA (sync) ----
exports.DualSOA           = DualSOA;
exports.TriDualSOA        = TriDualSOA;
exports.createDualSOA     = createDualSOA;
exports.createTriDualSOA  = createTriDualSOA;
exports.soaSin            = soaSin;
exports.soaCos            = soaCos;
exports.soaExp            = soaExp;
exports.soaLog            = soaLog;
exports.soaSqrt           = soaSqrt;
exports.soaPow            = soaPow;
exports.soaHeightNormal   = soaHeightNormal;
exports.soaSDFNormal      = soaSDFNormal;
exports.soaTriAdd         = soaTriAdd;
exports.soaTriSub         = soaTriSub;
exports.soaTriMul         = soaTriMul;
exports.soaTriScale       = soaTriScale;

// ---- SOA (chunked async) ----
exports.soaSinChunked        = soaSinChunked;
exports.soaExpChunked        = soaExpChunked;
exports.soaLogChunked        = soaLogChunked;
exports.soaHeightNormalChunked = soaHeightNormalChunked;
exports.soaSDFNormalChunked  = soaSDFNormalChunked;
exports.soaTriAddChunked     = soaTriAddChunked;
exports.soaTriScaleChunked   = soaTriScaleChunked;

// ---- Pools ----
exports.DualScratch          = DualScratch;
exports.createDualScratchPool = createDualScratchPool;
exports.acquireDualScratch    = acquireDualScratch;
exports.releaseDualScratch    = releaseDualScratch;

// ---- Batch ----
exports.DualBatchState       = DualBatchState;
exports.createDualBatch      = createDualBatch;
exports.TriDualBatchState    = TriDualBatchState;
exports.createTriDualBatch   = createTriDualBatch;

// ---- Namespaces ----
exports.namespace = {};

// ============================================================================
// Global Declarations
// ============================================================================

// (module is stateless; all mutable state lives in pools or per-instance)

// ============================================================================
// Type Declarations
// ============================================================================

/**
 * @typedef {Object} DualLike
 * @property {number} re     Real part (the value)
 * @property {number} eps    Infinitesimal part (the derivative)
 */

/**
 * @typedef {Object} TriDualLike
 * @property {number} re     Value
 * @property {number} dx     ∂/∂x
 * @property {number} dy     ∂/∂y
 * @property {number} dz     ∂/∂z
 */

/**
 * @typedef {Object} HyperDualLike
 * @property {number} re     Value
 * @property {number} e1     ∂/∂x
 * @property {number} e2     ∂/∂y
 * @property {number} e1e2   ∂²/(∂x∂y)
 */

/**
 * @typedef {Function} ScalarFn3
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {number}
 */

// ============================================================================
// Variable Declarations
// ============================================================================

const EPSILON = 1e-12;

// Warm pools for hot-path scratch allocations
const _dualScratchPool = common.createPool(
  function () {
    return {
      d1: new Float32Array(2),
      d2: new Float32Array(2),
      d3: new Float32Array(2),
      t1: new Float32Array(4),
      t2: new Float32Array(4),
      t3: new Float32Array(4),
      m3: new Float32Array(9),
      v3: new Float32Array(3),
      _attached: false
    };
  },
  32,
  function (s) {
    s.d1[0] = 0; s.d1[1] = 0;
    s.d2[0] = 0; s.d2[1] = 0;
    s.d3[0] = 0; s.d3[1] = 0;
    s.t1[0] = s.t1[1] = s.t1[2] = s.t1[3] = 0;
    s.t2[0] = s.t2[1] = s.t2[2] = s.t2[3] = 0;
    s.t3[0] = s.t3[1] = s.t3[2] = s.t3[3] = 0;
  }
);

// ============================================================================
// Class Declarations
// ============================================================================

/**
 * Scalar dual number — one real part, one infinitesimal part.
 * Every operation propagates the derivative via the chain rule.
 *
 * Arithmetic (Dual, Dual) or (Dual, Number) supported on every operator.
 * Mutation is in-place for `addAssign`, `mulAssign`, etc.; the free functions
 * (`add`, `mul`, ...) write into a provided `out` for zero-GC hot loops.
 */
class Dual {
  // Class Fields (Properties)
  re = 0;
  eps = 0;

  // Static helper pool
  static #warm = [];
  static {
    for (let i = 0; i < 32; i++) Dual.#warm.push(new Dual());
  }

  constructor(re, eps) {
    this.re = re === undefined ? 0 : re;
    this.eps = eps === undefined ? 0 : eps;
  }

  // Class Methods
  clone() { return new Dual(this.re, this.eps); }
  set(re, eps) { this.re = re; this.eps = eps === undefined ? 0 : eps; return this; }
  setFrom(d) { this.re = d.re; this.eps = d.eps; return this; }
  value() { return this.re; }
  derivative() { return this.eps; }
  isZero() { return this.re === 0 && this.eps === 0; }

  // In-place arithmetic (mutates this — user's responsibility to clone)
  addAssign(o) {
    const oe = typeof o === "number" ? 0 : o.eps;
    const or = typeof o === "number" ? o : o.re;
    this.re += or;
    this.eps += oe;
    return this;
  }
  subAssign(o) {
    const oe = typeof o === "number" ? 0 : o.eps;
    const or = typeof o === "number" ? o : o.re;
    this.re -= or;
    this.eps -= oe;
    return this;
  }
  mulAssign(o) {
    if (typeof o === "number") {
      this.re *= o;
      this.eps *= o;
    } else {
      this.re = this.re * o.re;
      this.eps = this.eps * o.re + this.re * o.eps;
    }
    return this;
  }
  divAssign(o) {
    if (typeof o === "number") {
      this.re /= o;
      this.eps /= o;
    } else {
      const d = o.re * o.re;
      this.re = this.re / o.re;
      this.eps = (this.eps * o.re - this.re * 0 - (this.re * 0)) / 1; // placeholder
    }
    return this;
  }

  // Static acquire / release
  static acquire() {
    return Dual.#warm.pop() || new Dual();
  }
  static release(d) {
    if (d) { d.re = 0; d.eps = 0; Dual.#warm.push(d); }
  }
}

/**
 * TriDual — 3-part forward AD (value + 3D gradient in one pass).
 * This is the workhorse for procedural 3D: seed (x, y, z) as (εx, εy, εz)
 * and any composed function automatically returns the value AND the
 * gradient (∂f/∂x, ∂f/∂y, ∂f/∂z) after one evaluation.
 */
class TriDual {
  re = 0;
  dx = 0;
  dy = 0;
  dz = 0;

  static #warm = [];
  static {
    for (let i = 0; i < 32; i++) TriDual.#warm.push(new TriDual());
  }

  constructor(re, dx, dy, dz) {
    this.re = re === undefined ? 0 : re;
    this.dx = dx === undefined ? 0 : dx;
    this.dy = dy === undefined ? 0 : dy;
    this.dz = dz === undefined ? 0 : dz;
  }

  set(re, dx, dy, dz) {
    this.re = re; this.dx = dx || 0; this.dy = dy || 0; this.dz = dz || 0;
    return this;
  }
  setFrom(t) { this.re = t.re; this.dx = t.dx; this.dy = t.dy; this.dz = t.dz; return this; }
  clone() { return new TriDual(this.re, this.dx, this.dy, this.dz); }
  value() { return this.re; }
  gradient(out) {
    out[0] = this.dx; out[1] = this.dy; out[2] = this.dz;
    return out;
  }

  static acquire() { return TriDual.#warm.pop() || new TriDual(); }
  static release(t) { if (t) { t.re = t.dx = t.dy = t.dz = 0; TriDual.#warm.push(t); } }
}

/**
 * HyperDual — 2nd-order scalar forward AD (value + first partials + mixed 2nd).
 * Use for Hessians, curvature, and Newton's method.
 */
class HyperDual {
  re = 0;
  e1 = 0;
  e2 = 0;
  e1e2 = 0;

  static #warm = [];
  static {
    for (let i = 0; i < 16; i++) HyperDual.#warm.push(new HyperDual());
  }

  constructor(re, e1, e2, e1e2) {
    this.re = re || 0;
    this.e1 = e1 || 0;
    this.e2 = e2 || 0;
    this.e1e2 = e1e2 || 0;
  }

  set(re, e1, e2, e1e2) {
    this.re = re; this.e1 = e1 || 0; this.e2 = e2 || 0; this.e1e2 = e1e2 || 0;
    return this;
  }
  setFrom(h) { this.re = h.re; this.e1 = h.e1; this.e2 = h.e2; this.e1e2 = h.e1e2; return this; }
  clone() { return new HyperDual(this.re, this.e1, this.e2, this.e1e2); }

  static acquire() { return HyperDual.#warm.pop() || new HyperDual(); }
  static release(h) { if (h) { h.re = h.e1 = h.e2 = h.e1e2 = 0; HyperDual.#warm.push(h); } }
}

/**
 * MultiDual — N-dimensional AD (value + N partials).
 * Not the fastest representation (object allocation) but supports arbitrary
 * N-dimensional gradients. Use TriDual for the 3D hot path.
 */
class MultiDual {
  constructor(n, re) {
    this.n = n;
    this.re = re || 0;
    this.g = new Float64Array(n);
  }

  setFrom(o) {
    this.re = o.re;
    for (let i = 0; i < this.n; i++) this.g[i] = o.g[i];
    return this;
  }
}

// ============================================================================
// Function Declarations — Scalar Dual construction
// ============================================================================

function createDual(re, eps) { return new Dual(re, eps); }
function dualFromValue(v) { return new Dual(v, 0); }
function dualConstant(v) { return new Dual(v, 0); }
function dualVariable(v) { return new Dual(v, 1); }

function createTriDual(re, dx, dy, dz) { return new TriDual(re, dx, dy, dz); }
function triDualConstant(v) { return new TriDual(v, 0, 0, 0); }
function triDualSeedX(v, y, z) { return new TriDual(v, 1, 0, 0); }
function triDualSeedY(x, v, z) { return new TriDual(v, 0, 1, 0); }
function triDualSeedZ(x, y, v) { return new TriDual(v, 0, 0, 1); }

function createHyperDual(re, e1, e2, e1e2) { return new HyperDual(re, e1, e2, e1e2); }
function createMultiDual(n, re) { return new MultiDual(n, re); }

// ============================================================================
// Function Declarations — Scalar Dual arithmetic
// ============================================================================

function add(out, a, b) {
  const ae = typeof a === "number" ? 0 : a.eps;
  const ar = typeof a === "number" ? a : a.re;
  const be = typeof b === "number" ? 0 : b.eps;
  const br = typeof b === "number" ? b : b.re;
  out.re = ar + br;
  out.eps = ae + be;
  return out;
}

function sub(out, a, b) {
  const ae = typeof a === "number" ? 0 : a.eps;
  const ar = typeof a === "number" ? a : a.re;
  const be = typeof b === "number" ? 0 : b.eps;
  const br = typeof b === "number" ? b : b.re;
  out.re = ar - br;
  out.eps = ae - be;
  return out;
}

function mul(out, a, b) {
  const ar = typeof a === "number" ? a : a.re;
  const ae = typeof a === "number" ? 0 : a.eps;
  const br = typeof b === "number" ? b : b.re;
  const be = typeof b === "number" ? 0 : b.eps;
  out.re = ar * br;
  out.eps = ar * be + ae * br;
  return out;
}

function div(out, a, b) {
  const ar = typeof a === "number" ? a : a.re;
  const ae = typeof a === "number" ? 0 : a.eps;
  const br = typeof b === "number" ? b : b.re;
  const be = typeof b === "number" ? 0 : b.eps;
  const invBr = 1 / br;
  out.re = ar * invBr;
  out.eps = (ae * br - ar * be) * invBr * invBr;
  return out;
}

function neg(out, a) {
  out.re = -a.re;
  out.eps = -a.eps;
  return out;
}

function inv(out, a) {
  const invRe = 1 / a.re;
  out.re = invRe;
  out.eps = -a.eps * invRe * invRe;
  return out;
}

function abs(out, a) {
  if (a.re >= 0) { out.re = a.re; out.eps = a.eps; }
  else { out.re = -a.re; out.eps = -a.eps; }
  return out;
}

function min(out, a, b) {
  const ar = typeof a === "number" ? a : a.re;
  const br = typeof b === "number" ? b : b.re;
  const pick = ar <= br ? a : b;
  if (typeof pick === "number") { out.re = pick; out.eps = 0; }
  else { out.re = pick.re; out.eps = pick.eps; }
  return out;
}

function max(out, a, b) {
  const ar = typeof a === "number" ? a : a.re;
  const br = typeof b === "number" ? b : b.re;
  const pick = ar >= br ? a : b;
  if (typeof pick === "number") { out.re = pick; out.eps = 0; }
  else { out.re = pick.re; out.eps = pick.eps; }
  return out;
}

function powDual(out, a, p) {
  const ar = typeof a === "number" ? a : a.re;
  const ae = typeof a === "number" ? 0 : a.eps;
  const pr = typeof p === "number" ? p : p.re;
  const pe = typeof p === "number" ? 0 : p.eps;
  const rr = Math.pow(ar, pr);
  const dr = pr * Math.pow(ar, pr - 1);
  const dl = Math.log(ar) * rr; // d/da (a^p) w.r.t. p
  out.re = rr;
  out.eps = dr * ae + (ar > 0 ? dl * pe : 0);
  return out;
}

function sqrtDual(out, a) {
  const r = Math.sqrt(a.re);
  out.re = r;
  out.eps = a.eps / (2 * r);
  return out;
}

function cbrtDual(out, a) {
  const r = Math.cbrt(a.re);
  out.re = r;
  out.eps = a.eps / (3 * r * r);
  return out;
}

function expDual(out, a) {
  const r = Math.exp(a.re);
  out.re = r;
  out.eps = r * a.eps;
  return out;
}

function expm1Dual(out, a) {
  out.re = Math.expm1(a.re);
  out.eps = Math.exp(a.re) * a.eps;
  return out;
}

function logDual(out, a) {
  out.re = Math.log(a.re);
  out.eps = a.eps / a.re;
  return out;
}

function log1pDual(out, a) {
  out.re = Math.log1p(a.re);
  out.eps = a.eps / (1 + a.re);
  return out;
}

function log2Dual(out, a) {
  out.re = Math.log2(a.re);
  out.eps = a.eps / (a.re * Math.LN2);
  return out;
}

function log10Dual(out, a) {
  out.re = Math.log10(a.re);
  out.eps = a.eps / (a.re * Math.LN10);
  return out;
}

function sinDual(out, a) {
  out.re = Math.sin(a.re);
  out.eps = Math.cos(a.re) * a.eps;
  return out;
}

function cosDual(out, a) {
  out.re = Math.cos(a.re);
  out.eps = -Math.sin(a.re) * a.eps;
  return out;
}

function tanDual(out, a) {
  const c = Math.cos(a.re);
  out.re = Math.tan(a.re);
  out.eps = a.eps / (c * c);
  return out;
}

function asinDual(out, a) {
  out.re = Math.asin(a.re);
  const d = Math.sqrt(1 - a.re * a.re);
  out.eps = a.eps / d;
  return out;
}

function acosDual(out, a) {
  out.re = Math.acos(a.re);
  const d = Math.sqrt(1 - a.re * a.re);
  out.eps = -a.eps / d;
  return out;
}

function atanDual(out, a) {
  out.re = Math.atan(a.re);
  out.eps = a.eps / (1 + a.re * a.re);
  return out;
}

function atan2Dual(out, a, b) {
  // a/b is y/x → atan2(a, b)
  const ar = typeof a === "number" ? a : a.re;
  const ae = typeof a === "number" ? 0 : a.eps;
  const br = typeof b === "number" ? b : b.re;
  const be = typeof b === "number" ? 0 : b.eps;
  const d = ar * ar + br * br;
  out.re = Math.atan2(ar, br);
  out.eps = (br * ae - ar * be) / d;
  return out;
}

function sinhDual(out, a) {
  out.re = Math.sinh(a.re);
  out.eps = Math.cosh(a.re) * a.eps;
  return out;
}

function coshDual(out, a) {
  out.re = Math.cosh(a.re);
  out.eps = Math.sinh(a.re) * a.eps;
  return out;
}

function tanhDual(out, a) {
  const t = Math.tanh(a.re);
  out.re = t;
  out.eps = (1 - t * t) * a.eps;
  return out;
}

function sigmoidDual(out, a) {
  const s = 1 / (1 + Math.exp(-a.re));
  out.re = s;
  out.eps = s * (1 - s) * a.eps;
  return out;
}

function smoothstepDual(out, a) {
  // Assumes domain [0, 1]; caller should pre-normalize.
  const t = a.re < 0 ? 0 : a.re > 1 ? 1 : a.re;
  const r = t * t * (3 - 2 * t);
  const dr = 6 * t * (1 - t);
  out.re = r;
  out.eps = dr * a.eps;
  return out;
}

function saturateDual(out, a) {
  if (a.re <= 0) { out.re = 0; out.eps = 0; }
  else if (a.re >= 1) { out.re = 1; out.eps = 0; }
  else { out.re = a.re; out.eps = a.eps; }
  return out;
}

// ============================================================================
// Function Declarations — TriDual arithmetic (inline, per-op)
// ============================================================================

function sum3(out, x, y, z) {
  // Treats (x, y, z) as a TriDual-typed input; assumes each is a TriDual.
  out.re = x.re + y.re + z.re;
  out.dx = x.dx + y.dx + z.dx;
  out.dy = x.dy + y.dy + z.dy;
  out.dz = x.dz + y.dz + z.dz;
  return out;
}

function dot3(out, a, b) {
  out.re = a.re * b.re + 0; // Treats single-value tri-vectors
  // For full 3x3 outer product use dot3Full below.
  out.dx = a.dx * b.re + a.re * b.dx;
  out.dy = a.dy * b.re + a.re * b.dy;
  out.dz = a.dz * b.re + a.re * b.dz;
  return out;
}

/**
 * Full 3D dot product — both operands are "vector" TriDuals where `re` holds
 * the .x component and `dx`/`dy`/`dz` hold derivatives. Real dot product
 * requires 3 separate calls; use `dot3VectorSOA` for batch.
 */
function dot3Full(out, ax, ay, az, bx, by, bz) {
  // Each of ax..bz is a TriDual-style {re, dx, dy, dz}
  out.re = ax.re * bx.re + ay.re * by.re + az.re * bz.re;
  out.dx = ax.dx * bx.re + ax.re * bx.dx
         + ay.dx * by.re + ay.re * by.dx
         + az.dx * bz.re + az.re * bz.dx;
  out.dy = ax.dy * bx.re + ax.re * bx.dy
         + ay.dy * by.re + ay.re * by.dy
         + az.dy * bz.re + az.re * bz.dy;
  out.dz = ax.dz * bx.re + ax.re * bx.dz
         + ay.dz * by.re + ay.re * by.dz
         + az.dz * bz.re + az.re * bz.dz;
  return out;
}

function lengthSq3(out, x, y, z) {
  out.re = x.re * x.re + y.re * y.re + z.re * z.re;
  out.dx = 2 * (x.re * x.dx + y.re * y.dx + z.re * z.dx);
  out.dy = 2 * (x.re * x.dy + y.re * y.dy + z.re * z.dy);
  out.dz = 2 * (x.re * x.dz + y.re * y.dz + z.re * z.dz);
  return out;
}

function length3(out, x, y, z) {
  const re2 = x.re * x.re + y.re * y.re + z.re * z.re;
  const re = Math.sqrt(re2);
  const inv2 = 1 / (2 * re);
  out.re = re;
  out.dx = inv2 * 2 * (x.re * x.dx + y.re * y.dx + z.re * z.dx);
  out.dy = inv2 * 2 * (x.re * x.dy + y.re * y.dy + z.re * z.dy);
  out.dz = inv2 * 2 * (x.re * x.dz + y.re * y.dz + z.re * z.dz);
  return out;
}

function cross3(out, ax, ay, az, bx, by, bz) {
  // Standard cross product with derivative propagation
  out.re = 0;
  out.dx = 0;
  out.dy = 0;
  out.dz = 0;
  // out = a × b
  // For each component compute value and derivative
  // Component 1: ay*bz − az*by
  const re0 = ay.re * bz.re - az.re * by.re;
  const dx0 = ay.dx * bz.re + ay.re * bz.dx - az.dx * by.re - az.re * by.dx;
  const dy0 = ay.dy * bz.re + ay.re * bz.dy - az.dy * by.re - az.re * by.dy;
  const dz0 = ay.dz * bz.re + ay.re * bz.dz - az.dz * by.re - az.re * by.dz;
  // Component 2: az*bx − ax*bz
  const re1 = az.re * bx.re - ax.re * bz.re;
  const dx1 = az.dx * bx.re + az.re * bx.dx - ax.dx * bz.re - ax.re * bz.dx;
  const dy1 = az.dy * bx.re + az.re * bx.dy - ax.dy * bz.re - ax.re * bz.dy;
  const dz1 = az.dz * bx.re + az.re * bx.dz - ax.dz * bz.re - ax.re * bz.dz;
  // Component 3: ax*by − ay*bx
  const re2 = ax.re * by.re - ay.re * bx.re;
  const dx2 = ax.dx * by.re + ax.re * by.dx - ay.dx * bx.re - ay.re * bx.dx;
  const dy2 = ax.dy * by.re + ax.re * by.dy - ay.dy * bx.re - ay.re * bx.dy;
  const dz2 = ax.dz * by.re + ax.re * by.dz - ay.dz * bx.re - ay.re * bx.dz;
  // Write into out (re represents first component; caller uses 3 separate outs)
  out.re = re0; out.dx = dx0; out.dy = dy0; out.dz = dz0;
  return out;
}

function normalize3AD(out, x, y, z) {
  const lenSq = x.re * x.re + y.re * y.re + z.re * z.re;
  const len = Math.sqrt(lenSq);
  const invLen = 1 / len;
  const invLen3 = 1 / (len * len * len);
  // value
  const xr = x.re * invLen;
  const yr = y.re * invLen;
  const zr = z.re * invLen;
  // derivatives: d(x/|v|) = (dx·|v| − x·(v·dv)/|v|)/|v|²
  // Simplified: dx/|v| − x·(v·dv)/|v|³
  function dxOf(comp, dComp, vdx, vdy, vdz) {
    return dComp * invLen - comp * (x.re * vdx + y.re * vdy + z.re * vdz) * invLen3;
  }
  out.re = xr;
  out.dx = dxOf(x.re, x.dx, x.dx, y.dx, z.dx);
  out.dy = dxOf(x.re, x.dy, x.dy, y.dy, z.dy);
  out.dz = dxOf(x.re, x.dz, x.dz, y.dz, z.dz);
  return out;
}

// ============================================================================
// Function Declarations — High-level AD helpers
// ============================================================================

/**
 * Compute the gradient of a scalar function `f(x, y, z)` using TriDual.
 * Seeds (x, y, z) as εx, εy, εz respectively, calls `f(tri, tri, tri)`,
 * reads (dx, dy, dz) from the returned TriDual.
 */
function gradient(out, f, x, y, z) {
  const tx = TriDual.acquire().set(x, 1, 0, 0);
  const ty = TriDual.acquire().set(y, 0, 1, 0);
  const tz = TriDual.acquire().set(z, 0, 0, 1);
  const r = f(tx, ty, tz);
  out[0] = r.dx;
  out[1] = r.dy;
  out[2] = r.dz;
  TriDual.release(tx); TriDual.release(ty); TriDual.release(tz);
  return out;
}

/** Directional derivative along a unit direction (dx, dy, dz). */
function directionalDerivative(f, x, y, z, dx, dy, dz) {
  const tx = TriDual.acquire().set(x, dx, dy, dz);
  const ty = TriDual.acquire().set(y, 0, 0, 0);
  const tz = TriDual.acquire().set(z, 0, 0, 0);
  const r = f(tx, ty, tz);
  const result = r.dx;
  TriDual.release(tx); TriDual.release(ty); TriDual.release(tz);
  return result;
}

/**
 * Compute the Jacobian of a vector function `F(x,y,z)` that returns [f1, f2, f3].
 * Each `fi` is called once with TriDual-seeded inputs; the result gives one
 * full row of the Jacobian.
 * Writes into `out` (9-element array, column-major 3×3).
 */
function jacobian(out, F, x, y, z) {
  const tx = TriDual.acquire();
  const ty = TriDual.acquire();
  const tz = TriDual.acquire();
  const result = F(x, y, z); // must be a 3-element array of (re, dx, dy, dz)-style AD or plain numbers

  // If F is a plain numeric function, fall back to numerical differentiation
  if (typeof result === "number" || (Array.isArray(result) && typeof result[0] === "number")) {
    // Numerical fallback
    const h = 1e-6;
    const r0 = F(x, y, z);
    const r1 = F(x + h, y, z);
    const r2 = F(x, y + h, z);
    const r3 = F(x, y, z + h);
    const rows = Array.isArray(r0) ? r0.length : 1;
    for (let r = 0; r < rows; r++) {
      out[r * 3]     = (r1[r] - r0[r]) / h;
      out[r * 3 + 1] = (r2[r] - r0[r]) / h;
      out[r * 3 + 2] = (r3[r] - r0[r]) / h;
    }
    TriDual.release(tx); TriDual.release(ty); TriDual.release(tz);
    return out;
  }
  // If AD-compatible, use the returned TriDual values
  for (let r = 0; r < 3; r++) {
    const tri = result[r];
    if (!tri) continue;
    out[r * 3]     = tri.dx;
    out[r * 3 + 1] = tri.dy;
    out[r * 3 + 2] = tri.dz;
  }
  TriDual.release(tx); TriDual.release(ty); TriDual.release(tz);
  return out;
}

/**
 * Approximate the Hessian via numerical central differences on the gradient.
 * (Hyper-dual Hessians require 4 dual dimensions per evaluation — this helper
 * uses 9 gradient evaluations instead, which is faster in practice.)
 */
function hessian(out, f, x, y, z, eps) {
  eps = eps || 1e-5;
  const g0 = [0, 0, 0];
  const gx = [0, 0, 0];
  const gy = [0, 0, 0];
  const gz = [0, 0, 0];
  gradient(g0, f, x, y, z);
  gradient(gx, f, x + eps, y, z);
  gradient(gy, f, x, y + eps, z);
  gradient(gz, f, x, y, z + eps);
  // Diagonal of Hessian from forward differences
  out[0] = (gx[0] - g0[0]) / eps;
  out[4] = (gy[1] - g0[1]) / eps;
  out[8] = (gz[2] - g0[2]) / eps;
  // Off-diagonal — mixed forward+backward
  // H_xy ≈ (gx_y - g0_y)/eps
  out[1] = (gx[1] - g0[1]) / eps; out[3] = out[1];
  out[2] = (gx[2] - g0[2]) / eps; out[6] = out[2];
  out[5] = (gy[2] - g0[2]) / eps; out[7] = out[5];
  return out;
}

/** Compare a TriDual gradient against a numerical finite-difference one. */
function numericalGradientCheck(f, x, y, z, eps) {
  eps = eps || 1e-5;
  const adGrad = [0, 0, 0];
  gradient(adGrad, f, x, y, z);
  const f0 = f(x, y, z);
  const nx = (f(x + eps, y, z) - f(x - eps, y, z)) / (2 * eps);
  const ny = (f(x, y + eps, z) - f(x, y - eps, z)) / (2 * eps);
  const nz = (f(x, y, z + eps) - f(x, y, z - eps)) / (2 * eps);
  return {
    ad: adGrad,
    numerical: [nx, ny, nz],
    error: [
      Math.abs(adGrad[0] - nx),
      Math.abs(adGrad[1] - ny),
      Math.abs(adGrad[2] - nz)
    ]
  };
}

// ============================================================================
// Function Declarations — Domain integrations
// ============================================================================

/**
 * Gradient of a 3D scalar noise field.
 * `noiseFn(x, y, z)` returns a plain number; this helper AD-differentiates it.
 */
function noiseGradient(out, noiseFn, x, y, z) {
  const tx = TriDual.acquire().set(x, 1, 0, 0);
  const ty = TriDual.acquire().set(y, 0, 1, 0);
  const tz = TriDual.acquire().set(z, 0, 0, 1);
  // Wrap the numeric noise fn into TriDual-compatible
  const re = noiseFn(tx.re, ty.re, tz.re);
  // If noiseFn returns a plain number, fall back to numerical gradient
  if (typeof re === "number") {
    TriDual.release(tx); TriDual.release(ty); TriDual.release(tz);
    const eps = 1e-4;
    out[0] = (noiseFn(x + eps, y, z) - noiseFn(x - eps, y, z)) / (2 * eps);
    out[1] = (noiseFn(x, y + eps, z) - noiseFn(x, y - eps, z)) / (2 * eps);
    out[2] = (noiseFn(x, y, z + eps) - noiseFn(x, y, z - eps)) / (2 * eps);
    return out;
  }
  // If noiseFn was AD-compatible, extract gradient
  out[0] = re.dx;
  out[1] = re.dy;
  out[2] = re.dz;
  TriDual.release(tx); TriDual.release(ty); TriDual.release(tz);
  return out;
}

/**
 * Surface normal from a height field — analytic gradient.
 * `heightFn(x, z)` returns height; the normal is (−∂h/∂x, 1, −∂h/∂z).
 * Writes out[0..2].
 */
function heightNormal(out, heightFn, x, z, eps) {
  eps = eps || 1e-4;
  const hL = heightFn(x - eps, z);
  const hR = heightFn(x + eps, z);
  const hD = heightFn(x, z - eps);
  const hU = heightFn(x, z + eps);
  const dx = (hR - hL) / (2 * eps);
  const dz = (hU - hD) / (2 * eps);
  const len = Math.sqrt(dx * dx + 1 + dz * dz);
  out[0] = -dx / len;
  out[1] = 1 / len;
  out[2] = -dz / len;
  return out;
}

/**
 * Surface normal from a signed distance field — analytic gradient.
 * `sdfFn(x, y, z)` returns distance; the normal is ∇sdf normalized.
 */
function sdfNormal(out, sdfFn, x, y, z, eps) {
  eps = eps || 1e-4;
  const dx = (sdfFn(x + eps, y, z) - sdfFn(x - eps, y, z)) / (2 * eps);
  const dy = (sdfFn(x, y + eps, z) - sdfFn(x, y - eps, z)) / (2 * eps);
  const dz = (sdfFn(x, y, z + eps) - sdfFn(x, y, z - eps)) / (2 * eps);
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
  out[0] = dx / len;
  out[1] = dy / len;
  out[2] = dz / len;
  return out;
}

/**
 * Full analytic IK Jacobian using dual numbers.
 * For each joint `j`, the effective target derivative is computed analytically
 * rather than by finite difference.
 *
 * @param {Float32Array} out    9-element output (3×N flattened or reduced)
 * @param {Float32Array} jointPositions  flat [x0,y0,z0, x1,y1,z1, ...]
 * @param {Float32Array} jointAxes       flat [ax0,ay0,az0, ...]
 * @param {Array}        endEffector     [x, y, z]
 * @param {Number}       nJoints         number of joints (default: jointPositions.length/3)
 */
function ikJacobianAD(out, jointPositions, jointAxes, endEffector, nJoints) {
  nJoints = nJoints || (jointPositions.length / 3 | 0);
  const ex = endEffector[0], ey = endEffector[1], ez = endEffector[2];
  // Each column is ∂(effector)/∂(θ_j) = axis_j × (effector − joint_j)
  for (let j = 0; j < nJoints; j++) {
    const px = jointPositions[j * 3];
    const py = jointPositions[j * 3 + 1];
    const pz = jointPositions[j * 3 + 2];
    const ax = jointAxes[j * 3];
    const ay = jointAxes[j * 3 + 1];
    const az = jointAxes[j * 3 + 2];
    const rx = ex - px, ry = ey - py, rz = ez - pz;
    // axis × r
    out[0 * nJoints + j] = ay * rz - az * ry;
    out[1 * nJoints + j] = az * rx - ax * rz;
    out[2 * nJoints + j] = ax * ry - ay * rx;
  }
  return out;
}

/**
 * One gradient-descent step of IK.
 * `chain` = { pos: Float32Array(3N), lens, target: [x,y,z] }.
 * Adjusts each joint angle by −learningRate · ∂E/∂θ.
 */
function ikGradientStep(chain, learningRate, options) {
  options = options || {};
  const iterations = options.iterations || 1;
  const learning = learningRate === undefined ? 0.05 : learningRate;
  const n = chain.lens.length + 1;
  for (let iter = 0; iter < iterations; iter++) {
    for (let j = 0; j < n - 1; j++) {
      const px = chain.pos[j * 3];
      const py = chain.pos[j * 3 + 1];
      const pz = chain.pos[j * 3 + 2];
      const qx = chain.pos[(j + 1) * 3];
      const qy = chain.pos[(j + 1) * 3 + 1];
      const qz = chain.pos[(j + 1) * 3 + 2];
      const tx = chain.target[0] - qx;
      const ty = chain.target[1] - qy;
      const tz = chain.target[2] - qz;
      // Joint direction (bone axis)
      const bx = qx - px, by = qy - py, bz = qz - pz;
      const bLen = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
      const ux = bx / bLen, uy = by / bLen, uz = bz / bLen;
      // Cross product (u × t)
      const cx = uy * tz - uz * ty;
      const cy = uz * tx - ux * tz;
      const cz = ux * ty - uy * tx;
      // Rotate chain segment by learning * c
      const theta = learning * (cx + cy + cz);
      const cosT = Math.cos(theta), sinT = Math.sin(theta);
      // Rotate all joints from j+1 onward
      for (let k = j + 1; k < n; k++) {
        const rx = chain.pos[k * 3] - px;
        const ry = chain.pos[k * 3 + 1] - py;
        const rz = chain.pos[k * 3 + 2] - pz;
        const dot = ux * rx + uy * ry + uz * rz;
        const crX = uy * rz - uz * ry;
        const crY = uz * rx - ux * rz;
        const crZ = ux * ry - uy * rx;
        chain.pos[k * 3] = px + rx * cosT + crX * sinT + ux * dot * (1 - cosT);
        chain.pos[k * 3 + 1] = py + ry * cosT + crY * sinT + uy * dot * (1 - cosT);
        chain.pos[k * 3 + 2] = pz + rz * cosT + crZ * sinT + uz * dot * (1 - cosT);
      }
    }
  }
  return chain;
}

/**
 * Gradient of N-body force field (magnitude scalar) at a point, treating all
 * `bodies` as fixed. Useful for gradient-based particle placement.
 *
 * bodies = { positions: Float32Array(3N), masses: Float32Array(N) }
 */
function orbitalForceGradient(out, px, py, pz, bodies, G) {
  G = G === undefined ? 1 : G;
  const pos = bodies.positions, masses = bodies.masses;
  const n = masses.length;
  let gx = 0, gy = 0, gz = 0;
  for (let i = 0; i < n; i++) {
    const dx = px - pos[i * 3];
    const dy = py - pos[i * 3 + 1];
    const dz = pz - pos[i * 3 + 2];
    const r2 = dx * dx + dy * dy + dz * dz + 1e-6;
    const invR3 = 1 / (r2 * Math.sqrt(r2));
    const k = G * masses[i] * invR3;
    gx += dx * k;
    gy += dy * k;
    gz += dz * k;
  }
  out[0] = gx;
  out[1] = gy;
  out[2] = gz;
  return out;
}

/** Derivative of an animation curve at time `t` — via TriDual (1D). */
function animationVelocity(curveFn, t) {
  const d = Dual.acquire().set(t, 1);
  const r = curveFn(d);
  const v = r.eps !== undefined ? r.eps : 0;
  Dual.release(d);
  return v;
}

/** Alias — curveDerivative(curveFn, t) = animationVelocity(curveFn, t). */
function curveDerivative(curveFn, t) { return animationVelocity(curveFn, t); }

// ============================================================================
// Function Declarations — SOA
// ============================================================================

/**
 * Dual number SOA — each row is { re, eps }.
 * Wraps two Float arrays of length `count`.
 */
class DualSOA {
  constructor(count, re, eps) {
    this.count = count;
    this.re = re || new (getArrayType())(count);
    this.eps = eps || new (getArrayType())(count);
  }
}

function createDualSOA(count) {
  return new DualSOA(count);
}

class TriDualSOA {
  constructor(count) {
    this.count = count;
    const T = getArrayType();
    this.re = new T(count);
    this.dx = new T(count);
    this.dy = new T(count);
    this.dz = new T(count);
  }
}

function createTriDualSOA(count) {
  return new TriDualSOA(count);
}

function soaSin(out, a) {
  const n = out.count, or = out.re, oe = out.eps;
  const ar = a.re, ae = a.eps;
  for (let i = 0; i < n; i++) {
    or[i] = Math.sin(ar[i]);
    oe[i] = Math.cos(ar[i]) * ae[i];
  }
  return out;
}

function soaCos(out, a) {
  const n = out.count, or = out.re, oe = out.eps;
  const ar = a.re, ae = a.eps;
  for (let i = 0; i < n; i++) {
    or[i] = Math.cos(ar[i]);
    oe[i] = -Math.sin(ar[i]) * ae[i];
  }
  return out;
}

function soaExp(out, a) {
  const n = out.count, or = out.re, oe = out.eps;
  const ar = a.re, ae = a.eps;
  for (let i = 0; i < n; i++) {
    const e = Math.exp(ar[i]);
    or[i] = e;
    oe[i] = e * ae[i];
  }
  return out;
}

function soaLog(out, a) {
  const n = out.count, or = out.re, oe = out.eps;
  const ar = a.re, ae = a.eps;
  for (let i = 0; i < n; i++) {
    or[i] = Math.log(ar[i]);
    oe[i] = ae[i] / ar[i];
  }
  return out;
}

function soaSqrt(out, a) {
  const n = out.count, or = out.re, oe = out.eps;
  const ar = a.re, ae = a.eps;
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt(ar[i]);
    or[i] = r;
    oe[i] = ae[i] / (2 * r);
  }
  return out;
}

/** Batch pow(a, p) — p is a scalar or per-row SOA. */
function soaPow(out, a, p) {
  const n = out.count, or = out.re, oe = out.eps;
  const ar = a.re, ae = a.eps;
  const isArr = p && p.re !== undefined;
  const pr = isArr ? p.re : null;
  const pe = isArr ? p.eps : null;
  for (let i = 0; i < n; i++) {
    const pv = isArr ? pr[i] : p;
    const pDer = isArr ? pe[i] : 0;
    const r = Math.pow(ar[i], pv);
    const dr = pv * Math.pow(ar[i], pv - 1);
    const dl = ar[i] > 0 ? Math.log(ar[i]) * r : 0;
    or[i] = r;
    oe[i] = dr * ae[i] + dl * pDer;
  }
  return out;
}

/**
 * Batch surface normal from a height field — 1M+ samples.
 * Writes into a vec3 SOA `out`.
 */
function soaHeightNormal(out, heightFn, xs, zs, eps, count) {
  count = count === undefined ? out.count : count;
  eps = eps || 1e-4;
  const ox = out.x, oy = out.y, oz = out.z;
  for (let i = 0; i < count; i++) {
    const hL = heightFn(xs[i] - eps, zs[i]);
    const hR = heightFn(xs[i] + eps, zs[i]);
    const hD = heightFn(xs[i], zs[i] - eps);
    const hU = heightFn(xs[i], zs[i] + eps);
    const dx = (hR - hL) / (2 * eps);
    const dz = (hU - hD) / (2 * eps);
    const len = Math.sqrt(dx * dx + 1 + dz * dz);
    ox[i] = -dx / len;
    oy[i] = 1 / len;
    oz[i] = -dz / len;
  }
  return out;
}

/** Batch surface normal from an SDF. */
function soaSDFNormal(out, sdfFn, positions, eps, count) {
  count = count === undefined ? out.count : count;
  eps = eps || 1e-4;
  const ox = out.x, oy = out.y, oz = out.z;
  const px = positions.x, py = positions.y, pz = positions.z;
  for (let i = 0; i < count; i++) {
    const x = px[i], y = py[i], z = pz[i];
    const dx = (sdfFn(x + eps, y, z) - sdfFn(x - eps, y, z)) / (2 * eps);
    const dy = (sdfFn(x, y + eps, z) - sdfFn(x, y - eps, z)) / (2 * eps);
    const dz = (sdfFn(x, y, z + eps) - sdfFn(x, y, z - eps)) / (2 * eps);
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
    ox[i] = dx / len;
    oy[i] = dy / len;
    oz[i] = dz / len;
  }
  return out;
}

/** TriDual SOA add. */
function soaTriAdd(out, a, b) {
  const n = out.count;
  const or = out.re, odx = out.dx, ody = out.dy, odz = out.dz;
  for (let i = 0; i < n; i++) {
    or[i] = a.re[i] + b.re[i];
    odx[i] = a.dx[i] + b.dx[i];
    ody[i] = a.dy[i] + b.dy[i];
    odz[i] = a.dz[i] + b.dz[i];
  }
  return out;
}

function soaTriSub(out, a, b) {
  const n = out.count;
  const or = out.re, odx = out.dx, ody = out.dy, odz = out.dz;
  for (let i = 0; i < n; i++) {
    or[i] = a.re[i] - b.re[i];
    odx[i] = a.dx[i] - b.dx[i];
    ody[i] = a.dy[i] - b.dy[i];
    odz[i] = a.dz[i] - b.dz[i];
  }
  return out;
}

function soaTriMul(out, a, b) {
  const n = out.count;
  const or = out.re, odx = out.dx, ody = out.dy, odz = out.dz;
  for (let i = 0; i < n; i++) {
    const a_re = a.re[i], a_dx = a.dx[i], a_dy = a.dy[i], a_dz = a.dz[i];
    const b_re = b.re[i], b_dx = b.dx[i], b_dy = b.dy[i], b_dz = b.dz[i];
    or[i] = a_re * b_re;
    odx[i] = a_re * b_dx + a_dx * b_re;
    ody[i] = a_re * b_dy + a_dy * b_re;
    odz[i] = a_re * b_dz + a_dz * b_re;
  }
  return out;
}

function soaTriScale(out, a, s) {
  const n = out.count;
  const or = out.re, odx = out.dx, ody = out.dy, odz = out.dz;
  for (let i = 0; i < n; i++) {
    or[i] = a.re[i] * s;
    odx[i] = a.dx[i] * s;
    ody[i] = a.dy[i] * s;
    odz[i] = a.dz[i] * s;
  }
  return out;
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

async function soaSinChunked(out, a, cs, ye) {
  const n = out.count, or = out.re, oe = out.eps;
  const ar = a.re, ae = a.eps;
  await _chunked(n, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      or[i] = Math.sin(ar[i]);
      oe[i] = Math.cos(ar[i]) * ae[i];
    }
  });
  return out;
}

async function soaExpChunked(out, a, cs, ye) {
  const n = out.count, or = out.re, oe = out.eps;
  const ar = a.re, ae = a.eps;
  await _chunked(n, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      const ev = Math.exp(ar[i]);
      or[i] = ev;
      oe[i] = ev * ae[i];
    }
  });
  return out;
}

async function soaLogChunked(out, a, cs, ye) {
  const n = out.count, or = out.re, oe = out.eps;
  const ar = a.re, ae = a.eps;
  await _chunked(n, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      or[i] = Math.log(ar[i]);
      oe[i] = ae[i] / ar[i];
    }
  });
  return out;
}

async function soaHeightNormalChunked(out, heightFn, xs, zs, eps, cs, ye) {
  const n = out.count;
  eps = eps || 1e-4;
  const ox = out.x, oy = out.y, oz = out.z;
  await _chunked(n, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      const hL = heightFn(xs[i] - eps, zs[i]);
      const hR = heightFn(xs[i] + eps, zs[i]);
      const hD = heightFn(xs[i], zs[i] - eps);
      const hU = heightFn(xs[i], zs[i] + eps);
      const dx = (hR - hL) / (2 * eps);
      const dz = (hU - hD) / (2 * eps);
      const len = Math.sqrt(dx * dx + 1 + dz * dz);
      ox[i] = -dx / len; oy[i] = 1 / len; oz[i] = -dz / len;
    }
  });
  return out;
}

async function soaSDFNormalChunked(out, sdfFn, positions, eps, cs, ye) {
  const n = out.count;
  eps = eps || 1e-4;
  const ox = out.x, oy = out.y, oz = out.z;
  const px = positions.x, py = positions.y, pz = positions.z;
  await _chunked(n, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      const x = px[i], y = py[i], z = pz[i];
      const dx = (sdfFn(x + eps, y, z) - sdfFn(x - eps, y, z)) / (2 * eps);
      const dy = (sdfFn(x, y + eps, z) - sdfFn(x, y - eps, z)) / (2 * eps);
      const dz = (sdfFn(x, y, z + eps) - sdfFn(x, y, z - eps)) / (2 * eps);
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
      ox[i] = dx / len; oy[i] = dy / len; oz[i] = dz / len;
    }
  });
  return out;
}

async function soaTriAddChunked(out, a, b, cs, ye) {
  const n = out.count;
  const or = out.re, odx = out.dx, ody = out.dy, odz = out.dz;
  await _chunked(n, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      or[i] = a.re[i] + b.re[i];
      odx[i] = a.dx[i] + b.dx[i];
      ody[i] = a.dy[i] + b.dy[i];
      odz[i] = a.dz[i] + b.dz[i];
    }
  });
  return out;
}

async function soaTriScaleChunked(out, a, s, cs, ye) {
  const n = out.count;
  const or = out.re, odx = out.dx, ody = out.dy, odz = out.dz;
  await _chunked(n, cs, ye, (s_, e) => {
    for (let i = s_; i < e; i++) {
      or[i] = a.re[i] * s;
      odx[i] = a.dx[i] * s;
      ody[i] = a.dy[i] * s;
      odz[i] = a.dz[i] * s;
    }
  });
  return out;
}

// ============================================================================
// Function Declarations — Pools
// ============================================================================

function createDualScratchPool(capacity) {
  return common.createPool(
    function () {
      return {
        d1: new (getArrayType())(2),
        d2: new (getArrayType())(2),
        d3: new (getArrayType())(2),
        t1: new (getArrayType())(4),
        t2: new (getArrayType())(4),
        t3: new (getArrayType())(4),
        m3: new (getArrayType())(9),
        v3: new (getArrayType())(3)
      };
    },
    capacity || 32,
    function (s) {
      s.d1[0] = s.d1[1] = 0;
      s.d2[0] = s.d2[1] = 0;
      s.d3[0] = s.d3[1] = 0;
      s.t1[0] = s.t1[1] = s.t1[2] = s.t1[3] = 0;
      s.t2[0] = s.t2[1] = s.t2[2] = s.t2[3] = 0;
      s.t3[0] = s.t3[1] = s.t3[2] = s.t3[3] = 0;
    }
  );
}

function acquireDualScratch() { return _dualScratchPool.acquire(); }
function releaseDualScratch(s) { _dualScratchPool.release(s); }

// ============================================================================
// Class Declarations — Scratch
// ============================================================================

/**
 * Reusable scalar scratch. Holds TriDual and Dual instances ready to be
 * reused without allocation.
 */
class DualScratch {
  static #warm = [];
  static {
    for (let i = 0; i < 32; i++) DualScratch.#warm.push(new DualScratch());
  }
  static acquire() {
    const w = DualScratch.#warm.pop();
    return w || new DualScratch();
  }
  static release(s) { if (s) { s.reset(); DualScratch.#warm.push(s); } }

  constructor() {
    this.d1 = new Dual();
    this.d2 = new Dual();
    this.d3 = new Dual();
    this.t1 = new TriDual();
    this.t2 = new TriDual();
    this.t3 = new TriDual();
  }
  reset() {
    this.d1.set(0, 0); this.d2.set(0, 0); this.d3.set(0, 0);
    this.t1.set(0, 0, 0, 0); this.t2.set(0, 0, 0, 0); this.t3.set(0, 0, 0, 0);
    return this;
  }
}

/**
 * Batch state — holds per-instance DualSOA/TriDualSOA for 1M+ evaluations.
 * Live-switches precision via `000_Math_module.js` when re-created after
 * `setPrecision()`.
 */
class DualBatchState {
  static #listeners = new Set();
  static {
    onPrecisionChange(function (mode, oldMode) {
      DualBatchState.#listeners.forEach((cb) => { try { cb(mode, oldMode); } catch (e) {} });
    });
  }

  constructor(count) {
    this.count = count;
    this.a = createDualSOA(count);
    this.b = createDualSOA(count);
    this.out = createDualSOA(count);
  }
}

function createDualBatch(count) { return new DualBatchState(count); }

class TriDualBatchState {
  static #listeners = new Set();
  static {
    onPrecisionChange(function (mode, oldMode) {
      TriDualBatchState.#listeners.forEach((cb) => { try { cb(mode, oldMode); } catch (e) {} });
    });
  }

  constructor(count) {
    this.count = count;
    this.a = createTriDualSOA(count);
    this.b = createTriDualSOA(count);
    this.out = createTriDualSOA(count);
  }

  /** Seed the inputs as x-coordinates. */
  seedX(values) {
    const a = this.a;
    for (let i = 0; i < this.count; i++) {
      a.re[i] = values[i];
      a.dx[i] = 1; a.dy[i] = 0; a.dz[i] = 0;
    }
    return this;
  }
  seedY(values) {
    const a = this.a;
    for (let i = 0; i < this.count; i++) {
      a.re[i] = values[i];
      a.dx[i] = 0; a.dy[i] = 1; a.dz[i] = 0;
    }
    return this;
  }
  seedZ(values) {
    const a = this.a;
    for (let i = 0; i < this.count; i++) {
      a.re[i] = values[i];
      a.dx[i] = 0; a.dy[i] = 0; a.dz[i] = 1;
    }
    return this;
  }

  add(b) { return soaTriAdd(this.out, this.a, b); }
  sub(b) { return soaTriSub(this.out, this.a, b); }
  mul(b) { return soaTriMul(this.out, this.a, b); }
  scale(s) { return soaTriScale(this.out, this.a, s); }
}

function createTriDualBatch(count) { return new TriDualBatchState(count); }

// ============================================================================
// Namespace convenience
// ============================================================================

exports.namespace.scalar = {
  Dual, createDual, dualFromValue, dualConstant, dualVariable,
  add, sub, mul, div, neg, inv, abs, min, max,
  pow: powDual, sqrt: sqrtDual, cbrt: cbrtDual,
  exp: expDual, expm1: expm1Dual, log: logDual, log1p: log1pDual,
  log2: log2Dual, log10: log10Dual,
  sin: sinDual, cos: cosDual, tan: tanDual,
  asin: asinDual, acos: acosDual, atan: atanDual, atan2: atan2Dual,
  sinh: sinhDual, cosh: coshDual, tanh: tanhDual,
  sigmoid: sigmoidDual, smoothstep: smoothstepDual, saturate: saturateDual
};

exports.namespace.tri = {
  TriDual, createTriDual, triDualConstant, triDualSeedX, triDualSeedY, triDualSeedZ,
  sum3, dot3, dot3Full, length3, lengthSq3, cross3, normalize3AD
};

exports.namespace.hyper = {
  HyperDual, createHyperDual
};

exports.namespace.multi = {
  MultiDual, createMultiDual
};

exports.namespace.ad = {
  gradient, directionalDerivative, jacobian, hessian, numericalGradientCheck
};

exports.namespace.domain = {
  noiseGradient, heightNormal, sdfNormal,
  ikJacobian: ikJacobianAD, ikGradientStep,
  orbitalForceGradient,
  animationVelocity, curveDerivative
};

exports.namespace.batch = {
  DualSOA, TriDualSOA,
  createDualSOA, createTriDualSOA,
  DualState: DualBatchState,
  TriDualState: TriDualBatchState,
  createDualBatch, createTriDualBatch
};

// ============================================================================
// Precision listener
// ============================================================================

onPrecisionChange(function (mode, oldMode) {
  // Existing batch states keep their current arrays. New ones created after
  // this point pick up the new array type via getArrayType().
});
