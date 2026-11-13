// file number : 326_Z02
// full path name : src/context/326_Z02_MediterraneanChaparralBiome.js
// description : Mediterranean / chaparral / scrubland biome descriptor — the
// second of five additional biome presets. This preset covers the five mild,
// wet-winter / hot, dry-summer climate zones: the Mediterranean Basin,
// California chaparral, central Chile, the Cape of South Africa, and
// southwestern Australia. These regions share a unique climate signature —
// cool, wet winters and warm, dry summers moderated by cold ocean currents —
// that drives sclerophyll shrub dominance, fire-adapted regeneration, and
// drought-deciduous phenology. Provides the same eleven interlocking descriptor
// blocks as the base nine biomes, with full PBR + anime parameters for dry
// scrub, aromatic herbs, oak woodland, exposed limestone, and charred post-fire
// ground. The descriptor allocates nothing after construction and is consumed
// by the biome registry, blend field, material bridge, climate/soil/hydrology
// couplings, fauna migration system, chunk descriptor, and the full material/
// lighting/sensory pipeline. Key calibration points: coolest-month temperature
// -3 °C to 18 °C, summer temperatures above 22 °C, annual precipitation
// 65–75 cm concentrated in winter, soil pH 6.1–6.7 with coarse, rocky,
// shallow profiles, and a fire return interval of roughly 70–125 years with
// high-intensity crown fires.
//#
// best for : Every consumer that needs a Mediterranean, chaparral, maquis,
// matorral, fynbos, or kwongan biome preset — biome registry barrel (327),
// biome blend field (328), biome blend system (329), cross-biome ecotone (330),
// biome material bridge (331), biome climate coupling (332), biome soil
// coupling (333), biome hydrology coupling (334), biome fauna migration (335),
// landscape chunk descriptor (336), and the whole material/lighting/sensory
// pipeline. Together with the other extended biome files this completes the
// planet-scale living-biome palette, and the Mediterranean preset is the one
// that must remain seamless from the dry-summer scrub through the oak woodland
// into the fire-denuded post-burn landscape.
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
import { CliffsGradientProvider, CLIFF_CLASS } from './282_Z02_CliffsGradientProvider.js';
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
const BIOME_ID = 11;
const BIOME_NAME = 'mediterranean_chaparral';
const BIOME_DISPLAY_NAME = 'Mediterranean / Chaparral';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── MEDITERRANEAN CHARACTERISTIC PARAMETERS ────────────────────
// ══════════════════════════════════════════════════════════════════
// ─── Climate ────────────────────────────────────────────────────
// The defining signature: wet winter, dry summer. Coolest-month temperatures
// range from −3 °C to 18 °C; summer means exceed 22 °C; annual precipitation
// is 65–75 cm concentrated in the winter half-year; summer rain is <40 mm.
const CLIMATE = Object.freeze({
  // Temperature (°C)
  temperatureMin: -5.0,             // rare winter frost at inland margins
  temperatureMax: 42.0,             // summer heat spikes
  temperatureMean: 16.0,
  temperatureDailySwing: 14.0,      // strong diurnal swing in summer
  temperatureFrostFree: false,       // frost possible in winter
  // Humidity (0..1) — dry summer air, humid winter
  humidityMin: 0.20,
  humidityMax: 0.85,
  humidityMean: 0.55,
  // Precipitation (mm/hr mean)
  precipitationMean: 1.0,
  precipitationMax: 20.0,
  precipitationStormProb: 0.10,
  precipitationAnnualMm: 700.0,     // 65–75 cm
  // Seasons — the wet/dry signal is the defining cycle
  seasonalityAmplitude: 0.75,
  drySeasonLengthDays: 120,         // summer drought
  wetSeasonPeakDay: 30,             // winter rains
  snowSeasonDays: 5,                // rare, only at elevation
  growingSeasonDays: 200,
  // Wind — moderate, with dry-season gusts
  windMeanSpeed: 3.0,
  windMaxSpeed: 25.0,
  windPredominantDirDeg: 270,      // westerly maritime influence
  // Weather state probabilities (0..1)
  weatherProbClear: 0.45,
  weatherProbCloudy: 0.25,
  weatherProbRain: 0.20,
  weatherProbStorm: 0.05,
  weatherProbSnow: 0.00,
  weatherProbFog: 0.05,
  // Atmospheric
  pressureMeanKPa: 101.3,
  pressureSwingKPa: 2.0
});

