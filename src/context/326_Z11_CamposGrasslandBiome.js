// file number : 326_Z11
// full path name : src/context/326_Z11_CamposGrasslandBiome.js
// description : Campos grassland biome descriptor — the second of four
// additional grassland biome presets with a strong flowering-forb component.
// This preset covers the subtropical-to-temperate grasslands of the Río de la
// Plata region — southern Brazil (Rio Grande do Sul), all of Uruguay,
// northeastern Argentina (Corrientes, Entre Ríos), and southeastern Paraguay —
// a roughly 500,000 km² ecological region between 24°S and 35°S[reference:0][reference:1].
// The defining drivers are a subtropical-to-temperate climate with very marked
// seasonal fluctuations[reference:2], subhumid conditions in which summer
// potential evapotranspiration exceeds precipitation[reference:3], frosts in
// winter[reference:4], mean annual temperatures from 16.6 °C in southern Uruguay
// to 21.1 °C in northern Corrientes[reference:5], annual rainfall from 1,000 mm in
// southern Uruguay to 1,600 mm in the northern Campos[reference:6], and soils that
// are generally low in phosphorus[reference:7]. The vegetation is a grassland
// mosaic of tussock-grass and short-grass communities[reference:8], with a
// dominance of summer-growing C4 grasses and C3 grasses associated with the
// winter cycle[reference:9], and a flora dominated by Poaceae with Asteraceae and
// Fabaceae as the other most important families[reference:10]. Provides the same
// eleven interlocking descriptor blocks as the base biomes, with full PBR +
// anime parameters for tussock grass, short grass, C3 winter grass, flowering
// forbs (Asteraceae), legumes (Fabaceae), low-phosphorus soil, and seasonal
// frost. The descriptor allocates nothing after construction and is consumed by
// the biome registry, blend field, material bridge, climate/soil/hydrology
// couplings, fauna migration system, chunk descriptor, and the full material/
// lighting/sensory pipeline.
//#
// best for : Every consumer that needs a Campos, Río de la Plata grassland,
// Uruguayan campo, or southern Brazilian grassland biome preset — biome
// registry barrel (327), biome blend field (328), biome blend system (329),
// cross-biome ecotone (330), biome material bridge (331), biome climate
// coupling (332), biome soil coupling (333), biome hydrology coupling (334),
// biome fauna migration (335), landscape chunk descriptor (336), and the whole
// material/lighting/sensory pipeline. Together with the other grassland biome
// files this completes the planet-scale living-biome palette, and the Campos
// preset is the one that must remain seamless from the Flooding Pampa of
// 326_Z10 through the rolling Campos grassland into the Pampa interior.
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
const BIOME_ID = 20;
const BIOME_NAME = 'campos_grassland';
const BIOME_DISPLAY_NAME = 'Campos Grassland';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── CAMPOS CHARACTERISTIC PARAMETERS ───────────────────────────
// ══════════════════════════════════════════════════════════════════
// ─── Climate ────────────────────────────────────────────────────
// Subtropical to temperate with very marked seasonal fluctuations[reference:11].
// Very warm summers with frosts in winter[reference:12]. Subhumid in summer
// because potential evapotranspiration exceeds precipitation[reference:13],
// with moisture surplus in autumn and spring[reference:14].
const CLIMATE = Object.freeze({
  // Temperature (°C) — warm summer, frosty winter
  temperatureMin: -5.0,             // frosts in winter[reference:15]
  temperatureMax: 38.0,             // very warm summer
  temperatureMean: 18.5,            // 16.6–21.1 °C across the region[reference:16]
  temperatureDailySwing: 11.0,      // continental influence
  temperatureFrostFree: false,      // frost is a defining winter signal
  // Humidity (0..1) — subhumid in summer, humid in autumn and spring
  humidityMin: 0.50,
  humidityMax: 0.90,
  humidityMean: 0.68,
  // Precipitation (mm/hr mean) — 1,000–1,600 mm annually[reference:17]
  precipitationMean: 2.0,
  precipitationMax: 35.0,
  precipitationStormProb: 0.18,     // convective summer storms
  precipitationAnnualMm: 1300.0,    // mid-range of 1,000–1,600 mm
  // Seasons — very marked seasonal fluctuations[reference:18]
  seasonalityAmplitude: 0.70,
  drySeasonLengthDays: 0,           // no true dry season; summer moisture deficit
  wetSeasonPeakDay: 60,             // autumn precipitation peak[reference:19]
  snowSeasonDays: 0,                // snow is rare
  growingSeasonDays: 240,
  // Wind — moderate
  windMeanSpeed: 3.2,
  windMaxSpeed: 25.0,
  windPredominantDirDeg: 90,        // easterly influence from the Atlantic
  // Weather state probabilities (0..1)
  weatherProbClear: 0.35,
  weatherProbCloudy: 0.30,
  weatherProbRain: 0.20,
  weatherProbStorm: 0.10,
  weatherProbSnow: 0.00,
  weatherProbFog: 0.05,
  // Atmospheric
  pressureMeanKPa: 101.2,
  pressureSwingKPa: 2.5
});

