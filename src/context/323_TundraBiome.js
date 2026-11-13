// file number : 323
// full path name : src/context/323_TundraBiome.js
// description : Tundra biome descriptor — the sixth of the nine biome presets,
// tuned for polar and alpine tundra (60°–75°+ in both hemispheres, plus high-
// elevation zones at any latitude) where permafrost, an extremely short growing
// season, and freeze–thaw cycles are the defining drivers. Provides the same
// eleven interlocking descriptor blocks as 318–322, but every parameter is
// recalibrated for the tundra's constraints: mean temperatures below 0 °C for
// six to ten months, 150–250 mm annual precipitation (comparable to a desert),
// treeless vegetation of mosses, sedges, lichens, and dwarf shrubs, and a
// permafrost table that traps moisture at the surface despite the low rainfall
// . The descriptor is a pure parameter set: it allocates nothing after
// construction and is consumed by the biome registry, blend field, material
// bridge, climate/soil/hydrology couplings, fauna migration system, chunk
// descriptor, and the full material/lighting/sensory pipeline.
// best for : Every consumer that needs a tundra or alpine biome preset — biome
// registry barrel (327), biome blend field (328), biome blend system (329),
// cross-biome ecotone (330), biome material bridge (331), biome climate coupling
// (332), biome soil coupling (333), biome hydrology coupling (334), biome fauna
// migration (335), landscape chunk descriptor (336), and the whole material/
// lighting/sensory pipeline. Together with the other eight biome files this
// completes the planet-scale living-biome palette.
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
const BIOME_ID = 6;
const BIOME_NAME = 'tundra';
const BIOME_DISPLAY_NAME = 'Tundra / Alpine';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── TUNDRA CHARACTERISTIC PARAMETERS ───────────────────────────
// ══════════════════════════════════════════════════════════════════
// ─── Climate ────────────────────────────────────────────────────
const CLIMATE = Object.freeze({
  // Temperature (°C) — extreme cold, brief cool summer
  // NASA: -40 °C to 18 °C overall range; winter mean ≈ -34 °C; summer 3–12 °C
  temperatureMin: -45.0,
  temperatureMax: 18.0,
  temperatureMean: -15.0,
  temperatureDailySwing: 10.0,      // moderate diurnal swing under low sun angles
  temperatureFrostFree: false,       // frost possible every month
  // Humidity (0..1) — low absolute moisture, but surface waterlogged by permafrost
  humidityMin: 0.50,
  humidityMax: 0.95,
  humidityMean: 0.75,
  // Precipitation (mm/hr mean) — very low; 150–250 mm annual 
  precipitationMean: 0.10,
  precipitationMax: 8.0,
  precipitationStormProb: 0.08,
  precipitationAnnualMm: 200.0,
  // Seasons — long winter, extremely short growing season
  seasonalityAmplitude: 0.98,
  drySeasonLengthDays: 0,
  wetSeasonPeakDay: 0,
  snowSeasonDays: 280,              // snow cover most of the year
  growingSeasonDays: 60,            // 55–90 days in most tundra regions
  // Wind — strong katabatic and polar easterlies
  windMeanSpeed: 6.0,
  windMaxSpeed: 30.0,
  windPredominantDirDeg: 0,         // polar easterlies / katabatic outflow
  // Weather state probabilities (0..1)
  weatherProbClear: 0.30,
  weatherProbCloudy: 0.35,
  weatherProbRain: 0.10,
  weatherProbStorm: 0.05,
  weatherProbSnow: 0.20,
  weatherProbFog: 0.00,
  // Atmospheric
  pressureMeanKPa: 100.5,
  pressureSwingKPa: 4.0
});

