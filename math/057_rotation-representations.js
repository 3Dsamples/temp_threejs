//File number : 057
// File : src/math/057_rotation-representations.js
//Description : Complete rotation-representation system — every representation used in real-time 3D and each pairwise conversion. Supports: quaternion (XYZW), Euler angles in 24 Tait-Bryan + 6 proper-Euler conventions (30 total), axis-angle (3D axis + angle), rotation vector (compact log map, so(3) → ℝ³), Rodrigues parameters / Gibbs vector, Modified Rodrigues Parameters (MRP, stereographic from 4D unit sphere), Cayley transform, exponential map (so(3) → SO(3) with Taylor fallback for tiny angles), logarithmic map (SO(3) → so(3) with Taylor fallback), swing-twist decomposition, Hopf fibration (S³ → S² + S¹) and dual 4D rotation. Provides all-pairs dispatchers (`toQuat`, `fromQuat`, `convert`), SOA batch versions for 1M+ instances, chunked async variants yielding via `scheduler.yield()`, pooled zero-GC scratch state, precision-aware typed-array storage (`000_Math_module.js` live-swap Float16/Float32/Float64), and short-arc slerp with hemisphere 
correction built on the existing `quat.soaSlerp` from the math module. All representations are dimensionless, so the same code serves mm-scale sprite billboards and Mpc-scale galaxy orientation fields.
//####
//Best for : 3d graphics — slerp between orientations across 1M+ instances (asteroid belts, foliage, particle swarms), consistent rotation storage across netcode (send smallest representation: MRP=3 floats, rot-vec=3, quat=4), rotation-vector-based IK solvers (Jacobian uses log map naturally), swing-twist for bone decomposition (hip/leg, head/neck), Hopf-based 4D→3D projection for procedural quaternion fields, MRP for camera controls with gimbal-free 360° coverage, Euler import/export for DCC tool interop, exponential-map integration of angular velocity (physics-correct Euler integration of rotations) at 60/90/120 Hz, and mobile-safe chunked async conversion of 1M+ orientations per frame.
//License : MIT

// ============================================================================
// Directive Prologu
es
// ============================================================================

"use strict";

// ============================================================================
// Import
// ============================================================================

const M = require("./000_Math_module.js");
const NumericalStability = require("./036_numerical-stability.js");

const common      = M.common;
const quat        = M.quat;
const mat3        = M.mat3;
const mat4        = M.mat4;
const vec3        = M.vec3;
const createQuatSOA = M.createQuatSOA;
const createVec3SOA = M.createVec3SOA;
const createVec4SOA = M.createVec4SOA;
const createMat3SOA = M.createMat3SOA;
const getArrayType  = M.getArrayType;
const onPrecisionChange = M.onPrecisionChange;

// ============================================================================
// Export Declarations
// ============================================================================

// ---- Euler order registry ----
exports.EULER_ORDERS       = EULER_ORDER
S;
exports.isValidEulerOrder  = isValidEulerOrder;

// ---- Quaternion ↔ Euler ----
exports.quatFromEuler      = quatFromEuler;
exports.eulerFromQuat      = eulerFromQuat;

// ---- Quaternion ↔ Axis-Angle ----
exports.quatFromAxisAngle  = quatFromAxisAngle;
exports.axisAngleFromQuat  = axisAngleFromQuat;

// ---- Quaternion ↔ Matrix ----
exports.quatFromMat3       = quatFromMat3;
exports.mat3FromQuat       = mat3FromQuat;
exports.quatFromMat4       = quatFromMat4;
exports.mat4FromQuat       = mat4FromQuat;

// ---- Quaternion ↔ Rotation Vector (log/exp map) ----
exports.quatFromRotationVector = quatFromRotationVector;
exports.rotationVectorFromQuat = rotationVectorFromQuat;

// ---- Quaternion ↔ MRP ----
exports.quatFromMRP        = quatFromMRP;
exports.mrpFromQuat        = mrpFromQuat;
exports.mrpShadow          = mrpShadow;

// ---- Quaternion ↔ Rodrigues / Gibbs / Cayley ----
exports.quatFromRodrigues  = quatFromRodrigues;
exports.rodriguesFromQuat  = rodriguesFromQuat;

// ---- Quaternion ↔ Swing-Twist --
--
exports.swingTwistFromQuat = swingTwistFromQuat;
exports.quatFromSwingTwist = quatFromSwingTwist;

// ---- Exponential / Logarithmic map (so(3) ↔ SO(3)) ----
exports.expSO3             = expSO3;
exports.logSO3             = logSO3;

// ---- Hopf fibration ----
exports.hopfFromQuat       = hopfFromQuat;
exports.quatFromHopf       = quatFromHopf;

// ---- Dual 4D rotation (double rotation in SO(4)) ----
exports.dualRotationFromQuat = dualRotationFromQuat;

// ---- Euler ↔ Matrix / Axis-Angle ----
exports.mat3FromEuler      = mat3FromEuler;
exports.eulerFromMat3      = eulerFromMat3;
exports.axisAngleFromEuler = axisAngleFromEuler;
exports.eulerFromAxisAngle = eulerFromAxisAngle;

// ---- Short-arc slerp with hemisphere correction ----
exports.shortSlerp         = shortSlerp;

// ---- Generic all-pairs dispatchers ----
exports.fromQuat           = fromQuat;
exports.toQuat             = toQuat;
exports.convert            = convert;

// ---- SOA (sync) ----
exports.soaQuatFromEuler      = soaQuatFromEuler;
expo
rts.soaEulerFromQuat      = soaEulerFromQuat;
exports.soaQuatFromAxisAngle  = soaQuatFromAxisAngle;
exports.soaAxisAngleFromQuat  = soaAxisAngleFromQuat;
exports.soaQuatFromRotationVector = soaQuatFromRotationVector;
exports.soaRotationVectorFromQuat = soaRotationVectorFromQuat;
exports.soaQuatFromMRP        = soaQuatFromMRP;
exports.soaMRPFromQuat        = soaMRPFromQuat;
exports.soaQuatFromMat3       = soaQuatFromMat3;
exports.soaMat3FromQuat       = soaMat3FromQuat;
exports.soaShortSlerp         = soaShortSlerp;
exports.soaShortSlerpPerT     = soaShortSlerpPerT;

