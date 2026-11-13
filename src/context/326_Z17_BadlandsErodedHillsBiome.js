// file number : 326_Z17
// full path name : src/context/326_Z17_BadlandsErodedHillsBiome.js
// description : Badlands eroded hills biome descriptor — the fourth and final
// arbitrary landscape biome that combines rock, valley, canyon, hill, lake,
// river, and vegetation features. This preset covers the deeply eroded
// badlands of the American West (White River Badlands of South Dakota,
// Theodore Roosevelt National Park in North Dakota, the Bisti/De-Na-Zin
// Wilderness in New Mexico), the Alberta badlands of Drumheller, and their
// global analogues (the Spanish Bardenas Reales, the Cappadocia badlands of
// Turkey, the Valle de la Luna in Argentina, and the Qeshm Island badlands of
// Iran). The defining drivers are soft, easily eroded sedimentary rock
// (mudstone, shale, siltstone, sandstone, bentonite) carved by intense but
// infrequent rainfall into a dense network of gullies, ridges, hoodoos,
// buttes, mesas, and steep-sided ravines; a dry climate with high sediment
// yield and flash-flood hydrology; minimal vegetation cover dominated by
// sparse desert scrub, bunchgrass, and drought-adapted forbs; and a
// distinctive stratified, banded appearance with alternating resistant and
// friable layers. Badlands are among the fastest-eroding landscapes on Earth
// (typical rates of 1–10 cm per year, with local peaks above 20 cm per year)
// and are therefore highly dynamic on human time scales. Provides the same
// eleven interlocking descriptor blocks as the base biomes, with full PBR +
// anime parameters for bentonite clay, mudstone, shale, sandstone, hoodoo
// caprock, gully alluvium, sparse desert scrub, and the ephemeral flash-flood
// channel water that briefly occupies the drainage network. The descriptor
// allocates nothing after construction and is consumed by the biome registry,
// blend field, material bridge, climate/soil/hydrology couplings, fauna
// migration system, chunk descriptor, and the full material/lighting/sensory
// pipeline.
//#
// best for : Every consumer that needs a badlands, eroded hills, hoodoo field,
// bentonite clay landscape, or dry badland gully biome preset — biome registry
// barrel (327), biome blend field (328), biome blend system (329), cross-biome
// ecotone (330), biome material bridge (331), biome climate coupling (332),
// biome soil coupling (333), biome hydrology coupling (334), biome fauna
// migration (335), landscape chunk descriptor (336), and the whole material/
// lighting/sensory pipeline. This preset is designed to remain seamless from
// the resistant caprock ridge through the friable slope and gully network to
// the ephemeral wash at the base, and to blend smoothly with the surrounding
// dry grassland and canyonland biomes.
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
import { NaturalFormationGradientProvider, FORMATION_TYPE } from './282_Z04_NaturalFormationGradientProvider.js';
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
const BIOME_ID = 26;
const BIOME_NAME = 'badlands_eroded_hills';
const BIOME_DISPLAY_NAME = 'Badlands / Eroded Hills';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── BADLANDS CHARACTERISTIC PARAMETERS ─────────────────────────
// ══════════════════════════════════════════════════════════════════
// ─── Climate ────────────────────────────────────────────────────
// Semi-arid to arid, continental. Rainfall is low on average but arrives in
// intense convective bursts, producing the flash floods that carve the
// badlands. Winters are cold; summers are hot and dry.
const CLIMATE = Object.freeze({
  // Temperature (°C) — continental
  temperatureMin: -25.0,            // cold winter
  temperatureMax: 40.0,             // hot, dry summer
  temperatureMean: 10.0,
  temperatureDailySwing: 18.0,      // large diurnal swing in dry air
  temperatureFrostFree: false,
  // Humidity (0..1) — dry
  humidityMin: 0.10,
  humidityMax: 0.65,
  humidityMean: 0.35,
  // Precipitation (mm/hr mean) — low mean, high storm intensity
  precipitationMean: 0.4,
  precipitationMax: 80.0,           // extreme convective burst
  precipitationStormProb: 0.08,
  precipitationAnnualMm: 350.0,
  // Seasons — cold winter, hot summer, wet spring/early summer
  seasonalityAmplitude: 0.85,
  drySeasonLengthDays: 200,
  wetSeasonPeakDay: 150,            // late spring / early summer
  snowSeasonDays: 60,
  growingSeasonDays: 150,
  // Wind — strong, dry, and erosive
  windMeanSpeed: 4.5,
  windMaxSpeed: 40.0,
  windPredominantDirDeg: 270,
  // Weather state probabilities (0..1)
  weatherProbClear: 0.50,
  weatherProbCloudy: 0.25,
  weatherProbRain: 0.10,
  weatherProbStorm: 0.10,
  weatherProbSnow: 0.05,
  weatherProbFog: 0.00,
  // Atmospheric
  pressureMeanKPa: 100.8,
  pressureSwingKPa: 2.5
});

