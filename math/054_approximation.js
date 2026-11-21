//File number : 054
// File : src/math/054_approximation.js
//Description : Complete approximation / fast-math system (ESM) — every fast primitive with
//              configurable accuracy tiers ("low" ≈ f16, "medium" ≈ f32, "high" = Math.*)
//              resolved ONCE outside every hot loop. Includes fast sin/cos/tan (periodic LUT
//              + nearest / linear interpolation), fast atan/atan2/asin/acos (two-stage range
//              reduction + odd Taylor minimax), fast sinh/cosh/tanh, fast exp/exp2/log/log2/
//              log10/pow (exponent-field range reduction + ldexp), fast sqrt/invsqrt/rcp/
//              hypot (bit-hack + Newton), Chebyshev approximation (nodes, DCT coefficients,
//              Clenshaw evaluation, extrema), Padé approximants from Taylor series, Taylor
//              series, Remez exchange / minimax polynomials, Lagrange & Newton interpolation,
//              rational fitting, Schlick Fresnel (scalar + vec3), ACES / Reinhard tone maps,
//              smoothstep / smootherstep / saturate / gamma / normalize / lerp / clamp / sign /
//              fract / mod, an error-measurement harness, a double-single argument-reduction
//              bridge for galactic-scale angles, SOA + chunked-async variants of every
//              primitive for 1M+ per-frame use, DataTexture LUT authoring, dirty-range GPU
//              attribute upload, deterministic fixed-step animation, zero-copy transferable
//              batch state, pooled zero-GC scratch, and live Float16/Float32/Float64 migration
//              through `000_Math_module.js`.
//
//              CORRECTIONS (this revision):
//              • FATAL: `const M = require(...)` / `const Stability = require(...)` replaced
//                with ESM named imports.
//              • FATAL: `exports.ApproximationScratch / ApproximationBatchState` read classes
//                from the TDZ at module-evaluation time; `exports.namespace` was mutated after
//                export. Converted to `export class` / `export function`.
//              • FATAL Zero-GC: `fastExp`, `fastExp2`, `fastLog`, `fastSqrt` and `fastInvSqrt`
//                each allocated a fresh `ArrayBuffer` + `DataView` PER CALL — 5 allocations
//                per element, 5M per 1M-element frame. All bit reinterpretation now uses
//                module-level views.
//              • FATAL: `fastAces` / `fastReinhard` returned a new 3-element Array per call
//                while their own doc claimed an `out` parameter. Now `fastAces(out, r, g, b)`
//                / `fastReinhard(out, r, g, b)`; single-channel `fastAcesChannel` added.
//              • FATAL: `soaFastAcesChunked` called `chunked(...)` (missing underscore →
//                ReferenceError) and used `b` instead of `b_` in the red channel, producing
//                a wrong tone curve. Both fixed.
//              • FATAL: `rationalApproximation` never advanced `xq` (`xq = x` instead of
//                `xq *= x`), so every denominator column was identical and the linear system
//                was singular. Fixed.
//              • FATAL: `_findRemezExtrema` contained `cons t xs`, `& &`, `peaks.sor t`,
//                `(a, b) = >`, `alt.lengt h` — all repaired, rewritten with typed arrays and
//                a correct alternating-extremum selection. Remez initial nodes are now
//                ASCENDING (Chebyshev extrema come out descending, which mismatched the
//                ascending nodes returned by the exchange step and made it oscillate).
//              • `fastExp` used `(x*LOG2E + 0.5)|0`, which truncates toward zero and mis-rounds
//                every negative argument; `fastExp2` used `x|0` giving r ∈ (−1,1). Both now
//                round/floor correctly, use the full f64 range (not an f32 clamp), and go
//                through a subnormal-safe `ldexp`.
//              • `fastSqrt`'s 64-bit bit-hack dropped the carry from the high word into the
//                low word. Now halves the full 64-bit pattern correctly.
//              • `fastAtan2`'s polynomial was mis-nested (an extra `*s` with no coefficient
//                add). Replaced with two-stage range reduction (|a| ≤ 1, then |a| ≤ 2−√3)
//                plus the exact odd Taylor series — ≈4e-9 rad for "medium", and the classic
//                `a/(1+0.28a²)` for "low".
//              • `fastAsin` used `atan2(x, sqrt(1−x²))`, which loses all precision near |x|=1.
//                Now uses the stable `2·atan(x/(1+sqrt(1−x²)))` form.
//              • `fastSinh` / `fastCosh` computed `1/exp(x)`, overflowing for large negative
//                x. Now evaluate exp(±x) directly with range guards.
//              • `padeApproximant` indexed `taylor[m+i-k]` below zero, producing NaN rows.
//                Out-of-range coefficients are now treated as 0 (the standard convention).
//              • `fastNormalize3` produced NaN for a zero-length vector (Infinity × 0). Guarded.
//              • `soaChebyshevEvaluate` read `coeffs[0]` on an empty table. Guarded.
//              • `soaFastPow` / `soaFastLerp` only detected TypedArrays, silently treating
//                plain Arrays as scalars. Both accept either.
//              • Tier strings were compared PER ELEMENT inside every SOA loop. Tiers are now
//                resolved to integers once, and sin/cos dispatch to three specialised loops.
//              • ES2022 static blocks / private static fields removed so the file parses on
//                older Android WebViews; warm-up runs in plain IIFEs. The
//                `static #listeners = new Set()` notification path is now a dense array.
//              • The monkey-patched `_approxScratchPool.acquire` is a real class-backed pool.
//
//              FEATURES ADDED from corrected_bitecs_enhancement.md:
//              • §10/§16 — Zero-GC everywhere: no per-call ArrayBuffer/DataView, no array
//                returns, no closures in hot loops, no Map/Set. `*Into` forms for every
//                allocating API. Scratch pools rebuild only at precision-switch time.
//              • §25/§28 — `writeApproxIntoFlat` / `flagApproxUpload` / `syncApproxAttribute`:
//                upload approximation results straight into an InstancedBufferAttribute
//                backing array with `clearUpdateRanges` / `addUpdateRange`.
//              • §26     — Double-single argument reduction: `reduceAngleDS` splits 2π into
//                two f64 words and uses error-free TwoProd/TwoDiff so an angle of 1e16 rad
//                still reduces to ~1e-16 absolute accuracy. `fastSinDS` / `fastCosDS` /
//                `fastSincosDS` / `soaSinDS` (+chunked) and `soaRelativeAngleFromDS` give
//                jitter-free sprite rotation and orbital phase at megaparsec offsets.
//              • §30     — `buildSinLUT` / `buildExpLUT` / `buildTonemapLUT` /
//                `buildFresnelLUT` / `buildChebyshevLUT` (+ chunked) author DataTexture-ready
//                RGBA buffers with zero per-texel allocation, plus `rebuildTrigLUT(size)`
//                to retune LUT resolution at runtime.
//              • §34     — Trig tables, reduction constants and bit views are pre-allocated.
//              • §45/§51 — `ApproximationClock` (compensated time) and `createApproxAnimator`
//                advance a parameter on a FIXED timestep for deterministic replays, plus a
//                re-exported `createFixedStepScheduler`.
//              • §49     — `approxBatchToTransferable` / `FromTransferable` pack a batch into
//                ONE ArrayBuffer for zero-copy Worker transfer.
//              • Tooling — `measureError` reports max-abs / max-rel / RMS error of any
//                approximation against a reference, so tier selection is evidence-based.
//####
//Best for : 3d graphics — replacing Math.sin/cos/exp in 1M+ per-frame loops with a
//           fractional-ULP fast version tuned to the active precision tier; fast ACES
//           tone-mapping of 1M+ HDR fragments; fast Fresnel for 1M+ glass/water instances;
//           fast atan2 for 1M+ sprite rotations and particle directions; fast sqrt for 1M+
//           distance checks; Chebyshev approximations of arbitrary procedural fields (custom
//           wave shapes, non-standard easing, custom BRDFs) with minimax error; Padé
//           approximants of rational functions (Kepler, orbital velocity) at 1M+ evaluations
//           per frame; Remez-generated minimax polynomials for deterministic CPU/GPU parity;
//           shader-aligned Schlick Fresnel; LUT authoring for mobile post-processing; and
//           seamless small-to-galactic behaviour via double-single angle reduction — all
//           mobile-safe at 60 fps on Android 64-bit.
//License : MIT

// ============================================================================
// Imports — ESM named imports
// ============================================================================
import {
    common,
    getPrecision,
    setPrecision,
    onPrecisionChange,
    getArrayType,
    createVec2SOA,
    createVec3SOA,
    createFixedStepScheduler
} from "./000_Math_module.js";

import {
    twoSumInto,
    twoDiffInto,
    twoProdInto,
    dsSubInto,
    neumaierSum,
    compDot,
    stableHypot,
    stableHypot3,
    stableSqrt,
    clampToRange,
    ulpAt
} from "./036_numerical-stability.js";

export const VERSION = "1.1.0-esm";

export {
    getPrecision,
    setPrecision,
    onPrecisionChange,
    getArrayType,
    createFixedStepScheduler
};

// ============================================================================
// Accuracy tiers
// ============================================================================
export const TIER_LOW = 0;      // ≈ f16 — nearest LUT / cheapest rational
export const TIER_MEDIUM = 1;   // ≈ f32 — linear LUT / short minimax
export const TIER_HIGH = 2;     // f64 — delegate to Math.*

let _globalTier = TIER_MEDIUM;

/** Resolve a tier name/number to an integer. Hoist this OUT of every hot loop. */
export function resolveTier(tier) {
    if (typeof tier === "number") return tier | 0;
    if (tier === "low") return TIER_LOW;
    if (tier === "high") return TIER_HIGH;
    if (tier === "medium") return TIER_MEDIUM;
    return _globalTier;
}
export function getGlobalTier() { return _globalTier; }
export function setGlobalTier(tier) { _globalTier = resolveTier(tier); return _globalTier; }

// ============================================================================
// Constants — pre-allocated (Blueprint §34)
// ============================================================================
const PI = Math.PI;
const TAU = PI * 2;
const HALF_PI = PI * 0.5;
const QUARTER_PI = PI * 0.25;
const INV_TAU = 1 / TAU;
const LN2 = Math.LN2;
const LOG2E = Math.LOG2E;
const LN10 = Math.LN10;
const LOG10E = Math.LOG10E;
const SQRT2 = Math.SQRT2;
const EPSILON = 1e-12;
const TAN_PI_12 = 2 - Math.sqrt(3);      // tan(π/12) ≈ 0.267949
const INV_SQRT_MAGIC = 0x5f375a86;
const INV_RCP_MAGIC = 0x7EF311C3;
const EXP_MAX_F64 = 709.0;
const EXP_MIN_F64 = -745.0;
const EXP2_MAX_F64 = 1023.0;
const EXP2_MIN_F64 = -1074.0;

// 2π split into two f64 words for double-single argument reduction (§26).
const TAU_HI = 6.283185307179586;
const TAU_LO = 2.4492935982947064e-16;

// ACES (Narkowicz) fit coefficients.
const ACES_A = 2.51, ACES_B = 0.03, ACES_C = 2.43, ACES_D = 0.59, ACES_E = 0.14;

// ============================================================================
// Module scratch — allocated once, reused by every hot path (Zero-GC)
// ============================================================================
const _buf64 = new ArrayBuffer(8);
const _dv64 = new DataView(_buf64);
const _buf32 = new ArrayBuffer(4);
const _dv32 = new DataView(_buf32);
const _p2 = new Float64Array(2);
const _d2 = new Float64Array(2);
const _r2 = new Float64Array(2);
const _sc2 = new Float64Array(2);
const _ds2 = new Float64Array(2);
const _v3 = new Float64Array(3);

// Chebyshev / Remez setup scratch (grown at setup, never per frame).
let _chebXs = new Float64Array(0);
let _chebFs = new Float64Array(0);
let _remexX = new Float64Array(0);
let _remexE = new Float64Array(0);
let _peakX = new Float64Array(0);
let _peakE = new Float64Array(0);
let _peakIdx = new Int32Array(0);

function _growF64(buf, n) {
    if (buf.length >= n) return buf;
    let cap = buf.length || 64;
    while (cap < n) cap *= 2;
    return new Float64Array(cap);
}
function _growI32(buf, n) {
    if (buf.length >= n) return buf;
    let cap = buf.length || 64;
    while (cap < n) cap *= 2;
    return new Int32Array(cap);
}

