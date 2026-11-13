// file number : 326_Z07
// full path name : src/context/326_Z07_TemperateDeciduousForestBiome.js
// description : Temperate deciduous forest biome descriptor — the second of
// four additional forest biome presets. This preset covers the four-season
// broadleaf forests of eastern North America, western and central Europe, and
// East Asia, where a distinct spring, summer, autumn, and cool-to-cold winter
// drive the annual cycle of leaf-out, full canopy, autumn senescence, and
// winter dormancy. The defining drivers are 75–125 cm of precipitation spread
// evenly through the year, brown forest soils (alfisols) with moderate to high
// natural fertility, a closed broadleaf canopy 20–30 m tall, a well-developed
// understorey and herb layer that flushes before canopy closure, and a winter
// freeze that triggers leaf drop. Provides the same eleven interlocking
// descriptor blocks as the base biomes, with full PBR + anime parameters for
// deciduous canopy, autumn foliage, bark, spring ephemerals, leaf litter,
// alfisol soil, and seasonal snow. The descriptor allocates nothing after
// construction and is consumed by the biome registry, blend field, material
// bridge, climate/soil/hydrology couplings, fauna migration system, chunk
// descriptor, and the full material/lighting/sensory pipeline.
//#
// best for : Every consumer that needs a temperate deciduous forest, broadleaf
// forest, or four-season hardwood forest biome preset — biome registry barrel
// (327), biome blend field (328), biome blend system (329), cross-biome ecotone
// (330), biome material bridge (331), biome climate coupling (332), biome soil
// coupling (333), biome hydrology coupling (334), biome fauna migration (335),
// landscape chunk descriptor (336), and the whole material/lighting/sensory
// pipeline. Together with the other forest biome files this completes the
// planet-scale living-biome palette, and the temperate deciduous preset is the
// one that must remain seamless from the boreal forest of 326_Z06 through the
// deciduous forest into the temperate rainforest and subtropical forest
// margins.
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
const BIOME_ID = 16;
const BIOME_NAME = 'temperate_deciduous_forest';
const BIOME_DISPLAY_NAME = 'Temperate Deciduous Forest';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── TEMPERATE DECIDUOUS FOREST CHARACTERISTIC PARAMETERS ───────
// ══════════════════════════════════════════════════════════════════
// ─── Climate ────────────────────────────────────────────────────
// Humid temperate to continental: warm summers, cool-to-cold winters, and
// precipitation distributed evenly through the year at 75–125 cm.
const CLIMATE = Object.freeze({
  // Temperature (°C)
  temperatureMin: -25.0,            // cold continental winter
  temperatureMax: 32.0,             // warm, humid summer
  temperatureMean: 10.0,            // ≈50 °F annual mean
  temperatureDailySwing: 10.0,
  temperatureFrostFree: false,       // frost is a defining winter signal
  // Humidity (0..1) — humid year-round
  humidityMin: 0.50,
  humidityMax: 0.90,
  humidityMean: 0.70,
  // Precipitation (mm/hr mean) — 75–125 cm annually
  precipitationMean: 1.5,
  precipitationMax: 20.0,
  precipitationStormProb: 0.10,
  precipitationAnnualMm: 1000.0,    // 75–125 cm
  // Seasons — four distinct seasons
  seasonalityAmplitude: 0.80,
  drySeasonLengthDays: 0,           // no true dry season; precipitation is even
  wetSeasonPeakDay: 0,
  snowSeasonDays: 90,
  growingSeasonDays: 180,           // ≈6 frost-free months
  // Wind — moderate, reduced by canopy
  windMeanSpeed: 3.0,
  windMaxSpeed: 25.0,
  windPredominantDirDeg: 270,      // westerly in both hemispheres
  // Weather state probabilities (0..1)
  weatherProbClear: 0.35,
  weatherProbCloudy: 0.30,
  weatherProbRain: 0.20,
  weatherProbStorm: 0.05,
  weatherProbSnow: 0.10,
  weatherProbFog: 0.00,
  // Atmospheric
  pressureMeanKPa: 101.3,
  pressureSwingKPa: 2.5
});