// ─── Terrain Bias ────────────────────────────────────────────────
// Badlands are defined by high relief carved into soft rock: steep-sided
// hills, sharp ridges, knife-edge divides, hoodoos, and a dense dendritic
// gully network. Slope statistics are bimodal — very steep on the eroded
// faces and very flat on the resistant caprock remnants.
const TERRAIN = Object.freeze({
  elevationBand: ELEVATION_BAND.LOWLAND_TO_UPLAND,
  elevationMinM: 500.0,
  elevationMaxM: 1500.0,
  slopeMeanDeg: 20.0,               // very steep on eroded faces
  slopeMaxDeg: 75.0,                // hoodoos and knife-edge ridges
  roughness: 0.90,                  // extremely rugged
  valleyDepth: 0.85,                // deep gully incision
  valleyDensity: 0.85,              // very high drainage density
  plateauBias: 0.25,                // few flat surfaces remain
  groundwaterTableDepthM: 15.0,
  permafrostDepthM: Infinity,
  terrainRoughnessHint: 0.95,
  biomeHint: BIOME_HINT.BADLANDS,
  // ─── Badlands-specific geometry ─────────────────────────────
  hoodooDensityPerKm2: 50.0,
  butteDensityPerKm2: 5.0,
  mesaDensityPerKm2: 2.0,
  ridgeCrestDensityKmPerKm2: 8.0,
  gullyDensityKmPerKm2: 60.0,
  // ─── Erosion regime ─────────────────────────────────────────
  erosionRateMmPerYear: 20.0,        // 1–10 cm typical, 20+ cm peak
  caprockPresence: true,
  caprockHardness: 0.85
});

// ─── Soil ──────────────────────────────────────────────────────
// Badlands soils are thin, skeletal, and lithologically controlled. They
// include bentonite clay (which swells and cracks on wetting/drying),
// mudstone and shale fragments, sandstone, and gully alluvium. The soils
// are typically alkaline to neutral, low in organic matter, and highly
// erodible.
const SOIL = Object.freeze({
  textureClass: SOIL_TEXTURE_CLASS.CLAY_LOAM,
  visualArchetype: SOIL_VISUAL_ARCHETYPE.PALE_CALCAREOUS,
  // Primary fractions (0..1) — clay-rich, skeletal
  sand: 0.25,
  silt: 0.30,
  clay: 0.40,
  organicMatter: 0.02,
  gravel: 0.03,
  rockFragment: 0.00,
  // Chemistry — variable, often alkaline
  pH: 8.0,
  fertilityClass: FERTILITY_CLASS.BARREN,
  fertilityIndex: 0.10,
  // Physics
  porosity: 0.40,
  bulkDensityGcm3: 1.40,
  waterHoldingCapacity: 0.20,
  hydraulicConductivityMmHr: 0.5,    // very low for bentonite
  cohesionKPa: 1.0,                 // extremely weak, erodible
  plasticityIndex: 35.0,
  // Colour (linear RGB) — grey, buff, or banded
  baseAlbedo: [0.40, 0.36, 0.30],
  organicDarkening: 0.10,
  ironOxideRedness: 0.25,
  calciumPale: 0.40,
  // Erosion — very high
  usleKFactor: 0.65,                // extremely erodible
  windErodibility: 0.55,
  // ─── Bentonite parameters ─────────────────────────────────
  bentoniteFraction: 0.30,
  swellCapacity: 0.85,              // high shrink-swell potential
  // ─── Stratigraphy ─────────────────────────────────────────
  strataLayers: 12,
  strataContrast: 0.50,             // strong colour and hardness contrast
  caprockHardness: 0.85,
  softLayerHardness: 0.10,
  drainageClass: 'excessive'
});