// ─── Terrain Bias ────────────────────────────────────────────────
// The Campos occupies gently rolling to hilly terrain[reference:20][reference:21],
// with flat, undulating, or hilly landscapes[reference:22]. Local relief is
// moderate, and the terrain is not as flat as the Flooding Pampa.
const TERRAIN = Object.freeze({
  elevationBand: ELEVATION_BAND.LOWLAND_TO_HIGHLAND,
  elevationMinM: 0.0,
  elevationMaxM: 500.0,
  slopeMeanDeg: 3.0,                // gently rolling[reference:23]
  slopeMaxDeg: 15.0,                // hilly terrain[reference:24]
  roughness: 0.35,
  valleyDepth: 0.20,
  valleyDensity: 0.30,
  plateauBias: 0.70,
  groundwaterTableDepthM: 4.0,      // deeper than the Flooding Pampa
  permafrostDepthM: Infinity,
  terrainRoughnessHint: 0.30,
  biomeHint: BIOME_HINT.GRASSLAND
});

// ─── Soil ──────────────────────────────────────────────────────
// Campos soils are variable in fertility[reference:25] and generally low in
// phosphorus, which is a major limiting factor for forage quality and
// livestock production[reference:26]. They are typically moderately acidic,
// with low available phosphorus and moderate organic matter.
const SOIL = Object.freeze({
  textureClass: SOIL_TEXTURE_CLASS.SILTY_CLAY_LOAM,
  visualArchetype: SOIL_VISUAL_ARCHETYPE.BROWN_FOREST,
  // Primary fractions (0..1) — silty clay loam over basalt/loess
  sand: 0.25,
  silt: 0.40,
  clay: 0.30,
  organicMatter: 0.05,
  gravel: 0.00,
  rockFragment: 0.00,
  // Chemistry — low phosphorus is the defining limitation[reference:27]
  pH: 5.5,                          // moderately acidic
  fertilityClass: FERTILITY_CLASS.POOR,
  fertilityIndex: 0.35,
  // Physics
  porosity: 0.48,
  bulkDensityGcm3: 1.25,
  waterHoldingCapacity: 0.35,
  hydraulicConductivityMmHr: 4.0,
  cohesionKPa: 9.0,
  plasticityIndex: 20.0,
  // Colour (linear RGB) — brown to reddish-brown
  baseAlbedo: [0.22, 0.16, 0.12],
  organicDarkening: 0.50,
  ironOxideRedness: 0.35,           // basalt-derived soils
  calciumPale: 0.10,
  // Erosion
  usleKFactor: 0.25,
  windErodibility: 0.20,
  // ─── Phosphorus limitation parameters ─────────────────────
  availablePhosphorusMgKg: 4.0,      // low available P is a defining trait[reference:28]
  phosphorusFixation: 0.40,          // moderate P fixation by clay and Fe/Al oxides
  drainageClass: 'moderate'
});

