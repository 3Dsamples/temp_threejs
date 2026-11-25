// file number : 015
// full path name : src/math/015_easings.js
// description : Complete easing / animation-curve library — every original
//               export preserved with byte-identical formulas, rewritten as a
//               self-contained native ES module in the three.js r185 JSM addon
//               style: no strict-mode directive, no CommonJS, no Vite / Vue /
//               client build, no CDN request.
//               Contents: the original easing table (linear, Quad / Cubic /
//               Expo in-out, easeOutBack, easeOutBounce, physical spring,
//               cubicBezier) plus the full extended preset set (Sine / Circ /
//               Quint / Quart / Back / Elastic in & out & in-out), a proper CSS
//               cubic-bezier Newton–Raphson solver with bisection fallback and
//               the W3C named curves, a universal getEasing resolver, baked
//               Float32 LUTs (transcendental curves become a single table tap
//               per element), SOA apply / lerp / per-element-t for 1M+ scalars,
//               complete chunked-yielding counterparts, allocation-free
//               frame-rate-independent spring batches (scalar + vec3), HDR-safe
//               color easing, eased vec3 / quaternion / dual-quaternion / full
//               TRS SOA interpolation (the default-math replacement layer for
//               1M instances), easing-aware stagger, Kepler orbital easing
//               (position + state, scalar and 1M-body SOA), IK target and
//               quaternion easing, an object-based EasingSystem, a typed-array
//               SOAEasingSystem built on a shared LUT atlas for 1M concurrent
//               transitions, duck-typed three.js r185 interop (Vector3 /
//               Quaternion / Color / BufferAttribute / InstancedMesh) and an
//               optional Blob-URL worker pool for true multi-core easing with
//               a non-blocking main-thread fallback.
// best for : 3d graphics — animation curves on 1M+ instances, HDR color
//            transitions that preserve shadow detail through exposure changes,
//            procedural placement paths that ease from noise / Voronoi /
//            orbital scatter into their targets, natural IK that eases limb
//            end-effectors or per-bone rotations toward solved positions,
//            orbital camera fly-ins along a Kepler-elliptical path with correct
//            physics, spring-driven cloth / tentacles / jelly wobble via batch
//            damping, and CSS-identical curves for HTML overlays on top of a
//            WebGL / WebGPU canvas — all at 60 fps on Android mobile 64-bit.
// license : MIT
//
// topological hierarchy (dependencies first — this file is last):
//   src/math/002_vec2.js
//   src/math/003_vec3.js
//   src/math/004_vec4.js
//   src/math/005_mat2.js
//   src/math/006_mat3.js          (optional, dynamic)
//   src/math/007_mat4.js
//   src/math/008_quat.js
//   src/math/009_quat2.js
//   src/math/010_bitECS_core.js   (optional, dynamic)
//   src/math/012_double.js        (optional precision tier, not required)
//   src/math/013_simplex.js       (optional, dynamic)
//   src/math/014_utils.js         (optional, dynamic — local stagger fallback)
//   src/math/015_easings.js       <- THIS FILE
// ============================================================================

import * as vec2 from "./002_vec2.js";
import * as vec3 from "./003_vec3.js";
import * as vec4 from "./004_vec4.js";
import * as mat2 from "./005_mat2.js";
import * as mat4 from "./007_mat4.js";
import * as quat from "./008_quat.js";
import * as quat2 from "./009_quat2.js";

// ============================================================================
// 0. FOUNDATION (inlined — replaces require("./common.js"))
// ============================================================================
const CHUNK_SIZE = 65536;
const CHUNK_YIELD_EVERY = 8;
const POOL_PREALLOC = 256;
const EPSILON = 0.000001;

function yieldToMain() {
    return new Promise(function (resolve) {
        if (typeof setTimeout === "function") { setTimeout(resolve, 0); }
        else { resolve(); }
    });
}

function createPool(factory, capacity, reset) {
    capacity = capacity || POOL_PREALLOC;
    const items = [];
    for (let i = 0; i < capacity; i++) { items.push(factory()); }
    return {
        acquire() { return items.length > 0 ? items.pop() : factory(); },
        release(v) {
            if (reset) { reset(v); }
            if (items.length < capacity) { items.push(v); }
        }
    };
}

const common = { CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC, EPSILON, yieldToMain, createPool };

// ============================================================================
// 1. ORIGINAL EASING TABLE (formulas preserved exactly)
// ============================================================================
const easings = {
    linear(t) { return t; },
    easeInQuad(t) { return t * t; },
    easeOutQuad(t) { return t * (2 - t); },
    easeInOutQuad(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; },
    easeInCubic(t) { return t * t * t; },
    easeOutCubic(t) { const u = t - 1; return u * u * u + 1; },
    easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1; },
    easeInExpo(t) { return t === 0 ? 0 : Math.pow(2, 10 * (t - 1)); },
    easeOutExpo(t) { return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); },
    easeInOutExpo(t) {
        if (t === 0 || t === 1) { return t; }
        return t < 0.5 ? 0.5 * Math.pow(2, 20 * t - 10) : 1 - 0.5 * Math.pow(2, -20 * t + 10);
    },
    easeOutBack(t, overshoot) {
        overshoot = overshoot === undefined ? 1.70158 : overshoot;
        const c = overshoot + 1;
        const u = t - 1;
        return 1 + c * u * u * u + overshoot * u * u;
    },
    easeOutBounce(t) {
        const n1 = 7.5625, d1 = 2.75;
        if (t < 1 / d1) { return n1 * t * t; }
        if (t < 2 / d1) { t -= 1.5 / d1; return n1 * t * t + 0.75; }
        if (t < 2.5 / d1) { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
        t -= 2.625 / d1; return n1 * t * t + 0.984375;
    },
    spring(t, mass, stiffness, damping) {
        mass = mass === undefined ? 1 : mass;
        stiffness = stiffness === undefined ? 100 : stiffness;
        damping = damping === undefined ? 10 : damping;
        const w0 = Math.sqrt(stiffness / mass);
        const zeta = damping / (2 * Math.sqrt(stiffness * mass));
        if (zeta < 1) {
            const wd = w0 * Math.sqrt(1 - zeta * zeta);
            return 1 - Math.exp(-zeta * w0 * t) *
                (Math.cos(wd * t) + (zeta * w0 / wd) * Math.sin(wd * t));
        }
        return 1 - (1 + w0 * t) * Math.exp(-w0 * t);
    },
    cubicBezier(x1, y1, x2, y2) {
        const cx = 3 * x1;
        const bx = 3 * (x2 - x1) - cx;
        const ax = 1 - cx - bx;
        const cy = 3 * y1;
        const by = 3 * (y2 - y1) - cy;
        const ay = 1 - cy - by;
        return function (t) { return ((ay * t + by) * t + cy) * t; };
    }
};

// ============================================================================
// 2. EXTENDED PRESETS (Sine / Circ / Quint / Quart / Back / Elastic)
// ============================================================================
const PI = Math.PI;
const HALF_PI = PI * 0.5;
const TWO_PI = PI * 2;

easings.easeInSine = function (t) { return 1 - Math.cos(t * HALF_PI); };
easings.easeOutSine = function (t) { return Math.sin(t * HALF_PI); };
easings.easeInOutSine = function (t) { return (1 - Math.cos(PI * t)) * 0.5; };

easings.easeInCirc = function (t) { return 1 - Math.sqrt(1 - t * t); };
easings.easeOutCirc = function (t) { const u = t - 1; return Math.sqrt(1 - u * u); };
easings.easeInOutCirc = function (t) {
    if (t < 0.5) { return (1 - Math.sqrt(1 - 4 * t * t)) * 0.5; }
    const u = -2 * t + 2;
    return (Math.sqrt(1 - u * u) + 1) * 0.5;
};

easings.easeInQuint = function (t) { return t * t * t * t * t; };
easings.easeOutQuint = function (t) { const u = t - 1; return u * u * u * u * u + 1; };
easings.easeInOutQuint = function (t) {
    if (t < 0.5) { return 16 * t * t * t * t * t; }
    const u = -2 * t + 2;
    return 0.5 * u * u * u * u * u + 1;
};

easings.easeInQuart = function (t) { return t * t * t * t; };
easings.easeOutQuart = function (t) { const u = t - 1; return 1 - u * u * u * u; };
easings.easeInOutQuart = function (t) {
    if (t < 0.5) { return 8 * t * t * t * t; }
    const u = t - 1;
    return 1 - 8 * u * u * u * u;
};

const BACK_C1 = 1.70158;
const BACK_C2 = BACK_C1 * 1.525;
const BACK_C3 = BACK_C1 + 1;

easings.easeInBack = function (t) { return BACK_C3 * t * t * t - BACK_C1 * t * t; };
easings.easeInOutBack = function (t) {
    if (t < 0.5) {
        const u = 2 * t;
        return 0.5 * (u * u * ((BACK_C2 + 1) * u - BACK_C2));
    }
    const v = 2 * t - 2;
    return 0.5 * (v * v * ((BACK_C2 + 1) * v + BACK_C2) + 2);
};

const ELASTIC_C4 = TWO_PI / 3;
const ELASTIC_C5 = TWO_PI / 4.5;

easings.easeInElastic = function (t) {
    if (t === 0 || t === 1) { return t; }
    return -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * ELASTIC_C4);
};
easings.easeOutElastic = function (t) {
    if (t === 0 || t === 1) { return t; }
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ELASTIC_C4) + 1;
};
easings.easeInOutElastic = function (t) {
    if (t === 0 || t === 1) { return t; }
    if (t < 0.5) { return -0.5 * Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * ELASTIC_C5); }
    return 0.5 * Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * ELASTIC_C5) + 1;
};

// Convenience aliases used across the SOA layer (never clamp HDR values).
easings.smoothstep = function (t) { return t * t * (3 - 2 * t); };
easings.smootherstep = function (t) { return t * t * t * (t * (t * 6 - 15) + 10); };

// ============================================================================
// 3. PROPER CSS CUBIC-BEZIER SOLVER (Newton–Raphson + bisection fallback)
// ============================================================================
/**
 * Unlike `easings.cubicBezier` (which evaluates y at the raw input t), this
 * solves x(s) = t for s, then returns y(s) — exactly what browsers do for
 * CSS `cubic-bezier(...)`. Coefficients are precomputed once per curve.
 */
