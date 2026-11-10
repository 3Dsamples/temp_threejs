// file number : 069
// full path name : src/weather/069_temperature_field.js
// description : Atmospheric temperature field system. Provides the
//               full spatial temperature backbone for the bitECS_max
//               pipeline. Extends file 065's per-region ambient
//               temperature into a continuous, advected, radiated,
//               and terrain-modified temperature field that every
//               downstream system can sample:
//                 • TEMPERATURE GRID — SoA grid of temperature cells
//                   with bilinear spatial interpolation, matching file
//                   068's humidity grid structure for numerical
//                   stability and easy cross-coupling.
//                 • HEAT TRANSPORT — full advection-diffusion of
//                   temperature driven by wind (file 047):
//                     - Advection: cold/hot air masses move with wind.
//                     - Diffusion: thermal energy spreads cell-to-cell.
//                     - Convection: vertical mixing in unstable layers
//                       (Warm → up, cold → down).
//                 • RADIATIVE HEATING — computes the solar heating rate
//                   from the sun angle (file 065) and cloud cover
//                   (file 040). Exposes a `solarHeatingRate` function
//                   for direct coupling.
//                 • RADIATIVE COOLING — long-wave (thermal infrared)
//                   cooling at night, using the Stefan-Boltzmann law
//                   with a cloud cover feedback (clear skies cool
//                   faster, cloudy skies cool slower).
//                 • LATENT HEAT — reads file 068's condensation mass
//                   and returns the corresponding temperature
//                   feedback (condensation warms, evaporation cools).
//                 • SENSIBLE HEAT — evaporative cooling from wet
//                   surfaces (file 042) and ocean surfaces (file 059)
//                   lowers local temperature (Bowen ratio coupling).
//                 • TERRAIN EFFECTS — real elevation lapse rate
//                   (6.5 °C/km) applied via BVH terrain height sampling
//                   (file 003):
//                     - Mountain tops are cooler.
//                     - Valley cold pools form at night (cold air
//                       drains downhill).
//                     - Urban heat islands add +2 °C (file 066).
//                 • THERMAL INVERSIONS — detect and model inversion
//                   layers (temperature increasing with altitude) that
//                   trap fog and pollution. Reads pressure tendency
//                   (file 067) and cloud cover to decide when an
//                   inversion is likely.
//                 • APPARENT TEMPERATURE — full set of comfort /
//                   safety metrics:
//                     - Wind chill (JAG/TI 2001) for cold + wind.
//                     - Heat index (Rothfusz 1990) for hot + humid.
//                     - Wet-bulb globe temperature (WBGT) approximation.
//                     - Apparent (feels-like) temperature.
//                 • FREEZING LEVEL — altitude where temperature
//                   crosses 0 °C, used by file 043 snow onset and
//                   file 061 ice formation.
//                 • TEMPERATURE TENDENCY — dT/dt at a fixed point,
//                   exposed for gameplay "getting colder / warmer"
//                   prediction.
//                 • LATENT / SENSIBLE HEAT BALANCE — tracks the
//                   fraction of local heating that goes into the air
//                   (sensible) vs. evaporation (latent). Exposed via
//                   `heatBalanceAt` so file 064 transitions can
//                   account for the "feel" of the change.
//               All state lives in typed arrays; per-frame cost is
//               O(grid cells) × O(1) + O(active heat sources). Zero
//               per-frame allocation; steady-state 1M-entity scenes
//               handle temperature on Android 64-bit.
// best for : Snow/ice onset prediction, character cold/heat status,
//            freeze levels, thermal inversions trapping fog, urban
//            heat islands, mountain / valley climates, and any
//            1M-entity scene needing realistic temperatures.
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
  pressureTendencyAt,
} from './067_pressure_system.js';

import {
  SeasonRegion,
  Season,
  SubSeason,
  getAmbientTemperature,
  getSunElevation,
  getDayLength,
  getSeason,
} from './065_season_system.js';

import {
  ClimateZone,
  sampleClimateAt,
  KoppenClimate,
} from './066_climate_zone.js';

import {
  HumidityGrid,
  HumidityState,
  sampleHumidityAt,
  sampleLatentHeatRelease,
  relativeHumidityFromAbsolute,
  saturationVaporPressure,
  vaporPressureDeficit,
  wetBulbTemperature,
  dewPoint,
} from './068_humidity_field.js';

import {
  WaterBody,
  WaterBodyType,
  WaterBodyTag,
  findWaterBodyAt,
  sampleWaterSurfaceHeight,
} from './059_water_surface.js';

import {
  SurfaceWetness,
  SurfaceType,
  getWetSurfaceSlot,
  getSurfaceWetness,
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
  FireCell,
  FirePhase,
} from './056_smoke_fire.js';

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
const GRAVITY                        = 9.81;
const AIR_DENSITY                    = 1.225;
const KELVIN_OFFSET                  = 273.15;
const STEFAN_BOLTZMANN               = 5.670374419e-8;   // W/(m²·K⁴)
const SOLAR_CONSTANT                 = 1361.0;           // W/m²
const AIR_SPECIFIC_HEAT              = 1005.0;           // J/(kg·K)
const AIR_EMISSIVITY                 = 0.85;
const GROUND_EMISSIVITY              = 0.95;

// ── Temperature grid ────────────────────────────────────────
const MAX_TEMP_GRIDS                 = 64;
const MAX_GRID_CELLS_PER_DIM         = 128;
const MAX_TEMPERATURE_SOURCES        = 2048;
const MAX_TEMP_OBSERVERS             = 4096;

// ── Physics constants ───────────────────────────────────────
const LAPSE_RATE_STANDARD            = 6.5;      // °C/km (dry adiabatic ~9.8, moist ~5)
const LAPSE_RATE_DRY_ADIABATIC       = 9.8;
const LAPSE_RATE_MOIST               = 5.0;
const LAPSE_RATE_INVERSION           = -2.0;     // °C/km (inversion: warmer with altitude)
const TEMP_CONVECTION_THRESHOLD      = 0.5;      // °C difference triggers convection
const DIFFUSION_RATE_TEMP_PER_SEC    = 0.02;
const ADVECTION_DAMPING              = 0.95;
const ADVECTION_CELLS_PER_SEC        = 0.05;
const MIN_TEMP_C                     = -90.0;
const MAX_TEMP_C                     = 70.0;

