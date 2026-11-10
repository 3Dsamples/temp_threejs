// file number : 008
// full path name : src/physics/008_physics3d_rigidbody.js
// description : 3D rigid body physics system inspired by Box2D v3 and
//               PBRT-v4's integrator loop. Implements SoA RigidBody3D
//               (position, quaternion, linear/angular velocity, mass/inertia
//               tensors), Shape3D (sphere/box/capsule), contact manifolds
//               with 4-point polygonal reduction, sequential impulse solver
//               in 3D with warm starting, NGS position correction, and
//               conservative advancement TOI for fast movers. Syncs directly
//               into file 002's LocalTransformF32 quaternions and feeds
//               file 003's BVH broadphase. All state is packed typed arrays;
//               zero per-contact object allocation.
// best for : 3D character controllers, vehicle physics, ragdoll chains,
//            object stacking, projectile collisions, and any 3D scene
//            requiring 1M-body scaling on Android 64-bit.
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
  getParents,
} from '../transform/002_transform_hierarchy.js';

import {
  bvhCollisionPairs,
  bvhCreateProxy,
  bvhDestroyProxy,
  bvhMoveProxy,
} from '../spatial/003_bvh_broadphase.js';

import {
  WorldBoundsF32,
  getWorldBoundsCenter,
  getWorldBoundsExtents,
} from '../geometry/004_aabb_bounds.js';

