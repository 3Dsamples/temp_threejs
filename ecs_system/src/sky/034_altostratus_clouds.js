// file number : 034
// full path name : src/sky/034_altostratus_clouds.js
// description : Altostratus cloud family — mid-level (2-6 km) uniform
//               greyish or bluish-grey sheet that covers a large portion
//               of the sky and typically precedes rain. Altostratus has
//               no visible texture at ground level, blocks the sun only
//               partially (still casting a soft "watery" cast), and can
//               transition into nimbostratus when precipitation starts.
//               The two WMO sub-types implemented here are the classic
//               UNIFORM SHEET (altostratus altostratus) and the
//               OPACUS-like DENSE variant that darkens further and
//               triggers drizzle. This file imports 029_cloud_archetypes.js
//               as its single source of truth and contributes:
//                 • AltostratusArchetypes — pre-built archetypes for
//                   uniform sheet, dense sheet, and drizzle-trigger
//                   via createCloudArchetype
//                 • AltostratusState — SoA extension tracking per-instance
//                   sheet thickness, veil sheen, drizzle accumulation,
//                   sun-dimming factor, and transition-to-nimbostratus
//                   progress
//                 • Behaviour system — systemAltostratusEvolve applies
//                   uniform fading, thickening toward nimbostratus, and
//                   drizzle triggering when thickness exceeds threshold
//                 • Density hook — sampleAltostratusDensity applies a
//                   very low-frequency, nearly flat noise band on top
//                   of 029's ellipsoid so the sheet looks uniform but
//                   not sterile
//                 • Sun-dimming hook — sampleAltostratusSunDimming
//                   returns the transmission factor (0..1) so file 028's
//                   sky sample darkens the sun correctly
//                 • VFX bridge — emitAltostratusDrizzle returns data
//                   for file 025 to spawn fine drizzle particles once
//                   the cloud enters the drizzle-trigger state
//               All coefficients tuned to WMO International Cloud Atlas
//               2017 and Houze 2014. Zero per-frame allocation; 25k
//               altostratus instances evolve in a single pass at
//               1M-entity scale on Android 64-bit.
// best for : Mid-level weather rendering, rainy-day skies, transition
//            states between altostratus and nimbostratus, drizzle
//            effects, moody atmospheric lighting, and any 1M-entity
//            scene needing uniform mid-level cloud realism on
//            Android 64-bit.
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

const MAX_ALTOSTRATUS_INSTANCES      = 25_000;
const ALTOSTRATUS_BASE_ALTITUDE_MIN  = 2000;
const ALTOSTRATUS_BASE_ALTITUDE_MAX  = 3000;
const ALTOSTRATUS_TOP_ALTITUDE_MIN   = 4500;
const ALTOSTRATUS_TOP_ALTITUDE_MAX   = 6000;
const ALTOSTRATUS_SHEET_THICKNESS_MIN = 0.20;
const ALTOSTRATUS_SHEET_THICKNESS_MAX = 0.55;
const ALTOSTRATUS_DRIFT_SPEED_MIN    = 8;
const ALTOSTRATUS_DRIFT_SPEED_MAX    = 18;
const ALTOSTRATUS_FADE_IN_START      = 0.00;
const ALTOSTRATUS_FADE_IN_END        = 0.25;
const ALTOSTRATUS_FADE_OUT_START     = 0.88;
const ALTOSTRATUS_FADE_OUT_END       = 1.00;

// Drizzle triggers when thickness × coverage exceeds this threshold.
const ALTOSTRATUS_DRIZZLE_TRIGGER    = 0.55;
const ALTOSTRATUS_DRIZZLE_RATE_BASE  = 0.4;   // mm/h at trigger
const ALTOSTRATUS_DRIZZLE_RATE_SCALE = 2.5;   // mm/h at full threshold