// ─── Vegetation ─────────────────────────────────────────────────
// Campos vegetation is a grassland mosaic of tussock-grass and short-grass
// communities[reference:29], dominated by summer-growing C4 grasses with C3
// grasses associated with the winter cycle[reference:30]. The flora is dominated
// by Poaceae (grasses), with Asteraceae (forbs) and Fabaceae (legumes) as the
// other most important families[reference:31]. Characteristic grass genera
// include Andropogon, Aristida, Briza, Erianthus, Piptochaetium, Poa, Stipa,
// Paspalum, and Panicum[reference:32]. Species richness is high: the Pampas
// subregion alone has about 1,000 vascular plant species, of which 230 are
// grasses (190 native, 40 introduced)[reference:33].
const VEGETATION = Object.freeze({
  treeTypeWeights: Object.freeze({
    [TREE_TYPE.WILLOW]: 0.50,      // riparian only[reference:34]
    [TREE_TYPE.OAK]: 0.30,
    [TREE_TYPE.PINE]: 0.20         // rare, in hilly pockets
  }),
  grassTypeWeights: Object.freeze({
    [GRASS_TYPE.TALL_PRAIRIE]: 0.30,   // tussock grasses[reference:35]
    [GRASS_TYPE.SHORT_PRAIRIE]: 0.30,  // short-grass communities[reference:36]
    [GRASS_TYPE.SAVANNA_BUNCH]: 0.20,  // C4 bunchgrasses
    [GRASS_TYPE.MEADOW_GRASS]: 0.15,   // C3 winter grasses
    [GRASS_TYPE.THISTLE]: 0.05         // Asteraceae forbs
  }),
  verticalLayers: 1,                // grass and forb layer
  emergentDensity: 0.00,
  canopyDensity: 0.00,
  understoryDensity: 0.00,
  groundCoverDensity: 0.85,         // near-total grass and forb cover
  epiphyteDensity: 0.00,
  lianaDensity: 0.00,
  successionTarget: SUCCESSION.CLIMAX,
  fireRegimeYears: 150,             // fire is rare in humid grassland
  rootDepthM: 1.8,
  canopyRadiusM: 0.0,
  trunkHeightM: 0.0,
  leafLitterDepthM: 0.05,
  bloomWindowDays: 120,
  // Poisson-disc targets per hectare
  treeDensityPerHa: 0,
  shrubDensityPerHa: 40,
  groundCoverDensityPerHa: 80000,
  // ─── C3/C4 composition ────────────────────────────────────
  c4SummerGrassFraction: 0.55,      // dominance of summer C4[reference:37]
  c3WinterGrassFraction: 0.35,      // C3 associated with winter cycle[reference:38]
  // ─── Forb and flowering parameters ─────────────────────────
  forbRichness: 0.45,               // Asteraceae and Fabaceae are prominent[reference:39]
  floweringForbFraction: 0.40,
  legumeFraction: 0.15,             // Fabaceae legumes[reference:40]
  tussockGrassFraction: 0.50,       // tussock grasses are a major component[reference:41]
  shortGrassFraction: 0.50
});

// ─── Fauna ──────────────────────────────────────────────────────
const FAUNA = Object.freeze({
  densityWeight: 0.55,
  habitatLayers: Object.freeze({
    ground: 0.60,                   // grassland birds, small mammals
    understory: 0.15,
    canopy: 0.00,
    aerial: 0.15,
    water: 0.10                    // riparian and wetland margins
  }),
  dielActivity: 0.40,
  migrationCorridorWeight: 0.60,    // wintering grounds for Nearctic migrants[reference:42]
  predatorPreyBalance: 0.45,
  nectarAvailability: 0.20,         // Asteraceae and Fabaceae forbs
  pollenAvailability: 0.20,
  // Characteristic guild weights
  largeHerbivoreWeight: 0.25,       // cattle, deer
  smallMammalWeight: 0.30,
  birdWeight: 0.30,                 // grassland birds are a major guild[reference:43]
  insectWeight: 0.10,
  amphibianWeight: 0.05
});

