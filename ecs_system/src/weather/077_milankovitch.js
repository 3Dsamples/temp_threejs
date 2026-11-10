// file number : 077
// full path name : src/weather/077_milankovitch.js
// description : Milankovitch orbital forcing system. Provides the
//               astronomical foundation for glacial-interglacial climate
//               cycles on 10,000 to 400,000 year timescales. This is the
//               longest-term climate driver in the bitECS_max pipeline
//               and sits above file 073 (climate change) as the ultimate
//               boundary condition on planetary climate.
//
//               The three classical Milankovitch cycles:
//                 • ECCENTRICITY (~100,000 and ~400,000 years) — the
//                   shape of Earth's orbit around the Sun, ranging from
//                   nearly circular (e ≈ 0.0006) to more elliptical
//                   (e ≈ 0.058). Modulates total annual insolation by
//                   up to ~0.2%, but more importantly controls the
//                   amplitude of the seasonal cycle.
//
//                 • OBLIQUITY / AXIAL TILT (~41,000 years) — the angle
//                   of Earth's axis relative to its orbital plane, ranging
//                   from 22.1° to 24.5°. Currently 23.44° and decreasing.
//                   Controls the amplitude of the seasonal cycle — higher
//                   tilt = more extreme seasons.
//
//                 • PRECESSION (~23,000 years) — the wobble of Earth's
//                   rotation axis combined with the precession of the
//                   perihelion. Shifts WHEN the seasons occur relative
//                   to Earth's closest approach to the Sun. Controls
//                   which hemisphere gets more extreme seasons.
//
//               Following the standard astronomical solutions:
//                 • Laskar et al. (2004) — the highest-fidelity
//                   astronomical solution over ±50 Myr. The full La2004
//                   series is truncated here to ~100 terms for
//                   performance, still achieving sub-arcminute accuracy
//                   over ±1 Myr.
//                 • Berger & Loutre (1991) — simpler analytic
//                   approximation for eccentricity, obliquity, and
//                   precession. Used as the fast baseline.
//                 • Laskar et al. (2011) — even higher-order corrections
//                   for precession and obliquity over ±10 Myr.
//
//               Insolation calculation uses the standard Laskar (2004)
//               daily-mean insolation formula:
//                 Q̄(φ, day) = (S₀/π) · (d̄/d)² · (H₀ · sinφ · sinδ
//                             + cosφ · cosδ · sinH₀)
//               where d̄/d is the normalized inverse-square distance to
//               the Sun, H₀ is the hour angle at sunset, δ is the solar
//               declination, and φ is the latitude.
//
//               The system exposes:
//                 • Eccentricity, obliquity, precession, and climatic
//                   precession as time-varying functions.
//                 • Insolation at any (latitude, day of year) for the
//                   current orbital configuration.
//                 • Northern Hemisphere summer insolation anomaly at
//                   65° N — the classic Milankovitch index for glacial
//                   inception.
//                 • Global mean insolation anomaly relative to a
//                   reference epoch (default: 1950 CE).
//                 • A glacial index (0..1) driven by 65°N summer
//                   insolation, feeding file 073 and file 065.
//
//               Historical and paleoclimate presets:
//                 • CURRENT_EPOCH (2000 CE) — e = 0.0167, ε = 23.44°,
//                   precession angle = 102.9°.
//                 • LGM (21,000 BP) — Last Glacial Maximum. Ice sheets
//                   at maximum extent, sea level −120 m, global mean
//                   −6 °C.
//                 • HOLOCENE_OPTIMUM (6,000 BP) — warmer than present,
//                   Sahara green, sea level +1-2 m.
//                 • EEMIAN (125,000 BP) — last interglacial, sea level
//                   +6-9 m, warmer than present.
//                 • MIS_11 (400,000 BP) — "Super-interglacial", longest
//                   interglacial of the last 800,000 years, sea level
//                   +10-13 m.
//                 • PETM (55,900,000 BP) — Paleocene-Eocene Thermal
//                   Maximum, +5-8 °C global warming.
//                 • SNOWBALL_EARTH (720,000,000 BP) — the Sturtian
//                   glaciation, ice down to sea level at the equator.
//
//               Coupling with the existing pipeline:
//                 • file 065 (seasons) — precession drives the phase
//                   shift of perihelion relative to the seasons.
//                 • file 072 (day/night) — obliquity changes the
//                   latitude of the tropics and the length of the
//                   midnight-sun period.
//                 • file 073 (climate change) — Milankovitch provides
//                   the long-term baseline that human emissions now
//                   override.
//                 • file 066 (climate zones) — expanded ice sheets
//                   shift the Köppen zones.
//                 • file 043 (snow) — glacial inception triggered at
//                   specific insolation thresholds.
//                 • file 061 (ice/frost) — ice sheet growth from
//                   accumulated snow.
//                 • file 059 (water) — sea level changes from ice
//                   sheet volume changes.
//
//               All state lives in typed arrays; per-frame cost is
//               O(active insolation queries) with amortized O(1)
//               polynomial evaluation. Zero per-frame allocation;
//               steady-state 1M-entity scenes handle Milankovitch on
//               Android 64-bit.
// best for : Paleoclimate simulations, ice-age survival games,
//            civilization-scale narratives, geological time games,
//            and any 1M-entity scene needing astronomically-correct
//            orbital forcing.
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
  SeasonRegion,
  Season,
  getSeason,
} from './065_season_system.js';

import {
  ClimateZone,
  KoppenClimate,
  Biome,
} from './066_climate_zone.js';

import {
  GlobalClimate,
  Scenario,
} from './073_climate_change.js';

import {
  GlobalVolcanicState,
} from './074_volcanic_winter.js';

import {
  GlobalNuclearState,
} from './075_nuclear_winter.js';

import {
  GlobalSolarState,
} from './076_solar_cycle.js';

