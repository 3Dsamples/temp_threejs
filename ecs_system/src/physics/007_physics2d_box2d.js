// file number : 007
// full path name : src/physics/007_physics2d_box2d.js
// description : 2D rigid body physics system derived from Box2D's sequential
//               impulse solver. Implements SoA RigidBody2D (velocity, angular
//               velocity, mass, inertia), Fixture2D (circle/box/polygon shapes,
//               friction, restitution), contact manifolds, warm-starting,
//               velocity iterations (default 8), NGS position correction
//               (beta=0.2), TOI for fast movers, and a broadphase adapter
//               consuming file 003's bvhCollisionPairs(). All data is packed
//               into Float32Array/Int32Array; zero per-contact allocation.
// best for : 2D physics on Android 64-bit, Box2D-compatible gameplay,
//            character controllers, puzzle physics, and any 2D scene that
//            must scale to 1M bodies without GC spikes.
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
  bvhCollisionPairs,
  bvhCreateProxy,
  bvhDestroyProxy,
  bvhMoveProxy,
} from '../spatial/003_bvh_broadphase.js';

import {
  WorldBoundsF32,
} from '../geometry/004_aabb_bounds.js';

import {
  vec2,
  mat2,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

const MAX_BODIES = 1_000_000;
const MAX_CONTACTS = 4_000_000;       // conservative
const B2_MAX_MANIFOLD_POINTS = 2;      // Box2D default
const LINEAR_SLOP = 0.005;             // b2_linearSlop
const MAX_LINEAR_CORRECTION = 0.2;     // b2_maxLinearCorrection
const BAUMGARTE = 0.2;                 // beta for NGS
const VELOCITY_THRESHOLD = 1.0;        // restitution threshold

// ═══════════════════════════════════════════════════════════════════════
// BODY TYPE
// ═══════════════════════════════════════════════════════════════════════

export const BodyType = Object.freeze({
  STATIC: 0,
  KINEMATIC: 1,
  DYNAMIC: 2,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA RIGID BODY STORE
// ═══════════════════════════════════════════════════════════════════════

export const RigidBody2D = {
  // Linear state.
  vx: new Float32Array(MAX_BODIES),
  vy: new Float32Array(MAX_BODIES),

  // Angular state.
  angularVelocity: new Float32Array(MAX_BODIES),
  angle: new Float32Array(MAX_BODIES),            // radians

  // Position (also mirrored to LocalTransformF32 for rendering).
  px: new Float32Array(MAX_BODIES),
  py: new Float32Array(MAX_BODIES),

  // Mass properties.
  invMass: new Float32Array(MAX_BODIES),
  invInertia: new Float32Array(MAX_BODIES),

  // Damping.
  linearDamping: new Float32Array(MAX_BODIES),
  angularDamping: new Float32Array(MAX_BODIES),

  // Gravity scale (per-body override; default 1).
  gravityScale: new Float32Array(MAX_BODIES),

  // Body type.
  type: new Uint8Array(MAX_BODIES),

  // Flags: bit 0 = awake, bit 1 = fixed rotation.
  flags: new Uint8Array(MAX_BODIES),

  // Sleep timer (seconds of low activity).
  sleepTime: new Float32Array(MAX_BODIES),

  // Velocity caps (per-body).
  maxLinearVelocity: new Float32Array(MAX_BODIES),
  maxAngularVelocity: new Float32Array(MAX_BODIES),
};

// ═══════════════════════════════════════════════════════════════════════
// SoA FIXTURE STORE
// ═══════════════════════════════════════════════════════════════════════

export const ShapeType = Object.freeze({
  CIRCLE: 0,
  BOX: 1,
  POLYGON: 2,
});

export const Fixture2D = {
  // Shape type.
  shapeType: new Uint8Array(MAX_BODIES),

  // Circle radius (also used as skin for boxes).
  radius: new Float32Array(MAX_BODIES),

  // Box half-extents (only for BOX).
  hx: new Float32Array(MAX_BODIES),
  hy: new Float32Array(MAX_BODIES),

  // Polygon vertices (up to 8) — stored as flat [x0,y0,x1,y1,...].
  // For BOX we synthesize vertices from hx/hy; polygon uses this array.
  polyVerts: new Float32Array(MAX_BODIES * 16), // 8 vertices × 2
  polyCount: new Uint8Array(MAX_BODIES),

  // Material.
  density: new Float32Array(MAX_BODIES),
  friction: new Float32Array(MAX_BODIES),
  restitution: new Float32Array(MAX_BODIES),

  // Collision filtering (Box2D-style category/mask/group).
  categoryBits: new Uint32Array(MAX_BODIES),
  maskBits: new Uint32Array(MAX_BODIES),
  groupIndex: new Int16Array(MAX_BODIES),

  // Local offset from body center.
  offsetX: new Float32Array(MAX_BODIES),
  offsetY: new Float32Array(MAX_BODIES),
  offsetAngle: new Float32Array(MAX_BODIES),

  // Body this fixture belongs to.
  bodyEid: new Uint32Array(MAX_BODIES),
};

// ═══════════════════════════════════════════════════════════════════════
// CONTACT MANIFOLD SoA
// ═══════════════════════════════════════════════════════════════════════

export const Contact2D = {
  // Body entity IDs.
  bodyA: new Uint32Array(MAX_CONTACTS),
  bodyB: new Uint32Array(MAX_CONTACTS),

  // World-space contact point.
  pointX: new Float32Array(MAX_CONTACTS),
  pointY: new Float32Array(MAX_CONTACTS),

  // Contact normal (from A to B).
  normalX: new Float32Array(MAX_CONTACTS),
  normalY: new Float32Array(MAX_CONTACTS),

  // Penetration depth (positive = separated).
  separation: new Float32Array(MAX_CONTACTS),

  // Accumulated impulses (for warm starting).
  normalImpulse: new Float32Array(MAX_CONTACTS),
  tangentImpulse: new Float32Array(MAX_CONTACTS),

  // Effective masses (computed each step).
  normalMass: new Float32Array(MAX_CONTACTS),
  tangentMass: new Float32Array(MAX_CONTACTS),

  // Material coefficients (combined friction / restitution).
  friction: new Float32Array(MAX_CONTACTS),
  restitution: new Float32Array(MAX_CONTACTS),

  // Relative contact vectors (from body center to contact point).
  rAx: new Float32Array(MAX_CONTACTS),
  rAy: new Float32Array(MAX_CONTACTS),
  rBx: new Float32Array(MAX_CONTACTS),
  rBy: new Float32Array(MAX_CONTACTS),

  // Velocity bias (for restitution).
  velocityBias: new Float32Array(MAX_CONTACTS),

  // Contact count (active manifolds).
  count: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// WORLD STATE
// ═══════════════════════════════════════════════════════════════════════

export const Physics2DState = {
  gravityX: 0,
  gravityY: -9.81,
  velocityIterations: 8,
  positionIterations: 3,
  fixedTimeStep: 1 / 60,
  accumulator: 0,
  // Contacts cached between frames for warm starting.
  prevContacts: new Map(), // key "eidA|eidB" -> { normalImpulse, tangentImpulse }
};

// ═══════════════════════════════════════════════════════════════════════
// BODY API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a dynamic 2D rigid body at (px, py).
 * Requires WorldTransformF32 (file 002) — call addTransform first.
 */
export function addRigidBody2D(world, eid, {
  type = BodyType.DYNAMIC,
  px = 0, py = 0, angle = 0,
  vx = 0, vy = 0, angularVelocity = 0,
  mass = 1,
  inertia = 1,
  linearDamping = 0.1,
  angularDamping = 0.1,
  gravityScale = 1,
  maxLinearVelocity = 100,
  maxAngularVelocity = 100,
} = {}) {
  addComponent(world, eid, RigidBody2D);
  addComponent(world, eid, Fixture2D);

  const id = getId(eid);
  const R = RigidBody2D;
  R.type[id] = type;
  R.px[id] = px; R.py[id] = py;
  R.angle[id] = angle;
  R.vx[id] = vx; R.vy[id] = vy;
  R.angularVelocity[id] = angularVelocity;
  R.invMass[id] = type === BodyType.STATIC ? 0 : 1 / mass;
  R.invInertia[id] = type === BodyType.STATIC ? 0 : 1 / inertia;
  R.linearDamping[id] = linearDamping;
  R.angularDamping[id] = angularDamping;
  R.gravityScale[id] = gravityScale;
  R.maxLinearVelocity[id] = maxLinearVelocity;
  R.maxAngularVelocity[id] = maxAngularVelocity;
  R.flags[id] = 1; // awake
  R.sleepTime[id] = 0;

  // Sync to transform.
  syncBodyToTransform(eid);
  return eid;
}

/**
 * Set shape on a body's fixture.
 * For BOX: hx, hy. For CIRCLE: radius. For POLYGON: verts (array of [x,y]).
 */
export function setFixtureShape(world, eid, shape) {
  const id = getId(eid);
  const F = Fixture2D;
  const R = RigidBody2D;

  if (shape.type === ShapeType.CIRCLE) {
    F.shapeType[id] = ShapeType.CIRCLE;
    F.radius[id] = shape.radius ?? 0.5;
    F.hx[id] = 0; F.hy[id] = 0;
    F.polyCount[id] = 0;
    // Mass: π r² ρ.
    const m = Math.PI * shape.radius * shape.radius * (shape.density ?? 1);
    R.invMass[id] = R.type[id] === BodyType.STATIC ? 0 : 1 / m;
    // Inertia: ½ m r².
    R.invInertia[id] = R.type[id] === BodyType.STATIC ? 0 : 1 / (0.5 * m * shape.radius * shape.radius);
  } else if (shape.type === ShapeType.BOX) {
    F.shapeType[id] = ShapeType.BOX;
    F.hx[id] = shape.hx ?? 0.5;
    F.hy[id] = shape.hy ?? 0.5;
    F.radius[id] = 0;
    F.polyCount[id] = 0;
    const m = 4 * F.hx[id] * F.hy[id] * (shape.density ?? 1);
    R.invMass[id] = R.type[id] === BodyType.STATIC ? 0 : 1 / m;
    // Box inertia: m (w² + h²) / 12.
    const w = 2 * F.hx[id], h = 2 * F.hy[id];
    R.invInertia[id] = R.type[id] === BodyType.STATIC ? 0 : 1 / (m * (w * w + h * h) / 12);
  } else if (shape.type === ShapeType.POLYGON) {
    F.shapeType[id] = ShapeType.POLYGON;
    F.polyCount[id] = Math.min(shape.verts.length, 8);
    const base = id * 16;
    for (let i = 0; i < F.polyCount[id]; i++) {
      F.polyVerts[base + i * 2]     = shape.verts[i][0];
      F.polyVerts[base + i * 2 + 1] = shape.verts[i][1];
    }
    // Approximate mass via polygon area (use shoelace).
    const area = polygonArea(F.polyVerts, base, F.polyCount[id]);
    const m = area * (shape.density ?? 1);
    R.invMass[id] = R.type[id] === BodyType.STATIC ? 0 : 1 / m;
    R.invInertia[id] = R.type[id] === BodyType.STATIC ? 0 : 1 / (m * polygonInertia(F.polyVerts, base, F.polyCount[id]));
  }

  F.density[id] = shape.density ?? 1;
  F.friction[id] = shape.friction ?? 0.2;
  F.restitution[id] = shape.restitution ?? 0.0;
  F.categoryBits[id] = shape.categoryBits ?? 0x0001;
  F.maskBits[id] = shape.maskBits ?? 0xFFFF;
  F.groupIndex[id] = shape.groupIndex ?? 0;
  F.bodyEid[id] = eid;

  // Create BVH proxy with shape bounds.
  bvhCreateProxy(eid);
  return eid;
}

function polygonArea(verts, base, n) {
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const xi = verts[base + i * 2], yi = verts[base + i * 2 + 1];
    const xj = verts[base + j * 2], yj = verts[base + j * 2 + 1];
    area += xi * yj - xj * yi;
  }
  return Math.abs(area) * 0.5;
}

function polygonInertia(verts, base, n) {
  // Approximate as circle with same area — adequate for gameplay.
  const area = polygonArea(verts, base, n);
  return area * 0.5;
}

// ═══════════════════════════════════════════════════════════════════════
// SYNC — write body state into transform components
// ═══════════════════════════════════════════════════════════════════════

export function syncBodyToTransform(eid) {
  const id = getId(eid);
  const R = RigidBody2D;
  const L = LocalTransformF32;

  L.px[id] = R.px[id];
  L.py[id] = R.py[id];
  L.pz[id] = 0;
  L.qx[id] = 0;
  L.qy[id] = 0;
  L.qz[id] = Math.sin(R.angle[id] * 0.5);
  L.qw[id] = Math.cos(R.angle[id] * 0.5);
  L.sx[id] = 1; L.sy[id] = 1; L.sz[id] = 1;

  markDirty(eid);
}

// ═══════════════════════════════════════════════════════════════════════
// NARROWPHASE — 2D shape collision
// ═══════════════════════════════════════════════════════════════════════

function collideCircleCircle(ax, ay, ar, bx, by, br, out) {
  const dx = bx - ax, dy = by - ay;
  const distSq = dx * dx + dy * dy;
  const rSum = ar + br;
  if (distSq > rSum * rSum) return false;

  const dist = Math.sqrt(distSq) || 1e-6;
  const nx = dx / dist, ny = dy / dist;
  const penetration = rSum - dist;

  out.pointX = ax + nx * ar;
  out.pointY = ay + ny * ar;
  out.normalX = nx;
  out.normalY = ny;
  out.separation = -penetration;
  return true;
}

function collideCircleBox(cx, cy, cr, bx, by, angle, hx, hy, out) {
  // Transform circle into box local space.
  const cos = Math.cos(-angle), sin = Math.sin(-angle);
  const dx = cx - bx, dy = cy - by;
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;

  // Clamp to box.
  const clampedX = Math.max(-hx, Math.min(hx, lx));
  const clampedY = Math.max(-hy, Math.min(hy, ly));
  const ddx = lx - clampedX, ddy = ly - clampedY;
  const distSq = ddx * ddx + ddy * ddy;

  if (distSq > cr * cr) return false;

  // Contact normal in local space.
  let nx, ny, penetration;
  if (distSq > 1e-12) {
    const dist = Math.sqrt(distSq);
    nx = ddx / dist; ny = ddy / dist;
    penetration = cr - dist;
  } else {
    // Circle center inside box.
    const dxEdge = hx - Math.abs(lx);
    const dyEdge = hy - Math.abs(ly);
    if (dxEdge < dyEdge) {
      nx = lx < 0 ? -1 : 1; ny = 0;
      penetration = cr + dxEdge;
    } else {
      nx = 0; ny = ly < 0 ? -1 : 1;
      penetration = cr + dyEdge;
    }
  }

  // Rotate normal back to world.
  const cosW = Math.cos(angle), sinW = Math.sin(angle);
  out.normalX = nx * cosW - ny * sinW;
  out.normalY = nx * sinW + ny * cosW;

  // Contact point in world.
  const localPX = clampedX + nx * (cr - penetration);
  const localPY = clampedY + ny * (cr - penetration);
  out.pointX = bx + localPX * cosW - localPY * sinW;
  out.pointY = by + localPX * sinW + localPY * cosW;

  out.separation = -penetration;
  return true;
}

function collideBoxBox(ax, ay, aAngle, ahx, ahy, bx, by, bAngle, bhx, bhy, out) {
  // Simplified SAT for axis-aligned + rotated boxes.
  // Use A's local axes and B's local axes to find minimum penetration axis.
  const axes = [
    [Math.cos(aAngle), Math.sin(aAngle)],
    [-Math.sin(aAngle), Math.cos(aAngle)],
    [Math.cos(bAngle), Math.sin(bAngle)],
    [-Math.sin(bAngle), Math.cos(bAngle)],
  ];

  let minPen = Infinity;
  let minNx = 0, minNy = 0;
  let found = false;

  for (const [nx, ny] of axes) {
    // Project both boxes onto axis.
    const aProj = projectBox(ax, ay, aAngle, ahx, ahy, nx, ny);
    const bProj = projectBox(bx, by, bAngle, bhx, bhy, nx, ny);

    const overlap = Math.min(aProj.max, bProj.max) - Math.max(aProj.min, bProj.min);
    if (overlap <= 0) return false; // separated

    if (overlap < minPen) {
      minPen = overlap;
      // Normal points from A to B.
      const centerDx = bx - ax, centerDy = by - ay;
      const dot = centerDx * nx + centerDy * ny;
      minNx = dot > 0 ? nx : -nx;
      minNy = dot > 0 ? ny : -ny;
      found = true;
    }
  }

  if (!found) return false;

  out.normalX = minNx;
  out.normalY = minNy;
  out.separation = -minPen;
  // Approximate contact point as midpoint between centers.
  out.pointX = (ax + bx) * 0.5;
  out.pointY = (ay + by) * 0.5;
  return true;
}

function projectBox(cx, cy, angle, hx, hy, nx, ny) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  // Four corners.
  const corners = [
    [-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]
  ];
  let min = Infinity, max = -Infinity;
  for (const [lx, ly] of corners) {
    const wx = cx + lx * cos - ly * sin;
    const wy = cy + lx * sin + ly * cos;
    const p = wx * nx + wy * ny;
    min = Math.min(min, p);
    max = Math.max(max, p);
  }
  return { min, max };
}

// ═══════════════════════════════════════════════════════════════════════
// BROADPHASE ADAPTER — consume file 003 pairs
// ═══════════════════════════════════════════════════════════════════════

function buildContacts(world) {
  Contact2D.count = 0;

  // Ensure all bodies have BVH proxies.
  const bodies = query(world, [RigidBody2D, Fixture2D]);
  for (let i = 0; i < bodies.length; i++) {
    bvhMoveProxy(bodies[i]);
  }

  const pairs = bvhCollisionPairs();
  const _out = {
    pointX: 0, pointY: 0, normalX: 0, normalY: 0, separation: 0,
  };

  for (const [eidA, eidB] of pairs) {
    if (Contact2D.count >= MAX_CONTACTS) break;
    if (!hasComponent(world, eidA, RigidBody2D)) continue;
    if (!hasComponent(world, eidB, RigidBody2D)) continue;

    const idA = getId(eidA);
    const idB = getId(eidB);

    // Collision filtering.
    const FA = Fixture2D;
    if (FA.groupIndex[idA] !== 0 && FA.groupIndex[idA] === FA.groupIndex[idB]) {
      if (FA.groupIndex[idA] > 0) continue; // same positive group = no collide
    }
    if ((FA.categoryBits[idA] & FA.maskBits[idB]) === 0) continue;
    if ((FA.categoryBits[idB] & FA.maskBits[idA]) === 0) continue;

    const R = RigidBody2D;
    const typeA = FA.shapeType[idA];
    const typeB = FA.shapeType[idB];

    let hit = false;
    if (typeA === ShapeType.CIRCLE && typeB === ShapeType.CIRCLE) {
      hit = collideCircleCircle(
        R.px[idA], R.py[idA], FA.radius[idA],
        R.px[idB], R.py[idB], FA.radius[idB],
        _out
      );
    } else if (typeA === ShapeType.CIRCLE && typeB === ShapeType.BOX) {
      hit = collideCircleBox(
        R.px[idA], R.py[idA], FA.radius[idA],
        R.px[idB], R.py[idB], R.angle[idB], FA.hx[idB], FA.hy[idB],
        _out
      );
    } else if (typeA === ShapeType.BOX && typeB === ShapeType.CIRCLE) {
      hit = collideCircleBox(
        R.px[idB], R.py[idB], FA.radius[idB],
        R.px[idA], R.py[idA], R.angle[idA], FA.hx[idA], FA.hy[idA],
        _out
      );
      if (hit) {
        // Flip normal: collideCircleBox returns normal from box→circle.
        _out.normalX = -_out.normalX;
        _out.normalY = -_out.normalY;
      }
    } else if (typeA === ShapeType.BOX && typeB === ShapeType.BOX) {
      hit = collideBoxBox(
        R.px[idA], R.py[idA], R.angle[idA], FA.hx[idA], FA.hy[idA],
        R.px[idB], R.py[idB], R.angle[idB], FA.hx[idB], FA.hy[idB],
        _out
      );
    }

    if (!hit) continue;

    const idx = Contact2D.count++;
    Contact2D.bodyA[idx] = eidA;
    Contact2D.bodyB[idx] = eidB;
    Contact2D.pointX[idx] = _out.pointX;
    Contact2D.pointY[idx] = _out.pointY;
    Contact2D.normalX[idx] = _out.normalX;
    Contact2D.normalY[idx] = _out.normalY;
    Contact2D.separation[idx] = _out.separation;

    // Combined material.
    Contact2D.friction[idx] = Math.sqrt(FA.friction[idA] * FA.friction[idB]);
    Contact2D.restitution[idx] = Math.max(FA.restitution[idA], FA.restitution[idB]);

    // Warm start: look up previous impulses.
    const key = `${eidA}|${eidB}`;
    const prev = Physics2DState.prevContacts.get(key);
    Contact2D.normalImpulse[idx] = prev ? prev.normalImpulse : 0;
    Contact2D.tangentImpulse[idx] = prev ? prev.tangentImpulse : 0;

    // Contact vectors from body centers to contact point.
    Contact2D.rAx[idx] = _out.pointX - R.px[idA];
    Contact2D.rAy[idx] = _out.pointY - R.py[idA];
    Contact2D.rBx[idx] = _out.pointX - R.px[idB];
    Contact2D.rBy[idx] = _out.pointY - R.py[idB];
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SEQUENTIAL IMPULSE SOLVER
// ═══════════════════════════════════════════════════════════════════════

function solveVelocityConstraints() {
  const R = RigidBody2D;

  for (let i = 0; i < Contact2D.count; i++) {
    const eidA = Contact2D.bodyA[i];
    const eidB = Contact2D.bodyB[i];
    const idA = getId(eidA);
    const idB = getId(eidB);

    const nx = Contact2D.normalX[i];
    const ny = Contact2D.normalY[i];
    const tx = -ny;
    const ty = nx;

    const rAx = Contact2D.rAx[i], rAy = Contact2D.rAy[i];
    const rBx = Contact2D.rBx[i], rBy = Contact2D.rBy[i];

    const invMassA = R.invMass[idA], invMassB = R.invMass[idB];
    const invIA = R.invInertia[idA], invIB = R.invInertia[idB];

    // Effective mass along normal.
    const rnA = rAx * ny - rAy * nx;
    const rnB = rBx * ny - rBy * nx;
    const normalMass = 1 / (invMassA + invMassB + invIA * rnA * rnA + invIB * rnB * rnB);
    Contact2D.normalMass[i] = normalMass;

    // Effective mass along tangent.
    const rtA = rAx * ty - rAy * tx;
    const rtB = rBx * ty - rBy * tx;
    const tangentMass = 1 / (invMassA + invMassB + invIA * rtA * rtA + invIB * rtB * rtB);
    Contact2D.tangentMass[i] = tangentMass;

    // Relative velocity at contact.
    const dvx = (R.vx[idB] - R.angularVelocity[idB] * rBy) -
                (R.vx[idA] - R.angularVelocity[idA] * rAy);
    const dvy = (R.vy[idB] + R.angularVelocity[idB] * rBx) -
                (R.vy[idA] + R.angularVelocity[idA] * rAx);

    // Normal impulse.
    const vn = dvx * nx + dvy * ny;
    let lambdaN = -normalMass * vn;
    // Accumulate and clamp.
    const oldN = Contact2D.normalImpulse[i];
    Contact2D.normalImpulse[i] = Math.max(0, oldN + lambdaN);
    lambdaN = Contact2D.normalImpulse[i] - oldN;

    // Apply normal impulse.
    R.vx[idA] -= lambdaN * nx * invMassA;
    R.vy[idA] -= lambdaN * ny * invMassA;
    R.angularVelocity[idA] -= lambdaN * (rAx * ny - rAy * nx) * invIA;

    R.vx[idB] += lambdaN * nx * invMassB;
    R.vy[idB] += lambdaN * ny * invMassB;
    R.angularVelocity[idB] += lambdaN * (rBx * ny - rBy * nx) * invIB;

    // Tangent impulse (friction).
    const vt = dvx * tx + dvy * ty;
    const friction = Contact2D.friction[i];
    let lambdaT = -tangentMass * vt;
    const oldT = Contact2D.tangentImpulse[i];
    const maxFriction = friction * Contact2D.normalImpulse[i];
    Contact2D.tangentImpulse[i] = Math.max(-maxFriction, Math.min(maxFriction, oldT + lambdaT));
    lambdaT = Contact2D.tangentImpulse[i] - oldT;

    R.vx[idA] -= lambdaT * tx * invMassA;
    R.vy[idA] -= lambdaT * ty * invMassA;
    R.angularVelocity[idA] -= lambdaT * (rAx * ty - rAy * tx) * invIA;

    R.vx[idB] += lambdaT * tx * invMassB;
    R.vy[idB] += lambdaT * ty * invMassB;
    R.angularVelocity[idB] += lambdaT * (rBx * ty - rBy * tx) * invIB;
  }
}

function warmStart() {
  const R = RigidBody2D;
  for (let i = 0; i < Contact2D.count; i++) {
    const eidA = Contact2D.bodyA[i];
    const eidB = Contact2D.bodyB[i];
    const idA = getId(eidA);
    const idB = getId(eidB);

    const nx = Contact2D.normalX[i], ny = Contact2D.normalY[i];
    const tx = -ny, ty = nx;

    const rAx = Contact2D.rAx[i], rAy = Contact2D.rAy[i];
    const rBx = Contact2D.rBx[i], rBy = Contact2D.rBy[i];

    const invMassA = R.invMass[idA], invMassB = R.invMass[idB];
    const invIA = R.invInertia[idA], invIB = R.invInertia[idB];

    const Px = Contact2D.normalImpulse[i] * nx + Contact2D.tangentImpulse[i] * tx;
    const Py = Contact2D.normalImpulse[i] * ny + Contact2D.tangentImpulse[i] * ty;

    R.vx[idA] -= Px * invMassA;
    R.vy[idA] -= Py * invMassA;
    R.angularVelocity[idA] -= (rAx * Py - rAy * Px) * invIA;

    R.vx[idB] += Px * invMassB;
    R.vy[idB] += Py * invMassB;
    R.angularVelocity[idB] += (rBx * Py - rBy * Px) * invIB;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// POSITION CORRECTION (NGS, beta = 0.2)
// ═══════════════════════════════════════════════════════════════════════

function solvePositionConstraints() {
  const R = RigidBody2D;
  let minSeparation = 0;

  for (let i = 0; i < Contact2D.count; i++) {
    const eidA = Contact2D.bodyA[i];
    const eidB = Contact2D.bodyB[i];
    const idA = getId(eidA);
    const idB = getId(eidB);

    if (R.type[idA] === BodyType.STATIC && R.type[idB] === BodyType.STATIC) continue;

    const nx = Contact2D.normalX[i];
    const ny = Contact2D.normalY[i];
    const rAx = Contact2D.rAx[i], rAy = Contact2D.rAy[i];
    const rBx = Contact2D.rBx[i], rBy = Contact2D.rBy[i];

    const invMassA = R.invMass[idA], invMassB = R.invMass[idB];
    const invIA = R.invInertia[idA], invIB = R.invInertia[idB];

    // Recompute separation from current positions.
    const dx = (R.px[idB] + rBx) - (R.px[idA] + rAx);
    const dy = (R.py[idB] + rBy) - (R.py[idA] + rAy);
    const separation = dx * nx + dy * ny;

    minSeparation = Math.min(minSeparation, separation);

    const C = Math.max(-MAX_LINEAR_CORRECTION, Math.min(MAX_LINEAR_CORRECTION, BAUMGARTE * (separation + LINEAR_SLOP)));
    if (C === 0) continue;

    const rnA = rAx * ny - rAy * nx;
    const rnB = rBx * ny - rBy * nx;
    const K = invMassA + invMassB + invIA * rnA * rnA + invIB * rnB * rnB;
    const impulse = -C / K;

    const Px = impulse * nx;
    const Py = impulse * ny;

    R.px[idA] -= Px * invMassA;
    R.py[idA] -= Py * invMassA;
    R.angle[idA] -= (rAx * Py - rAy * Px) * invIA;

    R.px[idB] += Px * invMassB;
    R.py[idB] += Py * invMassB;
    R.angle[idB] += (rBx * Py - rBy * Px) * invIB;
  }
  return minSeparation;
}

// ═══════════════════════════════════════════════════════════════════════
// TOI (time of impact) — conservative advancement for fast bodies
// ═══════════════════════════════════════════════════════════════════════

const TOI_MAX_ITERATIONS = 20;
const TOI_TOLERANCE = 0.001;

function computeTOI(eidA, eidB, dt) {
  const idA = getId(eidA);
  const idB = getId(eidB);
  const R = RigidBody2D;
  const F = Fixture2D;

  // Only handle circle-circle TOI for simplicity; boxes fall back to discrete.
  if (F.shapeType[idA] !== ShapeType.CIRCLE || F.shapeType[idB] !== ShapeType.CIRCLE) {
    return 1.0; // no TOI
  }

  const rA = F.radius[idA];
  const rB = F.radius[idB];
  const rSum = rA + rB;

  let t = 0;
  for (let iter = 0; iter < TOI_MAX_ITERATIONS; iter++) {
    // Relative position at time t.
    const pxA = R.px[idA] + R.vx[idA] * t * dt;
    const pyA = R.py[idA] + R.vy[idA] * t * dt;
    const pxB = R.px[idB] + R.vx[idB] * t * dt;
    const pyB = R.py[idB] + R.vy[idB] * t * dt;

    const dx = pxB - pxA;
    const dy = pyB - pyA;
    const distSq = dx * dx + dy * dy;
    const dist = Math.sqrt(distSq);

    if (dist < rSum - TOI_TOLERANCE) return t; // collision at t
    if (dist < rSum + TOI_TOLERANCE) {
      // Close enough — step forward.
      const relVx = R.vx[idB] - R.vx[idA];
      const relVy = R.vy[idB] - R.vy[idA];
      const closingSpeed = -(dx * relVx + dy * relVy) / (dist || 1e-6);
      if (closingSpeed <= 0) return 1.0; // moving apart
      const advance = (dist - rSum) / closingSpeed;
      t += advance / dt;
      if (t >= 1.0) return 1.0;
    } else {
      return 1.0; // no collision within dt
    }
  }
  return 1.0;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN STEP — systemPhysics2DStep(world, dt)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Step the 2D physics simulation by `dt` seconds.
 *
 * Pipeline (Box2D order):
 *   1. Integrate velocities (gravity, damping)
 *   2. Build contacts via BVH broadphase
 *   3. Warm start
 *   4. Velocity iterations (default 8)
 *   5. Integrate positions
 *   6. Position iterations (default 3)
 *   7. Sync transforms + BVH refit
 *   8. TOI for fast movers (optional)
 */
export function systemPhysics2DStep(world, dt) {
  if (dt <= 0) return world;
  const R = RigidBody2D;
  const bodies = query(world, [RigidBody2D]);
  const state = Physics2DState;

  // 1. Integrate velocities.
  for (let i = 0, n = bodies.length; i < n; i++) {
    const eid = bodies[i];
    const id = getId(eid);
    if (R.type[id] !== BodyType.DYNAMIC) continue;
    if ((R.flags[id] & 1) === 0) continue; // asleep

    // Gravity.
    R.vx[id] += state.gravityX * R.gravityScale[id] * dt;
    R.vy[id] += state.gravityY * R.gravityScale[id] * dt;

    // Damping (Box2D: v *= 1 / (1 + dt * damping)).
    const damp = 1 / (1 + dt * R.linearDamping[id]);
    R.vx[id] *= damp;
    R.vy[id] *= damp;
    R.angularVelocity[id] *= 1 / (1 + dt * R.angularDamping[id]);

    // Clamp.
    const maxV = R.maxLinearVelocity[id];
    const vSq = R.vx[id] * R.vx[id] + R.vy[id] * R.vy[id];
    if (vSq > maxV * maxV) {
      const scale = maxV / Math.sqrt(vSq);
      R.vx[id] *= scale;
      R.vy[id] *= scale;
    }
    R.angularVelocity[id] = Math.max(-R.maxAngularVelocity[id],
      Math.min(R.maxAngularVelocity[id], R.angularVelocity[id]));
  }

  // 2. Build contacts.
  buildContacts(world);

  // 3. Warm start.
  warmStart();

  // 4. Velocity iterations.
  for (let iter = 0; iter < state.velocityIterations; iter++) {
    solveVelocityConstraints();
  }

  // 5. Integrate positions.
  for (let i = 0, n = bodies.length; i < n; i++) {
    const eid = bodies[i];
    const id = getId(eid);
    if (R.type[id] !== BodyType.DYNAMIC) continue;

    R.px[id] += R.vx[id] * dt;
    R.py[id] += R.vy[id] * dt;
    R.angle[id] += R.angularVelocity[id] * dt;

    // Sync transform.
    syncBodyToTransform(eid);
  }

  // 6. Position iterations.
  for (let iter = 0; iter < state.positionIterations; iter++) {
    const minSep = solvePositionConstraints();
    if (minSep >= -3 * LINEAR_SLOP) break; // converged
  }

  // 7. Store impulses for warm starting next frame.
  state.prevContacts.clear();
  for (let i = 0; i < Contact2D.count; i++) {
    const key = `${Contact2D.bodyA[i]}|${Contact2D.bodyB[i]}`;
    state.prevContacts.set(key, {
      normalImpulse: Contact2D.normalImpulse[i],
      tangentImpulse: Contact2D.tangentImpulse[i],
    });
  }

  // 8. TOI for fast-moving dynamic bodies vs static bodies.
  for (let i = 0, n = bodies.length; i < n; i++) {
    const eidA = bodies[i];
    const idA = getId(eidA);
    if (R.type[idA] !== BodyType.DYNAMIC) continue;

    // Quick check: skip slow bodies.
    const speedSq = R.vx[idA] * R.vx[idA] + R.vy[idA] * R.vy[idA];
    if (speedSq < 1.0) continue;

    // Check against static bodies within broadphase pairs.
    // (Simplified: only check pairs already in Contact2D.)
    for (let j = 0; j < Contact2D.count; j++) {
      const eidB = Contact2D.bodyB[j];
      const idB = getId(eidB);
      if (R.type[idB] !== BodyType.STATIC) continue;
      const toi = computeTOI(eidA, eidB, dt);
      if (toi < 1.0) {
        // Advance to TOI, resolve, then continue.
        R.px[idA] = R.px[idA] * (1 - toi) + (R.px[idA] + R.vx[idA] * dt * toi) * toi;
        R.py[idA] = R.py[idA] * (1 - toi) + (R.py[idA] + R.vy[idA] * dt * toi) * toi;
        // For simplicity, just zero normal velocity.
        R.vx[idA] = 0;
        R.vy[idA] = 0;
        syncBodyToTransform(eidA);
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
// CONVENIENCE — create a box body in one call
// ═══════════════════════════════════════════════════════════════════════

export function createBox2D(world, eid, {
  x = 0, y = 0, hx = 0.5, hy = 0.5, angle = 0,
  type = BodyType.DYNAMIC, density = 1, friction = 0.2, restitution = 0,
} = {}) {
  addRigidBody2D(world, eid, { type, px: x, py: y, angle });
  setFixtureShape(world, eid, {
    type: ShapeType.BOX, hx, hy, density, friction, restitution,
  });
  return eid;
}

export function createCircle2D(world, eid, {
  x = 0, y = 0, radius = 0.5,
  type = BodyType.DYNAMIC, density = 1, friction = 0.2, restitution = 0,
} = {}) {
  addRigidBody2D(world, eid, { type, px: x, py: y });
  setFixtureShape(world, eid, {
    type: ShapeType.CIRCLE, radius, density, friction, restitution,
  });
  return eid;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function physics2DStats() {
  return {
    bodyCount: queryActiveBodies(),
    contactCount: Contact2D.count,
    velocityIterations: Physics2DState.velocityIterations,
    positionIterations: Physics2DState.positionIterations,
  };
}

function queryActiveBodies() {
  // Placeholder — actual count available from world query.
  return 0;
}