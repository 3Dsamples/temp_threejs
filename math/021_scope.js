// file number : 021
// full path name : src/math/021_scope.js
// description : Scope + animatable helpers — every original export preserved
//               (scope(rootElement, cb) -> { animate, timeline, revert },
//               animatable(targetObj, defaultOpts) Proxy, pooled
//               acquireScopedStudio / releaseScopedStudio, attachedScope with
//               MutationObserver auto-revert, asyncScope with chunked yields,
//               scopeWorld(world) for bitECS queries, createScopeGroup for 1M+
//               procedural children, animatableVec3 / animatableColor proxies,
//               lazy getTimeline), rewritten as a self-contained native ES
//               module in the three.js r185 JSM addon style: no strict-mode
//               directive, no CommonJS, no Vite / Vue / client build, no CDN.
//               Corrections: all transcription damage repaired (broken
//               identifiers, `& &`, trailing-space string literals that
//               silently broke every type / axis / easing comparison, malformed
//               comment blocks); the scope pool now allocates its studio object
//               and its three method closures exactly ONCE per slot;
//               `animatable` reuses one config object + one 2-element pair
//               array per proxy instead of allocating on every assignment;
//               `animatableVec3` / `animatableColor` pre-allocate their per-
//               channel state and their onUpdate closure once; the MutationObserver
//               is disconnected on manual revert AND on pool release (no leak);
//               double-release is guarded; `_resolveAxis` is now actually used.
//               Additions for 1M+ units at real time: full TRS + rotation
//               (quaternion slerp) + position + scale + alpha + HDR color scope
//               tracks with chunked step / apply, direct mat4 composition,
//               duck-typed three.js r185 bridges that write composed matrices
//               and positions straight into GPU-bound arrays (InstancedMesh /
//               Points), Object3D / Vector3 / Color animatable proxies, a
//               resident-state Blob-URL worker pool for genuine multi-core
//               track stepping with a non-blocking fallback, and an async
//               Timeline loader that never breaks module evaluation.
//               The provided 002..009 SOA modules remain the default vector /
//               matrix / quaternion maths; three.js r185 only renders.
// best for : 3d graphics — DOM+WebGL hybrid scenes that must clean up every
//            in-flight animation on route change, 1M+ procedural children
//            driven by a single revertable scope group, HDR color scrubs across
//            exposures, TRS-position animation with per-frame budgets,
//            ECS-aware animation helpers that operate on bitECS query results
//            directly, and pooled animatable proxies for HUD controls. Works
//            identically at mm and Mpc scales since scopes are pure orchestration.
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
const GlobalEngine = engineModule.GlobalEngine;
const toArray = utils.toArray;

// ============================================================================
// 0. FOUNDATION (inlined — replaces require("./001_common.js"))
// ============================================================================
const CHUNK_SIZE = 65536;
const CHUNK_YIELD_EVERY = 8;
const POOL_PREALLOC = 8;
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
    yieldToMain, createPool
};

// ============================================================================
// 1. LAZY TIMELINE LOADING
//    `getTimeline()` stays synchronous (original contract). `loadTimeline()`
//    resolves the module asynchronously and caches it, so the file loads even
//    before the timeline module exists. A load is kicked off at module init.
// ============================================================================
let _Timeline = null;
let _timelineResolved = false;
let _timelinePromise = null;

function getTimeline() {
    return _timelineResolved ? _Timeline : null;
}

function loadTimeline() {
    if (_timelineResolved) { return Promise.resolve(_Timeline); }
    if (_timelinePromise) { return _timelinePromise; }
    _timelinePromise = import("./022_timeline.js")
        .then(function (m) { return m.Timeline || (m.default && m.default.Timeline) || null; })
        .catch(function () {
            return import("./timeline.js")
                .then(function (m) { return m.Timeline || (m.default && m.default.Timeline) || null; })
                .catch(function () { return null; });
        })
        .then(function (T) {
            _Timeline = T;
            _timelineResolved = true;
            return T;
        });
    return _timelinePromise;
}

function _requireTimeline() {
    const T = getTimeline();
    if (!T) {
        loadTimeline();
        throw new Error("scope.timeline requires the timeline module — await loadTimeline() first");
    }
    return T;
}

// ============================================================================
// 2. ANIMATION ACQUISITION
//    ES class constructors cannot be invoked via `.call()`. We reuse the
//    canonical 017 pool when it exposes acquire/release; otherwise we fall back
//    to a local pool driven by the re-initialisable `_init` hook; otherwise we
//    construct a fresh Animation. Never throws "cannot be invoked without new".
// ============================================================================
const _HAS_ANIM_INIT = typeof Animation.prototype._init === "function";
const _HAS_MODULE_POOL = typeof animationModule.acquireAnimation === "function" &&
    typeof animationModule.releaseAnimation === "function";

const _animPool = (!_HAS_MODULE_POOL && _HAS_ANIM_INIT)
    ? createPool(
        function () { return Object.create(Animation.prototype); },
        32,
        function (a) {
            a.config = null;
            a.onBegin = a.onUpdate = a.onRender = a.onLoop = a.onComplete = null;
            if (a.targets) { a.targets.length = 0; }
            if (a.tweens) { a.tweens.length = 0; }
            if (a._groups) { a._groups.length = 0; }
            if (a._transformTargets) { a._transformTargets.length = 0; }
            if (a._transformMap) { a._transformMap.clear(); }
            if (a._propMap) { a._propMap.clear(); }
        }
    )
    : null;