// ─── Terrain Bias ────────────────────────────────────────────────
// Temperate deciduous forest occupies lowland to mid-elevation terrain with
// rolling topography, broad valleys, and moderately deep soils.
const TERRAIN = Object.freeze({
  elevationBand: ELEVATION_BAND.LOWLAND_TO_HIGHLAND,
  elevationMinM: 0.0,
  elevationMaxM: 1200.0,
  slopeMeanDeg: 5.0,
  slopeMaxDeg: 30.0,
  roughness: 0.45,
  valleyDepth: 0.35,
  valleyDensity: 0.45,
  plateauBias: 0.50,
  groundwaterTableDepthM: 5.0,
  permafrostDepthM: Infinity,
  terrainRoughnessHint: 0.45,
  biomeHint: BIOME_HINT.DECIDUOUS_FOREST
});

// ─── Soil ──────────────────────────────────────────────────────
// Alfisols are the characteristic soil order: moderately leached, base-rich,
// with clay accumulation in the subsoil. They are among the most fertile
// forest soils on Earth.
const SOIL = Object.freeze({
  textureClass: SOIL_TEXTURE_CLASS.LOAM,
  visualArchetype: SOIL_VISUAL_ARCHETYPE.BROWN_FOREST,
  // Primary fractions (0..1)
  sand: 0.35,
  silt: 0.40,
  clay: 0.20,
  organicMatter: 0.05,
  gravel: 0.00,
  rockFragment: 0.00,
  // Chemistry
  pH: 6.0,                          // slightly acidic to near neutral
  fertilityClass: FERTILITY_CLASS.RICH,
  fertilityIndex: 0.75,
  // Physics
  porosity: 0.48,
  bulkDensityGcm3: 1.20,
  waterHoldingCapacity: 0.35,
  hydraulicConductivityMmHr: 6.0,
  cohesionKPa: 10.0,
  plasticityIndex: 16.0,
  // Colour (linear RGB) — brown forest soil
  baseAlbedo: [0.20, 0.16, 0.12],
  organicDarkening: 0.55,
  ironOxideRedness: 0.25,
  calciumPale: 0.10,
  // Erosion
  usleKFactor: 0.30,
  windErodibility: 0.25
});

// ─── Vegetation ─────────────────────────────────────────────────
// Temperate deciduous forest is a closed broadleaf canopy with a well-defined
// vertical structure: canopy (20–30 m), understorey (5–15 m), shrub layer
// (1–3 m), and herb layer (<1 m). Spring ephemerals flush before canopy
// closure; autumn senescence is a defining phenological event.
const VEGETATION = Object.freeze({
  treeTypeWeights: Object.freeze({
    [TREE_TYPE.OAK]: 0.30,        // Quercus spp.
    [TREE_TYPE.MAPLE]: 0.25,      // Acer spp.
    [TREE_TYPE.BEECH]: 0.20,      // Fagus spp.
    [TREE_TYPE.BIRCH]: 0.15,      // Betula spp.
    [TREE_TYPE.ELM]: 0.10         // Ulmus spp.
  }),
  grassTypeWeights: Object.freeze({
    [GRASS_TYPE.FERN]: 0.35,       // understorey ferns
    [GRASS_TYPE.MEADOW_GRASS]: 0.30,
    [GRASS_TYPE.SHORT_PRAIRIE]: 0.20,
    [GRASS_TYPE.SNOWDROP]: 0.15    // spring ephemerals
  }),
  verticalLayers: 4,                // canopy, understorey, shrub, herb
  emergentDensity: 0.00,
  canopyDensity: 0.80,              // closed canopy
  understoryDensity: 0.40,
  groundCoverDensity: 0.50,         // herb layer and leaf litter
  epiphyteDensity: 0.10,
  lianaDensity: 0.05,
  successionTarget: SUCCESSION.CLIMAX,
  fireRegimeYears: 500,             // fire is rare in mesic deciduous forest
  rootDepthM: 2.0,
  canopyRadiusM: 5.0,
  trunkHeightM: 25.0,
  leafLitterDepthM: 0.08,
  bloomWindowDays: 60,              // spring bloom before canopy closure
  // Poisson-disc targets per hectare
  treeDensityPerHa: 350,
  shrubDensityPerHa: 1500,
  groundCoverDensityPerHa: 25000
});

