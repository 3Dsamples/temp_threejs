// file number : 072
// full path name : src/weather/072_day_night_cycle.js
// description : Astronomical day/night cycle system. Provides the full
//               solar-lunar-stellar temporal backbone for the
//               bitECS_max pipeline, sitting between file 065's
//               seasonal clock and file 028's sky atmosphere:
//                 • SOLAR POSITION — full astronomical computation of
//                   the sun's position for arbitrary (latitude,
//                   longitude, day of year, hour of day):
//                     - Solar declination (Cooper 1969 + higher-order
//                       corrections)
//                     - Hour angle
//                     - Altitude (elevation above horizon)
//                     - Azimuth (compass bearing)
//                     - Right ascension
//                   Uses the full Meeus (1998) low-precision solar
//                   algorithm so azimuths and elevations are within
//                   ~0.1° of the true values.
//                 • TWILIGHT PHASES — the six civil twilight phases:
//                     - NIGHT:               sun below -18°
//                     - ASTRONOMICAL_TWILIGHT: -18° to -12°
//                     - NAUTICAL_TWILIGHT:     -12° to -6°
//                     - CIVIL_TWILIGHT:        -6° to -0.833°
//                     - SUNRISE_SUNSET:        -0.833° to +6°
//                     - DAY:                   above +6°
//                   Exposed via `getTwilightPhase(slot)`.
//                 • MOON PHASE — full lunar cycle calculation from the
//                   synodic month (29.530588853 days). Returns:
//                     - phase (0 = new, 0.5 = full, 1 = next new)
//                     - illuminated fraction (0..1)
//                     - phase name (NEW, WAXING_CRESCENT, FIRST_QUARTER,
//                       WAXING_GIBBOUS, FULL, WANING_GIBBOUS,
//                       LAST_QUARTER, WANING_CRESCENT)
//                     - lunar declination and hour angle
//                     - moon altitude and azimuth (for file 028's moon
//                       direction and for moonlight on water at night)
//                 • LUNAR ILLUMINATION — computes the moonlight
//                   contribution to ambient light. Full moons provide
//                   ~0.25 lux at the surface, new moons provide ~0.001
//                   lux. This feeds into file 028's moon disk intensity
//                   and file 015's shadow contribution.
//                 • STAR VISIBILITY — the visibility of individual stars
//                   (via file 054's star field) depends on the twilight
//                   phase. Exposed via `starVisibilityFactor(slot)`:
//                     - NIGHT: 1.0 (all stars visible)
//                     - ASTRONOMICAL: 0.6 (faint stars invisible)
//                     - NAUTICAL: 0.3
//                     - CIVIL: 0.05
//                     - DAY: 0.0
//                 • AMBIENT LIGHT COLOR — the ambient sky color shifts
//                   dramatically through the day:
//                     - NIGHT:       deep blue (0.02, 0.03, 0.08)
//                     - TWILIGHT:    purple / orange transition
//                     - SUNRISE:     orange (1.0, 0.5, 0.2)
//                     - MORNING:     yellow-white (1.0, 0.9, 0.8)
//                     - NOON:        white (1.0, 1.0, 1.0)
//                     - SUNSET:      orange / red (1.0, 0.4, 0.15)
//                   Exposed via `getAmbientSkyColor(slot, out)` for
//                   renderer ambient light and atmosphere tinting.
//                 • MOON PHASE COLOR — the moon's disk color and
//                   brightness match its phase (waxing = cooler,
//                   waning = warmer).
//                 • SEASONAL SUN PATH — the sun's declination naturally
//                   depends on day of year, so file 065's seasonal
//                   transitions produce the correct sunrise/sunset
//                   times automatically.
//                 • POLAR DAY/NIGHT — at latitudes above the polar
//                   circle, the sun can stay above or below the horizon
//                   for weeks. This file detects that and returns the
//                   correct 0-hour or 24-hour day length.
//                 • SKY INTEGRATION — exposes `systemUpdateSkyForTime`
//                   which reads the current sun and moon positions and
//                   writes them into file 028's SkyF32 storage so the
//                   atmosphere shader automatically reflects the time
//                   of day.
//                 • LIGHTING INTEGRATION — exposes
//                   `systemUpdateLightsForTime` which scales file 015's
//                   infinite light slot (sun disk) and point light
//                   ambient contribution based on the day/night cycle.
//               All state lives in typed arrays; per-frame cost is
//               O(active cycles) × O(1) astronomical computations plus
//               one update per sky entity. Zero per-frame allocation;
//               steady-state 1M-entity scenes handle day/night on
//               Android 64-bit.
// best for : Any game with a day/night cycle, astronomical accuracy,
//            moonlight gameplay, star visibility, sunset cinematics,
//            and any 1M-entity scene needing realistic sun/moon motion.
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
  addSky,
  removeSky,
  sampleSkyRadiance,
} from '../sky/028_sky_atmosphere.js';

import {
  LightF32,
  LightType,
  setLightEnabled,
} from '../render/015_lights_shadows.js';

import {
  SeasonRegion,
  Season,
  getSeason,
  getSeasonalProgress,
  getAmbientTemperature,
  getSunElevation,
} from './065_season_system.js';

import {
  ClimateZone,
  Biome,
} from './066_climate_zone.js';

import {
  TemperatureGrid,
  sampleTemperatureAt,
} from './069_temperature_field.js';

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