// ─── Terrain Bias ────────────────────────────────────────────────
const TERRAIN = Object.freeze({
  elevationBand: ELEVATION_BAND.HIGHLAND,
  elevationMinM: 0.0,
  elevationMaxM: 3000.0,
  slopeMeanDeg: 6.0,
  slopeMaxDeg: 45.0,                // rocky alpine tundra can be steep
  roughness: 0.60,                  // hummocky, patterned ground, frost boils
  valleyDepth: 0.30,
  valleyDensity: 0.40,
  plateauBias: 0.60,
  groundwaterTableDepthM: 0.2,      // permafrost traps water at the surface 
  permafrostDepthM: 0.5,            // active layer is only a few inches deep in summer
  terrainRoughnessHint: 0.70,
  biomeHint: BIOME_HINT.TUNDRA
});

// ─── Soil ──────────────────────────────────────────────────────
// Tundra soils are often waterlogged, acidic, and nutrient-poor despite being
// rich in stored carbon and nitrogen locked in permafrost [reference:3].
const SOIL = Object.freeze({
  textureClass: SOIL_TEXTURE_CLASS.SILT_LOAM,
  visualArchetype: SOIL_VISUAL_ARCHETYPE.PEAT_BROWN,
  // Primary fractions (0..1)
  sand: 0.30,
  silt: 0.45,
  clay: 0.15,
  organicMatter: 0.10,              // slow decomposition accumulates organic matter
  gravel: 0.00,
  rockFragment: 0.00,
  // Chemistry
  pH: 4.5,                          // acidic, often waterlogged
  fertilityClass: FERTILITY_CLASS.POOR,
  fertilityIndex: 0.20,
  // Physics
  porosity: 0.50,
  bulkDensityGcm3: 1.10,
  waterHoldingCapacity: 0.40,       // high due to permafrost impedance
  hydraulicConductivityMmHr: 0.5,
  cohesionKPa: 4.0,
  plasticityIndex: 15.0,
  // Colour (linear RGB)
  baseAlbedo: [0.18, 0.16, 0.12],
  organicDarkening: 0.55,
  ironOxideRedness: 0.10,
  calciumPale: 0.15,
  // Erosion
  usleKFactor: 0.20,
  windErodibility: 0.40
});

// ─── Vegetation ─────────────────────────────────────────────────
// Tundra is treeless; vegetation is low-growing mosses, lichens, sedges, and
// dwarf shrubs that stay close to the ground for snow insulation .
const VEGETATION = Object.freeze({
  treeTypeWeights: Object.freeze({}),  // no trees — this is the defining trait
  grassTypeWeights: Object.freeze({
    [GRASS_TYPE.TUNDRA_TUFT]: 0.50,
    [GRASS_TYPE.MARSH_REED]: 0.25,
    [GRASS_TYPE.SHORT_PRAIRIE]: 0.15,
    [GRASS_TYPE.SNOWDROP]: 0.10
  }),
  verticalLayers: 1,                // single ground-hugging layer
  emergentDensity: 0.00,
  canopyDensity: 0.00,              // no canopy
  understoryDensity: 0.00,          // no understory
  groundCoverDensity: 0.60,         // moss, lichen, sedge, dwarf shrub
  epiphyteDensity: 0.40,            // lichen on rock and ground is prominent
  lianaDensity: 0.00,
  successionTarget: SUCCESSION.CLIMAX,
  fireRegimeYears: 500,             // fire is extremely rare
  rootDepthM: 0.3,                  // roots confined to shallow active layer
  canopyRadiusM: 0.0,
  trunkHeightM: 0.0,
  leafLitterDepthM: 0.02,
  bloomWindowDays: 30,              // brief summer bloom
  // Poisson-disc targets per hectare
  treeDensityPerHa: 0,
  shrubDensityPerHa: 300,           // dwarf shrubs
  groundCoverDensityPerHa: 30000
});

