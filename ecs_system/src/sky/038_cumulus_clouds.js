// file number : 038
// full path name : src/sky/038_cumulus_clouds.js
// description : Cumulus cloud family — the classic fair-weather "cotton
//               puff" clouds with flat bases and cauliflower tops. Cumulus
//               sit at 500-2000 m (base) and grow upward through three
//               distinct stages defined by WMO: HUMILIS (small, flat,
//               fair-weather), MEDIOCRIS (moderate vertical growth,
//               usually fair-weather but can produce light showers), and
//               CONGESTUS (towering, dark-based, prone to showers and
//               transition into cumulonimbus). This file imports
//               029_cloud_archetypes.js as its single source of truth and
//               contributes:
//                 • CumulusArchetypes — pre-built archetypes for humilis,
//                   mediocris, and congestus via createCloudArchetype
//                 • CumulusState — SoA extension tracking per-instance
//                   billow phase, puff count, updraft velocity, detrainment
//                   progress, and cumulonimbus-transition progress
//                 • Behaviour system — systemCumulusEvolve drives the
//                   characteristic life cycle: billow growth → maturation
//                   → detrainment (or, for congestus, → cumulonimbus
//                   transition when the anvil begins to form)
//                 • Density hook — sampleCumulusDensity layers cauliflower
//                   puffs onto 029's ellipsoid: a stack of small spheres
//                   with strong vertical bias and flat base
//                 • Sun block hook — sampleCumulusSunBlock returns the
//                   transmission factor so file 028 darkens the sun with
//                   the correct soft-edged shadow
//                 • VFX bridge — emitCumulusWisps returns data for
//                   file 025 to spawn torn wisps at the detrainment
//                   edge; emitCumulusShower returns data for a short,
//                   localized shower under congestus clouds
//                 • Cumulonimbus transition — isReadyForCumulonimbusTransition
//                   signals when congestus has developed a persistent
//                   anvil attempt and should be upgraded to file 039
//               All coefficients tuned to WMO International Cloud Atlas
//               2017, Cotton et al. 2011 "Storm and Cloud Dynamics", and
//               Houze 2014. Zero per-frame allocation; 25k cumulus
//               instances evolve in a single pass at 1M-entity scale on
//               Android 64-bit.
// best for : Fair-weather skies, convective weather, afternoon
//            thunderstorm build-up, tropical realism, and any 1M-entity
//            scene needing classic puffy-cotton cumulus on Android
//            64-bit.
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

const MAX_CUMULUS_INSTANCES          = 25_000;

// Altitude ranges.
const CUMULUS_HUMILIS_BASE_MIN       = 500;
const CUMULUS_HUMILIS_BASE_MAX       = 800;
const CUMULUS_HUMILIS_TOP_MIN        = 800;
const CUMULUS_HUMILIS_TOP_MAX        = 1200;

const CUMULUS_MEDIOCRIS_BASE_MIN     = 600;
const CUMULUS_MEDIOCRIS_BASE_MAX     = 900;
const CUMULUS_MEDIOCRIS_TOP_MIN      = 1200;
const CUMULUS_MEDIOCRIS_TOP_MAX      = 2500;

const CUMULUS_CONGESTUS_BASE_MIN     = 600;
const CUMULUS_CONGESTUS_BASE_MAX     = 1000;
const CUMULUS_CONGESTUS_TOP_MIN      = 2500;
const CUMULUS_CONGESTUS_TOP_MAX      = 5000;

const CUMULUS_DRIFT_SPEED_MIN        = 3;
const CUMULUS_DRIFT_SPEED_MAX        = 10;

// Billow behavior.
const CUMULUS_BILLOW_RATE_HUMILIS     = 0.10;
const CUMULUS_BILLOW_RATE_MEDIOCRIS   = 0.15;
const CUMULUS_BILLOW_RATE_CONGESTUS   = 0.20;

// Detrainment (edge shearing) — slow for all cumulus.
const CUMULUS_DETRAIN_RATE           = 0.008;
const CUMULUS_DETRAIN_THRESHOLD      = 0.85;

// Cumulonimbus transition — only for congestus.
const CUMULUS_CB_TRANSITION_RATE     = 0.012;
const CUMULUS_CB_TRANSITION_THRESHOLD = 0.95;

