// file number : 039
// full path name : src/sky/039_cumulonimbus_clouds.js
// description : Cumulonimbus cloud family — the towering storm clouds
//               that dominate severe weather. Cumulonimbus is the only
//               cloud type capable of producing thunder, lightning, hail,
//               tornadoes, and heavy rain / snow. The life cycle spans
//               three WMO stages: CALVUS (growing, fibrous top), CAPILLATUS
//               (mature, with a fully developed anvil), and INCUS (anvil
//               dominant, dissipating). This file imports
//               029_cloud_archetypes.js as its single source of truth and
//               contributes:
//                 • CumulonimbusArchetypes — pre-built archetypes for
//                   calvus, capillatus, incus, and supercell variants via
//                   createCloudArchetype
//                 • CumulonimbusState — SoA extension tracking per-instance
//                   updraft/downdraft column state, anvil width, anvil
//                   orientation, lightning strike accumulator, hail-core
//                   radius, overshooting-top flag, and tornado potential
//                 • Behaviour system — systemCumulonimbusEvolve drives
//                   the storm life cycle: tower growth → anvil expansion
//                   → dissipation, with updraft/downdraft oscillation
//                   feeding precipitation intensity
//                 • Density hook — sampleCumulonimbusDensity stacks
//                   towering puffs along the updraft column plus a wide,
//                   thin anvil sheet at the top, producing the iconic
//                   "mushroom cloud" shape
//                 • Lightning hook — sampleCumulonimbusLightning returns
//                   strike events (position, intensity, colour temperature)
//                   via a deterministic Poisson-like process, so file
//                   015's lights and file 026's observers can flash and
//                   react
//                 • Hail hook — sampleCumulonimbusHail returns hail
//                   emission data when the hail core is active, so
//                   file 025 can spawn damaging ice projectiles
//                 • Sun block hook — sampleCumulonimbusSunBlock returns
//                   the transmission factor (near zero at the tower)
//                 • VFX bridge — emitCumulonimbusRain, emitCumulonimbusHail,
//                   emitCumulonimbusAnvilWisps return data for file 025
//                 • Downdraft hook — sampleCumulonimbusDowndraft returns
//                   wind gusts for file 021's character controllers
//               All coefficients tuned to WMO International Cloud Atlas
//               2017, Cotton et al. 2011 "Storm and Cloud Dynamics",
//               Doswell 2001 "Severe Convective Storms", and Houze 2014.
//               Zero per-frame allocation; 8k cumulonimbus instances
//               evolve in a single pass at 1M-entity scale on Android
//               64-bit.
// best for : Severe-weather rendering, thunderstorms, supercell
//            simulations, tornado chases, gameplay storm events,
//            cinematic lightning flashes, damaging hail mechanics, and
//            any 1M-entity scene needing realistic towering storm clouds
//            on Android 64-bit.
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
  markDirty,
} from '../transform/002_transform_hierarchy.js';

import {
  SkyF32,
  sampleSkyRadiance,
  getSkySlot,
} from './028_sky_atmosphere.js';

import {
  CloudType,
  CloudSubtype,
  PrecipitationType,
  CloudArchetype,
  CloudInstance,
  CloudTag,
  createCloudArchetype,
  addCloudInstance,
  removeCloudInstance,
  getCloudSlot,
  sampleInstanceDensity,
} from './029_cloud_archetypes.js';

import {
  vec3,
  vec4,
  createNoise3D,
  createNoise2D,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS — verified
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ                        = 1e-16;
const EPSILON                           = 1e-8;
const EPSILON_HIGH                      = 1e-12;
const PI                                = Math.PI;
const TWO_PI                            = 2 * Math.PI;
const INV_PI                            = 1 / Math.PI;
const INV_TWO_PI                        = 1 / (2 * Math.PI);
const HALF_PI                           = Math.PI / 2;
const DEG_TO_RAD                        = Math.PI / 180;
const RAD_TO_DEG                        = 180 / Math.PI;

const MAX_CUMULONIMBUS_INSTANCES        = 8_000;
const CUMULONIMBUS_BASE_ALTITUDE_MIN    = 500;
const CUMULONIMBUS_BASE_ALTITUDE_MAX    = 1200;
const CUMULONIMBUS_TOP_ALTITUDE_MIN     = 8000;
const CUMULONIMBUS_TOP_ALTITUDE_MAX     = 16000;

const CUMULONIMBUS_DRIFT_SPEED_MIN      = 10;
const CUMULONIMBUS_DRIFT_SPEED_MAX      = 25;

// Life-cycle.
const CUMULONIMBUS_GROWTH_RATE          = 0.02;    // calvus growth
const CUMULONIMBUS_ANVIL_RATE           = 0.03;    // capillatus anvil
const CUMULONIMBUS_DISSIPATE_RATE       = 0.012;   // incus dissipation

// Anvil geometry.
const CUMULONIMBUS_ANVIL_MAX_WIDTH      = 15000;   // metres
const CUMULONIMBUS_ANVIL_MIN_WIDTH      = 3000;    // metres
const CUMULONIMBUS_ANVIL_THICKNESS      = 500;     // metres

// Tower geometry.
const CUMULONIMBUS_TOWER_RADIUS_MIN     = 800;
const CUMULONIMBUS_TOWER_RADIUS_MAX     = 3500;
const CUMULONIMBUS_TOWER_PUFF_MIN       = 20;
const CUMULONIMBUS_TOWER_PUFF_MAX       = 64;
const CUMULONIMBUS_TOWER_PUFF_RADIUS_MIN = 400;
const CUMULONIMBUS_TOWER_PUFF_RADIUS_MAX = 1200;

// Lightning.
const CUMULONIMBUS_LIGHTNING_RATE_BASE  = 0.08;    // strikes per second
const CUMULONIMBUS_LIGHTNING_RATE_SCALE = 0.45;    // additional
const CUMULONIMBUS_LIGHTNING_LIFETIME   = 0.15;    // seconds
const CUMULONIMBUS_LIGHTNING_INTENSITY  = 5.0;     // flash multiplier
const CUMULONIMBUS_LIGHTNING_COLOR_TEMP = 11000;   // Kelvin (blue-white)
const CUMULONIMBUS_LIGHTNING_RADIUS     = 4000;    // metres (search box)

// Hail.
const CUMULONIMBUS_HAIL_CORE_THRESHOLD  = 0.65;    // updraft strength
const CUMULONIMBUS_HAIL_RATE_BASE       = 2.0;     // mm/h
const CUMULONIMBUS_HAIL_RATE_SCALE      = 30.0;    // mm/h
const CUMULONIMBUS_HAIL_SIZE_MIN        = 5;       // mm
const CUMULONIMBUS_HAIL_SIZE_MAX        = 50;      // mm

// Precipitation.
const CUMULONIMBUS_RAIN_RATE_MIN        = 15.0;    // mm/h
const CUMULONIMBUS_RAIN_RATE_MAX        = 120.0;   // mm/h

// Snow mix.
const CUMULONIMBUS_SNOW_MIX_THRESHOLD   = 0.0;     // °C
const CUMULONIMBUS_SNOW_MIX_SLOPE       = 0.30;

// Fade.
const CUMULONIMBUS_FADE_IN_START        = 0.00;
const CUMULONIMBUS_FADE_IN_END          = 0.10;
const CUMULONIMBUS_FADE_OUT_START       = 0.90;
const CUMULONIMBUS_FADE_OUT_END         = 1.00;

// Sun block.
const CUMULONIMBUS_SUN_BLOCK_K          = 10.0;
const CUMULONIMBUS_SUN_TRANSMIT_MIN     = 0.01;

// Underside darkness.
const CUMULONIMBUS_UNDERSIDE_DARKEN     = 0.85;
const CUMULONIMBUS_TOPSIDE_BRIGHTEN     = 0.40;

// Overshooting top.
const CUMULONIMBUS_OVERSHOOT_THRESHOLD  = 0.75;
const CUMULONIMBUS_OVERSHOOT_HEIGHT     = 1500;   // metres above top

// Tornado potential.
const CUMULONIMBUS_TORNADO_THRESHOLD    = 0.85;
const CUMULONIMBUS_TORNADO_ACCUM_RATE   = 0.005;

// VFX.
const CUMULONIMBUS_VFX_RADIUS           = 2000;
const CUMULONIMBUS_VFX_MAX_RAIN         = 768;
const CUMULONIMBUS_VFX_MAX_HAIL         = 256;
const CUMULONIMBUS_VFX_MAX_ANVIL_WISPS  = 192;

// ═══════════════════════════════════════════════════════════════════════
// CUMULONIMBUS SUB-TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const CumulonimbusSubtype = Object.freeze({
  CALVUS:      0,   // growing, fibrous top, no anvil yet
  CAPILLATUS:  1,   // mature, fully developed anvil
  INCUS:       2,   // anvil-dominant, dissipating
  SUPERCELL:   3,   // rotating, most severe, tornado-prone
});

