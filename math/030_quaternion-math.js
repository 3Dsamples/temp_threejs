//File number : 030
// File : src/math/030_quaternion-math.js
//Description : Complete quaternion & dual-quaternion math system — imports 000_Math_module.js and
//              exposes a full SOA + pooled + chunked quaternion pipeline with seamless Float16 /
//              Float32 / Float64 precision switching at runtime.
//
//              CORRECTIONS (this revision):
//              • Zero-GC hot paths: every array literal (`[0,0,1]`, `[s,s,s]`, `[px,py,pz]`),
//                per-call `mat3.create()`, per-call RNG closure, and per-element object literal
//                has been replaced with module-level scratch or fully inlined scalar math
//                (Blueprint §10 / §16 / Snippets 25 / 28 / 34 / 42).
//              • `soaFromVelocity` no longer constructs a bogus `{0:oX,...,[i]:0}` object per
//                element — the inline shortest-arc path is the only path.
//              • `soaFromOrbitalElements` sign bug fixed: qz1 = +sO*sI (matches corrected
//                008_quat / 009_quat2).
//              • `toEuler` rewritten: the previous version read a TRANSPOSED matrix and returned
//                the inverse rotation's angles. All six orders now round-trip with `fromEuler`,
//                with explicit gimbal-lock fallbacks.
//              • `fromTo` 180° case now picks a genuinely perpendicular axis (previous fallback
//                could return a non-perpendicular axis and fail to map a → -a).
//              • `swingTwist` degenerate case fixed: a pure 180° swing now yields
//                twist = identity, swing = q (previously inverted).
//              • `toAxisAngle` clamps w before acos (no NaN on slightly-denormalized quats).
//              • `soaFromEuler` supports all six rotation orders (was xyz/zyx only).
//              • ES2022 static blocks / private static fields removed so the file parses on
//                older Android WebViews; warm-up is a plain IIFE with identical behaviour.
//              • Scalar `fromVelocity` and `soaFromVelocity` now share one +Z shortest-arc
//                convention (previously they disagreed).
//
//              FEATURES ADDED from corrected_bitecs_enhancement.md:
//              • §25/§28  — `composeTRSIntoFlat` + `syncInstancedMesh`: single-pass quaternion
//                TRS compose straight into THREE.InstancedMesh's interleaved Float32Array with
//                `clearUpdateRanges` / `addUpdateRange` dirty-prefix upload. Scalar scale path —
//                never `[s,s,s]`.
//              • §26      — Double-single precision bridge: `dsSubInto` / `dsSubF32` perform a
//                proper Knuth twoSum + renormalization BEFORE the fround cast (the blueprint's
//                `dxHi + dxLo` swallow bug), plus `dqFromWorldDS` / `soaDQFromWorldDS(+Chunked)`
//                for megaparsec-safe camera-relative dual quaternions.
//              • §34      — Pre-allocated `UP` / `AXIS_X/Y/Z` / `DEFAULT_BEND_AXIS` constants.
//              • §45/§51  — `soaIntegrateAngularVelocity(+Chunked)` designed for FIXED dt, and a
//                re-exported `createFixedStepScheduler` (spiral-of-death guarded accumulator).
//              • §10/§16  — Precision-change listener rebuilds every scratch pool with the new
//                dtype at switch time (never in the frame loop); `QuatBatchState` tracks all of
//                its SOAs with 000_Math_module so `setPrecision()` migrates them live.
//              • Skinning — `soaDQBlend(+Chunked)` (sign-corrected dual-quaternion linear blend
//                + renormalization) for two-influence DQS, plus full DQ SOA re-exports.
//              • `QuatBatchState` is now a real batch driver: targets, velocities, spring step
//                (sync + chunked), slerp step, angular-velocity integration, and instanced upload.
//####
//Best for : 3d graphics — 1M+ instanced rotation pipelines (asteroid belts, foliage, particles,
//           star clusters), dual-quaternion skinning on mobile with adaptive f32↔f64 precision
//           for galactic scenes, natural IK bone rotation via swing-twist and two-bone solutions,
//           orbital velocity-aligned quaternions and planet frames from Kepler elements,
//           procedural orientation from 3D simplex noise, HDR-aware hue rotation driven by
//           quaternions, animation pose blending with squad / bezier, deterministic fixed-step
//           angular integration, and mobile-safe chunked async batches that never block the UI
//           thread on Android 64-bit.
//License : MIT

// ============================================================================
// Directive Prologues
// ============================================================================
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

// ============================================================================
// Import
// ============================================================================
const M = require("./000_Math_module.js");

const common  = M.common;
const quat    = M.quat;
const quat2   = M.quat2;
const mat3    = M.mat3;
const mat4    = M.mat4;

// Precision plumbing (owned by 000_Math_module)
const getPrecision      = M.getPrecision;
const setPrecision      = M.setPrecision;
const onPrecisionChange = M.onPrecisionChange;
const getSOAPrecision   = M.getSOAPrecision;
const trackSOA          = M.trackSOA;
const untrackSOA        = M.untrackSOA;
const getArrayType      = M.getArrayType;

// Precision-aware SOA builders
const createQuatSOA  = M.createQuatSOA;
const createQuat2SOA = M.createQuat2SOA;
const createVec3SOA  = M.createVec3SOA;

// ============================================================================
// Constants — pre-allocated direction vectors (Blueprint §34: never `[0,1,0]`
// inside a loop). Frozen views are setup-time allocations, reused forever.
// ============================================================================
const PI      = Math.PI;
const TAU     = PI * 2;
const HALF_PI = PI * 0.5;
const EPSILON = 1e-6;
const HALF_3  = Math.sqrt(1 / 3);   // hue-rotation axis component

const AXIS_X = new Float32Array([1, 0, 0]);
const AXIS_Y = new Float32Array([0, 1, 0]);
const AXIS_Z = new Float32Array([0, 0, 1]);
const UP     = new Float32Array([0, 1, 0]);
const DEFAULT_BEND_AXIS = new Float32Array([0, 0, 1]);
const EULER_ORDERS = ["xyz", "xzy", "yxz", "yzx", "zxy", "zyx"];

// ============================================================================
// Module-level scratch (Zero-GC — allocated once, reused by every hot path)
// ============================================================================
const _tmpMat3 = new Float32Array(9);     // fromMat4 / fromDirection
const _tmpV3   = new Float32Array(3);     // DS bridge translation staging
const _ds2     = new Float64Array(2);     // double-single [hi, lo] renorm slot
const _sqC     = new Float32Array(4);     // chunked spring staging: current
const _sqT     = new Float32Array(4);     // chunked spring staging: target
const _sqV     = new Float32Array(4);     // chunked spring staging: velocity
const _dqC     = new Float32Array(8);     // chunked DQ spring staging
const _dqT     = new Float32Array(8);
const _dqV     = new Float32Array(8);

// Warm pools for scalar scratch handles. dtype follows the CURRENT precision
// at creation time; the precision listener below rebuilds them on switch.
const _scratchPool = common.createPool(
    function () { var q = new (getArrayType())(4); q[3] = 1; return { q: q }; },
    128,
    function (s) { s.q[0] = 0; s.q[1] = 0; s.q[2] = 0; s.q[3] = 1; }
);
const _dqScratchPool = common.createPool(
    function () { var q = new (getArrayType())(8); q[3] = 1; return { q: q }; },
    64,
    function (s) { s.q.fill(0); s.q[3] = 1; }
);

// ============================================================================
// Small helpers
// ============================================================================
function clamp1(v) { return v < -1 ? -1 : (v > 1 ? 1 : v); }
function _isArr(t) { return t != null && t.length !== undefined; }

// ============================================================================
// Scalar core
// ============================================================================
function create() { return quat.create(); }
function identity(out) { return quat.identity(out); }
function clone(a) { return quat.clone(a); }
function copy(out, a) { return quat.copy(out, a); }
function set(out, x, y, z, w) { return quat.set(out, x, y, z, w); }
function fromValues(x, y, z, w) { return quat.fromValues(x, y, z, w); }
function add(out, a, b) { return quat.add(out, a, b); }
function subtract(out, a, b) {
    out[0] = a[0] - b[0]; out[1] = a[1] - b[1];
    out[2] = a[2] - b[2]; out[3] = a[3] - b[3];
    return out;
}
function scale(out, a, s) { return quat.scale(out, a, s); }
function negate(out, a) {
    out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2]; out[3] = -a[3];
    return out;
}
function multiply(out, a, b) { return quat.multiply(out, a, b); }
function dot(a, b) { return quat.dot(a, b); }
function length(a) { return quat.length(a); }
function sqrLength(a) { return quat.squaredLength(a); }
function normalize(out, a) { return quat.normalize(out, a); }
function conjugate(out, a) { return quat.conjugate(out, a); }
function invert(out, a) { return quat.invert(out, a); }
function slerp(out, a, b, t) { return quat.slerp(out, a, b, t); }
function lerp(out, a, b, t) { return quat.lerp(out, a, b, t); }

