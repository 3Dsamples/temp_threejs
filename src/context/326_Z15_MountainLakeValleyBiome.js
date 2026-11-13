// file number : 326_Z15
// full path name : src/context/326_Z15_MountainLakeValleyBiome.js
// description : Mountain lake valley biome descriptor — the second of four
// arbitrary landscape biomes that combine rock, valley, canyon, hill, lake,
// river, and vegetation features. This preset covers glacially carved lake
// basins in alpine and subalpine settings: the fjord-like lakes of Patagonia,
// the glacial tarns of the Rocky Mountains and the Alps, the ribbon lakes of
// the English Lake District, and the cirque lakes of the Himalaya and the
// Andes. The defining drivers are a deep, cold, oligotrophic lake at the
// valley floor, steep rock walls on both sides, a snowmelt-fed inlet and
// outlet stream, and a sharp vegetation gradient from lakeshore sedge and
// willow through conifer forest to alpine meadow at the valley shoulders.
// Water clarity in these lakes is exceptionally high — Secchi depths of 10–30
// m are common — because the glacial rock flour has settled out and the
// catchment is small and undisturbed. The lake thermal structure is strongly
// seasonal: winter inverse stratification under ice, spring and autumn
// turnover, and summer thermal stratification. Provides the same eleven
// interlocking descriptor blocks as the base biomes, with full PBR + anime
// parameters for the cold oligotrophic lake surface, the rocky shoreline,
// the willow and sedge community, the conifer forest belt, the alpine meadow
// above, and the high-clarity, blue-shifted light of a mountain valley. The
// descriptor allocates nothing after construction and is consumed by the biome
// registry, blend field, material bridge, climate/soil/hydrology couplings,
// fauna migration system, chunk descriptor, and the full material/lighting/
// sensory pipeline.
//#
// best for : Every consumer that needs a mountain lake, glacial lake, alpine
// tarn, ribbon lake, or subalpine valley biome preset — biome registry barrel
// (327), biome blend field (328), biome blend system (329), cross-biome ecotone
// (330), biome material bridge (331), biome climate coupling (332), biome soil
// coupling (333), biome hydrology coupling (334), biome fauna migration (335),
// landscape chunk descriptor (336), and the whole material/lighting/sensory
// pipeline. This preset is designed to remain seamless from the open lake
// surface through the lakeshore and conifer belt to the alpine meadow, and
// to blend smoothly with the surrounding alpine and coniferous forest biomes.
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
import { CarveGradientProvider, CARVE_TYPE } from './282_Z03_CarveGradientProvider.js';
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
const BIOME_ID = 24;
const BIOME_NAME = 'mountain_lake_valley';
const BIOME_DISPLAY_NAME = 'Mountain Lake Valley';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── MOUNTAIN LAKE VALLEY CHARACTERISTIC PARAMETERS ─────────────
// ══════════════════════════════════════════════════════════════════
// ─── Climate ────────────────────────────────────────────────────
// Cool and moist, strongly elevation-dependent. Winters are cold with snow
// accumulation; summers are short and cool. Valley-floor temperatures are
// moderated by the lake's thermal mass.
const CLIMATE = Object.freeze({
  // Temperature (°C) — cool, moderated by lake
  temperatureMin: -25.0,            // cold valley-floor winter
  temperatureMax: 25.0,             // cool summer
  temperatureMean: 5.0,
  temperatureDailySwing: 12.0,
  temperatureFrostFree: false,
  // Lapse rate for elevation correction
  lapseRateKPerKm: 6.5,
  // Humidity (0..1) — humid
  humidityMin: 0.55,
  humidityMax: 0.95,
  humidityMean: 0.72,
  // Precipitation (mm/hr mean) — 800–2,000 mm annually, mostly snow
  precipitationMean: 1.5,
  precipitationMax: 25.0,
  precipitationStormProb: 0.10,
  precipitationAnnualMm: 1400.0,
  // Seasons — long snow season, short summer
  seasonalityAmplitude: 0.75,
  drySeasonLengthDays: 0,
  wetSeasonPeakDay: 0,
  snowSeasonDays: 150,
  growingSeasonDays: 120,
  // Wind — mountain-valley circulation (katabatic at night, anabatic by day)
  windMeanSpeed: 2.5,
  windMaxSpeed: 25.0,
  windPredominantDirDeg: 180,
  // Weather state probabilities (0..1)
  weatherProbClear: 0.30,
  weatherProbCloudy: 0.35,
  weatherProbRain: 0.15,
  weatherProbStorm: 0.05,
  weatherProbSnow: 0.15,
  weatherProbFog: 0.00,
  // Atmospheric
  pressureMeanKPa: 90.0,            // ~90 kPa at 1,500 m
  pressureSwingKPa: 2.0
});