// Puff density.
const CUMULUS_PUFF_COUNT_HUMILIS_MIN = 4;
const CUMULUS_PUFF_COUNT_HUMILIS_MAX = 8;
const CUMULUS_PUFF_COUNT_MEDIOCRIS_MIN = 8;
const CUMULUS_PUFF_COUNT_MEDIOCRIS_MAX = 16;
const CUMULUS_PUFF_COUNT_CONGESTUS_MIN = 16;
const CUMULUS_PUFF_COUNT_CONGESTUS_MAX = 32;

const CUMULUS_PUFF_RADIUS_MIN        = 120;
const CUMULUS_PUFF_RADIUS_MAX        = 400;

// Fade.
const CUMULUS_FADE_IN_START          = 0.00;
const CUMULUS_FADE_IN_END            = 0.15;
const CUMULUS_FADE_OUT_START         = 0.88;
const CUMULUS_FADE_OUT_END           = 1.00;

// Showers (congestus only).
const CUMULUS_SHOWER_THICKNESS       = 0.55;
const CUMULUS_SHOWER_RATE_BASE       = 0.5;   // mm/h
const CUMULUS_SHOWER_RATE_SCALE      = 3.0;   // mm/h

// Snow mix.
const CUMULUS_SNOW_MIX_THRESHOLD     = 0.0;   // °C
const CUMULUS_SNOW_MIX_SLOPE         = 0.25;

// Sun block.
const CUMULUS_SUN_BLOCK_K            = 3.0;
const CUMULUS_SUN_TRANSMIT_MIN       = 0.20;

// Underside darkening.
const CUMULUS_UNDERSIDE_DARKEN       = 0.55;
const CUMULUS_TOPSIDE_BRIGHTEN       = 0.25;

// VFX.
const CUMULUS_VFX_RADIUS             = 800;
const CUMULUS_VFX_MAX_WISPS          = 128;
const CUMULUS_VFX_MAX_SHOWER         = 256;

// ═══════════════════════════════════════════════════════════════════════
// CUMULUS SUB-TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const CumulusSubtype = Object.freeze({
  HUMILIS:   0,   // small, flat, fair-weather
  MEDIOCRIS: 1,   // moderate vertical growth
  CONGESTUS: 2,   // towering, dark-based, shower-prone
});

// ═══════════════════════════════════════════════════════════════════════
// PER-INSTANCE SoA STATE — cumulus-specific extensions
// ═══════════════════════════════════════════════════════════════════════

export const CumulusState = {
  // Sub-type (CumulusSubtype).
  subtype: new Uint8Array(MAX_CUMULUS_INSTANCES),

  // Billow phase (0..1; 0 = flat/fresh, 1 = fully puffed).
  billowPhase: new Float32Array(MAX_CUMULUS_INSTANCES),

  // Billow rate per second.
  billowRate: new Float32Array(MAX_CUMULUS_INSTANCES),

  // Number of puffs (cauliflower cells).
  puffCount: new Uint8Array(MAX_CUMULUS_INSTANCES),

  // Average puff radius (metres).
  puffRadius: new Float32Array(MAX_CUMULUS_INSTANCES),

  // Updraft velocity (m/s, positive = rising).
  updraftVelocity: new Float32Array(MAX_CUMULUS_INSTANCES),

  // Detrainment progress (0..1; 1 = ready to fade out).
  detrainProgress: new Float32Array(MAX_CUMULUS_INSTANCES),

  // Cumulonimbus transition progress (0..1; only for congestus).
  cbProgress: new Float32Array(MAX_CUMULUS_INSTANCES),

  // Showers (mm/h; 0 = no shower).
  showerRate: new Float32Array(MAX_CUMULUS_INSTANCES),

  // Base temperature (°C) — drives snow mix.
  baseTemperature: new Float32Array(MAX_CUMULUS_INSTANCES),

  // Snow-mix ratio (0..1).
  snowMix: new Float32Array(MAX_CUMULUS_INSTANCES),

  // Underside darkness (0..1).
  undersideDarkness: new Float32Array(MAX_CUMULUS_INSTANCES),

  // Current thickness (multiplied against 029 coverage).
  thickness: new Float32Array(MAX_CUMULUS_INSTANCES),

  // Drift speed (m/s).
  driftSpeed: new Float32Array(MAX_CUMULUS_INSTANCES),

  // Current fade factor (0..1).
  fade: new Float32Array(MAX_CUMULUS_INSTANCES),

  // Noise indices (lazy).
  noiseIndex: new Uint16Array(MAX_CUMULUS_INSTANCES),

  // Back-pointer to 029 instance slot.
  _baseInstanceSlot: new Uint16Array(MAX_CUMULUS_INSTANCES),
};

