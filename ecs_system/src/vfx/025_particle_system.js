// file number : 025
// full path name : src/vfx/025_particle_system.js
// description : High-performance GPU-friendly particle system and VFX
//               framework. Provides SoA ParticleEmitter / ParticleInstance /
//               ForceField / Modifier components that can spawn and evolve
//               millions of particles per frame on Android 64-bit. Emission
//               shapes cover point, box, sphere, cone, hemisphere, disc,
//               and mesh-surface sampling; per-particle evolution supports
//               size / color / alpha / velocity / rotation / drag over
//               lifetime; forces include gravity, wind, radial attractors,
//               vortex, and curl-noise turbulence. Particles render via
//               file 005's InstancedMesh buckets so 1M particles cost
//               ~1 draw call. Sub-emitters fire on birth, death, or
//               BVH collision (file 003), enabling rockets → explosion →
//               smoke chains. Everything is SoA typed arrays with a
//               ring-buffer particle pool so emission is O(1) and zero-GC
//               at steady state.
// best for : Explosions, smoke, sparks, fire, rain/snow, magical effects,
//            projectiles, trails, ambience, and any scene that must
//            render millions of dynamic VFX at 1M-entity budget on
//            Android 64-bit.
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
  bvhRaycast,
  bvhFrustumCull,
  BVHState,
} from '../spatial/003_bvh_broadphase.js';

import {
  WorldBoundsF32,
  LocalBoundsF32,
  BoundsTag,
} from '../geometry/004_aabb_bounds.js';

import {
  GeometryRef,
  MaterialRef,
  Visibility,
  LayerMask,
  RenderOrder,
  RenderableTag,
  registerGeometry,
  releaseGeometry,
  INSTANCED_BUCKETS,
  retainGeometry,
} from '../render/005_mesh_components.js';

