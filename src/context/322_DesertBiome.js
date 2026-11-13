// file number : 322
// full path name : src/context/322_DesertBiome.js
// description : Desert biome descriptor — the fifth of the nine biome presets,
// tuned for arid and semi-arid environments (15°–35° in both hemispheres) where
// moisture deficit, extreme diurnal temperature swing, and aeolian (wind-driven)
// erosion are the defining drivers. Provides the same eleven interlocking
// descriptor blocks as 318–321, but every parameter is recalibrated for the
// desert's constraints: near-zero humidity, sand and rock substrates, xerophytic
// vegetation, nocturnal fauna activity, intense solar irradiance, and sandstorm-
// driven erosion. The descriptor is a pure parameter set: it allocates nothing
// after construction and is consumed by the biome registry, blend field, material
// bridge, climate/soil/hydrology couplings, fauna migration system, chunk
// descriptor, and the full material/lighting/sensory pipeline.
// best for : Every consumer that needs a desert or arid biome preset — biome
// registry barrel (327), biome blend field (328), biome blend system (329),
// cross-biome ecotone (330), biome material bridge (331), biome climate coupling
// (332), biome soil coupling (333), biome hydrology coupling (334), biome fauna
// migration (335), landscape chunk descriptor (336), and the whole material/
// lighting/sensory pipeline. Together with the other eight biome files this
// completes the planet-scale living-biome palette.
// license : MIT

// ─── raw 3js primitives — exported by the 264 barrel ────────────
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere, Box3, Frustum,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems — each from its own file ───────
import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS } from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD } from './267_CoreClock.js';
import { smoothstep } from './268_ExtrasCurveUtils.js';
import { TemporalContextProvider, WEATHER } from './276_TemporalContextProvider.js';
import { CausalContextProvider, DERIVED_SIGNAL } from './278_CausalContextProvider.js';
import { TerrainProvider, BIOME_HINT } from './280_TerrainProvider.js';
import { ElevationProvider, ELEVATION_BAND } from './281_ElevationProvider.js';
import { SlopeGradientProvider, SLOPE_BAND } from './282_SlopeGradientProvider.js';
import { ReliefGradientProvider, RELIEF_CLASS } from './282_Z01_ReliefGradientProvider.js';
import { RockGradientProvider, ROCK_CLASS } from './282_Z06_RockGradientProvider.js';
import { ForestGradientProvider, TREE_TYPE, SUCCESSION } from './282_Z07_ForestGradientProvider.js';
import { GrassAndFlowresGradientProvider, GRASS_TYPE } from './282_Z08_GrassAndFlowresGradientProvider.js';
import { ContinentalReliefGradientProvider, CONTINENTAL_TYPE } from './282_Z09_ContinentalReliefGradientProvider.js';
import { BathymetryProvider, BATHY_ZONE, SEABED_CLASS } from './283_BathymetryProvider.js';
import { GroundwaterProvider, GROUNDWATER_TYPE } from './284_GroundwaterProvider.js';
import { MoistureLevelProvider, MOISTURE_STATE } from './285_MoistureLevelProvider.js';
import { DecomposersSystem, DECOMPOSER_TYPE } from './286_DecomposersSystem.js';
import { ClimateTemperatureProvider } from './287_ClimateTemperatureProvider.js';
import { ClimatePrecipitationProvider, PRECIPITATION_PHASE } from './288_ClimatePrecipitationProvider.js';
import { ClimateWindProvider, WIND_STATE } from './289_ClimateWindProvider.js';
import { SoilCompositionProvider, SOIL_TEXTURE_CLASS } from './290_SoilCompositionProvider.js';
import { SoilFertilityProvider, FERTILITY_CLASS } from './291_SoilFertilityProvider.js';
import { SoilColorTextureProvider, SOIL_VISUAL_ARCHETYPE } from './292_SoilColorTextureProvider.js';
import { AirQualityAtmosphereProvider } from './295_AirQualityAtmosphereProvider.js';
import { SeasonalitySystem, PHENOLOGY_STAGE, SEASONAL_MATERIAL } from './296_SeasonalitySystem.js';
import { AudioLightEmissionSystem, AUDIO_CUE_TYPE, LIGHT_CUE_TYPE } from './317_AudioLightEmissionSystem.js';
import { ACOUSTIC_PROFILE } from './297_SensoryDetailsProvider.js';

