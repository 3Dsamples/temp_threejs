//File number : 057
// File : src/math/057_rotation-representations.js
//Description : Complete rotation-representation system — every representation used in real-time 3D and each pairwise conversion. Supports: quaternion (XYZW), Euler angles in all 24 conventions (12 Tait-Bryan + 12 proper-Euler; uppercase = intrinsic, lowercase = extrinsic, SciPy convention), axis-angle (3D axis + angle), rotation vector (compact log map, so(3) → ℝ³), Rodrigues parameters / Gibbs vector / Cayley transform, Modified Rodrigues Parameters (MRP, stereographic from the unit 3-sphere) with shadow switching, swing-twist decomposition, Hopf fibration (S³ → S² + S¹) with a correct analytic inverse, dual 4D rotation (SO(4) isoclinic pair), exponential map (so(3) → SO(3)) with Taylor fallback, logarithmic map (SO(3) → so(3)) with Taylor fallback, short-arc quaternion construction from two vectors, and physics-correct exponential-map integration of angular velocity. Provides all-pairs dispatchers (`toQuat`, `fromQuat`, `convert`), SOA batch versions for 1M+ instances, chunked async variants yielding via `scheduler.yield()` / `MessageChannel`, pooled zero-GC scratch state, precision-aware typed-array storage (`000_Math_module.js` live-swap Float16/Float32/Float64), and hemisphere-corrected short-arc slerp. All representations are dimensionless, so the same code serves mm-scale sprite billboards and Mpc-scale galaxy orientation fields.
// Zero-GC Compliance : Strict adherence to the Enhanced Zero-GC ECS mandate. No closures, no array literals, no Map/Set, and no dynamic allocations in any hot loop. Euler-order lookup is a frozen init-time object (no Set). All scratch is pooled with buffer-preserving release. Chunked async kernels inline their loops (no per-call callbacks). Quaternion math is unrolled scalar FMA. All allocations occur exclusively at module init / pool growth.
//Corrections : ESM imports/exports only (no require/exports). Fixed: 24-order Euler registry (was a duplicated 30-entry list with trailing spaces and a Set), general intrinsic/extrinsic Euler compose + extract with gimbal-lock handling (was delegating every order to a 6-order quat.fromEuler), Gibbs/Rodrigues reconstruction (was using the MRP formula), Hopf inverse (now an exact analytic lift), shortSlerp array-literal allocation, per-element array literals in axis-angle SOA, `_fastSinCos` object allocation, `_chunked` closure allocation, RotationScratch unbounded push/pop pool, RotationBatchState Set/forEach listeners, pool release discarding buffers, mat4 scale-safe quaternion extraction, and numerous syntax/typographical corruptions.
//Added : integrateAngularVelocity (exp-map, world/body frame) + SOA/chunked, quatFromTwoVectors + SOA/chunked, soaQuatNormalize + chunked, soaSwingTwist / soaQuatFromSwingTwist + chunked, soaShortSlerpPerTChunked, and chunked variants for every SOA kernel.
//License : MIT
// ============================================================================
// Directive Prologues
// ============================================================================
"use strict";

// ============================================================================
// Import (ES Modules — sibling files within the 54-file math topology)
// ============================================================================
import {
    common,
    getArrayType,
    onPrecisionChange,
    createQuatSOA,
    createVec3SOA,
    createMat3SOA
} from './000_Math_module.js';

// ============================================================================
// Variable Declarations — constants (init-time only)
// ============================================================================
const PI      = Math.PI;
const TAU     = PI * 2;
const HALF_PI = PI * 0.5;
const EPSILON = 1e-9;
const GIMBAL_EPS = 1e-7;

// All 24 Euler conventions.
// Uppercase = intrinsic (rotating axes), lowercase = extrinsic (fixed axes).
// 12 Tait-Bryan (i ≠ j ≠ k) + 12 proper Euler (i === k).
const EULER_ORDERS = Object.freeze([
    "XYZ", "XZY", "YXZ", "YZX", "ZXY", "ZYX",
    "XYX", "XZX", "YXY", "YZY", "ZXZ", "ZYZ",
    "xyz", "xzy", "yxz", "yzx", "zxy", "zyx",
    "xyx", "xzx", "yxy", "yzy", "zxz", "zyz"
]);

// Packed order info (init-time frozen object — no Set, no per-call allocation).
// bits: i(0-1) | j(2-3) | k(4-5) | intrinsic(6) | properEuler(7) | epsPlus(8)
const _EULER_INFO = Object.create(null);

function _axisOf(ch) {
    const c = ch | 32; // to lowercase
    return c === 120 ? 0 : c === 121 ? 1 : 2;
}

(function buildEulerInfo() {
    for (let n = 0; n < EULER_ORDERS.length; n++) {
        const s = EULER_ORDERS[n];
        const i = _axisOf(s.charCodeAt(0));
        const j = _axisOf(s.charCodeAt(1));
        const k = _axisOf(s.charCodeAt(2));
        const intrinsic = s.charCodeAt(0) < 97 ? 1 : 0;
        const proper = i === k ? 1 : 0;
        const epsPlus = j === (i + 1) % 3 ? 1 : 0;
        _EULER_INFO[s] = i | (j << 2) | (k << 4) | (intrinsic << 6) | (proper << 7) | (epsPlus << 8);
    }
    Object.freeze(_EULER_INFO);
})();

// Module-level scalar scratch (single-threaded, non-reentrant within a call).
const _qTmp  = new Float64Array(4);
const _m3Tmp = new Float64Array(9);
const _eTmp  = new Float64Array(3);
const _axTmp = new Float64Array(3);

// Euler compose accumulator (module-level numbers — zero-GC, no array).
let _eqx = 0, _eqy = 0, _eqz = 0, _eqw = 1;

// ============================================================================
// Zero-GC scratch pool — buffer-preserving release, shared hoisted helpers
// ============================================================================
function _rotationScratchFactory() {
    const T = getArrayType();
    return {
        q:  new T(4),
        v:  new T(3),
        m3: new T(9),
        m4: new T(16),
        s:  new T(4),
        t:  new T(4)
    };
}

function _rotationScratchReset(s) {
    s.q[0] = s.q[1] = s.q[2] = 0; s.q[3] = 1;
    s.v[0] = s.v[1] = s.v[2] = 0;
    s.m3.fill(0);
    s.m4.fill(0); s.m4[0] = s.m4[5] = s.m4[10] = s.m4[15] = 1;
    s.s[0] = s.s[1] = s.s[2] = 0; s.s[3] = 1;
    s.t[0] = s.t[1] = s.t[2] = 0; s.t[3] = 1;
}

const _rotationScratchPool = common.createPool(_rotationScratchFactory, 32, _rotationScratchReset);

// Pre-warm at init so steady-state frame-loop acquisition never allocates.
for (let _pw = 0; _pw < 32; _pw++) {
    const _s = _rotationScratchPool.acquire() || _rotationScratchFactory();
    _rotationScratchReset(_s);
    _rotationScratchPool.release(_s);
}

function acquireRotationScratch() {
    return _rotationScratchPool.acquire() || _rotationScratchFactory();
}

function releaseRotationScratch(s) {
    if (s) _rotationScratchPool.release(s);
}

function createRotationScratchPool(capacity) {
    return common.createPool(_rotationScratchFactory, capacity || 32, _rotationScratchReset);
}

// ============================================================================
// Function Declarations — Utility / scalar quaternion helpers
// ============================================================================
function isValidEulerOrder(order) {
    return _EULER_INFO[order] !== undefined;
}

function _clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

function _quatNormalize(out, q) {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    const len = Math.sqrt(x * x + y * y + z * z + w * w);
    if (len < 1e-12) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1; return out; }
    const inv = 1 / len;
    out[0] = x * inv; out[1] = y * inv; out[2] = z * inv; out[3] = w * inv;
    return out;
}

// Right-multiply the Euler accumulator by an elementary axis rotation.
// q ← q ⊗ (sin(θ/2)·e_axis, cos(θ/2)). Unrolled scalar FMA (zero-GC).
function _eMul(axis, s, c) {
    const x = _eqx, y = _eqy, z = _eqz, w = _eqw;
    if (axis === 0) {
        _eqx = w * s + x * c;
        _eqy = y * c + z * s;
        _eqz = z * c - y * s;
        _eqw = w * c - x * s;
    } else if (axis === 1) {
        _eqx = x * c - z * s;
        _eqy = w * s + y * c;
        _eqz = z * c + x * s;
        _eqw = w * c - y * s;
    } else {
        _eqx = x * c + y * s;
        _eqy = y * c - x * s;
        _eqz = w * s + z * c;
        _eqw = w * c - z * s;
    }
}

// ============================================================================
// Function Declarations — Quaternion ↔ Euler (all 24 conventions)
// ============================================================================
/**
 * Build a unit quaternion from Euler angles (radians) in the given order.
 * Uppercase = intrinsic, lowercase = extrinsic. Default "ZYX".
 * General compose via three elementary axis quaternions (no delegation to a
 * 6-order helper), so every Tait-Bryan and proper-Euler sequence is correct.
 */
