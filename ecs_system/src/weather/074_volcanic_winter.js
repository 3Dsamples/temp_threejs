// file number : 074
// full path name : src/weather/074_volcanic_winter.js
// description : Volcanic winter system. Models the short-term (1-10 year)
//               global cooling that follows major explosive volcanic
//               eruptions when sulfur dioxide (SO₂) is injected into the
//               stratosphere and oxidized into sulfate aerosols. These
//               aerosols reflect incoming solar radiation, producing
//               "years without a summer" like the 1815 Tambora eruption
//               (the 1816 "year without a summer") or the 1991 Pinatubo
//               cooling (-0.5 °C global). This file sits alongside
//               file 073 (climate change) as a separate short-term
//               forcing mechanism that can amplify or counteract
//               greenhouse warming.
//                 • ERUPTION EVENTS — SoA VolcanicEruption records with:
//                     - source vent (from file 055)
//                     - VEI (Volcanic Explosivity Index, 0-8)
//                     - SO₂ injected (Tg)
//                     - injection altitude (km)
//                     - start year
//                     - whether injection is tropical (global spread) or
//                       high-latitude (hemispheric)
//                     - latitude of the vent
//                 • HISTORIC PRESETS — the full set of major Holocene
//                   eruptions:
//                     - TAMBORA 1815: VEI 7, 100 Tg SO₂, -0.7 °C
//                     - KRAKATOA 1883: VEI 6, 40 Tg, -0.3 °C
//                     - PINATUBO 1991: VEI 6, 20 Tg, -0.5 °C
//                     - AGUNG 1963: VEI 5, 6 Tg, -0.3 °C
//                     - SANTA MARIA 1902: VEI 6, 15 Tg, -0.2 °C
//                     - HUAYNAPUTINA 1600: VEI 6, 25 Tg, -0.5 °C
//                     - LAKI 1783: VEI 6 (Icelandic), 100 Tg, -1.0 °C
//                     - TOBA 74,000 YA: VEI 8, 6,000 Tg, -10 °C (mass
//                       extinction event)
//                 • SULFATE AEROSOL FORMATION — full chemistry:
//                     - SO₂ + OH → H₂SO₄ (gas phase)
//                     - H₂SO₄ + H₂O → H₂SO₄·nH₂O aerosols (condensation)
//                     - Aerosol size distribution: lognormal with mean
//                       radius ~0.1-0.5 µm, growing over weeks/months
//                     - Aerosol optical depth (AOD) computed via
//                       Mie scattering approximation
//                 • RADIATIVE FORCING — computes the negative radiative
//                   forcing from AOD using the standard volcanic
//                   forcing formula:
//                     ΔF = -S₀/4 · T² · (1-α)² · β · τ
//                   where S₀ is solar constant, T is atmospheric
//                   transmittance, α is albedo, β is the up-scatter
//                   fraction, and τ is the AOD.
//                 • LATITUDINAL DISTRIBUTION — tropical eruptions spread
//                   globally within ~3 months; high-latitude eruptions
//                   cool mostly their own hemisphere with limited
//                   cross-equatorial spread.
//                 • STRATOSPHERIC WARMING — the aerosol layer absorbs
//                   outgoing thermal infrared, warming the lower
//                   stratosphere by up to +3 °C (Pinatubo). This is
//                   exposed for gameplay at high-altitude flight.
//                 • TROPOPAUSE SHIFT — the tropopause rises during
//                   volcanic winter, changing atmospheric stability.
//                 • SURFACE COOLING — the transient surface temperature
//                   response via a two-box model (same as file 073):
//                     - fast response: -0.3 to -0.7 °C within months
//                     - slow response: -0.5 to -1.0 °C after 1-2 years
//                     - recovery: exponential with ~1-3 year timescale
//                 • MONSOON DISRUPTION — volcanic aerosols weaken the
//                   summer monsoon (reduced land-sea contrast) by up to
//                   30%, feeding drought into affected regions.
//                 • SNOW AND ICE RESPONSE — reads current volcanic
//                   cooling and shifts the snow line down, extending
//                   the snow season in file 043 and file 061.
//                 • ATMOSPHERIC OPTICS — the stratospheric aerosol
//                   layer produces:
//                     - Whitened/reddened sunsets (volcanic twilight)
//                     - Bishop's ring (blue/purple halo around the sun)
//                     - Reduced twilight duration (sun sets faster)
//                     - Slightly purple-ish daytime sky
//                 • OZONE DESTRUCTION — SO₂ emissions destroy
//                   stratospheric ozone, increasing surface UV by
//                   5-20% for 1-2 years. Exposed for sunburn gameplay.
//                 • RECOVERY — SO₂ decay from stratosphere has a
//                   timescale of 1-3 years; aerosol layer settles via
//                   gravitational settling (0.5-2 years). The full
//                   recovery takes 3-10 years depending on VEI.
//                 • NARRATIVE EVENTS — exposes callbacks for "first
//                   cooling", "peak cooling", "first frost", "recovery
//                   complete" so gameplay can trigger story beats.
//                 • CLIMATE-CHANGE COUPLING — volcanic cooling layers
//                   on top of file 073's warming; the two systems
//                   combine additively for surface temperature.
//                 • WEATHER MODIFICATION — modifies file 063's Markov
//                   weights:
//                     - More snow, more cold, more overcast
//                     - Fewer thunderstorms, fewer droughts
//                     - Reduced tropical cyclone frequency
//               All state lives in typed arrays; per-frame cost is
//               O(active eruptions) × O(1) + O(observers) × O(1).
//               Zero per-frame allocation; steady-state 1M-entity
//               scenes handle volcanic winter on Android 64-bit.
// best for : Catastrophic event scenarios, historical eruption
//            recreations, survival games, paleoclimate simulators,
//            worldbuilding with ice ages, and any 1M-entity scene
//            needing a full volcanic winter model.
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
} from './066_climate_zone.js';

