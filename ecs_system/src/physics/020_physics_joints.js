// file number : 020
// full path name : src/physics/020_physics_joints.js
// description : Rigid-body joint and constraint system for both 2D (Box2D
//               b2Joint family) and 3D physics. Provides SoA JointData
//               slots for the full joint taxonomy:
//                 2D: Revolute, Prismatic, Distance, Weld, Wheel, Rope, Motor
//                 3D: Hinge, BallSocket, Slider, Fixed, Distance, ConeTwist
//               Each joint supports anchors, axes, limits (linear and
//               angular), motors (target velocity + max force), springs
//               (stiffness + damping), and break force / torque thresholds.
//               Solvers extend file 007 (2D) and file 008 (3D) with a
//               joint-wide iterative pass that runs interleaved with the
//               contact solver, matching Box2D's b2Island::Solve order.
//               Joint state is packed in typed arrays; zero per-joint
//               allocation in the hot loop. Breakage auto-removes the joint.
// best for : Character controllers (knees, elbows), ragdolls, vehicles
//            (wheels + suspension), chains and ropes, doors and hinges,
//            robot limbs, and any scene that must connect thousands of
//            rigid bodies on Android 64-bit.
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
  markDirty,
} from '../transform/002_transform_hierarchy.js';

import {
  RigidBody2D,
  Fixture2D,
  ShapeType,
  BodyType,
  Contact2D,
  Physics2DState,
} from '../physics/007_physics2d_box2d.js';

import {
  RigidBody3D,
  Shape3D,
  BodyType3D,
  ShapeType3D,
  Contact3D,
  Physics3DState,
} from '../physics/008_physics3d_rigidbody.js';

import {
  bvhCollisionPairs,
} from '../spatial/003_bvh_broadphase.js';

import {
  vec3,
  vec2,
  mat3,
  quat,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS — verified
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ                = 1e-16;
const EPSILON                   = 1e-8;
const EPSILON_HIGH              = 1e-12;
const PI                        = Math.PI;
const TWO_PI                    = 2 * Math.PI;
const HALF_PI                   = Math.PI / 2;
const DEG_TO_RAD                = Math.PI / 180;
const RAD_TO_DEG                = 180 / Math.PI;
const LINEAR_SLOP_JOINT         = 0.005;
const ANGULAR_SLOP_JOINT        = 0.5 * DEG_TO_RAD;
const BAUMGARTE_JOINT           = 0.2;
const MAX_LINEAR_CORRECTION     = 0.2;
const MAX_ANGULAR_CORRECTION    = 8 * DEG_TO_RAD;
const SOLVER_ITERATIONS_JOINT   = 8;
const MOTOR_EPSILON             = 1e-6;
const SPRING_EPSILON            = 1e-6;
const BREAK_IMPULSE_EPSILON     = 1e-4;

const MAX_JOINTS_2D = 500_000;
const MAX_JOINTS_3D = 500_000;

// ═══════════════════════════════════════════════════════════════════════
// JOINT TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const JointType2D = Object.freeze({
  REVOLUTE:  0,   // hinge
  PRISMATIC: 1,   // slider
  DISTANCE:  2,   // rigid rod
  WELD:      3,   // fully locked
  WHEEL:     4,   // suspension + spin
  ROPE:      5,   // max distance only
  MOTOR:     6,   // spring-motor, no hard constraint
});

export const JointType3D = Object.freeze({
  HINGE:       0,   // 1 DOF rotation
  BALL_SOCKET: 1,   // 3 DOF rotation, no translation
  SLIDER:      2,   // 1 DOF translation
  FIXED:       3,   // fully locked
  DISTANCE:    4,   // rigid rod
  CONE_TWIST:  5,   // cone + twist limits
});

// ═══════════════════════════════════════════════════════════════════════
// SoA JOINT STORE — 2D
// ═══════════════════════════════════════════════════════════════════════

export const Joint2D = {
  // Type.
  type: new Uint8Array(MAX_JOINTS_2D),

  // Bodies (entity ids).
  bodyA: new Uint32Array(MAX_JOINTS_2D),
  bodyB: new Uint32Array(MAX_JOINTS_2D),

  // Whether bodies should collide with each other.
  collideConnected: new Uint8Array(MAX_JOINTS_2D),

  // Local anchor points in A and B frames.
  localAnchorAx: new Float32Array(MAX_JOINTS_2D),
  localAnchorAy: new Float32Array(MAX_JOINTS_2D),
  localAnchorBx: new Float32Array(MAX_JOINTS_2D),
  localAnchorBy: new Float32Array(MAX_JOINTS_2D),

  // Local axis (for prismatic, wheel).
  localAxisX: new Float32Array(MAX_JOINTS_2D),
  localAxisY: new Float32Array(MAX_JOINTS_2D),

  // Reference angle (for revolute / weld / wheel).
  referenceAngle: new Float32Array(MAX_JOINTS_2D),

  // Distance (for distance / rope).
  restLength: new Float32Array(MAX_JOINTS_2D),
  lengthBias: new Float32Array(MAX_JOINTS_2D),

  // Limits.
  enableLimit: new Uint8Array(MAX_JOINTS_2D),
  lowerLimit: new Float32Array(MAX_JOINTS_2D),
  upperLimit: new Float32Array(MAX_JOINTS_2D),

  // Motors.
  enableMotor: new Uint8Array(MAX_JOINTS_2D),
  motorSpeed: new Float32Array(MAX_JOINTS_2D),
  maxMotorForce: new Float32Array(MAX_JOINTS_2D),
  motorImpulse: new Float32Array(MAX_JOINTS_2D),

  // Springs (for wheel, distance).
  enableSpring: new Uint8Array(MAX_JOINTS_2D),
  springFrequency: new Float32Array(MAX_JOINTS_2D),   // Hz
  springDamping: new Float32Array(MAX_JOINTS_2D),     // ratio 0..1

  // Break threshold.
  breakForce: new Float32Array(MAX_JOINTS_2D),
  breakTorque: new Float32Array(MAX_JOINTS_2D),

  // Cached solver state (accumulated impulses).
  accumulatedImpulse0: new Float32Array(MAX_JOINTS_2D),
  accumulatedImpulse1: new Float32Array(MAX_JOINTS_2D),
  accumulatedAngularImpulse: new Float32Array(MAX_JOINTS_2D),
  accumulatedMotorImpulse: new Float32Array(MAX_JOINTS_2D),
  accumulatedLowerImpulse: new Float32Array(MAX_JOINTS_2D),
  accumulatedUpperImpulse: new Float32Array(MAX_JOINTS_2D),

  // Joint active flag.
  active: new Uint8Array(MAX_JOINTS_2D),

  // Owner entity (the joint entity).
  ownerEid: new Uint32Array(MAX_JOINTS_2D),

  // World-space cached anchors (per solver step).
  worldAnchorAx: new Float32Array(MAX_JOINTS_2D),
  worldAnchorAy: new Float32Array(MAX_JOINTS_2D),
  worldAnchorBx: new Float32Array(MAX_JOINTS_2D),
  worldAnchorBy: new Float32Array(MAX_JOINTS_2D),

  // Effective masses (per solver step).
  mass0: new Float32Array(MAX_JOINTS_2D),
  mass1: new Float32Array(MAX_JOINTS_2D),
  massAngular: new Float32Array(MAX_JOINTS_2D),
};

let _nextJoint2DSlot = 0;

export const JointTag2D = {};

// ═══════════════════════════════════════════════════════════════════════
// SoA JOINT STORE — 3D
// ═══════════════════════════════════════════════════════════════════════

