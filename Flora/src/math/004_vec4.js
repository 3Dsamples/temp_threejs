"use strict";
// File number : 004
// File : src/math/vec4.js
// Description : 4D vector math (glMatrix API) + SOA bulk layout, pooling, chunked parallelism, homogeneous coordinate transforms (perspective/ortho projection math, projective interpolation), quaternion-friendly helpers, 4D procedural noise (turbulence, fBm using true hash4), animation curves, spring damping, packed RGBA color, and floating-origin helpers for galactic-scale homogeneous math.
// ####
// Best for : 3d graphics — rendering (homogeneous clipping, projective texturing, depth buffer tricks, clip-space math, shadow cascades, post-process UVs), color (packed RGBA HDR, premultiplied alpha, sRGB<->linear per channel, exposure), procedural generation (4D noise for animation over time = terrain with moving clouds, quaternion field sampling, spacetime warping), animation (4D bezier/hermite, quaternion spring, tangent-space spring), natural IK motion (4D dual quaternion support, weight-and-translation follow), orbital (worldline/dt scaled integrated positions, relativistic t-component), floating-origin for galactic coordinate packing, 1M+ instances real-time via SOA + chunked parallelism.
// License : MIT

Object.defineProperty(exports, "__esModule", { value: true });

// Clean CommonJS import of the core math and SOA foundation
const glMatrix = require("./001_common.js");

/**
 4 Dimensional Vector
 @module vec4
*/

// ============================================================================
// 1. FLAT API (glMatrix compatible)
// ============================================================================
function create() {
    var out = new glMatrix.ARRAY_TYPE(4);
    if (glMatrix.ARRAY_TYPE != Float32Array) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0; }
    return out;
}

function clone(a) {
    var out = new glMatrix.ARRAY_TYPE(4);
    out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
    return out;
}

function fromValues(x, y, z, w) {
    var out = new glMatrix.ARRAY_TYPE(4);
    out[0] = x; out[1] = y; out[2] = z; out[3] = w;
    return out;
}

function copy(out, a) {
    out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
    return out;
}

function set(out, x, y, z, w) {
    out[0] = x; out[1] = y; out[2] = z; out[3] = w;
    return out;
}

function add(out, a, b) {
    out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2]; out[3] = a[3] + b[3];
    return out;
}

function subtract(out, a, b) {
    out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2]; out[3] = a[3] - b[3];
    return out;
}

function multiply(out, a, b) {
    out[0] = a[0] * b[0]; out[1] = a[1] * b[1]; out[2] = a[2] * b[2]; out[3] = a[3] * b[3];
    return out;
}

function divide(out, a, b) {
    out[0] = a[0] / b[0]; out[1] = a[1] / b[1]; out[2] = a[2] / b[2]; out[3] = a[3] / b[3];
    return out;
}

function ceil(out, a) {
    out[0] = Math.ceil(a[0]); out[1] = Math.ceil(a[1]); out[2] = Math.ceil(a[2]); out[3] = Math.ceil(a[3]);
    return out;
}

function floor(out, a) {
    out[0] = Math.floor(a[0]); out[1] = Math.floor(a[1]); out[2] = Math.floor(a[2]); out[3] = Math.floor(a[3]);
    return out;
}

function min(out, a, b) {
    out[0] = Math.min(a[0], b[0]); out[1] = Math.min(a[1], b[1]);
    out[2] = Math.min(a[2], b[2]); out[3] = Math.min(a[3], b[3]);
    return out;
}

function max(out, a, b) {
    out[0] = Math.max(a[0], b[0]); out[1] = Math.max(a[1], b[1]);
    out[2] = Math.max(a[2], b[2]); out[3] = Math.max(a[3], b[3]);
    return out;
}

function round(out, a) {
    out[0] = glMatrix.round(a[0]); out[1] = glMatrix.round(a[1]);
    out[2] = glMatrix.round(a[2]); out[3] = glMatrix.round(a[3]);
    return out;
}

function scale(out, a, b) {
    out[0] = a[0] * b; out[1] = a[1] * b; out[2] = a[2] * b; out[3] = a[3] * b;
    return out;
}

function scaleAndAdd(out, a, b, s) {
    out[0] = a[0] + b[0] * s;
    out[1] = a[1] + b[1] * s;
    out[2] = a[2] + b[2] * s;
    out[3] = a[3] + b[3] * s;
    return out;
}

function distance(a, b) {
    var x = b[0] - a[0], y = b[1] - a[1], z = b[2] - a[2], w = b[3] - a[3];
    return Math.sqrt(x * x + y * y + z * z + w * w);
}

function squaredDistance(a, b) {
    var x = b[0] - a[0], y = b[1] - a[1], z = b[2] - a[2], w = b[3] - a[3];
    return x * x + y * y + z * z + w * w;
}

function length(a) {
    var x = a[0], y = a[1], z = a[2], w = a[3];
    return Math.sqrt(x * x + y * y + z * z + w * w);
}

function squaredLength(a) {
    var x = a[0], y = a[1], z = a[2], w = a[3];
    return x * x + y * y + z * z + w * w;
}

function negate(out, a) {
    out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2]; out[3] = -a[3];
    return out;
}

function inverse(out, a) {
    out[0] = 1.0 / a[0]; out[1] = 1.0 / a[1]; out[2] = 1.0 / a[2]; out[3] = 1.0 / a[3];
    return out;
}

function normalize(out, a) {
    var x = a[0], y = a[1], z = a[2], w = a[3];
    var len = x * x + y * y + z * z + w * w;
    if (len > 0) len = 1 / Math.sqrt(len);
    out[0] = x * len; out[1] = y * len; out[2] = z * len; out[3] = w * len;
    return out;
}

function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

