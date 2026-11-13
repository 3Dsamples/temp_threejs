// file number : 326_Z06
// full path name : src/context/326_Z06_TaigaBorealConiferousForestBiome.js
// description : Taiga / boreal coniferous forest biome descriptor — the first
// of four additional forest biome presets. The taiga is the world's largest
// terrestrial biome, a circumpolar belt of evergreen coniferous forest across
// North America and Eurasia. Its defining drivers are a cold-humid climate with
// annual precipitation of 250–750 mm, mean annual temperatures below 0 °C,
// permafrost (continuous, discontinuous, or sporadic), a 3–5 month growing
// season, and nutrient-poor acidic soils that favour conifer dominance. The
// forest structure is simple: a single conifer canopy (spruce, fir, pine, larch)
// with a ground layer of mosses and lichens, and a sparse shrub understorey.
// Larch dominates on continuous permafrost where the climate is too dry and
// cold for spruce and fir. Provides the same eleven interlocking descriptor
// blocks as the base biomes, with full PBR + anime parameters for conifer
// needle, bark, moss, lichen, podzol soil, peat, and seasonal snow. The
// descriptor allocates nothing after construction and is consumed by the biome
// registry, blend field, material bridge, climate/soil/hydrology couplings,
// fauna migration system, chunk descriptor, and the full material/lighting/
// sensory pipeline.
//#
// best for : Every consumer that needs a taiga, boreal forest, or northern
// coniferous forest biome preset — biome registry barrel (327), biome blend
// field (328), biome blend system (329), cross-biome ecotone (330), biome
// material bridge (331), biome climate coupling (332), biome soil coupling
// (333), biome hydrology coupling (334), biome fauna migration (335), landscape
// chunk descriptor (336), and the whole material/lighting/sensory pipeline.
// Together with the other forest biome files this completes the planet-scale
// living-biome palette, and the taiga preset is the one that must remain
// seamless from the tundra of 323 through the boreal forest into the temperate
// forest biomes.
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
const BIOME_ID = 15;
const BIOME_NAME = 'taiga_boreal_coniferous_forest';
const BIOME_DISPLAY_NAME = 'Taiga / Boreal Coniferous Forest';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── TAIGA CHARACTERISTIC PARAMETERS ────────────────────────────
// ══════════════════════════════════════════════════════════════════
// ─── Climate ────────────────────────────────────────────────────
// Cold-humid, with annual precipitation of 250–750 mm, mean annual
// temperature below 0 °C, and extreme seasonal temperature fluctuation.
// The growing season lasts 3–5 months (maximum 6 months).
const CLIMATE = Object.freeze({
  // Temperature (°C) — extreme annual range
  temperatureMin: -50.0,            // continental Siberian winter minimum
  temperatureMax: 25.0,             // short, warm summer maximum
  temperatureMean: -3.0,            // mean annual below 0 °C
  temperatureDailySwing: 10.0,
  temperatureFrostFree: false,       // frost any month
  // Humidity (0..1) — cold-humid, poor drainage
  humidityMin: 0.45,
  humidityMax: 0.90,
  humidityMean: 0.68,
  // Precipitation (mm/hr mean) — 250–750 mm annually
  precipitationMean: 1.0,
  precipitationMax: 12.0,
  precipitationStormProb: 0.08,
  precipitationAnnualMm: 450.0,     // 250–750 mm
  // Seasons — long winter, short growing season
  seasonalityAmplitude: 0.95,
  drySeasonLengthDays: 0,
  wetSeasonPeakDay: 180,
  snowSeasonDays: 200,              // snow cover 6–8 months
  growingSeasonDays: 120,           // 3–5 months
  // Wind — moderate, channelled by topography
  windMeanSpeed: 2.5,
  windMaxSpeed: 20.0,
  windPredominantDirDeg: 315,
  // Weather state probabilities (0..1)
  weatherProbClear: 0.25,
  weatherProbCloudy: 0.40,
  weatherProbRain: 0.15,
  weatherProbStorm: 0.05,
  weatherProbSnow: 0.15,
  weatherProbFog: 0.00,
  // Atmospheric
  pressureMeanKPa: 101.0,
  pressureSwingKPa: 3.0
});

