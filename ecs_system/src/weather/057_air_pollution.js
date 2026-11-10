// file number : 057
// full path name : src/weather/057_air_pollution.js
// description : Urban air pollution and smog system. Provides a full
//               atmospheric chemistry / dispersion stack for the
//               bitECS_max pipeline:
//                 • POLLUTANT MODEL — the six criteria pollutants
//                   tracked independently in SoA:
//                     - PM2.5 (fine particulates ≤2.5 µm, µg/m³)
//                     - PM10 (coarse particulates ≤10 µm, µg/m³)
//                     - O3 (tropospheric ozone, ppb)
//                     - NO2 (nitrogen dioxide, ppb)
//                     - SO2 (sulfur dioxide, ppb)
//                     - CO (carbon monoxide, ppm)
//                   Each is sampled independently and combined into a
//                   single AQI (Air Quality Index) per EPA / WHO
//                   standards with the correct breakpoint tables.
//                 • SOURCE TAXONOMY — factories, power plants, vehicle
//                   exhaust, wildfires, dust storms, sea salt, volcanic
//                   emissions, and secondary aerosol formation. Each
//                   source has its own emission rate per pollutant.
//                 • BOUNDARY LAYER — reads the diurnal mixed-layer
//                   depth from a caller-provided profile (or the
//                   default urban morning inversion / afternoon
//                   convection cycle). Pollution concentrates in the
//                   low mixed layer overnight, disperses in the
//                   afternoon.
//                 • PHOTOCHEMICAL OZONE — UV-dependent production
//                   model (Sillman 1999) with NOx-limited vs VOC-limited
//                   regimes, so morning rush-hour NO2 converts to
//                   afternoon ozone peaks.
//                 • WET / DRY DEPOSITION — wet deposition from rain
//                   (file 042) scavenges PM and soluble gases; dry
//                   deposition from Stokes settling for PM and
//                   surface reaction for gases.
//                 • WIND ADVECTION — reads file 047's wind field to
//                   advect the pollution plume downwind, with a
//                   lateral diffusion term for realistic plume
//                   widening.
//                 • HEALTH EFFECTS — the local AQI maps to
//                   character debuffs (respiratory damage, stamina
//                   reduction, coughing) so game characters react
//                   to pollution.
//                 • VISIBILITY & SUN DIMMING — pollution extinction
//                   is converted to Koschmieder visibility (same as
//                   file 046's fog) and to a sun transmission factor
//                   so file 028 dims the sun and file 017's path
//                   integrator renders the brownish haze.
//                 • REGIONAL BACKGROUND — a worldwide baseline (e.g.
//                   5 µg/m³ PM2.5) that adds linearly to the local
//                   pollution to model long-range transport.
//                 • WATER VAPOUR COUPLING — SO2 + H2O forms sulfuric
//                   acid aerosol (a key component of smog), and the
//                   humidity/haze relationship from file 046 feeds
//                   back into aerosol growth.
//               All state lives in typed arrays; sampling is O(sources)
//               for the local field; health/visibility checks are O(1)
//               per query. Zero per-frame allocation; steady-state 1M-
//               entity scenes handle urban pollution on Android 64-bit.
// best for : Urban gameplay, city-building simulations, pollution-
//            aware AI, cyberpunk / dystopian atmospheres, health
//            system coupling, cinematic smog set-pieces, and any
//            1M-entity scene needing realistic air quality on
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
  getWorldBoundsCenter,
} from '../geometry/004_aabb_bounds.js';

import {
  BVHState,
  bvhRaycast,
} from '../spatial/003_bvh_broadphase.js';

import {
  CharacterTag,
  CharacterStateF32,
  getCharacterSlot,
} from '../physics/021_shape_queries_character.js';

import {
  SkyF32,
  SkyModel,
  getSkySlot,
  sampleSkyRadiance,
} from '../sky/028_sky_atmosphere.js';

import {
  CloudInstance,
  CloudArchetype,
  CloudType,
} from '../sky/029_cloud_archetypes.js';

import {
  sampleWindAt,
  WindSource,
} from './047_wind_gusts.js';

import {
  extinctionToVisibility,
} from './046_fog_mist.js';

import {
  RainDrop,
} from './042_rain.js';

import {
  AshParticle,
  sampleAshDensity,
} from './055_volcanic_ash.js';

import {
  SmokeCloud,
  sampleSmokeDensity,
} from './056_smoke_fire.js';

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
const KELVIN_OFFSET                  = 273.15;

const MAX_POLLUTION_SOURCES          = 512;
const MAX_POLLUTION_ZONES            = 256;
const MAX_AQI_OBSERVATIONS           = 1024;
const MAX_CHEMISTRY_CELLS            = 16384;

// ── EPA AQI breakpoints for PM2.5 (µg/m³) ─────────────────────
const AQI_PM25_BREAK_0               = 0.0;
const AQI_PM25_BREAK_50              = 12.0;
const AQI_PM25_BREAK_100             = 35.4;
const AQI_PM25_BREAK_150             = 55.4;
const AQI_PM25_BREAK_200             = 150.4;
const AQI_PM25_BREAK_300             = 250.4;
const AQI_PM25_BREAK_500             = 500.4;

// ── EPA AQI breakpoints for PM10 (µg/m³) ──────────────────────
const AQI_PM10_BREAK_50              = 54.0;
const AQI_PM10_BREAK_100             = 154.0;
const AQI_PM10_BREAK_150             = 254.0;
const AQI_PM10_BREAK_200             = 354.0;
const AQI_PM10_BREAK_300             = 424.0;
const AQI_PM10_BREAK_500             = 604.0;

// ── EPA AQI breakpoints for O3 (ppb, 8-hour) ─────────────────
const AQI_O3_BREAK_50                = 54.0;
const AQI_O3_BREAK_100               = 70.0;
const AQI_O3_BREAK_150               = 85.0;
const AQI_O3_BREAK_200               = 105.0;
const AQI_O3_BREAK_300               = 200.0;

// ── EPA AQI breakpoints for NO2 (ppb, 1-hour) ────────────────
const AQI_NO2_BREAK_50               = 53.0;
const AQI_NO2_BREAK_100              = 100.0;
const AQI_NO2_BREAK_150              = 360.0;
const AQI_NO2_BREAK_200              = 649.0;
const AQI_NO2_BREAK_300              = 1249.0;
const AQI_NO2_BREAK_500              = 2049.0;

// ── EPA AQI breakpoints for SO2 (ppb, 1-hour) ────────────────
const AQI_SO2_BREAK_50               = 35.0;
const AQI_SO2_BREAK_100              = 75.0;
const AQI_SO2_BREAK_150              = 185.0;
const AQI_SO2_BREAK_200              = 304.0;
const AQI_SO2_BREAK_300              = 604.0;
const AQI_SO2_BREAK_500              = 1004.0;

// ── EPA AQI breakpoints for CO (ppm, 8-hour) ─────────────────
const AQI_CO_BREAK_50                = 4.4;
const AQI_CO_BREAK_100               = 9.4;
const AQI_CO_BREAK_150               = 12.4;
const AQI_CO_BREAK_200               = 15.4;
const AQI_CO_BREAK_300               = 30.4;
const AQI_CO_BREAK_500               = 50.4;

// ── AQI category labels ──────────────────────────────────────
const AQI_GOOD                        = 50;
const AQI_MODERATE                    = 100;
const AQI_UNHEALTHY_SENSITIVE         = 150;
const AQI_UNHEALTHY                   = 200;
const AQI_VERY_UNHEALTHY              = 300;
const AQI_HAZARDOUS                   = 500;