function quatFromEuler(out, x, y, z, order) {
    const info = _EULER_INFO[order === undefined ? "ZYX" : order];
    if (info === undefined) {
        out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
        return out;
    }
    let i = info & 3, j = (info >> 2) & 3, k = (info >> 4) & 3;
    let a = x, b = y, c = z;
    if (((info >> 6) & 1) === 0) {
        // Extrinsic (i,j,k,a,b,c) ≡ intrinsic (k,j,i,c,b,a).
        const ti = i; i = k; k = ti;
        const ta = a; a = c; c = ta;
    }
    _eqx = 0; _eqy = 0; _eqz = 0; _eqw = 1;
    let h = a * 0.5; _eMul(i, Math.sin(h), Math.cos(h));
    h = b * 0.5;     _eMul(j, Math.sin(h), Math.cos(h));
    h = c * 0.5;     _eMul(k, Math.sin(h), Math.cos(h));
    out[0] = _eqx; out[1] = _eqy; out[2] = _eqz; out[3] = _eqw;
    return _quatNormalize(out, out);
}

/**
 * Extract Euler angles (radians) from a unit quaternion in the given order.
 * Writes out[0..2]. Handles gimbal lock deterministically (sets third angle 0).
 */
function eulerFromQuat(q, order, out) {
    out = out || _eTmp;
    mat3FromQuat(_m3Tmp, q);
    return eulerFromMat3(out, _m3Tmp, order);
}

/**
 * Extract Euler angles from a column-major rotation matrix (gl-matrix layout).
 * General intrinsic/extrinsic solution with Tait-Bryan and proper-Euler branches.
 */
function eulerFromMat3(out, m, order) {
    const info = _EULER_INFO[order === undefined ? "ZYX" : order];
    if (info === undefined) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
    let i = info & 3, j = (info >> 2) & 3, k = (info >> 4) & 3;
    const intrinsic = (info >> 6) & 1;
    const proper = (info >> 7) & 1;
    const eps = ((info >> 8) & 1) ? 1 : -1;
    if (intrinsic === 0) { const ti = i; i = k; k = ti; }

    let a, b, c;
    if (proper === 0) {
        // Tait-Bryan: R[i][k] = sin(b)·eps  (R[r][c] = m[c*3+r]).
        const s = _clamp(eps * m[k * 3 + i], -1, 1);
        if (Math.abs(s) < 1 - GIMBAL_EPS) {
            b = Math.asin(s);
            a = Math.atan2(-eps * m[k * 3 + j], m[k * 3 + k]);
            c = Math.atan2(-eps * m[j * 3 + i], m[i * 3 + i]);
        } else {
            b = s > 0 ? HALF_PI : -HALF_PI;
            a = Math.atan2(s * m[i * 3 + j], m[j * 3 + j]);
            c = 0;
        }
    } else {
        // Proper Euler: R[i][i] = cos(b); l is the third axis (3 − i − j).
        const l = 3 - i - j;
        const cb = _clamp(m[i * 3 + i], -1, 1);
        b = Math.acos(cb);
        if (Math.abs(cb) < 1 - GIMBAL_EPS) {
            a = Math.atan2(m[i * 3 + j], -eps * m[i * 3 + l]);
            c = Math.atan2(m[j * 3 + i], eps * m[l * 3 + i]);
        } else if (cb > 0) {
            a = Math.atan2(-eps * m[l * 3 + j], m[j * 3 + j]);
            c = 0;
        } else {
            a = Math.atan2(m[l * 3 + j], eps * m[j * 3 + j]);
            c = 0;
        }
    }
    if (intrinsic === 0) { const ta = a; a = c; c = ta; }
    out[0] = a; out[1] = b; out[2] = c;
    return out;
}

/** Rotation matrix from Euler angles (via quaternion). */
function mat3FromEuler(out, x, y, z, order) {
    quatFromEuler(_qTmp, x, y, z, order);
    return mat3FromQuat(out, _qTmp);
}

// ============================================================================
// Function Declarations — Quaternion ↔ Axis-Angle
// ============================================================================
/** Quaternion from a unit axis + angle (radians). Normalizes the axis. */
function quatFromAxisAngle(out, axis, angle) {
    const ax = axis[0], ay = axis[1], az = axis[2];
    const len = Math.sqrt(ax * ax + ay * ay + az * az);
    if (len < 1e-12) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1; return out; }
    const inv = 1 / len;
    const h = angle * 0.5;
    const s = Math.sin(h) * inv;
    out[0] = ax * s; out[1] = ay * s; out[2] = az * s; out[3] = Math.cos(h);
    return out;
}

/**
 * Extract axis-angle from a unit quaternion. Writes out[0..2] = unit axis,
 * out[3] = angle in [0, π]. Zero-GC (no array literals).
 */
function axisAngleFromQuat(out, q) {
    let x = q[0], y = q[1], z = q[2], w = q[3];
    if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
    const sinHalf = Math.sqrt(x * x + y * y + z * z);
    if (sinHalf < 1e-12) {
        out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
        return out;
    }
    const angle = 2 * Math.atan2(sinHalf, w);
    const inv = 1 / sinHalf;
    out[0] = x * inv; out[1] = y * inv; out[2] = z * inv; out[3] = angle;
    return out;
}

function axisAngleFromEuler(out, x, y, z, order) {
    quatFromEuler(_qTmp, x, y, z, order);
    return axisAngleFromQuat(out, _qTmp);
}

function eulerFromAxisAngle(out, x, y, z, angle, order) {
    _axTmp[0] = x; _axTmp[1] = y; _axTmp[2] = z;
    quatFromAxisAngle(_qTmp, _axTmp, angle);
    return eulerFromQuat(_qTmp, order, out);
}

// ============================================================================
// Function Declarations — Quaternion ↔ Matrix
// ============================================================================
/** Quaternion from a column-major rotation matrix (trace method). */
function quatFromMat3(out, m) {
    const m00 = m[0], m11 = m[4], m22 = m[8];
    const trace = m00 + m11 + m22;
    if (trace > 0) {
        let root = Math.sqrt(trace + 1);
        out[3] = 0.5 * root;
        root = 0.5 / root;
        out[0] = (m[5] - m[7]) * root;
        out[1] = (m[6] - m[2]) * root;
        out[2] = (m[1] - m[3]) * root;
    } else {
        let i = 0;
        if (m11 > m00) i = 1;
        if (m22 > (i === 0 ? m00 : m11)) i = 2;
        const j = (i + 1) % 3, k = (j + 1) % 3;
        let root = Math.sqrt(m[i * 3 + i] - m[j * 3 + j] - m[k * 3 + k] + 1);
        out[i] = 0.5 * root;
        root = 0.5 / root;
        out[3] = (m[j * 3 + k] - m[k * 3 + j]) * root;
        out[j] = (m[j * 3 + i] + m[i * 3 + j]) * root;
        out[k] = (m[k * 3 + i] + m[i * 3 + k]) * root;
    }
    return _quatNormalize(out, out);
}

/** Column-major rotation matrix from a unit quaternion. */
function mat3FromQuat(out, q) {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, yx = y * x2, yy = y * y2;
    const zx = z * x2, zy = z * y2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    out[0] = 1 - yy - zz; out[1] = yx + wz;     out[2] = zx - wy;
    out[3] = yx - wz;     out[4] = 1 - xx - zz; out[5] = zy + wx;
    out[6] = zx + wy;     out[7] = zy - wx;     out[8] = 1 - xx - yy;
    return out;
}

/** Quaternion from a mat4 — normalizes the upper 3×3 columns (scale-safe). */
function quatFromMat4(out, m) {
    const m3 = _m3Tmp;
    for (let c = 0; c < 3; c++) {
        const o = c * 4;
        const cx = m[o], cy = m[o + 1], cz = m[o + 2];
        const len = Math.sqrt(cx * cx + cy * cy + cz * cz);
        const inv = len > 1e-12 ? 1 / len : 0;
        m3[c * 3]     = cx * inv;
        m3[c * 3 + 1] = cy * inv;
        m3[c * 3 + 2] = cz * inv;
    }
    return quatFromMat3(out, m3);
}

/** mat4 from a unit quaternion (translation 0, bottom row [0,0,0,1]). */
function mat4FromQuat(out, q) {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, yx = y * x2, yy = y * y2;
    const zx = z * x2, zy = z * y2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    out[0] = 1 - yy - zz; out[1] = yx + wz;     out[2] = zx - wy;     out[3] = 0;
    out[4] = yx - wz;     out[5] = 1 - xx - zz; out[6] = zy + wx;     out[7] = 0;
    out[8] = zx + wy;     out[9] = zy - wx;     out[10] = 1 - xx - yy; out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
    return out;
}

// ============================================================================
// Function Declarations — Quaternion ↔ Rotation Vector (log/exp map)
// ============================================================================
/** Quaternion from a rotation vector v (exp map). Taylor fallback for tiny |v|. */
function quatFromRotationVector(out, vx, vy, vz) {
    const angle = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (angle < 1e-8) {
        out[0] = vx * 0.5; out[1] = vy * 0.5; out[2] = vz * 0.5; out[3] = 1;
        return _quatNormalize(out, out);
    }
    const h = angle * 0.5;
    const s = Math.sin(h) / angle;
    out[0] = vx * s; out[1] = vy * s; out[2] = vz * s; out[3] = Math.cos(h);
    return out;
}

/** Rotation vector (log map) from a unit quaternion. Shortest arc (angle ≤ π). */
function rotationVectorFromQuat(out, q) {
    let x = q[0], y = q[1], z = q[2], w = q[3];
    if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
    const sinHalf = Math.sqrt(x * x + y * y + z * z);
    if (sinHalf < 1e-8) {
        out[0] = 2 * x; out[1] = 2 * y; out[2] = 2 * z;
        return out;
    }
    const s = (2 * Math.atan2(sinHalf, w)) / sinHalf;
    out[0] = x * s; out[1] = y * s; out[2] = z * s;
    return out;
}

