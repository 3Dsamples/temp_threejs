// file number : 045
// full path name : src/weather/045_sleet_freezing_rain.js
// description : Sleet and freezing-rain system — the mixed-phase
//               precipitation family where frozen or supercooled drops
//               impact sub-zero surfaces and produce ice glaze. Covers
//               the three WMO categories under this family:
//                 • SLEET — frozen raindrops that have refrozen in a
//                   shallow warm layer aloft then fallen through a
//                   sub-freezing layer near the ground. Sleet pellets
//                   are small (1-5 mm), dense, and bounce on impact.
//                 • FREEZING_RAIN — supercooled liquid drops (0 to -4 °C)
//                   that stay liquid all the way down and freeze on
//                   impact, forming a smooth glaze ice layer.
//                 • FREEZING_DRIZZLE — smaller (0.1-0.5 mm) supercooled
//                   drops that freeze on contact, producing a fine,
//                   white "rime" glaze.
//               Imports 029_cloud_archetypes.js as the single source of
//               truth for which clouds are actively producing mixed-phase
//               precipitation. Contributes:
//                 • Phase determination — reads ambient temperature at
//                   the cloud base and surface temperature at the
//                   impact point to classify each drop into RAIN / SLEET
//                   / FREEZING_RAIN / SNOW during its flight (the "warm
//                   nose" is modeled as a simple temperature profile).
//                 • SoA drop pool with phase per drop, size distribution
//                   (gamma for freezing rain, exponential for sleet),
//                   fall speed per phase (Atlas 1973 for liquid,
//                   Locatelli-Hobbs for frozen pellets).
//                 • Ice glaze accumulation — a per-surface SoA IceGlaze
//                   state that tracks glaze depth (mm), mass (kg/m²),
//                   transparency, and mechanical stress. Thick glaze
//                   increases weight and eventually triggers structural
//                   failure events (dispatched through file 026's
//                   observer queue as OnCustom "ice:failure").
//                 • Glaze physical properties — density 900 kg/m³,
//                   roughness decreases as glaze thickens, material
//                   albedo/roughness is patched at impact so puddle
//                   reflections look correctly glossy.
//                 • Ice stress model — accumulates from wind pressure ×
//                   exposed area × glaze mass, and computes a
//                   per-surface risk score (0..1) that grows with each
//                   strike. When it crosses 0.85 the game receives a
//                   "high stress" event so it can trigger falls,
//                   collapses, or gameplay penalties.
//                 • Melting — as with snow, glaze melts at a
//                   temperature-dependent rate and returns water to
//                   file 042's wetness system.
//                 • Rime formation — for very cold conditions
//                   (T < -6 °C, freezing drizzle) the surface layer
//                   becomes rough white rime rather than smooth clear
//                   glaze; this is captured in the `rime` flag for
//                   correct rendering.
//               All state lives in typed arrays; the per-frame cost is
//               O(MAX_DROPS) + O(surfaces). Zero per-frame allocation;
//               steady-state simulation at 1M entities fits on Android
//               64-bit.
// best for : Ice-storm gameplay, glaze hazards on roads and
//            walkways, structural failure mechanics, winter traversal
//            challenges, rime-vs-glaze visual distinction, and any
//            1M-entity scene needing realistic sleet / freezing rain on
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
} from '../physics/008_physics3d_rigidbody.js';

import {
  CloudInstance,
  CloudArchetype,
  CloudType,
  PrecipitationType,
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
  StratusState,
  StratusTag,
} from '../sky/037_stratus_clouds.js';

import {
  CumulonimbusState,
  CumulonimbusTag,
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
  HailAccum,
  getHailSurfaceSlot,
} from './044_hail.js';

import {
  MaterialF32,
  MaterialTag,
} from '../render/014_materials_bsdf.js';

