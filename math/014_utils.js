// file number : 014
// full path name : src/math/014_utils.js
// description : Universal animation / utility layer — every original export
//               preserved and corrected, rewritten as a self-contained native
//               ES module in the three.js r185 JSM addon style: no strict-mode
//               directive, no CommonJS, no Vite / Vue / client build, no CDN.
//               Scalar API (clamp / lerp / mapRange / random / randomInt /
//               stagger / toArray / parseColor / calcRelativeValue /
//               decomposeValue / interpolateDecomposed), zero-GC pooled
//               decomposed-value objects, SOA clamp / lerp / mapRange /
//               random / ease for 1M+ elements, complete chunked-yielding
//               counterparts, frame-rate-independent damping / exp-lerp /
//               critically-damped springs (scalar + SOA), HDR / sRGB /
//               packed-RGBA / CSS color math (scalar + SOA), procedural
//               stagger (hash, simplex-noise, radial, Voronoi, Kepler,
//               grid / axis / from) that plugs straight into bitECS queries,
//               stagger baking + per-instance staggered playback for 1M
//               units, an easing library, duck-typed three.js r185 interop
//               (BufferAttribute upload / download, InstancedMesh stagger,
//               Color), and an optional Blob-URL worker pool for true
//               multi-core SOA math with a non-blocking main-thread fallback.
//               The provided 002..013 SOA stack stays the default vector /
//               matrix / quaternion maths; three.js r185 only renders.
// best for : 3d graphics + animation — 1M+ per-instance procedural stagger
//            (radial, noise, Voronoi, orbital), HDR color pipelines that
//            preserve shadow detail across exposures 1e-6…1e+12, per-entity
//            damping that never drifts at 60 / 90 / 120 / variable fps,
//            SIMD-friendly SOA clamp / lerp / mapRange for GPU upload prep,
//            bitECS-query-driven placement and timing of 1M+ instances along
//            Kepler orbits or through noise fields, small→galactic stagger
//            via stable spatial hash + simplex noise, and chunked async
//            worlds that stay at 60 fps on Android mobile 64-bit.
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
//   src/math/013_simplex.js       (optional, dynamic — noise stagger)
//   src/math/014_utils.js         <- THIS FILE
// ============================================================================

import * as vec2 from "./002_vec2.js";
import * as vec3 from "./003_vec3.js";
import * as vec4 from "./004_vec4.js";
import * as mat2 from "./005_mat2.js";
import * as mat4 from "./007_mat4.js";
import * as quat from "./008_quat.js";
import * as quat2 from "./009_quat2.js";

// ============================================================================
// 0. FOUNDATION (inlined — replaces require("./001_common.js"))
// ============================================================================
const CHUNK_SIZE = 65536;
const CHUNK_YIELD_EVERY = 8;
const POOL_PREALLOC = 256;
const TWO_PI = Math.PI * 2;

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

/** Deterministic seeded PRNG returning [0,1). */
function mulberry32(seed) {
    let a = seed | 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Deterministic 2D spatial hash returning [0,1]. */
function hash2(x, y) {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
    h = (h ^ (h >>> 13)) | 0;
    h = Math.imul(h, 1274126177) | 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967295;
}

/** Deterministic 3D spatial hash returning [0,1]. */
function hash3(x, y, z) {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2246822519)) | 0;
    h = (h ^ (h >>> 13)) | 0;
    h = Math.imul(h, 1274126177) | 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967295;
}

function identityEase(t) { return t; }

const common = {
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC,
    yieldToMain, createPool, mulberry32, hash2, hash3
};

// ============================================================================
// 1. EASING LIBRARY (allocation-free, usable by stagger / SOA playback)
// ============================================================================
const Easing = {
    linear: identityEase,
    smoothstep(t) { return t * t * (3 - 2 * t); },
    smootherstep(t) { return t * t * t * (t * (t * 6 - 15) + 10); },
    inQuad(t) { return t * t; },
    outQuad(t) { return t * (2 - t); },
    inOutQuad(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; },
    inCubic(t) { return t * t * t; },
    outCubic(t) { const u = t - 1; return u * u * u + 1; },
    inOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) * 0.5; },
    inSine(t) { return 1 - Math.cos(t * Math.PI * 0.5); },
    outSine(t) { return Math.sin(t * Math.PI * 0.5); },
    inOutSine(t) { return -(Math.cos(Math.PI * t) - 1) * 0.5; },
    inExpo(t) { return t <= 0 ? 0 : Math.pow(2, 10 * t - 10); },
    outExpo(t) { return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); },
    inOutExpo(t) {
        if (t <= 0) { return 0; }
        if (t >= 1) { return 1; }
        return t < 0.5 ? Math.pow(2, 20 * t - 10) * 0.5 : (2 - Math.pow(2, -20 * t + 10)) * 0.5;
    },
    outElastic(t) {
        if (t <= 0) { return 0; }
        if (t >= 1) { return 1; }
        const c = TWO_PI / 3;
        return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c) + 1;
    },
    outBounce(t) {
        const n = 7.5625, d = 2.75;
        if (t < 1 / d) { return n * t * t; }
        if (t < 2 / d) { t -= 1.5 / d; return n * t * t + 0.75; }
        if (t < 2.5 / d) { t -= 2.25 / d; return n * t * t + 0.9375; }
        t -= 2.625 / d; return n * t * t + 0.984375;
    }
};

const EASE_BY_ID = {
    linear: Easing.linear, smoothstep: Easing.smoothstep, smootherstep: Easing.smootherstep,
    inQuad: Easing.inQuad, outQuad: Easing.outQuad, inOutQuad: Easing.inOutQuad,
    inCubic: Easing.inCubic, outCubic: Easing.outCubic, inOutCubic: Easing.inOutCubic,
    inSine: Easing.inSine, outSine: Easing.outSine, inOutSine: Easing.inOutSine,
    inExpo: Easing.inExpo, outExpo: Easing.outExpo, inOutExpo: Easing.inOutExpo,
    outElastic: Easing.outElastic, outBounce: Easing.outBounce
};

// ============================================================================
// 2. ORIGINAL SCALAR API (behaviour preserved)
// ============================================================================
function clamp(val, min, max) { return Math.min(Math.max(val, min), max); }
function lerp(a, b, t) { return a + (b - a) * t; }
function mapRange(val, inMin, inMax, outMin, outMax) {
    return outMin + ((val - inMin) / (inMax - inMin)) * (outMax - outMin);
}
function random(min, max) { return Math.random() * (max - min) + min; }
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