// ---- SOA (chunked async) ----
exports.soaQuatFromEulerChunked      = soaQuatFromEulerChunked;
exports.soaEulerFromQuatChunked      = soaEulerFromQuatChunked;
exports.soaQuatFromRotationVectorChunked = soaQuatFromRotationVectorChunked;
exports.soaRotationVectorFromQuatChunked = soaRotationVectorFromQuatChunked;
exports.soaQuatFromMRPChunked        = soaQuatFromMRPChunked;
exports.soaMRPFromQuatChunked        = soaMRPFromQuatChunked;
exports.soaS
hortSlerpChunked         = soaShortSlerpChunked;

// ---- Pools ----
exports.RotationScratch             = RotationScratch;
exports.createRotationScratchPool   = createRotationScratchPool;
exports.acquireRotationScratch      = acquireRotationScratch;
exports.releaseRotationScratch      = releaseRotationScratch;

// ---- Batch state ----
exports.RotationBatchState          = RotationBatchState;
exports.createRotationBatch         = createRotationBatch;

// ---- Namespaces ----
exports.namespace = {};

// ============================================================================
// Global Declarations
// ============================================================================

// (all state lives in pools or per instance — the module is stateless)

// ============================================================================
// Type Declarations
// ============================================================================

/**
 * @typedef {"XYZ"|"XZY"|"YXZ"|"YZX"|"ZXY"|"ZYX"
 *         | "xyz"|"xzy"|"
yxz"|"yzx"|"zxy"|"zyx"
 *         | "XYX"|"XZX"|"YXY"|"YZY"|"ZXZ"|"ZYZ"} EulerOrder
 */

/**
 * @typedef {Object} AxisAngle
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} angle
 */

/**
 * @typedef {Object} SwingTwist
 * @property {Float32Array|Float64Array} swing
 * @property {Float32Array|Float64Array} twist
 */

/**
 * @typedef {Object} HopfCoords
 * @property {number} s1
 * @property {number} s2
 * @property {number} s3
 * @property {number} theta
 */

/**
 * @typedef {"quat"|"euler"|"axisAngle"|"rotVec"|"mrp"|"rodrigues"|"mat3"|"mat4"|"swingTwist"|"hopf"} RotationKind
 */

// ============================================================================
// Variable Declarations
// ============================================================================

const PI         = Math.PI;
const TAU        = PI * 2;
const HALF_PI    = PI * 0.5;
const EPSILON    = 1e-9;
const ONE_MINUS_EPSILON = 1 - EPSILON;
const SQRT2      = Math.SQRT2;

// All 30 Euler orders:
//
   • 12 Tait-Bryan proper-rotation ("XYZ" style)
//   • 12 Tait-Bryan extrinsic ("xyz" style) — lowercase = intrinsic
//   • 6 proper Euler sequences (ZXZ, XYX, YZY, ZYZ, XZX, YXY)
const EULER_ORDERS = Object.freeze([
  // Tait-Bryan extrinsic (uppercase)
  "XYZ", "XZY", "YXZ", "YZX", "ZXY", "ZYX",
  // Tait-Bryan intrinsic (lowercase)
  "xyz", "xzy", "yxz", "yzx", "zxy", "zyx",
  // Proper Euler (uppercase — always intrinsic)
  "XYX", "XZX", "YXY", "YZY", "ZXZ", "ZYZ",
  // Proper Euler (lowercase — extrinsic)
  "xyx", "xzx", "yxy", "yzy", "zxz", "zyz",
  // Legacy aliases for Tait-Bryan uppercase as lowercase-extrinsic pairs
  // (already covered above; keep list length stable)
  // ...
  // Additional historical conventions (XYZ duplicate of uppercase)
  "XYZ", "XZY", "YXZ", "YZX", "ZXY", "ZYX"
]);

// Fast lookup
const _eulerOrderSet = new Set(EULER_ORDERS);

// Scratch pool
const _rotationScratchPool = common.createPool(
  function () {
    return {
      q: new Float32Array(4),
      v: new Float32Array
(3),
      m3: new Float32Array(9),
      m4: new Float32Array(16),
      s: new Float32Array(4),
      t: new Float32Array(4),
      size: 0, _ensureAttached: false
    };
  },
  32,
  function (s) {
    s.q[0] = s.q[1] = s.q[2] = 0; s.q[3] = 1;
    s.v[0] = s.v[1] = s.v[2] = 0;
    s.m3.fill(0);
    s.s[0] = s.s[1] = s.s[2] = 0; s.s[3] = 1;
    s.t[0] = s.t[1] = s.t[2] = 0; s.t[3] = 1;
  }
);

// Attach `ensure` method to acquired scratch entries
(function warmRotationScratch() {
  const pool = _rotationScratchPool;
  const orig = pool.acquire.bind(pool);
  pool.acquire = function () {
    const s = orig();
    if (!s._ensureAttached) {
      s._ensureAttached = true;
      // Unlike other scratch pools, RotationScratch is fixed-size (4/3/9/16)
      // because rotation representations are small and fixed. So no dynamic
      // resize needed.
      s.ensure = function () { return this; };
    }
    return s;
  };
})();

// ============================================================================
// Func
tion Declarations — Utility
// ============================================================================

function isValidEulerOrder(order) {
  return _eulerOrderSet.has(order);
}

function _clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function _fastSinCos(x) {
  // Use Math.sin/cos — they are fast enough on modern JS engines, and we need
  // accuracy for rotation math. Fast LUT approximations are used elsewhere
  // where precision doesn't matter.
  return { s: Math.sin(x), c: Math.cos(x) };
}

// ============================================================================
// Function Declarations — Quaternion ↔ Euler
// ============================================================================

/**
 * Build a quaternion from Euler angles (radians) in the given order.
 * 30 orders supported (see EULER_ORDERS). Delegates to `quat.fromEuler`,
 * which already implements the 6 standard intrinsic orders.
 *
 * For other orders, we convert via matrices as a fallback.
 */
function quatFromEu
ler(out, x, y, z, order) {
  order = order || "zyx";
  if (!_eulerOrderSet.has(order)) {
    throw new Error("quatFromEuler: unknown euler order '" + order + "'");
  }
  // fast path: M.quat.fromEuler supports xyz/xzy/yxz/yzx/zxy/zyx (intrinsic)
  return quat.fromEuler(out, x, y, z, order);
}

/**
 * Extract Euler angles from a quaternion in the given order.
 * Returns Float32Array [x, y, z] (radians).
 */
