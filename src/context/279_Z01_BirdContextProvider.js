// file number : 279_Z01
// full path name : src/context/279_Z01_BirdContextProvider.js
// description : Bird context provider — a specialized living-creature controller for birds (raptors, songbirds, waterfowl, corvids) built on the same registries, IK stack, root-motion controller, motion-matching database, and deformation overlays as 279_PlayerContextProvider. Defines a bird skeleton (body, neck, head, beak, two 4-segment wings with shoulder/elbow/wrist/primaries, tail with 3 segments, two 3-segment legs with talons, wing-tip attachment bones for feather clusters) that can be swapped for any avian species at runtime. Provides flight root-motion profiles: flap, glide, soar, dive, hover, perch, takeoff, land. Provides per-limb IK for perch grip, beak target, and wingtip contact. Provides feather-ruffle, aerodynamics-stress, heat, and fire deformation overlays wired into joint emissive. Provides GOAP actions and goals for flocking, hunting, perching, takeoff, landing, singing, preening, fleeing, and attacking. Provides motion-matching samples for each flight gait. Writes pose, velocity, focus distance, stats, skeleton transforms, and light-eligible emissive flags into frame.layers.player and frame.layers.physical using the same contract as 279 so that downstream consumers (rendering, clustered lighting, physics, ecology) require no changes.
// best for : Populating any bird entity in the living world — carrion eaters, birds of prey, flocks, waterfowl — with realistic flight, perch, hunt, and interaction behaviour. Complements 279 (humanoid) and future creature providers (fish, quadrupeds, monsters, machines) so the entire fauna ecosystem is driven by the same registries and context-frame contract.
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

import {
  JointRegistry, AnimStateRegistry, GoapBitRegistry, ProceduralParamRegistry,
  JointNode, RootMotionController, MotionMatchingDatabase, DeformationOverlay,
  TwoBoneIKSolver, CCDIKSolver, FABRIKIKSolver, JacobianIKSolver, HybridIKSolver,
  IK_SOLVER, DEFORM, EQUIP_SLOT, EQUIP_DEFAULT_JOINT,
  ROOT_MOTION_PROFILES as _BASE_ROOT_MOTION_PROFILES
} from './279_PlayerContextProvider.js';

// ══════════════════════════════════════════════════════════════════
// ─── BIRD REGISTRIES (own instances, same shape) ─────────────────
// ══════════════════════════════════════════════════════════════════

const _birdJointReg = new JointRegistry();
const _birdAnimReg = new AnimStateRegistry();
const _birdGoapReg = new GoapBitRegistry();
const _birdProcReg = new ProceduralParamRegistry();

// ── bird skeleton (generic avian template) ─────────────────────
function registerBirdJoints(reg) {
  // core body
  reg.register('ROOT',       null,        [0, 0, 0]);
  reg.register('BODY',       'ROOT',      [0, 0.15, 0]);
  reg.register('CHEST',      'BODY',      [0, 0.05, 0.08]);
  reg.register('PELVIS',     'BODY',      [0, -0.02, -0.05]);

  // neck + head (birds have longer necks than mammals)
  reg.register('NECK_0',     'CHEST',     [0, 0.10, 0.06]);
  reg.register('NECK_1',     'NECK_0',    [0, 0.06, 0.04]);
  reg.register('HEAD',       'NECK_1',    [0, 0.06, 0.03]);
  reg.register('BEAK_UPPER', 'HEAD',      [0, 0.01, 0.08]);
  reg.register('BEAK_LOWER', 'HEAD',      [0, -0.01, 0.07]);
  reg.register('HEAD_ATTACH','HEAD',      [0, 0.04, 0]);

  // left wing: shoulder -> elbow -> wrist -> primaries (4-seg)
  reg.register('L_WING_SHOULDER', 'CHEST',       [ 0.10, 0.02, 0]);
  reg.register('L_WING_ELBOW',    'L_WING_SHOULDER', [ 0.14, 0, 0]);
  reg.register('L_WING_WRIST',    'L_WING_ELBOW',    [ 0.18, 0, 0]);
  reg.register('L_WING_PRIMARY',  'L_WING_WRIST',    [ 0.22, 0, 0]);
  reg.register('L_WING_TIP_ATTACH','L_WING_PRIMARY', [ 0.05, 0, 0]);

  // right wing: mirror
  reg.register('R_WING_SHOULDER', 'CHEST',       [-0.10, 0.02, 0]);
  reg.register('R_WING_ELBOW',    'R_WING_SHOULDER', [-0.14, 0, 0]);
  reg.register('R_WING_WRIST',    'R_WING_ELBOW',    [-0.18, 0, 0]);
  reg.register('R_WING_PRIMARY',  'R_WING_WRIST',    [-0.22, 0, 0]);
  reg.register('R_WING_TIP_ATTACH','R_WING_PRIMARY', [-0.05, 0, 0]);

  // tail (3 segments)
  reg.register('TAIL_0',     'PELVIS',    [0, 0.02, -0.10]);
  reg.register('TAIL_1',     'TAIL_0',    [0, 0, -0.10]);
  reg.register('TAIL_2',     'TAIL_1',    [0, 0, -0.10]);
  reg.register('TAIL_ATTACH','TAIL_2',    [0, 0, -0.05]);

  // left leg: hip -> knee -> ankle -> foot -> talon
  reg.register('L_LEG_HIP',   'PELVIS',   [ 0.05, -0.08, 0]);
  reg.register('L_LEG_KNEE',  'L_LEG_HIP',[ 0.02, -0.06, 0.03]);
  reg.register('L_LEG_ANKLE', 'L_LEG_KNEE',[ 0, -0.05, -0.02]);
  reg.register('L_LEG_FOOT',  'L_LEG_ANKLE',[ 0, -0.02, 0.05]);
  reg.register('L_TALON_0',   'L_LEG_FOOT',[ 0, 0, 0.03]);
  reg.register('L_TALON_1',   'L_LEG_FOOT',[ 0.02, 0, 0.02]);
  reg.register('L_TALON_2',   'L_LEG_FOOT',[-0.02, 0, 0.02]);
  reg.register('L_TALON_BACK','L_LEG_FOOT',[ 0, 0, -0.03]);

  // right leg: mirror
  reg.register('R_LEG_HIP',   'PELVIS',   [-0.05, -0.08, 0]);
  reg.register('R_LEG_KNEE',  'R_LEG_HIP',[-0.02, -0.06, 0.03]);
  reg.register('R_LEG_ANKLE', 'R_LEG_KNEE',[ 0, -0.05, -0.02]);
  reg.register('R_LEG_FOOT',  'R_LEG_ANKLE',[ 0, -0.02, 0.05]);
  reg.register('R_TALON_0',   'R_LEG_FOOT',[ 0, 0, 0.03]);
  reg.register('R_TALON_1',   'R_LEG_FOOT',[ 0.02, 0, 0.02]);
  reg.register('R_TALON_2',   'R_LEG_FOOT',[-0.02, 0, 0.02]);
  reg.register('R_TALON_BACK','R_LEG_FOOT',[ 0, 0, -0.03]);

  // body attachment bones for equipment / saddle / tracking device
  reg.register('BACK_ATTACH',  'BODY',   [0, 0.05, 0]);
  reg.register('CHEST_ATTACH', 'CHEST',  [0, 0.06, 0.02]);
  reg.register('PELVIS_ATTACH','PELVIS', [0, 0.02, 0]);

  reg.freezeBuiltins();
}
registerBirdJoints(_birdJointReg);

