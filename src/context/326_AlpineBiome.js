// file number : 326
// full path name : src/context/326_AlpineBiome.js
// description : Alpine biome descriptor — the ninth and final of the nine biome
// presets, tuned for high-elevation environments above the treeline (typically
// 1,500–5,000 m depending on latitude) where thin cold air, a rapid
// environmental lapse rate, persistent snow and ice, cryogenic (freeze–thaw)
// soils, and snowmelt-driven hydrology are the defining drivers. Provides the
// same eleven interlocking descriptor blocks as 318–325, but every parameter is
// recalibrated for the alpine's constraints: a temperature lapse rate of about
// 6.5 K/km, 25 % lower sea-level pressure at 2,500 m, intense UV at altitude,
// strong katabatic winds, a treeline that caps vertical vegetation structure at
// a single dwarf-shrub and turf layer, and a hydrology dominated by seasonal
// snowmelt rather than rainfall. Materials and lighting expose full PBR + anime
// parameters for snow, glacial ice, exposed granite, scree, and alpine turf,
// with elevation-dependent snowline, slope-dependent snow retention, and
// avalanche-source snowpack parameters. The descriptor allocates nothing after
// construction and is consumed by the biome registry, blend field, material
// bridge, climate/soil/hydrology couplings, fauna migration system, chunk
// descriptor, and the full material/lighting/sensory pipeline.
//#
// best for : Every consumer that needs an alpine or high-elevation biome preset
// — biome registry barrel (327), biome blend field (328), biome blend system
// (329), cross-biome ecotone (330), biome material bridge (331), biome climate
// coupling (332), biome soil coupling (333), biome hydrology coupling (334),
// biome fauna migration (335), landscape chunk descriptor (336), and the whole
// material/lighting/sensory pipeline. Together with the other eight biome files
// this completes the planet-scale living-biome palette, and the alpine preset
// is the one that must remain seamless from valley floor through treeline to
// the glacier and snowfield summit.
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
const BIOME_ID = 9;
const BIOME_NAME = 'alpine';
const BIOME_DISPLAY_NAME = 'Alpine / High Elevation';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── ALPINE CHARACTERISTIC PARAMETERS ───────────────────────────
// ══════════════════════════════════════════════════════════════════
// ─── Climate ────────────────────────────────────────────────────
// Alpine climate is a function of elevation, not latitude alone: the
// environmental lapse rate (≈6.5 K/km) cools the air, while the thinner
// atmosphere reduces pressure and increases UV.
const CLIMATE = Object.freeze({
  // Temperature (°C) — cold year-round, with large diurnal swing
  temperatureMin: -35.0,
  temperatureMax: 20.0,
  temperatureMean: -3.0,
  temperatureDailySwing: 18.0,      // strong diurnal swing at altitude
  temperatureFrostFree: false,       // frost any month
  // Environmental lapse rate (K/km) used by the temperature provider to
  // convert a sea-level reference temperature to an elevation-correct one.
  lapseRateKPerKm: 6.5,
  // Humidity (0..1) — low absolute moisture, higher relative humidity in cloud
  humidityMin: 0.30,
  humidityMax: 0.85,
  humidityMean: 0.55,
  // Precipitation (mm/hr mean) — orographic enhancement, mostly snow at altitude
  precipitationMean: 1.5,
  precipitationMax: 20.0,
  precipitationStormProb: 0.15,
  precipitationAnnualMm: 1200.0,     // higher than lowland at the same latitude
  // Seasons — long snow season, brief summer
  seasonalityAmplitude: 0.85,
  drySeasonLengthDays: 0,
  wetSeasonPeakDay: 0,
  snowSeasonDays: 240,
  growingSeasonDays: 90,
  // Wind — strong katabatic outflow and ridge-top gales
  windMeanSpeed: 7.0,
  windMaxSpeed: 40.0,
  windPredominantDirDeg: 180,        // katabatic flow is downslope, direction-agnostic
  // Weather state probabilities (0..1)
  weatherProbClear: 0.30,
  weatherProbCloudy: 0.30,
  weatherProbRain: 0.10,
  weatherProbStorm: 0.10,
  weatherProbSnow: 0.20,
  weatherProbFog: 0.00,
  // Atmospheric — sea-level standard pressure ≈101.3 kPa
  pressureMeanKPa: 101.3,           // reference; elevation correction applied downstream
  pressureSwingKPa: 2.0,
  // Partial pressure of oxygen at the reference sea level (used with
  // elevation to compute effective pO₂; ~21 % of total pressure).
  seaLevelPO2KPa: 21.2
});

