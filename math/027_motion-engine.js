//File number : 027
// File : src/math/027_motion-engine.js
//Description : The all-in-one motion engine bundle — every original UMD export preserved byte-compatible (`animate`, `timeline`, `timer`, `animatable`, `draggable`, `layout`, `scope`, `svg`, `text`, `onScroll`, `scrollTrigger`, `ScrollTriggerInstance`, `waapi`, `adapters`, `animateThree`, `engine`, `easings`, `utils`, `stagger`, `recipes`, `presets`, `spring`, `shake`, `flip`, `tilt`, `modal`, `draw`, `scramble`, `morph`, `magnet`, `gridRipple`, `swarm`, `typewriter`) — extended with `createScene`, `procedural`, `render`, `color`, `ik`, `orbital`, `soa`, `pool`, `chunked`, `world`, `double`, and `math` namespaces that aggregate every SOA / pooled / chunked / bitECS helper produced by the earlier modules into one flat, script-tag-friendly global (`StudioMotion`).
//####
//Best for : 3d graphics — one-call scene bootstrapping (`createScene` returns engine + world + TRS/color/matrix SOAs + eids ready for 1M+ instances), 3D procedural generation (simplex / fbm / turbulence / ridged / warp / curl / voronoi with SOA + chunked variants), rendering (instanced batches with dirty-range upload, TBN builders, normal matrices, batched TRS compose), color (sRGB/linear, ACES/reinhard, pack/unpack, hue rotation as a matrix, SOA apply), natural IK (FABRIK/CCD + joint transforms + DQ look-at), orbital mechanics (Kepler solver, orbit pos/vel, Hohmann, SOI, epoch advance), pooling (every vector/matrix/quaternion/animation/timer/timeline/Double), mobile-safe chunked iteration via `scheduler.yield`, and bitECS world serialization — all wired into a single require or `<script>` tag with no per-frame allocation on Android 64-bit.
//License : MIT
(function (global, factory) {
    if (typeof exports === "object" && typeof module !== "undefined") {
        module.exports = factory();
    } else if (typeof define === "function" && define.amd) {
        define(factory);
    } else {
        global = typeof globalThis !== "undefined" ? globalThis : (global || self);
        global.StudioMotion = factory();
        global.animate = global.StudioMotion.animate;
        global.timeline = global.StudioMotion.timeline;
        global.timer = global.StudioMotion.timer;
        global.onScroll = global.StudioMotion.onScroll;
        global.scrollTrigger = global.StudioMotion.scrollTrigger;
        global.draggable = global.StudioMotion.draggable;
        global.recipes = global.StudioMotion.recipes;
    }
})(this, function () {
    // CORRECTION: the original directive was `"use strict "` (trailing space),
    // which is NOT a valid strict-mode prologue — the whole bundle silently ran
    // in sloppy mode. Fixed to the exact literal.
    "use strict";

    // ==========================================================================
    // 0. IMPORTS — every module produced so far (numbered filenames)
    // ==========================================================================
    var glMatrix = require("./001_common.js");
    var vec2 = require("./002_vec2.js");
    var vec3 = require("./003_vec3.js");
    var vec4 = require("./004_vec4.js");
    var mat2 = require("./005_mat2.js");
    var mat3 = require("./006_mat3.js");
    var mat4 = require("./007_mat4.js");
    var quat = require("./008_quat.js");
    var quat2 = require("./009_quat2.js");
    var bitecs = require("./010_bitECS_core.js");
    var serialization = require("./011_bitECS_serialization.js");
    var double = require("./012_double.js");
    var simplex = require("./013_simplex-noise.js");
    var utils = require("./014_utils.js");
    var easings = require("./015_easings.js");
    var engineModule = require("./016_engine.js");
    var animationModule = require("./017_animation.js");
    var textModule = require("./018_text.js");
    var timerModule = require("./019_timer.js");
    var scrollModule = require("./020_scroll.js");
    var scopeModule = require("./021_scope.js");
    var recipesModule = require("./022_recipes.js");
    var svgModule = require("./023_svg.js");
    var adaptersModule = require("./025_adapters.js");
    var draggableModule = require("./026_draggable.js");

    var Animation = animationModule.Animation;
    var GlobalEngine = engineModule.GlobalEngine;
    var toArray = utils.toArray;
    var clamp = utils.clamp;

    // CORRECTION: the timeline module was required eagerly, so the entire bundle
    // threw at load time when it was absent. It is now resolved lazily and
    // optionally, exactly like `scope.getTimeline()`.
    var _timelineModule = null;
    var _timelineResolved = false;
    function getTimelineModule() {
        if (_timelineResolved) return _timelineModule;
        _timelineResolved = true;
        var paths = ["./024_timeline.js", "./timeline.cjs", "./timeline.js"];
        for (var i = 0; i < paths.length; i++) {
            try {
                var m = require(paths[i]);
                if (m && m.Timeline) { _timelineModule = m; return m; }
            } catch (e) { /* try next */ }
        }
        _timelineModule = null;
        return null;
    }

    // ==========================================================================
    // 1. BUNDLE-SPECIFIC IMPLEMENTATIONS
    //    (byte-identical to the original motion-engine.js where the source
    //    differs from the modular version)
    // ==========================================================================

    // ---- BUNDLE TIMER: duration default 1000, onTick(timer), progress field ----
    var BUNDLE_MAX_DELTA = 64; // ms — Blueprint Snippet 51 spiral-of-death guard
    function BundleTimer(config) {
        config = config || {};
        this.duration = config.duration || 1000;
        this.loop = config.loop || false;
        this.onTick = config.onTick || null;
        this.onComplete = config.onComplete || null;
        this.currentTime = 0;
        this.progress = 0;
        this.isRunning = false;
        this.lastTime = 0;
        // Opt-in extensions (defaults preserve original behaviour)
        this.timeScale = config.timeScale !== undefined ? config.timeScale : 1;
        this.maxLoops = config.maxLoops !== undefined ? config.maxLoops : Infinity;
        this.onLoop = config.onLoop || null;
        this._loopCount = 0;
        if (config.autoplay !== false) this.play();
    }
    BundleTimer.prototype.play = function () {
        this.isRunning = true;
        this.lastTime = typeof performance !== "undefined" ? performance.now() : Date.now();
        GlobalEngine.add(this);
        return this;
    };
    BundleTimer.prototype.pause = function () {
        this.isRunning = false;
        GlobalEngine.remove(this);
        return this;
    };
    BundleTimer.prototype.restart = function () {
        this.currentTime = 0;
        this.progress = 0;
        this._loopCount = 0;
        return this.play();
    };
    BundleTimer.prototype._step = function () {
        if (!this.isRunning) return;
        var now = typeof performance !== "undefined" ? performance.now() : Date.now();
        // CORRECTION: the original used the raw unclamped delta, so a backgrounded
        // tab or a GC pause produced a multi-second jump (Blueprint Snippet 51).
        var raw = now - this.lastTime;
        this.lastTime = now;
        var dt = Math.min(BUNDLE_MAX_DELTA, Math.max(0, raw)) * this.timeScale;
        this._advance(dt);
    };
    /** Deterministic advance with a caller-supplied delta (additive API). */
    BundleTimer.prototype.stepFixed = function (dtMs) {
        if (!this.isRunning) return this;
        this._advance(Math.max(0, dtMs) * this.timeScale);
        return this;
    };
    BundleTimer.prototype._advance = function (dt) {
        this.currentTime += dt;
        this.progress = Math.min(1, Math.max(0, this.currentTime / this.duration));
        if (this.onTick) this.onTick(this);
        if (this.currentTime >= this.duration) {
            if (this.loop) {
                this._loopCount++;
                if (this._loopCount >= this.maxLoops) {
                    this.pause();
                    if (this.onComplete) this.onComplete(this);
                    return;
                }
                this.currentTime = 0;
                this.progress = 0;
                if (this.onLoop) this.onLoop(this);
            } else {
                this.pause();
                if (this.onComplete) this.onComplete(this);
            }
        }
    };

    // ---- BUNDLE ANIMATABLE: transform-string builder (not a Proxy) ----
    // CORRECTION: key list is cached so `set()` no longer walks `for...in` on
    // every call; the transform string is rebuilt from a dense array.
    function bundleAnimatable(target, props) {
        var keys = [];
        var vals = [];
        var inst = {
            target: target,
            transforms: {},
            set: function (key, val) {
                this.transforms[key] = val;
                var idx = keys.indexOf(key);
                if (idx === -1) { idx = keys.length; keys.push(key); vals.push(null); }
                vals[idx] = val;
                var str = "";
                for (var i = 0; i < keys.length; i++) {
                    if (i > 0) str += " ";
                    str += keys[i] + "(" + vals[i] + ")";
                }
                if (target && target.style) target.style.transform = str;
                return this;
            }
        };
        if (props) { for (var k in props) inst.set(k, props[k]); }
        return inst;
    }

    // ---- BUNDLE SCOPE: simple animation registry (no execute-callback) ----
    function bundleScope(container) {
        var root = typeof container === "string"
            ? (typeof document !== "undefined" ? document.querySelector(container) : null)
            : container;
        var animations = [];
        return {
            add: function (anim) { animations.push(anim); return anim; },
            revert: function () {
                for (var i = 0; i < animations.length; i++) {
                    if (animations[i] && animations[i].pause) animations[i].pause();
                }
                animations.length = 0;
            },
            select: function (selector) { return root ? root.querySelectorAll(selector) : []; }
        };
    }

    // ---- BUNDLE LAYOUT: FLIP first/last ----
    // CORRECTION: replaced the per-call `Map` + `forEach` closures + one fresh
    // Animation config per element with pre-allocated typed-array rect storage,
    // plain loops, and reused config/pair objects (Blueprint Sections 10 / 16).
    function bundleLayout(targets) {
        var els = toArray(targets);
        var n = els.length;
        var firstRects = new Float64Array(n * 4); // left, top, width, height
        var recorded = new Uint8Array(n);
        var cfgs = new Array(n);
        var pairs = new Array(n);
        for (var i = 0; i < n; i++) {
            pairs[i] = [[0, 0], [0, 0], [1, 1], [1, 1]];
            cfgs[i] = {
                targets: els[i],
                translateX: pairs[i][0],
                translateY: pairs[i][1],
                scaleX: pairs[i][2],
                scaleY: pairs[i][3],
                duration: 600,
                easing: "spring"
            };
        }
        var anims = [];
        return {
            record: function () {
                for (var j = 0; j < n; j++) {
                    var r = els[j].getBoundingClientRect();
                    var o = j * 4;
                    firstRects[o] = r.left;
                    firstRects[o + 1] = r.top;
                    firstRects[o + 2] = r.width;
                    firstRects[o + 3] = r.height;
                    recorded[j] = 1;
                }
                return this;
            },
            play: function (opts) {
                opts = opts || {};
                var duration = opts.duration || 600;
                var easing = opts.easing || "spring";
                for (var j = 0; j < n; j++) {
                    if (!recorded[j]) continue;
                    var o = j * 4;
                    var last = els[j].getBoundingClientRect();
                    var p = pairs[j];
                    p[0][0] = firstRects[o] - last.left; p[0][1] = 0;
                    p[1][0] = firstRects[o + 1] - last.top; p[1][1] = 0;
                    p[2][0] = firstRects[o + 2] / (last.width || 1); p[2][1] = 1;
                    p[3][0] = firstRects[o + 3] / (last.height || 1); p[3][1] = 1;
                    var cfg = cfgs[j];
                    cfg.duration = duration;
                    cfg.easing = easing;
                    for (var k in opts) {
                        if (k === "duration" || k === "easing" || k === "targets") continue;
                        cfg[k] = opts[k];
                    }
                    anims.push(new Animation(cfg));
                }
                return this;
            },
            revert: function () {
                for (var j = 0; j < anims.length; j++) {
                    if (anims[j] && anims[j].pause) anims[j].pause();
                }
                anims.length = 0;
                recorded.fill(0);
            }
        };
    }

    // ---- BUNDLE SCROLLTRIGGER: preserves motion-engine.js math ----
    function BundleScrollTrigger(config) {
        config = config || {};
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
            var animCfg = {};
            for (var k in config.animation) animCfg[k] = config.animation[k];
            animCfg.targets = config.animation.targets || this.target;
            animCfg.autoplay = false;
            this.animation = new Animation(animCfg);
        }
        this.isInView = false;
        this.progress = 0;
        this.direction = 1;
        this.lastScrollPos = 0;
        this.ticking = false;
        // Zero-GC caches: thresholds are parsed on init/resize only.
        this._rafId = null;
        this._vh = 0;
        this._startPx = 0;
        this._endPx = 0;
        this._thresholdsDirty = true;
        // Pre-bound callbacks — allocated ONCE, never per scroll event.
        this._onScroll = this._onScroll.bind(this);
        this._onResize = this._onResize.bind(this);
        this._rafTick = this._rafTick.bind(this);
        this.init();
    }
    BundleScrollTrigger.prototype.init = function () {
        if (!this.target || typeof window === "undefined") return;
        window.addEventListener("scroll", this._onScroll, { passive: true });
        window.addEventListener("resize", this._onResize, { passive: true });
        this._refreshThresholds();
        this._update();
    };
    BundleScrollTrigger.prototype._onResize = function () {
        this._thresholdsDirty = true;
        this._onScroll();
    };
    // CORRECTION: the original allocated a fresh closure on EVERY scroll event.
    BundleScrollTrigger.prototype._onScroll = function () {
        if (this.ticking) return;
        this.ticking = true;
        if (typeof requestAnimationFrame !== "undefined") {
            this._rafId = requestAnimationFrame(this._rafTick);
        } else {
            this._rafTick();
        }
    };
    BundleScrollTrigger.prototype._rafTick = function () {
        this._rafId = null;
        this._update();
        this.ticking = false;
    };
    // CORRECTION: `parseThreshold` was redefined inside `_update`, allocating a
    // closure plus two `String().split(" ")` arrays on every scroll frame. It is
    // now a prototype method whose results are cached until a resize.
    BundleScrollTrigger.prototype._parseThreshold = function (str, vh, isTop) {
        if (typeof str === "number") return str;
        var parts = String(str).split(" ");
        var token = parts[1];
        if (token === undefined || token === "") return vh * (isTop ? 0.85 : 0.15);
        var last = token.charCodeAt(token.length - 1);
        if (last === 37) return (parseFloat(token) / 100) * vh;      // '%'
        if (token.length >= 2 &&
            token.charCodeAt(token.length - 1) === 120 &&
            token.charCodeAt(token.length - 2) === 112) {            // 'px'
            return parseFloat(token);
        }
        if (token === "top") return 0;
        if (token === "center") return vh * 0.5;
        if (token === "bottom") return vh;
        var pct = parseFloat(token);
        return isNaN(pct) ? vh * (isTop ? 0.85 : 0.15) : (pct / 100) * vh;
    };
    BundleScrollTrigger.prototype._refreshThresholds = function () {
        if (typeof window === "undefined") return;
        this._vh = window.innerHeight;
        this._startPx = this._parseThreshold(this.start, this._vh, true);
        this._endPx = this._parseThreshold(this.end, this._vh, false);
        this._thresholdsDirty = false;
    };
    BundleScrollTrigger.prototype._update = function () {
        if (!this.target || typeof window === "undefined") return;
        if (this._thresholdsDirty) this._refreshThresholds();
        var rect = this.target.getBoundingClientRect();
        var scrollY = window.pageYOffset || document.documentElement.scrollTop;
        this.direction = scrollY >= this.lastScrollPos ? 1 : -1;
        this.lastScrollPos = scrollY;
        var startTrigger = this._startPx;
        var endTrigger = this._endPx;
        // Bundle math preserved verbatim.
        var totalDistance = (rect.height + (startTrigger - endTrigger)) || 1;
        var currentDistance = startTrigger - rect.top;
        var p = clamp(currentDistance / totalDistance, 0, 1);
        this.progress = p;
        var currentlyInView = rect.top <= startTrigger && rect.bottom >= endTrigger;
        if (currentlyInView && !this.isInView) {
            this.isInView = true;
            if (this.direction === 1 && this.onEnter) this.onEnter(this);
            if (this.direction === -1 && this.onEnterBack) this.onEnterBack(this);
            if (!this.sync && this.animation) this.animation.restart();
        } else if (!currentlyInView && this.isInView) {
            this.isInView = false;
            if (this.direction === 1 && this.onLeave) this.onLeave(this);
            if (this.direction === -1 && this.onLeaveBack) this.onLeaveBack(this);
        }
        if (this.sync && this.animation) this.animation.seek(p);
        if (this.onUpdate) this.onUpdate(p, this);
    };
    BundleScrollTrigger.prototype.invalidate = function () {
        this._thresholdsDirty = true;
        return this;
    };
    BundleScrollTrigger.prototype.destroy = function () {
        if (typeof window !== "undefined") {
            window.removeEventListener("scroll", this._onScroll);
            window.removeEventListener("resize", this._onResize);
            if (this._rafId !== null && typeof cancelAnimationFrame !== "undefined") {
                cancelAnimationFrame(this._rafId);
            }
        }
        this._rafId = null;
        this.ticking = false;
        if (this.animation) this.animation.pause();
    };
    function bundleOnScroll(config) { return new BundleScrollTrigger(config); }

    // ---- BUNDLE DRAGGABLE: preserves `els.map(...)` return shape ----
    // CORRECTION: plain loop instead of a `.map` closure, and the teardown
    // handles returned by the corrected `draggable` are now retained so the
    // listeners can actually be removed (additive `destroy()` on the array).
    function bundleDraggable(target, opts) {
        opts = opts || {};
        var els = toArray(target);
        var out = new Array(els.length);
        var handles = [];
        for (var i = 0; i < els.length; i++) {
            out[i] = undefined; // original returned an array of undefined
            var h = draggableModule.draggable(els[i], opts);
            if (h && typeof h.destroy === "function") handles.push(h);
        }
        out.destroy = function () {
            for (var j = 0; j < handles.length; j++) handles[j].destroy();
            handles.length = 0;
        };
        return out;
    }

    // ==========================================================================
    // 2. LEGACY API COMPOSITION (byte-compatible)
    // ==========================================================================
    function animateFactory(config) { return new Animation(config); }
    function timelineFactory(config) {
        var m = getTimelineModule();
        if (!m) throw new Error("StudioMotion.timeline requires the timeline module to be loaded");
        return new m.Timeline(config);
    }
    function timerFactory(config) { return new BundleTimer(config); }

    var legacyUtils = {
        clamp: clamp,
        lerp: utils.lerp,
        mapRange: utils.mapRange,
        random: utils.random,
        randomInt: utils.randomInt,
        stagger: utils.stagger,
        toArray: toArray,
        parseColor: utils.parseColor,
        calcRelativeValue: utils.calcRelativeValue,
        decomposeValue: utils.decomposeValue,
        interpolateDecomposed: utils.interpolateDecomposed
    };

    var recipes = recipesModule.recipes;
    function bundleSpring(target, opts) { return recipes.letterSplit(target, opts); }
    function bundleShake(target, opts) { return recipes.bellWiggle(target, opts); }
    function bundleFlip(target, opts) { return recipes.flip180(target, opts); }
    function bundleTilt(target, opts) { return recipes.tilt3D(target, opts); }
    function bundleModal(target, opts) { return recipes.modalDrop(target, opts); }
    function bundleDraw(target, opts) { return svgModule.svg.createDrawable(target, opts); }
    function bundleScramble(target, endText, opts) { return textModule.text.scramble(target, endText, opts); }
    function bundleMorph(p1, p2, opts) { return svgModule.svg.morphTo(p1, p2, opts); }
    function bundleMagnet(target, container, opts) { return recipes.cursorMagnet(target, container, opts); }
    function bundleGridRipple(targets, opts) { return recipes.gridRipple(targets, opts); }
    function bundleSwarm(targets, opts) { return recipes.fireflySwarm(targets, opts); }
    function bundleTypewriter(target, endText, opts) { return recipes.typewriterHuman(target, endText, opts); }

    // ==========================================================================
    // 3. NAMESPACES (new 3D-first features)
    // ==========================================================================

    // ---- SOA builders ----
    var SOA = {
        vec2: vec2.createVec2SOA,
        vec3: vec3.createVec3SOA,
        vec4: vec4.createVec4SOA,
        quat: quat.createQuatSOA,
        quat2: quat2.createQuat2SOA,
        mat2: mat2.createMat2SOA,
        mat3: mat3.createMat3SOA,
        mat4: mat4.createMat4SOA,
        color: vec4.createVec4SOA,
        double: double.createDoubleSOA,
        transform: function (n) {
            var t = {
                position: vec3.createVec3SOA(n),
                rotation: quat.createQuatSOA(n),
                scale: vec3.createVec3SOA(n)
            };
            t.scale.x.fill(1); t.scale.y.fill(1); t.scale.z.fill(1);
            return t;
        }
    };

    // ---- Pools ----
    // CORRECTION: timeline pool accessors are resolved lazily so a missing
    // timeline module no longer yields `undefined` function references.
    var POOLS = {
        create: glMatrix.createPool,
        vec2: vec2.createVec2Pool,
        vec3: vec3.createVec3Pool,
        vec4: vec4.createVec4Pool,
        quat: quat.createQuatPool,
        quat2: quat2.createQuat2Pool,
        mat2: mat2.createMat2Pool,
        mat3: mat3.createMat3Pool,
        mat4: mat4.createMat4Pool,
        double: double.createDoublePool,
        acquireAnimation: animationModule.acquireAnimation,
        releaseAnimation: animationModule.releaseAnimation,
        acquireTimer: timerModule.acquireTimer,
        releaseTimer: timerModule.releaseTimer,
        acquireTimeline: function (config) {
            var m = getTimelineModule();
            if (!m || !m.acquireTimeline) throw new Error("pool.acquireTimeline requires the timeline module");
            return m.acquireTimeline(config);
        },
        releaseTimeline: function (tl) {
            var m = getTimelineModule();
            if (!m || !m.releaseTimeline) throw new Error("pool.releaseTimeline requires the timeline module");
            return m.releaseTimeline(tl);
        },
        acquireDouble: double.acquire,
        releaseDouble: double.release
    };

    // ---- Chunked / mobile-safe iteration ----
    async function soaStepAsync(soa, fn, chunkSize, yieldEvery) {
        chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
        yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
        var n = soa.count, c = 0;
        for (var start = 0; start < n; start += chunkSize) {
            var end = Math.min(start + chunkSize, n);
            for (var i = start; i < end; i++) fn(i, soa);
            if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
        }
        return soa;
    }
    var CHUNKED = {
        yield: glMatrix.yieldToMain,
        forEach: glMatrix.forEachChunked,
        soaStep: soaStepAsync,
        workerPool: glMatrix.createWorkerPool
    };

    // ---- Namespace shims for module APIs that do not exist ----
    // CORRECTION: `vec2.soaFillFBM2D`, `vec4.soaFillFBM4D` and `mat4.soaTranspose`
    // were referenced but never exported by their modules (undefined values in
    // the namespace). Correct equivalents / local implementations are provided.
    function fillFBM2DShim(soa, scale, octaves) {
        return vec2.soaFillNoise2D(soa, scale, octaves, "fbm");
    }
    function fillFBM2DShimChunked(soa, scale, octaves, chunkSize, yieldEvery) {
        return vec2.soaFillNoise2DChunked(soa, scale, octaves, "fbm", chunkSize, yieldEvery);
    }
    function fillFBM4DShim(soa, scale, timeStep, octaves) {
        return vec4.soaFillNoise4D(soa, scale, timeStep, octaves);
    }
    function fillFBM4DShimChunked(soa, scale, timeStep, octaves, chunkSize, yieldEvery) {
        return vec4.soaFillNoise4DChunked(soa, scale, timeStep, octaves, chunkSize, yieldEvery);
    }
    /** Zero-GC per-instance mat4 transpose (module has no SOA transpose). */
    function soaTransposeMat4(out, a) {
        var O = out.arrays, A = a.arrays, n = out.count;
        for (var i = 0; i < n; i++) {
            var a01 = A[1][i], a02 = A[2][i], a03 = A[3][i];
            var a12 = A[6][i], a13 = A[7][i], a23 = A[11][i];
            O[0][i] = A[0][i]; O[1][i] = A[4][i]; O[2][i] = A[8][i]; O[3][i] = A[12][i];
            O[4][i] = a01; O[5][i] = A[5][i]; O[6][i] = A[9][i]; O[7][i] = A[13][i];
            O[8][i] = a02; O[9][i] = a12; O[10][i] = A[10][i]; O[11][i] = A[14][i];
            O[12][i] = a03; O[13][i] = a13; O[14][i] = a23; O[15][i] = A[15][i];
        }
        return out;
    }
    /**
     * Safe hue rotation over vec4 SOAs. Blueprint Snippet 52's call site passes
     * the same buffer three times, which destructively overwrites channels;
     * this wrapper always passes distinct channels.
     */
    function soaHueRotateSOA(outColors, baseColors, angleRad) {
        return mat2.soaHueRotateChroma(
            outColors.y, outColors.z, outColors.x,
            baseColors.y, baseColors.z, baseColors.x,
            angleRad
        );
    }

    // ---- Procedural generation ----
    var PROCEDURAL = {
        // Noise — full generators
        simplex2D: simplex.createNoise2D,
        simplex3D: simplex.createNoise3D,
        simplex4D: simplex.createNoise4D,
        acquireSimplex2D: simplex.acquireNoise2D,
        acquireSimplex3D: simplex.acquireNoise3D,
        acquireSimplex4D: simplex.acquireNoise4D,
        // Noise — direct sampling
        value2D: vec2.valueNoise2D,
        value3D: vec3.valueNoise3D,
        value4D: vec4.valueNoise4D,
        gradient2D: vec2.gradientNoise2D,
        gradient3D: vec3.gradientNoise3D,
        fbm2D: vec2.fbm2D,
        fbm3D: vec3.fbm3D,
        fbm4D: vec4.fbm4D,
        turbulence4D: vec4.turbulence4D,
        voronoi2D: vec2.voronoi2D,
        voronoi3D: vec3.voronoi3D,
        // SOA fills (sync)
        fill2D: vec2.soaFillNoise2D,
        fill3D: vec3.soaFillNoise3D,
        fill4D: vec4.soaFillNoise4D,
        fillFBM2D: fillFBM2DShim,
        fillFBM3D: vec3.soaFillNoise3D,
        fillFBM4D: fillFBM4DShim,
        // SOA fills — simplex-backed (higher quality)
        fillNoise3DSimplex: simplex.soaFillNoise3D,
        fillFBM3DSimplex: simplex.soaFillFBM3D,
        fillTurbulence3D: simplex.soaFillTurbulence3D,
        fillRidged3D: simplex.soaFillRidged3D,
        fillWarped3D: simplex.soaFillWarped3D,
        fillCurl3D: simplex.soaFillCurl3D,
        fillGradient3D: simplex.soaFillGradient3D,
        // Chunked variants
        fill2DChunked: vec2.soaFillNoise2DChunked,
        fill3DChunked: vec3.soaFillNoise3DChunked,
        fill4DChunked: vec4.soaFillNoise4DChunked,
        fillFBM2DChunked: fillFBM2DShimChunked,
        fillFBM3DChunked: vec3.soaFillNoise3DChunked,
        fillFBM4DChunked: fillFBM4DShimChunked,
        fillFBM3DSimplexChunked: simplex.soaFillFBM3DChunked,
        fillTurbulence3DChunked: simplex.soaFillTurbulence3DChunked,
        fillRidged3DChunked: simplex.soaFillRidged3DChunked,
        fillCurl3DChunked: simplex.soaFillCurl3DChunked,
        fillGradient3DChunked: simplex.soaFillGradient3DChunked,
        // bitECS scatter
        scatter: bitecs.scatterEntities,
        scatterChunked: bitecs.scatterEntitiesChunked,
        scatterOrbital: bitecs.spawnOrbitalBodies,
        // Deterministic hash / PRNG
        hash2: glMatrix.hash2,
        hash3: glMatrix.hash3,
        hash4: glMatrix.hash4,
        mulberry32: glMatrix.mulberry32,
        xorshift32: glMatrix.xorshift32,
        splitmix32: glMatrix.splitmix32,
        // Double-precision noise
        value3D_64: double.valueNoise3D_64,
        hash3_64: double.hash3_64
    };

    // ---- Rendering ----
    var RENDER = {
        // Instancing
        createBatch: bitecs.createInstanceBatch,
        // TRS → mat4
        composeTRS: mat4.soaComposeTRS,
        composeTRSChunked: mat4.soaComposeTRSChunked,
        // Point transforms
        transformPoint: mat4.soaTransformPoint,
        transformPointChunked: mat4.soaTransformPointChunked,
        transformPointPerspective: mat4.soaTransformPointPerspective,
        // TBN
        buildTBN: mat3.buildTBN,
        buildTBNSOA: mat3.soaBuildTBN,
        buildTBNSOAChunked: mat3.soaBuildTBNChunked,
        // Matrix ops
        multiply: mat4.soaMultiply,
        multiplyChunked: mat4.soaMultiplyChunked,
        invert: mat4.soaInvert,
        invertChunked: mat4.soaInvertChunked,
        transpose: soaTransposeMat4,
        transposeMat3: mat3.soaTranspose,
        // Projection / camera
        perspective: mat4.perspectiveNO,
        perspectiveZO: mat4.perspectiveZO,
        ortho: mat4.orthoNO,
        orthoZO: mat4.orthoZO,
        frustum: mat4.frustum,
        lookAt: mat4.lookAt,
        targetTo: mat4.targetTo,
        fromWorldBoundsNDC: mat4.fromWorldBoundsNDC,
        // Normal matrices
        normalFromMat4: mat3.normalFromMat4,
        // Decompose
        decompose: mat4.soaDecompose,
        // AABB
        aabb: vec3.soaAABB,
        // Per-instance rotation / scale fields
        fillFromNoise: mat3.soaFillFromNoise,
        fillFromNoiseChunked: mat3.soaFillFromNoiseChunked,
        fillRotationFromNoise: mat2.soaFillRotationFromNoise,
        fillTRSFromNoise: mat4.soaFillTRSFromNoise,
        fillTRSFromNoiseChunked: mat4.soaFillTRSFromNoiseChunked,
        // Flat upload helper (dirty-range aware)
        toFlat: mat4.soaToFlat
    };

    // ---- Color ----
    var COLOR = {
        // Conversions
        srgb8ToLinear: utils.srgb8ToLinear,
        linearToSrgb8: utils.linearToSrgb8,
        srgbToLinear: glMatrix.srgbToLinear,
        linearToSrgb: glMatrix.linearToSrgb,
        hslToRgb: glMatrix.hslToRgb,
        rgbToHsl: glMatrix.rgbToHsl,
        hsvToRgb: glMatrix.hsvToRgb,
        rgbToHsv: glMatrix.rgbToHsv,
        hexToRgb: glMatrix.hexToRgb,
        rgbToHex: glMatrix.rgbToHex,
        // HDR
        expose: utils.exposeColor,
        reinhard: utils.reinhardColor,
        aces: utils.acesColor,
        acesToneMap: vec3.acesToneMap,
        reinhardToneMap: vec3.reinhardToneMap,
        acesToneMapSOA: double.acesToneMapSOA,
        // Packing
        pack: utils.packColorRGBA,
        unpack: utils.unpackColorRGBA,
        packVec3: vec3.packRGB,
        unpackVec3: vec3.unpackRGB,
        css: utils.cssColor,
        // SOA batch
        soaFill: vec4.soaFillColor,
        soaExpose: vec4.soaExpose,
        soaSrgbToLinear: vec4.soaSrgbToLinear,
        soaLinearToSrgb: vec4.soaLinearToSrgb,
        soaApplyMatrix: mat3.soaApplyColorMatrix,
        // Raw 6-channel chroma rotation (outCb,outCr,outY,inCb,inCr,inY,rad)
        soaHueRotateChroma: mat2.soaHueRotateChroma,
        // Safe vec4-SOA wrapper (distinct channels, never aliases)
        soaHueRotate: soaHueRotateSOA,
        // Grading matrices
        fromSaturation: mat3.fromSaturation,
        fromGrayscale: mat3.fromGrayscale,
        fromHueRotation: mat3.fromHueRotation,
        fromChannelMix: mat3.fromChannelMix,
        LUMA_R709: mat3.LUMA_R709,
        LUMA_G709: mat3.LUMA_G709,
        LUMA_B709: mat3.LUMA_B709
    };

    // ---- IK / natural motion ----
    var IK = {
        fabrikStep: vec3.fabrikStep3,
        ccdStep: vec3.ccdStep3,
        lookAtBasis: vec3.lookAtBasis,
        fromJointTransform: mat4.fromJointTransform,
        soaFromJointTransform: mat4.soaFromJointTransform,
        lookAtQuat: quat.lookAt,
        springLookAt: quat.springLookAt,
        soaLookAtQuat: quat.soaLookAt,
        lookAtDQ: quat2.lookAtDQ,
        soaLookAtDQ: quat2.soaLookAtDQ,
        springDamp3: vec3.springDamp3,
        createTargetAnimation: animationModule.createIKTargetAnimation,
        attachDrag: draggableModule.attachIKDrag,
        fromBoneDirection: mat3.fromBoneDirection
    };

    // ---- Orbital ----
    var ORBITAL = {
        // Kepler solver
        keplerSolve: glMatrix.keplerSolve,
        eccentricToTrue: glMatrix.eccentricToTrue,
        meanToTrue: glMatrix.meanToTrue,
        keplerSolveDouble: double.keplerSolve2,
        keplerSolveDoubleExact: double.keplerSolve2Exact,
        // Position / velocity
        orbit2D: vec2.keplerOrbit2D,
        orbit3D: vec3.keplerOrbit3D,
        velocity3D: vec3.keplerOrbitVelocity3D,
        speed: vec3.orbitalSpeed3D,
        // Manoeuvres
        hohmann: vec3.hohmannTransfer,
        sphereOfInfluence: vec3.sphereOfInfluence,
        // Epoch advance (1M+ bodies)
        createEpoch: timerModule.createOrbitalEpoch,
        integrateDouble: double.integrateOrbitSOA,
        // Orientation
        fromInclination: quat.fromInclination,
        fromOrbitalElementsQuat: quat.fromOrbitalElements,
        soaFromOrbitalElementsQuat: quat.soaFromOrbitalElements,
        fromOrbitalElementsDQ: quat2.fromOrbitalElements,
        soaFromOrbitalElementsDQ: quat2.soaFromOrbitalElements,
        fromOrbitalElementsMat4: mat4.fromOrbitalElements,
        soaFromOrbitalElementsMat4: mat4.soaFromOrbitalElements,
        soaFromOrbitalElementsMat4Chunked: mat4.soaFromOrbitalElementsChunked,
        fromVelocityTranslation: quat2.fromVelocityTranslation,
        soaFromVelocityTranslation: quat2.soaFromVelocityTranslation,
        soaFromVelocityTranslationChunked: quat2.soaFromVelocityTranslationChunked
    };

    // ---- bitECS world ----
    var WORLD = {
        create: bitecs.createWorld,
        reset: bitecs.resetWorld,
        delete: bitecs.deleteWorld,
        addEntity: bitecs.addEntity,
        removeEntity: bitecs.removeEntity,
        addComponent: bitecs.addComponent,
        addComponents: bitecs.addComponents,
        removeComponent: bitecs.removeComponent,
        hasComponent: bitecs.hasComponent,
        getComponent: bitecs.getComponent,
        setComponent: bitecs.setComponent,
        query: bitecs.query,
        registerComponent: bitecs.registerComponent,
        registerComponents: bitecs.registerComponents,
        observe: bitecs.observe,
        createRelation: bitecs.createRelation,
        getRelationTargets: bitecs.getRelationTargets,
        Pair: bitecs.Pair,
        Wildcard: bitecs.Wildcard,
        Prefab: bitecs.Prefab,
        getAllEntities: bitecs.getAllEntities,
        // Systems
        createAnimationSystem: bitecs.createAnimationSystem,
        createIKSystem: bitecs.createIKSystem,
        createOrbitalSystem: bitecs.createOrbitalSystem,
        createColorSystem: bitecs.createColorSystem,
        createFloatingOrigin: bitecs.createFloatingOrigin,
        createSpatialGrid: bitecs.createSpatialGrid,
        // Serialization
        serializeScene: serialization.serializeScene,
        deserializeScene: serialization.deserializeScene,
        createSnapshot: serialization.createSnapshotSerializer,
        createRestore: serialization.createSnapshotDeserializer,
        createByteWriter: serialization.createByteWriter,
        createByteReader: serialization.createByteReader,
        // Chunked
        iterChunked: bitecs.iterChunked,
        queryChunked: bitecs.queryChunked
    };

    // ---- Double precision ----
    var DOUBLE = {
        Double: double.Double,
        SOA: double.createDoubleSOA,
        fromFloat32: double.soaFromFloat32,
        add22: double.soaAdd22,
        sub22: double.soaSub22,
        mul22: double.soaMul22,
        div22: double.soaDiv22,
        sqrt2: double.soaSqrt2,
        keplerSolve: double.keplerSolve2,
        keplerSolveExact: double.keplerSolve2Exact,
        integrateOrbit: double.integrateOrbitSOA,
        attachPrecision: double.attachHighPrecisionPositions,
        setWorldPos: double.setWorldPosition,
        getWorldPos: double.getWorldPosition,
        worldToF32: double.worldToFloat32,
        f32ToWorld: double.float32ToWorld,
        recenter: double.recenterWorld,
        fabrik: double.fabrikStep3_precise,
        springDamp: double.springDamp2
    };

    // ---- Raw math modules ----
    var MATH = {
        common: glMatrix,
        utils: utils,
        easings: easings,
        engine: engineModule,
        animation: animationModule,
        timer: timerModule,
        scope: scopeModule,
        text: textModule,
        svg: svgModule,
        scroll: scrollModule,
        draggable: draggableModule,
        adapters: adaptersModule,
        recipes: recipesModule,
        vec2: vec2, vec3: vec3, vec4: vec4,
        mat2: mat2, mat3: mat3, mat4: mat4,
        quat: quat, quat2: quat2,
        bitecs: bitecs, simplex: simplex,
        serialization: serialization, double: double,
        get timeline() { return getTimelineModule(); }
    };

    // ==========================================================================
    // 4. CREATE SCENE — one-call bootstrap for 1M+ instanced worlds
    // ==========================================================================
    /**
     * Single-pass TRS compose straight into an interleaved mat4 Float32Array.
     * Avoids the intermediate mat4 SOA and the second copy pass.
     */
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

    function createScene(config) {
        config = config || {};
        var count = config.count || 1024;
        var world = bitecs.createWorld();
        var ownsEngine = !!config.engine;
        var engine = config.engine || GlobalEngine;
        var trs = SOA.transform(count);
        var colors = vec4.createVec4SOA(count);
        var matrices = mat4.createMat4SOA(count);
        var velocities = vec3.createVec3SOA(count);
        var eids = new Uint32Array(count);
        // CORRECTION: default colour is opaque white. Zero-initialised alpha
        // rendered every instance fully transparent.
        colors.x.fill(1); colors.y.fill(1); colors.z.fill(1); colors.w.fill(1);
        for (var i = 0; i < count; i++) eids[i] = bitecs.addEntity(world);

        // CORRECTION: `scatter` previously spawned a SECOND set of entities and
        // threw away its SOAs, leaving the scene at the origin with 2× entities.
        // It now reuses the pre-created eids and copies into the scene buffers.
        if (config.scatter) {
            var spawnIdx = 0;
            var scatterOpts = {};
            for (var sk in config.scatter) scatterOpts[sk] = config.scatter[sk];
            scatterOpts.spawn = function () { return eids[spawnIdx++]; };
            var res = bitecs.scatterEntities(world, count, scatterOpts);
            trs.position.x.set(res.position.x);
            trs.position.y.set(res.position.y);
            trs.position.z.set(res.position.z);
            trs.rotation.x.set(res.rotation.x);
            trs.rotation.y.set(res.rotation.y);
            trs.rotation.z.set(res.rotation.z);
            trs.rotation.w.set(res.rotation.w);
            trs.scale.x.set(res.scale.x);
            trs.scale.y.set(res.scale.y);
            trs.scale.z.set(res.scale.z);
        }

        var origin = config.origin || null;
        var ownedSteps = [];

        var scene = {
            world: world,
            engine: engine,
            count: count,
            eids: eids,
            trs: trs,
            colors: colors,
            matrices: matrices,
            velocities: velocities,
            /** Fill the mat4 SOA (for consumers that read `matrices`). */
            compose: function () {
                return mat4.soaComposeTRS(matrices, trs.position, trs.rotation, trs.scale);
            },
            composeChunked: function (cs, ye) {
                return mat4.soaComposeTRSChunked(matrices, trs.position, trs.rotation, trs.scale, cs, ye);
            },
            /**
             * Upload straight into the InstancedMesh backing array with
             * dirty-range tracking (Blueprint Snippets 25 / 28). Single pass,
             * no intermediate SOA, floating-origin aware.
             */
            uploadTo: function (mesh) {
                if (!mesh || !mesh.instanceMatrix || !mesh.instanceMatrix.array) return;
                var ox = origin ? origin[0] : 0;
                var oy = origin ? origin[1] : 0;
                var oz = origin ? origin[2] : 0;
                _composeTRSIntoFlat(mesh.instanceMatrix.array, trs, count, ox, oy, oz);
                _flagInstanceUpload(mesh, count);
            },
            setOrigin: function (x, y, z) {
                if (!origin) origin = new Float64Array(3);
                origin[0] = x; origin[1] = y; origin[2] = z;
            },
            /** Register a scene-owned SOA step (removed on dispose). */
            addStep: function (fn, name) {
                var entry = engine.addSoaStep(fn, name);
                ownedSteps.push(entry);
                return entry;
            },
            /** Scene step hook — the RAF loop drives the engine, not this. */
            step: function (dtSec) {
                for (var s = 0; s < ownedSteps.length; s++) {
                    var e = ownedSteps[s];
                    if (e.enabled) e.fn(dtSec, engine.lastTime);
                }
                return scene;
            },
            dispose: function () {
                for (var s = 0; s < ownedSteps.length; s++) engine.removeSoaStep(ownedSteps[s]);
                ownedSteps.length = 0;
                bitecs.deleteWorld(world);
                // CORRECTION: never destroy the shared GlobalEngine singleton.
                if (ownsEngine && engine.destroy) engine.destroy();
            }
        };
        return scene;
    }

    // ==========================================================================
    // 5. PUBLIC COMPOSED API
    // ==========================================================================
    var StudioMotion = {
        version: "3.0.0",
        // ---- Legacy factories ----
        animate: animateFactory,
        timeline: timelineFactory,
        timer: timerFactory,
        // ---- Legacy object helpers ----
        animatable: bundleAnimatable,
        draggable: bundleDraggable,
        layout: bundleLayout,
        scope: bundleScope,
        // ---- Legacy namespaces ----
        svg: svgModule.svg,
        text: textModule.text,
        onScroll: bundleOnScroll,
        scrollTrigger: bundleOnScroll,
        ScrollTriggerInstance: BundleScrollTrigger,
        // ---- Legacy adapters ----
        waapi: adaptersModule.waapi,
        animateThree: adaptersModule.animateThree,
        adapters: adaptersModule.adapters,
        // ---- Legacy engine + values ----
        engine: GlobalEngine,
        easings: easings.easings,
        utils: legacyUtils,
        stagger: utils.stagger,
        recipes: recipes,
        presets: recipes,
        // ---- Legacy short aliases ----
        spring: bundleSpring,
        shake: bundleShake,
        flip: bundleFlip,
        tilt: bundleTilt,
        modal: bundleModal,
        draw: bundleDraw,
        scramble: bundleScramble,
        morph: bundleMorph,
        magnet: bundleMagnet,
        gridRipple: bundleGridRipple,
        swarm: bundleSwarm,
        typewriter: bundleTypewriter,
        // ---- NEW: unified scene bootstrap ----
        createScene: createScene,
        // ---- NEW: 3D-first namespaces ----
        soa: SOA,
        pool: POOLS,
        chunked: CHUNKED,
        procedural: PROCEDURAL,
        render: RENDER,
        color: COLOR,
        ik: IK,
        orbital: ORBITAL,
        world: WORLD,
        double: DOUBLE,
        math: MATH
    };
    return StudioMotion;
});