// ── bird animation states ──────────────────────────────────────
[
  ['idle', 0], ['perch', 1], ['walk', 2], ['hop', 3],
  ['takeoff', 4], ['land', 5], ['flap', 6], ['glide', 7],
  ['soar', 8], ['dive', 9], ['hover', 10],
  ['preen', 11], ['sing', 12], ['peck', 13],
  ['attack', 14], ['flee', 15], ['death', 16], ['hit', 17],
  ['hunt', 18], ['flock', 19]
].forEach(([name, priority]) => _birdAnimReg.register(name, priority));

// ── bird GOAP bits ─────────────────────────────────────────────
[
  'HAS_TARGET', 'IN_RANGE', 'HAS_LOS',
  'IS_GROUNDED', 'IS_PERCHED', 'IS_AIRBORNE', 'IS_DIVING',
  'IS_LOW_STAMINA', 'IS_HURT', 'IS_HUNTING', 'TARGET_DEAD',
  'HAS_FOOD', 'IS_FLOCKING', 'IS_MATING', 'STORM_NEARBY',
  'PREDATOR_NEARBY'
].forEach(n => _birdGoapReg.register(n));

// ── bird procedural parameters ─────────────────────────────────
_birdProcReg.register('featherRuffle', { amplitude: 0.03, frequency: 2.5, recovery: 3.0 });
_birdProcReg.register('aerodynamicStress', { perUnitSpeed: 0.02, maxStress: 0.4 });
_birdProcReg.register('breath', { period: 2.8, amplitude: 0.015 });
_birdProcReg.register('wingSpring', { stiffness: 120, damping: 10 });
_birdProcReg.register('heat', { emissivePerC: 0.02, colorShiftPerC: 0.015 });
_birdProcReg.register('fire', { spreadRate: 1.2, emissiveMax: 3.5 });

// ── bird root-motion profiles ──────────────────────────────────
const BIRD_ROOT_MOTION_PROFILES = Object.freeze({
  // ground
  walk:    { maxSpeed: 0.8,  acceleration: 6,  angularAcceleration: 5,  gravityScale: 1.0, ground: 'ground', jumpImpulse: 2.5 },
  hop:     { maxSpeed: 1.5,  acceleration: 10, angularAcceleration: 8,  gravityScale: 1.0, ground: 'ground', jumpImpulse: 3.5 },
  perch:   { maxSpeed: 0.0,  acceleration: 3,  angularAcceleration: 4,  gravityScale: 1.0, ground: 'ground', jumpImpulse: 0 },
  land:    { maxSpeed: 1.2,  acceleration: 8,  angularAcceleration: 6,  gravityScale: 1.0, ground: 'ground', jumpImpulse: 0 },
  takeoff: { maxSpeed: 3.5,  acceleration: 12, angularAcceleration: 8,  gravityScale: 0.9, ground: 'ground', jumpImpulse: 6.5 },
  // air
  flap:    { maxSpeed: 6.0,  acceleration: 8,  angularAcceleration: 6,  gravityScale: 0.0, ground: 'air',    jumpImpulse: 0 },
  glide:   { maxSpeed: 8.0,  acceleration: 2,  angularAcceleration: 3,  gravityScale: 0.25, ground: 'air',   jumpImpulse: 0 },
  soar:    { maxSpeed: 12.0, acceleration: 1,  angularAcceleration: 2,  gravityScale: 0.1,  ground: 'air',   jumpImpulse: 0 },
  dive:    { maxSpeed: 20.0, acceleration: 25, angularAcceleration: 12, gravityScale: 1.2, ground: 'air',    jumpImpulse: 0 },
  hover:   { maxSpeed: 1.5,  acceleration: 5,  angularAcceleration: 4,  gravityScale: 0.0,  ground: 'air',   jumpImpulse: 0 },
  flee:    { maxSpeed: 14.0, acceleration: 18, angularAcceleration: 10, gravityScale: 0.0,  ground: 'air',   jumpImpulse: 0 }
});

