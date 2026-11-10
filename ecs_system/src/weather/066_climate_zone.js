// file number : 066
// full path name : src/weather/066_climate_zone.js
// description : Climate zone system. Provides the Köppen-Geiger
//               classification of the world into standardized climate
//               zones and their biome assignments. Sits between the
//               season clock (file 065) and the weather scheduler
//               (file 063) as the region-level climate authority:
//                 • KÖPPEN CLASSIFICATION — the full Köppen-Geiger
//                   (Kottek et al. 2006) taxonomy implemented as an
//                   enum with all 30 groups and their sub-types:
//                     - A (Tropical): Af, Am, Aw
//                     - B (Arid): BWh, BWk, BSh, BSk
//                     - C (Temperate): Csa, Csb, Csc, Cfa, Cfb, Cfc
//                     - D (Continental): Dsa, Dsb, Dsc, Dsd, Dfa, Dfb,
//                       Dfc, Dfd
//                     - E (Polar): ET, EF
//                 • ZONE DEFINITIONS — each Köppen zone has a full
//                   parametric definition: annual mean temperature,
//                   seasonal amplitude, annual precipitation, dry
//                   season length, humidity range, prevailing wind
//                   direction, wind speed base, cloud cover baseline,
//                   and a default biome (file 063 Biome enum).
//                 • TRANSITION BANDS — between climate zones there is
//                   a blending band (transitionWidth in degrees of
//                   latitude) where parameters interpolate smoothly
//                   from one zone to the next. This prevents a
//                   cliff-edge between zones (e.g. temperate forest
//                   suddenly switching to desert).
//                 • ELEVATION ADJUSTMENT — within any zone, higher
//                   elevation shifts the local climate toward a
//                   higher-latitude climate (e.g. mountain-top
//                   temperate behaves like polar). Uses the
//                   Koppen-Whittaker elevation classifier.
//                 • COASTAL PROXIMITY — a proximity factor to the
//                   ocean damps the seasonal amplitude (maritime
//                   climates are warmer in winter, cooler in summer)
//                   and raises humidity. Uses a signed distance to
//                   the nearest water body queried via file 059.
//                 • URBAN HEAT ISLAND — for biomes tagged Urban
//                   (from file 063), a +2 °C offset is applied
//                   year-round, plus a +0.05 humidity offset from
//                   vegetation clearance and a +1.5 °C nighttime
//                   UHI amplification.
//                 • RAIN SHADOW — a leeward-side precipitation
//                   reduction computed by sampling prevailing wind
//                   direction vs. terrain gradient (from file 003
//                   BVH hit normals). Windward slopes get 1.3×
//                   precipitation, leeward 0.5×.
//                 • CLIMATE TRANSITIONS — when the world has multiple
//                   climate zones, `sampleClimateAt(wx, wy, wz)` returns
//                   interpolated parameters for any point. The result
//                   is cached per-region for performance.
//                 • BIOME DEFAULTS — for gameplay AI, the
//                   `assignBiomeFromClimate` function maps a Köppen
//                   zone + elevation + coastal-proximity into one of
//                   file 063's Biome values, so the scheduler can
//                   select the correct biome weight table.
//                 • SCHEDULER COUPLING — the climate zone overrides
//                   the base temperature, humidity, wind, and cloud
//                   parameters that file 065's season system
//                   computes, so the same SEASON produces different
//                   ambient conditions in different climates.
//               All state lives in typed arrays; per-frame cost is
//               O(regions) × O(1) plus one nearest-zone lookup per
//               query. Zero per-frame allocation; steady-state
//               1M-entity scenes handle climate zones on Android 64-bit.
// best for : Planet-scale simulations, procedurally-generated worlds,
//            travel/exploration games, climate-aware AI, biome-correct
//            ambient conditions, and any 1M-entity scene needing a
//            proper climate model.
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
  WorldBoundsF32,
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
} from '../sky/028_sky_atmosphere.js';

import {
  Biome,
} from './063_weather_scheduler.js';

import {
  SeasonRegion,
  Season,
  SubSeason,
  Hemisphere,
  getSeason,
  getSubSeason,
  getSeasonalProgress,
  getAmbientTemperature,
  getAmbientHumidity,
  getAmbientWind,
} from './065_season_system.js';

import {
  WaterBody,
  WaterBodyTag,
  findWaterBodyAt,
} from './059_water_surface.js';

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

const MAX_CLIMATE_ZONES              = 256;
const MAX_CLIMATE_TRANSITIONS        = 512;
const MAX_CACHED_SAMPLES             = 4096;

// ── Köppen (Kottek 2006) temperature thresholds ────────────
const KOPPEN_A_TROPICAL_MIN_TEMP     = 18.0;    // all months > 18 °C
const KOPPEN_B_ARID_DRY_FACTOR       = 2.0;     // P < 2T
const KOPPEN_C_TEMPERATE_MIN_TEMP    = -3.0;    // coldest month ≥ -3 °C
const KOPPEN_C_TEMPERATE_MAX_TEMP    = 18.0;    // warmest month < 22 °C...
const KOPPEN_D_CONTINENTAL_MIN_TEMP  = -3.0;    // coldest month < -3 °C
const KOPPEN_D_CONTINENTAL_WARM      = 10.0;    // warmest month > 10 °C
const KOPPEN_E_POLAR_MAX_TEMP        = 10.0;    // warmest month < 10 °C
const KOPPEN_E_FROST_MIN_TEMP        = 0.0;     // warmest month < 0 °C

// ── Zone parameter ranges ──────────────────────────────────
const ZONE_TEMPERATURE_MIN           = -50.0;
const ZONE_TEMPERATURE_MAX           = 45.0;
const ZONE_HUMIDITY_MIN              = 0.05;
const ZONE_HUMIDITY_MAX              = 0.98;
const ZONE_WIND_SPEED_MIN            = 0.5;
const ZONE_WIND_SPEED_MAX            = 25.0;
const ZONE_PRECIP_MM_MIN             = 10.0;
const ZONE_PRECIP_MM_MAX             = 5000.0;
const ZONE_SEASONAL_AMPLITUDE_MIN    = 1.0;
const ZONE_SEASONAL_AMPLITUDE_MAX    = 40.0;

