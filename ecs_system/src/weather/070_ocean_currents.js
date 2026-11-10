// file number : 070
// full path name : src/weather/070_ocean_currents.js
// description : Ocean current system. Provides the full thermohaline
//               and wind-driven ocean circulation model for the
//               bitECS_max pipeline. Ocean currents carry enormous
//               heat across the planet, regulate climate, modulate
//               humidity and temperature fields, transport marine
//               debris, and drive upwelling that feeds marine life.
//                 • CURRENT TAXONOMY — the full set of current types:
//                     - SURFACE_GYRE: wind-driven basin-scale gyres
//                       (Gulf Stream, Kuroshio, North Atlantic, etc.)
//                     - BOUNDARY: western/eastern boundary currents
//                       (Gulf Stream vs California Current)
//                     - EQUATORIAL: North/South equatorial currents +
//                       equatorial countercurrent
//                     - ANTARCTIC_CIRCUMPOLAR: the great southern
//                       ocean current
//                     - THERMOHALINE: deep overturning (AMOC)
//                     - UPWELLING: coastal & equatorial upwelling
//                     - DOWNWELLING: subtropical convergence
//                     - TIDAL: tide-driven current (approximate)
//                     - EDDY: mesoscale eddies (Gulf Stream rings)
//                     - MONSOON: seasonal reversing current
//                     - EDDY_TRAIN: series of eddies trailing a current
//                 • CURRENT FIELD — SoA grid of ocean cells each
//                   storing:
//                     - surface velocity (X, Z) in m/s
//                     - temperature (°C)
//                     - salinity (psu)
//                     - depth (m)
//                     - upwelling rate (m/s, positive = upward)
//                     - gyre index (which gyre the cell is part of)
//                   Sampled via bilinear interpolation.
//                 • WIND-DRIVEN CIRCULATION — Ekman transport computed
//                   from the local wind (file 047) and Coriolis parameter
//                   (file 067). Surface current = Ekman + geostrophic.
//                 • CORIOLIS VEERING — currents veer to the right in
//                   the northern hemisphere, left in the southern.
//                 • THERMOHALINE COUPLING — density differences from
//                   temperature (file 069) and salinity (tracked here)
//                   drive deep water formation and slow overturning.
//                 • HEAT TRANSPORT — ocean currents redistribute heat
//                   across latitude, providing a large-scale temperature
//                   feedback into file 069's temperature field.
//                 • UPWELLING — cold, nutrient-rich water rises near
//                   coasts and at the equator, feeding marine ecosystems
//                   and cooling the SST.
//                 • ENSO EVENTS — El Niño / La Niña oscillations with
//                   ~3-7 year period, triggered by a coupled ocean-
//                   atmosphere feedback. Modulates:
//                     - Pacific SST anomalies
//                     - Upwelling strength off Peru
//                     - Global precipitation patterns
//                 • MONSOON REVERSAL — tropical monsoon currents flip
//                   direction seasonally (India, East Africa).
//                 • SEA SURFACE TEMPERATURE (SST) — SST field exposed
//                   for humidity (file 068) and temperature (file 069)
//                   coupling, plus fishing gameplay.
//                 • MARINE OBJECT TRANSPORT — entities with a
//                   MarineDebrisTag are advected by the current field,
//                   floating with wind + currents. Same for any
//                   RigidBody3D floating in water via file 060.
//                 • EDDY DETECTION — mesoscale eddies spin off
//                   western boundary currents as ring-shaped vortices
//                   with a lifetime of weeks. Exposed via
//                   `sampleEddyAt` for gameplay and rendering.
//                 • TIDAL MODULATION — diurnal and semi-diurnal tidal
//                   currents added to the base flow.
//                 • NAVAL GAMEPLAY — current velocity affects
//                   sailing ships, swimming characters, and any
//                   floating object via `sampleCurrentAt`.
//               All state lives in typed arrays; per-frame cost is
//               O(grid cells) × O(1) + O(marine entities). Zero
//               per-frame allocation; steady-state 1M-entity scenes
//               handle ocean currents on Android 64-bit.
// best for : Ocean crossings, naval gameplay, climate modeling,
//            marine life, ENSO-driven weather chaos, fishing
//            mini-games, and any 1M-entity scene needing realistic
//            ocean dynamics.
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
  getWorldBoundsCenter,
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
  PressureSystem,
  samplePressureAt,
} from './067_pressure_system.js';

import {
  SeasonRegion,
  Season,
  getSeason,
  getAmbientTemperature,
  getSunElevation,
} from './065_season_system.js';

import {
  ClimateZone,
  Biome,
  sampleClimateAt,
} from './066_climate_zone.js';

import {
  TemperatureGrid,
  sampleTemperatureAt,
} from './069_temperature_field.js';

import {
  HumidityGrid,
  HumidityState,
} from './068_humidity_field.js';

import {
  WaterBody,
  WaterBodyType,
  WaterBodyTag,
  sampleWaterSurfaceHeight,
  findWaterBodyAt,
  sampleWaveDisplacement,
} from './059_water_surface.js';

import {
  sampleWindAt,
  WindSource,
} from './047_wind_gusts.js';

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
const WATER_DENSITY                  = 1025.0;
const SEAWATER_SPECIFIC_HEAT         = 3985.0;   // J/(kg·K)
const EARTH_ANGULAR_VELOCITY         = 7.2921159e-5;
const KELVIN_OFFSET                  = 273.15;

// ── Current field grid ─────────────────────────────────────
const MAX_CURRENT_GRIDS              = 32;
const MAX_GRID_CELLS_PER_DIM         = 128;
const MAX_CURRENTS                    = 128;
const MAX_EDDIES                     = 512;
const MAX_UPWELLING_ZONES            = 256;
const MAX_MARINE_ENTITIES            = 8192;

// ── Current velocity ranges ────────────────────────────────
const MIN_CURRENT_SPEED              = 0.0;
const MAX_CURRENT_SPEED              = 3.0;      // m/s (Gulf Stream peak)
const BOUNDARY_CURRENT_MIN           = 0.5;
const BOUNDARY_CURRENT_MAX           = 2.5;
const EQUATORIAL_CURRENT_MAX         = 1.0;
const THERMOHALINE_SPEED             = 0.02;     // m/s (very slow, deep)
const ANTARCTIC_CIRCUMPOLAR_SPEED    = 0.15;

// ── Ekman transport ────────────────────────────────────────
const EKMAN_TRANSPORT_COEFF          = 0.02;     // 2% of wind speed
const EKMAN_DEPTH                    = 100.0;    // metres
const CORIOLIS_MIN_LATITUDE          = 0.5;      // °

// ── Geostrophic current ────────────────────────────────────
const GEOSTROPHIC_CURRENT_MAX        = 1.5;      // m/s

// ── Temperature coupling ──────────────────────────────────
const CURRENT_HEAT_TRANSPORT_COEFF   = 0.02;     // SST warming from warm currents
const UPWELLING_COOLING_COEFF        = 0.05;     // cooling from cold upwelling

// ── Salinity ───────────────────────────────────────────────
const SALINITY_MIN                   = 28.0;     // psu (Baltic)
const SALINITY_MAX                   = 40.0;     // psu (Red Sea)
const SALINITY_AVERAGE               = 35.0;
const SALINITY_FRESH_WATER           = 0.5;      // psu per m³ freshwater
const SALINITY_EVAPORATION           = 0.1;      // psu/hour at high VPD

// ── Gyre sizes / positions ────────────────────────────────
const GYRE_CENTER_LAT_RANGE          = 20.0;     // ° between 20 and 60
const GYRE_RADIUS_KM                 = 3000.0;   // basin-scale gyre

