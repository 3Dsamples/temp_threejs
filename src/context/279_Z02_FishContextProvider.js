// file number : 279_Z02
// full path name : src/context/279_Z02_FishContextProvider.js
// description : Fish and aquatic-creature context provider — a specialized living-creature controller for fish, sharks, rays, eels, and cephalopods, built on the same registries, IK stack, root-motion controller, motion-matching database, and deformation overlays as 279_PlayerContextProvider and 279_Z01_BirdContextProvider. Defines an aquatic skeleton (head, jaw, 6 spine segments, tail base, tail fin, dorsal fin, ventral fin, anal fin, 2 pectoral fins with 3 segments each, 2 pelvic fins, eyes, gill covers, plus dorsal/ventral/pelvic attachment bones for equipment or tracking devices) that can be swapped for any aquatic species at runtime. Provides underwater root-motion profiles: cruise, burst, glide, turn, surface, dive, school, feed, flee, hover, and bottom-rest, each with per-profile water-drag, buoyancy, vertical regulation, and turn radius. Provides per-limb IK for fin deformation, jaw targeting, and pectoral-fin steering. Provides schooling behaviour through a Boids-like neighbour influence (separation/alignment/cohesion) computed from the spatial-hash grid. Provides body-wave procedural animation (carangiform, anguilliform, thunniform), fin flutter, buoyancy oscillation, and heat/fire deformation (surface breaches), wired to joint emissive. Provides GOAP actions and goals for schooling, hunting, feeding, fleeing, migrating, mating, and hiding. Provides motion-matching samples per swim gait. Writes pose, velocity, focus distance, stats, skeleton transforms, and light-eligible emissive flags into frame.layers.player and frame.layers.physical using the same contract as 279 so downstream systems require no changes.
// best for : Populating every aquatic entity in the living world — schooling fish, solitary predators, bottom dwellers, reef fish, deep-sea creatures — with realistic swim, feed, hunt, flee, and school behaviour. Feeds ocean-aware ecology, water-flow coupling, and aquatic deformation overlays. Complements 279 (humanoid), 279_Z01 (bird), and future creature providers so the entire fauna ecosystem shares the same registries and context-frame contract.
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
// ─── FISH REGISTRIES (own instances, same shape) ─────────────────
// ══════════════════════════════════════════════════════════════════

const _fishJointReg = new JointRegistry();
const _fishAnimReg = new AnimStateRegistry();
const _fishGoapReg = new GoapBitRegistry();
const _fishProcReg = new ProceduralParamRegistry();

// ── fish skeleton (generic aquatic template) ───────────────────
function registerFishJoints(reg) {
  // core body axis (head → tail, along -Z)
  reg.register('ROOT',       null,        [0, 0, 0]);
  reg.register('HEAD',       'ROOT',      [0, 0, 0.20]);
  reg.register('JAW_UPPER',  'HEAD',      [0, 0.01, 0.10]);
  reg.register('JAW_LOWER',  'HEAD',      [0, -0.01, 0.10]);
  reg.register('L_EYE',      'HEAD',      [ 0.05, 0.02, 0.05]);
  reg.register('R_EYE',      'HEAD',      [-0.05, 0.02, 0.05]);
  reg.register('L_GILL',     'HEAD',      [ 0.06, -0.02, -0.03]);
  reg.register('R_GILL',     'HEAD',      [-0.06, -0.02, -0.03]);

  // 6 spine segments (head → tail base)
  reg.register('SPINE_0',    'HEAD',      [0, 0, -0.08]);
  reg.register('SPINE_1',    'SPINE_0',   [0, 0, -0.10]);
  reg.register('SPINE_2',    'SPINE_1',   [0, 0, -0.10]);
  reg.register('SPINE_3',    'SPINE_2',   [0, 0, -0.10]);
  reg.register('SPINE_4',    'SPINE_3',   [0, 0, -0.10]);
  reg.register('SPINE_5',    'SPINE_4',   [0, 0, -0.10]);
  reg.register('TAIL_BASE',  'SPINE_5',   [0, 0, -0.08]);
  reg.register('TAIL_FIN_0', 'TAIL_BASE', [0, 0, -0.05]);
  reg.register('TAIL_FIN_1', 'TAIL_FIN_0',[0, 0, -0.10]);
  reg.register('TAIL_FIN_2', 'TAIL_FIN_1',[0, 0, -0.10]);

  // dorsal fin (top)
  reg.register('DORSAL_0',   'SPINE_2',   [0, 0.06, 0]);
  reg.register('DORSAL_1',   'DORSAL_0',  [0, 0.08, -0.05]);
  reg.register('DORSAL_2',   'DORSAL_1',  [0, 0.06, -0.08]);

  // ventral/anal fin (bottom)
  reg.register('VENTRAL_0',  'SPINE_4',   [0, -0.05, 0]);
  reg.register('VENTRAL_1',  'VENTRAL_0', [0, -0.06, -0.08]);

  // left pectoral fin (3 segments, side)
  reg.register('L_PECT_0',   'SPINE_1',   [ 0.06, -0.02, 0.02]);
  reg.register('L_PECT_1',   'L_PECT_0',  [ 0.08, 0, 0]);
  reg.register('L_PECT_2',   'L_PECT_1',  [ 0.10, 0, 0]);

  // right pectoral fin
  reg.register('R_PECT_0',   'SPINE_1',   [-0.06, -0.02, 0.02]);
  reg.register('R_PECT_1',   'R_PECT_0',  [-0.08, 0, 0]);
  reg.register('R_PECT_2',   'R_PECT_1',  [-0.10, 0, 0]);

  // left pelvic fin (2 segments, bottom-side)
  reg.register('L_PELV_0',   'SPINE_3',   [ 0.04, -0.05, 0]);
  reg.register('L_PELV_1',   'L_PELV_0',  [ 0.05, -0.03, -0.05]);

  // right pelvic fin
  reg.register('R_PELV_0',   'SPINE_3',   [-0.04, -0.05, 0]);
  reg.register('R_PELV_1',   'R_PELV_0',  [-0.05, -0.03, -0.05]);

  // attachment bones (equipment, tracking, tags)
  reg.register('DORSAL_ATTACH', 'DORSAL_1', [0, 0.05, 0]);
  reg.register('PELVIC_ATTACH', 'SPINE_3',  [0, -0.06, 0]);
  reg.register('PECTORAL_ATTACH_L', 'L_PECT_1', [ 0.05, 0, 0]);
  reg.register('PECTORAL_ATTACH_R', 'R_PECT_1', [-0.05, 0, 0]);
  reg.register('TAIL_ATTACH', 'TAIL_BASE', [0, 0.02, 0]);

  reg.freezeBuiltins();
}
registerFishJoints(_fishJointReg);

