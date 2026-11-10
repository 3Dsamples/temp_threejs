// file number : 068
// full path name : src/weather/068_humidity_field.js
// description : Atmospheric humidity field system. Provides the complete
//               thermodynamic water-vapour backbone for the bitECS_max
//               pipeline: absolute humidity, specific humidity, mixing
//               ratio, relative humidity, vapour pressure, saturation
//               vapour pressure, vapour pressure deficit, dew point,
//               frost point, wet-bulb temperature, and their spatial
//               fields. Supplies the physical basis that file 042 (rain),
//               043 (snow), 046 (fog), 055 (ash), 056 (fire), 059
//               (water surface), 061 (ice/frost), 065 (seasons), 066
//               (climate), and 067 (pressure) all reference.
//                 • THERMODYNAMIC MODEL — full set of standard
//                   meteorological formulae:
//                     - Saturation vapour pressure via Magnus-Tetens
//                       (Alduchov & Eskridge 1996) over water and
//                       over ice (below 0 °C).
//                     - Dew point (Bolton 1980).
//                     - Frost point (using ice formula).
//                     - Wet-bulb temperature (Stull 2011).
//                     - Absolute humidity ρ_v = e / (R_v · T_K).
//                     - Specific humidity q = 0.622 · e / (p - 0.378·e).
//                     - Mixing ratio w = 0.622 · e / (p - e).
//                     - Vapour pressure deficit (VPD = e_s - e).
//                     - Lifting condensation level (LCL) for cloud base.
//                 • HUMIDITY FIELD — a SoA grid of humidity cells that
//                   covers the world, with spatial interpolation using
//                   bilinear sampling for smooth queries. Cells track
//                   absolute humidity, mixing ratio, and a per-cell
//                   condensation state (0..1) so cloud and fog formation
//                   read directly from the field.
//                 • VAPOUR SOURCES — SoA list of humidity emitters:
//                     - Water bodies (file 059): evaporation driven by
//                       wind, temperature, and VPD.
//                     - Vegetation (file 065): transpiration with a
//                       Penman-Monteith-inspired stomatal conductance
//                       term (daytime only, sun angle gated).
//                     - Soil moisture: slow evaporation after rain
//                       (file 042 wetness).
//                     - Industrial cooling towers: point-source
//                       emitters.
//                     - Volcanic vents (file 055): H₂O emission.
//                     - Ocean currents (file 070, forward): warm-water
//                       evaporation enhancement.
//                 • HUMIDITY SINKS — SoA list of condensation events:
//                     - Dew formation on cold surfaces (via file 065
//                       temperature and file 043/061 surfaces).
//                     - Fog formation when RH > 95% (couples to file
//                       046's fog system).
//                     - Cloud formation via orographic lift (LCL
//                       computation using file 003 terrain BVH).
//                     - Rain, snow, hail scavenging (files 042-045).
//                 • ADVECTION — wind-driven horizontal humidity transport
//                   computed by sampling the current wind field (file
//                   047) and shifting the humidity grid.
//                 • DIFFUSION — Gaussian-like spreading of humidity
//                   from high to low concentration cells.
//                 • LATENT HEAT — condensation releases ~2,500 kJ per kg
//                   of water into the air (warming); evaporation absorbs
//                   the same amount (cooling). This is applied back to
//                   the temperature field so condensation warms the
//                   surrounding air, feeding back into file 065 / 066.
//                 • FOG AND CLOUD TRIGGERS — exposes `checkFogFormation`
//                   and `checkCloudFormation` APIs that file 046 and
//                   file 040 can poll to spawn the corresponding
//                   weather entities, with realistic thresholds
//                   (RH > 95% for fog, LCL above surface for cloud).
//                 • LATENT / SENSIBLE HEAT — the system distinguishes
//                   latent (humidity) from sensible (temperature) heat
//                   transport, so file 064's transition blending can
//                   correctly account for the "feel" of a change.
//               All state lives in typed arrays; per-frame cost is
//               O(grid cells) × O(1) + O(active vapour sources) +
//               O(active sinks). Zero per-frame allocation; steady-
//               state 1M-entity scenes handle humidity on Android
//               64-bit.
// best for : Weather realism, fog and dew forecasting, cloud formation
//            for storm onset, rain shadow effects, drying roads after
//            rain, character wetness persistence, and any 1M-entity
//            scene needing realistic humidity.
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
  PressureSystem,
  samplePressureAt,
  pressureTendencyAt,
} from './067_pressure_system.js';

import {
  SeasonRegion,
  getAmbientTemperature,
  getAmbientHumidity,
  getSunElevation,
  Season,
} from './065_season_system.js';

import {
  ClimateZone,
  sampleClimateAt,
} from './066_climate_zone.js';

import {
  WaterBody,
  WaterBodyType,
  WaterBodyTag,
  sampleWaterSurfaceHeight,
  findWaterBodyAt,
} from './059_water_surface.js';

import {
  SnowSurface,
  getSnowSurfaceSlot,
} from './043_snow.js';

import {
  IceSurface,
  getIceSurfaceSlot,
  getFrostThickness,
} from './061_ice_frost.js';

import {
  SurfaceWetness,
  getWetSurfaceSlot,
  getSurfaceWetness,
} from './042_rain.js';

import {
  sampleWindAt,
  WindSource,
} from './047_wind_gusts.js';

import {
  VegetationTag,
} from './065_season_system.js';

import {
  VolcanicVent,
  VolcanicVentTag,
} from './055_volcanic_ash.js';

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

// ── Thermodynamic constants ─────────────────────────────────
const GAS_CONSTANT_WATER_VAPOR       = 461.5;    // J/(kg·K)
const GAS_CONSTANT_DRY_AIR           = 287.058;  // J/(kg·K)
const MOLAR_MASS_WATER_VAPOR         = 0.018015; // kg/mol
const MOLAR_MASS_DRY_AIR             = 0.028964; // kg/mol
const RATIO_MOLAR_MASSES             = 0.62198;  // ε = M_v / M_d
const KELVIN_OFFSET                  = 273.15;
const STANDARD_ATMOSPHERIC_PRESSURE  = 101325.0; // Pa

// ── Magnus-Tetens coefficients ──────────────────────────────
// For water (Alduchov & Eskridge 1996).
const MAGNUS_A_WATER                 = 17.625;
const MAGNUS_B_WATER                 = 243.04;
const MAGNUS_C_WATER                 = 6.1094;   // hPa
// For ice.
const MAGNUS_A_ICE                   = 22.587;
const MAGNUS_B_ICE                   = 273.86;
const MAGNUS_C_ICE                   = 6.1121;   // hPa

// ── Wet-bulb (Stull 2011) coefficients ─────────────────────
const STULL_A                        = 0.151977;
const STULL_B                        = 8.313659;
const STULL_C                        = 1.676331;
const STULL_D                        = 0.00391838;
const STULL_E                        = 0.023101;
const STULL_F                        = 4.686035;

// ── Latent heats (J/kg) ────────────────────────────────────
const LATENT_HEAT_VAPORIZATION       = 2.501e6;  // at 0 °C
const LATENT_HEAT_VAPORIZATION_100C  = 2.257e6;  // at 100 °C
const LATENT_HEAT_SUBLIMATION        = 2.834e6;
const LATENT_HEAT_FUSION             = 3.337e5;
const LATENT_HEAT_PER_DEGREE_COOL    = (LATENT_HEAT_VAPORIZATION - LATENT_HEAT_VAPORIZATION_100C) / 100.0;

