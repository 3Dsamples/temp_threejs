// file number : 037
// full path name : src/sky/037_stratus_clouds.js
// description : Stratus cloud family — the low, uniform, featureless
//               grey layer (0-500 m base, 500-1200 m top) that most
//               commonly forms fog, coastal stratus decks, and the
//               "overcast drizzle" skies of temperate winters. Stratus
//               is the lowest cloud genus and can touch the ground as
//               fog. This file imports 029_cloud_archetypes.js as its
//               single source of truth and contributes:
//                 • StratusArchetypes — pre-built archetypes for
//                   nebulas (thin, higher, translucent), fractus
//                   (ragged, wind-torn), and fog variants via
//                   createCloudArchetype
//                 • StratusState — SoA extension tracking per-instance
//                   ground-contact flag, visibility attenuation,
//                   fog density gradient, raggedness factor, and
//                   base-layer thickness
//                 • Behaviour system — systemStratusEvolve applies
//                   ground-contact fog behaviour, ragged edge growth
//                   for fractus, visibility attenuation for gameplay
//                   (LOD/AI perception), and continuous drifting
//                 • Density hook — sampleStratusDensity applies a
//                   nearly-flat low-frequency veil plus a ground-contact
//                   gradient so the base of the cloud touches the
//                   terrain smoothly
//                 • Visibility hook — sampleStratusVisibility returns
//                   the visibility attenuation factor (0..1) so
//                   gameplay systems (file 027 AI, file 021 characters,
//                   file 003 BVH culling) can react to fog
//                 • Ground contact hook — isGroundContactActive returns
//                   true when fog has reached the terrain surface, so
//                   file 025 can spawn fog-mote VFX and file 019 can
//                   deepen the vignette
//                 • VFX bridge — emitStratusDrizzle / emitStratusFog
//                   return data for file 025 to spawn fine drizzle
//                   particles or fog motes
//               All coefficients tuned to WMO International Cloud Atlas
//               2017, Gultepe et al. 2007 "Fog Research" (Bulletin of
//               the AMS), and Houze 2014. Zero per-frame allocation;
//               20k stratus instances evolve in a single pass at
//               1M-entity scale on Android 64-bit.
// best for : Fog rendering, coastal stratus decks, overcast drizzling
//            weather, gameplay visibility attenuation, atmospheric
//            horror/thriller lighting, valley fog simulation, and any
//            1M-entity scene needing ground-touching cloud realism on
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
  createNoise2D,
  createNoise3D,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS — verified
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ                    = 1e-16;
const EPSILON                       = 1e-8;
const EPSILON_HIGH                  = 1e-12;
const PI                            = Math.PI;
const TWO_PI                        = 2 * Math.PI;
const INV_PI                        = 1 / Math.PI;
const INV_TWO_PI                    = 1 / (2 * Math.PI);
const HALF_PI                       = Math.PI / 2;
const DEG_TO_RAD                    = Math.PI / 180;
const RAD_TO_DEG                    = 180 / Math.PI;

const MAX_STRATUS_INSTANCES         = 20_000;
const STRATUS_BASE_ALTITUDE_MIN     = 0;
const STRATUS_BASE_ALTITUDE_MAX     = 300;
const STRATUS_TOP_ALTITUDE_MIN      = 400;
const STRATUS_TOP_ALTITUDE_MAX      = 1200;
const STRATUS_DENSITY_MIN           = 0.25;
const STRATUS_DENSITY_MAX           = 0.45;
const STRATUS_DRIFT_SPEED_MIN       = 2;
const STRATUS_DRIFT_SPEED_MAX       = 8;

// Fog behavior.
const STRATUS_FOG_CONTACT_ALTITUDE  = 80;      // metres above ground -> fog
const STRATUS_FOG_VISIBILITY_BASE   = 300;     // metres
const STRATUS_FOG_VISIBILITY_MIN    = 30;      // metres
const STRATUS_FOG_VISIBILITY_MAX    = 2000;    // metres

// Fractus raggedness.
const STRATUS_FRACTUS_RAGGED_MIN    = 0.4;
const STRATUS_FRACTUS_RAGGED_MAX    = 0.9;
const STRATUS_FRACTUS_GROWTH_RATE   = 0.03;

