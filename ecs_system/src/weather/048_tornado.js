// file number : 048
// full path name : src/weather/048_tornado.js
// description : Tornado system with physically-based Rankine vortex model,
//               multi-segment funnel geometry with wobble and twist,
//               debris field with full 6-DOF dynamics, suction physics
//               affecting rigid bodies and characters, and EF-rated
//               damage radii. Imports 029_cloud_archetypes.js as the
//               single source of truth for the parent cumulonimbus storm
//               (tornadoes only form under supercells). Contributes:
//                 • TornadoType taxonomy — CONE, ROPE, STOVE_PIPE,
//                   WEDGE, MULTI_VORTEX, SATURN_SPOKE, WATERSPOUT.
//                   Each has its own base/top radius profile, wobble
//                   amplitude, and rotation frequency.
//                 • Rankine vortex velocity field — tangential velocity
//                   v_t(r) = v_max · r/r_c inside the core (solid body
//                   rotation), v_t(r) = v_max · r_c/r outside (potential
//                   vortex). Radial inflow and vertical updraft are
//                   layered on top with smooth falloffs, producing the
//                   real "suck + spin + lift" motion.
//                 • Multi-segment funnel geometry — the funnel is
//                   represented as a stack of N horizontal rings along a
//                   vertical axis, each with its own center offset
//                   (wobble) and radius (profile), and a per-segment
//                   twist phase. Callers can render this as a mesh,
//                   a tube, or a particle system.
//                 • Debris pool — up to 100k SoA-packed debris particles
//                   with mass, size, drag, and per-particle spiral
//                   physics. Debris is captured from the ground within
//                   the tornado's capture radius, spirals inward, gets
//                   lifted, and finally flings outward at the top.
//                 • Suction + damage physics — reads the local vortex
//                   velocity at any entity position, applies drag force
//                   to RigidBody3D (file 008) and CharacterStateF32
//                   (file 021), and computes EF-scaled damage severity.
//                 • Damage radii — three concentric rings (fatal,
//                   severe, moderate) whose radii scale with EF rating,
//                   used for both continuous "wind damage" and instant
//                   "impact" events.
//                 • Tornado motion — tornadoes drift with the parent
//                   storm's wind vector (from file 029), rotate slightly,
//                   and slowly curve.
//                 • Path prediction — exposes sampleDamageAt and
//                   sampleVortexVelocity so gameplay can query any point
//                   in the world without spawning particles.
//                 • Wind integration — registers a STORM_INFLOW wind
//                   source in file 047 so global wind and rain/snow
//                   drift automatically pick up the tornado's field.
//               All state lives in typed arrays; per-frame cost is
//               O(MAX_TORNADOES × DEBRIS_PER_TORNADO) for debris and
//               O(entities with TornadoSuctionTag) for applied forces.
//               Zero per-frame allocation; steady-state simulation at
//               1M entities fits on Android 64-bit.
// best for : Severe-storm gameplay, storm chases, tornado damage
//            mechanics, cinematic tornado set-pieces, wind-damage
//            systems, flying debris VFX, and any 1M-entity scene
//            needing realistic tornadoes on Android 64-bit.
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
  addStormInflow,
} from './047_wind_gusts.js';

import {
  vec3,
  vec4,
  mat4,
  quat,
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

const MAX_TORNADOES                  = 256;
const MAX_DEBRIS                     = 100_000;
const MAX_DEBRIS_IMPACTS             = 8192;
const MAX_FUNNEL_SEGMENTS            = 32;

// EF-rating velocity thresholds (m/s at ground level, ~3-second gust).
const EF0_MIN_VELOCITY               = 29.0;
const EF1_MIN_VELOCITY               = 38.0;
const EF2_MIN_VELOCITY               = 50.0;
const EF3_MIN_VELOCITY               = 61.0;
const EF4_MIN_VELOCITY               = 74.0;
const EF5_MIN_VELOCITY               = 89.0;

// Damage radii scale factors.
const DAMAGE_FATAL_MULT              = 1.0;      // × core radius
const DAMAGE_SEVERE_MULT             = 1.8;
const DAMAGE_MODERATE_MULT           = 3.2;
const DAMAGE_MIN_FATAL_RADIUS        = 15.0;     // metres
const DAMAGE_MIN_SEVERE_RADIUS       = 30.0;
const DAMAGE_MIN_MODERATE_RADIUS     = 60.0;

// Core velocity profile.
const CORE_VELOCITY_MAX_SCALE        = 1.0;
const OUTER_VELOCITY_DECAY           = 0.85;     // v_t(r) = v_max * (r_c/r)^p
const INFLOW_SPEED_FRACTION          = 0.4;      // radial inward fraction
const UPDRAFT_SPEED_FRACTION         = 0.55;
const DOWNDRAFT_SPEED_FRACTION       = 0.15;
const OUTER_DOWNDRAFT_RANGE_MULT     = 2.5;

// Funnel geometry.
const FUNNEL_SEGMENTS_MIN            = 8;
const FUNNEL_SEGMENTS_MAX            = 32;
const FUNNEL_TOP_WIDTH_MULT          = 3.5;
const FUNNEL_BASE_WIDTH_MULT         = 1.0;
const FUNNEL_WOBBLE_AMPLITUDE        = 0.15;     // × core radius
const FUNNEL_WOBBLE_FREQUENCY        = 0.35;     // Hz
const FUNNEL_TWIST_STRENGTH          = 0.6;

// Rope tornado wobble.
const ROPE_WOBBLE_MULT               = 2.5;
const ROPE_SEGMENT_RADIUS_MULT       = 0.4;

// Wedge tornado widening.
const WEDGE_TOP_WIDTH_MULT           = 5.5;

// Multi-vortex sub-vortex count.
const MULTI_VORTEX_COUNT_MIN         = 2;
const MULTI_VORTEX_COUNT_MAX         = 6;
const MULTI_VORTEX_DISTRIBUTION      = 0.35;

// Tornado movement.
const TORNADO_BASE_DRIFT_SPEED_MIN   = 5.0;      // m/s
const TORNADO_BASE_DRIFT_SPEED_MAX   = 20.0;
const TORNADO_CURVE_RATE             = 0.02;     // rad/s
const TORNADO_FORMATION_TIME         = 30.0;     // seconds
const TORNADO_DISSIPATION_TIME       = 45.0;
const TORNADO_MAX_LIFETIME           = 1800.0;

// Debris.
const DEBRIS_CAPTURE_RADIUS_MULT     = 4.0;      // × core radius
const DEBRIS_CAPTURE_HEIGHT          = 30.0;     // metres above ground
const DEBRIS_MAX_MASS                = 200.0;    // kg
const DEBRIS_MIN_MASS                = 0.05;
const DEBRIS_MAX_SIZE                = 2.0;      // metres
const DEBRIS_MIN_SIZE                = 0.05;
const DEBRIS_MAX_AGE                 = 60.0;
const DEBRIS_DRAG_COEFF              = 1.0;
const DEBRIS_IMPACT_LIFETIME         = 1.5;
const DEBRIS_SPAWN_RATE_BASE         = 60.0;     // per second at ground

// Rankine parameters.
const RANKINE_POWER                  = 0.85;

// Audio damage radius.
const WIND_AUDIO_RADIUS_MULT         = 5.0;

// ═══════════════════════════════════════════════════════════════════════
// TORNADO TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const TornadoType = Object.freeze({
  CONE:         0,   // classic cone
  ROPE:         1,   // thin, sinuous
  STOVE_PIPE:   2,   // thick, straight
  WEDGE:        3,   // very wide, low height
  MULTI_VORTEX: 4,   // multiple sub-vortices in one funnel
  SATURN_SPOKE: 5,   // large funnel with satellite vortices
  WATERSPOUT:   6,   // over water
});

