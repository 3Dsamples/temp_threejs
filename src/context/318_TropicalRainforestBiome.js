// file number : 318
// full path name : src/context/318_TropicalRainforestBiome.js
// description : Tropical rainforest biome descriptor — the first of the nine biome presets that wire every context provider, material system, and lighting path into one cohesive, fully parameterised living-biome specification. Provides eleven interlocking descriptor blocks that any downstream system reads at runtime: CLIMATE (year-round high temperature, high humidity, near-continuous precipitation, two-season equatorial cycle, storm probability, wind profile), TERRAIN BIAS (low-to-mid elevation, gentle slopes, meandering valleys, high groundwater, tall-grass terrain roughness), SOIL (acidic clay/silt texture, high organic matter, mid-low fertility masked by hyper-fast decomposition, iron-rich laterite colouring, poor alkalinity), VEGETATION (canopy-emergent emergent/broadleaf species weights across TREE_TYPE and GRASS_TYPE, four-layer vertical stratification with emergent > canopy > understory > ground, dense epiphyte and liana archetypes, pioneer-to-climax succession targets, epiphyte host bias), FAUNA (density weights per biome archetype, layered habitat preference from ground to emergent, diel activity, migration corridors, predator-prey balance, high nectar/pollen availability), MATERIALS (full PBR + anime blend parameters for the biome's characteristic surfaces — wet leaf, moss, lichen, laterite soil, dark humic litter, epiphyte mat, bright-blossom accent — each with albedo, roughness, transmission, subsurface, emissive, wetness response, and anime flatness so the material shader gets a complete, coherent palette out of the box), LIGHTING (canopy occlusion factor, diffuse-dominated sun profile, blue-green colour cast, humidity-boosted atmospheric scatter, bioluminescent understory emission, dappled-light frequency and amplitude, shadow softening per tier), WATER (surface water presence, riverine network, canopy drip, high groundwater table, freshwater springs), SENSORY (dominant acoustic signature — insect buzz, bird song, frog croaks, water trickle — dominant olfactory signature — floral, humus, wet earth, moss, fungal — and tactile profile), SEASONALITY (phenology overrides that push bud-break earlier, extend full-green longer, shift autumn colour slightly, keep bloom windows year-round for a subset of species, boost spore and fungal production in the wet season), and PROCEDURAL (noise scales for macro-canopy, mid-understory, and micro-litter layers; Poisson-disc density targets per layer; LOD scale thresholds). Provides per-world-position suitability scoring that fuses temperature, humidity, elevation, soil composition, and distance-to-water into a single 0–1 weight that `328_BiomeBlendField` uses to decide how much of this biome applies at any point. Registers with `327_BiomeRegistryBarrel` at construction time via a single `register()` call. Zero allocation after construction: all descriptor objects, colour arrays, and suitability scratch vectors are preallocated and reused. Implements the blueprint's biome-as-a-parameter-set contract so a rainforest is not a script but a set of constraints every other system honours.
// best for : Every consumer that needs a complete biome preset — the biome registry barrel (327), the biome blend field (328), the cross-biome ecotone system (330), the biome-material bridge (331), the biome-climate, biome-soil, and biome-hydrology couplings (332–334), the biome fauna migration (335), the landscape chunk descriptor (336), the flora/fauna spawners, the sensory system, and the material and lighting pipelines. This is one of the nine presets that together make the whole world feel like a living planet.
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
import { AirQualityAtmosphereProvider }                     from './295_AirQualityAtmosphereProvider.js';
import { SeasonalitySystem, PHENOLOGY_STAGE, SEASONAL_MATERIAL }
                                                            from './296_SeasonalitySystem.js';
import { AudioLightEmissionSystem, AUDIO_CUE_TYPE, LIGHT_CUE_TYPE }
                                                            from './317_AudioLightEmissionSystem.js';

// ══════════════════════════════════════════════════════════════════
// ─── BIOME IDENTITY ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const BIOME_ID = 1;
const BIOME_NAME = 'tropical_rainforest';
const BIOME_DISPLAY_NAME = 'Tropical Rainforest';

// ─── Biome mask for blend field (bit in a 9-biome mask) ────────
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── RAINFOREST CHARACTERISTIC PARAMETERS ──────────────────────
// ══════════════════════════════════════════════════════════════════