// ─── Terrain Bias ────────────────────────────────────────────────
// Chaparral occupies hilly to mountainous terrain with shallow, rocky soils.
// Slopes are often steep, and exposed bedrock is common.
const TERRAIN = Object.freeze({
  elevationBand: ELEVATION_BAND.LOWLAND_TO_HIGHLAND,
  elevationMinM: 0.0,
  elevationMaxM: 1500.0,
  slopeMeanDeg: 15.0,
  slopeMaxDeg: 45.0,
  roughness: 0.70,                  // rugged, rocky
  valleyDepth: 0.40,
  valleyDensity: 0.45,
  plateauBias: 0.30,
  groundwaterTableDepthM: 8.0,      // deep, except in riparian corridors
  permafrostDepthM: Infinity,
  terrainRoughnessHint: 0.75,
  biomeHint: BIOME_HINT.SCRUBLAND
});

// ─── Soil ──────────────────────────────────────────────────────
// Chaparral soils are typically shallow, coarse-textured, rocky, and
// well-drained, with pH ranging from 6.1 to 6.7 (slightly acidic to neutral)
// and low organic matter. They are derived from a variety of parent materials
// including limestone, schist, and volcanic rock.
const SOIL = Object.freeze({
  textureClass: SOIL_TEXTURE_CLASS.GRAVELLY_LOAM,
  visualArchetype: SOIL_VISUAL_ARCHETYPE.SANDY_TAN,
  // Primary fractions (0..1) — coarse, rocky
  sand: 0.45,
  silt: 0.25,
  clay: 0.10,
  organicMatter: 0.05,
  gravel: 0.15,
  rockFragment: 0.05,
  // Chemistry
  pH: 6.4,                          // 6.1–6.7
  fertilityClass: FERTILITY_CLASS.POOR,
  fertilityIndex: 0.30,
  // Physics
  porosity: 0.40,
  bulkDensityGcm3: 1.45,
  waterHoldingCapacity: 0.12,
  hydraulicConductivityMmHr: 15.0,
  cohesionKPa: 3.0,
  plasticityIndex: 6.0,
  // Colour (linear RGB)
  baseAlbedo: [0.38, 0.30, 0.22],
  organicDarkening: 0.20,
  ironOxideRedness: 0.35,           // terra rossa on limestone
  calciumPale: 0.15,
  // Erosion
  usleKFactor: 0.35,
  windErodibility: 0.40,
  // ─── Fire-related soil effects ─────────────────────────────
  // Post-fire water repellency (hydrophobicity) is a defining soil trait.
  fireWaterRepellency: 0.60,
  postFireErosionBoost: 0.50
});

// ─── Vegetation ─────────────────────────────────────────────────
// Chaparral vegetation is dominated by evergreen sclerophyll shrubs with
// small, hard, waxy leaves adapted to summer drought. Fire is the primary
// disturbance regime; many species are obligate resprouters or seeders.
const VEGETATION = Object.freeze({
  treeTypeWeights: Object.freeze({
    [TREE_TYPE.OAK]: 0.50,        // scrub oak, holm oak, cork oak
    [TREE_TYPE.PINE]: 0.30,       // Aleppo pine, Monterey pine
    [TREE_TYPE.OAK]: 0.20         // additional oak species
  }),
  grassTypeWeights: Object.freeze({
    [GRASS_TYPE.TALL_PRAIRIE]: 0.40, // bunch grasses
    [GRASS_TYPE.THISTLE]: 0.30,     // thistles and spiny herbs
    [GRASS_TYPE.SHORT_PRAIRIE]: 0.20,
    [GRASS_TYPE.FERN]: 0.10         // bracken in moist pockets
  }),
  verticalLayers: 3,                // overstorey shrubs, mid-shrubs, herb layer
  emergentDensity: 0.05,
  canopyDensity: 0.60,              // dense, impenetrable shrub cover
  understoryDensity: 0.30,
  groundCoverDensity: 0.20,         // sparse herb layer, seasonal
  epiphyteDensity: 0.05,
  lianaDensity: 0.00,
  successionTarget: SUCCESSION.CLIMAX,
  fireRegimeYears: 70,              // 70–125 year return interval
  fireIntensity: 'high',            // crown fires are typical
  rootDepthM: 3.0,                  // deep taproots for drought survival
  canopyRadiusM: 2.0,
  trunkHeightM: 3.0,
  leafLitterDepthM: 0.05,
  bloomWindowDays: 90,              // spring bloom before summer drought
  // Poisson-disc targets per hectare
  treeDensityPerHa: 200,
  shrubDensityPerHa: 3000,
  groundCoverDensityPerHa: 8000,
  // ─── Fire-adaptive traits ──────────────────────────────────
  // Fraction of species that resprout after fire
  resprouterFraction: 0.60,
  // Fraction of species that recruit from seed after fire
  seederFraction: 0.40,
  // Heat-shock germination threshold (°C)
  heatShockGerminationC: 80.0
});

