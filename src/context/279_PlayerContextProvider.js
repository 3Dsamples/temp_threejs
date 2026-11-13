// file number : 279
// full path name : src/context/279_PlayerContextProvider.js
// description : Complete player body, equipment, and animation controller for any living creature (humanoid, quadruped, bird, fish). Full 41-joint skeleton (spine, neck, head, 5 fingers per hand, weapon attachment bones, head/chest/pelvis/back attachment bones) stored as flat SoA. Live registries for joints, animation states, GOAP bits, and procedural motion parameters that can be extended at runtime without breaking the system. Pluggable IK stack: two-bone analytic, CCD, FABRIK, Jacobian transpose, and hybrid solvers; selectable per limb and per creature type. Root-motion profiles for walk, run, swim, fly, jump, fall, and climb with per-profile gravity, acceleration, and jump impulse. Motion matching with a pre-populated locomotion database and nearest-neighbor search. Procedural deformation overlays for poke, muscle bulge, bend, screw, balloon pressure, heat spread, and fire spread. GOAP A* planner over dynamically extensible world-state bits. Emits causal events on attack/jump/land/interact/hit; consumes causal events for hit reactions. Writes pose, velocity, focus distance, stats, tool state, skeleton transforms, equipment state, and light-eligible emissive flags into frame.layers.player and frame.layers.physical.
// best for : Player and NPC controller in a living dynamic world. Drives all animation, body, equipment, and deformation behaviour; feeds the render tier, the physics tier, the causal field, and the clustered lighting pass.
// license : MIT

import {
  Vec2, Vec3, Vec4, Mat4, Quat, Quat2,
  Precision, SimplexNoise,
  Interpolant, LinearInterpolant, CubicInterpolant, BezierInterpolant,
  Ray, Plane, Sphere, Box3,
  ContextFrame, CoreClock, CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES,
  TemporalContextProvider, WEATHER,
  CausalContextProvider, DERIVED_SIGNAL,
  CoreLayers, LAYER, smoothstep,
  CurveEvaluator, CURVE_KIND
} from './264_MathECSImportBarrel.js';

// ══════════════════════════════════════════════════════════════════
// ─── LIVE REGISTRIES (extensible at runtime) ─────────────────────
// ══════════════════════════════════════════════════════════════════

class JointRegistry {
  constructor() {
    this._indexByName = new Map();
    this._nameByIndex = [];
    this._parentOf = [];
    this._localPos = [];    // per joint: [x, y, z]
    this._localRot = [];    // per joint: [x, y, z, w]
    this._dynamicFrom = 0;  // joints below this index are fixed built-ins
  }

  register(name, parentName, localPos, localRot = [0, 0, 0, 1]) {
    if (this._indexByName.has(name)) return this._indexByName.get(name);
    const idx = this._nameByIndex.length;
    const parentIdx = parentName ? this._indexByName.get(parentName) ?? -1 : -1;
    this._indexByName.set(name, idx);
    this._nameByIndex.push(name);
    this._parentOf.push(parentIdx);
    this._localPos.push(localPos.slice());
    this._localRot.push(localRot.slice());
    return idx;
  }

  freezeBuiltins() {
    this._dynamicFrom = this._nameByIndex.length;
  }

  getIndex(name) { return this._indexByName.has(name) ? this._indexByName.get(name) : -1; }
  getName(idx) { return this._nameByIndex[idx] ?? 'UNKNOWN'; }
  getParent(idx) { return this._parentOf[idx] ?? -1; }
  getLocalPos(idx) { return this._localPos[idx]; }
  getLocalRot(idx) { return this._localRot[idx]; }
  get count() { return this._nameByIndex.length; }
  get dynamicFrom() { return this._dynamicFrom; }
  names() { return this._nameByIndex.slice(); }
}

class AnimStateRegistry {
  constructor() {
    this._idByName = new Map();
    this._nameById = [];
    this._priorityOf = [];
  }

  register(name, priority = 0) {
    if (this._idByName.has(name)) return this._idByName.get(name);
    const id = this._nameById.length;
    this._idByName.set(name, id);
    this._nameById.push(name);
    this._priorityOf.push(priority);
    return id;
  }

  getId(name) { return this._idByName.has(name) ? this._idByName.get(name) : -1; }
  getName(id) { return this._nameById[id] ?? 'unknown'; }
  getPriority(id) { return this._priorityOf[id] ?? 0; }
  get count() { return this._nameById.length; }
  all() { return this._nameById.slice(); }
}

class GoapBitRegistry {
  constructor() {
    this._bitByName = new Map();
    this._nameByBit = [];
  }

  register(name) {
    if (this._bitByName.has(name)) return this._bitByName.get(name);
    const next = this._nameByBit.length;
    if (next >= 32) throw new Error('GOAP bit registry exceeded 32 bits');
    const bit = 1 << next;
    this._bitByName.set(name, bit);
    this._nameByBit.push(name);
    return bit;
  }

  getBit(name) { return this._bitByName.has(name) ? this._bitByName.get(name) : 0; }
  getName(bit) {
    for (let i = 0; i < this._nameByBit.length; i++) {
      if ((1 << i) === bit) return this._nameByBit[i];
    }
    return 'unknown';
  }
  all() { return this._nameByBit.slice(); }
}

class ProceduralParamRegistry {
  constructor() {
    this._defaults = new Map();
  }

  register(name, params) {
    if (!this._defaults.has(name)) this._defaults.set(name, { ...params });
  }

  get(name) { return this._defaults.get(name); }
  has(name) { return this._defaults.has(name); }
  names() { return [...this._defaults.keys()]; }
}

// ─── build the default registries ────────────────────────────────
const _jointReg = new JointRegistry();
const _animReg = new AnimStateRegistry();
const _goapReg = new GoapBitRegistry();
const _procReg = new ProceduralParamRegistry();

// ── joints (built-in humanoid template) ────────────────────────
function registerBuiltinJoints(reg) {
  // core
  reg.register('ROOT',    null,       [0, 0, 0]);
  reg.register('HIPS',    'ROOT',     [0, 0.95, 0]);
  reg.register('SPINE_0', 'HIPS',     [0, 0.10, 0]);
  reg.register('SPINE_1', 'SPINE_0',  [0, 0.15, 0]);
  reg.register('SPINE_2', 'SPINE_1',  [0, 0.15, 0]);
  reg.register('SPINE_3', 'SPINE_2',  [0, 0.15, 0]);
  reg.register('NECK_1',  'SPINE_3',  [0, 0.10, 0]);
  reg.register('NECK_2',  'NECK_1',   [0, 0.05, 0]);
  reg.register('HEAD',    'NECK_2',   [0, 0.15, 0]);
  reg.register('HEAD_ATTACH', 'HEAD', [0, 0.10, 0]);

  // left arm
  reg.register('L_SHOULDER', 'SPINE_3', [ 0.18, 0.10, 0]);
  reg.register('L_ELBOW',    'L_SHOULDER', [ 0.28, 0, 0]);
  reg.register('L_WRIST',    'L_ELBOW',    [ 0.25, 0, 0]);
  reg.register('L_HAND',     'L_WRIST',    [ 0.08, 0, 0]);
  reg.register('L_FINGER_0', 'L_HAND',     [ 0.05,  0.02,  0.02]);
  reg.register('L_FINGER_1', 'L_HAND',     [ 0.05,  0.01,  0.01]);
  reg.register('L_FINGER_2', 'L_HAND',     [ 0.05,  0,    0]);
  reg.register('L_FINGER_3', 'L_HAND',     [ 0.05, -0.01,  0.01]);
  reg.register('L_FINGER_4', 'L_HAND',     [ 0.05, -0.02,  0.02]);
  reg.register('L_WEAPON_ATTACH', 'L_HAND', [0.02, 0, 0]);

  // right arm
  reg.register('R_SHOULDER', 'SPINE_3', [-0.18, 0.10, 0]);
  reg.register('R_ELBOW',    'R_SHOULDER', [-0.28, 0, 0]);
  reg.register('R_WRIST',    'R_ELBOW',    [-0.25, 0, 0]);
  reg.register('R_HAND',     'R_WRIST',    [-0.08, 0, 0]);
  reg.register('R_FINGER_0', 'R_HAND',     [-0.05,  0.02,  0.02]);
  reg.register('R_FINGER_1', 'R_HAND',     [-0.05,  0.01,  0.01]);
  reg.register('R_FINGER_2', 'R_HAND',     [-0.05,  0,    0]);
  reg.register('R_FINGER_3', 'R_HAND',     [-0.05, -0.01,  0.01]);
  reg.register('R_FINGER_4', 'R_HAND',     [-0.05, -0.02,  0.02]);
  reg.register('R_WEAPON_ATTACH', 'R_HAND', [-0.02, 0, 0]);

  // left leg
  reg.register('L_HIP',  'HIPS', [ 0.10, -0.05, 0]);
  reg.register('L_KNEE', 'L_HIP', [ 0, -0.42, 0]);
  reg.register('L_FOOT', 'L_KNEE', [ 0, -0.42, 0]);
  reg.register('L_TOE',  'L_FOOT', [ 0, -0.05, 0.10]);

  // right leg
  reg.register('R_HIP',  'HIPS', [-0.10, -0.05, 0]);
  reg.register('R_KNEE', 'R_HIP', [ 0, -0.42, 0]);
  reg.register('R_FOOT', 'R_KNEE', [ 0, -0.42, 0]);
  reg.register('R_TOE',  'R_FOOT', [ 0, -0.05, 0.10]);

  // body attachment bones for equipment
  reg.register('CHEST_ATTACH',  'SPINE_2', [0, 0.05, 0]);
  reg.register('PELVIS_ATTACH', 'HIPS',    [0, 0.05, 0]);
  reg.register('BACK_ATTACH',   'SPINE_1', [0, 0, -0.10]);

  reg.freezeBuiltins();
}
registerBuiltinJoints(_jointReg);

