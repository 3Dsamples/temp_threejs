// file number : 326_Z14
// full path name : src/context/326_Z14_CanyonlandsBiome.js
// description : Canyonlands biome descriptor — the first of four arbitrary
// landscape biomes that combine rock, valley, canyon, hill, lake, river, and
// vegetation features into a single coherent preset. This preset covers deeply
// incised canyon country — the Colorado Plateau of the American Southwest, the
// canyons of the Blue Mountains in Australia, the Anti-Atlas canyons of
// Morocco, and the karst-tower canyons of southern China. The defining drivers
// are high relief carved into layered sedimentary or volcanic rock, an arid to
// semi-arid climate, a strong elevational moisture gradient from dry rim to wet
// canyon floor, a sparse but distinctive riparian corridor along intermittent
// streams, and a rock substrate that ranges from friable shale to massive
// sandstone to hard limestone. Vegetation is strongly zoned by elevation and
// aspect: sparse desert scrub on the rim, pinyon-juniper woodland on the
// mid-slope, and cottonwood-willow gallery forest along the canyon bottom. The
// vertical rock walls dominate the visual and physical experience. Provides the
// same eleven interlocking descriptor blocks as the base biomes, with full PBR
// + anime parameters for sandstone, shale, limestone, talus, rimrock, canyon
// scrub, pinyon-juniper, and the intermittent stream and pool water that
// anchors the riparian corridor. The descriptor allocates nothing after
// construction and is consumed by the biome registry, blend field, material
// bridge, climate/soil/hydrology couplings, fauna migration system, chunk
// descriptor, and the full material/lighting/sensory pipeline.
//#
// best for : Every consumer that needs a canyon, canyonlands, river-cut gorge,
// sedimentary-rock badlands, or incised-plateau biome preset — biome registry
// barrel (327), biome blend field (328), biome blend system (329), cross-biome
// ecotone (330), biome material bridge (331), biome climate coupling (332),
// biome soil coupling (333), biome hydrology coupling (334), biome fauna
// migration (335), landscape chunk descriptor (336), and the whole material/
// lighting/sensory pipeline. This preset is designed to remain seamless from
// the dry rim through the mid-slope and into the wet canyon floor, and to
// blend smoothly with the surrounding open-desert and semi-arid scrublands.
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
const BIOME_ID = 23;
const BIOME_NAME = 'canyonlands';
const BIOME_DISPLAY_NAME = 'Canyonlands';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── CANYONLANDS CHARACTERISTIC PARAMETERS ──────────────────────
// ══════════════════════════════════════════════════════════════════
// ─── Climate ────────────────────────────────────────────────────
// Arid to semi-arid, with a strong elevational moisture gradient. The rim is
// dry and hot in summer and cold in winter; the canyon floor is warmer and
// wetter. Flash floods are the defining hydrological event.
const CLIMATE = Object.freeze({
  // Temperature (°C) — continental and strongly elevation-dependent
  temperatureMin: -20.0,            // cold rim winter
  temperatureMax: 42.0,             // hot canyon floor summer
  temperatureMean: 14.0,
  temperatureDailySwing: 16.0,      // strong diurnal swing in dry air
  temperatureFrostFree: false,
  // Humidity (0..1) — dry, but canyon floor is slightly more humid
  humidityMin: 0.10,
  humidityMax: 0.60,
  humidityMean: 0.30,
  // Precipitation (mm/hr mean) — low, but flash floods are extreme
  precipitationMean: 0.4,
  precipitationMax: 60.0,           // flash-flood convective bursts
  precipitationStormProb: 0.10,
  precipitationAnnualMm: 250.0,
  // Seasons — bimodal: summer convective storms and winter frontal storms
  seasonalityAmplitude: 0.70,
  drySeasonLengthDays: 180,
  wetSeasonPeakDay: 200,            // late summer monsoon
  snowSeasonDays: 30,               // shallow rim snow
  growingSeasonDays: 180,
  // Wind — strong, gusty, and erosive
  windMeanSpeed: 4.0,
  windMaxSpeed: 35.0,
  windPredominantDirDeg: 225,      // south-westerly in the American Southwest
  // Weather state probabilities (0..1)
  weatherProbClear: 0.55,
  weatherProbCloudy: 0.20,
  weatherProbRain: 0.10,
  weatherProbStorm: 0.10,
  weatherProbSnow: 0.05,
  weatherProbFog: 0.00,
  // Atmospheric
  pressureMeanKPa: 100.5,
  pressureSwingKPa: 2.0
});

