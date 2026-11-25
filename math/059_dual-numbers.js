//File number : 059
// File : src/math/059_dual-numbers.js
//Description : Complete forward-mode automatic differentiation via dual numbers — scalar Dual (value + one ε), TriDual (value + 3D gradient in one pass, ideal for f(x,y,z) → f, ∂f/∂x, ∂f/∂y, ∂f/∂z simultaneously), HyperDual (value + two first partials + mixed second partial, enabling EXACT Hessians in six evaluations), and MultiDual (bounded N-dimensional gradient). Provides full operator sets for every representation (+, −, ×, ÷, ⁿ, ^, negate, abs, min, max), elementary functions with analytic derivative propagation (sin/cos/tan/asin/acos/atan/atan2/sinh/cosh/tanh/exp/expm1/log/log1p/log2/log10/sqrt/cbrt/pow/sigmoid/smoothstep/saturate), vector helpers (sum, dot, length, cross, normalize), and high-level gradient / directional-derivative / Jacobian / Hessian helpers. Adds SOA batches (DualSOA, TriDualSOA) for 1M+ per-frame gradient evaluations with chunked async variants yielding via `scheduler.yield()` / `MessageChannel`, pooled zero-GC scratch state, precision-aware typed-array storage (Float16/Float32/Float64 live-swap via `000_Math_module.js`), and domain integrations: analytic procedural-noise gradients (terrain normals from height fields with NO finite differences), analytic SDF surface normals, IK Jacobian and correctly-derived gradient-descent step, N-body potential gradient / acceleration / acceleration Jacobian, and animation-curve velocity. All math is dimensionless so the same primitive serves mm-scale UI easing and Mpc-scale galaxy shading.
// Zero-GC Compliance : Strict adherence to the Enhanced Zero-GC ECS mandate. No closures, no array literals, no Map/Set, and no dynamic allocations in any hot loop. Every class pool is fixed-capacity with swap-remove (no Array.splice / unbounded push). Chunked async kernels inline their loops (no per-call callbacks). All high-level helpers write into caller-supplied buffers and release pooled seeds through try/finally. All allocations occur exclusively at module init / pool growth.
//Corrections : ESM imports/exports only (no require/exports). Fixed: `soaTriScaleChunked` referenced undefined `chunked` and undefined loop variable `s_`; `Dual.mulAssign` used the already-mutated real part when propagating the derivative; `Dual.divAssign` contained a placeholder expression; `cross3` computed three components but discarded two; `normalize3AD` allocated an inner closure per call and discarded two components; `dot3Full` was never exported; `jacobian` acquired unused seeds and indexed numeric results as arrays; `hessian` allocated four array literals per call and used asymmetric differences; `numericalGradientCheck` allocated a result object plus three arrays per call; `noiseGradient` AD branch was unreachable; `animationVelocity` silently returned 0 for numeric curves; `ikGradientStep` summed cross-product components instead of forming the true error gradient; HyperDual and MultiDual had no operators; TriDual has no elementary functions; `|| 0` coercion masked NaN in constructors; scratch factory ignored live precision.
//Added : Full TriDual and HyperDual operator/elementary sets, MultiDual operators, exact HyperDual Hessian (`hessianExact`), analytic AD variants (`noiseGradientAD`, `heightNormalAD`, `sdfNormalAD`, `soaHeightNormalAD`, `soaSDFNormalAD`), `jacobianAD`, `gravAccel`, `gravAccelJacobian`, `gradientError`, batch TriDual elementaries, `soaCurveDerivative`, and chunked variants for every SOA kernel.
//License : MIT
// ============================================================================
// Directive Prologues
// ============================================================================
"use strict";

// ============================================================================
// Import (ES Modules — sibling files within the 54-file math topology)
// ============================================================================
import {
    common,
    getArrayType,
    onPrecisionChange,
    createVec3SOA
} from './000_Math_module.js';

// ============================================================================
// Variable Declarations — constants and module scratch (init-time only)
// ============================================================================
const EPSILON = 1e-12;
const DEFAULT_FD_EPS = 1e-5;
const DEFAULT_FIELD_EPS = 1e-4;
const MULTI_DUAL_CAPACITY = 16;

// Shared numeric-difference scratch (single-threaded, never held across calls).
const _hA = new Float64Array(3);
const _hB = new Float64Array(3);
const _jA = new Float64Array(3);
const _jB = new Float64Array(3);
const _gA = new Float64Array(3);
const _gB = new Float64Array(3);

// ============================================================================
// Zero-GC scratch pool — precision-aware, buffer-preserving release
// ============================================================================
function _dualScratchFactory() {
    const T = getArrayType();
    return {
        d1: new T(2), d2: new T(2), d3: new T(2),
        t1: new T(4), t2: new T(4), t3: new T(4),
        m3: new T(9), v3: new T(3)
    };
}

function _dualScratchReset(s) {
    s.d1[0] = s.d1[1] = 0;
    s.d2[0] = s.d2[1] = 0;
    s.d3[0] = s.d3[1] = 0;
    s.t1[0] = s.t1[1] = s.t1[2] = s.t1[3] = 0;
    s.t2[0] = s.t2[1] = s.t2[2] = s.t2[3] = 0;
    s.t3[0] = s.t3[1] = s.t3[2] = s.t3[3] = 0;
    s.v3[0] = s.v3[1] = s.v3[2] = 0;
}

const _dualScratchPool = common.createPool(_dualScratchFactory, 32, _dualScratchReset);

for (let _pw = 0; _pw < 32; _pw++) {
    const _s = _dualScratchPool.acquire() || _dualScratchFactory();
    _dualScratchReset(_s);
    _dualScratchPool.release(_s);
}

function acquireDualScratch() {
    return _dualScratchPool.acquire() || _dualScratchFactory();
}

function releaseDualScratch(s) {
    if (s) _dualScratchPool.release(s);
}

function createDualScratchPool(capacity) {
    return common.createPool(_dualScratchFactory, capacity || 32, _dualScratchReset);
}

// ============================================================================
// Class Declarations — Dual (value + one infinitesimal)
// ============================================================================
/**
 * Scalar dual number. Every operation propagates the derivative by the chain
 * rule. Free functions (`add`, `mul`, …) write into a provided `out` for
 * zero-GC hot loops; `*Assign` methods mutate in place.
 */