// ── animation states (built-in) ────────────────────────────────
[
  ['idle', 0], ['walk', 1], ['run', 2], ['sprint', 3], ['jump', 4],
  ['fall', 5], ['land', 6], ['attack', 7], ['block', 8], ['reload', 9],
  ['hit', 10], ['death', 11], ['interact', 12], ['emote', 13],
  ['climb', 14], ['swim', 15], ['fly', 16], ['glide', 17]
].forEach(([name, priority]) => _animReg.register(name, priority));

// ── GOAP bits (built-in) ────────────────────────────────────────
[
  'HAS_TARGET', 'IN_RANGE', 'HAS_AMMO', 'HAS_LOS',
  'IS_MOVING', 'IS_GROUNDED', 'IS_RELOADING', 'IS_ATTACKING',
  'IS_BLOCKING', 'IS_HURT', 'IS_LOW_STAMINA', 'TARGET_DEAD',
  'IS_IN_WATER', 'IS_FLYING', 'IS_CLIMBING'
].forEach(n => _goapReg.register(n));

// ── procedural motion parameters (built-in) ────────────────────
_procReg.register('spring',   { stiffness: 80, damping: 12 });
_procReg.register('breath',   { period: 3.5, amplitude: 0.02 });
_procReg.register('blink',    { intervalMin: 2.5, intervalMax: 6.0, duration: 0.15 });
_procReg.register('poke',     { falloffRadius: 0.15, maxDisplacement: 0.05, recovery: 4.0 });
_procReg.register('muscle',   { bulgePerUnitTension: 0.10, maxBulge: 0.20 });
_procReg.register('bend',     { bendGain: 1.0, bendRate: 4.0 });
_procReg.register('screw',    { maxTwist: Math.PI * 0.5, twistRate: 8.0 });
_procReg.register('balloon',  { maxScale: 1.5, pressureResponse: 0.3 });
_procReg.register('heat',     { emissivePerC: 0.015, colorShiftPerC: 0.010 });
_procReg.register('fire',     { spreadRate: 0.5, heatPerSecond: 4.0, emissiveMax: 3.0 });

// ─── frozen export snapshots (built-ins only) ──────────────────
const JOINT = Object.freeze(
  _jointReg.names().reduce((acc, name, idx) => { acc[name] = idx; return acc; }, {})
);
const ANIM_STATE = Object.freeze(
  _animReg.all().reduce((acc, name, idx) => { acc[name.toUpperCase()] = idx; return acc; }, {})
);
const ANIM_STATE_NAMES = Object.freeze(_animReg.all());
const GOAP_BIT = Object.freeze(
  _goapReg.all().reduce((acc, name) => { acc[name] = _goapReg.getBit(name); return acc; }, {})
);

// ─── equipment slots ────────────────────────────────────────────
const EQUIP_SLOT = Object.freeze({
  MAIN_HAND: 0, OFF_HAND: 1, HEAD: 2, CHEST: 3, LEGS: 4, FEET: 5, BACK: 6,
  COUNT: 7
});

// ─── default attachment joints per equipment slot ──────────────
const EQUIP_DEFAULT_JOINT = Object.freeze({
  [EQUIP_SLOT.MAIN_HAND]: 'R_WEAPON_ATTACH',
  [EQUIP_SLOT.OFF_HAND]:  'L_WEAPON_ATTACH',
  [EQUIP_SLOT.HEAD]:      'HEAD_ATTACH',
  [EQUIP_SLOT.CHEST]:     'CHEST_ATTACH',
  [EQUIP_SLOT.LEGS]:      'PELVIS_ATTACH',
  [EQUIP_SLOT.FEET]:      'PELVIS_ATTACH',
  [EQUIP_SLOT.BACK]:      'BACK_ATTACH'
});

// ─── root-motion profiles ──────────────────────────────────────
const ROOT_MOTION_PROFILES = Object.freeze({
  walk:   { maxSpeed:  2.0, acceleration: 10, angularAcceleration:  5, gravityScale: 1.0, ground: 'ground', jumpImpulse: 0 },
  run:    { maxSpeed:  5.0, acceleration: 15, angularAcceleration:  8, gravityScale: 1.0, ground: 'ground', jumpImpulse: 0 },
  sprint: { maxSpeed:  7.5, acceleration: 18, angularAcceleration: 10, gravityScale: 1.0, ground: 'ground', jumpImpulse: 0 },
  swim:   { maxSpeed:  3.0, acceleration:  8, angularAcceleration:  4, gravityScale: 0.1, ground: 'water',  jumpImpulse: 0 },
  fly:    { maxSpeed:  8.0, acceleration: 12, angularAcceleration: 10, gravityScale: 0.0, ground: 'air',    jumpImpulse: 0 },
  glide:  { maxSpeed:  6.0, acceleration:  6, angularAcceleration:  6, gravityScale: 0.3, ground: 'air',    jumpImpulse: 0 },
  jump:   { maxSpeed:  4.0, acceleration:  5, angularAcceleration:  3, gravityScale: 1.0, ground: 'ground', jumpImpulse: 5.0 },
  fall:   { maxSpeed: 10.0, acceleration:  1, angularAcceleration:  2, gravityScale: 1.0, ground: 'air',    jumpImpulse: 0 },
  climb:  { maxSpeed:  1.5, acceleration:  6, angularAcceleration:  3, gravityScale: 0.3, ground: 'wall',   jumpImpulse: 0 }
});

// ─── IK solver IDs ─────────────────────────────────────────────
const IK_SOLVER = Object.freeze({
  TWO_BONE:  0,
  CCD:       1,
  FABRIK:    2,
  JACOBIAN:  3,
  HYBRID:    4
});

// ─── deformation overlay types ─────────────────────────────────
const DEFORM = Object.freeze({
  POKE:    0,
  MUSCLE:  1,
  BEND:    2,
  SCREW:   3,
  BALLOON: 4,
  HEAT:    5,
  FIRE:    6
});

// ══════════════════════════════════════════════════════════════════
// ─── IK SOLVERS ──────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Analytic two-bone: fast, exact for 2-segment chains (arms, legs).
class TwoBoneIKSolver {
  solve(chain, targetPos, weight, outRotations) {
    if (chain.length !== 3 || weight < 1e-5) return;
    const [a, b, c] = chain;
    const A = a.worldPos, B = b.worldPos, C = c.worldPos;

    const upperLen = A.distanceTo(B);
    const lowerLen = B.distanceTo(C);
    const targetDist = A.distanceTo(targetPos);

    const maxReach = upperLen + lowerLen - 0.001;
    const minReach = Math.abs(upperLen - lowerLen) + 0.001;
    const clamped = Math.min(maxReach, Math.max(minReach, targetDist));

    const cosU = (upperLen * upperLen + clamped * clamped - lowerLen * lowerLen) / (2 * upperLen * clamped);
    const cosL = (upperLen * upperLen + lowerLen * lowerLen - clamped * clamped) / (2 * upperLen * lowerLen);
    const upperAngle = Math.acos(Math.max(-1, Math.min(1, cosU)));
    const lowerAngle = Math.acos(Math.max(-1, Math.min(1, cosL)));

    const toTarget = targetPos.clone().sub(A).normalize();
    const bendAxis = new Vec3(0, 0, 1).cross(toTarget).normalize();
    if (bendAxis.lengthSq() < 1e-5) bendAxis.set(1, 0, 0);

    a.applyRotationDelta(bendAxis,  upperAngle * weight);
    b.applyRotationDelta(bendAxis, -lowerAngle * weight);
  }
}

