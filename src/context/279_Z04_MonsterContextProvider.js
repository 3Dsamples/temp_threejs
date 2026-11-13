// file number : 279_Z04
// full path name : src/context/279_Z04_MonsterContextProvider.js
// description : Monster / large-creature context provider — a specialized controller for dragons, giants, trolls, golems, krakens, behemoths, and other large hostile creatures. Built on the same registries, IK stack, root-motion controller, motion-matching database, and deformation overlays as 279_PlayerContextProvider and the 279_Z01..03 creature providers. Defines a configurable multi-limb skeleton (dragon: 4 legs + 2 wings + long neck + tail + horns + breath jaw; giant/troll: 2 arms + 2 legs + neck + head + armor plates; kraken: central body + 8 tentacles + 2 eyes) that can be swapped at runtime for any monster species. Provides species-specific root-motion profiles (lumber, stomp, charge, leap, rampage, hover, dive, glide, swim, surface-breach). Provides a rage state machine (calm → irritated → enraged → berserk) with escalating stats, a fear aura that emits causal events to nearby NPCs, breath-weapon emission (fire / ice / poison / lightning / acid) with cooldowns and directional beam targeting, area-of-effect (AoE) attacks with radial force, regeneration, armored plates with weak-point tracking, and a phase-based boss fight pattern. Provides per-limb IK for stomp/foot placement, jaw targeting, wingtip contact, and tentacle grabbing. Provides procedural overlays for spine flex, tail whip, wing flap, jaw snarl, chest breath buildup, heat, fire, and deformation. Provides motion-matching samples per locomotion profile. Provides GOAP actions for hunting, defending, rampaging, regenerating, and retreating. Emits causal events on attack, roar, breath-fire, stomp, leap, land, phase-change, and death. Consumes causal events for hit reactions and aggro triggers. Writes pose, velocity, focus distance, stats, skeleton transforms, breath-weapon state, and light-eligible emissive flags into frame.layers.player and frame.layers.physical using the same contract as 279 so downstream systems require no changes.
// best for : Populating every large hostile entity in the living world — dragons, giants, trolls, golems, krakens, behemoths. Feeds the combat, ecology, clustered-lighting (breath weapons), camera-shake, and audio systems. Complements 279 (humanoid), 279_Z01 (bird), 279_Z02 (fish), and 279_Z03 (quadruped) so every living archetype shares the same registries and context-frame contract.
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
// ─── MONSTER REGISTRIES ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

const _monsterJointReg = new JointRegistry();
const _monsterAnimReg = new AnimStateRegistry();
const _monsterGoapReg = new GoapBitRegistry();
const _monsterProcReg = new ProceduralParamRegistry();

// ── monster skeleton (dragon-like multi-limb template) ─────────
// Species with fewer limbs register a subset of these joints.
function registerMonsterJoints(reg) {
  // ── core ────────────────────────────────────────────────────
  reg.register('ROOT',         null,          [0, 0, 0]);
  reg.register('PELVIS',       'ROOT',        [0, 1.5, -1.0]);
  reg.register('SPINE_0',      'PELVIS',      [0, 0.10, 0.50]);
  reg.register('SPINE_1',      'SPINE_0',     [0, 0.05, 0.60]);
  reg.register('SPINE_2',      'SPINE_1',     [0, 0.05, 0.60]);
  reg.register('CHEST',        'SPINE_2',     [0, 0.05, 0.55]);
  reg.register('NECK_0',       'CHEST',       [0, 0.30, 0.40]);
  reg.register('NECK_1',       'NECK_0',      [0, 0.30, 0.40]);
  reg.register('NECK_2',       'NECK_1',      [0, 0.30, 0.40]);
  reg.register('HEAD',         'NECK_2',      [0, 0.15, 0.35]);
  reg.register('JAW_UPPER',    'HEAD',        [0, 0.05, 0.25]);
  reg.register('JAW_LOWER',    'HEAD',        [0, -0.10, 0.25]);
  reg.register('L_HORN',       'HEAD',        [ 0.15, 0.20, 0.05]);
  reg.register('R_HORN',       'HEAD',        [-0.15, 0.20, 0.05]);
  reg.register('L_EYE',        'HEAD',        [ 0.10, 0.05, 0.20]);
  reg.register('R_EYE',        'HEAD',        [-0.10, 0.05, 0.20]);
  reg.register('BREATH_NODE',  'HEAD',        [0, 0, 0.35]);

  // ── front legs ───────────────────────────────────────────────
  reg.register('FL_SHOULDER',  'CHEST',       [ 0.45, -0.35, 0]);
  reg.register('FL_ELBOW',     'FL_SHOULDER', [ 0.05, -0.60, 0]);
  reg.register('FL_WRIST',     'FL_ELBOW',    [ 0, -0.55, 0]);
  reg.register('FL_PAW',       'FL_WRIST',    [ 0, -0.15, 0.10]);
  reg.register('FR_SHOULDER',  'CHEST',       [-0.45, -0.35, 0]);
  reg.register('FR_ELBOW',     'FR_SHOULDER', [-0.05, -0.60, 0]);
  reg.register('FR_WRIST',     'FR_ELBOW',    [ 0, -0.55, 0]);
  reg.register('FR_PAW',       'FR_WRIST',    [ 0, -0.15, 0.10]);

  // ── rear legs ────────────────────────────────────────────────
  reg.register('RL_HIP',       'PELVIS',      [ 0.40, -0.30, 0]);
  reg.register('RL_KNEE',      'RL_HIP',      [ 0.05, -0.65, 0.10]);
  reg.register('RL_HOCK',      'RL_KNEE',     [ 0, -0.60, -0.10]);
  reg.register('RL_PAW',       'RL_HOCK',     [ 0, -0.15, 0.10]);
  reg.register('RR_HIP',       'PELVIS',      [-0.40, -0.30, 0]);
  reg.register('RR_KNEE',      'RR_HIP',      [-0.05, -0.65, 0.10]);
  reg.register('RR_HOCK',      'RR_KNEE',     [ 0, -0.60, -0.10]);
  reg.register('RR_PAW',       'RR_HOCK',     [ 0, -0.15, 0.10]);

  // ── wings (3 segments + tip) ─────────────────────────────────
  reg.register('L_WING_ROOT',  'CHEST',       [ 0.55, 0.40, 0]);
  reg.register('L_WING_ELBOW', 'L_WING_ROOT', [ 0.60, 0.20, 0]);
  reg.register('L_WING_WRIST', 'L_WING_ELBOW',[ 0.80, 0.10, 0]);
  reg.register('L_WING_TIP',   'L_WING_WRIST',[ 0.90, 0, 0]);
  reg.register('R_WING_ROOT',  'CHEST',       [-0.55, 0.40, 0]);
  reg.register('R_WING_ELBOW', 'R_WING_ROOT', [-0.60, 0.20, 0]);
  reg.register('R_WING_WRIST', 'R_WING_ELBOW',[-0.80, 0.10, 0]);
  reg.register('R_WING_TIP',   'R_WING_WRIST',[-0.90, 0, 0]);

  // ── tail (7 segments) ───────────────────────────────────────
  for (let i = 0; i < 7; i++) {
    const parent = i === 0 ? 'PELVIS' : `TAIL_${i - 1}`;
    reg.register(`TAIL_${i}`, parent, [0, 0.02, -0.35]);
  }
  reg.register('TAIL_SPADE',  'TAIL_6',       [0, 0, -0.20]);

  // ── armor plates (attachable) ───────────────────────────────
  reg.register('PLATE_HEAD',   'HEAD',        [0, 0.15, 0.05]);
  reg.register('PLATE_CHEST',  'CHEST',       [0, 0.15, 0.10]);
  reg.register('PLATE_BACK_0', 'SPINE_1',     [0, 0.20, 0]);
  reg.register('PLATE_BACK_1', 'SPINE_2',     [0, 0.20, 0]);
  reg.register('PLATE_PELVIS', 'PELVIS',      [0, 0.15, 0]);

  // ── attachment bones for equipment / saddle / rider ────────
  reg.register('SADDLE_ATTACH', 'SPINE_1',    [0, 0.30, 0]);
  reg.register('HEAD_ATTACH',   'HEAD',       [0, 0.10, 0]);
  reg.register('CHEST_ATTACH',  'CHEST',      [0, 0.20, 0]);
  reg.register('BACK_ATTACH',   'SPINE_2',    [0, 0.20, 0]);
  reg.register('PELVIS_ATTACH', 'PELVIS',     [0, 0.20, 0]);
  reg.register('TAIL_ATTACH',   'TAIL_SPADE', [0, 0, -0.10]);

  reg.freezeBuiltins();
}
registerMonsterJoints(_monsterJointReg);