function cubicBezierCSS(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;

    function sampleX(s) { return ((ax * s + bx) * s + cx) * s; }
    function sampleY(s) { return ((ay * s + by) * s + cy) * s; }
    function sampleDX(s) { return (3 * ax * s + 2 * bx) * s + cx; }

    return function (t) {
        if (t <= 0) { return 0; }
        if (t >= 1) { return 1; }
        let s = t;
        for (let i = 0; i < 8; i++) {
            const diff = sampleX(s) - t;
            if (diff < 1e-6 && diff > -1e-6) { return sampleY(s); }
            const dx = sampleDX(s);
            if (dx > -1e-6 && dx < 1e-6) { break; }
            s -= diff / dx;
        }
        // Bisection fallback guarantees convergence for degenerate curves.
        let lo = 0, hi = 1;
        s = t;
        for (let i = 0; i < 24; i++) {
            const x = sampleX(s);
            if (x > t - 1e-6 && x < t + 1e-6) { break; }
            if (x < t) { lo = s; } else { hi = s; }
            s = (lo + hi) * 0.5;
        }
        return sampleY(s);
    };
}

const CSS_CURVES = {
    "linear": easings.linear,
    "ease": cubicBezierCSS(0.25, 0.1, 0.25, 1.0),
    "ease-in": cubicBezierCSS(0.42, 0.0, 1.0, 1.0),
    "ease-out": cubicBezierCSS(0.0, 0.0, 0.58, 1.0),
    "ease-in-out": cubicBezierCSS(0.42, 0.0, 0.58, 1.0)
};

// ============================================================================
// 4. PRESET LOOKUP
// ============================================================================
const SPRING_RE = /^spring\(\s*([\d.]+)?\s*,?\s*([\d.]+)?\s*,?\s*([\d.]+)?\s*\)$/;
const BEZIER_RE = /^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/;
const _resolveCache = new Map();

/**
 * Resolve any easing identifier to a callable easing function.
 * Accepts a function, an `easings` key, a CSS curve name, a
 * `spring(mass, stiffness, damping)` string, a
 * `cubic-bezier(x1, y1, x2, y2)` string, or a partial / case-insensitive
 * match. Falls back to `easings.spring` (original behaviour).
 */
function getEasing(name) {
    if (typeof name === "function") { return name; }
    if (name == null) { return easings.spring; }
    const key = String(name);
    const cached = _resolveCache.get(key);
    if (cached) { return cached; }

    let fn = null;
    if (easings[key]) { fn = easings[key]; }
    else if (CSS_CURVES[key]) { fn = CSS_CURVES[key]; }

    if (!fn) {
        const mSpring = key.match(SPRING_RE);
        if (mSpring) {
            const mass = parseFloat(mSpring[1]) || 1;
            const k = parseFloat(mSpring[2]) || 100;
            const c = parseFloat(mSpring[3]) || 10;
            fn = function (t) { return easings.spring(t, mass, k, c); };
        }
    }
    if (!fn) {
        const mBez = key.match(BEZIER_RE);
        if (mBez) {
            fn = cubicBezierCSS(
                parseFloat(mBez[1]), parseFloat(mBez[2]),
                parseFloat(mBez[3]), parseFloat(mBez[4])
            );
        }
    }
    if (!fn) {
        const lower = key.toLowerCase();
        for (const k2 in easings) { if (k2.toLowerCase() === lower) { fn = easings[k2]; break; } }
        if (!fn) {
            for (const k3 in easings) { if (k3.toLowerCase().indexOf(lower) !== -1) { fn = easings[k3]; break; } }
        }
    }
    if (!fn) { fn = easings.spring; }
    if (_resolveCache.size < 512) { _resolveCache.set(key, fn); }
    return fn;
}

// ============================================================================
// 5. LUT BAKING — transcendental curves become one table tap per element
// ============================================================================
const EASE_IDS = [
    "linear", "smoothstep", "smootherstep",
    "easeInQuad", "easeOutQuad", "easeInOutQuad",
    "easeInCubic", "easeOutCubic", "easeInOutCubic",
    "easeInQuart", "easeOutQuart", "easeInOutQuart",
    "easeInQuint", "easeOutQuint", "easeInOutQuint",
    "easeInSine", "easeOutSine", "easeInOutSine",
    "easeInExpo", "easeOutExpo", "easeInOutExpo",
    "easeInCirc", "easeOutCirc", "easeInOutCirc",
    "easeInBack", "easeOutBack", "easeInOutBack",
    "easeInElastic", "easeOutElastic", "easeInOutElastic",
    "easeOutBounce", "spring"
];
const EASE_ID_MAP = new Map();
for (let i = 0; i < EASE_IDS.length; i++) { EASE_ID_MAP.set(EASE_IDS[i], i); }

/** Bake an easing into a Float32Array LUT of `size + 1` samples over [0,1]. */
function bakeEasingLUT(easeFn, size) {
    size = size || 1024;
    const fn = typeof easeFn === "function" ? easeFn : getEasing(easeFn);
    const lut = new Float32Array(size + 1);
    for (let i = 0; i <= size; i++) { lut[i] = fn(i / size); }
    return lut;
}

/** Linear-interpolated LUT tap. */
function sampleLUT(lut, t) {
    const n = lut.length - 1;
    if (t <= 0) { return lut[0]; }
    if (t >= 1) { return lut[n]; }
    const x = t * n;
    const i = x | 0;
    return lut[i] + (lut[i + 1] - lut[i]) * (x - i);
}

const _lutAtlas = new Map();
/** Shared, lazily-baked LUT for any named easing (used by SOAEasingSystem). */
function getEaseLUT(nameOrFn, size) {
    const key = typeof nameOrFn === "string" ? nameOrFn : null;
    if (key !== null) {
        const hit = _lutAtlas.get(key);
        if (hit) { return hit; }
    }
    const lut = bakeEasingLUT(nameOrFn, size || 1024);
    if (key !== null && _lutAtlas.size < 128) { _lutAtlas.set(key, lut); }
    return lut;
}

/** Map an easing function / name to a worker-safe id, or -1 for custom curves. */
function easeIdOf(ease) {
    if (typeof ease === "string") {
        const id = EASE_ID_MAP.get(ease);
        if (id !== undefined) { return id; }
        const fn = getEasing(ease);
        for (let i = 0; i < EASE_IDS.length; i++) { if (easings[EASE_IDS[i]] === fn) { return i; } }
        return -1;
    }
    if (typeof ease === "function") {
        for (let i = 0; i < EASE_IDS.length; i++) { if (easings[EASE_IDS[i]] === ease) { return i; } }
    }
    return -1;
}

/** out[i] = LUT(ts[i]) — the fastest path for 1M+ elements. */
function soaApplyLUT(out, ts, lut, count) {
    count = count === undefined ? out.length : count;
    const n = lut.length - 1;
    for (let i = 0; i < count; i++) {
        const t = ts[i];
        if (t <= 0) { out[i] = lut[0]; continue; }
        if (t >= 1) { out[i] = lut[n]; continue; }
        const x = t * n, k = x | 0;
        out[i] = lut[k] + (lut[k + 1] - lut[k]) * (x - k);
    }
    return out;
}

/** dst[i] = a[i] + (b[i]-a[i]) * LUT(ts[i]). */
function soaApplyLUTLerp(dst, a, b, ts, lut, count) {
    count = count === undefined ? dst.length : count;
    const n = lut.length - 1;
    for (let i = 0; i < count; i++) {
        const t = ts[i];
        let e;
        if (t <= 0) { e = lut[0]; }
        else if (t >= 1) { e = lut[n]; }
        else { const x = t * n, k = x | 0; e = lut[k] + (lut[k + 1] - lut[k]) * (x - k); }
        dst[i] = a[i] + (b[i] - a[i]) * e;
    }
    return dst;
}

// ============================================================================
// 6. SOA APPLY — 1M+ scalars per frame, synchronous, zero allocation
// ============================================================================
/** out[i] = easeFn(ts[i]). */
function soaApply(out, ts, easeFn, count) {
    count = count === undefined ? out.length : count;
    const fn = easeFn || easings.linear;
    for (let i = 0; i < count; i++) { out[i] = fn(ts[i]); }
    return out;
}

/** In-place variant: arr[i] = easeFn(arr[i]). */
function soaApplyInPlace(arr, easeFn, count) {
    count = count === undefined ? arr.length : count;
    const fn = easeFn || easings.linear;
    for (let i = 0; i < count; i++) { arr[i] = fn(arr[i]); }
    return arr;
}

/** Interpolate a[i] → b[i] using a shared eased t. */
function soaApplyLerp(dst, a, b, t, easeFn, count) {
    count = count === undefined ? dst.length : count;
    const et = (easeFn || easings.linear)(t);
    for (let i = 0; i < count; i++) { dst[i] = a[i] + (b[i] - a[i]) * et; }
    return dst;
}

/** Per-element t: dst[i] = a[i] + (b[i]-a[i]) * easeFn(ts[i]). */
function soaApplyLerpPerT(dst, a, b, ts, easeFn, count) {
    count = count === undefined ? dst.length : count;
    const fn = easeFn || easings.linear;
    for (let i = 0; i < count; i++) {
        const et = fn(ts[i]);
        dst[i] = a[i] + (b[i] - a[i]) * et;
    }
    return dst;
}

// ============================================================================
// 7. CHUNKED ASYNC — mobile-safe 1M+ with yields (never freezes the UI)
// ============================================================================
async function _chunkedRange(count, chunkSize, yieldEvery, perChunk) {
    chunkSize = chunkSize || CHUNK_SIZE;
    yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
    let start = 0, chunksSinceYield = 0;
    while (start < count) {
        const end = Math.min(start + chunkSize, count);
        perChunk(start, end);
        start = end;
        if (start >= count) { break; }
        if (++chunksSinceYield >= yieldEvery) { chunksSinceYield = 0; await yieldToMain(); }
    }
}

async function soaApplyChunked(out, ts, easeFn, count, chunkSize, yieldEvery) {
    count = count === undefined ? out.length : count;
    const fn = easeFn || easings.linear;
    await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) { out[i] = fn(ts[i]); }
    });
    return out;
}

async function soaApplyInPlaceChunked(arr, easeFn, count, chunkSize, yieldEvery) {
    count = count === undefined ? arr.length : count;
    const fn = easeFn || easings.linear;
    await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) { arr[i] = fn(arr[i]); }
    });
    return arr;
}

async function soaApplyLerpChunked(dst, a, b, t, easeFn, count, chunkSize, yieldEvery) {
    count = count === undefined ? dst.length : count;
    const et = (easeFn || easings.linear)(t);
    await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) { dst[i] = a[i] + (b[i] - a[i]) * et; }
    });
    return dst;
}

async function soaApplyLerpPerTChunked(dst, a, b, ts, easeFn, count, chunkSize, yieldEvery) {
    count = count === undefined ? dst.length : count;
    const fn = easeFn || easings.linear;
    await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) {
            const et = fn(ts[i]);
            dst[i] = a[i] + (b[i] - a[i]) * et;
        }
    });
    return dst;
}