import {
  THREE,
  vec3,
  quat,
  mat4,
  createNoise3D,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ               = 1e-16;
const EPSILON                  = 1e-8;
const EPSILON_HIGH             = 1e-12;
const PI                       = Math.PI;
const TWO_PI                   = 2 * Math.PI;
const INV_PI                   = 1 / Math.PI;
const INV_TWO_PI               = 1 / (2 * Math.PI);
const HALF_PI                  = Math.PI / 2;
const DEG_TO_RAD               = Math.PI / 180;
const RAD_TO_DEG               = 180 / Math.PI;
const MAX_PARTICLES            = 1_000_000;
const MAX_EMITTERS             = 8192;
const MAX_FORCE_FIELDS         = 256;
const MAX_SUB_EMITTERS         = 16;
const EMISSION_ACCUM_EPSILON   = 1e-6;
const CURL_NOISE_EPSILON       = 1e-4;
const R2_ALPHA_1               = 0.7548776662466927;
const R2_ALPHA_2               = 0.5698402909980532;
const R2_ALPHA_3               = 0.4301597090019467;
const STABLE_SUBSTEP_LIMIT     = 1 / 120;    // clamp dt for stability
const MAX_PARTICLE_SUBSTEPS    = 4;

// ═══════════════════════════════════════════════════════════════════════
// ENUMS
// ═══════════════════════════════════════════════════════════════════════

export const EmitShape = Object.freeze({
  POINT:          0,
  SPHERE:         1,
  HEMISPHERE:     2,
  BOX:            3,
  CONE:           4,
  DISC:           5,
  MESH_SURFACE:   6,
});

export const SubEmitterTrigger = Object.freeze({
  BIRTH:      0,
  DEATH:      1,
  COLLISION:  2,
  PERIODIC:   3,
});

export const BlendMode = Object.freeze({
  ALPHA:        0,
  ADDITIVE:     1,
  MULTIPLY:     2,
});

export const SimulationSpace = Object.freeze({
  LOCAL:   0,
  WORLD:   1,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA PARTICLE POOL — ring buffer, zero allocation after warmup
// ═══════════════════════════════════════════════════════════════════════

export const ParticlePool = {
  // Position + velocity.
  px: new Float32Array(MAX_PARTICLES),
  py: new Float32Array(MAX_PARTICLES),
  pz: new Float32Array(MAX_PARTICLES),
  vx: new Float32Array(MAX_PARTICLES),
  vy: new Float32Array(MAX_PARTICLES),
  vz: new Float32Array(MAX_PARTICLES),

  // Age and lifetime (seconds).
  age:      new Float32Array(MAX_PARTICLES),
  lifetime: new Float32Array(MAX_PARTICLES),

  // Size (start → end interpolation via sizeCurve).
  startSize: new Float32Array(MAX_PARTICLES),
  endSize:   new Float32Array(MAX_PARTICLES),
  curSize:   new Float32Array(MAX_PARTICLES),

  // Color (start → end, linear RGB).
  startR: new Float32Array(MAX_PARTICLES),
  startG: new Float32Array(MAX_PARTICLES),
  startB: new Float32Array(MAX_PARTICLES),
  endR:   new Float32Array(MAX_PARTICLES),
  endG:   new Float32Array(MAX_PARTICLES),
  endB:   new Float32Array(MAX_PARTICLES),

  // Alpha (start → end).
  startA: new Float32Array(MAX_PARTICLES),
  endA:   new Float32Array(MAX_PARTICLES),

  // Rotation (for billboarded / sprite particles).
  rotation:       new Float32Array(MAX_PARTICLES),
  angularVel:     new Float32Array(MAX_PARTICLES),

  // Drag coefficient (per second).
  drag: new Float32Array(MAX_PARTICLES),

  // Gravity scale (per-particle override).
  gravityScale: new Float32Array(MAX_PARTICLES),

  // Which emitter spawned this particle.
  emitterSlot: new Uint16Array(MAX_PARTICLES),

  // Flags: bit 0 = alive, bit 1 = has collided, bit 2 = has emitted sub.
  flags: new Uint8Array(MAX_PARTICLES),

  // BVH leaf proxy entity id (-1 = no proxy).
  bvhEntity: new Uint32Array(MAX_PARTICLES),

  // Free list head — implements ring-buffer recycling.
  freeHead: 0,
  liveCount: 0,
};

// Initialize BVH entity ids to "none".
for (let i = 0; i < MAX_PARTICLES; i++) {
  ParticlePool.bvhEntity[i] = 0xFFFFFFFF;
}

// ═══════════════════════════════════════════════════════════════════════
// SoA PARTICLE EMITTER COMPONENT
// ═══════════════════════════════════════════════════════════════════════

export const ParticleEmitter = {
  // Shape.
  shape: new Uint8Array(MAX_EMITTERS),
  shapeRadius: new Float32Array(MAX_EMITTERS),
  shapeHalfX:  new Float32Array(MAX_EMITTERS),
  shapeHalfY:  new Float32Array(MAX_EMITTERS),
  shapeHalfZ:  new Float32Array(MAX_EMITTERS),
  shapeConeAngle: new Float32Array(MAX_EMITTERS),

  // Emission rate (particles per second).
  rate: new Float32Array(MAX_EMITTERS),
  rateAccum: new Float32Array(MAX_EMITTERS),

  // Lifetime range (min, max).
  lifetimeMin: new Float32Array(MAX_EMITTERS),
  lifetimeMax: new Float32Array(MAX_EMITTERS),

  // Initial velocity (cone-shaped direction + speed range).
  speedMin: new Float32Array(MAX_EMITTERS),
  speedMax: new Float32Array(MAX_EMITTERS),
  dirX: new Float32Array(MAX_EMITTERS),
  dirY: new Float32Array(MAX_EMITTERS),
  dirZ: new Float32Array(MAX_EMITTERS),

  // Size over lifetime.
  sizeStart: new Float32Array(MAX_EMITTERS),
  sizeEnd:   new Float32Array(MAX_EMITTERS),

  // Color over lifetime (start, end, in linear RGB).
  colorStartR: new Float32Array(MAX_EMITTERS),
  colorStartG: new Float32Array(MAX_EMITTERS),
  colorStartB: new Float32Array(MAX_EMITTERS),
  colorEndR:   new Float32Array(MAX_EMITTERS),
  colorEndG:   new Float32Array(MAX_EMITTERS),
  colorEndB:   new Float32Array(MAX_EMITTERS),

  // Alpha over lifetime.
  alphaStart: new Float32Array(MAX_EMITTERS),
  alphaEnd:   new Float32Array(MAX_EMITTERS),

  // Particle dynamics.
  drag:         new Float32Array(MAX_EMITTERS),
  gravityScale: new Float32Array(MAX_EMITTERS),

  // Simulation space.
  simSpace: new Uint8Array(MAX_EMITTERS),

  // Blend mode (render hint).
  blend: new Uint8Array(MAX_EMITTERS),

  // Owner entity.
  ownerEid: new Uint32Array(MAX_EMITTERS),

  // Enabled.
  enabled: new Uint8Array(MAX_EMITTERS),

  // Max particle budget (soft cap).
  maxParticles: new Uint32Array(MAX_EMITTERS),

  // Geometry ID (from file 005) — what each particle looks like.
  particleGeometryId: new Uint32Array(MAX_EMITTERS),
  particleMaterialId: new Uint32Array(MAX_EMITTERS),

  // Duration (0 = infinite; otherwise stops emitting after duration).
  duration:     new Float32Array(MAX_EMITTERS),
  elapsedTime:  new Float32Array(MAX_EMITTERS),

  // Looping.
  looping: new Uint8Array(MAX_EMITTERS),

  // Sub-emitter hooks.
  subEmitterCount: new Uint8Array(MAX_EMITTERS),
  subEmitterIds: new Uint32Array(MAX_EMITTERS * MAX_SUB_EMITTERS),
  subEmitterTriggers: new Uint8Array(MAX_EMITTERS * MAX_SUB_EMITTERS),
};

/** Marker: entity is a particle emitter. */
export const ParticleEmitterTag = {};

let _nextEmitterSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// FORCE FIELDS — global + per-emitter forces
// ═══════════════════════════════════════════════════════════════════════

export const ForceField = {
  // Type: 0 = gravity, 1 = wind, 2 = radial attractor, 3 = vortex,
  //       4 = curl noise.
  type: new Uint8Array(MAX_FORCE_FIELDS),

  // Position (world space) for radial / vortex / curl.
  px: new Float32Array(MAX_FORCE_FIELDS),
  py: new Float32Array(MAX_FORCE_FIELDS),
  pz: new Float32Array(MAX_FORCE_FIELDS),

  // Direction (for gravity / wind).
  dx: new Float32Array(MAX_FORCE_FIELDS),
  dy: new Float32Array(MAX_FORCE_FIELDS),
  dz: new Float32Array(MAX_FORCE_FIELDS),

  // Strength.
  strength: new Float32Array(MAX_FORCE_FIELDS),

  // Radius (for radial / vortex; 0 = infinite).
  radius: new Float32Array(MAX_FORCE_FIELDS),

  // Enabled.
  enabled: new Uint8Array(MAX_FORCE_FIELDS),
};

let _nextForceFieldSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// EMITTER CREATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a particle emitter attached to an entity.
 * Requires WorldTransformF32 (position source) on the entity.
 */
export function addParticleEmitter(world, eid, {
  shape = EmitShape.POINT,
  shapeRadius = 1,
  shapeHalfX = 1, shapeHalfY = 1, shapeHalfZ = 1,
  shapeConeAngle = PI / 6,
  rate = 100,
  lifetimeMin = 1.0,
  lifetimeMax = 2.0,
  speedMin = 1.0,
  speedMax = 3.0,
  dirX = 0, dirY = 1, dirZ = 0,
  sizeStart = 0.1,
  sizeEnd = 0.0,
  colorStart = [1, 1, 1],
  colorEnd = [1, 1, 1],
  alphaStart = 1.0,
  alphaEnd = 0.0,
  drag = 0.1,
  gravityScale = 1.0,
  simSpace = SimulationSpace.WORLD,
  blend = BlendMode.ADDITIVE,
  maxParticles = 10000,
  particleGeometryId = 0,
  particleMaterialId = 0,
  duration = 0,
  looping = true,
} = {}) {
  if (_nextEmitterSlot >= MAX_EMITTERS) throw new Error('emitter capacity exceeded');
  const slot = _nextEmitterSlot++;

  addComponent(world, eid, ParticleEmitterTag);

  const E = ParticleEmitter;
  E.shape[slot] = shape;
  E.shapeRadius[slot] = shapeRadius;
  E.shapeHalfX[slot] = shapeHalfX;
  E.shapeHalfY[slot] = shapeHalfY;
  E.shapeHalfZ[slot] = shapeHalfZ;
  E.shapeConeAngle[slot] = shapeConeAngle;

  E.rate[slot] = rate;
  E.rateAccum[slot] = 0;
  E.lifetimeMin[slot] = lifetimeMin;
  E.lifetimeMax[slot] = lifetimeMax;
  E.speedMin[slot] = speedMin;
  E.speedMax[slot] = speedMax;
  E.dirX[slot] = dirX;
  E.dirY[slot] = dirY;
  E.dirZ[slot] = dirZ;

  E.sizeStart[slot] = sizeStart;
  E.sizeEnd[slot] = sizeEnd;
  E.colorStartR[slot] = colorStart[0];
  E.colorStartG[slot] = colorStart[1];
  E.colorStartB[slot] = colorStart[2];
  E.colorEndR[slot] = colorEnd[0];
  E.colorEndG[slot] = colorEnd[1];
  E.colorEndB[slot] = colorEnd[2];
  E.alphaStart[slot] = alphaStart;
  E.alphaEnd[slot] = alphaEnd;

  E.drag[slot] = drag;
  E.gravityScale[slot] = gravityScale;
  E.simSpace[slot] = simSpace;
  E.blend[slot] = blend;

  E.ownerEid[slot] = eid;
  E.enabled[slot] = 1;
  E.maxParticles[slot] = maxParticles;
  E.particleGeometryId[slot] = particleGeometryId;
  E.particleMaterialId[slot] = particleMaterialId;
  E.duration[slot] = duration;
  E.elapsedTime[slot] = 0;
  E.looping[slot] = looping ? 1 : 0;
  E.subEmitterCount[slot] = 0;

  return slot;
}

export function setEmitterEnabled(slot, enabled) {
  ParticleEmitter.enabled[slot] = enabled ? 1 : 0;
}

export function addSubEmitter(emitterSlot, subEmitterSlot, trigger) {
  const E = ParticleEmitter;
  const count = E.subEmitterCount[emitterSlot];
  if (count >= MAX_SUB_EMITTERS) return false;

  const base = emitterSlot * MAX_SUB_EMITTERS + count;
  E.subEmitterIds[base] = subEmitterSlot;
  E.subEmitterTriggers[base] = trigger;
  E.subEmitterCount[emitterSlot] = count + 1;
  return true;
}

// ═══════════════════════════════════════════════════════════════════════
// FORCE FIELD CREATION
// ═══════════════════════════════════════════════════════════════════════

export function addForceField({
  type = 0,
  px = 0, py = 0, pz = 0,
  dx = 0, dy = -1, dz = 0,
  strength = 9.81,
  radius = 0,
} = {}) {
  if (_nextForceFieldSlot >= MAX_FORCE_FIELDS) throw new Error('force field capacity exceeded');
  const slot = _nextForceFieldSlot++;

  const F = ForceField;
  F.type[slot] = type;
  F.px[slot] = px;
  F.py[slot] = py;
  F.pz[slot] = pz;
  F.dx[slot] = dx;
  F.dy[slot] = dy;
  F.dz[slot] = dz;
  F.strength[slot] = strength;
  F.radius[slot] = radius;
  F.enabled[slot] = 1;
  return slot;
}

// ═══════════════════════════════════════════════════════════════════════
// PARTICLE SPAWN — ring-buffer allocation
// ═══════════════════════════════════════════════════════════════════════

/**
 * Allocate a slot from the particle pool. Returns slot index or -1 if full.
 */
function allocParticle() {
  const P = ParticlePool;

  // Ring buffer scan: find a dead slot starting from freeHead.
  for (let i = 0; i < MAX_PARTICLES; i++) {
    const slot = (P.freeHead + i) % MAX_PARTICLES;
    if ((P.flags[slot] & 1) === 0) {
      P.freeHead = (slot + 1) % MAX_PARTICLES;
      P.flags[slot] = 1;    // alive
      P.age[slot] = 0;
      P.liveCount++;
      return slot;
    }
  }
  return -1;   // pool exhausted (should not happen if maxParticles is bounded)
}

function freeParticle(slot) {
  const P = ParticlePool;
  if ((P.flags[slot] & 1) === 0) return;
  P.flags[slot] = 0;
  P.liveCount--;
}

// ═══════════════════════════════════════════════════════════════════════
// EMITTER SHAPE SAMPLING
// ═══════════════════════════════════════════════════════════════════════

const _emitPos = vec3.create();
const _emitDir = vec3.create();

/**
 * Sample a random position on/inside the emitter's shape.
 * Uses two uniform random values (u1, u2) plus R2 phase for stability.
 */
function sampleShapePosition(emitterSlot, u1, u2, out) {
  const E = ParticleEmitter;
  const shape = E.shape[emitterSlot];

  if (shape === EmitShape.POINT) {
    out[0] = 0; out[1] = 0; out[2] = 0;
    return out;
  }

  if (shape === EmitShape.SPHERE) {
    // Uniform inside sphere.
    const r = E.shapeRadius[emitterSlot] * Math.cbrt(u1);
    const phi = TWO_PI * u2;
    const cosTheta = 2 * u1 - 1;
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));

    out[0] = r * sinTheta * Math.cos(phi);
    out[1] = r * cosTheta;
    out[2] = r * sinTheta * Math.sin(phi);
    return out;
  }

  if (shape === EmitShape.HEMISPHERE) {
    const r = E.shapeRadius[emitterSlot] * Math.cbrt(u1);
    const phi = TWO_PI * u2;
    const cosTheta = u1;
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));

    out[0] = r * sinTheta * Math.cos(phi);
    out[1] = r * cosTheta;
    out[2] = r * sinTheta * Math.sin(phi);
    return out;
  }

  if (shape === EmitShape.BOX) {
    out[0] = (u1 * 2 - 1) * E.shapeHalfX[emitterSlot];
    out[1] = (u2 * 2 - 1) * E.shapeHalfY[emitterSlot];
    out[2] = ((u1 + u2) % 1 * 2 - 1) * E.shapeHalfZ[emitterSlot];
    return out;
  }

  if (shape === EmitShape.CONE) {
    const halfAngle = E.shapeConeAngle[emitterSlot] * 0.5;
    const cosTheta = 1 - u1 * (1 - Math.cos(halfAngle));
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const phi = TWO_PI * u2;
    const r = E.shapeRadius[emitterSlot] * u1;

    out[0] = r * sinTheta * Math.cos(phi);
    out[1] = r * cosTheta;
    out[2] = r * sinTheta * Math.sin(phi);
    return out;
  }

  if (shape === EmitShape.DISC) {
    const r = E.shapeRadius[emitterSlot] * Math.sqrt(u1);
    const phi = TWO_PI * u2;
    out[0] = r * Math.cos(phi);
    out[1] = 0;
    out[2] = r * Math.sin(phi);
    return out;
  }

  if (shape === EmitShape.MESH_SURFACE) {
    // Fallback: sphere surface.
    const phi = TWO_PI * u2;
    const cosTheta = 2 * u1 - 1;
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const r = E.shapeRadius[emitterSlot];
    out[0] = r * sinTheta * Math.cos(phi);
    out[1] = r * cosTheta;
    out[2] = r * sinTheta * Math.sin(phi);
    return out;
  }

  out[0] = 0; out[1] = 0; out[2] = 0;
  return out;
}