// ─── Terrain Bias ────────────────────────────────────────────────
// Canyonlands is defined by high relief, vertical rock walls, incised meanders,
// and broad bench-and-ledge strata. Slope statistics are extreme: near-vertical
// walls on the cliff faces, near-horizontal benches on the strata.
const TERRAIN = Object.freeze({
  elevationBand: ELEVATION_BAND.PLATEAU_TO_CANYON,
  elevationMinM: 800.0,
  elevationMaxM: 2500.0,
  slopeMeanDeg: 25.0,               // bimodal: flat benches and vertical cliffs
  slopeMaxDeg: 90.0,                // vertical cliff faces
  roughness: 0.85,                  // very rugged
  valleyDepth: 0.90,                // deep incision is the defining trait
  valleyDensity: 0.60,              // dendritic canyon network
  plateauBias: 0.40,
  groundwaterTableDepthM: 20.0,     // deep, except in the canyon bottom
  permafrostDepthM: Infinity,
  terrainRoughnessHint: 0.90,
  biomeHint: BIOME_HINT.CANYON,
  // ─── Canyon geometry ───────────────────────────────────────
  canyonDepthRangeM: 300.0,
  canyonWidthRangeM: 500.0,
  canyonSinuosity: 1.4,             // incised meanders
  strataLayers: 8,                  // visible sedimentary layers
  // ─── Cliff and bench parameters ────────────────────────────
  cliffFaceFraction: 0.40,
  benchFraction: 0.35,
  talusFraction: 0.15,
  riverbedFraction: 0.10
});

// ─── Soil ──────────────────────────────────────────────────────
// Canyonlands soils are thin, skeletal, and lithologically controlled. Rim
// soils are thin and sandy; bench soils are sandy-loam with calcium carbonate
// horizons; canyon-floor soils are alluvial, sandy, and more fertile.
const SOIL = Object.freeze({
  textureClass: SOIL_TEXTURE_CLASS.SANDY_LOAM,
  visualArchetype: SOIL_VISUAL_ARCHETYPE.SANDY_TAN,
  // Primary fractions (0..1) — sandy, skeletal
  sand: 0.55,
  silt: 0.20,
  clay: 0.10,
  organicMatter: 0.02,
  gravel: 0.10,
  rockFragment: 0.03,
  // Chemistry — variable, often alkaline from carbonate
  pH: 7.8,
  fertilityClass: FERTILITY_CLASS.POOR,
  fertilityIndex: 0.20,
  // Physics
  porosity: 0.40,
  bulkDensityGcm3: 1.45,
  waterHoldingCapacity: 0.12,
  hydraulicConductivityMmHr: 20.0,  // rapid drainage
  cohesionKPa: 2.0,
  plasticityIndex: 5.0,
  // Colour (linear RGB) — pale sand and red sandstone
  baseAlbedo: [0.45, 0.32, 0.22],
  organicDarkening: 0.10,
  ironOxideRedness: 0.60,           // red sandstone
  calciumPale: 0.30,                // carbonate
  // Erosion
  usleKFactor: 0.35,
  windErodibility: 0.65,
  // ─── Lithology fractions ──────────────────────────────────
  sandstoneFraction: 0.50,
  shaleFraction: 0.25,
  limestoneFraction: 0.20,
  volcanicFraction: 0.05,
  drainageClass: 'excessive'
});