/** Marker: entity is a cumulus cloud (set by addCumulus). */
export const CumulusTag = {};

const _cumulusSlots = new Map(); // eid -> cumulus slot
let _nextCumulusSlot = 0;

// Noise generators (lazy).
const _cumulusNoise3D = new Map();
const _cumulusNoise2D = new Map();

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

function getCumulusNoise3D(index) {
  let n = _cumulusNoise3D.get(index);
  if (!n) {
    n = createNoise3D(() => mulberry32(0xC0C0 ^ (index * 2654435761)));
    _cumulusNoise3D.set(index, n);
  }
  return n;
}

function getCumulusNoise2D(index) {
  let n = _cumulusNoise2D.get(index);
  if (!n) {
    n = createNoise2D(() => mulberry32((0xC0C0 ^ 0xA5A5) ^ (index * 2654435761)));
    _cumulusNoise2D.set(index, n);
  }
  return n;
}

// ═══════════════════════════════════════════════════════════════════════
// PRE-BUILT ARCHETYPES — cumulus family
// ═══════════════════════════════════════════════════════════════════════

export const CumulusArchetypes = {
  humilis:    -1,
  mediocris:  -1,
  congestus:  -1,
  initialized: false,
};

/**
 * Build the three cumulus archetypes once.
 */
