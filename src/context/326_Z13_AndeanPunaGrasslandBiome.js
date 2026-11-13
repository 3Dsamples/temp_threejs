// file number : 326_Z13
// full path name : src/context/326_Z13_AndeanPunaGrasslandBiome.js
// description : Andean Puna grassland biome descriptor — the fourth and final
// of four additional grassland biome presets with a strong flowering-forb
// component. This preset covers the high-elevation montane grasslands of the
// central Andes — southern Peru, western Bolivia, northern Chile, and
// northwestern Argentina — occupying the altitudinal belt between the
// tree-line and the permanent snow-line, typically 3,200–5,200 m (overall
// range 3,200–6,600 m). The defining drivers are extreme altitude,
// oligothermic temperatures (mean annual <0 to 15 °C, with <10 °C over most
// of the belt), marked diurnal temperature fluctuations (up to 20 °C in the
// mesic Altiplano and even greater in the dry Altiplano), nocturnal frosts,
// a pronounced dry season (May–September) alternating with a wet season
// (October–April, with 75 % of precipitation falling November–March), low and
// variable annual precipitation (250–500 mm in the central puna, <400 mm in
// the dry puna), thin air with limited oxygen, intense UV radiation, and soils
// that are acidic (pH 4–5 in upper horizons) and organic-rich (2.44–15.24 %)
// with high CEC. The vegetation is dominated by perennial bunchgrasses of the
// genera Festuca, Calamagrostis, Stipa, and Poa, with sedges (Carex, Scirpus)
// in wetter microsites, and a distinctive flora of prostrate cushion plants
// (Azorella, Pycnophyllum) and rosette herbs. Bofedales — permanently
// saturated high-altitude wetlands — are critical azonal forage islands.
// Provides the same eleven interlocking descriptor blocks as the base biomes,
// with full PBR + anime parameters for ichu bunchgrass, cushion plant, tola
// shrub, bofedal wetland, volcanic soil, and the distinctive cold, clear,
// high-altitude light. The descriptor allocates nothing after construction and
// is consumed by the biome registry, blend field, material bridge, climate/soil/
// hydrology couplings, fauna migration system, chunk descriptor, and the full
// material/lighting/sensory pipeline.
//#
// best for : Every consumer that needs an Andean Puna, high-altitude grassland,
// tropical alpine grassland, or puna/páramo biome preset — biome registry barrel
// (327), biome blend field (328), biome blend system (329), cross-biome ecotone
// (330), biome material bridge (331), biome climate coupling (332), biome soil
// coupling (333), biome hydrology coupling (334), biome fauna migration (335),
// landscape chunk descriptor (336), and the whole material/lighting/sensory
// pipeline. Together with the other grassland biome files this completes the
// planet-scale living-biome palette, and the Andean Puna preset is the one that
// must remain seamless from the wet puna through the dry puna to the salt-flat
// and snow-line margins, and from the bunchgrass pajonal through the cushion-
// plant community into the bofedal wetland mosaic.
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
const BIOME_ID = 22;
const BIOME_NAME = 'andean_puna_grassland';
const BIOME_DISPLAY_NAME = 'Andean Puna Grassland';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── ANDEAN PUNA CHARACTERISTIC PARAMETERS ──────────────────────
// ══════════════════════════════════════════════════════════════════
// ─── Climate ────────────────────────────────────────────────────
// Oligothermic, dry, and strongly seasonal. Mean annual temperature is <10 °C
// over most of the belt, with the central puna ranging <0–15 °C. Nocturnal
// frosts are common, especially in the dry season. Diurnal fluctuations can
// reach 20 °C in the mesic Altiplano and more in the dry Altiplano.
// Precipitation is 250–500 mm/year in the central puna and <400 mm/year in the
// dry puna, concentrated in the wet season (October–April).
const CLIMATE = Object.freeze({
  // Temperature (°C) — cold, with extreme diurnal swing
  temperatureMin: -15.0,            // severe nocturnal frost in the dry season
  temperatureMax: 20.0,             // warm midday sun at altitude
  temperatureMean: 6.0,             // <10 °C mean annual, central puna <0–15 °C
  temperatureDailySwing: 20.0,      // up to 20 °C in the mesic Altiplano
  temperatureFrostFree: false,       // nocturnal frost is the defining signal
  // Lapse rate used by the temperature provider to correct sea-level reference
  lapseRateKPerKm: 6.5,
  // Humidity (0..1) — dry, thin air
  humidityMin: 0.20,
  humidityMax: 0.70,
  humidityMean: 0.45,
  // Precipitation (mm/hr mean) — 250–500 mm/year in the central puna
  precipitationMean: 0.6,
  precipitationMax: 15.0,
  precipitationStormProb: 0.10,
  precipitationAnnualMm: 400.0,     // mid-range of 250–500 mm
  // Seasons — two marked periods
  seasonalityAmplitude: 0.65,
  drySeasonLengthDays: 150,         // May–September (5 months)
  wetSeasonPeakDay: 30,             // November–March
  snowSeasonDays: 60,               // snow possible at high elevations
  growingSeasonDays: 120,           // short growing season (December–March)
  // Wind — strong, dry, and persistent
  windMeanSpeed: 5.0,
  windMaxSpeed: 35.0,
  windPredominantDirDeg: 270,      // westerly, dry
  // Weather state probabilities (0..1)
  weatherProbClear: 0.50,           // clear, dry-season skies
  weatherProbCloudy: 0.20,
  weatherProbRain: 0.10,
  weatherProbStorm: 0.05,
  weatherProbSnow: 0.10,
  weatherProbFog: 0.05,
  // Atmospheric — pressure is much lower than at sea level
  pressureMeanKPa: 65.0,            // ~65 kPa at 3,500 m
  pressureSwingKPa: 1.5,
  // Partial pressure of oxygen at 3,500 m is ~13.5 kPa vs 21.2 kPa at sea level
  seaLevelPO2KPa: 21.2
});