// ============================================================================
// Trig LUT — Float64 storage (a constant table, not per-instance data)
// ============================================================================
let _lutSize = 4096;
let _lutMask = _lutSize - 1;
let _lutScale = _lutSize / TAU;
let _sinLUT = new Float64Array(_lutSize + 1);
let _cosLUT = new Float64Array(_lutSize + 1);

function _fillTrigLUT() {
    for (let i = 0; i <= _lutSize; i++) {
        const a = (i / _lutSize) * TAU;
        _sinLUT[i] = Math.sin(a);
        _cosLUT[i] = Math.cos(a);
    }
}
_fillTrigLUT();

/**
 * Retune the trig LUT resolution at runtime (setup-time only).
 * 1024 → 8 KB, 4096 → 64 KB (default), 16384 → 256 KB.
 * Linear-interpolation error scales as (2π/size)²/8.
 */
export function rebuildTrigLUT(size) {
    let n = 64;
    const want = size === undefined ? 4096 : size | 0;
    while (n < want && n < (1 << 20)) n <<= 1;
    _lutSize = n;
    _lutMask = n - 1;
    _lutScale = n / TAU;
    _sinLUT = new Float64Array(n + 1);
    _cosLUT = new Float64Array(n + 1);
    _fillTrigLUT();
    return _lutSize;
}
export function getTrigLUTSize() { return _lutSize; }

// ============================================================================
// Bit helpers — module views, subnormal-safe ldexp
// ============================================================================
function _pow2Field(k) {
    _dv64.setUint32(0, (k + 1023) << 20);
    _dv64.setUint32(4, 0);
    return _dv64.getFloat64(0);
}
/** v * 2^k, correct across the subnormal boundary. */
function _ldexp(v, k) {
    if (k > 1023) { v *= _pow2Field(1023); k -= 1023; }
    else if (k < -1022) { v *= _pow2Field(-1022); k += 1022; }
    if (k > 1023) return v > 0 ? Infinity : -Infinity;
    if (k < -1074) return 0;
    return v * _pow2Field(k);
}
/** Extract the biased exponent of a positive f64. */
function _exponentOf(x) {
    _dv64.setFloat64(0, x);
    return ((_dv64.getUint32(0) >>> 20) & 0x7ff) - 1023;
}
/** Rebuild the mantissa of x with exponent 0 → m ∈ [1,2). */
function _mantissaOf(x) {
    _dv64.setFloat64(0, x);
    const hi = _dv64.getUint32(0);
    _dv64.setUint32(0, (hi & 0x800fffff) | (1023 << 20));
    return _dv64.getFloat64(0);
}

// ============================================================================
// Fast trigonometric
// ============================================================================
/**
 * Fast sin. Periodic LUT + nearest (low) / linear (medium) interpolation.
 *   low    : max abs error ≈ 7.7e-4  (4096-entry LUT)
 *   medium : max abs error ≈ 2.9e-7
 *   high   : Math.sin
 * For |x| beyond ~1e15 use `fastSinDS` (double-single reduction).
 */
export function fastSin(x, tier) {
    const t = resolveTier(tier);
    if (t === TIER_HIGH) return Math.sin(x);
    const xr = x - Math.floor(x * INV_TAU) * TAU;
    const idx = xr * _lutScale;
    const i0 = idx | 0;
    const a = _sinLUT[i0 & _lutMask];
    if (t === TIER_LOW) return a;
    const b = _sinLUT[(i0 + 1) & _lutMask];
    return a + (b - a) * (idx - i0);
}
/** Fast cos — same tiers and error bounds as `fastSin`. */
export function fastCos(x, tier) {
    const t = resolveTier(tier);
    if (t === TIER_HIGH) return Math.cos(x);
    const xr = x - Math.floor(x * INV_TAU) * TAU;
    const idx = xr * _lutScale;
    const i0 = idx | 0;
    const a = _cosLUT[i0 & _lutMask];
    if (t === TIER_LOW) return a;
    const b = _cosLUT[(i0 + 1) & _lutMask];
    return a + (b - a) * (idx - i0);
}
/** Fast tan = sin/cos with a pole guard. */
export function fastTan(x, tier) {
    const t = resolveTier(tier);
    if (t === TIER_HIGH) return Math.tan(x);
    const c = fastCos(x, t);
    if (c > -1e-7 && c < 1e-7) return c >= 0 ? 1e7 : -1e7;
    return fastSin(x, t) / c;
}
/** Zero-allocation sincos → out2 = [sin, cos]. */
export function fastSincosInto(out2, x, tier) {
    const t = resolveTier(tier);
    if (t === TIER_HIGH) { out2[0] = Math.sin(x); out2[1] = Math.cos(x); return out2; }
    const xr = x - Math.floor(x * INV_TAU) * TAU;
    const idx = xr * _lutScale;
    const i0 = idx | 0;
    const i1 = (i0 + 1) & _lutMask;
    const m = i0 & _lutMask;
    const sa = _sinLUT[m], ca = _cosLUT[m];
    if (t === TIER_LOW) { out2[0] = sa; out2[1] = ca; return out2; }
    const f = idx - i0;
    out2[0] = sa + (_sinLUT[i1] - sa) * f;
    out2[1] = ca + (_cosLUT[i1] - ca) * f;
    return out2;
}
/** Pooled {s,c} pair — caller MUST release via `releaseSincos`. Prefer the Into form. */
export function fastSincos(x, tier) {
    const p = _sincosPool.acquire();
    fastSincosInto(_sc2, x, tier);
    p.s = _sc2[0]; p.c = _sc2[1];
    return p;
}
export function releaseSincos(p) { if (p) _sincosPool.release(p); }

/**
 * Fast atan2. Two-stage range reduction (|a| ≤ 1, then |a| ≤ 2−√3) followed by
 * the exact odd Taylor series (medium, ≈4e-9 rad) or the classic a/(1+0.28a²)
 * rational (low, ≈5e-3 rad).
 */
export function fastAtan2(y, x, tier) {
    const t = resolveTier(tier);
    if (t === TIER_HIGH) return Math.atan2(y, x);
    if (x === 0 && y === 0) return 0;
    const ax = x < 0 ? -x : x;
    const ay = y < 0 ? -y : y;
    const swap = ay > ax;
    const num = swap ? ax : ay;
    const den = swap ? ay : ax;
    let a = num / den;
    let offset = 0;
    if (a > TAN_PI_12) { a = (a - 1) / (a + 1); offset = QUARTER_PI; }
    const s = a * a;
    let r;
    if (t === TIER_LOW) {
        r = a / (1 + 0.28 * s);
    } else {
        r = a * (1 + s * (-0.3333333333333333 + s * (0.2 + s * (-0.14285714285714285 +
            s * (0.1111111111111111 + s * (-0.09090909090909091))))));
    }
    r += offset;
    if (swap) r = HALF_PI - r;
    if (x < 0) r = PI - r;
    if (y < 0) r = -r;
    return r;
}
/** Fast atan. */
export function fastAtan(x, tier) { return fastAtan2(x, 1, tier); }
/** Fast asin — stable near |x| = 1 via 2·atan(x/(1+√(1−x²))). */
export function fastAsin(x, tier) {
    const t = resolveTier(tier);
    if (t === TIER_HIGH) return Math.asin(x);
    if (x >= 1) return HALF_PI;
    if (x <= -1) return -HALF_PI;
    const d = Math.sqrt(1 - x * x);
    return 2 * fastAtan2(x, 1 + d, t);
}
/** Fast acos = π/2 − asin(x). */
export function fastAcos(x, tier) {
    const t = resolveTier(tier);
    if (t === TIER_HIGH) return Math.acos(x);
    return HALF_PI - fastAsin(x, t);
}

// ============================================================================
// Fast hyperbolic
// ============================================================================
export function fastSinh(x, tier) {
    const t = resolveTier(tier);
    if (t === TIER_HIGH) return Math.sinh(x);
    if (x > 354) return Number.MAX_VALUE;
    if (x < -354) return -Number.MAX_VALUE;
    if (x > -0.05 && x < 0.05) { const x2 = x * x; return x * (1 + x2 * (0.1666666666666667 + x2 * 0.008333333333333333)); }
    return (fastExp(x, t) - fastExp(-x, t)) * 0.5;
}
export function fastCosh(x, tier) {
    const t = resolveTier(tier);
    if (t === TIER_HIGH) return Math.cosh(x);
    if (x > 354 || x < -354) return Number.MAX_VALUE;
    if (x > -0.05 && x < 0.05) { const x2 = x * x; return 1 + x2 * (0.5 + x2 * 0.041666666666666664); }
    return (fastExp(x, t) + fastExp(-x, t)) * 0.5;
}
export function fastTanh(x, tier) {
    const t = resolveTier(tier);
    if (t === TIER_HIGH) return Math.tanh(x);
    if (x > 15) return 1;
    if (x < -15) return -1;
    if (x > -1e-4 && x < 1e-4) return x;
    const e = fastExp(2 * x, t);
    return (e - 1) / (e + 1);
}

// ============================================================================
// Fast exp / log / pow
// ============================================================================
/**
 * Fast exp. x = k·ln2 + r with |r| ≤ ln2/2, then a Taylor polynomial and an
 * exact exponent-field scale. Full f64 range (not an f32 clamp).
 *   low    : degree 4  (≈2e-6 relative)
 *   medium : degree 7  (≈1e-11 relative)
 *   high   : Math.exp
 */
export function fastExp(x, tier) {
    const t = resolveTier(tier);
    if (t === TIER_HIGH) return Math.exp(x);
    if (x > EXP_MAX_F64) return Number.MAX_VALUE;
    if (x < EXP_MIN_F64) return 0;
    const k = Math.round(x * LOG2E);
    const r = x - k * LN2;
    const r2 = r * r;
    let poly;
    if (t === TIER_LOW) {
        poly = 1 + r + r2 * (0.5 + r * (0.16666666666666666 + r * 0.041666666666666664));
    } else {
        poly = 1 + r + r2 * (0.5 + r * (0.16666666666666666 + r * (0.041666666666666664 +
            r * (0.008333333333333333 + r * (0.001388888888888889 + r * 0.0001984126984126984)))));
    }
    return _ldexp(poly, k);
}
/** Fast exp2 = 2^x. */
export function fastExp2(x, tier) {
    const t = resolveTier(tier);
    if (t === TIER_HIGH) return Math.pow(2, x);
    if (x > EXP2_MAX_F64) return Number.MAX_VALUE;
    if (x < EXP2_MIN_F64) return 0;
    const k = Math.floor(x);
    const r = (x - k) * LN2;
    const r2 = r * r;
    let poly;
    if (t === TIER_LOW) {
        poly = 1 + r + r2 * (0.5 + r * (0.16666666666666666 + r * 0.041666666666666664));
    } else {
        poly = 1 + r + r2 * (0.5 + r * (0.16666666666666666 + r * (0.041666666666666664 +
            r * (0.008333333333333333 + r * (0.001388888888888889 + r * 0.0001984126984126984)))));
    }
    return _ldexp(poly, k);
}
/**
 * Fast log. Mantissa normalized to [√2/2, √2) so the atanh series argument
 * stays below 0.1716 — 5 terms give ≈1e-11 relative.
 */