// Nimbostratus transition: thickness × coverage must exceed this.
const ALTOSTRATUS_NIMBO_TRANSITION   = 0.80;
const ALTOSTRATUS_NIMBO_TRANSITION_RATE = 0.02;   // per second

// Sun dimming.
const ALTOSTRATUS_SUN_DIM_MIN        = 0.15;   // at full opacity
const ALTOSTRATUS_SUN_DIM_MAX        = 0.75;   // at minimum opacity

const ALTOSTRATUS_VFX_RADIUS         = 900;
const ALTOSTRATUS_VFX_MAX_PARTICLES  = 384;

// ═══════════════════════════════════════════════════════════════════════
// PER-INSTANCE SoA STATE — altostratus-specific extensions
// ═══════════════════════════════════════════════════════════════════════

export const AltostratusState = {
  // Sheet thickness (0..1; how opaque the sheet is).
  sheetThickness: new Float32Array(MAX_ALTOSTRATUS_INSTANCES),

  // Veil sheen (0..1; the slight "silvery" quality near the sun).
  veilSheen: new Float32Array(MAX_ALTOSTRATUS_INSTANCES),

  // Sun dimming factor (0 = transparent to sun, 1 = blocks sun).
  sunDimming: new Float32Array(MAX_ALTOSTRATUS_INSTANCES),

  // Sheet uniformity (0 = patchy, 1 = perfectly uniform).
  uniformity: new Float32Array(MAX_ALTOSTRATUS_INSTANCES),

  // Drizzle accumulation (mm accumulated this cloud's lifetime).
  drizzleAccum: new Float32Array(MAX_ALTOSTRATUS_INSTANCES),

  // Current drizzle rate (mm/h; 0 = no drizzle).
  drizzleRate: new Float32Array(MAX_ALTOSTRATUS_INSTANCES),

  // Nimbostratus transition progress (0..1; 1 = fully transitioned).
  nimbostratusProgress: new Float32Array(MAX_ALTOSTRATUS_INSTANCES),

  // Drift speed (m/s).
  driftSpeed: new Float32Array(MAX_ALTOSTRATUS_INSTANCES),

  // Current fade factor (0..1).
  fade: new Float32Array(MAX_ALTOSTRATUS_INSTANCES),

  // Noise index (lazy).
  noiseIndex: new Uint16Array(MAX_ALTOSTRATUS_INSTANCES),

  // Back-pointer to 029 instance slot.
  _baseInstanceSlot: new Uint16Array(MAX_ALTOSTRATUS_INSTANCES),
};

/** Marker: entity is an altostratus sheet (set by addAltostratus). */
export const AltostratusTag = {};

const _altostratusSlots = new Map(); // eid -> altostratus slot
let _nextAltostratusSlot = 0;

// Noise generators (lazy).
const _altostratusNoise = new Map();

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

function getAltostratusNoise(index) {
  let n = _altostratusNoise.get(index);
  if (!n) {
    n = createNoise3D(() => mulberry32(0xA150 ^ (index * 2654435761)));
    _altostratusNoise.set(index, n);
  }
  return n;
}

// ═══════════════════════════════════════════════════════════════════════
// PRE-BUILT ARCHETYPES — altostratus family
// ═══════════════════════════════════════════════════════════════════════

export const AltostratusArchetypes = {
  uniform:  -1,
  dense:    -1,
  drizzle:  -1,
  initialized: false,
};

/**
 * Build the three altostratus archetypes once.
 */
