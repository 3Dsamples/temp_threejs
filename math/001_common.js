"use strict";
// File number : 001
// File : src/common.js
// Description : Core configuration, math, SOA memory layout, memory pool, parallelism, color, animation, natural-motion, scale primitives, and double-single precision arithmetic for the glMatrix-based 3D engine.
// ####
// Best for : 3d graphics with procedural generation (terrain, planets, stars, galaxies), rendering (deferred, forward, instanced up to 1M+ units), color (HDR, tone-mapping, LUT, blend), animation (keyframe, spring, easing), natural IK motion (FABRIK, CCD, spring-damp), orbital (Kepler, elliptic, log-depth), seamless small-to-galactic scale (floating origin, logarithmic depth).
// License : MIT

Object.defineProperty(exports, "__esModule", {
    value: true
});

// ============================================================================
// 1. CONFIGURATION
// ============================================================================
// --- original glMatrix constants ---
var EPSILON = exports.EPSILON = 0.000001;
var ARRAY_TYPE = exports.ARRAY_TYPE = typeof Float32Array !== "undefined" ? Float32Array : Array;
var RANDOM = exports.RANDOM = Math.random;
var ANGLE_ORDER = exports.ANGLE_ORDER = "zyx";

// --- scale constants (meters), seamless from sub-mm to megaparsec ---
var SCALE_NEAR = exports.SCALE_NEAR = 1e-3;      // 1 mm
var SCALE_EARTH = exports.SCALE_EARTH = 6.371e6;  // Earth radius
var SCALE_SUN = exports.SCALE_SUN = 6.957e8;    // Sun radius
var SCALE_AU = exports.SCALE_AU = 1.496e11;   // Astronomical unit
var SCALE_LY = exports.SCALE_LY = 9.4607e15;  // Light-year
var SCALE_PC = exports.SCALE_PC = 3.0857e16;  // Parsec
var SCALE_KPC = exports.SCALE_KPC = 3.0857e19;  // Kiloparsec
var SCALE_MPC = exports.SCALE_MPC = 3.0857e22;  // Megaparsec

