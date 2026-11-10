// file number : 071
// full path name : src/weather/071_terrain_effects.js
// description : Terrain-driven atmospheric effects. Extends the weather
//               pipeline (files 040-070) with the full set of
//               terrain-induced processes that shape local climate and
//               weather at the mesoscale:
//                 • OROGRAPHIC LIFT — air forced up a mountain slope cools
//                   at the dry adiabatic lapse rate (9.8 °C/km) until it
//                   reaches the LCL, then at the moist rate (5 °C/km).
//                   Computes the uplift rate (m/s), condensation rate,
//                   and the resulting cloud / rainfall enhancement.
//                 • RAIN SHADOW — the classic leeward drying: downslope
//                   air warms and dries after precipitating its moisture
//                   on the windward side. Returns a per-point factor
//                   (0.2 to 1.3) that multiplies precipitation.
//                 • FOEHN / CHINOOK — the warm, dry downslope wind on
//                   the lee side of a mountain range, driven by the
//                   latent heat release during windward condensation.
//                   Produces a 5-15 °C temperature boost and 20-40%
//                   humidity drop.
//                 • KATABATIC FLOW — nighttime cold-air drainage from
//                   elevated terrain into valleys, producing the classic
//                   valley cold pool and mountain cold-air lake.
//                 • ANABATIC FLOW — daytime upslope winds driven by
//                   solar heating of the slopes, opposite to the
//                   katabatic flow.
//                 • MOUNTAIN WAVES — lee waves created when stable air
//                   flows over a ridge, often producing lenticular
//                   clouds and strong downslope wind bursts (the
//                   Boulder windstorm).
//                 • LAKE / SEA BREEZE — thermal circulation driven by
//                   the differential heating of land versus water.
//                   Daytime onshore sea breeze (from water toward land),
//                   nighttime offshore land breeze (from land toward
//                   water). Detected automatically near any water body
//                   (file 059) using the terrain temperature gradient.
//                 • VALLEY CHANNELING — the mechanical funneling of
//                   wind along valley axes, amplifying the along-valley
//                   component and suppressing the cross-valley
//                   component.
//                 • SNOW LINE / TREE LINE — altitude thresholds for
//                   permanent snow and forest, modulated by latitude
//                   and season. Used by files 043, 061, and 065.
//                 • URBAN CANYON EFFECT — inside cities, street
//                   canyons reduce wind speed and trap heat at street
//                   level, with a +1.5 °C offset and 30% wind
//                   reduction.
//                 • TOPOGRAPHIC EXPOSURE — computed from BVH (file 003)
//                   upward-ray coverage. Provides an "exposure factor"
//                   used by file 068 (evaporation), file 069
//                   (solar heating), and file 065 (frost onset).
//               The module exposes a family of `sampleTerrainXxx()`
//               functions that plug directly into:
//                 • file 047 (wind): via systemApplyTerrainWindModifier
//                 • file 068 (humidity): via systemApplyTerrainHumidity
//                 • file 069 (temperature): via systemApplyTerrainTemperature
//                 • file 042 (rain): via terrainPrecipitationMultiplier
//               All state lives in typed arrays; per-frame cost is
//               O(zones) × O(1) plus one BVH sample per query. Zero
//               per-frame allocation; steady-state 1M-entity scenes
//               handle terrain effects on Android 64-bit.
// best for : Mountain / valley weather, coastal breezes, foehn wind
//            gameplay, valley cold pools, mountain wave turbulence,
//            snow-line / tree-line realism, and any 1M-entity scene
//            needing physically-realistic terrain-weather interaction.
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
} from '../geometry/004_aabb_bounds.js';

import {
  BVHState,
  bvhRaycast,
} from '../spatial/003_bvh_broadphase.js';

import {
  SkyF32,
  SkyModel,
  getSkySlot,
  sampleSkyRadiance,
} from '../sky/028_sky_atmosphere.js';

import {
  PressureSystem,
  samplePressureAt,
} from './067_pressure_system.js';

import {
  SeasonRegion,
  Season,
  SubSeason,
  getAmbientTemperature,
  getAmbientHumidity,
  getSunElevation,
  getSeason,
  getSeasonalProgress,
} from './065_season_system.js';

import {
  ClimateZone,
  Biome,
  KoppenClimate,
  sampleClimateAt,
} from './066_climate_zone.js';

import {
  TemperatureGrid,
  sampleTemperatureAt,
} from './069_temperature_field.js';

import {
  HumidityGrid,
  absoluteHumidityFromRelative,
  relativeHumidityFromAbsolute,
  saturationVaporPressure,
  dewPoint,
  liftingCondensationLevel,
} from './068_humidity_field.js';

import {
  WaterBody,
  WaterBodyTag,
  findWaterBodyAt,
  sampleWaterSurfaceHeight,
} from './059_water_surface.js';

import {
  sampleWindAt,
  WindSource,
} from './047_wind_gusts.js';

import {
  SurfaceWetness,
  getWetSurfaceSlot,
} from './042_rain.js';

import {
  SnowSurface,
  getSnowSurfaceSlot,
} from './043_snow.js';

import {
  IceSurface,
  getIceSurfaceSlot,
} from './061_ice_frost.js';

import {
  VegetationTag,
} from './065_season_system.js';

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

// ── Lapse rates (°C per km) ────────────────────────────────
const LAPSE_RATE_DRY_ADIABATIC       = 9.8;
const LAPSE_RATE_MOIST_ADIABATIC     = 5.0;
const LAPSE_RATE_ENVIRONMENTAL       = 6.5;

// ── Orographic lift limits ─────────────────────────────────
const MAX_OROGRAPHIC_LIFT            = 5.0;    // m/s uplift cap
const MIN_UPLIFT_WIND_SPEED          = 1.0;    // m/s below this no lift
const OROGRAPHIC_CONDENSATION_EFF    = 0.5;    // fraction of uplift that condenses

// ── Rain shadow ────────────────────────────────────────────
const RAIN_SHADOW_WINDWARD_MULT      = 1.35;
const RAIN_SHADOW_LEEWARD_MULT       = 0.20;
const RAIN_SHADOW_TRANSITION_KM      = 15.0;   // smoothing width across ridge

// ── Foehn / Chinook wind ───────────────────────────────────
const FOEHN_TEMP_BOOST_MAX           = 15.0;   // °C
const FOEHN_HUMIDITY_DROP_MAX        = 0.40;   // fraction
const FOEHN_WIND_BOOST_MAX           = 12.0;   // m/s
const FOEHN_RAMP_KM                  = 30.0;   // distance over which it develops

// ── Katabatic flow ─────────────────────────────────────────
const KATABATIC_MAX_SPEED            = 15.0;   // m/s
const KATABATIC_TEMP_DEFICIT_MAX     = 8.0;    // °C
const KATABATIC_NIGHT_MIN_SUN_ELEV   = 0.0;    // sun must be below horizon

// ── Anabatic flow ──────────────────────────────────────────
const ANABATIC_MAX_SPEED             = 4.0;    // m/s
const ANABATIC_SUN_MIN_ELEV          = 0.15;   // rad (~8.6°)

// ── Mountain waves ─────────────────────────────────────────
const MOUNTAIN_WAVE_WAVELENGTH_MIN   = 2000.0; // metres
const MOUNTAIN_WAVE_WAVELENGTH_MAX   = 20000.0;
const MOUNTAIN_WAVE_AMPLITUDE_MAX    = 2000.0; // metres of vertical displacement
const MOUNTAIN_WAVE_MIN_STABILITY    = 0.5;    // dimensionless

// ── Lake / sea breeze ──────────────────────────────────────
const BREEZE_MAX_SPEED               = 8.0;    // m/s
const BREEZE_THERMAL_THRESHOLD       = 2.0;    // °C land-water difference
const BREEZE_REACH_KM                = 40.0;   // inland extent
const BREEZE_START_HOUR              = 10.0;   // morning
const BREEZE_PEAK_HOUR               = 15.0;   // afternoon
const BREEZE_END_HOUR                = 21.0;   // evening