async function soaApplyLUTChunked(out, ts, lut, count, chunkSize, yieldEvery) {
    count = count === undefined ? out.length : count;
    const n = lut.length - 1;
    await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) {
            const t = ts[i];
            if (t <= 0) { out[i] = lut[0]; continue; }
            if (t >= 1) { out[i] = lut[n]; continue; }
            const x = t * n, k = x | 0;
            out[i] = lut[k] + (lut[k + 1] - lut[k]) * (x - k);
        }
    });
    return out;
}

// ============================================================================
// 8. FRAME-RATE-INDEPENDENT SPRING BATCH (natural IK / cloth / wobble)
// ============================================================================
function _springParams(smoothTime, dt, maxSpeed) {
    let st = smoothTime;
    if (st < 0.0001) { st = 0.0001; }
    const omega = 2 / st;
    const x = omega * dt;
    return {
        omega: omega,
        exp: 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x),
        maxChange: (maxSpeed === undefined ? Infinity : maxSpeed) * st,
        invDt: dt > 0 ? 1 / dt : 0
    };
}

/**
 * Batch critically-damped spring for 1M+ independent scalars.
 * `positions` and `velocities` are mutated in place. `targets` may be a
 * Float32Array (per element) or a single number. `smoothTime` may also be a
 * per-element array. Allocation-free: the spring math is fully inlined.
 */
function soaSpringDampBatch(positions, velocities, targets, smoothTime, dt, count, maxSpeed) {
    count = count === undefined ? positions.length : count;
    const isArr = typeof targets !== "number";
    const stArr = (smoothTime && smoothTime.length !== undefined) ? smoothTime : null;
    const ms = maxSpeed === undefined ? Infinity : maxSpeed;
    const invDt = dt > 0 ? 1 / dt : 0;
    let omega = 0, exp = 0, maxChange = 0;
    if (!stArr) {
        const p = _springParams(smoothTime, dt, ms);
        omega = p.omega; exp = p.exp; maxChange = p.maxChange;
    }
    for (let i = 0; i < count; i++) {
        if (stArr) {
            let st = smoothTime[i];
            if (st < 0.0001) { st = 0.0001; }
            omega = 2 / st;
            const x = omega * dt;
            exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
            maxChange = ms * st;
        }
        const c = positions[i];
        const ot = isArr ? targets[i] : targets;
        let t = ot;
        let change = c - t;
        if (change > maxChange) { change = maxChange; }
        else if (change < -maxChange) { change = -maxChange; }
        t = c - change;
        const v0 = velocities[i];
        const temp = (v0 + omega * change) * dt;
        let v = (v0 - omega * temp) * exp;
        let out = t + (change + temp) * exp;
        if ((ot - c > 0) === (out > ot)) { out = ot; v = (out - ot) * invDt; }
        positions[i] = out;
        velocities[i] = v;
    }
    return positions;
}

async function soaSpringDampBatchChunked(positions, velocities, targets, smoothTime, dt, count, maxSpeed, chunkSize, yieldEvery) {
    count = count === undefined ? positions.length : count;
    await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
        const isArr = typeof targets !== "number";
        const sub = isArr ? targets.subarray(s, e) : targets;
        const stArr = (smoothTime && smoothTime.length !== undefined) ? smoothTime.subarray(s, e) : smoothTime;
        soaSpringDampRange(positions, velocities, sub, stArr, dt, s, e, maxSpeed, isArr);
    });
    return positions;
}

function soaSpringDampRange(positions, velocities, targets, smoothTime, dt, start, end, maxSpeed, isArr) {
    const stArr = (smoothTime && smoothTime.length !== undefined) ? smoothTime : null;
    const ms = maxSpeed === undefined ? Infinity : maxSpeed;
    const invDt = dt > 0 ? 1 / dt : 0;
    let omega = 0, exp = 0, maxChange = 0;
    if (!stArr) {
        const p = _springParams(smoothTime, dt, ms);
        omega = p.omega; exp = p.exp; maxChange = p.maxChange;
    }
    for (let i = start; i < end; i++) {
        if (stArr) {
            let st = stArr[i - start];
            if (st < 0.0001) { st = 0.0001; }
            omega = 2 / st;
            const x = omega * dt;
            exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
            maxChange = ms * st;
        }
        const c = positions[i];
        const ot = isArr ? targets[i - start] : targets;
        let t = ot;
        let change = c - t;
        if (change > maxChange) { change = maxChange; }
        else if (change < -maxChange) { change = -maxChange; }
        t = c - change;
        const v0 = velocities[i];
        const temp = (v0 + omega * change) * dt;
        let v = (v0 - omega * temp) * exp;
        let out = t + (change + temp) * exp;
        if ((ot - c > 0) === (out > ot)) { out = ot; v = (out - ot) * invDt; }
        positions[i] = out;
        velocities[i] = v;
    }
}

/**
 * Batch 3D spring — one independent spring per (element, axis).
 * `positions` / `velocities` are vec3 SOAs; `targets` is a vec3 SOA or [x,y,z].
 */
function soaSpringDamp3Batch(positions, velocities, targets, smoothTime, dt, count, maxSpeed) {
    count = count === undefined ? positions.count : count;
    const isSOA = targets && targets.x !== undefined;
    const px = positions.x, py = positions.y, pz = positions.z;
    const vx = velocities.x, vy = velocities.y, vz = velocities.z;
    const tx = isSOA ? targets.x : null, ty = isSOA ? targets.y : null, tz = isSOA ? targets.z : null;
    const fx = (!isSOA && targets) ? targets[0] : 0;
    const fy = (!isSOA && targets) ? targets[1] : 0;
    const fz = (!isSOA && targets) ? targets[2] : 0;
    const p = _springParams(smoothTime, dt, maxSpeed);
    const omega = p.omega, exp = p.exp, maxChange = p.maxChange, invDt = p.invDt;

    for (let i = 0; i < count; i++) {
        const otx = isSOA ? tx[i] : (targets ? fx : px[i]);
        const oty = isSOA ? ty[i] : (targets ? fy : py[i]);
        const otz = isSOA ? tz[i] : (targets ? fz : pz[i]);

        let c = px[i], t = otx, change = c - t;
        if (change > maxChange) { change = maxChange; } else if (change < -maxChange) { change = -maxChange; }
        t = c - change;
        let v0 = vx[i];
        let temp = (v0 + omega * change) * dt;
        let v = (v0 - omega * temp) * exp;
        let out = t + (change + temp) * exp;
        if ((otx - c > 0) === (out > otx)) { out = otx; v = 0; }
        px[i] = out; vx[i] = v;

        c = py[i]; t = oty; change = c - t;
        if (change > maxChange) { change = maxChange; } else if (change < -maxChange) { change = -maxChange; }
        t = c - change;
        v0 = vy[i];
        temp = (v0 + omega * change) * dt;
        v = (v0 - omega * temp) * exp;
        out = t + (change + temp) * exp;
        if ((oty - c > 0) === (out > oty)) { out = oty; v = 0; }
        py[i] = out; vy[i] = v;

        c = pz[i]; t = otz; change = c - t;
        if (change > maxChange) { change = maxChange; } else if (change < -maxChange) { change = -maxChange; }
        t = c - change;
        v0 = vz[i];
        temp = (v0 + omega * change) * dt;
        v = (v0 - omega * temp) * exp;
        out = t + (change + temp) * exp;
        if ((otz - c > 0) === (out > otz)) { out = otz; v = 0; }
        pz[i] = out; vz[i] = v;
    }
    return positions;
}

async function soaSpringDamp3BatchChunked(positions, velocities, targets, smoothTime, dt, count, maxSpeed, chunkSize, yieldEvery) {
    count = count === undefined ? positions.count : count;
    const isSOA = targets && targets.x !== undefined;
    const px = positions.x, py = positions.y, pz = positions.z;
    const vx = velocities.x, vy = velocities.y, vz = velocities.z;
    const p = _springParams(smoothTime, dt, maxSpeed);
    const omega = p.omega, exp = p.exp, maxChange = p.maxChange;

    await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) {
            const otx = isSOA ? targets.x[i] : (targets ? targets[0] : px[i]);
            const oty = isSOA ? targets.y[i] : (targets ? targets[1] : py[i]);
            const otz = isSOA ? targets.z[i] : (targets ? targets[2] : pz[i]);

            let c = px[i], t = otx, change = c - t;
            if (change > maxChange) { change = maxChange; } else if (change < -maxChange) { change = -maxChange; }
            t = c - change;
            let v0 = vx[i];
            let temp = (v0 + omega * change) * dt;
            let v = (v0 - omega * temp) * exp;
            let out = t + (change + temp) * exp;
            if ((otx - c > 0) === (out > otx)) { out = otx; v = 0; }
            px[i] = out; vx[i] = v;

            c = py[i]; t = oty; change = c - t;
            if (change > maxChange) { change = maxChange; } else if (change < -maxChange) { change = -maxChange; }
            t = c - change;
            v0 = vy[i];
            temp = (v0 + omega * change) * dt;
            v = (v0 - omega * temp) * exp;
            out = t + (change + temp) * exp;
            if ((oty - c > 0) === (out > oty)) { out = oty; v = 0; }
            py[i] = out; vy[i] = v;

            c = pz[i]; t = otz; change = c - t;
            if (change > maxChange) { change = maxChange; } else if (change < -maxChange) { change = -maxChange; }
            t = c - change;
            v0 = vz[i];
            temp = (v0 + omega * change) * dt;
            v = (v0 - omega * temp) * exp;
            out = t + (change + temp) * exp;
            if ((otz - c > 0) === (out > otz)) { out = otz; v = 0; }
            pz[i] = out; vz[i] = v;
        }
    });
    return positions;
}

// ============================================================================
// 9. HDR-SAFE COLOR EASING (never clamps — exposure pipelines stay intact)
// ============================================================================
function easeColorRGBA(out, from, to, t, easeFn) {
    const et = easeFn ? easeFn(t) : t;
    out[0] = from[0] + (to[0] - from[0]) * et;
    out[1] = from[1] + (to[1] - from[1]) * et;
    out[2] = from[2] + (to[2] - from[2]) * et;
    out[3] = from[3] + (to[3] - from[3]) * et;
    return out;
}

/** Per-element color lerp on a vec4 SOA from flat RGBA endpoints. */
function soaEaseColor(out, from, to, ts, easeFn, count) {
    count = count === undefined ? out.count : count;
    const fn = easeFn || easings.linear;
    const ox = out.x, oy = out.y, oz = out.z, ow = out.w;
    const fx = from[0], fy = from[1], fz = from[2], fw = from[3];
    const dx = to[0] - fx, dy = to[1] - fy, dz = to[2] - fz, dw = to[3] - fw;
    for (let i = 0; i < count; i++) {
        const et = fn(ts[i]);
        ox[i] = fx + dx * et;
        oy[i] = fy + dy * et;
        oz[i] = fz + dz * et;
        ow[i] = fw + dw * et;
    }
    return out;
}

