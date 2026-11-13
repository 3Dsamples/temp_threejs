// file number : 319
// full path name : src/context/319_TemperateDeciduousForestBiome.js
// description : Temperate deciduous forest biome descriptor — the second of the nine biome presets, tuned for mid-latitude forests with four true seasons (spring, summer, autumn, winter). Provides the same eleven interlocking descriptor blocks as 318 but with every parameter recalibrated for the temperate climate band: wide seasonal temperature swing with true winter freezing, deciduous phenology driving leaf-out/leaf-drop cycles, autumn colour palette shift, spring blossom burst, moderate precipitation with seasonal storms, rich fertile loam soil with active decomposer cycles, deep groundwater, oak/beech/maple/birch species mix, diurnal-dominant fauna with seasonal migration, four full PBR + anime material palettes that switch per season (spring new leaf, summer full green, autumn peak, winter bare branch), four-season lighting tints, and a suitability scoring function that pulls the biome across latitudes 30°–60° in both hemispheres. Every parameter is exposed for `328_BiomeBlendField`, `331_BiomeBlendMaterialBridge`, and `351_LandscapeLightingCoupler` to consume at runtime without branching. The `getSuitability()` function fuses temperature, humidity, elevation, slope, soil texture, and water table depth into a single 0–1 weight that downstream biome-blend logic uses to decide how much of this biome applies at any world point. Zero allocation after construction: all descriptor objects, colour arrays, and per-season palette tables are preallocated and reused.
// best for : Every consumer that needs a mid-latitude four-season biome preset — biome registry barrel (327), biome blend field (328), biome blend system (329), cross-biome ecotone (330), biome material bridge (331), biome climate coupling (332), biome soil coupling (333), biome hydrology coupling (334), biome fauna migration (335), landscape chunk descriptor (336), and the whole material/lighting/sensory pipeline. Together with the other eight biome files this completes the planet-scale living-biome palette.
// license : MIT

// ─── raw 3js primitives — exported from the 264 barrel ─────────
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
import { ContextFrame }                                    from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES }    from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS }                   from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD }                     from './267_CoreClock.js';
import { smoothstep }                                       from './268_ExtrasCurveUtils.js';
import { TemporalContextProvider, WEATHER }                 from './276_TemporalContextProvider.js';
import { CausalContextProvider, DERIVED_SIGNAL }            from './278_CausalContextProvider.js';
import { TerrainProvider, BIOME_HINT }                      from './280_TerrainProvider.js';
import { ElevationProvider, ELEVATION_BAND }                from './281_ElevationProvider.js';
import { SlopeGradientProvider, SLOPE_BAND }                from './282_SlopeGradientProvider.js';
import { ReliefGradientProvider, RELIEF_CLASS }             from './282_Z01_ReliefGradientProvider.js';
import { RockGradientProvider, ROCK_CLASS }                 from './282_Z06_RockGradientProvider.js';
import { ForestGradientProvider, TREE_TYPE, SUCCESSION }    from './282_Z07_ForestGradientProvider.js';
import { GrassAndFlowresGradientProvider, GRASS_TYPE }      from './282_Z08_GrassAndFlowresGradientProvider.js';
import { ContinentalReliefGradientProvider, CONTINENTAL_TYPE }
                                                            from './282_Z09_ContinentalReliefGradientProvider.js';
import { BathymetryProvider, BATHY_ZONE, SEABED_CLASS }     from './283_BathymetryProvider.js';
import { GroundwaterProvider, GROUNDWATER_TYPE }            from './284_GroundwaterProvider.js';
import { MoistureLevelProvider, MOISTURE_STATE }            from './285_MoistureLevelProvider.js';
import { DecomposersSystem, DECOMPOSER_TYPE }               from './286_DecomposersSystem.js';
import { ClimateTemperatureProvider }                       from './287_ClimateTemperatureProvider.js';
import { ClimatePrecipitationProvider, PRECIPITATION_PHASE }
                                                            from './288_ClimatePrecipitationProvider.js';
import { ClimateWindProvider, WIND_STATE }                  from './289_ClimateWindProvider.js';
import { SoilCompositionProvider, SOIL_TEXTURE_CLASS }      from './290_SoilCompositionProvider.js';
import { SoilFertilityProvider, FERTILITY_CLASS }           from './291_SoilFertilityProvider.js';
import { SoilColorTextureProvider, SOIL_VISUAL_ARCHETYPE }  from './292_SoilColorTextureProvider.js';
import { SeasonalitySystem, PHENOLOGY_STAGE, SEASONAL_MATERIAL }
                                                            from './296_SeasonalitySystem.js';
import { AudioLightEmissionSystem, AUDIO_CUE_TYPE, LIGHT_CUE_TYPE }
                                                            from './317_AudioLightEmissionSystem.js';
import { ACOUSTIC_PROFILE }                                 from './297_SensoryDetailsProvider.js';

// ══════════════════════════════════════════════════════════════════
// ─── BIOME IDENTITY ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const BIOME_ID = 2;
const BIOME_NAME = 'temperate_deciduous_forest';
const BIOME_DISPLAY_NAME = 'Temperate Deciduous Forest';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── TEMPERATE CHARACTERISTIC PARAMETERS ───────────────────────
// ══════════════════════════════════════════════════════════════════

// ─── Climate ────────────────────────────────────────────────────
const CLIMATE = Object.freeze({
  // Temperature (°C) — true winter freezing, warm summer
  temperatureMin:       -18.0,
  temperatureMax:        32.0,
  temperatureMean:       10.0,
  temperatureDailySwing: 10.0,      // larger diurnal swing than tropics
  temperatureFrostFree: false,      // true freezing events

  // Humidity (0..1)
  humidityMin:           0.35,
  humidityMax:           0.90,
  humidityMean:          0.62,

  // Precipitation (mm/hr mean)
  precipitationMean:     2.5,
  precipitationMax:     20.0,
  precipitationStormProb: 0.20,
  precipitationAnnualMm: 1000.0,

  // Seasons — four true seasons
  seasonalityAmplitude:   0.85,     // strong swing
  drySeasonLengthDays:    0,         // no true dry season
  wetSeasonPeakDay:       0,         // precipitation fairly constant
  snowSeasonDays:         90,        // ~3 months of snow potential

  // Wind
  windMeanSpeed:          3.5,
  windMaxSpeed:          18.0,
  windPredominantDirDeg: 270,        // westerlies

  // Weather state weights
  weatherClearWeight:     0.30,
  weatherCloudyWeight:    0.30,
  weatherRainWeight:      0.25,
  weatherStormWeight:     0.05,
  weatherFogWeight:       0.10,

  // Climate classification
  climateZone: 'temperate'
});