// ─── Fauna ──────────────────────────────────────────────────────
// Chaparral fauna is diverse but often secretive. Characteristic guilds
// include reptiles (lizards, snakes), birds (wrentit, California quail,
// towhees), and mammals (mule deer, gray fox, woodrats).
const FAUNA = Object.freeze({
  densityWeight: 0.40,
  habitatLayers: Object.freeze({
    ground: 0.35,                   // reptiles, small mammals
    understory: 0.40,               // dense shrub cover for nesting and shelter
    canopy: 0.15,
    aerial: 0.10                    // raptors
  }),
  dielActivity: 0.35,               // crepuscular and nocturnal due to summer heat
  migrationCorridorWeight: 0.30,    // altitudinal migration is limited
  predatorPreyBalance: 0.40,
  nectarAvailability: 0.15,
  pollenAvailability: 0.15,
  // Characteristic guild weights
  reptileWeight: 0.30,
  birdWeight: 0.25,
  smallMammalWeight: 0.25,
  largeMammalWeight: 0.15,
  amphibianWeight: 0.05
});

// ─── Materials ──────────────────────────────────────────────────
// Full PBR + anime parameters for the Mediterranean/chaparral surfaces:
// dry sclerophyll scrub, aromatic herbs, oak bark, limestone, and charred
// post-fire ground. Limestone is a defining substrate: grey to yellow,
// moderately rough, non-metallic, with dissolution pits and karst weathering.
const MATERIALS = Object.freeze({
  // ─── Dry sclerophyll shrub ──────────────────────────────────
  dryScrub: Object.freeze({
    albedo: [0.18, 0.20, 0.10],     // olive-green to grey-green
    roughness: 0.85,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.30,
    animeFlatness: 0.30,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.90,             // extremely flammable in summer
    hardness: 0.35,
    brittleness: 0.60
  }),
  // ─── Aromatic herb (thyme, rosemary, sage) ──────────────────
  aromaticHerb: Object.freeze({
    albedo: [0.22, 0.28, 0.15],
    roughness: 0.80,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.40,
    animeFlatness: 0.25,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.85,             // volatile oils increase flammability
    hardness: 0.15,
    brittleness: 0.75
  }),
  // ─── Oak bark ───────────────────────────────────────────────
  oakBark: Object.freeze({
    albedo: [0.15, 0.12, 0.08],
    roughness: 0.92,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.15,
    animeFlatness: 0.40,
    acousticProfile: ACOUSTIC_PROFILE.WOOD,
    flammability: 0.50,             // thick bark is fire-resistant
    hardness: 0.85,
    brittleness: 0.25
  }),
  // ─── Limestone bedrock ──────────────────────────────────────
  limestone: Object.freeze({
    albedo: [0.45, 0.42, 0.38],     // grey-yellow
    roughness: 0.75,                 // moderately coarse
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.10,
    animeFlatness: 0.45,
    acousticProfile: ACOUSTIC_PROFILE.ROCK,
    flammability: 0.0,
    hardness: 0.80,
    brittleness: 0.40,
    // ─── Karst weathering parameters ──────────────────────────
    dissolutionRateMmPerYear: 0.05,
    karstPitDensity: 0.30
  }),
  // ─── Charred post-fire ground ───────────────────────────────
  charredGround: Object.freeze({
    albedo: [0.05, 0.04, 0.03],     // near-black
    roughness: 0.95,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.80,           // fire-induced water repellency
    animeFlatness: 0.50,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.0,
    hardness: 0.10,
    brittleness: 0.90
  }),
  // ─── Seasonal dry grass ────────────────────────────────────
  dryGrass: Object.freeze({
    albedo: [0.42, 0.35, 0.18],     // straw-yellow
    roughness: 0.88,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.25,
    animeFlatness: 0.25,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.95,
    hardness: 0.10,
    brittleness: 0.85
  })
});

