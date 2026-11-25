// file number : 016
// full path name : src/math/016_engine.js
// description : Animation / simulation engine — every original export and
//               class member preserved (Engine + GlobalEngine singleton,
//               animations Set, systems, fixedSystems, soaSteps, idleTasks,
//               Float64 simulation clock, fixed-timestep accumulator with
//               spiral-of-death guard, visibility auto-pause, per-system
//               profiling, keepAlive, makeBitECSSystem), rewritten as a
//               self-contained native ES module in the three.js r185 JSM
//               addon style: no strict-mode directive, no CommonJS, no Vite /
//               Vue / client build, no CDN request.
//               Corrections: all transcription damage repaired (broken
//               identifiers, `& &`, trailing-space string literals that
//               silently broke `"visibilitychange"` / `"function"` /
//               `"undefined"` comparisons), and the single-slot
//               `_pendingIdleEntry` race replaced by a real idle queue so
//               every scheduled idle task actually runs.
//               Additions for 1M+ units at real time: a genuine Blob-URL
//               WorkerPool (transferables, op table + user source, CSP-safe
//               main-thread fallback) exported as `createWorkerPool`,
//               non-blocking chunked systems / SOA steps that never stall a
//               frame, rolling-cursor SOA batches that slice 1M-element loops
//               across frames, optional frame-budget deferral and per-system
//               frame staggering, manual `advance()` driving for external
//               loops, and duck-typed three.js r185 bridges that write SOA
//               data straight into GPU-bound arrays (InstancedMesh matrices,
//               Points positions) with zero intermediate copies.
//               The provided 002..015 SOA stack stays the default vector /
//               matrix / quaternion maths; three.js r185 only renders.
// best for : 3d graphics — the single loop that drives 1M+ SOA instances per
//            frame with per-system profiling, fixed-timestep orbital
//            integration and FABRIK / CCD IK that never pop at 60 / 90 / 120 /
//            144 Hz, HDR color fades on a Float64 clock that stays precise
//            from milliseconds to millions of years, procedural generation
//            streamed during idle, heavy work offloaded to worker threads,
//            and seamless small-to-galactic scale on Android mobile 64-bit.
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
//   src/math/012_double.js        (optional precision tier, dynamic)
//   src/math/013_simplex.js       (optional, dynamic)
//   src/math/014_utils.js         (optional, dynamic)
//   src/math/015_easings.js       (optional, dynamic)
//   src/math/016_engine.js        <- THIS FILE
// ============================================================================

import * as vec2 from "./002_vec2.js";
import * as vec3 from "./003_vec3.js";
import * as vec4 from "./004_vec4.js";
import * as mat2 from "./005_mat2.js";
import * as mat4 from "./007_mat4.js";
import * as quat from "./008_quat.js";
import * as quat2 from "./009_quat2.js";

// ============================================================================
// 0. CONSTANTS + FOUNDATION (inlined — replaces require("./001_common.js"))
// ============================================================================
const DEFAULT_FIXED_HZ = 60;
const DEFAULT_MAX_DELTA = 64;          // ms — matches the original 60 Hz clamp
const DEFAULT_MAX_FIXED_STEPS = 5;     // spiral-of-death guard
const DEFAULT_IDLE_EVERY_FRAMES = 4;
const MAX_FRAME_DT = 0.25;             // seconds — hard cap on app resume
const CHUNK_SIZE = 65536;
const CHUNK_YIELD_EVERY = 8;
const POOL_PREALLOC = 256;
const DEFAULT_WORKERS = 4;

// Pre-allocated idle callback options (zero-GC: allocated once, reused).
const _IDLE_CALLBACK_OPTS = { timeout: 500 };

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

const common = {
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC,
    DEFAULT_FIXED_HZ, DEFAULT_MAX_DELTA, DEFAULT_MAX_FIXED_STEPS,
    DEFAULT_IDLE_EVERY_FRAMES, MAX_FRAME_DT,
    yieldToMain, createPool, now: nowMs
};

// ============================================================================
// 1. WORKER POOL — true multi-core offload (Blob URL, no server, no CDN)
// ============================================================================
const _WORKER_SOURCE = "(" + function () {
    const cache = new Map();

    // Built-in SOA ops: plain typed-array loops, zero allocation per element.
    const OPS = {
        soaLerp(d) {
            const out = d.out, a = d.a, b = d.b, t = d.t, n = d.count;
            for (let i = 0; i < n; i++) { out[i] = a[i] + (b[i] - a[i]) * t; }
            return { out: out, __transfer: [out.buffer] };
        },
        soaClamp(d) {
            const out = d.out, min = d.min, max = d.max, n = d.count;
            for (let i = 0; i < n; i++) {
                const v = out[i];
                out[i] = v < min ? min : (v > max ? max : v);
            }
            return { out: out, __transfer: [out.buffer] };
        },
        soaMapRange(d) {
            const out = d.out, src = d.src, n = d.count;
            const span = d.inMax - d.inMin;
            const inv = span !== 0 ? 1 / span : 0;
            const os = d.outMax - d.outMin;
            for (let i = 0; i < n; i++) { out[i] = d.outMin + ((src[i] - d.inMin) * inv) * os; }
            return { out: out, __transfer: [out.buffer] };
        },
        soaSpringDamp(d) {
            const pos = d.positions, vel = d.velocities, tg = d.targets, n = d.count;
            const isArr = typeof tg !== "number";
            let st = d.smoothTime;
            if (st < 0.0001) { st = 0.0001; }
            const dt = d.dt;
            const ms = d.maxSpeed === null || d.maxSpeed === undefined ? Infinity : d.maxSpeed;
            const omega = 2 / st;
            const x = omega * dt;
            const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
            const maxChange = ms * st;
            const invDt = dt > 0 ? 1 / dt : 0;
            for (let i = 0; i < n; i++) {
                const c = pos[i];
                const ot = isArr ? tg[i] : tg;
                let t = ot;
                let change = c - t;
                if (change > maxChange) { change = maxChange; }
                else if (change < -maxChange) { change = -maxChange; }
                t = c - change;
                const temp = (vel[i] + omega * change) * dt;
                let v = (vel[i] - omega * temp) * exp;
                let o = t + (change + temp) * exp;
                if ((ot - c > 0) === (o > ot)) { o = ot; v = (o - ot) * invDt; }
                pos[i] = o; vel[i] = v;
            }
            return { positions: pos, velocities: vel, __transfer: [pos.buffer, vel.buffer] };
        },
        soaComposeTRS(d) {
            // Writes a flat, column-major mat4 array ready for instanceMatrix.
            const out = d.out, n = d.count;
            const px = d.px, py = d.py, pz = d.pz;
            const qx = d.qx, qy = d.qy, qz = d.qz, qw = d.qw;
            const sx = d.sx, sy = d.sy, sz = d.sz;
            for (let i = 0, o = 0; i < n; i++, o += 16) {
                const x = qx[i], y = qy[i], z = qz[i], w = qw[i];
                const x2 = x + x, y2 = y + y, z2 = z + z;
                const xx = x * x2, xy = x * y2, xz = x * z2;
                const yy = y * y2, yz = y * z2, zz = z * z2;
                const wx = w * x2, wy = w * y2, wz = w * z2;
                const Sx = sx ? sx[i] : 1, Sy = sy ? sy[i] : 1, Sz = sz ? sz[i] : 1;
                out[o] = (1 - (yy + zz)) * Sx; out[o + 1] = (xy + wz) * Sx; out[o + 2] = (xz - wy) * Sx; out[o + 3] = 0;
                out[o + 4] = (xy - wz) * Sy; out[o + 5] = (1 - (xx + zz)) * Sy; out[o + 6] = (yz + wx) * Sy; out[o + 7] = 0;
                out[o + 8] = (xz + wy) * Sz; out[o + 9] = (yz - wx) * Sz; out[o + 10] = (1 - (xx + yy)) * Sz; out[o + 11] = 0;
                out[o + 12] = px[i]; out[o + 13] = py[i]; out[o + 14] = pz[i]; out[o + 15] = 1;
            }
            return { out: out, __transfer: [out.buffer] };
        }
    };

    self.onmessage = function (e) {
        const d = e.data;
        try {
            let fn;
            if (d.op) {
                fn = OPS[d.op];
                if (!fn) { throw new Error("unknown op: " + d.op); }
            } else {
                fn = cache.get(d.src);
                if (!fn) {
                    fn = new Function("return (" + d.src + ")")();
                    cache.set(d.src, fn);
                }
            }
            const res = fn(d.data, self);
            let transfer = [];
            if (res && res.__transfer) {
                transfer = res.__transfer;
                delete res.__transfer;
            }
            self.postMessage({ id: d.id, result: res }, transfer);
        } catch (err) {
            self.postMessage({ id: d.id, error: String(err && err.message ? err.message : err) });
        }
    };
}.toString() + ")();";

