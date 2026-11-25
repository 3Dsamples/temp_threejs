// file number : 019
// full path name : src/math/019_timers.js
// description : Timer / scheduling layer — every original export, class and
//               method preserved (Timer with duration / loop / onTick /
//               onComplete / autoplay, play / pause / restart / _step,
//               timeScale, endDelay, maxLoops, onBegin / onLoop, Float64
//               simulationTime, stepFixed, stepChunked, getProgress /
//               getRemaining / isComplete; zero-GC pool; after(); the SOA
//               TimerGroup; createFixedStepScheduler; createOrbitalEpoch;
//               batchTick), rewritten as a self-contained native ES module in
//               the three.js r185 JSM addon style: no strict-mode directive,
//               no CommonJS, no Vite / Vue / client build, no CDN request.
//               Corrections: all transcription damage repaired (broken
//               identifiers, `& &`, `| |`, trailing-space string literals,
//               malformed comment blocks, `Uint8A rray` / `Float64 Array`),
//               and `Timer.call()` on a class replaced by a real `_init()` so
//               pooling works. `_step(deltaMs)` now honours the delta supplied
//               by the 016 engine instead of ignoring it.
//               Additions for 1M+ units at real time: O(1) active counting,
//               per-timer normalized + eased progress channels ready for GPU
//               upload, staggered timer groups driven by the procedural
//               stagger helpers, chunked-yielding counterparts everywhere,
//               a fixed-step scheduler that can yield between catch-up steps,
//               an orbital epoch that advances AND solves 1M Kepler bodies in
//               one pass, duck-typed three.js r185 bridges (Clock /
//               setAnimationLoop / BufferAttribute / InstancedMesh) and a
//               resident-state Blob-URL worker pool for genuine multi-core
//               timer stepping with a non-blocking main-thread fallback.
//               The provided 002..018 SOA stack stays the default vector /
//               matrix / quaternion maths; three.js r185 only renders.
// best for : 3d graphics — animation timing independent of display refresh
//            rate, per-particle spawn / despawn timers at 1M+ scale, orbital
//            epoch advance (Kepler mean anomaly) for 1M+ planets / asteroids /
//            dust, deterministic integration of natural IK targets
//            (FABRIK / CCD timers), reloading procedural chunks on a fixed
//            cadence, measuring HDR color fade durations precisely, and
//            driving simulation steps at 30 / 60 / 90 / 120 / 144 Hz from a
//            single unified clock without frame-rate drift on Android 64-bit.
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

const GlobalEngine = engineModule.GlobalEngine;

// ============================================================================
// 0. FOUNDATION (inlined — replaces require("./001_common.js"))
// ============================================================================
const CHUNK_SIZE = 65536;
const CHUNK_YIELD_EVERY = 8;
const POOL_PREALLOC = 32;
const TWO_PI = Math.PI * 2;
const MAX_SUB_STEP_MS = 16;

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

const _tmpPos = new Float32Array(3);

const common = {
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC, MAX_SUB_STEP_MS,
    yieldToMain, createPool, now: nowMs
};

// ============================================================================
// 1. TIMER (original API preserved; `_init` makes class pooling legal)
// ============================================================================
class Timer {
    constructor(config) {
        this._init(config || {});
    }

    /** Re-initialisable constructor body — used by the pool as well. */
    _init(config) {
        // --- original fields (exact defaults) ---
        this.duration = config.duration || Infinity;
        this.loop = config.loop || false;
        this.onTick = config.onTick || null;
        this.onComplete = config.onComplete || null;
        this.currentTime = 0;
        this.isRunning = false;
        this.lastStepTime = 0;

        // --- opt-in extensions (defaults preserve original behaviour) ---
        this.timeScale = config.timeScale !== undefined ? config.timeScale : 1;
        this.endDelay = config.endDelay || 0;
        this.onBegin = config.onBegin || null;
        this.onLoop = config.onLoop || null;
        this.maxLoops = config.maxLoops !== undefined ? config.maxLoops : Infinity;
        this._loopCount = 0;
        this.began = false;
        this.simulationTime = 0; // Float64 seconds since start (Mpc-scale safe)

        if (config.autoplay !== false) { this.play(); }
        return this;
    }

    // ---- original API ----
    play() {
        this.isRunning = true;
        this.lastStepTime = nowMs();
        GlobalEngine.add(this);
        return this;
    }

    pause() {
        this.isRunning = false;
        GlobalEngine.remove(this);
        return this;
    }

    restart() {
        this.currentTime = 0;
        this._loopCount = 0;
        this.began = false;
        return this.play();
    }

