// file number : 326_Z03
// full path name : src/context/326_Z03_SteppePrairieBiome.js
// description : Steppe / prairie temperate grassland biome descriptor — the
// third of five additional biome presets. This preset covers the continental-
// interior grasslands of Eurasia (the Pontic–Caspian steppe, the Kazakh steppe)
// and North America (tallgrass, mixed-grass, and shortgrass prairie). The
// defining drivers are continentality (wide temperature extremes), low and
// erratic precipitation concentrated in the growing season, and the deepest,
// most fertile soil order on Earth: the mollisol (chernozem). Provides the same
// eleven interlocking descriptor blocks as the base nine biomes, with full PBR
// + anime parameters for sod-forming grass, bunchgrass, exposed chernozem,
// loess, and seasonal snow. Key calibration points: mean annual temperature
// −2.5 °C to 7 °C; annual precipitation 300–600 mm; frost-free period
// 100–140 days; replacement fire every 5–15 years; and co-evolved grazing by
// bison, pronghorn, and prairie dogs that shapes the fuel mosaic. The descriptor
// allocates nothing after construction and is consumed by the biome registry,
// blend field, material bridge, climate/soil/hydrology couplings, fauna
// migration system, chunk descriptor, and the full material/lighting/sensory
// pipeline.
//#
// best for : Every consumer that needs a steppe, prairie, pampa, or temperate
// grassland biome preset — biome registry barrel (327), biome blend field (328),
// biome blend system (329), cross-biome ecotone (330), biome material bridge
// (331), biome climate coupling (332), biome soil coupling (333), biome
// hydrology coupling (334), biome fauna migration (335), landscape chunk
// descriptor (336), and the whole material/lighting/sensory pipeline. Together
// with the other extended biome files this completes the planet-scale
// living-biome palette, and the steppe preset is the one that must remain
// seamless from shortgrass through mixed-grass to tallgrass prairie, and from
// the grazed mosaic into the fire-maintained open landscape.
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
const BIOME_ID = 12;
const BIOME_NAME = 'steppe_prairie';
const BIOME_DISPLAY_NAME = 'Steppe / Prairie';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── STEPPE / PRAIRIE CHARACTERISTIC PARAMETERS ─────────────────
// ══════════════════════════════════════════════════════════════════
// ─── Climate ────────────────────────────────────────────────────
// Continentality is the defining climate signal: cold winters, warm summers,
// and a precipitation maximum in late spring / early summer.
const CLIMATE = Object.freeze({
  // Temperature (°C)
  temperatureMin: -35.0,            // severe continental winter
  temperatureMax: 40.0,             // hot continental summer
  temperatureMean: 5.0,             // 42–45 °F (6–7 °C) North America; –2.5 to 5.6 °C Asia
  temperatureDailySwing: 15.0,
  temperatureFrostFree: false,
  // Humidity (0..1)
  humidityMin: 0.20,
  humidityMax: 0.75,
  humidityMean: 0.50,
  // Precipitation (mm/hr mean)
  precipitationMean: 1.2,
  precipitationMax: 25.0,
  precipitationStormProb: 0.15,
  precipitationAnnualMm: 500.0,     // 300–600 mm across the steppe–prairie gradient
  // Seasons
  seasonalityAmplitude: 0.85,
  drySeasonLengthDays: 60,
  wetSeasonPeakDay: 150,            // late spring / early summer
  snowSeasonDays: 90,
  growingSeasonDays: 120,           // 100–140 frost-free days
  // Wind — strong, persistent, and a major geomorphic agent
  windMeanSpeed: 4.5,
  windMaxSpeed: 30.0,
  windPredominantDirDeg: 270,      // westerly in both North America and Eurasia
  // Weather state probabilities (0..1)
  weatherProbClear: 0.35,
  weatherProbCloudy: 0.25,
  weatherProbRain: 0.20,
  weatherProbStorm: 0.10,
  weatherProbSnow: 0.10,
  weatherProbFog: 0.00,
  // Atmospheric
  pressureMeanKPa: 101.0,
  pressureSwingKPa: 3.0
});

