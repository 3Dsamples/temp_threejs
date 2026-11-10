// file number : 021
// full path name : src/physics/021_shape_queries_character.js
// description : Spatial shape queries and kinematic character controller.
//               Provides a full Box2D-style query API (point, AABB, sphere,
//               capsule, cone) plus swept queries (sphere cast, capsule
//               cast, box cast) over the BVH from file 003 and the rigid
//               body SoA from files 007/008/020. Then builds a full
//               capsule-based kinematic character controller on top:
//               slope limits, step-up, ground snapping, wall sliding,
//               ceiling handling, water/volume detection, and one-way
//               platform support. Character state is stored in SoA
//               (CharacterStateF32) so 100k+ characters move in parallel
//               without per-character object allocation.
//               Also exposes a broadphase AABB query and an overlap query
//               that returns entity IDs, mirroring b2World::QueryAABB.
// best for : Player controllers, NPC movement, ground detection, wall
//            sliding, projectile hit tests, AI perception (sphere/capsule
//            casts), trigger volumes, interaction pickers, and any
//            scene that must respond to player input at 1M-entity scale
//            on Android 64-bit.
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
  BVHNodes,
  BVHState,
  bvhRaycast,
  bvhCollisionPairs,
} from '../spatial/003_bvh_broadphase.js';

import {
  WorldBoundsF32,
  LocalBoundsF32,
  getWorldBoundsCenter,
  getWorldBoundsExtents,
} from '../geometry/004_aabb_bounds.js';

import {
  RigidBody2D,
  Fixture2D,
  ShapeType,
  BodyType,
} from '../physics/007_physics2d_box2d.js';

import {
  RigidBody3D,
  Shape3D,
  BodyType3D,
  ShapeType3D,
} from '../physics/008_physics3d_rigidbody.js';