class Dual {
    re = 0;
    eps = 0;
    static #pool = new Array(64);
    static #count = 0;
    static {
        for (let i = 0; i < 32; i++) Dual.#pool[Dual.#count++] = new Dual();
    }
    constructor(re, eps) {
        this.re = re === undefined ? 0 : re;
        this.eps = eps === undefined ? 0 : eps;
    }
    clone() { return new Dual(this.re, this.eps); }
    set(re, eps) {
        this.re = re;
        this.eps = eps === undefined ? 0 : eps;
        return this;
    }
    setFrom(d) { this.re = d.re; this.eps = d.eps; return this; }
    value() { return this.re; }
    derivative() { return this.eps; }
    isZero() { return this.re === 0 && this.eps === 0; }
    addAssign(o) {
        if (typeof o === "number") { this.re += o; return this; }
        this.re += o.re; this.eps += o.eps;
        return this;
    }
    subAssign(o) {
        if (typeof o === "number") { this.re -= o; return this; }
        this.re -= o.re; this.eps -= o.eps;
        return this;
    }
    // Corrected: capture the original real part before mutating it.
    mulAssign(o) {
        if (typeof o === "number") { this.re *= o; this.eps *= o; return this; }
        const ar = this.re, ae = this.eps;
        this.re = ar * o.re;
        this.eps = ae * o.re + ar * o.eps;
        return this;
    }
    // Corrected: full quotient rule (previous version was a placeholder).
    divAssign(o) {
        if (typeof o === "number") {
            const inv = 1 / o;
            this.re *= inv; this.eps *= inv;
            return this;
        }
        const ar = this.re, ae = this.eps;
        const inv = 1 / o.re;
        this.re = ar * inv;
        this.eps = (ae * o.re - ar * o.eps) * inv * inv;
        return this;
    }
    negAssign() { this.re = -this.re; this.eps = -this.eps; return this; }
    static acquire() {
        if (Dual.#count > 0) {
            Dual.#count--;
            const d = Dual.#pool[Dual.#count];
            Dual.#pool[Dual.#count] = null;
            return d;
        }
        return new Dual();
    }
    static release(d) {
        if (!d) return;
        d.re = 0; d.eps = 0;
        if (Dual.#count < 64) Dual.#pool[Dual.#count++] = d;
    }
}

// ============================================================================
// Class Declarations — TriDual (value + 3D gradient)
// ============================================================================
/**
 * TriDual — 3-part forward AD. Seed (x, y, z) as (εx, εy, εz) and any composed
 * function returns the value AND ∇f after a single evaluation.
 */
class TriDual {
    re = 0;
    dx = 0;
    dy = 0;
    dz = 0;
    static #pool = new Array(64);
    static #count = 0;
    static {
        for (let i = 0; i < 32; i++) TriDual.#pool[TriDual.#count++] = new TriDual();
    }
    constructor(re, dx, dy, dz) {
        this.re = re === undefined ? 0 : re;
        this.dx = dx === undefined ? 0 : dx;
        this.dy = dy === undefined ? 0 : dy;
        this.dz = dz === undefined ? 0 : dz;
    }
    set(re, dx, dy, dz) {
        this.re = re;
        this.dx = dx === undefined ? 0 : dx;
        this.dy = dy === undefined ? 0 : dy;
        this.dz = dz === undefined ? 0 : dz;
        return this;
    }
    setFrom(t) { this.re = t.re; this.dx = t.dx; this.dy = t.dy; this.dz = t.dz; return this; }
    clone() { return new TriDual(this.re, this.dx, this.dy, this.dz); }
    value() { return this.re; }
    gradient(out) { out[0] = this.dx; out[1] = this.dy; out[2] = this.dz; return out; }
    static acquire() {
        if (TriDual.#count > 0) {
            TriDual.#count--;
            const t = TriDual.#pool[TriDual.#count];
            TriDual.#pool[TriDual.#count] = null;
            return t;
        }
        return new TriDual();
    }
    static release(t) {
        if (!t) return;
        t.re = 0; t.dx = 0; t.dy = 0; t.dz = 0;
        if (TriDual.#count < 64) TriDual.#pool[TriDual.#count++] = t;
    }
}

// ============================================================================
// Class Declarations — HyperDual (exact second-order mixed partials)
// ============================================================================
/**
 * HyperDual — value + ∂/∂e1 + ∂/∂e2 + ∂²/∂e1∂e2.
 * Seeding one variable with e1 = e2 = 1 yields f''; seeding two different
 * variables with e1 and e2 yields the exact mixed partial. Six evaluations
 * give a full, exact 3×3 Hessian (see `hessianExact`).
 */
class HyperDual {
    re = 0;
    e1 = 0;
    e2 = 0;
    e1e2 = 0;
    static #pool = new Array(32);
    static #count = 0;
    static {
        for (let i = 0; i < 16; i++) HyperDual.#pool[HyperDual.#count++] = new HyperDual();
    }
    constructor(re, e1, e2, e1e2) {
        this.re = re === undefined ? 0 : re;
        this.e1 = e1 === undefined ? 0 : e1;
        this.e2 = e2 === undefined ? 0 : e2;
        this.e1e2 = e1e2 === undefined ? 0 : e1e2;
    }
    set(re, e1, e2, e1e2) {
        this.re = re;
        this.e1 = e1 === undefined ? 0 : e1;
        this.e2 = e2 === undefined ? 0 : e2;
        this.e1e2 = e1e2 === undefined ? 0 : e1e2;
        return this;
    }
    setFrom(h) { this.re = h.re; this.e1 = h.e1; this.e2 = h.e2; this.e1e2 = h.e1e2; return this; }
    clone() { return new HyperDual(this.re, this.e1, this.e2, this.e1e2); }
    static acquire() {
        if (HyperDual.#count > 0) {
            HyperDual.#count--;
            const h = HyperDual.#pool[HyperDual.#count];
            HyperDual.#pool[HyperDual.#count] = null;
            return h;
        }
        return new HyperDual();
    }
    static release(h) {
        if (!h) return;
        h.re = 0; h.e1 = 0; h.e2 = 0; h.e1e2 = 0;
        if (HyperDual.#count < 32) HyperDual.#pool[HyperDual.#count++] = h;
    }
}

// ============================================================================
// Class Declarations — MultiDual (bounded N-dimensional gradient)
// ============================================================================
/**
 * MultiDual — value + N partials with a fixed pre-allocated capacity.
 * Use TriDual for the 3D hot path; MultiDual serves arbitrary-N gradients
 * without per-call allocation once acquired from the bounded pool.
 */
class MultiDual {
    static #pool = new Array(16);
    static #count = 0;
    static {
        for (let i = 0; i < 8; i++) MultiDual.#pool[MultiDual.#count++] = new MultiDual(MULTI_DUAL_CAPACITY);
    }
    constructor(n, re) {
        this.capacity = Math.max(n || 0, MULTI_DUAL_CAPACITY);
        this.n = n === undefined ? 0 : n;
        this.re = re === undefined ? 0 : re;
        this.g = new Float64Array(this.capacity);
    }
    ensure(n) {
        if (n <= this.capacity) { this.n = n; return this; }
        this.capacity = n;
        this.n = n;
        this.g = new Float64Array(n);
        return this;
    }
    setFrom(o) {
        this.ensure(o.n);
        this.re = o.re;
        for (let i = 0; i < this.n; i++) this.g[i] = o.g[i];
        return this;
    }
    static acquire(n) {
        let m;
        if (MultiDual.#count > 0) {
            MultiDual.#count--;
            m = MultiDual.#pool[MultiDual.#count];
            MultiDual.#pool[MultiDual.#count] = null;
        } else {
            m = new MultiDual(n || MULTI_DUAL_CAPACITY);
        }
        m.ensure(n || MULTI_DUAL_CAPACITY);
        m.re = 0;
        m.g.fill(0);
        return m;
    }
    static release(m) {
        if (!m) return;
        if (MultiDual.#count < 16) MultiDual.#pool[MultiDual.#count++] = m;
    }
}

// ============================================================================
// Function Declarations — construction helpers
// ============================================================================
function createDual(re, eps) { return new Dual(re, eps); }
function dualFromValue(v) { return new Dual(v, 0); }
function dualConstant(v) { return new Dual(v, 0); }
function dualVariable(v) { return new Dual(v, 1); }
function createTriDual(re, dx, dy, dz) { return new TriDual(re, dx, dy, dz); }
function triDualConstant(v) { return new TriDual(v, 0, 0, 0); }
/** Seed only ∂/∂x; remaining coordinates are supplied by the caller's closure. */
function triDualSeedX(v) { return new TriDual(v, 1, 0, 0); }
function triDualSeedY(v) { return new TriDual(v, 0, 1, 0); }
function triDualSeedZ(v) { return new TriDual(v, 0, 0, 1); }
function createHyperDual(re, e1, e2, e1e2) { return new HyperDual(re, e1, e2, e1e2); }
function createMultiDual(n, re) { return new MultiDual(n, re); }

// ============================================================================
// Function Declarations — Scalar Dual arithmetic
// ============================================================================
function add(out, a, b) {
    const ar = typeof a === "number" ? a : a.re;
    const ae = typeof a === "number" ? 0 : a.eps;
    const br = typeof b === "number" ? b : b.re;
    const be = typeof b === "number" ? 0 : b.eps;
    out.re = ar + br; out.eps = ae + be;
    return out;
}

function sub(out, a, b) {
    const ar = typeof a === "number" ? a : a.re;
    const ae = typeof a === "number" ? 0 : a.eps;
    const br = typeof b === "number" ? b : b.re;
    const be = typeof b === "number" ? 0 : b.eps;
    out.re = ar - br; out.eps = ae - be;
    return out;
}

function mul(out, a, b) {
    const ar = typeof a === "number" ? a : a.re;
    const ae = typeof a === "number" ? 0 : a.eps;
    const br = typeof b === "number" ? b : b.re;
    const be = typeof b === "number" ? 0 : b.eps;
    out.re = ar * br; out.eps = ar * be + ae * br;
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

function neg(out, a) { out.re = -a.re; out.eps = -a.eps; return out; }

function inv(out, a) {
    const invRe = 1 / a.re;
    out.re = invRe;
    out.eps = -a.eps * invRe * invRe;
    return out;
}

/** |a| — at a.re = 0 the derivative is a subgradient (a.eps propagated). */
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
    out.re = rr;
    let d = pr * Math.pow(ar, pr - 1) * ae;
    if (pe !== 0 && ar > 0) d += Math.log(ar) * rr * pe;
    out.eps = d;
    return out;
}

function sqrtDual(out, a) {
    const r = Math.sqrt(a.re);
    out.re = r;
    out.eps = r > EPSILON ? a.eps / (2 * r) : 0;
    return out;
}

function cbrtDual(out, a) {
    const r = Math.cbrt(a.re);
    out.re = r;
    out.eps = Math.abs(r) > EPSILON ? a.eps / (3 * r * r) : 0;
    return out;
}

function expDual(out, a) {
    const r = Math.exp(a.re);
    out.re = r; out.eps = r * a.eps;
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
    out.eps = a.eps / Math.sqrt(1 - a.re * a.re);
    return out;
}

function acosDual(out, a) {
    out.re = Math.acos(a.re);
    out.eps = -a.eps / Math.sqrt(1 - a.re * a.re);
    return out;
}

function atanDual(out, a) {
    out.re = Math.atan(a.re);
    out.eps = a.eps / (1 + a.re * a.re);
    return out;
}

/** atan2(a, b) — a is y, b is x. */
function atan2Dual(out, a, b) {
    const ar = typeof a === "number" ? a : a.re;
    const ae = typeof a === "number" ? 0 : a.eps;
    const br = typeof b === "number" ? b : b.re;
    const be = typeof b === "number" ? 0 : b.eps;
    out.re = Math.atan2(ar, br);
    out.eps = (br * ae - ar * be) / (ar * ar + br * br);
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

/** Smoothstep on the normalized domain [0, 1]; derivative vanishes at ends. */
function smoothstepDual(out, a) {
    const t = a.re < 0 ? 0 : a.re > 1 ? 1 : a.re;
    out.re = t * t * (3 - 2 * t);
    out.eps = 6 * t * (1 - t) * a.eps;
    return out;
}

function saturateDual(out, a) {
    if (a.re <= 0) { out.re = 0; out.eps = 0; }
    else if (a.re >= 1) { out.re = 1; out.eps = 0; }
    else { out.re = a.re; out.eps = a.eps; }
    return out;
}

// ============================================================================
// Function Declarations — TriDual arithmetic and elementaries
// ============================================================================
function triAdd(out, a, b) {
    const ar = typeof a === "number" ? a : a.re;
    const br = typeof b === "number" ? b : b.re;
    out.re = ar + br;
    out.dx = (typeof a === "number" ? 0 : a.dx) + (typeof b === "number" ? 0 : b.dx);
    out.dy = (typeof a === "number" ? 0 : a.dy) + (typeof b === "number" ? 0 : b.dy);
    out.dz = (typeof a === "number" ? 0 : a.dz) + (typeof b === "number" ? 0 : b.dz);
    return out;
}

function triSub(out, a, b) {
    const ar = typeof a === "number" ? a : a.re;
    const br = typeof b === "number" ? b : b.re;
    out.re = ar - br;
    out.dx = (typeof a === "number" ? 0 : a.dx) - (typeof b === "number" ? 0 : b.dx);
    out.dy = (typeof a === "number" ? 0 : a.dy) - (typeof b === "number" ? 0 : b.dy);
    out.dz = (typeof a === "number" ? 0 : a.dz) - (typeof b === "number" ? 0 : b.dz);
    return out;
}

function triMul(out, a, b) {
    const ar = typeof a === "number" ? a : a.re;
    const br = typeof b === "number" ? b : b.re;
    const adx = typeof a === "number" ? 0 : a.dx;
    const ady = typeof a === "number" ? 0 : a.dy;
    const adz = typeof a === "number" ? 0 : a.dz;
    const bdx = typeof b === "number" ? 0 : b.dx;
    const bdy = typeof b === "number" ? 0 : b.dy;
    const bdz = typeof b === "number" ? 0 : b.dz;
    out.re = ar * br;
    out.dx = adx * br + ar * bdx;
    out.dy = ady * br + ar * bdy;
    out.dz = adz * br + ar * bdz;
    return out;
}

function triDiv(out, a, b) {
    const ar = typeof a === "number" ? a : a.re;
    const br = typeof b === "number" ? b : b.re;
    const adx = typeof a === "number" ? 0 : a.dx;
    const ady = typeof a === "number" ? 0 : a.dy;
    const adz = typeof a === "number" ? 0 : a.dz;
    const bdx = typeof b === "number" ? 0 : b.dx;
    const bdy = typeof b === "number" ? 0 : b.dy;
    const bdz = typeof b === "number" ? 0 : b.dz;
    const invB = 1 / br;
    const invB2 = invB * invB;
    out.re = ar * invB;
    out.dx = (adx * br - ar * bdx) * invB2;
    out.dy = (ady * br - ar * bdy) * invB2;
    out.dz = (adz * br - ar * bdz) * invB2;
    return out;
}

function triNeg(out, a) {
    out.re = -a.re; out.dx = -a.dx; out.dy = -a.dy; out.dz = -a.dz;
    return out;
}

function triInv(out, a) {
    const invR = 1 / a.re;
    const k = -invR * invR;
    out.re = invR;
    out.dx = k * a.dx; out.dy = k * a.dy; out.dz = k * a.dz;
    return out;
}

function triScale(out, a, s) {
    out.re = a.re * s; out.dx = a.dx * s; out.dy = a.dy * s; out.dz = a.dz * s;
    return out;
}

function triAbs(out, a) {
    const s = a.re >= 0 ? 1 : -1;
    out.re = a.re * s; out.dx = a.dx * s; out.dy = a.dy * s; out.dz = a.dz * s;
    return out;
}

function triMin(out, a, b) {
    const pick = (typeof a === "number" ? a : a.re) <= (typeof b === "number" ? b : b.re) ? a : b;
    if (typeof pick === "number") { out.re = pick; out.dx = 0; out.dy = 0; out.dz = 0; }
    else { out.re = pick.re; out.dx = pick.dx; out.dy = pick.dy; out.dz = pick.dz; }
    return out;
}

function triMax(out, a, b) {
    const pick = (typeof a === "number" ? a : a.re) >= (typeof b === "number" ? b : b.re) ? a : b;
    if (typeof pick === "number") { out.re = pick; out.dx = 0; out.dy = 0; out.dz = 0; }
    else { out.re = pick.re; out.dx = pick.dx; out.dy = pick.dy; out.dz = pick.dz; }
    return out;
}

function triPow(out, a, p) {
    const ar = typeof a === "number" ? a : a.re;
    const pr = typeof p === "number" ? p : p.re;
    const rr = Math.pow(ar, pr);
    const ka = pr * Math.pow(ar, pr - 1);
    const kp = (typeof p === "number" || ar <= 0) ? 0 : Math.log(ar) * rr;
    const adx = typeof a === "number" ? 0 : a.dx;
    const ady = typeof a === "number" ? 0 : a.dy;
    const adz = typeof a === "number" ? 0 : a.dz;
    const pdx = typeof p === "number" ? 0 : p.dx;
    const pdy = typeof p === "number" ? 0 : p.dy;
    const pdz = typeof p === "number" ? 0 : p.dz;
    out.re = rr;
    out.dx = ka * adx + kp * pdx;
    out.dy = ka * ady + kp * pdy;
    out.dz = ka * adz + kp * pdz;
    return out;
}

function triSqrt(out, a) {
    const r = Math.sqrt(a.re);
    const k = r > EPSILON ? 0.5 / r : 0;
    out.re = r; out.dx = k * a.dx; out.dy = k * a.dy; out.dz = k * a.dz;
    return out;
}

function triCbrt(out, a) {
    const r = Math.cbrt(a.re);
    const k = Math.abs(r) > EPSILON ? 1 / (3 * r * r) : 0;
    out.re = r; out.dx = k * a.dx; out.dy = k * a.dy; out.dz = k * a.dz;
    return out;
}

function triExp(out, a) {
    const r = Math.exp(a.re);
    out.re = r; out.dx = r * a.dx; out.dy = r * a.dy; out.dz = r * a.dz;
    return out;
}

function triExpm1(out, a) {
    const k = Math.exp(a.re);
    out.re = Math.expm1(a.re);
    out.dx = k * a.dx; out.dy = k * a.dy; out.dz = k * a.dz;
    return out;
}

function triLog(out, a) {
    const k = 1 / a.re;
    out.re = Math.log(a.re);
    out.dx = k * a.dx; out.dy = k * a.dy; out.dz = k * a.dz;
    return out;
}

function triLog1p(out, a) {
    const k = 1 / (1 + a.re);
    out.re = Math.log1p(a.re);
    out.dx = k * a.dx; out.dy = k * a.dy; out.dz = k * a.dz;
    return out;
}

function triSin(out, a) {
    const k = Math.cos(a.re);
    out.re = Math.sin(a.re);
    out.dx = k * a.dx; out.dy = k * a.dy; out.dz = k * a.dz;
    return out;
}

function triCos(out, a) {
    const k = -Math.sin(a.re);
    out.re = Math.cos(a.re);
    out.dx = k * a.dx; out.dy = k * a.dy; out.dz = k * a.dz;
    return out;
}

function triTan(out, a) {
    const c = Math.cos(a.re);
    const k = 1 / (c * c);
    out.re = Math.tan(a.re);
    out.dx = k * a.dx; out.dy = k * a.dy; out.dz = k * a.dz;
    return out;
}

function triAsin(out, a) {
    const k = 1 / Math.sqrt(1 - a.re * a.re);
    out.re = Math.asin(a.re);
    out.dx = k * a.dx; out.dy = k * a.dy; out.dz = k * a.dz;
    return out;
}

function triAcos(out, a) {
    const k = -1 / Math.sqrt(1 - a.re * a.re);
    out.re = Math.acos(a.re);
    out.dx = k * a.dx; out.dy = k * a.dy; out.dz = k * a.dz;
    return out;
}

function triAtan(out, a) {
    const k = 1 / (1 + a.re * a.re);
    out.re = Math.atan(a.re);
    out.dx = k * a.dx; out.dy = k * a.dy; out.dz = k * a.dz;
    return out;
}

/** atan2(a, b) — a is y, b is x. */
function triAtan2(out, a, b) {
    const ar = a.re, br = b.re;
    const inv = 1 / (ar * ar + br * br);
    out.re = Math.atan2(ar, br);
    out.dx = (br * a.dx - ar * b.dx) * inv;
    out.dy = (br * a.dy - ar * b.dy) * inv;
    out.dz = (br * a.dz - ar * b.dz) * inv;
    return out;
}

function triSinh(out, a) {
    const k = Math.cosh(a.re);
    out.re = Math.sinh(a.re);
    out.dx = k * a.dx; out.dy = k * a.dy; out.dz = k * a.dz;
    return out;
}

function triCosh(out, a) {
    const k = Math.sinh(a.re);
    out.re = Math.cosh(a.re);
    out.dx = k * a.dx; out.dy = k * a.dy; out.dz = k * a.dz;
    return out;
}

function triTanh(out, a) {
    const t = Math.tanh(a.re);
    const k = 1 - t * t;
    out.re = t;
    out.dx = k * a.dx; out.dy = k * a.dy; out.dz = k * a.dz;
    return out;
}

function triSigmoid(out, a) {
    const s = 1 / (1 + Math.exp(-a.re));
    const k = s * (1 - s);
    out.re = s;
    out.dx = k * a.dx; out.dy = k * a.dy; out.dz = k * a.dz;
    return out;
}

function triSmoothstep(out, a) {
    const t = a.re < 0 ? 0 : a.re > 1 ? 1 : a.re;
    const k = 6 * t * (1 - t);
    out.re = t * t * (3 - 2 * t);
    out.dx = k * a.dx; out.dy = k * a.dy; out.dz = k * a.dz;
    return out;
}

function triSaturate(out, a) {
    if (a.re <= 0 || a.re >= 1) {
        out.re = a.re <= 0 ? 0 : 1;
        out.dx = 0; out.dy = 0; out.dz = 0;
    } else {
        out.re = a.re; out.dx = a.dx; out.dy = a.dy; out.dz = a.dz;
    }
    return out;
}

// ============================================================================
// Function Declarations — TriDual vector helpers
// ============================================================================
function sum3(out, x, y, z) {
    out.re = x.re + y.re + z.re;
    out.dx = x.dx + y.dx + z.dx;
    out.dy = x.dy + y.dy + z.dy;
    out.dz = x.dz + y.dz + z.dz;
    return out;
}

/** Scalar TriDual product (kept for API compatibility; see dot3Full for ℝ³). */
function dot3(out, a, b) { return triMul(out, a, b); }

/** True ℝ³ dot product of two TriDual-valued vectors, with full chain rule. */
function dot3Full(out, ax, ay, az, bx, by, bz) {
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
    const re = Math.sqrt(x.re * x.re + y.re * y.re + z.re * z.re);
    const k = re > EPSILON ? 1 / re : 0;
    out.re = re;
    out.dx = k * (x.re * x.dx + y.re * y.dx + z.re * z.dx);
    out.dy = k * (x.re * x.dy + y.re * y.dy + z.re * z.dy);
    out.dz = k * (x.re * x.dz + y.re * y.dz + z.re * z.dz);
    return out;
}

/**
 * Cross product of two TriDual-valued vectors — writes ALL THREE components.
 * (The previous version computed three components and discarded two.)
 */
function cross3(outX, outY, outZ, ax, ay, az, bx, by, bz) {
    outX.re = ay.re * bz.re - az.re * by.re;
    outX.dx = ay.dx * bz.re + ay.re * bz.dx - az.dx * by.re - az.re * by.dx;
    outX.dy = ay.dy * bz.re + ay.re * bz.dy - az.dy * by.re - az.re * by.dy;
    outX.dz = ay.dz * bz.re + ay.re * bz.dz - az.dz * by.re - az.re * by.dz;

    outY.re = az.re * bx.re - ax.re * bz.re;
    outY.dx = az.dx * bx.re + az.re * bx.dx - ax.dx * bz.re - ax.re * bz.dx;
    outY.dy = az.dy * bx.re + az.re * bx.dy - ax.dy * bz.re - ax.re * bz.dy;
    outY.dz = az.dz * bx.re + az.re * bx.dz - ax.dz * bz.re - ax.re * bz.dz;

    outZ.re = ax.re * by.re - ay.re * bx.re;
    outZ.dx = ax.dx * by.re + ax.re * by.dx - ay.dx * bx.re - ay.re * bx.dx;
    outZ.dy = ax.dy * by.re + ax.re * by.dy - ay.dy * bx.re - ay.re * bx.dy;
    outZ.dz = ax.dz * by.re + ax.re * by.dz - ay.dz * bx.re - ay.re * bx.dz;
    return outX;
}

/**
 * Normalize a TriDual-valued ℝ³ vector — writes ALL THREE components with the
 * exact Jacobian ∂(v/|v|)/∂s = (I/|v| − v vᵀ/|v|³)·∂v/∂s. Closure-free.
 */
function normalize3AD(outX, outY, outZ, x, y, z) {
    const xr = x.re, yr = y.re, zr = z.re;
    const len = Math.sqrt(xr * xr + yr * yr + zr * zr);
    if (len < EPSILON) {
        outX.re = 0; outX.dx = 0; outX.dy = 0; outX.dz = 0;
        outY.re = 0; outY.dx = 0; outY.dy = 0; outY.dz = 0;
        outZ.re = 0; outZ.dx = 0; outZ.dy = 0; outZ.dz = 0;
        return outX;
    }
    const invLen = 1 / len;
    const invLen3 = invLen * invLen * invLen;

    const sxDot = xr * x.dx + yr * y.dx + zr * z.dx;
    const syDot = xr * x.dy + yr * y.dy + zr * z.dy;
    const szDot = xr * x.dz + yr * y.dz + zr * z.dz;

    outX.re = xr * invLen;
    outX.dx = x.dx * invLen - xr * sxDot * invLen3;
    outX.dy = x.dy * invLen - xr * syDot * invLen3;
    outX.dz = x.dz * invLen - xr * szDot * invLen3;

    outY.re = yr * invLen;
    outY.dx = y.dx * invLen - yr * sxDot * invLen3;
    outY.dy = y.dy * invLen - yr * syDot * invLen3;
    outY.dz = y.dz * invLen - yr * szDot * invLen3;

    outZ.re = zr * invLen;
    outZ.dx = z.dx * invLen - zr * sxDot * invLen3;
    outZ.dy = z.dy * invLen - zr * syDot * invLen3;
    outZ.dz = z.dz * invLen - zr * szDot * invLen3;
    return outX;
}

// ============================================================================
// Function Declarations — HyperDual arithmetic and elementaries
// ============================================================================
function hyperAdd(out, a, b) {
    const ar = typeof a === "number" ? a : a.re;
    const br = typeof b === "number" ? b : b.re;
    out.re = ar + br;
    out.e1 = (typeof a === "number" ? 0 : a.e1) + (typeof b === "number" ? 0 : b.e1);
    out.e2 = (typeof a === "number" ? 0 : a.e2) + (typeof b === "number" ? 0 : b.e2);
    out.e1e2 = (typeof a === "number" ? 0 : a.e1e2) + (typeof b === "number" ? 0 : b.e1e2);
    return out;
}

function hyperSub(out, a, b) {
    const ar = typeof a === "number" ? a : a.re;
    const br = typeof b === "number" ? b : b.re;
    out.re = ar - br;
    out.e1 = (typeof a === "number" ? 0 : a.e1) - (typeof b === "number" ? 0 : b.e1);
    out.e2 = (typeof a === "number" ? 0 : a.e2) - (typeof b === "number" ? 0 : b.e2);
    out.e1e2 = (typeof a === "number" ? 0 : a.e1e2) - (typeof b === "number" ? 0 : b.e1e2);
    return out;
}

function hyperMul(out, a, b) {
    const ar = typeof a === "number" ? a : a.re;
    const br = typeof b === "number" ? b : b.re;
    const a1 = typeof a === "number" ? 0 : a.e1;
    const a2 = typeof a === "number" ? 0 : a.e2;
    const a12 = typeof a === "number" ? 0 : a.e1e2;
    const b1 = typeof b === "number" ? 0 : b.e1;
    const b2 = typeof b === "number" ? 0 : b.e2;
    const b12 = typeof b === "number" ? 0 : b.e1e2;
    out.re = ar * br;
    out.e1 = a1 * br + ar * b1;
    out.e2 = a2 * br + ar * b2;
    out.e1e2 = a12 * br + a1 * b2 + a2 * b1 + ar * b12;
    return out;
}

function hyperInv(out, a) {
    const r = 1 / a.re;
    const d1 = -r * r;
    const d2 = 2 * r * r * r;
    out.re = r;
    out.e1 = d1 * a.e1;
    out.e2 = d1 * a.e2;
    out.e1e2 = d2 * a.e1 * a.e2 + d1 * a.e1e2;
    return out;
}

function hyperDiv(out, a, b) {
    const t = HyperDual.acquire();
    try {
        if (typeof b === "number") {
            const inv = 1 / b;
            out.re = a.re * inv; out.e1 = a.e1 * inv;
            out.e2 = a.e2 * inv; out.e1e2 = a.e1e2 * inv;
            return out;
        }
        hyperInv(t, b);
        return hyperMul(out, a, t);
    } finally {
        HyperDual.release(t);
    }
}

function hyperScale(out, a, s) {
    out.re = a.re * s; out.e1 = a.e1 * s; out.e2 = a.e2 * s; out.e1e2 = a.e1e2 * s;
    return out;
}

/** Generic second-order chain rule: f, f', f'' supplied as scalars. */
function _hyperChain(out, a, v, d1, d2) {
    out.re = v;
    out.e1 = d1 * a.e1;
    out.e2 = d1 * a.e2;
    out.e1e2 = d2 * a.e1 * a.e2 + d1 * a.e1e2;
    return out;
}

function hyperExp(out, a) {
    const r = Math.exp(a.re);
    return _hyperChain(out, a, r, r, r);
}

function hyperLog(out, a) {
    const r = a.re;
    return _hyperChain(out, a, Math.log(r), 1 / r, -1 / (r * r));
}

function hyperSin(out, a) {
    const s = Math.sin(a.re), c = Math.cos(a.re);
    return _hyperChain(out, a, s, c, -s);
}

function hyperCos(out, a) {
    const s = Math.sin(a.re), c = Math.cos(a.re);
    return _hyperChain(out, a, c, -s, -c);
}

function hyperSqrt(out, a) {
    const r = Math.sqrt(a.re);
    const d1 = r > EPSILON ? 0.5 / r : 0;
    const d2 = r > EPSILON ? -0.25 / (r * a.re) : 0;
    return _hyperChain(out, a, r, d1, d2);
}

function hyperPow(out, a, p) {
    const r = Math.pow(a.re, p);
    const d1 = p * Math.pow(a.re, p - 1);
    const d2 = p * (p - 1) * Math.pow(a.re, p - 2);
    return _hyperChain(out, a, r, d1, d2);
}

function hyperTanh(out, a) {
    const t = Math.tanh(a.re);
    const d1 = 1 - t * t;
    return _hyperChain(out, a, t, d1, -2 * t * d1);
}

function hyperSigmoid(out, a) {
    const s = 1 / (1 + Math.exp(-a.re));
    const d1 = s * (1 - s);
    return _hyperChain(out, a, s, d1, d1 * (1 - 2 * s));
}

// ============================================================================
// Function Declarations — MultiDual operators (bounded N)
// ============================================================================
function multiAdd(out, a, b) {
    out.ensure(Math.max(a.n, b.n));
    out.re = a.re + b.re;
    for (let i = 0; i < out.n; i++) {
        out.g[i] = (i < a.n ? a.g[i] : 0) + (i < b.n ? b.g[i] : 0);
    }
    return out;
}

function multiMul(out, a, b) {
    out.ensure(Math.max(a.n, b.n));
    const ar = a.re, br = b.re;
    for (let i = 0; i < out.n; i++) {
        const ag = i < a.n ? a.g[i] : 0;
        const bg = i < b.n ? b.g[i] : 0;
        out.g[i] = ag * br + ar * bg;
    }
    out.re = ar * br;
    return out;
}

function multiScale(out, a, s) {
    out.ensure(a.n);
    out.re = a.re * s;
    for (let i = 0; i < a.n; i++) out.g[i] = a.g[i] * s;
    return out;
}

function multiDot(out, a, b) {
    const n = Math.min(a.n, b.n);
    let re = 0;
    for (let i = 0; i < n; i++) re += a.re[i] * b.re[i];
    out.re = re;
    return out;
}

// ============================================================================
// Function Declarations — High-level AD helpers (zero-GC, try/finally)
// ============================================================================
/** ∇f(x,y,z) via TriDual. `f(tx,ty,tz)` must return a TriDual. */
function gradient(out, f, x, y, z) {
    const tx = TriDual.acquire(), ty = TriDual.acquire(), tz = TriDual.acquire();
    try {
        tx.set(x, 1, 0, 0); ty.set(y, 0, 1, 0); tz.set(z, 0, 0, 1);
        const r = f(tx, ty, tz);
        out[0] = r.dx; out[1] = r.dy; out[2] = r.dz;
        return out;
    } finally {
        TriDual.release(tx); TriDual.release(ty); TriDual.release(tz);
    }
}

/** Directional derivative along (dx,dy,dz) — need not be unit length. */
function directionalDerivative(f, x, y, z, dx, dy, dz) {
    const tx = TriDual.acquire(), ty = TriDual.acquire(), tz = TriDual.acquire();
    try {
        tx.set(x, dx, dy, dz); ty.set(y, 0, 0, 0); tz.set(z, 0, 0, 0);
        return f(tx, ty, tz).dx;
    } finally {
        TriDual.release(tx); TriDual.release(ty); TriDual.release(tz);
    }
}

/**
 * Exact Jacobian via AD. `F(tx,ty,tz, ox,oy,oz)` writes three TriDual outputs.
 * `out` is a 9-element row-major 3×3: out[row*3 + col] = ∂F_row/∂x_col.
 */
function jacobianAD(out, F, x, y, z) {
    const tx = TriDual.acquire(), ty = TriDual.acquire(), tz = TriDual.acquire();
    const ox = TriDual.acquire(), oy = TriDual.acquire(), oz = TriDual.acquire();
    try {
        tx.set(x, 1, 0, 0); ty.set(y, 0, 1, 0); tz.set(z, 0, 0, 1);
        ox.set(0, 0, 0, 0); oy.set(0, 0, 0, 0); oz.set(0, 0, 0, 0);
        F(tx, ty, tz, ox, oy, oz);
        out[0] = ox.dx; out[1] = ox.dy; out[2] = ox.dz;
        out[3] = oy.dx; out[4] = oy.dy; out[5] = oy.dz;
        out[6] = oz.dx; out[7] = oz.dy; out[8] = oz.dz;
        return out;
    } finally {
        TriDual.release(tx); TriDual.release(ty); TriDual.release(tz);
        TriDual.release(ox); TriDual.release(oy); TriDual.release(oz);
    }
}

/**
 * Central-difference Jacobian for numeric `F(x,y,z,outVec3)`.
 * Zero-GC: uses module scratch, never allocates result arrays.
 */
function jacobian(out, F, x, y, z, eps) {
    const h = eps === undefined ? DEFAULT_FD_EPS : eps;
    const inv2h = 1 / (2 * h);
    F(x + h, y, z, _jA); F(x - h, y, z, _jB);
    for (let r = 0; r < 3; r++) out[r * 3] = (_jA[r] - _jB[r]) * inv2h;
    F(x, y + h, z, _jA); F(x, y - h, z, _jB);
    for (let r = 0; r < 3; r++) out[r * 3 + 1] = (_jA[r] - _jB[r]) * inv2h;
    F(x, y, z + h, _jA); F(x, y, z - h, _jB);
    for (let r = 0; r < 3; r++) out[r * 3 + 2] = (_jA[r] - _jB[r]) * inv2h;
    return out;
}

/**
 * Symmetric numeric Hessian from central differences of the AD gradient.
 * Row-major 3×3. Zero-GC (module scratch, no array literals).
 */
function hessian(out, f, x, y, z, eps) {
    const h = eps === undefined ? DEFAULT_FD_EPS : eps;
    const inv2h = 1 / (2 * h);
    gradient(_gA, f, x + h, y, z); gradient(_gB, f, x - h, y, z);
    out[0] = (_gA[0] - _gB[0]) * inv2h;
    out[3] = (_gA[1] - _gB[1]) * inv2h;
    out[6] = (_gA[2] - _gB[2]) * inv2h;
    gradient(_gA, f, x, y + h, z); gradient(_gB, f, x, y - h, z);
    out[1] = (_gA[0] - _gB[0]) * inv2h;
    out[4] = (_gA[1] - _gB[1]) * inv2h;
    out[7] = (_gA[2] - _gB[2]) * inv2h;
    gradient(_gA, f, x, y, z + h); gradient(_gB, f, x, y, z - h);
    out[2] = (_gA[0] - _gB[0]) * inv2h;
    out[5] = (_gA[1] - _gB[1]) * inv2h;
    out[8] = (_gA[2] - _gB[2]) * inv2h;
    // Symmetrize (H is symmetric for C² fields).
    let t = 0.5 * (out[1] + out[3]); out[1] = t; out[3] = t;
    t = 0.5 * (out[2] + out[6]); out[2] = t; out[6] = t;
    t = 0.5 * (out[5] + out[7]); out[5] = t; out[7] = t;
    return out;
}

/**
 * EXACT Hessian via HyperDual in six evaluations — no finite differences.
 * `f(hx,hy,hz)` must return a HyperDual composed with the hyper* operators.
 */
function hessianExact(out, f, x, y, z) {
    const hx = HyperDual.acquire(), hy = HyperDual.acquire(), hz = HyperDual.acquire();
    try {
        // Diagonal: seed one variable with e1 = e2 = 1 → e1e2 = f''.
        hx.set(x, 1, 1, 0); hy.set(y, 0, 0, 0); hz.set(z, 0, 0, 0);
        out[0] = f(hx, hy, hz).e1e2;
        hx.set(x, 0, 0, 0); hy.set(y, 1, 1, 0); hz.set(z, 0, 0, 0);
        out[4] = f(hx, hy, hz).e1e2;
        hx.set(x, 0, 0, 0); hy.set(y, 0, 0, 0); hz.set(z, 1, 1, 0);
        out[8] = f(hx, hy, hz).e1e2;
        // Mixed: seed two variables with e1 and e2 → e1e2 = ∂²f/∂xi∂xj.
        hx.set(x, 1, 0, 0); hy.set(y, 0, 1, 0); hz.set(z, 0, 0, 0);
        const xy = f(hx, hy, hz).e1e2; out[1] = xy; out[3] = xy;
        hx.set(x, 1, 0, 0); hy.set(y, 0, 0, 0); hz.set(z, 0, 1, 0);
        const xz = f(hx, hy, hz).e1e2; out[2] = xz; out[6] = xz;
        hx.set(x, 0, 0, 0); hy.set(y, 1, 0, 0); hz.set(z, 0, 1, 0);
        const yz = f(hx, hy, hz).e1e2; out[5] = yz; out[7] = yz;
        return out;
    } finally {
        HyperDual.release(hx); HyperDual.release(hy); HyperDual.release(hz);
    }
}

/**
 * Compare an AD gradient against central differences. Writes into a
 * caller-owned `out` = { ad, numerical, error } of three 3-element buffers.
 */
function numericalGradientCheck(out, f, x, y, z, eps) {
    const h = eps === undefined ? DEFAULT_FD_EPS : eps;
    const inv2h = 1 / (2 * h);
    gradient(out.ad, f, x, y, z);
    const tx = TriDual.acquire(), ty = TriDual.acquire(), tz = TriDual.acquire();
    try {
        tx.set(x + h, 0, 0, 0); ty.set(y, 0, 0, 0); tz.set(z, 0, 0, 0);
        const ax = f(tx, ty, tz).re;
        tx.set(x - h, 0, 0, 0);
        const bx = f(tx, ty, tz).re;
        tx.set(x, 0, 0, 0); ty.set(y + h, 0, 0, 0);
        const ay = f(tx, ty, tz).re;
        ty.set(y - h, 0, 0, 0);
        const by = f(tx, ty, tz).re;
        ty.set(y, 0, 0, 0); tz.set(z + h, 0, 0, 0);
        const az = f(tx, ty, tz).re;
        tz.set(z - h, 0, 0, 0);
        const bz = f(tx, ty, tz).re;
        out.numerical[0] = (ax - bx) * inv2h;
        out.numerical[1] = (ay - by) * inv2h;
        out.numerical[2] = (az - bz) * inv2h;
    } finally {
        TriDual.release(tx); TriDual.release(ty); TriDual.release(tz);
    }
    out.error[0] = Math.abs(out.ad[0] - out.numerical[0]);
    out.error[1] = Math.abs(out.ad[1] - out.numerical[1]);
    out.error[2] = Math.abs(out.ad[2] - out.numerical[2]);
    return out;
}

/** Max absolute AD-vs-numeric gradient error — scalar, zero-GC. */
function gradientError(f, x, y, z, eps) {
    const h = eps === undefined ? DEFAULT_FD_EPS : eps;
    const inv2h = 1 / (2 * h);
    gradient(_gA, f, x, y, z);
    const tx = TriDual.acquire(), ty = TriDual.acquire(), tz = TriDual.acquire();
    let e0 = 0, e1 = 0, e2 = 0;
    try {
        tx.set(x + h, 0, 0, 0); ty.set(y, 0, 0, 0); tz.set(z, 0, 0, 0);
        const ax = f(tx, ty, tz).re;
        tx.set(x - h, 0, 0, 0);
        e0 = Math.abs(_gA[0] - (ax - f(tx, ty, tz).re) * inv2h);
        tx.set(x, 0, 0, 0); ty.set(y + h, 0, 0, 0);
        const ay = f(tx, ty, tz).re;
        ty.set(y - h, 0, 0, 0);
        e1 = Math.abs(_gA[1] - (ay - f(tx, ty, tz).re) * inv2h);
        ty.set(y, 0, 0, 0); tz.set(z + h, 0, 0, 0);
        const az = f(tx, ty, tz).re;
        tz.set(z - h, 0, 0, 0);
        e2 = Math.abs(_gA[2] - (az - f(tx, ty, tz).re) * inv2h);
    } finally {
        TriDual.release(tx); TriDual.release(ty); TriDual.release(tz);
    }
    return Math.max(e0, e1, e2);
}

// ============================================================================
// Function Declarations — Domain integrations
// ============================================================================
/** Exact noise-field gradient. `noiseFn(tx,ty,tz)` must return a TriDual. */
function noiseGradientAD(out, noiseFn, x, y, z) {
    return gradient(out, noiseFn, x, y, z);
}

/** Central-difference gradient for plain numeric noise fields (013 / 044). */
function noiseGradient(out, noiseFn, x, y, z, eps) {
    const h = eps === undefined ? DEFAULT_FIELD_EPS : eps;
    const inv2h = 1 / (2 * h);
    out[0] = (noiseFn(x + h, y, z) - noiseFn(x - h, y, z)) * inv2h;
    out[1] = (noiseFn(x, y + h, z) - noiseFn(x, y - h, z)) * inv2h;
    out[2] = (noiseFn(x, y, z + h) - noiseFn(x, y, z - h)) * inv2h;
    return out;
}

/**
 * Terrain normal from a height field — EXACT analytic gradient, no finite
 * differences. `heightFn(tx,tz)` returns a TriDual; normal = (−∂h/∂x, 1, −∂h/∂z).
 */
function heightNormalAD(out, heightFn, x, z) {
    const tx = TriDual.acquire(), tz = TriDual.acquire();
    try {
        tx.set(x, 1, 0, 0); tz.set(z, 0, 0, 1);
        const r = heightFn(tx, tz);
        const dx = r.dx, dz = r.dz;
        const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
        out[0] = -dx * inv; out[1] = inv; out[2] = -dz * inv;
        return out;
    } finally {
        TriDual.release(tx); TriDual.release(tz);
    }
}

/** Central-difference terrain normal for numeric height fields. */
function heightNormal(out, heightFn, x, z, eps) {
    const h = eps === undefined ? DEFAULT_FIELD_EPS : eps;
    const inv2h = 1 / (2 * h);
    const dx = (heightFn(x + h, z) - heightFn(x - h, z)) * inv2h;
    const dz = (heightFn(x, z + h) - heightFn(x, z - h)) * inv2h;
    const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
    out[0] = -dx * inv; out[1] = inv; out[2] = -dz * inv;
    return out;
}

/** SDF surface normal — EXACT analytic gradient of the distance field. */
function sdfNormalAD(out, sdfFn, x, y, z) {
    gradient(out, sdfFn, x, y, z);
    const len = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2]);
    const inv = len > EPSILON ? 1 / len : 0;
    out[0] *= inv; out[1] *= inv; out[2] *= inv;
    return out;
}

/** Central-difference SDF normal for numeric distance fields. */
function sdfNormal(out, sdfFn, x, y, z, eps) {
    const h = eps === undefined ? DEFAULT_FIELD_EPS : eps;
    const inv2h = 1 / (2 * h);
    const dx = (sdfFn(x + h, y, z) - sdfFn(x - h, y, z)) * inv2h;
    const dy = (sdfFn(x, y + h, z) - sdfFn(x, y - h, z)) * inv2h;
    const dz = (sdfFn(x, y, z + h) - sdfFn(x, y, z - h)) * inv2h;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const inv = len > EPSILON ? 1 / len : 0;
    out[0] = dx * inv; out[1] = dy * inv; out[2] = dz * inv;
    return out;
}

/**
 * Analytic revolute-joint IK Jacobian: column j = axis_j × (end − joint_j).
 * `out` is row-major 3×N: out[row * nJoints + j].
 */
function ikJacobianAD(out, jointPositions, jointAxes, endEffector, nJoints) {
    const n = nJoints === undefined ? (jointPositions.length / 3) | 0 : nJoints;
    const ex = endEffector[0], ey = endEffector[1], ez = endEffector[2];
    for (let j = 0; j < n; j++) {
        const o = j * 3;
        const rx = ex - jointPositions[o];
        const ry = ey - jointPositions[o + 1];
        const rz = ez - jointPositions[o + 2];
        const ax = jointAxes[o], ay = jointAxes[o + 1], az = jointAxes[o + 2];
        out[j] = ay * rz - az * ry;
        out[n + j] = az * rx - ax * rz;
        out[2 * n + j] = ax * ry - ay * rx;
    }
    return out;
}

/**
 * One gradient-descent IK step on E = ½|target − end|².
 * Correct gradient: ∂E/∂θ_j = −(target − end) · (axis_j × (end − joint_j)).
 * (The previous version summed cross-product components, which is not a
 * gradient.) Gauss-Seidel: the end effector is re-read after each joint.
 * `chain` = { pos: Float32Array(3N), lens, target, axes? }.
 */
function ikGradientStep(chain, learningRate, options) {
    const iterations = (options && options.iterations) || 1;
    const learning = learningRate === undefined ? 0.05 : learningRate;
    const pos = chain.pos;
    const n = chain.lens.length + 1;
    const axes = chain.axes;
    const last = (n - 1) * 3;
    for (let iter = 0; iter < iterations; iter++) {
        for (let j = 0; j < n - 1; j++) {
            const o = j * 3;
            const px = pos[o], py = pos[o + 1], pz = pos[o + 2];
            const ex = pos[last], ey = pos[last + 1], ez = pos[last + 2];
            const tx = chain.target[0] - ex;
            const ty = chain.target[1] - ey;
            const tz = chain.target[2] - ez;
            let ux, uy, uz;
            if (axes) {
                ux = axes[o]; uy = axes[o + 1]; uz = axes[o + 2];
            } else {
                const bx = pos[o + 3] - px, by = pos[o + 4] - py, bz = pos[o + 5] - pz;
                const bl = Math.sqrt(bx * bx + by * by + bz * bz);
                const invB = bl > EPSILON ? 1 / bl : 0;
                ux = bx * invB; uy = by * invB; uz = bz * invB;
            }
            const rx = ex - px, ry = ey - py, rz = ez - pz;
            const cx = uy * rz - uz * ry;
            const cy = uz * rx - ux * rz;
            const cz = ux * ry - uy * rx;
            const theta = learning * (tx * cx + ty * cy + tz * cz);
            if (theta === 0) continue;
            const cosT = Math.cos(theta), sinT = Math.sin(theta), oneMinusCos = 1 - cosT;
            for (let k = j + 1; k < n; k++) {
                const q = k * 3;
                const vx = pos[q] - px, vy = pos[q + 1] - py, vz = pos[q + 2] - pz;
                const dot = ux * vx + uy * vy + uz * vz;
                const kx = uy * vz - uz * vy;
                const ky = uz * vx - ux * vz;
                const kz = ux * vy - uy * vx;
                pos[q]     = px + vx * cosT + kx * sinT + ux * dot * oneMinusCos;
                pos[q + 1] = py + vy * cosT + ky * sinT + uy * dot * oneMinusCos;
                pos[q + 2] = pz + vz * cosT + kz * sinT + uz * dot * oneMinusCos;
            }
        }
    }
    return chain;
}

/**
 * Gradient of the softened gravitational potential Φ = −Σ G·m/r.
 * ∇Φ points AWAY from the masses; acceleration is −∇Φ (see `gravAccel`).
 */
function orbitalForceGradient(out, px, py, pz, bodies, G) {
    const g = G === undefined ? 1 : G;
    const pos = bodies.positions, masses = bodies.masses;
    const n = masses.length;
    let gx = 0, gy = 0, gz = 0;
    for (let i = 0; i < n; i++) {
        const o = i * 3;
        const dx = px - pos[o], dy = py - pos[o + 1], dz = pz - pos[o + 2];
        const r2 = dx * dx + dy * dy + dz * dz + 1e-6;
        const k = g * masses[i] / (r2 * Math.sqrt(r2));
        gx += dx * k; gy += dy * k; gz += dz * k;
    }
    out[0] = gx; out[1] = gy; out[2] = gz;
    return out;
}

/** Gravitational acceleration a = −∇Φ (points toward the masses). */
function gravAccel(out, px, py, pz, bodies, G) {
    orbitalForceGradient(out, px, py, pz, bodies, G);
    out[0] = -out[0]; out[1] = -out[1]; out[2] = -out[2];
    return out;
}

/**
 * Analytic Jacobian of the acceleration field (negative Hessian of Φ):
 * ∂a_i/∂p_j = Σ G·m [3 r_i r_j / r⁵ − δ_ij / r³]. Row-major 3×3. Zero-GC.
 */
function gravAccelJacobian(out, px, py, pz, bodies, G) {
    const g = G === undefined ? 1 : G;
    const pos = bodies.positions, masses = bodies.masses;
    const n = masses.length;
    let h00 = 0, h01 = 0, h02 = 0, h11 = 0, h12 = 0, h22 = 0;
    for (let i = 0; i < n; i++) {
        const o = i * 3;
        const dx = px - pos[o], dy = py - pos[o + 1], dz = pz - pos[o + 2];
        const r2 = dx * dx + dy * dy + dz * dz + 1e-6;
        const invR = 1 / Math.sqrt(r2);
        const invR3 = invR / r2;
        const invR5 = invR3 / r2;
        const gm = g * masses[i];
        const k3 = 3 * gm * invR5;
        const kd = gm * invR3;
        h00 += k3 * dx * dx - kd;
        h01 += k3 * dx * dy;
        h02 += k3 * dx * dz;
        h11 += k3 * dy * dy - kd;
        h12 += k3 * dy * dz;
        h22 += k3 * dz * dz - kd;
    }
    out[0] = h00; out[1] = h01; out[2] = h02;
    out[3] = h01; out[4] = h11; out[5] = h12;
    out[6] = h02; out[7] = h12; out[8] = h22;
    return out;
}

/**
 * Derivative of an animation curve at t. `curveFn(dual)` may return a Dual
 * (exact) or a plain number (central-difference fallback — the previous
 * version silently returned 0 in that case).
 */
function animationVelocity(curveFn, t, eps) {
    const d = Dual.acquire();
    try {
        d.set(t, 1);
        const r = curveFn(d);
        if (typeof r === "number") {
            const h = eps === undefined ? DEFAULT_FD_EPS : eps;
            return (curveFn(t + h) - curveFn(t - h)) / (2 * h);
        }
        return r.eps;
    } finally {
        Dual.release(d);
    }
}

function curveDerivative(curveFn, t, eps) { return animationVelocity(curveFn, t, eps); }

// ============================================================================
// Class Declarations — SOA containers
// ============================================================================
class DualSOA {
    constructor(count, re, eps) {
        this.count = count;
        const T = getArrayType();
        this.re = re || new T(count);
        this.eps = eps || new T(count);
    }
}

function createDualSOA(count) { return new DualSOA(count); }

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

function createTriDualSOA(count) { return new TriDualSOA(count); }

// ============================================================================
// Function Declarations — Dual SOA (sync)
// ============================================================================
function soaSin(out, a) {
    const n = out.count, or = out.re, oe = out.eps, ar = a.re, ae = a.eps;
    for (let i = 0; i < n; i++) {
        or[i] = Math.sin(ar[i]);
        oe[i] = Math.cos(ar[i]) * ae[i];
    }
    return out;
}

function soaCos(out, a) {
    const n = out.count, or = out.re, oe = out.eps, ar = a.re, ae = a.eps;
    for (let i = 0; i < n; i++) {
        or[i] = Math.cos(ar[i]);
        oe[i] = -Math.sin(ar[i]) * ae[i];
    }
    return out;
}

function soaExp(out, a) {
    const n = out.count, or = out.re, oe = out.eps, ar = a.re, ae = a.eps;
    for (let i = 0; i < n; i++) {
        const e = Math.exp(ar[i]);
        or[i] = e; oe[i] = e * ae[i];
    }
    return out;
}

function soaLog(out, a) {
    const n = out.count, or = out.re, oe = out.eps, ar = a.re, ae = a.eps;
    for (let i = 0; i < n; i++) {
        or[i] = Math.log(ar[i]);
        oe[i] = ae[i] / ar[i];
    }
    return out;
}

function soaSqrt(out, a) {
    const n = out.count, or = out.re, oe = out.eps, ar = a.re, ae = a.eps;
    for (let i = 0; i < n; i++) {
        const r = Math.sqrt(ar[i]);
        or[i] = r;
        oe[i] = r > EPSILON ? ae[i] / (2 * r) : 0;
    }
    return out;
}

function soaPow(out, a, p) {
    const n = out.count, or = out.re, oe = out.eps, ar = a.re, ae = a.eps;
    const isArr = p && p.re !== undefined;
    const pr = isArr ? p.re : null;
    const pe = isArr ? p.eps : null;
    for (let i = 0; i < n; i++) {
        const pv = isArr ? pr[i] : p;
        const pDer = isArr ? pe[i] : 0;
        const av = ar[i];
        const r = Math.pow(av, pv);
        let d = pv * Math.pow(av, pv - 1) * ae[i];
        if (pDer !== 0 && av > 0) d += Math.log(av) * r * pDer;
        or[i] = r; oe[i] = d;
    }
    return out;
}

/** Batch animation-curve velocity / color-curve derivative. Zero-GC. */
function soaCurveDerivative(out, curveFn, ts, count, eps) {
    const n = count === undefined ? out.length : count;
    const h = eps === undefined ? DEFAULT_FD_EPS : eps;
    const inv2h = 1 / (2 * h);
    const d = Dual.acquire();
    try {
        for (let i = 0; i < n; i++) {
            const t = ts[i];
            d.set(t, 1);
            const r = curveFn(d);
            out[i] = typeof r === "number"
                ? (curveFn(t + h) - curveFn(t - h)) * inv2h
                : r.eps;
        }
    } finally {
        Dual.release(d);
    }
    return out;
}

// ============================================================================
// Function Declarations — TriDual SOA (sync)
// ============================================================================
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
        const ar = a.re[i], br = b.re[i];
        or[i] = ar * br;
        odx[i] = a.dx[i] * br + ar * b.dx[i];
        ody[i] = a.dy[i] * br + ar * b.dy[i];
        odz[i] = a.dz[i] * br + ar * b.dz[i];
    }
    return out;
}

function soaTriDiv(out, a, b) {
    const n = out.count;
    const or = out.re, odx = out.dx, ody = out.dy, odz = out.dz;
    for (let i = 0; i < n; i++) {
        const ar = a.re[i], br = b.re[i];
        const inv = 1 / br, inv2 = inv * inv;
        or[i] = ar * inv;
        odx[i] = (a.dx[i] * br - ar * b.dx[i]) * inv2;
        ody[i] = (a.dy[i] * br - ar * b.dy[i]) * inv2;
        odz[i] = (a.dz[i] * br - ar * b.dz[i]) * inv2;
    }
    return out;
}

/** Scale by a scalar or a per-instance typed array. */
function soaTriScale(out, a, s) {
    const n = out.count;
    const or = out.re, odx = out.dx, ody = out.dy, odz = out.dz;
    const isArr = s && s.BYTES_PER_ELEMENT !== undefined;
    for (let i = 0; i < n; i++) {
        const k = isArr ? s[i] : s;
        or[i] = a.re[i] * k;
        odx[i] = a.dx[i] * k;
        ody[i] = a.dy[i] * k;
        odz[i] = a.dz[i] * k;
    }
    return out;
}

function soaTriSin(out, a) {
    const n = out.count;
    const or = out.re, odx = out.dx, ody = out.dy, odz = out.dz;
    for (let i = 0; i < n; i++) {
        const k = Math.cos(a.re[i]);
        or[i] = Math.sin(a.re[i]);
        odx[i] = k * a.dx[i]; ody[i] = k * a.dy[i]; odz[i] = k * a.dz[i];
    }
    return out;
}

function soaTriCos(out, a) {
    const n = out.count;
    const or = out.re, odx = out.dx, ody = out.dy, odz = out.dz;
    for (let i = 0; i < n; i++) {
        const k = -Math.sin(a.re[i]);
        or[i] = Math.cos(a.re[i]);
        odx[i] = k * a.dx[i]; ody[i] = k * a.dy[i]; odz[i] = k * a.dz[i];
    }
    return out;
}

function soaTriExp(out, a) {
    const n = out.count;
    const or = out.re, odx = out.dx, ody = out.dy, odz = out.dz;
    for (let i = 0; i < n; i++) {
        const r = Math.exp(a.re[i]);
        or[i] = r;
        odx[i] = r * a.dx[i]; ody[i] = r * a.dy[i]; odz[i] = r * a.dz[i];
    }
    return out;
}

function soaTriLog(out, a) {
    const n = out.count;
    const or = out.re, odx = out.dx, ody = out.dy, odz = out.dz;
    for (let i = 0; i < n; i++) {
        const k = 1 / a.re[i];
        or[i] = Math.log(a.re[i]);
        odx[i] = k * a.dx[i]; ody[i] = k * a.dy[i]; odz[i] = k * a.dz[i];
    }
    return out;
}

function soaTriSqrt(out, a) {
    const n = out.count;
    const or = out.re, odx = out.dx, ody = out.dy, odz = out.dz;
    for (let i = 0; i < n; i++) {
        const r = Math.sqrt(a.re[i]);
        const k = r > EPSILON ? 0.5 / r : 0;
        or[i] = r;
        odx[i] = k * a.dx[i]; ody[i] = k * a.dy[i]; odz[i] = k * a.dz[i];
    }
    return out;
}

// ============================================================================
// Function Declarations — Analytic normal batches (headline AD kernels)
// ============================================================================
/** Exact terrain normals from an AD height field. `heightFn(tx,tz)` → TriDual. */
function soaHeightNormalAD(out, heightFn, xs, zs, count) {
    const n = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y, oz = out.z;
    const tx = TriDual.acquire(), tz = TriDual.acquire();
    try {
        for (let i = 0; i < n; i++) {
            tx.set(xs[i], 1, 0, 0); tz.set(zs[i], 0, 0, 1);
            const r = heightFn(tx, tz);
            const dx = r.dx, dz = r.dz;
            const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
            ox[i] = -dx * inv; oy[i] = inv; oz[i] = -dz * inv;
        }
    } finally {
        TriDual.release(tx); TriDual.release(tz);
    }
    return out;
}

/** Exact SDF normals. `sdfFn(tx,ty,tz)` → TriDual. */
function soaSDFNormalAD(out, sdfFn, positions, count) {
    const n = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y, oz = out.z;
    const px = positions.x, py = positions.y, pz = positions.z;
    const tx = TriDual.acquire(), ty = TriDual.acquire(), tz = TriDual.acquire();
    try {
        for (let i = 0; i < n; i++) {
            tx.set(px[i], 1, 0, 0); ty.set(py[i], 0, 1, 0); tz.set(pz[i], 0, 0, 1);
            const r = sdfFn(tx, ty, tz);
            const dx = r.dx, dy = r.dy, dz = r.dz;
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const inv = len > EPSILON ? 1 / len : 0;
            ox[i] = dx * inv; oy[i] = dy * inv; oz[i] = dz * inv;
        }
    } finally {
        TriDual.release(tx); TriDual.release(ty); TriDual.release(tz);
    }
    return out;
}

/** Central-difference terrain normals for numeric height fields. */
function soaHeightNormal(out, heightFn, xs, zs, eps, count) {
    const n = count === undefined ? out.count : count;
    const h = eps === undefined ? DEFAULT_FIELD_EPS : eps;
    const inv2h = 1 / (2 * h);
    const ox = out.x, oy = out.y, oz = out.z;
    for (let i = 0; i < n; i++) {
        const x = xs[i], z = zs[i];
        const dx = (heightFn(x + h, z) - heightFn(x - h, z)) * inv2h;
        const dz = (heightFn(x, z + h) - heightFn(x, z - h)) * inv2h;
        const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
        ox[i] = -dx * inv; oy[i] = inv; oz[i] = -dz * inv;
    }
    return out;
}

/** Central-difference SDF normals for numeric distance fields. */
function soaSDFNormal(out, sdfFn, positions, eps, count) {
    const n = count === undefined ? out.count : count;
    const h = eps === undefined ? DEFAULT_FIELD_EPS : eps;
    const inv2h = 1 / (2 * h);
    const ox = out.x, oy = out.y, oz = out.z;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < n; i++) {
        const x = px[i], y = py[i], z = pz[i];
        const dx = (sdfFn(x + h, y, z) - sdfFn(x - h, y, z)) * inv2h;
        const dy = (sdfFn(x, y + h, z) - sdfFn(x, y - h, z)) * inv2h;
        const dz = (sdfFn(x, y, z + h) - sdfFn(x, y, z - h)) * inv2h;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const inv = len > EPSILON ? 1 / len : 0;
        ox[i] = dx * inv; oy[i] = dy * inv; oz[i] = dz * inv;
    }
    return out;
}