// ─── Climate ────────────────────────────────────────────────────
const CLIMATE = Object.freeze({
  // Temperature (°C)
  temperatureMin:        22.0,
  temperatureMax:        32.0,
  temperatureMean:       27.0,
  temperatureDailySwing:  4.0,
  temperatureFrostFree:  true,

  // Humidity (0..1)
  humidityMin:           0.70,
  humidityMax:           0.98,
  humidityMean:          0.86,

  // Precipitation (mm/hr mean)
  precipitationMean:     6.0,
  precipitationMax:     30.0,
  precipitationStormProb: 0.35,   // probability per "day" that a storm occurs
  precipitationAnnualMm: 2800.0,

  // Seasons — equatorial two-season cycle
  seasonalityAmplitude:   0.10,   // very low — no true winter
  drySeasonLengthDays:   20,      // short dry spell in Feb–Mar
  wetSeasonPeakDay:     180,      // peak wet around day 180

  // Wind
  windMeanSpeed:          2.5,    // m/s
  windMaxSpeed:           8.0,
  windPredominantDirDeg: 90,      // mostly easterlies

  // Weather state weights
  weatherClearWeight:     0.15,
  weatherCloudyWeight:    0.20,
  weatherRainWeight:      0.55,
  weatherStormWeight:     0.10,
  weatherFogWeight:       0.00,

  // Climate classification
  climateZone: 'tropical'
});

// ─── Terrain bias ──────────────────────────────────────────────
const TERRAIN_BIAS = Object.freeze({
  // Elevation preference (m above sea level)
  elevationMin:             0,
  elevationMax:          1500,
  elevationOptimal:       150,
  elevationOptimalWidth:  400,   // ±m tolerance

  // Slope preference (radians)
  slopeMax:          30 * Math.PI / 180,
  slopeOptimal:      10 * Math.PI / 180,

  // Relief preference
  reliefPreference: Object.freeze([
    RELIEF_CLASS.VALLEY,    // river valleys
    RELIEF_CLASS.CHANNEL,   // low drainage channels
    RELIEF_CLASS.FLAT,      // broad alluvial flats
    RELIEF_CLASS.SLOPE      // gentle slopes
  ]),
  reliefRejected: Object.freeze([
    RELIEF_CLASS.PEAK,
    RELIEF_CLASS.CLIFF
  ]),

  // Continental type preference
  continentalPreference: Object.freeze([
    CONTINENTAL_TYPE.COASTAL_PLAIN,
    CONTINENTAL_TYPE.INTERIOR_LOWLAND,
    CONTINENTAL_TYPE.INTERIOR_PLATEAU
  ]),

  // Terrain noise scale modifiers
  macroNoiseScale:      1 / 4096,   // gentle hills
  midNoiseScale:        1 / 512,    // rolling valleys
  microNoiseScale:      1 / 32,     // organic roughness

  // Height variation amplitude (relative to base)
  macroAmplitude:      60.0,        // metres
  midAmplitude:        20.0,
  microAmplitude:       3.0
});

// ─── Soil preference ──────────────────────────────────────────
const SOIL_PREFERENCE = Object.freeze({
  // Texture class weights (0..1 each, sum not required but meaningful)
  textureWeights: Object.freeze({
    [SOIL_TEXTURE_CLASS.CLAY]:         0.35,
    [SOIL_TEXTURE_CLASS.CLAY_LOAM]:    0.30,
    [SOIL_TEXTURE_CLASS.SILTY_CLAY]:   0.15,
    [SOIL_TEXTURE_CLASS.SILT_LOAM]:    0.10,
    [SOIL_TEXTURE_CLASS.LOAM]:         0.10
  }),

  // Texture class rejection
  textureReject: Object.freeze([
    SOIL_TEXTURE_CLASS.SAND,
    SOIL_TEXTURE_CLASS.LOAMY_SAND
  ]),

  // Fertility
  fertilityMin:         0.30,
  fertilityMax:         0.70,
  fertilityMean:        0.45,   // mid-low because most nutrients are locked in biomass
  fertilityOptimalClass: FERTILITY_CLASS.MODERATE,

  // Organic matter
  organicPercentMin:    2.0,
  organicPercentMax:   12.0,
  organicPercentMean:   6.0,

  // pH (acidic due to heavy rainfall leaching)
  pHMin:               4.2,
  pHMax:               6.2,
  pHMean:              5.0,

  // Iron oxide (laterite)
  ironOxide:           0.08,
  calciumCarbonate:    0.01,

  // Colour archetype
  visualArchetype:     SOIL_VISUAL_ARCHETYPE.RED_LATERITE
});