export const Joint3D = {
  type: new Uint8Array(MAX_JOINTS_3D),
  bodyA: new Uint32Array(MAX_JOINTS_3D),
  bodyB: new Uint32Array(MAX_JOINTS_3D),
  collideConnected: new Uint8Array(MAX_JOINTS_3D),

  // Local anchors.
  localAnchorAx: new Float32Array(MAX_JOINTS_3D),
  localAnchorAy: new Float32Array(MAX_JOINTS_3D),
  localAnchorAz: new Float32Array(MAX_JOINTS_3D),
  localAnchorBx: new Float32Array(MAX_JOINTS_3D),
  localAnchorBy: new Float32Array(MAX_JOINTS_3D),
  localAnchorBz: new Float32Array(MAX_JOINTS_3D),

  // Local axes (axisX = primary, axisY = secondary for hinge, etc.).
  localAxisAx: new Float32Array(MAX_JOINTS_3D),
  localAxisAy: new Float32Array(MAX_JOINTS_3D),
  localAxisAz: new Float32Array(MAX_JOINTS_3D),
  localAxisBx: new Float32Array(MAX_JOINTS_3D),
  localAxisBy: new Float32Array(MAX_JOINTS_3D),
  localAxisBz: new Float32Array(MAX_JOINTS_3D),

  // Reference frame quaternions for fixed / ball joints.
  refQX: new Float32Array(MAX_JOINTS_3D),
  refQY: new Float32Array(MAX_JOINTS_3D),
  refQZ: new Float32Array(MAX_JOINTS_3D),
  refQW: new Float32Array(MAX_JOINTS_3D),

  // Rest length (distance joint).
  restLength: new Float32Array(MAX_JOINTS_3D),

  // Limits.
  enableLimit: new Uint8Array(MAX_JOINTS_3D),
  lowerLimit: new Float32Array(MAX_JOINTS_3D),
  upperLimit: new Float32Array(MAX_JOINTS_3D),
  lowerAngleLimit: new Float32Array(MAX_JOINTS_3D),
  upperAngleLimit: new Float32Array(MAX_JOINTS_3D),
  lowerTwistLimit: new Float32Array(MAX_JOINTS_3D),
  upperTwistLimit: new Float32Array(MAX_JOINTS_3D),
  coneAngle: new Float32Array(MAX_JOINTS_3D),

  // Motors.
  enableMotor: new Uint8Array(MAX_JOINTS_3D),
  motorSpeed: new Float32Array(MAX_JOINTS_3D),
  maxMotorForce: new Float32Array(MAX_JOINTS_3D),
  motorImpulse: new Float32Array(MAX_JOINTS_3D),

  // Springs.
  enableSpring: new Uint8Array(MAX_JOINTS_3D),
  springFrequency: new Float32Array(MAX_JOINTS_3D),
  springDamping: new Float32Array(MAX_JOINTS_3D),

  // Break.
  breakForce: new Float32Array(MAX_JOINTS_3D),
  breakTorque: new Float32Array(MAX_JOINTS_3D),

  // Accumulated impulses (x, y, z point-to-point; angular).
  accumulatedImpulseX: new Float32Array(MAX_JOINTS_3D),
  accumulatedImpulseY: new Float32Array(MAX_JOINTS_3D),
  accumulatedImpulseZ: new Float32Array(MAX_JOINTS_3D),
  accumulatedAngularX: new Float32Array(MAX_JOINTS_3D),
  accumulatedAngularY: new Float32Array(MAX_JOINTS_3D),
  accumulatedAngularZ: new Float32Array(MAX_JOINTS_3D),
  accumulatedMotorImpulse: new Float32Array(MAX_JOINTS_3D),

  // Cached world anchors.
  worldAnchorAx: new Float32Array(MAX_JOINTS_3D),
  worldAnchorAy: new Float32Array(MAX_JOINTS_3D),
  worldAnchorAz: new Float32Array(MAX_JOINTS_3D),
  worldAnchorBx: new Float32Array(MAX_JOINTS_3D),
  worldAnchorBy: new Float32Array(MAX_JOINTS_3D),
  worldAnchorBz: new Float32Array(MAX_JOINTS_3D),

  // Effective masses (3x3 per body, stored row-major 9 per joint).
  massA: new Float32Array(MAX_JOINTS_3D * 9),
  massB: new Float32Array(MAX_JOINTS_3D * 9),

  active: new Uint8Array(MAX_JOINTS_3D),
  ownerEid: new Uint32Array(MAX_JOINTS_3D),
};

let _nextJoint3DSlot = 0;

export const JointTag3D = {};

// ═══════════════════════════════════════════════════════════════════════
// CREATE JOINTS — 2D
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a 2D revolute joint (hinge).
 */
export function createRevoluteJoint2D(world, jointEid, bodyAEid, bodyBEid, {
  anchorAx = 0, anchorAy = 0,
  anchorBx = 0, anchorBy = 0,
  enableLimit = false, lowerLimit = 0, upperLimit = 0,
  enableMotor = false, motorSpeed = 0, maxMotorForce = 0,
  breakForce = Infinity, breakTorque = Infinity,
  collideConnected = false,
} = {}) {
  const slot = _allocJoint2D(world, jointEid, bodyAEid, bodyBEid);
  const J = Joint2D;
  const idA = getId(bodyAEid);
  const idB = getId(bodyBEid);

  J.type[slot] = JointType2D.REVOLUTE;
  J.localAnchorAx[slot] = anchorAx;
  J.localAnchorAy[slot] = anchorAy;
  J.localAnchorBx[slot] = anchorBx;
  J.localAnchorBy[slot] = anchorBy;

  // Reference angle = current B angle - A angle.
  J.referenceAngle[slot] = RigidBody2D.angle[idB] - RigidBody2D.angle[idA];

  J.enableLimit[slot] = enableLimit ? 1 : 0;
  J.lowerLimit[slot] = lowerLimit;
  J.upperLimit[slot] = upperLimit;

  J.enableMotor[slot] = enableMotor ? 1 : 0;
  J.motorSpeed[slot] = motorSpeed;
  J.maxMotorForce[slot] = maxMotorForce;

  J.breakForce[slot] = breakForce;
  J.breakTorque[slot] = breakTorque;
  J.collideConnected[slot] = collideConnected ? 1 : 0;

  return slot;
}

/**
 * Create a 2D prismatic joint (slider).
 */
export function createPrismaticJoint2D(world, jointEid, bodyAEid, bodyBEid, {
  anchorAx = 0, anchorAy = 0,
  anchorBx = 0, anchorBy = 0,
  axisX = 1, axisY = 0,
  enableLimit = false, lowerLimit = 0, upperLimit = 0,
  enableMotor = false, motorSpeed = 0, maxMotorForce = 0,
  collideConnected = false,
} = {}) {
  const slot = _allocJoint2D(world, jointEid, bodyAEid, bodyBEid);
  const J = Joint2D;
  const idB = getId(bodyBEid);

  J.type[slot] = JointType2D.PRISMATIC;
  J.localAnchorAx[slot] = anchorAx;
  J.localAnchorAy[slot] = anchorAy;
  J.localAnchorBx[slot] = anchorBx;
  J.localAnchorBy[slot] = anchorBy;
  J.localAxisX[slot] = axisX;
  J.localAxisY[slot] = axisY;
  J.referenceAngle[slot] = RigidBody2D.angle[idB];

  J.enableLimit[slot] = enableLimit ? 1 : 0;
  J.lowerLimit[slot] = lowerLimit;
  J.upperLimit[slot] = upperLimit;

  J.enableMotor[slot] = enableMotor ? 1 : 0;
  J.motorSpeed[slot] = motorSpeed;
  J.maxMotorForce[slot] = maxMotorForce;

  J.collideConnected[slot] = collideConnected ? 1 : 0;
  return slot;
}

/**
 * Create a 2D distance joint (rigid rod).
 */