async function soaEaseColorChunked(out, from, to, ts, easeFn, count, chunkSize, yieldEvery) {
    count = count === undefined ? out.count : count;
    const fn = easeFn || easings.linear;
    const ox = out.x, oy = out.y, oz = out.z, ow = out.w;
    const fx = from[0], fy = from[1], fz = from[2], fw = from[3];
    const dx = to[0] - fx, dy = to[1] - fy, dz = to[2] - fz, dw = to[3] - fw;
    await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) {
            const et = fn(ts[i]);
            ox[i] = fx + dx * et;
            oy[i] = fy + dy * et;
            oz[i] = fz + dz * et;
            ow[i] = fw + dw * et;
        }
    });
    return out;
}

/** Ease a vec4 SOA from its current value toward per-element targets. */
function soaEaseColorTargets(out, targets, ts, easeFn, count) {
    count = count === undefined ? out.count : count;
    const fn = easeFn || easings.linear;
    const ox = out.x, oy = out.y, oz = out.z, ow = out.w;
    const tX = targets.x, tY = targets.y, tZ = targets.z, tW = targets.w;
    for (let i = 0; i < count; i++) {
        const et = fn(ts[i]);
        ox[i] = ox[i] + (tX[i] - ox[i]) * et;
        oy[i] = oy[i] + (tY[i] - oy[i]) * et;
        oz[i] = oz[i] + (tZ[i] - oz[i]) * et;
        ow[i] = ow[i] + (tW[i] - ow[i]) * et;
    }
    return out;
}

async function soaEaseColorTargetsChunked(out, targets, ts, easeFn, count, chunkSize, yieldEvery) {
    count = count === undefined ? out.count : count;
    const fn = easeFn || easings.linear;
    const ox = out.x, oy = out.y, oz = out.z, ow = out.w;
    const tX = targets.x, tY = targets.y, tZ = targets.z, tW = targets.w;
    await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) {
            const et = fn(ts[i]);
            ox[i] = ox[i] + (tX[i] - ox[i]) * et;
            oy[i] = oy[i] + (tY[i] - oy[i]) * et;
            oz[i] = oz[i] + (tZ[i] - oz[i]) * et;
            ow[i] = ow[i] + (tW[i] - ow[i]) * et;
        }
    });
    return out;
}

// ============================================================================
// 10. VECTOR / QUATERNION / DUAL-QUAT / TRS EASING (default-math replacement)
// ============================================================================
/** Eased per-element lerp on vec3 SOAs. */
function soaEaseVec3(out, from, to, ts, easeFn, count) {
    count = count === undefined ? out.count : count;
    const fn = easeFn || easings.linear;
    const ox = out.x, oy = out.y, oz = out.z;
    const fx = from.x, fy = from.y, fz = from.z;
    const tx = to.x, ty = to.y, tz = to.z;
    for (let i = 0; i < count; i++) {
        const et = fn(ts[i]);
        ox[i] = fx[i] + (tx[i] - fx[i]) * et;
        oy[i] = fy[i] + (ty[i] - fy[i]) * et;
        oz[i] = fz[i] + (tz[i] - fz[i]) * et;
    }
    return out;
}

async function soaEaseVec3Chunked(out, from, to, ts, easeFn, count, chunkSize, yieldEvery) {
    count = count === undefined ? out.count : count;
    const fn = easeFn || easings.linear;
    const ox = out.x, oy = out.y, oz = out.z;
    const fx = from.x, fy = from.y, fz = from.z;
    const tx = to.x, ty = to.y, tz = to.z;
    await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) {
            const et = fn(ts[i]);
            ox[i] = fx[i] + (tx[i] - fx[i]) * et;
            oy[i] = fy[i] + (ty[i] - fy[i]) * et;
            oz[i] = fz[i] + (tz[i] - fz[i]) * et;
        }
    });
    return out;
}

/** Ease a vec3 SOA from its current value toward per-element targets. */
function soaEaseVec3Targets(out, targets, ts, easeFn, count) {
    count = count === undefined ? out.count : count;
    const fn = easeFn || easings.linear;
    const ox = out.x, oy = out.y, oz = out.z;
    const tx = targets.x, ty = targets.y, tz = targets.z;
    for (let i = 0; i < count; i++) {
        const et = fn(ts[i]);
        ox[i] = ox[i] + (tx[i] - ox[i]) * et;
        oy[i] = oy[i] + (ty[i] - oy[i]) * et;
        oz[i] = oz[i] + (tz[i] - oz[i]) * et;
    }
    return out;
}

async function soaEaseVec3TargetsChunked(out, targets, ts, easeFn, count, chunkSize, yieldEvery) {
    count = count === undefined ? out.count : count;
    const fn = easeFn || easings.linear;
    const ox = out.x, oy = out.y, oz = out.z;
    const tx = targets.x, ty = targets.y, tz = targets.z;
    await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) {
            const et = fn(ts[i]);
            ox[i] = ox[i] + (tx[i] - ox[i]) * et;
            oy[i] = oy[i] + (ty[i] - oy[i]) * et;
            oz[i] = oz[i] + (tz[i] - oz[i]) * et;
        }
    });
    return out;
}

/** Eased shortest-arc slerp on quaternion SOAs (inlined, zero-GC). */
function soaEaseQuatSOA(out, from, to, ts, easeFn, count) {
    count = count === undefined ? out.count : count;
    const fn = easeFn || easings.linear;
    const ox = out.x, oy = out.y, oz = out.z, ow = out.w;
    const ax = from.x, ay = from.y, az = from.z, aw = from.w;
    const bx = to.x, by = to.y, bz = to.z, bw = to.w;
    for (let i = 0; i < count; i++) {
        const tt = fn(ts[i]);
        const qx = ax[i], qy = ay[i], qz = az[i], qw = aw[i];
        let rx = bx[i], ry = by[i], rz = bz[i], rw = bw[i];
        let cosom = qx * rx + qy * ry + qz * rz + qw * rw;
        if (cosom < 0) { cosom = -cosom; rx = -rx; ry = -ry; rz = -rz; rw = -rw; }
        let s0, s1;
        if (1 - cosom > EPSILON) {
            const omega = Math.acos(cosom), sinom = Math.sin(omega);
            s0 = Math.sin((1 - tt) * omega) / sinom;
            s1 = Math.sin(tt * omega) / sinom;
        } else { s0 = 1 - tt; s1 = tt; }
        ox[i] = s0 * qx + s1 * rx;
        oy[i] = s0 * qy + s1 * ry;
        oz[i] = s0 * qz + s1 * rz;
        ow[i] = s0 * qw + s1 * rw;
    }
    return out;
}

async function soaEaseQuatSOAChunked(out, from, to, ts, easeFn, count, chunkSize, yieldEvery) {
    count = count === undefined ? out.count : count;
    await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
        const view = {
            x: out.x.subarray(s, e), y: out.y.subarray(s, e),
            z: out.z.subarray(s, e), w: out.w.subarray(s, e), count: e - s
        };
        const fv = {
            x: from.x.subarray(s, e), y: from.y.subarray(s, e),
            z: from.z.subarray(s, e), w: from.w.subarray(s, e), count: e - s
        };
        const tv = {
            x: to.x.subarray(s, e), y: to.y.subarray(s, e),
            z: to.z.subarray(s, e), w: to.w.subarray(s, e), count: e - s
        };
        soaEaseQuatSOA(view, fv, tv, ts.subarray(s, e), easeFn, e - s);
    });
    return out;
}

/**
 * Eased dual-quaternion blend on quat2 SOAs (8 floats / instance) — the
 * GPU-friendly rigid transform path. Antipodal-safe DLB + renormalisation.
 */
function soaEaseDualQuat(out, from, to, ts, easeFn, count) {
    count = count === undefined ? out.count : count;
    const fn = easeFn || easings.linear;
    const oX1 = out.x1, oY1 = out.y1, oZ1 = out.z1, oW1 = out.w1;
    const oX2 = out.x2, oY2 = out.y2, oZ2 = out.z2, oW2 = out.w2;
    const aX1 = from.x1, aY1 = from.y1, aZ1 = from.z1, aW1 = from.w1;
    const aX2 = from.x2, aY2 = from.y2, aZ2 = from.z2, aW2 = from.w2;
    const bX1 = to.x1, bY1 = to.y1, bZ1 = to.z1, bW1 = to.w1;
    const bX2 = to.x2, bY2 = to.y2, bZ2 = to.z2, bW2 = to.w2;

    for (let i = 0; i < count; i++) {
        const tt = fn(ts[i]);
        const r0 = aX1[i], r1 = aY1[i], r2 = aZ1[i], r3 = aW1[i];
        let s0 = bX1[i], s1 = bY1[i], s2 = bZ1[i], s3 = bW1[i];
        let d0 = bX2[i], d1 = bY2[i], d2 = bY2[i], d3 = bW2[i];
        d0 = bX2[i]; d1 = bY2[i]; d2 = bZ2[i]; d3 = bW2[i];
        if (r0 * s0 + r1 * s1 + r2 * s2 + r3 * s3 < 0) {
            s0 = -s0; s1 = -s1; s2 = -s2; s3 = -s3;
            d0 = -d0; d1 = -d1; d2 = -d2; d3 = -d3;
        }
        const mt = 1 - tt;
        const n0 = r0 * mt + s0 * tt, n1 = r1 * mt + s1 * tt;
        const n2 = r2 * mt + s2 * tt, n3 = r3 * mt + s3 * tt;
        const e0 = aX2[i] * mt + d0 * tt, e1 = aY2[i] * mt + d1 * tt;
        const e2 = aZ2[i] * mt + d2 * tt, e3 = aW2[i] * mt + d3 * tt;
        const mag = Math.sqrt(n0 * n0 + n1 * n1 + n2 * n2 + n3 * n3);
        if (mag > 0) {
            const q0 = n0 / mag, q1 = n1 / mag, q2 = n2 / mag, q3 = n3 / mag;
            const adb = q0 * e0 + q1 * e1 + q2 * e2 + q3 * e3;
            oX1[i] = q0; oY1[i] = q1; oZ1[i] = q2; oW1[i] = q3;
            oX2[i] = (e0 - q0 * adb) / mag;
            oY2[i] = (e1 - q1 * adb) / mag;
            oZ2[i] = (e2 - q2 * adb) / mag;
            oW2[i] = (e3 - q3 * adb) / mag;
        } else {
            oX1[i] = 0; oY1[i] = 0; oZ1[i] = 0; oW1[i] = 1;
            oX2[i] = 0; oY2[i] = 0; oZ2[i] = 0; oW2[i] = 0;
        }
    }
    return out;
}