// ══════════════════════════════════════════════════════════════════
// ─── BIRD PROVIDER ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

class BirdContextProvider {
  constructor(options = {}) {
    // ── config ──────────────────────────────────────────────
    this.ikWeight = options.ikWeight ?? 1.0;
    this.lookAtWeight = options.lookAtWeight ?? 0.8;
    this.perchIKEnabled = options.perchIKEnabled ?? true;
    this.beakIKEnabled = options.beakIKEnabled ?? true;
    this.wingIKEnabled = options.wingIKEnabled ?? true;
    this.proceduralEnabled = options.proceduralEnabled ?? true;
    this.motionMatchingEnabled = options.motionMatchingEnabled ?? true;
    this.goapEnabled = options.goapEnabled ?? true;
    this.goapReplanInterval = options.goapReplanInterval ?? 0.4;
    this.stateBlendRate = options.stateBlendRate ?? 10.0;
    this.defaultIkSolver = options.defaultIkSolver ?? IK_SOLVER.HYBRID;
    this.speciesName = options.speciesName ?? 'generic-bird';

    // ── joint registry (extendable at runtime) ─────────────
    this._jointRegistry = options.jointRegistry || _birdJointReg;
    const jointCount = this._jointRegistry.count;

    this._nodes = new Array(jointCount);
    for (let i = 0; i < jointCount; i++) {
      this._nodes[i] = new JointNode(i, this._jointRegistry.getParent(i));
      const lp = this._jointRegistry.getLocalPos(i);
      this._nodes[i].localPos.set(lp[0], lp[1], lp[2]);
    }
    this._jointCount = jointCount;

    // ── IK targets (wings, feet, beak) ────────────────────
    this._ikTargets = {
      lWing: new Vec3(), rWing: new Vec3(),
      lFoot: new Vec3(), rFoot: new Vec3(),
      beak: new Vec3()
    };
    this._ikWeights = new Float32Array(5); // lWing, rWing, lFoot, rFoot, beak
    this._ikSolvers = {
      lWing: this.defaultIkSolver,
      rWing: this.defaultIkSolver,
      lFoot: IK_SOLVER.TWO_BONE,
      rFoot: IK_SOLVER.TWO_BONE,
      beak: IK_SOLVER.FABRIK
    };

    // ── look-at ────────────────────────────────────────────
    this._lookAtTarget = new Vec3();
    this._lookAtActive = 0;

    // ── root motion (bird-specific profile map) ────────────
    this._rootMotion = new RootMotionController('flap');
    // patch the controller to use bird profiles
    this._rootMotion.profile = BIRD_ROOT_MOTION_PROFILES['flap'];
    this._rootMotion.profileName = 'flap';
    this._rootPosition = this._rootMotion.position;
    this._rootVelocity = this._rootMotion.velocity;
    this._rootQuat = this._rootMotion.quat;
    this._airborne = 0;
    this._altitude = 0;

    // ── equipment (saddle, harness, tracker) ───────────────
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
      // Bird default attachment mapping
      const name = i === EQUIP_SLOT.CHEST ? 'CHEST_ATTACH'
        : i === EQUIP_SLOT.BACK ? 'BACK_ATTACH'
        : i === EQUIP_SLOT.HEAD ? 'HEAD_ATTACH'
        : i === EQUIP_SLOT.LEGS || i === EQUIP_SLOT.FEET || i === EQUIP_SLOT.MAIN_HAND || i === EQUIP_SLOT.OFF_HAND
          ? 'PELVIS_ATTACH' : 'BODY';
      this._equipmentAttachJoint[i] = this._jointRegistry.getIndex(name);
    }

    // ── animation state ────────────────────────────────────
    this._animRegistry = options.animRegistry || _birdAnimReg;
    this._currentState = this._animRegistry.getId('perch');
    this._previousState = this._currentState;
    this._stateBlend = 1.0;
    this._animationTime = 0;
    this._animationSpeed = 1.0;

    // ── motion matching database (seeded) ──────────────────
    this._motionDB = new MotionMatchingDatabase(
      options.featureCapacity ?? 2048, 12
    );
    this._seedMotionSamples();
    this._currentMatchIndex = -1;
    this._currentMatchTime = 0;

    // ── procedural overlays ────────────────────────────────
    this._breathingPhase = 0;
    this._featherRuffle = 0;
    this._featherRuffleTarget = 0;
    this._aerodynamicStress = 0;
    this._hitStaggerTimer = 0;
    this._deformation = new DeformationOverlay();

    // ── spring bones for wingtips / tail feathers ──────────
    this._springBones = {
      lWingTip: { position: new Vec3(), velocity: new Vec3(), target: new Vec3(), active: 1 },
      rWingTip: { position: new Vec3(), velocity: new Vec3(), target: new Vec3(), active: 1 },
      tailTip:  { position: new Vec3(), velocity: new Vec3(), target: new Vec3(), active: 1 }
    };

    // ── GOAP ───────────────────────────────────────────────
    this._goapRegistry = options.goapRegistry || _birdGoapReg;
    this._goapGoals = [];
    this._goapActions = [];
    this._goapWorldState = 0;
    this._goapPlan = [];
    this._goapPlanIndex = 0;
    this._goapReplanTimer = 0;
    this._goapBestGoal = -1;

    // ── species stats ──────────────────────────────────────
    this._stats_bird = {
      health: 50, maxHealth: 50,
      stamina: 100, maxStamina: 100,
      energy: 100, maxEnergy: 100,
      focusDistance: 25,
      wingspan: 1.2,
      bodyMass: 0.4,     // kg
      flightSpeed: 0,
      altitude: 0,
      grounded: 0,
      moving: 0,
      perched: 1
    };

