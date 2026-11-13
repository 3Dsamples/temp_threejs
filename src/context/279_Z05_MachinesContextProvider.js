// file number : 279_Z05
// full path name : src/context/279_Z05_MachinesContextProvider.js
// description : Machine / construct context provider — a specialized controller for mechs, drones, turrets, vehicles (wheeled, tracked, hover), androids, androids-golems, and modular combat platforms. Built on the same registries, IK stack, root-motion controller, motion-matching database, and deformation overlays as 279_PlayerContextProvider and the 279_Z01..04 creature providers. Defines a configurable mechanical skeleton (base/chassis, turret with yaw/pitch, articulated arms with grippers/tools, wheel/tread stacks with rotational IK, sensor mast with radar/lidar/thermal cameras, antennae, engine nozzles, armor plates) that can be swapped at runtime for any machine class. Provides machine-specific root-motion profiles: idle, patrol, drive, reverse, turn, sprint, brake, hover, hover-drift, fly, dive, land, takeoff, tilt, and limp (damaged locomotion). Provides mechanical IK: wheel-ground conforming, tread tension, turret world-pointing, arm reach-to-target, gripper grasp, and tool alignment. Provides sensor suite processing: radar sweep, lidar ray bundle, thermal tracking, and threat assessment. Provides a modular damage system (intact → scratched → damaged → critical → destroyed) with per-component health, EMP sensitivity, and repair-by-parts. Provides power management (battery/fuel drain, recharge rate, brown-out effects). Provides machine-to-machine networking (peer broadcast, target handoff, formation coordination). Provides GOAP actions for patrol, engage, retreat, repair, recharge, network, hack, and hack-defend. Provides motion-matching samples per locomotion profile. Provides procedural overlays for servo jitter, antenna wobble, hover-bob, tread dust, engine exhaust, and heat/fire/EMP deformation. Emits causal events on weapon-fire, sensor-ping, alarm, system-damage, self-destruct, network-broadcast, and power-down. Consumes causal events for damage, EMP, hack attempts, and target handoff. Writes pose, velocity, focus distance, stats, skeleton transforms, weapon state, sensor state, network state, and light-eligible emissive flags into frame.layers.player and frame.layers.physical using the same contract as 279 so downstream systems require no changes.
// best for : Populating every machine entity in the living world — enemy mechs, allied drones, turrets, vehicles, androids, ancient golems — with realistic locomotion, sensors, combat, networking, and damage behaviour. Feeds the combat, ecology (as predators or prey), clustered-lighting, camera-shake, and network systems. Complements 279 (humanoid), 279_Z01 (bird), 279_Z02 (fish), 279_Z03 (quadruped), and 279_Z04 (monster) so every living archetype shares the same registries and context-frame contract.
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
  SpatialHashGrid,
  Raycaster
} from './264_MathECSImportBarrel.js';

import {
  JointRegistry, AnimStateRegistry, GoapBitRegistry, ProceduralParamRegistry,
  JointNode, RootMotionController, MotionMatchingDatabase, DeformationOverlay,
  TwoBoneIKSolver, CCDIKSolver, FABRIKIKSolver, JacobianIKSolver, HybridIKSolver,
  IK_SOLVER, DEFORM, EQUIP_SLOT, EQUIP_DEFAULT_JOINT
} from './279_PlayerContextProvider.js';

// ══════════════════════════════════════════════════════════════════
// ─── MACHINE REGISTRIES ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

const _machineJointReg = new JointRegistry();
const _machineAnimReg = new AnimStateRegistry();
const _machineGoapReg = new GoapBitRegistry();
const _machineProcReg = new ProceduralParamRegistry();

// ── machine skeleton (mech / vehicle composite template) ───────
function registerMachineJoints(reg) {
  // ── core chassis ───────────────────────────────────────────
  reg.register('ROOT',          null,           [0, 0, 0]);
  reg.register('CHASSIS',       'ROOT',         [0, 0.6, 0]);
  reg.register('CHASSIS_UPPER', 'CHASSIS',      [0, 0.4, 0]);

  // ── turret (yaw + pitch) ──────────────────────────────────
  reg.register('TURRET_YAW',    'CHASSIS_UPPER',[0, 0.35, 0]);
  reg.register('TURRET_PITCH',  'TURRET_YAW',   [0, 0.15, 0.25]);
  reg.register('BARREL_0',      'TURRET_PITCH', [0, 0, 0.45]);
  reg.register('BARREL_1',      'BARREL_0',     [0, 0, 0.35]);
  reg.register('MUZZLE',        'BARREL_1',     [0, 0, 0.20]);

  // ── sensor mast ──────────────────────────────────────────
  reg.register('SENSOR_MAST',   'CHASSIS_UPPER',[0, 0.55, -0.15]);
  reg.register('RADAR_DISH',    'SENSOR_MAST',  [0, 0.20, 0]);
  reg.register('LIDAR_HEAD',    'SENSOR_MAST',  [0, 0.15, 0.10]);
  reg.register('THERMAL_CAM',   'SENSOR_MAST',  [0, 0.15, -0.10]);
  reg.register('ANTENNA_0',     'SENSOR_MAST',  [0.10, 0.10, 0]);
  reg.register('ANTENNA_1',     'ANTENNA_0',    [0.05, 0.15, 0]);

  // ── left arm (3 segments + gripper) ───────────────────────
  reg.register('L_SHOULDER',    'CHASSIS_UPPER',[ 0.45, 0.20, 0]);
  reg.register('L_ELBOW',       'L_SHOULDER',   [ 0.35, 0, 0]);
  reg.register('L_WRIST',       'L_ELBOW',      [ 0.30, 0, 0]);
  reg.register('L_GRIPPER_BASE','L_WRIST',      [ 0.10, 0, 0]);
  reg.register('L_GRIPPER_0',   'L_GRIPPER_BASE',[ 0.05, 0.03, 0]);
  reg.register('L_GRIPPER_1',   'L_GRIPPER_BASE',[ 0.05, -0.03, 0]);
  reg.register('L_TOOL_ATTACH', 'L_GRIPPER_BASE',[ 0.10, 0, 0]);

  // ── right arm ────────────────────────────────────────────
  reg.register('R_SHOULDER',    'CHASSIS_UPPER',[-0.45, 0.20, 0]);
  reg.register('R_ELBOW',       'R_SHOULDER',   [-0.35, 0, 0]);
  reg.register('R_WRIST',       'R_ELBOW',      [-0.30, 0, 0]);
  reg.register('R_GRIPPER_BASE','R_WRIST',      [-0.10, 0, 0]);
  reg.register('R_GRIPPER_0',   'R_GRIPPER_BASE',[-0.05, 0.03, 0]);
  reg.register('R_GRIPPER_1',   'R_GRIPPER_BASE',[-0.05, -0.03, 0]);
  reg.register('R_TOOL_ATTACH', 'R_GRIPPER_BASE',[-0.10, 0, 0]);

  // ── wheels (per side, front / mid / rear) ────────────────
  // Each wheel is a spinning rotor with a fixed axle mount.
  const wheelPositions = {
    FL: [ 0.55, -0.15,  0.65], ML: [ 0.55, -0.15, 0.00], RL: [ 0.55, -0.15, -0.65],
    FR: [-0.55, -0.15,  0.65], MR: [-0.55, -0.15, 0.00], RR: [-0.55, -0.15, -0.65]
  };
  for (const [key, pos] of Object.entries(wheelPositions)) {
    reg.register(`WHEEL_${key}_MOUNT`, 'CHASSIS', pos);
    reg.register(`WHEEL_${key}`,       `WHEEL_${key}_MOUNT`, [0, 0, 0]);
  }

  // ── treads (for tracked vehicles) ────────────────────────
  reg.register('TREAD_L_MOUNT', 'CHASSIS', [ 0.55, -0.20, 0]);
  reg.register('TREAD_L_0',     'TREAD_L_MOUNT', [ 0.10, 0, 0.60]);
  reg.register('TREAD_L_1',     'TREAD_L_0',     [ 0, 0, -1.20]);
  reg.register('TREAD_R_MOUNT', 'CHASSIS', [-0.55, -0.20, 0]);
  reg.register('TREAD_R_0',     'TREAD_R_MOUNT', [-0.10, 0, 0.60]);
  reg.register('TREAD_R_1',     'TREAD_R_0',     [ 0, 0, -1.20]);

  // ── engine / exhaust nozzles ─────────────────────────────
  reg.register('ENGINE_0',      'CHASSIS',      [ 0.30, 0.05, -0.60]);
  reg.register('ENGINE_1',      'CHASSIS',      [-0.30, 0.05, -0.60]);
  reg.register('THRUSTER_FL',   'CHASSIS',      [ 0.55, -0.10, -0.40]);
  reg.register('THRUSTER_FR',   'CHASSIS',      [-0.55, -0.10, -0.40]);

  // ── armor plates (attachable) ────────────────────────────
  reg.register('PLATE_FRONT',   'CHASSIS',      [0, 0.10, 0.85]);
  reg.register('PLATE_REAR',    'CHASSIS',      [0, 0.10, -0.85]);
  reg.register('PLATE_L',       'CHASSIS',      [0.70, 0.10, 0]);
  reg.register('PLATE_R',       'CHASSIS',      [-0.70, 0.10, 0]);
  reg.register('PLATE_TOP',     'CHASSIS_UPPER',[0, 0.30, 0]);

  // ── attachment bones (saddle, cargo, rider, harpoint) ────
  reg.register('HEAD_ATTACH',    'SENSOR_MAST',  [0, 0.20, 0]);
  reg.register('CHEST_ATTACH',   'CHASSIS_UPPER',[0, 0.25, 0]);
  reg.register('BACK_ATTACH',    'CHASSIS',      [0, 0.30, -0.30]);
  reg.register('PELVIS_ATTACH',  'CHASSIS',      [0, 0.05, 0]);
  reg.register('SADDLE_ATTACH',  'CHASSIS_UPPER',[0, 0.35, -0.20]);
  reg.register('CARGO_ATTACH',   'CHASSIS',      [0, 0.30, -0.50]);
  reg.register('HARDPOINT_0',    'CHASSIS_UPPER',[ 0.35, 0.20, 0]);
  reg.register('HARDPOINT_1',    'CHASSIS_UPPER',[-0.35, 0.20, 0]);

  reg.freezeBuiltins();
}
registerMachineJoints(_machineJointReg);