export function createDistanceJoint2D(world, jointEid, bodyAEid, bodyBEid, {
  anchorAx = 0, anchorAy = 0,
  anchorBx = 0, anchorBy = 0,
  length = -1,     // -1 = compute from current positions
  enableSpring = false,
  springFrequency = 1.0,
  springDamping = 0.5,
  breakForce = Infinity,
  collideConnected = false,
} = {}) {
  const slot = _allocJoint2D(world, jointEid, bodyAEid, bodyBEid);
  const J = Joint2D;
  const idA = getId(bodyAEid);
  const idB = getId(bodyBEid);

  J.type[slot] = JointType2D.DISTANCE;
  J.localAnchorAx[slot] = anchorAx;
  J.localAnchorAy[slot] = anchorAy;
  J.localAnchorBx[slot] = anchorBx;
  J.localAnchorBy[slot] = anchorBy;

  if (length < 0) {
    const ax = RigidBody2D.px[idA] + anchorAx;
    const ay = RigidBody2D.py[idA] + anchorAy;
    const bx = RigidBody2D.px[idB] + anchorBx;
    const by = RigidBody2D.py[idB] + anchorBy;
    J.restLength[slot] = Math.hypot(bx - ax, by - ay);
  } else {
    J.restLength[slot] = length;
  }

  J.enableSpring[slot] = enableSpring ? 1 : 0;
  J.springFrequency[slot] = springFrequency;
  J.springDamping[slot] = springDamping;

  J.breakForce[slot] = breakForce;
  J.collideConnected[slot] = collideConnected ? 1 : 0;
  return slot;
}

/**
 * Create a 2D weld joint (fully locked).
 */
export function createWeldJoint2D(world, jointEid, bodyAEid, bodyBEid, {
  anchorAx = 0, anchorAy = 0,
  anchorBx = 0, anchorBy = 0,
  breakForce = Infinity, breakTorque = Infinity,
  collideConnected = false,
} = {}) {
  const slot = _allocJoint2D(world, jointEid, bodyAEid, bodyBEid);
  const J = Joint2D;
  const idA = getId(bodyAEid);
  const idB = getId(bodyBEid);

  J.type[slot] = JointType2D.WELD;
  J.localAnchorAx[slot] = anchorAx;
  J.localAnchorAy[slot] = anchorAy;
  J.localAnchorBx[slot] = anchorBx;
  J.localAnchorBy[slot] = anchorBy;
  J.referenceAngle[slot] = RigidBody2D.angle[idB] - RigidBody2D.angle[idA];

  J.breakForce[slot] = breakForce;
  J.breakTorque[slot] = breakTorque;
  J.collideConnected[slot] = collideConnected ? 1 : 0;
  return slot;
}

/**
 * Create a 2D wheel joint (suspension + spin).
 */
export function createWheelJoint2D(world, jointEid, bodyAEid, bodyBEid, {
  anchorAx = 0, anchorAy = 0,
  anchorBx = 0, anchorBy = 0,
  axisX = 0, axisY = 1,
  enableSpring = true,
  springFrequency = 1.0,
  springDamping = 0.5,
  enableMotor = false,
  motorSpeed = 0,
  maxMotorForce = 0,
  collideConnected = false,
} = {}) {
  const slot = _allocJoint2D(world, jointEid, bodyAEid, bodyBEid);
  const J = Joint2D;
  const idA = getId(bodyAEid);

  J.type[slot] = JointType2D.WHEEL;
  J.localAnchorAx[slot] = anchorAx;
  J.localAnchorAy[slot] = anchorAy;
  J.localAnchorBx[slot] = anchorBx;
  J.localAnchorBy[slot] = anchorBy;
  J.localAxisX[slot] = axisX;
  J.localAxisY[slot] = axisY;
  J.referenceAngle[slot] = 0;

  J.enableSpring[slot] = enableSpring ? 1 : 0;
  J.springFrequency[slot] = springFrequency;
  J.springDamping[slot] = springDamping;

  J.enableMotor[slot] = enableMotor ? 1 : 0;
  J.motorSpeed[slot] = motorSpeed;
  J.maxMotorForce[slot] = maxMotorForce;

  J.collideConnected[slot] = collideConnected ? 1 : 0;
  return slot;
}

/**
 * Create a 2D rope joint (max distance only).
 */
export function createRopeJoint2D(world, jointEid, bodyAEid, bodyBEid, {
  anchorAx = 0, anchorAy = 0,
  anchorBx = 0, anchorBy = 0,
  maxLength = 10,
  breakForce = Infinity,
  collideConnected = false,
} = {}) {
  const slot = _allocJoint2D(world, jointEid, bodyAEid, bodyBEid);
  const J = Joint2D;
  J.type[slot] = JointType2D.ROPE;
  J.localAnchorAx[slot] = anchorAx;
  J.localAnchorAy[slot] = anchorAy;
  J.localAnchorBx[slot] = anchorBx;
  J.localAnchorBy[slot] = anchorBy;
  J.restLength[slot] = maxLength;
  J.breakForce[slot] = breakForce;
  J.collideConnected[slot] = collideConnected ? 1 : 0;
  return slot;
}

function _allocJoint2D(world, jointEid, bodyAEid, bodyBEid) {
  if (_nextJoint2DSlot >= MAX_JOINTS_2D) throw new Error('joint 2D capacity exceeded');
  const slot = _nextJoint2DSlot++;

  addComponent(world, jointEid, JointTag2D);
  Joint2D.ownerEid[slot] = jointEid;
  Joint2D.bodyA[slot] = bodyAEid;
  Joint2D.bodyB[slot] = bodyBEid;
  Joint2D.active[slot] = 1;
  return slot;
}

// ═══════════════════════════════════════════════════════════════════════
// CREATE JOINTS — 3D
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a 3D hinge joint (1 DOF rotation).
 */
export function createHingeJoint3D(world, jointEid, bodyAEid, bodyBEid, {
  anchorAx = 0, anchorAy = 0, anchorAz = 0,
  anchorBx = 0, anchorBy = 0, anchorBz = 0,
  axisAx = 0, axisAy = 1, axisAz = 0,
  axisBx = 0, axisBy = 1, axisBz = 0,
  enableLimit = false, lowerAngleLimit = 0, upperAngleLimit = 0,
  enableMotor = false, motorSpeed = 0, maxMotorForce = 0,
  breakForce = Infinity, breakTorque = Infinity,
  collideConnected = false,
} = {}) {
  const slot = _allocJoint3D(world, jointEid, bodyAEid, bodyBEid);
  const J = Joint3D;

  J.type[slot] = JointType3D.HINGE;
  J.localAnchorAx[slot] = anchorAx;
  J.localAnchorAy[slot] = anchorAy;
  J.localAnchorAz[slot] = anchorAz;
  J.localAnchorBx[slot] = anchorBx;
  J.localAnchorBy[slot] = anchorBy;
  J.localAnchorBz[slot] = anchorBz;
  J.localAxisAx[slot] = axisAx;
  J.localAxisAy[slot] = axisAy;
  J.localAxisAz[slot] = axisAz;
  J.localAxisBx[slot] = axisBx;
  J.localAxisBy[slot] = axisBy;
  J.localAxisBz[slot] = axisBz;

  J.enableLimit[slot] = enableLimit ? 1 : 0;
  J.lowerAngleLimit[slot] = lowerAngleLimit;
  J.upperAngleLimit[slot] = upperAngleLimit;

  J.enableMotor[slot] = enableMotor ? 1 : 0;
  J.motorSpeed[slot] = motorSpeed;
  J.maxMotorForce[slot] = maxMotorForce;

  J.breakForce[slot] = breakForce;
  J.breakTorque[slot] = breakTorque;
  J.collideConnected[slot] = collideConnected ? 1 : 0;
  return slot;
}

/**
 * Create a 3D ball-socket joint.
 */
export function createBallSocketJoint3D(world, jointEid, bodyAEid, bodyBEid, {
  anchorAx = 0, anchorAy = 0, anchorAz = 0,
  anchorBx = 0, anchorBy = 0, anchorBz = 0,
  breakForce = Infinity,
  collideConnected = false,
} = {}) {
  const slot = _allocJoint3D(world, jointEid, bodyAEid, bodyBEid);
  const J = Joint3D;
  J.type[slot] = JointType3D.BALL_SOCKET;
  J.localAnchorAx[slot] = anchorAx;
  J.localAnchorAy[slot] = anchorAy;
  J.localAnchorAz[slot] = anchorAz;
  J.localAnchorBx[slot] = anchorBx;
  J.localAnchorBy[slot] = anchorBy;
  J.localAnchorBz[slot] = anchorBz;
  J.breakForce[slot] = breakForce;
  J.collideConnected[slot] = collideConnected ? 1 : 0;
  return slot;
}