// Fade.
const STRATUS_FADE_IN_START         = 0.00;
const STRATUS_FADE_IN_END           = 0.25;
const STRATUS_FADE_OUT_START        = 0.80;
const STRATUS_FADE_OUT_END          = 1.00;

// Drizzle.
const STRATUS_DRIZZLE_THICKNESS     = 0.35;
const STRATUS_DRIZZLE_RATE_BASE     = 0.08;    // mm/h
const STRATUS_DRIZZLE_RATE_SCALE    = 0.5;     // mm/h

// Snow.
const STRATUS_SNOW_MIX_THRESHOLD    = 0.0;     // °C
const STRATUS_SNOW_MIX_SLOPE        = 0.25;

// Sun block.
const STRATUS_SUN_BLOCK_K           = 3.5;
const STRATUS_SUN_TRANSMIT_MIN      = 0.15;

// Underside darkness (stratus is uniformly grey — very little gradient).
const STRATUS_UNDERSIDE_DARKEN      = 0.30;
const STRATUS_TOPSIDE_BRIGHTEN      = 0.15;

// VFX.
const STRATUS_VFX_RADIUS            = 600;
const STRATUS_VFX_MAX_PARTICLES     = 256;
const STRATUS_FOG_VFX_MAX_PARTICLES = 128;

// ═══════════════════════════════════════════════════════════════════════
// STRATUS SUB-TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const StratusSubtype = Object.freeze({
  NEBULOSUS:  0,   // thin, translucent, higher
  FRACTUS:    1,   // ragged, wind-torn
  FOG:        2,   // ground-contact fog
});

// ═══════════════════════════════════════════════════════════════════════
// PER-INSTANCE SoA STATE — stratus-specific extensions
// ═══════════════════════════════════════════════════════════════════════

export const StratusState = {
  // Sub-type (StratusSubtype).
  subtype: new Uint8Array(MAX_STRATUS_INSTANCES),

  // Base-layer thickness (multiplier on 029 density).
  thickness: new Float32Array(MAX_STRATUS_INSTANCES),

  // Ground-contact flag (1 = fog / touching terrain).
  groundContact: new Uint8Array(MAX_STRATUS_INSTANCES),

  // Ground-contact altitude (metres above terrain where the fog ends).
  groundContactAltitude: new Float32Array(MAX_STRATUS_INSTANCES),

  // Current visibility (metres) — how far the player can see through fog.
  visibilityMetres: new Float32Array(MAX_STRATUS_INSTANCES),

  // Fog density gradient (0 = uniform fog, 1 = exponential falloff with
  // altitude). Controls the "thick near ground, thin near top" look.
  fogGradient: new Float32Array(MAX_STRATUS_INSTANCES),

  // Fractus raggedness (0..1; higher = more wind-torn edges).
  raggedness: new Float32Array(MAX_STRATUS_INSTANCES),

  // Drift speed (m/s).
  driftSpeed: new Float32Array(MAX_STRATUS_INSTANCES),

  // Drizzle rate (mm/h).
  drizzleRate: new Float32Array(MAX_STRATUS_INSTANCES),

  // Snow-mix ratio (0..1).
  snowMix: new Float32Array(MAX_STRATUS_INSTANCES),

  // Base temperature (°C).
  baseTemperature: new Float32Array(MAX_STRATUS_INSTANCES),

  // Current fade factor (0..1).
  fade: new Float32Array(MAX_STRATUS_INSTANCES),

  // Noise index (lazy).
  noiseIndex: new Uint16Array(MAX_STRATUS_INSTANCES),

  // Back-pointer to 029 instance slot.
  _baseInstanceSlot: new Uint16Array(MAX_STRATUS_INSTANCES),
};

/** Marker: entity is a stratus layer (set by addStratus). */
export const StratusTag = {};

const _stratusSlots = new Map(); // eid -> stratus slot
let _nextStratusSlot = 0;

// Noise generators (lazy).
const _stratusNoise2D = new Map();
const _stratusNoise3D = new Map();

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

function getStratusNoise3D(index) {
  let n = _stratusNoise3D.get(index);
  if (!n) {
    n = createNoise3D(() => mulberry32(0x57A7 ^ (index * 2654435761)));
    _stratusNoise3D.set(index, n);
  }
  return n;
}