// ── machine animation states ────────────────────────────────
[
  ['idle', 0], ['power_up', 1], ['power_down', 2],
  ['patrol', 3], ['drive', 4], ['reverse', 5], ['turn_left', 6], ['turn_right', 7],
  ['sprint', 8], ['brake', 9], ['limp', 10], ['stuck', 11],
  ['scan', 12], ['target_acquire', 13], ['track_target', 14],
  ['weapon_fire', 15], ['weapon_reload', 16], ['weapon_overheat', 17],
  ['missile_launch', 18], ['melee_strike', 19], ['shield_up', 20],
  ['repair', 21], ['recharge', 22], ['self_destruct', 23],
  ['hover', 24], ['hover_drift', 25], ['fly', 26], ['dive', 27], ['land', 28], ['takeoff', 29],
  ['damaged', 30], ['critical', 31], ['destroyed', 32], ['reboot', 33],
  ['hack_attempt', 34], ['hack_defend', 35], ['network_broadcast', 36],
  ['hit', 37], ['death', 38]
].forEach(([name, priority]) => _machineAnimReg.register(name, priority));

// ── machine GOAP bits ───────────────────────────────────────
[
  'HAS_TARGET', 'IN_RANGE', 'HAS_LOS', 'TARGET_VISIBLE', 'TARGET_LOCKED',
  'IS_GROUNDED', 'IS_HOVERING', 'IS_FLYING',
  'IS_MOVING', 'IS_STUCK', 'IS_DAMAGED', 'IS_CRITICAL', 'IS_DESTROYED',
  'POWER_HIGH', 'POWER_LOW', 'WEAPON_READY', 'WEAPON_OVERHEAT',
  'SHIELD_UP', 'CAN_REPAIR', 'IN_NETWORK', 'NETWORK_ALERT',
  'IS_HACKED', 'IS_HACKING', 'THREAT_DETECTED', 'ALLY_NEARBY',
  'NEED_REINFORCEMENT', 'NEED_RETREAT'
].forEach(n => _machineGoapReg.register(n));

// ── machine procedural parameters ───────────────────────────
_machineProcReg.register('servoJitter',      { amplitude: 0.008, frequency: 12.0 });
_machineProcReg.register('antennaWobble',    { amplitude: 0.05,  frequency: 1.8 });
_machineProcReg.register('radarSweep',       { rate: 1.0,               // sweeps per second
                                               beamWidth: 0.15 });
_machineProcReg.register('hoverBob',         { amplitude: 0.03,         frequency: 1.5 });
_machineProcReg.register('treadDust',        { rate: 5.0,               lifetime: 0.8 });
_machineProcReg.register('engineExhaust',    { rate: 8.0,               lifetime: 0.6 });
_machineProcReg.register('heat',             { emissivePerC: 0.012,     colorShiftPerC: 0.010 });
_machineProcReg.register('fire',             { spreadRate: 0.8,         emissiveMax: 4.0 });
_machineProcReg.register('emp',              { recoveryPerSec: 0.4,     jitterIntensity: 0.5 });
_machineProcReg.register('weaponCharge',     { buildupRate: 4.0,        decayRate: 2.5 });

// ── weapon types ────────────────────────────────────────────
const WEAPON_TYPE = Object.freeze({
  NONE:           0,
  KINETIC:        1,    // machine gun, autocannon
  LASER:          2,    // continuous beam
  PLASMA:         3,    // projectile plasma
  MISSILE:        4,    // guided missile
  RAILGUN:        5,    // single high-damage shot
  EMP_BURST:      6,    // electronic warfare
  FLAMER:         7,    // short-range flame
  TESLA:          8     // chain lightning
});

// ── damage states ───────────────────────────────────────────
const DAMAGE_STATE = Object.freeze({
  INTACT:    0,   // full health
  SCRATCHED: 1,   // 75%-100%
  DAMAGED:   2,   // 40%-75%
  CRITICAL:  3,   // 10%-40%
  DESTROYED: 4    // 0%
});

// ── power source types ──────────────────────────────────────
const POWER_SOURCE = Object.freeze({
  BATTERY:    0,
  FUSION:     1,
  SOLAR:      2,
  COMBUSTION: 3,
  MANA:       4
});

// ── machine classes ─────────────────────────────────────────
const MACHINE_CLASS = Object.freeze({
  MECH:      0,    // bipedal or quadrupedal mech
  WHEELED:   1,    // wheeled vehicle
  TRACKED:   2,    // tracked vehicle
  HOVER:     3,    // hover vehicle
  FLYING:    4,    // drone / aircraft
  ANDROID:   5,    // humanoid android
  TURRET:    6,    // fixed turret
  GOLEM:     7     // magic-driven golem
});

// ── machine root-motion profiles ────────────────────────────
const MACHINE_ROOT_MOTION_PROFILES = Object.freeze({
  idle:     { maxSpeed: 0.0,  acceleration: 2,  angularAcceleration: 2,  gravityScale: 1.0, jumpImpulse: 0,   bodyPitch: 0.0 },
  patrol:   { maxSpeed: 2.5,  acceleration: 5,  angularAcceleration: 3,  gravityScale: 1.0, jumpImpulse: 0,   bodyPitch: 0.0 },
  drive:    { maxSpeed: 6.0,  acceleration: 8,  angularAcceleration: 4,  gravityScale: 1.0, jumpImpulse: 0,   bodyPitch: -0.03 },
  reverse:  { maxSpeed: 3.0,  acceleration: 4,  angularAcceleration: 3,  gravityScale: 1.0, jumpImpulse: 0,   bodyPitch: 0.02 },
  turn:     { maxSpeed: 1.5,  acceleration: 3,  angularAcceleration: 8,  gravityScale: 1.0, jumpImpulse: 0,   bodyPitch: 0.0 },
  sprint:   { maxSpeed: 12.0, acceleration: 15, angularAcceleration: 6,  gravityScale: 1.0, jumpImpulse: 0,   bodyPitch: -0.10 },
  brake:    { maxSpeed: 0.5,  acceleration: 20, angularAcceleration: 10, gravityScale: 1.0, jumpImpulse: 0,   bodyPitch: 0.05 },
  limp:     { maxSpeed: 2.0,  acceleration: 3,  angularAcceleration: 2,  gravityScale: 1.0, jumpImpulse: 0,   bodyPitch: -0.05 },
  hover:    { maxSpeed: 4.0,  acceleration: 6,  angularAcceleration: 4,  gravityScale: 0.0, jumpImpulse: 0,   bodyPitch: 0.0 },
  hover_drift: { maxSpeed: 8.0, acceleration: 8, angularAcceleration: 5, gravityScale: 0.0, jumpImpulse: 0,  bodyPitch: 0.0 },
  fly:      { maxSpeed: 15.0, acceleration: 10, angularAcceleration: 5,  gravityScale: 0.0, jumpImpulse: 0,   bodyPitch: -0.15 },
  dive:     { maxSpeed: 25.0, acceleration: 20, angularAcceleration: 8,  gravityScale: 1.0, jumpImpulse: 0,   bodyPitch: -0.35 },
  takeoff:  { maxSpeed: 8.0,  acceleration: 12, angularAcceleration: 4,  gravityScale: 0.9, jumpImpulse: 12.0, bodyPitch: 0.15 },
  land:     { maxSpeed: 1.0,  acceleration: 3,  angularAcceleration: 3,  gravityScale: 1.0, jumpImpulse: 0,   bodyPitch: 0.10 }
});