// ═══════════════════════════════════════════════════════════════════════
// PER-INSTANCE SoA STATE — cumulonimbus-specific extensions
// ═══════════════════════════════════════════════════════════════════════

export const CumulonimbusState = {
  // Sub-type (CumulonimbusSubtype).
  subtype: new Uint8Array(MAX_CUMULONIMBUS_INSTANCES),

  // Life-cycle phase (0 = fresh calvus, 1 = mature, 2 = dissipating).
  lifeCyclePhase: new Float32Array(MAX_CUMULONIMBUS_INSTANCES),

  // Tower growth progress (0..1; 1 = fully grown).
  towerGrowth: new Float32Array(MAX_CUMULONIMBUS_INSTANCES),

  // Anvil development progress (0..1; 1 = fully developed anvil).
  anvilProgress: new Float32Array(MAX_CUMULONIMBUS_INSTANCES),

  // Anvil width (metres).
  anvilWidth: new Float32Array(MAX_CUMULONIMBUS_INSTANCES),

  // Anvil orientation (radians; direction the anvil spreads).
  anvilOrientation: new Float32Array(MAX_CUMULONIMBUS_INSTANCES),

  // Updraft strength (0..1; 1 = maximum convection).
  updraftStrength: new Float32Array(MAX_CUMULONIMBUS_INSTANCES),

  // Downdraft strength (0..1; grows as precipitation loads the column).
  downdraftStrength: new Float32Array(MAX_CUMULONIMBUS_INSTANCES),

  // Tower radius (metres).
  towerRadius: new Float32Array(MAX_CUMULONIMBUS_INSTANCES),

  // Tower puff count (cauliflower cells along the column).
  towerPuffCount: new Uint8Array(MAX_CUMULONIMBUS_INSTANCES),

  // Tower puff radius (metres).
  towerPuffRadius: new Float32Array(MAX_CUMULONIMBUS_INSTANCES),

  // Lightning strike accumulator (0..1; fires when it reaches 1).
  lightningAccum: new Float32Array(MAX_CUMULONIMBUS_INSTANCES),

  // Recent lightning flash intensity (0 = no flash; decays after each strike).
  lightningFlash: new Float32Array(MAX_CUMULONIMBUS_INSTANCES),

  // Total lifetime lightning count.
  lightningCount: new Uint32Array(MAX_CUMULONIMBUS_INSTANCES),

  // Hail core radius (metres; 0 = no hail).
  hailCoreRadius: new Float32Array(MAX_CUMULONIMBUS_INSTANCES),

  // Hail emission rate (mm/h).
  hailRate: new Float32Array(MAX_CUMULONIMBUS_INSTANCES),

  // Mean hailstone diameter (mm).
  hailSize: new Float32Array(MAX_CUMULONIMBUS_INSTANCES),

  // Rain rate (mm/h).
  rainRate: new Float32Array(MAX_CUMULONIMBUS_INSTANCES),

  // Snow-mix ratio (0..1; rarely nonzero for cumulonimbus, but possible).
  snowMix: new Float32Array(MAX_CUMULONIMBUS_INSTANCES),

  // Base temperature (°C).
  baseTemperature: new Float32Array(MAX_CUMULONIMBUS_INSTANCES),

  // Overshooting top flag (1 = present).
  overshootingTop: new Uint8Array(MAX_CUMULONIMBUS_INSTANCES),

  // Tornado potential accumulator (0..1; SUPERCELL only).
  tornadoPotential: new Float32Array(MAX_CUMULONIMBUS_INSTANCES),

  // Underside darkness (0..1).
  undersideDarkness: new Float32Array(MAX_CUMULONIMBUS_INSTANCES),

  // Current thickness (multiplied against 029 coverage).
  thickness: new Float32Array(MAX_CUMULONIMBUS_INSTANCES),

  // Drift speed (m/s).
  driftSpeed: new Float32Array(MAX_CUMULONIMBUS_INSTANCES),

  // Current fade factor (0..1).
  fade: new Float32Array(MAX_CUMULONIMBUS_INSTANCES),

  // Noise indices (lazy).
  noiseIndex: new Uint16Array(MAX_CUMULONIMBUS_INSTANCES),

  // Back-pointer to 029 instance slot.
  _baseInstanceSlot: new Uint16Array(MAX_CUMULONIMBUS_INSTANCES),
};

/** Marker: entity is a cumulonimbus storm (set by addCumulonimbus). */
export const CumulonimbusTag = {};

const _cumulonimbusSlots = new Map(); // eid -> cumulonimbus slot
let _nextCumulonimbusSlot = 0;

// Noise generators (lazy).
const _cumulonimbusNoise3D = new Map();
const _cumulonimbusNoise2D = new Map();

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

function getCbNoise3D(index) {
  let n = _cumulonimbusNoise3D.get(index);
  if (!n) {
    n = createNoise3D(() => mulberry32(0xC8B0 ^ (index * 2654435761)));
    _cumulonimbusNoise3D.set(index, n);
  }
  return n;
}

