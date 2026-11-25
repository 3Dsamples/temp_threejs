// file number : 017
// full path name : src/math/017_animation.js
// description : Animation system — every original export, class and method
//               preserved (Animation with keyframes, per-target arrays,
//               function values, relative values, stagger, transform / CSS /
//               SVG / attribute / object property detection, autoplay, loop,
//               direction, restart, reverse, seek, onBegin / onUpdate /
//               onRender / onLoop / onComplete), rewritten as a self-contained
//               native ES module in the three.js r185 JSM addon style: no
//               strict-mode directive, no CommonJS, no Vite / Vue / client
//               build, no CDN request.
//               Corrections: all transcription damage repaired (broken
//               identifiers, `& &`, trailing-space string literals that
//               silently broke RESERVED_PROPS / TRANSFORM_PROPS lookups and
//               every type comparison, mangled spring / relative-value
//               regexes, invalid CSS unit strings); `Animation.call()` on a
//               class replaced by a real `_init()` so pooling works; the
//               per-frame `new Map()` / `[]` allocation in `_renderFrame`
//               replaced by groups built once at init (true zero-GC render);
//               `_step(deltaMs)` now honours the delta supplied by the 016
//               engine instead of ignoring it.
//               Additions for 1M+ units at real time: LUT-accelerated SOA
//               tracks, chunked async stepping everywhere, vec3 / vec4 /
//               quaternion / TRS / mat4 SOA animations built on the provided
//               math stack, a resident-state Blob-URL worker pool for genuine
//               multi-core track stepping with a non-blocking fallback, and
//               duck-typed three.js r185 bridges that write straight into
//               InstancedMesh / BufferAttribute arrays.
// best for : 3d graphics — animation of 1M+ per-instance values (positions,
//            rotations, colors, weights) at 60 / 90 / 120 Hz, procedural
//            fade-in / fade-out across million-entity asteroid or particle
//            fields, quaternion-eased head-look, HDR color transitions that
//            keep shadow detail intact, orbital camera / satellite orbits
//            driven by eased Kepler mean anomaly, FABRIK / CCD IK
//            end-effector animation, and hybrid scenes where a few DOM / WebGL
//            objects run alongside 1M+ GPU instances with no per-frame
//            allocation.
// license : MIT
//
// topological hierarchy (dependencies first — this file is last):
//   src/math/002_vec2.js
//   src/math/003_vec3.js
//   src/math/004_vec4.js
//   src/math/005_mat2.js
//   src/math/006_mat3.js          (optional, dynamic)
//   src/math/007_mat4.js
//   src/math/008_quat.js
//   src/math/009_quat2.js
//   src/math/010_bitECS_core.js   (optional, dynamic)
//   src/math/012_double.js        (optional precision tier)
//   src/math/013_simplex.js       (optional, dynamic — noise-driven animation)
//   src/math/014_utils.js
//   src/math/015_easings.js
//   src/math/016_engine.js
//   src/math/017_animation.js     <- THIS FILE
// ============================================================================

import * as vec2 from "./002_vec2.js";
import * as vec3 from "./003_vec3.js";
import * as vec4 from "./004_vec4.js";
import * as mat2 from "./005_mat2.js";
import * as mat4 from "./007_mat4.js";
import * as quat from "./008_quat.js";
import * as quat2 from "./009_quat2.js";
import * as utils from "./014_utils.js";
import * as easings from "./015_easings.js";
import * as engineModule from "./016_engine.js";

const GlobalEngine = engineModule.GlobalEngine;

// ============================================================================
// 0. FOUNDATION (inlined — replaces require("./001_common.js"))
// ============================================================================
const CHUNK_SIZE = 65536;
const CHUNK_YIELD_EVERY = 8;
const POOL_PREALLOC = 32;
const EPSILON = 0.000001;

function yieldToMain() {
    return new Promise(function (resolve) {
        if (typeof setTimeout === "function") { setTimeout(resolve, 0); }
        else { resolve(); }
    });
}

function createPool(factory, capacity, reset) {
    capacity = capacity || POOL_PREALLOC;
    const items = [];
    for (let i = 0; i < capacity; i++) { items.push(factory()); }
    return {
        acquire() { return items.length > 0 ? items.pop() : factory(); },
        release(v) {
            if (reset) { reset(v); }
            if (items.length < capacity) { items.push(v); }
        }
    };
}

function nowMs() {
    return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
}

async function _chunkedRange(count, chunkSize, yieldEvery, perChunk) {
    chunkSize = chunkSize || CHUNK_SIZE;
    yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + chunkSize, count);
        perChunk(start, end);
        start = end;
        if (start >= count) { break; }
        if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
    }
}

// Pre-allocated module temporaries (zero-GC hot paths).
const _tmpQuat4 = new Float32Array(4);
const _tmpVec3A = new Float32Array(3);
const _tmpVec3B = new Float32Array(3);
const _tmpMatA = new Float32Array(16);
const _tmpMatB = new Float32Array(16);
const _tmpMatOut = new Float32Array(16);

// ============================================================================
// 1. CONSTANTS & EASING RESOLUTION (original behaviour preserved)
// ============================================================================
const RESERVED_PROPS = new Set([
    "targets", "duration", "delay", "endDelay", "easing", "loop",
    "direction", "round", "autoplay", "keyframes", "timeScale",
    "onBegin", "onUpdate", "onRender", "onLoop", "onComplete", "stagger"
]);

const TRANSFORM_PROPS = new Set([
    "translateX", "translateY", "translateZ",
    "rotate", "rotateX", "rotateY", "rotateZ",
    "scale", "scaleX", "scaleY", "scaleZ",
    "skew", "skewX", "skewY",
    "perspective"
]);

const SPRING_RE = /^spring\(\s*([\d.]+)?\s*,?\s*([\d.]+)?\s*,?\s*([\d.]+)?\s*\)$/;
const RELATIVE_RE = /^[+\-*/]=/;

function getEasingFunction(easing) {
    if (typeof easing === "function") { return easing; }
    if (typeof easing === "string") {
        if (easings.easings[easing]) { return easings.easings[easing]; }
        const m = easing.match(SPRING_RE);
        if (m) {
            const mass = parseFloat(m[1]) || 1;
            const k = parseFloat(m[2]) || 100;
            const c = parseFloat(m[3]) || 10;
            return function (t) { return easings.spring(t, mass, k, c); };
        }
        // CSS names / cubic-bezier(...) resolve through the 015 resolver.
        if (easings.CSS_CURVES && easings.CSS_CURVES[easing]) { return easings.CSS_CURVES[easing]; }
        if (easing.indexOf("cubic-bezier(") === 0) { return easings.getEasing(easing); }
    }
    return easings.spring;
}

// ============================================================================
// 2. ANIMATION CLASS (original API preserved, zero-GC render)
// ============================================================================
class Animation {
    constructor(config) {
        // Persistent containers — allocated once, reused for the lifetime of
        // the instance (including pooled reuse).
        this._transformMap = new Map();
        this._propMap = new Map();
        this._groups = [];
        this._transformTargets = [];
        this.tweens = [];
        this.targets = [];
        this._init(config || {});
    }

    /** Re-initialisable constructor body (makes class pooling legal). */
    _init(config) {
        this.config = config;
        this.targets = utils.toArray(config.targets);
        this.globalDuration = config.duration !== undefined ? config.duration : 1000;
        this.globalDelay = config.delay || 0;
        this.globalEndDelay = config.endDelay || 0;
        this.globalEasing = getEasingFunction(config.easing);
        this.loop = config.loop || false;
        this.direction = config.direction || "normal";
        this.round = config.round || 0;
        this.keyframes = config.keyframes || null;
        this.timeScale = config.timeScale !== undefined ? config.timeScale : 1;
        this.onBegin = config.onBegin || null;
        this.onUpdate = config.onUpdate || null;
        this.onRender = config.onRender || null;
        this.onLoop = config.onLoop || null;
        this.onComplete = config.onComplete || null;
        this.currentTime = 0;
        this.progress = 0;
        this.isRunning = false;
        this.isReversed = this.direction === "reverse";
        this.began = false;
        this.completed = false;
        this.lastStepTime = 0;
        this.tweens.length = 0;
        this.duration = this.globalDuration;
        this.delay = 0;
        this.endDelay = this.globalEndDelay;

        this._initTweens(config);
        this._buildGroups();
        if (config.autoplay !== false) { this.play(); }
        return this;
    }