// ─── Terrain Bias ────────────────────────────────────────────────
// The valley is U-shaped from glacial carving: a flat or gently sloping valley
// floor, steep rock walls on both sides, and a lake basin at the floor.
const TERRAIN = Object.freeze({
  elevationBand: ELEVATION_BAND.MONTANE_TO_ALPINE,
  elevationMinM: 1000.0,
  elevationMaxM: 3000.0,
  slopeMeanDeg: 15.0,               // bimodal: flat floor + steep walls
  slopeMaxDeg: 70.0,
  roughness: 0.65,
  valleyDepth: 0.75,                // deep U-shaped valley
  valleyDensity: 0.30,
  plateauBias: 0.20,
  groundwaterTableDepthM: 2.0,
  permafrostDepthM: Infinity,
  terrainRoughnessHint: 0.70,
  biomeHint: BIOME_HINT.MONTANE_LAKE,
  // ─── Valley geometry ───────────────────────────────────────
  valleyWidthRangeM: 800.0,
  valleyDepthRangeM: 600.0,
  valleySinuosity: 1.2,
  // ─── Lake basin parameters ────────────────────────────────
  lakeMaxDepthM: 80.0,
  lakeMeanDepthM: 25.0,
  lakeSurfaceAreaKm2: 2.5,
  lakeShorelineLengthKm: 12.0,
  lakeBasinOrigin: 'glacial_cirque'
});

// ─── Soil ──────────────────────────────────────────────────────
// Soils are variable by position: rocky and thin on the walls, alluvial and
// organic-rich at the lakeshore, and peat in boggy margins.
const SOIL = Object.freeze({
  textureClass: SOIL_TEXTURE_CLASS.GRAVELLY_LOAM,
  visualArchetype: SOIL_VISUAL_ARCHETYPE.BROWN_FOREST,
  // Primary fractions (0..1)
  sand: 0.30,
  silt: 0.35,
  clay: 0.15,
  organicMatter: 0.10,
  gravel: 0.10,
  rockFragment: 0.00,
  // Chemistry
  pH: 5.5,
  fertilityClass: FERTILITY_CLASS.MODERATE,
  fertilityIndex: 0.40,
  // Physics
  porosity: 0.50,
  bulkDensityGcm3: 1.15,
  waterHoldingCapacity: 0.30,
  hydraulicConductivityMmHr: 8.0,
  cohesionKPa: 6.0,
  plasticityIndex: 12.0,
  // Colour (linear RGB)
  baseAlbedo: [0.20, 0.16, 0.12],
  organicDarkening: 0.50,
  ironOxideRedness: 0.20,
  calciumPale: 0.10,
  // Erosion
  usleKFactor: 0.25,
  windErodibility: 0.20,
  drainageClass: 'moderate'
});