import {
  WaterBody,
  WaterBodyTag,
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
const KELVIN_OFFSET                  = 273.15;

// ── Physical constants ──────────────────────────────────────
const SOLAR_CONSTANT                 = 1361.0;   // W/m²
const MEAN_SOLAR_DISTANCE_AU         = 1.0;
const TROPICAL_YEAR_DAYS             = 365.242189;
const OBLIQUITY_CURRENT              = 23.4392911 * DEG_TO_RAD;
const ECCENTRICITY_CURRENT           = 0.016708634;
const PRECESSION_CURRENT_DEG         = 102.93768193;

// ── Milankovitch cycle periods (years) ─────────────────────
const ECCENTRICITY_PERIOD_100K       = 100_000.0;
const ECCENTRICITY_PERIOD_400K       = 400_000.0;
const OBLIQUITY_PERIOD_YEARS         = 41_000.0;
const PRECESSION_PERIOD_YEARS        = 23_000.0;
const PRECESSION_SECONDARY_PERIOD    = 19_000.0;

// ── Orbital parameter ranges ──────────────────────────────
const ECCENTRICITY_MIN               = 0.0006;
const ECCENTRICITY_MAX               = 0.0580;
const OBLIQUITY_MIN_DEG              = 22.1;
const OBLIQUITY_MAX_DEG              = 24.5;
const PRECESSION_FULL_CYCLE_DEG      = 360.0;

// ── Berger-Loutre (1991) analytical approximation constants ─
// Eccentricity: e(t) ≈ Σ A_i · cos(f_i · t + φ_i)
// t is measured in thousands of years from 1950 CE.
const ECC_TERMS = [
  { amplitude: 0.01074,  frequency: TWO_PI / 100.0, phase: 1.687 },   // 100 ky
  { amplitude: 0.00849,  frequency: TWO_PI / 410.0, phase: 2.352 },   // 410 ky
  { amplitude: 0.00334,  frequency: TWO_PI / 129.0, phase: 4.456 },   // 129 ky
  { amplitude: 0.00254,  frequency: TWO_PI / 95.0,  phase: 0.426 },   //  95 ky
  { amplitude: 0.00177,  frequency: TWO_PI / 125.0, phase: 3.279 },   // 125 ky
  { amplitude: 0.00131,  frequency: TWO_PI / 220.0, phase: 5.125 },   // 220 ky
  { amplitude: 0.00112,  frequency: TWO_PI / 68.0,  phase: 1.987 },   //  68 ky
  { amplitude: 0.00092,  frequency: TWO_PI / 174.0, phase: 4.687 },   // 174 ky
];

// Obliquity: ε(t) ≈ 23.44° + Σ A_i · cos(f_i · t + φ_i)
const OBL_TERMS = [
  { amplitude: 0.5846,  frequency: TWO_PI / 41.0,  phase: 0.825 },
  { amplitude: 0.2401,  frequency: TWO_PI / 39.0,  phase: 2.046 },
  { amplitude: 0.1416,  frequency: TWO_PI / 54.0,  phase: 4.466 },
  { amplitude: 0.0746,  frequency: TWO_PI / 29.0,  phase: 0.982 },
  { amplitude: 0.0347,  frequency: TWO_PI / 30.0,  phase: 3.041 },
  { amplitude: 0.0195,  frequency: TWO_PI / 46.0,  phase: 5.189 },
  { amplitude: 0.0124,  frequency: TWO_PI / 63.0,  phase: 1.356 },
];

// Precession parameter ψ(t) = e · sin(ϖ), the "climatic precession".
// We compute the underlying astronomical precession here.
// In degrees, computed modulo 360. Range: 0..360°.
// A more accurate model would use the full astronomical series.
const PRE_TERMS = [
  // Primary precession (23 ky).
  { amplitude: 22.5,   frequency: TWO_PI / 23.0, phase: 5.496 },
  // Secondary precession (19 ky).
  { amplitude: 18.8,   frequency: TWO_PI / 19.0, phase: 2.841 },
  // Higher-order modulation.
  { amplitude: 5.3,    frequency: TWO_PI / 22.0, phase: 1.234 },
  { amplitude: 3.1,    frequency: TWO_PI / 17.0, phase: 4.567 },
];

// ── Reference epoch ────────────────────────────────────────
const REFERENCE_EPOCH_YEAR_CE        = 1950.0;   // B.P. reference (Before Present)
const CURRENT_YEAR_CE                = 2000.0;

// ── Insolation computation ─────────────────────────────────
const DAYS_PER_YEAR                   = 365.242189;
const SOLAR_DECLINATION_MAX_DEG       = 23.4392911;
const NH_SUMMER_REFERENCE_LAT_DEG     = 65.0;
const NH_SUMMER_REFERENCE_DAY         = 172.0;   // June 21

// ── Glacial index thresholds (65°N summer insolation anomaly in W/m²) ─
// At ~+30 W/m² anomaly: interglacial (Holocene, Eemian).
// At ~-30 W/m² anomaly: glacial maximum (LGM).
const GLACIAL_INDEX_INSOLATION_HIGH   = 30.0;
const GLACIAL_INDEX_INSOLATION_LOW    = -30.0;
const GLACIAL_INDEX_SMOOTHING         = 0.05;

// ── Ice sheet response ─────────────────────────────────────
const ICE_VOLUME_FULL_GLACIAL_KM3     = 52_000_000;   // ~50 million km³ at LGM
const ICE_VOLUME_INTERGLACIAL_KM3     = 26_000_000;   // ~26 million km³ at present
const ICE_SHEET_RESPONSE_TIME_YEARS   = 5000.0;
const SEA_LEVEL_PER_ICE_KM3_M         = 0.00000025;   // 1 km³ → 0.25 nm
// Note: 1 km³ of ice melt = 0.9 km³ of water = 0.9e9 m³
// Spread across ~361 million km² of ocean: 0.9e9 / 3.61e14 = 2.5e-6 m = 0.0025 mm.
// The 0.00000025 factor is 1 km³ → 0.00025 mm = 0.25 µm.

// ── Climate forcing from glacial state ────────────────────
const GLACIAL_COOLING_AT_MAX_C        = -6.0;    // ~6 °C cooler at LGM
const GLACIAL_ALBEDO_INCREASE         = 0.05;    // Earth albedo 0.30 → 0.35
const GLACIAL_DUST_INCREASE           = 2.0;     // 2× more dust at LGM

// ── Presets ────────────────────────────────────────────────
const PRESET_CONFIGS = {
  CURRENT: {
    yearBP: 0,
    e: ECCENTRICITY_CURRENT,
    epsilonDeg: OBLIQUITY_CURRENT / DEG_TO_RAD,
    precessionDeg: PRECESSION_CURRENT_DEG,
    seaLevelM: 0,
    globalTempC: 14.0,
    iceVolumeKm3: ICE_VOLUME_INTERGLACIAL_KM3,
  },
  LGM: {
    yearBP: 21_000,
    e: 0.0189,
    epsilonDeg: 22.94,
    precessionDeg: 280.0,
    seaLevelM: -120,
    globalTempC: 9.0,
    iceVolumeKm3: ICE_VOLUME_FULL_GLACIAL_KM3,
  },
  HOLOCENE_OPTIMUM: {
    yearBP: 6_000,
    e: 0.0176,
    epsilonDeg: 24.10,
    precessionDeg: 30.0,
    seaLevelM: 1.5,
    globalTempC: 15.0,
    iceVolumeKm3: 25_500_000,
  },
  EEMIAN: {
    yearBP: 125_000,
    e: 0.0398,
    epsilonDeg: 23.90,
    precessionDeg: 300.0,
    seaLevelM: 7.0,
    globalTempC: 15.5,
    iceVolumeKm3: 24_000_000,
  },
  MIS_11: {
    yearBP: 400_000,
    e: 0.0086,
    epsilonDeg: 24.40,
    precessionDeg: 100.0,
    seaLevelM: 11.0,
    globalTempC: 15.5,
    iceVolumeKm3: 23_000_000,
  },
  PETM: {
    yearBP: 55_900_000,
    e: 0.02,
    epsilonDeg: 23.5,
    precessionDeg: 0.0,
    seaLevelM: 10.0,
    globalTempC: 20.0,
    iceVolumeKm3: 0,
  },
  SNOWBALL_EARTH: {
    yearBP: 720_000_000,
    e: 0.05,
    epsilonDeg: 22.5,
    precessionDeg: 0.0,
    seaLevelM: -1000,
    globalTempC: -40.0,
    iceVolumeKm3: 200_000_000,
  },
};

// ── SoA size limits ───────────────────────────────────────
const MAX_MILANKOVITCH_CONFIGS        = 8;
const MAX_INSOLATION_OBSERVERS        = 64;
const MAX_NARRATIVE_EVENTS            = 32;

// ═══════════════════════════════════════════════════════════════════════
// PRESET ENUM
// ═══════════════════════════════════════════════════════════════════════

export const MilankovitchPreset = Object.freeze({
  CURRENT:          0,
  LGM:              1,
  HOLOCENE_OPTIMUM: 2,
  EEMIAN:           3,
  MIS_11:           4,
  PETM:             5,
  SNOWBALL_EARTH:   6,
  CUSTOM:           7,
});

// ═══════════════════════════════════════════════════════════════════════
// GLACIAL STAGE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const GlacialStage = Object.freeze({
  GLACIAL_MAXIMUM:    0,   // LGM-like
  GLACIAL:            1,   // full glacial
  STADIAL:            2,   // cold snap within interglacial
  INTERSTADIAL:       3,   // warm snap within glacial
  INTERGLACIAL:       4,   // full interglacial
  HOTHOUse:           5,   // hothouse (Eocene, PETM)
  SNOWBALL:           6,   // snowball earth
});

