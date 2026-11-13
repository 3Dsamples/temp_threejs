// file number : 321
// full path name : src/context/321_GrasslandSavannaBiome.js
// description : Grassland / savanna biome descriptor — the fourth of the nine
// biome presets, tuned for tropical and subtropical grasslands (5°–30° in both
// hemispheres) where a pronounced dry season, seasonal fire, and grazing
// pressure are the defining ecological drivers. Provides the same eleven
// interlocking descriptor blocks as 318–320, but every parameter is recalibrated
// for the savanna's constraints: a bimodal wet/dry cycle, C4-grass dominance,
// fire-adapted flora, large-herbivore migration, and a two-layer vertical
// structure (grass + scattered trees). The descriptor is a pure parameter set:
// it allocates nothing after construction and is consumed by the biome registry,
// blend field, material bridge, climate/soil/hydrology couplings, fauna
// migration system, chunk descriptor, and the full material/lighting/sensory
// pipeline.
// best for : Every consumer that needs a grassland or savanna biome preset —
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
const BIOME_ID = 4;
const BIOME_NAME = 'grassland_savanna';
const BIOME_DISPLAY_NAME = 'Grassland / Savanna';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── SAVANNA CHARACTERISTIC PARAMETERS ──────────────────────────
// ══════════════════════════════════════════════════════════════════
// ─── Climate ────────────────────────────────────────────────────
const CLIMATE = Object.freeze({
  // Temperature (°C) — warm year-round, pronounced dry-season heat
  temperatureMin: 2.0,
  temperatureMax: 42.0,
  temperatureMean: 24.0,
  temperatureDailySwing: 18.0,      // strong diurnal swing in the dry season
  temperatureFrostFree: true,        // frost is rare but possible at margins
  // Humidity (0..1) — strongly bimodal: dry season very dry, wet season humid
  humidityMin: 0.10,
  humidityMax: 0.85,
  humidityMean: 0.45,
  // Precipitation (mm/hr mean) — concentrated in a short wet season
  precipitationMean: 1.8,
  precipitationMax: 25.0,
  precipitationStormProb: 0.20,     // convective storms are frequent
  precipitationAnnualMm: 750.0,     // intermediate between desert and forest
  // Seasons — distinct dry and wet periods
  seasonalityAmplitude: 0.70,
  drySeasonLengthDays: 150,
  wetSeasonPeakDay: 180,
  snowSeasonDays: 0,
  growingSeasonDays: 200,
  // Wind — moderate, often gusty in the dry season
  windMeanSpeed: 3.2,
  windMaxSpeed: 18.0,
  windPredominantDirDeg: 90,        // easterly trade winds at low latitudes
  // Weather state probabilities (0..1)
  weatherProbClear: 0.40,
  weatherProbCloudy: 0.25,
  weatherProbRain: 0.20,
  weatherProbStorm: 0.10,
  weatherProbSnow: 0.00,
  weatherProbFog: 0.00,
  // Atmospheric
  pressureMeanKPa: 101.3,
  pressureSwingKPa: 2.0
});

// ─── Terrain Bias ────────────────────────────────────────────────
const TERRAIN = Object.freeze({
  elevationBand: ELEVATION_BAND.LOWLAND,
  elevationMinM: 200.0,
  elevationMaxM: 1500.0,
  slopeMeanDeg: 2.0,
  slopeMaxDeg: 15.0,
  roughness: 0.30,                  // smooth plains and gently rolling hills
  valleyDepth: 0.20,
  valleyDensity: 0.30,
  plateauBias: 0.75,                // expansive flat plains
  groundwaterTableDepthM: 5.0,      // deeper than taiga, shallower than desert
  permafrostDepthM: Infinity,       // no permafrost
  terrainRoughnessHint: 0.25,
  biomeHint: BIOME_HINT.GRASSLAND
});

// ─── Soil ──────────────────────────────────────────────────────
const SOIL = Object.freeze({
  textureClass: SOIL_TEXTURE_CLASS.SANDY_LOAM,
  visualArchetype: SOIL_VISUAL_ARCHETYPE.SANDY_TAN,
  // Primary fractions (0..1)
  sand: 0.55,
  silt: 0.25,
  clay: 0.15,
  organicMatter: 0.05,              // low organic matter; fire consumes litter
  gravel: 0.00,
  rockFragment: 0.00,
  // Chemistry
  pH: 6.5,                          // slightly acidic to neutral
  fertilityClass: FERTILITY_CLASS.MODERATE,
  fertilityIndex: 0.45,
  // Physics
  porosity: 0.40,
  bulkDensityGcm3: 1.40,
  waterHoldingCapacity: 0.18,
  hydraulicConductivityMmHr: 12.0,
  cohesionKPa: 5.0,
  plasticityIndex: 8.0,
  // Colour (linear RGB)
  baseAlbedo: [0.35, 0.28, 0.18],
  organicDarkening: 0.20,
  ironOxideRedness: 0.40,           // lateritic reddening at lower latitudes
  calciumPale: 0.10,
  // Erosion
  usleKFactor: 0.42,
  windErodibility: 0.55             // high wind erosion in the dry season
});

