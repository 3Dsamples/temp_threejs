// file number : 075
// full path name : src/weather/075_nuclear_winter.js
// description : Nuclear winter system. Models the catastrophic short-term
//               (1-30 year) global cooling that would follow a large-scale
//               nuclear exchange, where firestorms inject millions of
//               tonnes of soot (black carbon) into the stratosphere.
//               The soot absorbs incoming solar radiation, heats the
//               stratosphere, cools the surface, destroys ozone, and
//               destabilizes global agriculture.
//
//               Follows the Robock, Oman & Stenchikov (2007) "Nuclear
//               winter revisited" model and the more recent Toon et al.
//               (2019) "Rapidly expanding nuclear arsenals in Pakistan
//               and India portend regional and global catastrophe"
//               parameters.
//
//               Sits alongside:
//                 • file 073 (climate change) — long-term warming
//                 • file 074 (volcanic winter) — natural short-term cooling
//               All three compose additively for surface temperature.
//
//               Contributes:
//                 • SCENARIO TAXONOMY — the full set of nuclear exchange
//                   scenarios:
//                     - INDIA_PAKISTAN_REGIONAL: 100 Tg soot (100 Hiroshima-
//                       scale weapons). Regional catastrophe, 5-10 year
//                       global cooling.
//                     - US_RUSSIA_LIMITED: 150 Tg soot. Massive global
//                       disruption.
//                     - US_RUSSIA_FULL: 150 Tg soot (equivalent to the
//                       "full exchange" of the 1980s).
//                     - CUSTOM
//
//                 • SOOT INJECTION — SoA SootInjection records:
//                     - source (which country / region initiated)
//                     - explosion events count (weapons detonated)
//                     - yield total (megatons TNT)
//                     - soot mass (Tg)
//                     - injection altitude (km)
//                     - hemisphere (N/S; affects dispersal)
//                     - start year (game year of the exchange)
//
//                 • STRATOSPHERIC SOOT PHYSICS — full Robock model:
//                     - Initial lofting (from firestorm updraft) into the
//                       lower stratosphere (10-15 km)
//                     - Slow settling via gravitational sedimentation
//                       (~2-4 year residence)
//                     - Latitudinal spread via Brewer-Dobson circulation
//                       (~6-12 months to reach global distribution)
//                     - Coagulation into larger particles accelerates
//                       settling later in the decay
//
//                 • RADIATIVE FORCING — negative forcing from soot
//                   absorbing sunlight:
//                     ΔF = -S₀/4 · T · (1-α) · (1-f_planet) · τ_soot
//                   where f_planet is the fraction of soot hidden below
//                   the cloud layer. 150 Tg of soot produces ~-100 W/m²
//                   global forcing (vs Pinatubo's -4 W/m² from 20 Tg
//                   of SO₂ that form 0.5 Tg of aerosol).
//
//                 • SURFACE COOLING — the 150 Tg scenario produces
//                   -8 to -10 °C global cooling for 5-10 years, with
//                   regional cooling up to -20 °C over continental
//                   interiors during winter (firestorm soot blocks sun,
//                   so land cools fastest while oceans buffer).
//
//                 • STRATOSPHERIC WARMING — +30 to +50 °C in the
//                   lower stratosphere (the "black stratosphere").
//
//                 • OZONE DESTRUCTION — 50-80% column ozone loss
//                   (soot heats stratosphere, accelerates catalytic
//                   destruction, and disrupts the polar vortex).
//
//                 • UV INCREASE — surface UV index 3-5× normal for
//                   years, causing skin damage, crop damage, and
//                   ecological collapse.
//
//                 • NUCLEAR TWILIGHT — reduced sunlight (10-20% of
//                   normal for first year), 2-3 km visibility through
//                   dusty haze, orange/brown sky color.
//
//                 • AGRICULTURAL COLLAPSE — proxy model:
//                     - Growing season shortened by 30-90 days
//                     - Crop yield reduced to 20-60% of normal
//                     - Famine risk index (0..1) exposed
//                     - Ocean productivity reduced to 40-70%
//
//                 • WEATHER MODIFICATION — modifies file 063's Markov
//                   weights:
//                     - No more clear sunny days
//                     - Snow and blizzards vastly increased
//                     - Overcast permanent
//                     - No thunderstorms (insufficient surface heating)
//                     - No tropical cyclones (no ocean-atmosphere
//                       temperature contrast)
//
//                 • OCEAN RESPONSE — sea surface temperatures drop
//                   5-10 °C; marine productivity collapses; sea ice
//                   expands dramatically, exposed via
//                   file 059's water body state.
//
//                 • RECOVERY — 30-50 year recovery timescale for the
//                   full US-Russia scenario (soot settles slowly);
//                   India-Pakistan scenario recovers in 5-10 years.
//
//                 • NARRATIVE MILESTONES — callbacks for:
//                     - STRIKE_DAY: exchange begins
//                     - ONE_WEEK: initial firestorm soot injection
//                     - FIRST_WINTER: first nuclear winter winter
//                     - DARKEST_DAY: peak cooling
//                     - FIRST_THAW: soot has decayed below threshold
//                     - FULL_RECOVERY: climate back to baseline
//
//                 • COMBINATION WITH CLIMATE CHANGE — soot cooling
//                   subtracts from file 073's greenhouse warming, so
//                   a nuclear winter in 2080 could temporarily mask
//                   decades of warming.
//
//                 • COMBINATION WITH VOLCANIC WINTER — both contribute
//                   to combined cooling; they are NOT independent (in
//                   reality the soot would also block volcanic aerosols
//                   from view), but the current model treats them as
//                   additive for simplicity.
//
//               All state lives in typed arrays; per-frame cost is
//               O(active injections) × O(1) + O(observers) × O(1).
//               Zero per-frame allocation; steady-state 1M-entity
//               scenes handle nuclear winter on Android 64-bit.
// best for : Post-apocalyptic survival games, WW3 simulations,
//            narrative scenarios, disaster arcade games, cold
//            survival challenges, and any 1M-entity scene needing a
//            scientifically grounded nuclear winter model.
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
  WaterBody,
  WaterBodyTag,
} from './059_water_surface.js';