// ─── Vegetation ─────────────────────────────────────────────────
// Badlands vegetation is sparse and patchy, restricted to the gentler
// slopes, the gully bottoms, and the pockets of soil trapped on the
// flats. Characteristic species are drought-adapted bunchgrass, sagebrush,
// rabbitbrush, and saltbush. Tree cover is essentially absent except along
// the larger washes and at the margins.
const VEGETATION = Object.freeze({
  treeTypeWeights: Object.freeze({
    [TREE_TYPE.PINE]: 0.50,       // juniper and pinyon along the margins
    [TREE_TYPE.OAK]: 0.30,        // scrub oak
    [TREE_TYPE.WILLOW]: 0.20      // wash margin only
  }),
  grassTypeWeights: Object.freeze({
    [GRASS_TYPE.SHORT_PRAIRIE]: 0.50,  // bunchgrass
    [GRASS_TYPE.THISTLE]: 0.25,        // forbs
    [GRASS_TYPE.MEADOW_GRASS]: 0.15,
    [GRASS_TYPE.SHORT_PRAIRIE]: 0.10
  }),
  verticalLayers: 1,                // grass and shrub layer only
  emergentDensity: 0.00,
  canopyDensity: 0.02,              // essentially no canopy
  understoryDensity: 0.10,
  groundCoverDensity: 0.20,         // very sparse
  epiphyteDensity: 0.00,
  lianaDensity: 0.00,
  successionTarget: SUCCESSION.PIONEER,
  fireRegimeYears: 25,              // fuel is sparse, fire is rare
  rootDepthM: 1.0,                  // shallow and wide
  canopyRadiusM: 0.0,
  trunkHeightM: 0.0,
  leafLitterDepthM: 0.01,
  bloomWindowDays: 30,              // short spring bloom
  // Poisson-disc targets per hectare — sparse by design
  treeDensityPerHa: 5,
  shrubDensityPerHa: 200,
  groundCoverDensityPerHa: 5000,
  // ─── Zonation fractions ──────────────────────────────────
  ridgeSparseFraction: 0.50,        // ridge tops and steep slopes, bare
  slopePatchyFraction: 0.30,        // patchy grass and shrub
  washMarginFraction: 0.20,         // denser vegetation in washes
  // ─── Adaptation traits ──────────────────────────────────
  droughtDeciduousFraction: 0.40,    // shrubs that drop leaves in the dry season
  saltTolerantFraction: 0.30        // saltbush and greasewood
});

// ─── Fauna ──────────────────────────────────────────────────────
// Badlands fauna is adapted to heat, aridity, and the sheer, unstable
// terrain: bighorn sheep on the ridges, pronghorn and mule deer on the
// flats, prairie rattlesnakes in the gullies, and raptors overhead. The
// fossil record of the White River Badlands is world-famous, but the
// living fauna is sparse and specialised.
const FAUNA = Object.freeze({
  densityWeight: 0.20,
  habitatLayers: Object.freeze({
    ridge: 0.25,                    // bighorn sheep
    slope: 0.20,
    flat: 0.35,                     // pronghorn, deer
    aerial: 0.20                    // raptors
  }),
  dielActivity: 0.35,               // crepuscular and nocturnal
  migrationCorridorWeight: 0.30,
  predatorPreyBalance: 0.30,
  nectarAvailability: 0.05,
  pollenAvailability: 0.05,
  // Characteristic guild weights
  largeHerbivoreWeight: 0.20,       // pronghorn, mule deer, bighorn
  largePredatorWeight: 0.05,        // mountain lion, coyote
  smallMammalWeight: 0.30,          // prairie dog, jackrabbit
  birdWeight: 0.25,                 // raptors, ravens
  reptileWeight: 0.15,              // rattlesnakes, lizards
  insectWeight: 0.05
});