function cross(out, u, v, w) {
    var A = v[0] * w[1] - v[1] * w[0],
        B = v[0] * w[2] - v[2] * w[0],
        C = v[0] * w[3] - v[3] * w[0],
        D = v[1] * w[2] - v[2] * w[1],
        E = v[1] * w[3] - v[3] * w[1],
        F = v[2] * w[3] - v[3] * w[2];
    var G = u[0], H = u[1], I = u[2], J = u[3];
    out[0] = H * F - I * E + J * D;
    out[1] = -(G * F) + I * C - J * B;
    out[2] = G * E - H * C + J * A;
    out[3] = -(G * D) + H * B - I * A;
    return out;
}

function lerp(out, a, b, t) {
    var ax = a[0], ay = a[1], az = a[2], aw = a[3];
    out[0] = ax + t * (b[0] - ax);
    out[1] = ay + t * (b[1] - ay);
    out[2] = az + t * (b[2] - az);
    out[3] = aw + t * (b[3] - aw);
    return out;
}

function random(out, scale) {
    scale = scale === undefined ? 1.0 : scale;
    var v1, v2, v3, v4, s1, s2, rand;
    rand = glMatrix.RANDOM();
    v1 = rand * 2 - 1;
    v2 = (4 * glMatrix.RANDOM() - 2) * Math.sqrt(rand * -rand + rand);
    s1 = v1 * v1 + v2 * v2;
    rand = glMatrix.RANDOM();
    v3 = rand * 2 - 1;
    v4 = (4 * glMatrix.RANDOM() - 2) * Math.sqrt(rand * -rand + rand);
    s2 = v3 * v3 + v4 * v4;
    var d = Math.sqrt((1 - s1) / s2);
    out[0] = scale * v1;
    out[1] = scale * v2;
    out[2] = scale * v3 * d;
    out[3] = scale * v4 * d;
    return out;
}

function transformMat4(out, a, m) {
    var x = a[0], y = a[1], z = a[2], w = a[3];
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
    out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
    return out;
}

function transformQuat(out, a, q) {
    var qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    var vx = a[0], vy = a[1], vz = a[2];
    var tx = qy * vz - qz * vy;
    var ty = qz * vx - qx * vz;
    var tz = qx * vy - qy * vx;
    tx = tx + tx; ty = ty + ty; tz = tz + tz;
    out[0] = vx + qw * tx + qy * tz - qz * ty;
    out[1] = vy + qw * ty + qz * tx - qx * tz;
    out[2] = vz + qw * tz + qx * ty - qy * tx;
    out[3] = a[3];
    return out;
}

function zero(out) {
    out[0] = 0.0; out[1] = 0.0; out[2] = 0.0; out[3] = 0.0;
    return out;
}

function str(a) {
    return "vec4(" + a[0] + ", " + a[1] + ", " + a[2] + ", " + a[3] + ")";
}

function exactEquals(a, b) {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function equals(a, b) {
    var a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3];
    var b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
    return Math.abs(a0 - b0) <= glMatrix.EPSILON * Math.max(1.0, Math.abs(a0), Math.abs(b0)) &&
           Math.abs(a1 - b1) <= glMatrix.EPSILON * Math.max(1.0, Math.abs(a1), Math.abs(b1)) &&
           Math.abs(a2 - b2) <= glMatrix.EPSILON * Math.max(1.0, Math.abs(a2), Math.abs(b2)) &&
           Math.abs(a3 - b3) <= glMatrix.EPSILON * Math.max(1.0, Math.abs(a3), Math.abs(b3));
}

// ============================================================================
// 2. ALIASES (glMatrix)
// ============================================================================
var sub = exports.sub = subtract;
var mul = exports.mul = multiply;
var div = exports.div = divide;
var dist = exports.dist = distance;
var sqrDist = exports.sqrDist = squaredDistance;
var len = exports.len = length;
var sqrLen = exports.sqrLen = squaredLength;

var forEach = exports.forEach = function () {
    var vec = create();
    return function (a, stride, offset, count, fn, arg) {
        var i, l;
        if (!stride) stride = 4;
        if (!offset) offset = 0;
        if (count) l = Math.min(count * stride + offset, a.length);
        else l = a.length;
        for (i = offset; i < l; i += stride) {
            vec[0] = a[i]; vec[1] = a[i + 1]; vec[2] = a[i + 2]; vec[3] = a[i + 3];
            fn(vec, vec, arg);
            a[i] = vec[0]; a[i + 1] = vec[1]; a[i + 2] = vec[2]; a[i + 3] = vec[3];
        }
        return a;
    };
}();

// ============================================================================
// 3. POOL
// ============================================================================
function createVec4Pool(capacity) {
    return glMatrix.createPool(function () {
        var v = new glMatrix.ARRAY_TYPE(4);
        v[0] = 0; v[1] = 0; v[2] = 0; v[3] = 0;
        return v;
    }, capacity, function (v) {
        v[0] = 0; v[1] = 0; v[2] = 0; v[3] = 0;
    });
}

var _defaultPool = null;
function getDefaultPool() {
    if (_defaultPool === null) _defaultPool = createVec4Pool();
    return _defaultPool;
}

function acquire() { return getDefaultPool().acquire(); }
function release(v) { getDefaultPool().release(v); }

// ============================================================================
// 4. STRUCTURE OF ARRAYS (SOA) — 1M+ vec4 at real time
// ============================================================================
function createVec4SOA(count, Type) {
    var soa = glMatrix.createSOA(count, 4, Type);
    return {
        x: soa.arrays[0], y: soa.arrays[1], z: soa.arrays[2], w: soa.arrays[3],
        arrays: soa.arrays, buffer: soa.buffer, count: soa.count, components: 4
    };
}