    /**
     * Called by `GlobalEngine` once per frame. Clamps dt to 64 ms, advances
     * `currentTime`, fires `onTick`, then completes or loops. When the engine
     * supplies `deltaMs` it is honoured; otherwise the timer self-times.
     */
    _step(deltaMs) {
        if (!this.isRunning) { return; }
        const now = nowMs();
        const raw = typeof deltaMs === "number" ? deltaMs : (now - (this.lastStepTime || now));
        const dt = Math.min(64, Math.max(0, raw)) * this.timeScale;
        this.lastStepTime = now;
        this._advance(dt);
    }

    /** Deterministic fixed-step advance (caller provides the exact delta). */
    stepFixed(dtMs) {
        if (!this.isRunning) { return this; }
        this._advance(Math.max(0, dtMs) * this.timeScale);
        return this;
    }

    /** Chunked async — splits a huge delta into <=16 ms sub-steps and yields. */
    async stepChunked(dtMs) {
        if (!this.isRunning) { return this; }
        let remaining = Math.max(0, dtMs);
        while (remaining > 0) {
            const chunk = Math.min(MAX_SUB_STEP_MS, remaining);
            this._advance(chunk * this.timeScale);
            remaining -= chunk;
            if (!this.isRunning) { break; }
            await yieldToMain();
        }
        return this;
    }

    /** Internal advance — every original feature preserved. */
    _advance(dtMs) {
        this.currentTime += dtMs;
        this.simulationTime += dtMs * 0.001;

        if (!this.began) {
            this.began = true;
            if (this.onBegin) { this.onBegin(this); }
        }
        if (this.onTick) { this.onTick(this.currentTime); }

        const totalTime = this.duration + this.endDelay;
        if (this.currentTime >= totalTime) {
            if (this.loop) {
                this._loopCount++;
                if (this._loopCount >= this.maxLoops) {
                    this.pause();
                    if (this.onComplete) { this.onComplete(this); }
                    return;
                }
                this.currentTime = 0;
                if (this.onLoop) { this.onLoop(this); }
            } else {
                this.pause();
                if (this.onComplete) { this.onComplete(this); }
            }
        }
    }

    /** Progress as a fraction in [0,1]. */
    getProgress() {
        const total = this.duration + this.endDelay;
        if (!isFinite(total) || total <= 0) { return 0; }
        const p = this.currentTime / total;
        return p < 0 ? 0 : (p > 1 ? 1 : p);
    }

    /** Remaining time in ms (may be Infinity). */
    getRemaining() {
        return (this.duration + this.endDelay) - this.currentTime;
    }

    /** Whether the timer has actually completed (single-shot only). */
    isComplete() {
        return !this.isRunning &&
            this.currentTime >= (this.duration + this.endDelay) &&
            !this.loop;
    }

    dispose() {
        this.pause();
        this.onTick = this.onComplete = this.onBegin = this.onLoop = null;
    }
}

// ============================================================================
// 2. POOL — zero-GC reuse of Timer instances
// ============================================================================
const _timerPool = createPool(
    function () { return Object.create(Timer.prototype); },
    POOL_PREALLOC,
    function (t) {
        t.duration = Infinity;
        t.loop = false;
        t.onTick = null;
        t.onComplete = null;
        t.onBegin = null;
        t.onLoop = null;
        t.currentTime = 0;
        t.isRunning = false;
        t.lastStepTime = 0;
        t.timeScale = 1;
        t.endDelay = 0;
        t.maxLoops = Infinity;
        t._loopCount = 0;
        t.began = false;
        t.simulationTime = 0;
    }
);

function acquireTimer(config) {
    const t = _timerPool.acquire();
    t._init(config || {});
    return t;
}

function releaseTimer(t) {
    t.pause();
    _timerPool.release(t);
}

// ============================================================================
// 3. ONE-SHOT HELPER (setTimeout-style but frame-synced)
// ============================================================================
function after(ms, fn, options) {
    options = options || {};
    const cfg = {
        duration: ms,
        onComplete: function (t) { if (fn) { fn(t); } },
        autoplay: options.autoplay !== false
    };
    if (options.onBegin) { cfg.onBegin = options.onBegin; }
    if (options.onTick) { cfg.onTick = options.onTick; }
    if (options.timeScale) { cfg.timeScale = options.timeScale; }
    if (options.endDelay) { cfg.endDelay = options.endDelay; }
    return new Timer(cfg);
}

