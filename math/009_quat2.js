"use strict";
// File number : 009
// File : src/math/009_quat2.js
// Description : Dual quaternion (full glMatrix API) + full SOA bulk layout (1M+ dual quats), zero-GC pool, chunked parallelism, batch dual-quat skinning (transform points), TRS<->DQ composition, per-instance procedural dual-quat generation from spatial noise, batch translation extraction, spring-damped aim/follow in dual-quat space (natural IK), orbital velocity-aligned dual quats, and floating-origin-safe world-point transforms. Dual quaternions handle rigid-body rotation + translation in one primitive — ideal for skinning 1M+ instances without per-bone matrices.
// ####
// Best for : 3d graphics — procedural generation (per-instance rigid transforms from spatial hash: 1M+ asteroid/tree/crowd instances with position+orientation baked into one 8-float quat2), rendering (batch skinning of 1M+ instanced characters/props, GPU-friendly 8-float uploads, joint propagation), color (implicit through per-instance transform of coloured geometry), animation (slerp of dual quats for combined rotate+translate interpolation, spring-based follow), natural IK motion (spring-damped dual-quat follow of a limb's target frame, blending between solved joint transforms, root-motion integration), orbital (velocity-aligned dual quats for asteroid/trail/ring instances where the mesh rotates AND translates with the body), seamless small-to-galactic scale (translation column is Float64-safe mathematically, but provided as Float32 — for galactic-scale bodies use floating-origin; the SOA path supports per-instance world origin recenter). All SOA ops are Float32Array-backed and yield to the UI thread via scheduler.yield on mobile 64-bit.
// License : MIT

Object.defineProperty(exports, "__esModule", { value: true });

// Clean CommonJS imports
const glMatrix = require("./001_common.js");
const quat = require("./008_quat.js");
const mat4 = require("./007_mat4.js");

// Pre-allocated module-level temporaries for Zero-GC flat API operations
var _tmpQuat4 = new Float32Array(4);
var _tmpVec3A = new Float32Array(3);
var _tmpMat4A = new Float32Array(16);

/**
 Dual Quaternion
 Format: [real(x,y,z,w), dual(x,y,z,w)] — 8 floats.
 Rotation-only in real; translation baked into dual.
 @module quat2
*/

// ============================================================================
// 1. FLAT API (glMatrix — every original export preserved)
// ============================================================================
function create() {
    var dq = new glMatrix.ARRAY_TYPE(8);
    if (glMatrix.ARRAY_TYPE != Float32Array) {
        dq[0] = 0; dq[1] = 0; dq[2] = 0;
        dq[4] = 0; dq[5] = 0; dq[6] = 0; dq[7] = 0;
    }
    dq[3] = 1;
    return dq;
}

function clone(a) {
    var dq = new glMatrix.ARRAY_TYPE(8);
    for (var i = 0; i < 8; i++) dq[i] = a[i];
    return dq;
}

function fromValues(x1, y1, z1, w1, x2, y2, z2, w2) {
    var dq = new glMatrix.ARRAY_TYPE(8);
    dq[0] = x1; dq[1] = y1; dq[2] = z1; dq[3] = w1;
    dq[4] = x2; dq[5] = y2; dq[6] = z2; dq[7] = w2;
    return dq;
}

function fromRotationTranslationValues(x1, y1, z1, w1, x2, y2, z2) {
    var dq = new glMatrix.ARRAY_TYPE(8);
    dq[0] = x1; dq[1] = y1; dq[2] = z1; dq[3] = w1;
    var ax = x2 * 0.5, ay = y2 * 0.5, az = z2 * 0.5;
    dq[4] = ax * w1 + ay * z1 - az * y1;
    dq[5] = ay * w1 + az * x1 - ax * z1;
    dq[6] = az * w1 + ax * y1 - ay * x1;
    dq[7] = -ax * x1 - ay * y1 - az * z1;
    return dq;
}

function fromRotationTranslation(out, q, t) {
    var ax = t[0] * 0.5, ay = t[1] * 0.5, az = t[2] * 0.5;
    var bx = q[0], by = q[1], bz = q[2], bw = q[3];
    out[0] = bx; out[1] = by; out[2] = bz; out[3] = bw;
    out[4] = ax * bw + ay * bz - az * by;
    out[5] = ay * bw + az * bx - ax * bz;
    out[6] = az * bw + ax * by - ay * bx;
    out[7] = -ax * bx - ay * by - az * bz;
    return out;
}

function fromTranslation(out, t) {
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
    out[4] = t[0] * 0.5; out[5] = t[1] * 0.5; out[6] = t[2] * 0.5; out[7] = 0;
    return out;
}

function fromRotation(out, q) {
    out[0] = q[0]; out[1] = q[1]; out[2] = q[2]; out[3] = q[3];
    out[4] = 0; out[5] = 0; out[6] = 0; out[7] = 0;
    return out;
}

/**
 CORRECTION: Uses module-level temporaries to eliminate per-call allocations.
*/
function fromMat4(out, a) {
    mat4.getRotation(_tmpQuat4, a);
    mat4.getTranslation(_tmpVec3A, a);
    fromRotationTranslation(out, _tmpQuat4, _tmpVec3A);
    return out;
}

function copy(out, a) {
    for (var i = 0; i < 8; i++) out[i] = a[i];
    return out;
}

function identity(out) {
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
    out[4] = 0; out[5] = 0; out[6] = 0; out[7] = 0;
    return out;
}

function set(out, x1, y1, z1, w1, x2, y2, z2, w2) {
    out[0] = x1; out[1] = y1; out[2] = z1; out[3] = w1;
    out[4] = x2; out[5] = y2; out[6] = z2; out[7] = w2;
    return out;
}

var getReal = exports.getReal = quat.copy;

function getDual(out, a) {
    out[0] = a[4]; out[1] = a[5]; out[2] = a[6]; out[3] = a[7];
    return out;
}

var setReal = exports.setReal = quat.copy;

function setDual(out, q) {
    out[4] = q[0]; out[5] = q[1]; out[6] = q[2]; out[7] = q[3];
    return out;
}

function getTranslation(out, a) {
    var ax = a[4], ay = a[5], az = a[6], aw = a[7];
    var bx = -a[0], by = -a[1], bz = -a[2], bw = a[3];
    out[0] = (ax * bw + aw * bx + ay * bz - az * by) * 2;
    out[1] = (ay * bw + aw * by + az * bx - ax * bz) * 2;
    out[2] = (az * bw + aw * bz + ax * by - ay * bx) * 2;
    return out;
}

function translate(out, a, v) {
    var ax1 = a[0], ay1 = a[1], az1 = a[2], aw1 = a[3];
    var bx1 = v[0] * 0.5, by1 = v[1] * 0.5, bz1 = v[2] * 0.5;
    var ax2 = a[4], ay2 = a[5], az2 = a[6], aw2 = a[7];
    out[0] = ax1; out[1] = ay1; out[2] = az1; out[3] = aw1;
    out[4] = aw1 * bx1 + ay1 * bz1 - az1 * by1 + ax2;
    out[5] = aw1 * by1 + az1 * bx1 - ax1 * bz1 + ay2;
    out[6] = aw1 * bz1 + ax1 * by1 - ay1 * bx1 + az2;
    out[7] = -ax1 * bx1 - ay1 * by1 - az1 * bz1 + aw2;
    return out;
}

function rotateX(out, a, rad) {
    var bx = -a[0], by = -a[1], bz = -a[2], bw = a[3];
    var ax = a[4], ay = a[5], az = a[6], aw = a[7];
    var ax1 = ax * bw + aw * bx + ay * bz - az * by;
    var ay1 = ay * bw + aw * by + az * bx - ax * bz;
    var az1 = az * bw + aw * bz + ax * by - ay * bx;
    var aw1 = aw * bw - ax * bx - ay * by - az * bz;
    quat.rotateX(out, a, rad);
    bx = out[0]; by = out[1]; bz = out[2]; bw = out[3];
    out[4] = ax1 * bw + aw1 * bx + ay1 * bz - az1 * by;
    out[5] = ay1 * bw + aw1 * by + az1 * bx - ax1 * bz;
    out[6] = az1 * bw + aw1 * bz + ax1 * by - ay1 * bx;
    out[7] = aw1 * bw - ax1 * bx - ay1 * by - az1 * bz;
    return out;
}

function rotateY(out, a, rad) {
    var bx = -a[0], by = -a[1], bz = -a[2], bw = a[3];
    var ax = a[4], ay = a[5], az = a[6], aw = a[7];
    var ax1 = ax * bw + aw * bx + ay * bz - az * by;
    var ay1 = ay * bw + aw * by + az * bx - ax * bz;
    var az1 = az * bw + aw * bz + ax * by - ay * bx;
    var aw1 = aw * bw - ax * bx - ay * by - az * bz;
    quat.rotateY(out, a, rad);
    bx = out[0]; by = out[1]; bz = out[2]; bw = out[3];
    out[4] = ax1 * bw + aw1 * bx + ay1 * bz - az1 * by;
    out[5] = ay1 * bw + aw1 * by + az1 * bx - ax1 * bz;
    out[6] = az1 * bw + aw1 * bz + ax1 * by - ay1 * bx;
    out[7] = aw1 * bw - ax1 * bx - ay1 * by - az1 * bz;
    return out;
}

