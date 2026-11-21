//File number : 036
// File : src/math/036_numerical-stability.js
//Description : Complete numerical-stability toolkit (ESM) — compensated summation (Kahan,
//              Neumaier, Klein, pairwise), compensated dot / matvec / norms, error-free
//              transformations (TwoSum / TwoDiff / TwoProd / TwoSqr / FastTwoSum), a full
//              double-single (Dekker/Schewchuk) precision bridge, stable quadratic / hypot /
//              sqrt / log / exp / pow / atan2, robust normalize, overflow & denormal guards,
//              ULP / nextAfter for f64 AND f32, stable angle wrap / shortest arc, monotone
//              range-safe lerp, tolerance-aware equality / snapping / quantization,
//              Kepler-equation residual checks, precision-aware SOA + chunked async batches
//              for 1M+ per-frame operations, compensated simulation clocks, zero-copy
//              transferable state for Web Workers, and dirty-range GPU attribute upload.
//
//              CORRECTIONS (this revision):
//              • FATAL: every split identifier / operator repaired (`exports.stableSqrt\n=`,
//                `soaSta\nbleSqrt`, `releaseCo\nmpensation`, `neumaierSum(a\nrr`, `st\nableLog`,
//                `awa\nit`, `cou\nnt`, `max\nMag`, `st\nart`, `#warm.s\nplice`, `c\natch`,
//                and the missing `-` in `c = (t - sum)\ny`).
//              • FATAL: `exports.CompensatedAccumulator / ScalarScratch / StabilityBatchState`
//                read classes from the TDZ at module-evaluation time → ReferenceError on load.
//                Converted to ESM `export class` / `export function`, which hoist correctly.
//              • FATAL Zero-GC: `twoSum / twoDiff / twoProd / twoSqr / fastTwoSum` returned a
//                fresh `{hi, lo}` object per call, and `compDot` called `twoProd` PER ELEMENT —
//                1M+ object allocations per frame. All hot paths now use `*Into(out2, …)`
//                writing into caller-owned Float64Array(2), and `compDot / compDot3 /
//                compMatvec / compNorm` inline the Dekker split with zero allocation.
//              • `kleinSum` second-order compensation was wrong (it dropped the second-level
//                error whenever |cs| < |ccs|). Replaced with the correct Klein recurrence.
//              • `stableQuadratic` divided by `a` without checking `a === 0` (linear case) and
//                computed `b*b - 4*a*c` with catastrophic cancellation. Now handles the
//                degenerate/linear cases and uses an error-free compensated discriminant.
//              • `stablePow` used `exp & 1` for the sign of a negative base — wrong for
//                |exp| > 2^31. Now uses `Math.abs(exp % 2)`.
//              • `monotoneLerp` overflowed when `b - a` exceeded the float range (opposite
//                signs at 1e308). Now branches on sign and clamps monotonically.
//              • `nextAfter` allocated an ArrayBuffer + DataView PER CALL. Now uses module
//                scratch views; added `nextAfterF32` / `ulpAtF32` for f32 pipelines.
//              • `soaStableNormalize` allocated `[0, 0]` per call and called a scalar helper
//                per element. Fully inlined.
//              • `soaMonotoneLerp` only detected TypedArrays (`BYTES_PER_ELEMENT`), silently
//                treating plain Arrays as scalars. Now accepts both.
//              • `twoProd` overflowed the Veltkamp splitter for |x| > ~2^996, producing NaN
//                low words. Guarded.
//              • ES2022 static blocks / private static fields removed so the file parses on
//                older Android WebViews; warm-up runs in plain IIFEs. `static #listeners =
//                new Set()` (a Set in the notification path) replaced with a dense array.
//              • Pool `acquire` used `Array.splice` (allocation per acquire); now swap-removes.
//
//              FEATURES ADDED from corrected_bitecs_enhancement.md:
//              • §26     — THE double-single fix the blueprint calls out: `dsSubInto` performs
//                a full Knuth TwoSum plus renormalization BEFORE any narrowing cast, so the
//                low word is never swallowed. Full DS arithmetic (`dsAddInto`, `dsMulInto`,
//                `dsMul21Into`, `dsDiv21Into`, `dsNormalizeInto`, `dsSubF32`, `dsDistanceSq`)
//                plus `soaRelativeFromDS(+Chunked)` for megaparsec-safe camera-relative
//                Float32 positions, and `soaDsAdd / soaDsSub` over flat Float64 channels.
//              • §25/§28 — `writeScalarIntoFlat` / `flagStabilityUpload` /
//                `syncStabilityAttribute`: upload compensated results straight into an
//                InstancedBufferAttribute backing array with `clearUpdateRanges` /
//                `addUpdateRange` dirty-prefix upload.
//              • §45/§51 — `CompensatedClock` / `createCompensatedClock`: a drift-free fixed
//                step accumulator whose total time AND accumulator are both Neumaier-
//                compensated (stable over days), with a spiral-of-death guard and render
//                interpolation alpha. `createFixedStepScheduler` re-exported.
//              • §49     — `stabilityToTransferable` / `stabilityFromTransferable` pack a
//                batch state into ONE ArrayBuffer for zero-copy Worker transfer. The
//                compensation words are always stored as Float64 — narrowing them would
//                destroy the entire point of the compensation.
//              • §10/§16 — Every reduction has an `*Into` form; all scratch is module-level or
//                pooled; no Map/Set anywhere; the precision listener rebuilds scratch pools
//                and migrates tracked batch states at switch time, never in the frame loop.
//              • Interop — `compMatvecCSR(+Chunked)` accepts the 035 sparse CSR shape;
//                `toDoubleSOA` / `fromDoubleSOA` bridge to 012 double-double storage;
//                `compKeplerResidual` / `soaKeplerResidual` give convergence tests that stay
//                correct at 1e-8 and beyond.
//####
//Best for : 3d graphics — long-lived simulation clocks (stable over days without drift),
//           accumulated star positions across a galaxy without Float32 ULP collapse,
//           matrix-multiply stability for 1M+ instanced TRS compositions, terrain heightfield
//           accumulation from millions of fBm samples, HDR lighting accumulation without
//           shadow-detail loss, IK angle wrap and two-bone solves near degenerate
//           configurations, Kepler convergence checks correct at 1e-8, sparse FEM / orbital
//           Hessian matvecs with wildly varying row magnitudes, and mobile-safe chunked
//           variants that never block the Android UI thread.
//License : MIT

// ============================================================================
// Imports — ESM named imports from the unified math entry point
// ============================================================================
import {
    common,
    double,
    getPrecision,
    setPrecision,
    onPrecisionChange,
    getArrayType,
    trackSOA,
    untrackSOA,
    createFixedStepScheduler
} from "./000_Math_module.js";

export const VERSION = "1.1.0-esm";

export {
    getPrecision,
    setPrecision,
    onPrecisionChange,
    getArrayType,
    trackSOA,
    untrackSOA,
    createFixedStepScheduler
};

// ============================================================================
// Constants
// ============================================================================
export const EPSILON = 1e-6;
export const REL_EPSILON = 1e-9;
export const SPLITTER = 134217729;              // Veltkamp splitter 2^27 + 1
export const FLOAT32_MAX = 3.4028234663852886e+38;
export const FLOAT32_MIN_NORMAL = 1.1754943508222875e-38;
export const FLOAT32_MIN_SUBNORMAL = 1.401298464324817e-45;
export const FLOAT64_MAX = Number.MAX_VALUE;
export const FLOAT64_MIN_NORMAL = 2.2250738585072014e-308;
export const FLOAT64_MIN_SUBNORMAL = Number.MIN_VALUE;

const PI = Math.PI;
const TWO_PI = PI * 2;
const EXP_MAX = 709.782712893384;               // log(Number.MAX_VALUE)
const EXP_MIN = -745.1332191019411;             // log(Number.MIN_VALUE)
const SQRT_EPS = 1e-12;
const NORM_EPS = 1e-30;

// ============================================================================
// Module scratch — allocated once, reused by every hot path (Zero-GC)
// ============================================================================
const _p2 = new Float64Array(2);
const _q2 = new Float64Array(2);
const _r2 = new Float64Array(2);
const _d2 = new Float64Array(2);
const _ds2 = new Float64Array(2);
const _ds3 = new Float64Array(2);
const _quad4 = new Float64Array(4);
const _stat2 = new Float64Array(2);

// nextAfter / ULP bit views (big-endian DataView throughout → word order is stable)
const _f64Buf = new ArrayBuffer(8);
const _f64Dv = new DataView(_f64Buf);
const _f32Buf = new ArrayBuffer(4);
const _f32Dv = new DataView(_f32Buf);

// ============================================================================
// Error-free transformations — `*Into` forms are the hot-path API
// ============================================================================
/** Knuth TwoSum → out2 = [hi, lo] with hi + lo === a + b exactly. */
export function twoSumInto(out2, a, b) {
    const s = a + b;
    const bb = s - a;
    out2[0] = s;
    out2[1] = (a - (s - bb)) + (b - bb);
    return out2;
}
/** FastTwoSum → out2. REQUIRES |a| >= |b|. */
export function fastTwoSumInto(out2, a, b) {
    const s = a + b;
    out2[0] = s;
    out2[1] = b - (s - a);
    return out2;
}
/** TwoDiff → out2 = [hi, lo] with hi + lo === a - b exactly. */
export function twoDiffInto(out2, a, b) {
    const s = a - b;
    const bv = a - s;
    out2[0] = s;
    out2[1] = (a - (s + bv)) + (bv - b);
    return out2;
}
/** Dekker TwoProd → out2 = [hi, lo] with hi + lo === a * b exactly. */
export function twoProdInto(out2, a, b) {
    const p = a * b;
    const t = SPLITTER * a;
    if (!isFinite(t)) { out2[0] = p; out2[1] = 0; return out2; }
    const ah = t + (a - t), al = a - ah;
    const u = SPLITTER * b;
    if (!isFinite(u)) { out2[0] = p; out2[1] = 0; return out2; }
    const bh = u + (b - u), bl = b - bh;
    out2[0] = p;
    out2[1] = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
    return out2;
}
/** Dekker OneSqr → out2 = [hi, lo] with hi + lo === a * a exactly. */
export function twoSqrInto(out2, a) {
    const p = a * a;
    const t = SPLITTER * a;
    if (!isFinite(t)) { out2[0] = p; out2[1] = 0; return out2; }
    const ah = t + (a - t), al = a - ah;
    const hl = al * ah;
    out2[0] = p;
    out2[1] = ((ah * ah - p) + hl + hl) + al * al;
    return out2;
}

