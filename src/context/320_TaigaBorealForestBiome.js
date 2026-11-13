// file number : 320
// full path name : src/context/320_TaigaBorealForestBiome.js
// description : Taiga / boreal forest biome descriptor — the third of the nine
// biome presets, tuned for the subarctic coniferous belt (50°–70° N and the
// corresponding southern-hemisphere latitudes). Provides the same eleven
// interlocking descriptor blocks as 318 and 319, but every parameter is
// recalibrated for the taiga's defining constraints: short cool summers, long
// severe winters, permafrost-influenced soils, waterlogged bogs, fire-driven
// succession, and a narrow conifer-dominated species palette (spruce, fir,
// pine, larch). The descriptor is a pure parameter set: it allocates nothing
// after construction and is consumed by 327_BiomeRegistryBarrel,
// 328_BiomeBlendField, 331_BiomeBlendMaterialBridge, 332–334 couplings,
// 335_BiomeFaunaMigrationSystem, 336_LandscapeChunkDescriptor, the flora/fauna
// spawners, and the material/lighting/sensory pipelines.
// best for : Every consumer that needs a subarctic coniferous biome preset —
// biome registry barrel (327), biome blend field (328), biome blend system
// (329), cross-biome ecotone (330), biome material bridge (331), biome climate
// coupling (332), biome soil coupling (333), biome hydrology coupling (334),
// biome fauna migration (335), landscape chunk descriptor (336), and the whole
// material/lighting/sensory pipeline. Together with the other eight biome files
// this completes the planet-scale living-biome palette.
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
const BIOME_ID = 3;
const BIOME_NAME = 'taiga_boreal_forest';
const BIOME_DISPLAY_NAME = 'Taiga / Boreal Forest';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── TAIGA CHARACTERISTIC PARAMETERS ────────────────────────────
// ══════════════════════════════════════════════════════════════════
// ─── Climate ────────────────────────────────────────────────────
const CLIMATE = Object.freeze({
  // Temperature (°C) — short cool summer, long severe winter
  temperatureMin: -45.0,
  temperatureMax: 22.0,
  temperatureMean: -2.0,
  temperatureDailySwing: 12.0,      // strong diurnal swing under clear boreal skies
  temperatureFrostFree: false,      // frost possible any month
  // Humidity (0..1) — moderate, but waterlogged ground is common
  humidityMin: 0.40,
  humidityMax: 0.85,
  humidityMean: 0.65,
  // Precipitation (mm/hr mean) — low total, mostly snow
  precipitationMean: 1.2,
  precipitationMax: 12.0,
  precipitationStormProb: 0.10,
  precipitationAnnualMm: 450.0,     // low annual total
  // Seasons — long winter, short growing season
  seasonalityAmplitude: 0.95,       // extreme seasonal swing
  drySeasonLengthDays: 0,
  wetSeasonPeakDay: 0,
  snowSeasonDays: 210,              // ~7 months of snow potential
  growingSeasonDays: 90,            // very short growing season
  // Wind — moderate, channelled by topography
  windMeanSpeed: 2.8,
  windMaxSpeed: 22.0,
  windPredominantDirDeg: 315,       // northwesterly in the boreal belt
  // Weather state probabilities (0..1)
  weatherProbClear: 0.25,
  weatherProbCloudy: 0.35,
  weatherProbRain: 0.15,
  weatherProbStorm: 0.05,
  weatherProbSnow: 0.20,
  weatherProbFog: 0.00,
  // Atmospheric
  pressureMeanKPa: 101.0,
  pressureSwingKPa: 3.0
});

// ─── Terrain Bias ────────────────────────────────────────────────
const TERRAIN = Object.freeze({
  elevationBand: ELEVATION_BAND.LOWLAND,
  elevationMinM: 0.0,
  elevationMaxM: 800.0,
  slopeMeanDeg: 4.0,
  slopeMaxDeg: 25.0,
  roughness: 0.55,                  // hummocky, peat-rich ground
  valleyDepth: 0.35,
  valleyDensity: 0.60,
  plateauBias: 0.70,                // extensive flat lowlands
  groundwaterTableDepthM: 0.5,      // very shallow — waterlogged
  permafrostDepthM: 1.2,            // discontinuous permafrost
  terrainRoughnessHint: 0.65,
  biomeHint: BIOME_HINT.CONIFEROUS_FOREST
});