// ─── Vegetation ─────────────────────────────────────────────────
// Savanna is grass-dominated with scattered fire- and drought-adapted trees.
const VEGETATION = Object.freeze({
  treeTypeWeights: Object.freeze({
    [TREE_TYPE.ACACIA]: 0.45,
    [TREE_TYPE.BAOBAB]: 0.25,
    [TREE_TYPE.PALM]: 0.15,
    [TREE_TYPE.PINE]: 0.05,       // marginal, higher-elevation patches
    [TREE_TYPE.OAK]: 0.10         // riparian corridors only
  }),
  grassTypeWeights: Object.freeze({
    [GRASS_TYPE.SAVANNA_BUNCH]: 0.55,
    [GRASS_TYPE.TALL_PRAIRIE]: 0.25,
    [GRASS_TYPE.SHORT_PRAIRIE]: 0.15,
    [GRASS_TYPE.THISTLE]: 0.05
  }),
  verticalLayers: 2,                // grass layer + scattered tree layer
  emergentDensity: 0.00,
  canopyDensity: 0.15,              // very open canopy — scattered trees only
  understoryDensity: 0.10,
  groundCoverDensity: 0.85,         // grass dominates the ground layer
  epiphyteDensity: 0.05,
  lianaDensity: 0.00,
  successionTarget: SUCCESSION.CLIMAX,
  fireRegimeYears: 3,               // fire every 1–5 years is characteristic
  rootDepthM: 1.5,                  // deep roots to survive dry season
  canopyRadiusM: 4.0,
  trunkHeightM: 6.0,
  leafLitterDepthM: 0.02,
  bloomWindowDays: 60,
  // Poisson-disc targets per hectare
  treeDensityPerHa: 40,             // sparse tree cover
  shrubDensityPerHa: 200,
  groundCoverDensityPerHa: 50000    // very dense grass
});

// ─── Fauna ──────────────────────────────────────────────────────
const FAUNA = Object.freeze({
  densityWeight: 0.60,              // high biomass of large grazers
  habitatLayers: Object.freeze({
    ground: 0.70,                   // grazers and predators dominate
    understory: 0.10,
    canopy: 0.15,                   // arboreal species in scattered trees
    aerial: 0.05
  }),
  dielActivity: 0.40,               // crepuscular bias due to heat
  migrationCorridorWeight: 0.85,    // strongest migration corridor weight
  predatorPreyBalance: 0.50,
  nectarAvailability: 0.15,
  pollenAvailability: 0.20,
  // Characteristic guild weights
  largeHerbivoreWeight: 0.45,       // wildebeest, zebra, antelope, elephant
  largePredatorWeight: 0.20,        // lion, cheetah, hyena
  smallMammalWeight: 0.15,
  birdWeight: 0.15,
  insectWeight: 0.05
});

// ─── Materials ──────────────────────────────────────────────────
// Full PBR + anime parameters for the savanna's characteristic surfaces.
const MATERIALS = Object.freeze({
  // ─── C4 grass (dry and green variants) ──────────────────────
  savannaGrass: Object.freeze({
    albedo: [0.32, 0.30, 0.12],     // dry-season straw yellow-green
    roughness: 0.85,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.10,
    emissive: 0.0,
    wetnessResponse: 0.40,
    animeFlatness: 0.25,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.95,            // extremely flammable in the dry season
    hardness: 0.25,
    brittleness: 0.75
  }),
  // ─── Acacia / baobab bark ───────────────────────────────────
  savannaBark: Object.freeze({
    albedo: [0.20, 0.14, 0.08],
    roughness: 0.90,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.15,
    animeFlatness: 0.35,
    acousticProfile: ACOUSTIC_PROFILE.WOOD,
    flammability: 0.60,            // thick bark is fire-resistant
    hardness: 0.80,
    brittleness: 0.30
  }),
  // ─── Acacia / baobab canopy ─────────────────────────────────
  savannaCanopy: Object.freeze({
    albedo: [0.10, 0.16, 0.06],     // sparse, small-leaved canopy
    roughness: 0.75,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.30,
    animeFlatness: 0.20,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.65,
    hardness: 0.35,
    brittleness: 0.55
  }),
  // ─── Lateritic / sandy soil ─────────────────────────────────
  lateriteSoil: Object.freeze({
    albedo: [0.42, 0.26, 0.12],     // iron-rich red-brown
    roughness: 0.95,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.30,
    animeFlatness: 0.50,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.05,
    hardness: 0.25,
    brittleness: 0.65
  }),
  // ─── Exposed bedrock / inselberg ───────────────────────────
  savannaRock: Object.freeze({
    albedo: [0.30, 0.26, 0.20],
    roughness: 0.88,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.12,
    animeFlatness: 0.40,
    acousticProfile: ACOUSTIC_PROFILE.ROCK,
    flammability: 0.0,
    hardness: 0.92,
    brittleness: 0.25
  }),
  // ─── Dry riverbed sand ──────────────────────────────────────
  dryRiverbed: Object.freeze({
    albedo: [0.55, 0.45, 0.30],
    roughness: 0.92,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.20,
    animeFlatness: 0.45,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.0,
    hardness: 0.15,
    brittleness: 0.75
  })
});