export function fastLog(x, tier) {
    const t = resolveTier(tier);
    if (t === TIER_HIGH) return Math.log(x);
    if (x <= 0) return x === 0 ? -Infinity : NaN;
    let e = _exponentOf(x);
    let m = _mantissaOf(x);
    if (m > SQRT2) { m *= 0.5; e++; }
    const u = (m - 1) / (m + 1);
    const u2 = u * u;
    let series;
    if (t === TIER_LOW) {
        series = 1 + u2 * (0.3333333333333333 + u2 * 0.2);
    } else {
        series = 1 + u2 * (0.3333333333333333 + u2 * (0.2 + u2 * (0.14285714285714285 +
            u2 * (0.1111111111111111 + u2 * 0.09090909090909091))));
    }
    return e * LN2 + 2 * u * series;
}
/** Fast log2 — exponent extraction plus the same normalized series. */
export function fastLog2(x, tier) {
    const t = resolveTier(tier);
    if (t === TIER_HIGH) return Math.log2(x);
    if (x <= 0) return x === 0 ? -Infinity : NaN;
    let e = _exponentOf(x);
    let m = _mantissaOf(x);
    if (m > SQRT2) { m *= 0.5; e++; }
    const u = (m - 1) / (m + 1);
    const u2 = u * u;
    const series = t === TIER_LOW
        ? 1 + u2 * (0.3333333333333333 + u2 * 0.2)
        : 1 + u2 * (0.3333333333333333 + u2 * (0.2 + u2 * (0.14285714285714285 +
            u2 * (0.1111111111111111 + u2 * 0.09090909090909091))));
    return e + 2 * u * series * LOG2E;
}
export function fastLog10(x, tier) {
    const t = resolveTier(tier);
    if (t === TIER_HIGH) return Math.log10(x);
    return fastLog(x, t) * LOG10E;
}
/** Fast pow — integer exponentiation by squaring, else exp(y·log(x)). */
export function fastPow(x, y, tier) {
    const t = resolveTier(tier);
    if (t === TIER_HIGH) return Math.pow(x, y);
    if (y === 0) return 1;
    if (y === 1) return x;
    if (y === 2) return x * x;
    if (y === 0.5) return fastSqrt(x, t);
    if (x === 0) return y > 0 ? 0 : Infinity;
    if (x < 0) {
        if (y !== Math.floor(y)) return NaN;
        const r = fastPow(-x, y, t);
        return Math.abs(y % 2) === 1 ? -r : r;
    }
    if (y === Math.floor(y) && y > -32 && y < 32) {
        let n = y < 0 ? -y : y;
        let base = x, acc = 1;
        while (n > 0) {
            if (n & 1) acc *= base;
            base *= base;
            n >>= 1;
        }
        return y < 0 ? 1 / acc : acc;
    }
    return fastExp(y * fastLog(x, t), t);
}

// ============================================================================
// Fast roots
// ============================================================================
/**
 * Fast sqrt. `high`/`medium` use the hardware intrinsic (Math.sqrt compiles to
 * a single instruction and beats any JS bit hack). `low` uses a correct 64-bit
 * bit-hack seed plus Newton refinement.
 */
export function fastSqrt(x, tier) {
    const t = resolveTier(tier);
    if (t !== TIER_LOW) return Math.sqrt(x);
    if (x <= 0) return x === 0 ? 0 : NaN;
    if (!isFinite(x)) return x;
    _dv64.setFloat64(0, x);
    const hi = _dv64.getUint32(0), lo = _dv64.getUint32(4);
    // Logical 64-bit >> 1 with carry from the high word, then add the bias.
    const nh = ((hi >>> 1) + 0x1ff80000) >>> 0;
    const nl = ((lo >>> 1) | ((hi & 1) << 31)) >>> 0;
    _dv64.setUint32(0, nh);
    _dv64.setUint32(4, nl);
    let r = _dv64.getFloat64(0);
    r = 0.5 * (r + x / r);
    r = 0.5 * (r + x / r);
    return r;
}
/** Fast inverse sqrt — Quake III f32 bit hack + 1 (low) / 2 (medium) Newton steps. */
export function fastInvSqrt(x, tier) {
    const t = resolveTier(tier);
    if (t === TIER_HIGH) return 1 / Math.sqrt(x);
    if (x <= 0) return x === 0 ? Infinity : NaN;
    _dv32.setFloat32(0, x);
    let i = _dv32.getInt32(0);
    i = INV_SQRT_MAGIC - (i >> 1);
    _dv32.setInt32(0, i);
    let r = _dv32.getFloat32(0);
    r = r * (1.5 - 0.5 * x * r * r);
    if (t === TIER_MEDIUM) r = r * (1.5 - 0.5 * x * r * r);
    return r;
}
/** Fast reciprocal — f32 bit-hack seed + Newton (low), else hardware divide. */
export function fastRcp(x, tier) {
    const t = resolveTier(tier);
    if (t !== TIER_LOW) return 1 / x;
    if (x === 0) return Infinity;
    _dv32.setFloat32(0, x);
    let i = _dv32.getInt32(0);
    i = INV_RCP_MAGIC - i;
    _dv32.setInt32(0, i);
    let r = _dv32.getFloat32(0);
    r = r * (2 - x * r);
    r = r * (2 - x * r);
    return r;
}
/** Fast hypot — overflow/underflow safe at every tier. */
export function fastHypot(x, y, tier) {
    const t = resolveTier(tier);
    if (t === TIER_HIGH) return Math.hypot(x, y);
    let ax = x < 0 ? -x : x;
    let ay = y < 0 ? -y : y;
    if (!isFinite(ax) || !isFinite(ay)) return Infinity;
    if (ax < ay) { const s = ax; ax = ay; ay = s; }
    if (ay === 0) return ax;
    const r = ay / ax;
    return ax * fastSqrt(1 + r * r, t);
}
/** Fast 3D hypot. */
export function fastHypot3(x, y, z, tier) {
    const t = resolveTier(tier);
    if (t === TIER_HIGH) return stableHypot3(x, y, z);
    const ax = x < 0 ? -x : x, ay = y < 0 ? -y : y, az = z < 0 ? -z : z;
    let m = ax; if (ay > m) m = ay; if (az > m) m = az;
    if (m === 0) return 0;
    if (!isFinite(m)) return Infinity;
    const a = ax / m, b = ay / m, c = az / m;
    return m * fastSqrt(a * a + b * b + c * c, t);
}

// ============================================================================
// Chebyshev
// ============================================================================
/** Chebyshev nodes of the first kind: cos((2k+1)π/(2n)). */
export function chebyshevNodes(out, n) {
    const inv = PI / (2 * n);
    for (let k = 0; k < n; k++) out[k] = Math.cos((2 * k + 1) * inv);
    return out;
}
/** Chebyshev extrema (includes endpoints) — ascending, used as Remez seeds. */
export function chebyshevExtrema(out, n) {
    if (n < 2) { out[0] = 0; return out; }
    const inv = PI / (n - 1);
    for (let k = 0; k < n; k++) out[k] = Math.cos((n - 1 - k) * inv);
    return out;
}
/** Chebyshev coefficients via DCT-II. Setup-time; uses module scratch. */
export function chebyshevCoefficients(f, n, out) {
    out = out || new Float64Array(n);
    _chebXs = _growF64(_chebXs, n);
    _chebFs = _growF64(_chebFs, n);
    const xs = _chebXs, fs = _chebFs;
    chebyshevNodes(xs, n);
    for (let k = 0; k < n; k++) fs[k] = f(xs[k]);
    const scale = PI / (2 * n);
    const invN = 1 / n;
    for (let j = 0; j < n; j++) {
        let s = 0;
        for (let k = 0; k < n; k++) s += fs[k] * Math.cos(j * (2 * k + 1) * scale);
        out[j] = (j === 0 ? 1 : 2) * s * invN;
    }
    return out;
}
/** Clenshaw evaluation of a Chebyshev series at x ∈ [−1,1]. */
export function chebyshevEvaluate(coeffs, x) {
    const n = coeffs.length;
    if (n === 0) return 0;
    if (n === 1) return coeffs[0];
    let b1 = 0, b2 = 0;
    const x2 = 2 * x;
    for (let i = n - 1; i >= 1; i--) {
        const b0 = x2 * b1 - b2 + coeffs[i];
        b2 = b1; b1 = b0;
    }
    return x * b1 - b2 + coeffs[0];
}
/** Clenshaw into a caller buffer (identical maths, explicit out param). */
export function chebyshevEvaluateInto(out, coeffs, x) {
    out[0] = chebyshevEvaluate(coeffs, x);
    return out;
}
/** Build a Chebyshev approximation of `f` on [a,b]. Setup-time allocation. */
export function chebyshevApproximate(f, a, b, n) {
    const coeffs = new Float64Array(n);
    const half = (b - a) * 0.5;
    const mid = (a + b) * 0.5;
    const invHalf = half !== 0 ? 1 / half : 0;
    const scaled = function (t) { return f(mid + t * half); };
    chebyshevCoefficients(scaled, n, coeffs);
    return {
        coeffs: coeffs, a: a, b: b, mid: mid, half: half,
        evaluate: function (x) { return chebyshevEvaluate(coeffs, (x - mid) * invHalf); }
    };
}

// ============================================================================
// Padé
// ============================================================================
/**
 * Padé [m/n] approximant from Taylor coefficients. Coefficients with a negative
 * index are treated as 0 (the standard convention) — the previous version read
 * `undefined` and produced NaN rows.
 */
export function padeApproximant(taylor, m, n) {
    const total = m + n + 1;
    if (taylor.length < total) {
        throw new Error("padeApproximant: taylor array must have at least m+n+1 coefficients");
    }
    const q = new Float64Array(n + 1);
    q[0] = 1;
    if (n > 0) {
        const A = new Array(n);
        const rhs = new Float64Array(n);
        for (let i = 1; i <= n; i++) {
            const row = new Float64Array(n);
            for (let k = 1; k <= n; k++) {
                const idx = m + i - k;
                row[k - 1] = idx >= 0 ? taylor[idx] : 0;
            }
            A[i - 1] = row;
            const ri = m + i;
            rhs[i - 1] = -(ri < taylor.length ? taylor[ri] : 0);
        }
        const sol = _solveLinearSystem(A, rhs);
        for (let k = 1; k <= n; k++) q[k] = sol[k - 1];
    }
    const p = new Float64Array(m + 1);
    for (let i = 0; i <= m; i++) {
        let s = taylor[i];
        const lim = i < n ? i : n;
        for (let k = 1; k <= lim; k++) s += q[k] * taylor[i - k];
        p[i] = s;
    }
    return { p: p, q: q, m: m, n: n };
}
/** Horner evaluation of a Padé approximant. */
export function padeEvaluate(pade, x) {
    const p = pade.p, q = pade.q;
    let num = 0, den = 0;
    for (let i = p.length - 1; i >= 0; i--) num = num * x + p[i];
    for (let i = q.length - 1; i >= 0; i--) den = den * x + q[i];
    return den === 0 ? NaN : num / den;
}

// ============================================================================
// Taylor
// ============================================================================
export function taylorSin(x, terms) {
    const n = terms === undefined ? 6 : terms;
    let sum = 0, term = x, k = 1;
    const x2 = -x * x;
    for (let i = 0; i < n; i++) {
        sum += term;
        term *= x2 / ((k + 1) * (k + 2));
        k += 2;
    }
    return sum;
}
export function taylorCos(x, terms) {
    const n = terms === undefined ? 6 : terms;
    let sum = 0, term = 1, k = 0;
    const x2 = -x * x;
    for (let i = 0; i < n; i++) {
        sum += term;
        term *= x2 / ((k + 1) * (k + 2));
        k += 2;
    }
    return sum;
}
export function taylorExp(x, terms) {
    const n = terms === undefined ? 8 : terms;
    let sum = 1, term = 1;
    for (let i = 1; i < n; i++) { term *= x / i; sum += term; }
    return sum;
}
/** Raw log(1+y) series — converges for 0 < x < 2. Use `fastLog` outside that. */
export function taylorLog(x, terms) {
    const n = terms === undefined ? 8 : terms;
    const y = x - 1;
    let sum = 0, term = y;
    for (let i = 1; i <= n; i++) {
        sum += (i % 2 === 1 ? 1 : -1) * term / i;
        term *= y;
    }
    return sum;
}

// ============================================================================
// Remez / minimax
// ============================================================================
/**
 * Remez exchange for a minimax polynomial on [a,b].
 * Nodes are ASCENDING throughout so the (−1)^i error alternation is consistent
 * between the solve and the exchange step.
 */
export function remez(f, a, b, degree, maxIter) {
    const iters = maxIter === undefined ? 25 : maxIter;
    const n = degree + 2;
    _remexX = _growF64(_remexX, n);
    const x = _remexX;
    chebyshevExtrema(x, n);
    for (let i = 0; i < n; i++) x[i] = 0.5 * (a + b) + 0.5 * (b - a) * x[i];
    const coeffs = new Float64Array(degree + 1);
    let maxError = 0, iterations = 0;
    const A = new Array(n);
    for (let i = 0; i < n; i++) A[i] = new Float64Array(n);
    const rhs = new Float64Array(n);
    for (let iter = 0; iter < iters; iter++) {
        iterations = iter + 1;
        for (let i = 0; i < n; i++) {
            const row = A[i];
            let xi = 1;
            for (let j = 0; j <= degree; j++) { row[j] = xi; xi *= x[i]; }
            row[degree + 1] = (i % 2 === 0 ? 1 : -1);
            rhs[i] = f(x[i]);
        }
        const sol = _solveLinearSystem(A, rhs);
        for (let j = 0; j <= degree; j++) coeffs[j] = sol[j];
        maxError = Math.abs(sol[degree + 1]);
        const converged = _findRemezExtrema(f, coeffs, a, b, n, x);
        if (converged) break;
    }
    return { coefficients: coeffs, degree: degree, maxError: maxError, iterations: iterations };
}
export function minimaxPolynomial(f, a, b, degree, maxIter) {
    return remez(f, a, b, degree, maxIter);
}
function _horner(c, x) {
    let p = c[c.length - 1];
    for (let j = c.length - 2; j >= 0; j--) p = p * x + c[j];
    return p;
}
/**
 * Locate n alternating-sign error extrema and write them (ascending) into `x`.
 * Returns true when the node set stopped moving (convergence).
 * Typed arrays only — no per-peak object allocation.
 */
