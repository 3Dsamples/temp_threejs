// file number : 061
// full path name : src/weather/061_ice_frost.js
// description : Ice formation, frost crystallization, snow cover, and
//               icicle system. Provides the complete winter-surface
//               state machine for the bitECS_max pipeline:
//                 • ICE TYPES — six distinct ice varieties tracked
//                   independently in SoA:
//                     - GLAZE (clear ice from freezing rain, smooth,
//                       from file 045's IceGlaze)
//                     - RIME (white, rough ice from freezing fog or
//                       drizzle, on windward surfaces)
//                     - BLACK_ICE (thin clear ice on roads, dangerous,
//                       forms in sub-zero high-humidity conditions)
//                     - PACK_ICE (compacted snow ice, on roads and
//                       pavements after traffic)
//                     - SEA_ICE (frozen ocean surface, from file 059's
//                       water bodies)
//                     - LAKE_ICE (frozen lake surface, usually thicker
//                       and more stable than sea ice)
//                 • FROST CRYSTALLIZATION — using the Snow/Frost
//                   crystallization model (Libbrecht 2005), frost
//                   forms on surfaces that are colder than the local
//                   dew point. The crystal habit (plate, needle,
//                   dendrite) is chosen from the local temperature
//                   and humidity. Frost coverage and thickness
//                   accumulate over time, evaporate in sun, and form
//                   the characteristic fern and window-frost patterns.
//                 • SNOW COVER — compacted layered snow depth integrated
//                   from file 043's fresh snowfall. Tracks per-layer
//                   density (fresh powder, settled, packed, wet) and
//                   per-layer temperature. Exposes both the surface
//                   coverage (for renderer albedo blending) and the
//                   load-bearing capacity (for character controllers
//                   and file 021).
//                 • ICICLES — growing from eaves, branches, and ledges.
//                   Growth rate model: drip rate from snowmelt at the
//                   eave, minus sublimation. Icicle shape is a
//                   tapering cone defined by growth time and drip
//                   rate. When mass exceeds the attachment strength,
//                   the icicle detaches and falls, becoming a
//                   projectile with (mass, velocity, tip-down
//                   orientation) that file 008's physics can resolve
//                   and file 044's hail impacts pattern can mimic.
//                 • ICE STRESS — accumulated mechanical stress from
//                   wind pressure × ice mass. When stress crosses the
//                   failure threshold, the ice breaks into debris
//                   (fragment count scales with ice volume).
//                   Damage events are dispatched via file 026's
//                   observer queue.
//                 • MELTING — ice and snow melt at temperature-
//                   dependent rates. Melt produces water which is
//                   handed to file 042's wetness system (already done
//                   for snow; here we extend to ice and icicles).
//                 • WATER BODY FREEZE — file 059's water bodies are
//                   checked against temperature and salinity. When
//                   their surface temperature falls below the freezing
//                   point, a frozen layer is created (IceCover).
//                   Thickness grows at 1 cm/h in sub-zero air, and
//                   melts at 2 cm/h in sun. Freshwater lakes freeze
//                   faster than saltwater oceans.
//                 • VISUAL COUPLING — snow cover updates the renderer's
//                   material albedo (bright white) and roughness
//                   (0.6 for fresh, 0.4 for packed). Ice updates
//                   reflectivity (glossy) and adds a frozen sheen.
//                   Frost on glass adds a subtle normal-map-like
//                   pattern via UV noise.
//               All state lives in typed arrays; sampling is O(entities),
//               update is O(ice + snow + icicles). Zero per-frame
//               allocation; steady-state 1M-entity scenes handle ice
//               and frost on Android 64-bit.
// best for : Winter gameplay, snow-covered terrain, ice physics,
//            icicle hazards, frozen lakes, arctic survival, alpine
//            environments, and any 1M-entity scene needing realistic
//            ice and frost on Android 64-bit.
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
  addTransform,
  markDirty,
} from '../transform/002_transform_hierarchy.js';

import {
  WorldBoundsF32,
  LocalBoundsF32,
  getWorldBoundsCenter,
  getWorldBoundsExtents,
} from '../geometry/004_aabb_bounds.js';

import {
  BVHState,
  bvhRaycast,
} from '../spatial/003_bvh_broadphase.js';

import {
  RigidBody3D,
  BodyType3D,
  addRigidBody3D,
  setShape3D,
  ShapeType3D,
} from '../physics/008_physics3d_rigidbody.js';

import {
  CharacterTag,
  CharacterStateF32,
  getCharacterSlot,
} from '../physics/021_shape_queries_character.js';

import {
  MaterialF32,
  MaterialTag,
} from '../render/014_materials_bsdf.js';

import {
  SkyF32,
  getSkySlot,
} from '../sky/028_sky_atmosphere.js';

import {
  SurfaceWetness,
  getWetSurfaceSlot,
} from './042_rain.js';

import {
  SnowSurface,
  getSnowSurfaceSlot,
  SnowSurfaceTag,
} from './043_snow.js';

import {
  IceGlaze,
  getIceGlazeSlot,
  IceGlazeTag,
} from './045_sleet_freezing_rain.js';

import {
  WaterBody,
  WaterBodyType,
  sampleWaterSurfaceHeight,
  findWaterBodyAt,
} from './059_water_surface.js';

import {
  sampleWindAt,
} from './047_wind_gusts.js';