// ─── Terrain Bias ────────────────────────────────────────────────
// The taiga occupies glaciated lowlands, shield regions, and gentle uplands.
// Local relief is low to moderate; permafrost and poor drainage create
// extensive peatlands and waterlogged ground.
const TERRAIN = Object.freeze({
  elevationBand: ELEVATION_BAND.LOWLAND_TO_UPLAND,
  elevationMinM: 0.0,
  elevationMaxM: 800.0,
  slopeMeanDeg: 3.0,
  slopeMaxDeg: 20.0,
  roughness: 0.50,                  // hummocky, peat-rich
  valleyDepth: 0.30,
  valleyDensity: 0.50,
  plateauBias: 0.65,
  groundwaterTableDepthM: 1.0,      // shallow, poor drainage
  permafrostDepthM: 1.5,            // discontinuous to continuous permafrost
  terrainRoughnessHint: 0.55,
  biomeHint: BIOME_HINT.CONIFEROUS_FOREST
});

// ─── Soil ──────────────────────────────────────────────────────
// Taiga soils are nutrient-poor, acidic, and often podzolized. Permafrost
// restricts drainage, leading to peat accumulation and waterlogged conditions.
// Nitrogen is the primary limiting nutrient.
const SOIL = Object.freeze({
  textureClass: SOIL_TEXTURE_CLASS.SILT_LOAM,
  visualArchetype: SOIL_VISUAL_ARCHETYPE.PODZOL,
  // Primary fractions (0..1)
  sand: 0.35,
  silt: 0.40,
  clay: 0.10,
  organicMatter: 0.15,              // thick surface litter but slow decomposition
  gravel: 0.00,
  rockFragment: 0.00,
  // Chemistry
  pH: 4.2,                          // strongly acidic
  fertilityClass: FERTILITY_CLASS.POOR,
  fertilityIndex: 0.20,
  // Physics
  porosity: 0.45,
  bulkDensityGcm3: 1.25,
  waterHoldingCapacity: 0.30,
  hydraulicConductivityMmHr: 2.0,
  cohesionKPa: 8.0,
  plasticityIndex: 12.0,
  // Colour (linear RGB)
  baseAlbedo: [0.18, 0.15, 0.12],
  organicDarkening: 0.60,
  ironOxideRedness: 0.15,
  calciumPale: 0.00,
  // Erosion
  usleKFactor: 0.30,
  windErodibility: 0.20,
  // ─── Permafrost and drainage parameters ────────────────────
  permafrostPresence: 'discontinuous',
  activeLayerDepthM: 0.8,
  drainageClass: 'poor'
});

// ─── Vegetation ─────────────────────────────────────────────────
// Taiga vegetation is dominated by evergreen conifers — spruce, fir, and pine
// — with larch dominating on continuous permafrost. The ground layer is mosses
// and lichens; the shrub layer is sparse. Deciduous broadleaved species
// (birch, aspen) occur in early succession and in some environments.
const VEGETATION = Object.freeze({
  treeTypeWeights: Object.freeze({
    [TREE_TYPE.SPRUCE]: 0.35,
    [TREE_TYPE.FIR]: 0.25,
    [TREE_TYPE.PINE]: 0.20,
    [TREE_TYPE.LARCH]: 0.10,       // dominant on continuous permafrost
    [TREE_TYPE.BIRCH]: 0.10        // early successional and some environments
  }),
  grassTypeWeights: Object.freeze({
    [GRASS_TYPE.TUNDRA_TUFT]: 0.35,
    [GRASS_TYPE.MARSH_REED]: 0.25,
    [GRASS_TYPE.SHORT_PRAIRIE]: 0.25,
    [GRASS_TYPE.FERN]: 0.15
  }),
  verticalLayers: 3,                // overstorey, shrub, ground
  emergentDensity: 0.00,
  canopyDensity: 0.65,              // closed or semi-closed
  understoryDensity: 0.25,          // sparse
  groundCoverDensity: 0.60,         // moss and lichen dominate
  epiphyteDensity: 0.15,            // lichen on bark
  lianaDensity: 0.00,
  successionTarget: SUCCESSION.CLIMAX,
  fireRegimeYears: 100,             // stand-replacing fire every 50–150 years
  rootDepthM: 0.8,                  // shallow, above permafrost
  canopyRadiusM: 2.5,
  trunkHeightM: 15.0,
  leafLitterDepthM: 0.10,
  bloomWindowDays: 30,
  // Poisson-disc targets per hectare
  treeDensityPerHa: 1200,
  shrubDensityPerHa: 800,
  groundCoverDensityPerHa: 15000,
  // ─── Larch-permafrost interaction ──────────────────────────
  // Larch dominates where permafrost is continuous and the climate is too
  // dry and cold for spruce and fir.
  larchPermafrostThreshold: 0.70
});