// ============================================================================
// Function Declarations — Quaternion ↔ MRP
// ============================================================================
/** Quaternion from Modified Rodrigues Parameters. q = (2p, 1−|p|²)/(1+|p|²). */
function quatFromMRP(out, px, py, pz) {
    const p2 = px * px + py * py + pz * pz;
    const denom = 1 / (1 + p2);
    out[0] = 2 * px * denom;
    out[1] = 2 * py * denom;
    out[2] = 2 * pz * denom;
    out[3] = (1 - p2) * denom;
    return out;
}

/** MRP from a unit quaternion — short representative (|p| ≤ 1). Never singular. */
function mrpFromQuat(out, q) {
    let x = q[0], y = q[1], z = q[2], w = q[3];
    if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
    const inv = 1 / (1 + w);
    out[0] = x * inv; out[1] = y * inv; out[2] = z * inv;
    return out;
}

/** MRP shadow p' = −p/|p|². Switch when |p| > 1 to stay bounded. */
function mrpShadow(out, px, py, pz) {
    const p2 = px * px + py * py + pz * pz;
    if (p2 < 1e-12) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
    const inv = -1 / p2;
    out[0] = px * inv; out[1] = py * inv; out[2] = pz * inv;
    return out;
}

// ============================================================================
// Function Declarations — Quaternion ↔ Rodrigues / Gibbs / Cayley
// ============================================================================
/**
 * Quaternion from a Gibbs / Rodrigues vector g = tan(θ/2)·axis.
 * Correct reconstruction: q = (g, 1)/√(1+|g|²). (The previous version used the
 * MRP formula, which is wrong for Gibbs parameters.) Singular at θ = π.
 */
function quatFromRodrigues(out, gx, gy, gz) {
    const g2 = gx * gx + gy * gy + gz * gz;
    const inv = 1 / Math.sqrt(1 + g2);
    out[0] = gx * inv; out[1] = gy * inv; out[2] = gz * inv; out[3] = inv;
    return out;
}

/** Gibbs vector g = qvec/qw. Singular at 180° (returns signed Infinity). */
function rodriguesFromQuat(out, q) {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    if (Math.abs(w) < 1e-8) {
        out[0] = x >= 0 ? Infinity : -Infinity;
        out[1] = y >= 0 ? Infinity : -Infinity;
        out[2] = z >= 0 ? Infinity : -Infinity;
        return out;
    }
    const inv = 1 / w;
    out[0] = x * inv; out[1] = y * inv; out[2] = z * inv;
    return out;
}

// ============================================================================
// Function Declarations — Swing-Twist decomposition
// ============================================================================
/**
 * Swing-twist decomposition about a unit twist axis. `out` must be a caller
 * pooled object { swing: quat4, twist: quat4 } (no allocation inside).
 */
function swingTwistFromQuat(out, q, axis) {
    const ax = axis[0], ay = axis[1], az = axis[2];
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    const proj = qx * ax + qy * ay + qz * az;
    const tx = ax * proj, ty = ay * proj, tz = az * proj;
    const tl2 = tx * tx + ty * ty + tz * tz + qw * qw;
    if (tl2 < 1e-14) {
        out.swing[0] = qx; out.swing[1] = qy; out.swing[2] = qz; out.swing[3] = qw;
        out.twist[0] = 0; out.twist[1] = 0; out.twist[2] = 0; out.twist[3] = 1;
        return out;
    }
    const inv = 1 / Math.sqrt(tl2);
    const twx = tx * inv, twy = ty * inv, twz = tz * inv, tww = qw * inv;
    out.twist[0] = twx; out.twist[1] = twy; out.twist[2] = twz; out.twist[3] = tww;
    // swing = q ⊗ conj(twist)
    const cx = -twx, cy = -twy, cz = -twz, cw = tww;
    out.swing[0] = qw * cx + qx * cw + qy * cz - qz * cy;
    out.swing[1] = qw * cy + qy * cw + qz * cx - qx * cz;
    out.swing[2] = qw * cz + qz * cw + qx * cy - qy * cx;
    out.swing[3] = qw * cw - qx * cx - qy * cy - qz * cz;
    return out;
}

/** Recompose q = swing ⊗ twist. */
function quatFromSwingTwist(out, swing, twist) {
    const ax = swing[0], ay = swing[1], az = swing[2], aw = swing[3];
    const bx = twist[0], by = twist[1], bz = twist[2], bw = twist[3];
    out[0] = aw * bx + ax * bw + ay * bz - az * by;
    out[1] = aw * by + ay * bw + az * bx - ax * bz;
    out[2] = aw * bz + az * bw + ax * by - ay * bx;
    out[3] = aw * bw - ax * bx - ay * by - az * bz;
    return out;
}

// ============================================================================
// Function Declarations — Exponential / Logarithmic map (so(3) ↔ SO(3))
// ============================================================================
function expSO3(out, vx, vy, vz) {
    return quatFromRotationVector(out, vx, vy, vz);
}

function logSO3(out, q) {
    return rotationVectorFromQuat(out, q);
}

// ============================================================================
// Function Declarations — Hopf fibration (S³ → S² + S¹)
// ============================================================================
/**
 * Hopf map of a unit quaternion to (s1,s2,s3) on S² plus fiber phase θ.
 * Valid Hopf invariant: s1²+s2²+s3² = 1 for unit q. `out` is a caller pooled
 * object { s1, s2, s3, theta } (fields are numbers; no allocation inside).
 */
function hopfFromQuat(out, q) {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    out.s1 = 2 * (x * w + y * z);
    out.s2 = 2 * (y * w - x * z);
    out.s3 = 1 - 2 * (x * x + y * y);
    out.theta = Math.atan2(z, w);
    return out;
}

/**
 * Exact analytic inverse Hopf lift. Given (s1,s2,s3) on S² and phase θ,
 * reconstruct the unit quaternion. Handles the south-pole degenerate fiber.
 */
function quatFromHopf(out, s1, s2, s3, theta) {
    const V = (1 + s3) * 0.5; // c² + d²
    const ct = Math.cos(theta), st = Math.sin(theta);
    if (V < 1e-12) {
        out[0] = ct; out[1] = st; out[2] = 0; out[3] = 0;
        return _quatNormalize(out, out);
    }
    const sqV = Math.sqrt(V);
    const c = sqV * st, d = sqV * ct;
    const inv2V = 1 / (2 * V);
    out[0] = (d * s1 - c * s2) * inv2V;
    out[1] = (c * s1 + d * s2) * inv2V;
    out[2] = c;
    out[3] = d;
    return _quatNormalize(out, out);
}

// ============================================================================
// Function Declarations — Dual 4D rotation (SO(4) isoclinic pair)
// ============================================================================
/**
 * Embed a 3D quaternion as a left-isoclinic 4D rotation (q, identity).
 * `out` is a caller pooled object { left: quat4, right: quat4 }.
 */
function dualRotationFromQuat(out, q) {
    out.left[0] = q[0]; out.left[1] = q[1]; out.left[2] = q[2]; out.left[3] = q[3];
    out.right[0] = 0; out.right[1] = 0; out.right[2] = 0; out.right[3] = 1;
    return out;
}

// ============================================================================
// Function Declarations — Short-arc slerp / two-vector / angular integration
// ============================================================================
/** Slerp with automatic hemisphere correction (shortest arc). Zero-GC. */
function shortSlerp(out, a, b, t) {
    const ax = a[0], ay = a[1], az = a[2], aw = a[3];
    let bx = b[0], by = b[1], bz = b[2], bw = b[3];
    let d = ax * bx + ay * by + az * bz + aw * bw;
    if (d < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; d = -d; }
    let s0, s1;
    if (1 - d > EPSILON) {
        const omega = Math.acos(_clamp(d, -1, 1));
        const sinom = Math.sin(omega);
        s0 = Math.sin((1 - t) * omega) / sinom;
        s1 = Math.sin(t * omega) / sinom;
    } else {
        s0 = 1 - t; s1 = t;
    }
    out[0] = s0 * ax + s1 * bx;
    out[1] = s0 * ay + s1 * by;
    out[2] = s0 * az + s1 * bz;
    out[3] = s0 * aw + s1 * bw;
    return _quatNormalize(out, out);
}

/** Shortest-arc quaternion rotating unit vector `from` onto unit vector `to`. */
function quatFromTwoVectors(out, from, to) {
    const ax = from[0], ay = from[1], az = from[2];
    const bx = to[0], by = to[1], bz = to[2];
    const d = ax * bx + ay * by + az * bz;
    if (d < -1 + 1e-8) {
        // Opposite: pick any perpendicular axis.
        let cx = 0, cy = az, cz = -ay; // cross(from, (1,0,0))
        if (cy * cy + cz * cz < 1e-12) { cx = -az; cy = 0; cz = ax; } // cross(from,(0,1,0))
        const len = Math.sqrt(cx * cx + cy * cy + cz * cz);
        const inv = 1 / len;
        out[0] = cx * inv; out[1] = cy * inv; out[2] = cz * inv; out[3] = 0;
        return out;
    }
    const cx = ay * bz - az * by;
    const cy = az * bx - ax * bz;
    const cz = ax * by - ay * bx;
    out[0] = cx; out[1] = cy; out[2] = cz; out[3] = 1 + d;
    return _quatNormalize(out, out);
}

/**
 * Physics-correct exponential-map integration of angular velocity.
 * q' = normalize(exp(ω·dt) ⊗ q) for world-frame ω (bodyFrame=true → q ⊗ exp).
 * Deterministic fixed-step friendly (blueprint §14/§21/§51). Zero-GC.
 */
