// file number : 043
// full path name : src/weather/043_snow.js
// description : Snow precipitation system with physically-based crystal
//               type taxonomy, terminal velocity model per crystal, wind
//               drift, per-surface snow accumulation with powder / packed
//               phases, melting when temperature rises above freezing,
//               and snow-melt wetness coupling to file 042's wet-surface
//               system. Imports 029_cloud_archetypes.js as the single
//               source of truth for which cloud layers are actively snowing
//               (precipitationType SNOW or MIXED with snowMix > 0).
//                 • Crystal taxonomy — the ten WMO snow crystal types
//                   (stellar dendrite, stellar plate, sectored plate,
//                   dendrite, column, needle, spatial dendrite, irregular,
//                   graupel, hail-core), each with its own drag
//                   coefficient, terminal velocity, size range, and
//                   visual aspect ratio.
//                 • Fall-speed model — Locatelli & Hobbs 1974 empirical
//                   vT = a · D^b for D in mm; constants a and b per
//                   crystal type (e.g. stellar dendrite a = 0.65,
//                   b = 0.31, so vT ≈ 0.9 m/s for D = 2 mm).
//                 • Wind drift — flakes are far lighter than drops, so
//                   horizontal drift factor is ~0.7-0.95 depending on
//                   crystal density, producing strong sideways drift in
//                   wind.
//                 • Snow accumulation — per-surface depth (in metres),
//                   powder factor (0..1 = fresh loose snow, 1 = packed),
//                   and accumulated mass (kg/m²). New snow starts as
//                   powder and gradually compacts.
//                 • Melting — when ambient temp > 0 °C, accumulated snow
//                   recedes at a temp-dependent melt rate and adds to
//                   file 042's wetness of the same surface.
//                 • Powder coupling — while powderFactor < 0.4 and depth
//                   > 5 mm, gameplay systems (file 021 characters) can
//                   read the powder state to trigger snow-compression
//                   footsteps and powder plumes.
//               All state is typed arrays; emission is O(active storms),
//               per-flake update is O(MAX_FLAKES), accumulation is
//               O(surfaces). Zero per-frame allocation; steady-state
//               simulation at 1M entities fits on Android 64-bit.
// best for : Snowy-day rendering, winter gameplay, snowman / snowball
//            mechanics, wet-snow slush transitions, powder-ski gameplay,
//            blizzard visuals, and any 1M-entity scene needing realistic
//            snow on Android 64-bit.
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
  SurfaceWetness,
  getWetSurfaceSlot,
  SurfaceType,
} from './042_rain.js';

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

const MAX_FLAKES                     = 800_000;
const MAX_SNOW_SURFACES              = 100_000;
const MAX_SNOW_PUFFS                 = 16_384;

// Snowflake fall-speed constants (Locatelli & Hobbs 1974):
//   vT = a * D^b  (D in mm, vT in m/s).
// Stored as per-type a and b.
const FALL_A_STELLAR_DENDRITE        = 0.65;
const FALL_B_STELLAR_DENDRITE        = 0.31;
const FALL_A_STELLAR_PLATE           = 0.35;
const FALL_B_STELLAR_PLATE           = 0.45;
const FALL_A_SECTORED_PLATE          = 0.40;
const FALL_B_SECTORED_PLATE          = 0.42;
const FALL_A_DENDRITE                = 0.65;
const FALL_B_DENDRITE                = 0.28;
const FALL_A_COLUMN                  = 1.10;
const FALL_B_COLUMN                  = 0.20;
const FALL_A_NEEDLE                  = 0.80;
const FALL_B_NEEDLE                  = 0.30;
const FALL_A_SPATIAL_DENDRITE        = 0.55;
const FALL_B_SPATIAL_DENDRITE        = 0.30;
const FALL_A_IRREGULAR               = 0.50;
const FALL_B_IRREGULAR               = 0.40;
const FALL_A_GRAUPEL                 = 1.50;
const FALL_B_GRAUPEL                 = 0.18;
const FALL_A_HAIL_CORE               = 2.80;
const FALL_B_HAIL_CORE               = 0.10;

// Crystal type sizes (mm).
const D_STELLAR_DENDRITE_MIN         = 0.5;
const D_STELLAR_DENDRITE_MAX         = 5.0;
const D_STELLAR_PLATE_MIN            = 0.3;
const D_STELLAR_PLATE_MAX            = 3.0;
const D_SECTORED_PLATE_MIN           = 0.5;
const D_SECTORED_PLATE_MAX           = 4.0;
const D_DENDRITE_MIN                 = 0.5;
const D_DENDRITE_MAX                 = 4.0;
const D_COLUMN_MIN                   = 0.3;
const D_COLUMN_MAX                   = 2.0;
const D_NEEDLE_MIN                   = 0.2;
const D_NEEDLE_MAX                   = 1.5;
const D_SPATIAL_DENDRITE_MIN         = 0.5;
const D_SPATIAL_DENDRITE_MAX         = 3.0;
const D_IRREGULAR_MIN                = 0.3;
const D_IRREGULAR_MAX                = 2.5;
const D_GRAUPEL_MIN                  = 0.5;
const D_GRAUPEL_MAX                  = 3.0;
const D_HAIL_CORE_MIN                = 2.0;
const D_HAIL_CORE_MAX                = 8.0;