// ══════════════════════════════════════════════════════════════════
// ─── MACHINE PROVIDER ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

class MachinesContextProvider {
  constructor(options = {}) {
    // ── config ──────────────────────────────────────────────
    this.ikWeight = options.ikWeight ?? 1.0;
    this.lookAtWeight = options.lookAtWeight ?? 1.0;
    this.turretIKEnabled = options.turretIKEnabled ?? true;
    this.armIKEnabled = options.armIKEnabled ?? true;
    this.wheelIKEnabled = options.wheelIKEnabled ?? true;
    this.proceduralEnabled = options.proceduralEnabled ?? true;
    this.motionMatchingEnabled = options.motionMatchingEnabled ?? true;
    this.goapEnabled = options.goapEnabled ?? true;
    this.goapReplanInterval = options.goapReplanInterval ?? 0.3;
    this.stateBlendRate = options.stateBlendRate ?? 10.0;
    this.defaultIkSolver = options.defaultIkSolver ?? IK_SOLVER.HYBRID;
    this.machineClass = options.machineClass ?? MACHINE_CLASS.MECH;
    this.speciesName = options.speciesName ?? 'generic-machine';
    this.bodyScale = options.bodyScale ?? 1.0;

    // ── combat ─────────────────────────────────────────────
    this.primaryWeapon = options.primaryWeapon ?? WEAPON_TYPE.KINETIC;
    this.secondaryWeapon = options.secondaryWeapon ?? WEAPON_TYPE.MISSILE;
    this.weaponCooldown = options.weaponCooldown ?? 0.4;
    this.weaponRange = options.weaponRange ?? 35.0;
    this.weaponHeatRate = options.weaponHeatRate ?? 0.10;
    this.weaponCoolRate = options.weaponCoolRate ?? 0.05;
    this.weaponOverheatThreshold = options.weaponOverheatThreshold ?? 1.0;
    this.missileCooldown = options.missileCooldown ?? 6.0;
    this.empCooldown = options.empCooldown ?? 15.0;

    // ── sensor suite ───────────────────────────────────────
    this.radarRange = options.radarRange ?? 60.0;
    this.lidarRange = options.lidarRange ?? 40.0;
    this.thermalRange = options.thermalRange ?? 50.0;
    this.sensorSweepInterval = options.sensorSweepInterval ?? 0.2;

    // ── power ──────────────────────────────────────────────
    this.powerSource = options.powerSource ?? POWER_SOURCE.FUSION;
    this.maxPower = options.maxPower ?? 1000;
    this.powerDrainIdle = options.powerDrainIdle ?? 1.0;
    this.powerDrainActive = options.powerDrainActive ?? 5.0;
    this.powerDrainWeapon = options.powerDrainWeapon ?? 15.0;
    this.powerRechargeRate = options.powerRechargeRate ?? 8.0;

    // ── weapon / power state ───────────────────────────────
    this._weaponTimer = 0;
    this._missileTimer = 0;
    this._empTimer = 0;
    this._weaponHeat = 0;
    this._weaponOverheat = 0;
    this._weaponCharge = 0;
    this._power = this.maxPower;
    this._sensorSweepTimer = 0;

    // ── damage state ───────────────────────────────────────
    this._damageState = DAMAGE_STATE.INTACT;
    this._components = [];      // per-joint component health
    this._empActive = 0;         // 0..1, decays over time
    this._hacked = 0;
    this._selfDestructTimer = -1;

    // ── joint registry ────────────────────────────────────
    this._jointRegistry = options.jointRegistry || _machineJointReg;
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
    this._initComponents();

    // ── IK targets ─────────────────────────────────────────
    this._ikTargets = {
      lArm: new Vec3(), rArm: new Vec3(),
      turretTarget: new Vec3(),
      flWheel: new Vec3(), frWheel: new Vec3(),
      rlWheel: new Vec3(), rrWheel: new Vec3(),
      muzzleTarget: new Vec3()
    };
    this._ikWeights = new Float32Array(8);
    this._ikSolvers = {
      lArm: IK_SOLVER.HYBRID,
      rArm: IK_SOLVER.HYBRID,
      turret: IK_SOLVER.JACOBIAN,
      wheel: IK_SOLVER.TWO_BONE,
      muzzle: IK_SOLVER.FABRIK
    };

    // ── look-at ────────────────────────────────────────────
    this._lookAtTarget = new Vec3();
    this._lookAtActive = 0;

    // ── root motion ────────────────────────────────────────
    this._rootMotion = new RootMotionController('idle');
    this._rootMotion.profile = MACHINE_ROOT_MOTION_PROFILES['idle'];
    this._rootMotion.profileName = 'idle';
    this._rootPosition = this._rootMotion.position;
    this._rootVelocity = this._rootMotion.velocity;
    this._rootQuat = this._rootMotion.quat;
    this._airborne = 0;
    this._hovering = 0;

    // ── wheel rotation tracking ───────────────────────────
    this._wheelRotations = new Float32Array(6);  // FL, ML, RL, FR, MR, RR
    this._treadOffset = new Float32Array(2);     // L, R

    // ── turret aim ─────────────────────────────────────────
    this._turretYaw = 0;
    this._turretPitch = 0;
    this._targetTurretYaw = 0;
    this._targetTurretPitch = 0;

    // ── equipment (weapons, cargo, modules) ────────────────
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
        : i === EQUIP_SLOT.BACK ? 'BACK_ATTACH'
        : i === EQUIP_SLOT.HEAD ? 'HEAD_ATTACH'
        : i === EQUIP_SLOT.MAIN_HAND ? 'L_TOOL_ATTACH'
        : i === EQUIP_SLOT.OFF_HAND ? 'R_TOOL_ATTACH'
        : i === EQUIP_SLOT.LEGS ? 'PELVIS_ATTACH'
        : i === EQUIP_SLOT.FEET ? 'PELVIS_ATTACH'
        : 'CARGO_ATTACH';
      this._equipmentAttachJoint[i] = this._jointRegistry.getIndex(name);
    }

    // ── animation state ────────────────────────────────────
    this._animRegistry = options.animRegistry || _machineAnimReg;
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
    this._servoPhase = 0;
    this._antennaPhase = 0;
    this._radarPhase = 0;
    this._hoverPhase = 0;
    this._hitStaggerTimer = 0;
    this._deformation = new DeformationOverlay();

    // ── spring bones ──────────────────────────────────────
    this._springBones = {
      antennaTip:    { position: new Vec3(), velocity: new Vec3(), target: new Vec3(), active: 1 },
      radarTip:      { position: new Vec3(), velocity: new Vec3(), target: new Vec3(), active: 1 },
      lArmTip:       { position: new Vec3(), velocity: new Vec3(), target: new Vec3(), active: 1 },
      rArmTip:       { position: new Vec3(), velocity: new Vec3(), target: new Vec3(), active: 1 }
    };

    // ── network (peer communication) ──────────────────────
    this._networkId = options.networkId ?? (Math.random() * 0xFFFFFFFF) | 0;
    this._peers = new Map();
    this._broadcastTimer = 0;
    this._broadcastInterval = 1.0;
    this._networkAlert = 0;

    // ── sensor tracking ────────────────────────────────────
    this._radarContacts = [];
    this._lidarContacts = [];
    this._thermalContacts = [];
    this._radarMaxContacts = 16;
    this._lidarMaxContacts = 8;
    this._thermalMaxContacts = 8;
    this._threatLevel = 0;
    this._targetEntityId = -1;
    this._targetPosition = new Vec3();
    this._targetActive = 0;
    this._targetLocked = 0;

    // ── GOAP ──────────────────────────────────────────────
    this._goapRegistry = options.goapRegistry || _machineGoapReg;
    this._goapGoals = [];
    this._goapActions = [];
    this._goapWorldState = 0;
    this._goapPlan = [];
    this._goapPlanIndex = 0;
    this._goapReplanTimer = 0;
    this._goapBestGoal = -1;