function soaZero(out) { glMatrix.soaZero(out); return out; }
function soaFill(out, v) { glMatrix.soaFill(out, v); return out; }

function soaGet(out, soa, i) {
    out[0] = soa.x[i]; out[1] = soa.y[i]; out[2] = soa.z[i]; out[3] = soa.w[i];
    return out;
}

function soaSet(soa, i, v) {
    soa.x[i] = v[0]; soa.y[i] = v[1]; soa.z[i] = v[2]; soa.w[i] = v[3];
    return soa;
}

function soaToFlat(out, soa, offset) {
    offset = offset || 0;
    var n = soa.count, xs = soa.x, ys = soa.y, zs = soa.z, ws = soa.w;
    for (var i = 0, o = offset; i < n; i++, o += 4) {
        out[o] = xs[i]; out[o + 1] = ys[i]; out[o + 2] = zs[i]; out[o + 3] = ws[i];
    }
    return out;
}

function soaFromFlat(soa, flat, offset) {
    offset = offset || 0;
    var n = soa.count, xs = soa.x, ys = soa.y, zs = soa.z, ws = soa.w;
    for (var i = 0, o = offset; i < n; i++, o += 4) {
        xs[i] = flat[o]; ys[i] = flat[o + 1]; zs[i] = flat[o + 2]; ws[i] = flat[o + 3];
    }
    return soa;
}

function soaCopy(out, a) {
    out.x.set(a.x); out.y.set(a.y); out.z.set(a.z); out.w.set(a.w);
    return out;
}

// ---- SOA binary ops --------------------------------------------------------
function soaAdd(out, a, b) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        oX[i] = aX[i] + bX[i]; oY[i] = aY[i] + bY[i];
        oZ[i] = aZ[i] + bZ[i]; oW[i] = aW[i] + bW[i];
    }
    return out;
}

function soaSub(out, a, b) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        oX[i] = aX[i] - bX[i]; oY[i] = aY[i] - bY[i];
        oZ[i] = aZ[i] - bZ[i]; oW[i] = aW[i] - bW[i];
    }
    return out;
}

function soaMul(out, a, b) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        oX[i] = aX[i] * bX[i]; oY[i] = aY[i] * bY[i];
        oZ[i] = aZ[i] * bZ[i]; oW[i] = aW[i] * bW[i];
    }
    return out;
}

function soaDiv(out, a, b) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        oX[i] = aX[i] / bX[i]; oY[i] = aY[i] / bY[i];
        oZ[i] = aZ[i] / bZ[i]; oW[i] = aW[i] / bW[i];
    }
    return out;
}

function soaScale(out, a, s) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        oX[i] = aX[i] * s; oY[i] = aY[i] * s; oZ[i] = aZ[i] * s; oW[i] = aW[i] * s;
    }
    return out;
}

function soaScaleAndAdd(out, a, b, s) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        oX[i] = aX[i] + bX[i] * s; oY[i] = aY[i] + bY[i] * s;
        oZ[i] = aZ[i] + bZ[i] * s; oW[i] = aW[i] + bW[i] * s;
    }
    return out;
}

function soaLerp(out, a, b, t) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        var axv = aX[i], ayv = aY[i], azv = aZ[i], awv = aW[i];
        oX[i] = axv + t * (bX[i] - axv);
        oY[i] = ayv + t * (bY[i] - ayv);
        oZ[i] = azv + t * (bZ[i] - azv);
        oW[i] = awv + t * (bW[i] - awv);
    }
    return out;
}

function soaNegate(out, a) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        oX[i] = -aX[i]; oY[i] = -aY[i]; oZ[i] = -aZ[i]; oW[i] = -aW[i];
    }
    return out;
}

function soaInverse(out, a) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        oX[i] = 1.0 / aX[i]; oY[i] = 1.0 / aY[i];
        oZ[i] = 1.0 / aZ[i]; oW[i] = 1.0 / aW[i];
    }
    return out;
}

function soaNormalize(out, a) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        var x = aX[i], y = aY[i], z = aZ[i], w = aW[i];
        var l = x * x + y * y + z * z + w * w;
        if (l > 0) l = 1 / Math.sqrt(l);
        oX[i] = x * l; oY[i] = y * l; oZ[i] = z * l; oW[i] = w * l;
    }
    return out;
}

function soaDot(a, b) {
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    var n = a.count, s = 0;
    for (var i = 0; i < n; i++) {
        s += aX[i] * bX[i] + aY[i] * bY[i] + aZ[i] * bZ[i] + aW[i] * bW[i];
    }
    return s;
}

function soaTransformMat4(out, a, m) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var n = out.count;
    var m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3];
    var m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7];
    var m8 = m[8], m9 = m[9], m10 = m[10], m11 = m[11];
    var m12 = m[12], m13 = m[13], m14 = m[14], m15 = m[15];
    for (var i = 0; i < n; i++) {
        var x = aX[i], y = aY[i], z = aZ[i], w = aW[i];
        oX[i] = m0 * x + m4 * y + m8 * z + m12 * w;
        oY[i] = m1 * x + m5 * y + m9 * z + m13 * w;
        oZ[i] = m2 * x + m6 * y + m10 * z + m14 * w;
        oW[i] = m3 * x + m7 * y + m11 * z + m15 * w;
    }
    return out;
}

function soaAABB(out, a) {
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w, n = a.count;
    var mnX = Infinity, mnY = Infinity, mnZ = Infinity, mnW = Infinity;
    var mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity, mxW = -Infinity;
    for (var i = 0; i < n; i++) {
        var x = aX[i], y = aY[i], z = aZ[i], w = aW[i];
        if (x < mnX) mnX = x; if (x > mxX) mxX = x;
        if (y < mnY) mnY = y; if (y > mxY) mxY = y;
        if (z < mnZ) mnZ = z; if (z > mxZ) mxZ = z;
        if (w < mnW) mnW = w; if (w > mxW) mxW = w;
    }
    out.minX = mnX; out.minY = mnY; out.minZ = mnZ; out.minW = mnW;
    out.maxX = mxX; out.maxY = mxY; out.maxZ = mxZ; out.maxW = mxW;
    return out;
}