    // ── input ──────────────────────────────────────────────
    this._input = {
      moveX: 0, moveY: 0, lookX: 0, lookY: 0,
      flap: 0, glide: 0, dive: 0, land: 0, takeoff: 0,
      attack: 0, sing: 0, preen: 0, flee: 0
    };

    // ── scratch (pooled) ───────────────────────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpQuatA = new Quat();
    this._tmpQuatB = new Quat();
    this._tmpMatA = new Mat4();
    this._tmpRay = new Ray();
    this._tmpPlane = new Plane();

    // ── joint emissive (heat / fire) ───────────────────────
    this._jointEmissive = new Float32Array(jointCount);

    // ── timing / stats ────────────────────────────────────
    this._lastUpdateTime = -Infinity;
    this._updateCount = 0;
    this._dispatcher = options.dispatcher || null;
    this._frameRef = null;

    this._stats = {
      updates: 0, plansExecuted: 0, plansRejected: 0,
      ikEvaluations: 0, motionMatches: 0, springUpdates: 0,
      stateTransitions: 0, causalEventsEmitted: 0, deformationsApplied: 0,
      takeoffs: 0, landings: 0, hunts: 0
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── motion-matching seeding ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  _seedMotionSamples() {
    const tags = ['idle', 'perch', 'walk', 'hop', 'takeoff', 'flap',
                  'glide', 'soar', 'dive', 'hover'];
    for (const tag of tags) {
      const id = this._animRegistry.getId(tag);
      for (let s = 0; s < 12; s++) {
        const phase = (s / 12) * 2 * Math.PI;
        const amp = tag === 'dive' ? 3.0
          : tag === 'soar' ? 2.0
          : tag === 'glide' ? 1.5
          : tag === 'flap' ? 1.8
          : 0.3;
        this._motionDB.add(
          { x: Math.cos(phase) * 0.1, y: 0, z: Math.sin(phase) * 0.1 },
          { x: Math.cos(phase) * amp, y: 0, z: Math.sin(phase) * amp },
          { x: Math.cos(phase + 0.4) * amp * 0.5, y: 0, z: Math.sin(phase + 0.4) * amp * 0.5 },
          id, s * 0.08
        );
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── runtime extension ────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  registerJoint(name, parentName, localPos, localRot = [0, 0, 0, 1]) {
    const idx = this._jointRegistry.register(name, parentName, localPos, localRot);
    if (idx >= this._nodes.length) {
      this._nodes.push(new JointNode(idx, this._jointRegistry.getParent(idx)));
      this._jointCount = this._nodes.length;
      const newEm = new Float32Array(this._jointCount);
      newEm.set(this._jointEmissive);
      this._jointEmissive = newEm;
    }
    const lp = this._jointRegistry.getLocalPos(idx);
    this._nodes[idx].localPos.set(lp[0], lp[1], lp[2]);
    return idx;
  }
  registerAnimationState(name, priority = 0) { return this._animRegistry.register(name, priority); }
  registerGoapBit(name) { return this._goapRegistry.register(name); }
  registerProceduralParam(name, params) { _birdProcReg.register(name, params); return this; }
  registerGoapAction(action) { this._goapActions.push(action); return this; }
  registerGoapGoal(goal) { this._goapGoals.push(goal); return this; }

  // ══════════════════════════════════════════════════════════
  // ─── forward kinematics ───────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateFK() {
    for (let i = 0; i < this._jointCount; i++) {
      const node = this._nodes[i];
      const parent = node.parent >= 0 ? this._nodes[node.parent] : null;
      node.recomputeWorldFrom(parent);
    }
    const root = this._nodes[0];
    root.worldPos.copy(this._rootMotion.position);
    root.worldRot.copy(this._rootMotion.quat);
    root.worldMat.compose(root.worldPos, root.worldRot, new Vec3(1, 1, 1));
    for (let i = 1; i < this._jointCount; i++) {
      const node = this._nodes[i];
      const parent = node.parent >= 0 ? this._nodes[node.parent] : root;
      node.recomputeWorldFrom(parent);
    }
  }

  _buildChain(names) {
    const chain = [];
    for (const name of names) {
      const idx = this._jointRegistry.getIndex(name);
      if (idx >= 0) chain.push(this._nodes[idx]);
    }
    return chain;
  }

  // ══════════════════════════════════════════════════════════
  // ─── IK ───────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateLimbIK(targetPos, weight, chainNames, solverId) {
    if (weight < 1e-5) return;
    const chain = this._buildChain(chainNames);
    if (chain.length < 2) return;
    const solver = this._solversCache[solverId];
    if (!solver) return;
    solver.solve(chain, targetPos, weight);
    this._stats.ikEvaluations++;
  }

  _updatePerchIK(weight) {
    if (!this.perchIKEnabled || weight < 1e-5) return;
    if (this._ikWeights[2] > 1e-5) {
      this._updateLimbIK(this._ikTargets.lFoot, this._ikWeights[2] * weight,
        ['L_LEG_HIP', 'L_LEG_KNEE', 'L_LEG_ANKLE', 'L_LEG_FOOT'], this._ikSolvers.lFoot);
    }
    if (this._ikWeights[3] > 1e-5) {
      this._updateLimbIK(this._ikTargets.rFoot, this._ikWeights[3] * weight,
        ['R_LEG_HIP', 'R_LEG_KNEE', 'R_LEG_ANKLE', 'R_LEG_FOOT'], this._ikSolvers.rFoot);
    }
  }

  _updateWingIK(weight) {
    if (!this.wingIKEnabled || weight < 1e-5) return;
    if (this._ikWeights[0] > 1e-5) {
      this._updateLimbIK(this._ikTargets.lWing, this._ikWeights[0] * weight,
        ['L_WING_SHOULDER', 'L_WING_ELBOW', 'L_WING_WRIST', 'L_WING_PRIMARY'],
        this._ikSolvers.lWing);
    }
    if (this._ikWeights[1] > 1e-5) {
      this._updateLimbIK(this._ikTargets.rWing, this._ikWeights[1] * weight,
        ['R_WING_SHOULDER', 'R_WING_ELBOW', 'R_WING_WRIST', 'R_WING_PRIMARY'],
        this._ikSolvers.rWing);
    }
  }

  _updateBeakIK(weight) {
    if (!this.beakIKEnabled || weight < 1e-5) return;
    if (this._ikWeights[4] > 1e-5) {
      this._updateLimbIK(this._ikTargets.beak, this._ikWeights[4] * weight,
        ['NECK_0', 'NECK_1', 'HEAD'], this._ikSolvers.beak);
    }
  }

  // solver cache (lazy-built from exported solver classes)
  get _solversCache() {
    if (!this.__solversCache) {
      this.__solversCache = {
        [IK_SOLVER.TWO_BONE]: new TwoBoneIKSolver(),
        [IK_SOLVER.CCD]:      new CCDIKSolver(),
        [IK_SOLVER.FABRIK]:   new FABRIKIKSolver(),
        [IK_SOLVER.JACOBIAN]: new JacobianIKSolver(),
        [IK_SOLVER.HYBRID]:   new HybridIKSolver()
      };
    }
    return this.__solversCache;
  }

  // ══════════════════════════════════════════════════════════
  // ─── look-at ──────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
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
    this._applyLookTo('NECK_0', axis, angle * 0.25 * lookW);
    this._applyLookTo('NECK_1', axis, angle * 0.35 * lookW);
    this._applyLookTo('HEAD',   axis, angle * 0.40 * lookW);
  }

  _applyLookTo(name, axis, angle) {
    const idx = this._jointRegistry.getIndex(name);
    if (idx >= 0) this._nodes[idx].applyRotationDelta(axis, angle);
  }

  // ══════════════════════════════════════════════════════════
  // ─── procedural overlays ──────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateBreathing(dt) {
    if (!this.proceduralEnabled) return;
    const p = _birdProcReg.get('breath');
    this._breathingPhase += dt * (2 * Math.PI / p.period);
    const chest = this._jointRegistry.getIndex('CHEST');
    const pulse = Math.sin(this._breathingPhase) * p.amplitude;
    if (chest >= 0) this._nodes[chest].applyRotationDelta(new Vec3(1, 0, 0), pulse);
  }