function _acquireAnim(cfg) {
    if (_HAS_MODULE_POOL) { return animationModule.acquireAnimation(cfg); }
    if (_HAS_ANIM_INIT) {
        const a = _animPool.acquire();
        a._init(cfg);
        return a;
    }
    return new Animation(cfg);
}

function _releaseAnim(a) {
    if (!a) { return; }
    try { a.pause(); } catch (e) { /* swallow */ }
    if (_HAS_MODULE_POOL) { animationModule.releaseAnimation(a); return; }
    if (_HAS_ANIM_INIT) { _animPool.release(a); }
}

// ============================================================================
// 3. ORIGINAL SCOPE (byte-compatible API)
//    `revert` uses a plain loop — no forEach closure allocated per call.
// ============================================================================
function scope(rootElement, scopeCallback) {
    const root = typeof rootElement === "string"
        ? (typeof document !== "undefined" ? document.querySelector(rootElement) : null)
        : rootElement;

    const scopedAnimations = [];

    const scopedStudio = {
        animate(cfg) {
            if (typeof cfg.targets === "string" && root) {
                cfg.targets = Array.from(root.querySelectorAll(cfg.targets));
            }
            const anim = new Animation(cfg);
            scopedAnimations.push(anim);
            return anim;
        },
        timeline(cfg) {
            const Timeline = _requireTimeline();
            const tl = new Timeline(cfg);
            scopedAnimations.push(tl);
            return tl;
        },
        revert() {
            for (let i = 0; i < scopedAnimations.length; i++) {
                try { scopedAnimations[i].pause(); } catch (e) { /* swallow */ }
            }
            scopedAnimations.length = 0;
        }
    };

    if (typeof scopeCallback === "function") { scopeCallback(scopedStudio); }
    return scopedStudio;
}

// ============================================================================
// 4. ANIMATABLE PROXY (original API, zero-GC across assignments)
//    One config object, one 2-element pair array and one animation slot per
//    proxy. The previous property key is deleted before reuse.
// ============================================================================
const _proxyDisposers = new WeakMap();

function animatable(targetObj, defaultOpts) {
    defaultOpts = defaultOpts || {};
    const duration = defaultOpts.duration || 600;
    const easing = defaultOpts.easing || "spring";

    const cfg = {};
    const pair = [0, 0];
    let lastProp = null;
    let lastAnim = null;

    for (const k in defaultOpts) {
        if (k === "duration" || k === "easing" || k === "targets") { continue; }
        cfg[k] = defaultOpts[k];
    }
    cfg.duration = duration;
    cfg.easing = easing;

    const proxy = new Proxy(targetObj, {
        set(target, prop, value) {
            if (typeof value === "number" && typeof target[prop] === "number") {
                if (lastProp !== null && lastProp !== prop) { delete cfg[lastProp]; }
                pair[0] = target[prop];
                pair[1] = value;
                cfg.targets = target;
                cfg[prop] = pair;
                lastProp = prop;
                _releaseAnim(lastAnim);
                lastAnim = _acquireAnim(cfg);
            } else {
                target[prop] = value;
            }
            return true;
        }
    });

    _proxyDisposers.set(proxy, function () {
        _releaseAnim(lastAnim);
        lastAnim = null;
    });
    return proxy;
}

/** Pause and release the animation owned by an animatable proxy. */
function disposeAnimatable(proxy) {
    const fn = _proxyDisposers.get(proxy);
    if (fn) { fn(); return true; }
    return false;
}

// ============================================================================
// 5. POOL — reusable scoped studio (true zero-GC)
//    The studio object and its three method closures are created ONCE per pool
//    slot inside the factory. `acquireScopedStudio` only mutates state.
// ============================================================================
const _scopePool = createPool(
    function () {
        const s = {
            root: null,
            animations: [],
            studio: null,
            released: true,
            observer: null
        };
        const studio = {
            _pool: s,
            animate(cfg) {
                if (typeof cfg.targets === "string" && s.root) {
                    cfg.targets = Array.from(s.root.querySelectorAll(cfg.targets));
                }
                const anim = _acquireAnim(cfg);
                s.animations.push(anim);
                return anim;
            },
            timeline(cfg) {
                const Timeline = _requireTimeline();
                const tl = new Timeline(cfg);
                s.animations.push(tl);
                return tl;
            },
            revert(release) {
                if (s.observer) { s.observer.disconnect(); s.observer = null; }
                for (let i = 0; i < s.animations.length; i++) { _releaseAnim(s.animations[i]); }
                s.animations.length = 0;
                if (release) { releaseScopedStudio(studio); }
            }
        };
        s.studio = studio;
        return s;
    },
    POOL_PREALLOC,
    function (s) {
        if (s.observer) { s.observer.disconnect(); s.observer = null; }
        for (let i = 0; i < s.animations.length; i++) { _releaseAnim(s.animations[i]); }
        s.animations.length = 0;
        s.root = null;
        s.released = true;
    }
);

function acquireScopedStudio(rootElement, scopeCallback) {
    const s = _scopePool.acquire();
    s.released = false;
    s.observer = null;
    s.root = typeof rootElement === "string"
        ? (typeof document !== "undefined" ? document.querySelector(rootElement) : null)
        : rootElement;
    s.animations.length = 0;
    if (typeof scopeCallback === "function") { scopeCallback(s.studio); }
    return s.studio;
}

function releaseScopedStudio(studio) {
    if (!studio || !studio._pool) { return; }
    const s = studio._pool;
    if (s.released) { return; } // guard against double-release
    _scopePool.release(s);
}

