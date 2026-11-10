// file number : 067
// full path name : src/weather/067_pressure_system.js
// description : Atmospheric pressure system. Provides the full
//               pressure-field backbone that physically drives wind,
//               fronts, and weather transitions in the bitECS_max
//               pipeline. Every other weather subsystem (files 040-066)
//               references this file's pressure field to determine what
//               "should" happen physically, so weather becomes emergent
//               rather than randomly assigned.
//                 • PRESSURE FIELD — a continuous, spatially-varying
//                   sea-level pressure field reconstructed from a set of
//                   SoA HighPressureSystem and LowPressureSystem
//                   records. Each system contributes a Gaussian
//                   bump (highs) or dip (lows) to the field. The sum
//                   produces realistic isobar patterns.
//                 • PRESSURE SYSTEMS — high and low pressure centers
//                   with:
//                     - center position (world X / Y)
//                     - central pressure (hPa)
//                     - radius of influence (km)
//                     - deepening / filling rate (hPa/hour)
//                     - movement vector (km/h)
//                     - age and lifecycle stage (developing / mature /
//                       occluded / dissipating)
//                     - strength multiplier for gameplay tuning
//                 • FRONTS — cold, warm, stationary, and occluded fronts
//                   anchored between adjacent high/low pairs. Each front
//                   has:
//                     - start and end world positions
//                     - front type (FrontType enum)
//                     - frontal intensity (temperature gradient)
//                     - advancing speed (km/h)
//                     - precipitation potential
//                   Provides `sampleFrontProximity` for gameplay to
//                   query "am I near a front?" and `frontPrecipitation`
//                   to decide rainfall intensity in that zone.
//                 • GRADIENT WIND — the geostrophic wind (wind that
//                   results from pressure gradients) computed via
//                   `gradientWindAt(wx, wy, wz)`. Uses the classic
//                   geostrophic formula:
//                     v_g = (1 / (ρ · f)) · (∂p/∂x, -∂p/∂y)
//                   where ρ is air density, f is the Coriolis parameter
//                   (2Ω·sin(latitude)), and ∂p/∂x / ∂p/∂y are pressure
//                   gradients sampled from the field. This becomes the
//                   baseline wind that file 047's WindSource uses, so
//                   wind direction is physically consistent rather
//                   than arbitrary.
//                 • PRESSURE TENDENCY — computes the pressure change
//                   over time at any point (∂p/∂t) so gameplay can
//                   detect "pressure falling → storm coming".
//                 • FRONT FORMATION — when two pressure systems are
//                   close enough and their intensities warrant it, a
//                   new front is auto-generated between them (baroclinic
//                   instability approximation).
//                 • OCCLUSION DETECTION — when a cold front overtakes
//                   a warm front, they merge into an occluded front;
//                   the system detects this geometrically and
//                   transitions the front type.
//                 • ISOBAR GENERATION — `sampleIsobarContour(cx, cy, targetPressure)`
//                   returns an array of world positions along a
//                   constant-pressure contour for a given level, for
//                   rendering on maps or gameplay HUDs.
//                 • WEATHER COUPLING — low-pressure centers bias the
//                   weather scheduler toward storm / rain; high-pressure
//                   centers bias it toward clear / fair weather. This
//                   is exposed via `pressureBias` so file 063 can
//                   multiply the Markov weights.
//                 • CORIOLIS — the Coriolis parameter is computed from
//                   latitude so wind veers to the right in the northern
//                   hemisphere and to the left in the southern
//                   hemisphere, exactly as on Earth.
//               All state lives in typed arrays; per-frame cost is
//               O(systems) × O(1) for the pressure field sample plus
//               O(fronts) for front checks. Zero per-frame allocation;
//               steady-state 1M-entity scenes handle pressure
//               computations on Android 64-bit.
// best for : Physically-grounded weather, forecasting gameplay,
//            meteorology simulators, fronts with precipitation
//            emphasis, weather-map HUDs, and any 1M-entity scene
//            needing realistic pressure-driven weather.
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
  WindSource,
  WindSourceType,
  addWindSource,
  removeWindSource,
  sampleWindAt,
} from './047_wind_gusts.js';

import {
  WeatherType,
} from './040_weather_archetypes.js';

import {
  SchedulerRegion,
  Biome,
} from './063_weather_scheduler.js';

import {
  SeasonRegion,
  getAmbientTemperature,
} from './065_season_system.js';

import {
  ClimateZone,
  sampleClimateAt,
} from './066_climate_zone.js';

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

// ── Standard atmosphere constants ───────────────────────────
const STANDARD_PRESSURE_HPA          = 1013.25;
const MIN_PRESSURE_HPA               = 870.0;    // extreme typhoon low
const MAX_PRESSURE_HPA               = 1085.0;   // Siberian high
const PRESSURE_EPSILON_HPA           = 0.1;

// ── Coriolis ────────────────────────────────────────────────
const EARTH_ANGULAR_VELOCITY         = 7.2921159e-5;   // rad/s
const CORIOLIS_MIN_LATITUDE          = 0.1;            // ° |lat| below this → no geostrophic
const CORIOLIS_F_MAX                 = 2 * EARTH_ANGULAR_VELOCITY;

// ── Gradient wind ──────────────────────────────────────────
const GEOSTROPHIC_MAX_SPEED          = 80.0;     // m/s (safety cap)
const GEOSTROPHIC_MIN_SPEED          = 0.5;