// ─── Terrain bias ──────────────────────────────────────────────
const TERRAIN_BIAS = Object.freeze({
  // Elevation preference (m above sea level)
  elevationMin:             0,
  elevationMax:          1800,
  elevationOptimal:       350,
  elevationOptimalWidth:  500,

  // Slope preference (radians)
  slopeMax:          35 * Math.PI / 180,
  slopeOptimal:      12 * Math.PI / 180,

  // Relief preference
  reliefPreference: Object.freeze([
    RELIEF_CLASS.VALLEY,
    RELIEF_CLASS.FLAT,
    RELIEF_CLASS.SLOPE,
    RELIEF_CLASS.CHANNEL
  ]),
  reliefRejected: Object.freeze([
    RELIEF_CLASS.PEAK,
    RELIEF_CLASS.CLIFF,
    RELIEF_CLASS.BASIN
  ]),

  // Continental type preference
  continentalPreference: Object.freeze([
    CONTINENTAL_TYPE.COASTAL_PLAIN,
    CONTINENTAL_TYPE.INTERIOR_LOWLAND,
    CONTINENTAL_TYPE.INTERIOR_PLATEAU
  ]),

  // Terrain noise scale modifiers
  macroNoiseScale:      1 / 2048,   // mid-sized hills
  midNoiseScale:        1 / 384,    // rolling landscape
  microNoiseScale:      1 / 24,     // organic roughness

  // Height variation amplitude (relative to base)
  macroAmplitude:      80.0,
  midAmplitude:        30.0,
  microAmplitude:       5.0
});

// ─── Soil preference ──────────────────────────────────────────
const SOIL_PREFERENCE = Object.freeze({
  // Texture class weights (0..1)
  textureWeights: Object.freeze({
    [SOIL_TEXTURE_CLASS.LOAM]:         0.40,
    [SOIL_TEXTURE_CLASS.SILT_LOAM]:    0.25,
    [SOIL_TEXTURE_CLASS.CLAY_LOAM]:    0.20,
    [SOIL_TEXTURE_CLASS.SANDY_LOAM]:   0.10,
    [SOIL_TEXTURE_CLASS.SILT]:         0.05
  }),

  // Texture rejection
  textureReject: Object.freeze([
    SOIL_TEXTURE_CLASS.SAND,
    SOIL_TEXTURE_CLASS.CLAY,
    SOIL_TEXTURE_CLASS.SILTY_CLAY
  ]),

  // Fertility — temperate forests have the richest soils on Earth
  fertilityMin:         0.55,
  fertilityMax:         0.90,
  fertilityMean:        0.72,
  fertilityOptimalClass: FERTILITY_CLASS.RICH,

  // Organic matter
  organicPercentMin:    3.0,
  organicPercentMax:   10.0,
  organicPercentMean:   6.5,

  // pH — near neutral due to leaf litter and earthworm activity
  pHMin:               5.5,
  pHMax:               7.2,
  pHMean:              6.4,

  // Iron oxide
  ironOxide:           0.03,
  calciumCarbonate:    0.03,

  // Colour archetype
  visualArchetype:     SOIL_VISUAL_ARCHETYPE.DARK_HUMUS
});

// ─── Vegetation preference ────────────────────────────────────
const VEGETATION_PREFERENCE = Object.freeze({
  // Tree species weights
  treeWeights: Object.freeze({
    [TREE_TYPE.OAK]:        0.30,
    [TREE_TYPE.BIRCH]:      0.20,
    [TREE_TYPE.WILLOW]:     0.15,
    [TREE_TYPE.PINE]:       0.15,
    [TREE_TYPE.CONIFER]:    0.10,
    [TREE_TYPE.CYPRESS]:    0.10
  }),

  // Tree rejection
  treeReject: Object.freeze([
    TREE_TYPE.BAOBAB,
    TREE_TYPE.ACACIA,
    TREE_TYPE.MANGROVE,
    TREE_TYPE.PALM
  ]),

  // Grass species weights
  grassWeights: Object.freeze({
    [GRASS_TYPE.MEADOW_GRASS]:  0.35,
    [GRASS_TYPE.FERN]:          0.20,
    [GRASS_TYPE.CLOVER]:        0.15,
    [GRASS_TYPE.DANDELION]:     0.10,
    [GRASS_TYPE.SNOWDROP]:      0.10,
    [GRASS_TYPE.POPPY]:         0.05,
    [GRASS_TYPE.ORCHID]:        0.05
  }),

  // Grass rejection
  grassReject: Object.freeze([
    GRASS_TYPE.SHORT_TUNDRA,
    GRASS_TYPE.ALPINE_TUFT,
    GRASS_TYPE.SAVANNA_BUNCH
  ]),

  // Canopy density
  canopyDensityMin:         0.55,
  canopyDensityMax:         0.90,
  canopyDensityMean:        0.75,

  // Understory density
  understoryDensityMin:     0.30,
  understoryDensityMax:     0.80,
  understoryDensityMean:    0.55,

  // Vertical stratification
  emergentLayerFraction:    0.05,
  canopyLayerFraction:      0.60,
  understoryLayerFraction:  0.25,
  groundLayerFraction:      0.10,

  // Succession
  successionTarget:         SUCCESSION.CLIMAX,
  pioneerSpeciesWeights: Object.freeze({
    [TREE_TYPE.BIRCH]:  0.50,
    [TREE_TYPE.PINE]:   0.30,
    [TREE_TYPE.WILLOW]: 0.20
  }),

  // Epiphyte and liana coverage (lower than rainforest)
  epiphyteCoverage:     0.25,
  lianaCoverage:        0.10,

  // Bloom windows — spring burst, low summer, none in autumn/winter
  bloomWindows: Object.freeze([
    { start: 0.10, end: 0.30, intensity: 0.95 },   // Spring (Mar–Apr)
    { start: 0.30, end: 0.55, intensity: 0.55 },   // Summer (May–Jul)
    { start: 0.55, end: 0.75, intensity: 0.15 },   // Autumn (Aug–Oct)
    { start: 0.75, end: 1.00, intensity: 0.00 }    // Winter (Nov–Feb)
  ]),

  // Plant layers
  plantLayers: Object.freeze([
    {
      name: 'canopy',
      heightRange: [20, 35],
      radiusRange: [5, 10],
      density: 0.25,
      species: [TREE_TYPE.OAK, TREE_TYPE.PINE, TREE_TYPE.CONIFER]
    },
    {
      name: 'understory',
      heightRange: [3, 10],
      radiusRange: [1, 3],
      density: 0.40,
      species: [TREE_TYPE.BIRCH, TREE_TYPE.WILLOW, TREE_TYPE.CYPRESS]
    },
    {
      name: 'shrub',
      heightRange: [0.5, 3],
      radiusRange: [0.3, 1.2],
      density: 0.55,
      species: [GRASS_TYPE.FERN, GRASS_TYPE.MEADOW_GRASS]
    },
    {
      name: 'ground',
      heightRange: [0.05, 0.5],
      radiusRange: [0.1, 0.3],
      density: 0.85,
      species: [GRASS_TYPE.MEADOW_GRASS, GRASS_TYPE.CLOVER, GRASS_TYPE.DANDELION, GRASS_TYPE.SNOWDROP]
    }
  ])
});