// ── monster animation states ────────────────────────────────
[
  ['idle', 0], ['stand', 1], ['walk', 2], ['lumber', 3], ['stomp', 4],
  ['charge', 5], ['rampage', 6], ['leap', 7], ['land', 8],
  ['roar', 9], ['growl', 10], ['snarl', 11],
  ['attack_melee', 12], ['attack_bite', 13], ['attack_breath', 14],
  ['attack_sweep', 15], ['attack_tail', 16],
  ['crouch', 17], ['rear_up', 18], ['retreat', 19],
  ['glide', 20], ['flap', 21], ['dive', 22], ['hover', 23], ['takeoff', 24],
  ['swim', 25], ['surface_breach', 26], ['submerge', 27],
  ['phase_change', 28], ['rage_enter', 29], ['rage_attack', 30],
  ['regenerate', 31], ['death', 32], ['hit', 33]
].forEach(([name, priority]) => _monsterAnimReg.register(name, priority));

// ── monster GOAP bits ───────────────────────────────────────
[
  'HAS_TARGET', 'IN_RANGE', 'HAS_LOS',
  'IS_GROUNDED', 'IS_AIRBORNE', 'IS_UNDERWATER',
  'IS_AGGRO', 'IS_ENRAGED', 'IS_BERSERK', 'IS_HURT',
  'IS_LOW_HEALTH', 'IS_PHASE_TWO', 'IS_PHASE_THREE',
  'TARGET_DEAD', 'TARGET_VISIBLE', 'IN_MELEE_RANGE',
  'BREATH_READY', 'ROAR_READY', 'AOE_READY',
  'HAS_REGEN_ENERGY', 'NEED_RETREAT', 'OUT_OF_STAMINA'
].forEach(n => _monsterGoapReg.register(n));

// ── monster procedural parameters ──────────────────────────
_monsterProcReg.register('bodyWave',      { amplitude: 0.06, frequency: 1.2 });
_monsterProcReg.register('tailWhip',      { amplitude: 0.35, frequency: 1.8, whipAmplitude: 0.6 });
_monsterProcReg.register('wingFlap',      { amplitude: 0.55, frequency: 1.0 });
_monsterProcReg.register('jawSnarl',      { amplitude: 0.20, frequency: 8.0 });
_monsterProcReg.register('chestBreath',   { amplitude: 0.10, buildupRate: 2.0, decayRate: 1.0 });
_monsterProcReg.register('breath',        { period: 4.0, amplitude: 0.02 });
_monsterProcReg.register('heat',          { emissivePerC: 0.010, colorShiftPerC: 0.008 });
_monsterProcReg.register('fire',          { spreadRate: 0.5, emissiveMax: 5.0 });
_monsterProcReg.register('regen',         { healthPerSec: 2.0, staminaCost: 5.0 });

// ── breath weapon types ────────────────────────────────────
const BREATH_WEAPON = Object.freeze({
  FIRE:      0,
  ICE:       1,
  POISON:    2,
  LIGHTNING: 3,
  ACID:      4,
  HOLY:      5,
  NECROTIC:  6
});

// ── rage tiers ──────────────────────────────────────────────
const RAGE_TIER = Object.freeze({
  CALM:     0,   // normal
  IRRITATED:1,   // slight stats boost, aggressive
  ENRAGED:  2,   // strong stats boost, red glow
  BERSERK:  3    // massive stats boost, no retreat, red/black glow
});

// ── boss phases ─────────────────────────────────────────────
const BOSS_PHASE = Object.freeze({
  PHASE_1: 0,    // 100%-66% health
  PHASE_2: 1,    // 66%-33% health, gains new abilities
  PHASE_3: 2     // 33%-0% health, final stand
});

// ── monster root-motion profiles ────────────────────────────
const MONSTER_ROOT_MOTION_PROFILES = Object.freeze({
  idle:     { maxSpeed: 0.0,  acceleration: 1,  angularAcceleration: 1,  gravityScale: 1.0, jumpImpulse: 0,   bodyPitch: 0.0 },
  walk:     { maxSpeed: 1.5,  acceleration: 3,  angularAcceleration: 2,  gravityScale: 1.0, jumpImpulse: 0,   bodyPitch: 0.0 },
  lumber:   { maxSpeed: 2.5,  acceleration: 4,  angularAcceleration: 2,  gravityScale: 1.0, jumpImpulse: 0,   bodyPitch: -0.02 },
  stomp:    { maxSpeed: 2.0,  acceleration: 5,  angularAcceleration: 3,  gravityScale: 1.0, jumpImpulse: 0,   bodyPitch: -0.05 },
  charge:   { maxSpeed: 8.0,  acceleration: 12, angularAcceleration: 4,  gravityScale: 1.0, jumpImpulse: 0,   bodyPitch: -0.15 },
  rampage:  { maxSpeed: 12.0, acceleration: 18, angularAcceleration: 6,  gravityScale: 1.0, jumpImpulse: 0,   bodyPitch: -0.20 },
  leap:     { maxSpeed: 6.0,  acceleration: 8,  angularAcceleration: 3,  gravityScale: 1.0, jumpImpulse: 12.0, bodyPitch: 0.1 },
  land:     { maxSpeed: 1.0,  acceleration: 3,  angularAcceleration: 3,  gravityScale: 1.0, jumpImpulse: 0,   bodyPitch: 0.08 },
  retreat:  { maxSpeed: 4.0,  acceleration: 8,  angularAcceleration: 4,  gravityScale: 1.0, jumpImpulse: 0,   bodyPitch: -0.05 },
  hover:    { maxSpeed: 2.0,  acceleration: 4,  angularAcceleration: 3,  gravityScale: 0.0, jumpImpulse: 0,   bodyPitch: 0.0 },
  flap:     { maxSpeed: 8.0,  acceleration: 6,  angularAcceleration: 4,  gravityScale: 0.0, jumpImpulse: 0,   bodyPitch: -0.05 },
  glide:    { maxSpeed: 10.0, acceleration: 2,  angularAcceleration: 2,  gravityScale: 0.2, jumpImpulse: 0,   bodyPitch: -0.03 },
  dive:     { maxSpeed: 15.0, acceleration: 20, angularAcceleration: 8,  gravityScale: 1.2, jumpImpulse: 0,   bodyPitch: -0.30 },
  takeoff:  { maxSpeed: 5.0,  acceleration: 10, angularAcceleration: 4,  gravityScale: 1.0, jumpImpulse: 10.0, bodyPitch: 0.15 },
  swim:     { maxSpeed: 4.0,  acceleration: 4,  angularAcceleration: 2,  gravityScale: 0.0, jumpImpulse: 0,   bodyPitch: 0.0 },
  surface_breach: { maxSpeed: 6.0, acceleration: 10, angularAcceleration: 3, gravityScale: 1.0, jumpImpulse: 14.0, bodyPitch: 0.20 },
  submerge: { maxSpeed: 3.0,  acceleration: 4,  angularAcceleration: 2,  gravityScale: 0.0, jumpImpulse: 0,   bodyPitch: -0.10 }
});

