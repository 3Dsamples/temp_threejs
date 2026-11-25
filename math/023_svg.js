// file number : 023
// full path name : src/math/023_svg.js
// description : SVG helpers — every original export preserved (samplePath,
//               createMorphablePaths, svg.createDrawable / createMotionPath /
//               morphTo, samplePathFlat, samplePathFlatChunked, samplePathAsync,
//               pooledMorph, samplePathIntoSOA, samplePathIntoSOAChunked,
//               createSOAPathMorph, createSOAMotionPath, createKeplerMotionPath,
//               createIKMotionPath, createPathColorGradient,
//               createGlyphPathAnimation, getHelperPath, math), rewritten as a
//               self-contained native ES module in the three.js r185 JSM addon
//               style: no strict-mode directive, no CommonJS, no Vite / Vue /
//               client build, no CDN request.
//               Corrections: all transcription damage repaired (broken
//               identifiers, `& &`, `| |`, trailing-space string literals that
//               produced an INVALID SVG namespace and silently broke
//               getTotalLength(), the malformed selector character class, the
//               `d="…"` extraction regexes, and the double-spaced M/L/Z path
//               strings); missing `keplerSolve` / `eccentricToTrue` inlined;
//               the IK tolerance is compared against the DISTANCE error
//               returned by the corrected `vec3.fabrikStep3`.
//               Additions for 1M+ units at real time: an arc-length path LUT
//               baked ONCE per path (the original called the DOM
//               `getPointAtLength` once per instance per frame — catastrophic
//               at 1M), zero-GC flat / SOA samplers, tangent + normal + quaternion
//               frame builders so instances orient along the curve, chunked
//               yielding counterparts everywhere, duck-typed three.js r185
//               bridges (BufferGeometry / Line / InstancedMesh / Object3D), and
//               a resident-state Blob-URL worker pool for genuine multi-core
//               path evaluation with a non-blocking main-thread fallback.
//               The provided 002..009 SOA modules remain the default vector /
//               matrix / quaternion maths; three.js r185 only renders.
// best for : 3d graphics — SVG logos with per-path drawn-on reveals, morphing
//            icons across 1M+ glyphs, 3D motion paths driven by the same
//            geometry as the DOM, orbital camera / satellite chase reveals
//            ordered by Kepler mean anomaly, HDR color trails along a path
//            (emissive glow, ACES-compatible), FABRIK / CCD chains that follow
//            a motion path, instanced ribbons / tubes / asteroid streams that
//            ride a curve with correct tangent frames, and scroll-scrubbed or
//            timer-driven path animation — all at 60 fps on Android 64-bit.
// license : MIT
// ============================================================================

import * as vec2 from "./002_vec2.js";
import * as vec3 from "./003_vec3.js";
import * as vec4 from "./004_vec4.js";
import * as mat2 from "./005_mat2.js";
import * as mat4 from "./007_mat4.js";
import * as quat from "./008_quat.js";
import * as quat2 from "./009_quat2.js";
import * as utils from "./014_utils.js";
import * as easings from "./015_easings.js";
import * as engineModule from "./016_engine.js";
import * as animationModule from "./017_animation.js";

const Animation = animationModule.Animation;
const toArray = utils.toArray;

// ============================================================================
// 0. FOUNDATION (inlined — replaces require("./001_common.js"))
// ============================================================================
const CHUNK_SIZE = 65536;
const CHUNK_YIELD_EVERY = 8;
const POOL_PREALLOC = 8;
const EPSILON = 0.000001;
const TWO_PI = Math.PI * 2;
const DEFAULT_LUT_SAMPLES = 2048;

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

/** Newton-Raphson Kepler solver: E - e*sin(E) = M. */
function keplerSolve(M, e) {
    let E = M;
    for (let i = 0; i < 8; i++) {
        E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    }
    return E;
}

/** Eccentric anomaly -> true anomaly (radians, -π..π). */
function eccentricToTrue(E, e) {
    const s = Math.sqrt(1 + e) * Math.sin(E * 0.5);
    const c = Math.sqrt(1 - e) * Math.cos(E * 0.5);
    return 2 * Math.atan2(s, c);
}

async function _chunkedRange(count, chunkSize, yieldEvery, perChunk) {
    chunkSize = chunkSize || CHUNK_SIZE;
    yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + chunkSize, count);
        perChunk(start, end);
        start = end;
        if (start >= count) { break; }
        if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
    }
}

/** Resolve the axis string once (no per-element string compares in hot loops). */
function _axisMode(axis) {
    if (axis === "xz") { return 1; }
    if (axis === "yz") { return 2; }
    return 0; // "xy"
}

const common = {
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC, EPSILON, DEFAULT_LUT_SAMPLES,
    yieldToMain, createPool, keplerSolve, eccentricToTrue
};

// ============================================================================
// 1. HELPER PATH — one pooled node, correct SVG namespace
// ============================================================================
const SVG_NS = "http://www.w3.org/2000/svg";
let _helperSvgDoc = null;
let _helperSvgPath = null;

function getHelperPath(d) {
    if (typeof document === "undefined") { return null; }
    if (!_helperSvgPath) {
        _helperSvgDoc = document.createElementNS(SVG_NS, "svg");
        _helperSvgPath = document.createElementNS(SVG_NS, "path");
        _helperSvgDoc.appendChild(_helperSvgPath);
        _helperSvgDoc.style.position = "absolute";
        _helperSvgDoc.style.width = "0px";
        _helperSvgDoc.style.height = "0px";
        _helperSvgDoc.style.visibility = "hidden";
        _helperSvgDoc.style.pointerEvents = "none";
        _helperSvgDoc.setAttribute("aria-hidden", "true");
    }
    if (!_helperSvgDoc.parentNode && document.body) {
        document.body.appendChild(_helperSvgDoc);
    }
    if (typeof d === "string") { _helperSvgPath.setAttribute("d", d); }
    return _helperSvgPath;
}

/** Release the pooled helper node (call on scene teardown). */
function releaseHelperPath() {
    if (_helperSvgDoc && _helperSvgDoc.parentNode) {
        _helperSvgDoc.parentNode.removeChild(_helperSvgDoc);
    }
    _helperSvgDoc = null;
    _helperSvgPath = null;
}

// ---- path source resolution (allocation-free, selectors recognised first) ---
const PATH_DATA_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9eE\s.,+-]+$/;
const SELECTOR_PREFIX_RE = /^[#.\[:>]/;
const D_DOUBLE_RE = /d\s*=\s*"([^"]+)"/;
const D_SINGLE_RE = /d\s*=\s*'([^']+)'/;

function _resolvePathElement(source) {
    if (!source) { return null; }
    if (typeof source !== "string") {
        return (source.getTotalLength ? source : null);
    }
    const trimmed = source.trim();
    if (trimmed.length === 0) { return null; }

    if (trimmed.charAt(0) === "<") {
        const m = trimmed.match(D_DOUBLE_RE) || trimmed.match(D_SINGLE_RE);
        return getHelperPath(m ? m[1] : trimmed);
    }
    if (SELECTOR_PREFIX_RE.test(trimmed)) {
        return (typeof document !== "undefined") ? document.querySelector(trimmed) : null;
    }
    const c0 = trimmed.charAt(0);
    if (c0 === "M" || c0 === "m" || PATH_DATA_RE.test(trimmed)) {
        return getHelperPath(trimmed);
    }
    return (typeof document !== "undefined") ? document.querySelector(trimmed) : null;
}