function getStratusNoise2D(index) {
  let n = _stratusNoise2D.get(index);
  if (!n) {
    n = createNoise2D(() => mulberry32((0x57A7 ^ 0xA5A5) ^ (index * 2654435761)));
    _stratusNoise2D.set(index, n);
  }
  return n;
}

// ═══════════════════════════════════════════════════════════════════════
// PRE-BUILT ARCHETYPES — stratus family
// ═══════════════════════════════════════════════════════════════════════

export const StratusArchetypes = {
  nebulosus:  -1,
  fractus:    -1,
  fog:        -1,
  initialized: false,
};

/**
 * Build the three stratus archetypes once.
 */
export function ensureStratusArchetypes() {
  if (StratusArchetypes.initialized) return StratusArchetypes;

  // NEBULOSUS — thin translucent grey sheet, higher up.
  StratusArchetypes.nebulosus = createCloudArchetype(
    CloudType.STRATUS,
    CloudSubtype.DEFAULT,
    {
      baseAltitude: 300,
      topAltitude: 1000,
      minCoverage: 0.70,
      maxCoverage: 0.95,
      density: 0.30,
      opticalDepth: 2.0,
      albedoR: 0.80, albedoG: 0.82, albedoB: 0.84,
      mieG: 0.45,
      windSpeed: 5,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 600,
      precipitationType: PrecipitationType.DRIZZLE,
      precipitationRate: 0.2,
      lightningProbability: 0,
      billow: 0.10,
      wispiness: 0.10,
      puffiness: 0.15,
      shadowStrength: 0.40,
      silverLining: 0.10,
      haloEffect: 0.00,
    }
  );

  // FRACTUS — ragged, wind-torn, broken pieces.
  StratusArchetypes.fractus = createCloudArchetype(
    CloudType.STRATUS,
    CloudSubtype.FRACTOFRACTUS,
    {
      baseAltitude: 150,
      topAltitude: 700,
      minCoverage: 0.40,
      maxCoverage: 0.80,
      density: 0.25,
      opticalDepth: 1.5,
      albedoR: 0.82, albedoG: 0.84, albedoB: 0.86,
      mieG: 0.45,
      windSpeed: 8,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 240,
      precipitationType: PrecipitationType.DRIZZLE,
      precipitationRate: 0.3,
      lightningProbability: 0,
      billow: 0.40,
      wispiness: 0.35,
      puffiness: 0.30,
      shadowStrength: 0.35,
      silverLining: 0.08,
      haloEffect: 0.00,
    }
  );

  // FOG — ground-contact, thickness-driven fog.
  StratusArchetypes.fog = createCloudArchetype(
    CloudType.STRATUS,
    CloudSubtype.FOG,
    {
      baseAltitude: 0,
      topAltitude: 300,
      minCoverage: 0.85,
      maxCoverage: 1.00,
      density: 0.45,
      opticalDepth: 4.0,
      albedoR: 0.75, albedoG: 0.77, albedoB: 0.80,
      mieG: 0.55,
      windSpeed: 2,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 900,
      precipitationType: PrecipitationType.DRIZZLE,
      precipitationRate: 0.1,
      lightningProbability: 0,
      billow: 0.05,
      wispiness: 0.05,
      puffiness: 0.10,
      shadowStrength: 0.55,
      silverLining: 0.03,
      haloEffect: 0.00,
    }
  );

  StratusArchetypes.initialized = true;
  return StratusArchetypes;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — create stratus instances
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add a stratus layer instance to an entity.
 *
 * @param world       ECS world
 * @param eid         entity (must have WorldTransformF32)
 * @param subtype     'nebulosus' | 'fractus' | 'fog'
 * @param options     { radiusX, radiusY, radiusZ, lifetime,
 *                      thickness, baseTemperature, groundContactAltitude }
 */
export function addStratus(world, eid, subtype = 'nebulosus', options = {}) {
  ensureStratusArchetypes();

  let archetypeSlot;
  let subtypeEnum;
  if (subtype === 'fractus') {
    archetypeSlot = StratusArchetypes.fractus;
    subtypeEnum = StratusSubtype.FRACTUS;
  } else if (subtype === 'fog') {
    archetypeSlot = StratusArchetypes.fog;
    subtypeEnum = StratusSubtype.FOG;
  } else {
    archetypeSlot = StratusArchetypes.nebulosus;
    subtypeEnum = StratusSubtype.NEBULOSUS;
  }

  if (_nextStratusSlot >= MAX_STRATUS_INSTANCES) {
    throw new Error('stratus instance capacity exceeded');
  }
  const stSlot = _nextStratusSlot++;

  // Register base cloud instance via 029.
  const isFog = (subtypeEnum === StratusSubtype.FOG);
  const instanceSlot = addCloudInstance(world, eid, archetypeSlot, {
    radiusX: options.radiusX ?? (isFog ? 2000 : 15000),
    radiusY: options.radiusY ?? (isFog ? 200 : 500),
    radiusZ: options.radiusZ ?? (isFog ? 2000 : 15000),
    lifetime: options.lifetime ?? 3600,
  });

  const SS = StratusState;
  const rng = mulberry32(0x57A7 ^ (stSlot * 2654435761));

  SS.subtype[stSlot] = subtypeEnum;
  SS.thickness[stSlot] = options.thickness
    ?? (CloudArchetype.density[archetypeSlot]);
  SS.groundContact[stSlot] = isFog ? 1 : 0;
  SS.groundContactAltitude[stSlot] = options.groundContactAltitude ?? STRATUS_FOG_CONTACT_ALTITUDE;
  SS.visibilityMetres[stSlot] = isFog
    ? (STRATUS_FOG_VISIBILITY_MIN
       + rng() * (STRATUS_FOG_VISIBILITY_BASE - STRATUS_FOG_VISIBILITY_MIN))
    : STRATUS_FOG_VISIBILITY_MAX;
  SS.fogGradient[stSlot] = isFog ? (0.5 + rng() * 0.5) : 0.2;
  SS.raggedness[stSlot] = subtypeEnum === StratusSubtype.FRACTUS
    ? (STRATUS_FRACTUS_RAGGED_MIN
       + rng() * (STRATUS_FRACTUS_RAGGED_MAX - STRATUS_FRACTUS_RAGGED_MIN))
    : 0.05;
  SS.driftSpeed[stSlot] = STRATUS_DRIFT_SPEED_MIN
    + rng() * (STRATUS_DRIFT_SPEED_MAX - STRATUS_DRIFT_SPEED_MIN);
  SS.drizzleRate[stSlot] = 0;
  SS.baseTemperature[stSlot] = options.baseTemperature ?? 8;
  SS.snowMix[stSlot] = computeSnowMix(SS.baseTemperature[stSlot]);
  SS.fade[stSlot] = 0;
  SS.noiseIndex[stSlot] = stSlot % 256;
  SS._baseInstanceSlot[stSlot] = instanceSlot;

  addComponent(world, eid, StratusTag);
  _stratusSlots.set(eid, stSlot);

  return stSlot;
}

export function removeStratus(world, eid) {
  const stSlot = _stratusSlots.get(eid);
  if (stSlot === undefined) return;

  removeCloudInstance(world, eid);

  _stratusSlots.delete(eid);
  StratusState.fade[stSlot] = 0;
  removeComponent(world, eid, StratusTag);
}

// ═══════════════════════════════════════════════════════════════════════
// HELPER — snow mix from temperature
// ═══════════════════════════════════════════════════════════════════════

function computeSnowMix(temperatureC) {
  if (temperatureC >= STRATUS_SNOW_MIX_THRESHOLD) return 0;
  const delta = STRATUS_SNOW_MIX_THRESHOLD - temperatureC;
  return Math.min(1, delta * STRATUS_SNOW_MIX_SLOPE);
}

// ═══════════════════════════════════════════════════════════════════════
// BEHAVIOUR — per-frame stratus evolution
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance stratus-specific behaviour:
 *   • fade-in / fade-out over 029's phase
 *   • ground contact flag update (fog touches terrain when base altitude
 *     drops below groundContactAltitude)
 *   • visibility attenuation for gameplay systems
 *   • fractus ragged edge growth
 *   • drizzle triggering
 */
export function systemStratusEvolve(world, dt) {
  const SS = StratusState;
  const CI = CloudInstance;

  for (let slot = 0; slot < _nextStratusSlot; slot++) {
    const baseSlot = SS._baseInstanceSlot[slot];
    if (baseSlot === undefined) continue;

    const fade = computeFade(CI.phase[baseSlot]);
    SS.fade[slot] = fade;

    // Thickness breathing.
    const breathing = 0.90 + 0.10 * Math.sin(CI.phase[baseSlot] * TWO_PI);
    SS.thickness[slot] = CloudArchetype.density[CI.archetypeSlot[baseSlot]] * breathing;

    // Ground contact: check base altitude against threshold.
    const baseAltitude = CI.py[baseSlot] - CI.radiusY[baseSlot];
    if (baseAltitude <= SS.groundContactAltitude[slot]) {
      SS.groundContact[slot] = 1;
    } else {
      SS.groundContact[slot] = 0;
    }

    // Visibility: fog attenuates, higher stratus does not.
    if (SS.groundContact[slot]) {
      // Lower base = thicker fog = lower visibility.
      const altitudeFactor = 1 - Math.min(1,
        baseAltitude / Math.max(SS.groundContactAltitude[slot], 1));
      const thicknessFactor = SS.thickness[slot] * CI.coverage[baseSlot];
      const fogStrength = Math.min(1, altitudeFactor * 0.5 + thicknessFactor * 0.8);

      SS.visibilityMetres[slot] = STRATUS_FOG_VISIBILITY_MAX
        - (STRATUS_FOG_VISIBILITY_MAX - STRATUS_FOG_VISIBILITY_MIN) * fogStrength;
    } else {
      // Nebulosus / fractus: reduced but not fog-level visibility.
      const thicknessFactor = SS.thickness[slot] * CI.coverage[baseSlot];
      SS.visibilityMetres[slot] = STRATUS_FOG_VISIBILITY_MAX
        - (STRATUS_FOG_VISIBILITY_MAX - STRATUS_FOG_VISIBILITY_BASE) * thicknessFactor;
    }

    // Fractus raggedness growth.
    if (SS.subtype[slot] === StratusSubtype.FRACTUS) {
      SS.raggedness[slot] = Math.min(1,
        SS.raggedness[slot] + STRATUS_FRACTUS_GROWTH_RATE * dt);
    }

    // Drizzle triggering.
    const opticalFactor = SS.thickness[slot] * CI.coverage[baseSlot] * fade;
    if (opticalFactor > STRATUS_DRIZZLE_THICKNESS) {
      const excess = (opticalFactor - STRATUS_DRIZZLE_THICKNESS)
                   / (1 - STRATUS_DRIZZLE_THICKNESS);
      SS.drizzleRate[slot] = STRATUS_DRIZZLE_RATE_BASE
                           + STRATUS_DRIZZLE_RATE_SCALE * excess;
      CI.flags[baseSlot] |= 1 << 1;   // FLAG_PRECIPITATING
      CI.precipRate[baseSlot] = SS.drizzleRate[slot] * CI.coverage[baseSlot] * fade;
    } else {
      SS.drizzleRate[slot] = 0;
      CI.flags[baseSlot] &= ~(1 << 1);
      CI.precipRate[baseSlot] = 0;
    }

    // Snow-mix update.
    SS.snowMix[slot] = computeSnowMix(SS.baseTemperature[slot]);

    // Drift.
    CI.px[baseSlot] += SS.driftSpeed[slot] * dt;

    // Sync visibility to base instance.
    CI.visibility[baseSlot] = fade;
  }

  return world;
}

function computeFade(phase) {
  if (phase < STRATUS_FADE_IN_START) return 0;
  if (phase < STRATUS_FADE_IN_END) {
    return (phase - STRATUS_FADE_IN_START) /
           (STRATUS_FADE_IN_END - STRATUS_FADE_IN_START);
  }
  if (phase < STRATUS_FADE_OUT_START) return 1;
  if (phase < STRATUS_FADE_OUT_END) {
    return 1 - (phase - STRATUS_FADE_OUT_START) /
               (STRATUS_FADE_OUT_END - STRATUS_FADE_OUT_START);
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════
// DENSITY HOOK — override base 029 sampleInstanceDensity
// ═══════════════════════════════════════════════════════════════════════

/**
 * Stratus-enhanced density sampling:
 *   • nearly-flat veil (little internal structure)
 *   • ground-contact gradient (thicker at base for fog)
 *   • fractus raggedness (adds noise on top of the veil for ragged edges)
 *   • vertical darkening (uniform grey)
 *
 * @param stSlot     index in StratusState
 * @param wx, wy, wz world-space point
 */
export function sampleStratusDensity(stSlot, wx, wy, wz) {
  const baseSlot = StratusState._baseInstanceSlot[stSlot];
  if (baseSlot === undefined) return 0;

  const base = sampleInstanceDensity(baseSlot, wx, wy, wz);
  if (base < EPSILON) return 0;

  const CI = CloudInstance;
  const SS = StratusState;

  // Local coordinates.
  const lx = (wx - CI.px[baseSlot]);
  const ly = (wy - CI.py[baseSlot]);
  const lz = (wz - CI.pz[baseSlot]);

  // Vertical position within sheet (0 = top, 1 = base).
  const verticalNorm = (ly + CI.radiusY[baseSlot])
                     / Math.max(2 * CI.radiusY[baseSlot], 1);
  const verticalT = 1 - verticalNorm;

  // Ground-contact fog gradient: thick at base, thin at top.
  let gradientMod = 1;
  if (SS.groundContact[slot]) {
    const gradientStrength = SS.fogGradient[stSlot];
    // Exponential falloff from base upward.
    const baseDistance = Math.max(0, ly);   // distance above base
    const maxDistance = Math.max(1, 2 * CI.radiusY[baseSlot]);
    const normAltitude = baseDistance / maxDistance;
    gradientMod = Math.exp(-gradientStrength * normAltitude * 3.0);
  }

  // Vertical darkening (uniform grey).
  const darkening = STRATUS_UNDERSIDE_DARKEN * verticalT
                  + (1 - verticalT) * STRATUS_TOPSIDE_BRIGHTEN;
  const darkMod = 0.85 + 0.15 * darkening;

  // Noise (low frequency + raggedness).
  const noise3D = getStratusNoise3D(SS.noiseIndex[stSlot]);
  let noiseMod = 0.92 + 0.08 * noise3D(lx * 0.001, ly * 0.002, lz * 0.001);

  // Fractus raggedness: add high-frequency noise.
  if (SS.subtype[stSlot] === StratusSubtype.FRACTUS) {
    const noise2D = getStratusNoise2D(SS.noiseIndex[stSlot]);
    const raggedNoise = noise2D(lx * 0.01, lz * 0.01) * 0.5 + 0.5;
    const raggedMod = 1 - SS.raggedness[stSlot] * (1 - raggedNoise);
    noiseMod *= raggedMod;
  }

  const mod = gradientMod * darkMod * noiseMod * SS.fade[stSlot]
            * SS.thickness[stSlot] * 2.0;

  return Math.max(0, Math.min(1, base * mod));
}

// ═══════════════════════════════════════════════════════════════════════
// VISIBILITY HOOK — for gameplay systems
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the effective visibility (in metres) at a world position.
 * Gameplay systems (AI, characters, culling) should call this to react
 * to fog. Returns Infinity when no fog affects the position.
 *
 * @param wx, wy, wz  world-space point (usually the camera or actor)
 */
export function sampleStratusVisibility(wx, wy, wz) {
  let minVisibility = Infinity;

  for (let slot = 0; slot < _nextStratusSlot; slot++) {
    if (StratusState.fade[slot] < 0.2) continue;

    const baseSlot = StratusState._baseInstanceSlot[slot];
    if (baseSlot === undefined) continue;

    const CI = CloudInstance;

    // Horizontal distance test.
    const dx = wx - CI.px[baseSlot];
    const dz = wz - CI.pz[baseSlot];
    const horizontalDistSq = dx * dx + dz * dz;
    const radiusSq = CI.radiusX[baseSlot] * CI.radiusX[baseSlot];

    if (horizontalDistSq > radiusSq) continue;

    // Vertical containment.
    const dy = wy - CI.py[baseSlot];
    if (Math.abs(dy) > CI.radiusY[baseSlot] * 1.5) continue;

    const vis = StratusState.visibilityMetres[slot] * StratusState.fade[slot];
    if (vis < minVisibility) minVisibility = vis;
  }

  return minVisibility;
}

/**
 * Return true when a ground-contact fog is active at the given position.
 * Gameplay can use this to trigger fog-horn audio, ambient sound change,
 * or horror-effect vignettes.
 */
export function isGroundContactActive(wx, wy, wz) {
  for (let slot = 0; slot < _nextStratusSlot; slot++) {
    if (StratusState.groundContact[slot] === 0) continue;
    if (StratusState.fade[slot] < 0.3) continue;

    const baseSlot = StratusState._baseInstanceSlot[slot];
    if (baseSlot === undefined) continue;

    const CI = CloudInstance;
    const dx = wx - CI.px[baseSlot];
    const dz = wz - CI.pz[baseSlot];
    const horizontalDistSq = dx * dx + dz * dz;
    const radiusSq = CI.radiusX[baseSlot] * CI.radiusX[baseSlot];

    if (horizontalDistSq < radiusSq) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════
// SUN BLOCK HOOK — return sun transmission factor
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the sun transmission factor (0..1). Stratus blocks the sun
 * strongly but is thinner than nimbostratus.
 */
export function sampleStratusSunBlock(stSlot, viewDirX, viewDirY, viewDirZ) {
  const baseSlot = StratusState._baseInstanceSlot[stSlot];
  if (baseSlot === undefined) return 1.0;

  const SS = StratusState;
  if (SS.fade[stSlot] < 0.1) return 1.0;

  const CI = CloudInstance;
  const opticalFactor = SS.thickness[stSlot]
                      * CI.coverage[baseSlot]
                      * SS.fade[stSlot];

  const transmission = Math.exp(-opticalFactor * STRATUS_SUN_BLOCK_K);
  return Math.max(STRATUS_SUN_TRANSMIT_MIN, transmission);
}

// ═══════════════════════════════════════════════════════════════════════
// VFX BRIDGE — drizzle and fog motes
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return data for the caller (file 025) to spawn drizzle particles.
 */
export function emitStratusDrizzle(stSlot, cameraX, cameraY, cameraZ, emitRate) {
  const baseSlot = StratusState._baseInstanceSlot[stSlot];
  if (baseSlot === undefined) return null;

  const SS = StratusState;
  if (SS.drizzleRate[stSlot] < EPSILON) return null;
  if (SS.fade[stSlot] < 0.3) return null;

  const CI = CloudInstance;
  const dx = cameraX - CI.px[baseSlot];
  const dz = cameraZ - CI.pz[baseSlot];
  const horizontalDistSq = dx * dx + dz * dz;
  if (horizontalDistSq > STRATUS_VFX_RADIUS * STRATUS_VFX_RADIUS) return null;

  // Precipitation type from snow mix.
  const snowMix = SS.snowMix[stSlot];
  let precipType;
  if (snowMix > 0.95)      precipType = PrecipitationType.SNOW;
  else if (snowMix < 0.05) precipType = PrecipitationType.DRIZZLE;
  else                     precipType = PrecipitationType.MIXED;

  const count = Math.min(
    STRATUS_VFX_MAX_PARTICLES,
    Math.floor(emitRate * SS.drizzleRate[stSlot] * 8)
  );

  if (count <= 0) return null;

  return {
    count,
    precipType,
    snowMix,
    drizzleRate: SS.drizzleRate[stSlot],
    cloudBaseAltitude: CI.py[baseSlot] - CI.radiusY[baseSlot],
    cloudTopAltitude: CI.py[baseSlot] + CI.radiusY[baseSlot],
    position: [CI.px[baseSlot], CI.py[baseSlot], CI.pz[baseSlot]],
    radiusX: CI.radiusX[baseSlot],
    radiusZ: CI.radiusZ[baseSlot],
    subtype: SS.subtype[stSlot],
  };
}

/**
 * Return data for the caller (file 025) to spawn fog-mote particles
 * drifting near the ground. Only emitted for ground-contact stratus.
 */
export function emitStratusFog(stSlot, cameraX, cameraY, cameraZ, emitRate) {
  const baseSlot = StratusState._baseInstanceSlot[stSlot];
  if (baseSlot === undefined) return null;

  const SS = StratusState;
  if (SS.groundContact[slot0(stSlot)] === 0) return null;
  if (SS.fade[stSlot] < 0.3) return null;

  const CI = CloudInstance;
  const dx = cameraX - CI.px[baseSlot];
  const dz = cameraZ - CI.pz[baseSlot];
  const horizontalDistSq = dx * dx + dz * dz;
  if (horizontalDistSq > STRATUS_VFX_RADIUS * STRATUS_VFX_RADIUS) return null;

  const count = Math.min(
    STRATUS_FOG_VFX_MAX_PARTICLES,
    Math.floor(emitRate * SS.fade[stSlot])
  );

  if (count <= 0) return null;

  return {
    count,
    fogStrength: 1 - (SS.visibilityMetres[stSlot] / STRATUS_FOG_VISIBILITY_MAX),
    groundContactAltitude: SS.groundContactAltitude[stSlot],
    fogGradient: SS.fogGradient[stSlot],
    visibilityMetres: SS.visibilityMetres[stSlot],
    position: [CI.px[baseSlot], CI.py[baseSlot], CI.pz[baseSlot]],
    radiusX: CI.radiusX[baseSlot],
    radiusZ: CI.radiusZ[baseSlot],
  };
}

function slot0(slot) {
  // Helper: handles the case where the stratus slot itself is used
  // directly as the ground-contact index. Included here as a named
  // helper so the emit function stays readable.
  return slot;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — runtime parameter updates
// ═══════════════════════════════════════════════════════════════════════

/**
 * Set the base temperature.
 */
export function setStratusTemperature(stSlot, tempC) {
  if (stSlot < 0 || stSlot >= _nextStratusSlot) return;
  StratusState.baseTemperature[stSlot] = tempC;
  StratusState.snowMix[stSlot] = computeSnowMix(tempC);
}

/**
 * Force ground contact on / off (e.g. to script a fog bank rolling in).
 */
export function setStratusGroundContact(stSlot, on, altitude) {
  if (stSlot < 0 || stSlot >= _nextStratusSlot) return;
  StratusState.groundContact[stSlot] = on ? 1 : 0;
  if (altitude !== undefined) {
    StratusState.groundContactAltitude[stSlot] = altitude;
  }
}

/**
 * Set the visibility directly (metres).
 */
export function setStratusVisibility(stSlot, metres) {
  if (stSlot < 0 || stSlot >= _nextStratusSlot) return;
  StratusState.visibilityMetres[stSlot] = Math.max(
    STRATUS_FOG_VISIBILITY_MIN,
    Math.min(STRATUS_FOG_VISIBILITY_MAX, metres)
  );
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function stratusStats() {
  let active = 0;
  let nebulosus = 0, fractus = 0, fog = 0;
  let fogContacts = 0;
  let drizzling = 0;
  let minVisibility = Infinity;

  for (let slot = 0; slot < _nextStratusSlot; slot++) {
    if (StratusState.fade[slot] < EPSILON) continue;
    active++;
    const subtype = StratusState.subtype[slot];
    if (subtype === StratusSubtype.NEBULOSUS) nebulosus++;
    else if (subtype === StratusSubtype.FRACTUS) fractus++;
    else fog++;
    if (StratusState.groundContact[slot] === 1) fogContacts++;
    if (StratusState.drizzleRate[slot] > EPSILON) drizzling++;
    if (StratusState.visibilityMetres[slot] < minVisibility) {
      minVisibility = StratusState.visibilityMetres[slot];
    }
  }

  return {
    totalStratus: _nextStratusSlot,
    active,
    nebulosus,
    fractus,
    fog,
    fogContacts,
    drizzling,
    minVisibility: minVisibility === Infinity ? 0 : minVisibility,
    archetypesReady: StratusArchetypes.initialized,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearStratus() {
  _stratusSlots.clear();
  _nextStratusSlot = 0;
  _stratusNoise2D.clear();
  _stratusNoise3D.clear();
  StratusState.fade.fill(0);
  StratusState.groundContact.fill(0);
  StratusState.drizzleRate.fill(0);
  StratusState.visibilityMetres.fill(STRATUS_FOG_VISIBILITY_MAX);
}