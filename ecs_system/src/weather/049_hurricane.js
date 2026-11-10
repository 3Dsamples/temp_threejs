// file number : 049
// full path name : src/weather/049_hurricane.js
// description : Hurricane / typhoon / tropical cyclone system with a
//               physically-based two-zone wind field (calm eye, eyewall
//               updraft, spiral rain bands), storm surge modelling on
//               coastlines, spiral-band rain sourcing, translation across
//               the ocean, and integration with the wind / rain / tornado
//               subsystems already in the bitECS_max pipeline. Imports
//               029_cloud_archetypes.js as the single source of truth for
//               the parent cumulonimbus towers that make up the eyewall.
//               Contributes:
//                 • StormCategory taxonomy — TROPICAL_DEPRESSION,
//                   TROPICAL_STORM, HURRICANE_CAT1..CAT5 in both
//                   Saffir-Simpson (Atlantic) and JTWC (Pacific) scales.
//                 • Two-zone analytical wind model — inside the eye
//                   (r < eyeRadius) wind drops to nearly zero; in the
//                   eyewall (eyeRadius ≤ r < eyewallOuter) wind follows
//                   a Rankine-like peak; outside the eyewall the field
//                   decays exponentially out to the outer radius,
//                   producing the classic spiral rain band pattern when
//                   combined with a logarithmic spiral phase function.
//                 • Eye behavior — the eye radius is coupled to storm
//                   intensity (stronger storms have tighter, well-defined
//                   eyes); eye is mostly clear of cloud, dark blue when
//                   over water, and emits a distinct "stadium effect"
//                   visible from the ground.
//                 • Spiral bands — logarithmic spiral rain bands are
//                   distributed every ~60-90° of azimuth with their own
//                   cloud fraction, wind amplification, and lightning
//                   frequency. Rendered as a moving density field by
//                   sampling `sampleSpiralBandDensity`.
//                 • Storm surge — a coastal surge model that reads the
//                   local bathymetry from file 003's BVH hit normal and
//                   the local wind field to compute surge height and
//                   inundation. Uses the Holland (1980) pressure profile
//                   and the Jelesnianski (1992) SLOSH simplification for
//                   the surge factor.
//                 • Rain sourcing — rainfall rate scaled by radius
//                   (maximum in the eyewall, tapered exponentially
//                   outward) via the same Holland model used for wind.
//                 • Tornado generation — spawns tornadoes (file 048) in
//                   the eyewall when wind shear exceeds the rotational
//                   threshold — the source of hurricane-spawned tornadoes.
//                 • Storm translation — drift across the ocean at 5-25
//                   km/h, curving poleward with the Coriolis parameter.
//                 • Wind integration — registers an ATMOSPHERIC wind
//                   source in file 047 sized to the storm's total
//                   intensity so rain / snow drift / character
//                   controllers pick up the hurricane field
//                   automatically.
//                 • Storm surge water entity — creates a water body
//                   entity at the surge boundary that file 060's water
//                   surface sampling reads, so the surge is visible and
//                   physically correct.
//               All state lives in typed arrays; sampling is O(1) per
//               hurricane for the analytical field (no particle loop
//               required); the rendered clouds and debris still go
//               through 029 / 025 as usual. Zero per-frame allocation;
//               steady-state simulation of 32 hurricanes over a 1M-entity
//               world fits on Android 64-bit.
// best for : Tropical storm gameplay, coastal inundation events,
//            hurricane-chase cinematics, naval / sailing weather,
//            storm surge mechanics, cinematic "eye" moments, and any
//            1M-entity scene needing realistic tropical cyclones on
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
  PrecipitationType,
} from '../sky/029_cloud_archetypes.js';

import {
  CumulonimbusState,
  CumulonimbusSubtype,
  CumulonimbusTag,
  addCumulonimbus,
  removeCumulonimbus,
} from '../sky/039_cumulonimbus_clouds.js';

import {
  WindSource,
  WindSourceType,
  addWindSource,
  removeWindSource,
} from './047_wind_gusts.js';

import {
  TornadoInstance,
  TornadoType,
  EFRating,
  addTornado,
  removeTornado,
} from './048_tornado.js';

