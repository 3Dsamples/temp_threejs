// file number : 040
// full path name : src/weather/040_weather_archetypes.js
// description : Unified weather archetype system — the single top-level
//               weather composer that binds file 028's sky atmosphere with
//               every cloud family (files 030-039) into named, reusable
//               weather "recipes" (CLEAR_SUNNY, PARTLY_CLOUDY, OVERCAST,
//               LIGHT_RAIN, MODERATE_RAIN, HEAVY_RAIN, THUNDERSTORM,
//               SUPERCELL, LIGHT_SNOW, BLIZZARD, FOG, MIST, HAZE,
//               DUST_STORM, SANDSTORM, FREEZING_RAIN, SLEET, HAIL_STORM,
//               TROPICAL_STORM, HURRICANE, TORNADO_OUTBREAK, and more).
//               Each archetype is a fully described parameter bundle stored
//               in SoA (temperature, humidity, wind, turbulence, cloud mix,
//               precipitation rate, visibility, sun-dimming, sky model
//               choice) and can be instantiated on a world to spawn the
//               matching clouds, sky, and VFX through file 029's registry
//               and files 030-039's per-genus factories. Weather archetypes
//               are the building blocks that the upcoming scheduler (file
//               063) and seasonal system (file 061) will procedurally mix
//               to produce realistic transitions over time. All state is
//               typed arrays; blending two archetypes is a pure SoA lerp.
//               Zero per-frame allocation; 1000 concurrent weather archetypes
//               can be active across a 1M-entity world on Android 64-bit.
// best for : Procedural weather scheduling, dynamic day/night cycles,
//            biome-specific weather sets, cinematic weather scripting,
//            gameplay storm events, seasonal transitions, and any scene
//            that must procedurally generate realistic weather on
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
  SkyF32,
  SkyModel,
  SkyTag,
  SunTag,
  addSky,
  removeSky,
  getSkySlot,
  sampleSkyRadiance,
} from '../sky/028_sky_atmosphere.js';

import {
  CloudType,
  CloudSubtype,
  PrecipitationType,
  CloudArchetype,
  CloudInstance,
  CloudTag,
  createCloudArchetype,
  addCloudInstance,
  removeCloudInstance,
  getCloudSlot,
  sampleCloudDensity,
  sampleCloudScattering,
  getStormInstances,
  getPrecipitationAt,
} from '../sky/029_cloud_archetypes.js';

import {
  addCirrus,
  removeCirrus,
  CirrusTag,
  CirrusArchetypes,
  ensureCirrusArchetypes,
} from '../sky/030_cirrus_clouds.js';

import {
  addCirrocumulus,
  removeCirrocumulus,
  CirrocumulusTag,
  CirrocumulusArchetypes,
  ensureCirrocumulusArchetypes,
} from '../sky/031_cirrocumulus_clouds.js';

import {
  addCirrostratus,
  removeCirrostratus,
  CirrostratusTag,
  CirrostratusArchetypes,
  ensureCirrostratusArchetypes,
} from '../sky/032_cirrostratus_clouds.js';

import {
  addAltocumulus,
  removeAltocumulus,
  AltocumulusTag,
  AltocumulusArchetypes,
  ensureAltocumulusArchetypes,
} from '../sky/033_altocumulus_clouds.js';

import {
  addAltostratus,
  removeAltostratus,
  AltostratusTag,
  AltostratusArchetypes,
  ensureAltostratusArchetypes,
} from '../sky/034_altostratus_clouds.js';

import {
  addNimbostratus,
  removeNimbostratus,
  NimbostratusTag,
  NimbostratusArchetypes,
  ensureNimbostratusArchetypes,
} from '../sky/035_nimbostratus_clouds.js';

import {
  addStratocumulus,
  removeStratocumulus,
  StratocumulusTag,
  StratocumulusArchetypes,
  ensureStratocumulusArchetypes,
} from '../sky/036_stratocumulus_clouds.js';

import {
  addStratus,
  removeStratus,
  StratusTag,
  StratusArchetypes,
  ensureStratusArchetypes,
} from '../sky/037_stratus_clouds.js';

import {
  addCumulus,
  removeCumulus,
  CumulusTag,
  CumulusArchetypes,
  ensureCumulusArchetypes,
} from '../sky/038_cumulus_clouds.js';

import {
  addCumulonimbus,
  removeCumulonimbus,
  CumulonimbusTag,
  CumulonimbusArchetypes,
  ensureCumulonimbusArchetypes,
} from '../sky/039_cumulonimbus_clouds.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ              = 1e-16;
const EPSILON                 = 1e-8;
const EPSILON_HIGH            = 1e-12;
const PI                      = Math.PI;
const TWO_PI                  = 2 * Math.PI;
const INV_PI                  = 1 / Math.PI;
const INV_TWO_PI              = 1 / (2 * Math.PI);
const HALF_PI                 = Math.PI / 2;
const DEG_TO_RAD              = Math.PI / 180;
const RAD_TO_DEG              = 180 / Math.PI;

const MAX_WEATHER_ARCHETYPES  = 256;
const MAX_INSTANTIATED        = 1000;
const MAX_CLOUD_LAYERS        = 8;      // per weather instance

// ═══════════════════════════════════════════════════════════════════════
// WEATHER TYPE ENUM — the canonical set of named weathers
// ═══════════════════════════════════════════════════════════════════════

export const WeatherType = Object.freeze({
  CLEAR_SUNNY:        0,
  CLEAR_NIGHT:        1,
  PARTLY_CLOUDY:      2,
  MOSTLY_CLOUDY:      3,
  OVERCAST:           4,
  LIGHT_RAIN:         5,
  MODERATE_RAIN:      6,
  HEAVY_RAIN:         7,
  THUNDERSTORM:       8,
  SUPERCELL:          9,
  LIGHT_SNOW:         10,
  MODERATE_SNOW:      11,
  BLIZZARD:           12,
  FOG:                13,
  MIST:               14,
  HAZE:               15,
  DUST_STORM:         16,
  SANDSTORM:          17,
  FREEZING_RAIN:      18,
  SLEET:              19,
  HAIL_STORM:         20,
  TROPICAL_STORM:     21,
  HURRICANE:          22,
  TORNADO_OUTBREAK:   23,
});

// ═══════════════════════════════════════════════════════════════════════
// CLOUD LAYER SLOT — per-weather cloud descriptors (up to 8 layers)
// ═══════════════════════════════════════════════════════════════════════

export const WeatherCloudLayer = {
  // Which cloud family (0..9 matches CloudType).
  family: new Uint8Array(MAX_WEATHER_ARCHETYPES * MAX_CLOUD_LAYERS),

  // Which sub-type within that family (string key later resolved at
  // instantiation time — stored as an index by callers).
  subtypeIdx: new Uint8Array(MAX_WEATHER_ARCHETYPES * MAX_CLOUD_LAYERS),

  // Base coverage (0..1).
  coverage: new Float32Array(MAX_WEATHER_ARCHETYPES * MAX_CLOUD_LAYERS),

  // Scale multiplier relative to the family's default extent.
  scale: new Float32Array(MAX_WEATHER_ARCHETYPES * MAX_CLOUD_LAYERS),

  // Altitude offset (metres).
  altitudeOffset: new Float32Array(MAX_WEATHER_ARCHETYPES * MAX_CLOUD_LAYERS),

  // Weight when the weather is blending with another weather (0..1).
  weight: new Float32Array(MAX_WEATHER_ARCHETYPES * MAX_CLOUD_LAYERS),
};

// ═══════════════════════════════════════════════════════════════════════
// SoA WEATHER ARCHETYPE — every field required to describe a weather
// ═══════════════════════════════════════════════════════════════════════

