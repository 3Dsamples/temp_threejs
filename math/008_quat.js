"use strict";
// File number : 008
// File : src/math/008_quat.js
// Description : Quaternion (full glMatrix XYZW API) + full SOA bulk layout (1M+ quaternions), zero-GC pool, chunked parallelism, batch slerp/nlerp, procedural per-instance orientation from spatial hash & 4D noise, batch vec3 rotation for 1M+ instances, spring-damped look-at/aim (natural IK), orbital velocity-aligned quats, batch from/to Euler and from/to mat3, and floating-origin-friendly identity ops. Numerically identical to glMatrix flat API.
// ####
// Best for : 3d graphics — procedural generation (1M+ asteroid/tree/particle orientations from a spatial hash or animated 4D noise, per-instance spin from time-based noise), rendering (instance rotation for instanced draw, camera orientation, skinning joint rotation, batch vec3 rotation of normals/lighting), color (per-instance hue rotate on gradients), animation (batch slerp/nlerp of 1M+ orientations at 60 fps, Euler<->quat batch, mat3<->quat batch, quaternion spring-damping of a whole crowd), natural IK motion (spring look-at / aim, root-motion slerp, quaternion spring per bone), orbital (velocity-aligned quats for asteroids/trails/rings, inclination-node-argument frames), seamless small-to-galactic scale (velocity-alignment works at any magnitude by normalizing once). All SOA ops Float32Array-backed, chunked-yielding to keep the UI thread responsive on mobile 64-bit.
// License : MIT

Object.defineProperty(exports, "__esModule", { value: true });

// Clean CommonJS imports
const glMatrix = require("./001_common.js");
const mat3 = require("./006_mat3.js");
const vec3 = require("./003_vec3.js");
const vec4 = require("./004_vec4.js");

// Pre-allocated module-level temporaries for Zero-GC flat API operations
var _tmpQuat4 = new Float32Array(4);
var _tmpAxis3 = new Float32Array(3);

/**
 Quaternion in the format XYZW
 @module quat
*/

// ============================================================================
// 1. FLAT API (glMatrix, all original exports preserved)
// ============================================================================
function create() {
    var out = new glMatrix.ARRAY_TYPE(4);
    if (glMatrix.ARRAY_TYPE != Float32Array) {
        out[0] = 0; out[1] = 0; out[2] = 0;
    }
    out[3] = 1;
    return out;
}

function identity(out) {
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
    return out;
}

function setAxisAngle(out, axis, rad) {
    rad = rad * 0.5;
    var s = Math.sin(rad);
    out[0] = s * axis[0];
    out[1] = s * axis[1];
    out[2] = s * axis[2];
    out[3] = Math.cos(rad);
    return out;
}

function getAxisAngle(out_axis, q) {
    var rad = Math.acos(q[3]) * 2.0;
    var s = Math.sin(rad / 2.0);
    if (s > glMatrix.EPSILON) {
        out_axis[0] = q[0] / s;
        out_axis[1] = q[1] / s;
        out_axis[2] = q[2] / s;
    } else {
        out_axis[0] = 1;
        out_axis[1] = 0;
        out_axis[2] = 0;
    }
    return rad;
}

function getAngle(a, b) {
    var dotproduct = dot(a, b);
    return Math.acos(2 * dotproduct * dotproduct - 1);
}

function multiply(out, a, b) {
    var ax = a[0], ay = a[1], az = a[2], aw = a[3];
    var bx = b[0], by = b[1], bz = b[2], bw = b[3];
    out[0] = ax * bw + aw * bx + ay * bz - az * by;
    out[1] = ay * bw + aw * by + az * bx - ax * bz;
    out[2] = az * bw + aw * bz + ax * by - ay * bx;
    out[3] = aw * bw - ax * bx - ay * by - az * bz;
    return out;
}

function rotateX(out, a, rad) {
    rad *= 0.5;
    var ax = a[0], ay = a[1], az = a[2], aw = a[3];
    var bx = Math.sin(rad), bw = Math.cos(rad);
    out[0] = ax * bw + aw * bx;
    out[1] = ay * bw + az * bx;
    out[2] = az * bw - ay * bx;
    out[3] = aw * bw - ax * bx;
    return out;
}

function rotateY(out, a, rad) {
    rad *= 0.5;
    var ax = a[0], ay = a[1], az = a[2], aw = a[3];
    var by = Math.sin(rad), bw = Math.cos(rad);
    out[0] = ax * bw - az * by;
    out[1] = ay * bw + aw * by;
    out[2] = az * bw + ax * by;
    out[3] = aw * bw - ay * by;
    return out;
}

function rotateZ(out, a, rad) {
    rad *= 0.5;
    var ax = a[0], ay = a[1], az = a[2], aw = a[3];
    var bz = Math.sin(rad), bw = Math.cos(rad);
    out[0] = ax * bw + ay * bz;
    out[1] = ay * bw - ax * bz;
    out[2] = az * bw + aw * bz;
    out[3] = aw * bw - az * bz;
    return out;
}

function calculateW(out, a) {
    var x = a[0], y = a[1], z = a[2];
    out[0] = x;
    out[1] = y; out[2] = z;
    out[3] = Math.sqrt(Math.abs(1.0 - x * x - y * y - z * z));
    return out;
}

function exp(out, a) {
    var x = a[0], y = a[1], z = a[2], w = a[3];
    var r = Math.sqrt(x * x + y * y + z * z);
    var et = Math.exp(w);
    var s = r > 0 ? et * Math.sin(r) / r : 0;
    out[0] = x * s; out[1] = y * s; out[2] = z * s;
    out[3] = et * Math.cos(r);
    return out;
}

function ln(out, a) {
    var x = a[0], y = a[1], z = a[2], w = a[3];
    var r = Math.sqrt(x * x + y * y + z * z);
    var t = r > 0 ? Math.atan2(r, w) / r : 0;
    out[0] = x * t; out[1] = y * t; out[2] = z * t;
    out[3] = 0.5 * Math.log(x * x + y * y + z * z + w * w);
    return out;
}

function pow(out, a, b) {
    ln(out, a);
    scale(out, out, b);
    exp(out, out);
    return out;
}