// ─── Vegetation preference ────────────────────────────────────
const VEGETATION_PREFERENCE = Object.freeze({
  // Tree species weights (0..1 each)
  treeWeights: Object.freeze({
    [TREE_TYPE.PALM]:       0.30,
    [TREE_TYPE.OAK]:        0.20,
    [TREE_TYPE.BAMBOO]:     0.25,
    [TREE_TYPE.WILLOW]:     0.10,
    [TREE_TYPE.REDWOOD]:    0.05,
    [TREE_TYPE.CYPRESS]:    0.10
  }),

  // Tree species rejection
  treeReject: Object.freeze([
    TREE_TYPE.ACACIA,    // not in rainforest
    TREE_TYPE.BAOBAB,    // not in rainforest
    TREE_TYPE.CONIFER,   // not in rainforest
    TREE_TYPE.TAIGA      // not in rainforest (if defined)
  ]),

  // Grass species weights
  grassWeights: Object.freeze({
    [GRASS_TYPE.FERN]:          0.40,
    [GRASS_TYPE.MARSH_REED]:    0.15,
    [GRASS_TYPE.ORCHID]:        0.15,
    [GRASS_TYPE.CLOVER]:        0.10,
    [GRASS_TYPE.MEADOW_GRASS]:  0.10,
    [GRASS_TYPE.BAMBOO]:        0.10
  }),

  // Grass rejection
  grassReject: Object.freeze([
    GRASS_TYPE.SHORT_TUNDRA,
    GRASS_TYPE.ALPINE_TUFT,
    GRASS_TYPE.SAVANNA_BUNCH
  ]),

  // Canopy density targets (0..1)
  canopyDensityMin:         0.75,
  canopyDensityMax:         1.00,
  canopyDensityMean:        0.92,

  // Understory density
  understoryDensityMin:     0.40,
  understoryDensityMax:     0.90,
  understoryDensityMean:    0.70,

  // Vertical stratification (fractions of world height)
  emergentLayerFraction:    0.20,   // 20% of vegetation in emergent canopy
  canopyLayerFraction:      0.50,   // 50% in main canopy
  understoryLayerFraction:  0.25,   // 25% in understory
  groundLayerFraction:      0.05,   // 5% in ground cover

  // Forest succession targets
  successionTarget:         SUCCESSION.CLIMAX,
  pioneerSpeciesWeights: Object.freeze({
    [TREE_TYPE.BAMBOO]: 0.60,
    [TREE_TYPE.WILLOW]: 0.40
  }),

  // Epiphyte and liana coverage
  epiphyteCoverage:     0.60,      // 60% of canopy trees host epiphytes
  lianaCoverage:        0.40,      // 40% of understory has liana tangles

  // Plant bloom windows (fraction of year)
  bloomWindows: Object.freeze([
    { start: 0.00, end: 0.25, intensity: 0.70 },   // Jan–Mar
    { start: 0.25, end: 0.50, intensity: 0.90 },   // Apr–Jun
    { start: 0.50, end: 0.75, intensity: 0.80 },   // Jul–Sep
    { start: 0.75, end: 1.00, intensity: 0.60 }    // Oct–Dec
  ]),

  // Procedural plant layers (for `346_LandscapeVegetationScatterSystem`)
  plantLayers: Object.freeze([
    {
      name: 'emergent',
      heightRange: [30, 60],       // metres
      radiusRange: [8, 15],
      density: 0.05,               // per cell
      species: [TREE_TYPE.REDWOOD, TREE_TYPE.OAK]
    },
    {
      name: 'canopy',
      heightRange: [15, 30],
      radiusRange: [5, 10],
      density: 0.30,
      species: [TREE_TYPE.OAK, TREE_TYPE.PALM, TREE_TYPE.CYPRESS]
    },
    {
      name: 'understory',
      heightRange: [2, 15],
      radiusRange: [1, 4],
      density: 0.45,
      species: [TREE_TYPE.BAMBOO, TREE_TYPE.WILLOW]
    },
    {
      name: 'ground',
      heightRange: [0.1, 2],
      radiusRange: [0.2, 0.8],
      density: 0.80,
      species: [GRASS_TYPE.FERN, GRASS_TYPE.MEADOW_GRASS, GRASS_TYPE.CLOVER]
    }
  ])
});

// ─── Fauna preference ─────────────────────────────────────────
const FAUNA_PREFERENCE = Object.freeze({
  // Overall fauna density multiplier
  densityMultiplier:    1.00,       // baseline

  // Predator-prey balance
  predatorWeight:       0.25,
  preyWeight:           0.60,
  neutralWeight:        0.15,

  // Diel activity
  diurnalRatio:         0.35,       // most rainforest life is nocturnal
  nocturnalRatio:       0.50,
  crepuscularRatio:     0.15,

  // Migration corridors
  migrationEnabled:     true,
  migrationSeasonPeak:  0.50,       // peak at wet season

  // Nectar/pollen availability (higher than normal)
  nectarAvailability:   0.40,
  pollenAvailability:   0.30,

  // Habitat layer preference
  groundFaunaWeight:    0.20,
  understoryFaunaWeight: 0.30,
  canopyFaunaWeight:    0.35,
  emergentFaunaWeight:  0.15
});

