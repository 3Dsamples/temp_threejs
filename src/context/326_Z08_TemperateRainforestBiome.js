// file number : 326_Z08
// full path name : src/context/326_Z08_TemperateRainforestBiome.js
// description : Temperate rainforest biome descriptor — the third of four
// additional forest biome presets. This preset covers the cool, hyper-humid
// coastal forests of the Pacific Northwest of North America, southern Chile,
// New Zealand, Tasmania, and small pockets in western Europe and the Black Sea
// region. The defining drivers are annual precipitation of at least 140 cm
// and often 200–350 cm, mild year-round temperatures (mean annual 4–12 °C,
// rarely below freezing or above 25 °C), persistent coastal fog that
// contributes 17–30 cm of additional moisture during the dry season, and
// extremely high epiphyte biomass that forms canopy soils and thick moss
// mats on every surface. Soils are acidic, gravelly, organic-rich spodosols
// (pH ≈ 4.85 ± 0.45, coarse fragments ≈ 51.8 ± 20.4 %) with low base
// saturation and high soil organic carbon stocks (≈ 198 Mg C ha⁻¹).
// Provides the same eleven interlocking descriptor blocks as the base biomes,
// with full PBR + anime parameters for wet conifer needles, moss-draped bark,
// canopy epiphyte mats, sword ferns, nurse logs, saturated humus, and the
// distinctive diffuse, green-filtered light of the understorey. The descriptor
// allocates nothing after construction and is consumed by the biome registry,
// blend field, material bridge, climate/soil/hydrology couplings, fauna
// migration system, chunk descriptor, and the full material/lighting/sensory
// pipeline.
//#
// best for : Every consumer that needs a temperate rainforest, cool temperate
// rainforest, or Pacific coastal rainforest biome preset — biome registry
// barrel (327), biome blend field (328), biome blend system (329), cross-biome
// ecotone (330), biome material bridge (331), biome climate coupling (332),
// biome soil coupling (333), biome hydrology coupling (334), biome fauna
// migration (335), landscape chunk descriptor (336), and the whole material/
// lighting/sensory pipeline. Together with the other forest biome files this
// completes the planet-scale living-biome palette, and the temperate rainforest
// preset is the one that must remain seamless from the temperate deciduous
// forest of 326_Z07 through the hyper-humid coastal forest into the subalpine
// and alpine margins.
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
const BIOME_ID = 17;
const BIOME_NAME = 'temperate_rainforest';
const BIOME_DISPLAY_NAME = 'Temperate Rainforest';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── TEMPERATE RAINFOREST CHARACTERISTIC PARAMETERS ─────────────
// ══════════════════════════════════════════════════════════════════
// ─── Climate ────────────────────────────────────────────────────
// Cool, hyper-humid, and foggy. Mean annual temperature is 4–12 °C, rarely
// below 0 °C or above 25 °C. Annual precipitation is at least 140 cm and
// often 200–350 cm, supplemented by fog drip during the summer dry season.
const CLIMATE = Object.freeze({
  // Temperature (°C) — mild year-round, rarely freezing or hot
  temperatureMin: -5.0,             // rare cold snap
  temperatureMax: 25.0,             // rarely exceeds 25 °C
  temperatureMean: 8.0,             // 4–12 °C
  temperatureDailySwing: 6.0,       // moderated by ocean and fog
  temperatureFrostFree: false,       // frost possible but not severe
  // Humidity (0..1) — persistently very high
  humidityMin: 0.70,
  humidityMax: 1.00,
  humidityMean: 0.90,
  // Precipitation (mm/hr mean) — 200–350 cm annually
  precipitationMean: 4.0,
  precipitationMax: 50.0,
  precipitationStormProb: 0.25,     // frequent winter storms
  precipitationAnnualMm: 3000.0,    // 200–350 cm
  // Seasons — two-season pattern: long wet winter and short foggy summer
  seasonalityAmplitude: 0.40,       // small temperature seasonality
  drySeasonLengthDays: 90,          // short summer dry season
  wetSeasonPeakDay: 30,             // winter rains
  snowSeasonDays: 10,               // rare at low elevation
  growingSeasonDays: 240,           // long, mild growing season
  // Wind — moderate on the coast, reduced inland by canopy
  windMeanSpeed: 3.5,
  windMaxSpeed: 30.0,
  windPredominantDirDeg: 270,      // onshore westerlies
  // Weather state probabilities (0..1)
  weatherProbClear: 0.15,
  weatherProbCloudy: 0.40,
  weatherProbRain: 0.30,
  weatherProbStorm: 0.10,
  weatherProbSnow: 0.00,
  weatherProbFog: 0.05,            // coastal fog is frequent in summer
  // Atmospheric
  pressureMeanKPa: 101.0,
  pressureSwingKPa: 2.5
});