// ─── Terrain Bias ────────────────────────────────────────────────
// Alpine terrain is steep, rugged, and often glaciated. Slopes exceed 30°
// on exposed rock faces, and cirques, arêtes, and moraines are characteristic.
const TERRAIN = Object.freeze({
  elevationBand: ELEVATION_BAND.HIGHLAND,
  elevationMinM: 1500.0,            // treeline lower bound (variable by latitude)
  elevationMaxM: 6000.0,            // snowline upper bound
  slopeMeanDeg: 20.0,
  slopeMaxDeg: 70.0,                // cliff faces and arêtes
  roughness: 0.80,                  // very rugged
  valleyDepth: 0.70,                // deep glacial valleys
  valleyDensity: 0.50,
  plateauBias: 0.30,                // fewer plateaus, more ridges
  groundwaterTableDepthM: 1.0,      // shallow where meltwater saturates
  permafrostDepthM: 2.5,            // alpine permafrost is patchy and shallow
  terrainRoughnessHint: 0.85,
  biomeHint: BIOME_HINT.ALPINE,
  // Treeline elevation range for this biome (used by 282_Z07 ForestGradient)
  treelineMinM: 1500.0,
  treelineMaxM: 3000.0,
  // Snowline elevation range for this biome (used by 288 precipitation)
  snowlineMinM: 2000.0,
  snowlineMaxM: 5000.0
});

// ─── Soil ──────────────────────────────────────────────────────
// Alpine soils are thin, skeletal, rocky, and cryogenic. Freeze–thaw cycles
// produce patterned ground (sorted circles, stone stripes) and prevent deep
// soil development.
const SOIL = Object.freeze({
  textureClass: SOIL_TEXTURE_CLASS.GRAVELLY_LOAM,
  visualArchetype: SOIL_VISUAL_ARCHETYPE.VOLCANIC_BLACK,
  // Primary fractions (0..1) — skeletal, rocky
  sand: 0.30,
  silt: 0.25,
  clay: 0.05,
  organicMatter: 0.05,
  gravel: 0.20,
  rockFragment: 0.15,
  // Chemistry
  pH: 5.5,                          // slightly acidic to neutral
  fertilityClass: FERTILITY_CLASS.POOR,
  fertilityIndex: 0.20,
  // Physics
  porosity: 0.45,
  bulkDensityGcm3: 1.35,
  waterHoldingCapacity: 0.15,
  hydraulicConductivityMmHr: 8.0,
  cohesionKPa: 2.0,
  plasticityIndex: 5.0,
  // Colour (linear RGB) — dark grey-brown
  baseAlbedo: [0.16, 0.15, 0.13],
  organicDarkening: 0.35,
  ironOxideRedness: 0.20,
  calciumPale: 0.20,                // carbonate enrichment
  // Erosion
  usleKFactor: 0.30,
  windErodibility: 0.30,
  // Cryoturbation parameters (freeze–thaw mixing)
  cryoturbationIntensity: 0.60,
  activeLayerDepthM: 0.8
});

// ─── Vegetation ─────────────────────────────────────────────────
// Alpine vegetation is treeless above the treeline; it consists of low turf,
// cushion plants, dwarf shrubs, mosses, and lichens that hug the ground.
const VEGETATION = Object.freeze({
  treeTypeWeights: Object.freeze({
    [TREE_TYPE.PINE]: 0.50,       // krummholz at treeline
    [TREE_TYPE.FIR]: 0.30,        // krummholz at treeline
    [TREE_TYPE.BIRCH]: 0.20       // krummholz at treeline
  }),
  grassTypeWeights: Object.freeze({
    [GRASS_TYPE.ALPINE_TUFT]: 0.55,
    [GRASS_TYPE.SHORT_PRAIRIE]: 0.20,
    [GRASS_TYPE.SNOWDROP]: 0.15,
    [GRASS_TYPE.TUNDRA_TUFT]: 0.10
  }),
  verticalLayers: 1,                // single ground-hugging layer above treeline
  emergentDensity: 0.00,
  canopyDensity: 0.00,              // no canopy above treeline
  understoryDensity: 0.00,
  groundCoverDensity: 0.45,         // alpine turf and cushion plants
  epiphyteDensity: 0.25,            // lichen on rock is prominent
  lianaDensity: 0.00,
  successionTarget: SUCCESSION.PIONEER,   // primary succession on glacial till
  fireRegimeYears: 300,             // fire is rare
  rootDepthM: 0.4,                  // shallow active layer limits roots
  canopyRadiusM: 0.0,
  trunkHeightM: 0.0,
  leafLitterDepthM: 0.02,
  bloomWindowDays: 60,              // brief summer bloom
  // Poisson-disc targets per hectare — above-treeline density
  treeDensityPerHa: 0,
  shrubDensityPerHa: 200,
  groundCoverDensityPerHa: 20000,
  // Krummholz zone density (below treeline but above closed forest)
  krummholzDensityPerHa: 400
});

