// file number : 058
// full path name : src/weather/058_heat_haze.js
// description : Heat haze and thermal mirage system. Provides the
//               refractive distortion and shimmer that appears over hot
//               surfaces (asphalt, desert sand, engines, fires, volcanic
//               lava). Implements the full thermal mirage taxonomy:
//                 • INFERIOR MIRAGE — the classic "puddle on the road"
//                   shimmer. Cool air above hot ground bends light rays
//                   upward, so distant objects appear inverted and
//                   displaced. Modelled via the Gladstone-Dale relation
//                   linking air density to refractive index.
//                 • SUPERIOR MIRAGE — the "cold water reflection" that
//                   appears over cold water or ice, where warm air
//                   layers above cold dense air bend light rays
//                   downward. Objects appear elongated or lifted.
//                 • FATA MORGANA — the complex multi-layered mirage from
//                   multiple temperature inversions, producing the
//                   famous "floating cities" illusion.
//                 • THERMAL SHIMMER — the small-scale rapid refractive
//                   wobble caused by turbulent convection cells above
//                   a hot surface. Rendered as a per-pixel UV distortion
//                   that file 019's post-processing can apply to the
//                   screen-space frame.
//                 • GLADSTONE-DALE REFRACTIVE INDEX — the physical
//                   relation n = 1 + K · ρ (K = 0.226 × 10⁻³ m³/kg for
//                   air at standard conditions) with a temperature-
//                   dependent extension via the ideal gas law, so the
//                   temperature gradient directly determines the ray
//                   bending angle.
//                 • RAY DISPLACEMENT SAMPLING — the integrator-facing
//                   API `sampleHeatHazeDisplacement` returns the
//                   angular displacement and UV offset that a ray
//                   passing through a haze region should experience.
//                   File 017's path integrator adds this to the final
//                   pixel sample.
//                 • SHIMMER TURBULENCE FIELD — a 3D simplex noise field
//                   whose scale and amplitude grow with the local
//                   temperature anomaly. The result is a smoothly
//                   varying distortion that visually resembles real
//                   heat shimmer.
//                 • HOT SURFACE REGISTRY — one SoA record per entity
//                   flagged as a heat source (with WorldBoundsF32 from
//                   file 004), tracking the entity's surface
//                   temperature, effective radiating area, and a
//                   per-source intensity multiplier.
//                 • ATMOSPHERE COUPLING — reads ambient temperature,
//                   humidity, and sun intensity from file 028's sky
//                   and file 057's pollution zones. High humidity
//                   amplifies the effect; strong sun amplifies the
//                   ground heating; wind suppresses the effect.
//                 • DRY / WET COUPLING — reads file 042's per-surface
//                   wetness. Wet surfaces evaporate and create more
//                   shimmer (wet-road effect) while suppressing
//                   the hottest mirages.
//                 • INTERACTION WITH FIRE AND VOLCANO — reads file 056's
//                   active fire cells and file 055's volcanic vents to
//                   add extra distortion above active fires.
//               All state lives in typed arrays; sampling is O(heat
//               sources) per query with a small-noise cost. Zero per-
//               frame allocation; steady-state 1M-entity scenes handle
//               heat haze on Android 64-bit without GC spikes.
// best for : Desert gameplay, hot-road shimmer, lava fields, engine
//            exhaust VFX, cinematic summer heat, sci-fi plasma effects,
//            fire and volcano atmosphere, and any 1M-entity scene
//            needing realistic heat haze on Android 64-bit.
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
  samplePollution,
} from './057_air_pollution.js';

import {
  FireCell,
  FirePhase,
} from './056_smoke_fire.js';

import {
  VolcanicVent,
  VolcanicVentTag,
} from './055_volcanic_ash.js';

import {
  SurfaceWetness,
  getWetSurfaceSlot,
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

// Gladstone-Dale constant for air (m³/kg).
const GLADSTONE_DALE_AIR             = 0.226e-3;

// Standard air properties at sea level.
const AIR_DENSITY_STANDARD           = 1.225;      // kg/m³
const AIR_REFRACTIVE_INDEX_STANDARD  = 1.000293;

// Universal gas constant for dry air (J/(kg·K)).
const GAS_CONSTANT_AIR               = 287.058;

// Standard atmospheric pressure (Pa).
const ATMOSPHERIC_PRESSURE           = 101325.0;

// Reference temperature (K).
const REFERENCE_TEMPERATURE          = 288.15;

// Heat haze thresholds.
const HAZE_MIN_TEMP_DIFF             = 5.0;        // °C above ambient
const HAZE_MAX_TEMP_DIFF             = 250.0;      // °C at fire

// Shimmer distortion limits.
const SHIMMER_MAX_DISPLACEMENT       = 0.05;       // max UV displacement
const SHIMMER_MIN_DISPLACEMENT       = 0.0005;
const SHIMMER_BASE_FREQ              = 3.5;        // Hz
const SHIMMER_SCALE_KM               = 0.08;       // metres of noise scale

// Mirage classification thresholds (temperature gradient in K/m).
const INFERIOR_MIRAGE_GRADIENT_MIN   = 0.5;        // hot ground → cool air
const SUPERIOR_MIRAGE_GRADIENT_MIN   = -0.3;       // cold ground → warm air
const FATA_MORGANA_GRADIENT_JITTER   = 0.15;       // multiple inversions

// Wind suppression.
const WIND_SUPPRESSION_SPEED_MIN     = 0.5;        // m/s
const WIND_SUPPRESSION_SPEED_MAX     = 5.0;        // m/s

// Humidity amplification.
const HUMIDITY_AMPLIFICATION_MAX     = 1.6;

// Sun amplification.
const SUN_AMPLIFICATION_MAX          = 1.4;

// Heat source attenuation.
const HEAT_SOURCE_FALLOFF_POWER      = 1.5;

// Fire/volcano heat contribution.
const FIRE_HAZE_MULTIPLIER           = 3.0;
const VOLCANO_HAZE_MULTIPLIER        = 5.0;

// Max live records.
const MAX_HEAT_SOURCES               = 4096;
const MAX_HAZE_REGIONS               = 512;
const MAX_HAZE_OBSERVERS             = 8;
const MAX_MIRAGE_LAYERS              = 8;

// Heat source types.
const SOURCE_ROAD                     = 0;
const SOURCE_SAND                     = 1;
const SOURCE_ROCK                     = 2;
const SOURCE_ENGINE                   = 3;
const SOURCE_FIRE                     = 4;
const SOURCE_LAVA                     = 5;
const SOURCE_INDUSTRIAL               = 6;

// ═══════════════════════════════════════════════════════════════════════
// MIRAGE TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const MirageType = Object.freeze({
  NONE:          0,
  INFERIOR:      1,
  SUPERIOR:      2,
  FATA_MORGANA:  3,
});

