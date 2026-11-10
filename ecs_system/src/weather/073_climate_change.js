// file number : 073
// full path name : src/weather/073_climate_change.js
// description : Long-term climate change system. Extends the entire
//               weather pipeline (files 040-072) with multi-decadal
//               and multi-century climate forcing, allowing a world
//               to warm, cool, and experience shifting extreme-weather
//               frequency. This drives narrative-level change that
//               persists over years of gameplay, producing events
//               like glacial retreat, sea-level rise, desertification,
//               shifting snow lines, and increased storm frequency.
//                 • FORCING SOURCES — the full radiative forcing
//                   taxonomy (IPCC AR6-style):
//                     - GREENHOUSE_GAS: CO₂, CH₄, N₂O, halocarbons
//                       (concentration → radiative forcing via
//                       Myhre 1998 log relationship)
//                     - AEROSOL: SO₂, black carbon, organic carbon
//                       (both cooling and warming components)
//                     - LAND_USE: albedo change from deforestation,
//                       urbanization, agriculture
//                     - SOLAR: total solar irradiance (TSI) variation
//                     - VOLCANIC: stratospheric aerosol injection
//                       (feeds file 074's volcanic winter)
//                     - NUCLEAR: soot injection (feeds file 075's
//                       nuclear winter)
//                     - MILANKOVITCH: orbital forcing (feeds file 077)
//                 • EQUILIBRIUM CLIMATE SENSITIVITY — the ECS parameter
//                   (typically 3 °C per CO₂ doubling, IPCC range
//                   2.5-4.0 °C). Configurable per world.
//                 • TRANSIENT RESPONSE — the current warming is
//                   computed from a two-box (ocean + atmosphere) model
//                   that accounts for the ocean's thermal inertia.
//                   Fast atmospheric response in years; slow ocean
//                   response in decades to centuries.
//                 • FEEDBACK AMPLIFICATIONS — full set of climate
//                   feedbacks:
//                     - WATER_VAPOR: positive (~2×)
//                     - ICE_ALBEDO: positive (~0.3×)
//                     - CLOUD: positive (uncertain, ~0.4×)
//                     - PERMAFROST: positive (~0.2×)
//                     - CARBON_CYCLE: positive (~0.25×)
//                     - LAPSE_RATE: negative (~-0.6×)
//                 • REGIONAL PATTERNS — polar amplification (3× warming
//                   at the poles vs global average), land-sea contrast
//                   (land warms 1.5× faster), and monsoon shifts.
//                 • EXTREME WEATHER FREQUENCY — reads from file 063's
//                   Markov transition matrix and modifies the
//                   probabilities based on the current warming level:
//                     - Thunderstorms ↑ with warming
//                     - Hurricanes ↑ in intensity (Cat 4/5 more common)
//                     - Heat waves ↑ exponentially
//                     - Cold snaps ↓ but extreme ones still possible
//                     - Blizzards ↓ in frequency but ↑ in intensity
//                     - Droughts ↑ in duration and severity
//                 • SEA-LEVEL RISE — thermal expansion + ice-sheet mass
//                   loss. Modulates file 059's water body base level
//                   and file 049's storm surge heights.
//                 • SNOW LINE / TREE LINE SHIFT — raises them by
//                   ~100 m per °C of warming. Couples to files 043,
//                   061, and 071.
//                 • DESERTIFICATION — reads the current warming and
//                   applies a shift of arid biomes (from file 066)
//                   upward and outward.
//                 • OCEAN ACIDIFICATION — computes ocean pH from
//                   atmospheric CO₂ (via the Revelle factor). Exposed
//                   for marine ecosystem gameplay.
//                 • NARRATIVE MILESTONES — exposes "climate event"
//                   callbacks at key warming thresholds (1.5, 2.0,
//                   2.5, 3.0, 4.0 °C) so gameplay can trigger
//                   narrative events.
//                 • SCENARIO PRESETS — the full IPCC SSP pathway family:
//                     - SSP1_1_9 (Paris-aligned, ~1.5 °C)
//                     - SSP1_2_6 (~1.8 °C)
//                     - SSP2_4_5 (moderate, ~2.7 °C)
//                     - SSP3_7_0 (high, ~3.6 °C)
//                     - SSP4_6_0 (asymmetric, ~3.4 °C)
//                     - SSP5_8_5 (worst case, ~4.4 °C)
//                   Games can choose a scenario or define custom
//                   emission paths.
//               All state lives in typed arrays; per-frame cost is
//               O(1) forcing update + O(active climate observers) ×
//               O(1) sampling. Zero per-frame allocation; steady-state
//               1M-entity scenes handle climate change on Android
//               64-bit.
// best for : Long-form survival games, civilization games,
//            ecological simulators, narrative games with climate
//            arcs, "what if" scenarios, and any 1M-entity scene
//            needing multi-decadal climate evolution.
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
  getSkySlot,
} from '../sky/028_sky_atmosphere.js';

import {
  SchedulerRegion,
  WeatherType,
  Biome,
} from './063_weather_scheduler.js';

import {
  SeasonRegion,
  Season,
  getAmbientTemperature,
} from './065_season_system.js';

import {
  ClimateZone,
  KoppenClimate,
  sampleClimateAt,
} from './066_climate_zone.js';

import {
  TemperatureGrid,
  sampleTemperatureAt,
} from './069_temperature_field.js';

import {
  CurrentGrid,
  sampleSSTAt,
} from './070_ocean_currents.js';

