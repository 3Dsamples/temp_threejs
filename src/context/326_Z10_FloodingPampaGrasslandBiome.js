// file number : 326_Z10
// full path name : src/context/326_Z10_FloodingPampaGrasslandBiome.js
// description : Flooding Pampa grassland biome descriptor — the first of four
// additional grassland biome presets with a strong flowering-forb component.
// This preset covers the halomorphic lowland grasslands of the Argentinean
// Pampas, a 90,000 km² region of very gentle slopes (0.1–0.01 %) developed on
// loessoid sediments, where Mollisols and Alfisols alternate with sodic
// Natraquolls, Natraqualfs, and Natralbolls, and where flooding and
// exchangeable-sodium excess are the dominant ecological controls. The
// vegetation is a monotonous-looking but floristically heterogeneous grassland
// with four major community types — mesophyte grasslands, humid mesophyte
// grasslands, hydrophytic meadows, and halophyte steppes — and a flora rich in
// exotic annual forbs. Characteristic grasses include tall wheatgrass
// (Thinopyrum ponticum), Grama Rhodes (Chloris gayana), and Panicgrass
// (Panicum coloratum), while the forb layer is dominated by Asteraceae,
// Rubiaceae, Malvaceae, Lamiaceae, and Fabaceae. Provides the same eleven
// interlocking descriptor blocks as the base biomes, with full PBR + anime
// parameters for mesophyte grass, halophyte steppe, hydrophytic meadow,
// flowering forbs, sodic soil, and flood-pulse water. The descriptor allocates
// nothing after construction and is consumed by the biome registry, blend
// field, material bridge, climate/soil/hydrology couplings, fauna migration
// system, chunk descriptor, and the full material/lighting/sensory pipeline.
//#
// best for : Every consumer that needs a Flooding Pampa, halomorphic lowland
// grassland, or sodic grassland biome preset — biome registry barrel (327),
// biome blend field (328), biome blend system (329), cross-biome ecotone (330),
// biome material bridge (331), biome climate coupling (332), biome soil
// coupling (333), biome hydrology coupling (334), biome fauna migration (335),
// landscape chunk descriptor (336), and the whole material/lighting/sensory
// pipeline. Together with the other grassland biome files this completes the
// planet-scale living-biome palette, and the Flooding Pampa preset is the one
// that must remain seamless from the Pampa interior through the flood-prone
// lowlands into the halophyte steppe fringe.
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
const BIOME_ID = 19;
const BIOME_NAME = 'flooding_pampa_grassland';
const BIOME_DISPLAY_NAME = 'Flooding Pampa Grassland';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── FLOODING PAMPA CHARACTERISTIC PARAMETERS ───────────────────
// ══════════════════════════════════════════════════════════════════
// ─── Climate ────────────────────────────────────────────────────
// Humid and temperate, with mild winters and warm summers. The defining
// climatic feature is not drought but excess water: rainfall is adequate
// year-round, and the flat terrain prevents drainage, so flooding and
// waterlogging dominate the ecological signal.
const CLIMATE = Object.freeze({
  // Temperature (°C) — humid temperate
  temperatureMin: -5.0,
  temperatureMax: 35.0,
  temperatureMean: 16.0,
  temperatureDailySwing: 10.0,
  temperatureFrostFree: false,
  // Humidity (0..1) — humid
  humidityMin: 0.55,
  humidityMax: 0.95,
  humidityMean: 0.75,
  // Precipitation (mm/hr mean) — adequate year-round
  precipitationMean: 2.5,
  precipitationMax: 30.0,
  precipitationStormProb: 0.15,
  precipitationAnnualMm: 1000.0,
  // Seasons — mild, with a flood pulse in the wet season
  seasonalityAmplitude: 0.55,
  drySeasonLengthDays: 0,
  wetSeasonPeakDay: 120,
  snowSeasonDays: 5,
  growingSeasonDays: 250,
  // Wind — moderate
  windMeanSpeed: 3.0,
  windMaxSpeed: 20.0,
  windPredominantDirDeg: 270,
  // Weather state probabilities (0..1)
  weatherProbClear: 0.30,
  weatherProbCloudy: 0.30,
  weatherProbRain: 0.25,
  weatherProbStorm: 0.05,
  weatherProbSnow: 0.00,
  weatherProbFog: 0.10,
  // Atmospheric
  pressureMeanKPa: 101.3,
  pressureSwingKPa: 2.0
});