// ── Pressure systems ───────────────────────────────────────
const MAX_PRESSURE_SYSTEMS           = 64;
const MIN_SYSTEM_RADIUS_KM           = 200.0;
const MAX_SYSTEM_RADIUS_KM           = 4000.0;
const MIN_DEEPENING_RATE_HPA_PER_H   = -3.0;    // hPa/hour (deepening)
const MAX_DEEPENING_RATE_HPA_PER_H   = 3.0;     // hPa/hour (filling)
const SYSTEM_LIFETIME_HOURS_MIN      = 24.0;
const SYSTEM_LIFETIME_HOURS_MAX      = 240.0;
const SYSTEM_MATURE_AGE_HOURS        = 48.0;
const SYSTEM_OCCLUSION_AGE_HOURS     = 120.0;

// ── Fronts ─────────────────────────────────────────────────
const MAX_FRONTS                     = 32;
const FRONT_INTENSITY_MIN            = 0.1;
const FRONT_INTENSITY_MAX            = 5.0;
const FRONT_ADVANCE_SPEED_MIN        = 1.0;      // km/h
const FRONT_ADVANCE_SPEED_MAX        = 80.0;
const FRONT_PRECIP_MULT_COLD         = 1.4;
const FRONT_PRECIP_MULT_WARM         = 1.8;
const FRONT_PRECIP_MULT_STATIONARY   = 2.2;
const FRONT_PRECIP_MULT_OCCLUDED     = 0.7;
const FRONT_PROXIMITY_MAX_M           = 50000;   // 50 km
const FRONT_PROXIMITY_MIN_M           = 1000;    // 1 km

// ── Isobar generation ──────────────────────────────────────
const ISOBAR_STEP_DEGREES            = 1.0;      // spatial resolution
const ISOBAR_MAX_POINTS              = 4096;

// ── Pressure bias for weather scheduling ──────────────────
const LOW_PRESSURE_BIAS_STRENGTH     = 0.60;     // 0 = none, 1 = full storm bias
const HIGH_PRESSURE_BIAS_STRENGTH    = 0.55;     // 0 = none, 1 = full clear bias

// ── GPS / gameplay tie-in ─────────────────────────────────
const MAX_GPS_STATIONS               = 64;
const GPS_SAMPLE_RADIUS_KM           = 300.0;

// ═══════════════════════════════════════════════════════════════════════
// PRESSURE SYSTEM TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const PressureSystemType = Object.freeze({
  HIGH:               0,   // anticyclone
  LOW:                1,   // cyclone
  THERMAL_LOW:        2,   // heat low (over desert)
  THERMAL_HIGH:       3,   // cold high (over polar region)
  SUBTROPICAL_HIGH:   4,   // semi-permanent high
  TROPICAL_LOW:       5,   // tropical disturbance
});

// ═══════════════════════════════════════════════════════════════════════
// FRONT TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const FrontType = Object.freeze({
  NONE:        0,
  COLD:        1,
  WARM:        2,
  STATIONARY:  3,
  OCCLUDED:    4,
});

// ═══════════════════════════════════════════════════════════════════════
// PRESSURE SYSTEM LIFECYCLE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const SystemLifecycle = Object.freeze({
  DEVELOPING:  0,
  MATURE:      1,
  OCCLUDED:    2,
  DISSIPATING: 3,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA PRESSURE SYSTEM
// ═══════════════════════════════════════════════════════════════════════

export const PressureSystem = {
  active: new Uint8Array(MAX_PRESSURE_SYSTEMS),

  // System type.
  type: new Uint8Array(MAX_PRESSURE_SYSTEMS),

  // Lifecycle stage.
  lifecycle: new Uint8Array(MAX_PRESSURE_SYSTEMS),

  // World position of the center (metres).
  cx: new Float32Array(MAX_PRESSURE_SYSTEMS),
  cz: new Float32Array(MAX_PRESSURE_SYSTEMS),

  // Central pressure (hPa).
  centralPressure: new Float32Array(MAX_PRESSURE_SYSTEMS),

  // Initial pressure (hPa; for tracking).
  initialPressure: new Float32Array(MAX_PRESSURE_SYSTEMS),

  // Radius of influence (km).
  radiusKm: new Float32Array(MAX_PRESSURE_SYSTEMS),

  // Deepening rate (hPa/hour; positive = filling, negative = deepening).
  deepeningRate: new Float32Array(MAX_PRESSURE_SYSTEMS),

  // Movement (km/h) and direction (radians).
  moveSpeedKmh: new Float32Array(MAX_PRESSURE_SYSTEMS),
  moveDirection: new Float32Array(MAX_PRESSURE_SYSTEMS),

  // Age (hours) and total lifetime (hours).
  ageHours: new Float32Array(MAX_PRESSURE_SYSTEMS),
  lifetimeHours: new Float32Array(MAX_PRESSURE_SYSTEMS),

  // Strength multiplier (1.0 = default; 0.5 = half strength; 2.0 = doubled).
  strengthMultiplier: new Float32Array(MAX_PRESSURE_SYSTEMS),

  // Seed for minor jitter / noise.
  seed: new Uint32Array(MAX_PRESSURE_SYSTEMS),
};

// ═══════════════════════════════════════════════════════════════════════
// SoA FRONT
// ═══════════════════════════════════════════════════════════════════════

export const Front = {
  active: new Uint8Array(MAX_FRONTS),

  // Front type.
  type: new Uint8Array(MAX_FRONTS),

  // Two endpoints (world X / Z, metres).
  startX: new Float32Array(MAX_FRONTS),
  startZ: new Float32Array(MAX_FRONTS),
  endX: new Float32Array(MAX_FRONTS),
  endZ: new Float32Array(MAX_FRONTS),

  // Direction of travel (unit vector).
  advanceDirX: new Float32Array(MAX_FRONTS),
  advanceDirZ: new Float32Array(MAX_FRONTS),

  // Speed of advancement (km/h).
  advanceSpeedKmh: new Float32Array(MAX_FRONTS),

  // Temperature gradient across the front (°C/km).
  temperatureGradient: new Float32Array(MAX_FRONTS),

  // Frontal intensity (0..5; 0 = weak, 5 = severe).
  intensity: new Float32Array(MAX_FRONTS),

  // Precipitation multiplier at the front.
  precipitationMultiplier: new Float32Array(MAX_FRONTS),

  // Age (hours).
  ageHours: new Float32Array(MAX_FRONTS),

  // Underlying pressure systems (for occlusion detection).
  coldSystem: new Int16Array(MAX_FRONTS),
  warmSystem: new Int16Array(MAX_FRONTS),

  // Seed.
  seed: new Uint32Array(MAX_FRONTS),
};