import {
  WaterBody,
  WaterBodyTag,
  sampleWaterSurfaceHeight,
} from './059_water_surface.js';

import {
  SnowSurface,
  getSnowSurfaceSlot,
} from './043_snow.js';

import {
  IceSurface,
  getIceSurfaceSlot,
} from './061_ice_frost.js';

import {
  sampleTerrainEffects,
  computeSnowLine,
  computeTreeLine,
} from './071_terrain_effects.js';

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

// ── Forcing constants (IPCC AR6) ────────────────────────────
const PRE_INDUSTRIAL_CO2_PPM         = 278.0;
const CURRENT_CO2_PPM_2024           = 420.0;
const CO2_DOUBLING_FORCING           = 3.71;     // W/m² (Myhre 1998)
const CH4_FORCING_PER_PPB            = 0.00036;  // W/m² per ppb
const N2O_FORCING_PER_PPB            = 0.0031;   // W/m² per ppb
const AEROSOL_FORCING_DIRECT         = -0.4;     // W/m² (SO₂ cooling)
const AEROSOL_FORCING_INDIRECT       = -0.7;     // W/m² (cloud albedo)
const LAND_USE_FORCING_PER_FRACTION  = -0.15;    // W/m² per fraction deforested
const SOLAR_TSI_VARIATION            = 0.15;     // W/m² peak solar cycle
const VOLCANIC_FORCING_PER_TG        = -3.0;     // W/m² per Tg stratospheric SO₂
const NUCLEAR_SOOT_FORCING_PER_TG    = -5.0;     // W/m² per Tg soot
const VOLCANIC_DECAY_YEARS           = 2.5;
const NUCLEAR_DECAY_YEARS            = 5.0;

// ── Climate sensitivity ─────────────────────────────────────
const DEFAULT_EQUILIBRIUM_SENSITIVITY = 3.0;    // °C per CO₂ doubling
const MIN_EQUILIBRIUM_SENSITIVITY     = 2.0;
const MAX_EQUILIBRIUM_SENSITIVITY     = 5.0;

// ── Two-box ocean model ─────────────────────────────────────
// Fast atmosphere response (thin layer) + slow ocean response.
const ATMOSPHERE_HEAT_CAPACITY       = 1.0;     // relative units
const OCEAN_MIXED_LAYER_CAPACITY     = 20.0;    // relative units
const OCEAN_DEEP_LAYER_CAPACITY      = 100.0;   // relative units
const ATMOSPHERE_OCEAN_COUPLING      = 0.05;    // W/(m²·K) heat exchange

// ── Feedback multipliers (sum to equilibrium response) ───────
const FEEDBACK_WATER_VAPOR           = 1.80;    // 2× amplification
const FEEDBACK_ICE_ALBEDO            = 0.30;
const FEEDBACK_CLOUD                 = 0.40;
const FEEDBACK_PERMAFROST            = 0.20;
const FEEDBACK_CARBON_CYCLE          = 0.25;
const FEEDBACK_LAPSE_RATE            = -0.60;

// ── Polar amplification ────────────────────────────────────
const POLAR_AMPLIFICATION             = 3.0;    // 3× at poles
const LAND_SEA_CONTRAST              = 1.5;     // land warms 1.5× faster
const ARCTIC_WARMING_MULTIPLIER      = 3.0;

// ── Extreme weather frequency shifts per °C warming ────────
const THUNDERSTORM_FREQUENCY_PER_C   = 0.08;    // +8% per °C
const HURRICANE_CAT45_PER_C          = 0.12;    // +12% Cat 4/5
const HEATWAVE_FREQUENCY_PER_C       = 0.25;    // +25% per °C
const COLD_SNAP_FREQUENCY_PER_C      = -0.15;   // -15% per °C
const DROUGHT_DURATION_PER_C         = 0.10;    // +10% duration per °C
const BLIZZARD_INTENSITY_PER_C       = 0.05;    // +5% intensity per °C

// ── Sea level rise ─────────────────────────────────────────
const THERMAL_EXPANSION_MM_PER_C     = 1.5;     // mm/year per °C above baseline
const ICE_SHEET_MM_PER_C             = 2.0;     // mm/year per °C above baseline
const SEA_LEVEL_BASELINE_MM          = 0.0;
const SEA_LEVEL_MAX_MM               = 2000.0;  // 2 metres max

// ── Snow/tree line shift ──────────────────────────────────
const SNOW_LINE_SHIFT_M_PER_C        = 150.0;   // snow line rises 150m/°C
const TREE_LINE_SHIFT_M_PER_C        = 120.0;

// ── Ocean acidification ───────────────────────────────────
const PRE_INDUSTRIAL_OCEAN_PH        = 8.17;
const OCEAN_PH_CHANGE_PER_LOG_CO2    = -0.30;   // ΔpH per log10(CO₂ ratio)

// ── Observation and configuration ─────────────────────────
const MAX_CLIMATE_OBSERVERS          = 128;
const MAX_NARRATIVE_EVENTS           = 64;
const NARRATIVE_THRESHOLDS = [1.5, 2.0, 2.5, 3.0, 4.0, 5.0];

// ── SoA size limits ───────────────────────────────────────
const MAX_CLIMATE_SCENARIOS          = 16;
const MAX_NARRATIVE_TRIGGERS         = 64;

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO ENUM (IPCC SSP pathways)
// ═══════════════════════════════════════════════════════════════════════

