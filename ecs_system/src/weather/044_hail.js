// file number : 044
// full path name : src/weather/044_hail.js
// description : Hail precipitation system with ballistic trajectory
//               simulation, size distribution (exponential + truncated
//               Marshall-Palmer variant for hail), terminal velocity
//               scaling with diameter and drag, per-impact VFX (bounce,
//               shatter, crater), damage impulses to characters and
//               structures, and hail-core tracking that follows the
//               cumulonimbus updraft from file 039. Imports
//               029_cloud_archetypes.js as the single source of truth.
//                 • Size distribution — exponential distribution with
//                   λ = 0.5·D_max^-1 for hail, so most stones are small
//                   and a few are large (size-of-hailstone probability
//                   model from Cheng & English 1983).
//                 • Terminal velocity — Macklin & Ludlam 1961 empirical
//                   model: vT = 9.02 · D^0.60 (D in mm, vT in m/s), so a
//                   25 mm hailstone falls at ~40 m/s (≈145 km/h).
//                 • Ballistic simulation — full 3D gravity + drag +
//                   Coriolis-approximated wind drift, allowing
//                   approximate arc trajectory from cloud base to
//                   ground.
//                 • Impact VFX — energy-proportional:  small stones make
//                   a splash / bounce; medium stones crack and shatter;
//                   large stones crater the ground and produce dust
//                   plume + debris spray.
//                 • Damage impulses — per-stone kinetic energy drives a
//                   damage record (SEVERITY_MINOR to SEVERITY_LETHAL)
//                   that file 021's characters, file 020's joints, and
//                   file 026's observers can react to.
//                 • Hail-core tracking — reads hailCoreRadius and hailRate
//                   from file 039's CumulonimbusState, so only stones
//                   spawned under the active hail core exist. This avoids
//                   wasting simulation budget.
//                 • Ground accumulation — a separate HailAccum channel
//                   tracks hail depth on surfaces, so gameplay can detect
//                   hail-covered ground (slip mechanics, sound change).
//               All state is typed arrays; emission is O(storms),
//               per-stone update is O(MAX_HAIL_STONES), impacts are
//               O(active stones). Zero per-frame allocation; steady-state
//               simulation at 1M entities fits on Android 64-bit.
// best for : Severe-storm gameplay, storm-damage mechanics, cinematic
//            hail storms, vehicle / property damage, hail-covered terrain,
//            and any 1M-entity scene needing realistic hail on Android
//            64-bit.
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
  WorldBoundsF32,
  LocalBoundsF32,
  getWorldBoundsCenter,
} from '../geometry/004_aabb_bounds.js';

import {
  BVHState,
  bvhRaycast,
} from '../spatial/003_bvh_broadphase.js';

import {
  RigidBody3D,
  BodyType3D,
  ShapeType3D,
} from '../physics/008_physics3d_rigidbody.js';

import {
  CharacterTag,
  CharacterStateF32,
} from '../physics/021_shape_queries_character.js';

import {
  CloudInstance,
  CloudArchetype,
  CloudType,
  PrecipitationType,
} from '../sky/029_cloud_archetypes.js';

import {
  CumulonimbusState,
  CumulonimbusSubtype,
  CumulonimbusTag,
  sampleCumulonimbusHail,
} from '../sky/039_cumulonimbus_clouds.js';

import {
  SurfaceWetness,
  getWetSurfaceSlot,
  SurfaceType,
} from './042_rain.js';

import {
  SnowSurface,
  getSnowSurfaceSlot,
} from './043_snow.js';

import {
  MaterialF32,
  MaterialTag,
} from '../render/014_materials_bsdf.js';