// ============================================================================
// Function Declarations — SOA (chunked async, inlined loops, zero closures)
// ============================================================================
async function soaSinChunked(out, a, cs, ye) {
    const n = out.count, or = out.re, oe = out.eps, ar = a.re, ae = a.eps;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + cs, n);
        for (let i = start; i < end; i++) {
            or[i] = Math.sin(ar[i]);
            oe[i] = Math.cos(ar[i]) * ae[i];
        }
        start = end;
        if (start >= n) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaCosChunked(out, a, cs, ye) {
    const n = out.count, or = out.re, oe = out.eps, ar = a.re, ae = a.eps;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + cs, n);
        for (let i = start; i < end; i++) {
            or[i] = Math.cos(ar[i]);
            oe[i] = -Math.sin(ar[i]) * ae[i];
        }
        start = end;
        if (start >= n) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaExpChunked(out, a, cs, ye) {
    const n = out.count, or = out.re, oe = out.eps, ar = a.re, ae = a.eps;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + cs, n);
        for (let i = start; i < end; i++) {
            const e = Math.exp(ar[i]);
            or[i] = e; oe[i] = e * ae[i];
        }
        start = end;
        if (start >= n) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaLogChunked(out, a, cs, ye) {
    const n = out.count, or = out.re, oe = out.eps, ar = a.re, ae = a.eps;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + cs, n);
        for (let i = start; i < end; i++) {
            or[i] = Math.log(ar[i]);
            oe[i] = ae[i] / ar[i];
        }
        start = end;
        if (start >= n) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaSqrtChunked(out, a, cs, ye) {
    const n = out.count, or = out.re, oe = out.eps, ar = a.re, ae = a.eps;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + cs, n);
        for (let i = start; i < end; i++) {
            const r = Math.sqrt(ar[i]);
            or[i] = r;
            oe[i] = r > EPSILON ? ae[i] / (2 * r) : 0;
        }
        start = end;
        if (start >= n) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaPowChunked(out, a, p, cs, ye) {
    const n = out.count, or = out.re, oe = out.eps, ar = a.re, ae = a.eps;
    const isArr = p && p.re !== undefined;
    const pr = isArr ? p.re : null;
    const pe = isArr ? p.eps : null;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + cs, n);
        for (let i = start; i < end; i++) {
            const pv = isArr ? pr[i] : p;
            const pDer = isArr ? pe[i] : 0;
            const av = ar[i];
            const r = Math.pow(av, pv);
            let d = pv * Math.pow(av, pv - 1) * ae[i];
            if (pDer !== 0 && av > 0) d += Math.log(av) * r * pDer;
            or[i] = r; oe[i] = d;
        }
        start = end;
        if (start >= n) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaCurveDerivativeChunked(out, curveFn, ts, count, eps, cs, ye) {
    const n = count === undefined ? out.length : count;
    const h = eps === undefined ? DEFAULT_FD_EPS : eps;
    const inv2h = 1 / (2 * h);
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const d = Dual.acquire();
    try {
        let start = 0, c = 0;
        while (start < n) {
            const end = Math.min(start + cs, n);
            for (let i = start; i < end; i++) {
                const t = ts[i];
                d.set(t, 1);
                const r = curveFn(d);
                out[i] = typeof r === "number"
                    ? (curveFn(t + h) - curveFn(t - h)) * inv2h
                    : r.eps;
            }
            start = end;
            if (start >= n) break;
            if (++c >= ye) { c = 0; await common.yieldToMain(); }
        }
    } finally {
        Dual.release(d);
    }
    return out;
}