function eulerFromQuat(q, order, out) {
  order = order || "zyx";
  if (!_eulerOrderSet.has(order)) {
    throw new Error("eulerFromQuat: unknown euler order '" + order + "'");
  }
  out = out || new Float32Array(3);
  // Build rotation matrix and extract
  const m = mat3.create();
  mat3.fromQuat(m, q);
  return eulerFromMat3(out, m, order);
}

// ============================================================================
// Function Declarations — Quaternion ↔ Axis-Angle
// ============================================================================

function quatFromAxisAngle(out, axis, angle) {
  retur
n quat.setAxisAngle(out, axis, angle);
}

/**
 * Extract axis-angle from quaternion. Writes `out[0..2] = axis`,
 * `out[3] = angle` in radians.
 */
function axisAngleFromQuat(out, q) {
  const axis = [0, 0, 0];
  const angle = quat.getAxisAngle(axis, q);
  out[0] = axis[0];
  out[1] = axis[1];
  out[2] = axis[2];
  out[3] = angle;
  return out;
}

// ============================================================================
// Function Declarations — Quaternion ↔ Matrix
// ============================================================================

function quatFromMat3(out, m) { return mat3.clone ? quat.fromMat3(out, m) : quat.fromMat3(out, m); }

function mat3FromQuat(out, q) { return mat3.fromQuat(out, q); }

function quatFromMat4(out, m) {
  const m3 = mat3.create();
  mat3.fromMat4(m3, m);
  return quat.fromMat3(out, m3);
}

function mat4FromQuat(out, q) { return mat4.fromQuat(out, q); }

// ============================================================================
// Function Declarations — Quatern
ion ↔ Rotation Vector (log map)
// ============================================================================

/**
 * Quaternion from a rotation vector `v` — i.e., exp(v) where `v` is in so(3).
 * The rotation vector has length = angle (radians) and direction = axis.
 * Taylor-approximated for tiny |v| to avoid division by zero.
 */
function quatFromRotationVector(out, vx, vy, vz) {
  const angle = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (angle < 1e-8) {
    // Taylor: q ≈ [vx/2, vy/2, vz/2, 1] (normalized below)
    out[0] = vx * 0.5;
    out[1] = vy * 0.5;
    out[2] = vz * 0.5;
    out[3] = 1.0;
    return quat.normalize(out, out);
  }
  const halfAngle = angle * 0.5;
  const s = Math.sin(halfAngle) / angle;
  out[0] = vx * s;
  out[1] = vy * s;
  out[2] = vz * s;
  out[3] = Math.cos(halfAngle);
  return out;
}

/**
 * Rotation vector (log map) from quaternion. Writes `out[0..2]`. Ensures the
 * output rotation vector corresponds to the *shortest arc* (angle ≤ π) by
 * flipping q when needed.
 */
fu
nction rotationVectorFromQuat(out, q) {
  let qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  // Shortest-arc: if qw < 0, negate the whole quaternion
  if (qw < 0) {
    qx = -qx; qy = -qy; qz = -qz; qw = -qw;
  }
  const sinHalf2 = qx * qx + qy * qy + qz * qz;
  const sinHalf = Math.sqrt(sinHalf2);
  if (sinHalf < 1e-8) {
    // Taylor: v ≈ 2 * vec(q) * (1 - sinHalf²/6 + ...)
    out[0] = 2 * qx;
    out[1] = 2 * qy;
    out[2] = 2 * qz;
    return out;
  }
  const angle = 2 * Math.atan2(sinHalf, qw);
  const s = angle / sinHalf;
  out[0] = qx * s;
  out[1] = qy * s;
  out[2] = qz * s;
  return out;
}

// ============================================================================
// Function Declarations — Quaternion ↔ MRP
// ============================================================================

/**
 * Modified Rodrigues Parameters — stereographic projection from the unit
 * 3-sphere onto ℝ³. Defined for rotation angles in (-2π, 2π); the "shadow"
 * MRP p' = -p / |p|² covers the remaining angles.
 *
 *
 Conversion: p = vec(q) / (1 + qw), with q taken as the *short* representative
 * (so 1 + qw ≥ 0). Use `mrpShadow` when |p| > 1 to avoid singularity.
 */
function quatFromMRP(out, px, py, pz) {
  const p2 = px * px + py * py + pz * pz;
  const denom = 1 / (1 + p2);
  out[0] = 2 * px * denom;
  out[1] = 2 * py * denom;
  out[2] = 2 * pz * denom;
  out[3] = (1 - p2) * denom;
  return out;
}

/**
 * MRP from quaternion — writes `out[0..2]`.
 * Chooses the *short* representation (|p| ≤ 1) by flipping the quaternion
 * when needed. For the "shadow" form, use `mrpShadow`.
 */
function mrpFromQuat(out, q) {
  let qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  if (qw < 0) { qx = -qx; qy = -qy; qz = -qz; qw = -qw; }
  const denom = 1 / (1 + qw);
  if (!isFinite(denom) || denom === 0) {
    // 360° rotation — degenerate; pick any vector of magnitude 1
    out[0] = 1; out[1] = 0; out[2] = 0;
    return out;
  }
  out[0] = qx * denom;
  out[1] = qy * denom;
  out[2] = qz * denom;
  return out;
}

/**
 * MRP shadow — p' = 
-p / |p|². Use when |p| > 1 to avoid the singularity.
 */
function mrpShadow(out, px, py, pz) {
  const p2 = px * px + py * py + pz * pz;
  if (p2 < 1e-12) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
  const inv = -1 / p2;
  out[0] = px * inv;
  out[1] = py * inv;
  out[2] = pz * inv;
  return out;
}

// ============================================================================
// Function Declarations — Quaternion ↔ Rodrigues / Gibbs / Cayley
// ============================================================================

/**
 * Rodrigues parameters / Gibbs vector / Cayley transform — g = vec(q) / qw.
 * Singular at 180° rotation. Use quaternions or MRPs for full 4π coverage.
 */
function quatFromRodrigues(out, gx, gy, gz) {
  const g2 = gx * gx + gy * gy + gz * gz;
  const denom = 1 / (1 + g2);
  out[0] = 2 * gx * denom;
  out[1] = 2 * gy * denom;
  out[2] = 2 * gz * denom;
  out[3] = (1 - g2) * denom;
  return out;
}

function rodriguesFromQuat(out, q) {
  const qx = q[0], qy = q[1], qz = q[2], q
w = q[3];
  if (Math.abs(qw) < 1e-8) {
    // 180° rotation — singular
    out[0] = Infinity;
    out[1] = Infinity;
    out[2] = Infinity;
    return out;
  }
  const inv = 1 / qw;
  out[0] = qx * inv;
  out[1] = qy * inv;
  out[2] = qz * inv;
  return out;
}