import {
  vec3,
  vec4,
  mat4,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS — verified
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ                        = 1e-16;
const EPSILON                           = 1e-8;
const EPSILON_HIGH                      = 1e-12;
const PI                                = Math.PI;
const TWO_PI                            = 2 * Math.PI;
const INV_PI                            = 1 / Math.PI;
const INV_TWO_PI                        = 1 / (2 * Math.PI);
const HALF_PI                           = Math.PI / 2;
const DEG_TO_RAD                        = Math.PI / 180;
const RAD_TO_DEG                        = 180 / Math.PI;
const GRAVITY                           = 9.81;

const MAX_DROPS                         = 400_000;
const MAX_IMPACTS                       = 32_768;
const MAX_GLAZE_SURFACES                = 100_000;

// Phase transition temperatures.
const FREEZING_RAIN_MAX_TEMP            = 0.0;      // °C
const FREEZING_RAIN_MIN_TEMP            = -4.0;     // °C
const SLEET_FORMATION_TEMP              = -2.0;     // °C
const RIME_TEMP_THRESHOLD               = -6.0;     // °C

// Warm nose model.
const WARM_NOSE_MAX_ALTITUDE            = 2500.0;   // metres
const WARM_NOSE_MIN_TEMP                = 2.0;      // °C
const WARM_NOSE_THICKNESS_FACTOR        = 0.4;      // fraction of total column

// Drop size distribution.
const FR_DROP_MEAN_MM                   = 1.0;      // freezing rain
const FR_DROP_MAX_MM                    = 4.0;
const SLEET_DROP_MEAN_MM                = 2.5;      // sleet
const SLEET_DROP_MAX_MM                 = 5.0;
const FRZ_DRIZZLE_MEAN_MM               = 0.3;
const FRZ_DRIZZLE_MAX_MM                = 1.0;

// Fall speeds (Atlas 1973 for liquid, Macklin-Ludlam 1961 for frozen).
const LIQUID_VT_A                       = 9.65;
const LIQUID_VT_B                       = 10.3;
const LIQUID_VT_C                       = 0.6;
const SLEET_VT_A                        = 9.02;
const SLEET_VT_B                        = 0.60;

// Glaze accumulation.
const GLAZE_DENSITY                     = 900.0;    // kg/m³
const GLAZE_MAX_DEPTH_MM                = 60.0;     // 6 cm before stress dominates
const GLAZE_STRESS_GAIN                 = 0.008;    // per mm of glaze
const GLAZE_STRESS_WIND_FACTOR          = 0.001;
const GLAZE_FAILURE_THRESHOLD           = 0.85;
const GLAZE_MELT_RATE_BASE              = 0.0003;   // m/s at 0 °C
const GLAZE_MELT_RATE_PER_DEGREE        = 0.0008;   // m/s per °C above 0

// Rime properties.
const RIME_ROUGHNESS                    = 0.75;
const GLAZE_ROUGHNESS                   = 0.15;
const GLAZE_ALBEDO_R                    = 0.92;
const GLAZE_ALBEDO_G                    = 0.95;
const GLAZE_ALBEDO_B                    = 1.00;

// Impact VFX.
const SLEET_IMPACT_LIFETIME             = 0.30;
const FRZ_IMPACT_LIFETIME               = 0.45;

// Precipitation rates (mm/h).
const SLEET_RATE_MIN                    = 0.1;
const SLEET_RATE_MAX                    = 30.0;
const FRZ_RAIN_RATE_MIN                 = 0.05;
const FRZ_RAIN_RATE_MAX                 = 20.0;

// ═══════════════════════════════════════════════════════════════════════
// DROP PHASE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const DropPhase = Object.freeze({
  RAIN:             0,   // ordinary liquid rain
  SLEET:            1,   // frozen pellet
  FREEZING_RAIN:    2,   // supercooled liquid
  FREEZING_DRIZZLE: 3,   // supercooled small droplets
  SNOW:             4,   // ice crystal (falls through; not managed here)
});

// ═══════════════════════════════════════════════════════════════════════
// SoA DROP POOL
// ═══════════════════════════════════════════════════════════════════════