// ============================================================================
// 4. TIMER GROUP (SOA) — 1M+ independent timers, one tight loop
// ============================================================================
/**
 * SOA-backed group of N independent timers. A single callback per group (not
 * per timer) keeps the hot loop allocation-free. `progress` is maintained
 * every step so it can be uploaded straight to a GPU attribute.
 */
class TimerGroup {
    constructor(count, options) {
        options = options || {};
        this.count = count;
        this.durations = new Float64Array(count);
        this.currentTimes = new Float64Array(count);
        this.actives = new Uint8Array(count);
        this.loopFlags = new Uint8Array(count);
        this.loopCounts = new Uint32Array(count);
        this.maxLoopsArr = new Uint32Array(count);
        this.endDelays = new Float64Array(count);
        this.progress = new Float32Array(count);

        this.onTick = options.onTick || null;
        this.onComplete = options.onComplete || null;
        this.onLoop = options.onLoop || null;
        this._timeScale = options.timeScale !== undefined ? options.timeScale : 1;
        this._activeCount = 0;

        // Optional eased progress channel (LUT: one table tap per element).
        this.ease = options.ease ? easings.getEasing(options.ease) : null;
        this._lut = this.ease ? easings.bakeEasingLUT(this.ease, options.lutSize || 1024) : null;
        this.eased = this._lut ? new Float32Array(count) : null;

        // durations
        if (options.durations) {
            this.durations.set(options.durations);
        } else {
            const defDur = options.defaultDuration !== undefined ? options.defaultDuration : 1000;
            this.durations.fill(defDur);
        }

        // loop configuration
        if (options.loops !== undefined) {
            const lp = options.loops;
            if (Array.isArray(lp) || (lp && lp.BYTES_PER_ELEMENT !== undefined)) {
                for (let i = 0; i < count; i++) {
                    const lv = lp[i];
                    if (lv) {
                        this.loopFlags[i] = 1;
                        this.maxLoopsArr[i] = (typeof lv === "number") ? lv : 0;
                    }
                }
            } else if (typeof lp === "number") {
                this.loopFlags.fill(1);
                this.maxLoopsArr.fill(lp);
            } else if (lp === true) {
                this.loopFlags.fill(1);
                this.maxLoopsArr.fill(0); // 0 == infinite
            }
        }

        // end delays
        if (options.endDelays) { this.endDelays.set(options.endDelays); }
        else if (options.endDelay) { this.endDelays.fill(options.endDelay); }

        // initial state
        if (options.initialCurrentTimes) { this.currentTimes.set(options.initialCurrentTimes); }
        if (options.delays) {
            // Negative currentTime acts as a per-timer start delay.
            const d = options.delays;
            for (let i = 0; i < count; i++) { this.currentTimes[i] = -d[i]; }
        }
        if (options.autoplay !== false) {
            this.actives.fill(1);
            this._activeCount = count;
        }
        this._refreshProgress(0, count);
    }

    get activeCount() { return this._activeCount; }
    get timeScale() { return this._timeScale; }

    _sampleEase(t) {
        const lut = this._lut;
        const n = lut.length - 1;
        if (t <= 0) { return lut[0]; }
        if (t >= 1) { return lut[n]; }
        const x = t * n, k = x | 0;
        return lut[k] + (lut[k + 1] - lut[k]) * (x - k);
    }

    _refreshProgress(s, e) {
        const cur = this.currentTimes, dur = this.durations, ed = this.endDelays;
        const pr = this.progress, ea = this.eased;
        for (let i = s; i < e; i++) {
            const total = dur[i] + ed[i];
            let p = total > 0 ? cur[i] / total : 1;
            if (p < 0) { p = 0; } else if (p > 1) { p = 1; }
            pr[i] = p;
            if (ea) { ea[i] = this._sampleEase(p); }
        }
    }