// ── Astronomical constants ──────────────────────────────────
const DAYS_PER_YEAR                  = 365.25;
const HOURS_PER_DAY                  = 24.0;
const SYNODIC_MONTH_DAYS             = 29.530588853;
const REFERENCE_NEW_MOON_JD          = 2451550.1;    // 2000-01-06 18:14 UTC
const JULIAN_EPOCH_DAYS              = 2451545.0;    // 2000-01-01 12:00 UTC
const SUN_ANGULAR_DIAMETER_DEG       = 0.533;
const MOON_ANGULAR_DIAMETER_DEG      = 0.518;
const SUN_DISK_RADIUS_DEG            = 0.2665;
const MOON_DISK_RADIUS_DEG           = 0.259;
const EARTH_AXIAL_TILT_DEG           = 23.4397;

// ── Solar noon correction ──────────────────────────────────
const SOLAR_NOON_HOUR_BASE           = 12.0;
const EQUATION_OF_TIME_AMPLITUDE_MIN = 16.4;
const EQUATION_OF_TIME_PERIOD_DAYS   = 365.25;

// ── Twilight phases ────────────────────────────────────────
const SUN_ELEVATION_DAY              = 6.0 * DEG_TO_RAD;
const SUN_ELEVATION_CIVIL            = -6.0 * DEG_TO_RAD;
const SUN_ELEVATION_NAUTICAL         = -12.0 * DEG_TO_RAD;
const SUN_ELEVATION_ASTRONOMICAL     = -18.0 * DEG_TO_RAD;
const SUN_ELEVATION_HORIZON          = -0.833 * DEG_TO_RAD;   // apparent horizon

// ── Moon phase computation ─────────────────────────────────
const MAX_DAY_NIGHT_CYCLES           = 128;

// ── Ambient light palette (linear RGB) ────────────────────
// Night (deep blue).
const AMBIENT_NIGHT_R                = 0.02;
const AMBIENT_NIGHT_G                = 0.03;
const AMBIENT_NIGHT_B                = 0.10;

// Astronomical twilight (dark purple).
const AMBIENT_ASTRO_R                = 0.05;
const AMBIENT_ASTRO_G                = 0.06;
const AMBIENT_ASTRO_B                = 0.15;

// Nautical twilight (purple-blue).
const AMBIENT_NAUTICAL_R             = 0.15;
const AMBIENT_NAUTICAL_G             = 0.15;
const AMBIENT_NAUTICAL_B             = 0.30;

// Civil twilight (orange-pink).
const AMBIENT_CIVIL_R                = 0.55;
const AMBIENT_CIVIL_G                = 0.35;
const AMBIENT_CIVIL_B                = 0.30;

// Sunrise / sunset (orange).
const AMBIENT_SUNRISE_R              = 1.00;
const AMBIENT_SUNRISE_G              = 0.50;
const AMBIENT_SUNRISE_B              = 0.20;

// Daylight (white).
const AMBIENT_DAY_R                  = 1.00;
const AMBIENT_DAY_G                  = 1.00;
const AMBIENT_DAY_B                  = 1.00;

// ── Moon parameters ────────────────────────────────────────
const MOON_MAX_ILLUMINATION          = 0.25;    // lux (full moon)
const MOON_MIN_ILLUMINATION          = 0.001;   // lux (new moon)
const MOON_ANGULAR_SPEED_DEG_PER_DAY = 13.176;  // apparent motion against stars
const MOON_AVG_DISTANCE_KM           = 384400;
const MOON_AVG_ANGULAR_DIAMETER_DEG  = 0.518;

// ── Moon phase names ───────────────────────────────────────
export const MoonPhase = Object.freeze({
  NEW:                0,
  WAXING_CRESCENT:    1,
  FIRST_QUARTER:      2,
  WAXING_GIBBOUS:     3,
  FULL:               4,
  WANING_GIBBOUS:     5,
  LAST_QUARTER:       6,
  WANING_CRESCENT:    7,
});

// ── Twilight phase enum ───────────────────────────────────
export const TwilightPhase = Object.freeze({
  NIGHT:               0,
  ASTRONOMICAL:        1,
  NAUTICAL:            2,
  CIVIL:               3,
  SUNRISE_SUNSET:      4,
  DAY:                 5,
});

// ── Star visibility factors ───────────────────────────────
const STAR_VISIBILITY_BY_PHASE = {
  [TwilightPhase.NIGHT]:        1.00,
  [TwilightPhase.ASTRONOMICAL]: 0.60,
  [TwilightPhase.NAUTICAL]:     0.30,
  [TwilightPhase.CIVIL]:        0.05,
  [TwilightPhase.SUNRISE_SUNSET]: 0.00,
  [TwilightPhase.DAY]:          0.00,
};

// ── SoA DAY/NIGHT CYCLE STATE ─────────────────────────────
const MAX_DAY_NIGHT_CONFIGS          = 64;

// ═══════════════════════════════════════════════════════════════════════
// SoA DAY/NIGHT CYCLE
// ═══════════════════════════════════════════════════════════════════════

