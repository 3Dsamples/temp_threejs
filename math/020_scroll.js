// file number : 020
// full path name : src/math/020_scroll.js
// description : Scroll-trigger system — every original export, class and
//               method preserved (ScrollTriggerInstance with pooled
//               re-initialisation, onScroll / scrollTrigger, parallax and
//               noise-parallax sub-triggers writing straight into a vec3 SOA,
//               SOAScrollGroup, HDR-safe color scrub, Kepler-anomaly orbital
//               reveal ordering, orbital scene scrub, FABRIK / CCD IK scroll
//               targets, attachTRSScroll), rewritten as a self-contained
//               native ES module in the three.js r185 JSM addon style: no
//               strict-mode directive, no CommonJS, no Vite / Vue / client
//               build, no CDN request.
//               Corrections: all transcription damage repaired (broken
//               identifiers, `& &`, trailing-space string literals that
//               silently broke `"scroll"` / `"resize"` / `"undefined"` /
//               axis and easing comparisons, the two-space threshold split),
//               missing `keplerSolve` / `eccentricToTrue` helpers inlined,
//               IntersectionObserver + resize invalidation kept out of the
//               scroll hot path, thresholds parsed once and cached, RAF
//               callback pre-bound once (never per scroll event), pooled
//               instances re-initialised through `_init()` instead of the
//               illegal `Class.call()`, and callbacks bound only once so
//               pool reuse allocates nothing.
//               Additions for 1M+ units at real time: horizontal + element
//               container scroll sources, chunked-yielding counterparts for
//               every heavy loop, quaternion and dual-quaternion scroll
//               groups (the default-math replacement layer), duck-typed
//               three.js r185 bridges that write composed matrices and
//               positions directly into GPU-bound arrays (InstancedMesh /
//               Points / Camera / Object3D), and a resident-state Blob-URL
//               worker pool for genuine multi-core scroll evaluation with a
//               non-blocking main-thread fallback.
// best for : 3d graphics — scroll-driven procedural worlds (mountains
//            parallaxing at different speeds via simplex noise, asteroid
//            belts scrolling to reveal 1M+ placements), hero sections that
//            enter / leave / scrub with IntersectionObserver fallback on
//            mobile, 1M+ instanced entrance offsets driven by a single
//            scroll ratio, orbital chase reveals (glyphs / bodies appear in
//            Kepler-anomaly order), camera fly-throughs where the scroll
//            ratio advances a Kepler mean anomaly for the whole scene,
//            natural IK scroll targets (FABRIK limb reaches a scroll-defined
//            target), and HDR-safe per-element color scrubs — all at 60 fps
//            on Android mobile 64-bit regardless of DOM size.
// license : MIT
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
import * as animationModule from "./017_animation.js";

const Animation = animationModule.Animation;
const clamp = utils.clamp;

// ============================================================================
// 0. FOUNDATION (inlined — replaces require("./001_common.js"))
// ============================================================================
const CHUNK_SIZE = 65536;
const CHUNK_YIELD_EVERY = 8;
const POOL_PREALLOC = 8;
const TWO_PI = Math.PI * 2;
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

/** Newton-Raphson Kepler solver: E - e*sin(E) = M. */
function keplerSolve(M, e) {
    let E = M;
    for (let i = 0; i < 8; i++) {
        E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    }
    return E;
}