// ─── Fauna ──────────────────────────────────────────────────────
const FAUNA = Object.freeze({
  densityWeight: 0.25,              // low biomass, but seasonal migrations are large
  habitatLayers: Object.freeze({
    ground: 0.70,
    understory: 0.10,
    canopy: 0.00,                   // no canopy
    aerial: 0.20
  }),
  dielActivity: 0.30,               // crepuscular / continuous daylight in summer
  migrationCorridorWeight: 0.80,    // strong seasonal migration (caribou, birds)
  predatorPreyBalance: 0.35,
  nectarAvailability: 0.10,
  pollenAvailability: 0.10,
  // Characteristic guild weights
  largeHerbivoreWeight: 0.30,       // caribou, musk ox
  largePredatorWeight: 0.15,        // wolf, bear (marginal)
  smallMammalWeight: 0.25,          // lemming, arctic fox
  birdWeight: 0.20,                 // migratory waterfowl
  insectWeight: 0.10                // intense summer insect hatches
});

// ─── Materials ──────────────────────────────────────────────────
// Full PBR + anime parameters for the tundra's characteristic surfaces.
const MATERIALS = Object.freeze({
  // ─── Moss / lichen ground cover ─────────────────────────────
  tundraMoss: Object.freeze({
    albedo: [0.15, 0.18, 0.10],
    roughness: 0.92,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.60,
    animeFlatness: 0.20,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.25,
    hardness: 0.10,
    brittleness: 0.85
  }),
  // ─── Lichen (crustose and foliose) ──────────────────────────
  lichen: Object.freeze({
    albedo: [0.35, 0.38, 0.28],
    roughness: 0.88,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.40,
    animeFlatness: 0.30,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.20,
    hardness: 0.15,
    brittleness: 0.80
  }),
  // ─── Dwarf shrub (heath, crowberry, bearberry) ──────────────
  dwarfShrub: Object.freeze({
    albedo: [0.10, 0.14, 0.06],
    roughness: 0.85,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.35,
    animeFlatness: 0.25,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.40,
    hardness: 0.20,
    brittleness: 0.70
  }),
  // ─── Permafrost soil / patterned ground ─────────────────────
  permafrostSoil: Object.freeze({
    albedo: [0.16, 0.14, 0.11],
    roughness: 0.94,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.75,
    animeFlatness: 0.45,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.05,
    hardness: 0.30,
    brittleness: 0.65
  }),
  // ─── Snow (persistent) ──────────────────────────────────────
  snow: Object.freeze({
    albedo: [0.92, 0.94, 0.97],
    roughness: 0.35,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.30,
    emissive: 0.0,
    wetnessResponse: 0.05,
    animeFlatness: 0.10,
    acousticProfile: ACOUSTIC_PROFILE.SOFT,
    flammability: 0.0,
    hardness: 0.08,
    brittleness: 0.92
  }),
  // ─── Exposed rock / boulder field ───────────────────────────
  tundraRock: Object.freeze({
    albedo: [0.28, 0.28, 0.26],
    roughness: 0.86,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.10,
    animeFlatness: 0.50,
    acousticProfile: ACOUSTIC_PROFILE.ROCK,
    flammability: 0.0,
    hardness: 0.95,
    brittleness: 0.20
  })
});

// ─── Lighting ───────────────────────────────────────────────────
const LIGHTING = Object.freeze({
  canopyOcclusion: 0.00,            // no canopy
  sunDiffuseFraction: 0.50,         // low sun angles increase diffuse fraction
  sunIntensityScale: 0.70,          // weak insolation at high latitudes
  colourCast: [0.85, 0.90, 1.00],   // cool blue-white
  atmosphericScatterBoost: 1.30,    // long atmospheric path at low sun angles
  bioluminescentEmission: 0.00,
  dappledLightFrequency: 0.00,
  dappledLightAmplitude: 0.00,
  shadowSoftnessNear: 0.6,
  shadowSoftnessMid: 0.8,
  shadowSoftnessFar: 0.95,
  shadowCascadeScale: 0.7,          // lower cascades for performance on mobile
  snowAlbedoBoost: 1.60,            // snow reflects most incident light
  fogDensityBase: 0.010,
  skyTint: [0.80, 0.88, 0.95]
});