// ─── Lighting ───────────────────────────────────────────────────
const LIGHTING = Object.freeze({
  canopyOcclusion: 0.10,            // very open — minimal canopy shading
  sunDiffuseFraction: 0.30,         // direct sun dominates
  sunIntensityScale: 1.25,          // high-angle tropical sun
  colourCast: [1.00, 0.98, 0.90],   // warm golden cast
  atmosphericScatterBoost: 0.85,
  bioluminescentEmission: 0.00,
  dappledLightFrequency: 0.10,
  dappledLightAmplitude: 0.15,
  shadowSoftnessNear: 0.3,
  shadowSoftnessMid: 0.5,
  shadowSoftnessFar: 0.8,
  shadowCascadeScale: 0.9,
  snowAlbedoBoost: 0.0,
  dustHazeDensity: 0.015,           // dry-season dust haze
  skyTint: [0.95, 0.90, 0.75]      // pale blue to golden horizon
});

// ─── Water ──────────────────────────────────────────────────────
const WATER = Object.freeze({
  surfaceWaterPresence: 0.10,       // water is scarce in the dry season
  riverineNetworkDensity: 0.15,
  canopyDrip: 0.05,
  groundwaterTableDepthM: 5.0,
  freshwaterSpringPresence: 0.10,
  waterTableDepthM: 5.0,
  bogCoverage: 0.0,
  lakeCoverage: 0.05,
  riverWidthMeanM: 4.0,
  waterTemperatureC: 22.0,
  iceCoverMonths: 0,
  shorelineMaterial: 'dryRiverbed',
  seasonalWaterPresence: 0.40       // wet-season ponds and floodplains
});

// ─── Sensory ────────────────────────────────────────────────────
const SENSORY = Object.freeze({
  // Acoustic signature (0..1 weights across 8 channels)
  acoustic: Object.freeze({
    biological: 0.25,               // insects, birds, distant grazers
    geological: 0.05,
    water: 0.05,                    // dry-season water is scarce
    wind: 0.30,                     // wind through tall grass
    vegetation: 0.30,               // rustling grass dominates
    mechanical: 0.00
  }),
  // Olfactory signature
  olfactory: Object.freeze({
    floral: 0.15,
    earthy: 0.25,
    aquatic: 0.05,
    woodland: 0.10,
    smoke: 0.30,                    // seasonal fire smoke is defining
    animal: 0.10,
    decay: 0.05,
    sulfur: 0.00,
    sea: 0.00,
    clean: 0.05
  }),
  // Tactile profile
  tactile: Object.freeze({
    temperatureC: 28.0,
    humidity: 0.30,
    windPressurePa: 4.0,
    precipitationType: 'rain',
    groundHardness: 0.55           // dry, hard ground with grass cushion
  })
});

// ─── Seasonality ────────────────────────────────────────────────
// The savanna's phenology is driven by a pronounced dry/wet cycle. Grass
// greens up rapidly at the onset of rains and cures to straw during the dry
// season; trees leaf out and flower in the wet season and may shed leaves in
// the dry season.
const SEASONALITY = Object.freeze({
  phenologyOverrides: Object.freeze({
    budBreakDayOffset: 0,
    fullGreenDurationDays: 120,
    autumnColourShiftDays: 30,      // dry-season curing
    leafDropDurationDays: 20,
    bloomWindowDays: 60,
    sporeBoostWetSeason: 0.50,
    fungalBoostWetSeason: 0.40
  }),
  seasonalMaterialPalettes: Object.freeze({
    [SEASONAL_MATERIAL.SPRING_NEW_LEAF]: Object.freeze({
      savannaGrass: { albedo: [0.20, 0.35, 0.08], roughness: 0.80 },
      lateriteSoil: { albedo: [0.38, 0.24, 0.12], wetnessResponse: 0.50 }
    }),
    [SEASONAL_MATERIAL.SUMMER_FULL_GREEN]: Object.freeze({
      savannaGrass: { albedo: [0.18, 0.30, 0.06], roughness: 0.82 },
      savannaCanopy: { albedo: [0.10, 0.18, 0.06], roughness: 0.75 }
    }),
    [SEASONAL_MATERIAL.AUTUMN_PEAK]: Object.freeze({
      savannaGrass: { albedo: [0.32, 0.30, 0.12], roughness: 0.85 },
      lateriteSoil: { albedo: [0.42, 0.26, 0.12], wetnessResponse: 0.30 }
    }),
    [SEASONAL_MATERIAL.WINTER_BARE_BRANCH]: Object.freeze({
      savannaGrass: { albedo: [0.38, 0.32, 0.15], roughness: 0.88 },
      savannaCanopy: { albedo: [0.15, 0.14, 0.08], roughness: 0.80 },
      lateriteSoil: { albedo: [0.45, 0.28, 0.14], wetnessResponse: 0.20 }
    })
  }),
  snowAccumulationRateMmHr: 0.0,
  snowMeltRateMmHr: 0.0,
  snowAlbedoSeasonal: 0.0
});

