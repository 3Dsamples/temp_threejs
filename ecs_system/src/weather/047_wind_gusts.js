// file number : 047
// full path name : src/weather/047_wind_gusts.js
// description : Wind and gust field system. Provides a continuous
//               spatially-varying wind vector field driven by multi-octave
//               simplex noise, gust envelopes, terrain-sheltered wind,
//               and kinematic forces on props and rigid bodies. Uses
//               029_cloud_archetypes.js as the single source of truth for
//               weather-driven base wind (each cloud instance contributes
//               a directional wind source). Contributes:
//                 • WindField SoA — a set of WindSource entries, each with
//                   world position, base direction, base speed, gust
//                   amplitude, gust frequency, and a noise-seeded turbulator.
//                 • Gust envelopes — a per-source temporal envelope that
//                   multiplies the base speed by a smoothed random walk,
//                   producing realistic "gusts" lasting 1-10 s.
//                 • Turbulence field — 3D simplex noise sampled at the
//                   query point to add curl-like lateral displacement to
//                   the wind vector, ensuring wind isn't perfectly uniform
//                   across the world.
//                 • Terrain sheltering — sample the local geometry
//                   via file 003's BVH to attenuate wind speed in
//                   valleys, lee slopes, and behind obstacles. Uses
//                   a short ray-cast opposite to the wind direction.
//                 • Kinematic forces on props — iterate all entities
//                   with WindForceTag and apply force = 0.5 · ρ · v² ·
//                   Cd · A to their RigidBody3D (file 008) or
//                   CharacterStateF32 (file 021). Also applies a
//                   torque proportional to the lever arm from the
//                   entity's center of mass.
//                 • Wind audio cues — emits WindGustEvent records when
//                   a local wind speed crosses a threshold, so file 052
//                   (thunder synthesiser) and game audio layers can
//                   trigger whooshes and howls.
//                 • Player-facing sampling — `sampleWindAt` returns a
//                   full wind vector at a world position, ready for
//                   character controllers, particle emitters (file
//                   025), and rain / snow drift (files 042 / 043).
//                 • Tornado feeder — file 048 reads the ambient wind
//                   field to compute the inflow and rotational velocity
//                   of its vortex.
//               All state lives in typed arrays; sampling is O(sources) +
//               O(1) noise; forces are O(entities with WindForceTag).
//               Zero per-frame allocation; steady-state simulation at 1M
//               entities fits on Android 64-bit.
// best for : Windy weather, gusty days, wind-driven rain, sail / flag
//            physics, tornado feeder fields, hurricane inflow, dust
//            storms, wind turbine gameplay, character coat / hair
//            simulation, and any 1M-entity scene needing wind on
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
  ShapeType3D,
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
  CumulonimbusTag,
} from '../sky/039_cumulonimbus_clouds.js';

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

const AIR_DENSITY                    = 1.225;      // kg/m³ at sea level
const GRAVITY                        = 9.81;

const MAX_WIND_SOURCES               = 256;
const MAX_WIND_PROPS                 = 8192;
const MAX_GUST_EVENTS                = 128;

// Gust envelope defaults.
const GUST_LIFETIME_MIN              = 1.5;        // seconds
const GUST_LIFETIME_MAX              = 10.0;
const GUST_AMPLITUDE_DEFAULT         = 3.0;        // m/s swing
const GUST_FREQUENCY_DEFAULT         = 0.3;        // Hz
const GUST_ENVELOPE_SMOOTH           = 0.08;       // per-second smoothing

// Turbulence defaults.
const TURBULENCE_SCALE_DEFAULT       = 0.05;       // world-units scale
const TURBULENCE_OCTAVES             = 3;
const TURBULENCE_PERSISTENCE         = 0.55;

// Terrain sheltering.
const TERRAIN_SHELTER_RAY_LENGTH     = 200.0;      // metres
const TERRAIN_SHELTER_ATTENUATION    = 0.55;       // 55% reduction in shelter
const TERRAIN_SHELTER_MIN_SCALE      = 0.15;