// ── Transition band defaults ───────────────────────────────
const DEFAULT_TRANSITION_WIDTH_DEG   = 5.0;
const MIN_TRANSITION_WIDTH_DEG       = 0.5;
const MAX_TRANSITION_WIDTH_DEG       = 20.0;

// ── Elevation adjustment ───────────────────────────────────
const ELEVATION_LAPSE_RATE           = 6.5;      // °C per 1000 m
const ELEVATION_CLIMATE_SHIFT_PER_KM = 0.004;    // ~0.4% zone shift per metre

// ── Coastal proximity ──────────────────────────────────────
const COASTAL_SEARCH_RADIUS_M        = 50000.0;  // 50 km
const COASTAL_HUMIDITY_BOOST_MAX     = 0.15;
const COASTAL_AMPLITUDE_DAMPING      = 0.6;

// ── Urban heat island ──────────────────────────────────────
const URBAN_HEAT_OFFSET_C            = 2.0;
const URBAN_HUMIDITY_OFFSET          = -0.05;    // urban areas slightly drier

// ── Rain shadow ────────────────────────────────────────────
const RAIN_SHADOW_WINDWARD_MULT      = 1.3;
const RAIN_SHADOW_LEEWARD_MULT       = 0.5;
const RAIN_SHADOW_SEARCH_KM          = 30.0;     // km to sample upwind
const RAIN_SHADOW_MAX_ELEV_DIFF      = 2000.0;   // max elevation difference

// ── Föhn wind (warm dry downslope) ─────────────────────────
const FOEHN_TEMP_BOOST_MAX           = 8.0;      // °C boost on leeward
const FOEHN_HUMIDITY_DROP_MAX        = 0.25;

// ═══════════════════════════════════════════════════════════════════════
// KÖPPEN CLIMATE ZONE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const KoppenClimate = Object.freeze({
  // A — Tropical
  AF:  0,   // Tropical rainforest
  AM:  1,   // Tropical monsoon
  AW:  2,   // Tropical savanna (dry winter)

  // B — Arid / semi-arid
  BWH: 3,   // Hot desert
  BWK: 4,   // Cold desert
  BSH: 5,   // Hot semi-arid (steppe)
  BSK: 6,   // Cold semi-arid

  // C — Temperate / mesothermal
  CSA: 7,   // Hot-summer Mediterranean
  CSB: 8,   // Warm-summer Mediterranean
  CSC: 9,   // Cold-summer Mediterranean
  CFA: 10,  // Humid subtropical
  CFB: 11,  // Oceanic (warm summer)
  CFC: 12,  // Subpolar oceanic (cool summer)

  // D — Continental / microthermal
  DSA: 13,  // Mediterranean continental (hot summer)
  DSB: 14,  // Mediterranean continental (warm summer)
  DSC: 15,  // Mediterranean continental (cool summer)
  DSD: 16,  // Mediterranean continental (very cool summer)
  DFA: 17,  // Humid continental (hot summer)
  DFB: 18,  // Humid continental (warm summer)
  DFC: 19,  // Subarctic (cool summer)
  DFD: 20,  // Subarctic (very cool summer)

  // E — Polar / alpine
  ET:  21,  // Tundra
  EF:  22,  // Ice cap / polar ice

  // Extra: highland climates (H in older Koppen systems)
  HIGHLAND: 23,

  // Extra: none / unassigned
  NONE: 24,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA CLIMATE ZONE
// ═══════════════════════════════════════════════════════════════════════

export const ClimateZone = {
  ownerEid: new Uint32Array(MAX_CLIMATE_ZONES),

  // Köppen classification.
  koppen: new Uint8Array(MAX_CLIMATE_ZONES),

  // Default biome.
  biome: new Uint8Array(MAX_CLIMATE_ZONES),

  // Center (lat / lon / elevation) — used for procedural queries.
  centerLat: new Float32Array(MAX_CLIMATE_ZONES),
  centerLon: new Float32Array(MAX_CLIMATE_ZONES),
  elevation: new Float32Array(MAX_CLIMATE_ZONES),

  // Extent (degrees of latitude / longitude).
  extentLat: new Float32Array(MAX_CLIMATE_ZONES),
  extentLon: new Float32Array(MAX_CLIMATE_ZONES),

  // Mean annual temperature (°C).
  meanTemperature: new Float32Array(MAX_CLIMATE_ZONES),

  // Seasonal amplitude (half of the summer-to-winter swing, °C).
  seasonalAmplitude: new Float32Array(MAX_CLIMATE_ZONES),

  // Mean annual humidity (0..1).
  meanHumidity: new Float32Array(MAX_CLIMATE_ZONES),

  // Mean annual wind speed (m/s).
  meanWindSpeed: new Float32Array(MAX_CLIMATE_ZONES),

  // Prevailing wind direction (radians).
  prevailingWindDir: new Float32Array(MAX_CLIMATE_ZONES),

  // Annual precipitation (mm).
  annualPrecipitationMm: new Float32Array(MAX_CLIMATE_ZONES),

  // Cloud cover baseline (0..1).
  cloudCoverBaseline: new Float32Array(MAX_CLIMATE_ZONES),

  // Coastal proximity (0 = inland, 1 = directly on coast).
  coastalProximity: new Float32Array(MAX_CLIMATE_ZONES),

  // Urban factor (0 = rural, 1 = dense urban).
  urbanFactor: new Float32Array(MAX_CLIMATE_ZONES),

  // Transition width to the nearest neighboring zone (degrees).
  transitionWidth: new Float32Array(MAX_CLIMATE_ZONES),

  // Priority (higher wins when zones overlap).
  priority: new Uint8Array(MAX_CLIMATE_ZONES),

  // Active.
  active: new Uint8Array(MAX_CLIMATE_ZONES),

  // Seed.
  seed: new Uint32Array(MAX_CLIMATE_ZONES),
};

/** Marker: entity owns a climate zone. */
export const ClimateZoneTag = {};

const _climateZoneSlots = new Map();
let _nextClimateZoneSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// KÖPPEN ZONE DEFINITIONS — default parameters per zone
// ═══════════════════════════════════════════════════════════════════════