// ---- Object-returning convenience wrappers (SETUP / DIAGNOSTIC ONLY) -------
// These allocate. Never call them inside a frame loop — use the *Into forms.
/** @returns {{hi:number, lo:number}} — allocates; use twoSumInto in hot paths. */
export function twoSum(a, b) {
    twoSumInto(_p2, a, b);
    return { hi: _p2[0], lo: _p2[1] };
}
/** @returns {{hi:number, lo:number}} — allocates; use twoDiffInto in hot paths. */
export function twoDiff(a, b) {
    twoDiffInto(_p2, a, b);
    return { hi: _p2[0], lo: _p2[1] };
}
/** @returns {{hi:number, lo:number}} — allocates; use fastTwoSumInto in hot paths. */
export function fastTwoSum(a, b) {
    fastTwoSumInto(_p2, a, b);
    return { hi: _p2[0], lo: _p2[1] };
}
/** @returns {{hi:number, lo:number}} — allocates; use twoProdInto in hot paths. */
export function twoProd(a, b) {
    twoProdInto(_p2, a, b);
    return { hi: _p2[0], lo: _p2[1] };
}
/** @returns {{hi:number, lo:number}} — allocates; use twoSqrInto in hot paths. */
export function twoSqr(a) {
    twoSqrInto(_p2, a);
    return { hi: _p2[0], lo: _p2[1] };
}

// ============================================================================
// Double-single precision bridge (Blueprint §26 — corrected)
// ----------------------------------------------------------------------------
// The blueprint's `Math.fround(dxHi + dxLo)` swallows the low word when the high
// words nearly cancel. Every routine below renormalizes with a full TwoSum
// BEFORE any narrowing cast, preserving ~106 bits until the final fround.
// ============================================================================
/** Renormalize a (hi, lo) pair so that hi + lo is the exact value, |hi| >= |lo|. */
export function dsNormalizeInto(out2, hi, lo) { return twoSumInto(out2, hi, lo); }
/** Split a plain number into a normalized double-single pair. */
export function dsFromNumber(out2, x) { out2[0] = x; out2[1] = 0; return out2; }
/** Collapse a double-single pair to the nearest Float64. */
export function dsToNumber(hi, lo) { return hi + lo; }

/** out2 = (aHi,aLo) + (bHi,bLo), renormalized. */
export function dsAddInto(out2, aHi, aLo, bHi, bLo) {
    const sh = aHi + bHi;
    const sb = sh - aHi;
    const sl = (aHi - (sh - sb)) + (bHi - sb);
    const eh = aLo + bLo;
    const eb = eh - aLo;
    const el = (aLo - (eh - eb)) + (bLo - eb);
    let c = sl + eh;
    const vh = sh + c;
    const vl = c - (vh - sh);
    c = vl + el;
    const rh = vh + c;
    out2[0] = rh;
    out2[1] = c - (rh - vh);
    return out2;
}
/** out2 = (aHi,aLo) − (bHi,bLo), renormalized. THE §26 correction. */
export function dsSubInto(out2, aHi, aLo, bHi, bLo) {
    return dsAddInto(out2, aHi, aLo, -bHi, -bLo);
}
/** out2 = (aHi,aLo) * (bHi,bLo), renormalized. */
export function dsMulInto(out2, aHi, aLo, bHi, bLo) {
    twoProdInto(_ds3, aHi, bHi);
    const lo = _ds3[1] + (aHi * bLo + aLo * bHi);
    const hi = _ds3[0] + lo;
    out2[0] = hi;
    out2[1] = lo - (hi - _ds3[0]);
    return out2;
}
/** out2 = (aHi,aLo) * scalar, renormalized. */
export function dsMul21Into(out2, aHi, aLo, f) {
    twoProdInto(_ds3, aHi, f);
    let cl = aLo * f;
    const th = _ds3[0] + cl;
    let tl = cl - (th - _ds3[0]);
    cl = tl + _ds3[1];
    const hi = th + cl;
    out2[0] = hi;
    out2[1] = cl - (hi - th);
    return out2;
}
/** out2 = (aHi,aLo) / scalar, renormalized. */
export function dsDiv21Into(out2, aHi, aLo, f) {
    const th = aHi / f;
    twoProdInto(_ds3, th, f);
    twoSumInto(_r2, aHi, -_ds3[0]);
    const tl = (_r2[0] + (_r2[1] + (aLo - _ds3[1]))) / f;
    const hi = th + tl;
    out2[0] = hi;
    out2[1] = tl - (hi - th);
    return out2;
}
/** Camera-relative Float32 scalar from double-single inputs. Zero allocation. */
export function dsSubF32(aHi, aLo, bHi, bLo) {
    dsSubInto(_ds2, aHi, aLo, bHi, bLo);
    return Math.fround(_ds2[0] + _ds2[1]);
}
/** Squared distance between two double-single positions — exact before narrowing. */
export function dsDistanceSq(posHi, posLo, originHi, originLo) {
    dsSubInto(_ds2, posHi[0], posLo[0], originHi[0], originLo[0]);
    const dx = _ds2[0] + _ds2[1];
    dsSubInto(_ds2, posHi[1], posLo[1], originHi[1], originLo[1]);
    const dy = _ds2[0] + _ds2[1];
    dsSubInto(_ds2, posHi[2], posLo[2], originHi[2], originLo[2]);
    const dz = _ds2[0] + _ds2[1];
    return dx * dx + dy * dy + dz * dz;
}

/**
 * SOA double-single subtraction over flat Float64 channels.
 * outHi/outLo may alias aHi/aLo or bHi/bLo.
 */
export function soaDsSub(outHi, outLo, aHi, aLo, bHi, bLo, count) {
    count = count === undefined ? outHi.length : count;
    for (let i = 0; i < count; i++) {
        dsSubInto(_ds2, aHi[i], aLo[i], bHi[i], bLo[i]);
        outHi[i] = _ds2[0]; outLo[i] = _ds2[1];
    }
    return outHi;
}
export function soaDsAdd(outHi, outLo, aHi, aLo, bHi, bLo, count) {
    count = count === undefined ? outHi.length : count;
    for (let i = 0; i < count; i++) {
        dsAddInto(_ds2, aHi[i], aLo[i], bHi[i], bLo[i]);
        outHi[i] = _ds2[0]; outLo[i] = _ds2[1];
    }
    return outHi;
}

/**
 * Megaparsec-safe camera-relative Float32 positions.
 * `world` matches double.attachHighPrecisionPositions(): { x:{hi,lo}, y:{hi,lo}, z:{hi,lo} }.
 * `originHi` / `originLo` are 3-element array-likes. `eids` optionally maps row → entity id.
 */
export function soaRelativeFromDS(outVec3, world, originHi, originLo, eids, count) {
    count = count === undefined ? outVec3.count : count;
    const ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
    const xh = world.x.hi, xl = world.x.lo;
    const yh = world.y.hi, yl = world.y.lo;
    const zh = world.z.hi, zl = world.z.lo;
    const h0 = originHi[0], h1 = originHi[1], h2 = originHi[2];
    const l0 = originLo ? originLo[0] : 0;
    const l1 = originLo ? originLo[1] : 0;
    const l2 = originLo ? originLo[2] : 0;
    for (let i = 0; i < count; i++) {
        const idx = eids ? eids[i] : i;
        dsSubInto(_ds2, xh[idx], xl[idx], h0, l0);
        ox[i] = Math.fround(_ds2[0] + _ds2[1]);
        dsSubInto(_ds2, yh[idx], yl[idx], h1, l1);
        oy[i] = Math.fround(_ds2[0] + _ds2[1]);
        dsSubInto(_ds2, zh[idx], zl[idx], h2, l2);
        oz[i] = Math.fround(_ds2[0] + _ds2[1]);
    }
    return outVec3;
}

/** Write a compensated (hi, lo) channel pair into a 012 double-double SOA. */
export function toDoubleSOA(outDouble, hi, lo, count) {
    count = count === undefined ? outDouble.count : count;
    outDouble.hi.set(hi.subarray ? hi.subarray(0, count) : hi);
    outDouble.lo.set(lo.subarray ? lo.subarray(0, count) : lo);
    return outDouble;
}
/** Read a 012 double-double SOA into flat (hi, lo) channels. */
export function fromDoubleSOA(outHi, outLo, srcDouble, count) {
    count = count === undefined ? srcDouble.count : count;
    for (let i = 0; i < count; i++) { outHi[i] = srcDouble.hi[i]; outLo[i] = srcDouble.lo[i]; }
    return outHi;
}

// ============================================================================
// Compensated summation
// ============================================================================
/** Kahan summation — best when the running sum dominates the inputs. */
export function kahanSum(arr, n) {
    n = n === undefined ? arr.length : n;
    let sum = 0, c = 0;
    for (let i = 0; i < n; i++) {
        const y = arr[i] - c;
        const t = sum + y;
        c = (t - sum) - y;
        sum = t;
    }
    return sum;
}
/** Neumaier summation — order-independent, the production default. */
export function neumaierSum(arr, n) {
    n = n === undefined ? arr.length : n;
    let sum = 0, c = 0;
    for (let i = 0; i < n; i++) {
        const x = arr[i];
        const t = sum + x;
        if (Math.abs(sum) >= Math.abs(x)) c += (sum - t) + x;
        else c += (x - t) + sum;
        sum = t;
    }
    return sum + c;
}
/**
 * Klein summation — second-order compensated.
 * CORRECTED: the previous version discarded the second-level error whenever
 * |cs| < |ccs|, which silently degraded it to plain Neumaier.
 */
export function kleinSum(arr, n) {
    n = n === undefined ? arr.length : n;
    let s = 0, cs = 0, ccs = 0;
    for (let i = 0; i < n; i++) {
        const x = arr[i];
        let t = s + x;
        let c;
        if (Math.abs(s) >= Math.abs(x)) c = (s - t) + x;
        else c = (x - t) + s;
        s = t;
        t = cs + c;
        let cc;
        if (Math.abs(cs) >= Math.abs(c)) cc = (cs - t) + c;
        else cc = (c - t) + cs;
        cs = t;
        ccs += cc;
    }
    return s + cs + ccs;
}
/** Pairwise summation — O(log n) error growth, no compensation overhead. */
export function pairwiseSum(arr, lo, hi) {
    lo = lo === undefined ? 0 : lo;
    hi = hi === undefined ? arr.length : hi;
    const n = hi - lo;
    if (n < 8) {
        let s = 0;
        for (let i = lo; i < hi; i++) s += arr[i];
        return s;
    }
    const mid = lo + ((hi - lo) >> 1);
    return pairwiseSum(arr, lo, mid) + pairwiseSum(arr, mid, hi);
}
export const compensatedSum = neumaierSum;
export const sumKahan = kahanSum;