// ─── Materials ──────────────────────────────────────────────────
// Full PBR + anime parameters for badlands surfaces: bentonite clay, mudstone,
// shale, sandstone, hoodoo caprock, gully alluvium, sparse desert scrub, and
// the ephemeral flash-flood channel water that briefly occupies the drainage
// network.
const MATERIALS = Object.freeze({
  // ─── Bentonite clay (grey, swelling, cracked) ──────────────
  bentoniteClay: Object.freeze({
    albedo: [0.42, 0.40, 0.38],     // grey, pale
    roughness: 0.75,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.90,           // dramatic change when wet
    animeFlatness: 0.45,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.0,
    hardness: 0.05,
    brittleness: 0.95,
    // ─── Swelling behaviour ─────────────────────────────────
    swellFactorDry: 1.0,
    swellFactorWet: 1.8,
    crackPatternDensity: 0.60
  }),
  // ─── Mudstone (red-brown, banded) ─────────────────────────
  mudstone: Object.freeze({
    albedo: [0.42, 0.28, 0.20],     // red-brown
    roughness: 0.88,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.40,
    animeFlatness: 0.50,
    acousticProfile: ACOUSTIC_PROFILE.ROCK,
    flammability: 0.0,
    hardness: 0.25,
    brittleness: 0.75,
    // ─── Strata banding ─────────────────────────────────────
    strataBands: 12,
    strataContrast: 0.50
  }),
  // ─── Shale (grey, friable) ─────────────────────────────────
  shale: Object.freeze({
    albedo: [0.30, 0.28, 0.26],     // grey
    roughness: 0.92,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.30,
    animeFlatness: 0.55,
    acousticProfile: ACOUSTIC_PROFILE.ROCK,
    flammability: 0.0,
    hardness: 0.20,
    brittleness: 0.85
  }),
  // ─── Caprock (resistant sandstone or limestone) ────────────
  caprock: Object.freeze({
    albedo: [0.55, 0.48, 0.38],     // buff, pale
    roughness: 0.80,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.15,
    animeFlatness: 0.45,
    acousticProfile: ACOUSTIC_PROFILE.ROCK,
    flammability: 0.0,
    hardness: 0.90,
    brittleness: 0.20
  }),
  // ─── Gully alluvium (flood deposit) ────────────────────────
  gullyAlluvium: Object.freeze({
    albedo: [0.35, 0.30, 0.24],
    roughness: 0.90,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.60,
    animeFlatness: 0.45,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.0,
    hardness: 0.10,
    brittleness: 0.90,
    grainScaleM: 0.20
  }),
  // ─── Sparse desert scrub ──────────────────────────────────
  desertScrub: Object.freeze({
    albedo: [0.30, 0.28, 0.16],     // sage-grey-green
    roughness: 0.85,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.03,
    emissive: 0.0,
    wetnessResponse: 0.20,
    animeFlatness: 0.28,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.75,
    hardness: 0.15,
    brittleness: 0.80
  }),
  // ─── Ephemeral wash water ──────────────────────────────────
  ephemeralWash: Object.freeze({
    albedo: [0.28, 0.20, 0.14],     // muddy, sediment-laden
    roughness: 0.15,
    metalness: 0.0,
    transmission: 0.40,
    ior: 1.333,
    fresnelF0: 0.02,
    subsurface: 0.10,
    emissive: 0.0,
    wetnessResponse: 1.0,
    animeFlatness: 0.15,
    acousticProfile: ACOUSTIC_PROFILE.WATER,
    flammability: 0.0,
    hardness: 0.0,
    brittleness: 1.0,
    attenuationKd: Object.freeze({
      red: 1.50,                    // very high sediment load
      green: 0.90,
      blue: 0.60
    }),
    suspendedSedimentMgL: 20000.0,  // extreme
    turbidityNTU: 2000.0
  })
});

// ─── Lighting ───────────────────────────────────────────────────
// Badlands lighting is intense and high-contrast: the dry, clean air
// produces sharp shadows, the pale rock surfaces have high albedo, and the
// banded strata create strong colour variation under different sun angles.
const LIGHTING = Object.freeze({
  canopyOcclusion: 0.00,            // no canopy
  sunDiffuseFraction: 0.20,         // direct sun dominates
  sunIntensityScale: 1.35,          // intense continental sun
  colourCast: [1.00, 0.96, 0.88],   // warm, slightly golden
  atmosphericScatterBoost: 0.70,    // clear, dry air
  bioluminescentEmission: 0.00,
  dappledLightFrequency: 0.00,
  dappledLightAmplitude: 0.00,
  shadowSoftnessNear: 0.20,
  shadowSoftnessMid: 0.35,
  shadowSoftnessFar: 0.55,
  shadowCascadeScale: 1.0,
  snowAlbedoBoost: 1.20,            // snow on pale rock
  fogDensityBase: 0.004,            // very clear
  skyTint: [0.82, 0.88, 0.98],      // deep blue sky
  // ─── Stratified rock bounce ───────────────────────────────
  bandBounceStrength: 0.20,
  // ─── High albedo of pale rock ────────────────────────────
  rockAlbedoBoost: 1.15
});