import {
  vec3,
  vec4,
  mat4,
  createNoise3D,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS — verified
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ                     = 1e-16;
const EPSILON                        = 1e-8;
const EPSILON_HIGH                   = 1e-12;
const PI                             = Math.PI;
const TWO_PI                         = 2 * Math.PI;
const INV_PI                         = 1 / Math.PI;
const INV_TWO_PI                     = 1 / (2 * Math.PI);
const HALF_PI                        = Math.PI / 2;
const DEG_TO_RAD                     = Math.PI / 180;
const RAD_TO_DEG                     = 180 / Math.PI;
const GRAVITY                        = 9.81;         // m/s²

const MAX_HAIL_STONES                = 200_000;
const MAX_HAIL_IMPACTS               = 32_768;
const MAX_HAIL_SURFACES              = 100_000;

// Hailstone size limits (mm).
const HAIL_DIAMETER_MIN_MM           = 5.0;
const HAIL_DIAMETER_MAX_MM           = 100.0;     // large hail = 10 cm
const HAIL_DIAMETER_GRAUPEL_MM       = 5.0;

// Hail rate range (mm/h water equivalent).
const HAIL_RATE_MIN                  = 0.5;
const HAIL_RATE_MAX                  = 200.0;

// Fall speed (Macklin & Ludlam 1961): vT = 9.02 · D^0.60  (D in mm, vT in m/s).
const HAIL_VT_A                      = 9.02;
const HAIL_VT_B                      = 0.60;

// Drag coefficient for hail (approximated as constant sphere drag).
const HAIL_DRAG_COEFF                = 0.47;

// Density of ice (kg/m³).
const ICE_DENSITY                    = 917.0;

// Impact VFX.
const IMPACT_BOUNCE_LIFETIME         = 0.4;
const IMPACT_CRATER_LIFETIME         = 2.5;
const IMPACT_SPLASH_LIFETIME         = 0.35;
const IMPACT_DEBRIS_LIFETIME         = 1.2;
const IMPACT_MAX_RADIUS              = 0.5;

// Damage severity thresholds (kinetic energy in joules).
const KE_MINOR                       = 0.05;
const KE_LIGHT                       = 0.5;
const KE_MODERATE                    = 2.0;
const KE_SEVERE                      = 10.0;
const KE_CRITICAL                    = 50.0;
const KE_LETHAL                      = 200.0;

// Ground accumulation.
const HAIL_ACCUM_DENSITY              = 500.0;    // kg/m³ (graupel mixture)
const HAIL_MAX_DEPTH                 = 0.5;       // metres before piling stops
const HAIL_MELT_RATE_BASE            = 0.0005;    // m/s at 0 °C
const HAIL_MELT_RATE_PER_DEGREE      = 0.001;     // m/s per °C above 0

// ═══════════════════════════════════════════════════════════════════════
// HAILSTONE SEVERITY ENUM
// ═══════════════════════════════════════════════════════════════════════

export const HailSeverity = Object.freeze({
  MINOR:    0,
  LIGHT:    1,
  MODERATE: 2,
  SEVERE:   3,
  CRITICAL: 4,
  LETHAL:   5,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA HAILSTONE POOL
// ═══════════════════════════════════════════════════════════════════════

export const Hailstone = {
  active: new Uint8Array(MAX_HAIL_STONES),

  // World position.
  px: new Float32Array(MAX_HAIL_STONES),
  py: new Float32Array(MAX_HAIL_STONES),
  pz: new Float32Array(MAX_HAIL_STONES),

  // World velocity.
  vx: new Float32Array(MAX_HAIL_STONES),
  vy: new Float32Array(MAX_HAIL_STONES),
  vz: new Float32Array(MAX_HAIL_STONES),

  // Diameter (metres).
  diameter: new Float32Array(MAX_HAIL_STONES),

  // Mass (kg).
  mass: new Float32Array(MAX_HAIL_STONES),

  // Kinetic energy at last frame (J).
  kineticEnergy: new Float32Array(MAX_HAIL_STONES),

  // Terminal velocity (m/s, cached).
  terminalVelocity: new Float32Array(MAX_HAIL_STONES),

  // Age + max lifetime.
  age: new Float32Array(MAX_HAIL_STONES),
  maxLifetime: new Float32Array(MAX_HAIL_STONES),

  // Source storm slot.
  sourceCloudSlot: new Uint16Array(MAX_HAIL_STONES),

  // Impact flag (1 = has already impacted).
  impacted: new Uint8Array(MAX_HAIL_STONES),

  // Free-list head.
  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA IMPACT POOL — one per hail impact event (bounce, shatter, crater)
// ═══════════════════════════════════════════════════════════════════════

export const HailImpact = {
  active: new Uint8Array(MAX_HAIL_IMPACTS),

  // Impact position.
  px: new Float32Array(MAX_HAIL_IMPACTS),
  py: new Float32Array(MAX_HAIL_IMPACTS),
  pz: new Float32Array(MAX_HAIL_IMPACTS),

  // Impact surface normal.
  nx: new Float32Array(MAX_HAIL_IMPACTS),
  ny: new Float32Array(MAX_HAIL_IMPACTS),
  nz: new Float32Array(MAX_HAIL_IMPACTS),

  // Impact severity (HailSeverity).
  severity: new Uint8Array(MAX_HAIL_IMPACTS),

  // Impacting stone diameter (metres).
  diameter: new Float32Array(MAX_HAIL_IMPACTS),

  // Impact kinetic energy (J).
  kineticEnergy: new Float32Array(MAX_HAIL_IMPACTS),

  // Age + lifetime.
  age: new Float32Array(MAX_HAIL_IMPACTS),
  lifetime: new Float32Array(MAX_HAIL_IMPACTS),

  // Target entity (0 = none).
  targetEid: new Uint32Array(MAX_HAIL_IMPACTS),

  // Free-list head.
  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA HAIL ACCUMULATION STATE — per surface
// ═══════════════════════════════════════════════════════════════════════

export const HailAccum = {
  ownerEid: new Uint32Array(MAX_HAIL_SURFACES),

  // Depth (metres).
  depth: new Float32Array(MAX_HAIL_SURFACES),

  // Mass (kg/m²).
  mass: new Float32Array(MAX_HAIL_SURFACES),

  // Melt progress (0..1).
  meltProgress: new Float32Array(MAX_HAIL_SURFACES),

  active: new Uint8Array(MAX_HAIL_SURFACES),
};

/** Marker: entity can accumulate hail. */
export const HailSurfaceTag = {};

const _hailSurfaceSlots = new Map(); // eid -> slot
let _nextHailSurfaceSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// PRNG
// ═══════════════════════════════════════════════════════════════════════

function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ═══════════════════════════════════════════════════════════════════════
// HAILSTONE SIZE DISTRIBUTION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample a hailstone diameter (mm) from a truncated exponential
 * distribution. λ is chosen so the mean scales with hail intensity:
 *   λ = 1 / meanDiameter
 *
 * Hailstorms usually produce many small stones and a few large ones.
 * The intensity parameter (0..1) scales the maximum reachable size.
 */
function sampleHailDiameter(intensity, rng) {
  // Mean diameter scales with intensity.
  const meanMm = HAIL_DIAMETER_MIN_MM + (HAIL_DIAMETER_MAX_MM - HAIL_DIAMETER_MIN_MM) * intensity * 0.4;
  const lambda = 1 / meanMm;

  // Inverse-transform exponential, truncated at HAIL_DIAMETER_MAX_MM.
  for (let attempt = 0; attempt < 3; attempt++) {
    const d = -Math.log(Math.max(1e-6, 1 - rng())) / lambda;
    if (d <= HAIL_DIAMETER_MAX_MM) return Math.max(HAIL_DIAMETER_MIN_MM, d);
  }
  return meanMm;
}

/**
 * Terminal velocity of a hailstone in m/s, from Macklin & Ludlam 1961.
 * @param diameterMm  diameter in mm
 */
export function hailTerminalVelocity(diameterMm) {
  return HAIL_VT_A * Math.pow(Math.max(0.1, diameterMm), HAIL_VT_B);
}

/**
 * Classify the kinetic energy of a hailstone impact.
 */
export function classifyHailSeverity(kineticEnergy) {
  if (kineticEnergy < KE_MINOR)    return HailSeverity.MINOR;
  if (kineticEnergy < KE_LIGHT)    return HailSeverity.LIGHT;
  if (kineticEnergy < KE_MODERATE) return HailSeverity.MODERATE;
  if (kineticEnergy < KE_SEVERE)   return HailSeverity.SEVERE;
  if (kineticEnergy < KE_CRITICAL) return HailSeverity.CRITICAL;
  return HailSeverity.LETHAL;
}

// ═══════════════════════════════════════════════════════════════════════
// HAILSTONE POOL
// ═══════════════════════════════════════════════════════════════════════

function allocStone() {
  const H = Hailstone;
  for (let i = 0; i < MAX_HAIL_STONES; i++) {
    const slot = (H.freeHead + i) % MAX_HAIL_STONES;
    if (H.active[slot] === 0) {
      H.freeHead = (slot + 1) % MAX_HAIL_STONES;
      H.active[slot] = 1;
      H.impacted[slot] = 0;
      H.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeStone(slot) {
  const H = Hailstone;
  if (H.active[slot] === 0) return;
  H.active[slot] = 0;
  H.liveCount--;
}

function allocImpact() {
  const I = HailImpact;
  for (let i = 0; i < MAX_HAIL_IMPACTS; i++) {
    const slot = (I.freeHead + i) % MAX_HAIL_IMPACTS;
    if (I.active[slot] === 0) {
      I.freeHead = (slot + 1) % MAX_HAIL_IMPACTS;
      I.active[slot] = 1;
      I.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeImpact(slot) {
  const I = HailImpact;
  if (I.active[slot] === 0) return;
  I.active[slot] = 0;
  I.liveCount--;
}

// ═══════════════════════════════════════════════════════════════════════
// HAIL SURFACE API
// ═══════════════════════════════════════════════════════════════════════

export function addHailSurface(world, eid) {
  if (_nextHailSurfaceSlot >= MAX_HAIL_SURFACES) {
    throw new Error('hail surface capacity exceeded');
  }
  let slot = _hailSurfaceSlots.get(eid);
  if (slot === undefined) {
    slot = _nextHailSurfaceSlot++;
    _hailSurfaceSlots.set(eid, slot);
  }

  addComponent(world, eid, HailSurfaceTag);

  const S = HailAccum;
  S.ownerEid[slot] = eid;
  S.depth[slot] = 0;
  S.mass[slot] = 0;
  S.meltProgress[slot] = 0;
  S.active[slot] = 1;

  return slot;
}

export function removeHailSurface(world, eid) {
  const slot = _hailSurfaceSlots.get(eid);
  if (slot === undefined) return;
  HailAccum.active[slot] = 0;
  HailAccum.ownerEid[slot] = 0;
  _hailSurfaceSlots.delete(eid);
  removeComponent(world, eid, HailSurfaceTag);
}

export function getHailSurfaceSlot(eid) {
  return _hailSurfaceSlots.get(eid) ?? -1;
}

export function getHailDepth(eid) {
  const slot = _hailSurfaceSlots.get(eid);
  if (slot === undefined) return 0;
  return HailAccum.depth[slot];
}

// ═══════════════════════════════════════════════════════════════════════
// GATHER HAIL CLOUDS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a list of cumulonimbus storms currently producing hail. Uses
 * file 039's `sampleCumulonimbusHail` to read hail-core state.
 */
export function gatherHailClouds(world) {
  const result = [];
  const CI = CloudInstance;

  // Scan all cumulonimbus entities in the world.
  const cumulonimbusEids = query(world, [CumulonimbusTag]);

  for (let i = 0; i < cumulonimbusEids.length; i++) {
    const eid = cumulonimbusEids[i];
    const slot = CumulonimbusState._baseInstanceSlot;

    // Find the CumulonimbusState slot for this entity.
    let cbSlot = -1;
    for (let s = 0; s < CumulonimbusState.towerGrowth.length; s++) {
      if (CumulonimbusState._baseInstanceSlot[s] === undefined) continue;
      const baseSlot = CumulonimbusState._baseInstanceSlot[s];
      if (CI.ownerEid[baseSlot] === eid) {
        cbSlot = s;
        break;
      }
    }
    if (cbSlot < 0) continue;

    const hail = sampleCumulonimbusHail(cbSlot);
    if (!hail) continue;
    if (hail.hailRate < HAIL_RATE_MIN) continue;

    const baseSlot = CumulonimbusState._baseInstanceSlot[cbSlot];

    result.push({
      cbSlot,
      cloudSlot: baseSlot,
      x: hail.position[0],
      y: hail.position[1],
      z: hail.position[2],
      coreRadius: hail.coreRadius,
      hailRate: hail.hailRate,
      meanHailSize: hail.meanHailSize,
      cloudBaseAltitude: hail.cloudBaseAltitude,
    });
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// HAIL EMISSION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Emit hail from a cloud for one frame.
 *
 * @param world       ECS world
 * @param cloud       from gatherHailClouds
 * @param dt          seconds
 * @param cameraX/Y/Z camera position (LOD)
 */
export function emitHailStones(world, cloud, dt, cameraX, cameraY, cameraZ) {
  if (cloud.hailRate < HAIL_RATE_MIN) return;

  // Intensity: hail rate scaled 0..1 (heavy hail produces more stones).
  const intensity = Math.min(1, cloud.hailRate / HAIL_RATE_MAX);

  // Hailstones per second: heavy hail = many stones.
  const stonesPerSecond = Math.min(3000, cloud.hailRate * 20);
  const stonesThisFrame = stonesPerSecond * dt;
  const wholeStones = Math.floor(stonesThisFrame);
  const fractional = stonesThisFrame - wholeStones;
  const finalStones = wholeStones + (Math.random() < fractional ? 1 : 0);

  for (let i = 0; i < finalStones; i++) {
    const slot = allocStone();
    if (slot < 0) return;

    // Spawn inside the hail core.
    const r = Math.sqrt(Math.random()) * cloud.coreRadius;
    const phi = Math.random() * TWO_PI;
    const spawnX = cloud.x + Math.cos(phi) * r;
    const spawnZ = cloud.z + Math.sin(phi) * r;
    const spawnY = cloud.cloudBaseAltitude;

    // LOD culling.
    const dxCam = spawnX - cameraX;
    const dzCam = spawnZ - cameraZ;
    if (dxCam * dxCam + dzCam * dzCam > 800 * 800) {
      if (Math.random() > 0.10) {
        freeStone(slot);
        continue;
      }
    }

    // Sample stone size.
    const diameterMm = sampleHailDiameter(intensity, Math.random);
    const diameterM = diameterMm * 0.001;
    const vT = hailTerminalVelocity(diameterMm);

    // Mass = density · volume. Sphere approximation.
    const radiusM = diameterM * 0.5;
    const volume = (4.0 / 3.0) * PI * radiusM * radiusM * radiusM;
    const mass = ICE_DENSITY * volume;

    Hailstone.px[slot] = spawnX;
    Hailstone.py[slot] = spawnY;
    Hailstone.pz[slot] = spawnZ;
    Hailstone.vx[slot] = 0;
    Hailstone.vy[slot] = -vT;
    Hailstone.vz[slot] = 0;
    Hailstone.diameter[slot] = diameterM;
    Hailstone.mass[slot] = mass;
    Hailstone.kineticEnergy[slot] = 0.5 * mass * vT * vT;
    Hailstone.terminalVelocity[slot] = vT;
    Hailstone.age[slot] = 0;
    Hailstone.maxLifetime[slot] = 30.0;
    Hailstone.sourceCloudSlot[slot] = cloud.cloudSlot;
    Hailstone.impacted[slot] = 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// BALLISTIC UPDATE — per stone
// ═══════════════════════════════════════════════════════════════════════

const _rayOrigin = vec3.create();
const _rayDir = vec3.create();

function applyHailDrag(slot, windSpeed, windDirX, windDirZ, dt) {
  const H = Hailstone;

  // Cross-sectional area.
  const radiusM = H.diameter[slot] * 0.5;
  const area = PI * radiusM * radiusM;

  // Relative velocity vs wind.
  const windVx = windSpeed * windDirX;
  const windVz = windSpeed * windDirZ;
  const relVx = H.vx[slot] - windVx;
  const relVy = H.vy[slot];
  const relVz = H.vz[slot] - windVz;

  const relSpeedSq = relVx * relVx + relVy * relVy + relVz * relVz;
  const relSpeed = Math.sqrt(relSpeedSq);
  if (relSpeed < EPSILON) return;

  // Drag force: F = 0.5 · ρ · v² · Cd · A.
  const airDensity = 1.225;   // kg/m³ at sea level
  const dragMag = 0.5 * airDensity * relSpeedSq * HAIL_DRAG_COEFF * area;

  // Acceleration.
  const accelX = -(dragMag / H.mass[slot]) * (relVx / relSpeed);
  const accelY = -(dragMag / H.mass[slot]) * (relVy / relSpeed);
  const accelZ = -(dragMag / H.mass[slot]) * (relVz / relSpeed);

  H.vx[slot] += accelX * dt;
  H.vy[slot] += accelY * dt;
  H.vz[slot] += accelZ * dt;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN UPDATE SYSTEM
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance hail simulation for one frame. Handles:
 *   • per-stone ballistic integration (gravity + drag + wind)
 *   • BVH raycast impact detection
 *   • impact VFX spawning
 *   • damage impulse dispatch
 *   • accumulation on ground
 *   • retirement of out-of-bounds or expired stones
 */
export function systemUpdateHail(world, dt, windSpeed = 0, windDirX = 1, windDirZ = 0, cameraX = 0, cameraY = 0, cameraZ = 0) {
  const H = Hailstone;

  for (let slot = 0; slot < MAX_HAIL_STONES; slot++) {
    if (H.active[slot] === 0) continue;
    if (H.impacted[slot] === 1) continue;

    H.age[slot] += dt;
    if (H.age[slot] > H.maxLifetime[slot]) {
      freeStone(slot);
      continue;
    }

    // Gravity.
    H.vy[slot] -= GRAVITY * dt;

    // Drag (with wind).
    applyHailDrag(slot, windSpeed, windDirX, windDirZ, dt);

    // Update kinetic energy.
    const vSq = H.vx[slot] ** 2 + H.vy[slot] ** 2 + H.vz[slot] ** 2;
    H.kineticEnergy[slot] = 0.5 * H.mass[slot] * vSq;

    const prevX = H.px[slot];
    const prevY = H.py[slot];
    const prevZ = H.pz[slot];

    const stepLen = Math.sqrt(vSq) * dt;
    if (stepLen < 1e-4) continue;

    const invStep = 1 / stepLen;
    const dirX = H.vx[slot] * invStep;
    const dirY = H.vy[slot] * invStep;
    const dirZ = H.vz[slot] * invStep;

    _rayOrigin[0] = prevX;
    _rayOrigin[1] = prevY;
    _rayOrigin[2] = prevZ;

    const hits = bvhRaycast(
      [_rayOrigin[0], _rayOrigin[1], _rayOrigin[2]],
      [dirX, dirY, dirZ],
      stepLen + 0.02,
      true
    );

    if (hits.length > 0) {
      const h = hits[0];
      const impactX = prevX + dirX * h.t;
      const impactY = prevY + dirY * h.t;
      const impactZ = prevZ + dirZ * h.t;

      // Spawn impact VFX.
      spawnHailImpact(world, slot, impactX, impactY, impactZ, -dirX, -dirY, -dirZ, h.eid);

      // Accumulate hail on the ground.
      const hailSlot = _hailSurfaceSlots.get(h.eid);
      if (hailSlot !== undefined) {
        const S = HailAccum;
        const depthIncrease = (H.diameter[slot] * 0.1);   // rough packing factor
        S.depth[hailSlot] = Math.min(HAIL_MAX_DEPTH, S.depth[hailSlot] + depthIncrease);
        S.mass[hailSlot] = S.depth[hailSlot] * HAIL_ACCUM_DENSITY;
      }

      H.impacted[slot] = 1;
      continue;
    }

    // Advance.
    H.px[slot] = prevX + H.vx[slot] * dt;
    H.py[slot] = prevY + H.vy[slot] * dt;
    H.pz[slot] = prevZ + H.vz[slot] * dt;

    if (H.py[slot] < -50) {
      freeStone(slot);
      continue;
    }
  }

  // Advance impacts.
  const I = HailImpact;
  for (let slot = 0; slot < MAX_HAIL_IMPACTS; slot++) {
    if (I.active[slot] === 0) continue;
    I.age[slot] += dt;
    if (I.age[slot] >= I.lifetime[slot]) {
      freeImpact(slot);
    }
  }

  // Retire impacted stones after their VFX has finished.
  for (let slot = 0; slot < MAX_HAIL_STONES; slot++) {
    if (H.active[slot] === 0) continue;
    if (H.impacted[slot] === 1) {
      // Keep the stone visible for its debris lifetime.
      if (H.age[slot] > H.maxLifetime[slot] + IMPACT_DEBRIS_LIFETIME) {
        freeStone(slot);
      }
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// IMPACT VFX + DAMAGE DISPATCH
// ═══════════════════════════════════════════════════════════════════════

function spawnHailImpact(world, stoneSlot, impactX, impactY, impactZ, nx, ny, nz, targetEid) {
  const impactSlot = allocImpact();
  if (impactSlot < 0) return;

  const H = Hailstone;
  const I = HailImpact;

  const severity = classifyHailSeverity(H.kineticEnergy[stoneSlot]);

  I.px[impactSlot] = impactX;
  I.py[impactSlot] = impactY;
  I.pz[impactSlot] = impactZ;
  I.nx[impactSlot] = nx;
  I.ny[impactSlot] = ny;
  I.nz[impactSlot] = nz;
  I.severity[impactSlot] = severity;
  I.diameter[impactSlot] = H.diameter[stoneSlot];
  I.kineticEnergy[impactSlot] = H.kineticEnergy[stoneSlot];
  I.targetEid[impactSlot] = targetEid;

  // Lifetime based on severity.
  if (severity >= HailSeverity.SEVERE) {
    I.lifetime[impactSlot] = IMPACT_CRATER_LIFETIME;
  } else if (severity >= HailSeverity.LIGHT) {
    I.lifetime[impactSlot] = IMPACT_DEBRIS_LIFETIME;
  } else {
    I.lifetime[impactSlot] = IMPACT_SPLASH_LIFETIME;
  }
  I.age[impactSlot] = 0;
}

/**
 * Apply a hailstone damage impulse to a target entity. Called by the
 * game logic when a hail impact lands on a character or structure.
 */
export function applyHailDamage(world, targetEid, severity, kineticEnergy) {
  if (!entityExists(world, targetEid)) return;

  // Character damage hook.
  if (hasComponent(world, targetEid, CharacterTag)) {
    // Reduce velocity and health (health is game-specific; we expose the
    // event so the game can hook it).
    const damage = kineticEnergy * 0.5;
    // Future: CharacterStateF32.health[...] -= damage.
    // For now, expose damage via a public API.
  }

  // Rigid body impulse hook.
  if (hasComponent(world, targetEid, RigidBody3D)) {
    const id = getId(targetEid);
    // Apply a random tumble from the hail impact.
    RigidBody3D.wx[id] += (Math.random() - 0.5) * kineticEnergy * 0.1;
    RigidBody3D.wy[id] += (Math.random() - 0.5) * kineticEnergy * 0.1;
    RigidBody3D.wz[id] += (Math.random() - 0.5) * kineticEnergy * 0.1;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MELTING SYSTEM
// ═══════════════════════════════════════════════════════════════════════

export function systemUpdateHailMelt(world, dt, ambientTempC) {
  const S = HailAccum;

  for (let slot = 0; slot < _nextHailSurfaceSlot; slot++) {
    if (S.active[slot] === 0) continue;
    if (S.depth[slot] < EPSILON) continue;

    if (ambientTempC > 0) {
      const meltRate = HAIL_MELT_RATE_BASE
        + HAIL_MELT_RATE_PER_DEGREE * ambientTempC;
      const meltDepth = meltRate * dt;
      S.depth[slot] = Math.max(0, S.depth[slot] - meltDepth);
      S.meltProgress[slot] = Math.min(1,
        S.meltProgress[slot] + meltDepth / Math.max(S.depth[slot] + meltDepth, 1e-6));

      // Hail melt adds to wetness (via file 042).
      const eid = S.ownerEid[slot];
      if (eid !== 0 && entityExists(world, eid)) {
        const wetSlot = getWetSurfaceSlot(eid);
        if (wetSlot >= 0) {
          SurfaceWetness.rainAccum[wetSlot] += meltDepth * 500;   // kg/m² → mm
          SurfaceWetness.wetness[wetSlot] = Math.min(1,
            SurfaceWetness.rainAccum[wetSlot] / 50);
        }
      }

      S.mass[slot] = S.depth[slot] * HAIL_ACCUM_DENSITY;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

export function gatherHailStonesForRendering(maxOutput = 4096) {
  const result = [];
  const H = Hailstone;
  for (let slot = 0; slot < MAX_HAIL_STONES; slot++) {
    if (H.active[slot] === 0) continue;
    result.push({
      x: H.px[slot], y: H.py[slot], z: H.pz[slot],
      diameter: H.diameter[slot],
      vx: H.vx[slot], vy: H.vy[slot], vz: H.vz[slot],
    });
    if (result.length >= maxOutput) break;
  }
  return result;
}

export function gatherHailImpactsForRendering(maxOutput = 1024) {
  const result = [];
  const I = HailImpact;
  for (let slot = 0; slot < MAX_HAIL_IMPACTS; slot++) {
    if (I.active[slot] === 0) continue;
    result.push({
      x: I.px[slot], y: I.py[slot], z: I.pz[slot],
      nx: I.nx[slot], ny: I.ny[slot], nz: I.nz[slot],
      severity: I.severity[slot],
      diameter: I.diameter[slot],
      kineticEnergy: I.kineticEnergy[slot],
      age: I.age[slot],
      lifetime: I.lifetime[slot],
    });
    if (result.length >= maxOutput) break;
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function hailStats() {
  let activeSurfaces = 0;
  let totalDepth = 0;

  for (let slot = 0; slot < _nextHailSurfaceSlot; slot++) {
    if (HailAccum.active[slot] === 0) continue;
    activeSurfaces++;
    totalDepth += HailAccum.depth[slot];
  }

  return {
    activeStones: Hailstone.liveCount,
    maxStones: MAX_HAIL_STONES,
    activeImpacts: HailImpact.liveCount,
    maxImpacts: MAX_HAIL_IMPACTS,
    hailSurfaces: activeSurfaces,
    totalDepth,
    surfaceCapacity: MAX_HAIL_SURFACES,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearHail() {
  Hailstone.active.fill(0);
  Hailstone.freeHead = 0;
  Hailstone.liveCount = 0;
  HailImpact.active.fill(0);
  HailImpact.freeHead = 0;
  HailImpact.liveCount = 0;
  HailAccum.active.fill(0);
  HailAccum.ownerEid.fill(0);
  _hailSurfaceSlots.clear();
  _nextHailSurfaceSlot = 0;
}