// ============================================================================
// 2. ORIGINAL `samplePath` (byte-compatible return shape)
// ============================================================================
function samplePath(dOrElement, sampleCount) {
    sampleCount = sampleCount === undefined ? 60 : sampleCount;
    const pathEl = _resolvePathElement(dOrElement);
    if (!pathEl || !pathEl.getTotalLength) { return null; }
    const len = pathEl.getTotalLength();
    const count = Math.max(10, sampleCount);
    const points = new Array(count + 1);
    for (let i = 0; i <= count; i++) {
        const pt = pathEl.getPointAtLength((i / count) * len);
        points[i] = { x: pt.x, y: pt.y };
    }
    return { length: len, points: points };
}

// ============================================================================
// 3. ZERO-GC FLAT SAMPLER — writes into a caller-owned Float32Array
// ============================================================================
function samplePathFlat(out, dOrElement, sampleCount) {
    sampleCount = sampleCount === undefined ? 60 : sampleCount;
    const pathEl = _resolvePathElement(dOrElement);
    if (!pathEl || !pathEl.getTotalLength) { return 0; }
    const len = pathEl.getTotalLength();
    let count = Math.max(10, sampleCount);
    const need = (count + 1) * 2;
    if (out.length < need) { count = Math.max(10, ((out.length / 2) | 0) - 1); }
    for (let i = 0; i <= count; i++) {
        const pt = pathEl.getPointAtLength((i / count) * len);
        out[i * 2] = pt.x;
        out[i * 2 + 1] = pt.y;
    }
    return count + 1;
}

// ============================================================================
// 4. CHUNKED ASYNC SAMPLING — mobile-safe for very dense paths
// ============================================================================
async function samplePathAsync(dOrElement, sampleCount, chunkSize, yieldEvery) {
    sampleCount = sampleCount === undefined ? 60 : sampleCount;
    chunkSize = chunkSize || CHUNK_SIZE;
    yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
    const pathEl = _resolvePathElement(dOrElement);
    if (!pathEl || !pathEl.getTotalLength) { return null; }
    const len = pathEl.getTotalLength();
    const total = sampleCount + 1;
    const points = new Array(total);
    const invCount = sampleCount > 0 ? 1 / sampleCount : 0;
    let c = 0;
    for (let start = 0; start < total; start += chunkSize) {
        const end = Math.min(start + chunkSize, total);
        for (let i = start; i < end; i++) {
            const pt = pathEl.getPointAtLength(i * invCount * len);
            points[i] = { x: pt.x, y: pt.y };
        }
        if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
    }
    return { length: len, points: points };
}

async function samplePathFlatChunked(out, dOrElement, sampleCount, chunkSize, yieldEvery) {
    sampleCount = sampleCount === undefined ? 60 : sampleCount;
    chunkSize = chunkSize || CHUNK_SIZE;
    yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
    const pathEl = _resolvePathElement(dOrElement);
    if (!pathEl || !pathEl.getTotalLength) { return 0; }
    const len = pathEl.getTotalLength();
    let count = Math.max(10, sampleCount);
    if (out.length < (count + 1) * 2) { count = Math.max(10, ((out.length / 2) | 0) - 1); }
    const total = count + 1;
    const invCount = count > 0 ? 1 / count : 0;
    let c = 0;
    for (let start = 0; start < total; start += chunkSize) {
        const end = Math.min(start + chunkSize, total);
        for (let i = start; i < end; i++) {
            const pt = pathEl.getPointAtLength(i * invCount * len);
            out[i * 2] = pt.x;
            out[i * 2 + 1] = pt.y;
        }
        if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
    }
    return total;
}

// ============================================================================
// 5. ARC-LENGTH PATH LUT — the 1M-scale primitive
//    `getPointAtLength` is a DOM call; calling it per instance per frame is
//    fatal at 1M. Bake it ONCE into contiguous Float32Arrays, then every
//    per-frame sample is two array reads + one lerp (zero DOM, zero GC).
// ============================================================================
function createPathLUT(pathSource, samples) {
    samples = samples || DEFAULT_LUT_SAMPLES;
    const pathEl = _resolvePathElement(pathSource);
    if (!pathEl || !pathEl.getTotalLength) { return null; }
    const len = pathEl.getTotalLength();
    const count = Math.max(2, samples | 0);
    const xs = new Float32Array(count);
    const ys = new Float32Array(count);
    const inv = 1 / (count - 1);
    for (let i = 0; i < count; i++) {
        const pt = pathEl.getPointAtLength(i * inv * len);
        xs[i] = pt.x; ys[i] = pt.y;
    }
    return { xs: xs, ys: ys, count: count, length: len, last: count - 1 };
}

async function createPathLUTChunked(pathSource, samples, chunkSize, yieldEvery) {
    samples = samples || DEFAULT_LUT_SAMPLES;
    const pathEl = _resolvePathElement(pathSource);
    if (!pathEl || !pathEl.getTotalLength) { return null; }
    const len = pathEl.getTotalLength();
    const count = Math.max(2, samples | 0);
    const xs = new Float32Array(count);
    const ys = new Float32Array(count);
    const inv = 1 / (count - 1);
    await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) {
            const pt = pathEl.getPointAtLength(i * inv * len);
            xs[i] = pt.x; ys[i] = pt.y;
        }
    });
    return { xs: xs, ys: ys, count: count, length: len, last: count - 1 };
}

/** Interpolated LUT tap into a caller-owned 2-float array (zero-GC). */
function samplePathLUT(out, lut, t) {
    const last = lut.last;
    let x = t * last;
    if (x < 0) { x = 0; } else if (x > last) { x = last; }
    const i = x | 0;
    const j = i < last ? i + 1 : last;
    const f = x - i;
    const ax = lut.xs[i], ay = lut.ys[i];
    out[0] = ax + (lut.xs[j] - ax) * f;
    out[1] = ay + (lut.ys[j] - ay) * f;
    return out;
}

// ============================================================================
// 6. ORIGINAL `createMorphablePaths` (clean, valid path strings)
// ============================================================================
function createMorphablePaths(pathA, pathB, samples) {
    samples = samples === undefined ? 60 : samples;
    const sA = samplePath(pathA, samples);
    const sB = samplePath(pathB, samples);
    if (!sA || !sB) { return null; }
    const ptsA = sA.points;
    const ptsB = sB.points;
    const count = Math.max(ptsA.length, ptsB.length);

    const partsA = new Array(ptsA.length);
    for (let i = 0; i < ptsA.length; i++) {
        partsA[i] = (i === 0 ? "M" : "L") + ptsA[i].x.toFixed(2) + " " + ptsA[i].y.toFixed(2);
    }
    const partsB = new Array(ptsB.length);
    for (let j = 0; j < ptsB.length; j++) {
        partsB[j] = (j === 0 ? "M" : "L") + ptsB[j].x.toFixed(2) + " " + ptsB[j].y.toFixed(2);
    }
    return {
        pathA: partsA.join(" ") + " Z",
        pathB: partsB.join(" ") + " Z",
        count: count
    };
}