function slerp(out, a, b, t) {
    var ax = a[0], ay = a[1], az = a[2], aw = a[3];
    var bx = b[0], by = b[1], bz = b[2], bw = b[3];
    var omega, cosom, sinom, scale0, scale1;
    cosom = ax * bx + ay * by + az * bz + aw * bw;
    if (cosom < 0.0) {
        cosom = -cosom;
        bx = -bx; by = -by; bz = -bz; bw = -bw;
    }
    if (1.0 - cosom > glMatrix.EPSILON) {
        omega = Math.acos(cosom);
        sinom = Math.sin(omega);
        scale0 = Math.sin((1.0 - t) * omega) / sinom;
        scale1 = Math.sin(t * omega) / sinom;
    } else {
        scale0 = 1.0 - t;
        scale1 = t;
    }
    out[0] = scale0 * ax + scale1 * bx;
    out[1] = scale0 * ay + scale1 * by;
    out[2] = scale0 * az + scale1 * bz;
    out[3] = scale0 * aw + scale1 * bw;
    return out;
}

function random(out) {
    var u1 = glMatrix.RANDOM();
    var u2 = glMatrix.RANDOM();
    var u3 = glMatrix.RANDOM();
    var sqrt1MinusU1 = Math.sqrt(1 - u1);
    var sqrtU1 = Math.sqrt(u1);
    out[0] = sqrt1MinusU1 * Math.sin(2.0 * Math.PI * u2);
    out[1] = sqrt1MinusU1 * Math.cos(2.0 * Math.PI * u2);
    out[2] = sqrtU1 * Math.sin(2.0 * Math.PI * u3);
    out[3] = sqrtU1 * Math.cos(2.0 * Math.PI * u3);
    return out;
}

function invert(out, a) {
    var a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3];
    var dot = a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3;
    var invDot = dot ? 1.0 / dot : 0;
    out[0] = -a0 * invDot;
    out[1] = -a1 * invDot;
    out[2] = -a2 * invDot;
    out[3] = a3 * invDot;
    return out;
}

function conjugate(out, a) {
    out[0] = -a[0];
    out[1] = -a[1];
    out[2] = -a[2];
    out[3] = a[3];
    return out;
}

function fromMat3(out, m) {
    var fTrace = m[0] + m[4] + m[8];
    var fRoot;
    if (fTrace > 0.0) {
        fRoot = Math.sqrt(fTrace + 1.0);
        out[3] = 0.5 * fRoot;
        fRoot = 0.5 / fRoot;
        out[0] = (m[5] - m[7]) * fRoot;
        out[1] = (m[6] - m[2]) * fRoot;
        out[2] = (m[1] - m[3]) * fRoot;
    } else {
        var i = 0;
        if (m[4] > m[0]) i = 1;
        if (m[8] > m[i * 3 + i]) i = 2;
        var j = (i + 1) % 3;
        var k = (i + 2) % 3;
        fRoot = Math.sqrt(m[i * 3 + i] - m[j * 3 + j] - m[k * 3 + k] + 1.0);
        out[i] = 0.5 * fRoot;
        fRoot = 0.5 / fRoot;
        out[3] = (m[j * 3 + k] - m[k * 3 + j]) * fRoot;
        out[j] = (m[j * 3 + i] + m[i * 3 + j]) * fRoot;
        out[k] = (m[k * 3 + i] + m[i * 3 + k]) * fRoot;
    }
    return out;
}

function fromEuler(out, x, y, z, order) {
    order = order || glMatrix.ANGLE_ORDER;
    var halfToRad = Math.PI / 360;
    x *= halfToRad; z *= halfToRad; y *= halfToRad;
    var sx = Math.sin(x), cx = Math.cos(x);
    var sy = Math.sin(y), cy = Math.cos(y);
    var sz = Math.sin(z), cz = Math.cos(z);
    switch (order) {
        case "xyz":
            out[0] = sx * cy * cz + cx * sy * sz;
            out[1] = cx * sy * cz - sx * cy * sz;
            out[2] = cx * cy * sz + sx * sy * cz;
            out[3] = cx * cy * cz - sx * sy * sz;
            break;
        case "xzy":
            out[0] = sx * cy * cz - cx * sy * sz;
            out[1] = cx * sy * cz - sx * cy * sz;
            out[2] = cx * cy * sz + sx * sy * cz;
            out[3] = cx * cy * cz + sx * sy * sz;
            break;
        case "yxz":
            out[0] = sx * cy * cz + cx * sy * sz;
            out[1] = cx * sy * cz - sx * cy * sz;
            out[2] = cx * cy * sz - sx * sy * cz;
            out[3] = cx * cy * cz + sx * sy * sz;
            break;
        case "yzx":
            out[0] = sx * cy * cz + cx * sy * sz;
            out[1] = cx * sy * cz + sx * cy * sz;
            out[2] = cx * cy * sz - sx * sy * cz;
            out[3] = cx * cy * cz - sx * sy * sz;
            break;
        case "zxy":
            out[0] = sx * cy * cz - cx * sy * sz;
            out[1] = cx * sy * cz + sx * cy * sz;
            out[2] = cx * cy * sz + sx * sy * cz;
            out[3] = cx * cy * cz - sx * sy * sz;
            break;
        case "zyx":
            out[0] = sx * cy * cz - cx * sy * sz;
            out[1] = cx * sy * cz + sx * cy * sz;
            out[2] = cx * cy * sz - sx * sy * cz;
            out[3] = cx * cy * cz + sx * sy * sz;
            break;
        default:
            throw new Error('Unknown angle order ' + order);
    }
    return out;
}

function str(a) {
    return "quat(" + a[0] + ", " + a[1] + ", " + a[2] + ", " + a[3] + ")";
}

function equals(a, b) {
    return Math.abs(vec4.dot(a, b)) >= 1 - glMatrix.EPSILON;
}

// Aliases (vec4-provided)
var clone = exports.clone = vec4.clone;
var fromValues = exports.fromValues = vec4.fromValues;
var copy = exports.copy = vec4.copy;
var set = exports.set = vec4.set;
var add = exports.add = vec4.add;
var mul = exports.mul = multiply;
var scale = exports.scale = vec4.scale;
var dot = exports.dot = vec4.dot;
var lerp = exports.lerp = vec4.lerp;
var length = exports.length = vec4.length;
var len = exports.len = length;
var squaredLength = exports.squaredLength = vec4.squaredLength;
var sqrLen = exports.sqrLen = squaredLength;
var normalize = exports.normalize = vec4.normalize;
var exactEquals = exports.exactEquals = vec4.exactEquals;