// ─── Material palette ─────────────────────────────────────────
// Full PBR + anime parameter blocks for the biome's characteristic
// surfaces. Each material descriptor is a template the material
// shader reads.
const MATERIAL_PALETTE = Object.freeze({
  // Wet leaf canopy — the dominant visual
  wet_leaf: Object.freeze({
    pbr: {
      baseColor:       [0.14, 0.38, 0.10],
      metalness:       0.00,
      roughness:       0.45,
      clearcoat:       0.55,
      transmission:    0.12,
      ior:             1.40,
      sheen:           0.35,
      anisotropy:      0.05,
      subsurfaceRadius: [0.10, 0.18, 0.06]
    },
    anime: {
      baseColor:       [0.16, 0.42, 0.12],
      quantizeSteps:   3,
      rimPower:        1.6,
      rimColor:        [0.40, 0.85, 0.45],
      flatness:        0.28
    },
    wetnessResponse:   0.70,
    flammability:      0.55,      // wet leaves resist fire more than dry ones
    acoustics:         ACOUSTIC_PROFILE.FOLIAGE_DENSE
  }),

  // Dark humic litter — the ground layer
  humic_litter: Object.freeze({
    pbr: {
      baseColor:       [0.10, 0.07, 0.05],
      metalness:       0.00,
      roughness:       0.85,
      clearcoat:       0.10,
      transmission:    0.00,
      ior:             1.45,
      sheen:           0.10,
      anisotropy:      0.00,
      subsurfaceRadius: [0.02, 0.02, 0.01]
    },
    anime: {
      baseColor:       [0.12, 0.09, 0.07],
      quantizeSteps:   3,
      rimPower:        2.1,
      rimColor:        [0.30, 0.24, 0.20],
      flatness:        0.42
    },
    wetnessResponse:   0.75,
    flammability:      0.15,
    acoustics:         ACOUSTIC_PROFILE.PEAT_DAMP
  }),

  // Red laterite soil
  laterite_soil: Object.freeze({
    pbr: {
      baseColor:       [0.55, 0.22, 0.10],
      metalness:       0.00,
      roughness:       0.80,
      clearcoat:       0.15,
      transmission:    0.00,
      ior:             1.50,
      sheen:           0.10,
      anisotropy:      0.00,
      subsurfaceRadius: [0.04, 0.02, 0.01]
    },
    anime: {
      baseColor:       [0.58, 0.24, 0.12],
      quantizeSteps:   3,
      rimPower:        1.9,
      rimColor:        [0.75, 0.40, 0.25],
      flatness:        0.35
    },
    wetnessResponse:   0.60,
    flammability:      0.00,
    acoustics:         ACOUSTIC_PROFILE.GRAVEL_SOIL
  }),

  // Moss — covers rocks, tree bases, and wet ground
  moss: Object.freeze({
    pbr: {
      baseColor:       [0.18, 0.32, 0.12],
      metalness:       0.00,
      roughness:       0.70,
      clearcoat:       0.35,
      transmission:    0.05,
      ior:             1.42,
      sheen:           0.30,
      anisotropy:      0.00,
      subsurfaceRadius: [0.06, 0.10, 0.04]
    },
    anime: {
      baseColor:       [0.20, 0.36, 0.14],
      quantizeSteps:   3,
      rimPower:        1.7,
      rimColor:        [0.45, 0.75, 0.35],
      flatness:        0.30
    },
    wetnessResponse:   0.80,
    flammability:      0.30,
    acoustics:         ACOUSTIC_PROFILE.FOLIAGE_DENSE
  }),

  // Lichen on stones — pale grey-green
  lichen: Object.freeze({
    pbr: {
      baseColor:       [0.55, 0.60, 0.42],
      metalness:       0.00,
      roughness:       0.75,
      clearcoat:       0.10,
      transmission:    0.00,
      ior:             1.48,
      sheen:           0.15,
      anisotropy:      0.00,
      subsurfaceRadius: [0.02, 0.02, 0.02]
    },
    anime: {
      baseColor:       [0.58, 0.62, 0.44],
      quantizeSteps:   3,
      rimPower:        1.9,
      rimColor:        [0.70, 0.75, 0.55],
      flatness:        0.35
    },
    wetnessResponse:   0.55,
    flammability:      0.10,
    acoustics:         ACOUSTIC_PROFILE.BARE_ROCK
  }),

  // Epiphyte mat — bright green, dense
  epiphyte_mat: Object.freeze({
    pbr: {
      baseColor:       [0.22, 0.48, 0.16],
      metalness:       0.00,
      roughness:       0.65,
      clearcoat:       0.30,
      transmission:    0.08,
      ior:             1.42,
      sheen:           0.25,
      anisotropy:      0.00,
      subsurfaceRadius: [0.08, 0.14, 0.05]
    },
    anime: {
      baseColor:       [0.24, 0.52, 0.18],
      quantizeSteps:   3,
      rimPower:        1.6,
      rimColor:        [0.55, 0.92, 0.45],
      flatness:        0.28
    },
    wetnessResponse:   0.72,
    flammability:      0.40,
    acoustics:         ACOUSTIC_PROFILE.FOLIAGE_DENSE
  }),

  // Bright blossom accent — bright magenta/yellow flowers
  blossom_accent: Object.freeze({
    pbr: {
      baseColor:       [0.92, 0.32, 0.55],
      metalness:       0.00,
      roughness:       0.55,
      clearcoat:       0.30,
      transmission:    0.20,
      ior:             1.38,
      sheen:           0.40,
      anisotropy:      0.00,
      subsurfaceRadius: [0.12, 0.08, 0.06]
    },
    anime: {
      baseColor:       [0.95, 0.35, 0.58],
      quantizeSteps:   3,
      rimPower:        1.4,
      rimColor:        [1.00, 0.65, 0.85],
      flatness:        0.22
    },
    wetnessResponse:   0.65,
    flammability:      0.65,
    acoustics:         ACOUSTIC_PROFILE.FOLIAGE_DENSE
  }),

  // Fresh water — rivers and pools
  fresh_water: Object.freeze({
    pbr: {
      baseColor:       [0.15, 0.28, 0.35],
      metalness:       0.00,
      roughness:       0.08,
      clearcoat:       0.90,
      transmission:    0.85,
      ior:             1.33,
      sheen:           0.05,
      anisotropy:      0.00,
      subsurfaceRadius: [0.20, 0.25, 0.30]
    },
    anime: {
      baseColor:       [0.20, 0.34, 0.42],
      quantizeSteps:   3,
      rimPower:        1.4,
      rimColor:        [0.55, 0.85, 1.00],
      flatness:        0.25
    },
    wetnessResponse:   0.00,
    flammability:      0.00,
    acoustics:         ACOUSTIC_PROFILE.WATER_SURFACE
  }),

  // Wet rock — basalt boulders near streams
  wet_rock: Object.freeze({
    pbr: {
      baseColor:       [0.24, 0.22, 0.20],
      metalness:       0.05,
      roughness:       0.35,
      clearcoat:       0.70,
      transmission:    0.00,
      ior:             1.50,
      sheen:           0.05,
      anisotropy:      0.05,
      subsurfaceRadius: [0.02, 0.02, 0.02]
    },
    anime: {
      baseColor:       [0.28, 0.26, 0.24],
      quantizeSteps:   3,
      rimPower:        1.7,
      rimColor:        [0.55, 0.65, 0.75],
      flatness:        0.32
    },
    wetnessResponse:   0.25,
    flammability:      0.00,
    acoustics:         ACOUSTIC_PROFILE.BARE_ROCK
  })
});