/** Neumaier sum written as a normalized pair → out2 = [sum, compensation]. */
export function neumaierSumInto(out2, arr, n) {
    n = n === undefined ? arr.length : n;
    let sum = 0, c = 0;
    for (let i = 0; i < n; i++) {
        const x = arr[i];
        const t = sum + x;
        if (Math.abs(sum) >= Math.abs(x)) c += (sum - t) + x;
        else c += (x - t) + sum;
        sum = t;
    }
    twoSumInto(out2, sum, c);
    return out2;
}
/** Compensated arithmetic mean. */
export function compensatedMean(arr, n) {
    n = n === undefined ? arr.length : n;
    return n > 0 ? neumaierSum(arr, n) / n : 0;
}
/**
 * Compensated mean + population variance (two-pass, more accurate than Welford
 * for large n). out2 = [mean, variance]. Zero allocation.
 */
export function compensatedVariance(out2, arr, n) {
    n = n === undefined ? arr.length : n;
    if (n <= 0) { out2[0] = 0; out2[1] = 0; return out2; }
    const mean = neumaierSum(arr, n) / n;
    let s = 0, c = 0;
    for (let i = 0; i < n; i++) {
        const d = arr[i] - mean;
        twoSqrInto(_p2, d);
        let x = _p2[0];
        let t = s + x;
        if (Math.abs(s) >= Math.abs(x)) c += (s - t) + x; else c += (x - t) + s;
        s = t;
        x = _p2[1];
        t = s + x;
        if (Math.abs(s) >= Math.abs(x)) c += (s - t) + x; else c += (x - t) + s;
        s = t;
    }
    out2[0] = mean;
    out2[1] = (s + c) / n;
    return out2;
}

// ============================================================================
// Compensated dot / matvec / norms — fully inlined, ZERO allocation
// ============================================================================
/** Compensated dot product — accurate to the last ULP of the operands. */
export function compDot(a, b, n) {
    n = n === undefined ? a.length : n;
    let s = 0, c = 0;
    for (let i = 0; i < n; i++) {
        const av = a[i], bv = b[i];
        const p = av * bv;
        const t1 = SPLITTER * av;
        const t2 = SPLITTER * bv;
        let lo = 0;
        if (isFinite(t1) && isFinite(t2)) {
            const ah = t1 + (av - t1), al = av - ah;
            const bh = t2 + (bv - t2), bl = bv - bh;
            lo = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
        }
        let t = s + p;
        if (Math.abs(s) >= Math.abs(p)) c += (s - t) + p; else c += (p - t) + s;
        s = t;
        t = s + lo;
        if (Math.abs(s) >= Math.abs(lo)) c += (s - t) + lo; else c += (lo - t) + s;
        s = t;
    }
    return s + c;
}
/** 3-component compensated dot — the innermost rendering / IK hot loop. */
export function compDot3(ax, ay, az, bx, by, bz) {
    let s = 0, c = 0, t, x;
    // ax*bx
    let p = ax * bx;
    let t1 = SPLITTER * ax, t2 = SPLITTER * bx, lo = 0;
    if (isFinite(t1) && isFinite(t2)) {
        const ah = t1 + (ax - t1), al = ax - ah;
        const bh = t2 + (bx - t2), bl = bx - bh;
        lo = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
    }
    s = p;
    x = lo; t = s + x; if (Math.abs(s) >= Math.abs(x)) c += (s - t) + x; else c += (x - t) + s; s = t;
    // ay*by
    p = ay * by; t1 = SPLITTER * ay; t2 = SPLITTER * by; lo = 0;
    if (isFinite(t1) && isFinite(t2)) {
        const ah = t1 + (ay - t1), al = ay - ah;
        const bh = t2 + (by - t2), bl = by - bh;
        lo = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
    }
    x = p; t = s + x; if (Math.abs(s) >= Math.abs(x)) c += (s - t) + x; else c += (x - t) + s; s = t;
    x = lo; t = s + x; if (Math.abs(s) >= Math.abs(x)) c += (s - t) + x; else c += (x - t) + s; s = t;
    // az*bz
    p = az * bz; t1 = SPLITTER * az; t2 = SPLITTER * bz; lo = 0;
    if (isFinite(t1) && isFinite(t2)) {
        const ah = t1 + (az - t1), al = az - ah;
        const bh = t2 + (bz - t2), bl = bz - bh;
        lo = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
    }
    x = p; t = s + x; if (Math.abs(s) >= Math.abs(x)) c += (s - t) + x; else c += (x - t) + s; s = t;
    x = lo; t = s + x; if (Math.abs(s) >= Math.abs(x)) c += (s - t) + x; else c += (x - t) + s; s = t;
    return s + c;
}
/** Compensated sum of squares — overflow-safe via max-component scaling. */
export function compSumSquares(arr, n) {
    n = n === undefined ? arr.length : n;
    if (n === 0) return 0;
    let m = 0;
    for (let i = 0; i < n; i++) {
        const a = arr[i] < 0 ? -arr[i] : arr[i];
        if (a > m) m = a;
    }
    if (m === 0) return 0;
    if (!isFinite(m)) return Infinity;
    const inv = 1 / m;
    let s = 0, c = 0;
    for (let i = 0; i < n; i++) {
        const v = arr[i] * inv;
        twoSqrInto(_p2, v);
        let x = _p2[0];
        let t = s + x;
        if (Math.abs(s) >= Math.abs(x)) c += (s - t) + x; else c += (x - t) + s;
        s = t;
        x = _p2[1];
        t = s + x;
        if (Math.abs(s) >= Math.abs(x)) c += (s - t) + x; else c += (x - t) + s;
        s = t;
    }
    return (s + c) * m * m;
}
/** Compensated Euclidean norm — accurate AND overflow/underflow safe. */
export function compNorm(arr, n) { return Math.sqrt(compSumSquares(arr, n)); }
/** Compensated 3D length. */
export function compLength3(x, y, z) {
    const ax = x < 0 ? -x : x, ay = y < 0 ? -y : y, az = z < 0 ? -z : z;
    let m = ax; if (ay > m) m = ay; if (az > m) m = az;
    if (m === 0) return 0;
    if (!isFinite(m)) return Infinity;
    const inv = 1 / m;
    const a = x * inv, b = y * inv, cc = z * inv;
    let s = 0, c = 0, t, v;
    twoSqrInto(_p2, a);
    s = _p2[0];
    v = _p2[1]; t = s + v; if (Math.abs(s) >= Math.abs(v)) c += (s - t) + v; else c += (v - t) + s; s = t;
    twoSqrInto(_p2, b);
    v = _p2[0]; t = s + v; if (Math.abs(s) >= Math.abs(v)) c += (s - t) + v; else c += (v - t) + s; s = t;
    v = _p2[1]; t = s + v; if (Math.abs(s) >= Math.abs(v)) c += (s - t) + v; else c += (v - t) + s; s = t;
    twoSqrInto(_p2, cc);
    v = _p2[0]; t = s + v; if (Math.abs(s) >= Math.abs(v)) c += (s - t) + v; else c += (v - t) + s; s = t;
    v = _p2[1]; t = s + v; if (Math.abs(s) >= Math.abs(v)) c += (s - t) + v; else c += (v - t) + s; s = t;
    return m * Math.sqrt(s + c);
}
/** Compensated 3D distance — exact differences before squaring. */
export function compDistance3(ax, ay, az, bx, by, bz) {
    twoDiffInto(_p2, bx, ax); const dxh = _p2[0], dxl = _p2[1];
    twoDiffInto(_q2, by, ay); const dyh = _q2[0], dyl = _q2[1];
    twoDiffInto(_r2, bz, az); const dzh = _r2[0], dzl = _r2[1];
    let m = Math.abs(dxh);
    if (Math.abs(dyh) > m) m = Math.abs(dyh);
    if (Math.abs(dzh) > m) m = Math.abs(dzh);
    if (m === 0) return Math.sqrt(dxl * dxl + dyl * dyl + dzl * dzl);
    if (!isFinite(m)) return Infinity;
    const inv = 1 / m;
    const a = dxh * inv, b = dyh * inv, c = dzh * inv;
    const al = dxl * inv, bl = dyl * inv, cl = dzl * inv;
    let s = 0, comp = 0, t, v;
    twoSqrInto(_d2, a);
    s = _d2[0];
    v = _d2[1] + 2 * a * al; t = s + v; if (Math.abs(s) >= Math.abs(v)) comp += (s - t) + v; else comp += (v - t) + s; s = t;
    twoSqrInto(_d2, b);
    v = _d2[0]; t = s + v; if (Math.abs(s) >= Math.abs(v)) comp += (s - t) + v; else comp += (v - t) + s; s = t;
    v = _d2[1] + 2 * b * bl; t = s + v; if (Math.abs(s) >= Math.abs(v)) comp += (s - t) + v; else comp += (v - t) + s; s = t;
    twoSqrInto(_d2, c);
    v = _d2[0]; t = s + v; if (Math.abs(s) >= Math.abs(v)) comp += (s - t) + v; else comp += (v - t) + s; s = t;
    v = _d2[1] + 2 * c * cl; t = s + v; if (Math.abs(s) >= Math.abs(v)) comp += (s - t) + v; else comp += (v - t) + s; s = t;
    return m * Math.sqrt(s + comp);
}

/**
 * Compensated sparse matvec over raw CSR channels. Stable even when row entries
 * span many orders of magnitude (orbital Hessians, FEM stiffness matrices).
 */
export function compMatvec(out, rowPtr, colIdx, values, x, nRows) {
    nRows = nRows === undefined ? rowPtr.length - 1 : nRows;
    for (let i = 0; i < nRows; i++) {
        let s = 0, c = 0;
        const start = rowPtr[i], end = rowPtr[i + 1];
        for (let k = start; k < end; k++) {
            const av = values[k], bv = x[colIdx[k]];
            const p = av * bv;
            const t1 = SPLITTER * av, t2 = SPLITTER * bv;
            let lo = 0;
            if (isFinite(t1) && isFinite(t2)) {
                const ah = t1 + (av - t1), al = av - ah;
                const bh = t2 + (bv - t2), bl = bv - bh;
                lo = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
            }
            let t = s + p;
            if (Math.abs(s) >= Math.abs(p)) c += (s - t) + p; else c += (p - t) + s;
            s = t;
            t = s + lo;
            if (Math.abs(s) >= Math.abs(lo)) c += (s - t) + lo; else c += (lo - t) + s;
            s = t;
        }
        out[i] = s + c;
    }
    return out;
}
/** CSR-object bridge — accepts a 035_sparse-systems SparseCSR. */
export function compMatvecCSR(out, A, x) {
    return compMatvec(out, A.rowPtr, A.colIdx, A.values, x, A.rows);
}
export const compSpMV = compMatvecCSR;