// ─── Terrain Bias ────────────────────────────────────────────────
// The puna is a high-elevation montane grassland with snow-capped peaks,
// mountain pastures, high lakes, plateaus, and valleys. The landscape is
// mountainous but includes extensive flat or gently rolling plateau surfaces.
const TERRAIN = Object.freeze({
  elevationBand: ELEVATION_BAND.ALPINE,
  elevationMinM: 3200.0,
  elevationMaxM: 5200.0,            // typical puna belt; 6,600 m overall range
  slopeMeanDeg: 8.0,
  slopeMaxDeg: 45.0,
  roughness: 0.60,
  valleyDepth: 0.40,
  valleyDensity: 0.45,
  plateauBias: 0.50,                // extensive Altiplano plateaus
  groundwaterTableDepthM: 2.0,
  permafrostDepthM: 3.0,            // patchy alpine permafrost
  terrainRoughnessHint: 0.65,
  biomeHint: BIOME_HINT.ALPINE_GRASSLAND,
  // Snow-line elevation range for this biome
  snowlineMinM: 4500.0,
  snowlineMaxM: 6000.0
});

// ─── Soil ──────────────────────────────────────────────────────
// Puna soils are acidic (pH 4–5 in upper horizons), organic-rich (2.44–15.24 %
// organic matter), with high CEC attributed to organic matter or amorphous
// clays from volcanic ash. They are generally poor in available nutrients and
// often skeletal or volcanic in origin.
const SOIL = Object.freeze({
  textureClass: SOIL_TEXTURE_CLASS.SILTY_CLAY_LOAM,
  visualArchetype: SOIL_VISUAL_ARCHETYPE.VOLCANIC_BLACK,
  // Primary fractions (0..1) — silty loam with volcanic influence
  sand: 0.25,
  silt: 0.40,
  clay: 0.20,
  organicMatter: 0.10,              // 2.44–15.24 %; high end is peat-like
  gravel: 0.05,
  rockFragment: 0.00,
  // Chemistry — acidic
  pH: 4.8,                          // 4–5 in upper horizons
  fertilityClass: FERTILITY_CLASS.POOR,
  fertilityIndex: 0.25,
  // Physics
  porosity: 0.55,
  bulkDensityGcm3: 1.00,            // low, organic-rich
  waterHoldingCapacity: 0.40,
  hydraulicConductivityMmHr: 2.0,
  cohesionKPa: 5.0,
  plasticityIndex: 15.0,
  // Colour (linear RGB) — dark volcanic
  baseAlbedo: [0.14, 0.12, 0.10],
  organicDarkening: 0.70,
  ironOxideRedness: 0.15,
  calciumPale: 0.05,
  // Erosion — wind and frost are the dominant agents
  usleKFactor: 0.20,
  windErodibility: 0.50,
  // ─── Volcanic and organic parameters ───────────────────────
  volcanicAshFraction: 0.30,        // amorphous clays from ash falls
  cationExchangeCapacityCmolPerKg: 30.0, // high CEC from organic matter
  drainageClass: 'moderate'
});