    // ── machine stats ─────────────────────────────────────
    this._machineStats = {
      health: 800, maxHealth: 800,
      armor: 400, maxArmor: 400,
      shield: 100, maxShield: 100,
      focusDistance: 40,
      length: 4.5,
      height: 2.5,
      bodyMass: 2500.0,           // kg
      speed: 0,
      grounded: 1,
      moving: 0,
      power: this._power,
      maxPower: this.maxPower,
      threatLevel: 0,
      damageState: DAMAGE_STATE.INTACT
    };

    // ── input ─────────────────────────────────────────────
    this._input = {
      moveX: 0, moveY: 0, lookX: 0, lookY: 0,
      jump: 0, sprint: 0, brake: 0, reverse: 0,
      fire_primary: 0, fire_secondary: 0, fire_emp: 0,
      repair: 0, recharge: 0, self_destruct: 0,
      takeoff: 0, land: 0, hack: 0, broadcast: 0
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
    this._tmpRaycaster = new Raycaster();

    // ── joint emissive ────────────────────────────────────
    this._jointEmissive = new Float32Array(jointCount);

    // ── muzzle flash / fire lights ────────────────────────
    this._muzzleFlashIntensity = 0;
    this._muzzleFlashColor = [1.0, 0.8, 0.3];
    this._thrusterIntensity = 0;

    // ── timing / stats ───────────────────────────────────
    this._lastUpdateTime = -Infinity;
    this._updateCount = 0;
    this._dispatcher = options.dispatcher || null;
    this._frameRef = null;

    this._stats = {
      updates: 0, plansExecuted: 0, plansRejected: 0,
      ikEvaluations: 0, motionMatches: 0, springUpdates: 0,
      stateTransitions: 0, causalEventsEmitted: 0, deformationsApplied: 0,
      shotsFired: 0, missilesFired: 0, empBursts: 0, repairs: 0,
      radarSweeps: 0, lidarScans: 0, thermalScans: 0,
      networkBroadcasts: 0, hacksAttempted: 0, hacksSucceeded: 0
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── component / damage model ────────────────────────────
  // ══════════════════════════════════════════════════════════
  _initComponents() {
    const componentNames = [
      'CHASSIS', 'TURRET_YAW', 'BARREL_0', 'BARREL_1',
      'L_SHOULDER', 'L_ELBOW', 'R_SHOULDER', 'R_ELBOW',
      'SENSOR_MAST', 'RADAR_DISH', 'LIDAR_HEAD',
      'ENGINE_0', 'ENGINE_1'
    ];
    for (const name of componentNames) {
      const idx = this._jointRegistry.getIndex(name);
      if (idx >= 0) {
        this._components.push({
          jointIdx: idx, name, health: 100, maxHealth: 100, destroyed: 0
        });
      }
    }
  }

  damageComponent(jointName, amount) {
    for (const comp of this._components) {
      if (comp.name === jointName) {
        comp.health = Math.max(0, comp.health - amount);
        if (comp.health <= 0 && !comp.destroyed) {
          comp.destroyed = 1;
          this._onComponentDestroyed(comp);
        }
        this._updateDamageState();
        return comp.health;
      }
    }
    return -1;
  }

  _onComponentDestroyed(comp) {
    if (this._dispatcher) {
      const joint = this._nodes[comp.jointIdx];
      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.IMPACT,
        [joint.worldPos.x, joint.worldPos.y, joint.worldPos.z],
        -1, 50, 1.0,
        { kind: 'component_destroyed', name: comp.name, species: this.speciesName }
      );
      this._stats.causalEventsEmitted++;
    }
  }

  _updateDamageState() {
    const healthPercent = this._machineStats.health / this._machineStats.maxHealth;
    let newState = DAMAGE_STATE.INTACT;
    if (healthPercent <= 0) newState = DAMAGE_STATE.DESTROYED;
    else if (healthPercent < 0.10) newState = DAMAGE_STATE.CRITICAL;
    else if (healthPercent < 0.40) newState = DAMAGE_STATE.DAMAGED;
    else if (healthPercent < 0.75) newState = DAMAGE_STATE.SCRATCHED;

    if (newState !== this._damageState) {
      this._damageState = newState;
      this._machineStats.damageState = newState;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── sensor suite ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateSensors(dt, frame) {
    this._sensorSweepTimer -= dt;
    if (this._sensorSweepTimer > 0) return;
    this._sensorSweepTimer = this.sensorSweepInterval;

    // ── Radar sweep ──────────────────────────────────────
    this._radarPhase += dt * _machineProcReg.get('radarSweep').rate;
    if (this._radarPhase >= 1) this._radarPhase -= 1;
    this._stats.radarSweeps++;

    const radarRangeSq = this.radarRange * this.radarRange;
    const pos = this._rootMotion.position;
    const contactCount = Math.min(this._radarContacts.length, this._radarMaxContacts);

    // Read nearby entities from the frame's spatial layer.
    const spatial = frame.layers.spatial;
    const radarContacts = [];
    if (spatial && spatial.sphere) {
      const sphere = spatial.sphere;
      const n = Math.min(spatial.sphere.length / 4, 256);
      for (let i = 0; i < n && radarContacts.length < this._radarMaxContacts; i++) {
        const o = i * 4;
        const sx = sphere[o], sy = sphere[o + 1], sz = sphere[o + 2];
        const dx = sx - pos.x, dy = sy - pos.y, dz = sz - pos.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < radarRangeSq && d2 > 1.0) {
          radarContacts.push({ id: i, x: sx, y: sy, z: sz, d2 });
        }
      }
    }
    this._radarContacts = radarContacts;

    // ── Lidar scan ───────────────────────────────────────
    this._stats.lidarScans++;
    const lidarRangeSq = this.lidarRange * this.lidarRange;
    const lidarContacts = [];
    if (spatial && spatial.sphere) {
      const sphere = spatial.sphere;
      const n = Math.min(spatial.sphere.length / 4, 256);
      // Lidar only sees forward cone (dot product with facing > 0).
      const fwd = this._tmpVecA.set(0, 0, 1).applyQuaternion(this._rootMotion.quat);
      for (let i = 0; i < n && lidarContacts.length < this._lidarMaxContacts; i++) {
        const o = i * 4;
        const sx = sphere[o], sy = sphere[o + 1], sz = sphere[o + 2];
        const dx = sx - pos.x, dy = sy - pos.y, dz = sz - pos.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < lidarRangeSq && d2 > 1.0) {
          const dot = (dx * fwd.x + dy * fwd.y + dz * fwd.z) / Math.sqrt(d2);
          if (dot > 0.3) {
            lidarContacts.push({ id: i, x: sx, y: sy, z: sz, d2 });
          }
        }
      }
    }
    this._lidarContacts = lidarContacts;

    // ── Thermal scan ─────────────────────────────────────
    this._stats.thermalScans++;
    const thermalRangeSq = this.thermalRange * this.thermalRange;
    const thermalContacts = [];
    if (spatial && spatial.sphere) {
      const sphere = spatial.sphere;
      const n = Math.min(spatial.sphere.length / 4, 256);
      for (let i = 0; i < n && thermalContacts.length < this._thermalMaxContacts; i++) {
        const o = i * 4;
        const sx = sphere[o], sy = sphere[o + 1], sz = sphere[o + 2];
        const dx = sx - pos.x, dy = sy - pos.y, dz = sz - pos.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < thermalRangeSq && d2 > 1.0) {
          thermalContacts.push({ id: i, x: sx, y: sy, z: sz, d2 });
        }
      }
    }
    this._thermalContacts = thermalContacts;

    // ── Threat assessment ─────────────────────────────────
    this._threatLevel = 0;
    for (const c of lidarContacts) {
      if (c.d2 < 400) this._threatLevel = Math.max(this._threatLevel, 3);
      else if (c.d2 < 900) this._threatLevel = Math.max(this._threatLevel, 2);
      else this._threatLevel = Math.max(this._threatLevel, 1);
    }
    this._machineStats.threatLevel = this._threatLevel;

    // Auto-acquire highest-threat target.
    if (!this._targetActive && lidarContacts.length > 0) {
      let best = null;
      for (const c of lidarContacts) {
        if (!best || c.d2 < best.d2) best = c;
      }
      if (best) {
        this._targetActive = 1;
        this._targetEntityId = best.id;
        this._targetPosition.set(best.x, best.y, best.z);
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── weapon systems ──────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateWeapons(dt) {
    if (this._weaponTimer > 0) this._weaponTimer -= dt;
    if (this._missileTimer > 0) this._missileTimer -= dt;
    if (this._empTimer > 0) this._empTimer -= dt;

    // ── Overheat / cooldown ──────────────────────────────
    if (this._weaponOverheat > 0) {
      this._weaponHeat -= dt * this.weaponCoolRate * 2;
      if (this._weaponHeat <= 0.3) this._weaponOverheat = 0;
    } else {
      this._weaponHeat = Math.max(0, this._weaponHeat - dt * this.weaponCoolRate);
    }

    // ── Charge accumulation for charged weapons ──────────
    if (this.primaryWeapon === WEAPON_TYPE.RAILGUN) {
      const p = _machineProcReg.get('weaponCharge');
      if (this._input.fire_primary > 0.1) {
        this._weaponCharge = Math.min(1, this._weaponCharge + dt * p.buildupRate);
      } else {
        this._weaponCharge = Math.max(0, this._weaponCharge - dt * p.decayRate);
      }
    }

    // ── Primary weapon fire ──────────────────────────────
    if (this._input.fire_primary > 0.1 && this._weaponTimer <= 0 &&
        this._weaponOverheat === 0 && this._targetActive) {
      this._firePrimaryWeapon();
    }

    // ── Missile fire ─────────────────────────────────────
    if (this._input.fire_secondary > 0.1 && this._missileTimer <= 0 && this._targetActive) {
      this._fireMissile();
    }

    // ── EMP burst ────────────────────────────────────────
    if (this._input.fire_emp > 0.1 && this._empTimer <= 0) {
      this._fireEMP();
    }
  }

  _firePrimaryWeapon() {
    this._weaponTimer = this.weaponCooldown;
    this._weaponHeat += this.weaponHeatRate;
    if (this._weaponHeat >= this.weaponOverheatThreshold) {
      this._weaponOverheat = 1;
      this._transitionTo(this._animRegistry.getId('weapon_overheat'));
    }
    this._muzzleFlashIntensity = 1.0;
    this._stats.shotsFired++;
    this._transitionTo(this._animRegistry.getId('weapon_fire'));

    // Power drain.
    this._power = Math.max(0, this._power - this.powerDrainWeapon);

    if (this._dispatcher) {
      const muzzleIdx = this._jointRegistry.getIndex('MUZZLE');
      const muzzlePos = muzzleIdx >= 0 ? this._nodes[muzzleIdx].worldPos : this._rootMotion.position;
      let damage = 20;
      if (this.primaryWeapon === WEAPON_TYPE.LASER) damage = 12;
      else if (this.primaryWeapon === WEAPON_TYPE.PLASMA) damage = 35;
      else if (this.primaryWeapon === WEAPON_TYPE.RAILGUN) damage = 100 * this._weaponCharge;
      else if (this.primaryWeapon === WEAPON_TYPE.FLAMER) damage = 8;
      else if (this.primaryWeapon === WEAPON_TYPE.TESLA) damage = 25;

      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.IMPACT,
        [muzzlePos.x, muzzlePos.y, muzzlePos.z],
        -1, damage, 0.5,
        {
          kind: 'machine_shot', weaponType: this.primaryWeapon,
          range: this.weaponRange, targetEntityId: this._targetEntityId,
          targetPosition: [this._targetPosition.x, this._targetPosition.y, this._targetPosition.z]
        }
      );
      this._stats.causalEventsEmitted++;
    }
  }

  _fireMissile() {
    this._missileTimer = this.missileCooldown;
    this._stats.missilesFired++;
    if (this._dispatcher) {
      const muzzleIdx = this._jointRegistry.getIndex('MUZZLE');
      const muzzlePos = muzzleIdx >= 0 ? this._nodes[muzzleIdx].worldPos : this._rootMotion.position;
      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.IMPACT,
        [muzzlePos.x, muzzlePos.y, muzzlePos.z],
        -1, 80, 1.0,
        {
          kind: 'missile_launch', weaponType: this.secondaryWeapon,
          targetEntityId: this._targetEntityId,
          targetPosition: [this._targetPosition.x, this._targetPosition.y, this._targetPosition.z]
        }
      );
      this._stats.causalEventsEmitted++;
    }
  }

  _fireEMP() {
    this._empTimer = this.empCooldown;
    this._stats.empBursts++;
    if (this._dispatcher) {
      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.AUDIO_LIGHT,
        [this._rootMotion.position.x, this._rootMotion.position.y, this._rootMotion.position.z],
        -1, 40, 2.0,
        { kind: 'emp_burst', radius: 15.0 }
      );
      this._stats.causalEventsEmitted++;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── power management ────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updatePower(dt) {
    let drain = this.powerDrainIdle;
    if (this._machineStats.speed > 0.5) drain += this.powerDrainActive;
    if (this._weaponTimer > 0 || this._input.fire_primary > 0.1) drain += this.powerDrainWeapon * 0.5;

    this._power = Math.max(0, this._power - drain * dt);

    // Power source recharge.
    if (this.powerSource === POWER_SOURCE.SOLAR) {
      // Solar: recharge depends on sun altitude.
      const sunIntensity = this._frameRef && this._frameRef.layers.physical
        ? this._frameRef.layers.physical.sunIntensity || 0
        : 0.5;
      this._power = Math.min(this.maxPower, this._power + this.powerRechargeRate * sunIntensity * dt);
    } else if (this.powerSource === POWER_SOURCE.FUSION) {
      this._power = Math.min(this.maxPower, this._power + this.powerRechargeRate * dt);
    } else if (this.powerSource === POWER_SOURCE.MANA) {
      const ambient = this._frameRef && this._frameRef.layers.physical
        ? this._frameRef.layers.physical.ambientMana || 0.5
        : 0.5;
      this._power = Math.min(this.maxPower, this._power + this.powerRechargeRate * ambient * dt);
    }
    // Battery / combustion do not recharge on their own.

    // Manual recharge.
    if (this._input.recharge > 0.1) {
      this._power = Math.min(this.maxPower, this._power + this.powerRechargeRate * 2 * dt);
      this._stats.repairs++;
    }

    this._machineStats.power = this._power;

    // Brownout: if power is empty, shut down.
    if (this._power <= 0) {
      this._transitionTo(this._animRegistry.getId('power_down'));
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── networking ──────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateNetwork(dt) {
    this._broadcastTimer -= dt;
    if (this._broadcastTimer > 0) return;
    this._broadcastTimer = this._broadcastInterval;

    this._stats.networkBroadcasts++;
    this._networkAlert = Math.max(0, this._networkAlert - 0.1);

    if (this._dispatcher) {
      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.AUDIO_LIGHT,
        [this._rootMotion.position.x, this._rootMotion.position.y, this._rootMotion.position.z],
        -1, 5, 0.5,
        {
          kind: 'machine_broadcast', networkId: this._networkId,
          threatLevel: this._threatLevel,
          targetActive: this._targetActive,
          targetPosition: [this._targetPosition.x, this._targetPosition.y, this._targetPosition.z]
        }
      );
      this._stats.causalEventsEmitted++;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── motion matching seeding ────────────────────────────
  // ══════════════════════════════════════════════════════════
  _seedMotionSamples() {
    const tags = ['idle', 'patrol', 'drive', 'sprint', 'turn_left', 'turn_right',
                  'hover', 'fly', 'dive', 'land', 'takeoff',
                  'weapon_fire', 'missile_launch', 'scan', 'damaged', 'limp'];
    for (const tag of tags) {
      const id = this._animRegistry.getId(tag);
      for (let s = 0; s < 10; s++) {
        const phase = (s / 10) * 2 * Math.PI;
        const amp = tag === 'sprint' ? 12.0
          : tag === 'drive' ? 6.0
          : tag === 'patrol' ? 2.5
          : tag === 'fly' ? 10.0
          : tag === 'dive' ? 15.0
          : tag === 'limp' ? 1.5
          : 0.3;
        this._motionDB.add(
          { x: Math.cos(phase) * 0.2, y: 0, z: Math.sin(phase) * 0.2 },
          { x: Math.cos(phase) * amp, y: 0, z: Math.sin(phase) * amp },
          { x: Math.cos(phase + 0.3) * amp * 0.4, y: 0, z: Math.sin(phase + 0.3) * amp * 0.4 },
          id, s * 0.1
        );
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── runtime extension ──────────────────────────────────
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
  registerProceduralParam(name, params) { _machineProcReg.register(name, params); return this; }
  registerGoapAction(action) { this._goapActions.push(action); return this; }
  registerGoapGoal(goal) { this._goapGoals.push(goal); return this; }

  // ══════════════════════════════════════════════════════════
  // ─── forward kinematics ─────────────────────────────────
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

  _updateArmIK(weight) {
    if (!this.armIKEnabled || weight < 1e-5) return;
    if (this._ikWeights[0] > 1e-5) {
      this._updateLimbIK(this._ikTargets.lArm, this._ikWeights[0] * weight,
        ['L_SHOULDER', 'L_ELBOW', 'L_WRIST'], this._ikSolvers.lArm);
    }
    if (this._ikWeights[1] > 1e-5) {
      this._updateLimbIK(this._ikTargets.rArm, this._ikWeights[1] * weight,
        ['R_SHOULDER', 'R_ELBOW', 'R_WRIST'], this._ikSolvers.rArm);
    }
  }

  _updateTurretIK(weight) {
    if (!this.turretIKEnabled || weight < 1e-5) return;
    // Turret aim: compute required yaw and pitch to look at the target.
    const turretYawIdx = this._jointRegistry.getIndex('TURRET_YAW');
    const turretPitchIdx = this._jointRegistry.getIndex('TURRET_PITCH');
    if (turretYawIdx < 0 || turretPitchIdx < 0) return;

    // Aim at the target.
    if (this._targetActive) {
      const yawNode = this._nodes[turretYawIdx];
      const dx = this._targetPosition.x - yawNode.worldPos.x;
      const dz = this._targetPosition.z - yawNode.worldPos.z;
      this._targetTurretYaw = Math.atan2(dx, dz);

      // Pitch from horizontal.
      const pitchNode = this._nodes[turretPitchIdx];
      const dy = this._targetPosition.y - pitchNode.worldPos.y;
      const horizDist = Math.sqrt(dx * dx + dz * dz);
      this._targetTurretPitch = -Math.atan2(dy, horizDist);
    }

    // Smooth toward target yaw and pitch.
    const yawSpeed = 2.5 * dt;
    const pitchSpeed = 3.0 * dt;
    let dYaw = this._targetTurretYaw - this._turretYaw;
    while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
    while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
    this._turretYaw += Math.sign(dYaw) * Math.min(Math.abs(dYaw), yawSpeed);

    let dPitch = this._targetTurretPitch - this._turretPitch;
    this._turretPitch += Math.sign(dPitch) * Math.min(Math.abs(dPitch), pitchSpeed);

    // Apply to nodes.
    const yawNode = this._nodes[turretYawIdx];
    yawNode.localRot.setFromAxisAngle(new Vec3(0, 1, 0), this._turretYaw);
    const pitchNode = this._nodes[turretPitchIdx];
    pitchNode.localRot.setFromAxisAngle(new Vec3(1, 0, 0), this._turretPitch);

    this._stats.ikEvaluations++;
  }

  _updateWheelIK(weight) {
    if (!this.wheelIKEnabled || weight < 1e-5) return;
    // Rotate wheels based on speed.
    const wheels = ['FL', 'ML', 'RL', 'FR', 'MR', 'RR'];
    const speed = this._machineStats.speed;
    const wheelRadius = 0.35 * this.bodyScale;
    const rotationDelta = (speed * (1 / 60)) / wheelRadius;

    for (let i = 0; i < wheels.length; i++) {
      const key = wheels[i];
      const wheelIdx = this._jointRegistry.getIndex(`WHEEL_${key}`);
      if (wheelIdx < 0) continue;
      this._wheelRotations[i] += rotationDelta;
      const wheel = this._nodes[wheelIdx];
      // Rotate around the wheel's axle (local X axis).
      wheel.localRot.setFromAxisAngle(new Vec3(1, 0, 0), this._wheelRotations[i]);
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── look-at ────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateLookAt(weight) {
    if (!this._lookAtActive || weight < 1e-5) return;
    // Sensor mast looks at the target.
    const mastIdx = this._jointRegistry.getIndex('SENSOR_MAST');
    if (mastIdx < 0) return;
    const mast = this._nodes[mastIdx];
    const toTarget = this._lookAtTarget.clone().sub(mast.worldPos).normalize();
    const forward = new Vec3(0, 0, 1).applyQuaternion(mast.worldRot);
    const angle = forward.angleTo(toTarget);
    if (angle < 1e-5) return;
    const axis = forward.clone().cross(toTarget).normalize();
    if (axis.lengthSq() < 1e-5) axis.set(0, 1, 0);
    mast.applyRotationDelta(axis, angle * weight * this.lookAtWeight);
  }

  // ══════════════════════════════════════════════════════════
  // ─── procedural overlays ────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateServoJitter(dt) {
    if (!this.proceduralEnabled) return;
    const p = _machineProcReg.get('servoJitter');
    this._servoPhase += dt * (2 * Math.PI * p.frequency);
    const jitter = Math.sin(this._servoPhase) * p.amplitude;

    // Apply small rotation jitter to arms and turret.
    const arms = ['L_ELBOW', 'R_ELBOW', 'L_WRIST', 'R_WRIST'];
    for (const name of arms) {
      const idx = this._jointRegistry.getIndex(name);
      if (idx >= 0) this._nodes[idx].applyRotationDelta(new Vec3(0, 1, 0), jitter);
    }
  }

  _updateAntennaWobble(dt) {
    if (!this.proceduralEnabled) return;
    const p = _machineProcReg.get('antennaWobble');
    this._antennaPhase += dt * (2 * Math.PI * p.frequency);
    const speed = this._machineStats.speed;
    const wobble = Math.sin(this._antennaPhase) * p.amplitude * (0.3 + speed * 0.05);

    const ant0 = this._jointRegistry.getIndex('ANTENNA_0');
    const ant1 = this._jointRegistry.getIndex('ANTENNA_1');
    if (ant0 >= 0) this._nodes[ant0].applyRotationDelta(new Vec3(0, 1, 0), wobble);
    if (ant1 >= 0) this._nodes[ant1].applyRotationDelta(new Vec3(0, 1, 0), wobble * 1.3);
  }

  _updateRadarSweep(dt) {
    if (!this.proceduralEnabled) return;
    // Radar dish rotates continuously.
    const radarIdx = this._jointRegistry.getIndex('RADAR_DISH');
    if (radarIdx < 0) return;
    this._nodes[radarIdx].localRot.setFromAxisAngle(new Vec3(0, 1, 0), this._radarPhase * 2 * Math.PI);
  }

  _updateHoverBob(dt) {
    if (!this.proceduralEnabled || !this._hovering) return;
    const p = _machineProcReg.get('hoverBob');
    this._hoverPhase += dt * (2 * Math.PI * p.frequency);
    const bob = Math.sin(this._hoverPhase) * p.amplitude;
    this._rootMotion.position.y += bob * dt;
  }

  _updateEngineExhaust(dt) {
    // Update thruster intensity for lights.
    if (this._input.sprint > 0.1 || this._airborne) {
      this._thrusterIntensity = Math.min(1.0, this._thrusterIntensity + dt * 3);
    } else {
      this._thrusterIntensity = Math.max(0, this._thrusterIntensity - dt * 2);
    }
  }

  _updateMuzzleFlash(dt) {
    if (this._muzzleFlashIntensity > 0) {
      this._muzzleFlashIntensity = Math.max(0, this._muzzleFlashIntensity - dt * 8);
    }
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
  // ─── GOAP ───────────────────────────────────────────────
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
    if (this._monsterStats && this._monsterStats.grounded) { /* no-op for machines */ }
    if (this._machineStats.grounded) bits |= reg.getBit('IS_GROUNDED');
    if (this._hovering) bits |= reg.getBit('IS_HOVERING');
    if (this._airborne) bits |= reg.getBit('IS_FLYING');
    if (this._machineStats.moving) bits |= reg.getBit('IS_MOVING');
    if (this._damageState >= DAMAGE_STATE.DAMAGED) bits |= reg.getBit('IS_DAMAGED');
    if (this._damageState >= DAMAGE_STATE.CRITICAL) bits |= reg.getBit('IS_CRITICAL');
    if (this._damageState === DAMAGE_STATE.DESTROYED) bits |= reg.getBit('IS_DESTROYED');
    if (this._power / this.maxPower > 0.5) bits |= reg.getBit('POWER_HIGH');
    else bits |= reg.getBit('POWER_LOW');
    if (this._weaponTimer <= 0 && this._weaponOverheat === 0) bits |= reg.getBit('WEAPON_READY');
    if (this._weaponOverheat > 0) bits |= reg.getBit('WEAPON_OVERHEAT');
    if (this._input.repair > 0.1) bits |= reg.getBit('CAN_REPAIR');
    if (this._targetActive) bits |= reg.getBit('HAS_TARGET');
    if (this._targetLocked) bits |= reg.getBit('TARGET_LOCKED');
    if (this._threatLevel > 0) bits |= reg.getBit('THREAT_DETECTED');
    if (this._hacked) bits |= reg.getBit('IS_HACKED');
    if (this._networkAlert > 0) bits |= reg.getBit('NETWORK_ALERT');
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
  // ─── state machine ──────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateAnimationState(dt) {
    const S = (n) => this._animRegistry.getId(n);
    if (this._hitStaggerTimer > 0) this._transitionTo(S('hit'));
    else if (this._damageState === DAMAGE_STATE.DESTROYED) this._transitionTo(S('destroyed'));
    else if (this._power <= 0) this._transitionTo(S('power_down'));
    else if (this._selfDestructTimer >= 0) this._transitionTo(S('self_destruct'));
    else if (this._hacked) this._transitionTo(S('hack_defend'));
    else if (this._weaponOverheat > 0) this._transitionTo(S('weapon_overheat'));
    else if (this._weaponTimer > 0) this._transitionTo(S('weapon_fire'));
    else if (this._missileTimer > 0.5) this._transitionTo(S('missile_launch'));
    else if (this._damageState === DAMAGE_STATE.CRITICAL) this._transitionTo(S('critical'));
    else if (this._damageState === DAMAGE_STATE.DAMAGED) this._transitionTo(S('damaged'));
    else if (this._input.takeoff > 0.1 && this._machineStats.grounded) this._transitionTo(S('takeoff'));
    else if (!this._machineStats.grounded) this._transitionTo(S('fly'));
    else if (this._input.repair > 0.1) this._transitionTo(S('repair'));
    else if (this._input.recharge > 0.1) this._transitionTo(S('recharge'));
    else if (this._input.brake > 0.1) this._transitionTo(S('brake'));
    else if (this._input.reverse > 0.1) this._transitionTo(S('reverse'));
    else if (this._targetActive && this._threatLevel >= 2) this._transitionTo(S('track_target'));
    else {
      const speed = this._machineStats.speed;
      if (speed > 8) this._transitionTo(S('sprint'));
      else if (speed > 2) this._transitionTo(S('drive'));
      else if (speed > 0.2) this._transitionTo(S('patrol'));
      else if (this._threatLevel > 0) this._transitionTo(S('scan'));
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
      const destroyed = this._animRegistry.getId('destroyed');
      const selfDestruct = this._animRegistry.getId('self_destruct');
      const powerDown = this._animRegistry.getId('power_down');
      if (newState === destroyed || newState === selfDestruct) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.IMPACT,
          [this._rootMotion.position.x, this._rootMotion.position.y, this._rootMotion.position.z],
          -1, 200, 3.0,
          { kind: 'machine_destroyed', species: this.speciesName }
        );
        this._stats.causalEventsEmitted++;
      } else if (newState === powerDown) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.AUDIO_LIGHT,
          [this._rootMotion.position.x, this._rootMotion.position.y, this._rootMotion.position.z],
          -1, 20, 1.0,
          { kind: 'power_down', species: this.speciesName }
        );
        this._stats.causalEventsEmitted++;
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── root motion ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateRootMotion(dt) {
    // Determine active profile.
    let profileName = 'idle';
    const speed = this._machineStats.speed;
    if (this._airborne) profileName = 'fly';
    else if (this._hovering) profileName = 'hover';
    else if (this._input.brake > 0.1) profileName = 'brake';
    else if (this._input.reverse > 0.1) profileName = 'reverse';
    else if (speed > 8) profileName = 'sprint';
    else if (speed > 2) profileName = 'drive';
    else if (speed > 0.2) profileName = 'patrol';
    else profileName = 'idle';

    if (this._rootMotion.profileName !== profileName) {
      this._rootMotion.profileName = profileName;
      this._rootMotion.profile = MACHINE_ROOT_MOTION_PROFILES[profileName] || MACHINE_ROOT_MOTION_PROFILES.idle;
    }
    const profile = this._rootMotion.profile;

    // ── power gating ──────────────────────────────────────
    const powerFactor = Math.min(1, this._power / (this.maxPower * 0.5));
    const damageFactor = this._damageState >= DAMAGE_STATE.CRITICAL ? 0.5
      : this._damageState >= DAMAGE_STATE.DAMAGED ? 0.75
      : 1.0;

    // ── horizontal movement ───────────────────────────────
    const dir = this._tmpVecA.set(this._input.moveX, 0, this._input.moveY);
    if (dir.lengthSq() > 1e-6) dir.normalize();
    const sprintBoost = this._input.sprint > 0.1 ? 1.3 : 1.0;
    const targetSpeed = profile.maxSpeed * powerFactor * damageFactor * dir.length() * sprintBoost;
    const maxAccel = profile.acceleration * dt * powerFactor * damageFactor;

    const dvx = dir.x * targetSpeed - this._rootMotion.velocity.x;
    const dvz = dir.z * targetSpeed - this._rootMotion.velocity.z;
    this._rootMotion.velocity.x += Math.sign(dvx) * Math.min(Math.abs(dvx), maxAccel);
    this._rootMotion.velocity.z += Math.sign(dvz) * Math.min(Math.abs(dvz), maxAccel);

    // ── takeoff ───────────────────────────────────────────
    if (this._input.takeoff > 0.1 && this._machineStats.grounded) {
      this._rootMotion.verticalVelocity = profile.jumpImpulse || 8.0;
      this._machineStats.grounded = 0;
      this._airborne = 1;
    }

    // ── gravity (non-hover, non-flying) ───────────────────
    if (!this._machineStats.grounded && !this._hovering && !this._airborne) {
      this._rootMotion.verticalVelocity -= 9.81 * profile.gravityScale * dt;
    }

    // ── integrate ─────────────────────────────────────────
    this._rootMotion.position.x += this._rootMotion.velocity.x * dt;
    this._rootMotion.position.z += this._rootMotion.velocity.z * dt;
    this._rootMotion.position.y += this._rootMotion.verticalVelocity * dt;

    // Ground contact.
    if (this._rootMotion.position.y <= 0 && !this._hovering) {
      this._rootMotion.position.y = 0;
      this._rootMotion.verticalVelocity = 0;
      if (!this._machineStats.grounded) {
        this._transitionTo(this._animRegistry.getId('land'));
      }
      this._machineStats.grounded = 1;
      this._airborne = 0;
    }

    // ── facing ────────────────────────────────────────────
    const speedSq = this._rootMotion.velocity.x ** 2 + this._rootMotion.velocity.z ** 2;
    if (speedSq > 1e-4) {
      const targetYaw = Math.atan2(this._rootMotion.velocity.x, this._rootMotion.velocity.z);
      const currentYaw = 2 * Math.acos(Math.min(1, Math.max(-1, this._rootMotion.quat.w))) *
        (this._rootMotion.quat.y >= 0 ? 1 : -1);
      let dYaw = targetYaw - currentYaw;
      while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
      while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
      const maxStep = profile.angularAcceleration * dt * powerFactor;
      const step = Math.sign(dYaw) * Math.min(Math.abs(dYaw), maxStep);
      this._rootMotion.quat.multiply(
        new Quat().setFromAxisAngle(new Vec3(0, 1, 0), step)
      ).normalize();
    }

    // ── speed ─────────────────────────────────────────────
    this._machineStats.speed = Math.sqrt(speedSq);
    this._machineStats.moving = this._machineStats.speed > 0.2 ? 1 : 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── causal reactions ────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _readCausal(frame) {
    const causal = frame.layers.causal;
    if (!causal || !causal.derivedSignals) return;
    const s = causal.derivedSignals;
    for (let i = 0; i < s.count; i++) {
      if (s.types[i] === DERIVED_SIGNAL.LIGHT_FLICKER && s.forces[i] > 40) {
        // Damage.
        if (this._hitStaggerTimer <= 0) {
          this._hitStaggerTimer = 0.15;
          this._transitionTo(this._animRegistry.getId('hit'));

          const damage = s.forces[i] * 0.3;
          // Shield absorbs first.
          if (this._machineStats.shield > 0) {
            this._machineStats.shield = Math.max(0, this._machineStats.shield - damage);
          } else {
            this._machineStats.health = Math.max(0, this._machineStats.health - damage);
            this._updateDamageState();
          }

          // Random component damage.
          if (this._components.length > 0) {
            const comp = this._components[Math.floor(Math.random() * this._components.length)];
            this.damageComponent(comp.name, damage * 0.5);
          }
        }
      }
      if (s.types[i] === DERIVED_SIGNAL.IGNITE_CANDIDATE && s.forces[i] > 80) {
        this._machineStats.health = Math.max(0, this._machineStats.health - s.forces[i] * 0.1);
        this._updateDamageState();
      }
      // EMP pulses hit machines harder.
      if (s.types[i] === DERIVED_SIGNAL.EMISSIVE_BOOST && s.forces[i] > 30) {
        this._empActive = Math.min(1, this._empActive + 0.3);
        this._power = Math.max(0, this._power - 50);
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── equipment ──────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  equipItem(slot, item) {
    if (slot < 0 || slot >= EQUIP_SLOT.COUNT) return false;
    this._equipment[slot] = item;
    this._equipmentMass[slot] = item.mass || 50.0;
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
  // ─── input / API ────────────────────────────────────────
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
        lArm: 0, rArm: 1, turretTarget: 2,
        flWheel: 3, frWheel: 4, rlWheel: 5, rrWheel: 6, muzzleTarget: 7
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
    this._targetLocked = 1;
    return this;
  }

  clearTarget() {
    this._targetEntityId = -1;
    this._targetActive = 0;
    this._targetLocked = 0;
    return this;
  }

  triggerSelfDestruct(countdown = 5.0) {
    this._selfDestructTimer = countdown;
    return this;
  }

  attemptHack() {
    this._stats.hacksAttempted++;
    // Simple success chance based on damage.
    const successChance = 0.3 + this._damageState * 0.15;
    if (Math.random() < successChance) {
      this._hacked = 1;
      this._stats.hacksSucceeded++;
      return true;
    }
    return false;
  }

  clearHack() {
    this._hacked = 0;
    return this;
  }

  // ── deformation API ──────────────────────────────────────
  poke(position, impulse, ttl = 1.0) { this._deformation.addPoke(position, impulse, ttl); return this; }
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

    // 1. Causal reactions
    this._readCausal(frame);
    if (this._hitStaggerTimer > 0) this._hitStaggerTimer -= dt;

    // 2. Self-destruct countdown
    if (this._selfDestructTimer >= 0) {
      this._selfDestructTimer -= dt;
      if (this._selfDestructTimer <= 0) {
        this._machineStats.health = 0;
        this._updateDamageState();
        this._selfDestructTimer = -1;
      }
    }

    // 3. EMP recovery
    if (this._empActive > 0) {
      this._empActive = Math.max(0, this._empActive - dt * _machineProcReg.get('emp').recoveryPerSec);
    }

    // 4. Root motion
    this._updateRootMotion(dt);

    // 5. Sensors
    this._updateSensors(dt, frame);

    // 6. Weapons
    this._updateWeapons(dt);

    // 7. Power
    this._updatePower(dt);

    // 8. Network
    this._updateNetwork(dt);

    // 9. GOAP
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

    // 10. Animation state + blend
    this._updateAnimationState(dt);
    this._stateBlend = Math.min(1.0, this._stateBlend + this.stateBlendRate * dt);

    // 11. Procedural overlays
    this._updateServoJitter(dt);
    this._updateAntennaWobble(dt);
    this._updateRadarSweep(dt);
    this._updateHoverBob(dt);
    this._updateEngineExhaust(dt);
    this._updateMuzzleFlash(dt);
    this._updateSpringBones(dt);

    // 12. Motion matching
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

    // 13. Deformation overlays
    this._deformation.update(dt, this._nodes, this._jointEmissive);
    this._stats.deformationsApplied++;

    // 14. FK → IK → FK
    this._updateFK();
    this._updateArmIK(this.ikWeight);
    this._updateTurretIK(this.ikWeight);
    this._updateWheelIK(this.ikWeight);
    this._updateFK();
    this._updateLookAt(this.ikWeight);
    this._updateFK();

    // 15. Equipment emissive decay
    this._updateEquipmentEmissive(dt);

    // 16. Write to frame
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
    const chassisIdx = this._jointRegistry.getIndex('CHASSIS');
    const turretIdx = this._jointRegistry.getIndex('TURRET_YAW');
    const chassis = chassisIdx >= 0 ? this._nodes[chassisIdx] : this._nodes[0];
    const turret = turretIdx >= 0 ? this._nodes[turretIdx] : chassis;

    player.position[0] = chassis.worldPos.x;
    player.position[1] = chassis.worldPos.y;
    player.position[2] = chassis.worldPos.z;

    player.velocity[0] = this._rootMotion.velocity.x;
    player.velocity[1] = this._rootMotion.verticalVelocity;
    player.velocity[2] = this._rootMotion.velocity.z;

    this._tmpVecA.set(0, 0, 1).applyQuaternion(turret.worldRot);
    player.facing[0] = this._tmpVecA.x;
    player.facing[1] = this._tmpVecA.y;
    player.facing[2] = this._tmpVecA.z;

    player.health = this._machineStats.health;
    player.mana = this._machineStats.shield;
    player.stamina = this._machineStats.power;
    player.focusDistance = this._machineStats.focusDistance;
    player.species = this.speciesName;
    player.machineClass = this.machineClass;
    player.threatLevel = this._threatLevel;
    player.damageState = this._damageState;
    player.turretYaw = this._turretYaw;
    player.turretPitch = this._turretPitch;
    player.weaponHeat = this._weaponHeat;
    player.weaponOverheat = this._weaponOverheat;
    player.power = this._power;
    player.maxPower = this.maxPower;
    player.empActive = this._empActive;
    player.hacked = this._hacked;

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
    let totalMass = this._machineStats.bodyMass;
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

    // ── Muzzle flash light ─────────────────────────────
    if (!p.machineMuzzleFlashes) {
      p.machineMuzzleFlashes = { count: 0, positions: [], colors: [], intensities: [] };
    }
    const flashes = p.machineMuzzleFlashes;
    flashes.count = 0;
    flashes.positions.length = 0;
    flashes.colors.length = 0;
    flashes.intensities.length = 0;

    const muzzleIdx = this._jointRegistry.getIndex('MUZZLE');
    if (muzzleIdx >= 0 && this._muzzleFlashIntensity > 0.05) {
      const wp = this._nodes[muzzleIdx].worldPos;
      flashes.positions.push(wp.x, wp.y, wp.z);
      flashes.colors.push(this._muzzleFlashColor[0], this._muzzleFlashColor[1], this._muzzleFlashColor[2]);
      flashes.intensities.push(this._muzzleFlashIntensity);
      flashes.count = 1;
    }

    // ── Thruster lights ────────────────────────────────
    if (!p.machineThrusterLights) {
      p.machineThrusterLights = { count: 0, positions: [], colors: [], intensities: [] };
    }
    const thrusters = p.machineThrusterLights;
    thrusters.count = 0;
    thrusters.positions.length = 0;
    thrusters.colors.length = 0;
    thrusters.intensities.length = 0;

    if (this._thrusterIntensity > 0.05) {
      const thrusterNames = ['THRUSTER_FL', 'THRUSTER_FR', 'ENGINE_0', 'ENGINE_1'];
      for (const name of thrusterNames) {
        const idx = this._jointRegistry.getIndex(name);
        if (idx < 0) continue;
        const wp = this._nodes[idx].worldPos;
        thrusters.positions.push(wp.x, wp.y, wp.z);
        thrusters.colors.push(0.4, 0.6, 1.0);
        thrusters.intensities.push(this._thrusterIntensity * 0.8);
        thrusters.count++;
      }
    }

    p.playerJointEmissive = this._jointEmissive;
    p.playerBalloonScale = this._deformation.balloonScale;
    p.playerMachineClass = this.machineClass;
    p.playerDamageState = this._damageState;
    p.playerThreatLevel = this._threatLevel;
    p.playerPower = this._power;
    p.playerMaxPower = this.maxPower;
    p.playerNetworkId = this._networkId;
    p.playerRadarContacts = this._radarContacts.length;
    p.playerLidarContacts = this._lidarContacts.length;
  }

  // ── accessors ───────────────────────────────────────────
  attachDispatcher(d) { this._dispatcher = d; return this; }
  get currentState() { return this._currentState; }
  get currentStateName() { return this._animRegistry.getName(this._currentState); }
  get machineStats() { return this._machineStats; }
  get rootPosition() { return this._rootMotion.position; }
  get jointNodes() { return this._nodes; }
  get goapPlan() { return this._goapPlan; }
  get goapWorldState() { return this._goapWorldState; }
  get jointCount() { return this._jointCount; }
  get damageState() { return this._damageState; }
  get power() { return this._power; }
  get turretYaw() { return this._turretYaw; }
  get turretPitch() { return this._turretPitch; }
  get isHacked() { return this._hacked === 1; }
  get networkId() { return this._networkId; }

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
    this._components.length = 0;
    this._radarContacts.length = 0;
    this._lidarContacts.length = 0;
    this._thermalContacts.length = 0;
    this._peers.clear();
  }
}

export {
  MachinesContextProvider,
  MACHINE_ROOT_MOTION_PROFILES,
  MACHINE_CLASS,
  WEAPON_TYPE,
  DAMAGE_STATE,
  POWER_SOURCE,
  _machineJointReg as MACHINE_JOINT_REGISTRY,
  _machineAnimReg as MACHINE_ANIM_REGISTRY,
  _machineGoapReg as MACHINE_GOAP_REGISTRY,
  _machineProcReg as MACHINE_PROC_REGISTRY
};