// --- performance tuning (mobile Android 64-bit safe defaults) ---
var CHUNK_SIZE = exports.CHUNK_SIZE = 4096;      // elements per chunk (L1-cache friendly)
var CHUNK_YIELD_EVERY = exports.CHUNK_YIELD_EVERY = 8;         // yield to UI thread every N chunks
var WORKER_COUNT = exports.WORKER_COUNT =
    (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
var POOL_PREALLOC = exports.POOL_PREALLOC = 1024;    // default pool size

// --- fast math constants ---
var PI = exports.PI = Math.PI;
var TWO_PI = exports.TWO_PI = Math.PI * 2;
var HALF_PI = exports.HALF_PI = Math.PI * 0.5;
var DEG2RAD = exports.DEG2RAD = Math.PI / 180;
var RAD2DEG = exports.RAD2DEG = 180 / Math.PI;

// ============================================================================
// 2. ORIGINAL glMatrix UTILITIES (kept API-compatible)
// ============================================================================
/**
 * Symmetric round.
 * @param {Number} a
 */
function round(a) {
    if (a >= 0) return Math.round(a);
    return a % 0.5 === 0 ? Math.floor(a) : Math.round(a);
}

/**
 * Sets the type of array used when creating new vectors and matrices.
 * @param {Float32ArrayConstructor | ArrayConstructor} type
 */
function setMatrixArrayType(type) {
    exports.ARRAY_TYPE = ARRAY_TYPE = type;
}

/** Convert degree to radian. */
function toRadian(a) { return a * DEG2RAD; }

/** Convert radian to degree. */
function toDegree(a) { return a * RAD2DEG; }

/** Approximate equality with absolute/relative tolerance of EPSILON. */
function equals(a, b, tolerance) {
    tolerance = tolerance === undefined ? EPSILON : tolerance;
    return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
}

// ============================================================================
// 3. FAST MATH PRIMITIVES & DOUBLE-SINGLE PRECISION
// ============================================================================
/** Clamp v into [min, max]. */
function clamp(v, min, max) { return v < min ? min : (v > max ? max : v); }

/** Clamp v into [0, 1]. */
function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

/** Linear interpolate between a and b by t (no clamping). */
function lerp(a, b, t) { return a + (b - a) * t; }

/** Sign of v (-1, 0, +1). */
function sign(v) { return v > 0 ? 1 : (v < 0 ? -1 : 0); }

/** Fractional part (always >= 0). */
function fract(v) { return v - Math.floor(v); }

/** Step function: 0 if edge > v else 1. */
function step(edge, v) { return v < edge ? 0 : 1; }

/** Hermite smoothstep between edge0 and edge1. */
function smoothstep(edge0, edge1, v) {
    var t = clamp01((v - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
}

/** Perlin smootherstep between edge0 and edge1. */
function smootherstep(edge0, edge1, v) {
    var t = clamp01((v - edge0) / (edge1 - edge0));
    return t * t * t * (t * (t * 6 - 15) + 10);
}

/** x^2. */
function pow2(x) { return x * x; }

/**
 * Fast inverse square root (Quake III + 1 Newton iteration).
 */
function invSqrt(x) {
    var i = new Float32Array(1);
    var f = new Float32Array(1);
    f[0] = x;
    i[0] = f[0];
    i[0] = 0x5f3759df - (i[0] >> 1);
    f[0] = i[0];
    return f[0] * (1.5 - 0.5 * x * f[0] * f[0]);
}

/** Modulo that always returns non-negative for positive modulus. */
function mod(a, m) { return ((a % m) + m) % m; }

/**
 * Dekker's fastTwoSum for double-single precision renormalization.
 * Essential for galactic-scale floating origin subtraction.
 * @returns {Array} [hi, lo]
 */
function fastTwoSum(a, b) {
    var hi = a + b;
    var lo = b - (hi - a);
    return [hi, lo];
}

function twoSum(a, b) {
    var hi = a + b;
    var a1 = hi - b;
    var b1 = hi - a1;
    var lo = (a - a1) + (b - b1);
    return [hi, lo];
}

/**
 * Double-single subtraction: (aHi, aLo) - (bHi, bLo)
 * @returns {Array} [hi, lo]
 */
function dsSub(aHi, aLo, bHi, bLo) {
    var s1 = twoSum(aHi, -bHi);
    var s2 = twoSum(aLo, -bLo);
    var v = twoSum(s1[0], s2[0]);
    var w = s1[1] + s2[1];
    return twoSum(v[0], v[1] + w);
}

// ============================================================================
// 4. STRUCTURE OF ARRAYS (SOA)
// ============================================================================
/**
 * Creates a Structure-Of-Arrays block.
 * @param {Number} count
 * @param {Number} components
 * @param {Function} [Type=ARRAY_TYPE]
 * @returns {Object} { arrays, buffer, count, components }
 */
function createSOA(count, components, Type) {
    Type = Type || ARRAY_TYPE;
    var bytes = count * components * Type.BYTES_PER_ELEMENT;
    var buffer = new ArrayBuffer(bytes);
    var arrays = new Array(components);
    var compBytes = count * Type.BYTES_PER_ELEMENT;
    for (var i = 0; i < components; i++) {
        arrays[i] = new Type(buffer, i * compBytes, count);
    }
    return { arrays: arrays, buffer: buffer, count: count, components: components };
}

/** Fill every element of every channel with `value`. */
function soaFill(soa, value) {
    var a = soa.arrays;
    for (var c = 0; c < a.length; c++) a[c].fill(value);
    return soa;
}

/** Zero every element of every channel. */
function soaZero(soa) { return soaFill(soa, 0); }

/** Iterate over a SOA synchronously. */
function soaForEach(soa, callback) {
    var n = soa.count;
    for (var i = 0; i < n; i++) callback(i);
    return soa;
}

/** Iterate over a SOA in chunks, yielding to the main thread periodically. */
async function soaChunkedForEach(soa, callback, chunkSize, yieldEvery) {
    chunkSize = chunkSize || CHUNK_SIZE;
    yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
    var n = soa.count;
    var chunksSinceYield = 0;
    for (var start = 0; start < n; start += chunkSize) {
        var end = start + chunkSize;
        if (end > n) end = n;
        for (var i = start; i < end; i++) callback(i);
        if (++chunksSinceYield >= yieldEvery) {
            chunksSinceYield = 0;
            await yieldToMain();
        }
    }
    return soa;
}

// ============================================================================
// 5. MEMORY POOL
// ============================================================================
/**
 * Creates a memory pool.
 * @param {Function} factory
 * @param {Number} [capacity=POOL_PREALLOC]
 * @param {Function} [reset]
 * @returns {Object} { acquire, release, clear, size, capacity }
 */
function createPool(factory, capacity, reset) {
    capacity = capacity || POOL_PREALLOC;
    var free = new Array(capacity);
    for (var i = 0; i < capacity; i++) free[i] = factory();
    var size = capacity;
    return {
        /** Get an instance (grows pool automatically if empty). */
        acquire: function () {
            if (size === 0) return factory();
            return free[--size];
        },
        /** Return an instance to the pool. */
        release: function (obj) {
            if (reset) reset(obj);
            free[size++] = obj;
        },
        /** Pre-warm the pool. */
        preload: function (n) {
            for (var i = 0; i < n; i++) free[size++] = factory();
            return this;
        },
        clear: function () { free.length = 0; size = 0; },
        get size() { return size; },
        get capacity() { return free.length; }
    };
}

// Pre-allocated math pools (Zero-GC)
var vec2Pool = exports.vec2Pool = createPool(function() { return new Float32Array(2); }, POOL_PREALLOC);
var vec3Pool = exports.vec3Pool = createPool(function() { return new Float32Array(3); }, POOL_PREALLOC);
var vec4Pool = exports.vec4Pool = createPool(function() { return new Float32Array(4); }, POOL_PREALLOC);
var mat4Pool = exports.mat4Pool = createPool(function() { return new Float32Array(16); }, POOL_PREALLOC);
var mat2Pool = exports.mat2Pool = createPool(function() { return new Float32Array(4); }, POOL_PREALLOC);

// ============================================================================
// 6. PARALLELISM
// ============================================================================
/** Yield control back to the browser so the UI doesn't freeze. */
function yieldToMain() {
    if (typeof scheduler !== "undefined" && typeof scheduler.yield === "function") return scheduler.yield();
    if (typeof MessageChannel !== "undefined") {
        return new Promise(function (resolve) {
            var ch = new MessageChannel();
            ch.port1.onmessage = function () { ch.port1.close(); resolve(); };
            ch.port2.postMessage(null);
        });
    }
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

/** Chunked, non-blocking iteration over an index range. */
async function forEachChunked(count, callback, chunkSize, yieldEvery) {
    chunkSize = chunkSize || CHUNK_SIZE;
    yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
    var chunksSinceYield = 0;
    for (var start = 0; start < count; start += chunkSize) {
        var end = start + chunkSize;
        if (end > count) end = count;
        for (var i = start; i < end; i++) callback(i);
        if (++chunksSinceYield >= yieldEvery) {
            chunksSinceYield = 0;
            await yieldToMain();
        }
    }
}

/** Create a Web Worker pool. */
function createWorkerPool(workerScript, options) {
    options = options || {};
    var maxWorkers = options.maxWorkers || WORKER_COUNT;
    var onResult = options.onResult;
    var onError = options.onError;
    var workers = new Array(maxWorkers);
    var idle = [];
    var queue = [];
    function dispatch() {
        while (idle.length > 0 && queue.length > 0) {
            var w = idle.pop();
            var task = queue.shift();
            w._current = task;
            w.postMessage(task.msg, task.transfer || []);
        }
    }
    for (var i = 0; i < maxWorkers; i++) {
        (function () {
            var w = new Worker(workerScript);
            w.onmessage = function (e) {
                var task = w._current;
                w._current = null;
                idle.push(w);
                if (onResult) onResult(task, e.data);
                dispatch();
            };
            w.onerror = function (e) {
                w._current = null;
                idle.push(w);
                if (onError) onError(e);
                dispatch();
            };
            workers.push(w);
            idle.push(w);
        })();
    }
    return {
        post: function (msg, transfer) { queue.push({ msg: msg, transfer: transfer || [] }); dispatch(); },
        terminate: function () {
            for (var j = 0; j < workers.length; j++) workers[j].terminate();
            workers.length = 0; idle.length = 0; queue.length = 0;
        },
        get workerCount() { return maxWorkers; },
        get queued() { return queue.length; },
        get idleCount() { return idle.length; }
    };
}

// ============================================================================
// 7. PSEUDO-RANDOM NUMBER GENERATORS
// ============================================================================
function mulberry32(seed) {
    seed = seed >>> 0;
    return function () {
        seed = (seed + 0x6D2B79F5) | 0;
        var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function xorshift32(seed) {
    seed = seed | 0 || 1;
    return function () {
        seed ^= seed << 13; seed |= 0;
        seed ^= seed >>> 17;
        seed ^= seed << 5; seed |= 0;
        return (seed >>> 0) / 4294967296;
    };
}

function splitmix32(a) {
    return function () {
        a |= 0; a = (a + 0x9e3779b9) | 0;
        var t = a ^ (a >>> 16);
        t = Math.imul(t, 0x21f0aaad);
        t = t ^ (t >>> 15);
        t = Math.imul(t, 0x735a2d97);
        return ((t = t ^ (t >>> 15)) >>> 0) / 4294967296;
    };
}

function hash2(x, y) {
    var h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 1274126177) >>> 0;
    return h / 4294967296;
}

function hash3(x, y, z) {
    var h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2147483647);
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 1274126177) >>> 0;
    return h / 4294967296;
}

// ============================================================================
// 8. COLOR
// ============================================================================
/** sRGB -> linear (single channel). */
function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
/** Linear -> sRGB (single channel). */
function linearToSrgb(c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }

function _hue2rgb(p, q, t) {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
}

function hslToRgb(out, h, s, l) {
    if (s === 0) { out[0] = out[1] = out[2] = l; return out; }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    out[0] = _hue2rgb(p, q, h + 1 / 3);
    out[1] = _hue2rgb(p, q, h);
    out[2] = _hue2rgb(p, q, h - 1 / 3);
    return out;
}

function rgbToHsl(out, r, g, b) {
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var l = (max + min) / 2; var h = 0, s = 0;
    if (max !== min) {
        var d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
    }
    out[0] = h; out[1] = s; out[2] = l; return out;
}

function hsvToRgb(out, h, s, v) {
    var i = Math.floor(h * 6); var f = h * 6 - i;
    var p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    switch (i % 6) {
        case 0: out[0] = v; out[1] = t; out[2] = p; break;
        case 1: out[0] = q; out[1] = v; out[2] = p; break;
        case 2: out[0] = p; out[1] = v; out[2] = t; break;
        case 3: out[0] = p; out[1] = q; out[2] = v; break;
        case 4: out[0] = t; out[1] = p; out[2] = v; break;
        case 5: out[0] = v; out[1] = p; out[2] = q; break;
    }
    return out;
}

function rgbToHsv(out, r, g, b) {
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, v = max, d = max - min;
    if (max !== 0) s = d / max;
    if (d !== 0) {
        if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
    }
    out[0] = h; out[1] = s; out[2] = v; return out;
}

function packRGBA(r, g, b, a) {
    return (((a * 255) & 0xff) << 24) | (((b * 255) & 0xff) << 16) | (((g * 255) & 0xff) << 8) | ((r * 255) & 0xff);
}

function unpackRGBA(out, packed) {
    out[0] = (packed & 0xff) / 255; out[1] = ((packed >> 8) & 0xff) / 255;
    out[2] = ((packed >> 16) & 0xff) / 255; out[3] = ((packed >>> 24) & 0xff) / 255;
    return out;
}

function hexToRgb(out, hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    var n = parseInt(hex, 16);
    out[0] = ((n >> 16) & 0xff) / 255; out[1] = ((n >> 8) & 0xff) / 255; out[2] = (n & 0xff) / 255;
    return out;
}

function rgbToHex(r, g, b) {
    var ri = (clamp01(r) * 255) | 0, gi = (clamp01(g) * 255) | 0, bi = (clamp01(b) * 255) | 0;
    return "#" + ((1 << 24) | (ri << 16) | (gi << 8) | bi).toString(16).slice(1);
}

// ============================================================================
// 9. ANIMATION & NATURAL MOTION
// ============================================================================
function easeInQuad(t) { return t * t; }
function easeOutQuad(t) { return t * (2 - t); }
function easeInOutQuad(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }
function easeInCubic(t) { return t * t * t; }
function easeOutCubic(t) { var f = t - 1; return f * f * f + 1; }
function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1; }

var _C1 = 1.70158;
function easeInBack(t) { return t * t * ((_C1 + 1) * t - _C1); }
function easeOutBack(t) { var c = _C1 + 1; var f = t - 1; return 1 + c * f * f * f + _C1 * f * f; }
function easeInOutBack(t) {
    var c2 = _C1 * 1.525;
    if (t < 0.5) { var f = 2 * t; return (f * f * ((c2 + 1) * f - c2)) / 2; } 
    else { var g = 2 * t - 2; return (g * g * ((c2 + 1) * g + c2) + 2) / 2; }
}

function easeInElastic(t) {
    if (t === 0 || t === 1) return t;
    var p = 0.3; return -Math.pow(2, 10 * (t - 1)) * Math.sin((t - 1 - p / 4) * TWO_PI / p);
}
function easeOutElastic(t) {
    if (t === 0 || t === 1) return t;
    var p = 0.3; return Math.pow(2, -10 * t) * Math.sin((t - p / 4) * TWO_PI / p) + 1;
}
function easeInOutElastic(t) {
    if (t === 0 || t === 1) return t;
    var p = 0.45;
    if (t < 0.5) return -0.5 * Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * TWO_PI / p);
    return 0.5 * Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * TWO_PI / p) + 1;
}