    _stepRange(s, e, scaledDt) {
        const cur = this.currentTimes, dur = this.durations, ed = this.endDelays;
        const act = this.actives, lf = this.loopFlags, lc = this.loopCounts, ml = this.maxLoopsArr;
        const pr = this.progress, ea = this.eased;
        const onTick = this.onTick, onComplete = this.onComplete, onLoop = this.onLoop;
        const lut = this._lut;
        let completed = 0;

        for (let i = s; i < e; i++) {
            if (!act[i]) { continue; }
            const t = cur[i] + scaledDt;
            cur[i] = t;
            const total = dur[i] + ed[i];
            let p = total > 0 ? t / total : 1;
            if (p < 0) { p = 0; } else if (p > 1) { p = 1; }
            pr[i] = p;
            if (ea) {
                if (lut) {
                    const n = lut.length - 1;
                    if (p <= 0) { ea[i] = lut[0]; }
                    else if (p >= 1) { ea[i] = lut[n]; }
                    else { const x = p * n, k = x | 0; ea[i] = lut[k] + (lut[k + 1] - lut[k]) * (x - k); }
                } else { ea[i] = p; }
            }
            if (onTick) { onTick(i, t); }
            if (t >= total) {
                if (lf[i]) {
                    lc[i]++;
                    if (ml[i] > 0 && lc[i] >= ml[i]) {
                        act[i] = 0;
                        completed++;
                        if (onComplete) { onComplete(i); }
                        continue;
                    }
                    cur[i] = 0;
                    pr[i] = 0;
                    if (ea) { ea[i] = lut ? lut[0] : 0; }
                    if (onLoop) { onLoop(i); }
                } else {
                    act[i] = 0;
                    completed++;
                    if (onComplete) { onComplete(i); }
                }
            }
        }
        this._activeCount -= completed;
        return completed;
    }

    /** Synchronous step — 1M+ timers in a single tight loop. */
    step(dtMs) {
        this._stepRange(0, this.count, dtMs * this._timeScale);
        return this;
    }

    /** Chunked async — mobile-safe: yields every `yieldEvery` chunks. */
    async stepChunked(dtMs, chunkSize, yieldEvery) {
        const scaled = dtMs * this._timeScale;
        const self = this;
        await _chunkedRange(this.count, chunkSize, yieldEvery, function (s, e) {
            self._stepRange(s, e, scaled);
        });
        return this;
    }

    start(i) {
        if (!this.actives[i]) { this.actives[i] = 1; this._activeCount++; }
        return this;
    }
    startAll() { this.actives.fill(1); this._activeCount = this.count; return this; }
    stop(i) {
        if (this.actives[i]) { this.actives[i] = 0; this._activeCount--; }
        return this;
    }
    stopAll() { this.actives.fill(0); this._activeCount = 0; return this; }

    restart(i) {
        this.currentTimes[i] = 0;
        this.loopCounts[i] = 0;
        this.progress[i] = 0;
        if (this.eased) { this.eased[i] = this._lut ? this._lut[0] : 0; }
        this.start(i);
        return this;
    }
    restartAll() {
        this.currentTimes.fill(0);
        this.loopCounts.fill(0);
        this.progress.fill(0);
        if (this.eased) { this.eased.fill(this._lut ? this._lut[0] : 0); }
        this.actives.fill(1);
        this._activeCount = this.count;
        return this;
    }

    setDuration(i, d) { this.durations[i] = d; return this; }
    setDurations(arr) { this.durations.set(arr); return this; }
    setEndDelay(i, d) { this.endDelays[i] = d; return this; }
    setLoop(i, flag, maxLoops) {
        this.loopFlags[i] = flag ? 1 : 0;
        this.maxLoopsArr[i] = maxLoops !== undefined ? maxLoops : 0;
        return this;
    }
    setTimeScale(s) { this._timeScale = s; return this; }
    getTimeScale() { return this._timeScale; }
    getProgress(i) { return this.progress[i]; }
    getActiveCount() { return this._activeCount; }

    /** Write normalized (or eased) progress into a Float32Array for upload. */
    writeProgress(out, count, useEased) {
        const n = count === undefined ? this.count : count;
        const src = (useEased !== false && this.eased) ? this.eased : this.progress;
        out.set(src.subarray(0, n));
        return out;
    }

    /** Write progress into an ECS component channel indexed by entity id. */
    applyTo(channel, eids, useEased) {
        const src = (useEased !== false && this.eased) ? this.eased : this.progress;
        const n = eids.length < this.count ? eids.length : this.count;
        for (let i = 0; i < n; i++) { channel[eids[i]] = src[i]; }
        return channel;
    }

    setEase(e, lutSize) {
        this.ease = e ? easings.getEasing(e) : null;
        this._lut = this.ease ? easings.bakeEasingLUT(this.ease, lutSize || 1024) : null;
        if (this._lut && !this.eased) { this.eased = new Float32Array(this.count); }
        if (!this._lut) { this.eased = null; }
        this._refreshProgress(0, this.count);
        return this;
    }
}

function createTimerGroup(count, options) {
    return new TimerGroup(count, options);
}

/**
 * Staggered timer group: per-timer start delays produced by a stagger
 * function (index / radial / noise / Voronoi / hash / grid). Drives 1M+
 * spawn / despawn waves from a single call.
 */