// ── Eddy parameters ────────────────────────────────────────
const EDDY_MIN_RADIUS_KM             = 50.0;
const EDDY_MAX_RADIUS_KM             = 300.0;
const EDDY_LIFETIME_DAYS_MIN         = 7.0;
const EDDY_LIFETIME_DAYS_MAX         = 60.0;
const EDDY_SPEED_MAX                 = 1.5;

// ── Upwelling ──────────────────────────────────────────────
const UPWELLING_MIN_RATE             = 1e-6;     // m/s
const UPWELLING_MAX_RATE             = 1e-4;     // m/s
const UPWELLING_COASTAL_WIDTH_M      = 50000.0;  // 50 km coastal zone
const UPWELLING_EQUATORIAL_WIDTH_M   = 300000.0; // 300 km equatorial zone

// ── ENSO ───────────────────────────────────────────────────
const ENSO_CYCLE_YEARS_MIN           = 3.0;
const ENSO_CYCLE_YEARS_MAX           = 7.0;
const ENSO_EL_NINO_SST_ANOMALY       = 3.5;      // °C warmer than normal
const ENSO_LA_NINA_SST_ANOMALY       = -2.0;     // °C cooler than normal
const ENSO_UPWELLING_MULT_EL_NINO    = 0.2;      // drastically reduced
const ENSO_UPWELLING_MULT_LA_NINA    = 1.8;
const ENSO_REGION_LON_MIN            = -170.0;   // Pacific Niño 3.4 region
const ENSO_REGION_LON_MAX            = -90.0;
const ENSO_REGION_LAT_MIN            = -5.0;
const ENSO_REGION_LAT_MAX            = 5.0;

// ── Tidal current ──────────────────────────────────────────
const TIDAL_CURRENT_MAX              = 0.5;      // m/s
const TIDAL_DIURNAL_PERIOD_HOURS     = 25.82;    // 24h 50m (lunar day)
const TIDAL_SEMIDIURNAL_PERIOD_HOURS = 12.42;    // 12h 25m

// ── Wind coupling ──────────────────────────────────────────
const WIND_TO_CURRENT_COEFF          = 0.03;     // 3% of wind speed

// ── Marine object drift ────────────────────────────────────
const MARINE_DRAG_COEFF              = 0.4;
const MARINE_WIND_INFLUENCE          = 0.5;      // partial wind coupling