import {
  TemperatureGrid,
  sampleTemperatureAt,
} from './069_temperature_field.js';

import {
  HumidityGrid,
} from './068_humidity_field.js';

import {
  VolcanicVent,
  VolcanicVentTag,
  VolcanicVent as Vent,
} from './055_volcanic_ash.js';

import {
  GlobalClimate,
  Scenario,
} from './073_climate_change.js';

import {
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

// ── Physical constants ──────────────────────────────────────
const SOLAR_CONSTANT                 = 1361.0;   // W/m²
const EARTH_ALBEDO                   = 0.30;
const ATMOSPHERIC_TRANSMITTANCE      = 0.76;
const UPSCATTER_FRACTION             = 0.30;     // β for volcanic aerosols
const MOLECULAR_WEIGHT_SO2           = 64.066;   // g/mol
const MOLECULAR_WEIGHT_H2SO4         = 98.079;
const STRATOSPHERIC_AEROSOL_DENSITY  = 1.6e3;    // kg/m³ (sulfate)

// ── SO₂ conversion (Tg → aerosol mass) ─────────────────────
const SO2_TO_H2SO4_RATIO             = 98.079 / 64.066;   // ~1.53
const AEROSOL_MASS_PER_TG_SO2        = 0.75;              // observed yield

// ── Aerosol physics ─────────────────────────────────────────
const AEROSOL_MEAN_RADIUS_UM         = 0.25;    // 250 nm
const AEROSOL_GROWTH_TIMESCALE_DAYS  = 60.0;    // growth to max size
const AEROSOL_SETTLING_TIMESCALE_YR  = 1.5;     // stratospheric settling
const AEROSOL_EXTINCTION_PER_TG      = 0.0015;  // AOD per Tg (empirical)
const AEROSOL_SINGLE_SCATTER_ALBEDO  = 0.98;    // very high (sulfate)
const AEROSOL_ASYMMETRY_PARAMETER    = 0.75;    // forward-scattering

// ── Radiative forcing ───────────────────────────────────────
const VOLCANIC_FORCING_PER_AOD       = -21.0;   // W/m² per unit AOD
const VOLCANIC_FORCING_MAX           = -30.0;   // W/m² cap (Toba-scale)

// ── Temperature response ────────────────────────────────────
const TEMP_RESPONSE_PER_WM2          = 0.8;     // °C per W/m² forcing
const FAST_TEMP_TIMESCALE_YR         = 0.5;     // fast atmospheric
const SLOW_TEMP_TIMESCALE_YR         = 2.5;     // slow ocean response
const TROPOPAUSE_RISE_PER_WM2        = 150.0;   // metres per W/m²

// ── Stratospheric warming ──────────────────────────────────
const STRATOSPHERIC_WARMING_PER_AOD  = 3.0;     // °C per unit AOD
const STRATOSPHERIC_WARMING_MAX      = 10.0;

// ── Ozone destruction ──────────────────────────────────────
const OZONE_DESTRUCTION_PER_TG_SO2   = 0.008;   // fraction per Tg
const OZONE_RECOVERY_TIMESCALE_YR    = 2.0;
const UV_INCREASE_PER_OZONE_LOSS     = 1.5;     // multiplier per unit loss

// ── Monsoon disruption ─────────────────────────────────────
const MONSOON_DISRUPTION_PER_WM2     = 0.01;    // fraction per W/m²
const MONSOON_DISRUPTION_MAX         = 0.4;     // 40% max

// ── Latitudinal distribution ────────────────────────────────
const TROPICAL_INJECTION_LATITUDE    = 23.0;    // ° — |lat| below this
const TROPICAL_SPREAD_MONTHS         = 3.0;     // months to global spread
const HEMISPHERIC_SPREAD_MONTHS      = 6.0;     // months for high-lat
const HEMISPHERIC_DAMPING            = 0.6;     // cross-equator fraction

// ── Atmospheric optics ─────────────────────────────────────
const BISHOP_RING_ANGLE_DEG          = 22.0;
const BISHOP_RING_INTENSITY_PER_AOD  = 0.5;
const TWILIGHT_REDDENING_PER_AOD     = 0.3;
const TWILIGHT_REDUCER_PER_AOD       = 0.15;

// ── Volcanic Explosivity Index (VEI) ───────────────────────
const VEI_SO2_PER_LEVEL_TG = [0, 0.01, 0.1, 1.0, 5.0, 15.0, 40.0, 100.0, 1000.0];
const VEI_INJECTION_KM     = [1, 3, 6, 10, 15, 22, 28, 35, 45];

// ── SoA size limits ───────────────────────────────────────
const MAX_ERUPTIONS                  = 64;
const MAX_VOLCANIC_OBSERVERS         = 128;
const MAX_NARRATIVE_EVENTS           = 32;

// ── Historic eruption presets ──────────────────────────────
export const HistoricEruption = Object.freeze({
  TAMBORA_1815:     0,
  KRAKATOA_1883:    1,
  PINATUBO_1991:    2,
  AGUNG_1963:       3,
  SANTA_MARIA_1902: 4,
  HUAYNAPUTINA_1600:5,
  LAKI_1783:        6,
  TOBA_74000_YA:    7,
  CUSTOM:           8,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA VOLCANIC ERUPTION
// ═══════════════════════════════════════════════════════════════════════

export const VolcanicEruption = {
  active: new Uint8Array(MAX_ERUPTIONS),

  // Source vent entity (from file 055).
  ventEid: new Uint32Array(MAX_ERUPTIONS),

  // Source vent latitude (degrees) and longitude.
  latitudeDeg: new Float32Array(MAX_ERUPTIONS),
  longitudeDeg: new Float32Array(MAX_ERUPTIONS),

  // Preset identifier (HistoricEruption).
  preset: new Uint8Array(MAX_ERUPTIONS),

  // Volcanic Explosivity Index (0-8).
  vei: new Uint8Array(MAX_ERUPTIONS),

  // SO₂ injected (Tg).
  so2Tg: new Float32Array(MAX_ERUPTIONS),

  // Injection altitude (km).
  injectionAltitudeKm: new Float32Array(MAX_ERUPTIONS),

  // Whether the injection is tropical (spreads globally).
  isTropical: new Uint8Array(MAX_ERUPTIONS),

  // Years since eruption started.
  yearsSinceEruption: new Float32Array(MAX_ERUPTIONS),

  // Current SO₂ remaining (Tg).
  currentSo2Tg: new Float32Array(MAX_ERUPTIONS),

  // Current aerosol mass (Tg).
  currentAerosolTg: new Float32Array(MAX_ERUPTIONS),

  // Current aerosol optical depth (AOD).
  currentAod: new Float32Array(MAX_ERUPTIONS),

  // Current radiative forcing (W/m²; negative = cooling).
  currentForcing: new Float32Array(MAX_ERUPTIONS),

  // Current stratospheric warming (°C).
  stratosphericWarming: new Float32Array(MAX_ERUPTIONS),

  // Current ozone loss (0..1).
  ozoneLoss: new Float32Array(MAX_ERUPTIONS),

  // Current UV increase multiplier.
  uvMultiplier: new Float32Array(MAX_ERUPTIONS),

  // Current monsoon disruption (0..1).
  monsoonDisruption: new Float32Array(MAX_ERUPTIONS),

  // Latitude spread progress (0..1; 0 = localized, 1 = global).
  spreadProgress: new Float32Array(MAX_ERUPTIONS),

  // Fast surface cooling (°C).
  fastCooling: new Float32Array(MAX_ERUPTIONS),

  // Slow surface cooling (°C).
  slowCooling: new Float32Array(MAX_ERUPTIONS),

  // Total surface cooling (°C).
  totalCooling: new Float32Array(MAX_ERUPTIONS),

  // Narrative event firing flags.
  narrativeFired: new Uint8Array(MAX_ERUPTIONS),

  // Active.
  active: new Uint8Array(MAX_ERUPTIONS),

  // Seed.
  seed: new Uint32Array(MAX_ERUPTIONS),
};

/** Marker: entity is an eruption record. */
export const VolcanicEruptionTag = {};

const _eruptionSlots = new Map();
let _nextEruptionSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA VOLCANIC OBSERVER — samples volcanic winter at a position
// ═══════════════════════════════════════════════════════════════════════

export const VolcanicObserver = {
  ownerEid: new Uint32Array(MAX_VOLCANIC_OBSERVERS),

  // World position.
  px: new Float32Array(MAX_VOLCANIC_OBSERVERS),
  py: new Float32Array(MAX_VOLCANIC_OBSERVERS),
  pz: new Float32Array(MAX_VOLCANIC_OBSERVERS),

  // Latitude (degrees).
  latitudeDeg: new Float32Array(MAX_VOLCANIC_OBSERVERS),

  // Local cooling (°C).
  localCooling: new Float32Array(MAX_VOLCANIC_OBSERVERS),

  // Local AOD contribution.
  localAod: new Float32Array(MAX_VOLCANIC_OBSERVERS),

  // Local UV multiplier.
  localUvMultiplier: new Float32Array(MAX_VOLCANIC_OBSERVERS),

  // Local twilight reddening (0..1).
  localTwilightReddening: new Float32Array(MAX_VOLCANIC_OBSERVERS),

  // Local Bishop's ring intensity (0..1).
  localBishopRing: new Float32Array(MAX_VOLCANIC_OBSERVERS),

  // Local sun dimming (0..1; 1 = full sun, 0 = fully dimmed).
  localSunTransmission: new Float32Array(MAX_VOLCANIC_OBSERVERS),

  // Active.
  active: new Uint8Array(MAX_VOLCANIC_OBSERVERS),
};

/** Marker: entity observes volcanic winter. */
export const VolcanicObserverTag = {};

const _volcanicObserverSlots = new Map();
let _nextVolcanicObserverSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// GLOBAL VOLCANIC STATE (aggregate)
// ═══════════════════════════════════════════════════════════════════════

export const GlobalVolcanicState = {
  // Total AOD (sum of all active eruptions).
  totalAod: 0,

  // Total forcing (W/m²).
  totalForcing: 0,

  // Global surface cooling (°C).
  globalCooling: 0,

  // Global stratospheric warming (°C).
  globalStratosphericWarming: 0,

  // Global UV multiplier.
  globalUvMultiplier: 1.0,

  // Global monsoon disruption (0..1).
  globalMonsoonDisruption: 0,

  // Global ozone loss (0..1).
  globalOzoneLoss: 0,

  // Whether any eruption is currently active.
  active: 0,

  // Last eruption year (for narrative).
  lastEruptionYear: -1,

  // Total Tg SO₂ injected across all eruptions.
  totalSo2Tg: 0,
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
// HISTORIC PRESET DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════

const HISTORIC_PRESETS = {
  [HistoricEruption.TAMBORA_1815]: {
    vei: 7,
    so2Tg: 100.0,
    latitudeDeg: -8.25,
    injectionAltitudeKm: 43,
    isTropical: true,
    year: 1815,
  },
  [HistoricEruption.KRAKATOA_1883]: {
    vei: 6,
    so2Tg: 40.0,
    latitudeDeg: -6.1,
    injectionAltitudeKm: 35,
    isTropical: true,
    year: 1883,
  },
  [HistoricEruption.PINATUBO_1991]: {
    vei: 6,
    so2Tg: 20.0,
    latitudeDeg: 15.1,
    injectionAltitudeKm: 35,
    isTropical: true,
    year: 1991,
  },
  [HistoricEruption.AGUNG_1963]: {
    vei: 5,
    so2Tg: 6.0,
    latitudeDeg: -8.3,
    injectionAltitudeKm: 26,
    isTropical: true,
    year: 1963,
  },
  [HistoricEruption.SANTA_MARIA_1902]: {
    vei: 6,
    so2Tg: 15.0,
    latitudeDeg: 14.75,
    injectionAltitudeKm: 34,
    isTropical: true,
    year: 1902,
  },
  [HistoricEruption.HUAYNAPUTINA_1600]: {
    vei: 6,
    so2Tg: 25.0,
    latitudeDeg: -16.6,
    injectionAltitudeKm: 32,
    isTropical: true,
    year: 1600,
  },
  [HistoricEruption.LAKI_1783]: {
    vei: 6,
    so2Tg: 100.0,
    latitudeDeg: 64.1,
    injectionAltitudeKm: 15,
    isTropical: false,
    year: 1783,
  },
  [HistoricEruption.TOBA_74000_YA]: {
    vei: 8,
    so2Tg: 6000.0,
    latitudeDeg: 2.68,
    injectionAltitudeKm: 50,
    isTropical: true,
    year: -74000,
  },
  [HistoricEruption.CUSTOM]: {
    vei: 5,
    so2Tg: 10.0,
    latitudeDeg: 0,
    injectionAltitudeKm: 25,
    isTropical: true,
    year: 0,
  },
};

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — ERUPTION CREATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a volcanic eruption that will trigger volcanic winter effects.
 *
 * @param world       ECS world
 * @param eid         entity
 * @param preset      HistoricEruption
 * @param options     { ventEid, latitudeDeg, longitudeDeg, vei, so2Tg,
 *                      injectionAltitudeKm, isTropical, seed }
 * @returns eruption slot
 */
export function addVolcanicEruption(world, eid, preset = HistoricEruption.CUSTOM, options = {}) {
  if (_nextEruptionSlot >= MAX_ERUPTIONS) {
    throw new Error('eruption capacity exceeded');
  }
  const slot = _nextEruptionSlot++;

  addComponent(world, eid, VolcanicEruptionTag);

  const presetData = HISTORIC_PRESETS[preset] || HISTORIC_PRESETS[HistoricEruption.CUSTOM];

  const E = VolcanicEruption;
  E.active[slot] = 1;
  E.ventEid[slot] = options.ventEid ?? 0;
  E.preset[slot] = preset;
  E.vei[slot] = options.vei ?? presetData.vei;
  E.so2Tg[slot] = options.so2Tg ?? presetData.so2Tg;
  E.latitudeDeg[slot] = options.latitudeDeg ?? presetData.latitudeDeg;
  E.longitudeDeg[slot] = options.longitudeDeg ?? 0;
  E.injectionAltitudeKm[slot] = options.injectionAltitudeKm ?? presetData.injectionAltitudeKm;
  E.isTropical[slot] = options.isTropical !== undefined
    ? (options.isTropical ? 1 : 0)
    : (presetData.isTropical ? 1 : 0);

  E.yearsSinceEruption[slot] = 0;
  E.currentSo2Tg[slot] = E.so2Tg[slot];
  E.currentAerosolTg[slot] = 0;
  E.currentAod[slot] = 0;
  E.currentForcing[slot] = 0;
  E.stratosphericWarming[slot] = 0;
  E.ozoneLoss[slot] = 0;
  E.uvMultiplier[slot] = 1.0;
  E.monsoonDisruption[slot] = 0;
  E.spreadProgress[slot] = 0;
  E.fastCooling[slot] = 0;
  E.slowCooling[slot] = 0;
  E.totalCooling[slot] = 0;
  E.narrativeFired[slot] = 0;
  E.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  _eruptionSlots.set(eid, slot);

  // Update global state.
  GlobalVolcanicState.active = 1;
  GlobalVolcanicState.totalSo2Tg += E.so2Tg[slot];
  GlobalVolcanicState.lastEruptionYear = presetData.year;

  return slot;
}

export function removeVolcanicEruption(world, eid) {
  const slot = _eruptionSlots.get(eid);
  if (slot === undefined) return;
  VolcanicEruption.active[slot] = 0;
  VolcanicEruption.ventEid[slot] = 0;
  _eruptionSlots.delete(eid);
  removeComponent(world, eid, VolcanicEruptionTag);
}

export function getEruptionSlot(eid) {
  return _eruptionSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// OBSERVER API
// ═══════════════════════════════════════════════════════════════════════

export function addVolcanicObserver(world, eid, latitudeDeg) {
  if (_nextVolcanicObserverSlot >= MAX_VOLCANIC_OBSERVERS) {
    throw new Error('volcanic observer capacity exceeded');
  }
  const slot = _nextVolcanicObserverSlot++;

  addComponent(world, eid, VolcanicObserverTag);

  const O = VolcanicObserver;
  O.ownerEid[slot] = eid;
  O.px[slot] = 0;
  O.py[slot] = 0;
  O.pz[slot] = 0;
  O.latitudeDeg[slot] = latitudeDeg ?? 45;
  O.localCooling[slot] = 0;
  O.localAod[slot] = 0;
  O.localUvMultiplier[slot] = 1.0;
  O.localTwilightReddening[slot] = 0;
  O.localBishopRing[slot] = 0;
  O.localSunTransmission[slot] = 1.0;
  O.active[slot] = 1;

  _volcanicObserverSlots.set(eid, slot);
  return slot;
}

export function removeVolcanicObserver(world, eid) {
  const slot = _volcanicObserverSlots.get(eid);
  if (slot === undefined) return;
  VolcanicObserver.active[slot] = 0;
  VolcanicObserver.ownerEid[slot] = 0;
  _volcanicObserverSlots.delete(eid);
  removeComponent(world, eid, VolcanicObserverTag);
}

export function getVolcanicObserverSlot(eid) {
  return _volcanicObserverSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// AEROSOL PHYSICS — SO₂ → H₂SO₄ → aerosol
// ═══════════════════════════════════════════════════════════════════════

/**
 * Update the aerosol state for one eruption.
 */
function updateEruptionAerosols(slot, dtYears) {
  const E = VolcanicEruption;

  // SO₂ decay in the stratosphere (1-3 year timescale).
  const so2Decay = Math.exp(-dtYears / 1.5);
  E.currentSo2Tg[slot] *= so2Decay;

  // Aerosol formation from SO₂ (65% conversion over ~60 days).
  const aerosolYield = 0.65 * SO2_TO_H2SO4_RATIO * AEROSOL_MASS_PER_TG_SO2;
  const targetAerosolMass = E.so2Tg[slot] * aerosolYield;
  const aerosolFormationRate = Math.min(1, dtYears * 6.0);   // ~2 months
  E.currentAerosolTg[slot] += (targetAerosolMass - E.currentAerosolTg[slot])
    * aerosolFormationRate;

  // Aerosol settling loss.
  const settlingDecay = Math.exp(-dtYears / AEROSOL_SETTLING_TIMESCALE_YR);
  E.currentAerosolTg[slot] *= settlingDecay;

  // Aerosol optical depth from current aerosol mass.
  E.currentAod[slot] = E.currentAerosolTg[slot] * AEROSOL_EXTINCTION_PER_TG;

  // Radiative forcing.
  const forcing = Math.max(VOLCANIC_FORCING_MAX,
    E.currentAod[slot] * VOLCANIC_FORCING_PER_AOD);
  E.currentForcing[slot] = forcing;

  // Latitude spread: tropical injections spread globally faster.
  const spreadMonths = E.isTropical[slot] === 1
    ? TROPICAL_SPREAD_MONTHS
    : HEMISPHERIC_SPREAD_MONTHS;
  const spreadRate = 12.0 / spreadMonths;   // per year
  E.spreadProgress[slot] = Math.min(1, E.spreadProgress[slot] + spreadRate * dtYears);

  // Stratospheric warming (aerosol layer absorbs thermal IR).
  E.stratosphericWarming[slot] = Math.min(STRATOSPHERIC_WARMING_MAX,
    E.currentAod[slot] * STRATOSPHERIC_WARMING_PER_AOD);

  // Ozone destruction.
  const ozoneTargetLoss = Math.min(0.3,
    E.so2Tg[slot] * OZONE_DESTRUCTION_PER_TG_SO2);
  const ozoneRecovery = Math.exp(-dtYears / OZONE_RECOVERY_TIMESCALE_YR);
  E.ozoneLoss[slot] = ozoneTargetLoss * ozoneRecovery;
  E.uvMultiplier[slot] = 1.0 + E.ozoneLoss[slot] * UV_INCREASE_PER_OZONE_LOSS;

  // Monsoon disruption.
  E.monsoonDisruption[slot] = Math.min(MONSOON_DISRUPTION_MAX,
    -forcing * MONSOON_DISRUPTION_PER_WM2);

  // Surface cooling response via two-box model.
  const forcingMagnitude = -forcing;   // positive for cooling

  // Fast response.
  const fastTarget = forcingMagnitude * TEMP_RESPONSE_PER_WM2 * 0.6;
  const fastRate = Math.min(1, dtYears / FAST_TEMP_TIMESCALE_YR);
  E.fastCooling[slot] += (fastTarget - E.fastCooling[slot]) * fastRate;

  // Slow response.
  const slowTarget = forcingMagnitude * TEMP_RESPONSE_PER_WM2 * 0.4;
  const slowRate = Math.min(1, dtYears / SLOW_TEMP_TIMESCALE_YR);
  E.slowCooling[slot] += (slowTarget - E.slowCooling[slot]) * slowRate;

  // Total cooling.
  E.totalCooling[slot] = E.fastCooling[slot] + E.slowCooling[slot];

  // Deactivation: eruption is "complete" when forcing has decayed to <5%.
  if (Math.abs(forcing) < 0.05) {
    E.active[slot] = 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// LATITUDINAL DISTRIBUTION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the aerosol distribution factor at a given latitude for an
 * eruption.
 */
function latitudinalFactor(eruptionSlot, latitudeDeg) {
  const E = VolcanicEruption;

  // Tropical eruption: spreads globally with some polar enhancement
  // (Brewer-Dobson circulation carries aerosol toward the poles).
  if (E.isTropical[slot_eruption(eruptionSlot)] === 1) {
    const absLat = Math.abs(latitudeDeg);
    // Slightly enhanced at high latitudes.
    if (absLat > 60) return 1.2;
    if (absLat > 30) return 1.1;
    return 1.0;
  }

  // High-latitude eruption: mostly cools its own hemisphere.
  const eruptionLat = E.latitudeDeg[eruptionSlot];
  const sameHemisphere = (eruptionLat > 0) === (latitudeDeg > 0);

  if (sameHemisphere) {
    // Strong local effect.
    return 1.0 - Math.abs(latitudeDeg - eruptionLat) / 180.0;
  }

  // Opposite hemisphere: damped.
  return HEMISPHERIC_DAMPING;
}

function slot_eruption(eruptionSlot) {
  // Helper for TS-unfriendly access pattern.
  return eruptionSlot;
}

// ═══════════════════════════════════════════════════════════════════════
// LOCAL SAMPLING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the volcanic-winter contribution at a given latitude.
 *
 * @returns { cooling, aod, uvMultiplier, twilightReddening, bishopRing, sunTransmission }
 */
export function sampleVolcanicAt(latitudeDeg) {
  const E = VolcanicEruption;

  let totalCooling = 0;
  let totalAod = 0;
  let maxUvMultiplier = 1.0;
  let totalTwilightReddening = 0;
  let totalBishopRing = 0;
  let totalSunBlock = 0;

  for (let slot = 0; slot < _nextEruptionSlot; slot++) {
    if (!E.active[slot]) continue;

    const latFactor = latitudinalFactor(slot, latitudeDeg);

    totalCooling += E.totalCooling[slot] * latFactor;
    totalAod += E.currentAod[slot] * latFactor;
    if (E.uvMultiplier[slot] > maxUvMultiplier) {
      maxUvMultiplier = E.uvMultiplier[slot];
    }

    // Atmospheric optics.
    totalTwilightReddening += Math.min(1.0,
      E.currentAod[slot] * TWILIGHT_REDDENING_PER_AOD);
    totalBishopRing += Math.min(1.0,
      E.currentAod[slot] * BISHOP_RING_INTENSITY_PER_AOD);

    // Sun dimming: exponential attenuation through the aerosol layer.
    // Transmission = exp(-τ · (1-β))
    totalSunBlock += E.currentAod[slot] * (1 - UPSCATTER_FRACTION);
  }

  // Sun transmission from combined AOD.
  const sunTransmission = Math.exp(-totalSunBlock);

  return {
    cooling: totalCooling,
    aod: totalAod,
    uvMultiplier: maxUvMultiplier,
    twilightReddening: Math.min(1.0, totalTwilightReddening),
    bishopRing: Math.min(1.0, totalBishopRing),
    sunTransmission: Math.max(0.1, sunTransmission),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM — advance eruptions
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance all active eruptions by dtYears.
 */
export function systemVolcanicWinterTick(world, dtYears) {
  const E = VolcanicEruption;

  // Reset global aggregation.
  GlobalVolcanicState.totalAod = 0;
  GlobalVolcanicState.totalForcing = 0;
  GlobalVolcanicState.globalCooling = 0;
  GlobalVolcanicState.globalStratosphericWarming = 0;
  GlobalVolcanicState.globalUvMultiplier = 1.0;
  GlobalVolcanicState.globalMonsoonDisruption = 0;
  GlobalVolcanicState.globalOzoneLoss = 0;
  GlobalVolcanicState.active = 0;

  for (let slot = 0; slot < _nextEruptionSlot; slot++) {
    if (!E.active[slot]) continue;

    E.yearsSinceEruption[slot] += dtYears;

    // Advance aerosol and forcing physics.
    updateEruptionAerosols(slot, dtYears);

    // Aggregate into global state.
    GlobalVolcanicState.active = 1;
    GlobalVolcanicState.totalAod += E.currentAod[slot];
    GlobalVolcanicState.totalForcing += E.currentForcing[slot];
    GlobalVolcanicState.globalCooling += E.totalCooling[slot];
    GlobalVolcanicState.globalStratosphericWarming += E.stratosphericWarming[slot];
    GlobalVolcanicState.globalUvMultiplier = Math.max(
      GlobalVolcanicState.globalUvMultiplier, E.uvMultiplier[slot]);
    GlobalVolcanicState.globalMonsoonDisruption = Math.min(
      MONSOON_DISRUPTION_MAX,
      GlobalVolcanicState.globalMonsoonDisruption + E.monsoonDisruption[slot]);
    GlobalVolcanicState.globalOzoneLoss = Math.max(
      GlobalVolcanicState.globalOzoneLoss, E.ozoneLoss[slot]);
  }

  // Update volcanic observers.
  systemUpdateVolcanicObservers(world);

  // Fire narrative events.
  processVolcanicNarrativeEvents();

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// OBSERVER UPDATE
// ═══════════════════════════════════════════════════════════════════════

function systemUpdateVolcanicObservers(world) {
  const O = VolcanicObserver;

  for (let slot = 0; slot < _nextVolcanicObserverSlot; slot++) {
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

    // Sample volcanic effects.
    const effects = sampleVolcanicAt(O.latitudeDeg[slot]);

    O.localCooling[slot] = effects.cooling;
    O.localAod[slot] = effects.aod;
    O.localUvMultiplier[slot] = effects.uvMultiplier;
    O.localTwilightReddening[slot] = effects.twilightReddening;
    O.localBishopRing[slot] = effects.bishopRing;
    O.localSunTransmission[slot] = effects.sunTransmission;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// NARRATIVE EVENTS
// ═══════════════════════════════════════════════════════════════════════

// Bit flags for narrative event stages.
const NARRATIVE_FIRST_COOLING = 1;
const NARRATIVE_PEAK_COOLING  = 2;
const NARRATIVE_RECOVERY      = 4;

function processVolcanicNarrativeEvents() {
  const E = VolcanicEruption;
  for (let slot = 0; slot < _nextEruptionSlot; slot++) {
    if (!E.active[slot]) continue;

    const flags = E.narrativeFired[slot];

    // First cooling: total cooling > 0.1 °C.
    if ((flags & NARRATIVE_FIRST_COOLING) === 0 && E.totalCooling[slot] > 0.1) {
      E.narrativeFired[slot] |= NARRATIVE_FIRST_COOLING;
    }

    // Peak cooling: cooling has stopped rising (currentSo2Tg below half).
    if ((flags & NARRATIVE_PEAK_COOLING) === 0
        && E.currentSo2Tg[slot] < E.so2Tg[slot] * 0.5
        && E.totalCooling[slot] > 0.2) {
      E.narrativeFired[slot] |= NARRATIVE_PEAK_COOLING;
    }

    // Recovery: cooling < 0.1 °C.
    if ((flags & NARRATIVE_RECOVERY) === 0
        && E.currentAod[slot] < 0.05
        && (flags & NARRATIVE_FIRST_COOLING) !== 0) {
      E.narrativeFired[slot] |= NARRATIVE_RECOVERY;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// WEATHER MODIFIER — coupling to file 063 scheduler
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a weather-type multiplier reflecting the current volcanic winter.
 * Multiplied into file 063's Markov chain weights.
 */
export function getVolcanicWeatherMultiplier(weatherType) {
  const cooling = GlobalVolcanicState.globalCooling;

  if (cooling < 0.05) return 1.0;

  switch (weatherType) {
    case WeatherType.LIGHT_SNOW:
    case WeatherType.MODERATE_SNOW:
    case WeatherType.BLIZZARD:
      // Snow becomes much more common.
      return 1.0 + cooling * 0.5;

    case WeatherType.OVERCAST:
    case WeatherType.MOSTLY_CLOUDY:
      // More cloud cover (aerosols act as cloud condensation nuclei).
      return 1.0 + cooling * 0.3;

    case WeatherType.HEAVY_RAIN:
    case WeatherType.MODERATE_RAIN:
      // Rain frequency similar, maybe slightly less (drier overall).
      return Math.max(0.7, 1.0 - cooling * 0.1);

    case WeatherType.THUNDERSTORM:
    case WeatherType.SUPERCELL:
      // Fewer storms (reduced convection due to cooling).
      return Math.max(0.3, 1.0 - cooling * 0.4);

    case WeatherType.DUST_STORM:
    case WeatherType.SANDSTORM:
      // Some drought enhancement, but less than climate change.
      return 1.0 + cooling * 0.1;

    case WeatherType.HURRICANE:
    case WeatherType.TROPICAL_STORM:
      // Fewer tropical cyclones.
      return Math.max(0.4, 1.0 - cooling * 0.5);

    case WeatherType.FOG:
    case WeatherType.MIST:
      // Fog more common in cooler conditions.
      return 1.0 + cooling * 0.2;

    case WeatherType.CLEAR_SUNNY:
      // Clear skies rare under aerosol layer.
      return Math.max(0.5, 1.0 - cooling * 0.3);

    default:
      return 1.0;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SNOW/TREE LINE COUPLING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the snow line shift due to volcanic cooling (metres).
 * Volcanic cooling LOWERS the snow line (opposite of climate change).
 */
export function getVolcanicSnowLineShift() {
  return -GlobalVolcanicState.globalCooling * 150.0;
}

/**
 * Return the tree line shift (metres).
 */
export function getVolcanicTreeLineShift() {
  return -GlobalVolcanicState.globalCooling * 120.0;
}

// ═══════════════════════════════════════════════════════════════════════
// SUN DIMMING AND ATMOSPHERIC OPTICS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the sun transmission factor through the volcanic aerosol layer.
 */
export function getVolcanicSunTransmission(latitudeDeg) {
  const effects = sampleVolcanicAt(latitudeDeg);
  return effects.sunTransmission;
}

/**
 * Return the twilight reddening factor.
 */
export function getVolcanicTwilightReddening(latitudeDeg) {
  const effects = sampleVolcanicAt(latitudeDeg);
  return effects.twilightReddening;
}

/**
 * Return the Bishop's ring intensity.
 */
export function getVolcanicBishopRing(latitudeDeg) {
  const effects = sampleVolcanicAt(latitudeDeg);
  return effects.bishopRing;
}

// ═══════════════════════════════════════════════════════════════════════
// CLIMATE CHANGE INTEGRATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the *combined* temperature anomaly from both climate change
 * (file 073) and volcanic winter.
 */
export function getCombinedTemperatureAnomaly(latitudeDeg) {
  const climateWarming = GlobalClimate.transientWarming || 0;
  const volcanicCooling = GlobalVolcanicState.globalCooling;

  return climateWarming - volcanicCooling;
}

/**
 * Return the total radiative forcing from all sources.
 */
export function getCombinedTotalForcing() {
  return (GlobalClimate.totalForcing || 0) + GlobalVolcanicState.totalForcing;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a human-readable preset label.
 */
export function presetLabel(preset) {
  switch (preset) {
    case HistoricEruption.TAMBORA_1815:       return 'Tambora 1815';
    case HistoricEruption.KRAKATOA_1883:      return 'Krakatoa 1883';
    case HistoricEruption.PINATUBO_1991:      return 'Pinatubo 1991';
    case HistoricEruption.AGUNG_1963:         return 'Agung 1963';
    case HistoricEruption.SANTA_MARIA_1902:   return 'Santa Maria 1902';
    case HistoricEruption.HUAYNAPUTINA_1600:  return 'Huaynaputina 1600';
    case HistoricEruption.LAKI_1783:          return 'Laki 1783';
    case HistoricEruption.TOBA_74000_YA:      return 'Toba 74,000 YA';
    case HistoricEruption.CUSTOM:             return 'Custom Eruption';
    default:                                   return 'Unknown';
  }
}

/**
 * Return a full summary of the volcanic winter state.
 */
export function getVolcanicWinterSummary() {
  return {
    active: GlobalVolcanicState.active === 1,
    totalAod: GlobalVolcanicState.totalAod,
    totalForcing: GlobalVolcanicState.totalForcing,
    globalCooling: GlobalVolcanicState.globalCooling,
    globalStratosphericWarming: GlobalVolcanicState.globalStratosphericWarming,
    globalUvMultiplier: GlobalVolcanicState.globalUvMultiplier,
    globalMonsoonDisruption: GlobalVolcanicState.globalMonsoonDisruption,
    globalOzoneLoss: GlobalVolcanicState.globalOzoneLoss,
    totalSo2Tg: GlobalVolcanicState.totalSo2Tg,
    lastEruptionYear: GlobalVolcanicState.lastEruptionYear,
  };
}

/**
 * Return the total UV multiplier (for sunburn / damage gameplay).
 */
export function getGlobalUvMultiplier() {
  return GlobalVolcanicState.globalUvMultiplier;
}

/**
 * Return the monsoon disruption fraction (0..1).
 */
export function getGlobalMonsoonDisruption() {
  return GlobalVolcanicState.globalMonsoonDisruption;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a summary of all active eruptions.
 */
export function gatherVolcanicWinterForRendering() {
  const result = [];
  const E = VolcanicEruption;

  for (let slot = 0; slot < _nextEruptionSlot; slot++) {
    if (!E.active[slot]) continue;

    result.push({
      slot,
      preset: E.preset[slot],
      presetLabel: presetLabel(E.preset[slot]),
      vei: E.vei[slot],
      latitudeDeg: E.latitudeDeg[slot],
      longitudeDeg: E.longitudeDeg[slot],
      injectionAltitudeKm: E.injectionAltitudeKm[slot],
      isTropical: E.isTropical[slot] === 1,
      yearsSinceEruption: E.yearsSinceEruption[slot],
      so2Tg: E.so2Tg[slot],
      currentSo2Tg: E.currentSo2Tg[slot],
      currentAerosolTg: E.currentAerosolTg[slot],
      currentAod: E.currentAod[slot],
      currentForcing: E.currentForcing[slot],
      stratosphericWarming: E.stratosphericWarming[slot],
      totalCooling: E.totalCooling[slot],
      ozoneLoss: E.ozoneLoss[slot],
      uvMultiplier: E.uvMultiplier[slot],
      spreadProgress: E.spreadProgress[slot],
      monsoonDisruption: E.monsoonDisruption[slot],
    });
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function volcanicWinterStats() {
  let activeEruptions = 0;
  let activeObservers = 0;
  let totalVeI = 0;

  for (let slot = 0; slot < _nextEruptionSlot; slot++) {
    if (!VolcanicEruption.active[slot]) continue;
    activeEruptions++;
    totalVeI += VolcanicEruption.vei[slot];
  }

  for (let slot = 0; slot < _nextVolcanicObserverSlot; slot++) {
    if (VolcanicObserver.active[slot]) activeObservers++;
  }

  return {
    activeEruptions,
    maxEruptions: MAX_ERUPTIONS,
    activeObservers,
    maxObservers: MAX_VOLCANIC_OBSERVERS,
    totalVeI,
    totalAod: GlobalVolcanicState.totalAod,
    globalCooling: GlobalVolcanicState.globalCooling,
    globalStratosphericWarming: GlobalVolcanicState.globalStratosphericWarming,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearVolcanicWinter() {
  VolcanicEruption.active.fill(0);
  VolcanicEruption.ventEid.fill(0);
  _eruptionSlots.clear();
  _nextEruptionSlot = 0;

  VolcanicObserver.active.fill(0);
  VolcanicObserver.ownerEid.fill(0);
  _volcanicObserverSlots.clear();
  _nextVolcanicObserverSlot = 0;

  GlobalVolcanicState.totalAod = 0;
  GlobalVolcanicState.totalForcing = 0;
  GlobalVolcanicState.globalCooling = 0;
  GlobalVolcanicState.globalStratosphericWarming = 0;
  GlobalVolcanicState.globalUvMultiplier = 1.0;
  GlobalVolcanicState.globalMonsoonDisruption = 0;
  GlobalVolcanicState.globalOzoneLoss = 0;
  GlobalVolcanicState.active = 0;
  GlobalVolcanicState.lastEruptionYear = -1;
  GlobalVolcanicState.totalSo2Tg = 0;
}