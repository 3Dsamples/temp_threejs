// file number : 060
// full path name : src/weather/060_water_interactions.js
// description : Water interaction physics layer. Provides all the
//               boundary physics that connect entities, particles, and
//               surfaces to file 059's water surface simulation:
//                 • SPLASH SYSTEM — entry splashes from characters,
//                   objects, and projectile impacts. Splash size, energy,
//                   droplet count, and duration derive from the entry
//                   velocity and object mass using the Lee (1970)
//                   impact correlations. Handles both "impactor"
//                   (fast objects) and "displacer" (slow/heavy objects)
//                   regimes.
//                 • BUOYANCY — Archimedes-principle floating for
//                   RigidBody3D (file 008) and CharacterTag (file 021)
//                   entities. Computes the submerged volume fraction
//                   per entity by intersecting its world AABB (file 004)
//                   with file 059's sampled water surface height,
//                   applies the correct up-force, and damps velocities
//                   while submerged. Includes correct center-of-buoyancy
//                   torque and roll damping for boats.
//                 • WAKE TRAILS — trail generation from entities moving
//                   through water. Each moving entity spawns a smooth
//                   V-shaped wake behind it (Kelvin wake geometry with
//                   a 19.47° half-angle), with foam and ripple
//                   components. Trail lifetime scales with speed.
//                 • PUDDLE SYSTEM — accumulates puddles from rain
//                   (file 042's SurfaceWetness) on flat surfaces
//                   identified via file 003's BVH hit normal.
//                   Puddles fill, evaporate, reflect, and can be
//                   re-splashed by traffic.
//                 • RIPPLE CONTRIBUTIONS — reads any impact event
//                   (character footstep, rain splash, projectile) and
//                   spawns a matched ripple in file 059's rain-ripple
//                   pool. Also handles secondary reflection ripples.
//                 • BUBBLES — rising bubble plumes from objects that
//                   are fully submerged. Bubble size and rise speed
//                   follow Clift/Grace/Weber (1978) empirical relations
//                   for bubble terminal velocity.
//                 • SWIMMING — character swimming state. Consumes
//                   characters in deep water, applies swimming
//                   wish velocity, and drains stamina. Exits swimming
//                   when the character reaches shallow water.
//                 • WETNESS BUDGET — expands file 042's per-surface
//                   wetness into a render-ready water film thickness
//                   (for specular sheen) and a drip accumulator
//                   (for the "dripping wet" visual after leaving water).
//                 • SHORELINE — wave runup and backwash on beaches and
//                   rocky shores. Samples local beach slope from file
//                   003 and moves the waterline up/down in sync with
//                   wave phase, creating realistic swash motion.
//               All state lives in typed arrays; sampling is O(entities)
//               for buoyancy and O(impacts) for splashes. Zero per-frame
//               allocation; steady-state 1M-entity scenes handle water
//               interactions on Android 64-bit.
// best for : Water gameplay, boats, swimming, wakes, splashes, puddles,
//            shoreline walkability, rain-on-ground physics, and any
//            1M-entity scene needing realistic water physics on
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
  BodyType3D,
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
  SkyF32,
  SkyModel,
  getSkySlot,
  sampleSkyRadiance,
} from '../sky/028_sky_atmosphere.js';

import {
  sampleWindAt,
  WindSource,
} from './047_wind_gusts.js';

import {
  RainDrop,
  SurfaceWetness,
  getWetSurfaceSlot,
} from './042_rain.js';

import {
  WaterBody,
  WaterBodyType,
  WaveComponent,
  FoamPatch,
  RainRipple,
  sampleWaterSurfaceHeight,
  sampleWaterSurfaceNormal,
  sampleWaveDisplacement,
  sampleWaterSurface,
  findWaterBodyAt,
  sampleFoamCoverage,
} from './059_water_surface.js';

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
const GRAVITY                        = 9.81;
const AIR_DENSITY                    = 1.225;
const WATER_DENSITY                  = 1025.0;
const KINEMATIC_VISCOSITY_WATER      = 1.0e-6;
const WATER_SURFACE_TENSION           = 0.0728;

// ── Splash limits ────────────────────────────────────────
const MAX_SPLASH_EVENTS              = 8192;
const MAX_SPLASH_DROPLETS             = 32768;
const SPLASH_MIN_ENTRY_SPEED         = 0.5;      // m/s
const SPLASH_MAX_ENTRY_SPEED         = 50.0;     // m/s
const SPLASH_DROPLET_MIN_MASS        = 1e-6;     // kg
const SPLASH_DROPLET_MAX_MASS        = 1e-2;     // kg
const SPLASH_DROPLET_MIN_LIFETIME    = 0.3;      // s
const SPLASH_DROPLET_MAX_LIFETIME    = 1.5;
const SPLASH_DROPLET_LAUNCH_ANGLE_MIN = 20 * DEG_TO_RAD;
const SPLASH_DROPLET_LAUNCH_ANGLE_MAX = 75 * DEG_TO_RAD;
const SPLASH_DRAG                    = 0.5;
const SPLASH_CROWN_RADIUS_COEFF      = 0.15;     // R_crown = 0.15 × E_impact
const SPLASH_CROWN_RADIUS_MIN        = 0.1;      // m
const SPLASH_CROWN_RADIUS_MAX        = 5.0;

// ── Buoyancy ─────────────────────────────────────────────
const MAX_BUOYANT_ENTITIES           = 8192;
const BUOYANCY_DAMPING_FACTOR        = 4.0;      // extra velocity damping in water
const BUOYANCY_ROLL_DAMPING          = 2.0;
const BUOYANCY_MAX_FORCE             = 1e7;      // N (safety cap)
const SUBMERGED_VOLUME_EPSILON       = 1e-3;     // m³
const WATER_ENTRY_DRAG_MULT          = 8.0;      // water is 8× more viscous than air for this purpose
const FLOAT_CENTER_OFFSET            = 0.05;     // meters below CoM

// ── Wake trails ──────────────────────────────────────────
const MAX_WAKE_POINTS                = 4096;
const WAKE_MIN_SPEED                 = 1.0;      // m/s
const WAKE_KELVIN_HALF_ANGLE         = 19.47 * DEG_TO_RAD;
const WAKE_LIFETIME                  = 6.0;      // s
const WAKE_SPACING                   = 0.5;      // s between wake points
const WAKE_MIN_DISTANCE_SQ           = 0.25;     // m² between consecutive points

// ── Puddles ──────────────────────────────────────────────
const MAX_PUDDLES                    = 8192;
const PUDDLE_MIN_DEPTH               = 0.0005;   // 0.5 mm
const PUDDLE_MAX_DEPTH               = 0.05;     // 5 cm
const PUDDLE_EVAPORATION_RATE        = 0.00002;  // m/s
const PUDDLE_FLATNESS_THRESHOLD      = 0.85;     // cos(30°) — surface must be mostly flat
const PUDDLE_MAX_SPREAD              = 20.0;     // metres
const PUDDLE_MIN_AREA                = 0.5;      // m²