// ─── Materials ──────────────────────────────────────────────────
// Full PBR + anime parameters for Campos surfaces: tussock grass, short grass,
// C3 winter grass, flowering forbs (Asteraceae), legumes (Fabaceae), and
// low-phosphorus soil.
const MATERIALS = Object.freeze({
  // ─── Tussock grass ──────────────────────────────────────────
  tussockGrass: Object.freeze({
    albedo: [0.18, 0.22, 0.10],
    roughness: 0.80,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.50,
    animeFlatness: 0.22,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.65,
    hardness: 0.15,
    brittleness: 0.80
  }),
  // ─── Short grass ────────────────────────────────────────────
  shortGrass: Object.freeze({
    albedo: [0.22, 0.26, 0.12],
    roughness: 0.82,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.03,
    emissive: 0.0,
    wetnessResponse: 0.40,
    animeFlatness: 0.25,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.70,
    hardness: 0.12,
    brittleness: 0.85
  }),
  // ─── C3 winter grass ────────────────────────────────────────
  c3WinterGrass: Object.freeze({
    albedo: [0.16, 0.24, 0.08],     // cooler green, winter-active
    roughness: 0.78,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.55,
    animeFlatness: 0.20,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.55,
    hardness: 0.10,
    brittleness: 0.88
  }),
  // ─── Asteraceae flowering forb ───────────────────────────────
  asteraceaeForb: Object.freeze({
    albedo: [0.24, 0.22, 0.10],     // green with floral accent
    roughness: 0.75,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.45,
    animeFlatness: 0.18,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.60,
    hardness: 0.10,
    brittleness: 0.85
  }),
  // ─── Fabaceae legume ────────────────────────────────────────
  fabaceaeLegume: Object.freeze({
    albedo: [0.14, 0.20, 0.08],
    roughness: 0.78,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.50,
    animeFlatness: 0.20,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.50,
    hardness: 0.10,
    brittleness: 0.88
  }),
  // ─── Low-phosphorus soil ────────────────────────────────────
  camposSoil: Object.freeze({
    albedo: [0.22, 0.16, 0.12],
    roughness: 0.90,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.50,
    animeFlatness: 0.45,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.05,
    hardness: 0.30,
    brittleness: 0.65
  })
});

// ─── Lighting ───────────────────────────────────────────────────
const LIGHTING = Object.freeze({
  canopyOcclusion: 0.00,
  sunDiffuseFraction: 0.40,
  sunIntensityScale: 1.10,
  colourCast: [1.00, 0.98, 0.92],
  atmosphericScatterBoost: 1.05,
  bioluminescentEmission: 0.00,
  dappledLightFrequency: 0.00,
  dappledLightAmplitude: 0.00,
  shadowSoftnessNear: 0.4,
  shadowSoftnessMid: 0.6,
  shadowSoftnessFar: 0.8,
  shadowCascadeScale: 1.0,
  snowAlbedoBoost: 0.0,
  fogDensityBase: 0.012,
  skyTint: [0.85, 0.90, 0.98],
  skyViewFactor: 0.98
});

// ─── Water ──────────────────────────────────────────────────────
// Water is available but less dominant than in the Flooding Pampa. Streams
// are present, and riparian forest patches occur along watercourses[reference:44].
const WATER = Object.freeze({
  surfaceWaterPresence: 0.12,
  riverineNetworkDensity: 0.25,
  canopyDrip: 0.05,
  groundwaterTableDepthM: 4.0,
  freshwaterSpringPresence: 0.10,
  waterTableDepthM: 4.0,
  bogCoverage: 0.05,
  lakeCoverage: 0.03,
  riverWidthMeanM: 4.0,
  waterTemperatureC: 18.0,
  iceCoverMonths: 0,
  shorelineMaterial: 'camposSoil'
});

// ─── Sensory ────────────────────────────────────────────────────
const SENSORY = Object.freeze({
  acoustic: Object.freeze({
    biological: 0.30,               // grassland birds, insects
    geological: 0.00,
    water: 0.15,                    // streams
    wind: 0.35,                     // wind through grass dominates
    vegetation: 0.20,
    mechanical: 0.00
  }),
  olfactory: Object.freeze({
    floral: 0.20,                   // Asteraceae and Fabaceae
    earthy: 0.30,
    aquatic: 0.05,
    woodland: 0.05,
    smoke: 0.05,
    animal: 0.10,
    decay: 0.10,
    sulfur: 0.00,
    sea: 0.05,
    clean: 0.10
  }),
  tactile: Object.freeze({
    temperatureC: 18.5,
    humidity: 0.68,
    windPressurePa: 4.0,
    precipitationType: 'rain',
    groundHardness: 0.50
  })
});