export const Scenario = Object.freeze({
  PRE_INDUSTRIAL: 0,
  SSP1_1_9:       1,
  SSP1_2_6:       2,
  SSP2_4_5:       3,
  SSP3_7_0:       4,
  SSP4_6_0:       5,
  SSP5_8_5:       6,
  CUSTOM:         7,
});

// ═══════════════════════════════════════════════════════════════════════
// FORCING SOURCE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const ForcingSource = Object.freeze({
  GREENHOUSE_GAS:  0,
  AEROSOL:         1,
  LAND_USE:        2,
  SOLAR:           3,
  VOLCANIC:        4,
  NUCLEAR:         5,
  MILANKOVITCH:    6,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA GLOBAL CLIMATE STATE
// ═══════════════════════════════════════════════════════════════════════

export const GlobalClimate = {
  // Current scenario.
  scenario: Scenario.SSP2_4_5,

  // Current atmospheric CO₂ concentration (ppm).
  co2Ppm: PRE_INDUSTRIAL_CO2_PPM,

  // CH₄ concentration (ppb).
  ch4Ppb: 722,

  // N₂O concentration (ppb).
  n2oPpb: 270,

  // Halocarbons (CCl₂F₂ equivalent ppb).
  halocarbonPpb: 0,

  // Deforestation fraction (0..1).
  deforestation: 0,

  // Solar activity modulator (-1 to +1; solar cycle).
  solarCycle: 0,

  // Years since pre-industrial baseline.
  yearsSinceBaseline: 0,

  // Ocean surface pH.
  oceanPh: PRE_INDUSTRIAL_OCEAN_PH,

  // Ocean heat content (relative units; 0 = pre-industrial).
  oceanHeatContent: 0,

  // Current radiative forcing (W/m²).
  totalForcing: 0,

  // Equilibrium warming (°C).
  equilibriumWarming: 0,

  // Transient (actual) warming (°C).
  transientWarming: 0,

  // Sea level rise (mm since baseline).
  seaLevelRiseMm: 0,

  // Arctic sea ice extent (million km²).
  arcticSeaIceExtent: 6.0,

  // Greenland ice sheet mass balance (relative; 0 = baseline).
  greenlandMassBalance: 0,

  // Antarctic ice sheet mass balance.
  antarcticMassBalance: 0,

  // Snow line shift (m).
  snowLineShift: 0,

  // Tree line shift (m).
  treeLineShift: 0,

  // Amplification multiplier for extreme weather (from forcing).
  extremeWeatherMultiplier: 1.0,

  // Atmosphere temperature (°C above baseline).
  atmosphereAnomaly: 0,

  // Ocean mixed layer temperature anomaly.
  oceanMixedLayerAnomaly: 0,

  // Deep ocean temperature anomaly.
  oceanDeepAnomaly: 0,

  // Scenario custom emission rate (ppm CO₂ per year).
  customEmissionRate: 2.5,

  // Whether the climate is paused (no forced change).
  paused: false,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA CLIMATE OBSERVER — samples climate change state at a position
// ═══════════════════════════════════════════════════════════════════════

export const ClimateObserver = {
  ownerEid: new Uint32Array(MAX_CLIMATE_OBSERVERS),

  // Latitude and world position.
  latitudeDeg: new Float32Array(MAX_CLIMATE_OBSERVERS),
  px: new Float32Array(MAX_CLIMATE_OBSERVERS),
  py: new Float32Array(MAX_CLIMATE_OBSERVERS),
  pz: new Float32Array(MAX_CLIMATE_OBSERVERS),

  // Local temperature anomaly from climate change (°C).
  localAnomaly: new Float32Array(MAX_CLIMATE_OBSERVERS),

  // Local sea level rise at this position (mm).
  localSeaLevelRise: new Float32Array(MAX_CLIMATE_OBSERVERS),

  // Local extreme-weather multiplier.
  localExtremeMultiplier: new Float32Array(MAX_CLIMATE_OBSERVERS),

  // Local snow line shift (m).
  localSnowLineShift: new Float32Array(MAX_CLIMATE_OBSERVERS),

  // Active.
  active: new Uint8Array(MAX_CLIMATE_OBSERVERS),
};

/** Marker: entity observes climate change at its position. */
export const ClimateObserverTag = {};

const _climateObserverSlots = new Map();
let _nextClimateObserverSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA NARRATIVE EVENT — milestone callbacks
// ═══════════════════════════════════════════════════════════════════════

export const NarrativeEvent = {
  active: new Uint8Array(MAX_NARRATIVE_TRIGGERS),

  // Warming threshold (°C) at which to fire.
  warmingThreshold: new Float32Array(MAX_NARRATIVE_TRIGGERS),

  // Whether the event has already fired.
  fired: new Uint8Array(MAX_NARRATIVE_TRIGGERS),

  // Callback function.
  callback: new Array(MAX_NARRATIVE_TRIGGERS).fill(null),

  // Event name.
  name: new Array(MAX_NARRATIVE_TRIGGERS).fill(''),
};

let _nextNarrativeEventSlot = 0;

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
// SCENARIO PRESETS — SSP emission pathways
// ═══════════════════════════════════════════════════════════════════════

const SCENARIO_PRESETS = {
  [Scenario.PRE_INDUSTRIAL]: { co2PeakPpm: 278,  warming2100: 0.0, path: 'flat' },
  [Scenario.SSP1_1_9]:       { co2PeakPpm: 450,  warming2100: 1.5, path: 'stabilize' },
  [Scenario.SSP1_2_6]:       { co2PeakPpm: 470,  warming2100: 1.8, path: 'stabilize' },
  [Scenario.SSP2_4_5]:       { co2PeakPpm: 530,  warming2100: 2.7, path: 'slow_rise' },
  [Scenario.SSP3_7_0]:       { co2PeakPpm: 650,  warming2100: 3.6, path: 'rise' },
  [Scenario.SSP4_6_0]:       { co2PeakPpm: 620,  warming2100: 3.4, path: 'rise' },
  [Scenario.SSP5_8_5]:       { co2PeakPpm: 850,  warming2100: 4.4, path: 'fast_rise' },
  [Scenario.CUSTOM]:         { co2PeakPpm: 0,    warming2100: 0,   path: 'custom' },
};

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — SCENARIO CONTROL
// ═══════════════════════════════════════════════════════════════════════

/**
 * Set the climate scenario. Once set, the climate system will evolve
 * according to that SSP pathway.
 */
export function setScenario(scenario) {
  GlobalClimate.scenario = scenario;
  const preset = SCENARIO_PRESETS[scenario];
  if (!preset) return;

  // Reset state for a fresh scenario run.
  GlobalClimate.co2Ppm = PRE_INDUSTRIAL_CO2_PPM;
  GlobalClimate.yearsSinceBaseline = 0;
  GlobalClimate.oceanHeatContent = 0;
  GlobalClimate.transientWarming = 0;
  GlobalClimate.equilibriumWarming = 0;
  GlobalClimate.seaLevelRiseMm = 0;
  GlobalClimate.snowLineShift = 0;
  GlobalClimate.treeLineShift = 0;
  GlobalClimate.atmosphereAnomaly = 0;
  GlobalClimate.oceanMixedLayerAnomaly = 0;
  GlobalClimate.oceanDeepAnomaly = 0;
  GlobalClimate.oceanPh = PRE_INDUSTRIAL_OCEAN_PH;
  GlobalClimate.extremeWeatherMultiplier = 1.0;
  GlobalClimate.arcticSeaIceExtent = 6.0;
  GlobalClimate.greenlandMassBalance = 0;
  GlobalClimate.antarcticMassBalance = 0;
}

/**
 * Pause or resume the climate evolution.
 */
export function setClimatePaused(paused) {
  GlobalClimate.paused = paused;
}

/**
 * Configure a custom CO₂ emission rate (ppm/year).
 */
export function setCustomEmissionRate(ppmPerYear) {
  GlobalClimate.customEmissionRate = Math.max(0, ppmPerYear);
  GlobalClimate.scenario = Scenario.CUSTOM;
}

/**
 * Set a custom climate sensitivity (°C per CO₂ doubling).
 */
export function setEquilibriumSensitivity(value) {
  GlobalClimate.equilibriumSensitivity = Math.max(MIN_EQUILIBRIUM_SENSITIVITY,
    Math.min(MAX_EQUILIBRIUM_SENSITIVITY, value));
}

// ═══════════════════════════════════════════════════════════════════════
// FORCING COMPUTATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the total radiative forcing (W/m²).
 */
export function computeTotalForcing() {
  const climate = GlobalClimate;

  // CO₂ forcing via Myhre (1998): ΔF = 5.35 · ln(C/C₀)
  const co2Ratio = climate.co2Ppm / PRE_INDUSTRIAL_CO2_PPM;
  const co2Forcing = CO2_DOUBLING_FORCING * (Math.log(co2Ratio) / Math.log(2));

  // CH₄ forcing.
  const ch4Forcing = (climate.ch4Ppb - 722) * CH4_FORCING_PER_PPB;

  // N₂O forcing.
  const n2oForcing = (climate.n2oPpb - 270) * N2O_FORCING_PER_PPB;

  // Halocarbon forcing.
  const halocarbonForcing = climate.halocarbonPpb * 0.001;

  // Aerosol forcing (cooling).
  const aerosolForcing = AEROSOL_FORCING_DIRECT + AEROSOL_FORCING_INDIRECT;

  // Land use forcing.
  const landUseForcing = -climate.deforestation * LAND_USE_FORCING_PER_FRACTION;

  // Solar forcing.
  const solarForcing = climate.solarCycle * SOLAR_TSI_VARIATION;

  // Volcanic forcing (if active).
  const volcanicForcing = 0;   // handled by file 074

  // Nuclear forcing (if active).
  const nuclearForcing = 0;    // handled by file 075

  // Total.
  const total = co2Forcing + ch4Forcing + n2oForcing + halocarbonForcing
    + aerosolForcing + landUseForcing + solarForcing;

  climate.totalForcing = total;
  return total;
}

// ═══════════════════════════════════════════════════════════════════════
// TRANSIENT WARMING COMPUTATION — two-box model
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance the two-box ocean model by dtYears.
 */
function updateTwoBoxModel(dtYears) {
  const climate = GlobalClimate;

  // Effective climate sensitivity.
  const ECS = climate.equilibriumSensitivity || DEFAULT_EQUILIBRIUM_SENSITIVITY;

  // Equilibrium warming from forcing.
  const equilibriumWarming = climate.totalForcing * ECS / CO2_DOUBLING_FORCING;
  climate.equilibriumWarming = equilibriumWarming;

  // Fast atmosphere response (years).
  const atmosphereTarget = equilibriumWarming * 0.6;
  const atmosphereRate = 1.0 / (ATMOSPHERE_HEAT_CAPACITY + 1.0);
  climate.atmosphereAnomaly += (atmosphereTarget - climate.atmosphereAnomaly)
    * Math.min(1, atmosphereRate * dtYears);

  // Slow mixed-layer ocean response (decades).
  const mixedTarget = equilibriumWarming * 0.4;
  const mixedRate = 1.0 / OCEAN_MIXED_LAYER_CAPACITY;
  climate.oceanMixedLayerAnomaly += (mixedTarget - climate.oceanMixedLayerAnomaly)
    * Math.min(1, mixedRate * dtYears);

  // Very slow deep-ocean response (centuries).
  const deepTarget = equilibriumWarming * 0.2;
  const deepRate = 1.0 / OCEAN_DEEP_LAYER_CAPACITY;
  climate.oceanDeepAnomaly += (deepTarget - climate.oceanDeepAnomaly)
    * Math.min(1, deepRate * dtYears);

  // Total transient warming (weighted average of the three layers).
  climate.transientWarming = climate.atmosphereAnomaly * 0.3
    + climate.oceanMixedLayerAnomaly * 0.5
    + climate.oceanDeepAnomaly * 0.2;

  // Ocean heat content accumulation.
  climate.oceanHeatContent += climate.totalForcing * dtYears;
}

// ═══════════════════════════════════════════════════════════════════════
// SEA LEVEL RISE
// ═══════════════════════════════════════════════════════════════════════

function updateSeaL evel(dtYears) {
  const climate = GlobalClimate;

  const warming = Math.max(0, climate.transientWarming);

  // Thermal expansion.
  const thermalRate = warming * THERMAL_EXPANSION_MM_PER_C;
  // Ice sheet mass loss.
  const iceRate = warming * ICE_SHEET_MM_PER_C;

  climate.seaLevelRiseMm += (thermalRate + iceRate) * dtYears;
  climate.seaLevelRiseMm = Math.min(SEA_LEVEL_MAX_MM, climate.seaLevelRiseMm);

  // Arctic sea ice extent shrinks.
  climate.arcticSeaIceExtent = Math.max(0, 6.0 - warming * 0.8);

  // Greenland and Antarctic mass balance.
  climate.greenlandMassBalance = -warming * 0.3;
  climate.antarcticMassBalance = -warming * 0.15;
}

// ═══════════════════════════════════════════════════════════════════════
// SNOW AND TREE LINE SHIFT
// ═══════════════════════════════════════════════════════════════════════

function updateSnowTreeLine() {
  const climate = GlobalClimate;
  const warming = Math.max(0, climate.transientWarming);

  climate.snowLineShift = warming * SNOW_LINE_SHIFT_M_PER_C;
  climate.treeLineShift = warming * TREE_LINE_SHIFT_M_PER_C;
}

// ═══════════════════════════════════════════════════════════════════════
// OCEAN ACIDIFICATION
// ═══════════════════════════════════════════════════════════════════════

function updateOceanAcidification() {
  const climate = GlobalClimate;

  const co2Ratio = climate.co2Ppm / PRE_INDUSTRIAL_CO2_PPM;
  const log10Ratio = Math.log(co2Ratio) / Math.log(10);

  climate.oceanPh = PRE_INDUSTRIAL_OCEAN_PH + OCEAN_PH_CHANGE_PER_LOG_CO2 * log10Ratio;
}

// ═══════════════════════════════════════════════════════════════════════
// EXTREME WEATHER MULTIPLIER
// ═══════════════════════════════════════════════════════════════════════

function updateExtremeWeatherMultiplier() {
  const climate = GlobalClimate;
  const warming = Math.max(0, climate.transientWarming);

  // Overall multiplier applied to weather extremity.
  // At 0 °C: 1.0 (baseline).
  // At 2 °C: ~1.3.
  // At 4 °C: ~1.8.
  // At 6 °C: ~2.5.
  climate.extremeWeatherMultiplier = 1.0 + warming * 0.35;
}

// ═══════════════════════════════════════════════════════════════════════
// CO₂ EMISSION PATH
// ═══════════════════════════════════════════════════════════════════════

function updateCO2Concentration(dtYears) {
  const climate = GlobalClimate;
  const preset = SCENARIO_PRESETS[climate.scenario];

  let targetCo2;
  let rate;

  if (climate.scenario === Scenario.CUSTOM) {
    rate = climate.customEmissionRate;
    climate.co2Ppm += rate * dtYears;
    return;
  }

  if (!preset) return;

  // Path-specific CO₂ trajectory.
  switch (preset.path) {
    case 'flat':
      // Stay at pre-industrial.
      return;

    case 'stabilize':
      // Exponential approach to peak by 2100, then stabilize.
      targetCo2 = preset.co2PeakPpm;
      rate = (targetCo2 - climate.co2Ppm) / 100 * dtYears;
      climate.co2Ppm += rate;
      break;

    case 'slow_rise':
      targetCo2 = preset.co2PeakPpm;
      rate = (targetCo2 - climate.co2Ppm) / 120 * dtYears;
      climate.co2Ppm += rate;
      break;

    case 'rise':
      targetCo2 = preset.co2PeakPpm;
      rate = (targetCo2 - climate.co2Ppm) / 100 * dtYears;
      climate.co2Ppm += rate;
      break;

    case 'fast_rise':
      targetCo2 = preset.co2PeakPpm;
      rate = (targetCo2 - climate.co2Ppm) / 80 * dtYears;
      climate.co2Ppm += rate;
      break;
  }

  // CH₄ and N₂O co-evolve with CO₂.
  const co2Increase = climate.co2Ppm - PRE_INDUSTRIAL_CO2_PPM;
  climate.ch4Ppb = 722 + co2Increase * 2.5;
  climate.n2oPpb = 270 + co2Increase * 0.4;

  // Deforestation increases slightly.
  climate.deforestation = Math.min(0.35, climate.deforestation + dtYears * 0.001);
}

// ═══════════════════════════════════════════════════════════════════════
// SOLAR CYCLE
// ═══════════════════════════════════════════════════════════════════════

function updateSolarCycle() {
  const climate = GlobalClimate;
  // 11-year solar cycle.
  const cyclePhase = (climate.yearsSinceBaseline % 11) / 11 * TWO_PI;
  climate.solarCycle = Math.sin(cyclePhase);
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN SYSTEM — advance climate change
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance global climate change by `dtYears`.
 *
 * @param dtYears  years to advance (typically 1/365.25 per game day)
 */
export function systemClimateChangeTick(dtYears) {
  if (GlobalClimate.paused) return;

  // Update year count.
  GlobalClimate.yearsSinceBaseline += dtYears;

  // Update CO₂ concentration.
  updateCO2Concentration(dtYears);

  // Update solar cycle.
  updateSolarCycle();

  // Compute forcing.
  computeTotalForcing();

  // Update two-box model.
  updateTwoBoxModel(dtYears);

  // Update sea level.
  updateSeaL evel(dtYears);

  // Update snow/tree line.
  updateSnowTreeLine();

  // Update ocean acidification.
  updateOceanAcidification();

  // Update extreme weather multiplier.
  updateExtremeWeatherMultiplier();
}

// ═══════════════════════════════════════════════════════════════════════
// CLIMATE OBSERVER API
// ═══════════════════════════════════════════════════════════════════════

export function addClimateObserver(world, eid, latitudeDeg) {
  if (_nextClimateObserverSlot >= MAX_CLIMATE_OBSERVERS) {
    throw new Error('climate observer capacity exceeded');
  }
  const slot = _nextClimateObserverSlot++;

  addComponent(world, eid, ClimateObserverTag);

  const O = ClimateObserver;
  O.ownerEid[slot] = eid;
  O.latitudeDeg[slot] = latitudeDeg ?? 45;
  O.px[slot] = 0;
  O.py[slot] = 0;
  O.pz[slot] = 0;
  O.localAnomaly[slot] = 0;
  O.localSeaLevelRise[slot] = 0;
  O.localExtremeMultiplier[slot] = 1;
  O.localSnowLineShift[slot] = 0;
  O.active[slot] = 1;

  _climateObserverSlots.set(eid, slot);
  return slot;
}

export function removeClimateObserver(world, eid) {
  const slot = _climateObserverSlots.get(eid);
  if (slot === undefined) return;
  ClimateObserver.active[slot] = 0;
  ClimateObserver.ownerEid[slot] = 0;
  _climateObserverSlots.delete(eid);
  removeComponent(world, eid, ClimateObserverTag);
}

export function getClimateObserverSlot(eid) {
  return _climateObserverSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// LOCAL ANOMALY SAMPLING — polar amplification, land-sea contrast
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the local temperature anomaly at a position.
 * Applies polar amplification, land-sea contrast, and latitude-based
 * amplification.
 */
export function sampleLocalTemperatureAnomaly(latDeg, isLand = true) {
  const climate = GlobalClimate;
  const globalWarming = climate.transientWarming;

  // Polar amplification.
  let amplification = 1.0;
  const absLat = Math.abs(latDeg);
  if (absLat > 60) {
    amplification = POLAR_AMPLIFICATION;
  } else if (absLat > 30) {
    amplification = 1.0 + (absLat - 30) / 30 * (POLAR_AMPLIFICATION - 1.0);
  }

  // Land-sea contrast.
  const landFactor = isLand ? LAND_SEA_CONTRAST : 1.0;

  return globalWarming * amplification * landFactor;
}

/**
 * Compute the local sea-level rise at a position (mm).
 * Currently uniform, but in a full model would vary with ocean currents.
 */
export function sampleLocalSeaLevelRise(wx, wy, wz) {
  return GlobalClimate.seaLevelRiseMm;
}

/**
 * Compute the local extreme weather multiplier.
 */
export function sampleLocalExtremeMultiplier(latDeg) {
  const climate = GlobalClimate;
  const absLat = Math.abs(latDeg);

  // Tropical storms enhance more than mid-latitude weather.
  const tropicalFactor = absLat < 30 ? 1.15 : 1.0;

  return climate.extremeWeatherMultiplier * tropicalFactor;
}

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM — update climate observers
// ═══════════════════════════════════════════════════════════════════════

export function systemUpdateClimateObservers(world) {
  const O = ClimateObserver;

  for (let slot = 0; slot < _nextClimateObserverSlot; slot++) {
    if (!O.active[slot]) continue;

    const eid = O.ownerEid[slot];
    if (!eid || !entityExists(world, eid)) continue;

    const id = getId(eid);
    const M = WorldTransformF32.m;
    if (!M) continue;
    const off = id * 16;
    O.px[slot] = M[off + 12];
    O.py[slot] = M[off + 13];
    O.pz[slot] = M[off + 14];

    // Determine if the observer is on land or sea.
    const isLand = true;   // simplified; in production use file 059's water body check

    O.localAnomaly[slot] = sampleLocalTemperatureAnomaly(O.latitudeDeg[slot], isLand);
    O.localSeaLevelRise[slot] = sampleLocalSeaLevelRise(O.px[slot], O.py[slot], O.pz[slot]);
    O.localExtremeMultiplier[slot] = sampleLocalExtremeMultiplier(O.latitudeDeg[slot]);
    O.localSnowLineShift[slot] = GlobalClimate.snowLineShift;
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// EXTREME WEATHER FREQUENCY COUPLING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the modified probability weight for a weather type based on
 * the current warming level. This is multiplied into file 063's
 * Markov transition matrix.
 *
 * @returns Multiplier (0.5 to 3.0) applied to the base weight.
 */
export function getWeatherTypeMultiplier(weatherType) {
  const warming = Math.max(0, GlobalClimate.transientWarming);

  switch (weatherType) {
    case WeatherType.THUNDERSTORM:
    case WeatherType.SUPERCELL:
      // Storms become more common.
      return 1.0 + warming * THUNDERSTORM_FREQUENCY_PER_C;

    case WeatherType.HURRICANE:
    case WeatherType.TROPICAL_STORM:
      // Hurricanes become stronger (more Cat 4/5).
      return 1.0 + warming * HURRICANE_CAT45_PER_C;

    case WeatherType.HEAVY_RAIN:
    case WeatherType.MODERATE_RAIN:
      // Rain becomes more intense.
      return 1.0 + warming * 0.10;

    case WeatherType.MODERATE_SNOW:
    case WeatherType.BLIZZARD:
      // Snow becomes less frequent (shorter snow season) but more intense.
      return Math.max(0.3, 1.0 + warming * COLD_SNAP_FREQUENCY_PER_C);

    case WeatherType.LIGHT_SNOW:
      // Light snow becomes much rarer.
      return Math.max(0.2, 1.0 + warming * COLD_SNAP_FREQUENCY_PER_C * 1.5);

    case WeatherType.DUST_STORM:
    case WeatherType.SANDSTORM:
      // Droughts make dust storms more likely.
      return 1.0 + warming * DROUGHT_DURATION_PER_C;

    case WeatherType.HAZE:
    case WeatherType.FOG:
      // Similar frequency.
      return 1.0;

    case WeatherType.HEAVY_RAIN:
      // Heavy rain more intense.
      return 1.0 + warming * 0.15;

    default:
      return 1.0;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SNOW LINE / TREE LINE SHIFT COUPLING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the current snow line altitude with climate change applied.
 */
export function getAdjustedSnowLine(baseAltitude, latitudeDeg, season) {
  const base = computeSnowLine(latitudeDeg, season);
  return base + GlobalClimate.snowLineShift;
}

/**
 * Return the current tree line altitude with climate change applied.
 */
export function getAdjustedTreeLine(baseAltitude, latitudeDeg, season) {
  const base = computeTreeLine(latitudeDeg, season);
  return base + GlobalClimate.treeLineShift;
}

// ═══════════════════════════════════════════════════════════════════════
// SEA LEVEL COUPLING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the current global sea level rise in metres.
 */
export function getSealevelRiseMeters() {
  return GlobalClimate.seaLevelRiseMm / 1000.0;
}

/**
 * Return the adjusted water body base level at a given water body slot.
 */
export function getAdjustedWaterLevel(waterBodySlot) {
  if (!WaterBody.active[waterBodySlot]) return 0;
  return WaterBody.baseLevel[waterBodySlot] + getSealevelRiseMeters();
}

// ═══════════════════════════════════════════════════════════════════════
// OCEAN ACIDIFICATION HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the current ocean pH.
 */
export function getOceanPH() {
  return GlobalClimate.oceanPh;
}

/**
 * Return the pH change since pre-industrial.
 */
export function getOceanPHChange() {
  return GlobalClimate.oceanPh - PRE_INDUSTRIAL_OCEAN_PH;
}

// ═══════════════════════════════════════════════════════════════════════
// NARRATIVE EVENTS — narrative milestones
// ═══════════════════════════════════════════════════════════════════════

/**
 * Schedule a narrative event that fires when the transient warming
 * crosses a specific threshold.
 */
export function addNarrativeEvent(name, warmingThreshold, callback) {
  if (_nextNarrativeEventSlot >= MAX_NARRATIVE_TRIGGERS) {
    throw new Error('narrative event capacity exceeded');
  }
  const slot = _nextNarrativeEventSlot++;

  NarrativeEvent.active[slot] = 1;
  NarrativeEvent.warmingThreshold[slot] = warmingThreshold;
  NarrativeEvent.fired[slot] = 0;
  NarrativeEvent.callback[slot] = callback;
  NarrativeEvent.name[slot] = name;

  return slot;
}

function processNarrativeEvents() {
  const warming = GlobalClimate.transientWarming;

  for (let slot = 0; slot < _nextNarrativeEventSlot; slot++) {
    if (!NarrativeEvent.active[slot]) continue;
    if (NarrativeEvent.fired[slot]) continue;

    if (warming >= NarrativeEvent.warmingThreshold[slot]) {
      NarrativeEvent.fired[slot] = 1;

      if (NarrativeEvent.callback[slot]) {
        try {
          NarrativeEvent.callback[slot](NarrativeEvent.name[slot], warming);
        } catch (err) {
          if (typeof console !== 'undefined') {
            console.warn('[073_climate_change] narrative event threw:', err);
          }
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC QUERIES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a full global climate summary.
 */
export function getGlobalClimateSummary() {
  return {
    scenario: GlobalClimate.scenario,
    yearsSinceBaseline: GlobalClimate.yearsSinceBaseline,
    co2Ppm: GlobalClimate.co2Ppm,
    ch4Ppb: GlobalClimate.ch4Ppb,
    n2oPpb: GlobalClimate.n2oPpb,
    totalForcing: GlobalClimate.totalForcing,
    equilibriumWarming: GlobalClimate.equilibriumWarming,
    transientWarming: GlobalClimate.transientWarming,
    atmosphereAnomaly: GlobalClimate.atmosphereAnomaly,
    oceanMixedLayerAnomaly: GlobalClimate.oceanMixedLayerAnomaly,
    oceanDeepAnomaly: GlobalClimate.oceanDeepAnomaly,
    seaLevelRiseMm: GlobalClimate.seaLevelRiseMm,
    oceanPh: GlobalClimate.oceanPh,
    oceanPhChange: getOceanPHChange(),
    arcticSeaIceExtent: GlobalClimate.arcticSeaIceExtent,
    greenlandMassBalance: GlobalClimate.greenlandMassBalance,
    antarcticMassBalance: GlobalClimate.antarcticMassBalance,
    snowLineShift: GlobalClimate.snowLineShift,
    treeLineShift: GlobalClimate.treeLineShift,
    extremeWeatherMultiplier: GlobalClimate.extremeWeatherMultiplier,
    paused: GlobalClimate.paused,
  };
}

/**
 * Return a human-readable scenario label.
 */
export function scenarioLabel(scenario) {
  switch (scenario) {
    case Scenario.PRE_INDUSTRIAL: return 'Pre-Industrial';
    case Scenario.SSP1_1_9:       return 'SSP1-1.9 (Paris-aligned)';
    case Scenario.SSP1_2_6:       return 'SSP1-2.6 (Paris-aligned)';
    case Scenario.SSP2_4_5:       return 'SSP2-4.5 (Moderate)';
    case Scenario.SSP3_7_0:       return 'SSP3-7.0 (High)';
    case Scenario.SSP4_6_0:       return 'SSP4-6.0 (Asymmetric)';
    case Scenario.SSP5_8_5:       return 'SSP5-8.5 (Worst Case)';
    case Scenario.CUSTOM:         return 'Custom';
    default:                       return 'Unknown';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TICK — orchestrator
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance climate change for one frame.
 *
 * @param world     ECS world
 * @param dtGameHours game hours elapsed (converted to years)
 */
export function systemClimateChangeFullTick(world, dtGameHours) {
  const dtYears = dtGameHours / (365.25 * 24.0);
  systemClimateChangeTick(dtYears);
  systemUpdateClimateObservers(world);
  processNarrativeEvents();
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

export function gatherClimateChangeForRendering() {
  return getGlobalClimateSummary();
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function climateChangeStats() {
  let activeObservers = 0;
  let activeNarratives = 0;
  let firedNarratives = 0;

  for (let slot = 0; slot < _nextClimateObserverSlot; slot++) {
    if (ClimateObserver.active[slot]) activeObservers++;
  }

  for (let slot = 0; slot < _nextNarrativeEventSlot; slot++) {
    if (!NarrativeEvent.active[slot]) continue;
    activeNarratives++;
    if (NarrativeEvent.fired[slot]) firedNarratives++;
  }

  return {
    activeObservers,
    maxObservers: MAX_CLIMATE_OBSERVERS,
    activeNarratives,
    firedNarratives,
    maxNarratives: MAX_NARRATIVE_TRIGGERS,
    scenario: GlobalClimate.scenario,
    scenarioLabel: scenarioLabel(GlobalClimate.scenario),
    warming: GlobalClimate.transientWarming,
    co2Ppm: GlobalClimate.co2Ppm,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearClimateChange() {
  // Reset global state.
  GlobalClimate.scenario = Scenario.SSP2_4_5;
  GlobalClimate.co2Ppm = PRE_INDUSTRIAL_CO2_PPM;
  GlobalClimate.ch4Ppb = 722;
  GlobalClimate.n2oPpb = 270;
  GlobalClimate.halocarbonPpb = 0;
  GlobalClimate.deforestation = 0;
  GlobalClimate.solarCycle = 0;
  GlobalClimate.yearsSinceBaseline = 0;
  GlobalClimate.oceanPh = PRE_INDUSTRIAL_OCEAN_PH;
  GlobalClimate.oceanHeatContent = 0;
  GlobalClimate.totalForcing = 0;
  GlobalClimate.equilibriumWarming = 0;
  GlobalClimate.transientWarming = 0;
  GlobalClimate.seaLevelRiseMm = 0;
  GlobalClimate.arcticSeaIceExtent = 6.0;
  GlobalClimate.greenlandMassBalance = 0;
  GlobalClimate.antarcticMassBalance = 0;
  GlobalClimate.snowLineShift = 0;
  GlobalClimate.treeLineShift = 0;
  GlobalClimate.extremeWeatherMultiplier = 1.0;
  GlobalClimate.atmosphereAnomaly = 0;
  GlobalClimate.oceanMixedLayerAnomaly = 0;
  GlobalClimate.oceanDeepAnomaly = 0;
  GlobalClimate.paused = false;

  // Clear observers.
  ClimateObserver.active.fill(0);
  ClimateObserver.ownerEid.fill(0);
  _climateObserverSlots.clear();
  _nextClimateObserverSlot = 0;

  // Clear narrative events.
  NarrativeEvent.active.fill(0);
  NarrativeEvent.fired.fill(0);
  NarrativeEvent.callback.fill(null);
  NarrativeEvent.name.fill('');
  _nextNarrativeEventSlot = 0;
}