// ─── Terrain Bias ────────────────────────────────────────────────
// Temperate rainforest occupies coastal lowlands to mid-elevation slopes,
// often with steep terrain where orographic lifting generates heavy
// precipitation. Local relief can be substantial.
const TERRAIN = Object.freeze({
  elevationBand: ELEVATION_BAND.LOWLAND_TO_MONTANE,
  elevationMinM: 0.0,
  elevationMaxM: 1200.0,
  slopeMeanDeg: 10.0,
  slopeMaxDeg: 40.0,
  roughness: 0.60,
  valleyDepth: 0.40,
  valleyDensity: 0.50,
  plateauBias: 0.35,
  groundwaterTableDepthM: 2.0,      // shallow, saturated
  permafrostDepthM: Infinity,
  terrainRoughnessHint: 0.55,
  biomeHint: BIOME_HINT.TEMPERATE_RAINFOREST
});

// ─── Soil ──────────────────────────────────────────────────────
// Spodosols and histosols dominate: acidic, gravelly, organic-rich, and
// infertile. Mean mineral soil pH is 4.85 ± 0.45, coarse fragment content
// averages 51.8 ± 20.4 %, and soil organic carbon stocks average
// 198 ± 81 Mg C ha⁻¹. Soils are moderately deep (≈ 97 ± 38 cm).
const SOIL = Object.freeze({
  textureClass: SOIL_TEXTURE_CLASS.GRAVELLY_LOAM,
  visualArchetype: SOIL_VISUAL_ARCHETYPE.PODZOL,
  // Primary fractions (0..1) — gravelly, organic-rich
  sand: 0.30,
  silt: 0.30,
  clay: 0.05,
  organicMatter: 0.25,              // high surface organic matter
  gravel: 0.10,
  rockFragment: 0.05,
  // Chemistry
  pH: 4.85,                         // acidic (4.85 ± 0.45)
  fertilityClass: FERTILITY_CLASS.POOR,
  fertilityIndex: 0.15,
  // Physics
  porosity: 0.55,
  bulkDensityGcm3: 0.90,            // low, organic-rich
  waterHoldingCapacity: 0.50,
  hydraulicConductivityMmHr: 3.0,
  cohesionKPa: 4.0,
  plasticityIndex: 10.0,
  // Colour (linear RGB) — dark, organic-stained
  baseAlbedo: [0.12, 0.10, 0.08],
  organicDarkening: 0.75,
  ironOxideRedness: 0.10,
  calciumPale: 0.00,
  // Erosion
  usleKFactor: 0.25,
  windErodibility: 0.10,
  // ─── Spodosol-specific parameters ──────────────────────────
  coarseFragmentPercent: 51.8,      // 51.8 ± 20.4 %
  soilOrganicCarbonMgPerHa: 198.0,  // 198 ± 81 Mg C ha⁻¹
  soilDepthM: 0.97,                 // 96.56 ± 37.80 cm
  drainageClass: 'poor'
});