/** Compensated Kepler residual f = E − e·sin(E) − M. Correct well below 1e-8. */
export function compKeplerResidual(M, E, e) {
    const sinE = Math.sin(E);
    twoProdInto(_p2, e, sinE);
    let s = E, c = 0, t, v;
    v = -_p2[0]; t = s + v; if (Math.abs(s) >= Math.abs(v)) c += (s - t) + v; else c += (v - t) + s; s = t;
    v = -_p2[1]; t = s + v; if (Math.abs(s) >= Math.abs(v)) c += (s - t) + v; else c += (v - t) + s; s = t;
    v = -M; t = s + v; if (Math.abs(s) >= Math.abs(v)) c += (s - t) + v; else c += (v - t) + s; s = t;
    return s + c;
}

// ============================================================================
// Stable scalar primitives
// ============================================================================
/** Overflow/underflow-safe 2D hypot. */
export function stableHypot(x, y) {
    let ax = x < 0 ? -x : x;
    let ay = y < 0 ? -y : y;
    if (!isFinite(ax) || !isFinite(ay)) return Infinity;
    if (ax < ay) { const t = ax; ax = ay; ay = t; }
    if (ay === 0) return ax;
    const r = ay / ax;
    return ax * Math.sqrt(1 + r * r);
}
/** Overflow/underflow-safe 3D hypot. */
export function stableHypot3(x, y, z) {
    const ax = x < 0 ? -x : x, ay = y < 0 ? -y : y, az = z < 0 ? -z : z;
    let m = ax; if (ay > m) m = ay; if (az > m) m = az;
    if (m === 0) return 0;
    if (!isFinite(m)) return Infinity;
    const a = ax / m, b = ay / m, c = az / m;
    return m * Math.sqrt(a * a + b * b + c * c);
}

function _solveQuadratic(a, b, c) {
    // Degenerate: linear b*x + c = 0
    if (a === 0) {
        if (b === 0) {
            _quad4[0] = NaN; _quad4[1] = NaN; _quad4[2] = NaN; _quad4[3] = 0;
            return _quad4;
        }
        const r = -c / b;
        _quad4[0] = r; _quad4[1] = r; _quad4[2] = Infinity; _quad4[3] = 1;
        return _quad4;
    }
    // Compensated discriminant: b² − 4ac via error-free transformations.
    twoProdInto(_p2, b, b);
    twoProdInto(_q2, a, c);
    twoDiffInto(_d2, _p2[0], 4 * _q2[0]);
    const disc = (_d2[0] + _d2[1]) + (_p2[1] - 4 * _q2[1]);
    if (disc < 0) {
        _quad4[0] = NaN; _quad4[1] = NaN; _quad4[2] = disc; _quad4[3] = 0;
        return _quad4;
    }
    const sqrtD = Math.sqrt(disc);
    const q = b >= 0 ? -0.5 * (b + sqrtD) : -0.5 * (b - sqrtD);
    if (q === 0) {
        _quad4[0] = 0; _quad4[1] = 0; _quad4[2] = disc; _quad4[3] = 1;
        return _quad4;
    }
    let x1 = q / a, x2 = c / q;
    if (x1 > x2) { const t = x1; x1 = x2; x2 = t; }
    _quad4[0] = x1; _quad4[1] = x2; _quad4[2] = disc; _quad4[3] = 1;
    return _quad4;
}
/** Stable quadratic → out4 = [x1, x2, discriminant, hasReal ? 1 : 0]. Zero-GC. */
export function stableQuadraticInto(out4, a, b, c) {
    _solveQuadratic(a, b, c);
    out4[0] = _quad4[0]; out4[1] = _quad4[1];
    out4[2] = _quad4[2]; out4[3] = _quad4[3];
    return out4;
}
/**
 * Stable quadratic solver. Pass `result` (a reusable object) for zero-GC hot
 * paths; omitting it allocates a fresh result (setup / diagnostic only).
 */
export function stableQuadratic(a, b, c, result) {
    _solveQuadratic(a, b, c);
    const r = result || { x1: 0, x2: 0, discriminant: 0, hasReal: false };
    r.x1 = _quad4[0]; r.x2 = _quad4[1];
    r.discriminant = _quad4[2]; r.hasReal = _quad4[3] === 1;
    return r;
}
export function createQuadraticResult() {
    return { x1: 0, x2: 0, discriminant: 0, hasReal: false };
}

/** Safe log — returns -Infinity at 0, NaN for negatives. */
export function stableLog(x) {
    if (x > 0) return Math.log(x);
    if (x === 0) return -Infinity;
    return NaN;
}
/** Safe exp — clamps overflow to FLOAT64_MAX and underflow to 0. */
export function stableExp(x) {
    if (x > EXP_MAX) return FLOAT64_MAX;
    if (x < EXP_MIN) return 0;
    return Math.exp(x);
}
/** Safe pow — resolves 0^0 and negative-base integer exponents deterministically. */
export function stablePow(base, exp) {
    if (base === 0) {
        if (exp === 0) return 1;
        if (exp > 0) return 0;
        return Infinity;
    }
    if (base < 0) {
        if (exp !== Math.floor(exp)) return NaN;
        const r = stablePow(-base, exp);
        // CORRECTED: `exp & 1` truncates to 32 bits and is wrong for |exp| > 2^31.
        return Math.abs(exp % 2) === 1 ? -r : r;
    }
    const res = Math.pow(base, exp);
    return res === Infinity ? FLOAT64_MAX : res;
}
/** Safe sqrt — clamps near-zero negatives caused by FP rounding to 0. */
export function stableSqrt(x, tolerance) {
    if (x >= 0) return Math.sqrt(x);
    const tol = tolerance === undefined ? EPSILON : tolerance;
    if (x > -tol) return 0;
    return NaN;
}
/** Safe atan2 — returns 0 at the origin instead of an IEEE signed zero. */
export function stableAtan2(y, x) {
    if (x === 0 && y === 0) return 0;
    return Math.atan2(y, x);
}
/** Robust 2D normalize — zero-length safe, overflow safe. */
export function stableNormalize(out, x, y, epsilon) {
    const len = stableHypot(x, y);
    const eps = epsilon === undefined ? NORM_EPS : epsilon;
    if (len < eps || !isFinite(len)) { out[0] = 0; out[1] = 0; return out; }
    const inv = 1 / len;
    out[0] = x * inv; out[1] = y * inv;
    return out;
}
/** Robust 3D normalize — the workhorse for 1M+ per-instance normals. */
export function stableNormalize3(out, x, y, z, epsilon) {
    const len = stableHypot3(x, y, z);
    const eps = epsilon === undefined ? NORM_EPS : epsilon;
    if (len < eps || !isFinite(len)) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
    const inv = 1 / len;
    out[0] = x * inv; out[1] = y * inv; out[2] = z * inv;
    return out;
}