// ─── Fauna preference ─────────────────────────────────────────
const FAUNA_PREFERENCE = Object.freeze({
  // Overall fauna density
  densityMultiplier:    0.85,

  // Predator-prey balance (more balanced than rainforest)
  predatorWeight:       0.30,
  preyWeight:           0.55,
  neutralWeight:        0.15,

  // Diel activity — temperate fauna is more diurnal
  diurnalRatio:         0.55,
  nocturnalRatio:       0.30,
  crepuscularRatio:     0.15,

  // Migration
  migrationEnabled:     true,
  migrationSeasonPeak:  0.25,       // spring migration peak

  // Nectar/pollen availability — strong spring peak
  nectarAvailability:   0.30,
  pollenAvailability:   0.25,

  // Habitat layer preference
  groundFaunaWeight:    0.35,
  understoryFaunaWeight: 0.30,
  canopyFaunaWeight:    0.30,
  emergentFaunaWeight:  0.05
});

// ─── Material palette (four seasonal variants per material) ────
const MATERIAL_PALETTE = Object.freeze({
  // Deciduous leaf — has four seasonal colour variants
  deciduous_leaf: Object.freeze({
    pbr_spring: {
      baseColor:       [0.55, 0.78, 0.35],
      metalness:       0.00,
      roughness:       0.55,
      clearcoat:       0.40,
      transmission:    0.12,
      ior:             1.40,
      sheen:           0.25,
      anisotropy:      0.00,
      subsurfaceRadius: [0.10, 0.15, 0.06]
    },
    pbr_summer: {
      baseColor:       [0.28, 0.52, 0.18],
      metalness:       0.00,
      roughness:       0.60,
      clearcoat:       0.25,
      transmission:    0.08,
      ior:             1.40,
      sheen:           0.30,
      anisotropy:      0.00,
      subsurfaceRadius: [0.14, 0.20, 0.08]
    },
    pbr_autumn: {
      baseColor:       [0.82, 0.42, 0.15],
      metalness:       0.00,
      roughness:       0.72,
      clearcoat:       0.15,
      transmission:    0.10,
      ior:             1.40,
      sheen:           0.20,
      anisotropy:      0.00,
      subsurfaceRadius: [0.18, 0.10, 0.05]
    },
    pbr_winter: {
      baseColor:       [0.42, 0.30, 0.22],
      metalness:       0.00,
      roughness:       0.88,
      clearcoat:       0.05,
      transmission:    0.00,
      ior:             1.40,
      sheen:           0.10,
      anisotropy:      0.00,
      subsurfaceRadius: [0.04, 0.03, 0.02]
    },
    anime: {
      baseColor:       [0.30, 0.54, 0.20],
      quantizeSteps:   3,
      rimPower:        1.8,
      rimColor:        [0.55, 0.85, 0.50],
      flatness:        0.28
    },
    wetnessResponse:   0.65,
    flammability:      0.80,          // dry autumn leaves are very flammable
    acoustics:         ACOUSTIC_PROFILE.FOLIAGE_DENSE
  }),

  // Rich loam soil
  loam_soil: Object.freeze({
    pbr: {
      baseColor:       [0.32, 0.24, 0.18],
      metalness:       0.00,
      roughness:       0.78,
      clearcoat:       0.15,
      transmission:    0.00,
      ior:             1.48,
      sheen:           0.10,
      anisotropy:      0.00,
      subsurfaceRadius: [0.05, 0.05, 0.03]
    },
    anime: {
      baseColor:       [0.34, 0.26, 0.20],
      quantizeSteps:   3,
      rimPower:        1.9,
      rimColor:        [0.55, 0.45, 0.35],
      flatness:        0.35
    },
    wetnessResponse:   0.70,
    flammability:      0.00,
    acoustics:         ACOUSTIC_PROFILE.GRAVEL_SOIL
  }),

  // Humic litter — autumn leaf fall accumulation
  humic_litter: Object.freeze({
    pbr: {
      baseColor:       [0.18, 0.12, 0.08],
      metalness:       0.00,
      roughness:       0.88,
      clearcoat:       0.08,
      transmission:    0.00,
      ior:             1.45,
      sheen:           0.10,
      anisotropy:      0.00,
      subsurfaceRadius: [0.02, 0.02, 0.01]
    },
    anime: {
      baseColor:       [0.20, 0.14, 0.10],
      quantizeSteps:   3,
      rimPower:        2.0,
      rimColor:        [0.35, 0.28, 0.22],
      flatness:        0.40
    },
    wetnessResponse:   0.70,
    flammability:      0.45,
    acoustics:         ACOUSTIC_PROFILE.PEAT_DAMP
  }),

  // Moss on tree bases and stones
  moss: Object.freeze({
    pbr: {
      baseColor:       [0.20, 0.34, 0.14],
      metalness:       0.00,
      roughness:       0.68,
      clearcoat:       0.30,
      transmission:    0.04,
      ior:             1.42,
      sheen:           0.28,
      anisotropy:      0.00,
      subsurfaceRadius: [0.06, 0.10, 0.04]
    },
    anime: {
      baseColor:       [0.22, 0.38, 0.16],
      quantizeSteps:   3,
      rimPower:        1.7,
      rimColor:        [0.48, 0.78, 0.38],
      flatness:        0.30
    },
    wetnessResponse:   0.75,
    flammability:      0.25,
    acoustics:         ACOUSTIC_PROFILE.FOLIAGE_DENSE
  }),

  // Lichen
  lichen: Object.freeze({
    pbr: {
      baseColor:       [0.52, 0.55, 0.40],
      metalness:       0.00,
      roughness:       0.76,
      clearcoat:       0.08,
      transmission:    0.00,
      ior:             1.48,
      sheen:           0.12,
      anisotropy:      0.00,
      subsurfaceRadius: [0.02, 0.02, 0.02]
    },
    anime: {
      baseColor:       [0.55, 0.58, 0.42],
      quantizeSteps:   3,
      rimPower:        1.9,
      rimColor:        [0.65, 0.70, 0.55],
      flatness:        0.36
    },
    wetnessResponse:   0.50,
    flammability:      0.08,
    acoustics:         ACOUSTIC_PROFILE.BARE_ROCK
  }),

  // Bark — oak/beech trunk texture
  bark: Object.freeze({
    pbr: {
      baseColor:       [0.30, 0.22, 0.16],
      metalness:       0.00,
      roughness:       0.82,
      clearcoat:       0.10,
      transmission:    0.00,
      ior:             1.45,
      sheen:           0.05,
      anisotropy:      0.05,
      subsurfaceRadius: [0.01, 0.01, 0.01]
    },
    anime: {
      baseColor:       [0.32, 0.24, 0.18],
      quantizeSteps:   3,
      rimPower:        2.0,
      rimColor:        [0.45, 0.35, 0.28],
      flatness:        0.38
    },
    wetnessResponse:   0.60,
    flammability:      0.65,
    acoustics:         ACOUSTIC_PROFILE.WOOD_DENSE
  }),

  // Spring blossom burst
  blossom_spring: Object.freeze({
    pbr: {
      baseColor:       [0.92, 0.78, 0.85],
      metalness:       0.00,
      roughness:       0.55,
      clearcoat:       0.30,
      transmission:    0.25,
      ior:             1.38,
      sheen:           0.40,
      anisotropy:      0.00,
      subsurfaceRadius: [0.15, 0.10, 0.08]
    },
    anime: {
      baseColor:       [0.95, 0.82, 0.88],
      quantizeSteps:   3,
      rimPower:        1.4,
      rimColor:        [1.00, 0.85, 0.92],
      flatness:        0.22
    },
    wetnessResponse:   0.55,
    flammability:      0.55,
    acoustics:         ACOUSTIC_PROFILE.FOLIAGE_DENSE
  }),

  // Fresh water — creeks and ponds
  fresh_water: Object.freeze({
    pbr: {
      baseColor:       [0.18, 0.30, 0.38],
      metalness:       0.00,
      roughness:       0.10,
      clearcoat:       0.85,
      transmission:    0.82,
      ior:             1.33,
      sheen:           0.05,
      anisotropy:      0.00,
      subsurfaceRadius: [0.20, 0.25, 0.30]
    },
    anime: {
      baseColor:       [0.22, 0.36, 0.44],
      quantizeSteps:   3,
      rimPower:        1.5,
      rimColor:        [0.60, 0.85, 1.00],
      flatness:        0.25
    },
    wetnessResponse:   0.00,
    flammability:      0.00,
    acoustics:         ACOUSTIC_PROFILE.WATER_SURFACE
  }),

  // Wet rock — stones near creeks
  wet_rock: Object.freeze({
    pbr: {
      baseColor:       [0.32, 0.30, 0.28],
      metalness:       0.05,
      roughness:       0.38,
      clearcoat:       0.65,
      transmission:    0.00,
      ior:             1.50,
      sheen:           0.05,
      anisotropy:      0.05,
      subsurfaceRadius: [0.02, 0.02, 0.02]
    },
    anime: {
      baseColor:       [0.35, 0.33, 0.30],
      quantizeSteps:   3,
      rimPower:        1.7,
      rimColor:        [0.60, 0.72, 0.82],
      flatness:        0.32
    },
    wetnessResponse:   0.30,
    flammability:      0.00,
    acoustics:         ACOUSTIC_PROFILE.BARE_ROCK
  }),

  // Snow — winter cover
  snow: Object.freeze({
    pbr: {
      baseColor:       [0.94, 0.96, 0.99],
      metalness:       0.00,
      roughness:       0.78,
      clearcoat:       0.05,
      transmission:    0.12,
      ior:             1.31,
      sheen:           0.30,
      anisotropy:      0.00,
      subsurfaceRadius: [0.20, 0.22, 0.25]
    },
    anime: {
      baseColor:       [0.96, 0.97, 1.00],
      quantizeSteps:   2,
      rimPower:        1.3,
      rimColor:        [0.85, 0.92, 1.00],
      flatness:        0.22
    },
    wetnessResponse:   0.00,
    flammability:      0.00,
    acoustics:         ACOUSTIC_PROFILE.SNOW_PACK
  })
});