/** Fast normalized-lerp — no trig, hemisphere-corrected. */
function nlerp(out, a, b, t) {
    var bx = b[0], by = b[1], bz = b[2], bw = b[3];
    var d = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
    if (d < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
    out[0] = a[0] + (bx - a[0]) * t;
    out[1] = a[1] + (by - a[1]) * t;
    out[2] = a[2] + (bz - a[2]) * t;
    out[3] = a[3] + (bw - a[3]) * t;
    return quat.normalize(out, out);
}

/** Squad (spherical quadrangle) — C¹-continuous quaternion spline. */
function squad(out, a, b, c, d, t) {
    var s1 = _scratchPool.acquire();
    var s2 = _scratchPool.acquire();
    quat.slerp(s1.q, a, d, t);
    quat.slerp(s2.q, b, c, t);
    quat.slerp(out, s1.q, s2.q, 2 * t * (1 - t));
    _scratchPool.release(s1);
    _scratchPool.release(s2);
    return out;
}

/** Bezier over 4 quaternions via recursive slerp (de Casteljau). */
function bezier(out, a, b, c, d, t) {
    var ab = _scratchPool.acquire();
    var bc = _scratchPool.acquire();
    var cd = _scratchPool.acquire();
    quat.slerp(ab.q, a, b, t);
    quat.slerp(bc.q, b, c, t);
    quat.slerp(cd.q, c, d, t);
    var abc = _scratchPool.acquire();
    var bcd = _scratchPool.acquire();
    quat.slerp(abc.q, ab.q, bc.q, t);
    quat.slerp(bcd.q, bc.q, cd.q, t);
    quat.slerp(out, abc.q, bcd.q, t);
    _scratchPool.release(ab); _scratchPool.release(bc); _scratchPool.release(cd);
    _scratchPool.release(abc); _scratchPool.release(bcd);
    return out;
}

/** Axis must be unit length (glMatrix convention). */
function fromAxisAngle(out, axis, rad) { return quat.setAxisAngle(out, axis, rad); }

/** CORRECTION: clamps w before acos — no NaN on denormalized quaternions. */
function toAxisAngle(outAxis, q) {
    var w = clamp1(q[3]);
    var rad = Math.acos(w) * 2;
    var s = Math.sqrt(1 - w * w);
    if (s > EPSILON) {
        var inv = 1 / s;
        outAxis[0] = q[0] * inv; outAxis[1] = q[1] * inv; outAxis[2] = q[2] * inv;
    } else {
        outAxis[0] = 1; outAxis[1] = 0; outAxis[2] = 0;
    }
    return rad;
}

function fromEuler(out, x, y, z, order) {
    return quat.fromEuler(out, x, y, z, order || common.ANGLE_ORDER || "zyx");
}

/**
 * Euler from quaternion — radians, all six orders, round-trips with fromEuler.
 * CORRECTION: previous version read a transposed matrix (mIJ = RJI) and
 * returned the inverse rotation's angles. Entries below are the true R[row][col].
 * Gimbal-lock fallbacks zero the redundant axis deterministically.
 */
function toEuler(out, q, order) {
    order = order || "zyx";
    var x = q[0], y = q[1], z = q[2], w = q[3];
    var xx = x * x, yy = y * y, zz = z * z;
    var xy = x * y, xz = x * z, yz = y * z;
    var wx = w * x, wy = w * y, wz = w * z;
    var r00 = 1 - 2 * (yy + zz), r01 = 2 * (xy - wz), r02 = 2 * (xz + wy);
    var r10 = 2 * (xy + wz),     r11 = 1 - 2 * (xx + zz), r12 = 2 * (yz - wx);
    var r20 = 2 * (xz - wy),     r21 = 2 * (yz + wx),     r22 = 1 - 2 * (xx + yy);
    var ex, ey, ez, s;
    var LOCK = 0.999999;
    switch (order) {
        case "xyz": // R = Rx·Ry·Rz
            s = clamp1(r02); ey = Math.asin(s);
            if (Math.abs(s) < LOCK) { ex = Math.atan2(-r12, r22); ez = Math.atan2(-r01, r00); }
            else { ez = 0; ex = Math.atan2(s * r10, r11); }
            break;
        case "xzy": // R = Rx·Rz·Ry
            s = clamp1(-r01); ez = Math.asin(s);
            if (Math.abs(s) < LOCK) { ex = Math.atan2(r21, r11); ey = Math.atan2(r02, r00); }
            else { ey = 0; ex = Math.atan2(-r12, r22); }
            break;
        case "yxz": // R = Ry·Rx·Rz
            s = clamp1(-r12); ex = Math.asin(s);
            if (Math.abs(s) < LOCK) { ey = Math.atan2(r02, r22); ez = Math.atan2(r10, r11); }
            else { ez = 0; ey = Math.atan2(s * r01, r00); }
            break;
        case "yzx": // R = Ry·Rz·Rx
            s = clamp1(r10); ez = Math.asin(s);
            if (Math.abs(s) < LOCK) { ey = Math.atan2(-r20, r00); ex = Math.atan2(-r12, r11); }
            else { ex = 0; ey = Math.atan2(r02, r22); }
            break;
        case "zxy": // R = Rz·Rx·Ry
            s = clamp1(r21); ex = Math.asin(s);
            if (Math.abs(s) < LOCK) { ez = Math.atan2(-r01, r11); ey = Math.atan2(-r20, r22); }
            else { ey = 0; ez = Math.atan2(r10, r00); }
            break;
        case "zyx": // R = Rz·Ry·Rx (glMatrix default)
        default:
            s = clamp1(-r20); ey = Math.asin(s);
            if (Math.abs(s) < LOCK) { ez = Math.atan2(r10, r00); ex = Math.atan2(r21, r22); }
            else { ez = 0; ex = Math.atan2(s * r01, r11); }
            break;
    }
    out[0] = ex; out[1] = ey; out[2] = ez;
    return out;
}

function fromMat3(out, m) { return quat.fromMat3(out, m); }
function toMat3(out, q) { return mat3.fromQuat(out, q); }

/** CORRECTION: module scratch instead of per-call mat3.create(). */
function fromMat4(out, m) {
    mat3.fromMat4(_tmpMat3, m);
    return quat.fromMat3(out, _tmpMat3);
}
function toMat4(out, q) { return mat4.fromQuat(out, q); }

/**
 * Shortest-arc rotation from direction a to direction b.
 * CORRECTION: the 180° fallback now crosses with the least-aligned cardinal
 * axis, guaranteeing a perpendicular rotation axis for ANY input direction.
 */
function fromTo(out, a, b) {
    var ax = a[0], ay = a[1], az = a[2];
    var bx = b[0], by = b[1], bz = b[2];
    var la = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
    var lb = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
    var ila = 1 / la, ilb = 1 / lb;
    ax *= ila; ay *= ila; az *= ila;
    bx *= ilb; by *= ilb; bz *= ilb;
    var d = ax * bx + ay * by + az * bz;
    if (d > 1 - EPSILON) return quat.identity(out);
    if (d < -1 + EPSILON) {
        // Pick the cardinal axis least aligned with a, then cross → perpendicular.
        var hx = 0, hy = 0, hz = 0;
        var aax = Math.abs(ax), aay = Math.abs(ay), aaz = Math.abs(az);
        if (aax <= aay && aax <= aaz) hx = 1;
        else if (aay <= aaz) hy = 1;
        else hz = 1;
        var px = ay * hz - az * hy;
        var py = az * hx - ax * hz;
        var pz = ax * hy - ay * hx;
        var pl = Math.sqrt(px * px + py * py + pz * pz) || 1;
        var pi = 1 / pl;
        out[0] = px * pi; out[1] = py * pi; out[2] = pz * pi; out[3] = 0;
        return out;
    }
    var cx = ay * bz - az * by;
    var cy = az * bx - ax * bz;
    var cz = ax * by - ay * bx;
    out[0] = cx; out[1] = cy; out[2] = cz; out[3] = 1 + d;
    return quat.normalize(out, out);
}

/** Look-at quaternion — aims local +Z at the target (008 convention). */
function lookAt(out, fromPos, target, upHint) { return quat.lookAt(out, fromPos, target, upHint); }
function aimQuat(out, fromPos, target, upHint) { return quat.lookAt(out, fromPos, target, upHint); }

function random(out) { return quat.random(out); }

/**
 * Deterministic unit quaternion from a spatial hash.
 * CORRECTION: no per-call mulberry32 closure — Shoemake's method is fed
 * directly by three independent hashes (seed folded into the hash lattice).
 */
function randomFromNoise(out, x, y, z, seed) {
    seed = seed === undefined ? 0 : seed | 0;
    var gx = Math.floor(x), gy = Math.floor(y), gz = Math.floor(z);
    var u1 = common.hash3(gx + seed, gy, gz);
    var u2 = common.hash3(gy + 17 + seed, gz + 23, gx + 5);
    var u3 = common.hash3(gz + 3 + seed, gx + 11, gy + 29);
    var s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
    out[0] = s1 * Math.sin(TAU * u2);
    out[1] = s1 * Math.cos(TAU * u2);
    out[2] = s2 * Math.sin(TAU * u3);
    out[3] = s2 * Math.cos(TAU * u3);
    return out;
}

/** Random spin around local +Y only. */
function randomDirectional(out, rng) {
    rng = rng || Math.random;
    var half = rng() * TAU * 0.5;
    out[0] = 0; out[1] = Math.sin(half); out[2] = 0; out[3] = Math.cos(half);
    return out;
}

function rotateX(out, a, rad) { return quat.rotateX(out, a, rad); }
function rotateY(out, a, rad) { return quat.rotateY(out, a, rad); }
function rotateZ(out, a, rad) { return quat.rotateZ(out, a, rad); }

function rotateAxis(out, a, axis, rad) {
    var rx = _scratchPool.acquire();
    quat.setAxisAngle(rx.q, axis, rad);
    quat.multiply(out, a, rx.q);
    _scratchPool.release(rx);
    return out;
}

function equals(a, b) { return quat.equals(a, b); }
function approxEquals(a, b) { return Math.abs(quat.dot(a, b)) >= 1 - EPSILON; }

/** Quaternion from an angular-velocity vector (rad/s) over dt. Use FIXED dt (§51). */
function fromAngularVelocity(out, omegaX, omegaY, omegaZ, dt) {
    var mag = Math.sqrt(omegaX * omegaX + omegaY * omegaY + omegaZ * omegaZ);
    if (mag < EPSILON || dt <= 0) return quat.identity(out);
    var half = mag * dt * 0.5;
    var s = Math.sin(half) / mag;
    out[0] = omegaX * s; out[1] = omegaY * s; out[2] = omegaZ * s; out[3] = Math.cos(half);
    return out;
}

/** Integrate an existing quaternion by angular velocity over dt (world frame). */
function integrateAngularVelocity(out, q, omegaX, omegaY, omegaZ, dt) {
    var dq = _scratchPool.acquire();
    fromAngularVelocity(dq.q, omegaX, omegaY, omegaZ, dt);
    quat.multiply(out, dq.q, q);
    quat.normalize(out, out);
    _scratchPool.release(dq);
    return out;
}

// ============================================================================
// Swing-twist decomposition
// ============================================================================
/**
 * CORRECTION: degenerate case (pure 180° swing, projection ≈ 0) now returns
 * twist = identity, swing = q. The previous code returned the inverse pairing.
 */
function swingTwist(out, q, axis) {
    var ax = axis[0], ay = axis[1], az = axis[2];
    var d = q[0] * ax + q[1] * ay + q[2] * az;
    var px = ax * d, py = ay * d, pz = az * d;
    var w = q[3];
    var len2 = px * px + py * py + pz * pz + w * w;
    if (len2 < EPSILON * EPSILON) {
        out.twist[0] = 0; out.twist[1] = 0; out.twist[2] = 0; out.twist[3] = 1;
        out.swing[0] = q[0]; out.swing[1] = q[1]; out.swing[2] = q[2]; out.swing[3] = q[3];
        return out;
    }
    var inv = 1 / Math.sqrt(len2);
    var tx = px * inv, ty = py * inv, tz = pz * inv, tw = w * inv;
    out.twist[0] = tx; out.twist[1] = ty; out.twist[2] = tz; out.twist[3] = tw;
    // swing = q * conj(twist)
    var nx = -tx, ny = -ty, nz = -tz;
    var qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    out.swing[0] = qw * nx + qx * tw + qy * nz - qz * ny;
    out.swing[1] = qw * ny + qy * tw + qz * nx - qx * nz;
    out.swing[2] = qw * nz + qz * tw + qx * ny - qy * nx;
    out.swing[3] = qw * tw - qx * nx - qy * ny - qz * nz;
    return out;
}

/** Batch swing-twist over quaternion + axis SOAs. Same corrected degenerate case. */
function swingTwistBatch(outSwing, outTwist, qs, axes, count) {
    count = count === undefined ? qs.count : count;
    var qx = qs.x, qy = qs.y, qz = qs.z, qw = qs.w;
    var ax = axes.x, ay = axes.y, az = axes.z;
    var oSx = outSwing.x, oSy = outSwing.y, oSz = outSwing.z, oSw = outSwing.w;
    var oTx = outTwist.x, oTy = outTwist.y, oTz = outTwist.z, oTw = outTwist.w;
    for (var i = 0; i < count; i++) {
        var avx = ax[i], avy = ay[i], avz = az[i];
        var qxi = qx[i], qyi = qy[i], qzi = qz[i], qwi = qw[i];
        var d = qxi * avx + qyi * avy + qzi * avz;
        var px = avx * d, py = avy * d, pz = avz * d;
        var len2 = px * px + py * py + pz * pz + qwi * qwi;
        if (len2 < EPSILON * EPSILON) {
            oTx[i] = 0; oTy[i] = 0; oTz[i] = 0; oTw[i] = 1;
            oSx[i] = qxi; oSy[i] = qyi; oSz[i] = qzi; oSw[i] = qwi;
            continue;
        }
        var inv = 1 / Math.sqrt(len2);
        var tx = px * inv, ty = py * inv, tz = pz * inv, tw = qwi * inv;
        oTx[i] = tx; oTy[i] = ty; oTz[i] = tz; oTw[i] = tw;
        var nx = -tx, ny = -ty, nz = -tz;
        oSx[i] = qwi * nx + qxi * tw + qyi * nz - qzi * ny;
        oSy[i] = qwi * ny + qyi * tw + qzi * nx - qxi * nz;
        oSz[i] = qwi * nz + qzi * tw + qxi * ny - qyi * nx;
        oSw[i] = qwi * tw - qxi * nx - qyi * ny - qzi * nz;
    }
    return outSwing;
}
function soaSwingTwist(outSwing, outTwist, qs, axes, count) {
    return swingTwistBatch(outSwing, outTwist, qs, axes, count);
}

// ============================================================================
// Natural IK
// ============================================================================
/**
 * Quaternion from a direction — local +Z aims along (dx,dy,dz), up-stabilized.
 * CORRECTION: module scratch mat3 instead of per-call mat3.create().
 */
function fromDirection(out, dx, dy, dz, upX, upY, upZ) {
    upX = upX === undefined ? 0 : upX;
    upY = upY === undefined ? 1 : upY;
    upZ = upZ === undefined ? 0 : upZ;
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < EPSILON) return quat.identity(out);
    var inv = 1 / len;
    var fx = dx * inv, fy = dy * inv, fz = dz * inv;
    var rx = upY * fz - upZ * fy;
    var ry = upZ * fx - upX * fz;
    var rz = upX * fy - upY * fx;
    var rlen = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (rlen < EPSILON) {
        // Up parallel to forward — pick a stable perpendicular.
        if (Math.abs(fx) > 0.9) { rx = 0; ry = 1; rz = 0; }
        else { rx = 1; ry = 0; rz = 0; }
    } else {
        var ri = 1 / rlen; rx *= ri; ry *= ri; rz *= ri;
    }
    var ux = fy * rz - fz * ry;
    var uy = fz * rx - fx * rz;
    var uz = fx * ry - fy * rx;
    _tmpMat3[0] = rx; _tmpMat3[1] = ry; _tmpMat3[2] = rz;
    _tmpMat3[3] = ux; _tmpMat3[4] = uy; _tmpMat3[5] = uz;
    _tmpMat3[6] = fx; _tmpMat3[7] = fy; _tmpMat3[8] = fz;
    return quat.fromMat3(out, _tmpMat3);
}