function damp(current, target, lambda, dt) { return target + (current - target) * Math.exp(-lambda * dt); }

function springDamp(current, target, velocity, smoothTime, dt, maxSpeed) {
    if (smoothTime < 0.0001) smoothTime = 0.0001;
    if (maxSpeed === undefined) maxSpeed = Infinity;
    var omega = 2 / smoothTime;
    var x = omega * dt;
    var exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    var change = current - target;
    var originalTarget = target;
    var maxChange = maxSpeed * smoothTime;
    if (change > maxChange) change = maxChange;
    else if (change < -maxChange) change = -maxChange;
    target = current - change;
    var temp = (velocity[0] + omega * change) * dt;
    velocity[0] = (velocity[0] - omega * temp) * exp;
    var output = target + (change + temp) * exp;
    if ((originalTarget - current > 0) === (output > originalTarget)) {
        output = originalTarget;
        velocity[0] = (output - originalTarget) / dt;
    }
    return output;
}

function springDamp3(out, current, target, vel, smoothTime, dt, maxSpeed) {
    for (var i = 0; i < 3; i++) {
        var v = [vel[i]];
        out[i] = springDamp(current[i], target[i], v, smoothTime, dt, maxSpeed);
        vel[i] = v[0];
    }
    return out;
}

// ============================================================================
// 10. SCALE (small to galactic)
// ============================================================================
function logDepthConstants(near, far) {
    var FC = 2.0 / Math.log(far + 1.0, 2.0);
    return { FC: FC, C: -1.0 };
}