// Cyclic Coordinate Descent: iterative, works for any chain length.
class CCDIKSolver {
  constructor(maxIterations = 8, tolerance = 0.01) {
    this.maxIterations = maxIterations;
    this.tolerance = tolerance;
  }

  solve(chain, targetPos, weight) {
    if (weight < 1e-5) return;
    const endJoint = chain[chain.length - 1];

    for (let iter = 0; iter < this.maxIterations; iter++) {
      for (let i = chain.length - 2; i >= 0; i--) {
        const joint = chain[i];
        const toEnd = endJoint.worldPos.clone().sub(joint.worldPos);
        const toTarget = targetPos.clone().sub(joint.worldPos);
        const endLen = toEnd.length();
        const tgtLen = toTarget.length();
        if (endLen < 1e-5 || tgtLen < 1e-5) continue;
        toEnd.normalize(); toTarget.normalize();

        const cosA = Math.max(-1, Math.min(1, toEnd.dot(toTarget)));
        const angle = Math.acos(cosA);
        if (angle < 1e-5) continue;

        const axis = toEnd.clone().cross(toTarget).normalize();
        if (axis.lengthSq() < 1e-5) continue;

        joint.applyRotationDelta(axis, angle * weight);
        endJoint.recomputeWorldFrom(joint);
      }
      if (endJoint.worldPos.distanceTo(targetPos) < this.tolerance) break;
    }
  }
}

// FABRIK: position-based, robust for limbs and tails.
class FABRIKIKSolver {
  constructor(maxIterations = 10, tolerance = 0.01) {
    this.maxIterations = maxIterations;
    this.tolerance = tolerance;
  }

  solve(chain, targetPos, weight) {
    if (weight < 1e-5 || chain.length < 2) return;
    const root = chain[0];
    const end = chain[chain.length - 1];
    const rootPos = root.worldPos.clone();

    // Segment lengths.
    const segLens = [];
    let totalLen = 0;
    for (let i = 0; i < chain.length - 1; i++) {
      const l = chain[i].worldPos.distanceTo(chain[i + 1].worldPos);
      segLens.push(l);
      totalLen += l;
    }

    const targetDist = rootPos.distanceTo(targetPos);
    if (targetDist > totalLen) {
      // Unreachable: stretch toward target.
      for (let i = 0; i < chain.length - 1; i++) {
        const dir = targetPos.clone().sub(chain[i].worldPos).normalize();
        chain[i + 1].worldPos.copy(chain[i].worldPos).addScaledVector(dir, segLens[i]);
      }
    } else {
      // Iterative FABRIK.
      const currentPos = chain.map(j => j.worldPos.clone());
      for (let iter = 0; iter < this.maxIterations; iter++) {
        // Backward: place end at target, work backward.
        currentPos[chain.length - 1].copy(targetPos);
        for (let i = chain.length - 2; i >= 0; i--) {
          const dir = currentPos[i].clone().sub(currentPos[i + 1]).normalize();
          currentPos[i].copy(currentPos[i + 1]).addScaledVector(dir, segLens[i]);
        }
        // Forward: place root at origin, work forward.
        currentPos[0].copy(rootPos);
        for (let i = 0; i < chain.length - 1; i++) {
          const dir = currentPos[i + 1].clone().sub(currentPos[i]).normalize();
          currentPos[i + 1].copy(currentPos[i]).addScaledVector(dir, segLens[i]);
        }
        if (currentPos[chain.length - 1].distanceTo(targetPos) < this.tolerance) break;
      }
      // Apply weighted result.
      for (let i = 0; i < chain.length; i++) {
        const target = currentPos[i];
        const cur = chain[i].worldPos;
        cur.lerp(target, weight);
      }
    }
  }
}

// Jacobian transpose: fine control, iterative, works per DOF.
class JacobianIKSolver {
  constructor(maxIterations = 6, stepSize = 0.1, tolerance = 0.01) {
    this.maxIterations = maxIterations;
    this.stepSize = stepSize;
    this.tolerance = tolerance;
  }

  solve(chain, targetPos, weight) {
    if (weight < 1e-5) return;
    const end = chain[chain.length - 1];

    for (let iter = 0; iter < this.maxIterations; iter++) {
      const err = targetPos.clone().sub(end.worldPos);
      if (err.length() < this.tolerance) break;

      // For each joint from end to root, compute a gradient step.
      for (let i = chain.length - 2; i >= 0; i--) {
        const joint = chain[i];
        const toEnd = end.worldPos.clone().sub(joint.worldPos);
        const toTarget = targetPos.clone().sub(joint.worldPos);
        if (toEnd.lengthSq() < 1e-6 || toTarget.lengthSq() < 1e-6) continue;

        const axis = toEnd.clone().normalize().cross(toTarget.clone().normalize()).normalize();
        if (axis.lengthSq() < 1e-6) continue;

        const angle = toEnd.angleTo(toTarget);
        const dq = angle * this.stepSize * weight;
        joint.applyRotationDelta(axis, dq);
        end.recomputeWorldFrom(joint);
      }
    }
  }
}

// Hybrid: two-bone analytic for the base, then CCD for refinement.
class HybridIKSolver {
  constructor() {
    this.twoBone = new TwoBoneIKSolver();
    this.ccd = new CCDIKSolver(4, 0.01);
  }

  solve(chain, targetPos, weight) {
    if (chain.length === 3) this.twoBone.solve(chain, targetPos, weight);
    this.ccd.solve(chain, targetPos, weight * 0.5);
  }
}

// ─── IK solver dispatcher ──────────────────────────────────────
const IK_SOLVERS = {
  [IK_SOLVER.TWO_BONE]: new TwoBoneIKSolver(),
  [IK_SOLVER.CCD]:      new CCDIKSolver(),
  [IK_SOLVER.FABRIK]:   new FABRIKIKSolver(),
  [IK_SOLVER.JACOBIAN]: new JacobianIKSolver(),
  [IK_SOLVER.HYBRID]:   new HybridIKSolver()
};

// ══════════════════════════════════════════════════════════════════
// ─── LIVE JOINT WRAPPER (with rotation-delta and FK recompute) ───
// ══════════════════════════════════════════════════════════════════

class JointNode {
  constructor(index, parent) {
    this.index = index;
    this.parent = parent;
    this.localPos = new Vec3();
    this.localRot = new Quat();
    this.worldPos = new Vec3();
    this.worldRot = new Quat();
    this.worldMat = new Mat4();
  }

  applyRotationDelta(axis, angle) {
    const delta = new Quat().setFromAxisAngle(axis, angle);
    this.localRot.premultiply(delta);
    this.localRot.normalize();
  }