// ============================================================================
// Range guards / ULP / nextAfter
// ============================================================================
export function clampMagnitude(x, maxMag) {
    const m = maxMag < 0 ? -maxMag : maxMag;
    if (x > m) return m;
    if (x < -m) return -m;
    return x;
}
export function clampToRange(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
/** Flush f32 denormals to zero — keeps Android f32 pipelines out of slow paths. */
export function denormalGuard(x) {
    return x < FLOAT32_MIN_NORMAL && x > -FLOAT32_MIN_NORMAL ? 0 : x;
}
/** Flush f64 denormals to zero. */
export function denormalGuard64(x) {
    return x < FLOAT64_MIN_NORMAL && x > -FLOAT64_MIN_NORMAL ? 0 : x;
}
/** ULP of a Float64 at magnitude x. */
export function ulpAt(x) {
    if (x === 0) return FLOAT64_MIN_SUBNORMAL;
    if (!isFinite(x)) return NaN;
    const ax = x < 0 ? -x : x;
    let e = Math.floor(Math.log2(ax)) - 52;
    if (e < -1074) e = -1074;
    return Math.pow(2, e);
}
/** ULP of a Float32 at magnitude x. */
export function ulpAtF32(x) {
    if (x === 0) return FLOAT32_MIN_SUBNORMAL;
    if (!isFinite(x)) return NaN;
    const ax = x < 0 ? -x : x;
    let e = Math.floor(Math.log2(ax)) - 23;
    if (e < -149) e = -149;
    return Math.pow(2, e);
}
/** Next representable Float64 after `x` toward `y`. Zero allocation. */
export function nextAfter(x, y) {
    if (isNaN(x) || isNaN(y)) return NaN;
    if (x === y) return y;
    if (x === 0) return y > 0 ? FLOAT64_MIN_SUBNORMAL : -FLOAT64_MIN_SUBNORMAL;
    _f64Dv.setFloat64(0, x);
    let hi = _f64Dv.getUint32(0);
    let lo = _f64Dv.getUint32(4);
    if ((y > x) === (x > 0)) {
        if (lo === 0xFFFFFFFF) { lo = 0; hi = (hi + 1) >>> 0; }
        else lo = (lo + 1) >>> 0;
    } else {
        if (lo === 0) { lo = 0xFFFFFFFF; hi = (hi - 1) >>> 0; }
        else lo = (lo - 1) >>> 0;
    }
    _f64Dv.setUint32(0, hi);
    _f64Dv.setUint32(4, lo);
    return _f64Dv.getFloat64(0);
}
/** Next representable Float32 after `x` toward `y`. Zero allocation. */
export function nextAfterF32(x, y) {
    if (isNaN(x) || isNaN(y)) return NaN;
    const fx = Math.fround(x);
    if (fx === y) return Math.fround(y);
    if (fx === 0) return y > 0 ? FLOAT32_MIN_SUBNORMAL : -FLOAT32_MIN_SUBNORMAL;
    _f32Dv.setFloat32(0, fx);
    let bits = _f32Dv.getUint32(0);
    if ((y > fx) === (fx > 0)) bits = (bits + 1) >>> 0;
    else bits = (bits - 1) >>> 0;
    _f32Dv.setUint32(0, bits);
    return _f32Dv.getFloat32(0);
}

// ============================================================================
// Angle / lerp safety
// ============================================================================
/** Wrap to [0, 2π). */
export function stableWrapAngle(a) {
    let r = a % TWO_PI;
    if (r < 0) r += TWO_PI;
    return r;
}
/** Shortest signed arc from a to b, in (−π, π]. */
export function stableShortestAngle(a, b) {
    let d = (b - a) % TWO_PI;
    if (d > PI) d -= TWO_PI;
    if (d < -PI) d += TWO_PI;
    return d;
}
/**
 * Monotone-safe lerp for t ∈ [0,1].
 * CORRECTED: `a + t*(b-a)` overflows when a and b have opposite signs at extreme
 * magnitudes. The opposite-sign branch uses the cancellation-free convex form.
 */
export function monotoneLerp(a, b, t) {
    if (t <= 0) return a;
    if (t >= 1) return b;
    if (a === b) return a;
    if ((a < 0) !== (b < 0)) {
        const v = a * (1 - t) + b * t;
        return a < b ? clampToRange(v, a, b) : clampToRange(v, b, a);
    }
    const v = a + t * (b - a);
    return a < b ? clampToRange(v, a, b) : clampToRange(v, b, a);
}
export function lerpClamped(a, b, t) {
    return monotoneLerp(a, b, t < 0 ? 0 : (t > 1 ? 1 : t));
}
/** Angle lerp along the shortest arc — never spins the long way round. */
export function lerpAngle(a, b, t) {
    return stableWrapAngle(a + stableShortestAngle(a, b) * clampToRange(t, 0, 1));
}

// ============================================================================
// Tolerance
// ============================================================================
export function approxEq(a, b, tol) {
    const t = tol === undefined ? EPSILON : tol;
    const d = a - b;
    return (d < 0 ? -d : d) <= t;
}
export function approxEqRel(a, b, tol) {
    const t = tol === undefined ? REL_EPSILON : tol;
    let m = 1;
    const aa = a < 0 ? -a : a, ab = b < 0 ? -b : b;
    if (aa > m) m = aa;
    if (ab > m) m = ab;
    const d = a - b;
    return (d < 0 ? -d : d) <= t * m;
}
/** ULP-aware equality — the correct test for convergence at extreme magnitudes. */
export function approxEqUlp(a, b, maxUlps) {
    const n = maxUlps === undefined ? 4 : maxUlps;
    if (a === b) return true;
    const d = a - b;
    const ad = d < 0 ? -d : d;
    return ad <= n * ulpAt(a === 0 ? b : a);
}
export function snapToGrid(x, cell) {
    if (cell === 0) return x;
    return Math.round(x / cell) * cell;
}
export function quantize(x, step) {
    if (step === 0) return x;
    return Math.round(x / step) * step;
}

// ============================================================================
// SOA — synchronous, zero allocation
// ============================================================================
export function soaKahanSum(arr, count) { return kahanSum(arr, count); }
export function soaNeumaierSum(arr, count) { return neumaierSum(arr, count); }
export function soaKleinSum(arr, count) { return kleinSum(arr, count); }
export function soaPairwiseSum(arr, count) { return pairwiseSum(arr, 0, count === undefined ? arr.length : count); }

/** Per-row compensated 3D dot product. */
export function soaCompDot(out, a, b, count) {
    count = count === undefined ? out.length : count;
    const ax = a.x, ay = a.y, az = a.z;
    const bx = b.x, by = b.y, bz = b.z;
    for (let i = 0; i < count; i++) out[i] = compDot3(ax[i], ay[i], az[i], bx[i], by[i], bz[i]);
    return out;
}
/** Per-row compensated 3D length — stable IK / convergence metric. */
export function soaCompNorm3(out, v, count) {
    count = count === undefined ? out.length : count;
    const vx = v.x, vy = v.y, vz = v.z;
    for (let i = 0; i < count; i++) out[i] = compLength3(vx[i], vy[i], vz[i]);
    return out;
}
/** Per-row compensated Kepler residual. */
export function soaKeplerResidual(out, Ms, Es, es, count) {
    count = count === undefined ? out.length : count;
    for (let i = 0; i < count; i++) out[i] = compKeplerResidual(Ms[i], Es[i], es[i]);
    return out;
}
export function soaStableHypot(out, xs, ys, count) {
    count = count === undefined ? out.length : count;
    for (let i = 0; i < count; i++) out[i] = stableHypot(xs[i], ys[i]);
    return out;
}
export function soaStableHypot3(out, xs, ys, zs, count) {
    count = count === undefined ? out.length : count;
    for (let i = 0; i < count; i++) out[i] = stableHypot3(xs[i], ys[i], zs[i]);
    return out;
}
export function soaStableSqrt(out, xs, count, tolerance) {
    count = count === undefined ? out.length : count;
    const tol = tolerance === undefined ? EPSILON : tolerance;
    for (let i = 0; i < count; i++) {
        const x = xs[i];
        out[i] = x >= 0 ? Math.sqrt(x) : (x > -tol ? 0 : NaN);
    }
    return out;
}
export function soaStableAtan2(out, ys, xs, count) {
    count = count === undefined ? out.length : count;
    for (let i = 0; i < count; i++) {
        const y = ys[i], x = xs[i];
        out[i] = (x === 0 && y === 0) ? 0 : Math.atan2(y, x);
    }
    return out;
}
export function soaStableExp(out, xs, count) {
    count = count === undefined ? out.length : count;
    for (let i = 0; i < count; i++) {
        const x = xs[i];
        out[i] = x > EXP_MAX ? FLOAT64_MAX : (x < EXP_MIN ? 0 : Math.exp(x));
    }
    return out;
}
/** CORRECTED: fully inlined — no per-call `[0,0]` literal, no scalar call per row. */
export function soaStableNormalize(outX, outY, xs, ys, count, epsilon) {
    count = count === undefined ? outX.length : count;
    const eps = epsilon === undefined ? NORM_EPS : epsilon;
    for (let i = 0; i < count; i++) {
        const x = xs[i], y = ys[i];
        let ax = x < 0 ? -x : x, ay = y < 0 ? -y : y;
        if (!isFinite(ax) || !isFinite(ay)) { outX[i] = 0; outY[i] = 0; continue; }
        if (ax < ay) { const t = ax; ax = ay; ay = t; }
        if (ax < eps) { outX[i] = 0; outY[i] = 0; continue; }
        const len = ay === 0 ? ax : ax * Math.sqrt(1 + (ay / ax) * (ay / ax));
        const inv = 1 / len;
        outX[i] = x * inv; outY[i] = y * inv;
    }
    return outX;
}
/** vec2-SOA convenience wrapper. */
export function soaStableNormalize2(outVec2, inVec2, count, epsilon) {
    soaStableNormalize(outVec2.x, outVec2.y, inVec2.x, inVec2.y,
        count === undefined ? outVec2.count : count, epsilon);
    return outVec2;
}
export function soaStableNormalize3(outVec3, inVec3, count, epsilon) {
    count = count === undefined ? outVec3.count : count;
    const eps = epsilon === undefined ? NORM_EPS : epsilon;
    const oX = outVec3.x, oY = outVec3.y, oZ = outVec3.z;
    const iX = inVec3.x, iY = inVec3.y, iZ = inVec3.z;
    for (let i = 0; i < count; i++) {
        const x = iX[i], y = iY[i], z = iZ[i];
        const ax = x < 0 ? -x : x, ay = y < 0 ? -y : y, az = z < 0 ? -z : z;
        let m = ax; if (ay > m) m = ay; if (az > m) m = az;
        if (m < eps || !isFinite(m)) { oX[i] = 0; oY[i] = 0; oZ[i] = 0; continue; }
        const a = ax / m, b = ay / m, c = az / m;
        const inv = 1 / (m * Math.sqrt(a * a + b * b + c * c));
        oX[i] = x * inv; oY[i] = y * inv; oZ[i] = z * inv;
    }
    return outVec3;
}
export function soaStableWrapAngle(out, angles, count) {
    count = count === undefined ? out.length : count;
    for (let i = 0; i < count; i++) {
        let r = angles[i] % TWO_PI;
        if (r < 0) r += TWO_PI;
        out[i] = r;
    }
    return out;
}
export function soaStableShortestAngle(out, from, to, count) {
    count = count === undefined ? out.length : count;
    for (let i = 0; i < count; i++) {
        let d = (to[i] - from[i]) % TWO_PI;
        if (d > PI) d -= TWO_PI;
        if (d < -PI) d += TWO_PI;
        out[i] = d;
    }
    return out;
}
/** CORRECTED: `t` may be a scalar, a TypedArray, OR a plain Array. */
export function soaMonotoneLerp(out, a, b, t, count) {
    count = count === undefined ? out.length : count;
    const tArr = (t != null && t.length !== undefined) ? t : null;
    for (let i = 0; i < count; i++) {
        const ti = tArr ? tArr[i] : t;
        out[i] = monotoneLerp(a[i], b[i], ti);
    }
    return out;
}
export function soaLerpClamped(out, a, b, t, count) {
    count = count === undefined ? out.length : count;
    const tArr = (t != null && t.length !== undefined) ? t : null;
    for (let i = 0; i < count; i++) {
        const ti = tArr ? tArr[i] : t;
        out[i] = monotoneLerp(a[i], b[i], ti < 0 ? 0 : (ti > 1 ? 1 : ti));
    }
    return out;
}
export function soaLerpAngle(out, a, b, t, count) {
    count = count === undefined ? out.length : count;
    const tArr = (t != null && t.length !== undefined) ? t : null;
    for (let i = 0; i < count; i++) {
        const ti = tArr ? tArr[i] : t;
        out[i] = lerpAngle(a[i], b[i], ti);
    }
    return out;
}
export function soaClampMagnitude(arr, maxMag, count) {
    count = count === undefined ? arr.length : count;
    const m = maxMag < 0 ? -maxMag : maxMag;
    for (let i = 0; i < count; i++) {
        const x = arr[i];
        if (x > m) arr[i] = m;
        else if (x < -m) arr[i] = -m;
    }
    return arr;
}
export function soaClampToRange(arr, lo, hi, count) {
    count = count === undefined ? arr.length : count;
    for (let i = 0; i < count; i++) {
        const x = arr[i];
        arr[i] = x < lo ? lo : (x > hi ? hi : x);
    }
    return arr;
}
export function soaDenormalGuard(arr, count) {
    count = count === undefined ? arr.length : count;
    for (let i = 0; i < count; i++) {
        const x = arr[i];
        if (x < FLOAT32_MIN_NORMAL && x > -FLOAT32_MIN_NORMAL) arr[i] = 0;
    }
    return arr;
}
export function soaSnapToGrid(arr, cell, count) {
    count = count === undefined ? arr.length : count;
    if (cell === 0) return arr;
    const inv = 1 / cell;
    for (let i = 0; i < count; i++) arr[i] = Math.round(arr[i] * inv) * cell;
    return arr;
}
export const soaQuantize = soaSnapToGrid;
export function soaUlpAt(out, xs, count) {
    count = count === undefined ? out.length : count;
    for (let i = 0; i < count; i++) out[i] = ulpAt(xs[i]);
    return out;
}
export function soaNextAfter(out, xs, ys, count) {
    count = count === undefined ? out.length : count;
    for (let i = 0; i < count; i++) out[i] = nextAfter(xs[i], ys[i]);
    return out;
}
/** Writes 1/0 flags — tolerance-aware equality over 1M+ rows. */
export function soaApproxEq(outFlags, a, b, tol, count) {
    count = count === undefined ? outFlags.length : count;
    const t = tol === undefined ? EPSILON : tol;
    for (let i = 0; i < count; i++) {
        const d = a[i] - b[i];
        outFlags[i] = (d < 0 ? -d : d) <= t ? 1 : 0;
    }
    return outFlags;
}
/** ULP-aware equality flags — the correct convergence test at galactic scale. */
export function soaApproxEqUlp(outFlags, a, b, maxUlps, count) {
    count = count === undefined ? outFlags.length : count;
    const n = maxUlps === undefined ? 4 : maxUlps;
    for (let i = 0; i < count; i++) {
        const av = a[i], bv = b[i];
        if (av === bv) { outFlags[i] = 1; continue; }
        const d = av - bv;
        const ad = d < 0 ? -d : d;
        outFlags[i] = ad <= n * ulpAt(av === 0 ? bv : av) ? 1 : 0;
    }
    return outFlags;
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

export async function soaKahanSumChunked(arr, count, chunkSize, yieldEvery) {
    count = count === undefined ? arr.length : count;
    let sum = 0, c = 0;
    await _chunked(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) {
            const y = arr[i] - c;
            const t = sum + y;
            c = (t - sum) - y;   // CORRECTED: the `-` was missing entirely
            sum = t;
        }
    });
    return sum;
}
export async function soaNeumaierSumChunked(arr, count, chunkSize, yieldEvery) {
    count = count === undefined ? arr.length : count;
    let sum = 0, c = 0;
    await _chunked(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) {
            const x = arr[i];
            const t = sum + x;
            if (Math.abs(sum) >= Math.abs(x)) c += (sum - t) + x;
            else c += (x - t) + sum;
            sum = t;
        }
    });
    return sum + c;
}
export async function soaKleinSumChunked(arr, count, chunkSize, yieldEvery) {
    count = count === undefined ? arr.length : count;
    let s0 = 0, cs = 0, ccs = 0;
    await _chunked(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) {
            const x = arr[i];
            let t = s0 + x;
            let c;
            if (Math.abs(s0) >= Math.abs(x)) c = (s0 - t) + x; else c = (x - t) + s0;
            s0 = t;
            t = cs + c;
            let cc;
            if (Math.abs(cs) >= Math.abs(c)) cc = (cs - t) + c; else cc = (c - t) + cs;
            cs = t;
            ccs += cc;
        }
    });
    return s0 + cs + ccs;
}
export async function soaCompDotChunked(out, a, b, count, chunkSize, yieldEvery) {
    count = count === undefined ? out.length : count;
    const ax = a.x, ay = a.y, az = a.z;
    const bx = b.x, by = b.y, bz = b.z;
    await _chunked(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) out[i] = compDot3(ax[i], ay[i], az[i], bx[i], by[i], bz[i]);
    });
    return out;
}
export async function soaCompNorm3Chunked(out, v, count, chunkSize, yieldEvery) {
    count = count === undefined ? out.length : count;
    const vx = v.x, vy = v.y, vz = v.z;
    await _chunked(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) out[i] = compLength3(vx[i], vy[i], vz[i]);
    });
    return out;
}
export async function soaStableHypotChunked(out, xs, ys, count, chunkSize, yieldEvery) {
    count = count === undefined ? out.length : count;
    await _chunked(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) out[i] = stableHypot(xs[i], ys[i]);
    });
    return out;
}
export async function soaStableHypot3Chunked(out, xs, ys, zs, count, chunkSize, yieldEvery) {
    count = count === undefined ? out.length : count;
    await _chunked(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) out[i] = stableHypot3(xs[i], ys[i], zs[i]);
    });
    return out;
}
export async function soaStableSqrtChunked(out, xs, count, chunkSize, yieldEvery, tolerance) {
    count = count === undefined ? out.length : count;
    const tol = tolerance === undefined ? EPSILON : tolerance;
    await _chunked(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) {
            const x = xs[i];
            out[i] = x >= 0 ? Math.sqrt(x) : (x > -tol ? 0 : NaN);
        }
    });
    return out;
}
export async function soaStableAtan2Chunked(out, ys, xs, count, chunkSize, yieldEvery) {
    count = count === undefined ? out.length : count;
    await _chunked(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) {
            const y = ys[i], x = xs[i];
            out[i] = (x === 0 && y === 0) ? 0 : Math.atan2(y, x);
        }
    });
    return out;
}
export async function soaStableNormalizeChunked(outX, outY, xs, ys, count, chunkSize, yieldEvery) {
    count = count === undefined ? outX.length : count;
    await _chunked(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) {
            const x = xs[i], y = ys[i];
            let ax = x < 0 ? -x : x, ay = y < 0 ? -y : y;
            if (!isFinite(ax) || !isFinite(ay)) { outX[i] = 0; outY[i] = 0; continue; }
            if (ax < ay) { const t = ax; ax = ay; ay = t; }
            if (ax < NORM_EPS) { outX[i] = 0; outY[i] = 0; continue; }
            const len = ay === 0 ? ax : ax * Math.sqrt(1 + (ay / ax) * (ay / ax));
            const inv = 1 / len;
            outX[i] = x * inv; outY[i] = y * inv;
        }
    });
    return outX;
}
export async function soaStableNormalize3Chunked(outVec3, inVec3, count, chunkSize, yieldEvery) {
    count = count === undefined ? outVec3.count : count;
    const oX = outVec3.x, oY = outVec3.y, oZ = outVec3.z;
    const iX = inVec3.x, iY = inVec3.y, iZ = inVec3.z;
    await _chunked(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) {
            const x = iX[i], y = iY[i], z = iZ[i];
            const ax = x < 0 ? -x : x, ay = y < 0 ? -y : y, az = z < 0 ? -z : z;
            let m = ax; if (ay > m) m = ay; if (az > m) m = az;
            if (m < NORM_EPS || !isFinite(m)) { oX[i] = 0; oY[i] = 0; oZ[i] = 0; continue; }
            const a = ax / m, b = ay / m, c = az / m;
            const inv = 1 / (m * Math.sqrt(a * a + b * b + c * c));
            oX[i] = x * inv; oY[i] = y * inv; oZ[i] = z * inv;
        }
    });
    return outVec3;
}
export async function soaStableWrapAngleChunked(out, angles, count, chunkSize, yieldEvery) {
    count = count === undefined ? out.length : count;
    await _chunked(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) {
            let r = angles[i] % TWO_PI;
            if (r < 0) r += TWO_PI;
            out[i] = r;
        }
    });
    return out;
}
export async function soaMonotoneLerpChunked(out, a, b, t, count, chunkSize, yieldEvery) {
    count = count === undefined ? out.length : count;
    const tArr = (t != null && t.length !== undefined) ? t : null;
    await _chunked(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) {
            const ti = tArr ? tArr[i] : t;
            out[i] = monotoneLerp(a[i], b[i], ti);
        }
    });
    return out;
}
export async function soaClampMagnitudeChunked(arr, maxMag, count, chunkSize, yieldEvery) {
    count = count === undefined ? arr.length : count;
    const m = maxMag < 0 ? -maxMag : maxMag;
    await _chunked(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) {
            const x = arr[i];
            if (x > m) arr[i] = m; else if (x < -m) arr[i] = -m;
        }
    });
    return arr;
}
export async function soaRelativeFromDSChunked(outVec3, world, originHi, originLo, eids, count, chunkSize, yieldEvery) {
    count = count === undefined ? outVec3.count : count;
    const ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
    const xh = world.x.hi, xl = world.x.lo;
    const yh = world.y.hi, yl = world.y.lo;
    const zh = world.z.hi, zl = world.z.lo;
    const h0 = originHi[0], h1 = originHi[1], h2 = originHi[2];
    const l0 = originLo ? originLo[0] : 0;
    const l1 = originLo ? originLo[1] : 0;
    const l2 = originLo ? originLo[2] : 0;
    await _chunked(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) {
            const idx = eids ? eids[i] : i;
            dsSubInto(_ds2, xh[idx], xl[idx], h0, l0);
            ox[i] = Math.fround(_ds2[0] + _ds2[1]);
            dsSubInto(_ds2, yh[idx], yl[idx], h1, l1);
            oy[i] = Math.fround(_ds2[0] + _ds2[1]);
            dsSubInto(_ds2, zh[idx], zl[idx], h2, l2);
            oz[i] = Math.fround(_ds2[0] + _ds2[1]);
        }
    });
    return outVec3;
}
export async function compMatvecCSRChunked(out, A, x, chunkSize, yieldEvery) {
    const rp = A.rowPtr, ci = A.colIdx, va = A.values;
    await _chunked(A.rows, chunkSize, yieldEvery, function (s, e) {
        compMatvec(out, rp, ci, va, x, e);
        // compMatvec writes rows [0,e); re-run only the requested window instead.
        for (let i = s; i < e; i++) {
            let sum = 0, c = 0;
            const st = rp[i], en = rp[i + 1];
            for (let k = st; k < en; k++) {
                const av = va[k], bv = x[ci[k]];
                const p = av * bv;
                const t1 = SPLITTER * av, t2 = SPLITTER * bv;
                let lo = 0;
                if (isFinite(t1) && isFinite(t2)) {
                    const ah = t1 + (av - t1), al = av - ah;
                    const bh = t2 + (bv - t2), bl = bv - bh;
                    lo = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
                }
                let t = sum + p;
                if (Math.abs(sum) >= Math.abs(p)) c += (sum - t) + p; else c += (p - t) + sum;
                sum = t;
                t = sum + lo;
                if (Math.abs(sum) >= Math.abs(lo)) c += (sum - t) + lo; else c += (lo - t) + sum;
                sum = t;
            }
            out[i] = sum + c;
        }
    });
    return out;
}