function integrateAngularVelocity(out, q, wx, wy, wz, dt, bodyFrame) {
    const theta = Math.sqrt(wx * wx + wy * wy + wz * wz) * dt;
    const h = theta * 0.5;
    const k = theta < 1e-8 ? 0.5 : Math.sin(h) / theta;
    const dx = wx * dt * k, dy = wy * dt * k, dz = wz * dt * k;
    const dw = theta < 1e-8 ? 1 - h * h * 0.5 : Math.cos(h);
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    if (bodyFrame === true) {
        out[0] = qw * dx + qx * dw + qy * dz - qz * dy;
        out[1] = qw * dy + qy * dw + qz * dx - qx * dz;
        out[2] = qw * dz + qz * dw + qx * dy - qy * dx;
        out[3] = qw * dw - qx * dx - qy * dy - qz * dz;
    } else {
        out[0] = dw * qx + dx * qw + dy * qz - dz * qy;
        out[1] = dw * qy + dy * qw + dz * qx - dx * qz;
        out[2] = dw * qz + dz * qw + dx * qy - dy * qx;
        out[3] = dw * qw - dx * qx - dy * qy - dz * qz;
    }
    return _quatNormalize(out, out);
}

// ============================================================================
// Function Declarations — Generic all-pairs dispatchers (out-first, zero-GC)
// ============================================================================
/**
 * Convert any representation to a quaternion. `data` is read-only (array or
 * caller-owned object). No allocation. `options.order` for Euler.
 */
function toQuat(out, kind, data, options) {
    switch (kind) {
        case "euler":
            return quatFromEuler(out, data.x, data.y, data.z, options && options.order);
        case "axisAngle":
            _axTmp[0] = data.x; _axTmp[1] = data.y; _axTmp[2] = data.z;
            return quatFromAxisAngle(out, _axTmp, data.angle);
        case "rotVec":
            return quatFromRotationVector(out, data.x, data.y, data.z);
        case "mrp":
            return quatFromMRP(out, data.x, data.y, data.z);
        case "rodrigues":
            return quatFromRodrigues(out, data.x, data.y, data.z);
        case "mat3":
            return quatFromMat3(out, data);
        case "mat4":
            return quatFromMat4(out, data);
        case "swingTwist":
            return quatFromSwingTwist(out, data.swing, data.twist);
        case "hopf":
            return quatFromHopf(out, data.s1, data.s2, data.s3, data.theta);
        case "quat":
            out[0] = data[0]; out[1] = data[1]; out[2] = data[2]; out[3] = data[3];
            return out;
        default:
            out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
            return out;
    }
}

/**
 * Convert a quaternion to any representation, writing into caller-supplied
 * `out` (typed array, or pooled object for swingTwist/hopf/dual4D). Zero-GC.
 */
function fromQuat(out, q, kind, options) {
    switch (kind) {
        case "euler":      return eulerFromQuat(q, options && options.order, out);
        case "axisAngle":  return axisAngleFromQuat(out, q);
        case "rotVec":     return rotationVectorFromQuat(out, q);
        case "mrp":        return mrpFromQuat(out, q);
        case "rodrigues":  return rodriguesFromQuat(out, q);
        case "mat3":       return mat3FromQuat(out, q);
        case "mat4":       return mat4FromQuat(out, q);
        case "swingTwist": return swingTwistFromQuat(out, q, (options && options.axis) || _axTmp);
        case "hopf":       return hopfFromQuat(out, q);
        case "dual4D":     return dualRotationFromQuat(out, q);
        case "quat":
            out[0] = q[0]; out[1] = q[1]; out[2] = q[2]; out[3] = q[3];
            return out;
        default:
            return out;
    }
}

/** Convert between any two representations via a pooled quaternion. Zero-GC. */
function convert(out, fromKind, fromData, toKind, options) {
    const s = acquireRotationScratch();
    toQuat(s.q, fromKind, fromData, options);
    fromQuat(out, s.q, toKind, options);
    releaseRotationScratch(s);
    return out;
}

// ============================================================================
// Function Declarations — SOA (sync, Zero-GC)
// ============================================================================
function soaQuatFromEuler(outQuat, xs, ys, zs, order, count) {
    count = count === undefined ? outQuat.count : count;
    const qx = outQuat.x, qy = outQuat.y, qz = outQuat.z, qw = outQuat.w;
    const q = _qTmp;
    for (let i = 0; i < count; i++) {
        quatFromEuler(q, xs[i], ys[i], zs[i], order);
        qx[i] = q[0]; qy[i] = q[1]; qz[i] = q[2]; qw[i] = q[3];
    }
    return outQuat;
}

function soaEulerFromQuat(outX, outY, outZ, quats, order, count) {
    count = count === undefined ? quats.count : count;
    const qx = quats.x, qy = quats.y, qz = quats.z, qw = quats.w;
    const q = _qTmp, e = _eTmp;
    for (let i = 0; i < count; i++) {
        q[0] = qx[i]; q[1] = qy[i]; q[2] = qz[i]; q[3] = qw[i];
        eulerFromQuat(q, order, e);
        outX[i] = e[0]; outY[i] = e[1]; outZ[i] = e[2];
    }
    return outX;
}

function soaQuatFromAxisAngle(outQuat, axisSOA, angleArr, count) {
    count = count === undefined ? outQuat.count : count;
    const qx = outQuat.x, qy = outQuat.y, qz = outQuat.z, qw = outQuat.w;
    const ax = axisSOA.x, ay = axisSOA.y, az = axisSOA.z;
    const isArr = angleArr && angleArr.BYTES_PER_ELEMENT !== undefined;
    for (let i = 0; i < count; i++) {
        const x = ax[i], y = ay[i], z = az[i];
        const len = Math.sqrt(x * x + y * y + z * z);
        const inv = len > 1e-12 ? 1 / len : 0;
        const h = (isArr ? angleArr[i] : angleArr) * 0.5;
        const s = Math.sin(h) * inv;
        qx[i] = x * s; qy[i] = y * s; qz[i] = z * s; qw[i] = Math.cos(h);
    }
    return outQuat;
}

function soaAxisAngleFromQuat(outAxis, outAngle, quats, count) {
    count = count === undefined ? quats.count : count;
    const qx = quats.x, qy = quats.y, qz = quats.z, qw = quats.w;
    const ax = outAxis.x, ay = outAxis.y, az = outAxis.z;
    for (let i = 0; i < count; i++) {
        let x = qx[i], y = qy[i], z = qz[i], w = qw[i];
        if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
        const sinHalf = Math.sqrt(x * x + y * y + z * z);
        if (sinHalf < 1e-12) {
            ax[i] = 1; ay[i] = 0; az[i] = 0; outAngle[i] = 0;
        } else {
            const inv = 1 / sinHalf;
            ax[i] = x * inv; ay[i] = y * inv; az[i] = z * inv;
            outAngle[i] = 2 * Math.atan2(sinHalf, w);
        }
    }
    return outAxis;
}

function soaQuatFromRotationVector(outQuat, vec, count) {
    count = count === undefined ? outQuat.count : count;
    const qx = outQuat.x, qy = outQuat.y, qz = outQuat.z, qw = outQuat.w;
    const vx = vec.x, vy = vec.y, vz = vec.z;
    for (let i = 0; i < count; i++) {
        const x = vx[i], y = vy[i], z = vz[i];
        const angle = Math.sqrt(x * x + y * y + z * z);
        if (angle < 1e-8) {
            const nx = x * 0.5, ny = y * 0.5, nz = z * 0.5;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz + 1);
            const inv = 1 / len;
            qx[i] = nx * inv; qy[i] = ny * inv; qz[i] = nz * inv; qw[i] = inv;
        } else {
            const h = angle * 0.5;
            const s = Math.sin(h) / angle;
            qx[i] = x * s; qy[i] = y * s; qz[i] = z * s; qw[i] = Math.cos(h);
        }
    }
    return outQuat;
}

function soaRotationVectorFromQuat(outVec, quats, count) {
    count = count === undefined ? quats.count : count;
    const qx = quats.x, qy = quats.y, qz = quats.z, qw = quats.w;
    const ox = outVec.x, oy = outVec.y, oz = outVec.z;
    for (let i = 0; i < count; i++) {
        let x = qx[i], y = qy[i], z = qz[i], w = qw[i];
        if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
        const sinHalf = Math.sqrt(x * x + y * y + z * z);
        if (sinHalf < 1e-8) {
            ox[i] = 2 * x; oy[i] = 2 * y; oz[i] = 2 * z;
        } else {
            const s = (2 * Math.atan2(sinHalf, w)) / sinHalf;
            ox[i] = x * s; oy[i] = y * s; oz[i] = z * s;
        }
    }
    return outVec;
}

function soaQuatFromMRP(outQuat, mrp, count) {
    count = count === undefined ? outQuat.count : count;
    const qx = outQuat.x, qy = outQuat.y, qz = outQuat.z, qw = outQuat.w;
    const px = mrp.x, py = mrp.y, pz = mrp.z;
    for (let i = 0; i < count; i++) {
        const x = px[i], y = py[i], z = pz[i];
        const p2 = x * x + y * y + z * z;
        const denom = 1 / (1 + p2);
        qx[i] = 2 * x * denom; qy[i] = 2 * y * denom; qz[i] = 2 * z * denom;
        qw[i] = (1 - p2) * denom;
    }
    return outQuat;
}