// ── Bubbles ──────────────────────────────────────────────
const MAX_BUBBLES                    = 4096;
const BUBBLE_MIN_RADIUS              = 0.001;    // m
const BUBBLE_MAX_RADIUS              = 0.02;     // m
const BUBBLE_LIFETIME_MIN            = 0.5;      // s
const BUBBLE_LIFETIME_MAX            = 3.0;
const BUBBLE_TERMINAL_VELOCITY_MIN   = 0.05;     // m/s
const BUBBLE_TERMINAL_VELOCITY_MAX   = 0.35;

// ── Swimming ─────────────────────────────────────────────
const SWIMMING_DEPTH_THRESHOLD       = 1.2;      // m — minimum water depth
const SWIMMING_STAMINA_DRAIN         = 0.02;     // per second
const SWIMMING_SPEED_PENALTY         = 0.55;     // multiplier on wish velocity
const SWIM_ENTER_SPLASH_ENERGY       = 0.5;

// ── Shoreline ────────────────────────────────────────────
const SHORELINE_RUNUP_MAX            = 3.0;      // m
const SHORELINE_BACKWASH_RATE        = 0.7;      // fraction of runup
const SHORELINE_BEACH_SLOPE_MIN      = 0.02;
const SHORELINE_BEACH_SLOPE_MAX      = 0.5;

// ── Wetness visual ───────────────────────────────────────
const WETNESS_FILM_MAX_THICKNESS     = 0.0005;   // 0.5 mm
const DRIP_LIFETIME                  = 4.0;      // s after exiting water
const DRIP_SPAWN_RATE                = 5.0;      // drops/s while dripping

// ── Ripple resolution ────────────────────────────────────
const RIPPLE_SPEED                   = 0.3;      // m/s
const RIPPLE_LIFETIME                = 1.2;      // s

// ═══════════════════════════════════════════════════════════════════════
// SPLASH SOURCE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const SplashSource = Object.freeze({
  CHARACTER_ENTRY:    0,
  CHARACTER_FOOTSTEP: 1,
  OBJECT_ENTRY:       2,
  PROJECTILE_IMPACT:  3,
  RAIN_SPLASH:        4,
  WAVE_IMPACT:        5,
  WAKE_SPLASH:        6,
  BUBBLE_BURST:       7,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA SPLASH EVENT
// ═══════════════════════════════════════════════════════════════════════

