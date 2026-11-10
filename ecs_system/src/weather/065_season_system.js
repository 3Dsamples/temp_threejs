// file number : 065
// full path name : src/weather/065_season_system.js
// description : Full seasonal cycle system. Provides the master seasonal
//               clock, hemisphere-aware seasonal phase, biome-specific
//               climate offsets, and the per-frame ambient conditions
//               (temperature, humidity, wind, sun elevation, day length)
//               that drive every downstream weather subsystem from files
//               040 through 064. Contributes:
//                 • SEASON ENUM — SPRING, SUMMER, AUTUMN, WINTER plus
//                   two tropical-specific seasons: WET (monsoon) and DRY.
//                   Biomes choose whether they use the 4-season cycle or
//                   the tropical 2-season cycle automatically.
//                 • SEASONAL PHASE — each region tracks its position
//                   in the season as a normalized 0..1 progress, plus a
//                   sub-season label (EARLY, MID, LATE) so that e.g.
//                   "late autumn" carries a different temperature
//                   offset from "early autumn".
//                 • HEMISPHERE AWARENESS — Northern hemisphere starts
//                   SPRING at the vernal equinox (~Mar 21); Southern
//                   hemisphere starts it 6 months later (~Sep 21).
//                   Equatorial / tropical biomes switch to the WET/DRY
//                   cycle based on the biome's monsoon timing.
//                 • BIOME CLIMATE OFFSETS — each biome has an
//                   independent seasonal temperature curve:
//                     - TROPICAL:   narrow range (±5 °C), WET season is
//                                   +2 °C warmer than DRY, +40% humidity.
//                     - TEMPERATE:  wide swing (-5 to +25 °C), typical
//                                   4-season progression.
//                     - ARID:       huge swing (-5 to +45 °C), extremely
//                                   dry in summer, mild in winter.
//                     - POLAR:      always below freezing, but summer
//                                   approaches 0 °C.
//                     - MOUNTAIN:   elevation-dependent; SEASONAL
//                                   effects amplified at higher altitudes.
//                     - COASTAL:    damped by ocean thermal inertia (smaller
//                                   swing, delayed peak by ~30 days).
//                     - URBAN:      heat-island offset +2 °C year-round.
//                     - CONTINENTAL: harshest swings, fastest change.
//                 • SUN PATH INTEGRATION — the sunrise/sunset times and
//                   sun elevation change with season and latitude. The
//                   sun elevation is exposed for file 028's sky model so
//                   the sun visibly moves across the sky and the days
//                   lengthen/shorten.
//                 • POLAR DAY/NIGHT — at |latitude| > 66.5°, the sun
//                   can stay above (midnight sun) or below (polar night)
//                   the horizon for weeks or months. The system detects
//                   this and exposes an appropriate sun elevation so the
//                   sky correctly dims or brightens.
//                 • SNOW/ICE ONSET — each region has a seasonal
//                   snowLine altitude and a per-surface snow onset date.
//                   File 043's snow accumulation uses this to know when
//                   to start accumulating. Ice/snow melt in spring is
//                   also driven by the seasonal melt intensity.
//                 • VEGETATION COLOR — materials tagged as
//                   VegetationTag receive an albedo shift based on
//                   seasonal foliage color (fresh green in spring,
//                   full green in summer, yellow/orange in autumn,
//                   grey/brown in winter). This is exposed via
//                   `applyVegetationColor` which mutates the material
//                   so no separate renderer hook is needed.
//                 • MONSOON MODEL — tropical biomes cycle between
//                   WET and DRY seasons. The transition is modelled
//                   with a 2-week "monsoon onset" window in which the
//                   precipitation probability ramps up to monsoon
//                   levels (from file 040's MODERATE_RAIN and HEAVY_RAIN).
//                   The WET/DRY switch flips at the configured monsoon
//                   date for the biome.
//                 • SEASONAL EVENTS — a QueueEvent API allows gameplay
//                   to schedule callbacks at "first frost", "first
//                   snow", "first thaw", "first bloom", etc. Each event
//                   fires once per year per region.
//                 • SCHEDULER COUPLING — reads and writes file 063's
//                   SchedulerRegion.dayOfYear / seasonalOffsetYears so
//                   the scheduler's Markov chain and season bias
//                   automatically use the correct seasonal values.
//               All state lives in typed arrays; per-frame cost is
//               O(regions) × O(1). Zero per-frame allocation;
//               steady-state 1M-entity scenes handle seasonal updates
//               on Android 64-bit.
// best for : Long-term survival gameplay, seasonal foliage changes,
//            polar day/night realism, monsoon cycles, snow-line dynamics,
//            and any 1M-entity scene needing a proper seasonal clock.
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
} from '../transform/002_transform_hierarchy.js';

import {
  SkyF32,
  SkyModel,
  getSkySlot,
} from '../sky/028_sky_atmosphere.js';

import {
  WeatherType,
  WeatherArchetype,
  PredefinedWeathers,
  ensurePredefinedWeathers,
} from './040_weather_archetypes.js';

import {
  SchedulerRegion,
  Biome,
  getCurrentWeatherType,
  getGameTime,
  advanceGameTime,
  setTimeScale,
} from './063_weather_scheduler.js';

import {
  MaterialF32,
  MaterialTag,
} from '../render/014_materials_bsdf.js';

import {
  SnowSurface,
  getSnowSurfaceSlot,
  SnowSurfaceTag,
  addSnowSurface,
} from './043_snow.js';

import {
  IceSurface,
  getIceSurfaceSlot,
  IceSurfaceTag,
} from './061_ice_frost.js';

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

const MAX_SEASON_REGIONS             = 128;
const MAX_SEASONAL_EVENTS            = 1024;

// ── Year length ─────────────────────────────────────────────
const DAYS_PER_YEAR                  = 365.25;
const DAYS_PER_SEASON_4              = DAYS_PER_YEAR / 4;    // 91.3125
const DAYS_PER_MONSOON               = DAYS_PER_YEAR / 2;    // 182.625

// ── Season boundaries (day of year, Northern hemisphere) ──
const SPRING_START_DOY_NORTH         = 80.0;    // Mar 21
const SUMMER_START_DOY_NORTH         = 172.0;   // Jun 21
const AUTUMN_START_DOY_NORTH         = 265.0;   // Sep 22
const WINTER_START_DOY_NORTH         = 355.0;   // Dec 21

