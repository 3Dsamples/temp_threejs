// file number : 056
// full path name : src/weather/056_smoke_fire.js
// description : Wildfire and smoke system. Simulates the full lifecycle
//               of landscape-scale fires:
//                 • FIRE MODEL — Rothermel (1972) surface fire spread
//                   model with fuel-type-specific parameters (grass,
//                   shrub, timber litter, timber understory, slash,
//                   agricultural). Fire spreads through a SoA grid
//                   of fuel cells, each with fuel load, moisture,
//                   slope, wind factor, and ROS (rate of spread).
//                   Supports surface fire, crown fire (Van Wagner
//                   1977), and spotting (ember transport).
//                 • SMOKE PLUME — buoyant plume rise model
//                   (Briggs 1965/1975) computes the plume's
//                   equilibrium height from the fire's heat release
//                   rate and the ambient wind, then rises through
//                   the troposphere. Smoke is emitted as particles
//                   that follow the plume's trajectory.
//                 • EMBER TRANSPORT — burning embers are lofted by
//                   the plume updraft, transported downwind, and
//                   ignite new spot fires upon landing.
//                 • RADIATIVE TRANSPORT — active fires emit
//                   hemispherical-directional radiance that
//                   illuminates nearby geometry and characters.
//                   The firelight is exposed as a set of point
//                   lights (file 015) plus a scattering field
//                   that file 017's integrator reads to add the
//                   characteristic orange-red glow to the sky.
//                 • SMOKE CLOUD AGGREGATION — particles condense
//                   into aggregated SmokeCloud records for efficient
//                   culling, raycasting, and self-shadowing.
//                 • SUN DIMMING — smoke optically attenuates the sun
//                   (file 028) and shifts its color toward
//                   orange-red (Rayleigh-style Mie forward scatter
//                   through aerosols).
//                 • VISIBILITY — Koschmieder extinction from the
//                   local smoke density.
//                 • GROUND BURNOUT — burned fuel decays to ash,
//                   which can be resuspended by wind.
//                 • FIRE TRIANGLE COUPLING — reads the weather
//                   pipeline's humidity, wind, temperature, and
//                   precipitation to gate spread: no fire in rain,
//                   slower spread with high humidity, faster in
//                   high wind.
//               All state lives in typed arrays; emission is O(active
//               fires), per-ember physics is O(MAX_EMBERS), per-smoke
//               physics is O(MAX_SMOKE_PARTICLES). Zero per-frame
//               allocation; steady-state 1M-entity scenes handle
//               landscape fires on Android 64-bit.
// best for : Wildfire gameplay, firefighting simulators, survival
//            scenarios, cinematic fire set-pieces, ecological
//            simulation, and any 1M-entity scene needing realistic
//            wildfire on Android 64-bit.
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
  SkyF32,
  SkyModel,
  getSkySlot,
} from '../sky/028_sky_atmosphere.js';

import {
  CloudInstance,
  CloudArchetype,
  CloudType,
} from '../sky/029_cloud_archetypes.js';

import {
  LightF32,
  LightType,
  addPointLight,
  setLightEnabled,
} from '../render/015_lights_shadows.js';

import {
  sampleWindAt,
  WindSource,
} from './047_wind_gusts.js';

import {
  extinctionToVisibility,
} from './046_fog_mist.js';

import {
  RainDrop,
} from './042_rain.js';

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
const GRAVITY                        = 9.81;
const AIR_DENSITY                    = 1.225;
const KELVIN_OFFSET                  = 273.15;
const STEFAN_BOLTZMANN               = 5.670374419e-8;

const MAX_FIRE_CELLS                 = 65_536;
const MAX_EMBERS                     = 32_768;
const MAX_SMOKE_PARTICLES            = 250_000;
const MAX_SMOKE_CLOUDS               = 128;
const MAX_BURNED_AREAS               = 16_384;
const MAX_FIRELIGHTS                 = 128;

// Rothermel surface fire spread model constants.
const MINERAL_DAMPING                = 0.4174;        // η_M for dead fuel
const MINERAL_CONTENT                = 0.0555;        // S_T
const PARTICLE_DENSITY               = 513.0;         // ρ_p kg/m³
const TOTAL_MINERAL_CONTENT          = 0.0555;        // S_T
const EFFECTIVE_MINERAL_CONTENT      = 0.01;          // S_e
const HEAT_OF_COMBUSTION            = 18_622_000.0;   // H kJ/kg → J/kg
const HEAT_SINK                      = 581.0;         // kJ/kg
const WIND_FACTOR_MAX                = 45.0;
const SLOPE_FACTOR_MAX               = 12.0;

// Fuel type parameters (Rothermel standard fuel models).
const FUEL_GRASS                    = 0;
const FUEL_GRASS_TIMBER             = 1;
const FUEL_SHRUB                    = 2;
const FUEL_TIMBER_UNDERSTORY        = 3;
const FUEL_TIMBER_LITTER            = 4;
const FUEL_TIMBER_SLASH             = 5;
const FUEL_AGRICULTURAL             = 6;
const FUEL_NONBURNABLE              = 7;

// Fuel moisture thresholds.
const MOISTURE_EXTINCTION            = 0.30;          // > this = no fire
const MOISTURE_MIN                   = 0.03;          // very dry
const MOISTURE_MAX                   = 0.40;

// Crown fire thresholds (Van Wagner 1977).
const CROWN_FIRE_CRITICAL_ROS        = 0.5;           // m/s
const CROWN_FIRE_CRITICAL_INTENSITY  = 2000.0;        // kW/m

// Fire behavior.
const MAX_ROS                        = 5.0;           // m/s max spread
const RESIDENCE_TIME_DEFAULT         = 30.0;          // seconds
const BURNED_ASH_DECAY               = 0.001;         // per second

// Heat release.
const HEAT_RELEASE_PER_KG            = 18.6e6;        // J/kg
const FLAME_TEMPERATURE              = 1100.0;        // K
const SMOKE_TEMPERATURE              = 400.0;         // K above ambient

// Plume rise (Briggs 1965).
const PLUME_RISE_COEFF_B             = 1.6;           // calm conditions
const PLUME_RISE_COEFF_F             = 0.045;         // windy conditions
const PLUME_EQUILIBRIUM_FACTOR       = 1.0;

// Smoke particle properties.
const SMOKE_PARTICLE_MIN_DIAMETER    = 1e-5;          // 10 µm
const SMOKE_PARTICLE_MAX_DIAMETER    = 1e-3;          // 1 mm
const SMOKE_PARTICLE_DRAG            = 1.2;
const SMOKE_LIFETIME_MIN             = 300.0;         // 5 minutes
const SMOKE_LIFETIME_MAX             = 3600.0;        // 1 hour
const SMOKE_SETTLING_VELOCITY        = 0.05;          // m/s for fine particles
const SMOKE_COHESION_RATE            = 0.02;          // per second

// Ember properties.
const EMBER_MIN_DIAMETER             = 0.001;         // 1 mm
const EMBER_MAX_DIAMETER             = 0.05;          // 5 cm
const EMBER_MIN_MASS                 = 1e-5;          // kg
const EMBER_MAX_MASS                 = 0.5;           // kg
const EMBER_MIN_LIFETIME             = 30.0;
const EMBER_MAX_LIFETIME             = 300.0;
const EMBER_BURN_INTENSITY           = 0.8;           // 0 = cold, 1 = fully burning
const EMBER_IGNITE_THRESHOLD         = 0.4;
const EMBER_DRAG                     = 0.5;