async function soaEaseDualQuatChunked(out, from, to, ts, easeFn, count, chunkSize, yieldEvery) {
    count = count === undefined ? out.count : count;
    const keys = ["x1", "y1", "z1", "w1", "x2", "y2", "z2", "w2"];
    await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
        const n = e - s;
        const ov = { count: n }, fv = { count: n }, tv = { count: n };
        for (let k = 0; k < 8; k++) {
            const key = keys[k];
            ov[key] = out[key].subarray(s, e);
            fv[key] = from[key].subarray(s, e);
            tv[key] = to[key].subarray(s, e);
        }
        soaEaseDualQuat(ov, fv, tv, ts.subarray(s, e), easeFn, n);
    });
    return out;
}

/**
 * Eased full TRS blend: position lerp + shortest-arc quaternion slerp +
 * scale lerp, all driven by the same per-element eased t. This is the
 * 1M-instance transform animation primitive.
 * `out` / `from` / `to` are { position, rotation, scale } SOA bundles.
 */
function soaEaseTRS(out, from, to, ts, easeFn, count) {
    count = count === undefined ? out.position.count : count;
    const fn = easeFn || easings.linear;
    const opx = out.position.x, opy = out.position.y, opz = out.position.z;
    const fpx = from.position.x, fpy = from.position.y, fpz = from.position.z;
    const tpx = to.position.x, tpy = to.position.y, tpz = to.position.z;
    const osx = out.scale.x, osy = out.scale.y, osz = out.scale.z;
    const fsx = from.scale.x, fsy = from.scale.y, fsz = from.scale.z;
    const tsx = to.scale.x, tsy = to.scale.y, tsz = to.scale.z;
    const oqx = out.rotation.x, oqy = out.rotation.y, oqz = out.rotation.z, oqw = out.rotation.w;
    const fqx = from.rotation.x, fqy = from.rotation.y, fqz = from.rotation.z, fqw = from.rotation.w;
    const tqx = to.rotation.x, tqy = to.rotation.y, tqz = to.rotation.z, tqw = to.rotation.w;

    for (let i = 0; i < count; i++) {
        const et = fn(ts[i]);
        opx[i] = fpx[i] + (tpx[i] - fpx[i]) * et;
        opy[i] = fpy[i] + (tpy[i] - fpy[i]) * et;
        opz[i] = fpz[i] + (tpz[i] - fpz[i]) * et;
        osx[i] = fsx[i] + (tsx[i] - fsx[i]) * et;
        osy[i] = fsy[i] + (tsy[i] - fsy[i]) * et;
        osz[i] = fsz[i] + (tsz[i] - fsz[i]) * et;

        const ax = fqx[i], ay = fqy[i], az = fqz[i], aw = fqw[i];
        let bx = tqx[i], by = tqy[i], bz = tqz[i], bw = tqw[i];
        let cosom = ax * bx + ay * by + az * bz + aw * bw;
        if (cosom < 0) { cosom = -cosom; bx = -bx; by = -by; bz = -bz; bw = -bw; }
        let s0, s1;
        if (1 - cosom > EPSILON) {
            const omega = Math.acos(cosom), sinom = Math.sin(omega);
            s0 = Math.sin((1 - et) * omega) / sinom;
            s1 = Math.sin(et * omega) / sinom;
        } else { s0 = 1 - et; s1 = et; }
        oqx[i] = s0 * ax + s1 * bx;
        oqy[i] = s0 * ay + s1 * by;
        oqz[i] = s0 * az + s1 * bz;
        oqw[i] = s0 * aw + s1 * bw;
    }
    return out;
}

async function soaEaseTRSChunked(out, from, to, ts, easeFn, count, chunkSize, yieldEvery) {
    count = count === undefined ? out.position.count : count;
    await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
        const n = e - s;
        const ov = {
            position: { x: out.position.x.subarray(s, e), y: out.position.y.subarray(s, e), z: out.position.z.subarray(s, e), count: n },
            rotation: { x: out.rotation.x.subarray(s, e), y: out.rotation.y.subarray(s, e), z: out.rotation.z.subarray(s, e), w: out.rotation.w.subarray(s, e), count: n },
            scale: { x: out.scale.x.subarray(s, e), y: out.scale.y.subarray(s, e), z: out.scale.z.subarray(s, e), count: n }
        };
        const fv = {
            position: { x: from.position.x.subarray(s, e), y: from.position.y.subarray(s, e), z: from.position.z.subarray(s, e), count: n },
            rotation: { x: from.rotation.x.subarray(s, e), y: from.rotation.y.subarray(s, e), z: from.rotation.z.subarray(s, e), w: from.rotation.w.subarray(s, e), count: n },
            scale: { x: from.scale.x.subarray(s, e), y: from.scale.y.subarray(s, e), z: from.scale.z.subarray(s, e), count: n }
        };
        const tv = {
            position: { x: to.position.x.subarray(s, e), y: to.position.y.subarray(s, e), z: to.position.z.subarray(s, e), count: n },
            rotation: { x: to.rotation.x.subarray(s, e), y: to.rotation.y.subarray(s, e), z: to.rotation.z.subarray(s, e), w: to.rotation.w.subarray(s, e), count: n },
            scale: { x: to.scale.x.subarray(s, e), y: to.scale.y.subarray(s, e), z: to.scale.z.subarray(s, e), count: n }
        };
        soaEaseTRS(ov, fv, tv, ts.subarray(s, e), easeFn, n);
    });
    return out;
}

// ============================================================================
// 11. EASING-AWARE STAGGER
// ============================================================================
/** Compose an easing with a stagger factor function. */
function staggerEased(easeFn, staggerFn) {
    const fn = easeFn || easings.linear;
    return function (index, total, position) {
        return fn(staggerFn(index, total, position));
    };
}

/** Local stagger fallback (identical semantics to utils.stagger). */
function _localStagger(val, opts) {
    opts = opts || {};
    const from = opts.from || 0;
    const ease = typeof opts.easing === "function" ? opts.easing : function (t) { return t; };
    const grid = opts.grid, axis = opts.axis;
    return function (index, total) {
        total = total === undefined ? 1 : total;
        if (grid && Array.isArray(grid)) {
            const cols = grid[0], rows = grid[1];
            const col = index % cols, row = Math.floor(index / cols);
            let fromX = 0, fromY = 0;
            if (from === "center") { fromX = (cols - 1) / 2; fromY = (rows - 1) / 2; }
            else if (from === "last") { fromX = cols - 1; fromY = rows - 1; }
            else if (Array.isArray(from)) { fromX = from[0]; fromY = from[1]; }
            let dist;
            if (axis === "x") { dist = Math.abs(col - fromX); }
            else if (axis === "y") { dist = Math.abs(row - fromY); }
            else { dist = Math.sqrt((col - fromX) * (col - fromX) + (row - fromY) * (row - fromY)); }
            const mx = Math.max(fromX, cols - 1 - fromX);
            const my = Math.max(fromY, rows - 1 - fromY);
            const maxDist = axis === "x" ? mx : axis === "y" ? my : Math.sqrt(mx * mx + my * my);
            const factor = maxDist > 0 ? dist / maxDist : 0;
            const baseVal = typeof val === "function" ? val(index, total) : val;
            return ease(factor) * baseVal;
        }
        let f = total > 1 ? index / (total - 1) : 0;
        if (from === "center") { f = Math.abs(index - (total - 1) / 2) / ((total - 1) / 2 || 1); }
        else if (from === "last") { f = 1 - f; }
        else if (typeof from === "number" && total > 1) { f = Math.abs(index - from) / Math.max(from, total - 1 - from); }
        const baseVal2 = typeof val === "function" ? val(index, total) : val * index;
        return ease(f) * baseVal2;
    };
}

/** Compose an easing with utils.stagger options (grid / axis / from). */
function staggerWithEase(easing, val, opts) {
    const base = utils && utils.stagger ? utils.stagger : _localStagger;
    return staggerEased(getEasing(easing), base(val, opts));
}

// ============================================================================
// 12. EASING-AWARE ORBITAL (Kepler anomaly interpolation)
// ============================================================================
function easeKeplerPosition(out, a, e, inc, Om, om, M0, M1, t, easeFn) {
    const et = easeFn ? easeFn(t) : t;
    const M = M0 + (M1 - M0) * et;
    return vec3.keplerOrbit3D(out, a, e, M, inc, Om, om);
}

function easeKeplerState(outPos, outVel, a, e, inc, Om, om, M0, M1, mu, t, easeFn) {
    const et = easeFn ? easeFn(t) : t;
    const M = M0 + (M1 - M0) * et;
    vec3.keplerOrbit3D(outPos, a, e, M, inc, Om, om);
    vec3.keplerOrbitVelocity3D(outVel, a, e, M, inc, Om, om, mu);
    return outPos;
}

/** 1M-body eased Kepler positions written into a vec3 SOA. */
function soaEaseKeplerPosition(out, elements, M1s, ts, easeFn, count) {
    count = count === undefined ? out.count : count;
    const fn = easeFn || easings.linear;
    const ox = out.x, oy = out.y, oz = out.z;
    const a = elements.a, e = elements.e, M0 = elements.M;
    const inc = elements.inc, Om = elements.Om, om = elements.om;
    const tmp = _tmpVec3;
    for (let i = 0; i < count; i++) {
        const et = fn(ts[i]);
        const M = M0[i] + (M1s[i] - M0[i]) * et;
        vec3.keplerOrbit3D(tmp, a[i], e[i], M, inc[i], Om[i], om[i]);
        ox[i] = tmp[0]; oy[i] = tmp[1]; oz[i] = tmp[2];
    }
    return out;
}

async function soaEaseKeplerPositionChunked(out, elements, M1s, ts, easeFn, count, chunkSize, yieldEvery) {
    count = count === undefined ? out.count : count;
    const fn = easeFn || easings.linear;
    const ox = out.x, oy = out.y, oz = out.z;
    const a = elements.a, e = elements.e, M0 = elements.M;
    const inc = elements.inc, Om = elements.Om, om = elements.om;
    const tmp = _tmpVec3;
    await _chunkedRange(count, chunkSize, yieldEvery, function (s, en) {
        for (let i = s; i < en; i++) {
            const et = fn(ts[i]);
            const M = M0[i] + (M1s[i] - M0[i]) * et;
            vec3.keplerOrbit3D(tmp, a[i], e[i], M, inc[i], Om[i], om[i]);
            ox[i] = tmp[0]; oy[i] = tmp[1]; oz[i] = tmp[2];
        }
    });
    return out;
}

// ============================================================================
// 13. EASING-AWARE IK / NATURAL MOTION
// ============================================================================
const _tmpVec3 = new Float32Array(3);
const _tmpQuat = new Float32Array(4);