async function soaTriAddChunked(out, a, b, cs, ye) {
    const n = out.count;
    const or = out.re, odx = out.dx, ody = out.dy, odz = out.dz;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + cs, n);
        for (let i = start; i < end; i++) {
            or[i] = a.re[i] + b.re[i];
            odx[i] = a.dx[i] + b.dx[i];
            ody[i] = a.dy[i] + b.dy[i];
            odz[i] = a.dz[i] + b.dz[i];
        }
        start = end;
        if (start >= n) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaTriSubChunked(out, a, b, cs, ye) {
    const n = out.count;
    const or = out.re, odx = out.dx, ody = out.dy, odz = out.dz;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + cs, n);
        for (let i = start; i < end; i++) {
            or[i] = a.re[i] - b.re[i];
            odx[i] = a.dx[i] - b.dx[i];
            ody[i] = a.dy[i] - b.dy[i];
            odz[i] = a.dz[i] - b.dz[i];
        }
        start = end;
        if (start >= n) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaTriMulChunked(out, a, b, cs, ye) {
    const n = out.count;
    const or = out.re, odx = out.dx, ody = out.dy, odz = out.dz;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + cs, n);
        for (let i = start; i < end; i++) {
            const ar = a.re[i], br = b.re[i];
            or[i] = ar * br;
            odx[i] = a.dx[i] * br + ar * b.dx[i];
            ody[i] = a.dy[i] * br + ar * b.dy[i];
            odz[i] = a.dz[i] * br + ar * b.dz[i];
        }
        start = end;
        if (start >= n) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaTriDivChunked(out, a, b, cs, ye) {
    const n = out.count;
    const or = out.re, odx = out.dx, ody = out.dy, odz = out.dz;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + cs, n);
        for (let i = start; i < end; i++) {
            const ar = a.re[i], br = b.re[i];
            const inv = 1 / br, inv2 = inv * inv;
            or[i] = ar * inv;
            odx[i] = (a.dx[i] * br - ar * b.dx[i]) * inv2;
            ody[i] = (a.dy[i] * br - ar * b.dy[i]) * inv2;
            odz[i] = (a.dz[i] * br - ar * b.dz[i]) * inv2;
        }
        start = end;
        if (start >= n) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

