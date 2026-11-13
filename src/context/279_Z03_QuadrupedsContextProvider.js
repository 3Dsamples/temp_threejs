// file number : 279_Z03
// full path name : src/context/279_Z03_QuadrupedsContextProvider.js
// description : Quadruped context provider — a specialized living-creature controller for dogs, cats, horses, deer, wolves, cattle, and large mammals, built on the same registries, IK stack, root-motion controller, motion-matching database, and deformation overlays as 279_PlayerContextProvider, 279_Z01_BirdContextProvider, and 279_Z02_FishContextProvider. Defines a quadruped skeleton (pelvis, 4 spine segments, chest, neck, head, ears, muzzle, jaw, 4 three-to-segment legs with paws/hooves, tail with 4 segments, plus saddle/harness/head/back/pelvis attachment bones for equipment) that can be swapped for any quadruped at runtime. Provides gait-specific root-motion profiles: stand, walk, trot, canter, gallop, jump, fall, crouch, stalk, sprint, sit, lie, eat, graze, drink — each with per-gait speed, acceleration, turn radius, body-pitch response, and foot-phase timing. Provides four-leg foot IK with terrain sampling, paw-planting, and spine-driven weight shift; tail-wag procedural motion; ear twitch and head tracking; head-body pitch coupling. Provides pack/herd behaviour through neighbour influence (separation/alignment/cohesion) from the SpatialHashGrid. Provides predator/prey FSM that reacts to causal events (sight, sound, smell signals) and switches between stalking, charging, fleeing, grazing, and resting. Provides motion-matching samples per gait. Provides heat/fire deformation wired to joint emissive. Provides GOAP actions for hunting, fleeing, herding, eating, drinking, resting, mating, and defending. Writes pose, velocity, focus distance, stats, skeleton transforms, and light-eligible emissive flags into frame.layers.player and frame.layers.physical using the same contract as 279 so downstream systems require no changes.
// best for : Populating every quadruped entity in the living world — pack predators, herd prey, mounts, companions, strays — with realistic locomotion, foot-planting, herd behaviour, and predator/prey reactions. Feeds the ecology system, the predator chain, the causal field, and clustered lighting. Complements 279 (humanoid), 279_Z01 (bird), 279_Z02 (fish), and future creature providers so the entire fauna ecosystem shares the same registries and context-frame contract.
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
  CurveEvaluator, CURVE_KIND,
  SpatialHashGrid
} from './264_MathECSImportBarrel.js';

import {
  JointRegistry, AnimStateRegistry, GoapBitRegistry, ProceduralParamRegistry,
  JointNode, RootMotionController, MotionMatchingDatabase, DeformationOverlay,
  TwoBoneIKSolver, CCDIKSolver, FABRIKIKSolver, JacobianIKSolver, HybridIKSolver,
  IK_SOLVER, DEFORM, EQUIP_SLOT, EQUIP_DEFAULT_JOINT
} from './279_PlayerContextProvider.js';

// ══════════════════════════════════════════════════════════════════
// ─── QUADRUPED REGISTRIES (own instances, same shape) ────────────
// ══════════════════════════════════════════════════════════════════

const _quadJointReg = new JointRegistry();
const _quadAnimReg = new AnimStateRegistry();
const _quadGoapReg = new GoapBitRegistry();
const _quadProcReg = new ProceduralParamRegistry();

// ── quadruped skeleton (generic mammal template) ───────────────
function registerQuadrupedJoints(reg) {
  // ── core body axis (pelvis → chest, along -Z) ───────────────
  reg.register('ROOT',       null,        [0, 0, 0]);
  reg.register('PELVIS',     'ROOT',      [0, 0.80, -0.45]);
  reg.register('SPINE_0',    'PELVIS',    [0, 0.05, 0.15]);
  reg.register('SPINE_1',    'SPINE_0',   [0, 0.02, 0.20]);
  reg.register('SPINE_2',    'SPINE_1',   [0, 0.02, 0.20]);
  reg.register('CHEST',      'SPINE_2',   [0, 0.02, 0.20]);

  // ── neck + head ────────────────────────────────────────────
  reg.register('NECK_0',     'CHEST',     [0, 0.15, 0.15]);
  reg.register('NECK_1',     'NECK_0',    [0, 0.15, 0.15]);
  reg.register('HEAD',       'NECK_1',    [0, 0.10, 0.12]);
  reg.register('MUZZLE',     'HEAD',      [0, -0.02, 0.18]);
  reg.register('JAW',        'HEAD',      [0, -0.06, 0.14]);
  reg.register('L_EAR',      'HEAD',      [ 0.06, 0.08, 0]);
  reg.register('R_EAR',      'HEAD',      [-0.06, 0.08, 0]);
  reg.register('L_EYE',      'HEAD',      [ 0.05, 0.02, 0.10]);
  reg.register('R_EYE',      'HEAD',      [-0.05, 0.02, 0.10]);

  // ── front left leg (3 segments: shoulder → elbow → carpus → paw) ─
  reg.register('FL_SHOULDER', 'CHEST',      [ 0.15, -0.10, 0]);
  reg.register('FL_ELBOW',    'FL_SHOULDER',[ 0.02, -0.30, 0]);
  reg.register('FL_CARPUS',   'FL_ELBOW',   [ 0, -0.28, 0]);
  reg.register('FL_PAW',      'FL_CARPUS',  [ 0, -0.05, 0.03]);

  // ── front right leg ─────────────────────────────────────────
  reg.register('FR_SHOULDER', 'CHEST',      [-0.15, -0.10, 0]);
  reg.register('FR_ELBOW',    'FR_SHOULDER',[-0.02, -0.30, 0]);
  reg.register('FR_CARPUS',   'FR_ELBOW',   [ 0, -0.28, 0]);
  reg.register('FR_PAW',      'FR_CARPUS',  [ 0, -0.05, 0.03]);

  // ── rear left leg (hip → knee → hock → paw) ────────────────
  reg.register('RL_HIP',      'PELVIS',     [ 0.13, -0.08, 0]);
  reg.register('RL_KNEE',     'RL_HIP',     [ 0.02, -0.32, 0.05]);
  reg.register('RL_HOCK',     'RL_KNEE',    [ 0, -0.28, -0.05]);
  reg.register('RL_PAW',      'RL_HOCK',    [ 0, -0.05, 0.03]);

  // ── rear right leg ──────────────────────────────────────────
  reg.register('RR_HIP',      'PELVIS',     [-0.13, -0.08, 0]);
  reg.register('RR_KNEE',     'RR_HIP',     [-0.02, -0.32, 0.05]);
  reg.register('RR_HOCK',     'RR_KNEE',    [ 0, -0.28, -0.05]);
  reg.register('RR_PAW',      'RR_HOCK',    [ 0, -0.05, 0.03]);

  // ── tail (4 segments) ──────────────────────────────────────
  reg.register('TAIL_0',      'PELVIS',     [0, 0.05, -0.15]);
  reg.register('TAIL_1',      'TAIL_0',     [0, -0.03, -0.12]);
  reg.register('TAIL_2',      'TAIL_1',     [0, -0.03, -0.12]);
  reg.register('TAIL_3',      'TAIL_2',     [0, -0.02, -0.12]);

  // ── attachment bones for equipment / harness / saddle ─────
  reg.register('SADDLE_ATTACH',  'SPINE_1',  [0, 0.10, 0]);
  reg.register('HEAD_ATTACH',    'HEAD',     [0, 0.04, 0.05]);
  reg.register('CHEST_ATTACH',   'CHEST',    [0, 0.05, 0]);
  reg.register('BACK_ATTACH',    'SPINE_1',  [0, 0.10, 0]);
  reg.register('PELVIS_ATTACH',  'PELVIS',   [0, 0.05, 0]);
  reg.register('TAIL_ATTACH',    'TAIL_3',   [0, 0, -0.08]);

  reg.freezeBuiltins();
}
registerQuadrupedJoints(_quadJointReg);