// ─── Terrain Bias ────────────────────────────────────────────────
// The Flooding Pampa is defined by extremely low relief: slopes are
// 0.1–0.01 % (1–10 cm per km), so the landscape is almost perfectly flat
// and drainage is almost entirely vertical.
const TERRAIN = Object.freeze({
  elevationBand: ELEVATION_BAND.LOWLAND,
  elevationMinM: 0.0,
  elevationMaxM: 50.0,
  slopeMeanDeg: 0.05,               // 0.1–0.01 % slope 
  slopeMaxDeg: 0.5,
  roughness: 0.15,                  // extremely flat
  valleyDepth: 0.02,
  valleyDensity: 0.10,
  plateauBias: 0.95,
  groundwaterTableDepthM: 0.5,      // very shallow, often at the surface
  permafrostDepthM: Infinity,
  terrainRoughnessHint: 0.10,
  biomeHint: BIOME_HINT.GRASSLAND
});

// ─── Soil ──────────────────────────────────────────────────────
// The Flooding Pampa is a mosaic of Mollisols, Alfisols, and sodic
// Natraquolls, Natraqualfs, and Natralbolls. Sodic soils have high
// exchangeable-sodium percentages and poor structure; they support
// halophyte steppes where salinity is highest.
const SOIL = Object.freeze({
  textureClass: SOIL_TEXTURE_CLASS.SILTY_CLAY_LOAM,
  visualArchetype: SOIL_VISUAL_ARCHETYPE.DARK_HUMUS,
  // Primary fractions (0..1) — loess-derived silty soils
  sand: 0.20,
  silt: 0.45,
  clay: 0.30,
  organicMatter: 0.05,
  gravel: 0.00,
  rockFragment: 0.00,
  // Chemistry — variable, with sodic patches
  pH: 6.5,                          // neutral to slightly alkaline
  fertilityClass: FERTILITY_CLASS.MODERATE,
  fertilityIndex: 0.50,
  // Physics
  porosity: 0.50,
  bulkDensityGcm3: 1.20,
  waterHoldingCapacity: 0.40,
  hydraulicConductivityMmHr: 1.0,   // poor drainage
  cohesionKPa: 8.0,
  plasticityIndex: 22.0,
  // Colour (linear RGB) — dark humus-rich
  baseAlbedo: [0.14, 0.12, 0.10],
  organicDarkening: 0.70,
  ironOxideRedness: 0.15,
  calciumPale: 0.20,                // carbonate enrichment
  // Erosion
  usleKFactor: 0.15,                // low, because of flatness
  windErodibility: 0.20,
  // ─── Sodic and halomorphic parameters ─────────────────────
  exchangeableSodiumPercent: 15.0,   // ESP of 15 % is the sodic threshold
  electricalConductivityDsm: 8.0,    // saline-sodic
  drainageClass: 'poor'
});

// ─── Vegetation ─────────────────────────────────────────────────
// The vegetation is a floristically heterogeneous grassland organised into
// four major community types along a topographic–salinity gradient:
// mesophyte grassland (Udolls), humid mesophyte grassland (Natraquolls),
// hydrophytic meadow (Albolls), and halophyte steppe (Natraqualfs).
// Grasses and forbs coexist; the forb layer is rich in exotic annuals
// and is dominated by Asteraceae, Rubiaceae, Malvaceae, Lamiaceae, and
// Fabaceae.
const VEGETATION = Object.freeze({
  treeTypeWeights: Object.freeze({
    [TREE_TYPE.WILLOW]: 0.60,      // riparian only
    [TREE_TYPE.OAK]: 0.40
  }),
  grassTypeWeights: Object.freeze({
    [GRASS_TYPE.TALL_PRAIRIE]: 0.35,   // tall wheatgrass, tussock grasses
    [GRASS_TYPE.SAVANNA_BUNCH]: 0.25,  // C4 bunchgrasses
    [GRASS_TYPE.MEADOW_GRASS]: 0.20,
    [GRASS_TYPE.MARSH_REED]: 0.15,     // hydrophytic meadow
    [GRASS_TYPE.SHORT_PRAIRIE]: 0.05   // halophyte steppe
  }),
  verticalLayers: 1,                // grass and forb layer
  emergentDensity: 0.00,
  canopyDensity: 0.00,
  understoryDensity: 0.00,
  groundCoverDensity: 0.90,         // near-total grass and forb cover
  epiphyteDensity: 0.00,
  lianaDensity: 0.00,
  successionTarget: SUCCESSION.CLIMAX,
  fireRegimeYears: 200,             // fire is rare in humid grassland
  rootDepthM: 1.5,
  canopyRadiusM: 0.0,
  trunkHeightM: 0.0,
  leafLitterDepthM: 0.05,
  bloomWindowDays: 120,
  // Poisson-disc targets per hectare
  treeDensityPerHa: 0,
  shrubDensityPerHa: 20,
  groundCoverDensityPerHa: 90000,
  // ─── Community-type fractions ──────────────────────────────
  mesophyteFraction: 0.30,          // Udolls
  humidMesophyteFraction: 0.25,     // Natraquolls
  hydrophyticFraction: 0.20,        // Albolls
  halophyteFraction: 0.25,          // Natraqualfs
  // ─── Forb and flowering parameters ─────────────────────────
  forbRichness: 0.60,               // proportion of forb species in the flora
  floweringForbFraction: 0.45,      // forbs that are insect-pollinated
  exoticAnnualFraction: 0.30        // large proportion of exotic annual forbs
});