// ─── Fauna ──────────────────────────────────────────────────────
const FAUNA = Object.freeze({
  densityWeight: 0.40,
  habitatLayers: Object.freeze({
    ground: 0.35,
    understory: 0.30,
    canopy: 0.25,
    aerial: 0.10
  }),
  dielActivity: 0.30,               // crepuscular bias
  migrationCorridorWeight: 0.70,    // strong seasonal migration (caribou, birds)
  predatorPreyBalance: 0.40,
  nectarAvailability: 0.05,
  pollenAvailability: 0.10,
  // Characteristic guild weights
  largeHerbivoreWeight: 0.25,       // moose, caribou
  largePredatorWeight: 0.20,        // wolf, bear, lynx
  smallMammalWeight: 0.30,
  birdWeight: 0.20,
  insectWeight: 0.05                // short insect season
});

// ─── Materials ──────────────────────────────────────────────────
// Full PBR + anime parameters for taiga surfaces: conifer needle, bark, moss,
// lichen, podzol soil, peat, and seasonal snow.
const MATERIALS = Object.freeze({
  // ─── Conifer needle (spruce / fir / pine) ───────────────────
  coniferNeedle: Object.freeze({
    albedo: [0.04, 0.10, 0.04],     // dark green
    roughness: 0.80,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.35,
    animeFlatness: 0.30,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.85,
    hardness: 0.40,
    brittleness: 0.60
  }),
  // ─── Larch needle (deciduous conifer) ───────────────────────
  larchNeedle: Object.freeze({
    albedo: [0.12, 0.18, 0.08],     // lighter green, turns gold in autumn
    roughness: 0.78,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.40,
    animeFlatness: 0.25,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.80,
    hardness: 0.35,
    brittleness: 0.65
  }),
  // ─── Conifer bark ───────────────────────────────────────────
  coniferBark: Object.freeze({
    albedo: [0.10, 0.07, 0.05],
    roughness: 0.92,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.20,
    animeFlatness: 0.40,
    acousticProfile: ACOUSTIC_PROFILE.WOOD,
    flammability: 0.70,
    hardness: 0.75,
    brittleness: 0.35
  }),
  // ─── Moss / lichen ground cover ─────────────────────────────
  mossLichen: Object.freeze({
    albedo: [0.18, 0.20, 0.12],
    roughness: 0.90,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.55,
    animeFlatness: 0.20,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.30,
    hardness: 0.15,
    brittleness: 0.80
  }),
  // ─── Podzol soil ────────────────────────────────────────────
  podzol: Object.freeze({
    albedo: [0.14, 0.10, 0.07],
    roughness: 0.95,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.70,
    animeFlatness: 0.50,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.10,
    hardness: 0.20,
    brittleness: 0.70
  }),
  // ─── Peat / bog surface ─────────────────────────────────────
  peat: Object.freeze({
    albedo: [0.08, 0.06, 0.04],
    roughness: 0.88,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.90,
    animeFlatness: 0.35,
    acousticProfile: ACOUSTIC_PROFILE.WATER,
    flammability: 0.25,
    hardness: 0.10,
    brittleness: 0.85
  }),
  // ─── Seasonal snow ─────────────────────────────────────────
  snow: Object.freeze({
    albedo: [0.92, 0.94, 0.96],
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
    brittleness: 0.90
  })
});