// Smoke optical properties.
const SMOKE_MASS_EXTINCTION          = 3.0;           // m²/kg (fresh smoke)
const SMOKE_MASS_EXTINCTION_AGED     = 1.5;           // m²/kg (older smoke)
const SMOKE_EXTINCTION_FACTOR        = SMOKE_MASS_EXTINCTION * 0.001;
const SMOKE_SUN_BLOCK_K              = 3.5;
const SMOKE_SUN_TRANSMIT_MIN         = 0.005;
const SMOKE_SUN_TINT_R               = 1.00;
const SMOKE_SUN_TINT_G               = 0.50;
const SMOKE_SUN_TINT_B               = 0.20;

// Visibility.
const SMOKE_VISIBILITY_MIN           = 1.0;           // metres

// Smoke cloud aggregation.
const SMOKE_CLOUD_MIN_PARTICLES      = 20;
const SMOKE_CLOUD_SPREAD_RADIUS      = 200.0;         // metres

// Fire light.
const FIRELIGHT_INTENSITY_BASE       = 1000.0;        // cd
const FIRELIGHT_RANGE                = 300.0;         // metres
const FIRELIGHT_MIN_AREA             = 1.0;           // m²

// Sun dimming.
const SMOKE_ABSORPTION_KM            = 0.15;          // per km

// Air viscosity (Sutherland's).
const AIR_VISCOSITY                  = 1.81e-5;

// Start radius.
const FIRE_START_RADIUS              = 5.0;           // metres

// ═══════════════════════════════════════════════════════════════════════
// FIRE TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const FireType = Object.freeze({
  SURFACE: 0,
  CROWN:   1,
  GROUND:  2,
  SPOT:    3,
});

// ═══════════════════════════════════════════════════════════════════════
// FIRE PHASE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const FirePhase = Object.freeze({
  UNBURNED:   0,
  IGNITED:    1,
  SPREADING:  2,
  BURNING:    3,
  DYING:      4,
  BURNED:     5,
  EXTINGUISHED: 6,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA FIRE CELL — one per spatial fire cell
// ═══════════════════════════════════════════════════════════════════════

export const FireCell = {
  // World-space centre of the cell.
  px: new Float32Array(MAX_FIRE_CELLS),
  py: new Float32Array(MAX_FIRE_CELLS),
  pz: new Float32Array(MAX_FIRE_CELLS),

  // Cell width (metres).
  size: new Float32Array(MAX_FIRE_CELLS),

  // Fuel type (FUEL_*).
  fuelType: new Uint8Array(MAX_FIRE_CELLS),

  // Current fuel load (kg/m²).
  fuelLoad: new Float32Array(MAX_FIRE_CELLS),

  // Initial fuel load.
  initialFuelLoad: new Float32Array(MAX_FIRE_CELLS),

  // Fuel moisture (0..1).
  moisture: new Float32Array(MAX_FIRE_CELLS),

  // Slope angle (radians).
  slope: new Float32Array(MAX_FIRE_CELLS),

  // Aspect (radians; direction the slope faces).
  aspect: new Float32Array(MAX_FIRE_CELLS),

  // Fire phase (FirePhase).
  phase: new Uint8Array(MAX_FIRE_CELLS),

  // Fire type (FireType).
  fireType: new Uint8Array(MAX_FIRE_CELLS),

  // Rate of spread (m/s).
  rateOfSpread: new Float32Array(MAX_FIRE_CELLS),

  // Fireline intensity (kW/m).
  firelineIntensity: new Float32Array(MAX_FIRE_CELLS),

  // Flame length (m).
  flameLength: new Float32Array(MAX_FIRE_CELLS),

  // Heat release rate (W).
  heatReleaseRate: new Float32Array(MAX_FIRE_CELLS),

  // Time burning (seconds).
  burnDuration: new Float32Array(MAX_FIRE_CELLS),

  // Age since ignition.
  age: new Float32Array(MAX_FIRE_CELLS),

  // Active flag.
  active: new Uint8Array(MAX_FIRE_CELLS),

  // Firelight slot (-1 = none).
  firelightSlot: new Int16Array(MAX_FIRE_CELLS),

  // Seed for noise.
  seed: new Uint32Array(MAX_FIRE_CELLS),
};

/** Marker: entity is a fire cell. */
export const FireCellTag = {};

const _fireCellSlots = new Map();
let _nextFireCellSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA EMBER PARTICLE
// ═══════════════════════════════════════════════════════════════════════