// ─── Vegetation ─────────────────────────────────────────────────
// Puna vegetation is dominated by perennial bunchgrasses (pajonal) of Festuca,
// Calamagrostis, Stipa, and Poa, with sedges (Carex, Scirpus) in wetter
// microsites. A distinctive flora of prostrate cushion plants (Azorella,
// Pycnophyllum) and rosette herbs occupies exposed rocky ground. Tola shrubs
// (Parastrephia lepidophylla) form local thickets. Bofedales — permanently
// saturated high-altitude wetlands — are critical azonal forage islands.
const VEGETATION = Object.freeze({
  treeTypeWeights: Object.freeze({
    [TREE_TYPE.PINE]: 0.50,       // substitute for Polylepis (queñoa) relicts
    [TREE_TYPE.BIRCH]: 0.50       // substitute for Buddleia / Escallonia relicts
  }),
  grassTypeWeights: Object.freeze({
    [GRASS_TYPE.TUNDRA_TUFT]: 0.40,   // ichu bunchgrass (Stipa ichu)
    [GRASS_TYPE.ALPINE_TUFT]: 0.30,   // Festuca, Calamagrostis, Poa
    [GRASS_TYPE.MARSH_REED]: 0.20,    // bofedal sedges and rushes
    [GRASS_TYPE.SHORT_PRAIRIE]: 0.10
  }),
  verticalLayers: 2,                // bunchgrass layer + cushion/rosette layer
  emergentDensity: 0.00,
  canopyDensity: 0.00,              // no tree canopy in the open puna
  understoryDensity: 0.20,          // tola shrub thickets are local
  groundCoverDensity: 0.55,         // patchy bunchgrass and cushion cover
  epiphyteDensity: 0.05,
  lianaDensity: 0.00,
  successionTarget: SUCCESSION.CLIMAX,
  fireRegimeYears: 50,              // fire is rare but occurs
  rootDepthM: 0.6,                  // shallow, constrained by cold and frost
  canopyRadiusM: 0.0,
  trunkHeightM: 0.0,
  leafLitterDepthM: 0.03,
  bloomWindowDays: 60,              // short wet-season bloom
  // Poisson-disc targets per hectare — calibrated from puna biomass literature
  treeDensityPerHa: 5,              // rare Polylepis relicts
  shrubDensityPerHa: 200,           // tola thickets
  groundCoverDensityPerHa: 40000,
  // ─── Bunchgrass and cushion-plant parameters ───────────────
  bunchgrassFraction: 0.60,         // pajonal is the dominant formation
  cushionPlantFraction: 0.25,       // Azorella, Pycnophyllum
  rosetteHerbFraction: 0.15,
  // ─── Bofedal wetland fraction ──────────────────────────────
  bofedalCoverageFraction: 0.10,    // azonal, but ecologically critical
  // ─── Biomass and productivity ──────────────────────────────
  abovegroundBiomassMgPerHa: 6.7,   // 6.7 ± 0.2 Mg ha⁻¹
  anppDenseGrassKgDMPerHaYear: 3900, // dense grass steppe
  anppSparseShrubKgDMPerHaYear: 472, // sparse shrub steppe
  // ─── Adaptation traits ─────────────────────────────────────
  leafAdaptation: 'small, hard, resinous', // reduces water loss and frost damage
  growthRate: 'very slow',
  resinContent: 0.25,               // high resin content
  siliconContent: 0.10              // silica in grass leaves deters herbivory
});