function createStaggeredTimerGroup(count, options) {
    options = options || {};
    const delays = new Float32Array(count);
    const spread = options.spread !== undefined ? options.spread : 1000;
    let fn;
    if (typeof options.stagger === "function") {
        fn = options.stagger;
    } else if (options.positions && utils.staggerForEntities) {
        fn = utils.staggerForEntities(options.positions, options.staggerOptions || { mode: "radial" });
    } else if (utils.stagger) {
        fn = utils.stagger(1, options.staggerOptions || {});
    } else {
        fn = function (i, n) { return n > 1 ? i / (n - 1) : 0; };
    }
    for (let i = 0; i < count; i++) {
        const f = fn(i, count);
        delays[i] = (f < 0 ? 0 : (f > 1 ? 1 : f)) * spread;
    }
    const opts = Object.assign({}, options);
    opts.delays = delays;
    return new TimerGroup(count, opts);
}

// ============================================================================
// 5. FIXED-STEP SCHEDULER (60 / 90 / 120 / 144 Hz safe)
// ============================================================================
/**
 * Accumulates real dt and fires `onFixedStep(fixedDtSec)` in fixed-size
 * chunks. A spiral-of-death guard caps the number of catch-up steps.
 */
function createFixedStepScheduler(hz, onFixedStep, maxSteps) {
    let rate = hz > 0 ? hz : 60;
    let stepMs = 1000 / rate;
    let accumulator = 0;
    const cap = maxSteps || 8;

    return {
        step(dtMs) {
            accumulator += dtMs;
            let steps = 0;
            while (accumulator >= stepMs && steps < cap) {
                onFixedStep(stepMs * 0.001);
                accumulator -= stepMs;
                steps++;
            }
            if (steps === cap) { accumulator = 0; }
            return steps;
        },
        /** Yielding variant — heavy fixed systems never freeze the UI. */
        async stepChunked(dtMs, yieldEvery) {
            accumulator += dtMs;
            let steps = 0, c = 0;
            const every = yieldEvery || 1;
            while (accumulator >= stepMs && steps < cap) {
                onFixedStep(stepMs * 0.001);
                accumulator -= stepMs;
                steps++;
                if (++c >= every) { c = 0; await yieldToMain(); }
            }
            if (steps === cap) { accumulator = 0; }
            return steps;
        },
        reset() { accumulator = 0; return this; },
        getAccumulator() { return accumulator; },
        getHz() { return rate; },
        getStepMs() { return stepMs; },
        setHz(v) { if (v > 0) { rate = v; stepMs = 1000 / v; } return this; }
    };
}

// ============================================================================
// 6. ORBITAL EPOCH — advance Kepler mean anomaly by real time
// ============================================================================
/**
 * Advance the mean anomaly M of every entry in `elements` by `n * dt`, where
 * `n = sqrt(mu / a³)` (Kepler's third law). M wraps in [0, 2π) by default.
 * Ideal for 1M+ bodies: no per-entity timer objects, one typed-array pass.
 */