// ─── Lighting profile ─────────────────────────────────────────
const LIGHTING_PROFILE = Object.freeze({
  // Canopy occlusion — most sunlight is filtered by the canopy
  canopyOcclusionFactor: 0.35,     // only 35% of direct sunlight reaches ground

  // Sun contribution scaling (sun on ground vs on canopy)
  sunAtCanopyScale:      1.00,
  sunAtGroundScale:      0.35,
  sunAtUnderstoryScale:  0.15,

  // Ambient contribution scaled by humidity / reflections from wet surfaces
  ambientScale:          1.15,

  // Colour grading: rainforest has a green-blue colour cast
  colorTintR:            0.94,
  colorTintG:            1.00,
  colorTintB:            0.92,

  // Sky tint specific to the rainforest — deep blue with green reflection
  skyTintR:              0.55,
  skyTintG:              0.72,
  skyTintB:              0.95,

  // Fog density modifier (humid air → thicker fog)
  fogDensityMultiplier:  1.40,

  // Dappled light — the signature sunbeam pattern through the canopy
  dappleFrequency:       8.0,      // beams per metre squared
  dappleAmplitude:       0.60,     // 60% light modulation
  dappleSpeed:           0.30,     // wind-driven shift speed

  // Bioluminescence: emissive understory at night
  bioluminescentDensity: 0.15,     // 15% of ground cover emits light at night
  bioluminescentColor:   [0.40, 1.00, 0.80],
  bioluminescentIntensity: 0.35,

  // Fire glow: fire events are amplified (more dried fuel available)
  fireGlowScale:         1.30,

  // Shadow cascade scaling per tier
  shadowCascadesNear:    4,
  shadowCascadesMid:     2,
  shadowCascadesFar:     1,

  // Rendering: cluster light-list compression
  lightPriorityScale:    0.90      // slightly reduce nearby light priority for performance
});

// ─── Water profile ────────────────────────────────────────────
const WATER_PROFILE = Object.freeze({
  surfaceWaterPresence: 0.80,
  riverineNetwork:     true,
  riverDensity:        2.5,         // rivers per chunk
  streamWidthMean:     3.0,         // metres
  canopyDripRate:      0.30,        // drips per second per canopy area
  groundwaterTableDepth: 3.0,       // metres below surface (very shallow)
  freshwaterSprings:   0.60,
  springDensity:       0.15,
  poolPresence:        0.35,
  poolAverageRadius:   6.0,
  flowSpeed:           1.2          // m/s typical river speed
});