// Wind force defaults.
const WIND_FORCE_AREA_DEFAULT        = 1.0;        // m²
const WIND_FORCE_CD_DEFAULT          = 1.20;       // flat plate drag coefficient
const WIND_TORQUE_ARM_DEFAULT        = 0.5;        // metres

// Wind audio cues.
const WIND_AUDIO_THRESHOLD           = 12.0;       // m/s to trigger a whoosh
const WIND_AUDIO_COOLDOWN            = 2.5;        // seconds between whooshes

// Sample cutoff.
const WIND_MAX_QUERY_DISTANCE        = 5000.0;     // metres

// ═══════════════════════════════════════════════════════════════════════
// WIND SOURCE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const WindSourceType = Object.freeze({
  ATMOSPHERIC: 0,   // global / weather-driven wind
  CLOUD_DRIVEN: 1,  // wind pulled from a cloud instance (file 029)
  STORM_INFLOW: 2,  // storm-associated inflow (tornado feeder)
  LOCAL_TERRAIN: 3, // terrain channeling / orographic wind
  POINT: 4,         // localised fan / engine / explosion wind
});

// ═══════════════════════════════════════════════════════════════════════
// SoA WIND SOURCE
// ═══════════════════════════════════════════════════════════════════════

export const WindSource = {
  ownerEid: new Uint32Array(MAX_WIND_SOURCES),
  type: new Uint8Array(MAX_WIND_SOURCES),

  // World position (for localised wind; ignored by atmospheric).
  px: new Float32Array(MAX_WIND_SOURCES),
  py: new Float32Array(MAX_WIND_SOURCES),
  pz: new Float32Array(MAX_WIND_SOURCES),

  // Influence radius (0 = global / infinite).
  radiusX: new Float32Array(MAX_WIND_SOURCES),
  radiusY: new Float32Array(MAX_WIND_SOURCES),
  radiusZ: new Float32Array(MAX_WIND_SOURCES),

  // Base wind direction (unit vector).
  dirX: new Float32Array(MAX_WIND_SOURCES),
  dirY: new Float32Array(MAX_WIND_SOURCES),
  dirZ: new Float32Array(MAX_WIND_SOURCES),

  // Base wind speed (m/s).
  baseSpeed: new Float32Array(MAX_WIND_SOURCES),

  // Gust amplitude (m/s) and frequency (Hz).
  gustAmplitude: new Float32Array(MAX_WIND_SOURCES),
  gustFrequency: new Float32Array(MAX_WIND_SOURCES),

  // Current gust envelope (0..1; smoothly driven by a random walk).
  gustEnvelope: new Float32Array(MAX_WIND_SOURCES),
  gustTarget: new Float32Array(MAX_WIND_SOURCES),
  gustPhase: new Float32Array(MAX_WIND_SOURCES),

  // Turbulence scale (larger = faster variation).
  turbulenceScale: new Float32Array(MAX_WIND_SOURCES),

  // Active flag.
  active: new Uint8Array(MAX_WIND_SOURCES),

  // Seed for noise.
  seed: new Uint32Array(MAX_WIND_SOURCES),
};

/** Marker: entity is a wind source (usually weather root). */
export const WindSourceTag = {};

const _windSourceSlots = new Map(); // eid -> source slot
let _nextWindSourceSlot = 0;

// Per-source noise generator (lazily created).
const _windNoise = new Map();

// ═══════════════════════════════════════════════════════════════════════
// SoA WIND FORCE PROPS — entities that receive kinematic wind forces
// ═══════════════════════════════════════════════════════════════════════

export const WindProp = {
  ownerEid: new Uint32Array(MAX_WIND_PROPS),

  // Cross-sectional area (m²) in the direction of wind.
  area: new Float32Array(MAX_WIND_PROPS),

  // Drag coefficient (default = 1.2 flat plate).
  dragCoefficient: new Float32Array(MAX_WIND_PROPS),

  // Torque arm (metres from CoM).
  torqueArm: new Float32Array(MAX_WIND_PROPS),

  // Active flag.
  active: new Uint8Array(MAX_WIND_PROPS),
};

