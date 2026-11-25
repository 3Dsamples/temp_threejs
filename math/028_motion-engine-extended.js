//File number : 028
// File : src/math/028_motion-engine-extended.js
//Description : Full extended motion engine. Preserves every original export from motion-engine.cjs byte-compatible, and adds: a complete `Generic_To_Any_Shape` morph system (any primitive / SVG path / point cloud / SVG element → any other), `ShapePrimitive` (circle/ellipse/rect/square/triangle/star/polygon/pentagon/hexagon/octagon/line/points), `ShapeSampler` (uniform / arc-length / angular strategies), `MorphTrack`, `SOAMorphGroup` (1M+ instanced shape morphing), `KeyframeTrack`, `AnimationStateMachine`, `BlendTree`, and `FullAnimationSystem` orchestrator — all integrated into the existing UMD `StudioMotion` global with mobile-safe async stepping.
//####
//Best for : 3d graphics — morphing any shape to any other shape (circle↔star, logo↔logo, icon↔icon, primitive↔custom path, complex SVG↔complex SVG) on any number of instances; state-machine-driven character or UI animation; keyframe tracks for arbitrary numeric properties (position, opacity, HDR colors, quaternions via arrays); blend trees for locomotion / expression blending; 1M+ instanced shape morphing on GPU-fed SOAs (e.g. 1M asteroid silhouette morphs), HDR color morphing alongside geometry; bitECS-integrated animation with chunked async stepping that never freezes the Android UI thread; full backward compatibility with all recipes / easings / utils / svg / text / scroll / draggable / adapters helpers.
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
        global.GenericToAnyShape = global.StudioMotion.GenericToAnyShape;
        global.ShapePrimitive = global.StudioMotion.ShapePrimitive;
        global.ShapeSampler = global.StudioMotion.ShapeSampler;
        global.MorphTrack = global.StudioMotion.MorphTrack;
        global.SOAMorphGroup = global.StudioMotion.SOAMorphGroup;
        global.KeyframeTrack = global.StudioMotion.KeyframeTrack;
        global.AnimationStateMachine = global.StudioMotion.AnimationStateMachine;
        global.BlendTree = global.StudioMotion.BlendTree;
        global.FullAnimationSystem = global.StudioMotion.FullAnimationSystem;
    }
})(this, function () {
    // CORRECTION: `"use strict "` (trailing space) is NOT a valid directive
    // prologue — the whole bundle silently ran in sloppy mode.
    "use strict";

    // ====================================================================
    // 1. IMPORTS — numbered filenames, no trailing spaces
    // CORRECTION: every require path in the original had a trailing space
    // (e.g. "./common.js "), which resolves to a different filename on
    // case-sensitive filesystems and breaks module loading entirely.
    // ====================================================================
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
    var easeMap = easings.easings;

    // CORRECTION: the timeline module was required eagerly, so the bundle
    // threw at load time when it was absent. Resolved lazily + optionally.
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

    // ====================================================================
    // 2. TYPE DECLARATIONS (JSDoc)
    // ====================================================================
    /**
     * @typedef {Object} Point2D
     * @property {number} x
     * @property {number} y
     */
    /**
     * @typedef {Object|string|Array|SVGElement} ShapeSource
     */
    /**
     * @typedef {Object} MorphOptions
     * @property {number} [sampleCount=128]
     * @property {'uniform'|'arcLength'|'angular'} [strategy='uniform']
     * @property {string|Function} [easing='linear']
     * @property {boolean} [closed=true]
     */
    /**
     * @typedef {Object} Keyframe
     * @property {number} time
     * @property {number|number[]|string} value
     * @property {string|Function} [easing='linear']
     */

    // ====================================================================
    // 3. CONSTANTS / SHARED SCRATCH (Zero-GC)
    // ====================================================================
    var TAU = Math.PI * 2;
    var DEFAULT_SAMPLE_COUNT = 128;
    var DEFAULT_STRATEGY = "uniform";
    var NUMERIC_EPSILON = 1e-9;
    var MAX_DELTA_MS = 64;
    var MAX_FRAME_DT = 0.25;

    var _shapeScratch = [];
    var _centroidScratch = { x: 0, y: 0 };

    // ====================================================================
    // 4. CLASS DECLARATIONS
    // ====================================================================

    // --------------------------------------------------------------------
    // 4.1 ShapePrimitive — factories that emit point arrays
    // CORRECTION: arrays are pre-sized instead of grown with push() in a
    // loop, and the per-call `edge` closure in rect() is hoisted.
    // --------------------------------------------------------------------
    function _emitSegment(pts, offset, x1, y1, x2, y2, samples) {
        for (var j = 0; j < samples; j++) {
            var t = j / samples;
            var p = pts[offset + j];
            if (!p) { p = pts[offset + j] = { x: 0, y: 0 }; }
            p.x = x1 + (x2 - x1) * t;
            p.y = y1 + (y2 - y1) * t;
        }
        return offset + samples;
    }

    class ShapePrimitive {
        static circle(cx, cy, r, segments) {
            segments = segments || 64;
            var pts = new Array(segments);
            for (var i = 0; i < segments; i++) {
                var a = (i / segments) * TAU;
                pts[i] = { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
            }
            return pts;
        }
        static ellipse(cx, cy, rx, ry, segments) {
            segments = segments || 64;
            var pts = new Array(segments);
            for (var i = 0; i < segments; i++) {
                var a = (i / segments) * TAU;
                pts[i] = { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry };
            }
            return pts;
        }
        static square(x, y, size, segmentsPerSide) {
            return ShapePrimitive.rect(x, y, size, size, segmentsPerSide);
        }
        static rect(x, y, w, h, segmentsPerSide) {
            segmentsPerSide = segmentsPerSide || 8;
            var pts = new Array(segmentsPerSide * 4);
            var o = 0;
            o = _emitSegment(pts, o, x, y, x + w, y, segmentsPerSide);
            o = _emitSegment(pts, o, x + w, y, x + w, y + h, segmentsPerSide);
            o = _emitSegment(pts, o, x + w, y + h, x, y + h, segmentsPerSide);
            o = _emitSegment(pts, o, x, y + h, x, y, segmentsPerSide);
            return pts;
        }
        static triangle(cx, cy, r, segmentsPerSide) {
            return ShapePrimitive.polygon(cx, cy, r, 3, segmentsPerSide || 12);
        }
        static polygon(cx, cy, r, sides, segmentsPerSide) {
            sides = sides || 6;
            segmentsPerSide = segmentsPerSide || 8;
            var pts = new Array(sides * segmentsPerSide);
            var o = 0;
            for (var i = 0; i < sides; i++) {
                var a1 = (i / sides) * TAU - Math.PI / 2;
                var a2 = ((i + 1) / sides) * TAU - Math.PI / 2;
                var x1 = cx + Math.cos(a1) * r, y1 = cy + Math.sin(a1) * r;
                var x2 = cx + Math.cos(a2) * r, y2 = cy + Math.sin(a2) * r;
                o = _emitSegment(pts, o, x1, y1, x2, y2, segmentsPerSide);
            }
            return pts;
        }
        static pentagon(cx, cy, r, segmentsPerSide) {
            return ShapePrimitive.polygon(cx, cy, r, 5, segmentsPerSide);
        }
        static hexagon(cx, cy, r, segmentsPerSide) {
            return ShapePrimitive.polygon(cx, cy, r, 6, segmentsPerSide);
        }
        static octagon(cx, cy, r, segmentsPerSide) {
            return ShapePrimitive.polygon(cx, cy, r, 8, segmentsPerSide);
        }
        static star(cx, cy, outerR, innerR, points, samplesPerSegment) {
            points = points || 5;
            innerR = innerR || outerR * 0.4;
            samplesPerSegment = samplesPerSegment || 4;
            var totalVerts = points * 2;
            var pts = new Array(totalVerts * samplesPerSegment);
            var o = 0;
            for (var i = 0; i < totalVerts; i++) {
                var a1 = (i / totalVerts) * TAU - Math.PI / 2;
                var a2 = ((i + 1) / totalVerts) * TAU - Math.PI / 2;
                var r1 = (i % 2 === 0) ? outerR : innerR;
                var r2 = (i % 2 === 0) ? innerR : outerR;
                var x1 = cx + Math.cos(a1) * r1, y1 = cy + Math.sin(a1) * r1;
                var x2 = cx + Math.cos(a2) * r2, y2 = cy + Math.sin(a2) * r2;
                o = _emitSegment(pts, o, x1, y1, x2, y2, samplesPerSegment);
            }
            return pts;
        }
        static line(x1, y1, x2, y2, segments) {
            segments = segments || 16;
            var pts = new Array(segments);
            for (var i = 0; i < segments; i++) {
                var t = segments > 1 ? i / (segments - 1) : 0;
                pts[i] = { x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t };
            }
            return pts;
        }
        static points(pts) {
            if (!pts || pts.length === 0) return [];
            if (typeof pts[0] === "number") {
                var n = (pts.length / 2) | 0;
                var out = new Array(n);
                for (var i = 0; i < n; i++) out[i] = { x: pts[i * 2], y: pts[i * 2 + 1] };
                return out;
            }
            var out2 = new Array(pts.length);
            for (var j = 0; j < pts.length; j++) out2[j] = { x: pts[j].x, y: pts[j].y };
            return out2;
        }
        static circleFlat(out, cx, cy, r, segments) {
            segments = segments || 64;
            for (var i = 0; i < segments; i++) {
                var a = (i / segments) * TAU;
                out[i * 2] = cx + Math.cos(a) * r;
                out[i * 2 + 1] = cy + Math.sin(a) * r;
            }
            return segments;
        }
    }

    // --------------------------------------------------------------------
    // 4.2 ShapeSampler
    // --------------------------------------------------------------------
    function _byAngle(a, b) { return a.angle - b.angle; }

    class ShapeSampler {
        constructor(source, options) {
            this.source = source;
            this.options = options || {};
            this._cache = null;
            this._cum = null;
        }
        sample(count) {
            count = count || this.options.sampleCount || DEFAULT_SAMPLE_COUNT;
            var strategy = this.options.strategy || DEFAULT_STRATEGY;
            var basePoints = this._resolve();
            if (!basePoints || basePoints.length === 0) return [];
            if (strategy === "arcLength") return this._sampleArcLength(basePoints, count);
            if (strategy === "angular") return this._sampleAngular(basePoints, count);
            return this._sampleUniform(basePoints, count);
        }
        sampleInto(out, count) {
            count = count || this.options.sampleCount || DEFAULT_SAMPLE_COUNT;
            var basePoints = this._resolve();
            if (!basePoints || basePoints.length === 0) return 0;
            var total = basePoints.length;
            var useArc = this.options.strategy === "arcLength";
            var cum = null, totalLen = 1;
            if (useArc) {
                if (!this._cum || this._cum.length < total + 1) this._cum = new Float32Array(total + 1);
                cum = this._cum;
                cum[0] = 0;
                for (var i = 0; i < total; i++) {
                    var nx = basePoints[(i + 1) % total];
                    var dx = nx.x - basePoints[i].x, dy = nx.y - basePoints[i].y;
                    cum[i + 1] = cum[i] + Math.sqrt(dx * dx + dy * dy);
                }
                totalLen = cum[total] || 1;
            }
            for (var k = 0; k < count; k++) {
                var ax, ay, bx, by, t;
                if (useArc) {
                    var target = (k / count) * totalLen;
                    var lo = 0, hi = total;
                    while (lo < hi - 1) {
                        var mid = (lo + hi) >> 1;
                        if (cum[mid] < target) lo = mid; else hi = mid;
                    }
                    var segLen = cum[lo + 1] - cum[lo] || 1;
                    t = (target - cum[lo]) / segLen;
                    var a = basePoints[lo], b = basePoints[(lo + 1) % total];
                    ax = a.x; ay = a.y; bx = b.x; by = b.y;
                } else {
                    var idx = (k / count) * total;
                    var l = Math.floor(idx);
                    var h = (l + 1) % total;
                    t = idx - l;
                    ax = basePoints[l].x; ay = basePoints[l].y;
                    bx = basePoints[h].x; by = basePoints[h].y;
                }
                out[k * 2] = ax + (bx - ax) * t;
                out[k * 2 + 1] = ay + (by - ay) * t;
            }
            return count;
        }
        _resolve() {
            if (this._cache) return this._cache;
            this._cache = resolveShapeSource(this.source);
            return this._cache;
        }
        _sampleUniform(points, count) {
            var out = new Array(count);
            var total = points.length;
            for (var i = 0; i < count; i++) {
                var idx = (i / count) * total;
                var lo = Math.floor(idx);
                var hi = (lo + 1) % total;
                var t = idx - lo;
                out[i] = {
                    x: points[lo].x + (points[hi].x - points[lo].x) * t,
                    y: points[lo].y + (points[hi].y - points[lo].y) * t
                };
            }
            return out;
        }
        _sampleArcLength(points, count) {
            var total = points.length;
            var cum = new Float32Array(total + 1);
            for (var i = 0; i < total; i++) {
                var next = (i + 1) % total;
                var dx = points[next].x - points[i].x;
                var dy = points[next].y - points[i].y;
                cum[i + 1] = cum[i] + Math.sqrt(dx * dx + dy * dy);
            }
            var totalLen = cum[total] || 1;
            var out = new Array(count);
            for (var k = 0; k < count; k++) {
                var target = (k / count) * totalLen;
                var lo = 0, hi = total;
                while (lo < hi - 1) {
                    var mid = (lo + hi) >> 1;
                    if (cum[mid] < target) lo = mid; else hi = mid;
                }
                var segmentLen = cum[lo + 1] - cum[lo] || 1;
                var t = (target - cum[lo]) / segmentLen;
                var a = points[lo];
                var b = points[(lo + 1) % total];
                out[k] = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
            }
            return out;
        }
        _sampleAngular(points, count) {
            var cx = 0, cy = 0, i;
            for (i = 0; i < points.length; i++) { cx += points[i].x; cy += points[i].y; }
            cx /= points.length; cy /= points.length;
            var sorted = new Array(points.length);
            for (i = 0; i < points.length; i++) {
                sorted[i] = { x: points[i].x, y: points[i].y, angle: Math.atan2(points[i].y - cy, points[i].x - cx) };
            }
            sorted.sort(_byAngle);
            var out = new Array(count);
            var minAngle = sorted[0].angle;
            var maxAngle = sorted[sorted.length - 1].angle;
            var span = (maxAngle - minAngle) || TAU;
            for (var k = 0; k < count; k++) {
                var target = minAngle + (k / count) * span;
                var lo = 0;
                while (lo < sorted.length - 1 && sorted[lo + 1].angle < target) lo++;
                var a = sorted[lo];
                var b = sorted[(lo + 1) % sorted.length];
                var dt = (b.angle - a.angle) || NUMERIC_EPSILON;
                var t = (target - a.angle) / dt;
                out[k] = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
            }
            return out;
        }
    }

    // --------------------------------------------------------------------
    // 4.3 GenericToAnyShape — the primary morph class
    // CORRECTION: interpolate() allocated a fresh Array + N point objects on
    // EVERY call. The point list and flat Float32Array are now pre-allocated.
    // --------------------------------------------------------------------
    class GenericToAnyShape {
        constructor(source, target, options) {
            options = options || {};
            this.options = options;
            this.sampleCount = options.sampleCount || DEFAULT_SAMPLE_COUNT;
            this.strategy = options.strategy || DEFAULT_STRATEGY;
            this.easing = typeof options.easing === "function"
                ? options.easing
                : (easeMap[options.easing || "linear"] || easeMap.linear);
            this.sourceSampler = new ShapeSampler(source, { sampleCount: this.sampleCount, strategy: this.strategy });
            this.targetSampler = new ShapeSampler(target, { sampleCount: this.sampleCount, strategy: this.strategy });
            this.sourcePoints = this.sourceSampler.sample(this.sampleCount);
            this.targetPoints = this.targetSampler.sample(this.sampleCount);
            if (this.sourcePoints.length !== this.targetPoints.length) {
                var min = Math.min(this.sourcePoints.length, this.targetPoints.length);
                this.sourcePoints.length = min;
                this.targetPoints.length = min;
                this.sampleCount = min;
            }
            this._pts = new Array(this.sampleCount);
            for (var i = 0; i < this.sampleCount; i++) this._pts[i] = { x: 0, y: 0 };
            this.flat = new Float32Array(this.sampleCount * 2);
        }
        interpolate(t) {
            t = clamp(this.easing(t), 0, 1);
            var n = this.sampleCount, pts = this._pts, flat = this.flat;
            for (var i = 0; i < n; i++) {
                var a = this.sourcePoints[i], b = this.targetPoints[i];
                var x = a.x + (b.x - a.x) * t;
                var y = a.y + (b.y - a.y) * t;
                var p = pts[i];
                p.x = x; p.y = y;
                flat[i * 2] = x; flat[i * 2 + 1] = y;
            }
            return pts;
        }
        interpolateFlat(out, t) {
            t = clamp(this.easing(t), 0, 1);
            var n = this.sampleCount;
            for (var i = 0; i < n; i++) {
                var a = this.sourcePoints[i], b = this.targetPoints[i];
                out[i * 2] = a.x + (b.x - a.x) * t;
                out[i * 2 + 1] = a.y + (b.y - a.y) * t;
            }
            return out;
        }
        toPathString(t, closed) {
            if (closed === undefined) closed = true;
            return buildShapePath(this.interpolate(t), closed);
        }
        toCanvasPath(ctx, t, closed) {
            if (closed === undefined) closed = true;
            var pts = this.interpolate(t);
            if (pts.length === 0) return;
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            if (closed) ctx.closePath();
        }
        applyTo(element, t) {
            if (!element) return;
            element.setAttribute("d", this.toPathString(t, this.options.closed !== false));
        }
        reverse() {
            var tmp = this.sourcePoints;
            this.sourcePoints = this.targetPoints;
            this.targetPoints = tmp;
            return this;
        }
        setSource(shape) {
            this.sourceSampler = new ShapeSampler(shape, { sampleCount: this.sampleCount, strategy: this.strategy });
            this.sourcePoints = this.sourceSampler.sample(this.sampleCount);
            return this;
        }
        setTarget(shape) {
            this.targetSampler = new ShapeSampler(shape, { sampleCount: this.sampleCount, strategy: this.strategy });
            this.targetPoints = this.targetSampler.sample(this.sampleCount);
            return this;
        }
    }

    // --------------------------------------------------------------------
    // 4.4 MorphTrack
    // --------------------------------------------------------------------
    class MorphTrack {
        constructor(morph, options) {
            options = options || {};
            this.morph = morph;
            this.duration = options.duration || 1000;
            this.loop = options.loop || false;
            this.pingPong = options.pingPong || false;
            this.timeScale = options.timeScale === undefined ? 1 : options.timeScale;
            this.currentTime = 0;
            this.target = options.target || null;
            this.onUpdate = options.onUpdate || null;
            this.onComplete = options.onComplete || null;
            this.progress = 0;
            this.isRunning = false;
            this._lastStepTime = 0;
        }
        step(dtMs) {
            if (!this.isRunning) return;
            this.currentTime += dtMs * this.timeScale;
            var t = this.duration > 0 ? this.currentTime / this.duration : 1;
            if (this.pingPong) { t = t % 2; if (t > 1) t = 2 - t; }
            else if (this.loop) { t = t % 1; }
            else if (t > 1) t = 1;
            this.progress = t;
            if (this.target) this.morph.applyTo(this.target, t);
            if (this.onUpdate) this.onUpdate(t, this);
            if (!this.loop && !this.pingPong && t >= 1) {
                this.isRunning = false;
                GlobalEngine.remove(this);
                if (this.onComplete) this.onComplete(this);
            }
        }
        play() {
            this.isRunning = true;
            this._lastStepTime = typeof performance !== "undefined" ? performance.now() : Date.now();
            GlobalEngine.add(this);
            return this;
        }
        pause() { this.isRunning = false; GlobalEngine.remove(this); return this; }
        restart() { this.currentTime = 0; this.progress = 0; return this.play(); }
        seek(t) {
            this.currentTime = t * this.duration;
            this.progress = t;
            if (this.target) this.morph.applyTo(this.target, t);
            if (this.onUpdate) this.onUpdate(t, this);
            return this;
        }
        _step() {
            var now = typeof performance !== "undefined" ? performance.now() : Date.now();
            var raw = now - (this._lastStepTime || now);
            this._lastStepTime = now;
            this.step(Math.min(MAX_DELTA_MS, Math.max(0, raw)));
        }
    }

    // --------------------------------------------------------------------
    // 4.5 SOAMorphGroup — 1M+ instanced shape morphing
    // CORRECTION: setPaths() allocated `{x:0,y:0}` literals for missing
    // samples; toPathString() allocated a fresh point array per call.
    // --------------------------------------------------------------------
    class SOAMorphGroup {
        constructor(count, options) {
            options = options || {};
            this.count = count;
            this.sampleCount = options.sampleCount || 64;
            this.duration = options.duration || 1.0;
            this.ease = typeof options.easing === "function"
                ? options.easing
                : (easeMap[options.easing || "linear"] || easeMap.linear);
            var floats = count * this.sampleCount * 2;
            this.fromPoints = new Float32Array(floats);
            this.toPoints = new Float32Array(floats);
            this.outPoints = new Float32Array(floats);
            this.t = new Float32Array(count);
            this.delays = new Float32Array(count);
            this.durations = new Float32Array(count);
            this.durations.fill(this.duration);
            this.done = false;
            this._scratch = new Array(this.sampleCount);
            for (var i = 0; i < this.sampleCount; i++) this._scratch[i] = { x: 0, y: 0 };
        }
        setPaths(index, from, to) {
            var sc = this.sampleCount;
            var base = index * sc * 2;
            var fl = from ? from.length : 0;
            var tl = to ? to.length : 0;
            var flastX = fl ? from[fl - 1].x : 0, flastY = fl ? from[fl - 1].y : 0;
            var tlastX = tl ? to[tl - 1].x : 0, tlastY = tl ? to[tl - 1].y : 0;
            for (var i = 0; i < sc; i++) {
                var fi = (from && from[i]) || null;
                var ti = (to && to[i]) || null;
                this.fromPoints[base + i * 2] = fi ? fi.x : flastX;
                this.fromPoints[base + i * 2 + 1] = fi ? fi.y : flastY;
                this.toPoints[base + i * 2] = ti ? ti.x : tlastX;
                this.toPoints[base + i * 2 + 1] = ti ? ti.y : tlastY;
            }
            this.done = false;
            return this;
        }
        setPathsFlat(index, fromFlat, toFlat) {
            var sc = this.sampleCount;
            var base = index * sc * 2;
            for (var i = 0; i < sc * 2; i++) {
                this.fromPoints[base + i] = fromFlat ? fromFlat[i] : 0;
                this.toPoints[base + i] = toFlat ? toFlat[i] : 0;
            }
            this.done = false;
            return this;
        }
        setTiming(index, delay, duration) {
            this.delays[index] = delay || 0;
            this.durations[index] = duration || this.duration;
            return this;
        }
        _stepOne(i, dtSec, ease) {
            if (this.delays[i] > 0) { this.delays[i] -= dtSec; if (this.delays[i] > 0) return; }
            var dur = this.durations[i];
            var t = dur > 0 ? this.t[i] + dtSec / dur : 1;
            if (t > 1) t = 1;
            this.t[i] = t;
            var et = ease(t);
            var sc = this.sampleCount;
            var base = i * sc * 2;
            var fp = this.fromPoints, tp = this.toPoints, op = this.outPoints;
            for (var k = 0; k < sc; k++) {
                var o = base + k * 2;
                var fx = fp[o], fy = fp[o + 1];
                op[o] = fx + (tp[o] - fx) * et;
                op[o + 1] = fy + (tp[o + 1] - fy) * et;
            }
        }
        step(dtSec) {
            var ease = this.ease, c = 0;
            for (var i = 0; i < this.count; i++) {
                this._stepOne(i, dtSec, ease);
                if (this.t[i] >= 1) c++;
            }
            this.done = (c === this.count);
            return this;
        }
        async stepChunked(dtSec, chunkSize, yieldEvery) {
            chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
            yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
            var ease = this.ease, c = 0, chunks = 0;
            for (var start = 0; start < this.count; start += chunkSize) {
                var end = Math.min(start + chunkSize, this.count);
                for (var i = start; i < end; i++) {
                    this._stepOne(i, dtSec, ease);
                    if (this.t[i] >= 1) c++;
                }
                if (++chunks >= yieldEvery) { chunks = 0; await glMatrix.yieldToMain(); }
            }
            this.done = (c === this.count);
            return this;
        }
        interpolateInto(out, i) {
            var sc = this.sampleCount;
            var base = i * sc * 2;
            for (var k = 0; k < sc; k++) {
                var p = out[k];
                if (!p) { p = out[k] = { x: 0, y: 0 }; }
                p.x = this.outPoints[base + k * 2];
                p.y = this.outPoints[base + k * 2 + 1];
            }
            out.length = sc;
            return out;
        }
        getInstanceView(i) {
            var sc = this.sampleCount;
            return this.outPoints.subarray(i * sc * 2, (i + 1) * sc * 2);
        }
        toPathString(i, closed) {
            return buildShapePath(this.interpolateInto(this._scratch, i), closed !== false);
        }
    }

    // --------------------------------------------------------------------
    // 4.6 KeyframeTrack
    // CORRECTION: evaluate() allocated a new Array for array-valued
    // keyframes on every call. A per-track scratch array is reused.
    // --------------------------------------------------------------------
    function _byTime(a, b) { return a.time - b.time; }

    class KeyframeTrack {
        constructor(property, keyframes, options) {
            options = options || {};
            this.property = property;
            this.target = options.target || null;
            this.keyframes = this._normalizeKeyframes(keyframes);
            this.duration = this._computeDuration();
            this.loop = options.loop || false;
            this.pingPong = options.pingPong || false;
            this.timeScale = options.timeScale === undefined ? 1 : options.timeScale;
            this.currentTime = 0;
            this.progress = 0;
            this.isRunning = false;
            this.onUpdate = options.onUpdate || null;
            this.onKeyframe = options.onKeyframe || null;
            this.onComplete = options.onComplete || null;
            this._lastStepTime = 0;
            this._lastKeyframeIdx = -1;
            var maxLen = 0;
            for (var i = 0; i < this.keyframes.length; i++) {
                var v = this.keyframes[i].value;
                if (Array.isArray(v) && v.length > maxLen) maxLen = v.length;
            }
            this._scratch = maxLen > 0 ? new Array(maxLen) : null;
            if (this._scratch) for (var j = 0; j < maxLen; j++) this._scratch[j] = 0;
            this._scratchLen = maxLen;
        }
        _normalizeKeyframes(kfs) {
            if (!Array.isArray(kfs) || kfs.length === 0) {
                return [{ time: 0, value: 0, easing: easeMap.linear }];
            }
            var out = new Array(kfs.length);
            for (var i = 0; i < kfs.length; i++) {
                var kf = kfs[i];
                var easing = typeof kf.easing === "function"
                    ? kf.easing
                    : (easeMap[kf.easing || "linear"] || easeMap.linear);
                out[i] = { time: kf.time !== undefined ? kf.time : i * 1000, value: kf.value, easing: easing };
            }
            out.sort(_byTime);
            return out;
        }
        _computeDuration() { return this.keyframes[this.keyframes.length - 1].time; }
        evaluate(time) {
            var kfs = this.keyframes;
            if (kfs.length === 0) return 0;
            if (kfs.length === 1) return kfs[0].value;
            if (time <= kfs[0].time) return kfs[0].value;
            if (time >= kfs[kfs.length - 1].time) return kfs[kfs.length - 1].value;
            for (var i = 0; i < kfs.length - 1; i++) {
                if (time >= kfs[i].time && time <= kfs[i + 1].time) {
                    var span = kfs[i + 1].time - kfs[i].time;
                    var t = span > 0 ? (time - kfs[i].time) / span : 0;
                    var et = kfs[i].easing(t);
                    var a = kfs[i].value, b = kfs[i + 1].value;
                    if (typeof a === "number" && typeof b === "number") return a + (b - a) * et;
                    if (Array.isArray(a) && Array.isArray(b)) {
                        var n = Math.min(a.length, b.length);
                        var out = this._scratch;
                        for (var j = 0; j < n; j++) out[j] = a[j] + (b[j] - a[j]) * et;
                        out.length = n;
                        return out;
                    }
                    return et < 0.5 ? a : b;
                }
            }
            return kfs[kfs.length - 1].value;
        }
        evaluateInto(out, time) {
            var v = this.evaluate(time);
            if (typeof v === "number") { out[0] = v; return out; }
            if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) out[i] = v[i]; }
            return out;
        }
        step(dtMs) {
            if (!this.isRunning) return;
            this.currentTime += dtMs * this.timeScale;
            var t = this.duration > 0 ? this.currentTime / this.duration : 1;
            if (this.pingPong) { t = t % 2; if (t > 1) t = 2 - t; }
            else if (this.loop) { t = t % 1; }
            else if (t > 1) t = 1;
            this.progress = t;
            var absTime = t * this.duration;
            var value = this.evaluate(absTime);
            if (this.target && this.property) this.target[this.property] = value;
            if (this.onUpdate) this.onUpdate(value, t, this);
            if (this.onKeyframe) {
                for (var i = 0; i < this.keyframes.length; i++) {
                    if (this.keyframes[i].time <= absTime && i > this._lastKeyframeIdx) {
                        this._lastKeyframeIdx = i;
                        this.onKeyframe(this.keyframes[i], i, this);
                    }
                }
            }
            if (!this.loop && !this.pingPong && t >= 1) {
                this.isRunning = false;
                GlobalEngine.remove(this);
                if (this.onComplete) this.onComplete(this);
            }
        }
        play() {
            this.isRunning = true;
            this._lastStepTime = typeof performance !== "undefined" ? performance.now() : Date.now();
            GlobalEngine.add(this);
            return this;
        }
        pause() { this.isRunning = false; GlobalEngine.remove(this); return this; }
        restart() {
            this.currentTime = 0; this.progress = 0; this._lastKeyframeIdx = -1;
            return this.play();
        }
        seek(t) {
            this.currentTime = t * this.duration;
            this.progress = t;
            var v = this.evaluate(this.currentTime);
            if (this.target && this.property) this.target[this.property] = v;
            if (this.onUpdate) this.onUpdate(v, t, this);
            return this;
        }
        _step() {
            var now = typeof performance !== "undefined" ? performance.now() : Date.now();
            var raw = now - (this._lastStepTime || now);
            this._lastStepTime = now;
            this.step(Math.min(MAX_DELTA_MS, Math.max(0, raw)));
        }
    }

    // --------------------------------------------------------------------
    // 4.7 AnimationStateMachine
    // CORRECTION: Map.get() ran inside the frame loop. Trigger decay is
    // now on the simulation tick — no timers, no closures, no Map lookups
    // per frame (Blueprint Sections 10 / 16).
    // --------------------------------------------------------------------
    var _EMPTY_LIST = [];

    class AnimationStateMachine {
        constructor(config) {
            config = config || {};
            this.states = new Map();
            this.transitions = new Map();
            this.parameters = Object.create(null);
            this.current = null;
            this.currentState = null;
            this.time = 0;
            this.blendTime = config.blendTime || 0.2;
            this.onEnter = config.onEnter || null;
            this.onExit = config.onExit || null;
            this.onTransition = config.onTransition || null;
            this._currentTrans = _EMPTY_LIST;
            this._pendingTriggers = [];
        }
        addState(name, config) {
            config = config || {};
            var state = {
                name: name,
                update: config.update || null,
                onEnter: config.onEnter || null,
                onExit: config.onExit || null,
                loop: config.loop !== false,
                duration: config.duration || 1.0,
                time: 0
            };
            this.states.set(name, state);
            return this;
        }
        addTransition(from, to, config) {
            config = config || {};
            var trans = {
                from: from,
                to: to,
                trigger: config.trigger || null,
                condition: config.condition || null,
                duration: config.duration !== undefined ? config.duration : this.blendTime,
                easing: typeof config.easing === "function"
                    ? config.easing
                    : (easeMap[config.easing || "easeOutCubic"] || easeMap.easeOutCubic)
            };
            var list = this.transitions.get(from);
            if (!list) { list = []; this.transitions.set(from, list); }
            list.push(trans);
            if (this.current === from) this._currentTrans = list;
            return this;
        }
        setParameter(name, value) {
            this.parameters[name] = value;
            this._checkTriggers();
            return this;
        }
        trigger(name) {
            this.parameters[name] = true;
            this._pendingTriggers.push(name);
            this._checkTriggers();
            return this;
        }
        play(stateName) {
            var state = this.states.get(stateName);
            if (!state) return this;
            if (this.currentState && this.currentState.onExit) this.currentState.onExit(this.currentState);
            this.current = stateName;
            this.currentState = state;
            this._currentTrans = this.transitions.get(stateName) || _EMPTY_LIST;
            state.time = 0;
            if (state.onEnter) state.onEnter(state);
            if (this.onEnter) this.onEnter(stateName, state);
            return this;
        }
        _checkTriggers() {
            if (!this.current) return;
            var list = this._currentTrans;
            for (var i = 0; i < list.length; i++) {
                var tr = list[i];
                var go = false;
                if (tr.trigger && this.parameters[tr.trigger]) go = true;
                if (!go && tr.condition && tr.condition(this.parameters)) go = true;
                if (go) {
                    this.play(tr.to);
                    if (this.onTransition) this.onTransition(tr.from, tr.to, tr);
                    break;
                }
            }
        }
        step(dtSec) {
            if (!this.currentState) return;
            this.time += dtSec;
            this.currentState.time += dtSec;
            if (this.currentState.update) this.currentState.update(dtSec, this.currentState);
            this._checkTriggers();
            var pend = this._pendingTriggers;
            for (var i = 0; i < pend.length; i++) this.parameters[pend[i]] = false;
            pend.length = 0;
        }
    }

    // --------------------------------------------------------------------
    // 4.8 BlendTree
    // CORRECTION: evaluate() used Map.forEach + closures per call and
    // allocated a fresh result object. Dense arrays + a reused result.
    // --------------------------------------------------------------------
    class BlendTree {
        constructor(config) {
            config = config || {};
            this.clips = new Map();
            this.weights = new Map();
            this.currentTime = 0;
            this.duration = config.duration || 1.0;
            this.isRunning = false;
            this._lastStepTime = 0;
            this._names = [];
            this._clipList = [];
            this._weightArr = new Float32Array(0);
            this._result = { x: 0, y: 0 };
            this._dirty = true;
        }
        addClip(name, clip) {
            this.clips.set(name, clip);
            if (!this.weights.has(name)) this.weights.set(name, 0);
            this._dirty = true;
            return this;
        }
        setWeight(name, w) {
            this.weights.set(name, clamp(w, 0, 1));
            if (!this._dirty) {
                var idx = this._names.indexOf(name);
                if (idx >= 0) this._weightArr[idx] = clamp(w, 0, 1);
            }
            return this;
        }
        getWeight(name) { return this.weights.get(name) || 0; }
        _rebuild() {
            var n = this.clips.size;
            this._names.length = 0;
            this._clipList.length = 0;
            if (this._weightArr.length < n) this._weightArr = new Float32Array(n);
            var i = 0;
            this.clips.forEach(function (clip, name) {
                this._names.push(name);
                this._clipList.push(clip);
                this._weightArr[i++] = this.weights.get(name) || 0;
            }, this);
            this._dirty = false;
        }
        evaluate(t) {
            if (this._dirty) this._rebuild();
            var res = this._result;
            res.x = 0; res.y = 0;
            var n = this._clipList.length, total = 0, i;
            for (i = 0; i < n; i++) total += this._weightArr[i];
            if (total <= 0) return res;
            for (i = 0; i < n; i++) {
                var w = this._weightArr[i] / total;
                if (w === 0) continue;
                var clip = this._clipList[i];
                var sample = typeof clip === "function" ? clip(t) : clip;
                if (sample && typeof sample === "object") {
                    res.x += (sample.x || 0) * w;
                    res.y += (sample.y || 0) * w;
                }
            }
            return res;
        }
        step(dtSec) {
            if (!this.isRunning) return;
            this.currentTime += dtSec;
            if (this.currentTime >= this.duration) this.currentTime = 0;
        }
        play() { this.isRunning = true; return this; }
        pause() { this.isRunning = false; return this; }
    }

    // --------------------------------------------------------------------
    // 4.9 FullAnimationSystem
    // CORRECTION: stepChunked() allocated a concatenated array per call and
    // passed the wrong time unit to generic tracks. A pre-built dispatch
    // list carries an explicit unit tag; nothing allocates per frame.
    // --------------------------------------------------------------------
    var UNIT_MS = 0, UNIT_SEC = 1;

    class FullAnimationSystem {
        constructor(config) {
            config = config || {};
            this.tracks = [];
            this.morphTracks = [];
            this.keyframeTracks = [];
            this.stateMachines = [];
            this.blendTrees = [];
            this.paused = false;
            this.timeScale = config.timeScale === undefined ? 1 : config.timeScale;
            this._all = [];
        }
        _register(item, unit, bucket) {
            bucket.push(item);
            this._all.push({ item: item, unit: unit });
            return this;
        }
        addTrack(track) { return this._register(track, UNIT_MS, this.tracks); }
        addMorph(track) { return this._register(track, UNIT_SEC, this.morphTracks); }
        addKeyframe(track) { return this._register(track, UNIT_MS, this.keyframeTracks); }
        addStateMachine(sm) { return this._register(sm, UNIT_SEC, this.stateMachines); }
        addBlendTree(bt) { return this._register(bt, UNIT_SEC, this.blendTrees); }
        step(dtMs) {
            if (this.paused) return;
            var scaledMs = dtMs * this.timeScale;
            var scaledSec = scaledMs / 1000;
            var all = this._all;
            for (var i = 0; i < all.length; i++) {
                var e = all[i], item = e.item;
                if (!item.step) continue;
                item.step(e.unit === UNIT_MS ? scaledMs : scaledSec);
            }
        }
        async stepChunked(dtMs, chunkSize, yieldEvery) {
            if (this.paused) return;
            chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
            yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
            var scaledMs = dtMs * this.timeScale;
            var scaledSec = scaledMs / 1000;
            var all = this._all, c = 0;
            for (var start = 0; start < all.length; start += chunkSize) {
                var end = Math.min(start + chunkSize, all.length);
                for (var i = start; i < end; i++) {
                    var e = all[i], item = e.item;
                    if (item.stepChunked) await item.stepChunked(scaledSec, chunkSize, yieldEvery);
                    else if (item.step) item.step(e.unit === UNIT_MS ? scaledMs : scaledSec);
                }
                if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
            }
        }
        play() { this.paused = false; return this; }
        pause() { this.paused = true; return this; }
        restart() {
            var all = this._all;
            for (var i = 0; i < all.length; i++) {
                if (all[i].item.restart) all[i].item.restart();
            }
            return this;
        }
        clear() {
            this.tracks.length = 0;
            this.morphTracks.length = 0;
            this.keyframeTracks.length = 0;
            this.stateMachines.length = 0;
            this.blendTrees.length = 0;
            this._all.length = 0;
            return this;
        }
    }

    // ====================================================================
    // 5. FUNCTION DECLARATIONS
    // ====================================================================
    function resolveShapeSource(source) {
        if (!source) return [];
        if (typeof source === "object" && source.type) {
            switch (source.type) {
                case "circle": return ShapePrimitive.circle(source.cx || 0, source.cy || 0, source.r || 10, source.segments);
                case "ellipse": return ShapePrimitive.ellipse(source.cx || 0, source.cy || 0, source.rx || 10, source.ry || 6, source.segments);
                case "rect": return ShapePrimitive.rect(source.x || 0, source.y || 0, source.w || 20, source.h || 20, source.segments);
                case "square": return ShapePrimitive.square(source.x || 0, source.y || 0, source.size || 20, source.segments);
                case "triangle": return ShapePrimitive.triangle(source.cx || 0, source.cy || 0, source.r || 10, source.segments);
                case "star": return ShapePrimitive.star(source.cx || 0, source.cy || 0, source.outerR || 10, source.innerR || 4, source.points || 5, source.segments);
                case "polygon": return ShapePrimitive.polygon(source.cx || 0, source.cy || 0, source.r || 10, source.sides || 6, source.segments);
                case "pentagon": return ShapePrimitive.pentagon(source.cx || 0, source.cy || 0, source.r || 10, source.segments);
                case "hexagon": return ShapePrimitive.hexagon(source.cx || 0, source.cy || 0, source.r || 10, source.segments);
                case "octagon": return ShapePrimitive.octagon(source.cx || 0, source.cy || 0, source.r || 10, source.segments);
                case "line": return ShapePrimitive.line(source.x1 || 0, source.y1 || 0, source.x2 || 10, source.y2 || 0, source.segments);
                case "points": return ShapePrimitive.points(source.pts || []);
            }
        }
        if (typeof source === "object" && source.getTotalLength) {
            var sampledEl = svgModule.samplePath(source, DEFAULT_SAMPLE_COUNT);
            return sampledEl ? sampledEl.points : [];
        }
        if (typeof source === "string") {
            var s = svgModule.samplePath(source, DEFAULT_SAMPLE_COUNT);
            return s ? s.points : [];
        }
        if (Array.isArray(source)) return ShapePrimitive.points(source);
        return [];
    }

    function buildShapePath(points, closed) {
        if (closed === undefined) closed = true;
        if (!points || points.length === 0) return "";
        var d = "M " + points[0].x.toFixed(2) + " " + points[0].y.toFixed(2);
        for (var i = 1; i < points.length; i++) {
            d += " L " + points[i].x.toFixed(2) + " " + points[i].y.toFixed(2);
        }
        if (closed) d += " Z";
        return d;
    }

    function _centroid(pts, out) {
        var cx = 0, cy = 0;
        for (var i = 0; i < pts.length; i++) { cx += pts[i].x; cy += pts[i].y; }
        out.x = cx / pts.length; out.y = cy / pts.length;
        return out;
    }
    function _angularIndex(pts, c, scratch) {
        scratch.length = pts.length;
        for (var i = 0; i < pts.length; i++) {
            var s = scratch[i];
            if (!s) { s = scratch[i] = { idx: 0, angle: 0 }; }
            s.idx = i;
            s.angle = Math.atan2(pts[i].y - c.y, pts[i].x - c.x);
        }
        scratch.sort(_byAngle);
        return scratch;
    }
    var _alignScratchA = [], _alignScratchB = [];
    var _alignCentroidA = { x: 0, y: 0 }, _alignCentroidB = { x: 0, y: 0 };

    function alignPointsByAngle(from, to) {
        if (from.length !== to.length) return { from: from, to: to };
        var n = from.length;
        _centroid(from, _alignCentroidA);
        _centroid(to, _alignCentroidB);
        var fIdx = _angularIndex(from, _alignCentroidA, _alignScratchA);
        var tIdx = _angularIndex(to, _alignCentroidB, _alignScratchB);
        var newTo = new Array(n);
        for (var i = 0; i < n; i++) newTo[i] = to[tIdx[i].idx];
        return { from: from, to: newTo };
    }

    // ====================================================================
    // 6. LEGACY API (motion-engine.cjs preserved)
    // ====================================================================
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
        this.timeScale = config.timeScale === undefined ? 1 : config.timeScale;
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
        this.currentTime = 0; this.progress = 0; return this.play();
    };
    BundleTimer.prototype._step = function () {
        if (!this.isRunning) return;
        var now = typeof performance !== "undefined" ? performance.now() : Date.now();
        var dt = Math.min(MAX_DELTA_MS, Math.max(0, now - this.lastTime)) * this.timeScale;
        this.lastTime = now;
        this.currentTime += dt;
        this.progress = clamp(this.currentTime / this.duration, 0, 1);
        if (this.onTick) this.onTick(this);
        if (this.currentTime >= this.duration) {
            if (this.loop) this.currentTime = 0;
            else { this.pause(); if (this.onComplete) this.onComplete(this); }
        }
    };
    BundleTimer.prototype.stepFixed = function (dtMs) {
        if (!this.isRunning) return this;
        this.lastTime = typeof performance !== "undefined" ? performance.now() : Date.now();
        this.currentTime += Math.max(0, dtMs) * this.timeScale;
        this.progress = clamp(this.currentTime / this.duration, 0, 1);
        if (this.onTick) this.onTick(this);
        if (this.currentTime >= this.duration) {
            if (this.loop) this.currentTime = 0;
            else { this.pause(); if (this.onComplete) this.onComplete(this); }
        }
        return this;
    };

    function bundleAnimatable(target, props) {
        var keys = [], vals = [];
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

    function bundleLayout(targets) {
        var els = toArray(targets);
        var n = els.length;
        var firstRects = new Float64Array(n * 4);
        var recorded = new Uint8Array(n);
        var cfgs = new Array(n), pairs = new Array(n);
        for (var i = 0; i < n; i++) {
            pairs[i] = [[0, 0], [0, 0], [1, 1], [1, 1]];
            cfgs[i] = {
                targets: els[i],
                translateX: pairs[i][0], translateY: pairs[i][1],
                scaleX: pairs[i][2], scaleY: pairs[i][3],
                duration: 600, easing: "spring"
            };
        }
        var anims = [];
        return {
            record: function () {
                for (var j = 0; j < n; j++) {
                    var r = els[j].getBoundingClientRect();
                    var o = j * 4;
                    firstRects[o] = r.left; firstRects[o + 1] = r.top;
                    firstRects[o + 2] = r.width; firstRects[o + 3] = r.height;
                    recorded[j] = 1;
                }
                return this;
            },
            play: function (opts) {
                opts = opts || {};
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
                    cfg.duration = opts.duration || 600;
                    cfg.easing = opts.easing || "spring";
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
        this._rafId = null;
        this._vh = 0;
        this._startPx = 0;
        this._endPx = 0;
        this._thresholdsDirty = true;
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
    BundleScrollTrigger.prototype._parseThreshold = function (str, vh, isTop) {
        if (typeof str === "number") return str;
        var s = String(str);
        var sp = s.indexOf(" ");
        var token = sp === -1 ? "" : s.slice(sp + 1);
        if (token === "") return vh * (isTop ? 0.85 : 0.15);
        var lastCh = token.charCodeAt(token.length - 1);
        if (lastCh === 37) return (parseFloat(token) / 100) * vh;
        if (token.length >= 2 && token.charCodeAt(token.length - 1) === 120 &&
            token.charCodeAt(token.length - 2) === 112) return parseFloat(token);
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
        var startT = this._startPx, endT = this._endPx;
        var total = (rect.height + (startT - endT)) || 1;
        var current = startT - rect.top;
        var p = clamp(current / total, 0, 1);
        this.progress = p;
        var inView = rect.top <= startT && rect.bottom >= endT;
        if (inView && !this.isInView) {
            this.isInView = true;
            if (this.direction === 1 && this.onEnter) this.onEnter(this);
            if (this.direction === -1 && this.onEnterBack) this.onEnterBack(this);
            if (!this.sync && this.animation) this.animation.restart();
        } else if (!inView && this.isInView) {
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

    function bundleDraggable(target, opts) {
        opts = opts || {};
        var els = toArray(target);
        var out = new Array(els.length);
        var handles = [];
        for (var i = 0; i < els.length; i++) {
            out[i] = undefined;
            var h = draggableModule.draggable(els[i], opts);
            if (h && typeof h.destroy === "function") handles.push(h);
        }
        out.destroy = function () {
            for (var j = 0; j < handles.length; j++) handles[j].destroy();
            handles.length = 0;
        };
        return out;
    }

    // ====================================================================
    // 7. PUBLIC COMPOSITION
    // ====================================================================
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

    function fillFBM2DShim(soa, scale, octaves) { return vec2.soaFillNoise2D(soa, scale, octaves, "fbm"); }
    function fillFBM2DShimChunked(soa, scale, octaves, cs, ye) {
        return vec2.soaFillNoise2DChunked(soa, scale, octaves, "fbm", cs, ye);
    }
    function fillFBM3DShim(soa, scale, octaves) { return vec3.soaFillNoise3D(soa, scale, octaves, "fbm"); }
    function fillFBM3DShimChunked(soa, scale, octaves, cs, ye) {
        return vec3.soaFillNoise3DChunked(soa, scale, octaves, "fbm", cs, ye);
    }
    function fillFBM4DShim(soa, scale, timeStep, octaves) { return vec4.soaFillNoise4D(soa, scale, timeStep, octaves); }
    function fillFBM4DShimChunked(soa, scale, timeStep, octaves, cs, ye) {
        return vec4.soaFillNoise4DChunked(soa, scale, timeStep, octaves, cs, ye);
    }
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
    function soaHueRotateSOA(outColors, baseColors, angleRad) {
        return mat2.soaHueRotateChroma(
            outColors.y, outColors.z, outColors.x,
            baseColors.y, baseColors.z, baseColors.x,
            angleRad
        );
    }

    var PROCEDURAL = {
        simplex2D: simplex.createNoise2D,
        simplex3D: simplex.createNoise3D,
        simplex4D: simplex.createNoise4D,
        acquireSimplex2D: simplex.acquireNoise2D,
        acquireSimplex3D: simplex.acquireNoise3D,
        acquireSimplex4D: simplex.acquireNoise4D,
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
        fill2D: vec2.soaFillNoise2D,
        fill3D: vec3.soaFillNoise3D,
        fill4D: vec4.soaFillNoise4D,
        fillFBM2D: fillFBM2DShim,
        fillFBM3D: fillFBM3DShim,
        fillFBM4D: fillFBM4DShim,
        fillNoise3DSimplex: simplex.soaFillNoise3D,
        fillFBM3DSimplex: simplex.soaFillFBM3D,
        fillTurbulence3D: simplex.soaFillTurbulence3D,
        fillRidged3D: simplex.soaFillRidged3D,
        fillWarped3D: simplex.soaFillWarped3D,
        fillCurl3D: simplex.soaFillCurl3D,
        fillGradient3D: simplex.soaFillGradient3D,
        fill2DChunked: vec2.soaFillNoise2DChunked,
        fill3DChunked: vec3.soaFillNoise3DChunked,
        fill4DChunked: vec4.soaFillNoise4DChunked,
        fillFBM2DChunked: fillFBM2DShimChunked,
        fillFBM3DChunked: fillFBM3DShimChunked,
        fillFBM4DChunked: fillFBM4DShimChunked,
        fillFBM3DSimplexChunked: simplex.soaFillFBM3DChunked,
        fillTurbulence3DChunked: simplex.soaFillTurbulence3DChunked,
        fillRidged3DChunked: simplex.soaFillRidged3DChunked,
        fillCurl3DChunked: simplex.soaFillCurl3DChunked,
        fillGradient3DChunked: simplex.soaFillGradient3DChunked,
        scatter: bitecs.scatterEntities,
        scatterChunked: bitecs.scatterEntitiesChunked,
        scatterOrbital: bitecs.spawnOrbitalBodies,
        hash2: glMatrix.hash2,
        hash3: glMatrix.hash3,
        hash4: glMatrix.hash4,
        mulberry32: glMatrix.mulberry32,
        xorshift32: glMatrix.xorshift32,
        splitmix32: glMatrix.splitmix32,
        value3D_64: double.valueNoise3D_64,
        hash3_64: double.hash3_64
    };

    var RENDER = {
        createBatch: bitecs.createInstanceBatch,
        composeTRS: mat4.soaComposeTRS,
        composeTRSChunked: mat4.soaComposeTRSChunked,
        transformPoint: mat4.soaTransformPoint,
        transformPointChunked: mat4.soaTransformPointChunked,
        transformPointPerspective: mat4.soaTransformPointPerspective,
        buildTBN: mat3.buildTBN,
        buildTBNSOA: mat3.soaBuildTBN,
        buildTBNSOAChunked: mat3.soaBuildTBNChunked,
        multiply: mat4.soaMultiply,
        multiplyChunked: mat4.soaMultiplyChunked,
        invert: mat4.soaInvert,
        invertChunked: mat4.soaInvertChunked,
        transpose: soaTransposeMat4,
        transposeMat3: mat3.soaTranspose,
        perspective: mat4.perspectiveNO,
        perspectiveZO: mat4.perspectiveZO,
        ortho: mat4.orthoNO,
        orthoZO: mat4.orthoZO,
        frustum: mat4.frustum,
        lookAt: mat4.lookAt,
        targetTo: mat4.targetTo,
        fromWorldBoundsNDC: mat4.fromWorldBoundsNDC,
        normalFromMat4: mat3.normalFromMat4,
        decompose: mat4.soaDecompose,
        aabb: vec3.soaAABB,
        fillFromNoise: mat3.soaFillFromNoise,
        fillFromNoiseChunked: mat3.soaFillFromNoiseChunked,
        fillRotationFromNoise: mat2.soaFillRotationFromNoise,
        fillTRSFromNoise: mat4.soaFillTRSFromNoise,
        fillTRSFromNoiseChunked: mat4.soaFillTRSFromNoiseChunked,
        toFlat: mat4.soaToFlat
    };

    var COLOR = {
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
        expose: utils.exposeColor,
        reinhard: utils.reinhardColor,
        aces: utils.acesColor,
        acesToneMap: vec3.acesToneMap,
        reinhardToneMap: vec3.reinhardToneMap,
        acesToneMapSOA: double.acesToneMapSOA,
        pack: utils.packColorRGBA,
        unpack: utils.unpackColorRGBA,
        packVec3: vec3.packRGB,
        unpackVec3: vec3.unpackRGB,
        css: utils.cssColor,
        soaFill: vec4.soaFillColor,
        soaExpose: vec4.soaExpose,
        soaSrgbToLinear: vec4.soaSrgbToLinear,
        soaLinearToSrgb: vec4.soaLinearToSrgb,
        soaApplyMatrix: mat3.soaApplyColorMatrix,
        soaHueRotateChroma: mat2.soaHueRotateChroma,
        soaHueRotate: soaHueRotateSOA,
        fromSaturation: mat3.fromSaturation,
        fromGrayscale: mat3.fromGrayscale,
        fromHueRotation: mat3.fromHueRotation,
        fromChannelMix: mat3.fromChannelMix,
        LUMA_R709: mat3.LUMA_R709,
        LUMA_G709: mat3.LUMA_G709,
        LUMA_B709: mat3.LUMA_B709
    };

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

    var ORBITAL = {
        keplerSolve: glMatrix.keplerSolve,
        eccentricToTrue: glMatrix.eccentricToTrue,
        meanToTrue: glMatrix.meanToTrue,
        keplerSolveDouble: double.keplerSolve2,
        keplerSolveDoubleExact: double.keplerSolve2Exact,
        orbit2D: vec2.keplerOrbit2D,
        orbit3D: vec3.keplerOrbit3D,
        velocity3D: vec3.keplerOrbitVelocity3D,
        speed: vec3.orbitalSpeed3D,
        hohmann: vec3.hohmannTransfer,
        sphereOfInfluence: vec3.sphereOfInfluence,
        createEpoch: timerModule.createOrbitalEpoch,
        integrateDouble: double.integrateOrbitSOA,
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
        createAnimationSystem: bitecs.createAnimationSystem,
        createIKSystem: bitecs.createIKSystem,
        createOrbitalSystem: bitecs.createOrbitalSystem,
        createColorSystem: bitecs.createColorSystem,
        createFloatingOrigin: bitecs.createFloatingOrigin,
        createSpatialGrid: bitecs.createSpatialGrid,
        serializeScene: serialization.serializeScene,
        deserializeScene: serialization.deserializeScene,
        createSnapshot: serialization.createSnapshotSerializer,
        createRestore: serialization.createSnapshotDeserializer,
        createByteWriter: serialization.createByteWriter,
        createByteReader: serialization.createByteReader,
        iterChunked: bitecs.iterChunked,
        queryChunked: bitecs.queryChunked
    };

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

    // ====================================================================
    // 7.1 CREATE SCENE — one-call bootstrap for 1M+ instanced worlds
    // CORRECTIONS:
    //  • scatter reuses the pre-created eids (it previously spawned a
    //    SECOND, discarded entity set and left the scene at the origin);
    //  • colours default to opaque white (zero alpha rendered nothing);
    //  • uploadTo composes into the interleaved buffer in ONE pass with
    //    dirty-range tracking (Blueprint §25/§28);
    //  • dispose never destroys the shared GlobalEngine singleton.
    // ====================================================================
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
        colors.x.fill(1); colors.y.fill(1); colors.z.fill(1); colors.w.fill(1);
        for (var i = 0; i < count; i++) eids[i] = bitecs.addEntity(world);

        if (config.scatter) {
            var spawnIdx = 0;
            var scatterOpts = {};
            for (var sk in config.scatter) scatterOpts[sk] = config.scatter[sk];
            scatterOpts.spawn = function () { return eids[spawnIdx++]; };
            var res = PROCEDURAL.scatter(world, count, scatterOpts);
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

        return {
            world: world,
            engine: engine,
            count: count,
            eids: eids,
            trs: trs,
            colors: colors,
            matrices: matrices,
            velocities: velocities,
            compose: function () {
                return mat4.soaComposeTRS(matrices, trs.position, trs.rotation, trs.scale);
            },
            composeChunked: function (cs, ye) {
                return mat4.soaComposeTRSChunked(matrices, trs.position, trs.rotation, trs.scale, cs, ye);
            },
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
            addStep: function (fn, name) {
                var entry = engine.addSoaStep(fn, name);
                ownedSteps.push(entry);
                return entry;
            },
            step: function (dtSec) {
                for (var s = 0; s < ownedSteps.length; s++) {
                    var e = ownedSteps[s];
                    if (e.enabled) e.fn(dtSec, engine.lastTime);
                }
                return this;
            },
            dispose: function () {
                for (var s = 0; s < ownedSteps.length; s++) engine.removeSoaStep(ownedSteps[s]);
                ownedSteps.length = 0;
                bitecs.deleteWorld(world);
                if (ownsEngine && engine.destroy) engine.destroy();
            }
        };
    }

    // ====================================================================
    // 8. EXPORT DECLARATIONS
    // ====================================================================
    return {
        version: "4.0.0",
        // ---- Legacy API ----
        animate: function (config) { return new Animation(config); },
        timeline: function (config) {
            var m = getTimelineModule();
            if (!m) throw new Error("StudioMotion.timeline requires the timeline module to be loaded");
            return new m.Timeline(config);
        },
        timer: function (config) { return new BundleTimer(config); },
        animatable: bundleAnimatable,
        draggable: bundleDraggable,
        layout: bundleLayout,
        scope: bundleScope,
        svg: svgModule.svg,
        text: textModule.text,
        onScroll: bundleOnScroll,
        scrollTrigger: bundleOnScroll,
        ScrollTriggerInstance: BundleScrollTrigger,
        waapi: adaptersModule.waapi,
        animateThree: adaptersModule.animateThree,
        adapters: adaptersModule.adapters,
        engine: GlobalEngine,
        easings: easeMap,
        utils: legacyUtils,
        stagger: utils.stagger,
        recipes: recipes,
        presets: recipes,
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
        // ---- Extended: full shape morphing ----
        GenericToAnyShape: GenericToAnyShape,
        ShapePrimitive: ShapePrimitive,
        ShapeSampler: ShapeSampler,
        MorphTrack: MorphTrack,
        SOAMorphGroup: SOAMorphGroup,
        resolveShapeSource: resolveShapeSource,
        buildShapePath: buildShapePath,
        alignPointsByAngle: alignPointsByAngle,
        // ---- Extended: complete animation system ----
        KeyframeTrack: KeyframeTrack,
        AnimationStateMachine: AnimationStateMachine,
        BlendTree: BlendTree,
        FullAnimationSystem: FullAnimationSystem,
        // ---- Scene bootstrap ----
        createScene: createScene,
        // ---- Namespaces ----
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
});