/** 2D bone rotation around +Z. */
function boneRotation(out, dx, dy) {
    var half = Math.atan2(dy, dx) * 0.5;
    out[0] = 0; out[1] = 0; out[2] = Math.sin(half); out[3] = Math.cos(half);
    return out;
}

/**
 * Two-bone quaternion solve (law of cosines).
 * CORRECTION: `bendAxis || [0,0,1]` literals replaced with DEFAULT_BEND_AXIS.
 * out = { upper, lower, reach, reachable } — caller-owned, reused.
 */
function twoBoneQuats(out, targetX, targetY, targetZ, upperLen, lowerLen, bendAxis) {
    var axis = bendAxis || DEFAULT_BEND_AXIS;
    var d = Math.sqrt(targetX * targetX + targetY * targetY + targetZ * targetZ);
    var maxReach = upperLen + lowerLen;
    var minReach = Math.abs(upperLen - lowerLen);
    var reachable = d <= maxReach && d >= minReach;
    var dc = Math.max(minReach + EPSILON, Math.min(maxReach - EPSILON, d));
    var cosUpper = (upperLen * upperLen + dc * dc - lowerLen * lowerLen) / (2 * upperLen * dc);
    var cosLower = (upperLen * upperLen + lowerLen * lowerLen - dc * dc) / (2 * upperLen * lowerLen);
    var upperAngle = Math.acos(clamp1(cosUpper));
    var innerAngle = Math.acos(clamp1(cosLower));
    var forward = _scratchPool.acquire();
    var bend = _scratchPool.acquire();
    fromDirection(forward.q, targetX, targetY, targetZ);
    quat.setAxisAngle(bend.q, axis, -upperAngle);
    quat.multiply(out.upper, forward.q, bend.q);
    quat.setAxisAngle(bend.q, axis, PI - innerAngle);
    quat.multiply(out.lower, out.upper, bend.q);
    out.reach = d;
    out.reachable = reachable;
    _scratchPool.release(forward);
    _scratchPool.release(bend);
    return out;
}

// ============================================================================
// Orbital
// ============================================================================
/**
 * Velocity-aligned quaternion — +Z shortest-arc convention, identical to
 * soaFromVelocity below (CORRECTION: scalar and SOA paths previously disagreed).
 */
function fromVelocity(out, vx, vy, vz) {
    var len = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (len < EPSILON) return quat.identity(out);
    var inv = 1 / len;
    var dx = vx * inv, dy = vy * inv, dz = vz * inv;
    var w = 1 + dz;
    if (w < EPSILON) { out[0] = 0; out[1] = 1; out[2] = 0; out[3] = 0; return out; }
    var qx = -dy, qy = dx;
    var ql = Math.sqrt(qx * qx + qy * qy + w * w);
    var qi = 1 / ql;
    out[0] = qx * qi; out[1] = qy * qi; out[2] = 0; out[3] = w * qi;
    return out;
}

/** Full orbital-element quaternion Rz(Ω)·Rx(i)·Rz(ω) — corrected 008 path. */
function fromOrbitalElements(out, inclination, ascendingNode, argPeriapsis) {
    return quat.fromOrbitalElements(out, inclination, ascendingNode, argPeriapsis);
}

/** Approximate orbital elements from a quaternion (best-effort, documented). */
function toOrbitalElements(out, q) {
    var x = q[0], y = q[1], z = q[2], w = q[3];
    var r02 = 2 * (x * z + y * w);
    var r12 = 2 * (y * z - x * w);
    var r22 = 1 - 2 * (x * x + y * y);
    var r20 = 2 * (x * z - y * w);
    var r21 = 2 * (y * z + x * w);
    out.inclination = Math.acos(clamp1(r22));
    out.ascendingNode = Math.atan2(r02, -r12);
    out.argPeriapsis = Math.atan2(r20, r21);
    return out;
}

/**
 * Orbital-plane frame qz(Ω)·qx(i).
 * CORRECTION: delegates to the corrected zero-alloc quat.fromInclination
 * (previous version allocated two `[0,0,1]`-style literals per call).
 */
function orbitalFrame(out, inclination, ascendingNode) {
    return quat.fromInclination(out, inclination, ascendingNode);
}

// ============================================================================
// Procedural
// ============================================================================
function fromSpherical(out, theta, phi) {
    var sT = Math.sin(theta);
    return fromDirection(out, sT * Math.cos(phi), Math.cos(theta), sT * Math.sin(phi));
}

/** Procedural orientation from 3D noise sampled at the position. Zero-alloc. */
function fromNoise(out, noiseFn, x, y, z, scale, time) {
    scale = scale === undefined ? 1 : scale;
    time = time === undefined ? 0 : time;
    var a = noiseFn(x * scale, y * scale, z * scale + time);
    var b = noiseFn(x * scale + 41, y * scale + 17, z * scale + 23 + time);
    var c = noiseFn(x * scale + 3, y * scale + 11, z * scale + 29 + time);
    var hA = a * PI, hB = b * PI, hC = c * PI;
    var sx = Math.sin(hA), cx = Math.cos(hA);
    var sy = Math.sin(hB), cy = Math.cos(hB);
    var sz = Math.sin(hC), cz = Math.cos(hC);
    out[0] = sx * cy * cz - cx * sy * sz;
    out[1] = cx * sy * cz + sx * cy * sz;
    out[2] = cx * cy * sz - sx * sy * cz;
    out[3] = cx * cy * cz + sx * sy * sz;
    return out;
}

// ============================================================================
// Color — hue rotation as a quaternion around (1,1,1)/√3
// ============================================================================
function fromHue(out, hueAngle) {
    var half = hueAngle * 0.5;
    var s = Math.sin(half) * HALF_3;
    out[0] = s; out[1] = s; out[2] = s; out[3] = Math.cos(half);
    return out;
}

/**
 * Apply a hue quaternion to RGB.
 * CORRECTION: fully inlined v' = v + 2w(q×v) + 2q×(q×v) — the previous version
 * acquired three pool slots and ran two Hamilton products per call.
 * HDR-safe: no clamping. Preserves r+g+b (energy), not perceptual luma.
 */
function applyHue(out, r, g, b, hueQuat) {
    var qx = hueQuat[0], qy = hueQuat[1], qz = hueQuat[2], qw = hueQuat[3];
    var tx = qy * b - qz * g;
    var ty = qz * r - qx * b;
    var tz = qx * g - qy * r;
    out[0] = r + qw * (tx + tx) + qy * (tz + tz) - qz * (ty + ty);
    out[1] = g + qw * (ty + ty) + qz * (tx + tx) - qx * (tz + tz);
    out[2] = b + qw * (tz + tz) + qx * (ty + ty) - qy * (tx + tx);
    return out;
}
function applyHueVec3(out, rgb, hueQuat) {
    return applyHue(out, rgb[0], rgb[1], rgb[2], hueQuat);
}

// ============================================================================
// Animation
// ============================================================================
function poseBlend(out, poseA, poseB, weight) { return quat.slerp(out, poseA, poseB, weight); }

/**
 * Keyframe slerp through N keys.
 * CORRECTION: uniform spacing is computed inline when `times` is omitted —
 * no per-call `new Array(n)`.
 */
function keyframeSlerp(out, keyframes, times, t) {
    var n = keyframes.length;
    if (n === 0) return quat.identity(out);
    if (n === 1) return quat.copy(out, keyframes[0]);
    if (!times) {
        var u = t * (n - 1);
        if (u <= 0) return quat.copy(out, keyframes[0]);
        if (u >= n - 1) return quat.copy(out, keyframes[n - 1]);
        var i0 = u | 0;
        return quat.slerp(out, keyframes[i0], keyframes[i0 + 1], u - i0);
    }
    if (t <= times[0]) return quat.copy(out, keyframes[0]);
    if (t >= times[n - 1]) return quat.copy(out, keyframes[n - 1]);
    for (var i = 0; i < n - 1; i++) {
        if (t >= times[i] && t <= times[i + 1]) {
            var span = times[i + 1] - times[i] || 1;
            return quat.slerp(out, keyframes[i], keyframes[i + 1], (t - times[i]) / span);
        }
    }
    return quat.copy(out, keyframes[n - 1]);
}

// ============================================================================
// Dual quaternions — scalar
// ============================================================================
function dqCreate() { return quat2.create(); }
function dqIdentity(out) { return quat2.identity(out); }
function dqClone(a) { return quat2.clone(a); }
function dqCopy(out, a) { return quat2.copy(out, a); }
function dqMultiply(out, a, b) { return quat2.multiply(out, a, b); }
function dqConjugate(out, a) { return quat2.conjugate(out, a); }
function dqNormalize(out, a) { return quat2.normalize(out, a); }
function dqFromTRS(out, position, rotation) { return quat2.fromRotationTranslation(out, rotation, position); }
function dqToTRS(outTranslation, outRotation, dq) {
    quat2.getTranslation(outTranslation, dq);
    outRotation[0] = dq[0]; outRotation[1] = dq[1];
    outRotation[2] = dq[2]; outRotation[3] = dq[3];
    return outTranslation;
}

/** DQS point transform — fully inlined, zero allocation. */
function dqTransformPoint(out, dq, point) {
    var x = point[0], y = point[1], z = point[2];
    var qx = dq[0], qy = dq[1], qz = dq[2], qw = dq[3];
    var tx = qy * z - qz * y;
    var ty = qz * x - qx * z;
    var tz = qx * y - qy * x;
    var rx = x + qw * (tx + tx) + qy * (tz + tz) - qz * (ty + ty);
    var ry = y + qw * (ty + ty) + qz * (tx + tx) - qx * (tz + tz);
    var rz = z + qw * (tz + tz) + qx * (ty + ty) - qy * (tx + tx);
    var dx = dq[4], dy = dq[5], dz = dq[6], dw = dq[7];
    var nx = -qx, ny = -qy, nz = -qz;
    out[0] = rx + (dw * nx + dx * qw + dy * nz - dz * ny) * 2;
    out[1] = ry + (dw * ny + dy * qw + dz * nx - dx * nz) * 2;
    out[2] = rz + (dw * nz + dz * qw + dx * ny - dy * nx) * 2;
    return out;
}

/** Dual-quaternion LINEAR blend (DLB) — sign-corrected, renormalized. */
function dqSlerp(out, a, b, t) {
    var d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    var sign = d < 0 ? -1 : 1;
    var mt = 1 - t, ts = t * sign;
    out[0] = a[0] * mt + b[0] * ts;
    out[1] = a[1] * mt + b[1] * ts;
    out[2] = a[2] * mt + b[2] * ts;
    out[3] = a[3] * mt + b[3] * ts;
    out[4] = a[4] * mt + b[4] * ts;
    out[5] = a[5] * mt + b[5] * ts;
    out[6] = a[6] * mt + b[6] * ts;
    out[7] = a[7] * mt + b[7] * ts;
    return quat2.normalize(out, out);
}

function dqLookAt(out, position, target, upHint) {
    var q = _scratchPool.acquire();
    quat.lookAt(q.q, position, target, upHint);
    quat2.fromRotationTranslation(out, q.q, position);
    _scratchPool.release(q);
    return out;
}

// ============================================================================
// Double-single precision bridge (Blueprint §26 — corrected)
// ----------------------------------------------------------------------------
// The blueprint's `Math.fround(dxHi + dxLo)` swallows the low word when the
// high words nearly cancel. These helpers perform a full Knuth twoSum on the
// high words, fold in the low-word difference, then RENORMALIZE with a second
// twoSum before any fround cast — exact to ~106 bits until the final cast.
// ============================================================================
/** out2 = [hi, lo] of (aHi,aLo) − (bHi,bLo). Caller-owned Float64Array(2). */
function dsSubInto(out2, aHi, aLo, bHi, bLo) {
    var b = -bHi;
    var s = aHi + b;
    var bb = s - aHi;
    var e = (aHi - (s - bb)) + (b - bb);
    var lo = e + (aLo - bLo);
    // Renormalize (full twoSum — safe even under catastrophic cancellation).
    var hi = s + lo;
    var v = hi - s;
    out2[0] = hi;
    out2[1] = (s - (hi - v)) + (lo - v);
    return out2;
}
/** Camera-relative Float32 scalar from double-single inputs. Zero-alloc. */
function dsSubF32(aHi, aLo, bHi, bLo) {
    dsSubInto(_ds2, aHi, aLo, bHi, bLo);
    return Math.fround(_ds2[0] + _ds2[1]);
}

