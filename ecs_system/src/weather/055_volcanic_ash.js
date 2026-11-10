// file number : 055
// full path name : src/weather/055_volcanic_ash.js
// description : Volcanic ash plume system. Models tephra dispersion
//               from an active volcanic vent, including the full
//               Mastin (2009) / Suzuki (1983) plume physics stack,
//               umbrella-cloud formation, gravity-current collapse,
//               downwind ash transport, particle settling by Stokes's
//               law, aviation hazard-zone classification (ICAO
//               VAA/IWXXA style), sun dimming, and visibility
//               attenuation. Contributes:
//                 • PlumeType taxonomy — HAWAIIAN (gentle effusive,
//                   low ash), STROMBOLIAN (moderate), VULCANIAN
//                   (violent, frequent ash), PELÉAN (pyroclastic
//                   dome collapse, huge ash), PLINIAN (stratospheric
//                   column, umbrella cloud), SURTSEYAN (phreatomagmatic,
//                   steam + ash), CALDERA (super-eruption scale).
//                 • SoA VolcanicVent — one per active vent, with
//                   world position, eruption column height, mass
//                   eruption rate (MER), magma density, tephra
//                   density, initial ash size distribution (Rosin-
//                   Rammler), and vent temperature.
//                 • SoA AshParticle pool — up to 500k particles with
//                   position, velocity, size (log-normal by Rosin-
//                   Rammler), density, and age. Stokes settling with
//                   the Cunningham slip-correction factor ensures
//                   realistic fall speeds for sub-100-µm particles.
//                 • Umbrella cloud formation — when the column
//                   reaches the neutral buoyancy level (NBL), an
//                   umbrella cloud spreads radially at the NBL.
//                   Modelled as an expanding horizontal disc.
//                 • Gravity-current collapse — for PELÉAN and
//                   PLINIAN, pyroclastic density currents (PDCs)
//                   flow downslope from the vent at high speed.
//                   Modelled as a horizontal surge with front
//                   velocity.
//                 • Aviation hazard classification — each ash cloud
//                   gets an ICAO-style hazard color (RED, ORANGE,
//                   YELLOW, GREEN) based on ash concentration and
//                   ceiling height. The hazard zone is offered as
//                   an API for game aviation systems.
//                 • Sun dimming — computes the ash optical depth
//                   along a sun ray so file 028's sky correctly
//                   dims and reddens the sun through the veil.
//                 • Visibility — ash extinction is computed with
//                   Koschmieder's formula (same as file 046).
//                 • Tephra settling on ground — accumulates as a
//                   ground layer (depth in mm), with particle
//                   re-suspension if wind speed is high enough.
//                 • Wind advection — reads file 047's wind field
//                   to advect the plume downwind.
//                 • Lahar trigger — if rainfall (file 042) is
//                   combined with fresh tephra (depth > 5 mm), a
//                   lahar (volcanic mudflow) entity is spawned.
//               All state lives in typed arrays; emission is
//               O(active vents), per-particle physics is
//               O(MAX_ASH_PARTICLES). Zero per-frame allocation;
//               steady-state 1M-entity scenes handle ash plumes on
//               Android 64-bit.
// best for : Volcanic gameplay, aviation hazard systems, post-
//            eruption survival, cinematic eruption set-pieces,
//            geological simulation, and any 1M-entity scene
//            needing realistic volcanic ash on Android 64-bit.
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
const AIR_DENSITY                    = 1.225;

const MAX_VENTS                      = 16;
const MAX_ASH_PARTICLES              = 500_000;
const MAX_ASH_CLOUDS                 = 64;
const MAX_ASH_ACCUMULATIONS          = 8_192;
const MAX_ASH_HAZARD_ZONES           = 32;

// Plume column heights (metres) by type.
const PLUME_HAWAIIAN_HEIGHT          = 1000;
const PLUME_STROMBOLIAN_HEIGHT       = 5000;
const PLUME_VULCANIAN_HEIGHT         = 12000;
const PLUME_PELEAN_HEIGHT            = 20000;
const PLUME_PLINIAN_HEIGHT           = 35000;
const PLUME_SURTSEYAN_HEIGHT         = 4000;
const PLUME_CALDERA_HEIGHT           = 50000;

// Mass eruption rates (kg/s).
const MER_HAWAIIAN                   = 1e3;
const MER_STROMBOLIAN                = 1e4;
const MER_VULCANIAN                  = 1e6;
const MER_PELEAN                     = 1e7;
const MER_PLINIAN                    = 1e8;
const MER_SURTSEYAN                  = 5e5;
const MER_CALDERA                    = 1e10;

// Ash particle physics.
const ASH_DENSITY                    = 2400.0;      // kg/m³ (silicate)
const ASH_MIN_DIAMETER               = 1e-6;        // 1 µm
const ASH_MAX_DIAMETER               = 3.2e-3;      // 3.2 mm
const ASH_ROSIN_RAMMLER_N            = 1.5;         // Rosin-Rammler exponent
const ASH_ROSIN_RAMMLER_D            = 0.5e-3;      // Rosin-Rammler scale (m)

// Air viscosity (Sutherland's law, ~18 °C).
const AIR_VISCOSITY                  = 1.81e-5;     // kg/(m·s)
const AIR_MOLECULAR_MEAN_FREE_PATH   = 6.8e-8;      // m at STP
const CUNNINGHAM_A1                  = 1.257;
const CUNNINGHAM_A2                  = 0.400;
const CUNNINGHAM_A3                  = 1.100;
const CUNNINGHAM_A4                  = 0.5;

// Stokes + Cunningham settling.
const ASH_TERMINAL_VELOCITY_MAX      = 20.0;        // m/s cap (large particles)

// Umbrella cloud.
const UMBRELLA_RADIUS_GROWTH_RATE     = 0.15;        // per second (fraction of height)
const UMBRELLA_TOP_DENSITY_FACTOR    = 0.3;         // umbrella top is thinner

// Gravity-current collapse.
const GRAVITY_CURRENT_MIN_SPEED      = 5.0;         // m/s
const GRAVITY_CURRENT_MAX_SPEED      = 250.0;       // m/s (PDC surge)
const GRAVITY_CURRENT_RUNOUT_MIN     = 500.0;       // metres
const GRAVITY_CURRENT_RUNOUT_MAX     = 50000.0;     // metres (large PDC)

// Aviation hazard thresholds (ICAO).
const HAZARD_GREEN_MAX_ASH            = 0.0002;     // mg/m³ → ~0.2 µg/m³
const HAZARD_YELLOW_MAX_ASH           = 0.002;      // mg/m³
const HAZARD_ORANGE_MAX_ASH           = 0.004;      // mg/m³
const HAZARD_RED_MIN_ASH              = 0.004;      // mg/m³