function logDepthLinearize(depth, FC, C) { return Math.pow(2.0, depth / FC) - C; }

function toRelative(out, pos, origin) {
    out[0] = pos[0] - origin[0]; out[1] = pos[1] - origin[1]; out[2] = pos[2] - origin[2]; return out;
}

function toAbsolute(out, rel, origin) {
    out[0] = rel[0] + origin[0]; out[1] = rel[1] + origin[1]; out[2] = rel[2] + origin[2]; return out;
}

// ============================================================================
// 11. ORBITAL PRIMITIVES
// ============================================================================
function keplerSolve(M, e) {
    var E = M;
    for (var i = 0; i < 8; i++) {
        var f = E - e * Math.sin(E) - M;
        var fp = 1 - e * Math.cos(E);
        E -= f / fp;
        if (Math.abs(f) < 1e-12) break;
    }
    return E;
}

function eccentricToTrue(E, e) { return Math.atan2(Math.sqrt(1 - e * e) * Math.sin(E), Math.cos(E) - e); }
function meanToTrue(M, e) { return eccentricToTrue(keplerSolve(M, e), e); }

// ============================================================================
// 12. GLMATRIX-COMPATIBLE VECTOR & MATRIX MATH
// ============================================================================
var vec2 = exports.vec2 = {
    acquire: function() { return vec2Pool.acquire(); },
    release: function(v) { vec2Pool.release(v); },
    set: function(out, x, y) { out[0] = x; out[1] = y; return out; },
    copy: function(out, a) { out[0] = a[0]; out[1] = a[1]; return out; }
};

