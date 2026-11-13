// file number : 326_Z04
// full path name : src/context/326_Z04_SavannaWoodlandBiome.js
// description : Savanna woodland biome descriptor — the fourth of five
// additional biome presets. This preset covers the more heavily wooded end of
// the tropical grassland spectrum, including the Miombo woodlands of south-
// central Africa, the Cerrado woodland of Brazil, and the eucalypt open
// woodlands of northern Australia. The defining difference from the open
// savanna in 321 is a closed or semi-closed tree canopy (typically 25–60 %
// cover) that nevertheless remains light enough to support a continuous C4
// grass understorey[reference:0]. Annual rainfall is higher than open savanna
// (roughly 650–1,200 mm), and the dry season is shorter and less severe.
// Fire is still a primary disturbance agent, but its regime is less frequent
// and lower-intensity than in open savanna, and tree density is strongly
// regulated by fire frequency, grazing, and soil fertility[reference:1].
// Provides the same eleven interlocking descriptor blocks as the base nine
// biomes, with full PBR + anime parameters for miombo canopy, cerrado bark,
// eucalypt leaves, grass understorey, and lateritic soil. The descriptor
// allocates nothing after construction and is consumed by the biome registry,
// blend field, material bridge, climate/soil/hydrology couplings, fauna
// migration system, chunk descriptor, and the full material/lighting/sensory
// pipeline.
//#
// best for : Every consumer that needs a savanna woodland, miombo, cerrado
// woodland, or eucalypt open woodland biome preset — biome registry barrel
// (327), biome blend field (328), biome blend system (329), cross-biome
// ecotone (330), biome material bridge (331), biome climate coupling (332),
// biome soil coupling (333), biome hydrology coupling (334), biome fauna
// migration (335), landscape chunk descriptor (336), and the whole material/
// lighting/sensory pipeline. Together with the other extended biome files this
// completes the planet-scale living-biome palette, and the savanna woodland
// preset is the one that must remain seamless from the open savanna of 321
// through the woodland transition into dry forest.
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
const BIOME_ID = 13;
const BIOME_NAME = 'savanna_woodland';
const BIOME_DISPLAY_NAME = 'Savanna / Woodland';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── SAVANNA WOODLAND CHARACTERISTIC PARAMETERS ─────────────────
// ══════════════════════════════════════════════════════════════════
// ─── Climate ────────────────────────────────────────────────────
// Higher rainfall and a shorter dry season than open savanna. Tree canopy can
// close above ~650 mm of mean annual rainfall, and above ~1,000 mm either
// savanna woodland or a forest/grassland mosaic may prevail[reference:2].
const CLIMATE = Object.freeze({
  // Temperature (°C) — warm year-round, tropical
  temperatureMin: 5.0,
  temperatureMax: 38.0,
  temperatureMean: 23.0,
  temperatureDailySwing: 14.0,
  temperatureFrostFree: true,
  // Humidity (0..1) — higher than open savanna due to greater canopy cover
  humidityMin: 0.25,
  humidityMax: 0.90,
  humidityMean: 0.55,
  // Precipitation (mm/hr mean)
  precipitationMean: 2.2,
  precipitationMax: 30.0,
  precipitationStormProb: 0.20,
  precipitationAnnualMm: 900.0,     // 650–1,200 mm
  // Seasons — distinct but shorter dry season than open savanna
  seasonalityAmplitude: 0.60,
  drySeasonLengthDays: 100,
  wetSeasonPeakDay: 180,
  snowSeasonDays: 0,
  growingSeasonDays: 220,
  // Wind — moderate, reduced by canopy
  windMeanSpeed: 2.5,
  windMaxSpeed: 20.0,
  windPredominantDirDeg: 90,
  // Weather state probabilities (0..1)
  weatherProbClear: 0.35,
  weatherProbCloudy: 0.30,
  weatherProbRain: 0.20,
  weatherProbStorm: 0.10,
  weatherProbSnow: 0.00,
  weatherProbFog: 0.05,
  // Atmospheric
  pressureMeanKPa: 101.3,
  pressureSwingKPa: 2.0
});