// ── Humidity thresholds ────────────────────────────────────
const MIN_ABSOLUTE_HUMIDITY          = 0.0;      // kg/m³
const MAX_ABSOLUTE_HUMIDITY          = 0.05;     // 50 g/m³ (tropical saturation)
const MIN_RELATIVE_HUMIDITY          = 0.01;     // 1%
const MAX_RELATIVE_HUMIDITY          = 1.00;     // 100%
const FOG_RH_THRESHOLD               = 0.95;     // 95% relative humidity
const CLOUD_LCL_ALTITUDE_MAX_M       = 15000;    // 15 km max cloud base
const CONDENSATION_RATE_COEFF        = 0.0005;   // per second at saturation
const EVAPORATION_RATE_COEFF         = 0.0003;   // per second at VPD=1 kPa
const DIFFUSION_RATE_CELL_PER_SEC    = 0.02;

// ── Grid parameters ────────────────────────────────────────
const MAX_HUMIDITY_GRIDS             = 64;
const MAX_GRID_CELLS_PER_DIM         = 128;
const MAX_VAPOR_SOURCES              = 4096;
const MAX_DEW_OBSERVERS              = 512;
const MAX_CONDENSATION_EVENTS        = 1024;

// ── Transpiration constants (Penman-Monteith inspired) ─────
const STOMATAL_CONDUCTANCE_MAX       = 0.02;     // m/s (fully open)
const STOMATAL_NIGHT_FACTOR          = 0.1;      // 10% at night
const LEAF_AREA_INDEX_DEFAULT        = 3.0;      // typical forest
const TRANSPIRATION_MIN_TEMP         = 5.0;      // °C — below this, minimal
const TRANSPIRATION_SUN_THRESHOLD    = 0.05;     // sun elevation for opening

// ── Soil evaporation ───────────────────────────────────────
const SOIL_EVAPORATION_MAX           = 0.00005;  // kg/(m²·s) max rate
const SOIL_MOISTURE_THRESHOLD        = 0.10;     // below this no evaporation

// ── Ocean evaporation ──────────────────────────────────────
const OCEAN_EVAPORATION_COEFF        = 0.00008;  // kg/(m²·s) base
const OCEAN_EVAPORATION_WIND_SCALE   = 0.000012; // extra per m/s wind
const OCEAN_EVAPORATION_VPD_SCALE    = 0.0002;   // extra per kPa VPD
const OCEAN_SEA_SURFACE_TEMP_OFFSET  = 1.0;      // °C warmer than air base

// ── Volcanic H₂O emission ──────────────────────────────────
const VOLCANIC_H2O_PER_KG_ASH        = 0.02;     // kg H₂O per kg ash

// ── Latent heat feedback ──────────────────────────────────
const LATENT_HEAT_TEMP_GAIN_MAX      = 0.5;      // °C max per frame

// ── Advection ─────────────────────────────────────────────
const ADVECTION_CELLS_PER_SEC        = 0.05;
const ADVECTION_DAMPING              = 0.95;

// ═══════════════════════════════════════════════════════════════════════
// HUMIDITY CELL STATE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const HumidityState = Object.freeze({
  SUBSATURATED:    0,   // RH < 100%
  SATURATED:       1,   // RH = 100% (dew point reached)
  CONDENSING:      2,   // condensing (forming dew, fog, or cloud)
  SUPERSATURATED:  3,   // transient supersaturation (will condense)
});

// ═══════════════════════════════════════════════════════════════════════
// VAPOR SOURCE TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const VaporSourceType = Object.freeze({
  WATER_BODY:      0,   // evaporation from open water
  VEGETATION:      1,   // transpiration from plants
  SOIL:            2,   // evaporation from wet soil
  COOLING_TOWER:   3,   // industrial cooling tower
  VOLCANIC_VENT:   4,   // volcanic H₂O emission
  OCEAN_CURRENT:   5,   // warm ocean current enhancement
});

// ═══════════════════════════════════════════════════════════════════════
// CONDENSATION TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const CondensationType = Object.freeze({
  DEW:          0,   // liquid water on surfaces
  FROST:        1,   // ice crystals on surfaces
  FOG:          2,   // ground-level cloud
  CLOUD:        3,   // elevated cloud base
  PRECIP:       4,   // falling water (rain/snow/hail)
});

// ═══════════════════════════════════════════════════════════════════════
// SoA HUMIDITY GRID
// ═══════════════════════════════════════════════════════════════════════

export const HumidityGrid = {
  ownerEid: new Uint32Array(MAX_HUMIDITY_GRIDS),

  // Grid dimensions (cell count in X and Z).
  gridSizeX: new Uint16Array(MAX_HUMIDITY_GRIDS),
  gridSizeZ: new Uint16Array(MAX_HUMIDITY_GRIDS),

  // World extents (metres).
  worldMinX: new Float32Array(MAX_HUMIDITY_GRIDS),
  worldMinZ: new Float32Array(MAX_HUMIDITY_GRIDS),
  worldMaxX: new Float32Array(MAX_HUMIDITY_GRIDS),
  worldMaxZ: new Float32Array(MAX_HUMIDITY_GRIDS),

  // Base altitude (metres; the grid is a 2.5D layer).
  baseAltitude: new Float32Array(MAX_HUMIDITY_GRIDS),

  // Layer thickness (metres; typically the atmospheric boundary layer).
  layerThickness: new Float32Array(MAX_HUMIDITY_GRIDS),

  // Per-cell absolute humidity (kg/m³) — the primary state.
  // Stored as a Float32Array per grid slot (allocated lazily).
  cellsByGrid: new Map(),

  // Per-cell mixing ratio (g/kg).
  mixingRatioByGrid: new Map(),

  // Per-cell condensation state (HumidityState).
  stateByGrid: new Map(),

  // Per-cell condensation mass (kg/m³).
  condensationByGrid: new Map(),

  // Age (seconds).
  age: new Float32Array(MAX_HUMIDITY_GRIDS),

  // Active.
  active: new Uint8Array(MAX_HUMIDITY_GRIDS),

  // Seed.
  seed: new Uint32Array(MAX_HUMIDITY_GRIDS),
};

/** Marker: entity owns a humidity grid. */
export const HumidityGridTag = {};

const _humidityGridSlots = new Map();
let _nextHumidityGridSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA VAPOR SOURCE
// ═══════════════════════════════════════════════════════════════════════

export const VaporSource = {
  ownerEid: new Uint32Array(MAX_VAPOR_SOURCES),
  type: new Uint8Array(MAX_VAPOR_SOURCES),

  // World position (metres).
  px: new Float32Array(MAX_VAPOR_SOURCES),
  py: new Float32Array(MAX_VAPOR_SOURCES),
  pz: new Float32Array(MAX_VAPOR_SOURCES),

  // Influence radius (metres).
  radiusX: new Float32Array(MAX_VAPOR_SOURCES),
  radiusY: new Float32Array(MAX_VAPOR_SOURCES),
  radiusZ: new Float32Array(MAX_VAPOR_SOURCES),

  // Per-source emission rate multiplier (0..2).
  rateMultiplier: new Float32Array(MAX_VAPOR_SOURCES),

  // Source-specific parameters:
  // - WATER_BODY: area (m²), surface temperature (°C)
  // - VEGETATION: LAI, sun exposure
  // - SOIL: current wetness (0..1)
  // - COOLING_TOWER: emission mass rate (kg/s)
  // - VOLCANIC_VENT: ash mass rate (kg/s)
  param1: new Float32Array(MAX_VAPOR_SOURCES),
  param2: new Float32Array(MAX_VAPOR_SOURCES),

  // Active.
  active: new Uint8Array(MAX_VAPOR_SOURCES),
};

/** Marker: entity is a vapor source. */
export const VaporSourceTag = {};