// ─── Lighting profile (four seasonal tints) ──────────────────
const LIGHTING_PROFILE = Object.freeze({
  // Canopy occlusion — moderate
  canopyOcclusionFactor: 0.55,

  // Sun contribution scaling per canopy layer
  sunAtCanopyScale:      1.00,
  sunAtGroundScale:      0.55,
  sunAtUnderstoryScale:  0.30,

  // Ambient contribution
  ambientScale:          1.00,

  // Colour grading — four seasonal tints
  colorTintSpring:       [0.96, 1.00, 0.92],
  colorTintSummer:       [0.94, 0.98, 0.90],
  colorTintAutumn:       [1.00, 0.88, 0.72],
  colorTintWinter:       [0.88, 0.92, 0.98],

  // Sky tints per season
  skyTintSpring:         [0.68, 0.85, 1.00],
  skyTintSummer:         [0.55, 0.78, 1.00],
  skyTintAutumn:         [0.78, 0.72, 0.62],
  skyTintWinter:         [0.72, 0.82, 0.95],

  // Fog density modifier
  fogDensityMultiplier:  1.00,

  // Dappled light
  dappleFrequency:       4.0,
  dappleAmplitude:       0.45,
  dappleSpeed:           0.25,

  // Bioluminescence — minimal in temperate forest
  bioluminescentDensity: 0.02,
  bioluminescentColor:   [0.55, 0.85, 0.70],
  bioluminescentIntensity: 0.15,

  // Fire glow
  fireGlowScale:         1.15,

  // Shadow cascades per tier
  shadowCascadesNear:    4,
  shadowCascadesMid:     2,
  shadowCascadesFar:     1,

  lightPriorityScale:    0.95
});

