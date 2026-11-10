// file number : 076
// full path name : src/weather/076_solar_cycle.js
// description : Solar activity cycle system. Provides the astronomical
//               foundation for solar variability across multiple
//               timescales:
//                 • SCHWABE CYCLE (11-year sunspot cycle) — the primary
//                   ~11-year oscillation in solar magnetic activity,
//                   tracking sunspot number, active region count, and
//                   flare frequency.
//                 • GLEISSBERG CYCLE (~87 years) — amplitude modulation
//                   of the 11-year cycle.
//                 • DE VRIES / SUESS CYCLE (~210 years) — longer-term
//                   amplitude modulation of the Schwabe cycle.
//                 • HALLSTATT CYCLE (~2300 years) — the longest
//                   recognized solar cycle.
//                 • GNEVYSHEV-OHL RULE — odd-numbered cycles are
//                   systematically stronger than preceding even cycles.
//                 • WALÉN-MOSS RULE — polar magnetic field polarity
//                   flips each Schwabe cycle.
//
//               Solar activity affects downstream systems:
//                 • TOTAL SOLAR IRRADIANCE (TSI) — ±0.1% over the
//                   Schwabe cycle. Small but matters for file 073's
//                   long-term climate accounting. Baseline TSI at
//                   solar minimum ≈ 1360.5 W/m², solar maximum ≈
//                   1362.0 W/m².
//                 • ULTRAVIOLET / EXTREME UV — much larger variability
//                   (±10% at 200 nm, ±50% at Lyman-alpha 121.6 nm,
//                   ±100% at extreme UV <100 nm). Drives stratospheric
//                   ozone chemistry and file 028's sky scattering.
//                 • F10.7 CM SOLAR RADIO FLUX — the standard proxy
//                   (64-300 sfu). Feeds file 053's aurora intensity.
//                 • SUNSPOT NUMBER (SSN) — Wolf number (0-300). Visual
//                   sunspots on the solar disk (renderable via file 054's
//                   star field if not seen from space).
//                 • SOLAR FLARES — B, C, M, X class events. M and X
//                   class emit significant X-ray flux, affecting
//                   high-altitude ionosphere.
//                 • CORONAL MASS EJECTIONS (CMEs) — particle clouds
//                   traveling at 200-3000 km/s, arriving 1-4 days after
//                   the flare. Trigger geomagnetic storms.
//                 • GEOMAGNETIC STORMS — G1-G5 scale (Kp 5-9). Fed to
//                   file 053's aurora system for the correct equatorward
//                   boundary shift. Also affect file 062's electrical
//                   grid outages.
//                 • SOLAR ENERGETIC PARTICLES (SEP) events — high-
//                   energy protons and electrons, affecting file 014's
//                   material response in space, radiation dose for
//                   characters in space.
//
//               Historic milestones:
//                 • CARRINGTON EVENT (1859) — the largest recorded
//                   geomagnetic storm, caused by an X45-class flare
//                   + ultrafast CME. Would have destroyed modern
//                   electrical infrastructure. Available as a preset.
//                 • SOLAR CYCLE 19 (1957-1958) — the strongest cycle
//                   in the 20th century (SSN peak ~285).
//                 • MAUNDER MINIMUM (1645-1715) — 70-year period of
//                   near-zero sunspot activity coinciding with the
//                   "Little Ice Age". Available as a preset.
//                 • MODERN MAXIMUM (1950-2008) — 60-year period of
//                   unusually high solar activity.
//                 • DALTON MINIMUM (1790-1830) — another low-activity
//                   period.
//                 • MAUNDER MINIMUM (1645-1715).
//                 • SPÖRER MINIMUM (1450-1540).
//
//               All solar state lives in typed arrays; per-frame cost
//               is O(1) for the cycle computation + O(active flares
//               and CMEs) × O(1) for propagation. Zero per-frame
//               allocation; steady-state 1M-entity scenes handle
//               solar activity on Android 64-bit.
// best for : Space weather gameplay, aurora frequency modulation,
//            satellite/communications hazard, narrative solar-event
//            arcs, historical recreations (Carrington event),
//            long-term climate coupling, and any 1M-entity scene
//            needing realistic solar variability.
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
  AuroraInstance,
  AuroraViewer,
  setKpIndex,
} from '../sky/053_aurora.js';

import {
  SolarCycleInput,
} from './072_day_night_cycle.js';

import {
  GlobalClimate,
} from './073_climate_change.js';

import {
  GridNode,
  GridNodeTag,
} from './062_lightning_environmental.js';

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
const DAYS_PER_YEAR                  = 365.25;

// ── Solar cycle periods ─────────────────────────────────────
const SCHWABE_PERIOD_YEARS           = 11.0;
const GLEISSBERG_PERIOD_YEARS        = 87.0;
const DE_VRIES_PERIOD_YEARS          = 210.0;
const HALLSTATT_PERIOD_YEARS         = 2300.0;

// ── Solar irradiance ────────────────────────────────────────
const TSI_SOLAR_MINIMUM              = 1360.5;    // W/m²
const TSI_SOLAR_MAXIMUM              = 1362.0;
const TSI_VARIATION_RANGE            = 1.5;      // W/m² (peak to peak)
const UV_200NM_VARIATION             = 0.10;     // 10% variation at 200 nm
const UV_LYMAN_ALPHA_VARIATION       = 0.50;     // 50% at 121.6 nm
const EUV_VARIATION                  = 1.00;     // 100% at extreme UV

// ── F10.7 cm radio flux ────────────────────────────────────
const F10_7_MINIMUM                  = 64.0;     // sfu
const F10_7_MAXIMUM                  = 300.0;    // sfu
const F10_7_BASELINE                 = 80.0;     // sfu (solar minimum proxy)

// ── Sunspot number ─────────────────────────────────────────
const SUNSPOT_NUMBER_MAX             = 300.0;    // extreme maximum
const SUNSPOT_GROUPS_MAX             = 20;
const SUNSPOT_SPOTS_PER_GROUP_MAX    = 30;

// ── Solar flare classes (X-ray flux at 1 AU, W/m²) ─────────
const FLARE_CLASS_A_MIN_FLUX         = 1.0e-8;   // A class
const FLARE_CLASS_B_MIN_FLUX         = 1.0e-7;   // B class
const FLARE_CLASS_C_MIN_FLUX         = 1.0e-6;   // C class
const FLARE_CLASS_M_MIN_FLUX         = 1.0e-5;   // M class
const FLARE_CLASS_X_MIN_FLUX         = 1.0e-4;   // X class
const FLARE_CLASS_X_MAX_FLUX         = 5.0e-3;   // X50 (Carrington-scale)