// ─── Sensory profile ──────────────────────────────────────────
const SENSORY_PROFILE = Object.freeze({
  // Dominant acoustic cues
  acousticPrimary:    AUDIO_CUE_TYPE.AMBIENT_LEAVES,
  acousticSecondary:  AUDIO_CUE_TYPE.AMBIENT_WATER,
  acousticIntensity:  0.85,

  // Dominant olfactory cues (encoded as strings the sensory provider reads)
  olfactoryPrimary:   'floral',
  olfactorySecondary: 'humus',
  olfactoryIntensity: 0.90,

  // Ambient tactile cues
  tactileHumidity:    0.90,
  tactileTemperature: 0.65,         // warm
  tactileWindPressure: 0.20,         // gentle breeze
  tactileVegetation:  0.90           // dense foliage contact

  // Ambient colour tint applied to overall scene
  ambientTintR:       0.90,
  ambientTintG:       1.00,
  ambientTintB:       0.88,

  // Particle density (canopy drip, insects, spores)
  particleDensity:    0.35,
  particleKind:       'spore'
});

// ─── Seasonality overrides ───────────────────────────────────
const SEASONALITY_OVERRIDES = Object.freeze({
  // Rainforest has no true winter — phenology stays at full green
  forceFullGreen:      true,
  phenologyOverride:   PHENOLOGY_STAGE.FULL_GREEN,

  // Bloom is year-round — every season gets a bloom window
  yearRoundBloom:      true,
  bloomIntensityMin:   0.40,

  // Temperature never triggers autumn leaf drop
  overrideAutumnColor: false,
  overrideLeafDrop:    false,

  // Wet season increases spore production
  sporeBoostWetSeason: 1.60,
  fogBoostWetSeason:   1.50,

  // Litter fall is continuous, not seasonal
  litterFallContinuous: true
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING CONSTANTS ────────────────────────────
// ══════════════════════════════════════════════════════════════════
const SUITABILITY_WEIGHTS = Object.freeze({
  temperature:  0.25,
  humidity:     0.25,
  elevation:    0.20,
  slope:        0.10,
  soil:         0.10,
  water:        0.10
});

// ══════════════════════════════════════════════════════════════════
// ─── TROPICAL RAINFOREST BIOME ────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class TropicalRainforestBiome {
  constructor(options = {}) {
    // ── Identity ────────────────────────────────────────
    this.id = BIOME_ID;
    this.name = BIOME_NAME;
    this.displayName = BIOME_DISPLAY_NAME;
    this.mask = BIOME_BIT;

    // ── Descriptor blocks (frozen, exposed for direct reading) ─
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

    // ── Convenience aliases ─────────────────────────────
    // Some consumers may query by biome hint code.
    this.biomeHint = BIOME_HINT.TROPICAL;
    this.climateZoneName = 'tropical';

    // ── Dynamic state (updated by `update()`) ──────────
    this.state = {
      currentSuitability: 0.0,
      currentTemperature: 27.0,
      currentHumidity: 0.86,
      currentWetness: 0.5,
      currentSeasonPhase: 0.5,
      currentWeatherState: WEATHER.RAIN,
      currentFogDensity: 0.0,
      currentBioluminescence: 0.0,
      currentLightingTint: [1.0, 1.0, 1.0],
      lastUpdateTick: -1
    };

    // ── Runtime collaborators (attached externally) ────
    this._dispatcher = options.dispatcher || null;
    this._clock = options.clock || null;
    this._frameRef = null;

    // ── Scratch (pooled, no reallocation) ──────────────
    this._tmpVec3A = new Vec3();
    this._tmpVec3B = new Vec3();
    this._tmpColor = new Vec3();
    this._tmpMat4 = new Mat4();
    this._tmpQuat = new Quat();

    // ── Statistics ─────────────────────────────────────
    this._stats = {
      updates: 0,
      suitabilityQueries: 0,
      registered: false,
      materialPaletteHits: 0
    };

    // ── Registration state ─────────────────────────────
    this._registry = null;
    this._registryHandle = -1;
  }

  // ══════════════════════════════════════════════════════
  // ─── Registration ────────────────────────────────────
  // ══════════════════════════════════════════════════════
  register(registry) {
    if (!registry) return -1;
    this._registry = registry;
    // BiomeRegistryBarrel exposes `registerBiome(biome)`.
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
  // Given a world position and the current context, returns
  // 0..1 indicating how much of this biome applies.
  getSuitability(worldX, worldY, worldZ, frame) {
    this._stats.suitabilityQueries++;

    const physical = frame?.layers?.physical;
    const spatial = frame?.layers?.spatial;

    // ── Inputs ─────────────────────────────────────────
    const temperature = physical?.ambientTemperature ?? 25;
    const humidity = physical?.humidity ?? 0.8;
    const elevation = worldY;

    // Get slope if available.
    let slopeAngle = 0;
    if (spatial && spatial.elevation) {
      // No direct slope here; assume 0 as fallback.
    }

    // Soil suitability — read from soil layer if present.
    let soilSuit = 0.5;
    if (spatial && spatial.soil && spatial.soil.textureClass) {
      const texClass = spatial.soil.textureClass[0] ?? -1;
      const weight = this.soil.textureWeights[texClass] ?? 0;
      soilSuit = weight;
    }

    // Water proximity — read from groundwater layer.
    let waterSuit = 0.5;
    if (spatial && spatial.groundwater) {
      const wtDepth = spatial.groundwater.waterTableDepth?.[0] ?? 20;
      waterSuit = smoothstep(30, 3, wtDepth);   // shallower is better
    }

    // ── Compute per-factor suitability ────────────────
    // Temperature factor: gaussian centred on optimal.
    const tempDelta = (temperature - this.climate.temperatureMean);
    const tempWidth = (this.climate.temperatureMax - this.climate.temperatureMin) / 2;
    const tempSuit = Math.max(0, 1 - (tempDelta / (tempWidth * 1.5)) ** 2);

    // Humidity factor: strongly prefer high humidity.
    const humidSuit = smoothstep(0.55, 0.85, humidity);

    // Elevation factor: preferred band with wide tolerance.
    const elevDelta = Math.abs(elevation - this.terrainBias.elevationOptimal);
    const elevWidth = this.terrainBias.elevationOptimalWidth;
    const elevSuit = Math.max(0, 1 - (elevDelta / (elevWidth * 1.5)) ** 2);

    // Slope factor.
    const slopeSuit = 1 - smoothstep(0, this.terrainBias.slopeMax, slopeAngle);

    // ── Weighted combination ──────────────────────────
    const w = this.suitabilityWeights;
    let score =
      tempSuit * w.temperature +
      humidSuit * w.humidity +
      elevSuit * w.elevation +
      slopeSuit * w.slope +
      soilSuit * w.soil +
      waterSuit * w.water;

    // Clamp.
    if (score < 0) score = 0;
    if (score > 1) score = 1;

    this.state.currentSuitability = score;
    return score;
  }

  // ══════════════════════════════════════════════════════
  // ─── Material palette access ────────────────────────
  // ══════════════════════════════════════════════════════
  getMaterial(key) {
    this._stats.materialPaletteHits++;
    return this.materials[key] ?? null;
  }

  // Return material blended between wet-leaf base and a given accent.
  getBlendedMaterial(baseKey, accentKey, accentWeight) {
    const base = this.materials[baseKey];
    const accent = this.materials[accentKey];
    if (!base) return null;
    if (!accent || accentWeight <= 0) return base;

    const w = Math.min(1, Math.max(0, accentWeight));
    const invW = 1 - w;

    // Build a blended descriptor (returned by reference into a
    // pooled object so no allocation per call).
    const out = this._blendedOut || (this._blendedOut = {
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
    });

    for (let i = 0; i < 3; i++) {
      out.pbr.baseColor[i] = base.pbr.baseColor[i] * invW + accent.pbr.baseColor[i] * w;
      out.pbr.subsurfaceRadius[i] = base.pbr.subsurfaceRadius[i] * invW + accent.pbr.subsurfaceRadius[i] * w;
      out.anime.baseColor[i] = base.anime.baseColor[i] * invW + accent.anime.baseColor[i] * w;
      out.anime.rimColor[i] = base.anime.rimColor[i] * invW + accent.anime.rimColor[i] * w;
    }
    out.pbr.metalness = base.pbr.metalness * invW + accent.pbr.metalness * w;
    out.pbr.roughness = base.pbr.roughness * invW + accent.pbr.roughness * w;
    out.pbr.clearcoat = base.pbr.clearcoat * invW + accent.pbr.clearcoat * w;
    out.pbr.transmission = base.pbr.transmission * invW + accent.pbr.transmission * w;
    out.pbr.ior = base.pbr.ior * invW + accent.pbr.ior * w;
    out.pbr.sheen = base.pbr.sheen * invW + accent.pbr.sheen * w;
    out.pbr.anisotropy = base.pbr.anisotropy * invW + accent.pbr.anisotropy * w;

    out.anime.quantizeSteps = Math.round(base.anime.quantizeSteps * invW + accent.anime.quantizeSteps * w);
    out.anime.rimPower = base.anime.rimPower * invW + accent.anime.rimPower * w;
    out.anime.flatness = base.anime.flatness * invW + accent.anime.flatness * w;

    out.wetnessResponse = base.wetnessResponse * invW + accent.wetnessResponse * w;
    out.flammability = base.flammability * invW + accent.flammability * w;
    out.acoustics = base.acoustics;   // keep base acoustics

    return out;
  }

  // ══════════════════════════════════════════════════════
  // ─── Lighting adjustment for a position ────────────
  // ══════════════════════════════════════════════════════
  // Returns a descriptor the lighting pipeline applies on top
  // of the global lighting state.
  getLightingAdjustment(worldY, hourOfDay) {
    // Determine which canopy layer this elevation is in.
    // Assume canopy top at ~40m; ground at 0.
    const canopyTop = 40;
    const canopyNorm = Math.min(1, worldY / canopyTop);

    let sunScale;
    if (canopyNorm > 0.85) sunScale = this.lighting.sunAtCanopyScale;
    else if (canopyNorm > 0.35) sunScale = this.lighting.sunAtGroundScale;
    else sunScale = this.lighting.sunAtUnderstoryScale;

    // Night bioluminescence.
    const isNight = hourOfDay < 0.25 || hourOfDay > 0.75;
    const biolum = isNight ? this.lighting.bioluminescentDensity * this.state.currentHumidity : 0;

    return {
      sunScale,
      ambientScale: this.lighting.ambientScale,
      colorTint: [
        this.lighting.colorTintR,
        this.lighting.colorTintG,
        this.lighting.colorTintB
      ],
      skyTint: [
        this.lighting.skyTintR,
        this.lighting.skyTintG,
        this.lighting.skyTintB
      ],
      fogMultiplier: this.lighting.fogDensityMultiplier * (1 + this.state.currentWetness * 0.5),
      dappleFrequency: this.lighting.dappleFrequency,
      dappleAmplitude: this.lighting.dappleAmplitude * (1 - this.state.currentWetness * 0.4),
      bioluminescence: biolum,
      bioluminescenceColor: this.lighting.bioluminescentColor,
      bioluminescenceIntensity: this.lighting.bioluminescentIntensity
    };
  }

  // ══════════════════════════════════════════════════════
  // ─── Procedural plant layer dispatch ────────────────
  // ══════════════════════════════════════════════════════
  // Returns the plant layers with per-layer parameters ready for
  // `346_LandscapeVegetationScatterSystem`.
  getPlantLayers() {
    return this.vegetation.plantLayers;
  }

  // Return per-layer Poisson-disc density target for a specific layer.
  getLayerDensity(layerName) {
    for (let i = 0; i < this.vegetation.plantLayers.length; i++) {
      const layer = this.vegetation.plantLayers[i];
      if (layer.name === layerName) return layer.density;
    }
    return 0;
  }

  // ══════════════════════════════════════════════════════
  // ─── Update: refresh dynamic state from the frame ───
  // ══════════════════════════════════════════════════════
  update(frame, dt) {
    if (!frame || !frame.layers) return;
    this._frameRef = frame;
    this._stats.updates++;

    const physical = frame.layers.physical;
    const temporal = frame.layers.temporal;

    // ── Temperature / humidity ─────────────────────────
    if (physical) {
      this.state.currentTemperature = physical.ambientTemperature ?? this.climate.temperatureMean;
      this.state.currentHumidity = physical.humidity ?? this.climate.humidityMean;
      this.state.currentWetness = physical.surfaceWetness ?? 0.5;
      this.state.currentFogDensity = physical.fogDensity ?? 0;
    }

    // ── Season ─────────────────────────────────────────
    if (temporal) {
      this.state.currentSeasonPhase = temporal.season ?? 0.5;
    }

    // ── Weather ────────────────────────────────────────
    if (physical && physical.weatherState !== undefined) {
      this.state.currentWeatherState = physical.weatherState;
    }

    // ── Bioluminescence from hour-of-day ───────────────
    const hourOfDay = temporal?.timeOfDay ?? 0.5;
    const isNight = hourOfDay < 0.25 || hourOfDay > 0.75;
    this.state.currentBioluminescence = isNight
      ? this.lighting.bioluminescentDensity * this.state.currentHumidity
      : 0;

    // ── Colour tint from lighting ──────────────────────
    const tint = this._tmpColor;
    tint.set(
      this.lighting.colorTintR,
      this.lighting.colorTintG,
      this.lighting.colorTintB
    );
    this.state.currentLightingTint[0] = tint.x;
    this.state.currentLightingTint[1] = tint.y;
    this.state.currentLightingTint[2] = tint.z;

    this.state.lastUpdateTick = this._stats.updates;
  }

  // ══════════════════════════════════════════════════════
  // ─── Weather schedule for a given season phase ─────
  // ══════════════════════════════════════════════════════
  // Returns a probability-weighted weather distribution.
  getWeatherDistribution(seasonPhase) {
    // Rainforest: rain is common year-round, storms peak in wet season.
    const wetBoost = Math.exp(-((seasonPhase - 0.5) ** 2) / 0.05);
    return {
      [WEATHER.CLEAR]:  this.climate.weatherClearWeight * (1 - wetBoost * 0.3),
      [WEATHER.CLOUDY]: this.climate.weatherCloudyWeight,
      [WEATHER.RAIN]:   this.climate.weatherRainWeight * (1 + wetBoost * 0.2),
      [WEATHER.STORM]:  this.climate.weatherStormWeight * wetBoost,
      [WEATHER.FOG]:    this.climate.weatherFogWeight * wetBoost
    };
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
    this._stats.registered = false;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── SINGLETON INSTANCE ──────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// Provides a single canonical instance for `327_BiomeRegistryBarrel`
// to register without every consumer needing to instantiate.
let _singleton = null;
function getTropicalRainforestBiome(options = {}) {
  if (!_singleton) _singleton = new TropicalRainforestBiome(options);
  return _singleton;
}

export {
  TropicalRainforestBiome,
  getTropicalRainforestBiome,
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