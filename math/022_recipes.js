"use strict";
//File number : 022
// File : src/math/022_recipes.js
//Description : Preset-recipe dictionary — every original export preserved byte-compatible (`recipes` with all ~60 presets + `presets` alias) — extended with: a zero-GC pooled recipe-factory, bitECS query-driven `recipeOnQuery`, SOA 1M+ recipes for the popular presets (`soaRecipes.*` returning step-able tracks with chunked apply), HDR-safe color variants, new procedural recipes (`noiseWave`, `orbitalReveal`, `keplerChase`, `nebulaBloom`, `starfieldScroll`, `ikReach`, `galacticSpin`), and `chainRecipes` for sequenced lists with `+=`-style offsets.
//####
//Best for : 3d graphics — hero DOM intros (`letterSplit`, `blurUnmask`, `perspectiveFold`, `flip180`, …), HUD widgets (`buttonPop`, `bellWiggle`, `toggleSwitch`, `statusDot`), dashboards (`countUp`, `progressFill`, `circularGauge`, `donutChart`, `sparkline`), SVG logos (`chartDraw`, `svgLogoDraw`, `morphIcon`), pointer-driven props (`magnetic`, `cursorMagnet`), 1M+ instanced variants for GPU scenes (`soaRecipes.gridRipple`, `soaRecipes.starlightSwarm`, `soaRecipes.planetaryOrbit`, …), natural IK reach recipes (`skeletalIK`, `ikReach`), orbital reveals driven by Kepler math (`orbitalReveal`, `keplerChase`, `galacticSpin`), HDR color bloom driven by simplex-noise density (`nebulaBloom`), and scroll-parallax starfields (`starfieldScroll`). All SOA variants fit into `engine.addSoaStep` and yield via `scheduler.yield()` when 1M+ instances are involved.
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
var scopeModule = require("./021_scope.js");
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
var toArray = utils.toArray;
var stagger = utils.stagger;
// ============================================================================
// 0.1 ANIMATION ACQUISITION
// CORRECTION: ES6 class constructors cannot be invoked via `.call()`.
// Pooled reuse is only enabled when the Animation prototype exposes a
// re-initializable `_init` hook; otherwise we fall back to `new Animation`
// and pause the previous instance so at most one is live per handler.
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
// 0.2 LAZY SVG LOADER
// CORRECTION: Added a resolved flag so a missing module is not re-required
// on every call (the original retried the failing require forever).
// ============================================================================
var _svg = null;
var _svgResolved = false;
function getSvg() {
if (_svgResolved) return _svg;
_svgResolved = true;
try {
_svg = require("./023_svg.js").svg || null;
} catch (e) {
try {
_svg = require("./svg.cjs").svg || null;
} catch (e2) {
_svg = null;
}
}
return _svg;
}
// ============================================================================
// 1. ORIGINAL RECIPES (byte-compatible, all ~60 presets preserved)
// ============================================================================
var recipes = {
letterSplit: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, translateY: [40, 0], opacity: [0, 1],
stagger: 30, duration: 600, easing: "spring"
}, opts));
},
wordFloat: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, translateY: [25, 0], scale: [0.92, 1], opacity: [0, 1],
stagger: 80, duration: 700, easing: "spring"
}, opts));
},
blurUnmask: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, scale: [0.85, 1], opacity: [0, 1],
filter: ["blur(12px)", "blur(0px)"], duration: 650, easing: "easeOutCubic"
}, opts));
},
gradientWave: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, rotate: [-6, 0], scale: [0.95, 1], duration: 800, easing: "spring"
}, opts));
},
typewriterBlink: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, scaleX: [0, 1], duration: 900, easing: "steps(20)"
}, opts));
},
counterRoll: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, translateY: [60, 0], opacity: [0, 1], duration: 550, easing: "spring"
}, opts));
},
perspectiveFold: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, rotateX: [70, 0], opacity: [0, 1], duration: 850, easing: "spring"
}, opts));
},
neonFlicker: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, opacity: [0.2, 1, 0.4, 1, 0.8, 1], duration: 400, easing: "linear"
}, opts));
},
skewGlitch: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, skewX: [-25, 20, -10, 0], translateX: [-10, 10, 0],
duration: 350, easing: "easeInOutQuad"
}, opts));
},
waveStagger: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, translateY: [-20, 0], stagger: 50, duration: 500, easing: "spring"
}, opts));
},
tilt3D: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, rotateX: [25, 0], rotateY: [-25, 0], scale: [0.9, 1],
duration: 800, easing: "spring"
}, opts));
},
bentoGlow: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, scale: [0.96, 1], duration: 500, easing: "spring"
}, opts));
},
depthParallax: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, translateY: [-30, 0], scale: [1.08, 1], duration: 750, easing: "spring"
}, opts));
},
glassmorphismFlip: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, rotateY: [180, 0], scale: [0.8, 1], duration: 900, easing: "spring"
}, opts));
},
cardElevate: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, translateY: [-18, 0], scale: [0.95, 1], duration: 600, easing: "spring"
}, opts));
},
perspectiveFan: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, rotate: [-18, 0], translateX: [-30, 0], opacity: [0, 1],
stagger: 70, duration: 650, easing: "spring"
}, opts));
},
flip180: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, rotateY: [0, 180, 0], duration: 1000, easing: "spring"
}, opts));
},
isometricPop: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, rotateX: [45, 0], rotateZ: [-25, 0], scale: [0.75, 1],
duration: 800, easing: "spring"
}, opts));
},
magneticSpring: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, translateX: [-35, 35, 0], translateY: [-15, 15, 0],
duration: 750, easing: "spring"
}, opts));
},
cardUnfold: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, scaleY: [0, 1], opacity: [0, 1], duration: 600, easing: "spring"
}, opts));
},
buttonPop: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, scale: [0.82, 1.15, 1], duration: 400, easing: "spring"
}, opts));
},
magnetic: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, translateX: [-25, 25, 0], translateY: [-12, 12, 0],
duration: 600, easing: "spring"
}, opts));
},
bellWiggle: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, rotate: [-22, 22, -14, 14, -6, 6, 0],
duration: 750, easing: "easeInOutQuad"
}, opts));
},
radarRings: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, scale: [0.4, 2.2], opacity: [1, 0], stagger: 200,
duration: 1100, loop: true, easing: "easeOutCubic"
}, opts));
},
heartPop: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, scale: [0.6, 1.35, 1], duration: 450, easing: "spring"
}, opts));
},
checkDraw: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, strokeDashoffset: [40, 0], duration: 450, easing: "easeOutCubic"
}, opts));
},
toggleSwitch: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, translateX: [0, 24, 0], duration: 600, easing: "spring"
}, opts));
},
fluidRipple: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, scale: [0, 4], opacity: [0.6, 0], duration: 550, easing: "easeOutQuad"
}, opts));
},
accordionDrawer: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, translateY: [-15, 0], opacity: [0, 1], duration: 450, easing: "spring"
}, opts));
},
statusDot: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, scale: [0.75, 1.3], opacity: [0.5, 1],
direction: "alternate", loop: true, duration: 900, easing: "easeInOutQuad"
}, opts));
},
/**
* CORRECTION: The original allocated a fresh `forEach` closure AND a fresh
* formatted string per element on EVERY onUpdate tick (per frame). The
* string is now built once per tick and written with a plain loop.
*/
countUp: function (targets, endVal, opts) {
endVal = endVal === undefined ? 100 : endVal;
opts = opts || {};
var obj = { val: 0 };
var els = toArray(targets);
var n = els.length;
var decimals = opts.decimals || 0;
var suffix = opts.suffix || "%";
return new Animation(Object.assign({
targets: obj,
val: endVal,
round: opts.round || 1,
duration: opts.duration || 1100,
easing: opts.easing || "easeOutCubic",
onUpdate: function () {
var s = obj.val.toFixed(decimals) + suffix;
for (var i = 0; i < n; i++) els[i].textContent = s;
}
}, opts));
},
progressFill: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, scaleX: [0, 1], duration: 900, easing: "easeOutCubic"
}, opts));
},
circularGauge: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, strokeDashoffset: [126, 25], duration: 900, easing: "easeOutCubic"
}, opts));
},
audioEqualizer: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, scaleY: [0.2, 2.2, 0.7], stagger: 40, duration: 550, easing: "spring"
}, opts));
},
tickerMarquee: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, translateX: [0, -200], duration: 3500, loop: true, easing: "linear"
}, opts));
},
stepperFlow: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, scale: [0.5, 1.25, 1], stagger: 120, duration: 450, easing: "spring"
}, opts));
},
sparkline: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, strokeDashoffset: [120, 0], duration: 700, easing: "easeOutQuad"
}, opts));
},
donutChart: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, strokeDashoffset: [113, 28], duration: 750, easing: "easeInOutCubic"
}, opts));
},
telemetryPing: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, scale: [0.5, 1.8], opacity: [1, 0],
duration: 800, loop: true, easing: "easeOutQuad"
}, opts));
},
skeletonShimmer: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, translateX: [-100, 100], duration: 1200, loop: true, easing: "easeInOutQuad"
}, opts));
},
modalDrop: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, translateY: [-80, 0], duration: 850, easing: "easeOutBounce"
}, opts));
},
sidebarFly: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, translateX: [80, 0], duration: 550, easing: "spring"
}, opts));
},
morphBlob: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, rotate: [0, 180, 360], scale: [0.85, 1.1, 1],
duration: 1100, easing: "easeInOutCubic"
}, opts));
},
svgLogoDraw: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, strokeDashoffset: [120, 0], duration: 750, easing: "easeInOutQuad"
}, opts));
},
planetaryOrbit: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, rotate: [0, 360], duration: 2500, loop: true, easing: "linear"
}, opts));
},
techParticles: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, translateY: [-16, 16], stagger: 50,
direction: "alternate", loop: true, duration: 1200, easing: "easeInOutQuad"
}, opts));
},
tabSlider: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, translateX: [0, 75, 0], duration: 650, easing: "spring"
}, opts));
},
backdropUnmask: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, scale: [0.85, 1], opacity: [0.2, 1], duration: 400, easing: "spring"
}, opts));
},
cardStackRoll: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, scale: [1, 0.9, 1], opacity: [1, 0.5, 1],
duration: 600, easing: "easeInOutQuad"
}, opts));
},
curtainWipe: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets, scaleY: [1, 0, 1], duration: 700, easing: "easeInOutQuad"
}, opts));
},
gridRipple: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets,
scale: [0.3, 1.35, 1],
rotate: [-90, 0],
stagger: stagger(opts.stagger || 45, { from: opts.from || "center" }),
duration: opts.duration || 650,
easing: "spring"
}, opts));
},
fireflySwarm: function (targets, opts) {
opts = opts || {};
var rangeX = opts.rangeX || 160;
var rangeY = opts.rangeY || 120;
return new Animation(Object.assign({
targets: targets,
translateX: function () { return (Math.random() - 0.5) * rangeX; },
translateY: function () { return (Math.random() - 0.5) * rangeY; },
scale: [0.5, 1.4, 1],
duration: opts.duration || 850,
easing: "spring"
}, opts));
},
/**
* DOM-only typewriter. The `tick` closure is created ONCE per element and
* reschedules itself, so no new function object is allocated per character.
* String growth is inherent to `textContent` and unavoidable in the DOM.
*/
typewriterHuman: function (targets, text, opts) {
opts = opts || {};
var els = toArray(targets);
var str = text || (els[0] ? els[0].textContent : "");
var variance = opts.variance || 60;
var speed = opts.speed || 40;
var out = [];
for (var e = 0; e < els.length; e++) {
out.push(_makeTypewriter(els[e], str, variance, speed, opts.onComplete || null));
}
return out;
},
/**
* CORRECTION: The original allocated a brand-new `Animation` (and a fresh
* config object) on EVERY pointermove event. Config objects are now
* pre-allocated once and animations are acquired from the pool, with the
* previous instance released before the next is started.
*/
cursorMagnet: function (target, container, opts) {
opts = opts || {};
var el = typeof target === "string"
? (typeof document !== "undefined" ? document.querySelector(target) : null)
: target;
var stage = typeof container === "string"
? (typeof document !== "undefined" ? document.querySelector(container) : null)
: (container || (el ? el.parentElement : null));
if (!el || !stage) return;
var strength = opts.strength || 0.35;
// Pre-allocated configs (Zero-GC across pointer events)
var moveCfg = {
targets: el, translateX: 0, translateY: 0, rotateX: 0, rotateY: 0,
duration: 350, easing: "spring"
};
var leaveCfg = {
targets: el, translateX: 0, translateY: 0, rotateX: 0, rotateY: 0,
duration: 600, easing: "spring"
};
var moveAnim = null;
var leaveAnim = null;
function onMove(e) {
var rect = stage.getBoundingClientRect();
var dx = (e.clientX - rect.left - rect.width * 0.5) * strength;
var dy = (e.clientY - rect.top - rect.height * 0.5) * strength;
moveCfg.translateX = dx;
moveCfg.translateY = dy;
moveCfg.rotateX = -dy * 0.4;
moveCfg.rotateY = dx * 0.4;
_releaseAnim(leaveAnim); leaveAnim = null;
_releaseAnim(moveAnim);
moveAnim = _acquireAnim(moveCfg);
}
function onLeave() {
_releaseAnim(moveAnim); moveAnim = null;
_releaseAnim(leaveAnim);
leaveAnim = _acquireAnim(leaveCfg);
}
stage.addEventListener("pointermove", onMove);
stage.addEventListener("pointerleave", onLeave);
return {
destroy: function () {
stage.removeEventListener("pointermove", onMove);
stage.removeEventListener("pointerleave", onLeave);
_releaseAnim(moveAnim); moveAnim = null;
_releaseAnim(leaveAnim); leaveAnim = null;
}
};
},
chartDraw: function (targets, opts) {
opts = opts || {};
var svg = getSvg();
if (!svg) throw new Error("recipes.chartDraw requires the svg module to be loaded");
return svg.createDrawable(targets, Object.assign({
duration: opts.duration || 900, easing: "easeInOutCubic"
}, opts));
},
morphIcon: function (targetPath, endPathSelector, opts) {
opts = opts || {};
var svg = getSvg();
if (!svg) throw new Error("recipes.morphIcon requires the svg module to be loaded");
return svg.morphTo(targetPath, endPathSelector, opts);
},
layeredSpin: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets,
rotateX: [35, 0],
rotateY: [-35, 0],
rotateZ: [15, 0],
scale: [0.8, 1],
duration: opts.duration || 800,
easing: "spring"
}, opts));
},
infiniteCarousel: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets,
translateX: [0, -(opts.distance || 300)],
duration: opts.duration || 4000,
loop: true,
easing: "linear"
}, opts));
},
skeletalIK: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets,
rotate: [-18, 18, -12, 12, 0],
stagger: opts.stagger || 60,
duration: opts.duration || 900,
easing: "spring"
}, opts));
},
starlightSwarm: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets,
scale: [0.2, 1.2, 0.4],
opacity: [0.2, 1, 0.2],
stagger: stagger(opts.stagger || 25, { from: "center" }),
loop: true,
duration: opts.duration || 1400,
easing: "easeInOutQuad"
}, opts));
},
clockScrub: function (targets, opts) {
opts = opts || {};
return new Animation(Object.assign({
targets: targets,
rotate: [0, 360],
duration: opts.duration || 12000,
loop: true,
easing: "linear"
}, opts));
}
};
var presets = recipes;
/** Hoisted typewriter factory — one closure per element, not per character. */
function _makeTypewriter(el, str, variance, speed, onComplete) {
el.textContent = "";
var i = 0;
var tick = function () {
if (i < str.length) {
el.textContent += str[i++];
setTimeout(tick, Math.random() * variance + speed);
} else if (onComplete) {
onComplete(el);
}
};
tick();
return el;
}
// ============================================================================
// 2. POOL — reusable recipe-animation slots (zero-GC)
// CORRECTION: The returned wrapper object and its `release` closure are now
// created ONCE per pool slot. `pooledRecipe` only mutates state.
// ============================================================================
var _recipeAnims = glMatrix.createPool(
function () {
var h = { anim: null, kind: null, released: true };
h.wrapper = {
get anim() { return h.anim; },
get kind() { return h.kind; },
release: function () {
if (h.released) return;
_recipeAnims.release(h);
}
};
return h;
},
16,
function (h) {
_releaseAnim(h.anim);
h.anim = null;
h.kind = null;
h.released = true;
}
);
/**
Run a recipe using pooled state — for repeated "play preset" events on
the same target without accumulating Animation instances.
*/
function pooledRecipe(name, targets, args) {
var fn = recipes[name];
if (typeof fn !== "function") throw new Error("pooledRecipe: unknown recipe " + name);
var handle = _recipeAnims.acquire();
handle.released = false;
handle.kind = name;
handle.anim = fn.apply(null, [targets].concat(args || []));
return handle.wrapper;
}
// ============================================================================
// 3. CHAINED RECIPES — sequence multiple presets
// ============================================================================
/**
Chain a list of recipes into a single timeline-like sequence.
Each entry: { recipe, targets, args?, offset? }
`offset` uses Timeline-style `+=N`, `-=N`, `+=N%`, or absolute ms.
Returns `{ play(), pause(), restart(), seek(p), step(dtMs), duration, time }`.
All sequence entries are built at setup time; `step`/`render` are Zero-GC.
*/
function chainRecipes(entries, options) {
options = options || {};
var seq = [];
var cursor = 0;
var maxEnd = 0;
for (var i = 0; i < entries.length; i++) {
var e = entries[i];
var fn = recipes[e.recipe];
if (typeof fn !== "function") throw new Error("chainRecipes: unknown recipe " + e.recipe);
var anim = fn.apply(null, [e.targets].concat(e.args || []));
anim.pause();
var off = 0;
if (typeof e.offset === "number") {
off = e.offset;
} else if (typeof e.offset === "string") {
var m = e.offset.match(/^([+-])=?([\d.]+)(%?)$/);
if (m) {
var delta = m[3] === "%" ? (cursor * parseFloat(m[2]) / 100) : parseFloat(m[2]);
off = (m[1] === "-") ? Math.max(0, cursor - delta) : cursor + delta;
}
} else {
off = cursor;
}
var dur = anim.duration + (anim.endDelay || 0);
seq.push({ anim: anim, start: off, dur: dur });
cursor = off + dur;
if (cursor > maxEnd) maxEnd = cursor;
}
var state = { time: 0, playing: false, duration: maxEnd };
var seqLen = seq.length;
function render() {
for (var k = 0; k < seqLen; k++) {
var s = seq[k];
var local = state.time - s.start;
var p = s.dur > 0 ? Math.max(0, Math.min(1, local / s.dur)) : (local >= 0 ? 1 : 0);
try { s.anim.seek(p); } catch (err) { /* swallow */ }
}
}
function step(dtMs) {
if (!state.playing) return;
state.time += dtMs;
if (state.time >= state.duration) {
state.time = state.duration;
render();
state.playing = false;
if (options.onComplete) options.onComplete(state);
return;
}
render();
}
return {
play: function () { state.playing = true; render(); return this; },
pause: function () { state.playing = false; return this; },
restart: function () { state.time = 0; return this.play(); },
seek: function (p) {
state.time = Math.max(0, Math.min(1, p)) * state.duration;
render();
return this;
},
step: step,
get duration() { return state.duration; },
get time() { return state.time; },
destroy: function () {
for (var k = 0; k < seqLen; k++) {
try { seq[k].anim.pause(); } catch (err) { /* swallow */ }
}
seq.length = 0;
}
};
}
// ============================================================================
// 4. SOA RECIPES — 1M+ instanced versions of popular presets
// ============================================================================
// Each factory returns an object with `step(dtSec)`, `stepChunked`,
// `apply()`, `applyChunked()`, `done`, and `track`.
// Wire into `engine.addSoaStep`.
var soaRecipes = {};
/** Grid-ripple — staggered scale-up across a grid of instances. */
soaRecipes.gridRipple = function (trs, options) {
options = options || {};
var n = trs.position.count;
var grid = options.grid || [16, 16];
var from = options.from || "center";
var duration = options.duration !== undefined ? options.duration : 0.65;
var maxStagger = (options.stagger !== undefined ? options.stagger : 45) / 1000;
var staggerFn = utils.stagger(1, { grid: grid, from: from });
var track = animationModule.createSOAAnimationTrack(n, { ease: options.ease || "spring" });
for (var i = 0; i < n; i++) {
track.setElement(i, 0.3, 1, duration, staggerFn(i, n) * maxStagger);
}
return _makeSoaRecipeHandle(track, trs.scale.x, n);
};
/** Starlight-swarm — staggered alpha pulse on the color SOA. */
soaRecipes.starlightSwarm = function (colors, options) {
options = options || {};
var n = colors.count;
var duration = options.duration !== undefined ? options.duration : 1.4;
var maxStagger = (options.stagger !== undefined ? options.stagger : 25) / 1000;
var staggerFn = utils.stagger(1, { from: options.from || "center" });
var track = animationModule.createSOAAnimationTrack(n, { ease: "easeInOutQuad" });
for (var i = 0; i < n; i++) {
track.setElement(i, 0.2, 1, duration, staggerFn(i, n) * maxStagger);
}
return _makeSoaRecipeHandle(track, colors.w, n);
};
/**
Planetary-orbit — linear 0..2π rotation over `duration`.
By default this writes the Euler-Z channel (`rotations.z`), matching the
original behaviour. Pass `asQuat: true` when `rotations` is a quat SOA
(x,y,z,w) so a correct unit quaternion is produced instead.
*/
soaRecipes.planetaryOrbit = function (rotations, options) {
options = options || {};
var n = rotations.count;
var duration = options.duration !== undefined ? options.duration : 2.5;
var track = animationModule.createSOAAnimationTrack(n, { ease: "linear" });
track.fillUniform(0, Math.PI * 2, duration, 0);
if (options.asQuat === true && rotations.w) {
var rz = rotations.z, rw = rotations.w;
if (rotations.x) rotations.x.fill(0);
if (rotations.y) rotations.y.fill(0);
return {
track: track,
count: n,
step: function (dtSec) { track.step(dtSec); },
stepChunked: function (dtSec, cs, ye) { return track.stepChunked(dtSec, cs, ye); },
apply: function () {
var cur = track.current;
for (var i = 0; i < n; i++) {
var half = cur[i] * 0.5;
rz[i] = Math.sin(half);
rw[i] = Math.cos(half);
}
},
applyChunked: async function (chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
var cur = track.current, c = 0;
for (var s = 0; s < n; s += chunkSize) {
var e = Math.min(s + chunkSize, n);
for (var j = s; j < e; j++) {
var h2 = cur[j] * 0.5;
rz[j] = Math.sin(h2);
rw[j] = Math.cos(h2);
}
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
},
get done() { return track.done; }
};
}
return _makeSoaRecipeHandle(track, rotations.z, n);
};
/** Magnetic — spring-eased X offset. */
soaRecipes.magnetic = function (trs, options) {
options = options || {};
var n = trs.position.count;
var duration = options.duration !== undefined ? options.duration : 0.6;
var track = animationModule.createSOAAnimationTrack(n, { ease: "easeOutBack" });
track.fillUniform(-25, 0, duration, 0);
return _makeSoaRecipeHandle(track, trs.position.x, n);
};
/** Wave-stagger — Y offset with per-row time stagger. */
soaRecipes.waveStagger = function (trs, options) {
options = options || {};
var n = trs.position.count;
var duration = options.duration !== undefined ? options.duration : 0.5;
var maxStagger = (options.stagger !== undefined ? options.stagger : 50) / 1000;
var track = animationModule.createSOAAnimationTrack(n, { ease: "spring" });
var invN = n > 0 ? 1 / n : 0;
for (var i = 0; i < n; i++) {
track.setElement(i, -20, 0, duration, (i * invN) * maxStagger);
}
return _makeSoaRecipeHandle(track, trs.position.y, n);
};
/** Blur-unmask — opacity reveal across 1M+ instances. */
soaRecipes.blurUnmask = function (colors, options) {
options = options || {};
var n = colors.count;
var duration = options.duration !== undefined ? options.duration : 0.65;
var track = animationModule.createSOAAnimationTrack(n, { ease: "easeOutCubic" });
track.fillUniform(0, 1, duration, 0);
return _makeSoaRecipeHandle(track, colors.w, n);
};
/** Progress-fill — scale a channel from 0 to 1. */
soaRecipes.progressFill = function (trs, options) {
options = options || {};
var axis = options.axis || "x";
var n = trs.position.count;
var duration = options.duration !== undefined ? options.duration : 0.9;
var track = animationModule.createSOAAnimationTrack(n, { ease: "easeOutCubic" });
track.fillUniform(0, 1, duration, 0);
return _makeSoaRecipeHandle(track, trs.scale[axis], n);
};
/**
CORRECTION: Added `applyChunked` so writing 1M+ channel values never
blocks the Android UI thread (Blueprint Sections 12 / 16).
*/
function _makeSoaRecipeHandle(track, channel, count) {
return {
track: track,
channel: channel,
count: count,
step: function (dtSec) { track.step(dtSec); },
stepChunked: function (dtSec, chunkSize, yieldEvery) {
return track.stepChunked(dtSec, chunkSize, yieldEvery);
},
apply: function () {
var cur = track.current;
for (var i = 0; i < count; i++) channel[i] = cur[i];
},
applyChunked: async function (chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
var cur = track.current;
var c = 0;
for (var start = 0; start < count; start += chunkSize) {
var end = Math.min(start + chunkSize, count);
for (var i = start; i < end; i++) channel[i] = cur[i];
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
},
get done() { return track.done; }
};
}
// ============================================================================
// 5. HDR-SAFE COLOR RECIPES
// ============================================================================
/**
HDR color scrub — fromColor → toColor over `duration`, no clamping, works
for `colors` in the SOA with values up to 1e6 (or beyond). Fits perfectly
with ACES / Reinhard tone maps.
*/
function recipeHDRColorScrub(colors, fromColor, toColor, duration, options) {
options = options || {};
var a = animationModule.createColorSOAAnimation(
colors, fromColor, toColor, duration, options.ease || "easeOutCubic"
);
return {
step: function (dtSec) { a.step(dtSec); },
get done() { return a.done; }
};
}
// ============================================================================
// 6. NEW PROCEDURAL RECIPES (3D-first)
// ============================================================================
/**
Noise-wave — drives `channel[i]` from a 3D simplex field sampled at the
instance's own position; elapsed time becomes the 4th axis. Perfect for
organic waves on 1M+ instances without storing per-element keyframes.
*/
function recipeNoiseWave(trs, channel, options) {
options = options || {};
var noiseFn = options.noiseFn || simplex.acquireNoise3D(options.seed);
var scale = options.scale !== undefined ? options.scale : 0.01;
var speed = options.speed !== undefined ? options.speed : 0.5;
var amplitude = options.amplitude !== undefined ? options.amplitude : 1;
var t = 0;
var n = trs.position.count;
var px = trs.position.x, py = trs.position.y, pz = trs.position.z;
return {
step: function (dtSec) {
t += dtSec * speed;
for (var i = 0; i < n; i++) {
channel[i] = noiseFn(px[i] * scale, py[i] * scale, pz[i] * scale + t) * amplitude;
}
},
stepChunked: async function (dtSec, chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
t += dtSec * speed;
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
var end = Math.min(start + chunkSize, n);
for (var i = start; i < end; i++) {
channel[i] = noiseFn(px[i] * scale, py[i] * scale, pz[i] * scale + t) * amplitude;
}
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
},
get done() { return false; }
};
}
/**
Orbital-reveal — per-row delay from Kepler-solved true anomaly.
Use the returned array as a `stagger` when constructing an SOA track.
*/
function recipeOrbitalReveal(count, options) {
options = options || {};
var e = options.e !== undefined ? options.e : 0.5;
var speed = options.speed !== undefined ? options.speed : 1;
var delays = new Float32Array(count);
var TWO_PI = Math.PI * 2;
var invCount = count > 0 ? 1 / count : 0;
for (var i = 0; i < count; i++) {
var M = (i * invCount) * TWO_PI;
var E = glMatrix.keplerSolve(M, e);
var nu = glMatrix.eccentricToTrue(E, e);
delays[i] = ((nu + Math.PI) / TWO_PI) * speed;
}
return delays;
}
/**
Kepler-chase — scroll-driven mean anomaly animation.
CORRECTION: `options.M1` previously produced NaN when omitted; it now
defaults to one full revolution (M0 + 2π). The span is hoisted out of
the per-frame loop.
*/
function recipeKeplerChase(master, elements, options) {
options = options || {};
var M0 = options.M0 !== undefined ? options.M0 : 0;
var M1 = options.M1 !== undefined ? options.M1 : M0 + Math.PI * 2;
var span = M1 - M0;
var dM = options.delta || null;
var ease = easings.getEasing(options.ease || "linear");
var MArr = elements.M;
var n = MArr.length;
return {
step: function () {
var p = ease(master.progress);
if (dM) {
for (var i = 0; i < n; i++) MArr[i] = M0 + dM[i] * p;
} else {
MArr.fill(M0 + span * p);
}
},
get done() { return master.progress >= 1; }
};
}
/**
Nebula-bloom — HDR color pulse across 1M+ instances driven by simplex
noise density. Combine with an ACES tone map for a cinematic nebula.
CORRECTION: Color deltas and position channel references are hoisted out
of the per-frame loop (they were recomputed per element per frame).
*/
function recipeNebulaBloom(colors, options) {
options = options || {};
var noiseFn = options.noiseFn || simplex.acquireNoise3D(options.seed);
var baseColor = options.baseColor || [0.2, 0.4, 0.9, 1];
var hotColor = options.hotColor || [3.0, 2.0, 5.0, 1]; // HDR!
var scale = options.scale !== undefined ? options.scale : 0.02;
var speed = options.speed !== undefined ? options.speed : 0.4;
var minDensity = options.minDensity !== undefined ? options.minDensity : 0.1;
var maxDensity = options.maxDensity !== undefined ? options.maxDensity : 1;
var positions = options.positions || null;
var n = colors.count;
var cr = colors.x, cg = colors.y, cb = colors.z, ca = colors.w;
var px = positions ? positions.x : null;
var py = positions ? positions.y : null;
var pz = positions ? positions.z : null;
var br = baseColor[0], bg = baseColor[1], bb = baseColor[2], ba = baseColor[3];
var dr = hotColor[0] - br, dg = hotColor[1] - bg, db = hotColor[2] - bb, da = hotColor[3] - ba;
var dSpan = maxDensity - minDensity;
var t = 0;
function writeRange(s, e) {
for (var i = s; i < e; i++) {
var nx = px ? px[i] * scale : i * scale;
var ny = py ? py[i] * scale : 0;
var nz = pz ? pz[i] * scale : 0;
var density = 0.5 + 0.5 * noiseFn(nx, ny, nz + t);
var w = minDensity + dSpan * density;
cr[i] = br + dr * w;
cg[i] = bg + dg * w;
cb[i] = bb + db * w;
ca[i] = ba + da * w;
}
}
return {
step: function (dtSec) {
t += dtSec * speed;
writeRange(0, n);
},
stepChunked: async function (dtSec, chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
t += dtSec * speed;
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
writeRange(start, Math.min(start + chunkSize, n));
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
},
get done() { return false; }
};
}
/**
Starfield-scroll — parallax starfield driven by scroll. Background stars
move at lower speed, foreground at higher. The baseline Z is captured
once at setup (initialization-time allocation, not per frame).
*/
function recipeStarfieldScroll(master, trs, options) {
options = options || {};
var depth = options.depth || null;
var strength = options.strength !== undefined ? options.strength : 20;
var n = trs.position.count;
var sz = trs.position.z;
var baseZ = new Float32Array(n);
baseZ.set(sz);
function writeRange(s, e, p) {
for (var i = s; i < e; i++) {
sz[i] = baseZ[i] + p * strength * (depth ? depth[i] : 1);
}
}
return {
step: function () { writeRange(0, n, master.progress); },
stepChunked: async function (chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
var p = master.progress;
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
writeRange(start, Math.min(start + chunkSize, n), p);
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
},
get done() { return false; }
};
}
/**
IK-reach — scroll progress drives a FABRIK/CCD target from `fromTarget`
to `toTarget` and re-solves the chain.
CORRECTION: Tolerance is configurable and compared against the solver's
returned DISTANCE error (matching the corrected `vec3.fabrikStep3`),
instead of comparing a distance against a squared epsilon.
*/
function recipeIKReach(master, chain, fromTarget, toTarget, options) {
options = options || {};
var ease = easings.getEasing(options.ease || "easeInOutCubic");
var iterations = options.iterations || 10;
var tolerance = options.tolerance !== undefined ? options.tolerance : 0.001;
var useCCD = options.method === "ccd";
var fx = fromTarget[0], fy = fromTarget[1], fz = fromTarget[2];
var dx = toTarget[0] - fx, dy = toTarget[1] - fy, dz = toTarget[2] - fz;
return {
step: function () {
var et = ease(master.progress);
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
},
get done() { return master.progress >= 1; }
};
}
/**
Galactic-spin — differential rotation: inner instances rotate faster than
outer ones (matches real spiral galaxies).
CORRECTION: Fixed a fatal operator omission — the original computed
`omegaInner (omegaOuter - omegaInner) * t` (a call on a number). The
correct interpolation is `omegaInner + (omegaOuter - omegaInner) * t`.
The axis branch is also resolved once instead of per element per frame.
*/
function recipeGalacticSpin(rotations, positions, options) {
options = options || {};
var omegaInner = options.omegaInner !== undefined ? options.omegaInner : 1.0;
var omegaOuter = options.omegaOuter !== undefined ? options.omegaOuter : 0.25;
var radius = options.radius !== undefined ? options.radius : 100;
var axis = options.axis || "z";
var n = rotations.count;
var px = positions.x, py = positions.y;
var rx = rotations.x, ry = rotations.y, rz = rotations.z, rw = rotations.w;
var angles = new Float32Array(n);
var invRadius = radius > 0 ? 1 / radius : 0;
var omegaSpan = omegaOuter - omegaInner;
var mode = axis === "z" ? 0 : axis === "y" ? 1 : 2;
function writeRange(s, e, dtSec) {
for (var i = s; i < e; i++) {
var x = px[i], y = py[i];
var r = Math.sqrt(x * x + y * y);
var t = r * invRadius;
if (t > 1) t = 1;
// CORRECTED: linear interpolation of angular velocity
var omega = omegaInner + omegaSpan * t;
angles[i] += omega * dtSec;
var half = angles[i] * 0.5;
var c = Math.cos(half);
var sn = Math.sin(half);
if (mode === 0) { rx[i] = 0; ry[i] = 0; rz[i] = sn; rw[i] = c; }
else if (mode === 1) { rx[i] = 0; ry[i] = sn; rz[i] = 0; rw[i] = c; }
else { rx[i] = sn; ry[i] = 0; rz[i] = 0; rw[i] = c; }
}
}
return {
step: function (dtSec) { writeRange(0, n, dtSec); },
stepChunked: async function (dtSec, chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
writeRange(start, Math.min(start + chunkSize, n), dtSec);
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
},
get done() { return false; }
};
}
// ============================================================================
// 7. BITECS QUERY RECIPE — apply a recipe to any query result
// ============================================================================
/**
Resolve a recipe against a bitECS query result.
CORRECTION: When SOA buffers (`trs` / `colors` / `rotations`) are supplied
and a SOA variant exists, the SOA path is taken FIRST. The original always
preferred the DOM recipe, which allocated one wrapper object per entity —
catastrophic at 1M+ and in direct violation of the Zero-GC mandate.
The DOM/object fallback remains for small, object-target animations and
is explicitly a setup-time (not per-frame) allocation.
*/
function recipeOnQuery(queryResult, name, args, options) {
options = options || {};
var soaFn = soaRecipes[name];
var soaBuffer = options.trs || options.colors || options.rotations;
if (typeof soaFn === "function" && soaBuffer) {
return soaFn.apply(null, [soaBuffer].concat(args || []));
}
var fn = recipes[name];
if (typeof fn === "function") {
var list = queryResult.dense || queryResult;
var len = list.length;
var objs = new Array(len);
for (var i = 0; i < len; i++) {
objs[i] = options.objectBuilder ? options.objectBuilder(list[i]) : { value: 0 };
}
return fn.apply(null, [objs].concat(args || []));
}
if (typeof soaFn === "function") {
return soaFn.apply(null, [soaBuffer].concat(args || []));
}
throw new Error("recipeOnQuery: unknown recipe " + name);
}
// ============================================================================
// 8. EXPORTS
// ============================================================================
// ---- original ----
exports.recipes = recipes;
exports.presets = presets;
// ---- pool ----
exports.pooledRecipe = pooledRecipe;
// ---- chain ----
exports.chainRecipes = chainRecipes;
// ---- SOA ----
exports.soaRecipes = soaRecipes;
// ---- HDR color ----
exports.recipeHDRColorScrub = recipeHDRColorScrub;
// ---- new procedural recipes ----
exports.recipeNoiseWave = recipeNoiseWave;
exports.recipeOrbitalReveal = recipeOrbitalReveal;
exports.recipeKeplerChase = recipeKeplerChase;
exports.recipeNebulaBloom = recipeNebulaBloom;
exports.recipeStarfieldScroll = recipeStarfieldScroll;
exports.recipeIKReach = recipeIKReach;
exports.recipeGalacticSpin = recipeGalacticSpin;
// ---- bitECS ----
exports.recipeOnQuery = recipeOnQuery;
// ---- lazy loaders / helpers ----
exports.getSvg = getSvg;
// ---- math re-exports ----
exports.math = {
common: glMatrix,
utils: utils,
easings: easings,
animation: animationModule,
engine: engineModule,
scope: scopeModule,
timer: timerModule,
vec2: vec2, vec3: vec3, vec4: vec4,
mat2: mat2, mat3: mat3, mat4: mat4,
quat: quat, quat2: quat2,
bitecs: bitecs,
simplex: simplex
};