// ─── Vegetation ─────────────────────────────────────────────────
// Temperate rainforest vegetation is dominated by a few massive conifers
// (Douglas-fir, Sitka spruce, western hemlock, western red cedar, coast
// redwood) with little mid-story and a dense understorey of ferns, mosses,
// and evergreen shrubs. Epiphyte biomass is exceptionally high: mosses,
// lichens, and ferns blanket trunks and branches, and canopy soils form
// thick mats that support invertebrate communities and additional
// vegetation.
const VEGETATION = Object.freeze({
  treeTypeWeights: Object.freeze({
    [TREE_TYPE.SPRUCE]: 0.30,      // Sitka spruce
    [TREE_TYPE.FIR]: 0.25,         // Douglas-fir
    [TREE_TYPE.HEMLOCK]: 0.20,     // western hemlock
    [TREE_TYPE.CEDAR]: 0.15,       // western red cedar
    [TREE_TYPE.MAPLE]: 0.10        // bigleaf maple in gaps
  }),
  grassTypeWeights: Object.freeze({
    [GRASS_TYPE.FERN]: 0.50,       // sword fern, lady fern
    [GRASS_TYPE.MEADOW_GRASS]: 0.20,
    [GRASS_TYPE.SHORT_PRAIRIE]: 0.15,
    [GRASS_TYPE.MOSS]: 0.15        // moss ground cover
  }),
  verticalLayers: 4,                // canopy, mid-story (sparse), understorey, ground
  emergentDensity: 0.10,            // towering emergents
  canopyDensity: 0.85,              // closed canopy
  understoryDensity: 0.60,          // dense fern and shrub layer
  groundCoverDensity: 0.70,         // moss and litter
  epiphyteDensity: 0.90,            // exceptionally high
  lianaDensity: 0.05,
  successionTarget: SUCCESSION.CLIMAX,
  fireRegimeYears: 500,             // fire is extremely rare
  rootDepthM: 1.5,                  // shallow, wide-spreading
  canopyRadiusM: 6.0,
  trunkHeightM: 60.0,               // up to 90 m for emergents
  leafLitterDepthM: 0.15,           // thick, slow-decomposing litter
  bloomWindowDays: 60,
  // Poisson-disc targets per hectare
  treeDensityPerHa: 250,
  shrubDensityPerHa: 1200,
  groundCoverDensityPerHa: 35000,
  // ─── Epiphyte and canopy soil parameters ──────────────────
  canopySoilDepthCm: 15.0,          // thick epiphyte mats
  epiphyteBiomassKgPerHa: 20000.0,  // exceptionally high
  mossCoverPercent: 85.0            // near-total moss cover on trunks
});

// ─── Fauna ──────────────────────────────────────────────────────
// Temperate rainforest fauna is diverse but often secretive. Characteristic
// guilds include salamanders, frogs, birds (varied thrush, spotted owl,
// lyrebird in Australasia), and mammals (deer, elk, bears, marsupials in
// the southern hemisphere).
const FAUNA = Object.freeze({
  densityWeight: 0.50,
  habitatLayers: Object.freeze({
    ground: 0.35,                   // salamanders, small mammals
    understory: 0.35,               // dense fern and shrub layer
    canopy: 0.20,                   // arboreal species, birds
    aerial: 0.10
  }),
  dielActivity: 0.35,               // many species are crepuscular or nocturnal
  migrationCorridorWeight: 0.50,    // some altitudinal migration
  predatorPreyBalance: 0.45,
  nectarAvailability: 0.10,
  pollenAvailability: 0.10,
  // Characteristic guild weights
  amphibianWeight: 0.25,            // salamanders and frogs
  birdWeight: 0.25,
  smallMammalWeight: 0.25,
  largeHerbivoreWeight: 0.15,       // deer, elk
  largePredatorWeight: 0.10         // bear, cougar
});