// ============================================================================
// 7. ORIGINAL `svg` OBJECT (byte-compatible API)
// ============================================================================
const svg = {
    createDrawable(targets, opts) {
        opts = opts || {};
        const paths = toArray(targets);
        const out = new Array(paths.length);
        for (let i = 0; i < paths.length; i++) {
            const path = paths[i];
            const len = path.getTotalLength ? path.getTotalLength() : 300;
            path.style.strokeDasharray = String(len);
            path.style.strokeDashoffset = String(len);
            const cfg = {
                targets: path,
                strokeDashoffset: [len, 0],
                duration: opts.duration || 1000,
                easing: opts.easing || "easeInOutQuad"
            };
            for (const k in opts) { cfg[k] = opts[k]; }
            cfg.targets = path;
            out[i] = new Animation(cfg);
        }
        return out;
    },

    createMotionPath(target, pathSelector, opts) {
        opts = opts || {};
        const el = typeof target === "string"
            ? (typeof document !== "undefined" ? document.querySelector(target) : null)
            : target;
        const path = _resolvePathElement(pathSelector);
        if (!el || !path || !path.getTotalLength) { return undefined; }
        const len = path.getTotalLength();
        const autoRotate = !!opts.autoRotate;
        const cfg = {
            targets: el,
            duration: opts.duration || 2000,
            easing: opts.easing || "linear",
            // One transform write per frame — no read-modify-write style recalc.
            onUpdate(anim) {
                const d = anim.progress * len;
                const pt = path.getPointAtLength(d);
                let s = "translate3d(" + pt.x + "px, " + pt.y + "px, 0px)";
                if (autoRotate) {
                    const nextPt = path.getPointAtLength(Math.min(len, d + 1));
                    const angle = Math.atan2(nextPt.y - pt.y, nextPt.x - pt.x) * (180 / Math.PI);
                    s += " rotate(" + angle + "deg)";
                }
                el.style.transform = s;
            }
        };
        for (const k in opts) { cfg[k] = opts[k]; }
        cfg.targets = el;
        return new Animation(cfg);
    },

    morphTo(targetPath, endPathSelector, opts) {
        opts = opts || {};
        const p1 = typeof targetPath === "string"
            ? (typeof document !== "undefined" ? document.querySelector(targetPath) : null)
            : targetPath;
        if (!p1) { return undefined; }
        const morphed = createMorphablePaths(p1, endPathSelector, opts.precision || 60);
        if (!morphed) { return undefined; }
        p1.setAttribute("d", morphed.pathA);
        const cfg = {
            targets: p1,
            d: [morphed.pathA, morphed.pathB],
            duration: opts.duration || 1000,
            easing: opts.easing || "easeInOutCubic"
        };
        for (const k in opts) { cfg[k] = opts[k]; }
        cfg.targets = p1;
        return new Animation(cfg);
    }
};

// ============================================================================
// 8. POOL — reusable SVG morph handles (wrapper + closure created ONCE)
// ============================================================================
const _morphPool = createPool(
    function () {
        const h = { anim: null, el: null, samples: 60, cached: null, released: true, wrapper: null };
        h.wrapper = {
            get anim() { return h.anim; },
            get cached() { return h.cached; },
            release() {
                if (h.released) { return; }
                _morphPool.release(h);
            }
        };
        return h;
    },
    POOL_PREALLOC,
    function (h) {
        if (h.anim) { try { h.anim.pause(); } catch (e) { /* swallow */ } }
        h.anim = null; h.el = null; h.samples = 60; h.cached = null; h.released = true;
    }
);
const _morphHandles = [];

function pooledMorph(targetPath, endPathSelector, opts) {
    opts = opts || {};
    const p1 = typeof targetPath === "string"
        ? (typeof document !== "undefined" ? document.querySelector(targetPath) : null)
        : targetPath;
    if (!p1) { return null; }

    const handle = _morphPool.acquire();
    handle.released = false;
    handle.el = p1;
    handle.samples = opts.precision || 60;

    const morphed = createMorphablePaths(p1, endPathSelector, handle.samples);
    if (!morphed) { _morphPool.release(handle); return null; }
    p1.setAttribute("d", morphed.pathA);
    handle.cached = morphed;

    const cfg = {
        targets: p1,
        d: [morphed.pathA, morphed.pathB],
        duration: opts.duration || 1000,
        easing: opts.easing || "easeInOutCubic"
    };
    for (const k in opts) { cfg[k] = opts[k]; }
    cfg.targets = p1;
    handle.anim = new Animation(cfg);
    _morphHandles.push(handle);
    return handle.wrapper;
}

/** Release every pooled morph handle (call when a scene unmounts). */
function releaseMorphPool() {
    for (let i = 0; i < _morphHandles.length; i++) {
        if (!_morphHandles[i].released) { _morphPool.release(_morphHandles[i]); }
    }
    _morphHandles.length = 0;
}

// ============================================================================
// 9. SOA PATH SAMPLER — 1M+ samples straight into vec2 / vec3 SOA channels
//    Default path uses the baked LUT (zero DOM calls per element).
//    Pass `exact: true` to force per-element `getPointAtLength` (original
//    behaviour) — only sensible for small counts.
// ============================================================================
function samplePathIntoSOA(pathSource, soa, options) {
    options = options || {};
    const mode = _axisMode(options.axis || "xy");
    const n = soa.count;
    if (n === 0) { return soa; }
    const ox = soa.x, oy = soa.y, oz = soa.z;
    const inv = n > 1 ? 1 / (n - 1) : 0;

    if (options.exact === true) {
        const pathEl = _resolvePathElement(pathSource);
        if (!pathEl || !pathEl.getTotalLength) { return soa; }
        const len = pathEl.getTotalLength();
        for (let i = 0; i < n; i++) {
            const pt = pathEl.getPointAtLength(i * inv * len);
            if (mode === 0) { ox[i] = pt.x; oy[i] = pt.y; }
            else if (mode === 1) { ox[i] = pt.x; oz[i] = pt.y; }
            else { oy[i] = pt.x; oz[i] = pt.y; }
        }
        return soa;
    }

    const lut = options.lut || createPathLUT(pathSource, options.lutSamples);
    if (!lut) { return soa; }
    const xs = lut.xs, ys = lut.ys, last = lut.last;
    for (let i = 0; i < n; i++) {
        let x = i * inv * last;
        if (x > last) { x = last; }
        const k = x | 0;
        const j = k < last ? k + 1 : last;
        const f = x - k;
        const ax = xs[k], ay = ys[k];
        const px = ax + (xs[j] - ax) * f;
        const py = ay + (ys[j] - ay) * f;
        if (mode === 0) { ox[i] = px; oy[i] = py; }
        else if (mode === 1) { ox[i] = px; oz[i] = py; }
        else { oy[i] = px; oz[i] = py; }
    }
    return soa;
}

async function samplePathIntoSOAChunked(pathSource, soa, options, chunkSize, yieldEvery) {
    options = options || {};
    const mode = _axisMode(options.axis || "xy");
    const n = soa.count;
    if (n === 0) { return soa; }
    const ox = soa.x, oy = soa.y, oz = soa.z;
    const inv = n > 1 ? 1 / (n - 1) : 0;

    if (options.exact === true) {
        const pathEl = _resolvePathElement(pathSource);
        if (!pathEl || !pathEl.getTotalLength) { return soa; }
        const len = pathEl.getTotalLength();
        await _chunkedRange(n, chunkSize, yieldEvery, function (s, e) {
            for (let i = s; i < e; i++) {
                const pt = pathEl.getPointAtLength(i * inv * len);
                if (mode === 0) { ox[i] = pt.x; oy[i] = pt.y; }
                else if (mode === 1) { ox[i] = pt.x; oz[i] = pt.y; }
                else { oy[i] = pt.x; oz[i] = pt.y; }
            }
        });
        return soa;
    }

    const lut = options.lut || await createPathLUTChunked(pathSource, options.lutSamples, chunkSize, yieldEvery);
    if (!lut) { return soa; }
    const xs = lut.xs, ys = lut.ys, last = lut.last;
    await _chunkedRange(n, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) {
            let x = i * inv * last;
            if (x > last) { x = last; }
            const k = x | 0;
            const j = k < last ? k + 1 : last;
            const f = x - k;
            const ax = xs[k], ay = ys[k];
            const px = ax + (xs[j] - ax) * f;
            const py = ay + (ys[j] - ay) * f;
            if (mode === 0) { ox[i] = px; oy[i] = py; }
            else if (mode === 1) { ox[i] = px; oz[i] = py; }
            else { oy[i] = px; oz[i] = py; }
        }
    });
    return soa;
}