// ─── Vegetation ─────────────────────────────────────────────────
// Canyonlands vegetation is strongly zoned by elevation, aspect, and moisture:
// sparse desert scrub on the dry rim, pinyon-juniper woodland on mid-slopes,
// and cottonwood-willow gallery forest in the riparian corridor along the
// intermittent stream at the canyon bottom.
const VEGETATION = Object.freeze({
  treeTypeWeights: Object.freeze({
    [TREE_TYPE.PINE]: 0.40,        // pinyon-juniper woodland
    [TREE_TYPE.OAK]: 0.20,         // scrub oak
    [TREE_TYPE.WILLOW]: 0.25,      // cottonwood-willow gallery forest
    [TREE_TYPE.CYPRESS]: 0.15      // juniper
  }),
  grassTypeWeights: Object.freeze({
    [GRASS_TYPE.SHORT_PRAIRIE]: 0.40,  // desert bunchgrass
    [GRASS_TYPE.THALL_PRAIRIE]: 0.20,
    [GRASS_TYPE.MARSH_REED]: 0.25,     // canyon-floor marsh
    [GRASS_TYPE.THISTLE]: 0.15
  }),
  verticalLayers: 3,                // rim scrub + mid-slope woodland + riparian
  emergentDensity: 0.00,
  canopyDensity: 0.20,              // woodland is sparse and zoned
  understoryDensity: 0.30,
  groundCoverDensity: 0.30,
  epiphyteDensity: 0.02,
  lianaDensity: 0.05,               // wild grape, poison ivy
  successionTarget: SUCCESSION.CLIMAX,
  fireRegimeYears: 30,              // fire every 20–50 years
  rootDepthM: 1.5,
  canopyRadiusM: 2.5,
  trunkHeightM: 6.0,
  leafLitterDepthM: 0.03,
  bloomWindowDays: 60,
  // Poisson-disc targets per hectare
  treeDensityPerHa: 100,            // low, zoned density
  shrubDensityPerHa: 600,
  groundCoverDensityPerHa: 15000,
  // ─── Vegetation zonation ──────────────────────────────────
  rimScrubFraction: 0.40,
  midSlopeWoodlandFraction: 0.35,
  riparianForestFraction: 0.25,
  // ─── Riparian trait ───────────────────────────────────────
  riparianRootDepthM: 4.0,          // phreatophytes reach deep water
  riparianBiomassMultiplier: 3.0
});

// ─── Fauna ──────────────────────────────────────────────────────
// Canyonlands fauna is adapted to heat, aridity, and vertical terrain:
// desert bighorn sheep, canyon wrens, ravens, rattlesnakes, jackrabbits, and
// in the American Southwest, the reintroduced California condor.
const FAUNA = Object.freeze({
  densityWeight: 0.30,
  habitatLayers: Object.freeze({
    cliff: 0.25,                    // cliff-nesting birds, bighorn
    bench: 0.25,
    canyonFloor: 0.30,
    aerial: 0.20
  }),
  dielActivity: 0.35,               // crepuscular and nocturnal
  migrationCorridorWeight: 0.30,
  predatorPreyBalance: 0.35,
  nectarAvailability: 0.10,
  pollenAvailability: 0.10,
  // Characteristic guild weights
  largeHerbivoreWeight: 0.15,       // bighorn sheep
  largePredatorWeight: 0.05,        // mountain lion
  smallMammalWeight: 0.30,          // jackrabbit, rock squirrel
  birdWeight: 0.30,                 // raptors, ravens, wrens
  reptileWeight: 0.15,              // rattlesnakes, lizards
  insectWeight: 0.05
});