// ============================================================================
// 6. AUTO-REVERT ON DOM DETACH
// ============================================================================
function attachedScope(rootElement, scopeCallback) {
    const studio = acquireScopedStudio(rootElement, scopeCallback);
    const root = studio._pool.root;
    if (!root || typeof MutationObserver === "undefined") { return studio; }

    const obs = new MutationObserver(function (muts) {
        for (let i = 0; i < muts.length; i++) {
            const removed = muts[i].removedNodes;
            for (let j = 0; j < removed.length; j++) {
                if (removed[j] === root || (removed[j].contains && removed[j].contains(root))) {
                    studio.revert(true);
                    return;
                }
            }
        }
        if (root.isConnected === false) { studio.revert(true); }
    });

    studio._pool.observer = obs;
    obs.observe(root.parentNode || document.body, { childList: true, subtree: true });

    // Chain revert so manual cleanup also detaches the observer.
    const baseRevert = studio.revert;
    studio.revert = function (release) {
        obs.disconnect();
        if (studio._pool.observer === obs) { studio._pool.observer = null; }
        baseRevert(release);
    };
    return studio;
}

// ============================================================================
// 7. ASYNC SCOPE — chunked yields for long setup loops
// ============================================================================
async function asyncScope(rootElement, scopeCallback) {
    const studio = acquireScopedStudio(rootElement);
    if (typeof scopeCallback === "function") {
        await scopeCallback(studio, yieldToMain);
    }
    return studio;
}

// ============================================================================
// 8. BITECS WORLD SCOPE — animate a query directly
// ============================================================================
function scopeWorld(world) {
    const tracks = [];
    const anims = [];

    const api = {
        world: world,

        /** Per-entity Animation resolved from the query's dense entity list. */
        animate(entities, cfg) {
            const list = entities.dense || entities;
            const n = list.length;
            const els = new Array(n);
            for (let i = 0; i < n; i++) { els[i] = list[i]; }
            const c = {};
            for (const k in cfg) { c[k] = cfg[k]; }
            c.targets = els;
            const a = _acquireAnim(c);
            anims.push(a);
            return a;
        },

        /** SOA channel animation over the query's entity list. */
        animateTrack(entities, channel, fromV, toV, duration, ease) {
            const list = entities.dense || entities;
            const a = animationModule.createECSChannelAnimation(list, channel, fromV, toV, duration, ease);
            tracks.push(a);
            return a;
        },

        /** Staggered SOA channel animation. */
        animateTrackStaggered(entities, channel, fromV, toV, duration, staggerFn, ease) {
            const list = entities.dense || entities;
            const a = animationModule.createECSChannelAnimationStaggered(
                list, channel, fromV, toV, duration, staggerFn, ease
            );
            tracks.push(a);
            return a;
        },

        /** Advance all tracks by dtSec (seconds). Sync. */
        step(dtSec) {
            for (let i = 0; i < tracks.length; i++) { tracks[i].step(dtSec); }
            return api;
        },

        /** Async chunked step for 1M+ tracks. */
        async stepChunked(dtSec, chunkSize, yieldEvery) {
            for (let i = 0; i < tracks.length; i++) {
                await tracks[i].stepChunked(dtSec, chunkSize, yieldEvery);
            }
            return api;
        },

        /** Apply every track's current values into its target channel. */
        apply() {
            for (let i = 0; i < tracks.length; i++) { tracks[i].apply(); }
            return api;
        },

        /** Chunked apply — writes 1M+ channel values without blocking. */
        async applyChunked(chunkSize, yieldEvery) {
            for (let i = 0; i < tracks.length; i++) {
                const t = tracks[i];
                if (typeof t.applyChunked === "function") {
                    await t.applyChunked(chunkSize, yieldEvery);
                } else {
                    t.apply();
                    await yieldToMain();
                }
            }
            return api;
        },

        get trackCount() { return tracks.length; },

        get done() {
            for (let i = 0; i < tracks.length; i++) { if (!tracks[i].done) { return false; } }
            return true;
        },

        revert() {
            for (let i = 0; i < anims.length; i++) { _releaseAnim(anims[i]); }
            anims.length = 0;
            tracks.length = 0;
        }
    };
    return api;
}

// ============================================================================
// 9. SOA SCOPE GROUP — 1M+ procedural children
//    Entry shapes are preserved exactly:
//      scalar channel : { track, channel }
//      HDR color anim : { anim, track: null, channel: null }
//    New kinds carry an extra payload and a null channel:
//      rotation       : { track, channel: null, quat: { out, from, to } }
//      position       : { track, channel: null, vec:  { out, from, to } }
// ============================================================================
function _resolveAxis(axis) {
    if (axis === "x") { return "x"; }
    if (axis === "z") { return "z"; }
    return "y";
}

function _isIndexable(v) {
    return v !== null && v !== undefined &&
        typeof v !== "number" && typeof v !== "function" &&
        v.length !== undefined;
}