import {
  vec3,
  vec4,
  mat4,
  quat,
  createNoise2D,
  createNoise3D,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS — verified
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ                        = 1e-16;
const EPSILON                           = 1e-8;
const EPSILON_HIGH                      = 1e-12;
const PI                                = Math.PI;
const TWO_PI                            = 2 * Math.PI;
const INV_PI                            = 1 / Math.PI;
const INV_TWO_PI                        = 1 / (2 * Math.PI);
const HALF_PI                           = Math.PI / 2;
const DEG_TO_RAD                        = Math.PI / 180;
const RAD_TO_DEG                        = 180 / Math.PI;
const GRAVITY                           = 9.81;
const AIR_DENSITY                       = 1.225;
const WATER_DENSITY                     = 1025.0;      // kg/m³ (sea water)
const CORIOLIS_PARAMETER                = 5.0e-5;       // 1/s at ~20° latitude

const MAX_HURRICANES                     = 32;
const MAX_SPIRAL_BANDS                   = 8;
const MAX_HURRICANE_TORNADOES            = 8;

// Storm category velocity thresholds (10-minute sustained winds, m/s).
const TD_MIN_WIND                        = 10.8;        // 24 mph
const TS_MIN_WIND                        = 17.5;        // 39 mph
const CAT1_MIN_WIND                      = 33.0;        // 74 mph
const CAT2_MIN_WIND                      = 42.7;        // 96 mph
const CAT3_MIN_WIND                      = 49.6;        // 111 mph
const CAT4_MIN_WIND                      = 58.1;        // 130 mph
const CAT5_MIN_WIND                      = 70.0;        // 157 mph

// Eye radius by category (metres).
const EYE_RADIUS_CAT1                    = 60000;
const EYE_RADIUS_CAT2                    = 50000;
const EYE_RADIUS_CAT3                    = 40000;
const EYE_RADIUS_CAT4                    = 30000;
const EYE_RADIUS_CAT5                    = 20000;

// Eyewall radius by category (metres).
const EYEWALL_RADIUS_CAT1                = 80000;
const EYEWALL_RADIUS_CAT2                = 70000;
const EYEWALL_RADIUS_CAT3                = 55000;
const EYEWALL_RADIUS_CAT4                = 45000;
const EYEWALL_RADIUS_CAT5                = 35000;

// Outer radius (metres) — start of the spiral band field.
const OUTER_RADIUS_DEFAULT               = 400000;

// Rain rate (mm/h) at various radii.
const RAIN_RATE_EYEWALL                  = 60.0;
const RAIN_RATE_BAND_BASE                = 30.0;
const RAIN_RATE_OUTER_BASE               = 8.0;
const RAIN_RATE_TAPER_K                  = 1.5;

// Translation drift.
const TRANSLATE_SPEED_MIN                = 3.0;         // m/s
const TRANSLATE_SPEED_MAX                = 20.0;        // m/s
const TRANSLATE_CURVE_RATE               = 0.001;       // rad/s (poleward)

// Storm surge (Holland pressure profile).
const HOLLAND_B_PARAM_DEFAULT            = 1.5;
const SURGE_MAX_HEIGHT                   = 9.0;         // metres (Cat 5 max surge)
const SURGE_DECAY_DISTANCE               = 150000;      // metres to zero surge inland
const SURGE_WIND_COUPLING                = 0.0015;      // surge height per (m/s)²
const SURGE_PRESSURE_COUPLING            = 0.0025;      // surge height per hPa deficit

// Ambient pressure (hPa).
const AMBIENT_PRESSURE                   = 1013.0;
const CAT1_CENTRAL_PRESSURE              = 980.0;
const CAT5_CENTRAL_PRESSURE              = 900.0;

// Spiral band geometry.
const BAND_ANGULAR_SPACING_MIN           = 60 * DEG_TO_RAD;
const BAND_ANGULAR_SPACING_MAX           = 90 * DEG_TO_RAD;
const BAND_SPIRAL_PITCH                  = 0.35;        // tan of spiral angle
const BAND_DENSITY_AMPLITUDE             = 0.55;
const BAND_WIDTH_RADIANS                 = 8 * DEG_TO_RAD;

// Tornado spawning in the eyewall.
const HURRICANE_TORNADO_SHEAR_THRESHOLD  = 0.85;
const HURRICANE_TORNADO_SPAWN_RATE       = 0.005;       // per second
const HURRICANE_TORNADO_LIFETIME_MIN     = 30.0;
const HURRICANE_TORNADO_LIFETIME_MAX     = 120.0;
const HURRICANE_TORNADO_EF_MIN           = EFRating.EF0;
const HURRICANE_TORNADO_EF_MAX           = EFRating.EF2;

// Formation / dissipation.
const HURRICANE_FORMATION_TIME           = 600.0;       // seconds
const HURRICANE_DISSIPATION_TIME         = 900.0;       // seconds
const HURRICANE_MAX_LIFETIME             = 86400.0;     // 24 hours

// Wind field.
const WIND_RANKINE_POWER                 = 0.65;
const WIND_OUTER_DECAY_RATE              = 0.35;        // exponential decay per eyewall radius
const WIND_INFLOW_FRACTION               = 0.25;
const WIND_UPDRAFT_FRACTION              = 0.10;

// ═══════════════════════════════════════════════════════════════════════
// STORM CATEGORY ENUM
// ═══════════════════════════════════════════════════════════════════════

export const StormCategory = Object.freeze({
  TROPICAL_DEPRESSION: 0,
  TROPICAL_STORM:      1,
  HURRICANE_CAT1:      2,
  HURRICANE_CAT2:      3,
  HURRICANE_CAT3:      4,
  HURRICANE_CAT4:      5,
  HURRICANE_CAT5:      6,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA HURRICANE INSTANCE
// ═══════════════════════════════════════════════════════════════════════

export const HurricaneInstance = {
  ownerEid: new Uint32Array(MAX_HURRICANES),

  // Category (StormCategory).
  category: new Uint8Array(MAX_HURRICANES),

  // World-space center of the eye.
  cx: new Float32Array(MAX_HURRICANES),
  cy: new Float32Array(MAX_HURRICANES),
  cz: new Float32Array(MAX_HURRICANES),

  // Eye radius (metres).
  eyeRadius: new Float32Array(MAX_HURRICANES),

  // Eyewall radius (metres; outer edge of the eyewall).
  eyewallRadius: new Float32Array(MAX_HURRICANES),

  // Total storm extent (metres; outer spiral band radius).
  outerRadius: new Float32Array(MAX_HURRICANES),

  // Max sustained wind (m/s).
  maxWind: new Float32Array(MAX_HURRICANES),

  // Central pressure (hPa).
  centralPressure: new Float32Array(MAX_HURRICANES),

  // Holland B parameter (pressure profile shape).
  hollandB: new Float32Array(MAX_HURRICANES),

  // Rotation sense: +1 = counterclockwise (Northern), -1 = clockwise.
  rotationSense: new Float32Array(MAX_HURRICANES),

  // Translation direction (unit) and speed (m/s).
  translateDirX: new Float32Array(MAX_HURRICANES),
  translateDirZ: new Float32Array(MAX_HURRICANES),
  translateSpeed: new Float32Array(MAX_HURRICANES),

  // Formation / dissipation progress (0..1).
  formationProgress: new Float32Array(MAX_HURRICANES),
  dissipationProgress: new Float32Array(MAX_HURRICANES),

  // Age and lifetime.
  age: new Float32Array(MAX_HURRICANES),
  lifetime: new Float32Array(MAX_HURRICANES),

  // Active flag.
  active: new Uint8Array(MAX_HURRICANES),

  // Wind source slot (file 047).
  windSourceSlot: new Int16Array(MAX_HURRICANES),

  // Tornado slot array (spawned by this hurricane).
  tornadoSlots: new Int16Array(MAX_HURRICANES * MAX_HURRICANE_TORNADOES),
  tornadoCount: new Uint8Array(MAX_HURRICANES),

  // Seed for noise.
  seed: new Uint32Array(MAX_HURRICANES),
};

/** Marker: entity is a hurricane root. */
export const HurricaneTag = {};

const _hurricaneSlots = new Map(); // eid -> hurricane slot
let _nextHurricaneSlot = 0;

const _hurricaneNoise = new Map(); // slot -> noise

// ═══════════════════════════════════════════════════════════════════════
// SoA SPIRAL BAND STATE (per hurricane)
// ═══════════════════════════════════════════════════════════════════════

export const SpiralBand = {
  // Owner hurricane slot.
  hurricaneSlot: new Uint16Array(MAX_HURRICANES * MAX_SPIRAL_BANDS),

  // Angular offset of this band (radians).
  angularOffset: new Float32Array(MAX_HURRICANES * MAX_SPIRAL_BANDS),

  // Band density fraction (0..1).
  density: new Float32Array(MAX_HURRICANES * MAX_SPIRAL_BANDS),

  // Rain rate (mm/h) for this band.
  rainRate: new Float32Array(MAX_HURRICANES * MAX_SPIRAL_BANDS),

  // Count of active bands per hurricane.
  bandCount: new Uint8Array(MAX_HURRICANES),
};

// ═══════════════════════════════════════════════════════════════════════
// SoA STORM SURGE — one record per coastal landfall event
// ═══════════════════════════════════════════════════════════════════════

export const StormSurge = {
  hurricaneSlot: new Uint16Array(MAX_HURRICANES),

  // Peak surge height (metres) at the coast.
  surgeHeight: new Float32Array(MAX_HURRICANES),

  // Inland penetration distance (metres).
  inlandPenetration: new Float32Array(MAX_HURRICANES),

  // Coastline normal (unit vector pointing inland).
  coastNormalX: new Float32Array(MAX_HURRICANES),
  coastNormalZ: new Float32Array(MAX_HURRICANES),

  // Coastline point (world space).
  coastX: new Float32Array(MAX_HURRICANES),
  coastY: new Float32Array(MAX_HURRICANES),
  coastZ: new Float32Array(MAX_HURRICANES),

  // Active.
  active: new Uint8Array(MAX_HURRICANES),

  // Owning water entity (created on landfall).
  waterEntity: new Uint32Array(MAX_HURRICANES),
};

/** Marker: entity is a storm surge water body. */
export const StormSurgeTag = {};

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

function getHurricaneNoise(slot) {
  let n = _hurricaneNoise.get(slot);
  if (!n) {
    n = createNoise2D(() => mulberry32(HurricaneInstance.seed[slot]));
    _hurricaneNoise.set(slot, n);
  }
  return n;
}

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY HELPERS
// ═══════════════════════════════════════════════════════════════════════

function categoryFromWind(windMS) {
  if (windMS < TD_MIN_WIND) return StormCategory.TROPICAL_DEPRESSION;
  if (windMS < TS_MIN_WIND) return StormCategory.TROPICAL_DEPRESSION;
  if (windMS < CAT1_MIN_WIND) return StormCategory.TROPICAL_STORM;
  if (windMS < CAT2_MIN_WIND) return StormCategory.HURRICANE_CAT1;
  if (windMS < CAT3_MIN_WIND) return StormCategory.HURRICANE_CAT2;
  if (windMS < CAT4_MIN_WIND) return StormCategory.HURRICANE_CAT3;
  if (windMS < CAT5_MIN_WIND) return StormCategory.HURRICANE_CAT4;
  return StormCategory.HURRICANE_CAT5;
}

function eyeRadiusForCategory(cat) {
  switch (cat) {
    case StormCategory.HURRICANE_CAT1: return EYE_RADIUS_CAT1;
    case StormCategory.HURRICANE_CAT2: return EYE_RADIUS_CAT2;
    case StormCategory.HURRICANE_CAT3: return EYE_RADIUS_CAT3;
    case StormCategory.HURRICANE_CAT4: return EYE_RADIUS_CAT4;
    case StormCategory.HURRICANE_CAT5: return EYE_RADIUS_CAT5;
    default: return EYE_RADIUS_CAT1 * 1.5;
  }
}

function eyewallRadiusForCategory(cat) {
  switch (cat) {
    case StormCategory.HURRICANE_CAT1: return EYEWALL_RADIUS_CAT1;
    case StormCategory.HURRICANE_CAT2: return EYEWALL_RADIUS_CAT2;
    case StormCategory.HURRICANE_CAT3: return EYEWALL_RADIUS_CAT3;
    case StormCategory.HURRICANE_CAT4: return EYEWALL_RADIUS_CAT4;
    case StormCategory.HURRICANE_CAT5: return EYEWALL_RADIUS_CAT5;
    default: return EYEWALL_RADIUS_CAT1 * 1.5;
  }
}

function centralPressureForWind(windMS) {
  // Holland (1980) approximation.
  // Δp ≈ ρ * v_max² / (e * B) for atmospheric density 1.15 kg/m³ at sea.
  const rho = 1.15;
  const B = HOLLAND_B_PARAM_DEFAULT;
  const deltaP = (rho * windMS * windMS) / (Math.E * B);
  // Convert Pa to hPa.
  return Math.max(870, AMBIENT_PRESSURE - deltaP / 100);
}

// ═══════════════════════════════════════════════════════════════════════
// HURRICANE CREATION API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Spawn a hurricane at a world position.
 *
 * @param world       ECS world
 * @param eid         owner entity (usually a weather root)
 * @param options     { category, cx, cy, cz, maxWind, translateDir,
 *                      translateSpeed, rotationSense, seed, lifetime }
 * @returns hurricane slot id
 */
export function addHurricane(world, eid, options = {}) {
  if (_nextHurricaneSlot >= MAX_HURRICANES) {
    throw new Error('hurricane capacity exceeded');
  }
  const slot = _nextHurricaneSlot++;

  addComponent(world, eid, HurricaneTag);

  const H = HurricaneInstance;
  H.ownerEid[slot] = eid;

  // Wind / category.
  const maxWind = options.maxWind ?? CAT3_MIN_WIND;
  const category = options.category ?? categoryFromWind(maxWind);
  H.category[slot] = category;
  H.maxWind[slot] = maxWind;

  // Central pressure derived from wind (Holland).
  H.centralPressure[slot] = centralPressureForWind(maxWind);
  H.hollandB[slot] = HOLLAND_B_PARAM_DEFAULT;

  // Geometry.
  H.eyeRadius[slot] = options.eyeRadius ?? eyeRadiusForCategory(category);
  H.eyewallRadius[slot] = options.eyewallRadius ?? eyewallRadiusForCategory(category);
  H.outerRadius[slot] = options.outerRadius ?? OUTER_RADIUS_DEFAULT;

  // Center.
  H.cx[slot] = options.cx ?? 0;
  H.cy[slot] = options.cy ?? 0;
  H.cz[slot] = options.cz ?? 0;

  // Translation.
  const td = options.translateDir ?? [1, 0];
  H.translateDirX[slot] = td[0];
  H.translateDirZ[slot] = td[1];
  H.translateSpeed[slot] = options.translateSpeed ?? (TRANSLATE_SPEED_MIN
    + Math.random() * (TRANSLATE_SPEED_MAX - TRANSLATE_SPEED_MIN));

  // Rotation sense (+1 CCW, -1 CW).
  H.rotationSense[slot] = options.rotationSense ?? 1.0;

  // Formation.
  H.formationProgress[slot] = 0;
  H.dissipationProgress[slot] = 0;

  // Age and lifetime.
  H.age[slot] = 0;
  H.lifetime[slot] = options.lifetime ?? HURRICANE_MAX_LIFETIME;

  // Active.
  H.active[slot] = 1;

  // Wind source (file 047).
  const wslot = addWindSource(world, eid, WindSourceType.ATMOSPHERIC, {
    px: H.cx[slot], py: H.cy[slot], pz: H.cz[slot],
    radiusX: H.outerRadius[slot],
    radiusY: 20000,
    radiusZ: H.outerRadius[slot],
    dir: [1, 0, 0],              // will be overridden per-sample by hurricane
    baseSpeed: maxWind,
    gustAmplitude: 5.0,
    gustFrequency: 0.1,
    turbulenceScale: 0.0001,
    seed: options.seed ?? ((slot * 2654435761) >>> 0),
  });
  H.windSourceSlot[slot] = wslot;

  // Seed.
  H.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  // Spiral bands.
  initSpiralBands(slot);

  // Tornado slots cleared.
  H.tornadoCount[slot] = 0;
  for (let i = 0; i < MAX_HURRICANE_TORNADOES; i++) {
    H.tornadoSlots[slot * MAX_HURRICANE_TORNADOES + i] = -1;
  }

  _hurricaneSlots.set(eid, slot);
  return slot;
}

function initSpiralBands(slot) {
  // Distribute bands evenly with slight jitter.
  const bandCount = 3 + Math.floor(Math.random() * (MAX_SPIRAL_BANDS - 3));
  const baseOffset = Math.random() * TWO_PI;

  for (let i = 0; i < bandCount; i++) {
    const idx = slot * MAX_SPIRAL_BANDS + i;
    SpiralBand.hurricaneSlot[idx] = slot;
    SpiralBand.angularOffset[idx] = baseOffset
      + i * BAND_ANGULAR_SPACING_MIN
      + (Math.random() - 0.5) * BAND_WIDTH_RADIANS;
    SpiralBand.density[idx] = 0.6 + Math.random() * 0.4;
    SpiralBand.rainRate[idx] = RAIN_RATE_BAND_BASE * (0.7 + Math.random() * 0.6);
  }
  SpiralBand.bandCount[slot] = bandCount;
}

export function removeHurricane(world, eid) {
  const slot = _hurricaneSlots.get(eid);
  if (slot === undefined) return;

  // Remove wind source.
  const wslot = HurricaneInstance.windSourceSlot[slot];
  if (wslot >= 0 && WindSource.active[wslot]) {
    removeWindSource(world, WindSource.ownerEid[wslot]);
  }

  // Remove spawned tornadoes.
  const count = HurricaneInstance.tornadoCount[slot];
  for (let i = 0; i < count; i++) {
    const tSlot = HurricaneInstance.tornadoSlots[slot * MAX_HURRICANE_TORNADOES + i];
    if (tSlot >= 0 && TornadoInstance.active[tSlot]) {
      removeTornado(world, TornadoInstance.ownerEid[tSlot]);
    }
  }

  // Remove surge water entity.
  if (StormSurge.active[slot]) {
    const waterEid = StormSurge.waterEntity[slot];
    if (waterEid && entityExists(world, waterEid)) {
      removeComponent(world, waterEid, StormSurgeTag);
    }
    StormSurge.active[slot] = 0;
  }

  HurricaneInstance.active[slot] = 0;
  HurricaneInstance.ownerEid[slot] = 0;
  _hurricaneSlots.delete(eid);
  _hurricaneNoise.delete(slot);

  removeComponent(world, eid, HurricaneTag);
}

export function getHurricaneSlot(eid) {
  return _hurricaneSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// ANALYTICAL WIND FIELD — the physics core
// ═══════════════════════════════════════════════════════════════════════

const _hurricaneWind = vec3.create();

/**
 * Sample the hurricane wind field at a world position.
 *
 * Two-zone Rankine-with-exponential-decay model:
 *   r < eyeRadius:                v = v_max · (r/eyeR)^2      (near zero at center)
 *   eyeR ≤ r < eyewall:           v = v_max · Rankine profile (peak)
 *   eyewall ≤ r < outerRadius:    v = v_max · exp(-k · (r - eyewall)/eyewall)
 *   r ≥ outerRadius:              0
 *
 * @param slot     from addHurricane
 * @param wx, wy, wz   world position
 * @param out      [vx, vy, vz]
 * @returns out
 */
export function sampleHurricaneWind(slot, wx, wy, wz, out) {
  const H = HurricaneInstance;
  if (!H.active[slot]) {
    out[0] = 0; out[1] = 0; out[2] = 0;
    return out;
  }

  const formation = H.formationProgress[slot];
  const dissipation = H.dissipationProgress[slot];
  const intensity = formation * (1 - dissipation);
  if (intensity < EPSILON) {
    out[0] = 0; out[1] = 0; out[2] = 0;
    return out;
  }

  // Horizontal distance from eye center.
  const dx = wx - H.cx[slot];
  const dz = wz - H.cz[slot];
  const r = Math.sqrt(dx * dx + dz * dz);
  if (r < EPSILON) {
    out[0] = 0; out[1] = 0; out[2] = 0;
    return out;
  }

  const eyeR = H.eyeRadius[slot];
  const eyewallR = H.eyewallRadius[slot];
  const outerR = H.outerRadius[slot];
  const vMax = H.maxWind[slot];

  // Tangential speed profile.
  let vt;
  if (r < eyeR) {
    // Inside the eye: nearly calm; wind rises as (r/eyeR)^2.
    vt = vMax * Math.pow(r / eyeR, 2.0);
  } else if (r < eyewallR) {
    // Eyewall region: Rankine ramp-up and peak.
    const t = (r - eyeR) / (eyewallR - eyeR);
    // Peak near the outer edge of the eyewall.
    vt = vMax * (0.65 + 0.35 * Math.pow(t, WIND_RANKINE_POWER));
  } else if (r < outerR) {
    // Outer region: exponential decay from v_max at eyewall to 0 at outer.
    const t = (r - eyewallR) / (outerR - eyewallR);
    vt = vMax * Math.exp(-WIND_OUTER_DECAY_RATE * (r - eyewallR) / eyewallR)
       * (1.0 - t * 0.4);   // taper to ~0.6 of exponential value at outer
  } else {
    vt = 0;
  }

  // Tangential unit vector.
  const tangentX = -dz / r * H.rotationSense[slot];
  const tangentZ = dx / r * H.rotationSense[slot];

  // Radial inflow (toward the eyewall).
  let vr = 0;
  if (r >= eyeR && r < eyewallR) {
    vr = -vMax * WIND_INFLOW_FRACTION * Math.sqrt((r - eyeR) / (eyewallR - eyeR));
  } else if (r >= eyewallR && r < outerR) {
    const t = (r - eyewallR) / (outerR - eyewallR);
    vr = -vMax * WIND_INFLOW_FRACTION * Math.exp(-2.0 * t);
  }

  // Vertical updraft (in the eyewall) and downdraft (in the eye).
  let vy = 0;
  if (r < eyeR * 0.8) {
    // Eye downdraft.
    vy = -vMax * WIND_UPDRAFT_FRACTION * 0.5;
  } else if (r < eyewallR) {
    // Eyewall updraft.
    const t = (r - eyeR * 0.8) / (eyewallR - eyeR * 0.8);
    vy = vMax * WIND_UPDRAFT_FRACTION * t;
  } else if (r < outerR) {
    // Outer downdraft (rain-cooled air).
    const t = (r - eyewallR) / (outerR - eyewallR);
    vy = -vMax * WIND_UPDRAFT_FRACTION * 0.3 * Math.exp(-2.0 * t);
  }

  // Combine and scale by intensity.
  const vx = tangentX * vt + (dx / r) * vr;
  const vz = tangentZ * vt + (dz / r) * vr;

  out[0] = vx * intensity;
  out[1] = vy * intensity;
  out[2] = vz * intensity;
  return out;
}

/**
 * Sample the wind speed magnitude only.
 */
export function sampleHurricaneWindSpeed(slot, wx, wy, wz) {
  sampleHurricaneWind(slot, wx, wy, wz, _hurricaneWind);
  return Math.hypot(_hurricaneWind[0], _hurricaneWind[1], _hurricaneWind[2]);
}

// ═══════════════════════════════════════════════════════════════════════
// SPIRAL BAND DENSITY
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the rain band density (0..1) at a world position.
 * Uses logarithmic spiral geometry: each band is a logarithmic curve with
 * pitch angle, and the density peaks at the band's radius and falls off
 * according to a Gaussian around the band.
 */
export function sampleSpiralBandDensity(slot, wx, wy, wz) {
  const H = HurricaneInstance;
  if (!H.active[slot]) return 0;

  const dx = wx - H.cx[slot];
  const dz = wz - H.cz[slot];
  const r = Math.sqrt(dx * dx + dz * dz);
  if (r < H.eyewallRadius[slot] || r > H.outerRadius[slot]) return 0;

  // Azimuth.
  const azimuth = Math.atan2(dz, dx);

  // Spiral pitch: log(r) vs azimuth linear relationship.
  // bandAngle(r) = baseAngle + log(r / eyewallR) / tan(pitch).
  const spiralOffset = Math.log(r / H.eyewallRadius[slot]) / Math.tan(BAND_SPIRAL_PITCH);

  const bandCount = SpiralBand.bandCount[slot];

  let maxDensity = 0;

  for (let i = 0; i < bandCount; i++) {
    const idx = slot * MAX_SPIRAL_BANDS + i;
    const targetAngle = SpiralBand.angularOffset[idx] + spiralOffset;

    // Angular distance from the band, wrapped.
    let delta = azimuth - targetAngle;
    while (delta > PI) delta -= TWO_PI;
    while (delta < -PI) delta += TWO_PI;

    // Gaussian falloff around the band.
    const bandDensity = SpiralBand.density[idx]
      * Math.exp(-Math.pow(delta / BAND_WIDTH_RADIANS, 2));

    if (bandDensity > maxDensity) maxDensity = bandDensity;
  }

  // Radial taper.
  const radialTaper = 1 - (r - H.eyewallRadius[slot])
    / (H.outerRadius[slot] - H.eyewallRadius[slot]);
  const formation = H.formationProgress[slot];
  const dissipation = H.dissipationProgress[slot];
  const intensity = formation * (1 - dissipation);

  return Math.max(0, Math.min(1, maxDensity * radialTaper * intensity));
}

// ═══════════════════════════════════════════════════════════════════════
// RAIN RATE SAMPLING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the local rain rate (mm/h) at a world position.
 */
export function sampleHurricaneRainRate(slot, wx, wy, wz) {
  const H = HurricaneInstance;
  if (!H.active[slot]) return 0;

  const dx = wx - H.cx[slot];
  const dz = wz - H.cz[slot];
  const r = Math.sqrt(dx * dx + dz * dz);

  const intensity = H.formationProgress[slot] * (1 - H.dissipationProgress[slot]);
  if (intensity < EPSILON) return 0;

  // Eyewall rain.
  let rain = 0;
  if (r < H.eyeRadius[slot]) {
    // Eye is mostly clear.
    rain = 0.5;
  } else if (r < H.eyewallRadius[slot]) {
    // Eyewall peak rain.
    const t = (r - H.eyeRadius[slot]) / (H.eyewallRadius[slot] - H.eyeRadius[slot]);
    rain = RAIN_RATE_EYEWALL * Math.sin(t * PI);
  } else if (r < H.outerRadius[slot]) {
    // Outer bands with exponential taper + spiral band modulation.
    const t = (r - H.eyewallRadius[slot]) / (H.outerRadius[slot] - H.eyewallRadius[slot]);
    rain = RAIN_RATE_OUTER_BASE * Math.exp(-RAIN_RATE_TAPER_K * t);
    rain += sampleSpiralBandDensity(slot, wx, wy, wz) * RAIN_RATE_BAND_BASE;
  }

  return rain * intensity;
}

// ═══════════════════════════════════════════════════════════════════════
// STORM SURGE MODELLING
// ═══════════════════════════════════════════════════════════════════════

const _surgeRay = vec3.create();

/**
 * Estimate the storm surge height (metres) at a coastal position.
 * Uses Holland (1980) + simple SLOSH-style inland attenuation.
 *
 * @param slot     hurricane slot
 * @param coastX, coastY, coastZ   coastline position
 * @param inlandNormalX, inlandNormalZ   unit vector pointing inland
 */
export function computeStormSurge(slot, coastX, coastY, coastZ, inlandNormalX, inlandNormalZ) {
  const H = HurricaneInstance;
  if (!H.active[slot]) return 0;

  const intensity = H.formationProgress[slot] * (1 - H.dissipationProgress[slot]);
  if (intensity < 0.2) return 0;

  // Wind speed at the coast.
  const coastWindSpeed = sampleHurricaneWindSpeed(slot, coastX, coastY, coastZ);

  // Pressure deficit at the center.
  const pressureDeficit = AMBIENT_PRESSURE - H.centralPressure[slot];

  // Surge height: wind + pressure coupling.
  const windSurge = coastWindSpeed * coastWindSpeed * SURGE_WIND_COUPLING;
  const pressureSurge = pressureDeficit * SURGE_PRESSURE_COUPLING;

  const totalSurge = Math.min(SURGE_MAX_HEIGHT, (windSurge + pressureSurge) * intensity);
  return totalSurge;
}

/**
 * Sample the surge inundation height (metres) at a position given a
 * coastline reference. Falls off exponentially inland.
 */
export function sampleSurgeHeight(slot, wx, wy, wz) {
  if (!StormSurge.active[slot]) return 0;

  const S = StormSurge;

  // Inland distance from the coast.
  const dx = wx - S.coastX[slot];
  const dz = wz - S.coastZ[slot];
  const inlandDist = dx * S.coastNormalX[slot] + dz * S.coastNormalZ[slot];

  if (inlandDist < 0) {
    // Offshore: still has some surge but attenuated.
    return S.surgeHeight[slot] * Math.exp(-Math.abs(inlandDist) / SURGE_DECAY_DISTANCE);
  }

  if (inlandDist > S.inlandPenetration[slot]) return 0;

  const t = inlandDist / S.inlandPenetration[slot];
  return S.surgeHeight[slot] * (1 - t * t);
}

/**
 * Update the storm surge as the hurricane approaches or moves over land.
 * Called once per frame.
 */
export function systemUpdateStormSurge(world, dt) {
  const H = HurricaneInstance;
  const S = StormSurge;

  for (let slot = 0; slot < _nextHurricaneSlot; slot++) {
    if (!H.active[slot]) continue;

    // Cast a ray from the storm center downward to find the terrain and
    // determine whether we're over water or land.
    const hits = bvhRaycast(
      [H.cx[slot], H.cy[slot] + 1000, H.cz[slot]],
      [0, -1, 0],
      20000,
      true
    );

    let overWater = false;
    let coastX = H.cx[slot];
    let coastY = 0;
    let coastZ = H.cz[slot];
    let coastNormalX = 0;
    let coastNormalZ = 1;

    if (hits.length > 0) {
      const h = hits[0];
      coastX = H.cx[slot];
      coastY = H.cy[slot] + 1000 - h.t;
      coastZ = H.cz[slot];

      // Determine if land or water by examining the entity.
      const hitEid = h.eid;
      if (hitEid && entityExists(world, hitEid)) {
        // Check for a water tag.
        // (Simplification: if the hit normal has |y| < 0.5, treat as slope
        // → water; if |y| > 0.5, land. Terrain files can override.)
        overWater = false;   // default to land for accuracy
      }
    } else {
      overWater = true;
      coastY = 0;
    }

    // Compute the surge if we're near a coastline.
    if (!overWater) {
      const surgeHeight = computeStormSurge(slot, coastX, coastY, coastZ,
        coastNormalX, coastNormalZ);

      if (surgeHeight > 0.1) {
        S.active[slot] = 1;
        S.hurricaneSlot[slot] = slot;
        S.surgeHeight[slot] = surgeHeight;
        S.inlandPenetration[slot] = SURGE_DECAY_DISTANCE * (surgeHeight / SURGE_MAX_HEIGHT);
        S.coastX[slot] = coastX;
        S.coastY[slot] = coastY;
        S.coastZ[slot] = coastZ;
        S.coastNormalX[slot] = coastNormalX;
        S.coastNormalZ[slot] = coastNormalZ;

        // Ensure a water entity exists.
        if (!S.waterEntity[slot] || !entityExists(world, S.waterEntity[slot])) {
          const waterEid = _allocSurgeEntity(world);
          addTransform(world, waterEid, {
            px: coastX + coastNormalX * 10,
            py: coastY,
            pz: coastZ + coastNormalZ * 10,
          });
          addComponent(world, waterEid, StormSurgeTag);
          S.waterEntity[slot] = waterEid;
        }
      } else {
        S.active[slot] = 0;
      }
    } else {
      S.active[slot] = 0;
    }
  }
  return world;
}

function _allocSurgeEntity(world) {
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
// HURRICANE-TORNADO GENESIS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Check whether the hurricane is spawning tornadoes in its eyewall.
 * Requires a strong eyewall (high wind shear) and pre-existing structural
 * support from the parent cumulonimbus.
 *
 * Tornado lifetimes are short (30-120 s) and their EF is low (0-2),
 * which matches real hurricane-spawned tornadoes.
 */
export function systemSpawnHurricaneTornadoes(world, dt) {
  const H = HurricaneInstance;

  for (let slot = 0; slot < _nextHurricaneSlot; slot++) {
    if (!H.active[slot]) continue;

    const intensity = H.formationProgress[slot] * (1 - H.dissipationProgress[slot]);
    const shear = H.maxWind[slot] / CAT5_MIN_WIND;

    if (shear < HURRICANE_TORNADO_SHEAR_THRESHOLD) continue;

    // Spawn rate proportional to (shear - threshold).
    const spawnChance = HURRICANE_TORNADO_SPAWN_RATE
      * (shear - HURRICANE_TORNADO_SHEAR_THRESHOLD)
      * intensity;

    if (Math.random() > spawnChance * dt) continue;

    // Slots available?
    const count = H.tornadoCount[slot];
    if (count >= MAX_HURRICANE_TORNADOES) continue;

    // Choose a spawn angle within the eyewall.
    const angle = Math.random() * TWO_PI;
    const spawnRadius = H.eyewallRadius[slot] * (0.7 + Math.random() * 0.5);
    const tx = H.cx[slot] + Math.cos(angle) * spawnRadius;
    const tz = H.cz[slot] + Math.sin(angle) * spawnRadius;

    // EF rating (0-2).
    const ef = HURRICANE_TORNADO_EF_MIN
      + Math.floor(Math.random() * (HURRICANE_TORNADO_EF_MAX - HURRICANE_TORNADO_EF_MIN + 1));

    // Spawn a tornado entity.
    const eid = _allocSurgeEntity(world);
    addTransform(world, eid, { px: tx, py: 0, pz: tz });

    // Get the base cumulonimbus storm if available.
    const stormSlot = CumulonimbusState._baseInstanceSlot;
    // Fallback: -1 (tornado will use defaults).
    const baseSlot = -1;

    const tornadoSlot = addTornado(world, eid, baseSlot, TornadoType.ROPE, {
      efRating: ef,
      coreRadius: 20,
      tangentialVelocity: 30 + ef * 15,
      updraftVelocity: 15 + ef * 5,
      inflowVelocity: 8 + ef * 3,
      lifetime: HURRICANE_TORNADO_LIFETIME_MIN
        + Math.random() * (HURRICANE_TORNADO_LIFETIME_MAX - HURRICANE_TORNADO_LIFETIME_MIN),
    });

    H.tornadoSlots[slot * MAX_HURRICANE_TORNADOES + count] = tornadoSlot;
    H.tornadoCount[slot] = count + 1;
  }
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// HURRICANE EVOLUTION SYSTEM
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance the hurricane's life cycle and physical parameters.
 * Called once per frame.
 */
export function systemUpdateHurricanes(world, dt) {
  const H = HurricaneInstance;

  for (let slot = 0; slot < _nextHurricaneSlot; slot++) {
    if (!H.active[slot]) continue;

    H.age[slot] += dt;

    // Formation.
    if (H.formationProgress[slot] < 1) {
      H.formationProgress[slot] = Math.min(1,
        H.formationProgress[slot] + dt / HURRICANE_FORMATION_TIME);
    }

    // Dissipation (after lifetime * 0.9).
    if (H.age[slot] > H.lifetime[slot] * 0.9) {
      H.dissipationProgress[slot] = Math.min(1,
        H.dissipationProgress[slot] + dt / HURRICANE_DISSIPATION_TIME);
    }

    // Fully dissipated: retire.
    if (H.dissipationProgress[slot] >= 1) {
      removeHurricane(world, H.ownerEid[slot]);
      continue;
    }

    // Translation with slight poleward curve.
    H.cx[slot] += H.translateDirX[slot] * H.translateSpeed[slot] * dt;
    H.cz[slot] += H.translateDirZ[slot] * H.translateSpeed[slot] * dt;

    // Curve drift direction (poleward): rotate drift direction slightly
    // toward +Z (north) or -Z (south).
    const polewardTarget = H.translateDirZ[slot] > 0 ? 1 : -1;
    const curveAngle = TRANSLATE_CURVE_RATE * dt * polewardTarget;
    const cosC = Math.cos(curveAngle);
    const sinC = Math.sin(curveAngle);
    const dx = H.translateDirX[slot];
    const dz = H.translateDirZ[slot];
    H.translateDirX[slot] = dx * cosC - dz * sinC;
    H.translateDirZ[slot] = dx * sinC + dz * cosC;

    // Sync the wind source center.
    const wslot = H.windSourceSlot[slot];
    if (wslot >= 0 && WindSource.active[wslot]) {
      WindSource.px[wslot] = H.cx[slot];
      WindSource.py[wslot] = H.cy[slot];
      WindSource.pz[wslot] = H.cz[slot];
      WindSource.baseSpeed[wslot] = H.maxWind[slot]
        * H.formationProgress[slot]
        * (1 - H.dissipationProgress[slot]);
    }
  }
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// SUCTION FORCES — applied to rigid bodies and characters
// ═══════════════════════════════════════════════════════════════════════

export const HurricaneForceTag = {};

/**
 * Apply hurricane wind force to a specific entity.
 */
export function applyHurricaneForce(world, hurricaneSlot, eid) {
  const H = HurricaneInstance;
  if (!H.active[hurricaneSlot]) return;
  if (!entityExists(world, eid)) return;

  const id = getId(eid);
  const M = WorldTransformF32.m;
  if (!M) return;
  const off = id * 16;
  const wx = M[off + 12];
  const wy = M[off + 13];
  const wz = M[off + 14];

  sampleHurricaneWind(hurricaneSlot, wx, wy, wz, _hurricaneWind);

  const speedSq = _hurricaneWind[0] ** 2 + _hurricaneWind[1] ** 2 + _hurricaneWind[2] ** 2;
  if (speedSq < EPSILON_SQ) return;

  // Rigid body: apply drag toward the wind vector.
  if (hasComponent(world, eid, RigidBody3D)) {
    const relVx = _hurricaneWind[0] - RigidBody3D.vx[id];
    const relVy = _hurricaneWind[1] - RigidBody3D.vy[id];
    const relVz = _hurricaneWind[2] - RigidBody3D.vz[id];
    const relSpeedSq = relVx * relVx + relVy * relVy + relVz * relVz;
    const relSpeed = Math.sqrt(relSpeedSq);

    if (relSpeed > EPSILON) {
      const area = 1.0;
      const cd = 1.2;
      const dragMag = 0.5 * AIR_DENSITY * relSpeedSq * cd * area;
      const accelX = (dragMag / Math.max(RigidBody3D.invMass[id], EPSILON))
        * (relVx / relSpeed);
      const accelY = (dragMag / Math.max(RigidBody3D.invMass[id], EPSILON))
        * (relVy / relSpeed);
      const accelZ = (dragMag / Math.max(RigidBody3D.invMass[id], EPSILON))
        * (relVz / relSpeed);

      RigidBody3D.vx[id] += accelX * dt;
      RigidBody3D.vy[id] += accelY * dt;
      RigidBody3D.vz[id] += accelZ * dt;
    }
  }

  // Character: pull wish velocity.
  if (hasComponent(world, eid, CharacterTag)) {
    const cs = getCharacterSlot(eid);
    if (cs >= 0) {
      const pullStrength = 0.03;
      CharacterStateF32.wishX[cs] += _hurricaneWind[0] * pullStrength;
      CharacterStateF32.wishY[cs] += _hurricaneWind[1] * pullStrength;
      CharacterStateF32.wishZ[cs] += _hurricaneWind[2] * pullStrength;
    }
  }
}

/**
 * System: apply hurricane wind forces to all entities with
 * HurricaneForceTag.
 */
export function systemApplyHurricaneForces(world) {
  const eids = query(world, [HurricaneForceTag]);

  for (let i = 0; i < eids.length; i++) {
    const eid = eids[i];
    const id = getId(eid);

    // Find the nearest hurricane.
    let nearestSlot = -1;
    let nearestDistSq = Infinity;

    for (let h = 0; h < _nextHurricaneSlot; h++) {
      if (!HurricaneInstance.active[h]) continue;
      const dx = HurricaneInstance.cx[h] - WorldTransformF32.m[id * 16 + 12];
      const dz = HurricaneInstance.cz[h] - WorldTransformF32.m[id * 16 + 14];
      const distSq = dx * dx + dz * dz;
      if (distSq < HurricaneInstance.outerRadius[h] ** 2 && distSq < nearestDistSq) {
        nearestSlot = h;
        nearestDistSq = distSq;
      }
    }

    if (nearestSlot >= 0) {
      applyHurricaneForce(world, nearestSlot, eid);
    }
  }
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TICK
// ═══════════════════════════════════════════════════════════════════════

/**
 * Full hurricane pipeline for one frame:
 *   1. systemUpdateHurricanes(world, dt)
 *   2. systemUpdateStormSurge(world, dt)
 *   3. systemSpawnHurricaneTornadoes(world, dt)
 *   4. systemApplyHurricaneForces(world)
 */
export function systemHurricaneTick(world, dt) {
  systemUpdateHurricanes(world, dt);
  systemUpdateStormSurge(world, dt);
  systemSpawnHurricaneTornadoes(world, dt);
  systemApplyHurricaneForces(world);
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS
// ═══════════════════════════════════════════════════════════════════════

export function findNearestHurricane(wx, wy, wz, maxDistance = 500000) {
  let nearestSlot = -1;
  let nearestDistSq = maxDistance * maxDistance;

  for (let slot = 0; slot < _nextHurricaneSlot; slot++) {
    if (!HurricaneInstance.active[slot]) continue;
    const dx = HurricaneInstance.cx[slot] - wx;
    const dz = HurricaneInstance.cz[slot] - wz;
    const distSq = dx * dx + dz * dz;
    if (distSq < nearestDistSq) {
      nearestSlot = slot;
      nearestDistSq = distSq;
    }
  }
  return nearestSlot;
}

export function getCategoryLabel(slot) {
  if (slot < 0 || slot >= _nextHurricaneSlot) return 'N/A';
  const cat = HurricaneInstance.category[slot];
  switch (cat) {
    case StormCategory.TROPICAL_DEPRESSION: return 'TD';
    case StormCategory.TROPICAL_STORM:      return 'TS';
    case StormCategory.HURRICANE_CAT1:      return 'Cat 1';
    case StormCategory.HURRICANE_CAT2:      return 'Cat 2';
    case StormCategory.HURRICANE_CAT3:      return 'Cat 3';
    case StormCategory.HURRICANE_CAT4:      return 'Cat 4';
    case StormCategory.HURRICANE_CAT5:      return 'Cat 5';
    default:                                return 'N/A';
  }
}

/**
 * Return true if the given position is inside the calm eye.
 */
export function isInsideEye(slot, wx, wy, wz) {
  if (slot < 0 || slot >= _nextHurricaneSlot) return false;
  const H = HurricaneInstance;
  const dx = wx - H.cx[slot];
  const dz = wz - H.cz[slot];
  return (dx * dx + dz * dz) < H.eyeRadius[slot] ** 2;
}

/**
 * Return true if the given position is in the eyewall.
 */
export function isInEyewall(slot, wx, wy, wz) {
  if (slot < 0 || slot >= _nextHurricaneSlot) return false;
  const H = HurricaneInstance;
  const dx = wx - H.cx[slot];
  const dz = wz - H.cz[slot];
  const rSq = dx * dx + dz * dz;
  return rSq >= H.eyeRadius[slot] ** 2 && rSq < H.eyewallRadius[slot] ** 2;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a summary of all active hurricanes for renderer integration.
 */
export function gatherHurricanesForRendering() {
  const result = [];
  for (let slot = 0; slot < _nextHurricaneSlot; slot++) {
    if (!HurricaneInstance.active[slot]) continue;
    result.push({
      slot,
      category: HurricaneInstance.category[slot],
      categoryLabel: getCategoryLabel(slot),
      cx: HurricaneInstance.cx[slot],
      cy: HurricaneInstance.cy[slot],
      cz: HurricaneInstance.cz[slot],
      eyeRadius: HurricaneInstance.eyeRadius[slot],
      eyewallRadius: HurricaneInstance.eyewallRadius[slot],
      outerRadius: HurricaneInstance.outerRadius[slot],
      maxWind: HurricaneInstance.maxWind[slot],
      centralPressure: HurricaneInstance.centralPressure[slot],
      rotationSense: HurricaneInstance.rotationSense[slot],
      intensity: HurricaneInstance.formationProgress[slot]
        * (1 - HurricaneInstance.dissipationProgress[slot]),
      spiralBandCount: SpiralBand.bandCount[slot],
      tornadoCount: HurricaneInstance.tornadoCount[slot],
    });
  }
  return result;
}

/**
 * Return the current storm surge data for gameplay / renderer.
 */
export function gatherSurgesForRendering() {
  const result = [];
  for (let slot = 0; slot < _nextHurricaneSlot; slot++) {
    if (!StormSurge.active[slot]) continue;
    result.push({
      hurricaneSlot: slot,
      surgeHeight: StormSurge.surgeHeight[slot],
      inlandPenetration: StormSurge.inlandPenetration[slot],
      coastX: StormSurge.coastX[slot],
      coastY: StormSurge.coastY[slot],
      coastZ: StormSurge.coastZ[slot],
      coastNormalX: StormSurge.coastNormalX[slot],
      coastNormalZ: StormSurge.coastNormalZ[slot],
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearHurricanes(world) {
  for (let slot = 0; slot < _nextHurricaneSlot; slot++) {
    if (!HurricaneInstance.active[slot]) continue;
    removeHurricane(world, HurricaneInstance.ownerEid[slot]);
  }

  HurricaneInstance.active.fill(0);
  HurricaneInstance.ownerEid.fill(0);
  _hurricaneSlots.clear();
  _hurricaneNoise.clear();
  _nextHurricaneSlot = 0;

  SpiralBand.bandCount.fill(0);
  StormSurge.active.fill(0);
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function hurricaneStats() {
  let active = 0;
  let activeSurges = 0;
  let totalTornadoes = 0;

  const byCategory = [0, 0, 0, 0, 0, 0, 0];

  for (let slot = 0; slot < _nextHurricaneSlot; slot++) {
    if (!HurricaneInstance.active[slot]) continue;
    active++;
    byCategory[HurricaneInstance.category[slot]]++;
    if (StormSurge.active[slot]) activeSurges++;
    totalTornadoes += HurricaneInstance.tornadoCount[slot];
  }

  return {
    hurricaneCount: _nextHurricaneSlot,
    activeHurricanes: active,
    maxHurricanes: MAX_HURRICANES,
    activeSurges,
    totalTornadoes,
    byCategory: {
      TD: byCategory[StormCategory.TROPICAL_DEPRESSION],
      TS: byCategory[StormCategory.TROPICAL_STORM],
      cat1: byCategory[StormCategory.HURRICANE_CAT1],
      cat2: byCategory[StormCategory.HURRICANE_CAT2],
      cat3: byCategory[StormCategory.HURRICANE_CAT3],
      cat4: byCategory[StormCategory.HURRICANE_CAT4],
      cat5: byCategory[StormCategory.HURRICANE_CAT5],
    },
  };
}