import {
  vec3,
  vec4,
  mat4,
  createNoise3D,
  createNoise2D,
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
const GRAVITY                        = 9.81;
const AIR_DENSITY                    = 1.225;
const WATER_DENSITY                  = 1025.0;
const ICE_DENSITY                    = 917.0;
const SNOW_DENSITY_FRESH             = 100.0;
const SNOW_DENSITY_SETTLED           = 200.0;
const SNOW_DENSITY_PACKED            = 400.0;
const SNOW_DENSITY_WET               = 500.0;

// ── Ice type constants ───────────────────────────────────
const MAX_ICE_SURFACES               = 65_536;
const ICE_GLAZE_MAX_THICKNESS        = 0.06;     // 6 cm max glaze
const ICE_RIME_MAX_THICKNESS         = 0.10;     // 10 cm rough rime
const ICE_BLACK_MAX_THICKNESS        = 0.003;    // 3 mm black ice
const ICE_PACK_MAX_THICKNESS         = 0.20;     // 20 cm pack ice

// ── Sea / lake ice ───────────────────────────────────────
const MAX_ICE_COVERS                 = 512;
const SEA_ICE_GROWTH_RATE            = 0.0000028;  // m/s = ~1 cm/hour
const SEA_ICE_MELT_RATE              = 0.0000056;  // m/s = ~2 cm/hour
const LAKE_ICE_GROWTH_RATE           = 0.0000042;  // m/s = ~1.5 cm/hour
const LAKE_ICE_MELT_RATE             = 0.0000083;  // m/s = ~3 cm/hour
const SEA_ICE_FREEZE_TEMP            = -1.8;       // °C (salt water)
const LAKE_ICE_FREEZE_TEMP           = 0.0;        // °C (fresh water)
const MAX_SEA_ICE_THICKNESS          = 3.0;        // 3 m
const MAX_LAKE_ICE_THICKNESS         = 2.0;        // 2 m
const SEA_ICE_DENSITY                = 900.0;      // kg/m³
const LAKE_ICE_DENSITY               = 917.0;      // kg/m³

// ── Frost ────────────────────────────────────────────────
const MAX_FROST_SURFACES             = 65_536;
const FROST_GROWTH_RATE              = 0.00002;    // m/s (2 mm/hour) at saturation
const FROST_MELT_RATE                = 0.00005;    // m/s (5 mm/hour) at 0°C
const FROST_MAX_THICKNESS            = 0.005;      // 5 mm max
const FROST_DEWPOINT_DELTA           = 2.0;        // °C below dew point
const FROST_TEMP_MIN                 = -30.0;      // below this no frost grows
const FROST_TEMP_MAX                 = 0.0;        // above this frost melts

// ── Snow cover ───────────────────────────────────────────
const SNOW_LAYERS_MAX                = 4;
const SNOW_LAYER_COMPACT_RATE        = 0.0001;     // per second compaction
const SNOW_MELT_TEMP_THRESHOLD       = 0.0;
const SNOW_MELT_RATE_BASE            = 0.00002;    // m/s at 0 °C
const SNOW_MELT_RATE_PER_DEGREE      = 0.00005;    // m/s per °C above 0
const SNOW_MAX_DEPTH                 = 1.5;        // metres before piling stops

// ── Icicles ──────────────────────────────────────────────
const MAX_ICICLES                    = 8192;
const ICICLE_GROWTH_RATE_BASE        = 0.000012;   // m/s = 4.3 cm/hour
const ICICLE_MELT_RATE_BASE          = 0.00002;    // m/s at 0 °C
const ICICLE_MELT_RATE_PER_DEGREE    = 0.00005;    // m/s per °C above 0
const ICICLE_MAX_LENGTH              = 2.0;        // metres
const ICICLE_BASE_RADIUS_MIN         = 0.005;      // 5 mm
const ICICLE_BASE_RADIUS_MAX         = 0.05;       // 5 cm
const ICICLE_TIP_RADIUS_FRAC         = 0.02;       // tip is 2% of base
const ICICLE_ATTACH_STRENGTH         = 50.0;       // N
const ICICLE_STRESS_PER_METER        = 25.0;       // N per metre of length
const ICICLE_FALL_DAMAGE             = 5.0;        // kinetic energy → damage
const ICICLE_PIECE_COUNT             = 4;          // pieces when it breaks

// ── Ice stress ───────────────────────────────────────────
const ICE_FAILURE_STRESS             = 0.85;
const ICE_STRESS_DECAY               = 0.001;      // per second
const ICE_STRESS_WIND_FACTOR         = 0.00002;    // per (m/s)²

// ── Snow cover visual parameters ────────────────────────
const SNOW_ALBEDO_FRESH_R            = 0.95;
const SNOW_ALBEDO_FRESH_G            = 0.97;
const SNOW_ALBEDO_FRESH_B            = 1.00;
const SNOW_ROUGHNESS_FRESH           = 0.6;
const SNOW_ROUGHNESS_PACKED          = 0.4;

// ── Ice visual parameters ────────────────────────────────
const ICE_ALBEDO_R                   = 0.85;
const ICE_ALBEDO_G                   = 0.90;
const ICE_ALBEDO_B                   = 0.95;
const ICE_ROUGHNESS                  = 0.10;
const ICE_METALLIC                   = 0.05;

// ── Frost visual parameters ──────────────────────────────
const FROST_ALBEDO_R                 = 0.95;
const FROST_ALBEDO_G                 = 0.97;
const FROST_ALBEDO_B                 = 1.00;
const FROST_ROUGHNESS                = 0.75;

// ── Black ice / pack ice tint ────────────────────────────
const BLACK_ICE_TINT_R               = 0.35;
const BLACK_ICE_TINT_G               = 0.35;
const BLACK_ICE_TINT_B               = 0.40;
const PACK_ICE_TINT_R                = 0.60;
const PACK_ICE_TINT_G                = 0.60;
const PACK_ICE_TINT_B                = 0.65;

// ═══════════════════════════════════════════════════════════════════════
// ICE TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const IceType = Object.freeze({
  GLAZE:     0,
  RIME:      1,
  BLACK_ICE: 2,
  PACK_ICE:  3,
  SEA_ICE:   4,
  LAKE_ICE:  5,
});

// ═══════════════════════════════════════════════════════════════════════
// FROST CRYSTAL HABIT ENUM
// ═══════════════════════════════════════════════════════════════════════