// ─── Fauna ──────────────────────────────────────────────────────
const FAUNA = Object.freeze({
  densityWeight: 0.55,
  habitatLayers: Object.freeze({
    ground: 0.50,
    understory: 0.20,
    canopy: 0.00,
    aerial: 0.15,
    water: 0.15                    // flooded and waterlogged areas
  }),
  dielActivity: 0.40,
  migrationCorridorWeight: 0.50,
  predatorPreyBalance: 0.45,
  nectarAvailability: 0.25,         // flowering forbs support pollinators
  pollenAvailability: 0.25,
  // Characteristic guild weights
  largeHerbivoreWeight: 0.25,       // cattle, deer
  smallMammalWeight: 0.25,
  birdWeight: 0.25,
  insectWeight: 0.20,               // pollinator and detritivore insects
  amphibianWeight: 0.05
});

// ─── Materials ──────────────────────────────────────────────────
// Full PBR + anime parameters for Flooding Pampa surfaces: mesophyte grass,
// halophyte steppe, hydrophytic meadow, flowering forbs, sodic soil, and
// flood-pulse water.
const MATERIALS = Object.freeze({
  // ─── Mesophyte grass ────────────────────────────────────────
  mesophyteGrass: Object.freeze({
    albedo: [0.14, 0.22, 0.08],
    roughness: 0.80,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.60,
    animeFlatness: 0.20,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.60,
    hardness: 0.15,
    brittleness: 0.80
  }),
  // ─── Halophyte steppe grass ─────────────────────────────────
  halophyteGrass: Object.freeze({
    albedo: [0.28, 0.24, 0.16],     // drier, salt-tinged
    roughness: 0.85,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.03,
    emissive: 0.0,
    wetnessResponse: 0.30,
    animeFlatness: 0.25,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.70,
    hardness: 0.12,
    brittleness: 0.85
  }),
  // ─── Hydrophytic meadow ─────────────────────────────────────
  hydrophyticMeadow: Object.freeze({
    albedo: [0.10, 0.20, 0.12],     // darker, wetter green
    roughness: 0.78,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.08,
    emissive: 0.0,
    wetnessResponse: 0.90,
    animeFlatness: 0.20,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.30,
    hardness: 0.10,
    brittleness: 0.88
  }),
  // ─── Flowering forb ─────────────────────────────────────────
  floweringForb: Object.freeze({
    albedo: [0.20, 0.24, 0.10],     // green with floral accent
    roughness: 0.75,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.50,
    animeFlatness: 0.18,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.55,
    hardness: 0.10,
    brittleness: 0.85
  }),
  // ─── Sodic soil ─────────────────────────────────────────────
  sodicSoil: Object.freeze({
    albedo: [0.20, 0.18, 0.15],     // pale, salt-affected
    roughness: 0.90,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.80,
    animeFlatness: 0.45,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.05,
    hardness: 0.15,
    brittleness: 0.75
  }),
  // ─── Flood-pulse water ──────────────────────────────────────
  floodWater: Object.freeze({
    albedo: [0.12, 0.14, 0.10],     // greenish, turbid
    roughness: 0.12,
    metalness: 0.0,
    transmission: 0.60,
    ior: 1.333,
    fresnelF0: 0.02,
    subsurface: 0.15,
    emissive: 0.0,
    wetnessResponse: 1.0,
    animeFlatness: 0.10,
    acousticProfile: ACOUSTIC_PROFILE.WATER,
    flammability: 0.0,
    hardness: 0.0,
    brittleness: 1.0,
    attenuationKd: Object.freeze({
      red: 0.80,
      green: 0.45,
      blue: 0.25
    })
  })
});