// ─── Water ──────────────────────────────────────────────────────
// Badlands water is ephemeral and erosive: the drainage network is dry most
// of the year, but flash floods briefly fill the channels with sediment-laden
// water. Permanent water is rare and confined to a few springs and small
// stock ponds.
const WATER = Object.freeze({
  surfaceWaterPresence: 0.02,       // ephemeral
  riverineNetworkDensity: 0.10,     // dense but dry most of the time
  canopyDrip: 0.00,
  groundwaterTableDepthM: 15.0,
  freshwaterSpringPresence: 0.02,
  waterTableDepthM: 15.0,
  bogCoverage: 0.00,
  lakeCoverage: 0.00,
  riverWidthMeanM: 2.0,
  waterTemperatureC: 15.0,
  iceCoverMonths: 0,
  shorelineMaterial: 'gullyAlluvium',
  // ─── Flash-flood hydrology ────────────────────────────────
  flashFloodPeakFlowM3s: 100.0,
  flashFloodDurationHours: 4.0,
  floodFrequencyYears: 2.0,
  // ─── Sediment yield ───────────────────────────────────────
  sedimentYieldTonnesPerKm2PerYear: 5000.0,
  suspendedSedimentMgL: 20000.0
});

// ─── Sensory ────────────────────────────────────────────────────
const SENSORY = Object.freeze({
  acoustic: Object.freeze({
    biological: 0.10,               // sparse birds and insects
    geological: 0.30,               // rockfall, clay cracking
    water: 0.05,                    // ephemeral streams
    wind: 0.45,                     // wind dominates
    vegetation: 0.05,
    mechanical: 0.00
  }),
  olfactory: Object.freeze({
    floral: 0.02,
    earthy: 0.35,                   // dry clay and dust
    aquatic: 0.00,
    woodland: 0.05,
    smoke: 0.00,
    animal: 0.05,
    decay: 0.05,
    sulfur: 0.00,
    sea: 0.00,
    clean: 0.45                    // very clean, dry air
  }),
  tactile: Object.freeze({
    temperatureC: 20.0,
    humidity: 0.30,
    windPressurePa: 6.0,
    precipitationType: 'rain',
    groundHardness: 0.65
  })
});

// ─── Seasonality ────────────────────────────────────────────────
// Badlands phenology is driven by the wet/dry cycle: a brief spring green
// flush, a dry summer dormancy, autumn senescence, and winter dormancy under
// snow. The vegetation responds quickly to rain events but remains sparse.
const SEASONALITY = Object.freeze({
  phenologyOverrides: Object.freeze({
    budBreakDayOffset: 0,
    fullGreenDurationDays: 60,      // very short
    autumnColourShiftDays: 25,
    leafDropDurationDays: 15,
    bloomWindowDays: 30,
    sporeBoostWetSeason: 0.10,
    fungalBoostWetSeason: 0.05
  }),
  seasonalMaterialPalettes: Object.freeze({
    [SEASONAL_MATERIAL.SPRING_NEW_LEAF]: Object.freeze({
      desertScrub: { albedo: [0.32, 0.32, 0.18], roughness: 0.82 },
      bentoniteClay: { albedo: [0.42, 0.40, 0.38], wetnessResponse: 0.70 }
    }),
    [SEASONAL_MATERIAL.SUMMER_FULL_GREEN]: Object.freeze({
      desertScrub: { albedo: [0.30, 0.28, 0.16], roughness: 0.85 },
      mudstone: { albedo: [0.42, 0.28, 0.20], roughness: 0.88 }
    }),
    [SEASONAL_MATERIAL.AUTUMN_PEAK]: Object.freeze({
      desertScrub: { albedo: [0.35, 0.28, 0.14], roughness: 0.87 },
      shale: { albedo: [0.32, 0.30, 0.28], roughness: 0.92 }
    }),
    [SEASONAL_MATERIAL.WINTER_BARE_BRANCH]: Object.freeze({
      desertScrub: { albedo: [0.30, 0.28, 0.18], roughness: 0.88 },
      bentoniteClay: { albedo: [0.44, 0.42, 0.40], wetnessResponse: 0.40 },
      caprock: { albedo: [0.55, 0.48, 0.38], roughness: 0.80 }
    })
  }),
  snowAccumulationRateMmHr: 1.0,
  snowMeltRateMmHr: 2.0,
  snowAlbedoSeasonal: 0.85
});