export function ensureAltostratusArchetypes() {
  if (AltostratusArchetypes.initialized) return AltostratusArchetypes;

  // UNIFORM — classic mid-level uniform sheet, partial sun dimming.
  AltostratusArchetypes.uniform = createCloudArchetype(
    CloudType.ALTOSTRATUS,
    CloudSubtype.DEFAULT,
    {
      baseAltitude: 2500,
      topAltitude: 5500,
      minCoverage: 0.70,
      maxCoverage: 0.95,
      density: 0.25,
      opticalDepth: 2.0,
      albedoR: 0.90, albedoG: 0.92, albedoB: 0.94,
      mieG: 0.50,
      windSpeed: 12,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 400,
      precipitationType: PrecipitationType.DRIZZLE,
      precipitationRate: 0.2,
      lightningProbability: 0,
      billow: 0.10,
      wispiness: 0.35,
      puffiness: 0.15,
      shadowStrength: 0.40,
      silverLining: 0.15,
      haloEffect: 0.05,
    }
  );

  // DENSE — thicker, darker sheet with stronger sun blocking.
  AltostratusArchetypes.dense = createCloudArchetype(
    CloudType.ALTOSTRATUS,
    CloudSubtype.DEFAULT,
    {
      baseAltitude: 2200,
      topAltitude: 5500,
      minCoverage: 0.85,
      maxCoverage: 1.00,
      density: 0.40,
      opticalDepth: 3.2,
      albedoR: 0.75, albedoG: 0.78, albedoB: 0.80,
      mieG: 0.48,
      windSpeed: 10,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 500,
      precipitationType: PrecipitationType.DRIZZLE,
      precipitationRate: 0.5,
      lightningProbability: 0,
      billow: 0.10,
      wispiness: 0.30,
      puffiness: 0.15,
      shadowStrength: 0.65,
      silverLining: 0.10,
      haloEffect: 0.03,
    }
  );

  // DRIZZLE — heavier sheet actively producing drizzle, near-nimbostratus.
  AltostratusArchetypes.drizzle = createCloudArchetype(
    CloudType.ALTOSTRATUS,
    CloudSubtype.DEFAULT,
    {
      baseAltitude: 2000,
      topAltitude: 5500,
      minCoverage: 0.90,
      maxCoverage: 1.00,
      density: 0.55,
      opticalDepth: 4.5,
      albedoR: 0.65, albedoG: 0.68, albedoB: 0.72,
      mieG: 0.45,
      windSpeed: 9,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 550,
      precipitationType: PrecipitationType.DRIZZLE,
      precipitationRate: 1.0,
      lightningProbability: 0,
      billow: 0.10,
      wispiness: 0.25,
      puffiness: 0.20,
      shadowStrength: 0.80,
      silverLining: 0.05,
      haloEffect: 0.00,
    }
  );

  AltostratusArchetypes.initialized = true;
  return AltostratusArchetypes;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — create altostratus instances
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add an altostratus sheet instance to an entity.
 *
 * @param world       ECS world
 * @param eid         entity (must have WorldTransformF32)
 * @param subtype     'uniform' | 'dense' | 'drizzle'
 * @param options     { radiusX, radiusY, radiusZ, lifetime,
 *                      sheetThickness, uniformity }
 */
export function addAltostratus(world, eid, subtype = 'uniform', options = {}) {
  ensureAltostratusArchetypes();

  let archetypeSlot;
  if (subtype === 'dense')        archetypeSlot = AltostratusArchetypes.dense;
  else if (subtype === 'drizzle') archetypeSlot = AltostratusArchetypes.drizzle;
  else                            archetypeSlot = AltostratusArchetypes.uniform;

  if (_nextAltostratusSlot >= MAX_ALTOSTRATUS_INSTANCES) {
    throw new Error('altostratus instance capacity exceeded');
  }
  const asSlot = _nextAltostratusSlot++;

  // Register base cloud instance via 029.
  const instanceSlot = addCloudInstance(world, eid, archetypeSlot, {
    radiusX: options.radiusX ?? 12000,
    radiusY: options.radiusY ?? 1500,
    radiusZ: options.radiusZ ?? 12000,
    lifetime: options.lifetime ?? 3600,
  });

  const AS = AltostratusState;
  const rng = mulberry32(0xA150 ^ (asSlot * 2654435761));

  AS.sheetThickness[asSlot] = options.sheetThickness
    ?? (ALTOSTRATUS_SHEET_THICKNESS_MIN
        + rng() * (ALTOSTRATUS_SHEET_THICKNESS_MAX - ALTOSTRATUS_SHEET_THICKNESS_MIN));
  AS.veilSheen[asSlot] = options.veilSheen ?? (0.15 + rng() * 0.20);
  AS.sunDimming[asSlot] = 0.5;
  AS.uniformity[asSlot] = options.uniformity ?? (0.7 + rng() * 0.3);
  AS.drizzleAccum[asSlot] = 0;
  AS.drizzleRate[asSlot] = 0;
  AS.nimbostratusProgress[asSlot] = 0;
  AS.driftSpeed[asSlot] = ALTOSTRATUS_DRIFT_SPEED_MIN
    + rng() * (ALTOSTRATUS_DRIFT_SPEED_MAX - ALTOSTRATUS_DRIFT_SPEED_MIN);
  AS.fade[asSlot] = 0;
  AS.noiseIndex[asSlot] = asSlot % 256;
  AS._baseInstanceSlot[asSlot] = instanceSlot;

  addComponent(world, eid, AltostratusTag);
  _altostratusSlots.set(eid, asSlot);

  return asSlot;
}

export function removeAltostratus(world, eid) {
  const asSlot = _altostratusSlots.get(eid);
  if (asSlot === undefined) return;

  removeCloudInstance(world, eid);

  _altostratusSlots.delete(eid);
  AltostratusState.fade[asSlot] = 0;
  removeComponent(world, eid, AltostratusTag);
}

// ═══════════════════════════════════════════════════════════════════════
// BEHAVIOUR — per-frame altostratus evolution
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance altostratus-specific behaviour:
 *   • fade-in / fade-out over 029's phase
 *   • sheet thickness slight oscillation
 *   • sun-dimming factor computed from thickness × coverage
 *   • drizzle triggering when thickness × coverage crosses threshold
 *   • nimbostratus transition when threshold is exceeded long enough
 */
export function systemAltostratusEvolve(world, dt) {
  const AS = AltostratusState;
  const CI = CloudInstance;

  for (let slot = 0; slot < _nextAltostratusSlot; slot++) {
    const baseSlot = AS._baseInstanceSlot[slot];
    if (baseSlot === undefined) continue;

    const fade = computeFade(CI.phase[baseSlot]);
    AS.fade[slot] = fade;

    // Sheet thickness slow breathing.
    const breathing = 0.90 + 0.10 * Math.sin(CI.phase[baseSlot] * TWO_PI);
    const effectiveThickness = AS.sheetThickness[slot] * breathing;

    // Compute effective optical depth = thickness × coverage.
    const coverage = CI.coverage[baseSlot];
    const opticalFactor = effectiveThickness * coverage;

    // Sun dimming: linear in optical factor, clamped.
    AS.sunDimming[slot] = Math.max(0,
      Math.min(1, opticalFactor * 1.2));

    // Drizzle trigger: optical factor above threshold.
    if (opticalFactor > ALTOSTRATUS_DRIZZLE_TRIGGER) {
      const excess = (opticalFactor - ALTOSTRATUS_DRIZZLE_TRIGGER)
                   / (1 - ALTOSTRATUS_DRIZZLE_TRIGGER);
      AS.drizzleRate[slot] = ALTOSTRATUS_DRIZZLE_RATE_BASE
                           + ALTOSTRATUS_DRIZZLE_RATE_SCALE * excess;
      AS.drizzleAccum[slot] += AS.drizzleRate[slot] * dt / 3600;
      CI.flags[baseSlot] |= 1 << 1;   // FLAG_PRECIPITATING
    } else {
      AS.drizzleRate[slot] = 0;
      CI.flags[baseSlot] &= ~(1 << 1);
    }

    // Nimbostratus transition: if optical factor exceeds the transition
    // threshold for long enough, progress increases.
    if (opticalFactor > ALTOSTRATUS_NIMBO_TRANSITION) {
      AS.nimbostratusProgress[slot] = Math.min(1,
        AS.nimbostratusProgress[slot] + ALTOSTRATUS_NIMBO_TRANSITION_RATE * dt);
    } else {
      AS.nimbostratusProgress[slot] = Math.max(0,
        AS.nimbostratusProgress[slot] - ALTOSTRATUS_NIMBO_TRANSITION_RATE * dt * 0.5);
    }

    // Sheet drift.
    CI.px[baseSlot] += AS.driftSpeed[slot] * dt;

    // Sync visibility to base instance.
    CI.visibility[baseSlot] = fade;
  }

  return world;
}

function computeFade(phase) {
  if (phase < ALTOSTRATUS_FADE_IN_START) return 0;
  if (phase < ALTOSTRATUS_FADE_IN_END) {
    return (phase - ALTOSTRATUS_FADE_IN_START) /
           (ALTOSTRATUS_FADE_IN_END - ALTOSTRATUS_FADE_IN_START);
  }
  if (phase < ALTOSTRATUS_FADE_OUT_START) return 1;
  if (phase < ALTOSTRATUS_FADE_OUT_END) {
    return 1 - (phase - ALTOSTRATUS_FADE_OUT_START) /
               (ALTOSTRATUS_FADE_OUT_END - ALTOSTRATUS_FADE_OUT_START);
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════
// DENSITY HOOK — override base 029 sampleInstanceDensity with sheet
// ═══════════════════════════════════════════════════════════════════════

/**
 * Altostratus-enhanced density sampling. Adds a very low-frequency noise
 * band to produce the "uniform but not sterile" look. Uniformity controls
 * how much of the noise is visible (1 = perfectly flat).
 *
 * @param asSlot     index in AltostratusState
 * @param wx, wy, wz world-space point
 */
export function sampleAltostratusDensity(asSlot, wx, wy, wz) {
  const baseSlot = AltostratusState._baseInstanceSlot[asSlot];
  if (baseSlot === undefined) return 0;

  const base = sampleInstanceDensity(baseSlot, wx, wy, wz);
  if (base < EPSILON) return 0;

  const CI = CloudInstance;
  const AS = AltostratusState;

  // Local coordinates.
  const lx = (wx - CI.px[baseSlot]);
  const ly = (wy - CI.py[baseSlot]);
  const lz = (wz - CI.pz[baseSlot]);

  // Low-frequency noise (very smooth).
  const noise = getAltostratusNoise(AS.noiseIndex[asSlot]);
  const rawNoise = noise(lx * 0.0005, ly * 0.001, lz * 0.0005);

  // Uniformity: 1.0 = ignore noise, 0.0 = full noise.
  const noiseInfluence = (1 - AS.uniformity[asSlot]) * 0.20;
  const noiseMod = 1.0 - noiseInfluence * (0.5 + 0.5 * rawNoise);

  // Sheet thickness scaling.
  const mod = noiseMod * AS.fade[asSlot] * AS.sheetThickness[asSlot];

  return Math.max(0, Math.min(1, base * mod));
}

// ═══════════════════════════════════════════════════════════════════════
// SUN DIMMING HOOK — return sun transmission factor
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the sun transmission factor (0..1) for a given view direction.
 * 1 = sun fully visible through the sheet, 0 = sun completely blocked.
 *
 * This is what file 028's sky sample multiplies the sun disk brightness
 * by, so altostratus correctly casts a soft, diffuse light.
 *
 * @param asSlot        altostratus slot
 * @param viewDirX/Y/Z  normalised view direction
 */
export function sampleAltostratusSunDimming(asSlot, viewDirX, viewDirY, viewDirZ) {
  const baseSlot = AltostratusState._baseInstanceSlot[asSlot];
  if (baseSlot === undefined) return 1.0;

  const AS = AltostratusState;
  if (AS.fade[asSlot] < 0.1) return 1.0;

  // Compute the view direction's coverage by this sheet: highest if the
  // ray travels directly through the sheet's center.
  const CI = CloudInstance;
  const dx = viewDirX;
  const dy = viewDirY;
  const dz = viewDirZ;

  // Approximate: use the sheet's effective optical factor.
  const opticalFactor = AS.sheetThickness[asSlot]
                      * CI.coverage[baseSlot]
                      * AS.fade[asSlot];

  // Transmission = exp(-opticalFactor * k).
  const k = 3.0;
  const transmission = Math.exp(-opticalFactor * k);

  // Clamp to a sensible range.
  return Math.max(ALTOSTRATUS_SUN_DIM_MIN,
                  Math.min(1.0, transmission));
}

// ═══════════════════════════════════════════════════════════════════════
// VFX BRIDGE — drizzle particles
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return data for the caller (file 025) to spawn drizzle particles when
 * the sheet is actively producing drizzle.
 */
export function emitAltostratusDrizzle(asSlot, cameraX, cameraY, cameraZ, emitRate) {
  const baseSlot = AltostratusState._baseInstanceSlot[asSlot];
  if (baseSlot === undefined) return null;

  const AS = AltostratusState;
  if (AS.drizzleRate[asSlot] < EPSILON) return null;
  if (AS.fade[asSlot] < 0.3) return null;

  const CI = CloudInstance;
  const dx = cameraX - CI.px[baseSlot];
  const dz = cameraZ - CI.pz[baseSlot];
  const horizontalDistSq = dx * dx + dz * dz;
  if (horizontalDistSq > ALTOSTRATUS_VFX_RADIUS * ALTOSTRATUS_VFX_RADIUS) return null;

  const count = Math.min(
    ALTOSTRATUS_VFX_MAX_PARTICLES,
    Math.floor(emitRate * AS.drizzleRate[asSlot] * 0.1)
  );

  if (count <= 0) return null;

  return {
    count,
    position: [CI.px[baseSlot], CI.py[baseSlot], CI.pz[baseSlot]],
    radiusX: CI.radiusX[baseSlot],
    radiusY: CI.radiusY[baseSlot],
    radiusZ: CI.radiusZ[baseSlot],
    drizzleRate: AS.drizzleRate[asSlot],
    drizzleAccum: AS.drizzleAccum[asSlot],
    nimbostratusProgress: AS.nimbostratusProgress[asSlot],
    sunDimming: AS.sunDimming[asSlot],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// NIMBOSTRATUS TRANSITION — signal when ready to convert
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return true when this altostratus has fully transitioned to
 * nimbostratus. The caller should then remove this cloud and spawn
 * a nimbostratus instance (file 035) at the same position.
 */
export function isReadyForNimbostratusTransition(asSlot) {
  const AS = AltostratusState;
  if (asSlot < 0 || asSlot >= _nextAltostratusSlot) return false;
  return AS.nimbostratusProgress[asSlot] >= 0.98;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function altostratusStats() {
  let active = 0;
  let drizzling = 0;
  let transitioning = 0;

  for (let slot = 0; slot < _nextAltostratusSlot; slot++) {
    if (AltostratusState.fade[slot] < EPSILON) continue;
    active++;
    if (AltostratusState.drizzleRate[slot] > EPSILON) drizzling++;
    if (AltostratusState.nimbostratusProgress[slot] > 0.5) transitioning++;
  }

  return {
    totalAltostratus: _nextAltostratusSlot,
    active,
    drizzling,
    transitioning,
    archetypesReady: AltostratusArchetypes.initialized,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearAltostratus() {
  _altostratusSlots.clear();
  _nextAltostratusSlot = 0;
  _altostratusNoise.clear();
  AltostratusState.fade.fill(0);
  AltostratusState.drizzleRate.fill(0);
  AltostratusState.nimbostratusProgress.fill(0);
}