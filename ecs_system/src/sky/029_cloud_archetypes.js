// file number : 029
// full path name : src/sky/029_cloud_archetypes.js
// description : Unified cloud archetype core — the single source of truth
//               for every type of fully-parameterised cloud in the new
//               bitECS_max runtime. Provides a SoA CloudArchetype store
//               that captures the complete physical description of all 10
//               WMO cloud genera (Cirrus, Cirrocumulus, Cirrostratus,
//               Altocumulus, Altostratus, Nimbostratus, Stratocumulus,
//               Stratus, Cumulus, Cumulonimbus) plus subtypes — base and
//               top altitude, coverage range, density, optical depth,
//               albedo, Henyey-Greenstein anisotropy, wind vector,
//               evolution timescale, precipitation type and rate,
//               lightning probability, shape descriptors (billow,
//               wispiness, puffiness), shadow strength, silver lining,
//               halo effect, and noise seed. A second SoA CloudInstance
//               store attaches archetypes to world entities and evolves
//               each cloud's age, coverage, density, and precipitation
//               in a zero-allocation pass. The two sampling functions —
//               sampleCloudDensity and sampleCloudScattering — are the
//               hot hooks that file 028's sampleSkyRadiance calls to
//               apply realistic occlusion, in-scattering, and silver
//               linings to any view direction that crosses a cloud. All
//               data lives in typed arrays, and the per-cloud-type
//               modules (030..039) build specialised presets, VFX and
//               shader inputs on top of this core without touching its
//               memory layout.
// best for : Realistic weather systems, volumetric cloud rendering,
//            day/night cycle integration, flight simulator skies,
//            open-world weather, lightning + rain VFX triggering,
//            cloud shadow projection, and any 1M-entity scene that
//            needs correct clouds on Android 64-bit.
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
  SkyTag,
  sampleSkyRadiance,
  getSkySlot,
} from './028_sky_atmosphere.js';

