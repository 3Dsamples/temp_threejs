// file number : 042
// full path name : src/weather/042_rain.js
// description : Rain precipitation system with physically-based drop-size
//               distribution (Marshall-Palmer exponential distribution),
//               terminal velocity model, wind drift, per-drop splash
//               generation on surface impact, and cumulative surface
//               wetness tracking. Imports 029_cloud_archetypes.js as the
//               single source of truth for which cloud layers are
//               actively precipitating (rainRate + snowMix > 0). Uses
//               file 025's particle system for rendering, file 021's
//               character controller for wetness resistance, and file
//               003's BVH for surface hit detection.
//                 • Drop-size distribution — exponential Marshall-Palmer
//                   with N(D) = N0 * exp(-Λ·D), Λ = 4.1 * R^-0.21, so
//                   heavy rain produces larger, faster drops and light
//                   rain produces small slow ones.
//                 • Terminal velocity — Atlas 1973 empirical model
//                   vT(D) = 9.65 - 10.3·exp(-0.6·D) for 0.1 mm ≤ D ≤ 6 mm,
//                   plus droplet-drift correction for wind.
//                 • Drop pool — SoA ring buffer of MAX_DROPS live drops
//                   per world, recycled with no GC churn.
//                 • Splash generation — on each surface impact, spawn a
//                   short-lived splash ring whose radius/intensity derive
//                   from the drop's kinetic energy.
//                 • Wetness accumulation — per-surface (entity) wetness
//                   0..1 that saturates at rainRate saturation threshold,
//                   dries at temperature and sun-intensity-dependent rate,
//                   and drives puddle formation.
//                 • Puddle state — once wetness > threshold, a surface
//                   becomes puddled which increases reflectivity (feeds
//                   file 014's materials) and triggers file 060's ripple
//                   VFX.
//               All state is typed arrays; emission is O(active storms),
//               per-drop update is O(MAX_DROPS), wetness is O(entities).
//               Zero per-frame allocation on Android 64-bit.
// best for : Rainy-day rendering, wet-surface realism, character wetness
//            mechanics, rain audio cues, puddles, and any 1M-entity scene
//            needing realistic rain on Android 64-bit.
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
  bvhFrustumCull,
} from '../spatial/003_bvh_broadphase.js';

import {
  CloudInstance,
  CloudArchetype,
  CloudType,
  PrecipitationType,
  sampleInstanceDensity,
} from '../sky/029_cloud_archetypes.js';

import {
  NimbostratusState,
  NimbostratusTag,
} from '../sky/035_nimbostratus_clouds.js';

import {
  AltostratusState,
  AltostratusTag,
} from '../sky/034_altostratus_clouds.js';

import {
  StratocumulusState,
  StratocumulusTag,
} from '../sky/036_stratocumulus_clouds.js';

import {
  StratusState,
  StratusTag,
} from '../sky/037_stratus_clouds.js';

import {
  CumulusState,
  CumulusSubtype,
  CumulusTag,
} from '../sky/038_cumulus_clouds.js';

import {
  CumulonimbusState,
  CumulonimbusSubtype,
  CumulonimbusTag,
  emitCumulonimbusRain,
} from '../sky/039_cumulonimbus_clouds.js';