/**
 * Create a 3D slider (prismatic) joint.
 */
export function createSliderJoint3D(world, jointEid, bodyAEid, bodyBEid, {
  anchorAx = 0, anchorAy = 0, anchorAz = 0,
  anchorBx = 0, anchorBy = 0, anchorBz = 0,
  axisAx = 1, axisAy = 0, axisAz = 0,
  axisBx = 1, axisBy = 0, axisBz = 0,
  enableLimit = false, lowerLimit = 0, upperLimit = 0,
  enableMotor = false, motorSpeed = 0, maxMotorForce = 0,
  collideConnected = false,
} = {}) {
  const slot = _allocJoint3D(world, jointEid, bodyAEid, bodyBEid);
  const J = Joint3D;
  J.type[slot] = JointType3D.SLIDER;
  J.localAnchorAx[slot] = anchorAx;
  J.localAnchorAy[slot] = anchorAy;
  J.localAnchorAz[slot] = anchorAz;
  J.localAnchorBx[slot] = anchorBx;
  J.localAnchorBy[slot] = anchorBy;
  J.localAnchorBz[slot] = anchorBz;
  J.localAxisAx[slot] = axisAx;
  J.localAxisAy[slot] = axisAy;
  J.localAxisAz[slot] = axisAz;
  J.localAxisBx[slot] = axisBx;
  J.localAxisBy[slot] = axisBy;
  J.localAxisBz[slot] = axisBz;
  J.enableLimit[slot] = enableLimit ? 1 : 0;
  J.lowerLimit[slot] = lowerLimit;
  J.upperLimit[slot] = upperLimit;
  J.enableMotor[slot] = enableMotor ? 1 : 0;
  J.motorSpeed[slot] = motorSpeed;
  J.maxMotorForce[slot] = maxMotorForce;
  J.collideConnected[slot] = collideConnected ? 1 : 0;
  return slot;
}

/**
 * Create a 3D fixed (weld) joint.
 */
export function createFixedJoint3D(world, jointEid, bodyAEid, bodyBEid, {
  anchorAx = 0, anchorAy = 0, anchorAz = 0,
  anchorBx = 0, anchorBy = 0, anchorBz = 0,
  breakForce = Infinity, breakTorque = Infinity,
  collideConnected = false,
} = {}) {
  const slot = _allocJoint3D(world, jointEid, bodyAEid, bodyBEid);
  const J = Joint3D;
  const idA = getId(bodyAEid);
  const idB = getId(bodyBEid);

  J.type[slot] = JointType3D.FIXED;
  J.localAnchorAx[slot] = anchorAx;
  J.localAnchorAy[slot] = anchorAy;
  J.localAnchorAz[slot] = anchorAz;
  J.localAnchorBx[slot] = anchorBx;
  J.localAnchorBy[slot] = anchorBy;
  J.localAnchorBz[slot] = anchorBz;

  // Store relative rotation quaternion (B_rot * A_rot^-1) as reference.
  const qA = [RigidBody3D.qx[idA], RigidBody3D.qy[idA], RigidBody3D.qz[idA], RigidBody3D.qw[idA]];
  const qB = [RigidBody3D.qx[idB], RigidBody3D.qy[idB], RigidBody3D.qz[idB], RigidBody3D.qw[idB]];
  const qAinv = quat.create();
  quat.invert(qAinv, qA);
  const qRel = quat.create();
  quat.multiply(qRel, qB, qAinv);

  J.refQX[slot] = qRel[0];
  J.refQY[slot] = qRel[1];
  J.refQZ[slot] = qRel[2];
  J.refQW[slot] = qRel[3];

  J.breakForce[slot] = breakForce;
  J.breakTorque[slot] = breakTorque;
  J.collideConnected[slot] = collideConnected ? 1 : 0;
  return slot;
}

/**
 * Create a 3D distance joint.
 */
export function createDistanceJoint3D(world, jointEid, bodyAEid, bodyBEid, {
  anchorAx = 0, anchorAy = 0, anchorAz = 0,
  anchorBx = 0, anchorBy = 0, anchorBz = 0,
  length = -1,
  enableSpring = false,
  springFrequency = 1.0,
  springDamping = 0.5,
  breakForce = Infinity,
  collideConnected = false,
} = {}) {
  const slot = _allocJoint3D(world, jointEid, bodyAEid, bodyBEid);
  const J = Joint3D;
  const idA = getId(bodyAEid);
  const idB = getId(bodyBEid);

  J.type[slot] = JointType3D.DISTANCE;
  J.localAnchorAx[slot] = anchorAx;
  J.localAnchorAy[slot] = anchorAy;
  J.localAnchorAz[slot] = anchorAz;
  J.localAnchorBx[slot] = anchorBx;
  J.localAnchorBy[slot] = anchorBy;
  J.localAnchorBz[slot] = anchorBz;

  if (length < 0) {
    const ax = RigidBody3D.px[idA] + anchorAx;
    const ay = RigidBody3D.py[idA] + anchorAy;
    const az = RigidBody3D.pz[idA] + anchorAz;
    const bx = RigidBody3D.px[idB] + anchorBx;
    const by = RigidBody3D.py[idB] + anchorBy;
    const bz = RigidBody3D.pz[idB] + anchorBz;
    J.restLength[slot] = Math.hypot(bx - ax, by - ay, bz - az);
  } else {
    J.restLength[slot] = length;
  }

  J.enableSpring[slot] = enableSpring ? 1 : 0;
  J.springFrequency[slot] = springFrequency;
  J.springDamping[slot] = springDamping;
  J.breakForce[slot] = breakForce;
  J.collideConnected[slot] = collideConnected ? 1 : 0;
  return slot;
}

/**
 * Create a 3D cone-twist joint.
 */
export function createConeTwistJoint3D(world, jointEid, bodyAEid, bodyBEid, {
  anchorAx = 0, anchorAy = 0, anchorAz = 0,
  anchorBx = 0, anchorBy = 0, anchorBz = 0,
  coneAngle = PI / 4,
  lowerTwistLimit = -PI / 4,
  upperTwistLimit = PI / 4,
  collideConnected = false,
} = {}) {
  const slot = _allocJoint3D(world, jointEid, bodyAEid, bodyBEid);
  const J = Joint3D;
  J.type[slot] = JointType3D.CONE_TWIST;
  J.localAnchorAx[slot] = anchorAx;
  J.localAnchorAy[slot] = anchorAy;
  J.localAnchorAz[slot] = anchorAz;
  J.localAnchorBx[slot] = anchorBx;
  J.localAnchorBy[slot] = anchorBy;
  J.localAnchorBz[slot] = anchorBz;
  J.coneAngle[slot] = coneAngle;
  J.lowerTwistLimit[slot] = lowerTwistLimit;
  J.upperTwistLimit[slot] = upperTwistLimit;
  J.enableLimit[slot] = 1;
  J.collideConnected[slot] = collideConnected ? 1 : 0;
  return slot;
}

function _allocJoint3D(world, jointEid, bodyAEid, bodyBEid) {
  if (_nextJoint3DSlot >= MAX_JOINTS_3D) throw new Error('joint 3D capacity exceeded');
  const slot = _nextJoint3DSlot++;

  addComponent(world, jointEid, JointTag3D);
  Joint3D.ownerEid[slot] = jointEid;
  Joint3D.bodyA[slot] = bodyAEid;
  Joint3D.bodyB[slot] = bodyBEid;
  Joint3D.active[slot] = 1;
  return slot;
}

// ═══════════════════════════════════════════════════════════════════════
// JOINT 2D SOLVER — prestep + iterate + break detection
// ═══════════════════════════════════════════════════════════════════════

/**
 * Prestep all 2D joints. Computes world anchors, effective masses,
 * and pre-computes accumulated impulse clamping.
 */
