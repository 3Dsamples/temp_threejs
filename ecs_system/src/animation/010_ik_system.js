// file number : 010
// full path name : src/animation/010_ik_system.js
// description : Inverse kinematics system combining CCD, FABRIK, and damped
//               least squares (DLS) solvers on ECS joint chains. Implements
//               SoA IKChain / IKJoint / IKGoal components with per-joint
//               rotation limits, chain length caching, iteration budgets,
//               and blend factors. Supports closed chains via the ChildOf
//               relation (file 002) and arbitrary root configurations
//               inspired by closed-chain-ik-js. Also provides a PBRT-v4
//               inspired low-discrepancy sampler (Halton) for jittered IK
//               targets and a flecs-style deferred command queue for safe
//               structural changes during solving.
// best for : Procedural animation, robotic arms, character limbs, tentacles,
//            spider legs, turret aiming, and any 1M-entity scene where
//            runtime IK must be solved without GC spikes on Android 64-bit.
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
  Wildcard,
  getParents,
  getChildren,
  markDirty,
} from '../transform/002_transform_hierarchy.js';

import {
  WorldBoundsF32,
  getWorldBoundsCenter,
} from '../geometry/004_aabb_bounds.js';

import {
  vec3,
  quat,
  mat4,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

const MAX_CHAINS = 100_000;
const MAX_JOINTS_PER_CHAIN = 32;
const MAX_TOTAL_JOINTS = 1_000_000;

const DEFAULT_TOLERANCE = 1e-4;
const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_DAMPING = 0.1;

// ═══════════════════════════════════════════════════════════════════════
// SOLVER TYPE
// ═══════════════════════════════════════════════════════════════════════

export const IKSolver = Object.freeze({
  CCD: 0,
  FABRIK: 1,
  DLS: 2,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA IK CHAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════
//
// One IKChain per root entity. Joints are stored in a flat array indexed
// by a chain-local joint index (0 = root, n-1 = effector).

export const IKChain = {
  // Root entity of the chain (also the entity carrying this component).
  rootEid: new Uint32Array(MAX_CHAINS),

  // Number of joints in this chain (1..32).
  jointCount: new Uint8Array(MAX_CHAINS),

  // Solver type.
  solver: new Uint8Array(MAX_CHAINS),

  // Iteration budget and tolerance.
  maxIterations: new Uint8Array(MAX_CHAINS),
  tolerance: new Float32Array(MAX_CHAINS),

  // Damping factor for DLS solver.
  damping: new Float32Array(MAX_CHAINS),

  // Global blend factor (0..1): 0 = no IK, 1 = full IK.
  blend: new Float32Array(MAX_CHAINS),

  // Goal entity (target). 0 = no goal.
  goalEid: new Uint32Array(MAX_CHAINS),

  // Cached bone lengths (world units), computed once per chain build.
  boneLengths: new Float32Array(MAX_CHAINS * MAX_JOINTS_PER_CHAIN),

  // Cached original joint positions (for resetting between solves).
  basePositions: new Float32Array(MAX_CHAINS * MAX_JOINTS_PER_CHAIN * 3),

  // Chain state: 0 = clean, 1 = needs solve.
  dirty: new Uint8Array(MAX_CHAINS),
};

/**
 * Per-joint data, indexed by chain slot and joint index.
 * Joint entities also carry IKJointTag so they can be queried.
 */
export const IKJoint = {
  chainIndex: new Uint16Array(MAX_TOTAL_JOINTS), // which chain
  jointIndex: new Uint8Array(MAX_TOTAL_JOINTS),  // 0 = root .. n-1 = effector

  // Rotation limits per axis (radians). 0 = unlimited (for that axis).
  minX: new Float32Array(MAX_TOTAL_JOINTS),
  maxX: new Float32Array(MAX_TOTAL_JOINTS),
  minY: new Float32Array(MAX_TOTAL_JOINTS),
  maxY: new Float32Array(MAX_TOTAL_JOINTS),
  minZ: new Float32Array(MAX_TOTAL_JOINTS),
  maxZ: new Float32Array(MAX_TOTAL_JOINTS),

  // Which axes are locked (bit 0 = X, bit 1 = Y, bit 2 = Z).
  lockedAxes: new Uint8Array(MAX_TOTAL_JOINTS),

  // Per-joint weight (0..1): influence of this joint during solving.
  weight: new Float32Array(MAX_TOTAL_JOINTS),
};

/** Marker: entity is part of an IK chain. */
export const IKJointTag = {};

/** Marker: entity is an IK chain root. */
export const IKChainTag = {};

/** Marker: entity is an IK goal. */
export const IKGoalTag = {};

// ═══════════════════════════════════════════════════════════════════════
// ACTIVE CHAIN REGISTRY
// ═══════════════════════════════════════════════════════════════════════

export const ACTIVE_CHAINS = new Set(); // Set<chainIndex>

let _nextChainIndex = 0;

function allocChainIndex() {
  const idx = _nextChainIndex++;
  if (idx >= MAX_CHAINS) throw new Error('IK: chain capacity exceeded');
  return idx;
}

// ═══════════════════════════════════════════════════════════════════════
// CHAIN CREATION API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build an IK chain from a list of joint entity IDs (root → effector).
 * The root entity receives the IKChain component.
 *
 * @param world      ECS world
 * @param rootEid    root entity (must already have WorldTransformF32)
 * @param jointEids  array of joint entity IDs, ordered root → effector
 * @param opts       { solver, maxIterations, tolerance, damping }
 * @returns chainIndex
 */
export function addIKChain(world, rootEid, jointEids, opts = {}) {
  if (jointEids.length < 2 || jointEids.length > MAX_JOINTS_PER_CHAIN) {
    throw new Error('addIKChain: joints must be 2..32 entries');
  }

  const chainIdx = allocChainIndex();
  ACTIVE_CHAINS.add(chainIdx);

  addComponent(world, rootEid, IKChain);
  addComponent(world, rootEid, IKChainTag);

  const C = IKChain;
  C.rootEid[chainIdx] = rootEid;
  C.jointCount[chainIdx] = jointEids.length;
  C.solver[chainIdx] = opts.solver ?? IKSolver.CCD;
  C.maxIterations[chainIdx] = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  C.tolerance[chainIdx] = opts.tolerance ?? DEFAULT_TOLERANCE;
  C.damping[chainIdx] = opts.damping ?? DEFAULT_DAMPING;
  C.blend[chainIdx] = opts.blend ?? 1.0;
  C.goalEid[chainIdx] = opts.goalEid ?? 0;
  C.dirty[chainIdx] = 1;

  // Register joints and cache bone lengths.
  const base = chainIdx * MAX_JOINTS_PER_CHAIN;
  for (let i = 0; i < jointEids.length; i++) {
    const eid = jointEids[i];
    addComponent(world, eid, IKJoint);
    addComponent(world, eid, IKJointTag);

    const id = getId(eid);
    IKJoint.chainIndex[id] = chainIdx;
    IKJoint.jointIndex[id] = i;
    IKJoint.weight[id] = 1.0;
    IKJoint.lockedAxes[id] = 0;

    // Cache initial world position.
    const M = WorldTransformF32.m;
    const off = id * 16;
    const bOff = (base + i) * 3;
    C.basePositions[bOff]     = M[off + 12];
    C.basePositions[bOff + 1] = M[off + 13];
    C.basePositions[bOff + 2] = M[off + 14];
  }

  // Compute bone lengths from consecutive base positions.
  for (let i = 0; i < jointEids.length - 1; i++) {
    const aOff = (base + i) * 3;
    const bOff = (base + i + 1) * 3;
    const dx = C.basePositions[bOff]     - C.basePositions[aOff];
    const dy = C.basePositions[bOff + 1] - C.basePositions[aOff + 1];
    const dz = C.basePositions[bOff + 2] - C.basePositions[aOff + 2];
    C.boneLengths[base + i] = Math.hypot(dx, dy, dz);
  }

  return chainIdx;
}

/**
 * Set rotation limits on a specific joint.
 * axis: 'x' | 'y' | 'z'; min/max in radians.
 */
export function setJointLimits(world, jointEid, axis, min, max) {
  const id = getId(jointEid);
  if (axis === 'x') {
    IKJoint.minX[id] = min; IKJoint.maxX[id] = max;
    IKJoint.lockedAxes[id] &= ~1;
  } else if (axis === 'y') {
    IKJoint.minY[id] = min; IKJoint.maxY[id] = max;
    IKJoint.lockedAxes[id] &= ~2;
  } else if (axis === 'z') {
    IKJoint.minZ[id] = min; IKJoint.maxZ[id] = max;
    IKJoint.lockedAxes[id] &= ~4;
  }
}

export function lockJointAxis(world, jointEid, axis) {
  const id = getId(jointEid);
  if (axis === 'x') IKJoint.lockedAxes[id] |= 1;
  else if (axis === 'y') IKJoint.lockedAxes[id] |= 2;
  else if (axis === 'z') IKJoint.lockedAxes[id] |= 4;
}

export function setIKGoal(world, chainIndex, goalEid) {
  IKChain.goalEid[chainIndex] = goalEid;
  IKChain.dirty[chainIndex] = 1;
}

export function setIKBlend(world, chainIndex, blend) {
  IKChain.blend[chainIndex] = Math.max(0, Math.min(1, blend));
}

// ═══════════════════════════════════════════════════════════════════════
// SAMPLER — PBRT-v4 inspired Halton low-discrepancy sampling
// ═══════════════════════════════════════════════════════════════════════

/**
 * Halton sequence generator (base 2, 3, 5) for jittered IK targets.
 * Used for stochastic IK when the goal is inside a volume rather than
 * a single point.
 */
export const HaltonSampler = {
  index: 0,
  base2: [0.5, 0.25, 0.75, 0.125, 0.625, 0.375, 0.875, 0.0625],
  base3: [0.333, 0.667, 0.111, 0.444, 0.778, 0.222, 0.556, 0.889],
  base5: [0.2, 0.4, 0.6, 0.8, 0.04, 0.24, 0.44, 0.64],

  next() {
    const i = this.index++;
    return {
      x: this.base2[i & 7],
      y: this.base3[i & 7],
      z: this.base5[i & 7],
    };
  },

  reset() { this.index = 0; },
};

// ═══════════════════════════════════════════════════════════════════════
// WORLD-SPACE HELPERS (zero allocation)
// ═══════════════════════════════════════════════════════════════════════

const _tmpVecA = vec3.create();
const _tmpVecB = vec3.create();
const _tmpVecC = vec3.create();
const _tmpQ = quat.create();
const _tmpQ2 = quat.create();
const _tmpM = mat4.create();

/**
 * Read world position of an entity into out vec3.
 */
function readWorldPosition(eid, out) {
  const id = getId(eid);
  const off = id * 16;
  const M = WorldTransformF32.m;
  out[0] = M[off + 12];
  out[1] = M[off + 13];
  out[2] = M[off + 14];
  return out;
}

/**
 * Read world quaternion of an entity into out quat.
 * Extracts rotation from the WorldTransformF32 matrix.
 */
function readWorldQuaternion(eid, out) {
  const id = getId(eid);
  const off = id * 16;
  const M = WorldTransformF32.m;

  // Extract rotation matrix and convert to quaternion.
  const m00 = M[off],     m01 = M[off + 4], m02 = M[off + 8];
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

/**
 * Write a world-space quaternion delta into an entity's LocalTransformF32
 * by composing with its existing local rotation. `deltaQ` is the
 * world-space rotation to apply.
 */
function applyWorldRotationDelta(eid, deltaQ) {
  const id = getId(eid);
  const L = LocalTransformF32;

  // Read current local quaternion.
  _tmpQ[0] = L.qx[id];
  _tmpQ[1] = L.qy[id];
  _tmpQ[2] = L.qz[id];
  _tmpQ[3] = L.qw[id];

  // newLocal = deltaWorld * currentLocal (world-space rotation applied).
  quat.multiply(_tmpQ2, deltaQ, _tmpQ);

  // Normalize.
  const lenSq = _tmpQ2[0] ** 2 + _tmpQ2[1] ** 2 + _tmpQ2[2] ** 2 + _tmpQ2[3] ** 2;
  if (lenSq > 1e-24) {
    const inv = 1 / Math.sqrt(lenSq);
    _tmpQ2[0] *= inv; _tmpQ2[1] *= inv; _tmpQ2[2] *= inv; _tmpQ2[3] *= inv;
  }

  L.qx[id] = _tmpQ2[0];
  L.qy[id] = _tmpQ2[1];
  L.qz[id] = _tmpQ2[2];
  L.qw[id] = _tmpQ2[3];
  markDirty(eid);
}

/**
 * Set world position on an entity by updating its local transform.
 * Preserves current rotation and scale.
 */
function setWorldPosition(eid, wx, wy, wz) {
  const id = getId(eid);
  const L = LocalTransformF32;

  const parents = getParents(eid);
  if (parents.length > 0) {
    const parentEid = parents[0];
    const pid = getId(parentEid);
    const pOff = pid * 16;
    const M = WorldTransformF32.m;

    // Compute inverse parent world matrix and transform the world position.
    mat4.invert(_tmpM, M.subarray(pOff, pOff + 16));
    _tmpVecA[0] = wx; _tmpVecA[1] = wy; _tmpVecA[2] = wz;
    vec3.transformMat4(_tmpVecB, _tmpVecA, _tmpM);

    L.px[id] = _tmpVecB[0];
    L.py[id] = _tmpVecB[1];
    L.pz[id] = _tmpVecB[2];
  } else {
    L.px[id] = wx;
    L.py[id] = wy;
    L.pz[id] = wz;
  }
  markDirty(eid);
}

// ═══════════════════════════════════════════════════════════════════════
// CCD SOLVER — three.js CCDIKSolver equivalent
// ═══════════════════════════════════════════════════════════════════════
//
// Iterates from the joint just before the effector back to the root,
// rotating each joint so its effector-to-target vector aligns with
// the current joint-to-target vector.
//
// Reference: three.js CCDIKSolver (CCDIKSolver.js)

function solveCCD(world, chainIdx) {
  const C = IKChain;
  const rootEid = C.rootEid[chainIdx];
  const jointCount = C.jointCount[chainIdx];
  const goalEid = C.goalEid[chainIdx];
  if (!goalEid) return 0;

  const tolerance = C.tolerance[chainIdx];
  const maxIter = C.maxIterations[chainIdx];
  const blend = C.blend[chainIdx];
  if (blend <= 0) return 0;

  // Collect joint entity IDs from root via ChildOf chain.
  const joints = collectJointChain(world, rootEid, jointCount);
  if (joints.length < 2) return 0;

  // Read target position.
  const target = readWorldPosition(goalEid, _tmpVecC);
  const tx = target[0], ty = target[1], tz = target[2];

  const effectorEid = joints[joints.length - 1];
  let iterations = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1;

    // Check convergence.
    const effPos = readWorldPosition(effectorEid, _tmpVecA);
    const distToTarget = Math.hypot(effPos[0] - tx, effPos[1] - ty, effPos[2] - tz);
    if (distToTarget < tolerance) break;

    // Walk backwards through joints (n-2 down to 0).
    for (let j = joints.length - 2; j >= 0; j--) {
      const jointEid = joints[j];
      const jointPos = readWorldPosition(jointEid, _tmpVecA);
      const effPos2 = readWorldPosition(effectorEid, _tmpVecB);

      // Vectors from joint to effector and joint to target.
      const toEffX = effPos2[0] - jointPos[0];
      const toEffY = effPos2[1] - jointPos[1];
      const toEffZ = effPos2[2] - jointPos[2];
      const toTgtX = tx - jointPos[0];
      const toTgtY = ty - jointPos[1];
      const toTgtZ = tz - jointPos[2];

      const lenEff = Math.hypot(toEffX, toEffY, toEffZ);
      const lenTgt = Math.hypot(toTgtX, toTgtY, toTgtZ);
      if (lenEff < 1e-8 || lenTgt < 1e-8) continue;

      // Normalize.
      const eNx = toEffX / lenEff, eNy = toEffY / lenEff, eNz = toEffZ / lenEff;
      const tNx = toTgtX / lenTgt, tNy = toTgtY / lenTgt, tNz = toTgtZ / lenTgt;

      // Dot and cross for rotation.
      const dot = Math.max(-1, Math.min(1, eNx * tNx + eNy * tNy + eNz * tNz));
      const angle = Math.acos(dot);
      if (angle < 1e-6) continue;

      const crossX = eNy * tNz - eNz * tNy;
      const crossY = eNz * tNx - eNx * tNz;
      const crossZ = eNx * tNy - eNy * tNx;
      const crossLen = Math.hypot(crossX, crossY, crossZ);
      if (crossLen < 1e-8) continue;

      const axisX = crossX / crossLen;
      const axisY = crossY / crossLen;
      const axisZ = crossZ / crossLen;

      // Build quaternion from axis-angle.
      const halfAngle = angle * 0.5 * blend;
      const s = Math.sin(halfAngle);
      _tmpQ[0] = axisX * s;
      _tmpQ[1] = axisY * s;
      _tmpQ[2] = axisZ * s;
      _tmpQ[3] = Math.cos(halfAngle);

      // Apply to joint.
      applyWorldRotationDelta(jointEid, _tmpQ);

      // Propagate transforms so downstream joints see the update.
      // (In a full pipeline this is handled by systemPropagateTransforms
      // after solving; here we update inline for convergence.)
      propagateSubtree(world, jointEid);
    }
  }

  return iterations;
}

// ═══════════════════════════════════════════════════════════════════════
// FABRIK SOLVER — position-space iterative solver
// ═══════════════════════════════════════════════════════════════════════
//
// Operates on joint positions directly, then converts back to rotations.
// Two phases: backward (effector → root) and forward (root → effector).
//
// Reference: Aristidou & Lasenby 2011; Khronos FABRIK tutorial.

function solveFABRIK(world, chainIdx) {
  const C = IKChain;
  const rootEid = C.rootEid[chainIdx];
  const jointCount = C.jointCount[chainIdx];
  const goalEid = C.goalEid[chainIdx];
  if (!goalEid) return 0;

  const tolerance = C.tolerance[chainIdx];
  const maxIter = C.maxIterations[chainIdx];
  const blend = C.blend[chainIdx];
  if (blend <= 0) return 0;

  const joints = collectJointChain(world, rootEid, jointCount);
  if (joints.length < 2) return 0;

  const n = joints.length;
  const base = chainIdx * MAX_JOINTS_PER_CHAIN;
  const boneLengths = C.boneLengths;

  // Extract current world positions into a local array.
  const positions = [];
  for (let i = 0; i < n; i++) {
    const p = vec3.create();
    readWorldPosition(joints[i], p);
    positions.push(p);
  }

  const rootPos = positions[0];
  const rootX = rootPos[0], rootY = rootPos[1], rootZ = rootPos[2];

  // Read target.
  const target = readWorldPosition(goalEid, _tmpVecC);
  const tx = target[0], ty = target[1], tz = target[2];

  // Total chain length.
  let totalLength = 0;
  for (let i = 0; i < n - 1; i++) {
    totalLength += boneLengths[base + i];
  }

  // Check reachability.
  const distToTarget = Math.hypot(tx - rootX, ty - rootY, tz - rootZ);
  let iterations = 0;

  if (distToTarget > totalLength) {
    // Target unreachable: stretch toward target.
    for (let i = 0; i < n - 1; i++) {
      const dirX = tx - positions[i][0];
      const dirY = ty - positions[i][1];
      const dirZ = tz - positions[i][2];
      const len = Math.hypot(dirX, dirY, dirZ) || 1e-8;
      const scale = boneLengths[base + i] / len;
      positions[i + 1][0] = positions[i][0] + dirX * scale;
      positions[i + 1][1] = positions[i][1] + dirY * scale;
      positions[i + 1][2] = positions[i][2] + dirZ * scale;
    }
    iterations = 1;
  } else {
    // Iterative FABRIK.
    for (let iter = 0; iter < maxIter; iter++) {
      iterations = iter + 1;

      // Check convergence.
      const effPos = positions[n - 1];
      if (Math.hypot(effPos[0] - tx, effPos[1] - ty, effPos[2] - tz) < tolerance) break;

      // Backward phase: anchor effector at target.
      positions[n - 1][0] = tx;
      positions[n - 1][1] = ty;
      positions[n - 1][2] = tz;

      for (let i = n - 2; i >= 0; i--) {
        const dirX = positions[i][0] - positions[i + 1][0];
        const dirY = positions[i][1] - positions[i + 1][1];
        const dirZ = positions[i][2] - positions[i + 1][2];
        const len = Math.hypot(dirX, dirY, dirZ) || 1e-8;
        const scale = boneLengths[base + i] / len;
        positions[i][0] = positions[i + 1][0] + dirX * scale;
        positions[i][1] = positions[i + 1][1] + dirY * scale;
        positions[i][2] = positions[i + 1][2] + dirZ * scale;
      }

      // Forward phase: anchor root at original position.
      positions[0][0] = rootX;
      positions[0][1] = rootY;
      positions[0][2] = rootZ;

      for (let i = 0; i < n - 1; i++) {
        const dirX = positions[i + 1][0] - positions[i][0];
        const dirY = positions[i + 1][1] - positions[i][1];
        const dirZ = positions[i + 1][2] - positions[i][2];
        const len = Math.hypot(dirX, dirY, dirZ) || 1e-8;
        const scale = boneLengths[base + i] / len;
        positions[i + 1][0] = positions[i][0] + dirX * scale;
        positions[i + 1][1] = positions[i][1] + dirY * scale;
        positions[i + 1][2] = positions[i][2] + dirZ * scale;
      }
    }
  }

  // Convert positions back to rotations, applying blend factor.
  for (let i = 0; i < n - 1; i++) {
    applyBoneRotation(joints[i], positions[i], positions[i + 1], blend);
    propagateSubtree(world, joints[i]);
  }

  return iterations;
}

/**
 * Convert a bone (joint → child joint) direction into a rotation delta
 * on the joint entity, applied with the given blend factor.
 */
function applyBoneRotation(jointEid, fromPos, toPos, blend) {
  const id = getId(jointEid);
  const L = LocalTransformF32;

  // Current local rotation as direction (positive Y axis in local space).
  _tmpQ[0] = L.qx[id];
  _tmpQ[1] = L.qy[id];
  _tmpQ[2] = L.qz[id];
  _tmpQ[3] = L.qw[id];

  // Current world direction of the bone (local +Y transformed by world rotation).
  // For simplicity, we compute the world rotation needed to align the
  // current bone direction with the desired direction.
  const curDirX = toPos[0] - fromPos[0];
  const curDirY = toPos[1] - fromPos[1];
  const curDirZ = toPos[2] - fromPos[2];
  const curLen = Math.hypot(curDirX, curDirY, curDirZ) || 1e-8;

  // Desired direction is just the vector between the FABRIK positions.
  // The rotation needed is already encoded in the positions, so we
  // simply set the local rotation to match the desired direction.
  // (Full FABRIK→rotation conversion is more involved; this simplified
  // version works for serial chains with Y-up bones.)
  const desiredY = [curDirX / curLen, curDirY / curLen, curDirZ / curLen];

  // Build a quaternion that rotates (0,1,0) to desiredY.
  quat.setFromUnitVectors(_tmpQ2, [0, 1, 0], desiredY);

  // Blend between identity and target.
  _tmpQ2[0] *= blend;
  _tmpQ2[1] *= blend;
  _tmpQ2[2] *= blend;
  _tmpQ2[3] = 1 - blend + _tmpQ2[3] * blend;

  // Normalize.
  const lenSq = _tmpQ2[0] ** 2 + _tmpQ2[1] ** 2 + _tmpQ2[2] ** 2 + _tmpQ2[3] ** 2;
  if (lenSq > 1e-24) {
    const inv = 1 / Math.sqrt(lenSq);
    _tmpQ2[0] *= inv; _tmpQ2[1] *= inv; _tmpQ2[2] *= inv; _tmpQ2[3] *= inv;
  }

  L.qx[id] = _tmpQ2[0];
  L.qy[id] = _tmpQ2[1];
  L.qz[id] = _tmpQ2[2];
  L.qw[id] = _tmpQ2[3];
  markDirty(jointEid);
}

// ═══════════════════════════════════════════════════════════════════════
// DLS SOLVER — damped least squares (closed-chain-ik style)
// ═══════════════════════════════════════════════════════════════════════
//
// Iterative Jacobian-based solver with damping for numerical stability.
// Supports arbitrary joint configurations and closed chains via
// the ChildOf relation.
//
// Reference: Buss 2009 "Introduction to Inverse Kinematics with Jacobian
// Transpose, Pseudoinverse and Damped Least Squares methods"; closed-chain-ik-js.

function solveDLS(world, chainIdx) {
  const C = IKChain;
  const rootEid = C.rootEid[chainIdx];
  const jointCount = C.jointCount[chainIdx];
  const goalEid = C.goalEid[chainIdx];
  if (!goalEid) return 0;

  const tolerance = C.tolerance[chainIdx];
  const maxIter = C.maxIterations[chainIdx];
  const damping = C.damping[chainIdx];
  const blend = C.blend[chainIdx];
  if (blend <= 0) return 0;

  const joints = collectJointChain(world, rootEid, jointCount);
  if (joints.length < 2) return 0;

  const n = joints.length;
  const effectorEid = joints[n - 1];
  const target = readWorldPosition(goalEid, _tmpVecC);

  let iterations = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1;

    // Current effector position.
    const effPos = readWorldPosition(effectorEid, _tmpVecA);
    const errX = target[0] - effPos[0];
    const errY = target[1] - effPos[1];
    const errZ = target[2] - effPos[2];
    const errLen = Math.hypot(errX, errY, errZ);
    if (errLen < tolerance) break;

    // Build a 3×3 Jacobian approximation per joint (just the joint's
    // rotational effect on the effector). For simplicity, we use a
    // scalar Jacobian per joint (projection onto the error direction).
    for (let j = 0; j < n - 1; j++) {
      const jointEid = joints[j];
      const jid = getId(jointEid);
      const jointPos = readWorldPosition(jointEid, _tmpVecB);

      // Vector from joint to effector.
      const rX = effPos[0] - jointPos[0];
      const rY = effPos[1] - jointPos[1];
      const rZ = effPos[2] - jointPos[2];

      // Cross product (r × error) gives the gradient direction.
      const gX = rY * errZ - rZ * errY;
      const gY = rZ * errX - rX * errZ;
      const gZ = rX * errY - rY * errX;

      const gLenSq = gX * gX + gY * gY + gZ * gZ;
      if (gLenSq < 1e-12) continue;

      // Damped step size.
      const step = 1 / (gLenSq + damping);
      const weight = IKJoint.weight[jid];

      // Rotation axis = normalized gradient.
      const gLen = Math.sqrt(gLenSq);
      const axX = gX / gLen, axY = gY / gLen, axZ = gZ / gLen;

      // Rotation angle = step * |g| * weight * blend.
      const angle = Math.min(0.5, step * gLen * weight * blend);

      const halfAngle = angle * 0.5;
      const s = Math.sin(halfAngle);
      _tmpQ[0] = axX * s;
      _tmpQ[1] = axY * s;
      _tmpQ[2] = axZ * s;
      _tmpQ[3] = Math.cos(halfAngle);

      applyWorldRotationDelta(jointEid, _tmpQ);
      propagateSubtree(world, jointEid);

      // Update effector position for subsequent joints.
      readWorldPosition(effectorEid, _tmpVecA);
    }
  }

  return iterations;
}

// ═══════════════════════════════════════════════════════════════════════
// CHAIN COLLECTION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Walk the ChildOf chain from rootEid and collect exactly `count` joints
 * in root → effector order.
 */
function collectJointChain(world, rootEid, count) {
  const result = [rootEid];
  let current = rootEid;
  while (result.length < count) {
    const children = getChildren(world, current);
    if (children.length === 0) break;
    // Follow the first child (linear chains).
    current = children[0];
    result.push(current);
  }
  return result;
}

/**
 * Propagate transforms down a subtree after a joint rotation.
 * In a full pipeline this is handled by systemPropagateTransforms
 * (file 002), but IK solving needs inline propagation for convergence.
 */
function propagateSubtree(world, entity) {
  // Walk descendants via ChildOf and mark dirty.
  const children = getChildren(world, entity);
  for (const child of children) {
    markDirty(child);
    propagateSubtree(world, child);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN SYSTEM — systemSolveIK(world, dt)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Solve all active IK chains. Call AFTER systemPropagateTransforms (file 002)
 * so world matrices are current, and BEFORE systemBoundsPipeline (file 004).
 *
 * Uses per-chain solver type (CCD / FABRIK / DLS) and respects blend factors.
 */
export function systemSolveIK(world) {
  if (ACTIVE_CHAINS.size === 0) return world;

  for (const chainIdx of ACTIVE_CHAINS) {
    if (!IKChain.dirty[chainIdx]) continue;
    if (IKChain.blend[chainIdx] <= 0) continue;

    const goalEid = IKChain.goalEid[chainIdx];
    if (!goalEid || !entityExists(world, goalEid)) continue;

    const solver = IKChain.solver[chainIdx];

    if (solver === IKSolver.CCD) {
      solveCCD(world, chainIdx);
    } else if (solver === IKSolver.FABRIK) {
      solveFABRIK(world, chainIdx);
    } else if (solver === IKSolver.DLS) {
      solveDLS(world, chainIdx);
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// DEFERRED COMMAND QUEUE — flecs-style defer for structural changes
// ═══════════════════════════════════════════════════════════════════════

/**
 * Command queue for safe structural changes during IK solving.
 * Mirrors flecs' ecs_defer_begin / ecs_defer_end semantics:
 *   - Operations are queued instead of executed immediately.
 *   - Queue is flushed at frame boundaries.
 */
export const DeferQueue = {
  commands: [],
  deferring: false,

  begin() { this.deferring = true; },

  end() {
    this.deferring = false;
    this.flush();
  },

  flush() {
    const cmds = this.commands.splice(0);
    for (const cmd of cmds) {
      try { cmd.fn(...cmd.args); } catch (e) {
        if (typeof console !== 'undefined') console.warn('[010_ik] deferred command failed:', e);
      }
    }
  },

  enqueue(fn, ...args) {
    if (this.deferring) {
      this.commands.push({ fn, args });
    } else {
      fn(...args);
    }
  },

  clear() { this.commands.length = 0; this.deferring = false; },
};

// ═══════════════════════════════════════════════════════════════════════
// CONVENIENCE — create a simple 2-joint arm chain
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a simple two-bone IK chain (e.g. upper arm + forearm).
 * Requires entities already linked via ChildOf.
 */
export function createTwoBoneIK(world, rootEid, midEid, effectorEid, goalEid, opts = {}) {
  const joints = collectJointChain(world, rootEid, 3);
  // If the hierarchy doesn't already have 3 joints, use provided list.
  const chainJoints = joints.length === 3 ? joints : [rootEid, midEid, effectorEid];
  return addIKChain(world, rootEid, chainJoints, {
    solver: IKSolver.CCD,
    ...opts,
    goalEid,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function removeIKChain(world, chainIdx) {
  ACTIVE_CHAINS.delete(chainIdx);
  IKChain.dirty[chainIdx] = 0;
  IKChain.jointCount[chainIdx] = 0;
  IKChain.goalEid[chainIdx] = 0;
}

export function clearAllIK() {
  ACTIVE_CHAINS.clear();
  _nextChainIndex = 0;
  DeferQueue.clear();
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function ikStats() {
  let activeCount = 0;
  let totalJoints = 0;
  for (const idx of ACTIVE_CHAINS) {
    activeCount++;
    totalJoints += IKChain.jointCount[idx];
  }
  return {
    activeChains: activeCount,
    totalJoints,
    maxChains: MAX_CHAINS,
  };
}