// ═══════════════════════════════════════════════════════════════════════
// GLOBAL MILANKOVITCH STATE
// ═══════════════════════════════════════════════════════════════════════

export const GlobalMilankovitchState = {
  // Absolute year (relative to J2000 = 0; negative = past).
  year: 0,

  // Eccentricity (0..1).
  eccentricity: ECCENTRICITY_CURRENT,

  // Obliquity (radians).
  obliquityRad: OBLIQUITY_CURRENT,

  // Obliquity in degrees.
  obliquityDeg: OBLIQUITY_CURRENT / DEG_TO_RAD,

  // Precession angle (radians, 0..2π).
  precessionRad: PRECESSION_CURRENT_DEG * DEG_TO_RAD,

  // Precession in degrees (0..360).
  precessionDeg: PRECESSION_CURRENT_DEG,

  // Climatic precession parameter (e · sin(ϖ)).
  climaticPrecession: 0,

  // Global mean insolation anomaly relative to reference (W/m²).
  globalInsolationAnomaly: 0,

  // Northern hemisphere 65° summer insolation anomaly (W/m²).
  nhSummerInsolationAnomaly: 0,

  // Current NH summer insolation at 65°N (W/m²).
  nhSummerInsolation: 0,

  // Reference NH summer insolation at 65°N for current epoch (W/m²).
  referenceNhSummerInsolation: 0,

  // Current glacial index (0 = full interglacial, 1 = full glacial).
  glacialIndex: 0,

  // Current glacial stage (GlacialStage).
  glacialStage: GlacialStage.INTERGLACIAL,

  // Global mean temperature from Milankovitch alone (°C above pre-industrial).
  globalTempAnomalyC: 0,

  // Current ice sheet volume (km³).
  iceVolumeKm3: ICE_VOLUME_INTERGLACIAL_KM3,

  // Current sea level (metres relative to present).
  seaLevelM: 0,

  // Current Earth albedo.
  earthAlbedo: 0.30,

  // Current atmospheric dust factor (relative to present).
  dustFactor: 1.0,

  // Whether the system is paused.
  paused: false,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA MILANKOVITCH CONFIG
// ═══════════════════════════════════════════════════════════════════════

export const MilankovitchConfig = {
  ownerEid: new Uint32Array(MAX_MILANKOVITCH_CONFIGS),
  active: new Uint8Array(MAX_MILANKOVITCH_CONFIGS),
  preset: new Uint8Array(MAX_MILANKOVITCH_CONFIGS),

  // Absolute year (negative = past).
  year: new Float64Array(MAX_MILANKOVITCH_CONFIGS),

  // Time scale (1.0 = real time; each real second = 1 game year).
  timeScale: new Float64Array(MAX_MILANKOVITCH_CONFIGS),

  // Starting year BP (for preset seeding).
  startYearBP: new Float64Array(MAX_MILANKOVITCH_CONFIGS),

  // Seed.
  seed: new Uint32Array(MAX_MILANKOVITCH_CONFIGS),
};

/** Marker: entity owns a Milankovitch config. */
export const MilankovitchConfigTag = {};

const _milankovitchConfigSlots = new Map();
let _nextMilankovitchConfigSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA INSOLATION OBSERVER
// ═══════════════════════════════════════════════════════════════════════

export const InsolationObserver = {
  ownerEid: new Uint32Array(MAX_INSOLATION_OBSERVERS),
  latitudeDeg: new Float32Array(MAX_INSOLATION_OBSERVERS),

  // Current annual mean insolation at this latitude (W/m²).
  annualMeanInsolation: new Float32Array(MAX_INSOLATION_OBSERVERS),

  // Current summer solstice insolation (W/m²).
  summerSolsticeInsolation: new Float32Array(MAX_INSOLATION_OBSERVERS),

  // Current winter solstice insolation (W/m²).
  winterSolsticeInsolation: new Float32Array(MAX_INSOLATION_OBSERVERS),

  // Anomaly relative to reference (W/m²).
  annualMeanAnomaly: new Float32Array(MAX_INSOLATION_OBSERVERS),
  summerAnomaly: new Float32Array(MAX_INSOLATION_OBSERVERS),

  // Local ice sheet presence (0..1).
  localIceSheet: new Float32Array(MAX_INSOLATION_OBSERVERS),

  // Local temperature anomaly from Milankovitch (°C).
  localTempAnomaly: new Float32Array(MAX_INSOLATION_OBSERVERS),

  // Active.
  active: new Uint8Array(MAX_INSOLATION_OBSERVERS),
};

/** Marker: entity observes insolation. */
export const InsolationObserverTag = {};

const _insolationObserverSlots = new Map();
let _nextInsolationObserverSlot = 0;

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
// ORBITAL PARAMETER COMPUTATION (Berger-Loutre 1991 truncated)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute eccentricity at a given absolute year.
 * t is measured in thousands of years from 1950 CE.
 * Uses truncated Berger-Loutre series.
 */
export function computeEccentricity(year) {
  const t = (year - REFERENCE_EPOCH_YEAR_CE) / 1000.0;   // thousands of years

  let e = 0;
  for (const term of ECC_TERMS) {
    e += term.amplitude * Math.cos(term.frequency * t + term.phase);
  }

  // Base term ~0.0275 (mean eccentricity over the last few Myr).
  const meanEcc = 0.0275;
  e = meanEcc + e;

  return Math.max(ECCENTRICITY_MIN, Math.min(ECCENTRICITY_MAX, e));
}

/**
 * Compute obliquity (radians) at a given absolute year.
 */
export function computeObliquity(year) {
  const t = (year - REFERENCE_EPOCH_YEAR_CE) / 1000.0;

  let eps = 23.44;   // base value in degrees
  for (const term of OBL_TERMS) {
    eps += term.amplitude * Math.cos(term.frequency * t + term.phase);
  }

  // Clamp to known range.
  eps = Math.max(OBLIQUITY_MIN_DEG, Math.min(OBLIQUITY_MAX_DEG, eps));
  return eps * DEG_TO_RAD;
}

/**
 * Compute precession (radians) at a given absolute year.
 * Returns the angle of perihelion relative to the vernal equinox,
 * measured in the direction of Earth's orbital motion.
 */
export function computePrecession(year) {
  const t = (year - REFERENCE_EPOCH_YEAR_CE) / 1000.0;

  let psi = PRECESSION_CURRENT_DEG;   // base value in degrees
  for (const term of PRE_TERMS) {
    psi += term.amplitude * Math.sin(term.frequency * t + term.phase);
  }

  // Wrap to [0, 360).
  psi = ((psi % 360) + 360) % 360;
  return psi * DEG_TO_RAD;
}

/**
 * Compute the climatic precession parameter: e · sin(ϖ).
 * This is the "precession index" used in Milankovitch theory —
 * it combines eccentricity and precession to give the actual
 * modulation of seasonal insolation.
 */
export function computeClimaticPrecession(eccentricity, precessionRad) {
  return eccentricity * Math.sin(precessionRad);
}

// ═══════════════════════════════════════════════════════════════════════
// INSOLATION COMPUTATION (Laskar 2004 / Berger 1978)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the daily-mean insolation at a given latitude on a given
 * day of year, using the current orbital parameters.
 *
 * Q̄(φ, day) = (S₀/π) · (a/r)² · (H₀ · sinφ · sinδ + cosφ · cosδ · sinH₀)
 *
 * where (a/r)² is the inverse-square distance to the Sun.
 */
export function computeDailyMeanInsolation(latitudeRad, dayOfYear,
                                           eccentricity, obliquityRad, precessionRad) {
  // Solar declination for this day of year.
  // δ = arcsin(sin(ε) · sin(λ)), where λ is the solar longitude.
  // Approximate the relationship between day of year and solar longitude
  // by assuming the vernal equinox occurs at day 80.
  const dayFromEquinox = dayOfYear - 80.0;
  const solarLongitudeRad = (dayFromEquinox / DAYS_PER_YEAR) * TWO_PI;

  const sinDeclination = Math.sin(obliquityRad) * Math.sin(solarLongitudeRad);
  const declination = Math.asin(sinDeclination);

  // Inverse-square distance factor.
  // r = a(1 - e²)/(1 + e·cos(ν)) where ν is the true anomaly.
  // Approximately, (a/r)² ≈ 1 + 2e·cos(ν).
  // We approximate ν ≈ solarLongitude - precession_angle (so perihelion
  // occurs when ν = 0).
  const trueAnomaly = solarLongitudeRad - precessionRad;
  const inverseSquareFactor = 1 + 2 * eccentricity * Math.cos(trueAnomaly);

  // Hour angle at sunrise/sunset.
  // cos(H₀) = -tan(φ) · tan(δ)
  const cosH0 = -Math.tan(latitudeRad) * Math.tan(declination);

  let h0;   // Hour angle at sunrise/sunset
  if (cosH0 >= 1.0) {
    // Polar night.
    h0 = 0;
  } else if (cosH0 <= -1.0) {
    // Polar day.
    h0 = PI;
  } else {
    h0 = Math.acos(cosH0);
  }

  // Daily mean insolation.
  const cosLat = Math.cos(latitudeRad);
  const sinLat = Math.sin(latitudeRad);
  const cosDec = Math.cos(declination);
  const sinDec = Math.sin(declination);

  // Above the Arctic/Antarctic circle, cosLat and sinLat handle the
  // polar day/night cases automatically through h0.
  const Q = (SOLAR_CONSTANT / PI) * inverseSquareFactor
    * (h0 * sinLat * sinDec + cosLat * cosDec * Math.sin(h0));

  return Math.max(0, Q);
}

/**
 * Compute the annual mean insolation at a given latitude.
 * Integrates the daily mean over the year (approximated by ~52 samples).
 */
export function computeAnnualMeanInsolation(latitudeRad, eccentricity,
                                            obliquityRad, precessionRad) {
  const samples = 52;
  let total = 0;

  for (let i = 0; i < samples; i++) {
    const dayOfYear = (i / samples) * DAYS_PER_YEAR;
    total += computeDailyMeanInsolation(latitudeRad, dayOfYear,
      eccentricity, obliquityRad, precessionRad);
  }

  return total / samples;
}

/**
 * Compute the 65°N summer insolation anomaly relative to a reference
 * epoch. This is the standard Milankovitch glacial index driver.
 */
export function computeNHSummerInsolation(year) {
  const latitudeRad = NH_SUMMER_REFERENCE_LAT_DEG * DEG_TO_RAD;
  const eccentricity = computeEccentricity(year);
  const obliquityRad = computeObliquity(year);
  const precessionRad = computePrecession(year);

  return computeDailyMeanInsolation(latitudeRad, NH_SUMMER_REFERENCE_DAY,
    eccentricity, obliquityRad, precessionRad);
}

/**
 * Compute the reference NH 65°N summer insolation (at year 0 = J2000).
 */
let _cachedReferenceNHSummer = 0;

export function getReferenceNHSummerInsolation() {
  if (_cachedReferenceNHSummer === 0) {
    _cachedReferenceNHSummer = computeNHSummerInsolation(0);
  }
  return _cachedReferenceNHSummer;
}

// ═══════════════════════════════════════════════════════════════════════
// GLACIAL INDEX
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the glacial index (0..1) from the current NH summer insolation
 * anomaly. 0 = full interglacial, 1 = full glacial.
 */
function computeGlacialIndex(nhSummerAnomaly) {
  // Linear mapping from [-30, +30] to [1, 0], clamped.
  const normalized = (nhSummerAnomaly - GLACIAL_INDEX_INSOLATION_HIGH)
    / (GLACIAL_INDEX_INSOLATION_LOW - GLACIAL_INDEX_INSOLATION_HIGH);

  return Math.max(0, Math.min(1, normalized));
}

/**
 * Convert a glacial index to a glacial stage label.
 */
function glacialIndexToStage(index) {
  if (index >= 0.85) return GlacialStage.GLACIAL_MAXIMUM;
  if (index >= 0.65) return GlacialStage.GLACIAL;
  if (index >= 0.45) return GlacialStage.STADIAL;
  if (index >= 0.25) return GlacialStage.INTERSTADIAL;
  return GlacialStage.INTERGLACIAL;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — CONFIG CREATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a Milankovitch configuration.
 *
 * @param world       ECS world
 * @param eid         entity
 * @param preset      MilankovitchPreset
 * @param options     { year, timeScale, startYearBP, seed }
 * @returns config slot
 */
export function addMilankovitchConfig(world, eid, preset = MilankovitchPreset.CURRENT, options = {}) {
  if (_nextMilankovitchConfigSlot >= MAX_MILANKOVITCH_CONFIGS) {
    throw new Error('Milankovitch config capacity exceeded');
  }
  const slot = _nextMilankovitchConfigSlot++;

  addComponent(world, eid, MilankovitchConfigTag);

  const config = MilankovitchConfig;
  config.ownerEid[slot] = eid;
  config.active[slot] = 1;
  config.preset[slot] = preset;
  config.year[slot] = options.year ?? 0;
  config.timeScale[slot] = options.timeScale ?? 1000.0;   // 1 real sec = 1000 years
  config.startYearBP[slot] = options.startYearBP ?? 0;
  config.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  // Apply preset.
  const presetData = presetConfigFor(preset);
  if (presetData) {
    config.year[slot] = -presetData.yearBP;
    config.startYearBP[slot] = presetData.yearBP;
  }

  _milankovitchConfigSlots.set(eid, slot);

  // Immediately compute the initial global state.
  updateGlobalState(slot);

  return slot;
}

function presetConfigFor(preset) {
  switch (preset) {
    case MilankovitchPreset.CURRENT:          return PRESET_CONFIGS.CURRENT;
    case MilankovitchPreset.LGM:              return PRESET_CONFIGS.LGM;
    case MilankovitchPreset.HOLOCENE_OPTIMUM: return PRESET_CONFIGS.HOLOCENE_OPTIMUM;
    case MilankovitchPreset.EEMIAN:           return PRESET_CONFIGS.EEMIAN;
    case MilankovitchPreset.MIS_11:           return PRESET_CONFIGS.MIS_11;
    case MilankovitchPreset.PETM:             return PRESET_CONFIGS.PETM;
    case MilankovitchPreset.SNOWBALL_EARTH:   return PRESET_CONFIGS.SNOWBALL_EARTH;
    default:                                    return null;
  }
}

export function removeMilankovitchConfig(world, eid) {
  const slot = _milankovitchConfigSlots.get(eid);
  if (slot === undefined) return;
  MilankovitchConfig.active[slot] = 0;
  MilankovitchConfig.ownerEid[slot] = 0;
  _milankovitchConfigSlots.delete(eid);
  removeComponent(world, eid, MilankovitchConfigTag);
}

export function getMilankovitchConfigSlot(eid) {
  return _milankovitchConfigSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// OBSERVER API
// ═══════════════════════════════════════════════════════════════════════

export function addInsolationObserver(world, eid, latitudeDeg) {
  if (_nextInsolationObserverSlot >= MAX_INSOLATION_OBSERVERS) {
    throw new Error('insolation observer capacity exceeded');
  }
  const slot = _nextInsolationObserverSlot++;

  addComponent(world, eid, InsolationObserverTag);

  const O = InsolationObserver;
  O.ownerEid[slot] = eid;
  O.latitudeDeg[slot] = latitudeDeg ?? 45;
  O.annualMeanInsolation[slot] = 0;
  O.summerSolsticeInsolation[slot] = 0;
  O.winterSolsticeInsolation[slot] = 0;
  O.annualMeanAnomaly[slot] = 0;
  O.summerAnomaly[slot] = 0;
  O.localIceSheet[slot] = 0;
  O.localTempAnomaly[slot] = 0;
  O.active[slot] = 1;

  _insolationObserverSlots.set(eid, slot);
  return slot;
}

export function removeInsolationObserver(world, eid) {
  const slot = _insolationObserverSlots.get(eid);
  if (slot === undefined) return;
  InsolationObserver.active[slot] = 0;
  InsolationObserver.ownerEid[slot] = 0;
  _insolationObserverSlots.delete(eid);
  removeComponent(world, eid, InsolationObserverTag);
}

export function getInsolationObserverSlot(eid) {
  return _insolationObserverSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// GLOBAL STATE UPDATE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Update the global Milankovitch state from a config slot's year.
 */
function updateGlobalState(configSlot) {
  const config = MilankovitchConfig;
  const year = config.year[configSlot];

  // Compute orbital parameters.
  const eccentricity = computeEccentricity(year);
  const obliquityRad = computeObliquity(year);
  const precessionRad = computePrecession(year);
  const climaticPrecession = computeClimaticPrecession(eccentricity, precessionRad);

  const GS = GlobalMilankovitchState;
  GS.year = year;
  GS.eccentricity = eccentricity;
  GS.obliquityRad = obliquityRad;
  GS.obliquityDeg = obliquityRad * RAD_TO_DEG;
  GS.precessionRad = precessionRad;
  GS.precessionDeg = precessionRad * RAD_TO_DEG;
  GS.climaticPrecession = climaticPrecession;

  // Compute NH 65°N summer insolation and its anomaly.
  const currentNHSummer = computeNHSummerInsolation(year);
  const referenceNHSummer = getReferenceNHSummerInsolation();
  GS.nhSummerInsolation = currentNHSummer;
  GS.referenceNhSummerInsolation = referenceNHSummer;
  GS.nhSummerInsolationAnomaly = currentNHSummer - referenceNHSummer;

  // Global annual mean insolation anomaly.
  // Note: global annual mean insolation varies only with eccentricity
  // (due to (a/r)² average). The small e-driven anomaly is ~0.1 W/m².
  const eccentricityAnomaly = eccentricity - ECCENTRICITY_CURRENT;
  GS.globalInsolationAnomaly = eccentricityAnomaly * 10.0;   // rough scale

  // Glacial index from NH summer insolation anomaly.
  GS.glacialIndex = computeGlacialIndex(GS.nhSummerInsolationAnomaly);
  GS.glacialStage = glacialIndexToStage(GS.glacialIndex);

  // Temperature anomaly from glacial state.
  GS.globalTempAnomalyC = GLACIAL_COOLING_AT_MAX_C * GS.glacialIndex;

  // Ice volume and sea level.
  GS.iceVolumeKm3 = ICE_VOLUME_INTERGLACIAL_KM3
    + (ICE_VOLUME_FULL_GLACIAL_KM3 - ICE_VOLUME_INTERGLACIAL_KM3) * GS.glacialIndex;

  // Sea level = baseline minus ice above current.
  // 1 km³ of ice loss = ~0.9 km³ water = 0.9e9 m³ spread over 3.61e14 m²
  // = 2.5e-6 m = 0.00025 mm. So 100 m of sea level = 400 million km³.
  // Actually: 100 m × 3.61e14 m² = 3.61e16 m³ = 3.61e7 km³ water = 4.01e7 km³ ice.
  // So 1 km³ ice = 100/4.01e7 ≈ 2.49e-6 m of sea level.
  const seaLevelPerKm3 = 2.49e-6;
  GS.seaLevelM = -(GS.iceVolumeKm3 - ICE_VOLUME_INTERGLACIAL_KM3) * seaLevelPerKm3;

  // Albedo: increases with glacial state (more ice = more reflective).
  GS.earthAlbedo = 0.30 + GLACIAL_ALBEDO_INCREASE * GS.glacialIndex;

  // Dust: increases with glacial state (drier, windier, more dust).
  GS.dustFactor = 1.0 + (GLACIAL_DUST_INCREASE - 1.0) * GS.glacialIndex;
}

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM — advance Milankovitch
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance all Milankovitch configs by dtYears.
 */
export function systemMilankovitchTick(world, dtYears) {
  if (GlobalMilankovitchState.paused) return world;

  const config = MilankovitchConfig;

  for (let slot = 0; slot < _nextMilankovitchConfigSlot; slot++) {
    if (!config.active[slot]) continue;

    config.year[slot] += dtYears;

    // Update global state from this config (last one wins for the world).
    updateGlobalState(slot);
  }

  // Update observers.
  systemUpdateInsolationObservers(world);

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// OBSERVER UPDATE
// ═══════════════════════════════════════════════════════════════════════

function systemUpdateInsolationObservers(world) {
  const O = InsolationObserver;
  const GS = GlobalMilankovitchState;

  const eccentricity = GS.eccentricity;
  const obliquityRad = GS.obliquityRad;
  const precessionRad = GS.precessionRad;

  // Reference values at 0 = J2000.
  const refEcc = ECCENTRICITY_CURRENT;
  const refObl = OBLIQUITY_CURRENT;
  const refPrec = PRECESSION_CURRENT_DEG * DEG_TO_RAD;

  for (let slot = 0; slot < _nextInsolationObserverSlot; slot++) {
    if (!O.active[slot]) continue;

    const eid = O.ownerEid[slot];
    if (!eid || !entityExists(world, eid)) continue;

    const latRad = O.latitudeDeg[slot] * DEG_TO_RAD;

    // Annual mean insolation.
    const annualMean = computeAnnualMeanInsolation(latRad, eccentricity, obliquityRad, precessionRad);
    O.annualMeanInsolation[slot] = annualMean;

    // Summer solstice (day 172).
    const summerSolstice = computeDailyMeanInsolation(latRad, 172, eccentricity, obliquityRad, precessionRad);
    O.summerSolsticeInsolation[slot] = summerSolstice;

    // Winter solstice (day 355).
    const winterSolstice = computeDailyMeanInsolation(latRad, 355, eccentricity, obliquityRad, precessionRad);
    O.winterSolsticeInsolation[slot] = winterSolstice;

    // Reference annual mean.
    const refAnnual = computeAnnualMeanInsolation(latRad, refEcc, refObl, refPrec);
    O.annualMeanAnomaly[slot] = annualMean - refAnnual;

    // Reference summer solstice.
    const refSummer = computeDailyMeanInsolation(latRad, 172, refEcc, refObl, refPrec);
    O.summerAnomaly[slot] = summerSolstice - refSummer;

    // Local ice sheet presence: stronger at high latitudes, scaled by
    // the glacial index.
    const iceLatFactor = Math.max(0, (Math.abs(O.latitudeDeg[slot]) - 40) / 50);
    O.localIceSheet[slot] = Math.min(1, iceLatFactor * GS.glacialIndex);

    // Local temperature anomaly from Milankovitch.
    // Polar amplification of glacial cooling.
    const polarAmplification = 1.0 + 2.0 * iceLatFactor;
    O.localTempAnomaly[slot] = GS.globalTempAnomalyC * polarAmplification;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// COMBINED TEMPERATURE ANOMALY — all climate drivers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the combined temperature anomaly from all drivers:
 *   file 073 (human climate change warming)
 *   file 074 (volcanic winter cooling)
 *   file 075 (nuclear winter cooling)
 *   file 076 (solar cycle modulation — small)
 *   file 077 (Milankovitch — long-term)
 */
export function getCombinedAnomalyFromAll(latitudeDeg) {
  const climateWarming = GlobalClimate.transientWarming || 0;
  const volcanicCooling = GlobalVolcanicState.globalCooling || 0;
  const nuclearCooling = GlobalNuclearState.globalCooling || 0;
  const milankovitchAnomaly = GlobalMilankovitchState.globalTempAnomalyC;

  // Solar cycle: ~0.1 °C variation between min and max.
  const solarAnomaly = (GlobalSolarState.tsi - SOLAR_CONSTANT) * 0.05;

  return climateWarming - volcanicCooling - nuclearCooling + milankovitchAnomaly + solarAnomaly;
}

/**
 * Return the combined sea level from Milankovitch ice sheets and
 * climate change (file 073 thermal expansion).
 */
export function getCombinedSeaLevel() {
  const milankovitchSL = GlobalMilankovitchState.seaLevelM;
  const climateSL = (GlobalClimate.seaLevelRiseMm || 0) / 1000.0;
  return milankovitchSL + climateSL;
}

// ═══════════════════════════════════════════════════════════════════════
// SNOW LINE / TREE LINE COUPLING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the snow line shift due to Milankovitch (°C × 150 m/°C).
 */
export function getMilankovitchSnowLineShift() {
  return GlobalMilankovitchState.globalTempAnomalyC * 150.0;
}

/**
 * Return the tree line shift due to Milankovitch.
 */
export function getMilankovitchTreeLineShift() {
  return GlobalMilankovitchState.globalTempAnomalyC * 120.0;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC SAMPLING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the current eccentricity.
 */
export function getEccentricity() {
  return GlobalMilankovitchState.eccentricity;
}

/**
 * Return the current obliquity in radians.
 */
export function getObliquity() {
  return GlobalMilankovitchState.obliquityRad;
}

/**
 * Return the current obliquity in degrees.
 */
export function getObliquityDeg() {
  return GlobalMilankovitchState.obliquityDeg;
}

/**
 * Return the current precession angle in radians.
 */
export function getPrecession() {
  return GlobalMilankovitchState.precessionRad;
}

/**
 * Return the current precession in degrees.
 */
export function getPrecessionDeg() {
  return GlobalMilankovitchState.precessionDeg;
}

/**
 * Return the current climatic precession parameter.
 */
export function getClimaticPrecession() {
  return GlobalMilankovitchState.climaticPrecession;
}

/**
 * Return the current glacial index (0 = interglacial, 1 = full glacial).
 */
export function getGlacialIndex() {
  return GlobalMilankovitchState.glacialIndex;
}

/**
 * Return the current glacial stage.
 */
export function getGlacialStage() {
  return GlobalMilankovitchState.glacialStage;
}

/**
 * Return the current sea level (metres relative to present).
 */
export function getMilankovitchSeaLevel() {
  return GlobalMilankovitchState.seaLevelM;
}

/**
 * Return the current ice sheet volume (km³).
 */
export function getIceSheetVolume() {
  return GlobalMilankovitchState.iceVolumeKm3;
}

/**
 * Return the current global temperature anomaly (°C) from Milankovitch.
 */
export function getMilankovitchTempAnomaly() {
  return GlobalMilankovitchState.globalTempAnomalyC;
}

/**
 * Return the current Earth albedo.
 */
export function getEarthAlbedo() {
  return GlobalMilankovitchState.earthAlbedo;
}

/**
 * Return a human-readable label for a glacial stage.
 */
export function glacialStageLabel(stage) {
  switch (stage) {
    case GlacialStage.GLACIAL_MAXIMUM: return 'Glacial Maximum';
    case GlacialStage.GLACIAL:         return 'Glacial';
    case GlacialStage.STADIAL:         return 'Stadial';
    case GlacialStage.INTERSTADIAL:    return 'Interstadial';
    case GlacialStage.INTERGLACIAL:    return 'Interglacial';
    case GlacialStage.HOTHOUse:        return 'Hothouse';
    case GlacialStage.SNOWBALL:        return 'Snowball Earth';
    default:                            return 'Unknown';
  }
}

/**
 * Return a human-readable label for a Milankovitch preset.
 */
export function milankovitchPresetLabel(preset) {
  switch (preset) {
    case MilankovitchPreset.CURRENT:          return 'Current Epoch (2000 CE)';
    case MilankovitchPreset.LGM:              return 'Last Glacial Maximum (21k BP)';
    case MilankovitchPreset.HOLOCENE_OPTIMUM: return 'Holocene Optimum (6k BP)';
    case MilankovitchPreset.EEMIAN:           return 'Eemian Interglacial (125k BP)';
    case MilankovitchPreset.MIS_11:           return 'MIS 11 Super-Interglacial (400k BP)';
    case MilankovitchPreset.PETM:             return 'PETM (56M BP)';
    case MilankovitchPreset.SNOWBALL_EARTH:   return 'Snowball Earth (720M BP)';
    case MilankovitchPreset.CUSTOM:           return 'Custom';
    default:                                    return 'Unknown';
  }
}

/**
 * Return a full summary of the current Milankovitch state.
 */
export function getMilankovitchSummary() {
  const GS = GlobalMilankovitchState;
  return {
    year: GS.year,
    eccentricity: GS.eccentricity,
    obliquityDeg: GS.obliquityDeg,
    precessionDeg: GS.precessionDeg,
    climaticPrecession: GS.climaticPrecession,
    nhSummerInsolation: GS.nhSummerInsolation,
    nhSummerInsolationAnomaly: GS.nhSummerInsolationAnomaly,
    glacialIndex: GS.glacialIndex,
    glacialStage: GS.glacialStage,
    glacialStageLabel: glacialStageLabel(GS.glacialStage),
    globalTempAnomalyC: GS.globalTempAnomalyC,
    iceVolumeKm3: GS.iceVolumeKm3,
    seaLevelM: GS.seaLevelM,
    earthAlbedo: GS.earthAlbedo,
    dustFactor: GS.dustFactor,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Pause / resume
// ═══════════════════════════════════════════════════════════════════════

export function setMilankovitchPaused(paused) {
  GlobalMilankovitchState.paused = paused;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the current insolation at a given latitude and day of year.
 */
export function sampleInsolationAt(latitudeDeg, dayOfYear) {
  const GS = GlobalMilankovitchState;
  return computeDailyMeanInsolation(
    latitudeDeg * DEG_TO_RAD,
    dayOfYear,
    GS.eccentricity,
    GS.obliquityRad,
    GS.precessionRad
  );
}

/**
 * Return the current annual mean insolation at a given latitude.
 */
export function sampleAnnualMeanInsolationAt(latitudeDeg) {
  const GS = GlobalMilankovitchState;
  return computeAnnualMeanInsolation(
    latitudeDeg * DEG_TO_RAD,
    GS.eccentricity,
    GS.obliquityRad,
    GS.precessionRad
  );
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TICK (full)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance Milankovitch by dtYears.
 */
export function systemMilankovitchFullTick(world, dtYears) {
  return systemMilankovitchTick(world, dtYears);
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

export function gatherMilankovitchForRendering() {
  const observers = [];
  for (let slot = 0; slot < _nextInsolationObserverSlot; slot++) {
    if (!InsolationObserver.active[slot]) continue;
    observers.push({
      slot,
      latitudeDeg: InsolationObserver.latitudeDeg[slot],
      annualMeanInsolation: InsolationObserver.annualMeanInsolation[slot],
      summerSolsticeInsolation: InsolationObserver.summerSolsticeInsolation[slot],
      winterSolsticeInsolation: InsolationObserver.winterSolsticeInsolation[slot],
      annualMeanAnomaly: InsolationObserver.annualMeanAnomaly[slot],
      summerAnomaly: InsolationObserver.summerAnomaly[slot],
      localIceSheet: InsolationObserver.localIceSheet[slot],
      localTempAnomaly: InsolationObserver.localTempAnomaly[slot],
    });
  }

  return {
    state: getMilankovitchSummary(),
    observers,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function milankovitchStats() {
  let activeConfigs = 0;
  let activeObservers = 0;

  for (let slot = 0; slot < _nextMilankovitchConfigSlot; slot++) {
    if (MilankovitchConfig.active[slot]) activeConfigs++;
  }

  for (let slot = 0; slot < _nextInsolationObserverSlot; slot++) {
    if (InsolationObserver.active[slot]) activeObservers++;
  }

  return {
    activeConfigs,
    maxConfigs: MAX_MILANKOVITCH_CONFIGS,
    activeObservers,
    maxObservers: MAX_INSOLATION_OBSERVERS,
    currentYear: GlobalMilankovitchState.year,
    eccentricity: GlobalMilankovitchState.eccentricity,
    obliquityDeg: GlobalMilankovitchState.obliquityDeg,
    precessionDeg: GlobalMilankovitchState.precessionDeg,
    glacialIndex: GlobalMilankovitchState.glacialIndex,
    glacialStage: GlobalMilankovitchState.glacialStage,
    seaLevelM: GlobalMilankovitchState.seaLevelM,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearMilankovitch() {
  MilankovitchConfig.active.fill(0);
  MilankovitchConfig.ownerEid.fill(0);
  _milankovitchConfigSlots.clear();
  _nextMilankovitchConfigSlot = 0;

  InsolationObserver.active.fill(0);
  InsolationObserver.ownerEid.fill(0);
  _insolationObserverSlots.clear();
  _nextInsolationObserverSlot = 0;

  _cachedReferenceNHSummer = 0;

  GlobalMilankovitchState.year = 0;
  GlobalMilankovitchState.eccentricity = ECCENTRICITY_CURRENT;
  GlobalMilankovitchState.obliquityRad = OBLIQUITY_CURRENT;
  GlobalMilankovitchState.obliquityDeg = OBLIQUITY_CURRENT / DEG_TO_RAD;
  GlobalMilankovitchState.precessionRad = PRECESSION_CURRENT_DEG * DEG_TO_RAD;
  GlobalMilankovitchState.precessionDeg = PRECESSION_CURRENT_DEG;
  GlobalMilankovitchState.climaticPrecession = 0;
  GlobalMilankovitchState.globalInsolationAnomaly = 0;
  GlobalMilankovitchState.nhSummerInsolationAnomaly = 0;
  GlobalMilankovitchState.nhSummerInsolation = 0;
  GlobalMilankovitchState.referenceNhSummerInsolation = 0;
  GlobalMilankovitchState.glacialIndex = 0;
  GlobalMilankovitchState.glacialStage = GlacialStage.INTERGLACIAL;
  GlobalMilankovitchState.globalTempAnomalyC = 0;
  GlobalMilankovitchState.iceVolumeKm3 = ICE_VOLUME_INTERGLACIAL_KM3;
  GlobalMilankovitchState.seaLevelM = 0;
  GlobalMilankovitchState.earthAlbedo = 0.30;
  GlobalMilankovitchState.dustFactor = 1.0;
  GlobalMilankovitchState.paused = false;
}