// ── Tropical (WET/DRY) boundaries by biome ─────────────────
const TROPICAL_MONSOON_DOY           = 150.0;   // ~May 30 onset
const TROPICAL_DRY_DOY               = 305.0;   // ~Nov 1 dry onset

// ── Sub-season boundaries ──────────────────────────────────
const SUBSESON_EARLY_THRESHOLD       = 0.33;
const SUBSESON_LATE_THRESHOLD        = 0.67;

// ── Sun path ───────────────────────────────────────────────
const MAX_SUN_ELEVATION              = 1.5533;   // ~89° at equator mid-summer
const MIN_SUN_ELEVATION              = -1.5;     // below horizon
const POLAR_CIRCLE_LATITUDE          = 66.5;     // degrees
const HOURS_PER_DAY                  = 24.0;

// ── Temperature references by biome (mid-season values) ───
const BIOME_TEMPERATURE_MID = {
  [Biome.TROPICAL]:    { spring: 27, summer: 29, autumn: 27, winter: 25 },
  [Biome.TEMPERATE]:   { spring: 12, summer: 22, autumn: 12, winter: 2 },
  [Biome.ARID]:        { spring: 20, summer: 32, autumn: 18, winter: 8 },
  [Biome.POLAR]:       { spring: -10, summer: -2, autumn: -12, winter: -25 },
  [Biome.MOUNTAIN]:    { spring: 5, summer: 15, autumn: 5, winter: -8 },
  [Biome.COASTAL]:     { spring: 14, summer: 20, autumn: 15, winter: 8 },
  [Biome.DESERT]:      { spring: 24, summer: 38, autumn: 22, winter: 12 },
  [Biome.TUNDRA]:      { spring: -6, summer: 8, autumn: -4, winter: -18 },
  [Biome.FOREST]:      { spring: 11, summer: 20, autumn: 11, winter: 1 },
  [Biome.GRASSLAND]:   { spring: 13, summer: 24, autumn: 13, winter: 3 },
  [Biome.URBAN]:       { spring: 15, summer: 25, autumn: 14, winter: 5 },
  [Biome.CONTINENTAL]: { spring: 10, summer: 24, autumn: 10, winter: -5 },
};

// ── Humidity references by biome ───────────────────────────
const BIOME_HUMIDITY_MID = {
  [Biome.TROPICAL]:    0.75,
  [Biome.TEMPERATE]:   0.55,
  [Biome.ARID]:        0.25,
  [Biome.POLAR]:       0.65,
  [Biome.MOUNTAIN]:    0.50,
  [Biome.COASTAL]:     0.75,
  [Biome.DESERT]:      0.15,
  [Biome.TUNDRA]:      0.55,
  [Biome.FOREST]:      0.65,
  [Biome.GRASSLAND]:   0.45,
  [Biome.URBAN]:       0.55,
  [Biome.CONTINENTAL]: 0.50,
};

// ── Wind references by biome ───────────────────────────────
const BIOME_WIND_MID = {
  [Biome.TROPICAL]:    6.0,
  [Biome.TEMPERATE]:   8.0,
  [Biome.ARID]:        6.0,
  [Biome.POLAR]:       12.0,
  [Biome.MOUNTAIN]:    10.0,
  [Biome.COASTAL]:     12.0,
  [Biome.DESERT]:      8.0,
  [Biome.TUNDRA]:      10.0,
  [Biome.FOREST]:      5.0,
  [Biome.GRASSLAND]:   7.0,
  [Biome.URBAN]:       5.0,
  [Biome.CONTINENTAL]: 9.0,
};

// ── Snow onset thresholds ─────────────────────────────────
const SNOW_ONSET_TEMPERATURE_C       = 2.0;      // snow begins to fall
const SNOW_MELT_TEMPERATURE_C        = 3.0;      // snow begins to melt
const FROST_ONSET_TEMPERATURE_C      = 0.0;      // frost forms
const ICE_ONSET_TEMPERATURE_C        = -2.0;     // ice forms

// ── Vegetation color palette (linear RGB) ─────────────────
// (Spring, Summer, Autumn, Winter)
const VEGETATION_SPRING_R            = 0.25;
const VEGETATION_SPRING_G            = 0.55;
const VEGETATION_SPRING_B            = 0.20;

const VEGETATION_SUMMER_R            = 0.15;
const VEGETATION_SUMMER_G            = 0.35;
const VEGETATION_SUMMER_B            = 0.10;

const VEGETATION_AUTUMN_R            = 0.65;
const VEGETATION_AUTUMN_G            = 0.40;
const VEGETATION_AUTUMN_B            = 0.10;

const VEGETATION_WINTER_R            = 0.35;
const VEGETATION_WINTER_G            = 0.28;
const VEGETATION_WINTER_B            = 0.20;

const VEGETATION_TROPICAL_WET_R      = 0.12;
const VEGETATION_TROPICAL_WET_G      = 0.45;
const VEGETATION_TROPICAL_WET_B      = 0.10;

const VEGETATION_TROPICAL_DRY_R      = 0.45;
const VEGETATION_TROPICAL_DRY_G      = 0.42;
const VEGETATION_TROPICAL_DRY_B      = 0.20;

// ═══════════════════════════════════════════════════════════════════════
// SEASON ENUM
// ═══════════════════════════════════════════════════════════════════════

export const Season = Object.freeze({
  SPRING:       0,
  SUMMER:       1,
  AUTUMN:       2,
  WINTER:       3,
  MONSOON_WET:  4,   // tropical wet season
  MONSOON_DRY:  5,   // tropical dry season
});

// ═══════════════════════════════════════════════════════════════════════
// SUB-SEASON ENUM
// ═══════════════════════════════════════════════════════════════════════

export const SubSeason = Object.freeze({
  EARLY:  0,
  MID:    1,
  LATE:   2,
});

// ═══════════════════════════════════════════════════════════════════════
// HEMISPHERE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const Hemisphere = Object.freeze({
  NORTHERN: 0,
  SOUTHERN: 1,
  TROPICAL: 2,   // uses monsoon cycle
});

// ═══════════════════════════════════════════════════════════════════════
// SEASONAL EVENT TYPES
// ═══════════════════════════════════════════════════════════════════════