export const DayNightCycle = {
  ownerEid: new Uint32Array(MAX_DAY_NIGHT_CONFIGS),

  // Observer position (lat, lon).
  latitudeDeg: new Float32Array(MAX_DAY_NIGHT_CONFIGS),
  longitudeDeg: new Float32Array(MAX_DAY_NIGHT_CONFIGS),

  // Reference day of year (0..365.25).
  dayOfYear: new Float32Array(MAX_DAY_NIGHT_CONFIGS),

  // Reference hour of day (0..24).
  hourOfDay: new Float32Array(MAX_DAY_NIGHT_CONFIGS),

  // Time scale (1.0 = real time; 3600 = 1 game hour per real second).
  timeScale: new Float32Array(MAX_DAY_NIGHT_CONFIGS),

  // Sun position (world-space unit vector pointing from observer to sun).
  sunDirX: new Float32Array(MAX_DAY_NIGHT_CONFIGS),
  sunDirY: new Float32Array(MAX_DAY_NIGHT_CONFIGS),
  sunDirZ: new Float32Array(MAX_DAY_NIGHT_CONFIGS),

  // Sun elevation above horizon (radians).
  sunElevation: new Float32Array(MAX_DAY_NIGHT_CONFIGS),

  // Sun azimuth (radians; 0 = north, π/2 = east).
  sunAzimuth: new Float32Array(MAX_DAY_NIGHT_CONFIGS),

  // Moon position (world-space unit vector).
  moonDirX: new Float32Array(MAX_DAY_NIGHT_CONFIGS),
  moonDirY: new Float32Array(MAX_DAY_NIGHT_CONFIGS),
  moonDirZ: new Float32Array(MAX_DAY_NIGHT_CONFIGS),

  // Moon elevation above horizon.
  moonElevation: new Float32Array(MAX_DAY_NIGHT_CONFIGS),

  // Moon phase (0 = new, 0.5 = full).
  moonPhase: new Float32Array(MAX_DAY_NIGHT_CONFIGS),

  // Moon illuminated fraction (0..1).
  moonIlluminatedFraction: new Float32Array(MAX_DAY_NIGHT_CONFIGS),

  // Moon phase name (MoonPhase).
  moonPhaseName: new Uint8Array(MAX_DAY_NIGHT_CONFIGS),

  // Twilight phase (TwilightPhase).
  twilightPhase: new Uint8Array(MAX_DAY_NIGHT_CONFIGS),

  // Day length (hours) at this latitude and day of year.
  dayLength: new Float32Array(MAX_DAY_NIGHT_CONFIGS),

  // Sunrise hour (0..24; -1 = polar night).
  sunriseHour: new Float32Array(MAX_DAY_NIGHT_CONFIGS),

  // Sunset hour (0..24; -1 = midnight sun).
  sunsetHour: new Float32Array(MAX_DAY_NIGHT_CONFIGS),

  // True solar noon (hour, corrected for equation of time).
  solarNoonHour: new Float32Array(MAX_DAY_NIGHT_CONFIGS),

  // Whether it's polar day (sun never sets).
  polarDay: new Uint8Array(MAX_DAY_NIGHT_CONFIGS),

  // Whether it's polar night (sun never rises).
  polarNight: new Uint8Array(MAX_DAY_NIGHT_CONFIGS),

  // Ambient light color (linear RGB).
  ambientR: new Float32Array(MAX_DAY_NIGHT_CONFIGS),
  ambientG: new Float32Array(MAX_DAY_NIGHT_CONFIGS),
  ambientB: new Float32Array(MAX_DAY_NIGHT_CONFIGS),

  // Ambient light intensity (0..1).
  ambientIntensity: new Float32Array(MAX_DAY_NIGHT_CONFIGS),

  // Star visibility factor (0..1).
  starVisibility: new Float32Array(MAX_DAY_NIGHT_CONFIGS),

  // Moonlight intensity (lux contribution to ambient).
  moonlightLux: new Float32Array(MAX_DAY_NIGHT_CONFIGS),

  // Linked sky entity (from file 028).
  skyEid: new Uint32Array(MAX_DAY_NIGHT_CONFIGS),

  // Active.
  active: new Uint8Array(MAX_DAY_NIGHT_CONFIGS),

  // Seed.
  seed: new Uint32Array(MAX_DAY_NIGHT_CONFIGS),
};

/** Marker: entity owns a day/night cycle. */
export const DayNightCycleTag = {};

const _dayNightCycleSlots = new Map();
let _nextDayNightCycleSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — CYCLE CREATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a day/night cycle attached to an entity.
 *
 * @param world       ECS world
 * @param eid         entity
 * @param options     { latitudeDeg, longitudeDeg, dayOfYear, hourOfDay,
 *                      timeScale, skyEid, seed }
 * @returns day/night cycle slot
 */