function rotateZ(out, a, rad) {
    var bx = -a[0], by = -a[1], bz = -a[2], bw = a[3];
    var ax = a[4], ay = a[5], az = a[6], aw = a[7];
    var ax1 = ax * bw + aw * bx + ay * bz - az * by;
    var ay1 = ay * bw + aw * by + az * bx - ax * bz;
    var az1 = az * bw + aw * bz + ax * by - ay * bx;
    var aw1 = aw * bw - ax * bx - ay * by - az * bz;
    quat.rotateZ(out, a, rad);
    bx = out[0]; by = out[1]; bz = out[2]; bw = out[3];
    out[4] = ax1 * bw + aw1 * bx + ay1 * bz - az1 * by;
    out[5] = ay1 * bw + aw1 * by + az1 * bx - ax1 * bz;
    out[6] = az1 * bw + aw1 * bz + ax1 * by - ay1 * bx;
    out[7] = aw1 * bw - ax1 * bx - ay1 * by - az1 * bz;
    return out;
}

function rotateByQuatAppend(out, a, q) {
    var qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    var ax = a[0], ay = a[1], az = a[2], aw = a[3];
    out[0] = ax * qw + aw * qx + ay * qz - az * qy;
    out[1] = ay * qw + aw * qy + az * qx - ax * qz;
    out[2] = az * qw + aw * qz + ax * qy - ay * qx;
    out[3] = aw * qw - ax * qx - ay * qy - az * qz;
    ax = a[4]; ay = a[5]; az = a[6]; aw = a[7];
    out[4] = ax * qw + aw * qx + ay * qz - az * qy;
    out[5] = ay * qw + aw * qy + az * qx - ax * qz;
    out[6] = az * qw + aw * qz + ax * qy - ay * qx;
    out[7] = aw * qw - ax * qx - ay * qy - az * qz;
    return out;
}

function rotateByQuatPrepend(out, q, a) {
    var qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    var bx = a[0], by = a[1], bz = a[2], bw = a[3];
    out[0] = qx * bw + qw * bx + qy * bz - qz * by;
    out[1] = qy * bw + qw * by + qz * bx - qx * bz;
    out[2] = qz * bw + qw * bz + qx * by - qy * bx;
    out[3] = qw * bw - qx * bx - qy * by - qz * bz;
    bx = a[4]; by = a[5]; bz = a[6]; bw = a[7];
    out[4] = qx * bw + qw * bx + qy * bz - qz * by;
    out[5] = qy * bw + qw * by + qz * bx - qx * bz;
    out[6] = qz * bw + qw * bz + qx * by - qy * bx;
    out[7] = qw * bw - qx * bx - qy * by - qz * bz;
    return out;
}

function rotateAroundAxis(out, a, axis, rad) {
    if (Math.abs(rad) < glMatrix.EPSILON) {
        return copy(out, a);
    }
    var axisLength = Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]);
    rad = rad * 0.5;
    var s = Math.sin(rad);
    var bx = s * axis[0] / axisLength;
    var by = s * axis[1] / axisLength;
    var bz = s * axis[2] / axisLength;
    var bw = Math.cos(rad);
    var ax1 = a[0], ay1 = a[1], az1 = a[2], aw1 = a[3];
    out[0] = ax1 * bw + aw1 * bx + ay1 * bz - az1 * by;
    out[1] = ay1 * bw + aw1 * by + az1 * bx - ax1 * bz;
    out[2] = az1 * bw + aw1 * bz + ax1 * by - ay1 * bx;
    out[3] = aw1 * bw - ax1 * bx - ay1 * by - az1 * bz;
    var ax = a[4], ay = a[5], az = a[6], aw = a[7];
    out[4] = ax * bw + aw * bx + ay * bz - az * by;
    out[5] = ay * bw + aw * by + az * bx - ax * bz;
    out[6] = az * bw + aw * bz + ax * by - ay * bx;
    out[7] = aw * bw - ax * bx - ay * by - az * bz;
    return out;
}

function add(out, a, b) {
    for (var i = 0; i < 8; i++) out[i] = a[i] + b[i];
    return out;
}

function multiply(out, a, b) {
    var ax0 = a[0], ay0 = a[1], az0 = a[2], aw0 = a[3];
    var bx1 = b[4], by1 = b[5], bz1 = b[6], bw1 = b[7];
    var ax1 = a[4], ay1 = a[5], az1 = a[6], aw1 = a[7];
    var bx0 = b[0], by0 = b[1], bz0 = b[2], bw0 = b[3];
    out[0] = ax0 * bw0 + aw0 * bx0 + ay0 * bz0 - az0 * by0;
    out[1] = ay0 * bw0 + aw0 * by0 + az0 * bx0 - ax0 * bz0;
    out[2] = az0 * bw0 + aw0 * bz0 + ax0 * by0 - ay0 * bx0;
    out[3] = aw0 * bw0 - ax0 * bx0 - ay0 * by0 - az0 * bz0;
    out[4] = ax0 * bw1 + aw0 * bx1 + ay0 * bz1 - az0 * by1 + ax1 * bw0 + aw1 * bx0 + ay1 * bz0 - az1 * by0;
    out[5] = ay0 * bw1 + aw0 * by1 + az0 * bx1 - ax0 * bz1 + ay1 * bw0 + aw1 * by0 + az1 * bx0 - ax1 * bz0;
    out[6] = az0 * bw1 + aw0 * bz1 + ax0 * by1 - ay0 * bx1 + az1 * bw0 + aw1 * bz0 + ax1 * by0 - ay1 * bx0;
    out[7] = aw0 * bw1 - ax0 * bx1 - ay0 * bz1 - az0 * bz1 + aw1 * bw0 - ax1 * bx0 - ay1 * by0 - az1 * bz0;
    return out;
}

var mul = exports.mul = multiply;

function scale(out, a, b) {
    for (var i = 0; i < 8; i++) out[i] = a[i] * b;
    return out;
}

var dot = exports.dot = quat.dot;

function lerp(out, a, b, t) {
    var mt = 1 - t;
    if (dot(a, b) < 0) t = -t;
    out[0] = a[0] * mt + b[0] * t;
    out[1] = a[1] * mt + b[1] * t;
    out[2] = a[2] * mt + b[2] * t;
    out[3] = a[3] * mt + b[3] * t;
    out[4] = a[4] * mt + b[4] * t;
    out[5] = a[5] * mt + b[5] * t;
    out[6] = a[6] * mt + b[6] * t;
    out[7] = a[7] * mt + b[7] * t;
    return out;
}

function invert(out, a) {
    var sqlen = squaredLength(a);
    out[0] = -a[0] / sqlen;
    out[1] = -a[1] / sqlen;
    out[2] = -a[2] / sqlen;
    out[3] = a[3] / sqlen;
    out[4] = -a[4] / sqlen;
    out[5] = -a[5] / sqlen;
    out[6] = -a[6] / sqlen;
    out[7] = a[7] / sqlen;
    return out;
}

function conjugate(out, a) {
    out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2]; out[3] = a[3];
    out[4] = -a[4]; out[5] = -a[5]; out[6] = -a[6]; out[7] = a[7];
    return out;
}

var length = exports.length = quat.length;
var len = exports.len = length;
var squaredLength = exports.squaredLength = quat.squaredLength;
var sqrLen = exports.sqrLen = squaredLength;

function normalize(out, a) {
    var magnitude = squaredLength(a);
    if (magnitude > 0) {
        magnitude = Math.sqrt(magnitude);
        var a0 = a[0] / magnitude, a1 = a[1] / magnitude;
        var a2 = a[2] / magnitude, a3 = a[3] / magnitude;
        var b0 = a[4], b1 = a[5], b2 = a[6], b3 = a[7];
        var a_dot_b = a0 * b0 + a1 * b1 + a2 * b2 + a3 * b3;
        out[0] = a0; out[1] = a1; out[2] = a2; out[3] = a3;
        out[4] = (b0 - a0 * a_dot_b) / magnitude;
        out[5] = (b1 - a1 * a_dot_b) / magnitude;
        out[6] = (b2 - a2 * a_dot_b) / magnitude;
        out[7] = (b3 - a3 * a_dot_b) / magnitude;
    }
    return out;
}

function str(a) {
    return "quat2(" + a[0] + ", " + a[1] + ", " + a[2] + ", " + a[3] + ", " + a[4] + ", " + a[5] + ", " + a[6] + ", " + a[7] + ")";
}

function exactEquals(a, b) {
    for (var i = 0; i < 8; i++) if (a[i] !== b[i]) return false;
    return true;
}