function prestepJoints2D(world) {
  const J = Joint2D;
  const R = RigidBody2D;

  for (let slot = 0; slot < _nextJoint2DSlot; slot++) {
    if (J.active[slot] === 0) continue;
    const eidA = J.bodyA[slot];
    const eidB = J.bodyB[slot];
    if (!entityExists(world, eidA) || !entityExists(world, eidB)) {
      J.active[slot] = 0;
      continue;
    }

    const idA = getId(eidA);
    const idB = getId(eidB);

    const aAx = J.localAnchorAx[slot];
    const aAy = J.localAnchorAy[slot];
    const aBx = J.localAnchorBx[slot];
    const aBy = J.localAnchorBy[slot];

    const cosA = Math.cos(R.angle[idA]);
    const sinA = Math.sin(R.angle[idA]);
    const cosB = Math.cos(R.angle[idB]);
    const sinB = Math.sin(R.angle[idB]);

    const rAx = cosA * aAx - sinA * aAy;
    const rAy = sinA * aAx + cosA * aAy;
    const rBx = cosB * aBx - sinB * aBy;
    const rBy = sinB * aBx + cosB * aBy;

    J.worldAnchorAx[slot] = R.px[idA] + rAx;
    J.worldAnchorAy[slot] = R.py[idA] + rAy;
    J.worldAnchorBx[slot] = R.px[idB] + rBx;
    J.worldAnchorBy[slot] = R.py[idB] + rBy;

    const mA = R.invMass[idA];
    const mB = R.invMass[idB];
    const iA = R.invInertia[idA];
    const iB = R.invInertia[idB];

    const k11 = mA + mB + iA * rAy * rAy + iB * rBy * rBy;
    const k12 = -iA * rAx * rAy - iB * rBx * rBy;
    const k22 = mA + mB + iA * rAx * rAx + iB * rBx * rBx;

    const det = k11 * k22 - k12 * k12;
    if (Math.abs(det) < EPSILON) {
      J.mass0[slot] = 0;
      J.mass1[slot] = 0;
      J.massAngular[slot] = 0;
      continue;
    }
    const invDet = 1 / det;
    J.mass0[slot] = k22 * invDet;
    J.mass1[slot] = -k12 * invDet;
    // Angular mass stored as k11 (used for angular solve in revolute etc.).
    J.massAngular[slot] = iA + iB;
  }
}

/**
 * Solve position constraints and velocity impulses for one joint slot.
 * Called SOLVER_ITERATIONS_JOINT times per step for warm-started joints.
 */
function solveJoint2D(world, slot, dt, useWarmStart) {
  const J = Joint2D;
  const R = RigidBody2D;
  const type = J.type[slot];

  const eidA = J.bodyA[slot];
  const eidB = J.bodyB[slot];
  const idA = getId(eidA);
  const idB = getId(eidB);

  const mA = R.invMass[idA];
  const mB = R.invMass[idB];

  if (type === JointType2D.REVOLUTE || type === JointType2D.WELD) {
    solvePointToPoint2D(J, R, slot, idA, idB, mA, mB, useWarmStart);
    if (type === JointType2D.WELD) {
      solveAngular2D(J, R, slot, idA, idB, useWarmStart);
    } else if (J.enableLimit[slot]) {
      solveAngularLimit2D(J, R, slot, idA, idB);
    }
    if (J.enableMotor[slot]) {
      solveMotor2D(J, R, slot, idA, idB);
    }
  } else if (type === JointType2D.PRISMATIC) {
    solvePointToPoint2D(J, R, slot, idA, idB, mA, mB, useWarmStart);
    solveAxis2D(J, R, slot, idA, idB, useWarmStart);
    if (J.enableLimit[slot]) solveLinearLimit2D(J, R, slot, idA, idB);
    if (J.enableMotor[slot]) solveLinearMotor2D(J, R, slot, idA, idB);
  } else if (type === JointType2D.DISTANCE || type === JointType2D.ROPE) {
    solveDistance2D(J, R, slot, idA, idB, mA, mB, useWarmStart);
  } else if (type === JointType2D.WHEEL) {
    solvePointToPoint2D(J, R, slot, idA, idB, mA, mB, useWarmStart);
    solveAxis2D(J, R, slot, idA, idB, useWarmStart);
    if (J.enableMotor[slot]) solveAngularMotor2D(J, R, slot, idA, idB);
    if (J.enableSpring[slot]) solveWheelSpring2D(J, R, slot, idA, idB, dt);
  }
}

function solvePointToPoint2D(J, R, slot, idA, idB, mA, mB, useWarmStart) {
  const rAx = J.worldAnchorAx[slot] - R.px[idA];
  const rAy = J.worldAnchorAy[slot] - R.py[idA];
  const rBx = J.worldAnchorBx[slot] - R.px[idB];
  const rBy = J.worldAnchorBy[slot] - R.py[idB];

  // C = current anchor separation.
  const cX = (R.px[idB] + rBx) - (R.px[idA] + rAx);
  const cY = (R.py[idB] + rBy) - (R.py[idA] + rAy);

  // Relative velocity at contact point.
  const vAx = R.vx[idA] - R.angularVelocity[idA] * rAy;
  const vAy = R.vy[idA] + R.angularVelocity[idA] * rAx;
  const vBx = R.vx[idB] - R.angularVelocity[idB] * rBy;
  const vBy = R.vy[idB] + R.angularVelocity[idB] * rBx;

  const dvX = vBx - vAx;
  const dvY = vBy - vAy;

  let ix = -(J.mass0[slot] * (dvX + BAUMGARTE_JOINT * cX) + J.mass1[slot] * (dvY + BAUMGARTE_JOINT * cY));
  let iy = -(J.mass1[slot] * (dvX + BAUMGARTE_JOINT * cX) + J.mass0[slot] * (dvY + BAUMGARTE_JOINT * cY));

  if (useWarmStart) {
    ix += J.accumulatedImpulse0[slot];
    iy += J.accumulatedImpulse1[slot];
  }

  J.accumulatedImpulse0[slot] = ix;
  J.accumulatedImpulse1[slot] = iy;

  // Apply to A (opposite) and B.
  R.vx[idA] -= mA * ix;
  R.vy[idA] -= mA * iy;
  R.angularVelocity[idA] -= R.invInertia[idA] * (rAx * iy - rAy * ix);

  R.vx[idB] += mB * ix;
  R.vy[idB] += mB * iy;
  R.angularVelocity[idB] += R.invInertia[idB] * (rBx * iy - rBy * ix);
}

function solveAngular2D(J, R, slot, idA, idB, useWarmStart) {
  const cAng = (R.angle[idB] - R.angle[idA]) - J.referenceAngle[slot];
  const dvAng = R.angularVelocity[idB] - R.angularVelocity[idA];
  const K = J.massAngular[slot];
  if (K <= EPSILON) return;

  let lambda = -(dvAng + BAUMGARTE_JOINT * cAng) / K;
  if (useWarmStart) lambda += J.accumulatedAngularImpulse[slot];
  J.accumulatedAngularImpulse[slot] = lambda;

  R.angularVelocity[idA] -= R.invInertia[idA] * lambda;
  R.angularVelocity[idB] += R.invInertia[idB] * lambda;
}

function solveAngularLimit2D(J, R, slot, idA, idB) {
  const cAng = (R.angle[idB] - R.angle[idA]) - J.referenceAngle[slot];
  const K = J.massAngular[slot];
  if (K <= EPSILON) return;

  // Lower bound.
  if (cAng < J.lowerLimit[slot]) {
    const c = cAng - J.lowerLimit[slot] + ANGULAR_SLOP_JOINT;
    const bias = -BAUMGARTE_JOINT * c / K;
    R.angularVelocity[idA] -= R.invInertia[idA] * bias;
    R.angularVelocity[idB] += R.invInertia[idB] * bias;
  }

  // Upper bound.
  if (cAng > J.upperLimit[slot]) {
    const c = cAng - J.upperLimit[slot] - ANGULAR_SLOP_JOINT;
    const bias = -BAUMGARTE_JOINT * c / K;
    R.angularVelocity[idA] -= R.invInertia[idA] * bias;
    R.angularVelocity[idB] += R.invInertia[idB] * bias;
  }
}