// ─── Terrain Bias ────────────────────────────────────────────────
// Savanna woodland occupies gently undulating plains and plateau margins.
// Local relief is low to moderate.
const TERRAIN = Object.freeze({
  elevationBand: ELEVATION_BAND.LOWLAND_TO_PLATEAU,
  elevationMinM: 200.0,
  elevationMaxM: 1500.0,
  slopeMeanDeg: 3.0,
  slopeMaxDeg: 20.0,
  roughness: 0.40,
  valleyDepth: 0.25,
  valleyDensity: 0.35,
  plateauBias: 0.60,
  groundwaterTableDepthM: 8.0,
  permafrostDepthM: Infinity,
  terrainRoughnessHint: 0.35,
  biomeHint: BIOME_HINT.WOODLAND
});

// ─── Soil ──────────────────────────────────────────────────────
// Savanna woodland soils range from eutrophic (nutrient-rich) on arid margins
// to dystrophic (nutrient-poor, highly weathered) in humid zones[reference:3].
// This preset models the intermediate, moderately fertile end.
const SOIL = Object.freeze({
  textureClass: SOIL_TEXTURE_CLASS.SANDY_CLAY_LOAM,
  visualArchetype: SOIL_VISUAL_ARCHETYPE.RED_LATERITE,
  // Primary fractions (0..1)
  sand: 0.40,
  silt: 0.25,
  clay: 0.25,
  organicMatter: 0.05,
  gravel: 0.05,
  rockFragment: 0.00,
  // Chemistry
  pH: 6.0,                          // slightly acidic
  fertilityClass: FERTILITY_CLASS.MODERATE,
  fertilityIndex: 0.50,
  // Physics
  porosity: 0.45,
  bulkDensityGcm3: 1.30,
  waterHoldingCapacity: 0.25,
  hydraulicConductivityMmHr: 8.0,
  cohesionKPa: 8.0,
  plasticityIndex: 14.0,
  // Colour (linear RGB) — red-brown lateritic
  baseAlbedo: [0.30, 0.18, 0.10],
  organicDarkening: 0.30,
  ironOxideRedness: 0.60,
  calciumPale: 0.05,
  // Erosion
  usleKFactor: 0.35,
  windErodibility: 0.30
});

// ─── Vegetation ─────────────────────────────────────────────────
// Savanna woodland is defined by a light but semi-continuous tree canopy
// (25–60 % cover) over a grass understorey. Miombo woodland tree densities
// vary widely with fire and grazing, from ~177 to ~800 stems per hectare
// depending on disturbance regime[reference:4].
const VEGETATION = Object.freeze({
  treeTypeWeights: Object.freeze({
    [TREE_TYPE.ACACIA]: 0.30,
    [TREE_TYPE.BAOBAB]: 0.15,
    [TREE_TYPE.OAK]: 0.20,        // substitute for miombo Brachystegia
    [TREE_TYPE.PINE]: 0.15,       // substitute for eucalypt
    [TREE_TYPE.PALM]: 0.10,
    [TREE_TYPE.BIRCH]: 0.10       // substitute for other deciduous species
  }),
  grassTypeWeights: Object.freeze({
    [GRASS_TYPE.SAVANNA_BUNCH]: 0.45,
    [GRASS_TYPE.TALL_PRAIRIE]: 0.25,
    [GRASS_TYPE.SHORT_PRAIRIE]: 0.20,
    [GRASS_TYPE.THISTLE]: 0.10
  }),
  verticalLayers: 2,                // tree layer + grass layer
  emergentDensity: 0.00,
  canopyDensity: 0.45,              // 25–60 % cover
  understoryDensity: 0.20,
  groundCoverDensity: 0.75,         // continuous grass understorey
  epiphyteDensity: 0.10,
  lianaDensity: 0.05,
  successionTarget: SUCCESSION.CLIMAX,
  fireRegimeYears: 6,               // 4–10 years, less frequent than open savanna
  rootDepthM: 2.0,
  canopyRadiusM: 3.5,
  trunkHeightM: 8.0,
  leafLitterDepthM: 0.05,
  bloomWindowDays: 90,
  // Poisson-disc targets per hectare — calibrated from miombo literature
  treeDensityPerHa: 400,            // range 177–800 stems/ha
  shrubDensityPerHa: 300,
  groundCoverDensityPerHa: 40000
});