// ══════════════════════════════════════════════════════════════════
// ─── MONSTER PROVIDER ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

class MonsterContextProvider {
  constructor(options = {}) {
    // ── config ──────────────────────────────────────────────
    this.ikWeight = options.ikWeight ?? 1.0;
    this.lookAtWeight = options.lookAtWeight ?? 0.8;
    this.footIKEnabled = options.footIKEnabled ?? true;
    this.wingIKEnabled = options.wingIKEnabled ?? true;
    this.jawIKEnabled = options.jawIKEnabled ?? true;
    this.tailIKEnabled = options.tailIKEnabled ?? true;
    this.proceduralEnabled = options.proceduralEnabled ?? true;
    this.motionMatchingEnabled = options.motionMatchingEnabled ?? true;
    this.goapEnabled = options.goapEnabled ?? true;
    this.goapReplanInterval = options.goapReplanInterval ?? 0.35;
    this.stateBlendRate = options.stateBlendRate ?? 6.0;
    this.defaultIkSolver = options.defaultIkSolver ?? IK_SOLVER.HYBRID;
    this.speciesName = options.speciesName ?? 'generic-monster';
    this.bodyScale = options.bodyScale ?? 1.0;

    // ── combat ─────────────────────────────────────────────
    this.breathWeaponType = options.breathWeaponType ?? BREATH_WEAPON.FIRE;
    this.breathCooldown = options.breathCooldown ?? 8.0;
    this.roarCooldown = options.roarCooldown ?? 15.0;
    this.aoeCooldown = options.aoeCooldown ?? 12.0;
    this.breathRange = options.breathRange ?? 25.0;
    this.aoeRadius = options.aoeRadius ?? 12.0;
    this.fearAuraRadius = options.fearAuraRadius ?? 15.0;
    this.fearAuraStrength = options.fearAuraStrength ?? 0.6;

    // ── cooldown state ─────────────────────────────────────
    this._breathTimer = 0;
    this._roarTimer = 0;
    this._aoeTimer = 0;
    this._breathCharging = 0;  // 0..1 as breath charges up
    this._breathActive = 0;    // 1 while breath is firing
    this._breathFireTime = 0;
    this._breathFireDuration = 1.5;

    // ── rage state ─────────────────────────────────────────
    this._rageTier = RAGE_TIER.CALM;
    this._rageMeter = 0;        // 0..1
    this._rageDecayRate = 0.03;  // per second

    // ── boss phase ─────────────────────────────────────────
    this._bossPhase = BOSS_PHASE.PHASE_1;
    this._phaseTransitions = 0;

    // ── joint registry ────────────────────────────────────
    this._jointRegistry = options.jointRegistry || _monsterJointReg;
    const jointCount = this._jointRegistry.count;
    this._nodes = new Array(jointCount);
    for (let i = 0; i < jointCount; i++) {
      this._nodes[i] = new JointNode(i, this._jointRegistry.getParent(i));
      const lp = this._jointRegistry.getLocalPos(i);
      this._nodes[i].localPos.set(
        lp[0] * this.bodyScale,
        lp[1] * this.bodyScale,
        lp[2] * this.bodyScale
      );
    }
    this._jointCount = jointCount;

    // ── IK targets ─────────────────────────────────────────
    this._ikTargets = {
      flFoot: new Vec3(), frFoot: new Vec3(),
      rlFoot: new Vec3(), rrFoot: new Vec3(),
      lWing: new Vec3(), rWing: new Vec3(),
      jaw: new Vec3(), tail: new Vec3()
    };
    this._ikWeights = new Float32Array(8);
    this._ikSolvers = {
      flFoot: IK_SOLVER.TWO_BONE,
      frFoot: IK_SOLVER.TWO_BONE,
      rlFoot: IK_SOLVER.TWO_BONE,
      rrFoot: IK_SOLVER.TWO_BONE,
      lWing: IK_SOLVER.CCD,
      rWing: IK_SOLVER.CCD,
      jaw: IK_SOLVER.FABRIK,
      tail: IK_SOLVER.FABRIK
    };

    // ── look-at ────────────────────────────────────────────
    this._lookAtTarget = new Vec3();
    this._lookAtActive = 0;

    // ── root motion ────────────────────────────────────────
    this._rootMotion = new RootMotionController('idle');
    this._rootMotion.profile = MONSTER_ROOT_MOTION_PROFILES['idle'];
    this._rootMotion.profileName = 'idle';
    this._rootPosition = this._rootMotion.position;
    this._rootVelocity = this._rootMotion.velocity;
    this._rootQuat = this._rootMotion.quat;
    this._airborne = 0;
    this._underwater = 0;

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
      const name = i === EQUIP_SLOT.CHEST ? 'CHEST_ATTACH'
        : i === EQUIP_SLOT.BACK ? 'SADDLE_ATTACH'
        : i === EQUIP_SLOT.HEAD ? 'HEAD_ATTACH'
        : i === EQUIP_SLOT.LEGS ? 'PELVIS_ATTACH'
        : i === EQUIP_SLOT.FEET ? 'PELVIS_ATTACH'
        : i === EQUIP_SLOT.MAIN_HAND ? 'CHEST_ATTACH'
        : i === EQUIP_SLOT.OFF_HAND ? 'CHEST_ATTACH'
        : 'BACK_ATTACH';
      this._equipmentAttachJoint[i] = this._jointRegistry.getIndex(name);
    }

    // ── animation state ────────────────────────────────────
    this._animRegistry = options.animRegistry || _monsterAnimReg;
    this._currentState = this._animRegistry.getId('idle');
    this._previousState = this._currentState;
    this._stateBlend = 1.0;
    this._animationTime = 0;
    this._animationSpeed = 1.0;

    // ── motion matching database (seeded) ─────────────────
    this._motionDB = new MotionMatchingDatabase(
      options.featureCapacity ?? 4096, 12
    );
    this._seedMotionSamples();
    this._currentMatchIndex = -1;
    this._currentMatchTime = 0;

    // ── procedural overlays ───────────────────────────────
    this._breathingPhase = 0;
    this._tailWhipPhase = 0;
    this._wingFlapPhase = 0;
    this._jawSnarlPhase = 0;
    this._chestBreathBuildup = 0;
    this._hitStaggerTimer = 0;
    this._deformation = new DeformationOverlay();

    // ── spring bones ──────────────────────────────────────
    this._springBones = {
      tailTip:       { position: new Vec3(), velocity: new Vec3(), target: new Vec3(), active: 1 },
      lWingTip:      { position: new Vec3(), velocity: new Vec3(), target: new Vec3(), active: 1 },
      rWingTip:      { position: new Vec3(), velocity: new Vec3(), target: new Vec3(), active: 1 },
      lHorn:         { position: new Vec3(), velocity: new Vec3(), target: new Vec3(), active: 1 },
      rHorn:         { position: new Vec3(), velocity: new Vec3(), target: new Vec3(), active: 1 }
    };