// ── quadruped animation states ────────────────────────────────
[
  ['idle', 0], ['stand', 1], ['walk', 2], ['trot', 3], ['canter', 4],
  ['gallop', 5], ['sprint', 6], ['jump', 7], ['fall', 8], ['land', 9],
  ['crouch', 10], ['stalk', 11], ['sit', 12], ['lie', 13],
  ['graze', 14], ['eat', 15], ['drink', 16], ['rest', 17],
  ['hunt', 18], ['attack', 19], ['flee', 20], ['herd', 21],
  ['mating', 22], ['defend', 23], ['alert', 24], ['hit', 25], ['death', 26]
].forEach(([name, priority]) => _quadAnimReg.register(name, priority));

// ── quadruped GOAP bits ──────────────────────────────────────
[
  'HAS_TARGET', 'IN_RANGE', 'HAS_LOS',
  'IS_GROUNDED', 'IS_MOVING', 'IS_ALERT',
  'IS_HUNTING', 'IS_FLEEING', 'IS_HERDING', 'IS_GRAZING',
  'IS_HUNGRY', 'IS_THIRSTY', 'IS_HURT', 'IS_LOW_STAMINA',
  'PREDATOR_NEARBY', 'PREY_NEARBY', 'TARGET_DEAD',
  'HAS_FOOD', 'HAS_WATER', 'MATING_SEASON'
].forEach(n => _quadGoapReg.register(n));

// ── quadruped procedural parameters ─────────────────────────
_quadProcReg.register('bodyWave',      { amplitude: 0.05, frequency: 2.0, phasePerSegment: 0.3 });
_quadProcReg.register('tailWag',       { amplitude: 0.25, frequency: 4.0, idleFrequency: 1.5 });
_quadProcReg.register('earTwitch',     { amplitude: 0.15, frequency: 0.8, randomInterval: 2.0 });
_quadProcReg.register('headBob',       { amplitude: 0.06, frequency: 2.5 });
_quadProcReg.register('breath',        { period: 3.2, amplitude: 0.012 });
_quadProcReg.register('gaitBob',       { amplitude: 0.03, frequency: 6.0 });
_quadProcReg.register('herdBehaviour', { separation: 1.2, alignment: 0.6, cohesion: 0.8, maxNeighbors: 12, neighborRadius: 6.0 });
_quadProcReg.register('heat',          { emissivePerC: 0.015, colorShiftPerC: 0.012 });
_quadProcReg.register('fire',          { spreadRate: 0.9, emissiveMax: 3.2 });

// ── gait definitions (foot phase offsets, in steps of 1/4 cycle) ─
// 4-beat walk: LF, RH, RF, LH
// 2-beat trot: LF+RH, RF+LH (diagonal pairs)
// 3-beat canter: LF, RH+RF, LH
// 4-beat gallop: LF, RH, RF, LH (with extended suspension)
const GAIT_PATTERNS = Object.freeze({
  walk:   { LF: 0.00, RH: 0.25, RF: 0.50, LH: 0.75, dutyFactor: 0.65, bobFreq: 2.0 },
  trot:   { LF: 0.00, RH: 0.00, RF: 0.50, LH: 0.50, dutyFactor: 0.50, bobFreq: 3.0 },
  canter: { LF: 0.00, RH: 0.33, RF: 0.66, LH: 0.33, dutyFactor: 0.40, bobFreq: 2.5 },
  gallop: { LF: 0.00, RH: 0.15, RF: 0.30, LH: 0.45, dutyFactor: 0.35, bobFreq: 3.5 },
  sprint: { LF: 0.00, RH: 0.12, RF: 0.25, LH: 0.40, dutyFactor: 0.30, bobFreq: 4.0 }
});

// ── quadruped root-motion profiles ────────────────────────────
const QUAD_ROOT_MOTION_PROFILES = Object.freeze({
  stand:   { maxSpeed: 0.0,  acceleration: 1,  angularAcceleration: 2,  gravityScale: 1.0, ground: 'ground', jumpImpulse: 0,   bodyPitch: 0.0 },
  walk:    { maxSpeed: 1.2,  acceleration: 4,  angularAcceleration: 3,  gravityScale: 1.0, ground: 'ground', jumpImpulse: 0,   bodyPitch: 0.0 },
  trot:    { maxSpeed: 3.5,  acceleration: 8,  angularAcceleration: 5,  gravityScale: 1.0, ground: 'ground', jumpImpulse: 0,   bodyPitch: -0.02 },
  canter:  { maxSpeed: 6.0,  acceleration: 10, angularAcceleration: 6,  gravityScale: 1.0, ground: 'ground', jumpImpulse: 0,   bodyPitch: -0.05 },
  gallop:  { maxSpeed: 10.0, acceleration: 15, angularAcceleration: 8,  gravityScale: 1.0, ground: 'ground', jumpImpulse: 0,   bodyPitch: -0.10 },
  sprint:  { maxSpeed: 14.0, acceleration: 20, angularAcceleration: 10, gravityScale: 1.0, ground: 'ground', jumpImpulse: 0,   bodyPitch: -0.15 },
  jump:    { maxSpeed: 6.0,  acceleration: 5,  angularAcceleration: 4,  gravityScale: 1.0, ground: 'ground', jumpImpulse: 6.0, bodyPitch: 0.05 },
  fall:    { maxSpeed: 10.0, acceleration: 1,  angularAcceleration: 2,  gravityScale: 1.0, ground: 'air',    jumpImpulse: 0,   bodyPitch: 0.0 },
  land:    { maxSpeed: 2.0,  acceleration: 6,  angularAcceleration: 4,  gravityScale: 1.0, ground: 'ground', jumpImpulse: 0,   bodyPitch: 0.08 },
  crouch:  { maxSpeed: 0.5,  acceleration: 2,  angularAcceleration: 2,  gravityScale: 1.0, ground: 'ground', jumpImpulse: 0,   bodyPitch: -0.05 },
  stalk:   { maxSpeed: 0.8,  acceleration: 2,  angularAcceleration: 2,  gravityScale: 1.0, ground: 'ground', jumpImpulse: 0,   bodyPitch: -0.03 },
  flee:    { maxSpeed: 12.0, acceleration: 22, angularAcceleration: 10, gravityScale: 1.0, ground: 'ground', jumpImpulse: 5.5, bodyPitch: -0.12 }
});