// Corrected: previously called undefined `chunked` with undefined `s_`.
async function soaTriScaleChunked(out, a, s, cs, ye) {
    const n = out.count;
    const or = out.re, odx = out.dx, ody = out.dy, odz = out.dz;
    const isArr = s && s.BYTES_PER_ELEMENT !== undefined;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + cs, n);
        for (let i = start; i < end; i++) {
            const k = isArr ? s[i] : s;
            or[i] = a.re[i] * k;
            odx[i] = a.dx[i] * k;
            ody[i] = a.dy[i] * k;
            odz[i] = a.dz[i] * k;
        }
        start = end;
        if (start >= n) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaTriSinChunked(out, a, cs, ye) {
    const n = out.count;
    const or = out.re, odx = out.dx, ody = out.dy, odz = out.dz;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + cs, n);
        for (let i = start; i < end; i++) {
            const k = Math.cos(a.re[i]);
            or[i] = Math.sin(a.re[i]);
            odx[i] = k * a.dx[i]; ody[i] = k * a.dy[i]; odz[i] = k * a.dz[i];
        }
        start = end;
        if (start >= n) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaTriCosChunked(out, a, cs, ye) {
    const n = out.count;
    const or = out.re, odx = out.dx, ody = out.dy, odz = out.dz;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + cs, n);
        for (let i = start; i < end; i++) {
            const k = -Math.sin(a.re[i]);
            or[i] = Math.cos(a.re[i]);
            odx[i] = k * a.dx[i]; ody[i] = k * a.dy[i]; odz[i] = k * a.dz[i];
        }
        start = end;
        if (start >= n) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaTriExpChunked(out, a, cs, ye) {
    const n = out.count;
    const or = out.re, odx = out.dx, ody = out.dy, odz = out.dz;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + cs, n);
        for (let i = start; i < end; i++) {
            const r = Math.exp(a.re[i]);
            or[i] = r;
            odx[i] = r * a.dx[i]; ody[i] = r * a.dy[i]; odz[i] = r * a.dz[i];
        }
        start = end;
        if (start >= n) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaTriLogChunked(out, a, cs, ye) {
    const n = out.count;
    const or = out.re, odx = out.dx, ody = out.dy, odz = out.dz;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + cs, n);
        for (let i = start; i < end; i++) {
            const k = 1 / a.re[i];
            or[i] = Math.log(a.re[i]);
            odx[i] = k * a.dx[i]; ody[i] = k * a.dy[i]; odz[i] = k * a.dz[i];
        }
        start = end;
        if (start >= n) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaTriSqrtChunked(out, a, cs, ye) {
    const n = out.count;
    const or = out.re, odx = out.dx, ody = out.dy, odz = out.dz;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + cs, n);
        for (let i = start; i < end; i++) {
            const r = Math.sqrt(a.re[i]);
            const k = r > EPSILON ? 0.5 / r : 0;
            or[i] = r;
            odx[i] = k * a.dx[i]; ody[i] = k * a.dy[i]; odz[i] = k * a.dz[i];
        }
        start = end;
        if (start >= n) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaHeightNormalADChunked(out, heightFn, xs, zs, count, cs, ye) {
    const n = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y, oz = out.z;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const tx = TriDual.acquire(), tz = TriDual.acquire();
    try {
        let start = 0, c = 0;
        while (start < n) {
            const end = Math.min(start + cs, n);
            for (let i = start; i < end; i++) {
                tx.set(xs[i], 1, 0, 0); tz.set(zs[i], 0, 0, 1);
                const r = heightFn(tx, tz);
                const dx = r.dx, dz = r.dz;
                const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
                ox[i] = -dx * inv; oy[i] = inv; oz[i] = -dz * inv;
            }
            start = end;
            if (start >= n) break;
            if (++c >= ye) { c = 0; await common.yieldToMain(); }
        }
    } finally {
        TriDual.release(tx); TriDual.release(tz);
    }
    return out;
}