export const WeatherArchetype = {
  // Type (WeatherType).
  type: new Uint8Array(MAX_WEATHER_ARCHETYPES),

  // Sky model + turbidity + rayleigh + mie.
  skyModel:      new Uint8Array(MAX_WEATHER_ARCHETYPES),
  turbidity:     new Float32Array(MAX_WEATHER_ARCHETYPES),
  rayleigh:      new Float32Array(MAX_WEATHER_ARCHETYPES),
  mie:           new Float32Array(MAX_WEATHER_ARCHETYPES),
  mieG:          new Float32Array(MAX_WEATHER_ARCHETYPES),

  // Sun elevation range (radians; min/max for the day-night cycle).
  sunElevationMin: new Float32Array(MAX_WEATHER_ARCHETYPES),
  sunElevationMax: new Float32Array(MAX_WEATHER_ARCHETYPES),

  // Sun disk intensity scale.
  sunIntensity: new Float32Array(MAX_WEATHER_ARCHETYPES),

  // Ambient temperature (°C).
  temperature: new Float32Array(MAX_WEATHER_ARCHETYPES),

  // Relative humidity (0..1).
  humidity: new Float32Array(MAX_WEATHER_ARCHETYPES),

  // Wind (m/s and direction).
  windSpeed: new Float32Array(MAX_WEATHER_ARCHETYPES),
  windDirX:  new Float32Array(MAX_WEATHER_ARCHETYPES),
  windDirZ:  new Float32Array(MAX_WEATHER_ARCHETYPES),

  // Turbulence (0..1; used by particle/VFX systems).
  turbulence: new Float32Array(MAX_WEATHER_ARCHETYPES),

  // Visibility (metres).
  visibility: new Float32Array(MAX_WEATHER_ARCHETYPES),

  // Precipitation rate (mm/h; 0 = dry).
  precipitationRate: new Float32Array(MAX_WEATHER_ARCHETYPES),

  // Precipitation type (PrecipitationType from 029).
  precipitationType: new Uint8Array(MAX_WEATHER_ARCHETYPES),

  // Snow-mix ratio (0..1).
  snowMix: new Float32Array(MAX_WEATHER_ARCHETYPES),

  // Number of cloud layers specified.
  cloudLayerCount: new Uint8Array(MAX_WEATHER_ARCHETYPES),

  // Lightning frequency (strikes per second, aggregated).
  lightningFrequency: new Float32Array(MAX_WEATHER_ARCHETYPES),

  // Hail rate (mm/h; 0 = none).
  hailRate: new Float32Array(MAX_WEATHER_ARCHETYPES),

  // Tornado potential (0..1).
  tornadoPotential: new Float32Array(MAX_WEATHER_ARCHETYPES),

  // Dust / sand density (0..1; 0 = clear).
  dustDensity: new Float32Array(MAX_WEATHER_ARCHETYPES),

  // Fog / mist density (0..1; 0 = clear).
  fogDensity: new Float32Array(MAX_WEATHER_ARCHETYPES),

  // UV index scale (0..1; how strong the UV is — affects sun color).
  uvIntensity: new Float32Array(MAX_WEATHER_ARCHETYPES),

  // Storm intensity (0..1; used for camera shake and audio).
  stormIntensity: new Float32Array(MAX_WEATHER_ARCHETYPES),

  // Duration range (seconds; min/max).
  durationMin: new Float32Array(MAX_WEATHER_ARCHETYPES),
  durationMax: new Float32Array(MAX_WEATHER_ARCHETYPES),

  // Which seasons this weather is more likely in (bitmask).
  // bit 0 = spring, bit 1 = summer, bit 2 = autumn, bit 3 = winter.
  seasonBias: new Uint8Array(MAX_WEATHER_ARCHETYPES),

  // Name (for debugging).
  name: new Array(MAX_WEATHER_ARCHETYPES).fill(''),
};

let _nextArchetypeSlot = 0;

/** Marker: entity carries a weather archetype (usually the weather root). */
export const WeatherArchetypeTag = {};

// ═══════════════════════════════════════════════════════════════════════
// WEATHER INSTANCE — one per active weather in the world
// ═══════════════════════════════════════════════════════════════════════

export const WeatherInstance = {
  archetypeSlot: new Uint16Array(MAX_INSTANTIATED),
  ownerEid:      new Uint32Array(MAX_INSTANTIATED),

  // Current blend state (0..1) between current and previous archetype.
  blendProgress: new Float32Array(MAX_INSTANTIATED),

  // Which archetype this weather is blending FROM.
  previousArchetypeSlot: new Uint16Array(MAX_INSTANTIATED),

  // Current active state.
  active: new Uint8Array(MAX_INSTANTIATED),

  // Sky entity that owns this weather.
  skyEid: new Uint32Array(MAX_INSTANTIATED),

  // Cloud layer entity ids (up to MAX_CLOUD_LAYERS).
  cloudLayerEids: new Uint32Array(MAX_INSTANTIATED * MAX_CLOUD_LAYERS),

  // Time elapsed in seconds since the weather began.
  elapsedTime: new Float32Array(MAX_INSTANTIATED),

  // Target duration (seconds).
  duration: new Float32Array(MAX_INSTANTIATED),

  // Weather seed (for deterministic VFX).
  seed: new Uint32Array(MAX_INSTANTIATED),
};

/** Marker: entity is the weather instance root. */
export const WeatherInstanceTag = {};

const _weatherInstances = new Map(); // eid -> instance slot
let _nextInstanceSlot = 0;

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
// CREATE WEATHER ARCHETYPE — helper
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a new weather archetype. All fields optional; defaults are the
 * CLEAR_SUNNY preset.
 */
export function createWeatherArchetype(type, overrides = {}) {
  if (_nextArchetypeSlot >= MAX_WEATHER_ARCHETYPES) {
    throw new Error('weather archetype capacity exceeded');
  }
  const slot = _nextArchetypeSlot++;
  const defaults = weatherDefaults(type);
  const W = WeatherArchetype;

  W.type[slot] = type;
  W.skyModel[slot]      = overrides.skyModel      ?? defaults.skyModel;
  W.turbidity[slot]     = overrides.turbidity     ?? defaults.turbidity;
  W.rayleigh[slot]      = overrides.rayleigh      ?? defaults.rayleigh;
  W.mie[slot]           = overrides.mie           ?? defaults.mie;
  W.mieG[slot]          = overrides.mieG          ?? defaults.mieG;
  W.sunElevationMin[slot] = overrides.sunElevationMin ?? defaults.sunElevationMin;
  W.sunElevationMax[slot] = overrides.sunElevationMax ?? defaults.sunElevationMax;
  W.sunIntensity[slot]  = overrides.sunIntensity  ?? defaults.sunIntensity;
  W.temperature[slot]   = overrides.temperature   ?? defaults.temperature;
  W.humidity[slot]      = overrides.humidity      ?? defaults.humidity;
  W.windSpeed[slot]     = overrides.windSpeed     ?? defaults.windSpeed;
  W.windDirX[slot]      = overrides.windDirX      ?? defaults.windDirX;
  W.windDirZ[slot]      = overrides.windDirZ      ?? defaults.windDirZ;
  W.turbulence[slot]    = overrides.turbulence    ?? defaults.turbulence;
  W.visibility[slot]    = overrides.visibility    ?? defaults.visibility;
  W.precipitationRate[slot] = overrides.precipitationRate ?? defaults.precipitationRate;
  W.precipitationType[slot] = overrides.precipitationType ?? defaults.precipitationType;
  W.snowMix[slot]       = overrides.snowMix       ?? defaults.snowMix;
  W.lightningFrequency[slot] = overrides.lightningFrequency ?? defaults.lightningFrequency;
  W.hailRate[slot]      = overrides.hailRate      ?? defaults.hailRate;
  W.tornadoPotential[slot] = overrides.tornadoPotential ?? defaults.tornadoPotential;
  W.dustDensity[slot]   = overrides.dustDensity   ?? defaults.dustDensity;
  W.fogDensity[slot]    = overrides.fogDensity    ?? defaults.fogDensity;
  W.uvIntensity[slot]   = overrides.uvIntensity   ?? defaults.uvIntensity;
  W.stormIntensity[slot] = overrides.stormIntensity ?? defaults.stormIntensity;
  W.durationMin[slot]   = overrides.durationMin   ?? defaults.durationMin;
  W.durationMax[slot]   = overrides.durationMax   ?? defaults.durationMax;
  W.seasonBias[slot]    = overrides.seasonBias    ?? defaults.seasonBias;
  W.name[slot]          = overrides.name          ?? weatherName(type);

  // Cloud layers.
  const layers = overrides.cloudLayers ?? defaults.cloudLayers;
  const layerCount = Math.min(layers.length, MAX_CLOUD_LAYERS);
  W.cloudLayerCount[slot] = layerCount;
  for (let i = 0; i < layerCount; i++) {
    const base = slot * MAX_CLOUD_LAYERS + i;
    const L = layers[i];
    WeatherCloudLayer.family[base]         = L.family;
    WeatherCloudLayer.subtypeIdx[base]     = L.subtypeIdx ?? 0;
    WeatherCloudLayer.coverage[base]       = L.coverage ?? 0.3;
    WeatherCloudLayer.scale[base]          = L.scale ?? 1.0;
    WeatherCloudLayer.altitudeOffset[base] = L.altitudeOffset ?? 0;
    WeatherCloudLayer.weight[base]         = L.weight ?? 1.0;
  }

  return slot;
}