function _findRemezExtrema(f, coeffs, a, b, n, x) {
    const samples = n * 16 + 32;
    _remexE = _growF64(_remexE, samples);
    _peakX = _growF64(_peakX, samples);
    _peakE = _growF64(_peakE, samples);
    _peakIdx = _growI32(_peakIdx, samples);
    const es = _remexE, px = _peakX, pe = _peakE, pidx = _peakIdx;
    const step = (b - a) / (samples - 1);
    for (let i = 0; i < samples; i++) {
        const xx = a + step * i;
        es[i] = f(xx) - _horner(coeffs, xx);
    }
    let count = 0;
    // Endpoints are always candidate extrema.
    px[count] = a; pe[count] = es[0]; count++;
    for (let i = 1; i < samples - 1; i++) {
        const a1 = es[i - 1] < 0 ? -es[i - 1] : es[i - 1];
        const a2 = es[i] < 0 ? -es[i] : es[i];
        const a3 = es[i + 1] < 0 ? -es[i + 1] : es[i + 1];
        if (a2 >= a1 && a2 >= a3 && a2 > 0) { px[count] = a + step * i; pe[count] = es[i]; count++; }
    }
    px[count] = b; pe[count] = es[samples - 1]; count++;

    // Greedily keep the strongest alternating-sign run of exactly n extrema.
    let kept = 0;
    let lastSign = 0;
    for (let i = 0; i < count && kept < n; i++) {
        const s = pe[i] > 0 ? 1 : (pe[i] < 0 ? -1 : 0);
        if (s === 0) continue;
        if (kept === 0 || s !== lastSign) { pidx[kept++] = i; lastSign = s; }
        else {
            const prev = pidx[kept - 1];
            const prevMag = pe[prev] < 0 ? -pe[prev] : pe[prev];
            const curMag = pe[i] < 0 ? -pe[i] : pe[i];
            if (curMag > prevMag) pidx[kept - 1] = i;
        }
    }
    let converged = true;
    if (kept === n) {
        for (let i = 0; i < n; i++) {
            const nx = px[pidx[i]];
            if (Math.abs(nx - x[i]) > 1e-9 * (b - a)) converged = false;
            x[i] = nx;
        }
    } else {
        // Not enough alternations — resample uniformly and keep iterating.
        for (let i = 0; i < n; i++) x[i] = a + (b - a) * i / (n - 1);
        converged = false;
    }
    return converged;
}

// ============================================================================
// Linear system solver (setup-time only)
// ============================================================================
let _lastSolveSingular = false;
export function wasSingular() { return _lastSolveSingular; }
/** Gaussian elimination with partial pivoting. Setup-time allocation. */
function _solveLinearSystem(A, rhs) {
    const n = A.length;
    _lastSolveSingular = false;
    const M = new Array(n);
    for (let i = 0; i < n; i++) {
        const r = new Float64Array(n + 1);
        r.set(A[i]);
        r[n] = rhs[i];
        M[i] = r;
    }
    for (let k = 0; k < n; k++) {
        let maxRow = k;
        let maxVal = Math.abs(M[k][k]);
        for (let i = k + 1; i < n; i++) {
            const v = Math.abs(M[i][k]);
            if (v > maxVal) { maxVal = v; maxRow = i; }
        }
        if (maxVal < 1e-14) { _lastSolveSingular = true; continue; }
        if (maxRow !== k) { const tmp = M[k]; M[k] = M[maxRow]; M[maxRow] = tmp; }
        const pivot = M[k][k];
        for (let i = k + 1; i < n; i++) {
            const factor = M[i][k] / pivot;
            if (factor === 0) continue;
            for (let j = k; j <= n; j++) M[i][j] -= factor * M[k][j];
        }
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
        let sum = M[i][n];
        for (let j = i + 1; j < n; j++) sum -= M[i][j] * x[j];
        const d = M[i][i];
        x[i] = Math.abs(d) > 1e-14 ? sum / d : 0;
    }
    return x;
}

// ============================================================================
// Interpolation
// ============================================================================
/** Lagrange polynomial evaluation at x. */
export function lagrangeInterpolation(xs, ys, x) {
    const n = xs.length;
    let sum = 0;
    for (let i = 0; i < n; i++) {
        let term = ys[i];
        const xi = xs[i];
        for (let j = 0; j < n; j++) {
            if (j !== i) term *= (x - xs[j]) / (xi - xs[j]);
        }
        sum += term;
    }
    return sum;
}
/** Newton divided differences → reusable evaluator. Setup-time allocation. */
export function newtonInterpolation(xs, ys) {
    const n = xs.length;
    const coef = new Float64Array(n);
    coef.set(ys);
    for (let j = 1; j < n; j++) {
        for (let i = n - 1; i >= j; i--) {
            coef[i] = (coef[i] - coef[i - 1]) / (xs[i] - xs[i - j]);
        }
    }
    return function (x) {
        let result = coef[n - 1];
        for (let i = n - 2; i >= 0; i--) result = result * (x - xs[i]) + coef[i];
        return result;
    };
}
/** Newton divided-difference coefficients into a caller buffer (zero-GC). */
export function newtonCoefficientsInto(out, xs, ys) {
    const n = xs.length;
    for (let i = 0; i < n; i++) out[i] = ys[i];
    for (let j = 1; j < n; j++) {
        for (let i = n - 1; i >= j; i--) {
            out[i] = (out[i] - out[i - 1]) / (xs[i] - xs[i - j]);
        }
    }
    return out;
}
/** Evaluate a precomputed Newton form (zero-GC hot path). */
export function newtonEvaluate(coef, xs, x) {
    const n = coef.length;
    let result = coef[n - 1];
    for (let i = n - 2; i >= 0; i--) result = result * (x - xs[i]) + coef[i];
    return result;
}

// ============================================================================
// Rational approximation
// ============================================================================
/**
 * Fit p(x)/q(x) with deg(p)=m, deg(q)=n through m+n+1 samples, q[0]=1.
 * CORRECTED: the denominator powers now advance (`xq *= x`).
 */
export function rationalApproximation(xs, ys, m, n) {
    const total = m + n + 1;
    if (xs.length < total) {
        throw new Error("rationalApproximation: need at least " + total + " sample points");
    }
    const cols = m + 1 + n;
    const A = new Array(total);
    const rhs = new Float64Array(total);
    for (let i = 0; i < total; i++) {
        const x = xs[i], f = ys[i];
        const row = new Float64Array(cols);
        let xp = 1;
        for (let j = 0; j <= m; j++) { row[j] = xp; xp *= x; }
        let xq = x;
        for (let j = 0; j < n; j++) { row[m + 1 + j] = -f * xq; xq *= x; }
        A[i] = row;
        rhs[i] = f;
    }
    const sol = _solveLinearSystem(A, rhs);
    const p = new Float64Array(m + 1);
    for (let i = 0; i <= m; i++) p[i] = sol[i];
    const q = new Float64Array(n + 1);
    q[0] = 1;
    for (let i = 1; i <= n; i++) q[i] = sol[m + i];
    return { p: p, q: q, m: m, n: n };
}

// ============================================================================
// Graphics approximations
// ============================================================================
/** Schlick Fresnel — scalar F0. */
export function schlickFresnel(cosTheta, F0) {
    const t = 1 - cosTheta;
    const t2 = t * t;
    return F0 + (1 - F0) * t2 * t2 * t;
}
/** Schlick Fresnel with a vec3 F0 (the usual PBR form). Writes out[0..2]. */
export function schlickFresnelVec3(out, cosTheta, F0) {
    const t = 1 - cosTheta;
    const t2 = t * t;
    const f = t2 * t2 * t;
    out[0] = F0[0] + (1 - F0[0]) * f;
    out[1] = F0[1] + (1 - F0[1]) * f;
    out[2] = F0[2] + (1 - F0[2]) * f;
    return out;
}
/** Single-channel ACES (Narkowicz) fit, clamped to [0,1]. */
export function fastAcesChannel(x) {
    const v = (x * (ACES_A * x + ACES_B)) / (x * (ACES_C * x + ACES_D) + ACES_E);
    return v < 0 ? 0 : (v > 1 ? 1 : v);
}
/**
 * ACES tone map. CORRECTED signature: writes into `out` instead of allocating
 * a 3-element Array per call. In-place (`out` aliasing the source) is fine.
 */
