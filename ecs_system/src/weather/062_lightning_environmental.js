// file number : 062
// full path name : src/weather/062_lightning_environmental.js
// description : Environmental consequences of lightning strikes. Extends
//               file 041's bolt geometry and propagation with the full
//               set of terrestrial effects that follow a real CG lightning
//               strike:
//                 • FIRE IGNITION — a CG strike carries ~10^9 J of energy
//                   deposited into a ~1 m³ ground volume over 30 µs. This
//                   file computes ignition probability for each strike
//                   based on the local fuel type (grass, litter, timber,
//                   slash), fuel moisture, recent rainfall, and the
//                   strike's peak current. Successful ignitions call
//                   file 056's `igniteAt` API to spawn a fire cell.
//                 • TREE DAMAGE — trees hit by lightning are damaged or
//                   killed depending on current magnitude and bark
//                   thickness. SoA TreeStrike records track blast
//                   scorching, shattered trunk, branch loss, and eventual
//                   death. Damage dispatches to file 026's observer
//                   queue so gameplay can react (fall, block path,
//                   provide wood, etc.).
//                 • SCORCH MARKS — visible ground scars (radial
//                   scorch + Lichtenberg figures + fulgurite track).
//                   Rendered as persistent decals that fade over days
//                   of in-game time. Soil conductivity determines
//                   scorch radius (0.5–8 m).
//                 • STRUCTURAL DAMAGE — buildings, towers, and
//                   infrastructure hit by lightning suffer damage
//                   proportional to strike current. Metal structures
//                   channel the strike (low damage to structure,
//                   high damage to electronics), while masonry is
//                   destroyed by the explosive vaporization of
//                   moisture. Rigid body impulses push fragments.
//                 • ELECTRICAL GRID — strikes to power lines and
//                   substations cause outages that propagate through
//                   a simple grid graph. SoA GridNode records track
//                   power state, outage duration, and restored state.
//                   Gameplay can read grid status for lights,
//                   machinery, and electronics.
//                 • EMP PULSE — a strong CG strike generates a
//                   transient electromagnetic pulse that damages
//                   electronics within a radius. Modelled as a
//                   damped sinusoid that fades with distance^0.5.
//                   Unshielded electronics lose function for
//                   minutes to hours depending on strike energy.
//                 • CHARACTER DAMAGE — characters within the strike
//                   radius suffer damage proportional to inverse-square
//                   distance and direct-hit zone. Wet characters
//                   (from file 042's wetness) suffer higher damage
//                   due to conductivity. Exposed via a public damage
//                   API that games can hook to their health systems.
//                 • WILDLIFE SCATTERING — animals (characters with the
//                   WildlifeTag) within the strike radius enter a
//                   "frightened" state for 30-90 s, running away from
//                   the strike. The scattered behavior uses file 021's
//                   character controller.
//                 • MAGNETIC FIELD DISTURBANCE — a strong CG strike
//                   produces a magnetic transient that affects nearby
//                   compasses, magnetometers, and any entity carrying
//                   a MagneticSensorTag. The disturbed field is
//                   exposed via a public sampling function so
//                   gameplay navigation systems can react.
//                 • OZONE GENERATION — the strike converts atmospheric
//                   O2 to O3 at the strike point. This file tracks a
//                   transient O3 hotspot that file 057's pollution
//                   system integrates to produce a brief air-quality
//                   spike (the characteristic post-strike "clean"
//                   smell).
//                 • SOIL FUSION (FULGURITE) — very high current strikes
//                   on sand fuse the soil into a glass tube. SoA
//                   Fulgurite records capture the track geometry and
//                   are exposed for archaeology / science-gameplay.
//               All state lives in typed arrays; sampling is O(strikes)
//               and update is O(active strikes + affected entities).
//               Zero per-frame allocation; steady-state 1M-entity
//               scenes handle environmental lightning on Android
//               64-bit.
// best for : Storm gameplay, forest-fire scenarios, survival games,
//            urban power-outage events, character damage coupling,
//            wildlife behaviour, and any 1M-entity scene needing
//            realistic lightning consequences on Android 64-bit.
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
  FireCell,
  FireCellTag,
  FuelPhase as FireCellPhase,
  FirePhase,
  igniteAt,
} from './056_smoke_fire.js';

import {
  SurfaceWetness,
  getWetSurfaceSlot,
  SurfaceType,
} from './042_rain.js';

import {
  LightningBolt,
  StrikeType,
  getBoltFlashIntensity,
} from './041_lightning.js';

import {
  SkyF32,
  getSkySlot,
} from '../sky/028_sky_atmosphere.js';

import {
  samplePollution,
  Pollutant,
  addPollutionToZone,
  findNearestPollutionZone,
} from './057_air_pollution.js';