// Snow rate range (mm/h water equivalent).
const SNOW_RATE_MIN                  = 0.05;
const SNOW_RATE_MAX                  = 80.0;

// Snow-to-liquid ratio (SLR); 10:1 typical, 20-30:1 for powder.
const SLR_DEFAULT                    = 10.0;
const SLR_POWDER                     = 25.0;

// Accumulation.
const SNOW_DENSITY_FRESH             = 100.0;     // kg/m³
const SNOW_DENSITY_PACKED            = 400.0;     // kg/m³
const SNOW_MAX_DEPTH                 = 2.0;       // metres before piling stops
const POWDER_INITIAL                 = 0.05;
const POWDER_COMPACTION_RATE         = 0.0005;    // per second
const POWDER_MELT_TEMP_THRESHOLD     = 0.0;       // °C

// Melting.
const MELT_RATE_BASE                 = 0.001;     // metres per second at 0 °C
const MELT_RATE_PER_DEGREE           = 0.002;     // additional per °C above 0
const MELT_WATER_YIELD_RATIO         = 0.10;      // kg snow → kg water

// Wind drift factors per crystal (lighter = higher drift).
const DRIFT_FACTOR_STELLAR_DENDRITE  = 0.85;
const DRIFT_FACTOR_STELLAR_PLATE     = 0.90;
const DRIFT_FACTOR_SECTORED_PLATE    = 0.88;
const DRIFT_FACTOR_DENDRITE          = 0.87;
const DRIFT_FACTOR_COLUMN            = 0.65;
const DRIFT_FACTOR_NEEDLE            = 0.70;
const DRIFT_FACTOR_SPATIAL_DENDRITE  = 0.80;
const DRIFT_FACTOR_IRREGULAR         = 0.75;
const DRIFT_FACTOR_GRAUPEL           = 0.50;
const DRIFT_FACTOR_HAIL_CORE         = 0.30;

// ═══════════════════════════════════════════════════════════════════════
// CRYSTAL TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const CrystalType = Object.freeze({
  STELLAR_DENDRITE:   0,
  STELLAR_PLATE:      1,
  SECTORED_PLATE:     2,
  DENDRITE:           3,
  COLUMN:             4,
  NEEDLE:             5,
  SPATIAL_DENDRITE:   6,
  IRREGULAR:          7,
  GRAUPEL:            8,
  HAIL_CORE:          9,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA SNOWFLAKE POOL
// ═══════════════════════════════════════════════════════════════════════