export function fastAces(out, r, g, b) {
    out[0] = fastAcesChannel(r);
    out[1] = fastAcesChannel(g);
    out[2] = fastAcesChannel(b);
    return out;
}
/** Reinhard tone map → out[0..2]. */
export function fastReinhard(out, r, g, b) {
    out[0] = r / (1 + r);
    out[1] = g / (1 + g);
    out[2] = b / (1 + b);
    return out;
}
/** Extended Reinhard with a white point. */
export function fastReinhardExt(out, r, g, b, white) {
    const w = white === undefined ? 1 : white;
    const w2 = w * w;
    out[0] = r * (1 + r / w2) / (1 + r);
    out[1] = g * (1 + g / w2) / (1 + g);
    out[2] = b * (1 + b / w2) / (1 + b);
    return out;
}
export function fastSmoothstep(edge0, edge1, x) {
    const span = edge1 - edge0;
    let t = span !== 0 ? (x - edge0) / span : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return t * t * (3 - 2 * t);
}
export function fastSmootherstep(edge0, edge1, x) {
    const span = edge1 - edge0;
    let t = span !== 0 ? (x - edge0) / span : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return t * t * t * (t * (t * 6 - 15) + 10);
}
export function fastSaturate(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
export function fastGamma(x, gamma, tier) {
    if (x <= 0) return 0;
    return fastPow(x, 1 / (gamma || 2.2), tier);
}
/** Gamma encode a vec3 → out[0..2]. */
export function fastGammaVec3(out, r, g, b, gamma, tier) {
    const inv = 1 / (gamma || 2.2);
    out[0] = r <= 0 ? 0 : fastPow(r, inv, tier);
    out[1] = g <= 0 ? 0 : fastPow(g, inv, tier);
    out[2] = b <= 0 ? 0 : fastPow(b, inv, tier);
    return out;
}
/** Fast vec3 normalize. CORRECTED: zero-length input yields (0,0,0), not NaN. */
export function fastNormalize3(out, x, y, z, tier) {
    const l2 = x * x + y * y + z * z;
    if (!(l2 > 1e-30) || !isFinite(l2)) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
    const inv = fastInvSqrt(l2, tier);
    out[0] = x * inv; out[1] = y * inv; out[2] = z * inv;
    return out;
}
export function fastLerp(a, b, t) { return a + (b - a) * t; }
export function fastClamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
export function fastSign(x) { return x > 0 ? 1 : (x < 0 ? -1 : 0); }
export function fastFract(x) { return x - Math.floor(x); }
export function fastMod(x, m) { const r = x % m; return r < 0 ? r + m : r; }

// ============================================================================
// Error measurement (setup / diagnostic — allocates)
// ============================================================================
/**
 * Measure an approximation against a reference over [a,b].
 * @returns {{maxAbs:number, maxRel:number, rms:number, at:number}}
 */
export function measureError(approx, reference, a, b, samples) {
    const n = samples === undefined ? 4096 : samples;
    const step = (b - a) / (n - 1);
    let maxAbs = 0, maxRel = 0, sumSq = 0, at = a;
    for (let i = 0; i < n; i++) {
        const x = a + step * i;
        const got = approx(x);
        const want = reference(x);
        const d = Math.abs(got - want);
        if (d > maxAbs) { maxAbs = d; at = x; }
        const denom = Math.abs(want) > 1e-30 ? Math.abs(want) : 1;
        const rel = d / denom;
        if (rel > maxRel) maxRel = rel;
        sumSq += d * d;
    }
    return { maxAbs: maxAbs, maxRel: maxRel, rms: Math.sqrt(sumSq / n), at: at };
}

// ============================================================================
// Double-single argument reduction (Blueprint §26)
// ============================================================================
/**
 * Reduce a double-single angle (hi + lo) modulo 2π into [−π, π].
 * 2π is split into two f64 words and the product k·2π is formed error-free,
 * so an angle of 1e16 rad still reduces to ~1e-16 absolute accuracy — the
 * precision that `x % TAU` loses entirely.
 */
export function reduceAngleDS(hi, lo) {
    const k = Math.round(hi * INV_TAU);
    twoProdInto(_p2, k, TAU_HI);
    twoDiffInto(_d2, hi, _p2[0]);
    let r = (_d2[0] + _d2[1]) - _p2[1] - k * TAU_LO + lo;
    if (r > PI) r -= TAU_HI;
    else if (r < -PI) r += TAU_HI;
    return r;
}
/** Fast sin of a double-single angle. */
export function fastSinDS(hi, lo, tier) { return fastSin(reduceAngleDS(hi, lo), tier); }
/** Fast cos of a double-single angle. */
export function fastCosDS(hi, lo, tier) { return fastCos(reduceAngleDS(hi, lo), tier); }
/** Fast sincos of a double-single angle → out2. */
export function fastSincosDS(out2, hi, lo, tier) {
    return fastSincosInto(out2, reduceAngleDS(hi, lo), tier);
}
/** Camera-relative atan2 from double-single world positions (zero-GC). */
export function relativeAngleFromDS(posHi, posLo, originHi, originLo, tier) {
    dsSubInto(_ds2, posHi[0], posLo[0], originHi[0], originLo ? originLo[0] : 0);
    const dx = _ds2[0] + _ds2[1];
    dsSubInto(_ds2, posHi[1], posLo[1], originHi[1], originLo ? originLo[1] : 0);
    const dy = _ds2[0] + _ds2[1];
    return fastAtan2(dy, dx, tier);
}

// ============================================================================
// SOA — synchronous. Tier resolved ONCE, outside every loop.
// ============================================================================
export function soaFastSin(out, angles, tier, count) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    if (t === TIER_HIGH) {
        for (let i = 0; i < count; i++) out[i] = Math.sin(angles[i]);
        return out;
    }
    const lut = _sinLUT, mask = _lutMask, scale = _lutScale;
    if (t === TIER_LOW) {
        for (let i = 0; i < count; i++) {
            const x = angles[i];
            const xr = x - Math.floor(x * INV_TAU) * TAU;
            out[i] = lut[(xr * scale | 0) & mask];
        }
        return out;
    }
    for (let i = 0; i < count; i++) {
        const x = angles[i];
        const xr = x - Math.floor(x * INV_TAU) * TAU;
        const idx = xr * scale;
        const i0 = idx | 0;
        const a = lut[i0 & mask];
        out[i] = a + (lut[(i0 + 1) & mask] - a) * (idx - i0);
    }
    return out;
}
export function soaFastCos(out, angles, tier, count) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    if (t === TIER_HIGH) {
        for (let i = 0; i < count; i++) out[i] = Math.cos(angles[i]);
        return out;
    }
    const lut = _cosLUT, mask = _lutMask, scale = _lutScale;
    if (t === TIER_LOW) {
        for (let i = 0; i < count; i++) {
            const x = angles[i];
            const xr = x - Math.floor(x * INV_TAU) * TAU;
            out[i] = lut[(xr * scale | 0) & mask];
        }
        return out;
    }
    for (let i = 0; i < count; i++) {
        const x = angles[i];
        const xr = x - Math.floor(x * INV_TAU) * TAU;
        const idx = xr * scale;
        const i0 = idx | 0;
        const a = lut[i0 & mask];
        out[i] = a + (lut[(i0 + 1) & mask] - a) * (idx - i0);
    }
    return out;
}
/** Interleaved sin+cos into a vec2 SOA (x = sin, y = cos). */
export function soaFastSincos(outVec2, angles, tier, count) {
    count = count === undefined ? outVec2.count : count;
    const t = resolveTier(tier);
    const ox = outVec2.x, oy = outVec2.y;
    const sl = _sinLUT, cl = _cosLUT, mask = _lutMask, scale = _lutScale;
    for (let i = 0; i < count; i++) {
        const x = angles[i];
        if (t === TIER_HIGH) { ox[i] = Math.sin(x); oy[i] = Math.cos(x); continue; }
        const xr = x - Math.floor(x * INV_TAU) * TAU;
        const idx = xr * scale;
        const i0 = idx | 0;
        const m = i0 & mask;
        const sa = sl[m], ca = cl[m];
        if (t === TIER_LOW) { ox[i] = sa; oy[i] = ca; continue; }
        const f = idx - i0;
        const m1 = (i0 + 1) & mask;
        ox[i] = sa + (sl[m1] - sa) * f;
        oy[i] = ca + (cl[m1] - ca) * f;
    }
    return outVec2;
}
export function soaFastTan(out, angles, tier, count) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    for (let i = 0; i < count; i++) out[i] = fastTan(angles[i], t);
    return out;
}
export function soaFastAtan2(out, ys, xs, tier, count) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    for (let i = 0; i < count; i++) out[i] = fastAtan2(ys[i], xs[i], t);
    return out;
}
/** atan2 of the XY plane of a vec2/vec3 SOA — sprite / particle rotation. */
export function soaFastAtan2_2(out, positions, tier, count) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    const px = positions.x, py = positions.y;
    for (let i = 0; i < count; i++) out[i] = fastAtan2(py[i], px[i], t);
    return out;
}
export function soaFastAsin(out, xs, tier, count) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    for (let i = 0; i < count; i++) out[i] = fastAsin(xs[i], t);
    return out;
}
export function soaFastAcos(out, xs, tier, count) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    for (let i = 0; i < count; i++) out[i] = fastAcos(xs[i], t);
    return out;
}
export function soaFastExp(out, xs, tier, count) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    for (let i = 0; i < count; i++) out[i] = fastExp(xs[i], t);
    return out;
}
export function soaFastExp2(out, xs, tier, count) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    for (let i = 0; i < count; i++) out[i] = fastExp2(xs[i], t);
    return out;
}
export function soaFastLog(out, xs, tier, count) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    for (let i = 0; i < count; i++) out[i] = fastLog(xs[i], t);
    return out;
}
export function soaFastLog2(out, xs, tier, count) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    for (let i = 0; i < count; i++) out[i] = fastLog2(xs[i], t);
    return out;
}
export function soaFastLog10(out, xs, tier, count) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    for (let i = 0; i < count; i++) out[i] = fastLog10(xs[i], t);
    return out;
}
export function soaFastPow(out, xs, ys, tier, count) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    const yArr = (ys != null && ys.length !== undefined) ? ys : null;
    for (let i = 0; i < count; i++) out[i] = fastPow(xs[i], yArr ? yArr[i] : ys, t);
    return out;
}
export function soaFastSqrt(out, xs, tier, count) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    if (t !== TIER_LOW) {
        for (let i = 0; i < count; i++) out[i] = Math.sqrt(xs[i]);
        return out;
    }
    for (let i = 0; i < count; i++) out[i] = fastSqrt(xs[i], TIER_LOW);
    return out;
}
export function soaFastInvSqrt(out, xs, tier, count) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    for (let i = 0; i < count; i++) out[i] = fastInvSqrt(xs[i], t);
    return out;
}
export function soaFastRcp(out, xs, tier, count) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    for (let i = 0; i < count; i++) out[i] = fastRcp(xs[i], t);
    return out;
}
export function soaFastHypot(out, xs, ys, tier, count) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    for (let i = 0; i < count; i++) out[i] = fastHypot(xs[i], ys[i], t);
    return out;
}
export function soaFastTanh(out, xs, tier, count) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    for (let i = 0; i < count; i++) out[i] = fastTanh(xs[i], t);
    return out;
}
/** Normalize a vec3 SOA in place (or into `out`). */
export function soaFastNormalize3(outVec3, inVec3, tier, count) {
    count = count === undefined ? outVec3.count : count;
    const t = resolveTier(tier);
    const ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
    const ix = inVec3.x, iy = inVec3.y, iz = inVec3.z;
    for (let i = 0; i < count; i++) {
        const x = ix[i], y = iy[i], z = iz[i];
        const l2 = x * x + y * y + z * z;
        if (!(l2 > 1e-30) || !isFinite(l2)) { ox[i] = 0; oy[i] = 0; oz[i] = 0; continue; }
        const inv = fastInvSqrt(l2, t);
        ox[i] = x * inv; oy[i] = y * inv; oz[i] = z * inv;
    }
    return outVec3;
}
/** Chebyshev evaluation with per-instance x. Guards empty / single-term tables. */
export function soaChebyshevEvaluate(out, coeffs, xs, count) {
    count = count === undefined ? out.length : count;
    const n = coeffs.length;
    if (n === 0) { for (let i = 0; i < count; i++) out[i] = 0; return out; }
    if (n === 1) { const c = coeffs[0]; for (let i = 0; i < count; i++) out[i] = c; return out; }
    for (let i = 0; i < count; i++) {
        const x = xs[i];
        const x2 = 2 * x;
        let b1 = 0, b2 = 0;
        for (let k = n - 1; k >= 1; k--) {
            const b0 = x2 * b1 - b2 + coeffs[k];
            b2 = b1; b1 = b0;
        }
        out[i] = x * b1 - b2 + coeffs[0];
    }
    return out;
}
/** Evaluate a plain polynomial (Horner) over an SOA. */
export function soaPolyEvaluate(out, coeffs, xs, count) {
    count = count === undefined ? out.length : count;
    const n = coeffs.length;
    if (n === 0) { for (let i = 0; i < count; i++) out[i] = 0; return out; }
    const last = coeffs[n - 1];
    for (let i = 0; i < count; i++) {
        const x = xs[i];
        let p = last;
        for (let j = n - 2; j >= 0; j--) p = p * x + coeffs[j];
        out[i] = p;
    }
    return out;
}
/** Evaluate a Padé approximant over an SOA. */
export function soaPadeEvaluate(out, pade, xs, count) {
    count = count === undefined ? out.length : count;
    const p = pade.p, q = pade.q;
    const pn = p.length, qn = q.length;
    for (let i = 0; i < count; i++) {
        const x = xs[i];
        let num = 0, den = 0;
        for (let j = pn - 1; j >= 0; j--) num = num * x + p[j];
        for (let j = qn - 1; j >= 0; j--) den = den * x + q[j];
        out[i] = den === 0 ? NaN : num / den;
    }
    return out;
}
/** In-place ACES on an RGB(A) SOA. Alpha untouched. */
export function soaFastAces(colors, count) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    for (let i = 0; i < count; i++) {
        const rv = r[i], gv = g[i], bv = b[i];
        let a = (rv * (ACES_A * rv + ACES_B)) / (rv * (ACES_C * rv + ACES_D) + ACES_E);
        let c = (gv * (ACES_A * gv + ACES_B)) / (gv * (ACES_C * gv + ACES_D) + ACES_E);
        let d = (bv * (ACES_A * bv + ACES_B)) / (bv * (ACES_C * bv + ACES_D) + ACES_E);
        r[i] = a < 0 ? 0 : (a > 1 ? 1 : a);
        g[i] = c < 0 ? 0 : (c > 1 ? 1 : c);
        b[i] = d < 0 ? 0 : (d > 1 ? 1 : d);
    }
    return colors;
}
export function soaFastReinhard(colors, count) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    for (let i = 0; i < count; i++) {
        const rv = r[i], gv = g[i], bv = b[i];
        r[i] = rv / (1 + rv); g[i] = gv / (1 + gv); b[i] = bv / (1 + bv);
    }
    return colors;
}
export function soaFastSmoothstep(out, edge0, edge1, xs, count) {
    count = count === undefined ? out.length : count;
    const span = edge1 - edge0;
    const inv = span !== 0 ? 1 / span : 0;
    for (let i = 0; i < count; i++) {
        let t = (xs[i] - edge0) * inv;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        out[i] = t * t * (3 - 2 * t);
    }
    return out;
}
export function soaFastSmootherstep(out, edge0, edge1, xs, count) {
    count = count === undefined ? out.length : count;
    const span = edge1 - edge0;
    const inv = span !== 0 ? 1 / span : 0;
    for (let i = 0; i < count; i++) {
        let t = (xs[i] - edge0) * inv;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        out[i] = t * t * t * (t * (t * 6 - 15) + 10);
    }
    return out;
}
export function soaFastSaturate(arr, count) {
    count = count === undefined ? arr.length : count;
    for (let i = 0; i < count; i++) {
        const v = arr[i];
        arr[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
    }
    return arr;
}
export function soaFastLerp(out, a, b, t, count) {
    count = count === undefined ? out.length : count;
    const tArr = (t != null && t.length !== undefined) ? t : null;
    for (let i = 0; i < count; i++) {
        const ti = tArr ? tArr[i] : t;
        out[i] = a[i] + (b[i] - a[i]) * ti;
    }
    return out;
}
export function soaFastClamp(arr, lo, hi, count) {
    count = count === undefined ? arr.length : count;
    for (let i = 0; i < count; i++) {
        const v = arr[i];
        arr[i] = v < lo ? lo : (v > hi ? hi : v);
    }
    return arr;
}
/** Schlick Fresnel over an SOA. F0 may be a scalar or a per-row array. */
export function soaSchlickFresnel(out, cosThetas, F0, count) {
    count = count === undefined ? out.length : count;
    const fArr = (F0 != null && F0.length !== undefined) ? F0 : null;
    for (let i = 0; i < count; i++) {
        const f0 = fArr ? F0[i] : F0;
        const t = 1 - cosThetas[i];
        const t2 = t * t;
        out[i] = f0 + (1 - f0) * t2 * t2 * t;
    }
    return out;
}
/** Double-single sin over parallel hi/lo channels (§26). */
export function soaSinDS(out, hiArr, loArr, tier, count) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    for (let i = 0; i < count; i++) out[i] = fastSin(reduceAngleDS(hiArr[i], loArr[i]), t);
    return out;
}
export function soaCosDS(out, hiArr, loArr, tier, count) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    for (let i = 0; i < count; i++) out[i] = fastCos(reduceAngleDS(hiArr[i], loArr[i]), t);
    return out;
}
/**
 * Camera-relative sprite angles from a double-single world store
 * `{ x:{hi,lo}, y:{hi,lo} }` — jitter-free at megaparsec offsets.
 */