// ============================================================================
// 10. SOA MORPH — interpolate between two paths across 1M+ instances
// ============================================================================
function createSOAPathMorph(soa, pathA, pathB, options) {
    options = options || {};
    const mode = _axisMode(options.axis || "xy");
    const easeFn = easings.getEasing(options.ease || "easeInOutCubic");
    const n = soa.count;
    const samples = options.sampleCount || Math.max(64, Math.min(4096, n));

    const lutA = createPathLUT(pathA, samples);
    const lutB = createPathLUT(pathB, samples);
    if (!lutA || !lutB) { return null; }

    const ax = lutA.xs, ay = lutA.ys, lastA = lutA.last;
    const bx = lutB.xs, by = lutB.ys, lastB = lutB.last;
    const ox = soa.x, oy = soa.y, oz = soa.z;
    const inv = n > 1 ? 1 / (n - 1) : 0;

    function writeRange(s, e, t) {
        for (let k = s; k < e; k++) {
            const u = k * inv;
            let ia = u * lastA; if (ia > lastA) { ia = lastA; }
            let ib = u * lastB; if (ib > lastB) { ib = lastB; }
            const ka = ia | 0, kb = ib | 0;
            const ja = ka < lastA ? ka + 1 : lastA;
            const jb = kb < lastB ? kb + 1 : lastB;
            const fa = ia - ka, fb = ib - kb;
            const a0 = ax[ka], a1 = ay[ka];
            const b0 = bx[kb], b1 = by[kb];
            const pax = a0 + (ax[ja] - a0) * fa;
            const pay = a1 + (ay[ja] - a1) * fa;
            const pbx = b0 + (bx[jb] - b0) * fb;
            const pby = b1 + (by[jb] - b1) * fb;
            const x = pax + (pbx - pax) * t;
            const y = pay + (pby - pay) * t;
            if (mode === 0) { ox[k] = x; oy[k] = y; }
            else if (mode === 1) { ox[k] = x; oz[k] = y; }
            else { oy[k] = x; oz[k] = y; }
        }
    }

    return {
        count: n,
        lutA: lutA,
        lutB: lutB,
        step(p) { writeRange(0, n, easeFn(p < 0 ? 0 : (p > 1 ? 1 : p))); return soa; },
        async stepChunked(p, chunkSize, yieldEvery) {
            const et = easeFn(p < 0 ? 0 : (p > 1 ? 1 : p));
            await _chunkedRange(n, chunkSize, yieldEvery, function (s, e) { writeRange(s, e, et); });
            return soa;
        }
    };
}

// ============================================================================
// 11. 3D MOTION PATH — move a whole vec3 SOA along an SVG path
// ============================================================================
function createSOAMotionPath(soa, pathSource, options) {
    options = options || {};
    const spread = options.spread === true;
    const mode = _axisMode(options.axis || "xy");
    const easeFn = easings.getEasing(options.ease || "linear");
    const loop = options.loop !== false;
    const n = soa.count;

    const lut = options.lut || createPathLUT(pathSource, options.lutSamples);
    if (!lut) { return null; }
    const xs = lut.xs, ys = lut.ys, last = lut.last;
    const invN = n > 0 ? 1 / n : 0;
    const ox = soa.x, oy = soa.y, oz = soa.z;

    function writeRange(s, e, et) {
        for (let k = s; k < e; k++) {
            let tp = spread ? (k * invN + et) : et;
            if (loop) { tp = tp % 1; if (tp < 0) { tp += 1; } }
            else if (tp < 0) { tp = 0; } else if (tp > 1) { tp = 1; }
            let x = tp * last;
            if (x > last) { x = last; }
            const i = x | 0;
            const j = i < last ? i + 1 : last;
            const f = x - i;
            const a0 = xs[i], a1 = ys[i];
            const px = a0 + (xs[j] - a0) * f;
            const py = a1 + (ys[j] - a1) * f;
            if (mode === 0) { ox[k] = px; oy[k] = py; }
            else if (mode === 1) { ox[k] = px; oz[k] = py; }
            else { oy[k] = px; oz[k] = py; }
        }
    }

    const api = {
        count: n,
        lut: lut,
        step(p) { writeRange(0, n, easeFn(p < 0 ? 0 : (p > 1 ? 1 : p))); return soa; },
        async stepChunked(p, chunkSize, yieldEvery) {
            const et = easeFn(p < 0 ? 0 : (p > 1 ? 1 : p));
            await _chunkedRange(n, chunkSize, yieldEvery, function (s, e) { writeRange(s, e, et); });
            return soa;
        },
        /** Convenience — advance along the path over `duration` seconds. */
        play(engine, duration) {
            let t = 0;
            const dur = duration || 2;
            const entry = engine.addSoaStep(function (dtSec) {
                t += dtSec;
                api.step(t / dur);
            }, options.name || "svg.motionPath");
            api._entry = entry;
            return api;
        },
        stop(engine) {
            if (api._entry && engine) { engine.removeSoaStep(api._entry); api._entry = null; }
            return api;
        }
    };
    return api;
}

// ============================================================================
// 12. KEPLER MOTION PATH — orbital chase reveal
// ============================================================================
function createKeplerMotionPath(soa, pathSource, options) {
    options = options || {};
    const e = options.e !== undefined ? options.e : 0.5;
    const speed = options.speed !== undefined ? options.speed : 1;
    const rate = options.rate !== undefined ? options.rate : 0.15;
    const mode = _axisMode(options.axis || "xy");
    const n = soa.count;

    const lut = options.lut || createPathLUT(pathSource, options.lutSamples);
    if (!lut) { return null; }
    const xs = lut.xs, ys = lut.ys, last = lut.last;
    const invN = n > 0 ? 1 / n : 0;

    const delays = new Float32Array(n);
    const invTwoPi = 1 / TWO_PI;
    for (let d = 0; d < n; d++) {
        const M = d * invN * TWO_PI;
        const E = keplerSolve(M, e);
        const nu = eccentricToTrue(E, e);
        delays[d] = ((nu + Math.PI) * invTwoPi) * speed;
    }

    const ox = soa.x, oy = soa.y, oz = soa.z;
    let t = 0;

    function writeRange(s, en, base) {
        for (let k = s; k < en; k++) {
            let lt = (base + delays[k]) % 1;
            if (lt < 0) { lt += 1; }
            let x = lt * last;
            if (x > last) { x = last; }
            const i = x | 0;
            const j = i < last ? i + 1 : last;
            const f = x - i;
            const a0 = xs[i], a1 = ys[i];
            const px = a0 + (xs[j] - a0) * f;
            const py = a1 + (ys[j] - a1) * f;
            if (mode === 0) { ox[k] = px; oy[k] = py; }
            else if (mode === 1) { ox[k] = px; oz[k] = py; }
            else { oy[k] = px; oz[k] = py; }
        }
    }

    return {
        delays: delays,
        count: n,
        lut: lut,
        step(dtSec) { t += dtSec; writeRange(0, n, t * rate); return soa; },
        async stepChunked(dtSec, chunkSize, yieldEvery) {
            t += dtSec;
            const base = t * rate;
            await _chunkedRange(n, chunkSize, yieldEvery, function (s, e) { writeRange(s, e, base); });
            return soa;
        },
        get time() { return t; }
    };
}