// ─── Vegetation ─────────────────────────────────────────────────
// Vegetation is zoned by elevation and distance from the lake:
// lakeshore sedges and willow → conifer forest on the lower slopes →
// alpine meadow above the treeline.
const VEGETATION = Object.freeze({
  treeTypeWeights: Object.freeze({
    [TREE_TYPE.SPRUCE]: 0.35,
    [TREE_TYPE.FIR]: 0.25,
    [TREE_TYPE.PINE]: 0.20,
    [TREE_TYPE.BIRCH]: 0.15,
    [TREE_TYPE.WILLOW]: 0.05      // lakeshore
  }),
  grassTypeWeights: Object.freeze({
    [GRASS_TYPE.ALPINE_TUFT]: 0.35,
    [GRASS_TYPE.MARSH_REED]: 0.25,  // lakeshore sedges
    [GRASS_TYPE.MEADOW_GRASS]: 0.25,
    [GRASS_TYPE.FERN]: 0.15
  }),
  verticalLayers: 3,                // conifer → shrub → meadow/sedge
  emergentDensity: 0.00,
  canopyDensity: 0.65,
  understoryDensity: 0.30,
  groundCoverDensity: 0.60,
  epiphyteDensity: 0.15,
  lianaDensity: 0.00,
  successionTarget: SUCCESSION.CLIMAX,
  fireRegimeYears: 200,
  rootDepthM: 1.5,
  canopyRadiusM: 3.0,
  trunkHeightM: 18.0,
  leafLitterDepthM: 0.08,
  bloomWindowDays: 60,
  // Poisson-disc targets per hectare
  treeDensityPerHa: 800,
  shrubDensityPerHa: 500,
  groundCoverDensityPerHa: 12000,
  // ─── Zonation fractions ──────────────────────────────────
  lakeshoreSedgeFraction: 0.15,
  coniferBeltFraction: 0.55,
  alpineMeadowFraction: 0.30
});

// ─── Fauna ──────────────────────────────────────────────────────
const FAUNA = Object.freeze({
  densityWeight: 0.50,
  habitatLayers: Object.freeze({
    lake: 0.30,                     // fish, waterfowl
    shore: 0.20,                    // amphibians, shorebirds
    forest: 0.35,                   // forest mammals and birds
    alpine: 0.15                    // alpine species
  }),
  dielActivity: 0.40,
  migrationCorridorWeight: 0.55,
  predatorPreyBalance: 0.45,
  nectarAvailability: 0.10,
  pollenAvailability: 0.10,
  // Characteristic guild weights
  fishWeight: 0.25,
  waterfowlWeight: 0.20,
  smallMammalWeight: 0.25,
  largeHerbivoreWeight: 0.15,
  largePredatorWeight: 0.05,
  amphibianWeight: 0.10
});