// ─── Materials ──────────────────────────────────────────────────
// Full PBR + anime parameters for canyonlands surfaces: sandstone, shale,
// limestone, talus, rimrock, canyon scrub, pinyon-juniper, and the
// intermittent stream and pool water that anchors the riparian corridor.
const MATERIALS = Object.freeze({
  // ─── Red sandstone cliff face ───────────────────────────────
  redSandstone: Object.freeze({
    albedo: [0.42, 0.20, 0.10],     // deep red
    roughness: 0.90,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.15,
    animeFlatness: 0.45,
    acousticProfile: ACOUSTIC_PROFILE.ROCK,
    flammability: 0.0,
    hardness: 0.80,
    brittleness: 0.35,
    // ─── Sedimentary strata parameters ─────────────────────
    strataBands: 8,
    strataContrast: 0.35,
    crossBeddingScaleM: 2.5
  }),
  // ─── Shale / mudstone slope ─────────────────────────────────
  shaleSlope: Object.freeze({
    albedo: [0.32, 0.22, 0.16],     // greyish-red
    roughness: 0.95,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.30,           // holds moisture longer
    animeFlatness: 0.55,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.0,
    hardness: 0.20,
    brittleness: 0.85
  }),
  // ─── White / buff limestone bench ───────────────────────────
  limestoneBench: Object.freeze({
    albedo: [0.55, 0.50, 0.42],
    roughness: 0.80,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.10,
    animeFlatness: 0.45,
    acousticProfile: ACOUSTIC_PROFILE.ROCK,
    flammability: 0.0,
    hardness: 0.85,
    brittleness: 0.30
  }),
  // ─── Talus / scree slope ────────────────────────────────────
  talus: Object.freeze({
    albedo: [0.35, 0.25, 0.18],
    roughness: 0.92,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.15,
    animeFlatness: 0.50,
    acousticProfile: ACOUSTIC_PROFILE.ROCK,
    flammability: 0.0,
    hardness: 0.50,
    brittleness: 0.55,
    grainScaleM: 0.15
  }),
  // ─── Canyon-floor scrub ─────────────────────────────────────
  canyonScrub: Object.freeze({
    albedo: [0.30, 0.28, 0.15],     // dry sage-green
    roughness: 0.85,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.25,
    animeFlatness: 0.25,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.80,              // dry brush burns readily
    hardness: 0.15,
    brittleness: 0.85
  }),
  // ─── Pinyon-juniper woodland ────────────────────────────────
  pinyonJuniper: Object.freeze({
    albedo: [0.10, 0.15, 0.06],     // deep grey-green
    roughness: 0.82,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.03,
    emissive: 0.0,
    wetnessResponse: 0.30,
    animeFlatness: 0.25,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.70,
    hardness: 0.35,
    brittleness: 0.60
  }),
  // ─── Riparian cottonwood-willow ─────────────────────────────
  riparianCanopy: Object.freeze({
    albedo: [0.14, 0.22, 0.08],     // bright yellow-green
    roughness: 0.75,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.08,
    emissive: 0.0,
    wetnessResponse: 0.60,
    animeFlatness: 0.20,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.55,
    hardness: 0.25,
    brittleness: 0.70
  }),
  // ─── Intermittent stream / pool ────────────────────────────
  creekWater: Object.freeze({
    albedo: [0.15, 0.20, 0.15],     // greenish, silty
    roughness: 0.10,
    metalness: 0.0,
    transmission: 0.65,
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
      red: 0.90,
      green: 0.60,
      blue: 0.40
    })
  })
});

// ─── Lighting ───────────────────────────────────────────────────
// Canyonlands lighting is shaped by vertical walls that create sharp,
// high-contrast shadow patterns, by reflected light from the sunlit opposite
// wall, and by the enormous difference between sunlit rim and shadowed canyon
// floor.
const LIGHTING = Object.freeze({
  canopyOcclusion: 0.10,            // sparse canopy
  sunDiffuseFraction: 0.20,         // direct sun dominates
  sunIntensityScale: 1.35,          // intense desert sun
  colourCast: [1.00, 0.95, 0.85],   // warm, red-shifted from sandstone bounce
  atmosphericScatterBoost: 0.80,
  bioluminescentEmission: 0.00,
  dappledLightFrequency: 0.05,
  dappledLightAmplitude: 0.10,
  shadowSoftnessNear: 0.25,
  shadowSoftnessMid: 0.40,
  shadowSoftnessFar: 0.60,
  shadowCascadeScale: 1.0,
  snowAlbedoBoost: 0.0,
  fogDensityBase: 0.005,            // very clear
  skyTint: [0.80, 0.88, 0.98],      // deep blue sky
  // ─── Cliff bounce light ────────────────────────────────────
  // Sunlit sandstone walls bounce warm light into shaded areas.
  bounceLightColor: [0.95, 0.75, 0.55],
  bounceLightIntensity: 0.25,
  // ─── Shadow depth ──────────────────────────────────────────
  // The canyon floor can be 10–15 °C cooler than the rim.
  shadowTemperatureDropC: 12.0
});