// ─── Soil ──────────────────────────────────────────────────────
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
  pH: 4.2,                          // strongly acidic podzol
  fertilityClass: FERTILITY_CLASS.POOR,
  fertilityIndex: 0.25,
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
  usleKFactor: 0.35,
  windErodibility: 0.25
});

// ─── Vegetation ─────────────────────────────────────────────────
// Taiga is conifer-dominated; broadleaf species are rare and confined to
// disturbed or early-successional patches.
const VEGETATION = Object.freeze({
  treeTypeWeights: Object.freeze({
    [TREE_TYPE.SPRUCE]: 0.40,
    [TREE_TYPE.FIR]: 0.25,
    [TREE_TYPE.PINE]: 0.20,
    [TREE_TYPE.LARCH]: 0.10,
    [TREE_TYPE.BIRCH]: 0.05      // early-successional only
  }),
  grassTypeWeights: Object.freeze({
    [GRASS_TYPE.TUNDRA_TUFT]: 0.35,
    [GRASS_TYPE.MARSH_REED]: 0.30,
    [GRASS_TYPE.SHORT_PRAIRIE]: 0.20,
    [GRASS_TYPE.FERN]: 0.10,
    [GRASS_TYPE.SNOWDROP]: 0.05
  }),
  verticalLayers: 3,                // overstorey, shrub, ground — no true emergent
  emergentDensity: 0.00,
  canopyDensity: 0.75,
  understoryDensity: 0.30,
  groundCoverDensity: 0.50,
  epiphyteDensity: 0.15,            // lichen and moss, not vascular epiphytes
  lianaDensity: 0.00,
  successionTarget: SUCCESSION.CLIMAX,
  fireRegimeYears: 80,              // stand-replacing fire every 50–150 yr
  rootDepthM: 0.8,
  canopyRadiusM: 2.5,
  trunkHeightM: 15.0,
  leafLitterDepthM: 0.10,
  bloomWindowDays: 30,              // very short flowering window
  // Poisson-disc targets per hectare
  treeDensityPerHa: 1200,
  shrubDensityPerHa: 800,
  groundCoverDensityPerHa: 15000
});

// ─── Fauna ──────────────────────────────────────────────────────
const FAUNA = Object.freeze({
  densityWeight: 0.45,              // lower biodiversity than temperate/tropical
  habitatLayers: Object.freeze({
    ground: 0.40,
    understory: 0.30,
    canopy: 0.25,
    aerial: 0.05
  }),
  dielActivity: 0.35,               // 0 = nocturnal, 1 = diurnal; crepuscular bias
  migrationCorridorWeight: 0.60,    // strong seasonal migration
  predatorPreyBalance: 0.40,
  nectarAvailability: 0.10,
  pollenAvailability: 0.15,
  // Characteristic guild weights
  largeHerbivoreWeight: 0.30,       // moose, caribou
  largePredatorWeight: 0.20,        // wolf, bear
  smallMammalWeight: 0.30,
  birdWeight: 0.15,
  insectWeight: 0.05                // short insect season
});