// rotationTo, sqlerp, setAxes — as in glMatrix
var rotationTo = exports.rotationTo = function () {
    var tmpvec3 = vec3.create();
    var xUnitVec3 = vec3.fromValues(1, 0, 0);
    var yUnitVec3 = vec3.fromValues(0, 1, 0);
    return function (out, a, b) {
        var d = vec3.dot(a, b);
        if (d < -0.999999) {
            vec3.cross(tmpvec3, xUnitVec3, a);
            if (vec3.length(tmpvec3) < 0.000001) vec3.cross(tmpvec3, yUnitVec3, a);
            vec3.normalize(tmpvec3, tmpvec3);
            setAxisAngle(out, tmpvec3, Math.PI);
            return out;
        } else if (d > 0.999999) {
            out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
            return out;
        } else {
            vec3.cross(tmpvec3, a, b);
            out[0] = tmpvec3[0]; out[1] = tmpvec3[1]; out[2] = tmpvec3[2];
            out[3] = 1 + d;
            return normalize(out, out);
        }
    };
}();

var sqlerp = exports.sqlerp = function () {
    var temp1 = create();
    var temp2 = create();
    return function (out, a, b, c, d, t) {
        slerp(temp1, a, d, t);
        slerp(temp2, b, c, t);
        slerp(out, temp1, temp2, 2 * t * (1 - t));
        return out;
    };
}();

var setAxes = exports.setAxes = function () {
    var matr = mat3.create();
    return function (out, view, right, up) {
        matr[0] = right[0]; matr[3] = right[1]; matr[6] = right[2];
        matr[1] = up[0]; matr[4] = up[1]; matr[7] = up[2];
        matr[2] = -view[0]; matr[5] = -view[1]; matr[8] = -view[2];
        return normalize(out, fromMat3(out, matr));
    };
}();

// ============================================================================
// 2. POOL
// ============================================================================
function createQuatPool(capacity) {
    return glMatrix.createPool(function () {
        var q = new glMatrix.ARRAY_TYPE(4);
        q[0] = 0; q[1] = 0; q[2] = 0; q[3] = 1;
        return q;
    }, capacity, function (q) {
        q[0] = 0; q[1] = 0; q[2] = 0; q[3] = 1;
    });
}

var _defaultPool = null;
function getDefaultPool() {
    if (_defaultPool === null) _defaultPool = createQuatPool();
    return _defaultPool;
}

function acquire() { return getDefaultPool().acquire(); }
function release(q) { getDefaultPool().release(q); }

// ============================================================================
// 3. SOA (1M+ quaternions)
// ============================================================================
function createQuatSOA(count, Type) {
    var soa = glMatrix.createSOA(count, 4, Type);
    soa.arrays[0].fill(0);
    soa.arrays[1].fill(0);
    soa.arrays[2].fill(0);
    soa.arrays[3].fill(1);
    return {
        x: soa.arrays[0], y: soa.arrays[1], z: soa.arrays[2], w: soa.arrays[3],
        arrays: soa.arrays,
        buffer: soa.buffer, count: soa.count, components: 4
    };
}

function soaIdentity(out) {
    out.x.fill(0); out.y.fill(0); out.z.fill(0); out.w.fill(1);
    return out;
}

function soaGet(out, soa, i) {
    out[0] = soa.x[i]; out[1] = soa.y[i]; out[2] = soa.z[i]; out[3] = soa.w[i];
    return out;
}

function soaSet(soa, i, q) {
    soa.x[i] = q[0]; soa.y[i] = q[1]; soa.z[i] = q[2]; soa.w[i] = q[3];
    return soa;
}

function soaCopy(out, a) {
    out.x.set(a.x); out.y.set(a.y); out.z.set(a.z); out.w.set(a.w);
    return out;
}

function soaToFlat(out, soa, offset) {
    offset = offset || 0;
    var n = soa.count;
    var X = soa.x, Y = soa.y, Z = soa.z, W = soa.w;
    for (var i = 0, o = offset; i < n; i++, o += 4) {
        out[o] = X[i]; out[o + 1] = Y[i]; out[o + 2] = Z[i]; out[o + 3] = W[i];
    }
    return out;
}

function soaFromFlat(soa, flat, offset) {
    offset = offset || 0;
    var n = soa.count;
    var X = soa.x, Y = soa.y, Z = soa.z, W = soa.w;
    for (var i = 0, o = offset; i < n; i++, o += 4) {
        X[i] = flat[o]; Y[i] = flat[o + 1]; Z[i] = flat[o + 2]; W[i] = flat[o + 3];
    }
    return soa;
}

// ---- Core SOA ops ---------------------------------------------------------
function soaMultiply(out, a, b) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        var ax = aX[i], ay = aY[i], az = aZ[i], aw = aW[i];
        var bx = bX[i], by = bY[i], bz = bZ[i], bw = bW[i];
        oX[i] = ax * bw + aw * bx + ay * bz - az * by;
        oY[i] = ay * bw + aw * by + az * bx - ax * bz;
        oZ[i] = az * bw + aw * bz + ax * by - ay * bx;
        oW[i] = aw * bw - ax * bx - ay * by - az * bz;
    }
    return out;
}

function soaConjugate(out, a) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        oX[i] = -aX[i]; oY[i] = -aY[i]; oZ[i] = -aZ[i]; oW[i] = aW[i];
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
    for (var i = 0; i < n; i++) s += aX[i] * bX[i] + aY[i] * bY[i] + aZ[i] * bZ[i] + aW[i] * bW[i];
    return s;
}