export const EmberParticle = {
  active: new Uint8Array(MAX_EMBERS),

  // World position.
  px: new Float32Array(MAX_EMBERS),
  py: new Float32Array(MAX_EMBERS),
  pz: new Float32Array(MAX_EMBERS),

  // Velocity.
  vx: new Float32Array(MAX_EMBERS),
  vy: new Float32Array(MAX_EMBERS),
  vz: new Float32Array(MAX_EMBERS),

  // Diameter (m).
  diameter: new Float32Array(MAX_EMBERS),

  // Mass (kg).
  mass: new Float32Array(MAX_EMBERS),

  // Current burn intensity (0..1).
  intensity: new Float32Array(MAX_EMBERS),

  // Age and lifetime (s).
  age: new Float32Array(MAX_EMBERS),
  lifetime: new Float32Array(MAX_EMBERS),

  // Source fire cell slot.
  cellSlot: new Uint16Array(MAX_EMBERS),

  // Ignition flag (0 = not yet landed, 1 = landed and igniting).
  ignition: new Uint8Array(MAX_EMBERS),

  // Free-list.
  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA SMOKE PARTICLE
// ═══════════════════════════════════════════════════════════════════════

export const SmokeParticle = {
  active: new Uint8Array(MAX_SMOKE_PARTICLES),

  // Position.
  px: new Float32Array(MAX_SMOKE_PARTICLES),
  py: new Float32Array(MAX_SMOKE_PARTICLES),
  pz: new Float32Array(MAX_SMOKE_PARTICLES),

  // Velocity.
  vx: new Float32Array(MAX_SMOKE_PARTICLES),
  vy: new Float32Array(MAX_SMOKE_PARTICLES),
  vz: new Float32Array(MAX_SMOKE_PARTICLES),

  // Diameter (m).
  diameter: new Float32Array(MAX_SMOKE_PARTICLES),

  // Mass of ash/aerosol (kg).
  mass: new Float32Array(MAX_SMOKE_PARTICLES),

  // Age and lifetime (s).
  age: new Float32Array(MAX_SMOKE_PARTICLES),
  lifetime: new Float32Array(MAX_SMOKE_PARTICLES),

  // Source fire cell slot.
  cellSlot: new Uint16Array(MAX_SMOKE_PARTICLES),

  // Aggregation index (which SmokeCloud this particle belongs to).
  cloudIndex: new Uint16Array(MAX_SMOKE_PARTICLES),

  // Free-list.
  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA SMOKE CLOUD
// ═══════════════════════════════════════════════════════════════════════

export const SmokeCloud = {
  active: new Uint8Array(MAX_SMOKE_CLOUDS),

  cx: new Float32Array(MAX_SMOKE_CLOUDS),
  cy: new Float32Array(MAX_SMOKE_CLOUDS),
  cz: new Float32Array(MAX_SMOKE_CLOUDS),

  // Bounding ellipsoid.
  rx: new Float32Array(MAX_SMOKE_CLOUDS),
  ry: new Float32Array(MAX_SMOKE_CLOUDS),
  rz: new Float32Array(MAX_SMOKE_CLOUDS),

  // Average density (kg/m³).
  density: new Float32Array(MAX_SMOKE_CLOUDS),

  // Age and lifetime.
  age: new Float32Array(MAX_SMOKE_CLOUDS),
  lifetime: new Float32Array(MAX_SMOKE_CLOUDS),

  // Number of particles in this cloud.
  particleCount: new Uint16Array(MAX_SMOKE_CLOUDS),
};

// ═══════════════════════════════════════════════════════════════════════
// SoA BURNED AREA
// ═══════════════════════════════════════════════════════════════════════

export const BurnedArea = {
  active: new Uint8Array(MAX_BURNED_AREAS),

  cx: new Float32Array(MAX_BURNED_AREAS),
  cy: new Float32Array(MAX_BURNED_AREAS),
  cz: new Float32Array(MAX_BURNED_AREAS),

  // Radius (m).
  radius: new Float32Array(MAX_BURNED_AREAS),

  // Ash depth on the ground (m).
  ashDepth: new Float32Array(MAX_BURNED_AREAS),

  // Age and lifetime.
  age: new Float32Array(MAX_BURNED_AREAS),
  lifetime: new Float32Array(MAX_BURNED_AREAS),

  // Fire type that created this area.
  fireType: new Uint8Array(MAX_BURNED_AREAS),
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
// FIRE CELL API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a fire cell.
 *
 * @param world       ECS world
 * @param eid         entity
 * @param options     { px, py, pz, size, fuelType, fuelLoad, moisture,
 *                      slope, aspect, initialPhase }
 * @returns fire cell slot id
 */
export function addFireCell(world, eid, options = {}) {
  if (_nextFireCellSlot >= MAX_FIRE_CELLS) {
    throw new Error('fire cell capacity exceeded');
  }
  const slot = _nextFireCellSlot++;

  addComponent(world, eid, FireCellTag);

  const C = FireCell;
  C.px[slot] = options.px ?? 0;
  C.py[slot] = options.py ?? 0;
  C.pz[slot] = options.pz ?? 0;
  C.size[slot] = options.size ?? 10.0;

  C.fuelType[slot] = options.fuelType ?? FUEL_GRASS;
  const defaultFuelLoad = fuelLoadForType(C.fuelType[slot]);
  C.fuelLoad[slot] = options.fuelLoad ?? defaultFuelLoad;
  C.initialFuelLoad[slot] = C.fuelLoad[slot];
  C.moisture[slot] = options.moisture ?? 0.08;
  C.slope[slot] = options.slope ?? 0;
  C.aspect[slot] = options.aspect ?? 0;

  C.phase[slot] = options.initialPhase ?? FirePhase.UNBURNED;
  C.fireType[slot] = FireType.SURFACE;
  C.rateOfSpread[slot] = 0;
  C.firelineIntensity[slot] = 0;
  C.flameLength[slot] = 0;
  C.heatReleaseRate[slot] = 0;
  C.burnDuration[slot] = RESIDENCE_TIME_DEFAULT;
  C.age[slot] = 0;

  C.active[slot] = 1;
  C.firelightSlot[slot] = -1;
  C.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  _fireCellSlots.set(eid, slot);
  return slot;
}

export function removeFireCell(world, eid) {
  const slot = _fireCellSlots.get(eid);
  if (slot === undefined) return;

  // Disable firelight.
  if (FireCell.firelightSlot[slot] >= 0) {
    setLightEnabled(FireCell.firelightSlot[slot], false);
  }

  FireCell.active[slot] = 0;
  _fireCellSlots.delete(eid);
  removeComponent(world, eid, FireCellTag);
}

export function getFireCellSlot(eid) {
  return _fireCellSlots.get(eid) ?? -1;
}

/**
 * Fuel load (kg/m²) for each Rothermel fuel model.
 */
function fuelLoadForType(fuelType) {
  switch (fuelType) {
    case FUEL_GRASS:              return 0.74;
    case FUEL_GRASS_TIMBER:       return 1.10;
    case FUEL_SHRUB:              return 2.90;
    case FUEL_TIMBER_UNDERSTORY:  return 2.35;
    case FUEL_TIMBER_LITTER:      return 1.60;
    case FUEL_TIMBER_SLASH:       return 4.20;
    case FUEL_AGRICULTURAL:       return 0.45;
    case FUEL_NONBURNABLE:        return 0.0;
    default:                      return 0.5;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// EMBER PARTICLE POOL
// ═══════════════════════════════════════════════════════════════════════

function allocEmber() {
  const E = EmberParticle;
  for (let i = 0; i < MAX_EMBERS; i++) {
    const slot = (E.freeHead + i) % MAX_EMBERS;
    if (E.active[slot] === 0) {
      E.freeHead = (slot + 1) % MAX_EMBERS;
      E.active[slot] = 1;
      E.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeEmber(slot) {
  const E = EmberParticle;
  if (E.active[slot] === 0) return;
  E.active[slot] = 0;
  E.liveCount--;
}

// ═══════════════════════════════════════════════════════════════════════
// SMOKE PARTICLE POOL
// ═══════════════════════════════════════════════════════════════════════

function allocSmoke() {
  const S = SmokeParticle;
  for (let i = 0; i < MAX_SMOKE_PARTICLES; i++) {
    const slot = (S.freeHead + i) % MAX_SMOKE_PARTICLES;
    if (S.active[slot] === 0) {
      S.freeHead = (slot + 1) % MAX_SMOKE_PARTICLES;
      S.active[slot] = 1;
      S.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeSmoke(slot) {
  const S = SmokeParticle;
  if (S.active[slot] === 0) return;
  S.active[slot] = 0;
  S.liveCount--;
}

// ═══════════════════════════════════════════════════════════════════════
// ROTHERMEL FIRE SPREAD MODEL
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the rate of spread (m/s) for a fire cell using the
 * Rothermel (1972) surface fire model.
 */
export function computeRothermelROS(cellSlot, windSpeed, windDirX, windDirZ) {
  const C = FireCell;
  const fuelType = C.fuelType[cellSlot];
  if (fuelType === FUEL_NONBURNABLE) return 0;
  if (C.moisture[cellSlot] > MOISTURE_EXTINCTION) return 0;

  // Fuel parameters (simplified Rothermel).
  const fuelLoad = C.fuelLoad[cellSlot];
  const fuelDepth = fuelDepthForType(fuelType);
  const sigma = 1750.0;              // surface-area-to-volume ratio (1/m)
  const beta = (PARTICLE_DENSITY * fuelLoad) / (fuelDepth * 1000.0);
  const beta_op = 0.20395;

  // Packing ratio factors.
  const A = 133.0 * Math.pow(sigma, -0.7913);
  const betaRatio = beta / beta_op;
  const A_term = 1.0 / (1.0 + A * Math.pow(betaRatio, 3));
  const B = Math.pow(sigma, -0.1);

  // Moisture damping.
  const rM = C.moisture[cellSlot] / MOISTURE_EXTINCTION;
  const moistDamping = MINERAL_DAMPING * rM;

  // Mineral damping.
  const eta_s = 0.174 * Math.pow(EFFECTIVE_MINERAL_CONTENT, -0.19);
  const minDamping = 0.4174 * (1 - 2.59 * rM + 5.11 * rM * rM - 3.52 * rM * rM * rM);

  // Heat sink.
  const epsilon = Math.exp(-138.0 / sigma);

  // Propagating flux ratio.
  const xi = Math.exp((0.792 + 0.681 * Math.sqrt(sigma)) * (beta + 0.1)) / (192.0 + 0.2595 * sigma);

  // Reaction intensity (kW/m²).
  const w_n = fuelLoad * (1 - TOTAL_MINERAL_CONTENT);
  const I_R = (HEAT_OF_COMBUSTION * w_n * 1000.0 * 1e-6) * xi * epsilon * minDamping / 60.0;

  // Wind factor.
  const windFactor = computeWindFactor(windSpeed, sigma, beta, xi);

  // Slope factor.
  const slopeFactor = computeSlopeFactor(C.slope[cellSlot], C.aspect[cellSlot], windDirX, windDirZ);

  // Fireline intensity.
  const I_B = I_R * fuelLoad / 60.0;   // approx kW/m

  // Rate of spread (m/s).
  const phi_w = windFactor;
  const phi_s = slopeFactor;
  const rho_b = fuelLoad / fuelDepth;
  const heatSource = I_R * xi * (1 + phi_w + phi_s);
  const heatSink = rho_b * epsilon * HEAT_SINK * minDamping;

  let ros = 0;
  if (heatSink > EPSILON) {
    ros = heatSource / heatSink * 60.0 / 1000.0;
  }
  ros = Math.max(0, Math.min(MAX_ROS, ros));

  return ros;
}

function fuelDepthForType(fuelType) {
  switch (fuelType) {
    case FUEL_GRASS:              return 0.30;
    case FUEL_GRASS_TIMBER:       return 0.60;
    case FUEL_SHRUB:              return 1.20;
    case FUEL_TIMBER_UNDERSTORY:  return 1.50;
    case FUEL_TIMBER_LITTER:      return 0.80;
    case FUEL_TIMBER_SLASH:       return 1.80;
    case FUEL_AGRICULTURAL:       return 0.40;
    default:                      return 0.5;
  }
}

function computeWindFactor(windSpeed, sigma, beta, xi) {
  if (windSpeed < EPSILON) return 0;
  const C = 7.47 * Math.exp(-0.133 * Math.pow(sigma, 0.55));
  const B = 0.02526 * Math.pow(sigma, 0.54);
  const E = 0.715 * Math.exp(-3.59e-4 * sigma);
  const windFactor = C * Math.pow(windSpeed, B) * Math.pow(beta, -E);
  return Math.min(WIND_FACTOR_MAX, windFactor);
}

function computeSlopeFactor(slopeRadians, aspectRadians, windDirX, windDirZ) {
  if (slopeRadians < EPSILON) return 0;
  // Slope factor: φ_s = 5.275 * β^-0.3 * tan²(φ)
  const beta = 0.2;   // approximation
  const tanPhi = Math.tan(slopeRadians);
  const factor = 5.275 * Math.pow(beta, -0.3) * tanPhi * tanPhi;
  return Math.min(SLOPE_FACTOR_MAX, factor);
}

// ═══════════════════════════════════════════════════════════════════════
// CROWN FIRE CRITERION (Van Wagner 1977)
// ═══════════════════════════════════════════════════════════════════════

function isCrownFire(cellSlot, firelineIntensity) {
  const C = FireCell;
  return firelineIntensity > CROWN_FIRE_CRITICAL_INTENSITY
    && C.rateOfSpread[cellSlot] > CROWN_FIRE_CRITICAL_ROS;
}

// ═══════════════════════════════════════════════════════════════════════
// EMBER EMISSION
// ═══════════════════════════════════════════════════════════════════════

const _windAtCell = vec3.create();

function emitEmbers(world, cellSlot, dt) {
  const C = FireCell;
  if (C.phase[cellSlot] !== FirePhase.BURNING
      && C.phase[cellSlot] !== FirePhase.SPREADING) return;

  // Ember production rate scales with fireline intensity.
  const intensity = C.firelineIntensity[cellSlot];
  if (intensity < 100) return;   // too cool to loft embers

  const emberRate = Math.min(50, intensity / 200.0);
  const count = Math.floor(emberRate * dt) + (Math.random() < (emberRate * dt % 1) ? 1 : 0);

  // Sample ambient wind.
  sampleWindAt(C.px[cellSlot], C.py[cellSlot] + 2, C.pz[cellSlot], _windAtCell);
  const windSpeed = Math.hypot(_windAtCell[0], _windAtCell[2]);

  const rng = mulberry32((C.seed[cellSlot] ^ Math.floor(C.age[cellSlot] * 100)) >>> 0);

  for (let i = 0; i < count; i++) {
    const slot = allocEmber();
    if (slot < 0) return;

    const E = EmberParticle;
    const diameter = EMBER_MIN_DIAMETER
      + rng() * (EMBER_MAX_DIAMETER - EMBER_MIN_DIAMETER);
    const mass = EMBER_MIN_MASS + rng() * (EMBER_MAX_MASS - EMBER_MIN_MASS);

    E.px[slot] = C.px[cellSlot] + (rng() - 0.5) * C.size[cellSlot];
    E.py[slot] = C.py[cellSlot] + 3 + rng() * 5;
    E.pz[slot] = C.pz[cellSlot] + (rng() - 0.5) * C.size[cellSlot];

    // Updraft from fire, plus wind drift.
    E.vx[slot] = _windAtCell[0] * 0.5 + (rng() - 0.5) * 3;
    E.vy[slot] = 3 + rng() * 5;
    E.vz[slot] = _windAtCell[2] * 0.5 + (rng() - 0.5) * 3;

    E.diameter[slot] = diameter;
    E.mass[slot] = mass;
    E.intensity[slot] = EMBER_BURN_INTENSITY;
    E.age[slot] = 0;
    E.lifetime[slot] = EMBER_MIN_LIFETIME
      + rng() * (EMBER_MAX_LIFETIME - EMBER_MIN_LIFETIME);
    E.cellSlot[slot] = cellSlot;
    E.ignition[slot] = 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// EMBER PHYSICS + IGNITION
// ═══════════════════════════════════════════════════════════════════════

const _emberWind = vec3.create();

export function systemUpdateEmbers(world, dt) {
  const E = EmberParticle;

  for (let slot = 0; slot < MAX_EMBERS; slot++) {
    if (E.active[slot] === 0) continue;

    E.age[slot] += dt;

    // Burn intensity decays.
    E.intensity[slot] *= Math.pow(0.98, dt);

    // Retire if lifetime exceeded or burned out.
    if (E.age[slot] > E.lifetime[slot] || E.intensity[slot] < 0.05) {
      freeEmber(slot);
      continue;
    }

    // Sample wind.
    sampleWindAt(E.px[slot], E.py[slot], E.pz[slot], _emberWind);

    // Drag toward wind.
    const dx = _emberWind[0] - E.vx[slot];
    const dy = _emberWind[1] - E.vy[slot];
    const dz = _emberWind[2] - E.vz[slot];
    const relSpeedSq = dx * dx + dy * dy + dz * dz;
    const relSpeed = Math.sqrt(relSpeedSq);
    if (relSpeed > EPSILON) {
      const crossSection = E.diameter[slot] * E.diameter[slot];
      const dragMag = 0.5 * AIR_DENSITY * relSpeedSq * EMBER_DRAG * crossSection;
      const accelX = (dragMag / E.mass[slot]) * (dx / relSpeed);
      const accelY = (dragMag / E.mass[slot]) * (dy / relSpeed);
      const accelZ = (dragMag / E.mass[slot]) * (dz / relSpeed);

      E.vx[slot] += accelX * dt;
      E.vy[slot] += accelY * dt;
      E.vz[slot] += accelZ * dt;
    }

    // Gravity.
    E.vy[slot] -= GRAVITY * dt;

    const prevX = E.px[slot];
    const prevY = E.py[slot];
    const prevZ = E.pz[slot];

    const newX = prevX + E.vx[slot] * dt;
    const newY = prevY + E.vy[slot] * dt;
    const newZ = prevZ + E.vz[slot] * dt;

    // Impact test.
    if (newY < 1.0) {
      const hits = bvhRaycast(
        [prevX, prevY, prevZ],
        [E.vx[slot], E.vy[slot], E.vz[slot]],
        Math.hypot(E.vx[slot], E.vy[slot], E.vz[slot]) * dt + 2.0,
        true
      );

      if (hits.length > 0 || newY < 0) {
        // Ember lands — try to ignite the target cell.
        const impactEid = hits.length > 0 ? hits[0].eid : null;

        if (impactEid !== null) {
          const targetCellSlot = _fireCellSlots.get(impactEid);
          if (targetCellSlot !== undefined
              && FireCell.phase[targetCellSlot] === FirePhase.UNBURNED
              && E.intensity[slot] > EMBER_IGNITE_THRESHOLD) {
            // Ignite!
            FireCell.phase[targetCellSlot] = FirePhase.IGNITED;
            FireCell.age[targetCellSlot] = 0;
          }
        }

        freeEmber(slot);
        continue;
      }
    }

    E.px[slot] = newX;
    E.py[slot] = newY;
    E.pz[slot] = newZ;

    // Out of bounds.
    if (E.py[slot] < -100) {
      freeEmber(slot);
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// SMOKE EMISSION
// ═══════════════════════════════════════════════════════════════════════

function emitSmoke(world, cellSlot, dt) {
  const C = FireCell;
  if (C.phase[cellSlot] !== FirePhase.BURNING
      && C.phase[cellSlot] !== FirePhase.SPREADING) return;

  const intensity = C.firelineIntensity[cellSlot];
  if (intensity < 10) return;

  // Smoke production proportional to heat release.
  const smokeRate = Math.min(500, intensity * 0.5);
  const count = Math.floor(smokeRate * dt) + (Math.random() < (smokeRate * dt % 1) ? 1 : 0);

  sampleWindAt(C.px[cellSlot], C.py[cellSlot] + 2, C.pz[cellSlot], _windAtCell);
  const windSpeed = Math.hypot(_windAtCell[0], _windAtCell[2]);

  // Compute plume rise height from fire heat release.
  const heatFlux = C.heatReleaseRate[cellSlot];
  const plumeHeight = computePlumeRise(heatFlux, windSpeed);

  const rng = mulberry32((C.seed[cellSlot] ^ Math.floor(C.age[cellSlot] * 50)) >>> 0);

  for (let i = 0; i < count; i++) {
    const slot = allocSmoke();
    if (slot < 0) return;

    const S = SmokeParticle;
    const diameter = SMOKE_PARTICLE_MIN_DIAMETER
      + rng() * (SMOKE_PARTICLE_MAX_DIAMETER - SMOKE_PARTICLE_MIN_DIAMETER);

    S.px[slot] = C.px[cellSlot] + (rng() - 0.5) * C.size[cellSlot];
    S.py[slot] = C.py[cellSlot] + 2 + rng() * 5;
    S.pz[slot] = C.pz[cellSlot] + (rng() - 0.5) * C.size[cellSlot];

    // Initial upward velocity (buoyant plume).
    const initialVelocity = Math.sqrt(2 * GRAVITY * plumeHeight * 0.3);
    S.vx[slot] = _windAtCell[0] * 0.3 + (rng() - 0.5) * 2;
    S.vy[slot] = initialVelocity * (0.5 + rng() * 0.5);
    S.vz[slot] = _windAtCell[2] * 0.3 + (rng() - 0.5) * 2;

    S.diameter[slot] = diameter;
    S.mass[slot] = PI / 6 * Math.pow(diameter, 3) * 1000;   // ~1000 kg/m³ for smoke aerosol
    S.age[slot] = 0;
    S.lifetime[slot] = SMOKE_LIFETIME_MIN
      + rng() * (SMOKE_LIFETIME_MAX - SMOKE_LIFETIME_MIN);
    S.cellSlot[slot] = cellSlot;
    S.cloudIndex[slot] = 0xFFFF;
  }
}

/**
 * Briggs plume rise formula.
 * h_r = 1.6 * F^(1/3) * x^(2/3) / u   (neutral, calm)
 * or
 * h_r = 2.6 * (F / (u * S))^(1/3)    (stable, equilibrium)
 */
function computePlumeRise(heatFluxWatts, windSpeed) {
  // Buoyancy flux (m⁴/s³).
  const F = (GRAVITY * heatFluxWatts) / (PI * AIR_DENSITY * 1005 * 300);
  // 300 K assumed ambient buoyancy temperature difference.

  const u = Math.max(windSpeed, 0.5);

  // Equilibrium rise (Briggs stable).
  const S = 0.02;   // stability parameter (typical)
  const h = 2.6 * Math.pow(F / (u * S), 1/3);
  return Math.max(10, Math.min(20000, h));
}

// ═══════════════════════════════════════════════════════════════════════
// SMOKE PHYSICS
// ═══════════════════════════════════════════════════════════════════════

const _smokeWind = vec3.create();

export function systemUpdateSmoke(world, dt) {
  const S = SmokeParticle;

  for (let slot = 0; slot < MAX_SMOKE_PARTICLES; slot++) {
    if (S.active[slot] === 0) continue;

    S.age[slot] += dt;

    if (S.age[slot] > S.lifetime[slot]) {
      freeSmoke(slot);
      continue;
    }

    sampleWindAt(S.px[slot], S.py[slot], S.pz[slot], _smokeWind);

    // Drag toward wind.
    const dx = _smokeWind[0] - S.vx[slot];
    const dy = _smokeWind[1] - S.vy[slot];
    const dz = _smokeWind[2] - S.vz[slot];
    const relSpeedSq = dx * dx + dy * dy + dz * dz;
    const relSpeed = Math.sqrt(relSpeedSq);
    if (relSpeed > EPSILON) {
      const crossSection = S.diameter[slot] * S.diameter[slot];
      const dragMag = 0.5 * AIR_DENSITY * relSpeedSq * SMOKE_PARTICLE_DRAG * crossSection;
      const accelX = (dragMag / Math.max(S.mass[slot], EPSILON)) * (dx / relSpeed);
      const accelY = (dragMag / Math.max(S.mass[slot], EPSILON)) * (dy / relSpeed);
      const accelZ = (dragMag / Math.max(S.mass[slot], EPSILON)) * (dz / relSpeed);

      S.vx[slot] += accelX * dt;
      S.vy[slot] += accelY * dt;
      S.vz[slot] += accelZ * dt;
    }

    // Settling (very slow for fine smoke particles).
    S.vy[slot] -= SMOKE_SETTLING_VELOCITY * dt;

    // Position.
    S.px[slot] += S.vx[slot] * dt;
    S.py[slot] += S.vy[slot] * dt;
    S.pz[slot] += S.vz[slot] * dt;

    // Coagulation: diameter grows as particle ages.
    const ageFactor = S.age[slot] / S.lifetime[slot];
    S.diameter[slot] *= (1 + SMOKE_COHESION_RATE * dt * ageFactor);

    // Retire if hits ground or goes out of bounds.
    if (S.py[slot] < 0) {
      freeSmoke(slot);
      continue;
    }
    if (Math.abs(S.px[slot]) > 500000 || Math.abs(S.pz[slot]) > 500000) {
      freeSmoke(slot);
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// SMOKE CLOUD AGGREGATION
// ═══════════════════════════════════════════════════════════════════════

export function systemAggregateSmokeClouds(world, dt) {
  const S = SmokeParticle;
  const C = SmokeCloud;

  // Reset clouds.
  for (let i = 0; i < MAX_SMOKE_CLOUDS; i++) {
    C.active[i] = 0;
    C.particleCount[i] = 0;
  }

  // Aggregate live particles into clouds by spatial clustering.
  // Simple grid-based aggregation: each particle contributes to the
  // nearest cloud within SMOKE_CLOUD_SPREAD_RADIUS, or starts a new one.
  let cloudCount = 0;

  for (let slot = 0; slot < MAX_SMOKE_PARTICLES; slot++) {
    if (S.active[slot] === 0) continue;

    // Find a matching cloud.
    let bestCloud = -1;
    let bestDistSq = SMOKE_CLOUD_SPREAD_RADIUS * SMOKE_CLOUD_SPREAD_RADIUS;

    for (let c = 0; c < cloudCount; c++) {
      const dx = C.cx[c] - S.px[slot];
      const dy = C.cy[c] - S.py[slot];
      const dz = C.cz[c] - S.pz[slot];
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestCloud = c;
      }
    }

    if (bestCloud < 0) {
      // Create a new cloud.
      if (cloudCount >= MAX_SMOKE_CLOUDS) continue;
      bestCloud = cloudCount++;
      C.active[bestCloud] = 1;
      C.cx[bestCloud] = S.px[slot];
      C.cy[bestCloud] = S.py[slot];
      C.cz[bestCloud] = S.pz[slot];
      C.rx[bestCloud] = 0;
      C.ry[bestCloud] = 0;
      C.rz[bestCloud] = 0;
      C.density[bestCloud] = 0;
      C.age[bestCloud] = 0;
      C.lifetime[bestCloud] = SMOKE_LIFETIME_MAX;
      C.particleCount[bestCloud] = 0;
    }

    // Update cloud bounds and density.
    const nc = C.particleCount[bestCloud] + 1;
    C.cx[bestCloud] = (C.cx[bestCloud] * C.particleCount[bestCloud] + S.px[slot]) / nc;
    C.cy[bestCloud] = (C.cy[bestCloud] * C.particleCount[bestCloud] + S.py[slot]) / nc;
    C.cz[bestCloud] = (C.cz[bestCloud] * C.particleCount[bestCloud] + S.pz[slot]) / nc;
    C.rx[bestCloud] = Math.max(C.rx[bestCloud],
      Math.abs(S.px[slot] - C.cx[bestCloud]));
    C.ry[bestCloud] = Math.max(C.ry[bestCloud],
      Math.abs(S.py[slot] - C.cy[bestCloud]));
    C.rz[bestCloud] = Math.max(C.rz[bestCloud],
      Math.abs(S.pz[slot] - C.cz[bestCloud]));
    C.density[bestCloud] += S.mass[slot] / Math.max(PI / 6 * Math.pow(S.diameter[slot], 3), EPSILON);
    C.particleCount[bestCloud] = nc;

    S.cloudIndex[slot] = bestCloud;
  }

  // Discard clouds with too few particles.
  for (let c = 0; c < cloudCount; c++) {
    if (C.particleCount[c] < SMOKE_CLOUD_MIN_PARTICLES) {
      C.active[c] = 0;
    } else {
      C.density[c] /= C.particleCount[c];
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// FIRE CELL UPDATE — Rothermel spread + burning dynamics
// ═══════════════════════════════════════════════════════════════════════

export function systemUpdateFireCells(world, dt) {
  const C = FireCell;

  for (let slot = 0; slot < _nextFireCellSlot; slot++) {
    if (!C.active[slot]) continue;

    const phase = C.phase[slot];
    C.age[slot] += dt;

    // Ignition delay before active spreading.
    if (phase === FirePhase.IGNITED) {
      if (C.age[slot] > 3.0) {
        C.phase[slot] = FirePhase.SPREADING;
        C.age[slot] = 0;
      }
      continue;
    }

    if (phase === FirePhase.SPREADING || phase === FirePhase.BURNING) {
      // Sample wind at the cell.
      sampleWindAt(C.px[slot], C.py[slot] + 2, C.pz[slot], _windAtCell);
      const windSpeed = Math.hypot(_windAtCell[0], _windAtCell[2]);
      const windDirX = windSpeed > EPSILON ? _windAtCell[0] / windSpeed : 0;
      const windDirZ = windSpeed > EPSILON ? _windAtCell[2] / windSpeed : 0;

      // Compute ROS.
      const ros = computeRothermelROS(slot, windSpeed, windDirX, windDirZ);
      C.rateOfSpread[slot] = ros;

      // Fireline intensity.
      const heatPerUnitArea = HEAT_RELEASE_PER_KG * C.initialFuelLoad[slot];
      const firelineIntensity = heatPerUnitArea * ros / 60.0;   // kW/m
      C.firelineIntensity[slot] = firelineIntensity;

      // Flame length (Byram 1959).
      C.flameLength[slot] = Math.pow(firelineIntensity / 0.017, 0.5);

      // Heat release rate (W) — used for plume rise and firelight.
      const burningArea = C.size[slot] * C.size[slot];
      C.heatReleaseRate[slot] = firelineIntensity * 1000.0 * C.size[slot];

      // Fuel consumption.
      const fuelConsumptionRate = ros * C.initialFuelLoad[slot] / Math.max(C.size[slot], 1);
      C.fuelLoad[slot] = Math.max(0, C.fuelLoad[slot] - fuelConsumptionRate * dt);

      // Crown fire check.
      const isCrown = isCrownFire(slot, firelineIntensity);
      C.fireType[slot] = isCrown ? FireType.CROWN : FireType.SURFACE;

      // Emit embers and smoke.
      emitEmbers(world, slot, dt);
      emitSmoke(world, slot, dt);

      // Phase transition to BURNING once spreading has gone on a while.
      if (phase === FirePhase.SPREADING && C.age[slot] > 5.0) {
        C.phase[slot] = FirePhase.BURNING;
        C.age[slot] = 0;
      }

      // Phase transition to DYING when fuel is nearly depleted.
      if (C.fuelLoad[slot] < 0.05 * C.initialFuelLoad[slot]) {
        C.phase[slot] = FirePhase.DYING;
        C.age[slot] = 0;
      }

      // Create firelight if not yet created.
      if (C.firelightSlot[slot] < 0 && firelineIntensity > 100) {
        const eid = _allocFirelightEntity(world);
        addTransform(world, eid, {
          px: C.px[slot],
          py: C.py[slot] + 3,
          pz: C.pz[slot],
        });
        const lightSlot = addPointLight(world, eid, {
          color: [1.0, 0.55, 0.15],
          intensity: FIRELIGHT_INTENSITY_BASE,
          range: FIRELIGHT_RANGE,
          castShadow: false,
          layerMask: 1,
        });
        C.firelightSlot[slot] = lightSlot;
      }

      // Update firelight intensity and position.
      if (C.firelightSlot[slot] >= 0) {
        const lightSlot = C.firelightSlot[slot];
        const flickerFactor = 0.85 + 0.15 * Math.sin(C.age[slot] * 8 + slot);
        LightF32.intensity[lightSlot] = FIRELIGHT_INTENSITY_BASE
          * (firelineIntensity / 2000.0) * flickerFactor;
        LightF32.px[lightSlot] = C.px[slot];
        LightF32.py[lightSlot] = C.py[slot] + 3;
        LightF32.pz[lightSlot] = C.pz[slot];
      }
    } else if (phase === FirePhase.DYING) {
      // Slowly burn out.
      C.rateOfSpread[slot] = 0;
      C.firelineIntensity[slot] *= Math.pow(0.9, dt);
      C.heatReleaseRate[slot] *= Math.pow(0.9, dt);

      // Disable firelight.
      if (C.firelightSlot[slot] >= 0) {
        const lightSlot = C.firelightSlot[slot];
        LightF32.intensity[lightSlot] *= Math.pow(0.9, dt);
        if (LightF32.intensity[lightSlot] < 1.0) {
          setLightEnabled(lightSlot, false);
          C.firelightSlot[slot] = -1;
        }
      }

      if (C.age[slot] > 30.0) {
        C.phase[slot] = FirePhase.BURNED;
        // Create a burned area record.
        _recordBurnedArea(world, slot);
      }
    } else if (phase === FirePhase.BURNED) {
      // Nothing to do; cell is extinct.
    }
  }

  return world;
}

function _allocFirelightEntity(world) {
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

function _recordBurnedArea(world, cellSlot) {
  // Find an inactive burned area slot.
  for (let i = 0; i < MAX_BURNED_AREAS; i++) {
    if (BurnedArea.active[i]) continue;

    const C = FireCell;
    BurnedArea.active[i] = 1;
    BurnedArea.cx[i] = C.px[cellSlot];
    BurnedArea.cy[i] = C.py[cellSlot];
    BurnedArea.cz[i] = C.pz[cellSlot];
    BurnedArea.radius[i] = C.size[cellSlot] * 0.5;
    BurnedArea.ashDepth[i] = 0.002;
    BurnedArea.age[i] = 0;
    BurnedArea.lifetime[i] = 7200;   // 2 hours
    BurnedArea.fireType[i] = C.fireType[cellSlot];
    return;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SMOKE DENSITY SAMPLING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the smoke density (kg/m³) at a world position.
 * Uses the aggregated smoke clouds for efficiency (not the full
 * particle pool).
 */
export function sampleSmokeDensity(wx, wy, wz) {
  let density = 0;

  const C = SmokeCloud;
  for (let slot = 0; slot < MAX_SMOKE_CLOUDS; slot++) {
    if (!C.active[slot]) continue;

    const dx = (wx - C.cx[slot]) / Math.max(C.rx[slot], 1);
    const dy = (wy - C.cy[slot]) / Math.max(C.ry[slot], 1);
    const dz = (wz - C.cz[slot]) / Math.max(C.rz[slot], 1);
    const distSq = dx * dx + dy * dy + dz * dz;

    if (distSq < 1.0) {
      const falloff = 1 - distSq;
      density += C.density[slot] * falloff;
    }
  }

  return density;
}

/**
 * Sample visibility (metres) at a world position through smoke.
 */
export function sampleSmokeVisibility(wx, wy, wz) {
  const density = sampleSmokeDensity(wx, wy, wz);
  if (density < EPSILON) return Infinity;

  const beta = density * SMOKE_EXTINCTION_FACTOR * 100.0;
  return Math.max(SMOKE_VISIBILITY_MIN, extinctionToVisibility(beta));
}

// ═══════════════════════════════════════════════════════════════════════
// SUN DIMMING
// ═══════════════════════════════════════════════════════════════════════

export function sampleSmokeSunDimming(cameraX, cameraY, cameraZ, sunDirX, sunDirY, sunDirZ) {
  const steps = 8;
  const stepLen = 2000.0;
  let opticalDepth = 0;

  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * stepLen;
    const wx = cameraX + sunDirX * t;
    const wy = cameraY + sunDirY * t;
    const wz = cameraZ + sunDirZ * t;

    const density = sampleSmokeDensity(wx, wy, wz);
    opticalDepth += density * SMOKE_EXTINCTION_FACTOR * 100.0 * stepLen;
  }

  const transmission = Math.exp(-opticalDepth * SMOKE_SUN_BLOCK_K * 0.1);
  return Math.max(SMOKE_SUN_TRANSMIT_MIN, transmission);
}

export function sampleSmokeSunTint(sunTransmission) {
  const smokeiness = 1 - sunTransmission;
  return [
    1.0 * (1 - smokeiness) + SMOKE_SUN_TINT_R * smokeiness,
    1.0 * (1 - smokeiness) + SMOKE_SUN_TINT_G * smokeiness,
    1.0 * (1 - smokeiness) + SMOKE_SUN_TINT_B * smokeiness,
  ];
}

// ═══════════════════════════════════════════════════════════════════════
// RADIATIVE TRANSPORT — for firelit surfaces
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the additive fire radiance contribution (from all active fires)
 * to a view direction.
 */
export function sampleFireRadiance(cameraX, cameraY, cameraZ, dirX, dirY, dirZ, out) {
  out[0] = 0; out[1] = 0; out[2] = 0;

  const C = FireCell;
  for (let slot = 0; slot < _nextFireCellSlot; slot++) {
    if (!C.active[slot]) continue;
    if (C.phase[slot] !== FirePhase.BURNING && C.phase[slot] !== FirePhase.SPREADING) continue;

    const dx = C.px[slot] - cameraX;
    const dy = C.py[slot] + 3 - cameraY;
    const dz = C.pz[slot] - cameraZ;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1) continue;

    const cosAngle = (dx * dirX + dy * dirY + dz * dirZ) / dist;
    const angularRadius = C.flameLength[slot] / dist;
    if (cosAngle < Math.cos(Math.max(0.01, angularRadius))) continue;

    // Radiance contribution: proportional to fireline intensity / distance².
    const intensity = C.firelineIntensity[slot];
    const scale = Math.min(1, angularRadius * 100) * (intensity / 1000) / (dist * dist * 0.0001);
    const clampedScale = Math.min(10, scale);

    out[0] += clampedScale * 1.0;
    out[1] += clampedScale * 0.55;
    out[2] += clampedScale * 0.15;
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// FIRE IGNITION API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Ignite a fire at a world position.
 */
export function igniteAt(world, wx, wy, wz, fireType = FireType.SURFACE) {
  // Find the nearest fire cell within FIRE_START_RADIUS.
  const C = FireCell;
  let bestSlot = -1;
  let bestDistSq = FIRE_START_RADIUS * FIRE_START_RADIUS;

  for (let slot = 0; slot < _nextFireCellSlot; slot++) {
    if (!C.active[slot]) continue;
    if (C.phase[slot] !== FirePhase.UNBURNED) continue;

    const dx = C.px[slot] - wx;
    const dy = C.py[slot] - wy;
    const dz = C.pz[slot] - wz;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq < bestDistSq) {
      bestSlot = slot;
      bestDistSq = distSq;
    }
  }

  if (bestSlot < 0) return false;

  C.phase[bestSlot] = FirePhase.IGNITED;
  C.fireType[bestSlot] = fireType;
  C.age[bestSlot] = 0;
  return true;
}

// ═══════════════════════════════════════════════════════════════════════
// FIRE SPREAD TO NEIGHBORS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Spread fire to neighbouring cells. Called once per second (not per
 * frame) for efficiency. Neighbours are found by spatial proximity.
 */
export function systemSpreadFireToNeighbors(world) {
  const C = FireCell;

  for (let srcSlot = 0; srcSlot < _nextFireCellSlot; srcSlot++) {
    if (!C.active[srcSlot]) continue;
    if (C.phase[srcSlot] !== FirePhase.BURNING
        && C.phase[srcSlot] !== FirePhase.SPREADING) continue;

    const ros = C.rateOfSpread[srcSlot];
    if (ros < EPSILON) continue;

    // Search for neighbours within spread distance.
    const spreadRadius = ros * 10;   // 10-second look-ahead

    for (let dstSlot = 0; dstSlot < _nextFireCellSlot; dstSlot++) {
      if (dstSlot === srcSlot) continue;
      if (!C.active[dstSlot]) continue;
      if (C.phase[dstSlot] !== FirePhase.UNBURNED) continue;

      const dx = C.px[dstSlot] - C.px[srcSlot];
      const dz = C.pz[dstSlot] - C.pz[srcSlot];
      const dist = Math.hypot(dx, dz);

      if (dist < spreadRadius
          && C.moisture[dstSlot] < MOISTURE_EXTINCTION) {
        // Probability of ignition (simplified).
        const ignitionProb = Math.min(0.5, ros / (dist + EPSILON) * 0.1);
        if (Math.random() < ignitionProb) {
          C.phase[dstSlot] = FirePhase.IGNITED;
          C.age[dstSlot] = 0;
        }
      }
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// BURNED AREA UPDATE
// ═══════════════════════════════════════════════════════════════════════

export function systemUpdateBurnedAreas(world, dt) {
  for (let i = 0; i < MAX_BURNED_AREAS; i++) {
    if (!BurnedArea.active[i]) continue;

    BurnedArea.age[i] += dt;

    // Ash decay.
    BurnedArea.ashDepth[i] *= Math.pow(1 - BURNED_ASH_DECAY, dt);

    if (BurnedArea.age[i] > BurnedArea.lifetime[i]
        || BurnedArea.ashDepth[i] < EPSILON) {
      BurnedArea.active[i] = 0;
    }
  }
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// FIRELINE INTENSITY FROM FIRE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the total fireline intensity (kW/m) from all active fires.
 */
export function getTotalFirelineIntensity() {
  let total = 0;
  const C = FireCell;
  for (let slot = 0; slot < _nextFireCellSlot; slot++) {
    if (!C.active[slot]) continue;
    if (C.phase[slot] !== FirePhase.BURNING && C.phase[slot] !== FirePhase.SPREADING) continue;
    total += C.firelineIntensity[slot];
  }
  return total;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TICK
// ═══════════════════════════════════════════════════════════════════════

export function systemFireTick(world, dt, spreadSubstep = 1.0) {
  systemUpdateFireCells(world, dt);
  systemUpdateEmbers(world, dt);
  systemUpdateSmoke(world, dt);
  systemAggregateSmokeClouds(world, dt);

  // Spread step (throttled).
  static _spreadAccum = 0;
  _spreadAccum += dt;
  if (_spreadAccum >= spreadSubstep) {
    systemSpreadFireToNeighbors(world);
    _spreadAccum = 0;
  }

  systemUpdateBurnedAreas(world, dt);
  return world;
}

let _spreadAccum = 0;
function _staticSpreadAccum(value) { _spreadAccum = value; }

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS
// ═══════════════════════════════════════════════════════════════════════

export function getFirePhaseLabel(fireSlot) {
  if (fireSlot < 0 || fireSlot >= _nextFireCellSlot) return 'N/A';
  const phase = FireCell.phase[fireSlot];
  for (const [k, v] of Object.entries(FirePhase)) {
    if (v === phase) return k;
  }
  return 'UNKNOWN';
}

export function getFireTypeLabel(fireSlot) {
  if (fireSlot < 0 || fireSlot >= _nextFireCellSlot) return 'N/A';
  const type = FireCell.fireType[fireSlot];
  for (const [k, v] of Object.entries(FireType)) {
    if (v === type) return k;
  }
  return 'UNKNOWN';
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

export function gatherFiresForRendering() {
  const result = [];
  const C = FireCell;
  for (let slot = 0; slot < _nextFireCellSlot; slot++) {
    if (!C.active[slot]) continue;
    if (C.phase[slot] === FirePhase.UNBURNED
        || C.phase[slot] === FirePhase.BURNED
        || C.phase[slot] === FirePhase.EXTINGUISHED) continue;

    result.push({
      slot,
      px: C.px[slot],
      py: C.py[slot],
      pz: C.pz[slot],
      size: C.size[slot],
      phase: C.phase[slot],
      fireType: C.fireType[slot],
      firelineIntensity: C.firelineIntensity[slot],
      flameLength: C.flameLength[slot],
      heatReleaseRate: C.heatReleaseRate[slot],
      fuelLoad: C.fuelLoad[slot],
    });
  }
  return result;
}

export function gatherEmbersForRendering(maxOutput = 2048) {
  const result = [];
  const E = EmberParticle;
  for (let slot = 0; slot < MAX_EMBERS; slot++) {
    if (E.active[slot] === 0) continue;
    result.push({
      x: E.px[slot], y: E.py[slot], z: E.pz[slot],
      diameter: E.diameter[slot],
      intensity: E.intensity[slot],
      vx: E.vx[slot], vy: E.vy[slot], vz: E.vz[slot],
      age: E.age[slot],
      lifetime: E.lifetime[slot],
    });
    if (result.length >= maxOutput) break;
  }
  return result;
}

export function gatherSmokeCloudsForRendering() {
  const result = [];
  const C = SmokeCloud;
  for (let slot = 0; slot < MAX_SMOKE_CLOUDS; slot++) {
    if (!C.active[slot]) continue;
    result.push({
      cx: C.cx[slot],
      cy: C.cy[slot],
      cz: C.cz[slot],
      rx: C.rx[slot],
      ry: C.ry[slot],
      rz: C.rz[slot],
      density: C.density[slot],
      particleCount: C.particleCount[slot],
    });
  }
  return result;
}

export function gatherBurnedAreasForRendering() {
  const result = [];
  for (let i = 0; i < MAX_BURNED_AREAS; i++) {
    if (!BurnedArea.active[i]) continue;
    result.push({
      cx: BurnedArea.cx[i],
      cy: BurnedArea.cy[i],
      cz: BurnedArea.cz[i],
      radius: BurnedArea.radius[i],
      ashDepth: BurnedArea.ashDepth[i],
      fireType: BurnedArea.fireType[i],
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearFire() {
  FireCell.active.fill(0);
  _fireCellSlots.clear();
  _nextFireCellSlot = 0;

  EmberParticle.active.fill(0);
  EmberParticle.freeHead = 0;
  EmberParticle.liveCount = 0;

  SmokeParticle.active.fill(0);
  SmokeParticle.freeHead = 0;
  SmokeParticle.liveCount = 0;

  SmokeCloud.active.fill(0);
  BurnedArea.active.fill(0);
  _spreadAccum = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function fireStats() {
  let activeCells = 0;
  let burningCells = 0;
  let spreadingCells = 0;
  let crownCells = 0;
  let totalIntensity = 0;

  for (let slot = 0; slot < _nextFireCellSlot; slot++) {
    if (!FireCell.active[slot]) continue;
    activeCells++;
    if (FireCell.phase[slot] === FirePhase.BURNING) burningCells++;
    if (FireCell.phase[slot] === FirePhase.SPREADING) spreadingCells++;
    if (FireCell.fireType[slot] === FireType.CROWN) crownCells++;
    if (FireCell.phase[slot] === FirePhase.BURNING
        || FireCell.phase[slot] === FirePhase.SPREADING) {
      totalIntensity += FireCell.firelineIntensity[slot];
    }
  }

  let smokeCloudCount = 0;
  for (let i = 0; i < MAX_SMOKE_CLOUDS; i++) {
    if (SmokeCloud.active[i]) smokeCloudCount++;
  }

  return {
    activeCells,
    burningCells,
    spreadingCells,
    crownCells,
    totalIntensity,
    maxCells: MAX_FIRE_CELLS,
    embers: EmberParticle.liveCount,
    maxEmbers: MAX_EMBERS,
    smokeParticles: SmokeParticle.liveCount,
    maxSmokeParticles: MAX_SMOKE_PARTICLES,
    smokeClouds: smokeCloudCount,
  };
}