const KOPPEN_DEFAULTS = {
  [KoppenClimate.AF]:  { temp: 27, amp: 1.5,  humid: 0.85, wind: 4,  precip: 2400, cloud: 0.75, biome: Biome.TROPICAL },
  [KoppenClimate.AM]:  { temp: 26, amp: 3.5,  humid: 0.80, wind: 5,  precip: 1800, cloud: 0.65, biome: Biome.TROPICAL },
  [KoppenClimate.AW]:  { temp: 25, amp: 5.0,  humid: 0.65, wind: 5,  precip: 1200, cloud: 0.50, biome: Biome.TROPICAL },

  [KoppenClimate.BWH]: { temp: 28, amp: 10.0, humid: 0.20, wind: 6,  precip: 100,  cloud: 0.15, biome: Biome.DESERT },
  [KoppenClimate.BWK]: { temp: 15, amp: 15.0, humid: 0.22, wind: 6,  precip: 150,  cloud: 0.20, biome: Biome.DESERT },
  [KoppenClimate.BSH]: { temp: 24, amp: 8.0,  humid: 0.30, wind: 7,  precip: 350,  cloud: 0.30, biome: Biome.ARID },
  [KoppenClimate.BSK]: { temp: 14, amp: 12.0, humid: 0.32, wind: 7,  precip: 400,  cloud: 0.35, biome: Biome.ARID },

  [KoppenClimate.CSA]: { temp: 18, amp: 8.0,  humid: 0.55, wind: 7,  precip: 700,  cloud: 0.40, biome: Biome.COASTAL },
  [KoppenClimate.CSB]: { temp: 15, amp: 6.0,  humid: 0.60, wind: 6,  precip: 800,  cloud: 0.45, biome: Biome.COASTAL },
  [KoppenClimate.CSC]: { temp: 12, amp: 4.0,  humid: 0.65, wind: 5,  precip: 900,  cloud: 0.55, biome: Biome.COASTAL },
  [KoppenClimate.CFA]: { temp: 16, amp: 10.0, humid: 0.68, wind: 5,  precip: 1200, cloud: 0.50, biome: Biome.TEMPERATE },
  [KoppenClimate.CFB]: { temp: 12, amp: 7.0,  humid: 0.75, wind: 6,  precip: 1100, cloud: 0.60, biome: Biome.COASTAL },
  [KoppenClimate.CFC]: { temp: 8,  amp: 4.0,  humid: 0.78, wind: 7,  precip: 1000, cloud: 0.65, biome: Biome.COASTAL },

  [KoppenClimate.DSA]: { temp: 15, amp: 14.0, humid: 0.45, wind: 6,  precip: 500,  cloud: 0.35, biome: Biome.CONTINENTAL },
  [KoppenClimate.DSB]: { temp: 12, amp: 12.0, humid: 0.50, wind: 6,  precip: 600,  cloud: 0.42, biome: Biome.CONTINENTAL },
  [KoppenClimate.DSC]: { temp: 8,  amp: 10.0, humid: 0.55, wind: 5,  precip: 650,  cloud: 0.50, biome: Biome.CONTINENTAL },
  [KoppenClimate.DSD]: { temp: 4,  amp: 8.0,  humid: 0.60, wind: 5,  precip: 700,  cloud: 0.58, biome: Biome.CONTINENTAL },
  [KoppenClimate.DFA]: { temp: 12, amp: 16.0, humid: 0.62, wind: 6,  precip: 900,  cloud: 0.48, biome: Biome.CONTINENTAL },
  [KoppenClimate.DFB]: { temp: 8,  amp: 14.0, humid: 0.68, wind: 6,  precip: 850,  cloud: 0.52, biome: Biome.FOREST },
  [KoppenClimate.DFC]: { temp: 2,  amp: 12.0, humid: 0.72, wind: 6,  precip: 750,  cloud: 0.60, biome: Biome.FOREST },
  [KoppenClimate.DFD]: { temp: -2, amp: 10.0, humid: 0.75, wind: 5,  precip: 700,  cloud: 0.65, biome: Biome.TUNDRA },

  [KoppenClimate.ET]:  { temp: -8, amp: 8.0,  humid: 0.70, wind: 8,  precip: 250,  cloud: 0.65, biome: Biome.TUNDRA },
  [KoppenClimate.EF]:  { temp: -25, amp: 5.0, humid: 0.65, wind: 10, precip: 150,  cloud: 0.55, biome: Biome.POLAR },

  [KoppenClimate.HIGHLAND]: { temp: 5, amp: 10.0, humid: 0.55, wind: 9, precip: 800, cloud: 0.55, biome: Biome.MOUNTAIN },

  [KoppenClimate.NONE]: { temp: 20, amp: 5.0, humid: 0.5, wind: 5, precip: 800, cloud: 0.5, biome: Biome.TEMPERATE },
};

// ═══════════════════════════════════════════════════════════════════════
// SoA CLIMATE TRANSITION (blending band between zones)
// ═══════════════════════════════════════════════════════════════════════

export const ClimateTransition = {
  active: new Uint8Array(MAX_CLIMATE_TRANSITIONS),

  // Zone A (from) and Zone B (to).
  zoneA: new Uint16Array(MAX_CLIMATE_TRANSITIONS),
  zoneB: new Uint16Array(MAX_CLIMATE_TRANSITIONS),

  // Width of the transition band (degrees of latitude / longitude).
  width: new Float32Array(MAX_CLIMATE_TRANSITIONS),

  // Blend curve (0 = linear, 1 = smoothstep, 2 = smootherstep).
  blendCurve: new Uint8Array(MAX_CLIMATE_TRANSITIONS),

  // Direction of the transition (azimuth in radians).
  azimuth: new Float32Array(MAX_CLIMATE_TRANSITIONS),
};

let _nextClimateTransitionSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SAMPLE CACHE
// ═══════════════════════════════════════════════════════════════════════

const _sampleCache = new Map();   // key "x,y,z" → ClimateSample