// ─── Materials ──────────────────────────────────────────────────
// Full PBR + anime parameters for temperate rainforest surfaces: wet conifer
// needles, moss-draped bark, canopy epiphyte mats, sword ferns, nurse logs,
// saturated humus, and the distinctive green-filtered understorey light.
const MATERIALS = Object.freeze({
  // ─── Wet conifer needle ────────────────────────────────────
  wetConiferNeedle: Object.freeze({
    albedo: [0.04, 0.10, 0.04],     // dark green
    roughness: 0.65,                 // smoother when wet
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.80,
    animeFlatness: 0.25,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.40,             // wet needles are not highly flammable
    hardness: 0.35,
    brittleness: 0.65
  }),
  // ─── Moss-draped bark ──────────────────────────────────────
  mossyBark: Object.freeze({
    albedo: [0.10, 0.12, 0.06],     // green-brown
    roughness: 0.85,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.90,
    animeFlatness: 0.30,
    acousticProfile: ACOUSTIC_PROFILE.WOOD,
    flammability: 0.30,
    hardness: 0.60,
    brittleness: 0.45
  }),
  // ─── Canopy epiphyte mat ───────────────────────────────────
  epiphyteMat: Object.freeze({
    albedo: [0.12, 0.18, 0.08],     // green moss and fern
    roughness: 0.80,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.10,
    emissive: 0.0,
    wetnessResponse: 1.0,
    animeFlatness: 0.20,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.25,
    hardness: 0.10,
    brittleness: 0.85
  }),
  // ─── Sword fern / understorey herb ─────────────────────────
  swordFern: Object.freeze({
    albedo: [0.08, 0.16, 0.06],     // deep green
    roughness: 0.75,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.08,
    emissive: 0.0,
    wetnessResponse: 0.85,
    animeFlatness: 0.20,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.35,
    hardness: 0.15,
    brittleness: 0.80
  }),
  // ─── Nurse log (decaying wood) ─────────────────────────────
  nurseLog: Object.freeze({
    albedo: [0.10, 0.07, 0.04],     // dark, decayed wood
    roughness: 0.92,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.95,
    animeFlatness: 0.40,
    acousticProfile: ACOUSTIC_PROFILE.WOOD,
    flammability: 0.15,
    hardness: 0.25,
    brittleness: 0.70
  }),
  // ─── Saturated humus ────────────────────────────────────────
  saturatedHumus: Object.freeze({
    albedo: [0.08, 0.06, 0.04],     // very dark
    roughness: 0.90,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 1.0,
    animeFlatness: 0.45,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.10,
    hardness: 0.05,
    brittleness: 0.95
  }),
  // ─── Fog / mist (volumetric placeholder) ─────────────────
  fog: Object.freeze({
    albedo: [0.85, 0.88, 0.90],
    roughness: 0.20,
    metalness: 0.0,
    transmission: 0.90,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 1.0,
    animeFlatness: 0.10,
    acousticProfile: ACOUSTIC_PROFILE.SOFT,
    flammability: 0.0,
    hardness: 0.0,
    brittleness: 1.0
  })
});

// ─── Lighting ───────────────────────────────────────────────────
// Temperate rainforest lighting is dominated by diffuse, fog-filtered light
// and a dense canopy that creates deep shade on the forest floor. The
// understorey receives a small fraction of incident light, strongly
// green-shifted by transmission through leaves.
const LIGHTING = Object.freeze({
  canopyOcclusion: 0.85,            // very dense canopy
  sunDiffuseFraction: 0.75,         // fog and cloud dominate
  sunIntensityScale: 0.70,          // reduced direct irradiance
  colourCast: [0.85, 0.95, 0.85],   // green-shifted
  atmosphericScatterBoost: 1.40,    // high humidity and fog
  bioluminescentEmission: 0.08,     // some bioluminescent fungi
  dappledLightFrequency: 0.35,      // dappled light through canopy gaps
  dappledLightAmplitude: 0.30,
  shadowSoftnessNear: 0.6,
  shadowSoftnessMid: 0.8,
  shadowSoftnessFar: 0.95,
  shadowCascadeScale: 0.7,
  snowAlbedoBoost: 0.0,
  fogDensityBase: 0.035,            // persistent coastal fog
  skyTint: [0.80, 0.88, 0.92],
  // ─── Canopy gap fraction ──────────────────────────────────
  canopyGapFraction: 0.15,
  // ─── Understorey light attenuation ─────────────────────────
  // Only 1–5 % of incident light reaches the forest floor.
  understoreyLightFraction: 0.03,
  // ─── Fog drip parameters ──────────────────────────────────
  fogDripMmPerDay: 5.0
});