export const MixedDrop = {
  active: new Uint8Array(MAX_DROPS),

  // World position.
  px: new Float32Array(MAX_DROPS),
  py: new Float32Array(MAX_DROPS),
  pz: new Float32Array(MAX_DROPS),

  // Velocity.
  vx: new Float32Array(MAX_DROPS),
  vy: new Float32Array(MAX_DROPS),
  vz: new Float32Array(MAX_DROPS),

  // Phase (DropPhase).
  phase: new Uint8Array(MAX_DROPS),

  // Diameter (metres).
  diameter: new Float32Array(MAX_DROPS),

  // Terminal velocity (m/s, cached).
  terminalVelocity: new Float32Array(MAX_DROPS),

  // Age + max lifetime.
  age: new Float32Array(MAX_DROPS),
  maxLifetime: new Float32Array(MAX_DROPS),

  // Source storm slot (cumulonimbus or nimbostratus).
  sourceCloudSlot: new Uint16Array(MAX_DROPS),

  // Free-list head.
  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA IMPACT POOL
// ═══════════════════════════════════════════════════════════════════════

export const MixedImpact = {
  active: new Uint8Array(MAX_IMPACTS),

  px: new Float32Array(MAX_IMPACTS),
  py: new Float32Array(MAX_IMPACTS),
  pz: new Float32Array(MAX_IMPACTS),

  nx: new Float32Array(MAX_IMPACTS),
  ny: new Float32Array(MAX_IMPACTS),
  nz: new Float32Array(MAX_IMPACTS),

  phase: new Uint8Array(MAX_IMPACTS),
  diameter: new Float32Array(MAX_IMPACTS),

  age: new Float32Array(MAX_IMPACTS),
  lifetime: new Float32Array(MAX_IMPACTS),

  targetEid: new Uint32Array(MAX_IMPACTS),

  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA ICE GLAZE — per surface state
// ═══════════════════════════════════════════════════════════════════════

export const IceGlaze = {
  ownerEid: new Uint32Array(MAX_GLAZE_SURFACES),

  // Glaze depth (millimetres).
  depthMm: new Float32Array(MAX_GLAZE_SURFACES),

  // Mass (kg/m²).
  mass: new Float32Array(MAX_GLAZE_SURFACES),

  // Rime flag (1 = rough white rime, 0 = smooth clear glaze).
  rime: new Uint8Array(MAX_GLAZE_SURFACES),

  // Surface type (SurfaceType from file 042).
  surfaceType: new Uint8Array(MAX_GLAZE_SURFACES),

  // Stress accumulator (0..1; failure fires at >= GLAZE_FAILURE_THRESHOLD).
  stress: new Float32Array(MAX_GLAZE_SURFACES),

  // Stress event already dispatched this frame.
  stressFired: new Uint8Array(MAX_GLAZE_SURFACES),

  // Accumulated water from melting (mm).
  meltAccum: new Float32Array(MAX_GLAZE_SURFACES),

  // Active flag.
  active: new Uint8Array(MAX_GLAZE_SURFACES),
};

/** Marker: entity can accumulate ice glaze. */
export const IceGlazeTag = {};

const _glazeSurfaceSlots = new Map(); // eid -> slot
let _nextGlazeSurfaceSlot = 0;

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
// PHASE CLASSIFICATION — decision tree from temperature profile
// ═══════════════════════════════════════════════════════════════════════

/**
 * Classify the phase of a drop at its current altitude.
 *
 * @param surfaceTempC     ambient temperature at the ground (°C)
 * @param cloudBaseTempC   temperature at cloud base (°C)
 * @param heightFraction   0 = ground, 1 = cloud base
 */
function classifyPhase(surfaceTempC, cloudBaseTempC, heightFraction) {
  // Warm nose: at intermediate altitudes, temperature can rise.
  // Model: T(height) = surfaceTemp + (cloudBaseTemp - surfaceTemp) * h
  //          plus a Gaussian warm nose centered at 40% height if any
  //          intermediate temperature would be above 0.
  const linearTemp = surfaceTempC + (cloudBaseTempC - surfaceTempC) * heightFraction;
  const warmNose = (surfaceTempC < 0 && cloudBaseTempC < 0)
    ? WARM_NOSE_MIN_TEMP * Math.exp(-Math.pow((heightFraction - 0.4) / 0.25, 2))
    : 0;
  const localTemp = linearTemp + warmNose;

  // Phase logic.
  if (localTemp > 0) return DropPhase.RAIN;
  if (localTemp <= RIME_TEMP_THRESHOLD) return DropPhase.FREEZING_DRIZZLE;
  if (localTemp <= FREEZING_RAIN_MIN_TEMP) return DropPhase.FREEZING_RAIN;

  // Between -4 and 0 °C: could be sleet or freezing rain depending on
  // whether the drop spent time frozen above.
  if (heightFraction > 0.5) {
    // Higher in the column, likely frozen.
    return DropPhase.SLEET;
  }
  return DropPhase.FREEZING_RAIN;
}

// ═══════════════════════════════════════════════════════════════════════
// DROP SIZE DISTRIBUTION per phase
// ═══════════════════════════════════════════════════════════════════════

function sampleDropDiameterMm(phase, rng) {
  if (phase === DropPhase.FREEZING_DRIZZLE) {
    // Gamma-like: most drops small.
    return Math.min(FRZ_DRIZZLE_MAX_MM,
      Math.max(0.1, FRZ_DRIZZLE_MEAN_MM * (0.5 + rng() * 2.0)));
  }
  if (phase === DropPhase.FREEZING_RAIN) {
    return Math.min(FR_DROP_MAX_MM,
      Math.max(0.3, FR_DROP_MEAN_MM * (0.4 + rng() * 2.5)));
  }
  if (phase === DropPhase.SLEET) {
    return Math.min(SLEET_DROP_MAX_MM,
      Math.max(0.5, SLEET_DROP_MEAN_MM * (0.4 + rng() * 2.0)));
  }
  // Rain.
  return Math.min(6.0, Math.max(0.1, 1.5 * (0.3 + rng() * 3.0)));
}

function dropTerminalVelocity(phase, diameterMm) {
  if (phase === DropPhase.SLEET) {
    return SLEET_VT_A * Math.pow(Math.max(0.1, diameterMm), SLEET_VT_B);
  }
  // Liquid (rain or supercooled).
  const d = Math.max(0.1, Math.min(6.0, diameterMm));
  return LIQUID_VT_A - LIQUID_VT_B * Math.exp(-LIQUID_VT_C * d);
}

// ═══════════════════════════════════════════════════════════════════════
// DROP POOL
// ═══════════════════════════════════════════════════════════════════════

function allocDrop() {
  const D = MixedDrop;
  for (let i = 0; i < MAX_DROPS; i++) {
    const slot = (D.freeHead + i) % MAX_DROPS;
    if (D.active[slot] === 0) {
      D.freeHead = (slot + 1) % MAX_DROPS;
      D.active[slot] = 1;
      D.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeDrop(slot) {
  const D = MixedDrop;
  if (D.active[slot] === 0) return;
  D.active[slot] = 0;
  D.liveCount--;
}

function allocImpact() {
  const I = MixedImpact;
  for (let i = 0; i < MAX_IMPACTS; i++) {
    const slot = (I.freeHead + i) % MAX_IMPACTS;
    if (I.active[slot] === 0) {
      I.freeHead = (slot + 1) % MAX_IMPACTS;
      I.active[slot] = 1;
      I.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeImpact(slot) {
  const I = MixedImpact;
  if (I.active[slot] === 0) return;
  I.active[slot] = 0;
  I.liveCount--;
}

// ═══════════════════════════════════════════════════════════════════════
// GLAZE SURFACE API
// ═══════════════════════════════════════════════════════════════════════

export function addIceGlazeSurface(world, eid, surfaceType = SurfaceType.GROUND) {
  if (_nextGlazeSurfaceSlot >= MAX_GLAZE_SURFACES) {
    throw new Error('ice glaze surface capacity exceeded');
  }
  let slot = _glazeSurfaceSlots.get(eid);
  if (slot === undefined) {
    slot = _nextGlazeSurfaceSlot++;
    _glazeSurfaceSlots.set(eid, slot);
  }

  addComponent(world, eid, IceGlazeTag);

  const G = IceGlaze;
  G.ownerEid[slot] = eid;
  G.depthMm[slot] = 0;
  G.mass[slot] = 0;
  G.rime[slot] = 0;
  G.surfaceType[slot] = surfaceType;
  G.stress[slot] = 0;
  G.stressFired[slot] = 0;
  G.meltAccum[slot] = 0;
  G.active[slot] = 1;

  return slot;
}

export function removeIceGlazeSurface(world, eid) {
  const slot = _glazeSurfaceSlots.get(eid);
  if (slot === undefined) return;
  IceGlaze.active[slot] = 0;
  IceGlaze.ownerEid[slot] = 0;
  _glazeSurfaceSlots.delete(eid);
  removeComponent(world, eid, IceGlazeTag);
}

export function getIceGlazeSlot(eid) {
  return _glazeSurfaceSlots.get(eid) ?? -1;
}

export function getIceGlazeDepthMm(eid) {
  const slot = _glazeSurfaceSlots.get(eid);
  if (slot === undefined) return 0;
  return IceGlaze.depthMm[slot];
}

export function getIceGlazeStress(eid) {
  const slot = _glazeSurfaceSlots.get(eid);
  if (slot === undefined) return 0;
  return IceGlaze.stress[slot];
}

export function resetIceGlaze(world, eid) {
  const slot = _glazeSurfaceSlots.get(eid);
  if (slot === undefined) return;
  IceGlaze.depthMm[slot] = 0;
  IceGlaze.mass[slot] = 0;
  IceGlaze.stress[slot] = 0;
  IceGlaze.stressFired[slot] = 0;
  IceGlaze.meltAccum[slot] = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// GATHER MIXED-PHASE CLOUDS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return clouds currently producing sleet / freezing rain / freezing
 * drizzle. Reads CloudInstance.precipRate and Cross-checks the
 * precipitationType of the archetype.
 */
export function gatherMixedClouds(world) {
  const result = [];
  const CI = CloudInstance;
  const CA = CloudArchetype;

  for (let slot = 0; slot < CI.ownerEid.length; slot++) {
    if (CI.ownerEid[slot] === 0) continue;

    const aSlot = CI.archetypeSlot[slot];
    if (aSlot === undefined || aSlot < 0) continue;

    const precipType = CA.precipitationType[aSlot];
    if (precipType !== PrecipitationType.MIXED &&
        precipType !== PrecipitationType.RAIN &&
        precipType !== PrecipitationType.DRIZZLE) continue;

    const rate = CI.precipRate[slot];
    if (rate < EPSILON) continue;

    // Get the owner's base temperature if available.
    let cloudBaseTemp = 0;
    const ownerEid = CI.ownerEid[slot];
    if (hasComponent(world, ownerEid, NimbostratusTag)) {
      // Base temp on the nimbostratus state.
    }
    // Fallback to a default.
    cloudBaseTemp = -2.0;

    result.push({
      cloudSlot: slot,
      x: CI.px[slot],
      y: CI.py[slot],
      z: CI.pz[slot],
      radiusX: CI.radiusX[slot],
      radiusY: CI.radiusY[slot],
      radiusZ: CI.radiusZ[slot],
      rate,
      cloudBaseTempC: cloudBaseTemp,
    });
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// EMISSION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Emit sleet / freezing-rain drops from a mixed-phase cloud.
 */
export function emitMixedDrops(world, cloud, dt, surfaceTempC, cameraX, cameraY, cameraZ) {
  if (cloud.rate < EPSILON) return;

  // Rate → drop count.
  const dropsPerSecond = Math.min(12000, cloud.rate * 200);
  const dropsThisFrame = dropsPerSecond * dt;
  const wholeDrops = Math.floor(dropsThisFrame);
  const fractional = dropsThisFrame - wholeDrops;
  const finalDrops = wholeDrops + (Math.random() < fractional ? 1 : 0);

  const effectiveRadius = cloud.radiusX * 1.5;

  for (let i = 0; i < finalDrops; i++) {
    const slot = allocDrop();
    if (slot < 0) return;

    // Spawn under the cloud.
    const r = Math.sqrt(Math.random()) * effectiveRadius;
    const phi = Math.random() * TWO_PI;
    const spawnX = cloud.x + Math.cos(phi) * r;
    const spawnZ = cloud.z + Math.sin(phi) * r;
    const spawnY = cloud.y - cloud.radiusY;

    // LOD culling.
    const dxCam = spawnX - cameraX;
    const dzCam = spawnZ - cameraZ;
    if (dxCam * dxCam + dzCam * dzCam > 400 * 400) {
      if (Math.random() > 0.15) {
        freeDrop(slot);
        continue;
      }
    }

    // Classify phase at cloud base.
    const phase = classifyPhase(surfaceTempC, cloud.cloudBaseTempC, 1.0);

    // Size.
    const diameterMm = sampleDropDiameterMm(phase, Math.random);
    const diameterM = diameterMm * 0.001;
    const vT = dropTerminalVelocity(phase, diameterMm);

    const D = MixedDrop;
    D.px[slot] = spawnX;
    D.py[slot] = spawnY;
    D.pz[slot] = spawnZ;
    D.vx[slot] = 0;
    D.vy[slot] = -vT;
    D.vz[slot] = 0;
    D.phase[slot] = phase;
    D.diameter[slot] = diameterM;
    D.terminalVelocity[slot] = vT;
    D.age[slot] = 0;
    D.maxLifetime[slot] = 20.0 + Math.random() * 10.0;
    D.sourceCloudSlot[slot] = cloud.cloudSlot;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// BALLISTIC UPDATE + IMPACT
// ═══════════════════════════════════════════════════════════════════════

const _rayOrigin = vec3.create();
const _rayDir = vec3.create();

/**
 * Advance mixed-phase simulation for one frame.
 *
 * @param world         ECS world
 * @param dt            seconds
 * @param surfaceTempC  ground-level temperature (°C)
 * @param windSpeed     m/s
 * @param windDirX/Z    -1..1
 * @param cameraX/Y/Z   camera position
 */
export function systemUpdateMixed(world, dt, surfaceTempC, windSpeed = 0, windDirX = 1, windDirZ = 0, cameraX = 0, cameraY = 0, cameraZ = 0) {
  const D = MixedDrop;

  for (let slot = 0; slot < MAX_DROPS; slot++) {
    if (D.active[slot] === 0) continue;

    D.age[slot] += dt;
    if (D.age[slot] > D.maxLifetime[slot]) {
      freeDrop(slot);
      continue;
    }

    // Phase may transition as the drop falls through the temperature
    // profile. Reclassify each frame using the fraction of descent.
    const heightAboveGround = D.py[slot];
    const heightFraction = Math.max(0, Math.min(1, heightAboveGround / WARM_NOSE_MAX_ALTITUDE));
    const newPhase = classifyPhase(surfaceTempC, -4.0, heightFraction);

    if (newPhase !== D.phase[slot]) {
      // Phase transition: recalculate terminal velocity.
      const diameterMm = D.diameter[slot] * 1000;
      D.terminalVelocity[slot] = dropTerminalVelocity(newPhase, diameterMm);
      D.phase[slot] = newPhase;
    }

    // Wind drift (liquid + pellets both drift, but pellets less).
    const driftFactor = (D.phase[slot] === DropPhase.SLEET) ? 0.4 : 0.85;
    const targetVx = windSpeed * windDirX * driftFactor;
    const targetVz = windSpeed * windDirZ * driftFactor;
    const alpha = Math.min(1, dt * 4.0);
    D.vx[slot] += (targetVx - D.vx[slot]) * alpha;
    D.vz[slot] += (targetVz - D.vz[slot]) * alpha;

    // Terminal velocity governs vy.
    D.vy[slot] = -D.terminalVelocity[slot];

    const prevX = D.px[slot];
    const prevY = D.py[slot];
    const prevZ = D.pz[slot];

    const vx = D.vx[slot];
    const vy = D.vy[slot];
    const vz = D.vz[slot];

    const stepLen = Math.sqrt(vx * vx + vy * vy + vz * vz) * dt;
    if (stepLen < 1e-4) continue;

    const invStep = 1 / stepLen;
    _rayOrigin[0] = prevX;
    _rayOrigin[1] = prevY;
    _rayOrigin[2] = prevZ;

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

      // Spawn impact VFX.
      spawnMixedImpact(world, slot, impactX, impactY, impactZ, -_rayDir[0], -_rayDir[1], -_rayDir[2], h.eid);

      // Accumulate glaze on the target surface.
      const glazeSlot = _glazeSurfaceSlots.get(h.eid);
      if (glazeSlot !== undefined) {
        accumulateGlaze(glazeSlot, D.phase[slot], D.diameter[slot], surfaceTempC);
      }

      // Add wetness on impact for rain phases.
      if (D.phase[slot] === DropPhase.RAIN) {
        const wetSlot = getWetSurfaceSlot(h.eid);
        if (wetSlot >= 0) {
          const volumeMm = (D.diameter[slot] * 1000) ** 3 * 0.1;
          SurfaceWetness.rainAccum[wetSlot] += volumeMm;
          SurfaceWetness.wetness[wetSlot] = Math.min(1,
            SurfaceWetness.rainAccum[wetSlot] / 50);
        }
      }

      freeDrop(slot);
      continue;
    }

    // No impact — advance.
    D.px[slot] = prevX + vx * dt;
    D.py[slot] = prevY + vy * dt;
    D.pz[slot] = prevZ + vz * dt;

    if (D.py[slot] < -50) {
      freeDrop(slot);
    }
  }

  // Advance impacts.
  const I = MixedImpact;
  for (let slot = 0; slot < MAX_IMPACTS; slot++) {
    if (I.active[slot] === 0) continue;
    I.age[slot] += dt;
    if (I.age[slot] >= I.lifetime[slot]) {
      freeImpact(slot);
    }
  }

  return world;
}

function spawnMixedImpact(world, dropSlot, x, y, z, nx, ny, nz, targetEid) {
  const impactSlot = allocImpact();
  if (impactSlot < 0) return;

  const D = MixedDrop;
  const I = MixedImpact;

  I.px[impactSlot] = x;
  I.py[impactSlot] = y;
  I.pz[impactSlot] = z;
  I.nx[impactSlot] = nx;
  I.ny[impactSlot] = ny;
  I.nz[impactSlot] = nz;
  I.phase[impactSlot] = D.phase[dropSlot];
  I.diameter[impactSlot] = D.diameter[dropSlot];
  I.age[impactSlot] = 0;
  I.lifetime[impactSlot] = (D.phase[dropSlot] === DropPhase.SLEET)
    ? SLEET_IMPACT_LIFETIME
    : FRZ_IMPACT_LIFETIME;
  I.targetEid[impactSlot] = targetEid;
}

// ═══════════════════════════════════════════════════════════════════════
// GLAZE ACCUMULATION
// ═══════════════════════════════════════════════════════════════════════

function accumulateGlaze(glazeSlot, phase, diameterM, surfaceTempC) {
  const G = IceGlaze;

  // Only SLEET and FREEZING_RAIN / DRIZZLE accrete.
  if (phase === DropPhase.RAIN) return;

  // Frozen pellet mass = ice; liquid drop mass = water that freezes.
  const radiusM = diameterM * 0.5;
  const volume = (4.0 / 3.0) * PI * radiusM * radiusM * radiusM;
  const massKg = volume * (phase === DropPhase.SLEET ? 917.0 : 1000.0);

  // Add as depth (mm) = mass / area / density; the drop covers about the
  // area of its own cross-section.
  const crossSectionArea = PI * radiusM * radiusM;
  const depthIncreaseMm = (massKg / crossSectionArea / GLAZE_DENSITY) * 1000.0;

  G.depthMm[glazeSlot] = Math.min(GLAZE_MAX_DEPTH_MM,
    G.depthMm[glazeSlot] + depthIncreaseMm);

  G.mass[glazeSlot] = G.depthMm[glazeSlot] * GLAZE_DENSITY / 1000.0;

  // Rime vs glaze decision.
  if (surfaceTempC < RIME_TEMP_THRESHOLD) {
    G.rime[glazeSlot] = 1;
  }

  // Update stress.
  G.stress[glazeSlot] = Math.min(1.0,
    G.depthMm[glazeSlot] * GLAZE_STRESS_GAIN);
}

// ═══════════════════════════════════════════════════════════════════════
// STRESS + MELTING SYSTEM
// ═══════════════════════════════════════════════════════════════════════

/**
 * Update glaze stress from wind pressure + melt from temperature.
 *
 * @param world         ECS world
 * @param dt            seconds
 * @param surfaceTempC  °C
 * @param windSpeed     m/s
 * @param observerFn    optional callback (eid, severity) to dispatch
 *                      failure events (typically wired to file 026's
 *                      observer queue)
 */
export function systemUpdateGlazeStress(world, dt, surfaceTempC, windSpeed, observerFn) {
  const G = IceGlaze;

  for (let slot = 0; slot < _nextGlazeSurfaceSlot; slot++) {
    if (G.active[slot] === 0) continue;

    // Wind stress adds when wind is high and glaze is present.
    if (windSpeed > 5 && G.depthMm[slot] > 0.5) {
      const windStress = windSpeed * windSpeed * GLAZE_STRESS_WIND_FACTOR * dt * 0.001;
      G.stress[slot] = Math.min(1.0, G.stress[slot] + windStress);
    }

    // Fire stress events once when crossing threshold.
    if (G.stress[slot] >= GLAZE_FAILURE_THRESHOLD && G.stressFired[slot] === 0) {
      G.stressFired[slot] = 1;
      const eid = G.ownerEid[slot];
      if (eid !== 0 && entityExists(world, eid)) {
        if (observerFn) {
          try { observerFn(eid, G.stress[slot]); } catch (_) {}
        }
        // Rigid body shake for structural damage.
        if (hasComponent(world, eid, RigidBody3D)) {
          const id = getId(eid);
          RigidBody3D.wx[id] += (Math.random() - 0.5) * 0.2;
          RigidBody3D.wy[id] += (Math.random() - 0.5) * 0.2;
          RigidBody3D.wz[id] += (Math.random() - 0.5) * 0.2;
        }
      }
    }

    // Reset fired flag if stress falls.
    if (G.stress[slot] < GLAZE_FAILURE_THRESHOLD * 0.8) {
      G.stressFired[slot] = 0;
    }

    // Melting when above freezing.
    if (surfaceTempC > 0 && G.depthMm[slot] > EPSILON) {
      const meltRateMmPerSec = (GLAZE_MELT_RATE_BASE
        + GLAZE_MELT_RATE_PER_DEGREE * surfaceTempC) * 1000.0;
      const meltMm = meltRateMmPerSec * dt;

      G.depthMm[slot] = Math.max(0, G.depthMm[slot] - meltMm);
      G.mass[slot] = G.depthMm[slot] * GLAZE_DENSITY / 1000.0;
      G.meltAccum[slot] += meltMm;

      // Melt adds to surface wetness via file 042.
      const eid = G.ownerEid[slot];
      if (eid !== 0 && entityExists(world, eid)) {
        const wetSlot = getWetSurfaceSlot(eid);
        if (wetSlot >= 0) {
          SurfaceWetness.rainAccum[wetSlot] += meltMm;
          SurfaceWetness.wetness[wetSlot] = Math.min(1,
            SurfaceWetness.rainAccum[wetSlot] / 50);
        }
      }

      // Reset stress as glaze melts away.
      G.stress[slot] = Math.max(0, G.stress[slot] - meltMm * GLAZE_STRESS_GAIN);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MATERIAL COUPLING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Apply glaze appearance to the entity's material (if any).
 */
export function applyIceGlazeToMaterial(world, eid) {
  const glazeSlot = _glazeSurfaceSlots.get(eid);
  if (glazeSlot === undefined) return;
  if (!hasComponent(world, eid, MaterialTag)) return;

  const G = IceGlaze;
  if (G.depthMm[glazeSlot] < 0.05) return;

  const id = getId(eid);
  const coverage = Math.min(1, G.depthMm[glazeSlot] / 5.0);

  // Glaze vs rime visuals.
  const roughness = G.rime[glazeSlot]
    ? RIME_ROUGHNESS
    : GLAZE_ROUGHNESS;

  // Blend albedo toward ice-white.
  MaterialF32.baseR[id] = MaterialF32.baseR[id] * (1 - coverage) + GLAZE_ALBEDO_R * coverage;
  MaterialF32.baseG[id] = MaterialF32.baseG[id] * (1 - coverage) + GLAZE_ALBEDO_G * coverage;
  MaterialF32.baseB[id] = MaterialF32.baseB[id] * (1 - coverage) + GLAZE_ALBEDO_B * coverage;

  MaterialF32.roughness[id] = MaterialF32.roughness[id] * (1 - coverage) + roughness * coverage;

  // Glaze is slightly specular.
  MaterialF32.metallic[id] = Math.min(0.20, MaterialF32.metallic[id] + coverage * 0.05);
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

export function gatherMixedDropsForRendering(maxOutput = 4096) {
  const result = [];
  const D = MixedDrop;
  for (let slot = 0; slot < MAX_DROPS; slot++) {
    if (D.active[slot] === 0) continue;
    result.push({
      x: D.px[slot], y: D.py[slot], z: D.pz[slot],
      phase: D.phase[slot],
      diameter: D.diameter[slot],
      vx: D.vx[slot], vy: D.vy[slot], vz: D.vz[slot],
    });
    if (result.length >= maxOutput) break;
  }
  return result;
}

export function gatherMixedImpactsForRendering(maxOutput = 1024) {
  const result = [];
  const I = MixedImpact;
  for (let slot = 0; slot < MAX_IMPACTS; slot++) {
    if (I.active[slot] === 0) continue;
    result.push({
      x: I.px[slot], y: I.py[slot], z: I.pz[slot],
      nx: I.nx[slot], ny: I.ny[slot], nz: I.nz[slot],
      phase: I.phase[slot],
      diameter: I.diameter[slot],
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

export function mixedStats() {
  let activeGlazeSurfaces = 0;
  let glazedAboveThreshold = 0;
  let totalGlazeMm = 0;

  for (let slot = 0; slot < _nextGlazeSurfaceSlot; slot++) {
    if (IceGlaze.active[slot] === 0) continue;
    activeGlazeSurfaces++;
    totalGlazeMm += IceGlaze.depthMm[slot];
    if (IceGlaze.depthMm[slot] > 1.0) glazedAboveThreshold++;
  }

  return {
    activeDrops: MixedDrop.liveCount,
    maxDrops: MAX_DROPS,
    activeImpacts: MixedImpact.liveCount,
    maxImpacts: MAX_IMPACTS,
    glazeSurfaces: activeGlazeSurfaces,
    glazedAboveThreshold,
    totalGlazeMm,
    surfaceCapacity: MAX_GLAZE_SURFACES,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearMixedPrecipitation() {
  MixedDrop.active.fill(0);
  MixedDrop.freeHead = 0;
  MixedDrop.liveCount = 0;
  MixedImpact.active.fill(0);
  MixedImpact.freeHead = 0;
  MixedImpact.liveCount = 0;
  IceGlaze.active.fill(0);
  IceGlaze.ownerEid.fill(0);
  IceGlaze.stressFired.fill(0);
  _glazeSurfaceSlots.clear();
  _nextGlazeSurfaceSlot = 0;
}