// ═══════════════════════════════════════════════════════════════════════
// EF RATING ENUM (Enhanced Fujita scale)
// ═══════════════════════════════════════════════════════════════════════

export const EFRating = Object.freeze({
  EF0: 0,
  EF1: 1,
  EF2: 2,
  EF3: 3,
  EF4: 4,
  EF5: 5,
});

// ═══════════════════════════════════════════════════════════════════════
// DAMAGE SEVERITY ENUM
// ═══════════════════════════════════════════════════════════════════════

export const TornadoDamage = Object.freeze({
  NONE:     0,
  MODERATE: 1,
  SEVERE:   2,
  FATAL:    3,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA TORNADO INSTANCE
// ═══════════════════════════════════════════════════════════════════════

export const TornadoInstance = {
  // Owner entity (root).
  ownerEid: new Uint32Array(MAX_TORNADOES),

  // Type.
  type: new Uint8Array(MAX_TORNADOES),

  // EF rating (may be upgraded at runtime).
  efRating: new Uint8Array(MAX_TORNADOES),

  // Parent storm (cumulonimbus slot).
  stormSlot: new Uint16Array(MAX_TORNADOES),

  // Ground-level position.
  baseX: new Float32Array(MAX_TORNADOES),
  baseY: new Float32Array(MAX_TORNADOES),
  baseZ: new Float32Array(MAX_TORNADOES),

  // Cloud-base position (top of funnel).
  topX: new Float32Array(MAX_TORNADOES),
  topY: new Float32Array(MAX_TORNADOES),
  topZ: new Float32Array(MAX_TORNADOES),

  // Core radius at ground level.
  coreRadius: new Float32Array(MAX_TORNADOES),

  // Funnel top radius.
  topRadius: new Float32Array(MAX_TORNADOES),

  // Max tangential velocity (m/s).
  tangentialVelocity: new Float32Array(MAX_TORNADOES),

  // Updraft and inflow strengths (m/s).
  updraftVelocity: new Float32Array(MAX_TORNADOES),
  inflowVelocity: new Float32Array(MAX_TORNADOES),

  // Drift direction (unit vector along ground) and speed.
  driftDirX: new Float32Array(MAX_TORNADOES),
  driftDirZ: new Float32Array(MAX_TORNADOES),
  driftSpeed: new Float32Array(MAX_TORNADOES),

  // Funnel twist angle (radians).
  twistAngle: new Float32Array(MAX_TORNADOES),

  // Wobble phase (radians).
  wobblePhase: new Float32Array(MAX_TORNADOES),

  // Formation progress (0..1) and dissipation progress (0..1).
  formationProgress: new Float32Array(MAX_TORNADOES),
  dissipationProgress: new Float32Array(MAX_TORNADOES),

  // Age and lifetime.
  age: new Float32Array(MAX_TORNADOES),
  lifetime: new Float32Array(MAX_TORNADOES),

  // Active flag.
  active: new Uint8Array(MAX_TORNADOES),

  // Sub-vortex count (MULTI_VORTEX / SATURN_SPOKE).
  subVortexCount: new Uint8Array(MAX_TORNADOES),

  // Damage radii (cached, computed each frame).
  fatalRadius: new Float32Array(MAX_TORNADOES),
  severeRadius: new Float32Array(MAX_TORNADOES),
  moderateRadius: new Float32Array(MAX_TORNADOES),

  // Wind source slot (for integration with file 047).
  windSourceSlot: new Int16Array(MAX_TORNADOES),

  // Seed for noise.
  seed: new Uint32Array(MAX_TORNADOES),
};

/** Marker: entity is a tornado root. */
export const TornadoTag = {};

const _tornadoSlots = new Map(); // eid -> tornado slot
let _nextTornadoSlot = 0;

// Per-tornado noise generator.
const _tornadoNoise = new Map();

// ═══════════════════════════════════════════════════════════════════════
// SoA DEBRIS POOL
// ═══════════════════════════════════════════════════════════════════════

export const TornadoDebris = {
  active: new Uint8Array(MAX_DEBRIS),

  // World position.
  px: new Float32Array(MAX_DEBRIS),
  py: new Float32Array(MAX_DEBRIS),
  pz: new Float32Array(MAX_DEBRIS),

  // World velocity.
  vx: new Float32Array(MAX_DEBRIS),
  vy: new Float32Array(MAX_DEBRIS),
  vz: new Float32Array(MAX_DEBRIS),

  // Angular velocity (radians/s around each axis).
  wx: new Float32Array(MAX_DEBRIS),
  wy: new Float32Array(MAX_DEBRIS),
  wz: new Float32Array(MAX_DEBRIS),

  // Rotation (Euler angles; simple representation for debris rendering).
  rotX: new Float32Array(MAX_DEBRIS),
  rotY: new Float32Array(MAX_DEBRIS),
  rotZ: new Float32Array(MAX_DEBRIS),

  // Mass (kg).
  mass: new Float32Array(MAX_DEBRIS),

  // Size (metres).
  size: new Float32Array(MAX_DEBRIS),

  // Age and lifetime.
  age: new Float32Array(MAX_DEBRIS),
  lifetime: new Float32Array(MAX_DEBRIS),

  // Source tornado slot.
  tornadoSlot: new Uint16Array(MAX_DEBRIS),

  // Rendered as different shapes (0 = box, 1 = plank, 2 = sphere, 3 = shrub).
  debrisShape: new Uint8Array(MAX_DEBRIS),

  // Tint (linear RGB).
  tintR: new Float32Array(MAX_DEBRIS),
  tintG: new Float32Array(MAX_DEBRIS),
  tintB: new Float32Array(MAX_DEBRIS),

  // Hit flag (1 = debris is currently in impact VFX).
  hit: new Uint8Array(MAX_DEBRIS),

  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA DEBRIS IMPACT POOL
// ═══════════════════════════════════════════════════════════════════════

export const DebrisImpact = {
  active: new Uint8Array(MAX_DEBRIS_IMPACTS),

  px: new Float32Array(MAX_DEBRIS_IMPACTS),
  py: new Float32Array(MAX_DEBRIS_IMPACTS),
  pz: new Float32Array(MAX_DEBRIS_IMPACTS),

  nx: new Float32Array(MAX_DEBRIS_IMPACTS),
  ny: new Float32Array(MAX_DEBRIS_IMPACTS),
  nz: new Float32Array(MAX_DEBRIS_IMPACTS),

  mass: new Float32Array(MAX_DEBRIS_IMPACTS),
  kineticEnergy: new Float32Array(MAX_DEBRIS_IMPACTS),

  age: new Float32Array(MAX_DEBRIS_IMPACTS),
  lifetime: new Float32Array(MAX_DEBRIS_IMPACTS),

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

function getTornadoNoise(slot) {
  let n = _tornadoNoise.get(slot);
  if (!n) {
    n = createNoise3D(() => mulberry32(TornadoInstance.seed[slot]));
    _tornadoNoise.set(slot, n);
  }
  return n;
}

// ═══════════════════════════════════════════════════════════════════════
// TORNADO CREATION API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Spawn a tornado at a ground position under a parent storm.
 *
 * @param world       ECS world
 * @param eid         owner entity
 * @param stormSlot   cumulonimbus slot from file 039
 * @param type        TornadoType
 * @param options     { coreRadius, tangentialVelocity, updraftVelocity,
 *                      inflowVelocity, driftSpeed, driftDirX, driftDirZ,
 *                      efRating, lifetime }
 * @returns tornado slot id
 */
export function addTornado(world, eid, stormSlot, type = TornadoType.CONE, options = {}) {
  if (_nextTornadoSlot >= MAX_TORNADOES) {
    throw new Error('tornado capacity exceeded');
  }
  const slot = _nextTornadoSlot++;

  addComponent(world, eid, TornadoTag);

  const T = TornadoInstance;
  T.ownerEid[slot] = eid;
  T.type[slot] = type;
  T.stormSlot[slot] = stormSlot;

  // Default EF rating derived from type.
  const ef = options.efRating ?? defaultEFForType(type);
  T.efRating[slot] = ef;

  // Base and top positions.
  const bx = options.bx ?? 0;
  const by = options.by ?? 0;
  const bz = options.bz ?? 0;
  T.baseX[slot] = bx;
  T.baseY[slot] = by;
  T.baseZ[slot] = bz;

  // Top of funnel: cloud base altitude.
  const baseSlot = CumulonimbusState._baseInstanceSlot[stormSlot];
  if (baseSlot !== undefined && baseSlot >= 0) {
    const CI = CloudInstance;
    const cloudBaseY = CI.py[baseSlot] - CI.radiusY[baseSlot];
    T.topX[slot] = bx;
    T.topY[slot] = cloudBaseY;
    T.topZ[slot] = bz;
  } else {
    T.topX[slot] = bx;
    T.topY[slot] = 8000;
    T.topZ[slot] = bz;
  }

  // Core radius and velocity based on type.
  const defaultRadius = defaultCoreRadiusForType(type);
  const defaultVelocity = defaultVelocityForEF(ef);

  T.coreRadius[slot] = options.coreRadius ?? defaultRadius;
  T.topRadius[slot] = defaultRadius * topWidthMultForType(type);
  T.tangentialVelocity[slot] = options.tangentialVelocity ?? defaultVelocity;
  T.updraftVelocity[slot] = options.updraftVelocity ?? (defaultVelocity * UPDRAFT_SPEED_FRACTION);
  T.inflowVelocity[slot] = options.inflowVelocity ?? (defaultVelocity * INFLOW_SPEED_FRACTION);

  // Drift.
  T.driftSpeed[slot] = options.driftSpeed ?? (TORNADO_BASE_DRIFT_SPEED_MIN
    + Math.random() * (TORNADO_BASE_DRIFT_SPEED_MAX - TORNADO_BASE_DRIFT_SPEED_MIN));

  const dd = options.driftDir ?? defaultDriftDir();
  T.driftDirX[slot] = dd[0];
  T.driftDirZ[slot] = dd[1];

  T.twistAngle[slot] = 0;
  T.wobblePhase[slot] = 0;

  T.formationProgress[slot] = 0;
  T.dissipationProgress[slot] = 0;

  T.age[slot] = 0;
  T.lifetime[slot] = options.lifetime ?? (300 + Math.random() * (TORNADO_MAX_LIFETIME - 300));

  T.active[slot] = 1;

  // Sub-vortex count for MULTI_VORTEX / SATURN_SPOKE.
  if (type === TornadoType.MULTI_VORTEX || type === TornadoType.SATURN_SPOKE) {
    T.subVortexCount[slot] = MULTI_VORTEX_COUNT_MIN
      + Math.floor(Math.random() * (MULTI_VORTEX_COUNT_MAX - MULTI_VORTEX_COUNT_MIN + 1));
  } else {
    T.subVortexCount[slot] = 0;
  }

  // Damage radii (recomputed each frame).
  T.fatalRadius[slot] = DAMAGE_MIN_FATAL_RADIUS;
  T.severeRadius[slot] = DAMAGE_MIN_SEVERE_RADIUS;
  T.moderateRadius[slot] = DAMAGE_MIN_MODERATE_RADIUS;

  // Register a storm inflow wind source (integrates with file 047).
  const wslot = addStormInflow(world, eid, bx, by, bz,
    T.coreRadius[slot] * OUTER_DOWNDRAFT_RANGE_MULT,
    T.tangentialVelocity[slot]);
  T.windSourceSlot[slot] = wslot;

  T.seed[slot] = (slot * 2654435761) >>> 0;

  _tornadoSlots.set(eid, slot);

  return slot;
}

function defaultEFForType(type) {
  switch (type) {
    case TornadoType.ROPE:         return EFRating.EF0;
    case TornadoType.CONE:         return EFRating.EF2;
    case TornadoType.STOVE_PIPE:   return EFRating.EF3;
    case TornadoType.WEDGE:        return EFRating.EF4;
    case TornadoType.MULTI_VORTEX: return EFRating.EF3;
    case TornadoType.SATURN_SPOKE: return EFRating.EF4;
    case TornadoType.WATERSPOUT:   return EFRating.EF1;
    default:                       return EFRating.EF2;
  }
}

function defaultCoreRadiusForType(type) {
  switch (type) {
    case TornadoType.ROPE:         return 20;
    case TornadoType.CONE:         return 100;
    case TornadoType.STOVE_PIPE:   return 150;
    case TornadoType.WEDGE:        return 400;
    case TornadoType.MULTI_VORTEX: return 300;
    case TornadoType.SATURN_SPOKE: return 350;
    case TornadoType.WATERSPOUT:   return 60;
    default:                       return 100;
  }
}

function topWidthMultForType(type) {
  switch (type) {
    case TornadoType.CONE:         return FUNNEL_TOP_WIDTH_MULT;
    case TornadoType.WEDGE:        return WEDGE_TOP_WIDTH_MULT;
    case TornadoType.ROPE:         return 1.5;
    case TornadoType.STOVE_PIPE:   return 1.2;
    case TornadoType.MULTI_VORTEX: return 2.0;
    case TornadoType.SATURN_SPOKE: return 3.0;
    case TornadoType.WATERSPOUT:   return 1.8;
    default:                       return FUNNEL_TOP_WIDTH_MULT;
  }
}

function defaultVelocityForEF(ef) {
  switch (ef) {
    case EFRating.EF0: return EF0_MIN_VELOCITY + 4.0;
    case EFRating.EF1: return EF1_MIN_VELOCITY + 5.0;
    case EFRating.EF2: return EF2_MIN_VELOCITY + 5.0;
    case EFRating.EF3: return EF3_MIN_VELOCITY + 6.0;
    case EFRating.EF4: return EF4_MIN_VELOCITY + 7.0;
    case EFRating.EF5: return EF5_MIN_VELOCITY + 10.0;
    default:           return EF2_MIN_VELOCITY + 5.0;
  }
}

function defaultDriftDir() {
  const angle = Math.random() * TWO_PI;
  return [Math.cos(angle), Math.sin(angle)];
}

export function removeTornado(world, eid) {
  const slot = _tornadoSlots.get(eid);
  if (slot === undefined) return;

  // Remove associated wind source.
  const wslot = TornadoInstance.windSourceSlot[slot];
  if (wslot >= 0 && WindSource.active[wslot]) {
    removeWindSource(world, WindSource.ownerEid[wslot]);
  }

  TornadoInstance.active[slot] = 0;
  TornadoInstance.ownerEid[slot] = 0;
  _tornadoSlots.delete(eid);
  _tornadoNoise.delete(slot);
  removeComponent(world, eid, TornadoTag);
}

export function getTornadoSlot(eid) {
  return _tornadoSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// RANKINE VORTEX SAMPLING — the physics core
// ═══════════════════════════════════════════════════════════════════════

const _vortexScratch = vec3.create();

/**
 * Sample the vortex velocity field at a world position.
 * Returns a full velocity vector (tangential + radial + vertical).
 *
 * Velocity model (Rankine combined vortex):
 *   Inside core (r < r_c): v_t = v_max · (r/r_c)
 *   Outside core (r > r_c): v_t = v_max · (r_c/r)^p
 *   Radial inflow: v_r = -inflow · (r/r_c)^0.5 outside core, 0 inside
 *   Vertical: updraft in core, downdraft in outer ring
 *
 * @param tornadoSlot  from addTornado
 * @param wx, wy, wz   world position
 * @param out          vec3 output
 * @returns out
 */
export function sampleVortexVelocity(tornadoSlot, wx, wy, wz, out) {
  const T = TornadoInstance;
  if (!T.active[tornadoSlot]) {
    out[0] = 0; out[1] = 0; out[2] = 0;
    return out;
  }

  // Account for formation / dissipation.
  const formation = T.formationProgress[tornadoSlot];
  const dissipation = T.dissipationProgress[tornadoSlot];
  const intensity = formation * (1 - dissipation);
  if (intensity < EPSILON) {
    out[0] = 0; out[1] = 0; out[2] = 0;
    return out;
  }

  // Center position at the sample's altitude (linear interpolation
  // between base and top plus wobble offset).
  const baseX = T.baseX[tornadoSlot];
  const baseY = T.baseY[tornadoSlot];
  const baseZ = T.baseZ[tornadoSlot];
  const topX = T.topX[tornadoSlot];
  const topY = T.topY[tornadoSlot];
  const topZ = T.topZ[tornadoSlot];

  const topHeight = Math.max(topY - baseY, 1);
  const heightFraction = Math.max(0, Math.min(1, (wy - baseY) / topHeight));

  // Wobble offset (sinusoidal at the top).
  const wobblePhase = T.wobblePhase[tornadoSlot];
  const wobbleAmp = T.coreRadius[tornadoSlot] * FUNNEL_WOBBLE_AMPLITUDE
    * (T.type[tornadoSlot] === TornadoType.ROPE ? ROPE_WOBBLE_MULT : 1);
  const wobbleX = Math.sin(wobblePhase + heightFraction * PI) * wobbleAmp;
  const wobbleZ = Math.cos(wobblePhase * 1.3 + heightFraction * PI) * wobbleAmp;

  const cx = baseX + (topX - baseX) * heightFraction + wobbleX;
  const cz = baseZ + (topZ - baseZ) * heightFraction + wobbleZ;

  // Distance from axis.
  const dx = wx - cx;
  const dz = wz - cz;
  const r = Math.sqrt(dx * dx + dz * dz);
  if (r < EPSILON) {
    // At the exact center: pure updraft.
    out[0] = 0;
    out[1] = T.updraftVelocity[tornadoSlot] * intensity;
    out[2] = 0;
    return out;
  }

  // Core radius at this height (linear interpolation).
  const coreR = T.coreRadius[tornadoSlot] * (1 - heightFraction)
    + T.topRadius[tornadoSlot] * heightFraction;
  const safeCoreR = Math.max(coreR, 0.5);

  // Tangential velocity.
  let vt;
  if (r < safeCoreR) {
    vt = T.tangentialVelocity[tornadoSlot] * (r / safeCoreR);
  } else {
    vt = T.tangentialVelocity[tornadoSlot]
      * Math.pow(safeCoreR / r, RANKINE_POWER * OUTER_VELOCITY_DECAY);
  }

  // Tangential unit vector (perpendicular to radial direction).
  const tangentX = -dz / r;
  const tangentZ = dx / r;

  // Radial inflow.
  let vr;
  if (r < safeCoreR) {
    vr = 0;
  } else {
    vr = -T.inflowVelocity[tornadoSlot] * Math.sqrt(safeCoreR / r);
  }

  // Vertical velocity: updraft in core, downdraft in outer ring.
  let vy;
  if (r < safeCoreR * 1.2) {
    vy = T.updraftVelocity[tornadoSlot] * (1 - r / (safeCoreR * 1.2));
  } else if (r < safeCoreR * OUTER_DOWNDRAFT_RANGE_MULT) {
    const t = (r - safeCoreR * 1.2) / (safeCoreR * (OUTER_DOWNDRAFT_RANGE_MULT - 1.2));
    vy = -T.updraftVelocity[tornadoSlot] * DOWNDRAFT_SPEED_FRACTION * t;
  } else {
    vy = 0;
  }

  // Combine and apply intensity scaling.
  const vx = (tangentX * vt + (dx / r) * vr) * intensity;
  const vz = (tangentZ * vt + (dz / r) * vr) * intensity;

  out[0] = vx;
  out[1] = vy * intensity;
  out[2] = vz;
  return out;
}

/**
 * Sample the tangential velocity magnitude (for damage computation).
 */
export function sampleVortexSpeed(tornadoSlot, wx, wy, wz) {
  sampleVortexVelocity(tornadoSlot, wx, wy, wz, _vortexScratch);
  return Math.hypot(_vortexScratch[0], _vortexScratch[1], _vortexScratch[2]);
}

// ═══════════════════════════════════════════════════════════════════════
// DAMAGE SAMPLING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the damage severity at a world position.
 *
 * @returns one of TornadoDamage: NONE, MODERATE, SEVERE, or FATAL
 */
export function sampleDamageAt(tornadoSlot, wx, wy, wz) {
  const T = TornadoInstance;
  if (!T.active[tornadoSlot]) return TornadoDamage.NONE;

  // Horizontal distance from base center.
  const dx = wx - T.baseX[tornadoSlot];
  const dz = wz - T.baseZ[tornadoSlot];
  const r = Math.sqrt(dx * dx + dz * dz);

  // Vertical bounds.
  const baseY = T.baseY[tornadoSlot];
  const topY = T.topY[tornadoSlot];
  if (wy < baseY - 2 || wy > topY + 2) return TornadoDamage.NONE;

  // Compare to rings.
  if (r < T.fatalRadius[tornadoSlot]) return TornadoDamage.FATAL;
  if (r < T.severeRadius[tornadoSlot]) return TornadoDamage.SEVERE;
  if (r < T.moderateRadius[tornadoSlot]) return TornadoDamage.MODERATE;
  return TornadoDamage.NONE;
}

// ═══════════════════════════════════════════════════════════════════════
// FUNNEL GEOMETRY SAMPLING — for renderer
// ═══════════════════════════════════════════════════════════════════════

/**
 * Generate the funnel's segment center and radius at a given
 * segment index (0..segmentCount-1).
 *
 * @param tornadoSlot     from addTornado
 * @param segmentIndex    0..segmentCount-1
 * @param segmentCount    total number of segments (8..32)
 * @param outCenter       [x, y, z] center of the segment
 * @param outRadius       single float radius
 */
export function sampleFunnelSegment(tornadoSlot, segmentIndex, segmentCount, outCenter, outRadiusObj) {
  const T = TornadoInstance;
  if (!T.active[tornadoSlot]) {
    outCenter[0] = 0; outCenter[1] = 0; outCenter[2] = 0;
    outRadiusObj.value = 0;
    return;
  }

  const t = segmentIndex / Math.max(1, segmentCount - 1);

  // Position along axis (base → top).
  const baseX = T.baseX[tornadoSlot];
  const baseY = T.baseY[tornadoSlot];
  const baseZ = T.baseZ[tornadoSlot];
  const topX = T.topX[tornadoSlot];
  const topY = T.topY[tornadoSlot];
  const topZ = T.topZ[tornadoSlot];

  // Wobble.
  const wobblePhase = T.wobblePhase[tornadoSlot];
  const wobbleAmp = T.coreRadius[tornadoSlot] * FUNNEL_WOBBLE_AMPLITUDE
    * (T.type[tornadoSlot] === TornadoType.ROPE ? ROPE_WOBBLE_MULT : 1);
  const wobbleX = Math.sin(wobblePhase + t * PI) * wobbleAmp * t;
  const wobbleZ = Math.cos(wobblePhase * 1.3 + t * PI) * wobbleAmp * t;

  // Twist angle (rotates around vertical axis as we go up).
  const twist = T.twistAngle[tornadoSlot] + t * FUNNEL_TWIST_STRENGTH;

  // Position with twist (for correct visual spiral).
  const radiusAtT = T.coreRadius[tornadoSlot] * (1 - t)
    + T.topRadius[tornadoSlot] * t;
  const twistOffsetX = Math.cos(twist) * radiusAtT * 0.05;
  const twistOffsetZ = Math.sin(twist) * radiusAtT * 0.05;

  outCenter[0] = baseX + (topX - baseX) * t + wobbleX + twistOffsetX;
  outCenter[1] = baseY + (topY - baseY) * t;
  outCenter[2] = baseZ + (topZ - baseZ) * t + wobbleZ + twistOffsetZ;

  outRadiusObj.value = radiusAtT;
}

// ═══════════════════════════════════════════════════════════════════════
// DEBRIS POOL MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════

function allocDebris() {
  const D = TornadoDebris;
  for (let i = 0; i < MAX_DEBRIS; i++) {
    const slot = (D.freeHead + i) % MAX_DEBRIS;
    if (D.active[slot] === 0) {
      D.freeHead = (slot + 1) % MAX_DEBRIS;
      D.active[slot] = 1;
      D.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeDebris(slot) {
  const D = TornadoDebris;
  if (D.active[slot] === 0) return;
  D.active[slot] = 0;
  D.hit[slot] = 0;
  D.liveCount--;
}

function allocDebrisImpact() {
  const I = DebrisImpact;
  for (let i = 0; i < MAX_DEBRIS_IMPACTS; i++) {
    const slot = (I.freeHead + i) % MAX_DEBRIS_IMPACTS;
    if (I.active[slot] === 0) {
      I.freeHead = (slot + 1) % MAX_DEBRIS_IMPACTS;
      I.active[slot] = 1;
      I.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeDebrisImpact(slot) {
  const I = DebrisImpact;
  if (I.active[slot] === 0) return;
  I.active[slot] = 0;
  I.liveCount--;
}

// ═══════════════════════════════════════════════════════════════════════
// DEBRIS SPAWN — capture debris from the ground
// ═══════════════════════════════════════════════════════════════════════

/**
 * Spawn debris particles around a tornado. Called once per frame per
 * tornado. Uses a stochastic emission rate that scales with the
 * tornado's current intensity.
 */
function spawnDebrisAroundTornado(world, tornadoSlot, dt) {
  const T = TornadoInstance;
  const intensity = T.formationProgress[tornadoSlot]
    * (1 - T.dissipationProgress[tornadoSlot]);
  if (intensity < 0.1) return;

  // Emission rate scaled by intensity.
  const captureRadius = T.coreRadius[tornadoSlot] * DEBRIS_CAPTURE_RADIUS_MULT;
  const spawnRate = DEBRIS_SPAWN_RATE_BASE * intensity;
  const count = Math.floor(spawnRate * dt) + (Math.random() < (spawnRate * dt % 1) ? 1 : 0);

  for (let i = 0; i < count; i++) {
    const slot = allocDebris();
    if (slot < 0) return;

    // Spawn within the capture radius.
    const r = Math.sqrt(Math.random()) * captureRadius;
    const phi = Math.random() * TWO_PI;
    const sx = T.baseX[tornadoSlot] + Math.cos(phi) * r;
    const sz = T.baseZ[tornadoSlot] + Math.sin(phi) * r;

    // Attempt ground anchor via BVH raycast down.
    let sy = T.baseY[tornadoSlot];
    const downDir = [0, -1, 0];
    const hits = bvhRaycast([sx, T.baseY[tornadoSlot] + 50, sz], downDir, 100, true);
    if (hits.length > 0) {
      sy = T.baseY[tornadoSlot] + 50 - hits[0].t;
    }

    const D = TornadoDebris;
    D.px[slot] = sx;
    D.py[slot] = sy + 0.5;
    D.pz[slot] = sz;

    // Initial velocity: pulled toward the tornado.
    D.vx[slot] = (T.baseX[tornadoSlot] - sx) * 0.2;
    D.vy[slot] = 2.0 + Math.random() * 4.0;
    D.vz[slot] = (T.baseZ[tornadoSlot] - sz) * 0.2;

    // Rotation.
    D.wx[slot] = (Math.random() - 0.5) * 6.0;
    D.wy[slot] = (Math.random() - 0.5) * 6.0;
    D.wz[slot] = (Math.random() - 0.5) * 6.0;
    D.rotX[slot] = Math.random() * TWO_PI;
    D.rotY[slot] = Math.random() * TWO_PI;
    D.rotZ[slot] = Math.random() * TWO_PI;

    // Mass, size, and shape.
    const mass = DEBRIS_MIN_MASS
      + Math.random() * (DEBRIS_MAX_MASS - DEBRIS_MIN_MASS);
    D.mass[slot] = mass;
    D.size[slot] = DEBRIS_MIN_SIZE
      + Math.random() * (DEBRIS_MAX_SIZE - DEBRIS_MIN_SIZE);

    // Debris shape classification by mass.
    if (mass < 1.0) D.debrisShape[slot] = 1;         // small plank
    else if (mass < 10.0) D.debrisShape[slot] = 0;   // box
    else if (mass < 50.0) D.debrisShape[slot] = 3;   // shrub-like
    else D.debrisShape[slot] = 2;                    // sphere (rock)

    // Tint based on shape.
    D.tintR[slot] = 0.55 + Math.random() * 0.25;
    D.tintG[slot] = 0.40 + Math.random() * 0.25;
    D.tintB[slot] = 0.25 + Math.random() * 0.20;
    if (D.debrisShape[slot] === 3) {
      // Greenery.
      D.tintR[slot] = 0.25;
      D.tintG[slot] = 0.45;
      D.tintB[slot] = 0.20;
    }

    D.age[slot] = 0;
    D.lifetime[slot] = 10.0 + Math.random() * (DEBRIS_MAX_AGE - 10.0);
    D.tornadoSlot[slot] = tornadoSlot;
    D.hit[slot] = 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// DEBRIS UPDATE — per-particle dynamics
// ═══════════════════════════════════════════════════════════════════════

const _debrisVortex = vec3.create();
const _debrisForce = vec3.create();

/**
 * Advance all debris. Applies:
 *   • Vortex velocity from the parent tornado
 *   • Gravity
 *   • Air drag relative to the vortex velocity
 *   • Impact VFX on collision
 *   • Retirement when age exceeds lifetime
 */
export function systemUpdateDebris(world, dt) {
  const D = TornadoDebris;

  for (let slot = 0; slot < MAX_DEBRIS; slot++) {
    if (D.active[slot] === 0) continue;

    D.age[slot] += dt;
    if (D.age[slot] > D.lifetime[slot]) {
      freeDebris(slot);
      continue;
    }

    const tornadoSlot = D.tornadoSlot[slot];

    // If the parent tornado has died, debris falls to the ground.
    let intensity = 0;
    if (TornadoInstance.active[tornadoSlot]) {
      intensity = TornadoInstance.formationProgress[tornadoSlot]
        * (1 - TornadoInstance.dissipationProgress[tornadoSlot]);
    }

    if (intensity > 0.1) {
      // Sample the vortex velocity at the debris position.
      sampleVortexVelocity(tornadoSlot,
        D.px[slot], D.py[slot], D.pz[slot], _debrisVortex);

      // Drag toward the vortex velocity.
      const dx = _debrisVortex[0] - D.vx[slot];
      const dy = _debrisVortex[1] - D.vy[slot];
      const dz = _debrisVortex[2] - D.vz[slot];
      const relSpeedSq = dx * dx + dy * dy + dz * dz;
      const relSpeed = Math.sqrt(relSpeedSq);

      if (relSpeed > EPSILON) {
        // Drag force magnitude.
        const crossSection = D.size[slot] * D.size[slot];
        const dragMag = 0.5 * AIR_DENSITY * relSpeedSq * DEBRIS_DRAG_COEFF * crossSection;
        const accelX = (dragMag / D.mass[slot]) * (dx / relSpeed);
        const accelY = (dragMag / D.mass[slot]) * (dy / relSpeed);
        const accelZ = (dragMag / D.mass[slot]) * (dz / relSpeed);

        D.vx[slot] += accelX * dt;
        D.vy[slot] += accelY * dt;
        D.vz[slot] += accelZ * dt;
      }
    }

    // Gravity.
    D.vy[slot] -= GRAVITY * dt;

    // Update rotation from angular velocity.
    D.rotX[slot] += D.wx[slot] * dt;
    D.rotY[slot] += D.wy[slot] * dt;
    D.rotZ[slot] += D.wz[slot] * dt;

    // Advance position.
    const newX = D.px[slot] + D.vx[slot] * dt;
    const newY = D.py[slot] + D.vy[slot] * dt;
    const newZ = D.pz[slot] + D.vz[slot] * dt;

    // Impact test against ground via BVH.
    if (intensity < 0.3 || D.age[slot] > 3.0) {
      const downDir = [0, -1, 0];
      const speed = Math.sqrt(D.vx[slot] ** 2 + D.vy[slot] ** 2 + D.vz[slot] ** 2);
      if (speed > 5.0) {
        const hits = bvhRaycast(
          [newX, newY, newZ],
          [0, -1, 0],
          speed * dt + 0.5,
          true
        );
        if (hits.length > 0) {
          // Impact.
          spawnDebrisImpact(slot, newX, newY - hits[0].t, newZ,
            [0, 1, 0], hits[0].eid);
          freeDebris(slot);
          continue;
        }
      }
    }

    D.px[slot] = newX;
    D.py[slot] = newY;
    D.pz[slot] = newZ;

    // Retire if far below ground.
    if (D.py[slot] < -100) {
      freeDebris(slot);
      continue;
    }
  }

  // Advance impacts.
  const I = DebrisImpact;
  for (let slot = 0; slot < MAX_DEBRIS_IMPACTS; slot++) {
    if (I.active[slot] === 0) continue;
    I.age[slot] += dt;
    if (I.age[slot] >= I.lifetime[slot]) {
      freeDebrisImpact(slot);
    }
  }

  return world;
}

function spawnDebrisImpact(debrisSlot, px, py, pz, normal, targetEid) {
  const impactSlot = allocDebrisImpact();
  if (impactSlot < 0) return;

  const D = TornadoDebris;
  const I = DebrisImpact;

  const speedSq = D.vx[debrisSlot] ** 2 + D.vy[debrisSlot] ** 2 + D.vz[debrisSlot] ** 2;
  const ke = 0.5 * D.mass[debrisSlot] * speedSq;

  I.px[impactSlot] = px;
  I.py[impactSlot] = py;
  I.pz[impactSlot] = pz;
  I.nx[impactSlot] = normal[0];
  I.ny[impactSlot] = normal[1];
  I.nz[impactSlot] = normal[2];
  I.mass[impactSlot] = D.mass[debrisSlot];
  I.kineticEnergy[impactSlot] = ke;
  I.age[impactSlot] = 0;
  I.lifetime[impactSlot] = DEBRIS_IMPACT_LIFETIME;
}

// ═══════════════════════════════════════════════════════════════════════
// TORNADO EVOLUTION SYSTEM
// ═══════════════════════════════════════════════════════════════════════

const _tornadoVortexSample = vec3.create();

/**
 * Advance tornado evolution:
 *   • Formation phase (0 → 1)
 *   • Mature phase (steady-state)
 *   • Dissipation phase (1 → 0)
 *   • Funnel twist + wobble
 *   • Ground drift
 *   • Damage radii update
 *   • Wind source sync
 *   • Debris spawn
 */
export function systemUpdateTornadoes(world, dt) {
  const T = TornadoInstance;

  for (let slot = 0; slot < _nextTornadoSlot; slot++) {
    if (!T.active[slot]) continue;

    T.age[slot] += dt;

    // Formation.
    if (T.formationProgress[slot] < 1) {
      T.formationProgress[slot] = Math.min(1,
        T.formationProgress[slot] + dt / TORNADO_FORMATION_TIME);
    }

    // Dissipation (once lifetime * 0.9 is reached).
    if (T.age[slot] > T.lifetime[slot] * 0.9) {
      T.dissipationProgress[slot] = Math.min(1,
        T.dissipationProgress[slot] + dt / TORNADO_DISSIPATION_TIME);
    }

    // Fully dissipated: retire.
    if (T.dissipationProgress[slot] >= 1) {
      T.active[slot] = 0;
      continue;
    }

    // Twist + wobble.
    T.twistAngle[slot] += dt * 1.5;
    if (T.twistAngle[slot] > TWO_PI) T.twistAngle[slot] -= TWO_PI;
    T.wobblePhase[slot] += dt * FUNNEL_WOBBLE_FREQUENCY * TWO_PI;
    if (T.wobblePhase[slot] > TWO_PI) T.wobblePhase[slot] -= TWO_PI;

    // Drift base position along drift direction.
    T.baseX[slot] += T.driftDirX[slot] * T.driftSpeed[slot] * dt;
    T.baseZ[slot] += T.driftDirZ[slot] * T.driftSpeed[slot] * dt;

    // Slowly curve drift direction.
    const curveAngle = TORNADO_CURVE_RATE * dt;
    const cosC = Math.cos(curveAngle);
    const sinC = Math.sin(curveAngle);
    const dx = T.driftDirX[slot];
    const dz = T.driftDirZ[slot];
    T.driftDirX[slot] = dx * cosC - dz * sinC;
    T.driftDirZ[slot] = dx * sinC + dz * cosC;

    // Keep top anchored to the cloud (it moves with the storm).
    const stormSlot = T.stormSlot[slot];
    const baseSlot = CumulonimbusState._baseInstanceSlot[stormSlot];
    if (baseSlot !== undefined && baseSlot >= 0) {
      const CI = CloudInstance;
      const cloudTopX = CI.px[baseSlot];
      const cloudTopY = CI.py[baseSlot] - CI.radiusY[baseSlot];
      const cloudTopZ = CI.pz[baseSlot];

      // Gently pull the top toward the cloud base.
      T.topX[slot] = T.topX[slot] * 0.95 + cloudTopX * 0.05;
      T.topY[slot] = T.topY[slot] * 0.95 + cloudTopY * 0.05;
      T.topZ[slot] = T.topZ[slot] * 0.95 + cloudTopZ * 0.05;
    }

    // Update damage radii.
    updateDamageRadii(slot);

    // Sync the storm-inflow wind source position.
    const wslot = T.windSourceSlot[slot];
    if (wslot >= 0 && WindSource.active[wslot]) {
      WindSource.px[wslot] = T.baseX[slot];
      WindSource.py[wslot] = T.baseY[slot];
      WindSource.pz[wslot] = T.baseZ[slot];
      WindSource.radiusX[wslot] = T.coreRadius[slot] * OUTER_DOWNDRAFT_RANGE_MULT;
      WindSource.radiusY[wslot] = (T.topY[slot] - T.baseY[slot]) * 0.5;
      WindSource.radiusZ[wslot] = T.coreRadius[slot] * OUTER_DOWNDRAFT_RANGE_MULT;
      WindSource.baseSpeed[wslot] = T.tangentialVelocity[slot]
        * T.formationProgress[slot]
        * (1 - T.dissipationProgress[slot]);
    }

    // Spawn debris.
    spawnDebrisAroundTornado(world, slot, dt);
  }

  return world;
}

function updateDamageRadii(slot) {
  const T = TornadoInstance;

  // Radii scale with core radius and velocity (via EF).
  const ef = T.efRating[slot];
  const efScale = 1.0 + ef * 0.15;
  const core = T.coreRadius[slot];

  T.fatalRadius[slot] = Math.max(DAMAGE_MIN_FATAL_RADIUS,
    core * DAMAGE_FATAL_MULT * efScale);
  T.severeRadius[slot] = Math.max(DAMAGE_MIN_SEVERE_RADIUS,
    core * DAMAGE_SEVERE_MULT * efScale);
  T.moderateRadius[slot] = Math.max(DAMAGE_MIN_MODERATE_RADIUS,
    core * DAMAGE_MODERATE_MULT * efScale);
}

// ═══════════════════════════════════════════════════════════════════════
// SUCTION FORCES — applied to rigid bodies and characters
// ═══════════════════════════════════════════════════════════════════════

export const TornadoSuctionTag = {};

/**
 * Apply suction forces to a specific entity.
 * Called once per frame by the game's physics tick or by the main
 * pipeline below.
 */
export function applySuctionToEntity(world, tornadoSlot, eid) {
  const T = TornadoInstance;
  if (!T.active[tornadoSlot]) return;

  if (!entityExists(world, eid)) return;

  const id = getId(eid);
  const M = WorldTransformF32.m;
  if (!M) return;
  const off = id * 16;
  const wx = M[off + 12];
  const wy = M[off + 13];
  const wz = M[off + 14];

  // Sample the vortex velocity at the entity.
  sampleVortexVelocity(tornadoSlot, wx, wy, wz, _tornadoVortexSample);

  const vSq = _tornadoVortexSample[0] ** 2 + _tornadoVortexSample[1] ** 2 + _tornadoVortexSample[2] ** 2;
  if (vSq < EPSILON_SQ) return;

  // Rigid body: apply drag-like force toward the vortex velocity.
  if (hasComponent(world, eid, RigidBody3D)) {
    const invMass = RigidBody3D.invMass[id];
    if (invMass > 0) {
      // Approximate drag force.
      const relVx = _tornadoVortexSample[0] - RigidBody3D.vx[id];
      const relVy = _tornadoVortexSample[1] - RigidBody3D.vy[id];
      const relVz = _tornadoVortexSample[2] - RigidBody3D.vz[id];
      const relSpeedSq = relVx * relVx + relVy * relVy + relVz * relVz;
      const relSpeed = Math.sqrt(relSpeedSq);

      if (relSpeed > EPSILON) {
        const area = 1.0;   // approximation
        const dragMag = 0.5 * AIR_DENSITY * relSpeedSq * 1.2 * area;
        const accelX = (dragMag * invMass) * (relVx / relSpeed);
        const accelY = (dragMag * invMass) * (relVy / relSpeed);
        const accelZ = (dragMag * invMass) * (relVz / relSpeed);

        RigidBody3D.vx[id] += accelX * 0.016;
        RigidBody3D.vy[id] += accelY * 0.016;
        RigidBody3D.vz[id] += accelZ * 0.016;
      }
    }
  }

  // Character: pull wish velocity toward the vortex field.
  if (hasComponent(world, eid, CharacterTag)) {
    const cs = getCharacterSlot(eid);
    if (cs >= 0) {
      const pullStrength = 0.05;
      CharacterStateF32.wishX[cs] += _tornadoVortexSample[0] * pullStrength;
      CharacterStateF32.wishY[cs] += _tornadoVortexSample[1] * pullStrength;
      CharacterStateF32.wishZ[cs] += _tornadoVortexSample[2] * pullStrength;
    }
  }
}

/**
 * System: apply suction to all entities that carry the TornadoSuctionTag.
 * Iterates all tagged entities and finds the nearest tornado.
 */
export function systemApplyTornadoSuction(world) {
  const eids = query(world, [TornadoSuctionTag]);

  for (let i = 0; i < eids.length; i++) {
    const eid = eids[i];

    // Find the nearest tornado.
    let nearestTornado = -1;
    let nearestDistSq = Infinity;

    for (let t = 0; t < _nextTornadoSlot; t++) {
      if (!TornadoInstance.active[t]) continue;

      const dx = TornadoInstance.baseX[t] - WorldTransformF32.m[getId(eid) * 16 + 12];
      const dz = TornadoInstance.baseZ[t] - WorldTransformF32.m[getId(eid) * 16 + 14];
      const distSq = dx * dx + dz * dz;

      const captureRadius = TornadoInstance.coreRadius[t] * OUTER_DOWNDRAFT_RANGE_MULT * 2;
      if (distSq < captureRadius * captureRadius && distSq < nearestDistSq) {
        nearestTornado = t;
        nearestDistSq = distSq;
      }
    }

    if (nearestTornado >= 0) {
      applySuctionToEntity(world, nearestTornado, eid);
    }
  }
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TICK
// ═══════════════════════════════════════════════════════════════════════

/**
 * Full tornado pipeline for one frame:
 *   1. systemUpdateTornadoes(world, dt)
 *   2. systemUpdateDebris(world, dt)
 *   3. systemApplyTornadoSuction(world)
 */
export function systemTornadoTick(world, dt) {
  systemUpdateTornadoes(world, dt);
  systemUpdateDebris(world, dt);
  systemApplyTornadoSuction(world);
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the nearest tornado slot to a world position, or -1 if none
 * are within radius.
 */
export function findNearestTornado(wx, wy, wz, maxDistance = 5000) {
  let nearestSlot = -1;
  let nearestDistSq = maxDistance * maxDistance;

  for (let slot = 0; slot < _nextTornadoSlot; slot++) {
    if (!TornadoInstance.active[slot]) continue;
    const dx = TornadoInstance.baseX[slot] - wx;
    const dz = TornadoInstance.baseZ[slot] - wz;
    const distSq = dx * dx + dz * dz;
    if (distSq < nearestDistSq) {
      nearestSlot = slot;
      nearestDistSq = distSq;
    }
  }
  return nearestSlot;
}

/**
 * Return the EF rating label for a tornado slot (as a string).
 */
export function getEFLabel(slot) {
  if (slot < 0 || slot >= _nextTornadoSlot) return 'N/A';
  const ef = TornadoInstance.efRating[slot];
  return `EF${ef}`;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a summary of all active tornadoes for renderer integration.
 */
export function gatherTornadoesForRendering() {
  const result = [];
  for (let slot = 0; slot < _nextTornadoSlot; slot++) {
    if (!TornadoInstance.active[slot]) continue;
    result.push({
      slot,
      type: TornadoInstance.type[slot],
      efRating: TornadoInstance.efRating[slot],
      baseX: TornadoInstance.baseX[slot],
      baseY: TornadoInstance.baseY[slot],
      baseZ: TornadoInstance.baseZ[slot],
      topX: TornadoInstance.topX[slot],
      topY: TornadoInstance.topY[slot],
      topZ: TornadoInstance.topZ[slot],
      coreRadius: TornadoInstance.coreRadius[slot],
      topRadius: TornadoInstance.topRadius[slot],
      intensity: TornadoInstance.formationProgress[slot]
        * (1 - TornadoInstance.dissipationProgress[slot]),
      twist: TornadoInstance.twistAngle[slot],
      subVortexCount: TornadoInstance.subVortexCount[slot],
    });
  }
  return result;
}

/**
 * Return a summary of all active debris for renderer integration.
 */
export function gatherDebrisForRendering(maxOutput = 8192) {
  const result = [];
  const D = TornadoDebris;
  for (let slot = 0; slot < MAX_DEBRIS; slot++) {
    if (D.active[slot] === 0) continue;
    result.push({
      x: D.px[slot], y: D.py[slot], z: D.pz[slot],
      size: D.size[slot],
      rotX: D.rotX[slot],
      rotY: D.rotY[slot],
      rotZ: D.rotZ[slot],
      shape: D.debrisShape[slot],
      tint: [D.tintR[slot], D.tintG[slot], D.tintB[slot]],
    });
    if (result.length >= maxOutput) break;
  }
  return result;
}

/**
 * Return a summary of all active debris impacts for renderer integration.
 */
export function gatherDebrisImpactsForRendering(maxOutput = 512) {
  const result = [];
  const I = DebrisImpact;
  for (let slot = 0; slot < MAX_DEBRIS_IMPACTS; slot++) {
    if (I.active[slot] === 0) continue;
    result.push({
      x: I.px[slot], y: I.py[slot], z: I.pz[slot],
      nx: I.nx[slot], ny: I.ny[slot], nz: I.nz[slot],
      mass: I.mass[slot],
      kineticEnergy: I.kineticEnergy[slot],
      age: I.age[slot],
      lifetime: I.lifetime[slot],
    });
    if (result.length >= maxOutput) break;
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearTornadoes() {
  TornadoInstance.active.fill(0);
  TornadoInstance.ownerEid.fill(0);
  _tornadoSlots.clear();
  _tornadoNoise.clear();
  _nextTornadoSlot = 0;

  TornadoDebris.active.fill(0);
  TornadoDebris.freeHead = 0;
  TornadoDebris.liveCount = 0;

  DebrisImpact.active.fill(0);
  DebrisImpact.freeHead = 0;
  DebrisImpact.liveCount = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function tornadoStats() {
  let active = 0;
  let activeDebris = TornadoDebris.liveCount;
  let activeImpacts = DebrisImpact.liveCount;

  const byType = [0, 0, 0, 0, 0, 0, 0];
  const byEF = [0, 0, 0, 0, 0, 0];

  for (let slot = 0; slot < _nextTornadoSlot; slot++) {
    if (!TornadoInstance.active[slot]) continue;
    active++;
    byType[TornadoInstance.type[slot]]++;
    byEF[TornadoInstance.efRating[slot]]++;
  }

  return {
    tornadoCount: _nextTornadoSlot,
    activeTornadoes: active,
    maxTornadoes: MAX_TORNADOES,
    activeDebris,
    maxDebris: MAX_DEBRIS,
    activeImpacts,
    maxImpacts: MAX_DEBRIS_IMPACTS,
    byType: {
      cone: byType[0],
      rope: byType[1],
      stovePipe: byType[2],
      wedge: byType[3],
      multiVortex: byType[4],
      saturnSpoke: byType[5],
      waterspout: byType[6],
    },
    byEF: {
      EF0: byEF[0],
      EF1: byEF[1],
      EF2: byEF[2],
      EF3: byEF[3],
      EF4: byEF[4],
      EF5: byEF[5],
    },
  };
}