// ─── Fauna ──────────────────────────────────────────────────────
// Savanna woodland supports a mix of open-country and woodland species:
// browsers and grazers, woodland birds, and arboreal primates in some regions.
const FAUNA = Object.freeze({
  densityWeight: 0.55,
  habitatLayers: Object.freeze({
    ground: 0.35,
    understory: 0.25,
    canopy: 0.30,                   // higher canopy use than open savanna
    aerial: 0.10
  }),
  dielActivity: 0.40,
  migrationCorridorWeight: 0.60,
  predatorPreyBalance: 0.50,
  nectarAvailability: 0.15,
  pollenAvailability: 0.15,
  // Characteristic guild weights
  largeHerbivoreWeight: 0.30,
  largePredatorWeight: 0.15,
  smallMammalWeight: 0.20,
  birdWeight: 0.25,
  insectWeight: 0.10
});

// ─── Materials ──────────────────────────────────────────────────
// Full PBR + anime parameters for savanna woodland surfaces: miombo canopy,
// cerrado bark, eucalypt leaves, grass understorey, and lateritic soil.
const MATERIALS = Object.freeze({
  // ─── Miombo / Brachystegia canopy ───────────────────────────
  miomboCanopy: Object.freeze({
    albedo: [0.12, 0.18, 0.08],     // mid-green, slightly grey
    roughness: 0.78,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.40,
    animeFlatness: 0.22,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.70,
    hardness: 0.30,
    brittleness: 0.60
  }),
  // ─── Cerrado / eucalypt bark ────────────────────────────────
  woodlandBark: Object.freeze({
    albedo: [0.20, 0.16, 0.12],
    roughness: 0.88,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.25,
    animeFlatness: 0.35,
    acousticProfile: ACOUSTIC_PROFILE.WOOD,
    flammability: 0.55,             // fire-resistant thick bark
    hardness: 0.75,
    brittleness: 0.30
  }),
  // ─── Grass understorey ─────────────────────────────────────
  woodlandGrass: Object.freeze({
    albedo: [0.28, 0.30, 0.12],
    roughness: 0.82,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.40,
    animeFlatness: 0.25,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.90,
    hardness: 0.15,
    brittleness: 0.80
  }),
  // ─── Lateritic soil ─────────────────────────────────────────
  laterite: Object.freeze({
    albedo: [0.32, 0.20, 0.10],
    roughness: 0.92,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.35,
    animeFlatness: 0.48,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.05,
    hardness: 0.25,
    brittleness: 0.65
  }),
  // ─── Exposed rock / inselberg ──────────────────────────────
  woodlandRock: Object.freeze({
    albedo: [0.28, 0.24, 0.20],
    roughness: 0.86,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.15,
    animeFlatness: 0.45,
    acousticProfile: ACOUSTIC_PROFILE.ROCK,
    flammability: 0.0,
    hardness: 0.90,
    brittleness: 0.25
  })
});

// ─── Lighting ───────────────────────────────────────────────────
// Savanna woodland lighting sits between open savanna and dry forest: the
// light canopy creates moderate shade while still allowing substantial
// sky exposure.
const LIGHTING = Object.freeze({
  canopyOcclusion: 0.45,            // moderate shade from semi-closed canopy
  sunDiffuseFraction: 0.40,
  sunIntensityScale: 1.15,
  colourCast: [0.98, 0.96, 0.88],   // warm tropical light
  atmosphericScatterBoost: 0.90,
  bioluminescentEmission: 0.02,
  dappledLightFrequency: 0.25,
  dappledLightAmplitude: 0.30,
  shadowSoftnessNear: 0.4,
  shadowSoftnessMid: 0.6,
  shadowSoftnessFar: 0.8,
  shadowCascadeScale: 0.95,
  snowAlbedoBoost: 0.0,
  fogDensityBase: 0.010,
  skyTint: [0.88, 0.92, 0.95],
  // ─── Canopy gap fraction ───────────────────────────────────
  // Fraction of sky visible through the canopy (complement of cover).
  canopyGapFraction: 0.55
});