// ─── Fauna ──────────────────────────────────────────────────────
// Alpine fauna is adapted to cold, thin air and steep terrain: mountain goats,
// ibex, marmots, pikas, and raptors. Seasonal altitudinal migration is the
// dominant behavioural pattern.
const FAUNA = Object.freeze({
  densityWeight: 0.25,
  habitatLayers: Object.freeze({
    ground: 0.55,
    understory: 0.10,
    canopy: 0.05,
    aerial: 0.30                   // raptors and soaring birds
  }),
  dielActivity: 0.50,               // diurnal, with midday siesta at high altitude
  migrationCorridorWeight: 0.65,    // altitudinal migration dominates
  predatorPreyBalance: 0.35,
  nectarAvailability: 0.05,
  pollenAvailability: 0.05,
  // Characteristic guild weights
  largeHerbivoreWeight: 0.30,       // ibex, chamois, bighorn sheep
  largePredatorWeight: 0.10,        // mountain lion, snow leopard, eagle
  smallMammalWeight: 0.25,          // marmot, pika, vole
  birdWeight: 0.25,
  insectWeight: 0.10,
  // Altitudinal migration band (metres) below/above the treeline
  altitudinalMigrationBandM: 800.0
});

// ─── Materials ──────────────────────────────────────────────────
// Full PBR + anime parameters for alpine surfaces: snow, glacial ice, granite,
// scree, and alpine turf. Snow is the defining material: very high albedo,
// strong subsurface scattering, low roughness on fresh snow, and a melt-driven
// roughness and albedo transition as the snow ages.
const MATERIALS = Object.freeze({
  // ─── Alpine snow (fresh and aged) ──────────────────────────
  alpineSnow: Object.freeze({
    albedo: [0.92, 0.94, 0.97],     // fresh snow albedo ≈ 0.9
    roughness: 0.30,                 // fresh snow is relatively smooth
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.45,                // strong subsurface scattering
    emissive: 0.0,
    wetnessResponse: 0.05,
    animeFlatness: 0.10,
    acousticProfile: ACOUSTIC_PROFILE.SOFT,
    flammability: 0.0,
    hardness: 0.10,
    brittleness: 0.90,
    // ─── Snow ageing: fresh → firn → wet → ice ────────────
    ageToRoughnessCurve: Object.freeze({
      fresh: 0.30,
      firn: 0.55,
      wet: 0.65,
      ice: 0.15
    }),
    ageToAlbedoCurve: Object.freeze({
      fresh: 0.92,
      firn: 0.80,
      wet: 0.65,
      ice: 0.55
    }),
    ageRatePerDay: 0.10
  }),
  // ─── Glacial ice ────────────────────────────────────────────
  glacialIce: Object.freeze({
    albedo: [0.70, 0.82, 0.90],      // blue-tinted glacier ice
    roughness: 0.12,
    metalness: 0.0,
    transmission: 0.60,
    ior: 1.31,
    fresnelF0: 0.018,
    subsurface: 0.50,
    emissive: 0.0,
    wetnessResponse: 0.20,
    animeFlatness: 0.10,
    acousticProfile: ACOUSTIC_PROFILE.SOFT,
    flammability: 0.0,
    hardness: 0.55,
    brittleness: 0.45,
    // ─── Blue ice absorption (Beer–Lambert) ────────────────
    attenuationKd: Object.freeze({
      red: 0.25,
      green: 0.10,
      blue: 0.04
    })
  }),
  // ─── Exposed granite / bedrock ────────────────────────────
  alpineGranite: Object.freeze({
    albedo: [0.35, 0.33, 0.30],
    roughness: 0.85,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.20,
    animeFlatness: 0.45,
    acousticProfile: ACOUSTIC_PROFILE.ROCK,
    flammability: 0.0,
    hardness: 0.95,
    brittleness: 0.20
  }),
  // ─── Scree / talus ────────────────────────────────────────
  scree: Object.freeze({
    albedo: [0.30, 0.28, 0.25],
    roughness: 0.92,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.30,
    animeFlatness: 0.50,
    acousticProfile: ACOUSTIC_PROFILE.ROCK,
    flammability: 0.0,
    hardness: 0.70,
    brittleness: 0.40,
    grainScaleM: 0.10               // scree grain size for normal-map detail
  }),
  // ─── Alpine turf / cushion plant ──────────────────────────
  alpineTurf: Object.freeze({
    albedo: [0.12, 0.18, 0.08],
    roughness: 0.82,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.40,
    animeFlatness: 0.20,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.25,
    hardness: 0.10,
    brittleness: 0.85
  }),
  // ─── Lichen on rock ──────────────────────────────────────
  alpineLichen: Object.freeze({
    albedo: [0.40, 0.42, 0.30],
    roughness: 0.88,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.35,
    animeFlatness: 0.30,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.15,
    hardness: 0.10,
    brittleness: 0.85
  })
});