// ─── Water ──────────────────────────────────────────────────────
// Water is scarce but concentrated: intermittent streams, seasonal floods,
// and permanent pools in the deepest canyon reaches anchor the riparian
// corridor. Groundwater is deep and recharged by occasional floods.
const WATER = Object.freeze({
  surfaceWaterPresence: 0.08,
  riverineNetworkDensity: 0.15,
  canopyDrip: 0.00,
  groundwaterTableDepthM: 20.0,
  freshwaterSpringPresence: 0.10,
  waterTableDepthM: 20.0,
  bogCoverage: 0.00,
  lakeCoverage: 0.01,               // small pools
  riverWidthMeanM: 3.0,
  waterTemperatureC: 16.0,
  iceCoverMonths: 0,
  shorelineMaterial: 'talus',
  // ─── Flash-flood hydrology ────────────────────────────────
  flashFloodPeakFlowM3s: 200.0,
  flashFloodDurationHours: 6.0,
  floodFrequencyYears: 3.0,
  // ─── Permanent pool parameters ────────────────────────────
  permanentPoolDensityPerKm: 0.5,
  poolDepthM: 2.0,
  // ─── Spring parameters ────────────────────────────────────
  springDischargeLpm: 20.0
});

// ─── Sensory ────────────────────────────────────────────────────
const SENSORY = Object.freeze({
  acoustic: Object.freeze({
    biological: 0.15,               // canyon wrens, ravens, insects
    geological: 0.25,               // rockfall, wind through canyon
    water: 0.10,                    // intermittent stream
    wind: 0.45,                     // wind funnelled through canyon
    vegetation: 0.05,
    mechanical: 0.00
  }),
  olfactory: Object.freeze({
    floral: 0.05,
    earthy: 0.30,                   // dry rock and sand
    aquatic: 0.05,
    woodland: 0.10,                 // pinyon-juniper resin
    smoke: 0.00,
    animal: 0.10,
    decay: 0.05,
    sulfur: 0.00,
    sea: 0.00,
    clean: 0.35                    // very clean, dry air
  }),
  tactile: Object.freeze({
    temperatureC: 22.0,
    humidity: 0.30,
    windPressurePa: 6.0,
    precipitationType: 'rain',
    groundHardness: 0.75
  })
});

// ─── Seasonality ────────────────────────────────────────────────
// Phenology is driven by the two-storm-season pattern: winter frontal storms
// and summer convective storms. Spring is the flowering window. Riparian
// vegetation greens up later than the rim.
const SEASONALITY = Object.freeze({
  phenologyOverrides: Object.freeze({
    budBreakDayOffset: 0,
    fullGreenDurationDays: 150,
    autumnColourShiftDays: 30,
    leafDropDurationDays: 20,
    bloomWindowDays: 60,
    sporeBoostWetSeason: 0.20,
    fungalBoostWetSeason: 0.15
  }),
  seasonalMaterialPalettes: Object.freeze({
    [SEASONAL_MATERIAL.SPRING_NEW_LEAF]: Object.freeze({
      pinyonJuniper: { albedo: [0.12, 0.18, 0.08], roughness: 0.80 },
      riparianCanopy: { albedo: [0.18, 0.28, 0.10], roughness: 0.72 }
    }),
    [SEASONAL_MATERIAL.SUMMER_FULL_GREEN]: Object.freeze({
      pinyonJuniper: { albedo: [0.10, 0.15, 0.06], roughness: 0.82 },
      canyonScrub: { albedo: [0.30, 0.28, 0.15], roughness: 0.85 }
    }),
    [SEASONAL_MATERIAL.AUTUMN_PEAK]: Object.freeze({
      riparianCanopy: { albedo: [0.42, 0.28, 0.08], roughness: 0.78 },
      canyonScrub: { albedo: [0.35, 0.25, 0.12], roughness: 0.87 }
    }),
    [SEASONAL_MATERIAL.WINTER_BARE_BRANCH]: Object.freeze({
      riparianCanopy: { albedo: [0.20, 0.16, 0.12], roughness: 0.85 },
      redSandstone: { albedo: [0.44, 0.22, 0.10], roughness: 0.90 },
      shaleSlope: { albedo: [0.32, 0.22, 0.16], roughness: 0.95 }
    })
  }),
  snowAccumulationRateMmHr: 0.5,
  snowMeltRateMmHr: 1.5,
  snowAlbedoSeasonal: 0.80
});