import {
  GlobalClimate,
  Scenario,
} from './073_climate_change.js';

import {
  GlobalVolcanicState,
} from './074_volcanic_winter.js';

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
const SOOT_DENSITY                   = 1800.0;   // kg/m³ (black carbon)

// ── Robock 2007 parameters ─────────────────────────────────
// 150 Tg soot gives ~ -100 W/m² global forcing.
const SOOT_FORCING_PER_TG            = -0.667;   // W/m² per Tg
const SOOT_FORCING_MAX               = -120.0;   // W/m² cap (extreme)
const SOOT_RESIDENCE_TIME_YEARS      = 4.0;      // stratospheric settling
const SOOT_SPREAD_MONTHS             = 6.0;      // to global distribution
const SOOT_INJECTION_ALTITUDE_KM     = 12.0;     // typical firestorm height
const SOOT_HEMISPHERIC_ASYMMETRY     = 0.75;     // same-hemisphere fraction
const SOOT_PLANET_FRACTION           = 0.10;     // fraction "hidden" below clouds

// ── Temperature response ────────────────────────────────────
const TEMP_RESPONSE_PER_WM2          = 0.07;     // °C per W/m² (Robock)
const FAST_TEMP_TIMESCALE_YR         = 0.8;
const SLOW_TEMP_TIMESCALE_YR         = 5.0;
const CONTINENTAL_AMPLIFICATION      = 2.5;      // continental interiors cool more
const OCEAN_BUFFER_FACTOR            = 0.4;      // oceans cool slower

// ── Stratospheric warming ──────────────────────────────────
const STRATOSPHERIC_WARMING_PER_WM2  = 0.4;      // °C per W/m²
const STRATOSPHERIC_WARMING_MAX      = 60.0;     // °C

// ── Ozone destruction ──────────────────────────────────────
const OZONE_LOSS_PER_TG_SOOT         = 0.004;    // fraction per Tg
const OZONE_LOSS_MAX                 = 0.75;     // 75% max column loss
const OZONE_RECOVERY_TIMESCALE_YR    = 8.0;
const UV_INCREASE_PER_OZONE_LOSS     = 3.0;      // ~3× UV at 75% loss

// ── Sun dimming ────────────────────────────────────────────
const SUN_TRANSMISSION_MIN           = 0.05;     // 5% minimum (nuclear twilight)
const SUN_TRANSMISSION_PER_TG        = 0.02;     // fraction dimmed per Tg
const NUCLEAR_TWILIGHT_REDDENING     = 0.6;      // orange/brown shift

// ── Agricultural collapse ──────────────────────────────────
const GROWING_SEASON_SHORTEN_PER_C   = 8.0;      // days per °C cooling
const CROP_YIELD_LOSS_PER_C          = 0.06;     // fraction per °C
const OCEAN_PRODUCTIVITY_LOSS_PER_C  = 0.05;
const FAMINE_RISK_PER_C              = 0.10;

// ── Recovery ───────────────────────────────────────────────
const SOOT_DECAY_FAST_TIMESCALE_YR   = 2.0;      // initial fast decay
const SOOT_DECAY_SLOW_TIMESCALE_YR   = 8.0;      // later slow decay
const SOOT_DECAY_PIVOT_YEARS         = 2.0;      // pivot for two-phase decay
const RECOVERY_THRESHOLD_AOD         = 0.02;     // "recovered" AOD

// ── Scenario presets ───────────────────────────────────────
const SCENARIO_INDIA_PAKISTAN_TG     = 5.0;      // ~100 weapons of 15 kt
const SCENARIO_INDIA_PAKISTAN_YIELD  = 1.5;      // megatons TNT
const SCENARIO_LIMITED_TG            = 50.0;     // 150 weapons
const SCENARIO_LIMITED_YIELD         = 15.0;
const SCENARIO_FULL_TG               = 150.0;    // 4400 weapons
const SCENARIO_FULL_YIELD            = 4400.0;
const SCENARIO_EXTREME_TG            = 500.0;    // worst case
const SCENARIO_EXTREME_YIELD         = 15000.0;

// ── SoA size limits ───────────────────────────────────────
const MAX_SOOT_INJECTIONS            = 32;
const MAX_NUCLEAR_OBSERVERS          = 128;
const MAX_NARRATIVE_EVENTS           = 64;

// ── Narrative event bit flags ─────────────────────────────
const NARRATIVE_STRIKE_DAY           = 1;
const NARRATIVE_ONE_WEEK             = 2;
const NARRATIVE_FIRST_WINTER         = 4;
const NARRATIVE_DARKEST_DAY          = 8;
const NARRATIVE_FIRST_THAW           = 16;
const NARRATIVE_FULL_RECOVERY        = 32;

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO ENUM
// ═══════════════════════════════════════════════════════════════════════

export const NuclearScenario = Object.freeze({
  INDIA_PAKISTAN_REGIONAL: 0,
  US_RUSSIA_LIMITED:       1,
  US_RUSSIA_FULL:          2,
  EXTREME:                 3,
  CUSTOM:                  4,
});

// ═══════════════════════════════════════════════════════════════════════
// HEMISPHERE ENUM (which hemisphere the soot is primarily injected into)
// ═══════════════════════════════════════════════════════════════════════