// ─── Materials ──────────────────────────────────────────────────
// Full PBR + anime parameters for mountain lake valley surfaces: cold
// oligotrophic lake water, rocky shoreline, willow and sedge, conifer forest,
// and alpine meadow.
const MATERIALS = Object.freeze({
  // ─── Cold oligotrophic lake ─────────────────────────────────
  mountainLakeWater: Object.freeze({
    albedo: [0.04, 0.10, 0.14],     // deep blue-green
    roughness: 0.06,                 // calm, smooth
    metalness: 0.0,
    transmission: 0.88,
    ior: 1.333,
    fresnelF0: 0.02,
    subsurface: 0.25,
    emissive: 0.0,
    wetnessResponse: 1.0,
    animeFlatness: 0.08,
    acousticProfile: ACOUSTIC_PROFILE.WATER,
    flammability: 0.0,
    hardness: 0.0,
    brittleness: 1.0,
    // ─── High-clarity absorption (low CDOM) ────────────────
    attenuationKd: Object.freeze({
      red: 0.30,                    // red absorbed fastest
      green: 0.05,
      blue: 0.02                    // blue penetrates deepest
    }),
    // ─── Gerstner waves (small alpine waves) ──────────────
    gerstnerWaves: Object.freeze({
      gravity: 9.81,
      spectrum: Object.freeze([
        Object.freeze({ amplitude: 0.10, wavelength: 15.0, steepness: 0.20, directionDeg: 270 }),
        Object.freeze({ amplitude: 0.05, wavelength: 8.0, steepness: 0.25, directionDeg: 250 }),
        Object.freeze({ amplitude: 0.02, wavelength: 4.0, steepness: 0.30, directionDeg: 290 })
      ])
    })
  }),
  // ─── Rocky shoreline ────────────────────────────────────────
  rockyShore: Object.freeze({
    albedo: [0.25, 0.22, 0.20],
    roughness: 0.80,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 1.0,
    animeFlatness: 0.40,
    acousticProfile: ACOUSTIC_PROFILE.ROCK,
    flammability: 0.0,
    hardness: 0.85,
    brittleness: 0.30
  }),
  // ─── Lakeshore willow / sedge ───────────────────────────────
  lakeshoreVegetation: Object.freeze({
    albedo: [0.12, 0.20, 0.08],
    roughness: 0.78,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.08,
    emissive: 0.0,
    wetnessResponse: 0.80,
    animeFlatness: 0.22,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.50,
    hardness: 0.15,
    brittleness: 0.80
  }),
  // ─── Conifer belt ───────────────────────────────────────────
  coniferBelt: Object.freeze({
    albedo: [0.04, 0.10, 0.04],
    roughness: 0.80,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.40,
    animeFlatness: 0.30,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.85,
    hardness: 0.40,
    brittleness: 0.60
  }),
  // ─── Alpine meadow ──────────────────────────────────────────
  alpineMeadow: Object.freeze({
    albedo: [0.15, 0.22, 0.10],
    roughness: 0.82,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.50,
    animeFlatness: 0.25,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.40,
    hardness: 0.10,
    brittleness: 0.85
  }),
  // ─── Rock wall (cliff) ──────────────────────────────────────
  rockWall: Object.freeze({
    albedo: [0.28, 0.26, 0.22],
    roughness: 0.88,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.20,
    animeFlatness: 0.50,
    acousticProfile: ACOUSTIC_PROFILE.ROCK,
    flammability: 0.0,
    hardness: 0.92,
    brittleness: 0.25
  }),
  // ─── Seasonal snow ─────────────────────────────────────────
  mountainSnow: Object.freeze({
    albedo: [0.92, 0.94, 0.97],
    roughness: 0.35,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.30,
    emissive: 0.0,
    wetnessResponse: 0.05,
    animeFlatness: 0.12,
    acousticProfile: ACOUSTIC_PROFILE.SOFT,
    flammability: 0.0,
    hardness: 0.10,
    brittleness: 0.90
  })
});

// ─── Lighting ───────────────────────────────────────────────────
// Mountain lake lighting is cool, blue-shifted, and clear. The lake surface
// creates strong specular reflection and bounce light; the valley walls
// create shadow patterns that vary with sun angle.
const LIGHTING = Object.freeze({
  canopyOcclusion: 0.30,            // conifer belt shades the lower slopes
  sunDiffuseFraction: 0.40,
  sunIntensityScale: 1.10,
  colourCast: [0.85, 0.92, 1.00],   // cool blue-shifted
  atmosphericScatterBoost: 0.75,    // clear mountain air
  bioluminescentEmission: 0.00,
  dappledLightFrequency: 0.30,
  dappledLightAmplitude: 0.25,
  shadowSoftnessNear: 0.4,
  shadowSoftnessMid: 0.6,
  shadowSoftnessFar: 0.8,
  shadowCascadeScale: 1.0,
  snowAlbedoBoost: 1.55,            // high snow albedo
  fogDensityBase: 0.008,            // valley mist at dawn
  skyTint: [0.75, 0.85, 0.98],
  // ─── Lake surface reflections ─────────────────────────────
  specularReflectionStrength: 0.35,
  // ─── Valley-wall shadow depth ────────────────────────────
  valleyShadowDepth: 0.45,
  // ─── Sky-view factor ─────────────────────────────────────
  skyViewFactor: 0.75
});