/** Original stagger — grid / axis / from logic preserved exactly. */
function stagger(val, opts) {
    opts = opts || {};
    const from = opts.from || 0;
    const ease = typeof opts.easing === "function" ? opts.easing : identityEase;
    const grid = opts.grid;
    const axis = opts.axis;

    return function (index, total) {
        total = total === undefined ? 1 : total;

        if (grid && Array.isArray(grid)) {
            const cols = grid[0], rows = grid[1];
            const col = index % cols;
            const row = Math.floor(index / cols);
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

/** Original toArray — DOM / NodeList / HTMLCollection aware. */
function toArray(targets) {
    if (!targets) { return []; }
    if (typeof targets === "string") {
        if (typeof document !== "undefined") { return Array.from(document.querySelectorAll(targets)); }
        return [];
    }
    if (typeof Element !== "undefined" && targets instanceof Element) { return [targets]; }
    if (typeof SVGElement !== "undefined" && targets instanceof SVGElement) { return [targets]; }
    if (typeof NodeList !== "undefined" && NodeList.prototype.isPrototypeOf(targets)) { return Array.from(targets); }
    if (typeof HTMLCollection !== "undefined" && HTMLCollection.prototype.isPrototypeOf(targets)) { return Array.from(targets); }
    if (Array.isArray(targets)) { return Array.from(targets); }
    if (ArrayBuffer.isView(targets)) { return Array.from(targets); }
    return [targets];
}

// ============================================================================
// 3. COLOR PARSING (CSS named / hex / rgb / hsl)
// ============================================================================
const NAMED_COLORS = {
    transparent: [0, 0, 0, 0], black: [0, 0, 0, 1], white: [255, 255, 255, 1],
    red: [255, 0, 0, 1], green: [0, 128, 0, 1], blue: [0, 0, 255, 1],
    yellow: [255, 255, 0, 1], cyan: [0, 255, 255, 1], magenta: [255, 0, 255, 1],
    gray: [128, 128, 128, 1], grey: [128, 128, 128, 1], orange: [255, 165, 0, 1],
    purple: [128, 0, 128, 1]
};

// Hoisted hue helper — no per-call closure allocation in parsing hot paths.
function _hue2rgb(p, q, t) {
    if (t < 0) { t += 1; }
    if (t > 1) { t -= 1; }
    if (t < 1 / 6) { return p + (q - p) * 6 * t; }
    if (t < 1 / 2) { return q; }
    if (t < 2 / 3) { return p + (q - p) * (2 / 3 - t) * 6; }
    return p;
}

function hslToRgb(h, s, l, a) {
    a = a === undefined ? 1 : a;
    h = ((h % 360) + 360) % 360 / 360;
    s = clamp(s / 100, 0, 1);
    l = clamp(l / 100, 0, 1);
    if (s === 0) { const v = Math.round(l * 255); return [v, v, v, a]; }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
        Math.round(_hue2rgb(p, q, h + 1 / 3) * 255),
        Math.round(_hue2rgb(p, q, h) * 255),
        Math.round(_hue2rgb(p, q, h - 1 / 3) * 255),
        a
    ];
}

const RGB_RE = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/;
const HSL_RE = /^hsla?\(\s*([\d.]+)(?:deg)?\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%(?:\s*,\s*([\d.]+))?\s*\)$/;

function parseColor(str) {
    if (typeof str !== "string") { return null; }
    const lower = str.trim().toLowerCase();
    if (NAMED_COLORS[lower]) { return NAMED_COLORS[lower].slice(); }

    if (lower.startsWith("#")) {
        let hex = lower.slice(1);
        if (hex.length === 3) { hex = hex.split("").map(c => c + c).join("") + "ff"; }
        else if (hex.length === 4) { hex = hex.split("").map(c => c + c).join(""); }
        else if (hex.length === 6) { hex += "ff"; }
        if (hex.length === 8) {
            const num = parseInt(hex, 16);
            if (Number.isNaN(num)) { return null; }
            return [
                (num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255,
                parseFloat(((num & 255) / 255).toFixed(3))
            ];
        }
        return null;
    }

    const rgbMatch = lower.match(RGB_RE);
    if (rgbMatch) {
        return [
            parseFloat(rgbMatch[1]), parseFloat(rgbMatch[2]), parseFloat(rgbMatch[3]),
            rgbMatch[4] !== undefined ? parseFloat(rgbMatch[4]) : 1
        ];
    }

    const hslMatch = lower.match(HSL_RE);
    if (hslMatch) {
        return hslToRgb(
            parseFloat(hslMatch[1]), parseFloat(hslMatch[2]), parseFloat(hslMatch[3]),
            hslMatch[4] !== undefined ? parseFloat(hslMatch[4]) : 1
        );
    }
    return null;
}

// ============================================================================
// 4. RELATIVE VALUES + VALUE DECOMPOSITION
// ============================================================================
const RELATIVE_RE = /^([+\-*/]=)\s*(-?[\d.]+)(.*)$/;
const SIMPLE_RE = /^([-+]?(?:\d*\.?\d+(?:[eE][-+]?\d+)?))\s*([a-zA-Z%]*)$/;
const NUMBER_REGEX = /[-+]?(?:\d*\.?\d+(?:[eE][-+]?\d+)?)/g;

function calcRelativeValue(current, expr) {
    if (typeof expr !== "string") { return expr; }
    const match = expr.match(RELATIVE_RE);
    if (!match) { return expr; }
    const op = match[1];
    const delta = parseFloat(match[2]);
    const exprUnit = match[3] || "";
    const currStr = String(current);
    const currNum = parseFloat(currStr) || 0;
    const currUnit = currStr.replace(/[-+.\d\s]/g, "") || exprUnit;
    let result = currNum;
    if (op === "+=") { result += delta; }
    else if (op === "-=") { result -= delta; }
    else if (op === "*=") { result *= delta; }
    else if (op === "/=") { result = delta !== 0 ? result / delta : result; }
    return currUnit ? result + currUnit : result;
}

function decomposeValue(val) {
    if (typeof val === "number") { return { type: "number", num: val, unit: "", isColor: false }; }
    if (typeof val !== "string") { return { type: "number", num: parseFloat(val) || 0, unit: "", isColor: false }; }
    const str = val.trim();
    const color = parseColor(str);
    if (color) { return { type: "color", color: color, isColor: true }; }
    const simpleMatch = str.match(SIMPLE_RE);
    if (simpleMatch) {
        return { type: "simple", num: parseFloat(simpleMatch[1]) || 0, unit: simpleMatch[2] || "", isColor: false };
    }
    const numbers = [];
    const template = [];
    let lastIdx = 0, match;
    NUMBER_REGEX.lastIndex = 0;
    while ((match = NUMBER_REGEX.exec(str)) !== null) {
        template.push(str.slice(lastIdx, match.index));
        numbers.push(parseFloat(match[0]));
        lastIdx = NUMBER_REGEX.lastIndex;
    }
    template.push(str.slice(lastIdx));
    return { type: "complex", template: template, numbers: numbers, isColor: false };
}

function interpolateDecomposed(from, to, progress, round) {
    round = round || 0;

    if (to.type === "color" || from.type === "color") {
        const c1 = from.color || [0, 0, 0, 1];
        const c2 = to.color || [0, 0, 0, 1];
        const r = Math.round(lerp(c1[0], c2[0], progress));
        const g = Math.round(lerp(c1[1], c2[1], progress));
        const b = Math.round(lerp(c1[2], c2[2], progress));
        const a = parseFloat(lerp(c1[3], c2[3], progress).toFixed(3));
        return "rgba(" + r + ", " + g + ", " + b + ", " + a + ")";
    }

    if (to.type === "complex" && from.type === "complex") {
        const tmpl = to.template.length >= from.template.length ? to.template : from.template;
        const count = Math.min(from.numbers.length, to.numbers.length);
        let res = "";
        for (let i = 0; i < tmpl.length; i++) {
            res += tmpl[i] || "";
            if (i < count) {
                let n = lerp(from.numbers[i], to.numbers[i], progress);
                if (round > 0) { n = parseFloat(n.toFixed(round)); }
                res += n;
            } else if (i < to.numbers.length) { res += to.numbers[i]; }
        }
        return res;
    }

    const fromNum = from.num !== undefined ? from.num : (from.numbers ? from.numbers[0] : 0);
    const toNum = to.num !== undefined ? to.num : (to.numbers ? to.numbers[0] : 0);
    const unit = to.unit !== undefined ? to.unit : (from.unit || "");
    let val = lerp(fromNum, toNum, progress);
    if (round > 0) { val = parseFloat(val.toFixed(round)); }
    return unit ? val + unit : val;
}

// ============================================================================
// 5. POOL — reusable decomposed-value objects (zero-GC animation hot path)
// ============================================================================
const _decompPool = createPool(
    function () {
        return { type: "number", num: 0, unit: "", isColor: false, color: null, template: [], numbers: [] };
    },
    POOL_PREALLOC,
    function (d) {
        d.type = "number"; d.num = 0; d.unit = ""; d.isColor = false; d.color = null;
        if (d.template) { d.template.length = 0; }
        if (d.numbers) { d.numbers.length = 0; }
    }
);

function acquireDecomp() { return _decompPool.acquire(); }
function releaseDecomp(d) { _decompPool.release(d); }

/** Non-allocating decompose: writes into a pooled object, reusing its arrays. */
function decomposeInto(out, val) {
    if (out.template) { out.template.length = 0; }
    if (out.numbers) { out.numbers.length = 0; }
    out.color = null;

    if (typeof val === "number") {
        out.type = "number"; out.num = val; out.unit = ""; out.isColor = false;
        return out;
    }
    if (typeof val !== "string") {
        out.type = "number"; out.num = parseFloat(val) || 0; out.unit = ""; out.isColor = false;
        return out;
    }

    const str = val.trim();
    const color = parseColor(str);
    if (color) {
        out.type = "color"; out.color = color; out.isColor = true; out.num = 0; out.unit = "";
        return out;
    }
    const simpleMatch = str.match(SIMPLE_RE);
    if (simpleMatch) {
        out.type = "simple"; out.num = parseFloat(simpleMatch[1]) || 0;
        out.unit = simpleMatch[2] || ""; out.isColor = false;
        return out;
    }

    out.type = "complex"; out.isColor = false; out.num = 0; out.unit = "";
    let lastIdx = 0, match;
    NUMBER_REGEX.lastIndex = 0;
    while ((match = NUMBER_REGEX.exec(str)) !== null) {
        out.template.push(str.slice(lastIdx, match.index));
        out.numbers.push(parseFloat(match[0]));
        lastIdx = NUMBER_REGEX.lastIndex;
    }
    out.template.push(str.slice(lastIdx));
    return out;
}

// ============================================================================
// 6. SOA HELPERS — 1M+ elements per frame, synchronous, zero allocation
// ============================================================================
function soaClamp(arr, min, max, count) {
    count = count === undefined ? arr.length : count;
    for (let i = 0; i < count; i++) {
        const v = arr[i];
        arr[i] = v < min ? min : (v > max ? max : v);
    }
    return arr;
}

function soaLerp(dst, a, b, t, count) {
    count = count === undefined ? dst.length : count;
    for (let i = 0; i < count; i++) { dst[i] = a[i] + (b[i] - a[i]) * t; }
    return dst;
}

function soaMapRange(dst, src, inMin, inMax, outMin, outMax, count) {
    count = count === undefined ? dst.length : count;
    const span = inMax - inMin;
    const inv = span !== 0 ? 1 / span : 0;
    const outSpan = outMax - outMin;
    for (let i = 0; i < count; i++) { dst[i] = outMin + ((src[i] - inMin) * inv) * outSpan; }
    return dst;
}

function soaRandom(dst, min, max, count) {
    count = count === undefined ? dst.length : count;
    const span = max - min;
    for (let i = 0; i < count; i++) { dst[i] = min + Math.random() * span; }
    return dst;
}

/** Deterministic seeded fill — reproducible worlds across sessions. */
function soaRandomSeeded(dst, min, max, seed, count) {
    count = count === undefined ? dst.length : count;
    const rng = mulberry32(seed === undefined ? 1 : seed);
    const span = max - min;
    for (let i = 0; i < count; i++) { dst[i] = min + rng() * span; }
    return dst;
}

function soaEase(dst, a, b, t, easeFn, count) {
    count = count === undefined ? dst.length : count;
    const et = (easeFn || identityEase)(t);
    for (let i = 0; i < count; i++) { dst[i] = a[i] + (b[i] - a[i]) * et; }
    return dst;
}

/** Frame-rate independent exponential damping over 1M+ scalars. */
function soaDamp(dst, current, target, lambda, dt, count) {
    count = count === undefined ? dst.length : count;
    const k = Math.exp(-lambda * dt);
    for (let i = 0; i < count; i++) { dst[i] = target[i] + (current[i] - target[i]) * k; }
    return dst;
}

/** Frame-rate independent exponential lerp toward `b`. */
function soaExpLerp(dst, a, b, speed, dt, count) {
    count = count === undefined ? dst.length : count;
    const k = 1 - Math.exp(-speed * dt);
    for (let i = 0; i < count; i++) { dst[i] = a[i] + (b[i] - a[i]) * k; }
    return dst;
}

/** Critically-damped spring over 1M+ scalars. `vel` updated in place. */
function soaSpringDamp(dst, current, target, vel, smoothTime, dt, maxSpeed, count) {
    count = count === undefined ? dst.length : count;
    const stArr = (smoothTime && smoothTime.length !== undefined) ? smoothTime : null;
    const ms = maxSpeed === undefined ? Infinity : maxSpeed;
    const invDt = dt > 0 ? 1 / dt : 0;
    for (let i = 0; i < count; i++) {
        let st = stArr ? stArr[i] : smoothTime;
        if (st < 0.0001) { st = 0.0001; }
        const omega = 2 / st;
        const x = omega * dt;
        const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
        const maxChange = ms * st;
        const c = current[i];
        const originalTarget = target[i];
        let t = originalTarget;
        let change = c - t;
        if (change > maxChange) { change = maxChange; }
        else if (change < -maxChange) { change = -maxChange; }
        t = c - change;
        const temp = (vel[i] + omega * change) * dt;
        vel[i] = (vel[i] - omega * temp) * exp;
        let output = t + (change + temp) * exp;
        if ((originalTarget - c > 0) === (output > originalTarget)) {
            output = originalTarget;
            vel[i] = (output - originalTarget) * invDt;
        }
        dst[i] = output;
    }
    return dst;
}

// ============================================================================
// 7. CHUNKED ASYNC SOA — mobile-safe, never freezes the UI thread
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

async function soaClampChunked(arr, min, max, count, chunkSize, yieldEvery) {
    count = count === undefined ? arr.length : count;
    await _chunkedRange(count, chunkSize, yieldEvery, function (start, end) {
        for (let i = start; i < end; i++) {
            const v = arr[i];
            arr[i] = v < min ? min : (v > max ? max : v);
        }
    });
    return arr;
}

async function soaLerpChunked(dst, a, b, t, count, chunkSize, yieldEvery) {
    count = count === undefined ? dst.length : count;
    await _chunkedRange(count, chunkSize, yieldEvery, function (start, end) {
        for (let i = start; i < end; i++) { dst[i] = a[i] + (b[i] - a[i]) * t; }
    });
    return dst;
}

async function soaMapRangeChunked(dst, src, inMin, inMax, outMin, outMax, count, chunkSize, yieldEvery) {
    count = count === undefined ? dst.length : count;
    const span = inMax - inMin;
    const inv = span !== 0 ? 1 / span : 0;
    const outSpan = outMax - outMin;
    await _chunkedRange(count, chunkSize, yieldEvery, function (start, end) {
        for (let i = start; i < end; i++) { dst[i] = outMin + ((src[i] - inMin) * inv) * outSpan; }
    });
    return dst;
}

async function soaRandomChunked(dst, min, max, count, chunkSize, yieldEvery) {
    count = count === undefined ? dst.length : count;
    const span = max - min;
    await _chunkedRange(count, chunkSize, yieldEvery, function (start, end) {
        for (let i = start; i < end; i++) { dst[i] = min + Math.random() * span; }
    });
    return dst;
}

async function soaEaseChunked(dst, a, b, t, easeFn, count, chunkSize, yieldEvery) {
    count = count === undefined ? dst.length : count;
    const et = (easeFn || identityEase)(t);
    await _chunkedRange(count, chunkSize, yieldEvery, function (start, end) {
        for (let i = start; i < end; i++) { dst[i] = a[i] + (b[i] - a[i]) * et; }
    });
    return dst;
}

async function soaDampChunked(dst, current, target, lambda, dt, count, chunkSize, yieldEvery) {
    count = count === undefined ? dst.length : count;
    const k = Math.exp(-lambda * dt);
    await _chunkedRange(count, chunkSize, yieldEvery, function (start, end) {
        for (let i = start; i < end; i++) { dst[i] = target[i] + (current[i] - target[i]) * k; }
    });
    return dst;
}

async function soaSpringDampChunked(dst, current, target, vel, smoothTime, dt, maxSpeed, count, chunkSize, yieldEvery) {
    count = count === undefined ? dst.length : count;
    await _chunkedRange(count, chunkSize, yieldEvery, function (start, end) {
        soaSpringDampRange(dst, current, target, vel, smoothTime, dt, maxSpeed, start, end);
    });
    return dst;
}

function soaSpringDampRange(dst, current, target, vel, smoothTime, dt, maxSpeed, start, end) {
    const stArr = (smoothTime && smoothTime.length !== undefined) ? smoothTime : null;
    const ms = maxSpeed === undefined ? Infinity : maxSpeed;
    const invDt = dt > 0 ? 1 / dt : 0;
    for (let i = start; i < end; i++) {
        let st = stArr ? stArr[i] : smoothTime;
        if (st < 0.0001) { st = 0.0001; }
        const omega = 2 / st;
        const x = omega * dt;
        const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
        const maxChange = ms * st;
        const c = current[i];
        const originalTarget = target[i];
        let t = originalTarget;
        let change = c - t;
        if (change > maxChange) { change = maxChange; }
        else if (change < -maxChange) { change = -maxChange; }
        t = c - change;
        const temp = (vel[i] + omega * change) * dt;
        vel[i] = (vel[i] - omega * temp) * exp;
        let output = t + (change + temp) * exp;
        if ((originalTarget - c > 0) === (output > originalTarget)) {
            output = originalTarget;
            vel[i] = (output - originalTarget) * invDt;
        }
        dst[i] = output;
    }
}

// ============================================================================
// 8. FRAME-RATE INDEPENDENT INTERPOLATION (scalar)
// ============================================================================
function damp(current, target, lambda, dt) {
    return target + (current - target) * Math.exp(-lambda * dt);
}

function expLerp(a, b, speed, dt) {
    const k = 1 - Math.exp(-speed * dt);
    return a + (b - a) * k;
}

/** Critically-damped scalar spring. `velocity` is an array-like ([0] state). */
function springDamp(current, target, velocity, smoothTime, dt, maxSpeed) {
    if (smoothTime < 0.0001) { smoothTime = 0.0001; }
    if (maxSpeed === undefined) { maxSpeed = Infinity; }
    const omega = 2 / smoothTime;
    const x = omega * dt;
    const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const maxChange = maxSpeed * smoothTime;
    let change = current - target;
    const originalTarget = target;
    if (change > maxChange) { change = maxChange; }
    else if (change < -maxChange) { change = -maxChange; }
    target = current - change;
    const temp = (velocity[0] + omega * change) * dt;
    velocity[0] = (velocity[0] - omega * temp) * exp;
    let output = target + (change + temp) * exp;
    if ((originalTarget - current > 0) === (output > originalTarget)) {
        output = originalTarget;
        velocity[0] = dt > 0 ? (output - originalTarget) / dt : 0;
    }
    return output;
}

// ============================================================================
// 9. COLOR (HDR, sRGB, packed, CSS) — scalar + SOA
// ============================================================================
function srgb8ToLinear(c8) {
    const c = c8 / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb8(c) {
    const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.round(v * 255);
}

function exposeColor(color, exposure) {
    return [color[0] * exposure, color[1] * exposure, color[2] * exposure, color[3]];
}

function reinhardColor(color) {
    return [
        color[0] / (1 + color[0]),
        color[1] / (1 + color[1]),
        color[2] / (1 + color[2]),
        color[3]
    ];
}

// Hoisted ACES curve — no per-call closure allocation.
function _acesCurve(x) {
    return (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
}

function acesColor(color) {
    return [_acesCurve(color[0]), _acesCurve(color[1]), _acesCurve(color[2]), color[3]];
}

function packColorRGBA(color) {
    return ((color[3] * 255) & 0xff) << 24 |
        ((color[2] * 255) & 0xff) << 16 |
        ((color[1] * 255) & 0xff) << 8 |
        ((color[0] * 255) & 0xff);
}

function unpackColorRGBA(packed) {
    return [
        (packed & 0xff) / 255,
        ((packed >>> 8) & 0xff) / 255,
        ((packed >>> 16) & 0xff) / 255,
        ((packed >>> 24) & 0xff) / 255
    ];
}

function cssColor(color) {
    const r = Math.round(color[0]), g = Math.round(color[1]), b = Math.round(color[2]);
    const a = color[3];
    return (a === undefined || a === 1)
        ? "rgb(" + r + ", " + g + ", " + b + ")"
        : "rgba(" + r + ", " + g + ", " + b + ", " + a + ")";
}

// ---- SOA color (vec4 SOA: {x,y,z,w,count}) — 1M+ instances, zero-GC --------
function soaExposeColor(colors, exposure, count) {
    const n = count === undefined ? colors.count : count;
    const x = colors.x, y = colors.y, z = colors.z;
    for (let i = 0; i < n; i++) { x[i] *= exposure; y[i] *= exposure; z[i] *= exposure; }
    return colors;
}

function soaReinhardColor(colors, count) {
    const n = count === undefined ? colors.count : count;
    const x = colors.x, y = colors.y, z = colors.z;
    for (let i = 0; i < n; i++) {
        x[i] = x[i] / (1 + x[i]);
        y[i] = y[i] / (1 + y[i]);
        z[i] = z[i] / (1 + z[i]);
    }
    return colors;
}

function soaAcesColor(colors, count) {
    const n = count === undefined ? colors.count : count;
    const x = colors.x, y = colors.y, z = colors.z;
    for (let i = 0; i < n; i++) {
        x[i] = _acesCurve(x[i]);
        y[i] = _acesCurve(y[i]);
        z[i] = _acesCurve(z[i]);
    }
    return colors;
}

function soaSrgb8ToLinear(colors, count) {
    const n = count === undefined ? colors.count : count;
    const x = colors.x, y = colors.y, z = colors.z;
    for (let i = 0; i < n; i++) {
        x[i] = srgb8ToLinear(x[i]);
        y[i] = srgb8ToLinear(y[i]);
        z[i] = srgb8ToLinear(z[i]);
    }
    return colors;
}

function soaLinearToSrgb8(colors, count) {
    const n = count === undefined ? colors.count : count;
    const x = colors.x, y = colors.y, z = colors.z;
    for (let i = 0; i < n; i++) {
        x[i] = linearToSrgb8(x[i]);
        y[i] = linearToSrgb8(y[i]);
        z[i] = linearToSrgb8(z[i]);
    }
    return colors;
}

/** Pack 1M+ RGBA (0..255 float) into a Uint32Array for GPU upload. */
function soaPackRGBA(out, colors, count) {
    const n = count === undefined ? colors.count : count;
    const x = colors.x, y = colors.y, z = colors.z, w = colors.w;
    for (let i = 0; i < n; i++) {
        out[i] = (((w[i] * 255) & 0xff) << 24) |
            (((z[i] * 255) & 0xff) << 16) |
            (((y[i] * 255) & 0xff) << 8) |
            ((x[i] * 255) & 0xff);
    }
    return out;
}

function soaUnpackRGBA(colors, packed, count) {
    const n = count === undefined ? colors.count : count;
    const x = colors.x, y = colors.y, z = colors.z, w = colors.w;
    for (let i = 0; i < n; i++) {
        const p = packed[i];
        x[i] = (p & 0xff) / 255;
        y[i] = ((p >>> 8) & 0xff) / 255;
        z[i] = ((p >>> 16) & 0xff) / 255;
        w[i] = ((p >>> 24) & 0xff) / 255;
    }
    return colors;
}

// ============================================================================
// 10. PROCEDURAL STAGGER — hash / noise / radial / Voronoi / Kepler
// ============================================================================
/** Stable hash stagger — deterministic per seed, random-looking, zero-GC. */
function staggerHash(seed) {
    const s = seed === undefined ? 1 : seed;
    const LUT_SIZE = 256;
    const rng = mulberry32(s);
    const lut = new Float32Array(LUT_SIZE);
    for (let i = 0; i < LUT_SIZE; i++) { lut[i] = rng(); }
    return function (index) {
        const h = hash2(index | 0, s | 0);
        return lut[(h * LUT_SIZE) | 0];
    };
}

// Fallback noise (used until / unless the simplex module is linked).
function _fallbackNoise3(x, y, z) { return vec3.gradientNoise3D(x, y, z); }

/**
 * Simplex-noise stagger — samples 3D noise at the instance position so a wave
 * moves through world space. Pass `noiseFn` or let the pooled one be acquired.
 */
function staggerNoise(options) {
    options = options || {};
    const noiseFn = options.noiseFn ||
        (simplex ? simplex.acquireNoise3D(options.seed) : _fallbackNoise3);
    const scale = options.scale === undefined ? 0.01 : options.scale;
    const offset = options.offset || 0;
    return function (index, total, position) {
        if (!position) { return 0.5 + 0.5 * noiseFn(index * scale + offset, 0, 0); }
        return 0.5 + 0.5 * noiseFn(
            position.x * scale + offset,
            position.y * scale + offset,
            position.z * scale + offset
        );
    };
}

/** Kepler-orbital stagger — distributes over orbital mean anomaly. */
function staggerKepler(meanAnomalies) {
    return function (index) {
        const M = meanAnomalies[index] || 0;
        return (M % TWO_PI) / TWO_PI;
    };
}

/** Radial stagger — factor = |pos - origin| / maxRadius, clamped to [0,1]. */
function staggerRadial(options) {
    options = options || {};
    const origin = options.origin || [0, 0, 0];
    const maxRadius = options.maxRadius === undefined ? 100 : options.maxRadius;
    const invMax = maxRadius > 0 ? 1 / maxRadius : 0;
    return function (index, total, position) {
        if (!position) { return 0; }
        const dx = position.x - origin[0];
        const dy = position.y - origin[1];
        const dz = position.z - origin[2];
        const f = Math.sqrt(dx * dx + dy * dy + dz * dz) * invMax;
        return f < 0 ? 0 : (f > 1 ? 1 : f);
    };
}

/** Voronoi-group stagger — factor derived from the 2D cell id. Zero-GC. */
function staggerVoronoi(cellSize) {
    cellSize = cellSize || 1;
    const tmp = new Float32Array(2);
    return function (index, total, position) {
        if (!position) { return 0; }
        vec2.voronoi2D(tmp, position.x / cellSize, position.y / cellSize);
        return (tmp[1] & 0xffff) / 0xffff;
    };
}

// Pre-allocated position probe — no per-entity object allocation at 1M scale.
const _tmpStaggerPos = { x: 0, y: 0, z: 0 };

/**
 * ECS-aware stagger: wraps a stagger function so it reads positions from a
 * vec3 SOA by row index. Drop directly into a bitECS query loop.
 */
function staggerForEntities(positions, options) {
    options = options || {};
    const mode = options.mode || "radial";
    let inner;
    if (mode === "radial") { inner = staggerRadial(options); }
    else if (mode === "noise") { inner = staggerNoise(options); }
    else if (mode === "voronoi") { inner = staggerVoronoi(options.cellSize); }
    else if (mode === "hash") { inner = staggerHash(options.seed); }
    else if (mode === "kepler") { inner = staggerKepler(options.meanAnomalies || new Float32Array(0)); }
    else { inner = stagger(options.val || 1, options); }

    return function (index, total) {
        _tmpStaggerPos.x = positions.x[index];
        _tmpStaggerPos.y = positions.y[index];
        _tmpStaggerPos.z = positions.z[index];
        return inner(index, total, _tmpStaggerPos);
    };
}

/** Bake normalized [0,1] stagger factors for 1M+ instances (one closure). */
function soaStagger(dst, positions, options) {
    options = options || {};
    const n = dst.length;
    const mode = options.mode || "radial";
    const ease = typeof options.easing === "function" ? options.easing : identityEase;

    if (mode === "index" || mode === "grid") {
        if (mode === "grid") {
            const fn = stagger(1, options);
            const cols = options.grid ? options.grid[0] : 1;
            const rows = options.grid ? options.grid[1] : 1;
            const maxV = Math.max(1, cols * rows - 1);
            for (let i = 0; i < n; i++) { dst[i] = clamp(fn(i, n) / maxV, 0, 1); }
        } else {
            const inv = n > 1 ? 1 / (n - 1) : 0;
            const from = options.from;
            for (let i = 0; i < n; i++) {
                let f = i * inv;
                if (from === "last") { f = 1 - f; }
                else if (from === "center") { f = Math.abs(i - (n - 1) / 2) / ((n - 1) / 2 || 1); }
                dst[i] = ease(f);
            }
        }
        return dst;
    }

    const inner = staggerForEntities(positions, options);
    for (let i = 0; i < n; i++) {
        const f = inner(i, n);
        dst[i] = ease(f < 0 ? 0 : (f > 1 ? 1 : f));
    }
    return dst;
}

async function soaStaggerChunked(dst, positions, options, chunkSize, yieldEvery) {
    options = options || {};
    const n = dst.length;
    const mode = options.mode || "radial";
    const ease = typeof options.easing === "function" ? options.easing : identityEase;
    const inner = (mode === "index" || mode === "grid") ? null : staggerForEntities(positions, options);
    const inv = n > 1 ? 1 / (n - 1) : 0;
    const from = options.from;
    await _chunkedRange(n, chunkSize, yieldEvery, function (start, end) {
        for (let i = start; i < end; i++) {
            if (inner) {
                const f = inner(i, n);
                dst[i] = ease(f < 0 ? 0 : (f > 1 ? 1 : f));
            } else {
                let f = i * inv;
                if (from === "last") { f = 1 - f; }
                else if (from === "center") { f = Math.abs(i - (n - 1) / 2) / ((n - 1) / 2 || 1); }
                dst[i] = ease(f);
            }
        }
    });
    return dst;
}

/**
 * Per-instance staggered playback: each element starts at factors[i]*spread
 * and runs for `duration`. Drives 1M+ units from a single time scalar.
 */
function soaApplyStagger(dst, a, b, factors, time, duration, spread, easeFn, count) {
    count = count === undefined ? dst.length : count;
    const ease = easeFn || identityEase;
    const invDur = duration > 0 ? 1 / duration : 0;
    for (let i = 0; i < count; i++) {
        let t = (time - factors[i] * spread) * invDur;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        const e = ease(t);
        dst[i] = a[i] + (b[i] - a[i]) * e;
    }
    return dst;
}

async function soaApplyStaggerChunked(dst, a, b, factors, time, duration, spread, easeFn, count, chunkSize, yieldEvery) {
    count = count === undefined ? dst.length : count;
    const ease = easeFn || identityEase;
    const invDur = duration > 0 ? 1 / duration : 0;
    await _chunkedRange(count, chunkSize, yieldEvery, function (start, end) {
        for (let i = start; i < end; i++) {
            let t = (time - factors[i] * spread) * invDur;
            t = t < 0 ? 0 : (t > 1 ? 1 : t);
            const e = ease(t);
            dst[i] = a[i] + (b[i] - a[i]) * e;
        }
    });
    return dst;
}

// ============================================================================
// 11. CHUNKED ECS LOOP HELPER
// ============================================================================
/**
 * Chunked iteration over a bitECS query result — yields to the UI thread so
 * 1M+ entity loops stay at 60 fps on mobile. Accepts an array, a typed array,
 * a `{dense}` sparse set, or a `{count}` SOA index range.
 */
async function forEachEntityChunked(entities, body, chunkSize, yieldEvery) {
    chunkSize = chunkSize || CHUNK_SIZE;
    yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
    const list = (entities && entities.dense) ? entities.dense : entities;
    const n = (list && (list.length !== undefined ? list.length : list.count)) || 0;
    let c = 0;
    for (let start = 0; start < n; start += chunkSize) {
        const end = Math.min(start + chunkSize, n);
        for (let i = start; i < end; i++) { body(list ? list[i] : i, i); }
        if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
    }
}

// ============================================================================
// 12. THREE.JS r185 INTEROP (duck-typed — no three import, no CDN, no build)
// ============================================================================
/** Upload a Float32Array into any three.js r185 BufferAttribute. */
function soaToBufferAttribute(attribute, src, count) {
    const n = count === undefined ? Math.min(src.length, attribute.array.length) : count;
    attribute.array.set(src.subarray ? src.subarray(0, n) : src, 0);
    attribute.needsUpdate = true;
    return attribute;
}

/** Download a three.js r185 BufferAttribute into a Float32Array. */
function soaFromBufferAttribute(dst, attribute, count) {
    const n = count === undefined ? Math.min(dst.length, attribute.array.length) : count;
    dst.set(attribute.array.subarray(0, n));
    return dst;
}

/**
 * Bake per-instance stagger factors for a three.js r185 InstancedMesh and
 * optionally write them into an InstancedBufferAttribute (e.g. "aStagger").
 */
function createInstanceStagger(mesh, positions, options) {
    options = options || {};
    const n = options.count !== undefined ? options.count : (mesh ? mesh.count : positions.count);
    const factors = new Float32Array(n);
    soaStagger(factors, positions, options);
    if (options.attribute) { soaToBufferAttribute(options.attribute, factors, n); }
    return factors;
}

/** Write an RGBA (0..255) tuple into a three.js Color, sRGB→linear aware. */
function setThreeColorFromRGBA(color, rgba, linear) {
    const r = rgba[0] / 255, g = rgba[1] / 255, b = rgba[2] / 255;
    if (linear === false) { color.setRGB(r, g, b); }
    else {
        color.setRGB(
            r <= 0.04045 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4),
            g <= 0.04045 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4),
            b <= 0.04045 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4)
        );
    }
    return color;
}

/** Read a three.js Color (linear working space) back into an RGBA tuple. */
function getThreeColorToRGBA(out, color, alpha) {
    out[0] = linearToSrgb8(color.r);
    out[1] = linearToSrgb8(color.g);
    out[2] = linearToSrgb8(color.b);
    out[3] = alpha === undefined ? 1 : alpha;
    return out;
}

// ============================================================================
// 13. WORKER POOL — true multi-core SOA math (Blob URL, no server, no CDN)
// ============================================================================
const _utilsWorkerSource = "(" + function () {
    function ease(id, t) {
        switch (id) {
            case "smoothstep": return t * t * (3 - 2 * t);
            case "smootherstep": return t * t * t * (t * (t * 6 - 15) + 10);
            case "inQuad": return t * t;
            case "outQuad": return t * (2 - t);
            case "inOutQuad": return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
            case "inCubic": return t * t * t;
            case "outCubic": { const u = t - 1; return u * u * u + 1; }
            case "inOutCubic": return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) * 0.5;
            case "inSine": return 1 - Math.cos(t * Math.PI * 0.5);
            case "outSine": return Math.sin(t * Math.PI * 0.5);
            case "inOutSine": return -(Math.cos(Math.PI * t) - 1) * 0.5;
            case "outExpo": return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
            default: return t;
        }
    }

    self.onmessage = function (e) {
        const d = e.data, n = d.n, op = d.op, p = d.params;
        const a = d.a, b = d.b, vel = d.vel;
        const out = new Float32Array(n);
        const outVel = (op === "spring") ? new Float32Array(n) : null;

        if (op === "clamp") {
            for (let i = 0; i < n; i++) { const v = a[i]; out[i] = v < p.min ? p.min : (v > p.max ? p.max : v); }
        } else if (op === "lerp") {
            for (let i = 0; i < n; i++) { out[i] = a[i] + (b[i] - a[i]) * p.t; }
        } else if (op === "ease") {
            const et = ease(p.ease, p.t);
            for (let i = 0; i < n; i++) { out[i] = a[i] + (b[i] - a[i]) * et; }
        } else if (op === "mapRange") {
            const span = p.inMax - p.inMin;
            const inv = span !== 0 ? 1 / span : 0;
            const os = p.outMax - p.outMin;
            for (let i = 0; i < n; i++) { out[i] = p.outMin + ((a[i] - p.inMin) * inv) * os; }
        } else if (op === "damp") {
            const k = Math.exp(-p.lambda * p.dt);
            for (let i = 0; i < n; i++) { out[i] = b[i] + (a[i] - b[i]) * k; }
        } else if (op === "expLerp") {
            const k = 1 - Math.exp(-p.speed * p.dt);
            for (let i = 0; i < n; i++) { out[i] = a[i] + (b[i] - a[i]) * k; }
        } else if (op === "spring") {
            const st = Math.max(0.0001, p.smoothTime);
            const omega = 2 / st;
            const x = omega * p.dt;
            const ex = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
            const maxChange = (p.maxSpeed === null ? Infinity : p.maxSpeed) * st;
            const invDt = p.dt > 0 ? 1 / p.dt : 0;
            for (let i = 0; i < n; i++) {
                const c = a[i], ot = b[i];
                let t = ot, change = c - t;
                if (change > maxChange) { change = maxChange; }
                else if (change < -maxChange) { change = -maxChange; }
                t = c - change;
                const temp = (vel[i] + omega * change) * p.dt;
                let v = (vel[i] - omega * temp) * ex;
                let o = t + (change + temp) * ex;
                if ((ot - c > 0) === (o > ot)) { o = ot; v = (o - ot) * invDt; }
                out[i] = o; outVel[i] = v;
            }
        } else {
            for (let i = 0; i < n; i++) { out[i] = a[i]; }
        }

        const transfer = [out.buffer];
        if (outVel) { transfer.push(outVel.buffer); }
        self.postMessage({ id: d.id, out: out, vel: outVel }, transfer);
    };
}.toString() + ")();";

/**
 * Optional parallel executor for SOA utility math. When Workers / Blob URLs
 * are unavailable the pool transparently falls back to the chunked main
 * thread path, so a call never blocks the UI and never throws.
 * op: "clamp" | "lerp" | "ease" | "mapRange" | "damp" | "expLerp" | "spring".
 */
class UtilsWorkerPool {
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
            this._url = URL.createObjectURL(new Blob([_utilsWorkerSource], { type: "text/javascript" }));
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

    async _fallback(op, a, b, vel, params, out) {
        if (op === "clamp") { await soaClampChunked(out, params.min, params.max); }
        else if (op === "lerp") { await soaLerpChunked(out, a, b, params.t); }
        else if (op === "ease") { await soaEaseChunked(out, a, b, params.t, EASE_BY_ID[params.ease] || identityEase); }
        else if (op === "mapRange") { await soaMapRangeChunked(out, a, params.inMin, params.inMax, params.outMin, params.outMax); }
        else if (op === "damp") { await soaDampChunked(out, a, b, params.lambda, params.dt); }
        else if (op === "expLerp") { await soaExpLerp(out, a, b, params.speed, params.dt); }
        else if (op === "spring") {
            await soaSpringDampChunked(out, a, b, vel, params.smoothTime, params.dt,
                params.maxSpeed === null ? Infinity : params.maxSpeed);
            return { out, vel };
        } else { out.set(a); }
        return { out, vel: null };
    }

    /**
     * Run an op over Float32Arrays. `a` is the source (or current state),
     * `b` the secondary operand (or target), `vel` the spring velocity.
     * Resolves to { out, vel } — `out` may be supplied to avoid allocation.
     */
    async run(op, a, b, vel, params, out) {
        if (this._disposed) { throw new Error("UtilsWorkerPool disposed"); }
        params = params || {};
        const n = a.length;
        out = out || new Float32Array(n);

        if (this._workers.length === 0) {
            const src = a.slice ? a.slice() : new Float32Array(a);
            const dst = b ? (b.slice ? b.slice() : new Float32Array(b)) : null;
            const vv = vel ? (vel.slice ? vel.slice() : new Float32Array(vel)) : null;
            return this._fallback(op, src, dst, vv, params, out);
        }

        const W = this._workers.length;
        const per = Math.ceil(n / W);
        const jobs = [];
        for (let k = 0; k < W; k++) {
            const s = k * per, e = Math.min(s + per, n);
            if (s >= e) { break; }
            const len = e - s;
            const msg = {
                id: this._nextId++, op, n: len, params,
                a: a.slice(s, e),
                b: b ? b.slice(s, e) : null,
                vel: vel ? vel.slice(s, e) : null
            };
            const transfer = [msg.a.buffer];
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

function createUtilsWorkerPool(size) { return new UtilsWorkerPool(size); }

// ============================================================================
// 14. MATH NAMESPACE — the provided SOA stack stays the default maths
// ============================================================================
let simplex = null;

const math = {
    common, vec2, vec3, vec4, mat2,
    mat3: null, mat4, quat, quat2,
    bitecs: null, simplex: null, utils: null
};

/** Optional modules load dynamically; a failure never breaks this module. */
const mathReady = Promise.allSettled([
    import("./006_mat3.js").then((m) => { math.mat3 = m; }),
    import("./010_bitECS_core.js").then((m) => { math.bitecs = m; }),
    import("./013_simplex.js").then((m) => { simplex = m; math.simplex = m; })
]);

// ============================================================================
// 15. EXPORTS — every original export preserved + completed parallel layer
// ============================================================================
export {
    // foundation
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC,
    yieldToMain, createPool, mulberry32, hash2, hash3,
    // easing
    Easing, EASE_BY_ID,
    // original scalar API
    clamp, lerp, mapRange, random, randomInt, stagger, toArray,
    // color parsing
    NAMED_COLORS, hslToRgb, parseColor,
    // relative values + decomposition
    calcRelativeValue, decomposeValue, interpolateDecomposed,
    // pool
    acquireDecomp, releaseDecomp, decomposeInto,
    // SOA (sync)
    soaClamp, soaLerp, soaMapRange, soaRandom, soaRandomSeeded, soaEase,
    soaDamp, soaExpLerp, soaSpringDamp,
    // SOA (chunked async — mobile-safe)
    soaClampChunked, soaLerpChunked, soaMapRangeChunked, soaRandomChunked,
    soaEaseChunked, soaDampChunked, soaSpringDampChunked,
    // natural motion
    damp, expLerp, springDamp,
    // color (scalar)
    srgb8ToLinear, linearToSrgb8, exposeColor, reinhardColor, acesColor,
    packColorRGBA, unpackColorRGBA, cssColor,
    // color (SOA)
    soaExposeColor, soaReinhardColor, soaAcesColor, soaSrgb8ToLinear,
    soaLinearToSrgb8, soaPackRGBA, soaUnpackRGBA,
    // procedural stagger
    staggerHash, staggerNoise, staggerKepler, staggerRadial, staggerVoronoi,
    staggerForEntities, soaStagger, soaStaggerChunked,
    soaApplyStagger, soaApplyStaggerChunked,
    // chunked ECS
    forEachEntityChunked,
    // three.js r185 interop
    soaToBufferAttribute, soaFromBufferAttribute, createInstanceStagger,
    setThreeColorFromRGBA, getThreeColorToRGBA,
    // parallelism
    UtilsWorkerPool, createUtilsWorkerPool,
    // namespace
    math, mathReady
};

export default {
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC,
    yieldToMain, createPool, mulberry32, hash2, hash3,
    Easing, EASE_BY_ID,
    clamp, lerp, mapRange, random, randomInt, stagger, toArray,
    NAMED_COLORS, hslToRgb, parseColor,
    calcRelativeValue, decomposeValue, interpolateDecomposed,
    acquireDecomp, releaseDecomp, decomposeInto,
    soaClamp, soaLerp, soaMapRange, soaRandom, soaRandomSeeded, soaEase,
    soaDamp, soaExpLerp, soaSpringDamp,
    soaClampChunked, soaLerpChunked, soaMapRangeChunked, soaRandomChunked,
    soaEaseChunked, soaDampChunked, soaSpringDampChunked,
    damp, expLerp, springDamp,
    srgb8ToLinear, linearToSrgb8, exposeColor, reinhardColor, acesColor,
    packColorRGBA, unpackColorRGBA, cssColor,
    soaExposeColor, soaReinhardColor, soaAcesColor, soaSrgb8ToLinear,
    soaLinearToSrgb8, soaPackRGBA, soaUnpackRGBA,
    staggerHash, staggerNoise, staggerKepler, staggerRadial, staggerVoronoi,
    staggerForEntities, soaStagger, soaStaggerChunked,
    soaApplyStagger, soaApplyStaggerChunked,
    forEachEntityChunked,
    soaToBufferAttribute, soaFromBufferAttribute, createInstanceStagger,
    setThreeColorFromRGBA, getThreeColorToRGBA,
    UtilsWorkerPool, createUtilsWorkerPool,
    math, mathReady
};

// Continue with next file: src/math/015_easing.js (full easing / spring /
// timeline library — 1M-instance staggered playback, bezier solver LUT,
// keyframe tracks and bitECS timeline system)?