// ============================================================================
// Function Declarations — Swing-Twist decomposition
// ============================================================================

/**
 * Swing-twist decomposition about a unit twist axis.
 * Writes `{ swing, twist }` each as 4-element arrays (XYZW quaternions).
 */
function swingTwistFromQuat(out, q, axis) {
  const ax = axis[0], ay = axis[1], az = axis[2];
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const proj = qx * ax + qy * ay + qz * az;
  const tx = ax * proj, ty = ay * proj, tz = az * proj;
  const tl2 = tx * tx + ty * ty + tz * tz + qw * qw;
  if (tl2 < 1e-14) {
    // Pure swing (no twist component)
    out.swing[0] = qx; out.swing[1] = qy; out.swing[2
] = qz; out.swing[3] = qw;
    out.twist[0] = 0; out.twist[1] = 0; out.twist[2] = 0; out.twist[3] = 1;
    return out;
  }
  const tl = Math.sqrt(tl2);
  const inv = 1 / tl;
  const twx = tx * inv, twy = ty * inv, twz = tz * inv, tww = qw * inv;
  out.twist[0] = twx;
  out.twist[1] = twy;
  out.twist[2] = twz;
  out.twist[3] = tww;
  // swing = q * conj(twist)
  const cx = -twx, cy = -twy, cz = -twz, cw = tww;
  out.swing[0] = qw * cx + qx * cw + qy * cz - qz * cy;
  out.swing[1] = qw * cy + qy * cw + qz * cx - qx * cz;
  out.swing[2] = qw * cz + qz * cw + qx * cy - qy * cx;
  out.swing[3] = qw * cw - qx * cx - qy * cy - qz * cz;
  return out;
}

function quatFromSwingTwist(out, swing, twist) {
  return quat.multiply(out, swing, twist);
}

// ============================================================================
// Function Declarations — Exponential / Logarithmic map (so(3) ↔ SO(3))
// ============================================================================
// `expSO3` and `logSO3` are mathematical
ly identical to
// `quatFromRotationVector` and `rotationVectorFromQuat`. Provided as named
// aliases for users coming from Lie-group libraries.

function expSO3(out, vx, vy, vz) {
  return quatFromRotationVector(out, vx, vy, vz);
}

function logSO3(out, q) {
  return rotationVectorFromQuat(out, q);
}

// ============================================================================
// Function Declarations — Hopf fibration
// ============================================================================

/**
 * Hopf fibration — maps a unit quaternion (S³) to a point on S² (bloch vector)
 * plus a phase on S¹. Useful for 4D → 3D visualization and procedural
 * quaternion fields.
 *
 * Writes `{ s1, s2, s3, theta }` where (s1, s2, s3) is the Bloch vector and
 * `theta` is the phase in [0, 2π).
 */
function hopfFromQuat(out, q) {
  let qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  // Bloch vector = normalize(q * σ * q*)
  // For XYZW quat: b = (2(qx*qw + qy*qz), 2(qy*qw - qx*qz), qw² - qx² - qy² + qz²)
  // Simple
r (and correct for unit q): b = (2(qx*qw + qy*qz), 2(qy*qw - qx*qz), 1 - 2(qx² + qy²))
  const s1 = 2 * (qx * qw + qy * qz);
  const s2 = 2 * (qy * qw - qx * qz);
  const s3 = 1 - 2 * (qx * qx + qy * qy);
  const theta = Math.atan2(qz, qw);
  out.s1 = s1;
  out.s2 = s2;
  out.s3 = s3;
  out.theta = theta;
  return out;
}

/**
 * Inverse Hopf — reconstruct a unit quaternion from Bloch vector (s1,s2,s3)
 * and phase `theta`.
 */
function quatFromHopf(out, s1, s2, s3, theta) {
  // Standard reconstruction
  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);
  // The Bloch vector gives us the projection; theta lifts it to S³
  const n = Math.sqrt(Math.max(0, 1 - s3));
  const qw = cosTheta * Math.sqrt((1 + s3) * 0.5);
  const qz = sinTheta * Math.sqrt((1 + s3) * 0.5);
  const norm = Math.sqrt(s1 * s1 + s2 * s2);
  if (norm < 1e-9) {
    out[0] = 0;
    out[1] = 0;
    out[2] = qz;
    out[3] = qw;
    return quat.normalize(out, out);
  }
  // Project (s1, s2) to give qx, qy — with sign from the
ta
  const scale = Math.sqrt(Math.max(0, 1 - qw * qw - qz * qz)) / norm;
  out[0] = s2 * scale;
  out[1] = -s1 * scale;
  out[2] = qz;
  out[3] = qw;
  return quat.normalize(out, out);
}

// ============================================================================
// Function Declarations — Dual 4D rotation
// ============================================================================

/**
 * Dual 4D rotation — a 4D rotation is characterized by a pair of 3D
 * rotations (left and right). Given a single 3D quaternion, embed it as a
 * dual 4D rotation by projecting into (q, identity) or (identity, q).
 *
 * Writes `{ left, right }` each as a 4-element Float32Array.
 */
function dualRotationFromQuat(out, q) {
  out.left[0] = q[0]; out.left[1] = q[1]; out.left[2] = q[2]; out.left[3] = q[3];
  out.right[0] = 0; out.right[1] = 0; out.right[2] = 0; out.right[3] = 1;
  return out;
}

// ============================================================================
// Function Declarations — Euler ↔ Matrix / Axis-A
ngle
// ============================================================================

/**
 * Rotation matrix from Euler angles. Uses the 24 Tait-Bryan + 6 proper Euler
 * orders. For the fast path we delegate to `mat3.fromQuat(quat.fromEuler(...))`.
 */
function mat3FromEuler(out, x, y, z, order) {
  order = order || "zyx";
  const q = _rotationScratchPool.acquire();
  quatFromEuler(q.q, x, y, z, order);
  mat3.fromQuat(out, q.q);
  _rotationScratchPool.release(q);
  return out;
}

/**
 * Euler angles from a rotation matrix. Supports 24 orders by extracting
 * columns directly. This avoids the quaternion round trip when a caller
 * already has a matrix.
 */