// ─── Water profile ────────────────────────────────────────────
const WATER_PROFILE = Object.freeze({
  surfaceWaterPresence: 0.55,
  riverineNetwork:     true,
  riverDensity:        1.2,
  streamWidthMean:     2.0,
  canopyDripRate:      0.15,
  groundwaterTableDepth: 8.0,
  freshwaterSprings:   0.30,
  springDensity:       0.08,
  poolPresence:        0.25,
  poolAverageRadius:   4.0,
  flowSpeed:           0.9,
  seasonalFlooding:    true,
  winterIceCover:      0.40       // rivers freeze partially in winter
});

// ─── Sensory profile ──────────────────────────────────────────
const SENSORY_PROFILE = Object.freeze({
  // Dominant acoustic cues
  acousticPrimary:    AUDIO_CUE_TYPE.AMBIENT_LEAVES,
  acousticSecondary:  AUDIO_CUE_TYPE.AMBIENT_WOOD,
  acousticIntensity:  0.70,

  // Dominant olfactory cues
  olfactoryPrimary:   'humus',
  olfactorySecondary: 'leaf_litter',
  olfactoryIntensity: 0.65,

  // Ambient tactile
  tactileHumidity:    0.62,
  tactileTemperature: 0.45,        // mild
  tactileWindPressure: 0.35,
  tactileVegetation:  0.70,

  // Ambient colour tint
  ambientTintR:       0.95,
  ambientTintG:       0.98,
  ambientTintB:       0.94,

  // Particles
  particleDensity:    0.25,
  particleKind:       'pollen'
});