function createOrbitalEpoch(elements, options) {
    options = options || {};
    let mu = options.mu !== undefined ? options.mu : 1;
    let timeScale = options.timeScale !== undefined ? options.timeScale : 1;
    let wrap = options.wrap !== false;

    function _range(s, e, scaled) {
        const aArr = elements.a, MArr = elements.M;
        for (let i = s; i < e; i++) {
            const a = aArr[i];
            const meanMotion = Math.sqrt(mu / (a * a * a));
            let M = MArr[i] + scaled * meanMotion;
            if (wrap) { M = M % TWO_PI; }
            MArr[i] = M;
        }
    }

    function step(dtSec) {
        _range(0, elements.a.length, dtSec * timeScale);
        return elements;
    }

    async function stepChunked(dtSec, chunkSize, yieldEvery) {
        const scaled = dtSec * timeScale;
        await _chunkedRange(elements.a.length, chunkSize, yieldEvery, function (s, e) {
            _range(s, e, scaled);
        });
        return elements;
    }

    /** Advance the epoch AND solve Kepler positions for 1M+ bodies. */
    function advanceAndSolve(outPos, dtSec) {
        const aArr = elements.a, eArr = elements.e, MArr = elements.M;
        const inc = elements.inc, Om = elements.Om, om = elements.om;
        const ox = outPos.x, oy = outPos.y, oz = outPos.z;
        const scaled = dtSec * timeScale;
        const n = aArr.length;
        for (let i = 0; i < n; i++) {
            const a = aArr[i];
            const meanMotion = Math.sqrt(mu / (a * a * a));
            let M = MArr[i] + scaled * meanMotion;
            if (wrap) { M = M % TWO_PI; }
            MArr[i] = M;
            vec3.keplerOrbit3D(_tmpPos, a, eArr[i], M, inc[i], Om[i], om[i]);
            ox[i] = _tmpPos[0]; oy[i] = _tmpPos[1]; oz[i] = _tmpPos[2];
        }
        return outPos;
    }

    async function advanceAndSolveChunked(outPos, dtSec, chunkSize, yieldEvery) {
        const aArr = elements.a, eArr = elements.e, MArr = elements.M;
        const inc = elements.inc, Om = elements.Om, om = elements.om;
        const ox = outPos.x, oy = outPos.y, oz = outPos.z;
        const scaled = dtSec * timeScale;
        await _chunkedRange(aArr.length, chunkSize, yieldEvery, function (s, e) {
            for (let i = s; i < e; i++) {
                const a = aArr[i];
                const meanMotion = Math.sqrt(mu / (a * a * a));
                let M = MArr[i] + scaled * meanMotion;
                if (wrap) { M = M % TWO_PI; }
                MArr[i] = M;
                vec3.keplerOrbit3D(_tmpPos, a, eArr[i], M, inc[i], Om[i], om[i]);
                ox[i] = _tmpPos[0]; oy[i] = _tmpPos[1]; oz[i] = _tmpPos[2];
            }
        });
        return outPos;
    }

    return {
        step: step,
        stepChunked: stepChunked,
        advanceAndSolve: advanceAndSolve,
        advanceAndSolveChunked: advanceAndSolveChunked,
        setMu(newMu) { mu = newMu; return this; },
        getMu() { return mu; },
        setTimeScale(s) { timeScale = s; return this; },
        getTimeScale() { return timeScale; },
        setWrap(v) { wrap = v !== false; return this; },
        getMeanMotion(i) {
            const a = elements.a[i];
            return Math.sqrt(mu / (a * a * a));
        }
    };
}

// ============================================================================
// 7. BATCH TICK — deterministic ordering of an array of Timer instances
// ============================================================================
function batchTick(timers, dtMs) {
    const list = timers && timers.dense ? timers.dense : timers;
    for (let i = 0; i < list.length; i++) {
        if (list[i].isRunning) { list[i].stepFixed(dtMs); }
    }
    return list;
}

async function batchTickChunked(timers, dtMs, chunkSize, yieldEvery) {
    const list = timers && timers.dense ? timers.dense : timers;
    await _chunkedRange(list.length, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) {
            if (list[i].isRunning) { list[i].stepFixed(dtMs); }
        }
    });
    return list;
}

// ============================================================================
// 8. THREE.JS r185 INTEROP (duck-typed — no three import, no CDN, no build)
// ============================================================================
/**
 * Drive the 016 engine from a three.js r185 renderer's animation loop.
 * The engine stops requesting its own frames; exactly one loop survives.
 */
function driveEngineWithThree(renderer, engine, options) {
    options = options || {};
    const target = engine || GlobalEngine;
    let last = -1;
    if (typeof target.setExternalDrive === "function") { target.setExternalDrive(true); }
    renderer.setAnimationLoop(function (time) {
        const now = typeof time === "number" ? time : nowMs();
        const dt = last < 0 ? (1000 / (options.fps || 60)) : (now - last);
        last = now;
        if (typeof target.advance === "function") { target.advance(dt); }
        else { batchTick(Array.from(target.animations), dt); }
    });
    return function stop() {
        renderer.setAnimationLoop(null);
        if (typeof target.setExternalDrive === "function") { target.setExternalDrive(false); }
    };
}

/** Read a three.js r185 Clock delta (seconds) and tick a group (milliseconds). */
function tickGroupFromThreeClock(group, clock, useChunked) {
    const dtMs = clock.getDelta() * 1000;
    return useChunked ? group.stepChunked(dtMs) : group.step(dtMs);
}

/** Upload group progress into a three.js r185 (Instanced)BufferAttribute. */
function writeProgressToAttribute(group, attribute, count, useEased) {
    const n = count === undefined ? Math.min(group.count, attribute.count) : count;
    const src = (useEased !== false && group.eased) ? group.eased : group.progress;
    attribute.array.set(src.subarray(0, n));
    attribute.needsUpdate = true;
    return attribute;
}

/**
 * Bind a timer group to a three.js r185 InstancedMesh: each step uploads the
 * per-instance progress into `aProgress` (or a supplied attribute) so a
 * shader can fade / scale 1M instances with zero CPU per-instance work.
 */