  recomputeWorldFrom(parentNode) {
    if (parentNode) {
      this.worldRot.copy(parentNode.worldRot).multiply(this.localRot);
      this.worldPos.copy(this.localPos).applyQuaternion(parentNode.worldRot).add(parentNode.worldPos);
    } else {
      this.worldRot.copy(this.localRot);
      this.worldPos.copy(this.localPos);
    }
    this.worldMat.compose(this.worldPos, this.worldRot, new Vec3(1, 1, 1));
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── ROOT MOTION ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

class RootMotionController {
  constructor(profileName = 'walk') {
    this.profileName = profileName;
    this.profile = ROOT_MOTION_PROFILES[profileName] || ROOT_MOTION_PROFILES.walk;
    this.position = new Vec3();
    this.velocity = new Vec3();
    this.angularVelocity = new Vec3();
    this.quat = new Quat();
    this.grounded = 1;
    this.verticalVelocity = 0;
    this._tmpV = new Vec3();
  }

  setProfile(name) {
    if (ROOT_MOTION_PROFILES[name]) {
      this.profileName = name;
      this.profile = ROOT_MOTION_PROFILES[name];
    }
  }

  setInput(moveX, moveY, sprint, jump, crouch) {
    const speedScale = sprint ? 1.0 : crouch ? 0.5 : 0.7;
    const dir = this._tmpV.set(moveX, 0, moveY);
    if (dir.lengthSq() > 1e-6) dir.normalize();
    const targetSpeed = this.profile.maxSpeed * speedScale * dir.length();
    const targetVel = dir.multiplyScalar(targetSpeed);

    // Accelerate toward target velocity.
    const accel = this.profile.acceleration;
    const dx = targetVel.x - this.velocity.x;
    const dz = targetVel.z - this.velocity.z;
    const accelStep = accel * (1 / 60);
    this.velocity.x += Math.sign(dx) * Math.min(Math.abs(dx), accelStep);
    this.velocity.z += Math.sign(dz) * Math.min(Math.abs(dz), accelStep);

    // Jump impulse.
    if (jump > 0 && this.grounded) {
      this.verticalVelocity = this.profile.jumpImpulse || 4.0;
      this.grounded = 0;
    }
    return this;
  }

  integrate(dt, gravityMagnitude = 9.81) {
    // Horizontal movement.
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;

    // Vertical: gravity when airborne, snap to ground when grounded.
    if (!this.grounded) {
      this.verticalVelocity -= gravityMagnitude * this.profile.gravityScale * dt;
      this.position.y += this.verticalVelocity * dt;
      if (this.position.y <= 0) {
        this.position.y = 0;
        this.verticalVelocity = 0;
        this.grounded = 1;
      }
    }

    // Facing from horizontal velocity.
    const speedSq = this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z;
    if (speedSq > 1e-4) {
      const targetYaw = Math.atan2(this.velocity.x, this.velocity.z);
      const currentYaw = 2 * Math.acos(Math.min(1, Math.max(-1, this.quat.w))) * (this.quat.y >= 0 ? 1 : -1);
      const dYaw = this._shortestAngle(currentYaw, targetYaw);
      const maxStep = this.profile.angularAcceleration * dt;
      const step = Math.sign(dYaw) * Math.min(Math.abs(dYaw), maxStep);
      const deltaQ = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), step);
      this.quat.multiply(deltaQ).normalize();
    }
    return this;
  }