// ══════════════════════════════════════════════════════════════════
// ─── BIOME IDENTITY ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const BIOME_ID = 5;
const BIOME_NAME = 'desert';
const BIOME_DISPLAY_NAME = 'Desert / Arid';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── DESERT CHARACTERISTIC PARAMETERS ───────────────────────────
// ══════════════════════════════════════════════════════════════════
// ─── Climate ────────────────────────────────────────────────────
const CLIMATE = Object.freeze({
  // Temperature (°C) — extreme diurnal swing, very hot days, cold nights
  temperatureMin: -5.0,
  temperatureMax: 48.0,
  temperatureMean: 25.0,
  temperatureDailySwing: 25.0,      // extreme diurnal swing
  temperatureFrostFree: false,       // frost possible on winter nights
  // Humidity (0..1) — near-zero
  humidityMin: 0.02,
  humidityMax: 0.35,
  humidityMean: 0.15,
  // Precipitation (mm/hr mean) — extremely low and episodic
  precipitationMean: 0.05,
  precipitationMax: 15.0,           // rare flash-flood events
  precipitationStormProb: 0.05,
  precipitationAnnualMm: 120.0,     // hyper-arid to semi-arid
  // Seasons — temperature-driven, not moisture-driven
  seasonalityAmplitude: 0.60,
  drySeasonLengthDays: 300,
  wetSeasonPeakDay: 0,
  snowSeasonDays: 0,
  growingSeasonDays: 120,
  // Wind — strong, gusty, and the dominant geomorphic agent
  windMeanSpeed: 5.5,
  windMaxSpeed: 35.0,
  windPredominantDirDeg: 45,        // north-easterly trade winds
  // Weather state probabilities (0..1)
  weatherProbClear: 0.75,
  weatherProbCloudy: 0.10,
  weatherProbRain: 0.03,
  weatherProbStorm: 0.02,          // dust storms count as storms
  weatherProbSnow: 0.00,
  weatherProbFog: 0.00,
  // Atmospheric
  pressureMeanKPa: 101.5,
  pressureSwingKPa: 1.5
});

// ─── Terrain Bias ────────────────────────────────────────────────
const TERRAIN = Object.freeze({
  elevationBand: ELEVATION_BAND.LOWLAND,
  elevationMinM: 100.0,
  elevationMaxM: 2000.0,
  slopeMeanDeg: 1.5,
  slopeMaxDeg: 40.0,                // ergs, hamadas, and rocky plateaus
  roughness: 0.45,                  // smooth sand sheets vs. rugged rocky terrain
  valleyDepth: 0.10,                // wadis and canyons
  valleyDensity: 0.15,
  plateauBias: 0.60,
  groundwaterTableDepthM: 25.0,     // very deep
  permafrostDepthM: Infinity,
  terrainRoughnessHint: 0.50,
  biomeHint: BIOME_HINT.DESERT
});

// ─── Soil ──────────────────────────────────────────────────────
const SOIL = Object.freeze({
  textureClass: SOIL_TEXTURE_CLASS.SAND,
  visualArchetype: SOIL_VISUAL_ARCHETYPE.SANDY_TAN,
  // Primary fractions (0..1)
  sand: 0.80,
  silt: 0.10,
  clay: 0.05,
  organicMatter: 0.01,              // almost no organic matter
  gravel: 0.04,
  rockFragment: 0.00,
  // Chemistry
  pH: 8.0,                          // alkaline
  fertilityClass: FERTILITY_CLASS.BARREN,
  fertilityIndex: 0.08,
  // Physics
  porosity: 0.35,
  bulkDensityGcm3: 1.55,
  waterHoldingCapacity: 0.08,
  hydraulicConductivityMmHr: 25.0,
  cohesionKPa: 2.0,
  plasticityIndex: 3.0,
  // Colour (linear RGB)
  baseAlbedo: [0.60, 0.52, 0.35],   // bright sand
  organicDarkening: 0.05,
  ironOxideRedness: 0.55,           // red desert variant
  calciumPale: 0.20,
  // Erosion
  usleKFactor: 0.15,                // low rainfall erosivity
  windErodibility: 0.95             // extremely high wind erosion
});