// ─── Lighting ───────────────────────────────────────────────────
// Mediterranean lighting is characterized by intense, direct summer sun,
// a dry atmosphere with little haze, and high contrast between lit and
// shadowed surfaces. Winter light is softer and more diffuse.
const LIGHTING = Object.freeze({
  canopyOcclusion: 0.30,            // moderate from dense shrub cover
  sunDiffuseFraction: 0.25,         // direct sun dominates
  sunIntensityScale: 1.30,          // intense summer irradiance
  colourCast: [1.00, 0.97, 0.88],   // warm golden
  atmosphericScatterBoost: 0.75,    // dry, clear air
  bioluminescentEmission: 0.00,
  dappledLightFrequency: 0.15,
  dappledLightAmplitude: 0.20,
  shadowSoftnessNear: 0.3,
  shadowSoftnessMid: 0.5,
  shadowSoftnessFar: 0.7,
  shadowCascadeScale: 1.0,
  snowAlbedoBoost: 0.0,
  fogDensityBase: 0.005,            // very clear
  skyTint: [0.85, 0.90, 0.98],      // deep blue sky
  // ─── Summer heat shimmer / mirage term ────────────────────
  heatShimmerIntensity: 0.20,
  heatShimmerThresholdC: 30.0
});

// ─── Water ──────────────────────────────────────────────────────
// Water is scarce in summer; chaparral is a dry biome. Streams are seasonal
// and often intermittent; groundwater is deep.
const WATER = Object.freeze({
  surfaceWaterPresence: 0.05,       // ephemeral streams, rare springs
  riverineNetworkDensity: 0.10,
  canopyDrip: 0.05,
  groundwaterTableDepthM: 8.0,
  freshwaterSpringPresence: 0.05,
  waterTableDepthM: 8.0,
  bogCoverage: 0.00,
  lakeCoverage: 0.00,
  riverWidthMeanM: 1.5,
  waterTemperatureC: 18.0,
  iceCoverMonths: 0,
  shorelineMaterial: 'limestone',
  // ─── Seasonal flow ─────────────────────────────────────────
  // Streams flow in winter and dry in summer.
  seasonalFlowMonths: 4,
  intermittentFlow: true
});

// ─── Sensory ────────────────────────────────────────────────────
const SENSORY = Object.freeze({
  // Acoustic signature (0..1 weights across 8 channels)
  acoustic: Object.freeze({
    biological: 0.30,               // birds, insects, reptiles
    geological: 0.10,               // rockfall, soil creep
    water: 0.05,                    // rare streams
    wind: 0.35,                     // wind through dry scrub
    vegetation: 0.20,               // rustling leaves
    mechanical: 0.00
  }),
  // Olfactory signature
  olfactory: Object.freeze({
    floral: 0.20,                   // aromatic herbs
    earthy: 0.25,
    aquatic: 0.00,
    woodland: 0.10,
    smoke: 0.15,                    // wildfire smoke is characteristic
    animal: 0.05,
    decay: 0.05,
    sulfur: 0.00,
    sea: 0.05,                      // coastal influence
    clean: 0.15
  }),
  // Tactile profile
  tactile: Object.freeze({
    temperatureC: 25.0,
    humidity: 0.40,
    windPressurePa: 4.0,
    precipitationType: 'rain',
    groundHardness: 0.65
  })
});

// ─── Seasonality ────────────────────────────────────────────────
// Mediterranean phenology is defined by the wet-winter / dry-summer cycle:
// growth and flowering occur in spring, drought-deciduous species shed leaves
// in summer, and autumn rains trigger a second growth pulse.
const SEASONALITY = Object.freeze({
  phenologyOverrides: Object.freeze({
    budBreakDayOffset: 0,
    fullGreenDurationDays: 120,
    autumnColourShiftDays: 30,
    leafDropDurationDays: 20,
    bloomWindowDays: 90,
    sporeBoostWetSeason: 0.20,
    fungalBoostWetSeason: 0.15
  }),
  seasonalMaterialPalettes: Object.freeze({
    [SEASONAL_MATERIAL.SPRING_NEW_LEAF]: Object.freeze({
      dryScrub: { albedo: [0.16, 0.22, 0.10], roughness: 0.82 },
      aromaticHerb: { albedo: [0.20, 0.30, 0.14], roughness: 0.78 }
    }),
    [SEASONAL_MATERIAL.SUMMER_FULL_GREEN]: Object.freeze({
      dryScrub: { albedo: [0.18, 0.20, 0.10], roughness: 0.85 },
      dryGrass: { albedo: [0.42, 0.35, 0.18], roughness: 0.88 }
    }),
    [SEASONAL_MATERIAL.AUTUMN_PEAK]: Object.freeze({
      dryScrub: { albedo: [0.22, 0.20, 0.12], roughness: 0.84 },
      oakBark: { albedo: [0.17, 0.13, 0.09], wetnessResponse: 0.30 }
    }),
    [SEASONAL_MATERIAL.WINTER_BARE_BRANCH]: Object.freeze({
      dryScrub: { albedo: [0.20, 0.18, 0.12], roughness: 0.86 },
      limestone: { albedo: [0.48, 0.45, 0.40], wetnessResponse: 0.25 }
    })
  }),
  snowAccumulationRateMmHr: 0.0,
  snowMeltRateMmHr: 0.0,
  snowAlbedoSeasonal: 0.0
});