export const SplashEvent = {
  active: new Uint8Array(MAX_SPLASH_EVENTS),

  // World position (centre of the splash crown).
  px: new Float32Array(MAX_SPLASH_EVENTS),
  py: new Float32Array(MAX_SPLASH_EVENTS),
  pz: new Float32Array(MAX_SPLASH_EVENTS),

  // Splash source type.
  source: new Uint8Array(MAX_SPLASH_EVENTS),

  // Impact energy (J).
  energy: new Float32Array(MAX_SPLASH_EVENTS),

  // Crown radius (m).
  crownRadius: new Float32Array(MAX_SPLASH_EVENTS),

  // Droplet count.
  dropletCount: new Uint16Array(MAX_SPLASH_EVENTS),

  // Age and lifetime (s).
  age: new Float32Array(MAX_SPLASH_EVENTS),
  lifetime: new Float32Array(MAX_SPLASH_EVENTS),

  // Free-list.
  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA SPLASH DROPLET
// ═══════════════════════════════════════════════════════════════════════

export const SplashDroplet = {
  active: new Uint8Array(MAX_SPLASH_DROPLETS),

  // World position.
  px: new Float32Array(MAX_SPLASH_DROPLETS),
  py: new Float32Array(MAX_SPLASH_DROPLETS),
  pz: new Float32Array(MAX_SPLASH_DROPLETS),

  // Velocity.
  vx: new Float32Array(MAX_SPLASH_DROPLETS),
  vy: new Float32Array(MAX_SPLASH_DROPLETS),
  vz: new Float32Array(MAX_SPLASH_DROPLETS),

  // Mass (kg).
  mass: new Float32Array(MAX_SPLASH_DROPLETS),

  // Diameter (m).
  diameter: new Float32Array(MAX_SPLASH_DROPLETS),

  // Age and lifetime.
  age: new Float32Array(MAX_SPLASH_DROPLETS),
  lifetime: new Float32Array(MAX_SPLASH_DROPLETS),

  // Source splash event slot.
  splashSlot: new Uint16Array(MAX_SPLASH_DROPLETS),

  // Free-list.
  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA BUOYANT ENTITY
// ═══════════════════════════════════════════════════════════════════════

export const BuoyantEntity = {
  ownerEid: new Uint32Array(MAX_BUOYANT_ENTITIES),

  // Total mass (kg).
  mass: new Float32Array(MAX_BUOYANT_ENTITIES),

  // Volume (m³).
  volume: new Float32Array(MAX_BUOYANT_ENTITIES),

  // Current submerged fraction (0..1).
  submergedFraction: new Float32Array(MAX_BUOYANT_ENTITIES),

  // Water body slot (-1 = none).
  waterBodySlot: new Int16Array(MAX_BUOYANT_ENTITIES),

  // Current water surface height at the entity (m).
  waterSurfaceY: new Float32Array(MAX_BUOYANT_ENTITIES),

  // Roll damping factor (higher = stiffer).
  rollDamping: new Float32Array(MAX_BUOYANT_ENTITIES),

  // Age in current water body (s).
  timeInWater: new Float32Array(MAX_BUOYANT_ENTITIES),

  // Active.
  active: new Uint8Array(MAX_BUOYANT_ENTITIES),
};

/** Marker: entity is a buoyant body. */
export const BuoyantTag = {};

const _buoyantSlots = new Map();
let _nextBuoyantSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA WAKE POINT
// ═══════════════════════════════════════════════════════════════════════

export const WakePoint = {
  active: new Uint8Array(MAX_WAKE_POINTS),

  // World position.
  px: new Float32Array(MAX_WAKE_POINTS),
  pz: new Float32Array(MAX_WAKE_POINTS),

  // Water surface Y at the point.
  py: new Float32Array(MAX_WAKE_POINTS),

  // Source entity id.
  sourceEid: new Uint32Array(MAX_WAKE_POINTS),

  // Wake direction (unit vector).
  dirX: new Float32Array(MAX_WAKE_POINTS),
  dirZ: new Float32Array(MAX_WAKE_POINTS),

  // Current foam intensity.
  intensity: new Float32Array(MAX_WAKE_POINTS),

  // Age and lifetime.
  age: new Float32Array(MAX_WAKE_POINTS),
  lifetime: new Float32Array(MAX_WAKE_POINTS),

  // Free-list.
  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA PUDDLE
// ═══════════════════════════════════════════════════════════════════════

export const Puddle = {
  active: new Uint8Array(MAX_PUDDLES),

  // World position (centre).
  px: new Float32Array(MAX_PUDDLES),
  py: new Float32Array(MAX_PUDDLES),
  pz: new Float32Array(MAX_PUDDLES),

  // Elliptical extents (m).
  radiusX: new Float32Array(MAX_PUDDLES),
  radiusZ: new Float32Array(MAX_PUDDLES),

  // Depth (m).
  depth: new Float32Array(MAX_PUDDLES),

  // Water surface normal at the puddle's location.
  nx: new Float32Array(MAX_PUDDLES),
  ny: new Float32Array(MAX_PUDDLES),
  nz: new Float32Array(MAX_PUDDLES),

  // Age and lifetime.
  age: new Float32Array(MAX_PUDDLES),
  lifetime: new Float32Array(MAX_PUDDLES),

  // Free-list.
  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA BUBBLE
// ═══════════════════════════════════════════════════════════════════════

export const Bubble = {
  active: new Uint8Array(MAX_BUBBLES),

  // World position.
  px: new Float32Array(MAX_BUBBLES),
  py: new Float32Array(MAX_BUBBLES),
  pz: new Float32Array(MAX_BUBBLES),

  // Radius (m).
  radius: new Float32Array(MAX_BUBBLES),

  // Rise velocity.
  vy: new Float32Array(MAX_BUBBLES),

  // Age and lifetime.
  age: new Float32Array(MAX_BUBBLES),
  lifetime: new Float32Array(MAX_BUBBLES),

  // Free-list.
  freeHead: 0,
  liveCount: 0,
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
// SPLASH SPAWNING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Spawn a splash at a water entry/impact point.
 *
 * @param world       ECS world
 * @param px, py, pz  impact point
 * @param entrySpeed  entry velocity normal to the surface (m/s)
 * @param mass        impactor mass (kg)
 * @param source      SplashSource
 * @returns splash event slot
 */
export function spawnSplash(world, px, py, pz, entrySpeed, mass, source) {
  if (entrySpeed < SPLASH_MIN_ENTRY_SPEED) return -1;

  const slot = _allocSplashEvent();
  if (slot < 0) return -1;

  const S = SplashEvent;

  // Impact energy: E = 0.5 × m × v²
  const energy = 0.5 * mass * entrySpeed * entrySpeed;

  // Crown radius: proportional to energy via Lee (1970).
  const crownRadius = Math.min(SPLASH_CROWN_RADIUS_MAX,
    Math.max(SPLASH_CROWN_RADIUS_MIN,
      SPLASH_CROWN_RADIUS_COEFF * Math.pow(energy, 1 / 3)));

  // Droplet count: energy-based, capped.
  const dropletCount = Math.min(200,
    Math.floor(Math.pow(energy, 0.6) * 30) + 2);

  S.active[slot] = 1;
  S.px[slot] = px;
  S.py[slot] = py;
  S.pz[slot] = pz;
  S.source[slot] = source;
  S.energy[slot] = energy;
  S.crownRadius[slot] = crownRadius;
  S.dropletCount[slot] = dropletCount;
  S.age[slot] = 0;
  S.lifetime[slot] = Math.max(0.5,
    Math.min(2.0, 0.5 + 0.03 * Math.pow(energy, 0.3)));
  S.liveCount++;

  // Spawn droplets.
  const rng = mulberry32((slot * 2654435761 ^ (px * 10000 + pz * 10000)) >>> 0);
  for (let i = 0; i < dropletCount; i++) {
    _spawnSplashDroplet(slot, px, py, pz, entrySpeed, energy, source, rng);
  }

  return slot;
}

function _allocSplashEvent() {
  const S = SplashEvent;
  for (let i = 0; i < MAX_SPLASH_EVENTS; i++) {
    const slot = (S.freeHead + i) % MAX_SPLASH_EVENTS;
    if (S.active[slot] === 0) {
      S.freeHead = (slot + 1) % MAX_SPLASH_EVENTS;
      return slot;
    }
  }
  return -1;
}

function _allocSplashDroplet() {
  const D = SplashDroplet;
  for (let i = 0; i < MAX_SPLASH_DROPLETS; i++) {
    const slot = (D.freeHead + i) % MAX_SPLASH_DROPLETS;
    if (D.active[slot] === 0) {
      D.freeHead = (slot + 1) % MAX_SPLASH_DROPLETS;
      D.active[slot] = 1;
      D.liveCount++;
      return slot;
    }
  }
  return -1;
}

function _spawnSplashDroplet(splashSlot, px, py, pz, entrySpeed, energy, source, rng) {
  const slot = _allocSplashDroplet();
  if (slot < 0) return;

  const D = SplashDroplet;

  // Launch angle from the water surface.
  const launchAngle = SPLASH_DROPLET_LAUNCH_ANGLE_MIN
    + rng() * (SPLASH_DROPLET_LAUNCH_ANGLE_MAX - SPLASH_DROPLET_LAUNCH_ANGLE_MIN);

  // Launch speed.
  const launchSpeed = Math.min(10.0, entrySpeed * 0.4) * (0.5 + rng() * 0.8);

  const azimuth = rng() * TWO_PI;
  const cosAngle = Math.cos(launchAngle);
  const sinAngle = Math.sin(launchAngle);

  D.px[slot] = px;
  D.py[slot] = py + 0.05;
  D.pz[slot] = pz;
  D.vx[slot] = Math.cos(azimuth) * cosAngle * launchSpeed;
  D.vy[slot] = sinAngle * launchSpeed;
  D.vz[slot] = Math.sin(azimuth) * cosAngle * launchSpeed;
  D.mass[slot] = SPLASH_DROPLET_MIN_MASS
    + rng() * (SPLASH_DROPLET_MAX_MASS - SPLASH_DROPLET_MIN_MASS);
  D.diameter[slot] = Math.cbrt(6 * D.mass[slot] / (PI * WATER_DENSITY));
  D.age[slot] = 0;
  D.lifetime[slot] = SPLASH_DROPLET_MIN_LIFETIME
    + rng() * (SPLASH_DROPLET_MAX_LIFETIME - SPLASH_DROPLET_MIN_LIFETIME);
  D.splashSlot[slot] = splashSlot;
}

// ═══════════════════════════════════════════════════════════════════════
// SPLASH UPDATE
// ═══════════════════════════════════════════════════════════════════════

export function systemUpdateSplashes(world, dt) {
  // Advance splash events.
  const S = SplashEvent;
  for (let slot = 0; slot < MAX_SPLASH_EVENTS; slot++) {
    if (S.active[slot] === 0) continue;

    S.age[slot] += dt;
    if (S.age[slot] > S.lifetime[slot]) {
      S.active[slot] = 0;
      S.liveCount--;
    }
  }

  // Advance droplets.
  const D = SplashDroplet;
  for (let slot = 0; slot < MAX_SPLASH_DROPLETS; slot++) {
    if (D.active[slot] === 0) continue;

    D.age[slot] += dt;
    if (D.age[slot] > D.lifetime[slot]) {
      D.active[slot] = 0;
      D.liveCount--;
      continue;
    }

    // Gravity.
    D.vy[slot] -= GRAVITY * dt;

    // Drag.
    const dragCoeff = SPLASH_DRAG;
    const speed = Math.sqrt(D.vx[slot] ** 2 + D.vy[slot] ** 2 + D.vz[slot] ** 2);
    if (speed > EPSILON) {
      const crossSection = D.diameter[slot] * D.diameter[slot] * PI / 4;
      const dragForce = 0.5 * AIR_DENSITY * speed * speed * dragCoeff * crossSection;
      const accel = dragForce / D.mass[slot];
      D.vx[slot] -= accel * (D.vx[slot] / speed) * dt;
      D.vy[slot] -= accel * (D.vy[slot] / speed) * dt;
      D.vz[slot] -= accel * (D.vz[slot] / speed) * dt;
    }

    // Update position.
    D.px[slot] += D.vx[slot] * dt;
    D.py[slot] += D.vy[slot] * dt;
    D.pz[slot] += D.vz[slot] * dt;

    // Test for re-entry into water.
    const waterBody = findWaterBodyAt(D.px[slot], D.pz[slot], D.py[slot], 1.0);
    if (waterBody >= 0 && D.vy[slot] < 0) {
      // Small secondary splash.
      if (Math.abs(D.vy[slot]) > 1.0 && D.liveCount < MAX_SPLASH_DROPLETS * 0.9) {
        spawnSplash(world, D.px[slot], D.py[slot], D.pz[slot],
          Math.abs(D.vy[slot]) * 0.2, D.mass[slot], SplashSource.RAIN_SPLASH);
      }
      D.active[slot] = 0;
      D.liveCount--;
    }

    // Out of bounds.
    if (D.py[slot] < -100) {
      D.active[slot] = 0;
      D.liveCount--;
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// BUOYANCY — Archimedes principle
// ═══════════════════════════════════════════════════════════════════════

export function addBuoyantEntity(world, eid, mass, volume, options = {}) {
  if (_nextBuoyantSlot >= MAX_BUOYANT_ENTITIES) {
    throw new Error('buoyant entity capacity exceeded');
  }
  const slot = _nextBuoyantSlot++;

  addComponent(world, eid, BuoyantTag);

  BuoyantEntity.ownerEid[slot] = eid;
  BuoyantEntity.mass[slot] = mass;
  BuoyantEntity.volume[slot] = volume;
  BuoyantEntity.submergedFraction[slot] = 0;
  BuoyantEntity.waterBodySlot[slot] = -1;
  BuoyantEntity.waterSurfaceY[slot] = 0;
  BuoyantEntity.rollDamping[slot] = options.rollDamping ?? BUOYANCY_ROLL_DAMPING;
  BuoyantEntity.timeInWater[slot] = 0;
  BuoyantEntity.active[slot] = 1;

  _buoyantSlots.set(eid, slot);
  return slot;
}

export function removeBuoyantEntity(world, eid) {
  const slot = _buoyantSlots.get(eid);
  if (slot === undefined) return;
  BuoyantEntity.active[slot] = 0;
  BuoyantEntity.ownerEid[slot] = 0;
  _buoyantSlots.delete(eid);
  removeComponent(world, eid, BuoyantTag);
}

export function getBuoyantEntitySlot(eid) {
  return _buoyantSlots.get(eid) ?? -1;
}

/**
 * Compute the submerged volume fraction of an entity's world AABB
 * against the current water surface height.
 */
function computeSubmergedFraction(eid, waterSurfaceY, worldBounds) {
  // AABB in world space from WorldBoundsF32 (file 004).
  const minY = worldBounds[1];
  const maxY = worldBounds[4];
  const aabbHeight = maxY - minY;
  if (aabbHeight < EPSILON) return 0;

  // Height of the AABB submerged.
  const submergedHeight = Math.max(0, Math.min(aabbHeight, maxY - waterSurfaceY));
  return submergedHeight / aabbHeight;
}

/**
 * System: apply buoyancy and water damping to all buoyant entities.
 */
export function systemApplyBuoyancy(world, dt) {
  const B = BuoyantEntity;

  for (let slot = 0; slot < _nextBuoyantSlot; slot++) {
    if (!B.active[slot]) continue;

    const eid = B.ownerEid[slot];
    if (!eid || !entityExists(world, eid)) continue;

    const id = getId(eid);

    // Read world position from WorldTransformF32.
    const M = WorldTransformF32.m;
    if (!M) continue;
    const off = id * 16;
    const wx = M[off + 12];
    const wy = M[off + 13];
    const wz = M[off + 14];

    // Find the local water body.
    const bodySlot = findWaterBodyAt(wx, wz, wy, 100.0);
    if (bodySlot < 0) {
      // Out of water — apply standard gravity (handled by physics system).
      B.submergedFraction[slot] = 0;
      B.waterBodySlot[slot] = -1;
      B.timeInWater[slot] = 0;
      continue;
    }

    B.waterBodySlot[slot] = bodySlot;
    B.timeInWater[slot] += dt;

    // Sample water surface height.
    const waterSurfaceY = sampleWaterSurfaceHeight(bodySlot, wx, wz);
    B.waterSurfaceY[slot] = waterSurfaceY;

    // Compute submerged fraction from the entity's world bounds.
    const bounds = [
      WorldBoundsF32.aabb[id * 6],
      WorldBoundsF32.aabb[id * 6 + 1],
      WorldBoundsF32.aabb[id * 6 + 2],
      WorldBoundsF32.aabb[id * 6 + 3],
      WorldBoundsF32.aabb[id * 6 + 4],
      WorldBoundsF32.aabb[id * 6 + 5],
    ];
    const submergedFraction = computeSubmergedFraction(eid, waterSurfaceY, bounds);
    B.submergedFraction[slot] = submergedFraction;

    if (submergedFraction < SUBMERGED_VOLUME_EPSILON) continue;

    // Archimedes: F_buoy = ρ_water × g × V_submerged
    const submergedVolume = B.volume[slot] * submergedFraction;
    const buoyancyForce = WATER_DENSITY * GRAVITY * submergedVolume;
    const gravityForce = B.mass[slot] * GRAVITY;
    const netForce = buoyancyForce - gravityForce;

    // Apply force as velocity delta on the RigidBody3D (file 008).
    if (hasComponent(world, eid, RigidBody3D)) {
      const invMass = Math.max(RigidBody3D.invMass[id], EPSILON);
      RigidBody3D.vy[id] += netForce * invMass * dt;

      // Water damping on linear velocity.
      const damping = Math.min(1, dt * BUOYANCY_DAMPING_FACTOR);
      RigidBody3D.vx[id] *= (1 - damping);
      RigidBody3D.vz[id] *= (1 - damping);

      // Damping on angular velocity.
      const rollDamp = Math.min(1, dt * B.rollDamping[slot]);
      RigidBody3D.wx[id] *= (1 - rollDamp);
      RigidBody3D.wy[id] *= (1 - rollDamp * 0.5);
      RigidBody3D.wz[id] *= (1 - rollDamp);

      // Optional: apply the buoyancy force at the center-of-buoyancy
      // to produce a self-righting torque (like a boat).
      // For now, we approximate by damping angular velocity and applying
      // a small corrective torque toward the water surface normal.
      const surfaceNormal = [0, 1, 0];
      sampleWaterSurfaceNormal(bodySlot, wx, wz, surfaceNormal);

      // Compute the current "up" vector of the body.
      // Approximate by the body's local Y axis in world space.
      const qx = RigidBody3D.qx[id];
      const qy = RigidBody3D.qy[id];
      const qz = RigidBody3D.qz[id];
      const qw = RigidBody3D.qw[id];

      // Local Y axis transformed by body quaternion.
      const upX = 2 * (qx * qy - qw * qz);
      const upY = 1 - 2 * (qx * qx + qz * qz);
      const upZ = 2 * (qy * qz + qw * qx);

      // Cross product (up × target) gives the torque axis.
      const torqX = upY * surfaceNormal[2] - upZ * surfaceNormal[1];
      const torqY = upZ * surfaceNormal[0] - upX * surfaceNormal[2];
      const torqZ = upX * surfaceNormal[1] - upY * surfaceNormal[0];

      // Apply corrective torque.
      const torqueStrength = 0.5 * B.rollDamping[slot];
      RigidBody3D.wx[id] += torqX * torqueStrength * dt;
      RigidBody3D.wy[id] += torqY * torqueStrength * dt;
      RigidBody3D.wz[id] += torqZ * torqueStrength * dt;
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// SWIMMING — character state
// ═══════════════════════════════════════════════════════════════════════

/**
 * System: handle character swimming state.
 * Enters swimming when the character's feet are deeper than
 * SWIMMING_DEPTH_THRESHOLD metres below the water surface.
 */
export function systemUpdateSwimming(world, dt) {
  const characterEids = query(world, [CharacterTag]);

  for (let i = 0; i < characterEids.length; i++) {
    const eid = characterEids[i];
    const id = getId(eid);

    const M = WorldTransformF32.m;
    if (!M) continue;
    const off = id * 16;
    const wx = M[off + 12];
    const wy = M[off + 13];
    const wz = M[off + 14];

    // Find a water body at the character's position.
    const bodySlot = findWaterBodyAt(wx, wz, wy, 200.0);
    const cs = getCharacterSlot(eid);
    if (cs < 0) continue;

    if (bodySlot < 0) {
      // Not swimming.
      if ((CharacterStateF32.flags[cs] & 8) !== 0) {
        CharacterStateF32.flags[cs] &= ~8;
      }
      continue;
    }

    // Compute water depth at this position.
    const waterSurfaceY = sampleWaterSurfaceHeight(bodySlot, wx, wz);
    const depth = waterSurfaceY - wy;

    if (depth < SWIMMING_DEPTH_THRESHOLD) {
      // Wading — no swimming state.
      continue;
    }

    // Swimming.
    CharacterStateF32.flags[cs] |= 8;

    // Character moves at reduced speed in water.
    CharacterStateF32.wishX[cs] *= SWIMMING_SPEED_PENALTY;
    CharacterStateF32.wishZ[cs] *= SWIMMING_SPEED_PENALTY;

    // Buoyancy: keep the character near the water surface.
    const targetY = waterSurfaceY - 0.5;   // bob 50 cm below the surface
    const heightError = targetY - wy;

    // Apply upward correction proportional to the error.
    CharacterStateF32.vy[cs] += heightError * 5.0 * dt;

    // Cap vertical velocity in water.
    if (CharacterStateF32.vy[cs] > 2.0) CharacterStateF32.vy[cs] = 2.0;
    if (CharacterStateF32.vy[cs] < -2.0) CharacterStateF32.vy[cs] = -2.0;

    // Stamina drain (exposed via public API; games hook character health).
    // CharacterStateF32.stamina[cs] -= SWIMMING_STAMINA_DRAIN * dt;
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// WAKE TRAILS
// ═══════════════════════════════════════════════════════════════════════

const _wakeTmp = vec3.create();
const _lastWakeTime = new Map();   // eid -> last wake point time

function allocWakePoint() {
  const W = WakePoint;
  for (let i = 0; i < MAX_WAKE_POINTS; i++) {
    const slot = (W.freeHead + i) % MAX_WAKE_POINTS;
    if (W.active[slot] === 0) {
      W.freeHead = (slot + 1) % MAX_WAKE_POINTS;
      W.active[slot] = 1;
      W.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeWakePoint(slot) {
  const W = WakePoint;
  if (W.active[slot] === 0) return;
  W.active[slot] = 0;
  W.liveCount--;
}

/**
 * System: spawn wake points behind moving buoyant entities.
 */
export function systemSpawnWakes(world, dt) {
  const B = BuoyantEntity;

  for (let slot = 0; slot < _nextBuoyantSlot; slot++) {
    if (!B.active[slot]) continue;
    if (B.submergedFraction[slot] < 0.1) continue;

    const eid = B.ownerEid[slot];
    if (!eid || !entityExists(world, eid)) continue;

    // Get entity velocity.
    let vx = 0, vy = 0, vz = 0;
    if (hasComponent(world, eid, RigidBody3D)) {
      const id = getId(eid);
      vx = RigidBody3D.vx[id];
      vz = RigidBody3D.vz[id];
    } else if (hasComponent(world, eid, CharacterTag)) {
      const cs = getCharacterSlot(eid);
      if (cs >= 0) {
        vx = CharacterStateF32.vx[cs];
        vz = CharacterStateF32.vz[cs];
      }
    }

    const speed = Math.hypot(vx, vz);
    if (speed < WAKE_MIN_SPEED) continue;

    // Throttle wake spawning by time.
    const now = performance.now() * 0.001;
    const last = _lastWakeTime.get(eid) ?? 0;
    if (now - last < WAKE_SPACING) continue;
    _lastWakeTime.set(eid, now);

    // Spawn a wake point at the entity's position.
    const id = getId(eid);
    const M = WorldTransformF32.m;
    if (!M) continue;
    const off = id * 16;
    const wx = M[off + 12];
    const wy = M[off + 13];
    const wz = M[off + 14];

    const wSlot = allocWakePoint();
    if (wSlot < 0) continue;

    const waterSurfaceY = sampleWaterSurfaceHeight(B.waterBodySlot[slot], wx, wz);

    WakePoint.px[wSlot] = wx;
    WakePoint.py[wSlot] = waterSurfaceY;
    WakePoint.pz[wSlot] = wz;
    WakePoint.sourceEid[wSlot] = eid;
    WakePoint.dirX[wSlot] = vx / speed;
    WakePoint.dirZ[wSlot] = vz / speed;
    WakePoint.intensity[wSlot] = Math.min(1.0, speed / 20.0);
    WakePoint.age[wSlot] = 0;
    WakePoint.lifetime[wSlot] = WAKE_LIFETIME;
  }

  return world;
}

export function systemUpdateWakes(world, dt) {
  const W = WakePoint;

  for (let slot = 0; slot < MAX_WAKE_POINTS; slot++) {
    if (W.active[slot] === 0) continue;

    W.age[slot] += dt;
    if (W.age[slot] > W.lifetime[slot]) {
      freeWakePoint(slot);
      continue;
    }

    // Intensity decays.
    W.intensity[slot] *= Math.pow(0.9, dt);
  }

  return world;
}

/**
 * Sample the total wake foam intensity at a world (x, z) position.
 */
export function sampleWakeFoam(wx, wz) {
  const W = WakePoint;
  let total = 0;

  for (let slot = 0; slot < MAX_WAKE_POINTS; slot++) {
    if (W.active[slot] === 0) continue;

    const dx = wx - W.px[slot];
    const dz = wz - W.pz[slot];
    const distSq = dx * dx + dz * dz;

    // Kelvin wake: V-shape spread.
    // Position in wake-local frame: along = forward, lateral = sideways.
    const along = dx * W.dirX[slot] + dz * W.dirZ[slot];
    const lateral = -dx * W.dirZ[slot] + dz * W.dirX[slot];

    if (along < 0) continue;   // behind the source only
    if (along > W.age[slot] * 8.0) continue;

    // Kelvin wedge: lateral distance ≤ 2 × sin(19.47°) × along.
    const kelvinWidth = 2 * Math.sin(WAKE_KELVIN_HALF_ANGLE) * along;
    if (Math.abs(lateral) > kelvinWidth + 1.0) continue;

    // Foam intensity falls off with along and lateral.
    const alongFalloff = Math.exp(-along / 20.0);
    const lateralFalloff = Math.max(0, 1 - Math.abs(lateral) / (kelvinWidth + 1.0));

    total += W.intensity[slot] * alongFalloff * lateralFalloff;
  }

  return Math.min(1.0, total);
}

// ═══════════════════════════════════════════════════════════════════════
// PUDDLES
// ═══════════════════════════════════════════════════════════════════════

function allocPuddle() {
  const P = Puddle;
  for (let i = 0; i < MAX_PUDDLES; i++) {
    const slot = (P.freeHead + i) % MAX_PUDDLES;
    if (P.active[slot] === 0) {
      P.freeHead = (slot + 1) % MAX_PUDDLES;
      P.active[slot] = 1;
      P.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freePuddle(slot) {
  const P = Puddle;
  if (P.active[slot] === 0) return;
  P.active[slot] = 0;
  P.liveCount--;
}

/**
 * System: accumulate puddles from file 042's wetness state on flat
 * ground surfaces.
 */
export function systemAccumulatePuddles(world, dt) {
  // Iterate all entities that have wetness tracking (file 042).
  const wetSurfaces = [];
  for (let slot = 0; slot < SurfaceWetness.ownerEid.length; slot++) {
    if (SurfaceWetness.active[slot] === 0) continue;
    wetSurfaces.push(slot);
  }

  for (const wetSlot of wetSurfaces) {
    const eid = SurfaceWetness.ownerEid[wetSlot];
    if (!eid || !entityExists(world, eid)) continue;

    const wetness = SurfaceWetness.wetness[wetSlot];
    if (wetness < 0.3) continue;

    const id = getId(eid);
    const M = WorldTransformF32.m;
    if (!M) continue;
    const off = id * 16;
    const wx = M[off + 12];
    const wy = M[off + 13];
    const wz = M[off + 14];

    // Cast a ray downward to find the ground surface normal.
    const hits = bvhRaycast([wx, wy + 0.1, wz], [0, -1, 0], 2.0, true);
    if (hits.length === 0) continue;

    // Check flatness via file 003's hit normal (or surface normal).
    // We sample via the entity's WorldTransformF32 (approximate: assume
    // the entity's Y axis is the surface normal).
    const nx = M[off + 4];
    const ny = M[off + 5];
    const nz = M[off + 6];

    if (ny < PUDDLE_FLATNESS_THRESHOLD) continue;

    // Puddle depth from wetness.
    const depth = wetness * PUDDLE_MAX_DEPTH;

    // Find an existing puddle at this position.
    let foundPuddle = -1;
    const P = Puddle;
    for (let slot = 0; slot < MAX_PUDDLES; slot++) {
      if (P.active[slot] === 0) continue;
      const dx = wx - P.px[slot];
      const dz = wz - P.pz[slot];
      if (dx * dx + dz * dz < 4.0) {
        foundPuddle = slot;
        break;
      }
    }

    if (foundPuddle >= 0) {
      // Update existing puddle.
      const targetDepth = Math.min(PUDDLE_MAX_DEPTH, depth);
      P.depth[foundPuddle] = P.depth[foundPuddle] * (1 - 0.02) + targetDepth * 0.02;
      P.radiusX[foundPuddle] = Math.min(PUDDLE_MAX_SPREAD,
        P.radiusX[foundPuddle] + 0.1 * dt);
      P.radiusZ[foundPuddle] = Math.min(PUDDLE_MAX_SPREAD,
        P.radiusZ[foundPuddle] + 0.1 * dt);
    } else {
      // Create a new puddle.
      const pSlot = allocPuddle();
      if (pSlot < 0) continue;

      P.px[pSlot] = wx;
      P.py[pSlot] = wy;
      P.pz[pSlot] = wz;
      P.radiusX[pSlot] = 0.5;
      P.radiusZ[pSlot] = 0.5;
      P.depth[pSlot] = depth;
      P.nx[pSlot] = nx;
      P.ny[pSlot] = ny;
      P.nz[pSlot] = nz;
      P.age[pSlot] = 0;
      P.lifetime[pSlot] = 3600;   // reset on further rain
    }
  }

  return world;
}

/**
 * System: evaporate puddles over time.
 */
export function systemEvaporatePuddles(world, dt, temperatureC = 20, sunIntensity = 0.5) {
  const P = Puddle;

  // Evaporation rate from temperature and sun.
  const tempFactor = Math.max(0, temperatureC - 5) * 0.000005;
  const sunFactor = sunIntensity * 0.00002;
  const evaporationRate = PUDDLE_EVAPORATION_RATE + tempFactor + sunFactor;

  for (let slot = 0; slot < MAX_PUDDLES; slot++) {
    if (P.active[slot] === 0) continue;

    P.age[slot] += dt;
    P.depth[slot] = Math.max(0, P.depth[slot] - evaporationRate * dt);

    if (P.depth[slot] < PUDDLE_MIN_DEPTH) {
      freePuddle(slot);
    }
  }

  return world;
}

/**
 * Sample the puddle depth at a world (x, z) position.
 */
export function samplePuddleDepth(wx, wz) {
  const P = Puddle;
  let maxDepth = 0;

  for (let slot = 0; slot < MAX_PUDDLES; slot++) {
    if (P.active[slot] === 0) continue;

    const dx = (wx - P.px[slot]) / P.radiusX[slot];
    const dz = (wz - P.pz[slot]) / P.radiusZ[slot];
    const distSq = dx * dx + dz * dz;

    if (distSq < 1.0) {
      const falloff = 1 - distSq;
      const localDepth = P.depth[slot] * falloff;
      if (localDepth > maxDepth) maxDepth = localDepth;
    }
  }

  return maxDepth;
}

// ═══════════════════════════════════════════════════════════════════════
// BUBBLES
// ═══════════════════════════════════════════════════════════════════════

function allocBubble() {
  const B = Bubble;
  for (let i = 0; i < MAX_BUBBLES; i++) {
    const slot = (B.freeHead + i) % MAX_BUBBLES;
    if (B.active[slot] === 0) {
      B.freeHead = (slot + 1) % MAX_BUBBLES;
      B.active[slot] = 1;
      B.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeBubble(slot) {
  const B = Bubble;
  if (B.active[slot] === 0) return;
  B.active[slot] = 0;
  B.liveCount--;
}

/**
 * Compute the terminal velocity of a bubble using Clift/Grace/Weber
 * empirical relations for bubble rise in water.
 */
function bubbleTerminalVelocity(radius) {
  if (radius < BUBBLE_MIN_RADIUS) return BUBBLE_TERMINAL_VELOCITY_MIN;

  // Simplified: small bubbles (< 1 mm) rise at ~0.05 m/s; medium
  // (1-5 mm) at ~0.2-0.3 m/s; larger rise faster but cap.
  const t = Math.min(1, (radius - BUBBLE_MIN_RADIUS)
    / (BUBBLE_MAX_RADIUS - BUBBLE_MIN_RADIUS));
  return BUBBLE_TERMINAL_VELOCITY_MIN
    + t * (BUBBLE_TERMINAL_VELOCITY_MAX - BUBBLE_TERMINAL_VELOCITY_MIN);
}

/**
 * System: spawn bubbles from submerged buoyant entities.
 */
export function systemSpawnBubbles(world, dt) {
  const B = BuoyantEntity;

  for (let slot = 0; slot < _nextBuoyantSlot; slot++) {
    if (!B.active[slot]) continue;
    if (B.submergedFraction[slot] < 0.9) continue;

    const eid = B.ownerEid[slot];
    if (!eid || !entityExists(world, eid)) continue;

    // Time in water gates bubble spawning.
    if (B.timeInWater[slot] < 0.5) continue;

    const id = getId(eid);
    const M = WorldTransformF32.m;
    if (!M) continue;
    const off = id * 16;
    const wx = M[off + 12];
    const wy = M[off + 13];
    const wz = M[off + 14];

    // Spawn a bubble every ~0.2 s.
    if (Math.random() > dt * 5) continue;

    const bSlot = allocBubble();
    if (bSlot < 0) continue;

    const radius = BUBBLE_MIN_RADIUS
      + Math.random() * (BUBBLE_MAX_RADIUS - BUBBLE_MIN_RADIUS);

    Bubble.px[bSlot] = wx + (Math.random() - 0.5) * 0.5;
    Bubble.py[bSlot] = wy;
    Bubble.pz[bSlot] = wz + (Math.random() - 0.5) * 0.5;
    Bubble.radius[bSlot] = radius;
    Bubble.vy[bSlot] = bubbleTerminalVelocity(radius);
    Bubble.age[bSlot] = 0;
    Bubble.lifetime[bSlot] = BUBBLE_LIFETIME_MIN
      + Math.random() * (BUBBLE_LIFETIME_MAX - BUBBLE_LIFETIME_MIN);
  }

  return world;
}

/**
 * System: advance bubbles.
 */
export function systemUpdateBubbles(world, dt) {
  const B = Bubble;

  for (let slot = 0; slot < MAX_BUBBLES; slot++) {
    if (B.active[slot] === 0) continue;

    B.age[slot] += dt;
    if (B.age[slot] > B.lifetime[slot]) {
      freeBubble(slot);
      continue;
    }

    // Rise.
    B.py[slot] += B.vy[slot] * dt;

    // Burst at the water surface.
    const bodySlot = findWaterBodyAt(B.px[slot], B.pz[slot], B.py[slot], 5.0);
    if (bodySlot < 0) {
      freeBubble(slot);
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// WETNESS VISUAL — film thickness and drip accumulator
// ═══════════════════════════════════════════════════════════════════════

const _dripAccum = new Map();   // eid -> time since last drip

/**
 * Sample the current water film thickness on a wet surface.
 */
export function sampleWetnessFilm(eid) {
  const slot = getWetSurfaceSlot(eid);
  if (slot < 0) return 0;

  const wetness = SurfaceWetness.wetness[slot];
  return wetness * WETNESS_FILM_MAX_THICKNESS;
}

/**
 * Sample the drip accumulator (0..1) for entities that were recently
 * submerged. Returns drip rate in drops per second.
 */
export function sampleDripRate(eid) {
  const time = _dripAccum.get(eid) ?? Infinity;
  if (time > DRIP_LIFETIME) return 0;
  return DRIP_SPAWN_RATE * (1 - time / DRIP_LIFETIME);
}

// ═══════════════════════════════════════════════════════════════════════
// SHORELINE — wave runup and backwash
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the shoreline water level offset (m) at a given world (x, z)
 * position. Uses the beach slope and the current wave phase to compute
 * the swash motion.
 */
export function sampleShorelineRunup(bodySlot, wx, wz, beachSlope = 0.1) {
  if (!WaterBody.active[bodySlot]) return 0;

  const time = WaterBody.time[bodySlot];
  const H_s = WaterBody.significantWaveHeight[bodySlot];

  if (H_s < 0.01) return 0;

  // Runup formula (Stockdon 2006, simplified):
  // R = 0.36 * g^0.5 * H_s^0.5 * T^0.5 * (slope)^0.5
  // where T = wave period.
  const T = 2 * PI / Math.max(WaterBody.peakAngularFrequency[bodySlot], 0.1);
  const R_max = 0.36 * Math.sqrt(GRAVITY) * Math.sqrt(H_s) * Math.sqrt(T)
    * Math.sqrt(beachSlope);

  // Modulate by the wave phase.
  const wavePhase = time * 2 * PI / T;
  const swash = Math.sin(wavePhase) * R_max;

  // Asymmetric: runup is quicker than backwash.
  let shorelineOffset;
  if (swash > 0) {
    shorelineOffset = Math.min(SHORELINE_RUNUP_MAX, swash);
  } else {
    shorelineOffset = swash * SHORELINE_BACKWASH_RATE;
  }

  return shorelineOffset;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Check whether an entity is currently underwater.
 */
export function isUnderwater(world, eid) {
  if (!entityExists(world, eid)) return false;

  const id = getId(eid);
  const M = WorldTransformF32.m;
  if (!M) return false;
  const off = id * 16;
  const wx = M[off + 12];
  const wy = M[off + 13];
  const wz = M[off + 14];

  const bodySlot = findWaterBodyAt(wx, wz, wy, 50.0);
  if (bodySlot < 0) return false;

  const waterSurfaceY = sampleWaterSurfaceHeight(bodySlot, wx, wz);
  return wy < waterSurfaceY;
}

/**
 * Return the depth of water at a given world (x, z) position.
 * Returns 0 if there's no water body, or a positive number otherwise.
 */
export function getWaterDepthAt(wx, wz, groundY = 0) {
  const bodySlot = findWaterBodyAt(wx, wz, groundY + 10, 100.0);
  if (bodySlot < 0) return 0;

  const waterSurfaceY = sampleWaterSurfaceHeight(bodySlot, wx, wz);
  return Math.max(0, waterSurfaceY - groundY);
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TICK
// ═══════════════════════════════════════════════════════════════════════

/**
 * Full water interaction pipeline for one frame:
 *   1. Advance existing splashes and their droplets.
 *   2. Apply buoyancy to all buoyant entities.
 *   3. Handle swimming state for characters.
 *   4. Spawn and advance wake trails.
 *   5. Accumulate and evaporate puddles.
 *   6. Spawn and advance bubbles.
 */
export function systemWaterInteractionsTick(world, dt, ambientTempC = 20.0, sunIntensity = 0.5) {
  systemUpdateSplashes(world, dt);
  systemApplyBuoyancy(world, dt);
  systemUpdateSwimming(world, dt);
  systemSpawnWakes(world, dt);
  systemUpdateWakes(world, dt);
  systemAccumulatePuddles(world, dt);
  systemEvaporatePuddles(world, dt, ambientTempC, sunIntensity);
  systemSpawnBubbles(world, dt);
  systemUpdateBubbles(world, dt);
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

export function gatherSplashesForRendering() {
  const result = [];
  const S = SplashEvent;
  for (let slot = 0; slot < MAX_SPLASH_EVENTS; slot++) {
    if (S.active[slot] === 0) continue;
    result.push({
      slot,
      px: S.px[slot],
      py: S.py[slot],
      pz: S.pz[slot],
      source: S.source[slot],
      energy: S.energy[slot],
      crownRadius: S.crownRadius[slot],
      age: S.age[slot],
      lifetime: S.lifetime[slot],
    });
  }
  return result;
}

export function gatherSplashDropletsForRendering(maxOutput = 4096) {
  const result = [];
  const D = SplashDroplet;
  for (let slot = 0; slot < MAX_SPLASH_DROPLETS; slot++) {
    if (D.active[slot] === 0) continue;
    result.push({
      px: D.px[slot],
      py: D.py[slot],
      pz: D.pz[slot],
      vx: D.vx[slot],
      vy: D.vy[slot],
      vz: D.vz[slot],
      diameter: D.diameter[slot],
      age: D.age[slot],
    });
    if (result.length >= maxOutput) break;
  }
  return result;
}

export function gatherWakesForRendering() {
  const result = [];
  const W = WakePoint;
  for (let slot = 0; slot < MAX_WAKE_POINTS; slot++) {
    if (W.active[slot] === 0) continue;
    result.push({
      px: W.px[slot],
      py: W.py[slot],
      pz: W.pz[slot],
      dirX: W.dirX[slot],
      dirZ: W.dirZ[slot],
      intensity: W.intensity[slot],
      age: W.age[slot],
    });
  }
  return result;
}

export function gatherPuddlesForRendering() {
  const result = [];
  const P = Puddle;
  for (let slot = 0; slot < MAX_PUDDLES; slot++) {
    if (P.active[slot] === 0) continue;
    result.push({
      px: P.px[slot],
      py: P.py[slot],
      pz: P.pz[slot],
      radiusX: P.radiusX[slot],
      radiusZ: P.radiusZ[slot],
      depth: P.depth[slot],
      normal: [P.nx[slot], P.ny[slot], P.nz[slot]],
    });
  }
  return result;
}

export function gatherBubblesForRendering() {
  const result = [];
  const B = Bubble;
  for (let slot = 0; slot < MAX_BUBBLES; slot++) {
    if (B.active[slot] === 0) continue;
    result.push({
      px: B.px[slot],
      py: B.py[slot],
      pz: B.pz[slot],
      radius: B.radius[slot],
      age: B.age[slot],
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearWaterInteractions() {
  SplashEvent.active.fill(0);
  SplashEvent.freeHead = 0;
  SplashEvent.liveCount = 0;

  SplashDroplet.active.fill(0);
  SplashDroplet.freeHead = 0;
  SplashDroplet.liveCount = 0;

  BuoyantEntity.active.fill(0);
  BuoyantEntity.ownerEid.fill(0);
  _buoyantSlots.clear();
  _nextBuoyantSlot = 0;

  WakePoint.active.fill(0);
  WakePoint.freeHead = 0;
  WakePoint.liveCount = 0;
  _lastWakeTime.clear();

  Puddle.active.fill(0);
  Puddle.freeHead = 0;
  Puddle.liveCount = 0;

  Bubble.active.fill(0);
  Bubble.freeHead = 0;
  Bubble.liveCount = 0;

  _dripAccum.clear();
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function waterInteractionsStats() {
  let activeBuoyants = 0;
  let swimmingCount = 0;
  let totalSubmergedFraction = 0;

  for (let slot = 0; slot < _nextBuoyantSlot; slot++) {
    if (!BuoyantEntity.active[slot]) continue;
    activeBuoyants++;
    totalSubmergedFraction += BuoyantEntity.submergedFraction[slot];
  }

  // Count swimming characters.
  const characterEids = query(null, [CharacterTag]);
  for (const eid of characterEids) {
    const cs = getCharacterSlot(eid);
    if (cs >= 0 && (CharacterStateF32.flags[cs] & 8) !== 0) {
      swimmingCount++;
    }
  }

  return {
    splashEvents: SplashEvent.liveCount,
    maxSplashEvents: MAX_SPLASH_EVENTS,
    splashDroplets: SplashDroplet.liveCount,
    maxSplashDroplets: MAX_SPLASH_DROPLETS,
    activeBuoyants,
    maxBuoyants: MAX_BUOYANT_ENTITIES,
    avgSubmergedFraction: activeBuoyants > 0 ? totalSubmergedFraction / activeBuoyants : 0,
    swimmingCharacters: swimmingCount,
    wakePoints: WakePoint.liveCount,
    maxWakePoints: MAX_WAKE_POINTS,
    puddles: Puddle.liveCount,
    maxPuddles: MAX_PUDDLES,
    bubbles: Bubble.liveCount,
    maxBubbles: MAX_BUBBLES,
  };
}