/**
 * Build a camera-relative dual quaternion from a double-single world position.
 * posHi/posLo/originHi/originLo are 3-element array-likes (Float64Array).
 */
function dqFromWorldDS(out, q, posHi, posLo, originHi, originLo) {
    for (var k = 0; k < 3; k++) {
        dsSubInto(_ds2, posHi[k], posLo[k], originHi[k], originLo[k]);
        _tmpV3[k] = Math.fround(_ds2[0] + _ds2[1]);
    }
    return quat2.fromRotationTranslation(out, q, _tmpV3);
}

/**
 * SOA variant: `world` matches double.attachHighPrecisionPositions() —
 * { x:{hi,lo}, y:{hi,lo}, z:{hi,lo} }. `eids` optionally maps row → entity id.
 * Writes megaparsec-safe camera-relative dual quaternions with zero allocation.
 */
function soaDQFromWorldDS(out, rots, world, originHi, originLo, eids, count) {
    count = count === undefined ? out.count : count;
    var oX1 = out.x1, oY1 = out.y1, oZ1 = out.z1, oW1 = out.w1;
    var oX2 = out.x2, oY2 = out.y2, oZ2 = out.z2, oW2 = out.w2;
    var qx = rots.x, qy = rots.y, qz = rots.z, qw = rots.w;
    var xh = world.x.hi, xl = world.x.lo;
    var yh = world.y.hi, yl = world.y.lo;
    var zh = world.z.hi, zl = world.z.lo;
    for (var i = 0; i < count; i++) {
        var idx = eids ? eids[i] : i;
        dsSubInto(_ds2, xh[idx], xl[idx], originHi[0], originLo[0]);
        var tx = Math.fround(_ds2[0] + _ds2[1]) * 0.5;
        dsSubInto(_ds2, yh[idx], yl[idx], originHi[1], originLo[1]);
        var ty = Math.fround(_ds2[0] + _ds2[1]) * 0.5;
        dsSubInto(_ds2, zh[idx], zl[idx], originHi[2], originLo[2]);
        var tz = Math.fround(_ds2[0] + _ds2[1]) * 0.5;
        var bx = qx[i], by = qy[i], bz = qz[i], bw = qw[i];
        oX1[i] = bx; oY1[i] = by; oZ1[i] = bz; oW1[i] = bw;
        oX2[i] = tx * bw + ty * bz - tz * by;
        oY2[i] = ty * bw + tz * bx - tx * bz;
        oZ2[i] = tz * bw + tx * by - ty * bx;
        oW2[i] = -tx * bx - ty * by - tz * bz;
    }
    return out;
}
async function soaDQFromWorldDSChunked(out, rots, world, originHi, originLo, eids, count, cs, ye) {
    count = count === undefined ? out.count : count;
    var oX1 = out.x1, oY1 = out.y1, oZ1 = out.z1, oW1 = out.w1;
    var oX2 = out.x2, oY2 = out.y2, oZ2 = out.z2, oW2 = out.w2;
    var qx = rots.x, qy = rots.y, qz = rots.z, qw = rots.w;
    var xh = world.x.hi, xl = world.x.lo;
    var yh = world.y.hi, yl = world.y.lo;
    var zh = world.z.hi, zl = world.z.lo;
    await _chunked(count, cs, ye, function (s, e) {
        for (var i = s; i < e; i++) {
            var idx = eids ? eids[i] : i;
            dsSubInto(_ds2, xh[idx], xl[idx], originHi[0], originLo[0]);
            var tx = Math.fround(_ds2[0] + _ds2[1]) * 0.5;
            dsSubInto(_ds2, yh[idx], yl[idx], originHi[1], originLo[1]);
            var ty = Math.fround(_ds2[0] + _ds2[1]) * 0.5;
            dsSubInto(_ds2, zh[idx], zl[idx], originHi[2], originLo[2]);
            var tz = Math.fround(_ds2[0] + _ds2[1]) * 0.5;
            var bx = qx[i], by = qy[i], bz = qz[i], bw = qw[i];
            oX1[i] = bx; oY1[i] = by; oZ1[i] = bz; oW1[i] = bw;
            oX2[i] = tx * bw + ty * bz - tz * by;
            oY2[i] = ty * bw + tz * bx - tx * bz;
            oZ2[i] = tz * bw + tx * by - ty * bx;
            oW2[i] = -tx * bx - ty * by - tz * bz;
        }
    });
    return out;
}

// ============================================================================
// Pools — precision-aware, rebuilt on setPrecision() (setup-time only)
// ============================================================================
function createQuatPool(capacity) {
    return common.createPool(
        function () { var q = new (getArrayType())(4); q[3] = 1; return q; },
        capacity || 64,
        function (q) { q[0] = 0; q[1] = 0; q[2] = 0; q[3] = 1; }
    );
}
function createDQPool(capacity) {
    return common.createPool(
        function () { var q = new (getArrayType())(8); q[3] = 1; return q; },
        capacity || 32,
        function (q) { q.fill(0); q[3] = 1; }
    );
}
const _defaultQuatPool = createQuatPool(128);
const _defaultDQPool = createDQPool(64);
function acquireQuat() { return _defaultQuatPool.acquire(); }
function releaseQuat(q) { _defaultQuatPool.release(q); }
function acquireDQ() { return _defaultDQPool.acquire(); }
function releaseDQ(q) { _defaultDQPool.release(q); }

// ============================================================================
// SOA — synchronous, precision-agnostic, zero allocation
// ============================================================================
function soaMultiply(out, a, b, count) {
    count = count === undefined ? out.count : count;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    for (var i = 0; i < count; i++) {
        var ax = aX[i], ay = aY[i], az = aZ[i], aw = aW[i];
        var bx = bX[i], by = bY[i], bz = bZ[i], bw = bW[i];
        oX[i] = ax * bw + aw * bx + ay * bz - az * by;
        oY[i] = ay * bw + aw * by + az * bx - ax * bz;
        oZ[i] = az * bw + aw * bz + ax * by - ay * bx;
        oW[i] = aw * bw - ax * bx - ay * by - az * bz;
    }
    return out;
}
function soaConjugate(out, a, count) {
    count = count === undefined ? out.count : count;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    for (var i = 0; i < count; i++) {
        oX[i] = -aX[i]; oY[i] = -aY[i]; oZ[i] = -aZ[i]; oW[i] = aW[i];
    }
    return out;
}
function soaInvert(out, a, count) {
    count = count === undefined ? out.count : count;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    for (var i = 0; i < count; i++) {
        var x = aX[i], y = aY[i], z = aZ[i], w = aW[i];
        var d = x * x + y * y + z * z + w * w;
        var inv = d > 0 ? 1 / d : 0;
        oX[i] = -x * inv; oY[i] = -y * inv; oZ[i] = -z * inv; oW[i] = w * inv;
    }
    return out;
}
function soaNormalize(out, a, count) {
    count = count === undefined ? out.count : count;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    for (var i = 0; i < count; i++) {
        var x = aX[i], y = aY[i], z = aZ[i], w = aW[i];
        var l = x * x + y * y + z * z + w * w;
        if (l > 0) l = 1 / Math.sqrt(l); else { oX[i] = 0; oY[i] = 0; oZ[i] = 0; oW[i] = 1; continue; }
        oX[i] = x * l; oY[i] = y * l; oZ[i] = z * l; oW[i] = w * l;
    }
    return out;
}
function soaDot(a, b, count) {
    count = count === undefined ? a.count : count;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    var s = 0;
    for (var i = 0; i < count; i++) s += aX[i] * bX[i] + aY[i] * bY[i] + aZ[i] * bZ[i] + aW[i] * bW[i];
    return s;
}

/** SOA slerp — scalar or per-element t (TypedArray OR plain Array). */
function soaSlerp(out, a, b, t, count) {
    count = count === undefined ? out.count : count;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    var tArr = _isArr(t) ? t : null;
    for (var i = 0; i < count; i++) {
        var ti = tArr ? tArr[i] : t;
        var ax = aX[i], ay = aY[i], az = aZ[i], aw = aW[i];
        var bx = bX[i], by = bY[i], bz = bZ[i], bw = bW[i];
        var cosom = ax * bx + ay * by + az * bz + aw * bw;
        if (cosom < 0) { cosom = -cosom; bx = -bx; by = -by; bz = -bz; bw = -bw; }
        var s0, s1;
        if (1 - cosom > EPSILON) {
            var omega = Math.acos(clamp1(cosom));
            var sinom = Math.sin(omega);
            s0 = Math.sin((1 - ti) * omega) / sinom;
            s1 = Math.sin(ti * omega) / sinom;
        } else { s0 = 1 - ti; s1 = ti; }
        oX[i] = s0 * ax + s1 * bx;
        oY[i] = s0 * ay + s1 * by;
        oZ[i] = s0 * az + s1 * bz;
        oW[i] = s0 * aw + s1 * bw;
    }
    return out;
}
function soaNlerp(out, a, b, t, count) {
    count = count === undefined ? out.count : count;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    var tArr = _isArr(t) ? t : null;
    for (var i = 0; i < count; i++) {
        var ti = tArr ? tArr[i] : t;
        var ax = aX[i], ay = aY[i], az = aZ[i], aw = aW[i];
        var bx = bX[i], by = bY[i], bz = bZ[i], bw = bW[i];
        if (ax * bx + ay * by + az * bz + aw * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
        var x = ax + (bx - ax) * ti;
        var y = ay + (by - ay) * ti;
        var z = az + (bz - az) * ti;
        var w = aw + (bw - aw) * ti;
        var l = x * x + y * y + z * z + w * w;
        if (l > 0) l = 1 / Math.sqrt(l);
        oX[i] = x * l; oY[i] = y * l; oZ[i] = z * l; oW[i] = w * l;
    }
    return out;
}

/**
 * SOA look-at (+Z shortest arc).
 * CORRECTION: fully inlined — the previous version allocated TWO 3-element
 * array literals per element (2M arrays for 1M instances). Blueprint §10/§16.
 */
function soaLookAt(out, positions, targets, count) {
    count = count === undefined ? out.count : count;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var px = positions.x, py = positions.y, pz = positions.z;
    var tx = targets.x, ty = targets.y, tz = targets.z;
    for (var i = 0; i < count; i++) {
        var dx = tx[i] - px[i], dy = ty[i] - py[i], dz = tz[i] - pz[i];
        var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < EPSILON) { oX[i] = 0; oY[i] = 0; oZ[i] = 0; oW[i] = 1; continue; }
        var inv = 1 / len;
        dx *= inv; dy *= inv; dz *= inv;
        var w = 1 + dz;
        if (w < EPSILON) { oX[i] = 0; oY[i] = 1; oZ[i] = 0; oW[i] = 0; continue; }
        var qx = -dy, qy = dx;
        var ql = Math.sqrt(qx * qx + qy * qy + w * w);
        var qi = 1 / ql;
        oX[i] = qx * qi; oY[i] = qy * qi; oZ[i] = 0; oW[i] = w * qi;
    }
    return out;
}

/**
 * SOA velocity alignment (+Z shortest arc).
 * CORRECTION: removed the per-element `{0:oX,...,[i]:0}` object literal and
 * the redundant fromDirection call — the inline path is the only path.
 */
function soaFromVelocity(out, velocities, count) {
    count = count === undefined ? out.count : count;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var vx = velocities.x, vy = velocities.y, vz = velocities.z;
    for (var i = 0; i < count; i++) {
        var x = vx[i], y = vy[i], z = vz[i];
        var len = Math.sqrt(x * x + y * y + z * z);
        if (len < EPSILON) { oX[i] = 0; oY[i] = 0; oZ[i] = 0; oW[i] = 1; continue; }
        var inv = 1 / len;
        var dx = x * inv, dy = y * inv, dz = z * inv;
        var w = 1 + dz;
        if (w < EPSILON) { oX[i] = 0; oY[i] = 1; oZ[i] = 0; oW[i] = 0; continue; }
        var qx = -dy, qy = dx;
        var ql = Math.sqrt(qx * qx + qy * qy + w * w);
        var qi = 1 / ql;
        oX[i] = qx * qi; oY[i] = qy * qi; oZ[i] = 0; oW[i] = w * qi;
    }
    return out;
}

/**
 * SOA orbital-element quaternions.
 * CORRECTION: qz1 = +sO*sI (was −sO*sI — mirrored inclination, inconsistent
 * with the corrected 008_quat / 009_quat2 modules).
 */