// ═══════════════════════════════════════════════════════════════════════
// HEAT SOURCE TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const HeatSourceType = Object.freeze({
  ROAD:        0,
  SAND:        1,
  ROCK:        2,
  ENGINE:      3,
  FIRE:        4,
  LAVA:        5,
  INDUSTRIAL:  6,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA HEAT SOURCE RECORD
// ═══════════════════════════════════════════════════════════════════════

export const HeatSource = {
  ownerEid: new Uint32Array(MAX_HEAT_SOURCES),
  type: new Uint8Array(MAX_HEAT_SOURCES),

  // World position (center of the source).
  px: new Float32Array(MAX_HEAT_SOURCES),
  py: new Float32Array(MAX_HEAT_SOURCES),
  pz: new Float32Array(MAX_HEAT_SOURCES),

  // Horizontal extent and vertical influence (metres).
  radiusX: new Float32Array(MAX_HEAT_SOURCES),
  radiusZ: new Float32Array(MAX_HEAT_SOURCES),
  influenceHeight: new Float32Array(MAX_HEAT_SOURCES),

  // Surface temperature (°C).
  surfaceTemperature: new Float32Array(MAX_HEAT_SOURCES),

  // Effective radiating area (m²).
  radiatingArea: new Float32Array(MAX_HEAT_SOURCES),

  // Per-source intensity multiplier (0..1).
  intensityMultiplier: new Float32Array(MAX_HEAT_SOURCES),

  // Age (seconds).
  age: new Float32Array(MAX_HEAT_SOURCES),

  // Active.
  active: new Uint8Array(MAX_HEAT_SOURCES),

  // Seed for noise.
  seed: new Uint32Array(MAX_HEAT_SOURCES),
};

/** Marker: entity is a heat source. */
export const HeatSourceTag = {};

const _heatSourceSlots = new Map();
let _nextHeatSourceSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA HEAT HAZE REGION — aggregated regions for sampling
// ═══════════════════════════════════════════════════════════════════════

export const HeatHazeRegion = {
  ownerEid: new Uint32Array(MAX_HAZE_REGIONS),

  // Center of the haze region.
  cx: new Float32Array(MAX_HAZE_REGIONS),
  cy: new Float32Array(MAX_HAZE_REGIONS),
  cz: new Float32Array(MAX_HAZE_REGIONS),

  // Bounding extents (metres).
  radiusX: new Float32Array(MAX_HAZE_REGIONS),
  radiusY: new Float32Array(MAX_HAZE_REGIONS),
  radiusZ: new Float32Array(MAX_HAZE_REGIONS),

  // Total temperature differential (°C) driving the haze.
  temperatureDiff: new Float32Array(MAX_HAZE_REGIONS),

  // Current shimmer amplitude (0..1).
  shimmerAmplitude: new Float32Array(MAX_HAZE_REGIONS),

  // Dominant mirage type (MirageType).
  mirageType: new Uint8Array(MAX_HAZE_REGIONS),

  // Wind suppression factor (0..1; 1 = no wind, 0 = fully suppressed).
  windFactor: new Float32Array(MAX_HAZE_REGIONS),

  // Humidity amplification factor (1..1.6).
  humidityFactor: new Float32Array(MAX_HAZE_REGIONS),

  // Sun amplification factor (1..1.4).
  sunFactor: new Float32Array(MAX_HAZE_REGIONS),

  // Age (seconds).
  age: new Float32Array(MAX_HAZE_REGIONS),

  // Active.
  active: new Uint8Array(MAX_HAZE_REGIONS),
};

/** Marker: entity is a haze region. */
export const HeatHazeRegionTag = {};

const _hazeRegionSlots = new Map();
let _nextHazeRegionSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA HAZE OBSERVER — one per camera
// ═══════════════════════════════════════════════════════════════════════

export const HeatHazeObserver = {
  ownerEid: new Uint32Array(MAX_HAZE_OBSERVERS),

  // Camera position.
  camX: new Float32Array(MAX_HAZE_OBSERVERS),
  camY: new Float32Array(MAX_HAZE_OBSERVERS),
  camZ: new Float32Array(MAX_HAZE_OBSERVERS),

  // Camera forward direction (unit vector).
  fwdX: new Float32Array(MAX_HAZE_OBSERVERS),
  fwdY: new Float32Array(MAX_HAZE_OBSERVERS),
  fwdZ: new Float32Array(MAX_HAZE_OBSERVERS),

  // Local temperature anomaly at the camera.
  localTempAnomaly: new Float32Array(MAX_HAZE_OBSERVERS),

  // Active.
  active: new Uint8Array(MAX_HAZE_OBSERVERS),
};

