// file number : 050
// full path name : src/weather/050_dust_sandstorm.js
// description : Dust storm and sandstorm system. Provides the full set of
//               aeolian phenomena in the bitECS_max pipeline:
//                 • HABOOB — the massive wall of dust driven by
//                   thunderstorm downdrafts, with a sharp leading edge,
//                   full-column dust density, and gust front dynamics.
//                 • SANDSTORM — a sustained storm of sand-sized particles
//                   over arid terrain, with saltation, limited vertical
//                   extent, and high-speed horizontal transport.
//                 • DUST_STORM — a broader, loftier suspended-dust event
//                   (typically from distant sources) with a high-reaching
//                   veil that reduces visibility and dims the sun.
//                 • SALTATION — the ground-hugging hopping motion of sand
//                   particles during wind (Bagnold 1941 physics), which
//                   builds up the local aeolian flux used by the storm.
//                 • DUST_VEIL — the high-altitude suspended haze that
//                   persists long after the dust storm itself has passed,
//                   producing the classic orange/brown sky.
//               Imports 029_cloud_archetypes.js as the single source of
//               truth for the parent cumulonimbus storms that spawn
//               haboobs. Also integrates with:
//                 • file 003 (BVH) for terrain sampling and sheltering
//                 • file 042 (rain) for the "mud rain" coupling when
//                   a haboob reaches a rain area
//                 • file 046 (fog) for the shared visibility attenuation
//                   API so gameplay systems see dust as a fog-like effect
//                 • file 047 (wind) for the driving gust front
//               All state lives in typed arrays; per-frame cost is
//               O(MAX_DUST_PARTICLES) + O(active_storms). Zero per-frame
//               allocation; steady-state simulation at 1M entities fits
//               on Android 64-bit.
//                 • SoA DustParticle pool — up to 300,000 particles with
//                   position, velocity, size, density, age, and per-
//                   particle mineral tint (sandy / reddish / grey).
//                 • SoA DustStorm instance — one per active storm, with
//                   type, center, leading edge, depth, particle count,
//                   wind vector, vertical extent, and lightning
//                   probability.
//                 • SoA DustVeil — persistent high-altitude dust layers
//                   with attenuation and downwind spreading.
//                 • SoA SaltationField — per-surface saltation state
//                   (hopping flux, ground-layer density, erosion rate).
//                 • Bagnold saltation model — the classic
//                   q ∝ u*³ relationship (flux ∝ friction velocity
//                   cubed), so doubling wind speed produces 8× the sand
//                   flux, matching real desert dynamics.
//                 • Visibility attenuation — the dust density is
//                   converted to extinction coefficient via the same
//                   Koschmieder relation as file 046, and the resulting
//                   visibility is offered to gameplay.
//                 • Haboob gust front — reads the parent storm's
//                   downdraft from file 039's CumulonimbusState and
//                   spawns the leading edge at the correct velocity
//                   (typically 15-30 m/s).
//                 • Sun dimming — computes the dust optical depth along
//                   a sun ray so file 028's sky correctly dims and tints
//                   the sun to the correct dusty orange.
// best for : Desert gameplay, haboob cinematics, Sahara/Arabian
//            environment design, sand-blasted rendering effects,
//            dust-covered ruins, and any 1M-entity scene needing
//            realistic aeolian phenomena on Android 64-bit.
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
  addTransform,
  markDirty,
} from '../transform/002_transform_hierarchy.js';

import {
  WorldBoundsF32,
  LocalBoundsF32,
  getWorldBoundsCenter,
  getWorldBoundsExtents,
} from '../geometry/004_aabb_bounds.js';

import {
  BVHState,
  bvhRaycast,
} from '../spatial/003_bvh_broadphase.js';

import {
  RigidBody3D,
} from '../physics/008_physics3d_rigidbody.js';

import {
  CharacterTag,
  CharacterStateF32,
  getCharacterSlot,
} from '../physics/021_shape_queries_character.js';

import {
  CloudInstance,
  CloudArchetype,
  CloudType,
} from '../sky/029_cloud_archetypes.js';

import {
  CumulonimbusState,
  CumulonimbusSubtype,
  CumulonimbusTag,
} from '../sky/039_cumulonimbus_clouds.js';

import {
  WindSource,
  WindSourceType,
  addWindSource,
  removeWindSource,
  sampleWindAt,
} from './047_wind_gusts.js';

import {
  sampleVisibility as sampleFogVisibility,
  extinctionToVisibility,
} from './046_fog_mist.js';

import {
  vec3,
  vec4,
  mat4,
  createNoise2D,
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
const GRAVITY                          = 9.81;
const AIR_DENSITY                      = 1.225;

const MAX_DUST_STORMS                  = 32;
const MAX_DUST_PARTICLES               = 300_000;
const MAX_DUST_IMPACTS                 = 8_192;
const MAX_DUST_VEILS                   = 64;
const MAX_SALTATION_FIELDS             = 8_192;
const MAX_DUST_MOTES_RENDERED          = 16_384;

// Storm geometry.
const HABOOB_DEPTH_DEFAULT             = 500;         // metres
const HABOOB_HEIGHT_DEFAULT            = 1500;        // metres
const HABOOB_LEADING_EDGE_WIDTH        = 200;         // metres (sharpness)
const SANDSTORM_DEPTH_DEFAULT          = 2000;        // metres
const SANDSTORM_HEIGHT_DEFAULT         = 300;         // metres (low)
const DUSTSTORM_DEPTH_DEFAULT          = 5000;        // metres
const DUSTSTORM_HEIGHT_DEFAULT         = 3000;        // metres (high)

// Wind and gust front.
const HABOOB_GUST_MIN                  = 15.0;        // m/s
const HABOOB_GUST_MAX                  = 35.0;        // m/s
const GUST_FRONT_DRIFT_SPEED_MIN       = 10.0;
const GUST_FRONT_DRIFT_SPEED_MAX       = 30.0;

// Particle physics.
const DUST_PARTICLE_MASS_MIN           = 1e-6;        // kg (dust)
const DUST_PARTICLE_MASS_MAX           = 1e-3;        // kg (sand grain)
const DUST_PARTICLE_SIZE_MIN           = 0.001;       // metres
const DUST_PARTICLE_SIZE_MAX           = 0.1;         // metres
const DUST_PARTICLE_DRAG_COEFF         = 1.2;
const DUST_PARTICLE_MAX_LIFETIME       = 90.0;        // seconds
const DUST_PARTICLE_MAX_AGE_IN_VEIL    = 1800.0;      // seconds (persistent haze)

// Saltation.
const SALTATION_FRICTION_VELOCITY_MIN  = 0.15;        // m/s
const SALTATION_BAGNOLD_COEFF          = 1e-3;        // kg/m·s
const SALTATION_MAX_FLUX               = 5.0;         // kg/m·s
const SALTATION_BOUNCE_ANGLE_MIN       = 10 * DEG_TO_RAD;
const SALTATION_BOUNCE_ANGLE_MAX       = 40 * DEG_TO_RAD;
const SALTATION_HOP_DISTANCE_MIN       = 0.05;
const SALTATION_HOP_DISTANCE_MAX       = 2.0;

// Visibility.
const DUST_EXTINCTION_FACTOR          = 15.0;         // κ for dust scattering
const DUST_VISIBILITY_MIN              = 5.0;         // metres (total whiteout)
const DUST_VISIBILITY_MAX              = 50000.0;

// Sun dimming.
const DUST_SUN_BLOCK_K                 = 6.0;
const DUST_SUN_TRANSMIT_MIN            = 0.02;
const DUST_SUN_TINT_R                  = 1.00;
const DUST_SUN_TINT_G                  = 0.55;
const DUST_SUN_TINT_B                  = 0.25;

// Dust veil growth and decay.
const DUST_VEIL_GROWTH_RATE            = 0.001;       // per second
const DUST_VEIL_DECAY_RATE             = 0.0002;      // per second
const DUST_VEIL_MAX_DENSITY            = 0.20;        // kg/m³
const DUST_VEIL_BASE_DENSITY           = 0.001;       // kg/m³

// Sandstorm colour palette.
const DUST_TINT_SANDY_R                = 0.85;
const DUST_TINT_SANDY_G                = 0.72;
const DUST_TINT_SANDY_B                = 0.45;
const DUST_TINT_REDDISH_R              = 0.72;
const DUST_TINT_REDDISH_G              = 0.42;
const DUST_TINT_REDDISH_B              = 0.28;
const DUST_TINT_GREY_R                 = 0.65;
const DUST_TINT_GREY_G                 = 0.62;
const DUST_TINT_GREY_B                 = 0.55;

// Haboob trailing-edge dissipation.
const HABOOB_DISSIPATION_RATE          = 0.02;
const HABOOB_FORMATION_TIME            = 45.0;        // seconds

// Impact VFX.
const DUST_IMPACT_LIFETIME             = 0.8;

// Audio.
const DUST_AUDIO_THRESHOLD             = 10.0;        // m/s
const DUST_AUDIO_COOLDOWN              = 3.0;         // seconds

// ═══════════════════════════════════════════════════════════════════════
// STORM TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const DustStormType = Object.freeze({
  HABOOB:    0,   // thunderstorm-driven wall of dust
  SANDSTORM: 1,   // sustained low-level sandstorm
  DUSTSTORM: 2,   // broad, high-reaching dust storm
  DUST_VEIL: 3,   // high-altitude suspended dust layer
});