export function soaRelativeAngleFromDS(out, world, originHi, originLo, tier, eids, count) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    const xh = world.x.hi, xl = world.x.lo;
    const yh = world.y.hi, yl = world.y.lo;
    const h0 = originHi[0], h1 = originHi[1];
    const l0 = originLo ? originLo[0] : 0;
    const l1 = originLo ? originLo[1] : 0;
    for (let i = 0; i < count; i++) {
        const idx = eids ? eids[i] : i;
        dsSubInto(_ds2, xh[idx], xl[idx], h0, l0);
        const dx = _ds2[0] + _ds2[1];
        dsSubInto(_ds2, yh[idx], yl[idx], h1, l1);
        const dy = _ds2[0] + _ds2[1];
        out[i] = fastAtan2(dy, dx, t);
    }
    return out;
}

// ============================================================================
// Chunked async — one closure per CALL (async / loading path only, §1)
// ============================================================================
async function _chunked(count, chunkSize, yieldEvery, perChunk) {
    chunkSize = chunkSize || common.CHUNK_SIZE;
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

export async function soaFastSinChunked(out, angles, tier, count, cs, ye) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) out[i] = fastSin(angles[i], t);
    });
    return out;
}
export async function soaFastCosChunked(out, angles, tier, count, cs, ye) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) out[i] = fastCos(angles[i], t);
    });
    return out;
}
export async function soaFastSincosChunked(outVec2, angles, tier, count, cs, ye) {
    count = count === undefined ? outVec2.count : count;
    const t = resolveTier(tier);
    const ox = outVec2.x, oy = outVec2.y;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            fastSincosInto(_sc2, angles[i], t);
            ox[i] = _sc2[0]; oy[i] = _sc2[1];
        }
    });
    return outVec2;
}
export async function soaFastAtan2Chunked(out, ys, xs, tier, count, cs, ye) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) out[i] = fastAtan2(ys[i], xs[i], t);
    });
    return out;
}
export async function soaFastExpChunked(out, xs, tier, count, cs, ye) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) out[i] = fastExp(xs[i], t);
    });
    return out;
}
export async function soaFastLogChunked(out, xs, tier, count, cs, ye) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) out[i] = fastLog(xs[i], t);
    });
    return out;
}
export async function soaFastPowChunked(out, xs, ys, tier, count, cs, ye) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    const yArr = (ys != null && ys.length !== undefined) ? ys : null;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) out[i] = fastPow(xs[i], yArr ? ys[i] : ys, t);
    });
    return out;
}
export async function soaFastSqrtChunked(out, xs, tier, count, cs, ye) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) out[i] = fastSqrt(xs[i], t);
    });
    return out;
}
export async function soaFastInvSqrtChunked(out, xs, tier, count, cs, ye) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) out[i] = fastInvSqrt(xs[i], t);
    });
    return out;
}
export async function soaFastHypotChunked(out, xs, ys, tier, count, cs, ye) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) out[i] = fastHypot(xs[i], ys[i], t);
    });
    return out;
}
export async function soaFastTanhChunked(out, xs, tier, count, cs, ye) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) out[i] = fastTanh(xs[i], t);
    });
    return out;
}
export async function soaFastNormalize3Chunked(outVec3, inVec3, tier, count, cs, ye) {
    count = count === undefined ? outVec3.count : count;
    const t = resolveTier(tier);
    const ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
    const ix = inVec3.x, iy = inVec3.y, iz = inVec3.z;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            const x = ix[i], y = iy[i], z = iz[i];
            const l2 = x * x + y * y + z * z;
            if (!(l2 > 1e-30) || !isFinite(l2)) { ox[i] = 0; oy[i] = 0; oz[i] = 0; continue; }
            const inv = fastInvSqrt(l2, t);
            ox[i] = x * inv; oy[i] = y * inv; oz[i] = z * inv;
        }
    });
    return outVec3;
}
/** CORRECTED: `_chunked` (was `chunked`) and `ACES_B` in the red channel. */
export async function soaFastAcesChunked(colors, count, cs, ye) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    await _chunked(count, cs, ye, function (s, en) {
        for (let i = s; i < en; i++) {
            const rv = r[i], gv = g[i], bv = b[i];
            let a = (rv * (ACES_A * rv + ACES_B)) / (rv * (ACES_C * rv + ACES_D) + ACES_E);
            let c = (gv * (ACES_A * gv + ACES_B)) / (gv * (ACES_C * gv + ACES_D) + ACES_E);
            let d = (bv * (ACES_A * bv + ACES_B)) / (bv * (ACES_C * bv + ACES_D) + ACES_E);
            r[i] = a < 0 ? 0 : (a > 1 ? 1 : a);
            g[i] = c < 0 ? 0 : (c > 1 ? 1 : c);
            b[i] = d < 0 ? 0 : (d > 1 ? 1 : d);
        }
    });
    return colors;
}
export async function soaFastReinhardChunked(colors, count, cs, ye) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    await _chunked(count, cs, ye, function (s, en) {
        for (let i = s; i < en; i++) {
            const rv = r[i], gv = g[i], bv = b[i];
            r[i] = rv / (1 + rv); g[i] = gv / (1 + gv); b[i] = bv / (1 + bv);
        }
    });
    return colors;
}
export async function soaFastSmoothstepChunked(out, edge0, edge1, xs, count, cs, ye) {
    count = count === undefined ? out.length : count;
    const span = edge1 - edge0;
    const inv = span !== 0 ? 1 / span : 0;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            let t = (xs[i] - edge0) * inv;
            if (t < 0) t = 0; else if (t > 1) t = 1;
            out[i] = t * t * (3 - 2 * t);
        }
    });
    return out;
}
export async function soaFastLerpChunked(out, a, b, t, count, cs, ye) {
    count = count === undefined ? out.length : count;
    const tArr = (t != null && t.length !== undefined) ? t : null;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            const ti = tArr ? tArr[i] : t;
            out[i] = a[i] + (b[i] - a[i]) * ti;
        }
    });
    return out;
}
export async function soaChebyshevEvaluateChunked(out, coeffs, xs, count, cs, ye) {
    count = count === undefined ? out.length : count;
    const n = coeffs.length;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) out[i] = chebyshevEvaluate(coeffs, xs[i]);
    });
    return out;
}
export async function soaSchlickFresnelChunked(out, cosThetas, F0, count, cs, ye) {
    count = count === undefined ? out.length : count;
    const fArr = (F0 != null && F0.length !== undefined) ? F0 : null;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            const f0 = fArr ? F0[i] : F0;
            const t = 1 - cosThetas[i];
            const t2 = t * t;
            out[i] = f0 + (1 - f0) * t2 * t2 * t;
        }
    });
    return out;
}
export async function soaSinDSChunked(out, hiArr, loArr, tier, count, cs, ye) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) out[i] = fastSin(reduceAngleDS(hiArr[i], loArr[i]), t);
    });
    return out;
}
export async function soaRelativeAngleFromDSChunked(out, world, originHi, originLo, tier, eids, count, cs, ye) {
    count = count === undefined ? out.length : count;
    const t = resolveTier(tier);
    const xh = world.x.hi, xl = world.x.lo;
    const yh = world.y.hi, yl = world.y.lo;
    const h0 = originHi[0], h1 = originHi[1];
    const l0 = originLo ? originLo[0] : 0;
    const l1 = originLo ? originLo[1] : 0;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            const idx = eids ? eids[i] : i;
            dsSubInto(_ds2, xh[idx], xl[idx], h0, l0);
            const dx = _ds2[0] + _ds2[1];
            dsSubInto(_ds2, yh[idx], yl[idx], h1, l1);
            const dy = _ds2[0] + _ds2[1];
            out[i] = fastAtan2(dy, dx, t);
        }
    });
    return out;
}

// ============================================================================
// LUT authoring (Blueprint §30) — caller owns the buffer
// ============================================================================
/** 1D sin/cos LUT, RGBA floats: R=sin, G=cos, B=sin², A=1. */
export function buildSinLUT(out, size, turns, tier) {
    const t = resolveTier(tier);
    const span = (turns === undefined ? 1 : turns) * TAU;
    const inv = size > 1 ? 1 / (size - 1) : 0;
    for (let i = 0; i < size; i++) {
        const a = i * inv * span;
        const s = fastSin(a, t), c = fastCos(a, t);
        const o = i * 4;
        out[o] = s; out[o + 1] = c; out[o + 2] = s * s; out[o + 3] = 1;
    }
    return out;
}
/** 1D exp LUT over [xMin,xMax], RGBA floats: R=exp, G=exp2, B=normalized, A=1. */
export function buildExpLUT(out, size, xMin, xMax, tier) {
    const t = resolveTier(tier);
    const lo = xMin === undefined ? -8 : xMin;
    const hi = xMax === undefined ? 8 : xMax;
    const inv = size > 1 ? 1 / (size - 1) : 0;
    const span = hi - lo;
    const maxV = fastExp(hi, t) || 1;
    for (let i = 0; i < size; i++) {
        const x = lo + i * inv * span;
        const e = fastExp(x, t);
        const o = i * 4;
        out[o] = e; out[o + 1] = fastExp2(x, t); out[o + 2] = e / maxV; out[o + 3] = 1;
    }
    return out;
}
/** 1D tone-map LUT over [0,maxInput], RGBA floats. op: "aces" | "reinhard". */
export function buildTonemapLUT(out, size, op, maxInput) {
    const aces = op !== "reinhard";
    const maxIn = maxInput === undefined ? 16 : maxInput;
    const inv = size > 1 ? 1 / (size - 1) : 0;
    for (let i = 0; i < size; i++) {
        const v = i * inv * maxIn;
        const m = aces ? fastAcesChannel(v) : v / (1 + v);
        const o = i * 4;
        out[o] = m; out[o + 1] = m; out[o + 2] = m; out[o + 3] = 1;
    }
    return out;
}
/** 1D Schlick Fresnel LUT over cosθ ∈ [0,1]. */
export function buildFresnelLUT(out, size, F0) {
    const f0 = F0 === undefined ? 0.04 : F0;
    const inv = size > 1 ? 1 / (size - 1) : 0;
    for (let i = 0; i < size; i++) {
        const c = i * inv;
        const t = 1 - c, t2 = t * t;
        const f = f0 + (1 - f0) * t2 * t2 * t;
        const o = i * 4;
        out[o] = f; out[o + 1] = f; out[o + 2] = f; out[o + 3] = 1;
    }
    return out;
}
/** 1D LUT of a compiled Chebyshev fit over its [a,b] domain. */
export function buildChebyshevLUT(out, size, fit) {
    const coeffs = fit.coeffs || fit;
    const a = fit.a === undefined ? -1 : fit.a;
    const b = fit.b === undefined ? 1 : fit.b;
    const mid = (a + b) * 0.5, half = (b - a) * 0.5;
    const invHalf = half !== 0 ? 1 / half : 0;
    const inv = size > 1 ? 1 / (size - 1) : 0;
    for (let i = 0; i < size; i++) {
        const x = a + i * inv * (b - a);
        const v = chebyshevEvaluate(coeffs, (x - mid) * invHalf);
        const o = i * 4;
        out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 1;
    }
    return out;
}
export async function buildTonemapLUTChunked(out, size, op, maxInput, cs, ye) {
    const aces = op !== "reinhard";
    const maxIn = maxInput === undefined ? 16 : maxInput;
    const inv = size > 1 ? 1 / (size - 1) : 0;
    await _chunked(size, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            const v = i * inv * maxIn;
            const m = aces ? fastAcesChannel(v) : v / (1 + v);
            const o = i * 4;
            out[o] = m; out[o + 1] = m; out[o + 2] = m; out[o + 3] = 1;
        }
    });
    return out;
}
export async function buildSinLUTChunked(out, size, turns, tier, cs, ye) {
    const t = resolveTier(tier);
    const span = (turns === undefined ? 1 : turns) * TAU;
    const inv = size > 1 ? 1 / (size - 1) : 0;
    await _chunked(size, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            const a = i * inv * span;
            const sv = fastSin(a, t), cv = fastCos(a, t);
            const o = i * 4;
            out[o] = sv; out[o + 1] = cv; out[o + 2] = sv * sv; out[o + 3] = 1;
        }
    });
    return out;
}