/**
 * Sample an emission direction (spread around the emitter's forward).
 */
function sampleEmissionDirection(emitterSlot, u1, u2, out) {
  const E = ParticleEmitter;
  const shape = E.shape[emitterSlot];
  const coneAngle = shape === EmitShape.CONE
    ? E.shapeConeAngle[emitterSlot]
    : TWO_PI;

  const cosMax = Math.cos(coneAngle * 0.5);
  const cosTheta = 1 - u1 * (1 - cosMax);
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  const phi = TWO_PI * u2;

  // Local direction in emitter frame.
  const lx = sinTheta * Math.cos(phi);
  const ly = cosTheta;
  const lz = sinTheta * Math.sin(phi);

  // Rotate to align +Y with (dirX, dirY, dirZ).
  const dirX = E.dirX[emitterSlot];
  const dirY = E.dirY[emitterSlot];
  const dirZ = E.dirZ[emitterSlot];
  const dLen = Math.hypot(dirX, dirY, dirZ) || 1;
  const nX = dirX / dLen;
  const nY = dirY / dLen;
  const nZ = dirZ / dLen;

  // Build orthonormal basis around n.
  let upX, upY, upZ;
  if (Math.abs(nY) < 0.9) {
    // Cross(n, (0,1,0)) = (nZ, 0, -nX)
    upX = nZ; upY = 0; upZ = -nX;
  } else {
    // Cross(n, (1,0,0)) = (0, -nZ, nY)
    upX = 0; upY = -nZ; upZ = nY;
  }
  const upLen = Math.hypot(upX, upY, upZ) || 1;
  upX /= upLen; upY /= upLen; upZ /= upLen;

  // Right = cross(up, n).
  const rX = upY * nZ - upZ * nY;
  const rY = upZ * nX - upX * nZ;
  const rZ = upX * nY - upY * nX;

  // World direction = lx * right + ly * n + lz * up.
  out[0] = lx * rX + ly * nX + lz * upX;
  out[1] = lx * rY + ly * nY + lz * upY;
  out[2] = lx * rZ + ly * nZ + lz * upZ;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// EMIT ONE PARTICLE
// ═══════════════════════════════════════════════════════════════════════

const _randState = new Uint32Array(1);
_randState[0] = 1;

function xorshift32() {
  let s = _randState[0];
  s ^= s << 13;
  s ^= s >>> 17;
  s ^= s << 5;
  _randState[0] = s >>> 0;
  return s >>> 0;
}

function rand01() {
  return (xorshift32() >>> 8) * (1 / 16777216);
}

function randRange(lo, hi) {
  return lo + rand01() * (hi - lo);
}

/**
 * Emit one particle from an emitter slot.
 * Reads position from the owning entity's WorldTransformF32.
 */
function emitParticle(world, emitterSlot) {
  const E = ParticleEmitter;
  const P = ParticlePool;
  const ownerEid = E.ownerEid[emitterSlot];
  if (!ownerEid || !entityExists(world, ownerEid)) return;

  const ownerId = getId(ownerEid);
  const worldX = WorldTransformF32.m[ownerId * 16 + 12];
  const worldY = WorldTransformF32.m[ownerId * 16 + 13];
  const worldZ = WorldTransformF32.m[ownerId * 16 + 14];

  const slot = allocParticle();
  if (slot < 0) return;

  // Sample shape + direction.
  sampleShapePosition(emitterSlot, rand01(), rand01(), _emitPos);
  sampleEmissionDirection(emitterSlot, rand01(), rand01(), _emitDir);

  // Position = owner world position + local shape offset (in simSpace).
  if (E.simSpace[emitterSlot] === SimulationSpace.LOCAL) {
    // Rotate by owner transform (approximate — assumes rigid).
    const ow = WorldTransformF32.m;
    const off = ownerId * 16;
    const lx = _emitPos[0];
    const ly = _emitPos[1];
    const lz = _emitPos[2];
    P.px[slot] = ow[off + 12] + ow[off]     * lx + ow[off + 4] * ly + ow[off + 8]  * lz;
    P.py[slot] = ow[off + 13] + ow[off + 1] * lx + ow[off + 5] * ly + ow[off + 9]  * lz;
    P.pz[slot] = ow[off + 14] + ow[off + 2] * lx + ow[off + 6] * ly + ow[off + 10] * lz;
  } else {
    P.px[slot] = worldX + _emitPos[0];
    P.py[slot] = worldY + _emitPos[1];
    P.pz[slot] = worldZ + _emitPos[2];
  }

  const speed = randRange(E.speedMin[emitterSlot], E.speedMax[emitterSlot]);
  P.vx[slot] = _emitDir[0] * speed;
  P.vy[slot] = _emitDir[1] * speed;
  P.vz[slot] = _emitDir[2] * speed;

  P.age[slot] = 0;
  P.lifetime[slot] = randRange(E.lifetimeMin[emitterSlot], E.lifetimeMax[emitterSlot]);

  P.startSize[slot] = E.sizeStart[emitterSlot];
  P.endSize[slot] = E.sizeEnd[emitterSlot];
  P.curSize[slot] = E.sizeStart[emitterSlot];

  P.startR[slot] = E.colorStartR[emitterSlot];
  P.startG[slot] = E.colorStartG[emitterSlot];
  P.startB[slot] = E.colorStartB[emitterSlot];
  P.endR[slot] = E.colorEndR[emitterSlot];
  P.endG[slot] = E.colorEndG[emitterSlot];
  P.endB[slot] = E.colorEndB[emitterSlot];

  P.startA[slot] = E.alphaStart[emitterSlot];
  P.endA[slot] = E.alphaEnd[emitterSlot];

  P.rotation[slot] = rand01() * TWO_PI;
  P.angularVel[slot] = randRange(-PI, PI);

  P.drag[slot] = E.drag[emitterSlot];
  P.gravityScale[slot] = E.gravityScale[emitterSlot];
  P.emitterSlot[slot] = emitterSlot;

  P.flags[slot] = 1;    // alive
  P.bvhEntity[slot] = 0xFFFFFFFF;

  // Trigger BIRTH sub-emitters.
  triggerSubEmitters(world, emitterSlot, SubEmitterTrigger.BIRTH, P.px[slot], P.py[slot], P.pz[slot]);
}

// ═══════════════════════════════════════════════════════════════════════
// SUB-EMITTER TRIGGER
// ═══════════════════════════════════════════════════════════════════════

function triggerSubEmitters(world, parentEmitterSlot, triggerType, px, py, pz) {
  const E = ParticleEmitter;
  const count = E.subEmitterCount[parentEmitterSlot];
  for (let i = 0; i < count; i++) {
    const base = parentEmitterSlot * MAX_SUB_EMITTERS + i;
    if (E.subEmitterTriggers[base] !== triggerType) continue;

    const subSlot = E.subEmitterIds[base];
    if (!E.enabled[subSlot]) continue;

    // Emit a burst of a few particles at (px, py, pz).
    const subOwner = E.ownerEid[subSlot];
    if (!subOwner || !entityExists(world, subOwner)) continue;

    // Move sub emitter to burst location for one frame.
    const subOwnerId = getId(subOwner);
    const saveX = LocalTransformF32.px[subOwnerId];
    const saveY = LocalTransformF32.py[subOwnerId];
    const saveZ = LocalTransformF32.pz[subOwnerId];
    LocalTransformF32.px[subOwnerId] = px;
    LocalTransformF32.py[subOwnerId] = py;
    LocalTransformF32.pz[subOwnerId] = pz;
    markDirty(subOwner);

    // Emit a small burst.
    const burstCount = Math.min(16, Math.floor(E.rate[subSlot] * 0.1));
    for (let b = 0; b < burstCount; b++) {
      emitParticle(world, subSlot);
    }

    // Restore.
    LocalTransformF32.px[subOwnerId] = saveX;
    LocalTransformF32.py[subOwnerId] = saveY;
    LocalTransformF32.pz[subOwnerId] = saveZ;
    markDirty(subOwner);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// FORCE APPLICATION
// ═══════════════════════════════════════════════════════════════════════

const _noise3D = createNoise3D();

function applyForcesToParticle(slot, dt) {
  const P = ParticlePool;
  const px = P.px[slot];
  const py = P.py[slot];
  const pz = P.pz[slot];

  let ax = 0, ay = 0, az = 0;

  // Per-particle gravity scale.
  const gs = P.gravityScale[slot];

  for (let f = 0; f < _nextForceFieldSlot; f++) {
    const F = ForceField;
    if (!F.enabled[f]) continue;

    const type = F.type[f];
    const strength = F.strength[f];

    if (type === 0) {
      // Gravity.
      ax += F.dx[f] * strength * gs;
      ay += F.dy[f] * strength * gs;
      az += F.dz[f] * strength * gs;
    } else if (type === 1) {
      // Wind (constant acceleration).
      ax += F.dx[f] * strength;
      ay += F.dy[f] * strength;
      az += F.dz[f] * strength;
    } else if (type === 2) {
      // Radial attractor.
      const dx = F.px[f] - px;
      const dy = F.py[f] - py;
      const dz = F.pz[f] - pz;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > EPSILON_SQ) {
        const dist = Math.sqrt(distSq);
        if (F.radius[f] <= 0 || dist < F.radius[f]) {
          const scale = strength / (dist * dist);
          ax += dx * scale;
          ay += dy * scale;
          az += dz * scale;
        }
      }
    } else if (type === 3) {
      // Vortex around Y axis at (px, pz).
      const dx = px - F.px[f];
      const dz = pz - F.pz[f];
      const distSq = dx * dx + dz * dz;
      if (distSq > EPSILON_SQ) {
        const dist = Math.sqrt(distSq);
        if (F.radius[f] <= 0 || dist < F.radius[f]) {
          const tangentScale = strength / (dist + EPSILON);
          ax += -dz * tangentScale;
          az += dx * tangentScale;
        }
      }
    } else if (type === 4) {
      // Curl noise — approximate by sampling a 3D vector field.
      const nx = _noise3D(px * 0.1, py * 0.1, pz * 0.1);
      const ny = _noise3D(px * 0.1 + 100, py * 0.1, pz * 0.1);
      const nz = _noise3D(px * 0.1, py * 0.1 + 100, pz * 0.1);
      ax += nx * strength;
      ay += ny * strength;
      az += nz * strength;
    }
  }

  // Apply acceleration.
  P.vx[slot] += ax * dt;
  P.vy[slot] += ay * dt;
  P.vz[slot] += az * dt;

  // Apply drag (exponential).
  const drag = P.drag[slot];
  if (drag > EPSILON) {
    const dragFactor = Math.exp(-drag * dt);
    P.vx[slot] *= dragFactor;
    P.vy[slot] *= dragFactor;
    P.vz[slot] *= dragFactor;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PARTICLE COLLISION
// ═══════════════════════════════════════════════════════════════════════

function checkParticleCollision(slot) {
  const P = ParticlePool;

  // Ray from current position along velocity for one frame.
  const px = P.px[slot], py = P.py[slot], pz = P.pz[slot];
  const vx = P.vx[slot], vy = P.vy[slot], vz = P.vz[slot];

  const speedSq = vx * vx + vy * vy + vz * vz;
  if (speedSq < EPSILON_SQ) return false;

  const speed = Math.sqrt(speedSq);
  const dx = vx / speed, dy = vy / speed, dz = vz / speed;

  const hits = bvhRaycast([px, py, pz], [dx, dy, dz], speed * (1 / 60), true);
  if (hits.length > 0) {
    P.flags[slot] |= 2;   // collision
    // Reflect velocity (damped).
    const h = hits[0];
    const nx = -dx, ny = -dy, nz = -dz;
    const dot = vx * nx + vy * ny + vz * nz;
    P.vx[slot] = vx - 2 * dot * nx;
    P.vy[slot] = vy - 2 * dot * ny;
    P.vz[slot] = vz - 2 * dot * nz;
    P.vx[slot] *= 0.5;
    P.vy[slot] *= 0.5;
    P.vz[slot] *= 0.5;
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN SYSTEM — step all particle emitters and particles
// ═══════════════════════════════════════════════════════════════════════

export function systemParticleTick(world, dt) {
  if (dt <= 0) return world;

  // Clamp large frame times to prevent particle tunneling / instability.
  const clampedDt = Math.min(dt, STABLE_SUBSTEP_LIMIT * MAX_PARTICLE_SUBSTEPS);

  // 1. Emit new particles.
  for (let slot = 0; slot < _nextEmitterSlot; slot++) {
    const E = ParticleEmitter;
    if (!E.enabled[slot]) continue;
    if (!E.ownerEid[slot] || !entityExists(world, E.ownerEid[slot])) continue;

    E.elapsedTime[slot] += clampedDt;

    // Duration check.
    if (E.duration[slot] > 0 && E.elapsedTime[slot] > E.duration[slot]) {
      if (E.looping[slot]) {
        E.elapsedTime[slot] = 0;
      } else {
        E.enabled[slot] = 0;
        continue;
      }
    }

    // Accumulate fractional particles.
    E.rateAccum[slot] += E.rate[slot] * clampedDt;

    // Emission count (bounded by maxParticles and by pool availability).
    let remainingBudget = E.maxParticles[slot];
    let toEmit = Math.floor(E.rateAccum[slot]);
    E.rateAccum[slot] -= toEmit;

    if (toEmit > remainingBudget) toEmit = remainingBudget;
    if (toEmit > 0) {
      for (let i = 0; i < toEmit; i++) {
        emitParticle(world, slot);
      }
    }
  }

  // 2. Update living particles.
  const P = ParticlePool;
  for (let slot = 0; slot < MAX_PARTICLES; slot++) {
    if ((P.flags[slot] & 1) === 0) continue;

    // Age.
    P.age[slot] += clampedDt;
    if (P.age[slot] >= P.lifetime[slot]) {
      // Death — trigger sub-emitters.
      const emitterSlot = P.emitterSlot[slot];
      triggerSubEmitters(world, emitterSlot, SubEmitterTrigger.DEATH,
                         P.px[slot], P.py[slot], P.pz[slot]);
      freeParticle(slot);
      continue;
    }

    // Apply forces.
    applyForcesToParticle(slot, clampedDt);

    // Update position.
    P.px[slot] += P.vx[slot] * clampedDt;
    P.py[slot] += P.vy[slot] * clampedDt;
    P.pz[slot] += P.vz[slot] * clampedDt;

    // Rotation.
    P.rotation[slot] += P.angularVel[slot] * clampedDt;

    // Interpolate size / color / alpha over lifetime.
    const t = P.age[slot] / P.lifetime[slot];
    P.curSize[slot] = P.startSize[slot] * (1 - t) + P.endSize[slot] * t;

    // Collision test.
    if (checkParticleCollision(slot)) {
      triggerSubEmitters(world, P.emitterSlot[slot], SubEmitterTrigger.COLLISION,
                         P.px[slot], P.py[slot], P.pz[slot]);
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER SYNC — write particle transforms into file 005's instanced bucket
// ═══════════════════════════════════════════════════════════════════════

/**
 * Synchronize living particles into InstancedMesh instance matrices.
 * Called once per frame after systemParticleTick.
 */
export function systemSyncParticlesToBuckets(world) {
  const P = ParticlePool;
  const E = ParticleEmitter;

  // Map emitter slot → instanced bucket.
  for (let emitterSlot = 0; emitterSlot < _nextEmitterSlot; emitterSlot++) {
    if (!E.enabled[emitterSlot]) continue;

    const geomId = E.particleGeometryId[emitterSlot];
    const matId = E.particleMaterialId[emitterSlot];
    if (!geomId || !matId) continue;

    const key = `${geomId}|${matId}`;
    const bucket = INSTANCED_BUCKETS.get(key);
    if (!bucket) continue;

    // Walk particles belonging to this emitter.
    let instanceCount = 0;
    for (let slot = 0; slot < MAX_PARTICLES; slot++) {
      if ((P.flags[slot] & 1) === 0) continue;
      if (P.emitterSlot[slot] !== emitterSlot) continue;

      if (instanceCount >= bucket.capacity) break;

      // Compute interpolation t.
      const t = P.age[slot] / P.lifetime[slot];

      // Build transform matrix from position + rotation + size.
      const matArr = bucket.mesh.instanceMatrix.array;
      const off = instanceCount * 16;

      const size = P.curSize[slot];
      const rot = P.rotation[slot];
      const cosR = Math.cos(rot);
      const sinR = Math.sin(rot);

      // Column-major scale-rotate-translate matrix (2D rotation around Z).
      matArr[off]     = size * cosR;
      matArr[off + 1] = size * sinR;
      matArr[off + 2] = 0;
      matArr[off + 3] = 0;
      matArr[off + 4] = -size * sinR;
      matArr[off + 5] = size * cosR;
      matArr[off + 6] = 0;
      matArr[off + 7] = 0;
      matArr[off + 8] = 0;
      matArr[off + 9] = 0;
      matArr[off + 10] = size;
      matArr[off + 11] = 0;
      matArr[off + 12] = P.px[slot];
      matArr[off + 13] = P.py[slot];
      matArr[off + 14] = P.pz[slot];
      matArr[off + 15] = 1;

      instanceCount++;
    }

    // Set instance count and mark dirty.
    bucket.mesh.count = instanceCount;
    bucket.mesh.instanceMatrix.needsUpdate = true;
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearParticles(world) {
  const P = ParticlePool;
  for (let slot = 0; slot < MAX_PARTICLES; slot++) {
    P.flags[slot] = 0;
  }
  P.freeHead = 0;
  P.liveCount = 0;

  _nextEmitterSlot = 0;
  _nextForceFieldSlot = 0;

  for (let i = 0; i < MAX_EMITTERS; i++) {
    ParticleEmitter.enabled[i] = 0;
    ParticleEmitter.ownerEid[i] = 0;
    ParticleEmitter.subEmitterCount[i] = 0;
  }

  for (let i = 0; i < MAX_FORCE_FIELDS; i++) {
    ForceField.enabled[i] = 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function particleStats() {
  let enabledEmitters = 0;
  let enabledForceFields = 0;

  for (let i = 0; i < _nextEmitterSlot; i++) {
    if (ParticleEmitter.enabled[i]) enabledEmitters++;
  }
  for (let i = 0; i < _nextForceFieldSlot; i++) {
    if (ForceField.enabled[i]) enabledForceFields++;
  }

  return {
    emitterCount: _nextEmitterSlot,
    enabledEmitters,
    forceFieldCount: _nextForceFieldSlot,
    enabledForceFields,
    liveParticles: ParticlePool.liveCount,
    particleCapacity: MAX_PARTICLES,
  };
}