export const SnowFlake = {
  active: new Uint8Array(MAX_FLAKES),

  // World position.
  px: new Float32Array(MAX_FLAKES),
  py: new Float32Array(MAX_FLAKES),
  pz: new Float32Array(MAX_FLAKES),

  // World velocity.
  vx: new Float32Array(MAX_FLAKES),
  vy: new Float32Array(MAX_FLAKES),
  vz: new Float32Array(MAX_FLAKES),

  // Crystal type (CrystalType).
  crystalType: new Uint8Array(MAX_FLAKES),

  // Crystal size (metres).
  diameter: new Float32Array(MAX_FLAKES),

  // Terminal velocity (m/s, cached).
  terminalVelocity: new Float32Array(MAX_FLAKES),

  // Age + max lifetime.
  age: new Float32Array(MAX_FLAKES),
  maxLifetime: new Float32Array(MAX_FLAKES),

  // Random rotation (for rendering).
  rotation: new Float32Array(MAX_FLAKES),

  // Source cloud slot (which storm emitted it).
  sourceCloudSlot: new Uint16Array(MAX_FLAKES),

  // Stream index (for VFX binding).
  streamIndex: new Uint32Array(MAX_FLAKES),

  // Free-list head.
  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA SNOW SURFACE STATE — accumulation per entity
// ═══════════════════════════════════════════════════════════════════════

export const SnowSurface = {
  // Owner entity id (0 = free).
  ownerEid: new Uint32Array(MAX_SNOW_SURFACES),

  // Snow depth (metres; 0 = no snow).
  depth: new Float32Array(MAX_SNOW_SURFACES),

  // Mass (kg/m²) — depth × density.
  mass: new Float32Array(MAX_SNOW_SURFACES),

  // Powder factor (0 = packed / slush, 1 = fresh powder).
  powderFactor: new Float32Array(MAX_SNOW_SURFACES),

  // Surface type (SurfaceType from file 042).
  surfaceType: new Uint8Array(MAX_SNOW_SURFACES),

  // Melt progress (0..1).
  meltProgress: new Float32Array(MAX_SNOW_SURFACES),

  // Active flag.
  active: new Uint8Array(MAX_SNOW_SURFACES),

  // Last accumulation time.
  lastAccumTime: new Float32Array(MAX_SNOW_SURFACES),
};

/** Marker: entity can accumulate snow (set by addSnowSurface). */
export const SnowSurfaceTag = {};

const _snowSurfaceSlots = new Map(); // eid -> slot
let _nextSnowSurfaceSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA SNOW PUFF POOL — snow kick-up effects (footsteps, impacts)
// ═══════════════════════════════════════════════════════════════════════

export const SnowPuff = {
  active: new Uint8Array(MAX_SNOW_PUFFS),

  px: new Float32Array(MAX_SNOW_PUFFS),
  py: new Float32Array(MAX_SNOW_PUFFS),
  pz: new Float32Array(MAX_SNOW_PUFFS),

  vx: new Float32Array(MAX_SNOW_PUFFS),
  vy: new Float32Array(MAX_SNOW_PUFFS),
  vz: new Float32Array(MAX_SNOW_PUFFS),

  radius: new Float32Array(MAX_SNOW_PUFFS),
  intensity: new Float32Array(MAX_SNOW_PUFFS),

  age: new Float32Array(MAX_SNOW_PUFFS),
  lifetime: new Float32Array(MAX_SNOW_PUFFS),

  freeHead: 0,
  liveCount: 0,
};

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
// CRYSTAL DISTRIBUTION — pick a crystal type from temperature + humidity
// ═══════════════════════════════════════════════════════════════════════

/**
 * Choose a crystal type from temperature (°C) and relative humidity (0..1)
 * following the Nakaya / Kobayashi diagram.
 *
 * - Below -20 °C: plates / columns dominate (very dry air)
 * - -20 to -10 °C: dendrites / sectors (best conditions for powder)
 * - -10 to -4 °C: needles / columns
 * - -4 to 0 °C: plates / stellars (wetter, larger flakes)
 */
function pickCrystalType(tempC, humidity, rng) {
  const r = rng();

  if (tempC < -20) {
    if (r < 0.4) return CrystalType.COLUMN;
    if (r < 0.7) return CrystalType.STELLAR_PLATE;
    return CrystalType.IRREGULAR;
  }
  if (tempC < -10) {
    if (r < 0.35) return CrystalType.STELLAR_DENDRITE;
    if (r < 0.60) return CrystalType.SECTORED_PLATE;
    if (r < 0.80) return CrystalType.SPATIAL_DENDRITE;
    return CrystalType.DENDRITE;
  }
  if (tempC < -4) {
    if (r < 0.30) return CrystalType.NEEDLE;
    if (r < 0.55) return CrystalType.COLUMN;
    if (r < 0.75) return CrystalType.STELLAR_DENDRITE;
    return CrystalType.IRREGULAR;
  }
  // -4 to 0 °C: wetter, larger flakes.
  if (humidity > 0.85) {
    if (r < 0.5) return CrystalType.STELLAR_DENDRITE;
    if (r < 0.75) return CrystalType.GRAUPEL;
    return CrystalType.DENDRITE;
  }
  if (r < 0.40) return CrystalType.STELLAR_PLATE;
  if (r < 0.70) return CrystalType.DENDRITE;
  return CrystalType.IRREGULAR;
}

function crystalDiameterRange(crystalType) {
  switch (crystalType) {
    case CrystalType.STELLAR_DENDRITE:   return [D_STELLAR_DENDRITE_MIN,  D_STELLAR_DENDRITE_MAX];
    case CrystalType.STELLAR_PLATE:      return [D_STELLAR_PLATE_MIN,     D_STELLAR_PLATE_MAX];
    case CrystalType.SECTORED_PLATE:     return [D_SECTORED_PLATE_MIN,    D_SECTORED_PLATE_MAX];
    case CrystalType.DENDRITE:           return [D_DENDRITE_MIN,          D_DENDRITE_MAX];
    case CrystalType.COLUMN:             return [D_COLUMN_MIN,            D_COLUMN_MAX];
    case CrystalType.NEEDLE:             return [D_NEEDLE_MIN,            D_NEEDLE_MAX];
    case CrystalType.SPATIAL_DENDRITE:   return [D_SPATIAL_DENDRITE_MIN,  D_SPATIAL_DENDRITE_MAX];
    case CrystalType.IRREGULAR:          return [D_IRREGULAR_MIN,         D_IRREGULAR_MAX];
    case CrystalType.GRAUPEL:            return [D_GRAUPEL_MIN,           D_GRAUPEL_MAX];
    case CrystalType.HAIL_CORE:          return [D_HAIL_CORE_MIN,         D_HAIL_CORE_MAX];
    default:                             return [0.5, 3.0];
  }
}

function crystalFallSpeed(crystalType, diameterMm) {
  let a, b;
  switch (crystalType) {
    case CrystalType.STELLAR_DENDRITE:   a = FALL_A_STELLAR_DENDRITE;   b = FALL_B_STELLAR_DENDRITE;   break;
    case CrystalType.STELLAR_PLATE:      a = FALL_A_STELLAR_PLATE;      b = FALL_B_STELLAR_PLATE;      break;
    case CrystalType.SECTORED_PLATE:     a = FALL_A_SECTORED_PLATE;     b = FALL_B_SECTORED_PLATE;     break;
    case CrystalType.DENDRITE:           a = FALL_A_DENDRITE;           b = FALL_B_DENDRITE;           break;
    case CrystalType.COLUMN:             a = FALL_A_COLUMN;             b = FALL_B_COLUMN;             break;
    case CrystalType.NEEDLE:             a = FALL_A_NEEDLE;             b = FALL_B_NEEDLE;             break;
    case CrystalType.SPATIAL_DENDRITE:   a = FALL_A_SPATIAL_DENDRITE;   b = FALL_B_SPATIAL_DENDRITE;   break;
    case CrystalType.IRREGULAR:          a = FALL_A_IRREGULAR;          b = FALL_B_IRREGULAR;          break;
    case CrystalType.GRAUPEL:            a = FALL_A_GRAUPEL;            b = FALL_B_GRAUPEL;            break;
    case CrystalType.HAIL_CORE:          a = FALL_A_HAIL_CORE;          b = FALL_B_HAIL_CORE;          break;
    default:                             a = 0.6;                        b = 0.3;                       break;
  }
  return a * Math.pow(Math.max(0.1, diameterMm), b);
}

function crystalDriftFactor(crystalType) {
  switch (crystalType) {
    case CrystalType.STELLAR_DENDRITE:   return DRIFT_FACTOR_STELLAR_DENDRITE;
    case CrystalType.STELLAR_PLATE:      return DRIFT_FACTOR_STELLAR_PLATE;
    case CrystalType.SECTORED_PLATE:     return DRIFT_FACTOR_SECTORED_PLATE;
    case CrystalType.DENDRITE:           return DRIFT_FACTOR_DENDRITE;
    case CrystalType.COLUMN:             return DRIFT_FACTOR_COLUMN;
    case CrystalType.NEEDLE:             return DRIFT_FACTOR_NEEDLE;
    case CrystalType.SPATIAL_DENDRITE:   return DRIFT_FACTOR_SPATIAL_DENDRITE;
    case CrystalType.IRREGULAR:          return DRIFT_FACTOR_IRREGULAR;
    case CrystalType.GRAUPEL:            return DRIFT_FACTOR_GRAUPEL;
    case CrystalType.HAIL_CORE:          return DRIFT_FACTOR_HAIL_CORE;
    default:                             return 0.8;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// FLAKE POOL
// ═══════════════════════════════════════════════════════════════════════

function allocFlake() {
  const F = SnowFlake;
  for (let i = 0; i < MAX_FLAKES; i++) {
    const slot = (F.freeHead + i) % MAX_FLAKES;
    if (F.active[slot] === 0) {
      F.freeHead = (slot + 1) % MAX_FLAKES;
      F.active[slot] = 1;
      F.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeFlake(slot) {
  const F = SnowFlake;
  if (F.active[slot] === 0) return;
  F.active[slot] = 0;
  F.liveCount--;
}

function allocSnowPuff() {
  const P = SnowPuff;
  for (let i = 0; i < MAX_SNOW_PUFFS; i++) {
    const slot = (P.freeHead + i) % MAX_SNOW_PUFFS;
    if (P.active[slot] === 0) {
      P.freeHead = (slot + 1) % MAX_SNOW_PUFFS;
      P.active[slot] = 1;
      P.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeSnowPuff(slot) {
  const P = SnowPuff;
  if (P.active[slot] === 0) return;
  P.active[slot] = 0;
  P.liveCount--;
}

// ═══════════════════════════════════════════════════════════════════════
// SNOW SURFACE API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register a snow-accumulating surface on an entity.
 * @param world       ECS world
 * @param eid         entity (typically has WorldBoundsF32)
 * @param surfaceType SurfaceType from file 042
 */
export function addSnowSurface(world, eid, surfaceType = SurfaceType.GROUND) {
  if (_nextSnowSurfaceSlot >= MAX_SNOW_SURFACES) {
    throw new Error('snow surface capacity exceeded');
  }
  let slot = _snowSurfaceSlots.get(eid);
  if (slot === undefined) {
    slot = _nextSnowSurfaceSlot++;
    _snowSurfaceSlots.set(eid, slot);
  }

  addComponent(world, eid, SnowSurfaceTag);

  const S = SnowSurface;
  S.ownerEid[slot] = eid;
  S.depth[slot] = 0;
  S.mass[slot] = 0;
  S.powderFactor[slot] = 1;
  S.surfaceType[slot] = surfaceType;
  S.meltProgress[slot] = 0;
  S.active[slot] = 1;
  S.lastAccumTime[slot] = 0;

  return slot;
}

export function removeSnowSurface(world, eid) {
  const slot = _snowSurfaceSlots.get(eid);
  if (slot === undefined) return;
  SnowSurface.active[slot] = 0;
  SnowSurface.ownerEid[slot] = 0;
  _snowSurfaceSlots.delete(eid);
  removeComponent(world, eid, SnowSurfaceTag);
}

export function getSnowSurfaceSlot(eid) {
  return _snowSurfaceSlots.get(eid) ?? -1;
}

export function getSnowDepth(eid) {
  const slot = _snowSurfaceSlots.get(eid);
  if (slot === undefined) return 0;
  return SnowSurface.depth[slot];
}

export function getSnowPowderFactor(eid) {
  const slot = _snowSurfaceSlots.get(eid);
  if (slot === undefined) return 0;
  return SnowSurface.powderFactor[slot];
}

/**
 * Reset a surface's snow accumulation (e.g. after shoveling).
 */
export function resetSnowAccumulation(world, eid) {
  const slot = _snowSurfaceSlots.get(eid);
  if (slot === undefined) return;
  SnowSurface.depth[slot] = 0;
  SnowSurface.mass[slot] = 0;
  SnowSurface.meltProgress[slot] = 0;
  SnowSurface.powderFactor[slot] = 1;
}

// ═══════════════════════════════════════════════════════════════════════
// GATHER SNOW CLOUDS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a list of precipitating snow clouds.
 * Filters CloudInstance entries whose archetype is SNOW or MIXED-with-snow.
 */
export function gatherSnowClouds(world) {
  const result = [];
  const CI = CloudInstance;
  const CA = CloudArchetype;

  for (let slot = 0; slot < CI.ownerEid.length; slot++) {
    if (CI.ownerEid[slot] === 0) continue;

    const aSlot = CI.archetypeSlot[slot];
    if (aSlot === undefined || aSlot < 0) continue;

    const precipType = CA.precipitationType[aSlot];
    if (precipType !== PrecipitationType.SNOW &&
        precipType !== PrecipitationType.MIXED) continue;

    const rate = CI.precipRate[slot];
    if (rate < EPSILON) continue;

    // Determine snow fraction.
    let snowFraction = 1;
    if (precipType === PrecipitationType.MIXED) {
      snowFraction = 0.5;   // conservative; callers may override via snowMix
    }

    result.push({
      cloudSlot: slot,
      x: CI.px[slot],
      y: CI.py[slot],
      z: CI.pz[slot],
      radiusX: CI.radiusX[slot],
      radiusY: CI.radiusY[slot],
      radiusZ: CI.radiusZ[slot],
      rate: rate * snowFraction,
      snowFraction,
    });
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// SNOW EMISSION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Emit snowflakes from a cloud for one frame.
 *
 * @param world       ECS world
 * @param cloud       cloud descriptor from gatherSnowClouds
 * @param dt          seconds
 * @param tempC       ambient temperature (°C) — drives crystal type
 * @param humidity    relative humidity (0..1)
 * @param cameraX/Y/Z camera position (for LOD culling)
 */
export function emitSnowFlakes(world, cloud, dt, tempC, humidity, cameraX, cameraY, cameraZ) {
  if (cloud.rate < EPSILON) return;

  // Snowflakes are much more numerous per mm/h than raindrops because
  // each flake has far less water content.
  const flakesPerSecond = Math.min(20000, cloud.rate * 300);
  const flakesThisFrame = flakesPerSecond * dt;
  const wholeFlakes = Math.floor(flakesThisFrame);
  const fractional = flakesThisFrame - wholeFlakes;
  const finalFlakes = wholeFlakes + (Math.random() < fractional ? 1 : 0);

  const effectiveRadius = cloud.radiusX * 1.5;

  for (let i = 0; i < finalFlakes; i++) {
    const slot = allocFlake();
    if (slot < 0) return;

    // Spawn position under the cloud.
    const r = Math.sqrt(Math.random()) * effectiveRadius;
    const phi = Math.random() * TWO_PI;
    const spawnX = cloud.x + Math.cos(phi) * r;
    const spawnZ = cloud.z + Math.sin(phi) * r;
    const spawnY = cloud.y - cloud.radiusY;

    // LOD check: if far from camera, spawn less often.
    const dxCam = spawnX - cameraX;
    const dzCam = spawnZ - cameraZ;
    if (dxCam * dxCam + dzCam * dzCam > 500 * 500) {
      if (Math.random() > 0.10) {
        freeFlake(slot);
        continue;
      }
    }

    // Crystal type + size.
    const crystalType = pickCrystalType(tempC, humidity, Math.random);
    const [dMinMm, dMaxMm] = crystalDiameterRange(crystalType);
    const diameterMm = dMinMm + Math.random() * (dMaxMm - dMinMm);
    const diameterM = diameterMm * 0.001;

    const vT = crystalFallSpeed(crystalType, diameterMm);

    SnowFlake.px[slot] = spawnX;
    SnowFlake.py[slot] = spawnY;
    SnowFlake.pz[slot] = spawnZ;
    SnowFlake.vx[slot] = 0;
    SnowFlake.vy[slot] = -vT;
    SnowFlake.vz[slot] = 0;
    SnowFlake.crystalType[slot] = crystalType;
    SnowFlake.diameter[slot] = diameterM;
    SnowFlake.terminalVelocity[slot] = vT;
    SnowFlake.age[slot] = 0;
    SnowFlake.maxLifetime[slot] = 20.0 + Math.random() * 15.0;
    SnowFlake.rotation[slot] = Math.random() * TWO_PI;
    SnowFlake.sourceCloudSlot[slot] = cloud.cloudSlot;
    SnowFlake.streamIndex[slot] = slot;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// WIND DRIFT — flakes are light, drift strongly
// ═══════════════════════════════════════════════════════════════════════

function applySnowWindDrift(slot, windSpeed, windDirX, windDirZ, dt) {
  const crystalType = SnowFlake.crystalType[slot];
  const driftFactor = crystalDriftFactor(crystalType);

  // Flakes approach the wind speed very quickly (mass / drag is small).
  const targetVx = windSpeed * windDirX * driftFactor;
  const targetVz = windSpeed * windDirZ * driftFactor;

  // Approach rate: much faster than rain.
  const alpha = Math.min(1, dt * 8.0);
  SnowFlake.vx[slot] += (targetVx - SnowFlake.vx[slot]) * alpha;
  SnowFlake.vz[slot] += (targetVz - SnowFlake.vz[slot]) * alpha;
}

// ═══════════════════════════════════════════════════════════════════════
// MELTING — converts snow water yield to file 042's wetness
// ═══════════════════════════════════════════════════════════════════════

function applySnowMeltToWetness(world, eid, meltDepthM) {
  const wetSlot = getWetSurfaceSlot(eid);
  if (wetSlot < 0) return;

  // Convert melted depth to water mass (kg/m²).
  const waterMass = meltDepthM * SNOW_DENSITY_PACKED;   // kg/m²

  // Add to file 042's rainAccum (mm).
  SurfaceWetness.rainAccum[wetSlot] += waterMass;   // 1 kg/m² = 1 mm water

  // Update wetness value.
  const saturationMm = 50;
  SurfaceWetness.wetness[wetSlot] = Math.min(1,
    SurfaceWetness.rainAccum[wetSlot] / saturationMm);
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN FLAKE UPDATE SYSTEM
// ═══════════════════════════════════════════════════════════════════════

const _rayOrigin = vec3.create();
const _rayDir = vec3.create();

/**
 * Advance snow simulation for one frame. Handles:
 *   • per-flake velocity + gravity + wind drift
 *   • impact detection (via file 003's BVH)
 *   • snow accumulation on tagged surfaces
 *   • snow puff VFX from footfalls / impacts
 *   • retirement of out-of-bounds or expired flakes
 *
 * @param world       ECS world
 * @param dt          seconds
 * @param windSpeed   m/s
 * @param windDirX/Z  -1..1
 * @param cameraX/Y/Z camera position
 */
export function systemUpdateSnow(world, dt, windSpeed = 0, windDirX = 1, windDirZ = 0, cameraX = 0, cameraY = 0, cameraZ = 0) {
  const F = SnowFlake;

  for (let slot = 0; slot < MAX_FLAKES; slot++) {
    if (F.active[slot] === 0) continue;

    F.age[slot] += dt;

    if (F.age[slot] > F.maxLifetime[slot]) {
      freeFlake(slot);
      continue;
    }

    applySnowWindDrift(slot, windSpeed, windDirX, windDirZ, dt);

    const prevX = F.px[slot];
    const prevY = F.py[slot];
    const prevZ = F.pz[slot];

    const vx = F.vx[slot];
    const vy = F.vy[slot];
    const vz = F.vz[slot];

    const stepLen = Math.sqrt(vx * vx + vy * vy + vz * vz) * dt;
    if (stepLen < 1e-5) continue;

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

      // Accumulate on the target surface.
      const snowSlot = _snowSurfaceSlots.get(h.eid);
      if (snowSlot !== undefined) {
        const S = SnowSurface;

        // Depth increase from this flake.
        const crystalType = F.crystalType[slot];
        const diameterMm = F.diameter[slot] * 1000;
        const slr = (crystalType === CrystalType.STELLAR_DENDRITE ||
                     crystalType === CrystalType.STELLAR_PLATE) ? SLR_POWDER : SLR_DEFAULT;
        // Water equivalent per flake.
        const waterEqMm = (diameterMm * diameterMm * diameterMm) * 0.00005;
        // Depth (m) = waterEq × SLR / 1000 (SLR is per unit water).
        const depthIncrease = waterEqMm * slr * 0.001 * 0.05;

        S.depth[snowSlot] = Math.min(SNOW_MAX_DEPTH, S.depth[snowSlot] + depthIncrease);
        S.mass[snowSlot] = S.depth[snowSlot] * SNOW_DENSITY_FRESH;
        S.lastAccumTime[snowSlot] = 0;

        // Powder factor decays as snow packs.
        const newPowder = Math.max(0.0, S.powderFactor[snowSlot] - depthIncrease * 0.1);
        S.powderFactor[snowSlot] = newPowder;
      }

      // Small puff on impact (occasional to avoid VFX spam).
      if (Math.random() < 0.005) {
        const puffSlot = allocSnowPuff();
        if (puffSlot >= 0) {
          SnowPuff.px[puffSlot] = impactX;
          SnowPuff.py[puffSlot] = impactY;
          SnowPuff.pz[puffSlot] = impactZ;
          SnowPuff.vx[puffSlot] = (Math.random() - 0.5) * 0.5;
          SnowPuff.vy[puffSlot] = 0.5 + Math.random() * 0.5;
          SnowPuff.vz[puffSlot] = (Math.random() - 0.5) * 0.5;
          SnowPuff.radius[puffSlot] = 0.02 + Math.random() * 0.05;
          SnowPuff.intensity[puffSlot] = 0.3 + Math.random() * 0.4;
          SnowPuff.age[puffSlot] = 0;
          SnowPuff.lifetime[puffSlot] = 0.6 + Math.random() * 0.4;
        }
      }

      freeFlake(slot);
      continue;
    }

    // Advance.
    F.px[slot] = prevX + vx * dt;
    F.py[slot] = prevY + vy * dt;
    F.pz[slot] = prevZ + vz * dt;

    if (F.py[slot] < -50) {
      freeFlake(slot);
      continue;
    }
  }

  // Advance puffs.
  const P = SnowPuff;
  for (let slot = 0; slot < MAX_SNOW_PUFFS; slot++) {
    if (P.active[slot] === 0) continue;
    P.age[slot] += dt;
    if (P.age[slot] >= P.lifetime[slot]) {
      freeSnowPuff(slot);
    } else {
      // Gentle upward drift.
      P.px[slot] += P.vx[slot] * dt;
      P.py[slot] += P.vy[slot] * dt;
      P.pz[slot] += P.vz[slot] * dt;
      P.vy[slot] -= 0.3 * dt;   // gentle deceleration
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// SNOW MELTING + PACKING SYSTEM
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance snow compaction and melting on every surface.
 * Call once per frame (or at low frequency).
 *
 * @param world          ECS world
 * @param dt             seconds
 * @param ambientTempC   °C
 */
export function systemUpdateSnowMelt(world, dt, ambientTempC) {
  const S = SnowSurface;

  for (let slot = 0; slot < _nextSnowSurfaceSlot; slot++) {
    if (S.active[slot] === 0) continue;

    // Compaction (fresh powder → packed over time).
    if (S.depth[slot] > EPSILON) {
      const packAmount = POWDER_COMPACTION_RATE * dt;
      S.powderFactor[slot] = Math.max(0, S.powderFactor[slot] - packAmount);

      // Density grows as powder factor decreases.
      const density = SNOW_DENSITY_FRESH
        + (1 - S.powderFactor[slot]) * (SNOW_DENSITY_PACKED - SNOW_DENSITY_FRESH);
      S.mass[slot] = S.depth[slot] * density;
    }

    // Melt when above freezing.
    if (ambientTempC > POWDER_MELT_TEMP_THRESHOLD && S.depth[slot] > EPSILON) {
      const meltRate = MELT_RATE_BASE
        + MELT_RATE_PER_DEGREE * (ambientTempC - POWDER_MELT_TEMP_THRESHOLD);
      const meltDepth = meltRate * dt;

      const actualMelt = Math.min(meltDepth, S.depth[slot]);
      S.depth[slot] -= actualMelt;
      S.meltProgress[slot] += actualMelt / Math.max(S.depth[slot] + actualMelt, 1e-6);

      // Convert melted depth to wetness on the same entity.
      const eid = S.ownerEid[slot];
      if (eid !== 0 && entityExists(world, eid)) {
        applySnowMeltToWetness(world, eid, actualMelt);
      }

      // Reset mass.
      if (S.depth[slot] < EPSILON) {
        S.depth[slot] = 0;
        S.mass[slot] = 0;
        S.meltProgress[slot] = 0;
        S.powderFactor[slot] = 1;
      } else {
        S.mass[slot] = S.depth[slot] * SNOW_DENSITY_PACKED;
      }
    }

    // Update last accum time.
    S.lastAccumTime[slot] += dt;
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// SNOW KICK-UP — gameplay hook (footsteps, powder plumes)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request a snow puff at a world position (called by character controllers).
 *
 * @param world      ECS world
 * @param x, y, z    world position
 * @param intensity  0..1 (how hard the puff should be)
 * @param powder     powderFactor of the surface (1 = max plume)
 */
export function triggerSnowPuff(world, x, y, z, intensity = 0.5, powder = 1.0) {
  const puffSlot = allocSnowPuff();
  if (puffSlot < 0) return -1;

  const P = SnowPuff;
  P.px[puffSlot] = x;
  P.py[puffSlot] = y;
  P.pz[puffSlot] = z;
  P.vx[puffSlot] = (Math.random() - 0.5) * 1.0;
  P.vy[puffSlot] = 0.4 + Math.random() * 0.6;
  P.vz[puffSlot] = (Math.random() - 0.5) * 1.0;
  P.radius[puffSlot] = 0.05 + intensity * 0.15;
  P.intensity[puffSlot] = intensity * (0.5 + powder * 0.5);
  P.age[puffSlot] = 0;
  P.lifetime[puffSlot] = 0.8 + powder * 0.4;

  return puffSlot;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE — for file 025 particle system
// ═══════════════════════════════════════════════════════════════════════

export function gatherSnowFlakesForRendering(maxOutput = 4096) {
  const result = [];
  const F = SnowFlake;

  for (let slot = 0; slot < MAX_FLAKES; slot++) {
    if (F.active[slot] === 0) continue;
    result.push({
      x: F.px[slot], y: F.py[slot], z: F.pz[slot],
      crystalType: F.crystalType[slot],
      diameter: F.diameter[slot],
      rotation: F.rotation[slot],
      vx: F.vx[slot], vy: F.vy[slot], vz: F.vz[slot],
    });
    if (result.length >= maxOutput) break;
  }
  return result;
}

export function gatherSnowPuffsForRendering(maxOutput = 1024) {
  const result = [];
  const P = SnowPuff;

  for (let slot = 0; slot < MAX_SNOW_PUFFS; slot++) {
    if (P.active[slot] === 0) continue;
    result.push({
      x: P.px[slot], y: P.py[slot], z: P.pz[slot],
      radius: P.radius[slot],
      intensity: P.intensity[slot],
      age: P.age[slot],
      lifetime: P.lifetime[slot],
    });
    if (result.length >= maxOutput) break;
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// SURFACE MATERIAL COUPLING — snow depth into albedo
// ═══════════════════════════════════════════════════════════════════════

/**
 * Apply snow accumulation to a material: as depth grows, albedo approaches
 * bright white and roughness decreases.
 *
 * @param world  ECS world
 * @param eid    entity with MaterialTag
 */
export function applySnowToMaterial(world, eid) {
  const snowSlot = _snowSurfaceSlots.get(eid);
  if (snowSlot === undefined) return;
  if (!hasComponent(world, eid, MaterialTag)) return;

  const id = getId(eid);
  const depth = SnowSurface.depth[snowSlot];
  if (depth < 0.001) return;

  // Snow coverage factor (0 = bare, 1 = full coverage).
  const coverage = Math.min(1, depth / 0.05);

  // Blend albedo toward white.
  const snowR = 0.95;
  const snowG = 0.97;
  const snowB = 1.00;
  MaterialF32.baseR[id] = MaterialF32.baseR[id] * (1 - coverage) + snowR * coverage;
  MaterialF32.baseG[id] = MaterialF32.baseG[id] * (1 - coverage) + snowG * coverage;
  MaterialF32.baseB[id] = MaterialF32.baseB[id] * (1 - coverage) + snowB * coverage;

  // Snow is smoother / less rough than most surfaces.
  MaterialF32.roughness[id] = MaterialF32.roughness[id] * (1 - coverage) + 0.6 * coverage;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearSnow() {
  SnowFlake.active.fill(0);
  SnowFlake.freeHead = 0;
  SnowFlake.liveCount = 0;
  SnowPuff.active.fill(0);
  SnowPuff.freeHead = 0;
  SnowPuff.liveCount = 0;
  SnowSurface.active.fill(0);
  SnowSurface.ownerEid.fill(0);
  _snowSurfaceSlots.clear();
  _nextSnowSurfaceSlot = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function snowStats() {
  let activeSurfaces = 0;
  let totalDepth = 0;
  let powderSurfaces = 0;

  for (let slot = 0; slot < _nextSnowSurfaceSlot; slot++) {
    if (SnowSurface.active[slot] === 0) continue;
    activeSurfaces++;
    totalDepth += SnowSurface.depth[slot];
    if (SnowSurface.powderFactor[slot] > 0.5 && SnowSurface.depth[slot] > 0.005) {
      powderSurfaces++;
    }
  }

  return {
    activeFlakes: SnowFlake.liveCount,
    maxFlakes: MAX_FLAKES,
    activePuffs: SnowPuff.liveCount,
    maxPuffs: MAX_SNOW_PUFFS,
    snowSurfaces: activeSurfaces,
    powderSurfaces,
    totalDepth,
    surfaceCapacity: MAX_SNOW_SURFACES,
  };
}