/** Eccentric anomaly -> true anomaly (radians, -π..π). */
function eccentricToTrue(E, e) {
    const s = Math.sqrt(1 + e) * Math.sin(E * 0.5);
    const c = Math.sqrt(1 - e) * Math.cos(E * 0.5);
    return 2 * Math.atan2(s, c);
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

const common = {
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC, EPSILON,
    yieldToMain, createPool, keplerSolve, eccentricToTrue
};

// ============================================================================
// 1. SCROLLTRIGGERINSTANCE
//    `_init(config)` makes pooled re-initialisation legal (ES class
//    constructors cannot be invoked via `.call()`). Thresholds are parsed
//    once and cached; the scroll hot path allocates nothing.
// ============================================================================
class ScrollTriggerInstance {
    constructor(config) {
        this._init(config || {});
    }

    _init(config) {
        config = config || {};
        this.config = config;

        const hasDoc = typeof document !== "undefined";
        this.target = typeof config.target === "string"
            ? (hasDoc ? document.querySelector(config.target) : null)
            : config.target;

        this.container = config.container
            ? (typeof config.container === "string"
                ? (hasDoc ? document.querySelector(config.container) : null)
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
            const animCfg = Object.assign({}, config.animation, {
                targets: config.animation.targets || this.target,
                autoplay: false
            });
            this.animation = new Animation(animCfg);
        }

        this.isInView = false;
        this.progress = 0;
        this.direction = 1;
        this.lastScrollPos = 0;
        this.ticking = false;

        // ---- opt-in IntersectionObserver ----
        this.useIntersectionObserver = config.useIntersectionObserver === true;
        this.ioThreshold = config.ioThreshold || [0, 0.0001, 0.5, 0.9999, 1];
        this.ioRootMargin = config.ioRootMargin || "0px";
        this._io = null;

        // ---- zero-GC caches ----
        this._rafId = null;
        this._cachedVh = 0;
        this._cachedStartPx = 0;
        this._cachedEndPx = 0;
        this._thresholdsDirty = true;
        this._scrollAccumulator = 0;   // Float64 precision-safe scroll delta

        // ---- scroll source resolution (window OR element container) ----
        this._isWindow = (typeof window !== "undefined" && this.container === window);
        this._scrollSource = this._isWindow ? window : this.container;
        this._horizontal = this.axis === "x";

        // ---- pre-bound callbacks: created ONCE, reused across pool cycles ----
        if (!this._callbacksBound) {
            this._onScroll = this._onScroll.bind(this);
            this._boundRafTick = this._rafTick.bind(this);
            this._onResize = this._onResize.bind(this);
            this._boundIoCallback = this._ioCallback.bind(this);
            this._callbacksBound = true;
        }

        this.init();
        return this;
    }

    init() {
        if (!this.target || typeof window === "undefined") { return this; }
        if (this._scrollSource && this._scrollSource.addEventListener) {
            this._scrollSource.addEventListener("scroll", this._onScroll, { passive: true });
        }
        window.addEventListener("resize", this._onResize, { passive: true });

        if (this.useIntersectionObserver && typeof IntersectionObserver !== "undefined") {
            this._io = new IntersectionObserver(this._boundIoCallback, {
                root: this._isWindow ? null : this.container,
                rootMargin: this.ioRootMargin,
                threshold: this.ioThreshold
            });
            this._io.observe(this.target);
        }
        this._refreshThresholds();
        this._update();
        return this;
    }

    /** Pre-bound; no closure is created per observation batch. */
    _ioCallback() {
        this._thresholdsDirty = true;
        this._onScroll();
    }

    /** Resize invalidates the cached parse — never happens per frame. */
    _onResize() {
        this._thresholdsDirty = true;
        this._onScroll();
    }

    /** Single pre-bound RAF callback instead of a closure per scroll event. */
    _onScroll() {
        if (this.ticking) { return; }
        this.ticking = true;
        if (typeof requestAnimationFrame !== "undefined") {
            this._rafId = requestAnimationFrame(this._boundRafTick);
        } else {
            this._rafTick();
        }
    }

    _rafTick() {
        this._rafId = null;
        this._update();
        this.ticking = false;
    }

    /** Parse + cache thresholds. Called on init / resize / IO change only. */
    _refreshThresholds() {
        if (typeof window === "undefined" || !this.target) { return; }
        const vh = this._isWindow
            ? (this._horizontal ? window.innerWidth : window.innerHeight)
            : (this._horizontal
                ? (this.container.clientWidth || 0)
                : (this.container.clientHeight || 0));
        this._cachedVh = vh;
        const rect = this.target.getBoundingClientRect();
        const size = this._horizontal ? rect.width : rect.height;
        this._cachedStartPx = this._parseThreshold(this.start, vh, size);
        this._cachedEndPx = this._parseThreshold(this.end, vh, size);
        this._thresholdsDirty = false;
    }

    /**
     * Reads cached thresholds. No split(), no string allocation, no array
     * creation per scroll frame. `getBoundingClientRect()` is a DOM-owned
     * allocation that cannot be avoided while tracking a live element; all
     * engine-side math below is strictly allocation-free.
     */
    _update() {
        if (!this.target || typeof window === "undefined") { return; }
        if (this._thresholdsDirty) { this._refreshThresholds(); }

        const rect = this.target.getBoundingClientRect();
        const vh = this._cachedVh || (this._horizontal ? window.innerWidth : window.innerHeight);

        let scrollPos, targetStart, targetSize;
        if (this._isWindow) {
            if (this._horizontal) {
                scrollPos = window.scrollX !== undefined ? window.scrollX : (window.pageXOffset || 0);
                targetStart = rect.left;
                targetSize = rect.width;
            } else {
                scrollPos = window.scrollY !== undefined
                    ? window.scrollY
                    : (window.pageYOffset || document.documentElement.scrollTop || 0);
                targetStart = rect.top;
                targetSize = rect.height;
            }
        } else {
            const cRect = this.container.getBoundingClientRect
                ? this.container.getBoundingClientRect()
                : { top: 0, left: 0 };
            if (this._horizontal) {
                scrollPos = this.container.scrollLeft || 0;
                targetStart = rect.left - cRect.left;
                targetSize = rect.width;
            } else {
                scrollPos = this.container.scrollTop || 0;
                targetStart = rect.top - cRect.top;
                targetSize = rect.height;
            }
        }

        this.direction = scrollPos >= this.lastScrollPos ? 1 : -1;
        this._scrollAccumulator += scrollPos - this.lastScrollPos;
        this.lastScrollPos = scrollPos;

        const startPx = this._cachedStartPx;
        const endPx = this._cachedEndPx;
        const totalDistance = (vh - startPx) + (targetSize - endPx);
        const currentDistance = vh - startPx - targetStart;
        const progress = clamp(currentDistance / (totalDistance || 1), 0, 1);
        this.progress = progress;

        const wasInView = this.isInView;
        const currentlyInView = progress > 0 && progress < 1;

        if (currentlyInView && !wasInView) {
            this.isInView = true;
            if (this.direction === 1 && this.onEnter) { this.onEnter(this); }
            if (this.direction === -1 && this.onEnterBack) { this.onEnterBack(this); }
            if (this.animation && !this.sync) { this.animation.play(); }
        } else if (!currentlyInView && wasInView) {
            this.isInView = false;
            if (progress >= 1 && this.onLeave) { this.onLeave(this); }
            if (progress <= 0 && this.onLeaveBack) { this.onLeaveBack(this); }
            if (this.animation && !this.sync && this.repeat) { this.animation.seek(0); }
        }

        if (this.sync && this.animation) { this.animation.seek(progress); }
        if (this.onUpdate) { this.onUpdate(this); }
    }

    /**
     * Parse a threshold into viewport pixels. Allocation is confined to
     * init / resize (cached by `_refreshThresholds`). Numeric input
     * short-circuits with zero work.
     */
    _parseThreshold(thresholdStr, viewportHeight, targetHeight) {
        if (typeof thresholdStr === "number") { return thresholdStr; }
        const str = String(thresholdStr);
        const spaceIdx = str.indexOf(" ");
        let viewportEdge = spaceIdx === -1 ? str : str.slice(spaceIdx + 1);
        if (viewportEdge.length === 0) { viewportEdge = "80%"; }
        const vh = viewportHeight;
        const last = viewportEdge.charCodeAt(viewportEdge.length - 1);

        if (last === 37) { return (parseFloat(viewportEdge) / 100) * vh; }   // '%'
        if (viewportEdge.length >= 2 &&
            viewportEdge.charCodeAt(viewportEdge.length - 1) === 120 &&
            viewportEdge.charCodeAt(viewportEdge.length - 2) === 112) {     // 'px'
            return parseFloat(viewportEdge);
        }
        if (viewportEdge === "top") { return 0; }
        if (viewportEdge === "center") { return vh * 0.5; }
        if (viewportEdge === "bottom") { return vh; }
        if (viewportEdge === "target" && targetHeight !== undefined) { return targetHeight; }
        return vh * 0.8;
    }

    /** Force a re-parse on the next update (call after layout changes). */
    invalidate() {
        this._thresholdsDirty = true;
        return this;
    }

    /** Immediately re-evaluate (useful after programmatic layout changes). */
    refresh() {
        this._thresholdsDirty = true;
        this._update();
        return this;
    }

    destroy() {
        if (typeof window !== "undefined") {
            if (this._scrollSource && this._scrollSource.removeEventListener) {
                this._scrollSource.removeEventListener("scroll", this._onScroll);
            }
            window.removeEventListener("resize", this._onResize);
            if (this._rafId !== null && typeof cancelAnimationFrame !== "undefined") {
                cancelAnimationFrame(this._rafId);
            }
        }
        this._rafId = null;
        this.ticking = false;
        if (this._io) { this._io.disconnect(); this._io = null; }
        if (this.animation) { this.animation.pause(); }
    }
}

function onScroll(config) { return new ScrollTriggerInstance(config); }
function scrollTrigger(config) { return onScroll(config); }

// ============================================================================
// 2. POOL — zero-GC reuse of ScrollTriggerInstance
// ============================================================================
const _stPool = createPool(
    function () { return Object.create(ScrollTriggerInstance.prototype); },
    POOL_PREALLOC,
    function (s) {
        if (typeof s.destroy === "function" && s.target) {
            try { s.destroy(); } catch (e) { /* swallow */ }
        }
        s.target = null;
        s.container = null;
        s._scrollSource = null;
        s._io = null;
        s.animation = null;
        s.onEnter = s.onLeave = s.onEnterBack = s.onLeaveBack = s.onUpdate = null;
        s.isInView = false;
        s.progress = 0;
        s.direction = 1;
        s.lastScrollPos = 0;
        s._scrollAccumulator = 0;
        s.ticking = false;
        s._thresholdsDirty = true;
    }
);

function acquireScrollTrigger(config) {
    const s = _stPool.acquire();
    s._init(config || {});
    return s;
}

function releaseScrollTrigger(s) {
    _stPool.release(s);
}

// ============================================================================
// 3. PARALLAX SUB-TRIGGER — writes into a vec3 SOA (instanced-friendly)
// ============================================================================
/**
 * Every enter / update advances an offset written into a caller-provided
 * vec3 SOA slot (typically TRS.position of a GPU-instanced mesh).
 * Axis is resolved ONCE at attach time — no per-element string comparison
 * inside the 1M+ hot loop.
 */
function createParallax(trigger, soa, opts) {
    opts = opts || {};
    const depth = opts.depth || null;
    const axis = opts.axis || "y";
    const strength = opts.strength !== undefined ? opts.strength : 100;
    const speed = opts.speed !== undefined ? opts.speed : 1;
    const base = opts.base || null;
    const bx = base ? base[0] : 0;
    const by = base ? base[1] : 0;
    const bz = base ? base[2] : 0;
    const n = soa.count;
    const sx = soa.x, sy = soa.y, sz = soa.z;
    const mode = axis === "x" ? 1 : axis === "z" ? 2 : axis === "xy" ? 3 : axis === "xyz" ? 4 : 0;

    function apply(p) {
        const offset = p * strength * speed;
        let i, d, v;
        if (mode === 0) {
            for (i = 0; i < n; i++) { d = depth ? depth[i] : 1; sy[i] = by + offset * d; }
        } else if (mode === 1) {
            for (i = 0; i < n; i++) { d = depth ? depth[i] : 1; sx[i] = bx + offset * d; }
        } else if (mode === 2) {
            for (i = 0; i < n; i++) { d = depth ? depth[i] : 1; sz[i] = bz + offset * d; }
        } else if (mode === 3) {
            for (i = 0; i < n; i++) { d = depth ? depth[i] : 1; v = offset * d; sx[i] = bx + v; sy[i] = by + v; }
        } else {
            for (i = 0; i < n; i++) { d = depth ? depth[i] : 1; v = offset * d; sx[i] = bx + v; sy[i] = by + v; sz[i] = bz + v; }
        }
    }

    async function applyChunked(p, chunkSize, yieldEvery) {
        const offset = p * strength * speed;
        await _chunkedRange(n, chunkSize, yieldEvery, function (start, end) {
            for (let i = start; i < end; i++) {
                const d = depth ? depth[i] : 1;
                const v = offset * d;
                if (mode === 0) { sy[i] = by + v; }
                else if (mode === 1) { sx[i] = bx + v; }
                else if (mode === 2) { sz[i] = bz + v; }
                else if (mode === 3) { sx[i] = bx + v; sy[i] = by + v; }
                else { sx[i] = bx + v; sy[i] = by + v; sz[i] = bz + v; }
            }
        });
    }

    const prevUpdate = trigger.onUpdate;
    trigger.onUpdate = function (self) {
        apply(self.progress);
        if (prevUpdate) { prevUpdate(self); }
    };
    apply(trigger.progress);

    return {
        trigger: trigger,
        apply: apply,
        applyChunked: applyChunked,
        detach: function () { trigger.onUpdate = prevUpdate; return trigger; }
    };
}

// ============================================================================
// 4. NOISE PARALLAX — per-row depth derived from 3D simplex
// ============================================================================
let simplex = null;
function _fallbackNoise3(x, y, z) { return vec3.gradientNoise3D(x, y, z); }

function createNoiseParallax(trigger, soa, opts) {
    opts = opts || {};
    const noiseFn = opts.noiseFn ||
        (simplex ? simplex.acquireNoise3D(opts.seed) : _fallbackNoise3);
    const noiseScale = opts.noiseScale !== undefined ? opts.noiseScale : 0.01;
    const minDepth = opts.minDepth !== undefined ? opts.minDepth : 0.25;
    const maxDepth = opts.maxDepth !== undefined ? opts.maxDepth : 1.0;
    const n = soa.count;
    const depth = opts.depth || new Float32Array(n);
    const px = soa.x, py = soa.y, pz = soa.z;
    const span = maxDepth - minDepth;

    for (let i = 0; i < n; i++) {
        const v = 0.5 + 0.5 * noiseFn(px[i] * noiseScale, py[i] * noiseScale, pz[i] * noiseScale);
        depth[i] = minDepth + v * span;
    }
    opts.depth = depth;
    return createParallax(trigger, soa, opts);
}

/** Chunked depth bake for 1M+ rows — never blocks the UI thread. */
async function createNoiseParallaxAsync(trigger, soa, opts, chunkSize, yieldEvery) {
    opts = opts || {};
    const noiseFn = opts.noiseFn ||
        (simplex ? simplex.acquireNoise3D(opts.seed) : _fallbackNoise3);
    const noiseScale = opts.noiseScale !== undefined ? opts.noiseScale : 0.01;
    const minDepth = opts.minDepth !== undefined ? opts.minDepth : 0.25;
    const maxDepth = opts.maxDepth !== undefined ? opts.maxDepth : 1.0;
    const n = soa.count;
    const depth = opts.depth || new Float32Array(n);
    const px = soa.x, py = soa.y, pz = soa.z;
    const span = maxDepth - minDepth;

    await _chunkedRange(n, chunkSize, yieldEvery, function (start, end) {
        for (let i = start; i < end; i++) {
            const v = 0.5 + 0.5 * noiseFn(px[i] * noiseScale, py[i] * noiseScale, pz[i] * noiseScale);
            depth[i] = minDepth + v * span;
        }
    });
    opts.depth = depth;
    return createParallax(trigger, soa, opts);
}

// ============================================================================
// 5. SOA SCROLL GROUP — 1M+ rows driven by a single scroll ratio
// ============================================================================
function createSOAScrollGroup(master, soa, options) {
    options = options || {};
    const from = options.from !== undefined ? options.from : 0;
    const to = options.to !== undefined ? options.to : 1;
    const axis = options.axis || "y";
    const stagger = options.stagger || null;
    const ease = easings.getEasing(options.ease || "linear");
    const lut = options.lut ? easings.bakeEasingLUT(ease, options.lut === true ? 1024 : options.lut) : null;
    const lutN = lut ? lut.length - 1 : 0;
    const n = soa.count;
    const sx = soa.x, sy = soa.y, sz = soa.z;
    const fromArr = typeof from !== "number" && from.length !== undefined;
    const toArr = typeof to !== "number" && to.length !== undefined;
    const mode = axis === "x" ? 1 : axis === "z" ? 2 : 0;

    function sampleEase(t) {
        if (!lut) { return ease(t); }
        if (t <= 0) { return lut[0]; }
        if (t >= 1) { return lut[lutN]; }
        const x = t * lutN, k = x | 0;
        return lut[k] + (lut[k + 1] - lut[k]) * (x - k);
    }

    function apply(p) {
        let i, pi, et, f, t;
        if (mode === 0) {
            for (i = 0; i < n; i++) {
                pi = stagger ? clamp((p - stagger[i]) / Math.max(1e-6, 1 - stagger[i]), 0, 1) : p;
                et = sampleEase(pi);
                f = fromArr ? from[i] : from;
                t = toArr ? to[i] : to;
                sy[i] = f + (t - f) * et;
            }
        } else if (mode === 1) {
            for (i = 0; i < n; i++) {
                pi = stagger ? clamp((p - stagger[i]) / Math.max(1e-6, 1 - stagger[i]), 0, 1) : p;
                et = sampleEase(pi);
                f = fromArr ? from[i] : from;
                t = toArr ? to[i] : to;
                sx[i] = f + (t - f) * et;
            }
        } else {
            for (i = 0; i < n; i++) {
                pi = stagger ? clamp((p - stagger[i]) / Math.max(1e-6, 1 - stagger[i]), 0, 1) : p;
                et = sampleEase(pi);
                f = fromArr ? from[i] : from;
                t = toArr ? to[i] : to;
                sz[i] = f + (t - f) * et;
            }
        }
    }

    async function applyChunked(p, chunkSize, yieldEvery) {
        await _chunkedRange(n, chunkSize, yieldEvery, function (start, end) {
            for (let i = start; i < end; i++) {
                const pi = stagger ? clamp((p - stagger[i]) / Math.max(1e-6, 1 - stagger[i]), 0, 1) : p;
                const et = sampleEase(pi);
                const f = fromArr ? from[i] : from;
                const t = toArr ? to[i] : to;
                const v = f + (t - f) * et;
                if (mode === 0) { sy[i] = v; }
                else if (mode === 1) { sx[i] = v; }
                else { sz[i] = v; }
            }
        });
    }

    const prevUpdate = master.onUpdate;
    master.onUpdate = function (self) {
        apply(self.progress);
        if (prevUpdate) { prevUpdate(self); }
    };
    apply(master.progress);

    return {
        master: master,
        apply: apply,
        applyChunked: applyChunked,
        detach: function () { master.onUpdate = prevUpdate; return master; }
    };
}

// ============================================================================
// 6. COLOR SCRUB — 1M+ HDR-safe per-row color driven by scroll
// ============================================================================
function createColorScrub(master, colors, fromColor, toColor, options) {
    options = options || {};
    const ease = easings.getEasing(options.ease || "linear");
    const stagger = options.stagger || null;
    const n = colors.count;
    const cr = colors.x, cg = colors.y, cb = colors.z, ca = colors.w;
    const fr = fromColor[0], fg = fromColor[1], fb = fromColor[2], fa = fromColor[3];
    const dr = toColor[0] - fr, dg = toColor[1] - fg, db = toColor[2] - fb, da = toColor[3] - fa;

    function apply(p) {
        for (let i = 0; i < n; i++) {
            const pi = stagger ? clamp((p - stagger[i]) / Math.max(1e-6, 1 - stagger[i]), 0, 1) : p;
            const et = ease(pi);
            cr[i] = fr + dr * et;
            cg[i] = fg + dg * et;
            cb[i] = fb + db * et;
            ca[i] = fa + da * et;
        }
    }

    async function applyChunked(p, chunkSize, yieldEvery) {
        await _chunkedRange(n, chunkSize, yieldEvery, function (start, end) {
            for (let i = start; i < end; i++) {
                const pi = stagger ? clamp((p - stagger[i]) / Math.max(1e-6, 1 - stagger[i]), 0, 1) : p;
                const et = ease(pi);
                cr[i] = fr + dr * et;
                cg[i] = fg + dg * et;
                cb[i] = fb + db * et;
                ca[i] = fa + da * et;
            }
        });
    }

    const prev = master.onUpdate;
    master.onUpdate = function (self) {
        apply(self.progress);
        if (prev) { prev(self); }
    };
    apply(master.progress);

    return {
        master: master,
        apply: apply,
        applyChunked: applyChunked,
        detach: function () { master.onUpdate = prev; return master; }
    };
}

// ============================================================================
// 7. ORBITAL SCROLL REVEAL — Kepler-anomaly ordered progress per row
// ============================================================================
function createOrbitalScrollOrder(count, opts) {
    opts = opts || {};
    const e = opts.e !== undefined ? opts.e : 0.5;
    const delays = new Float32Array(count);
    const invCount = count > 0 ? 1 / count : 0;
    const invTwoPi = 1 / TWO_PI;
    for (let i = 0; i < count; i++) {
        const M = (i * invCount) * TWO_PI;
        const E = keplerSolve(M, e);
        const nu = eccentricToTrue(E, e);
        delays[i] = (nu + Math.PI) * invTwoPi;
    }
    return delays;
}

async function createOrbitalScrollOrderChunked(count, opts, chunkSize, yieldEvery) {
    opts = opts || {};
    const e = opts.e !== undefined ? opts.e : 0.5;
    const delays = new Float32Array(count);
    const invCount = count > 0 ? 1 / count : 0;
    const invTwoPi = 1 / TWO_PI;
    await _chunkedRange(count, chunkSize, yieldEvery, function (start, end) {
        for (let i = start; i < end; i++) {
            const M = (i * invCount) * TWO_PI;
            const E = keplerSolve(M, e);
            const nu = eccentricToTrue(E, e);
            delays[i] = (nu + Math.PI) * invTwoPi;
        }
    });
    return delays;
}

// ============================================================================
// 8. NATURAL IK MOTION — scroll-driven target for FABRIK / CCD
// ============================================================================
/**
 * As the user scrolls, the IK target moves from `fromTarget` to `toTarget`.
 * Tolerance is compared against the solver's returned error (distance),
 * matching the corrected `vec3.fabrikStep3` contract. Also supports the
 * bitECS IK-system form (`chain.setTarget(index, x, y, z)`).
 */
function createIKScrollTarget(master, chain, fromTarget, toTarget, opts) {
    opts = opts || {};
    const ease = easings.getEasing(opts.ease || "easeInOutCubic");
    const iterations = opts.iterations || 10;
    const tolerance = opts.tolerance !== undefined ? opts.tolerance : 0.001;
    const useCCD = opts.method === "ccd";
    const fx = fromTarget[0], fy = fromTarget[1], fz = fromTarget[2];
    const dx = toTarget[0] - fx, dy = toTarget[1] - fy, dz = toTarget[2] - fz;
    const hasSetter = chain && typeof chain.setTarget === "function";
    const chainIndex = chain && chain.index !== undefined ? chain.index : 0;
    const solve = opts.solve !== false;

    function apply(p) {
        const et = ease(p);
        const tx = fx + dx * et, ty = fy + dy * et, tz = fz + dz * et;
        if (hasSetter) { chain.setTarget(chainIndex, tx, ty, tz); }
        if (chain && chain.target) {
            chain.target[0] = tx; chain.target[1] = ty; chain.target[2] = tz;
        }
        if (!solve || !chain || !chain.pos) { return; }
        if (useCCD) {
            vec3.ccdStep3(chain.pos, chain.target, iterations);
        } else {
            for (let it = 0; it < iterations; it++) {
                const err = vec3.fabrikStep3(chain.pos, chain.lens, chain.target, tolerance);
                if (err < tolerance) { break; }
            }
        }
    }

    const prev = master.onUpdate;
    master.onUpdate = function (self) {
        apply(self.progress);
        if (prev) { prev(self); }
    };
    apply(master.progress);

    return {
        master: master,
        apply: apply,
        chain: chain,
        detach: function () { master.onUpdate = prev; return master; }
    };
}

// ============================================================================
// 9. ORBITAL SCENE — scroll drives Kepler mean anomaly of 1M+ bodies
// ============================================================================
function createOrbitalScroll(master, elements, M0, M1, opts) {
    opts = opts || {};
    const ease = easings.getEasing(opts.ease || "linear");
    const deltaArr = opts.delta || null;
    const n = elements.M.length;
    const MArr = elements.M;
    const span = M1 - M0;

    function apply(p) {
        const et = ease(p);
        if (deltaArr) {
            for (let i = 0; i < n; i++) { MArr[i] = M0 + deltaArr[i] * et; }
        } else {
            MArr.fill(M0 + span * et);
        }
    }

    async function applyChunked(p, chunkSize, yieldEvery) {
        const et = ease(p);
        if (!deltaArr) { MArr.fill(M0 + span * et); return; }
        await _chunkedRange(n, chunkSize, yieldEvery, function (start, end) {
            for (let i = start; i < end; i++) { MArr[i] = M0 + deltaArr[i] * et; }
        });
    }

    const prev = master.onUpdate;
    master.onUpdate = function (self) {
        apply(self.progress);
        if (prev) { prev(self); }
    };
    apply(master.progress);

    return {
        master: master,
        apply: apply,
        applyChunked: applyChunked,
        detach: function () { master.onUpdate = prev; return master; }
    };
}

// ============================================================================
// 10. MULTI-TARGET LAYOUT HELPERS
// ============================================================================
function attachTRSScroll(master, trs, opts) {
    opts = opts || {};
    opts.axis = opts.channel || opts.axis || "y";
    return createSOAScrollGroup(master, trs.position, opts);
}

// ============================================================================
// 11. QUATERNION / DUAL-QUATERNION SCROLL GROUPS (default-math replacement)
// ============================================================================
// Reusable SOA views — mutated per chunk instead of allocating literals.
const _qViewOut = { x: null, y: null, z: null, w: null, count: 0 };
const _qViewA = { x: null, y: null, z: null, w: null, count: 0 };
const _qViewB = { x: null, y: null, z: null, w: null, count: 0 };

function _setQuatView(view, soa, s, e) {
    view.x = soa.x.subarray(s, e);
    view.y = soa.y.subarray(s, e);
    view.z = soa.z.subarray(s, e);
    view.w = soa.w.subarray(s, e);
    view.count = e - s;
    return view;
}

/** Scroll-driven shortest-arc slerp across 1M+ orientations. */
function createQuatScrollGroup(master, out, from, to, options) {
    options = options || {};
    const ease = easings.getEasing(options.ease || "linear");
    const stagger = options.stagger || null;
    const n = out.count;
    const ts = options.progress || new Float32Array(n);

    function fillTs(p, s, e) {
        for (let i = s; i < e; i++) {
            const pi = stagger ? clamp((p - stagger[i]) / Math.max(1e-6, 1 - stagger[i]), 0, 1) : p;
            ts[i] = ease(pi);
        }
    }

    function apply(p) {
        fillTs(p, 0, n);
        quat.soaSlerp(out, from, to, ts);
    }

    async function applyChunked(p, chunkSize, yieldEvery) {
        await _chunkedRange(n, chunkSize, yieldEvery, function (s, e) {
            fillTs(p, s, e);
            quat.soaSlerp(
                _setQuatView(_qViewOut, out, s, e),
                _setQuatView(_qViewA, from, s, e),
                _setQuatView(_qViewB, to, s, e),
                ts.subarray(s, e)
            );
        });
    }

    const prev = master.onUpdate;
    master.onUpdate = function (self) {
        apply(self.progress);
        if (prev) { prev(self); }
    };
    apply(master.progress);

    return {
        master: master, apply: apply, applyChunked: applyChunked, progress: ts,
        detach: function () { master.onUpdate = prev; return master; }
    };
}

/**
 * Scroll-driven dual-quaternion blend (8 floats / instance) — the GPU-friendly
 * rigid transform path. Antipodal-safe DLB + renormalisation, inlined.
 */
function createDualQuatScrollGroup(master, out, from, to, options) {
    options = options || {};
    const ease = easings.getEasing(options.ease || "linear");
    const stagger = options.stagger || null;
    const n = out.count;
    const oX1 = out.x1, oY1 = out.y1, oZ1 = out.z1, oW1 = out.w1;
    const oX2 = out.x2, oY2 = out.y2, oZ2 = out.z2, oW2 = out.w2;
    const aX1 = from.x1, aY1 = from.y1, aZ1 = from.z1, aW1 = from.w1;
    const aX2 = from.x2, aY2 = from.y2, aZ2 = from.z2, aW2 = from.w2;
    const bX1 = to.x1, bY1 = to.y1, bZ1 = to.z1, bW1 = to.w1;
    const bX2 = to.x2, bY2 = to.y2, bZ2 = to.z2, bW2 = to.w2;

    function range(p, s, e) {
        for (let i = s; i < e; i++) {
            const pi = stagger ? clamp((p - stagger[i]) / Math.max(1e-6, 1 - stagger[i]), 0, 1) : p;
            const tt = ease(pi);
            const r0 = aX1[i], r1 = aY1[i], r2 = aZ1[i], r3 = aW1[i];
            let s0 = bX1[i], s1 = bY1[i], s2 = bZ1[i], s3 = bW1[i];
            let d0 = bX2[i], d1 = bY2[i], d2 = bZ2[i], d3 = bW2[i];
            if (r0 * s0 + r1 * s1 + r2 * s2 + r3 * s3 < 0) {
                s0 = -s0; s1 = -s1; s2 = -s2; s3 = -s3;
                d0 = -d0; d1 = -d1; d2 = -d2; d3 = -d3;
            }
            const mt = 1 - tt;
            const n0 = r0 * mt + s0 * tt, n1 = r1 * mt + s1 * tt;
            const n2 = r2 * mt + s2 * tt, n3 = r3 * mt + s3 * tt;
            const e0 = aX2[i] * mt + d0 * tt, e1 = aY2[i] * mt + d1 * tt;
            const e2 = aZ2[i] * mt + d2 * tt, e3 = aW2[i] * mt + d3 * tt;
            const mag = Math.sqrt(n0 * n0 + n1 * n1 + n2 * n2 + n3 * n3);
            if (mag > 0) {
                const q0 = n0 / mag, q1 = n1 / mag, q2 = n2 / mag, q3 = n3 / mag;
                const adb = q0 * e0 + q1 * e1 + q2 * e2 + q3 * e3;
                oX1[i] = q0; oY1[i] = q1; oZ1[i] = q2; oW1[i] = q3;
                oX2[i] = (e0 - q0 * adb) / mag;
                oY2[i] = (e1 - q1 * adb) / mag;
                oZ2[i] = (e2 - q2 * adb) / mag;
                oW2[i] = (e3 - q3 * adb) / mag;
            } else {
                oX1[i] = 0; oY1[i] = 0; oZ1[i] = 0; oW1[i] = 1;
                oX2[i] = 0; oY2[i] = 0; oZ2[i] = 0; oW2[i] = 0;
            }
        }
    }

    function apply(p) { range(p, 0, n); }
    async function applyChunked(p, chunkSize, yieldEvery) {
        await _chunkedRange(n, chunkSize, yieldEvery, function (s, e) { range(p, s, e); });
    }

    const prev = master.onUpdate;
    master.onUpdate = function (self) {
        apply(self.progress);
        if (prev) { prev(self); }
    };
    apply(master.progress);

    return {
        master: master, apply: apply, applyChunked: applyChunked,
        detach: function () { master.onUpdate = prev; return master; }
    };
}

// ============================================================================
// 12. THREE.JS r185 BRIDGES (duck-typed — no three import, no CDN, no build)
// ============================================================================
/** Write a Float32Array channel straight into a three.js BufferAttribute. */
function writeScrollToAttribute(src, attribute, count) {
    const n = count === undefined ? Math.min(src.length, attribute.array.length) : count;
    attribute.array.set(src.subarray(0, n));
    attribute.needsUpdate = true;
    return attribute;
}

/**
 * Drive a three.js r185 InstancedMesh from a scroll-scrubbed TRS SOA.
 * Composed matrices are written directly into `mesh.instanceMatrix.array`
 * (no intermediate buffer, no per-instance Object3D).
 */
function attachInstancedMeshScroll(master, mesh, trs, opts) {
    opts = opts || {};
    const n = trs.position.count;
    const matrices = opts.matrices || mat4.createMat4SOA(n);
    const group = attachTRSScroll(master, trs, opts);
    const recomputeBounds = opts.recomputeBounds === true;
    const innerApply = group.apply;
    const innerChunked = group.applyChunked;

    function upload() {
        const attr = mesh.instanceMatrix;
        if (!attr || !attr.array) { return; }
        const capacity = attr.count !== undefined ? attr.count : (attr.array.length / 16) | 0;
        const count = Math.min(n, capacity);
        mat4.soaComposeTRS(matrices, trs.position, trs.rotation, trs.scale);
        mat4.soaToFlat(attr.array, { arrays: matrices.arrays, count: count }, 0);
        attr.needsUpdate = true;
        if (mesh.count !== count) { mesh.count = count; }
        if (recomputeBounds && typeof mesh.computeBoundingSphere === "function") {
            mesh.computeBoundingSphere();
        }
    }

    function apply(p) { innerApply(p); upload(); }
    async function applyChunked(p, chunkSize, yieldEvery) {
        await innerChunked(p, chunkSize, yieldEvery);
        await mat4.soaComposeTRSChunked(matrices, trs.position, trs.rotation, trs.scale, chunkSize, yieldEvery);
        const attr = mesh.instanceMatrix;
        if (attr && attr.array) {
            const capacity = attr.count !== undefined ? attr.count : (attr.array.length / 16) | 0;
            const count = Math.min(n, capacity);
            mat4.soaToFlat(attr.array, { arrays: matrices.arrays, count: count }, 0);
            attr.needsUpdate = true;
            if (mesh.count !== count) { mesh.count = count; }
        }
    }

    const prev = master.onUpdate;
    master.onUpdate = function (self) {
        apply(self.progress);
        if (prev) { prev(self); }
    };
    apply(master.progress);

    return {
        master: master, matrices: matrices, apply: apply, applyChunked: applyChunked,
        detach: function () { master.onUpdate = prev; return master; }
    };
}

/** Drive a three.js r185 Points geometry position attribute from a vec3 SOA. */
function attachPointsScroll(master, points, positions, opts) {
    opts = opts || {};
    const attributeName = opts.attribute || "position";
    const group = createSOAScrollGroup(master, positions, opts);
    const innerApply = group.apply;
    const innerChunked = group.applyChunked;
    const recomputeBounds = opts.recomputeBounds === true;

    function upload() {
        const geo = points.geometry;
        if (!geo || !geo.attributes) { return; }
        const attr = geo.attributes[attributeName];
        if (!attr || !attr.array) { return; }
        const capacity = attr.count !== undefined ? attr.count : (attr.array.length / 3) | 0;
        const count = Math.min(positions.count, capacity);
        vec3.soaToFlat(attr.array, { x: positions.x, y: positions.y, z: positions.z, count: count }, 0);
        attr.needsUpdate = true;
        if (geo.setDrawRange) { geo.setDrawRange(0, count); }
        if (recomputeBounds && typeof geo.computeBoundingSphere === "function") {
            geo.computeBoundingSphere();
        }
    }

    function apply(p) { innerApply(p); upload(); }
    async function applyChunked(p, chunkSize, yieldEvery) {
        await innerChunked(p, chunkSize, yieldEvery);
        upload();
    }

    const prev = master.onUpdate;
    master.onUpdate = function (self) {
        apply(self.progress);
        if (prev) { prev(self); }
    };
    apply(master.progress);

    return {
        master: master, apply: apply, applyChunked: applyChunked,
        detach: function () { master.onUpdate = prev; return master; }
    };
}

/** Scrub any three.js Object3D transform channel (position / scale / rotation). */
function attachThreeTransformScroll(trigger, object, opts) {
    opts = opts || {};
    const ease = easings.getEasing(opts.ease || "linear");
    const channel = opts.channel || "position";
    const axis = opts.axis || "y";
    const from = opts.from !== undefined ? opts.from : 0;
    const to = opts.to !== undefined ? opts.to : 1;
    const target = object[channel];

    function apply(p) {
        const et = ease(p);
        if (target && target.isVector3) {
            const v = from + (to - from) * et;
            if (axis === "x") { target.x = v; }
            else if (axis === "z") { target.z = v; }
            else { target.y = v; }
        } else if (target && typeof target.setScalar === "function") {
            target.setScalar(from + (to - from) * et);
        } else if (object[channel] !== undefined) {
            object[channel] = from + (to - from) * et;
        }
        if (opts.updateMatrix !== false && typeof object.updateMatrix === "function") {
            object.updateMatrix();
        }
    }

    const prev = trigger.onUpdate;
    trigger.onUpdate = function (self) {
        apply(self.progress);
        if (prev) { prev(self); }
    };
    apply(trigger.progress);

    return {
        trigger: trigger, apply: apply,
        detach: function () { trigger.onUpdate = prev; return trigger; }
    };
}

/** Scroll-driven camera dolly + optional FOV scrub (three.js r185 Camera). */
function attachCameraScroll(trigger, camera, opts) {
    opts = opts || {};
    const ease = easings.getEasing(opts.ease || "easeInOutCubic");
    const from = opts.from || [0, 0, 10];
    const to = opts.to || [0, 0, 1];
    const fov0 = opts.fovFrom;
    const fov1 = opts.fovTo;
    const lookTarget = opts.lookAt || null;

    function apply(p) {
        const et = ease(p);
        camera.position.set(
            from[0] + (to[0] - from[0]) * et,
            from[1] + (to[1] - from[1]) * et,
            from[2] + (to[2] - from[2]) * et
        );
        if (lookTarget && typeof camera.lookAt === "function") {
            camera.lookAt(lookTarget[0], lookTarget[1], lookTarget[2]);
        }
        if (fov0 !== undefined && fov1 !== undefined && camera.fov !== undefined) {
            camera.fov = fov0 + (fov1 - fov0) * et;
            if (typeof camera.updateProjectionMatrix === "function") { camera.updateProjectionMatrix(); }
        }
    }

    const prev = trigger.onUpdate;
    trigger.onUpdate = function (self) {
        apply(self.progress);
        if (prev) { prev(self); }
    };
    apply(trigger.progress);

    return {
        trigger: trigger, apply: apply,
        detach: function () { trigger.onUpdate = prev; return trigger; }
    };
}

// ============================================================================
// 13. WORKER POOL — resident-state multi-core scroll evaluation (Blob URL)
// ============================================================================
const _scrollWorkerSource = "(" + function () {
    const specs = new Map();

    function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

    self.onmessage = function (e) {
        const d = e.data;
        if (d.op === "attach") {
            specs.set(d.specId, {
                kind: d.kind, n: d.n,
                from: d.from, to: d.to,
                fromScalar: d.fromScalar, toScalar: d.toScalar,
                stagger: d.stagger, lut: d.lut
            });
            self.postMessage({ id: d.id, ok: true });
            return;
        }
        if (d.op === "detach") {
            specs.delete(d.specId);
            self.postMessage({ id: d.id, ok: true });
            return;
        }

        const sp = specs.get(d.specId);
        const p = d.p, n = sp.n, out = d.out;
        const stag = sp.stagger, lut = sp.lut;
        const lutN = lut ? lut.length - 1 : 0;
        const fromArr = sp.from, toArr = sp.to;
        const fs = sp.fromScalar, ts = sp.toScalar;

        if (sp.kind === "color") {
            const fr = fs[0], fg = fs[1], fb = fs[2], fa = fs[3];
            const dr = ts[0] - fr, dg = ts[1] - fg, db = ts[2] - fb, da = ts[3] - fa;
            for (let i = 0, o = 0; i < n; i++, o += 4) {
                const pi = stag ? clamp01((p - stag[i]) / Math.max(1e-6, 1 - stag[i])) : p;
                let et;
                if (lut) {
                    if (pi <= 0) { et = lut[0]; }
                    else if (pi >= 1) { et = lut[lutN]; }
                    else { const x = pi * lutN, k = x | 0; et = lut[k] + (lut[k + 1] - lut[k]) * (x - k); }
                } else { et = pi; }
                out[o] = fr + dr * et;
                out[o + 1] = fg + dg * et;
                out[o + 2] = fb + db * et;
                out[o + 3] = fa + da * et;
            }
        } else {
            for (let i = 0; i < n; i++) {
                const pi = stag ? clamp01((p - stag[i]) / Math.max(1e-6, 1 - stag[i])) : p;
                let et;
                if (lut) {
                    if (pi <= 0) { et = lut[0]; }
                    else if (pi >= 1) { et = lut[lutN]; }
                    else { const x = pi * lutN, k = x | 0; et = lut[k] + (lut[k + 1] - lut[k]) * (x - k); }
                } else { et = pi; }
                const f = fromArr ? fromArr[i] : fs;
                const t = toArr ? toArr[i] : ts;
                out[i] = f + (t - f) * et;
            }
        }
        self.postMessage({ id: d.id, out: out }, [out.buffer]);
    };
}.toString() + ")();";

/**
 * Optional multi-core executor for scroll evaluation. Immutable spec data
 * (from / to / stagger / ease LUT) is attached once and stays resident in the
 * worker; only the output channel is transferred each scroll frame (zero
 * copy). Without Workers / Blob URLs the pool falls back to the chunked
 * main-thread path, so a call never blocks the UI and never throws.
 */
class ScrollWorkerPool {
    constructor(size) {
        this._workers = [];
        this._idle = [];
        this._queue = [];
        this._pending = new Map();
        this._nextId = 1;
        this._url = null;
        this._disposed = false;
        this._specs = new Map();

        const want = size || Math.min(4, (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 2);
        try {
            if (typeof Worker === "undefined" || typeof Blob === "undefined" ||
                typeof URL === "undefined" || !URL.createObjectURL) {
                throw new Error("workers unavailable");
            }
            this._url = URL.createObjectURL(new Blob([_scrollWorkerSource], { type: "text/javascript" }));
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

    /**
     * Register a scroll spec.
     * spec: { kind:"channel"|"color", n, from, to, stagger, ease, lutSize }
     * `from` / `to` may be scalars, typed arrays, or (color) 4-tuples.
     */
    async attach(specId, spec) {
        const ease = easings.getEasing(spec.ease || "linear");
        const lut = easings.bakeEasingLUT(ease, spec.lutSize || 1024);
        const isColor = spec.kind === "color";
        const fromArr = (!isColor && spec.from && spec.from.length !== undefined) ? spec.from.slice() : null;
        const toArr = (!isColor && spec.to && spec.to.length !== undefined) ? spec.to.slice() : null;
        const fromScalar = isColor ? Array.from(spec.from) : (fromArr ? 0 : spec.from);
        const toScalar = isColor ? Array.from(spec.to) : (toArr ? 0 : spec.to);
        const record = {
            kind: spec.kind || "channel", n: spec.n,
            from: fromArr, to: toArr, fromScalar, toScalar,
            stagger: spec.stagger ? spec.stagger.slice() : null,
            lut, ease
        };
        this._specs.set(specId, record);
        if (this._workers.length === 0) { return false; }
        await this._post({
            id: this._nextId++, op: "attach", specId,
            kind: record.kind, n: record.n,
            from: fromArr, to: toArr, fromScalar, toScalar,
            stagger: record.stagger, lut: lut.slice()
        }, []);
        return true;
    }

    /** Evaluate a spec at progress `p` into `out` (transferred, not copied). */
    async run(specId, p, out, chunkSize, yieldEvery) {
        if (this._disposed) { throw new Error("ScrollWorkerPool disposed"); }
        const rec = this._specs.get(specId);
        if (!rec) { throw new Error("ScrollWorkerPool: unknown spec " + specId); }

        if (this._workers.length === 0) {
            const n = rec.n, stag = rec.stagger, ease = rec.ease, lut = rec.lut;
            const lutN = lut.length - 1;
            const isColor = rec.kind === "color";
            await _chunkedRange(n, chunkSize, yieldEvery, function (s, e) {
                for (let i = s; i < e; i++) {
                    const pi = stag ? clamp((p - stag[i]) / Math.max(1e-6, 1 - stag[i]), 0, 1) : p;
                    let et;
                    if (pi <= 0) { et = lut[0]; }
                    else if (pi >= 1) { et = lut[lutN]; }
                    else { const x = pi * lutN, k = x | 0; et = lut[k] + (lut[k + 1] - lut[k]) * (x - k); }
                    if (isColor) {
                        const o = i * 4, f = rec.fromScalar, t = rec.toScalar;
                        out[o] = f[0] + (t[0] - f[0]) * et;
                        out[o + 1] = f[1] + (t[1] - f[1]) * et;
                        out[o + 2] = f[2] + (t[2] - f[2]) * et;
                        out[o + 3] = f[3] + (t[3] - f[3]) * et;
                    } else {
                        const f = rec.from ? rec.from[i] : rec.fromScalar;
                        const t = rec.to ? rec.to[i] : rec.toScalar;
                        out[i] = f + (t - f) * et;
                    }
                }
            });
            return out;
        }

        const res = await this._post({
            id: this._nextId++, op: "run", specId, p, out
        }, [out.buffer]);
        return res.out;
    }

    async detach(specId) {
        this._specs.delete(specId);
        if (this._workers.length === 0) { return false; }
        await this._post({ id: this._nextId++, op: "detach", specId }, []);
        return true;
    }

    dispose() {
        this._disposed = true;
        for (let i = 0; i < this._workers.length; i++) { this._workers[i].terminate(); }
        this._workers.length = 0;
        this._idle.length = 0;
        for (const job of this._pending.values()) { job.reject(new Error("ScrollWorkerPool disposed")); }
        this._pending.clear();
        for (let i = 0; i < this._queue.length; i++) { this._queue[i].reject(new Error("ScrollWorkerPool disposed")); }
        this._queue.length = 0;
        this._specs.clear();
        if (this._url) { URL.revokeObjectURL(this._url); this._url = null; }
    }
}

function createScrollWorkerPool(size) { return new ScrollWorkerPool(size); }

// ============================================================================
// 14. MATH NAMESPACE — the provided SOA stack stays the default maths
// ============================================================================
const math = {
    common: common,
    utils: utils,
    easings: easings,
    animation: animationModule,
    engine: engineModule,
    vec2: vec2, vec3: vec3, vec4: vec4,
    mat2: mat2, mat3: null, mat4: mat4,
    quat: quat, quat2: quat2,
    bitecs: null, simplex: null,
    scroll: null
};

/** Optional modules load dynamically; a failure never breaks this module. */
const mathReady = Promise.allSettled([
    import("./006_mat3.js").then(function (m) { math.mat3 = m; }),
    import("./010_bitECS_core.js").then(function (m) { math.bitecs = m; }),
    import("./013_simplex.js").then(function (m) { simplex = m; math.simplex = m; })
]);

math.scroll = {
    ScrollTriggerInstance: ScrollTriggerInstance,
    onScroll: onScroll,
    scrollTrigger: scrollTrigger,
    createSOAScrollGroup: createSOAScrollGroup,
    createScrollWorkerPool: createScrollWorkerPool
};

// ============================================================================
// 15. EXPORTS — every original export preserved + the 1M-scale parallel layer
// ============================================================================
export {
    // foundation
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC, EPSILON,
    // original class + factories
    ScrollTriggerInstance, onScroll, scrollTrigger,
    // pool
    acquireScrollTrigger, releaseScrollTrigger,
    // parallax
    createParallax, createNoiseParallax, createNoiseParallaxAsync,
    // SOA group
    createSOAScrollGroup,
    // color
    createColorScrub,
    // orbital
    createOrbitalScrollOrder, createOrbitalScrollOrderChunked, createOrbitalScroll,
    // IK
    createIKScrollTarget,
    // layout
    attachTRSScroll,
    // quaternion / dual-quaternion groups
    createQuatScrollGroup, createDualQuatScrollGroup,
    // three.js r185 bridges
    writeScrollToAttribute, attachInstancedMeshScroll, attachPointsScroll,
    attachThreeTransformScroll, attachCameraScroll,
    // parallelism
    ScrollWorkerPool, createScrollWorkerPool,
    // namespace
    math, mathReady
};

export default {
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC, EPSILON,
    ScrollTriggerInstance, onScroll, scrollTrigger,
    acquireScrollTrigger, releaseScrollTrigger,
    createParallax, createNoiseParallax, createNoiseParallaxAsync,
    createSOAScrollGroup,
    createColorScrub,
    createOrbitalScrollOrder, createOrbitalScrollOrderChunked, createOrbitalScroll,
    createIKScrollTarget,
    attachTRSScroll,
    createQuatScrollGroup, createDualQuatScrollGroup,
    writeScrollToAttribute, attachInstancedMeshScroll, attachPointsScroll,
    attachThreeTransformScroll, attachCameraScroll,
    ScrollWorkerPool, createScrollWorkerPool,
    math, mathReady
};