// ============================================================================
// 13. IK MOTION PATH — FABRIK / CCD end-effector follows an SVG path
// ============================================================================
function createIKMotionPath(chain, pathSource, options) {
    options = options || {};
    const duration = options.duration !== undefined ? options.duration : 2;
    const easeFn = easings.getEasing(options.ease || "linear");
    const iterations = options.iterations || 10;
    const tolerance = options.tolerance !== undefined ? options.tolerance : 0.001;
    const useCCD = options.method === "ccd";
    const zBase = options.zBase !== undefined
        ? options.zBase
        : ((chain && chain.target) ? (chain.target[2] || 0) : 0);

    const lut = options.lut || createPathLUT(pathSource, options.lutSamples || 256);
    if (!lut) { return null; }
    const xs = lut.xs, ys = lut.ys, last = lut.last;
    const hasSetter = chain && typeof chain.setTarget === "function";
    const chainIndex = chain && chain.index !== undefined ? chain.index : 0;
    let t = 0;

    function apply() {
        let x = easeFn(t) * last;
        if (x < 0) { x = 0; } else if (x > last) { x = last; }
        const i = x | 0;
        const j = i < last ? i + 1 : last;
        const f = x - i;
        const a0 = xs[i], a1 = ys[i];
        const tx = a0 + (xs[j] - a0) * f;
        const ty = a1 + (ys[j] - a1) * f;
        if (hasSetter) { chain.setTarget(chainIndex, tx, ty, zBase); }
        if (chain && chain.target) {
            chain.target[0] = tx; chain.target[1] = ty; chain.target[2] = zBase;
        }
        if (!chain || !chain.pos) { return; }
        if (useCCD) {
            vec3.ccdStep3(chain.pos, chain.target, iterations);
        } else {
            for (let it = 0; it < iterations; it++) {
                if (vec3.fabrikStep3(chain.pos, chain.lens, chain.target, tolerance) < tolerance) { break; }
            }
        }
    }

    return {
        lut: lut,
        step(dtSec) {
            t += dtSec / duration;
            if (t > 1) { t = 1; }
            apply();
            return t >= 1;
        },
        seek(p) { t = p < 0 ? 0 : (p > 1 ? 1 : p); apply(); return this; },
        get done() { return t >= 1; },
        get progress() { return t; }
    };
}

// ============================================================================
// 14. HDR COLOR ALONG PATH — per-instance gradient (no clamping)
// ============================================================================
function createPathColorGradient(colors, fromColor, toColor, soa) {
    const n = Math.min(colors.count, soa.count);
    const px = soa.x, py = soa.y, pz = soa.z;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
        const x = px[i], y = py[i], z = pz[i];
        if (x < minX) { minX = x; } if (x > maxX) { maxX = x; }
        if (y < minY) { minY = y; } if (y > maxY) { maxY = y; }
        if (z < minZ) { minZ = z; } if (z > maxZ) { maxZ = z; }
    }
    const w = (maxX - minX) || 1;
    const h = (maxY - minY) || 1;
    const d = (maxZ - minZ) || 1;
    const invSpan = 1 / (Math.sqrt(w * w + h * h + d * d) || 1);
    const fr = fromColor[0], fg = fromColor[1], fb = fromColor[2], fa = fromColor[3];
    const dr = toColor[0] - fr, dg = toColor[1] - fg, db = toColor[2] - fb, da = toColor[3] - fa;
    const cx = colors.x, cy = colors.y, cz = colors.z, ca = colors.w;

    function writeRange(s, e) {
        for (let j = s; j < e; j++) {
            const ex = px[j] - minX, ey = py[j] - minY, ez = pz[j] - minZ;
            const t = Math.sqrt(ex * ex + ey * ey + ez * ez) * invSpan;
            cx[j] = fr + dr * t;
            cy[j] = fg + dg * t;
            cz[j] = fb + db * t;
            ca[j] = fa + da * t;
        }
    }

    writeRange(0, n);
    return {
        colors: colors,
        count: n,
        apply() { writeRange(0, n); return colors; },
        async applyChunked(chunkSize, yieldEvery) {
            await _chunkedRange(n, chunkSize, yieldEvery, writeRange);
            return colors;
        }
    };
}

// ============================================================================
// 15. BITECS GLYPH PATH ANIMATION — 1M+ glyphs morph along a path
// ============================================================================
function createGlyphPathAnimation(trs, pathSource, options) {
    options = options || {};
    const mode = _axisMode(options.axis || "xy");
    const spread = options.spread === true;
    const easeFn = easings.getEasing(options.ease || "easeOutCubic");
    const duration = options.duration !== undefined ? options.duration : 2;
    const stagger = options.stagger || null;
    const n = trs.position.count;

    const lut = options.lut || createPathLUT(pathSource, options.lutSamples || Math.max(64, Math.min(4096, n)));
    if (!lut) { return null; }
    const xs = lut.xs, ys = lut.ys, last = lut.last;
    const invN = n > 0 ? 1 / n : 0;
    const sx = trs.position.x, sy = trs.position.y, sz = trs.position.z;
    let t = 0;

    function writeRange(s, e) {
        for (let k = s; k < e; k++) {
            let local = t;
            if (stagger) {
                let span = 1 - stagger[k];
                if (span < 1e-6) { span = 1e-6; }
                local = (t - stagger[k]) / span;
                if (local < 0) { local = 0; } else if (local > 1) { local = 1; }
            }
            const et = easeFn(local);
            let tp = spread ? ((k * invN + et) % 1) : et;
            if (tp < 0) { tp += 1; }
            let x = tp * last;
            if (x > last) { x = last; }
            const i = x | 0;
            const j = i < last ? i + 1 : last;
            const f = x - i;
            const a0 = xs[i], a1 = ys[i];
            const px = a0 + (xs[j] - a0) * f;
            const py = a1 + (ys[j] - a1) * f;
            if (mode === 0) { sx[k] = px; sy[k] = py; }
            else if (mode === 1) { sx[k] = px; sz[k] = py; }
            else { sy[k] = px; sz[k] = py; }
        }
    }

    return {
        count: n,
        lut: lut,
        step(dtSec) {
            t += dtSec / duration;
            if (t > 1) { t = 1; }
            writeRange(0, n);
            return t >= 1;
        },
        async stepChunked(dtSec, chunkSize, yieldEvery) {
            t += dtSec / duration;
            if (t > 1) { t = 1; }
            await _chunkedRange(n, chunkSize, yieldEvery, writeRange);
            return t >= 1;
        },
        get done() { return t >= 1; },
        get progress() { return t; }
    };
}

// ============================================================================
// 16. TANGENT / NORMAL / QUATERNION FRAMES — orient 1M+ instances on a curve
//     This is the default-math replacement layer: vec3 tangents + normals and
//     quat / dual-quat orientations built from the provided SOA modules.
// ============================================================================
/** Bake tangents (unit) and 2D normals into flat arrays alongside a LUT. */
function createPathFrames(pathSource, options) {
    options = options || {};
    const lut = options.lut || createPathLUT(pathSource, options.lutSamples);
    if (!lut) { return null; }
    const count = lut.count, last = lut.last;
    const xs = lut.xs, ys = lut.ys;
    const tx = new Float32Array(count);
    const ty = new Float32Array(count);
    const nx = new Float32Array(count);
    const ny = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        const a = i > 0 ? i - 1 : 0;
        const b = i < last ? i + 1 : last;
        let dx = xs[b] - xs[a];
        let dy = ys[b] - ys[a];
        const l = Math.sqrt(dx * dx + dy * dy);
        if (l > EPSILON) { dx /= l; dy /= l; } else { dx = 1; dy = 0; }
        tx[i] = dx; ty[i] = dy;
        nx[i] = -dy; ny[i] = dx;
    }
    return { lut: lut, tx: tx, ty: ty, nx: nx, ny: ny, count: count, last: last };
}