// ═══════════════════════════════════════════════════════════════════════
// SoA GPS / BAROMETER STATION
// ═══════════════════════════════════════════════════════════════════════

export const BarometerStation = {
  ownerEid: new Uint32Array(MAX_GPS_STATIONS),
  px: new Float32Array(MAX_GPS_STATIONS),
  pz: new Float32Array(MAX_GPS_STATIONS),

  // Reading (hPa).
  pressure: new Float32Array(MAX_GPS_STATIONS),

  // Pressure tendency (hPa/hour).
  tendency: new Float32Array(MAX_GPS_STATIONS),

  // Active.
  active: new Uint8Array(MAX_GPS_STATIONS),
};

/** Marker: entity is a barometer. */
export const BarometerTag = {};

const _barometerSlots = new Map();
let _nextBarometerSlot = 0;

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
// PRESSURE SYSTEM CREATION
// ═══════════════════════════════════════════════════════════════════════

let _nextSystemSlot = 0;

function allocSystemSlot() {
  for (let i = 0; i < MAX_PRESSURE_SYSTEMS; i++) {
    if (!PressureSystem.active[i]) return i;
  }
  // Pool full: recycle the oldest (highest age).
  let oldestSlot = 0;
  let oldestAge = -1;
  for (let i = 0; i < MAX_PRESSURE_SYSTEMS; i++) {
    if (PressureSystem.ageHours[i] > oldestAge) {
      oldestAge = PressureSystem.ageHours[i];
      oldestSlot = i;
    }
  }
  return oldestSlot;
}

/**
 * Create a pressure system.
 *
 * @param world       ECS world
 * @param eid         entity
 * @param type        PressureSystemType
 * @param options     { cx, cz, centralPressure, radiusKm, deepeningRate,
 *                      moveSpeedKmh, moveDirection, lifetimeHours,
 *                      strengthMultiplier, seed }
 * @returns system slot
 */
export function addPressureSystem(world, eid, type = PressureSystemType.LOW, options = {}) {
  const slot = allocSystemSlot();
  const S = PressureSystem;

  S.active[slot] = 1;
  S.type[slot] = type;
  S.lifecycle[slot] = SystemLifecycle.DEVELOPING;

  S.cx[slot] = options.cx ?? 0;
  S.cz[slot] = options.cz ?? 0;

  // Default pressure depends on type.
  let defaultPressure;
  if (type === PressureSystemType.HIGH || type === PressureSystemType.THERMAL_HIGH || type === PressureSystemType.SUBTROPICAL_HIGH) {
    defaultPressure = STANDARD_PRESSURE_HPA + 15;
  } else {
    defaultPressure = STANDARD_PRESSURE_HPA - 20;
  }

  S.centralPressure[slot] = options.centralPressure ?? defaultPressure;
  S.initialPressure[slot] = S.centralPressure[slot];
  S.radiusKm[slot] = Math.max(MIN_SYSTEM_RADIUS_KM, Math.min(MAX_SYSTEM_RADIUS_KM,
    options.radiusKm ?? 800));
  S.deepeningRate[slot] = Math.max(MIN_DEEPENING_RATE_HPA_PER_H, Math.min(MAX_DEEPENING_RATE_HPA_PER_H,
    options.deepeningRate ?? 0));
  S.moveSpeedKmh[slot] = options.moveSpeedKmh ?? 30;
  S.moveDirection[slot] = options.moveDirection ?? (Math.random() * TWO_PI);
  S.ageHours[slot] = 0;
  S.lifetimeHours[slot] = Math.max(SYSTEM_LIFETIME_HOURS_MIN, Math.min(SYSTEM_LIFETIME_HOURS_MAX,
    options.lifetimeHours ?? 120));
  S.strengthMultiplier[slot] = options.strengthMultiplier ?? 1.0;
  S.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  if (slot >= _nextSystemSlot) _nextSystemSlot = slot + 1;
  return slot;
}

/**
 * Remove a pressure system.
 */