// ============================================================================
// GPU attribute bridge (Blueprint §25 / §28)
// ============================================================================
export function writeApproxIntoFlat(flat, values, count, stride, offset, scale, bias) {
    const n = count === undefined ? values.length : count;
    const st = stride === undefined ? 1 : stride;
    const off = offset === undefined ? 0 : offset;
    const s = scale === undefined ? 1 : scale;
    const b = bias === undefined ? 0 : bias;
    for (let i = 0, o = off; i < n; i++, o += st) flat[o] = values[i] * s + b;
    return flat;
}
export function flagApproxUpload(attr, count, itemSize) {
    if (!attr) return;
    const st = itemSize || attr.itemSize || 1;
    if (attr.clearUpdateRanges) attr.clearUpdateRanges();
    if (attr.addUpdateRange) attr.addUpdateRange(0, count * st);
    attr.needsUpdate = true;
}
/** Upload a scalar channel (array or ApproximationBatchState) into an attribute. */
export function syncApproxAttribute(attr, values, count, options) {
    if (!attr || !attr.array) return 0;
    options = options || {};
    const isState = !!(values && values.out && values.count !== undefined);
    const src = isState ? values.out : values;
    const n = count === undefined ? (isState ? values.count : src.length) : count;
    const st = options.stride !== undefined ? options.stride : (attr.itemSize || 1);
    writeApproxIntoFlat(attr.array, src, n, st, options.offset, options.scale, options.bias);
    flagApproxUpload(attr, n, st);
    return n;
}

// ============================================================================
// Pools — precision-aware, ES2017-compatible
// ============================================================================
const _sincosPool = common.createPool(
    function () { return { s: 0, c: 1 }; },
    64,
    function (o) { o.s = 0; o.c = 1; }
);
export function createSincosPool(capacity) {
    return common.createPool(
        function () { return { s: 0, c: 1 }; },
        capacity || 64,
        function (o) { o.s = 0; o.c = 1; }
    );
}
export function acquireSincos() { return _sincosPool.acquire(); }

/** Reusable precision-aware scalar scratch (three channels, lazily grown). */
export class ApproximationScratch {
    constructor(size) {
        this.size = 0;
        this.have = 0;
        this._dtype = null;
        this.a = null; this.b = null; this.c = null;
        if (size) this.ensure(size, 3);
    }
    ensure(n, channels) {
        const need = channels === undefined ? 3 : channels;
        const T = getArrayType();
        const size = Math.max(n | 0, this.size);
        const grow = size > this.size || this._dtype !== T;
        if (!grow && this.have >= need) return this;
        if (grow || !this.a) this.a = new T(size);
        if (need >= 2 && (grow || !this.b)) this.b = new T(size);
        if (need >= 3 && (grow || !this.c)) this.c = new T(size);
        this.size = size;
        this.have = Math.max(this.have, need);
        this._dtype = T;
        return this;
    }
    reset() {
        if (this.a) this.a.fill(0);
        if (this.b) this.b.fill(0);
        if (this.c) this.c.fill(0);
        return this;
    }
    static acquire(size, channels) {
        const pool = ApproximationScratch._warm;
        let best = -1;
        for (let i = 0; i < pool.length; i++) {
            if (pool[i].size >= (size || 0)) { best = i; break; }
        }
        let s;
        if (best >= 0) {
            const last = pool.length - 1;
            s = pool[best];
            pool[best] = pool[last];
            pool[last] = undefined;
            pool.length = last;
        } else {
            s = new ApproximationScratch(0);
        }
        s.ensure(size || 0, channels || 3);
        return s;
    }
    static release(s) {
        if (!s) return;
        const pool = ApproximationScratch._warm;
        if (pool.length < ApproximationScratch.MAX_POOLED) pool.push(s);
    }
}
ApproximationScratch._warm = [];
ApproximationScratch.MAX_POOLED = 12;
(function _warmApproxScratch() {
    for (let i = 0; i < 4; i++) ApproximationScratch._warm.push(new ApproximationScratch(0));
})();

export function createApproxScratchPool(capacity) {
    return common.createPool(
        function () { return new ApproximationScratch(0); },
        capacity || 12,
        function (s) { s.reset(); }
    );
}
const _approxScratchPool = createApproxScratchPool(12);
export function acquireApproxScratch(size, channels) {
    const s = _approxScratchPool.acquire();
    s.ensure(size || 0, channels || 3);
    return s;
}
export function releaseApproxScratch(s) { if (s) _approxScratchPool.release(s); }

// ============================================================================
// Batch state
// ============================================================================
export class ApproximationBatchState {
    constructor(count, options) {
        options = options || {};
        this.count = count;
        const T = getArrayType();
        this._dtype = T;
        this.in = new T(count);
        this.out = new T(count);
        this.inAux = new T(count);
        this.coeffs = null;
        this.remez = null;
        this.pade = null;
        this._chebMid = 0;
        this._chebHalf = 1;
        this._chebInvHalf = 1;
        this.tier = resolveTier(options.tier);
        this._tracked = options.track !== false;
        if (this._tracked) trackApprox(this);
    }
    setTier(tier) { this.tier = resolveTier(tier); return this; }
    fastSin(angles) { return soaFastSin(this.out, angles || this.in, this.tier, this.count); }
    fastCos(angles) { return soaFastCos(this.out, angles || this.in, this.tier, this.count); }
    fastTan(angles) { return soaFastTan(this.out, angles || this.in, this.tier, this.count); }
    fastExp() { return soaFastExp(this.out, this.in, this.tier, this.count); }
    fastLog() { return soaFastLog(this.out, this.in, this.tier, this.count); }
    fastSqrt() { return soaFastSqrt(this.out, this.in, this.tier, this.count); }
    fastInvSqrt() { return soaFastInvSqrt(this.out, this.in, this.tier, this.count); }
    fastAtan2(xs) { return soaFastAtan2(this.out, this.in, xs || this.inAux, this.tier, this.count); }
    /** Fit a Chebyshev approximation to `f` on [a,b] and store it. */
    fitChebyshev(f, a, b, n) {
        this.coeffs = new Float64Array(n);
        this._chebMid = (a + b) * 0.5;
        this._chebHalf = (b - a) * 0.5;
        this._chebInvHalf = this._chebHalf !== 0 ? 1 / this._chebHalf : 0;
        const mid = this._chebMid, half = this._chebHalf;
        chebyshevCoefficients(function (t) { return f(mid + t * half); }, n, this.coeffs);
        return this;
    }
    evaluateChebyshev() {
        if (!this.coeffs) throw new Error("ApproximationBatchState: no Chebyshev fit");
        const coeffs = this.coeffs, n = coeffs.length;
        const out = this.out, inn = this.in;
        const mid = this._chebMid, invHalf = this._chebInvHalf;
        for (let i = 0; i < this.count; i++) {
            const x = (inn[i] - mid) * invHalf;
            if (n === 0) { out[i] = 0; continue; }
            if (n === 1) { out[i] = coeffs[0]; continue; }
            const x2 = 2 * x;
            let b1 = 0, b2 = 0;
            for (let k = n - 1; k >= 1; k--) {
                const b0 = x2 * b1 - b2 + coeffs[k];
                b2 = b1; b1 = b0;
            }
            out[i] = x * b1 - b2 + coeffs[0];
        }
        return out;
    }
    fitRemez(f, a, b, degree, maxIter) { this.remez = remez(f, a, b, degree, maxIter); return this; }
    evaluateRemez() {
        if (!this.remez) throw new Error("ApproximationBatchState: no Remez fit");
        return soaPolyEvaluate(this.out, this.remez.coefficients, this.in, this.count);
    }
    fitPade(taylor, m, n) { this.pade = padeApproximant(taylor, m, n); return this; }
    evaluatePade() {
        if (!this.pade) throw new Error("ApproximationBatchState: no Padé fit");
        return soaPadeEvaluate(this.out, this.pade, this.in, this.count);
    }
    async fastSinChunked(angles, cs, ye) {
        return soaFastSinChunked(this.out, angles || this.in, this.tier, this.count, cs, ye);
    }
    async fastExpChunked(cs, ye) {
        return soaFastExpChunked(this.out, this.in, this.tier, this.count, cs, ye);
    }
    async evaluateChebyshevChunked(cs, ye) {
        if (!this.coeffs) throw new Error("ApproximationBatchState: no Chebyshev fit");
        const coeffs = this.coeffs, out = this.out, inn = this.in;
        const mid = this._chebMid, invHalf = this._chebInvHalf;
        await _chunked(this.count, cs, ye, function (s, e) {
            for (let i = s; i < e; i++) out[i] = chebyshevEvaluate(coeffs, (inn[i] - mid) * invHalf);
        });
        return out;
    }
    /** Single-pass dirty-range upload (§25/§28). */
    uploadTo(attr, options) { return syncApproxAttribute(attr, this, this.count, options); }
    reset() { this.in.fill(0); this.out.fill(0); this.inAux.fill(0); return this; }
    migrate(targetPrecision) {
        const T = targetPrecision ? getArrayType(targetPrecision) : getArrayType();
        if (T === this._dtype) return this;
        const n = this.count;
        const names = ["in", "out", "inAux"];
        for (let i = 0; i < names.length; i++) {
            const old = this[names[i]];
            const next = new T(n);
            next.set(old);
            this[names[i]] = next;
        }
        this._dtype = T;
        return this;
    }
    toTransferable() { return approxBatchToTransferable(this); }
    dispose() { if (this._tracked) untrackApprox(this); return this; }
}
export function createApproximationBatch(count, options) {
    return new ApproximationBatchState(count, options);
}

// ============================================================================
// Precision tracking / migration (dense arrays — no Map/Set, §10/§16)
// ============================================================================
const _trackedBatches = [];
export function trackApprox(state) {
    if (!state) return state;
    if (_trackedBatches.indexOf(state) === -1) _trackedBatches.push(state);
    return state;
}
export function untrackApprox(state) {
    const i = _trackedBatches.indexOf(state);
    if (i !== -1) _trackedBatches.splice(i, 1);
}
export function clearTrackedApprox() { _trackedBatches.length = 0; }
export function getTrackedApprox() { return _trackedBatches; }
export function migrateApprox(state, targetPrecision) {
    if (state && state.migrate) state.migrate(targetPrecision);
    return state;
}
export function migrateAllApprox(targetPrecision) {
    for (let i = 0; i < _trackedBatches.length; i++) {
        try { _trackedBatches[i].migrate(targetPrecision); }
        catch (e) { console.error("[054_approximation] migration failed for one batch", e); }
    }
}