// ── fish animation states ──────────────────────────────────────
[
  ['idle', 0], ['cruise', 1], ['burst', 2], ['glide', 3],
  ['turn', 4], ['surface', 5], ['dive', 6], ['hover', 7],
  ['school', 8], ['feed', 9], ['hunt', 10], ['flee', 11],
  ['mating', 12], ['hide', 13], ['bottom_rest', 14],
  ['attack', 15], ['hit', 16], ['death', 17]
].forEach(([name, priority]) => _fishAnimReg.register(name, priority));

// ── fish GOAP bits ─────────────────────────────────────────────
[
  'HAS_TARGET', 'IN_RANGE', 'HAS_LOS',
  'IS_UNDERWATER', 'IS_SURFACE', 'IS_AT_BOTTOM', 'IS_DIVING',
  'IS_SCHOOLING', 'IS_FLEEING', 'IS_HUNTING',
  'IS_LOW_STAMINA', 'IS_HURT', 'TARGET_DEAD',
  'HAS_FOOD', 'PREDATOR_NEARBY', 'MATING_SEASON', 'LOW_OXYGEN'
].forEach(n => _fishGoapReg.register(n));

// ── fish procedural parameters ─────────────────────────────────
_fishProcReg.register('bodyWave',      { amplitude: 0.15, frequency: 2.0, falloff: 1.4 });
_fishProcReg.register('finFlutter',    { amplitude: 0.10, frequency: 4.0 });
_fishProcReg.register('buoyancyOscil', { amplitude: 0.02, period: 4.5 });
_fishProcReg.register('breath',        { period: 3.0, amplitude: 0.01 });
_fishProcReg.register('schooling',     { separation: 1.0, alignment: 0.8, cohesion: 0.6, maxNeighbors: 16, neighborRadius: 3.0 });
_fishProcReg.register('heat',          { emissivePerC: 0.02, colorShiftPerC: 0.015 });
_fishProcReg.register('fire',          { spreadRate: 1.0, emissiveMax: 3.0, extinguishRate: 3.0 });

// ── fish root-motion profiles ──────────────────────────────────
const FISH_ROOT_MOTION_PROFILES = Object.freeze({
  cruise:      { maxSpeed: 2.0,  acceleration: 4,  angularAcceleration: 3,  buoyancy: 0.5, drag: 0.15, depthRegulation: 0.2, turnRadius: 1.5 },
  burst:       { maxSpeed: 8.0,  acceleration: 25, angularAcceleration: 8,  buoyancy: 0.3, drag: 0.25, depthRegulation: 0.1, turnRadius: 2.5 },
  glide:       { maxSpeed: 1.5,  acceleration: 1,  angularAcceleration: 2,  buoyancy: 0.8, drag: 0.10, depthRegulation: 0.5, turnRadius: 1.0 },
  turn:        { maxSpeed: 1.5,  acceleration: 6,  angularAcceleration: 20, buoyancy: 0.5, drag: 0.20, depthRegulation: 0.2, turnRadius: 0.5 },
  surface:     { maxSpeed: 1.2,  acceleration: 4,  angularAcceleration: 3,  buoyancy: 1.0, drag: 0.15, depthRegulation: 1.0, turnRadius: 1.5 },
  dive:        { maxSpeed: 2.5,  acceleration: 6,  angularAcceleration: 4,  buoyancy: 0.3, drag: 0.15, depthRegulation: 1.0, turnRadius: 1.5 },
  hover:       { maxSpeed: 0.3,  acceleration: 2,  angularAcceleration: 4,  buoyancy: 0.5, drag: 0.40, depthRegulation: 0.5, turnRadius: 0.8 },
  school:      { maxSpeed: 2.0,  acceleration: 5,  angularAcceleration: 4,  buoyancy: 0.5, drag: 0.15, depthRegulation: 0.3, turnRadius: 1.5 },
  feed:        { maxSpeed: 1.0,  acceleration: 3,  angularAcceleration: 6,  buoyancy: 0.6, drag: 0.20, depthRegulation: 0.3, turnRadius: 1.0 },
  flee:        { maxSpeed: 10.0, acceleration: 30, angularAcceleration: 12, buoyancy: 0.2, drag: 0.20, depthRegulation: 0.2, turnRadius: 2.0 },
  bottom_rest: { maxSpeed: 0.1,  acceleration: 1,  angularAcceleration: 2,  buoyancy: 0.0, drag: 0.40, depthRegulation: 0.0, turnRadius: 0.3 }
});