// ─── Water ──────────────────────────────────────────────────────
// Savanna woodland has more reliable water than open savanna: seasonal
// streams, dambos (seasonally waterlogged grasslands), and shallow wells.
const WATER = Object.freeze({
  surfaceWaterPresence: 0.15,
  riverineNetworkDensity: 0.20,
  canopyDrip: 0.10,
  groundwaterTableDepthM: 8.0,
  freshwaterSpringPresence: 0.10,
  waterTableDepthM: 8.0,
  bogCoverage: 0.05,                // dambos
  lakeCoverage: 0.02,
  riverWidthMeanM: 4.0,
  waterTemperatureC: 22.0,
  iceCoverMonths: 0,
  shorelineMaterial: 'laterite',
  seasonalWaterPresence: 0.30
});

// ─── Sensory ────────────────────────────────────────────────────
const SENSORY = Object.freeze({
  // Acoustic signature (0..1 weights across 8 channels)
  acoustic: Object.freeze({
    biological: 0.30,               // birds, insects, arboreal fauna
    geological: 0.05,
    water: 0.10,
    wind: 0.25,                     // wind through canopy and grass
    vegetation: 0.25,
    mechanical: 0.05
  }),
  // Olfactory signature
  olfactory: Object.freeze({
    floral: 0.15,
    earthy: 0.25,
    aquatic: 0.05,
    woodland: 0.20,                 // leaf litter and bark
    smoke: 0.20,                    // seasonal fire smoke
    animal: 0.05,
    decay: 0.05,
    sulfur: 0.00,
    sea: 0.00,
    clean: 0.05
  }),
  // Tactile profile
  tactile: Object.freeze({
    temperatureC: 24.0,
    humidity: 0.55,
    windPressurePa: 3.0,
    precipitationType: 'rain',
    groundHardness: 0.50
  })
});

// ─── Seasonality ────────────────────────────────────────────────
// Phenology follows the wet/dry cycle: leaf flush at the onset of rains,
// flowering in the dry season for many species, and grass curing late in
// the dry season when fire risk peaks.
const SEASONALITY = Object.freeze({
  phenologyOverrides: Object.freeze({
    budBreakDayOffset: 0,
    fullGreenDurationDays: 150,
    autumnColourShiftDays: 25,
    leafDropDurationDays: 15,
    bloomWindowDays: 80,
    sporeBoostWetSeason: 0.35,
    fungalBoostWetSeason: 0.25
  }),
  seasonalMaterialPalettes: Object.freeze({
    [SEASONAL_MATERIAL.SPRING_NEW_LEAF]: Object.freeze({
      miomboCanopy: { albedo: [0.14, 0.24, 0.10], roughness: 0.76 },
      laterite: { albedo: [0.30, 0.20, 0.10], wetnessResponse: 0.50 }
    }),
    [SEASONAL_MATERIAL.SUMMER_FULL_GREEN]: Object.freeze({
      miomboCanopy: { albedo: [0.12, 0.18, 0.08], roughness: 0.78 },
      woodlandGrass: { albedo: [0.22, 0.28, 0.10], roughness: 0.80 }
    }),
    [SEASONAL_MATERIAL.AUTUMN_PEAK]: Object.freeze({
      miomboCanopy: { albedo: [0.20, 0.18, 0.10], roughness: 0.80 },
      woodlandGrass: { albedo: [0.32, 0.30, 0.12], roughness: 0.84 }
    }),
    [SEASONAL_MATERIAL.WINTER_BARE_BRANCH]: Object.freeze({
      miomboCanopy: { albedo: [0.18, 0.16, 0.12], roughness: 0.82 },
      woodlandBark: { albedo: [0.22, 0.18, 0.14], wetnessResponse: 0.15 },
      woodlandGrass: { albedo: [0.38, 0.32, 0.15], roughness: 0.86 }
    })
  }),
  snowAccumulationRateMmHr: 0.0,
  snowMeltRateMmHr: 0.0,
  snowAlbedoSeasonal: 0.0
});