    _initTweens(config) {
        const totalTargets = this.targets.length;
        let maxEndTime = this.globalDuration;
        let minDelay = Infinity;
        const self = this;

        this.targets.forEach(function (target, targetIndex) {
            const targetDelay = typeof config.delay === "function"
                ? config.delay(targetIndex, totalTargets)
                : (typeof config.stagger === "function" ? config.stagger(targetIndex, totalTargets) : self.globalDelay);
            if (targetDelay < minDelay) { minDelay = targetDelay; }

            // ---- keyframes array form ----
            if (self.keyframes && Array.isArray(self.keyframes)) {
                const stepCount = self.keyframes.length;
                let runningTime = targetDelay;
                for (let i = 0; i < stepCount; i++) {
                    const kf = self.keyframes[i];
                    const prevKf = i === 0 ? {} : self.keyframes[i - 1];
                    const kfDuration = kf.duration !== undefined ? kf.duration : (self.globalDuration / stepCount);
                    const kfDelay = kf.delay || 0;
                    const kfEndDelay = kf.endDelay || 0;
                    const kfEasing = kf.easing ? getEasingFunction(kf.easing) : self.globalEasing;
                    const startTime = runningTime + kfDelay;
                    for (const prop in kf) {
                        if (RESERVED_PROPS.has(prop)) { continue; }
                        const fromRaw = prevKf[prop] !== undefined ? prevKf[prop] : self._getCurrentValue(target, prop);
                        const toRaw = typeof kf[prop] === "function" ? kf[prop](targetIndex, totalTargets) : kf[prop];
                        self.tweens.push({
                            target: target, prop: prop,
                            type: self._getPropertyType(target, prop),
                            from: utils.decomposeValue(fromRaw),
                            to: utils.decomposeValue(toRaw),
                            startTime: startTime, duration: kfDuration, easing: kfEasing
                        });
                    }
                    runningTime = startTime + kfDuration + kfEndDelay;
                    if (runningTime > maxEndTime) { maxEndTime = runningTime; }
                }
                return;
            }

            // ---- property form ----
            for (const prop2 in config) {
                if (RESERVED_PROPS.has(prop2)) { continue; }
                const val = config[prop2];

                // per-property keyframe array: [{value, duration, ...}, ...]
                if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object" &&
                    val[0] !== null && "value" in val[0]) {
                    let runT = targetDelay;
                    for (let k = 0; k < val.length; k++) {
                        const kf2 = val[k];
                        const prevKf2 = k === 0 ? null : val[k - 1];
                        const kfD2 = kf2.duration !== undefined ? kf2.duration : (self.globalDuration / val.length);
                        const kfDel2 = kf2.delay || 0;
                        const kfEnd2 = kf2.endDelay || 0;
                        const kfE2 = kf2.easing ? getEasingFunction(kf2.easing) : self.globalEasing;
                        const st2 = runT + kfDel2;
                        const fRaw = prevKf2 ? prevKf2.value : self._getCurrentValue(target, prop2);
                        let tRaw = typeof kf2.value === "function" ? kf2.value(targetIndex, totalTargets) : kf2.value;
                        if (typeof tRaw === "string" && RELATIVE_RE.test(tRaw)) {
                            tRaw = utils.calcRelativeValue(fRaw, tRaw);
                        }
                        self.tweens.push({
                            target: target, prop: prop2,
                            type: self._getPropertyType(target, prop2),
                            from: utils.decomposeValue(fRaw),
                            to: utils.decomposeValue(tRaw),
                            startTime: st2, duration: kfD2, easing: kfE2
                        });
                        runT = st2 + kfD2 + kfEnd2;
                        if (runT > maxEndTime) { maxEndTime = runT; }
                    }
                    continue;
                }

                let fromVal, toVal;
                if (Array.isArray(val)) {
                    if (val.length === 1) {
                        fromVal = self._getCurrentValue(target, prop2); toVal = val[0];
                    } else if (val.length === 2) {
                        fromVal = val[0]; toVal = val[1];
                    } else {
                        const stepDur = self.globalDuration / (val.length - 1);
                        for (let k2 = 0; k2 < val.length - 1; k2++) {
                            const f2 = val[k2];
                            let t2 = val[k2 + 1];
                            if (typeof t2 === "string" && RELATIVE_RE.test(t2)) {
                                t2 = utils.calcRelativeValue(f2, t2);
                            }
                            const st3 = targetDelay + k2 * stepDur;
                            self.tweens.push({
                                target: target, prop: prop2,
                                type: self._getPropertyType(target, prop2),
                                from: utils.decomposeValue(f2),
                                to: utils.decomposeValue(t2),
                                startTime: st3, duration: stepDur, easing: self.globalEasing
                            });
                            if (st3 + stepDur > maxEndTime) { maxEndTime = st3 + stepDur; }
                        }
                        continue;
                    }
                } else if (typeof val === "string" && RELATIVE_RE.test(val)) {
                    fromVal = self._getCurrentValue(target, prop2);
                    toVal = utils.calcRelativeValue(fromVal, val);
                } else if (typeof val === "function") {
                    fromVal = self._getCurrentValue(target, prop2);
                    toVal = val(targetIndex, totalTargets);
                } else {
                    fromVal = self._getCurrentValue(target, prop2);
                    toVal = val;
                }

                const endTime = targetDelay + self.globalDuration;
                if (endTime > maxEndTime) { maxEndTime = endTime; }
                self.tweens.push({
                    target: target, prop: prop2,
                    type: self._getPropertyType(target, prop2),
                    from: utils.decomposeValue(fromVal),
                    to: utils.decomposeValue(toVal),
                    startTime: targetDelay, duration: self.globalDuration,
                    easing: self.globalDuration === 0 ? function (t) { return t; } : self.globalEasing
                });
            }
        });