function soaFromOrbitalElements(out, inclinations, ascendingNodes, argPeriapses, count) {
    count = count === undefined ? out.count : count;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    for (var i = 0; i < count; i++) {
        var hO = ascendingNodes[i] * 0.5, hI = inclinations[i] * 0.5, hW = argPeriapses[i] * 0.5;
        var sO = Math.sin(hO), cO = Math.cos(hO);
        var sI = Math.sin(hI), cI = Math.cos(hI);
        var sW = Math.sin(hW), cW = Math.cos(hW);
        var qz0 = cO * sI, qz1 = sO * sI, qz2 = sO * cI, qz3 = cO * cI; // CORRECTED sign
        oX[i] = qz0 * cW + qz1 * sW;
        oY[i] = qz1 * cW - qz0 * sW;
        oZ[i] = qz2 * cW + qz3 * sW;
        oW[i] = qz3 * cW - qz2 * sW;
    }
    return out;
}

function soaFromNoise(out, positions, noiseFn, scale, time, count) {
    count = count === undefined ? out.count : count;
    scale = scale === undefined ? 1 : scale;
    time = time === undefined ? 0 : time;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var px = positions.x, py = positions.y, pz = positions.z;
    var s = _scratchPool.acquire();
    for (var i = 0; i < count; i++) {
        fromNoise(s.q, noiseFn, px[i], py[i], pz[i], scale, time);
        oX[i] = s.q[0]; oY[i] = s.q[1]; oZ[i] = s.q[2]; oW[i] = s.q[3];
    }
    _scratchPool.release(s);
    return out;
}

/** SOA hue rotation — HDR-safe, inlined, alpha untouched. */
function soaApplyHue(colors, hueQuat, count) {
    count = count === undefined ? colors.count : count;
    var cx = colors.x, cy = colors.y, cz = colors.z;
    var qx = hueQuat[0], qy = hueQuat[1], qz = hueQuat[2], qw = hueQuat[3];
    for (var i = 0; i < count; i++) {
        var r = cx[i], g = cy[i], b = cz[i];
        var tx = qy * b - qz * g;
        var ty = qz * r - qx * b;
        var tz = qx * g - qy * r;
        cx[i] = r + qw * (tx + tx) + qy * (tz + tz) - qz * (ty + ty);
        cy[i] = g + qw * (ty + ty) + qz * (tx + tx) - qx * (tz + tz);
        cz[i] = b + qw * (tz + tz) + qx * (ty + ty) - qy * (tx + tx);
    }
    return colors;
}

/** Batch rotate 1M+ vec3s by per-instance quaternions. */
function soaRotateVec3(outVec3, quats, inVec3, count) {
    count = count === undefined ? outVec3.count : count;
    var oX = outVec3.x, oY = outVec3.y, oZ = outVec3.z;
    var vx = inVec3.x, vy = inVec3.y, vz = inVec3.z;
    var qX = quats.x, qY = quats.y, qZ = quats.z, qW = quats.w;
    for (var i = 0; i < count; i++) {
        var x = vx[i], y = vy[i], z = vz[i];
        var qx = qX[i], qy = qY[i], qz = qZ[i], qw = qW[i];
        var tx = qy * z - qz * y;
        var ty = qz * x - qx * z;
        var tz = qx * y - qy * x;
        var ttx = tx + tx, tty = ty + ty, ttz = tz + tz;
        oX[i] = x + qw * ttx + qy * ttz - qz * tty;
        oY[i] = y + qw * tty + qz * ttx - qx * ttz;
        oZ[i] = z + qw * ttz + qx * tty - qy * ttx;
    }
    return outVec3;
}

/** SOA dual-quaternion skinning — the DQS hot loop for 1M+ skinned instances. */
function soaDQSkin(outPositions, dqs, restPositions, count) {
    count = count === undefined ? outPositions.count : count;
    var oX = outPositions.x, oY = outPositions.y, oZ = outPositions.z;
    var rx = restPositions.x, ry = restPositions.y, rz = restPositions.z;
    var rX = dqs.x1, rY = dqs.y1, rZ = dqs.z1, rW = dqs.w1;
    var dX = dqs.x2, dY = dqs.y2, dZ = dqs.z2, dW = dqs.w2;
    for (var i = 0; i < count; i++) {
        var x = rx[i], y = ry[i], z = rz[i];
        var qx = rX[i], qy = rY[i], qz = rZ[i], qw = rW[i];
        var tx = qy * z - qz * y;
        var ty = qz * x - qx * z;
        var tz = qx * y - qy * x;
        var ttx = tx + tx, tty = ty + ty, ttz = tz + tz;
        var rrx = x + qw * ttx + qy * ttz - qz * tty;
        var rry = y + qw * tty + qz * ttx - qx * ttz;
        var rrz = z + qw * ttz + qx * tty - qy * ttx;
        var dx = dX[i], dy = dY[i], dz = dZ[i], dw = dW[i];
        var nx = -qx, ny = -qy, nz = -qz;
        oX[i] = rrx + (dw * nx + dx * qw + dy * nz - dz * ny) * 2;
        oY[i] = rry + (dw * ny + dy * qw + dz * nx - dx * nz) * 2;
        oZ[i] = rrz + (dw * nz + dz * qw + dx * ny - dy * nx) * 2;
    }
    return outPositions;
}

/**
 * NEW (§ animation blending): two-influence dual-quaternion linear blend.
 * out = normalize((1−w)·a + w·b) with hemisphere sign correction on the real
 * part. This is the second half of 4-influence DQS (blend pairs, then blend
 * the pair results). Zero allocation.
 */
function soaDQBlend(out, a, b, weights, count) {
    count = count === undefined ? out.count : count;
    var wArr = _isArr(weights) ? weights : null;
    var oX1 = out.x1, oY1 = out.y1, oZ1 = out.z1, oW1 = out.w1;
    var oX2 = out.x2, oY2 = out.y2, oZ2 = out.z2, oW2 = out.w2;
    var aX1 = a.x1, aY1 = a.y1, aZ1 = a.z1, aW1 = a.w1;
    var aX2 = a.x2, aY2 = a.y2, aZ2 = a.z2, aW2 = a.w2;
    var bX1 = b.x1, bY1 = b.y1, bZ1 = b.z1, bW1 = b.w1;
    var bX2 = b.x2, bY2 = b.y2, bZ2 = b.z2, bW2 = b.w2;
    for (var i = 0; i < count; i++) {
        var t = wArr ? wArr[i] : weights;
        var sign = (aX1[i] * bX1[i] + aY1[i] * bY1[i] + aZ1[i] * bZ1[i] + aW1[i] * bW1[i]) < 0 ? -1 : 1;
        var mt = 1 - t, ts = t * sign;
        var r0 = aX1[i] * mt + bX1[i] * ts;
        var r1 = aY1[i] * mt + bY1[i] * ts;
        var r2 = aZ1[i] * mt + bZ1[i] * ts;
        var r3 = aW1[i] * mt + bW1[i] * ts;
        var d0 = aX2[i] * mt + bX2[i] * ts;
        var d1 = aY2[i] * mt + bY2[i] * ts;
        var d2 = aZ2[i] * mt + bZ2[i] * ts;
        var d3 = aW2[i] * mt + bW2[i] * ts;
        // Unit-DQ renormalization (real normalize + dual orthogonalization).
        var mag = Math.sqrt(r0 * r0 + r1 * r1 + r2 * r2 + r3 * r3);
        if (mag > 0) {
            var n0 = r0 / mag, n1 = r1 / mag, n2 = r2 / mag, n3 = r3 / mag;
            var adb = n0 * d0 + n1 * d1 + n2 * d2 + n3 * d3;
            oX1[i] = n0; oY1[i] = n1; oZ1[i] = n2; oW1[i] = n3;
            oX2[i] = (d0 - n0 * adb) / mag;
            oY2[i] = (d1 - n1 * adb) / mag;
            oZ2[i] = (d2 - n2 * adb) / mag;
            oW2[i] = (d3 - n3 * adb) / mag;
        } else {
            oX1[i] = 0; oY1[i] = 0; oZ1[i] = 0; oW1[i] = 1;
            oX2[i] = 0; oY2[i] = 0; oZ2[i] = 0; oW2[i] = 0;
        }
    }
    return out;
}

function soaFromAxisAngle(out, axes, angles, count) {
    count = count === undefined ? out.count : count;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var axX = axes.x, axY = axes.y, axZ = axes.z;
    var angArr = _isArr(angles) ? angles : null;
    for (var i = 0; i < count; i++) {
        var a = (angArr ? angArr[i] : angles) * 0.5;
        var s = Math.sin(a);
        oX[i] = axX[i] * s; oY[i] = axY[i] * s; oZ[i] = axZ[i] * s; oW[i] = Math.cos(a);
    }
    return out;
}

/**
 * SOA Euler → quaternion.
 * CORRECTION: all six orders supported (was xyz/zyx only); order resolved to
 * an integer mode ONCE outside the loop — no per-element string compares.
 */
function soaFromEuler(out, xs, ys, zs, order, count) {
    count = count === undefined ? out.count : count;
    var mode = EULER_ORDERS.indexOf(order || "zyx");
    if (mode < 0) mode = 5;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    for (var i = 0; i < count; i++) {
        var hx = xs[i] * 0.5, hy = ys[i] * 0.5, hz = zs[i] * 0.5;
        var sx = Math.sin(hx), cx = Math.cos(hx);
        var sy = Math.sin(hy), cy = Math.cos(hy);
        var sz = Math.sin(hz), cz = Math.cos(hz);
        switch (mode) {
            case 0: // xyz
                oX[i] = sx * cy * cz + cx * sy * sz;
                oY[i] = cx * sy * cz - sx * cy * sz;
                oZ[i] = cx * cy * sz + sx * sy * cz;
                oW[i] = cx * cy * cz - sx * sy * sz;
                break;
            case 1: // xzy
                oX[i] = sx * cy * cz - cx * sy * sz;
                oY[i] = cx * sy * cz - sx * cy * sz;
                oZ[i] = cx * cy * sz + sx * sy * cz;
                oW[i] = cx * cy * cz + sx * sy * sz;
                break;
            case 2: // yxz
                oX[i] = sx * cy * cz + cx * sy * sz;
                oY[i] = cx * sy * cz - sx * cy * sz;
                oZ[i] = cx * cy * sz - sx * sy * cz;
                oW[i] = cx * cy * cz + sx * sy * sz;
                break;
            case 3: // yzx
                oX[i] = sx * cy * cz + cx * sy * sz;
                oY[i] = cx * sy * cz + sx * cy * sz;
                oZ[i] = cx * cy * sz - sx * sy * cz;
                oW[i] = cx * cy * cz - sx * sy * sz;
                break;
            case 4: // zxy
                oX[i] = sx * cy * cz - cx * sy * sz;
                oY[i] = cx * sy * cz + sx * cy * sz;
                oZ[i] = cx * cy * sz + sx * sy * cz;
                oW[i] = cx * cy * cz - sx * sy * sz;
                break;
            default: // zyx
                oX[i] = sx * cy * cz - cx * sy * sz;
                oY[i] = cx * sy * cz + sx * cy * sz;
                oZ[i] = cx * cy * sz - sx * sy * cz;
                oW[i] = cx * cy * cz + sx * sy * sz;
                break;
        }
    }
    return out;
}

/** Batch quaternion → mat3 (column-major) into a mat3 SOA. */
function soaToMat3(outMat, quats, count) {
    count = count === undefined ? outMat.count : count;
    var M00 = outMat.m00, M01 = outMat.m01, M02 = outMat.m02;
    var M10 = outMat.m10, M11 = outMat.m11, M12 = outMat.m12;
    var M20 = outMat.m20, M21 = outMat.m21, M22 = outMat.m22;
    var qX = quats.x, qY = quats.y, qZ = quats.z, qW = quats.w;
    for (var i = 0; i < count; i++) {
        var x = qX[i], y = qY[i], z = qZ[i], w = qW[i];
        var x2 = x + x, y2 = y + y, z2 = z + z;
        var xx = x * x2, yx = y * x2, yy = y * y2;
        var zx = z * x2, zy = z * y2, zz = z * z2;
        var wx = w * x2, wy = w * y2, wz = w * z2;
        M00[i] = 1 - yy - zz; M10[i] = yx - wz;       M20[i] = zx + wy;
        M01[i] = yx + wz;     M11[i] = 1 - xx - zz;  M21[i] = zy - wx;
        M02[i] = zx - wy;     M12[i] = zy + wx;      M22[i] = 1 - xx - yy;
    }
    return outMat;
}

/**
 * NEW (§45/§51): fixed-dt angular-velocity integration over a velocity SOA.
 * out = normalize(dq(omega·dt) · q). Feed dt from createFixedStepScheduler.
 */