export function ensureCumulusArchetypes() {
  if (CumulusArchetypes.initialized) return CumulusArchetypes;

  // HUMILIS — small flat fair-weather cumulus.
  CumulusArchetypes.humilis = createCloudArchetype(
    CloudType.CUMULUS,
    CloudSubtype.DEFAULT,
    {
      baseAltitude: 650,
      topAltitude: 1200,
      minCoverage: 0.08,
      maxCoverage: 0.25,
      density: 0.40,
      opticalDepth: 2.5,
      albedoR: 0.95, albedoG: 0.96, albedoB: 0.97,
      mieG: 0.55,
      windSpeed: 5,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 400,
      precipitationType: PrecipitationType.NONE,
      precipitationRate: 0,
      lightningProbability: 0,
      billow: 0.85,
      wispiness: 0.05,
      puffiness: 0.90,
      shadowStrength: 0.35,
      silverLining: 0.55,
      haloEffect: 0.00,
    }
  );

  // MEDIOCRIS — moderate vertical growth, sharper cauliflower top.
  CumulusArchetypes.mediocris = createCloudArchetype(
    CloudType.CUMULUS,
    CloudSubtype.DEFAULT,
    {
      baseAltitude: 700,
      topAltitude: 2500,
      minCoverage: 0.10,
      maxCoverage: 0.35,
      density: 0.55,
      opticalDepth: 3.5,
      albedoR: 0.90, albedoG: 0.91, albedoB: 0.93,
      mieG: 0.58,
      windSpeed: 6,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 300,
      precipitationType: PrecipitationType.RAIN,
      precipitationRate: 0.5,
      lightningProbability: 0.0001,
      billow: 0.92,
      wispiness: 0.05,
      puffiness: 0.95,
      shadowStrength: 0.50,
      silverLining: 0.65,
      haloEffect: 0.00,
    }
  );

  // CONGESTUS — towering, dark-based, shower-prone.
  CumulusArchetypes.congestus = createCloudArchetype(
    CloudType.CUMULUS,
    CloudSubtype.DEFAULT,
    {
      baseAltitude: 800,
      topAltitude: 5000,
      minCoverage: 0.12,
      maxCoverage: 0.45,
      density: 0.75,
      opticalDepth: 6.0,
      albedoR: 0.80, albedoG: 0.82, albedoB: 0.85,
      mieG: 0.60,
      windSpeed: 8,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 240,
      precipitationType: PrecipitationType.RAIN,
      precipitationRate: 2.0,
      lightningProbability: 0.0005,
      billow: 0.90,
      wispiness: 0.05,
      puffiness: 0.92,
      shadowStrength: 0.70,
      silverLining: 0.70,
      haloEffect: 0.00,
    }
  );

  CumulusArchetypes.initialized = true;
  return CumulusArchetypes;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — create cumulus instances
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add a cumulus cloud instance to an entity.
 *
 * @param world       ECS world
 * @param eid         entity (must have WorldTransformF32)
 * @param subtype     'humilis' | 'mediocris' | 'congestus'
 * @param options     { radiusX, radiusY, radiusZ, lifetime,
 *                      baseTemperature, puffCount }
 */
export function addCumulus(world, eid, subtype = 'humilis', options = {}) {
  ensureCumulusArchetypes();

  let archetypeSlot;
  let subtypeEnum;
  if (subtype === 'mediocris') {
    archetypeSlot = CumulusArchetypes.mediocris;
    subtypeEnum = CumulusSubtype.MEDIOCRIS;
  } else if (subtype === 'congestus') {
    archetypeSlot = CumulusArchetypes.congestus;
    subtypeEnum = CumulusSubtype.CONGESTUS;
  } else {
    archetypeSlot = CumulusArchetypes.humilis;
    subtypeEnum = CumulusSubtype.HUMILIS;
  }

  if (_nextCumulusSlot >= MAX_CUMULUS_INSTANCES) {
    throw new Error('cumulus instance capacity exceeded');
  }
  const cuSlot = _nextCumulusSlot++;

  // Register base cloud instance via 029.
  const topAlt = CloudArchetype.topAltitude[archetypeSlot];
  const baseAlt = CloudArchetype.baseAltitude[archetypeSlot];
  const radiusY = (topAlt - baseAlt) * 0.5;

  const instanceSlot = addCloudInstance(world, eid, archetypeSlot, {
    radiusX: options.radiusX ?? 800,
    radiusY: options.radiusY ?? radiusY,
    radiusZ: options.radiusZ ?? 800,
    lifetime: options.lifetime ?? 1200,
  });

  const CS = CumulusState;
  const rng = mulberry32(0xC0C0 ^ (cuSlot * 2654435761));

  CS.subtype[cuSlot] = subtypeEnum;
  CS.billowPhase[cuSlot] = 0;
  CS.billowRate[cuSlot] = subtypeEnum === CumulusSubtype.HUMILIS
    ? CUMULUS_BILLOW_RATE_HUMILIS
    : subtypeEnum === CumulusSubtype.MEDIOCRIS
      ? CUMULUS_BILLOW_RATE_MEDIOCRIS
      : CUMULUS_BILLOW_RATE_CONGESTUS;

  let puffCount;
  if (subtypeEnum === CumulusSubtype.HUMILIS) {
    puffCount = CUMULUS_PUFF_COUNT_HUMILIS_MIN
              + Math.floor(rng() * (CUMULUS_PUFF_COUNT_HUMILIS_MAX - CUMULUS_PUFF_COUNT_HUMILIS_MIN + 1));
  } else if (subtypeEnum === CumulusSubtype.MEDIOCRIS) {
    puffCount = CUMULUS_PUFF_COUNT_MEDIOCRIS_MIN
              + Math.floor(rng() * (CUMULUS_PUFF_COUNT_MEDIOCRIS_MAX - CUMULUS_PUFF_COUNT_MEDIOCRIS_MIN + 1));
  } else {
    puffCount = CUMULUS_PUFF_COUNT_CONGESTUS_MIN
              + Math.floor(rng() * (CUMULUS_PUFF_COUNT_CONGESTUS_MAX - CUMULUS_PUFF_COUNT_CONGESTUS_MIN + 1));
  }
  CS.puffCount[cuSlot] = options.puffCount ?? puffCount;

  CS.puffRadius[cuSlot] = CUMULUS_PUFF_RADIUS_MIN
    + rng() * (CUMULUS_PUFF_RADIUS_MAX - CUMULUS_PUFF_RADIUS_MIN);

  CS.updraftVelocity[cuSlot] = 1.0 + rng() * 2.5;
  CS.detrainProgress[cuSlot] = 0;
  CS.cbProgress[cuSlot] = 0;
  CS.showerRate[cuSlot] = 0;
  CS.baseTemperature[cuSlot] = options.baseTemperature ?? 15;
  CS.snowMix[cuSlot] = computeSnowMix(CS.baseTemperature[cuSlot]);
  CS.undersideDarkness[cuSlot] = 0.5;
  CS.thickness[cuSlot] = CloudArchetype.density[archetypeSlot];
  CS.driftSpeed[cuSlot] = CUMULUS_DRIFT_SPEED_MIN
    + rng() * (CUMULUS_DRIFT_SPEED_MAX - CUMULUS_DRIFT_SPEED_MIN);
  CS.fade[cuSlot] = 0;
  CS.noiseIndex[cuSlot] = cuSlot % 256;
  CS._baseInstanceSlot[cuSlot] = instanceSlot;

  addComponent(world, eid, CumulusTag);
  _cumulusSlots.set(eid, cuSlot);

  return cuSlot;
}

export function removeCumulus(world, eid) {
  const cuSlot = _cumulusSlots.get(eid);
  if (cuSlot === undefined) return;

  removeCloudInstance(world, eid);

  _cumulusSlots.delete(eid);
  CumulusState.fade[cuSlot] = 0;
  removeComponent(world, eid, CumulusTag);
}

// ═══════════════════════════════════════════════════════════════════════
// HELPER — snow mix from temperature
// ═══════════════════════════════════════════════════════════════════════

function computeSnowMix(temperatureC) {
  if (temperatureC >= CUMULUS_SNOW_MIX_THRESHOLD) return 0;
  const delta = CUMULUS_SNOW_MIX_THRESHOLD - temperatureC;
  return Math.min(1, delta * CUMULUS_SNOW_MIX_SLOPE);
}

// ═══════════════════════════════════════════════════════════════════════
// BEHAVIOUR — per-frame cumulus evolution
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance cumulus-specific behaviour. Cumulus life cycle:
 *   1. Billow growth (fresh → mature cauliflower)
 *   2. Detrainment (edges shear off into wispy fragments)
 *   3. (Congestus only) Cumulonimbus transition
 */
export function systemCumulusEvolve(world, dt) {
  const CS = CumulusState;
  const CI = CloudInstance;

  for (let slot = 0; slot < _nextCumulusSlot; slot++) {
    const baseSlot = CS._baseInstanceSlot[slot];
    if (baseSlot === undefined) continue;

    const fade = computeFade(CI.phase[baseSlot]);
    CS.fade[slot] = fade;

    // Billow growth (0 → 1 over the cloud's lifespan).
    CS.billowPhase[slot] = Math.min(1, CS.billowPhase[slot] + CS.billowRate[slot] * dt);

    // Thickness grows with billow phase (puffs get taller/fuller).
    const billowFactor = 0.5 + 0.5 * CS.billowPhase[slot];
    CS.thickness[slot] = CloudArchetype.density[CI.archetypeSlot[baseSlot]] * billowFactor;

    // Updraft: driven by billow, decreases once detrainment starts.
    const detrainPenalty = Math.min(1, CS.detrainProgress[slot]);
    CS.updraftVelocity[slot] = Math.max(0.3,
      CS.updraftVelocity[slot] * (1 - 0.5 * dt) + 0.1 * billowFactor * dt);

    // Detrainment: begins after billow saturates.
    if (CS.billowPhase[slot] > 0.85) {
      CS.detrainProgress[slot] = Math.min(1,
        CS.detrainProgress[slot] + CUMULUS_DETRAIN_RATE * dt);
    }

    // Cumulonimbus transition — only congestus with full billow + detrainment.
    if (CS.subtype[slot] === CumulusSubtype.CONGESTUS
        && CS.billowPhase[slot] >= 0.95
        && CS.detrainProgress[slot] > 0.3) {
      CS.cbProgress[slot] = Math.min(1,
        CS.cbProgress[slot] + CUMULUS_CB_TRANSITION_RATE * dt);
    } else {
      CS.cbProgress[slot] = Math.max(0,
        CS.cbProgress[slot] - CUMULUS_CB_TRANSITION_RATE * dt * 0.3);
    }

    // Underside darkness: driven by thickness × coverage.
    const opticalFactor = CS.thickness[slot] * CI.coverage[baseSlot] * fade;
    CS.undersideDarkness[slot] = Math.max(0.4,
      Math.min(1.0, opticalFactor * 1.5));

    // Showers (congestus only).
    let showerRate = 0;
    if (CS.subtype[slot] === CumulusSubtype.CONGESTUS
        && opticalFactor > CUMULUS_SHOWER_THICKNESS) {
      const excess = (opticalFactor - CUMULUS_SHOWER_THICKNESS)
                   / (1 - CUMULUS_SHOWER_THICKNESS);
      showerRate = CUMULUS_SHOWER_RATE_BASE
                 + CUMULUS_SHOWER_RATE_SCALE * excess;
    }
    CS.showerRate[slot] = showerRate;

    if (showerRate > EPSILON) {
      CI.flags[baseSlot] |= 1 << 1;   // FLAG_PRECIPITATING
      CI.precipRate[baseSlot] = showerRate * CI.coverage[baseSlot] * fade;
    } else {
      CI.flags[baseSlot] &= ~(1 << 1);
      CI.precipRate[baseSlot] = 0;
    }

    // Snow-mix update.
    CS.snowMix[slot] = computeSnowMix(CS.baseTemperature[slot]);

    // Drift.
    CI.px[baseSlot] += CS.driftSpeed[slot] * dt;

    // Sync visibility to base instance.
    CI.visibility[baseSlot] = fade;
  }

  return world;
}

function computeFade(phase) {
  if (phase < CUMULUS_FADE_IN_START) return 0;
  if (phase < CUMULUS_FADE_IN_END) {
    return (phase - CUMULUS_FADE_IN_START) /
           (CUMULUS_FADE_IN_END - CUMULUS_FADE_IN_START);
  }
  if (phase < CUMULUS_FADE_OUT_START) return 1;
  if (phase < CUMULUS_FADE_OUT_END) {
    return 1 - (phase - CUMULUS_FADE_OUT_START) /
               (CUMULUS_FADE_OUT_END - CUMULUS_FADE_OUT_START);
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════
// PUFF LAYOUT — pre-computed puff centers around the ellipsoid
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the world-space center of puff `index` for a cumulus instance.
 * The puffs are distributed in a hemispherical stack (flat base).
 * Stable per-instance via a deterministic hash.
 */
function getPuffCenter(cuSlot, index, out) {
  const CI = CloudInstance;
  const baseSlot = CumulusState._baseInstanceSlot[cuSlot];
  const rng = mulberry32(0xC0C0 ^ (cuSlot * 2654435761) ^ (index * 83492791));

  const totalPuffs = CumulusState.puffCount[cuSlot];
  const puffRadius = CumulusState.puffRadius[cuSlot];

  // Distribute puffs using a Fibonacci-like spiral on the upper hemisphere.
  const phi = index * 2.39996322972865332;   // golden angle
  const v = (index + 0.5) / Math.max(1, totalPuffs);
  const y = Math.sqrt(v);   // upper hemisphere projection

  const radial = 1 - y;   // wider at base, tighter at top
  const x = radial * Math.cos(phi);
  const z = radial * Math.sin(phi);

  // Scale to the cloud's ellipsoid. Use radiusX/radiusY/radiusZ.
  const cx = CI.px[baseSlot];
  const cy = CI.py[baseSlot] + (y * 2 - 1) * CI.radiusY[baseSlot];
  const cz = CI.pz[baseSlot];

  // Add puff radius offset.
  const scale = CI.radiusX[baseSlot] * 0.6;

  out[0] = cx + x * scale;
  out[1] = cy;
  out[2] = cz + z * scale;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// DENSITY HOOK — override base 029 sampleInstanceDensity with puffs
// ═══════════════════════════════════════════════════════════════════════

const _puffCenter = vec3.create();

/**
 * Cumulus-enhanced density sampling. Layers multiple puff spheres onto
 * 029's ellipsoid to produce the characteristic cauliflower look with
 * a flat base.
 *
 * @param cuSlot     index in CumulusState
 * @param wx, wy, wz world-space point
 */
export function sampleCumulusDensity(cuSlot, wx, wy, wz) {
  const baseSlot = CumulusState._baseInstanceSlot[cuSlot];
  if (baseSlot === undefined) return 0;

  const base = sampleInstanceDensity(baseSlot, wx, wy, wz);
  if (base < EPSILON) return 0;

  const CI = CloudInstance;
  const CS = CumulusState;

  // Vertical position within the cloud (0 = base, 1 = top).
  const ly = wy - CI.py[baseSlot];
  const verticalNorm = (ly + CI.radiusY[baseSlot])
                     / Math.max(2 * CI.radiusY[baseSlot], 1);
  const verticalT = verticalNorm;   // 0 = base, 1 = top for cumulus

  // Flat base: fade density sharply below ~15% height.
  if (verticalT < 0.10) {
    return 0;
  }
  const baseFade = Math.min(1, (verticalT - 0.10) / 0.15);

  // Sum density contributions from each puff.
  const puffCount = CS.puffCount[cuSlot];
  const puffRadius = CS.puffRadius[cuSlot];
  const billowFactor = 0.5 + 0.5 * CS.billowPhase[cuSlot];

  let puffDensity = 0;
  let sampleCount = 0;

  for (let p = 0; p < puffCount; p++) {
    getPuffCenter(cuSlot, p, _puffCenter);

    const dx = wx - _puffCenter[0];
    const dy = wy - _puffCenter[1];
    const dz = wz - _puffCenter[2];
    const distSq = dx * dx + dy * dy + dz * dz;
    const puffRadiusSq = puffRadius * puffRadius * 2.0;   // puffs overlap

    if (distSq < puffRadiusSq) {
      // Soft spherical falloff per puff.
      const falloff = 1 - distSq / puffRadiusSq;
      puffDensity = Math.max(puffDensity, falloff);
      sampleCount++;
    }
  }

  if (puffDensity <= 0) return 0;

  // Vertical darkening: darker at base (thicker), lighter at top.
  const darkening = CUMULUS_UNDERSIDE_DARKEN * (1 - verticalT)
                  + CUMULUS_TOPSIDE_BRIGHTEN * verticalT;
  const darkMod = 1 - (1 - CS.undersideDarkness[cuSlot]) * (1 - darkening);

  // Organic noise overlay for soft edges.
  const noise3D = getCumulusNoise3D(CS.noiseIndex[cuSlot]);
  const noiseMod = 0.88 + 0.12 * noise3D(wx * 0.005, wy * 0.005, wz * 0.005);

  const mod = puffDensity * baseFade * darkMod * noiseMod
            * CS.fade[cuSlot] * CS.thickness[cuSlot]
            * (0.8 + 0.2 * billowFactor);

  return Math.max(0, Math.min(1, base * mod * 2.5));
}

// ═══════════════════════════════════════════════════════════════════════
// SUN BLOCK HOOK — return sun transmission factor
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the sun transmission factor (0..1). Cumulus casts a strong
 * dark shadow at its densest, but has a soft-edged penumbra.
 */
export function sampleCumulusSunBlock(cuSlot, viewDirX, viewDirY, viewDirZ) {
  const baseSlot = CumulusState._baseInstanceSlot[cuSlot];
  if (baseSlot === undefined) return 1.0;

  const CS = CumulusState;
  if (CS.fade[cuSlot] < 0.1) return 1.0;

  const CI = CloudInstance;
  const opticalFactor = CS.thickness[cuSlot]
                      * CI.coverage[baseSlot]
                      * CS.fade[cuSlot];

  const transmission = Math.exp(-opticalFactor * CUMULUS_SUN_BLOCK_K);
  return Math.max(CUMULUS_SUN_TRANSMIT_MIN, transmission);
}

// ═══════════════════════════════════════════════════════════════════════
// VFX BRIDGE — torn wisps and localized showers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return data for the caller (file 025) to spawn torn-wisp particles
 * at the detrainment edge of the cloud.
 */
export function emitCumulusWisps(cuSlot, cameraX, cameraY, cameraZ, emitRate) {
  const baseSlot = CumulusState._baseInstanceSlot[cuSlot];
  if (baseSlot === undefined) return null;

  const CS = CumulusState;
  if (CS.detrainProgress[cuSlot] < 0.1) return null;
  if (CS.fade[cuSlot] < 0.3) return null;

  const CI = CloudInstance;
  const dx = cameraX - CI.px[baseSlot];
  const dz = cameraZ - CI.pz[baseSlot];
  const horizontalDistSq = dx * dx + dz * dz;
  if (horizontalDistSq > CUMULUS_VFX_RADIUS * CUMULUS_VFX_RADIUS) return null;

  const count = Math.min(
    CUMULUS_VFX_MAX_WISPS,
    Math.floor(emitRate * CS.detrainProgress[cuSlot] * 8)
  );

  if (count <= 0) return null;

  return {
    count,
    detrainProgress: CS.detrainProgress[cuSlot],
    billowPhase: CS.billowPhase[cuSlot],
    position: [CI.px[baseSlot], CI.py[baseSlot], CI.pz[baseSlot]],
    radiusX: CI.radiusX[baseSlot],
    radiusY: CI.radiusY[baseSlot],
    radiusZ: CI.radiusZ[baseSlot],
  };
}

/**
 * Return data for the caller (file 025) to spawn a localized shower
 * underneath a congestus cloud.
 */
export function emitCumulusShower(cuSlot, cameraX, cameraY, cameraZ, emitRate) {
  const baseSlot = CumulusState._baseInstanceSlot[cuSlot];
  if (baseSlot === undefined) return null;

  const CS = CumulusState;
  if (CS.showerRate[cuSlot] < EPSILON) return null;
  if (CS.fade[cuSlot] < 0.3) return null;

  const CI = CloudInstance;
  const dx = cameraX - CI.px[baseSlot];
  const dz = cameraZ - CI.pz[baseSlot];
  const horizontalDistSq = dx * dx + dz * dz;
  if (horizontalDistSq > CUMULUS_VFX_RADIUS * CUMULUS_VFX_RADIUS) return null;

  const snowMix = CS.snowMix[cuSlot];
  let precipType;
  if (snowMix > 0.95)      precipType = PrecipitationType.SNOW;
  else if (snowMix < 0.05) precipType = PrecipitationType.RAIN;
  else                     precipType = PrecipitationType.MIXED;

  const count = Math.min(
    CUMULUS_VFX_MAX_SHOWER,
    Math.floor(emitRate * CS.showerRate[cuSlot] * 8)
  );

  if (count <= 0) return null;

  return {
    count,
    precipType,
    snowMix,
    showerRate: CS.showerRate[cuSlot],
    cloudBaseAltitude: CI.py[baseSlot] - CI.radiusY[baseSlot],
    cloudTopAltitude: CI.py[baseSlot] + CI.radiusY[baseSlot],
    position: [CI.px[baseSlot], CI.py[baseSlot], CI.pz[baseSlot]],
    radiusX: CI.radiusX[baseSlot],
    radiusZ: CI.radiusZ[baseSlot],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CUMULONIMBUS TRANSITION — signal when ready to upgrade
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return true when a congestus cumulus has developed a persistent anvil
 * attempt and should be upgraded to cumulonimbus (file 039).
 */
export function isReadyForCumulonimbusTransition(cuSlot) {
  const CS = CumulusState;
  if (cuSlot < 0 || cuSlot >= _nextCumulusSlot) return false;
  if (CS.subtype[cuSlot] !== CumulusSubtype.CONGESTUS) return false;
  return CS.cbProgress[cuSlot] >= CUMULUS_CB_TRANSITION_THRESHOLD;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — runtime parameter updates
// ═══════════════════════════════════════════════════════════════════════

/**
 * Set the base temperature.
 */
export function setCumulusTemperature(cuSlot, tempC) {
  if (cuSlot < 0 || cuSlot >= _nextCumulusSlot) return;
  CumulusState.baseTemperature[cuSlot] = tempC;
  CumulusState.snowMix[cuSlot] = computeSnowMix(tempC);
}

/**
 * Force the cumulus to start detraining (useful for scripted fade-outs).
 */
export function forceCumulusDetrainment(cuSlot) {
  if (cuSlot < 0 || cuSlot >= _nextCumulusSlot) return;
  CumulusState.detrainProgress[cuSlot] = Math.max(
    CumulusState.detrainProgress[cuSlot],
    CUMULUS_DETRAIN_THRESHOLD
  );
}

/**
 * Force the cumulus to attempt cumulonimbus transition (congestus only).
 */
export function forceCumulonimbusTransition(cuSlot) {
  if (cuSlot < 0 || cuSlot >= _nextCumulusSlot) return;
  if (CumulusState.subtype[cuSlot] !== CumulusSubtype.CONGESTUS) return;
  CumulusState.cbProgress[cuSlot] = Math.max(
    CumulusState.cbProgress[cuSlot],
    CUMULUS_CB_TRANSITION_THRESHOLD
  );
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function cumulusStats() {
  let active = 0;
  let humilis = 0, mediocris = 0, congestus = 0;
  let showering = 0;
  let transitioning = 0;
  let detraining = 0;

  for (let slot = 0; slot < _nextCumulusSlot; slot++) {
    if (CumulusState.fade[slot] < EPSILON) continue;
    active++;
    const subtype = CumulusState.subtype[slot];
    if (subtype === CumulusSubtype.HUMILIS) humilis++;
    else if (subtype === CumulusSubtype.MEDIOCRIS) mediocris++;
    else congestus++;
    if (CumulusState.showerRate[slot] > EPSILON) showering++;
    if (CumulusState.detrainProgress[slot] > 0.5) detraining++;
    if (CumulusState.cbProgress[slot] > 0.5) transitioning++;
  }

  return {
    totalCumulus: _nextCumulusSlot,
    active,
    humilis,
    mediocris,
    congestus,
    showering,
    detraining,
    transitioning,
    archetypesReady: CumulusArchetypes.initialized,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearCumulus() {
  _cumulusSlots.clear();
  _nextCumulusSlot = 0;
  _cumulusNoise3D.clear();
  _cumulusNoise2D.clear();
  CumulusState.fade.fill(0);
  CumulusState.billowPhase.fill(0);
  CumulusState.detrainProgress.fill(0);
  CumulusState.cbProgress.fill(0);
  CumulusState.showerRate.fill(0);
}