  _shortestAngle(from, to) {
    let d = to - from;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── MOTION MATCHING DATABASE ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

class MotionMatchingDatabase {
  constructor(capacity = 4096, featureStride = 12) {
    this.capacity = capacity;
    this.stride = featureStride;
    this.features = new Float32Array(capacity * featureStride);
    this.tags = new Uint8Array(capacity);
    this.times = new Float32Array(capacity);
    this.count = 0;
    this._seeded = false;
  }

  seedDefaultSamples() {
    if (this._seeded) return;
    this._seeded = true;
    // Seed a handful of canonical features per locomotion tag so
    // motion matching works out of the box.
    const tags = ['idle', 'walk', 'run', 'swim', 'fly', 'jump', 'climb'];
    for (let t = 0; t < tags.length; t++) {
      const tagId = _animReg.getId(tags[t]);
      for (let s = 0; s < 16; s++) {
        const phase = (s / 16) * 2 * Math.PI;
        this.add(
          { x: Math.cos(phase) * 0.1, y: 0, z: Math.sin(phase) * 0.1 },
          { x: Math.cos(phase) * 1.0, y: 0, z: Math.sin(phase) * 1.0 },
          { x: Math.cos(phase + 0.5) * 0.5, y: 0, z: Math.sin(phase + 0.5) * 0.5 },
          tagId, s * 0.05
        );
      }
    }
  }

  add(pos, vel, traj, tagId, time) {
    if (this.count >= this.capacity) return -1;
    const o = this.count * this.stride;
    this.features[o]     = pos.x;
    this.features[o + 1] = pos.y;
    this.features[o + 2] = pos.z;
    this.features[o + 3] = 0;
    this.features[o + 4] = vel.x;
    this.features[o + 5] = vel.y;
    this.features[o + 6] = vel.z;
    this.features[o + 7] = 0;
    this.features[o + 8] = traj.x;
    this.features[o + 9] = traj.y;
    this.features[o + 10] = traj.z;
    this.features[o + 11] = 0;
    this.tags[this.count] = tagId;
    this.times[this.count] = time;
    this.count++;
    return this.count - 1;
  }

  findNearest(pos, vel, traj, tagId) {
    let bestIdx = -1;
    let bestDist = Infinity;
    const stride = this.stride;
    for (let i = 0; i < this.count; i++) {
      if (this.tags[i] !== tagId) continue;
      const o = i * stride;
      const dp = (this.features[o]     - pos.x) ** 2 + (this.features[o + 1] - pos.y) ** 2 + (this.features[o + 2] - pos.z) ** 2;
      const dv = (this.features[o + 4] - vel.x) ** 2 + (this.features[o + 5] - vel.y) ** 2 + (this.features[o + 6] - vel.z) ** 2;
      const dt = (this.features[o + 8] - traj.x) ** 2 + (this.features[o + 9] - traj.y) ** 2 + (this.features[o + 10] - traj.z) ** 2;
      const d = dp * 1.0 + dv * 2.0 + dt * 1.5;
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    return bestIdx;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── DEFORMATION OVERLAYS ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

class DeformationOverlay {
  constructor() {
    this.pokes = [];
    this.muscles = new Map();
    this.bends = new Map();
    this.screws = new Map();
    this.balloons = new Map();
    this.heat = new Map();
    this.fire = new Map();
  }

  addPoke(position, impulse, ttl = 1.0) {
    this.pokes.push({ position: position.clone(), impulse, ttl, age: 0 });
    if (this.pokes.length > 64) this.pokes.shift();
  }

  setMuscle(jointIdx, tension) {
    this.muscles.set(jointIdx, Math.max(0, Math.min(1, tension)));
  }

  addBend(jointIdx, angle, ttl = 1.0) {
    this.bends.set(jointIdx, { angle, ttl, age: 0 });
  }

  addScrew(jointIdx, axis, angle, ttl = 1.0) {
    this.screws.set(jointIdx, { axis: axis.clone(), angle, ttl, age: 0 });
  }

  setBalloon(intensity) {
    this.balloons.set('_global', Math.max(0, Math.min(1, intensity)));
  }

  addHeat(jointIdx, celsius) {
    this.heat.set(jointIdx, Math.max(this.heat.get(jointIdx) || 0, celsius));
  }

  ignite(jointIdx, intensity = 1.0) {
    this.fire.set(jointIdx, Math.max(this.fire.get(jointIdx) || 0, intensity));
  }

  update(dt, nodes, outEmissive) {
    // Pokes decay.
    for (let i = this.pokes.length - 1; i >= 0; i--) {
      const p = this.pokes[i];
      p.age += dt;
      if (p.age >= p.ttl) this.pokes.splice(i, 1);
    }
    // Muscle/bend/screw follow tension input; decay when not fed.
    for (const [k, v] of this.muscles) {
      const decayed = Math.max(0, v - dt * 0.5);
      if (decayed <= 0) this.muscles.delete(k); else this.muscles.set(k, decayed);
    }
    for (const [k, v] of this.bends) {
      v.age += dt; if (v.age >= v.ttl) this.bends.delete(k);
    }
    for (const [k, v] of this.screws) {
      v.age += dt; if (v.age >= v.ttl) this.screws.delete(k);
    }
    for (const [k, v] of this.heat) {
      const decayed = v - dt * 2;
      if (decayed <= 0) this.heat.delete(k); else this.heat.set(k, decayed);
    }
    for (const [k, v] of this.fire) {
      const decayed = v - dt * 0.3;
      if (decayed <= 0) this.fire.delete(k); else this.fire.set(k, decayed);
    }

    // Apply muscle bulge to joint positions (small outward offset).
    const muscleParams = _procReg.get('muscle');
    for (const [jointIdx, tension] of this.muscles) {
      if (jointIdx < 0 || jointIdx >= nodes.length) continue;
      const node = nodes[jointIdx];
      if (!node) continue;
      const bulge = tension * muscleParams.bulgePerUnitTension;
      node.localPos.x *= 1 + bulge;
      node.localPos.z *= 1 + bulge;
    }

    // Apply bend / screw to joint local rotations.
    for (const [jointIdx, b] of this.bends) {
      const node = nodes[jointIdx];
      if (!node) continue;
      node.applyRotationDelta(new Vec3(1, 0, 0), b.angle * (1 - b.age / b.ttl));
    }
    for (const [jointIdx, s] of this.screws) {
      const node = nodes[jointIdx];
      if (!node) continue;
      node.applyRotationDelta(s.axis, s.angle * (1 - s.age / s.ttl));
    }

    // Balloon: uniform scale handled by the renderer via emissive feedback.
    // Heat / fire: emit emissive intensities.
    if (outEmissive) {
      for (const [jointIdx, celsius] of this.heat) {
        if (jointIdx < 0 || jointIdx >= outEmissive.length) continue;
        outEmissive[jointIdx] = Math.max(outEmissive[jointIdx], celsius * _procReg.get('heat').emissivePerC);
      }
      for (const [jointIdx, intensity] of this.fire) {
        if (jointIdx < 0 || jointIdx >= outEmissive.length) continue;
        outEmissive[jointIdx] = Math.max(outEmissive[jointIdx], intensity * _procReg.get('fire').emissiveMax);
      }
    }
  }

  get balloonScale() {
    const b = this.balloons.get('_global') || 0;
    return 1 + b * (_procReg.get('balloon').maxScale - 1);
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── MAIN PROVIDER ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

class PlayerContextProvider {
  constructor(options = {}) {
    // ── config ──────────────────────────────────────────────
    this.ikWeight = options.ikWeight ?? 1.0;
    this.lookAtWeight = options.lookAtWeight ?? 0.7;
    this.footIKEnabled = options.footIKEnabled ?? true;
    this.handIKEnabled = options.handIKEnabled ?? true;
    this.proceduralEnabled = options.proceduralEnabled ?? true;
    this.motionMatchingEnabled = options.motionMatchingEnabled ?? true;
    this.goapEnabled = options.goapEnabled ?? true;
    this.goapReplanInterval = options.goapReplanInterval ?? 0.5;
    this.stateBlendRate = options.stateBlendRate ?? 8.0;
    this.defaultIkSolver = options.defaultIkSolver ?? IK_SOLVER.HYBRID;
    this.rootMotionProfile = options.rootMotionProfile ?? 'walk';

    // ── joint registry (can be replaced for non-humanoid) ────
    this._jointRegistry = options.jointRegistry || _jointReg;
    const jointCount = this._jointRegistry.count;

    // ── joint nodes (pooled) ────────────────────────────────
    this._nodes = new Array(jointCount);
    for (let i = 0; i < jointCount; i++) {
      this._nodes[i] = new JointNode(i, this._jointRegistry.getParent(i));
      const lp = this._jointRegistry.getLocalPos(i);
      this._nodes[i].localPos.set(lp[0], lp[1], lp[2]);
    }
    this._jointCount = jointCount;

    // ── IK targets & weights ────────────────────────────────
    this._ikTargets = {
      lHand: new Vec3(), rHand: new Vec3(),
      lFoot: new Vec3(), rFoot: new Vec3()
    };
    this._ikWeights = new Float32Array(4);
    this._ikSolvers = {
      lHand: this.defaultIkSolver,
      rHand: this.defaultIkSolver,
      lFoot: IK_SOLVER.TWO_BONE,
      rFoot: IK_SOLVER.TWO_BONE
    };

    // ── look-at ─────────────────────────────────────────────
    this._lookAtTarget = new Vec3();
    this._lookAtActive = 0;
    this._lookAtSpeed = 5.0;

    // ── root motion ────────────────────────────────────────
    this._rootMotion = new RootMotionController(this.rootMotionProfile);
    this._rootPosition = this._rootMotion.position;
    this._rootVelocity = this._rootMotion.velocity;
    this._rootQuat = this._rootMotion.quat;

    // ── equipment ──────────────────────────────────────────
    this._equipment = new Array(EQUIP_SLOT.COUNT).fill(null);
    this._equipmentMass = new Float32Array(EQUIP_SLOT.COUNT);
    this._equipmentEmissive = new Float32Array(EQUIP_SLOT.COUNT);
    this._equipmentEmissiveTarget = new Float32Array(EQUIP_SLOT.COUNT);
    this._equipmentAttachJoint = new Int8Array(EQUIP_SLOT.COUNT).fill(-1);
    this._equipmentOffset = new Array(EQUIP_SLOT.COUNT);
    this._equipmentLightColor = new Array(EQUIP_SLOT.COUNT);
    for (let i = 0; i < EQUIP_SLOT.COUNT; i++) {
      this._equipmentOffset[i] = new Mat4();
      this._equipmentLightColor[i] = [1, 1, 1];
      this._equipmentAttachJoint[i] = this._jointRegistry.getIndex(EQUIP_DEFAULT_JOINT[i]);
    }

    // ── animation state ────────────────────────────────────
    this._animRegistry = options.animRegistry || _animReg;
    this._currentState = this._animRegistry.getId('idle');
    this._previousState = this._currentState;
    this._stateBlend = 1.0;
    this._animationTime = 0;
    this._animationSpeed = 1.0;

    // ── motion matching ────────────────────────────────────
    this._motionDB = new MotionMatchingDatabase(
      options.featureCapacity ?? 4096, 12
    );
    this._motionDB.seedDefaultSamples();
    this._currentMatchIndex = -1;
    this._currentMatchTime = 0;

    // ── procedural overlays ────────────────────────────────
    this._breathingPhase = 0;
    this._blinkTimer = 2.5;
    this._blinkState = 0;
    this._landTimer = 0;
    this._hitStaggerTimer = 0;
    this._deformation = new DeformationOverlay();

    // ── spring bones per equipment slot ────────────────────
    this._springBones = new Array(EQUIP_SLOT.COUNT);
    for (let i = 0; i < EQUIP_SLOT.COUNT; i++) {
      this._springBones[i] = {
        position: new Vec3(), velocity: new Vec3(),
        target: new Vec3(), active: 0
      };
    }

    // ── GOAP planner ───────────────────────────────────────
    this._goapRegistry = options.goapRegistry || _goapReg;
    this._goapGoals = [];
    this._goapActions = [];
    this._goapWorldState = 0;
    this._goapPlan = [];
    this._goapPlanIndex = 0;
    this._goapReplanTimer = 0;
    this._goapBestGoal = -1;

    // ── player stats ───────────────────────────────────────
    this._playerStats = {
      health: 100, maxHealth: 100,
      mana: 100, maxMana: 100,
      stamina: 100, maxStamina: 100,
      focusDistance: 10,
      activeTool: -1,
      grounded: 1, moving: 0, speed: 0
    };

    // ── input state ────────────────────────────────────────
    this._input = {
      moveX: 0, moveY: 0, lookX: 0, lookY: 0,
      jump: 0, crouch: 0, sprint: 0,
      attack: 0, block: 0, interact: 0, reload: 0
    };

    // ── scratch (pooled) ───────────────────────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpQuatA = new Quat();
    this._tmpQuatB = new Quat();
    this._tmpMatA = new Mat4();
    this._tmpMatB = new Mat4();
    this._tmpRay = new Ray();
    this._tmpPlane = new Plane();

    // ── joint emissive output for material/lighting ────────
    this._jointEmissive = new Float32Array(jointCount);

    // ── timing ─────────────────────────────────────────────
    this._lastUpdateTime = -Infinity;
    this._updateCount = 0;
    this._dispatcher = options.dispatcher || null;
    this._frameRef = null;

    // ── statistics ─────────────────────────────────────────
    this._stats = {
      updates: 0, plansExecuted: 0, plansRejected: 0,
      ikEvaluations: 0, motionMatches: 0, springUpdates: 0,
      stateTransitions: 0, causalEventsEmitted: 0, deformationsApplied: 0
    };
  }

  // ── runtime extension APIs ─────────────────────────────────
  registerJoint(name, parentName, localPos, localRot = [0, 0, 0, 1]) {
    const idx = this._jointRegistry.register(name, parentName, localPos, localRot);
    if (idx >= this._nodes.length) {
      this._nodes.push(new JointNode(idx, this._jointRegistry.getParent(idx)));
      this._jointCount = this._nodes.length;
      const newEmissive = new Float32Array(this._jointCount);
      newEmissive.set(this._jointEmissive);
      this._jointEmissive = newEmissive;
    }
    const lp = this._jointRegistry.getLocalPos(idx);
    this._nodes[idx].localPos.set(lp[0], lp[1], lp[2]);
    return idx;
  }

  registerAnimationState(name, priority = 0) {
    return this._animRegistry.register(name, priority);
  }

  registerGoapBit(name) {
    return this._goapRegistry.register(name);
  }

  registerProceduralParam(name, params) {
    _procReg.register(name, params);
    return this;
  }

  registerGoapAction(action) {
    this._goapActions.push(action);
    return this;
  }

  registerGoapGoal(goal) {
    this._goapGoals.push(goal);
    return this;
  }

  // ── forward kinematics ─────────────────────────────────────
  _updateFK() {
    for (let i = 0; i < this._jointCount; i++) {
      const node = this._nodes[i];
      const parent = node.parent >= 0 ? this._nodes[node.parent] : null;
      node.recomputeWorldFrom(parent);
    }
    // Apply root transform.
    const root = this._nodes[0];
    root.worldPos.copy(this._rootMotion.position);
    root.worldRot.copy(this._rootMotion.quat);
    root.worldMat.compose(root.worldPos, root.worldRot, new Vec3(1, 1, 1));
    // Recompute children with root applied.
    for (let i = 1; i < this._jointCount; i++) {
      const node = this._nodes[i];
      const parent = node.parent >= 0 ? this._nodes[node.parent] : root;
      node.recomputeWorldFrom(parent);
    }
  }

  // ── joint chain builder from names ────────────────────────
  _buildChain(names) {
    const chain = [];
    for (const name of names) {
      const idx = this._jointRegistry.getIndex(name);
      if (idx >= 0) chain.push(this._nodes[idx]);
    }
    return chain;
  }

  // ── IK update for a specific limb ─────────────────────────
  _updateLimbIK(targetPos, weight, chainNames, solverId) {
    if (weight < 1e-5) return;
    const chain = this._buildChain(chainNames);
    if (chain.length < 2) return;
    const solver = IK_SOLVERS[solverId];
    if (!solver) return;
    solver.solve(chain, targetPos, weight);
    this._stats.ikEvaluations++;
  }

  _updateFootIK(weight) {
    if (!this.footIKEnabled || weight < 1e-5) return;
    if (this._ikWeights[2] > 1e-5) {
      this._updateLimbIK(this._ikTargets.lFoot, this._ikWeights[2] * weight,
        ['L_HIP', 'L_KNEE', 'L_FOOT'], this._ikSolvers.lFoot);
    }
    if (this._ikWeights[3] > 1e-5) {
      this._updateLimbIK(this._ikTargets.rFoot, this._ikWeights[3] * weight,
        ['R_HIP', 'R_KNEE', 'R_FOOT'], this._ikSolvers.rFoot);
    }
  }

  _updateHandIK(weight) {
    if (!this.handIKEnabled || weight < 1e-5) return;
    if (this._ikWeights[0] > 1e-5) {
      this._updateLimbIK(this._ikTargets.lHand, this._ikWeights[0] * weight,
        ['L_SHOULDER', 'L_ELBOW', 'L_WRIST'], this._ikSolvers.lHand);
    }
    if (this._ikWeights[1] > 1e-5) {
      this._updateLimbIK(this._ikTargets.rHand, this._ikWeights[1] * weight,
        ['R_SHOULDER', 'R_ELBOW', 'R_WRIST'], this._ikSolvers.rHand);
    }
  }

  // ── look-at ────────────────────────────────────────────────
  _updateLookAt(weight) {
    if (!this._lookAtActive || weight < 1e-5) return;
    const headIdx = this._jointRegistry.getIndex('HEAD');
    if (headIdx < 0) return;
    const head = this._nodes[headIdx];

    const toTarget = this._lookAtTarget.clone().sub(head.worldPos).normalize();
    const forward = new Vec3(0, 0, 1).applyQuaternion(head.worldRot);
    const angle = forward.angleTo(toTarget);
    if (angle < 1e-5) return;
    const axis = forward.clone().cross(toTarget).normalize();
    if (axis.lengthSq() < 1e-5) axis.set(0, 1, 0);

    const lookW = weight * this.lookAtWeight;
    this._applyLookAtToJoint('SPINE_0', axis, angle * 0.15 * lookW);
    this._applyLookAtToJoint('SPINE_1', axis, angle * 0.20 * lookW);
    this._applyLookAtToJoint('NECK_1',  axis, angle * 0.25 * lookW);
    this._applyLookAtToJoint('HEAD',    axis, angle * 0.40 * lookW);
  }

  _applyLookAtToJoint(name, axis, angle) {
    const idx = this._jointRegistry.getIndex(name);
    if (idx < 0) return;
    this._nodes[idx].applyRotationDelta(axis, angle);
  }

  // ── procedural overlays ────────────────────────────────────
  _updateBreathing(dt) {
    if (!this.proceduralEnabled) return;
    const p = _procReg.get('breath');
    this._breathingPhase += dt * (2 * Math.PI / p.period);
    const spine0 = this._jointRegistry.getIndex('SPINE_0');
    const spine1 = this._jointRegistry.getIndex('SPINE_1');
    const pulse = Math.sin(this._breathingPhase) * p.amplitude;
    if (spine0 >= 0) this._nodes[spine0].applyRotationDelta(new Vec3(1, 0, 0), pulse * 0.5);
    if (spine1 >= 0) this._nodes[spine1].applyRotationDelta(new Vec3(1, 0, 0), pulse);
  }

  _updateBlink(dt) {
    if (!this.proceduralEnabled) return;
    const p = _procReg.get('blink');
    this._blinkTimer -= dt;
    if (this._blinkState === 0 && this._blinkTimer <= 0) {
      this._blinkState = 1;
      this._blinkTimer = p.duration * 0.5;
    } else if (this._blinkState === 1 && this._blinkTimer <= 0) {
      this._blinkState = 2;
      this._blinkTimer = p.duration * 0.5;
    } else if (this._blinkState === 2 && this._blinkTimer <= 0) {
      this._blinkState = 0;
      this._blinkTimer = p.intervalMin + Math.random() * (p.intervalMax - p.intervalMin);
    }
  }

  _updateSpringBones(dt) {
    if (!this.proceduralEnabled) return;
    const params = _procReg.get('spring');
    for (let i = 0; i < EQUIP_SLOT.COUNT; i++) {
      const s = this._springBones[i];
      if (!s.active) continue;
      const dx = s.position.x - s.target.x;
      const dy = s.position.y - s.target.y;
      const dz = s.position.z - s.target.z;
      s.velocity.x += (-params.stiffness * dx - params.damping * s.velocity.x) * dt;
      s.velocity.y += (-params.stiffness * dy - params.damping * s.velocity.y) * dt;
      s.velocity.z += (-params.stiffness * dz - params.damping * s.velocity.z) * dt;
      s.position.x += s.velocity.x * dt;
      s.position.y += s.velocity.y * dt;
      s.position.z += s.velocity.z * dt;
      this._stats.springUpdates++;
    }
  }

  // ── GOAP ───────────────────────────────────────────────────
  _planGoap(startState) {
    if (this._goapGoals.length === 0) return null;
    let bestGoal = -1, bestPriority = -Infinity;
    for (let g = 0; g < this._goapGoals.length; g++) {
      const goal = this._goapGoals[g];
      const missing = goal.desiredBits & ~startState;
      const priority = (goal.priority || 0) - this._popcount(missing) * 0.1;
      if (priority > bestPriority) { bestPriority = priority; bestGoal = g; }
    }
    if (bestGoal === -1) return null;
    const targetBits = this._goapGoals[bestGoal].desiredBits;

    const open = [{ state: startState, cost: 0, plan: [] }];
    const visited = new Set([startState]);

    for (let iter = 0; iter < 32 && open.length > 0; iter++) {
      let bi = 0, bc = open[0].cost;
      for (let i = 1; i < open.length; i++) if (open[i].cost < bc) { bc = open[i].cost; bi = i; }
      const node = open.splice(bi, 1)[0];
      if ((node.state & targetBits) === targetBits) {
        this._stats.plansExecuted++;
        return node.plan;
      }
      for (let a = 0; a < this._goapActions.length; a++) {
        const action = this._goapActions[a];
        if ((node.state & action.preconditions) !== action.preconditions) continue;
        const newState = (node.state & ~action.removeBits) | action.addBits;
        if (visited.has(newState)) continue;
        visited.add(newState);
        open.push({
          state: newState,
          cost: node.cost + (action.cost || 1) + this._popcount(targetBits & ~newState),
          plan: node.plan.concat([a])
        });
      }
    }
    this._stats.plansRejected++;
    return null;
  }

  _popcount(bits) { let c = 0; while (bits) { c += bits & 1; bits >>= 1; } return c; }

  _updateWorldStateBitmask() {
    let bits = 0;
    const reg = this._goapRegistry;
    if (this._playerStats.grounded) bits |= reg.getBit('IS_GROUNDED');
    if (this._playerStats.moving) bits |= reg.getBit('IS_MOVING');
    if (this._input.attack > 0.1) bits |= reg.getBit('HAS_TARGET');
    if (this._input.reload > 0.1) bits |= reg.getBit('IS_RELOADING');
    if (this._input.block > 0.1) bits |= reg.getBit('IS_BLOCKING');
    if (this._hitStaggerTimer > 0) bits |= reg.getBit('IS_HURT');
    if (this._playerStats.stamina < 20) bits |= reg.getBit('IS_LOW_STAMINA');
    if (this._equipment[EQUIP_SLOT.MAIN_HAND]) bits |= reg.getBit('HAS_AMMO');
    this._goapWorldState = bits;
  }

  _executeGoapPlan() {
    if (this._goapPlanIndex >= this._goapPlan.length) return;
    const action = this._goapActions[this._goapPlan[this._goapPlanIndex]];
    if (!action) return;
    if (this._currentState === action.animationStateId) {
      this._goapPlanIndex++;
      this._goapWorldState = (this._goapWorldState & ~action.removeBits) | action.addBits;
    }
  }

  // ── animation state machine ────────────────────────────────
  _updateAnimationState(dt) {
    const reg = this._animRegistry;
    const S = (name) => reg.getId(name);
    if (this._hitStaggerTimer > 0) this._transitionTo(S('hit'));
    else if (this._playerStats.health <= 0) this._transitionTo(S('death'));
    else if (this._input.attack > 0.1) this._transitionTo(S('attack'));
    else if (this._input.block > 0.1) this._transitionTo(S('block'));
    else if (this._input.reload > 0.1) this._transitionTo(S('reload'));
    else if (this._input.interact > 0.1) this._transitionTo(S('interact'));
    else if (!this._playerStats.grounded) this._transitionTo(this._rootMotion.verticalVelocity > 0.5 ? S('jump') : S('fall'));
    else if (this._landTimer > 0) this._transitionTo(S('land'));
    else {
      const speed = this._playerStats.speed;
      if (speed > 6.5) this._transitionTo(S('sprint'));
      else if (speed > 3.5) this._transitionTo(S('run'));
      else if (speed > 0.3) this._transitionTo(S('walk'));
      else this._transitionTo(S('idle'));
    }
    this._animationTime += dt * this._animationSpeed;
  }

  _transitionTo(newState) {
    if (newState === this._currentState || newState < 0) return;
    this._previousState = this._currentState;
    this._currentState = newState;
    this._stateBlend = 0.0;
    this._animationTime = 0;
    this._stats.stateTransitions++;
    if (this._dispatcher) {
      if (newState === this._animRegistry.getId('attack')) {
        this._dispatcher.queueCausalEvent(EVENT_TYPE.IMPACT, [0, 0, 0], this._playerStats.activeTool, 50, 0.5, null);
        this._stats.causalEventsEmitted++;
      } else if (newState === this._animRegistry.getId('land')) {
        this._dispatcher.queueCausalEvent(EVENT_TYPE.IMPACT, [0, 0, 0], -1, 20, 0.8, null);
        this._stats.causalEventsEmitted++;
      }
    }
  }

  // ── equipment ─────────────────────────────────────────────
  equipItem(slot, item) {
    if (slot < 0 || slot >= EQUIP_SLOT.COUNT) return false;
    this._equipment[slot] = item;
    this._equipmentMass[slot] = item.mass || 1.0;
    this._equipmentAttachJoint[slot] = item.attachJoint ?? this._jointRegistry.getIndex(EQUIP_DEFAULT_JOINT[slot]);
    if (item.offset) this._equipmentOffset[slot].copy(item.offset);
    if (item.lightColor) this._equipmentLightColor[slot] = item.lightColor.slice();
    if (item.springEnabled !== false) this._springBones[slot].active = 1;
    return true;
  }

  unequipItem(slot) {
    if (slot < 0 || slot >= EQUIP_SLOT.COUNT) return false;
    this._equipment[slot] = null;
    this._equipmentMass[slot] = 0;
    this._equipmentEmissive[slot] = 0;
    this._equipmentEmissiveTarget[slot] = 0;
    this._springBones[slot].active = 0;
    return true;
  }

  setEquipmentEmissive(slot, intensity, r = 1, g = 1, b = 1) {
    if (slot < 0 || slot >= EQUIP_SLOT.COUNT) return;
    this._equipmentEmissiveTarget[slot] = intensity;
    this._equipmentLightColor[slot] = [r, g, b];
  }

  _updateEquipmentEmissive(dt) {
    for (let i = 0; i < EQUIP_SLOT.COUNT; i++) {
      const target = this._equipmentEmissiveTarget[i];
      const current = this._equipmentEmissive[i];
      if (Math.abs(target - current) < 0.001) continue;
      const tau = target > current ? 0.15 : 0.8;
      const alpha = 1 - Math.exp(-dt / tau);
      this._equipmentEmissive[i] = current + (target - current) * alpha;
    }
  }

  // ── input ──────────────────────────────────────────────────
  setInput(input) {
    if (!input) return this;
    for (const k of Object.keys(this._input)) {
      if (input[k] !== undefined) this._input[k] = input[k];
    }
    return this;
  }

  setIKTarget(which, position, weight = 1.0) {
    if (this._ikTargets[which]) {
      this._ikTargets[which].copy(position);
      const idx = which === 'lHand' ? 0 : which === 'rHand' ? 1
        : which === 'lFoot' ? 2 : 3;
      this._ikWeights[idx] = weight;
    }
    return this;
  }

  setLookAtTarget(target, active = true) {
    this._lookAtTarget.copy(target);
    this._lookAtActive = active ? 1 : 0;
    return this;
  }

  setRootMotionProfile(name) {
    this._rootMotion.setProfile(name);
    return this;
  }

  // ── deformation API ────────────────────────────────────────
  poke(position, impulse, ttl = 1.0) { this._deformation.addPoke(position, impulse, ttl); return this; }
  flexMuscle(jointName, tension) {
    const idx = this._jointRegistry.getIndex(jointName);
    if (idx >= 0) this._deformation.setMuscle(idx, tension);
    return this;
  }
  bendJoint(jointName, angle, ttl = 1.0) {
    const idx = this._jointRegistry.getIndex(jointName);
    if (idx >= 0) this._deformation.addBend(idx, angle, ttl);
    return this;
  }
  screwJoint(jointName, axis, angle, ttl = 1.0) {
    const idx = this._jointRegistry.getIndex(jointName);
    if (idx >= 0) this._deformation.addScrew(idx, axis, angle, ttl);
    return this;
  }
  setBalloon(intensity) { this._deformation.setBalloon(intensity); return this; }
  applyHeat(jointName, celsius) {
    const idx = this._jointRegistry.getIndex(jointName);
    if (idx >= 0) this._deformation.addHeat(idx, celsius);
    return this;
  }
  igniteJoint(jointName, intensity = 1.0) {
    const idx = this._jointRegistry.getIndex(jointName);
    if (idx >= 0) this._deformation.ignite(idx, intensity);
    return this;
  }

  // ── causal reaction ────────────────────────────────────────
  _readCausal(frame) {
    const causal = frame.layers.causal;
    if (!causal || !causal.derivedSignals) return;
    const s = causal.derivedSignals;
    for (let i = 0; i < s.count; i++) {
      if (s.types[i] === DERIVED_SIGNAL.LIGHT_FLICKER && s.forces[i] > 40) {
        if (this._hitStaggerTimer <= 0) {
          this._hitStaggerTimer = 0.25;
          this._transitionTo(this._animRegistry.getId('hit'));
        }
      }
    }
  }

  // ── update ─────────────────────────────────────────────────
  update(frame, clock) {
    if (!frame || !frame.layers || !frame.layers.player) return 0;
    const now = clock ? clock.elapsedSeconds : performance.now() / 1000;
    if (now - this._lastUpdateTime < 1 / 60) return 0;
    const dt = Math.min(0.05, now - (this._lastUpdateTime > 0 ? this._lastUpdateTime : now - 1 / 60));
    this._lastUpdateTime = now;
    this._frameRef = frame;

    this._readCausal(frame);

    // Root motion: input → velocity → position.
    this._rootMotion.setInput(
      this._input.moveX, this._input.moveY,
      this._input.sprint > 0.1, this._input.jump > 0.1, this._input.crouch > 0.1
    );
    this._rootMotion.integrate(dt, 9.81);
    this._playerStats.grounded = this._rootMotion.grounded;
    this._playerStats.speed = Math.sqrt(
      this._rootMotion.velocity.x ** 2 + this._rootMotion.velocity.z ** 2
    );
    this._playerStats.moving = this._playerStats.speed > 0.3 ? 1 : 0;

    // Stamina.
    if (this._input.sprint > 0.1 && this._playerStats.grounded) {
      this._playerStats.stamina = Math.max(0, this._playerStats.stamina - dt * 15);
    } else {
      this._playerStats.stamina = Math.min(this._playerStats.maxStamina,
        this._playerStats.stamina + dt * 10);
    }
    if (this._hitStaggerTimer > 0) this._hitStaggerTimer -= dt;
    if (this._landTimer > 0) this._landTimer -= dt;

    // GOAP.
    this._updateWorldStateBitmask();
    if (this.goapEnabled) {
      this._goapReplanTimer -= dt;
      if (this._goapReplanTimer <= 0) {
        this._goapReplanTimer = this.goapReplanInterval;
        const plan = this._planGoap(this._goapWorldState);
        if (plan) { this._goapPlan = plan; this._goapPlanIndex = 0; }
      }
      this._executeGoapPlan();
    }

    // Animation state + blend.
    this._updateAnimationState(dt);
    this._stateBlend = Math.min(1.0, this._stateBlend + this.stateBlendRate * dt);

    // Procedural overlays.
    this._updateBreathing(dt);
    this._updateBlink(dt);
    this._updateSpringBones(dt);

    // Motion matching for base pose selection.
    if (this.motionMatchingEnabled) {
      const tag = this._currentState;
      this._currentMatchIndex = this._motionDB.findNearest(
        this._rootMotion.position, this._rootMotion.velocity,
        new Vec3(this._rootMotion.velocity.x, 0, this._rootMotion.velocity.z),
        tag
      );
      if (this._currentMatchIndex >= 0) {
        this._currentMatchTime = this._motionDB.times[this._currentMatchIndex];
        this._stats.motionMatches++;
      }
    }

    // Deformation overlays (poke/muscle/bend/screw/balloon/heat/fire).
    this._deformation.update(dt, this._nodes, this._jointEmissive);
    this._stats.deformationsApplied++;

    // FK -> IK -> FK.
    this._updateFK();
    this._updateFootIK(this.ikWeight);
    this._updateHandIK(this.ikWeight);
    this._updateFK();
    this._updateLookAt(this.ikWeight);
    this._updateFK();

    // Emissive decay.
    this._updateEquipmentEmissive(dt);

    // Write to frame.
    this._writePlayerLayer(frame, now);
    this._writePhysicalLayer(frame);

    this._stats.updates++;
    this._updateCount++;
    return 1;
  }

  // ── write to frame.layers.player ───────────────────────────
  _writePlayerLayer(frame, now) {
    const player = frame.layers.player;
    const hipsIdx = this._jointRegistry.getIndex('HIPS');
    const headIdx = this._jointRegistry.getIndex('HEAD');
    const hips = hipsIdx >= 0 ? this._nodes[hipsIdx] : this._nodes[0];
    const head = headIdx >= 0 ? this._nodes[headIdx] : this._nodes[0];

    player.position[0] = hips.worldPos.x;
    player.position[1] = hips.worldPos.y;
    player.position[2] = hips.worldPos.z;

    player.velocity[0] = this._rootMotion.velocity.x;
    player.velocity[1] = this._rootMotion.verticalVelocity;
    player.velocity[2] = this._rootMotion.velocity.z;

    this._tmpVecA.set(0, 0, 1).applyQuaternion(head.worldRot);
    player.facing[0] = this._tmpVecA.x;
    player.facing[1] = this._tmpVecA.y;
    player.facing[2] = this._tmpVecA.z;

    player.health = this._playerStats.health;
    player.mana = this._playerStats.mana;
    player.stamina = this._playerStats.stamina;
    player.activeTool = this._playerStats.activeTool;
    player.focusDistance = this._playerStats.focusDistance;

    player.animationState = this._currentState;
    player.animationStateName = this._animRegistry.getName(this._currentState);
    player.animationBlend = this._stateBlend;
    player.animationTime = this._animationTime;

    // Skeleton snapshot (flat SoA).
    if (!player.skeletonWorldPos || player.skeletonWorldPos.length !== this._jointCount * 3) {
      player.skeletonWorldPos = new Float32Array(this._jointCount * 3);
      player.skeletonWorldRot = new Float32Array(this._jointCount * 4);
    }
    for (let i = 0; i < this._jointCount; i++) {
      const n = this._nodes[i];
      const o3 = i * 3, o4 = i * 4;
      player.skeletonWorldPos[o3] = n.worldPos.x;
      player.skeletonWorldPos[o3 + 1] = n.worldPos.y;
      player.skeletonWorldPos[o3 + 2] = n.worldPos.z;
      player.skeletonWorldRot[o4] = n.worldRot.x;
      player.skeletonWorldRot[o4 + 1] = n.worldRot.y;
      player.skeletonWorldRot[o4 + 2] = n.worldRot.z;
      player.skeletonWorldRot[o4 + 3] = n.worldRot.w;
    }
    player.skeletonDirty = 1;
    player.jointEmissive = this._jointEmissive;
    player.balloonScale = this._deformation.balloonScale;

    // Equipment snapshot.
    if (!player.equipment) player.equipment = new Array(EQUIP_SLOT.COUNT).fill(null);
    if (!player.equipmentEmissive) player.equipmentEmissive = new Float32Array(EQUIP_SLOT.COUNT);
    if (!player.equipmentMass) player.equipmentMass = new Float32Array(EQUIP_SLOT.COUNT);
    for (let i = 0; i < EQUIP_SLOT.COUNT; i++) {
      player.equipment[i] = this._equipment[i];
      player.equipmentEmissive[i] = this._equipmentEmissive[i];
      player.equipmentMass[i] = this._equipmentMass[i];
    }
    player.lastUpdated = now;
  }

  // ── write material/lighting hints to frame.layers.physical ──
  _writePhysicalLayer(frame) {
    const p = frame.layers.physical;
    if (!p) return;
    let totalMass = 0;
    for (let i = 0; i < EQUIP_SLOT.COUNT; i++) totalMass += this._equipmentMass[i];
    p.playerTotalMass = totalMass;

    if (!p.playerEquipmentLights) {
      p.playerEquipmentLights = { count: 0, positions: [], colors: [], intensities: [] };
    }
    const lights = p.playerEquipmentLights;
    lights.count = 0;
    lights.positions.length = 0;
    lights.colors.length = 0;
    lights.intensities.length = 0;

    for (let i = 0; i < EQUIP_SLOT.COUNT; i++) {
      const emit = this._equipmentEmissive[i];
      if (emit <= 0.05) continue;
      const joint = this._equipmentAttachJoint[i];
      if (joint < 0 || joint >= this._jointCount) continue;
      const wp = this._nodes[joint].worldPos;
      lights.positions.push(wp.x, wp.y, wp.z);
      const c = this._equipmentLightColor[i];
      lights.colors.push(c[0], c[1], c[2]);
      lights.intensities.push(emit);
      lights.count++;
    }
    // Joint-level emissive from heat/fire deformation.
    p.playerJointEmissive = this._jointEmissive;
    p.playerBalloonScale = this._deformation.balloonScale;
  }

  // ── public accessors ───────────────────────────────────────
  attachDispatcher(d) { this._dispatcher = d; return this; }
  get currentState() { return this._currentState; }
  get currentStateName() { return this._animRegistry.getName(this._currentState); }
  get playerStats() { return this._playerStats; }
  get rootPosition() { return this._rootMotion.position; }
  get jointNodes() { return this._nodes; }
  get goapPlan() { return this._goapPlan; }
  get goapWorldState() { return this._goapWorldState; }
  get jointCount() { return this._jointCount; }

  getStats() { return Object.freeze({ ...this._stats }); }
  resetStats() { for (const k of Object.keys(this._stats)) this._stats[k] = 0; }

  dispose() {
    this._dispatcher = null;
    this._frameRef = null;
    this._equipment.fill(null);
    this._equipmentMass.fill(0);
    this._equipmentEmissive.fill(0);
    this._springBones.forEach(s => s.active = 0);
    this._deformation.pokes.length = 0;
    this._deformation.muscles.clear();
    this._deformation.bends.clear();
    this._deformation.screws.clear();
    this._deformation.heat.clear();
    this._deformation.fire.clear();
  }
}

export {
  PlayerContextProvider,
  JointRegistry, AnimStateRegistry, GoapBitRegistry, ProceduralParamRegistry,
  JOINT, ANIM_STATE, ANIM_STATE_NAMES, GOAP_BIT, EQUIP_SLOT, EQUIP_DEFAULT_JOINT,
  ROOT_MOTION_PROFILES, IK_SOLVER, DEFORM,
  TwoBoneIKSolver, CCDIKSolver, FABRIKIKSolver, JacobianIKSolver, HybridIKSolver,
  RootMotionController, MotionMatchingDatabase, DeformationOverlay,
  JointNode
};