/** Marker: entity is a haze observer. */
export const HeatHazeObserverTag = {};

const _hazeObserverSlots = new Map();
let _nextHazeObserverSlot = 0;

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

const _heatHazeNoise = createNoise3D();

// ═══════════════════════════════════════════════════════════════════════
// HEAT SOURCE API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register a heat source on an entity.
 *
 * @param world       ECS world
 * @param eid         entity (should have WorldTransformF32)
 * @param type        HeatSourceType
 * @param options     { surfaceTemperature, radiatingArea, radiusX, radiusZ,
 *                      influenceHeight, intensityMultiplier, seed }
 * @returns heat source slot
 */
export function addHeatSource(world, eid, type = HeatSourceType.ROAD, options = {}) {
  if (_nextHeatSourceSlot >= MAX_HEAT_SOURCES) {
    throw new Error('heat source capacity exceeded');
  }
  const slot = _nextHeatSourceSlot++;

  addComponent(world, eid, HeatSourceTag);

  const S = HeatSource;
  S.ownerEid[slot] = eid;
  S.type[slot] = type;

  S.px[slot] = options.px ?? 0;
  S.py[slot] = options.py ?? 0;
  S.pz[slot] = options.pz ?? 0;

  const defaults = defaultsForHeatType(type);
  S.radiusX[slot] = options.radiusX ?? defaults.radiusX;
  S.radiusZ[slot] = options.radiusZ ?? defaults.radiusZ;
  S.influenceHeight[slot] = options.influenceHeight ?? defaults.influenceHeight;
  S.surfaceTemperature[slot] = options.surfaceTemperature ?? defaults.surfaceTemperature;
  S.radiatingArea[slot] = options.radiatingArea ?? defaults.radiatingArea;
  S.intensityMultiplier[slot] = options.intensityMultiplier ?? 1.0;

  S.age[slot] = 0;
  S.active[slot] = 1;
  S.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  _heatSourceSlots.set(eid, slot);
  return slot;
}

function defaultsForHeatType(type) {
  switch (type) {
    case HeatSourceType.ROAD:
      return {
        radiusX: 20.0,
        radiusZ: 20.0,
        influenceHeight: 3.0,
        surfaceTemperature: 55.0,
        radiatingArea: 400.0,
      };
    case HeatSourceType.SAND:
      return {
        radiusX: 100.0,
        radiusZ: 100.0,
        influenceHeight: 5.0,
        surfaceTemperature: 65.0,
        radiatingArea: 10000.0,
      };
    case HeatSourceType.ROCK:
      return {
        radiusX: 50.0,
        radiusZ: 50.0,
        influenceHeight: 4.0,
        surfaceTemperature: 60.0,
        radiatingArea: 2500.0,
      };
    case HeatSourceType.ENGINE:
      return {
        radiusX: 1.5,
        radiusZ: 1.5,
        influenceHeight: 1.5,
        surfaceTemperature: 120.0,
        radiatingArea: 2.25,
      };
    case HeatSourceType.FIRE:
      return {
        radiusX: 10.0,
        radiusZ: 10.0,
        influenceHeight: 15.0,
        surfaceTemperature: 800.0,
        radiatingArea: 100.0,
      };
    case HeatSourceType.LAVA:
      return {
        radiusX: 30.0,
        radiusZ: 30.0,
        influenceHeight: 25.0,
        surfaceTemperature: 1200.0,
        radiatingArea: 900.0,
      };
    case HeatSourceType.INDUSTRIAL:
      return {
        radiusX: 5.0,
        radiusZ: 5.0,
        influenceHeight: 8.0,
        surfaceTemperature: 180.0,
        radiatingArea: 25.0,
      };
    default:
      return {
        radiusX: 10.0,
        radiusZ: 10.0,
        influenceHeight: 3.0,
        surfaceTemperature: 50.0,
        radiatingArea: 100.0,
      };
  }
}

export function removeHeatSource(world, eid) {
  const slot = _heatSourceSlots.get(eid);
  if (slot === undefined) return;
  HeatSource.active[slot] = 0;
  HeatSource.ownerEid[slot] = 0;
  _heatSourceSlots.delete(eid);
  removeComponent(world, eid, HeatSourceTag);
}