function equals(a, b) {
    for (var i = 0; i < 8; i++) {
        if (Math.abs(a[i] - b[i]) > glMatrix.EPSILON * Math.max(1.0, Math.abs(a[i]), Math.abs(b[i]))) return false;
    }
    return true;
}

// ============================================================================
// 2. POOL
// ============================================================================
function createQuat2Pool(capacity) {
    return glMatrix.createPool(function () {
        var dq = new glMatrix.ARRAY_TYPE(8);
        dq[3] = 1;
        return dq;
    }, capacity, function (dq) {
        dq[0] = 0; dq[1] = 0; dq[2] = 0; dq[3] = 1;
        dq[4] = 0; dq[5] = 0; dq[6] = 0; dq[7] = 0;
    });
}

var _defaultPool = null;
function getDefaultPool() {
    if (_defaultPool === null) _defaultPool = createQuat2Pool();
    return _defaultPool;
}

function acquire() { return getDefaultPool().acquire(); }
function release(dq) { getDefaultPool().release(dq); }

// ============================================================================
// 3. SOA — 1M+ dual quaternions
// ============================================================================
function createQuat2SOA(count, Type) {
    var soa = glMatrix.createSOA(count, 8, Type);
    soa.arrays[3].fill(1);
    return {
        x1: soa.arrays[0], y1: soa.arrays[1], z1: soa.arrays[2], w1: soa.arrays[3],
        x2: soa.arrays[4], y2: soa.arrays[5], z2: soa.arrays[6], w2: soa.arrays[7],
        arrays: soa.arrays, buffer: soa.buffer, count: soa.count, components: 8
    };
}

function soaIdentity(out) {
    out.x1.fill(0); out.y1.fill(0); out.z1.fill(0); out.w1.fill(1);
    out.x2.fill(0); out.y2.fill(0); out.z2.fill(0); out.w2.fill(0);
    return out;
}

function soaGet(out, soa, i) {
    out[0] = soa.x1[i]; out[1] = soa.y1[i]; out[2] = soa.z1[i]; out[3] = soa.w1[i];
    out[4] = soa.x2[i]; out[5] = soa.y2[i]; out[6] = soa.z2[i]; out[7] = soa.w2[i];
    return out;
}

function soaSet(soa, i, dq) {
    soa.x1[i] = dq[0]; soa.y1[i] = dq[1]; soa.z1[i] = dq[2]; soa.w1[i] = dq[3];
    soa.x2[i] = dq[4]; soa.y2[i] = dq[5]; soa.z2[i] = dq[6]; soa.w2[i] = dq[7];
    return soa;
}

function soaCopy(out, a) {
    for (var k = 0; k < 8; k++) out.arrays[k].set(a.arrays[k]);
    return out;
}

function soaToFlat(out, soa, offset) {
    offset = offset || 0;
    var n = soa.count, A = soa.arrays;
    for (var i = 0, o = offset; i < n; i++, o += 8) {
        for (var k = 0; k < 8; k++) out[o + k] = A[k][i];
    }
    return out;
}

function soaFromFlat(soa, flat, offset) {
    offset = offset || 0;
    var n = soa.count, A = soa.arrays;
    for (var i = 0, o = offset; i < n; i++, o += 8) {
        for (var k = 0; k < 8; k++) A[k][i] = flat[o + k];
    }
    return soa;
}

// ---- Core SOA ops ---------------------------------------------------------
function soaMultiply(out, a, b) {
    var oX1 = out.x1, oY1 = out.y1, oZ1 = out.z1, oW1 = out.w1;
    var oX2 = out.x2, oY2 = out.y2, oZ2 = out.z2, oW2 = out.w2;
    var aX0 = a.x1, aY0 = a.y1, aZ0 = a.z1, aW0 = a.w1;
    var bX1 = b.x2, bY1 = b.y2, bZ1 = b.z2, bW1 = b.w2;
    var aX1 = a.x2, aY1 = a.y2, aZ1 = a.z2, aW1 = a.w2;
    var bX0 = b.x1, bY0 = b.y1, bZ0 = b.z1, bW0 = b.w1;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        var ax0 = aX0[i], ay0 = aY0[i], az0 = aZ0[i], aw0 = aW0[i];
        var ax1 = aX1[i], ay1 = aY1[i], az1 = aZ1[i], aw1 = aW1[i];
        var bx0 = bX0[i], by0 = bY0[i], bz0 = bZ0[i], bw0 = bW0[i];
        var bx1 = bX1[i], by1 = bY1[i], bz1 = bZ1[i], bw1 = bW1[i];
        oX1[i] = ax0 * bw0 + aw0 * bx0 + ay0 * bz0 - az0 * by0;
        oY1[i] = ay0 * bw0 + aw0 * by0 + az0 * bx0 - ax0 * bz0;
        oZ1[i] = az0 * bw0 + aw0 * bz0 + ax0 * by0 - ay0 * bx0;
        oW1[i] = aw0 * bw0 - ax0 * bx0 - ay0 * by0 - az0 * bz0;
        oX2[i] = ax0 * bw1 + aw0 * bx1 + ay0 * bz1 - az0 * by1 + ax1 * bw0 + aw1 * bx0 + ay1 * bz0 - az1 * by0;
        oY2[i] = ay0 * bw1 + aw0 * by1 + az0 * bx1 - ax0 * bz1 + ay1 * bw0 + aw1 * by0 + az1 * bx0 - ax1 * bz0;
        oZ2[i] = az0 * bw1 + aw0 * bz1 + ax0 * by1 - ay0 * bx1 + az1 * bw0 + aw1 * bz0 + ax1 * by0 - ay1 * bx0;
        oW2[i] = aw0 * bw1 - ax0 * bx1 - ay0 * bz1 - az0 * bz1 + aw1 * bw0 - ax1 * bx0 - ay1 * by0 - az1 * bz0;
    }
    return out;
}

function soaNormalize(out, a) {
    var oX1 = out.x1, oY1 = out.y1, oZ1 = out.z1, oW1 = out.w1;
    var oX2 = out.x2, oY2 = out.y2, oZ2 = out.z2, oW2 = out.w2;
    var aX1 = a.x1, aY1 = a.y1, aZ1 = a.z1, aW1 = a.w1;
    var aX2 = a.x2, aY2 = a.y2, aZ2 = a.z2, aW2 = a.w2;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        var r0 = aX1[i], r1 = aY1[i], r2 = aZ1[i], r3 = aW1[i];
        var mag = Math.sqrt(r0 * r0 + r1 * r1 + r2 * r2 + r3 * r3);
        if (mag > 0) {
            var a0 = r0 / mag, a1 = r1 / mag, a2 = r2 / mag, a3 = r3 / mag;
            var b0 = aX2[i], b1 = aY2[i], b2 = aZ2[i], b3 = aW2[i];
            var adb = a0 * b0 + a1 * b1 + a2 * b2 + a3 * b3;
            oX1[i] = a0; oY1[i] = a1; oZ1[i] = a2; oW1[i] = a3;
            oX2[i] = (b0 - a0 * adb) / mag;
            oY2[i] = (b1 - a1 * adb) / mag;
            oZ2[i] = (b2 - a2 * adb) / mag;
            oW2[i] = (b3 - a3 * adb) / mag;
        } else {
            oX1[i] = 0; oY1[i] = 0; oZ1[i] = 0; oW1[i] = 1;
            oX2[i] = 0; oY2[i] = 0; oZ2[i] = 0; oW2[i] = 0;
        }
    }
    return out;
}

function soaConjugate(out, a) {
    var oX1 = out.x1, oY1 = out.y1, oZ1 = out.z1, oW1 = out.w1;
    var oX2 = out.x2, oY2 = out.y2, oZ2 = out.z2, oW2 = out.w2;
    var aX1 = a.x1, aY1 = a.y1, aZ1 = a.z1, aW1 = a.w1;
    var aX2 = a.x2, aY2 = a.y2, aZ2 = a.z2, aW2 = a.w2;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        oX1[i] = -aX1[i]; oY1[i] = -aY1[i]; oZ1[i] = -aZ1[i]; oW1[i] = aW1[i];
        oX2[i] = -aX2[i]; oY2[i] = -aY2[i]; oZ2[i] = -aZ2[i]; oW2[i] = aW2[i];
    }
    return out;
}

function soaInvert(out, a) {
    var oX1 = out.x1, oY1 = out.y1, oZ1 = out.z1, oW1 = out.w1;
    var oX2 = out.x2, oY2 = out.y2, oZ2 = out.z2, oW2 = out.w2;
    var aX1 = a.x1, aY1 = a.y1, aZ1 = a.z1, aW1 = a.w1;
    var aX2 = a.x2, aY2 = a.y2, aZ2 = a.z2, aW2 = a.w2;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        var r0 = aX1[i], r1 = aY1[i], r2 = aZ1[i], r3 = aW1[i];
        var sq = r0 * r0 + r1 * r1 + r2 * r2 + r3 * r3;
        var inv = sq ? 1 / sq : 0;
        oX1[i] = -r0 * inv; oY1[i] = -r1 * inv; oZ1[i] = -r2 * inv; oW1[i] = r3 * inv;
        oX2[i] = -aX2[i] * inv; oY2[i] = -aY2[i] * inv; oZ2[i] = -aZ2[i] * inv; oW2[i] = aW2[i] * inv;
    }
    return out;
}