// ─── Fauna ──────────────────────────────────────────────────────
// Temperate deciduous forest fauna is adapted to a strong seasonal cycle:
// summer breeding, autumn caching, and winter dormancy or migration.
const FAUNA = Object.freeze({
  densityWeight: 0.55,
  habitatLayers: Object.freeze({
    ground: 0.30,
    understory: 0.30,
    canopy: 0.30,
    aerial: 0.10
  }),
  dielActivity: 0.45,               // many species are crepuscular
  migrationCorridorWeight: 0.60,    // strong seasonal bird migration
  predatorPreyBalance: 0.50,
  nectarAvailability: 0.15,
  pollenAvailability: 0.15,
  // Characteristic guild weights
  largeHerbivoreWeight: 0.20,       // deer
  largePredatorWeight: 0.10,        // bear, wolf (regionally)
  smallMammalWeight: 0.35,          // squirrels, rodents
  birdWeight: 0.25,
  insectWeight: 0.10
});

// ─── Materials ──────────────────────────────────────────────────
// Full PBR + anime parameters for temperate deciduous forest surfaces:
// summer canopy, autumn foliage, bark, spring ephemerals, leaf litter,
// alfisol soil, and seasonal snow.
const MATERIALS = Object.freeze({
  // ─── Summer deciduous canopy ────────────────────────────────
  deciduousCanopySummer: Object.freeze({
    albedo: [0.10, 0.18, 0.06],     // rich green
    roughness: 0.78,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.40,
    animeFlatness: 0.20,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.60,
    hardness: 0.25,
    brittleness: 0.70
  }),
  // ─── Autumn deciduous canopy ────────────────────────────────
  deciduousCanopyAutumn: Object.freeze({
    albedo: [0.45, 0.25, 0.05],     // orange-gold
    roughness: 0.80,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.45,
    animeFlatness: 0.20,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.70,
    hardness: 0.20,
    brittleness: 0.75
  }),
  // ─── Deciduous bark ─────────────────────────────────────────
  deciduousBark: Object.freeze({
    albedo: [0.18, 0.14, 0.10],
    roughness: 0.90,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.25,
    animeFlatness: 0.35,
    acousticProfile: ACOUSTIC_PROFILE.WOOD,
    flammability: 0.55,
    hardness: 0.80,
    brittleness: 0.30
  }),
  // ─── Spring ephemeral / herb layer ──────────────────────────
  springEphemeral: Object.freeze({
    albedo: [0.15, 0.25, 0.10],
    roughness: 0.82,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.50,
    animeFlatness: 0.20,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.50,
    hardness: 0.10,
    brittleness: 0.85
  }),
  // ─── Leaf litter ────────────────────────────────────────────
  leafLitter: Object.freeze({
    albedo: [0.28, 0.20, 0.12],     // brown-orange
    roughness: 0.88,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.65,
    animeFlatness: 0.40,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.40,
    hardness: 0.05,
    brittleness: 0.90
  }),
  // ─── Alfisol soil ───────────────────────────────────────────
  alfisol: Object.freeze({
    albedo: [0.20, 0.16, 0.12],
    roughness: 0.92,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.50,
    animeFlatness: 0.45,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.05,
    hardness: 0.30,
    brittleness: 0.65
  }),
  // ─── Seasonal snow ─────────────────────────────────────────
  snow: Object.freeze({
    albedo: [0.90, 0.92, 0.95],
    roughness: 0.40,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.25,
    emissive: 0.0,
    wetnessResponse: 0.10,
    animeFlatness: 0.15,
    acousticProfile: ACOUSTIC_PROFILE.SOFT,
    flammability: 0.0,
    hardness: 0.10,
    brittleness: 0.88
  })
});