        this.duration = maxEndTime;
        this.delay = minDelay === Infinity ? 0 : minDelay;
    }

    /**
     * Group tweens by (target, prop) ONCE. The original rebuilt these Maps and
     * arrays every frame; the tween set is immutable after init, so grouping
     * is hoisted here — `_renderFrame` is now allocation-free.
     */
    _buildGroups() {
        const groups = this._groups;
        groups.length = 0;
        this._transformTargets.length = 0;
        this._propMap.clear();
        this._transformMap.clear();

        for (let i = 0; i < this.tweens.length; i++) {
            const tw = this.tweens[i];
            let tMap = this._propMap.get(tw.target);
            if (!tMap) { tMap = new Map(); this._propMap.set(tw.target, tMap); }
            let g = tMap.get(tw.prop);
            if (!g) {
                g = { target: tw.target, prop: tw.prop, type: tw.type, tweens: [], tf: null };
                tMap.set(tw.prop, g);
                groups.push(g);
            }
            g.tweens.push(tw);
        }

        for (let i = 0; i < groups.length; i++) {
            const g = groups[i];
            if (g.type !== "transform") { continue; }
            let rec = this._transformMap.get(g.target);
            if (!rec) {
                rec = { target: g.target, values: {} };
                this._transformMap.set(g.target, rec);
                this._transformTargets.push(rec);
            }
            g.tf = rec;
        }
        return this;
    }

    _getPropertyType(target, prop) {
        if (typeof HTMLElement !== "undefined" && target instanceof HTMLElement) {
            if (prop.indexOf("--") === 0) { return "cssVar"; }
            if (TRANSFORM_PROPS.has(prop)) { return "transform"; }
            if (target.style && prop in target.style) { return "css"; }
            if (target.hasAttribute && target.hasAttribute(prop)) { return "attribute"; }
        }
        if (typeof SVGElement !== "undefined" && target instanceof SVGElement) {
            if (prop.indexOf("--") === 0) { return "cssVar"; }
            if (TRANSFORM_PROPS.has(prop)) { return "transform"; }
            if (target.style && prop in target.style) { return "css"; }
            return "svgAttribute";
        }
        return "object";
    }

    _getCurrentValue(target, prop) {
        const type = this._getPropertyType(target, prop);
        if (type === "transform") {
            target._studioTransforms = target._studioTransforms || {};
            if (target._studioTransforms[prop] !== undefined) { return target._studioTransforms[prop]; }
            if (prop.indexOf("scale") === 0) { return 1; }
            return 0;
        }
        if (type === "cssVar") {
            if (typeof window !== "undefined" && typeof getComputedStyle === "function") {
                const val = getComputedStyle(target).getPropertyValue(prop).trim();
                return val || 0;
            }
            return 0;
        }
        if (type === "css") {
            if (typeof window !== "undefined" && typeof getComputedStyle === "function") {
                const v2 = target.style[prop] || getComputedStyle(target)[prop];
                return v2 !== undefined ? v2 : 0;
            }
            return 0;
        }
        if (type === "attribute" || type === "svgAttribute") {
            return target.getAttribute(prop) || 0;
        }
        return target[prop] !== undefined ? target[prop] : 0;
    }

    play() {
        this.isRunning = true;
        this.completed = false;
        this.lastStepTime = nowMs();
        this._renderFrame(this.progress);
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
        this.progress = 0;
        this.began = false;
        this.completed = false;
        this.isReversed = this.direction === "reverse";
        this.play();
        return this;
    }

    reverse() { this.isReversed = !this.isReversed; return this; }

    seek(progressRatio) {
        this.progress = utils.clamp(progressRatio, 0, 1);
        this.currentTime = this.progress * (this.duration + this.endDelay);
        this._renderFrame(this.progress);
        return this;
    }

    /**
     * Advance one step. `deltaMs` is supplied by the 016 engine; when omitted
     * the animation self-times (standalone usage).
     */
    _step(deltaMs) {
        if (!this.isRunning) { return; }
        const now = nowMs();
        const raw = typeof deltaMs === "number" ? deltaMs : (now - (this.lastStepTime || now));
        const dt = Math.min(64, Math.max(0, raw)) * this.timeScale;
        this.lastStepTime = now;

        if (!this.began) {
            this.began = true;
            if (this.onBegin) { this.onBegin(this); }
        }

        const totalTime = this.duration + this.endDelay;
        this.currentTime += dt;
        let animProgress = totalTime > 0 ? utils.clamp(this.currentTime / totalTime, 0, 1) : 1;
        if (this.isReversed) { animProgress = 1 - animProgress; }
        this.progress = animProgress;
        this._renderFrame(this.progress);
        if (this.onUpdate) { this.onUpdate(this); }

        if (this.currentTime >= totalTime) {
            if (this.loop) {
                if (typeof this.loop === "number") {
                    this.loop--;
                    if (this.loop <= 0) { this._complete(); return; }
                }
                if (this.direction === "alternate") { this.isReversed = !this.isReversed; }
                this.currentTime = 0;
                if (this.onLoop) { this.onLoop(this); }
            } else {
                this._complete();
            }
        }
    }

    /** Chunked variant — renders huge tween sets without blocking the UI. */
    async stepChunked(deltaMs, chunkSize, yieldEvery) {
        if (!this.isRunning) { return this; }
        const now = nowMs();
        const raw = typeof deltaMs === "number" ? deltaMs : (now - (this.lastStepTime || now));
        const dt = Math.min(64, Math.max(0, raw)) * this.timeScale;
        this.lastStepTime = now;

        if (!this.began) {
            this.began = true;
            if (this.onBegin) { this.onBegin(this); }
        }
        const totalTime = this.duration + this.endDelay;
        this.currentTime += dt;
        let animProgress = totalTime > 0 ? utils.clamp(this.currentTime / totalTime, 0, 1) : 1;
        if (this.isReversed) { animProgress = 1 - animProgress; }
        this.progress = animProgress;
        await this._renderFrameChunked(this.progress, chunkSize, yieldEvery);
        if (this.onUpdate) { this.onUpdate(this); }

        if (this.currentTime >= totalTime) {
            if (this.loop) {
                if (typeof this.loop === "number") {
                    this.loop--;
                    if (this.loop <= 0) { this._complete(); return this; }
                }
                if (this.direction === "alternate") { this.isReversed = !this.isReversed; }
                this.currentTime = 0;
                if (this.onLoop) { this.onLoop(this); }
            } else {
                this._complete();
            }
        }
        return this;
    }

    _complete() {
        this.completed = true;
        this.isRunning = false;
        GlobalEngine.remove(this);
        if (this.onComplete) { this.onComplete(this); }
    }

    /** Resolve the active tween + local progress for a group at `elapsed`. */
    _resolveGroup(list, elapsed) {
        const first = list[0], last = list[list.length - 1];
        if (elapsed >= last.startTime + last.duration) {
            this._activeTween = last; this._activeP = 1; return;
        }
        if (elapsed <= first.startTime) {
            this._activeTween = first; this._activeP = 0; return;
        }
        for (let idx = 0; idx < list.length; idx++) {
            const tw = list[idx];
            const end = tw.startTime + tw.duration;
            if (elapsed >= tw.startTime && elapsed <= end) {
                this._activeTween = tw;
                this._activeP = tw.duration > 0 ? (elapsed - tw.startTime) / tw.duration : 1;
                return;
            }
            if (idx < list.length - 1 && elapsed > end && elapsed < list[idx + 1].startTime) {
                this._activeTween = tw; this._activeP = 1; return;
            }
        }
        this._activeTween = last; this._activeP = 1;
    }

    _applyGroup(g, elapsed) {
        this._resolveGroup(g.tweens, elapsed);
        const active = this._activeTween;
        const eased = active.easing(this._activeP);
        const val = utils.interpolateDecomposed(active.from, active.to, eased, this.round);
        const target = g.target;
        if (g.type === "transform") {
            g.tf.values[g.prop] = val;
        } else if (g.type === "css") {
            target.style[g.prop] = val;
        } else if (g.type === "cssVar") {
            target.style.setProperty(g.prop, String(val));
        } else if (g.type === "svgAttribute" || g.type === "attribute") {
            target.setAttribute(g.prop, String(val));
        } else {
            target[g.prop] = typeof val === "string" ? (parseFloat(val) || val) : val;
        }
    }

    _flushTransforms() {
        const recs = this._transformTargets;
        for (let i = 0; i < recs.length; i++) {
            const target = recs[i].target;
            const values = recs[i].values;
            const tf = target._studioTransforms || (target._studioTransforms = {});
            for (const k in values) { tf[k] = values[k]; }
            let str = "";
            if (tf.perspective !== undefined) { str += "perspective(" + tf.perspective + "px) "; }
            if (tf.translateX !== undefined || tf.translateY !== undefined || tf.translateZ !== undefined) {
                const x = tf.translateX !== undefined ? (typeof tf.translateX === "number" ? tf.translateX + "px" : tf.translateX) : "0px";
                const y = tf.translateY !== undefined ? (typeof tf.translateY === "number" ? tf.translateY + "px" : tf.translateY) : "0px";
                const z = tf.translateZ !== undefined ? (typeof tf.translateZ === "number" ? tf.translateZ + "px" : tf.translateZ) : "0px";
                str += "translate3d(" + x + ", " + y + ", " + z + ") ";
            }
            if (tf.rotateX !== undefined) { str += "rotateX(" + (typeof tf.rotateX === "number" ? tf.rotateX + "deg" : tf.rotateX) + ") "; }
            if (tf.rotateY !== undefined) { str += "rotateY(" + (typeof tf.rotateY === "number" ? tf.rotateY + "deg" : tf.rotateY) + ") "; }
            if (tf.rotateZ !== undefined) { str += "rotateZ(" + (typeof tf.rotateZ === "number" ? tf.rotateZ + "deg" : tf.rotateZ) + ") "; }
            if (tf.rotate !== undefined) { str += "rotate(" + (typeof tf.rotate === "number" ? tf.rotate + "deg" : tf.rotate) + ") "; }
            if (tf.scale !== undefined) { str += "scale(" + tf.scale + ") "; }
            else if (tf.scaleX !== undefined || tf.scaleY !== undefined || tf.scaleZ !== undefined) {
                str += "scale3d(" + (tf.scaleX !== undefined ? tf.scaleX : 1) + ", " +
                    (tf.scaleY !== undefined ? tf.scaleY : 1) + ", " +
                    (tf.scaleZ !== undefined ? tf.scaleZ : 1) + ") ";
            }
            if (tf.skewX !== undefined) { str += "skewX(" + (typeof tf.skewX === "number" ? tf.skewX + "deg" : tf.skewX) + ") "; }
            if (tf.skewY !== undefined) { str += "skewY(" + (typeof tf.skewY === "number" ? tf.skewY + "deg" : tf.skewY) + ") "; }
            if (target.style) { target.style.transform = str.trim(); }
        }
    }

    /** Zero-GC render: groups are prebuilt, no Map / array creation per frame. */
    _renderFrame(progressRatio) {
        const elapsed = progressRatio * (this.duration + this.endDelay);
        const groups = this._groups;
        for (let i = 0; i < groups.length; i++) { this._applyGroup(groups[i], elapsed); }
        this._flushTransforms();
        if (this.onRender) { this.onRender(this); }
    }

    async _renderFrameChunked(progressRatio, chunkSize, yieldEvery) {
        const elapsed = progressRatio * (this.duration + this.endDelay);
        const groups = this._groups;
        const self = this;
        await _chunkedRange(groups.length, chunkSize, yieldEvery, function (s, e) {
            for (let i = s; i < e; i++) { self._applyGroup(groups[i], elapsed); }
        });
        this._flushTransforms();
        if (this.onRender) { this.onRender(this); }
        return this;
    }

    dispose() {
        this.pause();
        this.tweens.length = 0;
        this._groups.length = 0;
        this._transformTargets.length = 0;
        this._propMap.clear();
        this._transformMap.clear();
        this.targets.length = 0;
    }
}