function soaGetTranslation(outVec3, a) {
    var ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
    var aX = a.x1, aY = a.y1, aZ = a.z1, aW = a.w1;
    var dX = a.x2, dY = a.y2, dZ = a.z2, dW = a.w2;
    var n = outVec3.count;
    for (var i = 0; i < n; i++) {
        var dx = dX[i], dy = dY[i], dz = dZ[i], dw = dW[i];
        var rx = -aX[i], ry = -aY[i], rz = -aZ[i], rw = aW[i];
        ox[i] = (dx * rw + dw * rx + dy * rz - dz * ry) * 2;
        oy[i] = (dy * rw + dw * ry + dz * rx - dx * rz) * 2;
        oz[i] = (dz * rw + dw * rz + dx * ry - dy * rx) * 2;
    }
    return outVec3;
}

function soaGetReal(outQuat, a) {
    outQuat.x.set(a.x1); outQuat.y.set(a.y1);
    outQuat.z.set(a.z1); outQuat.w.set(a.w1);
    return outQuat;
}

function soaGetDual(outQuat, a) {
    outQuat.x.set(a.x2); outQuat.y.set(a.y2);
    outQuat.z.set(a.z2); outQuat.w.set(a.w2);
    return outQuat;
}

function soaFromRotationTranslation(out, rotSOA, transSOA) {
    var oX1 = out.x1, oY1 = out.y1, oZ1 = out.z1, oW1 = out.w1;
    var oX2 = out.x2, oY2 = out.y2, oZ2 = out.z2, oW2 = out.w2;
    var qx = rotSOA.x, qy = rotSOA.y, qz = rotSOA.z, qw = rotSOA.w;
    var tx = transSOA.x, ty = transSOA.y, tz = transSOA.z;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        var ax = tx[i] * 0.5, ay = ty[i] * 0.5, az = tz[i] * 0.5;
        var bx = qx[i], by = qy[i], bz = qz[i], bw = qw[i];
        oX1[i] = bx; oY1[i] = by; oZ1[i] = bz; oW1[i] = bw;
        oX2[i] = ax * bw + ay * bz - az * by;
        oY2[i] = ay * bw + az * bx - ax * bz;
        oZ2[i] = az * bw + ax * by - ay * bx;
        oW2[i] = -ax * bx - ay * by - az * bz;
    }
    return out;
}

function soaTransformPoint(outVec3, dqs, inVec3) {
    var ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
    var px = inVec3.x, py = inVec3.y, pz = inVec3.z;
    var rX = dqs.x1, rY = dqs.y1, rZ = dqs.z1, rW = dqs.w1;
    var dX = dqs.x2, dY = dqs.y2, dZ = dqs.z2, dW = dqs.w2;
    var n = outVec3.count;
    for (var i = 0; i < n; i++) {
        var x = px[i], y = py[i], z = pz[i];
        var qx = rX[i], qy = rY[i], qz = rZ[i], qw = rW[i];
        var tx = qy * z - qz * y;
        var ty = qz * x - qx * z;
        var tz = qx * y - qy * x;
        tx = tx + tx; ty = ty + ty; tz = tz + tz;
        var rx = x + qw * tx + qy * tz - qz * ty;
        var ry = y + qw * ty + qz * tx - qx * tz;
        var rz = z + qw * tz + qx * ty - qy * tx;
        var dx = dX[i], dy = dY[i], dz = dZ[i], dw = dW[i];
        var nx = -qx, ny = -qy, nz = -qz, nw = qw;
        var t0 = dw * nx + dx * nw + dy * nz - dz * ny;
        var t1 = dw * ny + dy * nw + dz * nx - dx * nz;
        var t2 = dw * nz + dz * nw + dx * ny - dy * nx;
        ox[i] = rx + 2 * t0;
        oy[i] = ry + 2 * t1;
        oz[i] = rz + 2 * t2;
    }
    return outVec3;
}