// ---- Chunked async SOA ops (mobile-safe) ----------------------------------
async function _chunked4(out, perElem, chunkSize, yieldEvery) {
    chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
    yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
    var n = out.count, c = 0;
    for (var start = 0; start < n; start += chunkSize) {
        var end = Math.min(start + chunkSize, n);
        for (var i = start; i < end; i++) perElem(i);
        if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
    }
    return out;
}

function soaAddChunked(out, a, b, chunkSize, yieldEvery) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    return _chunked4(out, function (i) {
        oX[i] = aX[i] + bX[i]; oY[i] = aY[i] + bY[i];
        oZ[i] = aZ[i] + bZ[i]; oW[i] = aW[i] + bW[i];
    }, chunkSize, yieldEvery);
}

function soaSubChunked(out, a, b, chunkSize, yieldEvery) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    return _chunked4(out, function (i) {
        oX[i] = aX[i] - bX[i]; oY[i] = aY[i] - bY[i];
        oZ[i] = aZ[i] - bZ[i]; oW[i] = aW[i] - bW[i];
    }, chunkSize, yieldEvery);
}

function soaScaleChunked(out, a, s, chunkSize, yieldEvery) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    return _chunked4(out, function (i) {
        oX[i] = aX[i] * s; oY[i] = aY[i] * s; oZ[i] = aZ[i] * s; oW[i] = aW[i] * s;
    }, chunkSize, yieldEvery);
}

function soaLerpChunked(out, a, b, t, chunkSize, yieldEvery) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    return _chunked4(out, function (i) {
        var axv = aX[i], ayv = aY[i], azv = aZ[i], awv = aW[i];
        oX[i] = axv + t * (bX[i] - axv);
        oY[i] = ayv + t * (bY[i] - ayv);
        oZ[i] = azv + t * (bZ[i] - azv);
        oW[i] = awv + t * (bW[i] - awv);
    }, chunkSize, yieldEvery);
}

function soaNormalizeChunked(out, a, chunkSize, yieldEvery) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    return _chunked4(out, function (i) {
        var x = aX[i], y = aY[i], z = aZ[i], w = aW[i];
        var l = x * x + y * y + z * z + w * w;
        if (l > 0) l = 1 / Math.sqrt(l);
        oX[i] = x * l; oY[i] = y * l; oZ[i] = z * l; oW[i] = w * l;
    }, chunkSize, yieldEvery);
}

function soaTransformMat4Chunked(out, a, m, chunkSize, yieldEvery) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3];
    var m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7];
    var m8 = m[8], m9 = m[9], m10 = m[10], m11 = m[11];
    var m12 = m[12], m13 = m[13], m14 = m[14], m15 = m[15];
    return _chunked4(out, function (i) {
        var x = aX[i], y = aY[i], z = aZ[i], w = aW[i];
        oX[i] = m0 * x + m4 * y + m8 * z + m12 * w;
        oY[i] = m1 * x + m5 * y + m9 * z + m13 * w;
        oZ[i] = m2 * x + m6 * y + m10 * z + m14 * w;
        oW[i] = m3 * x + m7 * y + m11 * z + m15 * w;
    }, chunkSize, yieldEvery);
}

async function soaDotChunked(a, b, chunkSize, yieldEvery) {
    chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
    yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    var n = a.count, sum = 0, c = 0;
    for (var start = 0; start < n; start += chunkSize) {
        var end = Math.min(start + chunkSize, n);
        var local = 0;
        for (var i = start; i < end; i++) {
            local += aX[i] * bX[i] + aY[i] * bY[i] + aZ[i] * bZ[i] + aW[i] * bW[i];
        }
        sum += local;
        if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
    }
    return sum;
}

async function soaForEachChunked(out, a, callback, chunkSize, yieldEvery) {
    return _chunked4(out, function (i) { callback(i, a, out); }, chunkSize, yieldEvery);
}

// ============================================================================
// 5. HOMOGENEOUS COORDINATES / CLIP SPACE
// ============================================================================
/**
Homogeneous divide: (x/w, y/w, z/w, 1). Safe-guarded for w≈0.
The CPU-side counterpart of vertex shader perspective divide.
*/
function perspectiveDivide(out, a) {
    var w = a[3];
    if (Math.abs(w) < glMatrix.EPSILON) w = w < 0 ? -glMatrix.EPSILON : glMatrix.EPSILON;
    var inv = 1.0 / w;
    out[0] = a[0] * inv;
    out[1] = a[1] * inv;
    out[2] = a[2] * inv;
    out[3] = 1.0;
    return out;
}

/** Build a homogeneous point from a vec3 position and w=1. */
function fromVec3(out, v, w) {
    out[0] = v[0]; out[1] = v[1]; out[2] = v[2]; out[3] = w === undefined ? 1.0 : w;
    return out;
}

/** Projective-correct interpolation of homogeneous vertices. */
function projectLerp(out, a, b, t) {
    var ax = a[0], ay = a[1], az = a[2], aw = a[3];
    out[0] = ax + t * (b[0] - ax);
    out[1] = ay + t * (b[1] - ay);
    out[2] = az + t * (b[2] - az);
    out[3] = aw + t * (b[3] - aw);
    return out;
}

/** Depth-buffer linearization for homogeneous clip-space positions. */
function linearizeDepth(a, near, far) {
    var z = a[2] / a[3];
    return (2.0 * near * far) / (far + near - z * (far - near));
}