// ============================================================================
// 3. POOL — zero-GC reuse of Animation instances
// ============================================================================
const _animPool = createPool(
    function () {
        const a = Object.create(Animation.prototype);
        a._transformMap = new Map();
        a._propMap = new Map();
        a._groups = [];
        a._transformTargets = [];
        a.tweens = [];
        a.targets = [];
        return a;
    },
    POOL_PREALLOC,
    function (a) {
        a.config = null;
        a.currentTime = 0;
        a.progress = 0;
        a.isRunning = false;
        a.began = false;
        a.completed = false;
        a.onBegin = a.onUpdate = a.onRender = a.onLoop = a.onComplete = null;
        if (a.targets) { a.targets.length = 0; }
        if (a.tweens) { a.tweens.length = 0; }
        if (a._groups) { a._groups.length = 0; }
        if (a._transformTargets) { a._transformTargets.length = 0; }
        if (a._transformMap) { a._transformMap.clear(); }
        if (a._propMap) { a._propMap.clear(); }
    }
);

function acquireAnimation(config) {
    const a = _animPool.acquire();
    a._init(config || {});
    return a;
}

function releaseAnimation(a) {
    a.pause();
    _animPool.release(a);
}

// ============================================================================
// 4. SOA ANIMATION TRACK — 1M+ per-element tweens per frame
// ============================================================================
class SOAAnimationTrack {
    constructor(count, options) {
        options = options || {};
        this.count = count;
        this.from = options.from instanceof Float32Array ? options.from : new Float32Array(count);
        this.to = options.to instanceof Float32Array ? options.to : new Float32Array(count);
        this.current = new Float32Array(count);
        this.ts = new Float32Array(count);
        this.delays = new Float32Array(count);
        this.durations = new Float32Array(count);
        this.finished = new Uint8Array(count);
        this.ease = options.ease ? easings.getEasing(options.ease) : easings.easeOutCubic;
        this.onElementDone = options.onElementDone || null;
        this.done = false;
        this._lut = null;
        this._initFromTargets();
    }

    _initFromTargets() {
        const n = this.count;
        for (let i = 0; i < n; i++) {
            const d = this.durations[i] || 0;
            if (d <= 0) { this.current[i] = this.to[i]; this.ts[i] = 1; }
            else { this.current[i] = this.from[i]; this.ts[i] = 0; }
        }
    }

    fillUniform(fromV, toV, duration, delay) {
        delay = delay || 0;
        this.from.fill(fromV);
        this.to.fill(toV);
        this.durations.fill(duration);
        this.delays.fill(delay);
        this.finished.fill(0);
        this._initFromTargets();
        this.done = false;
        return this;
    }

    async fillUniformChunked(fromV, toV, duration, delay, chunkSize, yieldEvery) {
        delay = delay || 0;
        const from = this.from, to = this.to, dur = this.durations, del = this.delays;
        const fin = this.finished, cur = this.current, ts = this.ts;
        await _chunkedRange(this.count, chunkSize, yieldEvery, function (s, e) {
            for (let i = s; i < e; i++) {
                from[i] = fromV; to[i] = toV; dur[i] = duration; del[i] = delay;
                fin[i] = 0;
                if (duration <= 0) { cur[i] = toV; ts[i] = 1; } else { cur[i] = fromV; ts[i] = 0; }
            }
        });
        this.done = false;
        return this;
    }

    setElement(i, fromV, toV, duration, delay) {
        this.from[i] = fromV;
        this.to[i] = toV;
        this.durations[i] = duration;
        this.delays[i] = delay || 0;
        this.finished[i] = 0;
        this.current[i] = fromV;
        this.ts[i] = 0;
        this.done = false;
        return this;
    }

    setEase(e) {
        this.ease = easings.getEasing(e);
        if (this._lut) { this._lut = easings.bakeEasingLUT(this.ease, this._lut.length - 1); }
        return this;
    }

    /** Bake the curve into a LUT: one table tap per element instead of a call. */
    useLUT(size) {
        this._lut = easings.bakeEasingLUT(this.ease, size || 1024);
        return this;
    }

    clearLUT() { this._lut = null; return this; }

    reset() {
        this.finished.fill(0);
        this.ts.fill(0);
        this._initFromTargets();
        this.done = false;
        return this;
    }

    _stepRange(s, e, dtSec) {
        const from = this.from, to = this.to, cur = this.current, ts = this.ts;
        const dur = this.durations, del = this.delays, fin = this.finished;
        const ease = this.ease, lut = this._lut;
        const onDone = this.onElementDone;
        const lutN = lut ? lut.length - 1 : 0;
        let doneCount = 0;
        for (let i = s; i < e; i++) {
            if (fin[i]) { doneCount++; continue; }
            if (del[i] > 0) { del[i] -= dtSec; if (del[i] > 0) { continue; } }
            const d = dur[i];
            let t;
            if (d <= 0) { t = 1; }
            else { t = ts[i] + dtSec / d; if (t > 1) { t = 1; } }
            ts[i] = t;
            let et;
            if (lut) {
                if (t <= 0) { et = lut[0]; }
                else if (t >= 1) { et = lut[lutN]; }
                else { const x = t * lutN, k = x | 0; et = lut[k] + (lut[k + 1] - lut[k]) * (x - k); }
            } else { et = ease(t); }
            cur[i] = from[i] + (to[i] - from[i]) * et;
            if (t >= 1) {
                fin[i] = 1;
                doneCount++;
                if (onDone) { onDone(i, this); }
            }
        }
        return doneCount;
    }

    step(dtSec) {
        const doneCount = this._stepRange(0, this.count, dtSec);
        if (doneCount === this.count) { this.done = true; }
        return this;
    }