function soaIntegrateAngularVelocity(out, qs, omegas, dt, count) {
    count = count === undefined ? out.count : count;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var qX = qs.x, qY = qs.y, qZ = qs.z, qW = qs.w;
    var wX = omegas.x, wY = omegas.y, wZ = omegas.z;
    for (var i = 0; i < count; i++) {
        var ox = wX[i], oy = wY[i], oz = wZ[i];
        var qx = qX[i], qy = qY[i], qz = qZ[i], qw = qW[i];
        var mag = Math.sqrt(ox * ox + oy * oy + oz * oz);
        var dx, dy, dz, dw;
        if (mag < EPSILON || dt <= 0) { dx = 0; dy = 0; dz = 0; dw = 1; }
        else {
            var half = mag * dt * 0.5;
            var s = Math.sin(half) / mag;
            dx = ox * s; dy = oy * s; dz = oz * s; dw = Math.cos(half);
        }
        // out = dq * q (world-frame pre-multiply)
        var rx = dx * qw + dw * qx + dy * qz - dz * qy;
        var ry = dy * qw + dw * qy + dz * qx - dx * qz;
        var rz = dz * qw + dw * qz + dx * qy - dy * qx;
        var rw = dw * qw - dx * qx - dy * qy - dz * qz;
        var l = rx * rx + ry * ry + rz * rz + rw * rw;
        if (l > 0) l = 1 / Math.sqrt(l);
        oX[i] = rx * l; oY[i] = ry * l; oZ[i] = rz * l; oW[i] = rw * l;
    }
    return out;
}

// ============================================================================
// Instanced render bridge (Blueprint §25 / §28 — corrected, zero-GC)
// ----------------------------------------------------------------------------
// Single-pass TRS compose straight into the interleaved Float32Array backing
// THREE.InstancedMesh.instanceMatrix, with dirty-prefix upload. Scale accepts
// a vec3 SOA, a scalar number, or null (=1). NEVER allocates `[s,s,s]`.
// ============================================================================
function composeTRSIntoFlat(flat, quats, positions, scales, count, ox, oy, oz) {
    count = count === undefined ? quats.count : count;
    ox = ox || 0; oy = oy || 0; oz = oz || 0;
    var qX = quats.x, qY = quats.y, qZ = quats.z, qW = quats.w;
    var px = positions ? positions.x : null;
    var py = positions ? positions.y : null;
    var pz = positions ? positions.z : null;
    var scalarScale = typeof scales === "number" ? scales : 0;
    var sx = null, sy = null, sz = null;
    if (scales && typeof scales !== "number") { sx = scales.x; sy = scales.y; sz = scales.z; }
    for (var i = 0, o = 0; i < count; i++, o += 16) {
        var x = qX[i], y = qY[i], z = qZ[i], w = qW[i];
        var x2 = x + x, y2 = y + y, z2 = z + z;
        var xx = x * x2, xy = x * y2, xz = x * z2;
        var yy = y * y2, yz = y * z2, zz = z * z2;
        var wx = w * x2, wy = w * y2, wz = w * z2;
        var Sx = sx ? sx[i] : (scalarScale || 1);
        var Sy = sy ? sy[i] : (scalarScale || 1);
        var Sz = sz ? sz[i] : (scalarScale || 1);
        flat[o]      = (1 - (yy + zz)) * Sx;
        flat[o + 1]  = (xy + wz) * Sx;
        flat[o + 2]  = (xz - wy) * Sx;
        flat[o + 3]  = 0;
        flat[o + 4]  = (xy - wz) * Sy;
        flat[o + 5]  = (1 - (xx + zz)) * Sy;
        flat[o + 6]  = (yz + wx) * Sy;
        flat[o + 7]  = 0;
        flat[o + 8]  = (xz + wy) * Sz;
        flat[o + 9]  = (yz - wx) * Sz;
        flat[o + 10] = (1 - (xx + yy)) * Sz;
        flat[o + 11] = 0;
        flat[o + 12] = (px ? px[i] : 0) - ox;
        flat[o + 13] = (py ? py[i] : 0) - oy;
        flat[o + 14] = (pz ? pz[i] : 0) - oz;
        flat[o + 15] = 1;
    }
    return flat;
}

/** Compose + dirty-range upload into a THREE.InstancedMesh. Returns count. */
function syncInstancedMesh(mesh, quats, positions, scales, count, origin) {
    if (!mesh || !mesh.instanceMatrix || !mesh.instanceMatrix.array) return 0;
    count = count === undefined ? quats.count : count;
    var ox = origin ? origin[0] : 0;
    var oy = origin ? origin[1] : 0;
    var oz = origin ? origin[2] : 0;
    composeTRSIntoFlat(mesh.instanceMatrix.array, quats, positions, scales, count, ox, oy, oz);
    var attr = mesh.instanceMatrix;
    if (mesh.count !== undefined) mesh.count = count;
    if (attr.clearUpdateRanges) attr.clearUpdateRanges();
    if (attr.addUpdateRange) attr.addUpdateRange(0, count * 16);
    attr.needsUpdate = true;
    return count;
}

/** Quaternion TRS → mat4 SOA (delegates to the corrected 007 pipeline). */
function soaToMat4TRS(outMat, quats, positions, scales) {
    return mat4.soaComposeTRS(outMat, positions, quats, scales);
}