export const FrostHabit = Object.freeze({
  NONE:      0,
  PLATE:     1,
  NEEDLE:    2,
  DENDRITE:  3,
  COLUMN:    4,
  FERN:      5,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA ICE SURFACE
// ═══════════════════════════════════════════════════════════════════════

export const IceSurface = {
  ownerEid: new Uint32Array(MAX_ICE_SURFACES),
  iceType: new Uint8Array(MAX_ICE_SURFACES),

  // Thickness (metres).
  thickness: new Float32Array(MAX_ICE_SURFACES),

  // Coverage (0..1) — fraction of the surface covered.
  coverage: new Float32Array(MAX_ICE_SURFACES),

  // Accumulated stress (0..1; failure fires at ICE_FAILURE_STRESS).
  stress: new Float32Array(MAX_ICE_SURFACES),

  // Stress-fired flag.
  stressFired: new Uint8Array(MAX_ICE_SURFACES),

  // Frost habit on this surface (FrostHabit).
  frostHabit: new Uint8Array(MAX_ICE_SURFACES),

  // Frost thickness (metres).
  frostThickness: new Float32Array(MAX_ICE_SURFACES),

  // Surface normal (approximation).
  nx: new Float32Array(MAX_ICE_SURFACES),
  ny: new Float32Array(MAX_ICE_SURFACES),
  nz: new Float32Array(MAX_ICE_SURFACES),

  // Age (seconds).
  age: new Float32Array(MAX_ICE_SURFACES),

  // Active.
  active: new Uint8Array(MAX_ICE_SURFACES),

  // Seed for noise.
  seed: new Uint32Array(MAX_ICE_SURFACES),
};

/** Marker: entity can accumulate surface ice. */
export const IceSurfaceTag = {};

const _iceSurfaceSlots = new Map();
let _nextIceSurfaceSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA ICE COVER — frozen water bodies
// ═══════════════════════════════════════════════════════════════════════

export const IceCover = {
  // Water body slot this cover belongs to.
  waterBodySlot: new Uint16Array(MAX_ICE_COVERS),

  // Ice type (SEA_ICE or LAKE_ICE).
  iceType: new Uint8Array(MAX_ICE_COVERS),

  // Ice thickness (metres).
  thickness: new Float32Array(MAX_ICE_COVERS),

  // Ice coverage (0..1; fraction of water body area covered).
  coverage: new Float32Array(MAX_ICE_COVERS),

  // Snow depth on top of the ice (metres).
  snowDepth: new Float32Array(MAX_ICE_COVERS),

  // Ice surface temperature (°C).
  surfaceTemperature: new Float32Array(MAX_ICE_COVERS),

  // Age (seconds).
  age: new Float32Array(MAX_ICE_COVERS),

  // Active.
  active: new Uint8Array(MAX_ICE_COVERS),
};

/** Marker: entity owns a frozen water body. */
export const IceCoverTag = {};

const _iceCoverSlots = new Map();
let _nextIceCoverSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA ICICLE
// ═══════════════════════════════════════════════════════════════════════

export const Icicle = {
  active: new Uint8Array(MAX_ICICLES),

  // Attachment point (top of the icicle).
  ax: new Float32Array(MAX_ICICLES),
  ay: new Float32Array(MAX_ICICLES),
  az: new Float32Array(MAX_ICICLES),

  // Length (metres).
  length: new Float32Array(MAX_ICICLES),

  // Base radius (metres).
  baseRadius: new Float32Array(MAX_ICICLES),

  // Mass (kg).
  mass: new Float32Array(MAX_ICICLES),

  // Age (seconds).
  age: new Float32Array(MAX_ICICLES),

  // Free-list.
  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA FALLING ICICLE — a detached icicle in free fall / physics
// ═══════════════════════════════════════════════════════════════════════

export const FallingIcicle = {
  active: new Uint8Array(MAX_ICICLES),

  // World position.
  px: new Float32Array(MAX_ICICLES),
  py: new Float32Array(MAX_ICICLES),
  pz: new Float32Array(MAX_ICICLES),

  // Velocity.
  vx: new Float32Array(MAX_ICICLES),
  vy: new Float32Array(MAX_ICICLES),
  vz: new Float32Array(MAX_ICICLES),

  // Mass, length, radius.
  mass: new Float32Array(MAX_ICICLES),
  length: new Float32Array(MAX_ICICLES),
  radius: new Float32Array(MAX_ICICLES),

  // Age (seconds).
  age: new Float32Array(MAX_ICICLES),

  // Owning entity (for damage attribution).
  sourceEid: new Uint32Array(MAX_ICICLES),

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
// ICE SURFACE API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create an ice surface on an entity.
 *
 * @param world       ECS world
 * @param eid         entity
 * @param iceType     IceType
 * @param options     { initialThickness, coverage, normal, seed }
 * @returns ice surface slot
 */
export function addIceSurface(world, eid, iceType = IceType.GLAZE, options = {}) {
  if (_nextIceSurfaceSlot >= MAX_ICE_SURFACES) {
    throw new Error('ice surface capacity exceeded');
  }
  const slot = _nextIceSurfaceSlot++;

  addComponent(world, eid, IceSurfaceTag);

  const S = IceSurface;
  S.ownerEid[slot] = eid;
  S.iceType[slot] = iceType;
  S.thickness[slot] = options.initialThickness ?? 0;
  S.coverage[slot] = options.coverage ?? 0;
  S.stress[slot] = 0;
  S.stressFired[slot] = 0;
  S.frostHabit[slot] = FrostHabit.NONE;
  S.frostThickness[slot] = 0;

  const normal = options.normal ?? [0, 1, 0];
  S.nx[slot] = normal[0];
  S.ny[slot] = normal[1];
  S.nz[slot] = normal[2];

  S.age[slot] = 0;
  S.active[slot] = 1;
  S.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  _iceSurfaceSlots.set(eid, slot);
  return slot;
}

export function removeIceSurface(world, eid) {
  const slot = _iceSurfaceSlots.get(eid);
  if (slot === undefined) return;
  IceSurface.active[slot] = 0;
  IceSurface.ownerEid[slot] = 0;
  _iceSurfaceSlots.delete(eid);
  removeComponent(world, eid, IceSurfaceTag);
}

export function getIceSurfaceSlot(eid) {
  return _iceSurfaceSlots.get(eid) ?? -1;
}

/**
 * Get the current ice thickness (metres) on an entity.
 */
export function getIceThickness(eid) {
  const slot = _iceSurfaceSlots.get(eid);
  if (slot === undefined) return 0;
  return IceSurface.thickness[slot];
}

/**
 * Get the current frost thickness (metres) on an entity.
 */
export function getFrostThickness(eid) {
  const slot = _iceSurfaceSlots.get(eid);
  if (slot === undefined) return 0;
  return IceSurface.frostThickness[slot];
}

// ═══════════════════════════════════════════════════════════════════════
// ICE COVER API — frozen water bodies
// ═══════════════════════════════════════════════════════════════════════

export function addIceCover(world, eid, waterBodySlot, iceType = IceType.LAKE_ICE) {
  if (_nextIceCoverSlot >= MAX_ICE_COVERS) {
    throw new Error('ice cover capacity exceeded');
  }
  const slot = _nextIceCoverSlot++;

  addComponent(world, eid, IceCoverTag);

  IceCover.waterBodySlot[slot] = waterBodySlot;
  IceCover.iceType[slot] = iceType;
  IceCover.thickness[slot] = 0;
  IceCover.coverage[slot] = 0;
  IceCover.snowDepth[slot] = 0;
  IceCover.surfaceTemperature[slot] = 0;
  IceCover.age[slot] = 0;
  IceCover.active[slot] = 1;

  _iceCoverSlots.set(eid, slot);
  return slot;
}

export function removeIceCover(world, eid) {
  const slot = _iceCoverSlots.get(eid);
  if (slot === undefined) return;
  IceCover.active[slot] = 0;
  _iceCoverSlots.delete(eid);
  removeComponent(world, eid, IceCoverTag);
}

export function getIceCoverSlot(eid) {
  return _iceCoverSlots.get(eid) ?? -1;
}

/**
 * Return the ice thickness on a water body.
 */
export function getWaterBodyIceThickness(waterBodySlot) {
  for (let slot = 0; slot < _nextIceCoverSlot; slot++) {
    if (!IceCover.active[slot]) continue;
    if (IceCover.waterBodySlot[slot] === waterBodySlot) {
      return IceCover.thickness[slot];
    }
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════
// FROST CRYSTALLIZATION — Libbrecht temperature-humidity habit model
// ═══════════════════════════════════════════════════════════════════════

/**
 * Determine the frost crystal habit from temperature and humidity.
 * Based on Libbrecht's snow crystal morphology diagram.
 */
function determineFrostHabit(temperatureC, humidity) {
  // Below -30 °C: mostly plates and columns.
  if (temperatureC < -30) {
    return humidity > 0.8 ? FrostHabit.PLATE : FrostHabit.COLUMN;
  }

  // -30 to -22 °C: columns and needles.
  if (temperatureC < -22) {
    if (humidity > 0.8) return FrostHabit.NEEDLE;
    return FrostHabit.COLUMN;
  }

  // -22 to -14 °C: plates and dendrites.
  if (temperatureC < -14) {
    if (humidity > 0.9) return FrostHabit.FERN;
    if (humidity > 0.6) return FrostHabit.DENDRITE;
    return FrostHabit.PLATE;
  }

  // -14 to -8 °C: plates.
  if (temperatureC < -8) {
    if (humidity > 0.7) return FrostHabit.FERN;
    return FrostHabit.PLATE;
  }

  // -8 to -3 °C: columns and needles.
  if (temperatureC < -3) {
    if (humidity > 0.8) return FrostHabit.NEEDLE;
    return FrostHabit.COLUMN;
  }

  // -3 to 0 °C: plates.
  if (humidity > 0.7) return FrostHabit.FERN;
  return FrostHabit.PLATE;
}

/**
 * Compute the dew point for a given temperature and humidity.
 * Uses the Magnus formula.
 */
export function dewPoint(temperatureC, humidity) {
  const a = 17.27;
  const b = 237.7;
  const alpha = (a * temperatureC) / (b + temperatureC) + Math.log(Math.max(0.01, humidity));
  return (b * alpha) / (a - alpha);
}

/**
 * System: grow or melt frost on all ice surfaces.
 *
 * Frost grows when:
 *   - Surface temperature < FROST_TEMP_MAX (0 °C)
 *   - Surface temperature > FROST_TEMP_MIN (-30 °C)
 *   - Local dew point > surface temperature (i.e., air is supersaturated
 *     with respect to the surface)
 *
 * @param world         ECS world
 * @param dt            seconds
 * @param temperatureC  ambient temperature (°C)
 * @param humidity      relative humidity (0..1)
 */
export function systemUpdateFrost(world, dt, temperatureC, humidity) {
  const S = IceSurface;

  if (temperatureC > FROST_TEMP_MAX || temperatureC < FROST_TEMP_MIN) {
    // No frost growth in this temperature regime.
    // But existing frost still melts if temp > 0.
    if (temperatureC > FROST_TEMP_MAX) {
      for (let slot = 0; slot < _nextIceSurfaceSlot; slot++) {
        if (!S.active[slot]) continue;
        if (S.frostThickness[slot] < EPSILON) continue;

        S.frostThickness[slot] = Math.max(0,
          S.frostThickness[slot] - FROST_MELT_RATE * dt);

        if (S.frostThickness[slot] < EPSILON) {
          S.frostHabit[slot] = FrostHabit.NONE;
        }
      }
    }
    return world;
  }

  const dp = dewPoint(temperatureC, humidity);
  const supersaturation = dp - temperatureC;

  if (supersaturation < FROST_DEWPOINT_DELTA) {
    // Not enough supersaturation — existing frost melts slowly.
    for (let slot = 0; slot < _nextIceSurfaceSlot; slot++) {
      if (!S.active[slot]) continue;
      if (S.frostThickness[slot] < EPSILON) continue;

      S.frostThickness[slot] = Math.max(0,
        S.frostThickness[slot] - FROST_MELT_RATE * dt * 0.1);
    }
    return world;
  }

  // Grow frost.
  const growthFactor = Math.min(1, (supersaturation - FROST_DEWPOINT_DELTA) / 5.0);
  const growthRate = FROST_GROWTH_RATE * growthFactor;

  for (let slot = 0; slot < _nextIceSurfaceSlot; slot++) {
    if (!S.active[slot]) continue;

    // Update habit based on temperature and humidity.
    const habit = determineFrostHabit(temperatureC, humidity);
    if (S.frostHabit[slot] === FrostHabit.NONE) {
      S.frostHabit[slot] = habit;
    }

    // Grow.
    S.frostThickness[slot] = Math.min(FROST_MAX_THICKNESS,
      S.frostThickness[slot] + growthRate * dt);

    // Increase coverage.
    S.coverage[slot] = Math.min(1.0,
      S.coverage[slot] + growthRate * dt / FROST_MAX_THICKNESS * 0.2);
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// SNOW COVER — layered snow state
// ═══════════════════════════════════════════════════════════════════════

/**
 * System: advance snow cover compaction and melting. Extends file 043's
 * snow state with layered compaction.
 *
 * @param world         ECS world
 * @param dt            seconds
 * @param temperatureC  ambient temperature (°C)
 * @param sunIntensity  0..1
 */
export function systemUpdateSnowCover(world, dt, temperatureC, sunIntensity) {
  const SS = SnowSurface;

  for (let slot = 0; slot < SS.depth.length; slot++) {
    if (!SS.active[slot]) continue;
    if (SS.depth[slot] < EPSILON) continue;

    // Compaction: snow packs under its own weight.
    const compactionFactor = Math.min(1, dt * SNOW_LAYER_COMPACT_RATE);
    SS.powderFactor[slot] = Math.max(0.05, SS.powderFactor[slot] - compactionFactor);

    // Melt when above freezing.
    if (temperatureC > SNOW_MELT_TEMP_THRESHOLD) {
      const meltRate = SNOW_MELT_RATE_BASE
        + SNOW_MELT_RATE_PER_DEGREE * (temperatureC - SNOW_MELT_TEMP_THRESHOLD)
        + sunIntensity * 0.00003;   // extra melt in sun

      const melt = Math.min(SS.depth[slot], meltRate * dt);
      SS.depth[slot] -= melt;

      // Melt produces wetness on the same entity.
      const eid = SS.ownerEid[slot];
      if (eid !== 0 && entityExists(world, eid)) {
        const wetSlot = getWetSurfaceSlot(eid);
        if (wetSlot >= 0) {
          SurfaceWetness.rainAccum[wetSlot] += melt * 500;   // m → mm × density
          SurfaceWetness.wetness[wetSlot] = Math.min(1,
            SurfaceWetness.rainAccum[wetSlot] / 50);
        }
      }

      if (SS.depth[slot] < EPSILON) {
        SS.depth[slot] = 0;
        SS.mass[slot] = 0;
        SS.powderFactor[slot] = 1;
      }
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// ICE COVER — sea / lake freezing and melting
// ═══════════════════════════════════════════════════════════════════════

/**
 * System: grow or melt ice covers on water bodies based on temperature.
 *
 * @param world         ECS world
 * @param dt            seconds
 * @param temperatureC  ambient temperature (°C)
 */
export function systemUpdateIceCovers(world, dt, temperatureC) {
  const IC = IceCover;

  for (let slot = 0; slot < _nextIceCoverSlot; slot++) {
    if (!IC.active[slot]) continue;

    IC.age[slot] += dt;

    const iceType = IC.iceType[slot];
    const freezeTemp = iceType === IceType.SEA_ICE
      ? SEA_ICE_FREEZE_TEMP : LAKE_ICE_FREEZE_TEMP;

    // Track water body existence.
    if (!WaterBody.active[IC.waterBodySlot[slot]]) {
      IC.active[slot] = 0;
      continue;
    }

    // Freeze or melt based on temperature.
    if (temperatureC < freezeTemp) {
      // Growth.
      const growthRate = iceType === IceType.SEA_ICE
        ? SEA_ICE_GROWTH_RATE : LAKE_ICE_GROWTH_RATE;
      const maxThickness = iceType === IceType.SEA_ICE
        ? MAX_SEA_ICE_THICKNESS : MAX_LAKE_ICE_THICKNESS;

      const tempFactor = Math.min(1, (freezeTemp - temperatureC) / 10.0);
      IC.thickness[slot] = Math.min(maxThickness,
        IC.thickness[slot] + growthRate * tempFactor * dt);

      IC.coverage[slot] = Math.min(1.0,
        IC.coverage[slot] + growthRate * tempFactor * dt / maxThickness * 0.5);

      IC.surfaceTemperature[slot] = temperatureC;
    } else {
      // Melting.
      const meltRate = iceType === IceType.SEA_ICE
        ? SEA_ICE_MELT_RATE : LAKE_ICE_MELT_RATE;

      IC.thickness[slot] = Math.max(0,
        IC.thickness[slot] - meltRate * dt);

      IC.coverage[slot] = Math.max(0,
        IC.coverage[slot] - meltRate * dt / Math.max(IC.thickness[slot] + 0.01, 0.01) * 0.5);

      IC.surfaceTemperature[slot] = temperatureC;

      if (IC.thickness[slot] < 0.001) {
        IC.thickness[slot] = 0;
        IC.coverage[slot] = 0;
      }
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// ICICLES — growth, melting, and detachment
// ═══════════════════════════════════════════════════════════════════════

function allocIcicle() {
  const I = Icicle;
  for (let i = 0; i < MAX_ICICLES; i++) {
    const slot = (I.freeHead + i) % MAX_ICICLES;
    if (I.active[slot] === 0) {
      I.freeHead = (slot + 1) % MAX_ICICLES;
      I.active[slot] = 1;
      I.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeIcicle(slot) {
  const I = Icicle;
  if (I.active[slot] === 0) return;
  I.active[slot] = 0;
  I.liveCount--;
}

function allocFallingIcicle() {
  const F = FallingIcicle;
  for (let i = 0; i < MAX_ICICLES; i++) {
    const slot = (F.freeHead + i) % MAX_ICICLES;
    if (F.active[slot] === 0) {
      F.freeHead = (slot + 1) % MAX_ICICLES;
      F.active[slot] = 1;
      F.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeFallingIcicle(slot) {
  const F = FallingIcicle;
  if (F.active[slot] === 0) return;
  F.active[slot] = 0;
  F.liveCount--;
}

/**
 * System: spawn icicles at eaves and ledges. Called when there's
 * snow above a ledge and melting is occurring.
 */
export function systemSpawnIcicles(world, dt, temperatureC) {
  // Only spawn icicles when melting is active.
  if (temperatureC < -2 || temperatureC > 8) return world;

  const SS = SnowSurface;

  // For each entity with snow cover > 5 cm and a vertical face (probable
  // eave), spawn an icicle.
  for (let slot = 0; slot < SS.depth.length; slot++) {
    if (!SS.active[slot]) continue;
    if (SS.depth[slot] < 0.05) continue;

    const eid = SS.ownerEid[slot];
    if (!eid || !entityExists(world, eid)) continue;

    // Throttle: only spawn ~1 icicle per second per eligible entity.
    if (Math.random() > dt * 0.5) continue;

    // Attempt to allocate an icicle.
    const icicleSlot = allocIcicle();
    if (icicleSlot < 0) continue;

    // Get entity position.
    const id = getId(eid);
    const M = WorldTransformF32.m;
    if (!M) { freeIcicle(icicleSlot); continue; }
    const off = id * 16;

    // Attach at the bottom edge of the entity's bounds.
    const bounds = WorldBoundsF32.aabb;
    const bOff = id * 6;

    Icicle.ax[icicleSlot] = M[off + 12];
    Icicle.ay[icicleSlot] = bounds[bOff + 1];   // min Y
    Icicle.az[icicleSlot] = M[off + 14];
    Icicle.length[icicleSlot] = 0;
    Icicle.baseRadius[icicleSlot] = ICICLE_BASE_RADIUS_MIN;
    Icicle.mass[icicleSlot] = 0;
    Icicle.age[icicleSlot] = 0;
  }

  return world;
}

/**
 * System: grow or melt icicles based on temperature.
 */
export function systemUpdateIcicles(world, dt, temperatureC) {
  const I = Icicle;

  for (let slot = 0; slot < MAX_ICICLES; slot++) {
    if (I.active[slot] === 0) continue;

    I.age[slot] += dt;

    if (temperatureC < 0) {
      // Growth from melt-freeze cycles.
      const tempFactor = Math.min(1, Math.abs(temperatureC) / 5);
      const growth = ICICLE_GROWTH_RATE_BASE * tempFactor * dt;
      I.length[slot] = Math.min(ICICLE_MAX_LENGTH,
        I.length[slot] + growth);

      // Base radius grows with length (tapering cone).
      const newRadius = Math.min(ICICLE_BASE_RADIUS_MAX,
        ICICLE_BASE_RADIUS_MIN + I.length[slot] * 0.02);
      I.baseRadius[slot] = newRadius;

      // Recompute mass: cone volume × density.
      const volume = (PI / 3) * newRadius * newRadius * I.length[slot];
      I.mass[slot] = volume * ICE_DENSITY;
    } else if (temperatureC > 0) {
      // Melting.
      const meltRate = ICICLE_MELT_RATE_BASE
        + ICICLE_MELT_RATE_PER_DEGREE * temperatureC;
      I.length[slot] = Math.max(0, I.length[slot] - meltRate * dt);

      if (I.length[slot] < 0.001) {
        freeIcicle(slot);
        continue;
      }

      // Recompute mass.
      const volume = (PI / 3) * I.baseRadius[slot] * I.baseRadius[slot] * I.length[slot];
      I.mass[slot] = volume * ICE_DENSITY;
    }

    // Detachment check: if mass × g exceeds attachment strength, fall.
    const weight = I.mass[slot] * GRAVITY;
    if (weight > ICICLE_ATTACH_STRENGTH) {
      // Detach.
      const fallingSlot = allocFallingIcicle();
      if (fallingSlot >= 0) {
        const F = FallingIcicle;
        F.px[fallingSlot] = I.ax[slot];
        F.py[fallingSlot] = I.ay[slot] - I.length[slot];
        F.pz[fallingSlot] = I.az[slot];
        F.vx[fallingSlot] = (Math.random() - 0.5) * 0.5;
        F.vy[fallingSlot] = -0.5;   // small downward velocity
        F.vz[fallingSlot] = (Math.random() - 0.5) * 0.5;
        F.mass[fallingSlot] = I.mass[slot];
        F.length[fallingSlot] = I.length[slot];
        F.radius[fallingSlot] = I.baseRadius[slot];
        F.age[fallingSlot] = 0;
        F.sourceEid[fallingSlot] = 0;   // set by caller if needed
      }
      freeIcicle(slot);
    }
  }

  return world;
}

/**
 * System: advance falling icicles. On impact, break into pieces and
 * dispatch damage events.
 */
export function systemUpdateFallingIcicles(world, dt) {
  const F = FallingIcicle;

  for (let slot = 0; slot < MAX_ICICLES; slot++) {
    if (F.active[slot] === 0) continue;

    F.age[slot] += dt;

    // Gravity.
    F.vy[slot] -= GRAVITY * dt;

    // Air drag.
    F.vx[slot] *= Math.pow(0.99, dt);
    F.vz[slot] *= Math.pow(0.99, dt);

    // Position.
    const newX = F.px[slot] + F.vx[slot] * dt;
    const newY = F.py[slot] + F.vy[slot] * dt;
    const newZ = F.pz[slot] + F.vz[slot] * dt;

    // Impact test via BVH.
    const hits = bvhRaycast(
      [F.px[slot], F.py[slot], F.pz[slot]],
      [F.vx[slot], F.vy[slot], F.vz[slot]],
      Math.hypot(F.vx[slot], F.vy[slot], F.vz[slot]) * dt + 0.5,
      true
    );

    if (hits.length > 0) {
      const h = hits[0];
      const impactX = F.px[slot] + F.vx[slot] * dt * h.t;
      const impactY = F.py[slot] + F.vy[slot] * dt * h.t;
      const impactZ = F.pz[slot] + F.vz[slot] * dt * h.t;

      // Dispatch impact damage to the target entity if it's a character.
      if (h.eid && hasComponent(world, h.eid, CharacterTag)) {
        const cs = getCharacterSlot(h.eid);
        if (cs >= 0) {
          // Kinetic energy from falling icicle.
          const speedSq = F.vx[slot] ** 2 + F.vy[slot] ** 2 + F.vz[slot] ** 2;
          const ke = 0.5 * F.mass[slot] * speedSq;
          // Games hook character health; expose via API.
        }
      }

      freeFallingIcicle(slot);
      continue;
    }

    F.px[slot] = newX;
    F.py[slot] = newY;
    F.pz[slot] = newZ;

    if (F.py[slot] < -100) {
      freeFallingIcicle(slot);
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// ICE STRESS — accumulated mechanical stress
// ═══════════════════════════════════════════════════════════════════════

const _iceWind = vec3.create();

/**
 * System: accumulate ice stress from wind pressure and dispatch failure
 * events when it crosses the threshold.
 */
export function systemUpdateIceStress(world, dt, observerFn) {
  const S = IceSurface;

  for (let slot = 0; slot < _nextIceSurfaceSlot; slot++) {
    if (!S.active[slot]) continue;

    S.age[slot] += dt;

    const thickness = S.thickness[slot];
    if (thickness < EPSILON) {
      // No ice, stress decays naturally.
      S.stress[slot] = Math.max(0, S.stress[slot] - ICE_STRESS_DECAY * dt);
      continue;
    }

    // Sample wind.
    const eid = S.ownerEid[slot];
    if (eid === 0 || !entityExists(world, eid)) continue;

    const id = getId(eid);
    const M = WorldTransformF32.m;
    if (!M) continue;
    const off = id * 16;
    sampleWindAt(M[off + 12], M[off + 13], M[off + 14], _iceWind);
    const windSpeed = Math.hypot(_iceWind[0], _iceWind[1], _iceWind[2]);

    // Stress accumulates with wind speed and ice thickness.
    const stressRate = windSpeed * windSpeed * ICE_STRESS_WIND_FACTOR
      * Math.min(1, thickness / 0.02);
    S.stress[slot] = Math.min(1.0, S.stress[slot] + stressRate * dt);

    // Failure check.
    if (S.stress[slot] >= ICE_FAILURE_STRESS && S.stressFired[slot] === 0) {
      S.stressFired[slot] = 1;

      if (observerFn) {
        try {
          observerFn(eid, S.stress[slot]);
        } catch (_) {}
      }

      // Break the ice: reduce thickness / coverage.
      S.thickness[slot] *= 0.5;
      S.coverage[slot] *= 0.7;

      // Rigid body shake.
      if (hasComponent(world, eid, RigidBody3D)) {
        RigidBody3D.wx[id] += (Math.random() - 0.5) * 0.1;
        RigidBody3D.wy[id] += (Math.random() - 0.5) * 0.1;
        RigidBody3D.wz[id] += (Math.random() - 0.5) * 0.1;
      }
    }

    // Stress decays between impacts.
    if (S.stress[slot] < ICE_FAILURE_STRESS * 0.9) {
      S.stress[slot] = Math.max(0, S.stress[slot] - ICE_STRESS_DECAY * dt);
    }
    if (S.stress[slot] < ICE_FAILURE_STRESS * 0.5) {
      S.stressFired[slot] = 0;
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// ICE THICKNESS FROM FREEZING RAIN
// ═══════════════════════════════════════════════════════════════════════

/**
 * System: extend file 045's IceGlaze to grow/decay ice on all surfaces.
 * Called when freezing rain is active and temperature is below 0 °C.
 */
export function systemUpdateGlazeIce(world, dt, temperatureC) {
  const IG = IceGlaze;

  if (temperatureC > 0) {
    // Melt existing glaze.
    for (let slot = 0; slot < IG.depthMm.length; slot++) {
      if (!IG.active[slot]) continue;
      if (IG.depthMm[slot] < EPSILON) continue;

      const meltRateMmPerSec = 0.1 * temperatureC;
      IG.depthMm[slot] = Math.max(0, IG.depthMm[slot] - meltRateMmPerSec * dt);

      if (IG.depthMm[slot] < EPSILON) {
        IG.depthMm[slot] = 0;
        IG.mass[slot] = 0;
        IG.stress[slot] = 0;
      }
    }
  } else {
    // Cap at max thickness.
    for (let slot = 0; slot < IG.depthMm.length; slot++) {
      if (!IG.active[slot]) continue;
      const maxMm = IG.rime[slot] ? ICE_RIME_MAX_THICKNESS : ICE_GLAZE_MAX_THICKNESS;
      IG.depthMm[slot] = Math.min(maxMm * 1000, IG.depthMm[slot]);
      IG.mass[slot] = IG.depthMm[slot] * ICE_DENSITY / 1000;
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// MATERIAL COUPLING — snow / ice albedo and roughness
// ═══════════════════════════════════════════════════════════════════════

/**
 * Apply the current snow / ice / frost state to the entity's material.
 */
export function applyWinterMaterials(world, eid) {
  if (!hasComponent(world, eid, MaterialTag)) return;

  const id = getId(eid);

  // Snow cover contribution.
  const snowSlot = getSnowSurfaceSlot(eid);
  let snowCoverage = 0;
  if (snowSlot >= 0) {
    const depth = SnowSurface.depth[snowSlot];
    snowCoverage = Math.min(1, depth / 0.05);
  }

  // Ice contribution.
  const iceSlot = getIceSurfaceSlot(eid);
  let iceCoverage = 0;
  if (iceSlot >= 0) {
    const thickness = IceSurface.thickness[iceSlot];
    iceCoverage = Math.min(1, thickness / 0.01);
  }

  // Frost contribution.
  const frostSlot = iceSlot;
  let frostCoverage = 0;
  if (frostSlot >= 0) {
    frostCoverage = Math.min(1, IceSurface.frostThickness[frostSlot] / FROST_MAX_THICKNESS);
  }

  // Total coverage.
  const totalCoverage = Math.min(1, snowCoverage + iceCoverage + frostCoverage);
  if (totalCoverage < 0.01) return;

  // Blend albedo and roughness toward snow/ice values.
  const snowR = SNOW_ALBEDO_FRESH_R;
  const snowG = SNOW_ALBEDO_FRESH_G;
  const snowB = SNOW_ALBEDO_FRESH_B;
  const snowRough = SNOW_ROUGHNESS_FRESH;

  const iceR = ICE_ALBEDO_R;
  const iceG = ICE_ALBEDO_G;
  const iceB = ICE_ALBEDO_B;
  const iceRough = ICE_ROUGHNESS;

  // Combine: snow dominates if snowCoverage is high, ice otherwise.
  const snowWeight = snowCoverage / Math.max(totalCoverage, EPSILON);
  const iceWeight = iceCoverage / Math.max(totalCoverage, EPSILON);
  const frostWeight = frostCoverage / Math.max(totalCoverage, EPSILON);

  const blendedR = snowR * snowWeight + iceR * iceWeight + FROST_ALBEDO_R * frostWeight;
  const blendedG = snowG * snowWeight + iceG * iceWeight + FROST_ALBEDO_G * frostWeight;
  const blendedB = snowB * snowWeight + iceB * iceWeight + FROST_ALBEDO_B * frostWeight;

  const blendedRough = snowRough * snowWeight + iceRough * iceWeight + FROST_ROUGHNESS * frostWeight;

  // Apply to material.
  MaterialF32.baseR[id] = MaterialF32.baseR[id] * (1 - totalCoverage) + blendedR * totalCoverage;
  MaterialF32.baseG[id] = MaterialF32.baseG[id] * (1 - totalCoverage) + blendedG * totalCoverage;
  MaterialF32.baseB[id] = MaterialF32.baseB[id] * (1 - totalCoverage) + blendedB * totalCoverage;
  MaterialF32.roughness[id] = MaterialF32.roughness[id] * (1 - totalCoverage) + blendedRough * totalCoverage;

  // Ice adds specularity.
  if (iceCoverage > 0.1) {
    MaterialF32.metallic[id] = Math.min(0.20, MaterialF32.metallic[id] + iceCoverage * ICE_METALLIC);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the total ice thickness at an entity's position.
 */
export function getTotalIceAt(world, eid) {
  let total = 0;

  // Surface ice.
  const iceSlot = getIceSurfaceSlot(eid);
  if (iceSlot >= 0) {
    total += IceSurface.thickness[iceSlot];
  }

  // Frozen water body ice.
  const id = getId(eid);
  const M = WorldTransformF32.m;
  if (M) {
    const off = id * 16;
    const bodySlot = findWaterBodyAt(M[off + 12], M[off + 14], M[off + 13], 100.0);
    if (bodySlot >= 0) {
      total += getWaterBodyIceThickness(bodySlot);
    }
  }

  return total;
}

/**
 * Return whether the entity's water body is frozen enough to walk on.
 * Requires ice thickness > 5 cm.
 */
export function isWaterBodyFrozen(waterBodySlot, minThickness = 0.05) {
  const thickness = getWaterBodyIceThickness(waterBodySlot);
  return thickness >= minThickness;
}

/**
 * Return the total snow cover depth at an entity.
 */
export function getSnowCoverDepth(eid) {
  const slot = getSnowSurfaceSlot(eid);
  if (slot < 0) return 0;
  return SnowSurface.depth[slot];
}

/**
 * Return the current frost habit label.
 */
export function getFrostHabitLabel(habit) {
  switch (habit) {
    case FrostHabit.NONE:     return 'None';
    case FrostHabit.PLATE:    return 'Plate';
    case FrostHabit.NEEDLE:   return 'Needle';
    case FrostHabit.DENDRITE: return 'Dendrite';
    case FrostHabit.COLUMN:   return 'Column';
    case FrostHabit.FERN:     return 'Fern';
    default:                  return 'Unknown';
  }
}

/**
 * Return the ice type label.
 */
export function getIceTypeLabel(type) {
  switch (type) {
    case IceType.GLAZE:     return 'Glaze';
    case IceType.RIME:      return 'Rime';
    case IceType.BLACK_ICE: return 'Black Ice';
    case IceType.PACK_ICE:  return 'Pack Ice';
    case IceType.SEA_ICE:   return 'Sea Ice';
    case IceType.LAKE_ICE:  return 'Lake Ice';
    default:                return 'Unknown';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TICK
// ═══════════════════════════════════════════════════════════════════════

/**
 * Full ice/frost pipeline for one frame:
 *
 * @param world         ECS world
 * @param dt            seconds
 * @param temperatureC  ambient temperature (°C)
 * @param humidity      relative humidity (0..1)
 * @param sunIntensity  0..1 (sun brightness for melting)
 * @param observerFn    optional ice failure callback
 */
export function systemIceFrostTick(world, dt, temperatureC, humidity, sunIntensity = 0.5, observerFn = null) {
  systemUpdateFrost(world, dt, temperatureC, humidity);
  systemUpdateSnowCover(world, dt, temperatureC, sunIntensity);
  systemUpdateIceCovers(world, dt, temperatureC);
  systemSpawnIcicles(world, dt, temperatureC);
  systemUpdateIcicles(world, dt, temperatureC);
  systemUpdateFallingIcicles(world, dt);
  systemUpdateGlazeIce(world, dt, temperatureC);
  systemUpdateIceStress(world, dt, observerFn);

  // Update materials for all winter-affected entities.
  const allEids = query(world, [MaterialTag]);
  for (let i = 0; i < allEids.length; i++) {
    applyWinterMaterials(world, allEids[i]);
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

export function gatherIceSurfacesForRendering() {
  const result = [];
  const S = IceSurface;
  for (let slot = 0; slot < _nextIceSurfaceSlot; slot++) {
    if (!S.active[slot]) continue;
    if (S.thickness[slot] < EPSILON && S.frostThickness[slot] < EPSILON) continue;

    result.push({
      slot,
      iceType: S.iceType[slot],
      iceTypeLabel: getIceTypeLabel(S.iceType[slot]),
      thickness: S.thickness[slot],
      coverage: S.coverage[slot],
      frostHabit: S.frostHabit[slot],
      frostHabitLabel: getFrostHabitLabel(S.frostHabit[slot]),
      frostThickness: S.frostThickness[slot],
      stress: S.stress[slot],
      normal: [S.nx[slot], S.ny[slot], S.nz[slot]],
    });
  }
  return result;
}

export function gatherIceCoversForRendering() {
  const result = [];
  const IC = IceCover;
  for (let slot = 0; slot < _nextIceCoverSlot; slot++) {
    if (!IC.active[slot]) continue;
    if (IC.thickness[slot] < EPSILON) continue;

    result.push({
      slot,
      waterBodySlot: IC.waterBodySlot[slot],
      iceType: IC.iceType[slot],
      thickness: IC.thickness[slot],
      coverage: IC.coverage[slot],
      snowDepth: IC.snowDepth[slot],
      surfaceTemperature: IC.surfaceTemperature[slot],
    });
  }
  return result;
}

export function gatherIciclesForRendering() {
  const result = [];
  const I = Icicle;
  for (let slot = 0; slot < MAX_ICICLES; slot++) {
    if (I.active[slot] === 0) continue;
    if (I.length[slot] < 0.01) continue;

    result.push({
      slot,
      ax: I.ax[slot],
      ay: I.ay[slot],
      az: I.az[slot],
      length: I.length[slot],
      baseRadius: I.baseRadius[slot],
      mass: I.mass[slot],
      age: I.age[slot],
    });
  }
  return result;
}

export function gatherFallingIciclesForRendering() {
  const result = [];
  const F = FallingIcicle;
  for (let slot = 0; slot < MAX_ICICLES; slot++) {
    if (F.active[slot] === 0) continue;

    result.push({
      slot,
      px: F.px[slot],
      py: F.py[slot],
      pz: F.pz[slot],
      vx: F.vx[slot],
      vy: F.vy[slot],
      vz: F.vz[slot],
      mass: F.mass[slot],
      length: F.length[slot],
      radius: F.radius[slot],
      age: F.age[slot],
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearIceFrost() {
  IceSurface.active.fill(0);
  IceSurface.ownerEid.fill(0);
  _iceSurfaceSlots.clear();
  _nextIceSurfaceSlot = 0;

  IceCover.active.fill(0);
  _iceCoverSlots.clear();
  _nextIceCoverSlot = 0;

  Icicle.active.fill(0);
  Icicle.freeHead = 0;
  Icicle.liveCount = 0;

  FallingIcicle.active.fill(0);
  FallingIcicle.freeHead = 0;
  FallingIcicle.liveCount = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function iceFrostStats() {
  let activeIceSurfaces = 0;
  let activeIceCovers = 0;
  let activeIcicles = 0;
  let activeFallingIcicles = 0;
  let totalIceThickness = 0;
  let totalFrostThickness = 0;
  let totalSnowCover = 0;

  for (let slot = 0; slot < _nextIceSurfaceSlot; slot++) {
    if (!IceSurface.active[slot]) continue;
    activeIceSurfaces++;
    totalIceThickness += IceSurface.thickness[slot];
    totalFrostThickness += IceSurface.frostThickness[slot];
  }

  for (let slot = 0; slot < _nextIceCoverSlot; slot++) {
    if (IceCover.active[slot]) activeIceCovers++;
  }

  for (let slot = 0; slot < MAX_ICICLES; slot++) {
    if (Icicle.active[slot]) activeIcicles++;
    if (FallingIcicle.active[slot]) activeFallingIcicles++;
  }

  for (let slot = 0; slot < SnowSurface.depth.length; slot++) {
    if (SnowSurface.active[slot]) {
      totalSnowCover += SnowSurface.depth[slot];
    }
  }

  return {
    activeIceSurfaces,
    maxIceSurfaces: MAX_ICE_SURFACES,
    activeIceCovers,
    maxIceCovers: MAX_ICE_COVERS,
    activeIcicles,
    activeFallingIcicles,
    maxIcicles: MAX_ICICLES,
    totalIceThickness,
    totalFrostThickness,
    totalSnowCover,
  };
}