    async stepChunked(dtSec, chunkSize, yieldEvery) {
        chunkSize = chunkSize || CHUNK_SIZE;
        yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
        const self = this;
        let doneCount = 0, chunks = 0;
        const n = this.count;
        for (let start = 0; start < n; start += chunkSize) {
            const end = Math.min(start + chunkSize, n);
            doneCount += self._stepRange(start, end, dtSec);
            if (++chunks >= yieldEvery) { chunks = 0; await yieldToMain(); }
        }
        if (doneCount === n) { this.done = true; }
        return this;
    }

    applyTo(dst) { dst.set(this.current); return dst; }

    /** Write into a vec-SOA channel (`{x: Float32Array}`) or a plain array. */
    applyToSOA(dst) {
        const ch = dst && dst.x ? dst.x : dst;
        ch.set(this.current);
        return dst;
    }

    applyToEntities(dst, eids) {
        const n = eids.length < this.count ? eids.length : this.count;
        for (let i = 0; i < n; i++) { dst[eids[i]] = this.current[i]; }
        return dst;
    }
}

function createSOAAnimationTrack(count, options) {
    return new SOAAnimationTrack(count, options);
}

// ============================================================================
// 5. EXTENDED PROPERTY HELPERS (vec3 / vec4 / quat / mat4 / HDR color)
// ============================================================================
function animateVec3(out, a, b, t) { return vec3.lerp(out, a, b, t); }
function animateVec4(out, a, b, t) { return vec4.lerp(out, a, b, t); }
function animateQuat(out, a, b, t) { return quat.slerp(out, a, b, t); }

function animateColor(out, a, b, t, easeFn) {
    const et = easeFn ? easeFn(t) : t;
    out[0] = a[0] + (b[0] - a[0]) * et;
    out[1] = a[1] + (b[1] - a[1]) * et;
    out[2] = a[2] + (b[2] - a[2]) * et;
    out[3] = a[3] + (b[3] - a[3]) * et;
    return out;
}

/** Zero-GC TRS blend: module temporaries only, no per-call array literals. */
function animateTRS(outMat, fromTRS, toTRS, t, easeFn) {
    const et = easeFn ? easeFn(t) : t;
    const fp = fromTRS.position, tp = toTRS.position;
    const fs = fromTRS.scale, ts = toTRS.scale;
    _tmpVec3A[0] = fp[0] + (tp[0] - fp[0]) * et;
    _tmpVec3A[1] = fp[1] + (tp[1] - fp[1]) * et;
    _tmpVec3A[2] = fp[2] + (tp[2] - fp[2]) * et;
    quat.slerp(_tmpQuat4, fromTRS.rotation, toTRS.rotation, et);
    _tmpVec3B[0] = fs[0] + (ts[0] - fs[0]) * et;
    _tmpVec3B[1] = fs[1] + (ts[1] - fs[1]) * et;
    _tmpVec3B[2] = fs[2] + (ts[2] - fs[2]) * et;
    return mat4.fromRotationTranslationScale(outMat, _tmpQuat4, _tmpVec3A, _tmpVec3B);
}

// ============================================================================
// 6. BITECS COMPONENT-CHANNEL ANIMATION
// ============================================================================
function createECSChannelAnimation(eids, channel, from, to, duration, ease) {
    const n = eids.length;
    const track = new SOAAnimationTrack(n, { ease: ease });
    for (let i = 0; i < n; i++) {
        track.setElement(
            i,
            typeof from === "function" ? from(eids[i], i) : from,
            typeof to === "function" ? to(eids[i], i) : to,
            typeof duration === "function" ? duration(eids[i], i) : duration,
            0
        );
    }
    return {
        track: track,
        step(dt) { return track.step(dt); },
        stepChunked(dt, cs, ye) { return track.stepChunked(dt, cs, ye); },
        apply() { return track.applyToEntities(channel, eids); },
        get done() { return track.done; }
    };
}

function createECSChannelAnimationStaggered(eids, channel, from, to, duration, staggerFn, ease) {
    const n = eids.length;
    const track = new SOAAnimationTrack(n, { ease: ease });
    for (let i = 0; i < n; i++) {
        const delay = staggerFn ? staggerFn(i, n) * duration : 0;
        track.setElement(
            i,
            typeof from === "function" ? from(eids[i], i) : from,
            typeof to === "function" ? to(eids[i], i) : to,
            duration,
            delay
        );
    }
    return {
        track: track,
        step(dt) { return track.step(dt); },
        stepChunked(dt, cs, ye) { return track.stepChunked(dt, cs, ye); },
        apply() { return track.applyToEntities(channel, eids); },
        get done() { return track.done; }
    };
}

// ============================================================================
// 7. IK ANIMATION HELPERS
// ============================================================================
function createIKTargetAnimation(chain, from, to, duration, ease) {
    const easeFn = easings.getEasing(ease || "easeOutCubic");
    const track = new SOAAnimationTrack(3, { ease: easeFn });
    track.setElement(0, from[0], to[0], duration, 0);
    track.setElement(1, from[1], to[1], duration, 0);
    track.setElement(2, from[2], to[2], duration, 0);
    const hasSetter = chain && typeof chain.setTarget === "function";
    const chainIndex = chain && chain.index !== undefined ? chain.index : 0;
    return {
        track: track,
        step(dt) {
            track.step(dt);
            const c = track.current;
            if (hasSetter) { chain.setTarget(chainIndex, c[0], c[1], c[2]); }
            else if (chain && chain.target) {
                chain.target[0] = c[0]; chain.target[1] = c[1]; chain.target[2] = c[2];
            }
            return track.done;
        },
        async stepChunked(dt, cs, ye) {
            await track.stepChunked(dt, cs, ye);
            const c = track.current;
            if (hasSetter) { chain.setTarget(chainIndex, c[0], c[1], c[2]); }
            else if (chain && chain.target) {
                chain.target[0] = c[0]; chain.target[1] = c[1]; chain.target[2] = c[2];
            }
            return track.done;
        },
        get done() { return track.done; }
    };
}

// ============================================================================
// 8. ORBITAL ANIMATION HELPERS
// ============================================================================
function _orbitalChannel(elements, key, index, v0, v1, duration, ease) {
    const track = new SOAAnimationTrack(1, { ease: ease });
    track.setElement(0, v0, v1, duration, 0);
    return {
        track: track,
        step(dt) { track.step(dt); elements[key][index] = track.current[0]; return track.done; },
        async stepChunked(dt, cs, ye) {
            await track.stepChunked(dt, cs, ye);
            elements[key][index] = track.current[0];
            return track.done;
        },
        get done() { return track.done; }
    };
}

function createOrbitalMAnimation(elements, index, M0, M1, duration, ease) {
    return _orbitalChannel(elements, "M", index, M0, M1, duration, ease || "linear");
}
function createOrbitalAAnimation(elements, index, a0, a1, duration, ease) {
    return _orbitalChannel(elements, "a", index, a0, a1, duration, ease || "easeInOutCubic");
}
function createOrbitalEAnimation(elements, index, e0, e1, duration, ease) {
    return _orbitalChannel(elements, "e", index, e0, e1, duration, ease || "easeInOutCubic");
}
function createOrbitalIncAnimation(elements, index, i0, i1, duration, ease) {
    return _orbitalChannel(elements, "inc", index, i0, i1, duration, ease || "easeInOutCubic");
}

// ============================================================================
// 9. HDR COLOR ANIMATION (SOA) — never clamps, exposure pipelines stay intact
// ============================================================================
function createColorSOAAnimation(colors, fromColor, toColor, duration, ease, eids) {
    const n = eids ? eids.length : colors.count;
    const easeFn = easings.getEasing(ease || "easeOutCubic");
    const track = new SOAAnimationTrack(n, { ease: easeFn });
    track.fillUniform(0, 1, duration, 0);
    const dx = toColor[0] - fromColor[0];
    const dy = toColor[1] - fromColor[1];
    const dz = toColor[2] - fromColor[2];
    const dw = toColor[3] - fromColor[3];

    function apply() {
        const cx = colors.x, cy = colors.y, cz = colors.z, cw = colors.w;
        const cur = track.current;
        if (eids) {
            for (let i = 0; i < n; i++) {
                const e = eids[i], et = cur[i];
                cx[e] = fromColor[0] + dx * et;
                cy[e] = fromColor[1] + dy * et;
                cz[e] = fromColor[2] + dz * et;
                cw[e] = fromColor[3] + dw * et;
            }
        } else {
            for (let i = 0; i < n; i++) {
                const et = cur[i];
                cx[i] = fromColor[0] + dx * et;
                cy[i] = fromColor[1] + dy * et;
                cz[i] = fromColor[2] + dz * et;
                cw[i] = fromColor[3] + dw * et;
            }
        }
    }

    return {
        track: track,
        step(dt) { track.step(dt); apply(); return track.done; },
        async stepChunked(dt, cs, ye) { await track.stepChunked(dt, cs, ye); apply(); return track.done; },
        get done() { return track.done; }
    };
}

