// file number : 326_Z09
// full path name : src/context/326_Z09_SubtropicalHumidForestBiome.js
// description : Subtropical humid forest biome descriptor — the fourth of four
// additional forest biome presets. This preset covers the warm, humid broadleaf
// evergreen forests of southeastern North America (the southeastern mixed
// forest), eastern and southern China (the lower and mid-subtropical
// evergreen broadleaf forests), southern Japan (the Ryukyu and Kyushu
// evergreen broadleaf forests), and disjunct southern-hemisphere occurrences
// in southeastern Brazil, northeastern Argentina, and eastern Australia.
// The defining drivers are hot humid summers, mild winters, high rainfall
// distributed year-round (typically 1,300–3,000 mm, with subtropical
// Argentina receiving 1,600–2,000 mm and the Araucaria moist forests
// receiving 1,300–3,000 mm), mean annual temperatures of 15–23 °C
// [reference:0], deeply weathered acidic ultisol soils (pH typically below
// 5, base saturation often under 25 %) [reference:2], and a
// multi-layered evergreen–deciduous mixed canopy with high leaf area index
// and high primary productivity [reference:3][reference:4]. Upper-canopy
// dominance is typically shared among Fagaceae and Theaceae, with
// Castanopsis, Schima, and Lithocarpus as characteristic genera
// [reference:5][reference:6][reference:7]; understorey richness is high, with
// dozens of woody species per site . Provides the same eleven
// interlocking descriptor blocks as the base biomes, with full PBR + anime
// parameters for evergreen broadleaf canopy, mixed deciduous associates,
// bamboo, palm, fern, vine, epiphyte, ultisol soil, and the distinctive
// warm-humid, hazy, green-filtered light of the understorey. The descriptor
// allocates nothing after construction and is consumed by the biome registry,
// blend field, material bridge, climate/soil/hydrology couplings, fauna
// migration system, chunk descriptor, and the full material/lighting/sensory
// pipeline.
//#
// best for : Every consumer that needs a subtropical humid forest, evergreen
// broadleaf forest, laurel forest, or warm-temperate rainforest biome preset —
// biome registry barrel (327), biome blend field (328), biome blend system
// (329), cross-biome ecotone (330), biome material bridge (331), biome climate
// coupling (332), biome soil coupling (333), biome hydrology coupling (334),
// biome fauna migration (335), landscape chunk descriptor (336), and the whole
// material/lighting/sensory pipeline. Together with the other forest biome
// files this completes the planet-scale living-biome palette, and the
// subtropical humid forest preset is the one that must remain seamless from
// the temperate deciduous forest of 326_Z07 and the temperate rainforest of
// 326_Z08 through the warm-temperate transition into the tropical forest
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
const BIOME_ID = 18;
const BIOME_NAME = 'subtropical_humid_forest';
const BIOME_DISPLAY_NAME = 'Subtropical Humid Forest';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── SUBTROPICAL HUMID FOREST CHARACTERISTIC PARAMETERS ─────────
// ══════════════════════════════════════════════════════════════════
// ─── Climate ────────────────────────────────────────────────────
// Warm, humid, and without a true dry season. Mean annual temperature is
// 15–23 °C [reference:9]; summer means are 16–18 °C at the cool margin and
// over 25 °C in the warm core; winter means are around 10 °C at the cool
// margin and frost is rare or absent [reference:10]. Annual precipitation is
// typically 1,300–3,000 mm [reference:11], with 1,600–2,000 mm in the
// Argentine subtropics . Relative humidity is persistently high
// and the sky is frequently hazy.
const CLIMATE = Object.freeze({
  // Temperature (°C) — warm, humid, mild winter
  temperatureMin: -3.0,             // rare inland frost at the cool margin
  temperatureMax: 38.0,             // hot, humid summer
  temperatureMean: 18.0,            // 15–23 °C across the biome [reference:13]
  temperatureDailySwing: 9.0,       // moderated by humidity and cloud
  temperatureFrostFree: false,       // rare frost at the poleward margin
  // Humidity (0..1) — persistently high
  humidityMin: 0.55,
  humidityMax: 0.95,
  humidityMean: 0.75,
  // Precipitation (mm/hr mean) — 1,300–3,000 mm annually [reference:14]
  precipitationMean: 2.5,
  precipitationMax: 45.0,
  precipitationStormProb: 0.20,     // convective summer storms and typhoons
  precipitationAnnualMm: 1800.0,    // mid-range of the 1,300–3,000 mm band
  // Seasons — no true dry season; summer is the wettest season
  seasonalityAmplitude: 0.50,
  drySeasonLengthDays: 0,           // humid year-round
  wetSeasonPeakDay: 180,            // summer monsoon / convective peak
  snowSeasonDays: 0,                // snow is rare or absent
  growingSeasonDays: 300,           // long, warm growing season
  // Wind — moderate, but typhoon / cyclone exposed at the coastal margin
  windMeanSpeed: 2.8,
  windMaxSpeed: 45.0,               // typhoon gusts
  windPredominantDirDeg: 135,      // summer monsoon from the southeast
  // Weather state probabilities (0..1)
  weatherProbClear: 0.25,
  weatherProbCloudy: 0.35,
  weatherProbRain: 0.25,
  weatherProbStorm: 0.10,
  weatherProbSnow: 0.00,
  weatherProbFog: 0.05,
  // Atmospheric
  pressureMeanKPa: 101.2,
  pressureSwingKPa: 2.5
});