// ─── Lighting ───────────────────────────────────────────────────
// Alpine lighting is intense and UV-rich. The thinner atmosphere scatters less
// and absorbs less, producing sharper shadows, higher contrast, and a stronger
// blue sky. Snow albedo and the secondary bounce are the defining features.
const LIGHTING = Object.freeze({
  canopyOcclusion: 0.00,            // no canopy above treeline
  sunDiffuseFraction: 0.25,         // direct sun strongly dominates
  sunIntensityScale: 1.35,          // intense solar irradiance at altitude
  colourCast: [0.88, 0.94, 1.00],   // strongly blue-shifted at altitude
  atmosphericScatterBoost: 0.65,    // less atmosphere above means less scatter
  bioluminescentEmission: 0.00,
  dappledLightFrequency: 0.00,
  dappledLightAmplitude: 0.00,
  shadowSoftnessNear: 0.3,
  shadowSoftnessMid: 0.5,
  shadowSoftnessFar: 0.7,
  shadowCascadeScale: 1.0,
  snowAlbedoBoost: 1.70,            // highest snow albedo of any biome
  fogDensityBase: 0.004,            // very clear air
  skyTint: [0.70, 0.82, 0.95],      // deep, saturated blue sky
  // ─── UV index (used by the sensory and sun providers) ───────
  uvIndexBase: 11.0,                // extreme UV at high altitude
  uvElevationBoost: 0.08,          // UV increases ~8 % per 1,000 m
  // ─── Snow reflectance parameters ──────────────────────────
  // Snow is strongly forward-scattering; a Henyey-Greenstein g close to 0.9
  // captures the sharp specular sheen on fresh snow.
  snowHenyeyGreensteinG: 0.85,
  // ─── Atmospheric pressure correction ──────────────────────
  // Barometric formula: P(z) = P₀ · exp(−Mgz / RT), with M ≈ 0.02896 kg/mol.
  seaLevelPressureKPa: 101.325,
  molarMassAirKgPerMol: 0.02896,
  gravityMs2: 9.81,
  gasConstantJKPerMol: 8.314
});

// ─── Water ──────────────────────────────────────────────────────
// Alpine hydrology is dominated by snowmelt, glaciers, and seasonal streams.
// Water is cold and often frozen; glacial meltwater carries fine rock flour
// that turns lakes a distinctive turquoise.
const WATER = Object.freeze({
  surfaceWaterPresence: 0.20,       // tarns, glacial lakes, meltwater streams
  riverineNetworkDensity: 0.30,     // high-density headwater streams
  canopyDrip: 0.00,
  groundwaterTableDepthM: 1.0,
  freshwaterSpringPresence: 0.15,
  waterTableDepthM: 1.0,
  bogCoverage: 0.05,
  lakeCoverage: 0.05,               // glacial tarns
  riverWidthMeanM: 2.0,             // small alpine streams
  waterTemperatureC: 4.0,           // snowmelt-fed, consistently cold
  iceCoverMonths: 6,
  shorelineMaterial: 'scree',
  // ─── Glacial rock flour ────────────────────────────────────
  // Suspended rock flour shifts the water colour toward turquoise and
  // raises turbidity, lowering Secchi depth.
  rockFlourTurbidityNTU: 3.0,
  rockFlourColor: [0.25, 0.55, 0.60],
  // ─── Snowmelt parameters ───────────────────────────────────
  // Degree-day melt model: M = DDF · (T_mean − T_base)
  degreeDayFactorMmPerCPerDay: 4.0,
  meltBaseTemperatureC: 0.0,
  // ─── Glacier mass balance (simplified) ────────────────────
  glacierAccumulationMmPerYear: 800.0,
  glacierAblationMmPerYear: 950.0  // net negative in a warming climate
});