function easeIKTarget(out, from, to, t, easeFn) {
    const et = easeFn ? easeFn(t) : t;
    out[0] = from[0] + (to[0] - from[0]) * et;
    out[1] = from[1] + (to[1] - from[1]) * et;
    out[2] = from[2] + (to[2] - from[2]) * et;
    return out;
}

function easeQuat(out, from, to, t, easeFn) {
    const et = easeFn ? easeFn(t) : t;
    return quat.slerp(out, from, to, et);
}

// ============================================================================
// 14. EASING SYSTEMS — object-based (original) + typed-array SOA (1M+)
// ============================================================================
const _entryPool = createPool(
    function () {
        return {
            eid: 0, from: 0, to: 0, current: 0, t: 0, duration: 1, delay: 0,
            ease: easings.linear, apply: null, onDone: null, done: false, active: true
        };
    },
    POOL_PREALLOC,
    function (e) {
        e.eid = 0; e.from = 0; e.to = 0; e.current = 0; e.t = 0;
        e.duration = 1; e.delay = 0; e.ease = easings.linear;
        e.apply = null; e.onDone = null; e.done = false; e.active = true;
    }
);

/**
 * Per-entity easing system (original API preserved). Each entity owns a
 * (from → to) transition on a chosen channel: particle fades, material
 * transitions, staggered spawn scale-ups, crowd IK targets.
 */
class EasingSystem {
    constructor(world, options) {
        options = options || {};
        this.world = world || null;
        this.chunkSize = options.chunkSize || CHUNK_SIZE;
        this.yieldEvery = options.yieldEvery || CHUNK_YIELD_EVERY;
        this.entries = [];
        this._stepsSincePurge = 0;
    }

    get size() { return this.entries.length; }

    add(eid, cfg) {
        cfg = cfg || {};
        const e = _entryPool.acquire();
        e.eid = eid;
        e.from = cfg.from !== undefined ? cfg.from : 0;
        e.to = cfg.to !== undefined ? cfg.to : 1;
        e.current = e.from;
        e.t = 0;
        e.duration = cfg.duration !== undefined ? cfg.duration : 1;
        e.delay = cfg.delay || 0;
        e.ease = getEasing(cfg.ease);
        e.apply = cfg.apply || null;
        e.onDone = cfg.onDone || null;
        e.done = false;
        e.active = true;
        this.entries.push(e);
        return e;
    }

    /** Remove every entry for an entity id (swap-pop, O(n) scan). */
    remove(eid) {
        const list = this.entries;
        for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].eid === eid) {
                const e = list[i];
                const last = list.pop();
                if (i < list.length) { list[i] = last; }
                _entryPool.release(e);
            }
        }
        return this;
    }

    _stepOne(e, dt) {
        if (!e.active || e.done) { return; }
        if (e.delay > 0) { e.delay -= dt; return; }
        if (e.duration <= 0) { e.current = e.to; e.t = 1; }
        else {
            e.t += dt / e.duration;
            if (e.t >= 1) { e.t = 1; }
        }
        e.current = e.from + (e.to - e.from) * e.ease(e.t);
        if (e.apply) { e.apply(e.eid, e.current, e); }
        if (e.t >= 1) {
            e.done = true;
            if (e.onDone) { e.onDone(e.eid, e); }
        }
    }

    _purge() {
        const list = this.entries;
        for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].done) {
                const e = list[i];
                const last = list.pop();
                if (i < list.length) { list[i] = last; }
                _entryPool.release(e);
            }
        }
    }

    /** Synchronous step. Fast for <100k; use stepChunked for 1M+. */
    step(dt) {
        const list = this.entries, n = list.length;
        for (let i = 0; i < n; i++) { this._stepOne(list[i], dt); }
        if (++this._stepsSincePurge >= 64) { this._stepsSincePurge = 0; this._purge(); }
        return this;
    }

    /** Chunked async step — mobile-safe. */
    async stepChunked(dt) {
        const list = this.entries, n = list.length;
        const self = this;
        await _chunkedRange(n, this.chunkSize, this.yieldEvery, function (s, e) {
            for (let i = s; i < e; i++) { self._stepOne(list[i], dt); }
        });
        if (++this._stepsSincePurge >= 64) { this._stepsSincePurge = 0; this._purge(); }
        return this;
    }

    clear() {
        const list = this.entries;
        for (let i = 0; i < list.length; i++) { _entryPool.release(list[i]); }
        list.length = 0;
        return this;
    }
}

function createEasingSystem(world, options) { return new EasingSystem(world, options); }

/**
 * Typed-array easing system for 1M+ concurrent transitions. All state lives
 * in SOA channels; every curve is sampled from a shared baked LUT atlas, so a
 * step costs one table tap per element — no transcendental calls, no GC.
 */
class SOAEasingSystem {
    constructor(capacity, options) {
        capacity = capacity || (1 << 20);
        options = options || {};
        this.capacity = capacity;
        this.chunkSize = options.chunkSize || CHUNK_SIZE;
        this.yieldEvery = options.yieldEvery || CHUNK_YIELD_EVERY;
        this.lutSize = options.lutSize || 1024;
        this.eid = new Uint32Array(capacity);
        this.from = new Float32Array(capacity);
        this.to = new Float32Array(capacity);
        this.value = new Float32Array(capacity);
        this.t = new Float32Array(capacity);
        this.duration = new Float32Array(capacity);
        this.delay = new Float32Array(capacity);
        this.easeId = new Uint8Array(capacity);
        this.state = new Uint8Array(capacity); // 0 free · 1 active · 2 done
        this.count = 0;
        this._luts = [];
        for (let i = 0; i < EASE_IDS.length; i++) {
            this._luts.push(getEaseLUT(EASE_IDS[i], this.lutSize));
        }
        this._stepsSincePurge = 0;
    }

    get size() { return this.count; }

    /** Returns the slot index, or -1 when the system is full. */
    add(eid, cfg) {
        if (this.count >= this.capacity) { return -1; }
        cfg = cfg || {};
        const i = this.count++;
        this.eid[i] = eid;
        this.from[i] = cfg.from !== undefined ? cfg.from : 0;
        this.to[i] = cfg.to !== undefined ? cfg.to : 1;
        this.value[i] = this.from[i];
        this.t[i] = 0;
        this.duration[i] = cfg.duration !== undefined ? cfg.duration : 1;
        this.delay[i] = cfg.delay || 0;
        const id = easeIdOf(cfg.ease === undefined ? "linear" : cfg.ease);
        this.easeId[i] = id >= 0 ? id : 0;
        this.state[i] = 1;
        return i;
    }

    remove(index) {
        if (index < 0 || index >= this.count) { return this; }
        const last = --this.count;
        if (index !== last) {
            this.eid[index] = this.eid[last];
            this.from[index] = this.from[last];
            this.to[index] = this.to[last];
            this.value[index] = this.value[last];
            this.t[index] = this.t[last];
            this.duration[index] = this.duration[last];
            this.delay[index] = this.delay[last];
            this.easeId[index] = this.easeId[last];
            this.state[index] = this.state[last];
        }
        this.state[last] = 0;
        return this;
    }

    _range(dt, s, e, apply) {
        const t = this.t, dur = this.duration, delay = this.delay;
        const from = this.from, to = this.to, value = this.value;
        const state = this.state, easeId = this.easeId, eid = this.eid;
        const luts = this._luts;
        for (let i = s; i < e; i++) {
            if (state[i] !== 1) { continue; }
            if (delay[i] > 0) { delay[i] -= dt; continue; }
            let tt;
            if (dur[i] <= 0) { tt = 1; }
            else {
                tt = t[i] + dt / dur[i];
                if (tt >= 1) { tt = 1; }
            }
            t[i] = tt;
            const lut = luts[easeId[i]];
            const n = lut.length - 1;
            let ev;
            if (tt <= 0) { ev = lut[0]; }
            else if (tt >= 1) { ev = lut[n]; }
            else { const x = tt * n, k = x | 0; ev = lut[k] + (lut[k + 1] - lut[k]) * (x - k); }
            const v = from[i] + (to[i] - from[i]) * ev;
            value[i] = v;
            if (apply) { apply(eid[i], v, i); }
            if (tt >= 1) { state[i] = 2; }
        }
    }

    _purge() {
        for (let i = this.count - 1; i >= 0; i--) {
            if (this.state[i] === 2) { this.remove(i); }
        }
    }

    step(dt, apply) {
        this._range(dt, 0, this.count, apply);
        if (++this._stepsSincePurge >= 64) { this._stepsSincePurge = 0; this._purge(); }
        return this;
    }

    async stepChunked(dt, apply) {
        const self = this;
        await _chunkedRange(this.count, this.chunkSize, this.yieldEvery, function (s, e) {
            self._range(dt, s, e, apply);
        });
        if (++this._stepsSincePurge >= 64) { this._stepsSincePurge = 0; this._purge(); }
        return this;
    }

    clear() {
        this.count = 0;
        this.state.fill(0);
        return this;
    }
}

function createSOAEasingSystem(capacity, options) { return new SOAEasingSystem(capacity, options); }

// ============================================================================
// 15. THREE.JS r185 INTEROP (duck-typed — no three import, no CDN, no build)
// ============================================================================
const _p3 = { x: 0, y: 0, z: 0 };
const _q4 = { x: 0, y: 0, z: 0, w: 1 };
const _s3 = { x: 1, y: 1, z: 1 };

function easeThreeVector3(v, from, to, t, easeFn) {
    const et = (easeFn || easings.linear)(t);
    v.set(
        from.x + (to.x - from.x) * et,
        from.y + (to.y - from.y) * et,
        from.z + (to.z - from.z) * et
    );
    return v;
}

function easeThreeQuaternion(q, from, to, t, easeFn) {
    const et = (easeFn || easings.linear)(t);
    _tmpQuat[0] = from.x; _tmpQuat[1] = from.y; _tmpQuat[2] = from.z; _tmpQuat[3] = from.w;
    const b = _tmpVec3;
    b[0] = to.x; b[1] = to.y; b[2] = to.z;
    const target = [b[0], b[1], b[2], to.w];
    quat.slerp(_tmpQuat, _tmpQuat, target, et);
    q.set(_tmpQuat[0], _tmpQuat[1], _tmpQuat[2], _tmpQuat[3]);
    return q;
}

/** Linear-working-space color ease (three r185 Color.setRGB). */
function easeThreeColor(color, from, to, t, easeFn) {
    const et = (easeFn || easings.linear)(t);
    color.setRGB(
        from.r + (to.r - from.r) * et,
        from.g + (to.g - from.g) * et,
        from.b + (to.b - from.b) * et
    );
    return color;
}