function soaMRPFromQuat(outMRP, quats, count) {
    count = count === undefined ? quats.count : count;
    const qx = quats.x, qy = quats.y, qz = quats.z, qw = quats.w;
    const px = outMRP.x, py = outMRP.y, pz = outMRP.z;
    for (let i = 0; i < count; i++) {
        let x = qx[i], y = qy[i], z = qz[i], w = qw[i];
        if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
        const inv = 1 / (1 + w);
        px[i] = x * inv; py[i] = y * inv; pz[i] = z * inv;
    }
    return outMRP;
}

function soaQuatFromMat3(outQuat, matSOA, count) {
    count = count === undefined ? outQuat.count : count;
    const qx = outQuat.x, qy = outQuat.y, qz = outQuat.z, qw = outQuat.w;
    const m00 = matSOA.m00, m01 = matSOA.m01, m02 = matSOA.m02;
    const m10 = matSOA.m10, m11 = matSOA.m11, m12 = matSOA.m12;
    const m20 = matSOA.m20, m21 = matSOA.m21, m22 = matSOA.m22;
    const m = _m3Tmp, q = _qTmp;
    for (let i = 0; i < count; i++) {
        m[0] = m00[i]; m[1] = m01[i]; m[2] = m02[i];
        m[3] = m10[i]; m[4] = m11[i]; m[5] = m12[i];
        m[6] = m20[i]; m[7] = m21[i]; m[8] = m22[i];
        quatFromMat3(q, m);
        qx[i] = q[0]; qy[i] = q[1]; qz[i] = q[2]; qw[i] = q[3];
    }
    return outQuat;
}

function soaMat3FromQuat(outMat, quats, count) {
    count = count === undefined ? quats.count : count;
    const qx = quats.x, qy = quats.y, qz = quats.z, qw = quats.w;
    const m00 = outMat.m00, m01 = outMat.m01, m02 = outMat.m02;
    const m10 = outMat.m10, m11 = outMat.m11, m12 = outMat.m12;
    const m20 = outMat.m20, m21 = outMat.m21, m22 = outMat.m22;
    for (let i = 0; i < count; i++) {
        const x = qx[i], y = qy[i], z = qz[i], w = qw[i];
        const x2 = x + x, y2 = y + y, z2 = z + z;
        const xx = x * x2, yx = y * x2, yy = y * y2;
        const zx = z * x2, zy = z * y2, zz = z * z2;
        const wx = w * x2, wy = w * y2, wz = w * z2;
        m00[i] = 1 - yy - zz; m01[i] = yx + wz;     m02[i] = zx - wy;
        m10[i] = yx - wz;     m11[i] = 1 - xx - zz; m12[i] = zy + wx;
        m20[i] = zx + wy;     m21[i] = zy - wx;     m22[i] = 1 - xx - yy;
    }
    return outMat;
}

function soaShortSlerp(out, a, b, t, count) {
    count = count === undefined ? out.count : count;
    const oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    const aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    const bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    for (let i = 0; i < count; i++) {
        const ax = aX[i], ay = aY[i], az = aZ[i], aw = aW[i];
        let bx = bX[i], by = bY[i], bz = bZ[i], bw = bW[i];
        let d = ax * bx + ay * by + az * bz + aw * bw;
        if (d < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; d = -d; }
        let s0, s1;
        if (1 - d > EPSILON) {
            const omega = Math.acos(_clamp(d, -1, 1));
            const sinom = Math.sin(omega);
            s0 = Math.sin((1 - t) * omega) / sinom;
            s1 = Math.sin(t * omega) / sinom;
        } else { s0 = 1 - t; s1 = t; }
        oX[i] = s0 * ax + s1 * bx; oY[i] = s0 * ay + s1 * by;
        oZ[i] = s0 * az + s1 * bz; oW[i] = s0 * aw + s1 * bw;
    }
    return out;
}

function soaShortSlerpPerT(out, a, b, ts, count) {
    count = count === undefined ? out.count : count;
    const oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    const aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    const bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    for (let i = 0; i < count; i++) {
        const ax = aX[i], ay = aY[i], az = aZ[i], aw = aW[i];
        let bx = bX[i], by = bY[i], bz = bZ[i], bw = bW[i];
        let d = ax * bx + ay * by + az * bz + aw * bw;
        if (d < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; d = -d; }
        const t = ts[i];
        let s0, s1;
        if (1 - d > EPSILON) {
            const omega = Math.acos(_clamp(d, -1, 1));
            const sinom = Math.sin(omega);
            s0 = Math.sin((1 - t) * omega) / sinom;
            s1 = Math.sin(t * omega) / sinom;
        } else { s0 = 1 - t; s1 = t; }
        oX[i] = s0 * ax + s1 * bx; oY[i] = s0 * ay + s1 * by;
        oZ[i] = s0 * az + s1 * bz; oW[i] = s0 * aw + s1 * bw;
    }
    return out;
}

function soaQuatNormalize(out, quats, count) {
    count = count === undefined ? out.count : count;
    const oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    const aX = quats.x, aY = quats.y, aZ = quats.z, aW = quats.w;
    for (let i = 0; i < count; i++) {
        const x = aX[i], y = aY[i], z = aZ[i], w = aW[i];
        const len = Math.sqrt(x * x + y * y + z * z + w * w);
        if (len < 1e-12) { oX[i] = 0; oY[i] = 0; oZ[i] = 0; oW[i] = 1; }
        else {
            const inv = 1 / len;
            oX[i] = x * inv; oY[i] = y * inv; oZ[i] = z * inv; oW[i] = w * inv;
        }
    }
    return out;
}

function soaQuatFromTwoVectors(out, fromSOA, toSOA, count) {
    count = count === undefined ? out.count : count;
    const oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    const fx = fromSOA.x, fy = fromSOA.y, fz = fromSOA.z;
    const tx = toSOA.x, ty = toSOA.y, tz = toSOA.z;
    for (let i = 0; i < count; i++) {
        const ax = fx[i], ay = fy[i], az = fz[i];
        const bx = tx[i], by = ty[i], bz = tz[i];
        const d = ax * bx + ay * by + az * bz;
        let cx, cy, cz, cw;
        if (d < -1 + 1e-8) {
            cx = 0; cy = az; cz = -ay;
            if (cy * cy + cz * cz < 1e-12) { cx = -az; cy = 0; cz = ax; }
            const len = Math.sqrt(cx * cx + cy * cy + cz * cz);
            const inv = 1 / len;
            cx *= inv; cy *= inv; cz *= inv; cw = 0;
        } else {
            cx = ay * bz - az * by; cy = az * bx - ax * bz; cz = ax * by - ay * bx; cw = 1 + d;
            const len = Math.sqrt(cx * cx + cy * cy + cz * cz + cw * cw);
            const inv = len > 1e-12 ? 1 / len : 0;
            cx *= inv; cy *= inv; cz *= inv; cw *= inv;
        }
        oX[i] = cx; oY[i] = cy; oZ[i] = cz; oW[i] = cw;
    }
    return out;
}

function soaIntegrateAngularVelocity(out, quats, wx, wy, wz, dt, count, bodyFrame) {
    count = count === undefined ? out.count : count;
    const oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    const aX = quats.x, aY = quats.y, aZ = quats.z, aW = quats.w;
    const dtArr = dt && dt.BYTES_PER_ELEMENT !== undefined;
    const body = bodyFrame === true;
    for (let i = 0; i < count; i++) {
        const dti = dtArr ? dt[i] : dt;
        const wxi = wx[i], wyi = wy[i], wzi = wz[i];
        const theta = Math.sqrt(wxi * wxi + wyi * wyi + wzi * wzi) * dti;
        const h = theta * 0.5;
        const k = theta < 1e-8 ? 0.5 : Math.sin(h) / theta;
        const dx = wxi * dti * k, dy = wyi * dti * k, dz = wzi * dti * k;
        const dw = theta < 1e-8 ? 1 - h * h * 0.5 : Math.cos(h);
        const qx = aX[i], qy = aY[i], qz = aZ[i], qw = aW[i];
        let rx, ry, rz, rw;
        if (body) {
            rx = qw * dx + qx * dw + qy * dz - qz * dy;
            ry = qw * dy + qy * dw + qz * dx - qx * dz;
            rz = qw * dz + qz * dw + qx * dy - qy * dx;
            rw = qw * dw - qx * dx - qy * dy - qz * dz;
        } else {
            rx = dw * qx + dx * qw + dy * qz - dz * qy;
            ry = dw * qy + dy * qw + dz * qx - dx * qz;
            rz = dw * qz + dz * qw + dx * qy - dy * qx;
            rw = dw * qw - dx * qx - dy * qy - dz * qz;
        }
        const len = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw);
        const inv = len > 1e-12 ? 1 / len : 0;
        oX[i] = rx * inv; oY[i] = ry * inv; oZ[i] = rz * inv; oW[i] = rw * inv;
    }
    return out;
}