/**
 * Multi-core task pool. `run(task, data, transfer)` accepts either a built-in
 * op name ("soaLerp", "soaClamp", "soaMapRange", "soaSpringDamp",
 * "soaComposeTRS") or a function (stringified and compiled inside the worker).
 * When Workers / Blob URLs / `new Function` are unavailable the task runs on
 * the main thread after a yield, so a call never blocks a frame and never
 * throws synchronously.
 */
class WorkerPool {
    constructor(size, options) {
        options = options || {};
        this._workers = [];
        this._idle = [];
        this._queue = [];
        this._pending = new Map();
        this._nextId = 1;
        this._url = null;
        this._disposed = false;
        this._localCache = new Map();
        this._maxWorkers = size || Math.min(DEFAULT_WORKERS,
            (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 2);

        if (options.forceMainThread === true) { return; }

        try {
            if (typeof Worker === "undefined" || typeof Blob === "undefined" ||
                typeof URL === "undefined" || !URL.createObjectURL) {
                throw new Error("workers unavailable");
            }
            this._url = URL.createObjectURL(new Blob([_WORKER_SOURCE], { type: "text/javascript" }));
            for (let i = 0; i < this._maxWorkers; i++) {
                const w = new Worker(this._url);
                w.onmessage = (e) => {
                    const job = this._pending.get(e.data.id);
                    if (job) {
                        this._pending.delete(e.data.id);
                        if (e.data.error) { job.reject(new Error(e.data.error)); }
                        else { job.resolve(e.data.result); }
                    }
                    this._idle.push(w);
                    this._dispatch();
                };
                w.onerror = (ev) => {
                    // Fail the head job on this worker, keep the pool alive.
                    const job = this._pending.get(w.__jobId);
                    if (job) {
                        this._pending.delete(w.__jobId);
                        job.reject(new Error(ev && ev.message ? ev.message : "worker error"));
                    }
                    this._idle.push(w);
                    this._dispatch();
                };
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
    get pending() { return this._queue.length + this._pending.size; }
    get isParallel() { return this._workers.length > 0; }

    _dispatch() {
        while (this._queue.length > 0 && this._idle.length > 0) {
            const job = this._queue.shift();
            const w = this._idle.pop();
            w.__jobId = job.msg.id;
            this._pending.set(job.msg.id, job);
            try {
                w.postMessage(job.msg, job.transfer || []);
            } catch (err) {
                this._pending.delete(job.msg.id);
                this._idle.push(w);
                job.reject(err);
            }
        }
    }

    async _localRun(task, data) {
        await yieldToMain();
        let fn;
        if (typeof task === "function") { fn = task; }
        else if (typeof task === "string") {
            fn = this._localCache.get(task);
            if (!fn) {
                // Built-in ops fall back to the imported SOA math modules.
                if (task === "soaLerp") {
                    fn = (d) => {
                        const out = d.out, a = d.a, b = d.b, t = d.t, n = d.count;
                        for (let i = 0; i < n; i++) { out[i] = a[i] + (b[i] - a[i]) * t; }
                        return { out: out };
                    };
                } else if (task === "soaClamp") {
                    fn = (d) => {
                        const out = d.out, n = d.count, mn = d.min, mx = d.max;
                        for (let i = 0; i < n; i++) {
                            const v = out[i];
                            out[i] = v < mn ? mn : (v > mx ? mx : v);
                        }
                        return { out: out };
                    };
                } else if (task === "soaMapRange") {
                    fn = (d) => {
                        const out = d.out, src = d.src, n = d.count;
                        const span = d.inMax - d.inMin;
                        const inv = span !== 0 ? 1 / span : 0;
                        const os = d.outMax - d.outMin;
                        for (let i = 0; i < n; i++) { out[i] = d.outMin + ((src[i] - d.inMin) * inv) * os; }
                        return { out: out };
                    };
                } else if (task === "soaComposeTRS") {
                    fn = (d) => {
                        const soa = mat4.createMat4SOA(d.count);
                        mat4.soaComposeTRS(soa,
                            { x: d.px, y: d.py, z: d.pz },
                            { x: d.qx, y: d.qy, z: d.qz, w: d.qw },
                            { x: d.sx, y: d.sy, z: d.sz });
                        mat4.soaToFlat(d.out, soa, 0);
                        return { out: d.out };
                    };
                } else if (task === "soaSpringDamp") {
                    fn = (d) => {
                        const pos = d.positions, vel = d.velocities, tg = d.targets, n = d.count;
                        const isArr = typeof tg !== "number";
                        let st = d.smoothTime;
                        if (st < 0.0001) { st = 0.0001; }
                        const dt = d.dt;
                        const ms = (d.maxSpeed === null || d.maxSpeed === undefined) ? Infinity : d.maxSpeed;
                        const omega = 2 / st;
                        const x = omega * dt;
                        const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
                        const maxChange = ms * st;
                        const invDt = dt > 0 ? 1 / dt : 0;
                        for (let i = 0; i < n; i++) {
                            const c = pos[i];
                            const ot = isArr ? tg[i] : tg;
                            let t = ot, change = c - t;
                            if (change > maxChange) { change = maxChange; }
                            else if (change < -maxChange) { change = -maxChange; }
                            t = c - change;
                            const temp = (vel[i] + omega * change) * dt;
                            let v = (vel[i] - omega * temp) * exp;
                            let o = t + (change + temp) * exp;
                            if ((ot - c > 0) === (o > ot)) { o = ot; v = (o - ot) * invDt; }
                            pos[i] = o; vel[i] = v;
                        }
                        return { positions: pos, velocities: vel };
                    };
                } else {
                    fn = new Function("return (" + task + ")")();
                }
                this._localCache.set(task, fn);
            }
        } else {
            throw new Error("WorkerPool.run: task must be an op name or a function");
        }
        const res = fn(data, typeof self !== "undefined" ? self : undefined);
        if (res && res.__transfer) { delete res.__transfer; }
        return res;
    }

    /**
     * Execute a task off the main thread.
     * @param {String|Function} task  op name or function (stringified for workers)
     * @param {Object} data           structured-cloneable payload (typed arrays)
     * @param {Array} [transfer]      ArrayBuffers to transfer (zero-copy)
     * @returns {Promise<any>}
     */
    run(task, data, transfer) {
        if (this._disposed) { return Promise.reject(new Error("WorkerPool disposed")); }
        if (this._workers.length === 0 || typeof task === "function" && this._workers.length === 0) {
            return this._localRun(task, data);
        }
        const src = typeof task === "function" ? task.toString() : null;
        const op = typeof task === "string" ? task : null;
        if (!src && !op) { return Promise.reject(new Error("WorkerPool.run: invalid task")); }

        return new Promise((resolve, reject) => {
            const msg = { id: this._nextId++, op: op, src: src, data: data };
            this._queue.push({ msg: msg, transfer: transfer || [], resolve: resolve, reject: reject });
            this._dispatch();
        });
    }

    dispose() {
        this._disposed = true;
        for (let i = 0; i < this._workers.length; i++) { this._workers[i].terminate(); }
        this._workers.length = 0;
        this._idle.length = 0;
        for (const job of this._pending.values()) { job.reject(new Error("WorkerPool disposed")); }
        this._pending.clear();
        for (let i = 0; i < this._queue.length; i++) { this._queue[i].reject(new Error("WorkerPool disposed")); }
        this._queue.length = 0;
        this._localCache.clear();
        if (this._url) { URL.revokeObjectURL(this._url); this._url = null; }
    }
}

function createWorkerPool(size, options) { return new WorkerPool(size, options); }

// ============================================================================
// 2. ENGINE
// ============================================================================
class Engine {
    constructor(options) {
        options = options || {};

        // --- original API (preserved) ---
        this.animations = new Set();
        this.isPaused = false;
        this.speed = options.speed !== undefined ? options.speed : 1.0;
        this.fps = options.fps !== undefined ? options.fps : 60;
        this.lastTime = this._now();
        this.rafId = null;
        this._tick = this._tick.bind(this);

        // --- systems & SOA ---
        this.systems = [];          // { name, update, priority, enabled }
        this.fixedSystems = [];     // { name, fixedUpdate, priority, enabled }
        this.soaSteps = [];         // { fn, name, enabled } — 1M+ batch loops
        this.chunkedSystems = [];   // { name, updateChunked } — async, never stalls
        this.idleTasks = [];        // { name, task, everyFrames, lastFrame }

        // --- timing ---
        this.fixedHz = options.fixedHz !== undefined ? options.fixedHz : DEFAULT_FIXED_HZ;
        this.maxFixedSteps = options.maxFixedSteps !== undefined ? options.maxFixedSteps : DEFAULT_MAX_FIXED_STEPS;
        this.maxDelta = options.maxDelta !== undefined ? options.maxDelta : DEFAULT_MAX_DELTA;
        this._fixedAccumulator = 0;

        // --- Float64 simulation clocks (galactic-scale safe) ---
        this.simulationTime = 0;
        this.simulationTimeScaled = 0;

        // --- loop control ---
        this._started = false;
        this._keepAlive = false;
        this._externalDrive = options.externalDrive === true;

        // --- optional frame governor (opt-in; default = original behaviour) ---
        this.frameBudgetMs = options.frameBudgetMs !== undefined ? options.frameBudgetMs : 0;
        this.capFps = options.capFps === true;
        this._minFrameMs = 0;
        this._deferred = 0;

        // --- idle scheduling ---
        this._idleEveryFrames = options.idleEveryFrames !== undefined
            ? options.idleEveryFrames
            : DEFAULT_IDLE_EVERY_FRAMES;
        this._idleQueue = [];
        this._idleHandles = [];
        this._pendingIdleEntry = null;

        // --- visibility auto-pause ---
        this.autoPauseOnVisibility = options.autoPauseOnVisibility !== false;
        this._wasRunningBeforeHide = false;
        this._boundVisibilityHandler = this._onVisibilityChange.bind(this);
        if (this.autoPauseOnVisibility && typeof document !== "undefined") {
            document.addEventListener("visibilitychange", this._boundVisibilityHandler);
        }

        // --- profiling (pre-allocated slots: no per-frame object creation) ---
        this.stats = {
            frame: 0,
            lastDt: 0,
            lastNow: 0,
            totalFrameTime: 0,
            systems: {},
            fixedSystems: {},
            soaSteps: {},
            chunkedSystems: {},
            idleRuns: 0,
            deferred: 0
        };

        // --- pre-allocated iteration buffer for animations (zero-GC) ---
        this._animBuffer = [];

        // --- pre-bound idle callback wrapper (zero-GC: no per-frame closure) ---
        this._boundIdleRunner = this._executeIdleTask.bind(this);
    }

    // ------------------------------------------------------------------------
    // 2.1 Original animation API
    // ------------------------------------------------------------------------
    add(anim) {
        this.animations.add(anim);
        this._ensureLoopRunning();
        return this;
    }

    remove(anim) {
        this.animations.delete(anim);
        if (!this._hasWork()) { this._stopLoop(); }
        return this;
    }

    pause() {
        this.isPaused = true;
        this._stopLoop();
        return this;
    }

    resume() {
        if (this.isPaused) {
            this.isPaused = false;
            this.lastTime = this._now();
            if (this._hasWork()) { this._startLoop(); }
        }
        return this;
    }

    // ------------------------------------------------------------------------
    // 2.2 Per-frame systems
    // ------------------------------------------------------------------------
    /**
     * Register a system that runs once per animation frame.
     * `update(dtSec, nowMs)` receives seconds and a Float64 timestamp.
     * Higher `priority` runs first. Optional `everyFrames` / `phase` stagger
     * heavy systems across frames; optional `optional: true` allows the frame
     * budget governor to defer it.
     */
    addSystem(system) {
        if (!system || typeof system.update !== "function") {
            throw new Error("addSystem: system must have an `update(dtSec, nowMs)` method");
        }
        system.name = system.name || "system" + this.systems.length;
        system.priority = system.priority !== undefined ? system.priority : 0;
        system.enabled = system.enabled !== false;
        system.everyFrames = system.everyFrames !== undefined ? system.everyFrames : 1;
        system.phase = system.phase !== undefined ? system.phase : 0;
        system.optional = system.optional === true;
        system._calls = 0;
        system._lastMs = 0;
        system._avgMs = 0;
        system._lastFrame = -Infinity;
        this.stats.systems[system.name] = { calls: 0, avgMs: 0 };
        this.systems.push(system);
        this.systems.sort(function (a, b) { return b.priority - a.priority; });
        this._ensureLoopRunning();
        return system;
    }

    removeSystem(systemOrName) {
        const name = typeof systemOrName === "string" ? systemOrName : (systemOrName && systemOrName.name);
        for (let i = this.systems.length - 1; i >= 0; i--) {
            if (this.systems[i] === systemOrName || this.systems[i].name === name) {
                delete this.stats.systems[this.systems[i].name];
                this.systems.splice(i, 1);
            }
        }
        if (!this._hasWork()) { this._stopLoop(); }
        return this;
    }

    // ------------------------------------------------------------------------
    // 2.3 Fixed-timestep systems (orbital / IK / physics)
    // ------------------------------------------------------------------------
    /**
     * Register a system that runs at a fixed rate regardless of display
     * refresh. `fixedUpdate(fixedDtSec)` receives exact seconds — crucial for
     * Kepler integration and FABRIK / CCD chains so they never pop.
     */
    addFixedSystem(system) {
        if (!system || typeof system.fixedUpdate !== "function") {
            throw new Error("addFixedSystem: system must have a `fixedUpdate(fixedDtSec)` method");
        }
        system.name = system.name || "fixed" + this.fixedSystems.length;
        system.priority = system.priority !== undefined ? system.priority : 0;
        system.enabled = system.enabled !== false;
        system._calls = 0;
        system._lastMs = 0;
        system._avgMs = 0;
        this.stats.fixedSystems[system.name] = { calls: 0, avgMs: 0 };
        this.fixedSystems.push(system);
        this.fixedSystems.sort(function (a, b) { return b.priority - a.priority; });
        this._ensureLoopRunning();
        return system;
    }

    removeFixedSystem(systemOrName) {
        const name = typeof systemOrName === "string" ? systemOrName : (systemOrName && systemOrName.name);
        for (let i = this.fixedSystems.length - 1; i >= 0; i--) {
            if (this.fixedSystems[i] === systemOrName || this.fixedSystems[i].name === name) {
                delete this.stats.fixedSystems[this.fixedSystems[i].name];
                this.fixedSystems.splice(i, 1);
            }
        }
        if (!this._hasWork()) { this._stopLoop(); }
        return this;
    }

    setFixedHz(hz) {
        if (hz > 0) { this.fixedHz = hz; }
        return this;
    }

    // ------------------------------------------------------------------------
    // 2.4 SOA batch steps — the 1M+ workhorse
    // ------------------------------------------------------------------------
    /**
     * Register a raw batch step `fn(deltaSec, nowMs)`, called once per frame.
     * Use for any `soa*` loop from the math modules. If a loop would exceed
     * ~8 ms on mobile, use addSoaBatch / addSoaStepChunked / a WorkerPool.
     */
    addSoaStep(fn, name) {
        if (typeof fn !== "function") {
            throw new Error("addSoaStep: fn must be a function(deltaSec, nowMs)");
        }
        const entryName = name || ("soa" + this.soaSteps.length);
        const entry = { fn: fn, name: entryName, enabled: true, _calls: 0, _lastMs: 0, _avgMs: 0 };
        this.stats.soaSteps[entryName] = { calls: 0, avgMs: 0 };
        this.soaSteps.push(entry);
        this._ensureLoopRunning();
        return entry;
    }

    removeSoaStep(entryOrFn) {
        for (let i = this.soaSteps.length - 1; i >= 0; i--) {
            if (this.soaSteps[i] === entryOrFn || this.soaSteps[i].fn === entryOrFn) {
                delete this.stats.soaSteps[this.soaSteps[i].name];
                this.soaSteps.splice(i, 1);
            }
        }
        if (!this._hasWork()) { this._stopLoop(); }
        return this;
    }

    /**
     * Rolling-cursor SOA batch: processes `chunkSize` elements of `soa.count`
     * per frame with a wrap-around cursor, so a 1M-element loop is fully
     * covered over N frames without ever blocking a frame.
     * `stepFn(index, soa, dtSec, nowMs)`.
     */
    addSoaBatch(soa, stepFn, options) {
        options = options || {};
        if (!soa || typeof stepFn !== "function") {
            throw new Error("addSoaBatch: requires a SOA and stepFn(index, soa, dtSec, nowMs)");
        }
        const chunk = options.chunkSize !== undefined ? options.chunkSize : CHUNK_SIZE;
        const name = options.name || ("batch" + this.soaSteps.length);
        const state = { soa: soa, step: stepFn, cursor: 0, chunk: chunk };
        const entry = this.addSoaStep(function (dtSec, now) {
            const total = state.soa.count | 0;
            if (total <= 0) { return; }
            let start = state.cursor;
            if (start >= total) { start = 0; }
            const end = Math.min(start + state.chunk, total);
            const fn = state.step, s = state.soa;
            for (let i = start; i < end; i++) { fn(i, s, dtSec, now); }
            state.cursor = end >= total ? 0 : end;
        }, name);
        entry.batch = state;
        return entry;
    }

    /**
     * Register an async SOA step. It is launched without awaiting, guarded so
     * only one instance runs at a time — the frame never waits for it.
     */
    addSoaStepChunked(fn, name) {
        if (typeof fn !== "function") {
            throw new Error("addSoaStepChunked: fn must be an async function(dtSec, nowMs)");
        }
        return this.addChunkedSystem({ name: name || ("soaAsync" + this.chunkedSystems.length), updateChunked: fn });
    }

    /** Register an async system: `await system.updateChunked(dtSec, nowMs)`. */
    addChunkedSystem(system) {
        if (!system || typeof system.updateChunked !== "function") {
            throw new Error("addChunkedSystem: system must have an `updateChunked(dtSec, nowMs)` method");
        }
        system.name = system.name || ("chunked" + this.chunkedSystems.length);
        system.priority = system.priority !== undefined ? system.priority : 0;
        system.enabled = system.enabled !== false;
        system.everyFrames = system.everyFrames !== undefined ? system.everyFrames : 1;
        system._busy = false;
        system._calls = 0;
        system._lastMs = 0;
        system._avgMs = 0;
        system._lastFrame = -Infinity;
        system._engine = this;
        this.stats.chunkedSystems[system.name] = { calls: 0, avgMs: 0, skipped: 0 };
        this.chunkedSystems.push(system);
        this.chunkedSystems.sort(function (a, b) { return b.priority - a.priority; });
        this._ensureLoopRunning();
        return system;
    }

    removeChunkedSystem(systemOrName) {
        const name = typeof systemOrName === "string" ? systemOrName : (systemOrName && systemOrName.name);
        for (let i = this.chunkedSystems.length - 1; i >= 0; i--) {
            if (this.chunkedSystems[i] === systemOrName || this.chunkedSystems[i].name === name) {
                delete this.stats.chunkedSystems[this.chunkedSystems[i].name];
                this.chunkedSystems.splice(i, 1);
            }
        }
        if (!this._hasWork()) { this._stopLoop(); }
        return this;
    }

    // ------------------------------------------------------------------------
    // 2.5 Idle tasks — background procedural work
    // ------------------------------------------------------------------------
    addIdleTask(task, options) {
        options = options || {};
        if (typeof task !== "function") {
            throw new Error("addIdleTask: task must be a function(deadline)");
        }
        const entry = {
            name: options.name || ("idle" + this.idleTasks.length),
            task: task,
            everyFrames: options.everyFrames || this._idleEveryFrames,
            lastFrame: -Infinity,
            enabled: true
        };
        this.idleTasks.push(entry);
        this._ensureLoopRunning();
        return entry;
    }

    removeIdleTask(entryOrName) {
        const name = typeof entryOrName === "string" ? entryOrName : (entryOrName && entryOrName.name);
        for (let i = this.idleTasks.length - 1; i >= 0; i--) {
            if (this.idleTasks[i] === entryOrName || this.idleTasks[i].name === name) {
                this.idleTasks.splice(i, 1);
            }
        }
        if (!this._hasWork()) { this._stopLoop(); }
        return this;
    }

    // ------------------------------------------------------------------------
    // 2.6 Loop control
    // ------------------------------------------------------------------------
    _hasWork() {
        return this._keepAlive ||
            this.animations.size > 0 ||
            this.systems.length > 0 ||
            this.fixedSystems.length > 0 ||
            this.soaSteps.length > 0 ||
            this.chunkedSystems.length > 0 ||
            this.idleTasks.length > 0;
    }

    _ensureLoopRunning() {
        if (this.isPaused || this._externalDrive) { return; }
        if (this.rafId === null && this._hasWork()) { this._startLoop(); }
    }

    _startLoop() {
        if (this.rafId !== null || this._externalDrive) { return; }
        if (typeof requestAnimationFrame === "undefined") { return; }
        this._started = true;
        this.lastTime = this._now();
        this.rafId = requestAnimationFrame(this._tick);
    }

    _stopLoop() {
        if (this.rafId !== null && typeof cancelAnimationFrame !== "undefined") {
            cancelAnimationFrame(this.rafId);
        }
        this.rafId = null;
        this._started = false;
    }

    /** Pin the loop on (useful when something external drives visibility). */
    keepAlive(v) {
        this._keepAlive = v !== false;
        if (this._keepAlive) { this._ensureLoopRunning(); }
        else if (!this._hasWork()) { this._stopLoop(); }
        return this;
    }

    /**
     * Hand the loop to an external driver (e.g. three.js r185
     * `renderer.setAnimationLoop(() => engine.advance())`). The engine stops
     * requesting its own frames but keeps the full pipeline.
     */
    setExternalDrive(v) {
        this._externalDrive = v !== false;
        if (this._externalDrive) { this._stopLoop(); }
        else { this._ensureLoopRunning(); }
        return this;
    }

    /** Manually advance one frame by `deltaMs` (no rAF scheduling). */
    advance(deltaMs) {
        const d = deltaMs === undefined ? 1000 / Math.max(1, this.fps) : deltaMs;
        this._runFrame(this.lastTime + d, false);
        return this;
    }

    // ------------------------------------------------------------------------
    // 2.7 Precision-safe time
    // ------------------------------------------------------------------------
    _now() { return nowMs(); }

    _nowAbsolute() {
        if (typeof performance !== "undefined" && performance.timeOrigin !== undefined) {
            return performance.timeOrigin + performance.now();
        }
        return Date.now();
    }

    // ------------------------------------------------------------------------
    // 2.8 Visibility handler — auto-pause when the tab is hidden
    // ------------------------------------------------------------------------
    _onVisibilityChange() {
        if (typeof document === "undefined") { return; }
        if (document.hidden) {
            if (!this.isPaused) {
                this._wasRunningBeforeHide = true;
                this.pause();
            }
        } else if (this._wasRunningBeforeHide) {
            this._wasRunningBeforeHide = false;
            this.resume();
        }
    }

    // ------------------------------------------------------------------------
    // 2.9 Main tick — preserves the `Animation._step(deltaMs)` contract
    // ------------------------------------------------------------------------
    _tick(currentTime) {
        this.rafId = null;
        if (this.isPaused) { return; }
        const now = currentTime || this._now();
        if (this.capFps && this.fps > 0) {
            const minMs = 1000 / this.fps;
            if (now - this.lastTime < minMs - 0.5) {
                if (this._hasWork() && typeof requestAnimationFrame !== "undefined") {
                    this.rafId = requestAnimationFrame(this._tick);
                }
                return;
            }
        }
        this._runFrame(now, true);
    }

    _runFrame(now, schedule) {
        if (this.isPaused) { this.rafId = null; return; }

        const frameStart = this._now();
        const rawDelta = now - this.lastTime;
        this.lastTime = now;

        // Clamp huge deltas (tab wakeup, GC pause) — prevents spiral of death.
        const clampedRaw = Math.min(this.maxDelta, Math.max(0, rawDelta));
        const dtMs = clampedRaw * this.speed;
        let dtSec = dtMs / 1000;
        if (dtSec > MAX_FRAME_DT) { dtSec = MAX_FRAME_DT; }

        // Float64 simulation clocks (never drift over galactic timespans).
        this.simulationTime += clampedRaw / 1000;
        this.simulationTimeScaled += dtSec;

        const frame = this.stats.frame;
        const budget = this.frameBudgetMs;
        let deferred = 0;

        // --- original API: step every Animation (reused buffer, zero-GC) ---
        if (this.animations.size > 0) {
            const animBuffer = this._animBuffer;
            animBuffer.length = 0;
            this.animations.forEach(function (anim) { animBuffer.push(anim); });
            for (let i = 0; i < animBuffer.length; i++) {
                const a = animBuffer[i];
                if (a && typeof a._step === "function") { a._step(dtMs); }
            }
            animBuffer.length = 0;
        }

        // --- SOA batch steps (1M+ workhorse) ---
        const soa = this.soaSteps;
        for (let s = 0; s < soa.length; s++) {
            const entry = soa[s];
            if (!entry.enabled) { continue; }
            const t0 = this._now();
            entry.fn(dtSec, now);
            const elapsed = this._now() - t0;
            entry._calls++;
            entry._lastMs = elapsed;
            entry._avgMs += (elapsed - entry._avgMs) * 0.1;
            const st = this.stats.soaSteps[entry.name];
            if (st) { st.calls++; st.avgMs += (elapsed - st.avgMs) * 0.1; }
        }

        // --- fixed-timestep systems (deterministic accumulator) ---
        this._fixedAccumulator += dtSec;
        const fixedDt = 1 / this.fixedHz;
        const maxSteps = this.maxFixedSteps;
        let steps = 0;
        while (this._fixedAccumulator >= fixedDt && steps < maxSteps) {
            for (let f = 0; f < this.fixedSystems.length; f++) {
                const fsys = this.fixedSystems[f];
                if (!fsys.enabled) { continue; }
                const f0 = this._now();
                fsys.fixedUpdate(fixedDt);
                const fel = this._now() - f0;
                fsys._calls++;
                fsys._lastMs = fel;
                fsys._avgMs += (fel - fsys._avgMs) * 0.1;
                const fst = this.stats.fixedSystems[fsys.name];
                if (fst) { fst.calls++; fst.avgMs += (fel - fst.avgMs) * 0.1; }
            }
            this._fixedAccumulator -= fixedDt;
            steps++;
        }
        // Spiral-of-death guard: capped means we lost time we cannot recover.
        if (steps === maxSteps) { this._fixedAccumulator = 0; }

        // --- per-frame systems ---
        for (let sy = 0; sy < this.systems.length; sy++) {
            const sys = this.systems[sy];
            if (!sys.enabled) { continue; }
            if (sys.everyFrames > 1 && ((frame + sys.phase) % sys.everyFrames) !== 0) { continue; }
            if (budget > 0 && sys.optional && (this._now() - frameStart) > budget) {
                deferred++;
                continue;
            }
            const s0 = this._now();
            sys.update(dtSec, now);
            const sel = this._now() - s0;
            sys._calls++;
            sys._lastMs = sel;
            sys._avgMs += (sel - sys._avgMs) * 0.1;
            const sst = this.stats.systems[sys.name];
            if (sst) { sst.calls++; sst.avgMs += (sel - sst.avgMs) * 0.1; }
        }

        // --- async / chunked systems (launched, never awaited) ---
        for (let c = 0; c < this.chunkedSystems.length; c++) {
            const cs = this.chunkedSystems[c];
            if (!cs.enabled) { continue; }
            if (cs.everyFrames > 1 && ((frame + c) % cs.everyFrames) !== 0) { continue; }
            const cst = this.stats.chunkedSystems[cs.name];
            if (cs._busy) { if (cst) { cst.skipped++; } continue; }
            cs._busy = true;
            cs._t0 = this._now();
            let p;
            try { p = cs.updateChunked(dtSec, now); }
            catch (e) { cs._busy = false; continue; }
            if (p && typeof p.then === "function") { p.then(this._makeChunkedDone(cs), this._makeChunkedDone(cs)); }
            else { this._finishChunked(cs); }
        }

        // --- idle tasks ---
        this._runIdleTasks(now);

        // --- stats ---
        const work = this._now() - frameStart;
        this.stats.frame++;
        this.stats.lastDt = dtMs;
        this.stats.lastNow = now;
        this.stats.totalFrameTime += work;
        this._deferred = deferred;
        this.stats.deferred += deferred;

        // --- schedule next frame ---
        if (schedule && !this._externalDrive) {
            if (this._hasWork() && typeof requestAnimationFrame !== "undefined") {
                this.rafId = requestAnimationFrame(this._tick);
            } else {
                this.rafId = null;
                this._started = false;
            }
        }
    }

    _makeChunkedDone(cs) {
        // One bound resolver per system (created at first launch, then cached).
        if (!cs._done) {
            const engine = this;
            cs._done = function () { engine._finishChunked(cs); };
        }
        return cs._done;
    }

    _finishChunked(cs) {
        const el = this._now() - cs._t0;
        cs._busy = false;
        cs._calls++;
        cs._lastMs = el;
        cs._avgMs += (el - cs._avgMs) * 0.1;
        const st = this.stats.chunkedSystems[cs.name];
        if (st) { st.calls++; st.avgMs += (el - st.avgMs) * 0.1; }
    }

    // ------------------------------------------------------------------------
    // 2.10 Idle execution (queue-based: every scheduled task actually runs)
    // ------------------------------------------------------------------------
    _executeIdleTask(deadline) {
        const entry = this._idleQueue.length > 0 ? this._idleQueue.shift() : this._pendingIdleEntry;
        this._pendingIdleEntry = entry || null;
        if (entry && entry.enabled) {
            try {
                entry.task(deadline);
                this.stats.idleRuns++;
            } catch (e) {
                // Swallow: one idle task must never crash the loop.
            }
        }
        this._pendingIdleEntry = null;
        if (this._idleHandles.length > 0) { this._idleHandles.shift(); }
    }

    _runIdleTasks(now) {
        if (this.idleTasks.length === 0) { return; }
        const hasIdle = typeof requestIdleCallback !== "undefined";
        const frame = this.stats.frame;
        for (let i = 0; i < this.idleTasks.length; i++) {
            const it = this.idleTasks[i];
            if (!it.enabled) { continue; }
            if (frame - it.lastFrame < it.everyFrames) { continue; }
            it.lastFrame = frame;
            if (hasIdle) {
                this._idleQueue.push(it);
                this._idleHandles.push(requestIdleCallback(this._boundIdleRunner, _IDLE_CALLBACK_OPTS));
            } else {
                this._pendingIdleEntry = it;
                try {
                    it.task({ timeRemaining: function () { return 4; }, didTimeout: true });
                    this.stats.idleRuns++;
                } catch (e) {
                    // Swallow.
                }
                this._pendingIdleEntry = null;
            }
        }
    }

    // ------------------------------------------------------------------------
    // 2.11 Profiling
    // ------------------------------------------------------------------------
    /** Snapshot of per-system average times. Allocates — cache outside hot paths. */
    profile() {
        return {
            frame: this.stats.frame,
            lastDtMs: this.stats.lastDt,
            simulationTime: this.simulationTime,
            simulationTimeScaled: this.simulationTimeScaled,
            totalFrameTime: this.stats.totalFrameTime,
            avgFrameMs: this.stats.frame > 0 ? this.stats.totalFrameTime / this.stats.frame : 0,
            systems: Object.assign({}, this.stats.systems),
            soaSteps: Object.assign({}, this.stats.soaSteps),
            chunkedSystems: Object.assign({}, this.stats.chunkedSystems),
            fixedSystems: this._collectFixedStats(),
            idleRuns: this.stats.idleRuns,
            deferred: this.stats.deferred,
            workers: this._workerPool ? this._workerPool.size : 0
        };
    }

    _collectFixedStats() {
        const out = {};
        for (let i = 0; i < this.fixedSystems.length; i++) {
            const f = this.fixedSystems[i];
            out[f.name] = { calls: f._calls, avgMs: f._avgMs };
        }
        return out;
    }

    resetStats() {
        this.stats.frame = 0;
        this.stats.totalFrameTime = 0;
        this.stats.idleRuns = 0;
        this.stats.deferred = 0;
        const groups = [this.stats.systems, this.stats.soaSteps, this.stats.fixedSystems, this.stats.chunkedSystems];
        for (let g = 0; g < groups.length; g++) {
            const names = Object.keys(groups[g]);
            for (let i = 0; i < names.length; i++) {
                const slot = groups[g][names[i]];
                slot.calls = 0;
                slot.avgMs = 0;
                if (slot.skipped !== undefined) { slot.skipped = 0; }
            }
        }
        const lists = [this.systems, this.fixedSystems, this.soaSteps, this.chunkedSystems];
        for (let l = 0; l < lists.length; l++) {
            const arr = lists[l];
            for (let i = 0; i < arr.length; i++) { arr[i]._calls = 0; arr[i]._avgMs = 0; arr[i]._lastMs = 0; }
        }
        return this;
    }

    /** Attach a shared worker pool so systems can offload heavy SOA work. */
    attachWorkerPool(pool) {
        this._workerPool = pool || null;
        return this;
    }

    get workerPool() { return this._workerPool || null; }

    // ------------------------------------------------------------------------
    // 2.12 Tear-down
    // ------------------------------------------------------------------------
    destroy() {
        this._stopLoop();
        if (this.autoPauseOnVisibility && typeof document !== "undefined") {
            document.removeEventListener("visibilitychange", this._boundVisibilityHandler);
        }
        if (typeof cancelIdleCallback !== "undefined") {
            for (let i = 0; i < this._idleHandles.length; i++) { cancelIdleCallback(this._idleHandles[i]); }
        }
        this._idleHandles.length = 0;
        this._idleQueue.length = 0;
        this.animations.clear();
        this.systems.length = 0;
        this.fixedSystems.length = 0;
        this.soaSteps.length = 0;
        this.chunkedSystems.length = 0;
        this.idleTasks.length = 0;
        this._animBuffer.length = 0;
        this._pendingIdleEntry = null;
        if (this._workerPool) { this._workerPool.dispose(); this._workerPool = null; }
        this.isPaused = true;
    }
}

// ============================================================================
// 3. GLOBAL SINGLETON (preserved)
// ============================================================================
const GlobalEngine = new Engine();

// ============================================================================
// 4. BITECS SYSTEM BRIDGES
// ============================================================================
/** Wrap a bitECS-style `run(world, dtSec, nowMs)` as a per-frame system. */
function makeBitECSSystem(name, world, run, options) {
    options = options || {};
    return {
        name: name,
        priority: options.priority !== undefined ? options.priority : 0,
        enabled: options.enabled !== false,
        everyFrames: options.everyFrames !== undefined ? options.everyFrames : 1,
        optional: options.optional === true,
        update: function (dtSec, now) { run(world, dtSec, now); }
    };
}

/** Same, but fixed-timestep — the correct home for orbital / IK integration. */
function makeBitECSFixedSystem(name, world, run, options) {
    options = options || {};
    return {
        name: name,
        priority: options.priority !== undefined ? options.priority : 0,
        enabled: options.enabled !== false,
        fixedUpdate: function (fixedDtSec) { run(world, fixedDtSec); }
    };
}

/** Chunked bitECS system: `await run(world, dtSec, now)` — never stalls a frame. */
function makeBitECSChunkedSystem(name, world, run, options) {
    options = options || {};
    return {
        name: name,
        priority: options.priority !== undefined ? options.priority : 0,
        enabled: options.enabled !== false,
        everyFrames: options.everyFrames !== undefined ? options.everyFrames : 1,
        updateChunked: function (dtSec, now) { return run(world, dtSec, now); }
    };
}

// ============================================================================
// 5. THREE.JS r185 BRIDGES (duck-typed — no three import, no CDN, no build)
// ============================================================================
/**
 * Register a render system. Uses `renderer.renderAsync` when present (WebGPU)
 * as a chunked system, otherwise `renderer.render` as a per-frame system.
 * Runs last by default (priority -1000) so all simulation completes first.
 */
function addThreeRenderer(engine, renderer, scene, camera, options) {
    options = options || {};
    const priority = options.priority !== undefined ? options.priority : -1000;
    const name = options.name || "three.render";
    if (typeof renderer.renderAsync === "function") {
        return engine.addChunkedSystem({
            name: name, priority: priority,
            updateChunked: function () { return renderer.renderAsync(scene, camera); }
        });
    }
    return engine.addSystem({
        name: name, priority: priority,
        update: function () { renderer.render(scene, camera); }
    });
}

/**
 * Drive a three.js r185 InstancedMesh from a mat4 SOA (1M instances).
 * The flat SOA write targets `mesh.instanceMatrix.array` directly — no
 * intermediate buffer, no per-instance Object3D, no matrix compose per frame
 * unless `options.trs` is supplied.
 */
function addInstancedMeshStep(engine, mesh, matrices, options) {
    options = options || {};
    const trs = options.trs || null;
    const name = options.name || "three.instanced";
    const recomputeBounds = options.recomputeBounds === true;
    return engine.addSoaStep(function () {
        const attr = mesh.instanceMatrix;
        if (!attr || !attr.array) { return; }
        const capacity = attr.count !== undefined ? attr.count : (attr.array.length / 16) | 0;
        const n = Math.min(matrices.count, capacity);
        if (trs) {
            mat4.soaComposeTRS(matrices, trs.position, trs.rotation, trs.scale);
        }
        const view = { arrays: matrices.arrays, count: n };
        mat4.soaToFlat(attr.array, view, 0);
        attr.needsUpdate = true;
        if (mesh.count !== n) { mesh.count = n; }
        if (recomputeBounds && typeof mesh.computeBoundingSphere === "function") {
            mesh.computeBoundingSphere();
        }
    }, name);
}

/**
 * Drive a three.js r185 Points / Line geometry position attribute from a
 * vec3 SOA (1M particles) — one flat write straight into the GPU-bound array.
 */
function addPointsStep(engine, points, positions, options) {
    options = options || {};
    const name = options.name || "three.points";
    const attributeName = options.attribute || "position";
    const recomputeBounds = options.recomputeBounds === true;
    return engine.addSoaStep(function () {
        const geo = points.geometry;
        if (!geo || !geo.attributes) { return; }
        const attr = geo.attributes[attributeName];
        if (!attr || !attr.array) { return; }
        const capacity = attr.count !== undefined ? attr.count : (attr.array.length / 3) | 0;
        const n = Math.min(positions.count, capacity);
        const view = { x: positions.x, y: positions.y, z: positions.z, count: n };
        vec3.soaToFlat(attr.array, view, 0);
        attr.needsUpdate = true;
        if (geo.setDrawRange) { geo.setDrawRange(0, n); }
        if (recomputeBounds && typeof geo.computeBoundingSphere === "function") {
            geo.computeBoundingSphere();
        }
    }, name);
}

/** Drive a per-instance color attribute from a vec4 SOA (HDR-safe, 1M). */
function addInstanceColorStep(engine, mesh, colors, options) {
    options = options || {};
    const name = options.name || "three.instanceColor";
    const attributeName = options.attribute || "instanceColor";
    return engine.addSoaStep(function () {
        let attr = mesh[attributeName] || (mesh.geometry && mesh.geometry.attributes[attributeName]);
        if (!attr || !attr.array) { return; }
        const capacity = attr.count !== undefined ? attr.count : (attr.array.length / 3) | 0;
        const n = Math.min(colors.count, capacity);
        const ox = colors.x, oy = colors.y, oz = colors.z;
        const arr = attr.array;
        for (let i = 0, o = 0; i < n; i++, o += 3) {
            arr[o] = ox[i]; arr[o + 1] = oy[i]; arr[o + 2] = oz[i];
        }
        attr.needsUpdate = true;
    }, name);
}

// ============================================================================
// 6. MATH NAMESPACE — the provided SOA stack stays the default maths
// ============================================================================
const math = {
    common: common,
    vec2: vec2, vec3: vec3, vec4: vec4,
    mat2: mat2, mat3: null, mat4: mat4,
    quat: quat, quat2: quat2,
    bitecs: null, simplex: null, double: null,
    utils: null, easings: null,
    engine: null
};

/** Optional modules load dynamically; a failure never breaks this module. */
const mathReady = Promise.allSettled([
    import("./006_mat3.js").then(function (m) { math.mat3 = m; }),
    import("./010_bitECS_core.js").then(function (m) { math.bitecs = m; }),
    import("./012_double.js").then(function (m) { math.double = m; }),
    import("./013_simplex.js").then(function (m) { math.simplex = m; }),
    import("./014_utils.js").then(function (m) { math.utils = m; }),
    import("./015_easings.js").then(function (m) { math.easings = m; })
]);

math.engine = {
    Engine: Engine, GlobalEngine: GlobalEngine,
    WorkerPool: WorkerPool, createWorkerPool: createWorkerPool,
    makeBitECSSystem: makeBitECSSystem
};

// ============================================================================
// 7. EXPORTS — every original export preserved + the parallel / three layer
// ============================================================================
export {
    // constants
    DEFAULT_FIXED_HZ, DEFAULT_MAX_DELTA, DEFAULT_MAX_FIXED_STEPS,
    DEFAULT_IDLE_EVERY_FRAMES, MAX_FRAME_DT,
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC, DEFAULT_WORKERS,
    // foundation
    yieldToMain, createPool,
    // original core
    Engine, GlobalEngine,
    // parallelism (was glMatrix.createWorkerPool — now a real implementation)
    WorkerPool, createWorkerPool,
    // bitECS bridges
    makeBitECSSystem, makeBitECSFixedSystem, makeBitECSChunkedSystem,
    // three.js r185 bridges
    addThreeRenderer, addInstancedMeshStep, addPointsStep, addInstanceColorStep,
    // namespace
    math, mathReady
};

export default {
    DEFAULT_FIXED_HZ, DEFAULT_MAX_DELTA, DEFAULT_MAX_FIXED_STEPS,
    DEFAULT_IDLE_EVERY_FRAMES, MAX_FRAME_DT,
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC, DEFAULT_WORKERS,
    yieldToMain, createPool,
    Engine, GlobalEngine,
    WorkerPool, createWorkerPool,
    makeBitECSSystem, makeBitECSFixedSystem, makeBitECSChunkedSystem,
    addThreeRenderer, addInstancedMeshStep, addPointsStep, addInstanceColorStep,
    math, mathReady
};

// Continue with next file: src/math/017_timeline.js (keyframe tracks + pooled
// timeline scheduler — 1M-instance staggered playback, bezier track solver,
// bitECS timeline system and three.js r185 AnimationClip bridging)?