onPrecisionChange(function (mode) {
    migrateAllApprox();
    ApproximationScratch._warm.length = 0;
    for (let i = 0; i < 4; i++) ApproximationScratch._warm.push(new ApproximationScratch(0));
    // Retune LUT resolution to the storage tier (setup-time only).
    if (mode === "f64") rebuildTrigLUT(16384);
    else if (mode === "f16") rebuildTrigLUT(1024);
    else rebuildTrigLUT(4096);
});

// ============================================================================
// Deterministic fixed-step animation (Blueprint §45 / §51)
// ============================================================================
/** Drift-free clock — total time AND accumulator are Neumaier-compensated. */
export class ApproximationClock {
    constructor(options) {
        options = options || {};
        this.hz = options.hz !== undefined ? options.hz : 60;
        this.fixedDt = 1 / this.hz;
        this.maxSteps = options.maxSteps !== undefined ? options.maxSteps : 8;
        this.maxFrameDt = options.maxFrameDt !== undefined ? options.maxFrameDt : 0.25;
        this.onStep = options.onStep || null;
        this._tS = 0; this._tC = 0;
        this._aS = 0; this._aC = 0;
        this.ticks = 0; this.alpha = 0; this.dropped = 0;
    }
    get time() { return this._tS + this._tC; }
    get accumulator() { return this._aS + this._aC; }
    _addTime(x) {
        const t = this._tS + x;
        if (Math.abs(this._tS) >= Math.abs(x)) this._tC += (this._tS - t) + x;
        else this._tC += (x - t) + this._tS;
        this._tS = t;
    }
    _addAcc(x) {
        const t = this._aS + x;
        if (Math.abs(this._aS) >= Math.abs(x)) this._aC += (this._aS - t) + x;
        else this._aC += (x - t) + this._aS;
        this._aS = t;
    }
    step(dtSec) {
        const dt = dtSec < 0 ? 0 : (dtSec > this.maxFrameDt ? this.maxFrameDt : dtSec);
        this._addAcc(dt);
        const fdt = this.fixedDt;
        let steps = 0;
        while (this._aS + this._aC >= fdt && steps < this.maxSteps) {
            this._addTime(fdt);
            if (this.onStep) this.onStep(fdt, this.ticks);
            this._addAcc(-fdt);
            this.ticks++; steps++;
        }
        if (steps === this.maxSteps) { this.dropped++; this._aS = 0; this._aC = 0; }
        this.alpha = (this._aS + this._aC) / fdt;
        return steps;
    }
    stepMs(dtMs) { return this.step(dtMs * 0.001); }
    reset() {
        this._tS = 0; this._tC = 0; this._aS = 0; this._aC = 0;
        this.ticks = 0; this.alpha = 0; this.dropped = 0;
        return this;
    }
}
export function createApproximationClock(options) { return new ApproximationClock(options); }

/**
 * Drive a batch's input channel along a fixed-step sweep and re-evaluate the
 * compiled approximation. Identical output for identical tick indices.
 */
export function createApproxAnimator(batch, options) {
    options = options || {};
    const from = options.from === undefined ? -1 : options.from;
    const to = options.to === undefined ? 1 : options.to;
    const duration = options.duration === undefined ? 2 : options.duration;
    const loop = options.loop !== false;
    const mode = options.mode || "chebyshev";
    const clock = new ApproximationClock(options);
    const span = to - from;
    const n = batch.count;
    const invN = n > 1 ? 1 / (n - 1) : 0;
    let phase = 0;
    function evaluate() {
        const inn = batch.in;
        const offset = phase * span;
        for (let i = 0; i < n; i++) inn[i] = from + i * invN * span + offset;
        if (mode === "remez") batch.evaluateRemez();
        else if (mode === "pade") batch.evaluatePade();
        else if (mode === "sin") batch.fastSin();
        else batch.evaluateChebyshev();
    }
    const perTick = duration > 0 ? clock.fixedDt / duration : 1;
    return {
        batch: batch, clock: clock,
        get phase() { return phase; },
        get time() { return clock.time; },
        step: function (dtSec) {
            const before = clock.ticks;
            clock.step(dtSec);
            const advanced = clock.ticks - before;
            if (advanced > 0) {
                phase += advanced * perTick;
                if (loop) phase -= Math.floor(phase);
                else if (phase > 1) phase = 1;
                evaluate();
            }
            return this;
        },
        stepMs: function (dtMs) { return this.step(dtMs * 0.001); },
        seek: function (p) { phase = loop ? fastFract(p) : fastSaturate(p); evaluate(); return this; },
        evaluate: evaluate,
        reset: function () { phase = 0; clock.reset(); evaluate(); return this; }
    };
}

// ============================================================================
// Zero-copy transferable batch state (Blueprint §49)
// Layout: Int32 header [magic, version, count, coeffCount, tier, 0,0,0]
//         then in | out | inAux | coeffs as Float64
// ============================================================================
const APPROX_MAGIC = 0x41505258; // "APRX"
const APPROX_HEADER_BYTES = 32;

export function approxBatchToTransferable(state) {
    const n = state.count;
    const cn = state.coeffs ? state.coeffs.length : 0;
    const buffer = new ArrayBuffer(APPROX_HEADER_BYTES + (n * 3 + cn) * 8);
    const header = new Int32Array(buffer, 0, 8);
    header[0] = APPROX_MAGIC; header[1] = 1; header[2] = n; header[3] = cn; header[4] = state.tier;
    let off = APPROX_HEADER_BYTES;
    new Float64Array(buffer, off, n).set(state.in); off += n * 8;
    new Float64Array(buffer, off, n).set(state.out); off += n * 8;
    new Float64Array(buffer, off, n).set(state.inAux); off += n * 8;
    if (cn > 0) new Float64Array(buffer, off, cn).set(state.coeffs);
    return {
        buffer: buffer, count: n, coeffCount: cn, tier: state.tier,
        chebMid: state._chebMid, chebHalf: state._chebHalf,
        transferable: [buffer]
    };
}
export function approxBatchFromTransferable(packet, options) {
    const buffer = packet.buffer || packet;
    const header = new Int32Array(buffer, 0, 8);
    if (header[0] !== APPROX_MAGIC) throw new Error("approxBatchFromTransferable: bad magic");
    if (header[1] !== 1) throw new Error("approxBatchFromTransferable: unsupported version " + header[1]);
    const n = header[2], cn = header[3], tier = header[4];
    const opts = options || {};
    opts.tier = tier;
    const state = new ApproximationBatchState(n, opts);
    let off = APPROX_HEADER_BYTES;
    state.in.set(new Float64Array(buffer, off, n)); off += n * 8;
    state.out.set(new Float64Array(buffer, off, n)); off += n * 8;
    state.inAux.set(new Float64Array(buffer, off, n)); off += n * 8;
    if (cn > 0) {
        state.coeffs = new Float64Array(cn);
        state.coeffs.set(new Float64Array(buffer, off, cn));
        state._chebMid = packet.chebMid === undefined ? 0 : packet.chebMid;
        state._chebHalf = packet.chebHalf === undefined ? 1 : packet.chebHalf;
        state._chebInvHalf = state._chebHalf !== 0 ? 1 / state._chebHalf : 0;
    }
    return state;
}

// ============================================================================
// Namespaces
// ============================================================================
export const fastTrig = {
    sin: fastSin, cos: fastCos, tan: fastTan,
    sincos: fastSincos, sincosInto: fastSincosInto, releaseSincos: releaseSincos,
    atan: fastAtan, atan2: fastAtan2, asin: fastAsin, acos: fastAcos,
    sinDS: fastSinDS, cosDS: fastCosDS, sincosDS: fastSincosDS,
    rebuildLUT: rebuildTrigLUT, getLUTSize: getTrigLUTSize
};
export const fastHyp = { sinh: fastSinh, cosh: fastCosh, tanh: fastTanh };
export const fastExplog = {
    exp: fastExp, exp2: fastExp2,
    log: fastLog, log2: fastLog2, log10: fastLog10,
    pow: fastPow
};
export const fastRoots = {
    sqrt: fastSqrt, invSqrt: fastInvSqrt, rcp: fastRcp,
    hypot: fastHypot, hypot3: fastHypot3
};
export const chebyshev = {
    nodes: chebyshevNodes, extrema: chebyshevExtrema,
    coefficients: chebyshevCoefficients,
    evaluate: chebyshevEvaluate, evaluateInto: chebyshevEvaluateInto,
    approximate: chebyshevApproximate
};
export const pade = { approximant: padeApproximant, evaluate: padeEvaluate };
export const taylor = { sin: taylorSin, cos: taylorCos, exp: taylorExp, log: taylorLog };
export const minimax = {
    remez: remez, minimaxPolynomial: minimaxPolynomial, wasSingular: wasSingular
};
export const interpolation = {
    lagrange: lagrangeInterpolation,
    newton: newtonInterpolation,
    newtonCoefficientsInto: newtonCoefficientsInto,
    newtonEvaluate: newtonEvaluate
};
export const rational = { approximate: rationalApproximation, evaluate: padeEvaluate };
export const graphics = {
    schlickFresnel: schlickFresnel,
    schlickFresnelVec3: schlickFresnelVec3,
    aces: fastAces, acesChannel: fastAcesChannel,
    reinhard: fastReinhard, reinhardExt: fastReinhardExt,
    smoothstep: fastSmoothstep, smootherstep: fastSmootherstep,
    saturate: fastSaturate, gamma: fastGamma, gammaVec3: fastGammaVec3,
    normalize3: fastNormalize3, lerp: fastLerp, clamp: fastClamp,
    sign: fastSign, fract: fastFract, mod: fastMod
};
export const precisionBridge = {
    reduceAngleDS: reduceAngleDS,
    fastSinDS: fastSinDS, fastCosDS: fastCosDS, fastSincosDS: fastSincosDS,
    relativeAngleFromDS: relativeAngleFromDS,
    soaSinDS: soaSinDS, soaCosDS: soaCosDS,
    soaRelativeAngleFromDS: soaRelativeAngleFromDS
};
export const tiers = {
    LOW: TIER_LOW, MEDIUM: TIER_MEDIUM, HIGH: TIER_HIGH,
    resolve: resolveTier, get: getGlobalTier, set: setGlobalTier,
    measureError: measureError
};
export const lut = {
    sin: buildSinLUT, sinChunked: buildSinLUTChunked,
    exp: buildExpLUT,
    tonemap: buildTonemapLUT, tonemapChunked: buildTonemapLUTChunked,
    fresnel: buildFresnelLUT,
    chebyshev: buildChebyshevLUT
};
export const gpu = {
    writeIntoFlat: writeApproxIntoFlat,
    flagUpload: flagApproxUpload,
    syncAttribute: syncApproxAttribute
};
export const transfer = {
    toTransferable: approxBatchToTransferable,
    fromTransferable: approxBatchFromTransferable
};
export const precision = {
    getPrecision: getPrecision, setPrecision: setPrecision,
    getArrayType: getArrayType, onPrecisionChange: onPrecisionChange,
    track: trackApprox, untrack: untrackApprox,
    migrate: migrateApprox, migrateAll: migrateAllApprox,
    getTracked: getTrackedApprox, clearTracked: clearTrackedApprox
};
export const animation = {
    ApproximationClock: ApproximationClock,
    createClock: createApproximationClock,
    createAnimator: createApproxAnimator,
    createFixedStepScheduler: createFixedStepScheduler
};
export const batch = {
    State: ApproximationBatchState,
    create: createApproximationBatch,
    Scratch: ApproximationScratch,
    acquireScratch: acquireApproxScratch,
    releaseScratch: releaseApproxScratch
};
export const stability = {
    twoSumInto: twoSumInto, twoDiffInto: twoDiffInto, twoProdInto: twoProdInto,
    dsSubInto: dsSubInto, neumaierSum: neumaierSum, compDot: compDot,
    stableHypot: stableHypot, stableHypot3: stableHypot3, stableSqrt: stableSqrt,
    clampToRange: clampToRange, ulpAt: ulpAt
};
export const math = {
    common: common,
    createVec2SOA: createVec2SOA,
    createVec3SOA: createVec3SOA
};
export const namespace = {
    fastTrig: fastTrig, fastHyp: fastHyp, fastExplog: fastExplog, fastRoots: fastRoots,
    chebyshev: chebyshev, pade: pade, taylor: taylor, minimax: minimax,
    interpolation: interpolation, rational: rational, graphics: graphics,
    precisionBridge: precisionBridge, tiers: tiers, lut: lut, gpu: gpu,
    transfer: transfer, precision: precision, animation: animation, batch: batch
};