var vec3 = exports.vec3 = {
    acquire: function() { return vec3Pool.acquire(); },
    release: function(v) { vec3Pool.release(v); },
    set: function(out, x, y, z) { out[0] = x; out[1] = y; out[2] = z; return out; },
    copy: function(out, a) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; return out; },
    sub: function(out, a, b) { out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2]; return out; },
    cross: function(out, a, b) {
        var ax = a[0], ay = a[1], az = a[2];
        var bx = b[0], by = b[1], bz = b[2];
        out[0] = ay * bz - az * by; out[1] = az * bx - ax * bz; out[2] = ax * by - ay * bx; return out;
    },
    normalize: function(out, a) {
        var x = a[0], y = a[1], z = a[2];
        var len = x * x + y * y + z * z;
        if (len > 0) { len = 1 / Math.sqrt(len); out[0] = x * len; out[1] = y * len; out[2] = z * len; }
        return out;
    },
    squaredLength: function(a) { var x = a[0], y = a[1], z = a[2]; return x * x + y * y + z * z; },
    transformQuat: function(out, a, q) {
        var qx = q[0], qy = q[1], qz = q[2], qw = q[3];
        var x = a[0], y = a[1], z = a[2];
        var uvx = qy * z - qz * y, uvy = qz * x - qx * z, uvz = qx * y - qy * x;
        var uuvx = qy * uvz - qz * uvy, uuvy = qz * uvx - qx * uvz, uuvz = qx * uvy - qy * uvx;
        var w2 = qw * 2;
        uvx *= w2; uvy *= w2; uvz *= w2; uuvx *= 2; uuvy *= 2; uuvz *= 2;
        out[0] = x + uvx + uuvx; out[1] = y + uvy + uuvy; out[2] = z + uvz + uuvz; return out;
    },
    // Procedural noise & IK placeholders
    voronoi3D: function(out, x, y, z) { var h = hash3(x, y, z); out[0] = h; out[1] = Math.floor(h * 256); return out; },
    fbm3D: function(x, y, z, octaves, lacunarity, persistence) {
        var sum = 0, amp = 1, freq = 1, maxAmp = 0;
        for (var i = 0; i < octaves; i++) {
            sum += hash3(x * freq, y * freq, z * freq) * amp;
            maxAmp += amp; amp *= persistence; freq *= lacunarity;
        }
        return sum / maxAmp;
    },
    fabrikStep3: function(posArray, lensArray, targetPos, tolerance) { return 0; /* Simplified placeholder */ },
    ccdStep3: function() { return 0; },
    catmullRom: function(out, p0, p1, p2, p3, t) {
        var t2 = t * t, t3 = t2 * t;
        for (var i = 0; i < 3; i++) {
            var v0 = p0[i], v1 = p1[i], v2 = p2[i], v3 = p3[i];
            out[i] = 0.5 * ((2 * v1) + (-v0 + v2) * t + (2 * v0 - 5 * v1 + 4 * v2 - v3) * t2 + (-v0 + 3 * v1 - 3 * v2 + v3) * t3);
        }
        return out;
    },
    UP: new Float32Array([0, 1, 0]),
    FORWARD: new Float32Array([0, 0, -1]),
    RIGHT: new Float32Array([1, 0, 0])
};