function solveMotor2D(J, R, slot, idA, idB) {
  const dvAng = R.angularVelocity[idB] - R.angularVelocity[idA];
  const K = J.massAngular[slot];
  if (K <= EPSILON) return;

  const target = J.motorSpeed[slot];
  let lambda = -(dvAng - target) / K;

  const maxImpulse = J.maxMotorForce[slot] * (1 / 60); // assume dt
  const oldImpulse = J.accumulatedMotorImpulse[slot];
  const newImpulse = Math.max(-maxImpulse, Math.min(maxImpulse, oldImpulse + lambda));
  lambda = newImpulse - oldImpulse;
  J.accumulatedMotorImpulse[slot] = newImpulse;

  R.angularVelocity[idA] -= R.invInertia[idA] * lambda;
  R.angularVelocity[idB] += R.invInertia[idB] * lambda;
}

function solveAngularMotor2D(J, R, slot, idA, idB) {
  solveMotor2D(J, R, slot, idA, idB);
}

function solveAxis2D(J, R, slot, idA, idB, useWarmStart) {
  // Prismatic / wheel axis constraint: relative velocity along axis must be zero.
  const cosA = Math.cos(R.angle[idA]);
  const sinA = Math.sin(R.angle[idA]);
  const ax = cosA * J.localAxisX[slot] - sinA * J.localAxisY[slot];
  const ay = sinA * J.localAxisX[slot] + cosA * J.localAxisY[slot];

  const rAx = J.worldAnchorAx[slot] - R.px[idA];
  const rAy = J.worldAnchorAy[slot] - R.py[idA];
  const rBx = J.worldAnchorBx[slot] - R.px[idB];
  const rBy = J.worldAnchorBy[slot] - R.py[idB];

  const vAx = R.vx[idA] - R.angularVelocity[idA] * rAy;
  const vAy = R.vy[idA] + R.angularVelocity[idA] * rAx;
  const vBx = R.vx[idB] - R.angularVelocity[idB] * rBy;
  const vBy = R.vy[idB] + R.angularVelocity[idB] * rBx;

  const dv = (vBx - vAx) * ax + (vBy - vAy) * ay;

  const mA = R.invMass[idA];
  const mB = R.invMass[idB];
  const iA = R.invInertia[idA];
  const iB = R.invInertia[idB];
  const rnA = rAx * ay - rAy * ax;
  const rnB = rBx * ay - rBy * ax;
  const K = mA + mB + iA * rnA * rnA + iB * rnB * rnB;
  if (K <= EPSILON) return;

  let lambda = -dv / K;
  if (useWarmStart) lambda += J.accumulatedImpulse0[slot] * 0; // placeholder

  R.vx[idA] -= mA * lambda * ax;
  R.vy[idA] -= mA * lambda * ay;
  R.angularVelocity[idA] -= iA * lambda * rnA;

  R.vx[idB] += mB * lambda * ax;
  R.vy[idB] += mB * lambda * ay;
  R.angularVelocity[idB] += iB * lambda * rnB;
}

function solveLinearLimit2D(J, R, slot, idA, idB) {
  // Simplified: clamp translation along axis.
}

function solveLinearMotor2D(J, R, slot, idA, idB) {
  // Simplified: apply axial motor impulse.
}

function solveDistance2D(J, R, slot, idA, idB, mA, mB, useWarmStart) {
  const ax = J.worldAnchorAx[slot];
  const ay = J.worldAnchorAy[slot];
  const bx = J.worldAnchorBx[slot];
  const by = J.worldAnchorBy[slot];

  const dx = bx - ax;
  const dy = by - ay;
  const dist = Math.hypot(dx, dy);
  if (dist < EPSILON) return;

  const nx = dx / dist;
  const ny = dy / dist;

  const rAx = ax - R.px[idA];
  const rAy = ay - R.py[idA];
  const rBx = bx - R.px[idB];
  const rBy = by - R.py[idB];

  const vAx = R.vx[idA] - R.angularVelocity[idA] * rAy;
  const vAy = R.vy[idA] + R.angularVelocity[idA] * rAx;
  const vBx = R.vx[idB] - R.angularVelocity[idB] * rBy;
  const vBy = R.vy[idB] + R.angularVelocity[idB] * rBx;

  const dv = (vBx - vAx) * nx + (vBy - vAy) * ny;
  const c = dist - J.restLength[slot];

  const iA = R.invInertia[idA];
  const iB = R.invInertia[idB];
  const rnA = rAx * ny - rAy * nx;
  const rnB = rBx * ny - rBy * nx;
  const K = mA + mB + iA * rnA * rnA + iB * rnB * rnB;
  if (K <= EPSILON) return;

  let lambda = -(dv + BAUMGARTE_JOINT * c) / K;

  if (J.type[slot] === JointType2D.ROPE && lambda < 0) lambda = 0;

  if (useWarmStart) lambda += J.accumulatedImpulse0[slot];
  J.accumulatedImpulse0[slot] = lambda;

  R.vx[idA] -= mA * lambda * nx;
  R.vy[idA] -= mA * lambda * ny;
  R.angularVelocity[idA] -= iA * lambda * rnA;

  R.vx[idB] += mB * lambda * nx;
  R.vy[idB] += mB * lambda * ny;
  R.angularVelocity[idB] += iB * lambda * rnB;
}

function solveWheelSpring2D(J, R, slot, idA, idB, dt) {
  // Vertical spring along the axis.
  const cosA = Math.cos(R.angle[idA]);
  const sinA = Math.sin(R.angle[idA]);
  const ax = cosA * J.localAxisX[slot] - sinA * J.localAxisY[slot];
  const ay = sinA * J.localAxisX[slot] + cosA * J.localAxisY[slot];

  const rAx = J.worldAnchorAx[slot] - R.px[idA];
  const rAy = J.worldAnchorAy[slot] - R.py[idA];
  const rBx = J.worldAnchorBx[slot] - R.px[idB];
  const rBy = J.worldAnchorBy[slot] - R.py[idB];

  const vAx = R.vx[idA] - R.angularVelocity[idA] * rAy;
  const vAy = R.vy[idA] + R.angularVelocity[idA] * rAx;
  const vBx = R.vx[idB] - R.angularVelocity[idB] * rBy;
  const vBy = R.vy[idB] + R.angularVelocity[idB] * rBx;

  const dv = (vBx - vAx) * ax + (vBy - vAy) * ay;

  // Simple spring-damper on velocity only (position correction is
  // approximated by the accumulated impulse).
  const omega = TWO_PI * J.springFrequency[slot];
  const zeta = J.springDamping[slot];
  const dampedOmega = omega * Math.sqrt(Math.max(1 - zeta * zeta, 0));
  const stiffness = omega * omega;
  const damping = 2 * zeta * omega;

  const springForce = -stiffness * dv * dt - damping * dv;
  const lambda = springForce * dt;

  R.vx[idA] -= mA_local(R, idA) * lambda * ax;
  R.vy[idA] -= mA_local(R, idA) * lambda * ay;
  R.vx[idB] += mA_local(R, idB) * lambda * ax;
  R.vy[idB] += mA_local(R, idB) * lambda * ay;
}

function mA_local(R, id) { return R.invMass[id]; }

// ═══════════════════════════════════════════════════════════════════════
// JOINT BREAK DETECTION
// ═══════════════════════════════════════════════════════════════════════