// ── Valley channeling ──────────────────────────────────────
const VALLEY_CHANNEL_AMPLIFY         = 1.4;    // along-valley multiplier
const VALLEY_CHANNEL_DAMPEN          = 0.4;    // cross-valley multiplier

// ── Snow line / tree line ──────────────────────────────────
const SNOW_LINE_DEFAULT_ALT_M        = 2500.0;
const TREE_LINE_DEFAULT_ALT_M        = 3000.0;
const SNOW_LINE_LAT_SCALE            = 100.0;  // °C/° lat
const TREE_LINE_LAT_SCALE            = 120.0;

// ── Urban canyon effect ────────────────────────────────────
const URBAN_CANYON_HEAT_BOOST        = 1.5;    // °C
const URBAN_CANYON_WIND_REDUCTION    = 0.30;   // 30% reduction

// ── Topographic exposure ───────────────────────────────────
const EXPOSURE_RAY_COUNT             = 8;
const EXPOSURE_RAY_MAX_DIST          = 5000.0;
const EXPOSURE_MAX_ALT               = 3000.0;
const EXPOSURE_MIN_ALT               = -500.0;

// ── Breeze state enums ─────────────────────────────────────
export const BreezeType = Object.freeze({
  NONE:           0,
  SEA_BREEZE:     1,   // daytime, onshore
  LAND_BREEZE:    2,   // nighttime, offshore
  LAKE_BREEZE:    3,   // small-scale daytime, onshore
  LAKE_LAND_BREEZE: 4, // small-scale nighttime, offshore
});

// ── Orographic feature enums ───────────────────────────────
export const OrographicFeature = Object.freeze({
  NONE:           0,
  RIDGE:          1,   // sharp linear feature
  MOUNTAIN_PEAK:  2,   // isolated peak
  VALLEY:         3,   // concave feature
  PLATEAU:        4,   // flat elevated region
  COASTAL_SLOPE:  5,   // slope from sea to mountain
});

// ── SoA element counts ────────────────────────────────────
const MAX_OROGRAPHIC_ZONES            = 256;
const MAX_VALLEY_ZONES               = 128;
const MAX_BREEZE_CELLS               = 512;
const MAX_URBAN_CANYON_ZONES         = 128;
const MAX_TERRAIN_OBSERVERS          = 4096;

// ═══════════════════════════════════════════════════════════════════════
// SoA OROGRAPHIC ZONE — mountain / ridge / peak
// ═══════════════════════════════════════════════════════════════════════

export const OrographicZone = {
  ownerEid: new Uint32Array(MAX_OROGRAPHIC_ZONES),

  // Feature type.
  featureType: new Uint8Array(MAX_OROGRAPHIC_ZONES),

  // Center of the zone.
  cx: new Float32Array(MAX_OROGRAPHIC_ZONES),
  cz: new Float32Array(MAX_OROGRAPHIC_ZONES),

  // Peak / ridge elevation (metres above sea level).
  peakElevation: new Float32Array(MAX_OROGRAPHIC_ZONES),

  // Base elevation of the surrounding area (metres).
  baseElevation: new Float32Array(MAX_OROGRAPHIC_ZONES),

  // Horizontal extent (radius for peaks, length for ridges).
  extentX: new Float32Array(MAX_OROGRAPHIC_ZONES),
  extentZ: new Float32Array(MAX_OROGRAPHIC_ZONES),

  // Ridge axis orientation (radians) — used for elongated features.
  ridgeAxisAngle: new Float32Array(MAX_OROGRAPHIC_ZONES),

  // Ridge steepness (0..1; how abruptly the elevation increases).
  steepness: new Float32Array(MAX_OROGRAPHIC_ZONES),

  // Whether this zone is active.
  active: new Uint8Array(MAX_OROGRAPHIC_ZONES),

  // Seed.
  seed: new Uint32Array(MAX_OROGRAPHIC_ZONES),
};

/** Marker: entity is an orographic feature. */
export const OrographicZoneTag = {};

const _orographicZoneSlots = new Map();
let _nextOrographicZoneSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA VALLEY ZONE — for cold-air pooling and channeling
// ═══════════════════════════════════════════════════════════════════════

export const ValleyZone = {
  ownerEid: new Uint32Array(MAX_VALLEY_ZONES),

  // Valley centerline (two endpoints).
  startX: new Float32Array(MAX_VALLEY_ZONES),
  startZ: new Float32Array(MAX_VALLEY_ZONES),
  endX: new Float32Array(MAX_VALLEY_ZONES),
  endZ: new Float32Array(MAX_VALLEY_ZONES),

  // Floor elevation (metres).
  floorElevation: new Float32Array(MAX_VALLEY_ZONES),

  // Ridge elevation (surrounding peaks) (metres).
  ridgeElevation: new Float32Array(MAX_VALLEY_ZONES),

  // Valley width (metres).
  width: new Float32Array(MAX_VALLEY_ZONES),

  // Nighttime cold-pool strength (0..1).
  coldPoolStrength: new Float32Array(MAX_VALLEY_ZONES),

  // Active.
  active: new Uint8Array(MAX_VALLEY_ZONES),

  // Seed.
  seed: new Uint32Array(MAX_VALLEY_ZONES),
};

/** Marker: entity is a valley. */
export const ValleyZoneTag = {};

const _valleyZoneSlots = new Map();
let _nextValleyZoneSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA BREEZE CELL — lake / sea breeze
// ═══════════════════════════════════════════════════════════════════════

export const BreezeCell = {
  active: new Uint8Array(MAX_BREEZE_CELLS),

  // Water source entity (from file 059).
  waterEid: new Uint32Array(MAX_BREEZE_CELLS),

  // Center of the water body.
  cx: new Float32Array(MAX_BREEZE_CELLS),
  cz: new Float32Array(MAX_BREEZE_CELLS),

  // Water extent.
  radiusX: new Float32Array(MAX_BREEZE_CELLS),
  radiusZ: new Float32Array(MAX_BREEZE_CELLS),

  // Thermal mass (relative to a small lake).
  thermalMass: new Float32Array(MAX_BREEZE_CELLS),

  // Current breeze type (BreezeType).
  currentType: new Uint8Array(MAX_BREEZE_CELLS),

  // Current speed (m/s).
  currentSpeed: new Float32Array(MAX_BREEZE_CELLS),

  // Direction (unit vector).
  dirX: new Float32Array(MAX_BREEZE_CELLS),
  dirZ: new Float32Array(MAX_BREEZE_CELLS),

  // Temperature difference land - water (°C).
  landWaterDiff: new Float32Array(MAX_BREEZE_CELLS),
};

// ═══════════════════════════════════════════════════════════════════════
// SoA URBAN CANYON ZONE
// ═══════════════════════════════════════════════════════════════════════

export const UrbanCanyonZone = {
  ownerEid: new Uint32Array(MAX_URBAN_CANYON_ZONES),

  // Center of the urban area.
  cx: new Float32Array(MAX_URBAN_CANYON_ZONES),
  cz: new Float32Array(MAX_URBAN_CANYON_ZONES),

  // Urban extent.
  radiusX: new Float32Array(MAX_URBAN_CANYON_ZONES),
  radiusZ: new Float32Array(MAX_URBAN_CANYON_ZONES),

  // Street canyon height-to-width ratio (H/W; higher = stronger effect).
  canyonAspectRatio: new Float32Array(MAX_URBAN_CANYON_ZONES),

  // Active.
  active: new Uint8Array(MAX_URBAN_CANYON_ZONES),

  // Seed.
  seed: new Uint32Array(MAX_URBAN_CANYON_ZONES),
};

/** Marker: entity is an urban canyon zone. */
export const UrbanCanyonZoneTag = {};

const _urbanCanyonZoneSlots = new Map();
let _nextUrbanCanyonZoneSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA TERRAIN OBSERVER — samples terrain effects at a position
// ═══════════════════════════════════════════════════════════════════════