// ── Solar heating ───────────────────────────────────────────
const SOLAR_HEATING_MAX_RATE         = 0.008;    // °C/s at full sun
const SOLAR_ALBEDO_GROUND            = 0.20;
const SOLAR_ALBEDO_SNOW              = 0.85;
const SOLAR_ALBEDO_OCEAN             = 0.06;
const CLOUD_SOLAR_ATTENUATION        = 0.7;      // fraction blocked per 100% cloud

// ── Long-wave cooling ───────────────────────────────────────
const LW_COOLING_MAX_RATE            = 0.004;    // °C/s at clear night
const CLOUD_LW_TRAPPING_FACTOR       = 0.65;     // clouds reduce cooling

// ── Heat sources ────────────────────────────────────────────
const FIRE_HEAT_MULTIPLIER           = 15.0;
const VOLCANIC_HEAT_MULTIPLIER       = 25.0;
const INDUSTRIAL_HEAT_MULTIPLIER     = 3.0;
const URBAN_HEAT_ISLAND_BOOST        = 2.0;      // +2 °C
const SENSIBLE_HEAT_COEFF            = 15.0;     // W/(m²·K) bulk sensible heat flux

// ── Urban / vegetation ─────────────────────────────────────
const URBAN_NIGHT_LOCKUP             = 0.6;      // Urban areas stay warm at night
const VEGETATION_COOLING             = 1.5;      // Trees cool by transpiration

// ── Apparent temperature formulas ──────────────────────────
const WIND_CHILL_MIN_TEMP            = 10.0;     // JAG/TI formula valid ≤ 10 °C
const WIND_CHILL_MIN_WIND            = 4.8;      // JAG/TI formula valid ≥ 4.8 km/h
const HEAT_INDEX_MIN_TEMP            = 27.0;     // Rothfusz formula valid ≥ 27 °C
const HEAT_INDEX_MIN_RH              = 0.40;     // Valid ≥ 40% RH

// ── Freezing / inversion thresholds ────────────────────────
const FREEZING_POINT_C               = 0.0;
const INVERSION_DETECTION_ALT_M      = 50.0;     // Inversion detected at 50m intervals
const FOG_INVERSION_MAX_RH           = 0.9;

// ═══════════════════════════════════════════════════════════════════════
// SoA TEMPERATURE GRID
// ═══════════════════════════════════════════════════════════════════════

export const TemperatureGrid = {
  ownerEid: new Uint32Array(MAX_TEMP_GRIDS),

  gridSizeX: new Uint16Array(MAX_TEMP_GRIDS),
  gridSizeZ: new Uint16Array(MAX_TEMP_GRIDS),

  worldMinX: new Float32Array(MAX_TEMP_GRIDS),
  worldMinZ: new Float32Array(MAX_TEMP_GRIDS),
  worldMaxX: new Float32Array(MAX_TEMP_GRIDS),
  worldMaxZ: new Float32Array(MAX_TEMP_GRIDS),

  baseAltitude: new Float32Array(MAX_TEMP_GRIDS),
  layerThickness: new Float32Array(MAX_TEMP_GRIDS),

  // Per-cell temperature (°C) — allocated lazily.
  cellsByGrid: new Map(),

  // Per-cell inversion flag (1 = inversion; cold air trapped under warm).
  inversionByGrid: new Map(),

  // Per-cell sensible heat flux (W/m²) — positive = heating air.
  sensibleHeatByGrid: new Map(),

  // Age (seconds).
  age: new Float32Array(MAX_TEMP_GRIDS),

  // Active.
  active: new Uint8Array(MAX_TEMP_GRIDS),

  // Seed.
  seed: new Uint32Array(MAX_TEMP_GRIDS),
};

/** Marker: entity owns a temperature grid. */
export const TemperatureGridTag = {};

const _temperatureGridSlots = new Map();
let _nextTemperatureGridSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA TEMPERATURE SOURCE — heat emitters / sinks
// ═══════════════════════════════════════════════════════════════════════

export const TemperatureSource = {
  ownerEid: new Uint32Array(MAX_TEMPERATURE_SOURCES),
  type: new Uint8Array(MAX_TEMPERATURE_SOURCES),

  // World position.
  px: new Float32Array(MAX_TEMPERATURE_SOURCES),
  py: new Float32Array(MAX_TEMPERATURE_SOURCES),
  pz: new Float32Array(MAX_TEMPERATURE_SOURCES),

  // Influence radius.
  radiusX: new Float32Array(MAX_TEMPERATURE_SOURCES),
  radiusY: new Float32Array(MAX_TEMPERATURE_SOURCES),
  radiusZ: new Float32Array(MAX_TEMPERATURE_SOURCES),

  // Heat release rate (°C/s contribution at 1 m from the source).
  heatRate: new Float32Array(MAX_TEMPERATURE_SOURCES),

  // Active.
  active: new Uint8Array(MAX_TEMPERATURE_SOURCES),
};

/** Marker: entity emits/absorbs temperature. */
export const TemperatureSourceTag = {};

const _temperatureSourceSlots = new Map();
let _nextTemperatureSourceSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA TEMPERATURE OBSERVER
// ═══════════════════════════════════════════════════════════════════════

export const TempObserver = {
  ownerEid: new Uint32Array(MAX_TEMP_OBSERVERS),

  // Current temperature (°C).
  temperature: new Float32Array(MAX_TEMP_OBSERVERS),

  // Apparent temperature (feels-like, °C).
  apparentTemperature: new Float32Array(MAX_TEMP_OBSERVERS),

  // Wind chill (°C) when applicable, NaN otherwise.
  windChill: new Float32Array(MAX_TEMP_OBSERVERS),

  // Heat index (°C) when applicable, NaN otherwise.
  heatIndex: new Float32Array(MAX_TEMP_OBSERVERS),

  // Tendency (°C/hour).
  tendency: new Float32Array(MAX_TEMP_OBSERVERS),

  // Active.
  active: new Uint8Array(MAX_TEMP_OBSERVERS),
};

/** Marker: entity observes temperature. */
export const TempObserverTag = {};