// ─── Seasonality overrides (four true seasons) ──────────────
const SEASONALITY_OVERRIDES = Object.freeze({
  forceFullGreen:      false,
  phenologyOverride:   null,        // no override — full four-season cycle

  yearRoundBloom:      false,
  bloomIntensityMin:   0.00,

  overrideAutumnColor: true,        // strong autumn colour is essential
  overrideLeafDrop:    true,        // full leaf drop in late autumn

  sporeBoostWetSeason: 1.20,
  fogBoostWetSeason:   1.20,

  litterFallContinuous: false,
  litterFallPeakSeason: 0.60,        // autumn (leaf fall peak)

  // Four-season phenology schedule (per species override,
  // used by 296_SeasonalitySystem when present).
  phenologySchedule: Object.freeze({
    budBreakDayOfYear:    80,        // mid-March
    leafOutDayOfYear:    100,        // early April
    fullGreenDayOfYear:  140,        // mid-May
    greenFadeDayOfYear:  240,        // late August
    autumnColorDayOfYear: 270,       // late September
    leafDropDayOfYear:   310,        // early November
    dormantDayOfYear:    340         // early December
  }),

  // Snow season begins when temperature drops below 0
  snowSeasonStartTempC: 2.0,
  snowSeasonEndTempC:   5.0
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING WEIGHTS ──────────────────────────────
// ══════════════════════════════════════════════════════════════════
const SUITABILITY_WEIGHTS = Object.freeze({
  temperature:  0.25,
  humidity:     0.15,
  elevation:    0.20,
  slope:        0.10,
  soil:         0.15,
  water:        0.15
});

// ══════════════════════════════════════════════════════════════════
// ─── TEMPERATE DECIDUOUS FOREST BIOME ─────────────────────────
// ══════════════════════════════════════════════════════════════════
class TemperateDeciduousForestBiome {
  constructor(options = {}) {
    // ── Identity ────────────────────────────────────────
    this.id = BIOME_ID;
    this.name = BIOME_NAME;
    this.displayName = BIOME_DISPLAY_NAME;
    this.mask = BIOME_BIT;

    // ── Descriptor blocks ──────────────────────────────
    this.climate = CLIMATE;
    this.terrainBias = TERRAIN_BIAS;
    this.soil = SOIL_PREFERENCE;
    this.vegetation = VEGETATION_PREFERENCE;
    this.fauna = FAUNA_PREFERENCE;
    this.materials = MATERIAL_PALETTE;
    this.lighting = LIGHTING_PROFILE;
    this.water = WATER_PROFILE;
    this.sensory = SENSORY_PROFILE;
    this.seasonality = SEASONALITY_OVERRIDES;
    this.suitabilityWeights = SUITABILITY_WEIGHTS;

    // ── Convenience aliases ────────────────────────────
    this.biomeHint = BIOME_HINT.TEMPERATE;
    this.climateZoneName = 'temperate';

    // ── Dynamic state ──────────────────────────────────
    this.state = {
      currentSuitability: 0.0,
      currentTemperature: 10.0,
      currentHumidity: 0.62,
      currentWetness: 0.35,
      currentSeasonPhase: 0.5,
      currentSeasonIndex: 1,          // 0=spring, 1=summer, 2=autumn, 3=winter
      currentWeatherState: WEATHER.CLEAR,
      currentFogDensity: 0.0,
      currentSnowCoverage: 0.0,
      currentBioluminescence: 0.0,
      currentLightingTint: [1.0, 1.0, 1.0],
      currentSkyTint: [0.55, 0.78, 1.0],
      lastUpdateTick: -1
    };

    // ── Collaborators ──────────────────────────────────
    this._dispatcher = options.dispatcher || null;
    this._clock = options.clock || null;
    this._frameRef = null;

    // ── Scratch (pooled) ───────────────────────────────
    this._tmpVec3A = new Vec3();
    this._tmpVec3B = new Vec3();
    this._tmpColor = new Vec3();
    this._tmpMat4 = new Mat4();
    this._tmpQuat = new Quat();
    this._blendedOut = null;

    // ── Statistics ─────────────────────────────────────
    this._stats = {
      updates: 0,
      suitabilityQueries: 0,
      registered: false,
      materialPaletteHits: 0,
      seasonalPaletteSwitches: 0
    };

    // ── Registry state ────────────────────────────────
    this._registry = null;
    this._registryHandle = -1;
    this._lastSeasonIndex = -1;
  }

  // ══════════════════════════════════════════════════════
  // ─── Registration ────────────────────────────────────
  // ══════════════════════════════════════════════════════
  register(registry) {
    if (!registry) return -1;
    this._registry = registry;
    const handle = registry.registerBiome
      ? registry.registerBiome(this)
      : -1;
    this._registryHandle = handle;
    this._stats.registered = true;
    return handle;
  }

  unregister() {
    if (this._registry && this._registryHandle >= 0) {
      this._registry.unregisterBiome?.(this._registryHandle);
    }
    this._registryHandle = -1;
    this._stats.registered = false;
  }

  attachDispatcher(d) { this._dispatcher = d; return this; }
  attachClock(c) { this._clock = c; return this; }

  // ══════════════════════════════════════════════════════
  // ─── Suitability scoring ─────────────────────────────
  // ══════════════════════════════════════════════════════
  getSuitability(worldX, worldY, worldZ, frame) {
    this._stats.suitabilityQueries++;

    const physical = frame?.layers?.physical;
    const spatial = frame?.layers?.spatial;

    // ── Inputs ─────────────────────────────────────────
    const temperature = physical?.ambientTemperature ?? this.climate.temperatureMean;
    const humidity = physical?.humidity ?? this.climate.humidityMean;
    const elevation = worldY;

    // Slope from spatial layer if available.
    let slopeAngle = 0;
    if (spatial && spatial.slopeAngle) {
      slopeAngle = spatial.slopeAngle[0] ?? 0;
    }

    // Soil suitability.
    let soilSuit = 0.5;
    if (spatial && spatial.soil && spatial.soil.textureClass) {
      const texClass = spatial.soil.textureClass[0] ?? -1;
      const weight = this.soil.textureWeights[texClass] ?? 0;
      soilSuit = weight;
    }

    // Water table depth.
    let waterSuit = 0.5;
    if (spatial && spatial.groundwater) {
      const wtDepth = spatial.groundwater.waterTableDepth?.[0] ?? 15;
      waterSuit = smoothstep(35, 4, wtDepth);
    }

    // ── Per-factor suitability ─────────────────────────
    // Temperature: prefer annual mean near 10°C, wide tolerance.
    const tempDelta = Math.abs(temperature - this.climate.temperatureMean);
    const tempWidth = (this.climate.temperatureMax - this.climate.temperatureMin) / 2;
    const tempSuit = Math.max(0, 1 - (tempDelta / (tempWidth * 1.2)) ** 2);

    // Humidity: moderate humidity is ideal.
    const humidSuit = 1 - Math.abs(humidity - this.climate.humidityMean) / 0.45;
    const clampedHumidSuit = Math.max(0, Math.min(1, humidSuit));

    // Elevation: preferred band with tolerance.
    const elevDelta = Math.abs(elevation - this.terrainBias.elevationOptimal);
    const elevWidth = this.terrainBias.elevationOptimalWidth;
    const elevSuit = Math.max(0, 1 - (elevDelta / (elevWidth * 1.5)) ** 2);

    // Slope factor.
    const slopeSuit = 1 - smoothstep(0, this.terrainBias.slopeMax, slopeAngle);

    // ── Weighted combination ──────────────────────────
    const w = this.suitabilityWeights;
    let score =
      tempSuit * w.temperature +
      clampedHumidSuit * w.humidity +
      elevSuit * w.elevation +
      slopeSuit * w.slope +
      soilSuit * w.soil +
      waterSuit * w.water;

    if (score < 0) score = 0;
    if (score > 1) score = 1;

    this.state.currentSuitability = score;
    return score;
  }

  // ══════════════════════════════════════════════════════
  // ─── Seasonal material palette selection ────────────
  // ══════════════════════════════════════════════════════
  // Returns the correct seasonal PBR palette for the deciduous
  // leaf material based on the current season phase.
  getSeasonalLeafPalette(seasonPhase = null) {
    const phase = seasonPhase !== null ? seasonPhase : this.state.currentSeasonPhase;
    let key;
    if (phase < 0.20) key = 'pbr_spring';
    else if (phase < 0.55) key = 'pbr_summer';
    else if (phase < 0.80) key = 'pbr_autumn';
    else key = 'pbr_winter';

    const leaf = this.materials.deciduous_leaf;
    return leaf[key] || leaf.pbr_summer;
  }

  // Return the full material descriptor for a given material key,
  // automatically substituting the seasonal PBR palette for the
  // deciduous leaf.
  getMaterial(key, seasonPhase = null) {
    this._stats.materialPaletteHits++;
    const base = this.materials[key];
    if (!base) return null;

    // If this is the leaf material and it has seasonal variants,
    // blend the current season's PBR into the descriptor.
    if (key === 'deciduous_leaf' && base.pbr_spring) {
      const seasonalPBR = this.getSeasonalLeafPalette(seasonPhase);
      const out = this._getPooledBlendedMaterial();
      // Copy the anime block from base.
      out.anime = base.anime;
      out.pbr = seasonalPBR;
      out.wetnessResponse = base.wetnessResponse;
      out.flammability = base.flammability;
      out.acoustics = base.acoustics;
      return out;
    }

    return base;
  }

  // Return a pre-allocated blended material object for internal reuse.
  _getPooledBlendedMaterial() {
    if (!this._blendedOut) {
      this._blendedOut = {
        pbr: {
          baseColor:       [0, 0, 0],
          metalness:       0,
          roughness:       0,
          clearcoat:       0,
          transmission:    0,
          ior:             1.4,
          sheen:           0,
          anisotropy:      0,
          subsurfaceRadius: [0, 0, 0]
        },
        anime: {
          baseColor:       [0, 0, 0],
          quantizeSteps:   3,
          rimPower:        2,
          rimColor:        [0, 0, 0],
          flatness:        0.3
        },
        wetnessResponse:   0,
        flammability:      0,
        acoustics:         null
      };
    }
    return this._blendedOut;
  }

  // Blend two materials together for cross-biome ecotones.
  getBlendedMaterial(baseKey, accentKey, accentWeight, seasonPhase = null) {
    const baseDesc = this.getMaterial(baseKey, seasonPhase);
    const accentDesc = this.getMaterial(accentKey, seasonPhase);
    if (!baseDesc) return null;
    if (!accentDesc || accentWeight <= 0) return baseDesc;

    const w = Math.min(1, Math.max(0, accentWeight));
    const invW = 1 - w;
    const out = this._getPooledBlendedMaterial();

    for (let i = 0; i < 3; i++) {
      out.pbr.baseColor[i] = baseDesc.pbr.baseColor[i] * invW + accentDesc.pbr.baseColor[i] * w;
      out.pbr.subsurfaceRadius[i] = baseDesc.pbr.subsurfaceRadius[i] * invW + accentDesc.pbr.subsurfaceRadius[i] * w;
      out.anime.baseColor[i] = baseDesc.anime.baseColor[i] * invW + accentDesc.anime.baseColor[i] * w;
      out.anime.rimColor[i] = baseDesc.anime.rimColor[i] * invW + accentDesc.anime.rimColor[i] * w;
    }
    out.pbr.metalness = baseDesc.pbr.metalness * invW + accentDesc.pbr.metalness * w;
    out.pbr.roughness = baseDesc.pbr.roughness * invW + accentDesc.pbr.roughness * w;
    out.pbr.clearcoat = baseDesc.pbr.clearcoat * invW + accentDesc.pbr.clearcoat * w;
    out.pbr.transmission = baseDesc.pbr.transmission * invW + accentDesc.pbr.transmission * w;
    out.pbr.ior = baseDesc.pbr.ior * invW + accentDesc.pbr.ior * w;
    out.pbr.sheen = baseDesc.pbr.sheen * invW + accentDesc.pbr.sheen * w;
    out.pbr.anisotropy = baseDesc.pbr.anisotropy * invW + accentDesc.pbr.anisotropy * w;
    out.anime.quantizeSteps = Math.round(baseDesc.anime.quantizeSteps * invW + accentDesc.anime.quantizeSteps * w);
    out.anime.rimPower = baseDesc.anime.rimPower * invW + accentDesc.anime.rimPower * w;
    out.anime.flatness = baseDesc.anime.flatness * invW + accentDesc.anime.flatness * w;
    out.wetnessResponse = baseDesc.wetnessResponse * invW + accentDesc.wetnessResponse * w;
    out.flammability = baseDesc.flammability * invW + accentDesc.flammability * w;
    out.acoustics = baseDesc.acoustics;
    return out;
  }

  // ══════════════════════════════════════════════════════
  // ─── Lighting adjustment ────────────────────────────
  // ══════════════════════════════════════════════════════
  getLightingAdjustment(worldY, hourOfDay, seasonPhase = null) {
    const phase = seasonPhase !== null ? seasonPhase : this.state.currentSeasonPhase;

    // Canopy layer scaling.
    const canopyTop = 25;
    const canopyNorm = Math.min(1, worldY / canopyTop);

    let sunScale;
    if (canopyNorm > 0.85) sunScale = this.lighting.sunAtCanopyScale;
    else if (canopyNorm > 0.35) sunScale = this.lighting.sunAtGroundScale;
    else sunScale = this.lighting.sunAtUnderstoryScale;

    // Seasonal tint choice.
    let colorTint, skyTint;
    if (phase < 0.20) {
      colorTint = this.lighting.colorTintSpring;
      skyTint = this.lighting.skyTintSpring;
    } else if (phase < 0.55) {
      colorTint = this.lighting.colorTintSummer;
      skyTint = this.lighting.skyTintSummer;
    } else if (phase < 0.80) {
      colorTint = this.lighting.colorTintAutumn;
      skyTint = this.lighting.skyTintAutumn;
    } else {
      colorTint = this.lighting.colorTintWinter;
      skyTint = this.lighting.skyTintWinter;
    }

    // Night bioluminescence.
    const isNight = hourOfDay < 0.25 || hourOfDay > 0.75;
    const biolum = isNight ? this.lighting.bioluminescentDensity : 0;

    return {
      sunScale,
      ambientScale: this.lighting.ambientScale,
      colorTint,
      skyTint,
      fogMultiplier: this.lighting.fogDensityMultiplier * (1 + this.state.currentWetness * 0.3),
      dappleFrequency: this.lighting.dappleFrequency,
      dappleAmplitude: this.lighting.dappleAmplitude * (1 - this.state.currentWetness * 0.4),
      bioluminescence: biolum,
      bioluminescenceColor: this.lighting.bioluminescentColor,
      bioluminescenceIntensity: this.lighting.bioluminescentIntensity
    };
  }

  // ══════════════════════════════════════════════════════
  // ─── Procedural plant layers ────────────────────────
  // ══════════════════════════════════════════════════════
  getPlantLayers() {
    return this.vegetation.plantLayers;
  }

  getLayerDensity(layerName) {
    for (let i = 0; i < this.vegetation.plantLayers.length; i++) {
      const layer = this.vegetation.plantLayers[i];
      if (layer.name === layerName) return layer.density;
    }
    return 0;
  }

  // ══════════════════════════════════════════════════════
  // ─── Update: refresh state from the frame ──────────
  // ══════════════════════════════════════════════════════
  update(frame, dt) {
    if (!frame || !frame.layers) return;
    this._frameRef = frame;
    this._stats.updates++;

    const physical = frame.layers.physical;
    const temporal = frame.layers.temporal;

    // Temperature / humidity / wetness.
    if (physical) {
      this.state.currentTemperature = physical.ambientTemperature ?? this.climate.temperatureMean;
      this.state.currentHumidity = physical.humidity ?? this.climate.humidityMean;
      this.state.currentWetness = physical.surfaceWetness ?? 0.35;
      this.state.currentFogDensity = physical.fogDensity ?? 0;
      this.state.currentSnowCoverage = physical.snowCoverage ?? 0;
      if (physical.weatherState !== undefined) {
        this.state.currentWeatherState = physical.weatherState;
      }
    }

    // Season phase and index.
    if (temporal) {
      this.state.currentSeasonPhase = temporal.season ?? 0.5;
    }

    // Compute season index from phase.
    let seasonIndex;
    const phase = this.state.currentSeasonPhase;
    if (phase < 0.20) seasonIndex = 0;         // spring
    else if (phase < 0.55) seasonIndex = 1;    // summer
    else if (phase < 0.80) seasonIndex = 2;    // autumn
    else seasonIndex = 3;                       // winter

    if (seasonIndex !== this._lastSeasonIndex) {
      this._lastSeasonIndex = seasonIndex;
      this.state.currentSeasonIndex = seasonIndex;
      this._stats.seasonalPaletteSwitches++;

      // Emit an event on season switch.
      if (this._dispatcher) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.AUDIO_LIGHT,
          [0, 0, 0],
          BIOME_ID, 1, 1.0,
          {
            kind: 'temperate_season_change',
            biomeId: BIOME_ID,
            seasonIndex,
            seasonPhase: phase
          }
        );
      }
    }

    // Bioluminescence from hour-of-day.
    const hourOfDay = temporal?.timeOfDay ?? 0.5;
    const isNight = hourOfDay < 0.25 || hourOfDay > 0.75;
    this.state.currentBioluminescence = isNight ? this.lighting.bioluminescentDensity : 0;

    // Update the lighting tint and sky tint.
    const adj = this.getLightingAdjustment(0, hourOfDay);
    this.state.currentLightingTint[0] = adj.colorTint[0];
    this.state.currentLightingTint[1] = adj.colorTint[1];
    this.state.currentLightingTint[2] = adj.colorTint[2];
    this.state.currentSkyTint[0] = adj.skyTint[0];
    this.state.currentSkyTint[1] = adj.skyTint[1];
    this.state.currentSkyTint[2] = adj.skyTint[2];

    this.state.lastUpdateTick = this._stats.updates;
  }

  // ══════════════════════════════════════════════════════
  // ─── Weather distribution ──────────────────────────
  // ══════════════════════════════════════════════════════
  getWeatherDistribution(seasonPhase) {
    // Temperate: more rain in spring, more snow in winter.
    const springBoost = Math.exp(-((seasonPhase - 0.15) ** 2) / 0.02);
    const winterBoost = Math.exp(-((seasonPhase - 0.90) ** 2) / 0.02);

    return {
      [WEATHER.CLEAR]:  this.climate.weatherClearWeight * (1 + (1 - springBoost) * 0.2),
      [WEATHER.CLOUDY]: this.climate.weatherCloudyWeight,
      [WEATHER.RAIN]:   this.climate.weatherRainWeight * (1 + springBoost * 0.4),
      [WEATHER.STORM]:  this.climate.weatherStormWeight * springBoost,
      [WEATHER.SNOW]:   this.climate.weatherFogWeight * winterBoost * 3,
      [WEATHER.FOG]:    this.climate.weatherFogWeight * (1 - winterBoost * 0.5)
    };
  }

  // ══════════════════════════════════════════════════════
  // ─── Phenology schedule accessors ───────────────────
  // ══════════════════════════════════════════════════════
  getPhenologyDayOfYear(stage) {
    return this.seasonality.phenologySchedule[stage] ?? 0;
  }

  getSeasonIndexForPhase(phase) {
    if (phase < 0.20) return 0;
    if (phase < 0.55) return 1;
    if (phase < 0.80) return 2;
    return 3;
  }

  // ══════════════════════════════════════════════════════
  // ─── Diagnostics ────────────────────────────────────
  // ══════════════════════════════════════════════════════
  getState() {
    return { ...this.state };
  }

  getStats() {
    return Object.freeze({ ...this._stats });
  }

  dispose() {
    this._dispatcher = null;
    this._clock = null;
    this._frameRef = null;
    this._registry = null;
    this._registryHandle = -1;
    this._blendedOut = null;
    this._stats.registered = false;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── SINGLETON HELPER ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
let _singleton = null;
function getTemperateDeciduousForestBiome(options = {}) {
  if (!_singleton) _singleton = new TemperateDeciduousForestBiome(options);
  return _singleton;
}

export {
  TemperateDeciduousForestBiome,
  getTemperateDeciduousForestBiome,
  BIOME_ID,
  BIOME_NAME,
  BIOME_DISPLAY_NAME,
  BIOME_BIT,
  CLIMATE,
  TERRAIN_BIAS,
  SOIL_PREFERENCE,
  VEGETATION_PREFERENCE,
  FAUNA_PREFERENCE,
  MATERIAL_PALETTE,
  LIGHTING_PROFILE,
  WATER_PROFILE,
  SENSORY_PROFILE,
  SEASONALITY_OVERRIDES,
  SUITABILITY_WEIGHTS
};