// ─── Fauna ──────────────────────────────────────────────────────
// Puna fauna is highly adapted to altitude and cold: Andean camelids (vicuña,
// llama, alpaca, guanaco), the Andean condor, mountain cats, and a rich
// community of high-altitude rodents and birds.
const FAUNA = Object.freeze({
  densityWeight: 0.40,
  habitatLayers: Object.freeze({
    ground: 0.60,                   // camelids, rodents, ground birds
    understory: 0.10,               // tola shrub thickets
    canopy: 0.00,                   // no canopy
    aerial: 0.30                    // condors, raptors
  }),
  dielActivity: 0.55,               // diurnal, with midday siesta at high altitude
  migrationCorridorWeight: 0.50,    // altitudinal migration
  predatorPreyBalance: 0.40,
  nectarAvailability: 0.05,
  pollenAvailability: 0.05,
  // Characteristic guild weights
  largeHerbivoreWeight: 0.35,       // vicuña, llama, alpaca, guanaco
  largePredatorWeight: 0.10,        // puma, Andean cat
  smallMammalWeight: 0.25,          // viscacha, chinchilla
  birdWeight: 0.25,                 // condor, flamingo, ground tyrants
  insectWeight: 0.05,
  // Altitudinal migration band (metres) below/above the puna belt
  altitudinalMigrationBandM: 800.0
});

// ─── Materials ──────────────────────────────────────────────────
// Full PBR + anime parameters for Andean Puna surfaces: ichu bunchgrass,
// cushion plant, tola shrub, bofedal wetland, volcanic soil, and the
// distinctive cold, clear, high-altitude light.
const MATERIALS = Object.freeze({
  // ─── Ichu bunchgrass (Stipa ichu) ───────────────────────────
  ichuBunchgrass: Object.freeze({
    albedo: [0.28, 0.26, 0.16],     // pale straw, frost-bleached
    roughness: 0.88,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.03,
    emissive: 0.0,
    wetnessResponse: 0.20,
    animeFlatness: 0.28,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.75,
    hardness: 0.12,
    brittleness: 0.85
  }),
  // ─── Cushion plant (Azorella / Pycnophyllum) ────────────────
  cushionPlant: Object.freeze({
    albedo: [0.18, 0.22, 0.12],     // olive-green, dense
    roughness: 0.80,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.08,                // dense mat buffers temperature
    emissive: 0.0,
    wetnessResponse: 0.30,
    animeFlatness: 0.22,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.40,
    hardness: 0.20,
    brittleness: 0.70
  }),
  // ─── Tola shrub (Parastrephia lepidophylla) ─────────────────
  tolaShrub: Object.freeze({
    albedo: [0.20, 0.18, 0.10],     // resinous, grey-green
    roughness: 0.85,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.03,
    emissive: 0.0,
    wetnessResponse: 0.15,
    animeFlatness: 0.30,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.65,             // resinous, burns readily
    hardness: 0.25,
    brittleness: 0.60
  }),
  // ─── Bofedal wetland (cushion bog) ──────────────────────────
  bofedal: Object.freeze({
    albedo: [0.12, 0.20, 0.10],     // lush green, permanently wet
    roughness: 0.75,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.12,
    emissive: 0.0,
    wetnessResponse: 1.0,
    animeFlatness: 0.18,
    acousticProfile: ACOUSTIC_PROFILE.WATER,
    flammability: 0.10,
    hardness: 0.05,
    brittleness: 0.95
  }),
  // ─── Volcanic puna soil ─────────────────────────────────────
  punaSoil: Object.freeze({
    albedo: [0.14, 0.12, 0.10],     // dark volcanic
    roughness: 0.92,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.40,
    animeFlatness: 0.48,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.05,
    hardness: 0.25,
    brittleness: 0.70
  }),
  // ─── Exposed rock / scree ───────────────────────────────────
  punaRock: Object.freeze({
    albedo: [0.30, 0.28, 0.25],
    roughness: 0.88,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.10,
    animeFlatness: 0.50,
    acousticProfile: ACOUSTIC_PROFILE.ROCK,
    flammability: 0.0,
    hardness: 0.92,
    brittleness: 0.22
  }),
  // ─── Snow (high-elevation, seasonal) ────────────────────────
  punaSnow: Object.freeze({
    albedo: [0.92, 0.94, 0.97],
    roughness: 0.35,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.35,
    emissive: 0.0,
    wetnessResponse: 0.05,
    animeFlatness: 0.12,
    acousticProfile: ACOUSTIC_PROFILE.SOFT,
    flammability: 0.0,
    hardness: 0.10,
    brittleness: 0.92
  })
});