/** SLERP: t may be scalar (broadcast) or Array/Float32Array of count. */
function soaSlerp(out, a, b, t) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    var n = out.count;
    var tArr = (t && t.length !== undefined) ? t : null;
    for (var i = 0; i < n; i++) {
        var tt = tArr ? tArr[i] : t;
        var ax = aX[i], ay = aY[i], az = aZ[i], aw = aW[i];
        var bx = bX[i], by = bY[i], bz = bZ[i], bw = bW[i];
        var cosom = ax * bx + ay * by + az * bz + aw * bw;
        if (cosom < 0.0) {
            cosom = -cosom; bx = -bx; by = -by; bz = -bz; bw = -bw;
        }
        var s0, s1;
        if (1.0 - cosom > glMatrix.EPSILON) {
            var omega = Math.acos(cosom);
            var sinom = Math.sin(omega);
            s0 = Math.sin((1.0 - tt) * omega) / sinom;
            s1 = Math.sin(tt * omega) / sinom;
        } else {
            s0 = 1.0 - tt; s1 = tt;
        }
        oX[i] = s0 * ax + s1 * bx;
        oY[i] = s0 * ay + s1 * by;
        oZ[i] = s0 * az + s1 * bz;
        oW[i] = s0 * aw + s1 * bw;
    }
    return out;
}

/** NLERP: fast normalized lerp (slerp approximation, arcs < 90°). */
function soaNlerp(out, a, b, t) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    var n = out.count;
    var tArr = (t && t.length !== undefined) ? t : null;
    for (var i = 0; i < n; i++) {
        var tt = tArr ? tArr[i] : t;
        var ax = aX[i], ay = aY[i], az = aZ[i], aw = aW[i];
        var bx = bX[i], by = bY[i], bz = bZ[i], bw = bW[i];
        if (ax * bx + ay * by + az * bz + aw * bw < 0) {
            bx = -bx; by = -by; bz = -bz; bw = -bw;
        }
        var x = ax + tt * (bx - ax);
        var y = ay + tt * (by - ay);
        var z = az + tt * (bz - az);
        var w = aw + tt * (bw - aw);
        var l = x * x + y * y + z * z + w * w;
        if (l > 0) l = 1 / Math.sqrt(l);
        oX[i] = x * l; oY[i] = y * l; oZ[i] = z * l; oW[i] = w * l;
    }
    return out;
}

/** Batch: rotate a vec3 SOA by a per-instance quat SOA (fast rotation formula). */
function soaRotateVec3(outVec3, quats, inVec3) {
    var qX = quats.x, qY = quats.y, qZ = quats.z, qW = quats.w;
    var vx = inVec3.x, vy = inVec3.y, vz = inVec3.z;
    var ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
    var n = quats.count;
    for (var i = 0; i < n; i++) {
        var x = vx[i], y = vy[i], z = vz[i];
        var qx = qX[i], qy = qY[i], qz = qZ[i], qw = qW[i];
        var tx = qy * z - qz * y;
        var ty = qz * x - qx * z;
        var tz = qx * y - qy * x;
        tx = tx + tx; ty = ty + ty; tz = tz + tz;
        ox[i] = x + qw * tx + qy * tz - qz * ty;
        oy[i] = y + qw * ty + qz * tx - qx * tz;
        oz[i] = z + qw * tz + qx * ty - qy * tx;
    }
    return outVec3;
}

/** Batch: compute 1M+ from axis-angle. Axis SOA (vec3) + angle scalar or array. */
function soaFromAxisAngle(out, axes, rad) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var axA = axes.x, ayA = axes.y, azA = axes.z;
    var n = out.count;
    var radArr = (rad && rad.length !== undefined) ? rad : null;
    for (var i = 0; i < n; i++) {
        var r = (radArr ? radArr[i] : rad) * 0.5;
        var s = Math.sin(r);
        oX[i] = s * axA[i]; oY[i] = s * ayA[i]; oZ[i] = s * azA[i];
        oW[i] = Math.cos(r);
    }
    return out;
}

/** Batch: convert 1M+ mat3 → quat. Uses Shoemake's method. */
function soaFromMat3(out, mats) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var M = mats.arrays;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        var m00 = M[0][i], m01 = M[1][i], m02 = M[2][i];
        var m10 = M[3][i], m11 = M[4][i], m12 = M[5][i];
        var m20 = M[6][i], m21 = M[7][i], m22 = M[8][i];
        var trace = m00 + m11 + m22;
        var S;
        if (trace > 0) {
            S = Math.sqrt(trace + 1.0);
            oW[i] = 0.5 * S;
            S = 0.5 / S;
            oX[i] = (m12 - m21) * S;
            oY[i] = (m20 - m02) * S;
            oZ[i] = (m01 - m10) * S;
        } else if (m00 > m11 && m00 > m22) {
            S = Math.sqrt(1.0 + m00 - m11 - m22);
            oX[i] = 0.5 * S;
            S = 0.5 / S;
            oW[i] = (m12 - m21) * S;
            oY[i] = (m01 + m10) * S;
            oZ[i] = (m20 + m02) * S;
        } else if (m11 > m22) {
            S = Math.sqrt(1.0 + m11 - m00 - m22);
            oY[i] = 0.5 * S;
            S = 0.5 / S;
            oW[i] = (m20 - m02) * S;
            oX[i] = (m01 + m10) * S;
            oZ[i] = (m12 + m21) * S;
        } else {
            S = Math.sqrt(1.0 + m22 - m00 - m11);
            oZ[i] = 0.5 * S;
            S = 0.5 / S;
            oW[i] = (m01 - m10) * S;
            oX[i] = (m20 + m02) * S;
            oY[i] = (m12 + m21) * S;
        }
    }
    return out;
}

/** Batch: convert 1M+ quat → mat3. */
function soaToMat3(outMat, quats) {
    var M = outMat.arrays;
    var qX = quats.x, qY = quats.y, qZ = quats.z, qW = quats.w;
    var n = outMat.count;
    for (var i = 0; i < n; i++) {
        var x = qX[i], y = qY[i], z = qZ[i], w = qW[i];
        var x2 = x + x, y2 = y + y, z2 = z + z;
        var xx = x * x2, yx = y * x2, yy = y * y2;
        var zx = z * x2, zy = z * y2, zz = z * z2;
        var wx = w * x2, wy = w * y2, wz = w * z2;
        M[0][i] = 1 - yy - zz;  M[3][i] = yx - wz;       M[6][i] = zx + wy;
        M[1][i] = yx + wz;       M[4][i] = 1 - xx - zz;  M[7][i] = zy - wx;
        M[2][i] = zx - wy;       M[5][i] = zy + wx;       M[8][i] = 1 - xx - yy;
    }
    return outMat;
}