// ─── Sensory ────────────────────────────────────────────────────
const SENSORY = Object.freeze({
  // Acoustic signature (0..1 weights across 8 channels)
  acoustic: Object.freeze({
    biological: 0.10,               // sparse, mostly birds and marmots
    geological: 0.25,               // rockfall, ice cracking
    water: 0.20,                    // meltwater streams
    wind: 0.40,                     // wind dominates above treeline
    vegetation: 0.05,
    mechanical: 0.00
  }),
  // Olfactory signature
  olfactory: Object.freeze({
    floral: 0.10,
    earthy: 0.20,
    aquatic: 0.10,
    woodland: 0.05,
    smoke: 0.00,
    animal: 0.05,
    decay: 0.05,
    sulfur: 0.00,
    sea: 0.00,
    clean: 0.45                    // very clean, thin, cold air
  }),
  // Tactile profile
  tactile: Object.freeze({
    temperatureC: -3.0,
    humidity: 0.55,
    windPressurePa: 12.0,
    precipitationType: 'snow',
    groundHardness: 0.40
  })
});

// ─── Seasonality ────────────────────────────────────────────────
// Alpine phenology is controlled by the snow-free window: the growing season
// is short, flowering is compressed, and autumn senescence is rapid. The
// snowline migrates up and down the mountain with the seasons.
const SEASONALITY = Object.freeze({
  phenologyOverrides: Object.freeze({
    budBreakDayOffset: -15,         // very late
    fullGreenDurationDays: 60,
    autumnColourShiftDays: 20,
    leafDropDurationDays: 10,
    bloomWindowDays: 45,
    sporeBoostWetSeason: 0.15,
    fungalBoostWetSeason: 0.10
  }),
  seasonalMaterialPalettes: Object.freeze({
    [SEASONAL_MATERIAL.SPRING_NEW_LEAF]: Object.freeze({
      alpineTurf: { albedo: [0.15, 0.22, 0.10], roughness: 0.80 },
      alpineSnow: { albedo: [0.88, 0.90, 0.94], roughness: 0.35 },
      scree: { albedo: [0.32, 0.30, 0.27], wetnessResponse: 0.45 }
    }),
    [SEASONAL_MATERIAL.SUMMER_FULL_GREEN]: Object.freeze({
      alpineTurf: { albedo: [0.12, 0.18, 0.08], roughness: 0.82 },
      alpineSnow: { albedo: [0.82, 0.86, 0.92], roughness: 0.45 },
      glacialIce: { albedo: [0.70, 0.82, 0.90], roughness: 0.12 }
    }),
    [SEASONAL_MATERIAL.AUTUMN_PEAK]: Object.freeze({
      alpineTurf: { albedo: [0.22, 0.16, 0.08], roughness: 0.84 },
      alpineSnow: { albedo: [0.90, 0.92, 0.95], roughness: 0.32 }
    }),
    [SEASONAL_MATERIAL.WINTER_BARE_BRANCH]: Object.freeze({
      alpineTurf: { albedo: [0.25, 0.22, 0.18], roughness: 0.85 }, // under snow
      alpineSnow: { albedo: [0.92, 0.94, 0.97], roughness: 0.30 },
      glacialIce: { albedo: [0.75, 0.85, 0.92], roughness: 0.12 },
      scree: { albedo: [0.30, 0.28, 0.25], wetnessResponse: 0.10 }
    })
  }),
  snowAccumulationRateMmHr: 3.0,
  snowMeltRateMmHr: 2.5,
  snowAlbedoSeasonal: 0.92,
  // Snowline migration range (metres) across the year
  snowlineSeasonalRangeM: 1500.0
});