function createInstancedTimerFade(mesh, group, options) {
    options = options || {};
    const attr = options.attribute ||
        (mesh.geometry && mesh.geometry.attributes[options.attributeName || "aProgress"]) || null;
    const count = options.count !== undefined ? options.count : group.count;
    const useEased = options.useEased !== false;

    function upload() {
        if (attr) { writeProgressToAttribute(group, attr, count, useEased); }
        if (mesh.count !== undefined && options.setCount !== false) { mesh.count = count; }
    }

    return {
        group: group,
        attribute: attr,
        upload: upload,
        step(dtMs) { group.step(dtMs); upload(); return group.activeCount === 0; },
        async stepChunked(dtMs, chunkSize, yieldEvery) {
            await group.stepChunked(dtMs, chunkSize, yieldEvery);
            upload();
            return group.activeCount === 0;
        },
        get done() { return group.activeCount === 0; }
    };
}

// ============================================================================
// 9. WORKER POOL — resident-state multi-core timer stepping (Blob URL)
// ============================================================================
const _timerWorkerSource = "(" + function () {
    const resident = new Map();

    self.onmessage = function (e) {
        const d = e.data;
        if (d.op === "attach") {
            resident.set(d.groupId, {
                durations: d.durations,
                endDelays: d.endDelays,
                loopFlags: d.loopFlags,
                maxLoops: d.maxLoops,
                lut: d.lut
            });
            self.postMessage({ id: d.id, ok: true });
            return;
        }
        if (d.op === "detach") {
            resident.delete(d.groupId);
            self.postMessage({ id: d.id, ok: true });
            return;
        }

        const st = resident.get(d.groupId);
        const cur = d.currentTimes, act = d.actives, lc = d.loopCounts, pr = d.progress;
        const dur = st.durations, ed = st.endDelays, lf = st.loopFlags, ml = st.maxLoops, lut = st.lut;
        const n = d.n, dt = d.dt;
        const lutN = lut ? lut.length - 1 : 0;
        let completed = 0;

        for (let i = 0; i < n; i++) {
            if (!act[i]) { continue; }
            const t = cur[i] + dt;
            cur[i] = t;
            const total = dur[i] + ed[i];
            let p = total > 0 ? t / total : 1;
            if (p < 0) { p = 0; } else if (p > 1) { p = 1; }
            pr[i] = p;
            if (t >= total) {
                if (lf[i]) {
                    lc[i]++;
                    if (ml[i] > 0 && lc[i] >= ml[i]) { act[i] = 0; completed++; continue; }
                    cur[i] = 0;
                    pr[i] = 0;
                } else {
                    act[i] = 0;
                    completed++;
                }
            }
        }

        let eased = null;
        if (lut) {
            eased = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                const p = pr[i];
                if (p <= 0) { eased[i] = lut[0]; }
                else if (p >= 1) { eased[i] = lut[lutN]; }
                else { const x = p * lutN, k = x | 0; eased[i] = lut[k] + (lut[k + 1] - lut[k]) * (x - k); }
            }
        }

        const transfer = [cur.buffer, act.buffer, lc.buffer, pr.buffer];
        if (eased) { transfer.push(eased.buffer); }
        self.postMessage({
            id: d.id, currentTimes: cur, actives: act, loopCounts: lc,
            progress: pr, eased: eased, completed: completed
        }, transfer);
    };
}.toString() + ")();";

/**
 * Optional multi-core executor for TimerGroup. Immutable channels are
 * attached once and stay resident in the worker; only mutable channels are
 * transferred each step (zero copy). Groups with JS callbacks, or hosts
 * without Workers / Blob URLs, fall back to `group.stepChunked` so a call
 * never blocks the UI and never throws.
 */
class TimerWorkerPool {
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
            this._url = URL.createObjectURL(new Blob([_timerWorkerSource], { type: "text/javascript" }));
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

    /** Upload the immutable channels of a group once. */
    async attach(group) {
        if (this._disposed || this._workers.length === 0) { return false; }
        const id = this._nextId++;
        await this._post({
            id: this._nextId++, op: "attach", groupId: id,
            durations: group.durations.slice(),
            endDelays: group.endDelays.slice(),
            loopFlags: group.loopFlags.slice(),
            maxLoops: group.maxLoopsArr.slice(),
            lut: group._lut ? group._lut.slice() : null
        }, []);
        this._attached.set(group, id);
        return true;
    }