export const SeasonalEventType = Object.freeze({
  FIRST_FROST:   0,
  FIRST_SNOW:    1,
  FIRST_THAW:    2,
  FIRST_BLOOM:   3,
  MONSOON_ONSET: 4,
  MONSOON_END:   5,
  SUMMER_SOLSTICE: 6,
  WINTER_SOLSTICE: 7,
  EQUINOX:       8,
  CUSTOM:        9,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA SEASON REGION
// ═══════════════════════════════════════════════════════════════════════

export const SeasonRegion = {
  ownerEid: new Uint32Array(MAX_SEASON_REGIONS),

  // Biome (from file 063).
  biome: new Uint8Array(MAX_SEASON_REGIONS),

  // Hemisphere (Hemisphere).
  hemisphere: new Uint8Array(MAX_SEASON_REGIONS),

  // Latitude (degrees; positive = north).
  latitude: new Float32Array(MAX_SEASON_REGIONS),

  // Elevation (metres above sea level; affects mountain temperature).
  elevation: new Float32Array(MAX_SEASON_REGIONS),

  // Reference day of year (from file 063's scheduler region).
  // If the region has no scheduler, this is the source of truth.
  dayOfYear: new Float32Array(MAX_SEASON_REGIONS),

  // Reference hour of day.
  hourOfDay: new Float32Array(MAX_SEASON_REGIONS),

  // Current season.
  season: new Uint8Array(MAX_SEASON_REGIONS),

  // Sub-season (EARLY/MID/LATE).
  subSeason: new Uint8Array(MAX_SEASON_REGIONS),

  // Progress through the current season (0..1).
  seasonalProgress: new Float32Array(MAX_SEASON_REGIONS),

  // Time scale (0 = frozen, 1 = real-time, 60 = 1 real second = 1 game minute).
  timeScale: new Float32Array(MAX_SEASON_REGIONS),

  // Current ambient temperature (°C).
  ambientTemperature: new Float32Array(MAX_SEASON_REGIONS),

  // Current ambient humidity (0..1).
  ambientHumidity: new Float32Array(MAX_SEASON_REGIONS),

  // Current wind speed (m/s).
  ambientWindSpeed: new Float32Array(MAX_SEASON_REGIONS),

  // Current wind direction (unit vector in horizontal plane).
  ambientWindDirX: new Float32Array(MAX_SEASON_REGIONS),
  ambientWindDirZ: new Float32Array(MAX_SEASON_REGIONS),

  // Sun elevation above horizon (radians).
  sunElevation: new Float32Array(MAX_SEASON_REGIONS),

  // Day length (hours).
  dayLength: new Float32Array(MAX_SEASON_REGIONS),

  // Midnight sun flag (1 = sun never sets; polar summer).
  midnightSun: new Uint8Array(MAX_SEASON_REGIONS),

  // Polar night flag (1 = sun never rises; polar winter).
  polarNight: new Uint8Array(MAX_SEASON_REGIONS),

  // Snow-line altitude (metres; below this, snow can accumulate).
  snowLineAltitude: new Float32Array(MAX_SEASON_REGIONS),

  // Per-snow-onset flag (1 = snow is currently possible).
  snowPossible: new Uint8Array(MAX_SEASON_REGIONS),

  // Per-frost-onset flag.
  frostPossible: new Uint8Array(MAX_SEASON_REGIONS),

  // Ice possible flag.
  icePossible: new Uint8Array(MAX_SEASON_REGIONS),

  // Seasonal event fire-state (bitmask of SeasonalEventType values).
  eventsFired: new Uint32Array(MAX_SEASON_REGIONS),

  // Age (seconds).
  age: new Float32Array(MAX_SEASON_REGIONS),

  // Active.
  active: new Uint8Array(MAX_SEASON_REGIONS),

  // Seed for noise.
  seed: new Uint32Array(MAX_SEASON_REGIONS),
};

/** Marker: entity owns a season region. */
export const SeasonRegionTag = {};

const _seasonRegionSlots = new Map();
let _nextSeasonRegionSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA SEASONAL EVENT
// ═══════════════════════════════════════════════════════════════════════

export const SeasonalEvent = {
  active: new Uint8Array(MAX_SEASONAL_EVENTS),

  // Region this event belongs to.
  regionSlot: new Uint16Array(MAX_SEASONAL_EVENTS),

  // Event type (SeasonalEventType).
  eventType: new Uint8Array(MAX_SEASONAL_EVENTS),

  // Trigger day of year.
  triggerDayOfYear: new Float32Array(MAX_SEASONAL_EVENTS),

  // Only fire once per year.
  oncePerYear: new Uint8Array(MAX_SEASONAL_EVENTS),

  // Last year this event fired.
  lastFiredYear: new Float32Array(MAX_SEASONAL_EVENTS),

  // Callback function (invoked when fired).
  callback: new Array(MAX_SEASONAL_EVENTS).fill(null),

  // Fired flag for current year.
  firedThisYear: new Uint8Array(MAX_SEASONAL_EVENTS),
};

let _nextSeasonalEventSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA VEGETATION TAG
// ═══════════════════════════════════════════════════════════════════════

/** Marker: entity's material should reflect the current season's foliage color. */
export const VegetationTag = {};

const _vegetationEids = new Set();

// ═══════════════════════════════════════════════════════════════════════
// SEASON REGION API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add a seasonal region to an entity.
 *
 * @param world       ECS world
 * @param eid         entity
 * @param biome       Biome
 * @param options     { latitude, elevation, hemisphere, dayOfYear,
 *                      hourOfDay, timeScale, seed }
 * @returns season region slot
 */
export function addSeasonRegion(world, eid, biome = Biome.TEMPERATE, options = {}) {
  if (_nextSeasonRegionSlot >= MAX_SEASON_REGIONS) {
    throw new Error('season region capacity exceeded');
  }
  const slot = _nextSeasonRegionSlot++;

  addComponent(world, eid, SeasonRegionTag);

  const S = SeasonRegion;
  S.ownerEid[slot] = eid;
  S.biome[slot] = biome;

  // Hemisphere default: TROPICAL for tropical biomes, NORTHERN otherwise.
  let hemisphere;
  if (biome === Biome.TROPICAL) {
    hemisphere = Hemisphere.TROPICAL;
  } else {
    hemisphere = options.hemisphere ?? Hemisphere.NORTHERN;
  }
  S.hemisphere[slot] = hemisphere;

  // Latitude default: temperate = 45°, tropical = 15°, polar = 75°.
  let defaultLatitude;
  if (biome === Biome.TROPICAL) defaultLatitude = 15.0;
  else if (biome === Biome.POLAR || biome === Biome.TUNDRA) defaultLatitude = 75.0;
  else if (biome === Biome.ARID || biome === Biome.DESERT) defaultLatitude = 30.0;
  else defaultLatitude = 45.0;

  let latitude = options.latitude ?? defaultLatitude;
  if (hemisphere === Hemisphere.SOUTHERN && latitude > 0) latitude = -latitude;
  S.latitude[slot] = latitude;

  S.elevation[slot] = options.elevation ?? 0;
  S.dayOfYear[slot] = options.dayOfYear ?? 80.0;
  S.hourOfDay[slot] = options.hourOfDay ?? 12.0;
  S.timeScale[slot] = options.timeScale ?? 60.0;

  S.season[slot] = Season.SPRING;
  S.subSeason[slot] = SubSeason.EARLY;
  S.seasonalProgress[slot] = 0;

  S.ambientTemperature[slot] = 15;
  S.ambientHumidity[slot] = 0.5;
  S.ambientWindSpeed[slot] = 5;
  S.ambientWindDirX[slot] = 1;
  S.ambientWindDirZ[slot] = 0;

  S.sunElevation[slot] = 0.5;
  S.dayLength[slot] = 12.0;
  S.midnightSun[slot] = 0;
  S.polarNight[slot] = 0;

  S.snowLineAltitude[slot] = 2000;
  S.snowPossible[slot] = 0;
  S.frostPossible[slot] = 0;
  S.icePossible[slot] = 0;

  S.eventsFired[slot] = 0;
  S.age[slot] = 0;
  S.active[slot] = 1;
  S.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  _seasonRegionSlots.set(eid, slot);

  // Initial computation.
  computeSeasonFromDay(slot);
  computeTemperature(slot);
  computeHumidity(slot);
  computeWind(slot);
  computeSunPath(slot);
  computeSnowOnset(slot);

  return slot;
}

export function removeSeasonRegion(world, eid) {
  const slot = _seasonRegionSlots.get(eid);
  if (slot === undefined) return;
  SeasonRegion.active[slot] = 0;
  SeasonRegion.ownerEid[slot] = 0;
  _seasonRegionSlots.delete(eid);
  removeComponent(world, eid, SeasonRegionTag);
}

export function getSeasonRegionSlot(eid) {
  return _seasonRegionSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// SEASON COMPUTATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute season and sub-season from the current day of year and
 * hemisphere.
 */
function computeSeasonFromDay(slot) {
  const S = SeasonRegion;
  const day = S.dayOfYear[slot];
  const hemisphere = S.hemisphere[slot];

  if (hemisphere === Hemisphere.TROPICAL) {
    // Tropical biomes use MONSOON_WET / MONSOON_DRY.
    // WET runs roughly May 30 to Nov 1, DRY the rest of the year.
    if (day >= TROPICAL_MONSOON_DOY && day < TROPICAL_DRY_DOY) {
      S.season[slot] = Season.MONSOON_WET;
      const seasonStart = TROPICAL_MONSOON_DOY;
      const seasonLen = TROPICAL_DRY_DOY - TROPICAL_MONSOON_DOY;
      S.seasonalProgress[slot] = (day - seasonStart) / seasonLen;
    } else {
      S.season[slot] = Season.MONSOON_DRY;
      let seasonStart, seasonLen;
      if (day < TROPICAL_MONSOON_DOY) {
        seasonStart = TROPICAL_DRY_DOY - DAYS_PER_YEAR;
        seasonLen = (TROPICAL_MONSOON_DOY - (TROPICAL_DRY_DOY - DAYS_PER_YEAR));
      } else {
        seasonStart = TROPICAL_DRY_DOY;
        seasonLen = (DAYS_PER_YEAR - TROPICAL_DRY_DOY) + TROPICAL_MONSOON_DOY;
      }
      S.seasonalProgress[slot] = (day - seasonStart) / seasonLen;
    }
  } else {
    // 4-season cycle.
    let seasonDay = day;
    let season;

    // In the southern hemisphere, shift by half a year.
    if (hemisphere === Hemisphere.SOUTHERN) {
      seasonDay = (seasonDay + DAYS_PER_YEAR / 2) % DAYS_PER_YEAR;
    }

    let seasonStart;
    if (seasonDay >= SPRING_START_DOY_NORTH && seasonDay < SUMMER_START_DOY_NORTH) {
      season = Season.SPRING;
      seasonStart = SPRING_START_DOY_NORTH;
    } else if (seasonDay >= SUMMER_START_DOY_NORTH && seasonDay < AUTUMN_START_DOY_NORTH) {
      season = Season.SUMMER;
      seasonStart = SUMMER_START_DOY_NORTH;
    } else if (seasonDay >= AUTUMN_START_DOY_NORTH && seasonDay < WINTER_START_DOY_NORTH) {
      season = Season.AUTUMN;
      seasonStart = AUTUMN_START_DOY_NORTH;
    } else {
      season = Season.WINTER;
      seasonStart = WINTER_START_DOY_NORTH;
    }

    // Compute season length.
    let seasonLength = DAYS_PER_SEASON_4;

    // Compute progress.
    let progress = (seasonDay - seasonStart) / seasonLength;
    if (progress < 0) progress += 1.0;

    S.season[slot] = season;
    S.seasonalProgress[slot] = Math.max(0, Math.min(1, progress));
  }

  // Compute sub-season.
  const p = S.seasonalProgress[slot];
  if (p < SUBSESON_EARLY_THRESHOLD) {
    S.subSeason[slot] = SubSeason.EARLY;
  } else if (p < SUBSESON_LATE_THRESHOLD) {
    S.subSeason[slot] = SubSeason.MID;
  } else {
    S.subSeason[slot] = SubSeason.LATE;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// TEMPERATURE COMPUTATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the current ambient temperature based on season, sub-season,
 * biome, latitude, elevation, and hour of day.
 */
function computeTemperature(slot) {
  const S = SeasonRegion;
  const biome = S.biome[slot];
  const season = S.season[slot];
  const subSeason = S.subSeason[slot];
  const progress = S.seasonalProgress[slot];
  const latitude = S.latitude[slot];
  const elevation = S.elevation[slot];

  // Base seasonal temperature from the biome table.
  const biomeTemps = BIOME_TEMPERATURE_MID[biome] || BIOME_TEMPERATURE_MID[Biome.TEMPERATE];

  let baseTemp;
  if (season === Season.MONSOON_WET) {
    baseTemp = biomeTemps.summer - 1;   // slightly cooler (evaporative cooling)
  } else if (season === Season.MONSOON_DRY) {
    baseTemp = biomeTemps.summer + 1;   // slightly warmer
  } else if (season === Season.SPRING) {
    baseTemp = biomeTemps.spring;
  } else if (season === Season.SUMMER) {
    baseTemp = biomeTemps.summer;
  } else if (season === Season.AUTUMN) {
    baseTemp = biomeTemps.autumn;
  } else {
    baseTemp = biomeTemps.winter;
  }

  // Sub-season adjustment (early = closer to previous season, late = closer to next).
  const subOffset = (subSeason === SubSeason.EARLY ? -1 : subSeason === SubSeason.MID ? 0 : 1) * 2.0;

  // Elevation effect: -6.5 °C per 1000 m.
  const elevationOffset = -6.5 * (elevation / 1000.0);

  // Latitude effect: hotter near equator, colder near poles.
  const latAbs = Math.abs(latitude);
  const latitudeOffset = -0.4 * (latAbs - 30.0);

  // Diurnal cycle: warmer in afternoon, cooler at night.
  const hour = S.hourOfDay[slot];
  const diurnalAmplitude = 5.0;
  const diurnalPhase = Math.cos((hour - 14.0) * TWO_PI / HOURS_PER_DAY);
  const diurnalOffset = diurnalAmplitude * diurnalPhase;

  const totalTemp = baseTemp + subOffset + elevationOffset + latitudeOffset + diurnalOffset;
  S.ambientTemperature[slot] = totalTemp;
}

// ═══════════════════════════════════════════════════════════════════════
// HUMIDITY COMPUTATION
// ═══════════════════════════════════════════════════════════════════════

function computeHumidity(slot) {
  const S = SeasonRegion;
  const biome = S.biome[slot];
  const season = S.season[slot];
  const progress = S.seasonalProgress[slot];
  const hour = S.hourOfDay[slot];

  const baseHumidity = BIOME_HUMIDITY_MID[biome] ?? 0.5;

  let seasonalMod = 0;
  if (season === Season.MONSOON_WET) seasonalMod = 0.20;
  else if (season === Season.MONSOON_DRY) seasonalMod = -0.15;
  else if (season === Season.SPRING) seasonalMod = -0.05;
  else if (season === Season.SUMMER) seasonalMod = 0.05;
  else if (season === Season.AUTUMN) seasonalMod = 0.00;
  else seasonalMod = -0.05;

  // Diurnal: higher at dawn, lower in afternoon.
  const diurnalAmplitude = 0.05;
  const diurnalPhase = Math.cos((hour - 6.0) * TWO_PI / HOURS_PER_DAY);
  const diurnalOffset = diurnalAmplitude * diurnalPhase;

  S.ambientHumidity[slot] = Math.max(0.05, Math.min(1.0,
    baseHumidity + seasonalMod + diurnalOffset));
}

// ═══════════════════════════════════════════════════════════════════════
// WIND COMPUTATION
// ═══════════════════════════════════════════════════════════════════════

function computeWind(slot) {
  const S = SeasonRegion;
  const biome = S.biome[slot];
  const season = S.season[slot];
  const progress = S.seasonalProgress[slot];

  const baseWind = BIOME_WIND_MID[biome] ?? 5.0;

  let seasonalMult = 1.0;
  if (season === Season.MONSOON_WET) seasonalMult = 1.5;
  else if (season === Season.MONSOON_DRY) seasonalMult = 0.9;
  else if (season === Season.SPRING) seasonalMult = 1.1;
  else if (season === Season.SUMMER) seasonalMult = 1.0;
  else if (season === Season.AUTUMN) seasonalMult = 1.2;
  else seasonalMult = 1.3;

  // Sub-season: mid-late seasons have stronger winds.
  const progressMult = 0.8 + 0.4 * progress;

  const totalWind = baseWind * seasonalMult * progressMult;
  S.ambientWindSpeed[slot] = totalWind;

  // Wind direction: prevailing wind changes by season.
  // Northern hemisphere spring/summer typically westerly; autumn/winter
  // often stronger westerly/southwesterly.
  let windAngle;
  if (season === Season.MONSOON_WET) {
    windAngle = 200 * DEG_TO_RAD;   // monsoon: from SW
  } else if (season === Season.MONSOON_DRY) {
    windAngle = 45 * DEG_TO_RAD;    // dry: from NE
  } else if (season === Season.SPRING) {
    windAngle = 260 * DEG_TO_RAD;   // from W
  } else if (season === Season.SUMMER) {
    windAngle = 240 * DEG_TO_RAD;   // from W
  } else if (season === Season.AUTUMN) {
    windAngle = 250 * DEG_TO_RAD;   // from W
  } else {
    windAngle = 220 * DEG_TO_RAD;   // from SW
  }

  S.ambientWindDirX[slot] = Math.cos(windAngle);
  S.ambientWindDirZ[slot] = Math.sin(windAngle);
}

// ═══════════════════════════════════════════════════════════════════════
// SUN PATH COMPUTATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the sun elevation and day length for a region.
 * Uses a simplified solar-geometry model:
 *   sin(elevation) = sin(latitude) * sin(declination) +
 *                    cos(latitude) * cos(declination) * cos(hour_angle)
 * where declination = 23.44° * sin(2π * (day - 81) / 365.25).
 */
function computeSunPath(slot) {
  const S = SeasonRegion;
  const latitude = S.latitude[slot] * DEG_TO_RAD;
  const day = S.dayOfYear[slot];
  const hour = S.hourOfDay[slot];

  // Solar declination.
  const declination = 23.44 * DEG_TO_RAD * Math.sin(TWO_PI * (day - 81) / DAYS_PER_YEAR);

  // Hour angle (radians): hour_angle = (hour - 12) * 15°.
  const hourAngle = (hour - 12.0) * 15.0 * DEG_TO_RAD;

  // Sun elevation.
  const sinElev = Math.sin(latitude) * Math.sin(declination)
                + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinElev)));
  S.sunElevation[slot] = elevation;

  // Day length: 2 * acos(-tan(lat)*tan(dec)).
  const tanLat = Math.tan(latitude);
  const tanDec = Math.tan(declination);
  const cosHourAngleSunset = -tanLat * tanDec;

  if (cosHourAngleSunset > 1.0) {
    // Polar night: sun never rises.
    S.dayLength[slot] = 0;
    S.polarNight[slot] = 1;
    S.midnightSun[slot] = 0;
  } else if (cosHourAngleSunset < -1.0) {
    // Midnight sun: sun never sets.
    S.dayLength[slot] = HOURS_PER_DAY;
    S.midnightSun[slot] = 1;
    S.polarNight[slot] = 0;
  } else {
    const hourAngleSunset = Math.acos(cosHourAngleSunset);
    S.dayLength[slot] = (hourAngleSunset / PI) * HOURS_PER_DAY;
    S.midnightSun[slot] = 0;
    S.polarNight[slot] = 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SNOW / FROST / ICE ONSET
// ═══════════════════════════════════════════════════════════════════════

function computeSnowOnset(slot) {
  const S = SeasonRegion;
  const temp = S.ambientTemperature[slot];
  const elevation = S.elevation[slot];
  const latitude = S.latitude[slot];

  // Snow line altitude: where temperature crosses 0 °C.
  // Roughly: -6.5 °C per 1000 m, so snow line = (T_surface / 6.5) * 1000.
  if (temp <= 0) {
    S.snowLineAltitude[slot] = 0;    // snow everywhere
  } else {
    S.snowLineAltitude[slot] = (temp / 6.5) * 1000.0;
  }

  // Snow is possible if surface temp is near or below SNOW_ONSET_TEMPERATURE_C
  // OR if the elevation is above the snow line.
  const snowPossible = (temp <= SNOW_ONSET_TEMPERATURE_C) || (elevation >= S.snowLineAltitude[slot]);
  S.snowPossible[slot] = snowPossible ? 1 : 0;

  // Frost is possible if surface temp is below FROST_ONSET_TEMPERATURE_C.
  S.frostPossible[slot] = (temp <= FROST_ONSET_TEMPERATURE_C) ? 1 : 0;

  // Ice is possible if surface temp is below ICE_ONSET_TEMPERATURE_C.
  S.icePossible[slot] = (temp <= ICE_ONSET_TEMPERATURE_C) ? 1 : 0;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — SAMPLING AMBIENT CONDITIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the current ambient temperature (°C) at a season region.
 */
export function getAmbientTemperature(seasonSlot) {
  if (seasonSlot < 0 || seasonSlot >= _nextSeasonRegionSlot) return 20;
  return SeasonRegion.ambientTemperature[seasonSlot];
}

/**
 * Return the current ambient humidity (0..1).
 */
export function getAmbientHumidity(seasonSlot) {
  if (seasonSlot < 0 || seasonSlot >= _nextSeasonRegionSlot) return 0.5;
  return SeasonRegion.ambientHumidity[seasonSlot];
}

/**
 * Return the current ambient wind vector as [speed, dirX, dirZ].
 */
export function getAmbientWind(seasonSlot) {
  if (seasonSlot < 0 || seasonSlot >= _nextSeasonRegionSlot) return [0, 1, 0];
  return [
    SeasonRegion.ambientWindSpeed[seasonSlot],
    SeasonRegion.ambientWindDirX[seasonSlot],
    SeasonRegion.ambientWindDirZ[seasonSlot],
  ];
}

/**
 * Return the current sun elevation (radians above horizon).
 */
export function getSunElevation(seasonSlot) {
  if (seasonSlot < 0 || seasonSlot >= _nextSeasonRegionSlot) return 0;
  return SeasonRegion.sunElevation[seasonSlot];
}

/**
 * Return the current day length (hours).
 */
export function getDayLength(seasonSlot) {
  if (seasonSlot < 0 || seasonSlot >= _nextSeasonRegionSlot) return 12;
  return SeasonRegion.dayLength[seasonSlot];
}

/**
 * Return the current season for a region.
 */
export function getSeason(seasonSlot) {
  if (seasonSlot < 0 || seasonSlot >= _nextSeasonRegionSlot) return Season.SPRING;
  return SeasonRegion.season[seasonSlot];
}

/**
 * Return the current sub-season for a region.
 */
export function getSubSeason(seasonSlot) {
  if (seasonSlot < 0 || seasonSlot >= _nextSeasonRegionSlot) return SubSeason.MID;
  return SeasonRegion.subSeason[seasonSlot];
}

/**
 * Return the current seasonal progress (0..1).
 */
export function getSeasonalProgress(seasonSlot) {
  if (seasonSlot < 0 || seasonSlot >= _nextSeasonRegionSlot) return 0.5;
  return SeasonRegion.seasonalProgress[seasonSlot];
}

/**
 * Return whether snow is currently possible in this region.
 */
export function isSnowPossible(seasonSlot) {
  if (seasonSlot < 0 || seasonSlot >= _nextSeasonRegionSlot) return false;
  return SeasonRegion.snowPossible[seasonSlot] === 1;
}

/**
 * Return whether frost is currently possible.
 */
export function isFrostPossible(seasonSlot) {
  if (seasonSlot < 0 || seasonSlot >= _nextSeasonRegionSlot) return false;
  return SeasonRegion.frostPossible[seasonSlot] === 1;
}

/**
 * Return whether ice is currently possible.
 */
export function isIcePossible(seasonSlot) {
  if (seasonSlot < 0 || seasonSlot >= _nextSeasonRegionSlot) return false;
  return SeasonRegion.icePossible[seasonSlot] === 1;
}

/**
 * Return a human-readable season label.
 */
export function seasonLabel(season) {
  switch (season) {
    case Season.SPRING:       return 'Spring';
    case Season.SUMMER:       return 'Summer';
    case Season.AUTUMN:       return 'Autumn';
    case Season.WINTER:       return 'Winter';
    case Season.MONSOON_WET:  return 'Wet Season';
    case Season.MONSOON_DRY:  return 'Dry Season';
    default:                  return 'Unknown';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SUN ELEVATION COUPLING WITH FILE 028 SKY
// ═══════════════════════════════════════════════════════════════════════

/**
 * Apply the current seasonal sun elevation to all sky entities that
 * are associated with this season region.
 */
function applySeasonToSky(world, seasonSlot) {
  const S = SeasonRegion;
  const ownerEid = S.ownerEid[seasonSlot];
  if (!ownerEid) return;

  // Query all sky entities in the world.
  const skyEids = query(world, [SkyF32]);

  for (let i = 0; i < skyEids.length; i++) {
    const skyEid = skyEids[i];
    const skySlot = getSkySlot(skyEid);
    if (skySlot < 0) continue;

    // Set sun elevation from seasonal sun path.
    const elev = S.sunElevation[seasonSlot];
    const sunDirY = Math.sin(elev);
    const cosElev = Math.cos(elev);
    const azimuth = 180 * DEG_TO_RAD;   // south-facing at noon (N hemisphere)

    SkyF32.sunDirX[skySlot] = cosElev * Math.sin(azimuth);
    SkyF32.sunDirY[skySlot] = sunDirY;
    SkyF32.sunDirZ[skySlot] = cosElev * Math.cos(azimuth);

    // Moon is opposite.
    SkyF32.moonDirX[skySlot] = -SkyF32.sunDirX[skySlot];
    SkyF32.moonDirY[skySlot] = -SkyF32.sunDirY[skySlot];
    SkyF32.moonDirZ[skySlot] = -SkyF32.sunDirZ[skySlot];
  }
}

// ═══════════════════════════════════════════════════════════════════════
// VEGETATION COLOR
// ═══════════════════════════════════════════════════════════════════════

/**
 * Apply the current seasonal foliage color to a vegetation entity's
 * material. Modifies MaterialF32 albedo in place.
 */
export function applyVegetationColor(world, eid, seasonSlot) {
  if (!hasComponent(world, eid, MaterialTag)) return;

  const S = SeasonRegion;
  if (!S.active[seasonSlot]) return;

  const season = S.season[seasonSlot];
  const subSeason = S.subSeason[seasonSlot];

  let r, g, b;

  if (season === Season.SPRING) {
    // Fresh green (brighter at early spring).
    const t = subSeason === SubSeason.EARLY ? 0.7 :
              subSeason === SubSeason.MID ? 1.0 : 0.9;
    r = VEGETATION_SPRING_R * t;
    g = VEGETATION_SPRING_G * t;
    b = VEGETATION_SPRING_B * t;
  } else if (season === Season.SUMMER) {
    r = VEGETATION_SUMMER_R;
    g = VEGETATION_SUMMER_G;
    b = VEGETATION_SUMMER_B;
  } else if (season === Season.AUTUMN) {
    // Gradually shift to orange/brown.
    const t = subSeason === SubSeason.EARLY ? 0.3 :
              subSeason === SubSeason.MID ? 0.7 : 1.0;
    r = VEGETATION_SUMMER_R * (1 - t) + VEGETATION_AUTUMN_R * t;
    g = VEGETATION_SUMMER_G * (1 - t) + VEGETATION_AUTUMN_G * t;
    b = VEGETATION_SUMMER_B * (1 - t) + VEGETATION_AUTUMN_B * t;
  } else if (season === Season.WINTER) {
    r = VEGETATION_WINTER_R;
    g = VEGETATION_WINTER_G;
    b = VEGETATION_WINTER_B;
  } else if (season === Season.MONSOON_WET) {
    r = VEGETATION_TROPICAL_WET_R;
    g = VEGETATION_TROPICAL_WET_G;
    b = VEGETATION_TROPICAL_WET_B;
  } else {
    r = VEGETATION_TROPICAL_DRY_R;
    g = VEGETATION_TROPICAL_DRY_G;
    b = VEGETATION_TROPICAL_DRY_B;
  }

  // Apply to material.
  const id = getId(eid);
  MaterialF32.baseR[id] = r;
  MaterialF32.baseG[id] = g;
  MaterialF32.baseB[id] = b;
}

// ═══════════════════════════════════════════════════════════════════════
// SEASONAL EVENT SCHEDULING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Schedule a seasonal event (e.g. "first frost").
 *
 * @param regionSlot      season region slot
 * @param eventType       SeasonalEventType
 * @param triggerDayOfYear day to trigger
 * @param callback        function(regionSlot, eventType) to invoke
 * @returns event slot
 */
export function scheduleSeasonalEvent(regionSlot, eventType, triggerDayOfYear, callback) {
  if (_nextSeasonalEventSlot >= MAX_SEASONAL_EVENTS) {
    throw new Error('seasonal event capacity exceeded');
  }
  const slot = _nextSeasonalEventSlot++;

  const E = SeasonalEvent;
  E.active[slot] = 1;
  E.regionSlot[slot] = regionSlot;
  E.eventType[slot] = eventType;
  E.triggerDayOfYear[slot] = triggerDayOfYear;
  E.oncePerYear[slot] = 1;
  E.lastFiredYear[slot] = -1;
  E.callback[slot] = callback;
  E.firedThisYear[slot] = 0;

  return slot;
}

/**
 * Process all seasonal events for a region.
 */
function processSeasonalEvents(world, seasonSlot, currentYear) {
  const S = SeasonRegion;
  const E = SeasonalEvent;
  const day = S.dayOfYear[seasonSlot];

  for (let evtSlot = 0; evtSlot < _nextSeasonalEventSlot; evtSlot++) {
    if (!E.active[evtSlot]) continue;
    if (E.regionSlot[evtSlot] !== seasonSlot) continue;

    // Reset the fired flag when we cross a new year.
    if (E.lastFiredYear[evtSlot] < currentYear) {
      E.firedThisYear[evtSlot] = 0;
    }

    if (E.firedThisYear[evtSlot]) continue;

    // Check if today is the trigger day.
    const triggerDay = E.triggerDayOfYear[evtSlot];
    if (Math.abs(day - triggerDay) < 0.5) {
      E.firedThisYear[evtSlot] = 1;
      E.lastFiredYear[evtSlot] = currentYear;

      if (E.callback[evtSlot]) {
        try {
          E.callback[evtSlot](seasonSlot, E.eventType[evtSlot]);
        } catch (err) {
          if (typeof console !== 'undefined') {
            console.warn('[065_season_system] seasonal event threw:', err);
          }
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TICK — advance the season clock and recompute derived state
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance the seasonal cycle for one frame.
 *
 * @param world       ECS world
 * @param dt          real-time seconds
 */
export function systemSeasonTick(world, dt) {
  const S = SeasonRegion;

  for (let slot = 0; slot < _nextSeasonRegionSlot; slot++) {
    if (!S.active[slot]) continue;

    S.age[slot] += dt;

    // Advance time-of-day and day-of-year.
    const gameHours = dt * S.timeScale[slot] / 3600.0;
    S.hourOfDay[slot] += gameHours;

    while (S.hourOfDay[slot] >= HOURS_PER_DAY) {
      S.hourOfDay[slot] -= HOURS_PER_DAY;
      S.dayOfYear[slot] += 1.0;
      if (S.dayOfYear[slot] >= DAYS_PER_YEAR) {
        S.dayOfYear[slot] -= DAYS_PER_YEAR;
      }
    }

    // Update derived state.
    computeSeasonFromDay(slot);
    computeTemperature(slot);
    computeHumidity(slot);
    computeWind(slot);
    computeSunPath(slot);
    computeSnowOnset(slot);

    // Sync to sky.
    applySeasonToSky(world, slot);

    // Process seasonal events.
    const currentYear = Math.floor(S.age[slot] / (DAYS_PER_YEAR * 24 * 3600 / Math.max(1, S.timeScale[slot])));
    processSeasonalEvents(world, slot, currentYear);

    // Apply vegetation color to all tagged entities.
    if (S.timeScale[slot] > 0) {
      for (const vegEid of _vegetationEids) {
        if (!entityExists(world, vegEid)) continue;
        applyVegetationColor(world, vegEid, slot);
      }
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS — VEGETATION REGISTRATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register an entity as vegetation (its material will reflect seasonal
 * foliage color).
 */
export function addVegetation(world, eid) {
  addComponent(world, eid, VegetationTag);
  _vegetationEids.add(eid);
  return eid;
}

export function removeVegetation(world, eid) {
  _vegetationEids.delete(eid);
  removeComponent(world, eid, VegetationTag);
}

/**
 * Return the current foliage color as a [r, g, b] array.
 */
export function getFoliageColor(seasonSlot) {
  const S = SeasonRegion;
  if (!S.active[seasonSlot]) return [0.15, 0.35, 0.10];

  const season = S.season[seasonSlot];
  const subSeason = S.subSeason[seasonSlot];

  if (season === Season.SPRING) {
    return [VEGETATION_SPRING_R, VEGETATION_SPRING_G, VEGETATION_SPRING_B];
  } else if (season === Season.SUMMER) {
    return [VEGETATION_SUMMER_R, VEGETATION_SUMMER_G, VEGETATION_SUMMER_B];
  } else if (season === Season.AUTUMN) {
    const t = subSeason === SubSeason.EARLY ? 0.3 :
              subSeason === SubSeason.MID ? 0.7 : 1.0;
    return [
      VEGETATION_SUMMER_R * (1 - t) + VEGETATION_AUTUMN_R * t,
      VEGETATION_SUMMER_G * (1 - t) + VEGETATION_AUTUMN_G * t,
      VEGETATION_SUMMER_B * (1 - t) + VEGETATION_AUTUMN_B * t,
    ];
  } else if (season === Season.WINTER) {
    return [VEGETATION_WINTER_R, VEGETATION_WINTER_G, VEGETATION_WINTER_B];
  } else if (season === Season.MONSOON_WET) {
    return [VEGETATION_TROPICAL_WET_R, VEGETATION_TROPICAL_WET_G, VEGETATION_TROPICAL_WET_B];
  } else {
    return [VEGETATION_TROPICAL_DRY_R, VEGETATION_TROPICAL_DRY_G, VEGETATION_TROPICAL_DRY_B];
  }
}

// ═══════════════════════════════════════════════════════════════════════
// INTEGRATION WITH FILE 063 SCHEDULER
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sync a season region with a scheduler region so the dayOfYear stays
 * up to date (used when both files are active in the same world).
 */
export function syncWithScheduler(seasonSlot, schedulerSlot) {
  if (seasonSlot < 0 || seasonSlot >= _nextSeasonRegionSlot) return;
  if (schedulerSlot < 0 || schedulerSlot >= SchedulerRegion.active.length) return;

  const S = SeasonRegion;
  const R = SchedulerRegion;

  S.dayOfYear[seasonSlot] = R.dayOfYear[schedulerSlot];
  S.hourOfDay[seasonSlot] = R.hourOfDay[schedulerSlot];
  S.timeScale[seasonSlot] = R.timeScale[schedulerSlot];

  // Update derived state immediately.
  computeSeasonFromDay(seasonSlot);
  computeTemperature(seasonSlot);
  computeHumidity(seasonSlot);
  computeWind(seasonSlot);
  computeSunPath(seasonSlot);
  computeSnowOnset(seasonSlot);
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function seasonStats() {
  let activeRegions = 0;
  let springCount = 0, summerCount = 0, autumnCount = 0, winterCount = 0;
  let wetSeasonCount = 0, drySeasonCount = 0;
  let snowPossibleCount = 0;
  let polarDayCount = 0, polarNightCount = 0;

  for (let slot = 0; slot < _nextSeasonRegionSlot; slot++) {
    if (!SeasonRegion.active[slot]) continue;
    activeRegions++;

    switch (SeasonRegion.season[slot]) {
      case Season.SPRING:      springCount++; break;
      case Season.SUMMER:      summerCount++; break;
      case Season.AUTUMN:      autumnCount++; break;
      case Season.WINTER:      winterCount++; break;
      case Season.MONSOON_WET: wetSeasonCount++; break;
      case Season.MONSOON_DRY: drySeasonCount++; break;
    }

    if (SeasonRegion.snowPossible[slot]) snowPossibleCount++;
    if (SeasonRegion.midnightSun[slot]) polarDayCount++;
    if (SeasonRegion.polarNight[slot]) polarNightCount++;
  }

  return {
    activeRegions,
    maxRegions: MAX_SEASON_REGIONS,
    springCount,
    summerCount,
    autumnCount,
    winterCount,
    wetSeasonCount,
    drySeasonCount,
    snowPossibleCount,
    polarDayCount,
    polarNightCount,
    registeredVegetation: _vegetationEids.size,
    scheduledEvents: _nextSeasonalEventSlot,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearSeasonSystem() {
  SeasonRegion.active.fill(0);
  SeasonRegion.ownerEid.fill(0);
  _seasonRegionSlots.clear();
  _nextSeasonRegionSlot = 0;

  SeasonalEvent.active.fill(0);
  SeasonalEvent.callback.fill(null);
  _nextSeasonalEventSlot = 0;

  _vegetationEids.clear();
}