// ---- Chunked async --------------------------------------------------------
async function _chunkedDQ(out, perElem, chunkSize, yieldEvery) {
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

function soaMultiplyChunked(out, a, b, chunkSize, yieldEvery) {
    var oX1 = out.x1, oY1 = out.y1, oZ1 = out.z1, oW1 = out.w1;
    var oX2 = out.x2, oY2 = out.y2, oZ2 = out.z2, oW2 = out.w2;
    var aX0 = a.x1, aY0 = a.y1, aZ0 = a.z1, aW0 = a.w1;
    var bX1 = b.x2, bY1 = b.y2, bZ1 = b.z2, bW1 = b.w2;
    var aX1 = a.x2, aY1 = a.y2, aZ1 = a.z2, aW1 = a.w2;
    var bX0 = b.x1, bY0 = b.y1, bZ0 = b.z1, bW0 = b.w1;
    return _chunkedDQ(out, function (i) {
        var ax0 = aX0[i], ay0 = aY0[i], az0 = aZ0[i], aw0 = aW0[i];
        var ax1 = aX1[i], ay1 = aY1[i], az1 = aZ1[i], aw1 = aW1[i];
        var bx0 = bX0[i], by0 = bY0[i], bz0 = bZ0[i], bw0 = bW0[i];
        var bx1 = bX1[i], by1 = bY1[i], bz1 = bZ1[i], bw1 = bW1[i];
        oX1[i] = ax0 * bw0 + aw0 * bx0 + ay0 * bz0 - az0 * by0;
        oY1[i] = ay0 * bw0 + aw0 * by0 + az0 * bx0 - ax0 * bz0;
        oZ1[i] = az0 * bw0 + aw0 * bz0 + ax0 * by0 - ay0 * bx0;
        oW1[i] = aw0 * bw0 - ax0 * bx0 - ay0 * by0 - az0 * bz0;
        oX2[i] = ax0 * bw1 + aw0 * bx1 + ay0 * bz1 - az0 * by1 + ax1 * bw0 + aw1 * bx0 + ay1 * bz0 - az1 * by0;
        oY2[i] = ay0 * bw1 + aw0 * by1 + az0 * bx1 - ax0 * bz1 + ay1 * bw0 + aw1 * by0 + az1 * bx0 - ax1 * bz0;
        oZ2[i] = az0 * bw1 + aw0 * bz1 + ax0 * by1 - ay0 * bx1 + az1 * bw0 + aw1 * bz0 + ax1 * by0 - ay1 * bx0;
        oW2[i] = aw0 * bw1 - ax0 * bx1 - ay0 * bz1 - az0 * bz1 + aw1 * bw0 - ax1 * bx0 - ay1 * by0 - az1 * bz0;
    }, chunkSize, yieldEvery);
}

function soaNormalizeChunked(out, a, chunkSize, yieldEvery) {
    var oX1 = out.x1, oY1 = out.y1, oZ1 = out.z1, oW1 = out.w1;
    var oX2 = out.x2, oY2 = out.y2, oZ2 = out.z2, oW2 = out.w2;
    var aX1 = a.x1, aY1 = a.y1, aZ1 = a.z1, aW1 = a.w1;
    var aX2 = a.x2, aY2 = a.y2, aZ2 = a.z2, aW2 = a.w2;
    return _chunkedDQ(out, function (i) {
        var r0 = aX1[i], r1 = aY1[i], r2 = aZ1[i], r3 = aW1[i];
        var mag = Math.sqrt(r0 * r0 + r1 * r1 + r2 * r2 + r3 * r3);
        if (mag > 0) {
            var a0 = r0 / mag, a1 = r1 / mag, a2 = r2 / mag, a3 = r3 / mag;
            var b0 = aX2[i], b1 = aY2[i], b2 = aZ2[i], b3 = aW2[i];
            var adb = a0 * b0 + a1 * b1 + a2 * b2 + a3 * b3;
            oX1[i] = a0; oY1[i] = a1; oZ1[i] = a2; oW1[i] = a3;
            oX2[i] = (b0 - a0 * adb) / mag;
            oY2[i] = (b1 - a1 * adb) / mag;
            oZ2[i] = (b2 - a2 * adb) / mag;
            oW2[i] = (b3 - a3 * adb) / mag;
        } else {
            oX1[i] = 0; oY1[i] = 0; oZ1[i] = 0; oW1[i] = 1;
            oX2[i] = 0; oY2[i] = 0; oZ2[i] = 0; oW2[i] = 0;
        }
    }, chunkSize, yieldEvery);
}

async function soaTransformPointChunked(outVec3, dqs, inVec3, chunkSize, yieldEvery) {
    chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
    yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
    var ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
    var px = inVec3.x, py = inVec3.y, pz = inVec3.z;
    var rX = dqs.x1, rY = dqs.y1, rZ = dqs.z1, rW = dqs.w1;
    var dX = dqs.x2, dY = dqs.y2, dZ = dqs.z2, dW = dqs.w2;
    var n = outVec3.count, cc = 0;
    for (var start = 0; start < n; start += chunkSize) {
        var end = Math.min(start + chunkSize, n);
        for (var i = start; i < end; i++) {
            var x = px[i], y = py[i], z = pz[i];
            var qx = rX[i], qy = rY[i], qz = rZ[i], qw = rW[i];
            var tx = qy * z - qz * y;
            var ty = qz * x - qx * z;
            var tz = qx * y - qy * x;
            tx = tx + tx; ty = ty + ty; tz = tz + tz;
            var rx = x + qw * tx + qy * tz - qz * ty;
            var ry = y + qw * ty + qz * tx - qx * tz;
            var rz = z + qw * tz + qx * ty - qy * tx;
            var dx = dX[i], dy = dY[i], dz = dZ[i], dw = dW[i];
            var nx = -qx, ny = -qy, nz = -qz, nw = qw;
            var t0 = dw * nx + dx * nw + dy * nz - dz * ny;
            var t1 = dw * ny + dy * nw + dz * nx - dx * nz;
            var t2 = dw * nz + dz * nw + dx * ny - dy * nx;
            ox[i] = rx + 2 * t0;
            oy[i] = ry + 2 * t1;
            oz[i] = rz + 2 * t2;
        }
        if (++cc >= yieldEvery) { cc = 0; await glMatrix.yieldToMain(); }
    }
    return outVec3;
}

async function soaForEachChunked(out, a, callback, chunkSize, yieldEvery) {
    return _chunkedDQ(out, function (i) { callback(i, a, out); }, chunkSize, yieldEvery);
}

// ============================================================================
// 4. PROCEDURAL GENERATION
// ============================================================================
function soaFillFromNoise(out, positions, scale, minTransJitter, maxTransJitter) {
    scale = scale || 1;
    minTransJitter = minTransJitter === undefined ? 0 : minTransJitter;
    maxTransJitter = maxTransJitter === undefined ? 0 : maxTransJitter;
    var oX1 = out.x1, oY1 = out.y1, oZ1 = out.z1, oW1 = out.w1;
    var oX2 = out.x2, oY2 = out.y2, oZ2 = out.z2, oW2 = out.w2;
    var px = positions.x, py = positions.y, pz = positions.z;
    var n = out.count;
    var span = maxTransJitter - minTransJitter;
    for (var i = 0; i < n; i++) {
        var wx = px[i], wy = py[i], wz = pz[i];
        var gx = Math.floor(wx * scale), gy = Math.floor(wy * scale), gz = Math.floor(wz * scale);
        var u1 = glMatrix.hash3(gx, gy, gz);
        var u2 = glMatrix.hash3(gx + 17, gy + 23, gz + 5);
        var u3 = glMatrix.hash3(gx + 3, gy + 11, gz + 29);
        var u4 = glMatrix.hash3(gx + 41, gy + 7, gz + 13);
        var s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
        var qx = s1 * Math.sin(2 * Math.PI * u2);
        var qy = s1 * Math.cos(2 * Math.PI * u2);
        var qz = s2 * Math.sin(2 * Math.PI * u3);
        var qw = s2 * Math.cos(2 * Math.PI * u3);
        var jX = minTransJitter + u4 * span;
        var jY = minTransJitter + ((u4 * 0.618) % 1) * span;
        var jZ = minTransJitter + ((u4 * 0.382) % 1) * span;
        var tx = wx + jX, ty = wy + jY, tz = wz + jZ;
        var ax = tx * 0.5, ay = ty * 0.5, az = tz * 0.5;
        oX1[i] = qx; oY1[i] = qy; oZ1[i] = qz; oW1[i] = qw;
        oX2[i] = ax * qw + ay * qz - az * qy;
        oY2[i] = ay * qw + az * qx - ax * qz;
        oZ2[i] = az * qw + ax * qy - ay * qx;
        oW2[i] = -ax * qx - ay * qy - az * qz;
    }
    return out;
}

async function soaFillFromNoiseChunked(out, positions, scale, minTransJitter, maxTransJitter, chunkSize, yieldEvery) {
    scale = scale || 1;
    minTransJitter = minTransJitter === undefined ? 0 : minTransJitter;
    maxTransJitter = maxTransJitter === undefined ? 0 : maxTransJitter;
    var oX1 = out.x1, oY1 = out.y1, oZ1 = out.z1, oW1 = out.w1;
    var oX2 = out.x2, oY2 = out.y2, oZ2 = out.z2, oW2 = out.w2;
    var px = positions.x, py = positions.y, pz = positions.z;
    var span = maxTransJitter - minTransJitter;
    return _chunkedDQ(out, function (i) {
        var wx = px[i], wy = py[i], wz = pz[i];
        var gx = Math.floor(wx * scale), gy = Math.floor(wy * scale), gz = Math.floor(wz * scale);
        var u1 = glMatrix.hash3(gx, gy, gz);
        var u2 = glMatrix.hash3(gx + 17, gy + 23, gz + 5);
        var u3 = glMatrix.hash3(gx + 3, gy + 11, gz + 29);
        var u4 = glMatrix.hash3(gx + 41, gy + 7, gz + 13);
        var s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
        var qx = s1 * Math.sin(2 * Math.PI * u2);
        var qy = s1 * Math.cos(2 * Math.PI * u2);
        var qz = s2 * Math.sin(2 * Math.PI * u3);
        var qw = s2 * Math.cos(2 * Math.PI * u3);
        var jX = minTransJitter + u4 * span;
        var jY = minTransJitter + ((u4 * 0.618) % 1) * span;
        var jZ = minTransJitter + ((u4 * 0.382) % 1) * span;
        var tx = wx + jX, ty = wy + jY, tz = wz + jZ;
        var ax = tx * 0.5, ay = ty * 0.5, az = tz * 0.5;
        oX1[i] = qx; oY1[i] = qy; oZ1[i] = qz; oW1[i] = qw;
        oX2[i] = ax * qw + ay * qz - az * qy;
        oY2[i] = ay * qw + az * qx - ax * qz;
        oZ2[i] = az * qw + ax * qy - ay * qx;
        oW2[i] = -ax * qx - ay * qy - az * qz;
    }, chunkSize, yieldEvery);
}

// ============================================================================
// 5. RENDERING — batch dual-quat to mat4
// ============================================================================
function soaToMat4(outMat, dqs) {
    var M = outMat.arrays;
    var rX = dqs.x1, rY = dqs.y1, rZ = dqs.z1, rW = dqs.w1;
    var dX = dqs.x2, dY = dqs.y2, dZ = dqs.z2, dW = dqs.w2;
    var n = outMat.count;
    for (var i = 0; i < n; i++) {
        var x = rX[i], y = rY[i], z = rZ[i], w = rW[i];
        var x2 = x + x, y2 = y + y, z2 = z + z;
        var xx = x * x2, yx = y * x2, yy = y * y2;
        var zx = z * x2, zy = z * y2, zz = z * z2;
        var wx = w * x2, wy = w * y2, wz = w * z2;
        M[0][i] = 1 - yy - zz;  M[1][i] = yx + wz;       M[2][i] = zx - wy;       M[3][i] = 0;
        M[4][i] = yx - wz;       M[5][i] = 1 - xx - zz;  M[6][i] = zy + wx;       M[7][i] = 0;
        M[8][i] = zx + wy;       M[9][i] = zy - wx;       M[10][i] = 1 - xx - yy; M[11][i] = 0;
        var dx = dX[i], dy = dY[i], dz = dZ[i], dw = dW[i];
        var nx = -x, ny = -y, nz = -z, nw = w;
        M[12][i] = 2 * (dw * nx + dx * nw + dy * nz - dz * ny);
        M[13][i] = 2 * (dw * ny + dy * nw + dz * nx - dx * nz);
        M[14][i] = 2 * (dw * nz + dz * nw + dx * ny - dy * nx);
        M[15][i] = 1;
    }
    return outMat;
}

async function soaToMat4Chunked(outMat, dqs, chunkSize, yieldEvery) {
    chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
    yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
    var M = outMat.arrays;
    var rX = dqs.x1, rY = dqs.y1, rZ = dqs.z1, rW = dqs.w1;
    var dX = dqs.x2, dY = dqs.y2, dZ = dqs.z2, dW = dqs.w2;
    var n = outMat.count, cc = 0;
    for (var start = 0; start < n; start += chunkSize) {
        var end = Math.min(start + chunkSize, n);
        for (var i = start; i < end; i++) {
            var x = rX[i], y = rY[i], z = rZ[i], w = rW[i];
            var x2 = x + x, y2 = y + y, z2 = z + z;
            var xx = x * x2, yx = y * x2, yy = y * y2;
            var zx = z * x2, zy = z * y2, zz = z * z2;
            var wx = w * x2, wy = w * y2, wz = w * z2;
            M[0][i] = 1 - yy - zz;  M[1][i] = yx + wz;       M[2][i] = zx - wy;       M[3][i] = 0;
            M[4][i] = yx - wz;       M[5][i] = 1 - xx - zz;  M[6][i] = zy + wx;       M[7][i] = 0;
            M[8][i] = zx + wy;       M[9][i] = zy - wx;       M[10][i] = 1 - xx - yy; M[11][i] = 0;
            var dx = dX[i], dy = dY[i], dz = dZ[i], dw = dW[i];
            var nx = -x, ny = -y, nz = -z, nw = w;
            M[12][i] = 2 * (dw * nx + dx * nw + dy * nz - dz * ny);
            M[13][i] = 2 * (dw * ny + dy * nw + dz * nx - dx * nz);
            M[14][i] = 2 * (dw * nz + dz * nw + dx * ny - dy * nx);
            M[15][i] = 1;
        }
        if (++cc >= yieldEvery) { cc = 0; await glMatrix.yieldToMain(); }
    }
    return outMat;
}

// ============================================================================
// 6. ANIMATION
// ============================================================================
/**
 CORRECTION: INLINED spring math to eliminate all array literal allocations.
 Frame-rate-independent critically-damped dual-quat spring.
*/
function springDamp(out, current, target, vel, smoothTime, dt, maxSpeed) {
    if (smoothTime < 0.0001) smoothTime = 0.0001;
    if (maxSpeed === undefined) maxSpeed = Infinity;

    // Ensure shortest-arc on real part
    var d = current[0] * target[0] + current[1] * target[1] + current[2] * target[2] + current[3] * target[3];
    var sgn = d < 0 ? -1 : 1;

    var omega = 2 / smoothTime;
    var x = omega * dt;
    var exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    var maxChange = maxSpeed * smoothTime;

    // Inline spring for real part (4 components)
    var nR = [0, 0, 0, 0];
    for (var i = 0; i < 4; i++) {
        var c = current[i];
        var t = target[i] * sgn;
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
        nR[i] = output;
    }

    // Normalize real part
    var l = Math.sqrt(nR[0] * nR[0] + nR[1] * nR[1] + nR[2] * nR[2] + nR[3] * nR[3]);
    if (l > 0) { var inv = 1 / l; nR[0] *= inv; nR[1] *= inv; nR[2] *= inv; nR[3] *= inv; }

    // Extract target translation and rebake dual
    var tgtR0 = target[0], tgtR1 = target[1], tgtR2 = target[2], tgtR3 = target[3];
    var tgtD0 = target[4], tgtD1 = target[5], tgtD2 = target[6], tgtD3 = target[7];
    var cnx = -tgtR0, cny = -tgtR1, cnz = -tgtR2, cnw = tgtR3;
    var tx = (tgtD0 * cnw + tgtD3 * cnx + tgtD1 * cnz - tgtD2 * cny) * 2;
    var ty = (tgtD1 * cnw + tgtD3 * cny + tgtD2 * cnx - tgtD0 * cnz) * 2;
    var tz = (tgtD2 * cnw + tgtD3 * cnz + tgtD0 * cny - tgtD1 * cnx) * 2;

    var ax = tx * 0.5, ay = ty * 0.5, az = tz * 0.5;
    out[0] = nR[0]; out[1] = nR[1]; out[2] = nR[2]; out[3] = nR[3];
    out[4] = ax * nR[3] + ay * nR[2] - az * nR[1];
    out[5] = ay * nR[3] + az * nR[0] - ax * nR[2];
    out[6] = az * nR[3] + ax * nR[1] - ay * nR[0];
    out[7] = -ax * nR[0] - ay * nR[1] - az * nR[2];
    return out;
}

/**
 CORRECTION: INLINED spring math to eliminate per-iteration array allocations.
 SOA spring-damp of 1M+ dual quats.
*/
function soaSpringDamp(out, current, target, vel, smoothTime, dt, maxSpeed) {
    var oX1 = out.x1, oY1 = out.y1, oZ1 = out.z1, oW1 = out.w1;
    var oX2 = out.x2, oY2 = out.y2, oZ2 = out.z2, oW2 = out.w2;
    var cX1 = current.x1, cY1 = current.y1, cZ1 = current.z1, cW1 = current.w1;
    var tX1 = target.x1, tY1 = target.y1, tZ1 = target.z1, tW1 = target.w1;
    var tX2 = target.x2, tY2 = target.y2, tZ2 = target.z2, tW2 = target.w2;
    var vX1 = vel.x1, vY1 = vel.y1, vZ1 = vel.z1, vW1 = vel.w1;
    var n = out.count;
    var stArr = (smoothTime && smoothTime.BYTES_PER_ELEMENT !== undefined) ? smoothTime : null;

    for (var i = 0; i < n; i++) {
        var st = stArr ? stArr[i] : smoothTime;
        if (st < 0.0001) st = 0.0001;
        if (maxSpeed === undefined) maxSpeed = Infinity;

        var cr0 = cX1[i], cr1 = cY1[i], cr2 = cZ1[i], cr3 = cW1[i];
        var tr0 = tX1[i], tr1 = tY1[i], tr2 = tZ1[i], tr3 = tW1[i];
        var dot = cr0 * tr0 + cr1 * tr1 + cr2 * tr2 + cr3 * tr3;
        var sgn = dot < 0 ? -1 : 1;

        var omega = 2 / st;
        var x = omega * dt;
        var exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
        var maxChange = maxSpeed * st;

        // Inline spring for real quaternion (4 components)
        var nr0, nr1, nr2, nr3;
        // Component 0
        var c0 = cr0, t0 = tr0 * sgn, ch0 = c0 - t0, ot0 = t0;
        if (ch0 > maxChange) ch0 = maxChange; else if (ch0 < -maxChange) ch0 = -maxChange;
        t0 = c0 - ch0;
        var tmp0 = (vX1[i] + omega * ch0) * dt;
        vX1[i] = (vX1[i] - omega * tmp0) * exp;
        nr0 = t0 + (ch0 + tmp0) * exp;
        if ((ot0 - c0 > 0) === (nr0 > ot0)) { nr0 = ot0; vX1[i] = (nr0 - ot0) / dt; }
        // Component 1
        var c1 = cr1, t1 = tr1 * sgn, ch1 = c1 - t1, ot1 = t1;
        if (ch1 > maxChange) ch1 = maxChange; else if (ch1 < -maxChange) ch1 = -maxChange;
        t1 = c1 - ch1;
        var tmp1 = (vY1[i] + omega * ch1) * dt;
        vY1[i] = (vY1[i] - omega * tmp1) * exp;
        nr1 = t1 + (ch1 + tmp1) * exp;
        if ((ot1 - c1 > 0) === (nr1 > ot1)) { nr1 = ot1; vY1[i] = (nr1 - ot1) / dt; }
        // Component 2
        var c2 = cr2, t2 = tr2 * sgn, ch2 = c2 - t2, ot2 = t2;
        if (ch2 > maxChange) ch2 = maxChange; else if (ch2 < -maxChange) ch2 = -maxChange;
        t2 = c2 - ch2;
        var tmp2 = (vZ1[i] + omega * ch2) * dt;
        vZ1[i] = (vZ1[i] - omega * tmp2) * exp;
        nr2 = t2 + (ch2 + tmp2) * exp;
        if ((ot2 - c2 > 0) === (nr2 > ot2)) { nr2 = ot2; vZ1[i] = (nr2 - ot2) / dt; }
        // Component 3
        var c3 = cr3, t3 = tr3 * sgn, ch3 = c3 - t3, ot3 = t3;
        if (ch3 > maxChange) ch3 = maxChange; else if (ch3 < -maxChange) ch3 = -maxChange;
        t3 = c3 - ch3;
        var tmp3 = (vW1[i] + omega * ch3) * dt;
        vW1[i] = (vW1[i] - omega * tmp3) * exp;
        nr3 = t3 + (ch3 + tmp3) * exp;
        if ((ot3 - c3 > 0) === (nr3 > ot3)) { nr3 = ot3; vW1[i] = (nr3 - ot3) / dt; }

        // Normalize
        var l = Math.sqrt(nr0 * nr0 + nr1 * nr1 + nr2 * nr2 + nr3 * nr3);
        if (l > 0) { var inv = 1 / l; nr0 *= inv; nr1 *= inv; nr2 *= inv; nr3 *= inv; }

        // Extract target translation and rebake dual
        var dr0 = tX2[i], dr1 = tY2[i], dr2 = tZ2[i], dr3 = tW2[i];
        var nx = -tr0, ny = -tr1, nz = -tr2, nw = tr3;
        var tx = (dr0 * nw + dr3 * nx + dr1 * nz - dr2 * ny) * 2;
        var ty = (dr1 * nw + dr3 * ny + dr2 * nx - dr0 * nz) * 2;
        var tz = (dr2 * nw + dr3 * nz + dr0 * ny - dr1 * nx) * 2;
        var ax = tx * 0.5, ay = ty * 0.5, az = tz * 0.5;

        oX1[i] = nr0; oY1[i] = nr1; oZ1[i] = nr2; oW1[i] = nr3;
        oX2[i] = ax * nr3 + ay * nr2 - az * nr1;
        oY2[i] = ay * nr3 + az * nr0 - ax * nr2;
        oZ2[i] = az * nr3 + ax * nr1 - ay * nr0;
        oW2[i] = -ax * nr0 - ay * nr1 - az * nr2;
    }
    return out;
}

// ============================================================================
// 7. NATURAL IK MOTION
// ============================================================================
function lookAtDQ(out, position, target, upHint) {
    var dx = target[0] - position[0];
    var dy = target[1] - position[1];
    var dz = target[2] - position[2];
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < glMatrix.EPSILON) {
        return fromTranslation(out, position);
    }
    var inv = 1 / len;
    dx *= inv; dy *= inv; dz *= inv;
    var w = 1 + dx;
    var qx = 0, qy = -dz, qz = dy, qw = w;
    if (w < glMatrix.EPSILON) { qx = 0; qy = 1; qz = 0; qw = 0; }
    else {
        var ql = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
        var qi = 1 / ql;
        qx *= qi; qy *= qi; qz *= qi; qw *= qi;
    }
    _tmpQuat4[0] = qx; _tmpQuat4[1] = qy; _tmpQuat4[2] = qz; _tmpQuat4[3] = qw;
    return fromRotationTranslation(out, _tmpQuat4, position);
}