/**
 * Fill a vec3 SOA with positions along the path AND a quat SOA whose local
 * +X axis follows the curve tangent (shortest-arc, zero-GC, 1M-safe).
 * `offset` pushes instances along the 2D normal (ribbon width / jitter).
 */
function createSOAPathFrames(positions, rotations, pathSource, options) {
    options = options || {};
    const mode = _axisMode(options.axis || "xy");
    const frames = options.frames || createPathFrames(pathSource, options);
    if (!frames) { return null; }
    const lut = frames.lut;
    const xs = lut.xs, ys = lut.ys, last = frames.last;
    const ftx = frames.tx, fty = frames.ty, fnx = frames.nx, fny = frames.ny;
    const n = positions.count;
    const inv = n > 1 ? 1 / (n - 1) : 0;
    const offset = options.offset || null;
    const zBase = options.zBase !== undefined ? options.zBase : 0;
    const px = positions.x, py = positions.y, pz = positions.z;
    const qx = rotations ? rotations.x : null;
    const qy = rotations ? rotations.y : null;
    const qz = rotations ? rotations.z : null;
    const qw = rotations ? rotations.w : null;

    function writeRange(s, e, progress) {
        for (let i = s; i < e; i++) {
            let u = i * inv + progress;
            u = u % 1; if (u < 0) { u += 1; }
            let x = u * last;
            if (x > last) { x = last; }
            const k = x | 0;
            const j = k < last ? k + 1 : last;
            const f = x - k;
            const a0 = xs[k], a1 = ys[k];
            let cx = a0 + (xs[j] - a0) * f;
            let cy = a1 + (ys[j] - a1) * f;

            let dx = ftx[k] + (ftx[j] - ftx[k]) * f;
            let dy = fty[k] + (fty[j] - fty[k]) * f;
            const dl = Math.sqrt(dx * dx + dy * dy);
            if (dl > EPSILON) { dx /= dl; dy /= dl; } else { dx = 1; dy = 0; }

            if (offset) {
                const o = offset[i];
                cx += (fnx[k] + (fnx[j] - fnx[k]) * f) * o;
                cy += (fny[k] + (fny[j] - fny[k]) * f) * o;
            }

            if (mode === 0) { px[i] = cx; py[i] = cy; }
            else if (mode === 1) { px[i] = cx; pz[i] = cy; }
            else { py[i] = cx; pz[i] = cy; }

            if (!qx) { continue; }
            // Shortest-arc rotation taking local +X to the tangent direction.
            let vx = dx, vy = dy, vz = 0;
            if (mode === 1) { vx = dx; vy = 0; vz = dy; }
            else if (mode === 2) { vx = 0; vy = dx; vz = dy; }
            const w = 1 + vx;
            if (w < EPSILON) {
                qx[i] = 0; qy[i] = 0; qz[i] = 1; qw[i] = 0;
            } else {
                const rqx = 0, rqy = -vz, rqz = vy, rqw = w;
                const l = Math.sqrt(rqy * rqy + rqz * rqz + rqw * rqw) || 1;
                const li = 1 / l;
                qx[i] = rqx * li; qy[i] = rqy * li; qz[i] = rqz * li; qw[i] = rqw * li;
            }
        }
    }

    writeRange(0, n, 0);

    return {
        count: n,
        frames: frames,
        lut: lut,
        apply(progress) { writeRange(0, n, progress || 0); return positions; },
        async applyChunked(progress, chunkSize, yieldEvery) {
            const p = progress || 0;
            await _chunkedRange(n, chunkSize, yieldEvery, function (s, e) { writeRange(s, e, p); });
            return positions;
        }
    };
}

/** Dual-quaternion variant — 8 floats / instance, GPU-friendly rigid transforms. */
function createSOAPathDualQuats(dqs, pathSource, options) {
    options = options || {};
    const positions = options.positions || vec3.createVec3SOA(dqs.count);
    const rotations = quat.createQuatSOA(dqs.count);
    const frames = createSOAPathFrames(positions, rotations, pathSource, options);
    if (!frames) { return null; }
    function bake() {
        quat2.soaFromRotationTranslation(dqs, rotations, positions);
        return dqs;
    }
    bake();
    return {
        count: dqs.count,
        frames: frames,
        positions: positions,
        rotations: rotations,
        apply(progress) { frames.apply(progress); return bake(); },
        async applyChunked(progress, chunkSize, yieldEvery) {
            await frames.applyChunked(progress, chunkSize, yieldEvery);
            return bake();
        }
    };
}

// ============================================================================
// 17. THREE.JS r185 BRIDGES (duck-typed — no three import, no CDN, no build)
// ============================================================================
/** Write a vec3 SOA straight into a three.js BufferGeometry position attribute. */
function pathToBufferGeometry(soa, geometry, options) {
    options = options || {};
    const attributeName = options.attribute || "position";
    const attr = geometry && geometry.attributes ? geometry.attributes[attributeName] : null;
    if (!attr || !attr.array) { return null; }
    const capacity = attr.count !== undefined ? attr.count : (attr.array.length / 3) | 0;
    const n = Math.min(soa.count, capacity);
    vec3.soaToFlat(attr.array, { x: soa.x, y: soa.y, z: soa.z, count: n }, 0);
    attr.needsUpdate = true;
    if (geometry.setDrawRange) { geometry.setDrawRange(0, n); }
    if (options.recomputeBounds === true && typeof geometry.computeBoundingSphere === "function") {
        geometry.computeBoundingSphere();
    }
    return attr;
}

/** Convenience alias for THREE.Line / LineLoop / LineSegments position upload. */
function pathToLineGeometry(soa, geometry, options) {
    return pathToBufferGeometry(soa, geometry, options);
}

/**
 * Ride a three.js r185 InstancedMesh along an SVG path with tangent-aligned
 * orientation. Composed matrices go straight into `mesh.instanceMatrix.array`
 * — no intermediate buffer, no per-instance Object3D.
 */
function attachPathToInstancedMesh(mesh, trs, pathSource, options) {
    options = options || {};
    const n = trs.position.count;
    const matrices = options.matrices || mat4.createMat4SOA(n);
    const frames = createSOAPathFrames(trs.position, trs.rotation, pathSource, options);
    if (!frames) { return null; }
    const view = { arrays: matrices.arrays, count: n };
    const recomputeBounds = options.recomputeBounds === true;

    function upload() {
        const attr = mesh.instanceMatrix;
        if (!attr || !attr.array) { return matrices; }
        const capacity = attr.count !== undefined ? attr.count : (attr.array.length / 16) | 0;
        view.count = Math.min(n, capacity);
        mat4.soaComposeTRS(matrices, trs.position, trs.rotation, trs.scale);
        mat4.soaToFlat(attr.array, view, 0);
        attr.needsUpdate = true;
        if (mesh.count !== view.count) { mesh.count = view.count; }
        if (recomputeBounds && typeof mesh.computeBoundingSphere === "function") {
            mesh.computeBoundingSphere();
        }
        return matrices;
    }

    upload();

    return {
        frames: frames,
        matrices: matrices,
        upload: upload,
        apply(progress) { frames.apply(progress); return upload(); },
        async applyChunked(progress, chunkSize, yieldEvery) {
            await frames.applyChunked(progress, chunkSize, yieldEvery);
            await mat4.soaComposeTRSChunked(
                matrices, trs.position, trs.rotation, trs.scale, chunkSize, yieldEvery
            );
            const attr = mesh.instanceMatrix;
            if (attr && attr.array) {
                const capacity = attr.count !== undefined ? attr.count : (attr.array.length / 16) | 0;
                view.count = Math.min(n, capacity);
                mat4.soaToFlat(attr.array, view, 0);
                attr.needsUpdate = true;
                if (mesh.count !== view.count) { mesh.count = view.count; }
            }
            return matrices;
        }
    };
}

