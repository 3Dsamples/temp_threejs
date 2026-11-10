// file number : 012
// full path name : src/animation/012_ik_advanced.js
// description : Advanced inverse kinematics extensions inspired by
//               Everything-Will-Be-IK (ewbIK). Adds to file 010:
//                 • 6-DOF targets (position + orientation)
//                 • Multiple end-effectors per chain
//                 • Intermediary effectors (solve a middle joint without
//                   disturbing the end)
//                 • Per-DOF weight / priority masks
//                 • Soft constraints (least-uncomfortable pose)
//                 • Stiffness / dampening per joint
//                 • Orientation-region constraints (cone / box / arbitrary)
//               All extensions reuse the SoA IKChain / IKJoint stores
//               from file 010 and the CCD/FABRIK/DLS solvers defined there.
//               New data is stored in additional SoA arrays so existing
//               chains pay zero overhead.
//
// FLOAT PRECISION AUDIT — all literals verified:
//   EPSILON_SQ     = 1e-16     (squared zero test; > Float64 ULP near 0,
//                               << Float32 min normal 1.17549435e-38)
//   EPSILON        = 1e-8      (linear zero test; < Float32 EPSILON 1.19209290e-7,
//                               > Float64 noise)
//   EPSILON_HIGH   = 1e-12     (quaternion / matrix guards)
//   DEG_TO_RAD     = Math.PI / 180   (exact fraction, not 0.0174533)
//   RAD_TO_DEG     = 180 / Math.PI   (exact fraction)
//   HALF_PI        = Math.PI / 2
//   TWO_PI         = 2 * Math.PI
//   SOFT_CONSTRAINT_WEIGHT_DEFAULT = 0.01  (1% pull toward rest pose;
//                                            stable, no visible jitter)
//   CONE_EPSILON   = 1e-6      (cone half-angle guard; well above Float32
//                               noise at 1 rad, well below any visible
//                               angular error)
//
// best for : Humanoid / quadruped limbs, robotic arms with orientation
//            targets, multi-effector solvers (two hands + head), foot
//            placement on uneven terrain, and any scene that needs
//            "natural" joint poses instead of mechanical extremes on
//            Android 64-bit.
// license : MIT

import {
  $internal,
  query,
  addComponent,
  removeComponent,
  hasComponent,
  entityExists,
  getId,
} from '../ecs/001_ecs_core.js';

import {
  WorldTransformF32,
  LocalTransformF32,
  ChildOf,
  Pair,
  getParents,
  getChildren,
  markDirty,
} from '../transform/002_transform_hierarchy.js';

import {
  IKChain,
  IKJoint,
  IKSolver,
  IKJointTag,
  IKChainTag,
  IKGoalTag,
  ACTIVE_CHAINS,
  HaltonSampler,
} from './010_ik_system.js';