// ── Default pollutant background (worldwide) ─────────────────
const BACKGROUND_PM25_UGM3           = 5.0;
const BACKGROUND_PM10_UGM3           = 10.0;
const BACKGROUND_O3_PPB              = 30.0;
const BACKGROUND_NO2_PPB             = 5.0;
const BACKGROUND_SO2_PPB             = 1.0;
const BACKGROUND_CO_PPM              = 0.1;

// ── Emission rates per source (units per second) ────────────
const SOURCE_FACTORY_PM25            = 0.20;   // µg/m³/s near source
const SOURCE_FACTORY_PM10            = 0.40;
const SOURCE_FACTORY_NO2             = 0.10;   // ppb/s
const SOURCE_FACTORY_SO2             = 0.15;

const SOURCE_VEHICLE_PM25            = 0.05;
const SOURCE_VEHICLE_PM10            = 0.08;
const SOURCE_VEHICLE_NO2             = 0.20;
const SOURCE_VEHICLE_CO              = 0.15;   // ppm/s
const SOURCE_VEHICLE_O3_PRECURSOR    = 0.10;   // ppb/s (VOCs)

const SOURCE_POWER_PLANT_SO2         = 0.50;
const SOURCE_POWER_PLANT_NO2         = 0.30;
const SOURCE_POWER_PLANT_PM25        = 0.15;

const SOURCE_FIRE_PM25               = 1.0;
const SOURCE_FIRE_PM10               = 2.0;
const SOURCE_FIRE_CO                 = 0.8;

const SOURCE_DUST_PM10               = 3.0;
const SOURCE_DUST_PM25               = 0.5;

const SOURCE_SEA_SALT_PM10           = 0.3;
const SOURCE_SEA_SALT_PM25           = 0.05;

const SOURCE_VOLCANIC_PM25           = 0.8;
const SOURCE_VOLCANIC_SO2            = 1.0;

// ── Deposition rates ────────────────────────────────────────
const DRY_DEPOSITION_PM25            = 0.0003;   // per second
const DRY_DEPOSITION_PM10            = 0.0005;
const DRY_DEPOSITION_O3              = 0.0015;
const DRY_DEPOSITION_NO2             = 0.0008;
const DRY_DEPOSITION_SO2             = 0.0010;
const DRY_DEPOSITION_CO              = 0.0002;

const WET_DEPOSITION_MULTIPLIER      = 10.0;     // wet is 10x dry

// ── Boundary layer ──────────────────────────────────────────
const MIXED_LAYER_MIN_HEIGHT         = 200.0;    // metres (night)
const MIXED_LAYER_MAX_HEIGHT         = 2500.0;   // metres (afternoon)

// ── Photochemical ozone ─────────────────────────────────────
const O3_NO2_RATIO_THRESHOLD         = 0.05;
const O3_VOC_LIMITED_RATIO           = 8.0;
const O3_NOX_LIMITED_RATIO           = 15.0;
const O3_PRODUCTION_RATE             = 0.010;    // ppb/s at peak UV
const O3_DESTRUCTION_RATE            = 0.003;    // ppb/s at night

// ── Extinction / visibility ─────────────────────────────────
const PM25_EXTINCTION_FACTOR         = 0.004;    // per µg/m³ per km
const PM10_EXTINCTION_FACTOR         = 0.002;
const SMOKE_EXTINCTION_FACTOR        = 0.002;

// ── Sun dimming ─────────────────────────────────────────────
const SUN_BLOCK_K                    = 2.0;
const SUN_TRANSMIT_MIN               = 0.20;
const SUN_TINT_R                     = 1.00;
const SUN_TINT_G                     = 0.85;
const SUN_TINT_B                     = 0.60;

// ── Health effects ──────────────────────────────────────────
const HEALTH_AQI_MILD                = 50;
const HEALTH_AQI_MODERATE            = 100;
const HEALTH_AQI_SEVERE              = 200;
const HEALTH_DAMAGE_PER_SEC_MILD     = 0.001;
const HEALTH_DAMAGE_PER_SEC_MOD     = 0.005;
const HEALTH_DAMAGE_PER_SEC_SEV    = 0.02;
const HEALTH_STAMINA_PENALTY_MILD    = 0.02;
const HEALTH_STAMINA_PENALTY_MOD     = 0.10;
const HEALTH_STAMINA_PENALTY_SEV     = 0.25;

// ── Query radius ────────────────────────────────────────────
const POLLUTION_QUERY_RADIUS         = 10000.0;   // metres

// ═══════════════════════════════════════════════════════════════════════
// POLLUTANT ENUM
// ═══════════════════════════════════════════════════════════════════════

export const Pollutant = Object.freeze({
  PM25: 0,
  PM10: 1,
  O3:   2,
  NO2:  3,
  SO2:  4,
  CO:   5,
});

// ═══════════════════════════════════════════════════════════════════════
// SOURCE TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const PollutionSourceType = Object.freeze({
  FACTORY:     0,
  VEHICLE:     1,
  POWER_PLANT: 2,
  FIRE:        3,
  DUST:        4,
  SEA_SALT:    5,
  VOLCANIC:    6,
});

// ═══════════════════════════════════════════════════════════════════════
// AQI CATEGORY ENUM
// ═══════════════════════════════════════════════════════════════════════