// ─── Terrain Bias ────────────────────────────────────────────────
// Prairie and steppe are expansive, nearly flat to gently rolling plains.
// Local relief is low; the landscape is dominated by horizontal sightlines.
const TERRAIN = Object.freeze({
  elevationBand: ELEVATION_BAND.LOWLAND_TO_PLAINS,
  elevationMinM: 0.0,
  elevationMaxM: 1500.0,
  slopeMeanDeg: 1.5,
  slopeMaxDeg: 12.0,
  roughness: 0.25,                  // smooth, rolling
  valleyDepth: 0.10,                // shallow, broad valleys
  valleyDensity: 0.20,
  plateauBias: 0.85,                // extremely flat
  groundwaterTableDepthM: 6.0,
  permafrostDepthM: Infinity,
  terrainRoughnessHint: 0.20,
  biomeHint: BIOME_HINT.GRASSLAND
});

// ─── Soil ──────────────────────────────────────────────────────
// Mollisols (chernozems) are the defining soil: deep, dark, base-rich, and
// among the most fertile soils on Earth. They form under grassland because
// the dense root mat and slow decomposition accumulate organic matter.
const SOIL = Object.freeze({
  textureClass: SOIL_TEXTURE_CLASS.SILTY_CLAY_LOAM,
  visualArchetype: SOIL_VISUAL_ARCHETYPE.DARK_HUMUS,
  // Primary fractions (0..1) — loam to silty clay loam
  sand: 0.25,
  silt: 0.45,
  clay: 0.25,
  organicMatter: 0.05,              // surface horizon is organic-rich
  gravel: 0.00,
  rockFragment: 0.00,
  // Chemistry
  pH: 6.8,                          // near neutral, base-saturated
  fertilityClass: FERTILITY_CLASS.RICH,
  fertilityIndex: 0.85,
  // Physics
  porosity: 0.50,
  bulkDensityGcm3: 1.15,
  waterHoldingCapacity: 0.35,
  hydraulicConductivityMmHr: 5.0,
  cohesionKPa: 10.0,
  plasticityIndex: 18.0,
  // Colour (linear RGB) — dark humus-rich A horizon
  baseAlbedo: [0.12, 0.09, 0.06],
  organicDarkening: 0.85,           // very dark
  ironOxideRedness: 0.10,
  calciumPale: 0.15,                // carbonate enrichment in the B horizon
  // Erosion
  usleKFactor: 0.30,
  windErodibility: 0.60,            // wind erosion is significant
  // ─── Mollisol-specific parameters ──────────────────────────
  mollicEpipedonThicknessM: 0.60,   // thick, dark surface horizon
  baseSaturationPercent: 85.0,
  cationExchangeCapacity: 35.0      // cmol(+)/kg
});