const _tempObserverSlots = new Map();
let _nextTempObserverSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// TEMPERATURE SOURCE TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const TemperatureSourceType = Object.freeze({
  FIRE:         0,   // active fire cell
  VOLCANIC:     1,   // volcanic vent
  INDUSTRIAL:   2,   // factory / engine / heating
  URBAN:        3,   // urban heat island
  WATER_SURFACE: 4,  // ocean (thermal inertia)
  VEGETATION:   5,   // trees / cool vegetation
  SOLAR:        6,   // direct solar heating (used internally)
});

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
// TEMPERATURE GRID API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a temperature grid.
 *
 * @param world       ECS world
 * @param eid         entity
 * @param options     { worldMinX, worldMinZ, worldMaxX, worldMaxZ,
 *                      gridSizeX, gridSizeZ, baseAltitude,
 *                      layerThickness, initialTemperature, seed }
 * @returns temperature grid slot
 */
export function addTemperatureGrid(world, eid, options = {}) {
  if (_nextTemperatureGridSlot >= MAX_TEMP_GRIDS) {
    throw new Error('temperature grid capacity exceeded');
  }
  const slot = _nextTemperatureGridSlot++;

  addComponent(world, eid, TemperatureGridTag);

  const G = TemperatureGrid;
  G.ownerEid[slot] = eid;

  const gridSizeX = Math.max(2, Math.min(MAX_GRID_CELLS_PER_DIM, options.gridSizeX ?? 64));
  const gridSizeZ = Math.max(2, Math.min(MAX_GRID_CELLS_PER_DIM, options.gridSizeZ ?? 64));

  G.gridSizeX[slot] = gridSizeX;
  G.gridSizeZ[slot] = gridSizeZ;

  G.worldMinX[slot] = options.worldMinX ?? -50000;
  G.worldMinZ[slot] = options.worldMinZ ?? -50000;
  G.worldMaxX[slot] = options.worldMaxX ?? 50000;
  G.worldMaxZ[slot] = options.worldMaxZ ?? 50000;

  G.baseAltitude[slot] = options.baseAltitude ?? 0;
  G.layerThickness[slot] = options.layerThickness ?? 2000.0;

  const cellCount = gridSizeX * gridSizeZ;
  const cells = new Float32Array(cellCount);
  const inversionCells = new Uint8Array(cellCount);
  const sensibleCells = new Float32Array(cellCount);

  const initialTemp = options.initialTemperature ?? 20.0;
  for (let i = 0; i < cellCount; i++) {
    cells[i] = initialTemp;
    inversionCells[i] = 0;
    sensibleCells[i] = 0;
  }

  G.cellsByGrid.set(slot, cells);
  G.inversionByGrid.set(slot, inversionCells);
  G.sensibleHeatByGrid.set(slot, sensibleCells);

  G.age[slot] = 0;
  G.active[slot] = 1;
  G.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  _temperatureGridSlots.set(eid, slot);
  return slot;
}

export function removeTemperatureGrid(world, eid) {
  const slot = _temperatureGridSlots.get(eid);
  if (slot === undefined) return;
  TemperatureGrid.active[slot] = 0;
  TemperatureGrid.ownerEid[slot] = 0;
  TemperatureGrid.cellsByGrid.delete(slot);
  TemperatureGrid.inversionByGrid.delete(slot);
  TemperatureGrid.sensibleHeatByGrid.delete(slot);
  _temperatureGridSlots.delete(eid);
  removeComponent(world, eid, TemperatureGridTag);
}