// ─── Water ──────────────────────────────────────────────────────
// Water is abundant: the lake is the centre of the biome, fed by snowmelt and
// springs, and drained by a single outlet stream. The lake is cold and
// oligotrophic with high clarity.
const WATER = Object.freeze({
  surfaceWaterPresence: 0.45,       // the lake dominates the valley floor
  riverineNetworkDensity: 0.25,     // inlet and outlet streams
  canopyDrip: 0.05,
  groundwaterTableDepthM: 2.0,
  freshwaterSpringPresence: 0.20,
  waterTableDepthM: 2.0,
  bogCoverage: 0.10,                // boggy lake margins
  lakeCoverage: 0.35,               // the lake itself
  riverWidthMeanM: 4.0,
  waterTemperatureC: 8.0,
  iceCoverMonths: 4,
  shorelineMaterial: 'rockyShore',
  // ─── Lake thermal structure ───────────────────────────────
  thermalStratification: true,
  epilimnionDepthM: 5.0,
  thermoclineDepthM: 10.0,
  hypolimnionTemperatureC: 4.0,
  // ─── Optical clarity ─────────────────────────────────────
  secchiDepthM: 15.0,
  turbidityNTU: 0.5,
  chlorophyllMgL: 0.5,
  cdomAbsorption: 0.05,
  // ─── Inlet and outlet ────────────────────────────────────
  inletDischargeM3s: 2.0,
  outletDischargeM3s: 2.0,
  residenceTimeDays: 90.0,
  // ─── Snowmelt ────────────────────────────────────────────
  degreeDayFactorMmPerCPerDay: 3.5,
  meltBaseTemperatureC: 0.0
});

// ─── Sensory ────────────────────────────────────────────────────
const SENSORY = Object.freeze({
  acoustic: Object.freeze({
    biological: 0.20,               // birds, insects, distant calls
    geological: 0.05,               // rockfall
    water: 0.45,                    // lake surface, inlet/outlet
    wind: 0.20,                     // wind through conifers
    vegetation: 0.10,
    mechanical: 0.00
  }),
  olfactory: Object.freeze({
    floral: 0.10,
    earthy: 0.20,
    aquatic: 0.30,                  // cold freshwater
    woodland: 0.20,                 // conifer resin
    smoke: 0.00,
    animal: 0.05,
    decay: 0.05,
    sulfur: 0.00,
    sea: 0.00,
    clean: 0.10
  }),
  tactile: Object.freeze({
    temperatureC: 8.0,
    humidity: 0.72,
    windPressurePa: 3.0,
    precipitationType: 'snow',
    groundHardness: 0.55
  })
});

// ─── Seasonality ────────────────────────────────────────────────
// Phenology is driven by the snowmelt pulse and the short summer. Lake ice
// cover is the dominant winter signal; spring melt is the dominant spring
// signal.
const SEASONALITY = Object.freeze({
  phenologyOverrides: Object.freeze({
    budBreakDayOffset: 0,
    fullGreenDurationDays: 100,
    autumnColourShiftDays: 25,
    leafDropDurationDays: 15,
    bloomWindowDays: 60,
    sporeBoostWetSeason: 0.20,
    fungalBoostWetSeason: 0.15
  }),
  seasonalMaterialPalettes: Object.freeze({
    [SEASONAL_MATERIAL.SPRING_NEW_LEAF]: Object.freeze({
      lakeshoreVegetation: { albedo: [0.15, 0.26, 0.10], roughness: 0.76 },
      coniferBelt: { albedo: [0.06, 0.12, 0.06], roughness: 0.78 }
    }),
    [SEASONAL_MATERIAL.SUMMER_FULL_GREEN]: Object.freeze({
      coniferBelt: { albedo: [0.04, 0.10, 0.04], roughness: 0.80 },
      alpineMeadow: { albedo: [0.15, 0.22, 0.10], roughness: 0.82 },
      mountainLakeWater: { albedo: [0.04, 0.10, 0.14], roughness: 0.06 }
    }),
    [SEASONAL_MATERIAL.AUTUMN_PEAK]: Object.freeze({
      coniferBelt: { albedo: [0.08, 0.09, 0.05], roughness: 0.82 },
      alpineMeadow: { albedo: [0.28, 0.22, 0.10], roughness: 0.84 }
    }),
    [SEASONAL_MATERIAL.WINTER_BARE_BRANCH]: Object.freeze({
      mountainLakeWater: { albedo: [0.70, 0.78, 0.85], roughness: 0.12, transmission: 0.35 },
      mountainSnow: { albedo: [0.92, 0.94, 0.97], roughness: 0.35 },
      coniferBelt: { albedo: [0.06, 0.08, 0.06], roughness: 0.84 }
    })
  }),
  snowAccumulationRateMmHr: 2.0,
  snowMeltRateMmHr: 3.0,
  snowAlbedoSeasonal: 0.92
});