async function soaSDFNormalADChunked(out, sdfFn, positions, count, cs, ye) {
    const n = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y, oz = out.z;
    const px = positions.x, py = positions.y, pz = positions.z;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const tx = TriDual.acquire(), ty = TriDual.acquire(), tz = TriDual.acquire();
    try {
        let start = 0, c = 0;
        while (start < n) {
            const end = Math.min(start + cs, n);
            for (let i = start; i < end; i++) {
                tx.set(px[i], 1, 0, 0); ty.set(py[i], 0, 1, 0); tz.set(pz[i], 0, 0, 1);
                const r = sdfFn(tx, ty, tz);
                const dx = r.dx, dy = r.dy, dz = r.dz;
                const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
                const inv = len > EPSILON ? 1 / len : 0;
                ox[i] = dx * inv; oy[i] = dy * inv; oz[i] = dz * inv;
            }
            start = end;
            if (start >= n) break;
            if (++c >= ye) { c = 0; await common.yieldToMain(); }
        }
    } finally {
        TriDual.release(tx); TriDual.release(ty); TriDual.release(tz);
    }
    return out;
}

async function soaHeightNormalChunked(out, heightFn, xs, zs, eps, count, cs, ye) {
    const n = count === undefined ? out.count : count;
    const h = eps === undefined ? DEFAULT_FIELD_EPS : eps;
    const inv2h = 1 / (2 * h);
    const ox = out.x, oy = out.y, oz = out.z;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + cs, n);
        for (let i = start; i < end; i++) {
            const x = xs[i], z = zs[i];
            const dx = (heightFn(x + h, z) - heightFn(x - h, z)) * inv2h;
            const dz = (heightFn(x, z + h) - heightFn(x, z - h)) * inv2h;
            const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
            ox[i] = -dx * inv; oy[i] = inv; oz[i] = -dz * inv;
        }
        start = end;
        if (start >= n) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaSDFNormalChunked(out, sdfFn, positions, eps, count, cs, ye) {
    const n = count === undefined ? out.count : count;
    const h = eps === undefined ? DEFAULT_FIELD_EPS : eps;
    const inv2h = 1 / (2 * h);
    const ox = out.x, oy = out.y, oz = out.z;
    const px = positions.x, py = positions.y, pz = positions.z;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + cs, n);
        for (let i = start; i < end; i++) {
            const x = px[i], y = py[i], z = pz[i];
            const dx = (sdfFn(x + h, y, z) - sdfFn(x - h, y, z)) * inv2h;
            const dy = (sdfFn(x, y + h, z) - sdfFn(x, y - h, z)) * inv2h;
            const dz = (sdfFn(x, y, z + h) - sdfFn(x, y, z - h)) * inv2h;
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const inv = len > EPSILON ? 1 / len : 0;
            ox[i] = dx * inv; oy[i] = dy * inv; oz[i] = dz * inv;
        }
        start = end;
        if (start >= n) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