// ─── Procedural ─────────────────────────────────────────────────
const PROCEDURAL = Object.freeze({
  macroCliffNoiseScale: 300.0,      // canyon network
  midCliffNoiseScale: 50.0,         // individual cliff face and bench
  microRockNoiseScale: 8.0,         // lithology detail
  terraceNoiseScale: 80.0,          // bench and terrace patterning
  treeDensityPerHa: VEGETATION.treeDensityPerHa,
  shrubDensityPerHa: VEGETATION.shrubDensityPerHa,
  groundCoverDensityPerHa: VEGETATION.groundCoverDensityPerHa,
  lodHighDistance: 1000.0,
  lodMidDistance: 5000.0,
  lodLowDistance: 25000.0,
  maxFireEventsPerTick: 1,
  maxErosionEventsPerTick: 3,       // rockfall, freeze-thaw, flash-flood scour
  maxGrowthEventsPerTick: 2,
  // ─── Rockfall and cliff processes ─────────────────────────
  rockfallSlopeThresholdDeg: 40.0,
  rockfallRatePerYearPerKm2: 2.0,
  cliffRetreatRateMmPerYear: 5.0
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING ────────────────────────────────────────
// Canyonlands suitability is driven by high relief and steep slopes, deep
// incision (valley depth), a dry climate with flash-flood precipitation,
// rocky sandstone/shale/limestone substrate, and a narrow riparian corridor
// along intermittent streams. 328_BiomeBlendField uses this to decide how
// much of the canyonlands biome applies at any world point.
// ══════════════════════════════════════════════════════════════════
const _scratchVec3 = new Vec3();
const _scratchNoise = new SimplexNoise();

function getSuitability(env) {
  // ─── Temperature: continental desert with strong diurnal swing ─────
  const tempScore = smoothstep(-15.0, 5.0, env.temperatureC) * (1.0 - smoothstep(35.0, 45.0, env.temperatureC));

  // ─── Humidity: dry to semi-arid ────────────────────────────────────
  const humidityScore = smoothstep(0.10, 0.30, env.humidity) * (1.0 - smoothstep(0.50, 0.70, env.humidity));

  // ─── Elevation: plateau to canyon range ──────────────────────────
  const elevScore = smoothstep(600.0, 1000.0, env.elevationM) * (1.0 - smoothstep(2200.0, 3000.0, env.elevationM));

  // ─── Slope: steep is the defining trait, but with flat benches ──
  // Bimodal: high score at 20–45° (cliff faces and talus) and also at 0–5°
  // (benches and canyon floor). Low score at intermediate slopes.
  const steepScore = smoothstep(15.0, 30.0, env.slopeDeg) * (1.0 - smoothstep(70.0, 90.0, env.slopeDeg));
  const benchScore = 1.0 - smoothstep(5.0, 15.0, env.slopeDeg);
  const slopeScore = 0.65 * steepScore + 0.35 * benchScore;

  // ─── Substrate: sandy and rocky ──────────────────────────────────
  const textureScore =
    0.40 * smoothstep(0.35, 0.55, env.soilSand) +
    0.30 * smoothstep(0.10, 0.30, env.soilSilt) +
    0.30 * (1.0 - smoothstep(0.10, 0.25, env.soilClay));

  // ─── Water table: very deep except in the riparian corridor ──────
  const waterScore = smoothstep(5.0, 20.0, env.waterTableDepthM);

  // ─── Relief: high relief is the canyonland's calling card ──────
  // Proxied here by low absolute elevation variance in the env object; if
  // env exposes reliefRangeM (highest minus lowest in the chunk), use that.
  const reliefScore = env.reliefRangeM !== undefined
    ? smoothstep(150.0, 500.0, env.reliefRangeM)
    : 0.5;

  // ─── Patchiness ────────────────────────────────────────────────────
  const patchiness = env.noise !== undefined ? (0.80 + 0.20 * env.noise) : 1.0;

  // ─── Weighted fusion ────────────────────────────────────────────────
  const raw =
    0.15 * tempScore +
    0.15 * humidityScore +
    0.10 * elevScore +
    0.25 * slopeScore +
    0.15 * textureScore +
    0.05 * waterScore +
    0.15 * reliefScore;

  return Math.max(0.0, Math.min(1.0, raw * patchiness));
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR EXPORT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const CanyonlandsBiome = Object.freeze({
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

export default CanyonlandsBiome;