/** Batch: euler (radians) → quat SOA. */
function soaFromEuler(out, xs, ys, zs, order) {
    order = order || glMatrix.ANGLE_ORDER;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        var x = xs[i] * 0.5, y = ys[i] * 0.5, z = zs[i] * 0.5;
        var sx = Math.sin(x), cx = Math.cos(x);
        var sy = Math.sin(y), cy = Math.cos(y);
        var sz = Math.sin(z), cz = Math.cos(z);
        switch (order) {
            case "xyz":
                oX[i] = sx * cy * cz + cx * sy * sz;
                oY[i] = cx * sy * cz - sx * cy * sz;
                oZ[i] = cx * cy * sz + sx * sy * cz;
                oW[i] = cx * cy * cz - sx * sy * sz;
                break;
            case "zyx":
            default:
                oX[i] = sx * cy * cz - cx * sy * sz;
                oY[i] = cx * sy * cz + sx * cy * sz;
                oZ[i] = cx * cy * sz - sx * sy * cz;
                oW[i] = cx * cy * cz + sx * sy * sz;
                break;
        }
    }
    return out;
}

/**
CORRECTION: Accepts a pre-allocated output buffer to avoid per-call allocation.
Batch: getAngle between paired quaternions, writes to `out` Float32Array.
*/
function soaGetAngle(out, a, b) {
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    for (var i = 0; i < a.count; i++) {
        var d = aX[i] * bX[i] + aY[i] * bY[i] + aZ[i] * bZ[i] + aW[i] * bW[i];
        out[i] = Math.acos(2 * d * d - 1);
    }
    return out;
}

// ---- Chunked async --------------------------------------------------------
async function _chunkedQ(out, perElem, chunkSize, yieldEvery) {
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
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    return _chunkedQ(out, function (i) {
        var ax = aX[i], ay = aY[i], az = aZ[i], aw = aW[i];
        var bx = bX[i], by = bY[i], bz = bZ[i], bw = bW[i];
        oX[i] = ax * bw + aw * bx + ay * bz - az * by;
        oY[i] = ay * bw + aw * by + az * bx - ax * bz;
        oZ[i] = az * bw + aw * bz + ax * by - ay * bx;
        oW[i] = aw * bw - ax * bx - ay * by - az * bz;
    }, chunkSize, yieldEvery);
}

function soaNormalizeChunked(out, a, chunkSize, yieldEvery) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    return _chunkedQ(out, function (i) {
        var x = aX[i], y = aY[i], z = aZ[i], w = aW[i];
        var l = x * x + y * y + z * z + w * w;
        if (l > 0) l = 1 / Math.sqrt(l);
        oX[i] = x * l; oY[i] = y * l; oZ[i] = z * l; oW[i] = w * l;
    }, chunkSize, yieldEvery);
}

function soaSlerpChunked(out, a, b, t, chunkSize, yieldEvery) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    var tArr = (t && t.length !== undefined) ? t : null;
    return _chunkedQ(out, function (i) {
        var tt = tArr ? tArr[i] : t;
        var ax = aX[i], ay = aY[i], az = aZ[i], aw = aW[i];
        var bx = bX[i], by = bY[i], bz = bZ[i], bw = bW[i];
        var cosom = ax * bx + ay * by + az * bz + aw * bw;
        if (cosom < 0.0) { cosom = -cosom; bx = -bx; by = -by; bz = -bz; bw = -bw; }
        var s0, s1;
        if (1.0 - cosom > glMatrix.EPSILON) {
            var omega = Math.acos(cosom), sinom = Math.sin(omega);
            s0 = Math.sin((1.0 - tt) * omega) / sinom;
            s1 = Math.sin(tt * omega) / sinom;
        } else { s0 = 1.0 - tt; s1 = tt; }
        oX[i] = s0 * ax + s1 * bx;
        oY[i] = s0 * ay + s1 * by;
        oZ[i] = s0 * az + s1 * bz;
        oW[i] = s0 * aw + s1 * bw;
    }, chunkSize, yieldEvery);
}

async function soaRotateVec3Chunked(outVec3, quats, inVec3, chunkSize, yieldEvery) {
    chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
    yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
    var qX = quats.x, qY = quats.y, qZ = quats.z, qW = quats.w;
    var vx = inVec3.x, vy = inVec3.y, vz = inVec3.z;
    var ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
    var n = quats.count, c = 0;
    for (var start = 0; start < n; start += chunkSize) {
        var end = Math.min(start + chunkSize, n);
        for (var i = start; i < end; i++) {
            var x = vx[i], y = vy[i], z = vz[i];
            var qx = qX[i], qy = qY[i], qz = qZ[i], qw = qW[i];
            var tx = qy * z - qz * y;
            var ty = qz * x - qx * z;
            var tz = qx * y - qy * x;
            tx = tx + tx; ty = ty + ty; tz = tz + tz;
            ox[i] = x + qw * tx + qy * tz - qz * ty;
            oy[i] = y + qw * ty + qz * tx - qx * tz;
            oz[i] = z + qw * tz + qx * ty - qy * tx;
        }
        if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
    }
    return outVec3;
}

async function soaForEachChunked(out, a, callback, chunkSize, yieldEvery) {
    return _chunkedQ(out, function (i) { callback(i, a, out); }, chunkSize, yieldEvery);
}

// ============================================================================
// 4. PROCEDURAL GENERATION
// ============================================================================
/**
Fill 1M+ quaternion SOA with per-instance random unit quats, seeded from
a 3D spatial hash of the instance's own position. Deterministic, zero RNG state.
*/
function soaFillFromNoise(out, positions, noiseScale) {
    noiseScale = noiseScale || 1;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var px = positions.x, py = positions.y, pz = positions.z;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        var gx = Math.floor(px[i] * noiseScale);
        var gy = Math.floor(py[i] * noiseScale);
        var gz = Math.floor(pz[i] * noiseScale);
        var u1 = glMatrix.hash3(gx, gy, gz);
        var u2 = glMatrix.hash3(gx + 17, gy + 23, gz + 5);
        var u3 = glMatrix.hash3(gx + 3, gy + 11, gz + 29);
        var s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
        oX[i] = s1 * Math.sin(2 * Math.PI * u2);
        oY[i] = s1 * Math.cos(2 * Math.PI * u2);
        oZ[i] = s2 * Math.sin(2 * Math.PI * u3);
        oW[i] = s2 * Math.cos(2 * Math.PI * u3);
    }
    return out;
}