// ─── Water ──────────────────────────────────────────────────────
// Despite low precipitation, tundra is often wet because permafrost prevents
// drainage and evaporation is slow .
const WATER = Object.freeze({
  surfaceWaterPresence: 0.45,       // bogs, ponds, waterlogged ground
  riverineNetworkDensity: 0.20,
  canopyDrip: 0.00,
  groundwaterTableDepthM: 0.2,
  freshwaterSpringPresence: 0.15,
  waterTableDepthM: 0.2,
  bogCoverage: 0.40,                // peat bogs and muskeg
  lakeCoverage: 0.10,
  riverWidthMeanM: 5.0,
  waterTemperatureC: 2.0,
  iceCoverMonths: 9,
  shorelineMaterial: 'permafrostSoil'
});

// ─── Sensory ────────────────────────────────────────────────────
const SENSORY = Object.freeze({
  // Acoustic signature (0..1 weights across 8 channels)
  acoustic: Object.freeze({
    biological: 0.15,               // birds and insects in summer, silence in winter
    geological: 0.10,               // frost cracking, rockfall
    water: 0.20,                    // bog seep, meltwater trickle
    wind: 0.45,                     // wind dominates
    vegetation: 0.10,               // rustling sedge
    mechanical: 0.00
  }),
  // Olfactory signature
  olfactory: Object.freeze({
    floral: 0.05,
    earthy: 0.30,
    aquatic: 0.20,
    woodland: 0.05,                 // no forest scent
    smoke: 0.00,
    animal: 0.10,
    decay: 0.15,                    // slow decomposition, peat
    sulfur: 0.00,
    sea: 0.05,                      // coastal tundra
    clean: 0.10
  }),
  // Tactile profile
  tactile: Object.freeze({
    temperatureC: -5.0,
    humidity: 0.75,
    windPressurePa: 10.0,
    precipitationType: 'snow',
    groundHardness: 0.20           // soft, spongy, waterlogged
  })
});

// ─── Seasonality ────────────────────────────────────────────────
// The tundra's phenology is an extremely compressed summer burst followed by a
// long dormant winter. Snow cover is the dominant seasonal signal.
const SEASONALITY = Object.freeze({
  phenologyOverrides: Object.freeze({
    budBreakDayOffset: -20,         // very late
    fullGreenDurationDays: 45,      // extremely short
    autumnColourShiftDays: 15,
    leafDropDurationDays: 10,
    bloomWindowDays: 30,
    sporeBoostWetSeason: 0.20,
    fungalBoostWetSeason: 0.15
  }),
  seasonalMaterialPalettes: Object.freeze({
    [SEASONAL_MATERIAL.SPRING_NEW_LEAF]: Object.freeze({
      tundraMoss: { albedo: [0.18, 0.22, 0.12], roughness: 0.90 },
      dwarfShrub: { albedo: [0.12, 0.18, 0.08], roughness: 0.82 }
    }),
    [SEASONAL_MATERIAL.SUMMER_FULL_GREEN]: Object.freeze({
      tundraMoss: { albedo: [0.15, 0.18, 0.10], roughness: 0.92 },
      lichen: { albedo: [0.35, 0.38, 0.28], roughness: 0.88 },
      dwarfShrub: { albedo: [0.10, 0.14, 0.06], roughness: 0.85 }
    }),
    [SEASONAL_MATERIAL.AUTUMN_PEAK]: Object.freeze({
      dwarfShrub: { albedo: [0.25, 0.15, 0.08], roughness: 0.88 }, // red/orange heath
      tundraMoss: { albedo: [0.20, 0.18, 0.10], roughness: 0.90 }
    }),
    [SEASONAL_MATERIAL.WINTER_BARE_BRANCH]: Object.freeze({
      tundraMoss: { albedo: [0.25, 0.25, 0.22], roughness: 0.80 }, // under snow
      snow: { albedo: [0.92, 0.94, 0.97], roughness: 0.35 },
      permafrostSoil: { albedo: [0.20, 0.18, 0.16], wetnessResponse: 0.20 }
    })
  }),
  snowAccumulationRateMmHr: 2.0,
  snowMeltRateMmHr: 1.5,
  snowAlbedoSeasonal: 0.92
});