// ─── Procedural ─────────────────────────────────────────────────
const PROCEDURAL = Object.freeze({
  macroCanopyNoiseScale: 60.0,      // scattered tree clusters
  midUnderstoryNoiseScale: 20.0,
  microLitterNoiseScale: 5.0,
  terrainNoiseScale: 250.0,
  fireScarNoiseScale: 40.0,         // burn-pattern variation
  // Poisson-disc density targets (per hectare) — mirrored from VEGETATION
  treeDensityPerHa: VEGETATION.treeDensityPerHa,
  shrubDensityPerHa: VEGETATION.shrubDensityPerHa,
  groundCoverDensityPerHa: VEGETATION.groundCoverDensityPerHa,
  // LOD scale thresholds (world units)
  lodHighDistance: 800.0,           // wide-open views need longer high LOD
  lodMidDistance: 3000.0,
  lodLowDistance: 15000.0,
  // Procedural event budgets
  maxFireEventsPerTick: 3,          // savanna fires are frequent
  maxErosionEventsPerTick: 1,
  maxGrowthEventsPerTick: 4
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING ────────────────────────────────────────
// Fuses temperature, humidity, elevation, slope, soil texture, and water-table
// depth into a single 0–1 weight. 328_BiomeBlendField uses this to decide how
// much of the savanna biome applies at any world point.
// ══════════════════════════════════════════════════════════════════
const _scratchVec3 = new Vec3();
const _scratchNoise = new SimplexNoise();

/**
 * Compute the savanna suitability at a world position and environmental state.
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
  // ─── Temperature: savanna is warm year-round, with dry-season heat ──
  const tempScore = smoothstep(5.0, 20.0, env.temperatureC) * (1.0 - smoothstep(35.0, 45.0, env.temperatureC));

  // ─── Humidity: intermediate; too dry becomes desert, too wet becomes forest ─
  const humidityScore = smoothstep(0.15, 0.40, env.humidity) * (1.0 - smoothstep(0.70, 0.90, env.humidity));

  // ─── Elevation: lowland to plateau; high mountains are excluded ──────
  const elevScore = smoothstep(100.0, 400.0, env.elevationM) * (1.0 - smoothstep(1200.0, 2000.0, env.elevationM));

  // ─── Slope: flat to gently rolling; steep slopes become woodland or rock ─
  const slopeScore = smoothstep(0.0, 3.0, env.slopeDeg) * (1.0 - smoothstep(8.0, 20.0, env.slopeDeg));

  // ─── Soil texture: sandy loam is ideal; heavy clay or pure sand is poor ─
  const textureScore =
    0.50 * smoothstep(0.35, 0.65, env.soilSand) +
    0.30 * smoothstep(0.15, 0.35, env.soilSilt) +
    0.20 * (1.0 - smoothstep(0.10, 0.30, env.soilClay));

  // ─── Water table: deep enough for dry-season stress, shallow enough for grass ─
  const waterScore = smoothstep(2.0, 5.0, env.waterTableDepthM) * (1.0 - smoothstep(8.0, 15.0, env.waterTableDepthM));

  // ─── Patchiness: break up the suitability field with low-frequency noise ─
  const patchiness = env.noise !== undefined ? (0.80 + 0.20 * env.noise) : 1.0;

  // ─── Weighted fusion ────────────────────────────────────────────────
  const raw =
    0.25 * tempScore +
    0.20 * humidityScore +
    0.12 * elevScore +
    0.10 * slopeScore +
    0.20 * textureScore +
    0.13 * waterScore;

  return Math.max(0.0, Math.min(1.0, raw * patchiness));
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR EXPORT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const GrasslandSavannaBiome = Object.freeze({
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

export default GrasslandSavannaBiome;