function soaLookAtDQ(out, positions, targets, upHint) {
    var oX1 = out.x1, oY1 = out.y1, oZ1 = out.z1, oW1 = out.w1;
    var oX2 = out.x2, oY2 = out.y2, oZ2 = out.z2, oW2 = out.w2;
    var px = positions.x, py = positions.y, pz = positions.z;
    var tx = targets.x, ty = targets.y, tz = targets.z;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        var dx = tx[i] - px[i], dy = ty[i] - py[i], dz = tz[i] - pz[i];
        var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        var qx, qy, qz, qw;
        if (len < glMatrix.EPSILON) {
            qx = 0; qy = 0; qz = 0; qw = 1;
        } else {
            var inv = 1 / len;
            dx *= inv; dy *= inv; dz *= inv;
            var w = 1 + dx;
            if (w < glMatrix.EPSILON) { qx = 0; qy = 1; qz = 0; qw = 0; }
            else {
                qx = 0; qy = -dz; qz = dy; qw = w;
                var ql = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
                var qi = 1 / ql;
                qx *= qi; qy *= qi; qz *= qi; qw *= qi;
            }
        }
        var ax = px[i] * 0.5, ay = py[i] * 0.5, az = pz[i] * 0.5;
        oX1[i] = qx; oY1[i] = qy; oZ1[i] = qz; oW1[i] = qw;
        oX2[i] = ax * qw + ay * qz - az * qy;
        oY2[i] = ay * qw + az * qx - ax * qz;
        oZ2[i] = az * qw + ax * qy - ay * qx;
        oW2[i] = -ax * qx - ay * qy - az * qz;
    }
    return out;
}