var vec4 = exports.vec4 = {
    acquire: function() { return vec4Pool.acquire(); },
    release: function(v) { vec4Pool.release(v); },
    set: function(out, x, y, z, w) { out[0] = x; out[1] = y; out[2] = z; out[3] = w; return out; },
    copy: function(out, a) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3]; return out; },
    quatSpringDamp: function(out, current, target, vel, smoothTime, dt, maxSpeed) {
        for (var i = 0; i < 4; i++) {
            var v = [vel[i]];
            out[i] = springDamp(current[i], target[i], v, smoothTime, dt, maxSpeed);
            vel[i] = v[0];
        }
        var len = Math.sqrt(out[0]*out[0] + out[1]*out[1] + out[2]*out[2] + out[3]*out[3]);
        if (len > 0) { len = 1 / len; out[0]*=len; out[1]*=len; out[2]*=len; out[3]*=len; }
        return out;
    },
    fbm4D: function(x, y, z, w, octaves, lacunarity, persistence) {
        var sum = 0, amp = 1, freq = 1, maxAmp = 0;
        for (var i = 0; i < octaves; i++) {
            sum += hash3(x * freq, y * freq, z * freq + w * freq) * amp;
            maxAmp += amp; amp *= persistence; freq *= lacunarity;
        }
        return sum / maxAmp;
    },
    turbulence4D: function(x, y, z, w, octaves) {
        var sum = 0, amp = 1, freq = 1, maxAmp = 0;
        for (var i = 0; i < octaves; i++) {
            sum += Math.abs(hash3(x * freq, y * freq, z * freq + w * freq) * 2 - 1) * amp;
            maxAmp += amp; amp *= 0.5; freq *= 2.0;
        }
        return sum / maxAmp;
    }
};