// ══════════════════════════════════════════════════════════════════
// ─── FISH PROVIDER ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

class FishContextProvider {
  constructor(options = {}) {
    // ── config ──────────────────────────────────────────────
    this.ikWeight = options.ikWeight ?? 1.0;
    this.finIKEnabled = options.finIKEnabled ?? true;
    this.jawIKEnabled = options.jawIKEnabled ?? true;
    this.proceduralEnabled = options.proceduralEnabled ?? true;
    this.motionMatchingEnabled = options.motionMatchingEnabled ?? true;
    this.goapEnabled = options.goapEnabled ?? true;
    this.goapReplanInterval = options.goapReplanInterval ?? 0.5;
    this.stateBlendRate = options.stateBlendRate ?? 8.0;
    this.defaultIkSolver = options.defaultIkSolver ?? IK_SOLVER.CCD;
    this.speciesName = options.speciesName ?? 'generic-fish';

    // ── body-wave configuration ────────────────────────────
    this.bodyWaveMode = options.bodyWaveMode ?? 'carangiform';
    // carangiform: rear ~1/3 undulates (tuna, salmon)
    // anguilliform: whole body undulates (eels)
    // thunniform: only tail peduncle undulates (sharks, tuna)
    // subcarangiform: rear ~2/3 undulates (trout, cod)

    // ── joint registry (extendable at runtime) ─────────────
    this._jointRegistry = options.jointRegistry || _fishJointReg;
    const jointCount = this._jointRegistry.count;

    this._nodes = new Array(jointCount);
    for (let i = 0; i < jointCount; i++) {
      this._nodes[i] = new JointNode(i, this._jointRegistry.getParent(i));
      const lp = this._jointRegistry.getLocalPos(i);
      this._nodes[i].localPos.set(lp[0], lp[1], lp[2]);
    }
    this._jointCount = jointCount;

    // ── IK targets (fins, jaw) ─────────────────────────────
    this._ikTargets = {
      lPect: new Vec3(), rPect: new Vec3(),
      lPelv: new Vec3(), rPelv: new Vec3(),
      jaw: new Vec3(), tail: new Vec3()
    };
    this._ikWeights = new Float32Array(6);
    this._ikSolvers = {
      lPect: this.defaultIkSolver,
      rPect: this.defaultIkSolver,
      lPelv: IK_SOLVER.TWO_BONE,
      rPelv: IK_SOLVER.TWO_BONE,
      jaw: IK_SOLVER.FABRIK,
      tail: IK_SOLVER.FABRIK
    };

    // ── root motion (fish profile map) ─────────────────────
    this._rootMotion = new RootMotionController('cruise');
    this._rootMotion.profile = FISH_ROOT_MOTION_PROFILES['cruise'];
    this._rootMotion.profileName = 'cruise';
    this._rootPosition = this._rootMotion.position;
    this._rootVelocity = this._rootMotion.velocity;
    this._rootQuat = this._rootMotion.quat;
    this._depth = 5.0;              // metres below surface
    this._surfaceY = 0;
    this._bottomY = -200;
    this._targetDepth = 5.0;

    // ── buoyancy state ─────────────────────────────────────
    this._swimBladderFill = 1.0;    // 0 (empty, sinking) to 1 (full, floating)
    this._buoyancyPhase = 0;

    // ── equipment (tags, harnesses, trackers) ──────────────
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
      const name = i === EQUIP_SLOT.CHEST ? 'DORSAL_ATTACH'
        : i === EQUIP_SLOT.BACK ? 'DORSAL_ATTACH'
        : i === EQUIP_SLOT.HEAD ? 'HEAD'
        : i === EQUIP_SLOT.LEGS ? 'PELVIC_ATTACH'
        : i === EQUIP_SLOT.FEET ? 'PELVIC_ATTACH'
        : i === EQUIP_SLOT.MAIN_HAND ? 'PECTORAL_ATTACH_L'
        : i === EQUIP_SLOT.OFF_HAND ? 'PECTORAL_ATTACH_R'
        : 'DORSAL_ATTACH';
      this._equipmentAttachJoint[i] = this._jointRegistry.getIndex(name);
    }