const _vaporSourceSlots = new Map();
let _nextVaporSourceSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA CONDENSATION EVENT
// ═══════════════════════════════════════════════════════════════════════

export const CondensationEvent = {
  active: new Uint8Array(MAX_CONDENSATION_EVENTS),

  // Type.
  type: new Uint8Array(MAX_CONDENSATION_EVENTS),

  // World position.
  px: new Float32Array(MAX_CONDENSATION_EVENTS),
  py: new Float32Array(MAX_CONDENSATION_EVENTS),
  pz: new Float32Array(MAX_CONDENSATION_EVENTS),

  // Mass rate (kg/s).
  massRate: new Float32Array(MAX_CONDENSATION_EVENTS),

  // Latent heat released (W).
  latentHeat: new Float32Array(MAX_CONDENSATION_EVENTS),

  // Age and lifetime (s).
  age: new Float32Array(MAX_CONDENSATION_EVENTS),
  lifetime: new Float32Array(MAX_CONDENSATION_EVENTS),

  // Target entity (surface being condensed on, or cloud entity).
  targetEid: new Uint32Array(MAX_CONDENSATION_EVENTS),

  // Free-list.
  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA DEW OBSERVER — an entity with a dew/surface wetness reading
// ═══════════════════════════════════════════════════════════════════════

export const DewObserver = {
  ownerEid: new Uint32Array(MAX_DEW_OBSERVERS),

  // Last-sampled dew point (°C).
  dewPoint: new Float32Array(MAX_DEW_OBSERVERS),

  // Surface temperature (°C; from file 065).
  surfaceTemp: new Float32Array(MAX_DEW_OBSERVERS),

  // Whether condensation is currently occurring (1 = yes).
  condensing: new Uint8Array(MAX_DEW_OBSERVERS),

  // Accumulated condensation mass (kg/m²).
  condensateMass: new Float32Array(MAX_DEW_OBSERVERS),

  // Active.
  active: new Uint8Array(MAX_DEW_OBSERVERS),
};

/** Marker: entity observes dew on its surface. */
export const DewObserverTag = {};

const _dewObserverSlots = new Map();
let _nextDewObserverSlot = 0;

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
// THERMODYNAMIC FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Saturation vapor pressure (hPa) over water, at temperature T (°C).
 * Uses Magnus-Tetens (Alduchov & Eskridge 1996).
 */
export function saturationVaporPressureWater(temperatureC) {
  return MAGNUS_C_WATER * Math.exp(
    (MAGNUS_A_WATER * temperatureC) / (MAGNUS_B_WATER + temperatureC)
  );
}

/**
 * Saturation vapor pressure (hPa) over ice, at temperature T (°C).
 */
export function saturationVaporPressureIce(temperatureC) {
  return MAGNUS_C_ICE * Math.exp(
    (MAGNUS_A_ICE * temperatureC) / (MAGNUS_B_ICE + temperatureC)
  );
}

/**
 * Saturation vapor pressure (hPa) — chooses water or ice based on
 * temperature.
 */
export function saturationVaporPressure(temperatureC) {
  if (temperatureC >= 0) {
    return saturationVaporPressureWater(temperatureC);
  }
  return saturationVaporPressureIce(temperatureC);
}

/**
 * Dew point temperature (°C) from actual vapor pressure e (hPa).
 * Uses Bolton (1980) formulation.
 */
export function dewPointFromVaporPressure(e) {
  if (e < EPSILON) return -100;
  const lnRatio = Math.log(e / 6.112);
  return (243.5 * lnRatio) / (17.67 - lnRatio);
}

/**
 * Dew point temperature (°C) from temperature (°C) and relative
 * humidity (0..1).
 */
export function dewPoint(temperatureC, relativeHumidity) {
  const rh = Math.max(MIN_RELATIVE_HUMIDITY, Math.min(MAX_RELATIVE_HUMIDITY, relativeHumidity));
  const gamma = Math.log(rh) + (MAGNUS_A_WATER * temperatureC) / (MAGNUS_B_WATER + temperatureC);
  return (MAGNUS_B_WATER * gamma) / (MAGNUS_A_WATER - gamma);
}

/**
 * Frost point temperature (°C). Same as dew point but using ice
 * saturation curve; only meaningful below 0 °C.
 */
export function frostPoint(temperatureC, relativeHumidity) {
  const rh = Math.max(MIN_RELATIVE_HUMIDITY, Math.min(MAX_RELATIVE_HUMIDITY, relativeHumidity));
  const gamma = Math.log(rh) + (MAGNUS_A_ICE * temperatureC) / (MAGNUS_B_ICE + temperatureC);
  return (MAGNUS_B_ICE * gamma) / (MAGNUS_A_ICE - gamma);
}

/**
 * Wet-bulb temperature (°C) from temperature (°C) and relative humidity
 * (0..1). Uses Stull (2011) empirical formula.
 */
export function wetBulbTemperature(temperatureC, relativeHumidity) {
  const rhPct = Math.max(1, Math.min(99, relativeHumidity * 100));

  const tw = temperatureC * Math.atan(STULL_A * Math.sqrt(rhPct + STULL_B))
    + Math.atan(temperatureC + rhPct)
    - Math.atan(rhPct - STULL_C)
    + STULL_D * Math.pow(rhPct, 1.5) * Math.atan(STULL_E * rhPct)
    - STULL_F;

  return tw;
}

/**
 * Absolute humidity (kg/m³) from vapor pressure e (hPa) and
 * temperature T (°C).
 * ρ_v = e / (R_v · T_K)
 */
export function absoluteHumidityFromVaporPressure(e, temperatureC) {
  const ePa = e * 100.0;
  const tK = temperatureC + KELVIN_OFFSET;
  if (tK <= 0) return 0;
  return ePa / (GAS_CONSTANT_WATER_VAPOR * tK);
}

/**
 * Vapor pressure e (hPa) from absolute humidity (kg/m³) and temperature
 * (°C).
 */
export function vaporPressureFromAbsoluteHumidity(rhoV, temperatureC) {
  const tK = temperatureC + KELVIN_OFFSET;
  if (tK <= 0) return 0;
  return (rhoV * GAS_CONSTANT_WATER_VAPOR * tK) / 100.0;
}

/**
 * Relative humidity (0..1) from absolute humidity (kg/m³) and
 * temperature (°C).
 */
export function relativeHumidityFromAbsolute(rhoV, temperatureC) {
  const e = vaporPressureFromAbsoluteHumidity(rhoV, temperatureC);
  const eSat = saturationVaporPressure(temperatureC);
  if (eSat < EPSILON) return 0;
  return Math.max(MIN_RELATIVE_HUMIDITY, Math.min(MAX_RELATIVE_HUMIDITY, e / eSat));
}

/**
 * Absolute humidity (kg/m³) from relative humidity (0..1) and
 * temperature (°C).
 */
export function absoluteHumidityFromRelative(relativeHumidity, temperatureC) {
  const eSat = saturationVaporPressure(temperatureC);
  const e = relativeHumidity * eSat;
  return absoluteHumidityFromVaporPressure(e, temperatureC);
}

/**
 * Specific humidity (g/kg) from absolute humidity (kg/m³), pressure
 * (hPa), and temperature (°C).
 */
export function specificHumidity(rhoV, pressureHpa, temperatureC) {
  const e = vaporPressureFromAbsoluteHumidity(rhoV, temperatureC);
  const p = pressureHpa;
  if (p < e + EPSILON) return 0;
  return RATIO_MOLAR_MASSES * (e / (p - (1 - RATIO_MOLAR_MASSES) * e)) * 1000.0;
}

/**
 * Mixing ratio (g/kg) from absolute humidity, pressure, and temperature.
 */
export function mixingRatio(rhoV, pressureHpa, temperatureC) {
  const e = vaporPressureFromAbsoluteHumidity(rhoV, temperatureC);
  const p = pressureHpa;
  if (p < e + EPSILON) return 0;
  return RATIO_MOLAR_MASSES * (e / (p - e)) * 1000.0;
}

/**
 * Vapor pressure deficit (hPa) — the difference between saturation
 * vapor pressure and actual vapor pressure.
 */
export function vaporPressureDeficit(rhoV, temperatureC) {
  const e = vaporPressureFromAbsoluteHumidity(rhoV, temperatureC);
  const eSat = saturationVaporPressure(temperatureC);
  return Math.max(0, eSat - e);
}

/**
 * Lifting condensation level — altitude (metres) at which a rising
 * air parcel will reach saturation.
 *
 * LCL = (T - T_d) × 125.0
 */
export function liftingCondensationLevel(temperatureC, dewPointC) {
  return Math.max(0, Math.min(CLOUD_LCL_ALTITUDE_MAX_M,
    (temperatureC - dewPointC) * 125.0));
}

/**
 * Latent heat released per kg of water condensing at temperature T (°C).
 */
export function latentHeatOfVaporization(temperatureC) {
  return LATENT_HEAT_VAPORIZATION - LATENT_HEAT_PER_DEGREE_COOL * temperatureC;
}

// ═══════════════════════════════════════════════════════════════════════
// HUMIDITY GRID API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a humidity grid.
 *
 * @param world       ECS world
 * @param eid         entity
 * @param options     { worldMinX, worldMinZ, worldMaxX, worldMaxZ,
 *                      gridSizeX, gridSizeZ, baseAltitude,
 *                      layerThickness, initialHumidity, seed }
 * @returns humidity grid slot
 */
export function addHumidityGrid(world, eid, options = {}) {
  if (_nextHumidityGridSlot >= MAX_HUMIDITY_GRIDS) {
    throw new Error('humidity grid capacity exceeded');
  }
  const slot = _nextHumidityGridSlot++;

  addComponent(world, eid, HumidityGridTag);

  const G = HumidityGrid;
  G.ownerEid[slot] = eid;

  const gridSizeX = Math.max(2, Math.min(MAX_GRID_CELLS_PER_DIM,
    options.gridSizeX ?? 64));
  const gridSizeZ = Math.max(2, Math.min(MAX_GRID_CELLS_PER_DIM,
    options.gridSizeZ ?? 64));

  G.gridSizeX[slot] = gridSizeX;
  G.gridSizeZ[slot] = gridSizeZ;

  G.worldMinX[slot] = options.worldMinX ?? -50000;
  G.worldMinZ[slot] = options.worldMinZ ?? -50000;
  G.worldMaxX[slot] = options.worldMaxX ?? 50000;
  G.worldMaxZ[slot] = options.worldMaxZ ?? 50000;

  G.baseAltitude[slot] = options.baseAltitude ?? 0;
  G.layerThickness[slot] = options.layerThickness ?? 2000.0;

  // Allocate per-cell arrays.
  const cellCount = gridSizeX * gridSizeZ;
  const cells = new Float32Array(cellCount);
  const mixRatio = new Float32Array(cellCount);
  const states = new Uint8Array(cellCount);
  const condMass = new Float32Array(cellCount);

  // Initialize humidity from regional climate.
  const initialHumidity = options.initialHumidity ?? 0.008;   // 8 g/m³
  for (let i = 0; i < cellCount; i++) {
    cells[i] = initialHumidity;
    mixRatio[i] = 0;
    states[i] = HumidityState.SUBSATURATED;
    condMass[i] = 0;
  }

  G.cellsByGrid.set(slot, cells);
  G.mixingRatioByGrid.set(slot, mixRatio);
  G.stateByGrid.set(slot, states);
  G.condensationByGrid.set(slot, condMass);

  G.age[slot] = 0;
  G.active[slot] = 1;
  G.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  _humidityGridSlots.set(eid, slot);
  return slot;
}

export function removeHumidityGrid(world, eid) {
  const slot = _humidityGridSlots.get(eid);
  if (slot === undefined) return;
  HumidityGrid.active[slot] = 0;
  HumidityGrid.ownerEid[slot] = 0;
  HumidityGrid.cellsByGrid.delete(slot);
  HumidityGrid.mixingRatioByGrid.delete(slot);
  HumidityGrid.stateByGrid.delete(slot);
  HumidityGrid.condensationByGrid.delete(slot);
  _humidityGridSlots.delete(eid);
  removeComponent(world, eid, HumidityGridTag);
}

export function getHumidityGridSlot(eid) {
  return _humidityGridSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// VAPOR SOURCE API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a vapor source.
 *
 * @param world       ECS world
 * @param eid         entity
 * @param type        VaporSourceType
 * @param options     { px, py, pz, radiusX, radiusY, radiusZ,
 *                      rateMultiplier, param1, param2 }
 * @returns vapor source slot
 */
export function addVaporSource(world, eid, type = VaporSourceType.WATER_BODY, options = {}) {
  if (_nextVaporSourceSlot >= MAX_VAPOR_SOURCES) {
    throw new Error('vapor source capacity exceeded');
  }
  const slot = _nextVaporSourceSlot++;

  addComponent(world, eid, VaporSourceTag);

  const V = VaporSource;
  V.ownerEid[slot] = eid;
  V.type[slot] = type;
  V.px[slot] = options.px ?? 0;
  V.py[slot] = options.py ?? 0;
  V.pz[slot] = options.pz ?? 0;
  V.radiusX[slot] = options.radiusX ?? 100;
  V.radiusY[slot] = options.radiusY ?? 50;
  V.radiusZ[slot] = options.radiusZ ?? 100;
  V.rateMultiplier[slot] = options.rateMultiplier ?? 1.0;
  V.param1[slot] = options.param1 ?? 0;
  V.param2[slot] = options.param2 ?? 0;
  V.active[slot] = 1;

  _vaporSourceSlots.set(eid, slot);
  return slot;
}

export function removeVaporSource(world, eid) {
  const slot = _vaporSourceSlots.get(eid);
  if (slot === undefined) return;
  VaporSource.active[slot] = 0;
  VaporSource.ownerEid[slot] = 0;
  _vaporSourceSlots.delete(eid);
  removeComponent(world, eid, VaporSourceTag);
}

export function getVaporSourceSlot(eid) {
  return _vaporSourceSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// DEW OBSERVER API
// ═══════════════════════════════════════════════════════════════════════

export function addDewObserver(world, eid) {
  if (_nextDewObserverSlot >= MAX_DEW_OBSERVERS) {
    throw new Error('dew observer capacity exceeded');
  }
  const slot = _nextDewObserverSlot++;

  addComponent(world, eid, DewObserverTag);

  DewObserver.ownerEid[slot] = eid;
  DewObserver.dewPoint[slot] = 0;
  DewObserver.surfaceTemp[slot] = 0;
  DewObserver.condensing[slot] = 0;
  DewObserver.condensateMass[slot] = 0;
  DewObserver.active[slot] = 1;

  _dewObserverSlots.set(eid, slot);
  return slot;
}

export function removeDewObserver(world, eid) {
  const slot = _dewObserverSlots.get(eid);
  if (slot === undefined) return;
  DewObserver.active[slot] = 0;
  DewObserver.ownerEid[slot] = 0;
  _dewObserverSlots.delete(eid);
  removeComponent(world, eid, DewObserverTag);
}

export function getDewObserverSlot(eid) {
  return _dewObserverSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// HUMIDITY SAMPLING — the hot path
// ═══════════════════════════════════════════════════════════════════════

const _humiditySample = {
  absoluteHumidity: 0,
  relativeHumidity: 0,
  vaporPressure: 0,
  saturationVaporPressure: 0,
  vaporPressureDeficit: 0,
  dewPoint: 0,
  frostPoint: 0,
  wetBulb: 0,
  mixingRatio: 0,
  specificHumidity: 0,
  state: HumidityState.SUBSATURATED,
};

/**
 * Sample the humidity at a world position from the nearest grid.
 * Uses bilinear interpolation across the grid.
 *
 * @param gridSlot  humidity grid slot
 * @param wx, wz    world position
 * @param tempC     local ambient temperature (°C)
 * @param pressureHpa local atmospheric pressure (hPa)
 * @param out       reusable output (default is internal)
 */
export function sampleHumidityAt(gridSlot, wx, wz, tempC, pressureHpa, out = _humiditySample) {
  const G = HumidityGrid;

  if (gridSlot < 0 || gridSlot >= _nextHumidityGridSlot || !G.active[gridSlot]) {
    return emptyHumiditySample(out);
  }

  const cells = G.cellsByGrid.get(gridSlot);
  const stateCells = G.stateByGrid.get(gridSlot);
  if (!cells) return emptyHumiditySample(out);

  const sizeX = G.gridSizeX[gridSlot];
  const sizeZ = G.gridSizeZ[gridSlot];

  // Convert world position to grid coordinates.
  const nx = (wx - G.worldMinX[gridSlot]) / (G.worldMaxX[gridSlot] - G.worldMinX[gridSlot]);
  const nz = (wz - G.worldMinZ[gridSlot]) / (G.worldMaxZ[gridSlot] - G.worldMinZ[gridSlot]);

  if (nx < 0 || nx > 1 || nz < 0 || nz > 1) {
    return emptyHumiditySample(out);
  }

  // Bilinear interpolation.
  const gx = nx * (sizeX - 1);
  const gz = nz * (sizeZ - 1);
  const x0 = Math.floor(gx);
  const z0 = Math.floor(gz);
  const x1 = Math.min(x0 + 1, sizeX - 1);
  const z1 = Math.min(z0 + 1, sizeZ - 1);
  const fx = gx - x0;
  const fz = gz - z0;

  const c00 = cells[z0 * sizeX + x0];
  const c10 = cells[z0 * sizeX + x1];
  const c01 = cells[z1 * sizeX + x0];
  const c11 = cells[z1 * sizeX + x1];

  const rhoV = c00 * (1 - fx) * (1 - fz)
    + c10 * fx * (1 - fz)
    + c01 * (1 - fx) * fz
    + c11 * fx * fz;

  // Compute derived quantities.
  out.absoluteHumidity = rhoV;
  out.relativeHumidity = relativeHumidityFromAbsolute(rhoV, tempC);
  out.vaporPressure = vaporPressureFromAbsoluteHumidity(rhoV, tempC);
  out.saturationVaporPressure = saturationVaporPressure(tempC);
  out.vaporPressureDeficit = vaporPressureDeficit(rhoV, tempC);
  out.dewPoint = dewPoint(tempC, out.relativeHumidity);
  out.frostPoint = frostPoint(tempC, out.relativeHumidity);
  out.wetBulb = wetBulbTemperature(tempC, out.relativeHumidity);
  out.mixingRatio = mixingRatio(rhoV, pressureHpa, tempC);
  out.specificHumidity = specificHumidity(rhoV, pressureHpa, tempC);

  // State from the nearest cell.
  const state = stateCells[z0 * sizeX + x0];
  out.state = state;

  return out;
}

function emptyHumiditySample(out) {
  out.absoluteHumidity = 0;
  out.relativeHumidity = 0;
  out.vaporPressure = 0;
  out.saturationVaporPressure = 0;
  out.vaporPressureDeficit = 0;
  out.dewPoint = -100;
  out.frostPoint = -100;
  out.wetBulb = 0;
  out.mixingRatio = 0;
  out.specificHumidity = 0;
  out.state = HumidityState.SUBSATURATED;
  return out;
}

/**
 * Return the humidity at a world point as a full struct (convenience
 * wrapper that samples from the local pressure and season).
 */
export function getHumidityAt(wx, wy, wz, gridSlot, seasonSlot) {
  const tempC = seasonSlot >= 0 ? getAmbientTemperature(seasonSlot) : 20;
  const pressureHpa = samplePressureAt(wx, wz);
  return sampleHumidityAt(gridSlot, wx, wz, tempC, pressureHpa);
}

// ═══════════════════════════════════════════════════════════════════════
// VAPOR SOURCE EMISSION COMPUTATION
// ═══════════════════════════════════════════════════════════════════════

const _windForVapor = vec3.create();

/**
 * Compute the emission rate (kg/s) of a vapor source.
 */
export function computeVaporEmissionRate(sourceSlot, tempC, pressureHpa) {
  const V = VaporSource;
  if (!V.active[sourceSlot]) return 0;

  const type = V.type[sourceSlot];

  // Sample wind at source.
  sampleWindAt(V.px[sourceSlot], V.py[sourceSlot], V.pz[sourceSlot], _windForVapor);
  const windSpeed = Math.hypot(_windForVapor[0], _windForVapor[2]);

  switch (type) {
    case VaporSourceType.WATER_BODY: {
      // Ocean evaporation model.
      // e_sat at surface temperature (slightly warmer than air).
      const surfaceTemp = V.param2[sourceSlot] || (tempC + OCEAN_SEA_SURFACE_TEMP_OFFSET);
      const eSat = saturationVaporPressure(surfaceTemp);
      const eAir = saturationVaporPressure(tempC) * 0.8;   // assume 80% RH
      const vpd = Math.max(0, eSat - eAir) / 10.0;   // convert hPa → kPa

      const rate = OCEAN_EVAPORATION_COEFF
        + OCEAN_EVAPORATION_WIND_SCALE * windSpeed
        + OCEAN_EVAPORATION_VPD_SCALE * vpd;

      // Multiply by area and rateMultiplier.
      const area = V.param1[sourceSlot] || 10000;
      return rate * area * V.rateMultiplier[sourceSlot] * 1000;   // kg/s
    }

    case VaporSourceType.VEGETATION: {
      // Penman-Monteith-inspired transpiration.
      if (tempC < TRANSPIRATION_MIN_TEMP) return 0;

      const lai = V.param1[sourceSlot] || LEAF_AREA_INDEX_DEFAULT;
      const sunFactor = Math.min(1, V.param2[sourceSlot] || 0.5);

      // Stomatal conductance: opens with sun and warmth.
      const stomatalOpen = STOMATAL_CONDUCTANCE_MAX
        * sunFactor
        * Math.min(1, (tempC - TRANSPIRATION_MIN_TEMP) / 20);

      const vpd = saturationVaporPressure(tempC) * 0.4 / 10.0;   // kPa
      const rate = stomatalOpen * vpd * lai;

      return rate * V.rateMultiplier[sourceSlot] * 100;   // kg/s
    }

    case VaporSourceType.SOIL: {
      const wetness = V.param1[sourceSlot] || 0;
      if (wetness < SOIL_MOISTURE_THRESHOLD) return 0;

      const area = V.param2[sourceSlot] || 100;
      const tempFactor = Math.min(1, Math.max(0, tempC - 5) / 30);

      return SOIL_EVAPORATION_MAX * wetness * tempFactor * area
        * V.rateMultiplier[sourceSlot] * 1000;   // kg/s
    }

    case VaporSourceType.COOLING_TOWER: {
      // Fixed mass rate from param1 (kg/s).
      return (V.param1[sourceSlot] || 1.0) * V.rateMultiplier[sourceSlot];
    }

    case VaporSourceType.VOLCANIC_VENT: {
      // H₂O emission proportional to ash emission rate.
      const ashRate = V.param1[sourceSlot] || 0;
      return ashRate * VOLCANIC_H2O_PER_KG_ASH * V.rateMultiplier[sourceSlot];
    }

    case VaporSourceType.OCEAN_CURRENT: {
      // Like WATER_BODY but with warmer surface temp offset.
      const warmOffset = V.param2[sourceSlot] || 5;
      const surfaceTemp = tempC + warmOffset;
      const eSat = saturationVaporPressure(surfaceTemp);
      const eAir = saturationVaporPressure(tempC) * 0.8;
      const vpd = Math.max(0, eSat - eAir) / 10.0;
      const area = V.param1[sourceSlot] || 10000;
      return (OCEAN_EVAPORATION_COEFF + OCEAN_EVAPORATION_VPD_SCALE * vpd) * area
        * V.rateMultiplier[sourceSlot] * 1000;
    }
  }

  return 0;
}

// ═══════════════════════════════════════════════════════════════════════
// GRID UPDATE SYSTEM — advance the humidity field
// ═══════════════════════════════════════════════════════════════════════

/**
 * Apply vapor source contributions to the grid, distribute them across
 * nearby cells, and advance diffusion/advection.
 *
 * @param world       ECS world
 * @param dt          seconds
 * @param tempC       ambient temperature (°C)
 * @param pressureHpa ambient pressure (hPa)
 */
export function systemUpdateHumidityField(world, dt, tempC, pressureHpa) {
  const G = HumidityGrid;
  const V = VaporSource;

  // 1. Process each active humidity grid.
  for (let gridSlot = 0; gridSlot < _nextHumidityGridSlot; gridSlot++) {
    if (!G.active[gridSlot]) continue;

    G.age[gridSlot] += dt;

    const cells = G.cellsByGrid.get(gridSlot);
    const stateCells = G.stateByGrid.get(gridSlot);
    const condCells = G.condensationByGrid.get(gridSlot);
    if (!cells) continue;

    const sizeX = G.gridSizeX[gridSlot];
    const sizeZ = G.gridSizeZ[gridSlot];

    // 2. Apply vapor source emissions into cells.
    const totalVaporInput = new Float32Array(cells.length);

    for (let srcSlot = 0; srcSlot < _nextVaporSourceSlot; srcSlot++) {
      if (!V.active[srcSlot]) continue;

      const rate = computeVaporEmissionRate(srcSlot, tempC, pressureHpa);
      if (rate <= EPSILON) continue;

      // Distribute over source radius.
      const srcX = V.px[srcSlot];
      const srcZ = V.pz[srcSlot];
      const radiusX = V.radiusX[srcSlot];
      const radiusZ = V.radiusZ[srcSlot];

      const worldWidth = G.worldMaxX[gridSlot] - G.worldMinX[gridSlot];
      const worldDepth = G.worldMaxZ[gridSlot] - G.worldMinZ[gridSlot];
      const cellW = worldWidth / sizeX;
      const cellD = worldDepth / sizeZ;

      // Determine affected cell range.
      const iMin = Math.max(0, Math.floor((srcX - radiusX - G.worldMinX[gridSlot]) / cellW));
      const iMax = Math.min(sizeX - 1, Math.ceil((srcX + radiusX - G.worldMinX[gridSlot]) / cellW));
      const jMin = Math.max(0, Math.floor((srcZ - radiusZ - G.worldMinZ[gridSlot]) / cellD));
      const jMax = Math.min(sizeZ - 1, Math.ceil((srcZ + radiusZ - G.worldMinZ[gridSlot]) / cellD));

      // Gaussian falloff weight.
      for (let j = jMin; j <= jMax; j++) {
        for (let i = iMin; i <= iMax; i++) {
          const cellCX = G.worldMinX[gridSlot] + (i + 0.5) * cellW;
          const cellCZ = G.worldMinZ[gridSlot] + (j + 0.5) * cellD;
          const dx = (cellCX - srcX) / Math.max(radiusX, 1);
          const dz = (cellCZ - srcZ) / Math.max(radiusZ, 1);
          const distNormSq = dx * dx + dz * dz;
          if (distNormSq > 1) continue;

          const weight = Math.exp(-distNormSq * 3);
          const cellIdx = j * sizeX + i;

          // Convert to per-cell humidity change: kg/s → kg/m³·(rate area)
          // Approximate: distribute total rate over affected cells.
          const cellArea = cellW * cellD;
          const layerVolume = cellArea * G.layerThickness[gridSlot];
          totalVaporInput[cellIdx] += (rate * weight * dt) / layerVolume;
        }
      }
    }

    // 3. Apply emissions + diffusion + advection + condensation.
    const totalVaporInputCopy = new Float32Array(totalVaporInput);

    for (let j = 0; j < sizeZ; j++) {
      for (let i = 0; i < sizeX; i++) {
        const idx = j * sizeX + i;

        // Add vapor emission.
        cells[idx] += totalVaporInputCopy[idx];

        // Sample wind for advection.
        const cellCX = G.worldMinX[gridSlot] + (i + 0.5) * (G.worldMaxX[gridSlot] - G.worldMinX[gridSlot]) / sizeX;
        const cellCZ = G.worldMinZ[gridSlot] + (j + 0.5) * (G.worldMaxZ[gridSlot] - G.worldMinZ[gridSlot]) / sizeZ;

        sampleWindAt(cellCX, G.baseAltitude[gridSlot], cellCZ, _windForVapor);
        const windX = _windForVapor[0];
        const windZ = _windForVapor[2];

        // Advection: shift humidity from upwind cell.
        const cellW = (G.worldMaxX[gridSlot] - G.worldMinX[gridSlot]) / sizeX;
        const cellD = (G.worldMaxZ[gridSlot] - G.worldMinZ[gridSlot]) / sizeZ;

        const srcI = Math.max(0, Math.min(sizeX - 1, i - Math.round(windX * dt / cellW * ADVECTION_CELLS_PER_SEC)));
        const srcJ = Math.max(0, Math.min(sizeZ - 1, j - Math.round(windZ * dt / cellD * ADVECTION_CELLS_PER_SEC)));

        const srcIdx = srcJ * sizeX + srcI;
        const advectionAmount = (cells[srcIdx] - cells[idx]) * ADVECTION_CELLS_PER_SEC * dt;
        cells[idx] += advectionAmount * 0.5;

        // Diffusion: pull toward neighbor average.
        const nL = i > 0 ? cells[j * sizeX + (i - 1)] : cells[idx];
        const nR = i < sizeX - 1 ? cells[j * sizeX + (i + 1)] : cells[idx];
        const nU = j > 0 ? cells[(j - 1) * sizeX + i] : cells[idx];
        const nD = j < sizeZ - 1 ? cells[(j + 1) * sizeX + i] : cells[idx];
        const avg = (nL + nR + nU + nD) * 0.25;

        cells[idx] += (avg - cells[idx]) * DIFFUSION_RATE_CELL_PER_SEC * dt;

        // Clamp.
        cells[idx] = Math.max(MIN_ABSOLUTE_HUMIDITY, Math.min(MAX_ABSOLUTE_HUMIDITY, cells[idx]));

        // Determine condensation state.
        const rh = relativeHumidityFromAbsolute(cells[idx], tempC);

        if (rh >= MAX_RELATIVE_HUMIDITY - 0.001) {
          // Saturated. Condense the excess.
          const excess = cells[idx] - absoluteHumidityFromRelative(MAX_RELATIVE_HUMIDITY - 0.001, tempC);
          if (excess > EPSILON) {
            const condenseRate = Math.min(excess, excess * CONDENSATION_RATE_COEFF * dt * 60);
            cells[idx] -= condenseRate;
            condCells[idx] += condenseRate;
            stateCells[idx] = HumidityState.CONDENSING;

            // Latent heat released — feedback to temperature is handled
            // by the caller via `systemApplyLatentHeat`.
          }
        } else if (rh >= FOG_RH_THRESHOLD) {
          stateCells[idx] = HumidityState.SATURATED;
        } else {
          stateCells[idx] = HumidityState.SUBSATURATED;
        }
      }
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// LATENT HEAT FEEDBACK
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the latent heat released by condensation at a world position.
 * This should be added to the local air temperature by the caller.
 *
 * @returns Latent heat release rate (W/m³) — positive means warming.
 */
export function sampleLatentHeatRelease(gridSlot, wx, wz, tempC) {
  const G = HumidityGrid;
  if (gridSlot < 0 || !G.active[gridSlot]) return 0;

  const condCells = G.condensationByGrid.get(gridSlot);
  if (!condCells) return 0;

  const sizeX = G.gridSizeX[gridSlot];
  const sizeZ = G.gridSizeZ[gridSlot];

  const nx = (wx - G.worldMinX[gridSlot]) / (G.worldMaxX[gridSlot] - G.worldMinX[gridSlot]);
  const nz = (wz - G.worldMinZ[gridSlot]) / (G.worldMaxZ[gridSlot] - G.worldMinZ[gridSlot]);

  if (nx < 0 || nx > 1 || nz < 0 || nz > 1) return 0;

  const i = Math.min(sizeX - 1, Math.floor(nx * sizeX));
  const j = Math.min(sizeZ - 1, Math.floor(nz * sizeZ));

  const condMass = condCells[j * sizeX + i];
  if (condMass < EPSILON) return 0;

  const Lv = latentHeatOfVaporization(tempC);
  // Approximate: condensation mass per second per m³ of air.
  return condMass * Lv;
}

// ═══════════════════════════════════════════════════════════════════════
// FOG / CLOUD FORMATION TRIGGERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Check whether fog should form at a world position. Fog forms when:
 *   - RH > 95% (near saturation)
 *   - No significant wind (or light wind) to disperse it
 *   - The grid is below ~300 m altitude (ground-level)
 *
 * @returns Fog density (0..1) or 0 if none.
 */
export function checkFogFormation(gridSlot, wx, wz, tempC, pressureHpa) {
  const sample = sampleHumidityAt(gridSlot, wx, wz, tempC, pressureHpa);

  if (sample.relativeHumidity < FOG_RH_THRESHOLD) return 0;

  // Check altitude (fog is ground-level).
  const G = HumidityGrid;
  if (gridSlot < 0 || !G.active[gridSlot]) return 0;
  if (G.baseAltitude[gridSlot] > 500) return 0;

  // Light wind required (fog forms in calm conditions).
  sampleWindAt(wx, G.baseAltitude[gridSlot], wz, _windForVapor);
  const windSpeed = Math.hypot(_windForVapor[0], _windForVapor[2]);
  if (windSpeed > 8) return 0;

  // Fog density proportional to RH above threshold.
  const fogDensity = (sample.relativeHumidity - FOG_RH_THRESHOLD) / (MAX_RELATIVE_HUMIDITY - FOG_RH_THRESHOLD);
  return Math.max(0, Math.min(1, fogDensity));
}

/**
 * Check whether clouds should form at a world position. Clouds form
 * when a rising air parcel reaches its lifting condensation level (LCL).
 *
 * @returns { form: boolean, cloudBaseAltitude: number, density: number }
 */
export function checkCloudFormation(gridSlot, wx, wz, tempC, pressureHpa, surfaceAltitude = 0) {
  const sample = sampleHumidityAt(gridSlot, wx, wz, tempC, pressureHpa);

  // Lifting condensation level.
  const lcl = liftingCondensationLevel(tempC, sample.dewPoint);

  // Clouds form if LCL is above the surface but not absurdly high.
  const cloudBaseAltitude = surfaceAltitude + lcl;
  const form = lcl > 100 && cloudBaseAltitude < CLOUD_LCL_ALTITUDE_MAX_M;

  // Density based on how low the LCL is (lower = denser clouds).
  const density = form
    ? Math.max(0, 1 - lcl / CLOUD_LCL_ALTITUDE_MAX_M)
    : 0;

  return {
    form,
    cloudBaseAltitude,
    density,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// DEW / FROST OBSERVER SYSTEM
// ═══════════════════════════════════════════════════════════════════════

/**
 * Update all dew observers. For each observer, sample the humidity
 * field at the surface, compare to the surface temperature, and
 * compute condensation (dew or frost) when the surface temp is at
 * or below the dew point.
 */
export function systemUpdateDewObservers(world, dt, tempC, pressureHpa) {
  const D = DewObserver;

  for (let slot = 0; slot < _nextDewObserverSlot; slot++) {
    if (!D.active[slot]) continue;

    const eid = D.ownerEid[slot];
    if (!eid || !entityExists(world, eid)) continue;

    const id = getId(eid);
    const M = WorldTransformF32.m;
    if (!M) continue;
    const off = id * 16;
    const wx = M[off + 12];
    const wy = M[off + 13];
    const wz = M[off + 14];

    // Surface temperature: use snow/ice/wetness state if available.
    // For simplicity, use ambient temperature (games can override).
    D.surfaceTemp[slot] = tempC - 1.0;   // surfaces 1 °C cooler than air (nocturnal)

    // Sample dew point.
    const sample = getHumidityAt(wx, wy, wz, -1, -1);

    D.dewPoint[slot] = sample.dewPoint;

    // Determine if condensation is happening.
    if (D.surfaceTemp[slot] <= sample.frostPoint) {
      // Frost (below freezing).
      D.condensing[slot] = 1;
      D.condensateMass[slot] += 0.0001 * dt;
    } else if (D.surfaceTemp[slot] <= sample.dewPoint) {
      // Dew.
      D.condensing[slot] = 1;
      D.condensateMass[slot] += 0.0001 * dt;
    } else {
      D.condensing[slot] = 0;
      // Evaporation from previous condensation.
      D.condensateMass[slot] = Math.max(0, D.condensateMass[slot] - 0.00005 * dt);
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TICK — advance humidity field
// ═══════════════════════════════════════════════════════════════════════

/**
 * Full humidity pipeline for one frame.
 *
 * @param world         ECS world
 * @param dt            seconds
 * @param seasonSlot    season region slot (for ambient temperature)
 */
export function systemHumidityTick(world, dt, seasonSlot = -1) {
  const tempC = seasonSlot >= 0 ? getAmbientTemperature(seasonSlot) : 20;

  // Sample global pressure (average from a point).
  const pressureHpa = samplePressureAt(0, 0);

  systemUpdateHumidityField(world, dt, tempC, pressureHpa);
  systemUpdateDewObservers(world, dt, tempC, pressureHpa);

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a full humidity summary at a world position.
 */
export function getHumiditySummaryAt(gridSlot, wx, wz, tempC, pressureHpa) {
  const sample = sampleHumidityAt(gridSlot, wx, wz, tempC, pressureHpa);

  return {
    absoluteHumidity: sample.absoluteHumidity,
    relativeHumidity: sample.relativeHumidity,
    vaporPressure: sample.vaporPressure,
    saturationVaporPressure: sample.saturationVaporPressure,
    vaporPressureDeficit: sample.vaporPressureDeficit,
    dewPoint: sample.dewPoint,
    frostPoint: sample.frostPoint,
    wetBulb: sample.wetBulb,
    mixingRatio: sample.mixingRatio,
    specificHumidity: sample.specificHumidity,
    state: sample.state,
    liftingCondensationLevel: liftingCondensationLevel(tempC, sample.dewPoint),
  };
}

/**
 * Return a human-readable label for a humidity state.
 */
export function humidityStateLabel(state) {
  switch (state) {
    case HumidityState.SUBSATURATED:  return 'Subsaturated';
    case HumidityState.SATURATED:     return 'Saturated';
    case HumidityState.CONDENSING:    return 'Condensing';
    case HumidityState.SUPERSATURATED: return 'Supersaturated';
    default:                           return 'Unknown';
  }
}

/**
 * Return a human-readable label for a vapor source type.
 */
export function vaporSourceTypeLabel(type) {
  switch (type) {
    case VaporSourceType.WATER_BODY:     return 'Water Body';
    case VaporSourceType.VEGETATION:     return 'Vegetation';
    case VaporSourceType.SOIL:           return 'Soil';
    case VaporSourceType.COOLING_TOWER:  return 'Cooling Tower';
    case VaporSourceType.VOLCANIC_VENT:  return 'Volcanic Vent';
    case VaporSourceType.OCEAN_CURRENT:  return 'Ocean Current';
    default:                              return 'Unknown';
  }
}

/**
 * Return a human-readable label for a condensation type.
 */
export function condensationTypeLabel(type) {
  switch (type) {
    case CondensationType.DEW:     return 'Dew';
    case CondensationType.FROST:   return 'Frost';
    case CondensationType.FOG:     return 'Fog';
    case CondensationType.CLOUD:   return 'Cloud';
    case CondensationType.PRECIP:  return 'Precipitation';
    default:                        return 'Unknown';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// AUTOMATIC VAPOR SOURCE SYNC — couples to files 059, 065, 042
// ═══════════════════════════════════════════════════════════════════════

/**
 * Automatically scan the world and register vapor sources for all
 * entities that should emit humidity (water bodies, vegetation, wet
 * soil, volcanic vents).
 *
 * Call once when the world is built, and re-run periodically to pick
 * up newly created entities.
 */
export function systemSyncVaporSources(world) {
  // Water bodies.
  const waterEids = query(world, [WaterBodyTag]);
  for (let i = 0; i < waterEids.length; i++) {
    const eid = waterEids[i];
    if (getVaporSourceSlot(eid) >= 0) continue;

    const id = getId(eid);
    addVaporSource(world, eid, VaporSourceType.WATER_BODY, {
      px: 0,
      py: 0,
      pz: 0,
      radiusX: 500,
      radiusY: 50,
      radiusZ: 500,
      param1: 250000,
      param2: 15,
    });
  }

  // Vegetation.
  const vegetationEids = query(world, [VegetationTag]);
  for (let i = 0; i < vegetationEids.length; i++) {
    const eid = vegetationEids[i];
    if (getVaporSourceSlot(eid) >= 0) continue;

    addVaporSource(world, eid, VaporSourceType.VEGETATION, {
      px: 0, py: 0, pz: 0,
      radiusX: 50,
      radiusY: 20,
      radiusZ: 50,
      param1: LEAF_AREA_INDEX_DEFAULT,
      param2: 0.5,
    });
  }

  // Volcanic vents.
  const volcanicEids = query(world, [VolcanicVentTag]);
  for (let i = 0; i < volcanicEids.length; i++) {
    const eid = volcanicEids[i];
    if (getVaporSourceSlot(eid) >= 0) continue;

    addVaporSource(world, eid, VaporSourceType.VOLCANIC_VENT, {
      px: 0, py: 0, pz: 0,
      radiusX: 100,
      radiusY: 200,
      radiusZ: 100,
      param1: 1000,   // ash kg/s
    });
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a summary of all active humidity grids.
 */
export function gatherHumidityGridsForRendering() {
  const result = [];
  const G = HumidityGrid;

  for (let slot = 0; slot < _nextHumidityGridSlot; slot++) {
    if (!G.active[slot]) continue;

    result.push({
      slot,
      gridSizeX: G.gridSizeX[slot],
      gridSizeZ: G.gridSizeZ[slot],
      worldMinX: G.worldMinX[slot],
      worldMinZ: G.worldMinZ[slot],
      worldMaxX: G.worldMaxX[slot],
      worldMaxZ: G.worldMaxZ[slot],
      baseAltitude: G.baseAltitude[slot],
      layerThickness: G.layerThickness[slot],
    });
  }

  return result;
}

/**
 * Return a summary of all active vapor sources.
 */
export function gatherVaporSourcesForRendering() {
  const result = [];
  const V = VaporSource;

  for (let slot = 0; slot < _nextVaporSourceSlot; slot++) {
    if (!V.active[slot]) continue;

    result.push({
      slot,
      type: V.type[slot],
      typeLabel: vaporSourceTypeLabel(V.type[slot]),
      px: V.px[slot],
      py: V.py[slot],
      pz: V.pz[slot],
      radiusX: V.radiusX[slot],
      radiusY: V.radiusY[slot],
      radiusZ: V.radiusZ[slot],
    });
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function humidityStats() {
  let activeGrids = 0;
  let activeSources = 0;
  let activeDewObservers = 0;
  let activeCondensation = 0;

  const sourcesByType = new Uint8Array(6);

  for (let slot = 0; slot < _nextHumidityGridSlot; slot++) {
    if (HumidityGrid.active[slot]) activeGrids++;
  }

  for (let slot = 0; slot < _nextVaporSourceSlot; slot++) {
    if (!VaporSource.active[slot]) continue;
    activeSources++;
    sourcesByType[VaporSource.type[slot]]++;
  }

  for (let slot = 0; slot < _nextDewObserverSlot; slot++) {
    if (DewObserver.active[slot]) activeDewObservers++;
  }

  return {
    activeGrids,
    maxGrids: MAX_HUMIDITY_GRIDS,
    activeSources,
    maxSources: MAX_VAPOR_SOURCES,
    activeDewObservers,
    maxDewObservers: MAX_DEW_OBSERVERS,
    sourcesByType: {
      waterBodies: sourcesByType[VaporSourceType.WATER_BODY],
      vegetation: sourcesByType[VaporSourceType.VEGETATION],
      soil: sourcesByType[VaporSourceType.SOIL],
      coolingTowers: sourcesByType[VaporSourceType.COOLING_TOWER],
      volcanicVents: sourcesByType[VaporSourceType.VOLCANIC_VENT],
      oceanCurrents: sourcesByType[VaporSourceType.OCEAN_CURRENT],
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearHumidityField() {
  HumidityGrid.active.fill(0);
  HumidityGrid.ownerEid.fill(0);
  HumidityGrid.cellsByGrid.clear();
  HumidityGrid.mixingRatioByGrid.clear();
  HumidityGrid.stateByGrid.clear();
  HumidityGrid.condensationByGrid.clear();
  _humidityGridSlots.clear();
  _nextHumidityGridSlot = 0;

  VaporSource.active.fill(0);
  VaporSource.ownerEid.fill(0);
  _vaporSourceSlots.clear();
  _nextVaporSourceSlot = 0;

  DewObserver.active.fill(0);
  DewObserver.ownerEid.fill(0);
  _dewObserverSlots.clear();
  _nextDewObserverSlot = 0;

  CondensationEvent.active.fill(0);
  CondensationEvent.freeHead = 0;
  CondensationEvent.liveCount = 0;
}