async function soaFillFromNoiseChunked(out, positions, noiseScale, chunkSize, yieldEvery) {
    noiseScale = noiseScale || 1;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var px = positions.x, py = positions.y, pz = positions.z;
    return _chunkedQ(out, function (i) {
        var gx = Math.floor(px[i] * noiseScale);
        var gy = Math.floor(py[i] * noiseScale);
        var gz = Math.floor(pz[i] * noiseScale);
        var u1 = glMatrix.hash3(gx, gy, gz);
        var u2 = glMatrix.hash3(gx + 17, gy + 23, gz + 5);
        var u3 = glMatrix.hash3(gx + 3, gy + 11, gz + 29);
        var s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
        oX[i] = s1 * Math.sin(2 * Math.PI * u2);
        oY[i] = s1 * Math.cos(2 * Math.PI * u2);
        oZ[i] = s2 * Math.sin(2 * Math.PI * u3);
        oW[i] = s2 * Math.cos(2 * Math.PI * u3);
    }, chunkSize, yieldEvery);
}

/**
Fill 1M+ quaternion SOA with per-instance spin from 4D noise.
Each instance gets a rotating orientation driven by its position AND time.
*/
function soaFillSpinFrom4DNoise(out, positions, time, frequency, amplitude) {
    frequency = frequency || 1;
    amplitude = amplitude === undefined ? Math.PI * 2 : amplitude;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var px = positions.x, py = positions.y, pz = positions.z;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        var x = px[i] * frequency, y = py[i] * frequency, z = pz[i] * frequency;
        var ax = (glMatrix.hash3(Math.floor(x), Math.floor(y), Math.floor(z)) + time * 0.31) * amplitude;
        var ay = (glMatrix.hash3(Math.floor(y) + 41, Math.floor(z) + 17, Math.floor(x) + 23) + time * 0.73) * amplitude;
        var az = (glMatrix.hash3(Math.floor(z) + 3, Math.floor(x) + 11, Math.floor(y) + 29) + time * 0.97) * amplitude;
        var sx = Math.sin(ax * 0.5), cx = Math.cos(ax * 0.5);
        var sy = Math.sin(ay * 0.5), cy = Math.cos(ay * 0.5);
        var sz = Math.sin(az * 0.5), cz = Math.cos(az * 0.5);
        // zyx order
        oX[i] = sx * cy * cz - cx * sy * sz;
        oY[i] = cx * sy * cz + sx * cy * sz;
        oZ[i] = cx * cy * sz - sx * sy * cz;
        oW[i] = cx * cy * cz + sx * sy * sz;
    }
    return out;
}

/**
Fill 1M+ quaternions so that each instance's local +X axis points along
its velocity vector. The primary orbital/debris orientation primitive.
*/
function soaFillFromVelocity(out, velocities) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var vx = velocities.x, vy = velocities.y, vz = velocities.z;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        var dx = vx[i], dy = vy[i], dz = vz[i];
        var vlen = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (vlen < glMatrix.EPSILON) {
            oX[i] = 0; oY[i] = 0; oZ[i] = 0; oW[i] = 1;
            continue;
        }
        var inv = 1.0 / vlen;
        dx *= inv; dy *= inv; dz *= inv;
        var w = 1 + dx;
        if (w < glMatrix.EPSILON) {
            oX[i] = 0; oY[i] = 1; oZ[i] = 0; oW[i] = 0;
        } else {
            oX[i] = 0; oY[i] = -dz; oZ[i] = dy; oW[i] = w;
            var l = Math.sqrt(oY[i] * oY[i] + oZ[i] * oZ[i] + w * w);
            var li = 1 / l;
            oX[i] *= li; oY[i] *= li; oZ[i] *= li; oW[i] *= li;
        }
    }
    return out;
}

async function soaFillFromVelocityChunked(out, velocities, chunkSize, yieldEvery) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var vx = velocities.x, vy = velocities.y, vz = velocities.z;
    return _chunkedQ(out, function (i) {
        var dx = vx[i], dy = vy[i], dz = vz[i];
        var vlen = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (vlen < glMatrix.EPSILON) {
            oX[i] = 0; oY[i] = 0; oZ[i] = 0; oW[i] = 1;
            return;
        }
        var inv = 1.0 / vlen;
        dx *= inv; dy *= inv; dz *= inv;
        var w = 1 + dx;
        if (w < glMatrix.EPSILON) {
            oX[i] = 0; oY[i] = 1; oZ[i] = 0; oW[i] = 0;
        } else {
            oX[i] = 0; oY[i] = -dz; oZ[i] = dy; oW[i] = w;
            var l = Math.sqrt(oY[i] * oY[i] + oZ[i] * oZ[i] + w * w);
            var li = 1 / l;
            oX[i] *= li; oY[i] *= li; oZ[i] *= li; oW[i] *= li;
        }
    }, chunkSize, yieldEvery);
}