// ─── Lighting ───────────────────────────────────────────────────
// Temperate deciduous forest lighting changes dramatically through the year:
// a closed summer canopy creates deep shade, while winter bare branches allow
// much more light to reach the forest floor.
const LIGHTING = Object.freeze({
  canopyOcclusion: 0.75,            // closed canopy in summer
  sunDiffuseFraction: 0.50,         // diffuse light dominates under canopy
  sunIntensityScale: 0.95,
  colourCast: [1.00, 0.98, 0.92],   // warm summer light
  atmosphericScatterBoost: 1.05,
  bioluminescentEmission: 0.01,     // rare fireflies
  dappledLightFrequency: 0.40,      // dappled light through leaves
  dappledLightAmplitude: 0.35,
  shadowSoftnessNear: 0.4,
  shadowSoftnessMid: 0.6,
  shadowSoftnessFar: 0.8,
  shadowCascadeScale: 0.9,
  snowAlbedoBoost: 1.25,
  fogDensityBase: 0.010,
  skyTint: [0.88, 0.92, 0.98],
  // ─── Seasonal canopy gap fraction ─────────────────────────
  canopyGapFractionSummer: 0.20,
  canopyGapFractionWinter: 0.75
});

// ─── Water ──────────────────────────────────────────────────────
// Water is abundant and reliable: precipitation is even through the year,
// and evapotranspiration is high in summer. Streams and small lakes are
// characteristic.
const WATER = Object.freeze({
  surfaceWaterPresence: 0.20,
  riverineNetworkDensity: 0.35,
  canopyDrip: 0.30,
  groundwaterTableDepthM: 5.0,
  freshwaterSpringPresence: 0.15,
  waterTableDepthM: 5.0,
  bogCoverage: 0.05,
  lakeCoverage: 0.05,
  riverWidthMeanM: 5.0,
  waterTemperatureC: 12.0,
  iceCoverMonths: 3,
  shorelineMaterial: 'alfisol'
});

// ─── Sensory ────────────────────────────────────────────────────
const SENSORY = Object.freeze({
  acoustic: Object.freeze({
    biological: 0.35,               // birdsong, insects
    geological: 0.00,
    water: 0.15,                    // streams
    wind: 0.25,                     // wind through leaves
    vegetation: 0.25,               // leaf rustle
    mechanical: 0.00
  }),
  olfactory: Object.freeze({
    floral: 0.20,
    earthy: 0.25,
    aquatic: 0.05,
    woodland: 0.25,                 // leaf litter and bark
    smoke: 0.05,
    animal: 0.05,
    decay: 0.10,
    sulfur: 0.00,
    sea: 0.00,
    clean: 0.05
  }),
  tactile: Object.freeze({
    temperatureC: 12.0,
    humidity: 0.70,
    windPressurePa: 3.0,
    precipitationType: 'rain',
    groundHardness: 0.50
  })
});

// ─── Seasonality ────────────────────────────────────────────────
// Four-season phenology: spring leaf-out and ephemeral bloom, summer full
// canopy, autumn senescence and leaf drop, winter dormancy under bare
// branches and snow.
const SEASONALITY = Object.freeze({
  phenologyOverrides: Object.freeze({
    budBreakDayOffset: 0,
    fullGreenDurationDays: 150,
    autumnColourShiftDays: 30,
    leafDropDurationDays: 20,
    bloomWindowDays: 60,
    sporeBoostWetSeason: 0.20,
    fungalBoostWetSeason: 0.15
  }),
  seasonalMaterialPalettes: Object.freeze({
    [SEASONAL_MATERIAL.SPRING_NEW_LEAF]: Object.freeze({
      deciduousCanopySummer: { albedo: [0.12, 0.24, 0.08], roughness: 0.76 },
      springEphemeral: { albedo: [0.15, 0.25, 0.10], roughness: 0.82 }
    }),
    [SEASONAL_MATERIAL.SUMMER_FULL_GREEN]: Object.freeze({
      deciduousCanopySummer: { albedo: [0.10, 0.18, 0.06], roughness: 0.78 },
      alfisol: { albedo: [0.18, 0.14, 0.10], wetnessResponse: 0.60 }
    }),
    [SEASONAL_MATERIAL.AUTUMN_PEAK]: Object.freeze({
      deciduousCanopyAutumn: { albedo: [0.45, 0.25, 0.05], roughness: 0.80 },
      leafLitter: { albedo: [0.28, 0.20, 0.12], roughness: 0.88 }
    }),
    [SEASONAL_MATERIAL.WINTER_BARE_BRANCH]: Object.freeze({
      deciduousBark: { albedo: [0.20, 0.16, 0.12], roughness: 0.90 },
      snow: { albedo: [0.90, 0.92, 0.95], roughness: 0.40 },
      alfisol: { albedo: [0.22, 0.18, 0.14], wetnessResponse: 0.20 }
    })
  }),
  snowAccumulationRateMmHr: 1.2,
  snowMeltRateMmHr: 2.5,
  snowAlbedoSeasonal: 0.88
});