// ─── Terrain Bias ────────────────────────────────────────────────
// Subtropical humid forest occupies lowland to low-montane terrain: coastal
// plains, foothills, and dissected plateaus with moderate relief.
const TERRAIN = Object.freeze({
  elevationBand: ELEVATION_BAND.LOWLAND_TO_HIGHLAND,
  elevationMinM: 0.0,
  elevationMaxM: 1500.0,
  slopeMeanDeg: 8.0,
  slopeMaxDeg: 35.0,
  roughness: 0.55,
  valleyDepth: 0.40,
  valleyDensity: 0.50,
  plateauBias: 0.45,
  groundwaterTableDepthM: 4.0,
  permafrostDepthM: Infinity,
  terrainRoughnessHint: 0.50,
  biomeHint: BIOME_HINT.SUBTROPICAL_FOREST
});

// ─── Soil ──────────────────────────────────────────────────────
// Ultisols are the dominant soil order: deeply weathered, acidic, clay-rich,
// and naturally low in fertility. They typically have a pH below 5
// , low base saturation (often <25 %) [reference:16], and high
// secondary iron and aluminium oxide content that gives them their red or
// yellow colour [reference:17]. Organic-matter-rich variants (humults) can be
// relatively fertile .
const SOIL = Object.freeze({
  textureClass: SOIL_TEXTURE_CLASS.CLAY_LOAM,
  visualArchetype: SOIL_VISUAL_ARCHETYPE.RED_LATERITE,
  // Primary fractions (0..1) — clay-rich, deeply weathered
  sand: 0.25,
  silt: 0.25,
  clay: 0.45,                       // high clay content from intense weathering
  organicMatter: 0.05,
  gravel: 0.00,
  rockFragment: 0.00,
  // Chemistry
  pH: 4.6,                          // typically < 5 
  fertilityClass: FERTILITY_CLASS.POOR,
  fertilityIndex: 0.30,
  // Physics
  porosity: 0.45,
  bulkDensityGcm3: 1.30,
  waterHoldingCapacity: 0.30,
  hydraulicConductivityMmHr: 3.0,
  cohesionKPa: 12.0,
  plasticityIndex: 25.0,
  // Colour (linear RGB) — red-yellow lateritic
  baseAlbedo: [0.30, 0.16, 0.08],
  organicDarkening: 0.30,
  ironOxideRedness: 0.65,           // strongly reddened by iron oxides
  calciumPale: 0.05,
  // Erosion
  usleKFactor: 0.30,
  windErodibility: 0.15,
  // ─── Ultisol-specific parameters ──────────────────────────
  baseSaturationPercent: 20.0,       // often <25 % [reference:20]
  cationExchangeCapacityCmolPerKg: 10.0,
  secondaryOxideContent: 0.35,       // Fe and Al oxides
  weatheringIntensity: 0.85,         // deeply weathered
  drainageClass: 'well'
});