/**
 * Move a single three.js Object3D along the path (position + optional
 * tangent-aligned quaternion). Uses module temporaries — zero per-frame GC.
 */
const _tmpPos3 = new Float32Array(3);
const _tmpVel3 = new Float32Array(3);
const _tmpQuat4 = new Float32Array(4);

function createThreeMotionPath(object3D, pathSource, options) {
    options = options || {};
    const mode = _axisMode(options.axis || "xy");
    const frames = options.frames || createPathFrames(pathSource, options);
    if (!frames) { return null; }
    const lut = frames.lut;
    const xs = lut.xs, ys = lut.ys, last = frames.last;
    const ftx = frames.tx, fty = frames.ty;
    const easeFn = easings.getEasing(options.ease || "linear");
    const autoRotate = options.autoRotate !== false;
    const zBase = options.zBase !== undefined ? options.zBase : 0;
    const duration = options.duration !== undefined ? options.duration : 2;
    let t = 0;

    function apply(p) {
        let x = easeFn(p < 0 ? 0 : (p > 1 ? 1 : p)) * last;
        if (x > last) { x = last; }
        const i = x | 0;
        const j = i < last ? i + 1 : last;
        const f = x - i;
        const a0 = xs[i], a1 = ys[i];
        const cx = a0 + (xs[j] - a0) * f;
        const cy = a1 + (ys[j] - a1) * f;
        if (mode === 0) { _tmpPos3[0] = cx; _tmpPos3[1] = cy; _tmpPos3[2] = zBase; }
        else if (mode === 1) { _tmpPos3[0] = cx; _tmpPos3[1] = zBase; _tmpPos3[2] = cy; }
        else { _tmpPos3[0] = zBase; _tmpPos3[1] = cx; _tmpPos3[2] = cy; }
        object3D.position.set(_tmpPos3[0], _tmpPos3[1], _tmpPos3[2]);

        if (autoRotate && object3D.quaternion) {
            let dx = ftx[i] + (ftx[j] - ftx[i]) * f;
            let dy = fty[i] + (fty[j] - fty[i]) * f;
            const dl = Math.sqrt(dx * dx + dy * dy);
            if (dl > EPSILON) { dx /= dl; dy /= dl; } else { dx = 1; dy = 0; }
            _tmpVel3[0] = mode === 0 ? dx : (mode === 1 ? dx : 0);
            _tmpVel3[1] = mode === 0 ? dy : (mode === 1 ? 0 : dx);
            _tmpVel3[2] = mode === 0 ? 0 : (mode === 1 ? dy : dy);
            quat2.fromVelocityTranslation(_tmpQuat4, _tmpVel3, _tmpPos3);
            object3D.quaternion.set(_tmpQuat4[0], _tmpQuat4[1], _tmpQuat4[2], _tmpQuat4[3]);
        }
        if (options.updateMatrix !== false && typeof object3D.updateMatrix === "function") {
            object3D.updateMatrix();
        }
        return object3D;
    }

    apply(0);

    return {
        frames: frames,
        lut: lut,
        seek(p) { t = p < 0 ? 0 : (p > 1 ? 1 : p); return apply(t); },
        step(dtSec) {
            t += dtSec / duration;
            if (t > 1) { t = options.loop ? t % 1 : 1; }
            apply(t);
            return t >= 1 && !options.loop;
        },
        get progress() { return t; },
        get done() { return t >= 1; }
    };
}

// ============================================================================
// 18. WORKER POOL — resident LUT, multi-core path evaluation (Blob URL)
// ============================================================================
const _pathWorkerSource = "(" + function () {
    const luts = new Map();

    self.onmessage = function (e) {
        const d = e.data;
        if (d.op === "attach") {
            luts.set(d.lutId, { xs: d.xs, ys: d.ys, last: d.xs.length - 1 });
            self.postMessage({ id: d.id, ok: true });
            return;
        }
        if (d.op === "detach") {
            luts.delete(d.lutId);
            self.postMessage({ id: d.id, ok: true });
            return;
        }

        const lut = luts.get(d.lutId);
        const xs = lut.xs, ys = lut.ys, last = lut.last;
        const ox = d.ox, oy = d.oy, oz = d.oz;
        const n = d.n, et = d.et, mode = d.mode;
        const spread = d.spread, invN = n > 0 ? 1 / n : 0;
        const loop = d.loop;

        for (let k = 0; k < n; k++) {
            let tp = spread ? (k * invN + et) : et;
            if (loop) { tp = tp % 1; if (tp < 0) { tp += 1; } }
            else if (tp < 0) { tp = 0; } else if (tp > 1) { tp = 1; }
            let x = tp * last;
            if (x > last) { x = last; }
            const i = x | 0;
            const j = i < last ? i + 1 : last;
            const f = x - i;
            const a0 = xs[i], a1 = ys[i];
            const px = a0 + (xs[j] - a0) * f;
            const py = a1 + (ys[j] - a1) * f;
            if (mode === 0) { ox[k] = px; oy[k] = py; }
            else if (mode === 1) { ox[k] = px; oz[k] = py; }
            else { oy[k] = px; oz[k] = py; }
        }

        const transfer = [];
        if (mode === 0) { transfer.push(ox.buffer, oy.buffer); }
        else if (mode === 1) { transfer.push(ox.buffer, oz.buffer); }
        else { transfer.push(oy.buffer, oz.buffer); }
        self.postMessage({ id: d.id, ox: ox, oy: oy, oz: oz }, transfer);
    };
}.toString() + ")();";

/**
 * Optional multi-core executor for SOA motion paths. The path LUT is attached
 * once and stays resident in the worker; only the output channels are
 * transferred each frame (zero copy). Without Workers / Blob URLs the pool
 * falls back to the chunked main-thread path, so a call never blocks the UI.
 */