// ============================================================================
// 10. VECTOR / QUATERNION / TRS / MATRIX SOA ANIMATION (1M+ instances)
// ============================================================================
function _progressTrack(n, duration, ease, options) {
    const track = new SOAAnimationTrack(n, { ease: ease || "easeOutCubic" });
    track.fillUniform(0, 1, duration, (options && options.delay) || 0);
    if (options && typeof options.stagger === "function") {
        const spread = options.spread !== undefined ? options.spread : duration;
        for (let i = 0; i < n; i++) { track.setElement(0, 1, duration, options.stagger(i, n) * spread); }
    }
    if (options && options.lut) { track.useLUT(options.lut === true ? 1024 : options.lut); }
    return track;
}

function createVec3SOAAnimation(out, from, to, duration, ease, options) {
    const n = out.count;
    const track = _progressTrack(n, duration, ease, options);
    const ox = out.x, oy = out.y, oz = out.z;
    const fx = from.x, fy = from.y, fz = from.z;
    const tx = to.x, ty = to.y, tz = to.z;

    function apply() {
        const cur = track.current;
        for (let i = 0; i < n; i++) {
            const et = cur[i];
            ox[i] = fx[i] + (tx[i] - fx[i]) * et;
            oy[i] = fy[i] + (ty[i] - fy[i]) * et;
            oz[i] = fz[i] + (tz[i] - fz[i]) * et;
        }
    }
    return {
        track: track,
        step(dt) { track.step(dt); apply(); return track.done; },
        async stepChunked(dt, cs, ye) { await track.stepChunked(dt, cs, ye); apply(); return track.done; },
        get done() { return track.done; }
    };
}

function createVec4SOAAnimation(out, from, to, duration, ease, options) {
    const n = out.count;
    const track = _progressTrack(n, duration, ease, options);
    const ox = out.x, oy = out.y, oz = out.z, ow = out.w;
    const fx = from.x, fy = from.y, fz = from.z, fw = from.w;
    const tx = to.x, ty = to.y, tz = to.z, tw = to.w;

    function apply() {
        const cur = track.current;
        for (let i = 0; i < n; i++) {
            const et = cur[i];
            ox[i] = fx[i] + (tx[i] - fx[i]) * et;
            oy[i] = fy[i] + (ty[i] - fy[i]) * et;
            oz[i] = fz[i] + (tz[i] - fz[i]) * et;
            ow[i] = fw[i] + (tw[i] - fw[i]) * et;
        }
    }
    return {
        track: track,
        step(dt) { track.step(dt); apply(); return track.done; },
        async stepChunked(dt, cs, ye) { await track.stepChunked(dt, cs, ye); apply(); return track.done; },
        get done() { return track.done; }
    };
}

/** Eased shortest-arc slerp across 1M+ orientations. */
function createQuatSOAAnimation(out, from, to, duration, ease, options) {
    const n = out.count;
    const track = _progressTrack(n, duration, ease, options);
    const ox = out.x, oy = out.y, oz = out.z, ow = out.w;
    const ax = from.x, ay = from.y, az = from.z, aw = from.w;
    const bx = to.x, by = to.y, bz = to.z, bw = to.w;

    function apply() {
        const cur = track.current;
        for (let i = 0; i < n; i++) {
            const tt = cur[i];
            const qx = ax[i], qy = ay[i], qz = az[i], qw = aw[i];
            let rx = bx[i], ry = by[i], rz = bz[i], rw = bw[i];
            let cosom = qx * rx + qy * ry + qz * rz + qw * rw;
            if (cosom < 0) { cosom = -cosom; rx = -rx; ry = -ry; rz = -rz; rw = -rw; }
            let s0, s1;
            if (1 - cosom > EPSILON) {
                const omega = Math.acos(cosom), sinom = Math.sin(omega);
                s0 = Math.sin((1 - tt) * omega) / sinom;
                s1 = Math.sin(tt * omega) / sinom;
            } else { s0 = 1 - tt; s1 = tt; }
            ox[i] = s0 * qx + s1 * rx;
            oy[i] = s0 * qy + s1 * ry;
            oz[i] = s0 * qz + s1 * rz;
            ow[i] = s0 * qw + s1 * rw;
        }
    }
    return {
        track: track,
        step(dt) { track.step(dt); apply(); return track.done; },
        async stepChunked(dt, cs, ye) { await track.stepChunked(dt, cs, ye); apply(); return track.done; },
        get done() { return track.done; }
    };
}

/**
 * Eased TRS blend across 1M+ instances: position lerp + quaternion slerp +
 * scale lerp, optionally composed straight into a mat4 SOA for GPU upload.
 */
function createTRSSOAAnimation(trs, fromTRS, toTRS, duration, ease, options) {
    options = options || {};
    const n = trs.position.count;
    const track = _progressTrack(n, duration, ease, options);
    const matrices = options.matrices || null;

    const opx = trs.position.x, opy = trs.position.y, opz = trs.position.z;
    const fpx = fromTRS.position.x, fpy = fromTRS.position.y, fpz = fromTRS.position.z;
    const tpx = toTRS.position.x, tpy = toTRS.position.y, tpz = toTRS.position.z;
    const osx = trs.scale.x, osy = trs.scale.y, osz = trs.scale.z;
    const fsx = fromTRS.scale.x, fsy = fromTRS.scale.y, fsz = fromTRS.scale.z;
    const tsx = toTRS.scale.x, tsy = toTRS.scale.y, tsz = toTRS.scale.z;
    const oqx = trs.rotation.x, oqy = trs.rotation.y, oqz = trs.rotation.z, oqw = trs.rotation.w;
    const fqx = fromTRS.rotation.x, fqy = fromTRS.rotation.y, fqz = fromTRS.rotation.z, fqw = fromTRS.rotation.w;
    const tqx = toTRS.rotation.x, tqy = toTRS.rotation.y, tqz = toTRS.rotation.z, tqw = toTRS.rotation.w;

    function apply() {
        const cur = track.current;
        for (let i = 0; i < n; i++) {
            const et = cur[i];
            opx[i] = fpx[i] + (tpx[i] - fpx[i]) * et;
            opy[i] = fpy[i] + (tpy[i] - fpy[i]) * et;
            opz[i] = fpz[i] + (tpz[i] - fpz[i]) * et;
            osx[i] = fsx[i] + (tsx[i] - fsx[i]) * et;
            osy[i] = fsy[i] + (tsy[i] - fsy[i]) * et;
            osz[i] = fsz[i] + (tsz[i] - fsz[i]) * et;

            const ax = fqx[i], ay = fqy[i], az = fqz[i], aw = fqw[i];
            let bx = tqx[i], by = tqy[i], bz = tqz[i], bw = tqw[i];
            let cosom = ax * bx + ay * by + az * bz + aw * bw;
            if (cosom < 0) { cosom = -cosom; bx = -bx; by = -by; bz = -bz; bw = -bw; }
            let s0, s1;
            if (1 - cosom > EPSILON) {
                const omega = Math.acos(cosom), sinom = Math.sin(omega);
                s0 = Math.sin((1 - et) * omega) / sinom;
                s1 = Math.sin(et * omega) / sinom;
            } else { s0 = 1 - et; s1 = et; }
            oqx[i] = s0 * ax + s1 * bx;
            oqy[i] = s0 * ay + s1 * by;
            oqz[i] = s0 * az + s1 * bz;
            oqw[i] = s0 * aw + s1 * bw;
        }
        if (matrices) { mat4.soaComposeTRS(matrices, trs.position, trs.rotation, trs.scale); }
    }

    return {
        track: track,
        trs: trs,
        matrices: matrices,
        step(dt) { track.step(dt); apply(); return track.done; },
        async stepChunked(dt, cs, ye) { await track.stepChunked(dt, cs, ye); apply(); return track.done; },
        get done() { return track.done; }
    };
}