// ─── Lighting ───────────────────────────────────────────────────
// Puna lighting is intense and UV-rich: the thin atmosphere scatters less and
// absorbs less, producing sharp shadows, very high contrast, and a deep blue
// sky. Snow albedo and secondary bounce are strong, and the high altitude
// means the sky-view factor is near 1.0.
const LIGHTING = Object.freeze({
  canopyOcclusion: 0.00,
  sunDiffuseFraction: 0.25,         // direct sun dominates
  sunIntensityScale: 1.40,          // intense high-altitude irradiance
  colourCast: [0.85, 0.92, 1.00],   // strongly blue-shifted
  atmosphericScatterBoost: 0.55,    // very thin atmosphere above
  bioluminescentEmission: 0.00,
  dappledLightFrequency: 0.00,
  dappledLightAmplitude: 0.00,
  shadowSoftnessNear: 0.3,
  shadowSoftnessMid: 0.5,
  shadowSoftnessFar: 0.7,
  shadowCascadeScale: 1.0,
  snowAlbedoBoost: 1.65,            // very high snow albedo
  fogDensityBase: 0.003,            // extremely clear air
  skyTint: [0.65, 0.78, 0.95],      // deep saturated blue
  // ─── UV index ───────────────────────────────────────────────
  uvIndexBase: 14.0,                // extreme UV at high altitude
  uvElevationBoost: 0.10,          // ~10 % increase per 1,000 m
  // ─── Barometric formula ─────────────────────────────────────
  seaLevelPressureKPa: 101.325,
  molarMassAirKgPerMol: 0.02896,
  gravityMs2: 9.81,
  gasConstantJKPerMol: 8.314,
  // ─── Sky-view factor ───────────────────────────────────────
  skyViewFactor: 0.99
});