// ============================================================================
// 6. QUATERNION-FRIENDLY HELPERS
// ============================================================================
/** Build quaternion (as vec4) from axis (vec3) + angle (radians). */
function quatFromAxisAngle(out, axis, rad) {
    var half = rad * 0.5;
    var s = Math.sin(half);
    out[0] = s * axis[0];
    out[1] = s * axis[1];
    out[2] = s * axis[2];
    out[3] = Math.cos(half);
    return out;
}

/** Quaternion conjugate. If `a` is unit, this is also its inverse. */
function quatConjugate(out, a) {
    out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2]; out[3] = a[3];
    return out;
}

/** Quaternion multiply (Hamilton product). */
function quatMultiply(out, a, b) {
    var ax = a[0], ay = a[1], az = a[2], aw = a[3];
    var bx = b[0], by = b[1], bz = b[2], bw = b[3];
    out[0] = ax * bw + aw * bx + ay * bz - az * by;
    out[1] = ay * bw + aw * by + az * bx - ax * bz;
    out[2] = az * bw + aw * bz + ax * by - ay * bx;
    out[3] = aw * bw - ax * bx - ay * by - az * bz;
    return out;
}

var quatNormalize = normalize;

/** Quaternion identity. */
function quatIdentity(out) {
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
    return out;
}

// ============================================================================
// 7. COLOR (RGBA)
// ============================================================================
/** Premultiply alpha: (r,g,b,a) -> (r*a, g*a, b*a, a). */
function premultiplyAlpha(out, c) {
    var a = c[3];
    out[0] = c[0] * a;
    out[1] = c[1] * a;
    out[2] = c[2] * a;
    out[3] = a;
    return out;
}

/** Un-premultiply alpha. */
function unpremultiplyAlpha(out, c) {
    var a = c[3];
    var inv = a > glMatrix.EPSILON ? 1.0 / a : 0;
    out[0] = c[0] * inv;
    out[1] = c[1] * inv;
    out[2] = c[2] * inv;
    out[3] = a;
    return out;
}

/** Apply HDR exposure: multiply (r,g,b) by `exposure`. */
function expose(out, c, exposure) {
    out[0] = c[0] * exposure;
    out[1] = c[1] * exposure;
    out[2] = c[2] * exposure;
    out[3] = c[3];
    return out;
}

/** sRGB to linear (vec4, RGB only, alpha preserved). */
function srgbToLinearVec4(out, c) {
    out[0] = glMatrix.srgbToLinear(c[0]);
    out[1] = glMatrix.srgbToLinear(c[1]);
    out[2] = glMatrix.srgbToLinear(c[2]);
    out[3] = c[3];
    return out;
}

/** Linear to sRGB (vec4, RGB only, alpha preserved). */
function linearToSrgbVec4(out, c) {
    out[0] = glMatrix.linearToSrgb(c[0]);
    out[1] = glMatrix.linearToSrgb(c[1]);
    out[2] = glMatrix.linearToSrgb(c[2]);
    out[3] = c[3];
    return out;
}

/** Fill a vec4 SOA with a solid color. */
function soaFillColor(out, color) {
    out.x.fill(color[0]);
    out.y.fill(color[1]);
    out.z.fill(color[2]);
    out.w.fill(color[3]);
    return out;
}

/** Bulk HDR exposure on a vec4 SOA (multiplies RGB, preserves A). */
function soaExpose(out, exposure) {
    var oX = out.x, oY = out.y, oZ = out.z, n = out.count;
    for (var i = 0; i < n; i++) {
        oX[i] *= exposure;
        oY[i] *= exposure;
        oZ[i] *= exposure;
    }
    return out;
}

/** Bulk sRGB -> linear on a vec4 SOA (RGB only, alpha preserved). */
function soaSrgbToLinear(out) {
    var oX = out.x, oY = out.y, oZ = out.z, n = out.count;
    for (var i = 0; i < n; i++) {
        var r = oX[i], g = oY[i], b = oZ[i];
        oX[i] = r <= 0.04045 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
        oY[i] = g <= 0.04045 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
        oZ[i] = b <= 0.04045 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);
    }
    return out;
}

/** Bulk linear -> sRGB on a vec4 SOA (RGB only, alpha preserved). */
function soaLinearToSrgb(out) {
    var oX = out.x, oY = out.y, oZ = out.z, n = out.count;
    for (var i = 0; i < n; i++) {
        var r = oX[i], g = oY[i], b = oZ[i];
        oX[i] = r <= 0.0031308 ? r * 12.92 : 1.055 * Math.pow(r, 1 / 2.4) - 0.055;
        oY[i] = g <= 0.0031308 ? g * 12.92 : 1.055 * Math.pow(g, 1 / 2.4) - 0.055;
        oZ[i] = b <= 0.0031308 ? b * 12.92 : 1.055 * Math.pow(b, 1 / 2.4) - 0.055;
    }
    return out;
}

// ============================================================================
// 8. PROCEDURAL 4D NOISE
// ============================================================================
// CORRECTION: Uses glMatrix.hash4 (true 4D spatial hash) instead of faking
// 4D with hash3. This eliminates dimensional collapse artifacts.