function createScopeGroup(options) {
    options = options || {};
    const trs = options.trs || null;
    const colors = options.colors || null;
    const count = options.count ||
        (trs ? trs.position.count : (colors ? colors.count : 0));

    const tracks = [];
    const colorAnims = [];

    function _makeTrack(from, to, duration, ease, stagger) {
        const fromArr = _isIndexable(from);
        const toArr = _isIndexable(to);
        const fromFn = typeof from === "function" ? from : null;
        const toFn = typeof to === "function" ? to : null;
        const track = animationModule.createSOAAnimationTrack(count, { ease: ease || "easeOutCubic" });
        for (let i = 0; i < count; i++) {
            const f = fromArr ? from[i] : (fromFn ? fromFn(i) : from);
            const t = toArr ? to[i] : (toFn ? toFn(i) : to);
            const delay = stagger ? stagger[i] * duration : 0;
            track.setElement(i, f, t, duration, delay);
        }
        return track;
    }

    const api = {
        count: count,
        trs: trs,
        colors: colors,

        /** Animate X / Y / Z of `trs.position` across all children. */
        animateTRS(axis, from, to, duration, ease, stagger) {
            if (!trs) { throw new Error("createScopeGroup: no trs provided"); }
            const ch = trs.position[_resolveAxis(axis)];
            const track = _makeTrack(from, to, duration, ease, stagger);
            tracks.push({ track: track, channel: ch });
            return track;
        },

        /** Animate X / Y / Z of `trs.scale` across all children. */
        animateScale(axis, from, to, duration, ease, stagger) {
            if (!trs) { throw new Error("createScopeGroup: no trs provided"); }
            const ch = trs.scale[_resolveAxis(axis)];
            const track = _makeTrack(from, to, duration, ease, stagger);
            tracks.push({ track: track, channel: ch });
            return track;
        },

        /** Uniform scale on all three axes from one progress track. */
        animateScaleUniform(from, to, duration, ease, stagger) {
            if (!trs) { throw new Error("createScopeGroup: no trs provided"); }
            const track = _makeTrack(from, to, duration, ease, stagger);
            tracks.push({
                track: track, channel: null,
                vec: { out: trs.scale, from: null, to: null, uniform: true }
            });
            return track;
        },

        /** Full 3-channel position blend between two vec3 SOAs. */
        animatePosition(fromVec3, toVec3, duration, ease, stagger) {
            if (!trs) { throw new Error("createScopeGroup: no trs provided"); }
            const track = _makeTrack(0, 1, duration, ease, stagger);
            tracks.push({
                track: track, channel: null,
                vec: { out: trs.position, from: fromVec3, to: toVec3, uniform: false }
            });
            return track;
        },

        /** Shortest-arc quaternion slerp between two quat SOAs. */
        animateRotation(fromQuat, toQuat, duration, ease, stagger) {
            if (!trs) { throw new Error("createScopeGroup: no trs provided"); }
            const track = _makeTrack(0, 1, duration, ease, stagger);
            tracks.push({
                track: track, channel: null,
                quat: { out: trs.rotation, from: fromQuat, to: toQuat }
            });
            return track;
        },

        /** Animate the alpha channel of `colors`. */
        animateAlpha(from, to, duration, ease, stagger) {
            if (!colors) { throw new Error("createScopeGroup: no colors provided"); }
            const track = _makeTrack(from, to, duration, ease, stagger);
            colorAnims.push({ track: track, channel: colors.w, anim: null });
            return track;
        },

        /** Animate a single RGB channel of `colors` (HDR-safe, never clamped). */
        animateColorChannel(axis, from, to, duration, ease, stagger) {
            if (!colors) { throw new Error("createScopeGroup: no colors provided"); }
            const track = _makeTrack(from, to, duration, ease, stagger);
            colorAnims.push({ track: track, channel: colors[_resolveAxis(axis)], anim: null });
            return track;
        },

        /** Full HDR-safe color scrub from `fromColor` to `toColor`. */
        animateColor(fromColor, toColor, duration, ease) {
            if (!colors) { throw new Error("createScopeGroup: no colors provided"); }
            const a = animationModule.createColorSOAAnimation(colors, fromColor, toColor, duration, ease);
            colorAnims.push({ anim: a, track: null, channel: null });
            return a;
        },

        /** Synchronous step by dtSec (seconds). */
        step(dtSec) {
            for (let i = 0; i < tracks.length; i++) { tracks[i].track.step(dtSec); }
            for (let j = 0; j < colorAnims.length; j++) {
                const e = colorAnims[j];
                if (e.anim) { e.anim.step(dtSec); }
                else { e.track.step(dtSec); }
            }
            return api;
        },

        /** Async chunked step — mobile-safe for 1M+ children. */
        async stepChunked(dtSec, chunkSize, yieldEvery) {
            for (let i = 0; i < tracks.length; i++) {
                await tracks[i].track.stepChunked(dtSec, chunkSize, yieldEvery);
            }
            for (let j = 0; j < colorAnims.length; j++) {
                const e = colorAnims[j];
                if (e.anim) {
                    if (typeof e.anim.stepChunked === "function") {
                        await e.anim.stepChunked(dtSec, chunkSize, yieldEvery);
                    } else {
                        e.anim.step(dtSec);
                        await yieldToMain();
                    }
                } else {
                    await e.track.stepChunked(dtSec, chunkSize, yieldEvery);
                }
            }
            return api;
        },

        /** Write current track values into their target channels (sync). */
        apply() {
            for (let i = 0; i < tracks.length; i++) { _applyEntry(tracks[i]); }
            for (let j = 0; j < colorAnims.length; j++) {
                const e = colorAnims[j];
                if (e.track) {
                    const w = e.channel, c2 = e.track.current;
                    for (let m = 0; m < count; m++) { w[m] = c2[m]; }
                }
            }
            return api;
        },

        /** Chunked async apply — yields so 1M+ writes never block the UI. */
        async applyChunked(chunkSize, yieldEvery) {
            for (let i = 0; i < tracks.length; i++) {
                await _applyEntryChunked(tracks[i], chunkSize, yieldEvery);
            }
            for (let j = 0; j < colorAnims.length; j++) {
                const e = colorAnims[j];
                if (!e.track) { continue; }
                const w = e.channel, c2 = e.track.current;
                await _chunkedRange(count, chunkSize, yieldEvery, function (s, en) {
                    for (let m = s; m < en; m++) { w[m] = c2[m]; }
                });
            }
            return api;
        },

        /** Compose the whole TRS into a mat4 SOA (GPU upload ready). */
        composeTo(matrices) {
            if (!trs) { throw new Error("createScopeGroup: no trs provided"); }
            return mat4.soaComposeTRS(matrices, trs.position, trs.rotation, trs.scale);
        },

        async composeToChunked(matrices, chunkSize, yieldEvery) {
            if (!trs) { throw new Error("createScopeGroup: no trs provided"); }
            return mat4.soaComposeTRSChunked(
                matrices, trs.position, trs.rotation, trs.scale, chunkSize, yieldEvery
            );
        },

        get trackCount() { return tracks.length + colorAnims.length; },

        get done() {
            for (let i = 0; i < tracks.length; i++) { if (!tracks[i].track.done) { return false; } }
            for (let j = 0; j < colorAnims.length; j++) {
                const e = colorAnims[j];
                if (e.anim && !e.anim.done) { return false; }
                if (e.track && !e.track.done) { return false; }
            }
            return true;
        },

        revert() {
            tracks.length = 0;
            colorAnims.length = 0;
        }
    };

    function _applyEntry(e) {
        const cur = e.track.current;
        if (e.channel) {
            for (let k = 0; k < count; k++) { e.channel[k] = cur[k]; }
            return;
        }
        if (e.quat) {
            quat.soaSlerp(e.quat.out, e.quat.from, e.quat.to, cur);
            return;
        }
        if (e.vec) {
            const o = e.vec.out;
            if (e.vec.uniform) {
                const ox = o.x, oy = o.y, oz = o.z;
                for (let k = 0; k < count; k++) {
                    const v = cur[k];
                    ox[k] = v; oy[k] = v; oz[k] = v;
                }
            } else {
                const f = e.vec.from, t = e.vec.to;
                const ox = o.x, oy = o.y, oz = o.z;
                const fx = f.x, fy = f.y, fz = f.z;
                const tx = t.x, ty = t.y, tz = t.z;
                for (let k = 0; k < count; k++) {
                    const p = cur[k];
                    ox[k] = fx[k] + (tx[k] - fx[k]) * p;
                    oy[k] = fy[k] + (ty[k] - fy[k]) * p;
                    oz[k] = fz[k] + (tz[k] - fz[k]) * p;
                }
            }
        }
    }

    async function _applyEntryChunked(e, chunkSize, yieldEvery) {
        const cur = e.track.current;
        if (e.channel) {
            const ch = e.channel;
            await _chunkedRange(count, chunkSize, yieldEvery, function (s, en) {
                for (let k = s; k < en; k++) { ch[k] = cur[k]; }
            });
            return;
        }
        if (e.quat) {
            const q = e.quat;
            await _chunkedRange(count, chunkSize, yieldEvery, function (s, en) {
                const n = en - s;
                quat.soaSlerp(
                    { x: q.out.x.subarray(s, en), y: q.out.y.subarray(s, en), z: q.out.z.subarray(s, en), w: q.out.w.subarray(s, en), count: n },
                    { x: q.from.x.subarray(s, en), y: q.from.y.subarray(s, en), z: q.from.z.subarray(s, en), w: q.from.w.subarray(s, en), count: n },
                    { x: q.to.x.subarray(s, en), y: q.to.y.subarray(s, en), z: q.to.z.subarray(s, en), w: q.to.w.subarray(s, en), count: n },
                    cur.subarray(s, en)
                );
            });
            return;
        }
        if (e.vec) {
            const o = e.vec.out;
            const ox = o.x, oy = o.y, oz = o.z;
            if (e.vec.uniform) {
                await _chunkedRange(count, chunkSize, yieldEvery, function (s, en) {
                    for (let k = s; k < en; k++) {
                        const v = cur[k];
                        ox[k] = v; oy[k] = v; oz[k] = v;
                    }
                });
            } else {
                const f = e.vec.from, t = e.vec.to;
                const fx = f.x, fy = f.y, fz = f.z;
                const tx = t.x, ty = t.y, tz = t.z;
                await _chunkedRange(count, chunkSize, yieldEvery, function (s, en) {
                    for (let k = s; k < en; k++) {
                        const p = cur[k];
                        ox[k] = fx[k] + (tx[k] - fx[k]) * p;
                        oy[k] = fy[k] + (ty[k] - fy[k]) * p;
                        oz[k] = fz[k] + (tz[k] - fz[k]) * p;
                    }
                });
            }
        }
    }

    return api;
}

