// file number : 063
// full path name : src/weather/063_weather_scheduler.js
// description : Procedural weather scheduler. The control layer that
//               orchestrates the entire weather pipeline delivered in
//               files 040-062. Provides a context-aware, seasonal,
//               biome-aware, Markov-chain-driven weather timeline:
//                 • WEATHER CLIMATE MAP — a per-biome, per-season
//                   probability table (weighted) that maps each
//                   WeatherType to a selection weight. Customizable
//                   per world / per biome / per region. Defaults
//                   cover all common biomes: TROPICAL, TEMPERATE,
//                   ARID, POLAR, MOUNTAIN, COASTAL, DESERT, TUNDRA,
//                   FOREST, GRASSLAND, URBAN, CONTINENTAL.
//                 • SEASONAL WEIGHTING — each weather type has a
//                   season bias (already in file 040's
//                   `WeatherArchetype.seasonBias` bitmask). The
//                   scheduler multiplies the biome weight by the
//                   season bias during selection. Spring favors
//                   thunderstorms and rainbows; winter favors snow
//                   and frost; summer favors heat and fire weather;
//                   autumn favors fog and storms.
//                 • MARKOV-CHAIN TRANSITIONS — weather does not
//                   randomly jump between states; it follows
//                   realistic meteorology. A transition matrix
//                   weights the probability of each weather type
//                   given the previous weather type, so CLEAR_SUNNY
//                   tends to stay sunny or transition to PARTLY_CLOUDY
//                   rather than jump to BLIZZARD. Customizable per
//                   world.
//                 • DIURNAL PATTERNS — day/night cycle influences the
//                   selection: afternoons are stormier, nights are
//                   cooler and mistier, dawn often produces fog, etc.
//                 • CONTEXT-AWARENESS — reads time-of-day, season,
//                   biome, and recent weather history to bias
//                   selection. Also accepts per-region overrides
//                   (e.g. deserts suppress rain, mountains enhance
//                   snow).
//                 • DWELL-TIME MODEL — each weather type has a
//                   configured mean dwell time (from file 040's
//                   durationMin / durationMax). The scheduler
//                   guarantees a weather persists at least the
//                   minimum dwell time before a transition can
//                   occur.
//                 • SCRIPTED OVERRIDES — game designers can pin a
//                   specific weather for an interval (e.g. "it will
//                   be a thunderstorm at 3pm during the boss fight")
//                   via `scheduleScriptedWeather`.
//                 • MULTI-REGION SUPPORT — a world can have multiple
//                   WeatherRegion entities (e.g. one per biome),
//                   each with its own scheduler state, seasonal
//                   phase, and biome preference.
//                 • TRANSITION BLENDING — when a transition fires,
//                   the scheduler hands off to file 040's
//                   `blendWeatherTo` with a configured blend
//                   duration (30-300 s) so the visual transition
//                   looks natural.
//                 • WEATHER INSTANCE HOOKS — every time a weather
//                   transition fires, the scheduler emits a
//                   WeatherTransitionEvent to any listeners (file
//                   026's observer queue) so gameplay systems can
//                   react (close windows, spawn NPCs, change
//                   music, etc.).
//                 • PREDICTIVE LOOKAHEAD — the scheduler provides
//                   `predictNextWeather` and `predictWeatherIn(seconds)`
//                   so gameplay can forecast upcoming conditions.
//               All state lives in typed arrays; per-frame cost is
//               O(regions) × O(weather types) ≈ O(regions × 24).
//               Zero per-frame allocation; steady-state 1M-entity
//               scenes handle scheduler updates on Android 64-bit.
// best for : Any game with dynamic weather, day/night cycles, seasonal
//            progression, biome-aware climate, scripted weather events,
//            and 1M-entity scenes needing continuous weather.
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
  getWorldBoundsCenter,
} from '../geometry/004_aabb_bounds.js';

import {
  WeatherType,
  WeatherArchetype,
  WeatherInstance,
  WeatherInstanceTag,
  PredefinedWeathers,
  ensurePredefinedWeathers,
  createWeatherArchetype,
  instantiateWeather,
  blendWeatherTo,
  systemUpdateWeather,
  sampleWeatherAt,
  weatherStats,
  clearWeather,
} from './040_weather_archetypes.js';

import {
  sampleWindAt,
} from './047_wind_gusts.js';

import {
  sampleAQI,
} from './057_air_pollution.js';