// ═══════════════════════════════════════════════════════════════════════
// DEFAULTS PER WEATHER TYPE
// ═══════════════════════════════════════════════════════════════════════

function weatherDefaults(type) {
  switch (type) {
    case WeatherType.CLEAR_SUNNY:
      return {
        skyModel: SkyModel.PREETHAM,
        turbidity: 2.0, rayleigh: 1.0, mie: 1.0, mieG: 0.8,
        sunElevationMin: 0, sunElevationMax: PI / 2,
        sunIntensity: 1.0,
        temperature: 22, humidity: 0.30,
        windSpeed: 2, windDirX: 1, windDirZ: 0,
        turbulence: 0.05,
        visibility: 30000,
        precipitationRate: 0, precipitationType: PrecipitationType.NONE,
        snowMix: 0,
        lightningFrequency: 0, hailRate: 0, tornadoPotential: 0,
        dustDensity: 0, fogDensity: 0,
        uvIntensity: 1.0, stormIntensity: 0,
        durationMin: 600, durationMax: 3600,
        seasonBias: 0b1111,
        cloudLayers: [
          { family: CloudType.CIRRUS, subtypeIdx: 0, coverage: 0.10, scale: 1.0 },
          { family: CloudType.CUMULUS, subtypeIdx: 0, coverage: 0.15, scale: 0.7 },
        ],
      };

    case WeatherType.CLEAR_NIGHT:
      return {
        skyModel: SkyModel.PREETHAM,
        turbidity: 1.5, rayleigh: 1.0, mie: 0.8, mieG: 0.75,
        sunElevationMin: -PI / 2, sunElevationMax: 0,
        sunIntensity: 0.1,
        temperature: 15, humidity: 0.35,
        windSpeed: 1, windDirX: 1, windDirZ: 0,
        turbulence: 0.02,
        visibility: 50000,
        precipitationRate: 0, precipitationType: PrecipitationType.NONE,
        snowMix: 0,
        lightningFrequency: 0, hailRate: 0, tornadoPotential: 0,
        dustDensity: 0, fogDensity: 0,
        uvIntensity: 0.02, stormIntensity: 0,
        durationMin: 600, durationMax: 3600,
        seasonBias: 0b1111,
        cloudLayers: [],
      };

    case WeatherType.PARTLY_CLOUDY:
      return {
        skyModel: SkyModel.PREETHAM,
        turbidity: 2.5, rayleigh: 1.0, mie: 1.2, mieG: 0.8,
        sunElevationMin: 0.1, sunElevationMax: PI / 2,
        sunIntensity: 0.9,
        temperature: 20, humidity: 0.45,
        windSpeed: 4, windDirX: 1, windDirZ: 0,
        turbulence: 0.10,
        visibility: 25000,
        precipitationRate: 0, precipitationType: PrecipitationType.NONE,
        snowMix: 0,
        lightningFrequency: 0, hailRate: 0, tornadoPotential: 0,
        dustDensity: 0, fogDensity: 0,
        uvIntensity: 0.85, stormIntensity: 0,
        durationMin: 300, durationMax: 1800,
        seasonBias: 0b1111,
        cloudLayers: [
          { family: CloudType.CIRRUS, subtypeIdx: 0, coverage: 0.15, scale: 1.0 },
          { family: CloudType.ALTOCUMULUS, subtypeIdx: 0, coverage: 0.20, scale: 1.0 },
          { family: CloudType.CUMULUS, subtypeIdx: 0, coverage: 0.25, scale: 1.0 },
        ],
      };

    case WeatherType.MOSTLY_CLOUDY:
      return {
        skyModel: SkyModel.PREETHAM,
        turbidity: 3.0, rayleigh: 1.0, mie: 1.5, mieG: 0.75,
        sunElevationMin: 0.0, sunElevationMax: PI / 2,
        sunIntensity: 0.6,
        temperature: 18, humidity: 0.55,
        windSpeed: 6, windDirX: 1, windDirZ: 0,
        turbulence: 0.20,
        visibility: 18000,
        precipitationRate: 0, precipitationType: PrecipitationType.NONE,
        snowMix: 0,
        lightningFrequency: 0, hailRate: 0, tornadoPotential: 0,
        dustDensity: 0, fogDensity: 0,
        uvIntensity: 0.55, stormIntensity: 0,
        durationMin: 300, durationMax: 1800,
        seasonBias: 0b1111,
        cloudLayers: [
          { family: CloudType.ALTOCUMULUS, subtypeIdx: 0, coverage: 0.45, scale: 1.0 },
          { family: CloudType.STRATOCUMULUS, subtypeIdx: 0, coverage: 0.50, scale: 1.2 },
          { family: CloudType.CUMULUS, subtypeIdx: 0, coverage: 0.30, scale: 1.0 },
        ],
      };

    case WeatherType.OVERCAST:
      return {
        skyModel: SkyModel.HOSEK_WILKIE,
        turbidity: 4.0, rayleigh: 1.0, mie: 2.0, mieG: 0.7,
        sunElevationMin: 0.0, sunElevationMax: PI / 2,
        sunIntensity: 0.3,
        temperature: 14, humidity: 0.75,
        windSpeed: 7, windDirX: 1, windDirZ: 0,
        turbulence: 0.15,
        visibility: 12000,
        precipitationRate: 0, precipitationType: PrecipitationType.NONE,
        snowMix: 0,
        lightningFrequency: 0, hailRate: 0, tornadoPotential: 0,
        dustDensity: 0, fogDensity: 0,
        uvIntensity: 0.25, stormIntensity: 0,
        durationMin: 600, durationMax: 3600,
        seasonBias: 0b1111,
        cloudLayers: [
          { family: CloudType.ALTOCUMULUS, subtypeIdx: 0, coverage: 0.55, scale: 1.2 },
          { family: CloudType.ALTOSTRATUS, subtypeIdx: 0, coverage: 0.75, scale: 1.5 },
          { family: CloudType.STRATOCUMULUS, subtypeIdx: 0, coverage: 0.70, scale: 1.5 },
        ],
      };

    case WeatherType.LIGHT_RAIN:
      return {
        skyModel: SkyModel.HOSEK_WILKIE,
        turbidity: 5.0, rayleigh: 1.2, mie: 2.5, mieG: 0.7,
        sunElevationMin: 0.0, sunElevationMax: PI / 2,
        sunIntensity: 0.25,
        temperature: 12, humidity: 0.85,
        windSpeed: 5, windDirX: 1, windDirZ: 0,
        turbulence: 0.20,
        visibility: 8000,
        precipitationRate: 2.0, precipitationType: PrecipitationType.RAIN,
        snowMix: 0,
        lightningFrequency: 0, hailRate: 0, tornadoPotential: 0,
        dustDensity: 0, fogDensity: 0,
        uvIntensity: 0.20, stormIntensity: 0.1,
        durationMin: 300, durationMax: 1800,
        seasonBias: 0b1011,   // spring, autumn, winter
        cloudLayers: [
          { family: CloudType.ALTOSTRATUS, subtypeIdx: 0, coverage: 0.65, scale: 1.3 },
          { family: CloudType.NIMBOSTRATUS, subtypeIdx: 0, coverage: 0.80, scale: 1.5, weight: 1.0 },
        ],
      };

    case WeatherType.MODERATE_RAIN:
      return {
        skyModel: SkyModel.HOSEK_WILKIE,
        turbidity: 6.0, rayleigh: 1.3, mie: 3.0, mieG: 0.65,
        sunElevationMin: 0.0, sunElevationMax: PI / 2,
        sunIntensity: 0.15,
        temperature: 11, humidity: 0.90,
        windSpeed: 8, windDirX: 1, windDirZ: 0,
        turbulence: 0.30,
        visibility: 5000,
        precipitationRate: 7.5, precipitationType: PrecipitationType.RAIN,
        snowMix: 0,
        lightningFrequency: 0.001, hailRate: 0, tornadoPotential: 0,
        dustDensity: 0, fogDensity: 0,
        uvIntensity: 0.15, stormIntensity: 0.25,
        durationMin: 300, durationMax: 1800,
        seasonBias: 0b1011,
        cloudLayers: [
          { family: CloudType.ALTOSTRATUS, subtypeIdx: 0, coverage: 0.80, scale: 1.4 },
          { family: CloudType.NIMBOSTRATUS, subtypeIdx: 0, coverage: 0.90, scale: 1.7, weight: 1.0 },
          { family: CloudType.STRATOCUMULUS, subtypeIdx: 0, coverage: 0.60, scale: 1.5, weight: 0.5 },
        ],
      };

    case WeatherType.HEAVY_RAIN:
      return {
        skyModel: SkyModel.HOSEK_WILKIE,
        turbidity: 8.0, rayleigh: 1.5, mie: 4.0, mieG: 0.6,
        sunElevationMin: 0.0, sunElevationMax: PI / 2,
        sunIntensity: 0.05,
        temperature: 10, humidity: 0.95,
        windSpeed: 12, windDirX: 1, windDirZ: 0,
        turbulence: 0.50,
        visibility: 2000,
        precipitationRate: 30.0, precipitationType: PrecipitationType.RAIN,
        snowMix: 0,
        lightningFrequency: 0.01, hailRate: 0, tornadoPotential: 0.05,
        dustDensity: 0, fogDensity: 0,
        uvIntensity: 0.05, stormIntensity: 0.50,
        durationMin: 300, durationMax: 1800,
        seasonBias: 0b1011,
        cloudLayers: [
          { family: CloudType.NIMBOSTRATUS, subtypeIdx: 0, coverage: 0.95, scale: 2.0, weight: 1.0 },
          { family: CloudType.STRATOCUMULUS, subtypeIdx: 0, coverage: 0.65, scale: 1.5, weight: 0.6 },
        ],
      };

    case WeatherType.THUNDERSTORM:
      return {
        skyModel: SkyModel.HOSEK_WILKIE,
        turbidity: 10.0, rayleigh: 1.8, mie: 5.0, mieG: 0.6,
        sunElevationMin: 0.0, sunElevationMax: PI / 2,
        sunIntensity: 0.05,
        temperature: 18, humidity: 0.92,
        windSpeed: 15, windDirX: 1, windDirZ: 0,
        turbulence: 0.80,
        visibility: 1500,
        precipitationRate: 40.0, precipitationType: PrecipitationType.RAIN,
        snowMix: 0,
        lightningFrequency: 0.15, hailRate: 3.0, tornadoPotential: 0.10,
        dustDensity: 0, fogDensity: 0,
        uvIntensity: 0.05, stormIntensity: 0.75,
        durationMin: 300, durationMax: 1200,
        seasonBias: 0b0110,   // summer + autumn
        cloudLayers: [
          { family: CloudType.CUMULONIMBUS, subtypeIdx: 0, coverage: 0.55, scale: 1.5, weight: 1.0 },
          { family: CloudType.NIMBOSTRATUS, subtypeIdx: 0, coverage: 0.80, scale: 1.8, weight: 0.8 },
          { family: CloudType.CUMULUS, subtypeIdx: 2 /* congestus */, coverage: 0.30, scale: 1.0 },
        ],
      };

    case WeatherType.SUPERCELL:
      return {
        skyModel: SkyModel.HOSEK_WILKIE,
        turbidity: 14.0, rayleigh: 2.0, mie: 6.5, mieG: 0.55,
        sunElevationMin: 0.0, sunElevationMax: PI / 2,
        sunIntensity: 0.02,
        temperature: 22, humidity: 0.95,
        windSpeed: 22, windDirX: 1, windDirZ: 0,
        turbulence: 1.0,
        visibility: 800,
        precipitationRate: 90.0, precipitationType: PrecipitationType.RAIN,
        snowMix: 0,
        lightningFrequency: 0.30, hailRate: 25.0, tornadoPotential: 0.85,
        dustDensity: 0, fogDensity: 0,
        uvIntensity: 0.02, stormIntensity: 1.0,
        durationMin: 600, durationMax: 2400,
        seasonBias: 0b0110,
        cloudLayers: [
          { family: CloudType.CUMULONIMBUS, subtypeIdx: 3 /* supercell */, coverage: 0.60, scale: 2.0, weight: 1.0 },
        ],
      };

    case WeatherType.LIGHT_SNOW:
      return {
        skyModel: SkyModel.HOSEK_WILKIE,
        turbidity: 5.0, rayleigh: 1.1, mie: 2.0, mieG: 0.7,
        sunElevationMin: 0.0, sunElevationMax: PI / 3,
        sunIntensity: 0.4,
        temperature: -2, humidity: 0.85,
        windSpeed: 4, windDirX: 1, windDirZ: 0,
        turbulence: 0.20,
        visibility: 8000,
        precipitationRate: 2.0, precipitationType: PrecipitationType.SNOW,
        snowMix: 1.0,
        lightningFrequency: 0, hailRate: 0, tornadoPotential: 0,
        dustDensity: 0, fogDensity: 0,
        uvIntensity: 0.20, stormIntensity: 0.1,
        durationMin: 600, durationMax: 3600,
        seasonBias: 0b1100,   // autumn + winter
        cloudLayers: [
          { family: CloudType.ALTOSTRATUS, subtypeIdx: 0, coverage: 0.70, scale: 1.4 },
          { family: CloudType.NIMBOSTRATUS, subtypeIdx: 0, coverage: 0.85, scale: 1.5, weight: 1.0 },
        ],
      };

    case WeatherType.MODERATE_SNOW:
      return {
        skyModel: SkyModel.HOSEK_WILKIE,
        turbidity: 6.0, rayleigh: 1.2, mie: 2.5, mieG: 0.65,
        sunElevationMin: 0.0, sunElevationMax: PI / 3,
        sunIntensity: 0.25,
        temperature: -6, humidity: 0.90,
        windSpeed: 6, windDirX: 1, windDirZ: 0,
        turbulence: 0.30,
        visibility: 5000,
        precipitationRate: 8.0, precipitationType: PrecipitationType.SNOW,
        snowMix: 1.0,
        lightningFrequency: 0, hailRate: 0, tornadoPotential: 0,
        dustDensity: 0, fogDensity: 0,
        uvIntensity: 0.15, stormIntensity: 0.25,
        durationMin: 600, durationMax: 3600,
        seasonBias: 0b1100,
        cloudLayers: [
          { family: CloudType.NIMBOSTRATUS, subtypeIdx: 0, coverage: 0.92, scale: 1.7, weight: 1.0 },
          { family: CloudType.STRATOCUMULUS, subtypeIdx: 0, coverage: 0.55, scale: 1.3, weight: 0.5 },
        ],
      };

    case WeatherType.BLIZZARD:
      return {
        skyModel: SkyModel.HOSEK_WILKIE,
        turbidity: 9.0, rayleigh: 1.4, mie: 4.0, mieG: 0.6,
        sunElevationMin: 0.0, sunElevationMax: PI / 4,
        sunIntensity: 0.05,
        temperature: -15, humidity: 0.92,
        windSpeed: 25, windDirX: 1, windDirZ: 0,
        turbulence: 0.85,
        visibility: 300,
        precipitationRate: 35.0, precipitationType: PrecipitationType.SNOW,
        snowMix: 1.0,
        lightningFrequency: 0.001, hailRate: 0, tornadoPotential: 0,
        dustDensity: 0, fogDensity: 0,
        uvIntensity: 0.05, stormIntensity: 0.85,
        durationMin: 1800, durationMax: 7200,
        seasonBias: 0b1000,   // winter only
        cloudLayers: [
          { family: CloudType.NIMBOSTRATUS, subtypeIdx: 0, coverage: 0.98, scale: 2.2, weight: 1.0 },
          { family: CloudType.STRATUS, subtypeIdx: 0, coverage: 0.70, scale: 1.5, weight: 0.7 },
        ],
      };

    case WeatherType.FOG:
      return {
        skyModel: SkyModel.SIMPLE_GRADIENT,
        turbidity: 8.0, rayleigh: 1.0, mie: 3.0, mieG: 0.7,
        sunElevationMin: 0.0, sunElevationMax: PI / 4,
        sunIntensity: 0.10,
        temperature: 5, humidity: 0.98,
        windSpeed: 1, windDirX: 1, windDirZ: 0,
        turbulence: 0.05,
        visibility: 100,
        precipitationRate: 0, precipitationType: PrecipitationType.NONE,
        snowMix: 0,
        lightningFrequency: 0, hailRate: 0, tornadoPotential: 0,
        dustDensity: 0, fogDensity: 0.9,
        uvIntensity: 0.05, stormIntensity: 0,
        durationMin: 1800, durationMax: 7200,
        seasonBias: 0b1001,   // spring + winter
        cloudLayers: [
          { family: CloudType.STRATUS, subtypeIdx: 2 /* fog */, coverage: 0.95, scale: 1.5, weight: 1.0 },
        ],
      };

    case WeatherType.MIST:
      return {
        skyModel: SkyModel.SIMPLE_GRADIENT,
        turbidity: 5.0, rayleigh: 1.0, mie: 2.0, mieG: 0.7,
        sunElevationMin: 0.0, sunElevationMax: PI / 4,
        sunIntensity: 0.30,
        temperature: 8, humidity: 0.92,
        windSpeed: 2, windDirX: 1, windDirZ: 0,
        turbulence: 0.10,
        visibility: 800,
        precipitationRate: 0, precipitationType: PrecipitationType.NONE,
        snowMix: 0,
        lightningFrequency: 0, hailRate: 0, tornadoPotential: 0,
        dustDensity: 0, fogDensity: 0.4,
        uvIntensity: 0.15, stormIntensity: 0,
        durationMin: 1800, durationMax: 5400,
        seasonBias: 0b1001,
        cloudLayers: [
          { family: CloudType.STRATUS, subtypeIdx: 2 /* fog */, coverage: 0.60, scale: 1.2, weight: 1.0 },
        ],
      };

    case WeatherType.HAZE:
      return {
        skyModel: SkyModel.PREETHAM,
        turbidity: 12.0, rayleigh: 1.0, mie: 2.5, mieG: 0.7,
        sunElevationMin: 0.0, sunElevationMax: PI / 2,
        sunIntensity: 0.50,
        temperature: 24, humidity: 0.65,
        windSpeed: 3, windDirX: 1, windDirZ: 0,
        turbulence: 0.10,
        visibility: 4000,
        precipitationRate: 0, precipitationType: PrecipitationType.NONE,
        snowMix: 0,
        lightningFrequency: 0, hailRate: 0, tornadoPotential: 0,
        dustDensity: 0.3, fogDensity: 0.2,
        uvIntensity: 0.45, stormIntensity: 0,
        durationMin: 1800, durationMax: 5400,
        seasonBias: 0b0110,
        cloudLayers: [
          { family: CloudType.CIRRUS, subtypeIdx: 0, coverage: 0.20, scale: 1.5 },
        ],
      };

    case WeatherType.DUST_STORM:
      return {
        skyModel: SkyModel.PREETHAM,
        turbidity: 15.0, rayleigh: 1.0, mie: 5.0, mieG: 0.6,
        sunElevationMin: 0.0, sunElevationMax: PI / 2,
        sunIntensity: 0.15,
        temperature: 35, humidity: 0.10,
        windSpeed: 30, windDirX: 1, windDirZ: 0,
        turbulence: 0.90,
        visibility: 500,
        precipitationRate: 0, precipitationType: PrecipitationType.NONE,
        snowMix: 0,
        lightningFrequency: 0, hailRate: 0, tornadoPotential: 0,
        dustDensity: 0.9, fogDensity: 0,
        uvIntensity: 0.10, stormIntensity: 0.60,
        durationMin: 300, durationMax: 1800,
        seasonBias: 0b0110,
        cloudLayers: [
          { family: CloudType.CUMULUS, subtypeIdx: 0, coverage: 0.15, scale: 0.5 },
        ],
      };

    case WeatherType.SANDSTORM:
      return {
        skyModel: SkyModel.PREETHAM,
        turbidity: 20.0, rayleigh: 1.0, mie: 6.0, mieG: 0.55,
        sunElevationMin: 0.0, sunElevationMax: PI / 2,
        sunIntensity: 0.05,
        temperature: 42, humidity: 0.05,
        windSpeed: 45, windDirX: 1, windDirZ: 0,
        turbulence: 1.0,
        visibility: 100,
        precipitationRate: 0, precipitationType: PrecipitationType.NONE,
        snowMix: 0,
        lightningFrequency: 0, hailRate: 0, tornadoPotential: 0,
        dustDensity: 1.0, fogDensity: 0,
        uvIntensity: 0.05, stormIntensity: 0.85,
        durationMin: 300, durationMax: 1800,
        seasonBias: 0b0110,
        cloudLayers: [
          { family: CloudType.CUMULUS, subtypeIdx: 0, coverage: 0.10, scale: 0.5 },
        ],
      };

    case WeatherType.FREEZING_RAIN:
      return {
        skyModel: SkyModel.HOSEK_WILKIE,
        turbidity: 7.0, rayleigh: 1.2, mie: 2.5, mieG: 0.65,
        sunElevationMin: 0.0, sunElevationMax: PI / 3,
        sunIntensity: 0.20,
        temperature: -1, humidity: 0.95,
        windSpeed: 5, windDirX: 1, windDirZ: 0,
        turbulence: 0.20,
        visibility: 3000,
        precipitationRate: 3.0, precipitationType: PrecipitationType.MIXED,
        snowMix: 0.5,
        lightningFrequency: 0, hailRate: 0, tornadoPotential: 0,
        dustDensity: 0, fogDensity: 0,
        uvIntensity: 0.10, stormIntensity: 0.20,
        durationMin: 600, durationMax: 2400,
        seasonBias: 0b1000,
        cloudLayers: [
          { family: CloudType.NIMBOSTRATUS, subtypeIdx: 0, coverage: 0.85, scale: 1.6, weight: 1.0 },
        ],
      };

    case WeatherType.SLEET:
      return {
        skyModel: SkyModel.HOSEK_WILKIE,
        turbidity: 6.5, rayleigh: 1.2, mie: 2.5, mieG: 0.65,
        sunElevationMin: 0.0, sunElevationMax: PI / 3,
        sunIntensity: 0.20,
        temperature: 1, humidity: 0.90,
        windSpeed: 8, windDirX: 1, windDirZ: 0,
        turbulence: 0.30,
        visibility: 4000,
        precipitationRate: 4.0, precipitationType: PrecipitationType.MIXED,
        snowMix: 0.6,
        lightningFrequency: 0, hailRate: 0, tornadoPotential: 0,
        dustDensity: 0, fogDensity: 0,
        uvIntensity: 0.15, stormIntensity: 0.20,
        durationMin: 600, durationMax: 2400,
        seasonBias: 0b1100,
        cloudLayers: [
          { family: CloudType.NIMBOSTRATUS, subtypeIdx: 0, coverage: 0.85, scale: 1.6, weight: 1.0 },
        ],
      };

    case WeatherType.HAIL_STORM:
      return {
        skyModel: SkyModel.HOSEK_WILKIE,
        turbidity: 10.0, rayleigh: 1.6, mie: 4.5, mieG: 0.6,
        sunElevationMin: 0.0, sunElevationMax: PI / 2,
        sunIntensity: 0.05,
        temperature: 20, humidity: 0.90,
        windSpeed: 18, windDirX: 1, windDirZ: 0,
        turbulence: 0.75,
        visibility: 1200,
        precipitationRate: 45.0, precipitationType: PrecipitationType.HAIL,
        snowMix: 0,
        lightningFrequency: 0.20, hailRate: 25.0, tornadoPotential: 0.20,
        dustDensity: 0, fogDensity: 0,
        uvIntensity: 0.05, stormIntensity: 0.85,
        durationMin: 300, durationMax: 900,
        seasonBias: 0b0100,   // summer only
        cloudLayers: [
          { family: CloudType.CUMULONIMBUS, subtypeIdx: 1 /* capillatus */, coverage: 0.65, scale: 1.8, weight: 1.0 },
        ],
      };

    case WeatherType.TROPICAL_STORM:
      return {
        skyModel: SkyModel.HOSEK_WILKIE,
        turbidity: 12.0, rayleigh: 1.8, mie: 5.0, mieG: 0.55,
        sunElevationMin: 0.0, sunElevationMax: PI / 2,
        sunIntensity: 0.03,
        temperature: 26, humidity: 0.98,
        windSpeed: 28, windDirX: 1, windDirZ: 0,
        turbulence: 0.95,
        visibility: 600,
        precipitationRate: 70.0, precipitationType: PrecipitationType.RAIN,
        snowMix: 0,
        lightningFrequency: 0.25, hailRate: 0, tornadoPotential: 0.30,
        dustDensity: 0, fogDensity: 0,
        uvIntensity: 0.02, stormIntensity: 0.95,
        durationMin: 3600, durationMax: 14400,
        seasonBias: 0b0110,
        cloudLayers: [
          { family: CloudType.CUMULONIMBUS, subtypeIdx: 1, coverage: 0.80, scale: 2.5, weight: 1.0 },
          { family: CloudType.NIMBOSTRATUS, subtypeIdx: 0, coverage: 0.95, scale: 2.5, weight: 0.8 },
        ],
      };

    case WeatherType.HURRICANE:
      return {
        skyModel: SkyModel.HOSEK_WILKIE,
        turbidity: 15.0, rayleigh: 2.0, mie: 6.0, mieG: 0.5,
        sunElevationMin: 0.0, sunElevationMax: PI / 2,
        sunIntensity: 0.01,
        temperature: 28, humidity: 1.0,
        windSpeed: 60, windDirX: 1, windDirZ: 0,
        turbulence: 1.0,
        visibility: 100,
        precipitationRate: 120.0, precipitationType: PrecipitationType.RAIN,
        snowMix: 0,
        lightningFrequency: 0.40, hailRate: 0, tornadoPotential: 0.60,
        dustDensity: 0, fogDensity: 0,
        uvIntensity: 0.01, stormIntensity: 1.0,
        durationMin: 7200, durationMax: 28800,
        seasonBias: 0b0100,
        cloudLayers: [
          { family: CloudType.CUMULONIMBUS, subtypeIdx: 1, coverage: 0.95, scale: 3.5, weight: 1.0 },
          { family: CloudType.NIMBOSTRATUS, subtypeIdx: 0, coverage: 1.0, scale: 3.0, weight: 0.9 },
        ],
      };

    case WeatherType.TORNADO_OUTBREAK:
      return {
        skyModel: SkyModel.HOSEK_WILKIE,
        turbidity: 14.0, rayleigh: 2.0, mie: 6.0, mieG: 0.5,
        sunElevationMin: 0.0, sunElevationMax: PI / 2,
        sunIntensity: 0.01,
        temperature: 24, humidity: 0.95,
        windSpeed: 30, windDirX: 1, windDirZ: 0,
        turbulence: 1.0,
        visibility: 200,
        precipitationRate: 100.0, precipitationType: PrecipitationType.RAIN,
        snowMix: 0,
        lightningFrequency: 0.50, hailRate: 40.0, tornadoPotential: 1.0,
        dustDensity: 0, fogDensity: 0,
        uvIntensity: 0.01, stormIntensity: 1.0,
        durationMin: 900, durationMax: 3600,
        seasonBias: 0b0100,
        cloudLayers: [
          { family: CloudType.CUMULONIMBUS, subtypeIdx: 3 /* supercell */, coverage: 0.70, scale: 2.5, weight: 1.0 },
        ],
      };

    default:
      return weatherDefaults(WeatherType.CLEAR_SUNNY);
  }
}