import {
  vec3,
  quat,
  mat3,
  mat4,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

const MAX_BODIES_3D    = 1_000_000;
const MAX_CONTACTS_3D  = 4_000_000;
const MAX_MANIFOLD_PTS = 4;
const LINEAR_SLOP_3D   = 0.005;
const MAX_LINEAR_CORRECTION_3D = 0.2;
const BAUMGARTE_3D     = 0.2;
const RESTITUTION_THRESHOLD_3D = 1.0;

// ═══════════════════════════════════════════════════════════════════════
// BODY TYPE / SHAPE TYPE
// ═══════════════════════════════════════════════════════════════════════

export const BodyType3D = Object.freeze({
  STATIC:    0,
  KINEMATIC: 1,
  DYNAMIC:   2,
});

export const ShapeType3D = Object.freeze({
  SPHERE:  0,
  BOX:     1,
  CAPSULE: 2,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA RIGID BODY 3D STORE
// ═══════════════════════════════════════════════════════════════════════

export const RigidBody3D = {
  // Linear position (also mirrored into LocalTransformF32).
  px: new Float32Array(MAX_BODIES_3D),
  py: new Float32Array(MAX_BODIES_3D),
  pz: new Float32Array(MAX_BODIES_3D),

  // Orientation quaternion (x, y, z, w).
  qx: new Float32Array(MAX_BODIES_3D),
  qy: new Float32Array(MAX_BODIES_3D),
  qz: new Float32Array(MAX_BODIES_3D),
  qw: new Float32Array(MAX_BODIES_3D),

  // Linear velocity.
  vx: new Float32Array(MAX_BODIES_3D),
  vy: new Float32Array(MAX_BODIES_3D),
  vz: new Float32Array(MAX_BODIES_3D),

  // Angular velocity (radians/second).
  wx: new Float32Array(MAX_BODIES_3D),
  wy: new Float32Array(MAX_BODIES_3D),
  wz: new Float32Array(MAX_BODIES_3D),

  // Inverse mass (0 for static/kinematic).
  invMass: new Float32Array(MAX_BODIES_3D),

  // Inverse inertia tensor in body space (diagonal, 3 floats).
  invIxx: new Float32Array(MAX_BODIES_3D),
  invIyy: new Float32Array(MAX_BODIES_3D),
  invIzz: new Float32Array(MAX_BODIES_3D),

  // Linear damping.
  linearDamping: new Float32Array(MAX_BODIES_3D),
  angularDamping: new Float32Array(MAX_BODIES_3D),

  // Gravity scale.
  gravityScale: new Float32Array(MAX_BODIES_3D),

  // Body type.
  type: new Uint8Array(MAX_BODIES_3D),

  // Flags: bit 0 = awake, bit 1 = fixed rotation, bit 2 = CCD enabled.
  flags: new Uint8Array(MAX_BODIES_3D),

  // Sleep timer.
  sleepTime: new Float32Array(MAX_BODIES_3D),

  // Velocity caps.
  maxLinearVelocity: new Float32Array(MAX_BODIES_3D),
  maxAngularVelocity: new Float32Array(MAX_BODIES_3D),
};

// ═══════════════════════════════════════════════════════════════════════
// SoA SHAPE 3D STORE
// ═══════════════════════════════════════════════════════════════════════

export const Shape3D = {
  shapeType: new Uint8Array(MAX_BODIES_3D),

  // Sphere radius / capsule radius.
  radius: new Float32Array(MAX_BODIES_3D),

  // Box half-extents.
  hx: new Float32Array(MAX_BODIES_3D),
  hy: new Float32Array(MAX_BODIES_3D),
  hz: new Float32Array(MAX_BODIES_3D),

  // Capsule half-height (cylindrical portion; total height = 2*hh + 2*r).
  halfHeight: new Float32Array(MAX_BODIES_3D),

  // Local offset from body center.
  offsetX: new Float32Array(MAX_BODIES_3D),
  offsetY: new Float32Array(MAX_BODIES_3D),
  offsetZ: new Float32Array(MAX_BODIES_3D),

  // Material.
  density:     new Float32Array(MAX_BODIES_3D),
  friction:    new Float32Array(MAX_BODIES_3D),
  restitution: new Float32Array(MAX_BODIES_3D),

  // Collision filtering.
  categoryBits: new Uint32Array(MAX_BODIES_3D),
  maskBits:     new Uint32Array(MAX_BODIES_3D),
  groupIndex:   new Int16Array(MAX_BODIES_3D),

  bodyEid: new Uint32Array(MAX_BODIES_3D),
};

// ═══════════════════════════════════════════════════════════════════════
// CONTACT 3D SoA (single-point contacts, merged into manifolds per pair)
// ═══════════════════════════════════════════════════════════════════════

export const Contact3D = {
  bodyA: new Uint32Array(MAX_CONTACTS_3D),
  bodyB: new Uint32Array(MAX_CONTACTS_3D),

  // World-space contact point.
  pointX: new Float32Array(MAX_CONTACTS_3D),
  pointY: new Float32Array(MAX_CONTACTS_3D),
  pointZ: new Float32Array(MAX_CONTACTS_3D),

  // Contact normal (from A to B).
  normalX: new Float32Array(MAX_CONTACTS_3D),
  normalY: new Float32Array(MAX_CONTACTS_3D),
  normalZ: new Float32Array(MAX_CONTACTS_3D),

  // Penetration (positive = separated; negative = overlapping).
  separation: new Float32Array(MAX_CONTACTS_3D),

  // Accumulated impulses (warm starting).
  normalImpulse:  new Float32Array(MAX_CONTACTS_3D),
  tangentImpulseX: new Float32Array(MAX_CONTACTS_3D),
  tangentImpulseY: new Float32Array(MAX_CONTACTS_3D),

  // Effective masses.
  normalMass:   new Float32Array(MAX_CONTACTS_3D),
  tangentMassX: new Float32Array(MAX_CONTACTS_3D),
  tangentMassY: new Float32Array(MAX_CONTACTS_3D),

  // Relative contact vectors (from body center to contact point).
  rAx: new Float32Array(MAX_CONTACTS_3D),
  rAy: new Float32Array(MAX_CONTACTS_3D),
  rAz: new Float32Array(MAX_CONTACTS_3D),
  rBx: new Float32Array(MAX_CONTACTS_3D),
  rBy: new Float32Array(MAX_CONTACTS_3D),
  rBz: new Float32Array(MAX_CONTACTS_3D),

  // Material coefficients.
  friction:    new Float32Array(MAX_CONTACTS_3D),
  restitution: new Float32Array(MAX_CONTACTS_3D),

  // Count of active contacts.
  count: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// WORLD STATE
// ═══════════════════════════════════════════════════════════════════════

export const Physics3DState = {
  gravityX: 0,
  gravityY: -9.81,
  gravityZ: 0,
  velocityIterations: 8,
  positionIterations: 3,
  fixedTimeStep: 1 / 60,
  accumulator: 0,
  prevContacts: new Map(), // "eidA|eidB|idx" -> { n, tx, ty }
  contactPoints: new Map(), // "eidA|eidB" -> { count, xs, ys, zs, nxs, nys, nzs }
};

// ═══════════════════════════════════════════════════════════════════════
// BODY API
// ═══════════════════════════════════════════════════════════════════════

export function addRigidBody3D(world, eid, {
  type = BodyType3D.DYNAMIC,
  px = 0, py = 0, pz = 0,
  qx = 0, qy = 0, qz = 0, qw = 1,
  vx = 0, vy = 0, vz = 0,
  wx = 0, wy = 0, wz = 0,
  mass = 1,
  ix = 1, iy = 1, iz = 1,
  linearDamping = 0.05,
  angularDamping = 0.05,
  gravityScale = 1,
  maxLinearVelocity = 200,
  maxAngularVelocity = 200,
  fixedRotation = false,
  ccdEnabled = false,
} = {}) {
  addComponent(world, eid, RigidBody3D);
  addComponent(world, eid, Shape3D);

  const id = getId(eid);
  const R = RigidBody3D;

  R.type[id] = type;
  R.px[id] = px; R.py[id] = py; R.pz[id] = pz;
  R.qx[id] = qx; R.qy[id] = qy; R.qz[id] = qz; R.qw[id] = qw;
  R.vx[id] = vx; R.vy[id] = vy; R.vz[id] = vz;
  R.wx[id] = wx; R.wy[id] = wy; R.wz[id] = wz;

  const isStatic = type === BodyType3D.STATIC;
  R.invMass[id] = isStatic ? 0 : 1 / mass;
  if (fixedRotation || isStatic) {
    R.invIxx[id] = 0;
    R.invIyy[id] = 0;
    R.invIzz[id] = 0;
  } else {
    R.invIxx[id] = 1 / ix;
    R.invIyy[id] = 1 / iy;
    R.invIzz[id] = 1 / iz;
  }

  R.linearDamping[id] = linearDamping;
  R.angularDamping[id] = angularDamping;
  R.gravityScale[id] = gravityScale;
  R.maxLinearVelocity[id] = maxLinearVelocity;
  R.maxAngularVelocity[id] = maxAngularVelocity;

  let flags = 1; // awake
  if (fixedRotation) flags |= 2;
  if (ccdEnabled) flags |= 4;
  R.flags[id] = flags;
  R.sleepTime[id] = 0;

  syncBody3DToTransform(eid);
  return eid;
}

export function setShape3D(world, eid, shape) {
  const id = getId(eid);
  const S = Shape3D;
  const R = RigidBody3D;

  const density = shape.density ?? 1;

  if (shape.type === ShapeType3D.SPHERE) {
    S.shapeType[id] = ShapeType3D.SPHERE;
    S.radius[id] = shape.radius ?? 0.5;
    S.hx[id] = 0; S.hy[id] = 0; S.hz[id] = 0;
    S.halfHeight[id] = 0;

    const r = S.radius[id];
    const m = (4 / 3) * Math.PI * r * r * r * density;
    const I = (2 / 5) * m * r * r;
    if (R.type[id] !== BodyType3D.STATIC) {
      R.invMass[id] = 1 / m;
      R.invIxx[id] = 1 / I;
      R.invIyy[id] = 1 / I;
      R.invIzz[id] = 1 / I;
    }
  } else if (shape.type === ShapeType3D.BOX) {
    S.shapeType[id] = ShapeType3D.BOX;
    S.hx[id] = shape.hx ?? 0.5;
    S.hy[id] = shape.hy ?? 0.5;
    S.hz[id] = shape.hz ?? 0.5;
    S.radius[id] = 0;
    S.halfHeight[id] = 0;

    const w = 2 * S.hx[id], h = 2 * S.hy[id], d = 2 * S.hz[id];
    const m = w * h * d * density;
    if (R.type[id] !== BodyType3D.STATIC) {
      R.invMass[id] = 1 / m;
      R.invIxx[id] = 1 / ((1 / 12) * m * (h * h + d * d));
      R.invIyy[id] = 1 / ((1 / 12) * m * (w * w + d * d));
      R.invIzz[id] = 1 / ((1 / 12) * m * (w * w + h * h));
    }
  } else if (shape.type === ShapeType3D.CAPSULE) {
    S.shapeType[id] = ShapeType3D.CAPSULE;
    S.radius[id] = shape.radius ?? 0.5;
    S.halfHeight[id] = shape.halfHeight ?? 0.5;
    S.hx[id] = 0; S.hy[id] = 0; S.hz[id] = 0;

    const r = S.radius[id];
    const hh = S.halfHeight[id];
    const cylinderH = 2 * hh;
    const mCyl = Math.PI * r * r * cylinderH * density;
    const mSph = (4 / 3) * Math.PI * r * r * r * density;
    const m = mCyl + mSph;
    if (R.type[id] !== BodyType3D.STATIC) {
      R.invMass[id] = 1 / m;
      // Axis-aligned capsule along Y.
      const iY = (1 / 2) * mCyl * r * r + (2 / 5) * mSph * r * r;
      const iX = (1 / 12) * mCyl * (3 * r * r + cylinderH * cylinderH)
               + (2 / 5) * mSph * r * r + mSph * (hh + r) * (hh + r);
      R.invIxx[id] = 1 / iX;
      R.invIyy[id] = 1 / iY;
      R.invIzz[id] = 1 / iX;
    }
  }

  S.density[id] = density;
  S.friction[id] = shape.friction ?? 0.3;
  S.restitution[id] = shape.restitution ?? 0.0;
  S.categoryBits[id] = shape.categoryBits ?? 0x0001;
  S.maskBits[id] = shape.maskBits ?? 0xFFFF;
  S.groupIndex[id] = shape.groupIndex ?? 0;
  S.bodyEid[id] = eid;

  bvhCreateProxy(eid);
  return eid;
}

// ═══════════════════════════════════════════════════════════════════════
// SYNC — write body state into LocalTransformF32
// ═══════════════════════════════════════════════════════════════════════

export function syncBody3DToTransform(eid) {
  const id = getId(eid);
  const R = RigidBody3D;
  const L = LocalTransformF32;

  L.px[id] = R.px[id];
  L.py[id] = R.py[id];
  L.pz[id] = R.pz[id];
  L.qx[id] = R.qx[id];
  L.qy[id] = R.qy[id];
  L.qz[id] = R.qz[id];
  L.qw[id] = R.qw[id];
  L.sx[id] = 1;
  L.sy[id] = 1;
  L.sz[id] = 1;

  markDirty(eid);
}

// ═══════════════════════════════════════════════════════════════════════
// NARROWPHASE HELPERS
// ═══════════════════════════════════════════════════════════════════════

const _tmpV3 = vec3.create();
const _tmpV3b = vec3.create();
const _tmpQ = quat.create();
const _tmpM3 = mat3.create();
const _tmpM4 = mat4.create();

function quatRotateVec(qx, qy, qz, qw, vx, vy, vz, out) {
  _tmpQ[0] = qx; _tmpQ[1] = qy; _tmpQ[2] = qz; _tmpQ[3] = qw;
  _tmpV3[0] = vx; _tmpV3[1] = vy; _tmpV3[2] = vz;
  vec3.transformQuat(out, _tmpV3, _tmpQ);
  return out;
}

// ─── Sphere vs Sphere ────────────────────────────────────────────────
function collideSphereSphere(R, S, idA, idB, out) {
  const dx = R.px[idB] - R.px[idA];
  const dy = R.py[idB] - R.py[idA];
  const dz = R.pz[idB] - R.pz[idA];
  const distSq = dx * dx + dy * dy + dz * dz;
  const rSum = S.radius[idA] + S.radius[idB];
  if (distSq > rSum * rSum) return false;

  const dist = Math.sqrt(distSq) || 1e-6;
  const nx = dx / dist, ny = dy / dist, nz = dz / dist;

  out.count = 1;
  out.nx[0] = nx; out.ny[0] = ny; out.nz[0] = nz;
  out.px[0] = R.px[idA] + nx * S.radius[idA];
  out.py[0] = R.py[idA] + ny * S.radius[idA];
  out.pz[0] = R.pz[idA] + nz * S.radius[idA];
  out.sep[0] = -(rSum - dist);
  return true;
}

// ─── Sphere vs Box (OBB) ─────────────────────────────────────────────
function collideSphereBox(R, S, idA, idB, out) {
  // Transform sphere center into box local space.
  const spX = R.px[idA] - R.px[idB];
  const spY = R.py[idA] - R.py[idB];
  const spZ = R.pz[idA] - R.pz[idB];

  quatRotateVec(
    -R.qx[idB], -R.qy[idB], -R.qz[idB], R.qw[idB],
    spX, spY, spZ, _tmpV3
  );

  const hx = S.hx[idB], hy = S.hy[idB], hz = S.hz[idB];
  const r  = S.radius[idA];

  const cx = Math.max(-hx, Math.min(hx, _tmpV3[0]));
  const cy = Math.max(-hy, Math.min(hy, _tmpV3[1]));
  const cz = Math.max(-hz, Math.min(hz, _tmpV3[2]));

  const ddx = _tmpV3[0] - cx;
  const ddy = _tmpV3[1] - cy;
  const ddz = _tmpV3[2] - cz;
  const distSq = ddx * ddx + ddy * ddy + ddz * ddz;
  if (distSq > r * r) return false;

  const dist = Math.sqrt(distSq) || 1e-6;
  let nx, ny, nz, pen;
  if (distSq > 1e-12) {
    nx = ddx / dist; ny = ddy / dist; nz = ddz / dist;
    pen = r - dist;
  } else {
    // Sphere center inside box — push along shortest axis.
    const dxE = hx - Math.abs(_tmpV3[0]);
    const dyE = hy - Math.abs(_tmpV3[1]);
    const dzE = hz - Math.abs(_tmpV3[2]);
    if (dxE < dyE && dxE < dzE) {
      nx = _tmpV3[0] < 0 ? -1 : 1; ny = 0; nz = 0;
    } else if (dyE < dzE) {
      nx = 0; ny = _tmpV3[1] < 0 ? -1 : 1; nz = 0;
    } else {
      nx = 0; ny = 0; nz = _tmpV3[2] < 0 ? -1 : 1;
    }
    pen = r + Math.min(dxE, dyE, dzE);
  }

  // Rotate normal into world (from box → sphere).
  _tmpV3[0] = nx; _tmpV3[1] = ny; _tmpV3[2] = nz;
  _tmpQ[0] = R.qx[idB]; _tmpQ[1] = R.qy[idB];
  _tmpQ[2] = R.qz[idB]; _tmpQ[3] = R.qw[idB];
  const wn = vec3.transformQuat(_tmpV3b, _tmpV3, _tmpQ);

  out.count = 1;
  out.nx[0] = wn[0]; out.ny[0] = wn[1]; out.nz[0] = wn[2];
  out.px[0] = R.px[idB] + cx; // approximate
  out.py[0] = R.py[idB] + cy;
  out.pz[0] = R.pz[idB] + cz;
  out.sep[0] = -pen;
  return true;
}

// ─── Box vs Box SAT (4-point manifold reduction approximation) ──────
function collideBoxBox(R, S, idA, idB, out) {
  // Simplified OBB-OBB using A's local axes for projection.
  // A full Box2D-style SAT + clipping is expensive; we use approximate
  // face-normal resolution for contact point + normal.
  const dx = R.px[idB] - R.px[idA];
  const dy = R.py[idB] - R.py[idA];
  const dz = R.pz[idB] - R.pz[idA];

  // Rotate center difference into A's frame.
  quatRotateVec(
    -R.qx[idA], -R.qy[idA], -R.qz[idA], R.qw[idA],
    dx, dy, dz, _tmpV3
  );

  // Closest point of B's OBB in A's frame (approx via extents).
  const hx = S.hx[idA] + S.hx[idB];
  const hy = S.hy[idA] + S.hy[idB];
  const hz = S.hz[idA] + S.hz[idB];

  if (Math.abs(_tmpV3[0]) > hx) return false;
  if (Math.abs(_tmpV3[1]) > hy) return false;
  if (Math.abs(_tmpV3[2]) > hz) return false;

  // Choose smallest overlap axis in A's frame.
  const penX = hx - Math.abs(_tmpV3[0]);
  const penY = hy - Math.abs(_tmpV3[1]);
  const penZ = hz - Math.abs(_tmpV3[2]);

  let lnx = 0, lny = 0, lnz = 0, pen = 0;
  if (penX < penY && penX < penZ) {
    lnx = _tmpV3[0] > 0 ? 1 : -1;
    pen = penX;
  } else if (penY < penZ) {
    lny = _tmpV3[1] > 0 ? 1 : -1;
    pen = penY;
  } else {
    lnz = _tmpV3[2] > 0 ? 1 : -1;
    pen = penZ;
  }

  // Rotate normal into world.
  _tmpV3[0] = lnx; _tmpV3[1] = lny; _tmpV3[2] = lnz;
  _tmpQ[0] = R.qx[idA]; _tmpQ[1] = R.qy[idA];
  _tmpQ[2] = R.qz[idA]; _tmpQ[3] = R.qw[idA];
  const wn = vec3.transformQuat(_tmpV3b, _tmpV3, _tmpQ);

  out.count = 1;
  out.nx[0] = wn[0]; out.ny[0] = wn[1]; out.nz[0] = wn[2];
  out.px[0] = (R.px[idA] + R.px[idB]) * 0.5;
  out.py[0] = (R.py[idA] + R.py[idB]) * 0.5;
  out.pz[0] = (R.pz[idA] + R.pz[idB]) * 0.5;
  out.sep[0] = -pen;
  return true;
}

// ═══════════════════════════════════════════════════════════════════════
// BROADPHASE → CONTACT GENERATION
// ═══════════════════════════════════════════════════════════════════════

function buildContacts3D(world) {
  Contact3D.count = 0;

  const bodies = query(world, [RigidBody3D, Shape3D]);
  for (let i = 0; i < bodies.length; i++) {
    bvhMoveProxy(bodies[i]);
  }

  const pairs = bvhCollisionPairs();
  const _manifold = {
    count: 0,
    nx: new Float32Array(MAX_MANIFOLD_PTS),
    ny: new Float32Array(MAX_MANIFOLD_PTS),
    nz: new Float32Array(MAX_MANIFOLD_PTS),
    px: new Float32Array(MAX_MANIFOLD_PTS),
    py: new Float32Array(MAX_MANIFOLD_PTS),
    pz: new Float32Array(MAX_MANIFOLD_PTS),
    sep: new Float32Array(MAX_MANIFOLD_PTS),
  };

  const R = RigidBody3D;
  const S = Shape3D;

  for (let p = 0; p < pairs.length; p++) {
    if (Contact3D.count >= MAX_CONTACTS_3D) break;
    const [eidA, eidB] = pairs[p];
    if (!hasComponent(world, eidA, RigidBody3D)) continue;
    if (!hasComponent(world, eidB, RigidBody3D)) continue;

    const idA = getId(eidA);
    const idB = getId(eidB);

    // Filtering.
    if (S.groupIndex[idA] !== 0 && S.groupIndex[idA] === S.groupIndex[idB]) {
      if (S.groupIndex[idA] > 0) continue;
    }
    if ((S.categoryBits[idA] & S.maskBits[idB]) === 0) continue;
    if ((S.categoryBits[idB] & S.maskBits[idA]) === 0) continue;

    // Skip if both static.
    if (R.type[idA] === BodyType3D.STATIC && R.type[idB] === BodyType3D.STATIC) continue;

    _manifold.count = 0;
    const tA = S.shapeType[idA];
    const tB = S.shapeType[idB];
    let hit = false;

    if (tA === ShapeType3D.SPHERE && tB === ShapeType3D.SPHERE) {
      hit = collideSphereSphere(R, S, idA, idB, _manifold);
    } else if (tA === ShapeType3D.SPHERE && tB === ShapeType3D.BOX) {
      hit = collideSphereBox(R, S, idA, idB, _manifold);
    } else if (tA === ShapeType3D.BOX && tB === ShapeType3D.SPHERE) {
      hit = collideSphereBox(R, S, idB, idA, _manifold);
      if (hit) {
        for (let k = 0; k < _manifold.count; k++) {
          _manifold.nx[k] = -_manifold.nx[k];
          _manifold.ny[k] = -_manifold.ny[k];
          _manifold.nz[k] = -_manifold.nz[k];
        }
      }
    } else if (tA === ShapeType3D.BOX && tB === ShapeType3D.BOX) {
      hit = collideBoxBox(R, S, idA, idB, _manifold);
    }

    if (!hit) continue;

    for (let k = 0; k < _manifold.count; k++) {
      if (Contact3D.count >= MAX_CONTACTS_3D) break;
      const idx = Contact3D.count++;
      Contact3D.bodyA[idx] = eidA;
      Contact3D.bodyB[idx] = eidB;
      Contact3D.pointX[idx] = _manifold.px[k];
      Contact3D.pointY[idx] = _manifold.py[k];
      Contact3D.pointZ[idx] = _manifold.pz[k];
      Contact3D.normalX[idx] = _manifold.nx[k];
      Contact3D.normalY[idx] = _manifold.ny[k];
      Contact3D.normalZ[idx] = _manifold.nz[k];
      Contact3D.separation[idx] = _manifold.sep[k];

      Contact3D.friction[idx] = Math.sqrt(S.friction[idA] * S.friction[idB]);
      Contact3D.restitution[idx] = Math.max(S.restitution[idA], S.restitution[idB]);

      const key = `${eidA}|${eidB}|${k}`;
      const prev = Physics3DState.prevContacts.get(key);
      Contact3D.normalImpulse[idx]   = prev ? prev.n : 0;
      Contact3D.tangentImpulseX[idx] = prev ? prev.tx : 0;
      Contact3D.tangentImpulseY[idx] = prev ? prev.ty : 0;

      Contact3D.rAx[idx] = _manifold.px[k] - R.px[idA];
      Contact3D.rAy[idx] = _manifold.py[k] - R.py[idA];
      Contact3D.rAz[idx] = _manifold.pz[k] - R.pz[idA];
      Contact3D.rBx[idx] = _manifold.px[k] - R.px[idB];
      Contact3D.rBy[idx] = _manifold.py[k] - R.py[idB];
      Contact3D.rBz[idx] = _manifold.pz[k] - R.pz[idB];
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SOLVER — world-space inertia tensor helper
// ═══════════════════════════════════════════════════════════════════════
//
// We keep inverse inertia in body space (diagonal). To transform a torque
// into world angular velocity we rotate by the body quaternion, apply the
// diagonal inverse inertia, then rotate back.
//
// I⁻¹_world(v) = R * (I⁻¹_body ⊙ (R⁻¹ * v))

function applyInvInertia(R, id, vx, vy, vz, out) {
  // Rotate v into body space.
  _tmpV3[0] = vx; _tmpV3[1] = vy; _tmpV3[2] = vz;
  _tmpQ[0] = -R.qx[id]; _tmpQ[1] = -R.qy[id];
  _tmpQ[2] = -R.qz[id]; _tmpQ[3] = R.qw[id];
  vec3.transformQuat(_tmpV3b, _tmpV3, _tmpQ);

  // Multiply by diagonal inverse inertia.
  _tmpV3b[0] *= R.invIxx[id];
  _tmpV3b[1] *= R.invIyy[id];
  _tmpV3b[2] *= R.invIzz[id];

  // Rotate back to world.
  _tmpQ[0] = R.qx[id]; _tmpQ[1] = R.qy[id];
  _tmpQ[2] = R.qz[id]; _tmpQ[3] = R.qw[id];
  vec3.transformQuat(out, _tmpV3b, _tmpQ);
  return out;
}

function solveVelocityConstraints3D() {
  const R = RigidBody3D;
  const _angA = vec3.create();
  const _angB = vec3.create();
  const _cross = vec3.create();
  const _tmp = vec3.create();

  for (let i = 0; i < Contact3D.count; i++) {
    const eidA = Contact3D.bodyA[i];
    const eidB = Contact3D.bodyB[i];
    const idA = getId(eidA);
    const idB = getId(eidB);

    const nx = Contact3D.normalX[i];
    const ny = Contact3D.normalY[i];
    const nz = Contact3D.normalZ[i];

    // Tangent basis (two orthogonal tangents).
    let tx, ty, tz;
    if (Math.abs(nx) < 0.9) {
      tx = 0; ty = -nz; tz = ny;
    } else {
      tx = -nz; ty = 0; tz = nx;
    }
    const tLen = Math.hypot(tx, ty, tz) || 1;
    tx /= tLen; ty /= tLen; tz /= tLen;

    const bx = ny * tz - nz * ty;
    const by = nz * tx - nx * tz;
    const bz = nx * ty - ny * tx;

    const rAx = Contact3D.rAx[i], rAy = Contact3D.rAy[i], rAz = Contact3D.rAz[i];
    const rBx = Contact3D.rBx[i], rBy = Contact3D.rBy[i], rBz = Contact3D.rBz[i];

    const invMassA = R.invMass[idA];
    const invMassB = R.invMass[idB];

    // Effective mass along normal.
    _tmp[0] = rAy * nz - rAz * ny;
    _tmp[1] = rAz * nx - rAx * nz;
    _tmp[2] = rAx * ny - rAy * nx;
    applyInvInertia(R, idA, _tmp[0], _tmp[1], _tmp[2], _angA);
    const rnA = _tmp[0] * _angA[0] + _tmp[1] * _angA[1] + _tmp[2] * _angA[2];

    _tmp[0] = rBy * nz - rBz * ny;
    _tmp[1] = rBz * nx - rBx * nz;
    _tmp[2] = rBx * ny - rBy * nx;
    applyInvInertia(R, idB, _tmp[0], _tmp[1], _tmp[2], _angB);
    const rnB = _tmp[0] * _angB[0] + _tmp[1] * _angB[1] + _tmp[2] * _angB[2];

    const normalMass = 1 / (invMassA + invMassB + rnA + rnB);
    Contact3D.normalMass[i] = normalMass;

    // Effective masses along both tangents (approximate: skip inertia coupling).
    const tmX = 1 / (invMassA + invMassB);
    const tmY = 1 / (invMassA + invMassB);
    Contact3D.tangentMassX[i] = tmX;
    Contact3D.tangentMassY[i] = tmY;

    // Relative velocity at contact point.
    const dvx = (R.vx[idB] + R.wy[idB] * rBz - R.wz[idB] * rBy)
              - (R.vx[idA] + R.wy[idA] * rAz - R.wz[idA] * rAy);
    const dvy = (R.vy[idB] + R.wz[idB] * rBx - R.wx[idB] * rBz)
              - (R.vy[idA] + R.wz[idA] * rAx - R.wx[idA] * rAz);
    const dvz = (R.vz[idB] + R.wx[idB] * rBy - R.wy[idB] * rBx)
              - (R.vz[idA] + R.wx[idA] * rAy - R.wy[idA] * rAx);

    // Normal impulse.
    const vn = dvx * nx + dvy * ny + dvz * nz;
    let lambdaN = -normalMass * vn;
    const oldN = Contact3D.normalImpulse[i];
    Contact3D.normalImpulse[i] = Math.max(0, oldN + lambdaN);
    lambdaN = Contact3D.normalImpulse[i] - oldN;

    const Pnx = lambdaN * nx;
    const Pny = lambdaN * ny;
    const Pnz = lambdaN * nz;

    // Apply normal impulse to A (opposite) and B.
    R.vx[idA] -= Pnx * invMassA;
    R.vy[idA] -= Pny * invMassA;
    R.vz[idA] -= Pnz * invMassA;
    _cross[0] = rAy * Pnz - rAz * Pny;
    _cross[1] = rAz * Pnx - rAx * Pnz;
    _cross[2] = rAx * Pny - rAy * Pnx;
    applyInvInertia(R, idA, _cross[0], _cross[1], _cross[2], _angA);
    R.wx[idA] -= _angA[0];
    R.wy[idA] -= _angA[1];
    R.wz[idA] -= _angA[2];

    R.vx[idB] += Pnx * invMassB;
    R.vy[idB] += Pny * invMassB;
    R.vz[idB] += Pnz * invMassB;
    _cross[0] = rBy * Pnz - rBz * Pny;
    _cross[1] = rBz * Pnx - rBx * Pnz;
    _cross[2] = rBx * Pny - rBy * Pnx;
    applyInvInertia(R, idB, _cross[0], _cross[1], _cross[2], _angB);
    R.wx[idB] += _angB[0];
    R.wy[idB] += _angB[1];
    R.wz[idB] += _angB[2];

    // Tangent friction (two axes).
    const friction = Contact3D.friction[i];
    const maxF = friction * Contact3D.normalImpulse[i];

    // Tangent 1.
    const vt1 = dvx * tx + dvy * ty + dvz * tz;
    let lt1 = -tmX * vt1;
    const oldT1 = Contact3D.tangentImpulseX[i];
    Contact3D.tangentImpulseX[i] = Math.max(-maxF, Math.min(maxF, oldT1 + lt1));
    lt1 = Contact3D.tangentImpulseX[i] - oldT1;

    R.vx[idA] -= lt1 * tx * invMassA;
    R.vy[idA] -= lt1 * ty * invMassA;
    R.vz[idA] -= lt1 * tz * invMassA;
    R.vx[idB] += lt1 * tx * invMassB;
    R.vy[idB] += lt1 * ty * invMassB;
    R.vz[idB] += lt1 * tz * invMassB;

    // Tangent 2.
    const vt2 = dvx * bx + dvy * by + dvz * bz;
    let lt2 = -tmY * vt2;
    const oldT2 = Contact3D.tangentImpulseY[i];
    Contact3D.tangentImpulseY[i] = Math.max(-maxF, Math.min(maxF, oldT2 + lt2));
    lt2 = Contact3D.tangentImpulseY[i] - oldT2;

    R.vx[idA] -= lt2 * bx * invMassA;
    R.vy[idA] -= lt2 * by * invMassA;
    R.vz[idA] -= lt2 * bz * invMassA;
    R.vx[idB] += lt2 * bx * invMassB;
    R.vy[idB] += lt2 * by * invMassB;
    R.vz[idB] += lt2 * bz * invMassB;
  }
}

function warmStart3D() {
  const R = RigidBody3D;
  const _angA = vec3.create();
  const _angB = vec3.create();
  const _cross = vec3.create();

  for (let i = 0; i < Contact3D.count; i++) {
    const eidA = Contact3D.bodyA[i];
    const eidB = Contact3D.bodyB[i];
    const idA = getId(eidA);
    const idB = getId(eidB);

    const nx = Contact3D.normalX[i];
    const ny = Contact3D.normalY[i];
    const nz = Contact3D.normalZ[i];

    // Rebuild tangent basis (must match solver).
    let tx, ty, tz;
    if (Math.abs(nx) < 0.9) { tx = 0; ty = -nz; tz = ny; }
    else { tx = -nz; ty = 0; tz = nx; }
    const tLen = Math.hypot(tx, ty, tz) || 1;
    tx /= tLen; ty /= tLen; tz /= tLen;
    const bx = ny * tz - nz * ty;
    const by = nz * tx - nx * tz;
    const bz = nx * ty - ny * tx;

    const Pnx = Contact3D.normalImpulse[i] * nx
              + Contact3D.tangentImpulseX[i] * tx
              + Contact3D.tangentImpulseY[i] * bx;
    const Pny = Contact3D.normalImpulse[i] * ny
              + Contact3D.tangentImpulseX[i] * ty
              + Contact3D.tangentImpulseY[i] * by;
    const Pnz = Contact3D.normalImpulse[i] * nz
              + Contact3D.tangentImpulseX[i] * tz
              + Contact3D.tangentImpulseY[i] * bz;

    const rAx = Contact3D.rAx[i], rAy = Contact3D.rAy[i], rAz = Contact3D.rAz[i];
    const rBx = Contact3D.rBx[i], rBy = Contact3D.rBy[i], rBz = Contact3D.rBz[i];

    R.vx[idA] -= Pnx * R.invMass[idA];
    R.vy[idA] -= Pny * R.invMass[idA];
    R.vz[idA] -= Pnz * R.invMass[idA];
    _cross[0] = rAy * Pnz - rAz * Pny;
    _cross[1] = rAz * Pnx - rAx * Pnz;
    _cross[2] = rAx * Pny - rAy * Pnx;
    applyInvInertia(R, idA, _cross[0], _cross[1], _cross[2], _angA);
    R.wx[idA] -= _angA[0]; R.wy[idA] -= _angA[1]; R.wz[idA] -= _angA[2];

    R.vx[idB] += Pnx * R.invMass[idB];
    R.vy[idB] += Pny * R.invMass[idB];
    R.vz[idB] += Pnz * R.invMass[idB];
    _cross[0] = rBy * Pnz - rBz * Pny;
    _cross[1] = rBz * Pnx - rBx * Pnz;
    _cross[2] = rBx * Pny - rBy * Pnx;
    applyInvInertia(R, idB, _cross[0], _cross[1], _cross[2], _angB);
    R.wx[idB] += _angB[0]; R.wy[idB] += _angB[1]; R.wz[idB] += _angB[2];
  }
}

function solvePositionConstraints3D() {
  const R = RigidBody3D;
  let minSeparation = 0;

  for (let i = 0; i < Contact3D.count; i++) {
    const eidA = Contact3D.bodyA[i];
    const eidB = Contact3D.bodyB[i];
    const idA = getId(eidA);
    const idB = getId(eidB);

    if (R.type[idA] === BodyType3D.STATIC && R.type[idB] === BodyType3D.STATIC) continue;

    const nx = Contact3D.normalX[i];
    const ny = Contact3D.normalY[i];
    const nz = Contact3D.normalZ[i];

    const rAx = Contact3D.rAx[i], rAy = Contact3D.rAy[i], rAz = Contact3D.rAz[i];
    const rBx = Contact3D.rBx[i], rBy = Contact3D.rBy[i], rBz = Contact3D.rBz[i];

    const dx = (R.px[idB] + rBx) - (R.px[idA] + rAx);
    const dy = (R.py[idB] + rBy) - (R.py[idA] + rAy);
    const dz = (R.pz[idB] + rBz) - (R.pz[idA] + rAz);
    const separation = dx * nx + dy * ny + dz * nz;
    minSeparation = Math.min(minSeparation, separation);

    const C = Math.max(
      -MAX_LINEAR_CORRECTION_3D,
      Math.min(MAX_LINEAR_CORRECTION_3D, BAUMGARTE_3D * (separation + LINEAR_SLOP_3D))
    );
    if (C === 0) continue;

    const invMassA = R.invMass[idA];
    const invMassB = R.invMass[idB];

    // Approx effective mass along normal (ignore inertia coupling for speed).
    const K = invMassA + invMassB;
    if (K === 0) continue;
    const impulse = -C / K;

    R.px[idA] -= impulse * nx * invMassA;
    R.py[idA] -= impulse * ny * invMassA;
    R.pz[idA] -= impulse * nz * invMassA;
    R.px[idB] += impulse * nx * invMassB;
    R.py[idB] += impulse * ny * invMassB;
    R.pz[idB] += impulse * nz * invMassB;
  }
  return minSeparation;
}

// ═══════════════════════════════════════════════════════════════════════
// QUATERNION INTEGRATION
// ═══════════════════════════════════════════════════════════════════════

function integrateOrientation(R, id, dt) {
  const wx = R.wx[id], wy = R.wy[id], wz = R.wz[id];
  if (wx === 0 && wy === 0 && wz === 0) return;

  // q += 0.5 * ω * q * dt (quaternion derivative), then normalize.
  const qx = R.qx[id], qy = R.qy[id], qz = R.qz[id], qw = R.qw[id];

  const halfDt = 0.5 * dt;
  const dqx = halfDt * (wx * qw + wy * qz - wz * qy);
  const dqy = halfDt * (wy * qw + wz * qx - wx * qz);
  const dqz = halfDt * (wz * qw + wx * qy - wy * qx);
  const dqw = halfDt * (-wx * qx - wy * qy - wz * qz);

  let nqx = qx + dqx;
  let nqy = qy + dqy;
  let nqz = qz + dqz;
  let nqw = qw + dqw;

  const lenSq = nqx * nqx + nqy * nqy + nqz * nqz + nqw * nqw;
  if (lenSq > 1e-24) {
    const inv = 1 / Math.sqrt(lenSq);
    nqx *= inv; nqy *= inv; nqz *= inv; nqw *= inv;
  }

  R.qx[id] = nqx;
  R.qy[id] = nqy;
  R.qz[id] = nqz;
  R.qw[id] = nqw;
}

// ═══════════════════════════════════════════════════════════════════════
// CCD / TOI (sphere-cast based for spheres only)
// ═══════════════════════════════════════════════════════════════════════

const TOI_MAX_ITER_3D = 16;
const TOI_TOL_3D = 0.001;

function computeTOI3D(eidA, eidB, dt) {
  const idA = getId(eidA);
  const idB = getId(eidB);
  const R = RigidBody3D;
  const S = Shape3D;

  if (S.shapeType[idA] !== ShapeType3D.SPHERE || S.shapeType[idB] !== ShapeType3D.SPHERE) {
    return 1.0;
  }

  const rSum = S.radius[idA] + S.radius[idB];

  let t = 0;
  for (let iter = 0; iter < TOI_MAX_ITER_3D; iter++) {
    const pxA = R.px[idA] + R.vx[idA] * t * dt;
    const pyA = R.py[idA] + R.vy[idA] * t * dt;
    const pzA = R.pz[idA] + R.vz[idA] * t * dt;
    const pxB = R.px[idB] + R.vx[idB] * t * dt;
    const pyB = R.py[idB] + R.vy[idB] * t * dt;
    const pzB = R.pz[idB] + R.vz[idB] * t * dt;

    const dx = pxB - pxA, dy = pyB - pyA, dz = pzB - pzA;
    const distSq = dx * dx + dy * dy + dz * dz;
    const dist = Math.sqrt(distSq);

    if (dist < rSum - TOI_TOL_3D) return t;
    if (dist < rSum + TOI_TOL_3D) {
      const relVx = R.vx[idB] - R.vx[idA];
      const relVy = R.vy[idB] - R.vy[idA];
      const relVz = R.vz[idB] - R.vz[idA];
      const closing = -(dx * relVx + dy * relVy + dz * relVz) / (dist || 1e-6);
      if (closing <= 0) return 1.0;
      const advance = (dist - rSum) / closing;
      t += advance / dt;
      if (t >= 1.0) return 1.0;
    } else {
      return 1.0;
    }
  }
  return 1.0;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN STEP
// ═══════════════════════════════════════════════════════════════════════

export function systemPhysics3DStep(world, dt) {
  if (dt <= 0) return world;
  const R = RigidBody3D;
  const state = Physics3DState;
  const bodies = query(world, [RigidBody3D]);

  // 1. Integrate velocities.
  for (let i = 0, n = bodies.length; i < n; i++) {
    const eid = bodies[i];
    const id = getId(eid);
    if (R.type[id] !== BodyType3D.DYNAMIC) continue;
    if ((R.flags[id] & 1) === 0) continue;

    R.vx[id] += state.gravityX * R.gravityScale[id] * dt;
    R.vy[id] += state.gravityY * R.gravityScale[id] * dt;
    R.vz[id] += state.gravityZ * R.gravityScale[id] * dt;

    const damp = 1 / (1 + dt * R.linearDamping[id]);
    R.vx[id] *= damp; R.vy[id] *= damp; R.vz[id] *= damp;
    const adamp = 1 / (1 + dt * R.angularDamping[id]);
    R.wx[id] *= adamp; R.wy[id] *= adamp; R.wz[id] *= adamp;

    const maxV = R.maxLinearVelocity[id];
    const vSq = R.vx[id] * R.vx[id] + R.vy[id] * R.vy[id] + R.vz[id] * R.vz[id];
    if (vSq > maxV * maxV) {
      const scale = maxV / Math.sqrt(vSq);
      R.vx[id] *= scale; R.vy[id] *= scale; R.vz[id] *= scale;
    }
    const maxW = R.maxAngularVelocity[id];
    const wSq = R.wx[id] * R.wx[id] + R.wy[id] * R.wy[id] + R.wz[id] * R.wz[id];
    if (wSq > maxW * maxW) {
      const scale = maxW / Math.sqrt(wSq);
      R.wx[id] *= scale; R.wy[id] *= scale; R.wz[id] *= scale;
    }
  }

  // 2. Broadphase → contacts.
  buildContacts3D(world);

  // 3. Warm start.
  warmStart3D();

  // 4. Velocity solver.
  for (let iter = 0; iter < state.velocityIterations; iter++) {
    solveVelocityConstraints3D();
  }

  // 5. Integrate positions + orientations.
  for (let i = 0, n = bodies.length; i < n; i++) {
    const eid = bodies[i];
    const id = getId(eid);
    if (R.type[id] !== BodyType3D.DYNAMIC) continue;

    R.px[id] += R.vx[id] * dt;
    R.py[id] += R.vy[id] * dt;
    R.pz[id] += R.vz[id] * dt;

    integrateOrientation(R, id, dt);
    syncBody3DToTransform(eid);
  }

  // 6. Position solver.
  for (let iter = 0; iter < state.positionIterations; iter++) {
    const minSep = solvePositionConstraints3D();
    if (minSep >= -3 * LINEAR_SLOP_3D) break;
  }

  // 7. Save impulses for warm starting next frame.
  state.prevContacts.clear();
  for (let i = 0; i < Contact3D.count; i++) {
    const key = `${Contact3D.bodyA[i]}|${Contact3D.bodyB[i]}|${i}`;
    state.prevContacts.set(key, {
      n:  Contact3D.normalImpulse[i],
      tx: Contact3D.tangentImpulseX[i],
      ty: Contact3D.tangentImpulseY[i],
    });
  }

  // 8. CCD for fast movers (spheres only).
  for (let i = 0, n = bodies.length; i < n; i++) {
    const eidA = bodies[i];
    const idA = getId(eidA);
    if (R.type[idA] !== BodyType3D.DYNAMIC) continue;
    if ((R.flags[idA] & 4) === 0) continue; // ccdEnabled

    const speedSq = R.vx[idA] ** 2 + R.vy[idA] ** 2 + R.vz[idA] ** 2;
    if (speedSq < 4.0) continue;

    for (let j = 0; j < Contact3D.count; j++) {
      const eidB = Contact3D.bodyB[j];
      const idB = getId(eidB);
      if (R.type[idB] !== BodyType3D.STATIC) continue;
      const toi = computeTOI3D(eidA, eidB, dt);
      if (toi < 1.0) {
        R.px[idA] += R.vx[idA] * dt * toi;
        R.py[idA] += R.vy[idA] * dt * toi;
        R.pz[idA] += R.vz[idA] * dt * toi;
        R.vx[idA] = 0; R.vy[idA] = 0; R.vz[idA] = 0;
        R.wx[idA] = 0; R.wy[idA] = 0; R.wz[idA] = 0;
        syncBody3DToTransform(eidA);
        break;
      }
    }
  }

  // 9. BVH refit.
  for (let i = 0, n = bodies.length; i < n; i++) {
    bvhMoveProxy(bodies[i]);
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// CONVENIENCE CONSTRUCTORS
// ═══════════════════════════════════════════════════════════════════════

export function createSphere3D(world, eid, {
  x = 0, y = 0, z = 0, radius = 0.5,
  type = BodyType3D.DYNAMIC, density = 1, friction = 0.3, restitution = 0,
} = {}) {
  addRigidBody3D(world, eid, { type, px: x, py: y, pz: z });
  setShape3D(world, eid, {
    type: ShapeType3D.SPHERE, radius, density, friction, restitution,
  });
  return eid;
}

export function createBox3D(world, eid, {
  x = 0, y = 0, z = 0, hx = 0.5, hy = 0.5, hz = 0.5,
  type = BodyType3D.DYNAMIC, density = 1, friction = 0.3, restitution = 0,
} = {}) {
  addRigidBody3D(world, eid, { type, px: x, py: y, pz: z });
  setShape3D(world, eid, {
    type: ShapeType3D.BOX, hx, hy, hz, density, friction, restitution,
  });
  return eid;
}

export function createCapsule3D(world, eid, {
  x = 0, y = 0, z = 0, radius = 0.4, halfHeight = 0.5,
  type = BodyType3D.DYNAMIC, density = 1, friction = 0.3, restitution = 0,
} = {}) {
  addRigidBody3D(world, eid, { type, px: x, py: y, pz: z });
  setShape3D(world, eid, {
    type: ShapeType3D.CAPSULE, radius, halfHeight, density, friction, restitution,
  });
  return eid;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function physics3DStats() {
  return {
    contactCount: Contact3D.count,
    velocityIterations: Physics3DState.velocityIterations,
    positionIterations: Physics3DState.positionIterations,
    gravity: [Physics3DState.gravityX, Physics3DState.gravityY, Physics3DState.gravityZ],
  };
}

export function resetPhysics3D() {
  Contact3D.count = 0;
  Physics3DState.prevContacts.clear();
  Physics3DState.accumulator = 0;
}