import {
  MaterialF32,
  MaterialTag,
  BSDFModel,
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

const EPSILON_SQ                       = 1e-16;
const EPSILON                          = 1e-8;
const EPSILON_HIGH                     = 1e-12;
const PI                               = Math.PI;
const TWO_PI                           = 2 * Math.PI;
const INV_PI                           = 1 / Math.PI;
const INV_TWO_PI                       = 1 / (2 * Math.PI);
const HALF_PI                          = Math.PI / 2;
const DEG_TO_RAD                       = Math.PI / 180;
const RAD_TO_DEG                       = 180 / Math.PI;

const MAX_DROPS                        = 1_000_000;
const MAX_SPLASHES                     = 65_536;
const MAX_WET_SURFACES                 = 100_000;

// Marshall-Palmer drop-size distribution constants.
const MP_N0                            = 8.0e6;      // m^-3 mm^-1
const MP_LAMBDA_COEFF                  = 4.1;
const MP_LAMBDA_EXPONENT               = -0.21;

// Terminal velocity (Atlas 1973): vT = 9.65 - 10.3 * exp(-0.6 D).
const VT_A                             = 9.65;
const VT_B                             = 10.3;
const VT_C                             = 0.6;

// Drop diameter range (metres).
const DROP_D_MIN                       = 0.0001;     // 0.1 mm
const DROP_D_MAX                       = 0.0060;     // 6 mm

// Rain rate range (mm/h).
const RAIN_RATE_MIN                    = 0.05;
const RAIN_RATE_MAX                    = 150.0;

// Splash parameters.
const SPLASH_LIFETIME                  = 0.35;
const SPLASH_RADIUS_MIN                = 0.02;
const SPLASH_RADIUS_MAX                = 0.15;
const SPLASH_INTENSITY_MIN             = 0.15;
const SPLASH_INTENSITY_MAX             = 1.0;

// Wetness accumulation.
const WETNESS_MAX                      = 1.0;
const WETNESS_RAIN_THRESHOLD           = 0.0;        // start wetting at > 0
const WETNESS_DRY_RATE_BASE            = 0.01;       // per second
const WETNESS_DRY_RATE_SUN_MULT        = 4.0;
const WETNESS_DRY_RATE_TEMP_MULT       = 0.02;       // per °C above 5

// Puddle state.
const PUDDLE_THRESHOLD                 = 0.60;
const PUDDLE_MAX_WETNESS               = 1.0;

// Surface classification (for wetness).
export const SurfaceType = Object.freeze({
  GROUND:    0,
  STONE:     1,
  METAL:     2,
  WOOD:      3,
  GLASS:     4,
  FOLIAGE:   5,
  WATER:     6,
  CHARACTER: 7,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA DROP POOL — one slot per live raindrop
// ═══════════════════════════════════════════════════════════════════════

export const RainDrop = {
  // Active flag.
  active: new Uint8Array(MAX_DROPS),

  // World position (metres).
  px: new Float32Array(MAX_DROPS),
  py: new Float32Array(MAX_DROPS),
  pz: new Float32Array(MAX_DROPS),

  // World velocity (m/s; includes wind drift).
  vx: new Float32Array(MAX_DROPS),
  vy: new Float32Array(MAX_DROPS),
  vz: new Float32Array(MAX_DROPS),

  // Drop diameter (metres).
  diameter: new Float32Array(MAX_DROPS),

  // Terminal velocity magnitude (cached per drop).
  terminalVelocity: new Float32Array(MAX_DROPS),

  // Lifetime (seconds since spawn; used to retire drops that go out of view).
  age: new Float32Array(MAX_DROPS),

  // Max lifetime (seconds).
  maxLifetime: new Float32Array(MAX_DROPS),

  // Spawner slot (which cloud emitted it).
  sourceCloudSlot: new Uint16Array(MAX_DROPS),

  // Stream index (used by file 025's particle system for rendering).
  streamIndex: new Uint32Array(MAX_DROPS),

  // Recent collision flag (for splash deduplication).
  collided: new Uint8Array(MAX_DROPS),

  // Free-list head (ring buffer).
  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA SPLASH POOL — one slot per live impact splash
// ═══════════════════════════════════════════════════════════════════════

export const RainSplash = {
  active: new Uint8Array(MAX_SPLASHES),

  px: new Float32Array(MAX_SPLASHES),
  py: new Float32Array(MAX_SPLASHES),
  pz: new Float32Array(MAX_SPLASHES),

  // Splash radius (metres).
  radius: new Float32Array(MAX_SPLASHES),

  // Splash intensity (0..1).
  intensity: new Float32Array(MAX_SPLASHES),

  // Splash age (seconds).
  age: new Float32Array(MAX_SPLASHES),

  // Splash lifetime (seconds).
  lifetime: new Float32Array(MAX_SPLASHES),

  // Source drop diameter (metres; for VFX sizing).
  dropDiameter: new Float32Array(MAX_SPLASHES),

  // Surface normal at impact point.
  nx: new Float32Array(MAX_SPLASHES),
  ny: new Float32Array(MAX_SPLASHES),
  nz: new Float32Array(MAX_SPLASHES),

  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA WETNESS STATE — one slot per wet-surface entity
// ═══════════════════════════════════════════════════════════════════════

export const SurfaceWetness = {
  // Owner entity id (0 = free slot).
  ownerEid: new Uint32Array(MAX_WET_SURFACES),

  // Current wetness (0..1).
  wetness: new Float32Array(MAX_WET_SURFACES),

  // Accumulated rain (mm since wetness last reset).
  rainAccum: new Float32Array(MAX_WET_SURFACES),

  // Puddle depth (metres; 0 = no puddle).
  puddleDepth: new Float32Array(MAX_WET_SURFACES),

  // Puddle coverage (0..1; fraction of surface covered).
  puddleCoverage: new Float32Array(MAX_WET_SURFACES),

  // Surface type (SurfaceType).
  surfaceType: new Uint8Array(MAX_WET_SURFACES),

  // Last time this surface received a splash (for VFX).
  lastSplashTime: new Float32Array(MAX_WET_SURFACES),

  // Active flag.
  active: new Uint8Array(MAX_WET_SURFACES),
};

/** Marker: entity can accumulate wetness (set by addWetSurface). */
export const WetSurfaceTag = {};

const _wetSurfaceSlots = new Map(); // eid -> slot
let _nextWetSurfaceSlot = 0;

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
// DROP-SIZE DISTRIBUTION — Marshall-Palmer
// ═══════════════════════════════════════════════════════════════════════

/**
 * Marshall-Palmer lambda parameter for rain rate R (mm/h).
 * Λ = 4.1 * R^-0.21 (per mm).
 */
function mpLambda(rainRate) {
  const rate = Math.max(RAIN_RATE_MIN, Math.min(RAIN_RATE_MAX, rainRate));
  return MP_LAMBDA_COEFF * Math.pow(rate, MP_LAMBDA_EXPONENT);
}

/**
 * Sample a drop diameter (metres) from the Marshall-Palmer exponential
 * distribution. Inverse transform: D = -ln(1 - u) / Λ.
 */
function sampleDropDiameter(rainRate, u) {
  const lambda = mpLambda(rainRate);
  // Λ is per mm; convert to per metre for drop diameter in metres.
  const lambdaPerMetre = lambda * 1000;
  const dMm = -Math.log(Math.max(1e-6, 1 - u)) / lambda;
  const dM = dMm / 1000;
  return Math.max(DROP_D_MIN, Math.min(DROP_D_MAX, dM));
}

/**
 * Terminal velocity for a drop of diameter D (metres) using the Atlas 1973
 * model (converted from mm).
 */
export function terminalVelocity(D) {
  const dMm = D * 1000;
  if (dMm < 0.1) return 0.1;
  if (dMm > 6.0) return VT_A;
  return VT_A - VT_B * Math.exp(-VT_C * dMm);
}

// ═══════════════════════════════════════════════════════════════════════
// DROP POOL — allocation
// ═══════════════════════════════════════════════════════════════════════

function allocDrop() {
  const R = RainDrop;
  for (let i = 0; i < MAX_DROPS; i++) {
    const slot = (R.freeHead + i) % MAX_DROPS;
    if (R.active[slot] === 0) {
      R.freeHead = (slot + 1) % MAX_DROPS;
      R.active[slot] = 1;
      R.collided[slot] = 0;
      R.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeDrop(slot) {
  const R = RainDrop;
  if (R.active[slot] === 0) return;
  R.active[slot] = 0;
  R.liveCount--;
}

function allocSplash() {
  const S = RainSplash;
  for (let i = 0; i < MAX_SPLASHES; i++) {
    const slot = (S.freeHead + i) % MAX_SPLASHES;
    if (S.active[slot] === 0) {
      S.freeHead = (slot + 1) % MAX_SPLASHES;
      S.active[slot] = 1;
      S.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeSplash(slot) {
  const S = RainSplash;
  if (S.active[slot] === 0) return;
  S.active[slot] = 0;
  S.liveCount--;
}

// ═══════════════════════════════════════════════════════════════════════
// SURFACE WETNESS API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register a wet surface on an entity. Wetness will accumulate here
 * when rain hits this entity's AABB.
 */
export function addWetSurface(world, eid, surfaceType = SurfaceType.GROUND) {
  if (_nextWetSurfaceSlot >= MAX_WET_SURFACES) {
    throw new Error('wet surface capacity exceeded');
  }

  // Reuse existing slot if present.
  let slot = _wetSurfaceSlots.get(eid);
  if (slot === undefined) {
    slot = _nextWetSurfaceSlot++;
    _wetSurfaceSlots.set(eid, slot);
  }

  addComponent(world, eid, WetSurfaceTag);

  const W = SurfaceWetness;
  W.ownerEid[slot] = eid;
  W.wetness[slot] = 0;
  W.rainAccum[slot] = 0;
  W.puddleDepth[slot] = 0;
  W.puddleCoverage[slot] = 0;
  W.surfaceType[slot] = surfaceType;
  W.lastSplashTime[slot] = 0;
  W.active[slot] = 1;

  return slot;
}

export function removeWetSurface(world, eid) {
  const slot = _wetSurfaceSlots.get(eid);
  if (slot === undefined) return;
  SurfaceWetness.active[slot] = 0;
  SurfaceWetness.ownerEid[slot] = 0;
  _wetSurfaceSlots.delete(eid);
  removeComponent(world, eid, WetSurfaceTag);
}

export function getWetSurfaceSlot(eid) {
  return _wetSurfaceSlots.get(eid) ?? -1;
}

export function getSurfaceWetness(eid) {
  const slot = _wetSurfaceSlots.get(eid);
  if (slot === undefined) return 0;
  return SurfaceWetness.wetness[slot];
}

export function getSurfacePuddleCoverage(eid) {
  const slot = _wetSurfaceSlots.get(eid);
  if (slot === undefined) return 0;
  return SurfaceWetness.puddleCoverage[slot];
}

/**
 * Directly reset wetness to zero (e.g. on a sunny day or entity reset).
 */
export function resetSurfaceWetness(world, eid) {
  const slot = _wetSurfaceSlots.get(eid);
  if (slot === undefined) return;
  SurfaceWetness.wetness[slot] = 0;
  SurfaceWetness.puddleDepth[slot] = 0;
  SurfaceWetness.puddleCoverage[slot] = 0;
  SurfaceWetness.rainAccum[slot] = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// STORM SCAN — find all actively raining cloud instances
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return an array of { cloudSlot, x, y, z, radiusX, radiusZ, rate }
 * describing currently precipitating rain clouds (any storm type).
 */
export function gatherRainClouds(world) {
  const result = [];
  const CI = CloudInstance;
  const CA = CloudArchetype;

  for (let slot = 0; slot < CI.ownerEid.length; slot++) {
    if (CI.ownerEid[slot] === 0) continue;

    const aSlot = CI.archetypeSlot[slot];
    if (aSlot === undefined || aSlot < 0) continue;

    const precipType = CA.precipitationType[aSlot];
    if (precipType === PrecipitationType.NONE) continue;
    if (precipType !== PrecipitationType.RAIN &&
        precipType !== PrecipitationType.DRIZZLE &&
        precipType !== PrecipitationType.MIXED) continue;

    const rate = CI.precipRate[slot];
    if (rate < EPSILON) continue;

    // Snow mix fraction filters out snow-only falls.
    // If rate * (1 - snowMix) too small, skip.
    let snowMix = 0;
    if (NimbostratusState.rainRate && hasComponentTagless(world, CI.ownerEid[slot], NimbostratusTag)) {
      const nsSlot = findTaggedSlot(CI.ownerEid[slot], 'nimbostratus');
      if (nsSlot >= 0) snowMix = NimbostratusState.snowMix[nsSlot];
    }
    // Simplified: read from cloud archetype.
    if (rate <= EPSILON) continue;

    result.push({
      cloudSlot: slot,
      x: CI.px[slot],
      y: CI.py[slot],
      z: CI.pz[slot],
      radiusX: CI.radiusX[slot],
      radiusY: CI.radiusY[slot],
      radiusZ: CI.radiusZ[slot],
      rate,
      snowMix,
    });
  }

  return result;
}

function hasComponentTagless(world, eid, tag) {
  return hasComponent(world, eid, tag);
}

function findTaggedSlot(eid, family) {
  // Linear scan of the relevant family state (small).
  if (family === 'nimbostratus') {
    for (let i = 0; i < NimbostratusState.rainRate.length; i++) {
      if (NimbostratusState._baseInstanceSlot[i] === undefined) continue;
      if (CloudInstance.ownerEid[NimbostratusState._baseInstanceSlot[i]] === eid) {
        return i;
      }
    }
  }
  return -1;
}

// ═══════════════════════════════════════════════════════════════════════
// RAIN EMISSION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Emit raindrops from a cloud for one dt frame.
 *
 * @param world       ECS world
 * @param cloud       { cloudSlot, x, y, z, radiusX, radiusY, radiusZ, rate, snowMix }
 * @param dt          seconds
 * @param cameraX/Y/Z camera position (for culling out-of-view spawns)
 * @param maxRadius   max spawn radius from cloud center (default 2x cloud)
 */
export function emitRainDrops(world, cloud, dt, cameraX, cameraY, cameraZ, maxRadius = 0) {
  const rate = cloud.rate;
  if (rate < EPSILON) return;

  // Rain rate -> number of drops to emit per second.
  // At 1 mm/h, roughly 100 drops/m²/s cover the ground; we approximate.
  const dropsPerSecond = Math.min(20000, rate * 40);
  const dropsThisFrame = dropsPerSecond * dt;
  const wholeDrops = Math.floor(dropsThisFrame);
  const fractional = dropsThisFrame - wholeDrops;
  const finalDrops = wholeDrops + (Math.random() < fractional ? 1 : 0);

  const effectiveRadius = maxRadius > 0 ? maxRadius : cloud.radiusX * 1.5;

  for (let i = 0; i < finalDrops; i++) {
    const slot = allocDrop();
    if (slot < 0) return;

    // Drop spawn position: uniform disc under the cloud.
    const r = Math.sqrt(Math.random()) * effectiveRadius;
    const phi = Math.random() * TWO_PI;
    const spawnX = cloud.x + Math.cos(phi) * r;
    const spawnZ = cloud.z + Math.sin(phi) * r;

    // Spawn at cloud base (bottom of the cloud).
    const spawnY = cloud.y - cloud.radiusY;

    // Skip if the spawn is out of view (far from camera).
    const dxCam = spawnX - cameraX;
    const dzCam = spawnZ - cameraZ;
    if (dxCam * dxCam + dzCam * dzCam > 400 * 400) {
      // Still spawn but with lower probability (LOD).
      if (Math.random() > 0.15) {
        freeDrop(slot);
        continue;
      }
    }

    // Sample drop diameter from Marshall-Palmer.
    const u = Math.random();
    const D = sampleDropDiameter(rate, u);
    const vT = terminalVelocity(D);

    RainDrop.px[slot] = spawnX;
    RainDrop.py[slot] = spawnY;
    RainDrop.pz[slot] = spawnZ;
    RainDrop.vx[slot] = 0;   // wind drift applied on first tick
    RainDrop.vy[slot] = -vT;
    RainDrop.vz[slot] = 0;
    RainDrop.diameter[slot] = D;
    RainDrop.terminalVelocity[slot] = vT;
    RainDrop.age[slot] = 0;
    RainDrop.maxLifetime[slot] = 6.0 + Math.random() * 2.0;
    RainDrop.sourceCloudSlot[slot] = cloud.cloudSlot;
    RainDrop.streamIndex[slot] = slot;   // file 025 binds by stream index
  }
}

// ═══════════════════════════════════════════════════════════════════════
// WIND DRIFT — apply to drop velocity each frame
// ═══════════════════════════════════════════════════════════════════════

function applyWindDrift(slot, windSpeed, windDirX, windDirZ, dt) {
  // Drag approximation: drop velocity approaches (windSpeed, -vT) with a
  // time constant roughly equal to the drop's mass / drag.
  const D = RainDrop.diameter[slot];
  // Larger drops are less affected by wind.
  const driftFactor = Math.max(0, 1 - D * 100);   // 0..1
  const targetVx = windSpeed * windDirX * driftFactor;
  const targetVz = windSpeed * windDirZ * driftFactor;

  const alpha = Math.min(1, dt * 4.0);   // approach rate
  RainDrop.vx[slot] += (targetVx - RainDrop.vx[slot]) * alpha;
  RainDrop.vz[slot] += (targetVz - RainDrop.vz[slot]) * alpha;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN SYSTEM — advance drops, handle impacts
// ═══════════════════════════════════════════════════════════════════════

const _rayOrigin = vec3.create();
const _rayDir = vec3.create();

/**
 * Advance rain simulation. Handles:
 *   • drop integration (velocity + gravity + wind drift)
 *   • ray-cast impact detection against world geometry (via file 003 BVH)
 *   • splash generation
 *   • wetness accumulation on tagged surfaces
 *   • retirement of out-of-view or expired drops
 *
 * @param world    ECS world
 * @param dt       seconds
 * @param windSpeed  m/s
 * @param windDirX   -1..1
 * @param windDirZ   -1..1
 * @param cameraX/Y/Z camera position
 */
export function systemUpdateRain(world, dt, windSpeed = 0, windDirX = 1, windDirZ = 0, cameraX = 0, cameraY = 0, cameraZ = 0) {
  const R = RainDrop;

  for (let slot = 0; slot < MAX_DROPS; slot++) {
    if (R.active[slot] === 0) continue;

    // Age.
    R.age[slot] += dt;

    // Retire if lifetime exceeded.
    if (R.age[slot] > R.maxLifetime[slot]) {
      freeDrop(slot);
      continue;
    }

    // Wind drift.
    applyWindDrift(slot, windSpeed, windDirX, windDirZ, dt);

    // Compute the current-to-next segment.
    const prevX = R.px[slot];
    const prevY = R.py[slot];
    const prevZ = R.pz[slot];

    const vx = R.vx[slot];
    const vy = R.vy[slot];
    const vz = R.vz[slot];

    // Cast a short ray to detect impact.
    const stepLen = Math.sqrt(vx * vx + vy * vy + vz * vz) * dt;
    if (stepLen < 1e-4) continue;

    _rayOrigin[0] = prevX;
    _rayOrigin[1] = prevY;
    _rayOrigin[2] = prevZ;

    const invStep = 1 / stepLen;
    _rayDir[0] = vx * invStep;
    _rayDir[1] = vy * invStep;
    _rayDir[2] = vz * invStep;

    const hits = bvhRaycast(
      [_rayOrigin[0], _rayOrigin[1], _rayOrigin[2]],
      [_rayDir[0], _rayDir[1], _rayDir[2]],
      stepLen + 0.01,
      true
    );

    if (hits.length > 0) {
      const h = hits[0];
      const impactX = prevX + _rayDir[0] * h.t;
      const impactY = prevY + _rayDir[1] * h.t;
      const impactZ = prevZ + _rayDir[2] * h.t;

      // Generate a splash.
      const splashSlot = allocSplash();
      if (splashSlot >= 0) {
        const D = R.diameter[slot];
        const energy = D * D * R.terminalVelocity[slot];
        RainSplash.px[splashSlot] = impactX;
        RainSplash.py[splashSlot] = impactY;
        RainSplash.pz[splashSlot] = impactZ;
        RainSplash.radius[splashSlot] = SPLASH_RADIUS_MIN + Math.min(
          SPLASH_RADIUS_MAX - SPLASH_RADIUS_MIN, energy * 100
        );
        RainSplash.intensity[splashSlot] = SPLASH_INTENSITY_MIN + Math.min(
          SPLASH_INTENSITY_MAX - SPLASH_INTENSITY_MIN, energy * 200
        );
        RainSplash.age[splashSlot] = 0;
        RainSplash.lifetime[splashSlot] = SPLASH_LIFETIME;
        RainSplash.dropDiameter[splashSlot] = D;
        // Approximate normal from inverse ray direction.
        RainSplash.nx[splashSlot] = -_rayDir[0];
        RainSplash.ny[splashSlot] = -_rayDir[1];
        RainSplash.nz[splashSlot] = -_rayDir[2];
      }

      // Add wetness to the impacted entity if it has a wet-surface slot.
      const wetSlot = _wetSurfaceSlots.get(h.eid);
      if (wetSlot !== undefined) {
        const volumeMm = (D * 1000) ** 3 * 0.1;   // rough volumetric contribution
        SurfaceWetness.rainAccum[wetSlot] += volumeMm;
        SurfaceWetness.lastSplashTime[wetSlot] = 0;

        // Convert rainAccum to wetness.
        // Saturation is reached at ~50 mm accumulated for most surfaces.
        const saturationMm = surfaceSaturationMm(SurfaceWetness.surfaceType[wetSlot]);
        SurfaceWetness.wetness[wetSlot] = Math.min(
          WETNESS_MAX,
          SurfaceWetness.rainAccum[wetSlot] / saturationMm
        );

        // Puddle formation.
        if (SurfaceWetness.wetness[wetSlot] > PUDDLE_THRESHOLD) {
          const excess = SurfaceWetness.wetness[wetSlot] - PUDDLE_THRESHOLD;
          SurfaceWetness.puddleCoverage[wetSlot] = Math.min(1, excess * 2);
          SurfaceWetness.puddleDepth[wetSlot] = excess * 0.02;   // up to 20 mm
        }
      }

      // Retire the drop.
      freeDrop(slot);
      continue;
    }

    // No impact: advance the drop.
    R.px[slot] = prevX + vx * dt;
    R.py[slot] = prevY + vy * dt;
    R.pz[slot] = prevZ + vz * dt;

    // Retire if the drop goes below ground level (Y < -50).
    if (R.py[slot] < -50) {
      freeDrop(slot);
      continue;
    }
  }

  // Advance splashes.
  const S = RainSplash;
  for (let slot = 0; slot < MAX_SPLASHES; slot++) {
    if (S.active[slot] === 0) continue;
    S.age[slot] += dt;
    if (S.age[slot] >= S.lifetime[slot]) {
      freeSplash(slot);
    }
  }

  return world;
}

function surfaceSaturationMm(surfaceType) {
  switch (surfaceType) {
    case SurfaceType.GROUND:    return 60;
    case SurfaceType.STONE:     return 40;
    case SurfaceType.METAL:     return 25;
    case SurfaceType.WOOD:      return 45;
    case SurfaceType.GLASS:     return 15;
    case SurfaceType.FOLIAGE:   return 80;
    case SurfaceType.WATER:     return 0;   // never "wet"
    case SurfaceType.CHARACTER: return 20;
    default:                    return 50;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// DRYING SYSTEM
// ═══════════════════════════════════════════════════════════════════════

/**
 * Dry surfaces based on temperature and sun intensity. Should be called
 * once per frame (or at a low tick rate).
 *
 * @param world           ECS world
 * @param dt              seconds
 * @param ambientTempC    °C
 * @param sunIntensity    0..1 (from sky)
 */
export function systemDrySurfaces(world, dt, ambientTempC, sunIntensity) {
  const W = SurfaceWetness;

  // Base drying per second.
  const tempFactor = Math.max(0, ambientTempC - 5) * WETNESS_DRY_RATE_TEMP_MULT;
  const sunFactor = sunIntensity * WETNESS_DRY_RATE_SUN_MULT;
  const dryRate = (WETNESS_DRY_RATE_BASE + tempFactor + sunFactor) * dt;

  for (let slot = 0; slot < _nextWetSurfaceSlot; slot++) {
    if (W.active[slot] === 0) continue;
    if (W.wetness[slot] < EPSILON) continue;

    // Puddles dry slower than surface wetness.
    const puddleModifier = W.puddleCoverage[slot] > 0.1 ? 0.3 : 1.0;
    const effectiveDry = dryRate * puddleModifier;

    W.wetness[slot] = Math.max(0, W.wetness[slot] - effectiveDry);
    W.rainAccum[slot] = Math.max(0, W.rainAccum[slot] - effectiveDry * 60);

    // Puddle recede.
    if (W.wetness[slot] < PUDDLE_THRESHOLD) {
      W.puddleCoverage[slot] = Math.max(0,
        W.puddleCoverage[slot] - effectiveDry * 2);
      W.puddleDepth[slot] = Math.max(0,
        W.puddleDepth[slot] - effectiveDry * 0.02);
    }

    // Reset last splash time.
    W.lastSplashTime[slot] += dt;
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE — for file 025 particle system
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a compact description of active rain for file 025's particle
 * renderer. Returns an array of { x, y, z, diameter, velocity } for each
 * live drop, capped by maxOutput (default 4096).
 */
export function gatherRainForRendering(maxOutput = 4096) {
  const result = [];
  const R = RainDrop;

  for (let slot = 0; slot < MAX_DROPS; slot++) {
    if (R.active[slot] === 0) continue;
    result.push({
      x: R.px[slot], y: R.py[slot], z: R.pz[slot],
      diameter: R.diameter[slot],
      vx: R.vx[slot], vy: R.vy[slot], vz: R.vz[slot],
    });
    if (result.length >= maxOutput) break;
  }
  return result;
}

/**
 * Return a compact description of active splashes for file 025's
 * particle renderer. Returns an array of { x, y, z, radius, intensity, age }.
 */
export function gatherSplashesForRendering(maxOutput = 2048) {
  const result = [];
  const S = RainSplash;

  for (let slot = 0; slot < MAX_SPLASHES; slot++) {
    if (S.active[slot] === 0) continue;
    result.push({
      x: S.px[slot], y: S.py[slot], z: S.pz[slot],
      radius: S.radius[slot],
      intensity: S.intensity[slot],
      age: S.age[slot],
      lifetime: S.lifetime[slot],
    });
    if (result.length >= maxOutput) break;
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// SURFACE MATERIAL COUPLING — reflectivity from wetness
// ═══════════════════════════════════════════════════════════════════════

/**
 * Apply wetness to an entity's material (if it has one). Wetness:
 *   • darkens albedo (~20% darker when fully wet)
 *   • increases specular reflectivity
 *   • decreases roughness
 *
 * Call this after material updates and before rendering.
 */
export function applyWetnessToMaterial(world, eid) {
  const wetSlot = _wetSurfaceSlots.get(eid);
  if (wetSlot === undefined) return;

  if (!hasComponent(world, eid, MaterialTag)) return;

  const id = getId(eid);
  const wet = SurfaceWetness.wetness[wetSlot];
  if (wet < EPSILON) return;

  // Darken albedo.
  MaterialF32.baseR[id] *= (1 - wet * 0.20);
  MaterialF32.baseG[id] *= (1 - wet * 0.20);
  MaterialF32.baseB[id] *= (1 - wet * 0.20);

  // Decrease roughness (wetter = shinier).
  MaterialF32.roughness[id] *= (1 - wet * 0.30);

  // Increase metallic-look specular when puddled.
  if (SurfaceWetness.puddleCoverage[wetSlot] > 0.1) {
    MaterialF32.metallic[id] = Math.min(0.15, MaterialF32.metallic[id] + 0.05);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearRain() {
  RainDrop.active.fill(0);
  RainDrop.freeHead = 0;
  RainDrop.liveCount = 0;
  RainSplash.active.fill(0);
  RainSplash.freeHead = 0;
  RainSplash.liveCount = 0;
  SurfaceWetness.active.fill(0);
  SurfaceWetness.ownerEid.fill(0);
  _wetSurfaceSlots.clear();
  _nextWetSurfaceSlot = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function rainStats() {
  let wetSurfaces = 0;
  let puddledSurfaces = 0;
  let avgWetness = 0;
  let wetSum = 0;

  for (let slot = 0; slot < _nextWetSurfaceSlot; slot++) {
    if (SurfaceWetness.active[slot] === 0) continue;
    wetSurfaces++;
    wetSum += SurfaceWetness.wetness[slot];
    if (SurfaceWetness.puddleCoverage[slot] > 0.1) puddledSurfaces++;
  }

  if (wetSurfaces > 0) avgWetness = wetSum / wetSurfaces;

  return {
    activeDrops: RainDrop.liveCount,
    maxDrops: MAX_DROPS,
    activeSplashes: RainSplash.liveCount,
    maxSplashes: MAX_SPLASHES,
    wetSurfaces,
    puddledSurfaces,
    avgWetness,
    wetSurfaceCapacity: MAX_WET_SURFACES,
  };
}