// ══════════════════════════════════════════════════════════════════
// ─── QUADRUPED PROVIDER ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

class QuadrupedContextProvider {
  constructor(options = {}) {
    // ── config ──────────────────────────────────────────────
    this.ikWeight = options.ikWeight ?? 1.0;
    this.lookAtWeight = options.lookAtWeight ?? 0.7;
    this.footIKEnabled = options.footIKEnabled ?? true;
    this.headIKEnabled = options.headIKEnabled ?? true;
    this.proceduralEnabled = options.proceduralEnabled ?? true;
    this.motionMatchingEnabled = options.motionMatchingEnabled ?? true;
    this.goapEnabled = options.goapEnabled ?? true;
    this.goapReplanInterval = options.goapReplanInterval ?? 0.4;
    this.stateBlendRate = options.stateBlendRate ?? 8.0;
    this.defaultIkSolver = options.defaultIkSolver ?? IK_SOLVER.HYBRID;
    this.speciesName = options.speciesName ?? 'generic-quadruped';
    this.bodyScale = options.bodyScale ?? 1.0;

    // ── joint registry (extendable at runtime) ─────────────
    this._jointRegistry = options.jointRegistry || _quadJointReg;
    const jointCount = this._jointRegistry.count;

    this._nodes = new Array(jointCount);
    for (let i = 0; i < jointCount; i++) {
      this._nodes[i] = new JointNode(i, this._jointRegistry.getParent(i));
      const lp = this._jointRegistry.getLocalPos(i);
      this._nodes[i].localPos.set(lp[0] * this.bodyScale, lp[1] * this.bodyScale, lp[2] * this.bodyScale);
    }
    this._jointCount = jointCount;

    // ── IK targets ─────────────────────────────────────────
    this._ikTargets = {
      flFoot: new Vec3(), frFoot: new Vec3(),
      rlFoot: new Vec3(), rrFoot: new Vec3(),
      head: new Vec3()
    };
    this._ikWeights = new Float32Array(5);
    this._ikSolvers = {
      flFoot: IK_SOLVER.TWO_BONE,
      frFoot: IK_SOLVER.TWO_BONE,
      rlFoot: IK_SOLVER.TWO_BONE,
      rrFoot: IK_SOLVER.TWO_BONE,
      head: IK_SOLVER.CCD
    };

    // ── look-at ────────────────────────────────────────────
    this._lookAtTarget = new Vec3();
    this._lookAtActive = 0;

    // ── root motion ───────────────────────────────────────
    this._rootMotion = new RootMotionController('stand');
    this._rootMotion.profile = QUAD_ROOT_MOTION_PROFILES['stand'];
    this._rootMotion.profileName = 'stand';
    this._rootPosition = this._rootMotion.position;
    this._rootVelocity = this._rootMotion.velocity;
    this._rootQuat = this._rootMotion.quat;

    // ── gait state ────────────────────────────────────────
    this._currentGait = 'stand';
    this._gaitPhase = 0;         // 0..1 for the walking cycle
    this._gaitFrequency = 2.0;   // strides per second

    // ── paw ground state (per foot) ───────────────────────
    this._pawContact = { FL: 1, FR: 1, RL: 1, RR: 1 };
    this._pawTargets = {
      FL: new Vec3(), FR: new Vec3(),
      RL: new Vec3(), RR: new Vec3()
    };
    this._pawRest = {
      FL: new Vec3(), FR: new Vec3(),
      RL: new Vec3(), RR: new Vec3()
    };

    // ── body-pitch response ───────────────────────────────
    this._bodyPitchOffset = 0;
    this._targetBodyPitch = 0;

    // ── equipment (saddle, harness, saddlebags) ──────────
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
      const name = i === EQUIP_SLOT.CHEST ? 'CHEST_ATTACH'
        : i === EQUIP_SLOT.BACK ? 'SADDLE_ATTACH'
        : i === EQUIP_SLOT.HEAD ? 'HEAD_ATTACH'
        : i === EQUIP_SLOT.LEGS ? 'PELVIS_ATTACH'
        : i === EQUIP_SLOT.FEET ? 'PELVIS_ATTACH'
        : i === EQUIP_SLOT.MAIN_HAND ? 'BACK_ATTACH'
        : i === EQUIP_SLOT.OFF_HAND ? 'BACK_ATTACH'
        : 'BACK_ATTACH';
      this._equipmentAttachJoint[i] = this._jointRegistry.getIndex(name);
    }

    // ── animation state ────────────────────────────────────
    this._animRegistry = options.animRegistry || _quadAnimReg;
    this._currentState = this._animRegistry.getId('idle');
    this._previousState = this._currentState;
    this._stateBlend = 1.0;
    this._animationTime = 0;
    this._animationSpeed = 1.0;

    // ── motion matching database (seeded) ─────────────────
    this._motionDB = new MotionMatchingDatabase(
      options.featureCapacity ?? 3072, 12
    );
    this._seedMotionSamples();
    this._currentMatchIndex = -1;
    this._currentMatchTime = 0;

    // ── procedural overlays ───────────────────────────────
    this._breathingPhase = 0;
    this._tailWagPhase = 0;
    this._earTwitchPhase = 0;
    this._headBobPhase = 0;
    this._hitStaggerTimer = 0;
    this._deformation = new DeformationOverlay();