// ============================================================================
// Pools
// ============================================================================
const _compensationPool = common.createPool(
    function () { return { sum: 0, c: 0, cc: 0, value: 0 }; },
    64,
    function (s) { s.sum = 0; s.c = 0; s.cc = 0; s.value = 0; }
);
const _errorPairPool = common.createPool(
    function () { return { hi: 0, lo: 0 }; },
    128,
    function (p) { p.hi = 0; p.lo = 0; }
);
export function createCompensationPool(capacity) {
    return common.createPool(
        function () { return { sum: 0, c: 0, cc: 0, value: 0 }; },
        capacity || 64,
        function (s) { s.sum = 0; s.c = 0; s.cc = 0; s.value = 0; }
    );
}
export function acquireCompensation() { return _compensationPool.acquire(); }
export function releaseCompensation(s) { if (s) _compensationPool.release(s); }
export function createErrorPairPool(capacity) {
    return common.createPool(
        function () { return { hi: 0, lo: 0 }; },
        capacity || 128,
        function (p) { p.hi = 0; p.lo = 0; }
    );
}
export function acquireErrorPair() { return _errorPairPool.acquire(); }
export function releaseErrorPair(p) { if (p) _errorPairPool.release(p); }
/** Fold a pooled compensation handle into its best estimate. */
export function compensationValue(s) { s.value = s.sum + s.c + s.cc; return s.value; }

// ============================================================================
// Classes — ES2017-compatible (no static blocks / private fields)
// ============================================================================
/**
 * Running compensated accumulator — stays accurate across millions of adds.
 * mode: 0 = Kahan, 1 = Neumaier (default), 2 = Klein (second order).
 */