// ── CME speeds ─────────────────────────────────────────────
const CME_MIN_SPEED_KM_PER_S         = 200.0;
const CME_MAX_SPEED_KM_PER_S         = 3000.0;
const CME_FAST_THRESHOLD_KM_PER_S    = 800.0;    // "fast" CME

// ── CME travel time to Earth ──────────────────────────────
const CME_EARTH_DISTANCE_AU          = 1.0;
const AU_IN_KM                       = 149_597_870.7;
const CME_AVERAGE_DECELERATION       = 0.5;      // fraction per AU

// ── Geomagnetic storm scale (Kp / G-scale) ────────────────
const KP_MIN                         = 0;
const KP_MAX                         = 9;
const STORM_THRESHOLD_KP             = 5.0;      // G1 minimum
const STORM_G5_KP                    = 9.0;
const STORM_G4_KP                    = 8.0;
const STORM_G3_KP                    = 7.0;
const STORM_G2_KP                    = 6.0;
const STORM_G1_KP                    = 5.0;

// ── SEP (Solar Energetic Particle) event ──────────────────
const SEP_MIN_PROTON_FLUX_PFU        = 10.0;     // pfu = proton flux unit
const SEP_MAX_PROTON_FLUX_PFU        = 100_000;

// ── Historical minimums ───────────────────────────────────
const HISTORIC_PRESETS = {
  CARINGTON_1859: {
    yearsSinceEpoch: 0.5,          // relative position in a super-cycle
    cycleNumber: 10,
    cycleAmplitude: 1.80,          // very strong
    monthOfCycle: 8,
    isExtreme: true,
  },
  CYCLE_19_PEAK: {
    yearsSinceEpoch: 19.0,
    cycleNumber: 19,
    cycleAmplitude: 1.35,
    monthOfCycle: 6,
    isExtreme: false,
  },
  MODERN_MAXIMUM: {
    yearsSinceEpoch: 20.0,
    cycleNumber: 20,
    cycleAmplitude: 1.25,
    monthOfCycle: 4,
    isExtreme: false,
  },
  MAUNDER_MINIMUM: {
    yearsSinceEpoch: 3.5,
    cycleNumber: 4,
    cycleAmplitude: 0.15,          // very weak
    monthOfCycle: 5,
    isExtreme: false,
  },
  DALTON_MINIMUM: {
    yearsSinceEpoch: 2.0,
    cycleNumber: 5,
    cycleAmplitude: 0.35,
    monthOfCycle: 6,
    isExtreme: false,
  },
  SPORER_MINIMUM: {
    yearsSinceEpoch: 1.5,
    cycleNumber: 3,
    cycleAmplitude: 0.25,
    monthOfCycle: 4,
    isExtreme: false,
  },
};

// ── SoA size limits ───────────────────────────────────────
const MAX_SOLAR_CYCLES               = 8;
const MAX_SOLAR_FLARES               = 128;
const MAX_CMES                       = 32;
const MAX_GEOMAGNETIC_STORMS         = 64;
const MAX_SOLAR_OBSERVERS            = 64;
const MAX_NARRATIVE_EVENTS           = 32;

// ── Flare class enum ──────────────────────────────────────
export const FlareClass = Object.freeze({
  A: 0,
  B: 1,
  C: 2,
  M: 3,
  X: 4,
});

// ── CME severity enum ─────────────────────────────────────
export const CMESeverity = Object.freeze({
  SLOW:     0,   // < 500 km/s
  MODERATE: 1,   // 500-1000 km/s
  FAST:     2,   // 1000-2000 km/s
  EXTREME:  3,   // > 2000 km/s
});

// ── Geomagnetic storm scale (NOAA G-scale) ────────────────
export const GeomagneticStormScale = Object.freeze({
  G0: 0,     // Kp < 5
  G1: 1,     // Kp = 5
  G2: 2,     // Kp = 6
  G3: 3,     // Kp = 7
  G4: 4,     // Kp = 8
  G5: 5,     // Kp = 9
});