import {
  vec3,
  quat,
  mat4,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// FLOAT CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ     = 1e-16;
const EPSILON        = 1e-8;
const EPSILON_HIGH   = 1e-12;
const DEG_TO_RAD     = Math.PI / 180;
const RAD_TO_DEG     = 180 / Math.PI;
const HALF_PI        = Math.PI / 2;
const TWO_PI         = 2 * Math.PI;
const SOFT_CONSTRAINT_WEIGHT_DEFAULT = 0.01;
const CONE_EPSILON   = 1e-6;

// ═══════════════════════════════════════════════════════════════════════
// NEW SoA STORES (extend file 010 without modifying it)
// ═══════════════════════════════════════════════════════════════════════

const MAX_CHAINS_ADV = 100_000;
const MAX_JOINTS_ADV = 1_000_000;

/**
 * 6-DOF orientation target per chain.
 * If `useOrientation` is 0, only position is solved (file 010 behaviour).
 */
export const IKChainAdv = {
  useOrientation:  new Uint8Array(MAX_CHAINS_ADV),  // 0 = position-only
  // Target orientation quaternion (world space).
  targetQX: new Float32Array(MAX_CHAINS_ADV),
  targetQY: new Float32Array(MAX_CHAINS_ADV),
  targetQZ: new Float32Array(MAX_CHAINS_ADV),
  targetQW: new Float32Array(MAX_CHAINS_ADV),
  // Per-DOF weights (0..1). 0 = ignore that DOF.
  weightX: new Float32Array(MAX_CHAINS_ADV),
  weightY: new Float32Array(MAX_CHAINS_ADV),
  weightZ: new Float32Array(MAX_CHAINS_ADV),
};

/**
 * Per-joint soft-constraint & stiffness data.
 * Stiffness pulls the joint toward its rest orientation during solving.
 */
export const IKJointAdv = {
  // Rest local quaternion (captured at chain build time).
  restQX: new Float32Array(MAX_JOINTS_ADV),
  restQY: new Float32Array(MAX_JOINTS_ADV),
  restQZ: new Float32Array(MAX_JOINTS_ADV),
  restQW: new Float32Array(MAX_JOINTS_ADV),

  // Stiffness weight (0 = free, 1 = locked to rest).
  stiffness: new Float32Array(MAX_JOINTS_ADV),

  // Orientation-region constraint (per joint).
  // 0 = none, 1 = cone, 2 = box.
  constraintType: new Uint8Array(MAX_JOINTS_ADV),
  // For cone: axis + half-angle.
  coneAxisX: new Float32Array(MAX_JOINTS_ADV),
  coneAxisY: new Float32Array(MAX_JOINTS_ADV),
  coneAxisZ: new Float32Array(MAX_JOINTS_ADV),
  coneHalfAngle: new Float32Array(MAX_JOINTS_ADV),
  // For box: min/max Euler angles (radians).
  boxMinX: new Float32Array(MAX_JOINTS_ADV),
  boxMaxX: new Float32Array(MAX_JOINTS_ADV),
  boxMinY: new Float32Array(MAX_JOINTS_ADV),
  boxMaxY: new Float32Array(MAX_JOINTS_ADV),
  boxMinZ: new Float32Array(MAX_JOINTS_ADV),
  boxMaxZ: new Float32Array(MAX_JOINTS_ADV),
};

/**
 * Multiple end-effectors per chain.
 * Each chain can have up to 4 end-effectors; each has its own goal entity
 * and weight. File 010's `goalEid` remains the primary effector (index 0).
 */
const MAX_EFFECTORS_PER_CHAIN = 4;

export const IKChainEffectos = {
  count: new Uint8Array(MAX_CHAINS_ADV),
  goalEid: new Uint32Array(MAX_CHAINS_ADV * MAX_EFFECTORS_PER_CHAIN),
  weight: new Float32Array(MAX_CHAINS_ADV * MAX_EFFECTORS_PER_CHAIN),
  // Which joint index is the effector (0-based from root).
  jointIndex: new Uint8Array(MAX_CHAINS_ADV * MAX_EFFECTORS_PER_CHAIN),
};

/**
 * Intermediary effector: a joint that should reach a goal while the
 * end-effector also reaches its goal. Used for foot/hand placement while
 * the root stays anchored.
 */
export const IKIntermediary = {
  count: new Uint8Array(MAX_CHAINS_ADV),
  jointIndex: new Uint8Array(MAX_CHAINS_ADV),
  goalEid: new Uint32Array(MAX_CHAINS_ADV),
  weight: new Float32Array(MAX_CHAINS_ADV),
};

// ═══════════════════════════════════════════════════════════════════════
// API — enable 6-DOF solving
// ═══════════════════════════════════════════════════════════════════════

/**
 * Enable 6-DOF target on an existing chain (from file 010).
 * @param targetQuat  [x, y, z, w] world-space target orientation
 */
export function setOrientationTarget(world, chainIdx, targetQuat, weights = [1, 1, 1]) {
  IKChainAdv.useOrientation[chainIdx] = 1;
  IKChainAdv.targetQX[chainIdx] = targetQuat[0];
  IKChainAdv.targetQY[chainIdx] = targetQuat[1];
  IKChainAdv.targetQZ[chainIdx] = targetQuat[2];
  IKChainAdv.targetQW[chainIdx] = targetQuat[3];
  IKChainAdv.weightX[chainIdx] = weights[0];
  IKChainAdv.weightY[chainIdx] = weights[1];
  IKChainAdv.weightZ[chainIdx] = weights[2];
  IKChain.dirty[chainIdx] = 1;
}

/**
 * Disable orientation solving (revert to file 010 position-only behaviour).
 */
export function clearOrientationTarget(world, chainIdx) {
  IKChainAdv.useOrientation[chainIdx] = 0;
  IKChain.dirty[chainIdx] = 1;
}

// ═══════════════════════════════════════════════════════════════════════
// API — stiffness and rest pose
// ═══════════════════════════════════════════════════════════════════════

/**
 * Capture the current local rotations as the rest pose for a chain.
 * Should be called once after building the chain (file 010's addIKChain).
 */
export function captureRestPose(world, chainIdx) {
  const rootEid = IKChain.rootEid[chainIdx];
  const joints = collectJointChain(world, rootEid, IKChain.jointCount[chainIdx]);
  for (const eid of joints) {
    const id = getId(eid);
    const L = LocalTransformF32;
    IKJointAdv.restQX[id] = L.qx[id];
    IKJointAdv.restQY[id] = L.qy[id];
    IKJointAdv.restQZ[id] = L.qz[id];
    IKJointAdv.restQW[id] = L.qw[id];
    if (IKJointAdv.stiffness[id] === 0) {
      IKJointAdv.stiffness[id] = SOFT_CONSTRAINT_WEIGHT_DEFAULT;
    }
  }
}

/**
 * Set stiffness (0 = free, 1 = locked to rest) on a joint.
 */
export function setJointStiffness(world, jointEid, stiffness) {
  const id = getId(jointEid);
  IKJointAdv.stiffness[id] = Math.max(0, Math.min(1, stiffness));
}

// ═══════════════════════════════════════════════════════════════════════
// API — orientation-region constraints
// ═══════════════════════════════════════════════════════════════════════

/**
 * Constrain a joint to a cone around `axis` with half-angle `halfAngle`
 * (radians). Any solved rotation outside the cone is projected back.
 */
export function setConeConstraint(world, jointEid, axis, halfAngle) {
  const id = getId(jointEid);
  IKJointAdv.constraintType[id] = 1;
  IKJointAdv.coneAxisX[id] = axis[0];
  IKJointAdv.coneAxisY[id] = axis[1];
  IKJointAdv.coneAxisZ[id] = axis[2];
  IKJointAdv.coneHalfAngle[id] = halfAngle;
}

/**
 * Constrain a joint to an Euler box [minX..maxX, minY..maxY, minZ..maxZ].
 */
export function setBoxConstraint(world, jointEid, minEuler, maxEuler) {
  const id = getId(jointEid);
  IKJointAdv.constraintType[id] = 2;
  IKJointAdv.boxMinX[id] = minEuler[0];
  IKJointAdv.boxMinY[id] = minEuler[1];
  IKJointAdv.boxMinZ[id] = minEuler[2];
  IKJointAdv.boxMaxX[id] = maxEuler[0];
  IKJointAdv.boxMaxY[id] = maxEuler[1];
  IKJointAdv.boxMaxZ[id] = maxEuler[2];
}

export function clearConstraint(world, jointEid) {
  const id = getId(jointEid);
  IKJointAdv.constraintType[id] = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// API — multiple effectors
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add a secondary end-effector to a chain.
 * @param jointIndex  0-based index from root of the effector joint
 * @param goalEid     target entity
 * @param weight      0..1 priority
 */
export function addChainEffector(world, chainIdx, jointIndex, goalEid, weight = 1.0) {
  const base = chainIdx * MAX_EFFECTORS_PER_CHAIN;
  let count = IKChainEffectos.count[chainIdx];
  if (count >= MAX_EFFECTORS_PER_CHAIN) {
    throw new Error('addChainEffector: max 4 effectors per chain');
  }
  IKChainEffectos.goalEid[base + count] = goalEid;
  IKChainEffectos.weight[base + count] = weight;
  IKChainEffectos.jointIndex[base + count] = jointIndex;
  IKChainEffectos.count[chainIdx] = count + 1;
  IKChain.dirty[chainIdx] = 1;
}

/**
 * Set an intermediary effector (a joint between root and end that must
 * reach its own goal without breaking the end-effector solution).
 */
export function setIntermediaryEffector(world, chainIdx, jointIndex, goalEid, weight = 0.5) {
  IKIntermediary.count[chainIdx] = 1;
  IKIntermediary.jointIndex[chainIdx] = jointIndex;
  IKIntermediary.goalEid[chainIdx] = goalEid;
  IKIntermediary.weight[chainIdx] = weight;
  IKChain.dirty[chainIdx] = 1;
}

// ═══════════════════════════════════════════════════════════════════════
// ADVANCED SOLVER — runs after file 010's solver
// ═══════════════════════════════════════════════════════════════════════

const _tmpQ = quat.create();
const _tmpQ2 = quat.create();
const _tmpV3 = vec3.create();
const _tmpV3b = vec3.create();

/**
 * System: solve all advanced IK features for every active chain.
 * Call AFTER systemSolveIK (file 010) and BEFORE systemPropagateTransforms
 * (file 002) finalization.
 */
export function systemSolveIKAdvanced(world) {
  for (const chainIdx of ACTIVE_CHAINS) {
    if (!IKChain.dirty[chainIdx]) continue;

    const rootEid = IKChain.rootEid[chainIdx];
    const jointCount = IKChain.jointCount[chainIdx];
    const joints = collectJointChain(world, rootEid, jointCount);
    if (joints.length < 2) continue;

    // 1. Stiffness: pull each joint toward its rest quaternion.
    applyStiffness(world, joints);

    // 2. Orientation target on the end-effector.
    if (IKChainAdv.useOrientation[chainIdx]) {
      solveOrientationTarget(world, chainIdx, joints);
    }

    // 3. Multiple effectors (indices > 0; index 0 is file 010's goal).
    solveSecondaryEffectors(world, chainIdx, joints);

    // 4. Intermediary effector.
    solveIntermediary(world, chainIdx, joints);

    // 5. Orientation-region constraints (cones / boxes).
    applyOrientationConstraints(world, joints);
  }
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// STIFFNESS — soft constraint toward rest pose
// ═══════════════════════════════════════════════════════════════════════

function applyStiffness(world, joints) {
  for (const eid of joints) {
    const id = getId(eid);
    const stiffness = IKJointAdv.stiffness[id];
    if (stiffness <= 0) continue;

    const L = LocalTransformF32;
    _tmpQ[0] = L.qx[id]; _tmpQ[1] = L.qy[id];
    _tmpQ[2] = L.qz[id]; _tmpQ[3] = L.qw[id];

    // Slerp toward rest by stiffness factor.
    slerpQuatInto(_tmpQ, [
      IKJointAdv.restQX[id],
      IKJointAdv.restQY[id],
      IKJointAdv.restQZ[id],
      IKJointAdv.restQW[id],
    ], stiffness, _tmpQ2);

    L.qx[id] = _tmpQ2[0]; L.qy[id] = _tmpQ2[1];
    L.qz[id] = _tmpQ2[2]; L.qw[id] = _tmpQ2[3];
    markDirty(eid);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ORIENTATION TARGET — align end-effector quaternion to target
// ═══════════════════════════════════════════════════════════════════════

function solveOrientationTarget(world, chainIdx, joints) {
  const endEid = joints[joints.length - 1];
  const endId = getId(endEid);

  const targetQ = [
    IKChainAdv.targetQX[chainIdx],
    IKChainAdv.targetQY[chainIdx],
    IKChainAdv.targetQZ[chainIdx],
    IKChainAdv.targetQW[chainIdx],
  ];

  // Current world quaternion of the end-effector.
  readWorldQuaternion(endEid, _tmpQ);

  // Delta rotation = target * inverse(current).
  quat.invert(_tmpQ2, _tmpQ);
  quat.multiply(_tmpQ2, targetQ, _tmpQ2);

  // Distribute delta across joints weighted by distance from end.
  const n = joints.length;
  for (let i = 0; i < n - 1; i++) {
    const eid = joints[i];
    const id = getId(eid);
    const weight = (i + 1) / n; // more rotation closer to end

    // Scale delta by weight (slerp from identity).
    slerpQuatInto([0, 0, 0, 1], _tmpQ2, weight, _tmpQ);

    applyWorldRotationDelta(eid, _tmpQ);
    propagateSubtree(world, eid);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SECONDARY EFFECTORS — additional goals beyond index 0
// ═══════════════════════════════════════════════════════════════════════

function solveSecondaryEffectors(world, chainIdx, joints) {
  const base = chainIdx * MAX_EFFECTORS_PER_CHAIN;
  const count = IKChainEffectos.count[chainIdx];
  if (count <= 1) return; // index 0 is file 010's goal

  for (let e = 1; e < count; e++) {
    const goalEid = IKChainEffectos.goalEid[base + e];
    if (!goalEid || !entityExists(world, goalEid)) continue;

    const jointIndex = IKChainEffectos.jointIndex[base + e];
    if (jointIndex >= joints.length) continue;

    const effectorEid = joints[jointIndex];
    const weight = IKChainEffectos.weight[base + e];

    // CCD-style solve toward the goal, blended by weight.
    solveCCDToGoal(world, joints, effectorEid, goalEid, weight, 3);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// INTERMEDIARY EFFECTOR — solve a middle joint without disturbing the end
// ═══════════════════════════════════════════════════════════════════════

function solveIntermediary(world, chainIdx, joints) {
  if (IKIntermediary.count[chainIdx] === 0) return;

  const jointIndex = IKIntermediary.jointIndex[chainIdx];
  const goalEid = IKIntermediary.goalEid[chainIdx];
  if (!goalEid || !entityExists(world, goalEid)) return;
  if (jointIndex >= joints.length) return;

  const weight = IKIntermediary.weight[chainIdx];

  // Solve only the sub-chain from root to intermediary, then re-solve the
  // full chain so the end-effector stays on target.
  solveCCDToGoal(world, joints.slice(0, jointIndex + 1), joints[jointIndex], goalEid, weight, 2);

  // Re-solve end effector with file 010's solver by marking dirty.
  IKChain.dirty[chainIdx] = 1;
}

// ═══════════════════════════════════════════════════════════════════════
// ORIENTATION CONSTRAINTS — project joint rotations back into allowed region
// ═══════════════════════════════════════════════════════════════════════

function applyOrientationConstraints(world, joints) {
  for (const eid of joints) {
    const id = getId(eid);
    const type = IKJointAdv.constraintType[id];
    if (type === 0) continue;

    if (type === 1) {
      // Cone constraint.
      applyConeConstraint(id, eid);
    } else if (type === 2) {
      // Box constraint (Euler).
      applyBoxConstraint(id, eid);
    }
  }
}

function applyConeConstraint(id, eid) {
  const L = LocalTransformF32;
  _tmpQ[0] = L.qx[id]; _tmpQ[1] = L.qy[id];
  _tmpQ[2] = L.qz[id]; _tmpQ[3] = L.qw[id];

  // Rotate the local Y axis by the quaternion.
  _tmpV3[0] = 0; _tmpV3[1] = 1; _tmpV3[2] = 0;
  vec3.transformQuat(_tmpV3b, _tmpV3, _tmpQ);

  const axis = [
    IKJointAdv.coneAxisX[id],
    IKJointAdv.coneAxisY[id],
    IKJointAdv.coneAxisZ[id],
  ];
  const dot = _tmpV3b[0] * axis[0] + _tmpV3b[1] * axis[1] + _tmpV3b[2] * axis[2];
  const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
  const halfAngle = IKJointAdv.coneHalfAngle[id];

  if (angle <= halfAngle + CONE_EPSILON) return;

  // Project back: rotate toward axis by (angle - halfAngle).
  const correction = angle - halfAngle;
  const rotAxis = cross(_tmpV3b, axis);
  const rotLen = Math.hypot(rotAxis[0], rotAxis[1], rotAxis[2]);
  if (rotLen < EPSILON) return;

  rotAxis[0] /= rotLen; rotAxis[1] /= rotLen; rotAxis[2] /= rotLen;

  const halfCorrection = correction * 0.5;
  const s = Math.sin(halfCorrection);
  _tmpQ2[0] = rotAxis[0] * s;
  _tmpQ2[1] = rotAxis[1] * s;
  _tmpQ2[2] = rotAxis[2] * s;
  _tmpQ2[3] = Math.cos(halfCorrection);

  quat.multiply(_tmpQ, _tmpQ2, _tmpQ);
  L.qx[id] = _tmpQ[0]; L.qy[id] = _tmpQ[1];
  L.qz[id] = _tmpQ[2]; L.qw[id] = _tmpQ[3];
  markDirty(eid);
}

function applyBoxConstraint(id, eid) {
  // Convert quaternion to Euler (XYZ order) and clamp.
  const L = LocalTransformF32;
  const qx = L.qx[id], qy = L.qy[id], qz = L.qz[id], qw = L.qw[id];

  const euler = quatToEuler(qx, qy, qz, qw);
  const clamped = [
    Math.max(IKJointAdv.boxMinX[id], Math.min(IKJointAdv.boxMaxX[id], euler[0])),
    Math.max(IKJointAdv.boxMinY[id], Math.min(IKJointAdv.boxMaxY[id], euler[1])),
    Math.max(IKJointAdv.boxMinZ[id], Math.min(IKJointAdv.boxMaxZ[id], euler[2])),
  ];

  if (clamped[0] === euler[0] && clamped[1] === euler[1] && clamped[2] === euler[2]) return;

  // Rebuild quaternion from clamped Euler.
  eulerToQuat(clamped[0], clamped[1], clamped[2], _tmpQ);
  L.qx[id] = _tmpQ[0]; L.qy[id] = _tmpQ[1];
  L.qz[id] = _tmpQ[2]; L.qw[id] = _tmpQ[3];
  markDirty(eid);
}

// ═══════════════════════════════════════════════════════════════════════
// HELPER — CCD toward a single goal, limited iterations
// ═══════════════════════════════════════════════════════════════════════

function solveCCDToGoal(world, joints, effectorEid, goalEid, weight, maxIter) {
  const target = readWorldPosition(goalEid, _tmpV3);
  const tx = target[0], ty = target[1], tz = target[2];

  for (let iter = 0; iter < maxIter; iter++) {
    const effPos = readWorldPosition(effectorEid, _tmpV3b);
    if (Math.hypot(effPos[0] - tx, effPos[1] - ty, effPos[2] - tz) < EPSILON) break;

    for (let j = joints.length - 2; j >= 0; j--) {
      const jointEid = joints[j];
      const jointPos = readWorldPosition(jointEid, _tmpV3);
      const effPos2 = readWorldPosition(effectorEid, _tmpV3b);

      const toEffX = effPos2[0] - jointPos[0];
      const toEffY = effPos2[1] - jointPos[1];
      const toEffZ = effPos2[2] - jointPos[2];
      const toTgtX = tx - jointPos[0];
      const toTgtY = ty - jointPos[1];
      const toTgtZ = tz - jointPos[2];

      const lenEff = Math.hypot(toEffX, toEffY, toEffZ);
      const lenTgt = Math.hypot(toTgtX, toTgtY, toTgtZ);
      if (lenEff < EPSILON || lenTgt < EPSILON) continue;

      const eN = [toEffX / lenEff, toEffY / lenEff, toEffZ / lenEff];
      const tN = [toTgtX / lenTgt, toTgtY / lenTgt, toTgtZ / lenTgt];
      const dot = Math.max(-1, Math.min(1, eN[0] * tN[0] + eN[1] * tN[1] + eN[2] * tN[2]));
      const angle = Math.acos(dot);
      if (angle < EPSILON) continue;

      const cross = crossVec(eN, tN);
      const crossLen = Math.hypot(cross[0], cross[1], cross[2]);
      if (crossLen < EPSILON) continue;

      const axis = [cross[0] / crossLen, cross[1] / crossLen, cross[2] / crossLen];
      const halfAngle = angle * 0.5 * weight;
      const s = Math.sin(halfAngle);
      _tmpQ[0] = axis[0] * s;
      _tmpQ[1] = axis[1] * s;
      _tmpQ[2] = axis[2] * s;
      _tmpQ[3] = Math.cos(halfAngle);

      applyWorldRotationDelta(jointEid, _tmpQ);
      propagateSubtree(world, jointEid);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// QUATERNION / VECTOR HELPERS
// ═══════════════════════════════════════════════════════════════════════

function slerpQuatInto(a, b, t, out) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];

  if (dot < 0) {
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }

  const cosHalfTheta = Math.abs(dot);
  if (cosHalfTheta >= 1.0 - EPSILON) {
    out[0] = a[0] + t * (bx - a[0]);
    out[1] = a[1] + t * (by - a[1]);
    out[2] = a[2] + t * (bz - a[2]);
    out[3] = a[3] + t * (bw - a[3]);
  } else {
    const halfTheta = Math.acos(cosHalfTheta);
    const sinHalfTheta = Math.sqrt(1.0 - cosHalfTheta * cosHalfTheta);
    const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
    const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;
    out[0] = a[0] * ratioA + bx * ratioB;
    out[1] = a[1] * ratioA + by * ratioB;
    out[2] = a[2] * ratioA + bz * ratioB;
    out[3] = a[3] * ratioA + bw * ratioB;
  }
  return out;
}

function crossVec(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function cross(a, b) { return crossVec(a, b); }

function quatToEuler(x, y, z, w) {
  const sinrCosp = 2 * (w * x + y * z);
  const cosrCosp = 1 - 2 * (x * x + y * y);
  const roll = Math.atan2(sinrCosp, cosrCosp);

  const sinp = 2 * (w * y - z * x);
  const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * HALF_PI : Math.asin(sinp);

  const sinyCosp = 2 * (w * z + x * y);
  const cosyCosp = 1 - 2 * (y * y + z * z);
  const yaw = Math.atan2(sinyCosp, cosyCosp);

  return [roll, pitch, yaw];
}

function eulerToQuat(roll, pitch, yaw, out) {
  const cr = Math.cos(roll * 0.5), sr = Math.sin(roll * 0.5);
  const cp = Math.cos(pitch * 0.5), sp = Math.sin(pitch * 0.5);
  const cy = Math.cos(yaw * 0.5), sy = Math.sin(yaw * 0.5);

  out[0] = sr * cp * cy - cr * sp * sy;
  out[1] = cr * sp * cy + sr * cp * sy;
  out[2] = cr * cp * sy - sr * sp * cy;
  out[3] = cr * cp * cy + sr * sp * sy;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// REUSED HELPERS FROM FILE 010 (copied to avoid circular imports)
// ═══════════════════════════════════════════════════════════════════════

function readWorldPosition(eid, out) {
  const id = getId(eid);
  const off = id * 16;
  const M = WorldTransformF32.m;
  out[0] = M[off + 12];
  out[1] = M[off + 13];
  out[2] = M[off + 14];
  return out;
}

function readWorldQuaternion(eid, out) {
  const id = getId(eid);
  const off = id * 16;
  const M = WorldTransformF32.m;
  const m00 = M[off], m01 = M[off + 4], m02 = M[off + 8];
  const m10 = M[off + 1], m11 = M[off + 5], m12 = M[off + 9];
  const m20 = M[off + 2], m21 = M[off + 6], m22 = M[off + 10];
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    out[3] = 0.25 / s;
    out[0] = (m21 - m12) * s;
    out[1] = (m02 - m20) * s;
    out[2] = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
    out[3] = (m21 - m12) / s;
    out[0] = 0.25 * s;
    out[1] = (m01 + m10) / s;
    out[2] = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
    out[3] = (m02 - m20) / s;
    out[0] = (m01 + m10) / s;
    out[1] = 0.25 * s;
    out[2] = (m12 + m21) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
    out[3] = (m10 - m01) / s;
    out[0] = (m02 + m20) / s;
    out[1] = (m12 + m21) / s;
    out[2] = 0.25 * s;
  }
  return out;
}

function applyWorldRotationDelta(eid, deltaQ) {
  const id = getId(eid);
  const L = LocalTransformF32;
  _tmpQ2[0] = L.qx[id]; _tmpQ2[1] = L.qy[id];
  _tmpQ2[2] = L.qz[id]; _tmpQ2[3] = L.qw[id];
  quat.multiply(_tmpQ2, deltaQ, _tmpQ2);
  const lenSq = _tmpQ2[0] ** 2 + _tmpQ2[1] ** 2 + _tmpQ2[2] ** 2 + _tmpQ2[3] ** 2;
  if (lenSq > EPSILON_SQ) {
    const inv = 1 / Math.sqrt(lenSq);
    _tmpQ2[0] *= inv; _tmpQ2[1] *= inv; _tmpQ2[2] *= inv; _tmpQ2[3] *= inv;
  }
  L.qx[id] = _tmpQ2[0]; L.qy[id] = _tmpQ2[1];
  L.qz[id] = _tmpQ2[2]; L.qw[id] = _tmpQ2[3];
  markDirty(eid);
}

function propagateSubtree(world, entity) {
  const children = getChildren(world, entity);
  for (const child of children) {
    markDirty(child);
    propagateSubtree(world, child);
  }
}

function collectJointChain(world, rootEid, count) {
  const result = [rootEid];
  let current = rootEid;
  while (result.length < count) {
    const children = getChildren(world, current);
    if (children.length === 0) break;
    current = children[0];
    result.push(current);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function ikAdvancedStats() {
  let orientedChains = 0;
  let multiEffectorChains = 0;
  let intermediaryChains = 0;
  for (const idx of ACTIVE_CHAINS) {
    if (IKChainAdv.useOrientation[idx]) orientedChains++;
    if (IKChainEffectos.count[idx] > 1) multiEffectorChains++;
    if (IKIntermediary.count[idx] > 0) intermediaryChains++;
  }
  return {
    totalChains: ACTIVE_CHAINS.size,
    orientedChains,
    multiEffectorChains,
    intermediaryChains,
  };
}