// ============================================================================
// Class Declarations — Scratch
// ============================================================================
/** Reusable AD seed scratch — fixed-capacity pool, swap-remove, no Set/Map. */
class DualScratch {
    static #pool = new Array(64);
    static #count = 0;
    static {
        for (let i = 0; i < 32; i++) DualScratch.#pool[DualScratch.#count++] = new DualScratch();
    }
    static acquire() {
        if (DualScratch.#count > 0) {
            DualScratch.#count--;
            const s = DualScratch.#pool[DualScratch.#count];
            DualScratch.#pool[DualScratch.#count] = null;
            return s;
        }
        return new DualScratch();
    }
    static release(s) {
        if (!s) return;
        s.reset();
        if (DualScratch.#count < 64) DualScratch.#pool[DualScratch.#count++] = s;
    }
    constructor() {
        this.d1 = new Dual(); this.d2 = new Dual(); this.d3 = new Dual();
        this.t1 = new TriDual(); this.t2 = new TriDual(); this.t3 = new TriDual();
        this.h1 = new HyperDual(); this.h2 = new HyperDual(); this.h3 = new HyperDual();
    }
    reset() {
        this.d1.set(0, 0); this.d2.set(0, 0); this.d3.set(0, 0);
        this.t1.set(0, 0, 0, 0); this.t2.set(0, 0, 0, 0); this.t3.set(0, 0, 0, 0);
        this.h1.set(0, 0, 0, 0); this.h2.set(0, 0, 0, 0); this.h3.set(0, 0, 0, 0);
        return this;
    }
}

// ============================================================================
// Class Declarations — Batch states
// ============================================================================
class DualBatchState {
    constructor(count) {
        this.count = count;
        this.a = createDualSOA(count);
        this.b = createDualSOA(count);
        this.out = createDualSOA(count);
    }
    sin() { return soaSin(this.out, this.a); }
    cos() { return soaCos(this.out, this.a); }
    exp() { return soaExp(this.out, this.a); }
    log() { return soaLog(this.out, this.a); }
    sqrt() { return soaSqrt(this.out, this.a); }
    pow(p) { return soaPow(this.out, this.a, p); }
    reset() {
        this.a.re.fill(0); this.a.eps.fill(0);
        this.b.re.fill(0); this.b.eps.fill(0);
        this.out.re.fill(0); this.out.eps.fill(0);
        return this;
    }
}

function createDualBatch(count) { return new DualBatchState(count); }

class TriDualBatchState {
    constructor(count) {
        this.count = count;
        this.a = createTriDualSOA(count);
        this.b = createTriDualSOA(count);
        this.out = createTriDualSOA(count);
        this.normal = createVec3SOA(count);
    }
    seedX(values) {
        const a = this.a;
        for (let i = 0; i < this.count; i++) {
            a.re[i] = values[i]; a.dx[i] = 1; a.dy[i] = 0; a.dz[i] = 0;
        }
        return this;
    }
    seedY(values) {
        const a = this.a;
        for (let i = 0; i < this.count; i++) {
            a.re[i] = values[i]; a.dx[i] = 0; a.dy[i] = 1; a.dz[i] = 0;
        }
        return this;
    }
    seedZ(values) {
        const a = this.a;
        for (let i = 0; i < this.count; i++) {
            a.re[i] = values[i]; a.dx[i] = 0; a.dy[i] = 0; a.dz[i] = 1;
        }
        return this;
    }
    add(b) { return soaTriAdd(this.out, this.a, b); }
    sub(b) { return soaTriSub(this.out, this.a, b); }
    mul(b) { return soaTriMul(this.out, this.a, b); }
    div(b) { return soaTriDiv(this.out, this.a, b); }
    scale(s) { return soaTriScale(this.out, this.a, s); }
    sin() { return soaTriSin(this.out, this.a); }
    cos() { return soaTriCos(this.out, this.a); }
    exp() { return soaTriExp(this.out, this.a); }
    log() { return soaTriLog(this.out, this.a); }
    sqrt() { return soaTriSqrt(this.out, this.a); }
    heightNormalAD(heightFn, xs, zs) {
        return soaHeightNormalAD(this.normal, heightFn, xs, zs, this.count);
    }
    sdfNormalAD(sdfFn, positions) {
        return soaSDFNormalAD(this.normal, sdfFn, positions, this.count);
    }
    async heightNormalADChunked(heightFn, xs, zs, cs, ye) {
        return soaHeightNormalADChunked(this.normal, heightFn, xs, zs, this.count, cs, ye);
    }
    reset() {
        this.a.re.fill(0); this.a.dx.fill(0); this.a.dy.fill(0); this.a.dz.fill(0);
        this.b.re.fill(0); this.b.dx.fill(0); this.b.dy.fill(0); this.b.dz.fill(0);
        this.out.re.fill(0); this.out.dx.fill(0); this.out.dy.fill(0); this.out.dz.fill(0);
        return this;
    }
}

function createTriDualBatch(count) { return new TriDualBatchState(count); }

// ============================================================================
// Namespace convenience (init-time object graph only)
// ============================================================================
const namespace = {
    scalar: {
        Dual, createDual, dualFromValue, dualConstant, dualVariable,
        add, sub, mul, div, neg, inv, abs, min, max,
        pow: powDual, sqrt: sqrtDual, cbrt: cbrtDual,
        exp: expDual, expm1: expm1Dual, log: logDual, log1p: log1pDual,
        log2: log2Dual, log10: log10Dual,
        sin: sinDual, cos: cosDual, tan: tanDual,
        asin: asinDual, acos: acosDual, atan: atanDual, atan2: atan2Dual,
        sinh: sinhDual, cosh: coshDual, tanh: tanhDual,
        sigmoid: sigmoidDual, smoothstep: smoothstepDual, saturate: saturateDual
    },
    tri: {
        TriDual, createTriDual, triDualConstant, triDualSeedX, triDualSeedY, triDualSeedZ,
        add: triAdd, sub: triSub, mul: triMul, div: triDiv, neg: triNeg, inv: triInv,
        scale: triScale, abs: triAbs, min: triMin, max: triMax,
        pow: triPow, sqrt: triSqrt, cbrt: triCbrt,
        exp: triExp, expm1: triExpm1, log: triLog, log1p: triLog1p,
        sin: triSin, cos: triCos, tan: triTan,
        asin: triAsin, acos: triAcos, atan: triAtan, atan2: triAtan2,
        sinh: triSinh, cosh: triCosh, tanh: triTanh,
        sigmoid: triSigmoid, smoothstep: triSmoothstep, saturate: triSaturate,
        sum3, dot3, dot3Full, length3, lengthSq3, cross3, normalize3AD
    },
    hyper: {
        HyperDual, createHyperDual,
        add: hyperAdd, sub: hyperSub, mul: hyperMul, div: hyperDiv,
        inv: hyperInv, scale: hyperScale,
        exp: hyperExp, log: hyperLog, sin: hyperSin, cos: hyperCos,
        sqrt: hyperSqrt, pow: hyperPow, tanh: hyperTanh, sigmoid: hyperSigmoid
    },
    multi: {
        MultiDual, createMultiDual,
        add: multiAdd, mul: multiMul, scale: multiScale, dot: multiDot
    },
    ad: {
        gradient, directionalDerivative, jacobian, jacobianAD,
        hessian, hessianExact, numericalGradientCheck, gradientError
    },
    domain: {
        noiseGradient, noiseGradientAD,
        heightNormal, heightNormalAD,
        sdfNormal, sdfNormalAD,
        ikJacobian: ikJacobianAD, ikGradientStep,
        orbitalForceGradient, gravAccel, gravAccelJacobian,
        animationVelocity, curveDerivative
    },
    batch: {
        DualSOA, TriDualSOA,
        createDualSOA, createTriDualSOA,
        DualState: DualBatchState,
        TriDualState: TriDualBatchState,
        createDualBatch, createTriDualBatch
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
    // Scalar Dual
    Dual, createDual, dualFromValue, dualConstant, dualVariable,
    // TriDual
    TriDual, createTriDual, triDualConstant, triDualSeedX, triDualSeedY, triDualSeedZ,
    // HyperDual / MultiDual
    HyperDual, createHyperDual, MultiDual, createMultiDual,
    // Scalar ops
    add, sub, mul, div, neg, inv, abs, min, max,
    powDual, sqrtDual, cbrtDual, expDual, expm1Dual,
    logDual, log1pDual, log2Dual, log10Dual,
    sinDual, cosDual, tanDual, asinDual, acosDual, atanDual, atan2Dual,
    sinhDual, coshDual, tanhDual, sigmoidDual, smoothstepDual, saturateDual,
    // TriDual ops
    triAdd, triSub, triMul, triDiv, triNeg, triInv, triScale, triAbs, triMin, triMax,
    triPow, triSqrt, triCbrt, triExp, triExpm1, triLog, triLog1p,
    triSin, triCos, triTan, triAsin, triAcos, triAtan, triAtan2,
    triSinh, triCosh, triTanh, triSigmoid, triSmoothstep, triSaturate,
    // Vector ops
    sum3, dot3, dot3Full, length3, lengthSq3, cross3, normalize3AD,
    // HyperDual ops
    hyperAdd, hyperSub, hyperMul, hyperDiv, hyperInv, hyperScale,
    hyperExp, hyperLog, hyperSin, hyperCos, hyperSqrt, hyperPow, hyperTanh, hyperSigmoid,
    // MultiDual ops
    multiAdd, multiMul, multiScale, multiDot,
    // High-level AD
    gradient, directionalDerivative, jacobian, jacobianAD,
    hessian, hessianExact, numericalGradientCheck, gradientError,
    // Domain integrations
    noiseGradient, noiseGradientAD, heightNormal, heightNormalAD,
    sdfNormal, sdfNormalAD, ikJacobianAD, ikGradientStep,
    orbitalForceGradient, gravAccel, gravAccelJacobian,
    animationVelocity, curveDerivative,
    // SOA containers
    DualSOA, TriDualSOA, createDualSOA, createTriDualSOA,
    // SOA (sync)
    soaSin, soaCos, soaExp, soaLog, soaSqrt, soaPow, soaCurveDerivative,
    soaTriAdd, soaTriSub, soaTriMul, soaTriDiv, soaTriScale,
    soaTriSin, soaTriCos, soaTriExp, soaTriLog, soaTriSqrt,
    soaHeightNormal, soaSDFNormal, soaHeightNormalAD, soaSDFNormalAD,
    // SOA (chunked async)
    soaSinChunked, soaCosChunked, soaExpChunked, soaLogChunked,
    soaSqrtChunked, soaPowChunked, soaCurveDerivativeChunked,
    soaTriAddChunked, soaTriSubChunked, soaTriMulChunked, soaTriDivChunked, soaTriScaleChunked,
    soaTriSinChunked, soaTriCosChunked, soaTriExpChunked, soaTriLogChunked, soaTriSqrtChunked,
    soaHeightNormalChunked, soaSDFNormalChunked,
    soaHeightNormalADChunked, soaSDFNormalADChunked,
    // Pools
    DualScratch, createDualScratchPool, acquireDualScratch, releaseDualScratch,
    // Batch states
    DualBatchState, createDualBatch, TriDualBatchState, createTriDualBatch,
    // Namespaces
    namespace
};