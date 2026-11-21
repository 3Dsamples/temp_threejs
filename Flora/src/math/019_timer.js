"use strict";
//File number : 019
// File : src/math/019_timer.cjs
//Description : Timer class (byte-identical original API: constructor({duration, loop, onTick, onComplete, autoplay}), play(), pause(), restart(), _step()) — extended with: zero-GC pool, `maxLoops` / `onBegin` / `onLoop` opt-in hooks, `timeScale`, `endDelay`, Float64 simulation clock, `stepFixed(dtMs)` for deterministic integration, `stepChunked(dtMs)` for mobile-safe processing, a `TimerGroup` SOA container that drives 1M+ independent timers per frame, a `createFixedStepScheduler(hz)` accumulator for 60/90/120/144 Hz independence, a `createOrbitalEpoch(elements)` helper that advances Kepler mean anomaly of 1M+ bodies by real time with wrap, an `after(ms, fn)` one-shot wrapper, and `batchTick(timers, dtMs)` for deterministic ordering — all callable from `GlobalEngine` with no extra glue code.
//####
//Best for : 3d graphics — animation timing independent of display refresh rate, per-particle spawn/despawn timers at 1M+ scale, orbital epoch advance (Kepler mean anomaly) for 1M+ planets/asteroids/dust, deterministic integration of natural IK targets (FABRIK / CCD timers), reloading procedural chunks on a fixed cadence, measuring HDR color fade durations precisely, and driving simulation steps at 30/60/90/120/144 Hz from a single unified clock without frame-rate drift on Android 64-bit.
//License : MIT
Object.defineProperty(exports, "__esModule", { value: true });
// ============================================================================
// 0. IMPORTS
// ============================================================================
var glMatrix = require("./001_common.js");
var utils = require("./014_utils.js");
var engineModule = require("./016_engine.js");
var vec3 = require("./003_vec3.js");
var quat = require("./008_quat.js");
var bitecs = require("./010_bitECS_core.js");
var simplex = require("./013_simplex-noise.js");
var GlobalEngine = engineModule.GlobalEngine;
// ============================================================================
// 1. TIMER (byte-identical original API + opt-in extensions)
// ============================================================================
class Timer {
constructor(config) {
config = config || {};
// --- original fields (exact defaults) ---
this.duration = config.duration || Infinity;
this.loop = config.loop || false;
this.onTick = config.onTick || null;
this.onComplete = config.onComplete || null;
this.currentTime = 0;
this.isRunning = false;
this.lastStepTime = 0;
// --- new fields (defaults preserve original behaviour) ---
this.timeScale = config.timeScale !== undefined ? config.timeScale : 1;
this.endDelay = config.endDelay || 0;
this.onBegin = config.onBegin || null;
this.onLoop = config.onLoop || null;
this.maxLoops = config.maxLoops !== undefined ? config.maxLoops : Infinity;
this._loopCount = 0;
this.began = false;
this.simulationTime = 0; // Float64 seconds since start (Mpc-scale safe)
if (config.autoplay !== false) this.play();
}
// -------------------------------------------------------------------------
// Original API (verbatim)
// -------------------------------------------------------------------------
play() {
this.isRunning = true;
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
this.currentTime = 0;
this._loopCount = 0;
this.began = false;
return this.play();
}
/**
Called by `GlobalEngine` once per frame. Byte-compatible with the
original: clamps `dt` to 64 ms, advances `currentTime`, fires `onTick`,
and completes or loops. Additional behaviour only fires when the
corresponding config hooks/values are set.
*/
_step() {
if (!this.isRunning) return;
var now = typeof performance !== "undefined" ? performance.now() : Date.now();
var dt = Math.min(64, Math.max(0, now - (this.lastStepTime || now))) * this.timeScale;
this.lastStepTime = now;
this._advance(dt);
}
// -------------------------------------------------------------------------
// New: deterministic fixed-step advance (caller provides the delta)
// -------------------------------------------------------------------------
/**
Advance the timer by an exact millisecond delta, bypassing
`performance.now()`. Use this for deterministic playback (replays,
physics-locked timers) and to drive a fixed-timestep accumulator.
*/
stepFixed(dtMs) {
if (!this.isRunning) return;
this._advance(Math.max(0, dtMs) * this.timeScale);
return this;
}
/**
Chunked async — splits a huge delta into ≤16 ms sub-steps and yields
between each. Use for mobile-safe processing after long pauses.
*/
async stepChunked(dtMs) {
if (!this.isRunning) return this;
var remaining = Math.max(0, dtMs);
var MAX_SUB = 16;
while (remaining > 0) {
var chunk = Math.min(MAX_SUB, remaining);
this._advance(chunk * this.timeScale);
remaining -= chunk;
if (!this.isRunning) break;
await glMatrix.yieldToMain();
}
return this;
}
// -------------------------------------------------------------------------
// Internal advance — every original feature preserved; new features
// gated on opt-in config so defaults stay byte-compatible.
// -------------------------------------------------------------------------
_advance(dtMs) {
this.currentTime += dtMs;
this.simulationTime += dtMs * 0.001;
if (!this.began) {
this.began = true;
if (this.onBegin) this.onBegin(this);
}
if (this.onTick) this.onTick(this.currentTime);
var totalTime = this.duration + this.endDelay;
if (this.currentTime >= totalTime) {
if (this.loop) {
this._loopCount++;
if (this._loopCount >= this.maxLoops) {
this.pause();
if (this.onComplete) this.onComplete(this);
return;
}
this.currentTime = 0;
if (this.onLoop) this.onLoop(this);
} else {
this.pause();
if (this.onComplete) this.onComplete(this);
}
}
}
// -------------------------------------------------------------------------
// Convenience getters / helpers
// -------------------------------------------------------------------------
/** Progress as a fraction in [0,1]. */
getProgress() {
var total = this.duration + this.endDelay;
if (!isFinite(total) || total <= 0) return 0;
var p = this.currentTime / total;
return p < 0 ? 0 : (p > 1 ? 1 : p);
}
/** Remaining time in ms (may be Infinity). */
getRemaining() {
return (this.duration + this.endDelay) - this.currentTime;
}
/** Whether the timer has actually completed (single-shot only). */
isComplete() {
return !this.isRunning && this.currentTime >= (this.duration + this.endDelay) && !this.loop;
}
}
// ============================================================================
// 2. POOL — zero-GC reuse of Timer instances
// ============================================================================
var _timerPool = glMatrix.createPool(
function () { return Object.create(Timer.prototype); },
32,
function (t) {
t.duration = Infinity;
t.loop = false;
t.onTick = null;
t.onComplete = null;
t.onBegin = null;
t.onLoop = null;
t.currentTime = 0;
t.isRunning = false;
t.lastStepTime = 0;
t.timeScale = 1;
t.endDelay = 0;
t.maxLoops = Infinity;
t._loopCount = 0;
t.began = false;
t.simulationTime = 0;
}
);
function acquireTimer(config) {
var t = _timerPool.acquire();
Timer.call(t, config);
return t;
}
function releaseTimer(t) {
t.pause();
_timerPool.release(t);
}
// ============================================================================
// 3. ONE-SHOT HELPER (setTimeout-style but frame-synced)
// ============================================================================
/**
Fire `fn` after `ms` milliseconds, synced to the animation frame.
@returns {Timer}
*/
function after(ms, fn, options) {
options = options || {};
var cfg = {
duration: ms,
onComplete: function (t) { if (fn) fn(t); },
autoplay: options.autoplay !== false
};
if (options.onBegin) cfg.onBegin = options.onBegin;
if (options.onTick) cfg.onTick = options.onTick;
if (options.timeScale) cfg.timeScale = options.timeScale;
return new Timer(cfg);
}
// ============================================================================
// 4. TIMER GROUP (SOA) — 1M+ timers per frame, one tight loop
// ============================================================================
/**
Create a SOA-backed group of N independent timers.
Single callback per group (not per timer) — the workhorse for 1M+.
Example:
var g = createTimerGroup(1_000_000, {
defaultDuration: 1500,
onTick: function (i, t) { // update particle i },
onComplete: function (i) { // despawn particle i }
});
engine.addSoaStep(function (dtSec) { g.step(dtSec * 1000); });
*/
function createTimerGroup(count, options) {
options = options || {};
var durations = new Float64Array(count);
var currentTimes = new Float64Array(count);
var actives = new Uint8Array(count);
var loopFlags = new Uint8Array(count);
var loopCounts = new Uint32Array(count);
var maxLoopsArr = new Uint32Array(count);
var endDelays = options.endDelay ? new Float64Array(count) : null;
var onTick = options.onTick || null;
var onComplete = options.onComplete || null;
var onLoop = options.onLoop || null;
var timeScale = options.timeScale !== undefined ? options.timeScale : 1;
// Initialise durations
if (options.durations) {
durations.set(options.durations);
} else {
var defDur = options.defaultDuration !== undefined ? options.defaultDuration : 1000;
durations.fill(defDur);
}
// Initialise loop configuration
if (options.loops !== undefined) {
if (Array.isArray(options.loops) || (options.loops.BYTES_PER_ELEMENT !== undefined)) {
for (var li = 0; li < count; li++) {
var lv = options.loops[li];
if (lv) {
loopFlags[li] = 1;
maxLoopsArr[li] = (typeof lv === "number") ? lv : 0;
}
}
} else if (typeof options.loops === "number") {
loopFlags.fill(1);
maxLoopsArr.fill(options.loops);
} else if (options.loops === true) {
loopFlags.fill(1);
maxLoopsArr.fill(0); // 0 == infinite
}
}
// Optionally start all
actives.fill(options.autoplay !== false ? 1 : 0);
if (options.initialCurrentTimes) currentTimes.set(options.initialCurrentTimes);
if (endDelays && options.endDelays) endDelays.set(options.endDelays);
function _stepOne(i, scaledDt) {
if (!actives[i]) return;
currentTimes[i] += scaledDt;
if (onTick) onTick(i, currentTimes[i]);
var total = durations[i] + (endDelays ? endDelays[i] : 0);
if (currentTimes[i] >= total) {
if (loopFlags[i]) {
loopCounts[i]++;
if (maxLoopsArr[i] > 0 && loopCounts[i] >= maxLoopsArr[i]) {
actives[i] = 0;
if (onComplete) onComplete(i);
return;
}
currentTimes[i] = 0;
if (onLoop) onLoop(i);
} else {
actives[i] = 0;
if (onComplete) onComplete(i);
}
}
}
/** Synchronous step — 1M+ timers in a single tight loop. */
function step(dtMs) {
var scaled = dtMs * timeScale;
for (var i = 0; i < count; i++) _stepOne(i, scaled);
}
/** Chunked async — mobile-safe: yields every `yieldEvery` chunks. */
async function stepChunked(dtMs, chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
var scaled = dtMs * timeScale;
var c = 0;
for (var start = 0; start < count; start += chunkSize) {
var end = Math.min(start + chunkSize, count);
for (var i = start; i < end; i++) _stepOne(i, scaled);
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
}
/** Linear scan count of currently-active timers. */
function getActiveCount() {
var s = 0;
for (var i = 0; i < count; i++) if (actives[i]) s++;
return s;
}
return {
count: count,
durations: durations,
currentTimes: currentTimes,
actives: actives,
loopFlags: loopFlags,
loopCounts: loopCounts,
maxLoopsArr: maxLoopsArr,
step: step,
stepChunked: stepChunked,
start: function (i) { actives[i] = 1; },
startAll: function () { actives.fill(1); },
stop: function (i) { actives[i] = 0; },
stopAll: function () { actives.fill(0); },
restart: function (i) { currentTimes[i] = 0; loopCounts[i] = 0; actives[i] = 1; },
restartAll: function () { currentTimes.fill(0); loopCounts.fill(0); actives.fill(1); },
setDuration: function (i, d) { durations[i] = d; },
setDurations: function (arr) { durations.set(arr); },
setTimeScale: function (s) { timeScale = s; },
getTimeScale: function () { return timeScale; },
getActiveCount: getActiveCount
};
}
// ============================================================================
// 5. FIXED-STEP SCHEDULER (60 / 90 / 120 / 144 Hz safe)
// ============================================================================
/**
Wrap a callback that must run at a fixed cadence regardless of frame rate.
Accumulates real dt and fires `onFixedStep(fixedDtSec)` in fixed-size
chunks. Spiral-of-death guard caps the number of catch-up steps.
(Blueprint Snippet 51: Deterministic Fixed-Step Simulation Accumulator)
*/
function createFixedStepScheduler(hz, onFixedStep, maxSteps) {
var stepMs = 1000 / hz;
var accumulator = 0;
maxSteps = maxSteps || 8;
return {
step: function (dtMs) {
accumulator += dtMs;
var steps = 0;
while (accumulator >= stepMs && steps < maxSteps) {
onFixedStep(stepMs * 0.001);
accumulator -= stepMs;
steps++;
}
// Spiral-of-death guard: if we hit the cap, discard remaining time
if (steps === maxSteps) accumulator = 0;
},
reset: function () { accumulator = 0; },
getAccumulator: function () { return accumulator; }
};
}
// ============================================================================
// 6. ORBITAL EPOCH — advance Kepler mean anomaly by real time
// ============================================================================
/**
Advance the mean anomaly M of every entry in `elements` by `n * dt`,
where `n = sqrt(mu / a³)` (Kepler's third law). M wraps in [0, 2π)
by default. Ideal for 1M+ bodies: no per-entity timer objects, just
one Float64Array mutation per frame.
@param {Object} elements  { a: Float32Array, M: Float32Array, ... }
@param {Object} options   { mu = 1, timeScale = 1, wrap = true }
*/
function createOrbitalEpoch(elements, options) {
options = options || {};
var mu = options.mu !== undefined ? options.mu : 1;
var timeScale = options.timeScale !== undefined ? options.timeScale : 1;
var wrap = options.wrap !== false;
var TWO_PI = Math.PI * 2;
function step(dtSec) {
var aArr = elements.a, MArr = elements.M;
var n = aArr.length;
var scaled = dtSec * timeScale;
for (var i = 0; i < n; i++) {
var a = aArr[i];
var meanMotion = Math.sqrt(mu / (a * a * a));
var M = MArr[i] + scaled * meanMotion;
if (wrap) M = M % TWO_PI;
MArr[i] = M;
}
}
async function stepChunked(dtSec, chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
var aArr = elements.a, MArr = elements.M;
var n = aArr.length;
var scaled = dtSec * timeScale;
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
var end = Math.min(start + chunkSize, n);
for (var i = start; i < end; i++) {
var a = aArr[i];
var meanMotion = Math.sqrt(mu / (a * a * a));
var M = MArr[i] + scaled * meanMotion;
if (wrap) M = M % TWO_PI;
MArr[i] = M;
}
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
}
return {
step: step,
stepChunked: stepChunked,
setMu: function (newMu) { mu = newMu; },
setTimeScale: function (s) { timeScale = s; }
};
}
// ============================================================================
// 7. BATCH TICK — deterministic ordering of an array of Timer instances
// ============================================================================
/**
Advance an array of Timer instances by an exact dt. Uses `stepFixed` for
determinism and preserves registration order. Useful when you need
reproducible results (replays, physics-locked systems).
*/
function batchTick(timers, dtMs) {
for (var i = 0; i < timers.length; i++) {
if (timers[i].isRunning) timers[i].stepFixed(dtMs);
}
}
// ============================================================================
// 8. EXPORTS
// ============================================================================
exports.Timer = Timer;
exports.acquireTimer = acquireTimer;
exports.releaseTimer = releaseTimer;
exports.after = after;
exports.createTimerGroup = createTimerGroup;
exports.createFixedStepScheduler = createFixedStepScheduler;
exports.createOrbitalEpoch = createOrbitalEpoch;
exports.batchTick = batchTick;
// math modules re-exported for convenience
exports.math = {
common: glMatrix,
utils: utils,
engine: engineModule,
vec3: vec3,
quat: quat,
bitecs: bitecs,
simplex: simplex
};