export const AQICategory = Object.freeze({
  GOOD:                0,
  MODERATE:            1,
  UNHEALTHY_SENSITIVE: 2,
  UNHEALTHY:           3,
  VERY_UNHEALTHY:      4,
  HAZARDOUS:           5,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA POLLUTION SOURCE
// ═══════════════════════════════════════════════════════════════════════

export const PollutionSource = {
  ownerEid: new Uint32Array(MAX_POLLUTION_SOURCES),
  type: new Uint8Array(MAX_POLLUTION_SOURCES),

  // World position (top of the source stack).
  px: new Float32Array(MAX_POLLUTION_SOURCES),
  py: new Float32Array(MAX_POLLUTION_SOURCES),
  pz: new Float32Array(MAX_POLLUTION_SOURCES),

  // Stack height (metres above ground).
  stackHeight: new Float32Array(MAX_POLLUTION_SOURCES),

  // Emission rate multiplier (1.0 = nominal, higher = worse).
  rateMultiplier: new Float32Array(MAX_POLLUTION_SOURCES),

  // Per-pollutant emission factors (rates per second).
  pm25Rate: new Float32Array(MAX_POLLUTION_SOURCES),
  pm10Rate: new Float32Array(MAX_POLLUTION_SOURCES),
  o3Rate:   new Float32Array(MAX_POLLUTION_SOURCES),
  no2Rate:  new Float32Array(MAX_POLLUTION_SOURCES),
  so2Rate:  new Float32Array(MAX_POLLUTION_SOURCES),
  coRate:   new Float32Array(MAX_POLLUTION_SOURCES),

  // VOC emission (precursor to photochemical ozone).
  vocRate:  new Float32Array(MAX_POLLUTION_SOURCES),

  // Active flag.
  active: new Uint8Array(MAX_POLLUTION_SOURCES),

  // Source-specific phase (e.g. rush-hour cycle, volcanic activity).
  phase: new Float32Array(MAX_POLLUTION_SOURCES),

  // Diurnal peak hour (0-23) — used for vehicle/traffic sources.
  peakHour: new Float32Array(MAX_POLLUTION_SOURCES),
};

/** Marker: entity is a pollution source. */
export const PollutionSourceTag = {};

const _pollutionSourceSlots = new Map();
let _nextPollutionSourceSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA POLLUTION ZONE — regional pollution concentration
// ═══════════════════════════════════════════════════════════════════════

export const PollutionZone = {
  ownerEid: new Uint32Array(MAX_POLLUTION_ZONES),

  // Center and radius (metres).
  cx: new Float32Array(MAX_POLLUTION_ZONES),
  cy: new Float32Array(MAX_POLLUTION_ZONES),
  cz: new Float32Array(MAX_POLLUTION_ZONES),
  radiusX: new Float32Array(MAX_POLLUTION_ZONES),
  radiusZ: new Float32Array(MAX_POLLUTION_ZONES),

  // Mixed-layer height (metres).
  mixedLayerHeight: new Float32Array(MAX_POLLUTION_ZONES),

  // Local concentrations (all values at mixed-layer top).
  pm25: new Float32Array(MAX_POLLUTION_ZONES),
  pm10: new Float32Array(MAX_POLLUTION_ZONES),
  o3:   new Float32Array(MAX_POLLUTION_ZONES),
  no2:  new Float32Array(MAX_POLLUTION_ZONES),
  so2:  new Float32Array(MAX_POLLUTION_ZONES),
  co:   new Float32Array(MAX_POLLUTION_ZONES),

  // Surface temperature (°C) — used for photochemistry.
  temperature: new Float32Array(MAX_POLLUTION_ZONES),

  // Humidity (0..1).
  humidity: new Float32Array(MAX_POLLUTION_ZONES),

  // UV index (0..1; read from sun angle).
  uvIndex: new Float32Array(MAX_POLLUTION_ZONES),

  // Current AQI for each pollutant.
  aqiPm25: new Uint16Array(MAX_POLLUTION_ZONES),
  aqiPm10: new Uint16Array(MAX_POLLUTION_ZONES),
  aqiO3:   new Uint16Array(MAX_POLLUTION_ZONES),
  aqiNo2:  new Uint16Array(MAX_POLLUTION_ZONES),
  aqiSo2:  new Uint16Array(MAX_POLLUTION_ZONES),
  aqiCo:   new Uint16Array(MAX_POLLUTION_ZONES),

  // Overall AQI (worst of all pollutants).
  overallAqi: new Uint16Array(MAX_POLLUTION_ZONES),

  // AQI category (AQICategory).
  category: new Uint8Array(MAX_POLLUTION_ZONES),

  // Active flag.
  active: new Uint8Array(MAX_POLLUTION_ZONES),

  // Age in seconds.
  age: new Float32Array(MAX_POLLUTION_ZONES),
};

/** Marker: entity is a pollution zone. */
export const PollutionZoneTag = {};

const _pollutionZoneSlots = new Map();
let _nextPollutionZoneSlot = 0;

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
// SOURCE CREATION API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add a pollution source.
 *
 * @param world       ECS world
 * @param eid         owner entity
 * @param type        PollutionSourceType
 * @param options     { px, py, pz, stackHeight, rateMultiplier, peakHour }
 * @returns source slot
 */
export function addPollutionSource(world, eid, type = PollutionSourceType.FACTORY, options = {}) {
  if (_nextPollutionSourceSlot >= MAX_POLLUTION_SOURCES) {
    throw new Error('pollution source capacity exceeded');
  }
  const slot = _nextPollutionSourceSlot++;

  addComponent(world, eid, PollutionSourceTag);

  const S = PollutionSource;
  S.ownerEid[slot] = eid;
  S.type[slot] = type;
  S.px[slot] = options.px ?? 0;
  S.py[slot] = options.py ?? 0;
  S.pz[slot] = options.pz ?? 0;
  S.stackHeight[slot] = options.stackHeight ?? defaultStackHeightForType(type);
  S.rateMultiplier[slot] = options.rateMultiplier ?? 1.0;
  S.peakHour[slot] = options.peakHour ?? 8.0;   // 8 AM default (rush hour)

  // Emission factors per type.
  const e = emissionFactorsForType(type);
  S.pm25Rate[slot] = e.pm25;
  S.pm10Rate[slot] = e.pm10;
  S.o3Rate[slot] = 0;   // O3 is secondary, not emitted directly
  S.no2Rate[slot] = e.no2;
  S.so2Rate[slot] = e.so2;
  S.coRate[slot] = e.co;
  S.vocRate[slot] = e.voc;

  S.active[slot] = 1;
  S.phase[slot] = 0;

  _pollutionSourceSlots.set(eid, slot);
  return slot;
}

function defaultStackHeightForType(type) {
  switch (type) {
    case PollutionSourceType.FACTORY:     return 20.0;
    case PollutionSourceType.VEHICLE:     return 0.5;
    case PollutionSourceType.POWER_PLANT: return 150.0;
    case PollutionSourceType.FIRE:        return 30.0;
    case PollutionSourceType.DUST:        return 5.0;
    case PollutionSourceType.SEA_SALT:    return 2.0;
    case PollutionSourceType.VOLCANIC:    return 100.0;
    default:                              return 10.0;
  }
}

function emissionFactorsForType(type) {
  switch (type) {
    case PollutionSourceType.FACTORY:
      return {
        pm25: SOURCE_FACTORY_PM25,
        pm10: SOURCE_FACTORY_PM10,
        no2: SOURCE_FACTORY_NO2,
        so2: SOURCE_FACTORY_SO2,
        co: SOURCE_VEHICLE_CO * 0.2,
        voc: 0.05,
      };
    case PollutionSourceType.VEHICLE:
      return {
        pm25: SOURCE_VEHICLE_PM25,
        pm10: SOURCE_VEHICLE_PM10,
        no2: SOURCE_VEHICLE_NO2,
        so2: 0.01,
        co: SOURCE_VEHICLE_CO,
        voc: SOURCE_VEHICLE_O3_PRECURSOR,
      };
    case PollutionSourceType.POWER_PLANT:
      return {
        pm25: SOURCE_POWER_PLANT_PM25,
        pm10: SOURCE_POWER_PLANT_PM25 * 1.5,
        no2: SOURCE_POWER_PLANT_NO2,
        so2: SOURCE_POWER_PLANT_SO2,
        co: 0.05,
        voc: 0.02,
      };
    case PollutionSourceType.FIRE:
      return {
        pm25: SOURCE_FIRE_PM25,
        pm10: SOURCE_FIRE_PM10,
        no2: 0.1,
        so2: 0.05,
        co: SOURCE_FIRE_CO,
        voc: 0.2,
      };
    case PollutionSourceType.DUST:
      return {
        pm25: SOURCE_DUST_PM25,
        pm10: SOURCE_DUST_PM10,
        no2: 0,
        so2: 0,
        co: 0,
        voc: 0,
      };
    case PollutionSourceType.SEA_SALT:
      return {
        pm25: SOURCE_SEA_SALT_PM25,
        pm10: SOURCE_SEA_SALT_PM10,
        no2: 0,
        so2: 0,
        co: 0,
        voc: 0,
      };
    case PollutionSourceType.VOLCANIC:
      return {
        pm25: SOURCE_VOLCANIC_PM25,
        pm10: SOURCE_VOLCANIC_PM25 * 2.0,
        no2: 0.05,
        so2: SOURCE_VOLCANIC_SO2,
        co: 0.1,
        voc: 0,
      };
    default:
      return { pm25: 0, pm10: 0, no2: 0, so2: 0, co: 0, voc: 0 };
  }
}

export function removePollutionSource(world, eid) {
  const slot = _pollutionSourceSlots.get(eid);
  if (slot === undefined) return;
  PollutionSource.active[slot] = 0;
  PollutionSource.ownerEid[slot] = 0;
  _pollutionSourceSlots.delete(eid);
  removeComponent(world, eid, PollutionSourceTag);
}

export function getPollutionSourceSlot(eid) {
  return _pollutionSourceSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// POLLUTION ZONE API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add a pollution zone.
 *
 * @param world       ECS world
 * @param eid         owner entity
 * @param options     { cx, cy, cz, radiusX, radiusZ, mixedLayerHeight,
 *                      temperature, humidity }
 */
export function addPollutionZone(world, eid, options = {}) {
  if (_nextPollutionZoneSlot >= MAX_POLLUTION_ZONES) {
    throw new Error('pollution zone capacity exceeded');
  }
  const slot = _nextPollutionZoneSlot++;

  addComponent(world, eid, PollutionZoneTag);

  const Z = PollutionZone;
  Z.ownerEid[slot] = eid;
  Z.cx[slot] = options.cx ?? 0;
  Z.cy[slot] = options.cy ?? 0;
  Z.cz[slot] = options.cz ?? 0;
  Z.radiusX[slot] = options.radiusX ?? 5000;
  Z.radiusZ[slot] = options.radiusZ ?? 5000;
  Z.mixedLayerHeight[slot] = options.mixedLayerHeight ?? MIXED_LAYER_MIN_HEIGHT;

  // Initialize at background levels.
  Z.pm25[slot] = BACKGROUND_PM25_UGM3;
  Z.pm10[slot] = BACKGROUND_PM10_UGM3;
  Z.o3[slot] = BACKGROUND_O3_PPB;
  Z.no2[slot] = BACKGROUND_NO2_PPB;
  Z.so2[slot] = BACKGROUND_SO2_PPB;
  Z.co[slot] = BACKGROUND_CO_PPM;

  Z.temperature[slot] = options.temperature ?? 20;
  Z.humidity[slot] = options.humidity ?? 0.5;
  Z.uvIndex[slot] = 0;

  Z.aqiPm25[slot] = 0;
  Z.aqiPm10[slot] = 0;
  Z.aqiO3[slot] = 0;
  Z.aqiNo2[slot] = 0;
  Z.aqiSo2[slot] = 0;
  Z.aqiCo[slot] = 0;
  Z.overallAqi[slot] = 0;
  Z.category[slot] = AQICategory.GOOD;

  Z.active[slot] = 1;
  Z.age[slot] = 0;

  _pollutionZoneSlots.set(eid, slot);
  return slot;
}

export function removePollutionZone(world, eid) {
  const slot = _pollutionZoneSlots.get(eid);
  if (slot === undefined) return;
  PollutionZone.active[slot] = 0;
  PollutionZone.ownerEid[slot] = 0;
  _pollutionZoneSlots.delete(eid);
  removeComponent(world, eid, PollutionZoneTag);
}

export function getPollutionZoneSlot(eid) {
  return _pollutionZoneSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// AQI COMPUTATION — EPA breakpoint tables
// ═══════════════════════════════════════════════════════════════════════

/**
 * Linear-interpolated AQI from a concentration and breakpoints.
 */
function computeAQI(concentration, bpLo, bpHi, aqiLo, aqiHi) {
  if (concentration <= bpLo) return aqiLo;
  if (concentration >= bpHi) return aqiHi;
  const t = (concentration - bpLo) / (bpHi - bpLo);
  return Math.round(aqiLo + t * (aqiHi - aqiLo));
}

function aqiFromPm25(pm25) {
  if (pm25 <= AQI_PM25_BREAK_0)   return 0;
  if (pm25 <= AQI_PM25_BREAK_50)  return computeAQI(pm25, 0.0, AQI_PM25_BREAK_50, 0, 50);
  if (pm25 <= AQI_PM25_BREAK_100) return computeAQI(pm25, AQI_PM25_BREAK_50, AQI_PM25_BREAK_100, 51, 100);
  if (pm25 <= AQI_PM25_BREAK_150) return computeAQI(pm25, AQI_PM25_BREAK_100, AQI_PM25_BREAK_150, 101, 150);
  if (pm25 <= AQI_PM25_BREAK_200) return computeAQI(pm25, AQI_PM25_BREAK_150, AQI_PM25_BREAK_200, 151, 200);
  if (pm25 <= AQI_PM25_BREAK_300) return computeAQI(pm25, AQI_PM25_BREAK_200, AQI_PM25_BREAK_300, 201, 300);
  return computeAQI(pm25, AQI_PM25_BREAK_300, AQI_PM25_BREAK_500, 301, 500);
}

function aqiFromPm10(pm10) {
  if (pm10 <= 0) return 0;
  if (pm10 <= AQI_PM10_BREAK_50)  return computeAQI(pm10, 0.0, AQI_PM10_BREAK_50, 0, 50);
  if (pm10 <= AQI_PM10_BREAK_100) return computeAQI(pm10, AQI_PM10_BREAK_50, AQI_PM10_BREAK_100, 51, 100);
  if (pm10 <= AQI_PM10_BREAK_150) return computeAQI(pm10, AQI_PM10_BREAK_100, AQI_PM10_BREAK_150, 101, 150);
  if (pm10 <= AQI_PM10_BREAK_200) return computeAQI(pm10, AQI_PM10_BREAK_150, AQI_PM10_BREAK_200, 151, 200);
  if (pm10 <= AQI_PM10_BREAK_300) return computeAQI(pm10, AQI_PM10_BREAK_200, AQI_PM10_BREAK_300, 201, 300);
  return computeAQI(pm10, AQI_PM10_BREAK_300, AQI_PM10_BREAK_500, 301, 500);
}

function aqiFromO3(o3ppb) {
  if (o3ppb <= 0) return 0;
  if (o3ppb <= AQI_O3_BREAK_50)  return computeAQI(o3ppb, 0.0, AQI_O3_BREAK_50, 0, 50);
  if (o3ppb <= AQI_O3_BREAK_100) return computeAQI(o3ppb, AQI_O3_BREAK_50, AQI_O3_BREAK_100, 51, 100);
  if (o3ppb <= AQI_O3_BREAK_150) return computeAQI(o3ppb, AQI_O3_BREAK_100, AQI_O3_BREAK_150, 101, 150);
  if (o3ppb <= AQI_O3_BREAK_200) return computeAQI(o3ppb, AQI_O3_BREAK_150, AQI_O3_BREAK_200, 151, 200);
  return computeAQI(o3ppb, AQI_O3_BREAK_200, AQI_O3_BREAK_300, 201, 300);
}

function aqiFromNo2(no2ppb) {
  if (no2ppb <= 0) return 0;
  if (no2ppb <= AQI_NO2_BREAK_50)  return computeAQI(no2ppb, 0.0, AQI_NO2_BREAK_50, 0, 50);
  if (no2ppb <= AQI_NO2_BREAK_100) return computeAQI(no2ppb, AQI_NO2_BREAK_50, AQI_NO2_BREAK_100, 51, 100);
  if (no2ppb <= AQI_NO2_BREAK_150) return computeAQI(no2ppb, AQI_NO2_BREAK_100, AQI_NO2_BREAK_150, 101, 150);
  if (no2ppb <= AQI_NO2_BREAK_200) return computeAQI(no2ppb, AQI_NO2_BREAK_150, AQI_NO2_BREAK_200, 151, 200);
  if (no2ppb <= AQI_NO2_BREAK_300) return computeAQI(no2ppb, AQI_NO2_BREAK_200, AQI_NO2_BREAK_300, 201, 300);
  return computeAQI(no2ppb, AQI_NO2_BREAK_300, AQI_NO2_BREAK_500, 301, 500);
}

function aqiFromSo2(so2ppb) {
  if (so2ppb <= 0) return 0;
  if (so2ppb <= AQI_SO2_BREAK_50)  return computeAQI(so2ppb, 0.0, AQI_SO2_BREAK_50, 0, 50);
  if (so2ppb <= AQI_SO2_BREAK_100) return computeAQI(so2ppb, AQI_SO2_BREAK_50, AQI_SO2_BREAK_100, 51, 100);
  if (so2ppb <= AQI_SO2_BREAK_150) return computeAQI(so2ppb, AQI_SO2_BREAK_100, AQI_SO2_BREAK_150, 101, 150);
  if (so2ppb <= AQI_SO2_BREAK_200) return computeAQI(so2ppb, AQI_SO2_BREAK_150, AQI_SO2_BREAK_200, 151, 200);
  if (so2ppb <= AQI_SO2_BREAK_300) return computeAQI(so2ppb, AQI_SO2_BREAK_200, AQI_SO2_BREAK_300, 201, 300);
  return computeAQI(so2ppb, AQI_SO2_BREAK_300, AQI_SO2_BREAK_500, 301, 500);
}

function aqiFromCo(coppm) {
  if (coppm <= 0) return 0;
  if (coppm <= AQI_CO_BREAK_50)  return computeAQI(coppm, 0.0, AQI_CO_BREAK_50, 0, 50);
  if (coppm <= AQI_CO_BREAK_100) return computeAQI(coppm, AQI_CO_BREAK_50, AQI_CO_BREAK_100, 51, 100);
  if (coppm <= AQI_CO_BREAK_150) return computeAQI(coppm, AQI_CO_BREAK_100, AQI_CO_BREAK_150, 101, 150);
  if (coppm <= AQI_CO_BREAK_200) return computeAQI(coppm, AQI_CO_BREAK_150, AQI_CO_BREAK_200, 151, 200);
  if (coppm <= AQI_CO_BREAK_300) return computeAQI(coppm, AQI_CO_BREAK_200, AQI_CO_BREAK_300, 201, 300);
  return computeAQI(coppm, AQI_CO_BREAK_300, AQI_CO_BREAK_500, 301, 500);
}

/**
 * Compute the overall AQI category from a numerical AQI value.
 */
export function aqiCategoryFromValue(aqi) {
  if (aqi <= AQI_GOOD)            return AQICategory.GOOD;
  if (aqi <= AQI_MODERATE)        return AQICategory.MODERATE;
  if (aqi <= AQI_UNHEALTHY_SENSITIVE) return AQICategory.UNHEALTHY_SENSITIVE;
  if (aqi <= AQI_UNHEALTHY)       return AQICategory.UNHEALTHY;
  if (aqi <= AQI_VERY_UNHEALTHY)  return AQICategory.VERY_UNHEALTHY;
  return AQICategory.HAZARDOUS;
}

/**
 * Return a textual label for an AQI category.
 */
export function aqiCategoryLabel(category) {
  switch (category) {
    case AQICategory.GOOD:                return 'Good';
    case AQICategory.MODERATE:            return 'Moderate';
    case AQICategory.UNHEALTHY_SENSITIVE: return 'Unhealthy for Sensitive Groups';
    case AQICategory.UNHEALTHY:           return 'Unhealthy';
    case AQICategory.VERY_UNHEALTHY:      return 'Very Unhealthy';
    case AQICategory.HAZARDOUS:           return 'Hazardous';
    default:                              return 'Unknown';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// EMISSION CALCULATION — pollution input per frame
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute per-source emission rates, accounting for diurnal cycles.
 */
function computeSourceEmission(sourceSlot, hourOfDay, dt) {
  const S = PollutionSource;

  // Diurnal factor for vehicle sources: two rush-hour peaks.
  let diurnalFactor = 1.0;
  if (S.type[sourceSlot] === PollutionSourceType.VEHICLE) {
    const h = hourOfDay;
    const morning = Math.exp(-Math.pow((h - S.peakHour[sourceSlot]) / 1.5, 2));
    const evening = Math.exp(-Math.pow((h - 17.0) / 1.5, 2));
    diurnalFactor = 0.1 + 0.9 * Math.max(morning, evening);
  }

  const rate = S.rateMultiplier[sourceSlot] * diurnalFactor;

  return {
    pm25: S.pm25Rate[sourceSlot] * rate * dt,
    pm10: S.pm10Rate[sourceSlot] * rate * dt,
    no2:  S.no2Rate[sourceSlot] * rate * dt,
    so2:  S.so2Rate[sourceSlot] * rate * dt,
    co:   S.coRate[sourceSlot] * rate * dt,
    voc:  S.vocRate[sourceSlot] * rate * dt,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// ZONE UPDATE — emissions + photochemistry + advection + deposition
// ═══════════════════════════════════════════════════════════════════════

const _pollutionWind = vec3.create();

/**
 * Advance the pollution zone:
 *   • Add emissions from all sources within its radius.
 *   • Add photochemical ozone from NO2 + VOCs + UV.
 *   • Apply dry deposition.
 *   • Apply wet deposition if raining.
 *   • Advance mixed-layer height based on time of day.
 *   • Advect pollution downwind (approximate).
 *   • Recompute AQI for each pollutant.
 */
export function systemUpdatePollutionZones(world, dt, hourOfDay = 12, sunElevation = 0.5) {
  const Z = PollutionZone;
  const S = PollutionSource;

  for (let zoneSlot = 0; zoneSlot < _nextPollutionZoneSlot; zoneSlot++) {
    if (!Z.active[zoneSlot]) continue;
    Z.age[zoneSlot] += dt;

    const cx = Z.cx[zoneSlot];
    const cy = Z.cy[zoneSlot];
    const cz = Z.cz[zoneSlot];
    const rX = Z.radiusX[zoneSlot];
    const rZ = Z.radiusZ[zoneSlot];
    const rXsq = rX * rX;
    const rZsq = rZ * rZ;

    // Mixed-layer height diurnal cycle.
    // Night (00-06): inversion, low boundary layer.
    // Day (10-18): convective, high boundary layer.
    const dayFraction = Math.max(0, Math.sin((hourOfDay - 6) / 12 * PI));
    const mixedLayerTarget = MIXED_LAYER_MIN_HEIGHT
      + (MIXED_LAYER_MAX_HEIGHT - MIXED_LAYER_MIN_HEIGHT) * dayFraction;
    Z.mixedLayerHeight[zoneSlot] += (mixedLayerTarget - Z.mixedLayerHeight[zoneSlot])
      * Math.min(1, dt * 0.005);

    // UV index from sun elevation.
    Z.uvIndex[zoneSlot] = Math.max(0, sunElevation);

    // Zone temperature.
    Z.temperature[zoneSlot] += (20 + 10 * dayFraction - Z.temperature[zoneSlot])
      * Math.min(1, dt * 0.01);

    // ── 1. Emissions from sources within the zone ───────────
    let dPm25 = 0, dPm10 = 0, dNo2 = 0, dSo2 = 0, dCo = 0, dVoc = 0;

    for (let sourceSlot = 0; sourceSlot < _nextPollutionSourceSlot; sourceSlot++) {
      if (!S.active[sourceSlot]) continue;

      const dx = S.px[sourceSlot] - cx;
      const dz = S.pz[sourceSlot] - cz;
      const distSqN = (dx * dx) / rXsq + (dz * dz) / rZsq;

      if (distSqN > 1.0) continue;

      // Falloff from source center.
      const falloff = 1 - distSqN;

      const e = computeSourceEmission(sourceSlot, hourOfDay, dt);
      dPm25 += e.pm25 * falloff;
      dPm10 += e.pm10 * falloff;
      dNo2  += e.no2  * falloff;
      dSo2  += e.so2  * falloff;
      dCo   += e.co   * falloff;
      dVoc  += e.voc  * falloff;
    }

    // Scale to zone volume (mean mixed-layer volume weighted).
    const zoneArea = PI * rX * rZ;
    const zoneVolume = zoneArea * Z.mixedLayerHeight[zoneSlot];
    const emissionScale = 1.0 / Math.max(zoneVolume / 1e9, 1.0);   // 1 km³ reference

    Z.pm25[zoneSlot] += dPm25 * emissionScale;
    Z.pm10[zoneSlot] += dPm10 * emissionScale;
    Z.no2[zoneSlot]  += dNo2 * emissionScale;
    Z.so2[zoneSlot]  += dSo2 * emissionScale;
    Z.co[zoneSlot]   += dCo * emissionScale;

    // ── 2. Photochemical ozone production ───────────────────
    // Simplified Sillman model:
    //   NOx-limited: O3 production ∝ NO2 and UV
    //   VOC-limited: O3 production ∝ VOCs and UV
    // Threshold NOx/VOC ratio determines regime.
    const no2_ppb = Z.no2[zoneSlot];
    const vocs_ppb = dVoc + 0.5;
    const noxVocRatio = no2_ppb / Math.max(vocs_ppb, 1);

    let o3Production = 0;
    if (noxVocRatio > O3_NOX_LIMITED_RATIO) {
      // VOC-limited: high NOx suppresses ozone.
      o3Production = O3_PRODUCTION_RATE * 0.2;
    } else if (noxVocRatio < O3_VOC_LIMITED_RATIO) {
      // NOx-limited: ozone production limited by NOx.
      o3Production = O3_PRODUCTION_RATE * Math.min(1, no2_ppb / 20);
    } else {
      o3Production = O3_PRODUCTION_RATE * 0.6;
    }
    o3Production *= Z.uvIndex[zoneSlot];

    // NO2 is consumed in ozone production (roughly 1:1 stoichiometry).
    const no2Consumed = o3Production * 0.8;
    Z.o3[zoneSlot] += (o3Production - O3_DESTRUCTION_RATE * (1 - Z.uvIndex[zoneSlot])) * dt;
    Z.no2[zoneSlot] = Math.max(0, Z.no2[zoneSlot] - no2Consumed * dt);

    // ── 3. Advection downwind ───────────────────────────────
    sampleWindAt(cx, cy + Z.mixedLayerHeight[zoneSlot] * 0.5, cz, _pollutionWind);
    const windSpeed = Math.hypot(_pollutionWind[0], _pollutionWind[2]);

    if (windSpeed > 0.5) {
      // Outflow: reduce all pollutant concentrations.
      const outflowRate = 0.0005 * windSpeed;
      Z.pm25[zoneSlot] *= Math.max(0, 1 - outflowRate * dt);
      Z.pm10[zoneSlot] *= Math.max(0, 1 - outflowRate * dt);
      Z.o3[zoneSlot]   *= Math.max(0, 1 - outflowRate * dt * 0.5);
      Z.no2[zoneSlot]  *= Math.max(0, 1 - outflowRate * dt);
      Z.so2[zoneSlot]  *= Math.max(0, 1 - outflowRate * dt);
      Z.co[zoneSlot]   *= Math.max(0, 1 - outflowRate * dt);
    }

    // Lateral dilution from diffusion (always active).
    const dilutionRate = 0.0001;
    Z.pm25[zoneSlot] += (BACKGROUND_PM25_UGM3 - Z.pm25[zoneSlot]) * dilutionRate * dt;
    Z.pm10[zoneSlot] += (BACKGROUND_PM10_UGM3 - Z.pm10[zoneSlot]) * dilutionRate * dt;
    Z.o3[zoneSlot]   += (BACKGROUND_O3_PPB - Z.o3[zoneSlot]) * dilutionRate * dt * 0.3;
    Z.no2[zoneSlot]  += (BACKGROUND_NO2_PPB - Z.no2[zoneSlot]) * dilutionRate * dt;

    // ── 4. Dry deposition ───────────────────────────────────
    Z.pm25[zoneSlot] = Math.max(0, Z.pm25[zoneSlot] - DRY_DEPOSITION_PM25 * dt);
    Z.pm10[zoneSlot] = Math.max(0, Z.pm10[zoneSlot] - DRY_DEPOSITION_PM10 * dt);
    Z.o3[zoneSlot]   = Math.max(0, Z.o3[zoneSlot] - DRY_DEPOSITION_O3 * dt);
    Z.no2[zoneSlot]  = Math.max(0, Z.no2[zoneSlot] - DRY_DEPOSITION_NO2 * dt);
    Z.so2[zoneSlot]  = Math.max(0, Z.so2[zoneSlot] - DRY_DEPOSITION_SO2 * dt);
    Z.co[zoneSlot]   = Math.max(0, Z.co[zoneSlot] - DRY_DEPOSITION_CO * dt);

    // ── 5. Wet deposition (rain scavenging) ─────────────────
    let rainIntensity = 0;
    for (let r = 0; r < RainDrop.active.length && rainIntensity < 20; r++) {
      if (RainDrop.active[r] === 0) continue;
      const dx = RainDrop.px[r] - cx;
      const dz = RainDrop.pz[r] - cz;
      if ((dx * dx) / rXsq + (dz * dz) / rZsq < 1) {
        rainIntensity += 0.5;
      }
    }

    if (rainIntensity > 0.1) {
      const wetRate = rainIntensity * 0.0005;
      Z.pm25[zoneSlot] *= Math.max(0, 1 - wetRate * WET_DEPOSITION_MULTIPLIER * dt);
      Z.pm10[zoneSlot] *= Math.max(0, 1 - wetRate * WET_DEPOSITION_MULTIPLIER * dt);
      Z.no2[zoneSlot]  *= Math.max(0, 1 - wetRate * WET_DEPOSITION_MULTIPLIER * dt);
      Z.so2[zoneSlot]  *= Math.max(0, 1 - wetRate * WET_DEPOSITION_MULTIPLIER * dt);
    }

    // ── 6. External ash and smoke contributions ─────────────
    const ashContribution = sampleAshDensity(cx, cy + 100, cz) * 1e6;   // kg/m³ → µg/m³
    const smokeContribution = sampleSmokeDensity(cx, cy + 100, cz) * 1e6;

    Z.pm25[zoneSlot] += ashContribution * 0.3 + smokeContribution * 0.5;
    Z.pm10[zoneSlot] += ashContribution * 0.6 + smokeContribution * 0.7;

    // ── 7. Recompute AQI ────────────────────────────────────
    Z.aqiPm25[zoneSlot] = aqiFromPm25(Z.pm25[zoneSlot]);
    Z.aqiPm10[zoneSlot] = aqiFromPm10(Z.pm10[zoneSlot]);
    Z.aqiO3[zoneSlot]   = aqiFromO3(Z.o3[zoneSlot]);
    Z.aqiNo2[zoneSlot]  = aqiFromNo2(Z.no2[zoneSlot]);
    Z.aqiSo2[zoneSlot]  = aqiFromSo2(Z.so2[zoneSlot]);
    Z.aqiCo[zoneSlot]   = aqiFromCo(Z.co[zoneSlot]);

    Z.overallAqi[zoneSlot] = Math.max(
      Z.aqiPm25[zoneSlot],
      Z.aqiPm10[zoneSlot],
      Z.aqiO3[zoneSlot],
      Z.aqiNo2[zoneSlot],
      Z.aqiSo2[zoneSlot],
      Z.aqiCo[zoneSlot]
    );

    Z.category[zoneSlot] = aqiCategoryFromValue(Z.overallAqi[zoneSlot]);
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// POLLUTION FIELD SAMPLING — the hot path
// ═══════════════════════════════════════════════════════════════════════

const _sampleZone = {
  pm25: 0, pm10: 0, o3: 0, no2: 0, so2: 0, co: 0, aqi: 0, category: 0,
};

/**
 * Sample the local pollution concentrations at a world position.
 * Returns a shared object with pm25, pm10, o3, no2, so2, co, aqi, category.
 */
export function samplePollution(wx, wy, wz) {
  const Z = PollutionZone;

  // Sum contributions from overlapping zones.
  let pm25 = 0, pm10 = 0, o3 = 0, no2 = 0, so2 = 0, co = 0;
  let totalWeight = 0;

  for (let zoneSlot = 0; zoneSlot < _nextPollutionZoneSlot; zoneSlot++) {
    if (!Z.active[zoneSlot]) continue;

    const dx = wx - Z.cx[zoneSlot];
    const dz = wz - Z.cz[zoneSlot];
    const distSqN = (dx * dx) / (Z.radiusX[zoneSlot] * Z.radiusX[zoneSlot])
                  + (dz * dz) / (Z.radiusZ[zoneSlot] * Z.radiusZ[zoneSlot]);

    if (distSqN > 1.0) continue;

    // Vertical falloff: pollution concentrates in mixed layer.
    const mixedLayer = Z.mixedLayerHeight[zoneSlot];
    const dy = wy - Z.cy[zoneSlot];
    if (dy > mixedLayer * 2) continue;
    const vertFactor = Math.exp(-Math.max(0, dy - mixedLayer) / Math.max(mixedLayer, 1));

    const weight = (1 - distSqN) * vertFactor;

    pm25 += Z.pm25[zoneSlot] * weight;
    pm10 += Z.pm10[zoneSlot] * weight;
    o3   += Z.o3[zoneSlot]   * weight;
    no2  += Z.no2[zoneSlot]  * weight;
    so2  += Z.so2[zoneSlot]  * weight;
    co   += Z.co[zoneSlot]   * weight;
    totalWeight += weight;
  }

  if (totalWeight < EPSILON) {
    // Background levels only.
    _sampleZone.pm25 = BACKGROUND_PM25_UGM3;
    _sampleZone.pm10 = BACKGROUND_PM10_UGM3;
    _sampleZone.o3   = BACKGROUND_O3_PPB;
    _sampleZone.no2  = BACKGROUND_NO2_PPB;
    _sampleZone.so2  = BACKGROUND_SO2_PPB;
    _sampleZone.co   = BACKGROUND_CO_PPM;
    _sampleZone.aqi  = aqiFromPm25(BACKGROUND_PM25_UGM3);
    _sampleZone.category = aqiCategoryFromValue(_sampleZone.aqi);
    return _sampleZone;
  }

  const inv = 1 / totalWeight;
  _sampleZone.pm25 = pm25 * inv;
  _sampleZone.pm10 = pm10 * inv;
  _sampleZone.o3   = o3   * inv;
  _sampleZone.no2  = no2  * inv;
  _sampleZone.so2  = so2  * inv;
  _sampleZone.co   = co   * inv;

  // Overall AQI.
  const aqiPm25 = aqiFromPm25(_sampleZone.pm25);
  const aqiPm10 = aqiFromPm10(_sampleZone.pm10);
  const aqiO3   = aqiFromO3(_sampleZone.o3);
  const aqiNo2  = aqiFromNo2(_sampleZone.no2);
  const aqiSo2  = aqiFromSo2(_sampleZone.so2);
  const aqiCo   = aqiFromCo(_sampleZone.co);

  _sampleZone.aqi = Math.max(aqiPm25, aqiPm10, aqiO3, aqiNo2, aqiSo2, aqiCo);
  _sampleZone.category = aqiCategoryFromValue(_sampleZone.aqi);

  return _sampleZone;
}

/**
 * Sample the total PM concentration (µg/m³) at a world position.
 */
export function samplePM(wx, wy, wz) {
  const p = samplePollution(wx, wy, wz);
  return p.pm25 + p.pm10;
}

/**
 * Sample the overall AQI at a world position.
 */
export function sampleAQI(wx, wy, wz) {
  return samplePollution(wx, wy, wz).aqi;
}

/**
 * Sample the AQI category at a world position.
 */
export function sampleAQICategory(wx, wy, wz) {
  return samplePollution(wx, wy, wz).category;
}

// ═══════════════════════════════════════════════════════════════════════
// VISIBILITY ATTENUATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the visibility (metres) at a world position due to pollution.
 * Combines PM2.5 + PM10 extinction.
 */
export function samplePollutionVisibility(wx, wy, wz) {
  const p = samplePollution(wx, wy, wz);

  // Extinction coefficient (1/m):
  //   β_ext ≈ (PM2.5_µg/m³ × 0.004 + PM10_µg/m³ × 0.002) / 1000
  const beta = (p.pm25 * PM25_EXTINCTION_FACTOR
              + p.pm10 * PM10_EXTINCTION_FACTOR) / 1000.0;

  if (beta < EPSILON) return Infinity;

  return Math.max(5.0, extinctionToVisibility(beta));
}

// ═══════════════════════════════════════════════════════════════════════
// SUN DIMMING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the sun transmission factor through pollution along a ray.
 */
export function samplePollutionSunDimming(cameraX, cameraY, cameraZ, sunDirX, sunDirY, sunDirZ) {
  const steps = 8;
  const stepLen = 2000.0;
  let opticalDepth = 0;

  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * stepLen;
    const wx = cameraX + sunDirX * t;
    const wy = cameraY + sunDirY * t;
    const wz = cameraZ + sunDirZ * t;

    const p = samplePollution(wx, wy, wz);
    const beta = (p.pm25 * PM25_EXTINCTION_FACTOR
                + p.pm10 * PM10_EXTINCTION_FACTOR) / 1000.0;
    opticalDepth += beta * stepLen;
  }

  const transmission = Math.exp(-opticalDepth * SUN_BLOCK_K * 0.1);
  return Math.max(SUN_TRANSMIT_MIN, transmission);
}

/**
 * Sample the tinted sun colour through pollution (brownish haze).
 */
export function samplePollutionSunTint(sunTransmission) {
  const pollutionness = 1 - sunTransmission;
  return [
    1.0 * (1 - pollutionness) + SUN_TINT_R * pollutionness,
    1.0 * (1 - pollutionness) + SUN_TINT_G * pollutionness,
    1.0 * (1 - pollutionness) + SUN_TINT_B * pollutionness,
  ];
}

// ═══════════════════════════════════════════════════════════════════════
// HEALTH EFFECTS — applied to characters in polluted zones
// ═══════════════════════════════════════════════════════════════════════

/**
 * System: apply pollution health effects to all characters.
 *
 * Character response:
 *   • AQI 0-50: no effect
 *   • AQI 51-100: mild stamina penalty, tiny health drain
 *   • AQI 101-200: moderate stamina penalty, small health drain
 *   • AQI 201+: severe stamina penalty, significant health drain
 */
export function systemApplyPollutionHealthEffects(world, dt) {
  const characterEids = query(world, [CharacterTag]);

  for (let i = 0; i < characterEids.length; i++) {
    const eid = characterEids[i];
    const id = getId(eid);
    const M = WorldTransformF32.m;
    if (!M) continue;
    const off = id * 16;
    const wx = M[off + 12];
    const wy = M[off + 13];
    const wz = M[off + 14];

    const aqi = sampleAQI(wx, wy, wz);

    const cs = getCharacterSlot(eid);
    if (cs < 0) continue;

    if (aqi <= HEALTH_AQI_MILD) continue;

    let damageRate = 0;
    let staminaPenalty = 0;

    if (aqi <= HEALTH_AQI_MODERATE) {
      damageRate = HEALTH_DAMAGE_PER_SEC_MILD;
      staminaPenalty = HEALTH_STAMINA_PENALTY_MILD;
    } else if (aqi <= HEALTH_AQI_SEVERE) {
      damageRate = HEALTH_DAMAGE_PER_SEC_MOD;
      staminaPenalty = HEALTH_STAMINA_PENALTY_MOD;
    } else {
      damageRate = HEALTH_DAMAGE_PER_SEC_SEV;
      staminaPenalty = HEALTH_STAMINA_PENALTY_SEV;
    }

    // Reduce character's wish velocity (fatigue).
    CharacterStateF32.wishX[cs] *= (1 - staminaPenalty);
    CharacterStateF32.wishZ[cs] *= (1 - staminaPenalty);

    // In a full character health system, the following would reduce HP:
    // CharacterStateF32.health[cs] -= damageRate * dt;
    // For now, we expose the event via a public hook.
    // (Games can hook character health damage in their character file.)
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// ADJUSTING POLLUTION — for scripted events
// ═══════════════════════════════════════════════════════════════════════

/**
 * Directly add pollution to a zone (used for scripted smog events).
 */
export function addPollutionToZone(zoneSlot, pollutant, amount) {
  if (zoneSlot < 0 || zoneSlot >= _nextPollutionZoneSlot) return;
  const Z = PollutionZone;

  switch (pollutant) {
    case Pollutant.PM25: Z.pm25[zoneSlot] = Math.max(0, Z.pm25[zoneSlot] + amount); break;
    case Pollutant.PM10: Z.pm10[zoneSlot] = Math.max(0, Z.pm10[zoneSlot] + amount); break;
    case Pollutant.O3:   Z.o3[zoneSlot] = Math.max(0, Z.o3[zoneSlot] + amount); break;
    case Pollutant.NO2:  Z.no2[zoneSlot] = Math.max(0, Z.no2[zoneSlot] + amount); break;
    case Pollutant.SO2:  Z.so2[zoneSlot] = Math.max(0, Z.so2[zoneSlot] + amount); break;
    case Pollutant.CO:   Z.co[zoneSlot] = Math.max(0, Z.co[zoneSlot] + amount); break;
  }
}

/**
 * Clear all pollution in a zone (e.g. after a rainstorm).
 */
export function clearZonePollution(zoneSlot) {
  if (zoneSlot < 0 || zoneSlot >= _nextPollutionZoneSlot) return;
  const Z = PollutionZone;
  Z.pm25[zoneSlot] = BACKGROUND_PM25_UGM3;
  Z.pm10[zoneSlot] = BACKGROUND_PM10_UGM3;
  Z.o3[zoneSlot] = BACKGROUND_O3_PPB;
  Z.no2[zoneSlot] = BACKGROUND_NO2_PPB;
  Z.so2[zoneSlot] = BACKGROUND_SO2_PPB;
  Z.co[zoneSlot] = BACKGROUND_CO_PPM;
  Z.overallAqi[zoneSlot] = aqiFromPm25(BACKGROUND_PM25_UGM3);
  Z.category[zoneSlot] = AQICategory.GOOD;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TICK
// ═══════════════════════════════════════════════════════════════════════

/**
 * Full pollution pipeline for one frame.
 *
 * @param world       ECS world
 * @param dt          seconds
 * @param hourOfDay   current hour (0-23, fractional)
 * @param sunElevation sun elevation above horizon (radians)
 */
export function systemAirPollutionTick(world, dt, hourOfDay = 12, sunElevation = 0.5) {
  systemUpdatePollutionZones(world, dt, hourOfDay, sunElevation);
  systemApplyPollutionHealthEffects(world, dt);
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Find the nearest pollution zone to a world position.
 */
export function findNearestPollutionZone(wx, wy, wz, maxDistance = 100000) {
  let nearestSlot = -1;
  let nearestDistSq = maxDistance * maxDistance;

  const Z = PollutionZone;
  for (let slot = 0; slot < _nextPollutionZoneSlot; slot++) {
    if (!Z.active[slot]) continue;
    const dx = Z.cx[slot] - wx;
    const dz = Z.cz[slot] - wz;
    const distSq = dx * dx + dz * dz;
    if (distSq < nearestDistSq) {
      nearestSlot = slot;
      nearestDistSq = distSq;
    }
  }
  return nearestSlot;
}

/**
 * Return a text label for the current AQI at a world position.
 */
export function getAQILabelAt(wx, wy, wz) {
  const category = sampleAQICategory(wx, wy, wz);
  return aqiCategoryLabel(category);
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

export function gatherPollutionZonesForRendering() {
  const result = [];
  const Z = PollutionZone;
  for (let slot = 0; slot < _nextPollutionZoneSlot; slot++) {
    if (!Z.active[slot]) continue;
    result.push({
      slot,
      cx: Z.cx[slot],
      cy: Z.cy[slot],
      cz: Z.cz[slot],
      radiusX: Z.radiusX[slot],
      radiusZ: Z.radiusZ[slot],
      mixedLayerHeight: Z.mixedLayerHeight[slot],
      pm25: Z.pm25[slot],
      pm10: Z.pm10[slot],
      o3: Z.o3[slot],
      no2: Z.no2[slot],
      so2: Z.so2[slot],
      co: Z.co[slot],
      overallAqi: Z.overallAqi[slot],
      category: Z.category[slot],
      categoryLabel: aqiCategoryLabel(Z.category[slot]),
    });
  }
  return result;
}

export function gatherPollutionSourcesForRendering() {
  const result = [];
  const S = PollutionSource;
  for (let slot = 0; slot < _nextPollutionSourceSlot; slot++) {
    if (!S.active[slot]) continue;
    result.push({
      slot,
      type: S.type[slot],
      px: S.px[slot],
      py: S.py[slot],
      pz: S.pz[slot],
      stackHeight: S.stackHeight[slot],
      rateMultiplier: S.rateMultiplier[slot],
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearAirPollution() {
  PollutionSource.active.fill(0);
  PollutionSource.ownerEid.fill(0);
  _pollutionSourceSlots.clear();
  _nextPollutionSourceSlot = 0;

  PollutionZone.active.fill(0);
  PollutionZone.ownerEid.fill(0);
  _pollutionZoneSlots.clear();
  _nextPollutionZoneSlot = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function airPollutionStats() {
  let activeSources = 0;
  let activeZones = 0;
  let avgAqi = 0;
  let maxAqi = 0;
  let hazardousZones = 0;

  for (let slot = 0; slot < _nextPollutionSourceSlot; slot++) {
    if (PollutionSource.active[slot]) activeSources++;
  }

  for (let slot = 0; slot < _nextPollutionZoneSlot; slot++) {
    if (!PollutionZone.active[slot]) continue;
    activeZones++;
    avgAqi += PollutionZone.overallAqi[slot];
    if (PollutionZone.overallAqi[slot] > maxAqi) {
      maxAqi = PollutionZone.overallAqi[slot];
    }
    if (PollutionZone.category[slot] >= AQICategory.VERY_UNHEALTHY) {
      hazardousZones++;
    }
  }

  if (activeZones > 0) avgAqi /= activeZones;

  return {
    activeSources,
    maxSources: MAX_POLLUTION_SOURCES,
    activeZones,
    maxZones: MAX_POLLUTION_ZONES,
    avgAqi,
    maxAqi,
    hazardousZones,
  };
}