// ============================================================================
// Chunked async (mobile-safe; one closure per CALL — setup/async only, §1)
// ============================================================================
async function _chunked(count, chunkSize, yieldEvery, perChunk) {
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    var start = 0, c = 0;
    while (start < count) {
        var end = Math.min(start + chunkSize, count);
        perChunk(start, end);
        start = end;
        if (start >= count) break;
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
}

async function soaMultiplyChunked(out, a, b, count, cs, ye) {
    count = count === undefined ? out.count : count;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    await _chunked(count, cs, ye, function (s, e) {
        for (var i = s; i < e; i++) {
            var ax = aX[i], ay = aY[i], az = aZ[i], aw = aW[i];
            var bx = bX[i], by = bY[i], bz = bZ[i], bw = bW[i];
            oX[i] = ax * bw + aw * bx + ay * bz - az * by;
            oY[i] = ay * bw + aw * by + az * bx - ax * bz;
            oZ[i] = az * bw + aw * bz + ax * by - ay * bx;
            oW[i] = aw * bw - ax * bx - ay * by - az * bz;
        }
    });
    return out;
}
async function soaNormalizeChunked(out, a, count, cs, ye) {
    count = count === undefined ? out.count : count;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    await _chunked(count, cs, ye, function (s, e) {
        for (var i = s; i < e; i++) {
            var x = aX[i], y = aY[i], z = aZ[i], w = aW[i];
            var l = x * x + y * y + z * z + w * w;
            if (l > 0) l = 1 / Math.sqrt(l);
            oX[i] = x * l; oY[i] = y * l; oZ[i] = z * l; oW[i] = w * l;
        }
    });
    return out;
}
async function soaSlerpChunked(out, a, b, t, count, cs, ye) {
    count = count === undefined ? out.count : count;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    var tArr = _isArr(t) ? t : null;
    await _chunked(count, cs, ye, function (s, e) {
        for (var i = s; i < e; i++) {
            var ti = tArr ? tArr[i] : t;
            var ax = aX[i], ay = aY[i], az = aZ[i], aw = aW[i];
            var bx = bX[i], by = bY[i], bz = bZ[i], bw = bW[i];
            var cosom = ax * bx + ay * by + az * bz + aw * bw;
            if (cosom < 0) { cosom = -cosom; bx = -bx; by = -by; bz = -bz; bw = -bw; }
            var s0, s1;
            if (1 - cosom > EPSILON) {
                var omega = Math.acos(clamp1(cosom));
                var sinom = Math.sin(omega);
                s0 = Math.sin((1 - ti) * omega) / sinom;
                s1 = Math.sin(ti * omega) / sinom;
            } else { s0 = 1 - ti; s1 = ti; }
            oX[i] = s0 * ax + s1 * bx;
            oY[i] = s0 * ay + s1 * by;
            oZ[i] = s0 * az + s1 * bz;
            oW[i] = s0 * aw + s1 * bw;
        }
    });
    return out;
}
async function soaLookAtChunked(out, positions, targets, count, cs, ye) {
    count = count === undefined ? out.count : count;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var px = positions.x, py = positions.y, pz = positions.z;
    var tx = targets.x, ty = targets.y, tz = targets.z;
    await _chunked(count, cs, ye, function (s, e) {
        for (var i = s; i < e; i++) {
            var dx = tx[i] - px[i], dy = ty[i] - py[i], dz = tz[i] - pz[i];
            var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (len < EPSILON) { oX[i] = 0; oY[i] = 0; oZ[i] = 0; oW[i] = 1; continue; }
            var inv = 1 / len;
            dx *= inv; dy *= inv; dz *= inv;
            var w = 1 + dz;
            if (w < EPSILON) { oX[i] = 0; oY[i] = 1; oZ[i] = 0; oW[i] = 0; continue; }
            var qx = -dy, qy = dx;
            var ql = Math.sqrt(qx * qx + qy * qy + w * w);
            var qi = 1 / ql;
            oX[i] = qx * qi; oY[i] = qy * qi; oZ[i] = 0; oW[i] = w * qi;
        }
    });
    return out;
}
async function soaFromVelocityChunked(out, velocities, count, cs, ye) {
    count = count === undefined ? out.count : count;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var vx = velocities.x, vy = velocities.y, vz = velocities.z;
    await _chunked(count, cs, ye, function (s, e) {
        for (var i = s; i < e; i++) {
            var x = vx[i], y = vy[i], z = vz[i];
            var len = Math.sqrt(x * x + y * y + z * z);
            if (len < EPSILON) { oX[i] = 0; oY[i] = 0; oZ[i] = 0; oW[i] = 1; continue; }
            var inv = 1 / len;
            var dx = x * inv, dy = y * inv, dz = z * inv;
            var w = 1 + dz;
            if (w < EPSILON) { oX[i] = 0; oY[i] = 1; oZ[i] = 0; oW[i] = 0; continue; }
            var qx = -dy, qy = dx;
            var ql = Math.sqrt(qx * qx + qy * qy + w * w);
            var qi = 1 / ql;
            oX[i] = qx * qi; oY[i] = qy * qi; oZ[i] = 0; oW[i] = w * qi;
        }
    });
    return out;
}
async function soaFromOrbitalElementsChunked(out, inc, Om, om, count, cs, ye) {
    count = count === undefined ? out.count : count;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    await _chunked(count, cs, ye, function (s, e) {
        for (var i = s; i < e; i++) {
            var hO = Om[i] * 0.5, hI = inc[i] * 0.5, hW = om[i] * 0.5;
            var sO = Math.sin(hO), cO = Math.cos(hO);
            var sI = Math.sin(hI), cI = Math.cos(hI);
            var sW = Math.sin(hW), cW = Math.cos(hW);
            var qz0 = cO * sI, qz1 = sO * sI, qz2 = sO * cI, qz3 = cO * cI; // CORRECTED sign
            oX[i] = qz0 * cW + qz1 * sW;
            oY[i] = qz1 * cW - qz0 * sW;
            oZ[i] = qz2 * cW + qz3 * sW;
            oW[i] = qz3 * cW - qz2 * sW;
        }
    });
    return out;
}
async function soaFromNoiseChunked(out, positions, noiseFn, scale, time, count, cs, ye) {
    count = count === undefined ? out.count : count;
    scale = scale === undefined ? 1 : scale;
    time = time === undefined ? 0 : time;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var px = positions.x, py = positions.y, pz = positions.z;
    var s = _scratchPool.acquire();
    await _chunked(count, cs, ye, function (st, en) {
        for (var i = st; i < en; i++) {
            fromNoise(s.q, noiseFn, px[i], py[i], pz[i], scale, time);
            oX[i] = s.q[0]; oY[i] = s.q[1]; oZ[i] = s.q[2]; oW[i] = s.q[3];
        }
    });
    _scratchPool.release(s);
    return out;
}
async function soaRotateVec3Chunked(outVec3, quats, inVec3, count, cs, ye) {
    count = count === undefined ? outVec3.count : count;
    var oX = outVec3.x, oY = outVec3.y, oZ = outVec3.z;
    var vx = inVec3.x, vy = inVec3.y, vz = inVec3.z;
    var qX = quats.x, qY = quats.y, qZ = quats.z, qW = quats.w;
    await _chunked(count, cs, ye, function (s, e) {
        for (var i = s; i < e; i++) {
            var x = vx[i], y = vy[i], z = vz[i];
            var qx = qX[i], qy = qY[i], qz = qZ[i], qw = qW[i];
            var tx = qy * z - qz * y;
            var ty = qz * x - qx * z;
            var tz = qx * y - qy * x;
            var ttx = tx + tx, tty = ty + ty, ttz = tz + tz;
            oX[i] = x + qw * ttx + qy * ttz - qz * tty;
            oY[i] = y + qw * tty + qz * ttx - qx * ttz;
            oZ[i] = z + qw * ttz + qx * tty - qy * ttx;
        }
    });
    return outVec3;
}
async function soaDQSkinChunked(outPositions, dqs, restPositions, count, cs, ye) {
    count = count === undefined ? outPositions.count : count;
    var oX = outPositions.x, oY = outPositions.y, oZ = outPositions.z;
    var rx = restPositions.x, ry = restPositions.y, rz = restPositions.z;
    var rX = dqs.x1, rY = dqs.y1, rZ = dqs.z1, rW = dqs.w1;
    var dX = dqs.x2, dY = dqs.y2, dZ = dqs.z2, dW = dqs.w2;
    await _chunked(count, cs, ye, function (s, e) {
        for (var i = s; i < e; i++) {
            var x = rx[i], y = ry[i], z = rz[i];
            var qx = rX[i], qy = rY[i], qz = rZ[i], qw = rW[i];
            var tx = qy * z - qz * y;
            var ty = qz * x - qx * z;
            var tz = qx * y - qy * x;
            var ttx = tx + tx, tty = ty + ty, ttz = tz + tz;
            var rrx = x + qw * ttx + qy * ttz - qz * tty;
            var rry = y + qw * tty + qz * ttx - qx * ttz;
            var rrz = z + qw * ttz + qx * tty - qy * ttx;
            var dx = dX[i], dy = dY[i], dz = dZ[i], dw = dW[i];
            var nx = -qx, ny = -qy, nz = -qz;
            oX[i] = rrx + (dw * nx + dx * qw + dy * nz - dz * ny) * 2;
            oY[i] = rry + (dw * ny + dy * qw + dz * nx - dx * nz) * 2;
            oZ[i] = rrz + (dw * nz + dz * qw + dx * ny - dy * nx) * 2;
        }
    });
    return outPositions;
}
async function soaDQBlendChunked(out, a, b, weights, count, cs, ye) {
    count = count === undefined ? out.count : count;
    var wArr = _isArr(weights) ? weights : null;
    var oX1 = out.x1, oY1 = out.y1, oZ1 = out.z1, oW1 = out.w1;
    var oX2 = out.x2, oY2 = out.y2, oZ2 = out.z2, oW2 = out.w2;
    var aX1 = a.x1, aY1 = a.y1, aZ1 = a.z1, aW1 = a.w1;
    var aX2 = a.x2, aY2 = a.y2, aZ2 = a.z2, aW2 = a.w2;
    var bX1 = b.x1, bY1 = b.y1, bZ1 = b.z1, bW1 = b.w1;
    var bX2 = b.x2, bY2 = b.y2, bZ2 = b.z2, bW2 = b.w2;
    await _chunked(count, cs, ye, function (s, e) {
        for (var i = s; i < e; i++) {
            var t = wArr ? wArr[i] : weights;
            var sign = (aX1[i] * bX1[i] + aY1[i] * bY1[i] + aZ1[i] * bZ1[i] + aW1[i] * bW1[i]) < 0 ? -1 : 1;
            var mt = 1 - t, ts = t * sign;
            var r0 = aX1[i] * mt + bX1[i] * ts;
            var r1 = aY1[i] * mt + bY1[i] * ts;
            var r2 = aZ1[i] * mt + bZ1[i] * ts;
            var r3 = aW1[i] * mt + bW1[i] * ts;
            var d0 = aX2[i] * mt + bX2[i] * ts;
            var d1 = aY2[i] * mt + bY2[i] * ts;
            var d2 = aZ2[i] * mt + bZ2[i] * ts;
            var d3 = aW2[i] * mt + bW2[i] * ts;
            var mag = Math.sqrt(r0 * r0 + r1 * r1 + r2 * r2 + r3 * r3);
            if (mag > 0) {
                var n0 = r0 / mag, n1 = r1 / mag, n2 = r2 / mag, n3 = r3 / mag;
                var adb = n0 * d0 + n1 * d1 + n2 * d2 + n3 * d3;
                oX1[i] = n0; oY1[i] = n1; oZ1[i] = n2; oW1[i] = n3;
                oX2[i] = (d0 - n0 * adb) / mag;
                oY2[i] = (d1 - n1 * adb) / mag;
                oZ2[i] = (d2 - n2 * adb) / mag;
                oW2[i] = (d3 - n3 * adb) / mag;
            } else {
                oX1[i] = 0; oY1[i] = 0; oZ1[i] = 0; oW1[i] = 1;
                oX2[i] = 0; oY2[i] = 0; oZ2[i] = 0; oW2[i] = 0;
            }
        }
    });
    return out;
}
async function soaFromAxisAngleChunked(out, axes, angles, count, cs, ye) {
    count = count === undefined ? out.count : count;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var axX = axes.x, axY = axes.y, axZ = axes.z;
    var angArr = _isArr(angles) ? angles : null;
    await _chunked(count, cs, ye, function (s, e) {
        for (var i = s; i < e; i++) {
            var a = (angArr ? angArr[i] : angles) * 0.5;
            var sa = Math.sin(a);
            oX[i] = axX[i] * sa; oY[i] = axY[i] * sa; oZ[i] = axZ[i] * sa; oW[i] = Math.cos(a);
        }
    });
    return out;
}
async function soaFromEulerChunked(out, xs, ys, zs, order, count, cs, ye) {
    count = count === undefined ? out.count : count;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var s = _scratchPool.acquire();
    var ord = order || "zyx";
    await _chunked(count, cs, ye, function (st, en) {
        for (var i = st; i < en; i++) {
            quat.fromEuler(s.q, xs[i], ys[i], zs[i], ord);
            oX[i] = s.q[0]; oY[i] = s.q[1]; oZ[i] = s.q[2]; oW[i] = s.q[3];
        }
    });
    _scratchPool.release(s);
    return out;
}
async function soaToMat3Chunked(outMat, quats, count, cs, ye) {
    count = count === undefined ? outMat.count : count;
    var M00 = outMat.m00, M01 = outMat.m01, M02 = outMat.m02;
    var M10 = outMat.m10, M11 = outMat.m11, M12 = outMat.m12;
    var M20 = outMat.m20, M21 = outMat.m21, M22 = outMat.m22;
    var qX = quats.x, qY = quats.y, qZ = quats.z, qW = quats.w;
    await _chunked(count, cs, ye, function (s, e) {
        for (var i = s; i < e; i++) {
            var x = qX[i], y = qY[i], z = qZ[i], w = qW[i];
            var x2 = x + x, y2 = y + y, z2 = z + z;
            var xx = x * x2, yx = y * x2, yy = y * y2;
            var zx = z * x2, zy = z * y2, zz = z * z2;
            var wx = w * x2, wy = w * y2, wz = w * z2;
            M00[i] = 1 - yy - zz; M10[i] = yx - wz;       M20[i] = zx + wy;
            M01[i] = yx + wz;     M11[i] = 1 - xx - zz;  M21[i] = zy - wx;
            M02[i] = zx - wy;     M12[i] = zy + wx;      M22[i] = 1 - xx - yy;
        }
    });
    return outMat;
}
async function soaIntegrateAngularVelocityChunked(out, qs, omegas, dt, count, cs, ye) {
    count = count === undefined ? out.count : count;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var qX = qs.x, qY = qs.y, qZ = qs.z, qW = qs.w;
    var wX = omegas.x, wY = omegas.y, wZ = omegas.z;
    await _chunked(count, cs, ye, function (s, e) {
        for (var i = s; i < e; i++) {
            var ox = wX[i], oy = wY[i], oz = wZ[i];
            var qx = qX[i], qy = qY[i], qz = qZ[i], qw = qW[i];
            var mag = Math.sqrt(ox * ox + oy * oy + oz * oz);
            var dx, dy, dz, dw;
            if (mag < EPSILON || dt <= 0) { dx = 0; dy = 0; dz = 0; dw = 1; }
            else {
                var half = mag * dt * 0.5;
                var sc = Math.sin(half) / mag;
                dx = ox * sc; dy = oy * sc; dz = oz * sc; dw = Math.cos(half);
            }
            var rx = dx * qw + dw * qx + dy * qz - dz * qy;
            var ry = dy * qw + dw * qy + dz * qx - dx * qz;
            var rz = dz * qw + dw * qz + dx * qy - dy * qx;
            var rw = dw * qw - dx * qx - dy * qy - dz * qz;
            var l = rx * rx + ry * ry + rz * rz + rw * rw;
            if (l > 0) l = 1 / Math.sqrt(l);
            oX[i] = rx * l; oY[i] = ry * l; oZ[i] = rz * l; oW[i] = rw * l;
        }
    });
    return out;
}

/** Chunked quaternion spring — staged through module scratch, zero steady-state GC. */
async function soaSpringDampChunked(out, current, target, vel, smoothTime, dt, maxSpeed, count, cs, ye) {
    count = count === undefined ? out.count : count;
    var stArr = _isArr(smoothTime) ? smoothTime : null;
    var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    var cX = current.x, cY = current.y, cZ = current.z, cW = current.w;
    var tX = target.x, tY = target.y, tZ = target.z, tW = target.w;
    var vX = vel.x, vY = vel.y, vZ = vel.z, vW = vel.w;
    await _chunked(count, cs, ye, function (s, e) {
        for (var i = s; i < e; i++) {
            _sqC[0] = cX[i]; _sqC[1] = cY[i]; _sqC[2] = cZ[i]; _sqC[3] = cW[i];
            _sqT[0] = tX[i]; _sqT[1] = tY[i]; _sqT[2] = tZ[i]; _sqT[3] = tW[i];
            _sqV[0] = vX[i]; _sqV[1] = vY[i]; _sqV[2] = vZ[i]; _sqV[3] = vW[i];
            quat.springDamp(_sqC, _sqC, _sqT, _sqV, stArr ? stArr[i] : smoothTime, dt, maxSpeed);
            oX[i] = _sqC[0]; oY[i] = _sqC[1]; oZ[i] = _sqC[2]; oW[i] = _sqC[3];
            vX[i] = _sqV[0]; vY[i] = _sqV[1]; vZ[i] = _sqV[2]; vW[i] = _sqV[3];
        }
    });
    return out;
}
/** Chunked dual-quaternion spring — staged through module scratch. */
async function soaDQSpringDampChunked(out, current, target, vel, smoothTime, dt, maxSpeed, count, cs, ye) {
    count = count === undefined ? out.count : count;
    var o = out.arrays, c = current.arrays, t = target.arrays, v = vel.arrays;
    await _chunked(count, cs, ye, function (s, e) {
        for (var i = s; i < e; i++) {
            for (var k = 0; k < 8; k++) { _dqC[k] = c[k][i]; _dqT[k] = t[k][i]; _dqV[k] = v[k][i]; }
            quat2.springDamp(_dqC, _dqC, _dqT, _dqV, smoothTime, dt, maxSpeed);
            for (var k2 = 0; k2 < 8; k2++) { o[k2][i] = _dqC[k2]; v[k2][i] = _dqV[k2]; }
        }
    });
    return out;
}

// ============================================================================
// Classes — ES2017-compatible (no static blocks / private fields: parses on
// older Android WebViews). Warm-up runs once at module load via IIFE below.
// ============================================================================
/** Reusable precision-aware quaternion scratch handle. */
class QuatScratch {
    static acquire() {
        var w = QuatScratch._warmPool.pop();
        return w || new QuatScratch();
    }
    static release(s) {
        if (s) { s.reset(); QuatScratch._warmPool.push(s); }
    }
    constructor() {
        this.q = new (getArrayType())(4);
        this.q[3] = 1;
    }
    reset() { this.q[0] = 0; this.q[1] = 0; this.q[2] = 0; this.q[3] = 1; return this; }
    set(x, y, z, w) { this.q[0] = x; this.q[1] = y; this.q[2] = z; this.q[3] = w; return this; }
    get x() { return this.q[0]; }
    get y() { return this.q[1]; }
    get z() { return this.q[2]; }
    get w() { return this.q[3]; }
    // Diagnostic iterator — allocates per next(); never use in a frame loop.
    [Symbol.iterator]() {
        var i = 0;
        var q = this.q;
        return {
            next: function () {
                var done = i >= 4;
                return { value: done ? undefined : q[i++], done: done };
            }
        };
    }
}
QuatScratch._warmPool = [];
(function _warmQuatScratch() {
    for (var i = 0; i < 16; i++) QuatScratch._warmPool.push(new QuatScratch());
})();

/** Reusable dual-quaternion scratch (pool-backed handles or `new`). */
class DQScratch {
    static acquire() { return _dqScratchPool.acquire(); }
    static release(s) { _dqScratchPool.release(s); }
    constructor() {
        this.q = new (getArrayType())(8);
        this.q[3] = 1;
    }
    reset() { this.q.fill(0); this.q[3] = 1; return this; }
}

/**
 * Full quaternion batch driver — the object a user holds for 1M+ instances.
 * All SOAs are tracked with 000_Math_module so setPrecision() migrates them
 * live; migration is a user action, never a frame-loop cost (§10/§16).
 */
class QuatBatchState {
    constructor(count, options) {
        options = options || {};
        this.count = count;
        this.quats = createQuatSOA(count);
        this.targets = createQuatSOA(count);
        this.velocities = createQuatSOA(count);
        // createQuatSOA defaults w=1 (identity) — velocities must start at 0.
        this.velocities.x.fill(0); this.velocities.y.fill(0);
        this.velocities.z.fill(0); this.velocities.w.fill(0);
        this.smoothTime = options.smoothTime !== undefined ? options.smoothTime : 0.15;
        this.maxSpeed = options.maxSpeed !== undefined ? options.maxSpeed : Infinity;
        this.tAnimated = new Float32Array(count);
        this._tracked = options.track !== false;
        if (this._tracked) {
            trackSOA(this.quats); trackSOA(this.targets); trackSOA(this.velocities);
        }
    }
    setTarget(i, x, y, z, w) {
        this.targets.x[i] = x; this.targets.y[i] = y;
        this.targets.z[i] = z; this.targets.w[i] = w;
        return this;
    }
    copyTargetsFrom(soa) { quat.soaCopy(this.targets, soa); return this; }
    /** Critically-damped spring toward targets. Use FIXED dt for determinism. */
    stepSpring(dt) {
        quat.soaSpringDamp(this.quats, this.quats, this.targets, this.velocities,
            this.smoothTime, dt, this.maxSpeed);
        return this;
    }
    stepSpringChunked(dt, cs, ye) {
        return soaSpringDampChunked(this.quats, this.quats, this.targets, this.velocities,
            this.smoothTime, dt, this.maxSpeed, this.count, cs, ye);
    }
    /** Slerp current → arbitrary target SOA by scalar or per-element t. */
    slerpTo(targetSOA, t) { soaSlerp(this.quats, this.quats, targetSOA, t, this.count); return this; }
    /** Fixed-dt angular-velocity integration (§45/§51). */
    integrate(omegaSOA, dt) {
        soaIntegrateAngularVelocity(this.quats, this.quats, omegaSOA, dt, this.count);
        return this;
    }
    /** Single-pass compose + dirty-range upload (§25/§28). */
    uploadTo(mesh, positions, scales, origin) {
        return syncInstancedMesh(mesh, this.quats, positions, scales, this.count, origin);
    }
    dispose() {
        if (this._tracked) {
            untrackSOA(this.quats); untrackSOA(this.targets); untrackSOA(this.velocities);
        }
        return this;
    }
}
function createQuatBatchState(count, options) { return new QuatBatchState(count, options); }

// ============================================================================
// Precision-change listener — rebuild scratch pools with the new dtype at
// SWITCH time (setup path). Existing tracked SOAs are migrated by 000 itself.
// ============================================================================
onPrecisionChange(function () {
    _scratchPool.clear();   _scratchPool.preload(128);
    _dqScratchPool.clear(); _dqScratchPool.preload(64);
    _defaultQuatPool.clear(); _defaultQuatPool.preload(128);
    _defaultDQPool.clear();   _defaultDQPool.preload(64);
    QuatScratch._warmPool.length = 0;
    for (var i = 0; i < 16; i++) QuatScratch._warmPool.push(new QuatScratch());
});

// ============================================================================
// Exports
// ============================================================================
// ---- Precision plumbing (pass-through) ----
exports.getPrecision = getPrecision;
exports.setPrecision = setPrecision;
exports.onPrecisionChange = onPrecisionChange;
exports.getSOAPrecision = getSOAPrecision;
exports.getArrayType = getArrayType;
exports.trackSOA = trackSOA;
exports.untrackSOA = untrackSOA;
// ---- Precision-aware SOA builders ----
exports.createQuatSOA = createQuatSOA;
exports.createQuat2SOA = createQuat2SOA;
exports.createVec3SOA = createVec3SOA;
// ---- Constants (Blueprint §34: pre-allocated, never per-frame literals) ----
exports.AXIS_X = AXIS_X;
exports.AXIS_Y = AXIS_Y;
exports.AXIS_Z = AXIS_Z;
exports.UP = UP;
exports.DEFAULT_BEND_AXIS = DEFAULT_BEND_AXIS;
exports.EULER_ORDERS = EULER_ORDERS;
// ---- Scalar core ----
exports.create = create;
exports.identity = identity;
exports.clone = clone;
exports.copy = copy;
exports.set = set;
exports.fromValues = fromValues;
exports.add = add;
exports.subtract = subtract;
exports.scale = scale;
exports.negate = negate;
exports.multiply = multiply;
exports.dot = dot;
exports.length = length;
exports.sqrLength = sqrLength;
exports.normalize = normalize;
exports.conjugate = conjugate;
exports.invert = invert;
exports.slerp = slerp;
exports.nlerp = nlerp;
exports.lerp = lerp;
exports.squad = squad;
exports.bezier = bezier;
exports.fromAxisAngle = fromAxisAngle;
exports.toAxisAngle = toAxisAngle;
exports.fromEuler = fromEuler;
exports.toEuler = toEuler;
exports.fromMat3 = fromMat3;
exports.toMat3 = toMat3;
exports.fromMat4 = fromMat4;
exports.toMat4 = toMat4;
exports.fromTo = fromTo;
exports.lookAt = lookAt;
exports.aimQuat = aimQuat;
exports.random = random;
exports.randomFromNoise = randomFromNoise;
exports.randomDirectional = randomDirectional;
exports.rotateX = rotateX;
exports.rotateY = rotateY;
exports.rotateZ = rotateZ;
exports.rotateAxis = rotateAxis;
exports.equals = equals;
exports.approxEquals = approxEquals;
exports.angle = quat.getAngle;
exports.fromAngularVelocity = fromAngularVelocity;
exports.integrateAngularVelocity = integrateAngularVelocity;
// ---- Swing-twist ----
exports.swingTwist = swingTwist;
exports.swingTwistBatch = swingTwistBatch;
// ---- Natural IK ----
exports.fromDirection = fromDirection;
exports.boneRotation = boneRotation;
exports.twoBoneQuats = twoBoneQuats;
exports.springDamp = quat.springDamp;
exports.springLookAt = quat.springLookAt;
// ---- Orbital ----
exports.fromVelocity = fromVelocity;
exports.fromOrbitalElements = fromOrbitalElements;
exports.toOrbitalElements = toOrbitalElements;
exports.orbitalFrame = orbitalFrame;
// ---- Procedural ----
exports.fromSpherical = fromSpherical;
exports.fromNoise = fromNoise;
// ---- Color ----
exports.fromHue = fromHue;
exports.applyHue = applyHue;
exports.applyHueVec3 = applyHueVec3;
// ---- Animation ----
exports.poseBlend = poseBlend;
exports.keyframeSlerp = keyframeSlerp;
// ---- Dual quaternions (scalar) ----
exports.dqCreate = dqCreate;
exports.dqIdentity = dqIdentity;
exports.dqClone = dqClone;
exports.dqCopy = dqCopy;
exports.dqMultiply = dqMultiply;
exports.dqConjugate = dqConjugate;
exports.dqNormalize = dqNormalize;
exports.dqFromTRS = dqFromTRS;
exports.dqToTRS = dqToTRS;
exports.dqTransformPoint = dqTransformPoint;
exports.dqSlerp = dqSlerp;
exports.dqLookAt = dqLookAt;
// ---- Double-single precision bridge (Blueprint §26, corrected) ----
exports.dsSubInto = dsSubInto;
exports.dsSubF32 = dsSubF32;
exports.dqFromWorldDS = dqFromWorldDS;
exports.soaDQFromWorldDS = soaDQFromWorldDS;
exports.soaDQFromWorldDSChunked = soaDQFromWorldDSChunked;
// ---- Instanced render bridge (Blueprint §25/§28) ----
exports.composeTRSIntoFlat = composeTRSIntoFlat;
exports.syncInstancedMesh = syncInstancedMesh;
exports.soaToMat4TRS = soaToMat4TRS;
// ---- Fixed-step determinism (Blueprint §51) ----
exports.createFixedStepScheduler = M.createFixedStepScheduler;
// ---- Pools ----
exports.createQuatPool = createQuatPool;
exports.acquireQuat = acquireQuat;
exports.releaseQuat = releaseQuat;
exports.createDQPool = createDQPool;
exports.acquireDQ = acquireDQ;
exports.releaseDQ = releaseDQ;
// ---- SOA (sync) ----
exports.soaMultiply = soaMultiply;
exports.soaConjugate = soaConjugate;
exports.soaInvert = soaInvert;
exports.soaNormalize = soaNormalize;
exports.soaDot = soaDot;
exports.soaSlerp = soaSlerp;
exports.soaNlerp = soaNlerp;
exports.soaLookAt = soaLookAt;
exports.soaFromVelocity = soaFromVelocity;
exports.soaFromOrbitalElements = soaFromOrbitalElements;
exports.soaFromNoise = soaFromNoise;
exports.soaSwingTwist = soaSwingTwist;
exports.soaApplyHue = soaApplyHue;
exports.soaRotateVec3 = soaRotateVec3;
exports.soaDQSkin = soaDQSkin;
exports.soaDQBlend = soaDQBlend;
exports.soaFromAxisAngle = soaFromAxisAngle;
exports.soaFromEuler = soaFromEuler;
exports.soaToMat3 = soaToMat3;
exports.soaIntegrateAngularVelocity = soaIntegrateAngularVelocity;
exports.soaSpringDamp = quat.soaSpringDamp;
exports.soaDQSpringDamp = quat2.soaSpringDamp;
// ---- DQ SOA re-exports (corrected 009 pipeline) ----
exports.soaDQMultiply = quat2.soaMultiply;
exports.soaDQNormalize = quat2.soaNormalize;
exports.soaDQConjugate = quat2.soaConjugate;
exports.soaDQInvert = quat2.soaInvert;
exports.soaDQFromRotationTranslation = quat2.soaFromRotationTranslation;
exports.soaDQGetTranslation = quat2.soaGetTranslation;
exports.soaDQTransformPoint = quat2.soaTransformPoint;
exports.soaDQToMat4 = quat2.soaToMat4;
exports.soaDQToMat4Chunked = quat2.soaToMat4Chunked;
exports.soaDQTransformPointChunked = quat2.soaTransformPointChunked;
exports.soaDQRecenter = quat2.soaRecenter;
exports.soaDQLookAt = quat2.soaLookAtDQ;
exports.soaDQFromOrbitalElements = quat2.soaFromOrbitalElements;
// ---- SOA (chunked async) ----
exports.soaMultiplyChunked = soaMultiplyChunked;
exports.soaNormalizeChunked = soaNormalizeChunked;
exports.soaSlerpChunked = soaSlerpChunked;
exports.soaLookAtChunked = soaLookAtChunked;
exports.soaFromVelocityChunked = soaFromVelocityChunked;
exports.soaFromOrbitalElementsChunked = soaFromOrbitalElementsChunked;
exports.soaFromNoiseChunked = soaFromNoiseChunked;
exports.soaRotateVec3Chunked = soaRotateVec3Chunked;
exports.soaDQSkinChunked = soaDQSkinChunked;
exports.soaDQBlendChunked = soaDQBlendChunked;
exports.soaFromAxisAngleChunked = soaFromAxisAngleChunked;
exports.soaFromEulerChunked = soaFromEulerChunked;
exports.soaToMat3Chunked = soaToMat3Chunked;
exports.soaIntegrateAngularVelocityChunked = soaIntegrateAngularVelocityChunked;
exports.soaSpringDampChunked = soaSpringDampChunked;
exports.soaDQSpringDampChunked = soaDQSpringDampChunked;
// ---- Batch state / classes ----
exports.QuatBatchState = QuatBatchState;
exports.createQuatBatchState = createQuatBatchState;
exports.QuatScratch = QuatScratch;
exports.DQScratch = DQScratch;