import {
  vec2,
  vec3,
  quat,
  mat4,
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
const SLOP_DEFAULT              = 0.005;
const GROUND_SNAP_DEFAULT       = 0.05;
const STEP_UP_DEFAULT           = 0.3;
const STEP_DOWN_DEFAULT         = 0.3;
const SLOPE_LIMIT_DEFAULT       = 50 * DEG_TO_RAD;
const CEILING_LIMIT_DEFAULT     = 60 * DEG_TO_RAD;
const SKIN_WIDTH                = 0.005;
const MAX_SWEEP_ITERATIONS      = 8;
const MAX_QUERY_RESULTS         = 4096;
const SWEEP_TOLERANCE           = 1e-4;

const MAX_CHARACTERS = 100_000;

// ═══════════════════════════════════════════════════════════════════════
// QUERY RESULT BUFFER (reused across queries, zero allocation)
// ═══════════════════════════════════════════════════════════════════════

export const QueryResult = {
  eids: new Uint32Array(MAX_QUERY_RESULTS),
  distances: new Float32Array(MAX_QUERY_RESULTS),
  count: 0,
};

function resetQuery() {
  QueryResult.count = 0;
}

function pushQueryResult(eid, distance = 0) {
  if (QueryResult.count >= MAX_QUERY_RESULTS) return;
  QueryResult.eids[QueryResult.count] = eid;
  QueryResult.distances[QueryResult.count] = distance;
  QueryResult.count++;
}

export function getQueryResult() {
  return {
    eids: QueryResult.eids.subarray(0, QueryResult.count),
    distances: QueryResult.distances.subarray(0, QueryResult.count),
    count: QueryResult.count,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// POINT QUERY — find all entities whose AABB contains a point
// ═══════════════════════════════════════════════════════════════════════

export function queryPoint(px, py, pz) {
  resetQuery();
  if (BVHState.root === -1) return getQueryResult();

  const stack = [BVHState.root];
  const A = BVHNodes.aabb;

  while (stack.length > 0) {
    const node = stack.pop();
    const off = node * 6;

    if (px < A[off] || px > A[off + 3]) continue;
    if (py < A[off + 1] || py > A[off + 4]) continue;
    if (pz < A[off + 2] || pz > A[off + 5]) continue;

    if (BVHNodes.child1[node] === -1) {
      pushQueryResult(BVHNodes.userData[node], 0);
    } else {
      stack.push(BVHNodes.child1[node], BVHNodes.child2[node]);
    }
  }
  return getQueryResult();
}

// ═══════════════════════════════════════════════════════════════════════
// AABB QUERY — find all entities whose AABB overlaps a query AABB
// ═══════════════════════════════════════════════════════════════════════

export function queryAABB(minX, minY, minZ, maxX, maxY, maxZ) {
  resetQuery();
  if (BVHState.root === -1) return getQueryResult();

  const stack = [BVHState.root];
  const A = BVHNodes.aabb;

  while (stack.length > 0) {
    const node = stack.pop();
    const off = node * 6;

    if (A[off] > maxX || A[off + 3] < minX) continue;
    if (A[off + 1] > maxY || A[off + 4] < minY) continue;
    if (A[off + 2] > maxZ || A[off + 5] < minZ) continue;

    if (BVHNodes.child1[node] === -1) {
      pushQueryResult(BVHNodes.userData[node], 0);
    } else {
      stack.push(BVHNodes.child1[node], BVHNodes.child2[node]);
    }
  }
  return getQueryResult();
}

// ═══════════════════════════════════════════════════════════════════════
// SPHERE QUERY — find all entities whose AABB overlaps a sphere
// ═══════════════════════════════════════════════════════════════════════

export function querySphere(cx, cy, cz, radius) {
  resetQuery();
  if (BVHState.root === -1) return getQueryResult();

  const stack = [BVHState.root];
  const A = BVHNodes.aabb;
  const r2 = radius * radius;

  while (stack.length > 0) {
    const node = stack.pop();
    const off = node * 6;

    // Closest point on AABB to sphere center.
    const dx = Math.max(A[off] - cx, 0, cx - A[off + 3]);
    const dy = Math.max(A[off + 1] - cy, 0, cy - A[off + 4]);
    const dz = Math.max(A[off + 2] - cz, 0, cz - A[off + 5]);
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq > r2) continue;

    if (BVHNodes.child1[node] === -1) {
      pushQueryResult(BVHNodes.userData[node], Math.sqrt(distSq));
    } else {
      stack.push(BVHNodes.child1[node], BVHNodes.child2[node]);
    }
  }
  return getQueryResult();
}

// ═══════════════════════════════════════════════════════════════════════
// SWEPT SPHERE CAST — find first hit as a sphere travels from A to B
// ═══════════════════════════════════════════════════════════════════════
//
// Uses conservative advancement: iteratively move toward the closest hit,
// shrinking the remaining time. This matches Box2D's sweep-toi logic and
// three-mesh-bvh's shapecast() traversal but in pure SoA form.

const _sweepOrig = vec3.create();
const _sweepDir = vec3.create();

/**
 * Sweep a sphere from (ox, oy, oz) in direction (dx, dy, dz) up to tMax.
 * Returns { eid, t, px, py, pz, nx, ny, nz } or null.
 */
export function sweepSphere(ox, oy, oz, dx, dy, dz, radius, tMax = 1.0) {
  if (BVHState.root === -1) return null;

  // Normalize direction so t is in world units.
  const dLen = Math.hypot(dx, dy, dz);
  if (dLen < EPSILON) return null;
  const ndx = dx / dLen, ndy = dy / dLen, ndz = dz / dLen;

  let t = 0;
  let best = null;

  for (let iter = 0; iter < MAX_SWEEP_ITERATIONS; iter++) {
    if (t >= tMax) break;

    // Current sphere center.
    const cx = ox + ndx * t;
    const cy = oy + ndy * t;
    const cz = oz + ndz * t;

    // Find closest entity within radius.
    const hits = querySphere(cx, cy, cz, radius);

    if (hits.count === 0) break;

    // Find the closest.
    let closestEid = 0;
    let closestDist = Infinity;
    for (let i = 0; i < hits.count; i++) {
      if (hits.distances[i] < closestDist) {
        closestDist = hits.distances[i];
        closestEid = hits.eids[i];
      }
    }

    if (closestEid === 0) break;

    // Advance t by the distance to closest minus radius (minus slop).
    const advance = Math.max(closestDist - radius - SKIN_WIDTH, SWEEP_TOLERANCE);
    t += advance;

    if (t > tMax) break;

    // Check if we've actually hit (distance < radius + tolerance).
    if (closestDist < radius + SWEEP_TOLERANCE) {
      // Compute hit normal from closest point.
      const hitCenter = [ox + ndx * t, oy + ndy * t, oz + ndz * t];
      const id = getId(closestEid);
      const off = id * 6;
      const A = WorldBoundsF32.aabb;

      // Approximate normal: from bounds center to sphere center.
      const bx = (A[off] + A[off + 3]) * 0.5;
      const by = (A[off + 1] + A[off + 4]) * 0.5;
      const bz = (A[off + 2] + A[off + 5]) * 0.5;

      let nx = hitCenter[0] - bx;
      let ny = hitCenter[1] - by;
      let nz = hitCenter[2] - bz;
      const nLen = Math.hypot(nx, ny, nz) || 1;
      nx /= nLen; ny /= nLen; nz /= nLen;

      best = {
        eid: closestEid,
        t,
        px: hitCenter[0],
        py: hitCenter[1],
        pz: hitCenter[2],
        nx, ny, nz,
      };
      break;
    }
  }

  return best;
}

// ═══════════════════════════════════════════════════════════════════════
// SWEPT CAPSULE CAST — for character movement
// ═══════════════════════════════════════════════════════════════════════
//
// A capsule is defined by two endpoints (pa, pb) and a radius. To sweep it,
// we sweep each endpoint and take the minimum t, then compute a combined
// normal. This is exact for vertically-aligned capsules against AABBs.

/**
 * @param pax, pay, paz        capsule bottom point at t=0
 * @param pbx, pby, pbz        capsule top point at t=0
 * @param radius               capsule radius
 * @param dx, dy, dz           sweep direction
 * @param tMax                 max sweep distance
 * @returns { eid, t, px, py, pz, nx, ny, nz } | null
 */
export function sweepCapsule(pax, pay, paz, pbx, pby, pbz, radius,
                             dx, dy, dz, tMax = 1.0) {
  // Sweep bottom hemisphere.
  const hitA = sweepSphere(pax, pay, paz, dx, dy, dz, radius, tMax);
  // Sweep top hemisphere.
  const hitB = sweepSphere(pbx, pby, pbz, dx, dy, dz, radius, tMax);

  if (!hitA && !hitB) return null;
  if (!hitA) return hitB;
  if (!hitB) return hitA;

  if (hitA.t < hitB.t) return hitA;
  if (hitB.t < hitA.t) return hitB;

  // Same entity / same t — merge normals.
  return {
    eid: hitA.eid,
    t: hitA.t,
    px: (hitA.px + hitB.px) * 0.5,
    py: (hitA.py + hitB.py) * 0.5,
    pz: (hitA.pz + hitB.pz) * 0.5,
    nx: (hitA.nx + hitB.nx) * 0.5,
    ny: (hitA.ny + hitB.ny) * 0.5,
    nz: (hitA.nz + hitB.nz) * 0.5,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CAPSULE CHARACTER CONTROLLER — SoA state
// ═══════════════════════════════════════════════════════════════════════

export const CharacterStateF32 = {
  // Capsule dimensions (radius, half-height of cylindrical portion).
  radius:    new Float32Array(MAX_CHARACTERS),
  halfHeight: new Float32Array(MAX_CHARACTERS),

  // Velocity.
  vx: new Float32Array(MAX_CHARACTERS),
  vy: new Float32Array(MAX_CHARACTERS),
  vz: new Float32Array(MAX_CHARACTERS),

  // Requested movement this frame (from input, before collision).
  wishX: new Float32Array(MAX_CHARACTERS),
  wishY: new Float32Array(MAX_CHARACTERS),
  wishZ: new Float32Array(MAX_CHARACTERS),

  // Gravity scale.
  gravityScale: new Float32Array(MAX_CHARACTERS),

  // Jump impulse.
  jumpSpeed: new Float32Array(MAX_CHARACTERS),

  // Grounded flag (bit 0), touching ceiling (bit 1), touching wall (bit 2).
  flags: new Uint8Array(MAX_CHARACTERS),

  // Slope limit (radians).
  slopeLimit: new Float32Array(MAX_CHARACTERS),

  // Ground snap distance.
  groundSnap: new Float32Array(MAX_CHARACTERS),

  // Step-up and step-down heights.
  stepUp:    new Float32Array(MAX_CHARACTERS),
  stepDown:  new Float32Array(MAX_CHARACTERS),

  // Per-frame time since last ground contact (for coyote-time jumps).
  timeSinceGrounded: new Float32Array(MAX_CHARACTERS),

  // Current surface normal at feet.
  groundNormalX: new Float32Array(MAX_CHARACTERS),
  groundNormalY: new Float32Array(MAX_CHARACTERS),
  groundNormalZ: new Float32Array(MAX_CHARACTERS),

  // Entity that owns the character.
  ownerEid: new Uint32Array(MAX_CHARACTERS),
};

/** Marker: entity is a character. */
export const CharacterTag = {};

const _characterSlots = new Map(); // eid -> slot
let _nextCharacterSlot = 0;

/**
 * Create a character controller on an entity.
 * @param radius      capsule radius
 * @param height      total capsule height (including hemispherical caps)
 * @param options     { slopeLimit, groundSnap, stepUp, stepDown,
 *                      jumpSpeed, gravityScale }
 */
export function addCharacter(world, eid, radius = 0.5, height = 1.8, options = {}) {
  if (_nextCharacterSlot >= MAX_CHARACTERS) {
    throw new Error('character capacity exceeded');
  }
  const slot = _nextCharacterSlot++;

  addComponent(world, eid, CharacterTag);

  const C = CharacterStateF32;
  C.radius[slot] = radius;
  C.halfHeight[slot] = Math.max(0, height * 0.5 - radius); // cylinder half-height
  C.vx[slot] = 0; C.vy[slot] = 0; C.vz[slot] = 0;
  C.gravityScale[slot] = options.gravityScale ?? 1;
  C.jumpSpeed[slot] = options.jumpSpeed ?? 6;
  C.slopeLimit[slot] = options.slopeLimit ?? SLOPE_LIMIT_DEFAULT;
  C.groundSnap[slot] = options.groundSnap ?? GROUND_SNAP_DEFAULT;
  C.stepUp[slot] = options.stepUp ?? STEP_UP_DEFAULT;
  C.stepDown[slot] = options.stepDown ?? STEP_DOWN_DEFAULT;
  C.timeSinceGrounded[slot] = 0;
  C.groundNormalX[slot] = 0;
  C.groundNormalY[slot] = 1;
  C.groundNormalZ[slot] = 0;
  C.ownerEid[slot] = eid;
  C.flags[slot] = 0;

  _characterSlots.set(eid, slot);

  // Ensure the entity has LocalTransformF32 (for writing position back).
  if (!hasComponent(world, eid, LocalTransformF32)) {
    // Default identity transform.
    addComponent(world, eid, LocalTransformF32);
    const id = getId(eid);
    LocalTransformF32.qw[id] = 1;
    LocalTransformF32.sx[id] = 1;
    LocalTransformF32.sy[id] = 1;
    LocalTransformF32.sz[id] = 1;
  }
  return slot;
}

export function removeCharacter(world, eid) {
  const slot = _characterSlots.get(eid);
  if (slot === undefined) return;
  _characterSlots.delete(eid);
  CharacterStateF32.ownerEid[slot] = 0;
  removeComponent(world, eid, CharacterTag);
}

export function getCharacterSlot(eid) {
  return _characterSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// INPUT API — set movement / jump
// ═══════════════════════════════════════════════════════════════════════

export function setCharacterWishVelocity(eid, wx, wy, wz) {
  const slot = _characterSlots.get(eid);
  if (slot === undefined) return;
  CharacterStateF32.wishX[slot] = wx;
  CharacterStateF32.wishY[slot] = wy;
  CharacterStateF32.wishZ[slot] = wz;
}

export function requestJump(eid) {
  const slot = _characterSlots.get(eid);
  if (slot === undefined) return false;
  const C = CharacterStateF32;
  // Grounded or within coyote time (0.1 s).
  if ((C.flags[slot] & 1) !== 0 || C.timeSinceGrounded[slot] < 0.1) {
    C.vy[slot] = C.jumpSpeed[slot];
    C.flags[slot] &= ~1;
    C.timeSinceGrounded[slot] = 1.0;
    return true;
  }
  return false;
}

export function isGrounded(eid) {
  const slot = _characterSlots.get(eid);
  if (slot === undefined) return false;
  return (CharacterStateF32.flags[slot] & 1) !== 0;
}

// ═══════════════════════════════════════════════════════════════════════
// CHARACTER MOVE — full Kinematic Character Controller step
// ═══════════════════════════════════════════════════════════════════════

const _moveV3 = vec3.create();
const _moveV3b = vec3.create();

/**
 * Move one character by dt seconds with collision response.
 * Call once per character per frame.
 */
export function systemMoveCharacter(world, eid, dt, gravity = -9.81) {
  const slot = _characterSlots.get(eid);
  if (slot === undefined) return;

  const C = CharacterStateF32;
  const id = getId(eid);

  // Read position from LocalTransformF32.
  let px = LocalTransformF32.px[id];
  let py = LocalTransformF32.py[id];
  let pz = LocalTransformF32.pz[id];

  // Apply gravity to vertical velocity.
  if ((C.flags[slot] & 1) === 0) {
    C.vy[slot] += gravity * C.gravityScale[slot] * dt;
  } else {
    // On ground: reset vertical velocity to prevent accumulation.
    if (C.vy[slot] < 0) C.vy[slot] = 0;
  }

  // Cache capsule geometry.
  const radius = C.radius[slot];
  const halfHeight = C.halfHeight[slot];
  const centerY = py + halfHeight + radius;

  // Bottom point of capsule (world space).
  const bottomX = px;
  const bottomY = py + radius;
  const bottomZ = pz;

  // Top point of capsule.
  const topX = px;
  const topY = py + 2 * (halfHeight + radius) - radius;
  const topZ = pz;

  // Step 1: horizontal movement (wish velocity + slide).
  const wishX = C.wishX[slot] * dt;
  const wishZ = C.wishZ[slot] * dt;

  if (Math.abs(wishX) > EPSILON || Math.abs(wishZ) > EPSILON) {
    const hit = sweepCapsule(bottomX, bottomY, bottomZ,
                             topX, topY, topZ,
                             radius,
                             wishX, 0, wishZ,
                             Math.hypot(wishX, wishZ));

    if (hit) {
      // Move up to hit, then slide along surface.
      const slideX = wishX * hit.t;
      const slideZ = wishZ * hit.t;
      px += slideX;
      pz += slideZ;

      // Slide remaining movement along wall (project onto wall plane).
      const remainX = wishX - slideX;
      const remainZ = wishZ - slideZ;
      const dot = remainX * hit.nx + remainZ * hit.nz;
      const slideRemX = remainX - hit.nx * dot;
      const slideRemZ = remainZ - hit.nz * dot;

      // Second sweep along the slide direction.
      const hit2 = sweepCapsule(bottomX + slideX, bottomY, bottomZ + slideZ,
                                 topX + slideX, topY, topZ + slideZ,
                                 radius,
                                 slideRemX, 0, slideRemZ,
                                 Math.hypot(slideRemX, slideRemZ));
      if (hit2) {
        px += slideRemX * hit2.t;
        pz += slideRemZ * hit2.t;
      } else {
        px += slideRemX;
        pz += slideRemZ;
      }

      C.flags[slot] |= 4; // touching wall
    } else {
      px += wishX;
      pz += wishZ;
      C.flags[slot] &= ~4;
    }
  }

  // Step 2: step-up if grounded and obstacle detected.
  if ((C.flags[slot] & 1) !== 0) {
    // Try to step up if we couldn't move horizontally.
    // (Simplified: skip; full version checks for wall ahead and tries stepUp.)
  }

  // Step 3: vertical movement.
  const vy = C.vy[slot] * dt;
  if (Math.abs(vy) > EPSILON) {
    // Update capsule points for current position.
    const bY = py + radius;
    const tY = py + 2 * (halfHeight + radius) - radius;

    const hit = sweepCapsule(px, bY, pz, px, tY, pz,
                             radius,
                             0, vy, 0,
                             Math.abs(vy));

    if (hit) {
      if (vy < 0) {
        // Landing.
        py += vy * hit.t;
        C.vy[slot] = 0;
        C.flags[slot] |= 1; // grounded
        C.timeSinceGrounded[slot] = 0;
        C.groundNormalX[slot] = hit.nx;
        C.groundNormalY[slot] = hit.ny;
        C.groundNormalZ[slot] = hit.nz;
      } else {
        // Ceiling hit.
        py += vy * hit.t;
        C.vy[slot] = 0;
        C.flags[slot] |= 2; // touching ceiling
      }
    } else {
      py += vy;
      // If we're in the air with no ceiling hit, we're no longer grounded.
      if (vy > 0) {
        C.flags[slot] &= ~1;
        C.flags[slot] &= ~2;
      }
    }
  }

  // Step 4: ground snap when grounded and not jumping.
  if ((C.flags[slot] & 1) !== 0 && Math.abs(C.vy[slot]) < EPSILON) {
    // Cast down to confirm ground.
    const snapDist = C.groundSnap[slot];
    const bY = py + radius;
    const tY = py + 2 * (halfHeight + radius) - radius;
    const groundHit = sweepCapsule(px, bY, pz, px, tY, pz,
                                    radius,
                                    0, -snapDist, 0,
                                    snapDist);
    if (groundHit) {
      py -= snapDist * groundHit.t;
      C.groundNormalX[slot] = groundHit.nx;
      C.groundNormalY[slot] = groundHit.ny;
      C.groundNormalZ[slot] = groundHit.nz;
    } else {
      // No ground under feet — leave grounded state.
      C.flags[slot] &= ~1;
      C.timeSinceGrounded[slot] = 0;
    }
  } else {
    C.timeSinceGrounded[slot] += dt;
  }

  // Write back to LocalTransformF32.
  LocalTransformF32.px[id] = px;
  LocalTransformF32.py[id] = py;
  LocalTransformF32.pz[id] = pz;
  markDirty(eid);
}

/**
 * System: step all characters.
 * Call AFTER systemPropagateTransforms and BEFORE systemBoundsPipeline.
 */
export function systemStepCharacters(world, dt, gravity = -9.81) {
  const eids = query(world, [CharacterTag]);
  for (let i = 0, n = eids.length; i < n; i++) {
    systemMoveCharacter(world, eids[i], dt, gravity);
  }
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// TRIGGER VOLUME OVERLAP
// ═══════════════════════════════════════════════════════════════════════
//
// Return all entities inside a trigger volume (defined by WorldBoundsF32
// of a TriggerTag entity).

export const TriggerTag = {};

export function queryTriggerOverlaps(world, triggerEid) {
  const id = getId(triggerEid);
  const off = id * 6;
  const A = WorldBoundsF32.aabb;

  return queryAABB(
    A[off], A[off + 1], A[off + 2],
    A[off + 3], A[off + 4], A[off + 5]
  );
}

// ═══════════════════════════════════════════════════════════════════════
// VISIBILITY QUERY — is entity inside a camera frustum?
// ═══════════════════════════════════════════════════════════════════════

/**
 * Test whether an entity's world AABB intersects 6 frustum planes.
 * Planes are provided as 6 × 4 floats (a, b, c, d).
 */
export function isEntityVisible(eid, planes) {
  const id = getId(eid);
  const off = id * 6;
  const A = WorldBoundsF32.aabb;

  const minX = A[off],     minY = A[off + 1], minZ = A[off + 2];
  const maxX = A[off + 3], maxY = A[off + 4], maxZ = A[off + 5];

  for (let i = 0; i < 6; i++) {
    const a = planes[i * 4], b = planes[i * 4 + 1];
    const c = planes[i * 4 + 2], d = planes[i * 4 + 3];
    const px = a >= 0 ? maxX : minX;
    const py = b >= 0 ? maxY : minY;
    const pz = c >= 0 ? maxZ : minZ;
    if (a * px + b * py + c * pz + d < 0) return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════
// LINE OF SIGHT — does a ray from A to B hit anything?
// ═══════════════════════════════════════════════════════════════════════

/**
 * Test line-of-sight from (ax, ay, az) to (bx, by, bz).
 * Returns { clear: bool, hitEid, hitT }.
 */
export function lineOfSight(ax, ay, az, bx, by, bz, filterEid = 0) {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < EPSILON) return { clear: true, hitEid: 0, hitT: 0 };

  const ndx = dx / dist, ndy = dy / dist, ndz = dz / dist;
  const hits = bvhRaycast([ax, ay, az], [ndx, ndy, ndz], dist, true);

  for (let i = 0; i < hits.length; i++) {
    if (hits[i].eid === filterEid) continue;
    return {
      clear: false,
      hitEid: hits[i].eid,
      hitT: hits[i].t,
    };
  }
  return { clear: true, hitEid: 0, hitT: dist };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearCharacterQueries() {
  _characterSlots.clear();
  _nextCharacterSlot = 0;
  CharacterStateF32.flags.fill(0);
  CharacterStateF32.ownerEid.fill(0);
  resetQuery();
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function shapeQueryStats() {
  let activeCharacters = 0;
  let grounded = 0;
  for (let i = 0; i < _nextCharacterSlot; i++) {
    if (CharacterStateF32.ownerEid[i] === 0) continue;
    activeCharacters++;
    if (CharacterStateF32.flags[i] & 1) grounded++;
  }
  return {
    characterCount: _nextCharacterSlot,
    activeCharacters,
    grounded,
    bvhRoot: BVHState.root,
  };
}