function soaSwingTwistFromQuat(outSwing, outTwist, quats, axis, count) {
    count = count === undefined ? quats.count : count;
    const ax = axis[0], ay = axis[1], az = axis[2];
    const qx = quats.x, qy = quats.y, qz = quats.z, qw = quats.w;
    const sx = outSwing.x, sy = outSwing.y, sz = outSwing.z, sw = outSwing.w;
    const tx = outTwist.x, ty = outTwist.y, tz = outTwist.z, tw = outTwist.w;
    for (let i = 0; i < count; i++) {
        const x = qx[i], y = qy[i], z = qz[i], w = qw[i];
        const proj = x * ax + y * ay + z * az;
        const px = ax * proj, py = ay * proj, pz = az * proj;
        const tl2 = px * px + py * py + pz * pz + w * w;
        if (tl2 < 1e-14) {
            sx[i] = x; sy[i] = y; sz[i] = z; sw[i] = w;
            tx[i] = 0; ty[i] = 0; tz[i] = 0; tw[i] = 1;
            continue;
        }
        const inv = 1 / Math.sqrt(tl2);
        const twx = px * inv, twy = py * inv, twz = pz * inv, tww = w * inv;
        tx[i] = twx; ty[i] = twy; tz[i] = twz; tw[i] = tww;
        const cx = -twx, cy = -twy, cz = -twz, cw = tww;
        sx[i] = w * cx + x * cw + y * cz - z * cy;
        sy[i] = w * cy + y * cw + z * cx - x * cz;
        sz[i] = w * cz + z * cw + x * cy - y * cx;
        sw[i] = w * cw - x * cx - y * cy - z * cz;
    }
    return outSwing;
}

function soaQuatFromSwingTwist(out, swing, twist, count) {
    count = count === undefined ? out.count : count;
    const oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    const ax = swing.x, ay = swing.y, az = swing.z, aw = swing.w;
    const bx = twist.x, by = twist.y, bz = twist.z, bw = twist.w;
    for (let i = 0; i < count; i++) {
        const sx = ax[i], sy = ay[i], sz = az[i], sw = aw[i];
        const tx = bx[i], ty = by[i], tz = bz[i], tw = bw[i];
        oX[i] = sw * tx + sx * tw + sy * tz - sz * ty;
        oY[i] = sw * ty + sy * tw + sz * tx - sx * tz;
        oZ[i] = sw * tz + sz * tw + sx * ty - sy * tx;
        oW[i] = sw * tw - sx * tx - sy * ty - sz * tz;
    }
    return out;
}

// ============================================================================
// Function Declarations — SOA (chunked async, inlined loops, zero closures)
// ============================================================================
async function soaQuatFromEulerChunked(outQuat, xs, ys, zs, order, count, cs, ye) {
    count = count === undefined ? outQuat.count : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const qx = outQuat.x, qy = outQuat.y, qz = outQuat.z, qw = outQuat.w;
    const q = _qTmp;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            quatFromEuler(q, xs[i], ys[i], zs[i], order);
            qx[i] = q[0]; qy[i] = q[1]; qz[i] = q[2]; qw[i] = q[3];
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return outQuat;
}

async function soaEulerFromQuatChunked(outX, outY, outZ, quats, order, count, cs, ye) {
    count = count === undefined ? quats.count : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const qx = quats.x, qy = quats.y, qz = quats.z, qw = quats.w;
    const q = _qTmp, e = _eTmp;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            q[0] = qx[i]; q[1] = qy[i]; q[2] = qz[i]; q[3] = qw[i];
            eulerFromQuat(q, order, e);
            outX[i] = e[0]; outY[i] = e[1]; outZ[i] = e[2];
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return outX;
}

async function soaQuatFromAxisAngleChunked(outQuat, axisSOA, angleArr, count, cs, ye) {
    count = count === undefined ? outQuat.count : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const qx = outQuat.x, qy = outQuat.y, qz = outQuat.z, qw = outQuat.w;
    const ax = axisSOA.x, ay = axisSOA.y, az = axisSOA.z;
    const isArr = angleArr && angleArr.BYTES_PER_ELEMENT !== undefined;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            const x = ax[i], y = ay[i], z = az[i];
            const len = Math.sqrt(x * x + y * y + z * z);
            const inv = len > 1e-12 ? 1 / len : 0;
            const h = (isArr ? angleArr[i] : angleArr) * 0.5;
            const s = Math.sin(h) * inv;
            qx[i] = x * s; qy[i] = y * s; qz[i] = z * s; qw[i] = Math.cos(h);
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return outQuat;
}

async function soaAxisAngleFromQuatChunked(outAxis, outAngle, quats, count, cs, ye) {
    count = count === undefined ? quats.count : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const qx = quats.x, qy = quats.y, qz = quats.z, qw = quats.w;
    const ax = outAxis.x, ay = outAxis.y, az = outAxis.z;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            let x = qx[i], y = qy[i], z = qz[i], w = qw[i];
            if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
            const sinHalf = Math.sqrt(x * x + y * y + z * z);
            if (sinHalf < 1e-12) {
                ax[i] = 1; ay[i] = 0; az[i] = 0; outAngle[i] = 0;
            } else {
                const inv = 1 / sinHalf;
                ax[i] = x * inv; ay[i] = y * inv; az[i] = z * inv;
                outAngle[i] = 2 * Math.atan2(sinHalf, w);
            }
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return outAxis;
}

async function soaQuatFromRotationVectorChunked(outQuat, vec, count, cs, ye) {
    count = count === undefined ? outQuat.count : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const qx = outQuat.x, qy = outQuat.y, qz = outQuat.z, qw = outQuat.w;
    const vx = vec.x, vy = vec.y, vz = vec.z;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            const x = vx[i], y = vy[i], z = vz[i];
            const angle = Math.sqrt(x * x + y * y + z * z);
            if (angle < 1e-8) {
                const nx = x * 0.5, ny = y * 0.5, nz = z * 0.5;
                const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + 1);
                qx[i] = nx * inv; qy[i] = ny * inv; qz[i] = nz * inv; qw[i] = inv;
            } else {
                const h = angle * 0.5;
                const s = Math.sin(h) / angle;
                qx[i] = x * s; qy[i] = y * s; qz[i] = z * s; qw[i] = Math.cos(h);
            }
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return outQuat;
}

async function soaRotationVectorFromQuatChunked(outVec, quats, count, cs, ye) {
    count = count === undefined ? quats.count : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const qx = quats.x, qy = quats.y, qz = quats.z, qw = quats.w;
    const ox = outVec.x, oy = outVec.y, oz = outVec.z;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            let x = qx[i], y = qy[i], z = qz[i], w = qw[i];
            if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
            const sinHalf = Math.sqrt(x * x + y * y + z * z);
            if (sinHalf < 1e-8) {
                ox[i] = 2 * x; oy[i] = 2 * y; oz[i] = 2 * z;
            } else {
                const s = (2 * Math.atan2(sinHalf, w)) / sinHalf;
                ox[i] = x * s; oy[i] = y * s; oz[i] = z * s;
            }
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return outVec;
}

async function soaQuatFromMRPChunked(outQuat, mrp, count, cs, ye) {
    count = count === undefined ? outQuat.count : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const qx = outQuat.x, qy = outQuat.y, qz = outQuat.z, qw = outQuat.w;
    const px = mrp.x, py = mrp.y, pz = mrp.z;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            const x = px[i], y = py[i], z = pz[i];
            const p2 = x * x + y * y + z * z;
            const denom = 1 / (1 + p2);
            qx[i] = 2 * x * denom; qy[i] = 2 * y * denom; qz[i] = 2 * z * denom;
            qw[i] = (1 - p2) * denom;
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return outQuat;
}

async function soaMRPFromQuatChunked(outMRP, quats, count, cs, ye) {
    count = count === undefined ? quats.count : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const qx = quats.x, qy = quats.y, qz = quats.z, qw = quats.w;
    const px = outMRP.x, py = outMRP.y, pz = outMRP.z;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            let x = qx[i], y = qy[i], z = qz[i], w = qw[i];
            if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
            const inv = 1 / (1 + w);
            px[i] = x * inv; py[i] = y * inv; pz[i] = z * inv;
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return outMRP;
}

async function soaQuatFromMat3Chunked(outQuat, matSOA, count, cs, ye) {
    count = count === undefined ? outQuat.count : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const qx = outQuat.x, qy = outQuat.y, qz = outQuat.z, qw = outQuat.w;
    const m00 = matSOA.m00, m01 = matSOA.m01, m02 = matSOA.m02;
    const m10 = matSOA.m10, m11 = matSOA.m11, m12 = matSOA.m12;
    const m20 = matSOA.m20, m21 = matSOA.m21, m22 = matSOA.m22;
    const m = _m3Tmp, q = _qTmp;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            m[0] = m00[i]; m[1] = m01[i]; m[2] = m02[i];
            m[3] = m10[i]; m[4] = m11[i]; m[5] = m12[i];
            m[6] = m20[i]; m[7] = m21[i]; m[8] = m22[i];
            quatFromMat3(q, m);
            qx[i] = q[0]; qy[i] = q[1]; qz[i] = q[2]; qw[i] = q[3];
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return outQuat;
}

async function soaMat3FromQuatChunked(outMat, quats, count, cs, ye) {
    count = count === undefined ? quats.count : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const qx = quats.x, qy = quats.y, qz = quats.z, qw = quats.w;
    const m00 = outMat.m00, m01 = outMat.m01, m02 = outMat.m02;
    const m10 = outMat.m10, m11 = outMat.m11, m12 = outMat.m12;
    const m20 = outMat.m20, m21 = outMat.m21, m22 = outMat.m22;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            const x = qx[i], y = qy[i], z = qz[i], w = qw[i];
            const x2 = x + x, y2 = y + y, z2 = z + z;
            const xx = x * x2, yx = y * x2, yy = y * y2;
            const zx = z * x2, zy = z * y2, zz = z * z2;
            const wx = w * x2, wy = w * y2, wz = w * z2;
            m00[i] = 1 - yy - zz; m01[i] = yx + wz;     m02[i] = zx - wy;
            m10[i] = yx - wz;     m11[i] = 1 - xx - zz; m12[i] = zy + wx;
            m20[i] = zx + wy;     m21[i] = zy - wx;     m22[i] = 1 - xx - yy;
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return outMat;
}