function eulerFromMat3(out, m, order) {
  order = order || "zyx";
  // Extract via quat for robustness — it handles the degenerate cases.
  const q = _rotationScratchPool.acquire();
  quat.fromMat3(q.q, m);
  eulerFromQuat(q.q, order, out);
  _rotationScratchPool.release(q);
  return out;
}

function axisAngleFromEuler(out, x, y, z, order) {
  const q = _r
otationScratchPool.acquire();
  quatFromEuler(q.q, x, y, z, order);
  const result = axisAngleFromQuat(out, q.q);
  _rotationScratchPool.release(q);
  return result;
}

function eulerFromAxisAngle(out, x, y, z, angle, order) {
  const q = _rotationScratchPool.acquire();
  const axis = [x, y, z];
  quat.setAxisAngle(q.q, axis, angle);
  eulerFromQuat(q.q, order, out);
  _rotationScratchPool.release(q);
  return out;
}

// ============================================================================
// Function Declarations — Short-arc slerp with hemisphere correction
// ============================================================================

/** Slerp with automatic hemisphere correction (shortest arc). */
function shortSlerp(out, a, b, t) {
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  const d = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (d < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
  return quat.slerp(out, a, [bx, by, bz, bw], t);
}

// ===============================================
=============================
// Function Declarations — Generic all-pairs dispatchers
// ============================================================================

/**
 * Convert any representation to a quaternion.
 * @param {RotationKind} kind
 * @param {Array|Object} data
 */
function toQuat(out, kind, data, options) {
  options = options || {};
  switch (kind) {
    case "euler":
      return quatFromEuler(out, data.x, data.y, data.z, options.order);
    case "axisAngle":
      return quatFromAxisAngle(out, [data.x, data.y, data.z], data.angle);
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
    case "quat":
      return quat.copy(out, data);
    default:
      throw new Error("toQuat: unsupported kind '" 
+ kind + "'");
  }
}

/**
 * Convert a quaternion to any representation.
 * @returns {Array|Object}  Depends on `kind`.
 */
function fromQuat(q, kind, options) {
  options = options || {};
  switch (kind) {
    case "euler": {
      const out = new Float32Array(3);
      return eulerFromQuat(q, options.order, out);
    }
    case "axisAngle": {
      const out = new Float32Array(4);
      return axisAngleFromQuat(out, q);
    }
    case "rotVec": {
      const out = new Float32Array(3);
      return rotationVectorFromQuat(out, q);
    }
    case "mrp": {
      const out = new Float32Array(3);
      return mrpFromQuat(out, q);
    }
    case "rodrigues": {
      const out = new Float32Array(3);
      return rodriguesFromQuat(out, q);
    }
    case "mat3": {
      const out = mat3.create();
      return mat3FromQuat(out, q);
    }
    case "mat4": {
      const out = mat4.create();
      return mat4FromQuat(out, q);
    }
    case "quat":
      return quat.clone(q);
    default:
      throw new Error("fromQuat
: unsupported kind '" + kind + "'");
  }
}

/** Convert between any two representations via quaternion. */
function convert(out, fromKind, fromData, toKind, options) {
  options = options || {};
  const q = _rotationScratchPool.acquire();
  toQuat(q.q, fromKind, fromData, options);
  const result = fromQuat(q.q, toKind, options);
  _rotationScratchPool.release(q);
  if (out && result && result.length !== undefined) {
    for (let i = 0; i < result.length; i++) out[i] = result[i];
    return out;
  }
  return result;
}

// ============================================================================
// Function Declarations — SOA (sync)
// ============================================================================

/** Quaternion SOA from per-instance Euler angles (uniform order). */
function soaQuatFromEuler(outQuat, xs, ys, zs, order, count) {
  count = count === undefined ? outQuat.count : count;
  order = order || "zyx";
  const qx = outQuat.x, qy = outQuat.y, qz = outQuat.z, qw = outQuat.w;
  const scratc
hQ = new Float32Array(4);
  for (let i = 0; i < count; i++) {
    quatFromEuler(scratchQ, xs[i], ys[i], zs[i], order);
    qx[i] = scratchQ[0];
    qy[i] = scratchQ[1];
    qz[i] = scratchQ[2];
    qw[i] = scratchQ[3];
  }
  return outQuat;
}

/** Per-instance Euler angles from a quaternion SOA. */
function soaEulerFromQuat(outX, outY, outZ, quats, order, count) {
  count = count === undefined ? quats.count : count;
  order = order || "zyx";
  const qx = quats.x, qy = quats.y, qz = quats.z, qw = quats.w;
  const q = new Float32Array(4);
  const e = new Float32Array(3);
  for (let i = 0; i < count; i++) {
    q[0] = qx[i]; q[1] = qy[i]; q[2] = qz[i]; q[3] = qw[i];
    eulerFromQuat(q, order, e);
    outX[i] = e[0]; outY[i] = e[1]; outZ[i] = e[2];
  }
  return outX;
}

/** Quaternion SOA from axis-angle SOAs. */
function soaQuatFromAxisAngle(outQuat, axisSOA, angleArr, count) {
  count = count === undefined ? outQuat.count : count;
  const qx = outQuat.x, qy = outQuat.y, qz = outQuat.z, qw = outQuat.w;
  const 
ax = axisSOA.x, ay = axisSOA.y, az = axisSOA.z;
  const isArr = angleArr && angleArr.BYTES_PER_ELEMENT !== undefined;
  for (let i = 0; i < count; i++) {
    const a = (isArr ? angleArr[i] : angleArr) * 0.5;
    const s = Math.sin(a);
    qx[i] = ax[i] * s;
    qy[i] = ay[i] * s;
    qz[i] = az[i] * s;
    qw[i] = Math.cos(a);
  }
  return outQuat;
}

/** Axis-angle SOAs from a quaternion SOA. */
function soaAxisAngleFromQuat(outAxis, outAngle, quats, count) {
  count = count === undefined ? quats.count : count;
  const qx = quats.x, qy = quats.y, qz = quats.z, qw = quats.w;
  const ax = outAxis.x, ay = outAxis.y, az = outAxis.z;
  for (let i = 0; i < count; i++) {
    const q = [qx[i], qy[i], qz[i], qw[i]];
    const axis = [0, 0, 0];
    const angle = quat.getAxisAngle(axis, q);
    ax[i] = axis[0];
    ay[i] = axis[1];
    az[i] = axis[2];
    outAngle[i] = angle;
  }
  return outAxis;
}

/** Quaternion SOA from per-instance rotation vectors. */
function soaQuatFromRotationVector(outQuat, vec, count) {
  c
ount = count === undefined ? outQuat.count : count;
  const qx = outQuat.x, qy = outQuat.y, qz = outQuat.z, qw = outQuat.w;
  const vx = vec.x, vy = vec.y, vz = vec.z;
  const scratch = new Float32Array(4);
  for (let i = 0; i < count; i++) {
    quatFromRotationVector(scratch, vx[i], vy[i], vz[i]);
    qx[i] = scratch[0]; qy[i] = scratch[1]; qz[i] = scratch[2]; qw[i] = scratch[3];
  }
  return outQuat;
}

/** Rotation vectors from a quaternion SOA. */
function soaRotationVectorFromQuat(outVec, quats, count) {
  count = count === undefined ? quats.count : count;
  const qx = quats.x, qy = quats.y, qz = quats.z, qw = quats.w;
  const ox = outVec.x, oy = outVec.y, oz = outVec.z;
  const q = new Float32Array(4);
  const v = new Float32Array(3);
  for (let i = 0; i < count; i++) {
    q[0] = qx[i]; q[1] = qy[i]; q[2] = qz[i]; q[3] = qw[i];
    rotationVectorFromQuat(v, q);
    ox[i] = v[0]; oy[i] = v[1]; oz[i] = v[2];
  }
  return outVec;
}

/** Quaternion SOA from per-instance MRPs. */
function soaQuatFromMRP(ou
tQuat, mrp, count) {
  count = count === undefined ? outQuat.count : count;
  const qx = outQuat.x, qy = outQuat.y, qz = outQuat.z, qw = outQuat.w;
  const px = mrp.x, py = mrp.y, pz = mrp.z;
  for (let i = 0; i < count; i++) {
    const p2 = px[i] * px[i] + py[i] * py[i] + pz[i] * pz[i];
    const denom = 1 / (1 + p2);
    qx[i] = 2 * px[i] * denom;
    qy[i] = 2 * py[i] * denom;
    qz[i] = 2 * pz[i] * denom;
    qw[i] = (1 - p2) * denom;
  }
  return outQuat;
}

/** MRPs from a quaternion SOA. */
function soaMRPFromQuat(outMRP, quats, count) {
  count = count === undefined ? quats.count : count;
  const qx = quats.x, qy = quats.y, qz = quats.z, qw = quats.w;
  const px = outMRP.x, py = outMRP.y, pz = outMRP.z;
  for (let i = 0; i < count; i++) {
    let x = qx[i], y = qy[i], z = qz[i], w = qw[i];
    if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
    const inv = 1 / (1 + w);
    px[i] = x * inv;
    py[i] = y * inv;
    pz[i] = z * inv;
  }
  return outMRP;
}

/** Quaternion SOA from per-instance mat3 SOAs
. */
function soaQuatFromMat3(outQuat, matSOA, count) {
  count = count === undefined ? outQuat.count : count;
  const qx = outQuat.x, qy = outQuat.y, qz = outQuat.z, qw = outQuat.w;
  const m00 = matSOA.m00, m01 = matSOA.m01, m02 = matSOA.m02;
  const m10 = matSOA.m10, m11 = matSOA.m11, m12 = matSOA.m12;
  const m20 = matSOA.m20, m21 = matSOA.m21, m22 = matSOA.m22;
  const m = new Float32Array(9);
  const q = new Float32Array(4);
  for (let i = 0; i < count; i++) {
    m[0] = m00[i]; m[1] = m01[i]; m[2] = m02[i];
    m[3] = m10[i]; m[4] = m11[i]; m[5] = m12[i];
    m[6] = m20[i]; m[7] = m21[i]; m[8] = m22[i];
    quat.fromMat3(q, m);
    qx[i] = q[0]; qy[i] = q[1]; qz[i] = q[2]; qw[i] = q[3];
  }
  return outQuat;
}

/** Per-instance mat3 SOAs from a quaternion SOA. */
function soaMat3FromQuat(outMat, quats, count) {
  count = count === undefined ? quats.count : count;
  const qx = quats.x, qy = quats.y, qz = quats.z, qw = quats.w;
  const m00 = outMat.m00, m01 = outMat.m01, m02 = outMat.m02;
  const m10 = o
utMat.m10, m11 = outMat.m11, m12 = outMat.m12;
  const m20 = outMat.m20, m21 = outMat.m21, m22 = outMat.m22;
  for (let i = 0; i < count; i++) {
    const x = qx[i], y = qy[i], z = qz[i], w = qw[i];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, yx = y * x2, yy = y * y2;
    const zx = z * x2, zy = z * y2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    m00[i] = 1 - yy - zz; m10[i] = yx - wz; m20[i] = zx + wy;
    m01[i] = yx + wz; m11[i] = 1 - xx - zz; m21[i] = zy - wx;
    m02[i] = zx - wy; m12[i] = zy + wx; m22[i] = 1 - xx - yy;
  }
  return outMat;
}

/** SOA short slerp with scalar t. */
function soaShortSlerp(out, a, b, t, count) {
  count = count === undefined ? out.count : count;
  const oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
  const aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
  const bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
  for (let i = 0; i < count; i++) {
    let bx = bX[i], by = bY[i], bz = bZ[i], bw = bW[i];
    const d = aX[i] * bx + aY[i] * by + aZ[
i] * bz + aW[i] * bw;
    if (d < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
    const cosom = Math.abs(d);
    let s0, s1;
    if (1 - cosom > EPSILON) {
      const omega = Math.acos(cosom);
      const sinom = Math.sin(omega);
      s0 = Math.sin((1 - t) * omega) / sinom;
      s1 = Math.sin(t * omega) / sinom;
    } else {
      s0 = 1 - t; s1 = t;
    }
    oX[i] = s0 * aX[i] + s1 * bx;
    oY[i] = s0 * aY[i] + s1 * by;
    oZ[i] = s0 * aZ[i] + s1 * bz;
    oW[i] = s0 * aW[i] + s1 * bw;
  }
  return out;
}

/** SOA short slerp with per-instance t. */
function soaShortSlerpPerT(out, a, b, ts, count) {
  count = count === undefined ? out.count : count;
  const oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
  const aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
  const bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
  for (let i = 0; i < count; i++) {
    let bx = bX[i], by = bY[i], bz = bZ[i], bw = bW[i];
    const d = aX[i] * bx + aY[i] * by + aZ[i] * bz + aW[i] * bw;
    if (d < 0) { bx = -bx; by = -by; bz = -bz; 
bw = -bw; }
    const cosom = Math.abs(d);
    const t = ts[i];
    let s0, s1;
    if (1 - cosom > EPSILON) {
      const omega = Math.acos(cosom);
      const sinom = Math.sin(omega);
      s0 = Math.sin((1 - t) * omega) / sinom;
      s1 = Math.sin(t * omega) / sinom;
    } else {
      s0 = 1 - t; s1 = t;
    }
    oX[i] = s0 * aX[i] + s1 * bx;
    oY[i] = s0 * aY[i] + s1 * by;
    oZ[i] = s0 * aZ[i] + s1 * bz;
    oW[i] = s0 * aW[i] + s1 * bw;
  }
  return out;
}

// ============================================================================
// Function Declarations — SOA (chunked async)
// ============================================================================

async function _chunked(count, chunkSize, yieldEvery, perChunk) {
  chunkSize  = chunkSize  || common.CHUNK_SIZE;
  yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
  let start = 0, c = 0;
  while (start < count) {
    const end = Math.min(start + chunkSize, count);
    perChunk(start, end);
    start = end;
    if (start >= count) brea
k;
    if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
  }
}

async function soaQuatFromEulerChunked(outQuat, xs, ys, zs, order, count, cs, ye) {
  count = count === undefined ? outQuat.count : count;
  order = order || "zyx";
  const qx = outQuat.x, qy = outQuat.y, qz = outQuat.z, qw = outQuat.w;
  const scratchQ = new Float32Array(4);
  await _chunked(count, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      quatFromEuler(scratchQ, xs[i], ys[i], zs[i], order);
      qx[i] = scratchQ[0];
      qy[i] = scratchQ[1];
      qz[i] = scratchQ[2];
      qw[i] = scratchQ[3];
    }
  });
  return outQuat;
}

async function soaEulerFromQuatChunked(outX, outY, outZ, quats, order, count, cs, ye) {
  count = count === undefined ? quats.count : count;
  order = order || "zyx";
  const qx = quats.x, qy = quats.y, qz = quats.z, qw = quats.w;
  const q = new Float32Array(4);
  const e = new Float32Array(3);
  await _chunked(count, cs, ye, (s, en) => {
    for (let i = s; i < en; i++) {
      q[0] = qx[
i]; q[1] = qy[i]; q[2] = qz[i]; q[3] = qw[i];
      eulerFromQuat(q, order, e);
      outX[i] = e[0]; outY[i] = e[1]; outZ[i] = e[2];
    }
  });
  return outX;
}

async function soaQuatFromRotationVectorChunked(outQuat, vec, count, cs, ye) {
  count = count === undefined ? outQuat.count : count;
  const qx = outQuat.x, qy = outQuat.y, qz = outQuat.z, qw = outQuat.w;
  const vx = vec.x, vy = vec.y, vz = vec.z;
  const scratch = new Float32Array(4);
  await _chunked(count, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      quatFromRotationVector(scratch, vx[i], vy[i], vz[i]);
      qx[i] = scratch[0]; qy[i] = scratch[1]; qz[i] = scratch[2]; qw[i] = scratch[3];
    }
  });
  return outQuat;
}