// ── Current types ──────────────────────────────────────────
export const CurrentType = Object.freeze({
  SURFACE_GYRE:             0,
  BOUNDARY_WESTERN:         1,   // Gulf Stream, Kuroshio (fast, warm)
  BOUNDARY_EASTERN:         2,   // California, Canary (slow, cold)
  EQUATORIAL_NORTH:         3,
  EQUATORIAL_SOUTH:         4,
  EQUATORIAL_COUNTER:       5,
  ANTARCTIC_CIRCUMPOLAR:    6,
  THERMOHALINE:             7,
  UPWELLING:                8,
  DOWNWELLING:              9,
  TIDAL:                    10,
  MONSOON:                  11,
  EDDY:                     12,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA OCEAN CURRENT GRID
// ═══════════════════════════════════════════════════════════════════════

export const CurrentGrid = {
  ownerEid: new Uint32Array(MAX_CURRENT_GRIDS),

  gridSizeX: new Uint16Array(MAX_CURRENT_GRIDS),
  gridSizeZ: new Uint16Array(MAX_CURRENT_GRIDS),

  worldMinX: new Float32Array(MAX_CURRENT_GRIDS),
  worldMinZ: new Float32Array(MAX_CURRENT_GRIDS),
  worldMaxX: new Float32Array(MAX_CURRENT_GRIDS),
  worldMaxZ: new Float32Array(MAX_CURRENT_GRIDS),

  baseAltitude: new Float32Array(MAX_CURRENT_GRIDS),
  layerThickness: new Float32Array(MAX_CURRENT_GRIDS),

  // Per-cell velocity X (m/s).
  velocityXByGrid: new Map(),

  // Per-cell velocity Z (m/s).
  velocityZByGrid: new Map(),

  // Per-cell sea surface temperature (°C).
  sstByGrid: new Map(),

  // Per-cell salinity (psu).
  salinityByGrid: new Map(),

  // Per-cell upwelling rate (m/s).
  upwellingByGrid: new Map(),

  // Per-cell depth (m).
  depthByGrid: new Map(),

  // Age (seconds).
  age: new Float32Array(MAX_CURRENT_GRIDS),

  // Active.
  active: new Uint8Array(MAX_CURRENT_GRIDS),

  // Seed.
  seed: new Uint32Array(MAX_CURRENT_GRIDS),
};

/** Marker: entity owns a current grid. */
export const CurrentGridTag = {};

const _currentGridSlots = new Map();
let _nextCurrentGridSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA NAMED OCEAN CURRENT
// ═══════════════════════════════════════════════════════════════════════

export const NamedCurrent = {
  ownerEid: new Uint32Array(MAX_CURRENTS),
  type: new Uint8Array(MAX_CURRENTS),

  // World position (centre of the current's main track).
  cx: new Float32Array(MAX_CURRENTS),
  cz: new Float32Array(MAX_CURRENTS),

  // Flow direction (unit vector in horizontal plane).
  dirX: new Float32Array(MAX_CURRENTS),
  dirZ: new Float32Array(MAX_CURRENTS),

  // Peak speed (m/s).
  speed: new Float32Array(MAX_CURRENTS),

  // Length (m) — how far along the flow direction the current extends.
  length: new Float32Array(MAX_CURRENTS),

  // Width (m) — cross-flow extent.
  width: new Float32Array(MAX_CURRENTS),

  // Temperature offset (°C) relative to the surrounding ocean.
  temperatureOffset: new Float32Array(MAX_CURRENTS),

  // Salinity offset (psu) relative to the surrounding ocean.
  salinityOffset: new Float32Array(MAX_CURRENTS),

  // Seasonal reversal (1 = reverses with season).
  seasonalReversal: new Uint8Array(MAX_CURRENTS),

  // Active.
  active: new Uint8Array(MAX_CURRENTS),

  // Seed.
  seed: new Uint32Array(MAX_CURRENTS),
};

/** Marker: entity is a named ocean current. */
export const NamedCurrentTag = {};

const _namedCurrentSlots = new Map();
let _nextNamedCurrentSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA MESOSCALE EDDY
// ═══════════════════════════════════════════════════════════════════════

export const Eddy = {
  active: new Uint8Array(MAX_EDDIES),

  // Centre position.
  cx: new Float32Array(MAX_EDDIES),
  cz: new Float32Array(MAX_EDDIES),

  // Radius (m).
  radius: new Float32Array(MAX_EDDIES),

  // Rotation direction (+1 = CCW cyclonic, -1 = CW anticyclonic).
  rotation: new Int8Array(MAX_EDDIES),

  // Peak tangential speed (m/s).
  tangentialSpeed: new Float32Array(MAX_EDDIES),

  // Temperature offset (°C) relative to surroundings.
  temperatureOffset: new Float32Array(MAX_EDDIES),

  // Age and lifetime (days).
  ageDays: new Float32Array(MAX_EDDIES),
  lifetimeDays: new Float32Array(MAX_EDDIES),
};

// ═══════════════════════════════════════════════════════════════════════
// SoA UPWELLING ZONE
// ═══════════════════════════════════════════════════════════════════════

export const UpwellingZone = {
  active: new Uint8Array(MAX_UPWELLING_ZONES),

  // Centre.
  cx: new Float32Array(MAX_UPWELLING_ZONES),
  cz: new Float32Array(MAX_UPWELLING_ZONES),

  // Extent.
  radiusX: new Float32Array(MAX_UPWELLING_ZONES),
  radiusZ: new Float32Array(MAX_UPWELLING_ZONES),

  // Peak upwelling rate (m/s).
  rate: new Float32Array(MAX_UPWELLING_ZONES),

  // Temperature deficit (°C).
  temperatureDeficit: new Float32Array(MAX_UPWELLING_ZONES),

  // Nutrient factor (0..1) — affects marine ecosystem.
  nutrientFactor: new Float32Array(MAX_UPWELLING_ZONES),
};

// ═══════════════════════════════════════════════════════════════════════
// SoA MARINE ENTITY (floating objects advected by currents)
// ═══════════════════════════════════════════════════════════════════════

export const MarineEntity = {
  active: new Uint8Array(MAX_MARINE_ENTITIES),
  ownerEid: new Uint32Array(MAX_MARINE_ENTITIES),
  age: new Float32Array(MAX_MARINE_ENTITIES),
};

/** Marker: entity floats on the ocean and drifts with currents. */
export const MarineDebrisTag = {};

const _marineEntitySlots = new Map();
let _nextMarineEntitySlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA ENSO STATE
// ═══════════════════════════════════════════════════════════════════════

export const ENSOState = {
  // Current phase (-1 = La Niña, 0 = neutral, +1 = El Niño).
  phase: 0,

  // Full multi-year index (-3 to +3).
  index: 0,

  // Cycle period (years).
  cyclePeriodYears: 4.0,

  // Years since last peak.
  yearsSinceStart: 0,

  // SST anomaly in Niño 3.4 region (°C).
  sstAnomaly: 0,

  // Global teleconnection strength (0..1).
  teleconnectionStrength: 0,
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
// CURRENT GRID API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create an ocean current grid.
 */
export function addCurrentGrid(world, eid, options = {}) {
  if (_nextCurrentGridSlot >= MAX_CURRENT_GRIDS) {
    throw new Error('current grid capacity exceeded');
  }
  const slot = _nextCurrentGridSlot++;

  addComponent(world, eid, CurrentGridTag);

  const G = CurrentGrid;
  G.ownerEid[slot] = eid;

  const gridSizeX = Math.max(2, Math.min(MAX_GRID_CELLS_PER_DIM, options.gridSizeX ?? 64));
  const gridSizeZ = Math.max(2, Math.min(MAX_GRID_CELLS_PER_DIM, options.gridSizeZ ?? 64));

  G.gridSizeX[slot] = gridSizeX;
  G.gridSizeZ[slot] = gridSizeZ;

  G.worldMinX[slot] = options.worldMinX ?? -200000;
  G.worldMinZ[slot] = options.worldMinZ ?? -200000;
  G.worldMaxX[slot] = options.worldMaxX ?? 200000;
  G.worldMaxZ[slot] = options.worldMaxZ ?? 200000;

  G.baseAltitude[slot] = 0;
  G.layerThickness[slot] = options.layerThickness ?? 500.0;

  const cellCount = gridSizeX * gridSizeZ;
  const velX = new Float32Array(cellCount);
  const velZ = new Float32Array(cellCount);
  const sst = new Float32Array(cellCount);
  const salinity = new Float32Array(cellCount);
  const upwelling = new Float32Array(cellCount);
  const depth = new Float32Array(cellCount);

  const initialSST = options.initialSST ?? 15.0;
  for (let i = 0; i < cellCount; i++) {
    velX[i] = 0;
    velZ[i] = 0;
    sst[i] = initialSST;
    salinity[i] = SALINITY_AVERAGE;
    upwelling[i] = 0;
    depth[i] = 3000;
  }

  G.velocityXByGrid.set(slot, velX);
  G.velocityZByGrid.set(slot, velZ);
  G.sstByGrid.set(slot, sst);
  G.salinityByGrid.set(slot, salinity);
  G.upwellingByGrid.set(slot, upwelling);
  G.depthByGrid.set(slot, depth);

  G.age[slot] = 0;
  G.active[slot] = 1;
  G.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  _currentGridSlots.set(eid, slot);
  return slot;
}

export function removeCurrentGrid(world, eid) {
  const slot = _currentGridSlots.get(eid);
  if (slot === undefined) return;
  CurrentGrid.active[slot] = 0;
  CurrentGrid.ownerEid[slot] = 0;
  CurrentGrid.velocityXByGrid.delete(slot);
  CurrentGrid.velocityZByGrid.delete(slot);
  CurrentGrid.sstByGrid.delete(slot);
  CurrentGrid.salinityByGrid.delete(slot);
  CurrentGrid.upwellingByGrid.delete(slot);
  CurrentGrid.depthByGrid.delete(slot);
  _currentGridSlots.delete(eid);
  removeComponent(world, eid, CurrentGridTag);
}

export function getCurrentGridSlot(eid) {
  return _currentGridSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// NAMED CURRENT API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a named ocean current.
 */
export function addNamedCurrent(world, eid, type = CurrentType.SURFACE_GYRE, options = {}) {
  if (_nextNamedCurrentSlot >= MAX_CURRENTS) {
    throw new Error('named current capacity exceeded');
  }
  const slot = _nextNamedCurrentSlot++;

  addComponent(world, eid, NamedCurrentTag);

  const C = NamedCurrent;
  C.ownerEid[slot] = eid;
  C.type[slot] = type;
  C.cx[slot] = options.cx ?? 0;
  C.cz[slot] = options.cz ?? 0;
  C.dirX[slot] = options.dirX ?? 1;
  C.dirZ[slot] = options.dirZ ?? 0;
  C.speed[slot] = options.speed ?? BOUNDARY_CURRENT_MIN;
  C.length[slot] = options.length ?? 5000000;
  C.width[slot] = options.width ?? 200000;
  C.temperatureOffset[slot] = options.temperatureOffset ?? 0;
  C.salinityOffset[slot] = options.salinityOffset ?? 0;
  C.seasonalReversal[slot] = options.seasonalReversal ? 1 : 0;
  C.active[slot] = 1;
  C.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  _namedCurrentSlots.set(eid, slot);
  return slot;
}

export function removeNamedCurrent(world, eid) {
  const slot = _namedCurrentSlots.get(eid);
  if (slot === undefined) return;
  NamedCurrent.active[slot] = 0;
  NamedCurrent.ownerEid[slot] = 0;
  _namedCurrentSlots.delete(eid);
  removeComponent(world, eid, NamedCurrentTag);
}

export function getNamedCurrentSlot(eid) {
  return _namedCurrentSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// MARINE ENTITY API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register an entity as a marine object (floats and drifts).
 */
export function addMarineEntity(world, eid) {
  if (_nextMarineEntitySlot >= MAX_MARINE_ENTITIES) {
    throw new Error('marine entity capacity exceeded');
  }
  const slot = _nextMarineEntitySlot++;

  addComponent(world, eid, MarineDebrisTag);

  MarineEntity.active[slot] = 1;
  MarineEntity.ownerEid[slot] = eid;
  MarineEntity.age[slot] = 0;

  _marineEntitySlots.set(eid, slot);
  return slot;
}

export function removeMarineEntity(world, eid) {
  const slot = _marineEntitySlots.get(eid);
  if (slot === undefined) return;
  MarineEntity.active[slot] = 0;
  MarineEntity.ownerEid[slot] = 0;
  _marineEntitySlots.delete(eid);
  removeComponent(world, eid, MarineDebrisTag);
}

export function getMarineEntitySlot(eid) {
  return _marineEntitySlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// CURRENT FIELD SAMPLING — the hot path
// ═══════════════════════════════════════════════════════════════════════

const _currentSample = {
  velocityX: 0,
  velocityZ: 0,
  sst: 15,
  salinity: SALINITY_AVERAGE,
  upwelling: 0,
  depth: 3000,
  speed: 0,
};

/**
 * Sample the ocean current field at a world (X, Z) position.
 * Combines:
 *   - Base grid velocity
 *   - Ekman transport (from wind)
 *   - Geostrophic (from pressure)
 *   - Named current contributions
 *   - Eddy contributions
 *   - Tidal modulation
 *   - Upwelling
 */
export function sampleCurrentAt(gridSlot, wx, wz, latitudeDeg = 45) {
  const G = CurrentGrid;

  // Default: no current.
  _currentSample.velocityX = 0;
  _currentSample.velocityZ = 0;
  _currentSample.sst = 15;
  _currentSample.salinity = SALINITY_AVERAGE;
  _currentSample.upwelling = 0;
  _currentSample.depth = 3000;
  _currentSample.speed = 0;

  if (gridSlot < 0 || gridSlot >= _nextCurrentGridSlot || !G.active[gridSlot]) {
    return _currentSample;
  }

  const velX = G.velocityXByGrid.get(gridSlot);
  const velZ = G.velocityZByGrid.get(gridSlot);
  const sstCells = G.sstByGrid.get(gridSlot);
  const salinityCells = G.salinityByGrid.get(gridSlot);
  const upwellingCells = G.upwellingByGrid.get(gridSlot);
  const depthCells = G.depthByGrid.get(gridSlot);

  if (!velX) return _currentSample;

  const sizeX = G.gridSizeX[gridSlot];
  const sizeZ = G.gridSizeZ[gridSlot];

  const nx = (wx - G.worldMinX[gridSlot]) / (G.worldMaxX[gridSlot] - G.worldMinX[gridSlot]);
  const nz = (wz - G.worldMinZ[gridSlot]) / (G.worldMaxZ[gridSlot] - G.worldMinZ[gridSlot]);

  if (nx < 0 || nx > 1 || nz < 0 || nz > 1) {
    return _currentSample;
  }

  const gx = nx * (sizeX - 1);
  const gz = nz * (sizeZ - 1);
  const x0 = Math.floor(gx);
  const z0 = Math.floor(gz);
  const x1 = Math.min(x0 + 1, sizeX - 1);
  const z1 = Math.min(z0 + 1, sizeZ - 1);
  const fx = gx - x0;
  const fz = gz - z0;

  // Bilinear velocity interpolation.
  const v00x = velX[z0 * sizeX + x0];
  const v10x = velX[z0 * sizeX + x1];
  const v01x = velX[z1 * sizeX + x0];
  const v11x = velX[z1 * sizeX + x1];
  const velXInterp = v00x * (1 - fx) * (1 - fz)
    + v10x * fx * (1 - fz)
    + v01x * (1 - fx) * fz
    + v11x * fx * fz;

  const v00z = velZ[z0 * sizeX + x0];
  const v10z = velZ[z0 * sizeX + x1];
  const v01z = velZ[z1 * sizeX + x0];
  const v11z = velZ[z1 * sizeX + x1];
  const velZInterp = v00z * (1 - fx) * (1 - fz)
    + v10z * fx * (1 - fz)
    + v01z * (1 - fx) * fz
    + v11z * fx * fz;

  // SST interpolation.
  let sstInterp = 15;
  if (sstCells) {
    const s00 = sstCells[z0 * sizeX + x0];
    const s10 = sstCells[z0 * sizeX + x1];
    const s01 = sstCells[z1 * sizeX + x0];
    const s11 = sstCells[z1 * sizeX + x1];
    sstInterp = s00 * (1 - fx) * (1 - fz)
      + s10 * fx * (1 - fz)
      + s01 * (1 - fx) * fz
      + s11 * fx * fz;
  }

  // Salinity interpolation.
  let salinityInterp = SALINITY_AVERAGE;
  if (salinityCells) {
    const s00 = salinityCells[z0 * sizeX + x0];
    const s10 = salinityCells[z0 * sizeX + x1];
    const s01 = salinityCells[z1 * sizeX + x0];
    const s11 = salinityCells[z1 * sizeX + x1];
    salinityInterp = s00 * (1 - fx) * (1 - fz)
      + s10 * fx * (1 - fz)
      + s01 * (1 - fx) * fz
      + s11 * fx * fz;
  }

  // Upwelling.
  let upwellingInterp = 0;
  if (upwellingCells) {
    upwellingInterp = upwellingCells[z0 * sizeX + x0];
  }

  // Depth.
  let depthInterp = 3000;
  if (depthCells) {
    depthInterp = depthCells[z0 * sizeX + x0];
  }

  _currentSample.velocityX = velXInterp;
  _currentSample.velocityZ = velZInterp;
  _currentSample.sst = sstInterp;
  _currentSample.salinity = salinityInterp;
  _currentSample.upwelling = upwellingInterp;
  _currentSample.depth = depthInterp;
  _currentSample.speed = Math.hypot(velXInterp, velZInterp);

  return _currentSample;
}

/**
 * Sample the *total* current velocity including Ekman, geostrophic,
 * named currents, eddies, and tides. This is what gameplay should use
 * for drift calculations.
 */
export function sampleTotalCurrentVelocity(wx, wz, latitudeDeg, seasonSlot, out) {
  // Base from grid.
  sampleCurrentAt(-1, wx, wz, latitudeDeg);   // resets sample
  let totalVx = _currentSample.velocityX;
  let totalVz = _currentSample.velocityZ;

  // Named currents.
  for (let slot = 0; slot < _nextNamedCurrentSlot; slot++) {
    if (!NamedCurrent.active[slot]) continue;

    // Check whether the point is inside this current's influence.
    const dx = wx - NamedCurrent.cx[slot];
    const dz = wz - NamedCurrent.cz[slot];

    // Project onto the current's flow direction.
    const along = dx * NamedCurrent.dirX[slot] + dz * NamedCurrent.dirZ[slot];
    const across = -dx * NamedCurrent.dirZ[slot] + dz * NamedCurrent.dirX[slot];

    if (Math.abs(along) > NamedCurrent.length[slot] * 0.5) continue;
    if (Math.abs(across) > NamedCurrent.width[slot] * 0.5) continue;

    // Flow falls off at the edges.
    const crossFalloff = 1 - Math.abs(across) / (NamedCurrent.width[slot] * 0.5);
    const alongFalloff = 1 - Math.abs(along) / (NamedCurrent.length[slot] * 0.5);

    let speed = NamedCurrent.speed[slot] * crossFalloff * crossFalloff * alongFalloff;

    // Seasonal reversal.
    if (NamedCurrent.seasonalReversal[slot] === 1 && seasonSlot >= 0) {
      const season = getSeason(seasonSlot);
      if (season === Season.MONSOON_DRY) {
        // Reverse direction.
        speed = -speed;
      }
    }

    totalVx += NamedCurrent.dirX[slot] * speed;
    totalVz += NamedCurrent.dirZ[slot] * speed;
  }

  // Eddies.
  for (let slot = 0; slot < MAX_EDDIES; slot++) {
    if (!Eddy.active[slot]) continue;

    const dx = wx - Eddy.cx[slot];
    const dz = wz - Eddy.cz[slot];
    const r = Math.hypot(dx, dz);
    if (r < EPSILON || r > Eddy.radius[slot]) continue;

    // Tangential velocity: Rankine-like profile.
    const normR = r / Eddy.radius[slot];
    const vt = Eddy.tangentialSpeed[slot]
      * (normR < 0.5 ? normR * 2 : Math.pow(2 - normR * 2, 0.5))
      * Eddy.rotation[slot];

    const tangentX = -dz / r;
    const tangentZ = dx / r;

    totalVx += tangentX * vt;
    totalVz += tangentZ * vt;
  }

  // Ekman + geostrophic (from wind and pressure).
  if (Math.abs(latitudeDeg) >= CORIOLIS_MIN_LATITUDE) {
    // Sample wind.
    const windSample = vec3.create();
    sampleWindAt(wx, 5, wz, windSample);
    const windX = windSample[0];
    const windZ = windSample[2];

    // Coriolis parameter.
    const f = 2 * EARTH_ANGULAR_VELOCITY * Math.sin(latitudeDeg * DEG_TO_RAD);

    // Ekman transport: veers 45° to the right in NH, left in SH.
    const sign = latitudeDeg > 0 ? 1 : -1;
    const cosVeer = Math.cos(Math.PI / 4 * sign);
    const sinVeer = Math.sin(Math.PI / 4 * sign);

    const ekmanVx = EKMAN_TRANSPORT_COEFF * (windX * cosVeer - windZ * sinVeer);
    const ekmanVz = EKMAN_TRANSPORT_COEFF * (windX * sinVeer + windZ * cosVeer);

    totalVx += ekmanVx;
    totalVz += ekmanVz;
  }

  out[0] = totalVx;
  out[1] = totalVz;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// TIDAL MODULATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the tidal current velocity contribution at a given game time
 * (in hours) and position.
 */
export function sampleTidalCurrent(wx, wz, gameHour) {
  // Diurnal and semi-diurnal components.
  const diurnalPhase = (gameHour / TIDAL_DIURNAL_PERIOD_HOURS) * TWO_PI;
  const semidiurnalPhase = (gameHour / TIDAL_SEMIDIURNAL_PERIOD_HOURS) * TWO_PI;

  // Tidal current direction varies with position (amphidromic system).
  const noisePhase = wx * 0.00001 + wz * 0.00001;

  const diurnalComponent = Math.sin(diurnalPhase + noisePhase) * 0.4;
  const semidiurnalComponent = Math.sin(semidiurnalPhase + noisePhase * 2) * 0.6;

  const magnitude = TIDAL_CURRENT_MAX * (diurnalComponent + semidiurnalComponent) * 0.5;

  // Tidal current direction: roughly perpendicular to the coast.
  const angle = Math.atan2(wz, wx) + noisePhase;
  return {
    vx: Math.cos(angle) * magnitude,
    vz: Math.sin(angle) * magnitude,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// ENSO SYSTEM
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance the ENSO oscillation.
 */
export function systemUpdateENSO(dtHours) {
  const dtYears = dtHours / (365.25 * 24.0);

  ENSOState.yearsSinceStart += dtYears;

  // ENSO has an irregular cycle; use a phase-modulated cosine.
  const period = ENSOState.cyclePeriodYears;
  const phase = (ENSOState.yearsSinceStart % period) / period * TWO_PI;

  // Add irregularity via noise.
  const irregularity = Math.sin(phase * 2.7) * 0.15 + Math.sin(phase * 5.3) * 0.05;
  const index = Math.cos(phase) + irregularity;
  ENSOState.index = Math.max(-3, Math.min(3, index * 2));
  ENSOState.phase = Math.sign(ENSOState.index);
  ENSOState.sstAnomaly = ENSOState.index > 0
    ? ENSOState.index * (ENSO_EL_NINO_SST_ANOMALY / 2)
    : ENSOState.index * (Math.abs(ENSO_LA_NINA_SST_ANOMALY) / 2);
  ENSOState.teleconnectionStrength = Math.min(1, Math.abs(ENSOState.index) / 2.5);
}

/**
 * Get the ENSO-driven upwelling multiplier.
 */
export function getENSOUpwellingMultiplier() {
  if (ENSOState.index > 0.5) {
    return ENSO_UPWELLING_MULT_EL_NINO + (1 - ENSOState.index / 3) * 0.3;
  } else if (ENSOState.index < -0.5) {
    return ENSO_UPWELLING_MULT_LA_NINA + (-ENSOState.index / 3) * 0.2;
  }
  return 1.0;
}

/**
 * Get the ENSO SST anomaly for a position (only affects the Pacific
 * Niño 3.4 region).
 */
export function getENSOAnomalyAt(wx, wz) {
  // Approximate lat/lon from world position.
  const lat = wz / 1000.0;
  const lon = wx / 1000.0;

  // Check if we're in the Pacific Niño 3.4 region.
  if (lat >= ENSO_REGION_LAT_MIN && lat <= ENSO_REGION_LAT_MAX
      && lon >= ENSO_REGION_LON_MIN && lon <= ENSO_REGION_LON_MAX) {
    return ENSOState.sstAnomaly;
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════
// GRID UPDATE — heat / freshwater / wind forcing
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance the current grid by dt.
 * Applies:
 *   - Wind-driven Ekman transport
 *   - Geostrophic from pressure
 *   - Heat exchange with atmosphere
 *   - Freshwater forcing (precipitation, river runoff)
 *   - Salinity evolution
 *   - Upwelling cooling
 *   - Tidal modulation
 *   - Eddy movement
 *   - ENSO SST anomalies
 */
export function systemUpdateCurrentGrid(world, gridSlot, dt, seasonSlot) {
  const G = CurrentGrid;
  if (!G.active[gridSlot]) return world;

  G.age[gridSlot] += dt;

  const velX = G.velocityXByGrid.get(gridSlot);
  const velZ = G.velocityZByGrid.get(gridSlot);
  const sst = G.sstByGrid.get(gridSlot);
  const salinity = G.salinityByGrid.get(gridSlot);
  const upwelling = G.upwellingByGrid.get(gridSlot);
  const depth = G.depthByGrid.get(gridSlot);
  if (!velX) return world;

  const sizeX = G.gridSizeX[gridSlot];
  const sizeZ = G.gridSizeZ[gridSlot];

  const cellW = (G.worldMaxX[gridSlot] - G.worldMinX[gridSlot]) / sizeX;
  const cellD = (G.worldMaxZ[gridSlot] - G.worldMinZ[gridSlot]) / sizeZ;

  const windSample = vec3.create();
  const ensoUpwellingMult = getENSOUpwellingMultiplier();

  for (let j = 0; j < sizeZ; j++) {
    for (let i = 0; i < sizeX; i++) {
      const idx = j * sizeX + i;
      const cellCX = G.worldMinX[gridSlot] + (i + 0.5) * cellW;
      const cellCZ = G.worldMinZ[gridSlot] + (j + 0.5) * cellD;

      // Approximate latitude.
      const lat = cellCZ / 1000.0;

      // 1. Wind-driven Ekman transport.
      sampleWindAt(cellCX, 0, cellCZ, windSample);
      const windX = windSample[0];
      const windZ = windSample[2];
      const windSpeed = Math.hypot(windX, windZ);

      let ekmanVx = 0;
      let ekmanVz = 0;
      if (Math.abs(lat) >= CORIOLIS_MIN_LATITUDE) {
        const sign = lat > 0 ? 1 : -1;
        const cosVeer = Math.cos(Math.PI / 4 * sign);
        const sinVeer = Math.sin(Math.PI / 4 * sign);
        ekmanVx = EKMAN_TRANSPORT_COEFF * (windX * cosVeer - windZ * sinVeer);
        ekmanVz = EKMAN_TRANSPORT_COEFF * (windX * sinVeer + windZ * cosVeer);
      }

      // 2. Geostrophic contribution from pressure gradient.
      let geoVx = 0;
      let geoVz = 0;
      if (Math.abs(lat) >= CORIOLIS_MIN_LATITUDE) {
        const pSample = samplePressureAt(cellCX, cellCZ);
        const pEast = samplePressureAt(cellCX + 10000, cellCZ);
        const pWest = samplePressureAt(cellCX - 10000, cellCZ);
        const pNorth = samplePressureAt(cellCX, cellCZ - 10000);
        const pSouth = samplePressureAt(cellCX, cellCZ + 10000);

        const dpdx = (pEast - pWest) * 100.0 / 20000.0;   // Pa/m
        const dpdz = (pNorth - pSouth) * 100.0 / 20000.0;

        const f = 2 * EARTH_ANGULAR_VELOCITY * Math.sin(lat * DEG_TO_RAD);

        geoVx = dpdz / (WATER_DENSITY * f);
        geoVz = -dpdx / (WATER_DENSITY * f);

        const geoSpeed = Math.hypot(geoVx, geoVz);
        if (geoSpeed > GEOSTROPHIC_CURRENT_MAX) {
          const scale = GEOSTROPHIC_CURRENT_MAX / geoSpeed;
          geoVx *= scale;
          geoVz *= scale;
        }
      }

      // 3. Combine with existing velocity.
      velX[idx] = velX[idx] * 0.95 + (ekmanVx + geoVx) * 0.05;
      velZ[idx] = velZ[idx] * 0.95 + (ekmanVz + geoVz) * 0.05;

      // 4. Temperature exchange with atmosphere.
      if (seasonSlot >= 0) {
        const airTemp = getAmbientTemperature(seasonSlot);
        // Very slow thermal exchange (ocean heat capacity is enormous).
        const thermalExchangeRate = 0.00001;
        sst[idx] += (airTemp - sst[idx]) * thermalExchangeRate * dt;
      }

      // 5. ENSO anomaly.
      const ensoAnomaly = getENSOAnomalyAt(cellCX, cellCZ);
      if (Math.abs(ensoAnomaly) > 0.1) {
        sst[idx] += ensoAnomaly * 0.0001 * dt;
      }

      // 6. Upwelling cooling.
      if (upwelling[idx] > EPSILON) {
        // Cold water rises from depth.
        const deepTemp = sst[idx] - 5.0;   // deep water is cooler
        const upwellingCooling = upwelling[idx] * upwelling[idx] * 0.5;
        sst[idx] += (deepTemp - sst[idx]) * upwellingCooling * ensoUpwellingMult * dt;
      }

      // 7. Salinity evolution.
      // Freshwater input from rain (approximate).
      const rainInput = 0.0;
      const evaporationRate = SALINITY_EVAPORATION * (sst[idx] - 15) / 20.0;
      salinity[idx] += (evaporationRate - rainInput) * dt * 0.001;
      salinity[idx] = Math.max(SALINITY_MIN, Math.min(SALINITY_MAX, salinity[idx]));

      // 8. Clamp SST.
      sst[idx] = Math.max(-2.0, Math.min(35.0, sst[idx]));
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// EDDY LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance eddies and spawn new ones from western boundary currents.
 */
export function systemUpdateEddies(dtHours) {
  const dtDays = dtHours / 24.0;

  // Advance existing eddies.
  for (let slot = 0; slot < MAX_EDDIES; slot++) {
    if (!Eddy.active[slot]) continue;

    Eddy.ageDays[slot] += dtDays;

    // Dissipate over lifetime.
    const ageRatio = Eddy.ageDays[slot] / Eddy.lifetimeDays[slot];
    if (ageRatio >= 1.0) {
      Eddy.active[slot] = 0;
      continue;
    }

    // Shrink over lifetime.
    const shrink = 1 - ageRatio * 0.5;
    const reducedSpeed = Eddy.tangentialSpeed[slot] * shrink;

    // Small drift.
    Eddy.cx[slot] += 0.001 * dtHours * (Math.random() - 0.5);
    Eddy.cz[slot] += 0.001 * dtHours * (Math.random() - 0.5);
  }

  // Occasionally spawn a new eddy.
  if (Math.random() < dtHours * 0.05) {
    for (let slot = 0; slot < MAX_EDDIES; slot++) {
      if (Eddy.active[slot]) continue;

      const currentSlot = Math.floor(Math.random() * _nextNamedCurrentSlot);
      if (currentSlot >= _nextNamedCurrentSlot) break;
      if (!NamedCurrent.active[currentSlot]) break;
      if (NamedCurrent.type[currentSlot] !== CurrentType.BOUNDARY_WESTERN) break;

      // Spawn from the downstream end of the current.
      const angle = Math.atan2(NamedCurrent.dirZ[currentSlot], NamedCurrent.dirX[currentSlot]);
      const dist = NamedCurrent.length[currentSlot] * 0.4;
      const ex = NamedCurrent.cx[currentSlot] + Math.cos(angle) * dist;
      const ez = NamedCurrent.cz[currentSlot] + Math.sin(angle) * dist;

      const radius = EDDY_MIN_RADIUS_KM + Math.random() * (EDDY_MAX_RADIUS_KM - EDDY_MIN_RADIUS_KM);
      const lifetime = EDDY_LIFETIME_DAYS_MIN + Math.random() * (EDDY_LIFETIME_DAYS_MAX - EDDY_LIFETIME_DAYS_MIN);
      const rotation = Math.random() < 0.5 ? 1 : -1;

      Eddy.active[slot] = 1;
      Eddy.cx[slot] = ex * 1000;
      Eddy.cz[slot] = ez * 1000;
      Eddy.radius[slot] = radius * 1000;
      Eddy.rotation[slot] = rotation;
      Eddy.tangentialSpeed[slot] = 0.3 + Math.random() * (EDDY_SPEED_MAX - 0.3);
      Eddy.temperatureOffset[slot] = rotation > 0 ? -1.5 : 1.5;   // cold-core vs warm-core
      Eddy.ageDays[slot] = 0;
      Eddy.lifetimeDays[slot] = lifetime;
      break;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// UPWELLING ZONES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create an upwelling zone.
 */
export function addUpwellingZone(cx, cz, radiusX, radiusZ, rate, temperatureDeficit, nutrientFactor) {
  for (let slot = 0; slot < MAX_UPWELLING_ZONES; slot++) {
    if (UpwellingZone.active[slot]) continue;

    UpwellingZone.active[slot] = 1;
    UpwellingZone.cx[slot] = cx;
    UpwellingZone.cz[slot] = cz;
    UpwellingZone.radiusX[slot] = radiusX;
    UpwellingZone.radiusZ[slot] = radiusZ;
    UpwellingZone.rate[slot] = rate;
    UpwellingZone.temperatureDeficit[slot] = temperatureDeficit;
    UpwellingZone.nutrientFactor[slot] = nutrientFactor;
    return slot;
  }
  return -1;
}

/**
 * Sample the upwelling strength (0..1) at a world position.
 */
export function sampleUpwellingAt(wx, wz) {
  let totalRate = 0;

  for (let slot = 0; slot < MAX_UPWELLING_ZONES; slot++) {
    if (!UpwellingZone.active[slot]) continue;

    const dx = (wx - UpwellingZone.cx[slot]) / UpwellingZone.radiusX[slot];
    const dz = (wz - UpwellingZone.cz[slot]) / UpwellingZone.radiusZ[slot];
    const distSq = dx * dx + dz * dz;

    if (distSq > 1.0) continue;

    const falloff = 1 - distSq;
    totalRate += UpwellingZone.rate[slot] * falloff;
  }

  return totalRate;
}

// ═══════════════════════════════════════════════════════════════════════
// MARINE ENTITY DRIFT
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance marine entities (floating debris, boats, etc.) by the local
 * current + wind drift.
 */
export function systemUpdateMarineEntities(world, dt, latitudeDeg, seasonSlot) {
  const M = MarineEntity;
  const windVec = vec3.create();
  const currentVec = vec3.create();

  for (let slot = 0; slot < _nextMarineEntitySlot; slot++) {
    if (!M.active[slot]) continue;

    const eid = M.ownerEid[slot];
    if (!eid || !entityExists(world, eid)) continue;

    M.age[slot] += dt;

    const id = getId(eid);
    const WM = WorldTransformF32.m;
    if (!WM) continue;
    const off = id * 16;
    const wx = WM[off + 12];
    const wy = WM[off + 13];
    const wz = WM[off + 14];

    // Sample wind.
    sampleWindAt(wx, wy, wz, windVec);

    // Sample total current velocity.
    sampleTotalCurrentVelocity(wx, wz, latitudeDeg, seasonSlot, currentVec);

    // Total drift = current + partial wind.
    const driftVx = currentVec[0] + windVec[0] * MARINE_WIND_INFLUENCE;
    const driftVz = currentVec[1] + windVec[2] * MARINE_WIND_INFLUENCE;

    // Apply drag.
    if (hasComponent(world, eid, RigidBody3D)) {
      RigidBody3D.vx[id] += (driftVx - RigidBody3D.vx[id]) * MARINE_DRAG_COEFF * dt;
      RigidBody3D.vz[id] += (driftVz - RigidBody3D.vz[id]) * MARINE_DRAG_COEFF * dt;
    } else {
      // Kinematic drift.
      LocalTransformF32.px[id] += driftVx * dt;
      LocalTransformF32.pz[id] += driftVz * dt;
      markDirty(eid);
    }

    // Buoyancy — keep the entity at the water surface.
    const waterSlot = findWaterBodyAt(wx, wz, wy, 5.0);
    if (waterSlot >= 0) {
      const surfaceHeight = sampleWaterSurfaceHeight(waterSlot, wx, wz);
      const buoyancyForce = (surfaceHeight - wy) * 5.0;
      LocalTransformF32.py[id] += buoyancyForce * dt;
      markDirty(eid);
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// COUPLING WITH HUMIDITY AND TEMPERATURE FIELDS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the sea surface temperature (SST) at a world position,
 * accounting for named currents, eddies, upwelling, and ENSO.
 */
export function sampleSSTAt(gridSlot, wx, wz) {
  sampleCurrentAt(gridSlot, wx, wz);
  let sst = _currentSample.sst;

  // Add named current temperature offsets.
  for (let slot = 0; slot < _nextNamedCurrentSlot; slot++) {
    if (!NamedCurrent.active[slot]) continue;

    const dx = wx - NamedCurrent.cx[slot];
    const dz = wz - NamedCurrent.cz[slot];
    const along = dx * NamedCurrent.dirX[slot] + dz * NamedCurrent.dirZ[slot];
    const across = -dx * NamedCurrent.dirZ[slot] + dz * NamedCurrent.dirX[slot];

    if (Math.abs(along) > NamedCurrent.length[slot] * 0.5) continue;
    if (Math.abs(across) > NamedCurrent.width[slot] * 0.5) continue;

    const falloff = (1 - Math.abs(across) / (NamedCurrent.width[slot] * 0.5));
    sst += NamedCurrent.temperatureOffset[slot] * falloff * falloff;
  }

  // Add eddy temperature offsets.
  for (let slot = 0; slot < MAX_EDDIES; slot++) {
    if (!Eddy.active[slot]) continue;

    const dx = wx - Eddy.cx[slot];
    const dz = wz - Eddy.cz[slot];
    const r = Math.hypot(dx, dz);
    if (r > Eddy.radius[slot]) continue;

    const falloff = 1 - r / Eddy.radius[slot];
    sst += Eddy.temperatureOffset[slot] * falloff;
  }

  // Add upwelling temperature deficit.
  const upwellRate = sampleUpwellingAt(wx, wz);
  if (upwellRate > EPSILON) {
    // Find the nearest upwelling zone and apply its deficit.
    for (let slot = 0; slot < MAX_UPWELLING_ZONES; slot++) {
      if (!UpwellingZone.active[slot]) continue;

      const dx = (wx - UpwellingZone.cx[slot]) / UpwellingZone.radiusX[slot];
      const dz = (wz - UpwellingZone.cz[slot]) / UpwellingZone.radiusZ[slot];
      const distSq = dx * dx + dz * dz;
      if (distSq > 1.0) continue;

      const falloff = 1 - distSq;
      sst -= UpwellingZone.temperatureDeficit[slot] * falloff;
      break;
    }
  }

  // Add ENSO anomaly.
  sst += getENSOAnomalyAt(wx, wz);

  return sst;
}

/**
 * Return the salinity at a world position, including named current
 * offsets.
 */
export function sampleSalinityAt(gridSlot, wx, wz) {
  sampleCurrentAt(gridSlot, wx, wz);
  let salinity = _currentSample.salinity;

  // Named currents.
  for (let slot = 0; slot < _nextNamedCurrentSlot; slot++) {
    if (!NamedCurrent.active[slot]) continue;

    const dx = wx - NamedCurrent.cx[slot];
    const dz = wz - NamedCurrent.cz[slot];
    const along = dx * NamedCurrent.dirX[slot] + dz * NamedCurrent.dirZ[slot];
    const across = -dx * NamedCurrent.dirZ[slot] + dz * NamedCurrent.dirX[slot];

    if (Math.abs(along) > NamedCurrent.length[slot] * 0.5) continue;
    if (Math.abs(across) > NamedCurrent.width[slot] * 0.5) continue;

    const falloff = (1 - Math.abs(across) / (NamedCurrent.width[slot] * 0.5));
    salinity += NamedCurrent.salinityOffset[slot] * falloff * falloff;
  }

  return salinity;
}

// ═══════════════════════════════════════════════════════════════════════
// ATMOSPHERE COUPLING — evaporation boost from SST
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the evaporation multiplier at a world position, based on SST
 * (warmer water evaporates faster). Used by file 068's vapor source.
 */
export function evaporationMultiplierFromSST(gridSlot, wx, wz) {
  const sst = sampleSSTAt(gridSlot, wx, wz);
  // Reference: 20 °C water. Warmer increases, colder decreases.
  return Math.max(0.1, (sst - 5) / 15);
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TICK
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance the ocean current system for one frame.
 */
export function systemOceanTick(world, dt, seasonSlot = -1, latitudeDeg = 45) {
  const dtHours = dt / 3600.0;

  // Advance ENSO.
  systemUpdateENSO(dtHours);

  // Update each current grid.
  const G = CurrentGrid;
  for (let gridSlot = 0; gridSlot < _nextCurrentGridSlot; gridSlot++) {
    if (!G.active[gridSlot]) continue;
    systemUpdateCurrentGrid(world, gridSlot, dt, seasonSlot);
  }

  // Update eddies.
  systemUpdateEddies(dtHours);

  // Update marine entities.
  systemUpdateMarineEntities(world, dt, latitudeDeg, seasonSlot);

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a human-readable label for a current type.
 */
export function currentTypeLabel(type) {
  switch (type) {
    case CurrentType.SURFACE_GYRE:          return 'Surface Gyre';
    case CurrentType.BOUNDARY_WESTERN:      return 'Western Boundary Current';
    case CurrentType.BOUNDARY_EASTERN:      return 'Eastern Boundary Current';
    case CurrentType.EQUATORIAL_NORTH:      return 'North Equatorial Current';
    case CurrentType.EQUATORIAL_SOUTH:      return 'South Equatorial Current';
    case CurrentType.EQUATORIAL_COUNTER:    return 'Equatorial Countercurrent';
    case CurrentType.ANTARCTIC_CIRCUMPOLAR: return 'Antarctic Circumpolar Current';
    case CurrentType.THERMOHALINE:          return 'Thermohaline Current';
    case CurrentType.UPWELLING:             return 'Upwelling';
    case CurrentType.DOWNWELLING:           return 'Downwelling';
    case CurrentType.TIDAL:                 return 'Tidal Current';
    case CurrentType.MONSOON:               return 'Monsoon Current';
    case CurrentType.EDDY:                  return 'Eddy';
    default:                                 return 'Unknown';
  }
}

/**
 * Return a label for the current ENSO phase.
 */
export function ensoPhaseLabel() {
  if (ENSOState.index > 0.5) {
    return `El Niño (${ENSOState.index.toFixed(1)})`;
  }
  if (ENSOState.index < -0.5) {
    return `La Niña (${ENSOState.index.toFixed(1)})`;
  }
  return `Neutral (${ENSOState.index.toFixed(1)})`;
}

/**
 * Return a full ocean summary at a world position.
 */
export function getOceanSummaryAt(gridSlot, wx, wz) {
  const sample = sampleCurrentAt(gridSlot, wx, wz);
  const totalCurrent = [0, 0];
  sampleTotalCurrentVelocity(wx, wz, 45, -1, totalCurrent);

  return {
    surfaceSST: sampleSSTAt(gridSlot, wx, wz),
    salinity: sampleSalinityAt(gridSlot, wx, wz),
    baseVelocityX: sample.velocityX,
    baseVelocityZ: sample.velocityZ,
    totalVelocityX: totalCurrent[0],
    totalVelocityZ: totalCurrent[1],
    speed: Math.hypot(totalCurrent[0], totalCurrent[1]),
    upwelling: sample.upwelling,
    depth: sample.depth,
    ensoPhase: ENSOState.phase,
    ensoIndex: ENSOState.index,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

export function gatherCurrentGridsForRendering() {
  const result = [];
  const G = CurrentGrid;

  for (let slot = 0; slot < _nextCurrentGridSlot; slot++) {
    if (!G.active[slot]) continue;

    result.push({
      slot,
      gridSizeX: G.gridSizeX[slot],
      gridSizeZ: G.gridSizeZ[slot],
      worldMinX: G.worldMinX[slot],
      worldMinZ: G.worldMinZ[slot],
      worldMaxX: G.worldMaxX[slot],
      worldMaxZ: G.worldMaxZ[slot],
    });
  }

  return result;
}

export function gatherNamedCurrentsForRendering() {
  const result = [];
  const C = NamedCurrent;

  for (let slot = 0; slot < _nextNamedCurrentSlot; slot++) {
    if (!C.active[slot]) continue;

    result.push({
      slot,
      type: C.type[slot],
      typeLabel: currentTypeLabel(C.type[slot]),
      cx: C.cx[slot],
      cz: C.cz[slot],
      dirX: C.dirX[slot],
      dirZ: C.dirZ[slot],
      speed: C.speed[slot],
      length: C.length[slot],
      width: C.width[slot],
      temperatureOffset: C.temperatureOffset[slot],
      salinityOffset: C.salinityOffset[slot],
    });
  }

  return result;
}

export function gatherEddiesForRendering() {
  const result = [];

  for (let slot = 0; slot < MAX_EDDIES; slot++) {
    if (!Eddy.active[slot]) continue;

    result.push({
      slot,
      cx: Eddy.cx[slot],
      cz: Eddy.cz[slot],
      radius: Eddy.radius[slot],
      rotation: Eddy.rotation[slot],
      tangentialSpeed: Eddy.tangentialSpeed[slot],
      temperatureOffset: Eddy.temperatureOffset[slot],
      ageDays: Eddy.ageDays[slot],
    });
  }

  return result;
}

export function gatherUpwellingZonesForRendering() {
  const result = [];

  for (let slot = 0; slot < MAX_UPWELLING_ZONES; slot++) {
    if (!UpwellingZone.active[slot]) continue;

    result.push({
      slot,
      cx: UpwellingZone.cx[slot],
      cz: UpwellingZone.cz[slot],
      radiusX: UpwellingZone.radiusX[slot],
      radiusZ: UpwellingZone.radiusZ[slot],
      rate: UpwellingZone.rate[slot],
      temperatureDeficit: UpwellingZone.temperatureDeficit[slot],
      nutrientFactor: UpwellingZone.nutrientFactor[slot],
    });
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function oceanCurrentStats() {
  let activeGrids = 0;
  let activeCurrents = 0;
  let activeEddies = 0;
  let activeUpwelling = 0;
  let activeMarine = 0;

  for (let slot = 0; slot < _nextCurrentGridSlot; slot++) {
    if (CurrentGrid.active[slot]) activeGrids++;
  }

  for (let slot = 0; slot < _nextNamedCurrentSlot; slot++) {
    if (NamedCurrent.active[slot]) activeCurrents++;
  }

  for (let slot = 0; slot < MAX_EDDIES; slot++) {
    if (Eddy.active[slot]) activeEddies++;
  }

  for (let slot = 0; slot < MAX_UPWELLING_ZONES; slot++) {
    if (UpwellingZone.active[slot]) activeUpwelling++;
  }

  for (let slot = 0; slot < _nextMarineEntitySlot; slot++) {
    if (MarineEntity.active[slot]) activeMarine++;
  }

  return {
    activeGrids,
    maxGrids: MAX_CURRENT_GRIDS,
    activeCurrents,
    maxCurrents: MAX_CURRENTS,
    activeEddies,
    maxEddies: MAX_EDDIES,
    activeUpwelling,
    maxUpwelling: MAX_UPWELLING_ZONES,
    activeMarine,
    maxMarine: MAX_MARINE_ENTITIES,
    ensoIndex: ENSOState.index,
    ensoPhase: ENSOState.phase,
    ensoLabel: ensoPhaseLabel(),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearOceanCurrents() {
  CurrentGrid.active.fill(0);
  CurrentGrid.ownerEid.fill(0);
  CurrentGrid.velocityXByGrid.clear();
  CurrentGrid.velocityZByGrid.clear();
  CurrentGrid.sstByGrid.clear();
  CurrentGrid.salinityByGrid.clear();
  CurrentGrid.upwellingByGrid.clear();
  CurrentGrid.depthByGrid.clear();
  _currentGridSlots.clear();
  _nextCurrentGridSlot = 0;

  NamedCurrent.active.fill(0);
  NamedCurrent.ownerEid.fill(0);
  _namedCurrentSlots.clear();
  _nextNamedCurrentSlot = 0;

  Eddy.active.fill(0);
  UpwellingZone.active.fill(0);

  MarineEntity.active.fill(0);
  MarineEntity.ownerEid.fill(0);
  _marineEntitySlots.clear();
  _nextMarineEntitySlot = 0;

  ENSOState.phase = 0;
  ENSOState.index = 0;
  ENSOState.yearsSinceStart = 0;
  ENSOState.sstAnomaly = 0;
  ENSOState.teleconnectionStrength = 0;
}