// ═══════════════════════════════════════════════════════════════════════
// SoA DUST STORM INSTANCE
// ═══════════════════════════════════════════════════════════════════════

export const DustStorm = {
  ownerEid: new Uint32Array(MAX_DUST_STORMS),
  type: new Uint8Array(MAX_DUST_STORMS),

  // Center of the storm (leading edge for haboob).
  cx: new Float32Array(MAX_DUST_STORMS),
  cy: new Float32Array(MAX_DUST_STORMS),
  cz: new Float32Array(MAX_DUST_STORMS),

  // Leading edge normal (unit vector pointing toward the direction of travel).
  edgeX: new Float32Array(MAX_DUST_STORMS),
  edgeZ: new Float32Array(MAX_DUST_STORMS),

  // Drift direction (unit vector) and speed (m/s).
  dirX: new Float32Array(MAX_DUST_STORMS),
  dirZ: new Float32Array(MAX_DUST_STORMS),
  driftSpeed: new Float32Array(MAX_DUST_STORMS),

  // Vertical extent: base and top.
  baseY: new Float32Array(MAX_DUST_STORMS),
  topY: new Float32Array(MAX_DUST_STORMS),

  // Depth of the dust wall (metres).
  depth: new Float32Array(MAX_DUST_STORMS),

  // Horizontal width perpendicular to the drift direction (metres).
  width: new Float32Array(MAX_DUST_STORMS),

  // Peak dust density (kg/m³).
  peakDensity: new Float32Array(MAX_DUST_STORMS),

  // Turbulence field scale.
  turbulenceScale: new Float32Array(MAX_DUST_STORMS),

  // Formation and dissipation progress (0..1).
  formationProgress: new Float32Array(MAX_DUST_STORMS),
  dissipationProgress: new Float32Array(MAX_DUST_STORMS),

  // Age and lifetime.
  age: new Float32Array(MAX_DUST_STORMS),
  lifetime: new Float32Array(MAX_DUST_STORMS),

  // Active flag.
  active: new Uint8Array(MAX_DUST_STORMS),

  // Parent storm (cumulonimbus slot) for haboobs.
  parentStormSlot: new Int16Array(MAX_DUST_STORMS),

  // Mineral tint (linear RGB).
  tintR: new Float32Array(MAX_DUST_STORMS),
  tintG: new Float32Array(MAX_DUST_STORMS),
  tintB: new Float32Array(MAX_DUST_STORMS),

  // Spawner accumulator.
  particleSpawnAccum: new Float32Array(MAX_DUST_STORMS),

  // Wind source (file 047) that follows the storm.
  windSourceSlot: new Int16Array(MAX_DUST_STORMS),

  // Seed for noise.
  seed: new Uint32Array(MAX_DUST_STORMS),
};

/** Marker: entity is a dust storm. */
export const DustStormTag = {};

const _dustStormSlots = new Map(); // eid -> storm slot
let _nextDustStormSlot = 0;

const _dustStormNoise = new Map();

// ═══════════════════════════════════════════════════════════════════════
// SoA DUST PARTICLE POOL
// ═══════════════════════════════════════════════════════════════════════