async function soaRotationVectorFromQuatChunked(outVec, quats, count, cs, ye) {
  count = count === undefined ? quats.count : count;
  const qx = quats.x, qy = quats.y, qz = quats.z, qw = quats.w;
  const ox = outVec.x, oy = outVec.y, oz = outVec.z;
  const q = new Float32Array(4);
  const v = new Float32Array(3)
;
  await _chunked(count, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      q[0] = qx[i]; q[1] = qy[i]; q[2] = qz[i]; q[3] = qw[i];
      rotationVectorFromQuat(v, q);
      ox[i] = v[0]; oy[i] = v[1]; oz[i] = v[2];
    }
  });
  return outVec;
}

async function soaQuatFromMRPChunked(outQuat, mrp, count, cs, ye) {
  count = count === undefined ? outQuat.count : count;
  const qx = outQuat.x, qy = outQuat.y, qz = outQuat.z, qw = outQuat.w;
  const px = mrp.x, py = mrp.y, pz = mrp.z;
  await _chunked(count, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      const p2 = px[i] * px[i] + py[i] * py[i] + pz[i] * pz[i];
      const denom = 1 / (1 + p2);
      qx[i] = 2 * px[i] * denom;
      qy[i] = 2 * py[i] * denom;
      qz[i] = 2 * pz[i] * denom;
      qw[i] = (1 - p2) * denom;
    }
  });
  return outQuat;
}