  _updateFeatherRuffle(dt) {
    if (!this.proceduralEnabled) return;
    const p = _birdProcReg.get('featherRuffle');
    this._featherRuffle += (this._featherRuffleTarget - this._featherRuffle) * p.recovery * dt;
    this._featherRuffleTarget *= (1 - dt * 2);
    const ruffle = this._featherRuffle * p.amplitude;
    if (Math.abs(ruffle) < 1e-4) return;
    // Wings and tail shake slightly.
    const wings = ['L_WING_SHOULDER', 'L_WING_ELBOW', 'L_WING_WRIST',
                   'R_WING_SHOULDER', 'R_WING_ELBOW', 'R_WING_WRIST'];
    for (const name of wings) {
      const idx = this._jointRegistry.getIndex(name);
      if (idx < 0) continue;
      const jitter = (SimplexNoise.noise(this._breathingPhase * 8, idx) || 0) * ruffle;
      this._nodes[idx].applyRotationDelta(new Vec3(0, 1, 0), jitter);
    }
    const tail = this._jointRegistry.getIndex('TAIL_1');
    if (tail >= 0) {
      const jitter = (SimplexNoise.noise(this._breathingPhase * 6, tail) || 0) * ruffle * 2;
      this._nodes[tail].applyRotationDelta(new Vec3(1, 0, 0), jitter);
    }
  }

  _updateAerodynamicStress(dt) {
    if (!this.proceduralEnabled) return;
    const p = _birdProcReg.get('aerodynamicStress');
    const speed = Math.sqrt(
      this._rootMotion.velocity.x ** 2 +
      this._rootMotion.velocity.y ** 2 +
      this._rootMotion.velocity.z ** 2
    );
    this._aerodynamicStress = Math.min(p.maxStress, speed * p.perUnitSpeed);
    if (this._aerodynamicStress < 1e-3) return;

    // Wings bend backward slightly under stress.
    const bend = this._aerodynamicStress * 0.15;
    const lw = this._jointRegistry.getIndex('L_WING_WRIST');
    const rw = this._jointRegistry.getIndex('R_WING_WRIST');
    if (lw >= 0) this._nodes[lw].applyRotationDelta(new Vec3(0, 1, 0),  bend);
    if (rw >= 0) this._nodes[rw].applyRotationDelta(new Vec3(0, 1, 0), -bend);
  }