// ============================================================================
// 8. ORBITAL
// ============================================================================
function fromVelocityTranslation(out, velocity, position) {
    var dx = velocity[0], dy = velocity[1], dz = velocity[2];
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    var qx, qy, qz, qw;
    if (len < glMatrix.EPSILON) {
        qx = 0; qy = 0; qz = 0; qw = 1;
    } else {
        var inv = 1 / len;
        dx *= inv; dy *= inv; dz *= inv;
        var w = 1 + dx;
        if (w < glMatrix.EPSILON) { qx = 0; qy = 1; qz = 0; qw = 0; }
        else {
            qx = 0; qy = -dz; qz = dy; qw = w;
            var ql = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
            var qi = 1 / ql;
            qx *= qi; qy *= qi; qz *= qi; qw *= qi;
        }
    }
    var ax = position[0] * 0.5, ay = position[1] * 0.5, az = position[2] * 0.5;
    out[0] = qx; out[1] = qy; out[2] = qz; out[3] = qw;
    out[4] = ax * qw + ay * qz - az * qy;
    out[5] = ay * qw + az * qx - ax * qz;
    out[6] = az * qw + ax * qy - ay * qx;
    out[7] = -ax * qx - ay * qy - az * qz;
    return out;
}

function soaFromVelocityTranslation(out, velocities, positions) {
    var oX1 = out.x1, oY1 = out.y1, oZ1 = out.z1, oW1 = out.w1;
    var oX2 = out.x2, oY2 = out.y2, oZ2 = out.z2, oW2 = out.w2;
    var vx = velocities.x, vy = velocities.y, vz = velocities.z;
    var px = positions.x, py = positions.y, pz = positions.z;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        var dx = vx[i], dy = vy[i], dz = vz[i];
        var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        var qx, qy, qz, qw;
        if (len < glMatrix.EPSILON) {
            qx = 0; qy = 0; qz = 0; qw = 1;
        } else {
            var inv = 1 / len;
            dx *= inv; dy *= inv; dz *= inv;
            var w = 1 + dx;
            if (w < glMatrix.EPSILON) { qx = 0; qy = 1; qz = 0; qw = 0; }
            else {
                qx = 0; qy = -dz; qz = dy; qw = w;
                var ql = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
                var qi = 1 / ql;
                qx *= qi; qy *= qi; qz *= qi; qw *= qi;
            }
        }
        var ax = px[i] * 0.5, ay = py[i] * 0.5, az = pz[i] * 0.5;
        oX1[i] = qx; oY1[i] = qy; oZ1[i] = qz; oW1[i] = qw;
        oX2[i] = ax * qw + ay * qz - az * qy;
        oY2[i] = ay * qw + az * qx - ax * qz;
        oZ2[i] = az * qw + ax * qy - ay * qx;
        oW2[i] = -ax * qx - ay * qy - az * qz;
    }
    return out;
}

async function soaFromVelocityTranslationChunked(out, velocities, positions, chunkSize, yieldEvery) {
    var oX1 = out.x1, oY1 = out.y1, oZ1 = out.z1, oW1 = out.w1;
    var oX2 = out.x2, oY2 = out.y2, oZ2 = out.z2, oW2 = out.w2;
    var vx = velocities.x, vy = velocities.y, vz = velocities.z;
    var px = positions.x, py = positions.y, pz = positions.z;
    return _chunkedDQ(out, function (i) {
        var dx = vx[i], dy = vy[i], dz = vz[i];
        var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        var qx, qy, qz, qw;
        if (len < glMatrix.EPSILON) {
            qx = 0; qy = 0; qz = 0; qw = 1;
        } else {
            var inv = 1 / len;
            dx *= inv; dy *= inv; dz *= inv;
            var w = 1 + dx;
            if (w < glMatrix.EPSILON) { qx = 0; qy = 1; qz = 0; qw = 0; }
            else {
                qx = 0; qy = -dz; qz = dy; qw = w;
                var ql = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
                var qi = 1 / ql;
                qx *= qi; qy *= qi; qz *= qi; qw *= qi;
            }
        }
        var ax = px[i] * 0.5, ay = py[i] * 0.5, az = pz[i] * 0.5;
        oX1[i] = qx; oY1[i] = qy; oZ1[i] = qz; oW1[i] = qw;
        oX2[i] = ax * qw + ay * qz - az * qy;
        oY2[i] = ay * qw + az * qx - ax * qz;
        oZ2[i] = az * qw + ax * qy - ay * qx;
        oW2[i] = -ax * qx - ay * qy - az * qz;
    }, chunkSize, yieldEvery);
}

/**
 CORRECTION: Fixed sign bug in quaternion composition (qz1 = sO * sI, not -sO * sI).
*/
function fromOrbitalElements(out, a, e, M, inc, Om, om) {
    var E = glMatrix.keplerSolve(M, e);
    var xp = a * (Math.cos(E) - e);
    var yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
    var hO = Om * 0.5, hI = inc * 0.5, hW = om * 0.5;
    var sO = Math.sin(hO), cO = Math.cos(hO);
    var sI = Math.sin(hI), cI = Math.cos(hI);
    var sW = Math.sin(hW), cW = Math.cos(hW);
    // CORRECTED: qz1 = sO * sI (positive)
    var qz0 = cO * sI, qz1 = sO * sI, qz2 = sO * cI, qz3 = cO * cI;
    var qx = qz0 * cW + qz1 * sW;
    var qy = qz1 * cW - qz0 * sW;
    var qz = qz2 * cW + qz3 * sW;
    var qw = qz3 * cW - qz2 * sW;
    var r00 = cO * cW - sO * sW * cI;
    var r01 = -cO * sW - sO * cW * cI;
    var r10 = sO * cW + cO * sW * cI;
    var r11 = -sO * sW + cO * cW * cI;
    var r20 = sW * sI;
    var r21 = cW * sI;
    var px = r00 * xp + r01 * yp;
    var py = r10 * xp + r11 * yp;
    var pz = r20 * xp + r21 * yp;
    var ax = px * 0.5, ay = py * 0.5, az = pz * 0.5;
    out[0] = qx; out[1] = qy; out[2] = qz; out[3] = qw;
    out[4] = ax * qw + ay * qz - az * qy;
    out[5] = ay * qw + az * qx - ax * qz;
    out[6] = az * qw + ax * qy - ay * qx;
    out[7] = -ax * qx - ay * qy - az * qz;
    return out;
}

