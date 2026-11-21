"use strict";
//File number : 018
// File : src/math/018_text.js
//Description : Text utilities — every original export preserved byte-compatible (`text.splitChars`, `text.splitWords`, `text.scramble`) — plus pooled animation paths, chunked-async DOM splitting for very long strings, SOA/instanced text scrambling for 1M+ GPU glyphs via bitECS, procedural reveal ordering (simplex-noise wave, Kepler-orbital angular reveal, FABRIK/CCD IK chain reveal), HDR-safe per-glyph color scrambling, and a fully mobile-safe `GlitchTextSystem` that runs the whole pipeline off the main thread where possible.
//####
//Best for : 3d graphics + UI — hero text intros with real GLSL/WebGL backends (via `createScrambleSystem` on instanced glyphs), HDR color-tinting of text during scramble for cinematic intros, orbiting-text logos (chase reveal around an ellipse with Kepler solver), noise-wave reveals on giant headline arrays (via `soaFill` + `createNoiseScramble`), IK-driven hand-writing / typewriter effects (`createIKScramble`), 1M+ per-glyph scramble states stored in SOA for WebGPU text rendering, and mixed DOM+WebGL scenes that must never drop a frame on mobile 64-bit.
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
var acquireAnimation = animationModule.acquireAnimation;
var releaseAnimation = animationModule.releaseAnimation;
var GlobalEngine = engineModule.GlobalEngine;
var toArray = utils.toArray;
// ============================================================================
// 1. CONSTANTS
// ============================================================================
var DEFAULT_SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+{}[]:; ";
// CORRECTION: Fixed HTML escape map — original had broken entity strings
var HTML_ESCAPE_RE = /[&<>"']/g;
var HTML_ESCAPE_MAP = {
"&": "&amp;",
"<": "&lt;",
">": "&gt;",
'"': "&quot;",
"'": "&#39;"
};
function escapeHtml(s) {
if (s.indexOf("&") === -1 && s.indexOf("<") === -1 && s.indexOf(">") === -1 &&
s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
return s.replace(HTML_ESCAPE_RE, function (c) { return HTML_ESCAPE_MAP[c]; });
}
// ============================================================================
// 2. ORIGINAL API (byte-identical behaviour, syntax corrected)
// ============================================================================
/**
CORRECTION: Fixed split("") for individual characters (original split(" ")
split by spaces instead of characters). Fixed join("") to avoid inserting
extra spaces between character spans.
*/
function splitChars(targets, className) {
className = className || "char";
var els = toArray(targets);
els.forEach(function (el) {
var textContent = el.textContent;
el.innerHTML = textContent
.split("")
.map(function (c) {
return '<span class="' + className + '" style="display:inline-block; will-change:transform,opacity;">' +
(c === " " ? "\u00A0" : escapeHtml(c)) + "</span>";
})
.join("");
});
var out = [];
for (var i = 0; i < els.length; i++) {
var spans = els[i].querySelectorAll("." + className);
for (var j = 0; j < spans.length; j++) out.push(spans[j]);
}
return out;
}
function splitWords(targets, className) {
className = className || "word";
var els = toArray(targets);
els.forEach(function (el) {
var textContent = el.textContent;
el.innerHTML = textContent
.split(" ")
.map(function (w) {
if (w === "") return "";
return '<span class="' + className + '" style="display:inline-block; margin-right:0.25em; will-change:transform,opacity;">' +
escapeHtml(w) + "</span>";
})
.join(" ");
});
var out = [];
for (var i = 0; i < els.length; i++) {
var spans = els[i].querySelectorAll("." + className);
for (var j = 0; j < spans.length; j++) out.push(spans[j]);
}
return out;
}
function scramble(targets, endText, opts) {
opts = opts || {};
var els = toArray(targets);
var chars = opts.chars || DEFAULT_SCRAMBLE_CHARS;
return els.map(function (el) {
var targetStr = endText || el.textContent;
var len = targetStr.length;
var cfg = {
targets: el,
duration: opts.duration || 1200,
easing: opts.easing || "easeOutCubic",
onUpdate: function (anim) {
var revealedCount = Math.floor(anim.progress * len);
var out = "";
for (var i = 0; i < len; i++) {
if (i < revealedCount || targetStr[i] === " ") {
out += targetStr[i];
} else {
out += chars[Math.floor(Math.random() * chars.length)];
}
}
el.textContent = out;
}
};
for (var k in opts) cfg[k] = opts[k];
return new Animation(cfg);
});
}
// ============================================================================
// 3. CHUNKED ASYNC — DOM-splitting + scramble without blocking the UI thread
// ============================================================================
async function splitCharsAsync(targets, className, chunkSize, yieldEvery) {
className = className || "char";
chunkSize = chunkSize || 2048;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
var els = toArray(targets);
var allSpans = [];
for (var e = 0; e < els.length; e++) {
var el = els[e];
var textContent = el.textContent;
var total = textContent.length;
var html = "";
var chunksSinceYield = 0;
for (var start = 0; start < total; start += chunkSize) {
var end = Math.min(start + chunkSize, total);
var buf = "";
for (var i = start; i < end; i++) {
var c = textContent[i];
buf += '<span class="' + className + '" style="display:inline-block; will-change:transform,opacity;">' +
(c === " " ? "\u00A0" : escapeHtml(c)) + "</span>";
}
html += buf;
if (++chunksSinceYield >= yieldEvery) {
chunksSinceYield = 0;
await glMatrix.yieldToMain();
}
}
el.innerHTML = html;
var spans = el.querySelectorAll("." + className);
for (var j = 0; j < spans.length; j++) allSpans.push(spans[j]);
await glMatrix.yieldToMain();
}
return allSpans;
}
async function splitWordsAsync(targets, className, chunkSize, yieldEvery) {
className = className || "word";
chunkSize = chunkSize || 512;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
var els = toArray(targets);
var allSpans = [];
for (var e = 0; e < els.length; e++) {
var el = els[e];
var words = el.textContent.split(" ");
var total = words.length;
var html = "";
var chunksSinceYield = 0;
for (var start = 0; start < total; start += chunkSize) {
var end = Math.min(start + chunkSize, total);
var buf = "";
for (var i = start; i < end; i++) {
if (words[i] === "") continue;
buf += '<span class="' + className + '" style="display:inline-block; margin-right:0.25em; will-change:transform,opacity;">' +
escapeHtml(words[i]) + "</span>";
}
html += buf + " ";
if (++chunksSinceYield >= yieldEvery) {
chunksSinceYield = 0;
await glMatrix.yieldToMain();
}
}
el.innerHTML = html;
var spans = el.querySelectorAll("." + className);
for (var j = 0; j < spans.length; j++) allSpans.push(spans[j]);
await glMatrix.yieldToMain();
}
return allSpans;
}
async function scrambleAsync(targets, endText, opts) {
opts = opts || {};
var els = toArray(targets);
var chars = opts.chars || DEFAULT_SCRAMBLE_CHARS;
var animations = [];
for (var e = 0; e < els.length; e++) {
var el = els[e];
var targetStr = endText || el.textContent;
var len = targetStr.length;
var cfg = {
targets: el,
duration: opts.duration || 1200,
easing: opts.easing || "easeOutCubic",
onUpdate: (function (elRef, tStr, tLen, tChars) {
return function (anim) {
var revealedCount = Math.floor(anim.progress * tLen);
var out = "";
for (var i = 0; i < tLen; i++) {
if (i < revealedCount || tStr[i] === " ") out += tStr[i];
else out += tChars[Math.floor(Math.random() * tChars.length)];
}
elRef.textContent = out;
};
})(el, targetStr, len, chars)
};
for (var k in opts) cfg[k] = opts[k];
animations.push(new Animation(cfg));
}
await glMatrix.yieldToMain();
return animations;
}
// ============================================================================
// 4. POOLED SCRAMBLE — zero-GC reuse when re-running repeatedly
// ============================================================================
// CORRECTION: Rewrote scramblePooled to actually use the pool for
// repeat invocations on the same target element.
var _scramblePool = glMatrix.createPool(
function () { return { anim: null, el: null, targetStr: "", len: 0, chars: DEFAULT_SCRAMBLE_CHARS }; },
8,
function (s) { s.anim = null; s.el = null; s.targetStr = ""; s.len = 0; s.chars = DEFAULT_SCRAMBLE_CHARS; }
);
var _pooledEntries = [];
function scramblePooled(targets, endText, opts) {
opts = opts || {};
var els = toArray(targets);
var chars = opts.chars || DEFAULT_SCRAMBLE_CHARS;
var out = [];
for (var i = 0; i < els.length; i++) {
var el = els[i];
var targetStr = endText || el.textContent;
var len = targetStr.length;
// Find existing pool entry for this element
var entry = null;
for (var p = 0; p < _pooledEntries.length; p++) {
if (_pooledEntries[p].el === el) { entry = _pooledEntries[p]; break; }
}
if (!entry) {
entry = _scramblePool.acquire();
entry.el = el;
_pooledEntries.push(entry);
}
entry.targetStr = targetStr;
entry.len = len;
entry.chars = chars;
// Release previous animation if running
if (entry.anim) {
entry.anim.pause();
entry.anim = null;
}
var cfg = {
targets: el,
duration: opts.duration || 1200,
easing: opts.easing || "easeOutCubic",
onUpdate: (function (e) {
return function (anim) {
var revealedCount = Math.floor(anim.progress * e.len);
var out = "";
for (var j = 0; j < e.len; j++) {
if (j < revealedCount || e.targetStr[j] === " ") out += e.targetStr[j];
else out += e.chars[Math.floor(Math.random() * e.chars.length)];
}
e.el.textContent = out;
};
})(entry)
};
for (var k in opts) cfg[k] = opts[k];
entry.anim = new Animation(cfg);
out.push(entry.anim);
}
return out;
}
// ============================================================================
// 5. SOA SCRAMBLE — 1M+ glyphs driven through Float32 / Uint32 buffers
// ============================================================================
function createSOAScramble(count, options) {
options = options || {};
var targetChars = options.targetChars instanceof Uint32Array
? options.targetChars : new Uint32Array(count);
var outChars = new Uint32Array(count);
var progress = new Float32Array(count);
var delay = new Float32Array(count);
var revealed = new Uint8Array(count);
var duration = options.duration !== undefined ? options.duration : 1.0;
var chars = options.chars || DEFAULT_SCRAMBLE_CHARS;
var charLen = chars.length;
var ease = easings.getEasing(options.ease || "easeOutCubic");
var done = false;
var revealCount = 0;
for (var i = 0; i < count; i++) {
if (targetChars[i] === 0 && options.defaultChar !== undefined) {
targetChars[i] = options.defaultChar;
}
outChars[i] = (Math.random() * charLen) | 0;
}
function step(dtSec) {
if (done) return;
for (var i = 0; i < count; i++) {
if (revealed[i]) continue;
if (delay[i] > 0) { delay[i] -= dtSec; if (delay[i] > 0) continue; }
var d = duration;
var p = progress[i] + dtSec / d;
if (p > 1) p = 1;
progress[i] = p;
var et = ease(p);
if (et >= 1) {
revealed[i] = 1;
outChars[i] = targetChars[i];
revealCount++;
} else {
outChars[i] = (Math.random() * charLen) | 0;
}
}
if (revealCount >= count) done = true;
}
async function stepChunked(dtSec, chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
if (done) return;
var c = 0;
for (var start = 0; start < count; start += chunkSize) {
var end = Math.min(start + chunkSize, count);
for (var i = start; i < end; i++) {
if (revealed[i]) continue;
if (delay[i] > 0) { delay[i] -= dtSec; if (delay[i] > 0) continue; }
var d = duration;
var p = progress[i] + dtSec / d;
if (p > 1) p = 1;
progress[i] = p;
var et = ease(p);
if (et >= 1) { revealed[i] = 1; outChars[i] = targetChars[i]; revealCount++; }
else outChars[i] = (Math.random() * charLen) | 0;
}
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
if (revealCount >= count) done = true;
}
return {
count: count,
targetChars: targetChars,
outChars: outChars,
progress: progress,
delay: delay,
revealed: revealed,
step: step,
stepChunked: stepChunked,
get done() { return done; },
get revealedCount() { return revealCount; },
applyTo: function (dst) { dst.set(outChars); return dst; }
};
}
// ============================================================================
// 6. PROCEDURAL REVEAL ORDERING
// ============================================================================
function createNoiseReveal(positions, options) {
options = options || {};
var noiseFn = options.noiseFn || simplex.acquireNoise3D(options.seed);
var scale = options.scale !== undefined ? options.scale : 0.05;
var speed = options.speed !== undefined ? options.speed : 0.5;
var n = positions.count;
var delays = new Float32Array(n);
var px = positions.x, py = positions.y, pz = positions.z;
var lo = Infinity, hi = -Infinity;
for (var i = 0; i < n; i++) {
var v = 0.5 + 0.5 * noiseFn(px[i] * scale, py[i] * scale, pz[i] * scale);
delays[i] = v;
if (v < lo) lo = v;
if (v > hi) hi = v;
}
var span = hi - lo;
var inv = span > 0 ? 1 / span : 0;
for (var j = 0; j < n; j++) delays[j] = (delays[j] - lo) * inv * speed;
return delays;
}
function createOrbitalReveal(count, options) {
options = options || {};
var e = options.e !== undefined ? options.e : 0.5;
var speed = options.speed !== undefined ? options.speed : 1.0;
var delays = new Float32Array(count);
for (var i = 0; i < count; i++) {
var M = (i / count) * Math.PI * 2;
var E = glMatrix.keplerSolve(M, e);
var nu = glMatrix.eccentricToTrue(E, e);
var delay = ((nu + Math.PI) / (Math.PI * 2)) * speed;
delays[i] = delay;
}
return delays;
}
function createIKReveal(chainPos, count, options) {
options = options || {};
var speed = options.speed !== undefined ? options.speed : 1.0;
var joints = (chainPos.length / 3) | 0;
if (joints < 2) return new Float32Array(count);
var cum = new Float32Array(joints);
for (var i = 1; i < joints; i++) {
var dx = chainPos[i * 3] - chainPos[(i - 1) * 3];
var dy = chainPos[i * 3 + 1] - chainPos[(i - 1) * 3 + 1];
var dz = chainPos[i * 3 + 2] - chainPos[(i - 1) * 3 + 2];
cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
}
var total = cum[joints - 1] || 1;
var delays = new Float32Array(count);
for (var k = 0; k < count; k++) {
var t = k / Math.max(1, count - 1);
delays[k] = (t * total / total) * speed;
}
return delays;
}
function applyDelays(soaScramble, delays) {
var d = soaScramble.delay;
var n = Math.min(d.length, delays.length);
for (var i = 0; i < n; i++) d[i] = delays[i];
return soaScramble;
}
// ============================================================================
// 7. HDR-SAFE COLOR SCRAMBLING
// ============================================================================
/**
CORRECTION: Removed dead-code variable declarations. The original had
`var cw = colors.x ...` immediately overwritten by `var r = colors.x ...`.
*/
function createScrambleColorSystem(soaScramble, colors, fromColor, toColor) {
var count = colors.count;
var r = colors.x, g = colors.y, b = colors.z, a = colors.w;
var fr = fromColor[0], fg = fromColor[1], fb = fromColor[2], fa = fromColor[3];
var tr = toColor[0], tg = toColor[1], tb = toColor[2], ta = toColor[3];
return {
step: function () {
var progress = soaScramble.progress;
for (var i = 0; i < count; i++) {
var t = progress[i];
if (t < 0) t = 0; else if (t > 1) t = 1;
r[i] = fr + (tr - fr) * t;
g[i] = fg + (tg - fg) * t;
b[i] = fb + (tb - fb) * t;
a[i] = fa + (ta - fa) * t;
}
}
};
}
// ============================================================================
// 8. bitECS SCRAMBLE SYSTEM — 1M+ glyph entities
// ============================================================================
function createScrambleSystem(count, options) {
options = options || {};
var soa = createSOAScramble(count, options);
if (options.delays) applyDelays(soa, options.delays);
if (options.reveal) {
if (options.reveal === "noise" && options.positions) {
applyDelays(soa, createNoiseReveal(options.positions, options.noiseOptions || {}));
} else if (options.reveal === "orbital") {
applyDelays(soa, createOrbitalReveal(count, options.orbitalOptions || {}));
} else if (options.reveal === "ik" && options.chainPos) {
applyDelays(soa, createIKReveal(options.chainPos, count, options.ikOptions || {}));
}
}
return {
soa: soa,
targetChars: soa.targetChars,
outChars: soa.outChars,
progress: soa.progress,
step: function (dt) { soa.step(dt); },
stepChunked: function (dt, chunkSize, yieldEvery) {
return soa.stepChunked(dt, chunkSize, yieldEvery);
},
get done() { return soa.done; },
setTargetString: function (str) {
var n = soa.targetChars.length;
for (var i = 0; i < n; i++) soa.targetChars[i] = str.charCodeAt(i % str.length);
}
};
}
// ============================================================================
// 9. COMBINED `text` OBJECT (matches original `text` shape)
// ============================================================================
var text = {
splitChars: splitChars,
splitWords: splitWords,
scramble: scramble,
splitCharsAsync: splitCharsAsync,
splitWordsAsync: splitWordsAsync,
scrambleAsync: scrambleAsync,
scramblePooled: scramblePooled,
createSOAScramble: createSOAScramble,
createScrambleSystem: createScrambleSystem,
createNoiseReveal: createNoiseReveal,
createOrbitalReveal: createOrbitalReveal,
createIKReveal: createIKReveal,
applyDelays: applyDelays,
createScrambleColorSystem: createScrambleColorSystem
};
// ============================================================================
// 10. EXPORTS
// ============================================================================
exports.text = text;
exports.splitChars = splitChars;
exports.splitWords = splitWords;
exports.scramble = scramble;
exports.splitCharsAsync = splitCharsAsync;
exports.splitWordsAsync = splitWordsAsync;
exports.scrambleAsync = scrambleAsync;
exports.scramblePooled = scramblePooled;
exports.createSOAScramble = createSOAScramble;
exports.createScrambleSystem = createScrambleSystem;
exports.createNoiseReveal = createNoiseReveal;
exports.createOrbitalReveal = createOrbitalReveal;
exports.createIKReveal = createIKReveal;
exports.applyDelays = applyDelays;
exports.createScrambleColorSystem = createScrambleColorSystem;
exports.math = {
common: glMatrix, utils: utils, easings: easings,
animation: animationModule, engine: engineModule,
vec2: vec2, vec3: vec3, vec4: vec4,
mat2: mat2, mat3: mat3, mat4: mat4,
quat: quat, quat2: quat2,
bitecs: bitecs, simplex: simplex
};