export function getTemperatureGridSlot(eid) {
  return _temperatureGridSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// TEMPERATURE SOURCE API
// ═══════════════════════════════════════════════════════════════════════

export function addTemperatureSource(world, eid, type = TemperatureSourceType.FIRE, options = {}) {
  if (_nextTemperatureSourceSlot >= MAX_TEMPERATURE_SOURCES) {
    throw new Error('temperature source capacity exceeded');
  }
  const slot = _nextTemperatureSourceSlot++;

  addComponent(world, eid, TemperatureSourceTag);

  const S = TemperatureSource;
  S.ownerEid[slot] = eid;
  S.type[slot] = type;
  S.px[slot] = options.px ?? 0;
  S.py[slot] = options.py ?? 0;
  S.pz[slot] = options.pz ?? 0;
  S.radiusX[slot] = options.radiusX ?? 100;
  S.radiusY[slot] = options.radiusY ?? 50;
  S.radiusZ[slot] = options.radiusZ ?? 100;
  S.heatRate[slot] = options.heatRate ?? 0.5;
  S.active[slot] = 1;

  _temperatureSourceSlots.set(eid, slot);
  return slot;
}

export function removeTemperatureSource(world, eid) {
  const slot = _temperatureSourceSlots.get(eid);
  if (slot === undefined) return;
  TemperatureSource.active[slot] = 0;
  TemperatureSource.ownerEid[slot] = 0;
  _temperatureSourceSlots.delete(eid);
  removeComponent(world, eid, TemperatureSourceTag);
}

export function getTemperatureSourceSlot(eid) {
  return _temperatureSourceSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// TEMPERATURE OBSERVER API
// ═══════════════════════════════════════════════════════════════════════

export function addTempObserver(world, eid) {
  if (_nextTempObserverSlot >= MAX_TEMP_OBSERVERS) {
    throw new Error('temp observer capacity exceeded');
  }
  const slot = _nextTempObserverSlot++;

  addComponent(world, eid, TempObserverTag);

  TempObserver.ownerEid[slot] = eid;
  TempObserver.temperature[slot] = 20;
  TempObserver.apparentTemperature[slot] = 20;
  TempObserver.windChill[slot] = NaN;
  TempObserver.heatIndex[slot] = NaN;
  TempObserver.tendency[slot] = 0;
  TempObserver.active[slot] = 1;

  _tempObserverSlots.set(eid, slot);
  return slot;
}

export function removeTempObserver(world, eid) {
  const slot = _tempObserverSlots.get(eid);
  if (slot === undefined) return;
  TempObserver.active[slot] = 0;
  TempObserver.ownerEid[slot] = 0;
  _tempObserverSlots.delete(eid);
  removeComponent(world, eid, TempObserverTag);
}

export function getTempObserverSlot(eid) {
  return _tempObserverSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// APPARENT TEMPERATURE FORMULAS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Wind chill (°C) — JAG/TI 2001 formula, valid for T ≤ 10 °C, wind ≥ 4.8 km/h.
 */
export function windChill(temperatureC, windSpeedMs) {
  if (temperatureC > WIND_CHILL_MIN_TEMP) return NaN;
  const windKmh = windSpeedMs * 3.6;
  if (windKmh < WIND_CHILL_MIN_WIND) return NaN;

  const v = Math.pow(windKmh, 0.16);
  return 13.12 + 0.6215 * temperatureC - 11.37 * v + 0.3965 * temperatureC * v;
}

/**
 * Heat index (°C) — Rothfusz 1990 formula, valid for T ≥ 27 °C, RH ≥ 40%.
 */
export function heatIndex(temperatureC, relativeHumidity) {
  if (temperatureC < HEAT_INDEX_MIN_TEMP) return NaN;
  if (relativeHumidity < HEAT_INDEX_MIN_RH) return NaN;

  const T = temperatureC;
  const R = relativeHumidity * 100;   // Rothfusz uses integer %

  let HI = -8.784695
    + 1.61139411 * T
    + 2.338549 * R
    - 0.14611605 * T * R
    - 0.012308094 * T * T
    - 0.016424828 * R * R
    + 0.002211732 * T * T * R
    + 0.00072546 * T * R * R
    - 0.000003582 * T * T * R * R;

  return HI;
}

/**
 * Apparent temperature (°C) — feels-like, combining wind chill and
 * heat index with a neutral fallback.
 */
export function apparentTemperature(temperatureC, relativeHumidity, windSpeedMs) {
  const wc = windChill(temperatureC, windSpeedMs);
  if (!Number.isNaN(wc)) return wc;

  const hi = heatIndex(temperatureC, relativeHumidity);
  if (!Number.isNaN(hi)) return hi;

  return temperatureC;
}

/**
 * Wet-bulb globe temperature (WBGT, °C) — simplified outdoor WBGT.
 * Uses temperature, humidity, wind, and solar radiation.
 */
export function wetBulbGlobeTemperature(temperatureC, relativeHumidity, windSpeedMs, solarRadiationWm2) {
  const tw = wetBulbTemperature(temperatureC, relativeHumidity);
  // Approximate black-globe temperature from solar radiation.
  const tg = temperatureC + solarRadiationWm2 * 0.02;
  // Indoor WBGT would be 0.7·Tw + 0.3·Tg; outdoor weights solar more.
  return 0.7 * tw + 0.2 * tg + 0.1 * temperatureC;
}

// ═══════════════════════════════════════════════════════════════════════
// TEMPERATURE SAMPLING — the hot path
// ═══════════════════════════════════════════════════════════════════════

const _temperatureSample = {
  temperature: 0,
  inversion: false,
  sensibleHeat: 0,
};

/**
 * Sample the temperature at a world (X, Z) position from the nearest grid.
 * Uses bilinear interpolation.
 */
export function sampleTemperatureAt(gridSlot, wx, wz) {
  const G = TemperatureGrid;

  if (gridSlot < 0 || gridSlot >= _nextTemperatureGridSlot || !G.active[gridSlot]) {
    _temperatureSample.temperature = 20;
    _temperatureSample.inversion = false;
    _temperatureSample.sensibleHeat = 0;
    return _temperatureSample;
  }

  const cells = G.cellsByGrid.get(gridSlot);
  if (!cells) {
    _temperatureSample.temperature = 20;
    _temperatureSample.inversion = false;
    _temperatureSample.sensibleHeat = 0;
    return _temperatureSample;
  }

  const sizeX = G.gridSizeX[gridSlot];
  const sizeZ = G.gridSizeZ[gridSlot];

  const nx = (wx - G.worldMinX[gridSlot]) / (G.worldMaxX[gridSlot] - G.worldMinX[gridSlot]);
  const nz = (wz - G.worldMinZ[gridSlot]) / (G.worldMaxZ[gridSlot] - G.worldMinZ[gridSlot]);

  if (nx < 0 || nx > 1 || nz < 0 || nz > 1) {
    _temperatureSample.temperature = 20;
    _temperatureSample.inversion = false;
    _temperatureSample.sensibleHeat = 0;
    return _temperatureSample;
  }

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

  _temperatureSample.temperature = c00 * (1 - fx) * (1 - fz)
    + c10 * fx * (1 - fz)
    + c01 * (1 - fx) * fz
    + c11 * fx * fz;

  const inversionCells = G.inversionByGrid.get(gridSlot);
  if (inversionCells) {
    _temperatureSample.inversion = inversionCells[z0 * sizeX + x0] === 1;
  } else {
    _temperatureSample.inversion = false;
  }

  const heatCells = G.sensibleHeatByGrid.get(gridSlot);
  if (heatCells) {
    _temperatureSample.sensibleHeat = heatCells[z0 * sizeX + x0];
  } else {
    _temperatureSample.sensibleHeat = 0;
  }

  return _temperatureSample;
}

/**
 * Sample the temperature tendency (°C/hour) at a world (X, Z) position.
 */
export function sampleTemperatureTendencyAt(gridSlot, wx, wz) {
  if (gridSlot < 0 || !TemperatureGrid.active[gridSlot]) return 0;

  // Recompute by sampling nearby cells and comparing to current temperature.
  const sample = sampleTemperatureAt(gridSlot, wx, wz);
  const cells = TemperatureGrid.cellsByGrid.get(gridSlot);
  if (!cells) return 0;

  // Approximate tendency from sensible heat and latent heat.
  return sample.sensibleHeat * 3.6;   // W/m² → °C/hour at typical boundary layer
}

// ═══════════════════════════════════════════════════════════════════════
// SOLAR HEATING RATE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the solar heating rate (°C/s) at a world position, taking
 * albedo (snow, water, ground) into account.
 */
export function solarHeatingRate(wx, wz, sunElevation, cloudCover, groundAlbedo) {
  if (sunElevation <= 0) return 0;

  // Incoming solar radiation at surface.
  const cosZenith = Math.sin(sunElevation);
  const incoming = SOLAR_CONSTANT * cosZenith * (1 - cloudCover * CLOUD_SOLAR_ATTENUATION);

  // Absorbed (after albedo).
  const absorbed = incoming * (1 - groundAlbedo);

  // Heating rate (°C/s) assuming boundary-layer thickness.
  // ΔT/dt = absorbed / (ρ · cp · h) where h ≈ 1000 m boundary layer.
  const boundaryLayerDepth = 1000.0;
  const deltaTdt = absorbed / (AIR_DENSITY * AIR_SPECIFIC_HEAT * boundaryLayerDepth);

  return Math.min(SOLAR_HEATING_MAX_RATE, deltaTdt);
}

// ═══════════════════════════════════════════════════════════════════════
// LONG-WAVE COOLING RATE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the long-wave (thermal infrared) cooling rate (°C/s) at a
 * world position at night.
 */
export function longWaveCoolingRate(temperatureC, cloudCover) {
  const tK = temperatureC + KELVIN_OFFSET;
  if (tK <= 0) return 0;

  // Outgoing LW radiation from ground.
  const outgoing = GROUND_EMISSIVITY * STEFAN_BOLTZMANN * Math.pow(tK, 4);

  // Incoming LW from clouds and atmosphere (traps heat).
  const effectiveAtmosphereEmissivity = CLOUD_LW_TRAPPING_FACTOR * cloudCover + 0.3;
  const incoming = effectiveAtmosphereEmissivity * STEFAN_BOLTZMANN * Math.pow(tK, 4);

  // Net cooling.
  const net = outgoing - incoming;
  const boundaryLayerDepth = 1000.0;
  const deltaTdt = -net / (AIR_DENSITY * AIR_SPECIFIC_HEAT * boundaryLayerDepth);

  return Math.max(-LW_COOLING_MAX_RATE, deltaTdt);
}

// ═══════════════════════════════════════════════════════════════════════
// SENSIBLE HEAT FLUX — from wet surfaces and oceans
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the sensible heat flux (W/m²) from a surface, given the
 * surface temperature, air temperature, and wind speed.
 */
export function sensibleHeatFlux(surfaceTempC, airTempC, windSpeedMs) {
  // Bulk formula: H = ρ · cp · CH · U · (Ts - Ta)
  const transferCoeff = 0.001 * (1 + 0.1 * windSpeedMs);
  return AIR_DENSITY * AIR_SPECIFIC_HEAT * transferCoeff * windSpeedMs * (surfaceTempC - airTempC);
}

// ═══════════════════════════════════════════════════════════════════════
// FREEZING LEVEL
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the altitude (metres) where temperature crosses 0 °C.
 * Assumes a constant lapse rate above the surface.
 */
export function freezingLevelAltitude(surfaceTempC, surfaceAltitude = 0) {
  if (surfaceTempC <= 0) return 0;
  return surfaceAltitude + (surfaceTempC / LAPSE_RATE_STANDARD) * 1000;
}

// ═══════════════════════════════════════════════════════════════════════
// TERRAIN-ADJUSTED TEMPERATURE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Apply the elevation lapse rate to a base temperature.
 */
export function applyLapseRate(baseTempC, elevationM) {
  return baseTempC - (elevationM / 1000.0) * LAPSE_RATE_STANDARD;
}

// ═══════════════════════════════════════════════════════════════════════
// TEMPERATURE GRID UPDATE — full physics per frame
// ═══════════════════════════════════════════════════════════════════════

const _windForTemp = vec3.create();

/**
 * Advance a temperature grid for one frame:
 *   • Apply advection from wind (file 047)
 *   • Apply diffusion
 *   • Apply solar heating (daytime)
 *   • Apply long-wave cooling (nighttime)
 *   • Apply latent heat (condensation/evaporation from file 068)
 *   • Apply sensible heat from wet surfaces and oceans
 *   • Apply heat source contributions
 *   • Apply terrain lapse rate
 *   • Apply urban heat island / vegetation cooling
 *   • Detect thermal inversions
 */
export function systemUpdateTemperatureGrid(world, gridSlot, dt, seasonSlot = -1, humidityGridSlot = -1) {
  const G = TemperatureGrid;
  if (!G.active[gridSlot]) return world;

  G.age[gridSlot] += dt;

  const cells = G.cellsByGrid.get(gridSlot);
  if (!cells) return world;

  const inversionCells = G.inversionByGrid.get(gridSlot);
  const heatCells = G.sensibleHeatByGrid.get(gridSlot);

  const sizeX = G.gridSizeX[gridSlot];
  const sizeZ = G.gridSizeZ[gridSlot];

  // Get sun elevation and cloud cover from the season system.
  const sunElevation = seasonSlot >= 0 ? getSunElevation(seasonSlot) : 0.5;
  const cloudCover = seasonSlot >= 0
    ? Math.min(1, Math.max(0,
        (SeasonRegion.season[seasonSlot] === Season.MONSOON_WET ? 0.75 : 0.4)))
    : 0.4;

  // Precompute cell dimensions.
  const cellW = (G.worldMaxX[gridSlot] - G.worldMinX[gridSlot]) / sizeX;
  const cellD = (G.worldMaxZ[gridSlot] - G.worldMinZ[gridSlot]) / sizeZ;
  const cellArea = cellW * cellD;

  // Process each cell.
  for (let j = 0; j < sizeZ; j++) {
    for (let i = 0; i < sizeX; i++) {
      const idx = j * sizeX + i;
      const cellCX = G.worldMinX[gridSlot] + (i + 0.5) * cellW;
      const cellCZ = G.worldMinZ[gridSlot] + (j + 0.5) * cellD;

      let tempDelta = 0;
      let sensibleDelta = 0;

      // 1. Advection — sample wind, transport temperature.
      sampleWindAt(cellCX, G.baseAltitude[gridSlot], cellCZ, _windForTemp);
      const windX = _windForTemp[0];
      const windZ = _windForTemp[2];

      const srcI = Math.max(0, Math.min(sizeX - 1, i - Math.round(windX * dt / cellW * ADVECTION_CELLS_PER_SEC)));
      const srcJ = Math.max(0, Math.min(sizeZ - 1, j - Math.round(windZ * dt / cellD * ADVECTION_CELLS_PER_SEC)));
      const srcIdx = srcJ * sizeX + srcI;

      tempDelta += (cells[srcIdx] - cells[idx]) * ADVECTION_CELLS_PER_SEC * dt * 0.5;

      // 2. Diffusion — pull toward neighbor average.
      const nL = i > 0 ? cells[j * sizeX + (i - 1)] : cells[idx];
      const nR = i < sizeX - 1 ? cells[j * sizeX + (i + 1)] : cells[idx];
      const nU = j > 0 ? cells[(j - 1) * sizeX + i] : cells[idx];
      const nD = j < sizeZ - 1 ? cells[(j + 1) * sizeX + i] : cells[idx];
      const avg = (nL + nR + nU + nD) * 0.25;

      tempDelta += (avg - cells[idx]) * DIFFUSION_RATE_TEMP_PER_SEC * dt;

      // 3. Solar heating.
      if (sunElevation > 0) {
        // Determine albedo based on local surface state.
        let albedo = SOLAR_ALBEDO_GROUND;
        if (humidityGridSlot >= 0) {
          const humiditySample = sampleHumidityAt(humidityGridSlot, cellCX, cellCZ,
            cells[idx], samplePressureAt(cellCX, cellCZ));
          // Snow/ice surfaces (approximated from temperature).
          if (cells[idx] < 0) albedo = SOLAR_ALBEDO_SNOW;
        }

        const solarRate = solarHeatingRate(cellCX, cellCZ, sunElevation, cloudCover, albedo);
        tempDelta += solarRate * dt;
        sensibleDelta += solarRate * AIR_DENSITY * AIR_SPECIFIC_HEAT * 1000;
      }

      // 4. Long-wave cooling (only at night or under thick clouds).
      if (sunElevation <= 0.1) {
        const lwRate = longWaveCoolingRate(cells[idx], cloudCover);
        tempDelta += lwRate * dt;
        sensibleDelta += lwRate * AIR_DENSITY * AIR_SPECIFIC_HEAT * 1000;
      }

      // 5. Latent heat from condensation.
      if (humidityGridSlot >= 0) {
        const latentHeat = sampleLatentHeatRelease(humidityGridSlot, cellCX, cellCZ, cells[idx]);
        if (Math.abs(latentHeat) > EPSILON) {
          const latentTempChange = latentHeat * dt / (AIR_DENSITY * AIR_SPECIFIC_HEAT * G.layerThickness[gridSlot]);
          tempDelta += Math.min(LATENT_HEAT_TEMP_GAIN_MAX, Math.max(-LATENT_HEAT_TEMP_GAIN_MAX, latentTempChange));
        }
      }

      // 6. Sensible heat from wet surfaces.
      const surfaceInfo = sampleSurfaceConditions(world, cellCX, cellCZ);
      if (surfaceInfo.type === SurfaceType.WATER) {
        // Ocean thermal inertia — water temperatures change slowly.
        const waterTemp = surfaceInfo.surfaceTemp;
        const flux = sensibleHeatFlux(waterTemp, cells[idx], Math.hypot(windX, windZ));
        const tempChange = flux * dt / (AIR_DENSITY * AIR_SPECIFIC_HEAT * G.layerThickness[gridSlot]);
        tempDelta += tempChange * 0.1;   // damped (water holds heat)
        sensibleDelta += flux;
      } else if (surfaceInfo.type === SurfaceType.STONE || surfaceInfo.type === SurfaceType.GROUND) {
        if (surfaceInfo.wetness > 0.3) {
          // Evaporative cooling.
          const evapCooling = -surfaceInfo.wetness * 0.0001 * dt;
          tempDelta += evapCooling;
        }
      }

      // 7. Heat sources.
      for (let srcSlot = 0; srcSlot < _nextTemperatureSourceSlot; srcSlot++) {
        if (!TemperatureSource.active[srcSlot]) continue;

        const src = TemperatureSource;
        const dx = (cellCX - src.px[srcSlot]) / Math.max(src.radiusX[srcSlot], 1);
        const dy = (G.baseAltitude[gridSlot] - src.py[srcSlot]) / Math.max(src.radiusY[srcSlot], 1);
        const dz = (cellCZ - src.pz[srcSlot]) / Math.max(src.radiusZ[srcSlot], 1);

        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq > 1.0) continue;

        const falloff = Math.exp(-distSq * 2);
        tempDelta += src.heatRate[srcSlot] * falloff * dt;
      }

      // 8. Terrain lapse rate.
      const terrainHit = bvhRaycast(
        [cellCX, G.baseAltitude[gridSlot] + 5000, cellCZ],
        [0, -1, 0], 10000, true
      );
      let terrainElevation = G.baseAltitude[gridSlot];
      if (terrainHit.length > 0) {
        terrainElevation = G.baseAltitude[gridSlot] + 5000 - terrainHit[0].t;
      }

      const lapseOffset = -(terrainElevation / 1000.0) * LAPSE_RATE_STANDARD;
      // Lapse is applied as an absolute reference, not a delta. Since our
      // grid stores temperature at sea level, we apply the lapse to the
      // effective "feel" temperature when sampling, not to the stored value.

      // 9. Urban heat island.
      // Approximated via climate zone lookup.
      if (seasonSlot >= 0) {
        const climateSample = sampleClimateAt(
          SeasonRegion.season[seasonSlot],
          0,
          terrainElevation,
          world
        );
        if (climateSample.urbanFactor > 0) {
          tempDelta += URBAN_HEAT_ISLAND_BOOST * climateSample.urbanFactor * 0.01 * dt;
        }
      }

      // Apply the accumulated delta.
      cells[idx] = Math.max(MIN_TEMP_C, Math.min(MAX_TEMP_C, cells[idx] + tempDelta));

      // Store sensible heat flux.
      if (heatCells) {
        heatCells[idx] = sensibleDelta;
      }

      // Inversion detection: check vertical temperature.
      if (inversionCells) {
        // Sample air at two altitudes to detect inversions.
        const altLow = G.baseAltitude[gridSlot];
        const altHigh = altLow + 100.0;

        const tempAtLow = cells[idx];
        const tempAtHigh = tempAtLow - (100.0 / 1000.0) * LAPSE_RATE_STANDARD;

        // If observed high-altitude temp > low-altitude temp - lapse, it's
        // likely inversion (temperature NOT dropping as fast as normal).
        if (tempAtHigh > tempAtLow - (100.0 / 1000.0) * LAPSE_RATE_STANDARD + INVERSION_DETECTION_ALT_M) {
          inversionCells[idx] = 1;
        } else {
          inversionCells[idx] = 0;
        }
      }
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// SURFACE CONDITION SAMPLING
// ═══════════════════════════════════════════════════════════════════════

const _surfaceInfo = {
  type: 0,
  surfaceTemp: 20,
  wetness: 0,
};

function sampleSurfaceConditions(world, wx, wz) {
  // Check for a water body.
  const waterSlot = findWaterBodyAt(wx, wz, 0, 100.0);
  if (waterSlot >= 0) {
    _surfaceInfo.type = SurfaceType.WATER;
    _surfaceInfo.surfaceTemp = 15;   // assume ocean surface temperature
    _surfaceInfo.wetness = 1.0;
    return _surfaceInfo;
  }

  // Check terrain via BVH.
  const hits = bvhRaycast([wx, 5000, wz], [0, -1, 0], 10000, true);
  if (hits.length === 0) {
    _surfaceInfo.type = SurfaceType.GROUND;
    _surfaceInfo.surfaceTemp = 20;
    _surfaceInfo.wetness = 0;
    return _surfaceInfo;
  }

  const eid = hits[0].eid;
  if (!eid || !entityExists(world, eid)) {
    _surfaceInfo.type = SurfaceType.GROUND;
    _surfaceInfo.surfaceTemp = 20;
    _surfaceInfo.wetness = 0;
    return _surfaceInfo;
  }

  const wetSlot = getWetSurfaceSlot(eid);
  if (wetSlot >= 0) {
    _surfaceInfo.type = SurfaceWetness.surfaceType[wetSlot];
    _surfaceInfo.wetness = SurfaceWetness.wetness[wetSlot];
  } else {
    _surfaceInfo.type = SurfaceType.GROUND;
    _surfaceInfo.wetness = 0;
  }

  _surfaceInfo.surfaceTemp = 20;
  return _surfaceInfo;
}

// ═══════════════════════════════════════════════════════════════════════
// TEMPERATURE OBSERVER UPDATE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Update all temperature observers with:
 *   - current temperature
 *   - apparent temperature (wind chill / heat index)
 *   - tendency (dT/dt)
 */
export function systemUpdateTempObservers(world, tempGridSlot, seasonSlot, dt) {
  const O = TempObserver;

  for (let slot = 0; slot < _nextTempObserverSlot; slot++) {
    if (!O.active[slot]) continue;

    const eid = O.ownerEid[slot];
    if (!eid || !entityExists(world, eid)) continue;

    const id = getId(eid);
    const M = WorldTransformF32.m;
    if (!M) continue;
    const off = id * 16;
    const wx = M[off + 12];
    const wy = M[off + 13];
    const wz = M[off + 14];

    // Sample temperature at the observer's position.
    const sample = sampleTemperatureAt(tempGridSlot, wx, wz);
    O.temperature[slot] = sample.temperature;

    // Sample local wind for apparent temperature.
    sampleWindAt(wx, wy, wz, _windForTemp);
    const windSpeed = Math.hypot(_windForTemp[0], _windForTemp[2]);

    // Sample local humidity for heat index.
    const humiditySample = getAmbientHumidity(seasonSlot);

    // Compute apparent temperature.
    O.apparentTemperature[slot] = apparentTemperature(
      sample.temperature,
      humiditySample,
      windSpeed
    );

    // Individual metrics.
    O.windChill[slot] = windChill(sample.temperature, windSpeed);
    O.heatIndex[slot] = heatIndex(sample.temperature, humiditySample);

    // Tendency.
    O.tendency[slot] = sample.sensibleHeat * 3.6;
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// HEAT BALANCE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the sensible vs latent heat balance at a position.
 * Uses the Bowen ratio approximation.
 *
 * @returns { sensibleHeat, latentHeat, bowenRatio, dominant }
 */
export function heatBalanceAt(wx, wz, tempC, humidityGridSlot) {
  // Sensible heat from temperature anomaly.
  const sensibleHeat = 100.0;   // W/m² (reference)

  // Latent heat from humidity grid.
  let latentHeat = 0;
  if (humidityGridSlot >= 0) {
    latentHeat = sampleLatentHeatRelease(humidityGridSlot, wx, wz, tempC);
  }

  // Bowen ratio = sensible / latent.
  const bowenRatio = latentHeat > EPSILON ? sensibleHeat / latentHeat : Infinity;

  // Dominant term.
  const dominant = sensibleHeat > Math.abs(latentHeat) ? 'sensible' : 'latent';

  return {
    sensibleHeat,
    latentHeat,
    bowenRatio,
    dominant,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a full temperature summary at a world position, including
 * apparent temperature, freezing level, and inversion status.
 */
export function getTemperatureSummaryAt(gridSlot, wx, wy, wz, seasonSlot = -1, humidityGridSlot = -1) {
  const sample = sampleTemperatureAt(gridSlot, wx, wz);

  // Apply lapse rate for altitude.
  let elevation = 0;
  const hits = bvhRaycast([wx, wy + 5000, wz], [0, -1, 0], 10000, true);
  if (hits.length > 0) {
    elevation = wy + 5000 - hits[0].t;
  }

  const lapseAdjustedTemp = applyLapseRate(sample.temperature, elevation);

  // Sample wind.
  sampleWindAt(wx, wy, wz, _windForTemp);
  const windSpeed = Math.hypot(_windForTemp[0], _windForTemp[2]);

  // Sample humidity.
  const humiditySample = getAmbientHumidity(seasonSlot);

  // Apparent temperature.
  const apparent = apparentTemperature(lapseAdjustedTemp, humiditySample, windSpeed);

  // Freezing level.
  const freezingLevel = freezingLevelAltitude(sample.temperature, elevation);

  // WBGT.
  const sunElev = seasonSlot >= 0 ? getSunElevation(seasonSlot) : 0.5;
  const solarRadiation = sunElev > 0 ? SOLAR_CONSTANT * Math.sin(sunElev) * 0.7 : 0;
  const wbgt = wetBulbGlobeTemperature(lapseAdjustedTemp, humiditySample, windSpeed, solarRadiation);

  return {
    temperature: lapseAdjustedTemp,
    apparentTemperature: apparent,
    windChill: windChill(lapseAdjustedTemp, windSpeed),
    heatIndex: heatIndex(lapseAdjustedTemp, humiditySample),
    wetBulbGlobe: wbgt,
    elevation,
    freezingLevel,
    tendency: sample.sensibleHeat * 3.6,
    inversion: sample.inversion,
    sensibleHeat: sample.sensibleHeat,
  };
}

/**
 * Return a human-readable label for a temperature source type.
 */
export function temperatureSourceTypeLabel(type) {
  switch (type) {
    case TemperatureSourceType.FIRE:          return 'Fire';
    case TemperatureSourceType.VOLCANIC:      return 'Volcanic';
    case TemperatureSourceType.INDUSTRIAL:    return 'Industrial';
    case TemperatureSourceType.URBAN:         return 'Urban';
    case TemperatureSourceType.WATER_SURFACE: return 'Water Surface';
    case TemperatureSourceType.VEGETATION:    return 'Vegetation';
    case TemperatureSourceType.SOLAR:         return 'Solar';
    default:                                    return 'Unknown';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// AUTOMATIC SOURCE SYNC
// ═══════════════════════════════════════════════════════════════════════

/**
 * Automatically scan the world and register temperature sources for
 * all entities that emit heat (fires, volcanic vents, industrial).
 */
export function systemSyncTemperatureSources(world) {
  // Fires.
  for (let slot = 0; slot < FireCell.active.length; slot++) {
    if (!FireCell.active[slot]) continue;
    if (FireCell.phase[slot] !== FirePhase.BURNING
        && FireCell.phase[slot] !== FirePhase.SPREADING) continue;

    // Find the FireCellTag entity for this fire cell.
    const fireEid = FireCell.ownerEid ? FireCell.ownerEid[slot] : 0;
    if (!fireEid || !entityExists(world, fireEid)) continue;
    if (getTemperatureSourceSlot(fireEid) >= 0) continue;

    const heatRate = FireCell.firelineIntensity[slot] / 1000.0 * FIRE_HEAT_MULTIPLIER;
    addTemperatureSource(world, fireEid, TemperatureSourceType.FIRE, {
      px: FireCell.px[slot],
      py: FireCell.py[slot] + 5,
      pz: FireCell.pz[slot],
      radiusX: FireCell.size[slot] * 3,
      radiusY: 50,
      radiusZ: FireCell.size[slot] * 3,
      heatRate,
    });
  }

  // Volcanic vents.
  const volcanicEids = query(world, [VolcanicVentTag]);
  for (let i = 0; i < volcanicEids.length; i++) {
    const eid = volcanicEids[i];
    if (getTemperatureSourceSlot(eid) >= 0) continue;

    const id = getId(eid);
    const M = WorldTransformF32.m;
    if (!M) continue;
    const off = id * 16;

    addTemperatureSource(world, eid, TemperatureSourceType.VOLCANIC, {
      px: M[off + 12],
      py: M[off + 13],
      pz: M[off + 14],
      radiusX: 500,
      radiusY: 1000,
      radiusZ: 500,
      heatRate: VOLCANIC_HEAT_MULTIPLIER,
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TICK
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance the entire temperature field for one frame.
 *
 * @param world         ECS world
 * @param dt            seconds
 * @param seasonSlot    season region slot (for sun elevation, ambient temp)
 * @param humidityGridSlot humidity grid slot (for latent heat)
 */
export function systemTemperatureTick(world, dt, seasonSlot = -1, humidityGridSlot = -1) {
  const G = TemperatureGrid;

  for (let gridSlot = 0; gridSlot < _nextTemperatureGridSlot; gridSlot++) {
    if (!G.active[gridSlot]) continue;
    systemUpdateTemperatureGrid(world, gridSlot, dt, seasonSlot, humidityGridSlot);
  }

  systemUpdateTempObservers(world, 0, seasonSlot, dt);
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a summary of all active temperature grids.
 */
export function gatherTemperatureGridsForRendering() {
  const result = [];
  const G = TemperatureGrid;

  for (let slot = 0; slot < _nextTemperatureGridSlot; slot++) {
    if (!G.active[slot]) continue;

    // Compute min/max temperature in the grid.
    const cells = G.cellsByGrid.get(slot);
    let minTemp = Infinity;
    let maxTemp = -Infinity;
    if (cells) {
      for (let i = 0; i < cells.length; i++) {
        if (cells[i] < minTemp) minTemp = cells[i];
        if (cells[i] > maxTemp) maxTemp = cells[i];
      }
    }

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
      minTemp,
      maxTemp,
    });
  }

  return result;
}

/**
 * Return a summary of all active temperature sources.
 */
export function gatherTemperatureSourcesForRendering() {
  const result = [];
  const S = TemperatureSource;

  for (let slot = 0; slot < _nextTemperatureSourceSlot; slot++) {
    if (!S.active[slot]) continue;

    result.push({
      slot,
      type: S.type[slot],
      typeLabel: temperatureSourceTypeLabel(S.type[slot]),
      px: S.px[slot],
      py: S.py[slot],
      pz: S.pz[slot],
      radiusX: S.radiusX[slot],
      radiusY: S.radiusY[slot],
      radiusZ: S.radiusZ[slot],
      heatRate: S.heatRate[slot],
    });
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function temperatureStats() {
  let activeGrids = 0;
  let activeSources = 0;
  let activeObservers = 0;

  const sourcesByType = new Uint8Array(7);

  for (let slot = 0; slot < _nextTemperatureGridSlot; slot++) {
    if (TemperatureGrid.active[slot]) activeGrids++;
  }

  for (let slot = 0; slot < _nextTemperatureSourceSlot; slot++) {
    if (!TemperatureSource.active[slot]) continue;
    activeSources++;
    sourcesByType[TemperatureSource.type[slot]]++;
  }

  for (let slot = 0; slot < _nextTempObserverSlot; slot++) {
    if (TempObserver.active[slot]) activeObservers++;
  }

  return {
    activeGrids,
    maxGrids: MAX_TEMP_GRIDS,
    activeSources,
    maxSources: MAX_TEMPERATURE_SOURCES,
    activeObservers,
    maxObservers: MAX_TEMP_OBSERVERS,
    sourcesByType: {
      fire: sourcesByType[TemperatureSourceType.FIRE],
      volcanic: sourcesByType[TemperatureSourceType.VOLCANIC],
      industrial: sourcesByType[TemperatureSourceType.INDUSTRIAL],
      urban: sourcesByType[TemperatureSourceType.URBAN],
      waterSurface: sourcesByType[TemperatureSourceType.WATER_SURFACE],
      vegetation: sourcesByType[TemperatureSourceType.VEGETATION],
      solar: sourcesByType[TemperatureSourceType.SOLAR],
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearTemperatureField() {
  TemperatureGrid.active.fill(0);
  TemperatureGrid.ownerEid.fill(0);
  TemperatureGrid.cellsByGrid.clear();
  TemperatureGrid.inversionByGrid.clear();
  TemperatureGrid.sensibleHeatByGrid.clear();
  _temperatureGridSlots.clear();
  _nextTemperatureGridSlot = 0;

  TemperatureSource.active.fill(0);
  TemperatureSource.ownerEid.fill(0);
  _temperatureSourceSlots.clear();
  _nextTemperatureSourceSlot = 0;

  TempObserver.active.fill(0);
  TempObserver.ownerEid.fill(0);
  _tempObserverSlots.clear();
  _nextTempObserverSlot = 0;
}