// ─── Vegetation ─────────────────────────────────────────────────
// Grassland vegetation is dominated by perennial grasses. Tallgrass prairie
// in the east transitions through mixed-grass to shortgrass steppe in the west,
// following the precipitation gradient. Sod-forming grasses dominate the
// mesic end; bunchgrasses dominate the arid end.
const VEGETATION = Object.freeze({
  treeTypeWeights: Object.freeze({
    [TREE_TYPE.OAK]: 0.60,        // bur oak in riparian corridors and savanna
    [TREE_TYPE.PINE]: 0.20,       // ponderosa pine at the western margin
    [TREE_TYPE.CYPRESS]: 0.20     // bottomland hardwood pockets
  }),
  grassTypeWeights: Object.freeze({
    [GRASS_TYPE.TALL_PRAIRIE]: 0.40,   // big bluestem, indiangrass
    [GRASS_TYPE.SHORT_PRAIRIE]: 0.35,  // buffalo grass, blue grama
    [GRASS_TYPE.MEADOW_GRASS]: 0.20,   // western wheatgrass, needlegrass
    [GRASS_TYPE.THISTLE]: 0.05
  }),
  verticalLayers: 1,                // grass layer only; trees are riparian
  emergentDensity: 0.00,
  canopyDensity: 0.05,              // scattered savanna trees only
  understoryDensity: 0.10,
  groundCoverDensity: 0.90,         // near-complete grass cover
  epiphyteDensity: 0.00,
  lianaDensity: 0.00,
  successionTarget: SUCCESSION.CLIMAX,
  fireRegimeYears: 10,              // replacement fire every 5–15 years
  rootDepthM: 2.5,                  // deep, fibrous root systems
  canopyRadiusM: 3.0,
  trunkHeightM: 6.0,
  leafLitterDepthM: 0.10,
  bloomWindowDays: 90,
  // Poisson-disc targets per hectare
  treeDensityPerHa: 10,             // very sparse, riparian only
  shrubDensityPerHa: 50,
  groundCoverDensityPerHa: 80000,   // near-total grass cover
  // ─── Sod-forming vs. bunchgrass fraction ──────────────────
  // Sod-forming grasses dominate the mesic (tallgrass) end; bunchgrasses
  // dominate the arid (shortgrass) end.
  sodFormerFraction: 0.55,
  bunchgrassFraction: 0.45,
  // ─── Grazing-adapted traits ────────────────────────────────
  // Belowground biomass exceeds aboveground biomass in intact prairie.
  rootToShootRatio: 4.0,
  grazingTolerance: 0.80
});

// ─── Fauna ──────────────────────────────────────────────────────
// Steppe and prairie fauna is adapted to open landscapes, extremes of
// temperature, and co-evolved grazing and fire. Burrowing is a dominant
// survival strategy.
const FAUNA = Object.freeze({
  densityWeight: 0.50,
  habitatLayers: Object.freeze({
    ground: 0.55,                   // grazers, predators, burrowers
    understory: 0.25,               // grassland birds, small mammals
    canopy: 0.05,                   // riparian trees only
    aerial: 0.15                    // raptors, prairie chickens
  }),
  dielActivity: 0.40,               // crepuscular bias due to heat
  migrationCorridorWeight: 0.75,    // bison and pronghorn migrations
  predatorPreyBalance: 0.45,
  nectarAvailability: 0.10,
  pollenAvailability: 0.10,
  // Characteristic guild weights
  largeHerbivoreWeight: 0.35,       // bison, pronghorn, elk
  largePredatorWeight: 0.10,        // wolf, coyote, mountain lion
  smallMammalWeight: 0.30,          // prairie dog, ground squirrel, jackrabbit
  birdWeight: 0.20,                 // burrowing owl, prairie chicken, meadowlark
  insectWeight: 0.05,
  // ─── Ecosystem-engineer parameters ─────────────────────────
  // Prairie dog colonies create patches of short grass and bare ground.
  prairieDogColonyDensityPerHa: 15.0,
  // Bison wallows are compacted depressions that hold water.
  bisonWallowDensityPerHa: 2.0
});