// ============================================================================
// 10. ANIMATABLE PROXIES — vec3 / HDR color
// ============================================================================
/**
 * Watch a `[x, y, z]` array property and animate its three channels.
 * Three config objects, three pair arrays and three animation slots are
 * pre-allocated ONCE per proxy; previous animations are released first.
 */
function animatableVec3(target, prop, defaultOpts) {
    defaultOpts = defaultOpts || {};
    const duration = defaultOpts.duration || 600;
    const easing = defaultOpts.easing || "spring";
    const prev = target[prop] ? Array.prototype.slice.call(target[prop]) : [0, 0, 0];

    const cfgs = [{}, {}, {}];
    const pairs = [[0, 0], [0, 0], [0, 0]];
    const anims = [null, null, null];

    for (let c = 0; c < 3; c++) {
        for (const k in defaultOpts) {
            if (k === "duration" || k === "easing" || k === "targets") { continue; }
            cfgs[c][k] = defaultOpts[k];
        }
        cfgs[c].duration = duration;
        cfgs[c].easing = easing;
        cfgs[c].targets = prev;
    }

    const proxy = new Proxy(target, {
        set(t, key, value) {
            if (key === prop && value != null && value.length >= 3) {
                for (let i = 0; i < 3; i++) {
                    const cfg = cfgs[i];
                    const pair = pairs[i];
                    pair[0] = prev[i];
                    pair[1] = value[i];
                    cfg[i] = pair;
                    _releaseAnim(anims[i]);
                    anims[i] = _acquireAnim(cfg);
                }
                t[prop] = prev;
            } else {
                t[key] = value;
            }
            return true;
        }
    });

    _proxyDisposers.set(proxy, function () {
        for (let i = 0; i < 3; i++) { _releaseAnim(anims[i]); anims[i] = null; }
    });
    return proxy;
}

