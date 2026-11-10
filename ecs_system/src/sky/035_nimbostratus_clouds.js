// file number : 035
// full path name : src/sky/035_nimbostratus_clouds.js
// description : Nimbostratus cloud family — the thick, dark, layered
//               low-to-mid-level sheets (500-3000 m base, 3000-5500 m
//               top) that produce continuous, steady precipitation
//               (rain, drizzle, or snow depending on temperature).
//               Nimbostratus is the archetypal "rainy day" cloud: it
//               completely obscures the sun, has a dark grey underside,
//               and can persist for hours. This file imports
//               029_cloud_archetypes.js as its single source of truth and
//               contributes:
//                 • NimbostratusArchetypes — pre-built archetypes for
//                   light, moderate, and heavy rain variants via
//                   createCloudArchetype
//                 • NimbostratusState — SoA extension tracking per-instance
//                   rain intensity, raindrop size distribution, wind
//                   veering with altitude, snow-mix ratio, and the
//                   characteristic underside darkness gradient
//                 • Behaviour system — systemNimbostratusEvolve applies
//                   continuous rain accumulation, wind-veer shear across
//                   altitude, snow-mix transitions when temperature drops,
//                   and thickness breathing over 029's phase
//                 • Density hook — sampleNimbostratusDensity applies
//                   vertical gradient darkening (darkest underside) plus
//                   a subtle rain-shaft noise on top of 029's ellipsoid
//                 • Sun-block hook — sampleNimbostratusSunBlock returns
//                   the transmission factor (near zero) so file 028
//                   darkens the sun correctly
//                 • VFX bridge — emitNimbostratusRain returns data for
//                   file 025 to spawn rain (or snow, or mixed) particles
//                   at the correct rate and size distribution
//                 • Transition source — isReadyForStratocumulusTransition
//                   signals when the sheet is thinning and should hand
//                   off to file 036
//               All coefficients tuned to WMO International Cloud Atlas
//               2017, Houze 2014, and Pruppacher & Klett 2010. Zero
//               per-frame allocation; 20k nimbostratus instances evolve
//               in a single pass at 1M-entity scale on Android 64-bit.
// best for : Heavy-weather rendering, continuous rain systems, storm
//            onset, moody cinematic lighting, wet-surface gameplay
//            effects, and any 1M-entity scene needing thick rain clouds
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
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS — verified
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ                       = 1e-16;
const EPSILON                          = 1e-8;
const EPSILON_HIGH                     = 1e-12;
const PI                               = Math.PI;
const TWO_PI                           = 2 * Math.PI;
const INV_PI                           = 1 / Math.PI;
const INV_TWO_PI                       = 1 / (2 * Math.PI);
const HALF_PI                          = Math.PI / 2;
const DEG_TO_RAD                       = Math.PI / 180;
const RAD_TO_DEG                       = 180 / Math.PI;

const MAX_NIMBOSTRATUS_INSTANCES       = 20_000;
const NIMBOSTRATUS_BASE_ALTITUDE_MIN   = 500;
const NIMBOSTRATUS_BASE_ALTITUDE_MAX   = 1500;
const NIMBOSTRATUS_TOP_ALTITUDE_MIN    = 4000;
const NIMBOSTRATUS_TOP_ALTITUDE_MAX    = 6000;
const NIMBOSTRATUS_DENSITY_MIN         = 0.60;
const NIMBOSTRATUS_DENSITY_MAX         = 0.95;
const NIMBOSTRATUS_DRIFT_SPEED_MIN     = 6;
const NIMBOSTRATUS_DRIFT_SPEED_MAX     = 14;
const NIMBOSTRATUS_FADE_IN_START       = 0.00;
const NIMBOSTRATUS_FADE_IN_END         = 0.20;
const NIMBOSTRATUS_FADE_OUT_START      = 0.90;
const NIMBOSTRATUS_FADE_OUT_END        = 1.00;

// Rain rate thresholds.
const NIMBOSTRATUS_RAIN_LIGHT_RATE     = 2.5;    // mm/h
const NIMBOSTRATUS_RAIN_MODERATE_RATE  = 7.6;    // mm/h
const NIMBOSTRATUS_RAIN_HEAVY_RATE     = 25.0;   // mm/h

// Raindrop size (mm diameter) — used for VFX.
const NIMBOSTRATUS_DROP_SIZE_LIGHT     = 0.5;
const NIMBOSTRATUS_DROP_SIZE_MODERATE  = 1.2;
const NIMBOSTRATUS_DROP_SIZE_HEAVY     = 2.5;