/** Write eased values into a three.js r185 BufferAttribute (itemSize 1). */
function applyEasingToAttribute(attribute, ts, ease, count) {
    const n = count === undefined ? attribute.count : count;
    const lut = (ease && ease.length !== undefined) ? ease : null;
    if (lut) {
        const m = lut.length - 1;
        for (let i = 0; i < n; i++) {
            const t = ts[i];
            let ev;
            if (t <= 0) { ev = lut[0]; }
            else if (t >= 1) { ev = lut[m]; }
            else { const x = t * m, k = x | 0; ev = lut[k] + (lut[k + 1] - lut[k]) * (x - k); }
            attribute.setX(i, ev);
        }
    } else {
        const fn = typeof ease === "function" ? ease : getEasing(ease);
        for (let i = 0; i < n; i++) { attribute.setX(i, fn(ts[i])); }
    }
    attribute.needsUpdate = true;
    return attribute;
}

/**
 * Drive a three.js r185 InstancedMesh from eased TRS SOAs (1M instances).
 * `matrix4` must be a reusable THREE.Matrix4; position / quaternion / scale
 * are optional reusable THREE objects (plain literals also work).
 */
function easeInstancedMesh(mesh, from, to, ts, easeFn, matrix4, position, quaternion, scale, count) {
    const n = count === undefined ? mesh.count : count;
    const fn = easeFn || easings.linear;
    const p = position || _p3, q = quaternion || _q4, s = scale || _s3;
    const fpx = from.position.x, fpy = from.position.y, fpz = from.position.z;
    const tpx = to.position.x, tpy = to.position.y, tpz = to.position.z;
    const fsx = from.scale.x, fsy = from.scale.y, fsz = from.scale.z;
    const tsx = to.scale.x, tsy = to.scale.y, tsz = to.scale.z;
    const fqx = from.rotation.x, fqy = from.rotation.y, fqz = from.rotation.z, fqw = from.rotation.w;
    const tqx = to.rotation.x, tqy = to.rotation.y, tqz = to.rotation.z, tqw = to.rotation.w;

    for (let i = 0; i < n; i++) {
        const et = fn(ts[i]);
        p.x = fpx[i] + (tpx[i] - fpx[i]) * et;
        p.y = fpy[i] + (tpy[i] - fpy[i]) * et;
        p.z = fpz[i] + (tpz[i] - fpz[i]) * et;
        s.x = fsx[i] + (tsx[i] - fsx[i]) * et;
        s.y = fsy[i] + (tsy[i] - fsy[i]) * et;
        s.z = fsz[i] + (tsz[i] - fsz[i]) * et;

        const ax = fqx[i], ay = fqy[i], az = fqz[i], aw = fqw[i];
        let bx = tqx[i], by = tqy[i], bz = tqz[i], bw = tqw[i];
        let cosom = ax * bx + ay * by + az * bz + aw * bw;
        if (cosom < 0) { cosom = -cosom; bx = -bx; by = -by; bz = -bz; bw = -bw; }
        let s0, s1;
        if (1 - cosom > EPSILON) {
            const omega = Math.acos(cosom), sinom = Math.sin(omega);
            s0 = Math.sin((1 - et) * omega) / sinom;
            s1 = Math.sin(et * omega) / sinom;
        } else { s0 = 1 - et; s1 = et; }
        q.x = s0 * ax + s1 * bx;
        q.y = s0 * ay + s1 * by;
        q.z = s0 * az + s1 * bz;
        q.w = s0 * aw + s1 * bw;

        matrix4.compose(p, q, s);
        mesh.setMatrixAt(i, matrix4);
    }
    if (mesh.instanceMatrix) { mesh.instanceMatrix.needsUpdate = true; }
    mesh.count = n;
    return mesh;
}

// ============================================================================
// 16. WORKER POOL — true multi-core easing (Blob URL, no server, no CDN)
// ============================================================================
const _easingWorkerSource = "(" + function () {
    const PI = Math.PI, HP = PI * 0.5, TP = PI * 2;
    const B1 = 1.70158, B2 = B1 * 1.525, B3 = B1 + 1;
    const E4 = TP / 3, E5 = TP / 4.5;

    function we(id, t) {
        switch (id) {
            case 0: return t;
            case 1: return t * t * (3 - 2 * t);
            case 2: return t * t * t * (t * (t * 6 - 15) + 10);
            case 3: return t * t;
            case 4: return t * (2 - t);
            case 5: return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
            case 6: return t * t * t;
            case 7: { const u = t - 1; return u * u * u + 1; }
            case 8: return t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1;
            case 9: return t * t * t * t;
            case 10: { const u = t - 1; return 1 - u * u * u * u; }
            case 11: { if (t < 0.5) { return 8 * t * t * t * t; } const u = t - 1; return 1 - 8 * u * u * u * u; }
            case 12: return t * t * t * t * t;
            case 13: { const u = t - 1; return u * u * u * u * u + 1; }
            case 14: { if (t < 0.5) { return 16 * t * t * t * t * t; } const u = -2 * t + 2; return 0.5 * u * u * u * u * u + 1; }
            case 15: return 1 - Math.cos(t * HP);
            case 16: return Math.sin(t * HP);
            case 17: return (1 - Math.cos(PI * t)) * 0.5;
            case 18: return t === 0 ? 0 : Math.pow(2, 10 * (t - 1));
            case 19: return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
            case 20:
                if (t === 0 || t === 1) { return t; }
                return t < 0.5 ? 0.5 * Math.pow(2, 20 * t - 10) : 1 - 0.5 * Math.pow(2, -20 * t + 10);
            case 21: return 1 - Math.sqrt(1 - t * t);
            case 22: { const u = t - 1; return Math.sqrt(1 - u * u); }
            case 23: { if (t < 0.5) { return (1 - Math.sqrt(1 - 4 * t * t)) * 0.5; } const u = -2 * t + 2; return (Math.sqrt(1 - u * u) + 1) * 0.5; }
            case 24: return B3 * t * t * t - B1 * t * t;
            case 25: { const c = B1 + 1, u = t - 1; return 1 + c * u * u * u + B1 * u * u; }
            case 26:
                if (t < 0.5) { const u = 2 * t; return 0.5 * (u * u * ((B2 + 1) * u - B2)); }
                { const v = 2 * t - 2; return 0.5 * (v * v * ((B2 + 1) * v + B2) + 2); }
            case 27:
                if (t === 0 || t === 1) { return t; }
                return -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * E4);
            case 28:
                if (t === 0 || t === 1) { return t; }
                return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * E4) + 1;
            case 29:
                if (t === 0 || t === 1) { return t; }
                if (t < 0.5) { return -0.5 * Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * E5); }
                return 0.5 * Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * E5) + 1;
            case 30: {
                const n1 = 7.5625, d1 = 2.75;
                if (t < 1 / d1) { return n1 * t * t; }
                if (t < 2 / d1) { t -= 1.5 / d1; return n1 * t * t + 0.75; }
                if (t < 2.5 / d1) { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
                t -= 2.625 / d1; return n1 * t * t + 0.984375;
            }
            case 31: {
                const w0 = Math.sqrt(100), zeta = 10 / (2 * Math.sqrt(100));
                const wd = w0 * Math.sqrt(1 - zeta * zeta);
                return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + (zeta * w0 / wd) * Math.sin(wd * t));
            }
            default: return t;
        }
    }

    self.onmessage = function (e) {
        const d = e.data, n = d.n, op = d.op, id = d.easeId;
        const ts = d.ts, a = d.a, b = d.b, vel = d.vel, p = d.params;
        const out = new Float32Array(n);
        let outVel = null;

        if (op === "apply") {
            for (let i = 0; i < n; i++) { out[i] = we(id, ts[i]); }
        } else if (op === "lerp") {
            for (let i = 0; i < n; i++) { const et = we(id, ts[i]); out[i] = a[i] + (b[i] - a[i]) * et; }
        } else if (op === "lerpT") {
            const et = we(id, p.t);
            for (let i = 0; i < n; i++) { out[i] = a[i] + (b[i] - a[i]) * et; }
        } else if (op === "spring") {
            outVel = new Float32Array(n);
            let st = p.smoothTime;
            if (st < 0.0001) { st = 0.0001; }
            const omega = 2 / st, x = omega * p.dt;
            const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
            const maxChange = (p.maxSpeed === null ? Infinity : p.maxSpeed) * st;
            const invDt = p.dt > 0 ? 1 / p.dt : 0;
            for (let i = 0; i < n; i++) {
                const c = a[i], ot = b[i];
                let t = ot, change = c - t;
                if (change > maxChange) { change = maxChange; }
                else if (change < -maxChange) { change = -maxChange; }
                t = c - change;
                const temp = (vel[i] + omega * change) * p.dt;
                let v = (vel[i] - omega * temp) * exp;
                let o = t + (change + temp) * exp;
                if ((ot - c > 0) === (o > ot)) { o = ot; v = (o - ot) * invDt; }
                out[i] = o; outVel[i] = v;
            }
        }
        const transfer = [out.buffer];
        if (outVel) { transfer.push(outVel.buffer); }
        self.postMessage({ id: d.id, out: out, vel: outVel }, transfer);
    };
}.toString() + ")();";

/**
 * Optional parallel executor for SOA easing. Custom (non-preset) curves and
 * environments without Workers / Blob URLs transparently fall back to the
 * chunked main-thread path, so a call never blocks the UI and never throws.
 * op: "apply" | "lerp" | "lerpT" | "spring".
 */