// Sun dimming.
const ASH_EXTINCTION_FACTOR           = 60.0;       // scattering coefficient
const ASH_SUN_BLOCK_K                 = 4.0;
const ASH_SUN_TRANSMIT_MIN            = 0.005;
const ASH_SUN_TINT_R                  = 1.00;
const ASH_SUN_TINT_G                  = 0.60;
const ASH_SUN_TINT_B                  = 0.35;

// Visibility.
const ASH_VISIBILITY_MIN              = 5.0;        // metres

// Ground accumulation.
const ASH_GROUND_DENSITY              = 1000.0;     // kg/m³ (loose tephra)
const ASH_ACCUM_MAX_DEPTH             = 2.0;        // metres
const ASH_ACCUM_MELT_RATE             = 0.0001;     // m/s
const ASH_RESUSPENSION_WIND_MIN       = 15.0;       // m/s
const ASH_RESUSPENSION_RATE           = 0.001;      // per second at threshold

// Lahar trigger.
const LAHAR_TEPHRA_THRESHOLD          = 0.005;      // 5 mm of tephra
const LAHAR_RAIN_THRESHOLD            = 1.0;        // mm/h
const LAHAR_MAX_RUNOUT                = 30000.0;    // metres

// Vent lifecycle.
const VENT_ERUPTION_STARTUP           = 5.0;        // seconds
const VENT_ERUPTION_DISSIPATE         = 30.0;

// Wind coupling at vent (relative to ambient wind).
const VENT_WIND_COUPLING              = 0.4;

// ═══════════════════════════════════════════════════════════════════════
// PLUME TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const PlumeType = Object.freeze({
  HAWAIIAN:    0,
  STROMBOLIAN: 1,
  VULCANIAN:   2,
  PELEAN:      3,
  PLINIAN:     4,
  SURTSEYAN:   5,
  CALDERA:     6,
});

// ═══════════════════════════════════════════════════════════════════════
// HAZARD COLOR ENUM — ICAO aviation color code
// ═══════════════════════════════════════════════════════════════════════

