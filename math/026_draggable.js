"use strict";
//File number : 026
// File : src/math/026_draggable.js
//Description : Pointer drag system — every original export preserved byte-compatible (`draggable(target, opts)` with `onDragStart`, `onDrag`, `onDragEnd`, `bounds`, `inertia`, `snap`, `pointermove`/`pointerup` window listeners, `cursor: grab/grabbing`, `touch-action: none`, spring inertia) — extended with: a true zero-GC listener pool (handler closures + wrapper allocated ONCE per pool slot), frame-synced inertia driven by `GlobalEngine.addSoaStep` instead of `setInterval`, `attachSOADraggable` (drag 1M+ instanced rows through a pivot with hoisted axis/bounds/snap branches and chunked apply), `attachIKDrag` (FABRIK/CCD chain follows the pointer with configurable tolerance), `attachOrbitalDrag` (drag advances Kepler mean anomaly of 1M+ bodies with non-negative wrap), `attachSOASnapGrid` (grid snap wired to drag-end), `attachHDRTrail` (HDR-safe emissive trail with chunked write/decay), `attachECSDrag` (bitECS query bridge), full pointer-capture release, passive mobile listeners, and complete listener teardown.
//####
//Best for : 3d graphics — pointer-driven editing of procedural worlds (drag an entire asteroid belt via a SOA pivot, IK arms reaching for a cursor, orbital satellites dragged around a star with correct Kepler physics), hero UIs with momentum + snap, canvas-based WebGL scenes with an invisible HTML drag layer, HDR-glow drag trails, multi-handle transform gizmos, and up to 1M+ instances moved by a single pointer move without allocating an `Animation` per instance, a closure per event, or blocking the UI on Android 64-bit.
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
var clamp = utils.clamp;
// ============================================================================
// 0.1 SHARED CONSTANTS / HELPERS (Zero-GC)
// ============================================================================
var HAS_WINDOW = typeof window !== "undefined";
var PASSIVE = { passive: true };
var CAPTURE_PASSIVE = { passive: true, capture: false };
function now() {
return (typeof performance !== "undefined") ? performance.now() : Date.now();
}
/**
* CORRECTION: ES6 class constructors cannot be invoked via `.call()`.
* Pooled Animation reuse is enabled only when the prototype exposes a
* re-initializable `_init` hook; otherwise we fall back to `new Animation`
* and pause the previous instance so at most one is live per handle.
*/
var _HAS_ANIM_INIT = typeof Animation.prototype._init === "function";
var _animPool = _HAS_ANIM_INIT
? glMatrix.createPool(
function () { return Object.create(Animation.prototype); },
16,
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
/** Resolve axis string ONCE (never per element inside a 1M+ loop). */
function _axisMode(axis) {
if (axis === "xz") return 1;
if (axis === "yz") return 2;
if (axis === "xyz") return 3;
return 0; // "xy"
}
function _releaseCapture(el, pointerId) {
if (el && el.releasePointerCapture && pointerId !== undefined) {
try { el.releasePointerCapture(pointerId); } catch (e) { /* swallow */ }
}
}
// ============================================================================
// 1. ORIGINAL `draggable` (byte-compatible behaviour)
// CORRECTION: plain loop instead of `forEach` closure; the inertia config
// object and its `onComplete` closure are allocated ONCE per element at
// attach time, not on every pointerup. Full teardown returned.
// ============================================================================
function draggable(target, opts) {
opts = opts || {};
var els = toArray(target);
var bundles = [];
for (var i = 0; i < els.length; i++) {
bundles.push(_makeDomBundle(els[i], opts));
}
return {
destroy: function () {
for (var k = 0; k < bundles.length; k++) bundles[k].detach();
bundles.length = 0;
}
};
}
/**
* Build one DOM drag bundle. All handlers and the inertia config are created
* once here (setup-time), so the pointer hot path allocates nothing.
*/
function _makeDomBundle(el, opts) {
var isDragging = false;
var startX = 0, startY = 0;
var curX = 0, curY = 0;
var velX = 0, velY = 0;
var lastTime = 0;
var inertiaAnim = null;
var bMinX = opts.bounds && opts.bounds.minX !== undefined ? opts.bounds.minX : -Infinity;
var bMaxX = opts.bounds && opts.bounds.maxX !== undefined ? opts.bounds.maxX : Infinity;
var bMinY = opts.bounds && opts.bounds.minY !== undefined ? opts.bounds.minY : -Infinity;
var bMaxY = opts.bounds && opts.bounds.maxY !== undefined ? opts.bounds.maxY : Infinity;
var snap = opts.snap || 0;
el.style.cursor = "grab";
el.style.touchAction = "none";
// Pre-allocated inertia config (reused on every release)
var inertiaCfg = {
targets: el,
translateX: 0,
translateY: 0,
duration: 600,
easing: "spring",
onComplete: function () {
curX = inertiaCfg.translateX;
curY = inertiaCfg.translateY;
if (opts.onDragEnd) opts.onDragEnd(curX, curY);
}
};
function onPointerDown(e) {
isDragging = true;
el.style.cursor = "grabbing";
startX = e.clientX - curX;
startY = e.clientY - curY;
lastTime = now();
_releaseAnim(inertiaAnim); inertiaAnim = null;
if (el.setPointerCapture && e.pointerId !== undefined) {
try { el.setPointerCapture(e.pointerId); } catch (err) { /* swallow */ }
}
if (opts.onDragStart) opts.onDragStart(curX, curY);
}
function onPointerMove(e) {
if (!isDragging) return;
var t = now();
var dt = (t - lastTime) || 16;
var newX = e.clientX - startX;
var newY = e.clientY - startY;
velX = (newX - curX) / dt;
velY = (newY - curY) / dt;
curX = clamp(newX, bMinX, bMaxX);
curY = clamp(newY, bMinY, bMaxY);
lastTime = t;
el.style.transform = "translate3d(" + curX + "px, " + curY + "px, 0px)";
if (opts.onDrag) opts.onDrag(curX, curY);
}
function onPointerUp(e) {
if (!isDragging) return;
isDragging = false;
el.style.cursor = "grab";
_releaseCapture(el, e && e.pointerId);
if (opts.inertia) {
var finalX = clamp(curX + velX * 120, bMinX, bMaxX);
var finalY = clamp(curY + velY * 120, bMinY, bMaxY);
if (snap) {
finalX = Math.round(finalX / snap) * snap;
finalY = Math.round(finalY / snap) * snap;
}
inertiaCfg.translateX = finalX;
inertiaCfg.translateY = finalY;
_releaseAnim(inertiaAnim);
inertiaAnim = _acquireAnim(inertiaCfg);
} else {
if (snap) {
curX = Math.round(curX / snap) * snap;
curY = Math.round(curY / snap) * snap;
el.style.transform = "translate3d(" + curX + "px, " + curY + "px, 0px)";
}
if (opts.onDragEnd) opts.onDragEnd(curX, curY);
}
}
el.addEventListener("pointerdown", onPointerDown);
if (HAS_WINDOW) {
window.addEventListener("pointermove", onPointerMove, PASSIVE);
window.addEventListener("pointerup", onPointerUp, PASSIVE);
window.addEventListener("pointercancel", onPointerUp, PASSIVE);
}
return {
el: el,
detach: function () {
el.removeEventListener("pointerdown", onPointerDown);
if (HAS_WINDOW) {
window.removeEventListener("pointermove", onPointerMove);
window.removeEventListener("pointerup", onPointerUp);
window.removeEventListener("pointercancel", onPointerUp);
}
_releaseAnim(inertiaAnim); inertiaAnim = null;
el.style.cursor = "";
}
};
}
// ============================================================================
// 2. POOL — reusable listener bundles (true zero-GC)
// CORRECTION: The original `acquireDraggable` created fresh handler closures,
// a fresh cleanups array, and a fresh `{release}` wrapper on EVERY acquire,
// which defeated the pool entirely. Now each pool slot pre-allocates
// MAX_ELS bundles (state + handlers) and the wrapper ONCE in the factory.
// ============================================================================
var MAX_ELS_PER_SLOT = 16;
function _makePooledBundle() {
var b = {
el: null, opts: null, attached: false,
isDragging: false, startX: 0, startY: 0, curX: 0, curY: 0,
velX: 0, velY: 0, lastTime: 0,
bMinX: -Infinity, bMaxX: Infinity, bMinY: -Infinity, bMaxY: Infinity, snap: 0
};
b.onDown = function (e) {
b.isDragging = true;
b.el.style.cursor = "grabbing";
b.startX = e.clientX - b.curX;
b.startY = e.clientY - b.curY;
b.lastTime = now();
if (b.el.setPointerCapture && e.pointerId !== undefined) {
try { b.el.setPointerCapture(e.pointerId); } catch (err) { /* swallow */ }
}
if (b.opts.onDragStart) b.opts.onDragStart(b.curX, b.curY);
};
b.onMove = function (e) {
if (!b.isDragging) return;
var t = now();
var dt = (t - b.lastTime) || 16;
var nx = e.clientX - b.startX;
var ny = e.clientY - b.startY;
b.velX = (nx - b.curX) / dt;
b.velY = (ny - b.curY) / dt;
b.curX = clamp(nx, b.bMinX, b.bMaxX);
b.curY = clamp(ny, b.bMinY, b.bMaxY);
b.lastTime = t;
if (b.snap) {
b.curX = Math.round(b.curX / b.snap) * b.snap;
b.curY = Math.round(b.curY / b.snap) * b.snap;
}
b.el.style.transform = "translate3d(" + b.curX + "px, " + b.curY + "px, 0px)";
if (b.opts.onDrag) b.opts.onDrag(b.curX, b.curY);
};
b.onUp = function (e) {
if (!b.isDragging) return;
b.isDragging = false;
b.el.style.cursor = "grab";
_releaseCapture(b.el, e && e.pointerId);
if (b.snap) {
b.curX = Math.round(b.curX / b.snap) * b.snap;
b.curY = Math.round(b.curY / b.snap) * b.snap;
}
b.el.style.transform = "translate3d(" + b.curX + "px, " + b.curY + "px, 0px)";
if (b.opts.onDragEnd) b.opts.onDragEnd(b.curX, b.curY);
};
b.attach = function (el, opts) {
b.el = el; b.opts = opts;
b.isDragging = false;
b.curX = 0; b.curY = 0; b.velX = 0; b.velY = 0; b.lastTime = 0;
b.bMinX = opts.bounds && opts.bounds.minX !== undefined ? opts.bounds.minX : -Infinity;
b.bMaxX = opts.bounds && opts.bounds.maxX !== undefined ? opts.bounds.maxX : Infinity;
b.bMinY = opts.bounds && opts.bounds.minY !== undefined ? opts.bounds.minY : -Infinity;
b.bMaxY = opts.bounds && opts.bounds.maxY !== undefined ? opts.bounds.maxY : Infinity;
b.snap = opts.snap || 0;
el.style.cursor = "grab";
el.style.touchAction = "none";
el.addEventListener("pointerdown", b.onDown);
if (HAS_WINDOW) {
window.addEventListener("pointermove", b.onMove, PASSIVE);
window.addEventListener("pointerup", b.onUp, PASSIVE);
window.addEventListener("pointercancel", b.onUp, PASSIVE);
}
b.attached = true;
};
b.detach = function () {
if (!b.attached) return;
var el = b.el;
el.removeEventListener("pointerdown", b.onDown);
if (HAS_WINDOW) {
window.removeEventListener("pointermove", b.onMove);
window.removeEventListener("pointerup", b.onUp);
window.removeEventListener("pointercancel", b.onUp);
}
el.style.cursor = "";
b.attached = false;
b.el = null; b.opts = null;
};
return b;
}
var _dragPool = glMatrix.createPool(
function () {
var slot = { bundles: [], used: 0, released: true };
for (var i = 0; i < MAX_ELS_PER_SLOT; i++) slot.bundles.push(_makePooledBundle());
slot.wrapper = {
release: function () {
if (slot.released) return;
_dragPool.release(slot);
}
};
return slot;
},
8,
function (slot) {
for (var i = 0; i < slot.used; i++) slot.bundles[i].detach();
slot.used = 0;
slot.released = true;
}
);
/**
* Pooled `draggable` — same options as `draggable`, returns a handle with
* `release()`. Handler closures and the wrapper come from the pool, so
* repeated create/destroy cycles (virtualised lists, dynamic panels) do
* not allocate. Targets beyond MAX_ELS_PER_SLOT grow the slot once at
* acquire time (setup, never per frame).
*/
function acquireDraggable(target, opts) {
opts = opts || {};
var els = toArray(target);
var slot = _dragPool.acquire();
slot.released = false;
for (var i = 0; i < els.length; i++) {
if (i >= slot.bundles.length) slot.bundles.push(_makePooledBundle());
slot.bundles[i].attach(els[i], opts);
}
slot.used = els.length;
return slot.wrapper;
}
// ============================================================================
// 3. SOA DRAGGABLE — pointer moves 1M+ instanced rows via a pivot
// CORRECTION: axis / bounds / snap branches hoisted OUT of the hot loop;
// inertia is frame-synced through GlobalEngine.addSoaStep (no setInterval,
// no per-release closure); chunked apply added for mobile 1M+ safety.
// ============================================================================
function attachSOADraggable(target, trs, options) {
options = options || {};
var el = typeof target === "string"
? (typeof document !== "undefined" ? document.querySelector(target) : null)
: target;
if (!el) return null;
var mode = _axisMode(options.axis || "xy");
var scale = options.scale !== undefined ? options.scale : 1;
var snap = options.snap || 0;
var hasSnap = snap !== 0;
var invSnap = hasSnap ? 1 / snap : 0;
var inertia = options.inertia !== false;
var onDragStart = options.onDragStart || null;
var onDrag = options.onDrag || null;
var onDragEnd = options.onDragEnd || null;
var b = options.bounds || null;
var hasMinX = !!(b && b.minX !== undefined), hasMaxX = !!(b && b.maxX !== undefined);
var hasMinY = !!(b && b.minY !== undefined), hasMaxY = !!(b && b.maxY !== undefined);
var hasMinZ = !!(b && b.minZ !== undefined), hasMaxZ = !!(b && b.maxZ !== undefined);
var minX = hasMinX ? b.minX : 0, maxX = hasMaxX ? b.maxX : 0;
var minY = hasMinY ? b.minY : 0, maxY = hasMaxY ? b.maxY : 0;
var minZ = hasMinZ ? b.minZ : 0, maxZ = hasMaxZ ? b.maxZ : 0;
var clampX = hasMinX || hasMaxX, clampY = hasMinY || hasMaxY, clampZ = hasMinZ || hasMaxZ;
if (!hasMinX) minX = -Infinity; if (!hasMaxX) maxX = Infinity;
if (!hasMinY) minY = -Infinity; if (!hasMaxY) maxY = Infinity;
if (!hasMinZ) minZ = -Infinity; if (!hasMaxZ) maxZ = Infinity;
var n = trs.position.count;
var px = trs.position.x, py = trs.position.y, pz = trs.position.z;
// Snapshot buffers (allocated once at attach)
var baseX = new Float32Array(n);
var baseY = new Float32Array(n);
var baseZ = new Float32Array(n);
var active = false;
var startX = 0, startY = 0, lastX = 0, lastY = 0;
var velX = 0, velY = 0, lastT = 0;
var offsetX = 0, offsetY = 0;
var dragEndHooks = [];
// ---- tight, branch-hoisted write loops -----------------------------------
function _writeRange(s, e, sx, sy) {
var i, nx, ny, nz;
if (mode === 0) {
for (i = s; i < e; i++) {
nx = baseX[i] + sx; ny = baseY[i] + sy;
if (clampX) nx = nx < minX ? minX : (nx > maxX ? maxX : nx);
if (clampY) ny = ny < minY ? minY : (ny > maxY ? maxY : ny);
if (hasSnap) { nx = Math.round(nx * invSnap) * snap; ny = Math.round(ny * invSnap) * snap; }
px[i] = nx; py[i] = ny;
}
} else if (mode === 1) {
for (i = s; i < e; i++) {
nx = baseX[i] + sx; nz = baseZ[i] + sy;
if (clampX) nx = nx < minX ? minX : (nx > maxX ? maxX : nx);
if (clampZ) nz = nz < minZ ? minZ : (nz > maxZ ? maxZ : nz);
if (hasSnap) { nx = Math.round(nx * invSnap) * snap; nz = Math.round(nz * invSnap) * snap; }
px[i] = nx; pz[i] = nz;
}
} else if (mode === 2) {
for (i = s; i < e; i++) {
ny = baseY[i] + sx; nz = baseZ[i] + sy;
if (clampY) ny = ny < minY ? minY : (ny > maxY ? maxY : ny);
if (clampZ) nz = nz < minZ ? minZ : (nz > maxZ ? maxZ : nz);
if (hasSnap) { ny = Math.round(ny * invSnap) * snap; nz = Math.round(nz * invSnap) * snap; }
py[i] = ny; pz[i] = nz;
}
} else {
for (i = s; i < e; i++) {
nx = baseX[i] + sx; ny = baseY[i] + sy; nz = baseZ[i] + sy;
if (clampX) nx = nx < minX ? minX : (nx > maxX ? maxX : nx);
if (clampY) ny = ny < minY ? minY : (ny > maxY ? maxY : ny);
if (clampZ) nz = nz < minZ ? minZ : (nz > maxZ ? maxZ : nz);
if (hasSnap) {
nx = Math.round(nx * invSnap) * snap;
ny = Math.round(ny * invSnap) * snap;
nz = Math.round(nz * invSnap) * snap;
}
px[i] = nx; py[i] = ny; pz[i] = nz;
}
}
}
function _apply(dx, dy) {
_writeRange(0, n, dx * scale, dy * scale);
}
async function _applyChunked(dx, dy, chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
var sx = dx * scale, sy = dy * scale;
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
_writeRange(start, Math.min(start + chunkSize, n), sx, sy);
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
}
function _snapshot() {
baseX.set(px); baseY.set(py); baseZ.set(pz);
}
function _fireDragEnd() {
if (onDragEnd) onDragEnd(offsetX, offsetY);
for (var i = 0; i < dragEndHooks.length; i++) dragEndHooks[i](offsetX, offsetY);
}
// ---- frame-synced inertia (pre-bound once, no per-release allocation) ----
var inertiaEntry = null;
var inertiaT = 0, inertiaDur = 0.6;
var inertiaBX = 0, inertiaBY = 0, inertiaVX = 0, inertiaVY = 0;
function _inertiaStep(dtSec) {
inertiaT += dtSec;
var p = inertiaT / inertiaDur;
if (p > 1) p = 1;
var et = 1 - Math.exp(-8 * p) * Math.cos(10 * p);
_apply(inertiaBX + inertiaVX * et, inertiaBY + inertiaVY * et);
if (p >= 1) {
_stopInertia();
offsetX = inertiaBX + inertiaVX;
offsetY = inertiaBY + inertiaVY;
_snapshot();
_fireDragEnd();
}
}
function _startInertia() {
if (inertiaEntry) return;
inertiaT = 0;
inertiaEntry = GlobalEngine.addSoaStep(_inertiaStep, "soaDragInertia");
}
function _stopInertia() {
if (!inertiaEntry) return;
GlobalEngine.removeSoaStep(inertiaEntry);
inertiaEntry = null;
}
// ---- pointer handlers (created once at attach) ---------------------------
function _onDown(e) {
active = true;
offsetX = 0; offsetY = 0;
startX = e.clientX; startY = e.clientY;
lastX = e.clientX; lastY = e.clientY;
velX = 0; velY = 0;
lastT = now();
_stopInertia();
_snapshot();
if (el.setPointerCapture && e.pointerId !== undefined) {
try { el.setPointerCapture(e.pointerId); } catch (err) { /* swallow */ }
}
if (onDragStart) onDragStart(0, 0);
}
function _onMove(e) {
if (!active) return;
var t = now();
var dt = (t - lastT) || 16;
velX = (e.clientX - lastX) / dt;
velY = (e.clientY - lastY) / dt;
lastX = e.clientX; lastY = e.clientY;
lastT = t;
offsetX = e.clientX - startX;
offsetY = e.clientY - startY;
_apply(offsetX, offsetY);
if (onDrag) onDrag(offsetX, offsetY);
}
function _onUp(e) {
if (!active) return;
active = false;
_releaseCapture(el, e && e.pointerId);
if (inertia && (Math.abs(velX) > 0.1 || Math.abs(velY) > 0.1)) {
inertiaBX = offsetX; inertiaBY = offsetY;
inertiaVX = velX * 120; inertiaVY = velY * 120;
_startInertia();
} else {
_snapshot();
_fireDragEnd();
}
}
el.style.touchAction = "none";
el.addEventListener("pointerdown", _onDown);
if (HAS_WINDOW) {
window.addEventListener("pointermove", _onMove, PASSIVE);
window.addEventListener("pointerup", _onUp, PASSIVE);
window.addEventListener("pointercancel", _onUp, PASSIVE);
}
return {
count: n,
apply: _apply,
applyChunked: _applyChunked,
/** Register an extra drag-end callback (used by attachSOASnapGrid). */
addDragEndHook: function (fn) { if (typeof fn === "function") dragEndHooks.push(fn); },
get offset() { return offsetX; },
get offsetY() { return offsetY; },
get dragging() { return active; },
destroy: function () {
el.removeEventListener("pointerdown", _onDown);
if (HAS_WINDOW) {
window.removeEventListener("pointermove", _onMove);
window.removeEventListener("pointerup", _onUp);
window.removeEventListener("pointercancel", _onUp);
}
_stopInertia();
dragEndHooks.length = 0;
}
};
}
// ============================================================================
// 4. IK DRAG — FABRIK / CCD chain follows the pointer
// CORRECTION: tolerance is configurable and compared against the DISTANCE
// error returned by the corrected `vec3.fabrikStep3` (the original compared
// a distance against a squared epsilon, so early-out never triggered).
// The pointerdown handler is now named and removed on destroy; pointer
// capture is released on pointerup.
// ============================================================================
function attachIKDrag(target, chain, joints, options) {
options = options || {};
var el = typeof target === "string"
? (typeof document !== "undefined" ? document.querySelector(target) : null)
: target;
if (!el) return null;
var zPlane = options.zPlane !== undefined ? options.zPlane : 0;
var iterations = options.iterations || 10;
var tolerance = options.tolerance !== undefined ? options.tolerance : 0.001;
var scale = options.scale !== undefined ? options.scale : 1;
var useCCD = options.method === "ccd";
var jointCount = joints ? joints.length : 0;
var rectLeft = 0, rectTop = 0;
var pointerId = null;
function _solve() {
if (useCCD) {
vec3.ccdStep3(chain.pos, chain.target, iterations);
} else {
for (var it = 0; it < iterations; it++) {
if (vec3.fabrikStep3(chain.pos, chain.lens, chain.target, tolerance) < tolerance) break;
}
}
for (var i = 0; i < jointCount; i++) {
joints[i].position.set(chain.pos[i * 3], chain.pos[i * 3 + 1], chain.pos[i * 3 + 2]);
}
}
function _update(clientX, clientY) {
chain.target[0] = (clientX - rectLeft) * scale;
chain.target[1] = (clientY - rectTop) * scale;
chain.target[2] = zPlane;
_solve();
}
function _onDown(e) {
var rect = el.getBoundingClientRect();
rectLeft = rect.left; rectTop = rect.top;
pointerId = e.pointerId;
if (el.setPointerCapture && pointerId !== undefined) {
try { el.setPointerCapture(pointerId); } catch (err) { /* swallow */ }
}
_update(e.clientX, e.clientY);
}
function _onMove(e) {
if (e.buttons === 0 && e.pointerType === "mouse") return;
_update(e.clientX, e.clientY);
}
function _onUp(e) {
_releaseCapture(el, e && e.pointerId);
pointerId = null;
}
el.style.touchAction = "none";
el.addEventListener("pointerdown", _onDown);
el.addEventListener("pointermove", _onMove, PASSIVE);
el.addEventListener("pointerup", _onUp, PASSIVE);
el.addEventListener("pointercancel", _onUp, PASSIVE);
return {
chain: chain,
solve: _solve,
destroy: function () {
el.removeEventListener("pointerdown", _onDown);
el.removeEventListener("pointermove", _onMove);
el.removeEventListener("pointerup", _onUp);
el.removeEventListener("pointercancel", _onUp);
_releaseCapture(el, pointerId);
pointerId = null;
}
};
}
// ============================================================================
// 5. ORBITAL DRAG — pointer advances Kepler mean anomaly of 1M+ bodies
// CORRECTION: wrap uses `glMatrix.mod` so negative drags stay in [0, 2π);
// pointer capture released; chunked write helper exposed for 1M+ bodies.
// ============================================================================
function attachOrbitalDrag(target, elements, options) {
options = options || {};
var el = typeof target === "string"
? (typeof document !== "undefined" ? document.querySelector(target) : null)
: target;
if (!el) return null;
var gain = options.gain !== undefined ? options.gain : 0.01;
var wrap = options.wrap !== false;
var TAU = Math.PI * 2;
var M = elements.M;
var n = M.length;
var lastX = 0;
var active = false;
var pointerId = null;
function _writeRange(s, e, dM) {
if (wrap) {
for (var i = s; i < e; i++) M[i] = glMatrix.mod(M[i] + dM, TAU);
} else {
for (var j = s; j < e; j++) M[j] = M[j] + dM;
}
}
function _applyDelta(dM) { _writeRange(0, n, dM); }
async function _applyDeltaChunked(dM, chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
_writeRange(start, Math.min(start + chunkSize, n), dM);
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
}
function _onDown(e) {
active = true;
lastX = e.clientX;
pointerId = e.pointerId;
if (el.setPointerCapture && pointerId !== undefined) {
try { el.setPointerCapture(pointerId); } catch (err) { /* swallow */ }
}
}
function _onMove(e) {
if (!active) return;
var dx = e.clientX - lastX;
lastX = e.clientX;
_applyDelta(dx * gain);
}
function _onUp(e) {
active = false;
_releaseCapture(el, e && e.pointerId);
pointerId = null;
}
el.style.touchAction = "none";
el.addEventListener("pointerdown", _onDown);
el.addEventListener("pointermove", _onMove, PASSIVE);
el.addEventListener("pointerup", _onUp, PASSIVE);
el.addEventListener("pointercancel", _onUp, PASSIVE);
return {
count: n,
applyDelta: _applyDelta,
applyDeltaChunked: _applyDeltaChunked,
destroy: function () {
el.removeEventListener("pointerdown", _onDown);
el.removeEventListener("pointermove", _onMove);
el.removeEventListener("pointerup", _onUp);
el.removeEventListener("pointercancel", _onUp);
_releaseCapture(el, pointerId);
pointerId = null;
}
};
}
// ============================================================================
// 6. SOA SNAP GRID — snap per-row to a 3D grid on drag release
// CORRECTION: the original returned `snapAll` but never wired it to the
// drag handle, so it never ran. It now registers a drag-end hook and
// exposes a chunked variant plus teardown.
// ============================================================================
function attachSOASnapGrid(handle, trs, grid) {
if (!handle || typeof handle.addDragEndHook !== "function") return null;
grid = grid || 1;
var invGrid = 1 / grid;
var px = trs.position.x, py = trs.position.y, pz = trs.position.z;
var n = trs.position.count;
function _snapRange(s, e) {
for (var i = s; i < e; i++) {
px[i] = Math.round(px[i] * invGrid) * grid;
py[i] = Math.round(py[i] * invGrid) * grid;
pz[i] = Math.round(pz[i] * invGrid) * grid;
}
}
function snapAll() { _snapRange(0, n); }
async function snapAllChunked(chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
_snapRange(start, Math.min(start + chunkSize, n));
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
}
handle.addDragEndHook(snapAll);
return {
snapAll: snapAll,
snapAllChunked: snapAllChunked,
destroy: function () {
// Hooks are cleared by handle.destroy(); nothing else to detach.
}
};
}
// ============================================================================
// 7. HDR TRAIL — accumulates an emissive color trail along the drag path
// CORRECTION: color deltas hoisted out of the loops; chunked write/decay
// added for 1M+ rows; passive listeners; complete teardown.
// ============================================================================
function attachHDRTrail(target, trail, options) {
options = options || {};
var el = typeof target === "string"
? (typeof document !== "undefined" ? document.querySelector(target) : null)
: target;
if (!el) return null;
var baseColor = options.baseColor || [1.0, 0.8, 0.4, 1.0];
var glow = options.glow !== undefined ? options.glow : 4.0;
var decay = options.decay !== undefined ? options.decay : 0.9;
var n = trail.count;
var cr = trail.x, cg = trail.y, cb = trail.z, ca = trail.w;
var wr = baseColor[0] * glow;
var wg = baseColor[1] * glow;
var wb = baseColor[2] * glow;
var wa = baseColor[3];
var active = false;
var pointerId = null;
function _writeRange(s, e) {
for (var i = s; i < e; i++) {
cr[i] = wr; cg[i] = wg; cb[i] = wb; ca[i] = wa;
}
}
function _decayRange(s, e) {
for (var i = s; i < e; i++) {
cr[i] *= decay; cg[i] *= decay; cb[i] *= decay;
}
}
function _write() { _writeRange(0, n); }
function _decay() { _decayRange(0, n); }
async function writeChunked(chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
_writeRange(start, Math.min(start + chunkSize, n));
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
}
async function decayChunked(chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
_decayRange(start, Math.min(start + chunkSize, n));
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
}
function _onDown(e) {
active = true;
pointerId = e.pointerId;
if (el.setPointerCapture && pointerId !== undefined) {
try { el.setPointerCapture(pointerId); } catch (err) { /* swallow */ }
}
_write();
}
function _onMove() { if (active) _write(); }
function _onUp(e) {
active = false;
_releaseCapture(el, e && e.pointerId);
pointerId = null;
_decay();
}
el.style.touchAction = "none";
el.addEventListener("pointerdown", _onDown);
el.addEventListener("pointermove", _onMove, PASSIVE);
el.addEventListener("pointerup", _onUp, PASSIVE);
el.addEventListener("pointercancel", _onUp, PASSIVE);
return {
count: n,
write: _write,
decay: _decay,
writeChunked: writeChunked,
decayChunked: decayChunked,
destroy: function () {
el.removeEventListener("pointerdown", _onDown);
el.removeEventListener("pointermove", _onMove);
el.removeEventListener("pointerup", _onUp);
el.removeEventListener("pointercancel", _onUp);
_releaseCapture(el, pointerId);
pointerId = null;
}
};
}
// ============================================================================
// 8. BITECS DRAG — drag a query selection via a shared offset
// CORRECTION: the unused `list` allocation was removed; the entity count is
// now surfaced on the handle for callers that need it.
// ============================================================================
function attachECSDrag(target, trs, entities, options) {
var handle = attachSOADraggable(target, trs, options);
if (!handle) return null;
var list = entities && (entities.dense || entities);
return {
count: list ? list.length : handle.count,
apply: handle.apply,
applyChunked: handle.applyChunked,
addDragEndHook: handle.addDragEndHook,
get dragging() { return handle.dragging; },
destroy: handle.destroy
};
}
// ============================================================================
// 9. EXPORTS
// ============================================================================
exports.draggable = draggable;
exports.acquireDraggable = acquireDraggable;
exports.attachSOADraggable = attachSOADraggable;
exports.attachIKDrag = attachIKDrag;
exports.attachOrbitalDrag = attachOrbitalDrag;
exports.attachSOASnapGrid = attachSOASnapGrid;
exports.attachHDRTrail = attachHDRTrail;
exports.attachECSDrag = attachECSDrag;
// Pool helpers for adapter hot paths (safe: `_init`-aware, never `.call()` on a class)
exports.acquireAnimation = _acquireAnim;
exports.releaseAnimation = _releaseAnim;
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