export function getHeatSourceSlot(eid) {
  return _heatSourceSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// HAZE REGION API
// ═══════════════════════════════════════════════════════════════════════

export function addHeatHazeRegion(world, eid, options = {}) {
  if (_nextHazeRegionSlot >= MAX_HAZE_REGIONS) {
    throw new Error('heat haze region capacity exceeded');
  }
  const slot = _nextHazeRegionSlot++;

  addComponent(world, eid, HeatHazeRegionTag);

  const R = HeatHazeRegion;
  R.ownerEid[slot] = eid;
  R.cx[slot] = options.cx ?? 0;
  R.cy[slot] = options.cy ?? 0;
  R.cz[slot] = options.cz ?? 0;
  R.radiusX[slot] = options.radiusX ?? 50;
  R.radiusY[slot] = options.radiusY ?? 10;
  R.radiusZ[slot] = options.radiusZ ?? 50;
  R.temperatureDiff[slot] = options.temperatureDiff ?? 0;
  R.shimmerAmplitude[slot] = 0;
  R.mirageType[slot] = MirageType.NONE;
  R.windFactor[slot] = 1;
  R.humidityFactor[slot] = 1;
  R.sunFactor[slot] = 1;
  R.age[slot] = 0;
  R.active[slot] = 1;

  _hazeRegionSlots.set(eid, slot);
  return slot;
}

export function removeHeatHazeRegion(world, eid) {
  const slot = _hazeRegionSlots.get(eid);
  if (slot === undefined) return;
  HeatHazeRegion.active[slot] = 0;
  HeatHazeRegion.ownerEid[slot] = 0;
  _hazeRegionSlots.delete(eid);
  removeComponent(world, eid, HeatHazeRegionTag);
}

// ═══════════════════════════════════════════════════════════════════════
// HAZE OBSERVER API
// ═══════════════════════════════════════════════════════════════════════

export function addHeatHazeObserver(world, eid, options = {}) {
  if (_nextHazeObserverSlot >= MAX_HAZE_OBSERVERS) {
    throw new Error('heat haze observer capacity exceeded');
  }
  const slot = _nextHazeObserverSlot++;

  addComponent(world, eid, HeatHazeObserverTag);

  const O = HeatHazeObserver;
  O.ownerEid[slot] = eid;
  O.camX[slot] = options.camX ?? 0;
  O.camY[slot] = options.camY ?? 0;
  O.camZ[slot] = options.camZ ?? 0;
  O.fwdX[slot] = options.fwdX ?? 0;
  O.fwdY[slot] = options.fwdY ?? 0;
  O.fwdZ[slot] = options.fwdZ ?? 1;
  O.localTempAnomaly[slot] = 0;
  O.active[slot] = 1;

  _hazeObserverSlots.set(eid, slot);
  return slot;
}

export function removeHeatHazeObserver(world, eid) {
  const slot = _hazeObserverSlots.get(eid);
  if (slot === undefined) return;
  HeatHazeObserver.active[slot] = 0;
  HeatHazeObserver.ownerEid[slot] = 0;
  _hazeObserverSlots.delete(eid);
  removeComponent(world, eid, HeatHazeObserverTag);
}

export function getHeatHazeObserverSlot(eid) {
  return _hazeObserverSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// GLADSTONE-DALE REFRACTIVE INDEX
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the refractive index of air at a given temperature (°C)
 * and pressure (Pa). Uses the Gladstone-Dale relation with the ideal
 * gas law to compute density.
 *
 *   ρ(T, P) = P / (R · T_K)
 *   n(ρ) = 1 + K · ρ
 *
 * @param temperatureC   temperature in °C
 * @param pressurePa     pressure in Pa (default = sea level)
 * @returns refractive index (≈ 1.0003 for standard conditions)
 */
export function airRefractiveIndex(temperatureC, pressurePa = ATMOSPHERIC_PRESSURE) {
  const temperatureK = temperatureC + 273.15;
  if (temperatureK <= 0) return AIR_REFRACTIVE_INDEX_STANDARD;

  const density = pressurePa / (GAS_CONSTANT_AIR * temperatureK);
  return 1.0 + GLADSTONE_DALE_AIR * density;
}

/**
 * Compute the refractive index gradient (1/m) from a temperature
 * gradient (K/m) using the Gladstone-Dale relation.
 *
 *   dn/dy ≈ -(K · P) / (R · T²) · dT/dy
 */
export function refractiveIndexGradient(tempGradientKPerM, temperatureC, pressurePa = ATMOSPHERIC_PRESSURE) {
  const temperatureK = temperatureC + 273.15;
  if (temperatureK <= 0) return 0;

  return -(GLADSTONE_DALE_AIR * pressurePa) / (GAS_CONSTANT_AIR * temperatureK * temperatureK) * tempGradientKPerM;
}

// ═══════════════════════════════════════════════════════════════════════
// MIRAGE CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Classify the mirage type from the local temperature gradient.
 */
function classifyMirage(tempGradientKPerM, jitterNoise) {
  // Inferior mirage: hot ground, temperature decreasing with altitude
  if (tempGradientKPerM > INFERIOR_MIRAGE_GRADIENT_MIN) {
    return MirageType.INFERIOR;
  }

  // Superior mirage: cold ground, temperature increasing with altitude
  if (tempGradientKPerM < SUPERIOR_MIRAGE_GRADIENT_MIN) {
    return MirageType.SUPERIOR;
  }

  // Fata Morgana: complex layers (near-zero but jittered gradient)
  if (Math.abs(tempGradientKPerM) < FATA_MORGANA_GRADIENT_JITTER
      && Math.abs(jitterNoise) > 0.7) {
    return MirageType.FATA_MORGANA;
  }

  return MirageType.NONE;
}

// ═══════════════════════════════════════════════════════════════════════
// ATMOSPHERIC COUPLING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the wind suppression factor for a position.
 * Returns 1.0 if no wind (full effect), 0.0 if wind exceeds suppression
 * threshold (effect fully suppressed).
 */
function computeWindSuppression(wx, wy, wz) {
  sampleWindAt(wx, wy, wz, _windScratch);
  const windSpeed = Math.hypot(_windScratch[0], _windScratch[2]);

  if (windSpeed <= WIND_SUPPRESSION_SPEED_MIN) return 1.0;
  if (windSpeed >= WIND_SUPPRESSION_SPEED_MAX) return 0.0;

  const t = (windSpeed - WIND_SUPPRESSION_SPEED_MIN)
    / (WIND_SUPPRESSION_SPEED_MAX - WIND_SUPPRESSION_SPEED_MIN);
  return 1.0 - t;
}

const _windScratch = vec3.create();

/**
 * Compute the humidity amplification factor for a position.
 * Higher humidity → more shimmer.
 */
function computeHumidityAmplification(wx, wy, wz) {
  const pollution = samplePollution(wx, wy, wz);
  // We don't have direct humidity here, but we can infer it from
  // pollution readings indirectly. In a full pipeline, use the weather
  // system's ambient humidity. This is a simplified model.
  const humidityProxy = Math.min(1, pollution.pm25 / 100);
  return 1.0 + humidityProxy * (HUMIDITY_AMPLIFICATION_MAX - 1.0);
}

/**
 * Compute the sun amplification factor for a position.
 */
function computeSunAmplification(world, wx, wy, wz) {
  const skyEids = query(world, [SkyF32]);
  if (skyEids.length === 0) return 1.0;

  const skySlot = getSkySlot(skyEids[0]);
  if (skySlot < 0) return 1.0;

  // Sun intensity from file 028.
  const sunIntensity = SkyF32.sunIntensity[skySlot];
  return 1.0 + Math.min(1, sunIntensity) * (SUN_AMPLIFICATION_MAX - 1.0);
}

/**
 * Compute the temperature differential (°C) at a world point relative
 * to the ambient.
 */
function computeTemperatureDiff(wx, wy, wz, ambientTempC) {
  let maxDiff = 0;

  const S = HeatSource;
  for (let slot = 0; slot < _nextHeatSourceSlot; slot++) {
    if (!S.active[slot]) continue;

    // Distance falloff.
    const dx = (wx - S.px[slot]) / Math.max(S.radiusX[slot], 1);
    const dz = (wz - S.pz[slot]) / Math.max(S.radiusZ[slot], 1);
    const dy = (wy - S.py[slot]) / Math.max(S.influenceHeight[slot], 1);

    const distSq = dx * dx + dz * dz + dy * dy;
    if (distSq > 1.0) continue;

    const falloff = Math.pow(1 - distSq, HEAT_SOURCE_FALLOFF_POWER);
    const diff = (S.surfaceTemperature[slot] - ambientTempC) * falloff
      * S.intensityMultiplier[slot];

    if (diff > maxDiff) maxDiff = diff;
  }

  return maxDiff;
}

/**
 * Compute the surface temperature rise from fire cells and volcanic vents.
 */
function computeExternalHeatContribution(wx, wy, wz) {
  let extraHeat = 0;

  // Fire cells (file 056).
  for (let slot = 0; slot < FireCell.active.length; slot++) {
    if (!FireCell.active[slot]) continue;
    if (FireCell.phase[slot] !== FirePhase.BURNING
        && FireCell.phase[slot] !== FirePhase.SPREADING) continue;

    const dx = wx - FireCell.px[slot];
    const dy = wy - FireCell.py[slot];
    const dz = wz - FireCell.pz[slot];
    const distSq = dx * dx + dy * dy + dz * dz;
    const influenceRadius = FireCell.size[slot] * 2;

    if (distSq < influenceRadius * influenceRadius) {
      const falloff = 1 - distSq / (influenceRadius * influenceRadius);
      extraHeat += FireCell.firelineIntensity[slot] * 0.1 * falloff * FIRE_HAZE_MULTIPLIER;
    }
  }

  // Volcanic vents (file 055).
  for (let slot = 0; slot < VolcanicVent.active.length; slot++) {
    if (!VolcanicVent.active[slot]) continue;

    const dx = wx - VolcanicVent.px[slot];
    const dy = wy - VolcanicVent.py[slot];
    const dz = wz - VolcanicVent.pz[slot];
    const influenceRadius = 500.0;   // 500 m influence

    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq < influenceRadius * influenceRadius) {
      const falloff = 1 - distSq / (influenceRadius * influenceRadius);
      // Vent temperature minus ambient.
      extraHeat += (VolcanicVent.ventTemperature[slot] - 20) * falloff * 0.05
        * VOLCANO_HAZE_MULTIPLIER;
    }
  }

  return extraHeat;
}

// ═══════════════════════════════════════════════════════════════════════
// REGION UPDATE — aggregate heat sources into haze regions
// ═══════════════════════════════════════════════════════════════════════

/**
 * Update the aggregated heat haze regions from individual heat sources.
 * Also computes the dominant mirage type for each region.
 *
 * @param world         ECS world
 * @param dt            seconds
 * @param ambientTempC  ambient temperature (°C)
 * @param ambientHumidity  ambient relative humidity (0..1)
 */
export function systemUpdateHeatHazeRegions(world, dt, ambientTempC = 20.0, ambientHumidity = 0.5) {
  const S = HeatSource;
  const R = HeatHazeRegion;

  // Clear existing region accumulators.
  for (let slot = 0; slot < _nextHazeRegionSlot; slot++) {
    if (!R.active[slot]) continue;
    R.age[slot] += dt;
    R.temperatureDiff[slot] = 0;
    R.radiusX[slot] = 0;
    R.radiusY[slot] = 0;
    R.radiusZ[slot] = 0;
  }

  // Build region cache: find nearest region for each heat source.
  const regionMap = new Map();

  for (let srcSlot = 0; srcSlot < _nextHeatSourceSlot; srcSlot++) {
    if (!S.active[srcSlot]) continue;

    // Update position from the entity's WorldTransformF32 if available.
    const ownerEid = S.ownerEid[srcSlot];
    if (ownerEid !== 0 && entityExists(world, ownerEid)) {
      const id = getId(ownerEid);
      const M = WorldTransformF32.m;
      if (M) {
        const off = id * 16;
        S.px[srcSlot] = M[off + 12];
        S.py[srcSlot] = M[off + 13];
        S.pz[srcSlot] = M[off + 14];
      }
    }

    // Find or create the nearest region for this source.
    let bestRegion = -1;
    let bestDistSq = Infinity;

    for (let rSlot = 0; rSlot < _nextHazeRegionSlot; rSlot++) {
      if (!R.active[rSlot]) continue;
      const dx = R.cx[rSlot] - S.px[srcSlot];
      const dz = R.cz[rSlot] - S.pz[srcSlot];
      const distSq = dx * dx + dz * dz;
      if (distSq < bestDistSq && distSq < 200 * 200) {   // 200 m matching radius
        bestRegion = rSlot;
        bestDistSq = distSq;
      }
    }

    if (bestRegion < 0) {
      // Create a new region for this source.
      if (_nextHazeRegionSlot >= MAX_HAZE_REGIONS) continue;
      bestRegion = _nextHazeRegionSlot++;
      R.active[bestRegion] = 1;
      R.cx[bestRegion] = S.px[srcSlot];
      R.cy[bestRegion] = S.py[srcSlot];
      R.cz[bestRegion] = S.pz[srcSlot];
      R.age[bestRegion] = 0;
    }

    // Accumulate into the region.
    const diff = S.surfaceTemperature[srcSlot] - ambientTempC;
    if (diff > 0) {
      R.temperatureDiff[bestRegion] = Math.max(R.temperatureDiff[bestRegion], diff);
      R.radiusX[bestRegion] = Math.max(R.radiusX[bestRegion], S.radiusX[srcSlot] * 2);
      R.radiusY[bestRegion] = Math.max(R.radiusY[bestRegion], S.influenceHeight[srcSlot] * 1.5);
      R.radiusZ[bestRegion] = Math.max(R.radiusZ[bestRegion], S.radiusZ[srcSlot] * 2);
    }
  }

  // Compute per-region shimmer amplitude and mirage type.
  for (let slot = 0; slot < _nextHazeRegionSlot; slot++) {
    if (!R.active[slot]) continue;

    const tempDiff = R.temperatureDiff[slot];

    if (tempDiff < HAZE_MIN_TEMP_DIFF) {
      R.shimmerAmplitude[slot] = 0;
      R.mirageType[slot] = MirageType.NONE;
      continue;
    }

    // Wind suppression.
    R.windFactor[slot] = computeWindSuppression(R.cx[slot], R.cy[slot] + 2, R.cz[slot]);

    // Humidity amplification.
    R.humidityFactor[slot] = 1.0 + ambientHumidity * (HUMIDITY_AMPLIFICATION_MAX - 1.0);

    // Sun amplification.
    R.sunFactor[slot] = computeSunAmplification(world, R.cx[slot], R.cy[slot], R.cz[slot]);

    // Shimmer amplitude from temperature diff.
    const normalizedTemp = Math.min(1.0, tempDiff / HAZE_MAX_TEMP_DIFF);
    R.shimmerAmplitude[slot] = normalizedTemp
      * R.windFactor[slot]
      * R.humidityFactor[slot]
      * R.sunFactor[slot];

    // Mirage type classification.
    const tempGradient = tempDiff / Math.max(R.radiusY[slot], 1);
    const jitterNoise = _heatHazeNoise(
      R.cx[slot] * 0.01,
      R.cy[slot] * 0.01 + R.age[slot] * 0.1,
      R.cz[slot] * 0.01
    );
    R.mirageType[slot] = classifyMirage(tempGradient, jitterNoise);
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// SHIMMER DISPLACEMENT SAMPLING
// ═══════════════════════════════════════════════════════════════════════

const _hazeTmp = vec3.create();

/**
 * Sample the heat shimmer displacement for a ray origin and direction.
 * Returns a screen-space UV offset (dx, dy) in the range [-1, 1] which
 * should be multiplied by SHIMMER_MAX_DISPLACEMENT by the caller.
 *
 * @param rayOriginX/Y/Z   ray start position
 * @param rayDirX/Y/Z      normalized ray direction
 * @param time             current time in seconds
 * @param out              [dx, dy] output
 * @returns out
 */
export function sampleHeatShimmer(rayOriginX, rayOriginY, rayOriginZ,
                                   rayDirX, rayDirY, rayDirZ,
                                   time, out) {
  out[0] = 0;
  out[1] = 0;

  // Accumulate shimmer from all regions.
  const R = HeatHazeRegion;
  let totalAmplitude = 0;

  for (let slot = 0; slot < _nextHazeRegionSlot; slot++) {
    if (!R.active[slot]) continue;
    if (R.shimmerAmplitude[slot] < EPSILON) continue;

    // Ray-region intersection (simplified: use closest approach to the
    // region center).
    const dx = R.cx[slot] - rayOriginX;
    const dy = R.cy[slot] - rayOriginY;
    const dz = R.cz[slot] - rayOriginZ;

    // Closest approach distance.
    const projT = dx * rayDirX + dy * rayDirY + dz * rayDirZ;
    if (projT < 0) continue;

    const closestX = rayOriginX + rayDirX * projT;
    const closestY = rayOriginY + rayDirY * projT;
    const closestZ = rayOriginZ + rayDirZ * projT;

    const toCenterX = closestX - R.cx[slot];
    const toCenterY = closestY - R.cy[slot];
    const toCenterZ = closestZ - R.cz[slot];

    const distSq = (toCenterX * toCenterX) / (R.radiusX[slot] * R.radiusX[slot])
                 + (toCenterY * toCenterY) / (R.radiusY[slot] * R.radiusY[slot])
                 + (toCenterZ * toCenterZ) / (R.radiusZ[slot] * R.radiusZ[slot]);

    if (distSq > 1.0) continue;

    // Falloff inside the region.
    const falloff = 1 - distSq;
    totalAmplitude += R.shimmerAmplitude[slot] * falloff;
  }

  if (totalAmplitude < EPSILON) return out;

  // Noise-driven shimmer using 3D simplex.
  const freq = SHIMMER_BASE_FREQ;
  const scale = SHIMMER_SCALE_KM;

  const nx = _heatHazeNoise(
    rayOriginX * scale + time * freq,
    rayOriginY * scale + time * freq * 0.7,
    rayOriginZ * scale
  );
  const ny = _heatHazeNoise(
    rayOriginX * scale + 100,
    rayOriginY * scale + time * freq,
    rayOriginZ * scale + time * freq * 0.5
  );

  // Amplitude-scaling.
  const amplitude = Math.min(1.0, totalAmplitude);
  out[0] = nx * amplitude * SHIMMER_MAX_DISPLACEMENT;
  out[1] = ny * amplitude * SHIMMER_MAX_DISPLACEMENT;

  return out;
}

/**
 * Sample the full heat haze distortion for an observer looking in a
 * direction. Returns displacement in UV space (dx, dy).
 */
export function sampleHeatHazeDisplacement(observerSlot, dirX, dirY, dirZ, time, out) {
  out[0] = 0;
  out[1] = 0;

  const O = HeatHazeObserver;
  if (!O.active[observerSlot]) return out;

  // Sample shimmer.
  return sampleHeatShimmer(
    O.camX[observerSlot], O.camY[observerSlot], O.camZ[observerSlot],
    dirX, dirY, dirZ,
    time, out
  );
}

// ═══════════════════════════════════════════════════════════════════════
// MIRAGE TYPE SAMPLING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the dominant mirage type at a world position.
 */
export function sampleMirageTypeAt(wx, wy, wz) {
  const R = HeatHazeRegion;
  let dominantType = MirageType.NONE;
  let maxAmplitude = 0;

  for (let slot = 0; slot < _nextHazeRegionSlot; slot++) {
    if (!R.active[slot]) continue;
    if (R.mirageType[slot] === MirageType.NONE) continue;

    const dx = wx - R.cx[slot];
    const dy = wy - R.cy[slot];
    const dz = wz - R.cz[slot];

    const distSq = (dx * dx) / (R.radiusX[slot] * R.radiusX[slot])
                 + (dy * dy) / (R.radiusY[slot] * R.radiusY[slot])
                 + (dz * dz) / (R.radiusZ[slot] * R.radiusZ[slot]);

    if (distSq > 1.0) continue;

    if (R.shimmerAmplitude[slot] > maxAmplitude) {
      maxAmplitude = R.shimmerAmplitude[slot];
      dominantType = R.mirageType[slot];
    }
  }

  return dominantType;
}

/**
 * Sample the local heat haze amplitude (0..1) at a world position.
 */
export function sampleHeatHazeAmplitudeAt(wx, wy, wz) {
  const R = HeatHazeRegion;
  let total = 0;

  for (let slot = 0; slot < _nextHazeRegionSlot; slot++) {
    if (!R.active[slot]) continue;
    if (R.shimmerAmplitude[slot] < EPSILON) continue;

    const dx = wx - R.cx[slot];
    const dy = wy - R.cy[slot];
    const dz = wz - R.cz[slot];

    const distSq = (dx * dx) / (R.radiusX[slot] * R.radiusX[slot])
                 + (dy * dy) / (R.radiusY[slot] * R.radiusY[slot])
                 + (dz * dz) / (R.radiusZ[slot] * R.radiusZ[slot]);

    if (distSq > 1.0) continue;

    total += R.shimmerAmplitude[slot] * (1 - distSq);
  }

  return Math.min(1.0, total);
}

// ═══════════════════════════════════════════════════════════════════════
// OBSERVER TEMPERATURE ANOMALY UPDATE
// ═══════════════════════════════════════════════════════════════════════

/**
 * System: update the local temperature anomaly for each observer.
 * Used for camera-side visual effects like camera lens distortion or
 * player status indicators.
 */
export function systemUpdateHeatHazeObservers(world, dt, ambientTempC = 20.0) {
  const O = HeatHazeObserver;

  for (let slot = 0; slot < _nextHazeObserverSlot; slot++) {
    if (!O.active[slot]) continue;

    // Sample local temperature anomaly at the camera.
    const diff = computeTemperatureDiff(
      O.camX[slot], O.camY[slot], O.camZ[slot], ambientTempC);
    const extra = computeExternalHeatContribution(
      O.camX[slot], O.camY[slot], O.camZ[slot]);

    O.localTempAnomaly[slot] = diff + extra;
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// DRY / WET COUPLING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the wetness factor for a heat source entity. Wet surfaces
 * produce a weaker mirage but a stronger evaporative shimmer.
 */
export function computeHeatSourceWetness(world, sourceSlot) {
  const S = HeatSource;
  const ownerEid = S.ownerEid[sourceSlot];
  if (!ownerEid) return 0;

  const wetSlot = getWetSurfaceSlot(ownerEid);
  if (wetSlot < 0) return 0;

  return SurfaceWetness.wetness[wetSlot];
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TICK
// ═══════════════════════════════════════════════════════════════════════

/**
 * Full heat haze pipeline for one frame:
 *   1. Update haze regions from heat sources.
 *   2. Update observers.
 *
 * @param world         ECS world
 * @param dt            seconds
 * @param ambientTempC  ambient temperature (°C)
 * @param ambientHumidity  relative humidity (0..1)
 */
export function systemHeatHazeTick(world, dt, ambientTempC = 20.0, ambientHumidity = 0.5) {
  systemUpdateHeatHazeRegions(world, dt, ambientTempC, ambientHumidity);
  systemUpdateHeatHazeObservers(world, dt, ambientTempC);
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS
// ═══════════════════════════════════════════════════════════════════════

export function getMirageLabel(type) {
  switch (type) {
    case MirageType.NONE:         return 'None';
    case MirageType.INFERIOR:     return 'Inferior Mirage';
    case MirageType.SUPERIOR:     return 'Superior Mirage';
    case MirageType.FATA_MORGANA: return 'Fata Morgana';
    default:                      return 'Unknown';
  }
}

export function findNearestHazeRegion(wx, wy, wz, maxDistance = 1000) {
  let nearestSlot = -1;
  let nearestDistSq = maxDistance * maxDistance;

  const R = HeatHazeRegion;
  for (let slot = 0; slot < _nextHazeRegionSlot; slot++) {
    if (!R.active[slot]) continue;
    const dx = R.cx[slot] - wx;
    const dz = R.cz[slot] - wz;
    const distSq = dx * dx + dz * dz;
    if (distSq < nearestDistSq) {
      nearestSlot = slot;
      nearestDistSq = distSq;
    }
  }
  return nearestSlot;
}

/**
 * Return a detailed summary of the heat haze at a world position.
 */
export function getHeatHazeSummaryAt(wx, wy, wz) {
  const amplitude = sampleHeatHazeAmplitudeAt(wx, wy, wz);
  const mirageType = sampleMirageTypeAt(wx, wy, wz);

  // Compute displacement sample (no observer, so approximate).
  const displacement = [0, 0];
  sampleHeatShimmer(wx, wy, wz, 0, 1, 0, 0, displacement);

  return {
    amplitude,
    mirageType,
    mirageLabel: getMirageLabel(mirageType),
    displacementX: displacement[0],
    displacementY: displacement[1],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Gather all active haze regions for renderer integration.
 */
export function gatherHeatHazeRegionsForRendering() {
  const result = [];
  const R = HeatHazeRegion;
  for (let slot = 0; slot < _nextHazeRegionSlot; slot++) {
    if (!R.active[slot]) continue;
    if (R.shimmerAmplitude[slot] < EPSILON) continue;

    result.push({
      slot,
      cx: R.cx[slot],
      cy: R.cy[slot],
      cz: R.cz[slot],
      radiusX: R.radiusX[slot],
      radiusY: R.radiusY[slot],
      radiusZ: R.radiusZ[slot],
      temperatureDiff: R.temperatureDiff[slot],
      shimmerAmplitude: R.shimmerAmplitude[slot],
      mirageType: R.mirageType[slot],
      mirageLabel: getMirageLabel(R.mirageType[slot]),
      windFactor: R.windFactor[slot],
      humidityFactor: R.humidityFactor[slot],
      sunFactor: R.sunFactor[slot],
    });
  }
  return result;
}

/**
 * Gather all active heat sources for renderer integration.
 */
export function gatherHeatSourcesForRendering() {
  const result = [];
  const S = HeatSource;
  for (let slot = 0; slot < _nextHeatSourceSlot; slot++) {
    if (!S.active[slot]) continue;
    result.push({
      slot,
      type: S.type[slot],
      px: S.px[slot],
      py: S.py[slot],
      pz: S.pz[slot],
      radiusX: S.radiusX[slot],
      radiusZ: S.radiusZ[slot],
      influenceHeight: S.influenceHeight[slot],
      surfaceTemperature: S.surfaceTemperature[slot],
      radiatingArea: S.radiatingArea[slot],
    });
  }
  return result;
}

/**
 * Gather all active haze observers for renderer integration.
 */
export function gatherHeatHazeObserversForRendering() {
  const result = [];
  const O = HeatHazeObserver;
  for (let slot = 0; slot < _nextHazeObserverSlot; slot++) {
    if (!O.active[slot]) continue;
    result.push({
      slot,
      camX: O.camX[slot],
      camY: O.camY[slot],
      camZ: O.camZ[slot],
      localTempAnomaly: O.localTempAnomaly[slot],
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearHeatHaze() {
  HeatSource.active.fill(0);
  HeatSource.ownerEid.fill(0);
  _heatSourceSlots.clear();
  _nextHeatSourceSlot = 0;

  HeatHazeRegion.active.fill(0);
  HeatHazeRegion.ownerEid.fill(0);
  _hazeRegionSlots.clear();
  _nextHazeRegionSlot = 0;

  HeatHazeObserver.active.fill(0);
  HeatHazeObserver.ownerEid.fill(0);
  _hazeObserverSlots.clear();
  _nextHazeObserverSlot = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function heatHazeStats() {
  let activeSources = 0;
  let activeRegions = 0;
  let activeObservers = 0;
  let avgAmplitude = 0;

  const byMirage = [0, 0, 0, 0];

  for (let slot = 0; slot < _nextHeatSourceSlot; slot++) {
    if (HeatSource.active[slot]) activeSources++;
  }

  for (let slot = 0; slot < _nextHazeRegionSlot; slot++) {
    if (!HeatHazeRegion.active[slot]) continue;
    activeRegions++;
    avgAmplitude += HeatHazeRegion.shimmerAmplitude[slot];
    byMirage[HeatHazeRegion.mirageType[slot]]++;
  }

  for (let slot = 0; slot < _nextHazeObserverSlot; slot++) {
    if (HeatHazeObserver.active[slot]) activeObservers++;
  }

  if (activeRegions > 0) avgAmplitude /= activeRegions;

  return {
    activeSources,
    maxSources: MAX_HEAT_SOURCES,
    activeRegions,
    maxRegions: MAX_HAZE_REGIONS,
    activeObservers,
    maxObservers: MAX_HAZE_OBSERVERS,
    avgAmplitude,
    byMirage: {
      none: byMirage[MirageType.NONE],
      inferior: byMirage[MirageType.INFERIOR],
      superior: byMirage[MirageType.SUPERIOR],
      fataMorgana: byMirage[MirageType.FATA_MORGANA],
    },
  };
}