async function soaShortSlerpChunked(out, a, b, t, count, cs, ye) {
    count = count === undefined ? out.count : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    const aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    const bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    const isArr = t && t.BYTES_PER_ELEMENT !== undefined;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            const ti = isArr ? t[i] : t;
            const ax = aX[i], ay = aY[i], az = aZ[i], aw = aW[i];
            let bx = bX[i], by = bY[i], bz = bZ[i], bw = bW[i];
            let d = ax * bx + ay * by + az * bz + aw * bw;
            if (d < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; d = -d; }
            let s0, s1;
            if (1 - d > EPSILON) {
                const omega = Math.acos(_clamp(d, -1, 1));
                const sinom = Math.sin(omega);
                s0 = Math.sin((1 - ti) * omega) / sinom;
                s1 = Math.sin(ti * omega) / sinom;
            } else { s0 = 1 - ti; s1 = ti; }
            oX[i] = s0 * ax + s1 * bx; oY[i] = s0 * ay + s1 * by;
            oZ[i] = s0 * az + s1 * bz; oW[i] = s0 * aw + s1 * bw;
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaShortSlerpPerTChunked(out, a, b, ts, count, cs, ye) {
    count = count === undefined ? out.count : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    const aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
    const bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            const ax = aX[i], ay = aY[i], az = aZ[i], aw = aW[i];
            let bx = bX[i], by = bY[i], bz = bZ[i], bw = bW[i];
            let d = ax * bx + ay * by + az * bz + aw * bw;
            if (d < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; d = -d; }
            const t = ts[i];
            let s0, s1;
            if (1 - d > EPSILON) {
                const omega = Math.acos(_clamp(d, -1, 1));
                const sinom = Math.sin(omega);
                s0 = Math.sin((1 - t) * omega) / sinom;
                s1 = Math.sin(t * omega) / sinom;
            } else { s0 = 1 - t; s1 = t; }
            oX[i] = s0 * ax + s1 * bx; oY[i] = s0 * ay + s1 * by;
            oZ[i] = s0 * az + s1 * bz; oW[i] = s0 * aw + s1 * bw;
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaQuatNormalizeChunked(out, quats, count, cs, ye) {
    count = count === undefined ? out.count : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    const aX = quats.x, aY = quats.y, aZ = quats.z, aW = quats.w;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            const x = aX[i], y = aY[i], z = aZ[i], w = aW[i];
            const len = Math.sqrt(x * x + y * y + z * z + w * w);
            if (len < 1e-12) { oX[i] = 0; oY[i] = 0; oZ[i] = 0; oW[i] = 1; }
            else {
                const inv = 1 / len;
                oX[i] = x * inv; oY[i] = y * inv; oZ[i] = z * inv; oW[i] = w * inv;
            }
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaQuatFromTwoVectorsChunked(out, fromSOA, toSOA, count, cs, ye) {
    count = count === undefined ? out.count : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    const fx = fromSOA.x, fy = fromSOA.y, fz = fromSOA.z;
    const tx = toSOA.x, ty = toSOA.y, tz = toSOA.z;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            const ax = fx[i], ay = fy[i], az = fz[i];
            const bx = tx[i], by = ty[i], bz = tz[i];
            const d = ax * bx + ay * by + az * bz;
            let cx, cy, cz, cw;
            if (d < -1 + 1e-8) {
                cx = 0; cy = az; cz = -ay;
                if (cy * cy + cz * cz < 1e-12) { cx = -az; cy = 0; cz = ax; }
                const inv = 1 / Math.sqrt(cx * cx + cy * cy + cz * cz);
                cx *= inv; cy *= inv; cz *= inv; cw = 0;
            } else {
                cx = ay * bz - az * by; cy = az * bx - ax * bz; cz = ax * by - ay * bx; cw = 1 + d;
                const len = Math.sqrt(cx * cx + cy * cy + cz * cz + cw * cw);
                const inv = len > 1e-12 ? 1 / len : 0;
                cx *= inv; cy *= inv; cz *= inv; cw *= inv;
            }
            oX[i] = cx; oY[i] = cy; oZ[i] = cz; oW[i] = cw;
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaIntegrateAngularVelocityChunked(out, quats, wx, wy, wz, dt, count, cs, ye, bodyFrame) {
    count = count === undefined ? out.count : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    const aX = quats.x, aY = quats.y, aZ = quats.z, aW = quats.w;
    const dtArr = dt && dt.BYTES_PER_ELEMENT !== undefined;
    const body = bodyFrame === true;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            const dti = dtArr ? dt[i] : dt;
            const wxi = wx[i], wyi = wy[i], wzi = wz[i];
            const theta = Math.sqrt(wxi * wxi + wyi * wyi + wzi * wzi) * dti;
            const h = theta * 0.5;
            const k = theta < 1e-8 ? 0.5 : Math.sin(h) / theta;
            const dx = wxi * dti * k, dy = wyi * dti * k, dz = wzi * dti * k;
            const dw = theta < 1e-8 ? 1 - h * h * 0.5 : Math.cos(h);
            const qx = aX[i], qy = aY[i], qz = aZ[i], qw = aW[i];
            let rx, ry, rz, rw;
            if (body) {
                rx = qw * dx + qx * dw + qy * dz - qz * dy;
                ry = qw * dy + qy * dw + qz * dx - qx * dz;
                rz = qw * dz + qz * dw + qx * dy - qy * dx;
                rw = qw * dw - qx * dx - qy * dy - qz * dz;
            } else {
                rx = dw * qx + dx * qw + dy * qz - dz * qy;
                ry = dw * qy + dy * qw + dz * qx - dx * qz;
                rz = dw * qz + dz * qw + dx * qy - dy * qx;
                rw = dw * qw - dx * qx - dy * qy - dz * qz;
            }
            const len = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw);
            const inv = len > 1e-12 ? 1 / len : 0;
            oX[i] = rx * inv; oY[i] = ry * inv; oZ[i] = rz * inv; oW[i] = rw * inv;
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaSwingTwistFromQuatChunked(outSwing, outTwist, quats, axis, count, cs, ye) {
    count = count === undefined ? quats.count : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const ax = axis[0], ay = axis[1], az = axis[2];
    const qx = quats.x, qy = quats.y, qz = quats.z, qw = quats.w;
    const sx = outSwing.x, sy = outSwing.y, sz = outSwing.z, sw = outSwing.w;
    const tx = outTwist.x, ty = outTwist.y, tz = outTwist.z, tw = outTwist.w;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            const x = qx[i], y = qy[i], z = qz[i], w = qw[i];
            const proj = x * ax + y * ay + z * az;
            const px = ax * proj, py = ay * proj, pz = az * proj;
            const tl2 = px * px + py * py + pz * pz + w * w;
            if (tl2 < 1e-14) {
                sx[i] = x; sy[i] = y; sz[i] = z; sw[i] = w;
                tx[i] = 0; ty[i] = 0; tz[i] = 0; tw[i] = 1;
                continue;
            }
            const inv = 1 / Math.sqrt(tl2);
            const twx = px * inv, twy = py * inv, twz = pz * inv, tww = w * inv;
            tx[i] = twx; ty[i] = twy; tz[i] = twz; tw[i] = tww;
            const cx = -twx, cy = -twy, cz = -twz, cw = tww;
            sx[i] = w * cx + x * cw + y * cz - z * cy;
            sy[i] = w * cy + y * cw + z * cx - x * cz;
            sz[i] = w * cz + z * cw + x * cy - y * cx;
            sw[i] = w * cw - x * cx - y * cy - z * cz;
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return outSwing;
}

async function soaQuatFromSwingTwistChunked(out, swing, twist, count, cs, ye) {
    count = count === undefined ? out.count : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
    const ax = swing.x, ay = swing.y, az = swing.z, aw = swing.w;
    const bx = twist.x, by = twist.y, bz = twist.z, bw = twist.w;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            const sx = ax[i], sy = ay[i], sz = az[i], sw = aw[i];
            const tx = bx[i], ty = by[i], tz = bz[i], tw = bw[i];
            oX[i] = sw * tx + sx * tw + sy * tz - sz * ty;
            oY[i] = sw * ty + sy * tw + sz * tx - sx * tz;
            oZ[i] = sw * tz + sz * tw + sx * ty - sy * tx;
            oW[i] = sw * tw - sx * tx - sy * ty - sz * tz;
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

// ============================================================================
// Class Declarations
// ============================================================================
/**
 * Reusable precision-aware rotation scratch. Fixed-capacity warm pool with
 * swap-remove (no Array.splice / push growth allocations, no Set/Map).
 */
class RotationScratch {
    static #pool = new Array(32);
    static #count = 0;
    static {
        for (let i = 0; i < 16; i++) {
            RotationScratch.#pool[RotationScratch.#count++] = new RotationScratch();
        }
    }
    static acquire() {
        if (RotationScratch.#count > 0) {
            RotationScratch.#count--;
            const s = RotationScratch.#pool[RotationScratch.#count];
            RotationScratch.#pool[RotationScratch.#count] = null;
            return s;
        }
        return new RotationScratch();
    }
    static release(s) {
        if (!s) return;
        s.reset();
        if (RotationScratch.#count < 32) {
            RotationScratch.#pool[RotationScratch.#count++] = s;
        }
    }
    constructor() {
        const T = getArrayType();
        this.q  = new T(4);  this.q[3] = 1;
        this.v  = new T(3);
        this.m3 = new T(9);
        this.m4 = new T(16); this.m4[0] = this.m4[5] = this.m4[10] = this.m4[15] = 1;
        this.s  = new T(4);  this.s[3] = 1;
        this.t  = new T(4);  this.t[3] = 1;
    }
    reset() {
        this.q[0] = this.q[1] = this.q[2] = 0; this.q[3] = 1;
        this.v[0] = this.v[1] = this.v[2] = 0;
        this.s[0] = this.s[1] = this.s[2] = 0; this.s[3] = 1;
        this.t[0] = this.t[1] = this.t[2] = 0; this.t[3] = 1;
        return this;
    }
}

/**
 * Batch state for 1M+ rotation conversions. Holds quaternion / vec3 / mat3
 * SOAs plus per-instance Euler, axis-angle, MRP, rotation-vector, swing/twist,
 * and angular-velocity channels. New instances pick up the live array type via
 * getArrayType() after setPrecision() in 000_Math_module.js.
 */
class RotationBatchState {
    constructor(count, options) {
        options = options || {};
        this.count = count;
        const T = getArrayType();
        this.quat   = createQuatSOA(count);
        this.vec    = createVec3SOA(count);
        this.eulerX = new T(count);
        this.eulerY = new T(count);
        this.eulerZ = new T(count);
        this.axis   = createVec3SOA(count);
        this.angle  = new T(count);
        this.mrp    = createVec3SOA(count);
        this.rotVec = createVec3SOA(count);
        this.mat    = createMat3SOA(count);
        this.swing  = createQuatSOA(count);
        this.twist  = createQuatSOA(count);
        this.wx     = new T(count);
        this.wy     = new T(count);
        this.wz     = new T(count);
        this.twistAxis = new Float64Array(3);
        this.twistAxis[1] = 1; // default Y twist axis
    }
    quatFromEuler(order) { return soaQuatFromEuler(this.quat, this.eulerX, this.eulerY, this.eulerZ, order, this.count); }
    eulerFromQuat(order) { return soaEulerFromQuat(this.eulerX, this.eulerY, this.eulerZ, this.quat, order, this.count); }
    quatFromAxisAngle()  { return soaQuatFromAxisAngle(this.quat, this.axis, this.angle, this.count); }
    axisAngleFromQuat()  { return soaAxisAngleFromQuat(this.axis, this.angle, this.quat, this.count); }
    quatFromRotVec()     { return soaQuatFromRotationVector(this.quat, this.rotVec, this.count); }
    rotVecFromQuat()     { return soaRotationVectorFromQuat(this.rotVec, this.quat, this.count); }
    quatFromMRP()        { return soaQuatFromMRP(this.quat, this.mrp, this.count); }
    mrpFromQuat()        { return soaMRPFromQuat(this.mrp, this.quat, this.count); }
    quatFromMat()        { return soaQuatFromMat3(this.quat, this.mat, this.count); }
    matFromQuat()        { return soaMat3FromQuat(this.mat, this.quat, this.count); }
    normalize()          { return soaQuatNormalize(this.quat, this.quat, this.count); }
    swingTwist()         { return soaSwingTwistFromQuat(this.swing, this.twist, this.quat, this.twistAxis, this.count); }
    quatFromSwingTwist() { return soaQuatFromSwingTwist(this.quat, this.swing, this.twist, this.count); }
    integrate(dt, bodyFrame) {
        return soaIntegrateAngularVelocity(this.quat, this.quat, this.wx, this.wy, this.wz, dt, this.count, bodyFrame);
    }
    async quatFromEulerChunked(order, cs, ye) {
        return soaQuatFromEulerChunked(this.quat, this.eulerX, this.eulerY, this.eulerZ, order, this.count, cs, ye);
    }
    async integrateChunked(dt, cs, ye, bodyFrame) {
        return soaIntegrateAngularVelocityChunked(this.quat, this.quat, this.wx, this.wy, this.wz, dt, this.count, cs, ye, bodyFrame);
    }
    reset() {
        this.eulerX.fill(0); this.eulerY.fill(0); this.eulerZ.fill(0);
        this.angle.fill(0); this.wx.fill(0); this.wy.fill(0); this.wz.fill(0);
        return this;
    }
}

function createRotationBatch(count, options) {
    return new RotationBatchState(count, options);
}

// ============================================================================
// Namespace convenience (init-time object graph only)
// ============================================================================
const namespace = {
    quat: {
        fromEuler: quatFromEuler,
        fromAxisAngle: quatFromAxisAngle,
        fromRotationVector: quatFromRotationVector,
        fromMRP: quatFromMRP,
        fromRodrigues: quatFromRodrigues,
        fromMat3: quatFromMat3,
        fromMat4: quatFromMat4,
        fromSwingTwist: quatFromSwingTwist,
        fromHopf: quatFromHopf,
        fromTwoVectors: quatFromTwoVectors,
        normalize: _quatNormalize
    },
    euler: {
        fromQuat: eulerFromQuat,
        fromMat3: eulerFromMat3,
        fromAxisAngle: eulerFromAxisAngle,
        orders: EULER_ORDERS,
        isValid: isValidEulerOrder
    },
    axisAngle: {
        fromQuat: axisAngleFromQuat,
        fromEuler: axisAngleFromEuler,
        toQuat: quatFromAxisAngle
    },
    rotationVector: {
        fromQuat: rotationVectorFromQuat,
        toQuat: quatFromRotationVector,
        exp: expSO3,
        log: logSO3
    },
    mrp: {
        fromQuat: mrpFromQuat,
        toQuat: quatFromMRP,
        shadow: mrpShadow
    },
    rodrigues: {
        fromQuat: rodriguesFromQuat,
        toQuat: quatFromRodrigues
    },
    swingTwist: {
        fromQuat: swingTwistFromQuat,
        toQuat: quatFromSwingTwist
    },
    hopf: {
        fromQuat: hopfFromQuat,
        toQuat: quatFromHopf
    },
    dual4D: {
        fromQuat: dualRotationFromQuat
    },
    slerp: {
        short: shortSlerp
    },
    integrate: {
        angularVelocity: integrateAngularVelocity
    },
    dispatchers: {
        fromQuat: fromQuat,
        toQuat: toQuat,
        convert: convert
    },
    batch: {
        State: RotationBatchState,
        create: createRotationBatch
    }
};

// ============================================================================
// Precision listener — hoisted named handler (no closure allocation).
// Existing buffers are intentionally retained (Zero-GC); new batch states and
// scratch growth pick up the live array type via getArrayType().
// ============================================================================
function _handlePrecisionChange(mode, oldMode) { /* retention policy: no-op */ }
onPrecisionChange(_handlePrecisionChange);

// ============================================================================
// Export Declarations (ES Modules)
// ============================================================================
export {
    // Euler registry
    EULER_ORDERS, isValidEulerOrder,
    // Quaternion ↔ Euler
    quatFromEuler, eulerFromQuat,
    // Quaternion ↔ Axis-Angle
    quatFromAxisAngle, axisAngleFromQuat,
    // Quaternion ↔ Matrix
    quatFromMat3, mat3FromQuat, quatFromMat4, mat4FromQuat,
    // Quaternion ↔ Rotation Vector
    quatFromRotationVector, rotationVectorFromQuat,
    // Quaternion ↔ MRP
    quatFromMRP, mrpFromQuat, mrpShadow,
    // Quaternion ↔ Rodrigues / Gibbs / Cayley
    quatFromRodrigues, rodriguesFromQuat,
    // Swing-Twist
    swingTwistFromQuat, quatFromSwingTwist,
    // Exponential / Logarithmic map
    expSO3, logSO3,
    // Hopf fibration
    hopfFromQuat, quatFromHopf,
    // Dual 4D rotation
    dualRotationFromQuat,
    // Euler ↔ Matrix / Axis-Angle
    mat3FromEuler, eulerFromMat3, axisAngleFromEuler, eulerFromAxisAngle,
    // Short-arc slerp / two-vector / angular integration
    shortSlerp, quatFromTwoVectors, integrateAngularVelocity,
    // Generic dispatchers
    fromQuat, toQuat, convert,
    // SOA (sync)
    soaQuatFromEuler, soaEulerFromQuat,
    soaQuatFromAxisAngle, soaAxisAngleFromQuat,
    soaQuatFromRotationVector, soaRotationVectorFromQuat,
    soaQuatFromMRP, soaMRPFromQuat,
    soaQuatFromMat3, soaMat3FromQuat,
    soaShortSlerp, soaShortSlerpPerT,
    soaQuatNormalize, soaQuatFromTwoVectors, soaIntegrateAngularVelocity,
    soaSwingTwistFromQuat, soaQuatFromSwingTwist,
    // SOA (chunked async)
    soaQuatFromEulerChunked, soaEulerFromQuatChunked,
    soaQuatFromAxisAngleChunked, soaAxisAngleFromQuatChunked,
    soaQuatFromRotationVectorChunked, soaRotationVectorFromQuatChunked,
    soaQuatFromMRPChunked, soaMRPFromQuatChunked,
    soaQuatFromMat3Chunked, soaMat3FromQuatChunked,
    soaShortSlerpChunked, soaShortSlerpPerTChunked,
    soaQuatNormalizeChunked, soaQuatFromTwoVectorsChunked,
    soaIntegrateAngularVelocityChunked,
    soaSwingTwistFromQuatChunked, soaQuatFromSwingTwistChunked,
    // Pools
    RotationScratch, createRotationScratchPool,
    acquireRotationScratch, releaseRotationScratch,
    // Batch state
    RotationBatchState, createRotationBatch,
    // Namespaces
    namespace
};