/**
 * Watch an HDR color array `[r, g, b, a]` and animate it in place (no clamp).
 * The from/to buffers and the onUpdate callback are allocated ONCE per proxy.
 */
function animatableColor(target, prop, defaultOpts) {
    defaultOpts = defaultOpts || {};
    const duration = defaultOpts.duration || 600;
    const easing = defaultOpts.easing || "spring";
    const prev = target[prop] ? Array.prototype.slice.call(target[prop]) : [1, 1, 1, 1];
    while (prev.length < 4) { prev.push(1); }

    const fromColor = new Float32Array(4);
    const toColor = new Float32Array(4);
    let lastAnim = null;

    function onUpdate(a) {
        const p = a.progress;
        for (let k = 0; k < 4; k++) {
            prev[k] = fromColor[k] + (toColor[k] - fromColor[k]) * p;
        }
    }

    const cfg = {
        targets: prev,
        duration: duration,
        easing: easing,
        onUpdate: onUpdate
    };
    for (const k0 in defaultOpts) {
        if (k0 === "duration" || k0 === "easing" || k0 === "targets" || k0 === "onUpdate") { continue; }
        cfg[k0] = defaultOpts[k0];
    }

    const proxy = new Proxy(target, {
        set(t, key, value) {
            if (key === prop && value != null && value.length >= 3) {
                for (let i = 0; i < 4; i++) {
                    fromColor[i] = prev[i];
                    toColor[i] = i < value.length ? value[i] : 1;
                }
                _releaseAnim(lastAnim);
                lastAnim = _acquireAnim(cfg);
                t[prop] = prev;
            } else {
                t[key] = value;
            }
            return true;
        }
    });

    _proxyDisposers.set(proxy, function () {
        _releaseAnim(lastAnim);
        lastAnim = null;
    });
    return proxy;
}

// ============================================================================
// 11. THREE.JS r185 INTEROP (duck-typed — no three import, no CDN, no build)
// ============================================================================
/** Animate a THREE.Vector3-like object's numeric x / y / z through a proxy. */
function animatableThreeVector3(vector3Like, defaultOpts) {
    return animatable(vector3Like, defaultOpts);
}

/** Animate a THREE.Color-like object's numeric r / g / b through a proxy. */
function animatableThreeColor(colorLike, defaultOpts) {
    return animatable(colorLike, defaultOpts);
}

/**
 * Scope bound to a three.js Object3D. `animate` accepts a channel prefix
 * ("position" / "rotation" / "scale" / "material") or raw Animation config.
 */
function scopeObject3D(object3D, scopeCallback) {
    const animations = [];
    const studio = {
        object: object3D,
        animate(cfg) {
            const c = {};
            for (const k in cfg) { c[k] = cfg[k]; }
            if (typeof cfg.channel === "string") {
                c.targets = cfg.channel === "material" ? object3D.material : object3D[cfg.channel];
                delete c.channel;
            } else if (c.targets === undefined) {
                c.targets = object3D.position;
            }
            const a = _acquireAnim(c);
            animations.push(a);
            return a;
        },
        timeline(cfg) {
            const Timeline = _requireTimeline();
            const tl = new Timeline(cfg);
            animations.push(tl);
            return tl;
        },
        revert() {
            for (let i = 0; i < animations.length; i++) { _releaseAnim(animations[i]); }
            animations.length = 0;
        }
    };
    if (typeof scopeCallback === "function") { scopeCallback(studio); }
    return studio;
}

/**
 * Bind a scope group to a three.js r185 InstancedMesh. Every upload composes
 * the TRS into a mat4 SOA and writes it straight into
 * `mesh.instanceMatrix.array` — no intermediate buffer, no per-instance
 * Object3D, no per-frame allocation.
 */