export class CompensatedAccumulator {
    static acquire(mode) {
        const pool = CompensatedAccumulator._warm;
        let a;
        if (pool.length > 0) {
            const last = pool.length - 1;
            a = pool[last];
            pool[last] = undefined;
            pool.length = last;
        } else {
            a = new CompensatedAccumulator();
        }
        a.mode = mode === undefined ? 1 : mode;
        a.reset();
        return a;
    }
    static release(a) {
        if (!a) return;
        a.reset();
        const pool = CompensatedAccumulator._warm;
        if (pool.length < CompensatedAccumulator.MAX_POOLED) pool.push(a);
    }
    constructor(mode) {
        this.mode = mode === undefined ? 1 : mode;
        this.sum = 0;
        this.c = 0;
        this.cc = 0;
    }
    get value() { return this.sum + this.c + this.cc; }
    add(x) {
        if (this.mode === 0) {
            const y = x - this.c;
            const t = this.sum + y;
            this.c = (t - this.sum) - y;
            this.sum = t;
            return this;
        }
        const t = this.sum + x;
        let c;
        if (Math.abs(this.sum) >= Math.abs(x)) c = (this.sum - t) + x;
        else c = (x - t) + this.sum;
        this.sum = t;
        if (this.mode === 2) {
            const t2 = this.c + c;
            let cc;
            if (Math.abs(this.c) >= Math.abs(c)) cc = (this.c - t2) + c;
            else cc = (c - t2) + this.c;
            this.c = t2;
            this.cc += cc;
        } else {
            this.c += c;
        }
        return this;
    }
    addAll(arr, n) {
        n = n === undefined ? arr.length : n;
        for (let i = 0; i < n; i++) this.add(arr[i]);
        return this;
    }
    /** Subtract with the same compensation guarantees. */
    sub(x) { return this.add(-x); }
    reset() { this.sum = 0; this.c = 0; this.cc = 0; return this; }
    drain() {
        const v = this.sum + this.c + this.cc;
        this.sum = 0; this.c = 0; this.cc = 0;
        return v;
    }
    /** Write the normalized [hi, lo] representation into a caller-owned pair. */
    into(out2) { return twoSumInto(out2, this.sum, this.c + this.cc); }
}
CompensatedAccumulator._warm = [];
CompensatedAccumulator.MAX_POOLED = 32;
(function _warmAccumulators() {
    for (let i = 0; i < 8; i++) CompensatedAccumulator._warm.push(new CompensatedAccumulator());
})();

/** Reusable precision-aware scalar scratch (three channels, lazily grown). */
export class ScalarScratch {
    static acquire(size) {
        const pool = ScalarScratch._warm;
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
            s = new ScalarScratch(size || 64);
        }
        s.ensure(size || 0);
        return s;
    }
    static release(s) {
        if (!s) return;
        const pool = ScalarScratch._warm;
        if (pool.length < ScalarScratch.MAX_POOLED) pool.push(s);
    }
    constructor(size) {
        this.size = size || 64;
        this._dtype = getArrayType();
        this.a = new this._dtype(this.size);
        this.b = new this._dtype(this.size);
        this.c = new this._dtype(this.size);
    }
    /** Grow to n AND reallocate if the global precision dtype changed. */
    ensure(n) {
        const T = getArrayType();
        const size = Math.max(n | 0, this.size);
        if (size <= this.size && T === this._dtype) return this;
        this.size = size;
        this._dtype = T;
        this.a = new T(size);
        this.b = new T(size);
        this.c = new T(size);
        return this;
    }
    zero() { this.a.fill(0); this.b.fill(0); this.c.fill(0); return this; }
}
ScalarScratch._warm = [];
ScalarScratch.MAX_POOLED = 16;
(function _warmScalarScratch() {
    for (let i = 0; i < 4; i++) ScalarScratch._warm.push(new ScalarScratch(64));
})();

/**
 * Per-instance compensated accumulation for 1M+ entities.
 * Holds sum / compensation / second-compensation channels plus scratch buffers,
 * migrates live with setPrecision(), and packs to a single transferable buffer.
 */
export class StabilityBatchState {
    constructor(count, options) {
        options = options || {};
        this.count = count;
        this.mode = options.mode === undefined ? 1 : options.mode;   // 0 kahan, 1 neumaier, 2 klein
        const T = getArrayType();
        this._dtype = T;
        this.sum = new T(count);
        this.compensation = new T(count);
        this.secondComp = new T(count);
        this.scratch = new T(count);
        this.scratch2 = new T(count);
        this.scratch3 = new T(count);
        this._tracked = options.track !== false;
        if (this._tracked) trackStability(this);
    }
    /** Add per-instance values with the configured compensation scheme. */
    accumulate(values, count) {
        count = count === undefined ? this.count : count;
        const s = this.sum, c = this.compensation, cc = this.secondComp;
        if (this.mode === 0) {
            for (let i = 0; i < count; i++) {
                const y = values[i] - c[i];
                const t = s[i] + y;
                c[i] = (t - s[i]) - y;
                s[i] = t;
            }
            return this;
        }
        if (this.mode === 2) {
            for (let i = 0; i < count; i++) {
                const x = values[i];
                const si = s[i];
                let t = si + x;
                let e;
                if (Math.abs(si) >= Math.abs(x)) e = (si - t) + x; else e = (x - t) + si;
                s[i] = t;
                const ci = c[i];
                t = ci + e;
                let e2;
                if (Math.abs(ci) >= Math.abs(e)) e2 = (ci - t) + e; else e2 = (e - t) + ci;
                c[i] = t;
                cc[i] += e2;
            }
            return this;
        }
        for (let i = 0; i < count; i++) {
            const x = values[i];
            const si = s[i];
            const t = si + x;
            if (Math.abs(si) >= Math.abs(x)) c[i] += (si - t) + x;
            else c[i] += (x - t) + si;
            s[i] = t;
        }
        return this;
    }
    /** Broadcast a single scalar to every instance. */
    accumulateScalar(x, count) {
        count = count === undefined ? this.count : count;
        const s = this.sum, c = this.compensation;
        for (let i = 0; i < count; i++) {
            const si = s[i];
            const t = si + x;
            if (Math.abs(si) >= Math.abs(x)) c[i] += (si - t) + x;
            else c[i] += (x - t) + si;
            s[i] = t;
        }
        return this;
    }
    async accumulateChunked(values, chunkSize, yieldEvery, count) {
        count = count === undefined ? this.count : count;
        const s = this.sum, c = this.compensation, cc = this.secondComp;
        const mode = this.mode;
        await _chunked(count, chunkSize, yieldEvery, function (st, en) {
            if (mode === 0) {
                for (let i = st; i < en; i++) {
                    const y = values[i] - c[i];
                    const t = s[i] + y;
                    c[i] = (t - s[i]) - y;
                    s[i] = t;
                }
            } else if (mode === 2) {
                for (let i = st; i < en; i++) {
                    const x = values[i], si = s[i];
                    let t = si + x, e;
                    if (Math.abs(si) >= Math.abs(x)) e = (si - t) + x; else e = (x - t) + si;
                    s[i] = t;
                    const ci = c[i];
                    t = ci + e;
                    let e2;
                    if (Math.abs(ci) >= Math.abs(e)) e2 = (ci - t) + e; else e2 = (e - t) + ci;
                    c[i] = t; cc[i] += e2;
                }
            } else {
                for (let i = st; i < en; i++) {
                    const x = values[i], si = s[i];
                    const t = si + x;
                    if (Math.abs(si) >= Math.abs(x)) c[i] += (si - t) + x;
                    else c[i] += (x - t) + si;
                    s[i] = t;
                }
            }
        });
        return this;
    }
    valueAt(i) { return this.sum[i] + this.compensation[i] + this.secondComp[i]; }
    /** Best estimate per instance = sum + compensation (+ second order). */
    drainInto(out, count) {
        count = count === undefined ? this.count : count;
        const s = this.sum, c = this.compensation, cc = this.secondComp;
        for (let i = 0; i < count; i++) out[i] = s[i] + c[i] + cc[i];
        return out;
    }
    /** Best estimate per instance, then reset the accumulators. */
    drainResetInto(out, count) {
        this.drainInto(out, count);
        this.reset();
        return out;
    }
    /** Compensated grand total across all instances. */
    total() {
        let s = 0, c = 0;
        const n = this.count;
        for (let i = 0; i < n; i++) {
            const x = this.sum[i] + this.compensation[i] + this.secondComp[i];
            const t = s + x;
            if (Math.abs(s) >= Math.abs(x)) c += (s - t) + x; else c += (x - t) + s;
            s = t;
        }
        return s + c;
    }
    /** Write the normalized [hi, lo] pair for row i into a caller-owned pair. */
    pairAt(out2, i) { return twoSumInto(out2, this.sum[i], this.compensation[i] + this.secondComp[i]); }
    reset() {
        this.sum.fill(0);
        this.compensation.fill(0);
        this.secondComp.fill(0);
        return this;
    }
    /** Reallocate channels at a new precision, preserving accumulated state. */
    migrate(targetPrecision) {
        const T = targetPrecision ? getArrayType(targetPrecision) : getArrayType();
        if (T === this._dtype) return this;
        const n = this.count;
        const ns = new T(n); ns.set(this.sum);
        const nc = new T(n); nc.set(this.compensation);
        const ncc = new T(n); ncc.set(this.secondComp);
        this.sum = ns; this.compensation = nc; this.secondComp = ncc;
        this.scratch = new T(n); this.scratch2 = new T(n); this.scratch3 = new T(n);
        this._dtype = T;
        return this;
    }
    toTransferable() { return stabilityToTransferable(this); }
    dispose() { if (this._tracked) untrackStability(this); return this; }
}
export function createStabilityBatch(count, options) { return new StabilityBatchState(count, options); }

/**
 * Drift-free fixed-step simulation clock (Blueprint §45 / §51).
 * BOTH the total time and the step accumulator are Neumaier-compensated, so a
 * simulation running for days at 120 Hz does not accumulate Float64 drift.
 */