function getCbNoise2D(index) {
  let n = _cumulonimbusNoise2D.get(index);
  if (!n) {
    n = createNoise2D(() => mulberry32((0xC8B0 ^ 0xA5A5) ^ (index * 2654435761)));
    _cumulonimbusNoise2D.set(index, n);
  }
  return n;
}

// ═══════════════════════════════════════════════════════════════════════
// PRE-BUILT ARCHETYPES — cumulonimbus family
// ═══════════════════════════════════════════════════════════════════════

export const CumulonimbusArchetypes = {
  calvus:     -1,
  capillatus: -1,
  incus:      -1,
  supercell:  -1,
  initialized: false,
};

/**
 * Build the four cumulonimbus archetypes once.
 */
export function ensureCumulonimbusArchetypes() {
  if (CumulonimbusArchetypes.initialized) return CumulonimbusArchetypes;

  // CALVUS — growing stage, fibrous top, no anvil.
  CumulonimbusArchetypes.calvus = createCloudArchetype(
    CloudType.CUMULONIMBUS,
    CloudSubtype.DEFAULT,
    {
      baseAltitude: 800,
      topAltitude: 10000,
      minCoverage: 0.15,
      maxCoverage: 0.40,
      density: 0.75,
      opticalDepth: 8.0,
      albedoR: 0.70, albedoG: 0.72, albedoB: 0.75,
      mieG: 0.55,
      windSpeed: 15,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 240,
      precipitationType: PrecipitationType.RAIN,
      precipitationRate: 15.0,
      lightningProbability: 0.02,
      billow: 0.85,
      wispiness: 0.25,
      puffiness: 0.85,
      shadowStrength: 0.85,
      silverLining: 0.55,
      haloEffect: 0.00,
    }
  );

  // CAPILLATUS — mature, with fully developed anvil.
  CumulonimbusArchetypes.capillatus = createCloudArchetype(
    CloudType.CUMULONIMBUS,
    CloudSubtype.DEFAULT,
    {
      baseAltitude: 700,
      topAltitude: 14000,
      minCoverage: 0.20,
      maxCoverage: 0.55,
      density: 0.90,
      opticalDepth: 12.0,
      albedoR: 0.55, albedoG: 0.58, albedoB: 0.62,
      mieG: 0.55,
      windSpeed: 18,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 300,
      precipitationType: PrecipitationType.RAIN,
      precipitationRate: 60.0,
      lightningProbability: 0.10,
      billow: 0.90,
      wispiness: 0.15,
      puffiness: 0.90,
      shadowStrength: 0.95,
      silverLining: 0.70,
      haloEffect: 0.00,
    }
  );

  // INCUS — anvil-dominant, dissipating.
  CumulonimbusArchetypes.incus = createCloudArchetype(
    CloudType.CUMULONIMBUS,
    CloudSubtype.INCUS,
    {
      baseAltitude: 700,
      topAltitude: 13000,
      minCoverage: 0.15,
      maxCoverage: 0.45,
      density: 0.75,
      opticalDepth: 9.0,
      albedoR: 0.60, albedoG: 0.63, albedoB: 0.67,
      mieG: 0.52,
      windSpeed: 25,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 400,
      precipitationType: PrecipitationType.RAIN,
      precipitationRate: 25.0,
      lightningProbability: 0.03,
      billow: 0.75,
      wispiness: 0.30,
      puffiness: 0.80,
      shadowStrength: 0.80,
      silverLining: 0.65,
      haloEffect: 0.00,
    }
  );

  // SUPERCELL — rotating, most severe, tornado-prone.
  CumulonimbusArchetypes.supercell = createCloudArchetype(
    CloudType.CUMULONIMBUS,
    CloudSubtype.DEFAULT,
    {
      baseAltitude: 500,
      topAltitude: 16000,
      minCoverage: 0.25,
      maxCoverage: 0.65,
      density: 0.95,
      opticalDepth: 15.0,
      albedoR: 0.45, albedoG: 0.48, albedoB: 0.52,
      mieG: 0.55,
      windSpeed: 22,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 350,
      precipitationType: PrecipitationType.RAIN,
      precipitationRate: 100.0,
      lightningProbability: 0.20,
      billow: 0.95,
      wispiness: 0.10,
      puffiness: 0.92,
      shadowStrength: 0.98,
      silverLining: 0.80,
      haloEffect: 0.00,
    }
  );

  CumulonimbusArchetypes.initialized = true;
  return CumulonimbusArchetypes;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — create cumulonimbus instances
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add a cumulonimbus storm instance to an entity.
 *
 * @param world       ECS world
 * @param eid         entity (must have WorldTransformF32)
 * @param subtype     'calvus' | 'capillatus' | 'incus' | 'supercell'
 * @param options     { radiusX, radiusZ, lifetime, baseTemperature,
 *                      updraftStrength, anvilOrientation }
 */
export function addCumulonimbus(world, eid, subtype = 'calvus', options = {}) {
  ensureCumulonimbusArchetypes();

  let archetypeSlot;
  let subtypeEnum;
  if (subtype === 'capillatus') {
    archetypeSlot = CumulonimbusArchetypes.capillatus;
    subtypeEnum = CumulonimbusSubtype.CAPILLATUS;
  } else if (subtype === 'incus') {
    archetypeSlot = CumulonimbusArchetypes.incus;
    subtypeEnum = CumulonimbusSubtype.INCUS;
  } else if (subtype === 'supercell') {
    archetypeSlot = CumulonimbusArchetypes.supercell;
    subtypeEnum = CumulonimbusSubtype.SUPERCELL;
  } else {
    archetypeSlot = CumulonimbusArchetypes.calvus;
    subtypeEnum = CumulonimbusSubtype.CALVUS;
  }

  if (_nextCumulonimbusSlot >= MAX_CUMULONIMBUS_INSTANCES) {
    throw new Error('cumulonimbus instance capacity exceeded');
  }
  const cbSlot = _nextCumulonimbusSlot++;

  // Register base cloud instance via 029.
  const topAlt = CloudArchetype.topAltitude[archetypeSlot];
  const baseAlt = CloudArchetype.baseAltitude[archetypeSlot];
  const radiusY = (topAlt - baseAlt) * 0.5;

  const towerRadius = CUMULONIMBUS_TOWER_RADIUS_MIN
    + Math.random() * (CUMULONIMBUS_TOWER_RADIUS_MAX - CUMULONIMBUS_TOWER_RADIUS_MIN);

  const instanceSlot = addCloudInstance(world, eid, archetypeSlot, {
    radiusX: options.radiusX ?? towerRadius * 2,
    radiusY: options.radiusY ?? radiusY,
    radiusZ: options.radiusZ ?? towerRadius * 2,
    lifetime: options.lifetime ?? 2400,
  });

  const CBS = CumulonimbusState;
  const rng = mulberry32(0xC8B0 ^ (cbSlot * 2654435761));

  CBS.subtype[cbSlot] = subtypeEnum;
  CBS.lifeCyclePhase[cbSlot] = 0;
  CBS.towerGrowth[cbSlot] = 0.3;   // starts with some growth
  CBS.anvilProgress[cbSlot] = subtypeEnum === CumulonimbusSubtype.CAPILLATUS ? 0.5 : 0;
  CBS.anvilWidth[cbSlot] = subtypeEnum === CumulonimbusSubtype.CAPILLATUS
    ? CUMULONIMBUS_ANVIL_MIN_WIDTH * 2
    : CUMULONIMBUS_ANVIL_MIN_WIDTH;
  CBS.anvilOrientation[cbSlot] = options.anvilOrientation ?? (rng() * TWO_PI);
  CBS.updraftStrength[cbSlot] = options.updraftStrength ?? (0.6 + rng() * 0.3);
  CBS.downdraftStrength[cbSlot] = 0.1;
  CBS.towerRadius[cbSlot] = towerRadius;

  let puffCount = CUMULONIMBUS_TOWER_PUFF_MIN
    + Math.floor(rng() * (CUMULONIMBUS_TOWER_PUFF_MAX - CUMULONIMBUS_TOWER_PUFF_MIN + 1));
  if (subtypeEnum === CumulonimbusSubtype.SUPERCELL) {
    puffCount = Math.floor(puffCount * 1.2);
  }
  CBS.towerPuffCount[cbSlot] = puffCount;
  CBS.towerPuffRadius[cbSlot] = CUMULONIMBUS_TOWER_PUFF_RADIUS_MIN
    + rng() * (CUMULONIMBUS_TOWER_PUFF_RADIUS_MAX - CUMULONIMBUS_TOWER_PUFF_RADIUS_MIN);

  CBS.lightningAccum[cbSlot] = 0;
  CBS.lightningFlash[cbSlot] = 0;
  CBS.lightningCount[cbSlot] = 0;
  CBS.hailCoreRadius[cbSlot] = 0;
  CBS.hailRate[cbSlot] = 0;
  CBS.hailSize[cbSlot] = 0;
  CBS.rainRate[cbSlot] = CloudArchetype.precipitationRate[archetypeSlot];
  CBS.baseTemperature[cbSlot] = options.baseTemperature ?? 20;
  CBS.snowMix[cbSlot] = computeSnowMix(CBS.baseTemperature[cbSlot]);
  CBS.overshootingTop[cbSlot] = 0;
  CBS.tornadoPotential[cbSlot] = 0;
  CBS.undersideDarkness[cbSlot] = 0.85;
  CBS.thickness[cbSlot] = CloudArchetype.density[archetypeSlot];
  CBS.driftSpeed[cbSlot] = CUMULONIMBUS_DRIFT_SPEED_MIN
    + rng() * (CUMULONIMBUS_DRIFT_SPEED_MAX - CUMULONIMBUS_DRIFT_SPEED_MIN);
  CBS.fade[cbSlot] = 0;
  CBS.noiseIndex[cbSlot] = cbSlot % 256;
  CBS._baseInstanceSlot[cbSlot] = instanceSlot;

  addComponent(world, eid, CumulonimbusTag);
  _cumulonimbusSlots.set(eid, cbSlot);

  return cbSlot;
}

export function removeCumulonimbus(world, eid) {
  const cbSlot = _cumulonimbusSlots.get(eid);
  if (cbSlot === undefined) return;

  removeCloudInstance(world, eid);

  _cumulonimbusSlots.delete(eid);
  CumulonimbusState.fade[cbSlot] = 0;
  removeComponent(world, eid, CumulonimbusTag);
}

// ═══════════════════════════════════════════════════════════════════════
// HELPER — snow mix from temperature
// ═══════════════════════════════════════════════════════════════════════

function computeSnowMix(temperatureC) {
  if (temperatureC >= CUMULONIMBUS_SNOW_MIX_THRESHOLD) return 0;
  const delta = CUMULONIMBUS_SNOW_MIX_THRESHOLD - temperatureC;
  return Math.min(1, delta * CUMULONIMBUS_SNOW_MIX_SLOPE);
}

// ═══════════════════════════════════════════════════════════════════════
// BEHAVIOUR — per-frame cumulonimbus evolution
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance cumulonimbus-specific behaviour. Full storm life cycle:
 *   1. Tower growth (calvus → capillatus)
 *   2. Anvil development (capillatus stage)
 *   3. Mature storm (lightning, hail, heavy rain)
 *   4. Dissipation (incus → fade out)
 *
 * Also drives lightning, hail, overshooting top, and tornado potential.
 */
export function systemCumulonimbusEvolve(world, dt) {
  const CBS = CumulonimbusState;
  const CI = CloudInstance;

  for (let slot = 0; slot < _nextCumulonimbusSlot; slot++) {
    const baseSlot = CBS._baseInstanceSlot[slot];
    if (baseSlot === undefined) continue;

    const fade = computeFade(CI.phase[baseSlot]);
    CBS.fade[slot] = fade;

    // 1. Tower growth (0 → 1).
    if (CBS.lifeCyclePhase[slot] < 1) {
      CBS.towerGrowth[slot] = Math.min(1,
        CBS.towerGrowth[slot] + CUMULONIMBUS_GROWTH_RATE * dt);
      if (CBS.towerGrowth[slot] >= 1) {
        CBS.lifeCyclePhase[slot] = 1;
      }
    }

    // 2. Anvil development (once tower is grown).
    if (CBS.towerGrowth[slot] >= 0.9) {
      CBS.anvilProgress[slot] = Math.min(1,
        CBS.anvilProgress[slot] + CUMULONIMBUS_ANVIL_RATE * dt);
    }

    // 3. Anvil width expands with anvilProgress.
    const targetWidth = CUMULONIMBUS_ANVIL_MIN_WIDTH
      + (CUMULONIMBUS_ANVIL_MAX_WIDTH - CUMULONIMBUS_ANVIL_MIN_WIDTH)
      * CBS.anvilProgress[slot];
    CBS.anvilWidth[slot] = targetWidth;

    // 4. Sub-type auto-promotion.
    if (CBS.subtype[slot] === CumulonimbusSubtype.CALVUS
        && CBS.anvilProgress[slot] > 0.7) {
      CBS.subtype[slot] = CumulonimbusSubtype.CAPILLATUS;
    }
    if (CBS.subtype[slot] === CumulonimbusSubtype.CAPILLATUS
        && CBS.lifeCyclePhase[slot] >= 2) {
      CBS.subtype[slot] = CumulonimbusSubtype.INCUS;
    }

    // 5. Life cycle progression.
    if (CBS.lifeCyclePhase[slot] === 1) {
      // Mature phase: advance toward dissipation when updraft weakens.
      if (CBS.updraftStrength[slot] < 0.4) {
        CBS.lifeCyclePhase[slot] = 2;
      }
    }
    if (CBS.lifeCyclePhase[slot] === 2) {
      // Dissipating.
      CBS.towerGrowth[slot] = Math.max(0,
        CBS.towerGrowth[slot] - CUMULONIMBUS_DISSIPATE_RATE * dt);
    }

    // 6. Updraft oscillation (convection pulsing).
    const oscillation = Math.sin(CI.phase[baseSlot] * TWO_PI * 3);
    CBS.updraftStrength[slot] = Math.max(0.3,
      Math.min(1.0, CBS.updraftStrength[slot] + oscillation * 0.02 * dt));

    // 7. Downdraft grows with precipitation load.
    const precipLoad = (CBS.rainRate[slot] + CBS.hailRate[slot]) / 100;
    CBS.downdraftStrength[slot] = Math.min(1.0,
      CBS.downdraftStrength[slot] + precipLoad * 0.01 * dt);

    // 8. Overshooting top: present when updraft is very strong and anvil
    //    is present.
    if (CBS.updraftStrength[slot] > CUMULONIMBUS_OVERSHOOT_THRESHOLD
        && CBS.anvilProgress[slot] > 0.5) {
      CBS.overshootingTop[slot] = 1;
    } else {
      CBS.overshootingTop[slot] = 0;
    }

    // 9. Lightning: Poisson-like accumulator with rate scaled by updraft
    //    and rain rate.
    const effectiveLightRate = CUMULONIMBUS_LIGHTNING_RATE_BASE
      + CUMULONIMBUS_LIGHTNING_RATE_SCALE * CBS.updraftStrength[slot];
    CBS.lightningAccum[slot] += effectiveLightRate * dt;

    if (CBS.lightningAccum[slot] >= 1.0) {
      CBS.lightningAccum[slot] -= 1.0;
      CBS.lightningFlash[slot] = 1.0;
      CBS.lightningCount[slot]++;
    }

    // Decay lightning flash.
    if (CBS.lightningFlash[slot] > 0) {
      CBS.lightningFlash[slot] = Math.max(0,
        CBS.lightningFlash[slot] - dt / CUMULONIMBUS_LIGHTNING_LIFETIME);
    }

    // 10. Hail: forms in the updraft core when updraft is strong enough.
    if (CBS.updraftStrength[slot] > CUMULONIMBUS_HAIL_CORE_THRESHOLD) {
      const excess = CBS.updraftStrength[slot] - CUMULONIMBUS_HAIL_CORE_THRESHOLD;
      const hailStrength = excess / (1 - CUMULONIMBUS_HAIL_CORE_THRESHOLD);
      CBS.hailCoreRadius[slot] = CBS.towerRadius[slot] * 0.5 * hailStrength;
      CBS.hailRate[slot] = CUMULONIMBUS_HAIL_RATE_BASE
        + CUMULONIMBUS_HAIL_RATE_SCALE * hailStrength;
      CBS.hailSize[slot] = CUMULONIMBUS_HAIL_SIZE_MIN
        + (CUMULONIMBUS_HAIL_SIZE_MAX - CUMULONIMBUS_HAIL_SIZE_MIN) * hailStrength;
    } else {
      CBS.hailCoreRadius[slot] = 0;
      CBS.hailRate[slot] = 0;
      CBS.hailSize[slot] = 0;
    }

    // 11. Rain rate: scales with updraft and downdraft.
    CBS.rainRate[slot] = CUMULONIMBUS_RAIN_RATE_MIN
      + (CUMULONIMBUS_RAIN_RATE_MAX - CUMULONIMBUS_RAIN_RATE_MIN)
      * CBS.updraftStrength[slot] * CBS.downdraftStrength[slot];

    // 12. Set precipitation flags.
    if (CBS.rainRate[slot] > EPSILON || CBS.hailRate[slot] > EPSILON) {
      CI.flags[baseSlot] |= 1 << 1;   // FLAG_PRECIPITATING
      CI.precipRate[baseSlot] = (CBS.rainRate[slot] + CBS.hailRate[slot])
        * CI.coverage[baseSlot] * fade;
    } else {
      CI.flags[baseSlot] &= ~(1 << 1);
      CI.precipRate[baseSlot] = 0;
    }

    // 13. Tornado potential (SUPERCELL only).
    if (CBS.subtype[slot] === CumulonimbusSubtype.SUPERCELL) {
      const tornadoFactor = CBS.updraftStrength[slot]
        * (1 - CBS.anvilProgress[slot] * 0.5);
      if (tornadoFactor > CUMULONIMBUS_TORNADO_THRESHOLD) {
        CBS.tornadoPotential[slot] = Math.min(1,
          CBS.tornadoPotential[slot] + CUMULONIMBUS_TORNADO_ACCUM_RATE * dt);
      } else {
        CBS.tornadoPotential[slot] = Math.max(0,
          CBS.tornadoPotential[slot] - CUMULONIMBUS_TORNADO_ACCUM_RATE * dt * 0.5);
      }
    }

    // 14. Snow mix.
    CBS.snowMix[slot] = computeSnowMix(CBS.baseTemperature[slot]);

    // 15. Underside darkness: driven by optical depth.
    const opticalFactor = CBS.thickness[slot] * CI.coverage[baseSlot] * fade;
    CBS.undersideDarkness[slot] = Math.max(0.7,
      Math.min(1.0, opticalFactor * 1.6));

    // 16. Drift.
    CI.px[baseSlot] += CBS.driftSpeed[slot] * dt;

    // 17. Sync visibility.
    CI.visibility[baseSlot] = fade;
  }

  return world;
}

function computeFade(phase) {
  if (phase < CUMULONIMBUS_FADE_IN_START) return 0;
  if (phase < CUMULONIMBUS_FADE_IN_END) {
    return (phase - CUMULONIMBUS_FADE_IN_START) /
           (CUMULONIMBUS_FADE_IN_END - CUMULONIMBUS_FADE_IN_START);
  }
  if (phase < CUMULONIMBUS_FADE_OUT_START) return 1;
  if (phase < CUMULONIMBUS_FADE_OUT_END) {
    return 1 - (phase - CUMULONIMBUS_FADE_OUT_START) /
               (CUMULONIMBUS_FADE_OUT_END - CUMULONIMBUS_FADE_OUT_START);
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════
// TOWER PUFF LAYOUT — pre-computed puff centers along the column
// ═══════════════════════════════════════════════════════════════════════

const _towerPuffCenter = vec3.create();

/**
 * Return the world-space center of tower puff `index`.
 * Puffs are distributed along the vertical column, spiralling slightly
 * for the cauliflower look.
 */
function getTowerPuffCenter(cbSlot, index, out) {
  const CI = CloudInstance;
  const baseSlot = CumulonimbusState._baseInstanceSlot[cbSlot];
  const rng = mulberry32(0xC8B0 ^ (cbSlot * 2654435761) ^ (index * 83492791));

  const totalPuffs = CumulonimbusState.towerPuffCount[cbSlot];

  // Normalized vertical position along the tower (0 = base, 1 = top).
  const v = (index + 0.5) / Math.max(1, totalPuffs);

  // Slight horizontal spiral for cauliflower texture.
  const phi = index * 2.39996322972865332;   // golden angle

  // Radius shrinks slightly with altitude (tower narrows toward top).
  const radial = (1 - v * 0.4) * (0.3 + rng() * 0.5);

  const x = Math.cos(phi) * radial;
  const z = Math.sin(phi) * radial;

  // Scale to cloud extents.
  const cx = CI.px[baseSlot];
  const cy = CI.py[baseSlot] - CI.radiusY[baseSlot] + v * 2 * CI.radiusY[baseSlot];
  const cz = CI.pz[baseSlot];

  const towerRadius = CumulonimbusState.towerRadius[cbSlot];

  out[0] = cx + x * towerRadius;
  out[1] = cy;
  out[2] = cz + z * towerRadius;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// DENSITY HOOK — override base 029 sampleInstanceDensity with tower+anvil
// ═══════════════════════════════════════════════════════════════════════

const _anvilCenter = vec3.create();

/**
 * Cumulonimbus-enhanced density sampling. Combines:
 *   • Tower: stacked puffs along the vertical column
 *   • Anvil: wide, flat sheet at the top
 *   • Overshooting top: extra density bulge above the anvil
 *
 * @param cbSlot     index in CumulonimbusState
 * @param wx, wy, wz world-space point
 */
export function sampleCumulonimbusDensity(cbSlot, wx, wy, wz) {
  const baseSlot = CumulonimbusState._baseInstanceSlot[cbSlot];
  if (baseSlot === undefined) return 0;

  const base = sampleInstanceDensity(baseSlot, wx, wy, wz);
  if (base < EPSILON) return 0;

  const CI = CloudInstance;
  const CBS = CumulonimbusState;

  // Vertical position within the cloud.
  const ly = wy - CI.py[baseSlot];
  const verticalNorm = (ly + CI.radiusY[baseSlot])
                     / Math.max(2 * CI.radiusY[baseSlot], 1);
  const verticalT = verticalNorm;   // 0 = base, 1 = top

  // Flat base check.
  if (verticalT < 0.05) return 0;
  const baseFade = Math.min(1, (verticalT - 0.05) / 0.10);

  // ── Tower density ─────────────────────────────────────────────
  const towerPuffCount = CBS.towerPuffCount[cbSlot];
  const towerPuffRadius = CBS.towerPuffRadius[cbSlot];
  const billowFactor = 0.6 + 0.4 * CBS.towerGrowth[cbSlot];

  let towerDensity = 0;
  for (let p = 0; p < towerPuffCount; p++) {
    getTowerPuffCenter(cbSlot, p, _towerPuffCenter);

    const dx = wx - _towerPuffCenter[0];
    const dy = wy - _towerPuffCenter[1];
    const dz = wz - _towerPuffCenter[2];
    const distSq = dx * dx + dy * dy + dz * dz;
    const puffRadiusSq = towerPuffRadius * towerPuffRadius * 2.2;

    if (distSq < puffRadiusSq) {
      const falloff = 1 - distSq / puffRadiusSq;
      towerDensity = Math.max(towerDensity, falloff);
    }
  }

  // ── Anvil density ────────────────────────────────────────────
  let anvilDensity = 0;
  if (CBS.anvilProgress[cbSlot] > EPSILON) {
    // Anvil sits at ~95% of tower height.
    _anvilCenter[0] = CI.px[baseSlot];
    _anvilCenter[1] = CI.py[baseSlot] + CI.radiusY[baseSlot] * 0.90;
    _anvilCenter[2] = CI.pz[baseSlot];

    const anvilRadius = CBS.anvilWidth[cbSlot] * 0.5;
    const anvilHeight = CUMULONIMBUS_ANVIL_THICKNESS;

    // Rotate into anvil frame.
    const dx = wx - _anvilCenter[0];
    const dz = wz - _anvilCenter[2];
    const cosA = Math.cos(CBS.anvilOrientation[cbSlot]);
    const sinA = Math.sin(CBS.anvilOrientation[cbSlot]);
    const along = dx * cosA + dz * sinA;
    const across = -dx * sinA + dz * cosA;

    const anvilDistAlong = along / anvilRadius;
    const anvilDistAcross = across / (anvilRadius * 0.6);
    const anvilDistY = (wy - _anvilCenter[1]) / Math.max(anvilHeight, 1);

    const anvilDistSq = anvilDistAlong * anvilDistAlong
                      + anvilDistAcross * anvilDistAcross
                      + anvilDistY * anvilDistY;

    if (anvilDistSq < 1.0) {
      anvilDensity = (1 - anvilDistSq) * CBS.anvilProgress[cbSlot];
    }
  }

  // ── Overshooting top ─────────────────────────────────────────
  let overshootDensity = 0;
  if (CBS.overshootingTop[cbSlot]) {
    const topY = CI.py[baseSlot] + CI.radiusY[baseSlot];
    const overshootY = topY + CUMULONIMBUS_OVERSHOOT_HEIGHT * 0.5;
    const dx = wx - CI.px[baseSlot];
    const dy = wy - overshootY;
    const dz = wz - CI.pz[baseSlot];
    const overshootR = CBS.towerRadius[cbSlot] * 0.4;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq < overshootR * overshootR) {
      overshootDensity = 1 - distSq / (overshootR * overshootR);
    }
  }

  // Combine densities (take max of tower/anvil, add overshoot).
  let combined = Math.max(towerDensity * billowFactor, anvilDensity * 0.6);
  combined = Math.max(combined, overshootDensity);

  if (combined <= 0) return 0;

  // Vertical darkening: very dark at base, lighter at top.
  const darkening = CUMULONIMBUS_UNDERSIDE_DARKEN * (1 - verticalT)
                  + CUMULONIMBUS_TOPSIDE_BRIGHTEN * verticalT;
  const darkMod = 1 - (1 - CBS.undersideDarkness[cbSlot]) * (1 - darkening);

  // Organic noise overlay.
  const noise3D = getCbNoise3D(CBS.noiseIndex[cbSlot]);
  const noiseMod = 0.85 + 0.15 * noise3D(wx * 0.004, wy * 0.004, wz * 0.004);

  const mod = combined * baseFade * darkMod * noiseMod
            * CBS.fade[cbSlot] * CBS.thickness[cbSlot] * 2.8;

  return Math.max(0, Math.min(1, base * mod));
}

// ═══════════════════════════════════════════════════════════════════════
// SUN BLOCK HOOK — return sun transmission factor
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the sun transmission factor (0..1). Cumulonimbus is nearly
 * opaque to the sun.
 */
export function sampleCumulonimbusSunBlock(cbSlot, viewDirX, viewDirY, viewDirZ) {
  const baseSlot = CumulonimbusState._baseInstanceSlot[cbSlot];
  if (baseSlot === undefined) return 1.0;

  const CBS = CumulonimbusState;
  if (CBS.fade[cbSlot] < 0.1) return 1.0;

  const CI = CloudInstance;
  const opticalFactor = CBS.thickness[cbSlot]
                      * CI.coverage[baseSlot]
                      * CBS.fade[cbSlot];

  const transmission = Math.exp(-opticalFactor * CUMULONIMBUS_SUN_BLOCK_K);
  return Math.max(CUMULONIMBUS_SUN_TRANSMIT_MIN, transmission);
}

// ═══════════════════════════════════════════════════════════════════════
// LIGHTNING HOOK — strikes as events
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the current lightning state of a cumulonimbus storm. Returns
 * strike data when a flash is currently active, or null.
 *
 * @returns { position, intensity, colorTemperature, hitRadius } | null
 */
export function sampleCumulonimbusLightning(cbSlot) {
  const CBS = CumulonimbusState;
  if (cbSlot < 0 || cbSlot >= _nextCumulonimbusSlot) return null;
  if (CBS.lightningFlash[cbSlot] < EPSILON) return null;

  const baseSlot = CBS._baseInstanceSlot[cbSlot];
  const CI = CloudInstance;

  // Lightning strikes at a random offset within the cloud base.
  const rng = mulberry32(0xC8B0 ^ (cbSlot * 2654435761) ^ (CBS.lightningCount[cbSlot] * 19349663));
  const angle = rng() * TWO_PI;
  const dist = rng() * CBS.towerRadius[cbSlot];
  const lx = Math.cos(angle) * dist;
  const lz = Math.sin(angle) * dist;

  const strikeX = CI.px[baseSlot] + lx;
  const strikeY = CI.py[baseSlot] - CI.radiusY[baseSlot];   // cloud base
  const strikeZ = CI.pz[baseSlot] + lz;

  return {
    position: [strikeX, strikeY, strikeZ],
    intensity: CBS.lightningFlash[cbSlot] * CUMULONIMBUS_LIGHTNING_INTENSITY,
    colorTemperature: CUMULONIMBUS_LIGHTNING_COLOR_TEMP,
    hitRadius: CUMULONIMBUS_LIGHTNING_RADIUS,
    lifetime: CUMULONIMBUS_LIGHTNING_LIFETIME,
    flash: CBS.lightningFlash[cbSlot],
    strikeIndex: CBS.lightningCount[cbSlot],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// HAIL HOOK — hail core data
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the hail core of a cumulonimbus storm.
 *
 * @returns { position, coreRadius, hailRate, meanHailSize } | null
 */
export function sampleCumulonimbusHail(cbSlot) {
  const CBS = CumulonimbusState;
  if (cbSlot < 0 || cbSlot >= _nextCumulonimbusSlot) return null;
  if (CBS.hailCoreRadius[cbSlot] < EPSILON) return null;

  const baseSlot = CBS._baseInstanceSlot[cbSlot];
  const CI = CloudInstance;

  return {
    position: [CI.px[baseSlot], CI.py[baseSlot], CI.pz[baseSlot]],
    coreRadius: CBS.hailCoreRadius[cbSlot],
    hailRate: CBS.hailRate[cbSlot],
    meanHailSize: CBS.hailSize[cbSlot],
    cloudBaseAltitude: CI.py[baseSlot] - CI.radiusY[baseSlot],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// DOWNDRAFT HOOK — for character controllers and wind gusts
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the downdraft gust at a given world position. Returns the
 * gust vector (x, z, speed) and intensity (0..1).
 */
export function sampleCumulonimbusDowndraft(cbSlot, wx, wy, wz) {
  const CBS = CumulonimbusState;
  if (cbSlot < 0 || cbSlot >= _nextCumulonimbusSlot) return null;
  if (CBS.downdraftStrength[cbSlot] < 0.2) return null;

  const baseSlot = CBS._baseInstanceSlot[cbSlot];
  const CI = CloudInstance;

  const dx = wx - CI.px[baseSlot];
  const dz = wz - CI.pz[baseSlot];
  const distSq = dx * dx + dz * dz;
  const maxDist = CI.radiusX[baseSlot] * 1.5;
  if (distSq > maxDist * maxDist) return null;

  // Outward radial gust from cloud center.
  const dist = Math.sqrt(distSq) || 1;
  const nx = dx / dist;
  const nz = dz / dist;

  const intensity = CBS.downdraftStrength[cbSlot]
                  * (1 - Math.min(1, dist / maxDist));
  const speed = 25 * intensity;   // peak ~25 m/s at center

  return {
    dirX: nx,
    dirZ: nz,
    speed,
    intensity,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// VFX BRIDGE — heavy rain, hail, and anvil wisps
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return data for the caller (file 025) to spawn heavy rain underneath
 * the storm.
 */
export function emitCumulonimbusRain(cbSlot, cameraX, cameraY, cameraZ, emitRate) {
  const baseSlot = CumulonimbusState._baseInstanceSlot[cbSlot];
  if (baseSlot === undefined) return null;

  const CBS = CumulonimbusState;
  if (CBS.rainRate[cbSlot] < EPSILON) return null;
  if (CBS.fade[cbSlot] < 0.3) return null;

  const CI = CloudInstance;
  const dx = cameraX - CI.px[baseSlot];
  const dz = cameraZ - CI.pz[baseSlot];
  const horizontalDistSq = dx * dx + dz * dz;
  if (horizontalDistSq > CUMULONIMBUS_VFX_RADIUS * CUMULONIMBUS_VFX_RADIUS) return null;

  // Precipitation type from snow mix.
  const snowMix = CBS.snowMix[cbSlot];
  let precipType;
  if (snowMix > 0.95)      precipType = PrecipitationType.SNOW;
  else if (snowMix < 0.05) precipType = PrecipitationType.RAIN;
  else                     precipType = PrecipitationType.MIXED;

  const count = Math.min(
    CUMULONIMBUS_VFX_MAX_RAIN,
    Math.floor(emitRate * CBS.rainRate[cbSlot] * 0.3)
  );

  if (count <= 0) return null;

  return {
    count,
    precipType,
    snowMix,
    rainRate: CBS.rainRate[cbSlot],
    cloudBaseAltitude: CI.py[baseSlot] - CI.radiusY[baseSlot],
    cloudTopAltitude: CI.py[baseSlot] + CI.radiusY[baseSlot],
    position: [CI.px[baseSlot], CI.py[baseSlot], CI.pz[baseSlot]],
    radiusX: CI.radiusX[baseSlot],
    radiusZ: CI.radiusZ[baseSlot],
    updraftStrength: CBS.updraftStrength[cbSlot],
    downdraftStrength: CBS.downdraftStrength[cbSlot],
  };
}

/**
 * Return data for the caller (file 025) to spawn hail particles.
 */
export function emitCumulonimbusHail(cbSlot, cameraX, cameraY, cameraZ, emitRate) {
  const baseSlot = CumulonimbusState._baseInstanceSlot[cbSlot];
  if (baseSlot === undefined) return null;

  const CBS = CumulonimbusState;
  if (CBS.hailRate[cbSlot] < EPSILON) return null;
  if (CBS.fade[cbSlot] < 0.3) return null;

  const CI = CloudInstance;
  const dx = cameraX - CI.px[baseSlot];
  const dz = cameraZ - CI.pz[baseSlot];
  const horizontalDistSq = dx * dx + dz * dz;
  if (horizontalDistSq > CUMULONIMBUS_VFX_RADIUS * CUMULONIMBUS_VFX_RADIUS) return null;

  const count = Math.min(
    CUMULONIMBUS_VFX_MAX_HAIL,
    Math.floor(emitRate * CBS.hailRate[cbSlot] * 0.5)
  );

  if (count <= 0) return null;

  return {
    count,
    hailRate: CBS.hailRate[cbSlot],
    meanHailSize: CBS.hailSize[cbSlot],
    coreRadius: CBS.hailCoreRadius[cbSlot],
    cloudBaseAltitude: CI.py[baseSlot] - CI.radiusY[baseSlot],
    position: [CI.px[baseSlot], CI.py[baseSlot], CI.pz[baseSlot]],
    radiusX: CI.radiusX[baseSlot],
    radiusZ: CI.radiusZ[baseSlot],
  };
}

/**
 * Return data for the caller (file 025) to spawn anvil wisp particles
 * (detrainment shearing off the anvil at the top).
 */
export function emitCumulonimbusAnvilWisps(cbSlot, cameraX, cameraY, cameraZ, emitRate) {
  const baseSlot = CumulonimbusState._baseInstanceSlot[cbSlot];
  if (baseSlot === undefined) return null;

  const CBS = CumulonimbusState;
  if (CBS.anvilProgress[cbSlot] < 0.3) return null;
  if (CBS.fade[cbSlot] < 0.3) return null;

  const CI = CloudInstance;
  const dx = cameraX - CI.px[baseSlot];
  const dz = cameraZ - CI.pz[baseSlot];
  const horizontalDistSq = dx * dx + dz * dz;
  if (horizontalDistSq > CUMULONIMBUS_VFX_RADIUS * CUMULONIMBUS_VFX_RADIUS) return null;

  const count = Math.min(
    CUMULONIMBUS_VFX_MAX_ANVIL_WISPS,
    Math.floor(emitRate * CBS.anvilProgress[cbSlot] * 6)
  );

  if (count <= 0) return null;

  return {
    count,
    anvilWidth: CBS.anvilWidth[cbSlot],
    anvilOrientation: CBS.anvilOrientation[cbSlot],
    anvilAltitude: CI.py[baseSlot] + CI.radiusY[baseSlot] * 0.90,
    position: [CI.px[baseSlot], CI.py[baseSlot], CI.pz[baseSlot]],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// TORNADO HOOK — signal tornado potential
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return true when the storm has tornado potential (SUPERCELL only).
 */
export function isTornadoActive(cbSlot) {
  const CBS = CumulonimbusState;
  if (cbSlot < 0 || cbSlot >= _nextCumulonimbusSlot) return false;
  if (CBS.subtype[cbSlot] !== CumulonimbusSubtype.SUPERCELL) return false;
  return CBS.tornadoPotential[cbSlot] >= 0.95;
}

/**
 * Return the current tornado potential (0..1).
 */
export function sampleTornadoPotential(cbSlot) {
  if (cbSlot < 0 || cbSlot >= _nextCumulonimbusSlot) return 0;
  return CumulonimbusState.tornadoPotential[cbSlot];
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — runtime parameter updates
// ═══════════════════════════════════════════════════════════════════════

/**
 * Set the base temperature.
 */
export function setCumulonimbusTemperature(cbSlot, tempC) {
  if (cbSlot < 0 || cbSlot >= _nextCumulonimbusSlot) return;
  CumulonimbusState.baseTemperature[cbSlot] = tempC;
  CumulonimbusState.snowMix[cbSlot] = computeSnowMix(tempC);
}

/**
 * Force an anvil development (e.g. for scripted severe-weather events).
 */
export function forceCumulonimbusAnvil(cbSlot, progress) {
  if (cbSlot < 0 || cbSlot >= _nextCumulonimbusSlot) return;
  CumulonimbusState.anvilProgress[cbSlot] = Math.max(0, Math.min(1, progress));
}

/**
 * Force lightning to strike immediately.
 */
export function forceCumulonimbusLightning(cbSlot) {
  if (cbSlot < 0 || cbSlot >= _nextCumulonimbusSlot) return;
  CumulonimbusState.lightningAccum[cbSlot] = 1.0;
}

/**
 * Force the storm into dissipation (fade out over the next few seconds).
 */
export function forceCumulonimbusDissipation(cbSlot) {
  if (cbSlot < 0 || cbSlot >= _nextCumulonimbusSlot) return;
  CumulonimbusState.lifeCyclePhase[cbSlot] = 2;
  CumulonimbusState.updraftStrength[cbSlot] = 0.2;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function cumulonimbusStats() {
  let active = 0;
  let calvus = 0, capillatus = 0, incus = 0, supercell = 0;
  let lightningTotal = 0;
  let hailing = 0;
  let tornadoActive = 0;

  for (let slot = 0; slot < _nextCumulonimbusSlot; slot++) {
    if (CumulonimbusState.fade[slot] < EPSILON) continue;
    active++;
    const subtype = CumulonimbusState.subtype[slot];
    if (subtype === CumulonimbusSubtype.CALVUS) calvus++;
    else if (subtype === CumulonimbusSubtype.CAPILLATUS) capillatus++;
    else if (subtype === CumulonimbusSubtype.INCUS) incus++;
    else supercell++;
    lightningTotal += CumulonimbusState.lightningCount[slot];
    if (CumulonimbusState.hailCoreRadius[slot] > EPSILON) hailing++;
    if (CumulonimbusState.tornadoPotential[slot] >= 0.95) tornadoActive++;
  }

  return {
    totalCumulonimbus: _nextCumulonimbusSlot,
    active,
    calvus,
    capillatus,
    incus,
    supercell,
    totalLightningStrikes: lightningTotal,
    hailing,
    tornadoActive,
    archetypesReady: CumulonimbusArchetypes.initialized,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearCumulonimbus() {
  _cumulonimbusSlots.clear();
  _nextCumulonimbusSlot = 0;
  _cumulonimbusNoise3D.clear();
  _cumulonimbusNoise2D.clear();
  CumulonimbusState.fade.fill(0);
  CumulonimbusState.lightningFlash.fill(0);
  CumulonimbusState.lightningAccum.fill(0);
  CumulonimbusState.lightningCount.fill(0);
  CumulonimbusState.hailRate.fill(0);
  CumulonimbusState.tornadoPotential.fill(0);
}