// ─── Procedural ─────────────────────────────────────────────────
const PROCEDURAL = Object.freeze({
  macroCanopyNoiseScale: 80.0,      // patterned ground and hummocks
  midUnderstoryNoiseScale: 25.0,    // frost boils, polygons
  microLitterNoiseScale: 5.0,
  terrainNoiseScale: 180.0,
  frostPatternNoiseScale: 30.0,     // sorted circles and stripes
  // Poisson-disc density targets (per hectare) — mirrored from VEGETATION
  treeDensityPerHa: 0,
  shrubDensityPerHa: VEGETATION.shrubDensityPerHa,
  groundCoverDensityPerHa: VEGETATION.groundCoverDensityPerHa,
  // LOD scale thresholds (world units)
  lodHighDistance: 600.0,           // low relief, but detail matters up close
  lodMidDistance: 2500.0,
  lodLowDistance: 12000.0,
  // Procedural event budgets
  maxFireEventsPerTick: 0,          // fire is negligible
  maxErosionEventsPerTick: 2,       // freeze–thaw and solifluction
  maxGrowthEventsPerTick: 2
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING ────────────────────────────────────────
// Fuses temperature, humidity, elevation, slope, soil texture, and water-table
// depth into a single 0–1 weight. 328_BiomeBlendField uses this to decide how
// much of the tundra biome applies at any world point. Permafrost presence
// (proxied by very cold mean temperature and shallow water table) is the
// dominant discriminator.
// ══════════════════════════════════════════════════════════════════
const _scratchVec3 = new Vec3();
const _scratchNoise = new SimplexNoise();

/**
 * Compute the tundra suitability at a world position and environmental state.
 * All inputs are expected to come from the context frame or from provider
 * summaries. The function allocates nothing after module initialisation.
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
  // ─── Temperature: tundra is centred on very cold means with cool summers ─
  // Optimal mean annual temperature ≈ -15 °C; summer must stay below ~18 °C.
  const tempScore = smoothstep(-45.0, -5.0, env.temperatureC) * (1.0 - smoothstep(12.0, 22.0, env.temperatureC));

  // ─── Humidity: surface is waterlogged despite low precipitation ────────
  const humidityScore = smoothstep(0.50, 0.80, env.humidity);

  // ─── Elevation: lowland Arctic or high alpine ──────────────────────────
  const elevScore =
    0.60 * smoothstep(0.0, 200.0, env.elevationM) * (1.0 - smoothstep(500.0, 800.0, env.elevationM)) +
    0.40 * smoothstep(1500.0, 2500.0, env.elevationM);

  // ─── Slope: flat to moderately steep (alpine tundra) ───────────────────
  const slopeScore = smoothstep(0.0, 5.0, env.slopeDeg) * (1.0 - smoothstep(30.0, 50.0, env.slopeDeg));

  // ─── Soil texture: silt-loam with organic matter is typical ───────────
  const textureScore =
    0.40 * smoothstep(0.25, 0.50, env.soilSilt) +
    0.30 * smoothstep(0.15, 0.40, env.soilSand) +
    0.30 * (1.0 - smoothstep(0.10, 0.30, env.soilClay));

  // ─── Water table: extremely shallow due to permafrost impedance ────────
  const waterScore = 1.0 - smoothstep(0.10, 0.60, env.waterTableDepthM);

  // ─── Patchiness: patterned ground and frost boils break the field ─────
  const patchiness = env.noise !== undefined ? (0.80 + 0.20 * env.noise) : 1.0;

  // ─── Weighted fusion ────────────────────────────────────────────────
  const raw =
    0.32 * tempScore +
    0.15 * humidityScore +
    0.15 * elevScore +
    0.08 * slopeScore +
    0.12 * textureScore +
    0.18 * waterScore;

  return Math.max(0.0, Math.min(1.0, raw * patchiness));
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR EXPORT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const TundraBiome = Object.freeze({
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

export default TundraBiome;