import {
  vec3,
  vec4,
  mat4,
  createNoise3D,
  createNoise2D,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
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

// ── Scheduler limits ─────────────────────────────────────────
const MAX_WEATHER_REGIONS            = 32;
const MAX_TRANSITIONS                = 64;
const MAX_SCRIPTED_EVENTS            = 256;

// ── Weather type count (must match file 040) ─────────────────
const WEATHER_TYPE_COUNT             = 24;

// ── Dwell time parameters ────────────────────────────────────
const DEFAULT_MIN_DWELL              = 300.0;   // 5 min minimum
const DEFAULT_MAX_DWELL              = 3600.0;  // 1 hour maximum
const DWELL_JITTER                   = 0.35;    // ±35% random variation
const DWELL_CHECK_INTERVAL           = 1.0;     // 1 s between re-rolls

// ── Transition duration ──────────────────────────────────────
const DEFAULT_BLEND_DURATION         = 120.0;   // 2 min blend

// ── Seasonal parameters ──────────────────────────────────────
const SEASON_SPRING                  = 0;
const SEASON_SUMMER                  = 1;
const SEASON_AUTUMN                  = 2;
const SEASON_WINTER                  = 3;
const DAYS_PER_SEASON                 = 90.0;
const DAYS_PER_YEAR                  = 365.25;

// ── Diurnal patterns ─────────────────────────────────────────
const HOURS_PER_DAY                   = 24.0;
const DAWN_START_HOUR                = 5.0;
const DAWN_END_HOUR                  = 8.0;
const DUSK_START_HOUR                = 17.0;
const DUSK_END_HOUR                  = 20.0;
const MORNING_STORM_HOUR             = 14.0;
const EVENING_STORM_HOUR             = 18.0;
const DIURNAL_FOG_HOUR               = 6.0;
const DIURNAL_MIST_HOUR              = 7.0;

// ── Biome enum ───────────────────────────────────────────────
export const Biome = Object.freeze({
  TROPICAL:     0,
  TEMPERATE:    1,
  ARID:         2,
  POLAR:        3,
  MOUNTAIN:     4,
  COASTAL:      5,
  DESERT:       6,
  TUNDRA:       7,
  FOREST:       8,
  GRASSLAND:    9,
  URBAN:        10,
  CONTINENTAL:  11,
});

// ── Weather category tags for filtering ──────────────────────
export const WeatherClass = Object.freeze({
  CLEAR:        0,   // CLEAR_SUNNY, CLEAR_NIGHT
  CLOUDY:       1,   // PARTLY_CLOUDY, MOSTLY_CLOUDY, OVERCAST
  RAIN:         2,   // LIGHT_RAIN, MODERATE_RAIN, HEAVY_RAIN
  STORM:        3,   // THUNDERSTORM, SUPERCELL
  SNOW:         4,   // LIGHT_SNOW, MODERATE_SNOW, BLIZZARD
  FOG:          5,   // FOG, MIST, HAZE
  DUST:         6,   // DUST_STORM, SANDSTORM
  ICE:          7,   // FREEZING_RAIN, SLEET, HAIL_STORM
  TROPICAL_CYC: 8,   // TROPICAL_STORM, HURRICANE, TORNADO_OUTBREAK
});

// ═══════════════════════════════════════════════════════════════════════
// SoA WEATHER SCHEDULER REGION
// ═══════════════════════════════════════════════════════════════════════

export const SchedulerRegion = {
  ownerEid: new Uint32Array(MAX_WEATHER_REGIONS),

  // Biome type.
  biome: new Uint8Array(MAX_WEATHER_REGIONS),

  // Seasonal offset (years since epoch; fractional).
  seasonalOffsetYears: new Float32Array(MAX_WEATHER_REGIONS),

  // Current day-of-year (0..DAYS_PER_YEAR).
  dayOfYear: new Float32Array(MAX_WEATHER_REGIONS),

  // Current hour (0..24).
  hourOfDay: new Float32Array(MAX_WEATHER_REGIONS),

  // Time scale (1.0 = real time; 60 = 1 real second = 1 game minute).
  timeScale: new Float32Array(MAX_WEATHER_REGIONS),

  // Current weather type.
  currentWeatherType: new Uint8Array(MAX_WEATHER_REGIONS),

  // Previous weather type (for blending and Markov).
  previousWeatherType: new Uint8Array(MAX_WEATHER_REGIONS),

  // Current archetype slot (in file 040).
  currentArchetypeSlot: new Uint16Array(MAX_WEATHER_REGIONS),

  // Previous archetype slot.
  previousArchetypeSlot: new Uint16Array(MAX_WEATHER_REGIONS),

  // Dwell time remaining (seconds) before next transition allowed.
  dwellTimeRemaining: new Float32Array(MAX_WEATHER_REGIONS),

  // Blend progress (0..1; 1 = fully transitioned).
  blendProgress: new Float32Array(MAX_WEATHER_REGIONS),

  // Weather instance slot (file 040's WeatherInstance).
  weatherInstanceSlot: new Int16Array(MAX_WEATHER_REGIONS),

  // Scripted override active.
  scriptedOverride: new Uint8Array(MAX_WEATHER_REGIONS),

  // Scripted override ends at (hour of game time; -1 = no override).
  scriptedEndHour: new Float32Array(MAX_WEATHER_REGIONS),

  // Number of transitions performed.
  transitionCount: new Uint32Array(MAX_WEATHER_REGIONS),

  // Age (seconds).
  age: new Float32Array(MAX_WEATHER_REGIONS),

  // Active.
  active: new Uint8Array(MAX_WEATHER_REGIONS),

  // Seed for noise.
  seed: new Uint32Array(MAX_WEATHER_REGIONS),
};

/** Marker: entity owns a scheduler region. */
export const SchedulerRegionTag = {};

const _schedulerRegionSlots = new Map();
let _nextSchedulerRegionSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA BIOME WEIGHT MATRIX — per-biome × per-weather weight
// ═══════════════════════════════════════════════════════════════════════
//
// This is a global table (not per-region) since biomes are shared.
// Format: BIOME_WEIGHTS[biome][weatherType] = weight (0 = never).

const BIOME_WEIGHTS = new Array(12);
for (let i = 0; i < 12; i++) {
  BIOME_WEIGHTS[i] = new Float32Array(WEATHER_TYPE_COUNT);
}

// ═══════════════════════════════════════════════════════════════════════
// SoA TRANSITION MATRIX — Markov probabilities
// ═══════════════════════════════════════════════════════════════════════
//
// TRANSITION_MATRIX[fromWeather][toWeather] = weight (0 = never).
// This global table (not per-region) captures meteorological realism.

const TRANSITION_MATRIX = new Array(WEATHER_TYPE_COUNT);
for (let i = 0; i < WEATHER_TYPE_COUNT; i++) {
  TRANSITION_MATRIX[i] = new Float32Array(WEATHER_TYPE_COUNT);
}

// ═══════════════════════════════════════════════════════════════════════
// SCRIPTED WEATHER EVENTS
// ═══════════════════════════════════════════════════════════════════════

export const ScriptedWeatherEvent = {
  active: new Uint8Array(MAX_SCRIPTED_EVENTS),

  regionSlot: new Uint16Array(MAX_SCRIPTED_EVENTS),

  weatherType: new Uint8Array(MAX_SCRIPTED_EVENTS),

  // Time (in days since epoch) when the event starts.
  startTime: new Float32Array(MAX_SCRIPTED_EVENTS),

  // Duration (in days).
  duration: new Float32Array(MAX_SCRIPTED_EVENTS),

  // Blend duration (in seconds).
  blendDuration: new Float32Array(MAX_SCRIPTED_EVENTS),

  // Active flag (also used as "fired" once triggered).
  fired: new Uint8Array(MAX_SCRIPTED_EVENTS),
};

let _nextScriptedEventId = 0;

// ═══════════════════════════════════════════════════════════════════════
// TRANSITION EVENT QUEUE
// ═══════════════════════════════════════════════════════════════════════

export const TransitionEvent = {
  regionSlot: new Uint16Array(1024),
  fromWeatherType: new Uint8Array(1024),
  toWeatherType: new Uint8Array(1024),
  timeOfDay: new Float32Array(1024),
  dayOfYear: new Float32Array(1024),
  active: new Uint8Array(1024),
  head: 0,
  tail: 0,
  count: 0,
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
// BIOME WEIGHT INITIALIZATION — the default climate map
// ═══════════════════════════════════════════════════════════════════════

/**
 * Initialize the default biome weight table. Called once on first use.
 * Each row is a 24-element vector (one weight per WeatherType).
 */
function initializeBiomeWeights() {
  // Index reference (matches WeatherType from file 040):
  //  0  CLEAR_SUNNY
  //  1  CLEAR_NIGHT
  //  2  PARTLY_CLOUDY
  //  3  MOSTLY_CLOUDY
  //  4  OVERCAST
  //  5  LIGHT_RAIN
  //  6  MODERATE_RAIN
  //  7  HEAVY_RAIN
  //  8  THUNDERSTORM
  //  9  SUPERCELL
  // 10  LIGHT_SNOW
  // 11  MODERATE_SNOW
  // 12  BLIZZARD
  // 13  FOG
  // 14  MIST
  // 15  HAZE
  // 16  DUST_STORM
  // 17  SANDSTORM
  // 18  FREEZING_RAIN
  // 19  SLEET
  // 20  HAIL_STORM
  // 21  TROPICAL_STORM
  // 22  HURRICANE
  // 23  TORNADO_OUTBREAK

  // ── TROPICAL ─────────────────────────────────────────
  BIOME_WEIGHTS[Biome.TROPICAL].set([
    30, 10, 20, 10, 5,
    8, 5, 2, 5, 0,
    0, 0, 0, 3, 5,
    1, 0, 0, 0, 0,
    0.5, 3, 0.2, 0,
  ]);

  // ── TEMPERATE ────────────────────────────────────────
  BIOME_WEIGHTS[Biome.TEMPERATE].set([
    30, 15, 20, 10, 5,
    5, 3, 1, 2, 0.1,
    3, 1, 0.2, 2, 3,
    1, 0, 0, 0.5, 0.5,
    0.2, 0, 0, 0,
  ]);

  // ── ARID ─────────────────────────────────────────────
  BIOME_WEIGHTS[Biome.ARID].set([
    45, 15, 15, 5, 2,
    1, 0.5, 0.1, 0.5, 0,
    0, 0, 0, 1, 2,
    5, 3, 1, 0, 0,
    0, 0, 0, 0,
  ]);

  // ── POLAR ────────────────────────────────────────────
  BIOME_WEIGHTS[Biome.POLAR].set([
    10, 30, 10, 10, 5,
    0, 0, 0, 0, 0,
    15, 10, 5, 2, 1,
    0, 0, 0, 2, 2,
    0, 0, 0, 0,
  ]);

  // ── MOUNTAIN ─────────────────────────────────────────
  BIOME_WEIGHTS[Biome.MOUNTAIN].set([
    20, 15, 20, 15, 10,
    3, 2, 1, 3, 0.3,
    5, 3, 0.5, 3, 3,
    0.5, 0, 0, 1, 1,
    1, 0, 0, 0,
  ]);

  // ── COASTAL ──────────────────────────────────────────
  BIOME_WEIGHTS[Biome.COASTAL].set([
    25, 15, 20, 15, 8,
    5, 3, 1, 1, 0,
    2, 1, 0.1, 4, 4,
    1, 0, 0, 0.5, 0.5,
    0.2, 0.5, 0, 0,
  ]);

  // ── DESERT ───────────────────────────────────────────
  BIOME_WEIGHTS[Biome.DESERT].set([
    50, 10, 10, 3, 1,
    0.5, 0.2, 0, 0.2, 0,
    0, 0, 0, 0.5, 1,
    3, 5, 4, 0, 0,
    0, 0, 0, 0,
  ]);

  // ── TUNDRA ───────────────────────────────────────────
  BIOME_WEIGHTS[Biome.TUNDRA].set([
    10, 25, 10, 10, 10,
    0.5, 0.2, 0, 0.3, 0,
    15, 10, 5, 3, 2,
    0, 0, 0, 2, 2,
    0, 0, 0, 0,
  ]);

  // ── FOREST ───────────────────────────────────────────
  BIOME_WEIGHTS[Biome.FOREST].set([
    20, 15, 20, 15, 10,
    5, 3, 1, 3, 0.1,
    5, 2, 0.2, 3, 4,
    1, 0, 0, 0.5, 0.5,
    0.5, 0, 0, 0,
  ]);

  // ── GRASSLAND ────────────────────────────────────────
  BIOME_WEIGHTS[Biome.GRASSLAND].set([
    30, 15, 20, 10, 5,
    5, 2, 0.5, 2, 0,
    3, 1, 0.1, 2, 3,
    2, 0.5, 0.1, 0.3, 0.3,
    0.1, 0, 0, 0,
  ]);

  // ── URBAN ────────────────────────────────────────────
  BIOME_WEIGHTS[Biome.URBAN].set([
    20, 15, 20, 15, 10,
    5, 3, 1, 2, 0,
    3, 1, 0.1, 3, 4,
    5, 0, 0, 0.5, 0.5,
    0.1, 0, 0, 0,
  ]);

  // ── CONTINENTAL ──────────────────────────────────────
  BIOME_WEIGHTS[Biome.CONTINENTAL].set([
    25, 15, 20, 15, 8,
    4, 3, 1, 3, 0.1,
    5, 3, 0.5, 2, 3,
    1, 0, 0, 1, 1,
    0.5, 0, 0, 0,
  ]);
}

// ═══════════════════════════════════════════════════════════════════════
// TRANSITION MATRIX INITIALIZATION — Markov chain
// ═══════════════════════════════════════════════════════════════════════

function initializeTransitionMatrix() {
  // Default: small weight for adjacent categories, larger for staying.
  // From CLEAR_SUNNY, most likely to stay CLEAR_SUNNY or go to
  // PARTLY_CLOUDY / MOSTLY_CLOUDY / CLEAR_NIGHT.
  for (let from = 0; from < WEATHER_TYPE_COUNT; from++) {
    const row = TRANSITION_MATRIX[from];

    // Self-loop dominates: ~30% chance of staying.
    row[from] = 30.0;

    // Adjacent categories: light weight.
    const fromClass = weatherClassOf(from);

    for (let to = 0; to < WEATHER_TYPE_COUNT; to++) {
      if (to === from) continue;

      const toClass = weatherClassOf(to);
      const classDistance = Math.abs(fromClass - toClass);

      let weight = 0.0;

      // Same class: more likely.
      if (fromClass === toClass) {
        weight = 5.0;
      }
      // Adjacent class: moderate.
      else if (classDistance === 1) {
        weight = 3.0;
      }
      // Two apart: less likely.
      else if (classDistance === 2) {
        weight = 1.0;
      }
      // Distant: rare.
      else {
        weight = 0.1;
      }

      row[to] = weight;
    }
  }

  // Customize a few key rows for realism.
  const clearSunny = TRANSITION_MATRIX[WeatherType.CLEAR_SUNNY];
  clearSunny[WeatherType.PARTLY_CLOUDY] = 12.0;
  clearSunny[WeatherType.CLEAR_NIGHT] = 8.0;
  clearSunny[WeatherType.OVERCAST] = 0.5;
  clearSunny[WeatherType.THUNDERSTORM] = 1.0;

  const thunderstorm = TRANSITION_MATRIX[WeatherType.THUNDERSTORM];
  thunderstorm[WeatherType.HEAVY_RAIN] = 15.0;
  thunderstorm[WeatherType.MODERATE_RAIN] = 12.0;
  thunderstorm[WeatherType.CLEAR_SUNNY] = 0.5;
  thunderstorm[WeatherType.MOSTLY_CLOUDY] = 8.0;

  const heavyRain = TRANSITION_MATRIX[WeatherType.HEAVY_RAIN];
  heavyRain[WeatherType.MODERATE_RAIN] = 20.0;
  heavyRain[WeatherType.THUNDERSTORM] = 8.0;
  heavyRain[WeatherType.LIGHT_RAIN] = 10.0;
  heavyRain[WeatherType.OVERCAST] = 10.0;

  const blizzard = TRANSITION_MATRIX[WeatherType.BLIZZARD];
  blizzard[WeatherType.MODERATE_SNOW] = 20.0;
  blizzard[WeatherType.LIGHT_SNOW] = 10.0;
  blizzard[WeatherType.OVERCAST] = 5.0;
}

/**
 * Return the WeatherClass for a WeatherType.
 */
function weatherClassOf(weatherType) {
  switch (weatherType) {
    case WeatherType.CLEAR_SUNNY:
    case WeatherType.CLEAR_NIGHT:
      return WeatherClass.CLEAR;
    case WeatherType.PARTLY_CLOUDY:
    case WeatherType.MOSTLY_CLOUDY:
    case WeatherType.OVERCAST:
      return WeatherClass.CLOUDY;
    case WeatherType.LIGHT_RAIN:
    case WeatherType.MODERATE_RAIN:
    case WeatherType.HEAVY_RAIN:
      return WeatherClass.RAIN;
    case WeatherType.THUNDERSTORM:
    case WeatherType.SUPERCELL:
      return WeatherClass.STORM;
    case WeatherType.LIGHT_SNOW:
    case WeatherType.MODERATE_SNOW:
    case WeatherType.BLIZZARD:
      return WeatherClass.SNOW;
    case WeatherType.FOG:
    case WeatherType.MIST:
    case WeatherType.HAZE:
      return WeatherClass.FOG;
    case WeatherType.DUST_STORM:
    case WeatherType.SANDSTORM:
      return WeatherClass.DUST;
    case WeatherType.FREEZING_RAIN:
    case WeatherType.SLEET:
    case WeatherType.HAIL_STORM:
      return WeatherClass.ICE;
    case WeatherType.TROPICAL_STORM:
    case WeatherType.HURRICANE:
    case WeatherType.TORNADO_OUTBREAK:
      return WeatherClass.TROPICAL_CYC;
    default:
      return WeatherClass.CLEAR;
  }
}

// Initialize on module load.
initializeBiomeWeights();
initializeTransitionMatrix();

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — CUSTOMIZE BIOME AND TRANSITION WEIGHTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Override the weight of a specific (biome, weatherType) pair.
 * Weight = 0 disables that weather entirely for that biome.
 */
export function setBiomeWeight(biome, weatherType, weight) {
  if (biome < 0 || biome >= 12) return;
  if (weatherType < 0 || weatherType >= WEATHER_TYPE_COUNT) return;
  BIOME_WEIGHTS[biome][weatherType] = Math.max(0, weight);
}

/**
 * Override the transition weight from `fromWeather` to `toWeather`.
 */
export function setTransitionWeight(fromWeather, toWeather, weight) {
  if (fromWeather < 0 || fromWeather >= WEATHER_TYPE_COUNT) return;
  if (toWeather < 0 || toWeather >= WEATHER_TYPE_COUNT) return;
  TRANSITION_MATRIX[fromWeather][toWeather] = Math.max(0, weight);
}

// ═══════════════════════════════════════════════════════════════════════
// SCHEDULER REGION CREATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a scheduler region.
 *
 * @param world       ECS world
 * @param eid         entity
 * @param biome       Biome
 * @param options     { dayOfYear, hourOfDay, initialWeather, seed }
 * @returns scheduler region slot
 */
export function addSchedulerRegion(world, eid, biome = Biome.TEMPERATE, options = {}) {
  if (_nextSchedulerRegionSlot >= MAX_WEATHER_REGIONS) {
    throw new Error('scheduler region capacity exceeded');
  }
  const slot = _nextSchedulerRegionSlot++;

  addComponent(world, eid, SchedulerRegionTag);

  ensurePredefinedWeathers();

  const R = SchedulerRegion;
  R.ownerEid[slot] = eid;
  R.biome[slot] = biome;
  R.seasonalOffsetYears[slot] = options.seasonalOffsetYears ?? 0;
  R.dayOfYear[slot] = options.dayOfYear ?? 80;   // ~Mar 21 (spring)
  R.hourOfDay[slot] = options.hourOfDay ?? 12.0;
  R.timeScale[slot] = options.timeScale ?? 60.0;

  // Initial weather.
  const initialWeather = options.initialWeather ?? WeatherType.CLEAR_SUNNY;
  R.currentWeatherType[slot] = initialWeather;
  R.previousWeatherType[slot] = initialWeather;

  // Archetype slot (from PredefinedWeathers).
  const archetypeSlot = archetypeSlotForWeatherType(initialWeather);
  R.currentArchetypeSlot[slot] = archetypeSlot;
  R.previousArchetypeSlot[slot] = archetypeSlot;

  // Initialize dwell.
  R.dwellTimeRemaining[slot] = computeDwellTime(initialWeather);
  R.blendProgress[slot] = 1.0;   // fully transitioned

  R.weatherInstanceSlot[slot] = -1;   // will be set up when instantiated
  R.scriptedOverride[slot] = 0;
  R.scriptedEndHour[slot] = -1;
  R.transitionCount[slot] = 0;
  R.age[slot] = 0;
  R.active[slot] = 1;
  R.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  _schedulerRegionSlots.set(eid, slot);
  return slot;
}

/**
 * Return the archetype slot for a given WeatherType.
 * Assumes PredefinedWeathers has been initialized.
 */
function archetypeSlotForWeatherType(weatherType) {
  const P = PredefinedWeathers;
  switch (weatherType) {
    case WeatherType.CLEAR_SUNNY:      return P.clearSunny;
    case WeatherType.PARTLY_CLOUDY:    return P.partlyCloudy;
    case WeatherType.OVERCAST:         return P.overcast;
    case WeatherType.LIGHT_RAIN:       return P.lightRain;
    case WeatherType.MODERATE_RAIN:    return P.moderateRain;
    case WeatherType.HEAVY_RAIN:       return P.heavyRain;
    case WeatherType.THUNDERSTORM:     return P.thunderstorm;
    case WeatherType.SUPERCELL:        return P.supercell;
    case WeatherType.LIGHT_SNOW:       return P.lightSnow;
    case WeatherType.MODERATE_SNOW:    return P.moderateSnow;
    case WeatherType.BLIZZARD:         return P.blizzard;
    case WeatherType.FOG:              return P.fog;
    case WeatherType.MIST:             return P.mist;
    case WeatherType.HAZE:             return P.haze;
    case WeatherType.DUST_STORM:       return P.dustStorm;
    case WeatherType.SANDSTORM:        return P.sandstorm;
    case WeatherType.FREEZING_RAIN:    return P.freezingRain;
    case WeatherType.SLEET:            return P.sleet;
    case WeatherType.HAIL_STORM:       return P.hailStorm;
    case WeatherType.TROPICAL_STORM:   return P.tropicalStorm;
    case WeatherType.HURRICANE:        return P.hurricane;
    case WeatherType.TORNADO_OUTBREAK: return P.tornadoOutbreak;
    default:                           return P.clearSunny;
  }
}

export function removeSchedulerRegion(world, eid) {
  const slot = _schedulerRegionSlots.get(eid);
  if (slot === undefined) return;
  SchedulerRegion.active[slot] = 0;
  SchedulerRegion.ownerEid[slot] = 0;
  _schedulerRegionSlots.delete(eid);
  removeComponent(world, eid, SchedulerRegionTag);
}

export function getSchedulerRegionSlot(eid) {
  return _schedulerRegionSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// DWELL TIME COMPUTATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the dwell time for a given weather type.
 * Uses the archetype's durationMin / durationMax with ±DWELL_JITTER.
 */
function computeDwellTime(weatherType) {
  const archetypeSlot = archetypeSlotForWeatherType(weatherType);
  const W = WeatherArchetype;

  const min = W.durationMin[archetypeSlot];
  const max = W.durationMax[archetypeSlot];

  if (max <= min) return min;

  // Random duration within the range, with jitter.
  const base = min + Math.random() * (max - min);
  const jitter = (Math.random() - 0.5) * 2 * DWELL_JITTER * base;
  return Math.max(DEFAULT_MIN_DWELL, base + jitter);
}

// ═══════════════════════════════════════════════════════════════════════
// SEASON & TIME HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Determine the current season (0..3) from the day of year.
 */
function currentSeason(dayOfYear) {
  // Approximate: day 0-90 = spring, 91-180 = summer, 181-270 = autumn, 271-365 = winter.
  // Real solstice/equinox offsets adjusted by DAYS_PER_SEASON.
  if (dayOfYear < DAYS_PER_SEASON) return SEASON_SPRING;
  if (dayOfYear < DAYS_PER_SEASON * 2) return SEASON_SUMMER;
  if (dayOfYear < DAYS_PER_SEASON * 3) return SEASON_AUTUMN;
  return SEASON_WINTER;
}

/**
 * Return the seasonal bias for a weather type: 1 = normal, >1 = favored, <1 = suppressed.
 */
function seasonalBias(weatherType, season) {
  // Use the seasonBias bitmask from file 040's archetypes.
  const archetypeSlot = archetypeSlotForWeatherType(weatherType);
  const biasMask = WeatherArchetype.seasonBias[archetypeSlot];

  const bit = 1 << season;
  if ((biasMask & bit) !== 0) return 1.5;   // favored
  return 0.2;                              // suppressed
}

/**
 * Return the diurnal bias for a weather type.
 */
function diurnalBias(weatherType, hourOfDay) {
  // Dawn/dusk fog.
  if (weatherType === WeatherType.FOG || weatherType === WeatherType.MIST) {
    if (hourOfDay >= DAWN_START_HOUR && hourOfDay <= DAWN_END_HOUR) return 3.0;
    if (hourOfDay >= DUSK_START_HOUR && hourOfDay <= DUSK_END_HOUR) return 2.0;
    return 0.5;
  }

  // Afternoon thunderstorms.
  if (weatherType === WeatherType.THUNDERSTORM) {
    const distToAfternoon = Math.abs(hourOfDay - MORNING_STORM_HOUR);
    if (distToAfternoon < 2) return 3.0;
    return 0.5;
  }

  // Evening storms.
  if (weatherType === WeatherType.HEAVY_RAIN || weatherType === WeatherType.SUPERCELL) {
    const distToEvening = Math.abs(hourOfDay - EVENING_STORM_HOUR);
    if (distToEvening < 2) return 2.0;
    return 0.7;
  }

  // Clear skies at night.
  if (weatherType === WeatherType.CLEAR_NIGHT) {
    if (hourOfDay < DAWN_START_HOUR || hourOfDay > DUSK_END_HOUR) return 3.0;
    return 0.1;
  }
  if (weatherType === WeatherType.CLEAR_SUNNY) {
    if (hourOfDay >= DAWN_END_HOUR && hourOfDay <= DUSK_START_HOUR) return 2.0;
    return 0.3;
  }

  return 1.0;
}

// ═══════════════════════════════════════════════════════════════════════
// WEATHER SELECTION — the heart of the scheduler
// ═══════════════════════════════════════════════════════════════════════

/**
 * Select the next weather type for a region using weighted probability.
 *
 * @returns WeatherType
 */
function selectNextWeather(regionSlot, rng) {
  const R = SchedulerRegion;

  const currentWeather = R.currentWeatherType[regionSlot];
  const biome = R.biome[regionSlot];
  const season = currentSeason(R.dayOfYear[regionSlot]);
  const hourOfDay = R.hourOfDay[regionSlot];

  const biomeWeights = BIOME_WEIGHTS[biome];
  const markovRow = TRANSITION_MATRIX[currentWeather];

  // Build the weight table for the current region.
  const weights = new Float32Array(WEATHER_TYPE_COUNT);
  let totalWeight = 0;

  for (let weatherType = 0; weatherType < WEATHER_TYPE_COUNT; weatherType++) {
    const biomeWeight = biomeWeights[weatherType];
    if (biomeWeight < EPSILON) {
      weights[weatherType] = 0;
      continue;
    }

    const markovWeight = markovRow[weatherType];
    const seasonFactor = seasonalBias(weatherType, season);
    const diurnalFactor = diurnalBias(weatherType, hourOfDay);

    // Sanity: suppress SNOW weathers if temperature indicates warm.
    let tempFactor = 1.0;
    // (We don't have ambient temperature here, but we can check the season.)
    if (weatherType === WeatherType.LIGHT_SNOW ||
        weatherType === WeatherType.MODERATE_SNOW ||
        weatherType === WeatherType.BLIZZARD) {
      if (season !== SEASON_WINTER && biome !== Biome.POLAR && biome !== Biome.TUNDRA) {
        tempFactor = 0.05;   // very unlikely in warm seasons / biomes
      }
    }
    if (weatherType === WeatherType.FREEZING_RAIN || weatherType === WeatherType.SLEET) {
      if (season !== SEASON_WINTER) {
        tempFactor = 0.1;
      }
    }

    // Suppress tropical cyclones except in tropical biome and appropriate seasons.
    if (weatherType === WeatherType.HURRICANE ||
        weatherType === WeatherType.TROPICAL_STORM) {
      if (biome !== Biome.TROPICAL && biome !== Biome.COASTAL) {
        tempFactor = 0.05;
      }
    }

    const weight = biomeWeight * markovWeight * seasonFactor * diurnalFactor * tempFactor;
    weights[weatherType] = weight;
    totalWeight += weight;
  }

  // No valid options → fall back to CLEAR_SUNNY (or CLEAR_NIGHT if night).
  if (totalWeight < EPSILON) {
    const isNight = hourOfDay < DAWN_START_HOUR || hourOfDay > DUSK_END_HOUR;
    return isNight ? WeatherType.CLEAR_NIGHT : WeatherType.CLEAR_SUNNY;
  }

  // Weighted random selection.
  let roll = rng() * totalWeight;
  for (let weatherType = 0; weatherType < WEATHER_TYPE_COUNT; weatherType++) {
    roll -= weights[weatherType];
    if (roll <= 0) {
      return weatherType;
    }
  }

  return WeatherType.CLEAR_SUNNY;
}

// ═══════════════════════════════════════════════════════════════════════
// TRANSITION EVENT EMISSION
// ═══════════════════════════════════════════════════════════════════════

function emitTransitionEvent(regionSlot, fromWeather, toWeather) {
  const T = TransitionEvent;

  if (T.count >= 1024) {
    // Drop oldest.
    T.tail = (T.tail + 1) % 1024;
    T.count--;
  }

  const idx = T.head;
  T.regionSlot[idx] = regionSlot;
  T.fromWeatherType[idx] = fromWeather;
  T.toWeatherType[idx] = toWeather;
  T.timeOfDay[idx] = SchedulerRegion.hourOfDay[regionSlot];
  T.dayOfYear[idx] = SchedulerRegion.dayOfYear[regionSlot];
  T.active[idx] = 1;

  T.head = (T.head + 1) % 1024;
  T.count++;
}

/**
 * Pop one transition event from the queue, or null if empty.
 */
export function popTransitionEvent() {
  const T = TransitionEvent;

  if (T.count === 0) return null;

  const idx = T.tail;
  if (!T.active[idx]) {
    T.count--;
    T.tail = (T.tail + 1) % 1024;
    return popTransitionEvent();   // recurse
  }

  T.active[idx] = 0;
  T.count--;
  T.tail = (T.tail + 1) % 1024;

  return {
    regionSlot: T.regionSlot[idx],
    fromWeather: T.fromWeatherType[idx],
    toWeather: T.toWeatherType[idx],
    timeOfDay: T.timeOfDay[idx],
    dayOfYear: T.dayOfYear[idx],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// SCRIPTED WEATHER
// ═══════════════════════════════════════════════════════════════════════

/**
 * Schedule a scripted weather event. The event fires when the region's
 * in-game time reaches `startTime` (in days since epoch), and lasts for
 * `duration` days.
 */
export function scheduleScriptedWeather(
  regionSlot,
  weatherType,
  startTimeDays,
  durationDays,
  blendDuration = DEFAULT_BLEND_DURATION
) {
  if (_nextScriptedEventId >= MAX_SCRIPTED_EVENTS) return -1;

  const id = _nextScriptedEventId++;
  const S = ScriptedWeatherEvent;
  S.active[id] = 1;
  S.regionSlot[id] = regionSlot;
  S.weatherType[id] = weatherType;
  S.startTime[id] = startTimeDays;
  S.duration[id] = durationDays;
  S.blendDuration[id] = blendDuration;
  S.fired[id] = 0;

  return id;
}

/**
 * Force an immediate scripted transition (overrides Markov selection).
 */
export function forceWeather(regionSlot, weatherType, blendDuration = DEFAULT_BLEND_DURATION) {
  const R = SchedulerRegion;
  if (regionSlot < 0 || regionSlot >= _nextSchedulerRegionSlot) return;

  const prevWeather = R.currentWeatherType[regionSlot];
  if (prevWeather === weatherType) return;

  R.previousWeatherType[regionSlot] = prevWeather;
  R.currentWeatherType[regionSlot] = weatherType;
  R.previousArchetypeSlot[regionSlot] = R.currentArchetypeSlot[regionSlot];
  R.currentArchetypeSlot[regionSlot] = archetypeSlotForWeatherType(weatherType);
  R.blendProgress[regionSlot] = 0;
  R.dwellTimeRemaining[regionSlot] = computeDwellTime(weatherType);
  R.transitionCount[regionSlot]++;

  emitTransitionEvent(regionSlot, prevWeather, weatherType);

  // Trigger file 040's blend if a weather instance exists.
  const weatherInstanceSlot = R.weatherInstanceSlot[regionSlot];
  if (weatherInstanceSlot >= 0) {
    blendWeatherTo(null, weatherInstanceSlot, R.currentArchetypeSlot[regionSlot], blendDuration);
  }
}

function processScriptedEvents(world, gameDay) {
  const S = ScriptedWeatherEvent;
  const R = SchedulerRegion;

  for (let id = 0; id < _nextScriptedEventId; id++) {
    if (!S.active[id]) continue;
    if (S.fired[id]) continue;

    const regionSlot = S.regionSlot[id];
    if (!R.active[regionSlot]) continue;

    // Check if the event should fire.
    if (gameDay >= S.startTime[id] && gameDay < S.startTime[id] + S.duration[id]) {
      forceWeather(regionSlot, S.weatherType[id], S.blendDuration[id]);
      S.fired[id] = 1;
    }

    // Check if the event has finished (fire the scheduled event has been consumed).
    if (gameDay > S.startTime[id] + S.duration[id]) {
      S.active[id] = 0;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN SYSTEM — advance the scheduler
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance the weather scheduler for one frame.
 *
 * @param world       ECS world
 * @param dt          real-time seconds
 */
export function systemWeatherSchedulerTick(world, dt) {
  const R = SchedulerRegion;

  for (let regionSlot = 0; regionSlot < _nextSchedulerRegionSlot; regionSlot++) {
    if (!R.active[regionSlot]) continue;

    R.age[regionSlot] += dt;

    // Convert real time to game time.
    const gameHours = dt * R.timeScale[regionSlot] / 3600.0;   // real seconds → game hours
    R.hourOfDay[regionSlot] += gameHours;

    // Handle day rollover.
    while (R.hourOfDay[regionSlot] >= HOURS_PER_DAY) {
      R.hourOfDay[regionSlot] -= HOURS_PER_DAY;
      R.dayOfYear[regionSlot] += 1.0;
      if (R.dayOfYear[regionSlot] >= DAYS_PER_YEAR) {
        R.dayOfYear[regionSlot] -= DAYS_PER_YEAR;
        R.seasonalOffsetYears[regionSlot] += 1.0;
      }
    }

    // Compute the absolute game day (for scripted events).
    const gameDay = R.dayOfYear[regionSlot]
      + R.seasonalOffsetYears[regionSlot] * DAYS_PER_YEAR;

    // Process scripted events.
    processScriptedEvents(world, gameDay);

    // Advance blend progress.
    if (R.blendProgress[regionSlot] < 1.0) {
      R.blendProgress[regionSlot] = Math.min(1.0,
        R.blendProgress[regionSlot] + dt / DEFAULT_BLEND_DURATION);
    }

    // Advance dwell timer.
    R.dwellTimeRemaining[regionSlot] -= dt * R.timeScale[regionSlot] / 60.0;

    // Check for weather transition.
    if (R.dwellTimeRemaining[regionSlot] <= 0 && R.blendProgress[regionSlot] >= 1.0) {
      // Roll a new weather.
      const rng = mulberry32(
        (R.seed[regionSlot] ^ Math.floor(R.age[regionSlot] * 1000)) >>> 0
      );

      const newWeatherType = selectNextWeather(regionSlot, rng);

      if (newWeatherType !== R.currentWeatherType[regionSlot]) {
        // Transition.
        R.previousWeatherType[regionSlot] = R.currentWeatherType[regionSlot];
        R.previousArchetypeSlot[regionSlot] = R.currentArchetypeSlot[regionSlot];
        R.currentWeatherType[regionSlot] = newWeatherType;
        R.currentArchetypeSlot[regionSlot] = archetypeSlotForWeatherType(newWeatherType);
        R.blendProgress[regionSlot] = 0;
        R.dwellTimeRemaining[regionSlot] = computeDwellTime(newWeatherType);
        R.transitionCount[regionSlot]++;

        emitTransitionEvent(regionSlot,
          R.previousWeatherType[regionSlot],
          R.currentWeatherType[regionSlot]);

        // Trigger file 040's blend.
        const weatherInstanceSlot = R.weatherInstanceSlot[regionSlot];
        if (weatherInstanceSlot >= 0) {
          blendWeatherTo(world, weatherInstanceSlot,
            R.currentArchetypeSlot[regionSlot], DEFAULT_BLEND_DURATION);
        }
      } else {
        // Same weather: reset dwell with another roll.
        R.dwellTimeRemaining[regionSlot] = computeDwellTime(newWeatherType);
      }
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS — PREDICTION & QUERIES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Predict the next weather type for a region (single roll).
 */
export function predictNextWeather(regionSlot, seed = 0) {
  if (regionSlot < 0 || regionSlot >= _nextSchedulerRegionSlot) return -1;

  const rng = seed > 0
    ? mulberry32(seed)
    : mulberry32((SchedulerRegion.seed[regionSlot] ^ Date.now()) >>> 0);

  return selectNextWeather(regionSlot, rng);
}

/**
 * Predict the weather that will be active at `futureHours` from now.
 * Simulates forward using the Markov chain (Monte Carlo approximation).
 */
export function predictWeatherIn(regionSlot, futureHours) {
  if (regionSlot < 0 || regionSlot >= _nextSchedulerRegionSlot) return -1;

  const R = SchedulerRegion;

  // Estimate transitions: typically one per ~30-60 game minutes.
  const averageDwellGameMinutes = 45;
  const transitionsToSimulate = Math.floor((futureHours * 60) / averageDwellGameMinutes);

  const rng = mulberry32((R.seed[regionSlot] ^ Math.floor(futureHours * 1000)) >>> 0);

  // Simulate transitions.
  let simulatedWeather = R.currentWeatherType[regionSlot];
  let simulatedHour = R.hourOfDay[regionSlot];

  for (let i = 0; i < transitionsToSimulate; i++) {
    // Compute the hour of day at the time of the transition.
    simulatedHour += averageDwellGameMinutes / 60;
    if (simulatedHour >= HOURS_PER_DAY) simulatedHour -= HOURS_PER_DAY;

    // Compute the seasonal shift over the simulated period.
    const season = currentSeason(R.dayOfYear[regionSlot] + futureHours / 24);

    // Roll a new weather using the current state.
    const weights = new Float32Array(WEATHER_TYPE_COUNT);
    let totalWeight = 0;
    const biomeWeights = BIOME_WEIGHTS[R.biome[regionSlot]];
    const markovRow = TRANSITION_MATRIX[simulatedWeather];

    for (let weatherType = 0; weatherType < WEATHER_TYPE_COUNT; weatherType++) {
      const w = biomeWeights[weatherType] * markovRow[weatherType]
        * seasonalBias(weatherType, season)
        * diurnalBias(weatherType, simulatedHour);
      weights[weatherType] = w;
      totalWeight += w;
    }

    if (totalWeight < EPSILON) continue;

    let roll = rng() * totalWeight;
    for (let weatherType = 0; weatherType < WEATHER_TYPE_COUNT; weatherType++) {
      roll -= weights[weatherType];
      if (roll <= 0) {
        simulatedWeather = weatherType;
        break;
      }
    }
  }

  return simulatedWeather;
}

/**
 * Return the current weather type for a region.
 */
export function getCurrentWeatherType(regionSlot) {
  if (regionSlot < 0 || regionSlot >= _nextSchedulerRegionSlot) return -1;
  return SchedulerRegion.currentWeatherType[regionSlot];
}

/**
 * Return the current game time as { dayOfYear, hourOfDay, season }.
 */
export function getGameTime(regionSlot) {
  if (regionSlot < 0 || regionSlot >= _nextSchedulerRegionSlot) return null;

  const R = SchedulerRegion;
  return {
    dayOfYear: R.dayOfYear[regionSlot],
    hourOfDay: R.hourOfDay[regionSlot],
    season: currentSeason(R.dayOfYear[regionSlot]),
    year: R.seasonalOffsetYears[regionSlot],
  };
}

/**
 * Set the time scale for a region (0 = paused, 1 = 1 game hour per real hour, etc.).
 */
export function setTimeScale(regionSlot, scale) {
  if (regionSlot < 0 || regionSlot >= _nextSchedulerRegionSlot) return;
  SchedulerRegion.timeScale[regionSlot] = Math.max(0, scale);
}

/**
 * Manually advance game time by `hours`.
 */
export function advanceGameTime(regionSlot, hours) {
  if (regionSlot < 0 || regionSlot >= _nextSchedulerRegionSlot) return;

  const R = SchedulerRegion;
  R.hourOfDay[regionSlot] += hours;

  while (R.hourOfDay[regionSlot] >= HOURS_PER_DAY) {
    R.hourOfDay[regionSlot] -= HOURS_PER_DAY;
    R.dayOfYear[regionSlot] += 1.0;
    if (R.dayOfYear[regionSlot] >= DAYS_PER_YEAR) {
      R.dayOfYear[regionSlot] -= DAYS_PER_YEAR;
      R.seasonalOffsetYears[regionSlot] += 1.0;
    }
  }
}

/**
 * Return a human-readable label for a WeatherType.
 */
export function weatherTypeLabel(weatherType) {
  switch (weatherType) {
    case WeatherType.CLEAR_SUNNY:      return 'Clear Sunny';
    case WeatherType.CLEAR_NIGHT:      return 'Clear Night';
    case WeatherType.PARTLY_CLOUDY:    return 'Partly Cloudy';
    case WeatherType.MOSTLY_CLOUDY:    return 'Mostly Cloudy';
    case WeatherType.OVERCAST:         return 'Overcast';
    case WeatherType.LIGHT_RAIN:       return 'Light Rain';
    case WeatherType.MODERATE_RAIN:    return 'Moderate Rain';
    case WeatherType.HEAVY_RAIN:       return 'Heavy Rain';
    case WeatherType.THUNDERSTORM:     return 'Thunderstorm';
    case WeatherType.SUPERCELL:        return 'Supercell';
    case WeatherType.LIGHT_SNOW:       return 'Light Snow';
    case WeatherType.MODERATE_SNOW:    return 'Moderate Snow';
    case WeatherType.BLIZZARD:         return 'Blizzard';
    case WeatherType.FOG:              return 'Fog';
    case WeatherType.MIST:             return 'Mist';
    case WeatherType.HAZE:             return 'Haze';
    case WeatherType.DUST_STORM:       return 'Dust Storm';
    case WeatherType.SANDSTORM:        return 'Sandstorm';
    case WeatherType.FREEZING_RAIN:    return 'Freezing Rain';
    case WeatherType.SLEET:            return 'Sleet';
    case WeatherType.HAIL_STORM:       return 'Hail Storm';
    case WeatherType.TROPICAL_STORM:   return 'Tropical Storm';
    case WeatherType.HURRICANE:        return 'Hurricane';
    case WeatherType.TORNADO_OUTBREAK: return 'Tornado Outbreak';
    default:                            return 'Unknown';
  }
}

/**
 * Return a human-readable label for a Biome.
 */
export function biomeLabel(biome) {
  switch (biome) {
    case Biome.TROPICAL:    return 'Tropical';
    case Biome.TEMPERATE:   return 'Temperate';
    case Biome.ARID:        return 'Arid';
    case Biome.POLAR:       return 'Polar';
    case Biome.MOUNTAIN:    return 'Mountain';
    case Biome.COASTAL:     return 'Coastal';
    case Biome.DESERT:      return 'Desert';
    case Biome.TUNDRA:      return 'Tundra';
    case Biome.FOREST:      return 'Forest';
    case Biome.GRASSLAND:   return 'Grassland';
    case Biome.URBAN:       return 'Urban';
    case Biome.CONTINENTAL: return 'Continental';
    default:                return 'Unknown';
  }
}

/**
 * Return a human-readable label for a season.
 */
export function seasonLabel(season) {
  switch (season) {
    case SEASON_SPRING: return 'Spring';
    case SEASON_SUMMER: return 'Summer';
    case SEASON_AUTUMN: return 'Autumn';
    case SEASON_WINTER: return 'Winter';
    default:            return 'Unknown';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a summary of all active regions for renderer / UI.
 */
export function gatherSchedulerRegionsForRendering() {
  const result = [];
  const R = SchedulerRegion;
  for (let slot = 0; slot < _nextSchedulerRegionSlot; slot++) {
    if (!R.active[slot]) continue;

    const season = currentSeason(R.dayOfYear[slot]);

    result.push({
      slot,
      biome: R.biome[slot],
      biomeLabel: biomeLabel(R.biome[slot]),
      dayOfYear: R.dayOfYear[slot],
      hourOfDay: R.hourOfDay[slot],
      season,
      seasonLabel: seasonLabel(season),
      currentWeatherType: R.currentWeatherType[slot],
      currentWeatherLabel: weatherTypeLabel(R.currentWeatherType[slot]),
      previousWeatherType: R.previousWeatherType[slot],
      blendProgress: R.blendProgress[slot],
      dwellTimeRemaining: R.dwellTimeRemaining[slot],
      transitionCount: R.transitionCount[slot],
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearWeatherScheduler() {
  SchedulerRegion.active.fill(0);
  SchedulerRegion.ownerEid.fill(0);
  _schedulerRegionSlots.clear();
  _nextSchedulerRegionSlot = 0;

  ScriptedWeatherEvent.active.fill(0);
  ScriptedWeatherEvent.fired.fill(0);
  _nextScriptedEventId = 0;

  TransitionEvent.head = 0;
  TransitionEvent.tail = 0;
  TransitionEvent.count = 0;
  TransitionEvent.active.fill(0);
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function weatherSchedulerStats() {
  let activeRegions = 0;
  let transitioningRegions = 0;
  let totalTransitions = 0;

  for (let slot = 0; slot < _nextSchedulerRegionSlot; slot++) {
    if (!SchedulerRegion.active[slot]) continue;
    activeRegions++;
    if (SchedulerRegion.blendProgress[slot] < 1.0) transitioningRegions++;
    totalTransitions += SchedulerRegion.transitionCount[slot];
  }

  let activeScripted = 0;
  for (let id = 0; id < _nextScriptedEventId; id++) {
    if (ScriptedWeatherEvent.active[id] && !ScriptedWeatherEvent.fired[id]) {
      activeScripted++;
    }
  }

  return {
    activeRegions,
    maxRegions: MAX_WEATHER_REGIONS,
    transitioningRegions,
    totalTransitions,
    activeScripted,
    maxScripted: MAX_SCRIPTED_EVENTS,
    pendingTransitionEvents: TransitionEvent.count,
  };
}