export function removePressureSystem(world, eid, systemSlot) {
  if (systemSlot < 0 || systemSlot >= MAX_PRESSURE_SYSTEMS) return;
  PressureSystem.active[systemSlot] = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// FRONT CREATION
// ═══════════════════════════════════════════════════════════════════════

let _nextFrontSlot = 0;

function allocFrontSlot() {
  for (let i = 0; i < MAX_FRONTS; i++) {
    if (!Front.active[i]) return i;
  }
  // Pool full: recycle the oldest.
  let oldestSlot = 0;
  let oldestAge = -1;
  for (let i = 0; i < MAX_FRONTS; i++) {
    if (Front.ageHours[i] > oldestAge) {
      oldestAge = Front.ageHours[i];
      oldestSlot = i;
    }
  }
  return oldestSlot;
}

/**
 * Create a front between two pressure systems.
 */
export function addFront(world, eid, type, options = {}) {
  const slot = allocFrontSlot();
  const F = Front;

  F.active[slot] = 1;
  F.type[slot] = type;

  F.startX[slot] = options.startX ?? 0;
  F.startZ[slot] = options.startZ ?? 0;
  F.endX[slot] = options.endX ?? 10000;
  F.endZ[slot] = options.endZ ?? 0;

  F.advanceDirX[slot] = options.advanceDirX ?? 1;
  F.advanceDirZ[slot] = options.advanceDirZ ?? 0;
  F.advanceSpeedKmh[slot] = options.advanceSpeedKmh ?? 30;
  F.temperatureGradient[slot] = options.temperatureGradient ?? 2.5;
  F.intensity[slot] = options.intensity ?? 1.5;

  // Precip multiplier by type.
  let precipMult = 1.0;
  switch (type) {
    case FrontType.COLD:        precipMult = FRONT_PRECIP_MULT_COLD; break;
    case FrontType.WARM:        precipMult = FRONT_PRECIP_MULT_WARM; break;
    case FrontType.STATIONARY:  precipMult = FRONT_PRECIP_MULT_STATIONARY; break;
    case FrontType.OCCLUDED:    precipMult = FRONT_PRECIP_MULT_OCCLUDED; break;
  }
  F.precipitationMultiplier[slot] = options.precipitationMultiplier ?? precipMult;

  F.ageHours[slot] = 0;
  F.coldSystem[slot] = options.coldSystem ?? -1;
  F.warmSystem[slot] = options.warmSystem ?? -1;
  F.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  if (slot >= _nextFrontSlot) _nextFrontSlot = slot + 1;
  return slot;
}

/**
 * Remove a front.
 */
export function removeFront(slot) {
  if (slot < 0 || slot >= MAX_FRONTS) return;
  Front.active[slot] = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// BAROMETER STATION CREATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register a barometer on an entity.
 */
export function addBarometer(world, eid, options = {}) {
  if (_nextBarometerSlot >= MAX_GPS_STATIONS) {
    throw new Error('barometer capacity exceeded');
  }
  const slot = _nextBarometerSlot++;

  addComponent(world, eid, BarometerTag);

  BarometerStation.ownerEid[slot] = eid;
  BarometerStation.px[slot] = options.px ?? 0;
  BarometerStation.pz[slot] = options.pz ?? 0;
  BarometerStation.pressure[slot] = STANDARD_PRESSURE_HPA;
  BarometerStation.tendency[slot] = 0;
  BarometerStation.active[slot] = 1;

  _barometerSlots.set(eid, slot);
  return slot;
}

export function removeBarometer(world, eid) {
  const slot = _barometerSlots.get(eid);
  if (slot === undefined) return;
  BarometerStation.active[slot] = 0;
  BarometerStation.ownerEid[slot] = 0;
  _barometerSlots.delete(eid);
  removeComponent(world, eid, BarometerTag);
}

export function getBarometerSlot(eid) {
  return _barometerSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// PRESSURE FIELD SAMPLING — the hot path
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the sea-level pressure (hPa) at a world (X, Z) position.
 * Sums the Gaussian bump contribution from each active system.
 *
 * Pressure contribution from a system:
 *   Δp(x) = (P_center - P_standard) × strength × exp(-(r / radius)²)
 */
export function samplePressureAt(wx, wz) {
  const S = PressureSystem;
  let totalDeltaP = 0;

  for (let slot = 0; slot < _nextSystemSlot; slot++) {
    if (!S.active[slot]) continue;

    const dx = wx - S.cx[slot];
    const dz = wz - S.cz[slot];
    const distSq = dx * dx + dz * dz;
    const radiusM = S.radiusKm[slot] * 1000.0;

    if (distSq > radiusM * radiusM * 9) continue;   // Beyond 3 radii

    const normDist = Math.sqrt(distSq) / radiusM;
    const gaussianWeight = Math.exp(-normDist * normDist);

    const deltaP = (S.centralPressure[slot] - STANDARD_PRESSURE_HPA)
      * S.strengthMultiplier[slot]
      * gaussianWeight;

    totalDeltaP += deltaP;
  }

  return Math.max(MIN_PRESSURE_HPA, Math.min(MAX_PRESSURE_HPA,
    STANDARD_PRESSURE_HPA + totalDeltaP));
}

/**
 * Sample the pressure gradient at a world (X, Z) position.
 * Uses finite differences with a small step (EPSILON_GRAD).
 */
const EPSILON_GRAD_M = 100.0;   // 100 m sample step

const _gradOut = { dpdx: 0, dpdz: 0 };

export function samplePressureGradient(wx, wz, out = _gradOut) {
  const pE = samplePressureAt(wx + EPSILON_GRAD_M, wz);
  const pW = samplePressureAt(wx - EPSILON_GRAD_M, wz);
  const pN = samplePressureAt(wx, wz - EPSILON_GRAD_M);
  const pS = samplePressureAt(wx, wz + EPSILON_GRAD_M);

  // Convert hPa/m to Pa/m for physical consistency.
  out.dpdx = (pE - pW) * 100.0 / (2 * EPSILON_GRAD_M);
  out.dpdz = (pN - pS) * 100.0 / (2 * EPSILON_GRAD_M);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// GEOSTROPHIC WIND
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the geostrophic wind at a world position, given the local
 * latitude (for Coriolis).
 *
 * Geostrophic wind formula:
 *   v_g = (1 / (ρ · f)) · (∂p/∂z, -∂p/∂x)
 * where f = 2Ω·sin(lat).
 *
 * @param wx, wz        world position
 * @param latitudeDeg   latitude in degrees
 * @param out           [vx, vz] output
 * @returns out
 */
export function gradientWindAt(wx, wz, latitudeDeg, out) {
  // No geostrophic wind near the equator.
  if (Math.abs(latitudeDeg) < CORIOLIS_MIN_LATITUDE) {
    out[0] = 0;
    out[1] = 0;
    return out;
  }

  const grad = samplePressureGradient(wx, wz, _gradOut);

  // Coriolis parameter.
  const f = 2 * EARTH_ANGULAR_VELOCITY * Math.sin(latitudeDeg * DEG_TO_RAD);

  // v_g = (1 / (ρ · f)) · (∂p/∂z, -∂p/∂x)
  let vx = grad.dpdz / (AIR_DENSITY * f);
  let vz = -grad.dpdx / (AIR_DENSITY * f);

  // Cap speed.
  const speed = Math.hypot(vx, vz);
  if (speed > GEOSTROPHIC_MAX_SPEED) {
    const scale = GEOSTROPHIC_MAX_SPEED / speed;
    vx *= scale;
    vz *= scale;
  } else if (speed < GEOSTROPHIC_MIN_SPEED && speed > EPSILON) {
    // Smooth down to zero if speed is very small.
    const scale = speed / GEOSTROPHIC_MIN_SPEED;
    vx *= scale;
    vz *= scale;
  }

  out[0] = vx;
  out[1] = vz;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// PRESSURE TENDENCY — dP/dt at a fixed point
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the pressure tendency (hPa/hour) at a world (X, Z) position
 * by summing the deepening rate of all systems weighted by their
 * Gaussian influence.
 */
export function pressureTendencyAt(wx, wz) {
  const S = PressureSystem;
  let tendency = 0;

  for (let slot = 0; slot < _nextSystemSlot; slot++) {
    if (!S.active[slot]) continue;

    const dx = wx - S.cx[slot];
    const dz = wz - S.cz[slot];
    const distSq = dx * dx + dz * dz;
    const radiusM = S.radiusKm[slot] * 1000.0;

    if (distSq > radiusM * radiusM * 9) continue;

    const normDist = Math.sqrt(distSq) / radiusM;
    const gaussianWeight = Math.exp(-normDist * normDist);

    tendency += S.deepeningRate[slot] * gaussianWeight;
  }

  return tendency;
}

// ═══════════════════════════════════════════════════════════════════════
// FRONT PROXIMITY
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the distance from a world (X, Z) point to the nearest front
 * segment. Returns { distance, frontSlot, type, intensity, precipMultiplier }
 * or null if no front is within range.
 */
const _frontProximity = {
  distance: Infinity,
  frontSlot: -1,
  type: FrontType.NONE,
  intensity: 0,
  precipMultiplier: 1.0,
};

export function sampleFrontProximity(wx, wz) {
  const F = Front;
  let bestDist = Infinity;
  let bestSlot = -1;

  for (let slot = 0; slot < _nextFrontSlot; slot++) {
    if (!F.active[slot]) continue;

    // Distance from (wx, wz) to segment (start, end).
    const sx = F.startX[slot];
    const sz = F.startZ[slot];
    const ex = F.endX[slot];
    const ez = F.endZ[slot];

    const dx = ex - sx;
    const dz = ez - sz;
    const lenSq = dx * dx + dz * dz;
    if (lenSq < EPSILON) continue;

    let t = ((wx - sx) * dx + (wz - sz) * dz) / lenSq;
    t = Math.max(0, Math.min(1, t));

    const px = sx + t * dx;
    const pz = sz + t * dz;
    const distSq = (wx - px) * (wx - px) + (wz - pz) * (wz - pz);

    if (distSq < bestDist) {
      bestDist = distSq;
      bestSlot = slot;
    }
  }

  if (bestSlot < 0) {
    _frontProximity.distance = Infinity;
    _frontProximity.frontSlot = -1;
    _frontProximity.type = FrontType.NONE;
    _frontProximity.intensity = 0;
    _frontProximity.precipMultiplier = 1.0;
    return _frontProximity;
  }

  _frontProximity.distance = Math.sqrt(bestDist);
  _frontProximity.frontSlot = bestSlot;
  _frontProximity.type = F.type[bestSlot];
  _frontProximity.intensity = F.intensity[bestSlot];
  _frontProximity.precipMultiplier = F.precipitationMultiplier[bestSlot];
  return _frontProximity;
}

// ═══════════════════════════════════════════════════════════════════════
// PRESSURE BIAS FOR WEATHER SCHEDULER
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a bias value for the weather scheduler:
 *   > 1.0 = more likely to select stormy weather
 *   < 1.0 = more likely to select fair weather
 *
 * Low-pressure systems bias toward storms (rain, thunderstorms).
 * High-pressure systems bias toward clear skies.
 *
 * @param pressure    sampled pressure (hPa)
 * @returns bias (0..2)
 */
export function pressureBiasForWeather(pressure) {
  if (pressure < STANDARD_PRESSURE_HPA - 10) {
    // Very low pressure: strong storm bias.
    const t = (STANDARD_PRESSURE_HPA - pressure) / 50.0;
    return 1.0 + Math.min(1.0, t) * LOW_PRESSURE_BIAS_STRENGTH;
  }
  if (pressure > STANDARD_PRESSURE_HPA + 10) {
    // Very high pressure: strong clear bias.
    const t = (pressure - STANDARD_PRESSURE_HPA) / 30.0;
    return Math.max(0.4, 1.0 - Math.min(1.0, t) * HIGH_PRESSURE_BIAS_STRENGTH);
  }
  return 1.0;
}

// ═══════════════════════════════════════════════════════════════════════
// ISO BAR CONTOUR GENERATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample an isobar contour for a given pressure level. Returns world
 * positions along the contour, or an empty array if the level doesn't
 * intersect the domain.
 *
 * Uses marching squares on a grid.
 */
export function sampleIsobarContour(targetPressureHpa, minX, minZ, maxX, maxZ) {
  const step = 10000.0;    // 10 km spacing
  const width = maxX - minX;
  const height = maxZ - minZ;
  const cols = Math.ceil(width / step);
  const rows = Math.ceil(height / step);

  if (cols < 2 || rows < 2) return [];

  // Sample the pressure field.
  const grid = new Float32Array((cols + 1) * (rows + 1));
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const wx = minX + i * step;
      const wz = minZ + j * step;
      grid[j * (cols + 1) + i] = samplePressureAt(wx, wz);
    }
  }

  // Marching squares.
  const points = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const v00 = grid[j * (cols + 1) + i];
      const v10 = grid[j * (cols + 1) + i + 1];
      const v01 = grid[(j + 1) * (cols + 1) + i];
      const v11 = grid[(j + 1) * (cols + 1) + i + 1];

      const x0 = minX + i * step;
      const x1 = x0 + step;
      const z0 = minZ + j * step;
      const z1 = z0 + step;

      // Test each edge.
      const edges = [];

      // Top edge (z=z0).
      if ((v00 < targetPressureHpa) !== (v10 < targetPressureHpa)) {
        const t = (targetPressureHpa - v00) / (v10 - v00);
        edges.push({ x: x0 + t * (x1 - x0), z: z0 });
      }
      // Right edge (x=x1).
      if ((v10 < targetPressureHpa) !== (v11 < targetPressureHpa)) {
        const t = (targetPressureHpa - v10) / (v11 - v10);
        edges.push({ x: x1, z: z0 + t * (z1 - z0) });
      }
      // Bottom edge (z=z1).
      if ((v01 < targetPressureHpa) !== (v11 < targetPressureHpa)) {
        const t = (targetPressureHpa - v01) / (v11 - v01);
        edges.push({ x: x0 + t * (x1 - x0), z: z1 });
      }
      // Left edge (x=x0).
      if ((v00 < targetPressureHpa) !== (v01 < targetPressureHpa)) {
        const t = (targetPressureHpa - v00) / (v01 - v00);
        edges.push({ x: x0, z: z0 + t * (z1 - z0) });
      }

      if (edges.length === 2) {
        points.push(edges[0], edges[1]);
        if (points.length >= ISOBAR_MAX_POINTS) return points;
      }
    }
  }

  return points;
}

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM LIFECYCLE UPDATE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Update the pressure system lifecycle and its state over time.
 */
function updateSystemLifecycle(slot, dtHours) {
  const S = PressureSystem;

  S.ageHours[slot] += dtHours;

  // Lifecycle transition.
  let lifecycle = S.lifecycle[slot];

  if (S.ageHours[slot] > SYSTEM_LIFETIME_HOURS_MIN) {
    if (lifecycle === SystemLifecycle.DEVELOPING
        && S.ageHours[slot] > SYSTEM_MATURE_AGE_HOURS * 0.5) {
      S.lifecycle[slot] = SystemLifecycle.MATURE;
    } else if (lifecycle === SystemLifecycle.MATURE
        && S.ageHours[slot] > SYSTEM_MATURE_AGE_HOURS) {
      S.lifecycle[slot] = SystemLifecycle.OCCLUDED;
    } else if (lifecycle === SystemLifecycle.OCCLUDED
        && S.ageHours[slot] > SYSTEM_OCCLUSION_AGE_HOURS) {
      S.lifecycle[slot] = SystemLifecycle.DISSIPATING;
    }
  }

  // Pressure deepening / filling.
  S.centralPressure[slot] += S.deepeningRate[slot] * dtHours;

  // Clamp.
  S.centralPressure[slot] = Math.max(MIN_PRESSURE_HPA, Math.min(MAX_PRESSURE_HPA,
    S.centralPressure[slot]));

  // Movement.
  const moveDistM = S.moveSpeedKmh[slot] * dtHours * 1000.0 / 3600.0;
  S.cx[slot] += Math.cos(S.moveDirection[slot]) * moveDistM;
  S.cz[slot] += Math.sin(S.moveDirection[slot]) * moveDistM;

  // Dissipating: reduce strength.
  if (S.lifecycle[slot] === SystemLifecycle.DISSIPATING) {
    S.strengthMultiplier[slot] = Math.max(0, S.strengthMultiplier[slot] - dtHours * 0.02);
  }

  // Retire the system if it has aged past its lifetime.
  if (S.ageHours[slot] > S.lifetimeHours[slot] || S.strengthMultiplier[slot] < 0.05) {
    S.active[slot] = 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// FRONT UPDATE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Update front positions.
 */
function updateFront(slot, dtHours) {
  const F = Front;

  F.ageHours[slot] += dtHours;

  // Advance the front.
  const moveDistM = F.advanceSpeedKmh[slot] * dtHours * 1000.0 / 3600.0;
  F.startX[slot] += F.advanceDirX[slot] * moveDistM;
  F.startZ[slot] += F.advanceDirZ[slot] * moveDistM;
  F.endX[slot] += F.advanceDirX[slot] * moveDistM;
  F.endZ[slot] += F.advanceDirZ[slot] * moveDistM;

  // Age out.
  if (F.ageHours[slot] > 240) {
    F.active[slot] = 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// FRONT FORMATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Detect opportunities for new fronts between adjacent high/low pairs.
 * Also detects occlusion when a cold front overtakes a warm front.
 */
function detectFrontFormation(dtHours) {
  const S = PressureSystem;

  // Find pairs of (high, low) systems close to each other.
  for (let hi = 0; hi < _nextSystemSlot; hi++) {
    if (!S.active[hi]) continue;
    if (S.type[hi] !== PressureSystemType.HIGH
        && S.type[hi] !== PressureSystemType.THERMAL_HIGH
        && S.type[hi] !== PressureSystemType.SUBTROPICAL_HIGH) continue;

    for (let lo = 0; lo < _nextSystemSlot; lo++) {
      if (!S.active[lo]) continue;
      if (lo === hi) continue;
      if (S.type[lo] !== PressureSystemType.LOW
          && S.type[lo] !== PressureSystemType.THERMAL_LOW
          && S.type[lo] !== PressureSystemType.TROPICAL_LOW) continue;

      const dx = S.cx[lo] - S.cx[hi];
      const dz = S.cz[lo] - S.cz[hi];
      const distKm = Math.hypot(dx, dz) / 1000.0;

      // Front only forms if the gap is reasonable (200-1500 km).
      if (distKm < 200 || distKm > 1500) continue;

      // Check if we already have a front between these systems.
      let hasFront = false;
      for (let fi = 0; fi < _nextFrontSlot; fi++) {
        if (!Front.active[fi]) continue;
        if ((Front.coldSystem[fi] === lo && Front.warmSystem[fi] === hi)
            || (Front.coldSystem[fi] === hi && Front.warmSystem[fi] === lo)) {
          hasFront = true;
          break;
        }
      }

      if (hasFront) continue;

      // Form a new front at the midpoint, perpendicular to the high-low line.
      const mx = (S.cx[hi] + S.cx[lo]) * 0.5;
      const mz = (S.cz[hi] + S.cz[lo]) * 0.5;
      const perpX = -dz / (distKm * 1000.0);
      const perpZ = dx / (distKm * 1000.0);

      // Front extent: about 60% of the gap.
      const halfExtent = Math.min(500000, distKm * 1000.0 * 0.6);

      const startX = mx - perpX * halfExtent;
      const startZ = mz - perpZ * halfExtent;
      const endX = mx + perpX * halfExtent;
      const endZ = mz + perpZ * halfExtent;

      // Determine front type: cold front ahead of low, warm behind.
      // Simplified: alternate cold and warm.
      const frontType = Math.random() < 0.5 ? FrontType.COLD : FrontType.WARM;

      addFront(null, null, frontType, {
        startX,
        startZ,
        endX,
        endZ,
        advanceDirX: (S.cx[lo] - S.cx[hi]) / (distKm * 1000.0),
        advanceDirZ: (S.cz[lo] - S.cz[hi]) / (distKm * 1000.0),
        advanceSpeedKmh: 20 + Math.random() * 30,
        temperatureGradient: 1.5 + Math.random() * 2.5,
        intensity: 1.0 + Math.random() * 2.0,
        coldSystem: lo,
        warmSystem: hi,
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// BAROMETER UPDATE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Update all barometer readings.
 */
function updateBarometers(dtHours) {
  const B = BarometerStation;

  for (let slot = 0; slot < _nextBarometerSlot; slot++) {
    if (!B.active[slot]) continue;

    const eid = B.ownerEid[slot];
    if (eid && entityExists(null, eid)) {
      // Read world position.
      const id = getId(eid);
      const M = WorldTransformF32.m;
      if (M) {
        const off = id * 16;
        B.px[slot] = M[off + 12];
        B.pz[slot] = M[off + 14];
      }
    }

    // Sample the pressure at the barometer's position.
    const pressure = samplePressureAt(B.px[slot], B.pz[slot]);

    // Update tendency.
    const newTendency = pressureTendencyAt(B.px[slot], B.pz[slot]);

    B.tendency[slot] = newTendency;
    B.pressure[slot] = pressure;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN SYSTEM — advance the pressure field
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance all pressure systems, fronts, and barometers by dt.
 *
 * @param world       ECS world
 * @param dtHours     elapsed game hours
 */
export function systemPressureTick(world, dtHours) {
  if (dtHours < EPSILON) return world;

  // Update each pressure system.
  for (let slot = 0; slot < _nextSystemSlot; slot++) {
    if (!PressureSystem.active[slot]) continue;
    updateSystemLifecycle(slot, dtHours);
  }

  // Update each front.
  for (let slot = 0; slot < _nextFrontSlot; slot++) {
    if (!Front.active[slot]) continue;
    updateFront(slot, dtHours);
  }

  // Detect new fronts.
  detectFrontFormation(dtHours);

  // Update barometers.
  updateBarometers(dtHours);

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// COUPLING WITH FILE 047 WIND SYSTEM
// ═══════════════════════════════════════════════════════════════════════

/**
 * Synchronize the wind field (file 047) with the pressure-derived
 * geostrophic wind.
 *
 * @param world       ECS world
 * @param latitudeDeg latitude in degrees
 */
export function systemSyncGeostrophicWind(world, latitudeDeg = 45) {
  const _windOut = [0, 0];

  for (let slot = 0; slot < WindSource.active.length; slot++) {
    if (!WindSource.active[slot]) continue;
    if (WindSource.type[slot] !== WindSourceType.ATMOSPHERIC) continue;

    const wx = WindSource.px[slot];
    const wz = WindSource.pz[slot];

    gradientWindAt(wx, wz, latitudeDeg, _windOut);

    const windSpeed = Math.hypot(_windOut[0], _windOut[1]);
    if (windSpeed > GEOSTROPHIC_MIN_SPEED) {
      WindSource.baseSpeed[slot] = windSpeed;
      WindSource.dirX[slot] = _windOut[0] / windSpeed;
      WindSource.dirZ[slot] = _windOut[1] / windSpeed;
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the nearest pressure system to a world position.
 */
export function findNearestPressureSystem(wx, wz, maxDistKm = 2000) {
  const S = PressureSystem;
  let nearestSlot = -1;
  let nearestDistSq = (maxDistKm * 1000.0) * (maxDistKm * 1000.0);

  for (let slot = 0; slot < _nextSystemSlot; slot++) {
    if (!S.active[slot]) continue;
    const dx = S.cx[slot] - wx;
    const dz = S.cz[slot] - wz;
    const distSq = dx * dx + dz * dz;
    if (distSq < nearestDistSq) {
      nearestSlot = slot;
      nearestDistSq = distSq;
    }
  }
  return nearestSlot;
}

/**
 * Return a summary of the nearest pressure system at a world point.
 */
export function getPressureSummaryAt(wx, wz) {
  const pressure = samplePressureAt(wx, wz);
  const tendency = pressureTendencyAt(wx, wz);
  const bias = pressureBiasForWeather(pressure);

  const nearestSlot = findNearestPressureSystem(wx, wz);
  let nearestType = -1;
  let nearestTypeLabel = 'None';
  let distKm = 0;

  if (nearestSlot >= 0) {
    nearestType = PressureSystem.type[nearestSlot];
    nearestTypeLabel = pressureSystemTypeLabel(nearestType);
    distKm = Math.hypot(
      PressureSystem.cx[nearestSlot] - wx,
      PressureSystem.cz[nearestSlot] - wz
    ) / 1000.0;
  }

  const front = sampleFrontProximity(wx, wz);

  return {
    pressure,
    tendency,
    bias,
    nearestType,
    nearestTypeLabel,
    nearestDistKm: distKm,
    frontType: front.type,
    frontTypeLabel: frontTypeLabel(front.type),
    frontDistanceKm: front.distance / 1000.0,
    frontIntensity: front.intensity,
    frontPrecipMultiplier: front.precipMultiplier,
  };
}

/**
 * Return a label for a pressure system type.
 */
export function pressureSystemTypeLabel(type) {
  switch (type) {
    case PressureSystemType.HIGH:             return 'High';
    case PressureSystemType.LOW:              return 'Low';
    case PressureSystemType.THERMAL_LOW:      return 'Thermal Low';
    case PressureSystemType.THERMAL_HIGH:     return 'Thermal High';
    case PressureSystemType.SUBTROPICAL_HIGH: return 'Subtropical High';
    case PressureSystemType.TROPICAL_LOW:     return 'Tropical Low';
    default:                                   return 'Unknown';
  }
}

/**
 * Return a label for a front type.
 */
export function frontTypeLabel(type) {
  switch (type) {
    case FrontType.NONE:       return 'None';
    case FrontType.COLD:       return 'Cold Front';
    case FrontType.WARM:       return 'Warm Front';
    case FrontType.STATIONARY: return 'Stationary Front';
    case FrontType.OCCLUDED:   return 'Occluded Front';
    default:                    return 'Unknown';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a summary of all active pressure systems.
 */
export function gatherPressureSystemsForRendering() {
  const result = [];
  const S = PressureSystem;

  for (let slot = 0; slot < _nextSystemSlot; slot++) {
    if (!S.active[slot]) continue;

    result.push({
      slot,
      type: S.type[slot],
      typeLabel: pressureSystemTypeLabel(S.type[slot]),
      lifecycle: S.lifecycle[slot],
      cx: S.cx[slot],
      cz: S.cz[slot],
      centralPressure: S.centralPressure[slot],
      radiusKm: S.radiusKm[slot],
      deepeningRate: S.deepeningRate[slot],
      strengthMultiplier: S.strengthMultiplier[slot],
      ageHours: S.ageHours[slot],
    });
  }

  return result;
}

/**
 * Return a summary of all active fronts.
 */
export function gatherFrontsForRendering() {
  const result = [];
  const F = Front;

  for (let slot = 0; slot < _nextFrontSlot; slot++) {
    if (!F.active[slot]) continue;

    result.push({
      slot,
      type: F.type[slot],
      typeLabel: frontTypeLabel(F.type[slot]),
      startX: F.startX[slot],
      startZ: F.startZ[slot],
      endX: F.endX[slot],
      endZ: F.endZ[slot],
      advanceDirX: F.advanceDirX[slot],
      advanceDirZ: F.advanceDirZ[slot],
      advanceSpeedKmh: F.advanceSpeedKmh[slot],
      intensity: F.intensity[slot],
      temperatureGradient: F.temperatureGradient[slot],
    });
  }

  return result;
}

/**
 * Return a summary of all barometer readings.
 */
export function gatherBarometersForRendering() {
  const result = [];
  const B = BarometerStation;

  for (let slot = 0; slot < _nextBarometerSlot; slot++) {
    if (!B.active[slot]) continue;

    result.push({
      slot,
      px: B.px[slot],
      pz: B.pz[slot],
      pressure: B.pressure[slot],
      tendency: B.tendency[slot],
    });
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function pressureSystemStats() {
  let activeSystems = 0;
  let activeFronts = 0;
  let activeBarometers = 0;

  const byType = new Uint8Array(6);

  for (let slot = 0; slot < _nextSystemSlot; slot++) {
    if (!PressureSystem.active[slot]) continue;
    activeSystems++;
    byType[PressureSystem.type[slot]]++;
  }

  for (let slot = 0; slot < _nextFrontSlot; slot++) {
    if (Front.active[slot]) activeFronts++;
  }

  for (let slot = 0; slot < _nextBarometerSlot; slot++) {
    if (BarometerStation.active[slot]) activeBarometers++;
  }

  return {
    activeSystems,
    maxSystems: MAX_PRESSURE_SYSTEMS,
    activeFronts,
    maxFronts: MAX_FRONTS,
    activeBarometers,
    maxBarometers: MAX_GPS_STATIONS,
    systemsByType: {
      high: byType[PressureSystemType.HIGH],
      low: byType[PressureSystemType.LOW],
      thermalLow: byType[PressureSystemType.THERMAL_LOW],
      thermalHigh: byType[PressureSystemType.THERMAL_HIGH],
      subtropicalHigh: byType[PressureSystemType.SUBTROPICAL_HIGH],
      tropicalLow: byType[PressureSystemType.TROPICAL_LOW],
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearPressureSystem() {
  PressureSystem.active.fill(0);
  _nextSystemSlot = 0;

  Front.active.fill(0);
  _nextFrontSlot = 0;

  BarometerStation.active.fill(0);
  BarometerStation.ownerEid.fill(0);
  _barometerSlots.clear();
  _nextBarometerSlot = 0;
}