    /** Step a group off-thread; mutable channels are transferred, not copied. */
    async step(group, dtMs, chunkSize, yieldEvery) {
        if (this._disposed) { throw new Error("TimerWorkerPool disposed"); }
        const id = this._attached.get(group);
        const hasCallbacks = !!(group.onTick || group.onComplete || group.onLoop);
        if (this._workers.length === 0 || id === undefined || hasCallbacks) {
            return group.stepChunked(dtMs, chunkSize, yieldEvery);
        }
        const res = await this._post({
            id: this._nextId++, op: "step", groupId: id, n: group.count,
            dt: dtMs * group.getTimeScale(),
            currentTimes: group.currentTimes,
            actives: group.actives,
            loopCounts: group.loopCounts,
            progress: group.progress
        }, [
            group.currentTimes.buffer, group.actives.buffer,
            group.loopCounts.buffer, group.progress.buffer
        ]);

        group.currentTimes = res.currentTimes;
        group.actives = res.actives;
        group.loopCounts = res.loopCounts;
        group.progress = res.progress;
        if (res.eased && group.eased) { group.eased = res.eased; }
        group._activeCount -= res.completed;
        if (group._activeCount < 0) { group._activeCount = 0; }
        return group;
    }

    async detach(group) {
        const id = this._attached.get(group);
        if (id === undefined || this._workers.length === 0) { return false; }
        this._attached.delete(group);
        await this._post({ id: this._nextId++, op: "detach", groupId: id }, []);
        return true;
    }

    dispose() {
        this._disposed = true;
        for (let i = 0; i < this._workers.length; i++) { this._workers[i].terminate(); }
        this._workers.length = 0;
        this._idle.length = 0;
        for (const job of this._pending.values()) { job.reject(new Error("TimerWorkerPool disposed")); }
        this._pending.clear();
        for (let i = 0; i < this._queue.length; i++) { this._queue[i].reject(new Error("TimerWorkerPool disposed")); }
        this._queue.length = 0;
        if (this._url) { URL.revokeObjectURL(this._url); this._url = null; }
    }
}

function createTimerWorkerPool(size) { return new TimerWorkerPool(size); }

// ============================================================================
// 10. MATH NAMESPACE — the provided SOA stack stays the default maths
// ============================================================================
const math = {
    common: common,
    utils: utils,
    easings: easings,
    engine: engineModule,
    vec2: vec2, vec3: vec3, vec4: vec4,
    mat2: mat2, mat3: null, mat4: mat4,
    quat: quat, quat2: quat2,
    bitecs: null, simplex: null,
    timers: null
};

/** Optional modules load dynamically; a failure never breaks this module. */
const mathReady = Promise.allSettled([
    import("./006_mat3.js").then(function (m) { math.mat3 = m; }),
    import("./010_bitECS_core.js").then(function (m) { math.bitecs = m; }),
    import("./013_simplex.js").then(function (m) { math.simplex = m; })
]);

math.timers = {
    Timer: Timer,
    TimerGroup: TimerGroup,
    acquireTimer: acquireTimer,
    releaseTimer: releaseTimer,
    after: after,
    batchTick: batchTick
};

// ============================================================================
// 11. EXPORTS — every original export preserved + the 1M-scale parallel layer
// ============================================================================
export {
    // foundation
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC, MAX_SUB_STEP_MS,
    // original class + pool + helper
    Timer, acquireTimer, releaseTimer, after,
    // SOA group
    TimerGroup, createTimerGroup, createStaggeredTimerGroup,
    // scheduling
    createFixedStepScheduler,
    // orbital
    createOrbitalEpoch,
    // deterministic batch
    batchTick, batchTickChunked,
    // three.js r185 interop
    driveEngineWithThree, tickGroupFromThreeClock,
    writeProgressToAttribute, createInstancedTimerFade,
    // parallelism
    TimerWorkerPool, createTimerWorkerPool,
    // namespace
    math, mathReady
};

export default {
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC, MAX_SUB_STEP_MS,
    Timer, acquireTimer, releaseTimer, after,
    TimerGroup, createTimerGroup, createStaggeredTimerGroup,
    createFixedStepScheduler,
    createOrbitalEpoch,
    batchTick, batchTickChunked,
    driveEngineWithThree, tickGroupFromThreeClock,
    writeProgressToAttribute, createInstancedTimerFade,
    TimerWorkerPool, createTimerWorkerPool,
    math, mathReady
};

// Continue with next file: src/math/020_timeline.js (keyframe tracks + pooled
// timeline scheduler — 1M-instance staggered playback, bezier track solver,
// bitECS timeline system and three.js r185 AnimationClip bridging)?