// ─── Materials ──────────────────────────────────────────────────
// Full PBR + anime parameters for steppe/prairie surfaces: sod-forming grass,
// bunchgrass, dark chernozem soil, loess, and seasonal snow.
const MATERIALS = Object.freeze({
  // ─── Sod-forming tallgrass ──────────────────────────────────
  tallgrassSod: Object.freeze({
    albedo: [0.12, 0.22, 0.08],
    roughness: 0.80,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.45,
    animeFlatness: 0.20,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.75,
    hardness: 0.15,
    brittleness: 0.80
  }),
  // ─── Shortgrass / bunchgrass ────────────────────────────────
  shortgrassBunch: Object.freeze({
    albedo: [0.28, 0.26, 0.12],     // drier, straw-tinged
    roughness: 0.85,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.03,
    emissive: 0.0,
    wetnessResponse: 0.30,
    animeFlatness: 0.25,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.80,
    hardness: 0.12,
    brittleness: 0.85
  }),
  // ─── Chernozem / mollisol surface ──────────────────────────
  chernozem: Object.freeze({
    albedo: [0.10, 0.08, 0.06],     // very dark, humus-rich
    roughness: 0.92,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.50,
    animeFlatness: 0.40,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.05,
    hardness: 0.30,
    brittleness: 0.65
  }),
  // ─── Loess (wind-blown silt) ────────────────────────────────
  loess: Object.freeze({
    albedo: [0.42, 0.38, 0.30],
    roughness: 0.88,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.35,
    animeFlatness: 0.45,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.0,
    hardness: 0.15,
    brittleness: 0.80,
    // ─── Loess erodibility ────────────────────────────────────
    windErodibilityIndex: 0.85
  }),
  // ─── Seasonal snow ─────────────────────────────────────────
  prairieSnow: Object.freeze({
    albedo: [0.88, 0.90, 0.94],
    roughness: 0.40,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.30,
    emissive: 0.0,
    wetnessResponse: 0.10,
    animeFlatness: 0.15,
    acousticProfile: ACOUSTIC_PROFILE.SOFT,
    flammability: 0.0,
    hardness: 0.10,
    brittleness: 0.88
  }),
  // ─── Riparian oak bark ──────────────────────────────────────
  riparianOakBark: Object.freeze({
    albedo: [0.16, 0.12, 0.08],
    roughness: 0.90,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.40,
    animeFlatness: 0.35,
    acousticProfile: ACOUSTIC_PROFILE.WOOD,
    flammability: 0.60,
    hardness: 0.80,
    brittleness: 0.30
  })
});

// ─── Lighting ───────────────────────────────────────────────────
// Steppe and prairie lighting is dominated by huge sky exposure: there is
// little to no canopy, so the sky dome contributes a large fraction of
// irradiance, and the wide-open landscape produces long, unbroken shadows.
const LIGHTING = Object.freeze({
  canopyOcclusion: 0.02,            // essentially no canopy
  sunDiffuseFraction: 0.40,         // large sky fraction from open horizon
  sunIntensityScale: 1.15,
  colourCast: [1.00, 0.98, 0.92],   // warm continental light
  atmosphericScatterBoost: 1.00,
  bioluminescentEmission: 0.00,
  dappledLightFrequency: 0.00,
  dappledLightAmplitude: 0.00,
  shadowSoftnessNear: 0.4,
  shadowSoftnessMid: 0.6,
  shadowSoftnessFar: 0.8,
  shadowCascadeScale: 1.0,
  snowAlbedoBoost: 1.30,
  fogDensityBase: 0.008,
  skyTint: [0.82, 0.88, 0.98],
  // ─── Wide-sky exposure term ────────────────────────────────
  // The sky-view factor is near 1.0 because there is no canopy.
  skyViewFactor: 0.98,
  // ─── Dust haze ─────────────────────────────────────────────
  dustHazeDensity: 0.012
});

// ─── Water ──────────────────────────────────────────────────────
// Water is scarce and seasonal. Prairie potholes and steppe lakes are
// important but localised; most moisture is stored in the soil.
const WATER = Object.freeze({
  surfaceWaterPresence: 0.08,
  riverineNetworkDensity: 0.15,
  canopyDrip: 0.02,
  groundwaterTableDepthM: 6.0,
  freshwaterSpringPresence: 0.05,
  waterTableDepthM: 6.0,
  bogCoverage: 0.00,
  lakeCoverage: 0.03,               // prairie potholes
  riverWidthMeanM: 3.0,
  waterTemperatureC: 12.0,
  iceCoverMonths: 4,
  shorelineMaterial: 'chernozem',
  // ─── Seasonal wetlands ─────────────────────────────────────
  // Prairie potholes fill in spring and often dry by late summer.
  seasonalWetlandFraction: 0.15,
  potholeDensityPerKm2: 8.0
});