    // ── armor plates / weak points ────────────────────────
    this._armorPlates = [];
    this._weakPoints = [];
    this._registerDefaultArmor();

    // ── fear aura ─────────────────────────────────────────
    this._fearAuraActive = 0;
    this._fearAuraPulseTimer = 0;
    this._fearAuraTickInterval = 0.5;   // emit once every 0.5s

    // ── target tracking ───────────────────────────────────
    this._targetEntityId = -1;
    this._targetPosition = new Vec3();
    this._targetActive = 0;

    // ── GOAP ──────────────────────────────────────────────
    this._goapRegistry = options.goapRegistry || _monsterGoapReg;
    this._goapGoals = [];
    this._goapActions = [];
    this._goapWorldState = 0;
    this._goapPlan = [];
    this._goapPlanIndex = 0;
    this._goapReplanTimer = 0;
    this._goapBestGoal = -1;

    // ── monster stats ─────────────────────────────────────
    this._monsterStats = {
      health: 2000, maxHealth: 2000,
      stamina: 200, maxStamina: 200,
      armor: 200, maxArmor: 200,
      focusDistance: 40,
      length: 12.0,               // metres
      height: 5.0,
      bodyMass: 4000.0,           // kg
      speed: 0,
      grounded: 1,
      moving: 0,
      aggro: 0,
      rageTier: RAGE_TIER.CALM,
      bossPhase: BOSS_PHASE.PHASE_1
    };

    // ── input ─────────────────────────────────────────────
    this._input = {
      moveX: 0, moveY: 0, lookX: 0, lookY: 0,
      jump: 0, sprint: 0, crouch: 0,
      attack_melee: 0, attack_bite: 0, attack_breath: 0,
      attack_sweep: 0, attack_tail: 0,
      roar: 0, retreat: 0, takeoff: 0, land: 0,
      aoe: 0
    };

    // ── scratch ───────────────────────────────────────────
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
    this._tmpBox = new Box3();

    // ── joint emissive ────────────────────────────────────
    this._jointEmissive = new Float32Array(jointCount);

    // ── breath weapon light params ────────────────────────
    this._breathLightColor = this._colorForBreathType(this.breathWeaponType);
    this._breathLightIntensity = 0;

    // ── timing / stats ───────────────────────────────────
    this._lastUpdateTime = -Infinity;
    this._updateCount = 0;
    this._dispatcher = options.dispatcher || null;
    this._frameRef = null;