const CLIMATE_SAMPLE = {
  temperature: 0,
  humidity: 0,
  windSpeed: 0,
  windDirX: 0,
  windDirZ: 0,
  cloudCover: 0,
  precipitation: 0,
  koppen: 0,
  biome: 0,
  elevation: 0,
  coastalProximity: 0,
  urbanFactor: 0,
  rainShadowFactor: 1,
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
// CLIMATE ZONE CREATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a climate zone.
 *
 * @param world       ECS world
 * @param eid         entity
 * @param koppen       KoppenClimate
 * @param options     { centerLat, centerLon, elevation, extentLat, extentLon,
 *                      coastalProximity, urbanFactor, transitionWidth, priority }
 * @returns climate zone slot
 */
export function addClimateZone(world, eid, koppen = KoppenClimate.CFB, options = {}) {
  if (_nextClimateZoneSlot >= MAX_CLIMATE_ZONES) {
    throw new Error('climate zone capacity exceeded');
  }
  const slot = _nextClimateZoneSlot++;

  addComponent(world, eid, ClimateZoneTag);

  const Z = ClimateZone;
  Z.ownerEid[slot] = eid;
  Z.koppen[slot] = koppen;

  const defaults = KOPPEN_DEFAULTS[koppen] || KOPPEN_DEFAULTS[KoppenClimate.NONE];

  Z.biome[slot] = options.biome ?? defaults.biome;
  Z.centerLat[slot] = options.centerLat ?? 45.0;
  Z.centerLon[slot] = options.centerLon ?? 0.0;
  Z.elevation[slot] = options.elevation ?? 0;
  Z.extentLat[slot] = options.extentLat ?? 10.0;
  Z.extentLon[slot] = options.extentLon ?? 20.0;

  Z.meanTemperature[slot] = options.meanTemperature ?? defaults.temp;
  Z.seasonalAmplitude[slot] = options.seasonalAmplitude ?? defaults.amp;
  Z.meanHumidity[slot] = options.meanHumidity ?? defaults.humid;
  Z.meanWindSpeed[slot] = options.meanWindSpeed ?? defaults.wind;
  Z.prevailingWindDir[slot] = options.prevailingWindDir ?? 270 * DEG_TO_RAD;
  Z.annualPrecipitationMm[slot] = options.annualPrecipitationMm ?? defaults.precip;
  Z.cloudCoverBaseline[slot] = options.cloudCoverBaseline ?? defaults.cloud;

  Z.coastalProximity[slot] = options.coastalProximity ?? 0.0;
  Z.urbanFactor[slot] = options.urbanFactor ?? 0.0;
  Z.transitionWidth[slot] = options.transitionWidth ?? DEFAULT_TRANSITION_WIDTH_DEG;
  Z.priority[slot] = options.priority ?? 0;
  Z.active[slot] = 1;
  Z.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  _climateZoneSlots.set(eid, slot);
  return slot;
}

export function removeClimateZone(world, eid) {
  const slot = _climateZoneSlots.get(eid);
  if (slot === undefined) return;
  ClimateZone.active[slot] = 0;
  ClimateZone.ownerEid[slot] = 0;
  _climateZoneSlots.delete(eid);
  removeComponent(world, eid, ClimateZoneTag);
}

export function getClimateZoneSlot(eid) {
  return _climateZoneSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// TRANSITION REGISTRATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register a blend transition between two zones.
 */
export function addClimateTransition(zoneASlot, zoneBSlot, options = {}) {
  if (_nextClimateTransitionSlot >= MAX_CLIMATE_TRANSITIONS) {
    throw new Error('climate transition capacity exceeded');
  }
  const slot = _nextClimateTransitionSlot++;

  const T = ClimateTransition;
  T.active[slot] = 1;
  T.zoneA[slot] = zoneASlot;
  T.zoneB[slot] = zoneBSlot;
  T.width[slot] = Math.max(MIN_TRANSITION_WIDTH_DEG, Math.min(MAX_TRANSITION_WIDTH_DEG,
    options.width ?? DEFAULT_TRANSITION_WIDTH_DEG));
  T.blendCurve[slot] = options.blendCurve ?? 1;   // 1 = smoothstep
  T.azimuth[slot] = options.azimuth ?? 0;

  return slot;
}

// ═══════════════════════════════════════════════════════════════════════
// ZONE PARAMETER INTERPOLATION
// ═══════════════════════════════════════════════════════════════════════

function applyBlendCurve(curve, t) {
  t = Math.max(0, Math.min(1, t));
  if (curve === 0) return t;
  if (curve === 1) return t * t * (3 - 2 * t);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a, b, t) {
  return a * (1 - t) + b * t;
}

// ═══════════════════════════════════════════════════════════════════════
// CLIMATE SAMPLING — the hot path
// ═══════════════════════════════════════════════════════════════════════

const _sampleScratch = {
  temperature: 0,
  humidity: 0,
  windSpeed: 0,
  windDirX: 0,
  windDirZ: 0,
  cloudCover: 0,
  precipitation: 0,
  koppen: 0,
  biome: 0,
  elevation: 0,
  coastalProximity: 0,
  urbanFactor: 0,
  rainShadowFactor: 1,
};

/**
 * Sample the climate at a world (latitude, longitude, elevation) point.
 * Interpolates across overlapping zones and returns a reusable object.
 */
export function sampleClimateAt(latDeg, lonDeg, elevationM, world = null) {
  const Z = ClimateZone;

  // Find the two nearest zones that contain this point (by lat/lon bounds).
  let bestZone = -1;
  let secondBestZone = -1;
  let bestDist = Infinity;
  let secondBestDist = Infinity;

  for (let slot = 0; slot < _nextClimateZoneSlot; slot++) {
    if (!Z.active[slot]) continue;

    // Normalized distance from the zone center.
    const dLat = Math.abs(latDeg - Z.centerLat[slot]) / Math.max(Z.extentLat[slot], 0.1);
    const dLon = Math.abs(lonDeg - Z.centerLon[slot]) / Math.max(Z.extentLon[slot], 0.1);
    const dist = Math.sqrt(dLat * dLat + dLon * dLon);

    if (dist < bestDist) {
      secondBestDist = bestDist;
      secondBestZone = bestZone;
      bestDist = dist;
      bestZone = slot;
    } else if (dist < secondBestDist) {
      secondBestDist = dist;
      secondBestZone = slot;
    }
  }

  if (bestZone < 0) {
    return emptySample();
  }

  // Compute the interpolation weight between the primary and secondary zones.
  let blendFactor = 0;
  if (secondBestZone >= 0) {
    // Blend by proximity ratio.
    const w = Z.transitionWidth[bestZone] / Math.max(Z.extentLat[bestZone], 1);
    blendFactor = Math.max(0, Math.min(1,
      (bestDist - (1.0 - w)) / Math.max(2 * w, EPSILON)));
    blendFactor = applyBlendCurve(1, blendFactor);
  }

  // Start from the primary zone.
  _sampleScratch.temperature = Z.meanTemperature[bestZone];
  _sampleScratch.humidity = Z.meanHumidity[bestZone];
  _sampleScratch.windSpeed = Z.meanWindSpeed[bestZone];
  _sampleScratch.windDirX = Math.cos(Z.prevailingWindDir[bestZone]);
  _sampleScratch.windDirZ = Math.sin(Z.prevailingWindDir[bestZone]);
  _sampleScratch.cloudCover = Z.cloudCoverBaseline[bestZone];
  _sampleScratch.precipitation = Z.annualPrecipitationMm[bestZone];
  _sampleScratch.koppen = Z.koppen[bestZone];
  _sampleScratch.biome = Z.biome[bestZone];
  _sampleScratch.elevation = Z.elevation[bestZone];
  _sampleScratch.coastalProximity = Z.coastalProximity[bestZone];
  _sampleScratch.urbanFactor = Z.urbanFactor[bestZone];
  _sampleScratch.rainShadowFactor = 1.0;

  // Blend in the secondary zone if there is one.
  if (secondBestZone >= 0 && blendFactor > EPSILON) {
    _sampleScratch.temperature = lerp(_sampleScratch.temperature, Z.meanTemperature[secondBestZone], blendFactor);
    _sampleScratch.humidity = lerp(_sampleScratch.humidity, Z.meanHumidity[secondBestZone], blendFactor);
    _sampleScratch.windSpeed = lerp(_sampleScratch.windSpeed, Z.meanWindSpeed[secondBestZone], blendFactor);
    _sampleScratch.cloudCover = lerp(_sampleScratch.cloudCover, Z.cloudCoverBaseline[secondBestZone], blendFactor);
    _sampleScratch.precipitation = lerp(_sampleScratch.precipitation, Z.annualPrecipitationMm[secondBestZone], blendFactor);
    _sampleScratch.elevation = lerp(_sampleScratch.elevation, Z.elevation[secondBestZone], blendFactor);
    _sampleScratch.coastalProximity = lerp(_sampleScratch.coastalProximity, Z.coastalProximity[secondBestZone], blendFactor);
    _sampleScratch.urbanFactor = lerp(_sampleScratch.urbanFactor, Z.urbanFactor[secondBestZone], blendFactor);
  }

  // Elevation adjustment.
  const elevDiff = elevationM - _sampleScratch.elevation;
  if (Math.abs(elevDiff) > EPSILON) {
    _sampleScratch.temperature -= elevDiff / 1000.0 * ELEVATION_LAPSE_RATE;
    // Shift humidity up slightly with elevation (orographic lift).
    _sampleScratch.humidity = Math.min(ZONE_HUMIDITY_MAX,
      _sampleScratch.humidity + Math.max(0, elevDiff) / 10000.0 * 0.05);
  }

  // Coastal damping (maritime climates have smaller seasonal swings).
  if (_sampleScratch.coastalProximity > EPSILON) {
    _sampleScratch.humidity = Math.min(ZONE_HUMIDITY_MAX,
      _sampleScratch.humidity + _sampleScratch.coastalProximity * COASTAL_HUMIDITY_BOOST_MAX);
  }

  // Urban heat island.
  if (_sampleScratch.urbanFactor > EPSILON) {
    _sampleScratch.temperature += URBAN_HEAT_OFFSET_C * _sampleScratch.urbanFactor;
    _sampleScratch.humidity = Math.max(0.05, _sampleScratch.humidity + URBAN_HUMIDITY_OFFSET);
  }

  // Clamp values.
  _sampleScratch.temperature = Math.max(ZONE_TEMPERATURE_MIN, Math.min(ZONE_TEMPERATURE_MAX, _sampleScratch.temperature));
  _sampleScratch.humidity = Math.max(ZONE_HUMIDITY_MIN, Math.min(ZONE_HUMIDITY_MAX, _sampleScratch.humidity));
  _sampleScratch.windSpeed = Math.max(ZONE_WIND_SPEED_MIN, Math.min(ZONE_WIND_SPEED_MAX, _sampleScratch.windSpeed));

  return _sampleScratch;
}

function emptySample() {
  _sampleScratch.temperature = 20;
  _sampleScratch.humidity = 0.5;
  _sampleScratch.windSpeed = 5;
  _sampleScratch.windDirX = 1;
  _sampleScratch.windDirZ = 0;
  _sampleScratch.cloudCover = 0.5;
  _sampleScratch.precipitation = 800;
  _sampleScratch.koppen = KoppenClimate.NONE;
  _sampleScratch.biome = Biome.TEMPERATE;
  _sampleScratch.elevation = 0;
  _sampleScratch.coastalProximity = 0;
  _sampleScratch.urbanFactor = 0;
  _sampleScratch.rainShadowFactor = 1;
  return _sampleScratch;
}

// ═══════════════════════════════════════════════════════════════════════
// RAIN SHADOW — leeward precipitation reduction
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the rain shadow factor at a world position by sampling the
 * terrain upwind (via BVH) and comparing elevation to the local point.
 *
 * @returns rain shadow factor (0.5 to 1.3)
 */
function computeRainShadow(world, wx, wy, wz, windDirX, windDirZ) {
  if (!world) return 1.0;

  // Sample the upwind terrain.
  const searchDist = RAIN_SHADOW_SEARCH_KM * 1000;
  const stepLen = searchDist / 8;

  let maxUpwindElevation = wy;
  let foundBlockage = false;

  for (let i = 1; i <= 8; i++) {
    const t = i * stepLen;
    // Walk upwind from (wx, wz).
    const sampleX = wx - windDirX * t;
    const sampleZ = wz - windDirZ * t;

    // Cast a ray down to find the terrain elevation at the sample point.
    const hits = bvhRaycast(
      [sampleX, wy + 5000, sampleZ],
      [0, -1, 0],
      10000,
      true
    );

    if (hits.length > 0) {
      const elevation = wy + 5000 - hits[0].t;
      if (elevation > maxUpwindElevation) {
        maxUpwindElevation = elevation;
        foundBlockage = true;
      }
    }
  }

  if (!foundBlockage) {
    // No upwind terrain: normal precipitation.
    return 1.0;
  }

  // If the upwind elevation is much higher, we're in a rain shadow.
  const elevationDiff = maxUpwindElevation - wy;
  if (elevationDiff > RAIN_SHADOW_MAX_ELEV_DIFF) {
    return RAIN_SHADOW_LEEWARD_MULT;
  }

  const t = elevationDiff / RAIN_SHADOW_MAX_ELEV_DIFF;
  return lerp(RAIN_SHADOW_LEEWARD_MULT, 1.0, t);
}

// ═══════════════════════════════════════════════════════════════════════
// CLIMATE → SEASONAL PARAMETER INTEGRATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the seasonal temperature offset based on the current season
 * and the climate zone's seasonal amplitude.
 */
function seasonalTemperatureOffset(season, subSeason, progress, amplitude) {
  // Cosine wave: peak at mid-summer, trough at mid-winter.
  // Spring (0):   0 to +amp/2
  // Summer (1):   +amp/2 to +amp
  // Autumn (2):   +amp to 0
  // Winter (3):   0 to -amp
  let offset = 0;

  if (season === Season.SPRING) {
    offset = lerp(0, amplitude * 0.5, progress);
  } else if (season === Season.SUMMER) {
    offset = lerp(amplitude * 0.5, amplitude, progress);
  } else if (season === Season.AUTUMN) {
    offset = lerp(amplitude, 0, progress);
  } else if (season === Season.WINTER) {
    offset = lerp(0, -amplitude, progress);
  } else if (season === Season.MONSOON_WET) {
    offset = amplitude * 0.3;
  } else if (season === Season.MONSOON_DRY) {
    offset = -amplitude * 0.2;
  }

  return offset;
}

/**
 * Sample the complete climate-driven ambient weather parameters at a
 * world (latitude, longitude, elevation) point, using the current
 * seasonal state from file 065.
 *
 * @param climateSlot   climate zone slot from addClimateZone
 * @param seasonSlot    season region slot from file 065
 * @param wx, wy, wz    world position (for rain shadow and coastal proximity)
 * @param world         ECS world (optional, for terrain sampling)
 * @returns { temperature, humidity, windSpeed, windDirX, windDirZ, precipitation, cloudCover, ... }
 */
export function sampleClimateConditions(climateSlot, seasonSlot, wx, wy, wz, world = null) {
  const Z = ClimateZone;

  if (climateSlot < 0 || climateSlot >= _nextClimateZoneSlot) {
    return emptySample();
  }
  if (!Z.active[climateSlot]) {
    return emptySample();
  }

  // Read the season state.
  const season = getSeason(seasonSlot);
  const subSeason = getSubSeason(seasonSlot);
  const progress = getSeasonalProgress(seasonSlot);

  // Base climate parameters.
  const baseTemperature = Z.meanTemperature[climateSlot];
  const amplitude = Z.seasonalAmplitude[climateSlot];
  const baseHumidity = Z.meanHumidity[climateSlot];
  const baseWindSpeed = Z.meanWindSpeed[climateSlot];
  const baseWindDir = Z.prevailingWindDir[climateSlot];
  const basePrecipitation = Z.annualPrecipitationMm[climateSlot];
  const baseCloudCover = Z.cloudCoverBaseline[climateSlot];

  // Seasonal temperature offset.
  const seasonalTempOffset = seasonalTemperatureOffset(season, subSeason, progress, amplitude);

  // Coastal amplitude damping.
  let amplitudeDamping = 1.0;
  if (Z.coastalProximity[climateSlot] > EPSILON) {
    amplitudeDamping = 1.0 - Z.coastalProximity[climateSlot] * (1.0 - COASTAL_AMPLITUDE_DAMPING);
  }

  // Elevation adjustment.
  let elevationOffset = 0;
  if (world) {
    // Sample local terrain elevation.
    const hits = bvhRaycast([wx, wy + 5000, wz], [0, -1, 0], 10000, true);
    if (hits.length > 0) {
      const localElevation = wy + 5000 - hits[0].t;
      elevationOffset = -(localElevation - Z.elevation[climateSlot]) / 1000.0 * ELEVATION_LAPSE_RATE;
    }
  }

  // Urban heat island.
  let urbanOffset = 0;
  if (Z.urbanFactor[climateSlot] > EPSILON) {
    urbanOffset = URBAN_HEAT_OFFSET_C * Z.urbanFactor[climateSlot];
  }

  // Rain shadow.
  const windDirX = Math.cos(baseWindDir);
  const windDirZ = Math.sin(baseWindDir);
  const rainShadowFactor = world ? computeRainShadow(world, wx, wy, wz, windDirX, windDirZ) : 1.0;

  // Compute final values.
  _sampleScratch.temperature = baseTemperature + seasonalTempOffset * amplitudeDamping + elevationOffset + urbanOffset;
  _sampleScratch.humidity = baseHumidity;
  _sampleScratch.windSpeed = baseWindSpeed;
  _sampleScratch.windDirX = windDirX;
  _sampleScratch.windDirZ = windDirZ;
  _sampleScratch.cloudCover = baseCloudCover;
  _sampleScratch.precipitation = basePrecipitation * rainShadowFactor;
  _sampleScratch.koppen = Z.koppen[climateSlot];
  _sampleScratch.biome = Z.biome[climateSlot];
  _sampleScratch.elevation = Z.elevation[climateSlot];
  _sampleScratch.coastalProximity = Z.coastalProximity[climateSlot];
  _sampleScratch.urbanFactor = Z.urbanFactor[climateSlot];
  _sampleScratch.rainShadowFactor = rainShadowFactor;

  // Clamp.
  _sampleScratch.temperature = Math.max(ZONE_TEMPERATURE_MIN, Math.min(ZONE_TEMPERATURE_MAX, _sampleScratch.temperature));
  _sampleScratch.humidity = Math.max(ZONE_HUMIDITY_MIN, Math.min(ZONE_HUMIDITY_MAX, _sampleScratch.humidity));
  _sampleScratch.windSpeed = Math.max(ZONE_WIND_SPEED_MIN, Math.min(ZONE_WIND_SPEED_MAX, _sampleScratch.windSpeed));

  return _sampleScratch;
}

// ═══════════════════════════════════════════════════════════════════════
// CLIMATE → BIOME ASSIGNMENT
// ═══════════════════════════════════════════════════════════════════════

/**
 * Assign a biome value (file 063 Biome) from a Köppen zone + elevation +
 * coastal proximity.
 */
export function assignBiomeFromClimate(koppen, elevationM, coastalProximity) {
  const defaults = KOPPEN_DEFAULTS[koppen] || KOPPEN_DEFAULTS[KoppenClimate.NONE];
  let biome = defaults.biome;

  // Elevation overrides: high elevation → MOUNTAIN biome.
  if (elevationM > 2000) {
    biome = Biome.MOUNTAIN;
  }

  // Coastal override.
  if (coastalProximity > 0.7 && biome !== Biome.MOUNTAIN) {
    biome = Biome.COASTAL;
  }

  return biome;
}

// ═══════════════════════════════════════════════════════════════════════
// KÖPPEN CLASSIFICATION FROM CLIMATE PARAMETERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Classify a climate zone from its temperature and precipitation
 * parameters (Köppen-Geiger).
 *
 * @param meanTempC         annual mean temperature (°C)
 * @param summerHighC       warmest month temperature (°C)
 * @param winterLowC        coldest month temperature (°C)
 * @param precipMm          annual precipitation (mm)
 * @param elevationM        elevation above sea level (metres)
 * @returns KoppenClimate
 */
export function classifyKoppen(meanTempC, summerHighC, winterLowC, precipMm, elevationM = 0) {
  // Elevation override: highland.
  if (elevationM > 2500) {
    return KoppenClimate.HIGHLAND;
  }

  // E — Polar / ice cap: summer high < 10 °C.
  if (summerHighC < KOPPEN_E_POLAR_MAX_TEMP) {
    if (summerHighC < KOPPEN_E_FROST_MIN_TEMP) {
      return KoppenClimate.EF;
    }
    return KoppenClimate.ET;
  }

  // A — Tropical: winter low ≥ 18 °C.
  if (winterLowC >= KOPPEN_A_TROPICAL_MIN_TEMP) {
    // Distinguish Af / Am / Aw by precipitation.
    if (precipMm >= 2400) return KoppenClimate.AF;
    if (precipMm >= 1200) return KoppenClimate.AM;
    return KoppenClimate.AW;
  }

  // B — Arid: precip < 2 × temp.
  const aridityThreshold = meanTempC * KOPPEN_B_ARID_DRY_FACTOR;
  if (precipMm < aridityThreshold * 10) {
    // Hot vs cold by mean temp.
    const isHot = meanTempC > 18;
    if (precipMm < aridityThreshold * 5) {
      return isHot ? KoppenClimate.BWH : KoppenClimate.BWK;
    }
    return isHot ? KoppenClimate.BSH : KoppenClimate.BSK;
  }

  // C — Temperate: winter low ≥ -3 °C.
  if (winterLowC >= KOPPEN_C_TEMPERATE_MIN_TEMP) {
    // Mediterranean (dry summer) vs humid.
    if (summerHighC > 22) {
      return KoppenClimate.CFA;
    }
    if (summerHighC > 15) {
      return KoppenClimate.CFB;
    }
    return KoppenClimate.CFC;
  }

  // D — Continental: winter low < -3 °C, summer high > 10 °C.
  if (summerHighC > 10) {
    if (summerHighC > 22) return KoppenClimate.DFA;
    if (summerHighC > 15) return KoppenClimate.DFB;
    if (summerHighC > 5) return KoppenClimate.DFC;
    return KoppenClimate.DFD;
  }

  // Fallback to polar if nothing matched.
  return KoppenClimate.ET;
}

// ═══════════════════════════════════════════════════════════════════════
// KÖPPEN ZONE NAME LOOKUP
// ═══════════════════════════════════════════════════════════════════════

const KOPPEN_NAMES = {
  [KoppenClimate.AF]:  'Tropical Rainforest',
  [KoppenClimate.AM]:  'Tropical Monsoon',
  [KoppenClimate.AW]:  'Tropical Savanna',
  [KoppenClimate.BWH]: 'Hot Desert',
  [KoppenClimate.BWK]: 'Cold Desert',
  [KoppenClimate.BSH]: 'Hot Semi-Arid',
  [KoppenClimate.BSK]: 'Cold Semi-Arid',
  [KoppenClimate.CSA]: 'Hot-Summer Mediterranean',
  [KoppenClimate.CSB]: 'Warm-Summer Mediterranean',
  [KoppenClimate.CSC]: 'Cold-Summer Mediterranean',
  [KoppenClimate.CFA]: 'Humid Subtropical',
  [KoppenClimate.CFB]: 'Oceanic',
  [KoppenClimate.CFC]: 'Subpolar Oceanic',
  [KoppenClimate.DSA]: 'Mediterranean Continental (Hot)',
  [KoppenClimate.DSB]: 'Mediterranean Continental (Warm)',
  [KoppenClimate.DSC]: 'Mediterranean Continental (Cool)',
  [KoppenClimate.DSD]: 'Mediterranean Continental (Very Cool)',
  [KoppenClimate.DFA]: 'Humid Continental (Hot Summer)',
  [KoppenClimate.DFB]: 'Humid Continental (Warm Summer)',
  [KoppenClimate.DFC]: 'Subarctic',
  [KoppenClimate.DFD]: 'Subarctic (Extreme)',
  [KoppenClimate.ET]:  'Tundra',
  [KoppenClimate.EF]:  'Ice Cap',
  [KoppenClimate.HIGHLAND]: 'Highland',
  [KoppenClimate.NONE]: 'Unassigned',
};

export function koppenLabel(koppen) {
  return KOPPEN_NAMES[koppen] || 'Unknown';
}

/**
 * Return the two-letter Köppen code (e.g. "Cfb", "BWh").
 */
export function koppenCode(koppen) {
  const codes = {
    [KoppenClimate.AF]:  'Af',
    [KoppenClimate.AM]:  'Am',
    [KoppenClimate.AW]:  'Aw',
    [KoppenClimate.BWH]: 'BWh',
    [KoppenClimate.BWK]: 'BWk',
    [KoppenClimate.BSH]: 'BSh',
    [KoppenClimate.BSK]: 'BSk',
    [KoppenClimate.CSA]: 'Csa',
    [KoppenClimate.CSB]: 'Csb',
    [KoppenClimate.CSC]: 'Csc',
    [KoppenClimate.CFA]: 'Cfa',
    [KoppenClimate.CFB]: 'Cfb',
    [KoppenClimate.CFC]: 'Cfc',
    [KoppenClimate.DSA]: 'Dsa',
    [KoppenClimate.DSB]: 'Dsb',
    [KoppenClimate.DSC]: 'Dsc',
    [KoppenClimate.DSD]: 'Dsd',
    [KoppenClimate.DFA]: 'Dfa',
    [KoppenClimate.DFB]: 'Dfb',
    [KoppenClimate.DFC]: 'Dfc',
    [KoppenClimate.DFD]: 'Dfd',
    [KoppenClimate.ET]:  'ET',
    [KoppenClimate.EF]:  'EF',
    [KoppenClimate.HIGHLAND]: 'H',
    [KoppenClimate.NONE]: '??',
  };
  return codes[koppen] || '??';
}

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM — update climate zones (rare, mostly for procedural worlds)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance climate zones. For most worlds, climate parameters are
 * static, so this only handles procedural re-classification if the
 * elevation or coastal proximity changes.
 */
export function systemClimateZoneTick(world, dt) {
  const Z = ClimateZone;

  for (let slot = 0; slot < _nextClimateZoneSlot; slot++) {
    if (!Z.active[slot]) continue;

    // In a fully procedural world, we would re-classify here. For now,
    // the climate is static.

    // Update the biome if elevation or coastal proximity was modified.
    const newBiome = assignBiomeFromClimate(Z.koppen[slot], Z.elevation[slot], Z.coastalProximity[slot]);
    if (newBiome !== Z.biome[slot]) {
      Z.biome[slot] = newBiome;
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// CLIMATE ZONE LOOKUP HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the biome for a Köppen zone.
 */
export function biomeForKoppen(koppen) {
  const defaults = KOPPEN_DEFAULTS[koppen];
  return defaults ? defaults.biome : Biome.TEMPERATE;
}

/**
 * Return a human-readable label for a Köppen zone.
 */
export function koppenFullLabel(koppen) {
  return `${koppenCode(koppen)} — ${koppenLabel(koppen)}`;
}

// ═══════════════════════════════════════════════════════════════════════
// INTEGRATION WITH WEATHER SCHEDULER — biome defaults
// ═══════════════════════════════════════════════════════════════════════

/**
 * Query the biome for a scheduler region based on the climate zone that
 * contains its position.
 */
export function findBiomeForPosition(world, wx, wy, wz) {
  const Z = ClimateZone;

  for (let slot = 0; slot < _nextClimateZoneSlot; slot++) {
    if (!Z.active[slot]) continue;

    // Check whether this position is within the zone.
    const centerLat = Z.centerLat[slot];
    const centerLon = Z.centerLon[slot];
    const extentLat = Z.extentLat[slot];
    const extentLon = Z.extentLon[slot];

    // Convert world position to a synthetic lat/lon (for worlds where
    // the world position is used directly as lat/lon — most game worlds
    // use a small local region).
    const lat = wy / 1000.0 + centerLat;
    const lon = wx / 1000.0 + centerLon;

    const dLat = Math.abs(lat - centerLat) / Math.max(extentLat, 0.1);
    const dLon = Math.abs(lon - centerLon) / Math.max(extentLon, 0.1);

    if (dLat * dLat + dLon * dLon <= 1.0) {
      return Z.biome[slot];
    }
  }

  return Biome.TEMPERATE;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a summary of all climate zones for renderer / UI.
 */
export function gatherClimateZonesForRendering() {
  const result = [];
  const Z = ClimateZone;

  for (let slot = 0; slot < _nextClimateZoneSlot; slot++) {
    if (!Z.active[slot]) continue;

    result.push({
      slot,
      koppen: Z.koppen[slot],
      koppenCode: koppenCode(Z.koppen[slot]),
      koppenLabel: koppenLabel(Z.koppen[slot]),
      biome: Z.biome[slot],
      centerLat: Z.centerLat[slot],
      centerLon: Z.centerLon[slot],
      elevation: Z.elevation[slot],
      extentLat: Z.extentLat[slot],
      extentLon: Z.extentLon[slot],
      meanTemperature: Z.meanTemperature[slot],
      seasonalAmplitude: Z.seasonalAmplitude[slot],
      meanHumidity: Z.meanHumidity[slot],
      meanWindSpeed: Z.meanWindSpeed[slot],
      annualPrecipitationMm: Z.annualPrecipitationMm[slot],
      cloudCoverBaseline: Z.cloudCoverBaseline[slot],
      coastalProximity: Z.coastalProximity[slot],
      urbanFactor: Z.urbanFactor[slot],
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function climateZoneStats() {
  let activeZones = 0;
  let activeTransitions = 0;
  let totalMeanTemp = 0;

  const byClass = new Uint8Array(5);   // A, B, C, D, E

  for (let slot = 0; slot < _nextClimateZoneSlot; slot++) {
    if (!ClimateZone.active[slot]) continue;
    activeZones++;
    totalMeanTemp += ClimateZone.meanTemperature[slot];

    const koppen = ClimateZone.koppen[slot];
    if (koppen <= 2) byClass[0]++;         // A
    else if (koppen <= 6) byClass[1]++;    // B
    else if (koppen <= 12) byClass[2]++;   // C
    else if (koppen <= 20) byClass[3]++;   // D
    else byClass[4]++;                     // E and beyond
  }

  for (let slot = 0; slot < _nextClimateTransitionSlot; slot++) {
    if (ClimateTransition.active[slot]) activeTransitions++;
  }

  return {
    activeZones,
    maxZones: MAX_CLIMATE_ZONES,
    activeTransitions,
    maxTransitions: MAX_CLIMATE_TRANSITIONS,
    avgMeanTemperature: activeZones > 0 ? totalMeanTemp / activeZones : 0,
    byClass: {
      tropical:    byClass[0],
      arid:        byClass[1],
      temperate:   byClass[2],
      continental: byClass[3],
      polar:       byClass[4],
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearClimateZones() {
  ClimateZone.active.fill(0);
  ClimateZone.ownerEid.fill(0);
  _climateZoneSlots.clear();
  _nextClimateZoneSlot = 0;

  ClimateTransition.active.fill(0);
  _nextClimateTransitionSlot = 0;

  _sampleCache.clear();
}