// ─── Lighting ───────────────────────────────────────────────────
const LIGHTING = Object.freeze({
  canopyOcclusion: 0.70,            // dense conifer canopy blocks light
  sunDiffuseFraction: 0.55,         // diffuse dominates under cloud and canopy
  sunIntensityScale: 0.85,
  colourCast: [0.92, 0.96, 1.00],   // cool blue-white
  atmosphericScatterBoost: 1.15,
  bioluminescentEmission: 0.02,
  dappledLightFrequency: 0.35,
  dappledLightAmplitude: 0.25,
  shadowSoftnessNear: 0.5,
  shadowSoftnessMid: 0.7,
  shadowSoftnessFar: 0.9,
  shadowCascadeScale: 0.8,
  snowAlbedoBoost: 1.40,
  fogDensityBase: 0.025,
  skyTint: [0.75, 0.82, 0.90]
});

// ─── Water ──────────────────────────────────────────────────────
// The taiga is often wet despite low precipitation because permafrost and
// poor drainage prevent infiltration and evaporation. Bogs, muskeg, and
// shallow lakes are characteristic.
const WATER = Object.freeze({
  surfaceWaterPresence: 0.35,
  riverineNetworkDensity: 0.30,
  canopyDrip: 0.40,
  groundwaterTableDepthM: 1.0,
  freshwaterSpringPresence: 0.20,
  waterTableDepthM: 1.0,
  bogCoverage: 0.30,
  lakeCoverage: 0.10,
  riverWidthMeanM: 6.0,
  waterTemperatureC: 6.0,
  iceCoverMonths: 7,
  shorelineMaterial: 'peat'
});

// ─── Sensory ────────────────────────────────────────────────────
const SENSORY = Object.freeze({
  acoustic: Object.freeze({
    biological: 0.15,
    geological: 0.05,
    water: 0.25,
    wind: 0.35,
    vegetation: 0.20,
    mechanical: 0.00
  }),
  olfactory: Object.freeze({
    floral: 0.05,
    earthy: 0.30,
    aquatic: 0.20,
    woodland: 0.25,                 // resin, pine, spruce
    smoke: 0.10,
    animal: 0.05,
    decay: 0.10,
    sulfur: 0.00,
    sea: 0.00,
    clean: 0.10
  }),
  tactile: Object.freeze({
    temperatureC: 2.0,
    humidity: 0.68,
    windPressurePa: 3.0,
    precipitationType: 'snow',
    groundHardness: 0.30
  })
});

// ─── Seasonality ────────────────────────────────────────────────
// Taiga phenology is a brief summer green-up followed by a long winter
// dormant period under snow. Larch sheds its needles in autumn.
const SEASONALITY = Object.freeze({
  phenologyOverrides: Object.freeze({
    budBreakDayOffset: -10,
    fullGreenDurationDays: 75,
    autumnColourShiftDays: 20,
    leafDropDurationDays: 15,
    bloomWindowDays: 25,
    sporeBoostWetSeason: 0.30,
    fungalBoostWetSeason: 0.25
  }),
  seasonalMaterialPalettes: Object.freeze({
    [SEASONAL_MATERIAL.SPRING_NEW_LEAF]: Object.freeze({
      coniferNeedle: { albedo: [0.06, 0.12, 0.06], roughness: 0.78 },
      podzol: { albedo: [0.16, 0.12, 0.08], wetnessResponse: 0.80 }
    }),
    [SEASONAL_MATERIAL.SUMMER_FULL_GREEN]: Object.freeze({
      coniferNeedle: { albedo: [0.04, 0.10, 0.04], roughness: 0.80 },
      larchNeedle: { albedo: [0.12, 0.18, 0.08], roughness: 0.78 }
    }),
    [SEASONAL_MATERIAL.AUTUMN_PEAK]: Object.freeze({
      coniferNeedle: { albedo: [0.08, 0.09, 0.05], roughness: 0.82 },
      larchNeedle: { albedo: [0.35, 0.25, 0.08], roughness: 0.80 }  // golden
    }),
    [SEASONAL_MATERIAL.WINTER_BARE_BRANCH]: Object.freeze({
      coniferNeedle: { albedo: [0.06, 0.07, 0.06], roughness: 0.85 },
      podzol: { albedo: [0.20, 0.18, 0.16], wetnessResponse: 0.20 },
      snow: { albedo: [0.92, 0.94, 0.96], roughness: 0.40 }
    })
  }),
  snowAccumulationRateMmHr: 1.5,
  snowMeltRateMmHr: 3.0,
  snowAlbedoSeasonal: 0.90
});