// ─── Water ──────────────────────────────────────────────────────
// Water is scarce in the open puna but concentrated in bofedales, high lakes,
// and seasonal streams. Bofedales are the critical water and forage resource.
const WATER = Object.freeze({
  surfaceWaterPresence: 0.15,
  riverineNetworkDensity: 0.20,
  canopyDrip: 0.00,
  groundwaterTableDepthM: 2.0,
  freshwaterSpringPresence: 0.15,
  waterTableDepthM: 2.0,
  bogCoverage: 0.10,                // bofedales
  lakeCoverage: 0.05,               // high-altitude lakes
  riverWidthMeanM: 3.0,
  waterTemperatureC: 5.0,
  iceCoverMonths: 3,
  shorelineMaterial: 'punaSoil',
  // ─── Bofedal hydrology ─────────────────────────────────────
  bofedalWaterTableDepthM: 0.1,     // permanently saturated
  bofedalPeatDepthM: 1.0,           // organic soil accumulation
  // ─── Snowmelt ──────────────────────────────────────────────
  degreeDayFactorMmPerCPerDay: 3.0,
  meltBaseTemperatureC: 0.0
});

// ─── Sensory ────────────────────────────────────────────────────
const SENSORY = Object.freeze({
  acoustic: Object.freeze({
    biological: 0.15,               // sparse, mostly birds and camelids
    geological: 0.15,               // rockfall, frost cracking
    water: 0.15,                    // bofedal seep, streams
    wind: 0.50,                     // wind dominates
    vegetation: 0.05,
    mechanical: 0.00
  }),
  olfactory: Object.freeze({
    floral: 0.10,
    earthy: 0.25,                   // volcanic soil
    aquatic: 0.10,
    woodland: 0.05,                 // resinous tola
    smoke: 0.00,
    animal: 0.10,
    decay: 0.05,
    sulfur: 0.00,
    sea: 0.00,
    clean: 0.35                    // extremely clean, thin air
  }),
  tactile: Object.freeze({
    temperatureC: 5.0,
    humidity: 0.45,
    windPressurePa: 8.0,
    precipitationType: 'snow',
    groundHardness: 0.35
  })
});

// ─── Seasonality ────────────────────────────────────────────────
// Phenology is controlled by the wet–dry cycle and the short growing season
// (December–March). The dry season (May–September) is a dormant period with
// nocturnal frosts; the wet season triggers a brief green flush and flowering.
const SEASONALITY = Object.freeze({
  phenologyOverrides: Object.freeze({
    budBreakDayOffset: 0,
    fullGreenDurationDays: 90,
    autumnColourShiftDays: 20,
    leafDropDurationDays: 15,
    bloomWindowDays: 60,
    sporeBoostWetSeason: 0.15,
    fungalBoostWetSeason: 0.10
  }),
  seasonalMaterialPalettes: Object.freeze({
    [SEASONAL_MATERIAL.SPRING_NEW_LEAF]: Object.freeze({
      ichuBunchgrass: { albedo: [0.20, 0.26, 0.12], roughness: 0.85 },
      cushionPlant: { albedo: [0.16, 0.24, 0.10], roughness: 0.78 }
    }),
    [SEASONAL_MATERIAL.SUMMER_FULL_GREEN]: Object.freeze({
      ichuBunchgrass: { albedo: [0.22, 0.28, 0.14], roughness: 0.86 },
      bofedal: { albedo: [0.12, 0.20, 0.10], roughness: 0.75 }
    }),
    [SEASONAL_MATERIAL.AUTUMN_PEAK]: Object.freeze({
      ichuBunchgrass: { albedo: [0.30, 0.28, 0.18], roughness: 0.88 },
      tolaShrub: { albedo: [0.22, 0.20, 0.12], roughness: 0.84 }
    }),
    [SEASONAL_MATERIAL.WINTER_BARE_BRANCH]: Object.freeze({
      ichuBunchgrass: { albedo: [0.35, 0.32, 0.22], roughness: 0.90 },
      punaSnow: { albedo: [0.92, 0.94, 0.97], roughness: 0.35 },
      punaSoil: { albedo: [0.16, 0.14, 0.12], wetnessResponse: 0.20 }
    })
  }),
  snowAccumulationRateMmHr: 2.0,
  snowMeltRateMmHr: 2.5,
  snowAlbedoSeasonal: 0.92,
  // Snow-line migration range (metres) across the year
  snowlineSeasonalRangeM: 1000.0
});