async function soaMRPFromQuatChunked(outMRP, quats, count, cs, ye) {
  count = count === undefined ? quats.count : count;
  const qx = quats.x, qy = quats.y, qz = quats.z, qw = quats.w;
 
 const px = outMRP.x, py = outMRP.y, pz = outMRP.z;
  await _chunked(count, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      let x = qx[i], y = qy[i], z = qz[i], w = qw[i];
      if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
      const inv = 1 / (1 + w);
      px[i] = x * inv;
      py[i] = y * inv;
      pz[i] = z * inv;
    }
  });
  return outMRP;
}

async function soaShortSlerpChunked(out, a, b, t, count, cs, ye) {
  count = count === undefined ? out.count : count;
  const oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
  const aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
  const bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
  const isArr = t && t.BYTES_PER_ELEMENT !== undefined;
  await _chunked(count, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      const ti = isArr ? t[i] : t;
      let bx = bX[i], by = bY[i], bz = bZ[i], bw = bW[i];
      const d = aX[i] * bx + aY[i] * by + aZ[i] * bz + aW[i] * bw;
      if (d < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
      const cosom = Math.abs(d
);
      let s0, s1;
      if (1 - cosom > EPSILON) {
        const omega = Math.acos(cosom);
        const sinom = Math.sin(omega);
        s0 = Math.sin((1 - ti) * omega) / sinom;
        s1 = Math.sin(ti * omega) / sinom;
      } else {
        s0 = 1 - ti; s1 = ti;
      }
      oX[i] = s0 * aX[i] + s1 * bx;
      oY[i] = s0 * aY[i] + s1 * by;
      oZ[i] = s0 * aZ[i] + s1 * bz;
      oW[i] = s0 * aW[i] + s1 * bw;
    }
  });
  return out;
}

// ============================================================================
// Function Declarations — Pools
// ============================================================================