// ─── Lighting ───────────────────────────────────────────────────
const LIGHTING = Object.freeze({
  canopyOcclusion: 0.00,
  sunDiffuseFraction: 0.45,
  sunIntensityScale: 1.05,
  colourCast: [1.00, 0.98, 0.92],
  atmosphericScatterBoost: 1.10,
  bioluminescentEmission: 0.00,
  dappledLightFrequency: 0.00,
  dappledLightAmplitude: 0.00,
  shadowSoftnessNear: 0.4,
  shadowSoftnessMid: 0.6,
  shadowSoftnessFar: 0.8,
  shadowCascadeScale: 1.0,
  snowAlbedoBoost: 0.0,
  fogDensityBase: 0.015,            // humid, flood-prone
  skyTint: [0.85, 0.90, 0.95],
  skyViewFactor: 0.99
});

// ─── Water ──────────────────────────────────────────────────────
// Water is the defining element: the Flooding Pampa is subject to periodic
// widespread flooding because the almost flat terrain cannot drain. The
// water table is shallow, and hydrophytic meadows occupy the lowest
// positions.
const WATER = Object.freeze({
  surfaceWaterPresence: 0.25,       // seasonal flooding
  riverineNetworkDensity: 0.15,     // slow, poorly defined channels
  canopyDrip: 0.05,
  groundwaterTableDepthM: 0.5,
  freshwaterSpringPresence: 0.10,
  waterTableDepthM: 0.5,
  bogCoverage: 0.10,
  lakeCoverage: 0.05,
  riverWidthMeanM: 3.0,
  waterTemperatureC: 16.0,
  iceCoverMonths: 0,
  shorelineMaterial: 'sodicSoil',
  floodPulseAmplitudeM: 1.0,
  floodFrequencyYears: 3.0
});

// ─── Sensory ────────────────────────────────────────────────────
const SENSORY = Object.freeze({
  acoustic: Object.freeze({
    biological: 0.30,
    geological: 0.00,
    water: 0.25,                    // flooding and waterlogging
    wind: 0.30,
    vegetation: 0.15,
    mechanical: 0.00
  }),
  olfactory: Object.freeze({
    floral: 0.15,
    earthy: 0.30,                   // wet soil
    aquatic: 0.15,
    woodland: 0.00,
    smoke: 0.00,
    animal: 0.10,
    decay: 0.10,
    sulfur: 0.00,
    sea: 0.00,
    clean: 0.10
  }),
  tactile: Object.freeze({
    temperatureC: 16.0,
    humidity: 0.75,
    windPressurePa: 3.0,
    precipitationType: 'rain',
    groundHardness: 0.25
  })
});