export const TerrainObserver = {
  ownerEid: new Uint32Array(MAX_TERRAIN_OBSERVERS),

  // Samples cached each frame.
  orographicLift: new Float32Array(MAX_TERRAIN_OBSERVERS),
  rainShadowFactor: new Float32Array(MAX_TERRAIN_OBSERVERS),
  foehnTempBoost: new Float32Array(MAX_TERRAIN_OBSERVERS),
  katabaticSpeed: new Float32Array(MAX_TERRAIN_OBSERVERS),
  katabaticTempDeficit: new Float32Array(MAX_TERRAIN_OBSERVERS),
  anabaticSpeed: new Float32Array(MAX_TERRAIN_OBSERVERS),
  breezeSpeed: new Float32Array(MAX_TERRAIN_OBSERVERS),
  breezeDirX: new Float32Array(MAX_TERRAIN_OBSERVERS),
  breezeDirZ: new Float32Array(MAX_TERRAIN_OBSERVERS),
  exposureFactor: new Float32Array(MAX_TERRAIN_OBSERVERS),
  urbanHeatBoost: new Float32Array(MAX_TERRAIN_OBSERVERS),
  urbanWindReduction: new Float32Array(MAX_TERRAIN_OBSERVERS),

  // Active.
  active: new Uint8Array(MAX_TERRAIN_OBSERVERS),
};

/** Marker: entity samples terrain effects. */
export const TerrainObserverTag = {};

const _terrainObserverSlots = new Map();
let _nextTerrainObserverSlot = 0;

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
// OROGRAPHIC ZONE API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add an orographic feature (mountain, ridge, peak, plateau).
 */
export function addOrographicZone(world, eid, featureType = OrographicFeature.MOUNTAIN_PEAK, options = {}) {
  if (_nextOrographicZoneSlot >= MAX_OROGRAPHIC_ZONES) {
    throw new Error('orographic zone capacity exceeded');
  }
  const slot = _nextOrographicZoneSlot++;

  addComponent(world, eid, OrographicZoneTag);

  const Z = OrographicZone;
  Z.ownerEid[slot] = eid;
  Z.featureType[slot] = featureType;
  Z.cx[slot] = options.cx ?? 0;
  Z.cz[slot] = options.cz ?? 0;
  Z.peakElevation[slot] = options.peakElevation ?? 2000;
  Z.baseElevation[slot] = options.baseElevation ?? 0;
  Z.extentX[slot] = options.extentX ?? 5000;
  Z.extentZ[slot] = options.extentZ ?? 5000;
  Z.ridgeAxisAngle[slot] = options.ridgeAxisAngle ?? 0;
  Z.steepness[slot] = options.steepness ?? 0.7;
  Z.active[slot] = 1;
  Z.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  _orographicZoneSlots.set(eid, slot);
  return slot;
}

export function removeOrographicZone(world, eid) {
  const slot = _orographicZoneSlots.get(eid);
  if (slot === undefined) return;
  OrographicZone.active[slot] = 0;
  OrographicZone.ownerEid[slot] = 0;
  _orographicZoneSlots.delete(eid);
  removeComponent(world, eid, OrographicZoneTag);
}