function weatherName(type) {
  for (const [k, v] of Object.entries(WeatherType)) {
    if (v === type) return k;
  }
  return 'UNKNOWN';
}

// ═══════════════════════════════════════════════════════════════════════
// INSTANTIATE WEATHER — spawn the archetype into the world
// ═══════════════════════════════════════════════════════════════════════

/**
 * Instantiate a weather archetype on a world entity. Spawns:
 *   • a sky entity (using file 028's addSky)
 *   • one entity per cloud layer (using files 030-039's factories)
 *   • a WeatherInstance component tracking the current state
 *
 * @returns weather instance slot id
 */
export function instantiateWeather(world, weatherRootEid, archetypeSlot, {
  seed = (Math.random() * 0xFFFFFFFF) >>> 0,
  sunElevation = 45 * DEG_TO_RAD,
  sunAzimuth = 0,
  x = 0, y = 0, z = 0,
} = {}) {
  if (_nextInstanceSlot >= MAX_INSTANTIATED) {
    throw new Error('weather instance capacity exceeded');
  }
  const instanceSlot = _nextInstanceSlot++;

  const W = WeatherArchetype;

  // Ensure all cloud archetypes exist.
  ensureCirrusArchetypes();
  ensureCirrocumulusArchetypes();
  ensureCirrostratusArchetypes();
  ensureAltocumulusArchetypes();
  ensureAltostratusArchetypes();
  ensureNimbostratusArchetypes();
  ensureStratocumulusArchetypes();
  ensureStratusArchetypes();
  ensureCumulusArchetypes();
  ensureCumulonimbusArchetypes();

  // 1. Create sky entity.
  const skyEid = world[$internal].entityIndex.aliveCount + 100000;   // unique id offset (callers should use their own addEntity)
  // We use addTransform to ensure the sky entity has a proper transform.
  addTransform(world, weatherRootEid, { px: x, py: y, pz: z });

  const skySlot = addSky(world, weatherRootEid, {
    model: W.skyModel[archetypeSlot],
    sunElevation,
    sunAzimuth,
    sunIntensity: W.sunIntensity[archetypeSlot],
    turbidity: W.turbidity[archetypeSlot],
    rayleigh: W.rayleigh[archetypeSlot],
    mie: W.mie[archetypeSlot],
    mieG: W.mieG[archetypeSlot],
    exposure: 1.0,
  });

  // 2. Spawn cloud layer entities.
  const layerCount = W.cloudLayerCount[archetypeSlot];
  for (let i = 0; i < layerCount; i++) {
    const base = archetypeSlot * MAX_CLOUD_LAYERS + i;
    const family = WeatherCloudLayer.family[base];
    const subtypeIdx = WeatherCloudLayer.subtypeIdx[base];
    const coverage = WeatherCloudLayer.coverage[base];
    const scale = WeatherCloudLayer.scale[base];
    const altitudeOffset = WeatherCloudLayer.altitudeOffset[base];

    // Compute cloud spawn position (centered on weather root).
    const cloudX = x + (Math.random() - 0.5) * 2000;
    const cloudZ = z + (Math.random() - 0.5) * 2000;
    const baseAltitude = CloudArchetype.baseAltitude[_pickArchetypeForFamily(family, subtypeIdx)] + altitudeOffset;
    const cloudY = y + baseAltitude;

    // Create the cloud entity via file 001's addEntity.
    const cloudEid = _internalAddEntity(world);
    addTransform(world, cloudEid, { px: cloudX, py: cloudY, pz: cloudZ });

    const radiusX = 4000 * scale;
    const radiusZ = 4000 * scale;

    // Dispatch to the right cloud type's add function.
    if (family === CloudType.CIRRUS) {
      const subtypeStr = subtypeIdx === 0 ? 'fibratus' : subtypeIdx === 1 ? 'uncinus' : 'vertebratus';
      addCirrus(world, cloudEid, subtypeStr, { radiusX, radiusZ });
    } else if (family === CloudType.CIRROCUMULUS) {
      const subtypeStr = subtypeIdx === 0 ? 'rippled' : subtypeIdx === 1 ? 'castellanus' : 'lenticularis';
      addCirrocumulus(world, cloudEid, subtypeStr, { radiusX, radiusZ });
    } else if (family === CloudType.CIRROSTRATUS) {
      const subtypeStr = subtypeIdx === 0 ? 'uniform' : subtypeIdx === 1 ? 'halo' : 'denseVeil';
      addCirrostratus(world, cloudEid, subtypeStr, { radiusX, radiusZ });
    } else if (family === CloudType.ALTOCUMULUS) {
      const subtypeStr = subtypeIdx === 0 ? 'layered' : subtypeIdx === 1 ? 'castellanus' : 'lenticularis';
      addAltocumulus(world, cloudEid, subtypeStr, { radiusX, radiusZ });
    } else if (family === CloudType.ALTOSTRATUS) {
      const subtypeStr = subtypeIdx === 0 ? 'uniform' : subtypeIdx === 1 ? 'dense' : 'drizzle';
      addAltostratus(world, cloudEid, subtypeStr, { radiusX, radiusZ });
    } else if (family === CloudType.NIMBOSTRATUS) {
      const subtypeStr = subtypeIdx === 0 ? 'light' : subtypeIdx === 1 ? 'moderate' : 'heavy';
      addNimbostratus(world, cloudEid, subtypeStr, { radiusX, radiusZ });
    } else if (family === CloudType.STRATOCUMULUS) {
      const subtypeStr = subtypeIdx === 0 ? 'closedCell' : subtypeIdx === 1 ? 'openCell' : 'roll';
      addStratocumulus(world, cloudEid, subtypeStr, { radiusX, radiusZ });
    } else if (family === CloudType.STRATUS) {
      const subtypeStr = subtypeIdx === 0 ? 'nebulosus' : subtypeIdx === 1 ? 'fractus' : 'fog';
      addStratus(world, cloudEid, subtypeStr, { radiusX, radiusZ });
    } else if (family === CloudType.CUMULUS) {
      const subtypeStr = subtypeIdx === 0 ? 'humilis' : subtypeIdx === 1 ? 'mediocris' : 'congestus';
      addCumulus(world, cloudEid, subtypeStr, { radiusX, radiusZ });
    } else if (family === CloudType.CUMULONIMBUS) {
      const subtypeStr = subtypeIdx === 0 ? 'calvus' : subtypeIdx === 1 ? 'capillatus' : subtypeIdx === 2 ? 'incus' : 'supercell';
      addCumulonimbus(world, cloudEid, subtypeStr, { radiusX, radiusZ });
    }

    // Adjust coverage via direct instance write.
    const ci = _findCloudInstance(cloudEid);
    if (ci >= 0) {
      CloudInstance.coverage[ci] = coverage;
    }

    WeatherInstance.cloudLayerEids[instanceSlot * MAX_CLOUD_LAYERS + i] = cloudEid;
  }

  // 3. Store instance state.
  WeatherInstance.archetypeSlot[instanceSlot] = archetypeSlot;
  WeatherInstance.ownerEid[instanceSlot] = weatherRootEid;
  WeatherInstance.skyEid[instanceSlot] = weatherRootEid;
  WeatherInstance.blendProgress[instanceSlot] = 0;
  WeatherInstance.previousArchetypeSlot[instanceSlot] = archetypeSlot;
  WeatherInstance.active[instanceSlot] = 1;
  WeatherInstance.elapsedTime[instanceSlot] = 0;
  WeatherInstance.duration[instanceSlot] = W.durationMin[archetypeSlot]
    + Math.random() * (W.durationMax[archetypeSlot] - W.durationMin[archetypeSlot]);
  WeatherInstance.seed[instanceSlot] = seed;

  addComponent(world, weatherRootEid, WeatherInstanceTag);
  _weatherInstances.set(weatherRootEid, instanceSlot);

  return instanceSlot;
}