// ─── Sensory ────────────────────────────────────────────────────
const SENSORY = Object.freeze({
  // Acoustic signature (0..1 weights across 8 channels)
  acoustic: Object.freeze({
    biological: 0.30,               // grassland birds, insects
    geological: 0.05,               // wind-driven soil
    water: 0.05,
    wind: 0.45,                     // wind through grass dominates
    vegetation: 0.15,
    mechanical: 0.00
  }),
  // Olfactory signature
  olfactory: Object.freeze({
    floral: 0.15,
    earthy: 0.35,                   // rich soil
    aquatic: 0.05,
    woodland: 0.05,
    smoke: 0.10,                    // grassfire smoke
    animal: 0.10,
    decay: 0.05,
    sulfur: 0.00,
    sea: 0.00,
    clean: 0.15
  }),
  // Tactile profile
  tactile: Object.freeze({
    temperatureC: 12.0,
    humidity: 0.50,
    windPressurePa: 6.0,
    precipitationType: 'rain',
    groundHardness: 0.55
  })
});

// ─── Seasonality ────────────────────────────────────────────────
// Prairie phenology is a rapid spring green-up, a summer flowering peak, and
// an autumn curing to straw. Winter is dormant under snow or frozen ground.
const SEASONALITY = Object.freeze({
  phenologyOverrides: Object.freeze({
    budBreakDayOffset: 0,
    fullGreenDurationDays: 100,
    autumnColourShiftDays: 30,
    leafDropDurationDays: 15,
    bloomWindowDays: 90,
    sporeBoostWetSeason: 0.10,
    fungalBoostWetSeason: 0.05
  }),
  seasonalMaterialPalettes: Object.freeze({
    [SEASONAL_MATERIAL.SPRING_NEW_LEAF]: Object.freeze({
      tallgrassSod: { albedo: [0.12, 0.28, 0.08], roughness: 0.78 },
      chernozem: { albedo: [0.10, 0.08, 0.06], wetnessResponse: 0.65 }
    }),
    [SEASONAL_MATERIAL.SUMMER_FULL_GREEN]: Object.freeze({
      tallgrassSod: { albedo: [0.12, 0.22, 0.08], roughness: 0.80 },
      shortgrassBunch: { albedo: [0.25, 0.26, 0.10], roughness: 0.84 }
    }),
    [SEASONAL_MATERIAL.AUTUMN_PEAK]: Object.freeze({
      tallgrassSod: { albedo: [0.30, 0.26, 0.12], roughness: 0.86 },  // cured straw
      shortgrassBunch: { albedo: [0.35, 0.30, 0.15], roughness: 0.88 }
    }),
    [SEASONAL_MATERIAL.WINTER_BARE_BRANCH]: Object.freeze({
      tallgrassSod: { albedo: [0.28, 0.24, 0.18], roughness: 0.88 },  // dormant
      prairieSnow: { albedo: [0.88, 0.90, 0.94], roughness: 0.40 },
      chernozem: { albedo: [0.12, 0.10, 0.08], wetnessResponse: 0.20 }
    })
  }),
  snowAccumulationRateMmHr: 1.5,
  snowMeltRateMmHr: 3.0,
  snowAlbedoSeasonal: 0.88
});