export class CompensatedClock {
    constructor(options) {
        options = options || {};
        this.hz = options.hz !== undefined ? options.hz : 60;
        this.fixedDt = 1 / this.hz;
        this.maxSteps = options.maxSteps !== undefined ? options.maxSteps : 8;
        this.maxFrameDt = options.maxFrameDt !== undefined ? options.maxFrameDt : 0.25;
        this.onStep = options.onStep || null;
        this._tS = 0; this._tC = 0;
        this._aS = 0; this._aC = 0;
        this.ticks = 0;
        this.alpha = 0;
        this.dropped = 0;
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
    /** Feed a real frame delta in SECONDS. Returns the number of fixed steps run. */
    step(dtSec) {
        let dt = dtSec < 0 ? 0 : (dtSec > this.maxFrameDt ? this.maxFrameDt : dtSec);
        this._addTime(dt);
        this._addAcc(dt);
        const fdt = this.fixedDt;
        let steps = 0;
        while (this._aS + this._aC >= fdt && steps < this.maxSteps) {
            if (this.onStep) this.onStep(fdt, this.ticks);
            this._addAcc(-fdt);
            this.ticks++;
            steps++;
        }
        if (steps === this.maxSteps) {
            this.dropped++;
            this._aS = 0; this._aC = 0;
        }
        this.alpha = (this._aS + this._aC) / fdt;
        return steps;
    }
    /** Feed milliseconds (RAF convention). */
    stepMs(dtMs) { return this.step(dtMs * 0.001); }
    reset() {
        this._tS = 0; this._tC = 0;
        this._aS = 0; this._aC = 0;
        this.ticks = 0; this.alpha = 0; this.dropped = 0;
        return this;
    }
}
export function createCompensatedClock(options) { return new CompensatedClock(options); }

// ============================================================================
// Precision tracking / migration (dense arrays — no Map/Set, §10/§16)
// ============================================================================
const _trackedStates = [];
export function trackStability(state) {
    if (!state) return state;
    if (_trackedStates.indexOf(state) === -1) _trackedStates.push(state);
    return state;
}
export function untrackStability(state) {
    const i = _trackedStates.indexOf(state);
    if (i !== -1) _trackedStates.splice(i, 1);
}
export function clearTrackedStability() { _trackedStates.length = 0; }
export function getTrackedStability() { return _trackedStates; }
export function migrateStability(state, targetPrecision) {
    if (state && state.migrate) state.migrate(targetPrecision);
    return state;
}
export function migrateAllStability(targetPrecision) {
    for (let i = 0; i < _trackedStates.length; i++) {
        try { _trackedStates[i].migrate(targetPrecision); }
        catch (e) { console.error("[036_numerical-stability] migration failed for one state", e); }
    }
}

onPrecisionChange(function () {
    migrateAllStability();
    // Scratch pools are rebuilt at SWITCH time only — never in the frame loop.
    ScalarScratch._warm.length = 0;
    for (let i = 0; i < 4; i++) ScalarScratch._warm.push(new ScalarScratch(64));
});

// ============================================================================
// Zero-copy transferable state (Blueprint §49)
// ----------------------------------------------------------------------------
// The compensation words are ALWAYS stored as Float64. Narrowing them to f32
// would destroy the entire point of compensated accumulation.
// Layout: Int32 header [magic, version, count, mode] then sum | comp | second.
// ============================================================================
const STAB_MAGIC = 0x53544142; // "STAB"
const STAB_HEADER_BYTES = 16;

export function stabilityToTransferable(state) {
    const n = state.count;
    const total = STAB_HEADER_BYTES + n * 8 * 3;
    const buffer = new ArrayBuffer(total);
    const header = new Int32Array(buffer, 0, 4);
    header[0] = STAB_MAGIC; header[1] = 1; header[2] = n; header[3] = state.mode;
    new Float64Array(buffer, STAB_HEADER_BYTES, n).set(state.sum);
    new Float64Array(buffer, STAB_HEADER_BYTES + n * 8, n).set(state.compensation);
    new Float64Array(buffer, STAB_HEADER_BYTES + n * 16, n).set(state.secondComp);
    return { buffer: buffer, count: n, mode: state.mode, transferable: [buffer] };
}
export function stabilityFromTransferable(packet, options) {
    const buffer = packet.buffer || packet;
    const header = new Int32Array(buffer, 0, 4);
    if (header[0] !== STAB_MAGIC) throw new Error("stabilityFromTransferable: bad magic");
    if (header[1] !== 1) throw new Error("stabilityFromTransferable: unsupported version " + header[1]);
    const n = header[2], mode = header[3];
    const opts = options || {};
    opts.mode = mode;
    const state = new StabilityBatchState(n, opts);
    // Copy through Float64 views first so no precision is lost on the way in.
    const sh = new Float64Array(buffer, STAB_HEADER_BYTES, n);
    const ch = new Float64Array(buffer, STAB_HEADER_BYTES + n * 8, n);
    const cch = new Float64Array(buffer, STAB_HEADER_BYTES + n * 16, n);
    for (let i = 0; i < n; i++) {
        state.sum[i] = sh[i];
        state.compensation[i] = ch[i];
        state.secondComp[i] = cch[i];
    }
    return state;
}

// ============================================================================
// GPU attribute bridge (Blueprint §25 / §28)
// ============================================================================
/** Write values[i] into flat[i*stride + offset], optionally scaled and biased. */
export function writeScalarIntoFlat(flat, values, count, stride, offset, scale, bias) {
    const n = count === undefined ? values.length : count;
    const st = stride === undefined ? 1 : stride;
    const off = offset === undefined ? 0 : offset;
    const s = scale === undefined ? 1 : scale;
    const b = bias === undefined ? 0 : bias;
    for (let i = 0, o = off; i < n; i++, o += st) flat[o] = values[i] * s + b;
    return flat;
}
/** Dirty-prefix upload flag (Three.js r185 addUpdateRange). */
export function flagStabilityUpload(attr, count, itemSize) {
    if (!attr) return;
    const st = itemSize || attr.itemSize || 1;
    if (attr.clearUpdateRanges) attr.clearUpdateRanges();
    if (attr.addUpdateRange) attr.addUpdateRange(0, count * st);
    attr.needsUpdate = true;
}
/**
 * Upload compensated results into an InstancedBufferAttribute.
 * `values` may be a plain array-like OR a StabilityBatchState (peeked, not reset).
 * options: { stride, offset, scale, bias, itemSize, reset }
 */
export function syncStabilityAttribute(attr, values, count, options) {
    if (!attr || !attr.array) return 0;
    options = options || {};
    const isState = !!(values && values.sum && values.compensation);
    const n = count === undefined ? (isState ? values.count : values.length) : count;
    const st = options.stride !== undefined ? options.stride : (attr.itemSize || 1);
    const off = options.offset === undefined ? 0 : options.offset;
    const sc = options.scale === undefined ? 1 : options.scale;
    const bi = options.bias === undefined ? 0 : options.bias;
    const flat = attr.array;
    if (isState) {
        const s = values.sum, c = values.compensation, cc = values.secondComp;
        for (let i = 0, o = off; i < n; i++, o += st) flat[o] = (s[i] + c[i] + cc[i]) * sc + bi;
        if (options.reset === true) values.reset();
    } else {
        for (let i = 0, o = off; i < n; i++, o += st) flat[o] = values[i] * sc + bi;
    }
    flagStabilityUpload(attr, n, st);
    return n;
}

// ============================================================================
// Namespaces
// ============================================================================
export const summation = {
    kahan: kahanSum,
    neumaier: neumaierSum,
    klein: kleinSum,
    pairwise: pairwiseSum,
    compensated: neumaierSum,
    into: neumaierSumInto,
    mean: compensatedMean,
    variance: compensatedVariance,
    accumulator: CompensatedAccumulator
};
export const transformations = {
    twoSum: twoSum, twoSumInto: twoSumInto,
    twoDiff: twoDiff, twoDiffInto: twoDiffInto,
    twoProd: twoProd, twoProdInto: twoProdInto,
    twoSqr: twoSqr, twoSqrInto: twoSqrInto,
    fastTwoSum: fastTwoSum, fastTwoSumInto: fastTwoSumInto
};
export const precisionBridge = {
    normalizeInto: dsNormalizeInto,
    fromNumber: dsFromNumber,
    toNumber: dsToNumber,
    addInto: dsAddInto,
    subInto: dsSubInto,
    mulInto: dsMulInto,
    mul21Into: dsMul21Into,
    div21Into: dsDiv21Into,
    subF32: dsSubF32,
    distanceSq: dsDistanceSq,
    soaAdd: soaDsAdd,
    soaSub: soaDsSub,
    soaRelative: soaRelativeFromDS,
    soaRelativeChunked: soaRelativeFromDSChunked,
    toDoubleSOA: toDoubleSOA,
    fromDoubleSOA: fromDoubleSOA
};
export const robust = {
    hypot: stableHypot,
    hypot3: stableHypot3,
    sqrt: stableSqrt,
    log: stableLog,
    exp: stableExp,
    pow: stablePow,
    atan2: stableAtan2,
    normalize: stableNormalize,
    normalize3: stableNormalize3,
    quadratic: stableQuadratic,
    quadraticInto: stableQuadraticInto
};
export const compensated = {
    dot: compDot,
    dot3: compDot3,
    sumSquares: compSumSquares,
    norm: compNorm,
    length3: compLength3,
    distance3: compDistance3,
    matvec: compMatvec,
    matvecCSR: compMatvecCSR,
    matvecCSRChunked: compMatvecCSRChunked,
    keplerResidual: compKeplerResidual
};
export const angles = {
    wrap: stableWrapAngle,
    shortest: stableShortestAngle,
    lerp: monotoneLerp,
    lerpClamped: lerpClamped,
    lerpAngle: lerpAngle
};
export const tolerance = {
    eq: approxEq,
    eqRel: approxEqRel,
    eqUlp: approxEqUlp,
    snap: snapToGrid,
    quantize: quantize,
    ulp: ulpAt,
    ulpF32: ulpAtF32,
    nextAfter: nextAfter,
    nextAfterF32: nextAfterF32
};
export const guards = {
    clampMagnitude: clampMagnitude,
    clampToRange: clampToRange,
    denormal: denormalGuard,
    denormal64: denormalGuard64
};
export const gpu = {
    writeScalarIntoFlat: writeScalarIntoFlat,
    flagUpload: flagStabilityUpload,
    syncAttribute: syncStabilityAttribute
};
export const transfer = {
    toTransferable: stabilityToTransferable,
    fromTransferable: stabilityFromTransferable
};
export const precision = {
    getPrecision: getPrecision,
    setPrecision: setPrecision,
    getArrayType: getArrayType,
    onPrecisionChange: onPrecisionChange,
    track: trackStability,
    untrack: untrackStability,
    migrate: migrateStability,
    migrateAll: migrateAllStability,
    getTracked: getTrackedStability,
    clearTracked: clearTrackedStability
};
export const math = {
    common: common,
    double: double,
    createFixedStepScheduler: createFixedStepScheduler
};
export const namespace = {
    summation: summation,
    transformations: transformations,
    precisionBridge: precisionBridge,
    robust: robust,
    compensated: compensated,
    angles: angles,
    tolerance: tolerance,
    guards: guards,
    gpu: gpu,
    transfer: transfer,
    precision: precision,
    CompensatedAccumulator: CompensatedAccumulator,
    ScalarScratch: ScalarScratch,
    StabilityBatchState: StabilityBatchState,
    CompensatedClock: CompensatedClock
};