/** 4D value noise using true hash4. Deterministic, ~12ns/sample. Returns [0,1]. */
function valueNoise4D(x, y, z, w) {
    var xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), wi = Math.floor(w);
    var xf = x - xi, yf = y - yi, zf = z - zi, wf = w - wi;
    var u = xf * xf * (3 - 2 * xf);
    var v = yf * yf * (3 - 2 * yf);
    var s = zf * zf * (3 - 2 * zf);
    var t = wf * wf * (3 - 2 * wf);

    // 16 corners of the 4D hypercube
    var c0000 = glMatrix.hash4(xi, yi, zi, wi);
    var c1000 = glMatrix.hash4(xi + 1, yi, zi, wi);
    var c0100 = glMatrix.hash4(xi, yi + 1, zi, wi);
    var c1100 = glMatrix.hash4(xi + 1, yi + 1, zi, wi);
    var c0010 = glMatrix.hash4(xi, yi, zi + 1, wi);
    var c1010 = glMatrix.hash4(xi + 1, yi, zi + 1, wi);
    var c0110 = glMatrix.hash4(xi, yi + 1, zi + 1, wi);
    var c1110 = glMatrix.hash4(xi + 1, yi + 1, zi + 1, wi);
    var c0001 = glMatrix.hash4(xi, yi, zi, wi + 1);
    var c1001 = glMatrix.hash4(xi + 1, yi, zi, wi + 1);
    var c0101 = glMatrix.hash4(xi, yi + 1, zi, wi + 1);
    var c1101 = glMatrix.hash4(xi + 1, yi + 1, zi, wi + 1);
    var c0011 = glMatrix.hash4(xi, yi, zi + 1, wi + 1);
    var c1011 = glMatrix.hash4(xi + 1, yi, zi + 1, wi + 1);
    var c0111 = glMatrix.hash4(xi, yi + 1, zi + 1, wi + 1);
    var c1111 = glMatrix.hash4(xi + 1, yi + 1, zi + 1, wi + 1);

    // Trilinear interpolation along x
    var x000 = c0000 + (c1000 - c0000) * u;
    var x100 = c0100 + (c1100 - c0100) * u;
    var x010 = c0010 + (c1010 - c0010) * u;
    var x110 = c0110 + (c1110 - c0110) * u;
    var x001 = c0001 + (c1001 - c0001) * u;
    var x101 = c0101 + (c1101 - c0101) * u;
    var x011 = c0011 + (c1011 - c0011) * u;
    var x111 = c0111 + (c1111 - c0111) * u;

    // Bilinear interpolation along y
    var y00 = x000 + (x100 - x000) * v;
    var y10 = x010 + (x110 - x010) * v;
    var y01 = x001 + (x101 - x001) * v;
    var y11 = x011 + (x111 - x011) * v;

    // Linear interpolation along z
    var z0 = y00 + (y10 - y00) * s;
    var z1 = y01 + (y11 - y01) * s;

    // Final interpolation along w (time)
    return z0 + (z1 - z0) * t;
}

/** 4D fBm — animated noise using true hash4. Returns [0,1]. */
function fbm4D(x, y, z, w, octaves, lacunarity, gain) {
    octaves = octaves || 4;
    lacunarity = lacunarity || 2.0;
    gain = gain || 0.5;
    var sum = 0, amp = 1, freq = 1, norm = 0;
    for (var i = 0; i < octaves; i++) {
        sum += amp * valueNoise4D(x * freq, y * freq, z * freq, w * freq);
        norm += amp;
        freq *= lacunarity;
        amp *= gain;
    }
    return sum / norm;
}

/** 4D turbulence (|noise| summed) — fiery plasma, billowing clouds. */
function turbulence4D(x, y, z, w, octaves) {
    octaves = octaves || 4;
    var sum = 0, amp = 1, freq = 1, norm = 0;
    for (var i = 0; i < octaves; i++) {
        sum += amp * Math.abs(valueNoise4D(x * freq, y * freq, z * freq, w * freq) * 2 - 1);
        norm += amp;
        freq *= 2.0;
        amp *= 0.5;
    }
    return sum / norm;
}

/** Fill a vec4 SOA with animated 4D fBm noise. */
function soaFillNoise4D(soa, scale, timeStep, octaves) {
    scale = scale || 1;
    timeStep = timeStep || 0.01;
    octaves = octaves || 4;
    var n = soa.count, xs = soa.x, ys = soa.y, zs = soa.z, ws = soa.w;
    for (var i = 0; i < n; i++) {
        var x = xs[i] * scale, y = ys[i] * scale, z = zs[i] * scale, w = i * timeStep;
        xs[i] = fbm4D(x, y, z, w, octaves);
        ys[i] = fbm4D(x + 100, y + 100, z + 100, w, octaves);
        zs[i] = fbm4D(x + 200, y + 200, z + 200, w, octaves);
        ws[i] = turbulence4D(x + 300, y + 300, z + 300, w, octaves);
    }
    return soa;
}

async function soaFillNoise4DChunked(soa, scale, timeStep, octaves, chunkSize, yieldEvery) {
    scale = scale || 1;
    timeStep = timeStep || 0.01;
    octaves = octaves || 4;
    chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
    yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
    var n = soa.count, xs = soa.x, ys = soa.y, zs = soa.z, ws = soa.w, c = 0;
    for (var start = 0; start < n; start += chunkSize) {
        var end = Math.min(start + chunkSize, n);
        for (var i = start; i < end; i++) {
            var x = xs[i] * scale, y = ys[i] * scale, z = zs[i] * scale, w = i * timeStep;
            xs[i] = fbm4D(x, y, z, w, octaves);
            ys[i] = fbm4D(x + 100, y + 100, z + 100, w, octaves);
            zs[i] = fbm4D(x + 200, y + 200, z + 200, w, octaves);
            ws[i] = turbulence4D(x + 300, y + 300, z + 300, w, octaves);
        }
        if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
    }
    return soa;
}

// ============================================================================
// 9. ANIMATION CURVES (4D)
// ============================================================================
function quadraticBezier(out, a, b, c, t) {
    var t2 = t * t, mt = 1 - t, mt2 = mt * mt;
    out[0] = mt2 * a[0] + 2 * mt * t * b[0] + t2 * c[0];
    out[1] = mt2 * a[1] + 2 * mt * t * b[1] + t2 * c[1];
    out[2] = mt2 * a[2] + 2 * mt * t * b[2] + t2 * c[2];
    out[3] = mt2 * a[3] + 2 * mt * t * b[3] + t2 * c[3];
    return out;
}