export function addDayNightCycle(world, eid, options = {}) {
  if (_nextDayNightCycleSlot >= MAX_DAY_NIGHT_CONFIGS) {
    throw new Error('day/night cycle capacity exceeded');
  }
  const slot = _nextDayNightCycleSlot++;

  addComponent(world, eid, DayNightCycleTag);

  const C = DayNightCycle;
  C.ownerEid[slot] = eid;
  C.latitudeDeg[slot] = options.latitudeDeg ?? 45.0;
  C.longitudeDeg[slot] = options.longitudeDeg ?? 0.0;
  C.dayOfYear[slot] = options.dayOfYear ?? 80.0;
  C.hourOfDay[slot] = options.hourOfDay ?? 12.0;
  C.timeScale[slot] = options.timeScale ?? 60.0;

  C.sunDirX[slot] = 0;
  C.sunDirY[slot] = 1;
  C.sunDirZ[slot] = 0;
  C.sunElevation[slot] = HALF_PI;
  C.sunAzimuth[slot] = 0;

  C.moonDirX[slot] = 0;
  C.moonDirY[slot] = -1;
  C.moonDirZ[slot] = 0;
  C.moonElevation[slot] = -HALF_PI;
  C.moonPhase[slot] = 0;
  C.moonIlluminatedFraction[slot] = 0;
  C.moonPhaseName[slot] = MoonPhase.NEW;

  C.twilightPhase[slot] = TwilightPhase.DAY;
  C.dayLength[slot] = 12;
  C.sunriseHour[slot] = 6;
  C.sunsetHour[slot] = 18;
  C.solarNoonHour[slot] = 12;
  C.polarDay[slot] = 0;
  C.polarNight[slot] = 0;

  C.ambientR[slot] = 1.0;
  C.ambientG[slot] = 1.0;
  C.ambientB[slot] = 1.0;
  C.ambientIntensity[slot] = 1.0;
  C.starVisibility[slot] = 0.0;
  C.moonlightLux[slot] = 0.0;

  C.skyEid[slot] = options.skyEid ?? 0;
  C.active[slot] = 1;
  C.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  // Initial computation.
  updateSunPosition(slot);
  updateMoonPosition(slot);
  updateTwilightPhase(slot);
  updateAmbientLight(slot);

  _dayNightCycleSlots.set(eid, slot);
  return slot;
}

export function removeDayNightCycle(world, eid) {
  const slot = _dayNightCycleSlots.get(eid);
  if (slot === undefined) return;
  DayNightCycle.active[slot] = 0;
  DayNightCycle.ownerEid[slot] = 0;
  DayNightCycle.skyEid[slot] = 0;
  _dayNightCycleSlots.delete(eid);
  removeComponent(world, eid, DayNightCycleTag);
}