// ── Solar cycle presets ───────────────────────────────────
export const SolarPreset = Object.freeze({
  MODERN_NORMAL:     0,
  CYCLE_19_PEAK:     1,
  MODERN_MAXIMUM:    2,
  MAUNDER_MINIMUM:   3,
  DALTON_MINIMUM:    4,
  SPORER_MINIMUM:    5,
  CARINGTON_1859:    6,
  CUSTOM:            7,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA GLOBAL SOLAR STATE
// ═══════════════════════════════════════════════════════════════════════

export const GlobalSolarState = {
  // Current solar cycle number (1-25).
  cycleNumber: 11,

  // Current position in the Schwabe cycle (0 = minimum, 0.5 = maximum, 1 = next minimum).
  cycleProgress: 0.0,

  // Current cycle amplitude multiplier (1.0 = normal, 2.0 = very strong, 0.1 = Maunder-like).
  cycleAmplitude: 1.0,

  // Long-term modulation from Gleissberg (~87 yr) cycle.
  gleissbergModulation: 0.0,

  // Long-term modulation from de Vries / Suess (~210 yr) cycle.
  deVriesModulation: 0.0,

  // Long-term modulation from Hallstatt (~2300 yr) cycle.
  hallstattModulation: 0.0,

  // Current total solar irradiance (W/m²).
  tsi: TSI_SOLAR_MINIMUM,

  // Current UV-200nm intensity (relative to baseline 1.0).
  uv200nm: 1.0,

  // Current Lyman-alpha intensity (relative to baseline 1.0).
  lymanAlpha: 1.0,

  // Current EUV intensity (relative to baseline 1.0).
  euv: 1.0,

  // Current F10.7 solar radio flux (sfu).
  f107: F10_7_BASELINE,

  // Current sunspot number (Wolf number).
  sunspotNumber: 0,

  // Current sunspot group count.
  sunspotGroups: 0,

  // Current visible sunspot spots.
  sunspotSpots: 0,

  // Polar field polarity: +1 = outward (north), -1 = inward (south).
  polarFieldSign: 1,

  // Current magnetic field strength at Earth (nT).
  geomagneticFieldStrength: 0,

  // Whether the solar cycle system is paused.
  paused: false,

  // Current year since epoch.
  year: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA SOLAR CYCLE
// ═══════════════════════════════════════════════════════════════════════

export const SolarCycle = {
  ownerEid: new Uint32Array(MAX_SOLAR_CYCLES),
  active: new Uint8Array(MAX_SOLAR_CYCLES),
  preset: new Uint8Array(MAX_SOLAR_CYCLES),
  cycleNumber: new Uint8Array(MAX_SOLAR_CYCLES),
  yearsElapsed: new Float32Array(MAX_SOLAR_CYCLES),
  amplitude: new Float32Array(MAX_SOLAR_CYCLES),
  seed: new Uint32Array(MAX_SOLAR_CYCLES),
};

/** Marker: entity owns a solar cycle. */
export const SolarCycleTag = {};

const _solarCycleSlots = new Map();
let _nextSolarCycleSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA SOLAR FLARE
// ═══════════════════════════════════════════════════════════════════════

export const SolarFlare = {
  active: new Uint8Array(MAX_SOLAR_FLARES),
  flareClass: new Uint8Array(MAX_SOLAR_FLARES),
  magnitude: new Float32Array(MAX_SOLAR_FLARES),    // C3.2 → 3.2, X1.5 → 1.5
  peakFluxWm2: new Float32Array(MAX_SOLAR_FLARES),
  activeRegionId: new Uint32Array(MAX_SOLAR_FLARES),
  eruptionTime: new Float32Array(MAX_SOLAR_FLARES),  // absolute solar year
  currentAge: new Float32Array(MAX_SOLAR_FLARES),
  durationHours: new Float32Array(MAX_SOLAR_FLARES),
  cmeGenerated: new Uint8Array(MAX_SOLAR_FLARES),
  cmeSlot: new Int16Array(MAX_SOLAR_FLARES),
  narrativeFired: new Uint8Array(MAX_SOLAR_FLARES),
};

// ═══════════════════════════════════════════════════════════════════════
// SoA CME
// ═══════════════════════════════════════════════════════════════════════

export const CME = {
  active: new Uint8Array(MAX_CMES),
  sourceFlareSlot: new Int16Array(MAX_CMES),
  speedKmPerS: new Float32Array(MAX_CMES),
  severity: new Uint8Array(MAX_CMES),
  launchYear: new Float32Array(MAX_CMES),
  currentAgeHours: new Float32Array(MAX_CMES),
  arrivalHours: new Float32Array(MAX_CMES),          // estimated arrival at Earth
  arrivalKp: new Float32Array(MAX_CMES),             // expected Kp when it arrives
  hasArrived: new Uint8Array(MAX_CMES),
  geomagneticStormSlot: new Int16Array(MAX_CMES),
};

// ═══════════════════════════════════════════════════════════════════════
// SoA GEOMAGNETIC STORM
// ═══════════════════════════════════════════════════════════════════════

export const GeomagneticStorm = {
  active: new Uint8Array(MAX_GEOMAGNETIC_STORMS),
  sourceCMESlot: new Int16Array(MAX_GEOMAGNETIC_STORMS),
  startYear: new Float32Array(MAX_GEOMAGNETIC_STORMS),
  peakKp: new Float32Array(MAX_GEOMAGNETIC_STORMS),
  currentKp: new Float32Array(MAX_GEOMAGNETIC_STORMS),
  scale: new Uint8Array(MAX_GEOMAGNETIC_STORMS),     // GeomagneticStormScale
  durationHours: new Float32Array(MAX_GEOMAGNETIC_STORMS),
  currentAgeHours: new Float32Array(MAX_GEOMAGNETIC_STORMS),
  auroraBoost: new Float32Array(MAX_GEOMAGNETIC_STORMS),   // multiplier for file 053
  gridOutageRisk: new Float32Array(MAX_GEOMAGNETIC_STORMS), // 0..1 for file 062
};

// ═══════════════════════════════════════════════════════════════════════
// SoA SOLAR OBSERVER
// ═══════════════════════════════════════════════════════════════════════

export const SolarObserver = {
  ownerEid: new Uint32Array(MAX_SOLAR_OBSERVERS),
  latitudeDeg: new Float32Array(MAX_SOLAR_OBSERVERS),
  localTsiModifier: new Float32Array(MAX_SOLAR_OBSERVERS),
  localUvModifier: new Float32Array(MAX_SOLAR_OBSERVERS),
  localEuvModifier: new Float32Array(MAX_SOLAR_OBSERVERS),
  localAuroraVisibility: new Float32Array(MAX_SOLAR_OBSERVERS),
  localRadiationDose: new Float32Array(MAX_SOLAR_OBSERVERS),
  active: new Uint8Array(MAX_SOLAR_OBSERVERS),
};

/** Marker: entity observes solar activity. */
export const SolarObserverTag = {};

const _solarObserverSlots = new Map();
let _nextSolarObserverSlot = 0;

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
// PUBLIC API — CYCLE CREATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a solar cycle configuration.
 */
export function addSolarCycle(world, eid, preset = SolarPreset.MODERN_NORMAL, options = {}) {
  if (_nextSolarCycleSlot >= MAX_SOLAR_CYCLES) {
    throw new Error('solar cycle capacity exceeded');
  }
  const slot = _nextSolarCycleSlot++;

  addComponent(world, eid, SolarCycleTag);

  const S = SolarCycle;
  S.ownerEid[slot] = eid;
  S.active[slot] = 1;
  S.preset[slot] = preset;
  S.cycleNumber[slot] = options.cycleNumber ?? 25;
  S.yearsElapsed[slot] = options.yearsElapsed ?? 0;
  S.amplitude[slot] = options.amplitude ?? 1.0;
  S.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  // Apply preset overrides.
  const presetData = HISTORIC_PRESETS[preset];
  if (presetData) {
    S.cycleNumber[slot] = presetData.cycleNumber ?? S.cycleNumber[slot];
    S.amplitude[slot] = presetData.cycleAmplitude ?? S.amplitude[slot];
    S.yearsElapsed[slot] = presetData.monthOfCycle / 12.0 ?? S.yearsElapsed[slot];
  }

  _solarCycleSlots.set(eid, slot);
  return slot;
}

export function removeSolarCycle(world, eid) {
  const slot = _solarCycleSlots.get(eid);
  if (slot === undefined) return;
  SolarCycle.active[slot] = 0;
  SolarCycle.ownerEid[slot] = 0;
  _solarCycleSlots.delete(eid);
  removeComponent(world, eid, SolarCycleTag);
}

export function getSolarCycleSlot(eid) {
  return _solarCycleSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// OBSERVER API
// ═══════════════════════════════════════════════════════════════════════

export function addSolarObserver(world, eid, latitudeDeg) {
  if (_nextSolarObserverSlot >= MAX_SOLAR_OBSERVERS) {
    throw new Error('solar observer capacity exceeded');
  }
  const slot = _nextSolarObserverSlot++;

  addComponent(world, eid, SolarObserverTag);

  const O = SolarObserver;
  O.ownerEid[slot] = eid;
  O.latitudeDeg[slot] = latitudeDeg ?? 45;
  O.localTsiModifier[slot] = 1.0;
  O.localUvModifier[slot] = 1.0;
  O.localEuvModifier[slot] = 1.0;
  O.localAuroraVisibility[slot] = 0;
  O.localRadiationDose[slot] = 0;
  O.active[slot] = 1;

  _solarObserverSlots.set(eid, slot);
  return slot;
}

export function removeSolarObserver(world, eid) {
  const slot = _solarObserverSlots.get(eid);
  if (slot === undefined) return;
  SolarObserver.active[slot] = 0;
  SolarObserver.ownerEid[slot] = 0;
  _solarObserverSlots.delete(eid);
  removeComponent(world, eid, SolarObserverTag);
}

export function getSolarObserverSlot(eid) {
  return _solarObserverSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// CYCLE POSITION AND AMPLITUDE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the current solar activity level (0..1) based on the Schwabe
 * cycle progress and amplitude.
 *
 * The Schwabe cycle is asymmetric — rise time is ~4 years, decline
 * is ~7 years.
 */
function computeSolarActivityLevel(cycleProgress, amplitude) {
  // Asymmetric shape: fast rise, slow decline.
  // Rise time ~4/11 of cycle, decline ~7/11.
  let activity;
  if (cycleProgress < 4.0 / 11.0) {
    // Rise phase.
    const t = cycleProgress / (4.0 / 11.0);
    activity = Math.sin(t * HALF_PI);
  } else if (cycleProgress < 1.0) {
    // Decline phase.
    const t = (cycleProgress - 4.0 / 11.0) / (7.0 / 11.0);
    activity = Math.cos(t * HALF_PI);
  } else {
    activity = 0.0;
  }

  return Math.max(0, Math.min(1, activity * amplitude));
}

/**
 * Compute the F10.7 solar radio flux from the activity level.
 */
function computeF107(activity) {
  return F10_7_MINIMUM + (F10_7_MAXIMUM - F10_7_MINIMUM) * activity;
}

/**
 * Compute the sunspot number from the activity level.
 */
function computeSunspotNumber(activity, rng) {
  if (activity < 0.05) return 0;

  const baseGroups = Math.floor(activity * SUNSPOT_GROUPS_MAX);
  const groupCount = Math.max(0, baseGroups + (rng() > 0.8 ? 1 : 0));

  let totalSpots = 0;
  for (let g = 0; g < groupCount; g++) {
    const spotsInGroup = Math.max(1, Math.floor(rng() * SUNSPOT_SPOTS_PER_GROUP_MAX));
    totalSpots += spotsInGroup;
  }

  // Wolf number: R = 10g + f.
  return Math.min(SUNSPOT_NUMBER_MAX, 10 * groupCount + totalSpots);
}

/**
 * Compute the total solar irradiance.
 */
function computeTSI(activity) {
  // 0.1% variation from solar minimum to maximum.
  return TSI_SOLAR_MINIMUM + TSI_VARIATION_RANGE * activity;
}

/**
 * Compute the UV (200 nm) intensity.
 */
function computeUV200(activity) {
  return 1.0 - UV_200NM_VARIATION * 0.5 + UV_200NM_VARIATION * activity;
}

/**
 * Compute the Lyman-alpha intensity.
 */
function computeLymanAlpha(activity) {
  return 1.0 - UV_LYMAN_ALPHA_VARIATION * 0.5 + UV_LYMAN_ALPHA_VARIATION * activity;
}

/**
 * Compute the EUV intensity.
 */
function computeEUV(activity) {
  return 1.0 - EUV_VARIATION * 0.5 + EUV_VARIATION * activity;
}

// ═══════════════════════════════════════════════════════════════════════
// FLARE GENERATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Generate a random solar flare. X-class flares are rare (0.1% of flares),
 * C-class are common (90%).
 */
function generateFlare(rng, activityLevel) {
  const u = rng();

  let flareClass;
  let magnitude;

  // Flare distribution depends on activity.
  const xProb = 0.001 * activityLevel;
  const mProb = 0.05 * activityLevel;
  const cProb = 0.5 * activityLevel;
  const bProb = 0.7 * activityLevel;

  if (u < xProb) {
    flareClass = FlareClass.X;
    magnitude = 1.0 + rng() * 9.0;    // X1 to X10 (very rare to be higher)
  } else if (u < xProb + mProb) {
    flareClass = FlareClass.M;
    magnitude = 1.0 + rng() * 9.0;
  } else if (u < xProb + mProb + cProb) {
    flareClass = FlareClass.C;
    magnitude = 1.0 + rng() * 9.0;
  } else if (u < xProb + mProb + cProb + bProb) {
    flareClass = FlareClass.B;
    magnitude = 1.0 + rng() * 9.0;
  } else {
    flareClass = FlareClass.A;
    magnitude = 1.0 + rng() * 9.0;
  }

  // Peak X-ray flux.
  let baseFlux;
  switch (flareClass) {
    case FlareClass.A: baseFlux = FLARE_CLASS_A_MIN_FLUX; break;
    case FlareClass.B: baseFlux = FLARE_CLASS_B_MIN_FLUX; break;
    case FlareClass.C: baseFlux = FLARE_CLASS_C_MIN_FLUX; break;
    case FlareClass.M: baseFlux = FLARE_CLASS_M_MIN_FLUX; break;
    case FlareClass.X: baseFlux = FLARE_CLASS_X_MIN_FLUX; break;
    default: baseFlux = 0;
  }

  return {
    flareClass,
    magnitude,
    peakFlux: baseFlux * magnitude,
  };
}

/**
 * Generate a CME. Fast CMEs (X-class) can be 1000-3000 km/s.
 */
function generateCME(rng, flareClass, magnitude) {
  let speedKmPerS;
  let severity;

  if (flareClass === FlareClass.X) {
    speedKmPerS = 800 + rng() * 2200;
    severity = CMESeverity.EXTREME;
  } else if (flareClass === FlareClass.M) {
    speedKmPerS = 500 + rng() * 1000;
    severity = CMESeverity.FAST;
  } else if (flareClass === FlareClass.C) {
    speedKmPerS = 300 + rng() * 500;
    severity = CMESeverity.MODERATE;
  } else {
    speedKmPerS = 200 + rng() * 300;
    severity = CMESeverity.SLOW;
  }

  // Estimate arrival time (in hours).
  const distanceKm = CME_EARTH_DISTANCE_AU * AU_IN_KM;
  let arrivalHours = distanceKm / speedKmPerS / 3600.0;

  // CMEs decelerate slightly.
  arrivalHours *= 1.0 + CME_AVERAGE_DECELERATION;

  // Expected Kp when it arrives.
  let arrivalKp;
  if (severity === CMESeverity.EXTREME) {
    arrivalKp = 7.0 + rng() * 2.0;
  } else if (severity === CMESeverity.FAST) {
    arrivalKp = 5.5 + rng() * 2.0;
  } else if (severity === CMESeverity.MODERATE) {
    arrivalKp = 3.0 + rng() * 2.0;
  } else {
    arrivalKp = 2.0 + rng() * 2.0;
  }

  return { speedKmPerS, severity, arrivalHours, arrivalKp };
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN SYSTEM — advance solar cycle
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance the solar cycle by dtYears.
 */
export function systemSolarCycleTick(world, dtYears) {
  const S = SolarCycle;

  for (let slot = 0; slot < _nextSolarCycleSlot; slot++) {
    if (!S.active[slot]) continue;

    S.yearsElapsed[slot] += dtYears;

    // Roll over to next cycle when we've reached the end.
    const cycleLength = SCHWABE_PERIOD_YEARS;
    if (S.yearsElapsed[slot] >= cycleLength) {
      S.yearsElapsed[slot] -= cycleLength;
      S.cycleNumber[slot] = (S.cycleNumber[slot] + 1) % 25;
      // Gnevyshev-Ohl rule: odd cycles stronger than preceding even.
      if (S.cycleNumber[slot] % 2 === 1) {
        S.amplitude[slot] *= 1.15;
      } else {
        S.amplitude[slot] *= 0.90;
      }
      S.amplitude[slot] = Math.max(0.1, Math.min(1.8, S.amplitude[slot]));
    }

    // Compute activity.
    const cycleProgress = S.yearsElapsed[slot] / cycleLength;
    const activity = computeSolarActivityLevel(cycleProgress, S.amplitude[slot]);

    // Update global state.
    const GS = GlobalSolarState;
    GS.cycleNumber = S.cycleNumber[slot];
    GS.cycleProgress = cycleProgress;
    GS.cycleAmplitude = S.amplitude[slot];
    GS.year += dtYears;
    GS.tsi = computeTSI(activity);
    GS.f107 = computeF107(activity);
    GS.uv200nm = computeUV200(activity);
    GS.lymanAlpha = computeLymanAlpha(activity);
    GS.euv = computeEUV(activity);

    // Sunspot number.
    const rng = mulberry32((S.seed[slot] + Math.floor(S.yearsElapsed[slot] * 1000)) >>> 0);
    GS.sunspotNumber = computeSunspotNumber(activity, rng);
    GS.sunspotGroups = Math.floor(activity * SUNSPOT_GROUPS_MAX);
    GS.sunspotSpots = Math.floor(GS.sunspotNumber * 0.9);

    // Polar field sign flips each cycle.
    GS.polarFieldSign = (S.cycleNumber[slot] % 2 === 0) ? 1 : -1;

    // Trigger flare generation.
    generateFlares(world, slot, activity, rng);

    // Advance existing flares.
    advanceFlares(world, dtYears);

    // Advance CMEs.
    advanceCMEs(world, dtYears);

    // Advance geomagnetic storms.
    advanceGeomagneticStorms(world, dtYears);

    // Update sky.
    applySolarToSky(world);
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// FLARE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════

function generateFlares(world, cycleSlot, activity, rng) {
  const S = SolarCycle;

  // Flare probability per year based on activity.
  const flaresPerYear = activity * 200;   // baseline
  const expectedFlares = flaresPerYear * (1.0 / 365.25) * (1.0 / 24.0);   // per hour

  const dtHours = (S.yearsElapsed[cycleSlot] - (S.yearsElapsed[cycleSlot] - 0.01)) * 365.25 * 24;

  if (rng() > expectedFlares) return;

  // Find a free flare slot.
  for (let i = 0; i < MAX_SOLAR_FLARES; i++) {
    if (SolarFlare.active[i]) continue;

    const flare = generateFlare(rng, activity);

    SolarFlare.active[i] = 1;
    SolarFlare.flareClass[i] = flare.flareClass;
    SolarFlare.magnitude[i] = flare.magnitude;
    SolarFlare.peakFluxWm2[i] = flare.peakFlux;
    SolarFlare.activeRegionId[i] = Math.floor(rng() * 10);
    SolarFlare.eruptionTime[i] = S.yearsElapsed[cycleSlot];
    SolarFlare.currentAge[i] = 0;
    SolarFlare.durationHours[i] = 0.5 + rng() * 2.0;
    SolarFlare.cmeGenerated[i] = 0;
    SolarFlare.cmeSlot[i] = -1;
    SolarFlare.narrativeFired[i] = 0;

    // X and M class flares may trigger CMEs.
    if (flare.flareClass >= FlareClass.M) {
      const cmeProbability = flare.flareClass === FlareClass.X ? 0.8 : 0.4;
      if (rng() < cmeProbability) {
        spawnCME(world, i, flare.flareClass, flare.magnitude, rng);
      }
    }

    return;
  }
}

function advanceFlares(world, dtYears) {
  const dtHours = dtYears * 365.25 * 24;

  for (let i = 0; i < MAX_SOLAR_FLARES; i++) {
    if (!SolarFlare.active[i]) continue;

    SolarFlare.currentAge[i] += dtHours;
    if (SolarFlare.currentAge[i] > SolarFlare.durationHours[i]) {
      SolarFlare.active[i] = 0;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// CME MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════

function spawnCME(world, flareSlot, flareClass, magnitude, rng) {
  for (let i = 0; i < MAX_CMES; i++) {
    if (CME.active[i]) continue;

    const cmeData = generateCME(rng, flareClass, magnitude);

    CME.active[i] = 1;
    CME.sourceFlareSlot[i] = flareSlot;
    CME.speedKmPerS[i] = cmeData.speedKmPerS;
    CME.severity[i] = cmeData.severity;
    CME.launchYear[i] = GlobalSolarState.year;
    CME.currentAgeHours[i] = 0;
    CME.arrivalHours[i] = cmeData.arrivalHours;
    CME.arrivalKp[i] = cmeData.arrivalKp;
    CME.hasArrived[i] = 0;
    CME.geomagneticStormSlot[i] = -1;

    SolarFlare.cmeGenerated[flareSlot] = 1;
    SolarFlare.cmeSlot[flareSlot] = i;

    return;
  }
}

function advanceCMEs(world, dtYears) {
  const dtHours = dtYears * 365.25 * 24;

  for (let i = 0; i < MAX_CMES; i++) {
    if (!CME.active[i]) continue;

    CME.currentAgeHours[i] += dtHours;

    // Check if CME has arrived at Earth.
    if (!CME.hasArrived[i] && CME.currentAgeHours[i] >= CME.arrivalHours[i]) {
      CME.hasArrived[i] = 1;

      // Trigger a geomagnetic storm if Kp is high enough.
      if (CME.arrivalKp[i] >= STORM_THRESHOLD_KP) {
        spawnGeomagneticStorm(world, i, CME.arrivalKp[i]);
      }
    }

    // Deactivate CME when storm has finished.
    if (CME.hasArrived[i]) {
      const stormSlot = CME.geomagneticStormSlot[i];
      if (stormSlot >= 0 && !GeomagneticStorm.active[stormSlot]) {
        CME.active[i] = 0;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// GEOMAGNETIC STORM MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════

function spawnGeomagneticStorm(world, cmeSlot, peakKp) {
  for (let i = 0; i < MAX_GEOMAGNETIC_STORMS; i++) {
    if (GeomagneticStorm.active[i]) continue;

    const scale = kpToStormScale(peakKp);

    GeomagneticStorm.active[i] = 1;
    GeomagneticStorm.sourceCMESlot[i] = cmeSlot;
    GeomagneticStorm.startYear[i] = GlobalSolarState.year;
    GeomagneticStorm.peakKp[i] = peakKp;
    GeomagneticStorm.currentKp[i] = 0;
    GeomagneticStorm.scale[i] = scale;
    GeomagneticStorm.durationHours[i] = 6 + Math.random() * 30;
    GeomagneticStorm.currentAgeHours[i] = 0;
    GeomagneticStorm.auroraBoost[i] = 1.0 + (peakKp - 5.0) * 0.5;
    GeomagneticStorm.gridOutageRisk[i] = Math.max(0, (peakKp - 5.0) / 4.0);

    CME.geomagneticStormSlot[cmeSlot] = i;

    // Update aurora.
    applyStormToAurora(i);

    return;
  }
}

function advanceGeomagneticStorms(world, dtYears) {
  const dtHours = dtYears * 365.25 * 24;

  for (let i = 0; i < MAX_GEOMAGNETIC_STORMS; i++) {
    if (!GeomagneticStorm.active[i]) continue;

    GeomagneticStorm.currentAgeHours[i] += dtHours;

    // Kp ramps up and down over the storm duration.
    const t = GeomagneticStorm.currentAgeHours[i] / GeomagneticStorm.durationHours[i];
    const ramp = Math.sin(t * PI);
    const currentKp = GeomagneticStorm.peakKp[i] * Math.max(0, ramp);

    GeomagneticStorm.currentKp[i] = currentKp;

    // Update aurora each frame.
    applyStormToAurora(i);

    // Deactivate when storm is over.
    if (t >= 1.0) {
      GeomagneticStorm.active[i] = 0;
      // Reset aurora Kp.
      resetAuroraKp();
    }
  }
}

/**
 * Map a Kp value to the NOAA G-scale.
 */
function kpToStormScale(kp) {
  if (kp >= STORM_G5_KP) return GeomagneticStormScale.G5;
  if (kp >= STORM_G4_KP) return GeomagneticStormScale.G4;
  if (kp >= STORM_G3_KP) return GeomagneticStormScale.G3;
  if (kp >= STORM_G2_KP) return GeomagneticStormScale.G2;
  if (kp >= STORM_G1_KP) return GeomagneticStormScale.G1;
  return GeomagneticStormScale.G0;
}

// ═══════════════════════════════════════════════════════════════════════
// AURORA COUPLING (file 053)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Apply the current geomagnetic storm's Kp to file 053's aurora system.
 */
function applyStormToAurora(stormSlot) {
  if (!AuroraInstance.active) return;

  const kp = GeomagneticStorm.currentKp[stormSlot];
  if (kp < 1.0) return;

  for (let auroraSlot = 0; auroraSlot < AuroraInstance.active.length; auroraSlot++) {
    if (!AuroraInstance.active[auroraSlot]) continue;
    setKpIndex(auroraSlot, Math.min(9.0, kp));
  }
}

/**
 * Reset aurora Kp to the baseline (5.0 for no storm).
 */
function resetAuroraKp() {
  if (!AuroraInstance.active) return;

  for (let auroraSlot = 0; auroraSlot < AuroraInstance.active.length; auroraSlot++) {
    if (!AuroraInstance.active[auroraSlot]) continue;
    setKpIndex(auroraSlot, 2.0);   // baseline Kp
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SKY INTEGRATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Apply the current solar activity level to file 028's sky storage.
 * Modulates the sun intensity slightly and adjusts sky colors for
 * solar maximum.
 */
function applySolarToSky(world) {
  if (!SkyF32 || !SkyF32.sunIntensity) return;

  const skyEids = query(world, [SkyF32]);
  for (let i = 0; i < skyEids.length; i++) {
    const eid = skyEids[i];
    const skySlot = getSkySlot(eid);
    if (skySlot < 0) continue;

    // Adjust exposure for TSI variation (tiny, barely visible).
    const tsiFactor = GlobalSolarState.tsi / TSI_SOLAR_MINIMUM;
    SkyF32.exposure[skySlot] *= tsiFactor;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// GRID OUTAGE COUPLING (file 062)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Apply the current geomagnetic storm's grid outage risk to file 062's
 * GridNode system. Larger storms can cause cascading electrical failures.
 */
export function systemApplySolarGridOutages(world) {
  for (let stormSlot = 0; stormSlot < MAX_GEOMAGNETIC_STORMS; stormSlot++) {
    if (!GeomagneticStorm.active[stormSlot]) continue;

    const risk = GeomagneticStorm.gridOutageRisk[stormSlot];
    if (risk < 0.1) continue;

    // Probabilistically knock out grid nodes.
    for (let nodeSlot = 0; nodeSlot < GridNode.active.length; nodeSlot++) {
      if (!GridNode.active[nodeSlot]) continue;
      if (GridNode.powered[nodeSlot] === 0) continue;

      if (Math.random() < risk * 0.01) {
        GridNode.powered[nodeSlot] = 0;
        GridNode.outageTimer[nodeSlot] = 3600;   // 1 hour minimum
      }
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// OBSERVER UPDATE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Update all solar observers with local effects.
 */
function systemUpdateSolarObservers(world) {
  const O = SolarObserver;

  for (let slot = 0; slot < _nextSolarObserverSlot; slot++) {
    if (!O.active[slot]) continue;

    const eid = O.ownerEid[slot];
    if (!eid || !entityExists(world, eid)) continue;

    // Sample local effects based on latitude.
    const latitude = O.latitudeDeg[slot];
    const absLat = Math.abs(latitude);

    // Aurora visibility: peaks at high latitudes, extends equatorward
    // during storms.
    let auroraVisibility = 0;
    for (let stormSlot = 0; stormSlot < MAX_GEOMAGNETIC_STORMS; stormSlot++) {
      if (!GeomagneticStorm.active[stormSlot]) continue;

      const kp = GeomagneticStorm.currentKp[stormSlot];
      const ovalLatitude = Math.max(30, 67 - kp * 3);   // equatorward boundary

      if (absLat >= ovalLatitude) {
        auroraVisibility = Math.max(auroraVisibility,
          (absLat - ovalLatitude) / (90 - ovalLatitude));
      }
    }
    O.localAuroraVisibility[slot] = auroraVisibility;

    // Local TSI modifier.
    O.localTsiModifier[slot] = GlobalSolarState.tsi / TSI_SOLAR_MINIMUM;

    // Local UV modifier.
    O.localUvModifier[slot] = GlobalSolarState.uv200nm;

    // Local EUV modifier (only matters for upper atmosphere).
    O.localEuvModifier[slot] = GlobalSolarState.euv;

    // Radiation dose: SEP events + geomagnetic storms.
    let dose = 0;
    for (let flareSlot = 0; flareSlot < MAX_SOLAR_FLARES; flareSlot++) {
      if (!SolarFlare.active[flareSlot]) continue;
      if (SolarFlare.flareClass[flareSlot] >= FlareClass.M) {
        dose += SolarFlare.peakFluxWm2[flareSlot] * 1e4;
      }
    }
    O.localRadiationDose[slot] = dose;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC SAMPLING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the current F10.7 flux.
 */
export function getCurrentF107() {
  return GlobalSolarState.f107;
}

/**
 * Return the current sunspot number.
 */
export function getCurrentSunspotNumber() {
  return GlobalSolarState.sunspotNumber;
}

/**
 * Return the current TSI (W/m²).
 */
export function getCurrentTSI() {
  return GlobalSolarState.tsi;
}

/**
 * Return the current cycle number.
 */
export function getCurrentCycleNumber() {
  return GlobalSolarState.cycleNumber;
}

/**
 * Return the current cycle progress (0..1).
 */
export function getCurrentCycleProgress() {
  return GlobalSolarState.cycleProgress;
}

/**
 * Return the current UV (200 nm) modifier.
 */
export function getCurrentUvModifier() {
  return GlobalSolarState.uv200nm;
}

/**
 * Return the current EUV modifier.
 */
export function getCurrentEuvModifier() {
  return GlobalSolarState.euv;
}

/**
 * Return the current geomagnetic storm Kp (0 if no storm).
 */
export function getCurrentKp() {
  let maxKp = 0;
  for (let i = 0; i < MAX_GEOMAGNETIC_STORMS; i++) {
    if (!GeomagneticStorm.active[i]) continue;
    if (GeomagneticStorm.currentKp[i] > maxKp) {
      maxKp = GeomagneticStorm.currentKp[i];
    }
  }
  return maxKp;
}

/**
 * Return a human-readable label for a flare class.
 */
export function flareClassLabel(flareClass) {
  switch (flareClass) {
    case FlareClass.A: return 'A';
    case FlareClass.B: return 'B';
    case FlareClass.C: return 'C';
    case FlareClass.M: return 'M';
    case FlareClass.X: return 'X';
    default:            return '?';
  }
}

/**
 * Return a human-readable label for a CME severity.
 */
export function cmeSeverityLabel(severity) {
  switch (severity) {
    case CMESeverity.SLOW:     return 'Slow';
    case CMESeverity.MODERATE: return 'Moderate';
    case CMESeverity.FAST:     return 'Fast';
    case CMESeverity.EXTREME:  return 'Extreme';
    default:                    return 'Unknown';
  }
}

/**
 * Return a human-readable label for a geomagnetic storm scale.
 */
export function geomagneticScaleLabel(scale) {
  switch (scale) {
    case GeomagneticStormScale.G0: return 'G0 (Quiet)';
    case GeomagneticStormScale.G1: return 'G1 (Minor)';
    case GeomagneticStormScale.G2: return 'G2 (Moderate)';
    case GeomagneticStormScale.G3: return 'G3 (Strong)';
    case GeomagneticStormScale.G4: return 'G4 (Severe)';
    case GeomagneticStormScale.G5: return 'G5 (Extreme)';
    default:                        return 'Unknown';
  }
}

/**
 * Return a human-readable label for a solar preset.
 */
export function solarPresetLabel(preset) {
  switch (preset) {
    case SolarPreset.MODERN_NORMAL:  return 'Modern Normal Cycle';
    case SolarPreset.CYCLE_19_PEAK:  return 'Cycle 19 Peak (1958)';
    case SolarPreset.MODERN_MAXIMUM: return 'Modern Maximum (1980s-2000s)';
    case SolarPreset.MAUNDER_MINIMUM:return 'Maunder Minimum (1645-1715)';
    case SolarPreset.DALTON_MINIMUM: return 'Dalton Minimum (1790-1830)';
    case SolarPreset.SPORER_MINIMUM: return 'Spörer Minimum (1450-1540)';
    case SolarPreset.CARINGTON_1859: return 'Carrington Event (1859)';
    case SolarPreset.CUSTOM:         return 'Custom';
    default:                          return 'Unknown';
  }
}

/**
 * Return a full summary of the current solar state.
 */
export function getSolarStateSummary() {
  return {
    cycleNumber: GlobalSolarState.cycleNumber,
    cycleProgress: GlobalSolarState.cycleProgress,
    cycleAmplitude: GlobalSolarState.cycleAmplitude,
    tsi: GlobalSolarState.tsi,
    f107: GlobalSolarState.f107,
    sunspotNumber: GlobalSolarState.sunspotNumber,
    sunspotGroups: GlobalSolarState.sunspotGroups,
    uv200nm: GlobalSolarState.uv200nm,
    lymanAlpha: GlobalSolarState.lymanAlpha,
    euv: GlobalSolarState.euv,
    currentKp: getCurrentKp(),
    polarFieldSign: GlobalSolarState.polarFieldSign,
    year: GlobalSolarState.year,
    activeFlares: countActiveFlares(),
    activeCMEs: countActiveCMEs(),
    activeStorms: countActiveStorms(),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN FULL TICK
// ═══════════════════════════════════════════════════════════════════════

/**
 * Full solar tick: advance cycle, flares, CMEs, storms, observers.
 */
export function systemSolarFullTick(world, dtYears) {
  if (GlobalSolarState.paused) return world;

  systemSolarCycleTick(world, dtYears);
  systemUpdateSolarObservers(world);
  systemApplySolarGridOutages(world);
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS / COUNTERS
// ═══════════════════════════════════════════════════════════════════════

function countActiveFlares() {
  let n = 0;
  for (let i = 0; i < MAX_SOLAR_FLARES; i++) if (SolarFlare.active[i]) n++;
  return n;
}

function countActiveCMEs() {
  let n = 0;
  for (let i = 0; i < MAX_CMES; i++) if (CME.active[i]) n++;
  return n;
}

function countActiveStorms() {
  let n = 0;
  for (let i = 0; i < MAX_GEOMAGNETIC_STORMS; i++) if (GeomagneticStorm.active[i]) n++;
  return n;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

export function gatherSolarActivityForRendering() {
  const flares = [];
  for (let i = 0; i < MAX_SOLAR_FLARES; i++) {
    if (!SolarFlare.active[i]) continue;
    flares.push({
      slot: i,
      flareClass: SolarFlare.flareClass[i],
      flareClassLabel: flareClassLabel(SolarFlare.flareClass[i]),
      magnitude: SolarFlare.magnitude[i],
      peakFluxWm2: SolarFlare.peakFluxWm2[i],
      currentAgeHours: SolarFlare.currentAge[i],
      durationHours: SolarFlare.durationHours[i],
    });
  }

  const cmes = [];
  for (let i = 0; i < MAX_CMES; i++) {
    if (!CME.active[i]) continue;
    cmes.push({
      slot: i,
      speedKmPerS: CME.speedKmPerS[i],
      severity: CME.severity[i],
      severityLabel: cmeSeverityLabel(CME.severity[i]),
      currentAgeHours: CME.currentAgeHours[i],
      arrivalHours: CME.arrivalHours[i],
      arrivalKp: CME.arrivalKp[i],
      hasArrived: CME.hasArrived[i] === 1,
    });
  }

  const storms = [];
  for (let i = 0; i < MAX_GEOMAGNETIC_STORMS; i++) {
    if (!GeomagneticStorm.active[i]) continue;
    storms.push({
      slot: i,
      peakKp: GeomagneticStorm.peakKp[i],
      currentKp: GeomagneticStorm.currentKp[i],
      scale: GeomagneticStorm.scale[i],
      scaleLabel: geomagneticScaleLabel(GeomagneticStorm.scale[i]),
      currentAgeHours: GeomagneticStorm.currentAgeHours[i],
      durationHours: GeomagneticStorm.durationHours[i],
    });
  }

  return {
    state: getSolarStateSummary(),
    flares,
    cmes,
    storms,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Pause or resume the solar cycle.
 */
export function setSolarCyclePaused(paused) {
  GlobalSolarState.paused = paused;
}

/**
 * Force a Carrington-scale flare at the current time.
 */
export function triggerCarringtonEvent(world) {
  for (let i = 0; i < MAX_SOLAR_FLARES; i++) {
    if (SolarFlare.active[i]) continue;

    SolarFlare.active[i] = 1;
    SolarFlare.flareClass[i] = FlareClass.X;
    SolarFlare.magnitude[i] = 45.0;   // X45 — the Carrington event
    SolarFlare.peakFluxWm2[i] = FLARE_CLASS_X_MIN_FLUX * 45.0;
    SolarFlare.activeRegionId[i] = 0;
    SolarFlare.eruptionTime[i] = GlobalSolarState.year;
    SolarFlare.currentAge[i] = 0;
    SolarFlare.durationHours[i] = 2.0;
    SolarFlare.cmeGenerated[i] = 0;
    SolarFlare.cmeSlot[i] = -1;

    // Generate the ultrafast CME.
    spawnCarringtonCME(world, i);

    return i;
  }
  return -1;
}

function spawnCarringtonCME(world, flareSlot) {
  for (let i = 0; i < MAX_CMES; i++) {
    if (CME.active[i]) continue;

    CME.active[i] = 1;
    CME.sourceFlareSlot[i] = flareSlot;
    CME.speedKmPerS[i] = 2500;   // ultrafast
    CME.severity[i] = CMESeverity.EXTREME;
    CME.launchYear[i] = GlobalSolarState.year;
    CME.currentAgeHours[i] = 0;
    CME.arrivalHours[i] = 17.0;   // ~17 hours to Earth
    CME.arrivalKp[i] = 9.5;      // Kp 9.5 (beyond scale)
    CME.hasArrived[i] = 0;
    CME.geomagneticStormSlot[i] = -1;

    SolarFlare.cmeGenerated[flareSlot] = 1;
    SolarFlare.cmeSlot[flareSlot] = i;
    return;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function solarCycleStats() {
  let activeCycles = 0;
  let activeObservers = 0;

  for (let slot = 0; slot < _nextSolarCycleSlot; slot++) {
    if (SolarCycle.active[slot]) activeCycles++;
  }

  for (let slot = 0; slot < _nextSolarObserverSlot; slot++) {
    if (SolarObserver.active[slot]) activeObservers++;
  }

  return {
    activeCycles,
    maxCycles: MAX_SOLAR_CYCLES,
    activeObservers,
    maxObservers: MAX_SOLAR_OBSERVERS,
    activeFlares: countActiveFlares(),
    activeCMEs: countActiveCMEs(),
    activeStorms: countActiveStorms(),
    cycleNumber: GlobalSolarState.cycleNumber,
    cycleProgress: GlobalSolarState.cycleProgress,
    tsi: GlobalSolarState.tsi,
    f107: GlobalSolarState.f107,
    sunspotNumber: GlobalSolarState.sunspotNumber,
    currentKp: getCurrentKp(),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearSolarCycle() {
  SolarCycle.active.fill(0);
  SolarCycle.ownerEid.fill(0);
  _solarCycleSlots.clear();
  _nextSolarCycleSlot = 0;

  SolarFlare.active.fill(0);

  CME.active.fill(0);

  GeomagneticStorm.active.fill(0);

  SolarObserver.active.fill(0);
  SolarObserver.ownerEid.fill(0);
  _solarObserverSlots.clear();
  _nextSolarObserverSlot = 0;

  GlobalSolarState.cycleNumber = 11;
  GlobalSolarState.cycleProgress = 0;
  GlobalSolarState.cycleAmplitude = 1.0;
  GlobalSolarState.tsi = TSI_SOLAR_MINIMUM;
  GlobalSolarState.f107 = F10_7_BASELINE;
  GlobalSolarState.uv200nm = 1.0;
  GlobalSolarState.lymanAlpha = 1.0;
  GlobalSolarState.euv = 1.0;
  GlobalSolarState.sunspotNumber = 0;
  GlobalSolarState.sunspotGroups = 0;
  GlobalSolarState.sunspotSpots = 0;
  GlobalSolarState.polarFieldSign = 1;
  GlobalSolarState.year = 0;
  GlobalSolarState.paused = false;
}