import {
  THREE,
  vec3,
  vec4,
  createNoise2D,
  createNoise3D,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS — verified
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ              = 1e-16;
const EPSILON                 = 1e-8;
const EPSILON_HIGH            = 1e-12;
const PI                      = Math.PI;
const TWO_PI                  = 2 * Math.PI;
const INV_PI                  = 1 / Math.PI;
const INV_TWO_PI              = 1 / (2 * Math.PI);
const HALF_PI                 = Math.PI / 2;
const DEG_TO_RAD              = Math.PI / 180;
const RAD_TO_DEG              = 180 / Math.PI;

const MAX_ARCHETYPES          = 256;
const MAX_INSTANCES           = 100_000;
const MAX_SUBTYPES            = 16;

const DENSITY_SAMPLE_EPSILON  = 1e-4;
const SCATTER_EPSILON         = 1e-5;
const EVOLVE_PHASE_SPEED_MIN  = 1e-3;

// Cloud flags
const FLAG_ACTIVE       = 1 << 0;
const FLAG_PRECIPITATING = 1 << 1;
const FLAG_STORM        = 1 << 2;
const FLAG_LIGHTNING    = 1 << 3;

// ═══════════════════════════════════════════════════════════════════════
// ENUMS
// ═══════════════════════════════════════════════════════════════════════

/**
 * WMO cloud genera — the 10 principal cloud types.
 */
export const CloudType = Object.freeze({
  CIRRUS:         0,   // High, wispy, ice — 6-12 km
  CIRROCUMULUS:   1,   // High, small puff rows — 5-8 km
  CIRROSTRATUS:   2,   // High, uniform veil, halos — 5-9 km
  ALTOCUMULUS:    3,   // Mid, patches / rolls — 2-6 km
  ALTOSTRATUS:    4,   // Mid, uniform gray sheet — 2-6 km
  NIMBOSTRATUS:   5,   // Mid-low, thick rain sheet — 0.5-3 km
  STRATOCUMULUS:  6,   // Low, lumpy gray rolls — 0.5-2 km
  STRATUS:        7,   // Low, uniform fog-like — 0-1 km
  CUMULUS:        8,   // Low, puffy fair-weather — 0.5-2 km
  CUMULONIMBUS:   9,   // Towering storm — 0.5-16 km
});

/**
 * Precipitation type emitted from a cloud.
 */
export const PrecipitationType = Object.freeze({
  NONE:    0,
  DRIZZLE: 1,
  RAIN:    2,
  SNOW:    3,
  HAIL:    4,
  MIXED:   5,
});

/**
 * Cloud subtype modifiers — used by per-cloud-type files (030..039).
 */
export const CloudSubtype = Object.freeze({
  DEFAULT:         0,
  FIBRATUS:        1,   // fibrous (cirrus fibratus)
  UNCINUS:         2,   // hooked (cirrus uncinus)
  CASTELLANUS:     3,   // turreted (altocumulus castellanus)
  LENTICULARIS:    4,   // lens-shaped (altocumulus lenticularis)
  FRACTOFRACTUS:   5,   // ragged (stratus fractus)
  INCUS:           6,   // anvil (cumulonimbus incus)
  MAMMATUS:        7,   // pouch underside
  VERTEBRATUS:     8,   // vertebra (cirrus vertebratus)
  PILEUS:          9,   // cap (cumulus pileus)
  FOG:             10,  // ground fog
});

// ═══════════════════════════════════════════════════════════════════════
// SoA CLOUD ARCHETYPE STORE — every physical parameter
// ═══════════════════════════════════════════════════════════════════════

export const CloudArchetype = {
  // Genus + subtype.
  type:    new Uint8Array(MAX_ARCHETYPES),
  subtype: new Uint8Array(MAX_ARCHETYPES),

  // Altitude range in meters (base .. top).
  baseAltitude: new Float32Array(MAX_ARCHETYPES),
  topAltitude:  new Float32Array(MAX_ARCHETYPES),

  // Coverage range (fraction of sky).
  minCoverage: new Float32Array(MAX_ARCHETYPES),
  maxCoverage: new Float32Array(MAX_ARCHETYPES),

  // Density scale (0.01 = very thin, 1 = opaque).
  density: new Float32Array(MAX_ARCHETYPES),

  // Optical depth (used for shadowing).
  opticalDepth: new Float32Array(MAX_ARCHETYPES),

  // Albedo of cloud particles (linear RGB).
  albedoR: new Float32Array(MAX_ARCHETYPES),
  albedoG: new Float32Array(MAX_ARCHETYPES),
  albedoB: new Float32Array(MAX_ARCHETYPES),

  // Henyey-Greenstein asymmetry (-1 = back scatter, 1 = forward).
  mieG: new Float32Array(MAX_ARCHETYPES),

  // Wind vector (m/s).
  windSpeed: new Float32Array(MAX_ARCHETYPES),
  windDirX:  new Float32Array(MAX_ARCHETYPES),
  windDirY:  new Float32Array(MAX_ARCHETYPES),
  windDirZ:  new Float32Array(MAX_ARCHETYPES),

  // Evolution timescale (seconds for full 0..1 phase).
  evolveSpeed: new Float32Array(MAX_ARCHETYPES),

  // Precipitation.
  precipitationType: new Uint8Array(MAX_ARCHETYPES),
  precipitationRate: new Float32Array(MAX_ARCHETYPES),   // mm / hour

  // Lightning probability (strikes per second per cloud).
  lightningProbability: new Float32Array(MAX_ARCHETYPES),

  // Shape descriptors (0..1 sliders).
  billow:    new Float32Array(MAX_ARCHETYPES),   // puffiness of edges
  wispiness: new Float32Array(MAX_ARCHETYPES),   // streaky / fibrous
  puffiness: new Float32Array(MAX_ARCHETYPES),   // round volumetric

  // Visual effects.
  shadowStrength:  new Float32Array(MAX_ARCHETYPES),
  silverLining:    new Float32Array(MAX_ARCHETYPES),
  haloEffect:      new Float32Array(MAX_ARCHETYPES),

  // Noise seed (used to generate per-archetype noise fields).
  noiseSeed: new Uint32Array(MAX_ARCHETYPES),
};

let _nextArchetypeSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA CLOUD INSTANCE STORE — one per live cloud entity
// ═══════════════════════════════════════════════════════════════════════

export const CloudInstance = {
  archetypeSlot: new Uint16Array(MAX_INSTANCES),
  ownerEid:      new Uint32Array(MAX_INSTANCES),

  // World-space center (read from the owning entity's WorldTransformF32
  // every frame by systemUpdateClouds — this is the cached copy).
  px: new Float32Array(MAX_INSTANCES),
  py: new Float32Array(MAX_INSTANCES),
  pz: new Float32Array(MAX_INSTANCES),

  // Extent (radius in world units).
  radiusX: new Float32Array(MAX_INSTANCES),
  radiusY: new Float32Array(MAX_INSTANCES),
  radiusZ: new Float32Array(MAX_INSTANCES),

  // Animation state.
  age:      new Float32Array(MAX_INSTANCES),
  lifetime: new Float32Array(MAX_INSTANCES),
  phase:    new Float32Array(MAX_INSTANCES),

  // Current coverage (0..1) — interpolated between min and max.
  coverage: new Float32Array(MAX_INSTANCES),

  // Current density (multiplied against archetype's density).
  density: new Float32Array(MAX_INSTANCES),

  // Precip output this frame (mm/h) — used by file 025 particle system.
  precipRate: new Float32Array(MAX_INSTANCES),

  // Visibility (0..1) — fades in / out.
  visibility: new Float32Array(MAX_INSTANCES),

  // Flags: ACTIVE / PRECIPITATING / STORM / LIGHTNING.
  flags: new Uint8Array(MAX_INSTANCES),
};

/** Marker: entity is a cloud instance. */
export const CloudTag = {};

const _instanceSlots = new Map(); // eid -> instance slot
let _nextInstanceSlot = 0;

// Per-archetype noise generators (lazily created).
const _archetypeNoise3D = new Map(); // archetypeSlot -> noise3D
const _archetypeNoise2D = new Map(); // archetypeSlot -> noise2D

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

function getArchetypeNoise3D(slot) {
  let n = _archetypeNoise3D.get(slot);
  if (!n) {
    const seed = CloudArchetype.noiseSeed[slot];
    n = createNoise3D(() => mulberry32(seed));
    _archetypeNoise3D.set(slot, n);
  }
  return n;
}

function getArchetypeNoise2D(slot) {
  let n = _archetypeNoise2D.get(slot);
  if (!n) {
    const seed = CloudArchetype.noiseSeed[slot] ^ 0xA5A5A5A5;
    n = createNoise2D(() => mulberry32(seed));
    _archetypeNoise2D.set(slot, n);
  }
  return n;
}

// ═══════════════════════════════════════════════════════════════════════
// ARCHETYPE CREATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a new cloud archetype. Any field omitted falls back to a
 * per-genus default from `defaultsForType(type)`.
 *
 * @param type        CloudType
 * @param subtype     CloudSubtype
 * @param overrides   { any CloudArchetype field }
 * @returns archetype slot id
 */
export function createCloudArchetype(type, subtype = CloudSubtype.DEFAULT, overrides = {}) {
  if (_nextArchetypeSlot >= MAX_ARCHETYPES) {
    throw new Error('cloud archetype capacity exceeded');
  }
  const slot = _nextArchetypeSlot++;
  const defaults = defaultsForType(type);
  const C = CloudArchetype;

  C.type[slot]    = type;
  C.subtype[slot] = subtype;

  C.baseAltitude[slot] = overrides.baseAltitude ?? defaults.baseAltitude;
  C.topAltitude[slot]  = overrides.topAltitude  ?? defaults.topAltitude;

  C.minCoverage[slot] = overrides.minCoverage ?? defaults.minCoverage;
  C.maxCoverage[slot] = overrides.maxCoverage ?? defaults.maxCoverage;

  C.density[slot]      = overrides.density      ?? defaults.density;
  C.opticalDepth[slot] = overrides.opticalDepth ?? defaults.opticalDepth;

  C.albedoR[slot] = overrides.albedoR ?? defaults.albedoR;
  C.albedoG[slot] = overrides.albedoG ?? defaults.albedoG;
  C.albedoB[slot] = overrides.albedoB ?? defaults.albedoB;

  C.mieG[slot] = overrides.mieG ?? defaults.mieG;

  C.windSpeed[slot] = overrides.windSpeed ?? defaults.windSpeed;
  C.windDirX[slot]  = overrides.windDirX  ?? defaults.windDirX;
  C.windDirY[slot]  = overrides.windDirY  ?? defaults.windDirY;
  C.windDirZ[slot]  = overrides.windDirZ  ?? defaults.windDirZ;

  C.evolveSpeed[slot] = overrides.evolveSpeed ?? defaults.evolveSpeed;

  C.precipitationType[slot] = overrides.precipitationType ?? defaults.precipitationType;
  C.precipitationRate[slot] = overrides.precipitationRate ?? defaults.precipitationRate;

  C.lightningProbability[slot] = overrides.lightningProbability ?? defaults.lightningProbability;

  C.billow[slot]    = overrides.billow    ?? defaults.billow;
  C.wispiness[slot] = overrides.wispiness ?? defaults.wispiness;
  C.puffiness[slot] = overrides.puffiness ?? defaults.puffiness;

  C.shadowStrength[slot] = overrides.shadowStrength ?? defaults.shadowStrength;
  C.silverLining[slot]   = overrides.silverLining   ?? defaults.silverLining;
  C.haloEffect[slot]     = overrides.haloEffect     ?? defaults.haloEffect;

  C.noiseSeed[slot] = overrides.noiseSeed ?? ((slot * 2654435761) >>> 0);

  return slot;
}

// ═══════════════════════════════════════════════════════════════════════
// PER-GENUS DEFAULTS
// ═══════════════════════════════════════════════════════════════════════
//
// Values chosen from meteorological literature (WMO International Cloud
// Atlas 2017, Houze 2014 Cloud Dynamics). All altitudes in metres,
// wind speeds in m/s, precipitation in mm/h.

function defaultsForType(type) {
  switch (type) {
    case CloudType.CIRRUS:
      return {
        baseAltitude: 6000, topAltitude: 12000,
        minCoverage: 0.05, maxCoverage: 0.4,
        density: 0.02, opticalDepth: 0.2,
        albedoR: 1.00, albedoG: 1.00, albedoB: 1.00,
        mieG: 0.70,
        windSpeed: 30, windDirX: 1, windDirY: 0, windDirZ: 0,
        evolveSpeed: 1 / 300,
        precipitationType: PrecipitationType.NONE, precipitationRate: 0,
        lightningProbability: 0,
        billow: 0.1, wispiness: 0.95, puffiness: 0.05,
        shadowStrength: 0.05, silverLining: 0.1, haloEffect: 0.0,
      };

    case CloudType.CIRROCUMULUS:
      return {
        baseAltitude: 5000, topAltitude: 8000,
        minCoverage: 0.05, maxCoverage: 0.3,
        density: 0.05, opticalDepth: 0.4,
        albedoR: 1.00, albedoG: 1.00, albedoB: 1.00,
        mieG: 0.6,
        windSpeed: 25, windDirX: 1, windDirY: 0, windDirZ: 0,
        evolveSpeed: 1 / 240,
        precipitationType: PrecipitationType.NONE, precipitationRate: 0,
        lightningProbability: 0,
        billow: 0.3, wispiness: 0.5, puffiness: 0.4,
        shadowStrength: 0.08, silverLining: 0.15, haloEffect: 0.0,
      };

    case CloudType.CIRROSTRATUS:
      return {
        baseAltitude: 5000, topAltitude: 9000,
        minCoverage: 0.6, maxCoverage: 1.0,
        density: 0.04, opticalDepth: 0.6,
        albedoR: 0.98, albedoG: 0.99, albedoB: 1.00,
        mieG: 0.5,
        windSpeed: 20, windDirX: 1, windDirY: 0, windDirZ: 0,
        evolveSpeed: 1 / 600,
        precipitationType: PrecipitationType.NONE, precipitationRate: 0,
        lightningProbability: 0,
        billow: 0.05, wispiness: 0.7, puffiness: 0.1,
        shadowStrength: 0.15, silverLining: 0.2, haloEffect: 0.9,
      };

    case CloudType.ALTOCUMULUS:
      return {
        baseAltitude: 2000, topAltitude: 6000,
        minCoverage: 0.2, maxCoverage: 0.7,
        density: 0.15, opticalDepth: 1.2,
        albedoR: 0.98, albedoG: 0.98, albedoB: 0.98,
        mieG: 0.55,
        windSpeed: 15, windDirX: 1, windDirY: 0, windDirZ: 0,
        evolveSpeed: 1 / 180,
        precipitationType: PrecipitationType.NONE, precipitationRate: 0,
        lightningProbability: 0,
        billow: 0.6, wispiness: 0.2, puffiness: 0.7,
        shadowStrength: 0.25, silverLining: 0.3, haloEffect: 0.1,
      };

    case CloudType.ALTOSTRATUS:
      return {
        baseAltitude: 2000, topAltitude: 6000,
        minCoverage: 0.7, maxCoverage: 1.0,
        density: 0.25, opticalDepth: 2.0,
        albedoR: 0.90, albedoG: 0.92, albedoB: 0.94,
        mieG: 0.5,
        windSpeed: 12, windDirX: 1, windDirY: 0, windDirZ: 0,
        evolveSpeed: 1 / 400,
        precipitationType: PrecipitationType.DRIZZLE, precipitationRate: 0.2,
        lightningProbability: 0,
        billow: 0.15, wispiness: 0.3, puffiness: 0.3,
        shadowStrength: 0.4, silverLining: 0.15, haloEffect: 0.05,
      };

    case CloudType.NIMBOSTRATUS:
      return {
        baseAltitude: 500, topAltitude: 3000,
        minCoverage: 0.85, maxCoverage: 1.0,
        density: 0.7, opticalDepth: 6.0,
        albedoR: 0.72, albedoG: 0.74, albedoB: 0.76,
        mieG: 0.4,
        windSpeed: 10, windDirX: 1, windDirY: 0, windDirZ: 0,
        evolveSpeed: 1 / 900,
        precipitationType: PrecipitationType.RAIN, precipitationRate: 5.0,
        lightningProbability: 0.001,
        billow: 0.2, wispiness: 0.1, puffiness: 0.3,
        shadowStrength: 0.7, silverLining: 0.05, haloEffect: 0,
      };

    case CloudType.STRATOCUMULUS:
      return {
        baseAltitude: 500, topAltitude: 2000,
        minCoverage: 0.3, maxCoverage: 0.8,
        density: 0.4, opticalDepth: 3.0,
        albedoR: 0.85, albedoG: 0.86, albedoB: 0.88,
        mieG: 0.5,
        windSpeed: 8, windDirX: 1, windDirY: 0, windDirZ: 0,
        evolveSpeed: 1 / 240,
        precipitationType: PrecipitationType.DRIZZLE, precipitationRate: 0.5,
        lightningProbability: 0.0001,
        billow: 0.7, wispiness: 0.1, puffiness: 0.6,
        shadowStrength: 0.5, silverLining: 0.2, haloEffect: 0,
      };

    case CloudType.STRATUS:
      return {
        baseAltitude: 0, topAltitude: 1000,
        minCoverage: 0.7, maxCoverage: 1.0,
        density: 0.35, opticalDepth: 2.5,
        albedoR: 0.8, albedoG: 0.82, albedoB: 0.84,
        mieG: 0.45,
        windSpeed: 5, windDirX: 1, windDirY: 0, windDirZ: 0,
        evolveSpeed: 1 / 600,
        precipitationType: PrecipitationType.DRIZZLE, precipitationRate: 0.3,
        lightningProbability: 0,
        billow: 0.1, wispiness: 0.05, puffiness: 0.2,
        shadowStrength: 0.45, silverLining: 0.1, haloEffect: 0,
      };

    case CloudType.CUMULUS:
      return {
        baseAltitude: 500, topAltitude: 2000,
        minCoverage: 0.1, maxCoverage: 0.4,
        density: 0.5, opticalDepth: 3.0,
        albedoR: 0.95, albedoG: 0.96, albedoB: 0.97,
        mieG: 0.6,
        windSpeed: 6, windDirX: 1, windDirY: 0, windDirZ: 0,
        evolveSpeed: 1 / 120,
        precipitationType: PrecipitationType.RAIN, precipitationRate: 0.5,
        lightningProbability: 0.0005,
        billow: 0.9, wispiness: 0.05, puffiness: 0.95,
        shadowStrength: 0.4, silverLining: 0.6, haloEffect: 0,
      };

    case CloudType.CUMULONIMBUS:
      return {
        baseAltitude: 500, topAltitude: 16000,
        minCoverage: 0.15, maxCoverage: 0.6,
        density: 0.9, opticalDepth: 12.0,
        albedoR: 0.6, albedoG: 0.62, albedoB: 0.65,
        mieG: 0.55,
        windSpeed: 12, windDirX: 1, windDirY: 0, windDirZ: 0,
        evolveSpeed: 1 / 300,
        precipitationType: PrecipitationType.RAIN, precipitationRate: 25.0,
        lightningProbability: 0.05,
        billow: 0.9, wispiness: 0.1, puffiness: 0.9,
        shadowStrength: 0.9, silverLining: 0.8, haloEffect: 0,
      };

    default:
      return {
        baseAltitude: 1000, topAltitude: 2000,
        minCoverage: 0.2, maxCoverage: 0.6,
        density: 0.3, opticalDepth: 1.5,
        albedoR: 0.9, albedoG: 0.9, albedoB: 0.9,
        mieG: 0.5,
        windSpeed: 5, windDirX: 1, windDirY: 0, windDirZ: 0,
        evolveSpeed: 1 / 180,
        precipitationType: PrecipitationType.NONE, precipitationRate: 0,
        lightningProbability: 0,
        billow: 0.5, wispiness: 0.5, puffiness: 0.5,
        shadowStrength: 0.3, silverLining: 0.2, haloEffect: 0,
      };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// CLOUD INSTANCE API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Attach a cloud instance to an entity.
 *
 * @param world         ECS world
 * @param eid           entity (must have WorldTransformF32 — usually
 *                      already created via addTransform in file 002)
 * @param archetypeSlot archetype id from createCloudArchetype
 * @param options       { radiusX, radiusY, radiusZ, lifetime,
 *                        initialCoverage }
 * @returns instance slot id
 */
export function addCloudInstance(world, eid, archetypeSlot, options = {}) {
  if (_nextInstanceSlot >= MAX_INSTANCES) {
    throw new Error('cloud instance capacity exceeded');
  }
  if (archetypeSlot < 0 || archetypeSlot >= _nextArchetypeSlot) {
    throw new Error(`addCloudInstance: invalid archetype ${archetypeSlot}`);
  }
  const slot = _nextInstanceSlot++;

  addComponent(world, eid, CloudTag);

  const I = CloudInstance;
  const A = CloudArchetype;

  I.archetypeSlot[slot] = archetypeSlot;
  I.ownerEid[slot] = eid;

  // Read world position from entity.
  const id = getId(eid);
  I.px[slot] = LocalTransformF32.px[id] ?? 0;
  I.py[slot] = LocalTransformF32.py[id] ?? A.baseAltitude[archetypeSlot];
  I.pz[slot] = LocalTransformF32.pz[id] ?? 0;

  I.radiusX[slot] = options.radiusX ?? 2000;
  I.radiusY[slot] = options.radiusY ?? ((A.topAltitude[archetypeSlot] - A.baseAltitude[archetypeSlot]) * 0.5);
  I.radiusZ[slot] = options.radiusZ ?? 2000;

  I.age[slot] = 0;
  I.lifetime[slot] = options.lifetime ?? 3600;
  I.phase[slot] = 0;

  const initialCoverage = options.initialCoverage
    ?? (A.minCoverage[archetypeSlot] + A.maxCoverage[archetypeSlot]) * 0.5;
  I.coverage[slot] = initialCoverage;
  I.density[slot] = A.density[archetypeSlot];
  I.precipRate[slot] = 0;
  I.visibility[slot] = 1.0;

  let flags = FLAG_ACTIVE;
  if (A.precipitationType[archetypeSlot] !== PrecipitationType.NONE) {
    flags |= FLAG_PRECIPITATING;
  }
  if (archetypeSlot < _nextArchetypeSlot
      && CloudArchetype.type[archetypeSlot] === CloudType.CUMULONIMBUS) {
    flags |= FLAG_STORM;
  }
  I.flags[slot] = flags;

  _instanceSlots.set(eid, slot);
  return slot;
}

export function removeCloudInstance(world, eid) {
  const slot = _instanceSlots.get(eid);
  if (slot === undefined) return;
  _instanceSlots.delete(eid);
  CloudInstance.flags[slot] = 0;
  CloudInstance.ownerEid[slot] = 0;
  removeComponent(world, eid, CloudTag);
}

export function getCloudSlot(eid) {
  return _instanceSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// DENSITY SAMPLING — volumetric cloud density at a world point
// ═══════════════════════════════════════════════════════════════════════

const _densityNoise = vec3.create();

/**
 * Sample the volumetric density of a single cloud instance at a world
 * point (wx, wy, wz). Returns a normalised 0..1 value.
 *
 * Combines:
 *   - ellipsoid falloff (hard boundary of the cloud volume)
 *   - vertical profile (denser at the base, thinner at the top)
 *   - per-archetype 3D noise (billow, wispiness, puffiness)
 *   - current coverage scaling
 */
export function sampleInstanceDensity(instanceSlot, wx, wy, wz) {
  const I = CloudInstance;
  const A = CloudArchetype;
  if (!(I.flags[instanceSlot] & FLAG_ACTIVE)) return 0;
  if (I.visibility[instanceSlot] < EPSILON) return 0;

  const aSlot = I.archetypeSlot[instanceSlot];

  // Ellipsoid containment.
  const dx = (wx - I.px[instanceSlot]) / I.radiusX[instanceSlot];
  const dy = (wy - I.py[instanceSlot]) / I.radiusY[instanceSlot];
  const dz = (wz - I.pz[instanceSlot]) / I.radiusZ[instanceSlot];
  const ellipsoidSq = dx * dx + dy * dy + dz * dz;

  if (ellipsoidSq > 1.0) return 0;

  // Core shape falloff (soft edges).
  const falloff = 1.0 - ellipsoidSq;

  // Vertical profile: dense base, wispy top.
  const verticalT = (dy + 1) * 0.5;  // 0 = top, 1 = base
  let verticalProfile = 0.6 + 0.4 * verticalT;

  // Noise.
  const noise = getArchetypeNoise3D(aSlot);
  const windPhase = I.age[instanceSlot] * (A.windSpeed[aSlot] / Math.max(A.baseAltitude[aSlot], 100));

  const billow = A.billow[aSlot];
  const wispy = A.wispiness[aSlot];
  const puffy = A.puffiness[aSlot];

  // Low-frequency shape.
  let shape = noise(
    dx * 2.0 + windPhase,
    dy * 3.0,
    dz * 2.0 - windPhase
  );
  shape = shape * 0.5 + 0.5;

  // High-frequency billow (puffy edges).
  let billowNoise = noise(
    dx * 6.0 + windPhase * 1.5,
    dy * 8.0 + I.phase[instanceSlot],
    dz * 6.0 - windPhase * 1.5
  );
  billowNoise = billowNoise * 0.5 + 0.5;

  // Wispiness (streaky).
  const wispyNoise = noise(dx * 12.0, dy * 1.0, dz * 12.0) * 0.5 + 0.5;

  // Combine.
  let density = shape;
  density = density * (1.0 - billow) + (density * billowNoise) * billow;
  density = density * (1.0 - wispy) + (density * wispyNoise) * wispy;
  density = density * puffy + density * (1.0 - puffy) * 0.7;

  density *= falloff * verticalProfile;
  density *= I.coverage[instanceSlot];
  density *= I.density[instanceSlot];
  density *= I.visibility[instanceSlot];

  return Math.max(0, Math.min(1, density));
}

/**
 * Sample total cloud density at a world point across all active
 * instances. This is the hot hook that file 028's integrator calls
 * per ray step.
 */
export function sampleCloudDensity(wx, wy, wz) {
  let total = 0;

  for (let slot = 0; slot < _nextInstanceSlot; slot++) {
    if (!(CloudInstance.flags[slot] & FLAG_ACTIVE)) continue;

    // Quick AABB reject.
    if (Math.abs(wx - CloudInstance.px[slot]) > CloudInstance.radiusX[slot]) continue;
    if (Math.abs(wy - CloudInstance.py[slot]) > CloudInstance.radiusY[slot]) continue;
    if (Math.abs(wz - CloudInstance.pz[slot]) > CloudInstance.radiusZ[slot]) continue;

    const d = sampleInstanceDensity(slot, wx, wy, wz);
    if (d > DENSITY_SAMPLE_EPSILON) total += d;
    if (total >= 1.0) return 1.0;
  }

  return Math.min(total, 1.0);
}

// ═══════════════════════════════════════════════════════════════════════
// SCATTERING — single-scatter contribution from a cloud to a view ray
// ═══════════════════════════════════════════════════════════════════════

/**
 * Henyey-Greenstein phase function.
 */
function hgPhase(g, cosTheta) {
  const denom = 1 + g * g - 2 * g * cosTheta;
  if (denom < SCATTER_EPSILON) return 0;
  const denomPow = denom * Math.sqrt(denom);
  return (1 - g * g) / (4 * PI * denomPow);
}

/**
 * Approximate single-scatter from all clouds along a ray.
 * Called by file 028's sampleSkyRadiance when a view ray crosses a
 * cloud region. Returns [r, g, b] additive contribution.
 *
 * @param viewDirX/Y/Z   normalised view direction
 * @param sunDirX/Y/Z    normalised sun direction (from sky)
 * @param sunColorR/G/B  linear sun colour
 * @param skySlot        the sky that owns this query (for sun direction)
 */
export function sampleCloudScattering(viewDirX, viewDirY, viewDirZ, skySlot) {
  if (_nextInstanceSlot === 0) return [0, 0, 0];

  // March along the ray through each cloud's bounding ellipsoid, accumulate
  // in-scatter. Simplified: 3-step integration per cloud.
  const steps = 3;
  let r = 0, g = 0, b = 0;

  const S = SkyF32;
  const sunDirX = S.sunDirX[skySlot];
  const sunDirY = S.sunDirY[skySlot];
  const sunDirZ = S.sunDirZ[skySlot];

  const cosSunView = viewDirX * sunDirX
                   + viewDirY * sunDirY
                   + viewDirZ * sunDirZ;

  for (let slot = 0; slot < _nextInstanceSlot; slot++) {
    if (!(CloudInstance.flags[slot] & FLAG_ACTIVE)) continue;

    const I = CloudInstance;
    const A = CloudArchetype;
    const aSlot = I.archetypeSlot[slot];

    // Ray-vs-ellipsoid intersection in normalised space.
    const ox = (0 - I.px[slot]) / I.radiusX[slot];
    const oy = (0 - I.py[slot]) / I.radiusY[slot];
    const oz = (0 - I.pz[slot]) / I.radiusZ[slot];

    const dx = viewDirX / I.radiusX[slot];
    const dy = viewDirY / I.radiusY[slot];
    const dz = viewDirZ / I.radiusZ[slot];

    const a = dx * dx + dy * dy + dz * dz;
    const bCoef = 2 * (ox * dx + oy * dy + oz * dz);
    const c = ox * ox + oy * oy + oz * oz - 1;

    const disc = bCoef * bCoef - 4 * a * c;
    if (disc <= 0) continue;

    const sqrtDisc = Math.sqrt(disc);
    const t0 = (-bCoef - sqrtDisc) / (2 * a);
    const t1 = (-bCoef + sqrtDisc) / (2 * a);
    if (t1 <= 0) continue;

    const tStart = Math.max(t0, 0);
    const tEnd = t1;

    // March steps inside the cloud.
    const dt = (tEnd - tStart) / steps;
    let localDensity = 0;
    for (let step = 0; step < steps; step++) {
      const t = tStart + (step + 0.5) * dt;
      const wx = viewDirX * t;
      const wy = viewDirY * t;
      const wz = viewDirZ * t;
      const d = sampleInstanceDensity(slot, wx + 0, wy + 0, wz + 0);
      localDensity += d;
    }
    localDensity /= steps;

    if (localDensity < SCATTER_EPSILON) continue;

    // Phase at the sun-view angle.
    const phase = hgPhase(A.mieG[aSlot], cosSunView);

    // Combine with cloud albedo.
    const albR = A.albedoR[aSlot];
    const albG = A.albedoG[aSlot];
    const albB = A.albedoB[aSlot];

    // Silver lining: bright when back-lit.
    const silverFactor = A.silverLining[aSlot] * Math.max(0, -cosSunView);

    r += localDensity * (albR + silverFactor) * phase * 0.5;
    g += localDensity * (albG + silverFactor) * phase * 0.5;
    b += localDensity * (albB + silverFactor) * phase * 0.5;
  }

  return [r, g, b];
}

// ═══════════════════════════════════════════════════════════════════════
// EVOLUTION SYSTEM — advance per-instance state every frame
// ═══════════════════════════════════════════════════════════════════════

/**
 * Evolve all active cloud instances.
 *
 * Per-instance work is O(1):
 *   - advance age
 *   - advance phase
 *   - update coverage via sin-wave between min and max
 *   - advect position by wind vector
 *   - update precipitation rate
 *   - trigger lightning
 */
export function systemUpdateClouds(world, dt) {
  const I = CloudInstance;
  const A = CloudArchetype;

  for (let slot = 0; slot < _nextInstanceSlot; slot++) {
    if (!(I.flags[slot] & FLAG_ACTIVE)) continue;

    const ownerEid = I.ownerEid[slot];
    if (!ownerEid || !entityExists(world, ownerEid)) {
      I.flags[slot] = 0;
      continue;
    }

    const aSlot = I.archetypeSlot[slot];

    // Advance age + phase.
    I.age[slot] += dt;
    const evolveSpeed = Math.max(A.evolveSpeed[aSlot], EVOLVE_PHASE_SPEED_MIN);
    I.phase[slot] += dt * evolveSpeed;
    if (I.phase[slot] > 1) I.phase[slot] -= Math.floor(I.phase[slot]);

    // Coverage interpolation.
    const coverageWave = 0.5 - 0.5 * Math.cos(I.phase[slot] * TWO_PI);
    I.coverage[slot] = A.minCoverage[aSlot]
                     + (A.maxCoverage[aSlot] - A.minCoverage[aSlot]) * coverageWave;

    // Density scale follows coverage.
    I.density[slot] = A.density[aSlot] * (0.5 + 0.5 * I.coverage[slot]);

    // Wind advection.
    const windSpeed = A.windSpeed[aSlot];
    if (windSpeed > EPSILON) {
      I.px[slot] += A.windDirX[aSlot] * windSpeed * dt;
      I.pz[slot] += A.windDirZ[aSlot] * windSpeed * dt;
    }

    // Write position back to the entity's LocalTransformF32 so its BVH
    // proxy (file 003) and world bounds (file 004) track correctly.
    const id = getId(ownerEid);
    LocalTransformF32.px[id] = I.px[slot];
    LocalTransformF32.py[id] = I.py[slot];
    LocalTransformF32.pz[id] = I.pz[slot];
    markDirty(ownerEid);

    // Precipitation output (feeds file 025's particle system).
    if ((I.flags[slot] & FLAG_PRECIPITATING) !== 0) {
      const precipType = A.precipitationType[aSlot];
      const precipRate = A.precipitationRate[aSlot] * I.coverage[slot] * I.density[slot];
      I.precipRate[slot] = precipRate;

      // Strike triggers: hand off to file 026 for observer dispatch.
      if (A.lightningProbability[aSlot] > 0) {
        if (Math.random() < A.lightningProbability[aSlot] * dt) {
          I.flags[slot] |= FLAG_LIGHTNING;
        } else {
          I.flags[slot] &= ~FLAG_LIGHTNING;
        }
      }
    } else {
      I.precipRate[slot] = 0;
    }

    // Auto-kill if lifetime expired (non-storm clouds only).
    if ((I.flags[slot] & FLAG_STORM) === 0 && I.age[slot] > I.lifetime[slot]) {
      removeCloudInstance(world, ownerEid);
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// INTEGRATION WITH 028 — apply clouds to sky radiance
// ═══════════════════════════════════════════════════════════════════════

/**
 * Composite cloud contribution into a sky radiance call. Wraps
 * sampleSkyRadiance from file 028 so callers see cloud shadows and
 * in-scatter without changing their code.
 *
 * NOTE: file 028's sampleSkyRadiance already calls sampleSkyRadiance
 * (its own internal cloud hook, from 028) — this function is the
 * higher-level composite used by external integrators like file 017.
 *
 * @returns [r, g, b]
 */
export function sampleSkyWithClouds(skySlot, dirX, dirY, dirZ) {
  // Base sky.
  const sky = sampleSkyRadiance(skySlot, dirX, dirY, dirZ);

  // Cloud in-scatter.
  const cloud = sampleCloudScattering(dirX, dirY, dirZ, skySlot);

  // Cloud occlusion (darkens sky behind cloud).
  const density = sampleCloudDensity(
    dirX * 1000, dirY * 1000 + 5000, dirZ * 1000
  );

  const skyAttenR = sky[0] * (1 - density);
  const skyAttenG = sky[1] * (1 - density);
  const skyAttenB = sky[2] * (1 - density);

  return [
    skyAttenR + cloud[0],
    skyAttenG + cloud[1],
    skyAttenB + cloud[2],
  ];
}

// ═══════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return an array of instance slots currently in STORM state (used by
 * file 025 to spawn rain particle bursts, or by file 026 to fire
 * lightning observers).
 */
export function getStormInstances() {
  const storms = [];
  for (let slot = 0; slot < _nextInstanceSlot; slot++) {
    if ((CloudInstance.flags[slot] & FLAG_STORM) !== 0
        && (CloudInstance.flags[slot] & FLAG_ACTIVE) !== 0) {
      storms.push(slot);
    }
  }
  return storms;
}

/**
 * Return the total precipitation output (mm/h) of all active clouds
 * at a given world position. Feeds weather audio / VFX systems.
 */
export function getPrecipitationAt(wx, wy, wz) {
  let total = 0;
  for (let slot = 0; slot < _nextInstanceSlot; slot++) {
    if ((CloudInstance.flags[slot] & FLAG_PRECIPITATING) === 0) continue;
    if (Math.abs(wx - CloudInstance.px[slot]) > CloudInstance.radiusX[slot]) continue;
    if (Math.abs(wz - CloudInstance.pz[slot]) > CloudInstance.radiusZ[slot]) continue;
    total += CloudInstance.precipRate[slot];
  }
  return total;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearCloudSystem() {
  _nextArchetypeSlot = 0;
  _nextInstanceSlot = 0;
  _instanceSlots.clear();
  _archetypeNoise3D.clear();
  _archetypeNoise2D.clear();

  CloudArchetype.type.fill(0);
  CloudInstance.flags.fill(0);
  CloudInstance.ownerEid.fill(0);
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function cloudStats() {
  let activeInstances = 0;
  let stormInstances = 0;
  let precipitatingInstances = 0;

  for (let slot = 0; slot < _nextInstanceSlot; slot++) {
    if ((CloudInstance.flags[slot] & FLAG_ACTIVE) === 0) continue;
    activeInstances++;
    if ((CloudInstance.flags[slot] & FLAG_STORM) !== 0) stormInstances++;
    if ((CloudInstance.flags[slot] & FLAG_PRECIPITATING) !== 0) precipitatingInstances++;
  }

  return {
    archetypeCount: _nextArchetypeSlot,
    instanceCount: _nextInstanceSlot,
    activeInstances,
    stormInstances,
    precipitatingInstances,
    archetypeNoiseCache: _archetypeNoise3D.size,
  };
}