/** Eased mat4 TRS blend across a mat4 SOA (uses module temporaries). */
function createMat4SOAAnimation(out, fromMats, toMats, duration, ease, options) {
    const n = out.count;
    const track = _progressTrack(n, duration, ease, options);
    function apply() {
        const cur = track.current;
        for (let i = 0; i < n; i++) {
            mat4.soaGet(_tmpMatA, fromMats, i);
            mat4.soaGet(_tmpMatB, toMats, i);
            mat4.blendTRS(_tmpMatOut, _tmpMatA, _tmpMatB, cur[i]);
            mat4.soaSet(out, i, _tmpMatOut);
        }
    }
    return {
        track: track,
        step(dt) { track.step(dt); apply(); return track.done; },
        async stepChunked(dt, cs, ye) { await track.stepChunked(dt, cs, ye); apply(); return track.done; },
        get done() { return track.done; }
    };
}

// ============================================================================
// 11. PROCEDURAL / SIMPLEX-DRIVEN ANIMATION
// ============================================================================
let simplex = null;
function _fallbackNoise3(x, y, z) { return vec3.gradientNoise3D(x, y, z); }

function createNoiseDrivenAnimation(positions, outAmplitude, options) {
    options = options || {};
    const noiseFn = options.noiseFn ||
        (simplex ? simplex.acquireNoise3D(options.seed) : _fallbackNoise3);
    const scale = options.scale !== undefined ? options.scale : 0.01;
    const speed = options.speed !== undefined ? options.speed : 0.5;
    const gain = options.gain !== undefined ? options.gain : 1;
    let time = 0;

    function run(dt) {
        time += dt * speed;
        const n = positions.count;
        const px = positions.x, py = positions.y, pz = positions.z;
        for (let i = 0; i < n; i++) {
            outAmplitude[i] = noiseFn(px[i] * scale, py[i] * scale, pz[i] * scale + time) * gain;
        }
        return true;
    }

    return {
        step(dt) { return run(dt); },
        async stepChunked(dt, chunkSize, yieldEvery) {
            time += dt * speed;
            const n = positions.count;
            const px = positions.x, py = positions.y, pz = positions.z;
            await _chunkedRange(n, chunkSize, yieldEvery, function (s, e) {
                for (let i = s; i < e; i++) {
                    outAmplitude[i] = noiseFn(px[i] * scale, py[i] * scale, pz[i] * scale + time) * gain;
                }
            });
            return true;
        },
        get time() { return time; }
    };
}

// ============================================================================
// 12. THREE.JS r185 INTEROP (duck-typed — no three import, no CDN, no build)
// ============================================================================
function animateThreeVector3(v, a, b, t, easeFn) {
    const et = easeFn ? easeFn(t) : t;
    v.set(a.x + (b.x - a.x) * et, a.y + (b.y - a.y) * et, a.z + (b.z - a.z) * et);
    return v;
}

function animateThreeQuaternion(q, a, b, t, easeFn) {
    const et = easeFn ? easeFn(t) : t;
    _tmpQuat4[0] = a.x; _tmpQuat4[1] = a.y; _tmpQuat4[2] = a.z; _tmpQuat4[3] = a.w;
    const target = [b.x, b.y, b.z, b.w];
    quat.slerp(_tmpQuat4, _tmpQuat4, target, et);
    q.set(_tmpQuat4[0], _tmpQuat4[1], _tmpQuat4[2], _tmpQuat4[3]);
    return q;
}

function animateThreeColor(color, a, b, t, easeFn) {
    const et = easeFn ? easeFn(t) : t;
    color.setRGB(a.r + (b.r - a.r) * et, a.g + (b.g - a.g) * et, a.b + (b.b - a.b) * et);
    return color;
}

/** Write a scalar track straight into a three.js r185 BufferAttribute. */
function applyTrackToAttribute(track, attribute, count) {
    const n = count !== undefined ? count : Math.min(track.count, attribute.count);
    attribute.array.set(track.current.subarray(0, n));
    attribute.needsUpdate = true;
    return attribute;
}

/**
 * Drive a three.js r185 InstancedMesh from an eased TRS SOA (1M instances).
 * The composed matrices are written directly into `mesh.instanceMatrix.array`
 * with no intermediate buffer and no per-instance Object3D.
 */
function createInstancedMeshAnimation(mesh, trs, fromTRS, toTRS, duration, ease, options) {
    options = options || {};
    const matrices = options.matrices || mat4.createMat4SOA(trs.position.count);
    const anim = createTRSSOAAnimation(trs, fromTRS, toTRS, duration, ease,
        Object.assign({}, options, { matrices: matrices }));
    const recomputeBounds = options.recomputeBounds === true;

    function upload() {
        const attr = mesh.instanceMatrix;
        if (!attr || !attr.array) { return; }
        const capacity = attr.count !== undefined ? attr.count : (attr.array.length / 16) | 0;
        const n = Math.min(matrices.count, capacity);
        mat4.soaToFlat(attr.array, { arrays: matrices.arrays, count: n }, 0);
        attr.needsUpdate = true;
        if (mesh.count !== n) { mesh.count = n; }
        if (recomputeBounds && typeof mesh.computeBoundingSphere === "function") {
            mesh.computeBoundingSphere();
        }
    }

    return {
        track: anim.track,
        trs: trs,
        matrices: matrices,
        step(dt) { anim.step(dt); upload(); return anim.done; },
        async stepChunked(dt, cs, ye) { await anim.stepChunked(dt, cs, ye); upload(); return anim.done; },
        get done() { return anim.done; }
    };
}

// ============================================================================
// 13. WORKER POOL — resident-state multi-core track stepping (Blob URL)
// ============================================================================
const _animWorkerSource = "(" + function () {
    const tracks = new Map();

    function sampleLUT(lut, t) {
        const n = lut.length - 1;
        if (t <= 0) { return lut[0]; }
        if (t >= 1) { return lut[n]; }
        const x = t * n, k = x | 0;
        return lut[k] + (lut[k + 1] - lut[k]) * (x - k);
    }

    self.onmessage = function (e) {
        const d = e.data;
        if (d.op === "attach") {
            tracks.set(d.id, { from: d.from, to: d.to, durations: d.durations, lut: d.lut, easeId: d.easeId });
            self.postMessage({ id: d.id, ok: true });
            return;
        }
        if (d.op === "detach") {
            tracks.delete(d.id);
            self.postMessage({ id: d.id, ok: true });
            return;
        }
        const st = tracks.get(d.trackId);
        const cur = d.current, ts = d.ts, del = d.delays, fin = d.finished;
        const n = d.n, dt = d.dt;
        const from = st.from, to = st.to, dur = st.durations, lut = st.lut;
        let doneCount = 0;
        for (let i = 0; i < n; i++) {
            if (fin[i]) { doneCount++; continue; }
            if (del[i] > 0) { del[i] -= dt; if (del[i] > 0) { continue; } }
            const dd = dur[i];
            let t;
            if (dd <= 0) { t = 1; } else { t = ts[i] + dt / dd; if (t > 1) { t = 1; } }
            ts[i] = t;
            const et = lut ? sampleLUT(lut, t) : t;
            cur[i] = from[i] + (to[i] - from[i]) * et;
            if (t >= 1) { fin[i] = 1; doneCount++; }
        }
        self.postMessage({
            id: d.id, current: cur, ts: ts, delays: del, finished: fin, done: doneCount === n
        }, [cur.buffer, ts.buffer, del.buffer, fin.buffer]);
    };
}.toString() + ")();";