// ─── Procedural ─────────────────────────────────────────────────
const PROCEDURAL = Object.freeze({
  macroGrassNoiseScale: 150.0,      // pajonal vs. cushion-plant mosaics
  midGrassNoiseScale: 35.0,         // bunchgrass clumps and bofedal patches
  microGrassNoiseScale: 6.0,        // individual tuft and cushion detail
  terrainNoiseScale: 300.0,         // mountain ridges and plateaus
  bofedalNoiseScale: 60.0,          // wetland distribution
  treeDensityPerHa: VEGETATION.treeDensityPerHa,
  shrubDensityPerHa: VEGETATION.shrubDensityPerHa,
  groundCoverDensityPerHa: VEGETATION.groundCoverDensityPerHa,
  lodHighDistance: 1200.0,
  lodMidDistance: 6000.0,
  lodLowDistance: 30000.0,
  maxFireEventsPerTick: 1,          // fire is rare
  maxErosionEventsPerTick: 3,       // frost weathering and wind erosion
  maxGrowthEventsPerTick: 2
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING ────────────────────────────────────────
// Andean Puna suitability is dominated by elevation (3,200–5,200 m), cold
// oligothermic temperature, dry-season moisture deficit, nocturnal frost,
// and volcanic or organic-rich soil. 328_BiomeBlendField uses this to decide
// how much of the Andean Puna biome applies at any world point.
// ══════════════════════════════════════════════════════════════════
const _scratchVec3 = new Vec3();
const _scratchNoise = new SimplexNoise();

function getSuitability(env) {
  // ─── Elevation: the master variable — puna exists only above 3,200 m ─
  const elevScore =
    smoothstep(2800.0, 3400.0, env.elevationM) *
    (1.0 - smoothstep(5000.0, 5800.0, env.elevationM));

  // ─── Temperature: oligothermic, cold mean annual ──────────────────
  const tempScore = smoothstep(-10.0, 2.0, env.temperatureC) * (1.0 - smoothstep(15.0, 25.0, env.temperatureC));

  // ─── Humidity: dry to semi-arid ──────────────────────────────────
  const humidityScore = smoothstep(0.20, 0.40, env.humidity) * (1.0 - smoothstep(0.65, 0.85, env.humidity));

  // ─── Slope: mountain terrain, but includes plateaus ───────────────
  const slopeScore = smoothstep(2.0, 10.0, env.slopeDeg) * (1.0 - smoothstep(35.0, 55.0, env.slopeDeg));

  // ─── Soil texture: silty loam with volcanic influence ─────────────
  const textureScore =
    0.45 * smoothstep(0.25, 0.45, env.soilSilt) +
    0.30 * smoothstep(0.15, 0.35, env.soilClay) +
    0.25 * (1.0 - smoothstep(0.15, 0.35, env.soilSand));

  // ─── Water table: shallow enough for bofedales, deep enough for open puna ─
  const waterScore =
    0.60 * (1.0 - smoothstep(0.1, 1.0, env.waterTableDepthM)) +  // bofedal
    0.40 * smoothstep(1.0, 3.0, env.waterTableDepthM);           // open puna

  // ─── Patchiness ────────────────────────────────────────────────────
  const patchiness = env.noise !== undefined ? (0.80 + 0.20 * env.noise) : 1.0;

  // ─── Weighted fusion ────────────────────────────────────────────────
  // Elevation dominates: the puna is defined by its altitude belt.
  const raw =
    0.35 * elevScore +
    0.20 * tempScore +
    0.12 * humidityScore +
    0.10 * slopeScore +
    0.10 * textureScore +
    0.13 * waterScore;

  return Math.max(0.0, Math.min(1.0, raw * patchiness));
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR EXPORT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const AndeanPunaGrasslandBiome = Object.freeze({
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

export default AndeanPunaGrasslandBiome;