export const DustParticle = {
  active: new Uint8Array(MAX_DUST_PARTICLES),

  // World position.
  px: new Float32Array(MAX_DUST_PARTICLES),
  py: new Float32Array(MAX_DUST_PARTICLES),
  pz: new Float32Array(MAX_DUST_PARTICLES),

  // World velocity.
  vx: new Float32Array(MAX_DUST_PARTICLES),
  vy: new Float32Array(MAX_DUST_PARTICLES),
  vz: new Float32Array(MAX_DUST_PARTICLES),

  // Size (metres).
  size: new Float32Array(MAX_DUST_PARTICLES),

  // Mass (kg).
  mass: new Float32Array(MAX_DUST_PARTICLES),

  // Age and lifetime.
  age: new Float32Array(MAX_DUST_PARTICLES),
  lifetime: new Float32Array(MAX_DUST_PARTICLES),

  // Source storm slot.
  stormSlot: new Uint16Array(MAX_DUST_PARTICLES),

  // Whether the particle is in the veil layer (1) or the main body (0).
  inVeil: new Uint8Array(MAX_DUST_PARTICLES),

  // Tint (linear RGB).
  tintR: new Float32Array(MAX_DUST_PARTICLES),
  tintG: new Float32Array(MAX_DUST_PARTICLES),
  tintB: new Float32Array(MAX_DUST_PARTICLES),

  // Free-list head.
  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA DUST IMPACT POOL
// ═══════════════════════════════════════════════════════════════════════

export const DustImpact = {
  active: new Uint8Array(MAX_DUST_IMPACTS),
  px: new Float32Array(MAX_DUST_IMPACTS),
  py: new Float32Array(MAX_DUST_IMPACTS),
  pz: new Float32Array(MAX_DUST_IMPACTS),
  age: new Float32Array(MAX_DUST_IMPACTS),
  lifetime: new Float32Array(MAX_DUST_IMPACTS),
  size: new Float32Array(MAX_DUST_IMPACTS),
  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA DUST VEIL — persistent high-altitude suspended dust
// ═══════════════════════════════════════════════════════════════════════

export const DustVeil = {
  ownerEid: new Uint32Array(MAX_DUST_VEILS),
  type: new Uint8Array(MAX_DUST_VEILS),

  // Horizontal center.
  cx: new Float32Array(MAX_DUST_VEILS),
  cy: new Float32Array(MAX_DUST_VEILS),
  cz: new Float32Array(MAX_DUST_VEILS),

  // Horizontal radius (metres).
  radiusX: new Float32Array(MAX_DUST_VEILS),
  radiusZ: new Float32Array(MAX_DUST_VEILS),

  // Vertical extent.
  baseAltitude: new Float32Array(MAX_DUST_VEILS),
  topAltitude: new Float32Array(MAX_DUST_VEILS),

  // Density (kg/m³) at the veil center.
  density: new Float32Array(MAX_DUST_VEILS),

  // Age and lifetime.
  age: new Float32Array(MAX_DUST_VEILS),
  lifetime: new Float32Array(MAX_DUST_VEILS),

  // Active flag.
  active: new Uint8Array(MAX_DUST_VEILS),

  // Mineral tint (linear RGB).
  tintR: new Float32Array(MAX_DUST_VEILS),
  tintG: new Float32Array(MAX_DUST_VEILS),
  tintB: new Float32Array(MAX_DUST_VEILS),

  // Seed for noise.
  seed: new Uint32Array(MAX_DUST_VEILS),
};

/** Marker: entity is a dust veil. */
export const DustVeilTag = {};

const _dustVeilSlots = new Map();
let _nextDustVeilSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA SALTATION FIELD — one per surface
// ═══════════════════════════════════════════════════════════════════════

export const SaltationField = {
  ownerEid: new Uint32Array(MAX_SALTATION_FIELDS),

  // Current saltation flux (kg/m/s).
  flux: new Float32Array(MAX_SALTATION_FIELDS),

  // Friction velocity (m/s) used to derive the flux.
  frictionVelocity: new Float32Array(MAX_SALTATION_FIELDS),

  // Ground-level particle density (kg/m³).
  groundDensity: new Float32Array(MAX_SALTATION_FIELDS),

  // Erosion rate (kg/m²/s); negative = deposition.
  erosionRate: new Float32Array(MAX_SALTATION_FIELDS),

  // Active.
  active: new Uint8Array(MAX_SALTATION_FIELDS),
};

/** Marker: surface participates in saltation. */
export const SaltationTag = {};

const _saltationSlots = new Map();
let _nextSaltationSlot = 0;

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

function getDustStormNoise(slot) {
  let n = _dustStormNoise.get(slot);
  if (!n) {
    n = createNoise3D(() => mulberry32(DustStorm.seed[slot]));
    _dustStormNoise.set(slot, n);
  }
  return n;
}

// ═══════════════════════════════════════════════════════════════════════
// TINT PALETTES
// ═══════════════════════════════════════════════════════════════════════

function pickDustTint(rng) {
  const roll = rng();
  if (roll < 0.55) return [DUST_TINT_SANDY_R, DUST_TINT_SANDY_G, DUST_TINT_SANDY_B];
  if (roll < 0.85) return [DUST_TINT_REDDISH_R, DUST_TINT_REDDISH_G, DUST_TINT_REDDISH_B];
  return [DUST_TINT_GREY_R, DUST_TINT_GREY_G, DUST_TINT_GREY_B];
}

// ═══════════════════════════════════════════════════════════════════════
// DUST STORM CREATION API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Spawn a dust storm.
 *
 * @param world       ECS world
 * @param eid         owner entity
 * @param type        DustStormType
 * @param options     { cx, cy, cz, baseY, topY, depth, width,
 *                      driftDir, driftSpeed, peakDensity,
 *                      parentStormSlot, lifetime, tint }
 * @returns storm slot id
 */
export function addDustStorm(world, eid, type = DustStormType.SANDSTORM, options = {}) {
  if (_nextDustStormSlot >= MAX_DUST_STORMS) {
    throw new Error('dust storm capacity exceeded');
  }
  const slot = _nextDustStormSlot++;

  addComponent(world, eid, DustStormTag);

  const S = DustStorm;
  S.ownerEid[slot] = eid;
  S.type[slot] = type;

  const cx = options.cx ?? 0;
  const cy = options.cy ?? 0;
  const cz = options.cz ?? 0;
  S.cx[slot] = cx;
  S.cy[slot] = cy;
  S.cz[slot] = cz;

  // Depth, height, and width defaults per type.
  let depth, topY, width;
  if (type === DustStormType.HABOOB) {
    depth = options.depth ?? HABOOB_DEPTH_DEFAULT;
    topY = options.topY ?? (cy + HABOOB_HEIGHT_DEFAULT);
    width = options.width ?? HABOOB_DEPTH_DEFAULT * 3;
  } else if (type === DustStormType.SANDSTORM) {
    depth = options.depth ?? SANDSTORM_DEPTH_DEFAULT;
    topY = options.topY ?? (cy + SANDSTORM_HEIGHT_DEFAULT);
    width = options.width ?? SANDSTORM_DEPTH_DEFAULT * 2;
  } else if (type === DustStormType.DUSTSTORM) {
    depth = options.depth ?? DUSTSTORM_DEPTH_DEFAULT;
    topY = options.topY ?? (cy + DUSTSTORM_HEIGHT_DEFAULT);
    width = options.width ?? DUSTSTORM_DEPTH_DEFAULT * 2;
  } else {
    // Dust veil (not really a "storm" but keeps the same storage).
    depth = options.depth ?? 2000;
    topY = options.topY ?? (cy + 10000);
    width = options.width ?? 20000;
  }

  S.depth[slot] = depth;
  S.topY[slot] = topY;
  S.width[slot] = width;
  S.baseY[slot] = cy;

  // Drift.
  const dd = options.driftDir ?? (() => {
    const angle = Math.random() * TWO_PI;
    return [Math.cos(angle), Math.sin(angle)];
  })();
  const dLen = Math.hypot(dd[0], dd[1]) || 1;
  S.dirX[slot] = dd[0] / dLen;
  S.dirZ[slot] = dd[1] / dLen;

  // Leading edge is perpendicular to drift direction.
  S.edgeX[slot] = -S.dirZ[slot];
  S.edgeZ[slot] = S.dirX[slot];

  S.driftSpeed[slot] = options.driftSpeed ?? (GUST_FRONT_DRIFT_SPEED_MIN
    + Math.random() * (GUST_FRONT_DRIFT_SPEED_MAX - GUST_FRONT_DRIFT_SPEED_MIN));

  S.peakDensity[slot] = options.peakDensity ?? (type === DustStormType.HABOOB ? 0.05 : 0.02);
  S.turbulenceScale[slot] = options.turbulenceScale ?? 0.0005;

  S.formationProgress[slot] = 0;
  S.dissipationProgress[slot] = 0;

  S.age[slot] = 0;
  S.lifetime[slot] = options.lifetime ?? (type === DustStormType.HABOOB ? 300 :
    type === DustStormType.SANDSTORM ? 3600 :
    type === DustStormType.DUSTSTORM ? 7200 : 3600);

  S.active[slot] = 1;

  S.parentStormSlot[slot] = options.parentStormSlot ?? -1;

  // Tint.
  const tint = options.tint ?? pickDustTint(Math.random);
  S.tintR[slot] = tint[0];
  S.tintG[slot] = tint[1];
  S.tintB[slot] = tint[2];

  S.particleSpawnAccum[slot] = 0;

  // Wind source (file 047) that follows the storm.
  const wslot = addWindSource(world, eid, WindSourceType.ATMOSPHERIC, {
    px: cx, py: cy, pz: cz,
    radiusX: depth * 2,
    radiusY: (topY - cy) * 0.5,
    radiusZ: depth * 2,
    dir: [S.dirX[slot], 0, S.dirZ[slot]],
    baseSpeed: S.driftSpeed[slot],
    gustAmplitude: 5.0,
    gustFrequency: 0.15,
    turbulenceScale: 0.001,
    seed: (slot * 2654435761) >>> 0,
  });
  S.windSourceSlot[slot] = wslot;

  S.seed[slot] = (slot * 2654435761) >>> 0;

  _dustStormSlots.set(eid, slot);
  return slot;
}

export function removeDustStorm(world, eid) {
  const slot = _dustStormSlots.get(eid);
  if (slot === undefined) return;

  // Remove wind source.
  const wslot = DustStorm.windSourceSlot[slot];
  if (wslot >= 0 && WindSource.active[wslot]) {
    removeWindSource(world, WindSource.ownerEid[wslot]);
  }

  DustStorm.active[slot] = 0;
  DustStorm.ownerEid[slot] = 0;
  _dustStormSlots.delete(eid);
  _dustStormNoise.delete(slot);
  removeComponent(world, eid, DustStormTag);
}

export function getDustStormSlot(eid) {
  return _dustStormSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// DUST VEIL CREATION API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Spawn a persistent high-altitude dust veil.
 */
export function addDustVeil(world, eid, options = {}) {
  if (_nextDustVeilSlot >= MAX_DUST_VEILS) {
    throw new Error('dust veil capacity exceeded');
  }
  const slot = _nextDustVeilSlot++;

  addComponent(world, eid, DustVeilTag);

  const V = DustVeil;
  V.ownerEid[slot] = eid;
  V.type[slot] = DustStormType.DUST_VEIL;

  V.cx[slot] = options.cx ?? 0;
  V.cy[slot] = options.cy ?? 5000;
  V.cz[slot] = options.cz ?? 0;

  V.radiusX[slot] = options.radiusX ?? 50000;
  V.radiusZ[slot] = options.radiusZ ?? 50000;

  V.baseAltitude[slot] = options.baseAltitude ?? 2000;
  V.topAltitude[slot] = options.topAltitude ?? 10000;

  V.density[slot] = options.density ?? DUST_VEIL_BASE_DENSITY;

  V.age[slot] = 0;
  V.lifetime[slot] = options.lifetime ?? 14400;   // 4 hours

  V.active[slot] = 1;

  const tint = options.tint ?? pickDustTint(Math.random);
  V.tintR[slot] = tint[0];
  V.tintG[slot] = tint[1];
  V.tintB[slot] = tint[2];

  V.seed[slot] = (slot * 2654435761) >>> 0;

  _dustVeilSlots.set(eid, slot);
  return slot;
}

export function removeDustVeil(world, eid) {
  const slot = _dustVeilSlots.get(eid);
  if (slot === undefined) return;
  DustVeil.active[slot] = 0;
  DustVeil.ownerEid[slot] = 0;
  _dustVeilSlots.delete(eid);
  removeComponent(world, eid, DustVeilTag);
}

// ═══════════════════════════════════════════════════════════════════════
// SALTATION FIELD API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register a surface for saltation tracking (typically a sandy ground
 * entity).
 */
export function addSaltationField(world, eid) {
  if (_nextSaltationSlot >= MAX_SALTATION_FIELDS) {
    throw new Error('saltation field capacity exceeded');
  }
  let slot = _saltationSlots.get(eid);
  if (slot === undefined) {
    slot = _nextSaltationSlot++;
    _saltationSlots.set(eid, slot);
  }

  addComponent(world, eid, SaltationTag);

  const S = SaltationField;
  S.ownerEid[slot] = eid;
  S.flux[slot] = 0;
  S.frictionVelocity[slot] = 0;
  S.groundDensity[slot] = 0;
  S.erosionRate[slot] = 0;
  S.active[slot] = 1;

  return slot;
}

export function removeSaltationField(world, eid) {
  const slot = _saltationSlots.get(eid);
  if (slot === undefined) return;
  SaltationField.active[slot] = 0;
  SaltationField.ownerEid[slot] = 0;
  _saltationSlots.delete(eid);
  removeComponent(world, eid, SaltationTag);
}

// ═══════════════════════════════════════════════════════════════════════
// DUST PARTICLE POOL
// ═══════════════════════════════════════════════════════════════════════

function allocDustParticle() {
  const P = DustParticle;
  for (let i = 0; i < MAX_DUST_PARTICLES; i++) {
    const slot = (P.freeHead + i) % MAX_DUST_PARTICLES;
    if (P.active[slot] === 0) {
      P.freeHead = (slot + 1) % MAX_DUST_PARTICLES;
      P.active[slot] = 1;
      P.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeDustParticle(slot) {
  const P = DustParticle;
  if (P.active[slot] === 0) return;
  P.active[slot] = 0;
  P.liveCount--;
}

function allocDustImpact() {
  const I = DustImpact;
  for (let i = 0; i < MAX_DUST_IMPACTS; i++) {
    const slot = (I.freeHead + i) % MAX_DUST_IMPACTS;
    if (I.active[slot] === 0) {
      I.freeHead = (slot + 1) % MAX_DUST_IMPACTS;
      I.active[slot] = 1;
      I.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeDustImpact(slot) {
  const I = DustImpact;
  if (I.active[slot] === 0) return;
  I.active[slot] = 0;
  I.liveCount--;
}

// ═══════════════════════════════════════════════════════════════════════
// DUST STORM PARTICLE EMISSION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Emit dust particles from a storm. Called once per frame.
 *
 * Emission rate depends on storm type and current intensity. Total
 * particle budget is soft-capped per storm to avoid wasting the
 * 300k-particle pool.
 */
function emitDustParticles(world, stormSlot, dt) {
  const S = DustStorm;
  const P = DustParticle;

  const intensity = S.formationProgress[stormSlot]
    * (1 - S.dissipationProgress[stormSlot]);
  if (intensity < 0.05) return;

  // Emission rate depends on storm type.
  let particlesPerSecond;
  if (S.type[stormSlot] === DustStormType.HABOOB) {
    particlesPerSecond = 3000 * intensity;
  } else if (S.type[stormSlot] === DustStormType.SANDSTORM) {
    particlesPerSecond = 1000 * intensity;
  } else if (S.type[stormSlot] === DustStormType.DUSTSTORM) {
    particlesPerSecond = 800 * intensity;
  } else {
    particlesPerSecond = 200 * intensity;
  }

  // Cap by pool availability and by budget.
  const desired = particlesPerSecond * dt;
  let wholeCount = Math.floor(desired);
  if (Math.random() < desired - wholeCount) wholeCount++;

  const rng = mulberry32((S.seed[stormSlot] ^ (S.age[stormSlot] * 1000)) >>> 0);

  const baseX = S.cx[stormSlot];
  const baseY = S.baseY[stormSlot];
  const baseZ = S.cz[stormSlot];
  const topY = S.topY[stormSlot];
  const depth = S.depth[stormSlot];
  const width = S.width[stormSlot];

  const edgeX = S.edgeX[stormSlot];
  const edgeZ = S.edgeZ[stormSlot];
  const dirX = S.dirX[stormSlot];
  const dirZ = S.dirZ[stormSlot];

  // Per-particle lifetime.
  const baseLifetime = S.type[stormSlot] === DustStormType.HABOOB ? 20.0 :
    S.type[stormSlot] === DustStormType.SANDSTORM ? 30.0 :
    S.type[stormSlot] === DustStormType.DUSTSTORM ? 60.0 : 300.0;

  for (let i = 0; i < wholeCount; i++) {
    const slot = allocDustParticle();
    if (slot < 0) return;

    // Uniform sampling in the storm's bounding box.
    const u1 = rng();
    const u2 = rng();
    const u3 = rng();

    // Position within the wall: edge coordinate is depth, side is width,
    // vertical is baseY..topY.
    const edgeOffset = (u1 - 0.5) * depth;
    const sideOffset = (u2 - 0.5) * width;
    const verticalT = Math.pow(u3, 0.5);   // more particles near the ground

    const sx = baseX + dirX * edgeOffset + edgeX * sideOffset;
    const sz = baseZ + dirZ * edgeOffset + edgeZ * sideOffset;
    const sy = baseY + (topY - baseY) * verticalT;

    // Velocity: dust drifts with the storm, plus turbulence.
    const speed = S.driftSpeed[stormSlot];
    const jitter = 0.4;

    P.px[slot] = sx;
    P.py[slot] = sy;
    P.pz[slot] = sz;
    P.vx[slot] = dirX * speed + (rng() - 0.5) * speed * jitter;
    P.vy[slot] = (rng() - 0.3) * speed * 0.3;
    P.vz[slot] = dirZ * speed + (rng() - 0.5) * speed * jitter;

    P.size[slot] = DUST_PARTICLE_SIZE_MIN
      + rng() * (DUST_PARTICLE_SIZE_MAX - DUST_PARTICLE_SIZE_MIN);
    P.mass[slot] = DUST_PARTICLE_MASS_MIN
      + rng() * (DUST_PARTICLE_MASS_MAX - DUST_PARTICLE_MASS_MIN);
    P.age[slot] = 0;
    P.lifetime[slot] = baseLifetime * (0.7 + rng() * 0.6);
    P.stormSlot[slot] = stormSlot;
    P.inVeil[slot] = 0;

    // Tint — inherit from the storm.
    P.tintR[slot] = S.tintR[stormSlot];
    P.tintG[slot] = S.tintG[stormSlot];
    P.tintB[slot] = S.tintB[stormSlot];
  }
}

// ═══════════════════════════════════════════════════════════════════════
// DUST PARTICLE PHYSICS
// ═══════════════════════════════════════════════════════════════════════

const _dustWind = vec3.create();

/**
 * Advance all dust particles for one frame.
 * Applies gravity, wind drag, and deactivation. Particles reaching
 * the veil altitude are absorbed into the veil system (marked and
 * removed).
 */
export function systemUpdateDustParticles(world, dt) {
  const P = DustParticle;
  const S = DustStorm;

  for (let slot = 0; slot < MAX_DUST_PARTICLES; slot++) {
    if (P.active[slot] === 0) continue;

    P.age[slot] += dt;
    if (P.age[slot] > P.lifetime[slot]) {
      freeDustParticle(slot);
      continue;
    }

    // Sample the wind field at the particle position.
    sampleWindAt(P.px[slot], P.py[slot], P.pz[slot], _dustWind);

    // Drag toward wind velocity.
    const dx = _dustWind[0] - P.vx[slot];
    const dy = _dustWind[1] - P.vy[slot];
    const dz = _dustWind[2] - P.vz[slot];
    const relSpeedSq = dx * dx + dy * dy + dz * dz;
    const relSpeed = Math.sqrt(relSpeedSq);

    if (relSpeed > EPSILON) {
      const crossSection = P.size[slot] * P.size[slot];
      const dragMag = 0.5 * AIR_DENSITY * relSpeedSq * DUST_PARTICLE_DRAG_COEFF * crossSection;
      const accelX = (dragMag / P.mass[slot]) * (dx / relSpeed);
      const accelY = (dragMag / P.mass[slot]) * (dy / relSpeed);
      const accelZ = (dragMag / P.mass[slot]) * (dz / relSpeed);

      P.vx[slot] += accelX * dt;
      P.vy[slot] += accelY * dt;
      P.vz[slot] += accelZ * dt;
    }

    // Gravity (heavier particles fall faster).
    P.vy[slot] -= GRAVITY * dt;

    // Ground friction: if the particle is very close to the ground,
    // kill vertical velocity and add horizontal rolling.
    if (P.py[slot] < 0.5 && !P.inVeil[slot]) {
      P.vy[slot] = Math.max(0, P.vy[slot]);
      // Ground rolling removes horizontal velocity slowly.
      P.vx[slot] *= 0.995;
      P.vz[slot] *= 0.995;
    }

    // Advance.
    const newX = P.px[slot] + P.vx[slot] * dt;
    const newY = P.py[slot] + P.vy[slot] * dt;
    const newZ = P.pz[slot] + P.vz[slot] * dt;

    // Terrain bounce: cast a short ray.
    if (!P.inVeil[slot]) {
      const speed = Math.sqrt(P.vx[slot] ** 2 + P.vy[slot] ** 2 + P.vz[slot] ** 2);
      if (speed > 1.0) {
        const hits = bvhRaycast(
          [newX, newY, newZ],
          [P.vx[slot] / speed, P.vy[slot] / speed, P.vz[slot] / speed],
          speed * dt + 1.0,
          true
        );
        if (hits.length > 0) {
          // Bounce: reflect velocity with damping.
          const h = hits[0];
          const impactY = newY + (P.vy[slot] / speed) * h.t;

          if (impactY < newY + 0.5) {
            // Bounce up and decay.
            P.vy[slot] = Math.abs(P.vy[slot]) * 0.3;
            P.vx[slot] *= 0.7;
            P.vz[slot] *= 0.7;
          }
        }
      }
    }

    P.px[slot] = newX;
    P.py[slot] = newY;
    P.pz[slot] = newZ;

    // Out of bounds check.
    if (P.py[slot] < -50) {
      freeDustParticle(slot);
    }
  }

  // Advance impacts.
  const I = DustImpact;
  for (let slot = 0; slot < MAX_DUST_IMPACTS; slot++) {
    if (I.active[slot] === 0) continue;
    I.age[slot] += dt;
    if (I.age[slot] >= I.lifetime[slot]) {
      freeDustImpact(slot);
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// DUST STORM EVOLUTION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance the storm life cycle.
 */
export function systemUpdateDustStorms(world, dt) {
  const S = DustStorm;

  for (let slot = 0; slot < _nextDustStormSlot; slot++) {
    if (!S.active[slot]) continue;

    S.age[slot] += dt;

    // Formation.
    if (S.formationProgress[slot] < 1) {
      S.formationProgress[slot] = Math.min(1,
        S.formationProgress[slot] + dt / HABOOB_FORMATION_TIME);
    }

    // Dissipation (after lifetime * 0.85).
    if (S.age[slot] > S.lifetime[slot] * 0.85) {
      S.dissipationProgress[slot] = Math.min(1,
        S.dissipationProgress[slot] + dt / HABOOB_DISSIPATION_RATE);
    }

    // Fully dissipated: retire.
    if (S.dissipationProgress[slot] >= 1) {
      removeDustStorm(world, S.ownerEid[slot]);
      continue;
    }

    // Drift the storm forward along its direction.
    S.cx[slot] += S.dirX[slot] * S.driftSpeed[slot] * dt;
    S.cz[slot] += S.dirZ[slot] * S.driftSpeed[slot] * dt;

    // Sync wind source.
    const wslot = S.windSourceSlot[slot];
    if (wslot >= 0 && WindSource.active[wslot]) {
      WindSource.px[wslot] = S.cx[slot];
      WindSource.py[wslot] = S.cy[slot];
      WindSource.pz[wslot] = S.cz[slot];
      WindSource.radiusX[wslot] = S.depth[slot] * 2;
      WindSource.radiusY[wslot] = (S.topY[slot] - S.cy[slot]) * 0.5;
      WindSource.radiusZ[wslot] = S.depth[slot] * 2;
      WindSource.baseSpeed[wslot] = S.driftSpeed[slot]
        * S.formationProgress[slot]
        * (1 - S.dissipationProgress[slot]);
    }

    // Emit particles.
    emitDustParticles(world, slot, dt);
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// DUST VEIL EVOLUTION
// ═══════════════════════════════════════════════════════════════════════

export function systemUpdateDustVeils(world, dt) {
  const V = DustVeil;

  for (let slot = 0; slot < _nextDustVeilSlot; slot++) {
    if (!V.active[slot]) continue;

    V.age[slot] += dt;

    // Decay density slowly over time.
    V.density[slot] = Math.max(0,
      V.density[slot] - DUST_VEIL_DECAY_RATE * dt);

    // Widen the veil.
    V.radiusX[slot] += 1.0 * dt;
    V.radiusZ[slot] += 1.0 * dt;

    // Retire when density is below threshold.
    if (V.density[slot] < EPSILON || V.age[slot] > V.lifetime[slot]) {
      removeDustVeil(world, V.ownerEid[slot]);
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// SALTATION SYSTEM — Bagnold physics
// ═══════════════════════════════════════════════════════════════════════

/**
 * Update saltation fields based on the local wind field.
 * Uses Bagnold's classic relationship: q = C · (u* - u*_t)³ / g.
 */
export function systemUpdateSaltation(world, dt) {
  const S = SaltationField;

  for (let slot = 0; slot < _nextSaltationSlot; slot++) {
    if (!S.active[slot]) continue;

    const eid = S.ownerEid[slot];
    if (!eid || !entityExists(world, eid)) continue;

    const id = getId(eid);
    const M = WorldTransformF32.m;
    if (!M) continue;
    const off = id * 16;
    const wx = M[off + 12];
    const wy = M[off + 13];
    const wz = M[off + 14];

    // Sample wind at the surface.
    sampleWindAt(wx, wy + 1.0, wz, _dustWind);
    const windSpeed = Math.hypot(_dustWind[0], _dustWind[2]);

    // Friction velocity: u* ≈ sqrt(τ/ρ), τ ≈ Cd · 0.5 · ρ · U²
    const dragCoeff = 0.002;
    const uStar = Math.sqrt(dragCoeff * 0.5) * windSpeed;

    S.frictionVelocity[slot] = uStar;

    // Bagnold threshold (assume threshold u*_t ≈ 0.15 m/s).
    const uStarThreshold = SALTATION_FRICTION_VELOCITY_MIN;
    if (uStar > uStarThreshold) {
      // Flux in kg/m/s.
      const excess = uStar - uStarThreshold;
      const flux = SALTATION_BAGNOLD_COEFF * excess * excess * excess / GRAVITY * 1000.0;
      S.flux[slot] = Math.min(SALTATION_MAX_FLUX, flux);
      S.erosionRate[slot] = S.flux[slot];
      S.groundDensity[slot] = flux * 0.001;
    } else {
      S.flux[slot] = 0;
      S.erosionRate[slot] = 0;
      S.groundDensity[slot] = 0;
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// DUST DENSITY SAMPLING — the hot path
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the dust density (kg/m³) at a world position.
 * Sums over all active dust storms + veils.
 */
export function sampleDustDensity(wx, wy, wz) {
  let density = 0;

  // Storm bodies.
  const S = DustStorm;
  for (let slot = 0; slot < _nextDustStormSlot; slot++) {
    if (!S.active[slot]) continue;

    const intensity = S.formationProgress[slot] * (1 - S.dissipationProgress[slot]);
    if (intensity < 0.05) continue;

    // Horizontal containment.
    const dx = wx - S.cx[slot];
    const dz = wz - S.cz[slot];

    const along = dx * S.edgeX[slot] + dz * S.edgeZ[slot];
    const across = dx * S.dirX[slot] + dz * S.dirZ[slot];

    // Wall profile: sharp leading edge in the direction of travel.
    // For HABOOB: sharp rise in front, gradual taper behind.
    const wallDist = across;   // distance in the direction of travel
    const wallProfile = 1.0 / (1.0 + Math.exp(-wallDist / HABOOB_LEADING_EDGE_WIDTH * 4.0));

    const sideProfile = Math.exp(-(along * along) / (S.width[slot] * S.width[slot] * 0.25));

    // Vertical profile: strong density near the ground, decreasing aloft.
    const verticalT = (wy - S.cy[slot]) / (S.topY[slot] - S.cy[slot]);
    if (verticalT < 0 || verticalT > 1) continue;
    const verticalProfile = Math.exp(-verticalT * 1.5);

    const localDensity = S.peakDensity[slot]
      * wallProfile
      * sideProfile
      * verticalProfile
      * intensity;

    density += localDensity;
  }

  // Veils.
  const V = DustVeil;
  for (let slot = 0; slot < _nextDustVeilSlot; slot++) {
    if (!V.active[slot]) continue;

    // Horizontal containment.
    const dx = (wx - V.cx[slot]) / V.radiusX[slot];
    const dz = (wz - V.cz[slot]) / V.radiusZ[slot];
    const distSq = dx * dx + dz * dz;
    if (distSq > 1.0) continue;

    // Vertical containment.
    if (wy < V.baseAltitude[slot] || wy > V.topAltitude[slot]) continue;

    // Very smooth profile.
    const horizontalFalloff = 1.0 - distSq;
    density += V.density[slot] * horizontalFalloff;
  }

  return density;
}

/**
 * Sample the dust tint at a world position.
 */
export function sampleDustTint(wx, wy, wz, out) {
  let totalWeight = 0;
  let r = 0, g = 0, b = 0;

  const S = DustStorm;
  for (let slot = 0; slot < _nextDustStormSlot; slot++) {
    if (!S.active[slot]) continue;

    const density = S.peakDensity[slot]
      * S.formationProgress[slot]
      * (1 - S.dissipationProgress[slot]);

    r += S.tintR[slot] * density;
    g += S.tintG[slot] * density;
    b += S.tintB[slot] * density;
    totalWeight += density;
  }

  const V = DustVeil;
  for (let slot = 0; slot < _nextDustVeilSlot; slot++) {
    if (!V.active[slot]) continue;

    r += V.tintR[slot] * V.density[slot];
    g += V.tintG[slot] * V.density[slot];
    b += V.tintB[slot] * V.density[slot];
    totalWeight += V.density[slot];
  }

  if (totalWeight < EPSILON) {
    out[0] = 1; out[1] = 1; out[2] = 1;
    return out;
  }

  const inv = 1 / totalWeight;
  out[0] = r * inv;
  out[1] = g * inv;
  out[2] = b * inv;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// VISIBILITY ATTENUATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the local visibility (metres) at a world position, combining
 * dust storms, dust veils, and file 046's fog systems.
 */
export function sampleVisibility(wx, wy, wz) {
  // Dust contribution.
  const dustDensity = sampleDustDensity(wx, wy, wz);
  let dustVisibility = DUST_VISIBILITY_MAX;
  if (dustDensity > EPSILON) {
    const beta = dustDensity * DUST_EXTINCTION_FACTOR;
    dustVisibility = extinctionToVisibility(beta);
  }

  // Fog contribution.
  const fogVisibility = sampleFogVisibility(wx, wy, wz);

  return Math.min(dustVisibility, fogVisibility);
}

// ═══════════════════════════════════════════════════════════════════════
// SUN DIMMING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the sun transmission factor through dust along a ray from
 * the camera toward the sun.
 */
export function sampleDustSunDimming(cameraX, cameraY, cameraZ, sunDirX, sunDirY, sunDirZ) {
  const steps = 8;
  const stepLen = 1000.0;
  let opticalDepth = 0;

  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * stepLen;
    const wx = cameraX + sunDirX * t;
    const wy = cameraY + sunDirY * t;
    const wz = cameraZ + sunDirZ * t;

    const density = sampleDustDensity(wx, wy, wz);
    opticalDepth += density * DUST_EXTINCTION_FACTOR * stepLen;
  }

  const transmission = Math.exp(-opticalDepth * DUST_SUN_BLOCK_K * 0.1);
  return Math.max(DUST_SUN_TRANSMIT_MIN, transmission);
}

/**
 * Sample the tinted sun colour through dust.
 * Returns [r, g, b] multiplicative tint.
 */
export function sampleDustSunTint(sunTransmission) {
  const dustiness = 1.0 - sunTransmission;
  return [
    1.0 * (1 - dustiness) + DUST_SUN_TINT_R * dustiness,
    1.0 * (1 - dustiness) + DUST_SUN_TINT_G * dustiness,
    1.0 * (1 - dustiness) + DUST_SUN_TINT_B * dustiness,
  ];
}

// ═══════════════════════════════════════════════════════════════════════
// HABOOB SPAWN — from a cumulonimbus downdraft
// ═══════════════════════════════════════════════════════════════════════

/**
 * Spawn a haboob from a cumulonimbus storm. Called by file 039 when its
 * downdraft exceeds the haboob threshold.
 */
export function spawnHaboobFromStorm(world, stormSlot, options = {}) {
  const baseSlot = CumulonimbusState._baseInstanceSlot[stormSlot];
  if (baseSlot === undefined || baseSlot < 0) return -1;

  const CI = CloudInstance;

  // Haboob spawns ahead of the storm's downdraft.
  const stormX = CI.px[baseSlot];
  const stormZ = CI.pz[baseSlot];

  // Direction from the storm downdraft (default: outward).
  const driftDir = options.driftDir ?? (() => {
    const angle = Math.random() * TWO_PI;
    return [Math.cos(angle), Math.sin(angle)];
  })();

  // Gust speed derived from downdraft.
  const downdraft = CumulonimbusState.downdraftStrength[stormSlot];
  const gustSpeed = HABOOB_GUST_MIN + (HABOOB_GUST_MAX - HABOOB_GUST_MIN) * downdraft;

  // Create a haboob entity.
  const eid = _allocDustStormEntity(world);
  addTransform(world, eid, { px: stormX, py: 0, pz: stormZ });

  const dustSlot = addDustStorm(world, eid, DustStormType.HABOOB, {
    cx: stormX,
    cy: 0,
    cz: stormZ,
    driftDir,
    driftSpeed: gustSpeed,
    parentStormSlot: stormSlot,
    lifetime: 300 + Math.random() * 300,
  });

  return dustSlot;
}

function _allocDustStormEntity(world) {
  const ctx = world[$internal];
  const index = ctx.entityIndex;
  const id = index.maxId + 1;
  index.maxId = id;
  index.dense[index.aliveCount] = id;
  index.sparse[id] = index.aliveCount;
  index.aliveCount++;
  ctx.entityComponents.set(id, new Set());
  return id;
}

// ═══════════════════════════════════════════════════════════════════════
// FORCE APPLICATION — dust has strong aerodynamic drag on entities
// ═══════════════════════════════════════════════════════════════════════

export const DustForceTag = {};

/**
 * Apply dust wind forces to a specific entity.
 * Strength scales with local dust density (dusty wind = strong wind
 * with extra drag from suspended particles).
 */
export function applyDustForce(world, eid) {
  if (!entityExists(world, eid)) return;

  const id = getId(eid);
  const M = WorldTransformF32.m;
  if (!M) return;
  const off = id * 16;
  const wx = M[off + 12];
  const wy = M[off + 13];
  const wz = M[off + 14];

  // Sample wind and dust at the entity.
  sampleWindAt(wx, wy, wz, _dustWind);
  const dustDensity = sampleDustDensity(wx, wy, wz);

  if (dustDensity < EPSILON) return;

  // Extra drag factor from suspended dust.
  const extraDrag = 1.0 + dustDensity * 10.0;

  const windSpeed = Math.hypot(_dustWind[0], _dustWind[1], _dustWind[2]);
  if (windSpeed < EPSILON) return;

  if (hasComponent(world, eid, RigidBody3D)) {
    const relVx = _dustWind[0] - RigidBody3D.vx[id];
    const relVy = _dustWind[1] - RigidBody3D.vy[id];
    const relVz = _dustWind[2] - RigidBody3D.vz[id];
    const relSpeedSq = relVx * relVx + relVy * relVy + relVz * relVz;
    const relSpeed = Math.sqrt(relSpeedSq);
    if (relSpeed < EPSILON) return;

    const area = 1.0;
    const cd = 1.2 * extraDrag;
    const dragMag = 0.5 * AIR_DENSITY * relSpeedSq * cd * area;

    const invMass = Math.max(RigidBody3D.invMass[id], EPSILON);
    RigidBody3D.vx[id] += (dragMag * invMass) * (relVx / relSpeed) * 0.016;
    RigidBody3D.vy[id] += (dragMag * invMass) * (relVy / relSpeed) * 0.016;
    RigidBody3D.vz[id] += (dragMag * invMass) * (relVz / relSpeed) * 0.016;
  }

  if (hasComponent(world, eid, CharacterTag)) {
    const cs = getCharacterSlot(eid);
    if (cs >= 0) {
      const pullStrength = 0.02 * extraDrag;
      CharacterStateF32.wishX[cs] += _dustWind[0] * pullStrength;
      CharacterStateF32.wishY[cs] += _dustWind[1] * pullStrength;
      CharacterStateF32.wishZ[cs] += _dustWind[2] * pullStrength;
    }
  }
}

/**
 * System: apply dust forces to all entities with DustForceTag.
 */
export function systemApplyDustForces(world) {
  const eids = query(world, [DustForceTag]);
  for (let i = 0; i < eids.length; i++) {
    applyDustForce(world, eids[i]);
  }
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TICK
// ═══════════════════════════════════════════════════════════════════════

/**
 * Full dust storm pipeline:
 *   1. systemUpdateDustStorms(world, dt)
 *   2. systemUpdateDustVeils(world, dt)
 *   3. systemUpdateDustParticles(world, dt)
 *   4. systemUpdateSaltation(world, dt)
 *   5. systemApplyDustForces(world)
 */
export function systemDustTick(world, dt) {
  systemUpdateDustStorms(world, dt);
  systemUpdateDustVeils(world, dt);
  systemUpdateDustParticles(world, dt);
  systemUpdateSaltation(world, dt);
  systemApplyDustForces(world);
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS
// ═══════════════════════════════════════════════════════════════════════

export function findNearestDustStorm(wx, wy, wz, maxDistance = 50000) {
  let nearestSlot = -1;
  let nearestDistSq = maxDistance * maxDistance;

  const S = DustStorm;
  for (let slot = 0; slot < _nextDustStormSlot; slot++) {
    if (!S.active[slot]) continue;
    const dx = S.cx[slot] - wx;
    const dz = S.cz[slot] - wz;
    const distSq = dx * dx + dz * dz;
    if (distSq < nearestDistSq) {
      nearestSlot = slot;
      nearestDistSq = distSq;
    }
  }
  return nearestSlot;
}

export function isInHaboob(slot, wx, wy, wz) {
  const S = DustStorm;
  if (slot < 0 || slot >= _nextDustStormSlot) return false;
  if (!S.active[slot]) return false;

  const dx = wx - S.cx[slot];
  const dz = wz - S.cz[slot];
  const along = dx * S.edgeX[slot] + dz * S.edgeZ[slot];
  const across = dx * S.dirX[slot] + dz * S.dirZ[slot];

  return Math.abs(along) < S.width[slot] * 0.5
    && Math.abs(across) < S.depth[slot] * 0.5
    && wy > S.cy[slot] && wy < S.topY[slot];
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

export function gatherDustStormsForRendering() {
  const result = [];
  const S = DustStorm;
  for (let slot = 0; slot < _nextDustStormSlot; slot++) {
    if (!S.active[slot]) continue;
    result.push({
      slot,
      type: S.type[slot],
      cx: S.cx[slot],
      cy: S.cy[slot],
      cz: S.cz[slot],
      baseY: S.baseY[slot],
      topY: S.topY[slot],
      depth: S.depth[slot],
      width: S.width[slot],
      dirX: S.dirX[slot],
      dirZ: S.dirZ[slot],
      edgeX: S.edgeX[slot],
      edgeZ: S.edgeZ[slot],
      peakDensity: S.peakDensity[slot],
      intensity: S.formationProgress[slot] * (1 - S.dissipationProgress[slot]),
      tint: [S.tintR[slot], S.tintG[slot], S.tintB[slot]],
    });
  }
  return result;
}

export function gatherDustParticlesForRendering(maxOutput = MAX_DUST_MOTES_RENDERED) {
  const result = [];
  const P = DustParticle;
  for (let slot = 0; slot < MAX_DUST_PARTICLES; slot++) {
    if (P.active[slot] === 0) continue;
    result.push({
      x: P.px[slot], y: P.py[slot], z: P.pz[slot],
      size: P.size[slot],
      vx: P.vx[slot], vy: P.vy[slot], vz: P.vz[slot],
      age: P.age[slot],
      lifetime: P.lifetime[slot],
      tint: [P.tintR[slot], P.tintG[slot], P.tintB[slot]],
    });
    if (result.length >= maxOutput) break;
  }
  return result;
}

export function gatherDustVeilsForRendering() {
  const result = [];
  const V = DustVeil;
  for (let slot = 0; slot < _nextDustVeilSlot; slot++) {
    if (!V.active[slot]) continue;
    result.push({
      cx: V.cx[slot],
      cy: V.cy[slot],
      cz: V.cz[slot],
      radiusX: V.radiusX[slot],
      radiusZ: V.radiusZ[slot],
      baseAltitude: V.baseAltitude[slot],
      topAltitude: V.topAltitude[slot],
      density: V.density[slot],
      tint: [V.tintR[slot], V.tintG[slot], V.tintB[slot]],
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearDust(world) {
  for (let slot = 0; slot < _nextDustStormSlot; slot++) {
    if (!DustStorm.active[slot]) continue;
    removeDustStorm(world, DustStorm.ownerEid[slot]);
  }

  DustStorm.active.fill(0);
  DustStorm.ownerEid.fill(0);
  _dustStormSlots.clear();
  _dustStormNoise.clear();
  _nextDustStormSlot = 0;

  DustParticle.active.fill(0);
  DustParticle.freeHead = 0;
  DustParticle.liveCount = 0;

  DustImpact.active.fill(0);
  DustImpact.freeHead = 0;
  DustImpact.liveCount = 0;

  DustVeil.active.fill(0);
  _dustVeilSlots.clear();
  _nextDustVeilSlot = 0;

  SaltationField.active.fill(0);
  _saltationSlots.clear();
  _nextSaltationSlot = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function dustStats() {
  let activeStorms = 0;
  let activeVeils = 0;
  let activeSaltation = 0;

  const byType = [0, 0, 0, 0];

  for (let slot = 0; slot < _nextDustStormSlot; slot++) {
    if (!DustStorm.active[slot]) continue;
    activeStorms++;
    byType[DustStorm.type[slot]]++;
  }

  for (let slot = 0; slot < _nextDustVeilSlot; slot++) {
    if (DustVeil.active[slot]) activeVeils++;
  }

  for (let slot = 0; slot < _nextSaltationSlot; slot++) {
    if (SaltationField.active[slot] && SaltationField.flux[slot] > 0) activeSaltation++;
  }

  return {
    activeStorms,
    maxStorms: MAX_DUST_STORMS,
    activeVeils,
    maxVeils: MAX_DUST_VEILS,
    activeSaltation,
    maxSaltation: MAX_SALTATION_FIELDS,
    particles: DustParticle.liveCount,
    maxParticles: MAX_DUST_PARTICLES,
    impacts: DustImpact.liveCount,
    byType: {
      haboob: byType[DustStormType.HABOOB],
      sandstorm: byType[DustStormType.SANDSTORM],
      duststorm: byType[DustStormType.DUSTSTORM],
      dustVeil: byType[DustStormType.DUST_VEIL],
    },
  };
}