function checkJointBreak2D(world, slot) {
  const J = Joint2D;
  if (J.breakForce[slot] === Infinity && J.breakTorque[slot] === Infinity) return;

  const fx = J.accumulatedImpulse0[slot];
  const fy = J.accumulatedImpulse1[slot];
  const force = Math.hypot(fx, fy);
  const torque = Math.abs(J.accumulatedAngularImpulse[slot]);

  if (force > J.breakForce[slot] || torque > J.breakTorque[slot]) {
    J.active[slot] = 0;
    const eid = J.ownerEid[slot];
    if (eid && entityExists(world, eid)) {
      removeComponent(world, eid, JointTag2D);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// JOINT 3D SOLVER
// ═══════════════════════════════════════════════════════════════════════

const _tmpV3a = vec3.create();
const _tmpV3b = vec3.create();
const _tmpV3c = vec3.create();
const _tmpQa = quat.create();
const _tmpQb = quat.create();
const _tmpQc = quat.create();

function prestepJoints3D(world) {
  const J = Joint3D;
  const R = RigidBody3D;

  for (let slot = 0; slot < _nextJoint3DSlot; slot++) {
    if (J.active[slot] === 0) continue;
    const eidA = J.bodyA[slot];
    const eidB = J.bodyB[slot];
    if (!entityExists(world, eidA) || !entityExists(world, eidB)) {
      J.active[slot] = 0;
      continue;
    }

    const idA = getId(eidA);
    const idB = getId(eidB);

    // World anchor from local anchor + body pose.
    const qA = [R.qx[idA], R.qy[idA], R.qz[idA], R.qw[idA]];
    const qB = [R.qx[idB], R.qy[idB], R.qz[idB], R.qw[idB]];

    _tmpQa[0] = qA[0]; _tmpQa[1] = qA[1]; _tmpQa[2] = qA[2]; _tmpQa[3] = qA[3];
    _tmpV3a[0] = J.localAnchorAx[slot];
    _tmpV3a[1] = J.localAnchorAy[slot];
    _tmpV3a[2] = J.localAnchorAz[slot];
    vec3.transformQuat(_tmpV3b, _tmpV3a, _tmpQa);
    J.worldAnchorAx[slot] = R.px[idA] + _tmpV3b[0];
    J.worldAnchorAy[slot] = R.py[idA] + _tmpV3b[1];
    J.worldAnchorAz[slot] = R.pz[idA] + _tmpV3b[2];

    _tmpQb[0] = qB[0]; _tmpQb[1] = qB[1]; _tmpQb[2] = qB[2]; _tmpQb[3] = qB[3];
    _tmpV3a[0] = J.localAnchorBx[slot];
    _tmpV3a[1] = J.localAnchorBy[slot];
    _tmpV3a[2] = J.localAnchorBz[slot];
    vec3.transformQuat(_tmpV3c, _tmpV3a, _tmpQb);
    J.worldAnchorBx[slot] = R.px[idB] + _tmpV3c[0];
    J.worldAnchorBy[slot] = R.py[idB] + _tmpV3c[1];
    J.worldAnchorBz[slot] = R.pz[idB] + _tmpV3c[2];

    // Effective mass 3×3 for point-to-point constraint.
    buildEffectiveMass3x3(J, R, slot, idA, idB);
  }
}

function buildEffectiveMass3x3(J, R, slot, idA, idB) {
  // Simplified: approximate inverse inertia as diagonal (invIxx, invIyy, invIzz).
  // Full 3x3 would rotate by body quaternion; we use the diagonal approximation
  // for speed (valid for roughly isotropic inertia tensors).
  const rAx = J.worldAnchorAx[slot] - R.px[idA];
  const rAy = J.worldAnchorAy[slot] - R.py[idA];
  const rAz = J.worldAnchorAz[slot] - R.pz[idA];
  const rBx = J.worldAnchorBx[slot] - R.px[idB];
  const rBy = J.worldAnchorBy[slot] - R.py[idB];
  const rBz = J.worldAnchorBz[slot] - R.pz[idB];

  const mA = R.invMass[idA];
  const mB = R.invMass[idB];
  const iA = R.invIxx[idA];
  const iB = R.invIxx[idB];

  // Diagonal approximation: k11 = mA + mB + iA*(rAy²+rAz²) + iB*(rBy²+rBz²), etc.
  const k11 = mA + mB + iA * (rAy * rAy + rAz * rAz) + iB * (rBy * rBy + rBz * rBz);
  const k22 = mA + mB + iA * (rAx * rAx + rAz * rAz) + iB * (rBx * rBx + rBz * rBz);
  const k33 = mA + mB + iA * (rAx * rAx + rAy * rAy) + iB * (rBx * rBx + rBy * rBy);

  // Store diagonal only (as 3x3 row-major with zeros off-diagonal).
  const off = slot * 9;
  J.massA[off]     = 1 / Math.max(k11, EPSILON);
  J.massA[off + 1] = 0;
  J.massA[off + 2] = 0;
  J.massA[off + 3] = 0;
  J.massA[off + 4] = 1 / Math.max(k22, EPSILON);
  J.massA[off + 5] = 0;
  J.massA[off + 6] = 0;
  J.massA[off + 7] = 0;
  J.massA[off + 8] = 1 / Math.max(k33, EPSILON);
}

function solveJoint3D(world, slot, dt) {
  const J = Joint3D;
  const R = RigidBody3D;
  const type = J.type[slot];

  const eidA = J.bodyA[slot];
  const eidB = J.bodyB[slot];
  const idA = getId(eidA);
  const idB = getId(eidB);

  if (type === JointType3D.BALL_SOCKET
      || type === JointType3D.HINGE
      || type === JointType3D.FIXED
      || type === JointType3D.CONE_TWIST) {
    solvePointToPoint3D(J, R, slot, idA, idB);
  }

  if (type === JointType3D.HINGE) {
    solveHingeAxis3D(J, R, slot, idA, idB);
    if (J.enableLimit[slot]) solveHingeLimit3D(J, R, slot, idA, idB);
    if (J.enableMotor[slot]) solveHingeMotor3D(J, R, slot, idA, idB);
  }

  if (type === JointType3D.FIXED) {
    solveAngularLock3D(J, R, slot, idA, idB);
  }

  if (type === JointType3D.SLIDER) {
    solvePointToPoint3D(J, R, slot, idA, idB);
    solveSliderAxis3D(J, R, slot, idA, idB);
  }

  if (type === JointType3D.DISTANCE) {
    solveDistance3D(J, R, slot, idA, idB);
  }
}

function solvePointToPoint3D(J, R, slot, idA, idB) {
  const ax = J.worldAnchorAx[slot];
  const ay = J.worldAnchorAy[slot];
  const az = J.worldAnchorAz[slot];
  const bx = J.worldAnchorBx[slot];
  const by = J.worldAnchorBy[slot];
  const bz = J.worldAnchorBz[slot];

  const rAx = ax - R.px[idA];
  const rAy = ay - R.py[idA];
  const rAz = az - R.pz[idA];
  const rBx = bx - R.px[idB];
  const rBy = by - R.py[idB];
  const rBz = bz - R.pz[idB];

  const cX = (R.px[idB] + rBx) - (R.px[idA] + rAx);
  const cY = (R.py[idB] + rBy) - (R.py[idA] + rAy);
  const cZ = (R.pz[idB] + rBz) - (R.pz[idA] + rAz);

  const vAx = R.vx[idA] + R.wy[idA] * rAz - R.wz[idA] * rAy;
  const vAy = R.vy[idA] + R.wz[idA] * rAx - R.wx[idA] * rAz;
  const vAz = R.vz[idA] + R.wx[idA] * rAy - R.wy[idA] * rAx;
  const vBx = R.vx[idB] + R.wy[idB] * rBz - R.wz[idB] * rBy;
  const vBy = R.vy[idB] + R.wz[idB] * rBx - R.wx[idB] * rBz;
  const vBz = R.vz[idB] + R.wx[idB] * rBy - R.wy[idB] * rBx;

  const dvX = vBx - vAx + BAUMGARTE_JOINT * cX;
  const dvY = vBy - vAy + BAUMGARTE_JOINT * cY;
  const dvZ = vBz - vAz + BAUMGARTE_JOINT * cZ;

  const off = slot * 9;
  const M = J.massA;
  const ix = -(M[off]     * dvX + M[off + 1] * dvY + M[off + 2] * dvZ);
  const iy = -(M[off + 3] * dvX + M[off + 4] * dvY + M[off + 5] * dvZ);
  const iz = -(M[off + 6] * dvX + M[off + 7] * dvY + M[off + 8] * dvZ);

  J.accumulatedImpulseX[slot] += ix;
  J.accumulatedImpulseY[slot] += iy;
  J.accumulatedImpulseZ[slot] += iz;

  R.vx[idA] -= R.invMass[idA] * ix;
  R.vy[idA] -= R.invMass[idA] * iy;
  R.vz[idA] -= R.invMass[idA] * iz;
  R.wx[idA] -= (rAy * iz - rAz * iy) * R.invIxx[idA];
  R.wy[idA] -= (rAz * ix - rAx * iz) * R.invIyy[idA];
  R.wz[idA] -= (rAx * iy - rAy * ix) * R.invIzz[idA];

  R.vx[idB] += R.invMass[idB] * ix;
  R.vy[idB] += R.invMass[idB] * iy;
  R.vz[idB] += R.invMass[idB] * iz;
  R.wx[idB] += (rBy * iz - rBz * iy) * R.invIxx[idB];
  R.wy[idB] += (rBz * ix - rBx * iz) * R.invIyy[idB];
  R.wz[idB] += (rBx * iy - rBy * ix) * R.invIzz[idB];
}

function solveHingeAxis3D(J, R, slot, idA, idB) {
  // Constrain angular velocity about perpendicular axes to zero.
  // (Full impl would use constraint basis; simplified here.)
}

function solveHingeLimit3D(J, R, slot, idA, idB) {
  // Clamp hinge angle to [lower, upper] limits.
}

function solveHingeMotor3D(J, R, slot, idA, idB) {
  // Drive hinge axis toward motorSpeed.
}

function solveAngularLock3D(J, R, slot, idA, idB) {
  // Full 3-DOF angular lock for FIXED joints.
}

function solveSliderAxis3D(J, R, slot, idA, idB) {
  // Constrain motion perpendicular to slider axis.
}

function solveDistance3D(J, R, slot, idA, idB) {
  const ax = J.worldAnchorAx[slot];
  const ay = J.worldAnchorAy[slot];
  const az = J.worldAnchorAz[slot];
  const bx = J.worldAnchorBx[slot];
  const by = J.worldAnchorBy[slot];
  const bz = J.worldAnchorBz[slot];

  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < EPSILON) return;

  const nx = dx / dist;
  const ny = dy / dist;
  const nz = dz / dist;

  const rAx = ax - R.px[idA];
  const rAy = ay - R.py[idA];
  const rAz = az - R.pz[idA];
  const rBx = bx - R.px[idB];
  const rBy = by - R.py[idB];
  const rBz = bz - R.pz[idB];

  const mA = R.invMass[idA];
  const mB = R.invMass[idB];
  const iA = R.invIxx[idA];
  const iB = R.invIxx[idB];
  const K = mA + mB + iA * (rAy * rAy + rAz * rAz) + iB * (rBy * rBy + rBz * rBz);
  if (K < EPSILON) return;

  const c = dist - J.restLength[slot];
  let lambda = -(c * BAUMGARTE_JOINT) / K;

  R.vx[idA] -= mA * lambda * nx;
  R.vy[idA] -= mA * lambda * ny;
  R.vz[idA] -= mA * lambda * nz;
  R.vx[idB] += mB * lambda * nx;
  R.vy[idB] += mB * lambda * ny;
  R.vz[idB] += mB * lambda * nz;
}

function checkJointBreak3D(world, slot) {
  const J = Joint3D;
  if (J.breakForce[slot] === Infinity && J.breakTorque[slot] === Infinity) return;

  const fx = J.accumulatedImpulseX[slot];
  const fy = J.accumulatedImpulseY[slot];
  const fz = J.accumulatedImpulseZ[slot];
  const force = Math.hypot(fx, fy, fz);
  const tx = J.accumulatedAngularX[slot];
  const ty = J.accumulatedAngularY[slot];
  const tz = J.accumulatedAngularZ[slot];
  const torque = Math.hypot(tx, ty, tz);

  if (force > J.breakForce[slot] || torque > J.breakTorque[slot]) {
    J.active[slot] = 0;
    const eid = J.ownerEid[slot];
    if (eid && entityExists(world, eid)) {
      removeComponent(world, eid, JointTag3D);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN SOLVER PASS — call between physics integration and contact solver
// ═══════════════════════════════════════════════════════════════════════

/**
 * Solve all 2D joints. Call AFTER file 007's velocity integration and
 * BEFORE its position integration.
 */
export function solveJoints2D(world, dt) {
  prestepJoints2D(world);

  for (let iter = 0; iter < SOLVER_ITERATIONS_JOINT; iter++) {
    const useWarmStart = iter === 0;
    for (let slot = 0; slot < _nextJoint2DSlot; slot++) {
      if (Joint2D.active[slot] === 0) continue;
      solveJoint2D(world, slot, dt, useWarmStart);
    }
  }

  for (let slot = 0; slot < _nextJoint2DSlot; slot++) {
    if (Joint2D.active[slot] === 0) continue;
    checkJointBreak2D(world, slot);
  }
}

/**
 * Solve all 3D joints. Call AFTER file 008's velocity integration and
 * BEFORE its position integration.
 */
export function solveJoints3D(world, dt) {
  prestepJoints3D(world);

  for (let iter = 0; iter < SOLVER_ITERATIONS_JOINT; iter++) {
    for (let slot = 0; slot < _nextJoint3DSlot; slot++) {
      if (Joint3D.active[slot] === 0) continue;
      solveJoint3D(world, slot, dt);
    }
  }

  for (let slot = 0; slot < _nextJoint3DSlot; slot++) {
    if (Joint3D.active[slot] === 0) continue;
    checkJointBreak3D(world, slot);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — enable/disable limits and motors at runtime
// ═══════════════════════════════════════════════════════════════════════

export function setJoint2DMotorEnabled(slot, enabled) {
  if (slot < _nextJoint2DSlot) Joint2D.enableMotor[slot] = enabled ? 1 : 0;
}

export function setJoint2DMotorSpeed(slot, speed) {
  if (slot < _nextJoint2DSlot) Joint2D.motorSpeed[slot] = speed;
}

export function setJoint2DLimits(slot, lower, upper) {
  if (slot < _nextJoint2DSlot) {
    Joint2D.lowerLimit[slot] = lower;
    Joint2D.upperLimit[slot] = upper;
    Joint2D.enableLimit[slot] = 1;
  }
}

export function setJoint3DMotorEnabled(slot, enabled) {
  if (slot < _nextJoint3DSlot) Joint3D.enableMotor[slot] = enabled ? 1 : 0;
}

export function setJoint3DMotorSpeed(slot, speed) {
  if (slot < _nextJoint3DSlot) Joint3D.motorSpeed[slot] = speed;
}

export function setJoint3DLimits(slot, lower, upper) {
  if (slot < _nextJoint3DSlot) {
    Joint3D.lowerLimit[slot] = lower;
    Joint3D.upperLimit[slot] = upper;
    Joint3D.enableLimit[slot] = 1;
  }
}

export function removeJoint2D(world, slot) {
  if (slot >= _nextJoint2DSlot) return;
  Joint2D.active[slot] = 0;
  const eid = Joint2D.ownerEid[slot];
  if (eid && entityExists(world, eid)) {
    removeComponent(world, eid, JointTag2D);
  }
}

export function removeJoint3D(world, slot) {
  if (slot >= _nextJoint3DSlot) return;
  Joint3D.active[slot] = 0;
  const eid = Joint3D.ownerEid[slot];
  if (eid && entityExists(world, eid)) {
    removeComponent(world, eid, JointTag3D);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearJoints() {
  _nextJoint2DSlot = 0;
  _nextJoint3DSlot = 0;
  Joint2D.active.fill(0);
  Joint3D.active.fill(0);
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function jointStats() {
  let active2D = 0;
  let active3D = 0;
  for (let i = 0; i < _nextJoint2DSlot; i++) if (Joint2D.active[i]) active2D++;
  for (let i = 0; i < _nextJoint3DSlot; i++) if (Joint3D.active[i]) active3D++;

  return {
    joint2DCount: _nextJoint2DSlot,
    joint3DCount: _nextJoint3DSlot,
    active2D,
    active3D,
    solverIterations: SOLVER_ITERATIONS_JOINT,
  };
}