// ─── Vegetation ─────────────────────────────────────────────────
// Desert is sparsely vegetated with xerophytes, succulents, and ephemeral
// annuals that appear only after rare rain.
const VEGETATION = Object.freeze({
  treeTypeWeights: Object.freeze({
    [TREE_TYPE.PALM]: 0.60,       // oasis and wadi species
    [TREE_TYPE.ACACIA]: 0.30,
    [TREE_TYPE.BAOBAB]: 0.10
  }),
  grassTypeWeights: Object.freeze({
    [GRASS_TYPE.SHORT_PRAIRIE]: 0.40,
    [GRASS_TYPE.THISTLE]: 0.30,
    [GRASS_TYPE.MEADOW_GRASS]: 0.30  // ephemeral after rain
  }),
  verticalLayers: 1,                // no meaningful canopy stratification
  emergentDensity: 0.00,
  canopyDensity: 0.02,              // extremely sparse
  understoryDensity: 0.05,
  groundCoverDensity: 0.08,         // bare ground dominates
  epiphyteDensity: 0.00,
  lianaDensity: 0.00,
  successionTarget: SUCCESSION.PIONEER,
  fireRegimeYears: 50,              // fuel is too sparse for frequent fire
  rootDepthM: 3.0,                  // deep taproots to reach groundwater
  canopyRadiusM: 3.0,
  trunkHeightM: 4.0,
  leafLitterDepthM: 0.00,
  bloomWindowDays: 15,              // very short, triggered by rain
  // Poisson-disc targets per hectare
  treeDensityPerHa: 5,              // very sparse
  shrubDensityPerHa: 50,
  groundCoverDensityPerHa: 2000
});

// ─── Fauna ──────────────────────────────────────────────────────
const FAUNA = Object.freeze({
  densityWeight: 0.15,              // low biomass
  habitatLayers: Object.freeze({
    ground: 0.60,
    understory: 0.10,
    canopy: 0.05,                   // rare arboreal species
    aerial: 0.25                    // birds and bats
  }),
  dielActivity: 0.20,               // strongly nocturnal / crepuscular
  migrationCorridorWeight: 0.30,
  predatorPreyBalance: 0.30,
  nectarAvailability: 0.05,
  pollenAvailability: 0.05,
  // Characteristic guild weights
  largeHerbivoreWeight: 0.10,       // camels, oryx
  largePredatorWeight: 0.05,        // rare
  smallMammalWeight: 0.35,          // rodents, reptiles
  birdWeight: 0.30,
  insectWeight: 0.20                // adapted to extreme heat
});

// ─── Materials ──────────────────────────────────────────────────
// Full PBR + anime parameters for the desert's characteristic surfaces.
const MATERIALS = Object.freeze({
  // ─── Sand (dune and sheet sand) ─────────────────────────────
  sand: Object.freeze({
    albedo: [0.60, 0.52, 0.35],
    roughness: 0.95,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.10,
    animeFlatness: 0.40,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.0,
    hardness: 0.05,
    brittleness: 0.95
  }),
  // ─── Sandstone / rock outcrop ────────────────────────────────
  sandstone: Object.freeze({
    albedo: [0.55, 0.42, 0.30],
    roughness: 0.88,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.08,
    animeFlatness: 0.45,
    acousticProfile: ACOUSTIC_PROFILE.ROCK,
    flammability: 0.0,
    hardness: 0.75,
    brittleness: 0.35
  }),
  // ─── Dry riverbed / wadi gravel ─────────────────────────────
  wadiGravel: Object.freeze({
    albedo: [0.45, 0.40, 0.32],
    roughness: 0.90,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.15,
    animeFlatness: 0.50,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.0,
    hardness: 0.40,
    brittleness: 0.60
  }),
  // ─── Xerophytic shrub / succulent ───────────────────────────
  desertShrub: Object.freeze({
    albedo: [0.20, 0.22, 0.12],
    roughness: 0.80,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.15,                // succulent water storage
    emissive: 0.0,
    wetnessResponse: 0.25,
    animeFlatness: 0.30,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.50,              // volatile oils in some species
    hardness: 0.20,
    brittleness: 0.70
  }),
  // ─── Palm / oasis vegetation ────────────────────────────────
  palmFrond: Object.freeze({
    albedo: [0.12, 0.25, 0.08],
    roughness: 0.78,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.10,
    emissive: 0.0,
    wetnessResponse: 0.30,
    animeFlatness: 0.25,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.65,
    hardness: 0.30,
    brittleness: 0.55
  })
});

// ─── Lighting ───────────────────────────────────────────────────
const LIGHTING = Object.freeze({
  canopyOcclusion: 0.00,            // no canopy to block light
  sunDiffuseFraction: 0.15,         // direct sun overwhelmingly dominates
  sunIntensityScale: 1.45,          // intense solar irradiance
  colourCast: [1.00, 0.95, 0.85],   // warm white to golden
  atmosphericScatterBoost: 0.60,    // less atmospheric scattering (dry air)
  bioluminescentEmission: 0.00,
  dappledLightFrequency: 0.00,
  dappledLightAmplitude: 0.00,
  shadowSoftnessNear: 0.2,
  shadowSoftnessMid: 0.4,
  shadowSoftnessFar: 0.7,
  shadowCascadeScale: 1.0,
  snowAlbedoBoost: 0.0,
  dustHazeDensity: 0.025,           // frequent dust haze
  skyTint: [1.00, 0.92, 0.75]      // pale golden-blue
});