// ─── Water ──────────────────────────────────────────────────────
// Water is abundant year-round: precipitation is high, fog drip adds
// moisture in summer, and streams and seeps are ubiquitous.
const WATER = Object.freeze({
  surfaceWaterPresence: 0.30,       // streams, seeps, small ponds
  riverineNetworkDensity: 0.40,
  canopyDrip: 0.50,                 // very high
  groundwaterTableDepthM: 2.0,
  freshwaterSpringPresence: 0.25,
  waterTableDepthM: 2.0,
  bogCoverage: 0.10,
  lakeCoverage: 0.05,
  riverWidthMeanM: 4.0,
  waterTemperatureC: 8.0,
  iceCoverMonths: 0,
  shorelineMaterial: 'saturatedHumus',
  fogDripContributionMmPerYear: 300.0
});

// ─── Sensory ────────────────────────────────────────────────────
const SENSORY = Object.freeze({
  acoustic: Object.freeze({
    biological: 0.30,               // birds, amphibians, insects
    geological: 0.00,
    water: 0.35,                    // dripping, streams
    wind: 0.15,                     // muted by canopy
    vegetation: 0.20,               // leaf and frond rustle
    mechanical: 0.00
  }),
  olfactory: Object.freeze({
    floral: 0.05,
    earthy: 0.30,                   // wet soil, humus
    aquatic: 0.20,
    woodland: 0.25,                 // moss, bark, decay
    smoke: 0.00,
    animal: 0.05,
    decay: 0.10,
    sulfur: 0.00,
    sea: 0.05,
    clean: 0.05
  }),
  tactile: Object.freeze({
    temperatureC: 8.0,
    humidity: 0.90,
    windPressurePa: 2.0,
    precipitationType: 'rain',
    groundHardness: 0.20           // soft, saturated
  })
});

// ─── Seasonality ────────────────────────────────────────────────
// Temperate rainforest is evergreen; the seasonal signal is weak in
// temperature but strong in precipitation (wet winter, foggy summer). Ferns
// and epiphytes remain green year-round.
const SEASONALITY = Object.freeze({
  phenologyOverrides: Object.freeze({
    budBreakDayOffset: 0,
    fullGreenDurationDays: 300,      // essentially evergreen
    autumnColourShiftDays: 20,
    leafDropDurationDays: 10,
    bloomWindowDays: 60,
    sporeBoostWetSeason: 0.40,
    fungalBoostWetSeason: 0.35
  }),
  seasonalMaterialPalettes: Object.freeze({
    [SEASONAL_MATERIAL.SPRING_NEW_LEAF]: Object.freeze({
      wetConiferNeedle: { albedo: [0.06, 0.12, 0.06], roughness: 0.68 },
      swordFern: { albedo: [0.10, 0.20, 0.08], roughness: 0.75 }
    }),
    [SEASONAL_MATERIAL.SUMMER_FULL_GREEN]: Object.freeze({
      wetConiferNeedle: { albedo: [0.04, 0.10, 0.04], roughness: 0.65 },
      epiphyteMat: { albedo: [0.12, 0.18, 0.08], roughness: 0.80 }
    }),
    [SEASONAL_MATERIAL.AUTUMN_PEAK]: Object.freeze({
      wetConiferNeedle: { albedo: [0.06, 0.09, 0.05], roughness: 0.68 },
      mossyBark: { albedo: [0.12, 0.14, 0.08], roughness: 0.85 }
    }),
    [SEASONAL_MATERIAL.WINTER_BARE_BRANCH]: Object.freeze({
      wetConiferNeedle: { albedo: [0.06, 0.08, 0.06], roughness: 0.70 },
      saturatedHumus: { albedo: [0.10, 0.08, 0.06], wetnessResponse: 1.0 }
    })
  }),
  snowAccumulationRateMmHr: 0.0,
  snowMeltRateMmHr: 0.0,
  snowAlbedoSeasonal: 0.0
});

