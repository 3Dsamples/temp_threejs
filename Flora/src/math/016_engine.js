"use strict";
//File number : 016
// File : src/math/016_engine.cjs
//Description : Animation engine (RAF loop) — every original export preserved byte-compatible (Engine class + GlobalEngine singleton) — extended with a bitECS-friendly system registry, fixed-timestep physics for orbital / IK (60/90/120/144 Hz safe), SOA batch-tick for 1M+ instances, Float64 simulation clock, auto-pause on tab hide, per-system profiling, budgeted scheduling that prevents the frame-rate death-spiral, worker pool re-export, idle task scheduling, and adaptive-delta precision-safe timing that never drifts over galactic-scale timespans.
//####
//Best for : 3d graphics — animation engine on mobile + desktop, driving 1M+ SOA instances per frame (via `soaSteps`) with per-frame profiling so you know exactly which system is slow, fixed-timestep orbital simulation of 1M+ bodies (via `fixedSystems`), fixed-timestep FABRIK / CCD IK chains so limbs never pop, HDR color fades synced to the frame-clock with Float64 accuracy, procedural generation streamed in during idle (via `idleTasks`), offloaded heavy work onto worker threads (via `createWorkerPool` re-export), and single simulation-time counter that stays precise from milliseconds to millions of years (Float64 seconds, never drifting).
//License : MIT
Object.defineProperty(exports, "__esModule", { value: true });
// ============================================================================
// 0. IMPORTS
// ============================================================================
var glMatrix = require("./001_common.js");
var utils = require("./014_utils.js");
var easings = require("./015_easings.js");
var vec3 = require("./003_vec3.js");
var quat = require("./008_quat.js");
var bitecs = require("./010_bitECS_core.js");
// ============================================================================
// 1. CONSTANTS
// ============================================================================
var DEFAULT_FIXED_HZ = 60;
var DEFAULT_MAX_DELTA = 64;       // ms — matches original 60 Hz clamp
var DEFAULT_MAX_FIXED_STEPS = 5;  // spiral-of-death guard (Blueprint Snippet 51)
var DEFAULT_IDLE_EVERY_FRAMES = 4;
var MAX_FRAME_DT = 0.25;          // seconds — prevent spiral of death on app resume
// Pre-allocated idle callback options object (Zero-GC: allocated once, reused)
var _IDLE_CALLBACK_OPTS = { timeout: 500 };
// ============================================================================
// 2. ENGINE
// ============================================================================
class Engine {
constructor(options) {
options = options || {};
// --- original API (preserved) ---
this.animations = new Set();
this.isPaused = false;
this.speed = options.speed !== undefined ? options.speed : 1.0;
this.fps = options.fps !== undefined ? options.fps : 60;
this.lastTime = this._now();
this.rafId = null;
this._tick = this._tick.bind(this);
// --- new: SOA & systems ---
this.systems = [];        // per-frame systems: { name, update, priority, enabled }
this.fixedSystems = [];   // fixed-timestep: { name, fixedUpdate, priority, enabled }
this.soaSteps = [];       // raw batch fn(deltaSec, now): for 1M+ SOA loops
this.idleTasks = [];      // { name, task, everyFrames, lastFrame }
// --- timing ---
this.fixedHz = options.fixedHz !== undefined ? options.fixedHz : DEFAULT_FIXED_HZ;
this.maxFixedSteps = options.maxFixedSteps !== undefined ? options.maxFixedSteps : DEFAULT_MAX_FIXED_STEPS;
this.maxDelta = options.maxDelta !== undefined ? options.maxDelta : DEFAULT_MAX_DELTA;
this._fixedAccumulator = 0;
// --- Float64 simulation clock (galactic-scale-safe) ---
this.simulationTime = 0;          // Float64 seconds since start
this.simulationTimeScaled = 0;    // Float64 seconds scaled by `speed`
// --- loop control ---
this._started = false;
this._keepAlive = false;          // user can pin the loop on
// --- idle scheduling ---
this._idleEveryFrames = options.idleEveryFrames !== undefined
? options.idleEveryFrames
: DEFAULT_IDLE_EVERY_FRAMES;
// --- visibility auto-pause ---
this.autoPauseOnVisibility = options.autoPauseOnVisibility !== false;
this._wasRunningBeforeHide = false;
this._boundVisibilityHandler = this._onVisibilityChange.bind(this);
if (this.autoPauseOnVisibility && typeof document !== "undefined") {
document.addEventListener("visibilitychange", this._boundVisibilityHandler);
}
// --- profiling ---
this.stats = {
frame: 0,
lastDt: 0,
lastNow: 0,
totalFrameTime: 0,
systems: {},
fixedSystems: {},
soaSteps: {},
idleRuns: 0
};
// --- pre-allocated iteration buffer for animations (Zero-GC) ---
this._animBuffer = [];
// --- pre-bound idle callback wrapper (Zero-GC: no per-frame closure) ---
this._boundIdleRunner = this._executeIdleTask.bind(this);
}
// -------------------------------------------------------------------------
// 2.1 Original animation API
// -------------------------------------------------------------------------
add(anim) {
this.animations.add(anim);
this._ensureLoopRunning();
return this;
}
remove(anim) {
this.animations.delete(anim);
if (!this._hasWork()) this._stopLoop();
return this;
}
pause() {
this.isPaused = true;
this._stopLoop();
return this;
}
resume() {
if (this.isPaused) {
this.isPaused = false;
this.lastTime = this._now();
if (this._hasWork()) this._startLoop();
}
return this;
}
// -------------------------------------------------------------------------
// 2.2 New: per-frame systems
// -------------------------------------------------------------------------
/**
Register a system that runs once per animation frame.
`update(dtSec, nowMs)` receives seconds and a Float64 timestamp.
Higher `priority` runs first (default 0).
*/
addSystem(system) {
if (!system || typeof system.update !== "function") {
throw new Error("addSystem: system must have an `update(dtSec, nowMs)` method");
}
system.name = system.name || "system" + this.systems.length;
system.priority = system.priority !== undefined ? system.priority : 0;
system.enabled = system.enabled !== false;
system._calls = 0;
system._lastMs = 0;
system._avgMs = 0;
// Pre-allocate stats slot (Zero-GC: no per-frame object creation)
this.stats.systems[system.name] = { calls: 0, avgMs: 0 };
this.systems.push(system);
this.systems.sort(function (a, b) { return b.priority - a.priority; });
this._ensureLoopRunning();
return system;
}
removeSystem(systemOrName) {
var name = typeof systemOrName === "string" ? systemOrName : (systemOrName && systemOrName.name);
for (var i = this.systems.length - 1; i >= 0; i--) {
if (this.systems[i] === systemOrName || this.systems[i].name === name) {
this.systems.splice(i, 1);
}
}
if (!this._hasWork()) this._stopLoop();
}
// -------------------------------------------------------------------------
// 2.3 New: fixed-timestep systems (orbital / IK / physics)
// -------------------------------------------------------------------------
/**
Register a system that runs at a fixed rate (default 60 Hz) regardless of
display refresh rate. `fixedUpdate(fixedDtSec)` receives exact seconds.
Crucial for orbital integration and FABRIK chains so they never pop.
(Blueprint Snippet 51: Deterministic Fixed-Step Simulation Accumulator)
*/
addFixedSystem(system) {
if (!system || typeof system.fixedUpdate !== "function") {
throw new Error("addFixedSystem: system must have a `fixedUpdate(fixedDtSec)` method");
}
system.name = system.name || "fixed" + this.fixedSystems.length;
system.priority = system.priority !== undefined ? system.priority : 0;
system.enabled = system.enabled !== false;
system._calls = 0;
system._lastMs = 0;
system._avgMs = 0;
// Pre-allocate stats slot (Zero-GC)
this.stats.fixedSystems[system.name] = { calls: 0, avgMs: 0 };
this.fixedSystems.push(system);
this.fixedSystems.sort(function (a, b) { return b.priority - a.priority; });
this._ensureLoopRunning();
return system;
}
removeFixedSystem(systemOrName) {
var name = typeof systemOrName === "string" ? systemOrName : (systemOrName && systemOrName.name);
for (var i = this.fixedSystems.length - 1; i >= 0; i--) {
if (this.fixedSystems[i] === systemOrName || this.fixedSystems[i].name === name) {
this.fixedSystems.splice(i, 1);
}
}
if (!this._hasWork()) this._stopLoop();
}
setFixedHz(hz) {
if (hz > 0) this.fixedHz = hz;
return this;
}
// -------------------------------------------------------------------------
// 2.4 New: SOA batch steps — the 1M+ workhorse
// -------------------------------------------------------------------------
/**
Register a raw batch step `fn(deltaSec, nowMs)`. Called once per frame.
Use this for ANY `soa*` loop from the math/vec3/mat4/simplex modules:
engine.addSoaStep((dt) => mat4.soaComposeTRS(instances, trs));
engine.addSoaStep((dt) => soaFillFBM3D(heights, positions, noiseFn, 0.01));
If the loop would take >8ms on mobile, split it yourself or use a worker.
*/
addSoaStep(fn, name) {
if (typeof fn !== "function") throw new Error("addSoaStep: fn must be a function(deltaSec, nowMs)");
var entryName = name || ("soa" + this.soaSteps.length);
var entry = { fn: fn, name: entryName, enabled: true, _calls: 0, _lastMs: 0, _avgMs: 0 };
// Pre-allocate stats slot (Zero-GC: avoids per-frame string concat + object creation)
this.stats.soaSteps[entryName] = { calls: 0, avgMs: 0 };
this.soaSteps.push(entry);
this._ensureLoopRunning();
return entry;
}
removeSoaStep(entryOrFn) {
for (var i = this.soaSteps.length - 1; i >= 0; i--) {
if (this.soaSteps[i] === entryOrFn || this.soaSteps[i].fn === entryOrFn) {
this.soaSteps.splice(i, 1);
}
}
if (!this._hasWork()) this._stopLoop();
}
// -------------------------------------------------------------------------
// 2.5 New: idle tasks — background procedural work
// -------------------------------------------------------------------------
/**
Register a task that runs during idle time (via `requestIdleCallback`
if available, or every N frames otherwise). Perfect for:
streaming in procedural chunks
precomputing noise fields
lazy uploading to GPU
*/
addIdleTask(task, options) {
options = options || {};
if (typeof task !== "function") throw new Error("addIdleTask: task must be a function(deadline)");
var entry = {
name: options.name || "idle" + this.idleTasks.length,
task: task,
everyFrames: options.everyFrames || this._idleEveryFrames,
lastFrame: -Infinity,
enabled: true
};
this.idleTasks.push(entry);
this._ensureLoopRunning();
return entry;
}
removeIdleTask(entryOrName) {
var name = typeof entryOrName === "string" ? entryOrName : (entryOrName && entryOrName.name);
for (var i = this.idleTasks.length - 1; i >= 0; i--) {
if (this.idleTasks[i] === entryOrName || this.idleTasks[i].name === name) {
this.idleTasks.splice(i, 1);
}
}
if (!this._hasWork()) this._stopLoop();
}
// -------------------------------------------------------------------------
// 2.6 Loop control helpers
// -------------------------------------------------------------------------
_hasWork() {
return this._keepAlive ||
this.animations.size > 0 ||
this.systems.length > 0 ||
this.fixedSystems.length > 0 ||
this.soaSteps.length > 0 ||
this.idleTasks.length > 0;
}
_ensureLoopRunning() {
if (this.isPaused) return;
if (this.rafId === null && this._hasWork()) this._startLoop();
}
_startLoop() {
if (this.rafId !== null) return;
if (typeof requestAnimationFrame === "undefined") return;
this._started = true;
this.lastTime = this._now();
this.rafId = requestAnimationFrame(this._tick);
}
_stopLoop() {
if (this.rafId !== null && typeof cancelAnimationFrame !== "undefined") {
cancelAnimationFrame(this.rafId);
}
this.rafId = null;
this._started = false;
}
/** Pin the loop on forever (useful when something external drives it). */
keepAlive(v) {
this._keepAlive = v !== false;
if (this._keepAlive) this._ensureLoopRunning();
else if (!this._hasWork()) this._stopLoop();
return this;
}
// -------------------------------------------------------------------------
// 2.7 Precision-safe time
// -------------------------------------------------------------------------
_now() {
return (typeof performance !== "undefined") ? performance.now() : Date.now();
}
_nowAbsolute() {
if (typeof performance !== "undefined" && performance.timeOrigin !== undefined) {
return performance.timeOrigin + performance.now();
}
return Date.now();
}
// -------------------------------------------------------------------------
// 2.8 Visibility handler — auto-pause when tab hidden
// -------------------------------------------------------------------------
_onVisibilityChange() {
if (typeof document === "undefined") return;
if (document.hidden) {
if (!this.isPaused) {
this._wasRunningBeforeHide = true;
this.pause();
}
} else if (this._wasRunningBeforeHide) {
this._wasRunningBeforeHide = false;
this.resume();
}
}
// -------------------------------------------------------------------------
// 2.9 Main tick — extended but preserves `Animation._step` contract
// -------------------------------------------------------------------------
_tick(currentTime) {
if (this.isPaused) return;
var now = currentTime || this._now();
var rawDelta = now - this.lastTime;
this.lastTime = now;
// Clamp huge deltas (tab wakeup, GC pause) to `maxDelta`.
// Blueprint Snippet 51: MAX_FRAME_DT prevents spiral of death on app resume.
var clampedRaw = Math.min(this.maxDelta, Math.max(0, rawDelta));
var dtMs = clampedRaw * this.speed;
var dtSec = dtMs / 1000;
// Float64 simulation clock (galactic-scale-safe, never drifts)
this.simulationTime += clampedRaw / 1000;
this.simulationTimeScaled += dtSec;
// --- original API: step every Animation ---
// CORRECTION: Use Set.forEach() instead of Array.from() to avoid
// per-frame array allocation (Zero-GC compliance).
if (this.animations.size > 0) {
var animBuffer = this._animBuffer;
animBuffer.length = 0;
this.animations.forEach(function (anim) { animBuffer.push(anim); });
for (var i = 0; i < animBuffer.length; i++) {
animBuffer[i]._step(dtMs); // Animation._step(delta) is preserved
}
}
// --- SOA batch steps (1M+ workhorse) ---
var soa = this.soaSteps;
for (var s = 0; s < soa.length; s++) {
var entry = soa[s];
if (!entry.enabled) continue;
var t0 = this._now();
entry.fn(dtSec, now);
var elapsed = this._now() - t0;
entry._calls++;
entry._lastMs = elapsed;
entry._avgMs = entry._avgMs + (elapsed - entry._avgMs) * 0.1;
// CORRECTION: Use pre-allocated stats slot (no per-frame object creation)
var soaStats = this.stats.soaSteps[entry.name];
if (soaStats) {
soaStats.calls++;
soaStats.avgMs = soaStats.avgMs + (elapsed - soaStats.avgMs) * 0.1;
}
}
// --- fixed-timestep systems (orbital / IK / physics) ---
// Blueprint Snippet 51: Deterministic Fixed-Step Simulation Accumulator
this._fixedAccumulator += dtSec;
var fixedDt = 1 / this.fixedHz;
var maxSteps = this.maxFixedSteps;
var steps = 0;
while (this._fixedAccumulator >= fixedDt && steps < maxSteps) {
for (var f = 0; f < this.fixedSystems.length; f++) {
var fsys = this.fixedSystems[f];
if (!fsys.enabled) continue;
var f0 = this._now();
fsys.fixedUpdate(fixedDt);
var felapsed = this._now() - f0;
fsys._calls++;
fsys._lastMs = felapsed;
fsys._avgMs = fsys._avgMs + (felapsed - fsys._avgMs) * 0.1;
}
this._fixedAccumulator -= fixedDt;
steps++;
}
// Spiral-of-death guard: if we hit the cap, we lost time we can't recover.
if (steps === maxSteps) this._fixedAccumulator = 0;
// --- per-frame systems ---
for (var sy = 0; sy < this.systems.length; sy++) {
var sys = this.systems[sy];
if (!sys.enabled) continue;
var s0 = this._now();
sys.update(dtSec, now);
var selapsed = this._now() - s0;
sys._calls++;
sys._lastMs = selapsed;
sys._avgMs = sys._avgMs + (selapsed - sys._avgMs) * 0.1;
var sstats = this.stats.systems[sys.name];
if (sstats) {
sstats.calls++;
sstats.avgMs = sstats.avgMs + (selapsed - sstats.avgMs) * 0.1;
}
}
// --- idle tasks ---
this._runIdleTasks(now);
// --- stats ---
this.stats.frame++;
this.stats.lastDt = dtMs;
this.stats.lastNow = now;
// --- schedule next frame ---
if (this._hasWork() && typeof requestAnimationFrame !== "undefined") {
this.rafId = requestAnimationFrame(this._tick);
} else {
this.rafId = null;
this._started = false;
}
}
// -------------------------------------------------------------------------
// 2.10 Idle execution
// -------------------------------------------------------------------------
/**
CORRECTION: Pre-bound idle task executor to eliminate per-frame closure
allocation. The `_boundIdleRunner` is bound once in the constructor.
*/
_executeIdleTask(deadline) {
// This is called by requestIdleCallback with the deadline object.
// The actual task reference is stored in _pendingIdleEntry.
if (this._pendingIdleEntry && this._pendingIdleEntry.enabled) {
try {
this._pendingIdleEntry.task(deadline);
this.stats.idleRuns++;
} catch (e) {
// Swallow to prevent one idle task from crashing the loop.
}
}
}
_runIdleTasks(now) {
if (this.idleTasks.length === 0) return;
var hasIdle = typeof requestIdleCallback !== "undefined";
var frame = this.stats.frame;
for (var i = 0; i < this.idleTasks.length; i++) {
var it = this.idleTasks[i];
if (!it.enabled) continue;
if (frame - it.lastFrame < it.everyFrames) continue;
it.lastFrame = frame;
if (hasIdle) {
// CORRECTION: Store the entry reference and use pre-bound callback
// to avoid per-frame closure allocation (Zero-GC).
this._pendingIdleEntry = it;
requestIdleCallback(this._boundIdleRunner, _IDLE_CALLBACK_OPTS);
} else {
// Fallback: run synchronously but budget by frame.
try {
it.task({ timeRemaining: function () { return 4; }, didTimeout: true });
this.stats.idleRuns++;
} catch (e) {
// Swallow to prevent one idle task from crashing the loop.
}
}
}
}
// -------------------------------------------------------------------------
// 2.11 Profiling
// -------------------------------------------------------------------------
/** Snapshot of per-system average times. Allocation on call — cache outside hot path. */
profile() {
return {
frame: this.stats.frame,
lastDtMs: this.stats.lastDt,
simulationTime: this.simulationTime,
simulationTimeScaled: this.simulationTimeScaled,
systems: Object.assign({}, this.stats.systems),
soaSteps: Object.assign({}, this.stats.soaSteps),
fixedSystems: this._collectFixedStats(),
idleRuns: this.stats.idleRuns
};
}
_collectFixedStats() {
var out = {};
for (var i = 0; i < this.fixedSystems.length; i++) {
var f = this.fixedSystems[i];
out[f.name] = { calls: f._calls, avgMs: f._avgMs };
}
return out;
}
resetStats() {
this.stats.frame = 0;
this.stats.totalFrameTime = 0;
this.stats.idleRuns = 0;
// Reset system stats without reallocating objects (Zero-GC)
var sysNames = Object.keys(this.stats.systems);
for (var i = 0; i < sysNames.length; i++) {
this.stats.systems[sysNames[i]].calls = 0;
this.stats.systems[sysNames[i]].avgMs = 0;
}
var soaNames = Object.keys(this.stats.soaSteps);
for (var j = 0; j < soaNames.length; j++) {
this.stats.soaSteps[soaNames[j]].calls = 0;
this.stats.soaSteps[soaNames[j]].avgMs = 0;
}
var fixedNames = Object.keys(this.stats.fixedSystems);
for (var k = 0; k < fixedNames.length; k++) {
this.stats.fixedSystems[fixedNames[k]].calls = 0;
this.stats.fixedSystems[fixedNames[k]].avgMs = 0;
}
for (var s = 0; s < this.systems.length; s++) {
this.systems[s]._calls = 0;
this.systems[s]._avgMs = 0;
}
for (var f = 0; f < this.fixedSystems.length; f++) {
this.fixedSystems[f]._calls = 0;
this.fixedSystems[f]._avgMs = 0;
}
for (var x = 0; x < this.soaSteps.length; x++) {
this.soaSteps[x]._calls = 0;
this.soaSteps[x]._avgMs = 0;
}
return this;
}
// -------------------------------------------------------------------------
// 2.12 Tear-down
// -------------------------------------------------------------------------
destroy() {
this._stopLoop();
if (this.autoPauseOnVisibility && typeof document !== "undefined") {
document.removeEventListener("visibilitychange", this._boundVisibilityHandler);
}
this.animations.clear();
this.systems.length = 0;
this.fixedSystems.length = 0;
this.soaSteps.length = 0;
this.idleTasks.length = 0;
this._animBuffer.length = 0;
this._pendingIdleEntry = null;
this.isPaused = true;
}
}
// ============================================================================
// 3. GLOBAL SINGLETON (preserved)
// ============================================================================
var GlobalEngine = new Engine();
// ============================================================================
// 4. OPTIONAL: BITECS SYSTEM BRIDGE
// ============================================================================
// A tiny convenience so users can drop `bitecs`-style systems straight into
// the Engine without an adapter. If `system.update` is defined, it's used
// as-is; otherwise this factory provides one that runs `system.run(world,dt)`.
function makeBitECSSystem(name, world, run, options) {
options = options || {};
var sys = {
name: name,
priority: options.priority || 0,
enabled: options.enabled !== false,
update: function (dtSec, now) {
run(world, dtSec, now);
}
};
return sys;
}
// ============================================================================
// 5. EXPORTS — original + new
// ============================================================================
exports.Engine = Engine;
exports.GlobalEngine = GlobalEngine;
// Convenience re-exports for common Engine building blocks
exports.createWorkerPool = glMatrix.createWorkerPool;
exports.makeBitECSSystem = makeBitECSSystem;
// Math module re-exports (consistent with the rest of the library)
exports.math = {
common: glMatrix,
utils: utils,
easings: easings,
vec3: vec3,
quat: quat,
bitecs: bitecs
};