// ─── Procedural ─────────────────────────────────────────────────
const PROCEDURAL = Object.freeze({
  macroCanopyNoiseScale: 150.0,
  midUnderstoryNoiseScale: 35.0,
  microLitterNoiseScale: 6.0,
  terrainNoiseScale: 180.0,
  treeDensityPerHa: VEGETATION.treeDensityPerHa,
  shrubDensityPerHa: VEGETATION.shrubDensityPerHa,
  groundCoverDensityPerHa: VEGETATION.groundCoverDensityPerHa,
  lodHighDistance: 700.0,
  lodMidDistance: 3000.0,
  lodLowDistance: 15000.0,
  maxFireEventsPerTick: 0,          // fire is rare in mesic deciduous forest
  maxErosionEventsPerTick: 1,
  maxGrowthEventsPerTick: 4
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING ────────────────────────────────────────
// Temperate deciduous forest suitability is driven by moderate temperatures
// with a cold winter, even precipitation, loam/alfisol soil, and low-to-mid
// elevation. 328_BiomeBlendField uses this to decide how much of the
// temperate deciduous biome applies at any world point.
// ══════════════════════════════════════════════════════════════════
const _scratchVec3 = new Vec3();
const _scratchNoise = new SimplexNoise();

function getSuitability(env) {
  // ─── Temperature: warm summer, cold winter ─────────────────────────
  const tempScore = smoothstep(-20.0, 0.0, env.temperatureC) * (1.0 - smoothstep(28.0, 38.0, env.temperatureC));

  // ─── Humidity: humid year-round ───────────────────────────────────
  const humidityScore = smoothstep(0.50, 0.70, env.humidity) * (1.0 - smoothstep(0.85, 0.95, env.humidity));

  // ─── Elevation: lowland to mid-elevation ──────────────────────────
  const elevScore = smoothstep(0.0, 200.0, env.elevationM) * (1.0 - smoothstep(900.0, 1500.0, env.elevationM));

  // ─── Slope: gentle to moderate ────────────────────────────────────
  const slopeScore = smoothstep(0.0, 3.0, env.slopeDeg) * (1.0 - smoothstep(20.0, 35.0, env.slopeDeg));

  // ─── Soil texture: loam to silt loam (alfisol) is ideal ───────────
  const textureScore =
    0.40 * smoothstep(0.30, 0.50, env.soilSilt) +
    0.35 * smoothstep(0.25, 0.45, env.soilSand) +
    0.25 * smoothstep(0.10, 0.25, env.soilClay);

  // ─── Water table: moderate depth ──────────────────────────────────
  const waterScore = smoothstep(2.0, 5.0, env.waterTableDepthM) * (1.0 - smoothstep(10.0, 20.0, env.waterTableDepthM));

  // ─── Patchiness ────────────────────────────────────────────────────
  const patchiness = env.noise !== undefined ? (0.85 + 0.15 * env.noise) : 1.0;

  // ─── Weighted fusion ────────────────────────────────────────────────
  const raw =
    0.25 * tempScore +
    0.20 * humidityScore +
    0.15 * elevScore +
    0.12 * slopeScore +
    0.18 * textureScore +
    0.10 * waterScore;

  return Math.max(0.0, Math.min(1.0, raw * patchiness));
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR EXPORT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const TemperateDeciduousForestBiome = Object.freeze({
  id: BIOME_ID,
  bit: BIOME_BIT,
  name: BIOME_NAME,
  displayName: BIOME_DISPLAY_NAME,
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
  getSuitability,
  register(registry) {
    if (registry && typeof registry.registerBiome === 'function') {
      registry.registerBiome(BIOME_ID, BIOME_NAME, this);
    }
  }
});

export default TemperateDeciduousForestBiome;