// ─── Materials ──────────────────────────────────────────────────
// Full PBR + anime parameters for the taiga's characteristic surfaces.
const MATERIALS = Object.freeze({
  // ─── Conifer needle (spruce/fir/pine) ────────────────────────
  coniferNeedle: Object.freeze({
    albedo: [0.04, 0.10, 0.04],
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
  // ─── Lichen / moss ground cover ─────────────────────────────
  lichenMoss: Object.freeze({
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
  podzolSoil: Object.freeze({
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
  peatBog: Object.freeze({
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
  // ─── Snow (seasonal) ────────────────────────────────────────
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
  }),
  // ─── Rock / outcrop ─────────────────────────────────────────
  rock: Object.freeze({
    albedo: [0.22, 0.22, 0.20],
    roughness: 0.85,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.15,
    animeFlatness: 0.45,
    acousticProfile: ACOUSTIC_PROFILE.ROCK,
    flammability: 0.0,
    hardness: 0.90,
    brittleness: 0.30
  })
});

// ─── Lighting ───────────────────────────────────────────────────
const LIGHTING = Object.freeze({
  canopyOcclusion: 0.70,            // dense conifer canopy blocks light
  sunDiffuseFraction: 0.55,         // diffuse dominates under cloud and canopy
  sunIntensityScale: 0.85,          // lower angle of incidence at high latitude
  colourCast: [0.92, 0.96, 1.00],   // cool blue-white cast
  atmosphericScatterBoost: 1.15,
  bioluminescentEmission: 0.02,     // very low — some fungi and lichen
  dappledLightFrequency: 0.35,
  dappledLightAmplitude: 0.25,
  shadowSoftnessNear: 0.5,
  shadowSoftnessMid: 0.7,
  shadowSoftnessFar: 0.9,
  shadowCascadeScale: 0.8,          // lower cascades for low-end devices
  snowAlbedoBoost: 1.40,            // snow reflects strongly
  fogDensityBase: 0.025,            // boreal haze and summer wildfire smoke
  skyTint: [0.75, 0.82, 0.90]
});

// ─── Water ──────────────────────────────────────────────────────
const WATER = Object.freeze({
  surfaceWaterPresence: 0.40,       // bogs, ponds, slow rivers
  riverineNetworkDensity: 0.35,
  canopyDrip: 0.45,
  groundwaterTableDepthM: 0.5,
  freshwaterSpringPresence: 0.30,
  waterTableDepthM: 0.5,
  bogCoverage: 0.35,                // peat bogs and muskeg are characteristic
  lakeCoverage: 0.15,
  riverWidthMeanM: 8.0,
  waterTemperatureC: 6.0,
  iceCoverMonths: 7,
  shorelineMaterial: 'peatBog'
});

// ─── Sensory ────────────────────────────────────────────────────
const SENSORY = Object.freeze({
  // Acoustic signature (0..1 weights across 8 channels)
  acoustic: Object.freeze({
    biological: 0.20,               // bird song, insect hum (short season)
    geological: 0.05,
    water: 0.25,                    // bog seep, stream trickle
    wind: 0.35,                     // wind in conifer needles dominates
    vegetation: 0.15,
    mechanical: 0.00
  }),
  // Olfactory signature
  olfactory: Object.freeze({
    floral: 0.05,
    earthy: 0.30,
    aquatic: 0.20,
    woodland: 0.25,                 // resin, pine, spruce
    smoke: 0.15,                    // wildfire smoke is a defining taiga smell
    animal: 0.05,
    decay: 0.10,                    // slow decomposition, peat
    sulfur: 0.00,
    sea: 0.00,
    clean: 0.10
  }),
  // Tactile profile
  tactile: Object.freeze({
    temperatureC: 2.0,
    humidity: 0.65,
    windPressurePa: 3.0,
    precipitationType: 'snow',
    groundHardness: 0.30           // soft, mossy, waterlogged
  })
});

// ─── Seasonality ────────────────────────────────────────────────
// The taiga's phenology is driven by an extremely short growing season and a
// long snow-covered winter. Material palettes switch between a brief green
// season and a long white/brown dormant season.
const SEASONALITY = Object.freeze({
  phenologyOverrides: Object.freeze({
    budBreakDayOffset: -10,         // late bud-break
    fullGreenDurationDays: 75,      // very short
    autumnColourShiftDays: 20,
    leafDropDurationDays: 15,
    bloomWindowDays: 25,
    sporeBoostWetSeason: 0.40,
    fungalBoostWetSeason: 0.30
  }),
  seasonalMaterialPalettes: Object.freeze({
    [SEASONAL_MATERIAL.SPRING_NEW_LEAF]: Object.freeze({
      coniferNeedle: { albedo: [0.06, 0.12, 0.06], roughness: 0.78 },
      podzolSoil: { albedo: [0.16, 0.12, 0.08], wetnessResponse: 0.80 }
    }),
    [SEASONAL_MATERIAL.SUMMER_FULL_GREEN]: Object.freeze({
      coniferNeedle: { albedo: [0.04, 0.10, 0.04], roughness: 0.80 },
      podzolSoil: { albedo: [0.14, 0.10, 0.07], wetnessResponse: 0.50 }
    }),
    [SEASONAL_MATERIAL.AUTUMN_PEAK]: Object.freeze({
      coniferNeedle: { albedo: [0.08, 0.09, 0.05], roughness: 0.82 },
      lichenMoss: { albedo: [0.20, 0.18, 0.10], roughness: 0.88 }
    }),
    [SEASONAL_MATERIAL.WINTER_BARE_BRANCH]: Object.freeze({
      coniferNeedle: { albedo: [0.06, 0.07, 0.06], roughness: 0.85 },
      podzolSoil: { albedo: [0.20, 0.18, 0.16], wetnessResponse: 0.20 },
      snow: { albedo: [0.92, 0.94, 0.96], roughness: 0.40 }
    })
  }),
  snowAccumulationRateMmHr: 1.5,
  snowMeltRateMmHr: 3.0,
  snowAlbedoSeasonal: 0.90
});

// ─── Procedural ─────────────────────────────────────────────────
const PROCEDURAL = Object.freeze({
  // Noise scales (world units) for each vertical layer
  macroCanopyNoiseScale: 120.0,
  midUnderstoryNoiseScale: 40.0,
  microLitterNoiseScale: 8.0,
  terrainNoiseScale: 200.0,
  bogNoiseScale: 80.0,
  // Poisson-disc density targets (per hectare) — mirrored from VEGETATION
  treeDensityPerHa: VEGETATION.treeDensityPerHa,
  shrubDensityPerHa: VEGETATION.shrubDensityPerHa,
  groundCoverDensityPerHa: VEGETATION.groundCoverDensityPerHa,
  // LOD scale thresholds (world units)
  lodHighDistance: 500.0,
  lodMidDistance: 2000.0,
  lodLowDistance: 10000.0,
  // Procedural event budgets
  maxFireEventsPerTick: 2,
  maxErosionEventsPerTick: 1,
  maxGrowthEventsPerTick: 3
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING ────────────────────────────────────────
// Fuses temperature, humidity, elevation, slope, soil texture, and water-table
// depth into a single 0–1 weight. 328_BiomeBlendField uses this to decide how
// much of the taiga biome applies at any world point.
// ══════════════════════════════════════════════════════════════════
const _scratchVec3 = new Vec3();
const _scratchNoise = new SimplexNoise();

/**
 * Compute the taiga suitability at a world position and environmental state.
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
  // ─── Temperature: taiga is centred on cool summers and severe winters ──
  // Optimal mean annual temperature is around -2 °C, with a broad tolerance.
  const tempScore = smoothstep(-45.0, 22.0, env.temperatureC) * (1.0 - smoothstep(18.0, 30.0, env.temperatureC));

  // ─── Humidity: moderate; too dry becomes steppe, too wet becomes bog ──
  const humidityScore = smoothstep(0.30, 0.70, env.humidity) * (1.0 - smoothstep(0.80, 0.95, env.humidity));

  // ─── Elevation: lowland to foothill; high alpine is excluded ──────────
  const elevScore = smoothstep(0.0, 200.0, env.elevationM) * (1.0 - smoothstep(600.0, 1200.0, env.elevationM));

  // ─── Slope: gentle; steep slopes shed soil and support alpine species ─
  const slopeScore = smoothstep(0.0, 5.0, env.slopeDeg) * (1.0 - smoothstep(15.0, 35.0, env.slopeDeg));

  // ─── Soil texture: silt-loam podzol is ideal; sand or heavy clay is poor ─
  const textureScore =
    0.45 * smoothstep(0.20, 0.45, env.soilSilt) +
    0.35 * smoothstep(0.15, 0.40, env.soilSand) +
    0.20 * (1.0 - smoothstep(0.05, 0.25, env.soilClay));

  // ─── Water table: shallow but not permanently flooded ────────────────
  const waterScore = smoothstep(0.1, 0.6, env.waterTableDepthM) * (1.0 - smoothstep(1.2, 2.5, env.waterTableDepthM));

  // ─── Patchiness: break up the suitability field with low-frequency noise ─
  const patchiness = env.noise !== undefined ? (0.85 + 0.15 * env.noise) : 1.0;

  // ─── Weighted fusion ────────────────────────────────────────────────
  const raw =
    0.28 * tempScore +
    0.18 * humidityScore +
    0.15 * elevScore +
    0.12 * slopeScore +
    0.15 * textureScore +
    0.12 * waterScore;

  return Math.max(0.0, Math.min(1.0, raw * patchiness));
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR EXPORT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const TaigaBorealForestBiome = Object.freeze({
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

// ══════════════════════════════════════════════════════════════════
// ─── AUTO-REGISTRATION (optional, controlled by registry import) ─
// ══════════════════════════════════════════════════════════════════
// The registry barrel imports this module and calls register explicitly.
// To avoid a circular dependency, we do not import the registry here.
// If the runtime requires side-effect registration, the barrel calls
// TaigaBorealForestBiome.register(registry) after importing this file.

export default TaigaBorealForestBiome;