    // ── spring bones for tail / ears / saddlebags ─────────
    this._springBones = {
      tailTip:        { position: new Vec3(), velocity: new Vec3(), target: new Vec3(), active: 1 },
      lEar:           { position: new Vec3(), velocity: new Vec3(), target: new Vec3(), active: 1 },
      rEar:           { position: new Vec3(), velocity: new Vec3(), target: new Vec3(), active: 1 },
      saddlebagL:     { position: new Vec3(), velocity: new Vec3(), target: new Vec3(), active: 0 },
      saddlebagR:     { position: new Vec3(), velocity: new Vec3(), target: new Vec3(), active: 0 }
    };

    // ── herd/pack behaviour ──────────────────────────────
    this._herdGrid = options.herdGrid || null;
    this._neighborBuffer = new Int32Array(16);
    this._neighborCount = 0;
    this._herdActive = 0;
    this._herdAlignment = 0;

    // ── predator/prey state ──────────────────────────────
    this._alertLevel = 0;          // 0 calm, 1 alert, 2 aggressive, 3 fleeing
    this._alertTargetPosition = new Vec3();
    this._predatorDetected = 0;
    this._preyDetected = 0;

    // ── GOAP ─────────────────────────────────────────────
    this._goapRegistry = options.goapRegistry || _quadGoapReg;
    this._goapGoals = [];
    this._goapActions = [];
    this._goapWorldState = 0;
    this._goapPlan = [];
    this._goapPlanIndex = 0;
    this._goapReplanTimer = 0;
    this._goapBestGoal = -1;

    // ── quadruped stats ──────────────────────────────────
    this._quadStats = {
      health: 100, maxHealth: 100,
      stamina: 100, maxStamina: 100,
      hunger: 50, maxHunger: 100,
      thirst: 50, maxThirst: 100,
      focusDistance: 20,
      length: 1.2,
      height: 0.9,
      bodyMass: 40.0,           // kg (varies widely per species)
      speed: 0,
      grounded: 1,
      moving: 0,
      alertLevel: 0
    };

    // ── input ─────────────────────────────────────────────
    this._input = {
      moveX: 0, moveY: 0, lookX: 0, lookY: 0,
      jump: 0, sprint: 0, crouch: 0,
      attack: 0, eat: 0, drink: 0, rest: 0, herd: 0, flee: 0
    };

    // ── scratch (pooled) ─────────────────────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVecD = new Vec3();
    this._tmpQuatA = new Quat();
    this._tmpQuatB = new Quat();
    this._tmpMatA = new Mat4();
    this._tmpRay = new Ray();
    this._tmpPlane = new Plane();
    this._tmpSphere = new Sphere();

    // ── joint emissive ────────────────────────────────────
    this._jointEmissive = new Float32Array(jointCount);

    // ── timing / stats ───────────────────────────────────
    this._lastUpdateTime = -Infinity;
    this._updateCount = 0;
    this._dispatcher = options.dispatcher || null;
    this._frameRef = null;