// ─── Procedural ─────────────────────────────────────────────────
const PROCEDURAL = Object.freeze({
  // Noise scales (world units) for grass mosaic and soil patterning
  macroGrassNoiseScale: 100.0,      // tallgrass–shortgrass transition bands
  midGrassNoiseScale: 25.0,         // grazing and fire patch mosaic
  microGrassNoiseScale: 4.0,        // individual bunch detail
  potholeNoiseScale: 60.0,          // prairie pothole distribution
  // Poisson-disc density targets (per hectare) — mirrored from VEGETATION
  treeDensityPerHa: VEGETATION.treeDensityPerHa,
  shrubDensityPerHa: VEGETATION.shrubDensityPerHa,
  groundCoverDensityPerHa: VEGETATION.groundCoverDensityPerHa,
  // LOD scale thresholds (world units) — very long sightlines across open plains
  lodHighDistance: 1200.0,
  lodMidDistance: 6000.0,
  lodLowDistance: 30000.0,
  // Procedural event budgets
  maxFireEventsPerTick: 3,          // fire every 5–15 years
  maxErosionEventsPerTick: 2,       // wind erosion
  maxGrowthEventsPerTick: 4,
  // ─── Fire spread parameters ────────────────────────────────
  fireSpreadRateMPerMin: 30.0,     // grass fires spread quickly
  // ─── Grazing patch parameters ──────────────────────────────
  grazingPatchRegrowthDays: 60.0
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING ────────────────────────────────────────
// Steppe/prairie suitability is driven by continentality (wide temperature
// range, cold winters), moderate but sub-humid precipitation, flat terrain,
// and base-rich loam or silty clay loam soils. 328_BiomeBlendField uses this
// to decide how much of the steppe/prairie biome applies at any world point.
// ══════════════════════════════════════════════════════════════════
const _scratchVec3 = new Vec3();
const _scratchNoise = new SimplexNoise();

/**
 * Compute the steppe/prairie suitability at a world position and environmental
 * state. All inputs are expected to come from the context frame or from
 * provider summaries. The function allocates nothing after module
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
  // ─── Temperature: cold winters and warm summers are both required ─────
  const tempScore =
    smoothstep(-30.0, 0.0, env.temperatureC) *
    (1.0 - smoothstep(30.0, 45.0, env.temperatureC));

  // ─── Humidity: sub-humid; too dry becomes desert, too wet becomes forest ─
  const humidityScore = smoothstep(0.30, 0.55, env.humidity) * (1.0 - smoothstep(0.70, 0.85, env.humidity));

  // ─── Elevation: lowland to plains; high mountains are excluded ───────
  const elevScore = smoothstep(0.0, 200.0, env.elevationM) * (1.0 - smoothstep(1200.0, 2000.0, env.elevationM));

  // ─── Slope: flat to gently rolling is defining ──────────────────────
  const slopeScore = smoothstep(0.0, 1.0, env.slopeDeg) * (1.0 - smoothstep(8.0, 15.0, env.slopeDeg));

  // ─── Soil texture: loam to silty clay loam (mollisol) is ideal ──────
  const textureScore =
    0.40 * smoothstep(0.30, 0.50, env.soilSilt) +
    0.30 * smoothstep(0.15, 0.35, env.soilClay) +
    0.30 * (1.0 - smoothstep(0.30, 0.55, env.soilSand));

  // ─── Water table: deep enough to avoid waterlogging, shallow enough for grass ─
  const waterScore = smoothstep(3.0, 8.0, env.waterTableDepthM) * (1.0 - smoothstep(15.0, 30.0, env.waterTableDepthM));

  // ─── Patchiness: grazing and fire create a mosaic ──────────────────
  const patchiness = env.noise !== undefined ? (0.85 + 0.15 * env.noise) : 1.0;

  // ─── Weighted fusion ────────────────────────────────────────────────
  const raw =
    0.28 * tempScore +
    0.20 * humidityScore +
    0.12 * elevScore +
    0.15 * slopeScore +
    0.15 * textureScore +
    0.10 * waterScore;

  return Math.max(0.0, Math.min(1.0, raw * patchiness));
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR EXPORT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const SteppePrairieBiome = Object.freeze({
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

export default SteppePrairieBiome;