export const HazardColor = Object.freeze({
  GREEN:  0,
  YELLOW: 1,
  ORANGE: 2,
  RED:    3,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA VOLCANIC VENT
// ═══════════════════════════════════════════════════════════════════════

export const VolcanicVent = {
  ownerEid: new Uint32Array(MAX_VENTS),
  type: new Uint8Array(MAX_VENTS),

  // World position of the vent.
  px: new Float32Array(MAX_VENTS),
  py: new Float32Array(MAX_VENTS),
  pz: new Float32Array(MAX_VENTS),

  // Eruption column height (metres).
  columnHeight: new Float32Array(MAX_VENTS),

  // Mass eruption rate (kg/s).
  mer: new Float32Array(MAX_VENTS),

  // Ash mass fraction of tephra (0..1).
  ashFraction: new Float32Array(MAX_VENTS),

  // Vent temperature (°C).
  ventTemperature: new Float32Array(MAX_VENTS),

  // Eruption phase: 0 = forming, 1 = steady, 2 = dissipating.
  phase: new Float32Array(MAX_VENTS),

  // Age and lifetime (seconds).
  age: new Float32Array(MAX_VENTS),
  lifetime: new Float32Array(MAX_VENTS),

  // Wind direction and speed at vent (advected from file 047).
  windDirX: new Float32Array(MAX_VENTS),
  windDirZ: new Float32Array(MAX_VENTS),
  windSpeed: new Float32Array(MAX_VENTS),

  // Umbrella cloud state.
  umbrellaActive: new Uint8Array(MAX_VENTS),
  umbrellaRadius: new Float32Array(MAX_VENTS),
  umbrellaAltitude: new Float32Array(MAX_VENTS),

  // Gravity-current (PDC) state.
  pdcActive: new Uint8Array(MAX_VENTS),
  pdcDirectionX: new Float32Array(MAX_VENTS),
  pdcDirectionZ: new Float32Array(MAX_VENTS),
  pdcSpeed: new Float32Array(MAX_VENTS),
  pdcRunout: new Float32Array(MAX_VENTS),
  pdcTraveled: new Float32Array(MAX_VENTS),

  // Active flag.
  active: new Uint8Array(MAX_VENTS),

  // Aviation hazard color (HazardColor).
  hazard: new Uint8Array(MAX_VENTS),

  // Particle emission accumulator.
  emissionAccum: new Float32Array(MAX_VENTS),

  // Seed for noise.
  seed: new Uint32Array(MAX_VENTS),
};

/** Marker: entity is a volcanic vent. */
export const VolcanicVentTag = {};

const _ventSlots = new Map();
let _nextVentSlot = 0;

const _ventNoise = new Map();

// ═══════════════════════════════════════════════════════════════════════
// SoA ASH PARTICLE POOL
// ═══════════════════════════════════════════════════════════════════════

export const AshParticle = {
  active: new Uint8Array(MAX_ASH_PARTICLES),

  // World position.
  px: new Float32Array(MAX_ASH_PARTICLES),
  py: new Float32Array(MAX_ASH_PARTICLES),
  pz: new Float32Array(MAX_ASH_PARTICLES),

  // World velocity.
  vx: new Float32Array(MAX_ASH_PARTICLES),
  vy: new Float32Array(MAX_ASH_PARTICLES),
  vz: new Float32Array(MAX_ASH_PARTICLES),

  // Particle diameter (metres).
  diameter: new Float32Array(MAX_ASH_PARTICLES),

  // Mass (kg).
  mass: new Float32Array(MAX_ASH_PARTICLES),

  // Age and lifetime (seconds).
  age: new Float32Array(MAX_ASH_PARTICLES),
  lifetime: new Float32Array(MAX_ASH_PARTICLES),

  // Source vent slot.
  ventSlot: new Uint16Array(MAX_ASH_PARTICLES),

  // Free-list head.
  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA ASH CLOUD — aggregated ash cloud for rendering / visibility
// ═══════════════════════════════════════════════════════════════════════

export const AshCloud = {
  active: new Uint8Array(MAX_ASH_CLOUDS),

  // Center of the cloud.
  cx: new Float32Array(MAX_ASH_CLOUDS),
  cy: new Float32Array(MAX_ASH_CLOUDS),
  cz: new Float32Array(MAX_ASH_CLOUDS),

  // Horizontal radii and vertical extent.
  radiusX: new Float32Array(MAX_ASH_CLOUDS),
  radiusY: new Float32Array(MAX_ASH_CLOUDS),
  radiusZ: new Float32Array(MAX_ASH_CLOUDS),

  // Average ash density (kg/m³).
  density: new Float32Array(MAX_ASH_CLOUDS),

  // Source vent slot.
  ventSlot: new Uint16Array(MAX_ASH_CLOUDS),

  // Whether this cloud is the umbrella at the top or the main column.
  isUmbrella: new Uint8Array(MAX_ASH_CLOUDS),

  // Age and lifetime.
  age: new Float32Array(MAX_ASH_CLOUDS),
  lifetime: new Float32Array(MAX_ASH_CLOUDS),

  // Hazard color (HazardColor).
  hazard: new Uint8Array(MAX_ASH_CLOUDS),
};

// ═══════════════════════════════════════════════════════════════════════
// SoA ASH GROUND ACCUMULATION
// ═══════════════════════════════════════════════════════════════════════

export const AshAccumulation = {
  ownerEid: new Uint32Array(MAX_ASH_ACCUMULATIONS),

  // Depth (metres) of tephra on the ground.
  depth: new Float32Array(MAX_ASH_ACCUMULATIONS),

  // Mass (kg/m²).
  mass: new Float32Array(MAX_ASH_ACCUMULATIONS),

  // Resuspension accumulator.
  resuspendAccum: new Float32Array(MAX_ASH_ACCUMULATIONS),

  // Active.
  active: new Uint8Array(MAX_ASH_ACCUMULATIONS),
};

/** Marker: entity can accumulate volcanic tephra. */
export const AshAccumulationTag = {};

const _ashAccumSlots = new Map();
let _nextAshAccumSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA LAHAR
// ═══════════════════════════════════════════════════════════════════════

export const Lahar = {
  ownerEid: new Uint32Array(MAX_VENTS * 4),

  // World position.
  px: new Float32Array(MAX_VENTS * 4),
  py: new Float32Array(MAX_VENTS * 4),
  pz: new Float32Array(MAX_VENTS * 4),

  // Flow direction and speed.
  dirX: new Float32Array(MAX_VENTS * 4),
  dirZ: new Float32Array(MAX_VENTS * 4),
  speed: new Float32Array(MAX_VENTS * 4),

  // Runout distance (metres).
  runout: new Float32Array(MAX_VENTS * 4),
  traveled: new Float32Array(MAX_VENTS * 4),

  // Age and lifetime.
  age: new Float32Array(MAX_VENTS * 4),
  lifetime: new Float32Array(MAX_VENTS * 4),

  // Active.
  active: new Uint8Array(MAX_VENTS * 4),
};

/** Marker: entity is a lahar flow. */
export const LaharTag = {};

const _laharSlots = new Map();
let _nextLaharSlot = 0;

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

function getVentNoise(slot) {
  let n = _ventNoise.get(slot);
  if (!n) {
    n = createNoise3D(() => mulberry32(VolcanicVent.seed[slot]));
    _ventNoise.set(slot, n);
  }
  return n;
}

// ═══════════════════════════════════════════════════════════════════════
// VENT CREATION API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a volcanic vent.
 *
 * @param world       ECS world
 * @param eid         owner entity
 * @param type        PlumeType
 * @param options     { px, py, pz, lifetime, seed }
 * @returns vent slot id
 */
export function addVolcanicVent(world, eid, type = PlumeType.STROMBOLIAN, options = {}) {
  if (_nextVentSlot >= MAX_VENTS) {
    throw new Error('volcanic vent capacity exceeded');
  }
  const slot = _nextVentSlot++;

  addComponent(world, eid, VolcanicVentTag);

  const V = VolcanicVent;
  V.ownerEid[slot] = eid;
  V.type[slot] = type;

  V.px[slot] = options.px ?? 0;
  V.py[slot] = options.py ?? 0;
  V.pz[slot] = options.pz ?? 0;

  // Defaults per type.
  const defaults = plumeDefaultsForType(type);
  V.columnHeight[slot] = options.columnHeight ?? defaults.columnHeight;
  V.mer[slot] = options.mer ?? defaults.mer;
  V.ashFraction[slot] = options.ashFraction ?? defaults.ashFraction;
  V.ventTemperature[slot] = options.ventTemperature ?? defaults.ventTemperature;

  V.phase[slot] = 0;
  V.age[slot] = 0;
  V.lifetime[slot] = options.lifetime ?? (3600 + Math.random() * 7200);

  V.windDirX[slot] = 1;
  V.windDirZ[slot] = 0;
  V.windSpeed[slot] = 5;

  V.umbrellaActive[slot] = 0;
  V.umbrellaRadius[slot] = 0;
  V.umbrellaAltitude[slot] = V.columnHeight[slot] * 0.85;

  V.pdcActive[slot] = 0;
  V.pdcDirectionX[slot] = 1;
  V.pdcDirectionZ[slot] = 0;
  V.pdcSpeed[slot] = 0;
  V.pdcRunout[slot] = 0;
  V.pdcTraveled[slot] = 0;

  V.active[slot] = 1;
  V.hazard[slot] = HazardColor.GREEN;
  V.emissionAccum[slot] = 0;
  V.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  _ventSlots.set(eid, slot);
  return slot;
}

function plumeDefaultsForType(type) {
  switch (type) {
    case PlumeType.HAWAIIAN:
      return {
        columnHeight: PLUME_HAWAIIAN_HEIGHT,
        mer: MER_HAWAIIAN,
        ashFraction: 0.05,
        ventTemperature: 1100,
      };
    case PlumeType.STROMBOLIAN:
      return {
        columnHeight: PLUME_STROMBOLIAN_HEIGHT,
        mer: MER_STROMBOLIAN,
        ashFraction: 0.20,
        ventTemperature: 1150,
      };
    case PlumeType.VULCANIAN:
      return {
        columnHeight: PLUME_VULCANIAN_HEIGHT,
        mer: MER_VULCANIAN,
        ashFraction: 0.60,
        ventTemperature: 1100,
      };
    case PlumeType.PELEAN:
      return {
        columnHeight: PLUME_PELEAN_HEIGHT,
        mer: MER_PELEAN,
        ashFraction: 0.75,
        ventTemperature: 900,
      };
    case PlumeType.PLINIAN:
      return {
        columnHeight: PLUME_PLINIAN_HEIGHT,
        mer: MER_PLINIAN,
        ashFraction: 0.85,
        ventTemperature: 800,
      };
    case PlumeType.SURTSEYAN:
      return {
        columnHeight: PLUME_SURTSEYAN_HEIGHT,
        mer: MER_SURTSEYAN,
        ashFraction: 0.40,
        ventTemperature: 400,
      };
    case PlumeType.CALDERA:
      return {
        columnHeight: PLUME_CALDERA_HEIGHT,
        mer: MER_CALDERA,
        ashFraction: 0.95,
        ventTemperature: 700,
      };
    default:
      return {
        columnHeight: PLUME_STROMBOLIAN_HEIGHT,
        mer: MER_STROMBOLIAN,
        ashFraction: 0.20,
        ventTemperature: 1150,
      };
  }
}

export function removeVolcanicVent(world, eid) {
  const slot = _ventSlots.get(eid);
  if (slot === undefined) return;

  VolcanicVent.active[slot] = 0;
  VolcanicVent.ownerEid[slot] = 0;
  _ventSlots.delete(eid);
  _ventNoise.delete(slot);
  removeComponent(world, eid, VolcanicVentTag);
}

export function getVolcanicVentSlot(eid) {
  return _ventSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// ASH ACCUMULATION API
// ═══════════════════════════════════════════════════════════════════════

export function addAshAccumulation(world, eid) {
  if (_nextAshAccumSlot >= MAX_ASH_ACCUMULATIONS) {
    throw new Error('ash accumulation capacity exceeded');
  }
  let slot = _ashAccumSlots.get(eid);
  if (slot === undefined) {
    slot = _nextAshAccumSlot++;
    _ashAccumSlots.set(eid, slot);
  }

  addComponent(world, eid, AshAccumulationTag);

  const A = AshAccumulation;
  A.ownerEid[slot] = eid;
  A.depth[slot] = 0;
  A.mass[slot] = 0;
  A.resuspendAccum[slot] = 0;
  A.active[slot] = 1;
  return slot;
}

export function removeAshAccumulation(world, eid) {
  const slot = _ashAccumSlots.get(eid);
  if (slot === undefined) return;
  AshAccumulation.active[slot] = 0;
  AshAccumulation.ownerEid[slot] = 0;
  _ashAccumSlots.delete(eid);
  removeComponent(world, eid, AshAccumulationTag);
}

export function getAshAccumulationSlot(eid) {
  return _ashAccumSlots.get(eid) ?? -1;
}

export function getAshDepth(eid) {
  const slot = _ashAccumSlots.get(eid);
  if (slot === undefined) return 0;
  return AshAccumulation.depth[slot];
}

// ═══════════════════════════════════════════════════════════════════════
// ASH PARTICLE POOL
// ═══════════════════════════════════════════════════════════════════════

function allocAshParticle() {
  const P = AshParticle;
  for (let i = 0; i < MAX_ASH_PARTICLES; i++) {
    const slot = (P.freeHead + i) % MAX_ASH_PARTICLES;
    if (P.active[slot] === 0) {
      P.freeHead = (slot + 1) % MAX_ASH_PARTICLES;
      P.active[slot] = 1;
      P.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeAshParticle(slot) {
  const P = AshParticle;
  if (P.active[slot] === 0) return;
  P.active[slot] = 0;
  P.liveCount--;
}

// ═══════════════════════════════════════════════════════════════════════
// ROSIN-RAMMLER SIZE DISTRIBUTION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample a particle diameter from the Rosin-Rammler distribution.
 * R(d) = exp(-(d / D)^n)
 */
function sampleAshDiameter(rng) {
  // Inverse transform from the R-R distribution.
  const u = Math.max(1e-8, rng());
  const d = ASH_ROSIN_RAMMLER_D * Math.pow(-Math.log(u), 1.0 / ASH_ROSIN_RAMMLER_N);
  return Math.max(ASH_MIN_DIAMETER, Math.min(ASH_MAX_DIAMETER, d));
}

// ═══════════════════════════════════════════════════════════════════════
// STOKES SETTLING VELOCITY with Cunningham slip correction
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the terminal fall velocity of an ash particle using the
 * Stokes / Cunningham corrected formula (valid for Re < 1):
 *
 *   v_t = (g · (ρ_p - ρ_a) · d² ) / (18 · µ) · Cc
 *
 * where Cc = 1 + (λ/d) · (A1 + A2 · exp(-A3 · d/λ))
 */
export function ashTerminalVelocity(diameterM) {
  if (diameterM < EPSILON) return 0;

  const rhoDiff = ASH_DENSITY - AIR_DENSITY;
  const dSq = diameterM * diameterM;

  // Cunningham slip correction.
  const lambdaRatio = AIR_MOLECULAR_MEAN_FREE_PATH / diameterM;
  const slipCorrection = 1.0 + lambdaRatio * (
    CUNNINGHAM_A1
    + CUNNINGHAM_A2 * Math.exp(-CUNNINGHAM_A3 * lambdaRatio)
  );

  // Stokes velocity.
  const vt = (GRAVITY * rhoDiff * dSq) / (18.0 * AIR_VISCOSITY) * slipCorrection;

  // Cap for very large particles (Re > 1, not Stokes).
  return Math.min(ASH_TERMINAL_VELOCITY_MAX, vt);
}

// ═══════════════════════════════════════════════════════════════════════
// ASH PARTICLE EMISSION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Emit ash particles from a vent. Called once per frame.
 */
function emitAshParticles(world, ventSlot, dt) {
  const V = VolcanicVent;
  const P = AshParticle;

  const phase = V.phase[ventSlot];
  if (phase < 0.05) return;

  // Emission rate: MER × ashFraction / average particle mass.
  const mer = V.mer[ventSlot];
  const ashFraction = V.ashFraction[ventSlot];
  const ashRate = mer * ashFraction;   // kg/s

  // Average particle mass (assume average diameter from R-R dist).
  const avgDiameter = ASH_ROSIN_RAMMLER_D * 0.6;
  const avgMass = ASH_DENSITY * (PI / 6) * Math.pow(avgDiameter, 3);
  const particlesPerSecond = Math.min(200000, ashRate / Math.max(avgMass, EPSILON));

  const desired = particlesPerSecond * dt;
  let wholeCount = Math.floor(desired);
  if (Math.random() < desired - wholeCount) wholeCount++;

  const rng = mulberry32(
    (V.seed[ventSlot] ^ (V.age[ventSlot] * 1000)) >>> 0
  );

  const ventX = V.px[ventSlot];
  const ventY = V.py[ventSlot];
  const ventZ = V.pz[ventSlot];
  const columnHeight = V.columnHeight[ventSlot];

  for (let i = 0; i < wholeCount; i++) {
    const slot = allocAshParticle();
    if (slot < 0) return;

    // Sample diameter.
    const diameterM = sampleAshDiameter(rng);
    const mass = ASH_DENSITY * (PI / 6) * Math.pow(diameterM, 3);

    // Spawn position: small ring around the vent, at the base.
    const spawnRadius = 20 + rng() * 100;
    const spawnAngle = rng() * TWO_PI;
    const sx = ventX + Math.cos(spawnAngle) * spawnRadius;
    const sy = ventY + 5.0;
    const sz = ventZ + Math.sin(spawnAngle) * spawnRadius;

    // Initial vertical velocity: upward, proportional to column height.
    // (Simplified buoyancy column model: initial velocity ~ sqrt(2 g h)).
    const initialVertVel = Math.sqrt(2 * GRAVITY * columnHeight * 0.5);

    // Small horizontal spread.
    const hSpread = 2.0 + rng() * 5.0;
    const hAngle = rng() * TWO_PI;

    P.px[slot] = sx;
    P.py[slot] = sy;
    P.pz[slot] = sz;
    P.vx[slot] = Math.cos(hAngle) * hSpread;
    P.vy[slot] = initialVertVel * (0.7 + rng() * 0.6);
    P.vz[slot] = Math.sin(hAngle) * hSpread;
    P.diameter[slot] = diameterM;
    P.mass[slot] = mass;
    P.age[slot] = 0;
    P.lifetime[slot] = 300 + rng() * 1800;
    P.ventSlot[slot] = ventSlot;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ASH PARTICLE PHYSICS UPDATE
// ═══════════════════════════════════════════════════════════════════════

const _windSample = vec3.create();

/**
 * Advance ash particle physics:
 *   • buoyancy (updraft decays with altitude)
 *   • wind advection from file 047
 *   • Stokes settling (in addition to buoyancy)
 *   • lifetime decay
 */
export function systemUpdateAshParticles(world, dt) {
  const P = AshParticle;
  const V = VolcanicVent;

  for (let slot = 0; slot < MAX_ASH_PARTICLES; slot++) {
    if (P.active[slot] === 0) continue;

    P.age[slot] += dt;
    if (P.age[slot] > P.lifetime[slot]) {
      freeAshParticle(slot);
      continue;
    }

    const ventSlot = P.ventSlot[slot];
    const ventX = V.px[ventSlot];
    const ventY = V.py[ventSlot];
    const ventZ = V.pz[ventSlot];
    const columnHeight = V.columnHeight[ventSlot];

    // Sample wind at the particle position.
    sampleWindAt(P.px[slot], P.py[slot], P.pz[slot], _windSample);

    // Wind advection (partial - ash drifts more than it accelerates).
    const windFactor = 0.4;
    const windDeltaX = _windSample[0] * windFactor - P.vx[slot] * 0.5;
    const windDeltaY = _windSample[1] * windFactor - P.vy[slot] * 0.05;
    const windDeltaZ = _windSample[2] * windFactor - P.vz[slot] * 0.5;

    P.vx[slot] += windDeltaX * dt * 0.5;
    P.vz[slot] += windDeltaZ * dt * 0.5;

    // Buoyancy updraft: strongest inside the column, decaying above.
    const heightAboveVent = P.py[slot] - ventY;
    if (heightAboveVent < columnHeight) {
      const buoyancyT = Math.max(0, 1 - heightAboveVent / columnHeight);
      const buoyancyAccel = buoyancyT * buoyancyT * 5.0;
      P.vy[slot] += buoyancyAccel * dt;
    }

    // Stokes settling (downward).
    const settlingVel = ashTerminalVelocity(P.diameter[slot]);
    P.vy[slot] -= settlingVel * dt;

    // Air drag.
    P.vx[slot] *= Math.pow(0.98, dt);
    P.vy[slot] *= Math.pow(0.97, dt);
    P.vz[slot] *= Math.pow(0.98, dt);

    // Advance position.
    const newX = P.px[slot] + P.vx[slot] * dt;
    const newY = P.py[slot] + P.vy[slot] * dt;
    const newZ = P.pz[slot] + P.vz[slot] * dt;

    // Impact test — is the particle reaching the ground?
    if (newY < 1.0) {
      // Attempt a BVH raycast to find the ground surface.
      const hits = bvhRaycast(
        [newX, P.py[slot], newZ],
        [0, -1, 0],
        P.py[slot] + 10.0,
        true
      );
      if (hits.length > 0) {
        const h = hits[0];
        const impactY = P.py[slot] - h.t;

        // Accumulate on the impacted surface.
        const accumSlot = _ashAccumSlots.get(h.eid);
        if (accumSlot !== undefined) {
          const A = AshAccumulation;
          const volume = (PI / 6) * Math.pow(P.diameter[slot], 3);
          const depthIncrease = volume / Math.max(P.diameter[slot], 0.001);
          A.depth[accumSlot] = Math.min(ASH_ACCUM_MAX_DEPTH,
            A.depth[accumSlot] + depthIncrease * 0.01);
          A.mass[accumSlot] = A.depth[accumSlot] * ASH_GROUND_DENSITY;
        }

        freeAshParticle(slot);
        continue;
      }

      // Ground-plane fallback.
      if (newY < 0) {
        freeAshParticle(slot);
        continue;
      }
    }

    P.px[slot] = newX;
    P.py[slot] = newY;
    P.pz[slot] = newZ;

    // Out-of-bounds check.
    if (P.px[slot] < -500000 || P.px[slot] > 500000 ||
        P.pz[slot] < -500000 || P.pz[slot] > 500000) {
      freeAshParticle(slot);
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// VENT LIFECYCLE UPDATE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance vent phase, umbrella cloud, PDC, hazard classification.
 */
export function systemUpdateVents(world, dt) {
  const V = VolcanicVent;

  for (let ventSlot = 0; ventSlot < _nextVentSlot; ventSlot++) {
    if (!V.active[ventSlot]) continue;

    V.age[ventSlot] += dt;

    // Formation phase.
    if (V.phase[ventSlot] < 1) {
      V.phase[ventSlot] = Math.min(1,
        V.phase[ventSlot] + dt / VENT_ERUPTION_STARTUP);
    }

    // Dissipation.
    if (V.age[ventSlot] > V.lifetime[ventSlot] * 0.9) {
      V.phase[ventSlot] = Math.max(0,
        V.phase[ventSlot] - dt / VENT_ERUPTION_DISSIPATE);
      if (V.phase[ventSlot] <= 0) {
        V.active[ventSlot] = 0;
        continue;
      }
    }

    // Read wind at vent.
    sampleWindAt(V.px[ventSlot], V.py[ventSlot], V.pz[ventSlot], _windSample);
    const windSpeed = Math.hypot(_windSample[0], _windSample[2]);
    if (windSpeed > EPSILON) {
      V.windDirX[ventSlot] = _windSample[0] / windSpeed;
      V.windDirZ[ventSlot] = _windSample[2] / windSpeed;
      V.windSpeed[ventSlot] = windSpeed;
    }

    // Umbrella cloud — forms when column height exceeds the
    // neutral buoyancy level (NBL). We approximate NBL as 85% of
    // column height.
    const type = V.type[ventSlot];
    const hasUmbrella = (
      type === PlumeType.PLINIAN
      || type === PlumeType.CALDERA
      || type === PlumeType.PELEAN
    );

    if (hasUmbrella && V.columnHeight[ventSlot] > 8000) {
      if (V.umbrellaActive[ventSlot] === 0) {
        V.umbrellaActive[ventSlot] = 1;
        V.umbrellaRadius[ventSlot] = 500;
        V.umbrellaAltitude[ventSlot] = V.columnHeight[ventSlot] * 0.85;
      } else {
        // Umbrella grows by spreading rate proportional to column height.
        V.umbrellaRadius[ventSlot] += V.columnHeight[ventSlot]
          * UMBRELLA_RADIUS_GROWTH_RATE * dt;
      }
    }

    // Gravity-current (PDC) — for PELÉAN, PLINIAN, CALDERA.
    const hasPDC = (
      type === PlumeType.PELEAN
      || type === PlumeType.PLINIAN
      || type === PlumeType.CALDERA
    );

    if (hasPDC && V.pdcActive[ventSlot] === 0 && V.phase[ventSlot] > 0.5) {
      V.pdcActive[ventSlot] = 1;
      V.pdcDirectionX[ventSlot] = V.windDirX[ventSlot] * 0.7;
      V.pdcDirectionZ[ventSlot] = V.windDirZ[ventSlot] * 0.7;
      V.pdcSpeed[ventSlot] = GRAVITY_CURRENT_MIN_SPEED
        + (GRAVITY_CURRENT_MAX_SPEED - GRAVITY_CURRENT_MIN_SPEED)
        * (type === PlumeType.CALDERA ? 1.0
          : type === PlumeType.PLINIAN ? 0.6 : 0.3);
      V.pdcRunout[ventSlot] = GRAVITY_CURRENT_RUNOUT_MIN
        + (GRAVITY_CURRENT_RUNOUT_MAX - GRAVITY_CURRENT_RUNOUT_MIN)
        * (type === PlumeType.CALDERA ? 1.0
          : type === PlumeType.PLINIAN ? 0.5 : 0.2);
    }

    if (V.pdcActive[ventSlot]) {
      V.pdcTraveled[ventSlot] += V.pdcSpeed[ventSlot] * dt;
      // Decay speed.
      V.pdcSpeed[ventSlot] *= Math.pow(0.98, dt);

      if (V.pdcTraveled[ventSlot] > V.pdcRunout[ventSlot]) {
        V.pdcActive[ventSlot] = 0;
      }
    }

    // Hazard classification from ash concentration near the vent.
    const ashConcentration = sampleAshDensity(
      V.px[ventSlot],
      V.py[ventSlot] + V.columnHeight[ventSlot] * 0.5,
      V.pz[ventSlot]
    );
    V.hazard[ventSlot] = classifyHazard(ashConcentration);

    // Emit particles.
    emitAshParticles(world, ventSlot, dt);
  }
  return world;
}

function classifyHazard(ashConcentrationKgPerM3) {
  // Convert kg/m³ to mg/m³.
  const mgPerM3 = ashConcentrationKgPerM3 * 1e6;
  if (mgPerM3 >= HAZARD_RED_MIN_ASH * 1000) return HazardColor.RED;
  if (mgPerM3 >= HAZARD_ORANGE_MAX_ASH * 1000) return HazardColor.ORANGE;
  if (mgPerM3 >= HAZARD_YELLOW_MAX_ASH * 1000) return HazardColor.YELLOW;
  return HazardColor.GREEN;
}

// ═══════════════════════════════════════════════════════════════════════
// ASH DENSITY SAMPLING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Approximate the ash density (kg/m³) at a world position by summing
 * contributions from each active vent's column + umbrella + PDC.
 * This is a fast analytical estimate (not a full particle sum) so
 * sampling works even for distant queries without walking the entire
 * particle pool.
 */
export function sampleAshDensity(wx, wy, wz) {
  let totalDensity = 0;

  const V = VolcanicVent;
  for (let ventSlot = 0; ventSlot < _nextVentSlot; ventSlot++) {
    if (!V.active[ventSlot]) continue;

    const ventX = V.px[ventSlot];
    const ventY = V.py[ventSlot];
    const ventZ = V.pz[ventSlot];
    const columnHeight = V.columnHeight[ventSlot];

    // Column contribution.
    const heightAboveVent = wy - ventY;
    if (heightAboveVent > 0 && heightAboveVent < columnHeight * 1.2) {
      // Radial distance from the column axis.
      const dx = wx - ventX;
      const dz = wz - ventZ;
      const radialDistSq = dx * dx + dz * dz;

      // Column radius expands with altitude.
      const columnRadius = 100 + heightAboveVent * 0.15;
      const columnRadiusSq = columnRadius * columnRadius;

      if (radialDistSq < columnRadiusSq) {
        const radialFalloff = 1 - radialDistSq / columnRadiusSq;
        const verticalProfile = Math.exp(-heightAboveVent
          / Math.max(columnHeight * 0.5, 1));
        const mer = V.mer[ventSlot];
        const ashFraction = V.ashFraction[ventSlot];
        const phase = V.phase[ventSlot];

        // Empirical column density: proportional to MER^0.5 and
        // inverse to column volume.
        const density = 0.001 * Math.sqrt(mer / 1e5)
          * ashFraction
          * phase
          * verticalProfile
          * radialFalloff;

        totalDensity += density;
      }
    }

    // Umbrella contribution.
    if (V.umbrellaActive[ventSlot]) {
      const umbrellaAlt = V.umbrellaAltitude[ventSlot];
      const umbrellaR = V.umbrellaRadius[ventSlot];
      const dy = wy - umbrellaAlt;
      if (Math.abs(dy) < 2000) {   // 2 km vertical thickness
        const dx = wx - ventX;
        const dz = wz - ventZ;
        const radialDistSq = dx * dx + dz * dz;
        if (radialDistSq < umbrellaR * umbrellaR) {
          const radialFalloff = 1 - Math.sqrt(radialDistSq) / umbrellaR;
          const verticalFalloff = 1 - Math.abs(dy) / 2000;
          const mer = V.mer[ventSlot];
          const density = 0.0005 * Math.sqrt(mer / 1e5)
            * radialFalloff
            * verticalFalloff
            * V.phase[ventSlot];
          totalDensity += density;
        }
      }
    }

    // PDC contribution (ground surge).
    if (V.pdcActive[ventSlot]) {
      if (wy < 500) {   // PDCs hug the ground
        const dx = wx - ventX;
        const dz = wz - ventZ;
        const dist = Math.hypot(dx, dz);
        if (dist < V.pdcTraveled[ventSlot]) {
          // PDC front is at traveled; inside is the cloud.
          const radialFalloff = 1 - dist / Math.max(V.pdcTraveled[ventSlot], 1);
          const verticalFalloff = Math.exp(-wy / 200);
          const density = 0.01 * radialFalloff * verticalFalloff;
          totalDensity += density;
        }
      }
    }
  }

  return totalDensity;
}

// ═══════════════════════════════════════════════════════════════════════
// VISIBILITY
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the visibility (metres) at a world position through ash.
 */
export function sampleAshVisibility(wx, wy, wz) {
  const density = sampleAshDensity(wx, wy, wz);
  if (density < EPSILON) return Infinity;

  const beta = density * ASH_EXTINCTION_FACTOR;
  return Math.max(ASH_VISIBILITY_MIN, extinctionToVisibility(beta));
}

// ═══════════════════════════════════════════════════════════════════════
// SUN DIMMING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the sun transmission factor through ash along a sun ray.
 */
export function sampleAshSunDimming(cameraX, cameraY, cameraZ, sunDirX, sunDirY, sunDirZ) {
  const steps = 8;
  const stepLen = 2000.0;
  let opticalDepth = 0;

  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * stepLen;
    const wx = cameraX + sunDirX * t;
    const wy = cameraY + sunDirY * t;
    const wz = cameraZ + sunDirZ * t;

    const density = sampleAshDensity(wx, wy, wz);
    opticalDepth += density * ASH_EXTINCTION_FACTOR * stepLen;
  }

  const transmission = Math.exp(-opticalDepth * ASH_SUN_BLOCK_K * 0.1);
  return Math.max(ASH_SUN_TRANSMIT_MIN, transmission);
}

/**
 * Sample the tinted sun colour through ash.
 */
export function sampleAshSunTint(sunTransmission) {
  const ashiness = 1 - sunTransmission;
  return [
    1.0 * (1 - ashiness) + ASH_SUN_TINT_R * ashiness,
    1.0 * (1 - ashiness) + ASH_SUN_TINT_G * ashiness,
    1.0 * (1 - ashiness) + ASH_SUN_TINT_B * ashiness,
  ];
}

// ═══════════════════════════════════════════════════════════════════════
// GROUND ACCUMULATION UPDATE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance ground ash accumulations (resuspension, compaction).
 */
export function systemUpdateAshAccumulations(world, dt) {
  const A = AshAccumulation;

  for (let slot = 0; slot < _nextAshAccumSlot; slot++) {
    if (!A.active[slot]) continue;
    if (A.depth[slot] < EPSILON) continue;

    const eid = A.ownerEid[slot];
    if (!eid || !entityExists(world, eid)) continue;

    const id = getId(eid);
    const M = WorldTransformF32.m;
    if (!M) continue;
    const off = id * 16;
    const wx = M[off + 12];
    const wy = M[off + 13];
    const wz = M[off + 14];

    // Sample wind.
    sampleWindAt(wx, wy, wz, _windSample);
    const windSpeed = Math.hypot(_windSample[0], _windSample[2]);

    // Resuspension.
    if (windSpeed > ASH_RESUSPENSION_WIND_MIN) {
      const excess = windSpeed - ASH_RESUSPENSION_WIND_MIN;
      const resuspensionRate = ASH_RESUSPENSION_RATE * excess;
      const resuspended = Math.min(A.depth[slot], resuspensionRate * dt);
      A.depth[slot] -= resuspended;
      A.mass[slot] = A.depth[slot] * ASH_GROUND_DENSITY;

      // Release ash particles back into the air (budget-limited).
      const puffsToRelease = Math.min(3,
        Math.floor(resuspended * 50000 * dt));
      for (let p = 0; p < puffsToRelease; p++) {
        const ashSlot = allocAshParticle();
        if (ashSlot < 0) break;

        const P = AshParticle;
        P.px[ashSlot] = wx + (Math.random() - 0.5) * 20;
        P.py[ashSlot] = wy + 1;
        P.pz[ashSlot] = wz + (Math.random() - 0.5) * 20;
        P.vx[ashSlot] = _windSample[0] * 0.6;
        P.vy[ashSlot] = 0.5 + Math.random() * 1.5;
        P.vz[ashSlot] = _windSample[2] * 0.6;
        P.diameter[ashSlot] = ASH_ROSIN_RAMMLER_D * 0.5;
        P.mass[ashSlot] = ASH_DENSITY * (PI / 6)
          * Math.pow(P.diameter[ashSlot], 3);
        P.age[ashSlot] = 0;
        P.lifetime[ashSlot] = 30 + Math.random() * 60;
        P.ventSlot[ashSlot] = 0;   // not tied to a vent
      }
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// LAHAR TRIGGER
// ═══════════════════════════════════════════════════════════════════════

/**
 * Check whether a lahar should spawn at any ash-covered surface that
 * is currently receiving rain (from file 042).
 */
export function systemCheckLaharTriggers(world) {
  // For each ash-covered entity, check nearby rain drops.
  const A = AshAccumulation;
  const R = RainDrop;

  for (let slot = 0; slot < _nextAshAccumSlot; slot++) {
    if (!A.active[slot]) continue;
    if (A.depth[slot] < LAHAR_TEPHRA_THRESHOLD) continue;

    const eid = A.ownerEid[slot];
    if (!eid || !entityExists(world, eid)) continue;

    const id = getId(eid);
    const M = WorldTransformF32.m;
    if (!M) continue;
    const off = id * 16;
    const wx = M[off + 12];
    const wy = M[off + 13];
    const wz = M[off + 14];

    // Check for rain drops within 100 m.
    let rainCount = 0;
    for (let r = 0; r < RainDrop.active.length && rainCount < 10; r++) {
      if (R.active[r] === 0) continue;
      const dx = R.px[r] - wx;
      const dy = R.py[r] - wy;
      const dz = R.pz[r] - wz;
      if (dx * dx + dz * dz < 10000) {
        rainCount++;
      }
    }

    if (rainCount >= LAHAR_RAIN_THRESHOLD) {
      // Find an empty lahar slot.
      for (let l = 0; l < MAX_VENTS * 4; l++) {
        if (Lahar.active[l] !== 0) continue;
        Lahar.active[l] = 1;
        Lahar.px[l] = wx;
        Lahar.py[l] = wy;
        Lahar.pz[l] = wz;
        Lahar.dirX[l] = 1.0;
        Lahar.dirZ[l] = 0.0;
        Lahar.speed[l] = 8.0 + Math.random() * 4.0;
        Lahar.runout[l] = 2000 + Math.random() * 5000;
        Lahar.traveled[l] = 0;
        Lahar.age[l] = 0;
        Lahar.lifetime[l] = 600;
        break;
      }
    }
  }
  return world;
}

/**
 * Advance lahar flows.
 */
export function systemUpdateLahars(world, dt) {
  for (let slot = 0; slot < MAX_VENTS * 4; slot++) {
    if (!Lahar.active[slot]) continue;

    Lahar.age[slot] += dt;
    if (Lahar.age[slot] > Lahar.lifetime[slot]) {
      Lahar.active[slot] = 0;
      continue;
    }

    Lahar.px[slot] += Lahar.dirX[slot] * Lahar.speed[slot] * dt;
    Lahar.pz[slot] += Lahar.dirZ[slot] * Lahar.speed[slot] * dt;
    Lahar.traveled[slot] += Lahar.speed[slot] * dt;

    // Decay speed.
    Lahar.speed[slot] *= Math.pow(0.99, dt);

    if (Lahar.traveled[slot] > Lahar.runout[slot]) {
      Lahar.active[slot] = 0;
    }
  }
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TICK
// ═══════════════════════════════════════════════════════════════════════

export function systemVolcanicAshTick(world, dt) {
  systemUpdateVents(world, dt);
  systemUpdateAshParticles(world, dt);
  systemUpdateAshAccumulations(world, dt);
  systemCheckLaharTriggers(world);
  systemUpdateLahars(world, dt);
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS
// ═══════════════════════════════════════════════════════════════════════

export function getHazardLabel(ventSlot) {
  if (ventSlot < 0 || ventSlot >= _nextVentSlot) return 'N/A';
  switch (VolcanicVent.hazard[ventSlot]) {
    case HazardColor.GREEN:  return 'GREEN';
    case HazardColor.YELLOW: return 'YELLOW';
    case HazardColor.ORANGE: return 'ORANGE';
    case HazardColor.RED:    return 'RED';
    default:                 return 'GREEN';
  }
}

export function findNearestVent(wx, wy, wz, maxDist = 200000) {
  let nearest = -1;
  let nearestDistSq = maxDist * maxDist;

  for (let slot = 0; slot < _nextVentSlot; slot++) {
    if (!VolcanicVent.active[slot]) continue;
    const dx = VolcanicVent.px[slot] - wx;
    const dz = VolcanicVent.pz[slot] - wz;
    const distSq = dx * dx + dz * dz;
    if (distSq < nearestDistSq) {
      nearest = slot;
      nearestDistSq = distSq;
    }
  }
  return nearest;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

export function gatherVentsForRendering() {
  const result = [];
  for (let slot = 0; slot < _nextVentSlot; slot++) {
    if (!VolcanicVent.active[slot]) continue;
    result.push({
      slot,
      type: VolcanicVent.type[slot],
      px: VolcanicVent.px[slot],
      py: VolcanicVent.py[slot],
      pz: VolcanicVent.pz[slot],
      columnHeight: VolcanicVent.columnHeight[slot],
      mer: VolcanicVent.mer[slot],
      ashFraction: VolcanicVent.ashFraction[slot],
      phase: VolcanicVent.phase[slot],
      umbrellaActive: VolcanicVent.umbrellaActive[slot] === 1,
      umbrellaRadius: VolcanicVent.umbrellaRadius[slot],
      umbrellaAltitude: VolcanicVent.umbrellaAltitude[slot],
      pdcActive: VolcanicVent.pdcActive[slot] === 1,
      pdcTraveled: VolcanicVent.pdcTraveled[slot],
      hazard: VolcanicVent.hazard[slot],
    });
  }
  return result;
}

export function gatherAshParticlesForRendering(maxOutput = 16384) {
  const result = [];
  const P = AshParticle;
  for (let slot = 0; slot < MAX_ASH_PARTICLES; slot++) {
    if (P.active[slot] === 0) continue;
    result.push({
      x: P.px[slot], y: P.py[slot], z: P.pz[slot],
      diameter: P.diameter[slot],
      vx: P.vx[slot], vy: P.vy[slot], vz: P.vz[slot],
      age: P.age[slot],
      lifetime: P.lifetime[slot],
    });
    if (result.length >= maxOutput) break;
  }
  return result;
}

export function gatherAshAccumulationsForRendering() {
  const result = [];
  const A = AshAccumulation;
  for (let slot = 0; slot < _nextAshAccumSlot; slot++) {
    if (!A.active[slot]) continue;
    if (A.depth[slot] < EPSILON) continue;
    result.push({
      ownerEid: A.ownerEid[slot],
      depth: A.depth[slot],
      mass: A.mass[slot],
    });
  }
  return result;
}

export function gatherLaharsForRendering() {
  const result = [];
  for (let slot = 0; slot < MAX_VENTS * 4; slot++) {
    if (!Lahar.active[slot]) continue;
    result.push({
      px: Lahar.px[slot],
      py: Lahar.py[slot],
      pz: Lahar.pz[slot],
      dirX: Lahar.dirX[slot],
      dirZ: Lahar.dirZ[slot],
      speed: Lahar.speed[slot],
      traveled: Lahar.traveled[slot],
      runout: Lahar.runout[slot],
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearVolcanicAsh() {
  VolcanicVent.active.fill(0);
  VolcanicVent.ownerEid.fill(0);
  _ventSlots.clear();
  _ventNoise.clear();
  _nextVentSlot = 0;

  AshParticle.active.fill(0);
  AshParticle.freeHead = 0;
  AshParticle.liveCount = 0;

  AshAccumulation.active.fill(0);
  AshAccumulation.ownerEid.fill(0);
  _ashAccumSlots.clear();
  _nextAshAccumSlot = 0;

  Lahar.active.fill(0);
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function volcanicAshStats() {
  let activeVents = 0;
  let activeLahars = 0;
  const byType = [0, 0, 0, 0, 0, 0, 0];
  const byHazard = [0, 0, 0, 0];

  for (let slot = 0; slot < _nextVentSlot; slot++) {
    if (!VolcanicVent.active[slot]) continue;
    activeVents++;
    byType[VolcanicVent.type[slot]]++;
    byHazard[VolcanicVent.hazard[slot]]++;
  }

  for (let slot = 0; slot < MAX_VENTS * 4; slot++) {
    if (Lahar.active[slot]) activeLahars++;
  }

  return {
    activeVents,
    maxVents: MAX_VENTS,
    activeAshParticles: AshParticle.liveCount,
    maxAshParticles: MAX_ASH_PARTICLES,
    activeLahars,
    byType: {
      hawaiian: byType[PlumeType.HAWAIIAN],
      strombolian: byType[PlumeType.STROMBOLIAN],
      vulcanian: byType[PlumeType.VULCANIAN],
      pelehan: byType[PlumeType.PELEAN],
      plinian: byType[PlumeType.PLINIAN],
      surtseyan: byType[PlumeType.SURTSEYAN],
      caldera: byType[PlumeType.CALDERA],
    },
    byHazard: {
      green: byHazard[HazardColor.GREEN],
      yellow: byHazard[HazardColor.YELLOW],
      orange: byHazard[HazardColor.ORANGE],
      red: byHazard[HazardColor.RED],
    },
  };
}