// ─── Procedural ─────────────────────────────────────────────────
const PROCEDURAL = Object.freeze({
  // Noise scales (world units) for shrub mosaic and rock outcrops
  macroScrubNoiseScale: 150.0,      // large shrub patches
  midScrubNoiseScale: 30.0,         // individual shrub clumps
  microScrubNoiseScale: 5.0,        // leaf and soil detail
  limestoneNoiseScale: 50.0,        // karst pit distribution
  // Poisson-disc density targets (per hectare) — mirrored from VEGETATION
  treeDensityPerHa: VEGETATION.treeDensityPerHa,
  shrubDensityPerHa: VEGETATION.shrubDensityPerHa,
  groundCoverDensityPerHa: VEGETATION.groundCoverDensityPerHa,
  // LOD scale thresholds (world units)
  lodHighDistance: 800.0,
  lodMidDistance: 4000.0,
  lodLowDistance: 20000.0,
  // Procedural event budgets
  maxFireEventsPerTick: 3,          // fire is a defining event
  maxErosionEventsPerTick: 2,       // post-fire erosion pulses
  maxGrowthEventsPerTick: 3,
  // ─── Fire spread parameters ────────────────────────────────
  // Rate of spread (m/min) in dry shrub fuel under moderate wind.
  fireSpreadRateMPerMin: 15.0,
  // Firebrand spotting distance (m)
  spottingDistanceM: 200.0
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING ────────────────────────────────────────
// Mediterranean suitability is driven by the winter-wet / summer-dry
// precipitation pattern, mild winter temperatures, and coarse, rocky soils.
// 328_BiomeBlendField uses this to decide how much of the Mediterranean biome
// applies at any world point.
// ══════════════════════════════════════════════════════════════════
const _scratchVec3 = new Vec3();
const _scratchNoise = new SimplexNoise();

/**
 * Compute the Mediterranean/chaparral suitability at a world position and
 * environmental state. All inputs are expected to come from the context frame
 * or from provider summaries. The function allocates nothing after module
 * initialisation.
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
  // ─── Temperature: mild winters, hot summers ────────────────────────
  const tempScore = smoothstep(-5.0, 10.0, env.temperatureC) * (1.0 - smoothstep(35.0, 45.0, env.temperatureC));

  // ─── Humidity: dry summer air is defining ──────────────────────────
  const humidityScore = smoothstep(0.20, 0.45, env.humidity) * (1.0 - smoothstep(0.75, 0.90, env.humidity));

  // ─── Elevation: lowland to mid-elevation; high mountains are excluded ─
  const elevScore = smoothstep(0.0, 200.0, env.elevationM) * (1.0 - smoothstep(1200.0, 2000.0, env.elevationM));

  // ─── Slope: hilly to steep terrain is characteristic ───────────────
  const slopeScore = smoothstep(5.0, 15.0, env.slopeDeg) * (1.0 - smoothstep(40.0, 55.0, env.slopeDeg));

  // ─── Soil texture: coarse, rocky, well-drained ────────────────────
  const textureScore =
    0.45 * smoothstep(0.35, 0.60, env.soilSand) +
    0.30 * smoothstep(0.15, 0.35, env.soilSilt) +
    0.25 * (1.0 - smoothstep(0.10, 0.25, env.soilClay));

  // ─── Water table: deep, except in riparian corridors ──────────────
  const waterScore = smoothstep(3.0, 8.0, env.waterTableDepthM) * (1.0 - smoothstep(15.0, 30.0, env.waterTableDepthM));

  // ─── Patchiness: shrub mosaic breaks the suitability field ────────
  const patchiness = env.noise !== undefined ? (0.85 + 0.15 * env.noise) : 1.0;

  // ─── Weighted fusion ────────────────────────────────────────────────
  const raw =
    0.25 * tempScore +
    0.20 * humidityScore +
    0.12 * elevScore +
    0.15 * slopeScore +
    0.18 * textureScore +
    0.10 * waterScore;

  return Math.max(0.0, Math.min(1.0, raw * patchiness));
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR EXPORT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const MediterraneanChaparralBiome = Object.freeze({
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

export default MediterraneanChaparralBiome;