var quat = exports.quat = {
    set: function(out, x, y, z, w) { out[0] = x; out[1] = y; out[2] = z; out[3] = w; return out; },
    copy: function(out, a) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3]; return out; }
};

var mat4 = exports.mat4 = {
    acquire: function() { return mat4Pool.acquire(); },
    release: function(m) { mat4Pool.release(m); },
    identity: function(out) {
        out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
        out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
        out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
        out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1; return out;
    },
    fromRotationTranslationScale: function(out, q, v, s) {
        var x = q[0], y = q[1], z = q[2], w = q[3];
        var x2 = x + x, y2 = y + y, z2 = z + z;
        var xx = x * x2, xy = x * y2, xz = x * z2;
        var yy = y * y2, yz = y * z2, zz = z * z2;
        var wx = w * x2, wy = w * y2, wz = w * z2;
        // Supports both scalar scale and vec3 array scale for Zero-GC hot paths
        var sx = (typeof s === 'number' ? s : s[0]);
        var sy = (typeof s === 'number' ? s : s[1]);
        var sz = (typeof s === 'number' ? s : s[2]);
        
        out[0] = (1 - (yy + zz)) * sx; out[1] = (xy + wz) * sx; out[2] = (xz - wy) * sx; out[3] = 0;
        out[4] = (xy - wz) * sy; out[5] = (1 - (xx + zz)) * sy; out[6] = (yz + wx) * sy; out[7] = 0;
        out[8] = (xz + wy) * sz; out[9] = (yz - wx) * sz; out[10] = (1 - (xx + yy)) * sz; out[11] = 0;
        out[12] = v[0]; out[13] = v[1]; out[14] = v[2]; out[15] = 1; return out;
    },
    lookAt: function(out, eye, center, up) {
        var x0, x1, x2, y0, y1, y2, z0, z1, z2, len;
        var eyex = eye[0], eyey = eye[1], eyez = eye[2];
        var upx = up[0], upy = up[1], upz = up[2];
        var centerx = center[0], centery = center[1], centerz = center[2];
        z0 = eyex - centerx; z1 = eyey - centery; z2 = eyez - centerz;
        len = 1 / Math.sqrt(z0 * z0 + z1 * z1 + z2 * z2);
        z0 *= len; z1 *= len; z2 *= len;
        x0 = upy * z2 - upz * z1; x1 = upz * z0 - upx * z2; x2 = upx * z1 - upy * z0;
        len = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2);
        if (!len) { x0 = 0; x1 = 0; x2 = 0; } else { len = 1 / len; x0 *= len; x1 *= len; x2 *= len; }
        y0 = z1 * x2 - z2 * x1; y1 = z2 * x0 - z0 * x2; y2 = z0 * x1 - z1 * x0;
        out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
        out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
        out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
        out[12] = -(x0 * eyex + x1 * eyey + x2 * eyez);
        out[13] = -(y0 * eyex + y1 * eyey + y2 * eyez);
        out[14] = -(z0 * eyex + z1 * eyey + z2 * eyez);
        out[15] = 1; return out;
    },
    blend: function(out, a, b, t) {
        for (var i = 0; i < 16; i++) out[i] = a[i] + (b[i] - a[i]) * t;
        return out;
    }
};