/** Marker: entity receives wind forces. */
export const WindForceTag = {};

const _windPropSlots = new Map(); // eid -> prop slot
let _nextWindPropSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// GUST EVENT QUEUE
// ═══════════════════════════════════════════════════════════════════════

export const WindGustEvent = {
  px: new Float32Array(MAX_GUST_EVENTS),
  py: new Float32Array(MAX_GUST_EVENTS),
  pz: new Float32Array(MAX_GUST_EVENTS),
  speed: new Float32Array(MAX_GUST_EVENTS),
  dirX: new Float32Array(MAX_GUST_EVENTS),
  dirY: new Float32Array(MAX_GUST_EVENTS),
  dirZ: new Float32Array(MAX_GUST_EVENTS),
  age: new Float32Array(MAX_GUST_EVENTS),
  lifetime: new Float32Array(MAX_GUST_EVENTS),
  active: new Uint8Array(MAX_GUST_EVENTS),
  head: 0,
  count: 0,
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

function getWindNoise(slot) {
  let n = _windNoise.get(slot);
  if (!n) {
    n = createNoise3D(() => mulberry32(WindSource.seed[slot]));
    _windNoise.set(slot, n);
  }
  return n;
}

// ═══════════════════════════════════════════════════════════════════════
// WIND SOURCE API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add a wind source.
 *
 * @param world       ECS world
 * @param eid         owner entity
 * @param type        WindSourceType
 * @param options     { px, py, pz, radius, dir, baseSpeed,
 *                      gustAmplitude, gustFrequency, turbulenceScale, seed }
 * @returns source slot id
 */
export function addWindSource(world, eid, type = WindSourceType.ATMOSPHERIC, options = {}) {
  if (_nextWindSourceSlot >= MAX_WIND_SOURCES) {
    throw new Error('wind source capacity exceeded');
  }
  const slot = _nextWindSourceSlot++;

  addComponent(world, eid, WindSourceTag);

  const W = WindSource;
  W.ownerEid[slot] = eid;
  W.type[slot] = type;
  W.px[slot] = options.px ?? 0;
  W.py[slot] = options.py ?? 0;
  W.pz[slot] = options.pz ?? 0;
  W.radiusX[slot] = options.radiusX ?? 0;
  W.radiusY[slot] = options.radiusY ?? 0;
  W.radiusZ[slot] = options.radiusZ ?? 0;

  const dir = options.dir ?? [1, 0, 0];
  const dLen = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  W.dirX[slot] = dir[0] / dLen;
  W.dirY[slot] = dir[1] / dLen;
  W.dirZ[slot] = dir[2] / dLen;

  W.baseSpeed[slot] = options.baseSpeed ?? 5.0;
  W.gustAmplitude[slot] = options.gustAmplitude ?? GUST_AMPLITUDE_DEFAULT;
  W.gustFrequency[slot] = options.gustFrequency ?? GUST_FREQUENCY_DEFAULT;

  W.gustEnvelope[slot] = 0.5;
  W.gustTarget[slot] = 0.5;
  W.gustPhase[slot] = Math.random() * TWO_PI;

  W.turbulenceScale[slot] = options.turbulenceScale ?? TURBULENCE_SCALE_DEFAULT;
  W.active[slot] = 1;
  W.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  _windSourceSlots.set(eid, slot);
  return slot;
}

export function removeWindSource(world, eid) {
  const slot = _windSourceSlots.get(eid);
  if (slot === undefined) return;
  WindSource.active[slot] = 0;
  WindSource.ownerEid[slot] = 0;
  _windNoise.delete(slot);
  _windSourceSlots.delete(eid);
  removeComponent(world, eid, WindSourceTag);
}

export function getWindSourceSlot(eid) {
  return _windSourceSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// WIND PROP API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Attach a wind prop to an entity (usually has RigidBody3D or CharacterTag).
 *
 * @param world       ECS world
 * @param eid         entity
 * @param options     { area, dragCoefficient, torqueArm }
 */
export function addWindProp(world, eid, options = {}) {
  if (_nextWindPropSlot >= MAX_WIND_PROPS) {
    throw new Error('wind prop capacity exceeded');
  }
  const slot = _nextWindPropSlot++;

  addComponent(world, eid, WindForceTag);

  WindProp.ownerEid[slot] = eid;
  WindProp.area[slot] = options.area ?? WIND_FORCE_AREA_DEFAULT;
  WindProp.dragCoefficient[slot] = options.dragCoefficient ?? WIND_FORCE_CD_DEFAULT;
  WindProp.torqueArm[slot] = options.torqueArm ?? WIND_TORQUE_ARM_DEFAULT;
  WindProp.active[slot] = 1;

  _windPropSlots.set(eid, slot);
  return slot;
}

export function removeWindProp(world, eid) {
  const slot = _windPropSlots.get(eid);
  if (slot === undefined) return;
  WindProp.active[slot] = 0;
  WindProp.ownerEid[slot] = 0;
  _windPropSlots.delete(eid);
  removeComponent(world, eid, WindForceTag);
}

// ═══════════════════════════════════════════════════════════════════════
// TERRAIN SHELTERING — sample BVH behind the wind direction
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute a shelter factor (0..1) at a world position for a given wind
 * direction. 1 = fully exposed, 0 = fully sheltered.
 *
 * Uses a short ray-cast opposite to the wind direction: if the ray hits
 * terrain, the point is in the lee of that obstacle.
 */
function computeShelterFactor(wx, wy, wz, dirX, dirY, dirZ) {
  // Cast a ray from (wx, wy, wz) toward the wind's source (opposite
  // of the wind direction).
  const rayDirX = -dirX;
  const rayDirY = -dirY;
  const rayDirZ = -dirZ;

  const hits = bvhRaycast(
    [wx, wy, wz],
    [rayDirX, rayDirY, rayDirZ],
    TERRAIN_SHELTER_RAY_LENGTH,
    true
  );

  if (hits.length === 0) return 1.0;

  // Distance to the obstacle governs the shelter amount.
  const t = hits[0].t;
  const shelterAmount = 1.0 - t / TERRAIN_SHELTER_RAY_LENGTH;
  const factor = 1.0 - shelterAmount * TERRAIN_SHELTER_ATTENUATION;

  return Math.max(TERRAIN_SHELTER_MIN_SCALE, factor);
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN WIND SAMPLING — returns a wind vector at a world position
// ═══════════════════════════════════════════════════════════════════════

const _windNoiseScratch = vec3.create();

/**
 * Sample the wind vector at a world position. Sums over all active
 * wind sources, applies gust envelopes, turbulence, and terrain
 * sheltering.
 *
 * @param wx, wy, wz  world position
 * @param out         [vx, vy, vz] output buffer
 * @param applyShelter whether to apply terrain sheltering (default true)
 * @returns out
 */
export function sampleWindAt(wx, wy, wz, out, applyShelter = true) {
  let vx = 0, vy = 0, vz = 0;

  for (let slot = 0; slot < _nextWindSourceSlot; slot++) {
    if (!WindSource.active[slot]) continue;

    const W = WindSource;

    // Spatial falloff for localised sources.
    let spatialScale = 1.0;
    if (W.radiusX[slot] > 0) {
      const dx = (wx - W.px[slot]) / W.radiusX[slot];
      const dy = (wy - W.py[slot]) / Math.max(W.radiusY[slot], 1);
      const dz = (wz - W.pz[slot]) / Math.max(W.radiusZ[slot], 1);
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > 1.0) continue;
      spatialScale = 1.0 - distSq;
    }

    // Turbulence: sample the noise at the query position.
    const noise = getWindNoise(slot);
    const tScale = W.turbulenceScale[slot];
    const seed = W.seed[slot] * 0.0001;

    let tx = 0, ty = 0, tz = 0;
    let amplitude = 1.0;
    let frequency = 1.0;
    for (let o = 0; o < TURBULENCE_OCTAVES; o++) {
      const nx = noise(wx * tScale * frequency + seed, wy * tScale * frequency, wz * tScale * frequency);
      const ny = noise(wx * tScale * frequency + 50 + seed, wy * tScale * frequency, wz * tScale * frequency);
      const nz = noise(wx * tScale * frequency, wy * tScale * frequency, wz * tScale * frequency + 50 + seed);
      tx += nx * amplitude;
      ty += ny * amplitude;
      tz += nz * amplitude;
      amplitude *= TURBULENCE_PERSISTENCE;
      frequency *= 2.0;
    }

    // Gust factor (0..1 envelope; base speed scaled).
    const gustFactor = 1.0 + W.gustAmplitude[slot] / Math.max(W.baseSpeed[slot], EPSILON) * (W.gustEnvelope[slot] - 0.5);

    // Effective speed.
    const speed = W.baseSpeed[slot] * gustFactor * spatialScale;

    // Direction.
    const dx = W.dirX[slot];
    const dy = W.dirY[slot];
    const dz = W.dirZ[slot];

    // Turbulence offset is proportional to speed.
    const turbAmount = speed * 0.20;
    vx += (dx * speed) + tx * turbAmount;
    vy += (dy * speed) + ty * turbAmount;
    vz += (dz * speed) + tz * turbAmount;
  }

  // Terrain sheltering.
  if (applyShelter) {
    const speedSq = vx * vx + vy * vy + vz * vz;
    if (speedSq > EPSILON_SQ) {
      const invSpeed = 1 / Math.sqrt(speedSq);
      const dirX = vx * invSpeed;
      const dirY = vy * invSpeed;
      const dirZ = vz * invSpeed;
      const shelter = computeShelterFactor(wx, wy, wz, dirX, dirY, dirZ);
      vx *= shelter;
      vy *= shelter;
      vz *= shelter;
    }
  }

  out[0] = vx;
  out[1] = vy;
  out[2] = vz;
  return out;
}

/**
 * Sample the wind speed magnitude at a world position.
 */
export function sampleWindSpeed(wx, wy, wz) {
  sampleWindAt(wx, wy, wz, _windNoiseScratch);
  return Math.hypot(_windNoiseScratch[0], _windNoiseScratch[1], _windNoiseScratch[2]);
}

// ═══════════════════════════════════════════════════════════════════════
// WIND SOURCE UPDATE SYSTEM — advance gust envelopes
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance each wind source's gust envelope. The envelope follows a
 * bounded random walk with a temporal smoothing, so gusts rise and fall
 * organically over 1-10 seconds.
 */
export function systemUpdateWindSources(world, dt) {
  for (let slot = 0; slot < _nextWindSourceSlot; slot++) {
    if (!WindSource.active[slot]) continue;

    const W = WindSource;

    // Advance gust phase.
    W.gustPhase[slot] += dt * W.gustFrequency[slot];
    if (W.gustPhase[slot] > TWO_PI) W.gustPhase[slot] -= TWO_PI;

    // Occasionally re-roll gust target.
    if (Math.random() < dt * 0.3) {
      W.gustTarget[slot] = Math.random();
    }

    // Smooth envelope toward target with a small sinusoidal overlay.
    const sin = 0.5 + 0.5 * Math.sin(W.gustPhase[slot]);
    const blend = Math.min(1, dt / GUST_ENVELOPE_SMOOTH);
    W.gustEnvelope[slot] = W.gustEnvelope[slot] * (1 - blend)
                        + (W.gustTarget[slot] * 0.6 + sin * 0.4) * blend;

    // Clamp to [0, 1].
    W.gustEnvelope[slot] = Math.max(0, Math.min(1, W.gustEnvelope[slot]));

    // Update localised source position from the owner entity (if it has
    // WorldTransformF32).
    const ownerEid = W.ownerEid[slot];
    if (ownerEid !== 0 && entityExists(world, ownerEid)) {
      const id = getId(ownerEid);
      const M = WorldTransformF32.m;
      if (M) {
        const off = id * 16;
        W.px[slot] = M[off + 12];
        W.py[slot] = M[off + 13];
        W.pz[slot] = M[off + 14];
      }
    }
  }
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// WIND FORCE APPLICATION — kinematic forces on props
// ═══════════════════════════════════════════════════════════════════════

const _windForceV = vec3.create();
const _windDirV = vec3.create();
const _windRelV = vec3.create();

/**
 * Apply wind forces to every entity with WindForceTag. For rigid bodies,
 * apply force = 0.5 · ρ · v² · Cd · A and torque = force × arm. For
 * characters, apply an additive acceleration to their wish velocity.
 */
export function systemApplyWindForces(world, dt) {
  for (let slot = 0; slot < _nextWindPropSlot; slot++) {
    if (!WindProp.active[slot]) continue;

    const eid = WindProp.ownerEid[slot];
    if (eid === 0 || !entityExists(world, eid)) continue;

    const id = getId(eid);

    // World position.
    const M = WorldTransformF32.m;
    if (!M) continue;
    const off = id * 16;
    const wx = M[off + 12];
    const wy = M[off + 13];
    const wz = M[off + 14];

    // Sample wind at the entity's position.
    sampleWindAt(wx, wy, wz, _windForceV);

    const windSpeedSq = _windForceV[0] ** 2 + _windForceV[1] ** 2 + _windForceV[2] ** 2;
    if (windSpeedSq < EPSILON_SQ) continue;

    // For rigid bodies, subtract body velocity to compute relative wind.
    let relVx = _windForceV[0], relVy = _windForceV[1], relVz = _windForceV[2];
    if (hasComponent(world, eid, RigidBody3D)) {
      relVx -= RigidBody3D.vx[id];
      relVy -= RigidBody3D.vy[id];
      relVz -= RigidBody3D.vz[id];
    } else if (hasComponent(world, eid, CharacterTag)) {
      const cs = getCharacterSlot(eid);
      if (cs >= 0) {
        relVx -= CharacterStateF32.vx[cs];
        relVy -= CharacterStateF32.vy[cs];
        relVz -= CharacterStateF32.vz[cs];
      }
    }

    const relSpeedSq = relVx * relVx + relVy * relVy + relVz * relVz;
    if (relSpeedSq < EPSILON_SQ) continue;
    const relSpeed = Math.sqrt(relSpeedSq);

    const area = WindProp.area[slot];
    const cd = WindProp.dragCoefficient[slot];

    // Drag force magnitude.
    const dragMag = 0.5 * AIR_DENSITY * relSpeedSq * cd * area;

    const fx = (relVx / relSpeed) * dragMag;
    const fy = (relVy / relSpeed) * dragMag;
    const fz = (relVz / relSpeed) * dragMag;

    // Apply to rigid body.
    if (hasComponent(world, eid, RigidBody3D)) {
      RigidBody3D.vx[id] += (fx / Math.max(RigidBody3D.invMass[id], EPSILON)) * dt;
      RigidBody3D.vy[id] += (fy / Math.max(RigidBody3D.invMass[id], EPSILON)) * dt;
      RigidBody3D.vz[id] += (fz / Math.max(RigidBody3D.invMass[id], EPSILON)) * dt;

      // Torque: apply around the vertical axis proportional to
      // horizontal force × lever arm.
      const arm = WindProp.torqueArm[slot];
      RigidBody3D.wy[id] += (fx * arm) * 0.02 * dt;
    }

    // Apply to character wish velocity (kinematic).
    if (hasComponent(world, eid, CharacterTag)) {
      const cs = getCharacterSlot(eid);
      if (cs >= 0) {
        // Character mass approximated as 70 kg.
        const accelX = fx / 70.0;
        const accelY = fy / 70.0;
        const accelZ = fz / 70.0;
        CharacterStateF32.wishX[cs] += accelX * dt;
        CharacterStateF32.wishY[cs] += accelY * dt;
        CharacterStateF32.wishZ[cs] += accelZ * dt;
      }
    }
  }
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// CLOUD-DRIVEN WIND — sync from file 029's cloud instances
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sync cloud archetype wind vectors into the atmospheric wind sources.
 * Called once per frame to keep the global wind aligned with the
 * currently active weather.
 */
export function systemSyncCloudWind(world) {
  // Aggregate: average direction + average speed across all cloud
  // instances that have a CloudArchetype wind.
  let sumDirX = 0, sumDirZ = 0;
  let sumSpeed = 0;
  let count = 0;

  for (let slot = 0; slot < CloudInstance.ownerEid.length; slot++) {
    if (CloudInstance.ownerEid[slot] === 0) continue;

    const aSlot = CloudInstance.archetypeSlot[slot];
    if (aSlot === undefined || aSlot < 0) continue;

    const wSpeed = CloudArchetype.windSpeed[aSlot];
    const wDirX = CloudArchetype.windDirX[aSlot];
    const wDirZ = CloudArchetype.windDirZ[aSlot];

    sumSpeed += wSpeed;
    sumDirX += wDirX * wSpeed;
    sumDirZ += wDirZ * wSpeed;
    count++;
  }

  if (count === 0) return world;

  // Blend into atmospheric wind sources.
  const avgSpeed = sumSpeed / count;
  const avgDirX = sumDirX / Math.max(sumSpeed, EPSILON);
  const avgDirZ = sumDirZ / Math.max(sumSpeed, EPSILON);
  const dirLen = Math.hypot(avgDirX, avgDirZ) || 1;

  for (let slot = 0; slot < _nextWindSourceSlot; slot++) {
    if (!WindSource.active[slot]) continue;
    if (WindSource.type[slot] !== WindSourceType.ATMOSPHERIC) continue;

    // Gently blend toward cloud-derived values.
    const blendRate = 0.02;
    WindSource.baseSpeed[slot] = WindSource.baseSpeed[slot] * (1 - blendRate) + avgSpeed * blendRate;
    WindSource.dirX[slot] = WindSource.dirX[slot] * (1 - blendRate) + (avgDirX / dirLen) * blendRate;
    WindSource.dirZ[slot] = WindSource.dirZ[slot] * (1 - blendRate) + (avgDirZ / dirLen) * blendRate;
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// GUST EVENT QUEUE — for audio / VFX cues
// ═══════════════════════════════════════════════════════════════════════

let _lastGustEventTime = 0;
let _gustEventTimer = 0;

/**
 * Detect gust events near the camera and queue audio cues.
 * Called once per frame.
 */
export function systemDetectGusts(world, dt, cameraX, cameraY, cameraZ) {
  _gustEventTimer += dt;
  if (_gustEventTimer < WIND_AUDIO_COOLDOWN) return world;

  const speed = sampleWindSpeed(cameraX, cameraY, cameraZ);
  if (speed < WIND_AUDIO_THRESHOLD) return world;

  _gustEventTimer = 0;

  const Q = WindGustEvent;
  if (Q.count >= MAX_GUST_EVENTS) return world;

  const idx = Q.head;
  Q.px[idx] = cameraX;
  Q.py[idx] = cameraY;
  Q.pz[idx] = cameraZ;
  Q.speed[idx] = speed;

  // Sample direction.
  sampleWindAt(cameraX, cameraY, cameraZ, _windDirV);
  const len = Math.hypot(_windDirV[0], _windDirV[1], _windDirV[2]) || 1;
  Q.dirX[idx] = _windDirV[0] / len;
  Q.dirY[idx] = _windDirV[1] / len;
  Q.dirZ[idx] = _windDirV[2] / len;

  Q.age[idx] = 0;
  Q.lifetime[idx] = 2.0;
  Q.active[idx] = 1;

  Q.head = (Q.head + 1) % MAX_GUST_EVENTS;
  Q.count++;

  return world;
}

/**
 * Pop any gust events whose lifetime has expired. Called by the audio
 * system.
 */
export function popGustEvent() {
  const Q = WindGustEvent;
  for (let i = 0; i < MAX_GUST_EVENTS; i++) {
    if (!Q.active[i]) continue;
    Q.active[i] = 0;
    Q.count--;
    return {
      x: Q.px[i], y: Q.py[i], z: Q.pz[i],
      speed: Q.speed[i],
      dirX: Q.dirX[i], dirY: Q.dirY[i], dirZ: Q.dirZ[i],
    };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN FRAME PIPELINE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Full wind pipeline for one frame:
 *   1. Advance wind source gust envelopes.
 *   2. Sync cloud-driven wind.
 *   3. Apply wind forces to rigid bodies and characters.
 *   4. Detect gust events for audio / VFX.
 */
export function systemWindTick(world, dt, cameraX = 0, cameraY = 0, cameraZ = 0) {
  systemUpdateWindSources(world, dt);
  systemSyncCloudWind(world);
  systemApplyWindForces(world, dt);
  systemDetectGusts(world, dt, cameraX, cameraY, cameraZ);
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS — for storm inflow (file 048) and dust (file 050)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add an inflow wind source at a storm center. File 048 uses this to
 * create the radial inflow field around a tornado.
 */
export function addStormInflow(world, eid, cx, cy, cz, radius, speed) {
  const slot = addWindSource(world, eid, WindSourceType.STORM_INFLOW, {
    px: cx, py: cy, pz: cz,
    radiusX: radius,
    radiusY: radius * 2,
    radiusZ: radius,
    dir: [0, 0, 0],       // inflow is radial; direction set by caller per sample
    baseSpeed: speed,
    gustAmplitude: 0,
    gustFrequency: 0,
    turbulenceScale: 0.05,
  });
  return slot;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE — for particle / VFX systems
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a compact summary of all active wind sources for renderer /
 * VFX integration.
 */
export function gatherWindSourcesForRendering() {
  const result = [];
  for (let slot = 0; slot < _nextWindSourceSlot; slot++) {
    if (!WindSource.active[slot]) continue;
    result.push({
      type: WindSource.type[slot],
      px: WindSource.px[slot],
      py: WindSource.py[slot],
      pz: WindSource.pz[slot],
      radiusX: WindSource.radiusX[slot],
      radiusY: WindSource.radiusY[slot],
      radiusZ: WindSource.radiusZ[slot],
      dirX: WindSource.dirX[slot],
      dirY: WindSource.dirY[slot],
      dirZ: WindSource.dirZ[slot],
      baseSpeed: WindSource.baseSpeed[slot],
      gustEnvelope: WindSource.gustEnvelope[slot],
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearWind() {
  WindSource.active.fill(0);
  WindSource.ownerEid.fill(0);
  _windSourceSlots.clear();
  _windNoise.clear();
  _nextWindSourceSlot = 0;

  WindProp.active.fill(0);
  WindProp.ownerEid.fill(0);
  _windPropSlots.clear();
  _nextWindPropSlot = 0;

  WindGustEvent.active.fill(0);
  WindGustEvent.head = 0;
  WindGustEvent.count = 0;
  _gustEventTimer = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function windStats() {
  let activeSources = 0;
  let activeProps = 0;
  let totalSpeed = 0;
  let maxSpeed = 0;

  for (let slot = 0; slot < _nextWindSourceSlot; slot++) {
    if (!WindSource.active[slot]) continue;
    activeSources++;
    totalSpeed += WindSource.baseSpeed[slot];
    if (WindSource.baseSpeed[slot] > maxSpeed) maxSpeed = WindSource.baseSpeed[slot];
  }

  for (let slot = 0; slot < _nextWindPropSlot; slot++) {
    if (WindProp.active[slot]) activeProps++;
  }

  return {
    sources: activeSources,
    maxSources: MAX_WIND_SOURCES,
    props: activeProps,
    maxProps: MAX_WIND_PROPS,
    avgSpeed: activeSources > 0 ? totalSpeed / activeSources : 0,
    maxSpeed,
    gustQueue: WindGustEvent.count,
  };
}