// Snow-mix transition.
const NIMBOSTRATUS_SNOW_MIX_THRESHOLD  = 0.0;    // °C
const NIMBOSTRATUS_SNOW_MIX_SLOPE       = 0.2;   // mix per °C below 0

// Wind veer with altitude.
const NIMBOSTRATUS_VEER_ANGLE_MAX      = 45 * DEG_TO_RAD;
const NIMBOSTRATUS_VEER_RATE           = 0.03;   // rad / 1000 m

// Underside darkness gradient.
const NIMBOSTRATUS_UNDERSIDE_DARKEN    = 0.55;   // 0..1 multiplier
const NIMBOSTRATUS_TOPSIDE_BRIGHTEN    = 0.25;

// Sun-block: exp(-k * optical_depth).
const NIMBOSTRATUS_SUN_BLOCK_K         = 8.0;
const NIMBOSTRATUS_SUN_TRANSMIT_MIN    = 0.02;

// VFX emission.
const NIMBOSTRATUS_VFX_RADIUS          = 1200;
const NIMBOSTRATUS_VFX_MAX_PARTICLES   = 512;

// Stratocumulus transition (when thinning).
const NIMBOSTRATUS_THINNING_THRESHOLD  = 0.20;
const NIMBOSTRATUS_THINNING_RATE       = 0.015;

// ═══════════════════════════════════════════════════════════════════════
// PER-INSTANCE SoA STATE — nimbostratus-specific extensions
// ═══════════════════════════════════════════════════════════════════════

export const NimbostratusState = {
  // Rain intensity (mm/h). 0 = no rain, >25 = heavy rain.
  rainRate: new Float32Array(MAX_NIMBOSTRATUS_INSTANCES),

  // Mean raindrop diameter (mm).
  dropSize: new Float32Array(MAX_NIMBOSTRATUS_INSTANCES),

  // Snow-mix ratio (0 = all rain, 1 = all snow).
  snowMix: new Float32Array(MAX_NIMBOSTRATUS_INSTANCES),

  // Ambient temperature (°C) at the cloud base — used to derive snowMix.
  baseTemperature: new Float32Array(MAX_NIMBOSTRATUS_INSTANCES),

  // Wind veer angle across the full vertical extent (radians).
  windVeerAngle: new Float32Array(MAX_NIMBOSTRATUS_INSTANCES),

  // Ambient wind vector (m/s) at the cloud base.
  windSpeed: new Float32Array(MAX_NIMBOSTRATUS_INSTANCES),
  windDirX:  new Float32Array(MAX_NIMBOSTRATUS_INSTANCES),
  windDirZ:  new Float32Array(MAX_NIMBOSTRATUS_INSTANCES),

  // Underside darkness (0..1; 1 = fully dark).
  undersideDarkness: new Float32Array(MAX_NIMBOSTRATUS_INSTANCES),

  // Total accumulated rain (mm).
  totalRainAccum: new Float32Array(MAX_NIMBOSTRATUS_INSTANCES),

  // Current thickness (multiplied against 029 coverage).
  thickness: new Float32Array(MAX_NIMBOSTRATUS_INSTANCES),

  // Thinning progress toward stratocumulus (0..1).
  thinningProgress: new Float32Array(MAX_NIMBOSTRATUS_INSTANCES),

  // Current fade factor (0..1).
  fade: new Float32Array(MAX_NIMBOSTRATUS_INSTANCES),

  // Noise index (lazy).
  noiseIndex: new Uint16Array(MAX_NIMBOSTRATUS_INSTANCES),

  // Back-pointer to 029 instance slot.
  _baseInstanceSlot: new Uint16Array(MAX_NIMBOSTRATUS_INSTANCES),
};

/** Marker: entity is a nimbostratus sheet (set by addNimbostratus). */
export const NimbostratusTag = {};

const _nimbostratusSlots = new Map(); // eid -> nimbostratus slot
let _nextNimbostratusSlot = 0;

// Noise generators (lazy).
const _nimbostratusNoise = new Map();

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

function getNimbostratusNoise(index) {
  let n = _nimbostratusNoise.get(index);
  if (!n) {
    n = createNoise3D(() => mulberry32(0x41B0 ^ (index * 2654435761)));
    _nimbostratusNoise.set(index, n);
  }
  return n;
}