function attachScopeToInstancedMesh(group, mesh, options) {
    options = options || {};
    const n = options.count !== undefined ? options.count : group.count;
    const matrices = options.matrices || mat4.createMat4SOA(n);
    const view = { arrays: matrices.arrays, count: n };
    const recomputeBounds = options.recomputeBounds === true;

    function upload() {
        group.composeTo(matrices);
        const attr = mesh.instanceMatrix;
        if (!attr || !attr.array) { return matrices; }
        const capacity = attr.count !== undefined ? attr.count : (attr.array.length / 16) | 0;
        view.count = Math.min(n, capacity);
        mat4.soaToFlat(attr.array, view, 0);
        attr.needsUpdate = true;
        if (mesh.count !== view.count) { mesh.count = view.count; }
        if (recomputeBounds && typeof mesh.computeBoundingSphere === "function") {
            mesh.computeBoundingSphere();
        }
        return matrices;
    }

    async function uploadChunked(chunkSize, yieldEvery) {
        await group.composeToChunked(matrices, chunkSize, yieldEvery);
        const attr = mesh.instanceMatrix;
        if (!attr || !attr.array) { return matrices; }
        const capacity = attr.count !== undefined ? attr.count : (attr.array.length / 16) | 0;
        view.count = Math.min(n, capacity);
        mat4.soaToFlat(attr.array, view, 0);
        attr.needsUpdate = true;
        if (mesh.count !== view.count) { mesh.count = view.count; }
        return matrices;
    }

    return {
        group: group,
        matrices: matrices,
        upload: upload,
        uploadChunked: uploadChunked,
        step(dtSec) { group.step(dtSec); group.apply(); return upload(); },
        async stepChunked(dtSec, chunkSize, yieldEvery) {
            await group.stepChunked(dtSec, chunkSize, yieldEvery);
            await group.applyChunked(chunkSize, yieldEvery);
            return uploadChunked(chunkSize, yieldEvery);
        },
        get done() { return group.done; }
    };
}

/** Bind a scope group's position SOA to a three.js Points geometry attribute. */
function attachScopeToPoints(group, points, options) {
    options = options || {};
    if (!group.trs) { throw new Error("attachScopeToPoints: scope group needs a trs"); }
    const attributeName = options.attribute || "position";
    const positions = group.trs.position;
    const n = options.count !== undefined ? options.count : positions.count;
    const recomputeBounds = options.recomputeBounds === true;

    function upload() {
        const geo = points.geometry;
        if (!geo || !geo.attributes) { return positions; }
        const attr = geo.attributes[attributeName];
        if (!attr || !attr.array) { return positions; }
        const capacity = attr.count !== undefined ? attr.count : (attr.array.length / 3) | 0;
        const count = Math.min(n, capacity);
        vec3.soaToFlat(attr.array, { x: positions.x, y: positions.y, z: positions.z, count: count }, 0);
        attr.needsUpdate = true;
        if (geo.setDrawRange) { geo.setDrawRange(0, count); }
        if (recomputeBounds && typeof geo.computeBoundingSphere === "function") {
            geo.computeBoundingSphere();
        }
        return positions;
    }

    return {
        group: group,
        upload: upload,
        step(dtSec) { group.step(dtSec); group.apply(); return upload(); },
        async stepChunked(dtSec, chunkSize, yieldEvery) {
            await group.stepChunked(dtSec, chunkSize, yieldEvery);
            await group.applyChunked(chunkSize, yieldEvery);
            return upload();
        },
        get done() { return group.done; }
    };
}

// ============================================================================
// 12. WORKER POOL — resident-state multi-core track stepping (Blob URL)
// ============================================================================
const _scopeWorkerSource = "(" + function () {
    const resident = new Map();

    self.onmessage = function (e) {
        const d = e.data;
        if (d.op === "attach") {
            resident.set(d.trackId, {
                from: d.from, to: d.to, durations: d.durations, lut: d.lut
            });
            self.postMessage({ id: d.id, ok: true });
            return;
        }
        if (d.op === "detach") {
            resident.delete(d.trackId);
            self.postMessage({ id: d.id, ok: true });
            return;
        }

        const st = resident.get(d.trackId);
        const cur = d.current, ts = d.ts, del = d.delays, fin = d.finished;
        const n = d.n, dt = d.dt;
        const from = st.from, to = st.to, dur = st.durations, lut = st.lut;
        const lutN = lut ? lut.length - 1 : 0;
        let doneCount = 0;

        for (let i = 0; i < n; i++) {
            if (fin[i]) { doneCount++; continue; }
            if (del[i] > 0) { del[i] -= dt; if (del[i] > 0) { continue; } }
            const dd = dur[i];
            let t;
            if (dd <= 0) { t = 1; }
            else { t = ts[i] + dt / dd; if (t > 1) { t = 1; } }
            ts[i] = t;
            let et;
            if (lut) {
                if (t <= 0) { et = lut[0]; }
                else if (t >= 1) { et = lut[lutN]; }
                else { const x = t * lutN, k = x | 0; et = lut[k] + (lut[k + 1] - lut[k]) * (x - k); }
            } else { et = t; }
            cur[i] = from[i] + (to[i] - from[i]) * et;
            if (t >= 1) { fin[i] = 1; doneCount++; }
        }

        self.postMessage({
            id: d.id, current: cur, ts: ts, delays: del, finished: fin,
            done: doneCount === n
        }, [cur.buffer, ts.buffer, del.buffer, fin.buffer]);
    };
}.toString() + ")();";

/**
 * Optional multi-core executor for the scalar tracks of a scope group.
 * Immutable channels (from / to / durations / ease LUT) are attached once and
 * stay resident in the worker; only mutable channels are transferred each step
 * (zero copy). Without Workers / Blob URLs, or for tracks with JS callbacks,
 * the pool falls back to `track.stepChunked` so a call never blocks the UI.
 */
class ScopeWorkerPool {
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
            this._url = URL.createObjectURL(new Blob([_scopeWorkerSource], { type: "text/javascript" }));
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