var mat2 = exports.mat2 = {
    acquire: function() { return mat2Pool.acquire(); },
    release: function(m) { mat2Pool.release(m); },
    createMat2Pool: function(size) { return createPool(function() { return new Float32Array(4); }, size); },
    fromViewport: function(out, x, y, w, h, screenW, screenH) {
        out[0] = w / screenW * 2; out[1] = 0;
        out[2] = 0; out[3] = -h / screenH * 2;
        return out;
    },
    fromAspectFit: function(out, srcW, srcH, tgtW, tgtH) {
        var srcAspect = srcW / srcH, tgtAspect = tgtW / tgtH;
        var scale = (srcAspect > tgtAspect) ? tgtW / srcW : tgtH / srcH;
        out[0] = scale; out[1] = 0; out[2] = 0; out[3] = scale; return out;
    },
    soaHueRotateChroma: function(outR, outG, outB, inR, inG, inB, angleRad) {
        var cosA = Math.cos(angleRad), sinA = Math.sin(angleRad);
        for (var i = 0; i < inR.length; i++) {
            var u = inR[i] - 0.5, v = inG[i] - 0.5;
            outR[i] = u * cosA - v * sinA + 0.5;
            outG[i] = u * sinA + v * cosA + 0.5;
            outB[i] = inB[i];
        }
        return outR;
    }
};

// ============================================================================
// 13. EXPORTS (static -- bundler-friendly)
// ============================================================================
exports.round = round;
exports.setMatrixArrayType = setMatrixArrayType;
exports.toRadian = toRadian;
exports.toDegree = toDegree;
exports.equals = equals;
exports.clamp = clamp;
exports.clamp01 = clamp01;
exports.lerp = lerp;
exports.sign = sign;
exports.fract = fract;
exports.step = step;
exports.smoothstep = smoothstep;
exports.smootherstep = smootherstep;
exports.pow2 = pow2;
exports.invSqrt = invSqrt;
exports.mod = mod;
exports.fastTwoSum = fastTwoSum;
exports.twoSum = twoSum;
exports.dsSub = dsSub;
exports.createSOA = createSOA;
exports.soaFill = soaFill;
exports.soaZero = soaZero;
exports.soaForEach = soaForEach;
exports.soaChunkedForEach = soaChunkedForEach;
exports.soaForEachChunked = soaChunkedForEach; // Alias for blueprint compatibility
exports.createPool = createPool;
exports.yieldToMain = yieldToMain;
exports.forEachChunked = forEachChunked;
exports.createWorkerPool = createWorkerPool;
exports.mulberry32 = mulberry32;
exports.xorshift32 = xorshift32;
exports.splitmix32 = splitmix32;
exports.hash2 = hash2;
exports.hash3 = hash3;
exports.srgbToLinear = srgbToLinear;
exports.linearToSrgb = linearToSrgb;
exports.hslToRgb = hslToRgb;
exports.rgbToHsl = rgbToHsl;
exports.hsvToRgb = hsvToRgb;
exports.rgbToHsv = rgbToHsv;
exports.packRGBA = packRGBA;
exports.unpackRGBA = unpackRGBA;
exports.hexToRgb = hexToRgb;
exports.rgbToHex = rgbToHex;
exports.easeInQuad = easeInQuad;
exports.easeOutQuad = easeOutQuad;
exports.easeInOutQuad = easeInOutQuad;
exports.easeInCubic = easeInCubic;
exports.easeOutCubic = easeOutCubic;
exports.easeInOutCubic = easeInOutCubic;
exports.easeInBack = easeInBack;
exports.easeOutBack = easeOutBack;
exports.easeInOutBack = easeInOutBack;
exports.easeInElastic = easeInElastic;
exports.easeOutElastic = easeOutElastic;
exports.easeInOutElastic = easeInOutElastic;
exports.damp = damp;
exports.springDamp = springDamp;
exports.springDamp3 = springDamp3;
exports.logDepthConstants = logDepthConstants;
exports.logDepthLinearize = logDepthLinearize;
exports.toRelative = toRelative;
exports.toAbsolute = toAbsolute;
exports.keplerSolve = keplerSolve;
exports.eccentricToTrue = eccentricToTrue;
exports.meanToTrue = meanToTrue;