// ─── Seasonality ────────────────────────────────────────────────
// Phenology follows the subtropical-to-temperate seasonal cycle: spring
// growth, summer C4 dominance, autumn moisture surplus, and winter frost
// dormancy with C3 grass activity.
const SEASONALITY = Object.freeze({
  phenologyOverrides: Object.freeze({
    budBreakDayOffset: 0,
    fullGreenDurationDays: 180,
    autumnColourShiftDays: 25,
    leafDropDurationDays: 15,
    bloomWindowDays: 120,
    sporeBoostWetSeason: 0.20,
    fungalBoostWetSeason: 0.15
  }),
  seasonalMaterialPalettes: Object.freeze({
    [SEASONAL_MATERIAL.SPRING_NEW_LEAF]: Object.freeze({
      tussockGrass: { albedo: [0.20, 0.26, 0.12], roughness: 0.78 },
      asteraceaeForb: { albedo: [0.24, 0.26, 0.12], roughness: 0.73 }
    }),
    [SEASONAL_MATERIAL.SUMMER_FULL_GREEN]: Object.freeze({
      tussockGrass: { albedo: [0.18, 0.22, 0.10], roughness: 0.80 },
      shortGrass: { albedo: [0.22, 0.26, 0.12], roughness: 0.82 }
    }),
    [SEASONAL_MATERIAL.AUTUMN_PEAK]: Object.freeze({
      tussockGrass: { albedo: [0.28, 0.24, 0.12], roughness: 0.84 },
      c3WinterGrass: { albedo: [0.18, 0.24, 0.10], roughness: 0.76 }
    }),
    [SEASONAL_MATERIAL.WINTER_BARE_BRANCH]: Object.freeze({
      tussockGrass: { albedo: [0.30, 0.28, 0.20], roughness: 0.86 },
      c3WinterGrass: { albedo: [0.20, 0.26, 0.12], roughness: 0.78 },
      camposSoil: { albedo: [0.24, 0.18, 0.14], wetnessResponse: 0.30 }
    })
  }),
  snowAccumulationRateMmHr: 0.0,
  snowMeltRateMmHr: 0.0,
  snowAlbedoSeasonal: 0.0
});

// ─── Procedural ─────────────────────────────────────────────────
const PROCEDURAL = Object.freeze({
  macroGrassNoiseScale: 100.0,      // tussock vs. short-grass mosaics
  midGrassNoiseScale: 25.0,         // patch and forb clump detail
  microGrassNoiseScale: 5.0,        // individual plant detail
  terrainNoiseScale: 150.0,
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
// Campos suitability is driven by subtropical-to-temperate temperature
// (16–21 °C mean), moderate humidity, gently rolling terrain, low-phosphorus
// silty clay loam soil, and low-to-mid elevation. 328_BiomeBlendField uses
// this to decide how much of the Campos biome applies at any world point.
// ══════════════════════════════════════════════════════════════════
const _scratchVec3 = new Vec3();
const _scratchNoise = new SimplexNoise();

function getSuitability(env) {
  // ─── Temperature: subtropical to temperate, warm summer, frosty winter ─
  const tempScore = smoothstep(5.0, 12.0, env.temperatureC) * (1.0 - smoothstep(30.0, 40.0, env.temperatureC));

  // ─── Humidity: subhumid to humid ──────────────────────────────────
  const humidityScore = smoothstep(0.50, 0.70, env.humidity) * (1.0 - smoothstep(0.85, 0.95, env.humidity));

  // ─── Elevation: lowland to mid-elevation ──────────────────────────
  const elevScore = smoothstep(0.0, 100.0, env.elevationM) * (1.0 - smoothstep(400.0, 800.0, env.elevationM));

  // ─── Slope: gently rolling to hilly ──────────────────────────────
  const slopeScore = smoothstep(0.0, 1.0, env.slopeDeg) * (1.0 - smoothstep(10.0, 20.0, env.slopeDeg));

  // ─── Soil texture: silty clay loam is typical ─────────────────────
  const textureScore =
    0.40 * smoothstep(0.30, 0.50, env.soilSilt) +
    0.35 * smoothstep(0.20, 0.40, env.soilClay) +
    0.25 * (1.0 - smoothstep(0.15, 0.35, env.soilSand));

  // ─── Water table: moderate depth ──────────────────────────────────
  const waterScore = smoothstep(2.0, 5.0, env.waterTableDepthM) * (1.0 - smoothstep(10.0, 20.0, env.waterTableDepthM));

  // ─── Patchiness ────────────────────────────────────────────────────
  const patchiness = env.noise !== undefined ? (0.85 + 0.15 * env.noise) : 1.0;

  // ─── Weighted fusion ────────────────────────────────────────────────
  const raw =
    0.28 * tempScore +
    0.18 * humidityScore +
    0.12 * elevScore +
    0.15 * slopeScore +
    0.15 * textureScore +
    0.12 * waterScore;

  return Math.max(0.0, Math.min(1.0, raw * patchiness));
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR EXPORT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const CamposGrasslandBiome = Object.freeze({
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

export default CamposGrasslandBiome;