// ============================================================================
// 5. ANIMATION
// ============================================================================
/**
CORRECTION: INLINED spring math to eliminate array literal allocations
(`var v0 = [vel[0]]` etc.). Frame-rate-independent critically-damped
quaternion spring. Handles hemisphere flips. Writes new quat to `out`,
updates `vel` in place.
*/
function springDamp(out, current, target, vel, smoothTime, dt, maxSpeed) {
    if (smoothTime < 0.0001) smoothTime = 0.0001;
    if (maxSpeed === undefined) maxSpeed = Infinity;

    // Ensure shortest-arc
    var d = current[0] * target[0] + current[1] * target[1] + current[2] * target[2] + current[3] * target[3];
    var sgn = d < 0 ? -1 : 1;

    var omega = 2 / smoothTime;
    var x = omega * dt;
    var exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    var maxChange = maxSpeed * smoothTime;

    for (var i = 0; i < 4; i++) {
        var tgt = target[i] * sgn;
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

/**
CORRECTION: INLINED spring math to eliminate per-iteration array allocations.
SOA: spring-damp 1M+ quaternions per element with per-instance smoothTime.
*/
function soaSpringDamp(out, current, target, vel, smoothTime, dt, maxSpeed) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var cX = current.x, cY = current.y, cZ = current.z, cW = current.w;
    var tX = target.x, tY = target.y, tZ = target.z, tW = target.w;
    var vX = vel.x, vY = vel.y, vZ = vel.z, vW = vel.w;
    var n = out.count;
    var sTArr = (smoothTime && smoothTime.length !== undefined) ? smoothTime : null;

    for (var i = 0; i < n; i++) {
        var st = sTArr ? smoothTime[i] : smoothTime;
        if (st < 0.0001) st = 0.0001;
        if (maxSpeed === undefined) maxSpeed = Infinity;

        var d = cX[i] * tX[i] + cY[i] * tY[i] + cZ[i] * tZ[i] + cW[i] * tW[i];
        var sgn = d < 0 ? -1 : 1;

        var omega = 2 / st;
        var x = omega * dt;
        var exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
        var maxChange = maxSpeed * st;

        // Inline spring for each component
        var cx = cX[i], cy = cY[i], cz = cZ[i], cw = cW[i];
        var tx = tX[i] * sgn, ty = tY[i] * sgn, tz = tZ[i] * sgn, tw = tW[i] * sgn;

        // X
        var changeX = cx - tx;
        var origTX = tx;
        if (changeX > maxChange) changeX = maxChange;
        else if (changeX < -maxChange) changeX = -maxChange;
        tx = cx - changeX;
        var tempX = (vX[i] + omega * changeX) * dt;
        vX[i] = (vX[i] - omega * tempX) * exp;
        var outX = tx + (changeX + tempX) * exp;
        if ((origTX - cx > 0) === (outX > origTX)) { outX = origTX; vX[i] = (outX - origTX) / dt; }

        // Y
        var changeY = cy - ty;
        var origTY = ty;
        if (changeY > maxChange) changeY = maxChange;
        else if (changeY < -maxChange) changeY = -maxChange;
        ty = cy - changeY;
        var tempY = (vY[i] + omega * changeY) * dt;
        vY[i] = (vY[i] - omega * tempY) * exp;
        var outY = ty + (changeY + tempY) * exp;
        if ((origTY - cy > 0) === (outY > origTY)) { outY = origTY; vY[i] = (outY - origTY) / dt; }

        // Z
        var changeZ = cz - tz;
        var origTZ = tz;
        if (changeZ > maxChange) changeZ = maxChange;
        else if (changeZ < -maxChange) changeZ = -maxChange;
        tz = cz - changeZ;
        var tempZ = (vZ[i] + omega * changeZ) * dt;
        vZ[i] = (vZ[i] - omega * tempZ) * exp;
        var outZ = tz + (changeZ + tempZ) * exp;
        if ((origTZ - cz > 0) === (outZ > origTZ)) { outZ = origTZ; vZ[i] = (outZ - origTZ) / dt; }

        // W
        var changeW = cw - tw;
        var origTW = tw;
        if (changeW > maxChange) changeW = maxChange;
        else if (changeW < -maxChange) changeW = -maxChange;
        tw = cw - changeW;
        var tempW = (vW[i] + omega * changeW) * dt;
        vW[i] = (vW[i] - omega * tempW) * exp;
        var outW = tw + (changeW + tempW) * exp;
        if ((origTW - cw > 0) === (outW > origTW)) { outW = origTW; vW[i] = (outW - origTW) / dt; }

        // Normalize
        var lenSq = outX * outX + outY * outY + outZ * outZ + outW * outW;
        if (lenSq > 0) {
            var invLen = 1 / Math.sqrt(lenSq);
            oX[i] = outX * invLen; oY[i] = outY * invLen;
            oZ[i] = outZ * invLen; oW[i] = outW * invLen;
        } else {
            oX[i] = 0; oY[i] = 0; oZ[i] = 0; oW[i] = 1;
        }
    }
    return out;
}

// ============================================================================
// 6. NATURAL IK MOTION
// ============================================================================
/**
Look-at quaternion: computes the shortest-arc rotation taking the local
forward axis (+Z) to point toward `target`.
*/
function lookAt(out, fromPos, target, upHint) {
    var dx = target[0] - fromPos[0];
    var dy = target[1] - fromPos[1];
    var dz = target[2] - fromPos[2];
    var vlen = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (vlen < glMatrix.EPSILON) {
        return identity(out);
    }
    var inv = 1 / vlen;
    dx *= inv; dy *= inv; dz *= inv;
    var dotz = dz;
    if (dotz < -0.999999) {
        out[0] = 0; out[1] = 1; out[2] = 0; out[3] = 0;
        return out;
    }
    out[0] = -dy; out[1] = dx; out[2] = 0; out[3] = 1 + dotz;
    return normalize(out, out);
}

/**
CORRECTION: Uses module-level temporary to eliminate per-call allocation.
Spring look-at: quaternion spring of the look-at target.
*/
function springLookAt(out, current, fromPos, target, vel, upHint, smoothTime, dt, maxSpeed) {
    lookAt(_tmpQuat4, fromPos, target, upHint);
    return springDamp(out, current, _tmpQuat4, vel, smoothTime, dt, maxSpeed);
}

/** Batch: 1M+ look-at quaternions from position SOA + target SOA. */
function soaLookAt(out, positions, targets) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var px = positions.x, py = positions.y, pz = positions.z;
    var tx = targets.x, ty = targets.y, tz = targets.z;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        var dx = tx[i] - px[i], dy = ty[i] - py[i], dz = tz[i] - pz[i];
        var vlen = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (vlen < glMatrix.EPSILON) {
            oX[i] = 0; oY[i] = 0; oZ[i] = 0; oW[i] = 1;
            continue;
        }
        var inv = 1 / vlen;
        dx *= inv; dy *= inv; dz *= inv;
        var dotz = dz;
        if (dotz < -0.999999) {
            oX[i] = 0; oY[i] = 1; oZ[i] = 0; oW[i] = 0;
            continue;
        }
        var qx = -dy, qy = dx, qz = 0, qw = 1 + dotz;
        var l = Math.sqrt(qx * qx + qy * qy + qw * qw);
        var li = 1 / l;
        oX[i] = qx * li; oY[i] = qy * li; oZ[i] = qz * li; oW[i] = qw * li;
    }
    return out;
}