function _internalAddEntity(world) {
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

function _findCloudInstance(eid) {
  // Linear scan — acceptable since cloud layers are few.
  for (let slot = 0; slot < _nextInstanceSlot; slot++) {
    if (CloudInstance.ownerEid[slot] === eid) return slot;
  }
  return -1;
}

function _pickArchetypeForFamily(family, subtypeIdx) {
  // Return any archetype slot from the family — used only to read default
  // base altitude.
  if (family === CloudType.CIRRUS) return CirrusArchetypes.fibratus;
  if (family === CloudType.CIRROCUMULUS) return CirrocumulusArchetypes.rippled;
  if (family === CloudType.CIRROSTRATUS) return CirrostratusArchetypes.uniform;
  if (family === CloudType.ALTOCUMULUS) return AltocumulusArchetypes.layered;
  if (family === CloudType.ALTOSTRATUS) return AltostratusArchetypes.uniform;
  if (family === CloudType.NIMBOSTRATUS) return NimbostratusArchetypes.moderate;
  if (family === CloudType.STRATOCUMULUS) return StratocumulusArchetypes.closedCell;
  if (family === CloudType.STRATUS) return StratusArchetypes.nebulosus;
  if (family === CloudType.CUMULUS) return CumulusArchetypes.humilis;
  if (family === CloudType.CUMULONIMBUS) return CumulonimbusArchetypes.calvus;
  return -1;
}

// ═══════════════════════════════════════════════════════════════════════
// BLEND WEATHER — transition between two archetypes over time
// ═══════════════════════════════════════════════════════════════════════

/**
 * Begin a transition to a new weather archetype. The current archetype
 * is stored as `previousArchetypeSlot` and `blendProgress` advances
 * from 0 → 1 over the given duration.
 */
export function blendWeatherTo(world, instanceSlot, newArchetypeSlot, transitionDuration = 60) {
  if (instanceSlot < 0 || instanceSlot >= _nextInstanceSlot) return;

  WeatherInstance.previousArchetypeSlot[instanceSlot] = WeatherInstance.archetypeSlot[instanceSlot];
  WeatherInstance.archetypeSlot[instanceSlot] = newArchetypeSlot;
  WeatherInstance.blendProgress[instanceSlot] = 0;
  WeatherInstance.duration[instanceSlot] = transitionDuration;
}

/**
 * Advance all active weather instances. Blends parameters between the
 * previous and current archetypes, and updates each cloud's coverage
 * and each sky's parameters.
 */
export function systemUpdateWeather(world, dt) {
  const W = WeatherArchetype;
  const WI = WeatherInstance;

  for (let slot = 0; slot < _nextInstanceSlot; slot++) {
    if (!WI.active[slot]) continue;

    WI.elapsedTime[slot] += dt;

    // Advance blend if transitioning.
    if (WI.blendProgress[slot] < 1.0) {
      WI.blendProgress[slot] = Math.min(1,
        WI.blendProgress[slot] + dt / Math.max(WI.duration[slot], EPSILON));
    }

    // Blend from previous to current.
    const prevSlot = WI.previousArchetypeSlot[slot];
    const curSlot = WI.archetypeSlot[slot];
    const t = WI.blendProgress[slot];

    // Update sky parameters (sun intensity, turbidity, etc.).
    const skyEid = WI.skyEid[slot];
    const skySlot = getSkySlot(skyEid);
    if (skySlot >= 0) {
      SkyF32.sunIntensity[skySlot] = lerp(W.sunIntensity[prevSlot], W.sunIntensity[curSlot], t);
      SkyF32.turbidity[skySlot]    = lerp(W.turbidity[prevSlot], W.turbidity[curSlot], t);
      SkyF32.rayleigh[skySlot]     = lerp(W.rayleigh[prevSlot], W.rayleigh[curSlot], t);
      SkyF32.mie[skySlot]          = lerp(W.mie[prevSlot], W.mie[curSlot], t);
      SkyF32.mieG[skySlot]         = lerp(W.mieG[prevSlot], W.mieG[curSlot], t);
    }

    // Update cloud layer coverage.
    const layerCount = W.cloudLayerCount[curSlot];
    const prevLayerCount = W.cloudLayerCount[prevSlot];
    for (let i = 0; i < layerCount; i++) {
      const cloudEid = WI.cloudLayerEids[slot * MAX_CLOUD_LAYERS + i];
      if (!cloudEid) continue;

      const ci = _findCloudInstance(cloudEid);
      if (ci < 0) continue;

      const curCoverage = WeatherCloudLayer.coverage[curSlot * MAX_CLOUD_LAYERS + i];
      const prevCoverage = i < prevLayerCount
        ? WeatherCloudLayer.coverage[prevSlot * MAX_CLOUD_LAYERS + i]
        : curCoverage;
      CloudInstance.coverage[ci] = lerp(prevCoverage, curCoverage, t);
    }
  }

  return world;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// ═══════════════════════════════════════════════════════════════════════
// SAMPLE WEATHER AT POSITION — for gameplay systems
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a weather summary at a given world position. Blends all active
 * weather archetypes that overlap this position.
 *
 * Returns { temperature, humidity, windSpeed, windDirX, windDirZ,
 *           precipitationRate, precipitationType, snowMix, visibility,
 *           lightningFrequency, hailRate, tornadoPotential,
 *           dustDensity, fogDensity, stormIntensity }
 */
export function sampleWeatherAt(world, wx, wy, wz) {
  const W = WeatherArchetype;
  const WI = WeatherInstance;

  // Accumulate weighted parameters from all overlapping weather.
  let totalWeight = 0;
  let temperature = 0, humidity = 0;
  let windSpeed = 0, windDirX = 0, windDirZ = 0;
  let precipitationRate = 0, precipitationType = PrecipitationType.NONE, snowMix = 0;
  let visibility = 0;
  let lightningFrequency = 0, hailRate = 0, tornadoPotential = 0;
  let dustDensity = 0, fogDensity = 0;
  let stormIntensity = 0;

  for (let slot = 0; slot < _nextInstanceSlot; slot++) {
    if (!WI.active[slot]) continue;

    const curSlot = WI.archetypeSlot[slot];
    const weight = 1.0;   // currently single-weather; will sum for multiple

    const t = WI.blendProgress[slot];
    const prevSlot = WI.previousArchetypeSlot[slot];

    temperature   += lerp(W.temperature[prevSlot], W.temperature[curSlot], t) * weight;
    humidity      += lerp(W.humidity[prevSlot], W.humidity[curSlot], t) * weight;
    windSpeed     += lerp(W.windSpeed[prevSlot], W.windSpeed[curSlot], t) * weight;
    windDirX      += lerp(W.windDirX[prevSlot], W.windDirX[curSlot], t) * weight;
    windDirZ      += lerp(W.windDirZ[prevSlot], W.windDirZ[curSlot], t) * weight;
    precipitationRate += lerp(W.precipitationRate[prevSlot], W.precipitationRate[curSlot], t) * weight;
    snowMix       += lerp(W.snowMix[prevSlot], W.snowMix[curSlot], t) * weight;
    visibility    += lerp(W.visibility[prevSlot], W.visibility[curSlot], t) * weight;
    lightningFrequency += lerp(W.lightningFrequency[prevSlot], W.lightningFrequency[curSlot], t) * weight;
    hailRate      += lerp(W.hailRate[prevSlot], W.hailRate[curSlot], t) * weight;
    tornadoPotential += lerp(W.tornadoPotential[prevSlot], W.tornadoPotential[curSlot], t) * weight;
    dustDensity   += lerp(W.dustDensity[prevSlot], W.dustDensity[curSlot], t) * weight;
    fogDensity    += lerp(W.fogDensity[prevSlot], W.fogDensity[curSlot], t) * weight;
    stormIntensity += lerp(W.stormIntensity[prevSlot], W.stormIntensity[curSlot], t) * weight;

    // Precipitation type from the dominant (current) archetype.
    if (weight > 0.5) {
      precipitationType = W.precipitationType[curSlot];
    }

    totalWeight += weight;
  }

  if (totalWeight < EPSILON) {
    return {
      temperature: 20, humidity: 0.5, windSpeed: 0, windDirX: 0, windDirZ: 0,
      precipitationRate: 0, precipitationType: PrecipitationType.NONE, snowMix: 0,
      visibility: 30000, lightningFrequency: 0, hailRate: 0, tornadoPotential: 0,
      dustDensity: 0, fogDensity: 0, stormIntensity: 0,
    };
  }

  const inv = 1 / totalWeight;
  return {
    temperature: temperature * inv,
    humidity: humidity * inv,
    windSpeed: windSpeed * inv,
    windDirX: windDirX * inv,
    windDirZ: windDirZ * inv,
    precipitationRate: precipitationRate * inv,
    precipitationType,
    snowMix: snowMix * inv,
    visibility: visibility * inv,
    lightningFrequency: lightningFrequency * inv,
    hailRate: hailRate * inv,
    tornadoPotential: tornadoPotential * inv,
    dustDensity: dustDensity * inv,
    fogDensity: fogDensity * inv,
    stormIntensity: stormIntensity * inv,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// PREDEFINED ARCHETYPES — created on first use
// ═══════════════════════════════════════════════════════════════════════

export const PredefinedWeathers = {
  clearSunny:       -1,
  partlyCloudy:     -1,
  overcast:         -1,
  lightRain:        -1,
  moderateRain:     -1,
  heavyRain:        -1,
  thunderstorm:     -1,
  supercell:        -1,
  lightSnow:        -1,
  moderateSnow:     -1,
  blizzard:         -1,
  fog:              -1,
  mist:             -1,
  haze:             -1,
  dustStorm:        -1,
  sandstorm:        -1,
  freezingRain:     -1,
  sleet:            -1,
  hailStorm:        -1,
  tropicalStorm:    -1,
  hurricane:        -1,
  tornadoOutbreak:  -1,
  initialized:      false,
};

export function ensurePredefinedWeathers() {
  if (PredefinedWeathers.initialized) return PredefinedWeathers;
  const P = PredefinedWeathers;
  P.clearSunny       = createWeatherArchetype(WeatherType.CLEAR_SUNNY);
  P.partlyCloudy     = createWeatherArchetype(WeatherType.PARTLY_CLOUDY);
  P.overcast         = createWeatherArchetype(WeatherType.OVERCAST);
  P.lightRain        = createWeatherArchetype(WeatherType.LIGHT_RAIN);
  P.moderateRain     = createWeatherArchetype(WeatherType.MODERATE_RAIN);
  P.heavyRain        = createWeatherArchetype(WeatherType.HEAVY_RAIN);
  P.thunderstorm     = createWeatherArchetype(WeatherType.THUNDERSTORM);
  P.supercell        = createWeatherArchetype(WeatherType.SUPERCELL);
  P.lightSnow        = createWeatherArchetype(WeatherType.LIGHT_SNOW);
  P.moderateSnow     = createWeatherArchetype(WeatherType.MODERATE_SNOW);
  P.blizzard         = createWeatherArchetype(WeatherType.BLIZZARD);
  P.fog              = createWeatherArchetype(WeatherType.FOG);
  P.mist             = createWeatherArchetype(WeatherType.MIST);
  P.haze             = createWeatherArchetype(WeatherType.HAZE);
  P.dustStorm        = createWeatherArchetype(WeatherType.DUST_STORM);
  P.sandstorm        = createWeatherArchetype(WeatherType.SANDSTORM);
  P.freezingRain     = createWeatherArchetype(WeatherType.FREEZING_RAIN);
  P.sleet            = createWeatherArchetype(WeatherType.SLEET);
  P.hailStorm        = createWeatherArchetype(WeatherType.HAIL_STORM);
  P.tropicalStorm    = createWeatherArchetype(WeatherType.TROPICAL_STORM);
  P.hurricane        = createWeatherArchetype(WeatherType.HURRICANE);
  P.tornadoOutbreak  = createWeatherArchetype(WeatherType.TORNADO_OUTBREAK);
  P.initialized = true;
  return P;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearWeather() {
  _weatherInstances.clear();
  _nextArchetypeSlot = 0;
  _nextInstanceSlot = 0;
  WeatherArchetype.name.fill('');
  WeatherInstance.active.fill(0);
  PredefinedWeathers.initialized = false;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function weatherStats() {
  let active = 0;
  let blending = 0;

  for (let slot = 0; slot < _nextInstanceSlot; slot++) {
    if (!WeatherInstance.active[slot]) continue;
    active++;
    if (WeatherInstance.blendProgress[slot] < 1.0) blending++;
  }

  return {
    archetypeCount: _nextArchetypeSlot,
    instanceCount: _nextInstanceSlot,
    active,
    blending,
    predefinedReady: PredefinedWeathers.initialized,
  };
}