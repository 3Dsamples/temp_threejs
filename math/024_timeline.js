"use strict";
//File number : 024
// File : src/math/024_timeline.js
//Description : Timeline sequencer — every original export preserved byte-compatible (`Timeline` class with children, callbacks, labels, add/set/addCallback/addLabel/_calcOffset/play/pause/restart/reverse/seek/_step/_complete/_syncChildren) — extended with: a true zero-GC pool (re-initializable `_init`, never `.call()` on an ES6 class), Float64 simulation clock, per-child SOA step functions for 1M+ work inside a single timeline, bitECS-driven children, FABRIK/CCD IK child wrappers, Kepler-orbital child wrappers, chunked-async `_syncChildren` / `stepChunked` for mobile-safe sequencing of 1M+ children, timeline nesting with `<` and `>` position labels (GSAP-compatible), `then()` chaining, and a `TimelinePool` for high-churn scenes.
//####
//Best for : 3d graphics — layered intros mixing DOM (`letterSplit`) with 1M+ GPU instances (`soaRecipes.gridRipple`), orchestrated IK reach + orbital camera fly-ins in the same sequence, mobile-safe setups where `stepChunked()` yields to the UI thread, giant save/replay pipelines driving 1M+ SOA tracks per frame, per-frame adaptive delta handled by the pool loader, and scenes that need both DOM and ECS targets in one declarative chain.
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
var timerModule = require("./019_timer.js");
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
// 0.1 CONSTANTS / SHARED SCRATCH (Zero-GC)
// ============================================================================
var MAX_DELTA_MS = 64;      // matches Engine / Animation frame clamp
var MAX_FRAME_DT = 0.25;    // seconds — spiral-of-death guard (Blueprint §51)
// CORRECTION: hoisted identity easing. The original created
// `function (x) { return x; }` inside every SOA-track step call.
function IDENTITY_EASE(x) { return x; }
// ============================================================================
// 1. TIMELINE CLASS
// CORRECTION: the constructor body moved into `_init(config)` so pooled
// instances can be re-initialized WITHOUT `new`. ES6 class constructors
// cannot be invoked via `.call()`, which broke `acquireTimeline`.
// ============================================================================
class Timeline {
constructor(config) {
this._init(config);
}
/** Re-initializable entry point — safe to call on a pooled instance. */
_init(config) {
config = config || {};
// Reuse existing containers when re-initializing from the pool.
this.children = this.children || [];
this.children.length = 0;
this.callbacks = this.callbacks || [];
this.callbacks.length = 0;
this.labels = this.labels || new Map();
this.labels.clear();
this._soaChildren = this._soaChildren || [];
this._soaChildren.length = 0;
this.currentTime = 0;
this.duration = 0;
this.isRunning = false;
this.loop = config.loop || false;
this.timeScale = config.timeScale !== undefined ? config.timeScale : 1;
this.direction = config.direction || "normal";
this.isReversed = this.direction === "reverse";
this.onBegin = config.onBegin || null;
this.onUpdate = config.onUpdate || null;
this.onLoop = config.onLoop || null;
this.onComplete = config.onComplete || null;
this.began = false;
this.completed = false;
this.lastStepTime = 0;
// ---- new (opt-in) ----
this._simulationTime = 0;               // Float64 seconds since start
this._endDelay = config.endDelay || 0;
this._containerId = 0;
if (config.autoplay !== false) this.play();
return this;
}
/**
 * CORRECTION: added a `progress` accessor. `_syncChildren` probes
 * `c.child.progress` — nested Timelines previously had no such property,
 * so `undefined > 0` was always false and a nested timeline could never
 * be rewound to 0 when the playhead moved before its start time.
 */
get progress() {
var total = this.duration + this._endDelay;
return total > 0 ? clamp(this.currentTime / total, 0, 1) : 0;
}
/** Expose endDelay so parent timelines can compute child durations. */
get endDelay() { return this._endDelay; }
set endDelay(v) { this._endDelay = v || 0; }
// -------------------------------------------------------------------------
// Original `add` — preserved.
// -------------------------------------------------------------------------
add(item, offset) {
offset = offset === undefined ? "+=0" : offset;
var startTime = this._calcOffset(offset);
var child = null;
var childDuration = 0;
if (item instanceof Animation || item instanceof Timeline) {
child = item;
child.pause();
childDuration = (child.duration || 0) + (child.endDelay || child._endDelay || 0);
} else if (typeof item === "object" && item !== null) {
child = new Animation(Object.assign({}, item, { autoplay: false }));
childDuration = (child.duration || 0) + (child.endDelay || 0);
}
if (child) {
this.children.push({ child: child, startTime: startTime, duration: childDuration });
var endTime = startTime + childDuration;
if (endTime > this.duration) this.duration = endTime;
}
return this;
}
// -------------------------------------------------------------------------
// Original `set` / `addCallback` / `addLabel` — preserved.
// -------------------------------------------------------------------------
set(targets, props, offset) {
offset = offset === undefined ? "+=0" : offset;
return this.add(Object.assign({ targets: targets, duration: 0 }, props), offset);
}
addCallback(fn, offset) {
offset = offset === undefined ? "+=0" : offset;
var time = this._calcOffset(offset);
this.callbacks.push({ fn: fn, time: time, executed: false });
if (time > this.duration) this.duration = time;
return this;
}
addLabel(labelName, offset) {
offset = offset === undefined ? "+=0" : offset;
this.labels.set(labelName, this._calcOffset(offset));
return this;
}
// -------------------------------------------------------------------------
// Original `_calcOffset` — preserved, plus `<` / `>` support (GSAP).
// CORRECTION: `">=0"` / `"<-0.5"` style suffixes produced `parseFloat("=0")`
// → NaN, which poisoned `duration` and every subsequent child start time.
// A leading `=` is now stripped and NaN is guarded.
// -------------------------------------------------------------------------
_calcOffset(offset) {
if (typeof offset === "number") return Math.max(0, offset);
if (typeof offset === "string") {
if (offset.charAt(0) === "<") {
var after = offset.slice(1);
if (after.charAt(0) === "=") after = after.slice(1);
var delta1 = after ? parseFloat(after) : 0;
if (isNaN(delta1)) delta1 = 0;
return Math.max(0, this._getLatestChildStart() + delta1);
}
if (offset.charAt(0) === ">") {
var after2 = offset.slice(1);
if (after2.charAt(0) === "=") after2 = after2.slice(1);
var delta2 = after2 ? parseFloat(after2) : 0;
if (isNaN(delta2)) delta2 = 0;
return Math.max(0, this._getLatestChildEnd() + delta2);
}
var match = offset.match(/^([a-zA-Z0-9_-]+)?([+-]=?)([\d.]+%?)$/);
if (match) {
var label = match[1];
var op = match[2];
var valStr = match[3];
var baseTime = this.duration;
if (label && this.labels.has(label)) baseTime = this.labels.get(label);
var delta = 0;
if (valStr.charAt(valStr.length - 1) === "%") {
var lastChild = this.children[this.children.length - 1];
var refDur = lastChild ? lastChild.duration : this.duration;
delta = (parseFloat(valStr) / 100) * refDur;
} else {
delta = parseFloat(valStr) || 0;
}
if (op === "+=" || op === "+") return Math.max(0, baseTime + delta);
if (op === "-=" || op === "-") return Math.max(0, baseTime - delta);
}
if (this.labels.has(offset)) return this.labels.get(offset);
var plain = parseFloat(offset);
return isNaN(plain) ? this.duration : Math.max(0, plain);
}
return this.duration;
}
_getLatestChildStart() {
if (this.children.length === 0) return 0;
return this.children[this.children.length - 1].startTime;
}
_getLatestChildEnd() {
if (this.children.length === 0) return 0;
var c = this.children[this.children.length - 1];
return c.startTime + c.duration;
}
/** Recompute total duration from children + SOA children + callbacks. */
_recalcDuration() {
var maxEnd = 0;
for (var i = 0; i < this.children.length; i++) {
var c = this.children[i];
var e = c.startTime + c.duration;
if (e > maxEnd) maxEnd = e;
}
for (var j = 0; j < this._soaChildren.length; j++) {
var sc = this._soaChildren[j];
var se = sc.startTime + sc.duration;
if (se > maxEnd) maxEnd = se;
}
for (var k = 0; k < this.callbacks.length; k++) {
if (this.callbacks[k].time > maxEnd) maxEnd = this.callbacks[k].time;
}
this.duration = maxEnd;
return this;
}
// -------------------------------------------------------------------------
// Original `play` / `pause` / `restart` / `reverse` / `seek` — preserved.
// CORRECTION: `restart` used two `forEach` closures per call; plain loops.
// -------------------------------------------------------------------------
play() {
this.isRunning = true;
this.completed = false;
this.lastStepTime = typeof performance !== "undefined" ? performance.now() : Date.now();
GlobalEngine.add(this);
return this;
}
pause() {
this.isRunning = false;
GlobalEngine.remove(this);
return this;
}
restart() {
this.pause();
this.currentTime = 0;
this._simulationTime = 0;
this.began = false;
this.completed = false;
this.isReversed = this.direction === "reverse";
for (var i = 0; i < this.callbacks.length; i++) this.callbacks[i].executed = false;
for (var j = 0; j < this.children.length; j++) this.children[j].child.seek(0);
this.play();
return this;
}
reverse() {
this.isReversed = !this.isReversed;
return this;
}
seek(progressRatio) {
var total = this.duration + this._endDelay;
this.currentTime = clamp(progressRatio, 0, 1) * total;
this._syncChildren();
return this;
}
/** Seek to an absolute time in milliseconds (additive convenience). */
seekTime(timeMs) {
var total = this.duration + this._endDelay;
this.currentTime = total > 0 ? clamp(timeMs, 0, total) : 0;
this._syncChildren();
return this;
}
// -------------------------------------------------------------------------
// Original `_step` — the `currentTime` path is untouched so the
// byte-compatible behaviour of the original is guaranteed.
// CORRECTION: the loop-rewind `callbacks.forEach` closure is now a loop.
// -------------------------------------------------------------------------
_step() {
if (!this.isRunning) return;
var now = typeof performance !== "undefined" ? performance.now() : Date.now();
var raw = now - (this.lastStepTime || now);
var dt = Math.min(MAX_DELTA_MS, Math.max(0, raw)) * this.timeScale;
this.lastStepTime = now;
this._simulationTime += dt * 0.001;
if (!this.began) {
this.began = true;
if (this.onBegin) this.onBegin(this);
}
if (this.isReversed) this.currentTime -= dt;
else this.currentTime += dt;
this._syncChildren();
for (var i = 0; i < this.callbacks.length; i++) {
var cb = this.callbacks[i];
if (!cb.executed && this.currentTime >= cb.time) {
cb.executed = true;
cb.fn(this);
}
}
if (this.onUpdate) this.onUpdate(this);
var total = this.duration + this._endDelay;
var isEnd = !this.isReversed && this.currentTime >= total;
var isStart = this.isReversed && this.currentTime <= 0;
if (isEnd || isStart) {
if (this.loop) {
if (typeof this.loop === "number") {
this.loop--;
if (this.loop <= 0) { this._complete(); return; }
}
if (this.direction === "alternate") this.isReversed = !this.isReversed;
this.currentTime = this.isReversed ? total : 0;
for (var k = 0; k < this.callbacks.length; k++) this.callbacks[k].executed = false;
if (this.onLoop) this.onLoop(this);
} else {
this._complete();
}
}
}
_complete() {
this.completed = true;
this.isRunning = false;
GlobalEngine.remove(this);
if (this.onComplete) this.onComplete(this);
}
// -------------------------------------------------------------------------
// Original `_syncChildren` — preserved; extended with SOA children.
// CORRECTION: SOA children are invoked as `handle.step(p)` so handles that
// rely on `this` (e.g. SOAMorphGroup) keep their receiver. The original
// stored a detached `handle.step` reference and silently broke them.
// -------------------------------------------------------------------------
_syncChildren() {
for (var i = 0; i < this.children.length; i++) {
var c = this.children[i];
if (this.currentTime < c.startTime) {
if (c.child.progress > 0) c.child.seek(0);
} else if (this.currentTime >= c.startTime + c.duration) {
c.child.seek(1);
} else if (c.duration > 0) {
c.child.seek((this.currentTime - c.startTime) / c.duration);
} else {
c.child.seek(1);
}
}
if (this._soaChildren.length > 0) {
for (var j = 0; j < this._soaChildren.length; j++) {
var sc = this._soaChildren[j];
var local = this.currentTime - sc.startTime;
var p = sc.duration > 0 ? clamp(local / sc.duration, 0, 1) : (local >= 0 ? 1 : 0);
try { sc.handle.step(p); } catch (e) { /* one child must not kill the timeline */ }
}
}
}
// =========================================================================
// NEW: SOA / bitECS / IK / orbital / procedural extensions
// =========================================================================
/**
 * Attach a raw SOA step handle. `step(p)` receives the child-local progress
 * in [0,1]. The handle can be a pooled `SOAAnimationTrack` wrapper, a
 * `soaRecipes.*` handle, a `recipeNoiseWave` / `recipeStarfieldScroll`, or any
 * custom `{ step(p) }` object.
 * @param {{step:Function}} handle
 * @param {Number|String} offset  same grammar as `add()`
 * @param {Number} duration       seconds (defaults to the parent's total)
 */
addSOA(handle, offset, duration) {
if (!handle || typeof handle.step !== "function") {
throw new Error("addSOA: handle must have a `step(p)` method");
}
var startTime = this._calcOffset(offset === undefined ? "+=0" : offset);
var dur = duration !== undefined ? duration * 1000 : (this.duration || 1000);
this._soaChildren.push({ handle: handle, startTime: startTime, duration: dur });
var end = startTime + dur;
if (end > this.duration) this.duration = end;
return this;
}
/**
 * Attach a 1M+ SOA animation track (from `animation.createSOAAnimationTrack`)
 * directly. Convenience over `addSOA`.
 * CORRECTION: the identity-easing fallback is hoisted (no per-step closure),
 * and the channel write is fused into the same loop instead of a second pass.
 */
addSOATrack(track, offset, duration, channel) {
var ease = track.ease || IDENTITY_EASE;
var handle = {
step: function (p) {
// Fast-path: set per-element progress by lerping from track.from to
// track.to at the eased fraction of `p`. We deliberately do not mutate
// the track's own per-element `ts` state so the timeline stays re-enterable.
var n = track.count;
var cur = track.current;
var f = track.from, t = track.to;
var et = ease(p);
if (channel) {
for (var i = 0; i < n; i++) {
var v = f[i] + (t[i] - f[i]) * et;
cur[i] = v;
channel[i] = v;
}
} else {
for (var j = 0; j < n; j++) cur[j] = f[j] + (t[j] - f[j]) * et;
}
}
};
return this.addSOA(handle, offset, duration);
}
/**
 * Attach an IK reach child — eases a chain's target from `fromTarget` to
 * `toTarget` and re-solves FABRIK (or CCD) each update.
 * CORRECTION: tolerance is configurable and compared against the DISTANCE
 * error returned by the corrected `vec3.fabrikStep3` (the original compared
 * a distance against a squared epsilon, so early-out never triggered).
 */
addIKReach(chain, fromTarget, toTarget, offset, duration, options) {
options = options || {};
var ease = easings.getEasing(options.ease || "easeInOutCubic");
var iterations = options.iterations || 10;
var tolerance = options.tolerance !== undefined ? options.tolerance : 0.001;
var useCCD = options.method === "ccd";
var fx = fromTarget[0], fy = fromTarget[1], fz = fromTarget[2];
var dx = toTarget[0] - fx, dy = toTarget[1] - fy, dz = toTarget[2] - fz;
var handle = {
step: function (p) {
var et = ease(p);
chain.target[0] = fx + dx * et;
chain.target[1] = fy + dy * et;
chain.target[2] = fz + dz * et;
if (useCCD) {
vec3.ccdStep3(chain.pos, chain.target, iterations);
} else {
for (var it = 0; it < iterations; it++) {
if (vec3.fabrikStep3(chain.pos, chain.lens, chain.target, tolerance) < tolerance) break;
}
}
}
};
return this.addSOA(handle, offset, duration);
}
/**
 * Attach an orbital reveal child — advances mean anomaly `elements.M` from
 * `M0` to `M1` as the child's local progress goes 0 → 1.
 */
addOrbitalReveal(elements, M0, M1, offset, duration, options) {
options = options || {};
var ease = easings.getEasing(options.ease || "linear");
var deltaArr = options.delta || null;
var MArr = elements.M;
var n = MArr.length;
var span = M1 - M0;
var handle = {
step: function (p) {
var et = ease(p);
if (deltaArr) {
for (var i = 0; i < n; i++) MArr[i] = M0 + deltaArr[i] * et;
} else {
MArr.fill(M0 + span * et);
}
}
};
return this.addSOA(handle, offset, duration);
}
/**
 * Attach a bitECS query as a child — runs `stepFn(list, p, n)` on every
 * listed entity via a caller-provided function. Ideal when you want the
 * timeline to drive per-entity animation code without a full SOA track.
 */
addBitECSStep(queryResult, stepFn, offset, duration) {
var list = queryResult.dense || queryResult;
var n = list.length;
var handle = {
step: function (p) { stepFn(list, p, n); }
};
return this.addSOA(handle, offset, duration);
}
// -------------------------------------------------------------------------
// NEW: chainable `.then()`
// -------------------------------------------------------------------------
/** Append an item right after the current end (equivalent to `">"`). */
then(item) {
return this.add(item, ">");
}
/** Append a label right at the current end. */
thenLabel(name) {
return this.addLabel(name, ">");
}
/** Append a callback right at the current end. */
thenCallback(fn) {
return this.addCallback(fn, ">");
}
// -------------------------------------------------------------------------
// NEW: async stepChunked — for 1M+ child tree traversal
// CORRECTION: reverse / alternate / endDelay parity with `_step`, plain
// loops instead of `forEach` closures, and negative-delta guarding.
// -------------------------------------------------------------------------
/**
 * Advance the timeline by `dtMs` while yielding to the UI thread between
 * chunks. Use after long pauses or when the child tree is huge.
 */
async stepChunked(dtMs, chunkSize, yieldEvery) {
if (!this.isRunning) return this;
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
var dt = Math.max(0, dtMs) * this.timeScale;
this.currentTime += this.isReversed ? -dt : dt;
this._simulationTime += dt * 0.001;
if (!this.began) {
this.began = true;
if (this.onBegin) this.onBegin(this);
}
// Chunked children sync
var n = this.children.length;
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
var end = Math.min(start + chunkSize, n);
for (var i = start; i < end; i++) {
var ch = this.children[i];
if (this.currentTime < ch.startTime) { if (ch.child.progress > 0) ch.child.seek(0); }
else if (this.currentTime >= ch.startTime + ch.duration) { ch.child.seek(1); }
else if (ch.duration > 0) { ch.child.seek((this.currentTime - ch.startTime) / ch.duration); }
else { ch.child.seek(1); }
}
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
// Chunked SOA children sync
var sn = this._soaChildren.length;
c = 0;
for (var s2 = 0; s2 < sn; s2 += chunkSize) {
var e2 = Math.min(s2 + chunkSize, sn);
for (var j = s2; j < e2; j++) {
var sc = this._soaChildren[j];
var local = this.currentTime - sc.startTime;
var p = sc.duration > 0 ? clamp(local / sc.duration, 0, 1) : (local >= 0 ? 1 : 0);
try { sc.handle.step(p); } catch (err) { /* swallow */ }
}
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
// Callbacks
for (var k = 0; k < this.callbacks.length; k++) {
var cb = this.callbacks[k];
if (!cb.executed && this.currentTime >= cb.time) { cb.executed = true; cb.fn(this); }
}
if (this.onUpdate) this.onUpdate(this);
var total = this.duration + this._endDelay;
var isEnd = !this.isReversed && this.currentTime >= total;
var isStart = this.isReversed && this.currentTime <= 0;
if (isEnd || isStart) {
if (this.loop) {
if (typeof this.loop === "number") {
this.loop--;
if (this.loop <= 0) { this._complete(); return this; }
}
if (this.direction === "alternate") this.isReversed = !this.isReversed;
this.currentTime = this.isReversed ? total : 0;
for (var m = 0; m < this.callbacks.length; m++) this.callbacks[m].executed = false;
if (this.onLoop) this.onLoop(this);
} else {
this._complete();
}
}
return this;
}
/** Clear all children / callbacks / labels without destroying the instance. */
clear() {
this.children.length = 0;
this.callbacks.length = 0;
this._soaChildren.length = 0;
this.labels.clear();
this.duration = 0;
this.currentTime = 0;
this._simulationTime = 0;
this.began = false;
this.completed = false;
return this;
}
// -------------------------------------------------------------------------
// NEW: children enumeration for external systems
// NOTE: allocates on call (diagnostic API) — never invoke inside a frame loop.
// -------------------------------------------------------------------------
/** Read-only shallow snapshot of children + SOA children. */
inspect() {
return {
duration: this.duration,
currentTime: this.currentTime,
simulationTime: this._simulationTime,
progress: this.progress,
children: this.children.slice(),
soaChildren: this._soaChildren.slice(),
labels: new Map(this.labels),
callbacks: this.callbacks.slice()
};
}
}
// ============================================================================
// 2. POOL — zero-GC reuse of Timeline instances
// CORRECTION: uses `_init()` instead of `Timeline.call()`, which throws for
// ES6 classes. The instance is paused before being returned to the pool.
// ============================================================================
var _timelinePool = glMatrix.createPool(
function () { return Object.create(Timeline.prototype); },
8,
function (tl) {
if (tl.isRunning) { try { tl.pause(); } catch (e) { /* swallow */ } }
if (tl.children) tl.children.length = 0;
if (tl.callbacks) tl.callbacks.length = 0;
if (tl.labels) tl.labels.clear();
if (tl._soaChildren) tl._soaChildren.length = 0;
tl.currentTime = 0;
tl.duration = 0;
tl.isRunning = false;
tl.began = false;
tl.completed = false;
tl.isReversed = false;
tl._simulationTime = 0;
tl.loop = false;
tl.timeScale = 1;
tl.direction = "normal";
tl.onBegin = null;
tl.onUpdate = null;
tl.onLoop = null;
tl.onComplete = null;
tl.lastStepTime = 0;
tl._endDelay = 0;
tl._containerId = 0;
}
);
function acquireTimeline(config) {
var tl = _timelinePool.acquire();
tl._init(config);
return tl;
}
function releaseTimeline(tl) {
if (!tl) return;
try { tl.pause(); } catch (e) { /* swallow */ }
_timelinePool.release(tl);
}
// ============================================================================
// 3. COMPOSITE HELPERS — quick builders
// ============================================================================
/**
 * Concatenate a list of `Animation` configs back-to-back.
 * CORRECTION: the original used `">=" + 0`, which parsed to NaN and collapsed
 * every child onto an invalid start time. `">"` is the correct GSAP-style
 * "append at the current end" marker.
 */
function timelineFromConfigs(configs) {
var tl = new Timeline({ autoplay: false });
for (var i = 0; i < configs.length; i++) tl.add(configs[i], ">");
return tl;
}
/**
 * Run N timelines in parallel and complete when all are done.
 * CORRECTION: removed the per-timeline dummy `{ step: function () {} }` SOA
 * child (a closure + a no-op entry per timeline) and registered children with
 * their real durations so `master.duration` is authoritative.
 * @param {Array<Timeline>} timelines
 * @param {Function} [onComplete]
 */
function parallelTimelines(timelines, onComplete) {
var master = new Timeline({ autoplay: false });
var total = timelines.length;
var done = 0;
for (var i = 0; i < total; i++) {
var tl = timelines[i];
tl.pause();
var dur = (tl.duration || 0) + (tl._endDelay || 0);
master.children.push({ child: tl, startTime: 0, duration: dur });
if (dur > master.duration) master.duration = dur;
tl.onComplete = (function (prev) {
return function (t) {
if (prev) prev(t);
done++;
if (done >= total && onComplete) onComplete(master);
};
})(tl.onComplete);
tl.play();
}
master.play();
return master;
}
// ============================================================================
// 4. EXPORTS
// ============================================================================
exports.Timeline = Timeline;
exports.acquireTimeline = acquireTimeline;
exports.releaseTimeline = releaseTimeline;
exports.timelineFromConfigs = timelineFromConfigs;
exports.parallelTimelines = parallelTimelines;
// math modules re-exported for convenience
exports.math = {
common: glMatrix,
utils: utils,
easings: easings,
animation: animationModule,
engine: engineModule,
timer: timerModule,
vec2: vec2, vec3: vec3, vec4: vec4,
mat2: mat2, mat3: mat3, mat4: mat4,
quat: quat, quat2: quat2,
bitecs: bitecs, simplex: simplex
};