export function getOrographicZoneSlot(eid) {
  return _orographicZoneSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// VALLEY ZONE API
// ═══════════════════════════════════════════════════════════════════════

export function addValleyZone(world, eid, options = {}) {
  if (_nextValleyZoneSlot >= MAX_VALLEY_ZONES) {
    throw new Error('valley zone capacity exceeded');
  }
  const slot = _nextValleyZoneSlot++;

  addComponent(world, eid, ValleyZoneTag);

  const V = ValleyZone;
  V.ownerEid[slot] = eid;
  V.startX[slot] = options.startX ?? 0;
  V.startZ[slot] = options.startZ ?? 0;
  V.endX[slot] = options.endX ?? 10000;
  V.endZ[slot] = options.endZ ?? 0;
  V.floorElevation[slot] = options.floorElevation ?? 500;
  V.ridgeElevation[slot] = options.ridgeElevation ?? 1500;
  V.width[slot] = options.width ?? 1000;
  V.coldPoolStrength[slot] = options.coldPoolStrength ?? 1.0;
  V.active[slot] = 1;
  V.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  _valleyZoneSlots.set(eid, slot);
  return slot;
}

export function removeValleyZone(world, eid) {
  const slot = _valleyZoneSlots.get(eid);
  if (slot === undefined) return;
  ValleyZone.active[slot] = 0;
  ValleyZone.ownerEid[slot] = 0;
  _valleyZoneSlots.delete(eid);
  removeComponent(world, eid, ValleyZoneTag);
}

export function getValleyZoneSlot(eid) {
  return _valleyZoneSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// BREEZE CELL API — auto-registered from water bodies
// ═══════════════════════════════════════════════════════════════════════

export function addBreezeCell(world, waterEid) {
  for (let slot = 0; slot < MAX_BREEZE_CELLS; slot++) {
    if (BreezeCell.active[slot]) continue;

    const id = getId(waterEid);
    const M = WorldTransformF32.m;
    if (!M) return -1;
    const off = id * 16;

    // Find the water body component on this entity.
    let waterBodySlot = -1;
    for (let wb = 0; wb < WaterBody.active.length; wb++) {
      if (!WaterBody.active[wb]) continue;
      if (WaterBody.ownerEid[wb] === waterEid) {
        waterBodySlot = wb;
        break;
      }
    }
    if (waterBodySlot < 0) return -1;

    BreezeCell.active[slot] = 1;
    BreezeCell.waterEid[slot] = waterEid;
    BreezeCell.cx[slot] = WaterBody.cx[waterBodySlot];
    BreezeCell.cz[slot] = WaterBody.cz[waterBodySlot];
    BreezeCell.radiusX[slot] = WaterBody.radiusX[waterBodySlot];
    BreezeCell.radiusZ[slot] = WaterBody.radiusZ[waterBodySlot];

    // Estimate thermal mass from water body size.
    const area = PI * WaterBody.radiusX[waterBodySlot] * WaterBody.radiusZ[waterBodySlot];
    BreezeCell.thermalMass[slot] = Math.min(10, area / 1000000);

    BreezeCell.currentType[slot] = BreezeType.NONE;
    BreezeCell.currentSpeed[slot] = 0;
    BreezeCell.dirX[slot] = 0;
    BreezeCell.dirZ[slot] = 0;
    BreezeCell.landWaterDiff[slot] = 0;

    return slot;
  }
  return -1;
}

export function removeBreezeCell(slot) {
  if (slot < 0 || slot >= MAX_BREEZE_CELLS) return;
  BreezeCell.active[slot] = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// URBAN CANYON ZONE API
// ═══════════════════════════════════════════════════════════════════════

export function addUrbanCanyonZone(world, eid, options = {}) {
  if (_nextUrbanCanyonZoneSlot >= MAX_URBAN_CANYON_ZONES) {
    throw new Error('urban canyon capacity exceeded');
  }
  const slot = _nextUrbanCanyonZoneSlot++;

  addComponent(world, eid, UrbanCanyonZoneTag);

  UrbanCanyonZone.ownerEid[slot] = eid;
  UrbanCanyonZone.cx[slot] = options.cx ?? 0;
  UrbanCanyonZone.cz[slot] = options.cz ?? 0;
  UrbanCanyonZone.radiusX[slot] = options.radiusX ?? 2000;
  UrbanCanyonZone.radiusZ[slot] = options.radiusZ ?? 2000;
  UrbanCanyonZone.canyonAspectRatio[slot] = options.canyonAspectRatio ?? 1.0;
  UrbanCanyonZone.active[slot] = 1;
  UrbanCanyonZone.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  _urbanCanyonZoneSlots.set(eid, slot);
  return slot;
}

export function removeUrbanCanyonZone(world, eid) {
  const slot = _urbanCanyonZoneSlots.get(eid);
  if (slot === undefined) return;
  UrbanCanyonZone.active[slot] = 0;
  UrbanCanyonZone.ownerEid[slot] = 0;
  _urbanCanyonZoneSlots.delete(eid);
  removeComponent(world, eid, UrbanCanyonZoneTag);
}

export function getUrbanCanyonZoneSlot(eid) {
  return _urbanCanyonZoneSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// TERRAIN OBSERVER API
// ═══════════════════════════════════════════════════════════════════════

export function addTerrainObserver(world, eid) {
  if (_nextTerrainObserverSlot >= MAX_TERRAIN_OBSERVERS) {
    throw new Error('terrain observer capacity exceeded');
  }
  const slot = _nextTerrainObserverSlot++;

  addComponent(world, eid, TerrainObserverTag);

  TerrainObserver.ownerEid[slot] = eid;
  TerrainObserver.orographicLift[slot] = 0;
  TerrainObserver.rainShadowFactor[slot] = 1;
  TerrainObserver.foehnTempBoost[slot] = 0;
  TerrainObserver.katabaticSpeed[slot] = 0;
  TerrainObserver.katabaticTempDeficit[slot] = 0;
  TerrainObserver.anabaticSpeed[slot] = 0;
  TerrainObserver.breezeSpeed[slot] = 0;
  TerrainObserver.breezeDirX[slot] = 0;
  TerrainObserver.breezeDirZ[slot] = 0;
  TerrainObserver.exposureFactor[slot] = 1;
  TerrainObserver.urbanHeatBoost[slot] = 0;
  TerrainObserver.urbanWindReduction[slot] = 0;
  TerrainObserver.active[slot] = 1;

  _terrainObserverSlots.set(eid, slot);
  return slot;
}

export function removeTerrainObserver(world, eid) {
  const slot = _terrainObserverSlots.get(eid);
  if (slot === undefined) return;
  TerrainObserver.active[slot] = 0;
  TerrainObserver.ownerEid[slot] = 0;
  _terrainObserverSlots.delete(eid);
  removeComponent(world, eid, TerrainObserverTag);
}

export function getTerrainObserverSlot(eid) {
  return _terrainObserverSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// OROGRAPHIC LIFT — the core physics
// ═══════════════════════════════════════════════════════════════════════

const _windForTerrain = vec3.create();

/**
 * Compute orographic uplift (m/s) at a world position.
 * Uplift = u · ∇h where u is the wind and ∇h is the terrain gradient.
 *
 * @returns Uplift velocity (m/s; positive = upward).
 */
export function sampleOrographicLift(wx, wz, windSpeed, windDirX, windDirZ) {
  if (windSpeed < MIN_UPLIFT_WIND_SPEED) return 0;

  // Compute the terrain gradient by sampling the BVH at two nearby points.
  const step = 200.0;
  const hEast = sampleTerrainElevation(wx + step, wz);
  const hWest = sampleTerrainElevation(wx - step, wz);
  const hNorth = sampleTerrainElevation(wx, wz - step);
  const hSouth = sampleTerrainElevation(wx, wz + step);

  const gradX = (hEast - hWest) / (2 * step);
  const gradZ = (hNorth - hSouth) / (2 * step);

  // Uplift = wind · ∇h (dot product of wind with terrain gradient).
  const uplift = windSpeed * (windDirX * gradX + windDirZ * gradZ);

  return Math.max(0, Math.min(MAX_OROGRAPHIC_LIFT, uplift));
}

/**
 * Sample the terrain elevation at a world (X, Z) position.
 * Casts a ray down through the BVH.
 */
function sampleTerrainElevation(wx, wz) {
  const hits = bvhRaycast([wx, EXPOSURE_MAX_ALT, wz], [0, -1, 0],
    EXPOSURE_MAX_ALT - EXPOSURE_MIN_ALT, true);
  if (hits.length === 0) return 0;
  return EXPOSURE_MAX_ALT - hits[0].t;
}

// ═══════════════════════════════════════════════════════════════════════
// RAIN SHADOW — windward / leeward precipitation factor
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the rain shadow factor at a world position.
 * Windward slopes get 1.35× more precip; leeward get 0.20×.
 *
 * @returns Precipitation multiplier (0.2 to 1.35).
 */
export function sampleRainShadow(wx, wz, windDirX, windDirZ) {
  // Find the nearest orographic zone that could cast a shadow on this point.
  let shadowEffect = 0;

  for (let slot = 0; slot < _nextOrographicZoneSlot; slot++) {
    if (!OrographicZone.active[slot]) continue;

    const peakX = OrographicZone.cx[slot];
    const peakZ = OrographicZone.cz[slot];

    // Vector from peak to the sample point.
    const dx = wx - peakX;
    const dz = wz - peakZ;
    const dist = Math.hypot(dx, dz);

    // Sample must be downwind of the peak.
    const downwindDot = dx * windDirX + dz * windDirZ;
    if (downwindDot <= 0) continue;

    // Effect decays with distance.
    const decayDist = RAIN_SHADOW_TRANSITION_KM * 1000 * 2;
    if (dist > decayDist * 2) continue;

    const decay = Math.exp(-dist / decayDist);

    // Effect also depends on the peak's height above the base.
    const heightDiff = OrographicZone.peakElevation[slot] - OrographicZone.baseElevation[slot];
    const heightFactor = Math.min(1, heightDiff / 2000);

    shadowEffect += decay * heightFactor;
  }

  // Cap the shadow effect.
  shadowEffect = Math.min(1.5, shadowEffect);

  // Interpolate between leeward and windward multipliers.
  if (shadowEffect > 0.01) {
    return RAIN_SHADOW_LEEWARD_MULT + (1.0 - RAIN_SHADOW_LEEWARD_MULT)
      * Math.max(0, 1 - shadowEffect);
  }

  // Check for windward enhancement.
  let upwindEffect = 0;
  for (let slot = 0; slot < _nextOrographicZoneSlot; slot++) {
    if (!OrographicZone.active[slot]) continue;

    const peakX = OrographicZone.cx[slot];
    const peakZ = OrographicZone.cz[slot];

    // Vector from sample to peak.
    const dx = peakX - wx;
    const dz = peakZ - wz;
    const dist = Math.hypot(dx, dz);
    if (dist > RAIN_SHADOW_TRANSITION_KM * 1000 * 2) continue;

    // Peak must be downwind of the sample (i.e., sample is upwind).
    const upwindDot = dx * windDirX + dz * windDirZ;
    if (upwindDot <= 0) continue;

    const decay = Math.exp(-dist / (RAIN_SHADOW_TRANSITION_KM * 1000));
    const heightDiff = OrographicZone.peakElevation[slot] - OrographicZone.baseElevation[slot];
    const heightFactor = Math.min(1, heightDiff / 2000);

    upwindEffect += decay * heightFactor;
  }

  upwindEffect = Math.min(1.0, upwindEffect);
  return 1.0 + (RAIN_SHADOW_WINDWARD_MULT - 1.0) * upwindEffect;
}

// ═══════════════════════════════════════════════════════════════════════
// FOEHN / CHINOOK WIND
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the foehn (downslope warm dry wind) effect at a world position.
 *
 * @returns { tempBoost, humidityDrop, windBoost }
 */
export function sampleFoehnWind(wx, wz, windDirX, windDirZ, windSpeed) {
  let tempBoost = 0;
  let humidityDrop = 0;
  let windBoost = 0;

  for (let slot = 0; slot < _nextOrographicZoneSlot; slot++) {
    if (!OrographicZone.active[slot]) continue;

    const peakX = OrographicZone.cx[slot];
    const peakZ = OrographicZone.cz[slot];

    // Vector from peak to sample.
    const dx = wx - peakX;
    const dz = wz - peakZ;
    const dist = Math.hypot(dx, dz);
    if (dist > FOEHN_RAMP_KM * 1000 * 3) continue;

    // Must be downwind of the peak.
    const downwindDot = dx * windDirX + dz * windDirZ;
    if (downwindDot <= 0) continue;

    // Distance factor.
    const rampFactor = Math.exp(-dist / (FOEHN_RAMP_KM * 1000));

    // Height difference drives the strength.
    const heightDiff = OrographicZone.peakElevation[slot] - OrographicZone.baseElevation[slot];
    const heightFactor = Math.min(1, heightDiff / 2000);

    // Need a strong enough wind.
    const windFactor = Math.min(1, windSpeed / 8);

    const combinedFactor = rampFactor * heightFactor * windFactor;

    tempBoost += FOEHN_TEMP_BOOST_MAX * combinedFactor;
    humidityDrop += FOEHN_HUMIDITY_DROP_MAX * combinedFactor;
    windBoost += FOEHN_WIND_BOOST_MAX * combinedFactor;
  }

  return {
    tempBoost: Math.min(FOEHN_TEMP_BOOST_MAX, tempBoost),
    humidityDrop: Math.min(FOEHN_HUMIDITY_DROP_MAX, humidityDrop),
    windBoost: Math.min(FOEHN_WIND_BOOST_MAX, windBoost),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// KATABATIC FLOW — nighttime cold-air drainage
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the katabatic flow strength at a world position, given the
 * sun elevation (must be at or below horizon for katabatic to develop).
 *
 * @returns { speed, tempDeficit, dirX, dirZ }
 */
export function sampleKatabaticFlow(wx, wz, sunElevation) {
  if (sunElevation > KATABATIC_NIGHT_MIN_SUN_ELEV) {
    return { speed: 0, tempDeficit: 0, dirX: 0, dirZ: 0 };
  }

  let maxSpeed = 0;
  let maxDeficit = 0;
  let dirX = 0;
  let dirZ = 0;

  for (let slot = 0; slot < _nextValleyZoneSlot; slot++) {
    if (!ValleyZone.active[slot]) continue;

    // Check if the sample point is inside the valley (proximity to the
    // valley axis).
    const vx = ValleyZone.endX[slot] - ValleyZone.startX[slot];
    const vz = ValleyZone.endZ[slot] - ValleyZone.startZ[slot];
    const vLen = Math.hypot(vx, vz);
    if (vLen < EPSILON) continue;

    const normVx = vx / vLen;
    const normVz = vz / vLen;

    // Project sample point onto valley axis.
    const dx = wx - ValleyZone.startX[slot];
    const dz = wz - ValleyZone.startZ[slot];
    const along = dx * normVx + dz * normVz;
    if (along < 0 || along > vLen) continue;

    // Cross-valley distance.
    const cross = Math.abs(-dx * normVz + dz * normVx);
    if (cross > ValleyZone.width[slot] * 0.5) continue;

    // Katabatic strength: proportional to the elevation drop along the valley.
    const elevDrop = ValleyZone.ridgeElevation[slot] - ValleyZone.floorElevation[slot];
    const slope = elevDrop / vLen;

    // Night duration factor (deeper into night = stronger cold pool).
    const nightDepth = Math.max(0, -sunElevation) / (PI / 2);   // 0 to 1

    const speed = KATABATIC_MAX_SPEED * Math.min(1, slope * 3) * nightDepth
      * ValleyZone.coldPoolStrength[slot];
    const deficit = KATABATIC_TEMP_DEFICIT_MAX * Math.min(1, slope * 2) * nightDepth
      * ValleyZone.coldPoolStrength[slot];

    if (speed > maxSpeed) {
      maxSpeed = speed;
      maxDeficit = deficit;
      // Katabatic direction: down-valley (toward the outlet).
      dirX = normVx;
      dirZ = normVz;
    }
  }

  return { speed: maxSpeed, tempDeficit: maxDeficit, dirX, dirZ };
}

// ═══════════════════════════════════════════════════════════════════════
// ANABATIC FLOW — daytime upslope winds
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the anabatic flow (upslope wind) at a world position, given
 * the sun elevation (must be above threshold for anabatic to develop).
 *
 * @returns { speed, dirX, dirZ }
 */
export function sampleAnabaticFlow(wx, wz, sunElevation) {
  if (sunElevation < ANABATIC_SUN_MIN_ELEV) {
    return { speed: 0, dirX: 0, dirZ: 0 };
  }

  // Compute the local terrain gradient.
  const step = 200.0;
  const hEast = sampleTerrainElevation(wx + step, wz);
  const hWest = sampleTerrainElevation(wx - step, wz);
  const hNorth = sampleTerrainElevation(wx, wz - step);
  const hSouth = sampleTerrainElevation(wx, wz + step);

  const gradX = (hEast - hWest) / (2 * step);
  const gradZ = (hNorth - hSouth) / (2 * step);

  const gradMag = Math.hypot(gradX, gradZ);
  if (gradMag < 0.01) return { speed: 0, dirX: 0, dirZ: 0 };

  // Sun heating factor.
  const sunFactor = Math.min(1, (sunElevation - ANABATIC_SUN_MIN_ELEV) / (PI / 3));

  // Anabatic wind blows up-slope.
  const speed = ANABATIC_MAX_SPEED * Math.min(1, gradMag * 3) * sunFactor;

  return {
    speed,
    dirX: gradX / gradMag,
    dirZ: gradZ / gradMag,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// LAKE / SEA BREEZE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Update all breeze cells based on current time-of-day and temperatures.
 */
export function systemUpdateBreezes(hourOfDay, landTemp, waterTemp) {
  const landWaterDiff = landTemp - waterTemp;

  // Daytime sea breeze (land warmer than water).
  let dayFactor = 0;
  if (hourOfDay >= BREEZE_START_HOUR && hourOfDay <= BREEZE_END_HOUR) {
    const normalizedHour = (hourOfDay - BREEZE_START_HOUR)
      / (BREEZE_END_HOUR - BREEZE_START_HOUR);
    // Peaks at BREEZE_PEAK_HOUR.
    const peakNorm = (BREEZE_PEAK_HOUR - BREEZE_START_HOUR)
      / (BREEZE_END_HOUR - BREEZE_START_HOUR);
    dayFactor = 1 - Math.abs(normalizedHour - peakNorm) / peakNorm;
  }

  // Nighttime land breeze.
  let nightFactor = 0;
  if (hourOfDay < BREEZE_START_HOUR || hourOfDay > BREEZE_END_HOUR) {
    // Peaks at 3 AM.
    const nightHour = hourOfDay < BREEZE_START_HOUR ? hourOfDay + 24 : hourOfDay;
    nightFactor = Math.max(0, 1 - Math.abs(nightHour - 27) / 6);
  }

  for (let slot = 0; slot < MAX_BREEZE_CELLS; slot++) {
    if (!BreezeCell.active[slot]) continue;

    BreezeCell.landWaterDiff[slot] = landWaterDiff;

    // Sea breeze (daytime, land warmer).
    if (dayFactor > 0 && landWaterDiff > BREEZE_THERMAL_THRESHOLD) {
      BreezeCell.currentType[slot] = BreezeType.SEA_BREEZE;
      const thermal = Math.min(1, (landWaterDiff - BREEZE_THERMAL_THRESHOLD) / 8);
      BreezeCell.currentSpeed[slot] = BREEZE_MAX_SPEED * thermal * dayFactor
        * Math.min(1, BreezeCell.thermalMass[slot]);

      // Sea breeze direction: onshore (from water toward land).
      const dx = BreezeCell.cx[slot];
      const dz = BreezeCell.cz[slot];
      const dist = Math.hypot(dx, dz);
      if (dist > EPSILON) {
        BreezeCell.dirX[slot] = -dx / dist;
        BreezeCell.dirZ[slot] = -dz / dist;
      }
    }
    // Land breeze (nighttime, water warmer).
    else if (nightFactor > 0 && landWaterDiff < -BREEZE_THERMAL_THRESHOLD * 0.5) {
      BreezeCell.currentType[slot] = BreezeType.LAND_BREEZE;
      const thermal = Math.min(1, Math.abs(landWaterDiff) / 8);
      BreezeCell.currentSpeed[slot] = BREEZE_MAX_SPEED * 0.5 * thermal * nightFactor
        * Math.min(1, BreezeCell.thermalMass[slot]);

      // Land breeze direction: offshore (from land toward water).
      const dx = BreezeCell.cx[slot];
      const dz = BreezeCell.cz[slot];
      const dist = Math.hypot(dx, dz);
      if (dist > EPSILON) {
        BreezeCell.dirX[slot] = dx / dist;
        BreezeCell.dirZ[slot] = dz / dist;
      }
    } else {
      BreezeCell.currentType[slot] = BreezeType.NONE;
      BreezeCell.currentSpeed[slot] = 0;
    }
  }
}

/**
 * Sample the breeze velocity at a world position.
 */
export function sampleBreezeAt(wx, wz) {
  let bestSpeed = 0;
  let bestVx = 0;
  let bestVz = 0;

  for (let slot = 0; slot < MAX_BREEZE_CELLS; slot++) {
    if (!BreezeCell.active[slot]) continue;
    if (BreezeCell.currentSpeed[slot] < EPSILON) continue;

    // Distance from the water body center.
    const dx = wx - BreezeCell.cx[slot];
    const dz = wz - BreezeCell.cz[slot];
    const dist = Math.hypot(dx, dz);

    // Only affects positions within BREEZE_REACH_KM of the water's edge.
    const waterRadius = Math.max(BreezeCell.radiusX[slot], BreezeCell.radiusZ[slot]);
    const distanceFromEdge = Math.max(0, dist - waterRadius);
    if (distanceFromEdge > BREEZE_REACH_KM * 1000) continue;

    // Falloff with distance from the edge.
    const falloff = Math.exp(-distanceFromEdge / (BREEZE_REACH_KM * 1000 * 0.5));
    const localSpeed = BreezeCell.currentSpeed[slot] * falloff;

    if (localSpeed > bestSpeed) {
      bestSpeed = localSpeed;
      bestVx = BreezeCell.dirX[slot] * localSpeed;
      bestVz = BreezeCell.dirZ[slot] * localSpeed;
    }
  }

  return { vx: bestVx, vz: bestVz, speed: bestSpeed };
}

// ═══════════════════════════════════════════════════════════════════════
// VALLEY CHANNELING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Apply valley channeling to a wind vector. Amplifies the along-valley
 * component and dampens the cross-valley component.
 */
export function applyValleyChanneling(wx, wz, vx, vz) {
  for (let slot = 0; slot < _nextValleyZoneSlot; slot++) {
    if (!ValleyZone.active[slot]) continue;

    // Check if we're inside the valley.
    const valleyX = ValleyZone.endX[slot] - ValleyZone.startX[slot];
    const valleyZ = ValleyZone.endZ[slot] - ValleyZone.startZ[slot];
    const vLen = Math.hypot(valleyX, valleyZ);
    if (vLen < EPSILON) continue;

    const normVx = valleyX / vLen;
    const normVz = valleyZ / vLen;

    const dx = wx - ValleyZone.startX[slot];
    const dz = wz - ValleyZone.startZ[slot];
    const along = dx * normVx + dz * normVz;
    const cross = -dx * normVz + dz * normVx;

    if (along < 0 || along > vLen) continue;
    if (Math.abs(cross) > ValleyZone.width[slot] * 0.5) continue;

    // Decompose wind into along-valley and cross-valley components.
    const windAlong = vx * normVx + vz * normVz;
    const windCross = -vx * normVz + vz * normVx;

    // Amplify along, dampen cross.
    const newAlong = windAlong * VALLEY_CHANNEL_AMPLIFY;
    const newCross = windCross * VALLEY_CHANNEL_DAMPEN;

    // Recombine.
    vx = newAlong * normVx - newCross * normVz;
    vz = newAlong * normVz + newCross * normVx;
    break;
  }

  return { vx, vz };
}

// ═══════════════════════════════════════════════════════════════════════
// URBAN CANYON EFFECT
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the urban canyon effect at a world position.
 *
 * @returns { tempBoost, windReduction }
 */
export function sampleUrbanCanyon(wx, wz) {
  let tempBoost = 0;
  let windReduction = 0;

  for (let slot = 0; slot < _nextUrbanCanyonZoneSlot; slot++) {
    if (!UrbanCanyonZone.active[slot]) continue;

    const dx = (wx - UrbanCanyonZone.cx[slot]) / UrbanCanyonZone.radiusX[slot];
    const dz = (wz - UrbanCanyonZone.cz[slot]) / UrbanCanyonZone.radiusZ[slot];
    const distSq = dx * dx + dz * dz;

    if (distSq > 1.0) continue;

    const falloff = 1 - distSq;
    const aspectFactor = Math.min(1, UrbanCanyonZone.canyonAspectRatio[slot]);

    tempBoost += URBAN_CANYON_HEAT_BOOST * falloff * aspectFactor;
    windReduction += URBAN_CANYON_WIND_REDUCTION * falloff * aspectFactor;
  }

  return {
    tempBoost: Math.min(URBAN_CANYON_HEAT_BOOST * 2, tempBoost),
    windReduction: Math.min(URBAN_CANYON_WIND_REDUCTION * 2, windReduction),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// TOPOGRAPHIC EXPOSURE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the topographic exposure factor at a world position.
 * 1.0 = fully exposed (sky visible in all directions).
 * 0.0 = fully sheltered (surrounded by terrain).
 */
export function sampleTopographicExposure(wx, wz, altitudeM) {
  let visibleSky = 0;

  for (let i = 0; i < EXPOSURE_RAY_COUNT; i++) {
    const angle = (i / EXPOSURE_RAY_COUNT) * TWO_PI;

    // Cast upward at a 45° angle in each direction.
    const dirX = Math.cos(angle) * 0.7;
    const dirY = 0.7;
    const dirZ = Math.sin(angle) * 0.7;

    const hits = bvhRaycast([wx, altitudeM, wz], [dirX, dirY, dirZ],
      EXPOSURE_RAY_MAX_DIST, true);

    if (hits.length === 0) {
      visibleSky += 1;
    }
  }

  return visibleSky / EXPOSURE_RAY_COUNT;
}

// ═══════════════════════════════════════════════════════════════════════
// SNOW LINE / TREE LINE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the snow line altitude (metres) for a given latitude and season.
 */
export function computeSnowLine(latitudeDeg, season) {
  // Base: 2500 m.
  let snowLine = SNOW_LINE_DEFAULT_ALT_M;

  // Lower at high latitude.
  snowLine -= Math.abs(latitudeDeg) * SNOW_LINE_LAT_SCALE;

  // Season adjusts by ±500 m.
  if (season === Season.SUMMER) snowLine += 500;
  else if (season === Season.WINTER) snowLine -= 500;

  return Math.max(0, snowLine);
}

/**
 * Compute the tree line altitude (metres) for a given latitude.
 */
export function computeTreeLine(latitudeDeg, season) {
  let treeLine = TREE_LINE_DEFAULT_ALT_M;
  treeLine -= Math.abs(latitudeDeg) * TREE_LINE_LAT_SCALE;
  if (season === Season.SUMMER) treeLine += 200;
  else if (season === Season.WINTER) treeLine -= 200;
  return Math.max(0, treeLine);
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC SAMPLING — full terrain effect bundle at a point
// ═══════════════════════════════════════════════════════════════════════

const _windSampleTmp = vec3.create();

/**
 * Sample all terrain effects at a world position and return a full
 * bundle of derived quantities.
 */
export function sampleTerrainEffects(wx, wy, wz, sunElevation, hourOfDay, seasonSlot) {
  // Sample wind at the position.
  sampleWindAt(wx, wy, wz, _windSampleTmp);
  const windSpeed = Math.hypot(_windSampleTmp[0], _windSampleTmp[2]);
  const windDirX = windSpeed > EPSILON ? _windSampleTmp[0] / windSpeed : 1;
  const windDirZ = windSpeed > EPSILON ? _windSampleTmp[2] / windSpeed : 0;

  // Sample each terrain effect.
  const orographicLift = sampleOrographicLift(wx, wz, windSpeed, windDirX, windDirZ);
  const rainShadow = sampleRainShadow(wx, wz, windDirX, windDirZ);
  const foehn = sampleFoehnWind(wx, wz, windDirX, windDirZ, windSpeed);
  const katabatic = sampleKatabaticFlow(wx, wz, sunElevation);
  const anabatic = sampleAnabaticFlow(wx, wz, sunElevation);
  const breeze = sampleBreezeAt(wx, wz);
  const urban = sampleUrbanCanyon(wx, wz);

  // Valley channeling.
  const channeled = applyValleyChanneling(wx, wz, _windSampleTmp[0], _windSampleTmp[2]);

  // Topographic exposure.
  const terrainElev = sampleTerrainElevation(wx, wz);
  const exposure = sampleTopographicExposure(wx, wz, terrainElev);

  // Snow line.
  const season = seasonSlot >= 0 ? getSeason(seasonSlot) : Season.SPRING;
  const latitude = wy / 1000.0;   // rough lat estimate
  const snowLine = computeSnowLine(latitude, season);

  return {
    orographicLift,
    rainShadowFactor: rainShadow,
    foehnTempBoost: foehn.tempBoost,
    foehnHumidityDrop: foehn.humidityDrop,
    foehnWindBoost: foehn.windBoost,
    katabaticSpeed: katabatic.speed,
    katabaticTempDeficit: katabatic.tempDeficit,
    katabaticDirX: katabatic.dirX,
    katabaticDirZ: katabatic.dirZ,
    anabaticSpeed: anabatic.speed,
    anabaticDirX: anabatic.dirX,
    anabaticDirZ: anabatic.dirZ,
    breezeSpeed: breeze.speed,
    breezeVx: breeze.vx,
    breezeVz: breeze.vz,
    urbanTempBoost: urban.tempBoost,
    urbanWindReduction: urban.windReduction,
    channeledWindX: channeled.vx,
    channeledWindZ: channeled.vz,
    terrainElevation: terrainElev,
    exposureFactor: exposure,
    snowLineAltitude: snowLine,
    waterBodyPresence: findWaterBodyAt(wx, wz, 0, 50.0) >= 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TICK — apply terrain effects to weather fields
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance terrain effects for one frame:
 *   • Update breeze cells from current time and temperature.
 *   • Refresh terrain observers.
 *   • Apply rain-shadow precipitation modifiers to file 042's rain.
 *   • Apply katabatic / anabatic / foehn temperature corrections to
 *     file 069's temperature grid.
 */
export function systemUpdateTerrainEffects(world, dt, seasonSlot) {
  if (seasonSlot < 0) return world;

  const hourOfDay = SeasonRegion.hourOfDay[seasonSlot];
  const sunElev = getSunElevation(seasonSlot);
  const landTemp = getAmbientTemperature(seasonSlot);
  const waterTemp = landTemp - 2.0;   // approximate water temperature

  // Update breeze cells.
  systemUpdateBreezes(hourOfDay, landTemp, waterTemp);

  // Refresh terrain observers.
  const obs = TerrainObserver;
  for (let slot = 0; slot < _nextTerrainObserverSlot; slot++) {
    if (!obs.active[slot]) continue;

    const eid = obs.ownerEid[slot];
    if (!eid || !entityExists(world, eid)) continue;

    const id = getId(eid);
    const M = WorldTransformF32.m;
    if (!M) continue;
    const off = id * 16;
    const wx = M[off + 12];
    const wy = M[off + 13];
    const wz = M[off + 14];

    const effects = sampleTerrainEffects(wx, wy, wz, sunElev, hourOfDay, seasonSlot);

    obs.orographicLift[slot] = effects.orographicLift;
    obs.rainShadowFactor[slot] = effects.rainShadowFactor;
    obs.foehnTempBoost[slot] = effects.foehnTempBoost;
    obs.katabaticSpeed[slot] = effects.katabaticSpeed;
    obs.katabaticTempDeficit[slot] = effects.katabaticTempDeficit;
    obs.anabaticSpeed[slot] = effects.anabaticSpeed;
    obs.breezeSpeed[slot] = effects.breezeSpeed;
    obs.breezeDirX[slot] = effects.breezeVx;
    obs.breezeDirZ[slot] = effects.breezeVz;
    obs.exposureFactor[slot] = effects.exposureFactor;
    obs.urbanHeatBoost[slot] = effects.urbanTempBoost;
    obs.urbanWindReduction[slot] = effects.urbanWindReduction;
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS — coupling into other weather files
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the precipitation multiplier at a world position, factoring in
 * rain shadow, orographic enhancement, and upslope condensation.
 */
export function terrainPrecipitationMultiplier(wx, wz, windDirX, windDirZ, windSpeed) {
  const rainShadow = sampleRainShadow(wx, wz, windDirX, windDirZ);
  const uplift = sampleOrographicLift(wx, wz, windSpeed, windDirX, windDirZ);

  // Orographic enhancement: upslope adds precipitation.
  const orographicEnhancement = 1.0 + Math.min(1, uplift / MAX_OROGRAPHIC_LIFT) * 0.5;

  return rainShadow * orographicEnhancement;
}

/**
 * Return the temperature modifier (°C) from all terrain effects.
 */
export function terrainTemperatureModifier(wx, wz, sunElev, hourOfDay) {
  let modifier = 0;

  // Wind at the point.
  sampleWindAt(wx, 100, wz, _windSampleTmp);
  const windSpeed = Math.hypot(_windSampleTmp[0], _windSampleTmp[2]);
  const windDirX = windSpeed > EPSILON ? _windSampleTmp[0] / windSpeed : 1;
  const windDirZ = windSpeed > EPSILON ? _windSampleTmp[2] / windSpeed : 0;

  // Foehn temp boost.
  const foehn = sampleFoehnWind(wx, wz, windDirX, windDirZ, windSpeed);
  modifier += foehn.tempBoost;

  // Katabatic temp deficit.
  const katabatic = sampleKatabaticFlow(wx, wz, sunElev);
  modifier -= katabatic.tempDeficit;

  // Urban heat boost.
  const urban = sampleUrbanCanyon(wx, wz);
  modifier += urban.tempBoost;

  return modifier;
}

/**
 * Return the humidity modifier (fraction, 0..1) from all terrain effects.
 */
export function terrainHumidityModifier(wx, wz, sunElev) {
  let modifier = 1.0;

  // Foehn drying.
  sampleWindAt(wx, 100, wz, _windSampleTmp);
  const windSpeed = Math.hypot(_windSampleTmp[0], _windSampleTmp[2]);
  const windDirX = windSpeed > EPSILON ? _windSampleTmp[0] / windSpeed : 1;
  const windDirZ = windSpeed > EPSILON ? _windSampleTmp[2] / windSpeed : 0;

  const foehn = sampleFoehnWind(wx, wz, windDirX, windDirZ, windSpeed);
  modifier *= (1.0 - foehn.humidityDrop);

  // Orographic lift increases humidity near clouds.
  const uplift = sampleOrographicLift(wx, wz, windSpeed, windDirX, windDirZ);
  if (uplift > 0) {
    modifier *= (1.0 + Math.min(0.3, uplift / MAX_OROGRAPHIC_LIFT * 0.3));
  }

  return modifier;
}

/**
 * Return the wind modifier at a world position, combining valley
 * channeling, urban canyon reduction, foehn boost, breeze contribution,
 * and katabatic/anabatic flows.
 */
export function terrainWindModifier(wx, wz, sunElev) {
  // Sample base wind.
  sampleWindAt(wx, 100, wz, _windSampleTmp);
  let vx = _windSampleTmp[0];
  let vz = _windSampleTmp[2];

  // Valley channeling.
  const channeled = applyValleyChanneling(wx, wz, vx, vz);
  vx = channeled.vx;
  vz = channeled.vz;

  // Urban canyon wind reduction.
  const urban = sampleUrbanCanyon(wx, wz);
  vx *= (1 - urban.windReduction);
  vz *= (1 - urban.windReduction);

  // Foehn wind boost.
  const windSpeed = Math.hypot(vx, vz);
  const windDirX = windSpeed > EPSILON ? vx / windSpeed : 1;
  const windDirZ = windSpeed > EPSILON ? vz / windSpeed : 0;
  const foehn = sampleFoehnWind(wx, wz, windDirX, windDirZ, windSpeed);
  vx += windDirX * foehn.windBoost;
  vz += windDirZ * foehn.windBoost;

  // Katabatic flow.
  const katabatic = sampleKatabaticFlow(wx, wz, sunElev);
  vx += katabatic.dirX * katabatic.speed;
  vz += katabatic.dirZ * katabatic.speed;

  // Anabatic flow.
  const anabatic = sampleAnabaticFlow(wx, wz, sunElev);
  vx += anabatic.dirX * anabatic.speed;
  vz += anabatic.dirZ * anabatic.speed;

  // Breeze contribution.
  const breeze = sampleBreezeAt(wx, wz);
  vx += breeze.vx;
  vz += breeze.vz;

  return { vx, vz };
}

// ═══════════════════════════════════════════════════════════════════════
// AUTOMATIC SYNC — register orographic and breeze zones from world
// ═══════════════════════════════════════════════════════════════════════

/**
 * Automatically scan the world for water bodies and register breeze
 * cells for each.
 */
export function systemSyncBreezeCells(world) {
  const waterEids = query(world, [WaterBodyTag]);
  for (let i = 0; i < waterEids.length; i++) {
    const eid = waterEids[i];

    // Check if this water body already has a breeze cell.
    let alreadyRegistered = false;
    for (let slot = 0; slot < MAX_BREEZE_CELLS; slot++) {
      if (!BreezeCell.active[slot]) continue;
      if (BreezeCell.waterEid[slot] === eid) {
        alreadyRegistered = true;
        break;
      }
    }

    if (!alreadyRegistered) {
      addBreezeCell(world, eid);
    }
  }
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

export function gatherOrographicZonesForRendering() {
  const result = [];
  for (let slot = 0; slot < _nextOrographicZoneSlot; slot++) {
    if (!OrographicZone.active[slot]) continue;
    result.push({
      slot,
      featureType: OrographicZone.featureType[slot],
      cx: OrographicZone.cx[slot],
      cz: OrographicZone.cz[slot],
      peakElevation: OrographicZone.peakElevation[slot],
      baseElevation: OrographicZone.baseElevation[slot],
      extentX: OrographicZone.extentX[slot],
      extentZ: OrographicZone.extentZ[slot],
      steepness: OrographicZone.steepness[slot],
    });
  }
  return result;
}

export function gatherValleyZonesForRendering() {
  const result = [];
  for (let slot = 0; slot < _nextValleyZoneSlot; slot++) {
    if (!ValleyZone.active[slot]) continue;
    result.push({
      slot,
      startX: ValleyZone.startX[slot],
      startZ: ValleyZone.startZ[slot],
      endX: ValleyZone.endX[slot],
      endZ: ValleyZone.endZ[slot],
      floorElevation: ValleyZone.floorElevation[slot],
      ridgeElevation: ValleyZone.ridgeElevation[slot],
      width: ValleyZone.width[slot],
    });
  }
  return result;
}

export function gatherBreezesForRendering() {
  const result = [];
  for (let slot = 0; slot < MAX_BREEZE_CELLS; slot++) {
    if (!BreezeCell.active[slot]) continue;
    if (BreezeCell.currentSpeed[slot] < 0.1) continue;
    result.push({
      slot,
      cx: BreezeCell.cx[slot],
      cz: BreezeCell.cz[slot],
      radiusX: BreezeCell.radiusX[slot],
      radiusZ: BreezeCell.radiusZ[slot],
      currentType: BreezeCell.currentType[slot],
      speed: BreezeCell.currentSpeed[slot],
      dirX: BreezeCell.dirX[slot],
      dirZ: BreezeCell.dirZ[slot],
      landWaterDiff: BreezeCell.landWaterDiff[slot],
    });
  }
  return result;
}

export function gatherUrbanCanyonsForRendering() {
  const result = [];
  for (let slot = 0; slot < _nextUrbanCanyonZoneSlot; slot++) {
    if (!UrbanCanyonZone.active[slot]) continue;
    result.push({
      slot,
      cx: UrbanCanyonZone.cx[slot],
      cz: UrbanCanyonZone.cz[slot],
      radiusX: UrbanCanyonZone.radiusX[slot],
      radiusZ: UrbanCanyonZone.radiusZ[slot],
      canyonAspectRatio: UrbanCanyonZone.canyonAspectRatio[slot],
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function terrainEffectsStats() {
  let activeOrographic = 0;
  let activeValleys = 0;
  let activeBreezes = 0;
  let activeUrbanCanyons = 0;
  let activeObservers = 0;

  const breezeByType = new Uint8Array(5);

  for (let slot = 0; slot < _nextOrographicZoneSlot; slot++) {
    if (OrographicZone.active[slot]) activeOrographic++;
  }

  for (let slot = 0; slot < _nextValleyZoneSlot; slot++) {
    if (ValleyZone.active[slot]) activeValleys++;
  }

  for (let slot = 0; slot < MAX_BREEZE_CELLS; slot++) {
    if (!BreezeCell.active[slot]) continue;
    if (BreezeCell.currentSpeed[slot] > 0.1) {
      activeBreezes++;
      breezeByType[BreezeCell.currentType[slot]]++;
    }
  }

  for (let slot = 0; slot < _nextUrbanCanyonZoneSlot; slot++) {
    if (UrbanCanyonZone.active[slot]) activeUrbanCanyons++;
  }

  for (let slot = 0; slot < _nextTerrainObserverSlot; slot++) {
    if (TerrainObserver.active[slot]) activeObservers++;
  }

  return {
    activeOrographic,
    maxOrographic: MAX_OROGRAPHIC_ZONES,
    activeValleys,
    maxValleys: MAX_VALLEY_ZONES,
    activeBreezes,
    maxBreezes: MAX_BREEZE_CELLS,
    activeUrbanCanyons,
    maxUrbanCanyons: MAX_URBAN_CANYON_ZONES,
    activeObservers,
    maxObservers: MAX_TERRAIN_OBSERVERS,
    breezeByType: {
      none: breezeByType[BreezeType.NONE],
      seaBreeze: breezeByType[BreezeType.SEA_BREEZE],
      landBreeze: breezeByType[BreezeType.LAND_BREEZE],
      lakeBreeze: breezeByType[BreezeType.LAKE_BREEZE],
      lakeLandBreeze: breezeByType[BreezeType.LAKE_LAND_BREEZE],
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearTerrainEffects() {
  OrographicZone.active.fill(0);
  OrographicZone.ownerEid.fill(0);
  _orographicZoneSlots.clear();
  _nextOrographicZoneSlot = 0;

  ValleyZone.active.fill(0);
  ValleyZone.ownerEid.fill(0);
  _valleyZoneSlots.clear();
  _nextValleyZoneSlot = 0;

  BreezeCell.active.fill(0);
  BreezeCell.waterEid.fill(0);

  UrbanCanyonZone.active.fill(0);
  UrbanCanyonZone.ownerEid.fill(0);
  _urbanCanyonZoneSlots.clear();
  _nextUrbanCanyonZoneSlot = 0;

  TerrainObserver.active.fill(0);
  TerrainObserver.ownerEid.fill(0);
  _terrainObserverSlots.clear();
  _nextTerrainObserverSlot = 0;
}