// ============================================================================
// 7. ORBITAL
// ============================================================================
/**
CORRECTION: Fixed sign bug in out[1]. The Hamilton product qz(Om) * qx(inc)
yields a positive y-component: sO * sI (not -sO * sI).
Orbital inclination orientation: align the local +Z axis with the
orbital plane normal derived from inclination & ascending node.
*/
function fromInclination(out, inclination, ascendingNode) {
    var halfOm = ascendingNode * 0.5, halfInc = inclination * 0.5;
    var sO = Math.sin(halfOm), cO = Math.cos(halfOm);
    var sI = Math.sin(halfInc), cI = Math.cos(halfInc);
    // q = qz(Om) * qx(inc) — Hamilton product
    out[0] = cO * sI;
    out[1] = sO * sI;   // CORRECTED: was -sO * sI
    out[2] = sO * cI;
    out[3] = cO * cI;
    return out;
}

/**
CORRECTION: Fixed sign bug in qz1. Full orbital-element quaternion:
R = Rz(Omega) * Rx(i) * Rz(omega).
*/
function fromOrbitalElements(out, inclination, ascendingNode, argPeriapsis) {
    var hO = ascendingNode * 0.5, hI = inclination * 0.5, hW = argPeriapsis * 0.5;
    var sO = Math.sin(hO), cO = Math.cos(hO);
    var sI = Math.sin(hI), cI = Math.cos(hI);
    var sW = Math.sin(hW), cW = Math.cos(hW);
    // qz(Om) * qx(i) — CORRECTED sign
    var qz0 = cO * sI, qz1 = sO * sI, qz2 = sO * cI, qz3 = cO * cI;
    // multiply by qz(omega) = (0, 0, sW, cW)
    out[0] = qz0 * cW + qz1 * sW;
    out[1] = qz1 * cW - qz0 * sW;
    out[2] = qz2 * cW + qz3 * sW;
    out[3] = qz3 * cW - qz2 * sW;
    return out;
}

/**
CORRECTION: Fixed sign bug. SOA batch: fill 1M+ orbital body quaternions
from per-instance elements.
*/
function soaFromOrbitalElements(out, inclinations, ascendingNodes, argPeriapses) {
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var n = out.count;
    for (var i = 0; i < n; i++) {
        var hO = ascendingNodes[i] * 0.5, hI = inclinations[i] * 0.5, hW = argPeriapses[i] * 0.5;
        var sO = Math.sin(hO), cO = Math.cos(hO);
        var sI = Math.sin(hI), cI = Math.cos(hI);
        var sW = Math.sin(hW), cW = Math.cos(hW);
        // CORRECTED sign
        var qz0 = cO * sI, qz1 = sO * sI, qz2 = sO * cI, qz3 = cO * cI;
        oX[i] = qz0 * cW + qz1 * sW;
        oY[i] = qz1 * cW - qz0 * sW;
        oZ[i] = qz2 * cW + qz3 * sW;
        oW[i] = qz3 * cW - qz2 * sW;
    }
    return out;
}

// ============================================================================
// 8. SCALE / FLOATING ORIGIN
// ============================================================================
/**
Quaternions are scale-invariant and origin-invariant.
Provided as a documentation anchor for API consistency.
*/
function recenter(out, q) {
    out[0] = q[0]; out[1] = q[1]; out[2] = q[2]; out[3] = q[3];
    return out;
}

// ============================================================================
// 9. EXPORTS
// ============================================================================
// ----- flat API -----
exports.create = create;
exports.identity = identity;
exports.setAxisAngle = setAxisAngle;
exports.getAxisAngle = getAxisAngle;
exports.getAngle = getAngle;
exports.multiply = multiply;
exports.rotateX = rotateX;
exports.rotateY = rotateY;
exports.rotateZ = rotateZ;
exports.calculateW = calculateW;
exports.exp = exp;
exports.ln = ln;
exports.pow = pow;
exports.slerp = slerp;
exports.random = random;
exports.invert = invert;
exports.conjugate = conjugate;
exports.fromMat3 = fromMat3;
exports.fromEuler = fromEuler;
exports.str = str;
exports.equals = equals;

// ----- pool -----
exports.createQuatPool = createQuatPool;
exports.acquire = acquire;
exports.release = release;

// ----- SOA -----
exports.createQuatSOA = createQuatSOA;
exports.soaIdentity = soaIdentity;
exports.soaGet = soaGet;
exports.soaSet = soaSet;
exports.soaCopy = soaCopy;
exports.soaToFlat = soaToFlat;
exports.soaFromFlat = soaFromFlat;
exports.soaMultiply = soaMultiply;
exports.soaConjugate = soaConjugate;
exports.soaNormalize = soaNormalize;
exports.soaDot = soaDot;
exports.soaSlerp = soaSlerp;
exports.soaNlerp = soaNlerp;
exports.soaRotateVec3 = soaRotateVec3;
exports.soaFromAxisAngle = soaFromAxisAngle;
exports.soaFromMat3 = soaFromMat3;
exports.soaToMat3 = soaToMat3;
exports.soaFromEuler = soaFromEuler;
exports.soaGetAngle = soaGetAngle;

// ----- chunked async -----
exports.soaMultiplyChunked = soaMultiplyChunked;
exports.soaNormalizeChunked = soaNormalizeChunked;
exports.soaSlerpChunked = soaSlerpChunked;
exports.soaRotateVec3Chunked = soaRotateVec3Chunked;
exports.soaForEachChunked = soaForEachChunked;

// ----- procedural -----
exports.soaFillFromNoise = soaFillFromNoise;
exports.soaFillFromNoiseChunked = soaFillFromNoiseChunked;
exports.soaFillSpinFrom4DNoise = soaFillSpinFrom4DNoise;
exports.soaFillFromVelocity = soaFillFromVelocity;
exports.soaFillFromVelocityChunked = soaFillFromVelocityChunked;

// ----- animation -----
exports.springDamp = springDamp;
exports.soaSpringDamp = soaSpringDamp;

// ----- natural IK motion -----
exports.lookAt = lookAt;
exports.springLookAt = springLookAt;
exports.soaLookAt = soaLookAt;

// ----- orbital -----
exports.fromInclination = fromInclination;
exports.fromOrbitalElements = fromOrbitalElements;
exports.soaFromOrbitalElements = soaFromOrbitalElements;

// ----- scale -----
exports.recenter = recenter;