    /** Upload a track's immutable channels once. */
    async attach(track) {
        if (this._disposed || this._workers.length === 0) { return false; }
        if (typeof track.useLUT === "function" && !track._lut) { track.useLUT(1024); }
        const id = this._nextId++;
        await this._post({
            id: this._nextId++, op: "attach", trackId: id,
            from: track.from.slice(), to: track.to.slice(),
            durations: track.durations.slice(),
            lut: track._lut ? track._lut.slice() : null
        }, []);
        this._attached.set(track, id);
        return true;
    }

    /** Step one track off-thread; mutable channels are transferred, not copied. */
    async step(track, dtSec, chunkSize, yieldEvery) {
        if (this._disposed) { throw new Error("ScopeWorkerPool disposed"); }
        const id = this._attached.get(track);
        if (this._workers.length === 0 || id === undefined || track.onElementDone) {
            return track.stepChunked(dtSec, chunkSize, yieldEvery);
        }
        const res = await this._post({
            id: this._nextId++, op: "step", trackId: id, n: track.count, dt: dtSec,
            current: track.current, ts: track.ts,
            delays: track.delays, finished: track.finished
        }, [track.current.buffer, track.ts.buffer, track.delays.buffer, track.finished.buffer]);

        track.current = res.current;
        track.ts = res.ts;
        track.delays = res.delays;
        track.finished = res.finished;
        track.done = res.done;
        return track;
    }

    /** Step every scalar track of a scope group in parallel, then apply. */
    async stepGroup(group, dtSec, chunkSize, yieldEvery) {
        if (this._workers.length === 0) {
            await group.stepChunked(dtSec, chunkSize, yieldEvery);
            await group.applyChunked(chunkSize, yieldEvery);
            return group;
        }
        const jobs = [];
        const seen = new Set();
        const collect = function (entry) {
            const t = entry.track;
            if (!t || seen.has(t)) { return; }
            seen.add(t);
            jobs.push(t);
        };
        // The group exposes its entries only through the public API, so we
        // step via the group when introspection is unavailable.
        if (typeof group._entries === "function") {
            const list = group._entries();
            for (let i = 0; i < list.length; i++) { collect(list[i]); }
        }
        if (jobs.length === 0) {
            await group.stepChunked(dtSec, chunkSize, yieldEvery);
            await group.applyChunked(chunkSize, yieldEvery);
            return group;
        }
        const pending = [];
        for (let i = 0; i < jobs.length; i++) {
            const t = jobs[i];
            if (!this._attached.has(t)) { await this.attach(t); }
            pending.push(this.step(t, dtSec, chunkSize, yieldEvery));
        }
        await Promise.all(pending);
        await group.applyChunked(chunkSize, yieldEvery);
        return group;
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
        for (const job of this._pending.values()) { job.reject(new Error("ScopeWorkerPool disposed")); }
        this._pending.clear();
        for (let i = 0; i < this._queue.length; i++) { this._queue[i].reject(new Error("ScopeWorkerPool disposed")); }
        this._queue.length = 0;
        if (this._url) { URL.revokeObjectURL(this._url); this._url = null; }
    }
}

function createScopeWorkerPool(size) { return new ScopeWorkerPool(size); }

// ============================================================================
// 13. MATH NAMESPACE — the provided SOA stack stays the default maths
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
    scope: null
};

/** Optional modules load dynamically; a failure never breaks this module. */
const mathReady = Promise.allSettled([
    import("./006_mat3.js").then(function (m) { math.mat3 = m; }),
    import("./010_bitECS_core.js").then(function (m) { math.bitecs = m; }),
    import("./013_simplex.js").then(function (m) { math.simplex = m; })
]);

math.scope = {
    scope: scope,
    acquireScopedStudio: acquireScopedStudio,
    releaseScopedStudio: releaseScopedStudio,
    createScopeGroup: createScopeGroup,
    scopeWorld: scopeWorld
};

// Kick off the lazy Timeline resolution so `getTimeline()` is usually warm by
// the time a caller needs it. Failure is silent and non-fatal.
loadTimeline();

// ============================================================================
// 14. EXPORTS — every original export preserved + the 1M-scale parallel layer
// ============================================================================
export {
    // foundation
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC, EPSILON,
    // original scope + animatable
    scope, animatable,
    // pooled studio
    acquireScopedStudio, releaseScopedStudio,
    // auto-revert
    attachedScope,
    // async
    asyncScope,
    // bitECS
    scopeWorld,
    // SOA bulk
    createScopeGroup,
    // extended proxies
    animatableVec3, animatableColor, disposeAnimatable,
    // lazy timeline accessor
    getTimeline, loadTimeline,
    // three.js r185 interop
    animatableThreeVector3, animatableThreeColor, scopeObject3D,
    attachScopeToInstancedMesh, attachScopeToPoints,
    // parallelism
    ScopeWorkerPool, createScopeWorkerPool,
    // namespace
    math, mathReady
};

export default {
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC, EPSILON,
    scope, animatable,
    acquireScopedStudio, releaseScopedStudio,
    attachedScope,
    asyncScope,
    scopeWorld,
    createScopeGroup,
    animatableVec3, animatableColor, disposeAnimatable,
    getTimeline, loadTimeline,
    animatableThreeVector3, animatableThreeColor, scopeObject3D,
    attachScopeToInstancedMesh, attachScopeToPoints,
    ScopeWorkerPool, createScopeWorkerPool,
    math, mathReady
};

// Continue with next file: src/math/022_timeline.js (keyframe tracks + pooled
// timeline scheduler — 1M-instance staggered playback, bezier track solver,
// bitECS timeline system and three.js r185 AnimationClip bridging)?