// ─── Procedural ─────────────────────────────────────────────────
const PROCEDURAL = Object.freeze({
  macroCanopyNoiseScale: 100.0,
  midUnderstoryNoiseScale: 30.0,
  microLitterNoiseScale: 5.0,
  terrainNoiseScale: 250.0,
  epiphyteNoiseScale: 20.0,
  treeDensityPerHa: VEGETATION.treeDensityPerHa,
  shrubDensityPerHa: VEGETATION.shrubDensityPerHa,
  groundCoverDensityPerHa: VEGETATION.groundCoverDensityPerHa,
  lodHighDistance: 600.0,           // dense understorey needs close LOD
  lodMidDistance: 2500.0,
  lodLowDistance: 12000.0,
  maxFireEventsPerTick: 0,          // fire is extremely rare
  maxErosionEventsPerTick: 2,       // high rainfall and steep slopes
  maxGrowthEventsPerTick: 4
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING ────────────────────────────────────────
// Temperate rainforest suitability is driven by very high precipitation,
// mild temperatures (rarely freezing or hot), persistent humidity and fog,
// acidic gravelly spodosol soil, and low-to-mid elevation with orographic
// influence. 328_BiomeBlendField uses this to decide how much of the
// temperate rainforest biome applies at any world point.
// ══════════════════════════════════════════════════════════════════
const _scratchVec3 = new Vec3();
const _scratchNoise = new SimplexNoise();

function getSuitability(env) {
  // ─── Temperature: mild year-round, rarely freezing or hot ──────────
  const tempScore = smoothstep(-5.0, 5.0, env.temperatureC) * (1.0 - smoothstep(22.0, 30.0, env.temperatureC));

  // ─── Humidity: persistently very high ──────────────────────────────
  const humidityScore = smoothstep(0.75, 0.90, env.humidity);

  // ─── Elevation: lowland to mid-montane ────────────────────────────
  const elevScore = smoothstep(0.0, 200.0, env.elevationM) * (1.0 - smoothstep(1000.0, 1500.0, env.elevationM));

  // ─── Slope: moderate to steep orographic slopes ──────────────────
  const slopeScore = smoothstep(2.0, 10.0, env.slopeDeg) * (1.0 - smoothstep(35.0, 50.0, env.slopeDeg));

  // ─── Soil texture: gravelly loam (spodosol) is typical ───────────
  const textureScore =
    0.40 * smoothstep(0.25, 0.45, env.soilSilt) +
    0.30 * smoothstep(0.20, 0.40, env.soilSand) +
    0.30 * (1.0 - smoothstep(0.05, 0.20, env.soilClay));

  // ─── Water table: shallow, saturated ──────────────────────────────
  const waterScore = 1.0 - smoothstep(1.0, 4.0, env.waterTableDepthM);

  // ─── Patchiness ────────────────────────────────────────────────────
  const patchiness = env.noise !== undefined ? (0.85 + 0.15 * env.noise) : 1.0;

  // ─── Weighted fusion ────────────────────────────────────────────────
  // Precipitation (humidity) and mild temperature dominate.
  const raw =
    0.25 * tempScore +
    0.30 * humidityScore +
    0.12 * elevScore +
    0.10 * slopeScore +
    0.13 * textureScore +
    0.10 * waterScore;

  return Math.max(0.0, Math.min(1.0, raw * patchiness));
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR EXPORT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const TemperateRainforestBiome = Object.freeze({
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

export default TemperateRainforestBiome;