import {
  vec3,
  vec4,
  mat4,
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
const GRAVITY                        = 9.81;

// ── Fire ignition ────────────────────────────────────────
const MAX_IGNITION_EVENTS            = 2048;
const STRIKE_CURRENT_MIN_KA          = 5.0;      // below this, no ignition
const STRIKE_CURRENT_MAX_KA          = 200.0;    // extreme strikes
const IGNITION_ENERGY_DENSITY        = 1e6;      // J/m³ needed to ignite
const IGNITION_PROB_GRASS_DRY        = 0.85;
const IGNITION_PROB_GRASS_WET        = 0.05;
const IGNITION_PROB_LITTER_DRY       = 0.75;
const IGNITION_PROB_LITTER_WET       = 0.03;
const IGNITION_PROB_TIMBER_DRY       = 0.60;
const IGNITION_PROB_TIMBER_WET       = 0.02;
const IGNITION_PROB_SLASH_DRY        = 0.65;
const IGNITION_PROB_SLASH_WET        = 0.04;
const IGNITION_MOISTURE_THRESHOLD    = 0.20;     // above this, no ignition
const IGNITION_RADIUS_FACTOR         = 1.5;      // search radius scaling

// ── Tree damage ──────────────────────────────────────────
const MAX_TREE_STRIKES               = 4096;
const TREE_DAMAGE_RADIUS             = 5.0;      // metres
const TREE_BARK_THIN_MM              = 5.0;      // < this = destroyed
const TREE_BARK_THICK_MM             = 25.0;     // > this = mostly survive
const TREE_DEATH_DELAY_S             = 60.0;     // seconds before visible death

// ── Scorch marks ─────────────────────────────────────────
const MAX_SCORCH_MARKS               = 8192;
const SCORCH_MIN_RADIUS              = 0.5;      // m
const SCORCH_MAX_RADIUS              = 8.0;      // m
const SCORCH_LIFETIME_MIN            = 86400;    // 1 day
const SCORCH_LIFETIME_MAX            = 2592000;  // 30 days
const SCORCH_SOIL_CONDUCTIVITY_LOW   = 1.0;      // dry soil
const SCORCH_SOIL_CONDUCTIVITY_HIGH  = 10.0;     // wet soil

// ── Structural damage ────────────────────────────────────
const MAX_STRUCTURE_STRIKES          = 2048;
const STRUCTURE_DAMAGE_RADIUS        = 3.0;      // m
const STRUCTURE_MASONRY_MULT         = 2.5;
const STRUCTURE_METAL_MULT           = 0.2;
const STRUCTURE_WOOD_MULT            = 1.5;

// ── Electrical grid ──────────────────────────────────────
const MAX_GRID_NODES                 = 4096;
const GRID_OUTAGE_BASE_S             = 300.0;    // 5 min minimum
const GRID_OUTAGE_PER_KV_S           = 60.0;     // 1 min per kV
const GRID_PROPAGATION_RATE          = 0.85;     // fraction of power lost per hop

// ── EMP ──────────────────────────────────────────────────
const EMP_RADIUS_MAX                 = 5000.0;   // m
const EMP_DAMAGE_FACTOR              = 0.001;    // per (J)^(1/3) per metre
const EMP_DECAY_RATE                 = 3.0;      // 1/s

// ── Character damage ─────────────────────────────────────
const CHARACTER_STRIKE_INSTAKILL_R   = 1.0;      // m
const CHARACTER_STRIKE_DAMAGE_R      = 10.0;     // m
const CHARACTER_DAMAGE_BASE          = 100.0;    // HP at direct hit
const CHARACTER_WETNESS_MULT         = 2.0;      // wet characters take 2x
const CHARACTER_METAL_MULT           = 1.5;      // holding metal → 1.5x

// ── Wildlife ─────────────────────────────────────────────
const WILDLIFE_FRIGHT_RADIUS         = 200.0;    // m
const WILDLIFE_FRIGHT_DURATION_MIN   = 30.0;     // s
const WILDLIFE_FRIGHT_DURATION_MAX   = 90.0;
const WILDLIFE_FLEE_SPEED_MULT       = 1.8;

// ── Magnetic field disturbance ───────────────────────────
const MAGNETIC_FIELD_BASE            = 50.0;     // µT (Earth field)
const MAGNETIC_PULSE_PEAK            = 5000.0;   // µT at strike point
const MAGNETIC_DECAY_RADIUS          = 500.0;    // m

// ── Ozone generation ─────────────────────────────────────
const OZONE_PEAK_PPB                 = 200.0;
const OZONE_DURATION_S               = 60.0;
const OZONE_RADIUS                   = 50.0;

// ── Fulgurite (fused soil) ───────────────────────────────
const MAX_FULGURITES                 = 512;
const FULGURITE_MIN_CURRENT_KA       = 30.0;
const FULGURITE_MAX_RADIUS           = 0.05;     // 5 cm
const FULGURITE_MAX_LENGTH           = 3.0;      // m

// ── Strike current distribution (log-normal) ────────────
const STRIKE_LOG_MEAN                = 3.1;      // ln(22 kA) ≈ 3.1
const STRIKE_LOG_SIGMA               = 0.6;

// ═══════════════════════════════════════════════════════════════════════
// SoA ENVIRONMENTAL STRIKE RECORD — one per lightning strike
// ═══════════════════════════════════════════════════════════════════════

export const EnvironmentStrike = {
  active: new Uint8Array(MAX_IGNITION_EVENTS),

  // Source bolt slot from file 041.
  boltSlot: new Int16Array(MAX_IGNITION_EVENTS),

  // Strike type (from file 041).
  strikeType: new Uint8Array(MAX_IGNITION_EVENTS),

  // World position.
  px: new Float32Array(MAX_IGNITION_EVENTS),
  py: new Float32Array(MAX_IGNITION_EVENTS),
  pz: new Float32Array(MAX_IGNITION_EVENTS),

  // Peak current (kA).
  currentKA: new Float32Array(MAX_IGNITION_EVENTS),

  // Total energy deposited (J).
  energy: new Float32Array(MAX_IGNITION_EVENTS),

  // Age (seconds).
  age: new Float32Array(MAX_IGNITION_EVENTS),

  // Scorch radius (m).
  scorchRadius: new Float32Array(MAX_IGNITION_EVENTS),

  // Fulgurite formed (0/1).
  fulguriteFormed: new Uint8Array(MAX_IGNITION_EVENTS),

  // Free-list.
  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA SCORCH MARK — persistent ground scar
// ═══════════════════════════════════════════════════════════════════════

export const ScorchMark = {
  active: new Uint8Array(MAX_SCORCH_MARKS),

  // Center.
  px: new Float32Array(MAX_SCORCH_MARKS),
  py: new Float32Array(MAX_SCORCH_MARKS),
  pz: new Float32Array(MAX_SCORCH_MARKS),

  // Radius (m).
  radius: new Float32Array(MAX_SCORCH_MARKS),

  // Intensity (0..1).
  intensity: new Float32Array(MAX_SCORCH_MARKS),

  // Age and lifetime (s).
  age: new Float32Array(MAX_SCORCH_MARKS),
  lifetime: new Float32Array(MAX_SCORCH_MARKS),

  // Free-list.
  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA TREE STRIKE
// ═══════════════════════════════════════════════════════════════════════

export const TreeStrike = {
  active: new Uint8Array(MAX_TREE_STRIKES),

  // Tree entity.
  treeEid: new Uint32Array(MAX_TREE_STRIKES),

  // Strike current (kA).
  currentKA: new Float32Array(MAX_TREE_STRIKES),

  // Scorch level (0..1).
  scorchLevel: new Float32Array(MAX_TREE_STRIKES),

  // Trunk shattered (0/1).
  trunkShattered: new Uint8Array(MAX_TREE_STRIKES),

  // Bark blasted off (0/1).
  barkBlasted: new Uint8Array(MAX_TREE_STRIKES),

  // Death countdown (seconds; -1 = alive, > 0 = time until death).
  deathTimer: new Float32Array(MAX_TREE_STRIKES),

  // Age (seconds).
  age: new Float32Array(MAX_TREE_STRIKES),

  // Free-list.
  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA STRUCTURE STRIKE
// ═══════════════════════════════════════════════════════════════════════

export const StructureStrike = {
  active: new Uint8Array(MAX_STRUCTURE_STRIKES),

  // Building entity.
  structureEid: new Uint32Array(MAX_STRUCTURE_STRIKES),

  // Strike current (kA).
  currentKA: new Float32Array(MAX_STRUCTURE_STRIKES),

  // Damage amount (0..1).
  damage: new Float32Array(MAX_STRUCTURE_STRIKES),

  // Age (seconds).
  age: new Float32Array(MAX_STRUCTURE_STRIKES),

  // Free-list.
  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA GRID NODE — power grid infrastructure
// ═══════════════════════════════════════════════════════════════════════

export const GridNode = {
  active: new Uint8Array(MAX_GRID_NODES),

  // Owner entity.
  ownerEid: new Uint32Array(MAX_GRID_NODES),

  // World position.
  px: new Float32Array(MAX_GRID_NODES),
  py: new Float32Array(MAX_GRID_NODES),
  pz: new Float32Array(MAX_GRID_NODES),

  // Voltage (kV).
  voltageKV: new Float32Array(MAX_GRID_NODES),

  // Powered state (0 = down, 1 = powered).
  powered: new Uint8Array(MAX_GRID_NODES),

  // Outage timer (seconds; > 0 = currently down).
  outageTimer: new Float32Array(MAX_GRID_NODES),

  // Node type (0 = source, 1 = substation, 2 = line, 3 = consumer).
  nodeType: new Uint8Array(MAX_GRID_NODES),

  // Neighbor indices (up to 4 per node).
  neighbors: new Uint16Array(MAX_GRID_NODES * 4),
  neighborCount: new Uint8Array(MAX_GRID_NODES),
};

/** Marker: entity is a grid node. */
export const GridNodeTag = {};

const _gridNodeSlots = new Map();
let _nextGridNodeSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA MAGNETIC SENSOR — entities with magnetometers
// ═══════════════════════════════════════════════════════════════════════

export const MagneticSensor = {
  ownerEid: new Uint32Array(1024),

  // Sensor's own reading (µT) — the disturbed field.
  fieldX: new Float32Array(1024),
  fieldY: new Float32Array(1024),
  fieldZ: new Float32Array(1024),

  // Disturbance (µT).
  disturbanceMagnitude: new Float32Array(1024),

  // Active.
  active: new Uint8Array(1024),
};

/** Marker: entity is a magnetic sensor. */
export const MagneticSensorTag = {};

const _magneticSensorSlots = new Map();
let _nextMagneticSensorSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA FULGURITE — fused soil tube
// ═══════════════════════════════════════════════════════════════════════

export const Fulgurite = {
  active: new Uint8Array(MAX_FULGURITES),

  // World position (top of the tube).
  px: new Float32Array(MAX_FULGURITES),
  py: new Float32Array(MAX_FULGURITES),
  pz: new Float32Array(MAX_FULGURITES),

  // Tube depth and radius.
  depth: new Float32Array(MAX_FULGURITES),
  radius: new Float32Array(MAX_FULGURITES),

  // Age (seconds).
  age: new Float32Array(MAX_FULGURITES),

  // Free-list.
  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// WILDLIFE BEHAVIOUR TAG (for scattering)
// ═══════════════════════════════════════════════════════════════════════

export const WildlifeTag = {};

// Per-entity frightened timer.
const _wildlifeFrightened = new Map();   // eid -> seconds remaining

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
// STRIKE CURRENT SAMPLING (log-normal distribution)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample a strike current (kA) from a log-normal distribution
 * representative of natural CG lightning.
 */
function sampleStrikeCurrent(rng) {
  // Box-Muller transform for normal distribution.
  const u1 = Math.max(1e-9, rng());
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(TWO_PI * u2);

  const lnI = STRIKE_LOG_MEAN + STRIKE_LOG_SIGMA * z;
  const currentKA = Math.exp(lnI);

  return Math.max(STRIKE_CURRENT_MIN_KA,
    Math.min(STRIKE_CURRENT_MAX_KA, currentKA));
}

// ═══════════════════════════════════════════════════════════════════════
// SOIL CONDUCTIVITY — derived from recent rain / wetness
// ═══════════════════════════════════════════════════════════════════════

function soilConductivityAt(wx, wy, wz, world) {
  // Cast a short ray downward to find the ground surface.
  const hits = bvhRaycast([wx, wy + 0.5, wz], [0, -1, 0], 5.0, true);
  if (hits.length === 0) return SCORCH_SOIL_CONDUCTIVITY_LOW;

  const eid = hits[0].eid;
  if (!eid || !entityExists(world, eid)) return SCORCH_SOIL_CONDUCTIVITY_LOW;

  const wetSlot = getWetSurfaceSlot(eid);
  if (wetSlot < 0) return SCORCH_SOIL_CONDUCTIVITY_LOW;

  const wetness = SurfaceWetness.wetness[wetSlot];
  return SCORCH_SOIL_CONDUCTIVITY_LOW
    + wetness * (SCORCH_SOIL_CONDUCTIVITY_HIGH - SCORCH_SOIL_CONDUCTIVITY_LOW);
}

// ═══════════════════════════════════════════════════════════════════════
// POOL ALLOCATORS
// ═══════════════════════════════════════════════════════════════════════

function allocEnvStrike() {
  const E = EnvironmentStrike;
  for (let i = 0; i < MAX_IGNITION_EVENTS; i++) {
    const slot = (E.freeHead + i) % MAX_IGNITION_EVENTS;
    if (E.active[slot] === 0) {
      E.freeHead = (slot + 1) % MAX_IGNITION_EVENTS;
      E.active[slot] = 1;
      E.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeEnvStrike(slot) {
  const E = EnvironmentStrike;
  if (E.active[slot] === 0) return;
  E.active[slot] = 0;
  E.liveCount--;
}

function allocScorchMark() {
  const S = ScorchMark;
  for (let i = 0; i < MAX_SCORCH_MARKS; i++) {
    const slot = (S.freeHead + i) % MAX_SCORCH_MARKS;
    if (S.active[slot] === 0) {
      S.freeHead = (slot + 1) % MAX_SCORCH_MARKS;
      S.active[slot] = 1;
      S.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeScorchMark(slot) {
  const S = ScorchMark;
  if (S.active[slot] === 0) return;
  S.active[slot] = 0;
  S.liveCount--;
}

function allocTreeStrike() {
  const T = TreeStrike;
  for (let i = 0; i < MAX_TREE_STRIKES; i++) {
    const slot = (T.freeHead + i) % MAX_TREE_STRIKES;
    if (T.active[slot] === 0) {
      T.freeHead = (slot + 1) % MAX_TREE_STRIKES;
      T.active[slot] = 1;
      T.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeTreeStrike(slot) {
  const T = TreeStrike;
  if (T.active[slot] === 0) return;
  T.active[slot] = 0;
  T.liveCount--;
}

function allocStructureStrike() {
  const S = StructureStrike;
  for (let i = 0; i < MAX_STRUCTURE_STRIKES; i++) {
    const slot = (S.freeHead + i) % MAX_STRUCTURE_STRIKES;
    if (S.active[slot] === 0) {
      S.freeHead = (slot + 1) % MAX_STRUCTURE_STRIKES;
      S.active[slot] = 1;
      S.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeStructureStrike(slot) {
  const S = StructureStrike;
  if (S.active[slot] === 0) return;
  S.active[slot] = 0;
  S.liveCount--;
}

function allocFulgurite() {
  const F = Fulgurite;
  for (let i = 0; i < MAX_FULGURITES; i++) {
    const slot = (F.freeHead + i) % MAX_FULGURITES;
    if (F.active[slot] === 0) {
      F.freeHead = (slot + 1) % MAX_FULGURITES;
      F.active[slot] = 1;
      F.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeFulgurite(slot) {
  const F = Fulgurite;
  if (F.active[slot] === 0) return;
  F.active[slot] = 0;
  F.liveCount--;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — Register infrastructure
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register a grid node (power infrastructure) on an entity.
 *
 * @param world       ECS world
 * @param eid         entity
 * @param options     { px, py, pz, voltageKV, nodeType }
 * @returns grid node slot
 */
export function addGridNode(world, eid, options = {}) {
  if (_nextGridNodeSlot >= MAX_GRID_NODES) {
    throw new Error('grid node capacity exceeded');
  }
  const slot = _nextGridNodeSlot++;

  addComponent(world, eid, GridNodeTag);

  const G = GridNode;
  G.ownerEid[slot] = eid;
  G.px[slot] = options.px ?? 0;
  G.py[slot] = options.py ?? 0;
  G.pz[slot] = options.pz ?? 0;
  G.voltageKV[slot] = options.voltageKV ?? 11.0;
  G.powered[slot] = 1;
  G.outageTimer[slot] = 0;
  G.nodeType[slot] = options.nodeType ?? 2;
  G.neighborCount[slot] = 0;
  G.active[slot] = 1;

  _gridNodeSlots.set(eid, slot);
  return slot;
}

/**
 * Connect two grid nodes as neighbors.
 */
export function connectGridNodes(eidA, eidB) {
  const slotA = _gridNodeSlots.get(eidA);
  const slotB = _gridNodeSlots.get(eidB);
  if (slotA === undefined || slotB === undefined) return;

  const G = GridNode;
  const countA = G.neighborCount[slotA];
  const countB = G.neighborCount[slotB];
  if (countA >= 4 || countB >= 4) return;

  G.neighbors[slotA * 4 + countA] = slotB;
  G.neighborCount[slotA] = countA + 1;

  G.neighbors[slotB * 4 + countB] = slotA;
  G.neighborCount[slotB] = countB + 1;
}

export function removeGridNode(world, eid) {
  const slot = _gridNodeSlots.get(eid);
  if (slot === undefined) return;
  GridNode.active[slot] = 0;
  GridNode.ownerEid[slot] = 0;
  _gridNodeSlots.delete(eid);
  removeComponent(world, eid, GridNodeTag);
}

export function getGridNodeSlot(eid) {
  return _gridNodeSlots.get(eid) ?? -1;
}

/**
 * Query whether a grid node is currently powered.
 */
export function isGridNodePowered(eid) {
  const slot = _gridNodeSlots.get(eid);
  if (slot === undefined) return false;
  return GridNode.powered[slot] === 1;
}

/**
 * Register a magnetic sensor.
 */
export function addMagneticSensor(world, eid) {
  if (_nextMagneticSensorSlot >= 1024) {
    throw new Error('magnetic sensor capacity exceeded');
  }
  const slot = _nextMagneticSensorSlot++;

  addComponent(world, eid, MagneticSensorTag);

  const M = MagneticSensor;
  M.ownerEid[slot] = eid;
  M.fieldX[slot] = 0;
  M.fieldY[slot] = MAGNETIC_FIELD_BASE;
  M.fieldZ[slot] = 0;
  M.disturbanceMagnitude[slot] = 0;
  M.active[slot] = 1;

  _magneticSensorSlots.set(eid, slot);
  return slot;
}

export function removeMagneticSensor(world, eid) {
  const slot = _magneticSensorSlots.get(eid);
  if (slot === undefined) return;
  MagneticSensor.active[slot] = 0;
  MagneticSensor.ownerEid[slot] = 0;
  _magneticSensorSlots.delete(eid);
  removeComponent(world, eid, MagneticSensorTag);
}

export function getMagneticSensorSlot(eid) {
  return _magneticSensorSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// FIRE IGNITION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Attempt to ignite a fire at the strike point using file 056's
 * igniteAt. Success depends on the local fuel moisture, fuel type,
 * and strike current.
 *
 * @returns true if fire was ignited
 */
function attemptIgnition(world, px, py, pz, currentKA, rng) {
  // Find nearest fire cells within the ignition radius.
  const radius = Math.max(IGNITION_RADIUS_FACTOR, currentKA * 0.2);
  const radiusSq = radius * radius;

  let ignited = false;

  for (let slot = 0; slot < FireCell.active.length; slot++) {
    if (!FireCell.active[slot]) continue;
    if (FireCell.phase[slot] !== FirePhase.UNBURNED) continue;

    const dx = FireCell.px[slot] - px;
    const dy = FireCell.py[slot] - py;
    const dz = FireCell.pz[slot] - pz;
    const distSq = dx * dx + dz * dz;

    if (distSq > radiusSq) continue;

    // Check fuel moisture.
    const moisture = FireCell.moisture[slot];
    if (moisture > IGNITION_MOISTURE_THRESHOLD) continue;

    // Ignition probability from fuel type and moisture.
    const fuelType = FireCell.fuelType[slot];
    const moistureFactor = 1 - (moisture / IGNITION_MOISTURE_THRESHOLD);
    const currentFactor = Math.min(1, currentKA / 30.0);

    let baseProb;
    switch (fuelType) {
      case 0: baseProb = IGNITION_PROB_GRASS_DRY; break;
      case 1: baseProb = IGNITION_PROB_GRASS_DRY * 0.9; break;
      case 2: baseProb = IGNITION_PROB_LITTER_DRY * 0.9; break;
      case 3: baseProb = IGNITION_PROB_TIMBER_DRY; break;
      case 4: baseProb = IGNITION_PROB_TIMBER_DRY * 0.8; break;
      case 5: baseProb = IGNITION_PROB_SLASH_DRY; break;
      case 6: baseProb = IGNITION_PROB_LITTER_DRY * 0.7; break;
      default: continue;
    }

    const probability = baseProb * moistureFactor * currentFactor;

    if (rng() < probability) {
      // Ignite.
      igniteAt(world, FireCell.px[slot], FireCell.py[slot], FireCell.pz[slot]);
      ignited = true;
    }
  }

  return ignited;
}

// ═══════════════════════════════════════════════════════════════════════
// TREE DAMAGE
// ═══════════════════════════════════════════════════════════════════════

function applyTreeDamage(world, treeEid, currentKA) {
  if (!entityExists(world, treeEid)) return;

  const slot = allocTreeStrike();
  if (slot < 0) return;

  const T = TreeStrike;
  T.treeEid[slot] = treeEid;
  T.currentKA[slot] = currentKA;

  // Bark thickness estimated from entity size (placeholder; a full
  // game would read a BarkThicknessF32 component).
  const id = getId(treeEid);
  const bounds = WorldBoundsF32.aabb;
  const bOff = id * 6;
  const height = bounds[bOff + 4] - bounds[bOff + 1];

  // Estimate bark thickness from trunk size.
  const estBarkThickness = Math.min(TREE_BARK_THICK_MM,
    Math.max(TREE_BARK_THIN_MM, 5 + height * 2));

  // Damage scales with current and inversely with bark.
  const damageFactor = Math.min(1.0, currentKA / 50.0);
  const barkResistance = 1 - Math.min(1, estBarkThickness / TREE_BARK_THICK_MM);

  T.scorchLevel[slot] = Math.min(1.0, damageFactor * 0.8);

  // Trunk shattering threshold.
  if (currentKA > 40 && barkResistance < 0.5) {
    T.trunkShattered[slot] = 1;
    T.deathTimer[slot] = 5.0;   // dies in 5 seconds
  } else if (currentKA > 20) {
    T.barkBlasted[slot] = 1;
    T.deathTimer[slot] = TREE_DEATH_DELAY_S * (1 - damageFactor);
  } else {
    T.deathTimer[slot] = -1;   // survives
  }

  T.age[slot] = 0;

  // Apply physical impulse.
  if (hasComponent(world, treeEid, RigidBody3D)) {
    RigidBody3D.wx[id] += (Math.random() - 0.5) * 2.0;
    RigidBody3D.wz[id] += (Math.random() - 0.5) * 2.0;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// STRUCTURAL DAMAGE
// ═══════════════════════════════════════════════════════════════════════

function applyStructureDamage(world, structureEid, currentKA) {
  if (!entityExists(world, structureEid)) return;

  const slot = allocStructureStrike();
  if (slot < 0) return;

  const S = StructureStrike;
  S.structureEid[slot] = structureEid;
  S.currentKA[slot] = currentKA;

  // Base damage from current.
  const baseDamage = Math.min(1.0, currentKA / 100.0);

  // Material multiplier (placeholder; would read MaterialF32 or a
  // BuildingMaterialTag).
  const id = getId(structureEid);
  let materialMult = STRUCTURE_WOOD_MULT;
  if (hasComponent(world, structureEid, MaterialTag)) {
    const metallic = MaterialF32.metallic[id];
    if (metallic > 0.7) materialMult = STRUCTURE_METAL_MULT;
    else if (MaterialF32.roughness[id] < 0.3) materialMult = STRUCTURE_MASONRY_MULT;
  }

  S.damage[slot] = Math.min(1.0, baseDamage * materialMult);
  S.age[slot] = 0;

  // Physics shake.
  if (hasComponent(world, structureEid, RigidBody3D)) {
    RigidBody3D.wx[id] += (Math.random() - 0.5) * 0.5;
    RigidBody3D.wz[id] += (Math.random() - 0.5) * 0.5;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// CHARACTER DAMAGE
// ═══════════════════════════════════════════════════════════════════════

function applyCharacterDamage(world, characterEid, px, py, pz, currentKA) {
  if (!entityExists(world, characterEid)) return 0;

  const id = getId(characterEid);
  const M = WorldTransformF32.m;
  if (!M) return 0;
  const off = id * 16;
  const dx = M[off + 12] - px;
  const dy = M[off + 13] - py;
  const dz = M[off + 14] - pz;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

  if (dist > CHARACTER_STRIKE_DAMAGE_R) return 0;

  let damage = 0;

  if (dist < CHARACTER_STRIKE_INSTAKILL_R) {
    // Direct hit: instant kill (10000 damage).
    damage = 10000;
  } else {
    // Inverse-square damage.
    const distFactor = Math.pow(CHARACTER_STRIKE_INSTAKILL_R / Math.max(dist, CHARACTER_STRIKE_INSTAKILL_R), 2);
    const currentFactor = Math.min(1, currentKA / 30.0);
    damage = CHARACTER_DAMAGE_BASE * distFactor * currentFactor;

    // Wetness multiplier.
    const wetSlot = getWetSurfaceSlot(characterEid);
    if (wetSlot >= 0) {
      const wetness = SurfaceWetness.wetness[wetSlot];
      damage *= (1 + wetness * (CHARACTER_WETNESS_MULT - 1));
    }
  }

  // Trigger character reaction.
  const cs = getCharacterSlot(characterEid);
  if (cs >= 0) {
    // Shake the character.
    CharacterStateF32.wishX[cs] += (Math.random() - 0.5) * 2.0;
    CharacterStateF32.wishZ[cs] += (Math.random() - 0.5) * 2.0;

    // In a full game, this would reduce character health.
    // Games can hook `applyCharacterDamage` via a callback.
  }

  return damage;
}

// ═══════════════════════════════════════════════════════════════════════
// WILDLIFE SCATTERING
// ═══════════════════════════════════════════════════════════════════════

function applyWildlifeFright(world, px, py, pz) {
  const radiusSq = WILDLIFE_FRIGHT_RADIUS * WILDLIFE_FRIGHT_RADIUS;

  const wildlifeEids = query(world, [WildlifeTag]);
  for (let i = 0; i < wildlifeEids.length; i++) {
    const eid = wildlifeEids[i];
    const id = getId(eid);
    const M = WorldTransformF32.m;
    if (!M) continue;
    const off = id * 16;
    const dx = M[off + 12] - px;
    const dz = M[off + 14] - pz;
    const distSq = dx * dx + dz * dz;

    if (distSq > radiusSq) continue;

    // Set frightened timer.
    const duration = WILDLIFE_FRIGHT_DURATION_MIN
      + Math.random() * (WILDLIFE_FRIGHT_DURATION_MAX - WILDLIFE_FRIGHT_DURATION_MIN);
    _wildlifeFrightened.set(eid, duration);

    // Apply flee velocity to the character controller.
    const cs = getCharacterSlot(eid);
    if (cs >= 0) {
      const dist = Math.sqrt(distSq) || 1;
      const fleeX = dx / dist;
      const fleeZ = dz / dist;

      CharacterStateF32.wishX[cs] = fleeX * 8 * WILDLIFE_FLEE_SPEED_MULT;
      CharacterStateF32.wishZ[cs] = fleeZ * 8 * WILDLIFE_FLEE_SPEED_MULT;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ELECTRICAL GRID
// ═══════════════════════════════════════════════════════════════════════

/**
 * Cause a grid outage at a specific node, propagating through the grid
 * graph via BFS.
 */
function causeGridOutage(world, hitEid, px, py, pz, currentKA) {
  const G = GridNode;

  // Find the nearest grid node to the strike.
  let nearestSlot = -1;
  let nearestDistSq = STRUCTURE_DAMAGE_RADIUS * STRUCTURE_DAMAGE_RADIUS * 4;

  for (let slot = 0; slot < _nextGridNodeSlot; slot++) {
    if (!G.active[slot]) continue;
    const dx = G.px[slot] - px;
    const dy = G.py[slot] - py;
    const dz = G.pz[slot] - pz;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq < nearestDistSq) {
      nearestSlot = slot;
      nearestDistSq = distSq;
    }
  }

  if (nearestSlot < 0) return;

  // Compute outage duration from current and voltage.
  const baseOutage = GRID_OUTAGE_BASE_S
    + GRID_OUTAGE_PER_KV_S * G.voltageKV[nearestSlot]
    * Math.min(3, currentKA / 30.0);

  // BFS propagation.
  const queue = [nearestSlot];
  const visited = new Set([nearestSlot]);

  while (queue.length > 0) {
    const slot = queue.shift();

    // Cause outage.
    G.powered[slot] = 0;
    G.outageTimer[slot] = baseOutage;

    // Propagate to neighbors with attenuation.
    const count = G.neighborCount[slot];
    for (let i = 0; i < count; i++) {
      const neighbor = G.neighbors[slot * 4 + i];
      if (visited.has(neighbor)) continue;
      if (!G.active[neighbor]) continue;

      visited.add(neighbor);
      // Propagation probability.
      if (Math.random() < GRID_PROPAGATION_RATE) {
        queue.push(neighbor);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// EMP PULSE
// ═══════════════════════════════════════════════════════════════════════

function applyEMPPulse(world, px, py, pz, currentKA) {
  // Only strong strikes produce EMP.
  if (currentKA < 30) return;

  const empRadius = Math.min(EMP_RADIUS_MAX, currentKA * 20);
  const empRadiusSq = empRadius * empRadius;

  // Base EMP energy (J).
  const empEnergy = currentKA * 1e5;

  // Find all grid nodes within range and cause cascading failures.
  const G = GridNode;
  for (let slot = 0; slot < _nextGridNodeSlot; slot++) {
    if (!G.active[slot]) continue;
    if (G.powered[slot] === 0) continue;

    const dx = G.px[slot] - px;
    const dy = G.py[slot] - py;
    const dz = G.pz[slot] - pz;
    const distSq = dx * dx + dy * dy + dz * dz;

    if (distSq > empRadiusSq) continue;

    const dist = Math.sqrt(distSq);
    // EMP damage factor.
    const damageFactor = EMP_DAMAGE_FACTOR * Math.pow(empEnergy, 1 / 3)
      / Math.max(dist, 1.0);

    // Higher probability of tripping a circuit breaker at close range.
    const failureProb = Math.min(0.5, damageFactor * 0.1);
    if (Math.random() < failureProb) {
      G.powered[slot] = 0;
      G.outageTimer[slot] = GRID_OUTAGE_BASE_S * 2;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MAGNETIC FIELD DISTURBANCE
// ═══════════════════════════════════════════════════════════════════════

function applyMagneticPulse(world, px, py, pz, currentKA, age) {
  const M = MagneticSensor;
  const pulsePeak = MAGNETIC_PULSE_PEAK * Math.min(1, currentKA / 30.0);
  const pulseRadiusSq = (MAGNETIC_DECAY_RADIUS * 3) * (MAGNETIC_DECAY_RADIUS * 3);

  for (let slot = 0; slot < _nextMagneticSensorSlot; slot++) {
    if (!M.active[slot]) continue;

    const eid = M.ownerEid[slot];
    if (!eid || !entityExists(world, eid)) continue;

    const id = getId(eid);
    const WM = WorldTransformF32.m;
    if (!WM) continue;
    const off = id * 16;

    const dx = WM[off + 12] - px;
    const dy = WM[off + 13] - py;
    const dz = WM[off + 14] - pz;
    const distSq = dx * dx + dy * dy + dz * dz;

    if (distSq > pulseRadiusSq) {
      M.disturbanceMagnitude[slot] = 0;
      continue;
    }

    const dist = Math.sqrt(distSq);
    const timeDecay = Math.exp(-age * EMP_DECAY_RATE);
    const distDecay = Math.exp(-dist / MAGNETIC_DECAY_RADIUS);

    const pulse = pulsePeak * timeDecay * distDecay;
    M.disturbanceMagnitude[slot] = pulse;

    // Add noise to the field readings.
    const noiseScale = pulse / MAGNETIC_FIELD_BASE;
    M.fieldX[slot] = (Math.random() - 0.5) * noiseScale;
    M.fieldY[slot] = MAGNETIC_FIELD_BASE + (Math.random() - 0.5) * noiseScale;
    M.fieldZ[slot] = (Math.random() - 0.5) * noiseScale;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// OZONE GENERATION
// ═══════════════════════════════════════════════════════════════════════

function applyOzoneGeneration(world, px, py, pz, age) {
  // Ozone decays with age.
  if (age > OZONE_DURATION_S) return;

  const timeFactor = 1 - age / OZONE_DURATION_S;
  if (timeFactor <= 0) return;

  // Add pollution to nearest pollution zone.
  const zoneSlot = findNearestPollutionZone(px, py, pz, OZONE_RADIUS * 2);
  if (zoneSlot < 0) return;

  // Ozone contribution to the zone (ppb).
  const ozonePPB = OZONE_PEAK_PPB * timeFactor * 0.01;   // small but present
  addPollutionToZone(zoneSlot, Pollutant.O3, ozonePPB);
}

// ═══════════════════════════════════════════════════════════════════════
// FULGURITE FORMATION
// ═══════════════════════════════════════════════════════════════════════

function formFulgurite(world, px, py, pz, currentKA) {
  if (currentKA < FULGURITE_MIN_CURRENT_KA) return;

  const slot = allocFulgurite();
  if (slot < 0) return;

  const F = Fulgurite;
  F.px[slot] = px;
  F.py[slot] = py;
  F.pz[slot] = pz;
  F.depth[slot] = Math.min(FULGURITE_MAX_LENGTH,
    currentKA * 0.05 + Math.random() * 0.5);
  F.radius[slot] = Math.min(FULGURITE_MAX_RADIUS,
    0.01 + currentKA * 0.0001);
  F.age[slot] = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// SCORCH MARK
// ═══════════════════════════════════════════════════════════════════════

function formScorchMark(world, px, py, pz, currentKA, soilConductivity) {
  const slot = allocScorchMark();
  if (slot < 0) return;

  // Scorch radius from soil conductivity and current.
  const radius = Math.min(SCORCH_MAX_RADIUS,
    Math.max(SCORCH_MIN_RADIUS,
      (currentKA / 20.0) * (1.0 / Math.sqrt(Math.max(0.1, soilConductivity)))));

  const S = ScorchMark;
  S.px[slot] = px;
  S.py[slot] = py;
  S.pz[slot] = pz;
  S.radius[slot] = radius;
  S.intensity[slot] = 1.0;
  S.age[slot] = 0;
  S.lifetime[slot] = SCORCH_LIFETIME_MIN
    + Math.random() * (SCORCH_LIFETIME_MAX - SCORCH_LIFETIME_MIN);
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN STRIKE PROCESSING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Process a lightning strike (from file 041) for its environmental
 * consequences.
 *
 * @param world       ECS world
 * @param boltSlot    bolt slot from file 041
 * @returns env strike slot, or -1 if not processed
 */
export function processLightningStrike(world, boltSlot) {
  const B = LightningBolt;
  if (!B.active[boltSlot]) return -1;

  const px = B.ix[boltSlot];
  const py = B.iy[boltSlot];
  const pz = B.iz[boltSlot];
  const strikeType = B.strikeType[boltSlot];

  // Only CG strikes produce significant ground effects.
  if (strikeType !== StrikeType.CG_NEGATIVE && strikeType !== StrikeType.CG_POSITIVE) {
    return -1;
  }

  // Allocate env strike record.
  const slot = allocEnvStrike();
  if (slot < 0) return -1;

  const rng = mulberry32((slot * 2654435761 ^ (px * 10000 + pz * 10000)) >>> 0);
  const currentKA = sampleStrikeCurrent(rng);
  const energy = currentKA * 1e6;   // rough energy estimate (J)

  // Compute scorch radius from soil conductivity.
  const soilConductivity = soilConductivityAt(px, py, pz, world);

  const E = EnvironmentStrike;
  E.boltSlot[slot] = boltSlot;
  E.strikeType[slot] = strikeType;
  E.px[slot] = px;
  E.py[slot] = py;
  E.pz[slot] = pz;
  E.currentKA[slot] = currentKA;
  E.energy[slot] = energy;
  E.age[slot] = 0;
  E.scorchRadius[slot] = Math.min(SCORCH_MAX_RADIUS,
    Math.max(SCORCH_MIN_RADIUS,
      (currentKA / 20.0) * (1.0 / Math.sqrt(Math.max(0.1, soilConductivity)))));
  E.fulguriteFormed[slot] = 0;

  // 1. Fire ignition.
  attemptIgnition(world, px, py, pz, currentKA, rng);

  // 2. Scorch mark.
  formScorchMark(world, px, py, pz, currentKA, soilConductivity);

  // 3. Fulgurite formation.
  if (currentKA > FULGURITE_MIN_CURRENT_KA) {
    formFulgurite(world, px, py, pz, currentKA);
    E.fulguriteFormed[slot] = 1;
  }

  // 4. Hit target classification: search nearby entities.
  const searchRadiusSq = (TREE_DAMAGE_RADIUS * 4) * (TREE_DAMAGE_RADIUS * 4);

  // Find nearby entities via BVH raycast in 8 directions or via query.
  // Use query for all rigid bodies / characters / structures in range.
  const candidateEids = query(world, [WorldTransformF32]);
  for (let i = 0; i < candidateEids.length; i++) {
    const eid = candidateEids[i];
    const id = getId(eid);
    const WM = WorldTransformF32.m;
    if (!WM) continue;
    const off = id * 16;
    const dx = WM[off + 12] - px;
    const dy = WM[off + 13] - py;
    const dz = WM[off + 14] - pz;
    const distSq = dx * dx + dy * dy + dz * dz;

    if (distSq > searchRadiusSq) continue;

    // Tree damage (heuristic: entity has a tall AABB).
    const bOff = id * 6;
    const height = WorldBoundsF32.aabb[bOff + 4] - WorldBoundsF32.aabb[bOff + 1];
    if (height > 3.0) {
      applyTreeDamage(world, eid, currentKA);
    }

    // Structure damage (has RigidBody3D but is STATIC).
    if (hasComponent(world, eid, RigidBody3D)) {
      if (RigidBody3D.type[id] === BodyType3D.STATIC) {
        applyStructureDamage(world, eid, currentKA);
      }
    }

    // Character damage.
    if (hasComponent(world, eid, CharacterTag)) {
      applyCharacterDamage(world, eid, px, py, pz, currentKA);
    }

    // Grid node check.
    if (hasComponent(world, eid, GridNodeTag)) {
      causeGridOutage(world, eid, px, py, pz, currentKA);
    }
  }

  // 5. Wildlife scattering.
  applyWildlifeFright(world, px, py, pz);

  // 6. EMP pulse.
  applyEMPPulse(world, px, py, pz, currentKA);

  // 7. Magnetic pulse (immediate initial impulse).
  applyMagneticPulse(world, px, py, pz, currentKA, 0);

  return slot;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN SYSTEM — advance environmental consequences
// ═══════════════════════════════════════════════════════════════════════

/**
 * Full environmental lightning update.
 *
 * @param world       ECS world
 * @param dt          seconds
 */
export function systemEnvironmentalLightningTick(world, dt) {
  // 1. Process new strikes from file 041.
  const B = LightningBolt;
  for (let boltSlot = 0; boltSlot < B.active.length; boltSlot++) {
    if (!B.active[boltSlot]) continue;

    // Only process each bolt once, on its first frame.
    if (B.age[boltSlot] > dt * 1.5) continue;

    // Check if this bolt was already processed.
    let alreadyProcessed = false;
    for (let slot = 0; slot < MAX_IGNITION_EVENTS; slot++) {
      if (!EnvironmentStrike.active[slot]) continue;
      if (EnvironmentStrike.boltSlot[slot] === boltSlot) {
        alreadyProcessed = true;
        break;
      }
    }

    if (!alreadyProcessed) {
      processLightningStrike(world, boltSlot);
    }
  }

  // 2. Age env strike records.
  const E = EnvironmentStrike;
  for (let slot = 0; slot < MAX_IGNITION_EVENTS; slot++) {
    if (!E.active[slot]) continue;

    E.age[slot] += dt;

    // Magnetic pulse decay.
    applyMagneticPulse(world, E.px[slot], E.py[slot], E.pz[slot],
      E.currentKA[slot], E.age[slot]);

    // Ozone generation (decays over OZONE_DURATION_S).
    if (E.age[slot] < OZONE_DURATION_S) {
      applyOzoneGeneration(world, E.px[slot], E.py[slot], E.pz[slot], E.age[slot]);
    }

    // Retire after 120 s.
    if (E.age[slot] > 120) {
      freeEnvStrike(slot);
    }
  }

  // 3. Age scorch marks.
  const S = ScorchMark;
  for (let slot = 0; slot < MAX_SCORCH_MARKS; slot++) {
    if (S.active[slot] === 0) continue;

    S.age[slot] += dt;

    if (S.age[slot] > S.lifetime[slot]) {
      freeScorchMark(slot);
    }
  }

  // 4. Age tree strikes and process death.
  const T = TreeStrike;
  for (let slot = 0; slot < MAX_TREE_STRIKES; slot++) {
    if (T.active[slot] === 0) continue;

    T.age[slot] += dt;

    // Death countdown.
    if (T.deathTimer[slot] > 0) {
      T.deathTimer[slot] -= dt;

      if (T.deathTimer[slot] <= 0) {
        // Tree dies — dispatch to observers or apply physics fall.
        const treeEid = T.treeEid[slot];
        if (treeEid && entityExists(world, treeEid)) {
          // Trigger fall.
          if (hasComponent(world, treeEid, RigidBody3D)) {
            const id = getId(treeEid);
            RigidBody3D.wx[id] += (Math.random() - 0.5) * 3.0;
            RigidBody3D.wz[id] += (Math.random() - 0.5) * 3.0;
          }
        }
        T.deathTimer[slot] = -1;
      }
    }

    // Retire after 5 minutes.
    if (T.age[slot] > 300) {
      freeTreeStrike(slot);
    }
  }

  // 5. Age structure strikes.
  const ST = StructureStrike;
  for (let slot = 0; slot < MAX_STRUCTURE_STRIKES; slot++) {
    if (ST.active[slot] === 0) continue;

    ST.age[slot] += dt;

    if (ST.age[slot] > 300) {
      freeStructureStrike(slot);
    }
  }

  // 6. Update grid outage timers.
  const G = GridNode;
  for (let slot = 0; slot < _nextGridNodeSlot; slot++) {
    if (!G.active[slot]) continue;

    if (G.powered[slot] === 0 && G.outageTimer[slot] > 0) {
      G.outageTimer[slot] -= dt;

      if (G.outageTimer[slot] <= 0) {
        // Restore power.
        G.powered[slot] = 1;
        G.outageTimer[slot] = 0;
      }
    }
  }

  // 7. Age fulgurites (they last essentially forever).
  // No retirement needed.

  // 8. Advance wildlife frightened timers.
  const toRemove = [];
  for (const [eid, remaining] of _wildlifeFrightened) {
    const newRemaining = remaining - dt;
    if (newRemaining <= 0) {
      toRemove.push(eid);
    } else {
      _wildlifeFrightened.set(eid, newRemaining);

      // Sustain the flee velocity (renew it each frame).
      const cs = getCharacterSlot(eid);
      if (cs >= 0) {
        CharacterStateF32.wishX[cs] *= WILDLIFE_FLEE_SPEED_MULT;
        CharacterStateF32.wishZ[cs] *= WILDLIFE_FLEE_SPEED_MULT;
      }
    }
  }
  for (const eid of toRemove) {
    _wildlifeFrightened.delete(eid);
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the magnetic disturbance magnitude at a world position.
 */
export function sampleMagneticDisturbance(wx, wy, wz) {
  let maxDisturbance = 0;
  const M = MagneticSensor;

  for (let slot = 0; slot < _nextMagneticSensorSlot; slot++) {
    if (!M.active[slot]) continue;
    if (M.disturbanceMagnitude[slot] > maxDisturbance) {
      maxDisturbance = M.disturbanceMagnitude[slot];
    }
  }

  return maxDisturbance;
}

/**
 * Return whether a grid node is currently out.
 */
export function isGridNodeOutage(eid) {
  const slot = _gridNodeSlots.get(eid);
  if (slot === undefined) return false;
  return GridNode.powered[slot] === 0 && GridNode.outageTimer[slot] > 0;
}

/**
 * Return the remaining outage time (seconds) for a grid node.
 */
export function getGridOutageRemaining(eid) {
  const slot = _gridNodeSlots.get(eid);
  if (slot === undefined) return 0;
  return GridNode.outageTimer[slot];
}

/**
 * Return whether a wildlife entity is currently frightened.
 */
export function isWildlifeFrightened(eid) {
  return _wildlifeFrightened.has(eid);
}

/**
 * Return the frightened timer (seconds remaining) for a wildlife entity.
 */
export function getWildlifeFrightenedRemaining(eid) {
  return _wildlifeFrightened.get(eid) ?? 0;
}

/**
 * Return the total damage amount (0..1) applied to a structure.
 */
export function getStructureDamage(eid) {
  let maxDamage = 0;
  const S = StructureStrike;
  for (let slot = 0; slot < MAX_STRUCTURE_STRIKES; slot++) {
    if (!S.active[slot]) continue;
    if (S.structureEid[slot] === eid) {
      if (S.damage[slot] > maxDamage) {
        maxDamage = S.damage[slot];
      }
    }
  }
  return maxDamage;
}

/**
 * Return whether a tree entity has been killed by lightning.
 */
export function isTreeStruck(eid) {
  const T = TreeStrike;
  for (let slot = 0; slot < MAX_TREE_STRIKES; slot++) {
    if (!T.active[slot]) continue;
    if (T.treeEid[slot] === eid) {
      return true;
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

export function gatherEnvironmentalStrikesForRendering() {
  const result = [];
  const E = EnvironmentStrike;
  for (let slot = 0; slot < MAX_IGNITION_EVENTS; slot++) {
    if (!E.active[slot]) continue;
    result.push({
      slot,
      px: E.px[slot],
      py: E.py[slot],
      pz: E.pz[slot],
      currentKA: E.currentKA[slot],
      energy: E.energy[slot],
      age: E.age[slot],
      scorchRadius: E.scorchRadius[slot],
      fulguriteFormed: E.fulguriteFormed[slot] === 1,
    });
  }
  return result;
}

export function gatherScorchMarksForRendering() {
  const result = [];
  const S = ScorchMark;
  for (let slot = 0; slot < MAX_SCORCH_MARKS; slot++) {
    if (S.active[slot] === 0) continue;
    result.push({
      px: S.px[slot],
      py: S.py[slot],
      pz: S.pz[slot],
      radius: S.radius[slot],
      intensity: S.intensity[slot] * (1 - S.age[slot] / S.lifetime[slot]),
      age: S.age[slot],
    });
  }
  return result;
}

export function gatherTreeStrikesForRendering() {
  const result = [];
  const T = TreeStrike;
  for (let slot = 0; slot < MAX_TREE_STRIKES; slot++) {
    if (T.active[slot] === 0) continue;
    result.push({
      treeEid: T.treeEid[slot],
      currentKA: T.currentKA[slot],
      scorchLevel: T.scorchLevel[slot],
      trunkShattered: T.trunkShattered[slot] === 1,
      barkBlasted: T.barkBlasted[slot] === 1,
      dying: T.deathTimer[slot] > 0,
      age: T.age[slot],
    });
  }
  return result;
}

export function gatherGridNodesForRendering() {
  const result = [];
  const G = GridNode;
  for (let slot = 0; slot < _nextGridNodeSlot; slot++) {
    if (!G.active[slot]) continue;
    result.push({
      px: G.px[slot],
      py: G.py[slot],
      pz: G.pz[slot],
      voltageKV: G.voltageKV[slot],
      powered: G.powered[slot] === 1,
      outageTimer: G.outageTimer[slot],
    });
  }
  return result;
}

export function gatherFulguritesForRendering() {
  const result = [];
  const F = Fulgurite;
  for (let slot = 0; slot < MAX_FULGURITES; slot++) {
    if (F.active[slot] === 0) continue;
    result.push({
      px: F.px[slot],
      py: F.py[slot],
      pz: F.pz[slot],
      depth: F.depth[slot],
      radius: F.radius[slot],
      age: F.age[slot],
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearEnvironmentalLightning() {
  EnvironmentStrike.active.fill(0);
  EnvironmentStrike.freeHead = 0;
  EnvironmentStrike.liveCount = 0;

  ScorchMark.active.fill(0);
  ScorchMark.freeHead = 0;
  ScorchMark.liveCount = 0;

  TreeStrike.active.fill(0);
  TreeStrike.freeHead = 0;
  TreeStrike.liveCount = 0;

  StructureStrike.active.fill(0);
  StructureStrike.freeHead = 0;
  StructureStrike.liveCount = 0;

  Fulgurite.active.fill(0);
  Fulgurite.freeHead = 0;
  Fulgurite.liveCount = 0;

  GridNode.active.fill(0);
  _gridNodeSlots.clear();
  _nextGridNodeSlot = 0;

  MagneticSensor.active.fill(0);
  _magneticSensorSlots.clear();
  _nextMagneticSensorSlot = 0;

  _wildlifeFrightened.clear();
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function environmentalLightningStats() {
  let activeStrikes = 0;
  let activeScorchMarks = 0;
  let activeTreeStrikes = 0;
  let activeStructureStrikes = 0;
  let activeFulgurites = 0;
  let activeGridNodes = 0;
  let poweredGridNodes = 0;

  for (let slot = 0; slot < MAX_IGNITION_EVENTS; slot++) {
    if (EnvironmentStrike.active[slot]) activeStrikes++;
  }

  for (let slot = 0; slot < MAX_SCORCH_MARKS; slot++) {
    if (ScorchMark.active[slot]) activeScorchMarks++;
  }

  for (let slot = 0; slot < MAX_TREE_STRIKES; slot++) {
    if (TreeStrike.active[slot]) activeTreeStrikes++;
  }

  for (let slot = 0; slot < MAX_STRUCTURE_STRIKES; slot++) {
    if (StructureStrike.active[slot]) activeStructureStrikes++;
  }

  for (let slot = 0; slot < MAX_FULGURITES; slot++) {
    if (Fulgurite.active[slot]) activeFulgurites++;
  }

  for (let slot = 0; slot < _nextGridNodeSlot; slot++) {
    if (!GridNode.active[slot]) continue;
    activeGridNodes++;
    if (GridNode.powered[slot]) poweredGridNodes++;
  }

  return {
    activeStrikes,
    maxStrikes: MAX_IGNITION_EVENTS,
    activeScorchMarks,
    maxScorchMarks: MAX_SCORCH_MARKS,
    activeTreeStrikes,
    maxTreeStrikes: MAX_TREE_STRIKES,
    activeStructureStrikes,
    maxStructureStrikes: MAX_STRUCTURE_STRIKES,
    activeFulgurites,
    maxFulgurites: MAX_FULGURITES,
    activeGridNodes,
    poweredGridNodes,
    totalGridNodes: _nextGridNodeSlot,
    frightenedWildlife: _wildlifeFrightened.size,
  };
}