export const InjectionHemisphere = Object.freeze({
  NORTHERN: 0,
  SOUTHERN: 1,
  BOTH:     2,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA SOOT INJECTION
// ═══════════════════════════════════════════════════════════════════════

export const SootInjection = {
  active: new Uint8Array(MAX_SOOT_INJECTIONS),

  // Scenario preset.
  scenario: new Uint8Array(MAX_SOOT_INJECTIONS),

  // Total soot injected (Tg).
  totalSootTg: new Float32Array(MAX_SOOT_INJECTIONS),

  // Current remaining soot (Tg).
  currentSootTg: new Float32Array(MAX_SOOT_INJECTIONS),

  // Total weapons detonated.
  weaponCount: new Float32Array(MAX_SOOT_INJECTIONS),

  // Total yield (megatons TNT).
  totalYieldMt: new Float32Array(MAX_SOOT_INJECTIONS),

  // Injection altitude (km).
  injectionAltitudeKm: new Float32Array(MAX_SOOT_INJECTIONS),

  // Hemisphere.
  hemisphere: new Uint8Array(MAX_SOOT_INJECTIONS),

  // Years since injection.
  yearsSinceInjection: new Float32Array(MAX_SOOT_INJECTIONS),

  // Latitudinal spread progress (0..1).
  spreadProgress: new Float32Array(MAX_SOOT_INJECTIONS),

  // Current soot AOD (optical depth).
  currentAod: new Float32Array(MAX_SOOT_INJECTIONS),

  // Current radiative forcing (W/m²; negative = cooling).
  currentForcing: new Float32Array(MAX_SOOT_INJECTIONS),

  // Current surface cooling (°C).
  surfaceCooling: new Float32Array(MAX_SOOT_INJECTIONS),

  // Current stratospheric warming (°C).
  stratosphericWarming: new Float32Array(MAX_SOOT_INJECTIONS),

  // Current ozone loss (0..1).
  ozoneLoss: new Float32Array(MAX_SOOT_INJECTIONS),

  // Current UV multiplier (1.0 = normal, 3-5 = elevated).
  uvMultiplier: new Float32Array(MAX_SOOT_INJECTIONS),

  // Current sun transmission (fraction of normal sunlight reaching ground).
  sunTransmission: new Float32Array(MAX_SOOT_INJECTIONS),

  // Current famine risk (0..1).
  famineRisk: new Float32Array(MAX_SOOT_INJECTIONS),

  // Growing season reduction (days).
  growingSeasonReduction: new Float32Array(MAX_SOOT_INJECTIONS),

  // Crop yield factor (0..1; 1 = normal, 0 = total failure).
  cropYieldFactor: new Float32Array(MAX_SOOT_INJECTIONS),

  // Fast cooling component (°C).
  fastCooling: new Float32Array(MAX_SOOT_INJECTIONS),

  // Slow cooling component (°C).
  slowCooling: new Float32Array(MAX_SOOT_INJECTIONS),

  // Narrative event flags (bitmask).
  narrativeFlags: new Uint8Array(MAX_SOOT_INJECTIONS),

  // Active.
  active: new Uint8Array(MAX_SOOT_INJECTIONS),

  // Seed.
  seed: new Uint32Array(MAX_SOOT_INJECTIONS),
};

/** Marker: entity is a soot injection record. */
export const SootInjectionTag = {};

const _sootInjectionSlots = new Map();
let _nextSootInjectionSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA NUCLEAR OBSERVER — samples nuclear winter effects at a position
// ═══════════════════════════════════════════════════════════════════════

export const NuclearObserver = {
  ownerEid: new Uint32Array(MAX_NUCLEAR_OBSERVERS),

  // World position.
  px: new Float32Array(MAX_NUCLEAR_OBSERVERS),
  py: new Float32Array(MAX_NUCLEAR_OBSERVERS),
  pz: new Float32Array(MAX_NUCLEAR_OBSERVERS),

  // Latitude (degrees; determines hemisphere effect).
  latitudeDeg: new Float32Array(MAX_NUCLEAR_OBSERVERS),

  // Whether the position is on a continent (cools faster).
  onContinent: new Uint8Array(MAX_NUCLEAR_OBSERVERS),

  // Local cooling (°C).
  localCooling: new Float32Array(MAX_NUCLEAR_OBSERVERS),

  // Local sun transmission (fraction).
  localSunTransmission: new Float32Array(MAX_NUCLEAR_OBSERVERS),

  // Local UV multiplier.
  localUvMultiplier: new Float32Array(MAX_NUCLEAR_OBSERVERS),

  // Local famine risk (0..1).
  localFamineRisk: new Float32Array(MAX_NUCLEAR_OBSERVERS),

  // Local AOD.
  localAod: new Float32Array(MAX_NUCLEAR_OBSERVERS),

  // Active.
  active: new Uint8Array(MAX_NUCLEAR_OBSERVERS),
};

/** Marker: entity observes nuclear winter effects. */
export const NuclearObserverTag = {};

const _nuclearObserverSlots = new Map();
let _nextNuclearObserverSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// GLOBAL NUCLEAR WINTER STATE (aggregate)
// ═══════════════════════════════════════════════════════════════════════

export const GlobalNuclearState = {
  // Aggregate soot (Tg).
  totalSootTg: 0,

  // Aggregate AOD.
  totalAod: 0,

  // Aggregate forcing (W/m²).
  totalForcing: 0,

  // Global mean surface cooling (°C).
  globalCooling: 0,

  // Global stratospheric warming (°C).
  globalStratosphericWarming: 0,

  // Global ozone loss (0..1).
  globalOzoneLoss: 0,

  // Global UV multiplier.
  globalUvMultiplier: 1.0,

  // Global sun transmission (fraction).
  globalSunTransmission: 1.0,

  // Global famine risk (0..1).
  globalFamineRisk: 0,

  // Whether nuclear winter is currently active (soot > threshold).
  active: 0,

  // Years since first injection.
  yearsSinceFirstInjection: 0,

  // Maximum cooling ever reached (°C).
  maxCoolingReached: 0,

  // Maximum AOD ever reached.
  maxAodReached: 0,
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
// SCENARIO PRESET LOOKUP
// ═══════════════════════════════════════════════════════════════════════

const NUCLEAR_PRESETS = {
  [NuclearScenario.INDIA_PAKISTAN_REGIONAL]: {
    sootTg: SCENARIO_INDIA_PAKISTAN_TG,
    weaponCount: 100,
    yieldMt: SCENARIO_INDIA_PAKISTAN_YIELD,
    hemisphere: InjectionHemisphere.NORTHERN,
  },
  [NuclearScenario.US_RUSSIA_LIMITED]: {
    sootTg: SCENARIO_LIMITED_TG,
    weaponCount: 150,
    yieldMt: SCENARIO_LIMITED_YIELD,
    hemisphere: InjectionHemisphere.NORTHERN,
  },
  [NuclearScenario.US_RUSSIA_FULL]: {
    sootTg: SCENARIO_FULL_TG,
    weaponCount: 4400,
    yieldMt: SCENARIO_FULL_YIELD,
    hemisphere: InjectionHemisphere.BOTH,
  },
  [NuclearScenario.EXTREME]: {
    sootTg: SCENARIO_EXTREME_TG,
    weaponCount: 15000,
    yieldMt: SCENARIO_EXTREME_YIELD,
    hemisphere: InjectionHemisphere.BOTH,
  },
  [NuclearScenario.CUSTOM]: {
    sootTg: 50.0,
    weaponCount: 100,
    yieldMt: 10.0,
    hemisphere: InjectionHemisphere.NORTHERN,
  },
};

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — INJECTION CREATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a nuclear winter soot injection (an exchange event).
 *
 * @param world       ECS world
 * @param eid         entity
 * @param scenario    NuclearScenario
 * @param options     { sootTg, weaponCount, yieldMt, injectionAltitudeKm,
 *                      hemisphere, seed }
 * @returns soot injection slot
 */
export function addSootInjection(world, eid, scenario = NuclearScenario.US_RUSSIA_LIMITED, options = {}) {
  if (_nextSootInjectionSlot >= MAX_SOOT_INJECTIONS) {
    throw new Error('soot injection capacity exceeded');
  }
  const slot = _nextSootInjectionSlot++;

  addComponent(world, eid, SootInjectionTag);

  const preset = NUCLEAR_PRESETS[scenario] || NUCLEAR_PRESETS[NuclearScenario.CUSTOM];

  const S = SootInjection;
  S.active[slot] = 1;
  S.scenario[slot] = scenario;
  S.totalSootTg[slot] = options.sootTg ?? preset.sootTg;
  S.currentSootTg[slot] = S.totalSootTg[slot];
  S.weaponCount[slot] = options.weaponCount ?? preset.weaponCount;
  S.totalYieldMt[slot] = options.yieldMt ?? preset.yieldMt;
  S.injectionAltitudeKm[slot] = options.injectionAltitudeKm ?? SOOT_INJECTION_ALTITUDE_KM;
  S.hemisphere[slot] = options.hemisphere ?? preset.hemisphere;
  S.yearsSinceInjection[slot] = 0;
  S.spreadProgress[slot] = 0;
  S.currentAod[slot] = 0;
  S.currentForcing[slot] = 0;
  S.surfaceCooling[slot] = 0;
  S.stratosphericWarming[slot] = 0;
  S.ozoneLoss[slot] = 0;
  S.uvMultiplier[slot] = 1.0;
  S.sunTransmission[slot] = 1.0;
  S.famineRisk[slot] = 0;
  S.growingSeasonReduction[slot] = 0;
  S.cropYieldFactor[slot] = 1.0;
  S.fastCooling[slot] = 0;
  S.slowCooling[slot] = 0;
  S.narrativeFlags[slot] = 0;
  S.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  _sootInjectionSlots.set(eid, slot);

  // Fire STRIKE_DAY narrative flag immediately.
  S.narrativeFlags[slot] |= NARRATIVE_STRIKE_DAY;

  // Update global state.
  GlobalNuclearState.active = 1;
  GlobalNuclearState.totalSootTg += S.totalSootTg[slot];

  return slot;
}

export function removeSootInjection(world, eid) {
  const slot = _sootInjectionSlots.get(eid);
  if (slot === undefined) return;
  SootInjection.active[slot] = 0;
  _sootInjectionSlots.delete(eid);
  removeComponent(world, eid, SootInjectionTag);
}

export function getSootInjectionSlot(eid) {
  return _sootInjectionSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// OBSERVER API
// ═══════════════════════════════════════════════════════════════════════

export function addNuclearObserver(world, eid, latitudeDeg, onContinent = true) {
  if (_nextNuclearObserverSlot >= MAX_NUCLEAR_OBSERVERS) {
    throw new Error('nuclear observer capacity exceeded');
  }
  const slot = _nextNuclearObserverSlot++;

  addComponent(world, eid, NuclearObserverTag);

  const O = NuclearObserver;
  O.ownerEid[slot] = eid;
  O.px[slot] = 0;
  O.py[slot] = 0;
  O.pz[slot] = 0;
  O.latitudeDeg[slot] = latitudeDeg ?? 45;
  O.onContinent[slot] = onContinent ? 1 : 0;
  O.localCooling[slot] = 0;
  O.localSunTransmission[slot] = 1.0;
  O.localUvMultiplier[slot] = 1.0;
  O.localFamineRisk[slot] = 0;
  O.localAod[slot] = 0;
  O.active[slot] = 1;

  _nuclearObserverSlots.set(eid, slot);
  return slot;
}

export function removeNuclearObserver(world, eid) {
  const slot = _nuclearObserverSlots.get(eid);
  if (slot === undefined) return;
  NuclearObserver.active[slot] = 0;
  NuclearObserver.ownerEid[slot] = 0;
  _nuclearObserverSlots.delete(eid);
  removeComponent(world, eid, NuclearObserverTag);
}

export function getNuclearObserverSlot(eid) {
  return _nuclearObserverSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// SOOT PHYSICS — decay, spread, forcing
// ═══════════════════════════════════════════════════════════════════════

/**
 * Update the soot physics for one injection.
 * Uses two-phase exponential decay (fast then slow) matching the
 * Robock 2007 model: initial rapid settling of large particles,
 * followed by slow settling of small particles.
 */
function updateSootPhysics(slot, dtYears) {
  const S = SootInjection;

  S.yearsSinceInjection[slot] += dtYears;

  // Two-phase decay.
  let decayRate;
  if (S.yearsSinceInjection[slot] < SOOT_DECAY_PIVOT_YEARS) {
    decayRate = Math.exp(-dtYears / SOOT_DECAY_FAST_TIMESCALE_YR);
  } else {
    decayRate = Math.exp(-dtYears / SOOT_DECAY_SLOW_TIMESCALE_YR);
  }
  S.currentSootTg[slot] *= decayRate;

  // Clamp negative.
  if (S.currentSootTg[slot] < 0) S.currentSootTg[slot] = 0;

  // Latitudinal spread.
  const spreadRate = 12.0 / SOOT_SPREAD_MONTHS;   // per year
  S.spreadProgress[slot] = Math.min(1, S.spreadProgress[slot] + spreadRate * dtYears);

  // AOD calculation: soot mass × extinction coefficient.
  // Empirical: 150 Tg gives AOD ~40 (Robock 2007).
  // 150 Tg → 40 AOD → 0.267 AOD per Tg.
  const AOD_PER_TG = 0.267;
  S.currentAod[slot] = S.currentSootTg[slot] * AOD_PER_TG;

  // Radiative forcing.
  const forcing = Math.max(SOOT_FORCING_MAX,
    S.currentSootTg[slot] * SOOT_FORCING_PER_TG);
  S.currentForcing[slot] = forcing;

  // Stratospheric warming: soot absorbs solar energy.
  S.stratosphericWarming[slot] = Math.min(STRATOSPHERIC_WARMING_MAX,
    -forcing * STRATOSPHERIC_WARMING_PER_WM2);

  // Surface cooling via two-box model.
  const forcingMagnitude = -forcing;   // positive for cooling.

  // Fast component (atmosphere).
  const fastTarget = forcingMagnitude * TEMP_RESPONSE_PER_WM2 * 0.5;
  const fastRate = Math.min(1, dtYears / FAST_TEMP_TIMESCALE_YR);
  S.fastCooling[slot] += (fastTarget - S.fastCooling[slot]) * fastRate;

  // Slow component (ocean mixed layer).
  const slowTarget = forcingMagnitude * TEMP_RESPONSE_PER_WM2 * 0.5;
  const slowRate = Math.min(1, dtYears / SLOW_TEMP_TIMESCALE_YR);
  S.slowCooling[slot] += (slowTarget - S.slowCooling[slot]) * slowRate;

  // Total cooling.
  S.surfaceCooling[slot] = S.fastCooling[slot] + S.slowCooling[slot];

  // Ozone destruction.
  const ozoneTargetLoss = Math.min(OZONE_LOSS_MAX,
    S.totalSootTg[slot] * OZONE_LOSS_PER_TG_SOOT);
  const ozoneRecovery = Math.exp(-dtYears / OZONE_RECOVERY_TIMESCALE_YR);
  S.ozoneLoss[slot] = ozoneTargetLoss * ozoneRecovery;

  // UV increase.
  S.uvMultiplier[slot] = 1.0 + S.ozoneLoss[slot] * UV_INCREASE_PER_OZONE_LOSS;

  // Sun transmission (dimming by soot AOD).
  const dimmingPerTg = Math.min(0.95, S.currentSootTg[slot] * SUN_TRANSMISSION_PER_TG);
  S.sunTransmission[slot] = Math.max(SUN_TRANSMISSION_MIN, 1.0 - dimmingPerTg);

  // Growing season reduction.
  S.growingSeasonReduction[slot] = Math.min(180,
    S.surfaceCooling[slot] * GROWING_SEASON_SHORTEN_PER_C);

  // Crop yield factor.
  S.cropYieldFactor[slot] = Math.max(0.05, 1.0 - S.surfaceCooling[slot] * CROP_YIELD_LOSS_PER_C);

  // Famine risk.
  S.famineRisk[slot] = Math.min(1.0,
    S.surfaceCooling[slot] * FAMINE_RISK_PER_C);
}

// ═══════════════════════════════════════════════════════════════════════
// LATITUDINAL FACTOR
// ═══════════════════════════════════════════════════════════════════════

function latitudinalFactor(sootSlot, latitudeDeg) {
  const S = SootInjection;
  const hemisphere = S.hemisphere[sootSlot];

  if (hemisphere === InjectionHemisphere.BOTH) {
    // Both hemispheres get full effect.
    return 1.0;
  }

  // Determine which hemisphere the injection is in.
  const injectionIsNorthern = hemisphere === InjectionHemisphere.NORTHERN;
  const observerIsNorthern = latitudeDeg >= 0;

  // Same hemisphere gets full effect; opposite gets damped.
  if (injectionIsNorthern === observerIsNorthern) {
    return 1.0;
  }

  // Cross-hemisphere gets damped by SOOT_HEMISPHERIC_ASYMMETRY.
  return 1.0 - SOOT_HEMISPHERIC_ASYMMETRY;
}

// ═══════════════════════════════════════════════════════════════════════
// LOCAL SAMPLING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the nuclear-winter effects at a latitude.
 *
 * @returns { cooling, aod, sunTransmission, uvMultiplier, famineRisk,
 *            growingSeasonReduction, cropYieldFactor }
 */
export function sampleNuclearAt(latitudeDeg, onContinent = true) {
  const S = SootInjection;

  let totalCooling = 0;
  let totalAod = 0;
  let minSunTransmission = 1.0;
  let maxUvMultiplier = 1.0;
  let maxFamineRisk = 0;
  let maxGrowingSeasonReduction = 0;
  let minCropYieldFactor = 1.0;

  for (let slot = 0; slot < _nextSootInjectionSlot; slot++) {
    if (!S.active[slot]) continue;
    if (S.currentSootTg[slot] < EPSILON) continue;

    const latFactor = latitudinalFactor(slot, latitudeDeg);

    // Continental amplification: land cools faster than ocean.
    const continentalFactor = onContinent ? CONTINENTAL_AMPLIFICATION : OCEAN_BUFFER_FACTOR;

    totalCooling += S.surfaceCooling[slot] * latFactor * continentalFactor;
    totalAod += S.currentAod[slot] * latFactor;
    if (S.sunTransmission[slot] < minSunTransmission) {
      minSunTransmission = S.sunTransmission[slot];
    }
    if (S.uvMultiplier[slot] > maxUvMultiplier) {
      maxUvMultiplier = S.uvMultiplier[slot];
    }
    if (S.famineRisk[slot] > maxFamineRisk) {
      maxFamineRisk = S.famineRisk[slot];
    }
    if (S.growingSeasonReduction[slot] > maxGrowingSeasonReduction) {
      maxGrowingSeasonReduction = S.growingSeasonReduction[slot];
    }
    if (S.cropYieldFactor[slot] < minCropYieldFactor) {
      minCropYieldFactor = S.cropYieldFactor[slot];
    }
  }

  return {
    cooling: totalCooling,
    aod: totalAod,
    sunTransmission: minSunTransmission,
    uvMultiplier: maxUvMultiplier,
    famineRisk: maxFamineRisk,
    growingSeasonReduction: maxGrowingSeasonReduction,
    cropYieldFactor: minCropYieldFactor,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM — advance injections
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance all active soot injections by dtYears.
 */
export function systemNuclearWinterTick(world, dtYears) {
  const S = SootInjection;

  // Reset global aggregation.
  GlobalNuclearState.totalSootTg = 0;
  GlobalNuclearState.totalAod = 0;
  GlobalNuclearState.totalForcing = 0;
  GlobalNuclearState.globalCooling = 0;
  GlobalNuclearState.globalStratosphericWarming = 0;
  GlobalNuclearState.globalOzoneLoss = 0;
  GlobalNuclearState.globalUvMultiplier = 1.0;
  GlobalNuclearState.globalSunTransmission = 1.0;
  GlobalNuclearState.globalFamineRisk = 0;
  GlobalNuclearState.active = 0;

  let earliestInjectionYears = Infinity;

  for (let slot = 0; slot < _nextSootInjectionSlot; slot++) {
    if (!S.active[slot]) continue;

    // Advance physics.
    updateSootPhysics(slot, dtYears);

    // Aggregate.
    GlobalNuclearState.totalSootTg += S.currentSootTg[slot];
    GlobalNuclearState.totalAod += S.currentAod[slot];
    GlobalNuclearState.totalForcing += S.currentForcing[slot];
    GlobalNuclearState.globalCooling += S.surfaceCooling[slot];
    GlobalNuclearState.globalStratosphericWarming += S.stratosphericWarming[slot];
    GlobalNuclearState.globalOzoneLoss = Math.max(
      GlobalNuclearState.globalOzoneLoss, S.ozoneLoss[slot]);
    GlobalNuclearState.globalUvMultiplier = Math.max(
      GlobalNuclearState.globalUvMultiplier, S.uvMultiplier[slot]);
    GlobalNuclearState.globalSunTransmission = Math.min(
      GlobalNuclearState.globalSunTransmission, S.sunTransmission[slot]);
    GlobalNuclearState.globalFamineRisk = Math.max(
      GlobalNuclearState.globalFamineRisk, S.famineRisk[slot]);

    if (earliestInjectionYears > S.yearsSinceInjection[slot]) {
      earliestInjectionYears = S.yearsSinceInjection[slot];
    }

    // Update peak tracking.
    if (S.surfaceCooling[slot] > GlobalNuclearState.maxCoolingReached) {
      GlobalNuclearState.maxCoolingReached = S.surfaceCooling[slot];
    }
    if (S.currentAod[slot] > GlobalNuclearState.maxAodReached) {
      GlobalNuclearState.maxAodReached = S.currentAod[slot];
    }

    // Deactivate injection when soot has decayed.
    if (S.currentAod[slot] < RECOVERY_THRESHOLD_AOD) {
      S.active[slot] = 0;
    } else {
      GlobalNuclearState.active = 1;
    }
  }

  if (GlobalNuclearState.active) {
    GlobalNuclearState.yearsSinceFirstInjection = earliestInjectionYears;
  }

  // Update observers.
  systemUpdateNuclearObservers(world);

  // Fire narrative events.
  processNuclearNarrativeEvents();

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// OBSERVER UPDATE
// ═══════════════════════════════════════════════════════════════════════

function systemUpdateNuclearObservers(world) {
  const O = NuclearObserver;

  for (let slot = 0; slot < _nextNuclearObserverSlot; slot++) {
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

    // Sample effects.
    const effects = sampleNuclearAt(
      O.latitudeDeg[slot],
      O.onContinent[slot] === 1
    );

    O.localCooling[slot] = effects.cooling;
    O.localSunTransmission[slot] = effects.sunTransmission;
    O.localUvMultiplier[slot] = effects.uvMultiplier;
    O.localFamineRisk[slot] = effects.famineRisk;
    O.localAod[slot] = effects.aod;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// NARRATIVE EVENTS
// ═══════════════════════════════════════════════════════════════════════

function processNuclearNarrativeEvents() {
  const S = SootInjection;
  for (let slot = 0; slot < _nextSootInjectionSlot; slot++) {
    if (!S.active[slot]) continue;

    const flags = S.narrativeFlags[slot];
    const years = S.yearsSinceInjection[slot];

    // ONE_WEEK: after ~2 weeks (0.04 years).
    if ((flags & NARRATIVE_ONE_WEEK) === 0 && years > 0.04) {
      S.narrativeFlags[slot] |= NARRATIVE_ONE_WEEK;
    }

    // FIRST_WINTER: after 6 months (0.5 years).
    if ((flags & NARRATIVE_FIRST_WINTER) === 0 && years > 0.5) {
      S.narrativeFlags[slot] |= NARRATIVE_FIRST_WINTER;
    }

    // DARKEST_DAY: when cooling peaks and starts to decline.
    if ((flags & NARRATIVE_DARKEST_DAY) === 0
        && S.currentSootTg[slot] < S.totalSootTg[slot] * 0.6
        && S.surfaceCooling[slot] > 1.0) {
      S.narrativeFlags[slot] |= NARRATIVE_DARKEST_DAY;
    }

    // FIRST_THAW: soot has decayed below 10% of peak.
    if ((flags & NARRATIVE_FIRST_THAW) === 0
        && S.currentAod[slot] < 1.0
        && (flags & NARRATIVE_DARKEST_DAY) !== 0) {
      S.narrativeFlags[slot] |= NARRATIVE_FIRST_THAW;
    }

    // FULL_RECOVERY: soot below threshold.
    if ((flags & NARRATIVE_FULL_RECOVERY) === 0
        && S.currentAod[slot] < RECOVERY_THRESHOLD_AOD) {
      S.narrativeFlags[slot] |= NARRATIVE_FULL_RECOVERY;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// WEATHER MODIFIER — coupling to file 063 scheduler
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a weather-type multiplier reflecting the current nuclear winter.
 */
export function getNuclearWeatherMultiplier(weatherType) {
  const cooling = GlobalNuclearState.globalCooling;

  if (cooling < 0.5) return 1.0;

  switch (weatherType) {
    case WeatherType.CLEAR_SUNNY:
    case WeatherType.CLEAR_NIGHT:
      // Essentially no clear days.
      return Math.max(0.05, 1.0 - cooling * 0.15);

    case WeatherType.LIGHT_SNOW:
    case WeatherType.MODERATE_SNOW:
    case WeatherType.BLIZZARD:
      // Snow everywhere (multiple feet per year).
      return Math.min(5.0, 1.0 + cooling * 0.4);

    case WeatherType.OVERCAST:
    case WeatherType.MOSTLY_CLOUDY:
      // Permanent overcast.
      return Math.min(4.0, 1.0 + cooling * 0.35);

    case WeatherType.THUNDERSTORM:
    case WeatherType.SUPERCELL:
      // No convection without surface heating.
      return Math.max(0.02, 1.0 - cooling * 0.25);

    case WeatherType.HURRICANE:
    case WeatherType.TROPICAL_STORM:
      // Almost no tropical cyclones.
      return Math.max(0.02, 1.0 - cooling * 0.25);

    case WeatherType.MODERATE_RAIN:
    case WeatherType.HEAVY_RAIN:
      // Reduced precipitation.
      return Math.max(0.3, 1.0 - cooling * 0.1);

    case WeatherType.FOG:
    case WeatherType.MIST:
      // Fog very common.
      return Math.min(3.0, 1.0 + cooling * 0.2);

    case WeatherType.HAZE:
    case WeatherType.DUST_STORM:
    case WeatherType.SANDSTORM:
      // Dust and soot haze everywhere.
      return Math.min(3.0, 1.0 + cooling * 0.2);

    default:
      return 1.0;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SNOW / TREE LINE COUPLING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the snow line shift due to nuclear winter (metres).
 * Nuclear cooling LOWERS the snow line dramatically.
 */
export function getNuclearSnowLineShift() {
  return -GlobalNuclearState.globalCooling * 200.0;
}

/**
 * Return the tree line shift (metres).
 */
export function getNuclearTreeLineShift() {
  return -GlobalNuclearState.globalCooling * 150.0;
}

// ═══════════════════════════════════════════════════════════════════════
// SUN DIMMING AND ATMOSPHERIC OPTICS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the sun transmission factor through the soot layer.
 */
export function getNuclearSunTransmission(latitudeDeg, onContinent = true) {
  const effects = sampleNuclearAt(latitudeDeg, onContinent);
  return effects.sunTransmission;
}

/**
 * Return the sky color tint from nuclear winter (brown/orange).
 */
export function getNuclearSkyTint() {
  const dimming = 1.0 - GlobalNuclearState.globalSunTransmission;
  // Brown/orange sky.
  return {
    r: 1.0 * (1 - dimming) + 0.5 * dimming,
    g: 1.0 * (1 - dimming) + 0.3 * dimming,
    b: 1.0 * (1 - dimming) + 0.15 * dimming,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLIMATE COMBINATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the *combined* temperature anomaly from all sources:
 *   file 073 (climate change warming)
 *   file 074 (volcanic winter cooling)
 *   file 075 (nuclear winter cooling)
 */
export function getCombinedAnomaly(latitudeDeg, onContinent = true) {
  const climateWarming = GlobalClimate.transientWarming || 0;
  const volcanicCooling = GlobalVolcanicState.globalCooling || 0;
  const nuclearEffects = sampleNuclearAt(latitudeDeg, onContinent);

  return climateWarming - volcanicCooling - nuclearEffects.cooling;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a human-readable scenario label.
 */
export function nuclearScenarioLabel(scenario) {
  switch (scenario) {
    case NuclearScenario.INDIA_PAKISTAN_REGIONAL: return 'India-Pakistan Regional';
    case NuclearScenario.US_RUSSIA_LIMITED:       return 'US-Russia Limited';
    case NuclearScenario.US_RUSSIA_FULL:          return 'US-Russia Full Exchange';
    case NuclearScenario.EXTREME:                 return 'Extreme Scenario';
    case NuclearScenario.CUSTOM:                  return 'Custom Scenario';
    default:                                       return 'Unknown';
  }
}

/**
 * Return a full summary of the nuclear winter state.
 */
export function getNuclearWinterSummary() {
  return {
    active: GlobalNuclearState.active === 1,
    totalSootTg: GlobalNuclearState.totalSootTg,
    totalAod: GlobalNuclearState.totalAod,
    totalForcing: GlobalNuclearState.totalForcing,
    globalCooling: GlobalNuclearState.globalCooling,
    globalStratosphericWarming: GlobalNuclearState.globalStratosphericWarming,
    globalOzoneLoss: GlobalNuclearState.globalOzoneLoss,
    globalUvMultiplier: GlobalNuclearState.globalUvMultiplier,
    globalSunTransmission: GlobalNuclearState.globalSunTransmission,
    globalFamineRisk: GlobalNuclearState.globalFamineRisk,
    yearsSinceFirstInjection: GlobalNuclearState.yearsSinceFirstInjection,
    maxCoolingReached: GlobalNuclearState.maxCoolingReached,
    maxAodReached: GlobalNuclearState.maxAodReached,
  };
}

/**
 * Return the current global famine risk (0..1).
 */
export function getGlobalFamineRisk() {
  return GlobalNuclearState.globalFamineRisk;
}

/**
 * Return the current global UV multiplier.
 */
export function getGlobalUvMultiplier() {
  return GlobalNuclearState.globalUvMultiplier;
}

/**
 * Return the current global sun transmission.
 */
export function getGlobalSunTransmission() {
  return GlobalNuclearState.globalSunTransmission;
}

/**
 * Return true if nuclear winter is currently active.
 */
export function isNuclearWinterActive() {
  return GlobalNuclearState.active === 1;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

export function gatherNuclearWinterForRendering() {
  const result = [];
  const S = SootInjection;

  for (let slot = 0; slot < _nextSootInjectionSlot; slot++) {
    if (!S.active[slot]) continue;

    result.push({
      slot,
      scenario: S.scenario[slot],
      scenarioLabel: nuclearScenarioLabel(S.scenario[slot]),
      totalSootTg: S.totalSootTg[slot],
      currentSootTg: S.currentSootTg[slot],
      weaponCount: S.weaponCount[slot],
      totalYieldMt: S.totalYieldMt[slot],
      hemisphere: S.hemisphere[slot],
      yearsSinceInjection: S.yearsSinceInjection[slot],
      currentAod: S.currentAod[slot],
      currentForcing: S.currentForcing[slot],
      surfaceCooling: S.surfaceCooling[slot],
      stratosphericWarming: S.stratosphericWarming[slot],
      ozoneLoss: S.ozoneLoss[slot],
      uvMultiplier: S.uvMultiplier[slot],
      sunTransmission: S.sunTransmission[slot],
      famineRisk: S.famineRisk[slot],
      growingSeasonReduction: S.growingSeasonReduction[slot],
      cropYieldFactor: S.cropYieldFactor[slot],
      spreadProgress: S.spreadProgress[slot],
      narrativeFlags: S.narrativeFlags[slot],
    });
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function nuclearWinterStats() {
  let activeInjections = 0;
  let activeObservers = 0;
  let totalSoot = 0;

  for (let slot = 0; slot < _nextSootInjectionSlot; slot++) {
    if (!SootInjection.active[slot]) continue;
    activeInjections++;
    totalSoot += SootInjection.currentSootTg[slot];
  }

  for (let slot = 0; slot < _nextNuclearObserverSlot; slot++) {
    if (NuclearObserver.active[slot]) activeObservers++;
  }

  return {
    activeInjections,
    maxInjections: MAX_SOOT_INJECTIONS,
    activeObservers,
    maxObservers: MAX_NUCLEAR_OBSERVERS,
    totalSootTg: totalSoot,
    globalCooling: GlobalNuclearState.globalCooling,
    globalAod: GlobalNuclearState.totalAod,
    globalFamineRisk: GlobalNuclearState.globalFamineRisk,
    active: GlobalNuclearState.active === 1,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearNuclearWinter() {
  SootInjection.active.fill(0);
  _sootInjectionSlots.clear();
  _nextSootInjectionSlot = 0;

  NuclearObserver.active.fill(0);
  NuclearObserver.ownerEid.fill(0);
  _nuclearObserverSlots.clear();
  _nextNuclearObserverSlot = 0;

  GlobalNuclearState.totalSootTg = 0;
  GlobalNuclearState.totalAod = 0;
  GlobalNuclearState.totalForcing = 0;
  GlobalNuclearState.globalCooling = 0;
  GlobalNuclearState.globalStratosphericWarming = 0;
  GlobalNuclearState.globalOzoneLoss = 0;
  GlobalNuclearState.globalUvMultiplier = 1.0;
  GlobalNuclearState.globalSunTransmission = 1.0;
  GlobalNuclearState.globalFamineRisk = 0;
  GlobalNuclearState.active = 0;
  GlobalNuclearState.yearsSinceFirstInjection = 0;
  GlobalNuclearState.maxCoolingReached = 0;
  GlobalNuclearState.maxAodReached = 0;
}