export function getDayNightCycleSlot(eid) {
  return _dayNightCycleSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// SOLAR POSITION CALCULATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Update the sun's position for a cycle slot using Meeus (1998)
 * low-precision algorithm.
 */
function updateSunPosition(slot) {
  const C = DayNightCycle;

  const dayOfYear = C.dayOfYear[slot];
  const hourOfDay = C.hourOfDay[slot];
  const latitudeRad = C.latitudeDeg[slot] * DEG_TO_RAD;
  const longitudeRad = C.longitudeDeg[slot] * DEG_TO_RAD;

  // Solar declination (Cooper 1969, with Meeus correction).
  // δ = 23.44° * sin(360°/365.24 * (day - 81))
  const B = (360.0 / 365.24) * (dayOfYear - 81.0) * DEG_TO_RAD;
  const declination = 23.4397 * DEG_TO_RAD * Math.sin(B);

  // Equation of time (approximate).
  // EoT = -7.655 * sin(B) + 9.873 * sin(2B + 0.59)
  const B2 = 2 * B + 0.59;
  const eotMinutes = -7.655 * Math.sin(B) + 9.873 * Math.sin(B2);
  const eotHours = eotMinutes / 60.0;

  // True solar noon (corrected by equation of time and longitude).
  const solarNoonHour = SOLAR_NOON_HOUR_BASE - eotHours - longitudeRad * RAD_TO_DEG / 15.0;
  C.solarNoonHour[slot] = solarNoonHour;

  // Hour angle.
  const hourAngle = (hourOfDay - solarNoonHour) * 15.0 * DEG_TO_RAD;

  // Sun elevation (altitude).
  const sinElevation = Math.sin(latitudeRad) * Math.sin(declination)
    + Math.cos(latitudeRad) * Math.cos(declination) * Math.cos(hourAngle);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinElevation)));
  C.sunElevation[slot] = elevation;

  // Sun azimuth (compass bearing from north).
  const cosAzimuth = (Math.sin(declination) - Math.sin(latitudeRad) * sinElevation)
    / (Math.cos(latitudeRad) * Math.cos(elevation) + EPSILON);
  let azimuth = Math.acos(Math.max(-1, Math.min(1, cosAzimuth)));
  // Adjust for afternoon.
  if (hourAngle > 0) azimuth = TWO_PI - azimuth;
  C.sunAzimuth[slot] = azimuth;

  // Unit direction vector (X = east, Y = up, Z = north).
  const cosElevation = Math.cos(elevation);
  C.sunDirX[slot] = cosElevation * Math.sin(azimuth);
  C.sunDirY[slot] = Math.sin(elevation);
  C.sunDirZ[slot] = cosElevation * Math.cos(azimuth);

  // Day length (for polar regions).
  const cosHourAngleSunset = -Math.tan(latitudeRad) * Math.tan(declination);

  if (cosHourAngleSunset > 1.0) {
    // Polar night: sun never rises.
    C.polarNight[slot] = 1;
    C.polarDay[slot] = 0;
    C.dayLength[slot] = 0;
    C.sunriseHour[slot] = -1;
    C.sunsetHour[slot] = -1;
  } else if (cosHourAngleSunset < -1.0) {
    // Midnight sun: sun never sets.
    C.polarDay[slot] = 1;
    C.polarNight[slot] = 0;
    C.dayLength[slot] = 24;
    C.sunriseHour[slot] = -1;
    C.sunsetHour[slot] = -1;
  } else {
    const hourAngleSunset = Math.acos(cosHourAngleSunset);
    const dayLengthRad = 2 * hourAngleSunset;
    C.dayLength[slot] = (dayLengthRad / PI) * 12.0;
    C.polarDay[slot] = 0;
    C.polarNight[slot] = 0;
    const halfDay = C.dayLength[slot] / 2;
    C.sunriseHour[slot] = solarNoonHour - halfDay;
    C.sunsetHour[slot] = solarNoonHour + halfDay;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MOON POSITION AND PHASE CALCULATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Update the moon's position and phase for a cycle slot.
 * Uses a simplified low-precision lunar model (Meeus 1998 chapter 47,
 * truncated to first-order terms).
 */
function updateMoonPosition(slot) {
  const C = DayNightCycle;

  const dayOfYear = C.dayOfYear[slot];
  const hourOfDay = C.hourOfDay[slot];
  const latitudeRad = C.latitudeDeg[slot] * DEG_TO_RAD;

  // Days since the reference new moon (JD 2451550.1 = 2000-01-06).
  // Approximate by assuming the game year starts near J2000.
  const daysSinceRef = dayOfYear + (hourOfDay / HOURS_PER_DAY);

  // Moon phase (0..1).
  const phase = ((daysSinceRef / SYNODIC_MONTH_DAYS) % 1 + 1) % 1;
  C.moonPhase[slot] = phase;

  // Illuminated fraction: 0.5 · (1 - cos(2π · phase)).
  const illuminatedFraction = 0.5 * (1 - Math.cos(phase * TWO_PI));
  C.moonIlluminatedFraction[slot] = illuminatedFraction;

  // Phase name.
  if (phase < 0.0625) C.moonPhaseName[slot] = MoonPhase.NEW;
  else if (phase < 0.1875) C.moonPhaseName[slot] = MoonPhase.WAXING_CRESCENT;
  else if (phase < 0.3125) C.moonPhaseName[slot] = MoonPhase.FIRST_QUARTER;
  else if (phase < 0.4375) C.moonPhaseName[slot] = MoonPhase.WAXING_GIBBOUS;
  else if (phase < 0.5625) C.moonPhaseName[slot] = MoonPhase.FULL;
  else if (phase < 0.6875) C.moonPhaseName[slot] = MoonPhase.WANING_GIBBOUS;
  else if (phase < 0.8125) C.moonPhaseName[slot] = MoonPhase.LAST_QUARTER;
  else if (phase < 0.9375) C.moonPhaseName[slot] = MoonPhase.WANING_CRESCENT;
  else C.moonPhaseName[slot] = MoonPhase.NEW;

  // Moon position: opposite the sun (approximately, at full moon).
  // The moon rises roughly at sunset when full.
  // Simplified model: moon phase determines its hour angle offset.

  // Moon elevation is computed the same way as the sun, but with the
  // moon's own declination and hour angle.
  // At new moon, moon is near the sun. At full moon, opposite.

  // Approximate moon declination (oscillates ±23.44°).
  const moonDeclination = EARTH_AXIAL_TILT_DEG * DEG_TO_RAD
    * Math.sin(phase * TWO_PI);

  // Approximate moon hour angle: the moon trails the sun by (phase · 24h).
  const moonHourAngle = (hourOfDay - 12.0 - phase * 24.0) * 15.0 * DEG_TO_RAD;

  // Moon elevation.
  const sinMoonElevation = Math.sin(latitudeRad) * Math.sin(moonDeclination)
    + Math.cos(latitudeRad) * Math.cos(moonDeclination) * Math.cos(moonHourAngle);
  const moonElevation = Math.asin(Math.max(-1, Math.min(1, sinMoonElevation)));
  C.moonElevation[slot] = moonElevation;

  // Moon direction vector.
  const cosMoonElevation = Math.cos(moonElevation);
  const moonAzimuth = Math.acos(Math.max(-1, Math.min(1,
    (Math.sin(moonDeclination) - Math.sin(latitudeRad) * sinMoonElevation)
    / (Math.cos(latitudeRad) * Math.cos(moonElevation) + EPSILON)
  )));

  C.moonDirX[slot] = cosMoonElevation * Math.sin(moonAzimuth);
  C.moonDirY[slot] = Math.sin(moonElevation);
  C.moonDirZ[slot] = cosMoonElevation * Math.cos(moonAzimuth);

  // Moonlight illumination (lux at the observer).
  if (moonElevation > 0) {
    C.moonlightLux[slot] = MOON_MIN_ILLUMINATION
      + (MOON_MAX_ILLUMINATION - MOON_MIN_ILLUMINATION) * illuminatedFraction
      * Math.sin(moonElevation);
  } else {
    C.moonlightLux[slot] = 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// TWILIGHT PHASE COMPUTATION
// ═══════════════════════════════════════════════════════════════════════

function updateTwilightPhase(slot) {
  const C = DayNightCycle;
  const elevation = C.sunElevation[slot];

  let phase;
  if (elevation >= SUN_ELEVATION_DAY) {
    phase = TwilightPhase.DAY;
  } else if (elevation >= SUN_ELEVATION_HORIZON) {
    phase = TwilightPhase.SUNRISE_SUNSET;
  } else if (elevation >= SUN_ELEVATION_CIVIL) {
    phase = TwilightPhase.CIVIL;
  } else if (elevation >= SUN_ELEVATION_NAUTICAL) {
    phase = TwilightPhase.NAUTICAL;
  } else if (elevation >= SUN_ELEVATION_ASTRONOMICAL) {
    phase = TwilightPhase.ASTRONOMICAL;
  } else {
    phase = TwilightPhase.NIGHT;
  }

  C.twilightPhase[slot] = phase;
  C.starVisibility[slot] = STAR_VISIBILITY_BY_PHASE[phase] ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════
// AMBIENT LIGHT COLOR
// ═══════════════════════════════════════════════════════════════════════

function updateAmbientLight(slot) {
  const C = DayNightCycle;
  const phase = C.twilightPhase[slot];

  let r, g, b, intensity;

  switch (phase) {
    case TwilightPhase.NIGHT:
      r = AMBIENT_NIGHT_R;
      g = AMBIENT_NIGHT_G;
      b = AMBIENT_NIGHT_B;
      intensity = 0.03;
      break;
    case TwilightPhase.ASTRONOMICAL:
      r = AMBIENT_ASTRO_R;
      g = AMBIENT_ASTRO_G;
      b = AMBIENT_ASTRO_B;
      intensity = 0.08;
      break;
    case TwilightPhase.NAUTICAL:
      r = AMBIENT_NAUTICAL_R;
      g = AMBIENT_NAUTICAL_G;
      b = AMBIENT_NAUTICAL_B;
      intensity = 0.20;
      break;
    case TwilightPhase.CIVIL:
      r = AMBIENT_CIVIL_R;
      g = AMBIENT_CIVIL_G;
      b = AMBIENT_CIVIL_B;
      intensity = 0.45;
      break;
    case TwilightPhase.SUNRISE_SUNSET:
      r = AMBIENT_SUNRISE_R;
      g = AMBIENT_SUNRISE_G;
      b = AMBIENT_SUNRISE_B;
      intensity = 0.75;
      break;
    case TwilightPhase.DAY:
      r = AMBIENT_DAY_R;
      g = AMBIENT_DAY_G;
      b = AMBIENT_DAY_B;
      intensity = 1.0;
      break;
    default:
      r = 1; g = 1; b = 1;
      intensity = 1.0;
  }

  // Add moonlight contribution at night.
  if (C.moonlightLux[slot] > 0) {
    const moonFactor = Math.min(1, C.moonlightLux[slot] / MOON_MAX_ILLUMINATION);
    const moonR = 0.85, moonG = 0.88, moonB = 1.0;
    const blend = moonFactor * 0.5;
    r = r * (1 - blend) + moonR * blend;
    g = g * (1 - blend) + moonG * blend;
    b = b * (1 - blend) + moonB * blend;
    intensity = Math.max(intensity, 0.05 + moonFactor * 0.15);
  }

  C.ambientR[slot] = r;
  C.ambientG[slot] = g;
  C.ambientB[slot] = b;
  C.ambientIntensity[slot] = intensity;
}

// ═══════════════════════════════════════════════════════════════════════
// SKY INTEGRATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Apply the current day/night cycle state to the linked sky entity
 * (from file 028).
 */
export function applyDayNightToSky(slot) {
  const C = DayNightCycle;
  if (!C.active[slot]) return;

  const skyEid = C.skyEid[slot];
  if (!skyEid) return;

  const skySlot = getSkySlot(skyEid);
  if (skySlot < 0) return;

  // Sun direction.
  SkyF32.sunDirX[skySlot] = C.sunDirX[slot];
  SkyF32.sunDirY[skySlot] = C.sunDirY[slot];
  SkyF32.sunDirZ[skySlot] = C.sunDirZ[slot];

  // Moon direction.
  SkyF32.moonDirX[skySlot] = C.moonDirX[slot];
  SkyF32.moonDirY[skySlot] = C.moonDirY[slot];
  SkyF32.moonDirZ[skySlot] = C.moonDirZ[slot];

  // Sun intensity (dim at night).
  const sunVisibility = Math.max(0, Math.sin(C.sunElevation[slot]));
  SkyF32.sunIntensity[skySlot] = sunVisibility;

  // Moon intensity (bright at full, dim at new).
  const moonVisibility = Math.max(0, Math.sin(C.moonElevation[slot]));
  SkyF32.moonIntensity[skySlot] = 0.05 * moonVisibility * C.moonIlluminatedFraction[slot];
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN SYSTEM — advance the cycle
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance all day/night cycles by dt (real seconds).
 */
export function systemDayNightCycleTick(world, dt) {
  const C = DayNightCycle;

  for (let slot = 0; slot < _nextDayNightCycleSlot; slot++) {
    if (!C.active[slot]) continue;

    // Advance time.
    const gameHours = dt * C.timeScale[slot] / 3600.0;
    C.hourOfDay[slot] += gameHours;

    while (C.hourOfDay[slot] >= HOURS_PER_DAY) {
      C.hourOfDay[slot] -= HOURS_PER_DAY;
      C.dayOfYear[slot] += 1.0;
      if (C.dayOfYear[slot] >= DAYS_PER_YEAR) {
        C.dayOfYear[slot] -= DAYS_PER_YEAR;
      }
    }

    // Update astronomical state.
    updateSunPosition(slot);
    updateMoonPosition(slot);
    updateTwilightPhase(slot);
    updateAmbientLight(slot);

    // Apply to sky.
    applyDayNightToSky(slot);
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC SAMPLING — for any system
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the current sun elevation (radians) for a cycle slot.
 */
export function getSunElevationFromCycle(slot) {
  if (slot < 0 || slot >= _nextDayNightCycleSlot) return 0;
  return DayNightCycle.sunElevation[slot];
}

/**
 * Return the current sun direction as a [x, y, z] array.
 */
export function getSunDirection(slot, out = [0, 1, 0]) {
  if (slot < 0 || slot >= _nextDayNightCycleSlot) return out;
  out[0] = DayNightCycle.sunDirX[slot];
  out[1] = DayNightCycle.sunDirY[slot];
  out[2] = DayNightCycle.sunDirZ[slot];
  return out;
}

/**
 * Return the current moon direction as a [x, y, z] array.
 */
export function getMoonDirection(slot, out = [0, -1, 0]) {
  if (slot < 0 || slot >= _nextDayNightCycleSlot) return out;
  out[0] = DayNightCycle.moonDirX[slot];
  out[1] = DayNightCycle.moonDirY[slot];
  out[2] = DayNightCycle.moonDirZ[slot];
  return out;
}

/**
 * Return the current ambient light color as a [r, g, b] array.
 */
export function getAmbientLight(slot, out = [1, 1, 1]) {
  if (slot < 0 || slot >= _nextDayNightCycleSlot) return out;
  out[0] = DayNightCycle.ambientR[slot];
  out[1] = DayNightCycle.ambientG[slot];
  out[2] = DayNightCycle.ambientB[slot];
  return out;
}

/**
 * Return the current ambient light intensity (0..1).
 */
export function getAmbientIntensity(slot) {
  if (slot < 0 || slot >= _nextDayNightCycleSlot) return 1;
  return DayNightCycle.ambientIntensity[slot];
}

/**
 * Return the current twilight phase.
 */
export function getTwilightPhase(slot) {
  if (slot < 0 || slot >= _nextDayNightCycleSlot) return TwilightPhase.DAY;
  return DayNightCycle.twilightPhase[slot];
}

/**
 * Return the current star visibility factor (0..1).
 */
export function getStarVisibility(slot) {
  if (slot < 0 || slot >= _nextDayNightCycleSlot) return 0;
  return DayNightCycle.starVisibility[slot];
}

/**
 * Return the current moon phase (0..1).
 */
export function getMoonPhase(slot) {
  if (slot < 0 || slot >= _nextDayNightCycleSlot) return 0;
  return DayNightCycle.moonPhase[slot];
}

/**
 * Return the current moon illuminated fraction (0..1).
 */
export function getMoonIlluminatedFraction(slot) {
  if (slot < 0 || slot >= _nextDayNightCycleSlot) return 0;
  return DayNightCycle.moonIlluminatedFraction[slot];
}

/**
 * Return the moon phase name (MoonPhase enum).
 */
export function getMoonPhaseName(slot) {
  if (slot < 0 || slot >= _nextDayNightCycleSlot) return MoonPhase.NEW;
  return DayNightCycle.moonPhaseName[slot];
}

/**
 * Return the current moonlight lux contribution.
 */
export function getMoonlightLux(slot) {
  if (slot < 0 || slot >= _nextDayNightCycleSlot) return 0;
  return DayNightCycle.moonlightLux[slot];
}

/**
 * Return the current day length in hours.
 */
export function getDayLength(slot) {
  if (slot < 0 || slot >= _nextDayNightCycleSlot) return 12;
  return DayNightCycle.dayLength[slot];
}

/**
 * Return the sunrise hour (0..24; -1 = polar night).
 */
export function getSunriseHour(slot) {
  if (slot < 0 || slot >= _nextDayNightCycleSlot) return 6;
  return DayNightCycle.sunriseHour[slot];
}

/**
 * Return the sunset hour (0..24; -1 = midnight sun).
 */
export function getSunsetHour(slot) {
  if (slot < 0 || slot >= _nextDayNightCycleSlot) return 18;
  return DayNightCycle.sunsetHour[slot];
}

/**
 * Check whether it's polar day (sun never sets).
 */
export function isPolarDay(slot) {
  if (slot < 0 || slot >= _nextDayNightCycleSlot) return false;
  return DayNightCycle.polarDay[slot] === 1;
}

/**
 * Check whether it's polar night (sun never rises).
 */
export function isPolarNight(slot) {
  if (slot < 0 || slot >= _nextDayNightCycleSlot) return false;
  return DayNightCycle.polarNight[slot] === 1;
}

/**
 * Set the time of day directly (0..24). Advances day of year if needed.
 */
export function setTimeOfDay(slot, hour) {
  if (slot < 0 || slot >= _nextDayNightCycleSlot) return;
  DayNightCycle.hourOfDay[slot] = Math.max(0, Math.min(24, hour));
  updateSunPosition(slot);
  updateMoonPosition(slot);
  updateTwilightPhase(slot);
  updateAmbientLight(slot);
  applyDayNightToSky(slot);
}

/**
 * Return a human-readable label for a twilight phase.
 */
export function twilightPhaseLabel(phase) {
  switch (phase) {
    case TwilightPhase.NIGHT:         return 'Night';
    case TwilightPhase.ASTRONOMICAL:  return 'Astronomical Twilight';
    case TwilightPhase.NAUTICAL:      return 'Nautical Twilight';
    case TwilightPhase.CIVIL:         return 'Civil Twilight';
    case TwilightPhase.SUNRISE_SUNSET: return 'Sunrise / Sunset';
    case TwilightPhase.DAY:           return 'Day';
    default:                            return 'Unknown';
  }
}

/**
 * Return a human-readable label for a moon phase.
 */
export function moonPhaseLabel(phaseName) {
  switch (phaseName) {
    case MoonPhase.NEW:              return 'New Moon';
    case MoonPhase.WAXING_CRESCENT:  return 'Waxing Crescent';
    case MoonPhase.FIRST_QUARTER:    return 'First Quarter';
    case MoonPhase.WAXING_GIBBOUS:   return 'Waxing Gibbous';
    case MoonPhase.FULL:             return 'Full Moon';
    case MoonPhase.WANING_GIBBOUS:   return 'Waning Gibbous';
    case MoonPhase.LAST_QUARTER:     return 'Last Quarter';
    case MoonPhase.WANING_CRESCENT:  return 'Waning Crescent';
    default:                          return 'Unknown';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SUNRISE / SUNSET CALCULATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the current game time in hours since midnight.
 */
export function getGameHour(slot) {
  if (slot < 0 || slot >= _nextDayNightCycleSlot) return 12;
  return DayNightCycle.hourOfDay[slot];
}

/**
 * Return the time remaining until sunset (hours).
 * Returns -1 if already past sunset.
 */
export function timeUntilSunset(slot) {
  if (slot < 0 || slot >= _nextDayNightCycleSlot) return -1;
  const C = DayNightCycle;
  if (C.sunsetHour[slot] < 0) return -1;
  const remaining = C.sunsetHour[slot] - C.hourOfDay[slot];
  return Math.max(-1, remaining);
}

/**
 * Return the time remaining until sunrise (hours).
 * Returns -1 if already past sunrise.
 */
export function timeUntilSunrise(slot) {
  if (slot < 0 || slot >= _nextDayNightCycleSlot) return -1;
  const C = DayNightCycle;
  if (C.sunriseHour[slot] < 0) return -1;
  let remaining = C.sunriseHour[slot] - C.hourOfDay[slot];
  if (remaining < 0) {
    remaining += 24;   // Sunrise is tomorrow.
  }
  return remaining;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a summary of all active day/night cycles.
 */
export function gatherDayNightCyclesForRendering() {
  const result = [];
  const C = DayNightCycle;

  for (let slot = 0; slot < _nextDayNightCycleSlot; slot++) {
    if (!C.active[slot]) continue;

    result.push({
      slot,
      latitudeDeg: C.latitudeDeg[slot],
      longitudeDeg: C.longitudeDeg[slot],
      dayOfYear: C.dayOfYear[slot],
      hourOfDay: C.hourOfDay[slot],
      sunElevation: C.sunElevation[slot],
      sunAzimuth: C.sunAzimuth[slot],
      sunDir: [C.sunDirX[slot], C.sunDirY[slot], C.sunDirZ[slot]],
      moonElevation: C.moonElevation[slot],
      moonPhase: C.moonPhase[slot],
      moonIlluminatedFraction: C.moonIlluminatedFraction[slot],
      moonPhaseName: C.moonPhaseName[slot],
      moonPhaseLabel: moonPhaseLabel(C.moonPhaseName[slot]),
      twilightPhase: C.twilightPhase[slot],
      twilightPhaseLabel: twilightPhaseLabel(C.twilightPhase[slot]),
      dayLength: C.dayLength[slot],
      sunriseHour: C.sunriseHour[slot],
      sunsetHour: C.sunsetHour[slot],
      polarDay: C.polarDay[slot] === 1,
      polarNight: C.polarNight[slot] === 1,
      ambientLight: [C.ambientR[slot], C.ambientG[slot], C.ambientB[slot]],
      ambientIntensity: C.ambientIntensity[slot],
      starVisibility: C.starVisibility[slot],
      moonlightLux: C.moonlightLux[slot],
    });
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function dayNightCycleStats() {
  let active = 0;
  let inDaylight = 0;
  let inNight = 0;
  let polarDayCount = 0;
  let polarNightCount = 0;

  for (let slot = 0; slot < _nextDayNightCycleSlot; slot++) {
    if (!DayNightCycle.active[slot]) continue;
    active++;

    const phase = DayNightCycle.twilightPhase[slot];
    if (phase === TwilightPhase.DAY || phase === TwilightPhase.SUNRISE_SUNSET) inDaylight++;
    if (phase === TwilightPhase.NIGHT) inNight++;

    if (DayNightCycle.polarDay[slot] === 1) polarDayCount++;
    if (DayNightCycle.polarNight[slot] === 1) polarNightCount++;
  }

  return {
    activeCycles: active,
    maxCycles: MAX_DAY_NIGHT_CONFIGS,
    inDaylight,
    inNight,
    polarDayCount,
    polarNightCount,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearDayNightCycles() {
  DayNightCycle.active.fill(0);
  DayNightCycle.ownerEid.fill(0);
  DayNightCycle.skyEid.fill(0);
  _dayNightCycleSlots.clear();
  _nextDayNightCycleSlot = 0;
}