// ─── Procedural ─────────────────────────────────────────────────
const PROCEDURAL = Object.freeze({
  // Noise scales (world units) for canopy and understorey mosaic
  macroCanopyNoiseScale: 150.0,     // woodland–savanna transition bands
  midCanopyNoiseScale: 40.0,        // individual tree clumps and gaps
  microCanopyNoiseScale: 8.0,       // leaf and grass detail
  soilPatternNoiseScale: 25.0,      // laterite exposure patterns
  // Poisson-disc density targets (per hectare) — mirrored from VEGETATION
  treeDensityPerHa: VEGETATION.treeDensityPerHa,
  shrubDensityPerHa: VEGETATION.shrubDensityPerHa,
  groundCoverDensityPerHa: VEGETATION.groundCoverDensityPerHa,
  // LOD scale thresholds (world units)
  lodHighDistance: 1000.0,
  lodMidDistance: 5000.0,
  lodLowDistance: 25000.0,
  // Procedural event budgets
  maxFireEventsPerTick: 2,
  maxErosionEventsPerTick: 1,
  maxGrowthEventsPerTick: 3,
  // ─── Fire spread parameters ────────────────────────────────
  fireSpreadRateMPerMin: 8.0       // slower than open savanna due to canopy
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING ────────────────────────────────────────
// Savanna woodland suitability is driven by rainfall (higher than open
// savanna, lower than dry forest), a moderate dry season, warm temperatures,
// and soils that are neither purely eutrophic nor purely dystrophic. 328_
// BiomeBlendField uses this to decide how much of the savanna woodland biome
// applies at any world point.
// ══════════════════════════════════════════════════════════════════
const _scratchVec3 = new Vec3();
const _scratchNoise = new SimplexNoise();

/**
 * Compute the savanna woodland suitability at a world position and
 * environmental state. All inputs are expected to come from the context
 * frame or from provider summaries. The function allocates nothing after
 * module initialisation.
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
  // ─── Temperature: warm year-round, tropical to subtropical ─────────
  const tempScore = smoothstep(5.0, 18.0, env.temperatureC) * (1.0 - smoothstep(35.0, 42.0, env.temperatureC));

  // ─── Humidity: sub-humid to humid; the key discriminator from open savanna ─
  const humidityScore = smoothstep(0.35, 0.55, env.humidity) * (1.0 - smoothstep(0.80, 0.95, env.humidity));

  // ─── Elevation: lowland to plateau margin ──────────────────────────
  const elevScore = smoothstep(100.0, 400.0, env.elevationM) * (1.0 - smoothstep(1200.0, 2000.0, env.elevationM));

  // ─── Slope: gentle undulation; steep slopes become woodland or rock ─
  const slopeScore = smoothstep(0.0, 2.0, env.slopeDeg) * (1.0 - smoothstep(15.0, 30.0, env.slopeDeg));

  // ─── Soil texture: sandy clay loam is ideal; pure sand or heavy clay is poor ─
  const textureScore =
    0.40 * smoothstep(0.30, 0.50, env.soilSand) +
    0.35 * smoothstep(0.15, 0.35, env.soilSilt) +
    0.25 * smoothstep(0.15, 0.30, env.soilClay);

  // ─── Water table: moderate depth; shallow supports dambos ──────────
  const waterScore = smoothstep(3.0, 8.0, env.waterTableDepthM) * (1.0 - smoothstep(15.0, 30.0, env.waterTableDepthM));

  // ─── Patchiness: fire and grazing create a mosaic ──────────────────
  const patchiness = env.noise !== undefined ? (0.85 + 0.15 * env.noise) : 1.0;

  // ─── Weighted fusion ────────────────────────────────────────────────
  const raw =
    0.22 * tempScore +
    0.25 * humidityScore +
    0.12 * elevScore +
    0.10 * slopeScore +
    0.18 * textureScore +
    0.13 * waterScore;

  return Math.max(0.0, Math.min(1.0, raw * patchiness));
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR EXPORT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const SavannaWoodlandBiome = Object.freeze({
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

export default SavannaWoodlandBiome;