// ─── Water ──────────────────────────────────────────────────────
const WATER = Object.freeze({
  surfaceWaterPresence: 0.02,       // only oases and rare wadis
  riverineNetworkDensity: 0.02,
  canopyDrip: 0.00,
  groundwaterTableDepthM: 25.0,
  freshwaterSpringPresence: 0.05,
  waterTableDepthM: 25.0,
  bogCoverage: 0.0,
  lakeCoverage: 0.00,
  riverWidthMeanM: 2.0,
  waterTemperatureC: 18.0,
  iceCoverMonths: 0,
  shorelineMaterial: 'wadiGravel',
  seasonalWaterPresence: 0.10       // flash floods
});

// ─── Sensory ────────────────────────────────────────────────────
const SENSORY = Object.freeze({
  // Acoustic signature (0..1 weights across 8 channels)
  acoustic: Object.freeze({
    biological: 0.10,               // sparse and mostly nocturnal
    geological: 0.15,               // rock cracking, sand sliding
    water: 0.00,
    wind: 0.55,                     // wind is the dominant sound
    vegetation: 0.15,               // dry rustling
    mechanical: 0.05               // distant human activity
  }),
  // Olfactory signature
  olfactory: Object.freeze({
    floral: 0.02,
    earthy: 0.35,                   // dry earth and sand
    aquatic: 0.00,
    woodland: 0.05,
    smoke: 0.05,
    animal: 0.08,
    decay: 0.05,
    sulfur: 0.00,
    sea: 0.00,
    clean: 0.40                    // very clean, dry air
  }),
  // Tactile profile
  tactile: Object.freeze({
    temperatureC: 35.0,
    humidity: 0.10,
    windPressurePa: 8.0,
    precipitationType: 'none',
    groundHardness: 0.70           // hard-packed sand or rock
  })
});

// ─── Seasonality ────────────────────────────────────────────────
// The desert's phenology is driven by rare rainfall events rather than a
// regular seasonal cycle. Ephemeral plants germinate and bloom within days
// of rain, then set seed and die.
const SEASONALITY = Object.freeze({
  phenologyOverrides: Object.freeze({
    budBreakDayOffset: 0,
    fullGreenDurationDays: 30,      // extremely short after rain
    autumnColourShiftDays: 0,       // no autumn colour
    leafDropDurationDays: 10,
    bloomWindowDays: 15,
    sporeBoostWetSeason: 0.10,
    fungalBoostWetSeason: 0.05
  }),
  seasonalMaterialPalettes: Object.freeze({
    [SEASONAL_MATERIAL.SPRING_NEW_LEAF]: Object.freeze({
      sand: { albedo: [0.58, 0.50, 0.34], roughness: 0.94 },
      desertShrub: { albedo: [0.22, 0.28, 0.12], roughness: 0.78 }
    }),
    [SEASONAL_MATERIAL.SUMMER_FULL_GREEN]: Object.freeze({
      sand: { albedo: [0.62, 0.54, 0.36], roughness: 0.95 },
      desertShrub: { albedo: [0.20, 0.22, 0.12], roughness: 0.80 }
    }),
    [SEASONAL_MATERIAL.AUTUMN_PEAK]: Object.freeze({
      sand: { albedo: [0.60, 0.52, 0.35], roughness: 0.95 },
      desertShrub: { albedo: [0.18, 0.16, 0.10], roughness: 0.82 }
    }),
    [SEASONAL_MATERIAL.WINTER_BARE_BRANCH]: Object.freeze({
      sand: { albedo: [0.55, 0.48, 0.32], roughness: 0.96 },
      desertShrub: { albedo: [0.15, 0.12, 0.08], roughness: 0.85 }
    })
  }),
  snowAccumulationRateMmHr: 0.0,
  snowMeltRateMmHr: 0.0,
  snowAlbedoSeasonal: 0.0
});