class EasingWorkerPool {
    constructor(size) {
        this._workers = [];
        this._idle = [];
        this._queue = [];
        this._pending = new Map();
        this._nextId = 1;
        this._url = null;
        this._disposed = false;

        const want = size || Math.min(4, (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 2);
        try {
            if (typeof Worker === "undefined" || typeof Blob === "undefined" ||
                typeof URL === "undefined" || !URL.createObjectURL) {
                throw new Error("workers unavailable");
            }
            this._url = URL.createObjectURL(new Blob([_easingWorkerSource], { type: "text/javascript" }));
            for (let i = 0; i < want; i++) {
                const w = new Worker(this._url);
                w.onmessage = (e) => {
                    const job = this._pending.get(e.data.id);
                    if (job) { this._pending.delete(e.data.id); job.resolve(e.data); }
                    this._idle.push(w);
                    this._dispatch();
                };
                w.onerror = () => { this._idle.push(w); this._dispatch(); };
                this._workers.push(w);
                this._idle.push(w);
            }
        } catch (e) {
            this._workers.length = 0;
            this._idle.length = 0;
            if (this._url) { URL.revokeObjectURL(this._url); this._url = null; }
        }
    }

    get size() { return this._workers.length; }

    _dispatch() {
        while (this._queue.length > 0 && this._idle.length > 0) {
            const task = this._queue.shift();
            const w = this._idle.pop();
            this._pending.set(task.msg.id, task);
            w.postMessage(task.msg, task.transfer);
        }
    }

    _runChunk(msg, transfer) {
        return new Promise((resolve, reject) => {
            this._queue.push({ msg, transfer, resolve, reject });
            this._dispatch();
        });
    }

    async _fallback(op, ts, a, b, vel, easeFn, params, out) {
        if (op === "apply") { await soaApplyChunked(out, ts, easeFn); return { out, vel: null }; }
        if (op === "lerp") { await soaApplyLerpPerTChunked(out, a, b, ts, easeFn); return { out, vel: null }; }
        if (op === "lerpT") { await soaApplyLerpChunked(out, a, b, params.t, easeFn); return { out, vel: null }; }
        await soaSpringDampBatchChunked(out, vel, b, params.smoothTime, params.dt, undefined,
            params.maxSpeed === null ? Infinity : params.maxSpeed);
        return { out, vel };
    }

    /**
     * Run an easing op over Float32Arrays.
     * `ease` may be a preset name / function; custom functions run on the
     * main thread via the chunked fallback. Resolves to { out, vel }.
     */
    async run(op, ts, a, b, vel, ease, params, out) {
        if (this._disposed) { throw new Error("EasingWorkerPool disposed"); }
        params = params || {};
        const n = op === "apply" ? ts.length : a.length;
        out = out || new Float32Array(n);
        const id = easeIdOf(ease === undefined ? "linear" : ease);
        const easeFn = typeof ease === "function" ? ease : getEasing(ease);

        if (this._workers.length === 0 || id < 0) {
            const cp = (v) => v ? (v.slice ? v.slice() : new Float32Array(v)) : null;
            return this._fallback(op, cp(ts), cp(a), cp(b), cp(vel), easeFn, params, out);
        }

        const W = this._workers.length;
        const per = Math.ceil(n / W);
        const jobs = [];
        for (let k = 0; k < W; k++) {
            const s = k * per, e = Math.min(s + per, n);
            if (s >= e) { break; }
            const msg = {
                id: this._nextId++, op, n: e - s, easeId: id, params,
                ts: ts ? ts.slice(s, e) : null,
                a: a ? a.slice(s, e) : null,
                b: b ? b.slice(s, e) : null,
                vel: vel ? vel.slice(s, e) : null
            };
            const transfer = [];
            if (msg.ts) { transfer.push(msg.ts.buffer); }
            if (msg.a) { transfer.push(msg.a.buffer); }
            if (msg.b) { transfer.push(msg.b.buffer); }
            if (msg.vel) { transfer.push(msg.vel.buffer); }
            jobs.push({ s, e, p: this._runChunk(msg, transfer) });
        }
        let outVel = null;
        for (let j = 0; j < jobs.length; j++) {
            const r = await jobs[j].p;
            out.set(r.out, jobs[j].s);
            if (r.vel) {
                if (!outVel) { outVel = vel || new Float32Array(n); }
                outVel.set(r.vel, jobs[j].s);
            }
        }
        return { out, vel: outVel };
    }

    dispose() {
        this._disposed = true;
        for (let i = 0; i < this._workers.length; i++) { this._workers[i].terminate(); }
        this._workers.length = 0;
        this._idle.length = 0;
        this._queue.length = 0;
        this._pending.clear();
        if (this._url) { URL.revokeObjectURL(this._url); this._url = null; }
    }
}

function createEasingWorkerPool(size) { return new EasingWorkerPool(size); }

// ============================================================================
// 17. MATH NAMESPACE — the provided SOA stack stays the default maths
// ============================================================================
let utils = null;

const math = {
    common, vec2, vec3, vec4, mat2,
    mat3: null, mat4, quat, quat2,
    bitecs: null, simplex: null, utils: null, easings: easings
};

/** Optional modules load dynamically; a failure never breaks this module. */
const mathReady = Promise.allSettled([
    import("./006_mat3.js").then((m) => { math.mat3 = m; }),
    import("./010_bitECS_core.js").then((m) => { math.bitecs = m; }),
    import("./013_simplex.js").then((m) => { math.simplex = m; }),
    import("./014_utils.js").then((m) => { utils = m; math.utils = m; })
]);

// ============================================================================
// 18. EXPORTS — every original export preserved + completed parallel layer
// ============================================================================
const linear = easings.linear;
const easeInQuad = easings.easeInQuad;
const easeOutQuad = easings.easeOutQuad;
const easeInOutQuad = easings.easeInOutQuad;
const easeInCubic = easings.easeInCubic;
const easeOutCubic = easings.easeOutCubic;
const easeInOutCubic = easings.easeInOutCubic;
const easeInExpo = easings.easeInExpo;
const easeOutExpo = easings.easeOutExpo;
const easeInOutExpo = easings.easeInOutExpo;
const easeOutBack = easings.easeOutBack;
const easeOutBounce = easings.easeOutBounce;
const spring = easings.spring;
const cubicBezier = easings.cubicBezier;
const easeInSine = easings.easeInSine;
const easeOutSine = easings.easeOutSine;
const easeInOutSine = easings.easeInOutSine;
const easeInCirc = easings.easeInCirc;
const easeOutCirc = easings.easeOutCirc;
const easeInOutCirc = easings.easeInOutCirc;
const easeInQuint = easings.easeInQuint;
const easeOutQuint = easings.easeOutQuint;
const easeInOutQuint = easings.easeInOutQuint;
const easeInQuart = easings.easeInQuart;
const easeOutQuart = easings.easeOutQuart;
const easeInOutQuart = easings.easeInOutQuart;
const easeInBack = easings.easeInBack;
const easeInOutBack = easings.easeInOutBack;
const easeInElastic = easings.easeInElastic;
const easeOutElastic = easings.easeOutElastic;
const easeInOutElastic = easings.easeInOutElastic;

export {
    // foundation
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC, EPSILON, yieldToMain, createPool,
    // original table + individual presets
    easings,
    linear, easeInQuad, easeOutQuad, easeInOutQuad,
    easeInCubic, easeOutCubic, easeInOutCubic,
    easeInExpo, easeOutExpo, easeInOutExpo,
    easeOutBack, easeOutBounce, spring, cubicBezier,
    easeInSine, easeOutSine, easeInOutSine,
    easeInCirc, easeOutCirc, easeInOutCirc,
    easeInQuint, easeOutQuint, easeInOutQuint,
    easeInQuart, easeOutQuart, easeInOutQuart,
    easeInBack, easeInOutBack,
    easeInElastic, easeOutElastic, easeInOutElastic,
    // CSS curves + resolver
    cubicBezierCSS, CSS_CURVES, getEasing,
    // LUT acceleration
    EASE_IDS, bakeEasingLUT, sampleLUT, getEaseLUT, easeIdOf,
    soaApplyLUT, soaApplyLUTLerp, soaApplyLUTChunked,
    // SOA apply (sync)
    soaApply, soaApplyInPlace, soaApplyLerp, soaApplyLerpPerT,
    // SOA apply (chunked async)
    soaApplyChunked, soaApplyInPlaceChunked, soaApplyLerpChunked, soaApplyLerpPerTChunked,
    // spring batch
    soaSpringDampBatch, soaSpringDampBatchChunked,
    soaSpringDamp3Batch, soaSpringDamp3BatchChunked,
    // HDR color
    easeColorRGBA, soaEaseColor, soaEaseColorChunked,
    soaEaseColorTargets, soaEaseColorTargetsChunked,
    // vector / quaternion / dual-quat / TRS easing
    soaEaseVec3, soaEaseVec3Chunked, soaEaseVec3Targets, soaEaseVec3TargetsChunked,
    soaEaseQuatSOA, soaEaseQuatSOAChunked,
    soaEaseDualQuat, soaEaseDualQuatChunked,
    soaEaseTRS, soaEaseTRSChunked,
    // stagger
    staggerEased, staggerWithEase,
    // orbital
    easeKeplerPosition, easeKeplerState,
    soaEaseKeplerPosition, soaEaseKeplerPositionChunked,
    // IK / natural motion
    easeIKTarget, easeQuat,
    // systems
    EasingSystem, createEasingSystem,
    SOAEasingSystem, createSOAEasingSystem,
    // three.js r185 interop
    easeThreeVector3, easeThreeQuaternion, easeThreeColor,
    applyEasingToAttribute, easeInstancedMesh,
    // parallelism
    EasingWorkerPool, createEasingWorkerPool,
    // namespace
    math, mathReady
};

export default {
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC, EPSILON, yieldToMain, createPool,
    easings,
    linear, easeInQuad, easeOutQuad, easeInOutQuad,
    easeInCubic, easeOutCubic, easeInOutCubic,
    easeInExpo, easeOutExpo, easeInOutExpo,
    easeOutBack, easeOutBounce, spring, cubicBezier,
    easeInSine, easeOutSine, easeInOutSine,
    easeInCirc, easeOutCirc, easeInOutCirc,
    easeInQuint, easeOutQuint, easeInOutQuint,
    easeInQuart, easeOutQuart, easeInOutQuart,
    easeInBack, easeInOutBack,
    easeInElastic, easeOutElastic, easeInOutElastic,
    cubicBezierCSS, CSS_CURVES, getEasing,
    EASE_IDS, bakeEasingLUT, sampleLUT, getEaseLUT, easeIdOf,
    soaApplyLUT, soaApplyLUTLerp, soaApplyLUTChunked,
    soaApply, soaApplyInPlace, soaApplyLerp, soaApplyLerpPerT,
    soaApplyChunked, soaApplyInPlaceChunked, soaApplyLerpChunked, soaApplyLerpPerTChunked,
    soaSpringDampBatch, soaSpringDampBatchChunked,
    soaSpringDamp3Batch, soaSpringDamp3BatchChunked,
    easeColorRGBA, soaEaseColor, soaEaseColorChunked,
    soaEaseColorTargets, soaEaseColorTargetsChunked,
    soaEaseVec3, soaEaseVec3Chunked, soaEaseVec3Targets, soaEaseVec3TargetsChunked,
    soaEaseQuatSOA, soaEaseQuatSOAChunked,
    soaEaseDualQuat, soaEaseDualQuatChunked,
    soaEaseTRS, soaEaseTRSChunked,
    staggerEased, staggerWithEase,
    easeKeplerPosition, easeKeplerState,
    soaEaseKeplerPosition, soaEaseKeplerPositionChunked,
    easeIKTarget, easeQuat,
    EasingSystem, createEasingSystem,
    SOAEasingSystem, createSOAEasingSystem,
    easeThreeVector3, easeThreeQuaternion, easeThreeColor,
    applyEasingToAttribute, easeInstancedMesh,
    EasingWorkerPool, createEasingWorkerPool,
    math, mathReady
};

// Continue with next file: src/math/016_timeline.js (keyframe tracks + pooled
// timeline scheduler — 1M-instance staggered playback, bezier track solver,
// bitECS timeline system and three.js r185 AnimationClip bridging)?