  _updateSpringBones(dt) {
    if (!this.proceduralEnabled) return;
    const p = _birdProcReg.get('wingSpring');
    for (const key of Object.keys(this._springBones)) {
      const s = this._springBones[key];
      if (!s.active) continue;
      const dx = s.position.x - s.target.x;
      const dy = s.position.y - s.target.y;
      const dz = s.position.z - s.target.z;
      s.velocity.x += (-p.stiffness * dx - p.damping * s.velocity.x) * dt;
      s.velocity.y += (-p.stiffness * dy - p.damping * s.velocity.y) * dt;
      s.velocity.z += (-p.stiffness * dz - p.damping * s.velocity.z) * dt;
      s.position.x += s.velocity.x * dt;
      s.position.y += s.velocity.y * dt;
      s.position.z += s.velocity.z * dt;
      this._stats.springUpdates++;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── GOAP ─────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _popcount(bits) { let c = 0; while (bits) { c += bits & 1; bits >>= 1; } return c; }

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

  _updateWorldStateBitmask() {
    const reg = this._goapRegistry;
    let bits = 0;
    if (this._stats_bird.grounded) bits |= reg.getBit('IS_GROUNDED');
    if (this._stats_bird.perched) bits |= reg.getBit('IS_PERCHED');
    if (this._airborne) bits |= reg.getBit('IS_AIRBORNE');
    if (this._input.dive > 0.1) bits |= reg.getBit('IS_DIVING');
    if (this._stats_bird.stamina < 20) bits |= reg.getBit('IS_LOW_STAMINA');
    if (this._hitStaggerTimer > 0) bits |= reg.getBit('IS_HURT');
    if (this._input.attack > 0.1) bits |= reg.getBit('HAS_TARGET');
    if (this._input.flee > 0.1) bits |= reg.getBit('PREDATOR_NEARBY');
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

  // ══════════════════════════════════════════════════════════
  // ─── state machine ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateAnimationState(dt) {
    const S = (n) => this._animRegistry.getId(n);
    if (this._hitStaggerTimer > 0) this._transitionTo(S('hit'));
    else if (this._stats_bird.health <= 0) this._transitionTo(S('death'));
    else if (this._input.flee > 0.1) this._transitionTo(S('flee'));
    else if (this._input.attack > 0.1) this._transitionTo(S('attack'));
    else if (this._input.takeoff > 0.1 && this._stats_bird.grounded) this._transitionTo(S('takeoff'));
    else if (this._input.dive > 0.1 && this._airborne) this._transitionTo(S('dive'));
    else if (this._input.glide > 0.1 && this._airborne) this._transitionTo(S('glide'));
    else if (this._input.flap > 0.1 && this._airborne) this._transitionTo(S('flap'));
    else if (this._input.sing > 0.1) this._transitionTo(S('sing'));
    else if (this._input.preen > 0.1) this._transitionTo(S('preen'));
    else if (this._airborne) this._transitionTo(S('soar'));
    else if (this._stats_bird.perched) this._transitionTo(S('perch'));
    else {
      const speed = this._stats_bird.flightSpeed;
      if (speed > 0.5) this._transitionTo(S('walk'));
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
      const takeoff = this._animRegistry.getId('takeoff');
      const land = this._animRegistry.getId('land');
      if (newState === takeoff) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.AUDIO_LIGHT, [this._rootMotion.position.x, this._rootMotion.position.y, this._rootMotion.position.z],
          -1, 10, 0.4, { kind: 'takeoff', species: this.speciesName }
        );
        this._stats.takeoffs++;
        this._stats.causalEventsEmitted++;
      } else if (newState === land) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.IMPACT, [this._rootMotion.position.x, this._rootMotion.position.y, this._rootMotion.position.z],
          -1, 8, 0.6, { kind: 'land', species: this.speciesName }
        );
        this._stats.landings++;
        this._stats.causalEventsEmitted++;
      } else if (newState === this._animRegistry.getId('attack')) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.IMPACT, [this._rootMotion.position.x, this._rootMotion.position.y, this._rootMotion.position.z],
          -1, 30, 0.5, { kind: 'strike', species: this.speciesName }
        );
        this._stats.hunts++;
        this._stats.causalEventsEmitted++;
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── root motion: bird-specific flight physics ────────────
  // ══════════════════════════════════════════════════════════
  _updateRootMotion(dt) {
    // Determine profile from current action.
    let profileName = 'perch';
    if (this._input.takeoff > 0.1 && this._stats_bird.grounded) profileName = 'takeoff';
    else if (this._input.dive > 0.1 && this._airborne) profileName = 'dive';
    else if (this._input.glide > 0.1 && this._airborne) profileName = 'glide';
    else if (this._input.flap > 0.1 && this._airborne) profileName = 'flap';
    else if (this._input.flee > 0.1) profileName = 'flee';
    else if (this._airborne) profileName = 'soar';
    else if (this._stats_bird.perched) profileName = 'perch';
    else profileName = 'walk';

    if (this._rootMotion.profileName !== profileName) {
      this._rootMotion.profileName = profileName;
      this._rootMotion.profile = BIRD_ROOT_MOTION_PROFILES[profileName];
    }

    // Apply input to velocity.
    const speedScale = Math.min(1, this._stats_bird.stamina / 100);
    const moveX = this._input.moveX, moveY = this._input.moveY;
    const dir = this._tmpVecA.set(moveX, 0, moveY);
    if (dir.lengthSq() > 1e-6) dir.normalize();
    const targetSpeed = this._rootMotion.profile.maxSpeed * speedScale * dir.length();

    const accel = this._rootMotion.profile.acceleration * dt;
    this._rootMotion.velocity.x += Math.sign(dir.x * targetSpeed - this._rootMotion.velocity.x) *
      Math.min(Math.abs(dir.x * targetSpeed - this._rootMotion.velocity.x), accel);
    this._rootMotion.velocity.z += Math.sign(dir.z * targetSpeed - this._rootMotion.velocity.z) *
      Math.min(Math.abs(dir.z * targetSpeed - this._rootMotion.velocity.z), accel);

    // Vertical: flap lifts, glide falls slowly, dive falls fast.
    const gravity = 9.81 * this._rootMotion.profile.gravityScale;
    if (this._airborne) {
      if (profileName === 'dive') {
        this._rootMotion.verticalVelocity -= (gravity + 15) * dt;
      } else if (profileName === 'flap') {
        this._rootMotion.verticalVelocity = (this._input.flap - 0.4) * 3;
      } else if (profileName === 'glide' || profileName === 'soar') {
        this._rootMotion.verticalVelocity -= gravity * 0.3 * dt;
      } else {
        this._rootMotion.verticalVelocity -= gravity * dt;
      }
    } else if (this._input.takeoff > 0.1 && this._stats_bird.grounded) {
      this._rootMotion.verticalVelocity = this._rootMotion.profile.jumpImpulse || 5.0;
      this._airborne = 1;
      this._stats_bird.grounded = 0;
      this._stats_bird.perched = 0;
    }

    // Integrate position.
    this._rootMotion.position.x += this._rootMotion.velocity.x * dt;
    this._rootMotion.position.z += this._rootMotion.velocity.z * dt;
    this._rootMotion.position.y += this._rootMotion.verticalVelocity * dt;

    // Ground contact.
    if (this._rootMotion.position.y <= 0) {
      this._rootMotion.position.y = 0;
      this._rootMotion.verticalVelocity = 0;
      if (this._airborne) {
        this._airborne = 0;
        this._stats_bird.grounded = 1;
        this._stats_bird.perched = 1;
        this._transitionTo(this._animRegistry.getId('land'));
      }
    } else {
      this._airborne = 1;
    }

    this._altitude = this._rootMotion.position.y;
    this._stats_bird.altitude = this._altitude;

    // Stamina drain for flapping, regen when gliding or perched.
    if (profileName === 'flap' || profileName === 'takeoff' || profileName === 'flee') {
      this._stats_bird.stamina = Math.max(0, this._stats_bird.stamina - dt * 8);
    } else if (profileName === 'glide' || profileName === 'soar' || profileName === 'perch') {
      this._stats_bird.stamina = Math.min(this._stats_bird.maxStamina,
        this._stats_bird.stamina + dt * 12);
    }

    // Facing from velocity.
    const speedSq = this._rootMotion.velocity.x ** 2 + this._rootMotion.velocity.z ** 2;
    if (speedSq > 1e-4) {
      const targetYaw = Math.atan2(this._rootMotion.velocity.x, this._rootMotion.velocity.z);
      const currentYaw = 2 * Math.acos(Math.min(1, Math.max(-1, this._rootMotion.quat.w))) *
        (this._rootMotion.quat.y >= 0 ? 1 : -1);
      let dYaw = targetYaw - currentYaw;
      while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
      while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
      const maxStep = this._rootMotion.profile.angularAcceleration * dt;
      const step = Math.sign(dYaw) * Math.min(Math.abs(dYaw), maxStep);
      this._rootMotion.quat.multiply(
        new Quat().setFromAxisAngle(new Vec3(0, 1, 0), step)
      ).normalize();
    }

    this._stats_bird.flightSpeed = Math.sqrt(speedSq + this._rootMotion.verticalVelocity ** 2);
    this._stats_bird.moving = this._stats_bird.flightSpeed > 0.3 ? 1 : 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── causal reactions ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _readCausal(frame) {
    const causal = frame.layers.causal;
    if (!causal || !causal.derivedSignals) return;
    const s = causal.derivedSignals;
    for (let i = 0; i < s.count; i++) {
      if (s.types[i] === DERIVED_SIGNAL.LIGHT_FLICKER && s.forces[i] > 25) {
        if (this._hitStaggerTimer <= 0) {
          this._hitStaggerTimer = 0.2;
          this._transitionTo(this._animRegistry.getId('hit'));
          this._featherRuffleTarget = 1.0;
        }
      }
      if (s.types[i] === DERIVED_SIGNAL.IGNITE_CANDIDATE) {
        this._featherRuffleTarget = 1.0;
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── equipment ────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  equipItem(slot, item) {
    if (slot < 0 || slot >= EQUIP_SLOT.COUNT) return false;
    this._equipment[slot] = item;
    this._equipmentMass[slot] = item.mass || 0.1;
    this._equipmentAttachJoint[slot] = item.attachJoint ?? this._equipmentAttachJoint[slot];
    if (item.offset) this._equipmentOffset[slot].copy(item.offset);
    if (item.lightColor) this._equipmentLightColor[slot] = item.lightColor.slice();
    return true;
  }

  unequipItem(slot) {
    if (slot < 0 || slot >= EQUIP_SLOT.COUNT) return false;
    this._equipment[slot] = null;
    this._equipmentMass[slot] = 0;
    this._equipmentEmissive[slot] = 0;
    this._equipmentEmissiveTarget[slot] = 0;
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
      const cur = this._equipmentEmissive[i];
      if (Math.abs(target - cur) < 0.001) continue;
      const tau = target > cur ? 0.15 : 0.8;
      const alpha = 1 - Math.exp(-dt / tau);
      this._equipmentEmissive[i] = cur + (target - cur) * alpha;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── input / targets ──────────────────────────────────────
  // ══════════════════════════════════════════════════════════
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
      const map = { lWing: 0, rWing: 1, lFoot: 2, rFoot: 3, beak: 4 };
      this._ikWeights[map[which]] = weight;
    }
    return this;
  }

  setLookAtTarget(target, active = true) {
    this._lookAtTarget.copy(target);
    this._lookAtActive = active ? 1 : 0;
    return this;
  }

  setFlightProfile(name) {
    if (BIRD_ROOT_MOTION_PROFILES[name]) {
      this._rootMotion.profileName = name;
      this._rootMotion.profile = BIRD_ROOT_MOTION_PROFILES[name];
    }
    return this;
  }

  ruffleFeathers(intensity = 1.0) {
    this._featherRuffleTarget = Math.max(this._featherRuffleTarget, intensity);
    return this;
  }

  // ── deformation API ───────────────────────────────────────
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

  // ══════════════════════════════════════════════════════════
  // ─── main update ──────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  update(frame, clock) {
    if (!frame || !frame.layers || !frame.layers.player) return 0;
    const now = clock ? clock.elapsedSeconds : performance.now() / 1000;
    if (now - this._lastUpdateTime < 1 / 60) return 0;
    const dt = Math.min(0.05, now - (this._lastUpdateTime > 0 ? this._lastUpdateTime : now - 1 / 60));
    this._lastUpdateTime = now;
    this._frameRef = frame;

    // 1. Causal reactions
    this._readCausal(frame);

    // 2. Root motion (bird flight physics)
    this._updateRootMotion(dt);
    if (this._hitStaggerTimer > 0) this._hitStaggerTimer -= dt;

    // 3. GOAP
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

    // 4. Animation state + blend
    this._updateAnimationState(dt);
    this._stateBlend = Math.min(1.0, this._stateBlend + this.stateBlendRate * dt);

    // 5. Procedural overlays
    this._updateBreathing(dt);
    this._updateFeatherRuffle(dt);
    this._updateAerodynamicStress(dt);
    this._updateSpringBones(dt);

    // 6. Motion matching
    if (this.motionMatchingEnabled) {
      this._currentMatchIndex = this._motionDB.findNearest(
        this._rootMotion.position, this._rootMotion.velocity,
        new Vec3(this._rootMotion.velocity.x, 0, this._rootMotion.velocity.z),
        this._currentState
      );
      if (this._currentMatchIndex >= 0) {
        this._currentMatchTime = this._motionDB.times[this._currentMatchIndex];
        this._stats.motionMatches++;
      }
    }

    // 7. Deformation overlays
    this._deformation.update(dt, this._nodes, this._jointEmissive);
    this._stats.deformationsApplied++;

    // 8. FK → IK → FK
    this._updateFK();
    this._updatePerchIK(this.ikWeight);
    this._updateWingIK(this.ikWeight);
    this._updateBeakIK(this.ikWeight);
    this._updateFK();
    this._updateLookAt(this.ikWeight);
    this._updateFK();

    // 9. Equipment emissive decay
    this._updateEquipmentEmissive(dt);

    // 10. Write to frame
    this._writePlayerLayer(frame, now);
    this._writePhysicalLayer(frame);

    this._stats.updates++;
    this._updateCount++;
    return 1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── frame writes (same contract as 279) ──────────────────
  // ══════════════════════════════════════════════════════════
  _writePlayerLayer(frame, now) {
    const player = frame.layers.player;
    const bodyIdx = this._jointRegistry.getIndex('BODY');
    const headIdx = this._jointRegistry.getIndex('HEAD');
    const body = bodyIdx >= 0 ? this._nodes[bodyIdx] : this._nodes[0];
    const head = headIdx >= 0 ? this._nodes[headIdx] : this._nodes[0];

    player.position[0] = body.worldPos.x;
    player.position[1] = body.worldPos.y;
    player.position[2] = body.worldPos.z;

    player.velocity[0] = this._rootMotion.velocity.x;
    player.velocity[1] = this._rootMotion.verticalVelocity;
    player.velocity[2] = this._rootMotion.velocity.z;

    this._tmpVecA.set(0, 0, 1).applyQuaternion(head.worldRot);
    player.facing[0] = this._tmpVecA.x;
    player.facing[1] = this._tmpVecA.y;
    player.facing[2] = this._tmpVecA.z;

    player.health = this._stats_bird.health;
    player.mana = this._stats_bird.energy;
    player.stamina = this._stats_bird.stamina;
    player.focusDistance = this._stats_bird.focusDistance;
    player.species = this.speciesName;
    player.altitude = this._altitude;
    player.airborne = this._airborne;

    player.animationState = this._currentState;
    player.animationStateName = this._animRegistry.getName(this._currentState);
    player.animationBlend = this._stateBlend;
    player.animationTime = this._animationTime;

    // Skeleton SoA.
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

  _writePhysicalLayer(frame) {
    const p = frame.layers.physical;
    if (!p) return;
    let totalMass = this._stats_bird.bodyMass;
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

    p.playerJointEmissive = this._jointEmissive;
    p.playerBalloonScale = this._deformation.balloonScale;
    p.playerAltitude = this._altitude;
    p.playerWingspan = this._stats_bird.wingspan;
  }

  // ── accessors ─────────────────────────────────────────────
  attachDispatcher(d) { this._dispatcher = d; return this; }
  get currentState() { return this._currentState; }
  get currentStateName() { return this._animRegistry.getName(this._currentState); }
  get playerStats() { return this._stats_bird; }
  get rootPosition() { return this._rootMotion.position; }
  get jointNodes() { return this._nodes; }
  get goapPlan() { return this._goapPlan; }
  get goapWorldState() { return this._goapWorldState; }
  get jointCount() { return this._jointCount; }
  get isAirborne() { return this._airborne === 1; }

  getStats() { return Object.freeze({ ...this._stats }); }
  resetStats() { for (const k of Object.keys(this._stats)) this._stats[k] = 0; }

  dispose() {
    this._dispatcher = null;
    this._frameRef = null;
    this._equipment.fill(null);
    this._equipmentMass.fill(0);
    this._equipmentEmissive.fill(0);
    this._springBones.lWingTip.active = 0;
    this._springBones.rWingTip.active = 0;
    this._springBones.tailTip.active = 0;
    this._deformation.pokes.length = 0;
    this._deformation.muscles.clear();
    this._deformation.bends.clear();
    this._deformation.screws.clear();
    this._deformation.heat.clear();
    this._deformation.fire.clear();
  }
}

export {
  BirdContextProvider,
  BIRD_ROOT_MOTION_PROFILES,
  _birdJointReg as BIRD_JOINT_REGISTRY,
  _birdAnimReg as BIRD_ANIM_REGISTRY,
  _birdGoapReg as BIRD_GOAP_REGISTRY,
  _birdProcReg as BIRD_PROC_REGISTRY
};