// ─── Procedural ─────────────────────────────────────────────────
const PROCEDURAL = Object.freeze({
  macroValleyNoiseScale: 400.0,     // valley and lake basin shape
  midValleyNoiseScale: 80.0,        // shoreline and terrace patterning
  microShoreNoiseScale: 10.0,       // rock and vegetation detail
  treeDensityPerHa: VEGETATION.treeDensityPerHa,
  shrubDensityPerHa: VEGETATION.shrubDensityPerHa,
  groundCoverDensityPerHa: VEGETATION.groundCoverDensityPerHa,
  lodHighDistance: 1000.0,
  lodMidDistance: 5000.0,
  lodLowDistance: 25000.0,
  maxFireEventsPerTick: 1,
  maxErosionEventsPerTick: 2,       // shoreline erosion, rockfall
  maxGrowthEventsPerTick: 3
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING ────────────────────────────────────────
// Mountain lake valley suitability is driven by moderate elevation (1,000–
// 3,000 m), cool temperature, high humidity, a U-shaped valley with a lake
// basin (deep valley depth, flat floor, steep walls), and a shallow water
// table at the lakeshore. 328_BiomeBlendField uses this to decide how much
// of the mountain lake valley biome applies at any world point.
// ══════════════════════════════════════════════════════════════════
const _scratchVec3 = new Vec3();
const _scratchNoise = new SimplexNoise();

function getSuitability(env) {
  // ─── Elevation: montane to subalpine belt ──────────────────────────
  const elevScore =
    smoothstep(600.0, 1200.0, env.elevationM) *
    (1.0 - smoothstep(2500.0, 3200.0, env.elevationM));

  // ─── Temperature: cool, with cold winters and cool summers ────────
  const tempScore = smoothstep(-20.0, 0.0, env.temperatureC) * (1.0 - smoothstep(20.0, 30.0, env.temperatureC));

  // ─── Humidity: humid ────────────────────────────────────────────
  const humidityScore = smoothstep(0.55, 0.75, env.humidity);

  // ─── Slope: bimodal — flat valley floor OR steep walls ───────────
  // High score at slope < 5° (floor) and slope > 25° (walls).
  const floorScore = 1.0 - smoothstep(2.0, 10.0, env.slopeDeg);
  const wallScore = smoothstep(25.0, 45.0, env.slopeDeg) * (1.0 - smoothstep(65.0, 80.0, env.slopeDeg));
  const slopeScore = Math.max(floorScore, wallScore);

  // ─── Water table: shallow, especially near the lake ──────────────
  const waterScore =
    0.60 * (1.0 - smoothstep(0.5, 3.0, env.waterTableDepthM)) +  // lakeside
    0.40 * smoothstep(3.0, 10.0, env.waterTableDepthM);          // upper slopes

  // ─── Substrate: gravelly loam is typical ────────────────────────
  const textureScore =
    0.40 * smoothstep(0.25, 0.45, env.soilSilt) +
    0.35 * smoothstep(0.20, 0.40, env.soilSand) +
    0.25 * (1.0 - smoothstep(0.10, 0.25, env.soilClay));

  // ─── Valley depth: the deeper the valley, the stronger the signal ─
  const reliefScore = env.reliefRangeM !== undefined
    ? smoothstep(200.0, 600.0, env.reliefRangeM)
    : 0.5;

  // ─── Patchiness ────────────────────────────────────────────────────
  const patchiness = env.noise !== undefined ? (0.80 + 0.20 * env.noise) : 1.0;

  // ─── Weighted fusion ────────────────────────────────────────────────
  const raw =
    0.20 * elevScore +
    0.15 * tempScore +
    0.12 * humidityScore +
    0.15 * slopeScore +
    0.15 * waterScore +
    0.10 * textureScore +
    0.13 * reliefScore;

  return Math.max(0.0, Math.min(1.0, raw * patchiness));
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR EXPORT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const MountainLakeValleyBiome = Object.freeze({
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

export default MountainLakeValleyBiome;