// ─── Vegetation ─────────────────────────────────────────────────
// Subtropical humid forest is a multi-layered evergreen broadleaf forest,
// often with a mixed evergreen–deciduous component [reference:21]. Upper-canopy
// dominance is typically shared among Fagaceae and Theaceae, with
// Castanopsis, Schima, and Lithocarpus as characteristic genera
// [reference:22][reference:23][reference:24]. Species richness is high: a
// single Okinawan site recorded 54 upper-storey species and 63 understorey
// species . The vertical profile commonly has three tree layers,
// a shrub layer, and a herb layer [reference:26]. Leaf area index is high and
// the canopy contributes over 80 % of total leaf litterfall and biomass
// [reference:27].
const VEGETATION = Object.freeze({
  treeTypeWeights: Object.freeze({
    [TREE_TYPE.OAK]: 0.30,        // Castanopsis / Lithocarpus (Fagaceae)
    [TREE_TYPE.MAPLE]: 0.15,      // deciduous associate (Acer)
    [TREE_TYPE.BEECH]: 0.15,      // Fagus / Castanopsis associates
    [TREE_TYPE.CAMELLIA]: 0.20,   // Schima / Camellia (Theaceae)
    [TREE_TYPE.LAUREL]: 0.10,     // Lauraceae (Machilus, Cinnamomum)
    [TREE_TYPE.PINE]: 0.10        // Pinus at disturbed margins
  }),
  grassTypeWeights: Object.freeze({
    [GRASS_TYPE.FERN]: 0.35,       // understorey ferns
    [GRASS_TYPE.BAMBOO]: 0.25,     // dwarf bamboo understorey
    [GRASS_TYPE.MEADOW_GRASS]: 0.20,
    [GRASS_TYPE.SHORT_PRAIRIE]: 0.10,
    [GRASS_TYPE.TALL_PRAIRIE]: 0.10
  }),
  verticalLayers: 5,                // upper, middle, lower tree + shrub + herb [reference:28]
  emergentDensity: 0.00,
  canopyDensity: 0.85,              // closed canopy [reference:29]
  understoryDensity: 0.55,          // rich shrub and small-tree layer
  groundCoverDensity: 0.50,         // fern and herb layer
  epiphyteDensity: 0.25,            // epiphytes on bark
  lianaDensity: 0.15,               // woody vines
  successionTarget: SUCCESSION.CLIMAX,
  fireRegimeYears: 400,             // fire is rare in humid evergreen forest
  rootDepthM: 2.0,
  canopyRadiusM: 5.0,
  trunkHeightM: 25.0,
  leafLitterDepthM: 0.08,
  bloomWindowDays: 90,
  // Poisson-disc targets per hectare
  treeDensityPerHa: 400,
  shrubDensityPerHa: 2000,
  groundCoverDensityPerHa: 30000,
  // ─── Structural and functional parameters ─────────────────
  leafAreaIndex: 5.5,               // high LAI [reference:30]
  canopyLitterContribution: 0.80,   // >80 % of litterfall [reference:31]
  evergreenFraction: 0.70,          // mixed evergreen–deciduous [reference:32]
  deciduousFraction: 0.30,
  bambooUnderstoreyFraction: 0.25
});

// ─── Fauna ──────────────────────────────────────────────────────
// Subtropical humid forest fauna is rich and includes many endemic species.
// Characteristic guilds include arboreal mammals, frugivorous and
// insectivorous birds, reptiles, amphibians, and a diverse invertebrate
// community. Seasonal migration is moderate.
const FAUNA = Object.freeze({
  densityWeight: 0.65,
  habitatLayers: Object.freeze({
    ground: 0.25,                   // ground-dwelling mammals, reptiles, amphibians
    understory: 0.30,               // dense shrub and bamboo layer
    canopy: 0.35,                   // arboreal mammals and birds
    aerial: 0.10
  }),
  dielActivity: 0.40,               // mixed, with many crepuscular species
  migrationCorridorWeight: 0.45,    // moderate seasonal migration
  predatorPreyBalance: 0.50,
  nectarAvailability: 0.20,
  pollenAvailability: 0.20,
  // Characteristic guild weights
  smallMammalWeight: 0.25,          // rodents, tree shrews
  birdWeight: 0.30,                 // frugivores, insectivores
  reptileWeight: 0.15,
  amphibianWeight: 0.15,
  largeMammalWeight: 0.10,          // deer, wild boar
  insectWeight: 0.05
});