// ─── Seasonality ────────────────────────────────────────────────
// Phenology is driven by the flood pulse and the temperate temperature cycle.
// Spring growth, summer flowering, autumn senescence, and winter dormancy.
const SEASONALITY = Object.freeze({
  phenologyOverrides: Object.freeze({
    budBreakDayOffset: 0,
    fullGreenDurationDays: 180,
    autumnColourShiftDays: 30,
    leafDropDurationDays: 20,
    bloomWindowDays: 120,
    sporeBoostWetSeason: 0.20,
    fungalBoostWetSeason: 0.15
  }),
  seasonalMaterialPalettes: Object.freeze({
    [SEASONAL_MATERIAL.SPRING_NEW_LEAF]: Object.freeze({
      mesophyteGrass: { albedo: [0.16, 0.26, 0.08], roughness: 0.78 },
      floweringForb: { albedo: [0.20, 0.28, 0.10], roughness: 0.73 }
    }),
    [SEASONAL_MATERIAL.SUMMER_FULL_GREEN]: Object.freeze({
      mesophyteGrass: { albedo: [0.14, 0.22, 0.08], roughness: 0.80 },
      halophyteGrass: { albedo: [0.26, 0.24, 0.14], roughness: 0.84 }
    }),
    [SEASONAL_MATERIAL.AUTUMN_PEAK]: Object.freeze({
      mesophyteGrass: { albedo: [0.28, 0.24, 0.12], roughness: 0.84 },
      floweringForb: { albedo: [0.30, 0.22, 0.10], roughness: 0.80 }
    }),
    [SEASONAL_MATERIAL.WINTER_BARE_BRANCH]: Object.freeze({
      mesophyteGrass: { albedo: [0.30, 0.28, 0.20], roughness: 0.86 },
      sodicSoil: { albedo: [0.22, 0.20, 0.18], wetnessResponse: 0.40 }
    })
  }),
  snowAccumulationRateMmHr: 0.5,
  snowMeltRateMmHr: 2.0,
  snowAlbedoSeasonal: 0.85
});

// ─── Procedural ─────────────────────────────────────────────────
const PROCEDURAL = Object.freeze({
  macroGrassNoiseScale: 80.0,       // community-type mosaics
  midGrassNoiseScale: 20.0,         // patch and forb clump detail
  microGrassNoiseScale: 4.0,        // individual plant detail
  floodPatternNoiseScale: 60.0,     // flood-pulse patterning
  treeDensityPerHa: VEGETATION.treeDensityPerHa,
  shrubDensityPerHa: VEGETATION.shrubDensityPerHa,
  groundCoverDensityPerHa: VEGETATION.groundCoverDensityPerHa,
  lodHighDistance: 1000.0,
  lodMidDistance: 5000.0,
  lodLowDistance: 25000.0,
  maxFireEventsPerTick: 0,          // fire is rare
  maxErosionEventsPerTick: 1,
  maxGrowthEventsPerTick: 4
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING ────────────────────────────────────────
// Flooding Pampa suitability is driven by very low slope, shallow water
// table, sodic or halomorphic soil patches, humid temperate climate, and
// low elevation. 328_BiomeBlendField uses this to decide how much of the
// Flooding Pampa biome applies at any world point.
// ══════════════════════════════════════════════════════════════════
const _scratchVec3 = new Vec3();
const _scratchNoise = new SimplexNoise();

function getSuitability(env) {
  // ─── Temperature: humid temperate ──────────────────────────────────
  const tempScore = smoothstep(-5.0, 8.0, env.temperatureC) * (1.0 - smoothstep(28.0, 38.0, env.temperatureC));

  // ─── Humidity: humid ──────────────────────────────────────────────
  const humidityScore = smoothstep(0.55, 0.75, env.humidity);

  // ─── Elevation: very low ──────────────────────────────────────────
  const elevScore = 1.0 - smoothstep(20.0, 80.0, env.elevationM);

  // ─── Slope: extremely flat is the master variable ──────────────────
  const slopeScore = 1.0 - smoothstep(0.1, 1.0, env.slopeDeg);

  // ─── Soil texture: silty clay loam with sodic patches ──────────────
  const textureScore =
    0.45 * smoothstep(0.35, 0.55, env.soilSilt) +
    0.35 * smoothstep(0.20, 0.40, env.soilClay) +
    0.20 * (1.0 - smoothstep(0.15, 0.35, env.soilSand));

  // ─── Water table: very shallow ─────────────────────────────────────
  const waterScore = 1.0 - smoothstep(0.2, 1.5, env.waterTableDepthM);

  // ─── Patchiness ────────────────────────────────────────────────────
  const patchiness = env.noise !== undefined ? (0.85 + 0.15 * env.noise) : 1.0;

  // ─── Weighted fusion ────────────────────────────────────────────────
  // Slope and water table dominate: the biome is defined by flatness and flooding.
  const raw =
    0.15 * tempScore +
    0.10 * humidityScore +
    0.10 * elevScore +
    0.30 * slopeScore +
    0.15 * textureScore +
    0.20 * waterScore;

  return Math.max(0.0, Math.min(1.0, raw * patchiness));
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR EXPORT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const FloodingPampaGrasslandBiome = Object.freeze({
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

export default FloodingPampaGrasslandBiome;