// ─── Procedural ─────────────────────────────────────────────────
const PROCEDURAL = Object.freeze({
  macroGullyNoiseScale: 200.0,      // drainage network
  midRidgeNoiseScale: 40.0,         // individual ridge, hoodoo, butte
  microClayNoiseScale: 5.0,         // clay crack and shale fragment detail
  strataNoiseScale: 60.0,           // banding pattern
  treeDensityPerHa: VEGETATION.treeDensityPerHa,
  shrubDensityPerHa: VEGETATION.shrubDensityPerHa,
  groundCoverDensityPerHa: VEGETATION.groundCoverDensityPerHa,
  lodHighDistance: 800.0,
  lodMidDistance: 4000.0,
  lodLowDistance: 20000.0,
  maxFireEventsPerTick: 0,          // fuel is too sparse
  maxErosionEventsPerTick: 3,       // very high erosion rate
  maxGrowthEventsPerTick: 2,
  // ─── Hoodoo formation parameters ──────────────────────────
  hoodooFormationRatePerYear: 0.5,
  hoodooCollapseRatePerYear: 0.10,
  // ─── Erosion parameters ───────────────────────────────────
  cliffRetreatRateMmPerYear: 20.0,
  gullyHeadcutRateMPerYear: 0.5,
  // ─── Flash-flood trigger ──────────────────────────────────
  flashFloodRainfallThresholdMmPerHour: 15.0
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING ────────────────────────────────────────
// Badlands suitability is driven by semi-arid to arid climate, soft
// erodible sedimentary rock, high relief, very high drainage density, thin
// skeletal soils, and sparse vegetation. 328_BiomeBlendField uses this to
// decide how much of the badlands biome applies at any world point.
// ══════════════════════════════════════════════════════════════════
const _scratchVec3 = new Vec3();
const _scratchNoise = new SimplexNoise();

function getSuitability(env) {
  // ─── Temperature: continental, avoids extreme cold and extreme heat ─
  const tempScore = smoothstep(-25.0, -5.0, env.temperatureC) * (1.0 - smoothstep(30.0, 42.0, env.temperatureC));

  // ─── Humidity: semi-arid to arid ──────────────────────────────────
  const humidityScore = smoothstep(0.10, 0.30, env.humidity) * (1.0 - smoothstep(0.55, 0.75, env.humidity));

  // ─── Elevation: lowland to upland ─────────────────────────────────
  const elevScore = smoothstep(300.0, 600.0, env.elevationM) * (1.0 - smoothstep(1400.0, 2200.0, env.elevationM));

  // ─── Slope: high slope is the master variable ────────────────────
  // Badlands are defined by steep eroded slopes, but with flat caprock tops.
  const slopeScore = smoothstep(10.0, 25.0, env.slopeDeg) * (1.0 - smoothstep(65.0, 85.0, env.slopeDeg));

  // ─── Substrate: clay-rich, soft rock, high erodibility ───────────
  const textureScore =
    0.45 * smoothstep(0.30, 0.50, env.soilClay) +
    0.30 * smoothstep(0.20, 0.40, env.soilSilt) +
    0.25 * (1.0 - smoothstep(0.25, 0.50, env.soilSand));

  // ─── Water table: deep ────────────────────────────────────────────
  const waterScore = smoothstep(8.0, 15.0, env.waterTableDepthM);

  // ─── Relief: high relief is a defining trait ────────────────────
  const reliefScore = env.reliefRangeM !== undefined
    ? smoothstep(100.0, 400.0, env.reliefRangeM)
    : 0.5;

  // ─── Patchiness ────────────────────────────────────────────────────
  const patchiness = env.noise !== undefined ? (0.80 + 0.20 * env.noise) : 1.0;

  // ─── Weighted fusion ────────────────────────────────────────────────
  const raw =
    0.15 * tempScore +
    0.20 * humidityScore +
    0.10 * elevScore +
    0.20 * slopeScore +
    0.15 * textureScore +
    0.08 * waterScore +
    0.12 * reliefScore;

  return Math.max(0.0, Math.min(1.0, raw * patchiness));
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR EXPORT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const BadlandsErodedHillsBiome = Object.freeze({
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

export default BadlandsErodedHillsBiome;