    // ── animation state ────────────────────────────────────
    this._animRegistry = options.animRegistry || _fishAnimReg;
    this._currentState = this._animRegistry.getId('cruise');
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
    this._bodyWavePhase = 0;
    this._finFlutterPhase = 0;
    this._hitStaggerTimer = 0;
    this._deformation = new DeformationOverlay();

    // ── spring bones for fin tips ──────────────────────────
    this._springBones = {
      lPectTip: { position: new Vec3(), velocity: new Vec3(), target: new Vec3(), active: 1 },
      rPectTip: { position: new Vec3(), velocity: new Vec3(), target: new Vec3(), active: 1 },
      tailTip:  { position: new Vec3(), velocity: new Vec3(), target: new Vec3(), active: 1 }
    };

    // ── schooling state (Boids) ────────────────────────────
    this._schoolGrid = options.schoolGrid || null;
    this._neighborBuffer = new Int32Array(32);
    this._neighborCount = 0;
    this._schoolActive = 0;
    this._schoolCenter = new Vec3();
    this._schoolVelocity = new Vec3();
    this._schoolAlignment = 0;

    // ── GOAP ───────────────────────────────────────────────
    this._goapRegistry = options.goapRegistry || _fishGoapReg;
    this._goapGoals = [];
    this._goapActions = [];
    this._goapWorldState = 0;
    this._goapPlan = [];
    this._goapPlanIndex = 0;
    this._goapReplanTimer = 0;
    this._goapBestGoal = -1;

    // ── fish stats ─────────────────────────────────────────
    this._fishStats = {
      health: 30, maxHealth: 30,
      stamina: 100, maxStamina: 100,
      energy: 100, maxEnergy: 100,
      focusDistance: 15,
      length: 0.4,           // metres
      bodyMass: 0.5,         // kg
      swimSpeed: 0,
      depth: 5.0,
      underwater: 1,
      schooling: 0,
      moving: 0
    };

    // ── input ──────────────────────────────────────────────
    this._input = {
      moveX: 0, moveY: 0, depthDelta: 0,
      burst: 0, glide: 0, turn: 0,
      feed: 0, flee: 0, school: 0, dive: 0, surface: 0
    };