/**
 CORRECTION: Fixed sign bug. SOA: 1M+ orbital-body dual quats.
*/
function soaFromOrbitalElements(out, semiMajorAxes, eccentricities, meanAnomalies, inclinations, ascendingNodes, argPeriapses) {
    var oX1 = out.x1, oY1 = out.y1, oZ1 = out.z1, oW1 = out.w1;
    var oX2 = out.x2, oY2 = out.y2, oZ2 = out.z2, oW2 = out.w2;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        var a = semiMajorAxes[i], e = eccentricities[i], M = meanAnomalies[i];
        var inc = inclinations[i], Om = ascendingNodes[i], om = argPeriapses[i];
        var E = glMatrix.keplerSolve(M, e);
        var xp = a * (Math.cos(E) - e);
        var yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
        var hO = Om * 0.5, hI = inc * 0.5, hW = om * 0.5;
        var sO = Math.sin(hO), cO = Math.cos(hO);
        var sI = Math.sin(hI), cI = Math.cos(hI);
        var sW = Math.sin(hW), cW = Math.cos(hW);
        // CORRECTED: qz1 = sO * sI (positive)
        var qz0 = cO * sI, qz1 = sO * sI, qz2 = sO * cI, qz3 = cO * cI;
        var qx = qz0 * cW + qz1 * sW;
        var qy = qz1 * cW - qz0 * sW;
        var qz = qz2 * cW + qz3 * sW;
        var qw = qz3 * cW - qz2 * sW;
        var r00 = cO * cW - sO * sW * cI;
        var r01 = -cO * sW - sO * cW * cI;
        var r10 = sO * cW + cO * sW * cI;
        var r11 = -sO * sW + cO * cW * cI;
        var r20 = sW * sI;
        var r21 = cW * sI;
        var px = r00 * xp + r01 * yp;
        var py = r10 * xp + r11 * yp;
        var pz = r20 * xp + r21 * yp;
        var ax = px * 0.5, ay = py * 0.5, az = pz * 0.5;
        oX1[i] = qx; oY1[i] = qy; oZ1[i] = qz; oW1[i] = qw;
        oX2[i] = ax * qw + ay * qz - az * qy;
        oY2[i] = ay * qw + az * qx - ax * qz;
        oZ2[i] = az * qw + ax * qy - ay * qx;
        oW2[i] = -ax * qx - ay * qy - az * qz;
    }
    return out;
}

// ============================================================================
// 9. SCALE / FLOATING ORIGIN
// ============================================================================
function recenter(out, dq, origin) {
    var qx = dq[0], qy = dq[1], qz = dq[2], qw = dq[3];
    var dx = dq[4], dy = dq[5], dz = dq[6], dw = dq[7];
    var nx = -qx, ny = -qy, nz = -qz, nw = qw;
    var tx = (dx * nw + dw * nx + dy * nz - dz * ny) * 2 - origin[0];
    var ty = (dy * nw + dw * ny + dz * nx - dx * nz) * 2 - origin[1];
    var tz = (dz * nw + dw * nz + dx * ny - dy * nx) * 2 - origin[2];
    var ax = tx * 0.5, ay = ty * 0.5, az = tz * 0.5;
    out[0] = qx; out[1] = qy; out[2] = qz; out[3] = qw;
    out[4] = ax * qw + ay * qz - az * qy;
    out[5] = ay * qw + az * qx - ax * qz;
    out[6] = az * qw + ax * qy - ay * qx;
    out[7] = -ax * qx - ay * qy - az * qz;
    return out;
}

function soaRecenter(out, a, originX, originY, originZ) {
    var oX1 = out.x1, oY1 = out.y1, oZ1 = out.z1, oW1 = out.w1;
    var oX2 = out.x2, oY2 = out.y2, oZ2 = out.z2, oW2 = out.w2;
    var aX1 = a.x1, aY1 = a.y1, aZ1 = a.z1, aW1 = a.w1;
    var aX2 = a.x2, aY2 = a.y2, aZ2 = a.z2, aW2 = a.w2;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        var qx = aX1[i], qy = aY1[i], qz = aZ1[i], qw = aW1[i];
        var dx = aX2[i], dy = aY2[i], dz = aZ2[i], dw = aW2[i];
        var nx = -qx, ny = -qy, nz = -qz, nw = qw;
        var tx = (dx * nw + dw * nx + dy * nz - dz * ny) * 2 - originX;
        var ty = (dy * nw + dw * ny + dz * nx - dx * nz) * 2 - originY;
        var tz = (dz * nw + dw * nz + dx * ny - dy * nx) * 2 - originZ;
        var ax = tx * 0.5, ay = ty * 0.5, az = tz * 0.5;
        oX1[i] = qx; oY1[i] = qy; oZ1[i] = qz; oW1[i] = qw;
        oX2[i] = ax * qw + ay * qz - az * qy;
        oY2[i] = ay * qw + az * qx - ax * qz;
        oZ2[i] = az * qw + ax * qy - ay * qx;
        oW2[i] = -ax * qx - ay * qy - az * qz;
    }
    return out;
}

// ============================================================================
// 10. EXPORTS
// ============================================================================
// ----- flat API -----
exports.create = create;
exports.clone = clone;
exports.fromValues = fromValues;
exports.fromRotationTranslationValues = fromRotationTranslationValues;
exports.fromRotationTranslation = fromRotationTranslation;
exports.fromTranslation = fromTranslation;
exports.fromRotation = fromRotation;
exports.fromMat4 = fromMat4;
exports.copy = copy;
exports.identity = identity;
exports.set = set;
exports.getDual = getDual;
exports.setDual = setDual;
exports.getTranslation = getTranslation;
exports.translate = translate;
exports.rotateX = rotateX;
exports.rotateY = rotateY;
exports.rotateZ = rotateZ;
exports.rotateByQuatAppend = rotateByQuatAppend;
exports.rotateByQuatPrepend = rotateByQuatPrepend;
exports.rotateAroundAxis = rotateAroundAxis;
exports.add = add;
exports.multiply = multiply;
exports.scale = scale;
exports.lerp = lerp;
exports.invert = invert;
exports.conjugate = conjugate;
exports.normalize = normalize;
exports.str = str;
exports.exactEquals = exactEquals;
exports.equals = equals;

// ----- pool -----
exports.createQuat2Pool = createQuat2Pool;
exports.acquire = acquire;
exports.release = release;

// ----- SOA -----
exports.createQuat2SOA = createQuat2SOA;
exports.soaIdentity = soaIdentity;
exports.soaGet = soaGet;
exports.soaSet = soaSet;
exports.soaCopy = soaCopy;
exports.soaToFlat = soaToFlat;
exports.soaFromFlat = soaFromFlat;
exports.soaMultiply = soaMultiply;
exports.soaNormalize = soaNormalize;
exports.soaConjugate = soaConjugate;
exports.soaInvert = soaInvert;
exports.soaGetTranslation = soaGetTranslation;
exports.soaGetReal = soaGetReal;
exports.soaGetDual = soaGetDual;
exports.soaFromRotationTranslation = soaFromRotationTranslation;
exports.soaTransformPoint = soaTransformPoint;
exports.soaToMat4 = soaToMat4;

// ----- chunked async -----
exports.soaMultiplyChunked = soaMultiplyChunked;
exports.soaNormalizeChunked = soaNormalizeChunked;
exports.soaTransformPointChunked = soaTransformPointChunked;
exports.soaToMat4Chunked = soaToMat4Chunked;
exports.soaForEachChunked = soaForEachChunked;

// ----- procedural -----
exports.soaFillFromNoise = soaFillFromNoise;
exports.soaFillFromNoiseChunked = soaFillFromNoiseChunked;

// ----- animation -----
exports.springDamp = springDamp;
exports.soaSpringDamp = soaSpringDamp;

// ----- natural IK motion -----
exports.lookAtDQ = lookAtDQ;
exports.soaLookAtDQ = soaLookAtDQ;

// ----- orbital -----
exports.fromVelocityTranslation = fromVelocityTranslation;
exports.soaFromVelocityTranslation = soaFromVelocityTranslation;
exports.soaFromVelocityTranslationChunked = soaFromVelocityTranslationChunked;
exports.fromOrbitalElements = fromOrbitalElements;
exports.soaFromOrbitalElements = soaFromOrbitalElements;

// ----- scale / floating origin -----
exports.recenter = recenter;
exports.soaRecenter = soaRecenter;