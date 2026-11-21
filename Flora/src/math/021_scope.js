"use strict";
//File number : 021
// File : src/math/021_scope.js
//Description : Scope + animatable helpers — every original export preserved byte-compatible (`scope(rootElement, scopeCallback)` returning `{ animate, timeline, revert }`, `animatable(targetObj, defaultOpts)` Proxy) — extended with: truly pooled scope instances (studio object + closures allocated ONCE per pool slot), auto-revert on DOM detach, async scope with chunked yields, bitECS world scope (`scopeWorld`), SOA bulk scope group for 1M+ procedural children with chunked apply, HDR-safe vec3 / color animatable proxies with zero per-assignment allocation, and lazy `Timeline` loading so the file loads even before the timeline module is present.
//####
//Best for : 3d graphics — DOM+WebGL hybrid scenes that must clean up every in-flight animation on route change, 1M+ procedural children driven by a single revertable scope group, HDR color scrubs across exposures, TRS-position animation with per-frame budgets, ECS-aware animation helpers that operate on bitECS query results directly, and pooled `animatable` proxies for HUD controls. Works identically at mm and Mpc scales since scopes are pure orchestration.
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
var toArray = utils.toArray;
// Lazy Timeline loader (safe even if the timeline module is not yet present)
var _Timeline = null;
var _timelineResolved = false;
function getTimeline() {
if (_timelineResolved) return _Timeline;
_timelineResolved = true;
try {
_Timeline = require("./022_timeline.js").Timeline || null;
} catch (e) {
try {
_Timeline = require("./timeline.cjs").Timeline || null;
} catch (e2) {
_Timeline = null;
}
}
return _Timeline;
}
// ============================================================================
// 1. ANIMATION ACQUISITION
// CORRECTION: ES6 class constructors cannot be invoked via `.call()`.
// We only reuse pooled instances when the Animation prototype exposes a
// re-initializable `_init` hook; otherwise we fall back to `new Animation`.
// This prevents "Class constructor cannot be invoked without 'new'".
// ============================================================================
var _HAS_ANIM_INIT = typeof Animation.prototype._init === "function";
var _animPool = _HAS_ANIM_INIT
? glMatrix.createPool(
function () { return Object.create(Animation.prototype); },
32,
function (a) {
a.config = null;
a.onBegin = a.onUpdate = a.onRender = a.onLoop = a.onComplete = null;
if (a.targets) a.targets.length = 0;
if (a.tweens) a.tweens.length = 0;
if (a._transformMap) a._transformMap.clear();
if (a._propMap) a._propMap.clear();
}
)
: null;
function _acquireAnim(cfg) {
if (_HAS_ANIM_INIT) {
var a = _animPool.acquire();
a._init(cfg);
return a;
}
return new Animation(cfg);
}
function _releaseAnim(a) {
if (!a) return;
try { a.pause(); } catch (e) { /* swallow */ }
if (_HAS_ANIM_INIT) _animPool.release(a);
}
// ============================================================================
// 2. ORIGINAL SCOPE (byte-compatible API)
// CORRECTION: `revert` uses a plain loop instead of allocating a forEach
// closure per call. Behaviour is identical.
// ============================================================================
function scope(rootElement, scopeCallback) {
var root = typeof rootElement === "string"
? (typeof document !== "undefined" ? document.querySelector(rootElement) : null)
: rootElement;
var scopedAnimations = [];
var scopedStudio = {
animate: function (cfg) {
if (typeof cfg.targets === "string" && root) {
cfg.targets = Array.from(root.querySelectorAll(cfg.targets));
}
var anim = new Animation(cfg);
scopedAnimations.push(anim);
return anim;
},
timeline: function (cfg) {
var Timeline = getTimeline();
if (!Timeline) throw new Error("scope.timeline requires the timeline module to be loaded");
var tl = new Timeline(cfg);
scopedAnimations.push(tl);
return tl;
},
revert: function () {
for (var i = 0; i < scopedAnimations.length; i++) {
try { scopedAnimations[i].pause(); } catch (e) { /* swallow */ }
}
scopedAnimations.length = 0;
}
};
if (typeof scopeCallback === "function") scopeCallback(scopedStudio);
return scopedStudio;
}
// ============================================================================
// 3. ORIGINAL ANIMATABLE (byte-compatible API)
// CORRECTION: The Proxy `set` trap is a hot path. The original allocated a
// fresh config object (`Object.assign`), a fresh `[from, to]` array literal,
// and a new Animation on EVERY assignment. All three are now reused:
//   - one config object per proxy (previous prop key deleted before reuse)
//   - one 2-element plain Array per proxy (Animation requires Array.isArray)
//   - the previous animation is paused/released before the next is acquired
// ============================================================================
function animatable(targetObj, defaultOpts) {
defaultOpts = defaultOpts || {};
var duration = defaultOpts.duration || 600;
var easing = defaultOpts.easing || "spring";
// Pre-allocated per-proxy state (Zero-GC across assignments)
var cfg = {};
var pair = [0, 0];
var lastProp = null;
var lastAnim = null;
// Copy through user defaults once (setup-time only)
for (var k in defaultOpts) {
if (k === "duration" || k === "easing" || k === "targets") continue;
cfg[k] = defaultOpts[k];
}
cfg.duration = duration;
cfg.easing = easing;
return new Proxy(targetObj, {
set: function (target, prop, value) {
if (typeof value === "number" && typeof target[prop] === "number") {
if (lastProp !== null && lastProp !== prop) delete cfg[lastProp];
pair[0] = target[prop];
pair[1] = value;
cfg.targets = target;
cfg[prop] = pair;
lastProp = prop;
_releaseAnim(lastAnim);
lastAnim = _acquireAnim(cfg);
} else {
target[prop] = value;
}
return true;
}
});
}
// ============================================================================
// 4. POOL — reusable scoped studio (true zero-GC)
// CORRECTION: The studio object and its three method closures are created
// ONCE per pool slot inside the factory. `acquireScopedStudio` only mutates
// state; it never allocates a new studio or new closures.
// ============================================================================
var _scopePool = glMatrix.createPool(
function () {
var s = { root: null, animations: [], studio: null, released: true };
var studio = {
_pool: s,
animate: function (cfg) {
if (typeof cfg.targets === "string" && s.root) {
cfg.targets = Array.from(s.root.querySelectorAll(cfg.targets));
}
var anim = _acquireAnim(cfg);
s.animations.push(anim);
return anim;
},
timeline: function (cfg) {
var Timeline = getTimeline();
if (!Timeline) throw new Error("scope.timeline requires the timeline module to be loaded");
var tl = new Timeline(cfg);
s.animations.push(tl);
return tl;
},
revert: function (release) {
for (var i = 0; i < s.animations.length; i++) _releaseAnim(s.animations[i]);
s.animations.length = 0;
if (release) releaseScopedStudio(studio);
}
};
s.studio = studio;
return s;
},
8,
function (s) {
for (var i = 0; i < s.animations.length; i++) _releaseAnim(s.animations[i]);
s.animations.length = 0;
s.root = null;
s.released = true;
}
);
/**
Pooled scope — same API as `scope()` but the studio object, its closures,
and its animation list all come from a zero-GC pool.
Call `releaseScopedStudio(studio)` when done (or use `revert(true)`).
*/
function acquireScopedStudio(rootElement, scopeCallback) {
var s = _scopePool.acquire();
s.released = false;
s.root = typeof rootElement === "string"
? (typeof document !== "undefined" ? document.querySelector(rootElement) : null)
: rootElement;
s.animations.length = 0;
if (typeof scopeCallback === "function") scopeCallback(s.studio);
return s.studio;
}
function releaseScopedStudio(studio) {
if (!studio || !studio._pool) return;
var s = studio._pool;
if (s.released) return; // guard against double-release
_scopePool.release(s);
}
// ============================================================================
// 5. AUTO-REVERT ON DOM DETACH
// ============================================================================
/**
Create a scope that auto-reverts (and releases its pool slot) when
`rootElement` is removed from the DOM. Perfect for SPA routes / dynamic
panels — no manual `revert()` bookkeeping.
CORRECTION: The observer is disconnected on manual revert as well, and a
guard prevents double-release if the node is removed after a manual revert.
*/
function attachedScope(rootElement, scopeCallback) {
var studio = acquireScopedStudio(rootElement, scopeCallback);
var root = typeof rootElement === "string"
? (typeof document !== "undefined" ? document.querySelector(rootElement) : null)
: rootElement;
if (!root || typeof MutationObserver === "undefined") return studio;
var obs = new MutationObserver(function (muts) {
for (var i = 0; i < muts.length; i++) {
var removed = muts[i].removedNodes;
for (var j = 0; j < removed.length; j++) {
if (removed[j] === root) {
obs.disconnect();
studio.revert(true);
return;
}
}
}
});
obs.observe(root.parentNode || document.body, { childList: true, subtree: true });
// Chain revert so manual cleanup also detaches the observer
var baseRevert = studio.revert;
studio.revert = function (release) {
obs.disconnect();
baseRevert(release);
};
return studio;
}
// ============================================================================
// 6. ASYNC SCOPE — chunked yields
// ============================================================================
/**
Async scope — runs `scopeCallback(studio, yieldToMain)` and awaits it so
long setup loops can chunk their work without freezing the UI thread.
*/
async function asyncScope(rootElement, scopeCallback) {
var studio = acquireScopedStudio(rootElement);
if (typeof scopeCallback === "function") {
await scopeCallback(studio, glMatrix.yieldToMain);
}
return studio;
}
// ============================================================================
// 7. BITECS WORLD SCOPE — animate a query directly
// ============================================================================
/**
Create a scope bound to a bitECS world. `animate` runs against a query
result, `animateTrack` uses the SOA channel animation machinery — one
batch drives 1M+ entities.
Example:
var ws = scopeWorld(world);
ws.animateTrack(query(world, [Position]), trs.position.y, 0, 1, 1.0, "easeOutCubic");
engine.addSoaStep(function (dt) { ws.step(dt); });
ws.revert();
CORRECTION: Entity list resolution no longer allocates via push-per-entity;
the dense list is copied with a single sized loop. Config is built without
`Object.assign` spread chains.
*/
function scopeWorld(world) {
var tracks = [];
var anims = [];
var api = {
world: world,
/** Per-entity Animation, resolved from the query's dense entity list. */
animate: function (entities, cfg) {
var list = entities.dense || entities;
var n = list.length;
var els = new Array(n);
for (var i = 0; i < n; i++) els[i] = list[i];
var c = {};
for (var k in cfg) c[k] = cfg[k];
c.targets = els;
var a = _acquireAnim(c);
anims.push(a);
return a;
},
/** SOA channel animation over the query's entity list. */
animateTrack: function (entities, channel, fromV, toV, duration, ease) {
var list = entities.dense || entities;
var a = animationModule.createECSChannelAnimation(list, channel, fromV, toV, duration, ease);
tracks.push(a);
return a;
},
/** Staggered SOA channel animation. */
animateTrackStaggered: function (entities, channel, fromV, toV, duration, staggerFn, ease) {
var list = entities.dense || entities;
var a = animationModule.createECSChannelAnimationStaggered(list, channel, fromV, toV, duration, staggerFn, ease);
tracks.push(a);
return a;
},
/** Advance all tracks by dtSec (in seconds). Sync. */
step: function (dtSec) {
for (var i = 0; i < tracks.length; i++) tracks[i].step(dtSec);
},
/** Async chunked step for 1M+ tracks. */
stepChunked: async function (dtSec, chunkSize, yieldEvery) {
for (var i = 0; i < tracks.length; i++) {
await tracks[i].stepChunked(dtSec, chunkSize, yieldEvery);
}
},
/** Apply every track's current values into its target channel. */
apply: function () {
for (var i = 0; i < tracks.length; i++) tracks[i].apply();
},
get trackCount() { return tracks.length; },
get done() {
for (var i = 0; i < tracks.length; i++) if (!tracks[i].done) return false;
return true;
},
/** Revert all animations + tracks. */
revert: function () {
for (var i = 0; i < anims.length; i++) _releaseAnim(anims[i]);
anims.length = 0;
tracks.length = 0;
}
};
return api;
}
// ============================================================================
// 8. SOA SCOPE GROUP — 1M+ procedural children
// ============================================================================
/**
Bulk scope for 1M+ children. Wraps TRS + color SOAs and emits a single
revertable batch. Perfect for procedural worlds where "all instances of
this mesh" is one logical scope.
CORRECTION: `from`/`to` array detection is hoisted out of the hot loop and
supports both TypedArrays and plain Arrays (the original only checked
BYTES_PER_ELEMENT and compared `typeof from === "function "` with a trailing
space, which never matched).
*/
function createScopeGroup(options) {
options = options || {};
var trs = options.trs || null;
var colors = options.colors || null;
var count = options.count || (trs ? trs.position.count : (colors ? colors.count : 0));
var tracks = [];
var colorAnims = [];
function _resolveAxis(axis) {
if (axis === "x") return 0;
if (axis === "z") return 2;
return 1;
}
return {
count: count,
/**
* Animate X / Y / Z channel of `trs.position` across all children.
* @param {'x'|'y'|'z'} axis
* @param {Float32Array|Array|Function|Number} from
* @param {Float32Array|Array|Function|Number} to
* @param {Number} duration seconds
* @param {String} [ease]
* @param {Float32Array} [stagger] per-row delay ∈ [0,1]
*/
animateTRS: function (axis, from, to, duration, ease, stagger) {
if (!trs) throw new Error("createScopeGroup: no trs provided");
var fromArr = typeof from !== "number" && typeof from !== "function" && from != null && from.length !== undefined;
var toArr = typeof to !== "number" && typeof to !== "function" && to != null && to.length !== undefined;
var fromFn = typeof from === "function" ? from : null;
var toFn = typeof to === "function" ? to : null;
var track = animationModule.createSOAAnimationTrack(count, { ease: ease || "easeOutCubic" });
var ch = trs.position[axis || "y"];
for (var i = 0; i < count; i++) {
var f = fromArr ? from[i] : (fromFn ? fromFn(i) : from);
var t = toArr ? to[i] : (toFn ? toFn(i) : to);
var delay = stagger ? stagger[i] * duration : 0;
track.setElement(i, f, t, duration, delay);
}
tracks.push({ track: track, channel: ch });
return track;
},
/** Animate alpha channel of `colors`. */
animateAlpha: function (from, to, duration, ease, stagger) {
if (!colors) throw new Error("createScopeGroup: no colors provided");
var fromArr = typeof from !== "number" && typeof from !== "function" && from != null && from.length !== undefined;
var toArr = typeof to !== "number" && typeof to !== "function" && to != null && to.length !== undefined;
var fromFn = typeof from === "function" ? from : null;
var toFn = typeof to === "function" ? to : null;
var track = animationModule.createSOAAnimationTrack(count, { ease: ease || "easeOutCubic" });
for (var i = 0; i < count; i++) {
var f = fromArr ? from[i] : (fromFn ? fromFn(i) : from);
var t = toArr ? to[i] : (toFn ? toFn(i) : to);
var delay = stagger ? stagger[i] * duration : 0;
track.setElement(i, f, t, duration, delay);
}
colorAnims.push({ track: track, channel: colors.w, anim: null });
return track;
},
/** Full HDR-safe color scrub from `fromColor` to `toColor`. */
animateColor: function (fromColor, toColor, duration, ease) {
if (!colors) throw new Error("createScopeGroup: no colors provided");
var a = animationModule.createColorSOAAnimation(colors, fromColor, toColor, duration, ease);
colorAnims.push({ anim: a, track: null, channel: null });
return a;
},
/** Synchronous step by dtSec (seconds). */
step: function (dtSec) {
for (var i = 0; i < tracks.length; i++) tracks[i].track.step(dtSec);
for (var j = 0; j < colorAnims.length; j++) {
var e = colorAnims[j];
if (e.anim) e.anim.step(dtSec);
else e.track.step(dtSec);
}
},
/** Async chunked step — mobile-safe for 1M+ children. */
stepChunked: async function (dtSec, chunkSize, yieldEvery) {
for (var i = 0; i < tracks.length; i++) {
await tracks[i].track.stepChunked(dtSec, chunkSize, yieldEvery);
}
for (var j = 0; j < colorAnims.length; j++) {
var e = colorAnims[j];
if (e.anim) e.anim.step(dtSec);
else await e.track.stepChunked(dtSec, chunkSize, yieldEvery);
}
},
/** Write current track values into their target channels (sync). */
apply: function () {
for (var i = 0; i < tracks.length; i++) {
var t = tracks[i].track;
var ch = tracks[i].channel;
var cur = t.current;
for (var k = 0; k < count; k++) ch[k] = cur[k];
}
for (var j = 0; j < colorAnims.length; j++) {
var e = colorAnims[j];
if (e.track) {
var w = e.channel;
var c2 = e.track.current;
for (var m = 0; m < count; m++) w[m] = c2[m];
}
}
},
/**
* Chunked async apply — yields via `scheduler.yield()` so writing 1M+
* channel values never blocks the Android UI thread.
*/
applyChunked: async function (chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
for (var i = 0; i < tracks.length; i++) {
var t = tracks[i].track;
var ch = tracks[i].channel;
var cur = t.current;
var c = 0;
for (var start = 0; start < count; start += chunkSize) {
var end = Math.min(start + chunkSize, count);
for (var k = start; k < end; k++) ch[k] = cur[k];
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
}
for (var j = 0; j < colorAnims.length; j++) {
var e = colorAnims[j];
if (!e.track) continue;
var w = e.channel;
var c2 = e.track.current;
var cc = 0;
for (var s2 = 0; s2 < count; s2 += chunkSize) {
var e2 = Math.min(s2 + chunkSize, count);
for (var m = s2; m < e2; m++) w[m] = c2[m];
if (++cc >= yieldEvery) { cc = 0; await glMatrix.yieldToMain(); }
}
}
},
get done() {
for (var i = 0; i < tracks.length; i++) if (!tracks[i].track.done) return false;
for (var j = 0; j < colorAnims.length; j++) {
var e = colorAnims[j];
if (e.anim && !e.anim.done) return false;
if (e.track && !e.track.done) return false;
}
return true;
},
revert: function () {
tracks.length = 0;
colorAnims.length = 0;
}
};
}
// ============================================================================
// 9. ANIMATABLE PROXIES — vec3 / HDR color
// ============================================================================
/**
Watch a `[x, y, z]` array property and animate its three channels.
CORRECTION: Three config objects and three `[from, to]` pair arrays are
pre-allocated ONCE per proxy. The original allocated six objects plus three
Animations on every assignment. Previous animations are released first.
*/
function animatableVec3(target, prop, defaultOpts) {
defaultOpts = defaultOpts || {};
var duration = defaultOpts.duration || 600;
var easing = defaultOpts.easing || "spring";
var prev = target[prop] ? Array.prototype.slice.call(target[prop]) : [0, 0, 0];
// Pre-allocated per-channel state (Zero-GC across assignments)
var cfgs = [{}, {}, {}];
var pairs = [[0, 0], [0, 0], [0, 0]];
var anims = [null, null, null];
for (var c = 0; c < 3; c++) {
for (var k in defaultOpts) {
if (k === "duration" || k === "easing" || k === "targets") continue;
cfgs[c][k] = defaultOpts[k];
}
cfgs[c].duration = duration;
cfgs[c].easing = easing;
cfgs[c].targets = prev;
}
return new Proxy(target, {
set: function (t, key, value) {
if (key === prop && value != null && value.length >= 3) {
for (var i = 0; i < 3; i++) {
var cfg = cfgs[i];
var pair = pairs[i];
pair[0] = prev[i];
pair[1] = value[i];
cfg[i] = pair;
_releaseAnim(anims[i]);
anims[i] = _acquireAnim(cfg);
}
t[prop] = prev;
} else {
t[key] = value;
}
return true;
}
});
}
/**
Watch an HDR color array `[r, g, b, a]` and animate it in place (no clamp).
CORRECTION: `fromColor` / `toColor` buffers and the `onUpdate` callback are
allocated ONCE per proxy. The original called `.slice()` twice and created
a fresh closure on every assignment.
*/
function animatableColor(target, prop, defaultOpts) {
defaultOpts = defaultOpts || {};
var duration = defaultOpts.duration || 600;
var easing = defaultOpts.easing || "spring";
var prev = target[prop] ? Array.prototype.slice.call(target[prop]) : [1, 1, 1, 1];
while (prev.length < 4) prev.push(1);
// Pre-allocated state (Zero-GC across assignments)
var fromColor = new Float32Array(4);
var toColor = new Float32Array(4);
var lastAnim = null;
function onUpdate(a) {
var p = a.progress;
for (var k = 0; k < 4; k++) {
prev[k] = fromColor[k] + (toColor[k] - fromColor[k]) * p;
}
}
var cfg = {
targets: prev,
duration: duration,
easing: easing,
onUpdate: onUpdate
};
for (var k0 in defaultOpts) {
if (k0 === "duration" || k0 === "easing" || k0 === "targets" || k0 === "onUpdate") continue;
cfg[k0] = defaultOpts[k0];
}
return new Proxy(target, {
set: function (t, key, value) {
if (key === prop && value != null && value.length >= 3) {
for (var i = 0; i < 4; i++) {
fromColor[i] = prev[i];
toColor[i] = i < value.length ? value[i] : 1;
}
_releaseAnim(lastAnim);
lastAnim = _acquireAnim(cfg);
t[prop] = prev;
} else {
t[key] = value;
}
return true;
}
});
}
// ============================================================================
// 10. EXPORTS
// ============================================================================
// ---- original ----
exports.scope = scope;
exports.animatable = animatable;
// ---- pooled ----
exports.acquireScopedStudio = acquireScopedStudio;
exports.releaseScopedStudio = releaseScopedStudio;
// ---- auto-revert ----
exports.attachedScope = attachedScope;
// ---- async ----
exports.asyncScope = asyncScope;
// ---- bitECS ----
exports.scopeWorld = scopeWorld;
// ---- SOA bulk ----
exports.createScopeGroup = createScopeGroup;
// ---- extended proxies ----
exports.animatableVec3 = animatableVec3;
exports.animatableColor = animatableColor;
// ---- lazy timeline accessor ----
exports.getTimeline = getTimeline;
// ---- math re-exports ----
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