    this._stats = {
      updates: 0, plansExecuted: 0, plansRejected: 0,
      ikEvaluations: 0, motionMatches: 0, springUpdates: 0,
      stateTransitions: 0, causalEventsEmitted: 0, deformationsApplied: 0,
      breathFires: 0, roars: 0, aoeAttacks: 0, rageEntries: 0,
      phaseChanges: 0, fearPulses: 0
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── armor / weak points ──────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _registerDefaultArmor() {
    const plates = ['PLATE_HEAD', 'PLATE_CHEST', 'PLATE_BACK_0', 'PLATE_BACK_1', 'PLATE_PELVIS'];
    for (const name of plates) {
      const idx = this._jointRegistry.getIndex(name);
      if (idx >= 0) {
        this._armorPlates.push({ jointIdx: idx, health: 100, maxHealth: 100, broken: 0 });
      }
    }
    // Weak points: eyes and jaw.
    const weakJointNames = ['L_EYE', 'R_EYE', 'JAW_LOWER'];
    for (const name of weakJointNames) {
      const idx = this._jointRegistry.getIndex(name);
      if (idx >= 0) {
        this._weakPoints.push({ jointIdx: idx, damageMultiplier: 3.0 });
      }
    }
  }

  registerArmorPlate(jointName, health = 100) {
    const idx = this._jointRegistry.getIndex(jointName);
    if (idx < 0) return -1;
    this._armorPlates.push({ jointIdx: idx, health, maxHealth: health, broken: 0 });
    return this._armorPlates.length - 1;
  }

  registerWeakPoint(jointName, damageMultiplier = 2.0) {
    const idx = this._jointRegistry.getIndex(jointName);
    if (idx < 0) return -1;
    this._weakPoints.push({ jointIdx: idx, damageMultiplier });
    return this._weakPoints.length - 1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── breath weapon ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _colorForBreathType(type) {
    switch (type) {
      case BREATH_WEAPON.FIRE:      return [1.0, 0.4, 0.1];
      case BREATH_WEAPON.ICE:       return [0.5, 0.8, 1.0];
      case BREATH_WEAPON.POISON:    return [0.4, 0.9, 0.3];
      case BREATH_WEAPON.LIGHTNING: return [1.0, 1.0, 0.5];
      case BREATH_WEAPON.ACID:      return [0.7, 1.0, 0.2];
      case BREATH_WEAPON.HOLY:      return [1.0, 0.95, 0.7];
      case BREATH_WEAPON.NECROTIC:  return [0.5, 0.2, 0.6];
      default:                       return [1.0, 0.4, 0.1];
    }
  }

  setBreathWeaponType(type) {
    this.breathWeaponType = type;
    this._breathLightColor = this._colorForBreathType(type);
    return this;
  }

  fireBreath() {
    if (this._breathTimer > 0) return false;
    if (this._breathActive) return false;
    this._breathTimer = this.breathCooldown;
    this._breathCharging = 1.0;
    this._breathActive = 1;
    this._breathFireTime = 0;
    this._stats.breathFires++;
    this._transitionTo(this._animRegistry.getId('attack_breath'));

    if (this._dispatcher) {
      const breathPos = this._jointRegistry.getIndex('BREATH_NODE');
      const worldPos = breathPos >= 0 ? this._nodes[breathPos].worldPos : this._rootMotion.position;
      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.AUDIO_LIGHT,
        [worldPos.x, worldPos.y, worldPos.z],
        this.breathWeaponType, 80, 1.5,
        { kind: 'breath_weapon', type: this.breathWeaponType, range: this.breathRange }
      );
      this._stats.causalEventsEmitted++;
    }
    return true;
  }

  stopBreath() {
    this._breathActive = 0;
    this._breathFireTime = 0;
    return this;
  }

  // ══════════════════════════════════════════════════════════
  // ─── rage / phase state ───────────────────────────────────
  // ══════════════════════════════════════════════════════════
  addRage(amount) {
    this._rageMeter = Math.min(1, this._rageMeter + amount);
    this._updateRageTier();
    return this;
  }

  _updateRageTier() {
    let newTier = RAGE_TIER.CALM;
    if (this._rageMeter > 0.85) newTier = RAGE_TIER.BERSERK;
    else if (this._rageMeter > 0.55) newTier = RAGE_TIER.ENRAGED;
    else if (this._rageMeter > 0.25) newTier = RAGE_TIER.IRRITATED;

    if (newTier !== this._rageTier) {
      this._rageTier = newTier;
      this._monsterStats.rageTier = newTier;
      this._stats.rageEntries++;
      if (newTier === RAGE_TIER.ENRAGED || newTier === RAGE_TIER.BERSERK) {
        this._transitionTo(this._animRegistry.getId('rage_enter'));
        if (this._dispatcher) {
          this._dispatcher.queueCausalEvent(
            EVENT_TYPE.AUDIO_LIGHT,
            [this._rootMotion.position.x, this._rootMotion.position.y, this._rootMotion.position.z],
            -1, 60, 2.0,
            { kind: 'rage_roar', tier: newTier }
          );
          this._stats.causalEventsEmitted++;
        }
      }
    }
  }

  _updateRage(dt) {
    this._rageMeter = Math.max(0, this._rageMeter - this._rageDecayRate * dt);
    this._updateRageTier();
  }

  _updateBossPhase() {
    const hpPercent = this._monsterStats.health / this._monsterStats.maxHealth;
    let newPhase = BOSS_PHASE.PHASE_1;
    if (hpPercent < 0.33) newPhase = BOSS_PHASE.PHASE_3;
    else if (hpPercent < 0.66) newPhase = BOSS_PHASE.PHASE_2;

    if (newPhase !== this._bossPhase) {
      this._bossPhase = newPhase;
      this._monsterStats.bossPhase = newPhase;
      this._phaseTransitions++;
      this._stats.phaseChanges++;

      // Enter phase transition — brief invulnerability + roar.
      this._transitionTo(this._animRegistry.getId('phase_change'));
      this.addRage(0.4);

      if (this._dispatcher) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.AUDIO_LIGHT,
          [this._rootMotion.position.x, this._rootMotion.position.y, this._rootMotion.position.z],
          -1, 100, 3.0,
          { kind: 'phase_change', phase: newPhase }
        );
        this._stats.causalEventsEmitted++;
      }
    }
  }

  _rageMultiplier() {
    switch (this._rageTier) {
      case RAGE_TIER.IRRITATED: return 1.15;
      case RAGE_TIER.ENRAGED:   return 1.4;
      case RAGE_TIER.BERSERK:   return 1.8;
      default:                   return 1.0;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── fear aura ────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateFearAura(dt, frame) {
    this._fearAuraPulseTimer -= dt;
    if (this._fearAuraPulseTimer > 0) return;
    this._fearAuraPulseTimer = this._fearAuraTickInterval;

    this._fearAuraActive = 1;
    this._stats.fearPulses++;

    // Emit a fear pulse as a causal signal. The ecology/fauna systems
    // will interpret it and cause nearby prey to flee.
    if (this._dispatcher) {
      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.ECOLOGY,
        [this._rootMotion.position.x, this._rootMotion.position.y, this._rootMotion.position.z],
        -1, 20 * this.fearAuraStrength * this._rageMultiplier(), 1.0,
        { kind: 'fear_aura', radius: this.fearAuraRadius, strength: this.fearAuraStrength * this._rageMultiplier() }
      );
      this._stats.causalEventsEmitted++;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── AoE attack ───────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  triggerAoE() {
    if (this._aoeTimer > 0) return false;
    this._aoeTimer = this.aoeCooldown;
    this._stats.aoeAttacks++;

    if (this._dispatcher) {
      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.IMPACT,
        [this._rootMotion.position.x, this._rootMotion.position.y, this._rootMotion.position.z],
        -1, 150 * this._rageMultiplier(), 1.0,
        { kind: 'aoe_attack', radius: this.aoeRadius, damage: 100 * this._rageMultiplier() }
      );
      this._stats.causalEventsEmitted++;
    }
    return true;
  }

  // ══════════════════════════════════════════════════════════
  // ─── motion matching seeding ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  _seedMotionSamples() {
    const tags = ['idle', 'walk', 'lumber', 'charge', 'rampage',
                  'flap', 'glide', 'dive', 'swim', 'attack_melee', 'attack_breath'];
    for (const tag of tags) {
      const id = this._animRegistry.getId(tag);
      for (let s = 0; s < 14; s++) {
        const phase = (s / 14) * 2 * Math.PI;
        const amp = tag === 'rampage' ? 8.0
          : tag === 'charge' ? 5.0
          : tag === 'attack_melee' || tag === 'attack_breath' ? 3.0
          : tag === 'flap' || tag === 'glide' || tag === 'dive' ? 4.0
          : tag === 'lumber' ? 1.5
          : tag === 'walk' ? 1.0
          : 0.2;
        this._motionDB.add(
          { x: Math.cos(phase) * 0.3, y: 0, z: Math.sin(phase) * 0.3 },
          { x: Math.cos(phase) * amp, y: 0, z: Math.sin(phase) * amp },
          { x: Math.cos(phase + 0.4) * amp * 0.5, y: 0, z: Math.sin(phase + 0.4) * amp * 0.5 },
          id, s * 0.12
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
    this._nodes[idx].localPos.set(
      lp[0] * this.bodyScale, lp[1] * this.bodyScale, lp[2] * this.bodyScale
    );
    return idx;
  }
  registerAnimationState(name, priority = 0) { return this._animRegistry.register(name, priority); }
  registerGoapBit(name) { return this._goapRegistry.register(name); }
  registerProceduralParam(name, params) { _monsterProcReg.register(name, params); return this; }
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
        ['FL_SHOULDER', 'FL_ELBOW', 'FL_WRIST', 'FL_PAW'], this._ikSolvers.flFoot);
    }
    if (this._ikWeights[1] > 1e-5) {
      this._updateLimbIK(this._ikTargets.frFoot, this._ikWeights[1] * weight,
        ['FR_SHOULDER', 'FR_ELBOW', 'FR_WRIST', 'FR_PAW'], this._ikSolvers.frFoot);
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

  _updateWingIK(weight) {
    if (!this.wingIKEnabled || weight < 1e-5) return;
    if (this._ikWeights[4] > 1e-5) {
      this._updateLimbIK(this._ikTargets.lWing, this._ikWeights[4] * weight,
        ['L_WING_ROOT', 'L_WING_ELBOW', 'L_WING_WRIST', 'L_WING_TIP'], this._ikSolvers.lWing);
    }
    if (this._ikWeights[5] > 1e-5) {
      this._updateLimbIK(this._ikTargets.rWing, this._ikWeights[5] * weight,
        ['R_WING_ROOT', 'R_WING_ELBOW', 'R_WING_WRIST', 'R_WING_TIP'], this._ikSolvers.rWing);
    }
  }

  _updateJawIK(weight) {
    if (!this.jawIKEnabled || weight < 1e-5) return;
    if (this._ikWeights[6] > 1e-5) {
      this._updateLimbIK(this._ikTargets.jaw, this._ikWeights[6] * weight,
        ['NECK_2', 'HEAD', 'JAW_LOWER'], this._ikSolvers.jaw);
    }
  }

  _updateTailIK(weight) {
    if (!this.tailIKEnabled || weight < 1e-5) return;
    if (this._ikWeights[7] > 1e-5) {
      this._updateLimbIK(this._ikTargets.tail, this._ikWeights[7] * weight,
        ['TAIL_0', 'TAIL_1', 'TAIL_2', 'TAIL_3', 'TAIL_4', 'TAIL_5', 'TAIL_6', 'TAIL_SPADE'],
        this._ikSolvers.tail);
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── look-at ─────────────────────────────────────────────
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
    this._applyLookTo('NECK_0', axis, angle * 0.30 * lookW);
    this._applyLookTo('NECK_1', axis, angle * 0.25 * lookW);
    this._applyLookTo('NECK_2', axis, angle * 0.25 * lookW);
    this._applyLookTo('HEAD',   axis, angle * 0.20 * lookW);
  }

  _applyLookTo(name, axis, angle) {
    const idx = this._jointRegistry.getIndex(name);
    if (idx >= 0) this._nodes[idx].applyRotationDelta(axis, angle);
  }

  // ══════════════════════════════════════════════════════════
  // ─── procedural overlays ─────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateBreathing(dt) {
    if (!this.proceduralEnabled) return;
    const p = _monsterProcReg.get('breath');
    this._breathingPhase += dt * (2 * Math.PI / p.period);
    const pulse = Math.sin(this._breathingPhase) * p.amplitude;
    const chest = this._jointRegistry.getIndex('CHEST');
    if (chest >= 0) this._nodes[chest].applyRotationDelta(new Vec3(0, 0, 1), pulse);
  }

  _updateBodyWave(dt) {
    if (!this.proceduralEnabled) return;
    const p = _monsterProcReg.get('bodyWave');
    const phase = this._animationTime * 2 * Math.PI * p.frequency;
    const spine1 = this._jointRegistry.getIndex('SPINE_1');
    const spine2 = this._jointRegistry.getIndex('SPINE_2');
    if (spine1 >= 0) this._nodes[spine1].applyRotationDelta(new Vec3(0, 1, 0), Math.sin(phase) * p.amplitude);
    if (spine2 >= 0) this._nodes[spine2].applyRotationDelta(new Vec3(0, 1, 0), Math.sin(phase + 0.5) * p.amplitude);
  }

  _updateTailWhip(dt) {
    if (!this.proceduralEnabled) return;
    const p = _monsterProcReg.get('tailWhip');
    this._tailWhipPhase += dt * (2 * Math.PI * p.frequency);
    const isAggressive = this._rageTier >= RAGE_TIER.ENRAGED || this._input.attack_tail > 0.1;
    const amplitude = isAggressive ? p.whipAmplitude : p.amplitude;
    for (let i = 0; i < 7; i++) {
      const idx = this._jointRegistry.getIndex(`TAIL_${i}`);
      if (idx < 0) continue;
      const phase = this._tailWhipPhase - i * 0.35;
      const whip = Math.sin(phase) * amplitude * (0.5 + i * 0.1);
      this._nodes[idx].applyRotationDelta(new Vec3(0, 1, 0), whip);
    }
  }

  _updateWingFlap(dt) {
    if (!this.proceduralEnabled) return;
    const p = _monsterProcReg.get('wingFlap');
    this._wingFlapPhase += dt * (2 * Math.PI * p.frequency);
    const flapAmp = this._airborne ? p.amplitude : p.amplitude * 0.2;
    const flap = Math.sin(this._wingFlapPhase) * flapAmp;

    const wings = ['L_WING_ROOT', 'L_WING_ELBOW', 'L_WING_WRIST', 'L_WING_TIP',
                   'R_WING_ROOT', 'R_WING_ELBOW', 'R_WING_WRIST', 'R_WING_TIP'];
    for (let i = 0; i < wings.length; i++) {
      const idx = this._jointRegistry.getIndex(wings[i]);
      if (idx < 0) continue;
      const sign = i < 4 ? 1 : -1;
      this._nodes[idx].applyRotationDelta(new Vec3(0, 1, 0), flap * sign * 0.3);
    }
  }

  _updateJawSnarl(dt) {
    if (!this.proceduralEnabled) return;
    const p = _monsterProcReg.get('jawSnarl');
    this._jawSnarlPhase += dt * (2 * Math.PI * p.frequency);
    const isAggressive = this._rageTier >= RAGE_TIER.IRRITATED || this._input.attack_bite > 0.1;
    const amplitude = isAggressive ? p.amplitude : p.amplitude * 0.2;
    const snarl = Math.sin(this._jawSnarlPhase) * amplitude;
    const jaw = this._jointRegistry.getIndex('JAW_LOWER');
    if (jaw >= 0) this._nodes[jaw].applyRotationDelta(new Vec3(1, 0, 0), snarl);
  }

  _updateChestBreathBuildup(dt) {
    if (!this.proceduralEnabled) return;
    const p = _monsterProcReg.get('chestBreath');
    if (this._breathCharging > 0) {
      this._chestBreathBuildup += dt * p.buildupRate;
      if (this._chestBreathBuildup > 1) this._chestBreathBuildup = 1;
      // Chest expands and glows.
      const chest = this._jointRegistry.getIndex('CHEST');
      if (chest >= 0) {
        this._nodes[chest].applyRotationDelta(new Vec3(0, 0, 1), p.amplitude * this._chestBreathBuildup);
      }
      // Emit chest emissive.
      if (chest >= 0) {
        this._jointEmissive[chest] = Math.max(this._jointEmissive[chest], this._chestBreathBuildup * 3.0);
      }
    } else {
      this._chestBreathBuildup -= dt * p.decayRate;
      if (this._chestBreathBuildup < 0) this._chestBreathBuildup = 0;
    }
  }

  _updateSpringBones(dt) {
    if (!this.proceduralEnabled) return;
    const stiffness = 50;
    const damping = 7;
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
  // ─── GOAP ────────────────────────────────────────────────
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
    if (this._monsterStats.grounded) bits |= reg.getBit('IS_GROUNDED');
    if (this._airborne) bits |= reg.getBit('IS_AIRBORNE');
    if (this._underwater) bits |= reg.getBit('IS_UNDERWATER');
    if (this._monsterStats.aggro) bits |= reg.getBit('IS_AGGRO');
    if (this._rageTier >= RAGE_TIER.ENRAGED) bits |= reg.getBit('IS_ENRAGED');
    if (this._rageTier === RAGE_TIER.BERSERK) bits |= reg.getBit('IS_BERSERK');
    if (this._hitStaggerTimer > 0) bits |= reg.getBit('IS_HURT');
    if (this._monsterStats.health / this._monsterStats.maxHealth < 0.3) bits |= reg.getBit('IS_LOW_HEALTH');
    if (this._bossPhase === BOSS_PHASE.PHASE_2) bits |= reg.getBit('IS_PHASE_TWO');
    if (this._bossPhase === BOSS_PHASE.PHASE_3) bits |= reg.getBit('IS_PHASE_THREE');
    if (this._breathTimer <= 0) bits |= reg.getBit('BREATH_READY');
    if (this._roarTimer <= 0) bits |= reg.getBit('ROAR_READY');
    if (this._aoeTimer <= 0) bits |= reg.getBit('AOE_READY');
    if (this._targetActive) bits |= reg.getBit('HAS_TARGET');
    if (this._monsterStats.stamina < 20) bits |= reg.getBit('OUT_OF_STAMINA');
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
  // ─── state machine ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateAnimationState(dt) {
    const S = (n) => this._animRegistry.getId(n);
    if (this._hitStaggerTimer > 0) this._transitionTo(S('hit'));
    else if (this._monsterStats.health <= 0) this._transitionTo(S('death'));
    else if (this._input.roar > 0.1 && this._roarTimer <= 0) {
      this._roarTimer = this.roarCooldown;
      this._transitionTo(S('roar'));
    }
    else if (this._breathActive) this._transitionTo(S('attack_breath'));
    else if (this._input.attack_bite > 0.1) this._transitionTo(S('attack_bite'));
    else if (this._input.attack_melee > 0.1) this._transitionTo(S('attack_melee'));
    else if (this._input.attack_sweep > 0.1) this._transitionTo(S('attack_sweep'));
    else if (this._input.attack_tail > 0.1) this._transitionTo(S('attack_tail'));
    else if (this._input.takeoff > 0.1 && this._monsterStats.grounded) this._transitionTo(S('takeoff'));
    else if (!this._monsterStats.grounded) {
      const vy = this._rootMotion.verticalVelocity;
      this._transitionTo(vy > 0.5 ? S('flap') : S('dive'));
    } else if (this._input.land > 0.1 && this._airborne) this._transitionTo(S('land'));
    else if (this._rageTier === RAGE_TIER.BERSERK) this._transitionTo(S('rampage'));
    else if (this._input.retreat > 0.1) this._transitionTo(S('retreat'));
    else {
      const speed = this._monsterStats.speed;
      if (speed > 8) this._transitionTo(S('charge'));
      else if (speed > 2) this._transitionTo(S('lumber'));
      else if (speed > 0.2) this._transitionTo(S('walk'));
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
      const attackStates = ['attack_melee', 'attack_bite', 'attack_sweep', 'attack_tail'];
      for (const atk of attackStates) {
        if (newState === this._animRegistry.getId(atk)) {
          this._dispatcher.queueCausalEvent(
            EVENT_TYPE.IMPACT,
            [this._rootMotion.position.x, this._rootMotion.position.y, this._rootMotion.position.z],
            -1, 80 * this._rageMultiplier(), 0.6,
            { kind: atk, species: this.speciesName }
          );
          this._stats.causalEventsEmitted++;
          break;
        }
      }
      if (newState === this._animRegistry.getId('roar')) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.AUDIO_LIGHT,
          [this._rootMotion.position.x, this._rootMotion.position.y, this._rootMotion.position.z],
          -1, 60 * this._rageMultiplier(), 1.5,
          { kind: 'roar', species: this.speciesName, fearRadius: this.fearAuraRadius }
        );
        this._stats.roars++;
        this._stats.causalEventsEmitted++;
      }
      if (newState === this._animRegistry.getId('death')) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.ECOLOGY,
          [this._rootMotion.position.x, this._rootMotion.position.y, this._rootMotion.position.z],
          -1, 200, 5.0,
          { kind: 'monster_death', species: this.speciesName }
        );
        this._stats.causalEventsEmitted++;
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── root motion ─────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateRootMotion(dt) {
    // Determine active profile.
    let profileName = 'idle';
    const speed = this._monsterStats.speed;
    if (this._rageTier === RAGE_TIER.BERSERK) profileName = 'rampage';
    else if (this._input.retreat > 0.1) profileName = 'retreat';
    else if (this._airborne) profileName = this._breathActive ? 'dive' : 'flap';
    else if (this._underwater) profileName = 'swim';
    else if (speed > 8) profileName = 'charge';
    else if (speed > 2) profileName = 'lumber';
    else if (speed > 0.2) profileName = 'walk';

    if (this._rootMotion.profileName !== profileName) {
      this._rootMotion.profileName = profileName;
      this._rootMotion.profile = MONSTER_ROOT_MOTION_PROFILES[profileName] || MONSTER_ROOT_MOTION_PROFILES.idle;
    }
    const profile = this._rootMotion.profile;

    // ── horizontal movement ──────────────────────────────
    const staminaScale = Math.min(1, this._monsterStats.stamina / 100);
    const dir = this._tmpVecA.set(this._input.moveX, 0, this._input.moveY);
    if (dir.lengthSq() > 1e-6) dir.normalize();
    const rageMultiplier = this._rageMultiplier();
    const targetSpeed = profile.maxSpeed * staminaScale * dir.length() * rageMultiplier;
    const maxAccel = profile.acceleration * dt * rageMultiplier;

    const dvx = dir.x * targetSpeed - this._rootMotion.velocity.x;
    const dvz = dir.z * targetSpeed - this._rootMotion.velocity.z;
    this._rootMotion.velocity.x += Math.sign(dvx) * Math.min(Math.abs(dvx), maxAccel);
    this._rootMotion.velocity.z += Math.sign(dvz) * Math.min(Math.abs(dvz), maxAccel);

    // ── jump / takeoff ───────────────────────────────────
    if ((this._input.jump > 0.1 || this._input.takeoff > 0.1) && this._monsterStats.grounded) {
      this._rootMotion.verticalVelocity = profile.jumpImpulse || 8.0;
      this._monsterStats.grounded = 0;
      this._airborne = 1;
    }

    // ── gravity ──────────────────────────────────────────
    if (!this._monsterStats.grounded && !this._underwater) {
      this._rootMotion.verticalVelocity -= 9.81 * profile.gravityScale * dt;
    }

    // ── integrate ────────────────────────────────────────
    this._rootMotion.position.x += this._rootMotion.velocity.x * dt;
    this._rootMotion.position.z += this._rootMotion.velocity.z * dt;
    this._rootMotion.position.y += this._rootMotion.verticalVelocity * dt;

    // Ground contact.
    if (this._rootMotion.position.y <= 0 && !this._underwater) {
      this._rootMotion.position.y = 0;
      this._rootMotion.verticalVelocity = 0;
      if (!this._monsterStats.grounded) {
        this._transitionTo(this._animRegistry.getId('land'));
      }
      this._monsterStats.grounded = 1;
      this._airborne = 0;
    }

    // ── facing ──────────────────────────────────────────
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

    // ── speed ───────────────────────────────────────────
    this._monsterStats.speed = Math.sqrt(speedSq);
    this._monsterStats.moving = this._monsterStats.speed > 0.2 ? 1 : 0;

    // ── stamina ─────────────────────────────────────────
    if (this._monsterStats.speed > 4 || this._rageTier >= RAGE_TIER.ENRAGED) {
      this._monsterStats.stamina = Math.max(0, this._monsterStats.stamina - dt * 5);
    } else {
      this._monsterStats.stamina = Math.min(this._monsterStats.maxStamina,
        this._monsterStats.stamina + dt * 3);
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── breath / AoE / regen updates ────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateCombatTimers(dt) {
    if (this._breathTimer > 0) this._breathTimer -= dt;
    if (this._roarTimer > 0) this._roarTimer -= dt;
    if (this._aoeTimer > 0) this._aoeTimer -= dt;

    // Breath firing.
    if (this._breathActive) {
      this._breathFireTime += dt;
      this._breathLightIntensity = Math.min(1, this._breathFireTime * 2);
      if (this._breathFireTime >= this._breathFireDuration) {
        this._breathActive = 0;
        this._breathFireTime = 0;
        this._breathLightIntensity = 0;
      } else {
        // Emit periodic breath hits.
        if (this._dispatcher && Math.random() < dt * 5) {
          const breathPos = this._jointRegistry.getIndex('BREATH_NODE');
          const wp = breathPos >= 0 ? this._nodes[breathPos].worldPos : this._rootMotion.position;
          this._dispatcher.queueCausalEvent(
            EVENT_TYPE.IMPACT,
            [wp.x, wp.y, wp.z],
            this.breathWeaponType, 30, 1.0,
            { kind: 'breath_hit', type: this.breathWeaponType }
          );
          this._stats.causalEventsEmitted++;
        }
      }
    } else {
      // Charge decay.
      if (this._breathCharging > 0) {
        this._breathCharging = Math.max(0, this._breathCharging - dt * 0.5);
      }
      this._breathLightIntensity = this._chestBreathBuildup * 2.0;
    }

    // Regeneration (only outside combat, i.e. no recent hits).
    if (this._hitStaggerTimer <= 0 && this._breathActive === 0) {
      const regen = _monsterProcReg.get('regen');
      if (this._monsterStats.stamina > regen.staminaCost) {
        this._monsterStats.health = Math.min(this._monsterStats.maxHealth,
          this._monsterStats.health + regen.healthPerSec * dt);
        this._monsterStats.stamina = Math.max(0,
          this._monsterStats.stamina - regen.staminaCost * dt);
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── causal reactions ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _readCausal(frame) {
    const causal = frame.layers.causal;
    if (!causal || !causal.derivedSignals) return;
    const s = causal.derivedSignals;
    for (let i = 0; i < s.count; i++) {
      if (s.types[i] === DERIVED_SIGNAL.LIGHT_FLICKER && s.forces[i] > 60) {
        // Large impact → take damage, gain rage.
        if (this._hitStaggerTimer <= 0) {
          this._hitStaggerTimer = 0.3;
          this._transitionTo(this._animRegistry.getId('hit'));
          this._monsterStats.health = Math.max(0, this._monsterStats.health - s.forces[i] * 0.2);
          this.addRage(0.08);
          this._updateBossPhase();
        }
      }
      if (s.types[i] === DERIVED_SIGNAL.IGNITE_CANDIDATE && s.forces[i] > 100) {
        this.addRage(0.15);
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── equipment ───────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  equipItem(slot, item) {
    if (slot < 0 || slot >= EQUIP_SLOT.COUNT) return false;
    this._equipment[slot] = item;
    this._equipmentMass[slot] = item.mass || 20.0;
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
  // ─── input / API ─────────────────────────────────────────
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
      const map = {
        flFoot: 0, frFoot: 1, rlFoot: 2, rrFoot: 3,
        lWing: 4, rWing: 5, jaw: 6, tail: 7
      };
      this._ikWeights[map[which]] = weight;
    }
    return this;
  }

  setLookAtTarget(target, active = true) {
    this._lookAtTarget.copy(target);
    this._lookAtActive = active ? 1 : 0;
    return this;
  }

  setTarget(entityId, position) {
    this._targetEntityId = entityId;
    this._targetPosition.copy(position);
    this._targetActive = 1;
    this._monsterStats.aggro = 1;
    return this;
  }

  clearTarget() {
    this._targetEntityId = -1;
    this._targetActive = 0;
    this._monsterStats.aggro = 0;
    return this;
  }

  // ── deformation API ──────────────────────────────────────
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
  // ─── main update ─────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  update(frame, clock) {
    if (!frame || !frame.layers || !frame.layers.player) return 0;
    const now = clock ? clock.elapsedSeconds : performance.now() / 1000;
    if (now - this._lastUpdateTime < 1 / 60) return 0;
    const dt = Math.min(0.05, now - (this._lastUpdateTime > 0 ? this._lastUpdateTime : now - 1 / 60));
    this._lastUpdateTime = now;
    this._frameRef = frame;

    // 1. Causal reactions (damage, rage gain)
    this._readCausal(frame);
    if (this._hitStaggerTimer > 0) this._hitStaggerTimer -= dt;

    // 2. Root motion
    this._updateRootMotion(dt);

    // 3. Rage / boss phase
    this._updateRage(dt);
    this._updateBossPhase();

    // 4. Combat timers (breath, roar, AoE, regen)
    this._updateCombatTimers(dt);

    // 5. Fear aura (periodic causal emission)
    this._updateFearAura(dt, frame);

    // 6. GOAP
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

    // 7. Animation state + blend
    this._updateAnimationState(dt);
    this._stateBlend = Math.min(1.0, this._stateBlend + this.stateBlendRate * dt);

    // 8. Procedural overlays
    this._updateBreathing(dt);
    this._updateBodyWave(dt);
    this._updateTailWhip(dt);
    this._updateWingFlap(dt);
    this._updateJawSnarl(dt);
    this._updateChestBreathBuildup(dt);
    this._updateSpringBones(dt);

    // 9. Motion matching
    if (this.motionMatchingEnabled) {
      this._currentMatchIndex = this._motionDB.findNearest(
        this._rootMotion.position, this._rootMotion.velocity,
        new Vec3(this._rootMotion.velocity.x, 0, this._rootMotion.velocity.z),
        this._currentState
      );
      if (this._currentMatchIndex >= 0) {
        this._currentMatchTime = this.motionDB ? this.motionDB.times[this._currentMatchIndex] : 0;
        this._stats.motionMatches++;
      }
    }

    // 10. Deformation overlays
    this._deformation.update(dt, this._nodes, this._jointEmissive);
    this._stats.deformationsApplied++;

    // 11. FK → IK → FK
    this._updateFK();
    this._updateFootIK(this.ikWeight);
    this._updateWingIK(this.ikWeight);
    this._updateJawIK(this.ikWeight);
    this._updateTailIK(this.ikWeight);
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

  // ══════════════════════════════════════════════════════════
  // ─── frame writes ────────────────────────────────────────
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

    player.health = this._monsterStats.health;
    player.mana = 0;
    player.stamina = this._monsterStats.stamina;
    player.focusDistance = this._monsterStats.focusDistance;
    player.species = this.speciesName;
    player.rageTier = this._rageTier;
    player.rageMeter = this._rageMeter;
    player.bossPhase = this._bossPhase;
    player.aggro = this._monsterStats.aggro;
    player.breathWeaponType = this.breathWeaponType;
    player.breathActive = this._breathActive;
    player.breathCharge = this._chestBreathBuildup;

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
    let totalMass = this._monsterStats.bodyMass;
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

    // ── Breath weapon light emission ─────────────────────
    if (!p.monsterBreathLights) {
      p.monsterBreathLights = { count: 0, positions: [], colors: [], intensities: [] };
    }
    const breathLights = p.monsterBreathLights;
    breathLights.count = 0;
    breathLights.positions.length = 0;
    breathLights.colors.length = 0;
    breathLights.intensities.length = 0;

    const breathNodeIdx = this._jointRegistry.getIndex('BREATH_NODE');
    if (breathNodeIdx >= 0 && this._breathLightIntensity > 0.05) {
      const wp = this._nodes[breathNodeIdx].worldPos;
      breathLights.positions.push(wp.x, wp.y, wp.z);
      breathLights.colors.push(this._breathLightColor[0], this._breathLightColor[1], this._breathLightColor[2]);
      breathLights.intensities.push(this._breathLightIntensity);
      breathLights.count = 1;
    }

    p.playerJointEmissive = this._jointEmissive;
    p.playerBalloonScale = this._deformation.balloonScale;
    p.playerRageTier = this._rageTier;
    p.playerRageMeter = this._rageMeter;
    p.playerBossPhase = this._bossPhase;
    p.playerSpeed = this._monsterStats.speed;
    p.playerBreathActive = this._breathActive;
    p.playerBreathType = this.breathWeaponType;
  }

  // ── accessors ────────────────────────────────────────────
  attachDispatcher(d) { this._dispatcher = d; return this; }
  get currentState() { return this._currentState; }
  get currentStateName() { return this._animRegistry.getName(this._currentState); }
  get monsterStats() { return this._monsterStats; }
  get rootPosition() { return this._rootMotion.position; }
  get jointNodes() { return this._nodes; }
  get goapPlan() { return this._goapPlan; }
  get goapWorldState() { return this._goapWorldState; }
  get jointCount() { return this._jointCount; }
  get rageTier() { return this._rageTier; }
  get bossPhase() { return this._bossPhase; }
  get breathActive() { return this._breathActive === 1; }

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
    this._armorPlates.length = 0;
    this._weakPoints.length = 0;
  }
}

export {
  MonsterContextProvider,
  MONSTER_ROOT_MOTION_PROFILES,
  BREATH_WEAPON,
  RAGE_TIER,
  BOSS_PHASE,
  _monsterJointReg as MONSTER_JOINT_REGISTRY,
  _monsterAnimReg as MONSTER_ANIM_REGISTRY,
  _monsterGoapReg as MONSTER_GOAP_REGISTRY,
  _monsterProcReg as MONSTER_PROC_REGISTRY
};