// ─── Materials ──────────────────────────────────────────────────
// Full PBR + anime parameters for subtropical humid forest surfaces:
// evergreen broadleaf canopy, mixed deciduous associates, bamboo, palm, fern,
// vine, epiphyte, ultisol soil, and the distinctive warm-humid, hazy,
// green-filtered light of the understorey.
const MATERIALS = Object.freeze({
  // ─── Evergreen broadleaf canopy ─────────────────────────────
  evergreenBroadleaf: Object.freeze({
    albedo: [0.08, 0.16, 0.05],     // deep, slightly blue-green
    roughness: 0.70,                 // leaves are waxy and somewhat glossy
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.08,
    emissive: 0.0,
    wetnessResponse: 0.50,
    animeFlatness: 0.18,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.50,
    hardness: 0.25,
    brittleness: 0.70
  }),
  // ─── Mixed deciduous associate ──────────────────────────────
  deciduousAssociate: Object.freeze({
    albedo: [0.12, 0.20, 0.07],     // lighter green
    roughness: 0.75,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.45,
    animeFlatness: 0.20,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.55,
    hardness: 0.22,
    brittleness: 0.72
  }),
  // ─── Evergreen bark ────────────────────────────────────────
  evergreenBark: Object.freeze({
    albedo: [0.16, 0.12, 0.08],
    roughness: 0.88,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.35,
    animeFlatness: 0.35,
    acousticProfile: ACOUSTIC_PROFILE.WOOD,
    flammability: 0.55,
    hardness: 0.78,
    brittleness: 0.30
  }),
  // ─── Bamboo understorey ────────────────────────────────────
  bamboo: Object.freeze({
    albedo: [0.14, 0.22, 0.06],     // bright, slightly yellow-green
    roughness: 0.72,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.40,
    animeFlatness: 0.22,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.60,             // dry bamboo is flammable
    hardness: 0.35,
    brittleness: 0.55
  }),
  // ─── Fern understorey ──────────────────────────────────────
  fern: Object.freeze({
    albedo: [0.07, 0.15, 0.05],     // deep green
    roughness: 0.78,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.55,
    animeFlatness: 0.20,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.40,
    hardness: 0.12,
    brittleness: 0.85
  }),
  // ─── Ultisol soil ──────────────────────────────────────────
  ultisol: Object.freeze({
    albedo: [0.30, 0.16, 0.08],     // red-yellow lateritic
    roughness: 0.90,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.60,
    animeFlatness: 0.45,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.05,
    hardness: 0.30,
    brittleness: 0.65
  }),
  // ─── Epiphyte mat ──────────────────────────────────────────
  epiphyteMat: Object.freeze({
    albedo: [0.10, 0.16, 0.06],     // moss and fern mix
    roughness: 0.82,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.08,
    emissive: 0.0,
    wetnessResponse: 0.75,
    animeFlatness: 0.20,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.30,
    hardness: 0.10,
    brittleness: 0.88
  })
});

// ─── Lighting ───────────────────────────────────────────────────
// Subtropical humid forest lighting is warm, humid, and hazy. The closed
// multi-layered canopy creates deep shade on the forest floor, while the
// high humidity and frequent cloud produce strong atmospheric scattering
// and a warm, slightly green-shifted colour cast.
const LIGHTING = Object.freeze({
  canopyOcclusion: 0.80,            // closed, multi-layered canopy
  sunDiffuseFraction: 0.55,         // humid haze increases diffuse
  sunIntensityScale: 1.10,          // warm subtropical sun
  colourCast: [0.98, 0.95, 0.88],   // warm, slightly yellow-green
  atmosphericScatterBoost: 1.25,    // humid haze
  bioluminescentEmission: 0.03,     // fireflies in some regions
  dappledLightFrequency: 0.35,      // dappled light through canopy
  dappledLightAmplitude: 0.30,
  shadowSoftnessNear: 0.5,
  shadowSoftnessMid: 0.7,
  shadowSoftnessFar: 0.85,
  shadowCascadeScale: 0.9,
  snowAlbedoBoost: 0.0,
  fogDensityBase: 0.018,            // humid haze
  skyTint: [0.85, 0.90, 0.92],
  // ─── Canopy gap fraction ──────────────────────────────────
  canopyGapFraction: 0.18,
  // ─── Understorey light attenuation ─────────────────────────
  // Only a few percent of incident light reaches the forest floor.
  understoreyLightFraction: 0.04,
  // ─── Warm-humid haze parameters ───────────────────────────
  hazeOpticalDepth: 0.25,
  hazeColor: [1.00, 0.96, 0.88]
});

