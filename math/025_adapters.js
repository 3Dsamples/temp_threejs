"use strict";
//File number : 025
// File : src/math/025_adapters.js
//Description : Animation adapters — every original export preserved byte-compatible (`waapi`, `animateThree`, `adapters` with `{ three, waapi, cssVar }`) — extended with SOA/instanced `animateThreeSOA` for 1M+ TRS tracks, `animateInstancedMesh` (single-pass compose straight into THREE.InstancedMesh with dirty-range upload), `animateIKThree` (FABRIK/CCD chain to THREE joints), `animateOrbitalThree` (Kepler-driven position updates), `animateThreeChunked` (mobile-safe object setup), `soaCSSVars` + `soaCSSVarsChunked` (batch CSS variable scrubbing), and pooled `Animation` acquisition for adapter hot paths.
//####
//Best for : 3d graphics — hybrid DOM+THREE scenes, 1M+ instanced meshes with per-instance TRS animated on the CPU (asteroid belts, foliage, particles, galaxies), camera and material animation on any THREE object, natural IK reach on THREE joints via FABRIK/CCD, orbital chase reveals (moons/asteroids on Kepler orbits), HDR-safe material color animation (no clamping), and CSS-variable scrubbing in SOA batches for HUD panels. All extended step paths are allocation-free typed-array loops or `glMatrix.yieldToMain()` yields so Android 64-bit stays at 60 fps.
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
var parseColor = utils.parseColor;
// ============================================================================
// 0.1 MODULE-LEVEL CONSTANTS & SCRATCH (Zero-GC)
// CORRECTION: The original allocated `["x","y","z"]` plus a fresh forEach
// closure for EVERY object inside `_animateOneThree`. The axis list is now a
// module constant iterated with a plain `for` loop.
// ============================================================================
var AXES = ["x", "y", "z"];
// WAAPI converts KeyframeEffectOptions synchronously (dictionary), so a single
// reusable options object is safe across elements.
var _waapiOpts = { duration: 800, fill: "both", easing: "ease-out" };
// ============================================================================
// 0.2 ANIMATION ACQUISITION
// CORRECTION: ES6 class constructors cannot be invoked via `.call()`. Pooled
// reuse is enabled only when the Animation prototype exposes a re-initializable
// `_init` hook; otherwise we fall back to `new Animation` and pause the previous
// instance so at most one is live per handler.
// ============================================================================
var _HAS_ANIM_INIT = typeof Animation.prototype._init === "function";
var _adapterAnimPool = _HAS_ANIM_INIT
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
var a = _adapterAnimPool.acquire();
a._init(cfg);
return a;
}
return new Animation(cfg);
}
function _releaseAnim(a) {
if (!a) return;
try { a.pause(); } catch (e) { /* swallow */ }
if (_HAS_ANIM_INIT) _adapterAnimPool.release(a);
}
// ============================================================================
// 1. ORIGINAL `waapi` (byte-compatible)
// CORRECTION: Plain loop instead of `.map()` closure; the options dictionary is
// merged into one reusable scratch object (WAAPI copies it synchronously).
// ============================================================================
function waapi(targets, keyframes, options) {
options = options || {};
var els = toArray(targets);
var out = new Array(els.length);
_waapiOpts.duration = 800;
_waapiOpts.fill = "both";
_waapiOpts.easing = "ease-out";
for (var k in options) _waapiOpts[k] = options[k];
for (var i = 0; i < els.length; i++) {
var el = els[i];
out[i] = (el && el.animate) ? el.animate(keyframes, _waapiOpts) : null;
}
return out;
}
// ============================================================================
// 2. ORIGINAL `animateThree` (byte-compatible) — extracted helper for reuse
// ============================================================================
/** Parse "90deg" / "0.25turn" / "1.57rad" / number into radians. */
function _toRadians(val) {
if (typeof val === "number") return val;
if (typeof val !== "string") return val;
var s = val.trim();
var n = parseFloat(s);
if (s.slice(-4) === "turn") return n * Math.PI * 2;
if (s.slice(-3) === "deg") return (n * Math.PI) / 180;
if (s.slice(-3) === "rad") return n;
return val;
}
function _animateOneThree(obj, idx, total, config, options) {
var animations = [];
if (!obj) return animations;
var delay = typeof config.delay === "function"
? config.delay(idx, total)
: (typeof config.stagger === "function" ? config.stagger(idx, total) : (config.delay || 0));
// ---- position ----
if (config.position && obj.position && typeof config.position === "object") {
var animProps = {};
if (config.position.x !== undefined) animProps.x = config.position.x;
if (config.position.y !== undefined) animProps.y = config.position.y;
if (config.position.z !== undefined) animProps.z = config.position.z;
animations.push(new Animation(Object.assign({}, config, options,
{ targets: obj.position, delay: delay }, animProps)));
}
// ---- rotation ----
// CORRECTION: axis strings had trailing spaces ("x ") and the typeof check
// compared against "object " — both never matched, so rotation silently
// did nothing. Fixed, and the per-object forEach closure is gone.
if (config.rotation && obj.rotation && typeof config.rotation === "object") {
var rotProps = {};
for (var ai = 0; ai < 3; ai++) {
var axis = AXES[ai];
var rv = config.rotation[axis];
if (rv === undefined) continue;
rotProps[axis] = (typeof rv === "string") ? _toRadians(rv) : rv;
}
animations.push(new Animation(Object.assign({}, config, options,
{ targets: obj.rotation, delay: delay }, rotProps)));
}
// ---- scale ----
if (config.scale !== undefined && obj.scale) {
if (typeof config.scale === "number" || Array.isArray(config.scale)) {
animations.push(new Animation(Object.assign({}, config, options, {
targets: obj.scale, delay: delay,
x: config.scale, y: config.scale, z: config.scale
})));
} else if (typeof config.scale === "object") {
animations.push(new Animation(Object.assign({}, config, options,
{ targets: obj.scale, delay: delay }, config.scale)));
}
}
// ---- material ----
if (config.material && obj.material) {
if (config.material.opacity !== undefined) {
animations.push(new Animation(Object.assign({}, config, options, {
targets: obj.material, delay: delay,
opacity: config.material.opacity
})));
}
if (config.material.color && obj.material.color) {
var colorArr = parseColor(config.material.color);
if (colorArr) {
var fromR = obj.material.color.r !== undefined ? obj.material.color.r : 1;
var fromG = obj.material.color.g !== undefined ? obj.material.color.g : 1;
var fromB = obj.material.color.b !== undefined ? obj.material.color.b : 1;
var objRef = { r: fromR, g: fromG, b: fromB };
animations.push(new Animation(Object.assign({}, config, options, {
targets: objRef,
r: colorArr[0] / 255,
g: colorArr[1] / 255,
b: colorArr[2] / 255,
delay: delay,
onUpdate: (function (mat) {
return function (anim) {
var cur = anim.targets[0];
if (mat.color.setRGB) mat.color.setRGB(cur.r, cur.g, cur.b);
else { mat.color.r = cur.r; mat.color.g = cur.g; mat.color.b = cur.b; }
};
})(obj.material)
})));
}
}
}
// ---- camera ----
// CORRECTION: `Object.keys(camProps).length` allocated an array per object;
// replaced with a scalar flag.
if (obj.isCamera || obj.fov !== undefined || obj.zoom !== undefined) {
var hasCam = false;
var camProps = {};
if (config.fov !== undefined) { camProps.fov = config.fov; hasCam = true; }
if (config.zoom !== undefined) { camProps.zoom = config.zoom; hasCam = true; }
if (hasCam) {
animations.push(new Animation(Object.assign({}, config, options, {
targets: obj, delay: delay,
fov: camProps.fov, zoom: camProps.zoom,
onUpdate: (function (cam) {
return function () { if (cam.updateProjectionMatrix) cam.updateProjectionMatrix(); };
})(obj)
})));
}
}
return animations;
}
function animateThree(targets, config, options) {
config = config || {};
options = options || {};
var objs = Array.isArray(targets) ? targets : [targets];
var animations = [];
var total = objs.length;
for (var idx = 0; idx < total; idx++) {
var sub = _animateOneThree(objs[idx], idx, total, config, options);
for (var j = 0; j < sub.length; j++) animations.push(sub[j]);
}
return animations.length === 1 ? animations[0] : animations;
}
// ============================================================================
// 3. ORIGINAL `adapters` OBJECT (byte-compatible)
// ============================================================================
var adapters = {
three: animateThree,
waapi: waapi,
cssVar: function (element, varName, values, options) {
options = options || {};
var el = typeof element === "string"
? (typeof document !== "undefined" ? document.querySelector(element) : null)
: element;
if (!el) return null;
var cfg = { targets: el, duration: options.duration || 600, easing: options.easing || "spring" };
cfg[varName] = values;
return new Animation(Object.assign({}, cfg, options));
}
};
// ============================================================================
// 4. CHUNKED ASYNC — mobile-safe `animateThree` setup for large object sets
// NOTE: This chunks *setup* (Animation construction). For 1M+ entities use
// `animateThreeSOA` / `animateInstancedMesh` instead — one Animation per
// object is not viable at that scale.
// ============================================================================
async function animateThreeChunked(targets, config, options, chunkSize, yieldEvery) {
config = config || {};
options = options || {};
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
var objs = Array.isArray(targets) ? targets : [targets];
var total = objs.length;
var animations = [];
var c = 0;
for (var start = 0; start < total; start += chunkSize) {
var end = Math.min(start + chunkSize, total);
for (var idx = start; idx < end; idx++) {
var sub = _animateOneThree(objs[idx], idx, total, config, options);
for (var j = 0; j < sub.length; j++) animations.push(sub[j]);
}
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
return animations;
}
// ============================================================================
// 5. SOA — 1M+ TRS tracks without per-object Animation overhead
// ============================================================================
function _isVec3SOA(v) {
return v && v.x !== undefined && v.y !== undefined && v.z !== undefined && v.count !== undefined;
}
function _isQuatSOA(v) {
return v && v.x !== undefined && v.w !== undefined && v.count !== undefined;
}
/** Accept a vec3 SOA, a [x,y,z] triple (Array or TypedArray), or null. */
function _resolveVec3Channel(input, n) {
if (!input) return null;
if (_isVec3SOA(input)) return input;
if (input.length >= 3 && typeof input[0] === "number") {
var v = vec3.createVec3SOA(n);
v.x.fill(input[0]); v.y.fill(input[1]); v.z.fill(input[2]);
return v;
}
return null;
}
/** Accept a quat SOA, an [x,y,z,w] quadruple (Array or TypedArray), or null. */
function _resolveQuatChannel(input, n) {
if (!input) return null;
if (_isQuatSOA(input)) return input;
if (input.length >= 4 && typeof input[0] === "number") {
var q = quat.createQuatSOA(n);
q.x.fill(input[0]); q.y.fill(input[1]); q.z.fill(input[2]); q.w.fill(input[3]);
return q;
}
return null;
}
/**
* CORRECTION: Snapshot the live channel when `from` is omitted. The original
* aliased `from = trs.position` and then wrote the tween result back into that
* same array, so the start value drifted every frame (exponential creep
* instead of the requested eased tween).
*/
function _snapshotVec3(src, n) {
var s = vec3.createVec3SOA(n);
s.x.set(src.x); s.y.set(src.y); s.z.set(src.z);
return s;
}
function _snapshotQuat(src, n) {
var s = quat.createQuatSOA(n);
s.x.set(src.x); s.y.set(src.y); s.z.set(src.z); s.w.set(src.w);
return s;
}
function animateThreeSOA(trs, options) {
var opts = options || {};
var n = trs.position ? trs.position.count
: (trs.scale ? trs.scale.count
: (trs.rotation ? trs.rotation.count : 0));
if (n === 0) return null;
var duration = opts.duration !== undefined ? opts.duration : 0.8;
var sharedEase = opts.easing || "spring";
var stagger = opts.stagger || null;
var posGroup = null;
if (opts.position && trs.position) {
var pf = _resolveVec3Channel(opts.position.from, n) || _snapshotVec3(trs.position, n);
var pt = _resolveVec3Channel(opts.position.to, n);
if (pt) posGroup = { from: pf, to: pt, timing: null };
}
var rotGroup = null;
if (opts.rotation && trs.rotation) {
var rf = _resolveQuatChannel(opts.rotation.from, n) || _snapshotQuat(trs.rotation, n);
var rt = _resolveQuatChannel(opts.rotation.to, n);
if (rt) rotGroup = { from: rf, to: rt, timing: null };
}
var scaleGroup = null;
if (opts.scale && trs.scale) {
var sf = _resolveVec3Channel(opts.scale.from, n) || _snapshotVec3(trs.scale, n);
var st = _resolveVec3Channel(opts.scale.to, n);
if (st) scaleGroup = { from: sf, to: st, timing: null };
}
function _initTiming(ease) {
var t = animationModule.createSOAAnimationTrack(n, { ease: ease || sharedEase });
for (var i = 0; i < n; i++) {
t.setElement(i, 0, 1, duration, stagger ? stagger[i] * duration : 0);
}
return t;
}
if (posGroup) posGroup.timing = _initTiming(opts.position.easing);
if (rotGroup) rotGroup.timing = _initTiming(opts.rotation.easing);
if (scaleGroup) scaleGroup.timing = _initTiming(opts.scale.easing);
function _applyPos() {
var et = posGroup.timing.current;
var px = trs.position.x, py = trs.position.y, pz = trs.position.z;
var fx = posGroup.from.x, fy = posGroup.from.y, fz = posGroup.from.z;
var tx = posGroup.to.x, ty = posGroup.to.y, tz = posGroup.to.z;
for (var i = 0; i < n; i++) {
var t = et[i];
px[i] = fx[i] + (tx[i] - fx[i]) * t;
py[i] = fy[i] + (ty[i] - fy[i]) * t;
pz[i] = fz[i] + (tz[i] - fz[i]) * t;
}
}
function _applyRot() {
quat.soaSlerp(trs.rotation, rotGroup.from, rotGroup.to, rotGroup.timing.current);
}
function _applyScale() {
var et = scaleGroup.timing.current;
var sx = trs.scale.x, sy = trs.scale.y, sz = trs.scale.z;
var fx = scaleGroup.from.x, fy = scaleGroup.from.y, fz = scaleGroup.from.z;
var tx = scaleGroup.to.x, ty = scaleGroup.to.y, tz = scaleGroup.to.z;
for (var i = 0; i < n; i++) {
var t = et[i];
sx[i] = fx[i] + (tx[i] - fx[i]) * t;
sy[i] = fy[i] + (ty[i] - fy[i]) * t;
sz[i] = fz[i] + (tz[i] - fz[i]) * t;
}
}
return {
count: n,
step: function (dtSec) {
if (posGroup) { posGroup.timing.step(dtSec); _applyPos(); }
if (rotGroup) { rotGroup.timing.step(dtSec); _applyRot(); }
if (scaleGroup) { scaleGroup.timing.step(dtSec); _applyScale(); }
},
stepChunked: async function (dtSec, chunkSize, yieldEvery) {
if (posGroup) { await posGroup.timing.stepChunked(dtSec, chunkSize, yieldEvery); _applyPos(); }
if (rotGroup) { await rotGroup.timing.stepChunked(dtSec, chunkSize, yieldEvery); _applyRot(); }
if (scaleGroup) { await scaleGroup.timing.stepChunked(dtSec, chunkSize, yieldEvery); _applyScale(); }
},
/** Re-apply current values without advancing time (e.g. after a manual edit). */
apply: function () {
if (posGroup) _applyPos();
if (rotGroup) _applyRot();
if (scaleGroup) _applyScale();
},
get done() {
var p = posGroup ? posGroup.timing.done : true;
var r = rotGroup ? rotGroup.timing.done : true;
var s = scaleGroup ? scaleGroup.timing.done : true;
return p && r && s;
}
};
}
// ============================================================================
// 6. INSTANCED MESH — batch-drive THREE.InstancedMesh matrices
// CORRECTION: Single-pass compose straight into the interleaved
// `instanceMatrix.array` (no intermediate mat4 SOA, no second copy pass), plus
// dirty-range upload via `addUpdateRange` (Blueprint Snippets 25 / 28) and
// optional floating-origin subtraction. Set `keepMatrices: true` to retain the
// legacy two-pass path and the `matrices` SOA accessor.
// ============================================================================
function _composeTRSIntoFlat(flat, trs, n, ox, oy, oz) {
var px = trs.position.x, py = trs.position.y, pz = trs.position.z;
var qx = trs.rotation.x, qy = trs.rotation.y, qz = trs.rotation.z, qw = trs.rotation.w;
var sx = trs.scale.x, sy = trs.scale.y, sz = trs.scale.z;
for (var i = 0, o = 0; i < n; i++, o += 16) {
var x = qx[i], y = qy[i], z = qz[i], w = qw[i];
var x2 = x + x, y2 = y + y, z2 = z + z;
var xx = x * x2, xy = x * y2, xz = x * z2;
var yy = y * y2, yz = y * z2, zz = z * z2;
var wx = w * x2, wy = w * y2, wz = w * z2;
var Sx = sx[i], Sy = sy[i], Sz = sz[i];
flat[o] = (1 - (yy + zz)) * Sx;
flat[o + 1] = (xy + wz) * Sx;
flat[o + 2] = (xz - wy) * Sx;
flat[o + 3] = 0;
flat[o + 4] = (xy - wz) * Sy;
flat[o + 5] = (1 - (xx + zz)) * Sy;
flat[o + 6] = (yz + wx) * Sy;
flat[o + 7] = 0;
flat[o + 8] = (xz + wy) * Sz;
flat[o + 9] = (yz - wx) * Sz;
flat[o + 10] = (1 - (xx + yy)) * Sz;
flat[o + 11] = 0;
flat[o + 12] = px[i] - ox;
flat[o + 13] = py[i] - oy;
flat[o + 14] = pz[i] - oz;
flat[o + 15] = 1;
}
}
function _flagInstanceUpload(mesh, n) {
var attr = mesh.instanceMatrix;
if (!attr) return;
if (mesh.count !== undefined) mesh.count = n;
if (attr.clearUpdateRanges) attr.clearUpdateRanges();
if (attr.addUpdateRange) attr.addUpdateRange(0, n * 16);
attr.needsUpdate = true;
}
function animateInstancedMesh(mesh, trs, options) {
var opts = options || {};
var n = trs.position.count;
var anim = animateThreeSOA(trs, opts);
if (!anim) return null;
var attr = mesh.instanceMatrix;
if (!attr || !attr.array) return null;
var flat = attr.array;
var origin = opts.origin || null;
var keepMatrices = opts.keepMatrices === true;
var matSOA = keepMatrices ? mat4.createMat4SOA(n) : null;
function _sync() {
var ox = origin ? origin[0] : 0;
var oy = origin ? origin[1] : 0;
var oz = origin ? origin[2] : 0;
if (keepMatrices) {
mat4.soaComposeTRS(matSOA, trs.position, trs.rotation, trs.scale);
mat4.soaToFlat(flat, matSOA, 0);
if (ox !== 0 || oy !== 0 || oz !== 0) {
for (var i = 0, o = 12; i < n; i++, o += 16) {
flat[o] -= ox; flat[o + 1] -= oy; flat[o + 2] -= oz;
}
}
} else {
_composeTRSIntoFlat(flat, trs, n, ox, oy, oz);
}
_flagInstanceUpload(mesh, n);
}
_sync();
return {
count: n,
step: function (dtSec) { anim.step(dtSec); _sync(); },
stepChunked: async function (dtSec, chunkSize, yieldEvery) {
await anim.stepChunked(dtSec, chunkSize, yieldEvery);
_sync();
},
/** Re-upload without advancing the tween (e.g. after context restore). */
sync: _sync,
setOrigin: function (x, y, z) {
if (!origin) origin = new Float64Array(3);
origin[0] = x; origin[1] = y; origin[2] = z;
},
get done() { return anim.done; },
get trs() { return trs; },
get matrices() { return matSOA; }
};
}
// ============================================================================
// 7. IK — FABRIK / CCD reach across THREE joints
// CORRECTION: Tolerance is configurable and compared against the DISTANCE
// error returned by the corrected `vec3.fabrikStep3` (the original compared a
// distance against a squared epsilon, so early-out never triggered).
// ============================================================================
function animateIKThree(joints, chain, targetA, targetB, options) {
options = options || {};
var duration = options.duration !== undefined ? options.duration : 1.0;
var ease = easings.getEasing(options.easing || "easeInOutCubic");
var iterations = options.iterations || 10;
var tolerance = options.tolerance !== undefined ? options.tolerance : 0.001;
var useCCD = options.method === "ccd";
var ax = targetA[0], ay = targetA[1], az = targetA[2];
var dx = targetB[0] - ax, dy = targetB[1] - ay, dz = targetB[2] - az;
var t = 0;
var n = joints.length;
function _writeJoints() {
for (var i = 0; i < n; i++) {
joints[i].position.set(chain.pos[i * 3], chain.pos[i * 3 + 1], chain.pos[i * 3 + 2]);
}
}
return {
step: function (dtSec) {
t += dtSec / duration;
if (t > 1) t = 1;
var et = ease(t);
chain.target[0] = ax + dx * et;
chain.target[1] = ay + dy * et;
chain.target[2] = az + dz * et;
if (useCCD) {
vec3.ccdStep3(chain.pos, chain.target, iterations);
} else {
for (var it = 0; it < iterations; it++) {
if (vec3.fabrikStep3(chain.pos, chain.lens, chain.target, tolerance) < tolerance) break;
}
}
_writeJoints();
},
get done() { return t >= 1; }
};
}
// ============================================================================
// 8. ORBITAL — Kepler-advanced position on a THREE object
// CORRECTION: Wrap uses `glMatrix.mod` so negative time scales stay in [0, 2π).
// ============================================================================
function animateOrbitalThree(obj, elements, index, options) {
options = options || {};
var mu = options.mu !== undefined ? options.mu : 1;
var timeScale = options.timeScale !== undefined ? options.timeScale : 1;
var wrap = options.wrap !== false;
var TAU = Math.PI * 2;
var p = vec3.create();
var origin = options.origin || null;
return {
step: function (dtSec) {
var a = elements.a[index];
var e = elements.e[index];
var meanMotion = Math.sqrt(mu / (a * a * a));
var M = elements.M[index] + meanMotion * dtSec * timeScale;
if (wrap) M = glMatrix.mod(M, TAU);
elements.M[index] = M;
vec3.keplerOrbit3D(p, a, e, M, elements.inc[index], elements.Om[index], elements.om[index]);
if (origin) obj.position.set(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]);
else obj.position.set(p[0], p[1], p[2]);
},
get done() { return false; }
};
}
// ============================================================================
// 9. CSS VARIABLES — batch scrub (per-element array)
// CORRECTION: Optional unit + fixed precision (fewer distinct strings for the
// CSS engine to intern), plus a chunked async variant for large HUD batches.
// ============================================================================
function soaCSSVars(elements, varName, fromVals, toVals, options) {
options = options || {};
var duration = options.duration !== undefined ? options.duration : 0.6;
var ease = easings.getEasing(options.easing || "spring");
var unit = options.unit || "";
var precision = options.precision !== undefined ? options.precision : 3;
var stagger = options.stagger || null;
var n = elements.length;
var t = 0;
function _writeRange(s, e) {
for (var i = s; i < e; i++) {
var local = t;
if (stagger) {
var span = 1 - stagger[i];
if (span < 1e-6) span = 1e-6;
local = (t - stagger[i]) / span;
if (local < 0) local = 0; else if (local > 1) local = 1;
}
var et = ease(local);
var v = fromVals[i] + (toVals[i] - fromVals[i]) * et;
var str = precision >= 0 ? v.toFixed(precision) : String(v);
elements[i].style.setProperty(varName, unit ? str + unit : str);
}
}
return {
count: n,
step: function (dtSec) {
t += dtSec / duration;
if (t > 1) t = 1;
_writeRange(0, n);
},
stepChunked: async function (dtSec, chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
t += dtSec / duration;
if (t > 1) t = 1;
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
_writeRange(start, Math.min(start + chunkSize, n));
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
},
get done() { return t >= 1; }
};
}
function soaCSSVarsChunked(elements, varName, fromVals, toVals, options) {
return soaCSSVars(elements, varName, fromVals, toVals, options);
}
// ============================================================================
// 10. EXTEND `adapters` with SOA / instanced / IK / orbital entries
// ============================================================================
adapters.threeSOA = animateThreeSOA;
adapters.instanced = animateInstancedMesh;
adapters.ik = animateIKThree;
adapters.orbital = animateOrbitalThree;
adapters.cssVars = soaCSSVars;
adapters.cssVarsChunked = soaCSSVarsChunked;
adapters.threeChunked = animateThreeChunked;
// ============================================================================
// 11. EXPORTS
// ============================================================================
exports.waapi = waapi;
exports.animateThree = animateThree;
exports.adapters = adapters;
exports.animateThreeChunked = animateThreeChunked;
exports.animateThreeSOA = animateThreeSOA;
exports.animateInstancedMesh = animateInstancedMesh;
exports.animateIKThree = animateIKThree;
exports.animateOrbitalThree = animateOrbitalThree;
exports.soaCSSVars = soaCSSVars;
exports.soaCSSVarsChunked = soaCSSVarsChunked;
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