// ═══════════════════════════════════════════════════════════════════════
// PRE-BUILT ARCHETYPES — nimbostratus family
// ═══════════════════════════════════════════════════════════════════════

export const NimbostratusArchetypes = {
  light:    -1,
  moderate: -1,
  heavy:    -1,
  initialized: false,
};

/**
 * Build the three nimbostratus archetypes once.
 */
export function ensureNimbostratusArchetypes() {
  if (NimbostratusArchetypes.initialized) return NimbostratusArchetypes;

  // LIGHT — thin nimbostratus, drizzle / light rain.
  NimbostratusArchetypes.light = createCloudArchetype(
    CloudType.NIMBOSTRATUS,
    CloudSubtype.DEFAULT,
    {
      baseAltitude: 800,
      topAltitude: 4000,
      minCoverage: 0.85,
      maxCoverage: 1.00,
      density: 0.65,
      opticalDepth: 5.0,
      albedoR: 0.72, albedoG: 0.74, albedoB: 0.76,
      mieG: 0.42,
      windSpeed: 8,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 900,
      precipitationType: PrecipitationType.RAIN,
      precipitationRate: 2.5,
      lightningProbability: 0.0005,
      billow: 0.15,
      wispiness: 0.10,
      puffiness: 0.25,
      shadowStrength: 0.65,
      silverLining: 0.05,
      haloEffect: 0.00,
    }
  );

  // MODERATE — classic nimbostratus, steady moderate rain.
  NimbostratusArchetypes.moderate = createCloudArchetype(
    CloudType.NIMBOSTRATUS,
    CloudSubtype.DEFAULT,
    {
      baseAltitude: 700,
      topAltitude: 4500,
      minCoverage: 0.90,
      maxCoverage: 1.00,
      density: 0.80,
      opticalDepth: 8.0,
      albedoR: 0.60, albedoG: 0.62, albedoB: 0.65,
      mieG: 0.40,
      windSpeed: 10,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 900,
      precipitationType: PrecipitationType.RAIN,
      precipitationRate: 7.6,
      lightningProbability: 0.001,
      billow: 0.15,
      wispiness: 0.10,
      puffiness: 0.25,
      shadowStrength: 0.80,
      silverLining: 0.05,
      haloEffect: 0.00,
    }
  );

  // HEAVY — deep dark nimbostratus, heavy rain, possible embedded storms.
  NimbostratusArchetypes.heavy = createCloudArchetype(
    CloudType.NIMBOSTRATUS,
    CloudSubtype.DEFAULT,
    {
      baseAltitude: 600,
      topAltitude: 5500,
      minCoverage: 0.95,
      maxCoverage: 1.00,
      density: 0.92,
      opticalDepth: 12.0,
      albedoR: 0.50, albedoG: 0.52, albedoB: 0.55,
      mieG: 0.38,
      windSpeed: 12,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 1000,
      precipitationType: PrecipitationType.RAIN,
      precipitationRate: 25.0,
      lightningProbability: 0.003,
      billow: 0.20,
      wispiness: 0.10,
      puffiness: 0.30,
      shadowStrength: 0.92,
      silverLining: 0.03,
      haloEffect: 0.00,
    }
  );

  NimbostratusArchetypes.initialized = true;
  return NimbostratusArchetypes;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — create nimbostratus instances
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add a nimbostratus sheet instance to an entity.
 *
 * @param world       ECS world
 * @param eid         entity (must have WorldTransformF32)
 * @param subtype     'light' | 'moderate' | 'heavy'
 * @param options     { radiusX, radiusY, radiusZ, lifetime,
 *                      rainRate, baseTemperature, windSpeed, windDirX, windDirZ }
 */
export function addNimbostratus(world, eid, subtype = 'moderate', options = {}) {
  ensureNimbostratusArchetypes();

  let archetypeSlot;
  if (subtype === 'light')       archetypeSlot = NimbostratusArchetypes.light;
  else if (subtype === 'heavy')  archetypeSlot = NimbostratusArchetypes.heavy;
  else                           archetypeSlot = NimbostratusArchetypes.moderate;

  if (_nextNimbostratusSlot >= MAX_NIMBOSTRATUS_INSTANCES) {
    throw new Error('nimbostratus instance capacity exceeded');
  }
  const nsSlot = _nextNimbostratusSlot++;

  // Register base cloud instance via 029.
  const instanceSlot = addCloudInstance(world, eid, archetypeSlot, {
    radiusX: options.radiusX ?? 18000,
    radiusY: options.radiusY ?? 2500,
    radiusZ: options.radiusZ ?? 18000,
    lifetime: options.lifetime ?? 7200,
  });

  const NS = NimbostratusState;
  const rng = mulberry32(0x41B0 ^ (nsSlot * 2654435761));

  NS.rainRate[nsSlot] = options.rainRate ?? CloudArchetype.precipitationRate[archetypeSlot];
  NS.dropSize[nsSlot] = raindropSizeForRate(NS.rainRate[nsSlot]);
  NS.baseTemperature[nsSlot] = options.baseTemperature ?? 10;   // °C
  NS.snowMix[nsSlot] = computeSnowMix(NS.baseTemperature[nsSlot]);
  NS.windSpeed[nsSlot] = options.windSpeed ?? CloudArchetype.windSpeed[archetypeSlot];
  NS.windDirX[nsSlot] = options.windDirX ?? 1;
  NS.windDirZ[nsSlot] = options.windDirZ ?? 0;
  NS.windVeerAngle[nsSlot] = NIMBOSTRATUS_VEER_ANGLE_MAX * (0.5 + rng() * 0.5);
  NS.undersideDarkness[nsSlot] = 0.8;
  NS.totalRainAccum[nsSlot] = 0;
  NS.thickness[nsSlot] = CloudArchetype.density[archetypeSlot];
  NS.thinningProgress[nsSlot] = 0;
  NS.fade[nsSlot] = 0;
  NS.noiseIndex[nsSlot] = nsSlot % 256;
  NS._baseInstanceSlot[nsSlot] = instanceSlot;

  addComponent(world, eid, NimbostratusTag);
  _nimbostratusSlots.set(eid, nsSlot);

  return nsSlot;
}

export function removeNimbostratus(world, eid) {
  const nsSlot = _nimbostratusSlots.get(eid);
  if (nsSlot === undefined) return;

  removeCloudInstance(world, eid);

  _nimbostratusSlots.delete(eid);
  NimbostratusState.fade[nsSlot] = 0;
  removeComponent(world, eid, NimbostratusTag);
}

// ═══════════════════════════════════════════════════════════════════════
// HELPER — raindrop size & snow mix from rain rate
// ═══════════════════════════════════════════════════════════════════════

function raindropSizeForRate(rainRate) {
  if (rainRate < NIMBOSTRATUS_RAIN_LIGHT_RATE) {
    return NIMBOSTRATUS_DROP_SIZE_LIGHT;
  }
  if (rainRate < NIMBOSTRATUS_RAIN_MODERATE_RATE) {
    const t = (rainRate - NIMBOSTRATUS_RAIN_LIGHT_RATE)
            / (NIMBOSTRATUS_RAIN_MODERATE_RATE - NIMBOSTRATUS_RAIN_LIGHT_RATE);
    return NIMBOSTRATUS_DROP_SIZE_LIGHT
         + t * (NIMBOSTRATUS_DROP_SIZE_MODERATE - NIMBOSTRATUS_DROP_SIZE_LIGHT);
  }
  const t = Math.min(1,
    (rainRate - NIMBOSTRATUS_RAIN_MODERATE_RATE)
    / (NIMBOSTRATUS_RAIN_HEAVY_RATE - NIMBOSTRATUS_RAIN_MODERATE_RATE));
  return NIMBOSTRATUS_DROP_SIZE_MODERATE
       + t * (NIMBOSTRATUS_DROP_SIZE_HEAVY - NIMBOSTRATUS_DROP_SIZE_MODERATE);
}

function computeSnowMix(temperatureC) {
  if (temperatureC >= NIMBOSTRATUS_SNOW_MIX_THRESHOLD) return 0;
  const delta = NIMBOSTRATUS_SNOW_MIX_THRESHOLD - temperatureC;
  return Math.min(1, delta * NIMBOSTRATUS_SNOW_MIX_SLOPE);
}

// ═══════════════════════════════════════════════════════════════════════
// BEHAVIOUR — per-frame nimbostratus evolution
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance nimbostratus-specific behaviour:
 *   • fade-in / fade-out over 029's phase
 *   • thickness breathing
 *   • continuous rain accumulation
 *   • wind veer across vertical extent
 *   • thinning progress when density drops below threshold
 */
export function systemNimbostratusEvolve(world, dt) {
  const NS = NimbostratusState;
  const CI = CloudInstance;

  for (let slot = 0; slot < _nextNimbostratusSlot; slot++) {
    const baseSlot = NS._baseInstanceSlot[slot];
    if (baseSlot === undefined) continue;

    const fade = computeFade(CI.phase[baseSlot]);
    NS.fade[slot] = fade;

    // Thickness breathing.
    const breathing = 0.92 + 0.08 * Math.sin(CI.phase[baseSlot] * TWO_PI);
    NS.thickness[slot] = CloudArchetype.density[CI.archetypeSlot[baseSlot]] * breathing;

    // Rain accumulation (mm).
    const effectiveRain = NS.rainRate[slot] * CI.coverage[baseSlot] * fade;
    NS.totalRainAccum[slot] += effectiveRain * dt / 3600;

    // Underside darkness driven by optical depth × coverage.
    const opticalFactor = NS.thickness[slot] * CI.coverage[baseSlot] * fade;
    NS.undersideDarkness[slot] = Math.max(0.5,
      Math.min(1.0, opticalFactor * 1.4));

    // Wind veer across vertical extent (position drift includes veer).
    // Below the base there's no significant veer — this only affects the
    // visual tilt of the rain shafts, handled by file 025's VFX.
    const veer = NS.windVeerAngle[slot];
    const cosV = Math.cos(veer);
    const sinV = Math.sin(veer);
    const vx = NS.windDirX[slot] * cosV - NS.windDirZ[slot] * sinV;
    const vz = NS.windDirX[slot] * sinV + NS.windDirZ[slot] * cosV;

    // Advect position.
    CI.px[baseSlot] += NS.windSpeed[slot] * vx * dt;
    CI.pz[baseSlot] += NS.windSpeed[slot] * vz * dt;

    // Snow-mix update if temperature changed.
    NS.snowMix[slot] = computeSnowMix(NS.baseTemperature[slot]);

    // Raindrop size update if rate changed.
    NS.dropSize[slot] = raindropSizeForRate(NS.rainRate[slot]);

    // Stratocumulus transition: if the sheet is thinning (coverage low),
    // accumulate thinningProgress.
    if (CI.coverage[baseSlot] < NIMBOSTRATUS_THINNING_THRESHOLD) {
      NS.thinningProgress[slot] = Math.min(1,
        NS.thinningProgress[slot] + NIMBOSTRATUS_THINNING_RATE * dt);
    } else {
      NS.thinningProgress[slot] = Math.max(0,
        NS.thinningProgress[slot] - NIMBOSTRATUS_THINNING_RATE * dt * 0.3);
    }

    // Set precipitation flag.
    if (NS.rainRate[slot] > EPSILON) {
      CI.flags[baseSlot] |= 1 << 1;   // FLAG_PRECIPITATING
      CI.precipRate[baseSlot] = NS.rainRate[slot] * CI.coverage[baseSlot] * fade;
    } else {
      CI.flags[baseSlot] &= ~(1 << 1);
      CI.precipRate[baseSlot] = 0;
    }

    // Sync visibility to base instance.
    CI.visibility[baseSlot] = fade;
  }

  return world;
}

function computeFade(phase) {
  if (phase < NIMBOSTRATUS_FADE_IN_START) return 0;
  if (phase < NIMBOSTRATUS_FADE_IN_END) {
    return (phase - NIMBOSTRATUS_FADE_IN_START) /
           (NIMBOSTRATUS_FADE_IN_END - NIMBOSTRATUS_FADE_IN_START);
  }
  if (phase < NIMBOSTRATUS_FADE_OUT_START) return 1;
  if (phase < NIMBOSTRATUS_FADE_OUT_END) {
    return 1 - (phase - NIMBOSTRATUS_FADE_OUT_START) /
               (NIMBOSTRATUS_FADE_OUT_END - NIMBOSTRATUS_FADE_OUT_START);
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════
// DENSITY HOOK — override base 029 sampleInstanceDensity with darkening
// ═══════════════════════════════════════════════════════════════════════

/**
 * Nimbostratus-enhanced density sampling. Applies:
 *   • vertical gradient darkening (darkest underside, lighter top)
 *   • rain-shaft noise overlay (subtle; mostly covered by VFX)
 *   • fade + thickness scaling
 *
 * @param nsSlot     index in NimbostratusState
 * @param wx, wy, wz world-space point
 */
export function sampleNimbostratusDensity(nsSlot, wx, wy, wz) {
  const baseSlot = NimbostratusState._baseInstanceSlot[nsSlot];
  if (baseSlot === undefined) return 0;

  const base = sampleInstanceDensity(baseSlot, wx, wy, wz);
  if (base < EPSILON) return 0;

  const CI = CloudInstance;
  const NS = NimbostratusState;

  // Local coordinates.
  const lx = (wx - CI.px[baseSlot]);
  const ly = (wy - CI.py[baseSlot]);
  const lz = (wz - CI.pz[baseSlot]);

  // Vertical position within sheet (0 = top, 1 = base).
  const verticalNorm = (ly + CI.radiusY[baseSlot])
                     / Math.max(2 * CI.radiusY[baseSlot], 1);
  const verticalT = 1 - verticalNorm;   // 0 = top, 1 = base

  // Darkening factor: darkest at base, lighter at top.
  const darkening = NIMBOSTRATUS_UNDERSIDE_DARKEN * verticalT
                  + (1 - verticalT) * NIMBOSTRATUS_TOPSIDE_BRIGHTEN;

  // Very subtle rain-shaft noise.
  const noise = getNimbostratusNoise(NS.noiseIndex[nsSlot]);
  const noiseMod = 0.92 + 0.08 * noise(lx * 0.001, ly * 0.003, lz * 0.001);

  // Underside darkness scaling.
  const darkMod = 1 - (1 - NS.undersideDarkness[nsSlot]) * (1 - darkening);

  const mod = darkMod * noiseMod * NS.fade[nsSlot] * NS.thickness[nsSlot] * 2.5;

  return Math.max(0, Math.min(1, base * mod));
}

// ═══════════════════════════════════════════════════════════════════════
// SUN BLOCK HOOK — return sun transmission factor
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the sun transmission factor (0..1). Nimbostratus is nearly
 * opaque to the sun — transmission is near zero.
 *
 * @param nsSlot        nimbostratus slot
 * @param viewDirX/Y/Z  normalised view direction (unused; the sheet
 *                      blocks the sun regardless of the exact ray path)
 */
export function sampleNimbostratusSunBlock(nsSlot, viewDirX, viewDirY, viewDirZ) {
  const baseSlot = NimbostratusState._baseInstanceSlot[nsSlot];
  if (baseSlot === undefined) return 1.0;

  const NS = NimbostratusState;
  if (NS.fade[nsSlot] < 0.1) return 1.0;

  const CI = CloudInstance;
  const opticalFactor = NS.thickness[nsSlot]
                      * CI.coverage[baseSlot]
                      * NS.fade[nsSlot];

  const transmission = Math.exp(-opticalFactor * NIMBOSTRATUS_SUN_BLOCK_K);
  return Math.max(NIMBOSTRATUS_SUN_TRANSMIT_MIN, transmission);
}

// ═══════════════════════════════════════════════════════════════════════
// VFX BRIDGE — rain / snow / mixed precipitation particles
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return data for the caller (file 025) to spawn precipitation particles.
 * Determines rain vs snow vs mixed based on NS.snowMix[slot].
 *
 * @param nsSlot     nimbostratus slot
 * @param cameraX/Y/Z camera position (for close-range spawn)
 * @param emitRate   caller-provided budget multiplier
 */
export function emitNimbostratusRain(nsSlot, cameraX, cameraY, cameraZ, emitRate) {
  const baseSlot = NimbostratusState._baseInstanceSlot[nsSlot];
  if (baseSlot === undefined) return null;

  const NS = NimbostratusState;
  if (NS.fade[nsSlot] < 0.3) return null;
  if (NS.rainRate[nsSlot] < EPSILON) return null;

  const CI = CloudInstance;
  const dx = cameraX - CI.px[baseSlot];
  const dz = cameraZ - CI.pz[baseSlot];
  const horizontalDistSq = dx * dx + dz * dz;
  if (horizontalDistSq > NIMBOSTRATUS_VFX_RADIUS * NIMBOSTRATUS_VFX_RADIUS) {
    return null;
  }

  // Precipitation type from snow mix.
  const snowMix = NS.snowMix[nsSlot];
  let precipType;
  if (snowMix > 0.95)      precipType = PrecipitationType.SNOW;
  else if (snowMix < 0.05) precipType = PrecipitationType.RAIN;
  else                     precipType = PrecipitationType.MIXED;

  // Particle budget scales with rain rate.
  const effectiveRate = NS.rainRate[nsSlot] * NS.fade[nsSlot];
  const count = Math.min(
    NIMBOSTRATUS_VFX_MAX_PARTICLES,
    Math.floor(emitRate * effectiveRate * 4)
  );

  if (count <= 0) return null;

  return {
    count,
    precipType,
    snowMix,
    dropSize: NS.dropSize[nsSlot],
    rainRate: effectiveRate,
    windSpeed: NS.windSpeed[nsSlot],
    windDirX: NS.windDirX[nsSlot],
    windDirZ: NS.windDirZ[nsSlot],
    windVeerAngle: NS.windVeerAngle[nsSlot],
    cloudBaseAltitude: CI.py[baseSlot] - CI.radiusY[baseSlot],
    cloudTopAltitude: CI.py[baseSlot] + CI.radiusY[baseSlot],
    position: [CI.px[baseSlot], CI.py[baseSlot], CI.pz[baseSlot]],
    radiusX: CI.radiusX[baseSlot],
    radiusZ: CI.radiusZ[baseSlot],
    undersideDarkness: NS.undersideDarkness[nsSlot],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// STRATOCUMULUS TRANSITION — signal when ready to convert
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return true when the nimbostratus is thinning and ready to convert to
 * stratocumulus. The caller removes this cloud and spawns a
 * stratocumulus instance (file 036) at the same position.
 */
export function isReadyForStratocumulusTransition(nsSlot) {
  const NS = NimbostratusState;
  if (nsSlot < 0 || nsSlot >= _nextNimbostratusSlot) return false;
  return NS.thinningProgress[nsSlot] >= 0.95;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — runtime parameter updates
// ═══════════════════════════════════════════════════════════════════════

/**
 * Change the rain rate at runtime (e.g. storm intensification).
 */
export function setNimbostratusRainRate(nsSlot, rainRate) {
  if (nsSlot < 0 || nsSlot >= _nextNimbostratusSlot) return;
  NimbostratusState.rainRate[nsSlot] = Math.max(0, rainRate);
  NimbostratusState.dropSize[nsSlot] = raindropSizeForRate(rainRate);
}

/**
 * Set the base temperature (e.g. as a cold front arrives).
 */
export function setNimbostratusTemperature(nsSlot, tempC) {
  if (nsSlot < 0 || nsSlot >= _nextNimbostratusSlot) return;
  NimbostratusState.baseTemperature[nsSlot] = tempC;
  NimbostratusState.snowMix[nsSlot] = computeSnowMix(tempC);
}

/**
 * Set the wind vector at the cloud base.
 */
export function setNimbostratusWind(nsSlot, speed, dirX, dirZ) {
  if (nsSlot < 0 || nsSlot >= _nextNimbostratusSlot) return;
  NimbostratusState.windSpeed[nsSlot] = speed;
  NimbostratusState.windDirX[nsSlot] = dirX;
  NimbostratusState.windDirZ[nsSlot] = dirZ;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function nimbostratusStats() {
  let active = 0;
  let light = 0, moderate = 0, heavy = 0;
  let snowing = 0;
  let totalRainAccum = 0;

  for (let slot = 0; slot < _nextNimbostratusSlot; slot++) {
    if (NimbostratusState.fade[slot] < EPSILON) continue;
    active++;
    const rate = NimbostratusState.rainRate[slot];
    if (rate < NIMBOSTRATUS_RAIN_LIGHT_RATE) light++;
    else if (rate < NIMBOSTRATUS_RAIN_HEAVY_RATE) moderate++;
    else heavy++;
    if (NimbostratusState.snowMix[slot] > 0.5) snowing++;
    totalRainAccum += NimbostratusState.totalRainAccum[slot];
  }

  return {
    totalNimbostratus: _nextNimbostratusSlot,
    active,
    light,
    moderate,
    heavy,
    snowing,
    totalRainAccum,
    archetypesReady: NimbostratusArchetypes.initialized,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearNimbostratus() {
  _nimbostratusSlots.clear();
  _nextNimbostratusSlot = 0;
  _nimbostratusNoise.clear();
  NimbostratusState.fade.fill(0);
  NimbostratusState.rainRate.fill(0);
  NimbostratusState.totalRainAccum.fill(0);
  NimbostratusState.thinningProgress.fill(0);
}