/**
 * Optional multi-core executor for SOAAnimationTrack. Read-only channels
 * (from / to / durations / LUT) are attached once and stay resident in the
 * worker; only the mutable channels are transferred each step (zero copy).
 * When Workers / Blob URLs are unavailable the pool transparently falls back
 * to `track.stepChunked`, so a call never blocks the UI and never throws.
 */
class AnimationWorkerPool {
    constructor(size) {
        this._workers = [];
        this._idle = [];
        this._queue = [];
        this._pending = new Map();
        this._nextId = 1;
        this._url = null;
        this._disposed = false;
        this._attached = new WeakMap();

        const want = size || Math.min(4, (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 2);
        try {
            if (typeof Worker === "undefined" || typeof Blob === "undefined" ||
                typeof URL === "undefined" || !URL.createObjectURL) {
                throw new Error("workers unavailable");
            }
            this._url = URL.createObjectURL(new Blob([_animWorkerSource], { type: "text/javascript" }));
            for (let i = 0; i < want; i++) {
                const w = new Worker(this._url);
                w.onmessage = (e) => {
                    const job = this._pending.get(e.data.id);
                    if (job) { this._pending.delete(e.data.id); job.resolve(e.data); }
                    this._idle.push(w);
                    this._dispatch();
                };
                w.onerror = () => { this._idle.push(w); this._dispatch(); };
                this._workers.push(w);
                this._idle.push(w);
            }
        } catch (e) {
            this._workers.length = 0;
            this._idle.length = 0;
            if (this._url) { URL.revokeObjectURL(this._url); this._url = null; }
        }
    }

    get size() { return this._workers.length; }
    get isParallel() { return this._workers.length > 0; }

    _dispatch() {
        while (this._queue.length > 0 && this._idle.length > 0) {
            const job = this._queue.shift();
            const w = this._idle.pop();
            this._pending.set(job.msg.id, job);
            w.postMessage(job.msg, job.transfer || []);
        }
    }

    _post(msg, transfer) {
        return new Promise((resolve, reject) => {
            this._queue.push({ msg, transfer, resolve, reject });
            this._dispatch();
        });
    }

    /** Upload the immutable channels of a track once. */
    async attach(track) {
        if (this._disposed || this._workers.length === 0) { return false; }
        if (!track._lut) { track.useLUT(1024); }
        const id = this._nextId++;
        this._attached.set(track, id);
        await this._post({
            id: this._nextId++, op: "attach", trackId: id,
            from: track.from.slice(), to: track.to.slice(),
            durations: track.durations.slice(), lut: track._lut.slice()
        }, []);
        this._attached.set(track, id);
        return true;
    }

    /** Step a track off-thread; mutable channels are transferred, not copied. */
    async step(track, dt, chunkSize, yieldEvery) {
        if (this._disposed) { throw new Error("AnimationWorkerPool disposed"); }
        const id = this._attached.get(track);
        if (this._workers.length === 0 || id === undefined) {
            return track.stepChunked(dt, chunkSize, yieldEvery);
        }
        const res = await this._post({
            id: this._nextId++, op: "step", trackId: id, n: track.count, dt: dt,
            current: track.current, ts: track.ts, delays: track.delays, finished: track.finished
        }, [track.current.buffer, track.ts.buffer, track.delays.buffer, track.finished.buffer]);
        track.current = res.current;
        track.ts = res.ts;
        track.delays = res.delays;
        track.finished = res.finished;
        track.done = res.done;
        return track;
    }

    async detach(track) {
        const id = this._attached.get(track);
        if (id === undefined || this._workers.length === 0) { return false; }
        this._attached.delete(track);
        await this._post({ id: this._nextId++, op: "detach", trackId: id }, []);
        return true;
    }

    dispose() {
        this._disposed = true;
        for (let i = 0; i < this._workers.length; i++) { this._workers[i].terminate(); }
        this._workers.length = 0;
        this._idle.length = 0;
        for (const job of this._pending.values()) { job.reject(new Error("AnimationWorkerPool disposed")); }
        this._pending.clear();
        for (let i = 0; i < this._queue.length; i++) { this._queue[i].reject(new Error("AnimationWorkerPool disposed")); }
        this._queue.length = 0;
        if (this._url) { URL.revokeObjectURL(this._url); this._url = null; }
    }
}

function createAnimationWorkerPool(size) { return new AnimationWorkerPool(size); }

// ============================================================================
// 14. MATH NAMESPACE — the provided SOA stack stays the default maths
// ============================================================================
const math = {
    common: {
        CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC, EPSILON,
        yieldToMain, createPool, now: nowMs
    },
    utils: utils,
    easings: easings,
    engine: engineModule,
    vec2: vec2, vec3: vec3, vec4: vec4,
    mat2: mat2, mat3: null, mat4: mat4,
    quat: quat, quat2: quat2,
    bitecs: null, simplex: null,
    animation: null
};

/** Optional modules load dynamically; a failure never breaks this module. */
const mathReady = Promise.allSettled([
    import("./006_mat3.js").then(function (m) { math.mat3 = m; }),
    import("./010_bitECS_core.js").then(function (m) { math.bitecs = m; }),
    import("./013_simplex.js").then(function (m) { simplex = m; math.simplex = m; })
]);

math.animation = {
    Animation: Animation,
    SOAAnimationTrack: SOAAnimationTrack,
    acquireAnimation: acquireAnimation,
    releaseAnimation: releaseAnimation
};

// ============================================================================
// 15. EXPORTS — every original export preserved + the 1M-scale parallel layer
// ============================================================================
export {
    // foundation
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC, EPSILON,
    RESERVED_PROPS, TRANSFORM_PROPS,
    // original class + pool + helper
    Animation, acquireAnimation, releaseAnimation, getEasingFunction,
    // SOA track
    SOAAnimationTrack, createSOAAnimationTrack,
    // extended property helpers
    animateVec3, animateVec4, animateQuat, animateColor, animateTRS,
    // bitECS
    createECSChannelAnimation, createECSChannelAnimationStaggered,
    // IK
    createIKTargetAnimation,
    // orbital
    createOrbitalMAnimation, createOrbitalAAnimation,
    createOrbitalEAnimation, createOrbitalIncAnimation,
    // color
    createColorSOAAnimation,
    // procedural
    createNoiseDrivenAnimation,
    // vector / quaternion / TRS / matrix SOA animation
    createVec3SOAAnimation, createVec4SOAAnimation, createQuatSOAAnimation,
    createTRSSOAAnimation, createMat4SOAAnimation,
    // three.js r185 interop
    animateThreeVector3, animateThreeQuaternion, animateThreeColor,
    applyTrackToAttribute, createInstancedMeshAnimation,
    // parallelism
    AnimationWorkerPool, createAnimationWorkerPool,
    // namespace
    math, mathReady
};

export default {
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC, EPSILON,
    RESERVED_PROPS, TRANSFORM_PROPS,
    Animation, acquireAnimation, releaseAnimation, getEasingFunction,
    SOAAnimationTrack, createSOAAnimationTrack,
    animateVec3, animateVec4, animateQuat, animateColor, animateTRS,
    createECSChannelAnimation, createECSChannelAnimationStaggered,
    createIKTargetAnimation,
    createOrbitalMAnimation, createOrbitalAAnimation,
    createOrbitalEAnimation, createOrbitalIncAnimation,
    createColorSOAAnimation,
    createNoiseDrivenAnimation,
    createVec3SOAAnimation, createVec4SOAAnimation, createQuatSOAAnimation,
    createTRSSOAAnimation, createMat4SOAAnimation,
    animateThreeVector3, animateThreeQuaternion, animateThreeColor,
    applyTrackToAttribute, createInstancedMeshAnimation,
    AnimationWorkerPool, createAnimationWorkerPool,
    math, mathReady
};

// Continue with next file: src/math/018_timeline.js (keyframe tracks + pooled
// timeline scheduler — 1M-instance staggered playback, bezier track solver,
// bitECS timeline system and three.js r185 AnimationClip bridging)?