// ─── Procedural ─────────────────────────────────────────────────
const PROCEDURAL = Object.freeze({
  // Noise scales (world units) for terrain and surface detail
  macroTerrainNoiseScale: 800.0,    // mountain ridges and cirques
  midTerrainNoiseScale: 150.0,      // gullies and moraines
  microTerrainNoiseScale: 20.0,     // scree and periglacial patterning
  snowFieldNoiseScale: 300.0,       // snowfield and glacier extents
  screeNoiseScale: 40.0,            // talus grain patterns
  // Poisson-disc density targets (per hectare) — mirrored from VEGETATION
  treeDensityPerHa: VEGETATION.treeDensityPerHa,
  shrubDensityPerHa: VEGETATION.shrubDensityPerHa,
  groundCoverDensityPerHa: VEGETATION.groundCoverDensityPerHa,
  // LOD scale thresholds (world units) — long alpine sightlines
  lodHighDistance: 1500.0,
  lodMidDistance: 8000.0,
  lodLowDistance: 40000.0,
  // Procedural event budgets
  maxFireEventsPerTick: 0,          // fire is negligible
  maxErosionEventsPerTick: 3,       // frost weathering, rockfall, avalanches
  maxGrowthEventsPerTick: 2,
  // ─── Avalanche source parameters ───────────────────────────
  // Avalanche release is triggered when the slope angle is between ~25° and
  // ~50° and the snowpack load exceeds a threshold.
  avalancheSlopeMinDeg: 25.0,
  avalancheSlopeMaxDeg: 50.0,
  avalancheSnowLoadThresholdKgM2: 400.0
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING ────────────────────────────────────────
// Alpine suitability is primarily driven by elevation: the biome exists only
// above the treeline and is strongest in the 2,000–4,500 m band. Temperature
// (already elevation-corrected by the caller), slope, and substrate provide
// supporting weights. 328_BiomeBlendField uses this to decide how much of the
// alpine biome applies at any world point.
// ══════════════════════════════════════════════════════════════════
const _scratchVec3 = new Vec3();
const _scratchNoise = new SimplexNoise();

/**
 * Compute the alpine suitability at a world position and environmental state.
 * All inputs are expected to come from the context frame or from provider
 * summaries. The function allocates nothing after module initialisation.
 *
 * @param {object} env - Environmental sample.
 * @param {number} env.temperatureC - Elevation-corrected air temperature in °C.
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
  // ─── Elevation: the dominant alpine discriminator ─────────────────────
  // Alpine becomes suitable at ~1,500 m, peaks between 2,500 and 4,000 m,
  // and fades above 5,500 m where only snowfields and rock remain.
  const elevScore =
    smoothstep(1000.0, 1800.0, env.elevationM) *
    (1.0 - smoothstep(4500.0, 6000.0, env.elevationM));

  // ─── Temperature: cold but not polar ──────────────────────────────────
  const tempScore = smoothstep(-35.0, -5.0, env.temperatureC) * (1.0 - smoothstep(15.0, 25.0, env.temperatureC));

  // ─── Humidity: cloud and snowpack raise humidity at altitude ──────────
  const humidityScore = smoothstep(0.30, 0.65, env.humidity);

  // ─── Slope: steep terrain is defining; flat plateaus are not alpine ──
  const slopeScore = smoothstep(5.0, 20.0, env.slopeDeg) * (1.0 - smoothstep(60.0, 80.0, env.slopeDeg));

  // ─── Substrate: gravelly loam with rock fragments is typical ──────────
  const textureScore =
    0.35 * smoothstep(0.20, 0.40, env.soilSilt) +
    0.30 * smoothstep(0.20, 0.45, env.soilSand) +
    0.35 * (1.0 - smoothstep(0.10, 0.30, env.soilClay));

  // ─── Water table: shallow where meltwater is present, dry on ridges ──
  const waterScore = 1.0 - smoothstep(0.5, 3.0, env.waterTableDepthM);

  // ─── Patchiness: break up the suitability field with low-frequency noise ─
  const patchiness = env.noise !== undefined ? (0.80 + 0.20 * env.noise) : 1.0;

  // ─── Weighted fusion ────────────────────────────────────────────────
  const raw =
    0.40 * elevScore +
    0.22 * tempScore +
    0.10 * humidityScore +
    0.12 * slopeScore +
    0.08 * textureScore +
    0.08 * waterScore;

  return Math.max(0.0, Math.min(1.0, raw * patchiness));
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR EXPORT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const AlpineBiome = Object.freeze({
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

export default AlpineBiome;