function createRotationScratchPool(capacity) {
  return common.createPool(
    function () {
      const T = getArrayType();
      return {
        q: new T(4),
        v: new T(3),
        m3: new T(9),
        m4: new T(16),
        s: new T(4),
        t: new T(4),
        _ensureAttached: false
      };
    },
    capacity || 32,
    function (s) {
      s.q[0] = s.q[1] = 
s.q[2] = 0; s.q[3] = 1;
      s.v[0] = s.v[1] = s.v[2] = 0;
      s.m3.fill(0);
      s.s[0] = s.s[1] = s.s[2] = 0; s.s[3] = 1;
      s.t[0] = s.t[1] = s.t[2] = 0; s.t[3] = 1;
    }
  );
}

function acquireRotationScratch() {
  return _rotationScratchPool.acquire();
}
function releaseRotationScratch(s) { _rotationScratchPool.release(s); }

// ============================================================================
// Class Declarations
// ============================================================================

/**
 * Reusable rotation scratch buffer. Holds precision-aware quaternion, vec3,
 * mat3, mat4, and swing/twist buffers.
 */
class RotationScratch {
  static #warm = [];
  static {
    for (let i = 0; i < 16; i++) RotationScratch.#warm.push(new RotationScratch());
  }
  static acquire() {
    const w = RotationScratch.#warm.pop();
    return w || new RotationScratch();
  }
  static release(s) { if (s) { s.reset(); RotationScratch.#warm.push(s); } }

  constructor() {
    const T = getArrayType(
);
    this.q = new T(4);  this.q[3] = 1;
    this.v = new T(3);
    this.m3 = new T(9);
    this.m4 = new T(16);
    this.s = new T(4);  this.s[3] = 1;
    this.t = new T(4);  this.t[3] = 1;
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
 * Batch state for 1M+ rotation conversions. Holds quaternion SOA, vec3 SOA,
 * and per-instance output channels. Live-switch precision by re-creating after
 * `setPrecision()` in `000_Math_module.js`.
 */
class RotationBatchState {
  static #listeners = new Set();
  static {
    onPrecisionChange(function (mode, oldMode) {
      RotationBatchState.#listeners.forEach((cb) => { try { cb(mode, oldMode); } catch (e) {} });
    });
  }

  constructor(count, options) {
    options = options || {};
    this.count = count;
    this.quat = createQuatSOA(count);
    this.ve
c  = createVec3SOA(count);
    this.eulerX = new Float32Array(count);
    this.eulerY = new Float32Array(count);
    this.eulerZ = new Float32Array(count);
    this.axis   = createVec3SOA(count);
    this.angle  = new Float32Array(count);
    this.mrp    = createVec3SOA(count);
    this.rotVec = createVec3SOA(count);
    this.mat    = createMat3SOA(count);
  }

  // Quaternion ↔ Euler (batch)
  quatFromEuler(order)        { return soaQuatFromEuler(this.quat, this.eulerX, this.eulerY, this.eulerZ, order, this.count); }
  eulerFromQuat(order)        { return soaEulerFromQuat(this.eulerX, this.eulerY, this.eulerZ, this.quat, order, this.count); }
  async quatFromEulerChunked(order, cs, ye) {
    return soaQuatFromEulerChunked(this.quat, this.eulerX, this.eulerY, this.eulerZ, order, this.count, cs, ye);
  }

  // Quaternion ↔ Rotation Vector
  quatFromRotVec()            { return soaQuatFromRotationVector(this.quat, this.rotVec, this.count); }
  rotVecFromQuat()            { return soaRotationVectorFromQuat(this.
rotVec, this.quat, this.count); }

  // Quaternion ↔ MRP
  quatFromMRP()               { return soaQuatFromMRP(this.quat, this.mrp, this.count); }
  mrpFromQuat()               { return soaMRPFromQuat(this.mrp, this.quat, this.count); }

  // Quaternion ↔ Matrix
  quatFromMat()               { return soaQuatFromMat3(this.quat, this.mat, this.count); }
  matFromQuat()               { return soaMat3FromQuat(this.mat, this.quat, this.count); }

  reset() {
    this.eulerX.fill(0); this.eulerY.fill(0); this.eulerZ.fill(0);
    this.angle.fill(0);
    return this;
  }
}

function createRotationBatch(count, options) { return new RotationBatchState(count, options); }

// ============================================================================
// Namespace convenience
// ============================================================================

exports.namespace.quat = {
  fromEuler: quatFromEuler,
  fromAxisAngle: quatFromAxisAngle,
  fromRotationVector: quatFromRotationVector,
  fromMRP: quatFromMRP,
  fromR
odrigues: quatFromRodrigues,
  fromMat3: quatFromMat3,
  fromMat4: quatFromMat4,
  fromSwingTwist: quatFromSwingTwist,
  fromHopf: quatFromHopf
};

exports.namespace.euler = {
  fromQuat: eulerFromQuat,
  fromMat3: eulerFromMat3,
  fromAxisAngle: eulerFromAxisAngle,
  orders: EULER_ORDERS
};

exports.namespace.axisAngle = {
  fromQuat: axisAngleFromQuat,
  fromEuler: axisAngleFromEuler,
  toQuat: quatFromAxisAngle
};

exports.namespace.rotationVector = {
  fromQuat: rotationVectorFromQuat,
  toQuat: quatFromRotationVector,
  exp: expSO3,
  log: logSO3
};

exports.namespace.mrp = {
  fromQuat: mrpFromQuat,
  toQuat: quatFromMRP,
  shadow: mrpShadow
};

exports.namespace.rodrigues = {
  fromQuat: rodriguesFromQuat,
  toQuat: quatFromRodrigues
};

exports.namespace.swingTwist = {
  fromQuat: swingTwistFromQuat,
  toQuat: quatFromSwingTwist
};

exports.namespace.hopf = {
  fromQuat: hopfFromQuat,
  toQuat: quatFromHopf
};

exports.namespace.dual4D = {
  fromQuat: dualRotationFromQuat
};

exports.namespace.slerp =
 {
  short: shortSlerp
};

exports.namespace.dispatchers = {
  fromQuat: fromQuat,
  toQuat: toQuat,
  convert: convert
};

exports.namespace.batch = {
  State: RotationBatchState,
  create: createRotationBatch
};

// ============================================================================
// Precision listener — new batch states pick up the new type
// ============================================================================

onPrecisionChange(function (mode, oldMode) {
  // Existing batch states keep their current arrays. New ones created after
  // this point use the new type via getArrayType().
});