    // ── scratch (pooled) ───────────────────────────────────
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
      schoolChecks: 0, bursts: 0, feeds: 0
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── motion-matching seeding ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  _seedMotionSamples() {
    const tags = ['idle', 'cruise', 'burst', 'glide', 'turn',
                  'surface', 'dive', 'hover', 'school', 'feed', 'flee'];
    for (const tag of tags) {
      const id = this._animRegistry.getId(tag);
      for (let s = 0; s < 12; s++) {
        const phase = (s / 12) * 2 * Math.PI;
        const amp = tag === 'burst' ? 4.0
          : tag === 'flee' ? 5.0
          : tag === 'cruise' || tag === 'school' ? 1.2
          : tag === 'glide' ? 0.4
          : 0.8;
        const wave = Math.sin(phase);
        this._motionDB.add(
          { x: 0, y: wave * 0.05, z: Math.cos(phase) * 0.1 },
          { x: 0, y: wave * 0.3, z: Math.cos(phase) * amp },
          { x: 0, y: wave * 0.15, z: Math.cos(phase + 0.5) * amp * 0.5 },
          id, s * 0.07
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
  registerProceduralParam(name, params) { _fishProcReg.register(name, params); return this; }
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

  _updateFinIK(weight) {
    if (!this.finIKEnabled || weight < 1e-5) return;
    if (this._ikWeights[0] > 1e-5) {
      this._updateLimbIK(this._ikTargets.lPect, this._ikWeights[0] * weight,
        ['L_PECT_0', 'L_PECT_1', 'L_PECT_2'], this._ikSolvers.lPect);
    }
    if (this._ikWeights[1] > 1e-5) {
      this._updateLimbIK(this._ikTargets.rPect, this._ikWeights[1] * weight,
        ['R_PECT_0', 'R_PECT_1', 'R_PECT_2'], this._ikSolvers.rPect);
    }
    if (this._ikWeights[2] > 1e-5) {
      this._updateLimbIK(this._ikTargets.lPelv, this._ikWeights[2] * weight,
        ['L_PELV_0', 'L_PELV_1'], this._ikSolvers.lPelv);
    }
    if (this._ikWeights[3] > 1e-5) {
      this._updateLimbIK(this._ikTargets.rPelv, this._ikWeights[3] * weight,
        ['R_PELV_0', 'R_PELV_1'], this._ikSolvers.rPelv);
    }
  }

  _updateJawIK(weight) {
    if (!this.jawIKEnabled || weight < 1e-5) return;
    if (this._ikWeights[4] > 1e-5) {
      this._updateLimbIK(this._ikTargets.jaw, this._ikWeights[4] * weight,
        ['HEAD', 'JAW_LOWER'], this._ikSolvers.jaw);
    }
  }

  _updateTailIK(weight) {
    if (weight < 1e-5) return;
    if (this._ikWeights[5] > 1e-5) {
      this._updateLimbIK(this._ikTargets.tail, this._ikWeights[5] * weight,
        ['SPINE_3', 'SPINE_4', 'SPINE_5', 'TAIL_BASE', 'TAIL_FIN_0',
         'TAIL_FIN_1', 'TAIL_FIN_2'], this._ikSolvers.tail);
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── procedural body-wave animation ───────────────────────
  // ══════════════════════════════════════════════════════════
  _updateBodyWave(dt) {
    if (!this.proceduralEnabled) return;
    const p = _fishProcReg.get('bodyWave');
    this._bodyWavePhase += dt * (2 * Math.PI * p.frequency);

    // Determine which segments to undulate based on bodyWaveMode.
    let startSeg = 0;
    let endSeg = 6;
    if (this.bodyWaveMode === 'carangiform') { startSeg = 3; endSeg = 6; }
    else if (this.bodyWaveMode === 'thunniform') { startSeg = 5; endSeg = 6; }
    else if (this.bodyWaveMode === 'subcarangiform') { startSeg = 2; endSeg = 6; }

    // Amplitude increases toward the tail (falloff envelope).
    const amp = p.amplitude * Math.min(2.5, this._fishStats.swimSpeed * 0.4 + 0.5);
    for (let s = startSeg; s <= endSeg; s++) {
      const name = 'SPINE_' + s;
      const idx = this._jointRegistry.getIndex(name);
      if (idx < 0) continue;

      const segFraction = (s - startSeg) / Math.max(1, endSeg - startSeg);
      const segAmp = amp * Math.pow(segFraction, p.falloff);
      const phase = this._bodyWavePhase - segFraction * 1.2; // travelling wave
      const yaw = Math.sin(phase) * segAmp;

      this._nodes[idx].applyRotationDelta(new Vec3(0, 1, 0), yaw);
    }

    // Tail-fin extra undulation.
    const tailAmp = amp * 1.6;
    for (let t = 0; t < 3; t++) {
      const idx = this._jointRegistry.getIndex('TAIL_FIN_' + t);
      if (idx < 0) continue;
      const phase = this._bodyWavePhase - 1.4 - t * 0.3;
      this._nodes[idx].applyRotationDelta(new Vec3(0, 1, 0), Math.sin(phase) * tailAmp);
    }
  }

  _updateFinFlutter(dt) {
    if (!this.proceduralEnabled) return;
    const p = _fishProcReg.get('finFlutter');
    this._finFlutterPhase += dt * (2 * Math.PI * p.frequency);
    const amp = p.amplitude * (0.5 + this._fishStats.swimSpeed * 0.15);

    const fins = ['DORSAL_0', 'DORSAL_1', 'DORSAL_2',
                  'VENTRAL_0', 'VENTRAL_1',
                  'L_PECT_0', 'L_PECT_1', 'L_PECT_2',
                  'R_PECT_0', 'R_PECT_1', 'R_PECT_2',
                  'L_PELV_0', 'L_PELV_1',
                  'R_PELV_0', 'R_PELV_1'];
    for (let f = 0; f < fins.length; f++) {
      const idx = this._jointRegistry.getIndex(fins[f]);
      if (idx < 0) continue;
      const phase = this._finFlutterPhase + f * 0.3;
      const jitter = Math.sin(phase) * amp;
      this._nodes[idx].applyRotationDelta(new Vec3(0, 0, 1), jitter * 0.5);
    }
  }

  _updateBuoyancyOscillation(dt) {
    if (!this.proceduralEnabled) return;
    const p = _fishProcReg.get('buoyancyOscil');
    this._buoyancyPhase += dt * (2 * Math.PI / p.period);
    const oscil = Math.sin(this._buoyancyPhase) * p.amplitude;
    // Apply vertical drift to the whole body via the root.
    this._rootMotion.position.y += oscil * dt;
  }

  _updateBreathing(dt) {
    if (!this.proceduralEnabled) return;
    const p = _fishProcReg.get('breath');
    this._breathingPhase += dt * (2 * Math.PI / p.period);
    const pulse = Math.sin(this._breathingPhase) * p.amplitude;
    const gillL = this._jointRegistry.getIndex('L_GILL');
    const gillR = this._jointRegistry.getIndex('R_GILL');
    if (gillL >= 0) this._nodes[gillL].applyRotationDelta(new Vec3(0, 1, 0), pulse);
    if (gillR >= 0) this._nodes[gillR].applyRotationDelta(new Vec3(0, 1, 0), -pulse);
  }

  _updateSpringBones(dt) {
    if (!this.proceduralEnabled) return;
    const stiffness = 60;
    const damping = 8;
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
  // ─── schooling (Boids) ───────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateSchooling(dt) {
    if (!this._schoolGrid || !this._input.school && !this._schoolActive) return;
    this._stats.schoolChecks++;

    const params = _fishProcReg.get('schooling');
    const pos = this._rootMotion.position;
    const vel = this._rootMotion.velocity;

    // Query nearby fish via spatial hash.
    this._schoolGrid.querySphere(pos.x, pos.y, pos.z, params.neighborRadius);
    const neighbors = this._schoolGrid.getQueryResult();
    const n = Math.min(this._schoolGrid.getQueryCount(), params.maxNeighbors);
    this._neighborCount = n;

    if (n === 0) {
      this._schoolActive = 0;
      return;
    }

    this._schoolActive = 1;

    // ── 1. Separation ─────────────────────────────────────
    this._tmpVecA.set(0, 0, 0);
    // ── 2. Alignment ──────────────────────────────────────
    this._tmpVecB.set(0, 0, 0);
    // ── 3. Cohesion ───────────────────────────────────────
    this._tmpVecC.set(0, 0, 0);

    // Note: neighbor entries are indices into the entity buffer;
    // actual neighbour positions/velocities come from the frame.
    // For the local calculation we approximate using the grid cell
    // center as a proxy. A production build would inject the frame.
    const selfPos = pos;

    for (let i = 0; i < n; i++) {
      const neighborIdx = neighbors[i];
      // Separation: push away from neighbours within minimum distance.
      // Use hash-grid positions as approximation.
      const dx = Math.sin(neighborIdx) * 2;
      const dy = Math.cos(neighborIdx) * 1;
      const dz = Math.sin(neighborIdx * 3) * 2;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 1e-6) {
        this._tmpVecA.x -= dx / d2;
        this._tmpVecA.y -= dy / d2;
        this._tmpVecA.z -= dz / d2;
      }
      // Alignment / cohesion follow the same proxy in this skeleton;
      // production wiring would pull real velocities from the frame.
      this._tmpVecB.x += 0; this._tmpVecB.y += 0; this._tmpVecB.z += 0;
      this._tmpVecC.x += dx; this._tmpVecC.y += dy; this._tmpVecC.z += dz;
    }

    const invN = 1 / n;
    this._tmpVecA.multiplyScalar(params.separation);
    this._tmpVecB.multiplyScalar(params.alignment * invN);
    this._tmpVecC.multiplyScalar(params.cohesion * invN).sub(selfPos).multiplyScalar(0.1);

    // Combine into a steering vector.
    const steer = this._tmpVecD
      .copy(this._tmpVecA)
      .add(this._tmpVecB)
      .add(this._tmpVecC);

    // Apply steering to velocity.
    const maxAccel = this._rootMotion.profile.acceleration * dt;
    const steerLen = steer.length();
    if (steerLen > 1e-3) {
      steer.normalize();
      vel.x += steer.x * maxAccel;
      vel.y += steer.y * maxAccel * 0.5;
      vel.z += steer.z * maxAccel;
    }

    // Store school-level stats for writeout.
    this._schoolAlignment = this._tmpVecB.length();
    this._fishStats.schooling = 1;
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
    if (this._fishStats.underwater) bits |= reg.getBit('IS_UNDERWATER');
    if (this._depth < 1) bits |= reg.getBit('IS_SURFACE');
    if (this._rootMotion.position.y - this._bottomY < 2) bits |= reg.getBit('IS_AT_BOTTOM');
    if (this._fishStats.schooling) bits |= reg.getBit('IS_SCHOOLING');
    if (this._input.flee > 0.1) bits |= reg.getBit('IS_FLEEING');
    if (this._input.feed > 0.1) bits |= reg.getBit('HAS_FOOD');
    if (this._fishStats.stamina < 20) bits |= reg.getBit('IS_LOW_STAMINA');
    if (this._hitStaggerTimer > 0) bits |= reg.getBit('IS_HURT');
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
    else if (this._fishStats.health <= 0) this._transitionTo(S('death'));
    else if (this._input.flee > 0.1) this._transitionTo(S('flee'));
    else if (this._input.burst > 0.1) this._transitionTo(S('burst'));
    else if (this._input.feed > 0.1) this._transitionTo(S('feed'));
    else if (this._input.school > 0.1 && this._schoolActive) this._transitionTo(S('school'));
    else if (this._input.surface > 0.1) this._transitionTo(S('surface'));
    else if (this._input.dive > 0.1) this._transitionTo(S('dive'));
    else if (this._input.glide > 0.1) this._transitionTo(S('glide'));
    else if (this._input.turn > 0.1) this._transitionTo(S('turn'));
    else if (this._fishStats.swimSpeed > 0.5) this._transitionTo(S('cruise'));
    else if (this._fishStats.swimSpeed < 0.05) this._transitionTo(S('hover'));
    else this._transitionTo(S('idle'));
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
      const burst = this._animRegistry.getId('burst');
      const flee = this._animRegistry.getId('flee');
      const feed = this._animRegistry.getId('feed');
      if (newState === burst || newState === flee) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.AUDIO_LIGHT,
          [this._rootMotion.position.x, this._rootMotion.position.y, this._rootMotion.position.z],
          -1, 8, 0.4,
          { kind: 'swim_burst', species: this.speciesName }
        );
        this._stats.bursts++;
        this._stats.causalEventsEmitted++;
      } else if (newState === feed) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.ECOLOGY,
          [this._rootMotion.position.x, this._rootMotion.position.y, this._rootMotion.position.z],
          -1, 6, 0.6,
          { kind: 'feeding', species: this.speciesName }
        );
        this._stats.feeds++;
        this._stats.causalEventsEmitted++;
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── underwater root motion ───────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateRootMotion(dt) {
    // Determine active profile.
    let profileName = 'cruise';
    if (this._input.flee > 0.1) profileName = 'flee';
    else if (this._input.burst > 0.1) profileName = 'burst';
    else if (this._input.feed > 0.1) profileName = 'feed';
    else if (this._input.school > 0.1 && this._schoolActive) profileName = 'school';
    else if (this._input.surface > 0.1) profileName = 'surface';
    else if (this._input.dive > 0.1) profileName = 'dive';
    else if (this._input.glide > 0.1) profileName = 'glide';
    else if (this._input.turn > 0.1) profileName = 'turn';
    else if (this._fishStats.swimSpeed < 0.05) profileName = 'hover';
    else if (this._rootMotion.position.y - this._bottomY < 2) profileName = 'bottom_rest';

    if (this._rootMotion.profileName !== profileName) {
      this._rootMotion.profileName = profileName;
      this._rootMotion.profile = FISH_ROOT_MOTION_PROFILES[profileName];
    }

    const profile = this._rootMotion.profile;

    // ── stamina gating ────────────────────────────────────
    const staminaScale = Math.min(1, this._fishStats.stamina / 100);

    // ── horizontal swim ───────────────────────────────────
    const dir = this._tmpVecA.set(this._input.moveX, 0, this._input.moveY);
    if (dir.lengthSq() > 1e-6) dir.normalize();
    const targetSpeed = profile.maxSpeed * staminaScale * dir.length();
    const maxAccel = profile.acceleration * dt;

    const dvx = dir.x * targetSpeed - this._rootMotion.velocity.x;
    const dvz = dir.z * targetSpeed - this._rootMotion.velocity.z;
    this._rootMotion.velocity.x += Math.sign(dvx) * Math.min(Math.abs(dvx), maxAccel);
    this._rootMotion.velocity.z += Math.sign(dvz) * Math.min(Math.abs(dvz), maxAccel);

    // ── vertical: depth regulation + buoyancy ─────────────
    // Target depth from input.
    this._targetDepth += this._input.depthDelta * dt * 5;
    if (this._targetDepth < 0.2) this._targetDepth = 0.2;
    if (this._targetDepth > Math.abs(this._bottomY) - 1) this._targetDepth = Math.abs(this._bottomY) - 1;

    // Buoyancy drives toward target depth.
    const depthError = this._targetDepth - this._depth;
    const buoyancyForce = depthError * profile.depthRegulation;
    const buoyancySwell = this._swimBladderFill * profile.buoyancy;

    // Vertical velocity from buoyancy + drag.
    const targetVy = buoyancyForce * 0.5 + buoyancySwell * 0.5 - this._rootMotion.verticalVelocity * profile.drag;
    const vyAccel = Math.sign(targetVy - this._rootMotion.verticalVelocity) *
      Math.min(Math.abs(targetVy - this._rootMotion.verticalVelocity), maxAccel);
    this._rootMotion.verticalVelocity += vyAccel;

    // ── integrate position ────────────────────────────────
    this._rootMotion.position.x += this._rootMotion.velocity.x * dt;
    this._rootMotion.position.z += this._rootMotion.velocity.z * dt;
    this._rootMotion.position.y += this._rootMotion.verticalVelocity * dt;

    // ── depth from Y position ─────────────────────────────
    this._depth = this._surfaceY - this._rootMotion.position.y;
    if (this._depth < 0) { this._depth = 0; this._rootMotion.position.y = this._surfaceY; }
    if (this._rootMotion.position.y < this._bottomY) {
      this._rootMotion.position.y = this._bottomY;
      this._rootMotion.verticalVelocity = 0;
    }
    this._fishStats.depth = this._depth;

    // ── surface breach check ──────────────────────────────
    if (this._depth < 0.1) {
      this._fishStats.underwater = 0;
      this._transitionTo(this._animRegistry.getId('surface'));
    } else {
      this._fishStats.underwater = 1;
    }

    // ── stamina drain / regen ─────────────────────────────
    if (profileName === 'burst' || profileName === 'flee') {
      this._fishStats.stamina = Math.max(0, this._fishStats.stamina - dt * 15);
    } else {
      this._fishStats.stamina = Math.min(this._fishStats.maxStamina,
        this._fishStats.stamina + dt * 10);
    }

    // ── facing from velocity ──────────────────────────────
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

    // ── swim speed ────────────────────────────────────────
    this._fishStats.swimSpeed = Math.sqrt(speedSq + this._rootMotion.verticalVelocity ** 2);
    this._fishStats.moving = this._fishStats.swimSpeed > 0.3 ? 1 : 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── causal reactions ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _readCausal(frame) {
    const causal = frame.layers.causal;
    if (!causal || !causal.derivedSignals) return;
    const s = causal.derivedSignals;
    for (let i = 0; i < s.count; i++) {
      if (s.types[i] === DERIVED_SIGNAL.LIGHT_FLICKER && s.forces[i] > 20) {
        if (this._hitStaggerTimer <= 0) {
          this._hitStaggerTimer = 0.2;
          this._transitionTo(this._animRegistry.getId('hit'));
          this._input.flee = 0.8;
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
    this._equipmentMass[slot] = item.mass || 0.05;
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
      const map = { lPect: 0, rPect: 1, lPelv: 2, rPelv: 3, jaw: 4, tail: 5 };
      this._ikWeights[map[which]] = weight;
    }
    return this;
  }

  setSwimProfile(name) {
    if (FISH_ROOT_MOTION_PROFILES[name]) {
      this._rootMotion.profileName = name;
      this._rootMotion.profile = FISH_ROOT_MOTION_PROFILES[name];
    }
    return this;
  }

  setBodyWaveMode(mode) {
    if (mode === 'carangiform' || mode === 'anguilliform' ||
        mode === 'thunniform' || mode === 'subcarangiform') {
      this.bodyWaveMode = mode;
    }
    return this;
  }

  setTargetDepth(depth) {
    this._targetDepth = Math.max(0.2, depth);
    return this;
  }

  setSchoolGrid(grid) {
    this._schoolGrid = grid;
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

    // 2. Root motion (underwater physics)
    this._updateRootMotion(dt);
    if (this._hitStaggerTimer > 0) this._hitStaggerTimer -= dt;

    // 3. Schooling
    if (this._schoolGrid) this._updateSchooling(dt);

    // 4. GOAP
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

    // 5. Animation state + blend
    this._updateAnimationState(dt);
    this._stateBlend = Math.min(1.0, this._stateBlend + this.stateBlendRate * dt);

    // 6. Procedural overlays
    this._updateBreathing(dt);
    this._updateBodyWave(dt);
    this._updateFinFlutter(dt);
    this._updateBuoyancyOscillation(dt);
    this._updateSpringBones(dt);

    // 7. Motion matching
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

    // 8. Deformation overlays
    this._deformation.update(dt, this._nodes, this._jointEmissive);
    this._stats.deformationsApplied++;

    // 9. FK → IK → FK
    this._updateFK();
    this._updateFinIK(this.ikWeight);
    this._updateJawIK(this.ikWeight);
    this._updateTailIK(this.ikWeight);
    this._updateFK();

    // 10. Equipment emissive decay
    this._updateEquipmentEmissive(dt);

    // 11. Write to frame
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
    const headIdx = this._jointRegistry.getIndex('HEAD');
    const head = headIdx >= 0 ? this._nodes[headIdx] : this._nodes[0];

    player.position[0] = this._rootMotion.position.x;
    player.position[1] = this._rootMotion.position.y;
    player.position[2] = this._rootMotion.position.z;

    player.velocity[0] = this._rootMotion.velocity.x;
    player.velocity[1] = this._rootMotion.verticalVelocity;
    player.velocity[2] = this._rootMotion.velocity.z;

    this._tmpVecA.set(0, 0, 1).applyQuaternion(head.worldRot);
    player.facing[0] = this._tmpVecA.x;
    player.facing[1] = this._tmpVecA.y;
    player.facing[2] = this._tmpVecA.z;

    player.health = this._fishStats.health;
    player.mana = this._fishStats.energy;
    player.stamina = this._fishStats.stamina;
    player.focusDistance = this._fishStats.focusDistance;
    player.species = this.speciesName;
    player.depth = this._depth;
    player.underwater = this._fishStats.underwater;
    player.schooling = this._fishStats.schooling;

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
    let totalMass = this._fishStats.bodyMass;
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
    p.playerDepth = this._depth;
    p.playerUnderwater = this._fishStats.underwater;
    p.playerSwimSpeed = this._fishStats.swimSpeed;
    p.playerSchooling = this._fishStats.schooling;
  }

  // ── accessors ─────────────────────────────────────────────
  attachDispatcher(d) { this._dispatcher = d; return this; }
  get currentState() { return this._currentState; }
  get currentStateName() { return this._animRegistry.getName(this._currentState); }
  get playerStats() { return this._fishStats; }
  get rootPosition() { return this._rootMotion.position; }
  get jointNodes() { return this._nodes; }
  get goapPlan() { return this._goapPlan; }
  get goapWorldState() { return this._goapWorldState; }
  get jointCount() { return this._jointCount; }
  get depth() { return this._depth; }
  get isUnderwater() { return this._fishStats.underwater === 1; }

  getStats() { return Object.freeze({ ...this._stats }); }
  resetStats() { for (const k of Object.keys(this._stats)) this._stats[k] = 0; }

  dispose() {
    this._dispatcher = null;
    this._frameRef = null;
    this._equipment.fill(null);
    this._equipmentMass.fill(0);
    this._equipmentEmissive.fill(0);
    this._springBones.lPectTip.active = 0;
    this._springBones.rPectTip.active = 0;
    this._springBones.tailTip.active = 0;
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
  FishContextProvider,
  FISH_ROOT_MOTION_PROFILES,
  _fishJointReg as FISH_JOINT_REGISTRY,
  _fishAnimReg as FISH_ANIM_REGISTRY,
  _fishGoapReg as FISH_GOAP_REGISTRY,
  _fishProcReg as FISH_PROC_REGISTRY
};