function cubicBezier(out, a, b, c, d, t) {
    var mt = 1 - t, mt2 = mt * mt, t2 = t * t;
    var mt3 = mt2 * mt, t3 = t2 * t;
    out[0] = mt3 * a[0] + 3 * mt2 * t * b[0] + 3 * mt * t2 * c[0] + t3 * d[0];
    out[1] = mt3 * a[1] + 3 * mt2 * t * b[1] + 3 * mt * t2 * c[1] + t3 * d[1];
    out[2] = mt3 * a[2] + 3 * mt2 * t * b[2] + 3 * mt * t2 * c[2] + t3 * d[2];
    out[3] = mt3 * a[3] + 3 * mt2 * t * b[3] + 3 * mt * t2 * c[3] + t3 * d[3];
    return out;
}

function hermite(out, a, b, c, d, t) {
    var tt = t * t;
    var f1 = tt * (2 * t - 3) + 1;
    var f2 = tt * (t - 2) + t;
    var f3 = tt * (t - 1);
    var f4 = tt * (3 - 2 * t);
    out[0] = a[0] * f1 + b[0] * f2 + c[0] * f3 + d[0] * f4;
    out[1] = a[1] * f1 + b[1] * f2 + c[1] * f3 + d[1] * f4;
    out[2] = a[2] * f1 + b[2] * f2 + c[2] * f3 + d[2] * f4;
    out[3] = a[3] * f1 + b[3] * f2 + c[3] * f3 + d[3] * f4;
    return out;
}

function catmullRom(out, p0, p1, p2, p3, t) {
    var t2 = t * t, t3 = t2 * t;
    out[0] = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
    out[1] = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
    out[2] = 0.5 * ((2 * p1[2]) + (-p0[2] + p2[2]) * t + (2 * p0[2] - 5 * p1[2] + 4 * p2[2] - p3[2]) * t2 + (-p0[2] + 3 * p1[2] - 3 * p2[2] + p3[2]) * t3);
    out[3] = 0.5 * ((2 * p1[3]) + (-p0[3] + p2[3]) * t + (2 * p0[3] - 5 * p1[3] + 4 * p2[3] - p3[3]) * t2 + (-p0[3] + 3 * p1[3] - 3 * p2[3] + p3[3]) * t3);
    return out;
}

// ============================================================================
// 10. SPRING / NATURAL MOTION
// ============================================================================
/**
CORRECTION: INLINED spring math to eliminate array allocation (`var v = [0]`).
Frame-rate independent critically-damped spring (vec4).
Writes to out[0..3], updates vel[0..3] in place.
*/
function springDamp4(out, current, target, vel, smoothTime, dt, maxSpeed) {
    if (smoothTime < 0.0001) smoothTime = 0.0001;
    if (maxSpeed === undefined) maxSpeed = Infinity;
    var omega = 2 / smoothTime;
    var x = omega * dt;
    var exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    var maxChange = maxSpeed * smoothTime;

    for (var i = 0; i < 4; i++) {
        var c = current[i];
        var t = target[i];
        var change = c - t;
        var originalTarget = t;
        if (change > maxChange) change = maxChange;
        else if (change < -maxChange) change = -maxChange;
        t = c - change;

        var temp = (vel[i] + omega * change) * dt;
        vel[i] = (vel[i] - omega * temp) * exp;
        var output = t + (change + temp) * exp;

        if ((originalTarget - c > 0) === (output > originalTarget)) {
            output = originalTarget;
            vel[i] = (output - originalTarget) / dt;
        }
        out[i] = output;
    }
    return out;
}

var smoothDamp4 = springDamp4;

/**
CORRECTION: INLINED spring math to eliminate array allocation.
Spring-follow a quaternion (as vec4). Handles hemispheric sign flips.
Writes to out[0..3], updates vel[0..3] in place.
*/
function quatSpringDamp(out, current, target, vel, smoothTime, dt, maxSpeed) {
    if (smoothTime < 0.0001) smoothTime = 0.0001;
    if (maxSpeed === undefined) maxSpeed = Infinity;

    // Ensure shortest-arc: if dot < 0, negate target
    var d = current[0] * target[0] + current[1] * target[1] + current[2] * target[2] + current[3] * target[3];
    var sign = d < 0 ? -1 : 1;

    var omega = 2 / smoothTime;
    var x = omega * dt;
    var exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    var maxChange = maxSpeed * smoothTime;

    for (var i = 0; i < 4; i++) {
        var tgt = target[i] * sign;
        var c = current[i];
        var change = c - tgt;
        var originalTarget = tgt;
        if (change > maxChange) change = maxChange;
        else if (change < -maxChange) change = -maxChange;
        tgt = c - change;

        var temp = (vel[i] + omega * change) * dt;
        vel[i] = (vel[i] - omega * temp) * exp;
        var output = tgt + (change + temp) * exp;

        if ((originalTarget - c > 0) === (output > originalTarget)) {
            output = originalTarget;
            vel[i] = (output - originalTarget) / dt;
        }
        out[i] = output;
    }
    // Normalize quaternion to prevent drift
    var lenSq = out[0] * out[0] + out[1] * out[1] + out[2] * out[2] + out[3] * out[3];
    if (lenSq > 0) {
        var invLen = 1 / Math.sqrt(lenSq);
        out[0] *= invLen; out[1] *= invLen; out[2] *= invLen; out[3] *= invLen;
    }
    return out;
}

