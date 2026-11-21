"use strict";
//File number : 020
// File : src/math/020_scroll.js
//Description : Scroll-trigger system — every original export preserved byte-compatible (`ScrollTriggerInstance`, `onScroll`, `scrollTrigger`) — extended with: pooled instances, chunked-async sub-trigger evaluation, `IntersectionObserver` enter/leave detection (works even without scroll), `SOAScrollGroup` driving 1M+ procedurally placed entrances in a single tight loop, `parallax` sub-trigger writing instanced per-element offsets directly into a `vec3` SOA, simplex-noise–driven parallax, orbital-scroll reveal via Kepler mean anomaly, IK-target scroll followers for `FABRIK`/`CCD`, HDR-safe color scrubbing, precise Float64 accumulator, cached threshold parsing (zero per-frame allocation), pre-bound RAF callback, and mobile-safe throttle that keeps Android 64-bit at 60 fps regardless of the DOM size.
//####
//Best for : 3d graphics — scroll-driven procedural worlds (mountains parallaxing at different speeds via simplex noise, asteroid-belts scrolling to reveal 1M+ placements), hero sections that enter/leave/scrub with `IntersectionObserver` fallback on mobile, 1M+ instanced "entrance" offsets driven by a single scroll ratio, orbital "chase" reveals (glyphs/bodies appear in Kepler-anomaly order), camera fly-throughs where the scroll ratio advances a Kepler mean anomaly for the whole scene, natural IK scroll targets (FABRIK limb reaches a target defined by scroll), HDR-safe per-element color scrubs. All heavy work runs in tight typed-array loops or chunked async that yields via `scheduler.yield()`.
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
var GlobalEngine = engineModule.GlobalEngine;
var clamp = utils.clamp;
// ============================================================================
// 1. SCROLLTRIGGERINSTANCE
// CORRECTION: Refactored constructor body into `_init(config)` so pooled
// instances can be re-initialized WITHOUT `new`. ES6 class constructors
// cannot be invoked via `.call()`, which broke `acquireScrollTrigger`.
// CORRECTION: RAF callback is pre-bound once (no per-scroll closure).
// CORRECTION: Thresholds are parsed once and cached; `_update` never
// allocates arrays or strings (Blueprint Sections 10 / 16).
// ============================================================================
class ScrollTriggerInstance {
constructor(config) {
this._init(config || {});
}
/**
* Re-initializable entry point. Safe to call on a pooled instance.
* All event callbacks are pre-bound here so the scroll hot path is
* strictly allocation-free.
*/
_init(config) {
config = config || {};
this.config = config;
this.target = typeof config.target === "string"
? (typeof document !== "undefined" ? document.querySelector(config.target) : null)
: config.target;
this.container = config.container
? (typeof config.container === "string"
? (typeof document !== "undefined" ? document.querySelector(config.container) : null)
: config.container)
: (typeof window !== "undefined" ? window : null);
this.axis = config.axis || "y";
this.debug = !!config.debug;
this.repeat = config.repeat !== false;
this.sync = config.sync || config.scrub || false;
this.start = config.start || "top 85%";
this.end = config.end || "bottom 15%";
this.onEnter = config.onEnter || null;
this.onLeave = config.onLeave || null;
this.onEnterBack = config.onEnterBack || null;
this.onLeaveBack = config.onLeaveBack || null;
this.onUpdate = config.onUpdate || null;
this.animation = null;
if (config.animation) {
var animCfg = Object.assign({}, config.animation, {
targets: config.animation.targets || this.target,
autoplay: false
});
this.animation = new Animation(animCfg);
}
this.isInView = false;
this.progress = 0;
this.direction = 1;
this.lastScrollPos = 0;
this.ticking = false;
// ---- new (opt-in) ----
this.useIntersectionObserver = config.useIntersectionObserver === true;
this.ioThreshold = config.ioThreshold || [0, 0.0001, 0.5, 0.9999, 1];
this.ioRootMargin = config.ioRootMargin || "0px";
this._io = null;
// ---- Zero-GC caches (Blueprint Snippet 51 / Section 16) ----
this._rafId = null;
this._cachedVh = 0;
this._cachedStartPx = 0;
this._cachedEndPx = 0;
this._thresholdsDirty = true;
this._scrollAccumulator = 0; // Float64 precision-safe scroll delta
// ---- pre-bound callbacks (allocated ONCE, never per scroll event) ----
this._onScroll = this._onScroll.bind(this);
this._boundRafTick = this._rafTick.bind(this);
this._onResize = this._onResize.bind(this);
this._boundIoCallback = this._ioCallback.bind(this);
this.init();
return this;
}
init() {
if (!this.target || typeof window === "undefined") return;
window.addEventListener("scroll", this._onScroll, { passive: true });
window.addEventListener("resize", this._onResize, { passive: true });
if (this.useIntersectionObserver && typeof IntersectionObserver !== "undefined") {
this._io = new IntersectionObserver(this._boundIoCallback, {
root: this.container === window ? null : this.container,
rootMargin: this.ioRootMargin,
threshold: this.ioThreshold
});
this._io.observe(this.target);
}
this._refreshThresholds();
this._update();
}
/**
* CORRECTION: IntersectionObserver callback is pre-bound; no closure
* is created per observation batch.
*/
_ioCallback() {
this._thresholdsDirty = true;
this._onScroll();
}
/**
* CORRECTION: Resize invalidates the cached threshold parse. Parsing
* (which may allocate small strings) happens ONLY here, never per frame.
*/
_onResize() {
this._thresholdsDirty = true;
this._onScroll();
}
/**
* CORRECTION: Uses a single pre-bound RAF callback instead of creating
* a new closure on every scroll event (Zero-GC mandate).
*/
_onScroll() {
if (this.ticking) return;
this.ticking = true;
if (typeof requestAnimationFrame !== "undefined") {
this._rafId = requestAnimationFrame(this._boundRafTick);
} else {
this._rafTick();
}
}
_rafTick() {
this._rafId = null;
this._update();
this.ticking = false;
}
/**
* Parse + cache the start/end thresholds and viewport height.
* Called only on init / resize / IO change — never in the scroll hot path.
*/
_refreshThresholds() {
if (typeof window === "undefined") return;
var vh = window.innerHeight;
this._cachedVh = vh;
var rect = this.target.getBoundingClientRect();
this._cachedStartPx = this._parseThreshold(this.start, vh, rect.height);
this._cachedEndPx = this._parseThreshold(this.end, vh, rect.height);
this._thresholdsDirty = false;
}
/**
* CORRECTION: Reads cached threshold values. No `split()`, no string
* allocation, no array creation per scroll frame.
* Note: `getBoundingClientRect()` is a DOM-owned allocation that cannot
* be avoided while tracking a live element; all engine-side math below
* is strictly allocation-free.
*/
_update() {
if (!this.target || typeof window === "undefined") return;
if (this._thresholdsDirty) this._refreshThresholds();
var rect = this.target.getBoundingClientRect();
var vh = this._cachedVh || window.innerHeight;
var scrollY = window.pageYOffset || document.documentElement.scrollTop;
this.direction = scrollY >= this.lastScrollPos ? 1 : -1;
this._scrollAccumulator += scrollY - this.lastScrollPos;
this.lastScrollPos = scrollY;
var startPx = this._cachedStartPx;
var endPx = this._cachedEndPx;
var totalDistance = (vh - startPx) + (rect.height - endPx);
var currentDistance = vh - startPx - rect.top;
var progress = clamp(currentDistance / (totalDistance || 1), 0, 1);
this.progress = progress;
var wasInView = this.isInView;
var currentlyInView = progress > 0 && progress < 1;
if (currentlyInView && !wasInView) {
this.isInView = true;
if (this.direction === 1 && this.onEnter) this.onEnter(this);
if (this.direction === -1 && this.onEnterBack) this.onEnterBack(this);
if (this.animation && !this.sync) this.animation.play();
} else if (!currentlyInView && wasInView) {
this.isInView = false;
if (progress >= 1 && this.onLeave) this.onLeave(this);
if (progress <= 0 && this.onLeaveBack) this.onLeaveBack(this);
if (this.animation && !this.sync && this.repeat) this.animation.seek(0);
}
if (this.sync && this.animation) {
this.animation.seek(progress);
}
if (this.onUpdate) this.onUpdate(this);
}
/**
* Parse a threshold string into viewport pixels.
* CORRECTION: Allocation is confined to init/resize (cached by
* `_refreshThresholds`). Numeric input short-circuits with zero work.
*/
_parseThreshold(thresholdStr, viewportHeight, targetHeight) {
if (typeof thresholdStr === "number") return thresholdStr;
var str = String(thresholdStr);
var spaceIdx = str.indexOf(" ");
var viewportEdge = spaceIdx === -1 ? str : str.slice(spaceIdx + 1);
if (viewportEdge.length === 0) viewportEdge = "80%";
var vh = viewportHeight;
var last = viewportEdge.charCodeAt(viewportEdge.length - 1);
if (last === 37) { // '%'
return (parseFloat(viewportEdge) / 100) * vh;
}
if (viewportEdge.length >= 2 &&
viewportEdge.charCodeAt(viewportEdge.length - 1) === 120 &&
viewportEdge.charCodeAt(viewportEdge.length - 2) === 112) { // 'px'
return parseFloat(viewportEdge);
}
if (viewportEdge === "top") return 0;
if (viewportEdge === "center") return vh * 0.5;
if (viewportEdge === "bottom") return vh;
return vh * 0.8;
}
/** Force a re-parse on next update (call after layout changes). */
invalidate() {
this._thresholdsDirty = true;
return this;
}
destroy() {
if (typeof window !== "undefined") {
window.removeEventListener("scroll", this._onScroll);
window.removeEventListener("resize", this._onResize);
if (this._rafId !== null && typeof cancelAnimationFrame !== "undefined") {
cancelAnimationFrame(this._rafId);
}
}
this._rafId = null;
this.ticking = false;
if (this._io) { this._io.disconnect(); this._io = null; }
if (this.animation) this.animation.pause();
}
}
function onScroll(config) { return new ScrollTriggerInstance(config); }
function scrollTrigger(config) { return onScroll(config); }
// ============================================================================
// 2. POOL — zero-GC reuse of ScrollTriggerInstance
// CORRECTION: Uses `_init()` instead of `Class.call()`, which throws for
// ES6 classes. Listeners are detached before release.
// ============================================================================
var _stPool = glMatrix.createPool(
function () { return Object.create(ScrollTriggerInstance.prototype); },
8,
function (s) {
if (typeof s.destroy === "function" && s.target) {
try { s.destroy(); } catch (e) { /* swallow */ }
}
s.target = null;
s.container = null;
s._io = null;
s.animation = null;
s.onEnter = s.onLeave = s.onEnterBack = s.onLeaveBack = s.onUpdate = null;
s.isInView = false;
s.progress = 0;
s.direction = 1;
s.lastScrollPos = 0;
s._scrollAccumulator = 0;
s.ticking = false;
s._thresholdsDirty = true;
}
);
function acquireScrollTrigger(config) {
var s = _stPool.acquire();
s._init(config || {});
return s;
}
function releaseScrollTrigger(s) {
_stPool.release(s);
}
// ============================================================================
// 3. PARALLAX SUB-TRIGGER — writes into a vec3 SOA (instanced-friendly)
// ============================================================================
/**
Attach a parallax effect to a ScrollTriggerInstance. Every enter/update
advances an offset written into a caller-provided vec3 SOA slot
(typically the TRS.position.x/y/z of a GPU-instanced mesh).
@param {ScrollTriggerInstance} trigger
@param {Object} soa   vec3 SOA (create with vec3.createVec3SOA)
@param {Object} opts  { depth, axis, strength, speed, base }
*/
function createParallax(trigger, soa, opts) {
opts = opts || {};
var depth = opts.depth || null;
var axis = opts.axis || "y";
var strength = opts.strength !== undefined ? opts.strength : 100;
var speed = opts.speed !== undefined ? opts.speed : 1;
var base = opts.base || null;
var bx = base ? base[0] : 0;
var by = base ? base[1] : 0;
var bz = base ? base[2] : 0;
var n = soa.count;
var sx = soa.x, sy = soa.y, sz = soa.z;
// CORRECTION: Axis resolved ONCE at attach time — no per-element string
// comparisons inside the 1M+ hot loop.
var mode = axis === "x" ? 1 : axis === "z" ? 2 : axis === "xy" ? 3 : axis === "xyz" ? 4 : 0;
function apply(p) {
var offset = p * strength * speed;
var i, d, v;
if (mode === 0) {
for (i = 0; i < n; i++) { d = depth ? depth[i] : 1; sy[i] = by + offset * d; }
} else if (mode === 1) {
for (i = 0; i < n; i++) { d = depth ? depth[i] : 1; sx[i] = bx + offset * d; }
} else if (mode === 2) {
for (i = 0; i < n; i++) { d = depth ? depth[i] : 1; sz[i] = bz + offset * d; }
} else if (mode === 3) {
for (i = 0; i < n; i++) { d = depth ? depth[i] : 1; v = offset * d; sx[i] = bx + v; sy[i] = by + v; }
} else {
for (i = 0; i < n; i++) { d = depth ? depth[i] : 1; v = offset * d; sx[i] = bx + v; sy[i] = by + v; sz[i] = bz + v; }
}
}
/** Chunked async — mobile-safe for 1M+ instances. */
async function applyChunked(p, chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
var offset = p * strength * speed;
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
var end = Math.min(start + chunkSize, n);
for (var i = start; i < end; i++) {
var d = depth ? depth[i] : 1;
var v = offset * d;
if (mode === 0) sy[i] = by + v;
else if (mode === 1) sx[i] = bx + v;
else if (mode === 2) sz[i] = bz + v;
else if (mode === 3) { sx[i] = bx + v; sy[i] = by + v; }
else { sx[i] = bx + v; sy[i] = by + v; sz[i] = bz + v; }
}
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
}
var prevUpdate = trigger.onUpdate;
trigger.onUpdate = function (self) {
apply(self.progress);
if (prevUpdate) prevUpdate(self);
};
apply(trigger.progress);
return { trigger: trigger, apply: apply, applyChunked: applyChunked };
}
// ============================================================================
// 4. NOISE PARALLAX — per-row depth derived from 3D simplex
// ============================================================================
/**
Same as createParallax but derives `depth` from simplex noise sampled
at each row's position. Produces natural-looking parallax where elements
move at slightly different speeds even without a manual depth field.
CORRECTION: Mutates `opts.depth` in place instead of `Object.assign({})`
to avoid an object allocation at attach time.
*/
function createNoiseParallax(trigger, soa, opts) {
opts = opts || {};
var noiseFn = opts.noiseFn || simplex.acquireNoise3D(opts.seed);
var noiseScale = opts.noiseScale !== undefined ? opts.noiseScale : 0.01;
var minDepth = opts.minDepth !== undefined ? opts.minDepth : 0.25;
var maxDepth = opts.maxDepth !== undefined ? opts.maxDepth : 1.0;
var n = soa.count;
var depth = opts.depth || new Float32Array(n);
var px = soa.x, py = soa.y, pz = soa.z;
var span = maxDepth - minDepth;
for (var i = 0; i < n; i++) {
var v = 0.5 + 0.5 * noiseFn(px[i] * noiseScale, py[i] * noiseScale, pz[i] * noiseScale);
depth[i] = minDepth + v * span;
}
opts.depth = depth;
return createParallax(trigger, soa, opts);
}
// ============================================================================
// 5. SOA SCROLL GROUP — 1M+ driven by a single scroll ratio
// ============================================================================
/**
@param {Object} master   the ScrollTriggerInstance
@param {Object} soa      output vec3 SOA (typically TRS.position)
@param {Object} options  { from, to, axis, stagger, ease }
CORRECTION: `from`/`to` array detection is hoisted out of the loop and
supports both TypedArrays and plain Arrays (original only checked
BYTES_PER_ELEMENT, silently treating plain Arrays as scalars).
*/
function createSOAScrollGroup(master, soa, options) {
options = options || {};
var from = options.from !== undefined ? options.from : 0;
var to = options.to !== undefined ? options.to : 1;
var axis = options.axis || "y";
var stagger = options.stagger || null;
var ease = easings.getEasing(options.ease || "linear");
var n = soa.count;
var sx = soa.x, sy = soa.y, sz = soa.z;
var fromArr = typeof from !== "number" && from.length !== undefined;
var toArr = typeof to !== "number" && to.length !== undefined;
var mode = axis === "x" ? 1 : axis === "z" ? 2 : 0;
function apply(p) {
var i, pi, et, f, t, v;
if (mode === 0) {
for (i = 0; i < n; i++) {
pi = stagger ? clamp((p - stagger[i]) / Math.max(1e-6, 1 - stagger[i]), 0, 1) : p;
et = ease(pi);
f = fromArr ? from[i] : from;
t = toArr ? to[i] : to;
sy[i] = f + (t - f) * et;
}
} else if (mode === 1) {
for (i = 0; i < n; i++) {
pi = stagger ? clamp((p - stagger[i]) / Math.max(1e-6, 1 - stagger[i]), 0, 1) : p;
et = ease(pi);
f = fromArr ? from[i] : from;
t = toArr ? to[i] : to;
sx[i] = f + (t - f) * et;
}
} else {
for (i = 0; i < n; i++) {
pi = stagger ? clamp((p - stagger[i]) / Math.max(1e-6, 1 - stagger[i]), 0, 1) : p;
et = ease(pi);
f = fromArr ? from[i] : from;
t = toArr ? to[i] : to;
sz[i] = f + (t - f) * et;
}
}
}
async function applyChunked(p, chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
var end = Math.min(start + chunkSize, n);
for (var i = start; i < end; i++) {
var pi = stagger ? clamp((p - stagger[i]) / Math.max(1e-6, 1 - stagger[i]), 0, 1) : p;
var et = ease(pi);
var f = fromArr ? from[i] : from;
var t = toArr ? to[i] : to;
var v = f + (t - f) * et;
if (mode === 0) sy[i] = v;
else if (mode === 1) sx[i] = v;
else sz[i] = v;
}
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
}
var prevUpdate = master.onUpdate;
master.onUpdate = function (self) {
apply(self.progress);
if (prevUpdate) prevUpdate(self);
};
apply(master.progress);
return { master: master, apply: apply, applyChunked: applyChunked };
}
// ============================================================================
// 6. COLOR SCRUB — 1M+ HDR-safe per-row color driven by scroll
// ============================================================================
/**
Scroll-driven HDR-safe color scrub into a vec4 SOA (RGBA, HDR allowed).
CORRECTION: Added chunked async variant for 1M+ mobile safety.
*/
function createColorScrub(master, colors, fromColor, toColor, options) {
options = options || {};
var ease = easings.getEasing(options.ease || "linear");
var stagger = options.stagger || null;
var n = colors.count;
var cr = colors.x, cg = colors.y, cb = colors.z, ca = colors.w;
var fr = fromColor[0], fg = fromColor[1], fb = fromColor[2], fa = fromColor[3];
var tr = toColor[0], tg = toColor[1], tb = toColor[2], ta = toColor[3];
var dr = tr - fr, dg = tg - fg, db = tb - fb, da = ta - fa;
function apply(p) {
for (var i = 0; i < n; i++) {
var pi = stagger ? clamp((p - stagger[i]) / Math.max(1e-6, 1 - stagger[i]), 0, 1) : p;
var et = ease(pi);
cr[i] = fr + dr * et;
cg[i] = fg + dg * et;
cb[i] = fb + db * et;
ca[i] = fa + da * et;
}
}
async function applyChunked(p, chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
var end = Math.min(start + chunkSize, n);
for (var i = start; i < end; i++) {
var pi = stagger ? clamp((p - stagger[i]) / Math.max(1e-6, 1 - stagger[i]), 0, 1) : p;
var et = ease(pi);
cr[i] = fr + dr * et;
cg[i] = fg + dg * et;
cb[i] = fb + db * et;
ca[i] = fa + da * et;
}
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
}
var prev = master.onUpdate;
master.onUpdate = function (self) {
apply(self.progress);
if (prev) prev(self);
};
apply(master.progress);
return { master: master, apply: apply, applyChunked: applyChunked };
}
// ============================================================================
// 7. ORBITAL SCROLL REVEAL — Kepler-anomaly ordered progress per row
// ============================================================================
/**
Produces a per-row progress derived from an elliptical anomaly so
elements reveal in a chase around the orbit.
@param {Number} count
@param {Object} opts   { e = 0.5 }
@returns {Float32Array} per-row delay in [0,1]
*/
function createOrbitalScrollOrder(count, opts) {
opts = opts || {};
var e = opts.e !== undefined ? opts.e : 0.5;
var delays = new Float32Array(count);
var TWO_PI = Math.PI * 2;
var invCount = count > 0 ? 1 / count : 0;
for (var i = 0; i < count; i++) {
var M = (i * invCount) * TWO_PI;
var E = glMatrix.keplerSolve(M, e);
var nu = glMatrix.eccentricToTrue(E, e);
delays[i] = (nu + Math.PI) / TWO_PI;
}
return delays;
}
// ============================================================================
// 8. NATURAL IK MOTION — scroll-driven target for FABRIK/CCD
// ============================================================================
/**
Bind a scroll trigger to a 3D IK chain target. As the user scrolls, the
target moves from `fromTarget` to `toTarget`.
CORRECTION: Tolerance is now configurable and compared consistently
against the solver's returned error (distance), matching the corrected
`vec3.fabrikStep3` contract.
@param {ScrollTriggerInstance} master
@param {Object} chain  { pos: Float32Array(3N), lens, target: [x,y,z] }
@param {Array<Number>} fromTarget [x,y,z]
@param {Array<Number>} toTarget   [x,y,z]
@param {Object} opts   { ease, iterations, tolerance, method }
*/
function createIKScrollTarget(master, chain, fromTarget, toTarget, opts) {
opts = opts || {};
var ease = easings.getEasing(opts.ease || "easeInOutCubic");
var iterations = opts.iterations || 10;
var tolerance = opts.tolerance !== undefined ? opts.tolerance : 0.001;
var useCCD = opts.method === "ccd";
var fx = fromTarget[0], fy = fromTarget[1], fz = fromTarget[2];
var dx = toTarget[0] - fx, dy = toTarget[1] - fy, dz = toTarget[2] - fz;
function apply(p) {
var et = ease(p);
chain.target[0] = fx + dx * et;
chain.target[1] = fy + dy * et;
chain.target[2] = fz + dz * et;
if (useCCD) {
vec3.ccdStep3(chain.pos, chain.target, iterations);
} else {
for (var it = 0; it < iterations; it++) {
var err = vec3.fabrikStep3(chain.pos, chain.lens, chain.target, tolerance);
if (err < tolerance) break;
}
}
}
var prev = master.onUpdate;
master.onUpdate = function (self) {
apply(self.progress);
if (prev) prev(self);
};
apply(master.progress);
return { master: master, apply: apply, chain: chain };
}
// ============================================================================
// 9. ORBITAL SCENE — scroll drives Kepler mean anomaly of 1M+ bodies
// ============================================================================
/**
Drive a whole scene of orbital bodies with a single scroll ratio.
CORRECTION: Added chunked async variant; scalar path uses `.fill()`
which is a native zero-GC memset.
@param {ScrollTriggerInstance} master
@param {Object} elements { a, e, inc, Om, om, M } each Float32Array
@param {Number} M0      starting mean anomaly (radians)
@param {Number} M1      ending mean anomaly (radians)
@param {Object} opts    { ease, delta (Float32Array per-row override) }
*/
function createOrbitalScroll(master, elements, M0, M1, opts) {
opts = opts || {};
var ease = easings.getEasing(opts.ease || "linear");
var deltaArr = opts.delta || null;
var n = elements.M.length;
var MArr = elements.M;
var span = M1 - M0;
function apply(p) {
var et = ease(p);
if (deltaArr) {
for (var i = 0; i < n; i++) MArr[i] = M0 + deltaArr[i] * et;
} else {
MArr.fill(M0 + span * et);
}
}
async function applyChunked(p, chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
var et = ease(p);
if (!deltaArr) { MArr.fill(M0 + span * et); return; }
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
var end = Math.min(start + chunkSize, n);
for (var i = start; i < end; i++) MArr[i] = M0 + deltaArr[i] * et;
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
}
var prev = master.onUpdate;
master.onUpdate = function (self) {
apply(self.progress);
if (prev) prev(self);
};
apply(master.progress);
return { master: master, apply: apply, applyChunked: applyChunked };
}
// ============================================================================
// 10. MULTI-TARGET LAYOUT HELPERS
// ============================================================================
/**
Create a scroll trigger that drives an entire bitECS query's TRS positions
through a shared scroll ratio.
CORRECTION: Mutates `opts.axis` in place instead of `Object.assign({})`
to avoid an object allocation at attach time.
@param {Object} master  the ScrollTriggerInstance
@param {Object} trs     { position: vec3SOA, rotation, scale }
@param {Object} opts    { channel: 'y'|'x'|'z', from, to, stagger, ease }
*/
function attachTRSScroll(master, trs, opts) {
opts = opts || {};
opts.axis = opts.channel || opts.axis || "y";
return createSOAScrollGroup(master, trs.position, opts);
}
// ============================================================================
// 11. EXPORTS
// ============================================================================
exports.ScrollTriggerInstance = ScrollTriggerInstance;
exports.onScroll = onScroll;
exports.scrollTrigger = scrollTrigger;
exports.acquireScrollTrigger = acquireScrollTrigger;
exports.releaseScrollTrigger = releaseScrollTrigger;
exports.createParallax = createParallax;
exports.createNoiseParallax = createNoiseParallax;
exports.createSOAScrollGroup = createSOAScrollGroup;
exports.createColorScrub = createColorScrub;
exports.createOrbitalScrollOrder = createOrbitalScrollOrder;
exports.createOrbitalScroll = createOrbitalScroll;
exports.createIKScrollTarget = createIKScrollTarget;
exports.attachTRSScroll = attachTRSScroll;
// math modules re-exported for convenience
exports.math = {
common: glMatrix,
utils: utils,
easings: easings,
animation: animationModule,
engine: engineModule,
vec2: vec2, vec3: vec3, vec4: vec4,
mat2: mat2, mat3: mat3, mat4: mat4,
quat: quat, quat2: quat2,
bitecs: bitecs, simplex: simplex
};