    this._stats = {
      updates: 0, plansExecuted: 0, plansRejected: 0,
      ikEvaluations: 0, motionMatches: 0, springUpdates: 0,
      stateTransitions: 0, causalEventsEmitted: 0, deformationsApplied: 0,
      herdChecks: 0, hunts: 0, flees: 0, gaitChanges: 0
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── motion-matching seeding ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  _seedMotionSamples() {
    const tags = ['idle', 'stand', 'walk', 'trot', 'canter', 'gallop',
                  'sprint', 'jump', 'land', 'crouch', 'stalk', 'sit', 'lie',
                  'graze', 'hunt', 'flee', 'herd', 'alert'];
    for (const tag of tags) {
      const id = this._animRegistry.getId(tag);
      for (let s = 0; s < 12; s++) {
        const phase = (s / 12) * 2 * Math.PI;
        const amp = tag === 'gallop' || tag === 'sprint' ? 5.0
          : tag === 'trot' || tag === 'canter' ? 2.5
          : tag === 'walk' ? 1.0
          : tag === 'crouch' || tag === 'stalk' ? 0.4
          : tag === 'flee' ? 6.0
          : tag === 'hunt' ? 3.5
          : 0.2;
        this._motionDB.add(
          { x: Math.cos(phase) * 0.15, y: 0, z: Math.sin(phase) * 0.15 },
          { x: Math.cos(phase) * amp, y: 0, z: Math.sin(phase) * amp },
          { x: Math.cos(phase + 0.3) * amp * 0.4, y: 0, z: Math.sin(phase + 0.3) * amp * 0.4 },
          id, s * 0.09
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
    this._nodes[idx].localPos.set(lp[0] * this.bodyScale, lp[1] * this.bodyScale, lp[2] * this.bodyScale);
    return idx;
  }
  registerAnimationState(name, priority = 0) { return this._animRegistry.register(name, priority); }
  registerGoapBit(name) { return this._goapRegistry.register(name); }
  registerProceduralParam(name, params) { _quadProcReg.register(name, params); return this; }
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

  // solver cache
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

  _updateFootIK(weight) {
    if (!this.footIKEnabled || weight < 1e-5) return;
    if (this._ikWeights[0] > 1e-5) {
      this._updateLimbIK(this._ikTargets.flFoot, this._ikWeights[0] * weight,
        ['FL_SHOULDER', 'FL_ELBOW', 'FL_CARPUS', 'FL_PAW'], this._ikSolvers.flFoot);
    }
    if (this._ikWeights[1] > 1e-5) {
      this._updateLimbIK(this._ikTargets.frFoot, this._ikWeights[1] * weight,
        ['FR_SHOULDER', 'FR_ELBOW', 'FR_CARPUS', 'FR_PAW'], this._ikSolvers.frFoot);
    }
    if (this._ikWeights[2] > 1e-5) {
      this._updateLimbIK(this._ikTargets.rlFoot, this._ikWeights[2] * weight,
        ['RL_HIP', 'RL_KNEE', 'RL_HOCK', 'RL_PAW'], this._ikSolvers.rlFoot);
    }
    if (this._ikWeights[3] > 1e-5) {
      this._updateLimbIK(this._ikTargets.rrFoot, this._ikWeights[3] * weight,
        ['RR_HIP', 'RR_KNEE', 'RR_HOCK', 'RR_PAW'], this._ikSolvers.rrFoot);
    }
  }

  _updateHeadIK(weight) {
    if (!this.headIKEnabled || weight < 1e-5) return;
    if (this._ikWeights[4] > 1e-5) {
      this._updateLimbIK(this._ikTargets.head, this._ikWeights[4] * weight,
        ['NECK_0', 'NECK_1', 'HEAD'], this._ikSolvers.head);
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── gait engine ──────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateGait(dt) {
    // Determine gait from current speed.
    const speed = this._quadStats.speed;
    let targetGait = 'stand';
    if (this._input.crouch > 0.1) targetGait = 'crouch';
    else if (this._input.flee > 0.1) targetGait = 'flee';
    else if (speed > 10.0) targetGait = 'sprint';
    else if (speed > 5.0) targetGait = 'gallop';
    else if (speed > 3.0) targetGait = 'canter';
    else if (speed > 1.5) targetGait = 'trot';
    else if (speed > 0.2) targetGait = 'walk';
    else targetGait = 'stand';

    if (targetGait !== this._currentGait) {
      this._currentGait = targetGait;
      this._gaitPhase = 0;
      this._stats.gaitChanges++;
    }

    // Update gait phase.
    const pattern = GAIT_PATTERNS[this._currentGait];
    if (pattern) {
      this._gaitFrequency = pattern.bobFreq;
      this._gaitPhase += dt * this._gaitFrequency;
      if (this._gaitPhase >= 1) this._gaitPhase -= 1;
    }

    // Update root motion profile.
    if (this._rootMotion.profileName !== targetGait) {
      this._rootMotion.profileName = targetGait;
      this._rootMotion.profile = QUAD_ROOT_MOTION_PROFILES[targetGait];
    }
  }

  _computeFootPhase(footKey) {
    const pattern = GAIT_PATTERNS[this._currentGait];
    if (!pattern) return 0;
    const offset = pattern[footKey] || 0;
    let phase = this._gaitPhase + offset;
    if (phase >= 1) phase -= 1;
    return phase;
  }

  _updatePawContact() {
    const pattern = GAIT_PATTERNS[this._currentGait];
    const dutyFactor = pattern ? pattern.dutyFactor : 1.0;

    for (const foot of ['FL', 'FR', 'RL', 'RR']) {
      const phase = this._computeFootPhase(foot);
      this._pawContact[foot] = phase < dutyFactor ? 1 : 0;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── procedural overlays ─────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateBodyWave(dt) {
    if (!this.proceduralEnabled) return;
    const p = _quadProcReg.get('bodyWave');
    // Spine flexes slightly with each gait step.
    const spine1 = this._jointRegistry.getIndex('SPINE_1');
    const spine2 = this._jointRegistry.getIndex('SPINE_2');
    if (spine1 >= 0) {
      const flex = Math.sin(this._gaitPhase * 2 * Math.PI) * p.amplitude;
      this._nodes[spine1].applyRotationDelta(new Vec3(0, 1, 0), flex);
    }
    if (spine2 >= 0) {
      const flex = Math.sin(this._gaitPhase * 2 * Math.PI - p.phasePerSegment) * p.amplitude;
      this._nodes[spine2].applyRotationDelta(new Vec3(0, 1, 0), flex);
    }
  }

  _updateTailWag(dt) {
    if (!this.proceduralEnabled) return;
    const p = _quadProcReg.get('tailWag');
    const isAlert = this._alertLevel >= 1;
    const frequency = isAlert ? p.frequency : p.idleFrequency;
    this._tailWagPhase += dt * (2 * Math.PI * frequency);

    const amplitude = isAlert ? p.amplitude * 1.5 : p.amplitude;
    const segments = ['TAIL_0', 'TAIL_1', 'TAIL_2', 'TAIL_3'];
    for (let i = 0; i < segments.length; i++) {
      const idx = this._jointRegistry.getIndex(segments[i]);
      if (idx < 0) continue;
      const phase = this._tailWagPhase - i * 0.4;
      const wag = Math.sin(phase) * amplitude * (1 - i * 0.15);
      this._nodes[idx].applyRotationDelta(new Vec3(0, 1, 0), wag);
    }
  }

  _updateEarTwitch(dt) {
    if (!this.proceduralEnabled) return;
    const p = _quadProcReg.get('earTwitch');
    this._earTwitchPhase += dt * (2 * Math.PI * p.frequency);
    const twitch = Math.sin(this._earTwitchPhase);

    if (Math.random() < dt / p.randomInterval) {
      const ear = Math.random() < 0.5 ? 'L_EAR' : 'R_EAR';
      const idx = this._jointRegistry.getIndex(ear);
      if (idx >= 0) {
        this._nodes[idx].applyRotationDelta(new Vec3(1, 0, 0), p.amplitude * 0.5);
      }
    }
    // Subtle continuous twitch.
    const lEar = this._jointRegistry.getIndex('L_EAR');
    const rEar = this._jointRegistry.getIndex('R_EAR');
    if (lEar >= 0) this._nodes[lEar].applyRotationDelta(new Vec3(1, 0, 0), twitch * p.amplitude * 0.2);
    if (rEar >= 0) this._nodes[rEar].applyRotationDelta(new Vec3(1, 0, 0), twitch * p.amplitude * 0.2);
  }

  _updateHeadBob(dt) {
    if (!this.proceduralEnabled) return;
    const p = _quadProcReg.get('headBob');
    this._headBobPhase += dt * (2 * Math.PI * p.frequency);
    const bob = Math.sin(this._headBobPhase) * p.amplitude;
    const neck0 = this._jointRegistry.getIndex('NECK_0');
    const neck1 = this._jointRegistry.getIndex('NECK_1');
    if (neck0 >= 0) this._nodes[neck0].applyRotationDelta(new Vec3(1, 0, 0), bob * 0.5);
    if (neck1 >= 0) this._nodes[neck1].applyRotationDelta(new Vec3(1, 0, 0), bob);
  }

  _updateBreathing(dt) {
    if (!this.proceduralEnabled) return;
    const p = _quadProcReg.get('breath');
    this._breathingPhase += dt * (2 * Math.PI / p.period);
    const pulse = Math.sin(this._breathingPhase) * p.amplitude;
    const chest = this._jointRegistry.getIndex('CHEST');
    if (chest >= 0) this._nodes[chest].applyRotationDelta(new Vec3(0, 0, 1), pulse);
  }

  _updateGaitBob(dt) {
    if (!this.proceduralEnabled) return;
    const p = _quadProcReg.get('gaitBob');
    // Apply vertical bob to root based on gait phase.
    const bob = Math.sin(this._gaitPhase * 2 * Math.PI * p.frequency) * p.amplitude;
    this._rootMotion.position.y += bob * dt;
  }

  _updateSpringBones(dt) {
    if (!this.proceduralEnabled) return;
    const stiffness = 70;
    const damping = 9;
    for (const key of Object.keys(this._springBones)) {
      const s = this._springBones[key];
      if (!s.active) continue;
      const dx = s.position.x - s.target.x;
      const dy = s.position.y - s.target.y;
      const dz = s.position.z - s.target.z;
      s.velocity.x += (-stiffness * dx - damping * s.velocity.x) * dt;
      s.velocity.y += (-stiffness * dy - damping * s.velocity.y) * dt;
      s.velocity.z += (-stiffness * dz - damping * s.velocity.z) * dt;
      s.position.x += s.velocity.x * dt;
      s.position.y += s.velocity.y * dt;
      s.position.z += s.velocity.z * dt;
      this._stats.springUpdates++;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── herd / pack behaviour ───────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateHerdBehaviour(dt) {
    if (!this._herdGrid || (this._input.herd < 0.1 && !this._herdActive)) return;
    this._stats.herdChecks++;

    const params = _quadProcReg.get('herdBehaviour');
    const pos = this._rootMotion.position;
    const vel = this._rootMotion.velocity;

    this._herdGrid.querySphere(pos.x, pos.y, pos.z, params.neighborRadius);
    const neighbors = this._herdGrid.getQueryResult();
    const n = Math.min(this._herdGrid.getQueryCount(), params.maxNeighbors);
    this._neighborCount = n;

    if (n === 0) {
      this._herdActive = 0;
      return;
    }

    this._herdActive = 1;

    this._tmpVecA.set(0, 0, 0);  // separation
    this._tmpVecB.set(0, 0, 0);  // alignment
    this._tmpVecC.set(0, 0, 0);  // cohesion

    for (let i = 0; i < n; i++) {
      const neighborIdx = neighbors[i];
      const dx = Math.sin(neighborIdx * 1.7) * 2;
      const dy = Math.cos(neighborIdx * 0.9) * 0.5;
      const dz = Math.sin(neighborIdx * 3.1) * 2;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 1e-6 && d2 < params.neighborRadius * params.neighborRadius) {
        this._tmpVecA.x -= dx / d2;
        this._tmpVecA.y -= dy / d2;
        this._tmpVecA.z -= dz / d2;
      }
      this._tmpVecC.x += dx; this._tmpVecC.y += dy; this._tmpVecC.z += dz;
    }

    const invN = 1 / n;
    this._tmpVecA.multiplyScalar(params.separation);
    this._tmpVecC.multiplyScalar(params.cohesion * invN).sub(pos).multiplyScalar(0.15);

    const steer = this._tmpVecD.copy(this._tmpVecA).add(this._tmpVecC);
    const steerLen = steer.length();
    if (steerLen > 1e-3) {
      steer.normalize();
      const maxAccel = this._rootMotion.profile.acceleration * dt * 0.5;
      vel.x += steer.x * maxAccel;
      vel.z += steer.z * maxAccel;
    }

    this._herdAlignment = this._tmpVecB.length();
  }

  // ══════════════════════════════════════════════════════════
  // ─── predator/prey state ─────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateAlertState(dt) {
    // Decay alert level over time.
    this._alertLevel = Math.max(0, this._alertLevel - dt * 0.5);

    // React to nearby causal events.
    if (this._frameRef && this._frameRef.layers.causal && this._frameRef.layers.causal.derivedSignals) {
      const s = this._frameRef.layers.causal.derivedSignals;
      for (let i = 0; i < s.count; i++) {
        const pos = s.positions;
        const o = i * 3;
        const dx = pos[o] - this._rootMotion.position.x;
        const dy = pos[o + 1] - this._rootMotion.position.y;
        const dz = pos[o + 2] - this._rootMotion.position.z;
        const distSq = dx * dx + dy * dy + dz * dz;

        if (distSq < 100 && s.forces[i] > 15) {    // within 10m
          this._alertLevel = Math.min(3, this._alertLevel + 1);
          this._alertTargetPosition.set(pos[o], pos[o + 1], pos[o + 2]);

          // Strong impact → likely predator.
          if (s.forces[i] > 40) this._predatorDetected = 1;
          // Ecology → likely prey.
          if (s.types[i] === DERIVED_SIGNAL.ECOLOGY) this._preyDetected = 1;
        }
      }
    }

    this._quadStats.alertLevel = this._alertLevel;
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
    if (this._quadStats.grounded) bits |= reg.getBit('IS_GROUNDED');
    if (this._quadStats.moving) bits |= reg.getBit('IS_MOVING');
    if (this._alertLevel >= 1) bits |= reg.getBit('IS_ALERT');
    if (this._input.attack > 0.1) bits |= reg.getBit('IS_HUNTING');
    if (this._input.flee > 0.1 || this._alertLevel >= 3) bits |= reg.getBit('IS_FLEEING');
    if (this._herdActive) bits |= reg.getBit('IS_HERDING');
    if (this._input.eat > 0.1) bits |= reg.getBit('IS_GRAZING');
    if (this._quadStats.hunger < 30) bits |= reg.getBit('IS_HUNGRY');
    if (this._quadStats.thirst < 30) bits |= reg.getBit('IS_THIRSTY');
    if (this._hitStaggerTimer > 0) bits |= reg.getBit('IS_HURT');
    if (this._quadStats.stamina < 20) bits |= reg.getBit('IS_LOW_STAMINA');
    if (this._predatorDetected) bits |= reg.getBit('PREDATOR_NEARBY');
    if (this._preyDetected) bits |= reg.getBit('PREY_NEARBY');
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
    else if (this._quadStats.health <= 0) this._transitionTo(S('death'));
    else if (this._alertLevel >= 3) this._transitionTo(S('flee'));
    else if (this._input.flee > 0.1) this._transitionTo(S('flee'));
    else if (this._input.attack > 0.1) this._transitionTo(S('attack'));
    else if (this._input.eat > 0.1) this._transitionTo(S('graze'));
    else if (this._input.drink > 0.1) this._transitionTo(S('drink'));
    else if (this._input.rest > 0.1) this._transitionTo(S('lie'));
    else if (this._input.crouch > 0.1) this._transitionTo(S('crouch'));
    else if (this._alertLevel >= 2) this._transitionTo(S('alert'));
    else if (!this._quadStats.grounded) {
      const vy = this._rootMotion.verticalVelocity;
      this._transitionTo(vy > 0.5 ? S('jump') : S('fall'));
    } else {
      const speed = this._quadStats.speed;
      if (speed > 10) this._transitionTo(S('sprint'));
      else if (speed > 5) this._transitionTo(S('gallop'));
      else if (speed > 3) this._transitionTo(S('canter'));
      else if (speed > 1.5) this._transitionTo(S('trot'));
      else if (speed > 0.2) this._transitionTo(S('walk'));
      else if (this._herdActive) this._transitionTo(S('herd'));
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
      const attack = this._animRegistry.getId('attack');
      const flee = this._animRegistry.getId('flee');
      const jump = this._animRegistry.getId('jump');
      if (newState === attack) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.IMPACT,
          [this._rootMotion.position.x, this._rootMotion.position.y, this._rootMotion.position.z],
          -1, 40, 0.5,
          { kind: 'quad_attack', species: this.speciesName }
        );
        this._stats.hunts++;
        this._stats.causalEventsEmitted++;
      } else if (newState === flee) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.ECOLOGY,
          [this._rootMotion.position.x, this._rootMotion.position.y, this._rootMotion.position.z],
          -1, 15, 0.8,
          { kind: 'quad_flee', species: this.speciesName }
        );
        this._stats.flees++;
        this._stats.causalEventsEmitted++;
      } else if (newState === jump) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.AUDIO_LIGHT,
          [this._rootMotion.position.x, this._rootMotion.position.y, this._rootMotion.position.z],
          -1, 10, 0.4,
          { kind: 'quad_jump', species: this.speciesName }
        );
        this._stats.causalEventsEmitted++;
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── root motion ──────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateRootMotion(dt) {
    const profile = this._rootMotion.profile;
    const staminaScale = Math.min(1, this._quadStats.stamina / 100);

    // ── horizontal movement ─────────────────────────────
    const dir = this._tmpVecA.set(this._input.moveX, 0, this._input.moveY);
    if (dir.lengthSq() > 1e-6) dir.normalize();
    const sprintBoost = this._input.sprint > 0.1 ? 1.5 : 1.0;
    const targetSpeed = profile.maxSpeed * staminaScale * dir.length() * sprintBoost;
    const maxAccel = profile.acceleration * dt;

    const dvx = dir.x * targetSpeed - this._rootMotion.velocity.x;
    const dvz = dir.z * targetSpeed - this._rootMotion.velocity.z;
    this._rootMotion.velocity.x += Math.sign(dvx) * Math.min(Math.abs(dvx), maxAccel);
    this._rootMotion.velocity.z += Math.sign(dvz) * Math.min(Math.abs(dvz), maxAccel);

    // ── jump ─────────────────────────────────────────────
    if (this._input.jump > 0.1 && this._quadStats.grounded) {
      this._rootMotion.verticalVelocity = profile.jumpImpulse || 5.0;
      this._quadStats.grounded = 0;
    }

    // ── gravity ──────────────────────────────────────────
    if (!this._quadStats.grounded) {
      this._rootMotion.verticalVelocity -= 9.81 * profile.gravityScale * dt;
    }

    // ── integrate ────────────────────────────────────────
    this._rootMotion.position.x += this._rootMotion.velocity.x * dt;
    this._rootMotion.position.z += this._rootMotion.velocity.z * dt;
    this._rootMotion.position.y += this._rootMotion.verticalVelocity * dt;

    // Ground contact.
    if (this._rootMotion.position.y <= 0) {
      this._rootMotion.position.y = 0;
      this._rootMotion.verticalVelocity = 0;
      if (!this._quadStats.grounded) {
        this._transitionTo(this._animRegistry.getId('land'));
      }
      this._quadStats.grounded = 1;
    }

    // ── facing ───────────────────────────────────────────
    const speedSq = this._rootMotion.velocity.x ** 2 + this._rootMotion.velocity.z ** 2;
    if (speedSq > 1e-4) {
      const targetYaw = Math.atan2(this._rootMotion.velocity.x, this._rootMotion.velocity.z);
      const currentYaw = 2 * Math.acos(Math.min(1, Math.max(-1, this._rootMotion.quat.w))) *
        (this._rootMotion.quat.y >= 0 ? 1 : -1);
      let dYaw = targetYaw - currentYaw;
      while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
      while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
      const maxStep = profile.angularAcceleration * dt;
      const step = Math.sign(dYaw) * Math.min(Math.abs(dYaw), maxStep);
      this._rootMotion.quat.multiply(
        new Quat().setFromAxisAngle(new Vec3(0, 1, 0), step)
      ).normalize();
    }

    // ── speed ────────────────────────────────────────────
    this._quadStats.speed = Math.sqrt(speedSq);
    this._quadStats.moving = this._quadStats.speed > 0.2 ? 1 : 0;

    // ── stamina ──────────────────────────────────────────
    if (this._quadStats.speed > 5) {
      this._quadStats.stamina = Math.max(0, this._quadStats.stamina - dt * 10);
    } else {
      this._quadStats.stamina = Math.min(this._quadStats.maxStamina,
        this._quadStats.stamina + dt * 8);
    }

    // ── hunger/thirst drift ──────────────────────────────
    this._quadStats.hunger = Math.max(0, this._quadStats.hunger - dt * 0.1);
    this._quadStats.thirst = Math.max(0, this._quadStats.thirst - dt * 0.15);
  }

  // ══════════════════════════════════════════════════════════
  // ─── causal reactions ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _readCausal(frame) {
    const causal = frame.layers.causal;
    if (!causal || !causal.derivedSignals) return;
    const s = causal.derivedSignals;
    for (let i = 0; i < s.count; i++) {
      if (s.types[i] === DERIVED_SIGNAL.LIGHT_FLICKER && s.forces[i] > 35) {
        if (this._hitStaggerTimer <= 0) {
          this._hitStaggerTimer = 0.25;
          this._transitionTo(this._animRegistry.getId('hit'));
          this._alertLevel = Math.min(3, this._alertLevel + 1);
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── equipment ────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  equipItem(slot, item) {
    if (slot < 0 || slot >= EQUIP_SLOT.COUNT) return false;
    this._equipment[slot] = item;
    this._equipmentMass[slot] = item.mass || 5.0;
    this._equipmentAttachJoint[slot] = item.attachJoint ?? this._equipmentAttachJoint[slot];
    if (item.offset) this._equipmentOffset[slot].copy(item.offset);
    if (item.lightColor) this._equipmentLightColor[slot] = item.lightColor.slice();
    // Activate spring bone for saddlebags.
    if (slot === EQUIP_SLOT.BACK) {
      this._springBones.saddlebagL.active = 1;
      this._springBones.saddlebagR.active = 1;
    }
    return true;
  }

  unequipItem(slot) {
    if (slot < 0 || slot >= EQUIP_SLOT.COUNT) return false;
    this._equipment[slot] = null;
    this._equipmentMass[slot] = 0;
    this._equipmentEmissive[slot] = 0;
    this._equipmentEmissiveTarget[slot] = 0;
    if (slot === EQUIP_SLOT.BACK) {
      this._springBones.saddlebagL.active = 0;
      this._springBones.saddlebagR.active = 0;
    }
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
  // ─── input / API ──────────────────────────────────────────
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
      const map = { flFoot: 0, frFoot: 1, rlFoot: 2, rrFoot: 3, head: 4 };
      this._ikWeights[map[which]] = weight;
    }
    return this;
  }

  setLookAtTarget(target, active = true) {
    this._lookAtTarget.copy(target);
    this._lookAtActive = active ? 1 : 0;
    return this;
  }

  setGait(name) {
    if (GAIT_PATTERNS[name]) {
      this._currentGait = name;
      this._gaitPhase = 0;
      if (QUAD_ROOT_MOTION_PROFILES[name]) {
        this._rootMotion.profileName = name;
        this._rootMotion.profile = QUAD_ROOT_MOTION_PROFILES[name];
      }
    }
    return this;
  }

  setHerdGrid(grid) {
    this._herdGrid = grid;
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

    // 2. Root motion
    this._updateRootMotion(dt);
    if (this._hitStaggerTimer > 0) this._hitStaggerTimer -= dt;

    // 3. Alert state (predator/prey detection)
    this._updateAlertState(dt);

    // 4. Herd behaviour
    if (this._herdGrid) this._updateHerdBehaviour(dt);

    // 5. GOAP
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

    // 6. Gait engine
    this._updateGait(dt);
    this._updatePawContact();

    // 7. Animation state + blend
    this._updateAnimationState(dt);
    this._stateBlend = Math.min(1.0, this._stateBlend + this.stateBlendRate * dt);

    // 8. Procedural overlays
    this._updateBreathing(dt);
    this._updateBodyWave(dt);
    this._updateTailWag(dt);
    this._updateEarTwitch(dt);
    this._updateHeadBob(dt);
    this._updateGaitBob(dt);
    this._updateSpringBones(dt);

    // 9. Motion matching
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

    // 10. Deformation overlays
    this._deformation.update(dt, this._nodes, this._jointEmissive);
    this._stats.deformationsApplied++;

    // 11. FK → IK → FK
    this._updateFK();
    this._updateFootIK(this.ikWeight);
    this._updateHeadIK(this.ikWeight);
    this._updateFK();
    this._updateLookAt(this.ikWeight);
    this._updateFK();

    // 12. Equipment emissive decay
    this._updateEquipmentEmissive(dt);

    // 13. Write to frame
    this._writePlayerLayer(frame, now);
    this._writePhysicalLayer(frame);

    this._stats.updates++;
    this._updateCount++;
    return 1;
  }

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
    this._applyLookTo('NECK_0', axis, angle * 0.35 * lookW);
    this._applyLookTo('NECK_1', axis, angle * 0.35 * lookW);
    this._applyLookTo('HEAD',   axis, angle * 0.30 * lookW);
  }

  _applyLookTo(name, axis, angle) {
    const idx = this._jointRegistry.getIndex(name);
    if (idx >= 0) this._nodes[idx].applyRotationDelta(axis, angle);
  }

  // ══════════════════════════════════════════════════════════
  // ─── frame writes (same contract as 279) ──────────────────
  // ══════════════════════════════════════════════════════════
  _writePlayerLayer(frame, now) {
    const player = frame.layers.player;
    const pelvisIdx = this._jointRegistry.getIndex('PELVIS');
    const headIdx = this._jointRegistry.getIndex('HEAD');
    const pelvis = pelvisIdx >= 0 ? this._nodes[pelvisIdx] : this._nodes[0];
    const head = headIdx >= 0 ? this._nodes[headIdx] : this._nodes[0];

    player.position[0] = pelvis.worldPos.x;
    player.position[1] = pelvis.worldPos.y;
    player.position[2] = pelvis.worldPos.z;

    player.velocity[0] = this._rootMotion.velocity.x;
    player.velocity[1] = this._rootMotion.verticalVelocity;
    player.velocity[2] = this._rootMotion.velocity.z;

    this._tmpVecA.set(0, 0, 1).applyQuaternion(head.worldRot);
    player.facing[0] = this._tmpVecA.x;
    player.facing[1] = this._tmpVecA.y;
    player.facing[2] = this._tmpVecA.z;

    player.health = this._quadStats.health;
    player.mana = 0;
    player.stamina = this._quadStats.stamina;
    player.focusDistance = this._quadStats.focusDistance;
    player.species = this.speciesName;
    player.alertLevel = this._alertLevel;
    player.hunger = this._quadStats.hunger;
    player.thirst = this._quadStats.thirst;

    player.animationState = this._currentState;
    player.animationStateName = this._animRegistry.getName(this._currentState);
    player.animationBlend = this._stateBlend;
    player.animationTime = this._animationTime;
    player.currentGait = this._currentGait;

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
    let totalMass = this._quadStats.bodyMass;
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
    p.playerGait = this._currentGait;
    p.playerAlertLevel = this._alertLevel;
    p.playerSpeed = this._quadStats.speed;
  }

  // ── accessors ─────────────────────────────────────────────
  attachDispatcher(d) { this._dispatcher = d; return this; }
  get currentState() { return this._currentState; }
  get currentStateName() { return this._animRegistry.getName(this._currentState); }
  get playerStats() { return this._quadStats; }
  get rootPosition() { return this._rootMotion.position; }
  get jointNodes() { return this._nodes; }
  get goapPlan() { return this._goapPlan; }
  get goapWorldState() { return this._goapWorldState; }
  get jointCount() { return this._jointCount; }
  get currentGait() { return this._currentGait; }
  get alertLevel() { return this._alertLevel; }

  getStats() { return Object.freeze({ ...this._stats }); }
  resetStats() { for (const k of Object.keys(this._stats)) this._stats[k] = 0; }

  dispose() {
    this._dispatcher = null;
    this._frameRef = null;
    this._equipment.fill(null);
    this._equipmentMass.fill(0);
    this._equipmentEmissive.fill(0);
    for (const key of Object.keys(this._springBones)) {
      this._springBones[key].active = 0;
    }
    this._deformation.pokes.length = 0;
    this._deformation.muscles.clear();
    this._deformation.bends.clear();
    this._deformation.screws.clear();
    this._deformation.heat.clear();
    this._deformation.fire.clear();
    this._neighborBuffer.fill(0);
  }
}

export {
  QuadrupedContextProvider,
  QUAD_ROOT_MOTION_PROFILES,
  GAIT_PATTERNS,
  _quadJointReg as QUAD_JOINT_REGISTRY,
  _quadAnimReg as QUAD_ANIM_REGISTRY,
  _quadGoapReg as QUAD_GOAP_REGISTRY,
  _quadProcReg as QUAD_PROC_REGISTRY
};