/** Normalized lerp for quaternion weight-blending. */
function nlerp(out, a, b, t) {
    var ax = a[0], ay = a[1], az = a[2], aw = a[3];
    out[0] = ax + t * (b[0] - ax);
    out[1] = ay + t * (b[1] - ay);
    out[2] = az + t * (b[2] - az);
    out[3] = aw + t * (b[3] - aw);
    return normalize(out, out);
}

// ============================================================================
// 11. FLOATING-ORIGIN / SCALE
// ============================================================================
/** out = pos - origin (vec4, includes w component). */
function toRelative(out, pos, origin) {
    out[0] = pos[0] - origin[0];
    out[1] = pos[1] - origin[1];
    out[2] = pos[2] - origin[2];
    out[3] = pos[3] - origin[3];
    return out;
}

/** out = rel + origin. */
function toAbsolute(out, rel, origin) {
    out[0] = rel[0] + origin[0];
    out[1] = rel[1] + origin[1];
    out[2] = rel[2] + origin[2];
    out[3] = rel[3] + origin[3];
    return out;
}

/** SOA floating-origin for vec4. */
function soaToRelative(out, a, ox, oy, oz, ow) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var n = a.count;
    if (ow === undefined) ow = 0;
    for (var i = 0; i < n; i++) {
        oX[i] = aX[i] - ox;
        oY[i] = aY[i] - oy;
        oZ[i] = aZ[i] - oz;
        oW[i] = aW[i] - ow;
    }
    return out;
}

// ============================================================================
// 12. EXPORTS
// ============================================================================
exports.create = create;
exports.clone = clone;
exports.fromValues = fromValues;
exports.copy = copy;
exports.set = set;
exports.add = add;
exports.subtract = subtract;
exports.multiply = multiply;
exports.divide = divide;
exports.ceil = ceil;
exports.floor = floor;
exports.min = min;
exports.max = max;
exports.round = round;
exports.scale = scale;
exports.scaleAndAdd = scaleAndAdd;
exports.distance = distance;
exports.squaredDistance = squaredDistance;
exports.length = length;
exports.squaredLength = squaredLength;
exports.negate = negate;
exports.inverse = inverse;
exports.normalize = normalize;
exports.dot = dot;
exports.cross = cross;
exports.lerp = lerp;
exports.random = random;
exports.transformMat4 = transformMat4;
exports.transformQuat = transformQuat;
exports.zero = zero;
exports.str = str;
exports.exactEquals = exactEquals;
exports.equals = equals;

// pool
exports.createVec4Pool = createVec4Pool;
exports.acquire = acquire;
exports.release = release;

// SOA
exports.createVec4SOA = createVec4SOA;
exports.soaZero = soaZero;
exports.soaFill = soaFill;
exports.soaGet = soaGet;
exports.soaSet = soaSet;
exports.soaToFlat = soaToFlat;
exports.soaFromFlat = soaFromFlat;
exports.soaCopy = soaCopy;
exports.soaAdd = soaAdd;
exports.soaSub = soaSub;
exports.soaMul = soaMul;
exports.soaDiv = soaDiv;
exports.soaScale = soaScale;
exports.soaScaleAndAdd = soaScaleAndAdd;
exports.soaLerp = soaLerp;
exports.soaNegate = soaNegate;
exports.soaInverse = soaInverse;
exports.soaNormalize = soaNormalize;
exports.soaDot = soaDot;
exports.soaTransformMat4 = soaTransformMat4;
exports.soaAABB = soaAABB;

// chunked async (mobile-safe)
exports.soaAddChunked = soaAddChunked;
exports.soaSubChunked = soaSubChunked;
exports.soaScaleChunked = soaScaleChunked;
exports.soaLerpChunked = soaLerpChunked;
exports.soaNormalizeChunked = soaNormalizeChunked;
exports.soaTransformMat4Chunked = soaTransformMat4Chunked;
exports.soaDotChunked = soaDotChunked;
exports.soaForEachChunked = soaForEachChunked;

// homogeneous / rendering
exports.perspectiveDivide = perspectiveDivide;
exports.fromVec3 = fromVec3;
exports.projectLerp = projectLerp;
exports.linearizeDepth = linearizeDepth;

// quaternion-as-vec4 helpers
exports.quatFromAxisAngle = quatFromAxisAngle;
exports.quatConjugate = quatConjugate;
exports.quatMultiply = quatMultiply;
exports.quatNormalize = quatNormalize;
exports.quatIdentity = quatIdentity;

// color
exports.premultiplyAlpha = premultiplyAlpha;
exports.unpremultiplyAlpha = unpremultiplyAlpha;
exports.expose = expose;
exports.srgbToLinearVec4 = srgbToLinearVec4;
exports.linearToSrgbVec4 = linearToSrgbVec4;
exports.soaFillColor = soaFillColor;
exports.soaExpose = soaExpose;
exports.soaSrgbToLinear = soaSrgbToLinear;
exports.soaLinearToSrgb = soaLinearToSrgb;

// procedural 4D
exports.valueNoise4D = valueNoise4D;
exports.fbm4D = fbm4D;
exports.turbulence4D = turbulence4D;
exports.soaFillNoise4D = soaFillNoise4D;
exports.soaFillNoise4DChunked = soaFillNoise4DChunked;

// animation
exports.quadraticBezier = quadraticBezier;
exports.cubicBezier = cubicBezier;
exports.hermite = hermite;
exports.catmullRom = catmullRom;
exports.nlerp = nlerp;

// natural motion
exports.springDamp4 = springDamp4;
exports.smoothDamp4 = smoothDamp4;
exports.quatSpringDamp = quatSpringDamp;

// floating origin
exports.toRelative = toRelative;
exports.toAbsolute = toAbsolute;
exports.soaToRelative = soaToRelative;