// ─── Procedural ─────────────────────────────────────────────────
const PROCEDURAL = Object.freeze({
  macroCanopyNoiseScale: 200.0,     // dune field patterns
  midUnderstoryNoiseScale: 50.0,    // ripple marks
  microLitterNoiseScale: 10.0,      // grain-scale detail
  terrainNoiseScale: 300.0,
  duneNoiseScale: 150.0,
  // Poisson-disc density targets (per hectare) — mirrored from VEGETATION
  treeDensityPerHa: VEGETATION.treeDensityPerHa,
  shrubDensityPerHa: VEGETATION.shrubDensityPerHa,
  groundCoverDensityPerHa: VEGETATION.groundCoverDensityPerHa,
  // LOD scale thresholds (world units)
  lodHighDistance: 1000.0,          // long sightlines across dunes
  lodMidDistance: 5000.0,
  lodLowDistance: 20000.0,
  // Procedural event budgets
  maxFireEventsPerTick: 0,          // fires are extremely rare
  maxErosionEventsPerTick: 3,       // wind erosion is continuous
  maxGrowthEventsPerTick: 1         // growth is rare without rain
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING ────────────────────────────────────────
// Fuses temperature, humidity, elevation, slope, soil texture, and water-table
// depth into a single 0–1 weight. 328_BiomeBlendField uses this to decide how
// much of the desert biome applies at any world point.
// ══════════════════════════════════════════════════════════════════
const _scratchVec3 = new Vec3();
const _scratchNoise = new SimplexNoise();

/**
 * Compute the desert suitability at a world position and environmental state.
 * All inputs are expected to come from the context frame or from provider
 * summaries. The function allocates nothing after module initialisation.
 *
 * @param {object} env - Environmental sample.
 * @param {number} env.temperatureC - Air temperature in °C.
 * @param {number} env.humidity - Relative humidity 0..1.
 * @param {number} env.elevationM - Elevation in metres.
 * @param {number} env.slopeDeg - Slope angle in degrees.
 * @param {number} env.soilSand - Sand fraction 0..1.
 * @param {number} env.soilSilt - Silt fraction 0..1.
 * @param {number} env.soilClay - Clay fraction 0..1.
 * @param {number} env.waterTableDepthM - Depth to water table in metres.
 * @param {number} [env.noise] - Optional simplex noise sample for patchiness.
 * @returns {number} Suitability weight in [0, 1].
 */
function getSuitability(env) {
  // ─── Temperature: hot days, cold nights, broad annual tolerance ─────
  const tempScore = smoothstep(-5.0, 15.0, env.temperatureC) * (1.0 - smoothstep(45.0, 55.0, env.temperatureC));

  // ─── Humidity: very dry; too wet becomes grassland or forest ───────
  const humidityScore = (1.0 - smoothstep(0.20, 0.45, env.humidity));

  // ─── Elevation: lowland to plateau; high mountains are excluded ─────
  const elevScore = smoothstep(0.0, 300.0, env.elevationM) * (1.0 - smoothstep(2000.0, 3500.0, env.elevationM));

  // ─── Slope: flat to moderately rugged; steep slopes become rock or scrub ─
  const slopeScore = smoothstep(0.0, 2.0, env.slopeDeg) * (1.0 - smoothstep(25.0, 45.0, env.slopeDeg));

  // ─── Soil texture: sand is ideal; clay or organic-rich soil is not ───
  const textureScore =
    0.60 * smoothstep(0.55, 0.85, env.soilSand) +
    0.25 * smoothstep(0.05, 0.20, env.soilSilt) +
    0.15 * (1.0 - smoothstep(0.05, 0.20, env.soilClay));

  // ─── Water table: very deep; shallow water table supports oases ─────
  const waterScore = smoothstep(10.0, 25.0, env.waterTableDepthM);

  // ─── Patchiness: break up the suitability field with low-frequency noise ─
  const patchiness = env.noise !== undefined ? (0.75 + 0.25 * env.noise) : 1.0;

  // ─── Weighted fusion ────────────────────────────────────────────────
  const raw =
    0.20 * tempScore +
    0.30 * humidityScore +
    0.10 * elevScore +
    0.08 * slopeScore +
    0.20 * textureScore +
    0.12 * waterScore;

  return Math.max(0.0, Math.min(1.0, raw * patchiness));
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR EXPORT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const DesertBiome = Object.freeze({
  // Identity
  id: BIOME_ID,
  bit: BIOME_BIT,
  name: BIOME_NAME,
  displayName: BIOME_DISPLAY_NAME,

  // Eleven descriptor blocks
  climate: CLIMATE,
  terrain: TERRAIN,
  soil: SOIL,
  vegetation: VEGETATION,
  fauna: FAUNA,
  materials: MATERIALS,
  lighting: LIGHTING,
  water: WATER,
  sensory: SENSORY,
  seasonality: SEASONALITY,
  procedural: PROCEDURAL,

  // Suitability
  getSuitability,

  // Registration hook — 327_BiomeRegistryBarrel calls this at construction.
  register(registry) {
    if (registry && typeof registry.registerBiome === 'function') {
      registry.registerBiome(BIOME_ID, BIOME_NAME, this);
    }
  }
});

export default DesertBiome;