// ─── Water ──────────────────────────────────────────────────────
// Water is abundant year-round: high rainfall, frequent cloud, and high
// humidity. Streams, seeps, and small ponds are common.
const WATER = Object.freeze({
  surfaceWaterPresence: 0.20,
  riverineNetworkDensity: 0.35,
  canopyDrip: 0.35,
  groundwaterTableDepthM: 4.0,
  freshwaterSpringPresence: 0.15,
  waterTableDepthM: 4.0,
  bogCoverage: 0.05,
  lakeCoverage: 0.05,
  riverWidthMeanM: 5.0,
  waterTemperatureC: 18.0,
  iceCoverMonths: 0,
  shorelineMaterial: 'ultisol'
});

// ─── Sensory ────────────────────────────────────────────────────
const SENSORY = Object.freeze({
  acoustic: Object.freeze({
    biological: 0.40,               // rich bird and insect chorus
    geological: 0.00,
    water: 0.20,                    // streams and drip
    wind: 0.15,                     // muted by canopy
    vegetation: 0.25,               // leaf and bamboo rustle
    mechanical: 0.00
  }),
  olfactory: Object.freeze({
    floral: 0.20,
    earthy: 0.25,
    aquatic: 0.10,
    woodland: 0.20,                 // leaf litter and bark
    smoke: 0.00,
    animal: 0.05,
    decay: 0.10,
    sulfur: 0.00,
    sea: 0.05,                      // coastal variants
    clean: 0.05
  }),
  tactile: Object.freeze({
    temperatureC: 20.0,
    humidity: 0.75,
    windPressurePa: 2.0,
    precipitationType: 'rain',
    groundHardness: 0.45
  })
});

// ─── Seasonality ────────────────────────────────────────────────
// Subtropical humid forest is largely evergreen; the seasonal signal is
// moderate and driven by temperature and the summer wet-season peak rather
// than by a pronounced dormant season. Some deciduous associates lose
// leaves briefly in the cool season.
const SEASONALITY = Object.freeze({
  phenologyOverrides: Object.freeze({
    budBreakDayOffset: 0,
    fullGreenDurationDays: 250,
    autumnColourShiftDays: 20,
    leafDropDurationDays: 15,
    bloomWindowDays: 90,
    sporeBoostWetSeason: 0.35,
    fungalBoostWetSeason: 0.30
  }),
  seasonalMaterialPalettes: Object.freeze({
    [SEASONAL_MATERIAL.SPRING_NEW_LEAF]: Object.freeze({
      evergreenBroadleaf: { albedo: [0.10, 0.20, 0.06], roughness: 0.68 },
      deciduousAssociate: { albedo: [0.14, 0.24, 0.08], roughness: 0.73 }
    }),
    [SEASONAL_MATERIAL.SUMMER_FULL_GREEN]: Object.freeze({
      evergreenBroadleaf: { albedo: [0.08, 0.16, 0.05], roughness: 0.70 },
      bamboo: { albedo: [0.14, 0.22, 0.06], roughness: 0.72 }
    }),
    [SEASONAL_MATERIAL.AUTUMN_PEAK]: Object.freeze({
      evergreenBroadleaf: { albedo: [0.10, 0.14, 0.05], roughness: 0.72 },
      deciduousAssociate: { albedo: [0.35, 0.22, 0.06], roughness: 0.78 }
    }),
    [SEASONAL_MATERIAL.WINTER_BARE_BRANCH]: Object.freeze({
      evergreenBroadleaf: { albedo: [0.10, 0.14, 0.06], roughness: 0.75 },
      evergreenBark: { albedo: [0.18, 0.14, 0.10], roughness: 0.88 },
      ultisol: { albedo: [0.32, 0.18, 0.10], wetnessResponse: 0.40 }
    })
  }),
  snowAccumulationRateMmHr: 0.0,
  snowMeltRateMmHr: 0.0,
  snowAlbedoSeasonal: 0.0
});