class PathWorkerPool {
    constructor(size) {
        this._workers = [];
        this._idle = [];
        this._queue = [];
        this._pending = new Map();
        this._nextId = 1;
        this._url = null;
        this._disposed = false;
        this._attached = new WeakMap();

        const want = size || Math.min(4, (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 2);
        try {
            if (typeof Worker === "undefined" || typeof Blob === "undefined" ||
                typeof URL === "undefined" || !URL.createObjectURL) {
                throw new Error("workers unavailable");
            }
            this._url = URL.createObjectURL(new Blob([_pathWorkerSource], { type: "text/javascript" }));
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
    get isParallel() { return this._workers.length > 0; }

    _dispatch() {
        while (this._queue.length > 0 && this._idle.length > 0) {
            const job = this._queue.shift();
            const w = this._idle.pop();
            this._pending.set(job.msg.id, job);
            w.postMessage(job.msg, job.transfer || []);
        }
    }

    _post(msg, transfer) {
        return new Promise((resolve, reject) => {
            this._queue.push({ msg, transfer, resolve, reject });
            this._dispatch();
        });
    }

    /** Upload a path LUT once; returns a handle id (or -1 in fallback mode). */
    async attach(lut) {
        if (this._disposed || this._workers.length === 0 || !lut) { return -1; }
        const id = this._nextId++;
        await this._post({
            id: this._nextId++, op: "attach", lutId: id,
            xs: lut.xs.slice(), ys: lut.ys.slice()
        }, []);
        this._attached.set(lut, id);
        return id;
    }

    /**
     * Evaluate a motion path off-thread. `soa` is the destination vec3 SOA.
     * options: { axis, spread, loop, ease }
     */
    async run(lut, soa, progress, options) {
        if (this._disposed) { throw new Error("PathWorkerPool disposed"); }
        options = options || {};
        const mode = _axisMode(options.axis || "xy");
        const easeFn = easings.getEasing(options.ease || "linear");
        const et = easeFn(progress < 0 ? 0 : (progress > 1 ? 1 : progress));
        const n = soa.count;
        const spread = options.spread === true;
        const loop = options.loop !== false;
        const id = this._attached.get(lut);

        if (this._workers.length === 0 || id === undefined || id < 0) {
            const xs = lut.xs, ys = lut.ys, last = lut.last;
            const ox = soa.x, oy = soa.y, oz = soa.z;
            const invN = n > 0 ? 1 / n : 0;
            await _chunkedRange(n, options.chunkSize, options.yieldEvery, function (s, e) {
                for (let k = s; k < e; k++) {
                    let tp = spread ? (k * invN + et) : et;
                    if (loop) { tp = tp % 1; if (tp < 0) { tp += 1; } }
                    else if (tp < 0) { tp = 0; } else if (tp > 1) { tp = 1; }
                    let x = tp * last; if (x > last) { x = last; }
                    const i = x | 0;
                    const j = i < last ? i + 1 : last;
                    const f = x - i;
                    const a0 = xs[i], a1 = ys[i];
                    const px = a0 + (xs[j] - a0) * f;
                    const py = a1 + (ys[j] - a1) * f;
                    if (mode === 0) { ox[k] = px; oy[k] = py; }
                    else if (mode === 1) { ox[k] = px; oz[k] = py; }
                    else { oy[k] = px; oz[k] = py; }
                }
            });
            return soa;
        }

        const res = await this._post({
            id: this._nextId++, op: "run", lutId: id,
            n: n, et: et, mode: mode, spread: spread, loop: loop,
            ox: soa.x, oy: soa.y, oz: soa.z
        }, mode === 0 ? [soa.x.buffer, soa.y.buffer]
            : mode === 1 ? [soa.x.buffer, soa.z.buffer]
                : [soa.y.buffer, soa.z.buffer]);

        soa.x = res.ox; soa.y = res.oy; soa.z = res.oz;
        if (soa.arrays) { soa.arrays[0] = soa.x; soa.arrays[1] = soa.y; soa.arrays[2] = soa.z; }
        return soa;
    }

    async detach(lut) {
        const id = this._attached.get(lut);
        if (id === undefined || id < 0 || this._workers.length === 0) { return false; }
        this._attached.delete(lut);
        await this._post({ id: this._nextId++, op: "detach", lutId: id }, []);
        return true;
    }

    dispose() {
        this._disposed = true;
        for (let i = 0; i < this._workers.length; i++) { this._workers[i].terminate(); }
        this._workers.length = 0;
        this._idle.length = 0;
        for (const job of this._pending.values()) { job.reject(new Error("PathWorkerPool disposed")); }
        this._pending.clear();
        for (let i = 0; i < this._queue.length; i++) { this._queue[i].reject(new Error("PathWorkerPool disposed")); }
        this._queue.length = 0;
        if (this._url) { URL.revokeObjectURL(this._url); this._url = null; }
    }
}

function createPathWorkerPool(size) { return new PathWorkerPool(size); }

// ============================================================================
// 19. MATH NAMESPACE — the provided SOA stack stays the default maths
// ============================================================================
const math = {
    common: common,
    utils: utils,
    easings: easings,
    animation: animationModule,
    engine: engineModule,
    vec2: vec2, vec3: vec3, vec4: vec4,
    mat2: mat2, mat3: null, mat4: mat4,
    quat: quat, quat2: quat2,
    bitecs: null, simplex: null,
    svg: null
};

/** Optional modules load dynamically; a failure never breaks this module. */
const mathReady = Promise.allSettled([
    import("./006_mat3.js").then(function (m) { math.mat3 = m; }),
    import("./010_bitECS_core.js").then(function (m) { math.bitecs = m; }),
    import("./013_simplex.js").then(function (m) { math.simplex = m; })
]);

math.svg = {
    svg: svg,
    samplePath: samplePath,
    createPathLUT: createPathLUT,
    createSOAMotionPath: createSOAMotionPath,
    createSOAPathFrames: createSOAPathFrames,
    createPathWorkerPool: createPathWorkerPool
};

// ============================================================================
// 20. EXPORTS — every original export preserved + the 1M-scale parallel layer
// ============================================================================
export {
    // foundation
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC, EPSILON, DEFAULT_LUT_SAMPLES,
    SVG_NS,
    // original API
    samplePath, createMorphablePaths, svg,
    // zero-GC flat sampling
    samplePathFlat, samplePathFlatChunked,
    // chunked async
    samplePathAsync,
    // pooled morph
    pooledMorph, releaseMorphPool,
    // SOA
    samplePathIntoSOA, samplePathIntoSOAChunked,
    createSOAPathMorph, createSOAMotionPath, createKeplerMotionPath,
    // IK
    createIKMotionPath,
    // color
    createPathColorGradient,
    // bitECS glyphs
    createGlyphPathAnimation,
    // helpers
    getHelperPath, releaseHelperPath,
    // arc-length LUT (1M-scale primitive)
    createPathLUT, createPathLUTChunked, samplePathLUT,
    // tangent / normal / quaternion frames
    createPathFrames, createSOAPathFrames, createSOAPathDualQuats,
    // three.js r185 bridges
    pathToBufferGeometry, pathToLineGeometry,
    attachPathToInstancedMesh, createThreeMotionPath,
    // parallelism
    PathWorkerPool, createPathWorkerPool,
    // namespace
    math, mathReady
};

export default {
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC, EPSILON, DEFAULT_LUT_SAMPLES,
    SVG_NS,
    samplePath, createMorphablePaths, svg,
    samplePathFlat, samplePathFlatChunked,
    samplePathAsync,
    pooledMorph, releaseMorphPool,
    samplePathIntoSOA, samplePathIntoSOAChunked,
    createSOAPathMorph, createSOAMotionPath, createKeplerMotionPath,
    createIKMotionPath,
    createPathColorGradient,
    createGlyphPathAnimation,
    getHelperPath, releaseHelperPath,
    createPathLUT, createPathLUTChunked, samplePathLUT,
    createPathFrames, createSOAPathFrames, createSOAPathDualQuats,
    pathToBufferGeometry, pathToLineGeometry,
    attachPathToInstancedMesh, createThreeMotionPath,
    PathWorkerPool, createPathWorkerPool,
    math, mathReady
};

// Continue with next file: src/math/024_draggable.js (pointer / gesture system —
// pooled draggables, inertia + spring snap, SOA hit-testing over 1M+ instances
// via the spatial grid, IK-driven grab targets, and three.js r185 raycast
// bridging)?