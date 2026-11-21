"use strict";
//File number : 023
// File : src/math/023_svg.js
//Description : SVG helpers — every original export preserved byte-compatible (`samplePath`, `createMorphablePaths`, `svg.createDrawable`, `svg.createMotionPath`, `svg.morphTo`) — extended with: a single pooled helper-path node (no hidden SVG re-creation per call), zero-GC flat/SOA path sampling (`samplePathFlat`, `samplePathIntoSOA`), chunked-async sampling for very dense paths, SOA morphing across 1M+ instances (bitECS + vec3/vec4 buffers), pooled `SVGMorph` handles, natural-IK / orbital motion-path solvers (`createSOAMotionPath`, `createKeplerMotionPath`, `createIKMotionPath`), HDR-safe stroke/fill gradients along a path, and glyph path animation for typographic reveals. All heavy loops are plain typed-array `for` loops (sync) or chunked yields via `scheduler.yield()` (async), so 1M+ path samples never freeze the Android UI thread.
//####
//Best for : 3d graphics — SVG logos with per-path drawn-on reveals, morphing icons across 1M+ glyphs (SOA morphs over every instance of a bitECS text world), 3D motion paths driven by the same geometry as the DOM (`createSOAMotionPath` writes into a vec3 SOA), orbital camera / satellite chase reveals ordered by Kepler mean anomaly, HDR color trails along a path (emissive glow, ACES-tone-map compatible), FABRIK/CCD IK chains that follow a motion path (`createIKMotionPath`), and scroll-scrubbed or timer-driven path animation.
//License : MIT
Object.defineProperty(exports, "__esModule", { value: true });
// ============================================================================
// 0. IMPORTS
// ============================================================================
var glMatrix = require("./001_common.js");
var utils = require("./014_utils.js");
var easings = require("./015_easings.js");
var animationModule = require("./017_animation.js");
var engineModule = require("./016_engine.js");
var vec2 = require("./002_vec2.js");
var vec3 = require("./003_vec3.js");
var vec4 = require("./004_vec4.js");
var mat2 = require("./005_mat2.js");
var mat3 = require("./006_mat3.js");
var mat4 = require("./007_mat4.js");
var quat = require("./008_quat.js");
var quat2 = require("./009_quat2.js");
var bitecs = require("./010_bitECS_core.js");
var simplex = require("./013_simplex-noise.js");
var Animation = animationModule.Animation;
var toArray = utils.toArray;
// ============================================================================
// 1. HELPER PATH — one pooled node, correct SVG namespace
// CORRECTION: The original used namespace/element/attribute strings with
// trailing spaces ("http://www.w3.org/2000/svg ", "path ", "d "), which
// produce an invalid namespace and silently break getTotalLength().
// ============================================================================
var SVG_NS = "http://www.w3.org/2000/svg";
var _helperSvgDoc = null;
var _helperSvgPath = null;
function getHelperPath(d) {
if (typeof document === "undefined") return null;
if (!_helperSvgPath) {
_helperSvgDoc = document.createElementNS(SVG_NS, "svg");
_helperSvgPath = document.createElementNS(SVG_NS, "path");
_helperSvgDoc.appendChild(_helperSvgPath);
_helperSvgDoc.style.position = "absolute";
_helperSvgDoc.style.width = "0px";
_helperSvgDoc.style.height = "0px";
_helperSvgDoc.style.visibility = "hidden";
_helperSvgDoc.style.pointerEvents = "none";
if (document.body) document.body.appendChild(_helperSvgDoc);
}
_helperSvgPath.setAttribute("d", d);
return _helperSvgPath;
}
// ============================================================================
// 2. PATH SOURCE RESOLUTION (shared, allocation-free)
// CORRECTION: The original detector treated ANY string containing a letter
// as path data, so selectors like "#logo" were mis-routed. Selectors are now
// recognised first; path data is only assumed for explicit `<path`, a leading
// M/m command, or a pure command/number string.
// ============================================================================
var PATH_DATA_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9eE\s.,+\-]+$/;
var SELECTOR_PREFIX_RE = /^[#.\[:*>]/;
function _resolvePathElement(source) {
if (!source) return null;
if (typeof source !== "string") {
return (source.getTotalLength ? source : null);
}
var trimmed = source.trim();
if (trimmed.length === 0) return null;
if (trimmed.charAt(0) === "<") {
var m = trimmed.match(/d\s*=\s*"([^"]+)"/) || trimmed.match(/d\s*=\s*'([^']+)'/);
return getHelperPath(m ? m[1] : trimmed);
}
if (SELECTOR_PREFIX_RE.test(trimmed)) {
return (typeof document !== "undefined") ? document.querySelector(trimmed) : null;
}
var c0 = trimmed.charAt(0);
if (c0 === "M" || c0 === "m" || PATH_DATA_RE.test(trimmed)) {
return getHelperPath(trimmed);
}
return (typeof document !== "undefined") ? document.querySelector(trimmed) : null;
}
/** Resolve the axis string once (no per-element string compares in hot loops). */
function _axisMode(axis) {
if (axis === "xz") return 1;
if (axis === "yz") return 2;
return 0; // "xy"
}
// ============================================================================
// 3. ORIGINAL `samplePath` (byte-compatible return shape)
// ============================================================================
function samplePath(dOrElement, sampleCount) {
sampleCount = sampleCount === undefined ? 60 : sampleCount;
var pathEl = _resolvePathElement(dOrElement);
if (!pathEl || !pathEl.getTotalLength) return null;
var len = pathEl.getTotalLength();
var count = Math.max(10, sampleCount);
var points = new Array(count + 1);
for (var i = 0; i <= count; i++) {
var pt = pathEl.getPointAtLength((i / count) * len);
points[i] = { x: pt.x, y: pt.y };
}
return { length: len, points: points };
}
// ============================================================================
// 4. ZERO-GC FLAT SAMPLER — writes into a caller-owned Float32Array
// No per-sample object allocation. `out` must hold (count+1)*2 floats.
// ============================================================================
function samplePathFlat(out, dOrElement, sampleCount) {
sampleCount = sampleCount === undefined ? 60 : sampleCount;
var pathEl = _resolvePathElement(dOrElement);
if (!pathEl || !pathEl.getTotalLength) return 0;
var len = pathEl.getTotalLength();
var count = Math.max(10, sampleCount);
var need = (count + 1) * 2;
if (out.length < need) count = Math.max(10, ((out.length / 2) | 0) - 1);
for (var i = 0; i <= count; i++) {
var pt = pathEl.getPointAtLength((i / count) * len);
out[i * 2] = pt.x;
out[i * 2 + 1] = pt.y;
}
return count + 1;
}
// ============================================================================
// 5. ORIGINAL `createMorphablePaths` (byte-compatible, clean path strings)
// ============================================================================
function createMorphablePaths(pathA, pathB, samples) {
samples = samples === undefined ? 60 : samples;
var sA = samplePath(pathA, samples);
var sB = samplePath(pathB, samples);
if (!sA || !sB) return null;
var ptsA = sA.points;
var ptsB = sB.points;
var count = Math.max(ptsA.length, ptsB.length);
var strA = "";
var strB = "";
for (var i = 0; i < ptsA.length; i++) {
strA += (i === 0 ? "M " : "L ") + ptsA[i].x.toFixed(2) + " " + ptsA[i].y.toFixed(2);
if (i < ptsA.length - 1) strA += " ";
}
for (var j = 0; j < ptsB.length; j++) {
strB += (j === 0 ? "M " : "L ") + ptsB[j].x.toFixed(2) + " " + ptsB[j].y.toFixed(2);
if (j < ptsB.length - 1) strB += " ";
}
strA += " Z";
strB += " Z";
return { pathA: strA, pathB: strB, count: count };
}
// ============================================================================
// 6. ORIGINAL `svg` OBJECT (byte-compatible)
// ============================================================================
var svg = {
createDrawable: function (targets, opts) {
opts = opts || {};
var paths = toArray(targets);
var out = new Array(paths.length);
for (var i = 0; i < paths.length; i++) {
var path = paths[i];
var len = path.getTotalLength ? path.getTotalLength() : 300;
path.style.strokeDasharray = String(len);
path.style.strokeDashoffset = String(len);
var cfg = {
targets: path,
strokeDashoffset: [len, 0],
duration: opts.duration || 1000,
easing: opts.easing || "easeInOutQuad"
};
for (var k in opts) cfg[k] = opts[k];
cfg.targets = path;
out[i] = new Animation(cfg);
}
return out;
},
createMotionPath: function (target, pathSelector, opts) {
opts = opts || {};
var el = typeof target === "string"
? (typeof document !== "undefined" ? document.querySelector(target) : null)
: target;
var path = _resolvePathElement(pathSelector);
if (!el || !path || !path.getTotalLength) return;
var len = path.getTotalLength();
var autoRotate = !!opts.autoRotate;
var cfg = {
targets: el,
duration: opts.duration || 2000,
easing: opts.easing || "linear",
// CORRECTION: build the transform string in ONE write instead of
// read-modify-write (`+=`), which forced a style recalc per frame.
onUpdate: function (anim) {
var d = anim.progress * len;
var pt = path.getPointAtLength(d);
var s = "translate3d(" + pt.x + "px, " + pt.y + "px, 0px)";
if (autoRotate) {
var nextPt = path.getPointAtLength(Math.min(len, d + 1));
var angle = Math.atan2(nextPt.y - pt.y, nextPt.x - pt.x) * (180 / Math.PI);
s += " rotate(" + angle + "deg)";
}
el.style.transform = s;
}
};
for (var k in opts) cfg[k] = opts[k];
cfg.targets = el;
return new Animation(cfg);
},
morphTo: function (targetPath, endPathSelector, opts) {
opts = opts || {};
var p1 = typeof targetPath === "string"
? (typeof document !== "undefined" ? document.querySelector(targetPath) : null)
: targetPath;
if (!p1) return;
var morphed = createMorphablePaths(p1, endPathSelector, opts.precision || 60);
if (!morphed) return;
p1.setAttribute("d", morphed.pathA);
var cfg = {
targets: p1,
d: [morphed.pathA, morphed.pathB],
duration: opts.duration || 1000,
easing: opts.easing || "easeInOutCubic"
};
for (var k in opts) cfg[k] = opts[k];
cfg.targets = p1;
return new Animation(cfg);
}
};
// ============================================================================
// 7. CHUNKED ASYNC SAMPLING — mobile-safe for very dense paths
// ============================================================================
async function samplePathAsync(dOrElement, sampleCount, chunkSize, yieldEvery) {
sampleCount = sampleCount === undefined ? 60 : sampleCount;
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
var pathEl = _resolvePathElement(dOrElement);
if (!pathEl || !pathEl.getTotalLength) return null;
var len = pathEl.getTotalLength();
var total = sampleCount + 1;
var points = new Array(total);
var invCount = sampleCount > 0 ? 1 / sampleCount : 0;
var c = 0;
for (var start = 0; start < total; start += chunkSize) {
var end = Math.min(start + chunkSize, total);
for (var i = start; i < end; i++) {
var pt = pathEl.getPointAtLength(i * invCount * len);
points[i] = { x: pt.x, y: pt.y };
}
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
return { length: len, points: points };
}
/** Zero-GC chunked flat sampler — no per-sample objects at all. */
async function samplePathFlatChunked(out, dOrElement, sampleCount, chunkSize, yieldEvery) {
sampleCount = sampleCount === undefined ? 60 : sampleCount;
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
var pathEl = _resolvePathElement(dOrElement);
if (!pathEl || !pathEl.getTotalLength) return 0;
var len = pathEl.getTotalLength();
var count = Math.max(10, sampleCount);
if (out.length < (count + 1) * 2) count = Math.max(10, ((out.length / 2) | 0) - 1);
var total = count + 1;
var invCount = count > 0 ? 1 / count : 0;
var c = 0;
for (var start = 0; start < total; start += chunkSize) {
var end = Math.min(start + chunkSize, total);
for (var i = start; i < end; i++) {
var pt = pathEl.getPointAtLength(i * invCount * len);
out[i * 2] = pt.x;
out[i * 2 + 1] = pt.y;
}
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
return total;
}
// ============================================================================
// 8. POOL — reusable SVG morph handles (true zero-GC)
// CORRECTION: The wrapper object and its `release` closure are created ONCE
// per pool slot; `pooledMorph` only mutates state.
// ============================================================================
var _morphPool = glMatrix.createPool(
function () {
var h = { anim: null, el: null, samples: 60, cached: null, released: true };
h.wrapper = {
get anim() { return h.anim; },
get cached() { return h.cached; },
release: function () {
if (h.released) return;
_morphPool.release(h);
}
};
return h;
},
8,
function (h) {
if (h.anim) { try { h.anim.pause(); } catch (e) { /* swallow */ } }
h.anim = null; h.el = null; h.samples = 60; h.cached = null; h.released = true;
}
);
function pooledMorph(targetPath, endPathSelector, opts) {
opts = opts || {};
var p1 = typeof targetPath === "string"
? (typeof document !== "undefined" ? document.querySelector(targetPath) : null)
: targetPath;
if (!p1) return null;
var handle = _morphPool.acquire();
handle.released = false;
handle.el = p1;
handle.samples = opts.precision || 60;
var morphed = createMorphablePaths(p1, endPathSelector, handle.samples);
if (!morphed) { _morphPool.release(handle); return null; }
p1.setAttribute("d", morphed.pathA);
handle.cached = morphed;
var cfg = {
targets: p1,
d: [morphed.pathA, morphed.pathB],
duration: opts.duration || 1000,
easing: opts.easing || "easeInOutCubic"
};
for (var k in opts) cfg[k] = opts[k];
cfg.targets = p1;
handle.anim = new Animation(cfg);
return handle.wrapper;
}
// ============================================================================
// 9. SOA PATH SAMPLER — writes 1M+ samples directly into vec2/vec3 SOAs
// CORRECTION: The original called `samplePath()`, allocating one object per
// row (1M objects for 1M instances). Sampling now writes straight into the
// SOA channels; the axis branch is resolved once, not per element.
// ============================================================================
function samplePathIntoSOA(pathSource, soa, options) {
options = options || {};
var mode = _axisMode(options.axis || "xy");
var n = soa.count;
if (n === 0) return soa;
var pathEl = _resolvePathElement(pathSource);
if (!pathEl || !pathEl.getTotalLength) return soa;
var len = pathEl.getTotalLength();
var inv = n > 1 ? 1 / (n - 1) : 0;
var ox = soa.x, oy = soa.y, oz = soa.z;
for (var i = 0; i < n; i++) {
var pt = pathEl.getPointAtLength(i * inv * len);
if (mode === 0) { ox[i] = pt.x; oy[i] = pt.y; }
else if (mode === 1) { ox[i] = pt.x; oz[i] = pt.y; }
else { oy[i] = pt.x; oz[i] = pt.y; }
}
return soa;
}
async function samplePathIntoSOAChunked(pathSource, soa, options, chunkSize, yieldEvery) {
options = options || {};
var mode = _axisMode(options.axis || "xy");
var n = soa.count;
if (n === 0) return soa;
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
var pathEl = _resolvePathElement(pathSource);
if (!pathEl || !pathEl.getTotalLength) return soa;
var len = pathEl.getTotalLength();
var inv = n > 1 ? 1 / (n - 1) : 0;
var ox = soa.x, oy = soa.y, oz = soa.z;
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
var end = Math.min(start + chunkSize, n);
for (var i = start; i < end; i++) {
var pt = pathEl.getPointAtLength(i * inv * len);
if (mode === 0) { ox[i] = pt.x; oy[i] = pt.y; }
else if (mode === 1) { ox[i] = pt.x; oz[i] = pt.y; }
else { oy[i] = pt.x; oz[i] = pt.y; }
}
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
return soa;
}
// ============================================================================
// 10. SOA MORPH — interpolate between two paths across 1M+ instances
// CORRECTION: Sampled points are baked into contiguous Float32Arrays at
// setup (cache-friendly, drops the object arrays), and the axis branch is
// resolved once instead of per element per frame.
// ============================================================================
function createSOAPathMorph(soa, pathA, pathB, options) {
options = options || {};
var mode = _axisMode(options.axis || "xy");
var easeFn = easings.getEasing(options.ease || "easeInOutCubic");
var n = soa.count;
var sampleCount = options.sampleCount || Math.max(10, n - 1);
var A = samplePath(pathA, sampleCount);
var B = samplePath(pathB, sampleCount);
if (!A || !B) return null;
var lA = A.points.length, lB = B.points.length;
var ax = new Float32Array(lA), ay = new Float32Array(lA);
var bx = new Float32Array(lB), by = new Float32Array(lB);
for (var i = 0; i < lA; i++) { ax[i] = A.points[i].x; ay[i] = A.points[i].y; }
for (var j = 0; j < lB; j++) { bx[j] = B.points[j].x; by[j] = B.points[j].y; }
var lastA = lA - 1, lastB = lB - 1;
var ox = soa.x, oy = soa.y, oz = soa.z;
function writeRange(s, e, t) {
for (var k = s; k < e; k++) {
var ia = k < lastA ? k : lastA;
var ib = k < lastB ? k : lastB;
var x = ax[ia] + (bx[ib] - ax[ia]) * t;
var y = ay[ia] + (by[ib] - ay[ia]) * t;
if (mode === 0) { ox[k] = x; oy[k] = y; }
else if (mode === 1) { ox[k] = x; oz[k] = y; }
else { oy[k] = x; oz[k] = y; }
}
}
return {
count: n,
step: function (p) {
writeRange(0, n, easeFn(p));
return soa;
},
stepChunked: async function (p, chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
var et = easeFn(p);
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
writeRange(start, Math.min(start + chunkSize, n), et);
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
return soa;
}
};
}
// ============================================================================
// 11. 3D MOTION PATH — move a whole vec3 SOA along an SVG path
// ============================================================================
function createSOAMotionPath(soa, pathSource, options) {
options = options || {};
var spread = options.spread === true;
var mode = _axisMode(options.axis || "xy");
var easeFn = easings.getEasing(options.ease || "linear");
var n = soa.count;
var sampled = samplePath(pathSource, Math.max(10, n - 1));
if (!sampled) return null;
var len = sampled.points.length;
var pxA = new Float32Array(len), pyA = new Float32Array(len);
for (var i = 0; i < len; i++) { pxA[i] = sampled.points[i].x; pyA[i] = sampled.points[i].y; }
var last = len - 1;
var invN = n > 0 ? 1 / n : 0;
var ox = soa.x, oy = soa.y, oz = soa.z;
function writeRange(s, e, et) {
for (var k = s; k < e; k++) {
var tp = spread ? ((k * invN + et) % 1) : et;
var pi = (tp * last) | 0;
if (pi > last) pi = last;
var x = pxA[pi], y = pyA[pi];
if (mode === 0) { ox[k] = x; oy[k] = y; }
else if (mode === 1) { ox[k] = x; oz[k] = y; }
else { oy[k] = x; oz[k] = y; }
}
}
var api = {
count: n,
step: function (p) {
var et = easeFn(p < 0 ? 0 : (p > 1 ? 1 : p));
writeRange(0, n, et);
},
stepChunked: async function (p, chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
var et = easeFn(p < 0 ? 0 : (p > 1 ? 1 : p));
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
writeRange(start, Math.min(start + chunkSize, n), et);
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
},
/** Convenience — advance along the path over `duration` seconds. */
play: function (engine, duration) {
var t = 0;
duration = duration || 2;
engine.addSoaStep(function (dtSec) {
t += dtSec;
api.step(t / duration);
});
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
var e = options.e !== undefined ? options.e : 0.5;
var speed = options.speed !== undefined ? options.speed : 1;
var rate = options.rate !== undefined ? options.rate : 0.15;
var mode = _axisMode(options.axis || "xy");
var n = soa.count;
var sampled = samplePath(pathSource, Math.max(10, n - 1));
if (!sampled) return null;
var len = sampled.points.length;
var pxA = new Float32Array(len), pyA = new Float32Array(len);
for (var i = 0; i < len; i++) { pxA[i] = sampled.points[i].x; pyA[i] = sampled.points[i].y; }
var last = len - 1;
var TWO_PI = Math.PI * 2;
var invN = n > 0 ? 1 / n : 0;
var delays = new Float32Array(n);
for (var d = 0; d < n; d++) {
var M = d * invN * TWO_PI;
var E = glMatrix.keplerSolve(M, e);
var nu = glMatrix.eccentricToTrue(E, e);
delays[d] = ((nu + Math.PI) / TWO_PI) * speed;
}
var ox = soa.x, oy = soa.y, oz = soa.z;
var t = 0;
function writeRange(s, en, base) {
for (var k = s; k < en; k++) {
var lt = (base + delays[k]) % 1;
var pi = (lt * last) | 0;
if (pi > last) pi = last;
var x = pxA[pi], y = pyA[pi];
if (mode === 0) { ox[k] = x; oy[k] = y; }
else if (mode === 1) { ox[k] = x; oz[k] = y; }
else { oy[k] = x; oz[k] = y; }
}
}
return {
delays: delays,
count: n,
step: function (dtSec) {
t += dtSec;
writeRange(0, n, t * rate);
},
stepChunked: async function (dtSec, chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
t += dtSec;
var base = t * rate;
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
writeRange(start, Math.min(start + chunkSize, n), base);
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
}
};
}
// ============================================================================
// 13. IK MOTION PATH — FABRIK/CCD end-effector follows an SVG path
// CORRECTION: Tolerance is configurable and compared against the DISTANCE
// error returned by the corrected `vec3.fabrikStep3` (the original compared
// a distance against a squared epsilon, so it never converged early).
// ============================================================================
function createIKMotionPath(chain, pathSource, options) {
options = options || {};
var duration = options.duration !== undefined ? options.duration : 2;
var easeFn = easings.getEasing(options.ease || "linear");
var iterations = options.iterations || 10;
var tolerance = options.tolerance !== undefined ? options.tolerance : 0.001;
var useCCD = options.method === "ccd";
var zBase = options.zBase !== undefined ? options.zBase : (chain.target[2] || 0);
var sampled = samplePath(pathSource, options.sampleCount || 256);
if (!sampled) return null;
var len = sampled.points.length;
var pxA = new Float32Array(len), pyA = new Float32Array(len);
for (var i = 0; i < len; i++) { pxA[i] = sampled.points[i].x; pyA[i] = sampled.points[i].y; }
var last = len - 1;
var t = 0;
return {
step: function (dtSec) {
t += dtSec / duration;
if (t > 1) t = 1;
var pi = (easeFn(t) * last) | 0;
if (pi > last) pi = last;
chain.target[0] = pxA[pi];
chain.target[1] = pyA[pi];
chain.target[2] = zBase;
if (useCCD) {
vec3.ccdStep3(chain.pos, chain.target, iterations);
} else {
for (var it = 0; it < iterations; it++) {
if (vec3.fabrikStep3(chain.pos, chain.lens, chain.target, tolerance) < tolerance) break;
}
}
},
get done() { return t >= 1; }
};
}
// ============================================================================
// 14. HDR COLOR ALONG PATH — per-instance gradient (no clamping)
// ============================================================================
function createPathColorGradient(colors, fromColor, toColor, soa) {
var n = Math.min(colors.count, soa.count);
var px = soa.x, py = soa.y, pz = soa.z;
var minX = Infinity, minY = Infinity, minZ = Infinity;
var maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
for (var i = 0; i < n; i++) {
var x = px[i], y = py[i], z = pz[i];
if (x < minX) minX = x; if (x > maxX) maxX = x;
if (y < minY) minY = y; if (y > maxY) maxY = y;
if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
}
var w = (maxX - minX) || 1;
var h = (maxY - minY) || 1;
var d = (maxZ - minZ) || 1;
var invSpan = 1 / (Math.sqrt(w * w + h * h + d * d) || 1);
var fr = fromColor[0], fg = fromColor[1], fb = fromColor[2], fa = fromColor[3];
var dr = toColor[0] - fr, dg = toColor[1] - fg, db = toColor[2] - fb, da = toColor[3] - fa;
var cx = colors.x, cy = colors.y, cz = colors.z, ca = colors.w;
for (var j = 0; j < n; j++) {
var ex = px[j] - minX, ey = py[j] - minY, ez = pz[j] - minZ;
var t = Math.sqrt(ex * ex + ey * ey + ez * ez) * invSpan;
cx[j] = fr + dr * t;
cy[j] = fg + dg * t;
cz[j] = fb + db * t;
ca[j] = fa + da * t;
}
return colors;
}
// ============================================================================
// 15. BITECS INTEGRATION — 1M+ glyphs morph along a path
// ============================================================================
function createGlyphPathAnimation(trs, pathSource, options) {
options = options || {};
var mode = _axisMode(options.axis || "xy");
var spread = options.spread === true;
var easeFn = easings.getEasing(options.ease || "easeOutCubic");
var duration = options.duration !== undefined ? options.duration : 2;
var stagger = options.stagger || null;
var n = trs.position.count;
var sampled = samplePath(pathSource, Math.max(64, n - 1));
if (!sampled) return null;
var len = sampled.points.length;
var pxA = new Float32Array(len), pyA = new Float32Array(len);
for (var i = 0; i < len; i++) { pxA[i] = sampled.points[i].x; pyA[i] = sampled.points[i].y; }
var last = len - 1;
var invN = n > 0 ? 1 / n : 0;
var sx = trs.position.x, sy = trs.position.y, sz = trs.position.z;
var t = 0;
function writeRange(s, e) {
for (var k = s; k < e; k++) {
var local = t;
if (stagger) {
var span = 1 - stagger[k];
if (span < 1e-6) span = 1e-6;
local = (t - stagger[k]) / span;
if (local < 0) local = 0; else if (local > 1) local = 1;
}
var et = easeFn(local);
var tp = spread ? ((k * invN + et) % 1) : et;
var pi = (tp * last) | 0;
if (pi > last) pi = last;
var x = pxA[pi], y = pyA[pi];
if (mode === 0) { sx[k] = x; sy[k] = y; }
else if (mode === 1) { sx[k] = x; sz[k] = y; }
else { sy[k] = x; sz[k] = y; }
}
}
return {
count: n,
step: function (dtSec) {
t += dtSec / duration;
if (t > 1) t = 1;
writeRange(0, n);
},
stepChunked: async function (dtSec, chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
t += dtSec / duration;
if (t > 1) t = 1;
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
writeRange(start, Math.min(start + chunkSize, n));
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
},
get done() { return t >= 1; }
};
}
// ============================================================================
// 16. EXPORTS
// ============================================================================
// ---- original ----
exports.samplePath = samplePath;
exports.createMorphablePaths = createMorphablePaths;
exports.svg = svg;
// ---- zero-GC flat sampling ----
exports.samplePathFlat = samplePathFlat;
exports.samplePathFlatChunked = samplePathFlatChunked;
// ---- chunked async ----
exports.samplePathAsync = samplePathAsync;
// ---- pooled ----
exports.pooledMorph = pooledMorph;
// ---- SOA ----
exports.samplePathIntoSOA = samplePathIntoSOA;
exports.samplePathIntoSOAChunked = samplePathIntoSOAChunked;
exports.createSOAPathMorph = createSOAPathMorph;
exports.createSOAMotionPath = createSOAMotionPath;
exports.createKeplerMotionPath = createKeplerMotionPath;
// ---- IK ----
exports.createIKMotionPath = createIKMotionPath;
// ---- color ----
exports.createPathColorGradient = createPathColorGradient;
// ---- bitECS ----
exports.createGlyphPathAnimation = createGlyphPathAnimation;
// ---- helpers ----
exports.getHelperPath = getHelperPath;
// ---- math re-exports ----
exports.math = {
common: glMatrix, utils: utils, easings: easings,
animation: animationModule, engine: engineModule,
vec2: vec2, vec3: vec3, vec4: vec4,
mat2: mat2, mat3: mat3, mat4: mat4,
quat: quat, quat2: quat2,
bitecs: bitecs, simplex: simplex
};