// ─── Procedural ─────────────────────────────────────────────────
const PROCEDURAL = Object.freeze({
  macroCanopyNoiseScale: 120.0,
  midUnderstoryNoiseScale: 40.0,
  microLitterNoiseScale: 8.0,
  terrainNoiseScale: 200.0,
  peatlandNoiseScale: 80.0,
  treeDensityPerHa: VEGETATION.treeDensityPerHa,
  shrubDensityPerHa: VEGETATION.shrubDensityPerHa,
  groundCoverDensityPerHa: VEGETATION.groundCoverDensityPerHa,
  lodHighDistance: 500.0,
  lodMidDistance: 2000.0,
  lodLowDistance: 10000.0,
  maxFireEventsPerTick: 1,
  maxErosionEventsPerTick: 1,
  maxGrowthEventsPerTick: 3
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING ────────────────────────────────────────
// Taiga suitability is driven by cold mean annual temperature, moderate
// precipitation, shallow water table (poor drainage), acidic silt-loam soil,
// and low elevation. 328_BiomeBlendField uses this to decide how much of the
// taiga biome applies at any world point.
// ══════════════════════════════════════════════════════════════════
const _scratchVec3 = new Vec3();
const _scratchNoise = new SimplexNoise();

function getSuitability(env) {
  // ─── Temperature: taiga is centred on cold means with short cool summers ─
  const tempScore = smoothstep(-45.0, -10.0, env.temperatureC) * (1.0 - smoothstep(18.0, 28.0, env.temperatureC));

  // ─── Humidity: cold-humid, poor drainage ─────────────────────────────
  const humidityScore = smoothstep(0.45, 0.65, env.humidity) * (1.0 - smoothstep(0.85, 0.95, env.humidity));

  // ─── Elevation: lowland to upland; high alpine is excluded ───────────
  const elevScore = smoothstep(0.0, 200.0, env.elevationM) * (1.0 - smoothstep(600.0, 1200.0, env.elevationM));

  // ─── Slope: gentle; steep slopes shed soil and permafrost ───────────
  const slopeScore = smoothstep(0.0, 5.0, env.slopeDeg) * (1.0 - smoothstep(15.0, 30.0, env.slopeDeg));

  // ─── Soil texture: silt-loam podzol is ideal ─────────────────────────
  const textureScore =
    0.45 * smoothstep(0.30, 0.50, env.soilSilt) +
    0.35 * smoothstep(0.15, 0.40, env.soilSand) +
    0.20 * (1.0 - smoothstep(0.05, 0.20, env.soilClay));

  // ─── Water table: shallow due to permafrost and poor drainage ───────
  const waterScore = smoothstep(0.3, 1.0, env.waterTableDepthM) * (1.0 - smoothstep(2.0, 4.0, env.waterTableDepthM));

  // ─── Patchiness ────────────────────────────────────────────────────
  const patchiness = env.noise !== undefined ? (0.85 + 0.15 * env.noise) : 1.0;

  // ─── Weighted fusion ────────────────────────────────────────────────
  const raw =
    0.30 * tempScore +
    0.18 * humidityScore +
    0.15 * elevScore +
    0.10 * slopeScore +
    0.15 * textureScore +
    0.12 * waterScore;

  return Math.max(0.0, Math.min(1.0, raw * patchiness));
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR EXPORT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const TaigaBorealConiferousForestBiome = Object.freeze({
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

export default TaigaBorealConiferousForestBiome;