// ─── Procedural ─────────────────────────────────────────────────
const PROCEDURAL = Object.freeze({
  macroCanopyNoiseScale: 130.0,
  midUnderstoryNoiseScale: 32.0,
  microLitterNoiseScale: 6.0,
  terrainNoiseScale: 200.0,
  bambooPatternNoiseScale: 25.0,
  treeDensityPerHa: VEGETATION.treeDensityPerHa,
  shrubDensityPerHa: VEGETATION.shrubDensityPerHa,
  groundCoverDensityPerHa: VEGETATION.groundCoverDensityPerHa,
  lodHighDistance: 700.0,
  lodMidDistance: 3000.0,
  lodLowDistance: 15000.0,
  maxFireEventsPerTick: 0,          // fire is rare in humid evergreen forest
  maxErosionEventsPerTick: 2,       // high rainfall and clay-rich soils
  maxGrowthEventsPerTick: 4
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING ────────────────────────────────────────
// Subtropical humid forest suitability is driven by warm mean annual
// temperature (15–23 °C) [reference:33], high and reliable precipitation
// (1,300–3,000 mm) [reference:34], high humidity, clay-rich acidic ultisol
// soils [reference:36], and low-to-mid elevation. 328_BiomeBlendField
// uses this to decide how much of the subtropical humid forest biome applies
// at any world point.
// ══════════════════════════════════════════════════════════════════
const _scratchVec3 = new Vec3();
const _scratchNoise = new SimplexNoise();

function getSuitability(env) {
  // ─── Temperature: warm, mild winter, hot humid summer ─────────────
  const tempScore = smoothstep(10.0, 18.0, env.temperatureC) * (1.0 - smoothstep(30.0, 40.0, env.temperatureC));

  // ─── Humidity: persistently high ──────────────────────────────────
  const humidityScore = smoothstep(0.60, 0.80, env.humidity);

  // ─── Elevation: lowland to low-montane ──────────────────────────
  const elevScore = smoothstep(0.0, 200.0, env.elevationM) * (1.0 - smoothstep(1000.0, 1600.0, env.elevationM));

  // ─── Slope: gentle to moderate ──────────────────────────────────
  const slopeScore = smoothstep(0.0, 5.0, env.slopeDeg) * (1.0 - smoothstep(25.0, 40.0, env.slopeDeg));

  // ─── Soil texture: clay loam (ultisol) is typical ────────────────
  const textureScore =
    0.50 * smoothstep(0.30, 0.50, env.soilClay) +
    0.30 * smoothstep(0.15, 0.35, env.soilSilt) +
    0.20 * smoothstep(0.10, 0.30, env.soilSand);

  // ─── Water table: moderate depth ──────────────────────────────────
  const waterScore = smoothstep(2.0, 5.0, env.waterTableDepthM) * (1.0 - smoothstep(12.0, 20.0, env.waterTableDepthM));

  // ─── Patchiness ────────────────────────────────────────────────────
  const patchiness = env.noise !== undefined ? (0.85 + 0.15 * env.noise) : 1.0;

  // ─── Weighted fusion ────────────────────────────────────────────────
  // Temperature and humidity dominate: the biome is defined by warm, wet conditions.
  const raw =
    0.28 * tempScore +
    0.25 * humidityScore +
    0.12 * elevScore +
    0.10 * slopeScore +
    0.15 * textureScore +
    0.10 * waterScore;

  return Math.max(0.0, Math.min(1.0, raw * patchiness));
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR EXPORT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const SubtropicalHumidForestBiome = Object.freeze({
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

export default SubtropicalHumidForestBiome;