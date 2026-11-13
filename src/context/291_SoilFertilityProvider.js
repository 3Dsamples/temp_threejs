// file number : 291
// full path name : src/context/291_SoilFertilityProvider.js
// description : Soil fertility provider computing the nutrient-rich vs nutrient-poor classification that drives flora density, plant growth rate, microbial activity, and ecosystem productivity across the living world. Reads soil composition (texture fractions, pH, organic percent, USLE K-factor, humus) from 290_SoilCompositionProvider, nutrient release (N, P, K) from 286_DecomposersSystem, soil moisture from 284_GroundwaterProvider, temperature from 287_ClimateTemperatureProvider, precipitation from 288_ClimatePrecipitationProvider, and groundwater proximity from 284. Computes three independent nutrient availabilities using the Liebig minimum law A = min(A_N, A_P, A_K) so the scarcest nutrient caps growth, plus a fourth micronutrient availability (Fe, Mn, Zn, Cu, B, Mo) tied to soil pH (peaking at pH 6.0–7.0 and dropping hard below 5.0 for most micronutrients and above 8.0 for iron and manganese). Combines nutrient availability, moisture factor, temperature factor, and pH suitability into a single fertility index F ∈ [0,1] via a multiplicative model F = F_Nutrients · F_Moisture · F_Temperature · F_pH · F_Texture, then maps this to fertility classes (BARREN, POOR, MODERATE, RICH, VERY_RICH). Provides growing degree day (GDD) coupling so plant growth per day = F · GDD_rate, per-species nutrient preferences via a lookup table for 15 soil-preference types (acid-loving, calcareous, nitrogen-fixing, potassium-hungry, etc.), and per-species suitability scores that 282_Z07_ForestGradientProvider and 282_Z08_GrassAndFlowresGradientProvider read to determine which plants can actually grow where. Provides full PBR + anime material parameter sets for fertile vs barren soil surfaces — healthy dark humus-rich soil, iron-poor chlorotic soil, calcium-rich chalky soil, nitrogen-deficient pale soil, potassium-deficient stunted soil — all live scalars the shader reads for subtle colour modulation. Emits a single coalesced ECOLOGY causal event per chunk when fertility crosses a class boundary (poor → moderate → rich) so plants and fauna react to improving or degrading soil. Writes per-chunk summaries into frame.layers.spatial.fertility and global aggregates into frame.layers.physical.fertilityProperties. All scratch objects are pooled; no allocation after the first frame.
// best for : Every consumer that needs soil fertility state — LandscapeVegetationScatterSystem (346) for plant placement density, BiomeBlendField (328) for biome vegetation density, LandscapeFaunaSpawnSystem (347) for herbivore carrying capacity, DecomposersSystem (286) for feedback into decomposition rates, SoilFertilityProvider's own per-species suitability table for the forest and grass providers, materials for fertile vs barren soil colouring, and EcologyResponseSystem (316) for vegetation spread dynamics. Complements 290 (soil composition), 286 (decomposers), and 284 (groundwater) by closing the pedogenesis-to-plant-growth loop.
// license : MIT

// ─── raw 3js primitives — exported by the 264 barrel ────────────
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision,
  ColorManagement, ColorSpace,
  Ray, Plane, Sphere,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems — each from its own file ────────
import { ContextFrame }                                    from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES }    from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS }                   from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD }                     from './267_CoreClock.js';
import { smoothstep, CURVE_KIND }                           from './268_ExtrasCurveUtils.js';
import { TemporalContextProvider, WEATHER, WEATHER_NAMES, WEATHER_SEVERITY }
                                                            from './276_TemporalContextProvider.js';
import { CausalContextProvider, DERIVED_SIGNAL }            from './278_CausalContextProvider.js';
import { TerrainProvider, BIOME_HINT }                      from './280_TerrainProvider.js';
import { ElevationProvider, ELEVATION_BAND, ATMOSPHERE }    from './281_ElevationProvider.js';
import { SlopeGradientProvider, SLOPE_BAND, SLOPE_BAND_THRESHOLDS }
                                                            from './282_SlopeGradientProvider.js';
import { ReliefGradientProvider, RELIEF_CLASS }             from './282_Z01_ReliefGradientProvider.js';
import { CliffsGradientProvider, CLIFF_CLASS }              from './282_Z02_CliffsGradientProvider.js';
import { CarveGradientProvider, CARVE_SOURCE, CARVE_MATERIAL_BAND }
                                                            from './282_Z03_CarveGradientProvider.js';
import { RockGradientProvider, ROCK_CLASS, ROCK_CLASS_NAMES }
                                                            from './282_Z06_RockGradientProvider.js';
import { ForestGradientProvider, TREE_TYPE, TREE_TYPE_NAMES, SUCCESSION }
                                                            from './282_Z07_ForestGradientProvider.js';
import { GrassAndFlowresGradientProvider, GRASS_TYPE, GRASS_TYPE_NAMES }
                                                            from './282_Z08_GrassAndFlowresGradientProvider.js';
import { ContinentalReliefGradientProvider, CONTINENTAL_TYPE }
                                                            from './282_Z09_ContinentalReliefGradientProvider.js';
import { BathymetryProvider, BATHY_ZONE, SEABED_CLASS }     from './283_BathymetryProvider.js';
import { GroundwaterProvider, GROUNDWATER_TYPE }            from './284_GroundwaterProvider.js';
import { MoistureLevelProvider, MOISTURE_STATE }            from './285_MoistureLevelProvider.js';
import { DecomposersSystem, DECOMPOSER_TYPE }               from './286_DecomposersSystem.js';
import { ClimateTemperatureProvider, CLIMATE_ZONE }         from './287_ClimateTemperatureProvider.js';
import { ClimatePrecipitationProvider, PRECIPITATION_PHASE }
                                                            from './288_ClimatePrecipitationProvider.js';
import { ClimateWindProvider, WIND_STATE }                  from './289_ClimateWindProvider.js';
import { SoilCompositionProvider, SOIL_TEXTURE_CLASS, SOIL_TEXTURE_NAMES, SOIL_PROPERTIES }
                                                            from './290_SoilCompositionProvider.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 0.5;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── fertility classes ──────────────────────────────────────────
const FERTILITY_CLASS = Object.freeze({
  BARREN:       0,   // F < 0.10
  POOR:         1,   // 0.10 – 0.30
  MODERATE:     2,   // 0.30 – 0.55
  RICH:         3,   // 0.55 – 0.80
  VERY_RICH:    4    // > 0.80
});

const FERTILITY_CLASS_NAMES = Object.freeze([
  'barren', 'poor', 'moderate', 'rich', 'very_rich'
]);

// ─── fertility class thresholds ────────────────────────────────
const FERTILITY_THRESHOLDS = Object.freeze([
  0.10, 0.30, 0.55, 0.80
]);

// ─── nutrient limitation model ─────────────────────────────────
// Liebig's law of the minimum: growth is capped by the scarcest
// nutrient. A_N, A_P, A_K, A_micro are individual availability
// scores (0..1), and A_total = min(them).
const NUTRIENT_CONSTANTS = Object.freeze({
  // Optimal soil pH for nutrient availability.
  phOptimalMin: 6.0,
  phOptimalMax: 7.0,
  phAbsoluteMin: 3.5,
  phAbsoluteMax: 9.5,

  // Nutrient availability response curves.
  // Nitrogen availability peaks at pH 6.5 and with high organic matter.
  nitrogenOptimalPh: 6.5,
  nitrogenOptimalOM: 5.0,        // percent
  nitrogenMinOM: 0.5,

  // Phosphorus availability peaks at pH 6.0-6.5; drops fast below 5.5 and above 7.5.
  phosphorusOptimalPh: 6.2,
  phosphorusMinOM: 0.2,

  // Potassium availability peaks at pH 6.0-7.0.
  potassiumOptimalPh: 6.5,
  potassiumMinOM: 0.3,

  // Micronutrients: Fe, Mn at low pH; Mo at high pH; Zn, Cu, B near neutral.
  micronutrientOptimalPh: 6.5,

  // CEC (cation exchange capacity) — from texture class.
  cecSand: 3.0,         // meq/100g
  cecLoam: 15.0,
  cecClay: 40.0,
  cecOrganicBoost: 100.0,  // meq/100g per unit organic fraction

  // Texture-quality factor: loam is best, extremes are worse.
  textureQualityOptimal: SOIL_TEXTURE_CLASS.LOAM,
  textureQualitySiltLoam: SOIL_TEXTURE_CLASS.SILT_LOAM,
  textureQualityFalloff: 1.5
});

// ─── growth-rate model ─────────────────────────────────────────
// Plant growth per day = F · GDD_rate · speciesModifier
const GROWTH_CONSTANTS = Object.freeze({
  baseGrowthRate: 0.02,          // metres of growth per day at F = 1
  temperatureThreshold: 5.0,     // °C
  temperatureOptimal: 25.0,      // °C
  moistureThreshold: 0.10,       // VWC
  moistureOptimal: 0.55,         // VWC
  nutrientThreshold: 0.05,       // F_nutrients below this = no growth
  gddWeighting: 0.001,           // converts GDD to growth boost

  // N-P-K absolute pool caps (kg/m²) — accumulation rate is capped.
  nPoolMax: 0.050,
  pPoolMax: 0.010,
  kPoolMax: 0.030,
  microPoolMax: 0.005,

  // Depletion rates when plants are actively growing.
  nDepletionRate: 0.0001,
  pDepletionRate: 0.00005,
  kDepletionRate: 0.00008,
  microDepletionRate: 0.00002
});

// ─── per-soil-preference suitability table ────────────────────
// Each archetype has preferred pH range, organic content, moisture,
// and nutrient emphasis. Used by 282_Z07 and 282_Z08 for placement.
const SOIL_PREFERENCE = Object.freeze({
  ACID_LOVING: {
    phMin: 3.5, phMax: 5.5, phOptimal: 4.5,
    omMin: 2.0, omOptimal: 6.0,
    moistureMin: 0.30, moistureOptimal: 0.60,
    nitrogenWeight: 0.3, phosphorusWeight: 0.2, potassiumWeight: 0.2, microWeight: 0.3
  },
  NEUTRAL: {
    phMin: 5.5, phMax: 7.5, phOptimal: 6.5,
    omMin: 1.5, omOptimal: 5.0,
    moistureMin: 0.25, moistureOptimal: 0.55,
    nitrogenWeight: 0.4, phosphorusWeight: 0.3, potassiumWeight: 0.2, microWeight: 0.1
  },
  CALCAREOUS: {
    phMin: 7.0, phMax: 9.0, phOptimal: 8.0,
    omMin: 0.5, omOptimal: 3.0,
    moistureMin: 0.15, moistureOptimal: 0.40,
    nitrogenWeight: 0.3, phosphorusWeight: 0.2, potassiumWeight: 0.3, microWeight: 0.2
  },
  BOG: {
    phMin: 3.0, phMax: 5.5, phOptimal: 4.0,
    omMin: 15.0, omOptimal: 30.0,
    moistureMin: 0.60, moistureOptimal: 0.90,
    nitrogenWeight: 0.2, phosphorusWeight: 0.1, potassiumWeight: 0.1, microWeight: 0.6
  },
  ARID: {
    phMin: 6.5, phMax: 9.0, phOptimal: 7.8,
    omMin: 0.2, omOptimal: 1.5,
    moistureMin: 0.05, moistureOptimal: 0.25,
    nitrogenWeight: 0.4, phosphorusWeight: 0.3, potassiumWeight: 0.2, microWeight: 0.1
  },
  NITROGEN_FIXING: {
    phMin: 5.5, phMax: 8.0, phOptimal: 7.0,
    omMin: 0.5, omOptimal: 3.0,
    moistureMin: 0.20, moistureOptimal: 0.50,
    nitrogenWeight: 0.1, phosphorusWeight: 0.4, potassiumWeight: 0.3, microWeight: 0.2
  },
  POTASSIUM_HUNGRY: {
    phMin: 5.5, phMax: 7.5, phOptimal: 6.5,
    omMin: 1.5, omOptimal: 4.0,
    moistureMin: 0.25, moistureOptimal: 0.55,
    nitrogenWeight: 0.2, phosphorusWeight: 0.2, potassiumWeight: 0.5, microWeight: 0.1
  },
  PHOSPHORUS_HUNGRY: {
    phMin: 5.5, phMax: 7.5, phOptimal: 6.2,
    omMin: 1.5, omOptimal: 4.0,
    moistureMin: 0.25, moistureOptimal: 0.55,
    nitrogenWeight: 0.2, phosphorusWeight: 0.5, potassiumWeight: 0.2, microWeight: 0.1
  },
  MICRONUTRIENT_SENSITIVE: {
    phMin: 5.5, phMax: 7.5, phOptimal: 6.5,
    omMin: 1.0, omOptimal: 4.0,
    moistureMin: 0.25, moistureOptimal: 0.55,
    nitrogenWeight: 0.2, phosphorusWeight: 0.2, potassiumWeight: 0.2, microWeight: 0.4
  }
});

const SOIL_PREFERENCE_NAMES = Object.freeze([
  'acid_loving', 'neutral', 'calcareous', 'bog', 'arid',
  'nitrogen_fixing', 'potassium_hungry', 'phosphorus_hungry',
  'micronutrient_sensitive'
]);

// ─── map each tree species to a preferred soil archetype ──────
const TREE_SOIL_PREFERENCE = Object.freeze({
  [TREE_TYPE.OAK]:      'NEUTRAL',
  [TREE_TYPE.PINE]:     'ACID_LOVING',
  [TREE_TYPE.BIRCH]:    'NEUTRAL',
  [TREE_TYPE.REDWOOD]:  'ACID_LOVING',
  [TREE_TYPE.ACACIA]:   'ARID',
  [TREE_TYPE.BAOBAB]:   'ARID',
  [TREE_TYPE.PALM]:     'NEUTRAL',
  [TREE_TYPE.WILLOW]:   'BOG',
  [TREE_TYPE.BAMBOO]:   'NEUTRAL',
  [TREE_TYPE.CONIFER]:  'ACID_LOVING',
  [TREE_TYPE.MANGROVE]: 'BOG',
  [TREE_TYPE.CYPRESS]:  'BOG'
});

// ─── map each grass species to a preferred soil archetype ─────
const GRASS_SOIL_PREFERENCE = Object.freeze({
  [GRASS_TYPE.MEADOW_GRASS]:  'NEUTRAL',
  [GRASS_TYPE.TALL_PRAIRIE]:  'NEUTRAL',
  [GRASS_TYPE.SHORT_TUNDRA]:  'ACID_LOVING',
  [GRASS_TYPE.ALPINE_TUFT]:   'CALCAREOUS',
  [GRASS_TYPE.SAVANNA_BUNCH]: 'ARID',
  [GRASS_TYPE.MARSH_REED]:    'BOG',
  [GRASS_TYPE.FERN]:          'ACID_LOVING',
  [GRASS_TYPE.CLOVER]:        'NEUTRAL',
  [GRASS_TYPE.POPPY]:         'CALCAREOUS',
  [GRASS_TYPE.LAVENDER]:      'CALCAREOUS',
  [GRASS_TYPE.SUNFLOWER]:     'NEUTRAL',
  [GRASS_TYPE.THISTLE]:       'ARID',
  [GRASS_TYPE.DANDELION]:     'NEUTRAL',
  [GRASS_TYPE.SNOWDROP]:      'NEUTRAL',
  [GRASS_TYPE.ORCHID]:        'BOG'
});

// ─── fertility → material parameter sets (PBR + anime) ────────
const FERTILITY_MATERIAL = Object.freeze({
  BARREN_SOIL: {
    pbr: {
      baseColor:    [0.55, 0.48, 0.38],
      metalness:    0.00,
      roughness:    0.90,
      clearcoat:    0.00,
      transmission: 0.00,
      ior:          1.50,
      sheen:        0.00,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.58, 0.50, 0.40],
      quantizeSteps: 3,
      rimPower:     2.0,
      rimColor:     [0.75, 0.70, 0.60]
    },
    subsurfaceRadius: [0.02, 0.02, 0.01],
    emissive:         [0.00, 0.00, 0.00],
    organicTint:      0.00
  },
  POOR_SOIL: {
    pbr: { baseColor: [0.50, 0.42, 0.32], metalness: 0.00, roughness: 0.85, clearcoat: 0.05, transmission: 0.00, ior: 1.48, sheen: 0.05, anisotropy: 0.00 },
    anime: { baseColor: [0.52, 0.44, 0.34], quantizeSteps: 3, rimPower: 1.9, rimColor: [0.68, 0.60, 0.48] },
    subsurfaceRadius: [0.03, 0.03, 0.02],
    emissive:         [0.00, 0.00, 0.00],
    organicTint:      0.10
  },
  MODERATE_SOIL: {
    pbr: { baseColor: [0.42, 0.34, 0.26], metalness: 0.00, roughness: 0.75, clearcoat: 0.15, transmission: 0.00, ior: 1.48, sheen: 0.15, anisotropy: 0.00 },
    anime: { baseColor: [0.44, 0.36, 0.28], quantizeSteps: 3, rimPower: 1.8, rimColor: [0.60, 0.52, 0.42] },
    subsurfaceRadius: [0.04, 0.04, 0.03],
    emissive:         [0.00, 0.00, 0.00],
    organicTint:      0.25
  },
  RICH_SOIL: {
    pbr: { baseColor: [0.30, 0.24, 0.18], metalness: 0.00, roughness: 0.65, clearcoat: 0.25, transmission: 0.00, ior: 1.48, sheen: 0.20, anisotropy: 0.00 },
    anime: { baseColor: [0.32, 0.26, 0.20], quantizeSteps: 3, rimPower: 1.7, rimColor: [0.50, 0.42, 0.35] },
    subsurfaceRadius: [0.05, 0.05, 0.04],
    emissive:         [0.00, 0.00, 0.00],
    organicTint:      0.45
  },
  VERY_RICH_SOIL: {
    pbr: { baseColor: [0.22, 0.18, 0.14], metalness: 0.00, roughness: 0.60, clearcoat: 0.30, transmission: 0.00, ior: 1.48, sheen: 0.25, anisotropy: 0.00 },
    anime: { baseColor: [0.24, 0.20, 0.16], quantizeSteps: 3, rimPower: 1.6, rimColor: [0.42, 0.36, 0.30] },
    subsurfaceRadius: [0.06, 0.06, 0.04],
    emissive:         [0.00, 0.00, 0.00],
    organicTint:      0.65
  },
  CHLOROTIC_SOIL: {
    pbr: { baseColor: [0.62, 0.60, 0.44], metalness: 0.00, roughness: 0.80, clearcoat: 0.10, transmission: 0.00, ior: 1.50, sheen: 0.05, anisotropy: 0.00 },
    anime: { baseColor: [0.65, 0.62, 0.46], quantizeSteps: 3, rimPower: 1.9, rimColor: [0.80, 0.78, 0.60] },
    subsurfaceRadius: [0.02, 0.02, 0.01],
    emissive:         [0.00, 0.00, 0.00],
    organicTint:      0.05
  },
  CHALKY_SOIL: {
    pbr: { baseColor: [0.70, 0.66, 0.58], metalness: 0.00, roughness: 0.82, clearcoat: 0.08, transmission: 0.00, ior: 1.52, sheen: 0.08, anisotropy: 0.00 },
    anime: { baseColor: [0.72, 0.68, 0.60], quantizeSteps: 3, rimPower: 1.9, rimColor: [0.85, 0.82, 0.72] },
    subsurfaceRadius: [0.02, 0.02, 0.01],
    emissive:         [0.00, 0.00, 0.00],
    organicTint:      0.05
  },
  PALE_DEFICIENT: {
    pbr: { baseColor: [0.58, 0.56, 0.44], metalness: 0.00, roughness: 0.88, clearcoat: 0.05, transmission: 0.00, ior: 1.48, sheen: 0.03, anisotropy: 0.00 },
    anime: { baseColor: [0.60, 0.58, 0.46], quantizeSteps: 3, rimPower: 2.0, rimColor: [0.72, 0.70, 0.58] },
    subsurfaceRadius: [0.02, 0.02, 0.01],
    emissive:         [0.00, 0.00, 0.00],
    organicTint:      0.05
  }
});

// ─── defaults ────────────────────────────────────────────────────
const FERTILITY_DEFAULTS = Object.freeze({
  worldSeed:              0xF32T11C0D & 0xFFFFFFFF,
  cellSize:               32.0,
  chunkSize:              1000,
  maxCellsPerChunk:       128,
  maxChunksPerFrame:      8,
  fertilityChangeCooldown: 10.0,
  nutrientPoolDecayRate:  0.0001,
  enableGddCoupling:      true,
  enableMicronutrients:   true,
  enableSpeciesSuitability: true
});

class SoilFertilityProvider {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.defaults = { ...FERTILITY_DEFAULTS, ...(options.defaults || {}) };
    // Ensure worldSeed is a valid 32-bit int.
    this.defaults.worldSeed = this.defaults.worldSeed | 0;
    this.nutrients = { ...NUTRIENT_CONSTANTS, ...(options.nutrients || {}) };
    this.growth = { ...GROWTH_CONSTANTS, ...(options.growth || {}) };
    this.thresholds = [...FERTILITY_THRESHOLDS];
    this.enableLiebigMin = options.enableLiebigMin ?? true;

    // ── scratch (pooled) ────────────────────────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVecD = new Vec3();
    this._tmpColor = new Vec3();
    this._tmpMatA = new Mat4();
    this._tmpSphere = new Sphere();
    this._tmpRay = new Ray();
    this._tmpPlane = new Plane();

    // ── per-chunk fertility state ──────────────────────────
    const chunkCap = options.maxTrackedChunks ?? 256;
    this._chunkCap = chunkCap;
    this._chunkKeys = new Map();
    this._chunkSlot = 0;
    this._chunkUsed = 0;

    this._chunkCX = new Int32Array(chunkCap);
    this._chunkCZ = new Int32Array(chunkCap);
    this._chunkState = new Uint8Array(chunkCap);

    // Nutrient pools (kg/m² per chunk).
    this._chunkNitrogenPool   = new Float32Array(chunkCap);
    this._chunkPhosphorusPool = new Float32Array(chunkCap);
    this._chunkPotassiumPool  = new Float32Array(chunkCap);
    this._chunkMicroPool      = new Float32Array(chunkCap);

    // Individual nutrient availabilities.
    this._chunkNitrogenAvail   = new Float32Array(chunkCap);   // 0..1
    this._chunkPhosphorusAvail = new Float32Array(chunkCap);
    this._chunkPotassiumAvail  = new Float32Array(chunkCap);
    this._chunkMicroAvail      = new Float32Array(chunkCap);

    // Combined factors.
    this._chunkNutrientFactor  = new Float32Array(chunkCap);   // Liebig min
    this._chunkMoistureFactor  = new Float32Array(chunkCap);
    this._chunkTemperatureFactor = new Float32Array(chunkCap);
    this._chunkPhFactor        = new Float32Array(chunkCap);
    this._chunkTextureFactor   = new Float32Array(chunkCap);
    this._chunkCEC             = new Float32Array(chunkCap);   // meq/100g

    // Overall fertility index.
    this._chunkFertilityIndex  = new Float32Array(chunkCap);
    this._chunkFertilityClass  = new Uint8Array(chunkCap);
    this._chunkGrowthRate      = new Float32Array(chunkCap);   // m/day at F=1
    this._chunkGddBoost        = new Float32Array(chunkCap);

    // Per-chunk summary.
    this._chunkDominantSoilTexture = new Uint8Array(chunkCap);
    this._chunkOrganicPercent  = new Float32Array(chunkCap);
    this._chunkPH              = new Float32Array(chunkCap);
    this._chunkSoilMoisture    = new Float32Array(chunkCap);
    this._chunkSoilTemp        = new Float32Array(chunkCap);

    // Per-chunk cell data.
    const cellCap = this.defaults.maxCellsPerChunk;
    this._chunkCellCount = new Uint16Array(chunkCap);
    this._chunkCellX = new Array(chunkCap).fill(null);
    this._chunkCellY = new Array(chunkCap).fill(null);
    this._chunkCellZ = new Array(chunkCap).fill(null);
    this._chunkCellFertility = new Array(chunkCap).fill(null);
    this._chunkCellClass = new Array(chunkCap).fill(null);   // Uint8Array
    this._chunkCellN = new Array(chunkCap).fill(null);
    this._chunkCellP = new Array(chunkCap).fill(null);
    this._chunkCellK = new Array(chunkCap).fill(null);
    this._chunkCellMicro = new Array(chunkCap).fill(null);

    // Free lists.
    this._cellPool = {
      x: [], y: [], z: [], fertility: [], n: [], p: [], k: [], micro: []
    };
    this._classArrayPool = [];

    // ── per-frame global aggregate ─────────────────────────
    this._globalFertility = {
      avgFertilityIndex: 0,
      avgNitrogenAvail: 0,
      avgPhosphorusAvail: 0,
      avgPotassiumAvail: 0,
      avgMicroAvail: 0,
      avgCEC: 0,
      avgGrowthRate: 0,
      dominantFertilityClass: 0,
      barrenFraction: 0,
      poorFraction: 0,
      moderateFraction: 0,
      richFraction: 0,
      veryRichFraction: 0
    };

    // ── timing / frame reference ───────────────────────────
    this._lastUpdateTime = -Infinity;
    this._frameRef = null;

    // ── statistics ─────────────────────────────────────────
    this._stats = {
      updates: 0,
      chunksProcessed: 0,
      cellsSampled: 0,
      barrenCells: 0,
      poorCells: 0,
      moderateCells: 0,
      richCells: 0,
      veryRichCells: 0,
      nitrogenLimitedCells: 0,
      phosphorusLimitedCells: 0,
      potassiumLimitedCells: 0,
      micronutrientLimitedCells: 0,
      fertilityTransitions: 0,
      mutationEventsEmitted: 0,
      suitabilityQueries: 0
    };

    // ── collaborators ─────────────────────────────────────
    this._terrain = options.terrain || null;
    this._elevation = options.elevation || null;
    this._slope = options.slope || null;
    this._carve = options.carve || null;
    this._rocks = options.rocks || null;
    this._forest = options.forest || null;
    this._grass = options.grass || null;
    this._bathymetry = options.bathymetry || null;
    this._groundwater = options.groundwater || null;
    this._moisture = options.moisture || null;
    this._decomposers = options.decomposers || null;
    this._temperature = options.temperature || null;
    this._precipitation = options.precipitation || null;
    this._wind = options.wind || null;
    this._soil = options.soil || null;
    this._temporal = options.temporal || null;
    this._dispatcher = options.dispatcher || null;

    // ── reusable material output ───────────────────────────
    this._blendedParams = {
      pbr: { baseColor: [0,0,0], metalness: 0, roughness: 0, clearcoat: 0, transmission: 0, ior: 1.33, sheen: 0, anisotropy: 0 },
      anime: { baseColor: [0,0,0], quantizeSteps: 3, rimPower: 2, rimColor: [0,0,0] },
      subsurfaceRadius: [0,0,0],
      emissive: [0,0,0],
      organicTint: 0
    };

    // ── previous class per chunk (for transitions) ─────────
    this._chunkLastClass = new Uint8Array(chunkCap);
    this._chunkLastTransitionTime = new Float64Array(chunkCap);
  }

  // ══════════════════════════════════════════════════════════
  // ─── collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachTerrain(t) { this._terrain = t; return this; }
  attachElevation(e) { this._elevation = e; return this; }
  attachSlope(s) { this._slope = s; return this; }
  attachCarve(c) { this._carve = c; return this; }
  attachRocks(r) { this._rocks = r; return this; }
  attachForest(f) { this._forest = f; return this; }
  attachGrass(g) { this._grass = g; return this; }
  attachBathymetry(b) { this._bathymetry = b; return this; }
  attachGroundwater(g) { this._groundwater = g; return this; }
  attachMoisture(m) { this._moisture = m; return this; }
  attachDecomposers(d) { this._decomposers = d; return this; }
  attachTemperature(t) { this._temperature = t; return this; }
  attachPrecipitation(p) { this._precipitation = p; return this; }
  attachWind(w) { this._wind = w; return this; }
  attachSoil(s) { this._soil = s; return this; }
  attachTemporal(t) { this._temporal = t; return this; }
  attachDispatcher(d) { this._dispatcher = d; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── height lookup ──────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _getHeight(wx, wz, lod = 0) {
    if (this._carve) return this._carve.getCarvedHeight(wx, wz, lod);
    if (this._elevation) return this._elevation.getElevation(wx, wz, lod);
    if (this._terrain) return this._terrain.getHeight(wx, wz, lod);
    return 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── nutrient availability responses ───────────────────
  // ══════════════════════════════════════════════════════════
  // N availability: peaks at pH 6.5, peaks at high organic matter,
  // capped by Liebig availability.
  _computeNitrogenAvailability(poolKgPerM2, ph, organicPercent) {
    const n = this.nutrients;
    // Pool contribution (linear from 0 to 0.05 kg/m²).
    const poolFactor = Math.min(1, poolKgPerM2 / 0.05);
    // pH factor: bell curve around 6.5, asymmetric.
    const phFactor = Math.exp(-Math.pow((ph - n.nitrogenOptimalPh) / 1.5, 2));
    // Organic matter factor: linear from minOM to 5%, saturated above.
    const omFactor = Math.min(1, Math.max(0,
      (organicPercent - n.nitrogenMinOM) / (n.nitrogenOptimalOM - n.nitrogenMinOM)));
    return Math.max(0, Math.min(1, poolFactor * phFactor * omFactor));
  }

  _computePhosphorusAvailability(poolKgPerM2, ph, organicPercent) {
    const n = this.nutrients;
    const poolFactor = Math.min(1, poolKgPerM2 / 0.010);
    const phFactor = Math.exp(-Math.pow((ph - n.phosphorusOptimalPh) / 1.2, 2));
    const omFactor = Math.min(1, Math.max(0,
      (organicPercent - n.phosphorusMinOM) / 3.0));
    return Math.max(0, Math.min(1, poolFactor * phFactor * omFactor));
  }

  _computePotassiumAvailability(poolKgPerM2, ph, organicPercent) {
    const n = this.nutrients;
    const poolFactor = Math.min(1, poolKgPerM2 / 0.030);
    const phFactor = Math.exp(-Math.pow((ph - n.potassiumOptimalPh) / 1.5, 2));
    const omFactor = Math.min(1, Math.max(0,
      (organicPercent - n.potassiumMinOM) / 3.0));
    return Math.max(0, Math.min(1, poolFactor * phFactor * omFactor));
  }

  _computeMicronutrientAvailability(poolKgPerM2, ph) {
    if (!this.defaults.enableMicronutrients) return 1.0;
    const n = this.nutrients;
    const poolFactor = Math.min(1, poolKgPerM2 / 0.005);
    // Bell curve around 6.5, wide.
    const phFactor = Math.exp(-Math.pow((ph - n.micronutrientOptimalPh) / 1.8, 2));
    return Math.max(0, Math.min(1, poolFactor * phFactor));
  }

  // ── overall pH factor across the whole range ───────────────
  _computePhFactor(ph) {
    const n = this.nutrients;
    // Bell curve around the optimal range, with soft edges.
    if (ph >= n.phOptimalMin && ph <= n.phOptimalMax) return 1.0;
    if (ph < n.phOptimalMin) {
      return Math.max(0, 1 - (n.phOptimalMin - ph) / 2.0);
    }
    return Math.max(0, 1 - (ph - n.phOptimalMax) / 2.0);
  }

  // ── moisture factor for growth (bell curve) ────────────────
  _computeMoistureFactor(moisture) {
    const g = this.growth;
    if (moisture < g.moistureThreshold) return 0;
    if (moisture >= g.moistureOptimal) {
      // Too much water = also bad.
      const excess = moisture - g.moistureOptimal;
      if (excess > 0.4) return Math.max(0.1, 1 - (excess - 0.4) * 2);
      return 1.0;
    }
    return (moisture - g.moistureThreshold) /
           (g.moistureOptimal - g.moistureThreshold);
  }

  // ── temperature factor for growth (bell curve) ─────────────
  _computeTemperatureFactor(temperature) {
    const g = this.growth;
    if (temperature < g.temperatureThreshold) return 0;
    if (temperature < g.temperatureOptimal) {
      return (temperature - g.temperatureThreshold) /
             (g.temperatureOptimal - g.temperatureThreshold);
    }
    if (temperature < g.temperatureOptimal + 15) return 1.0;
    // Above too-hot threshold, growth drops.
    return Math.max(0.1, 1 - (temperature - g.temperatureOptimal - 15) / 15);
  }

  // ── texture-quality factor (loam is best) ─────────────────
  _computeTextureFactor(textureClass) {
    const n = this.nutrients;
    const dist = Math.abs(textureClass - n.textureQualityOptimal);
    return Math.max(0, 1 - dist * (1 / n.textureQualityFalloff) * 0.5);
  }

  // ── CEC computation from texture + organic content ─────────
  _computeCEC(textureClass, organicFraction) {
    const n = this.nutrients;
    let cec = n.cecLoam;
    if (textureClass <= SOIL_TEXTURE_CLASS.SANDY_LOAM) cec = n.cecSand;
    else if (textureClass >= SOIL_TEXTURE_CLASS.CLAY_LOAM) cec = n.cecClay;
    return cec + organicFraction * n.cecOrganicBoost;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Liebig's law of the minimum ────────────────────────
  // ══════════════════════════════════════════════════════════
  _liebigMin(n, p, k, micro) {
    if (!this.enableLiebigMin) {
      // Average instead of min.
      return (n + p + k + micro) * 0.25;
    }
    let min = n;
    if (p < min) min = p;
    if (k < min) min = k;
    if (this.defaults.enableMicronutrients && micro < min) min = micro;
    return min;
  }

  // ══════════════════════════════════════════════════════════
  // ─── fertility class classification ────────────────────
  // ══════════════════════════════════════════════════════════
  _classifyFertility(fertility) {
    const t = this.thresholds;
    if (fertility < t[0]) return FERTILITY_CLASS.BARREN;
    if (fertility < t[1]) return FERTILITY_CLASS.POOR;
    if (fertility < t[2]) return FERTILITY_CLASS.MODERATE;
    if (fertility < t[3]) return FERTILITY_CLASS.RICH;
    return FERTILITY_CLASS.VERY_RICH;
  }

  // ══════════════════════════════════════════════════════════
  // ─── per-species suitability queries ───────────────────
  // ══════════════════════════════════════════════════════════
  computeSpeciesSuitability(preferenceName, ph, organicPercent, moisture,
                            nitrogen, phosphorus, potassium, micro) {
    this._stats.suitabilityQueries++;
    const pref = SOIL_PREFERENCE[preferenceName];
    if (!pref) return 0.5;

    // pH suitability.
    let phSuit = 1.0;
    if (ph < pref.phMin) phSuit = Math.max(0, 1 - (pref.phMin - ph) / 1.5);
    else if (ph > pref.phMax) phSuit = Math.max(0, 1 - (ph - pref.phMax) / 1.5);
    else {
      // Within range, prefer closeness to optimal.
      const dist = Math.abs(ph - pref.phOptimal) / Math.max(
        pref.phOptimal - pref.phMin,
        pref.phMax - pref.phOptimal
      );
      phSuit = 1 - dist * 0.3;
    }

    // Organic matter suitability.
    let omSuit = 1.0;
    if (organicPercent < pref.omMin) omSuit = Math.max(0, 1 - (pref.omMin - organicPercent) / pref.omMin);
    else if (organicPercent > pref.omOptimal * 2) {
      omSuit = Math.max(0.3, 1 - (organicPercent - pref.omOptimal * 2) / 20);
    }

    // Moisture suitability.
    let moistSuit = 1.0;
    if (moisture < pref.moistureMin) moistSuit = Math.max(0, moisture / pref.moistureMin);
    else if (moisture > pref.moistureOptimal + 0.3) {
      moistSuit = Math.max(0.2, 1 - (moisture - pref.moistureOptimal - 0.3) * 3);
    }

    // Weighted nutrient contribution.
    const nutrientSuit =
      nitrogen * pref.nitrogenWeight +
      phosphorus * pref.phosphorusWeight +
      potassium * pref.potassiumWeight +
      micro * pref.microWeight;

    return Math.max(0, Math.min(1,
      phSuit * omSuit * moistSuit * (0.5 + nutrientSuit * 0.5)));
  }

  // ── convenience for tree species ──────────────────────────
  treeSuitability(treeType, ph, organicPercent, moisture,
                  nitrogen, phosphorus, potassium, micro) {
    const pref = TREE_SOIL_PREFERENCE[treeType];
    if (!pref) return 0.5;
    return this.computeSpeciesSuitability(
      pref, ph, organicPercent, moisture,
      nitrogen, phosphorus, potassium, micro
    );
  }

  // ── convenience for grass species ─────────────────────────
  grassSuitability(grassType, ph, organicPercent, moisture,
                   nitrogen, phosphorus, potassium, micro) {
    const pref = GRASS_SOIL_PREFERENCE[grassType];
    if (!pref) return 0.5;
    return this.computeSpeciesSuitability(
      pref, ph, organicPercent, moisture,
      nitrogen, phosphorus, potassium, micro
    );
  }

  // ══════════════════════════════════════════════════════════
  // ─── chunk sampling ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _sampleChunk(cx, cz, frame, dtSeconds) {
    const chunkSize = this.defaults.chunkSize;
    const cellSize = this.defaults.cellSize;
    const cellsPerSide = Math.max(1, Math.floor(chunkSize / cellSize));

    let slot = this._getChunkSlot(cx, cz);
    if (slot < 0) slot = this._allocChunkSlot(cx, cz);

    // Allocate cell arrays.
    if (!this._chunkCellX[slot]) {
      this._chunkCellX[slot] = this._acquireCell('x');
      this._chunkCellY[slot] = this._acquireCell('y');
      this._chunkCellZ[slot] = this._acquireCell('z');
      this._chunkCellFertility[slot] = this._acquireCell('fertility');
      this._chunkCellClass[slot] = this._acquireClassArray();
      this._chunkCellN[slot] = this._acquireCell('n');
      this._chunkCellP[slot] = this._acquireCell('p');
      this._chunkCellK[slot] = this._acquireCell('k');
      this._chunkCellMicro[slot] = this._acquireCell('micro');
    }

    const cpx = this._chunkCellX[slot];
    const cpy = this._chunkCellY[slot];
    const cpz = this._chunkCellZ[slot];
    const cpFert = this._chunkCellFertility[slot];
    const cpClass = this._chunkCellClass[slot];
    const cpN = this._chunkCellN[slot];
    const cpP = this._chunkCellP[slot];
    const cpK = this._chunkCellK[slot];
    const cpM = this._chunkCellMicro[slot];

    let placed = 0;

    // Read global context.
    const physical = frame.layers.physical;
    const ambientTemp = physical?.ambientTemperature ?? 15;
    const relativeHumidity = physical?.relativeHumidity ?? 0.5;
    const soilMoisture = physical?.soilMoisture ?? 0.5;

    // Decomposer input.
    let decompositionInput = 0;
    if (this._decomposers) {
      const d = this._decomposers.getDecomposersAt(
        cx * chunkSize + chunkSize * 0.5,
        cz * chunkSize + chunkSize * 0.5
      );
      if (d) {
        decompositionInput = d.decompRate || 0;
      }
    }

    // ── Update nutrient pools at chunk level ────────────────
    // Pools grow from decomposition input and shrink from decay.
    const decay = this.defaults.nutrientPoolDecayRate * dtSeconds;
    this._chunkNitrogenPool[slot] = Math.min(this.growth.nPoolMax,
      Math.max(0, this._chunkNitrogenPool[slot] + decompositionInput * 0.05 * dtSeconds - decay * 0.05));
    this._chunkPhosphorusPool[slot] = Math.min(this.growth.pPoolMax,
      Math.max(0, this._chunkPhosphorusPool[slot] + decompositionInput * 0.01 * dtSeconds - decay * 0.01));
    this._chunkPotassiumPool[slot] = Math.min(this.growth.kPoolMax,
      Math.max(0, this._chunkPotassiumPool[slot] + decompositionInput * 0.03 * dtSeconds - decay * 0.03));
    this._chunkMicroPool[slot] = Math.min(this.growth.microPoolMax,
      Math.max(0, this._chunkMicroPool[slot] + decompositionInput * 0.002 * dtSeconds - decay * 0.002));

    // Ensure initial pools have a minimum baseline if starting from zero.
    if (this._chunkNitrogenPool[slot] < 0.001) this._chunkNitrogenPool[slot] = 0.005;
    if (this._chunkPhosphorusPool[slot] < 0.0005) this._chunkPhosphorusPool[slot] = 0.002;
    if (this._chunkPotassiumPool[slot] < 0.001) this._chunkPotassiumPool[slot] = 0.005;
    if (this._chunkMicroPool[slot] < 0.0001) this._chunkMicroPool[slot] = 0.0005;

    // Aggregates.
    let sumFertility = 0, sumN = 0, sumP = 0, sumK = 0, sumMicro = 0;
    let sumCEC = 0, sumGrowth = 0, sumPh = 0, sumOM = 0;
    let sumMoistureFactor = 0, sumTempFactor = 0;
    let sumPhFactor = 0, sumTextureFactor = 0, sumNutrientFactor = 0;

    let dominantClass = FERTILITY_CLASS.BARREN;
    const classCount = new Uint16Array(FERTILITY_CLASS_NAMES.length);

    let nLimited = 0, pLimited = 0, kLimited = 0, mLimited = 0;

    // Process each cell in the chunk.
    for (let j = 0; j < cellsPerSide && placed < this.defaults.maxCellsPerChunk; j++) {
      for (let i = 0; i < cellsPerSide && placed < this.defaults.maxCellsPerChunk; i++) {
        const wx = cx * chunkSize + (i + 0.5) * cellSize;
        const wz = cz * chunkSize + (j + 0.5) * cellSize;

        // Read soil data from SoilCompositionProvider.
        let ph = 6.5;
        let organicPercent = 2.0;
        let textureClass = SOIL_TEXTURE_CLASS.LOAM;
        let soilMoistureLocal = soilMoisture;

        if (this._soil) {
          const soil = this._soil.getSoilAt(wx, wz);
          if (soil) {
            ph = soil.pH;
            organicPercent = soil.organicPercent;
            textureClass = soil.textureClass;
            // Refine moisture with groundwater if available.
            if (this._groundwater) {
              const gw = this._groundwater.getGroundwaterAt(wx, wz);
              if (gw) soilMoistureLocal = (soilMoisture + gw.soilMoisture) * 0.5;
            }
          }
        }

        // Compute per-cell nutrient availabilities.
        const nAvail = this._computeNitrogenAvailability(
          this._chunkNitrogenPool[slot], ph, organicPercent
        );
        const pAvail = this._computePhosphorusAvailability(
          this._chunkPhosphorusPool[slot], ph, organicPercent
        );
        const kAvail = this._computePotassiumAvailability(
          this._chunkPotassiumPool[slot], ph, organicPercent
        );
        const mAvail = this._computeMicronutrientAvailability(
          this._chunkMicroPool[slot], ph
        );

        // Liebig's minimum.
        const nutrientFactor = this._liebigMin(nAvail, pAvail, kAvail, mAvail);

        // Other factors.
        const moistureFactor = this._computeMoistureFactor(soilMoistureLocal);
        const temperatureFactor = this._computeTemperatureFactor(ambientTemp);
        const phFactor = this._computePhFactor(ph);
        const textureFactor = this._computeTextureFactor(textureClass);
        const cec = this._computeCEC(textureClass, organicPercent / 100);

        // Overall fertility index.
        const fertility = nutrientFactor * moistureFactor * temperatureFactor *
                          phFactor * textureFactor;

        // Classify.
        const fertClass = this._classifyFertility(fertility);

        // Growth rate (metres per day, capped by GDD).
        const gddBoost = ambientTemp > this.growth.temperatureThreshold
          ? (ambientTemp - this.growth.temperatureThreshold) * this.growth.gddWeighting
          : 0;
        const growthRate = this.defaults.enableGddCoupling
          ? fertility * (this.growth.baseGrowthRate + gddBoost)
          : fertility * this.growth.baseGrowthRate;

        // Store cell.
        cpx[placed] = wx;
        cpy[placed] = this._getHeight(wx, wz);
        cpz[placed] = wz;
        cpFert[placed] = fertility;
        cpClass[placed] = fertClass;
        cpN[placed] = nAvail;
        cpP[placed] = pAvail;
        cpK[placed] = kAvail;
        cpM[placed] = mAvail;
        placed++;

        // Aggregate.
        sumFertility += fertility;
        sumN += nAvail;
        sumP += pAvail;
        sumK += kAvail;
        sumMicro += mAvail;
        sumCEC += cec;
        sumGrowth += growthRate;
        sumPh += ph;
        sumOM += organicPercent;
        sumMoistureFactor += moistureFactor;
        sumTempFactor += temperatureFactor;
        sumPhFactor += phFactor;
        sumTextureFactor += textureFactor;
        sumNutrientFactor += nutrientFactor;
        classCount[fertClass]++;

        // Limited-by counters.
        if (nAvail <= pAvail && nAvail <= kAvail && nAvail <= mAvail) nLimited++;
        else if (pAvail <= kAvail && pAvail <= mAvail) pLimited++;
        else if (kAvail <= mAvail) kLimited++;
        else mLimited++;

        // Per-class stats.
        switch (fertClass) {
          case FERTILITY_CLASS.BARREN:    this._stats.barrenCells++; break;
          case FERTILITY_CLASS.POOR:      this._stats.poorCells++; break;
          case FERTILITY_CLASS.MODERATE:  this._stats.moderateCells++; break;
          case FERTILITY_CLASS.RICH:      this._stats.richCells++; break;
          case FERTILITY_CLASS.VERY_RICH: this._stats.veryRichCells++; break;
        }

        this._stats.cellsSampled++;
      }
    }

    this._chunkCellCount[slot] = placed;

    // Store chunk-level aggregates.
    const inv = placed > 0 ? 1 / placed : 0;
    this._chunkNutrientFactor[slot] = sumNutrientFactor * inv;
    this._chunkMoistureFactor[slot] = sumMoistureFactor * inv;
    this._chunkTemperatureFactor[slot] = sumTempFactor * inv;
    this._chunkPhFactor[slot] = sumPhFactor * inv;
    this._chunkTextureFactor[slot] = sumTextureFactor * inv;
    this._chunkCEC[slot] = sumCEC * inv;
    this._chunkFertilityIndex[slot] = sumFertility * inv;
    this._chunkFertilityClass[slot] = this._classifyFertility(this._chunkFertilityIndex[slot]);
    this._chunkGrowthRate[slot] = sumGrowth * inv;
    this._chunkNitrogenAvail[slot] = sumN * inv;
    this._chunkPhosphorusAvail[slot] = sumP * inv;
    this._chunkPotassiumAvail[slot] = sumK * inv;
    this._chunkMicroAvail[slot] = sumMicro * inv;
    this._chunkPH[slot] = sumPh * inv;
    this._chunkOrganicPercent[slot] = sumOM * inv;
    this._chunkSoilMoisture[slot] = soilMoisture;
    this._chunkSoilTemp[slot] = ambientTemp;
    this._chunkGddBoost[slot] = ambientTemp > this.growth.temperatureThreshold
      ? (ambientTemp - this.growth.temperatureThreshold) * this.growth.gddWeighting
      : 0;

    // Dominant class.
    let maxCount = 0;
    for (let c = 0; c < classCount.length; c++) {
      if (classCount[c] > maxCount) { maxCount = classCount[c]; dominantClass = c; }
    }
    this._chunkFertilityClass[slot] = dominantClass;

    this._stats.chunksProcessed++;
    this._stats.nitrogenLimitedCells += nLimited;
    this._stats.phosphorusLimitedCells += pLimited;
    this._stats.potassiumLimitedCells += kLimited;
    this._stats.micronutrientLimitedCells += mLimited;

    // Fertility transition event.
    const previousClass = this._chunkLastClass[slot];
    const now = this._lastUpdateTime > 0 ? this._lastUpdateTime : 0;
    if (previousClass !== 0 && previousClass !== dominantClass &&
        now - this._chunkLastTransitionTime[slot] > this.defaults.fertilityChangeCooldown) {
      this._chunkLastTransitionTime[slot] = now;
      this._stats.fertilityTransitions++;

      if (this._dispatcher) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.ECOLOGY,
          [(cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize],
          -1, 25, 6.0,
          {
            kind: 'fertility_transition',
            chunkX: cx, chunkZ: cz,
            fromClass: previousClass,
            toClass: dominantClass,
            fromClassName: FERTILITY_CLASS_NAMES[previousClass],
            toClassName: FERTILITY_CLASS_NAMES[dominantClass],
            fertilityIndex: this._chunkFertilityIndex[slot],
            nitrogen: this._chunkNitrogenAvail[slot],
            phosphorus: this._chunkPhosphorusAvail[slot],
            potassium: this._chunkPotassiumAvail[slot]
          }
        );
        this._stats.mutationEventsEmitted++;
      }
    }
    this._chunkLastClass[slot] = dominantClass;

    return placed;
  }

  // ══════════════════════════════════════════════════════════
  // ─── chunk slot management ─────────────────────────────
  // ══════════════════════════════════════════════════════════
  _getChunkSlot(cx, cz) {
    const key = cx + ',' + cz;
    if (this._chunkKeys.has(key)) return this._chunkKeys.get(key);
    return -1;
  }

  _allocChunkSlot(cx, cz) {
    if (this._chunkUsed >= this._chunkCap) this._evictOldest();
    let slot = -1;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) { slot = i; break; }
    }
    if (slot < 0) {
      slot = this._chunkSlot;
      this._chunkSlot = (this._chunkSlot + 1) % this._chunkCap;
      this._evictSlot(slot);
    }
    this._chunkCX[slot] = cx;
    this._chunkCZ[slot] = cz;
    this._chunkState[slot] = 1;
    this._chunkKeys.set(cx + ',' + cz, slot);
    this._chunkUsed++;
    this._chunkLastClass[slot] = 0;
    this._chunkLastTransitionTime[slot] = 0;
    // Initial pool values.
    this._chunkNitrogenPool[slot] = 0.005;
    this._chunkPhosphorusPool[slot] = 0.002;
    this._chunkPotassiumPool[slot] = 0.005;
    this._chunkMicroPool[slot] = 0.0005;
    return slot;
  }

  _evictSlot(slot) {
    if (this._chunkState[slot] === 0) return;
    const key = this._chunkCX[slot] + ',' + this._chunkCZ[slot];
    this._chunkKeys.delete(key);
    this._chunkState[slot] = 0;
    this._chunkCellCount[slot] = 0;
    if (this._chunkCellX[slot]) {
      this._cellPool.x.push(this._chunkCellX[slot]);
      this._cellPool.y.push(this._chunkCellY[slot]);
      this._cellPool.z.push(this._chunkCellZ[slot]);
      this._cellPool.fertility.push(this._chunkCellFertility[slot]);
      this._cellPool.n.push(this._chunkCellN[slot]);
      this._cellPool.p.push(this._chunkCellP[slot]);
      this._cellPool.k.push(this._chunkCellK[slot]);
      this._cellPool.micro.push(this._chunkCellMicro[slot]);
      this._classArrayPool.push(this._chunkCellClass[slot]);
    }
    this._chunkCellX[slot] = null;
    this._chunkCellY[slot] = null;
    this._chunkCellZ[slot] = null;
    this._chunkCellFertility[slot] = null;
    this._chunkCellClass[slot] = null;
    this._chunkCellN[slot] = null;
    this._chunkCellP[slot] = null;
    this._chunkCellK[slot] = null;
    this._chunkCellMicro[slot] = null;
    this._chunkUsed--;
  }

  _evictOldest() {
    let oldest = -1;
    let oldestVal = Infinity;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      if (this._chunkCX[i] < oldestVal) { oldestVal = this._chunkCX[i]; oldest = i; }
    }
    if (oldest >= 0) this._evictSlot(oldest);
  }

  _acquireCell(kind) {
    const pool = this._cellPool[kind];
    if (pool && pool.length > 0) {
      const arr = pool.pop();
      arr.fill(0);
      return arr;
    }
    return new Float32Array(this.defaults.maxCellsPerChunk);
  }

  _acquireClassArray() {
    if (this._classArrayPool.length > 0) {
      const arr = this._classArrayPool.pop();
      arr.fill(0);
      return arr;
    }
    return new Uint8Array(this.defaults.maxCellsPerChunk);
  }

  // ══════════════════════════════════════════════════════════
  // ─── public queries ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getFertilityAt(wx, wz) {
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot < 0 || this._chunkState[slot] === 0) return null;

    return {
      fertilityIndex: this._chunkFertilityIndex[slot],
      fertilityClass: this._chunkFertilityClass[slot],
      fertilityClassName: FERTILITY_CLASS_NAMES[this._chunkFertilityClass[slot]],
      nitrogenAvail: this._chunkNitrogenAvail[slot],
      phosphorusAvail: this._chunkPhosphorusAvail[slot],
      potassiumAvail: this._chunkPotassiumAvail[slot],
      microAvail: this._chunkMicroAvail[slot],
      nutrientFactor: this._chunkNutrientFactor[slot],
      moistureFactor: this._chunkMoistureFactor[slot],
      temperatureFactor: this._chunkTemperatureFactor[slot],
      phFactor: this._chunkPhFactor[slot],
      textureFactor: this._chunkTextureFactor[slot],
      cec: this._chunkCEC[slot],
      growthRate: this._chunkGrowthRate[slot],
      gddBoost: this._chunkGddBoost[slot],
      pH: this._chunkPH[slot],
      organicPercent: this._chunkOrganicPercent[slot],
      soilMoisture: this._chunkSoilMoisture[slot],
      soilTemperature: this._chunkSoilTemp[slot],
      cellCount: this._chunkCellCount[slot],
      cells: {
        x: this._chunkCellX[slot],
        y: this._chunkCellY[slot],
        z: this._chunkCellZ[slot],
        fertility: this._chunkCellFertility[slot],
        class: this._chunkCellClass[slot],
        nitrogen: this._chunkCellN[slot],
        phosphorus: this._chunkCellP[slot],
        potassium: this._chunkCellK[slot],
        micro: this._chunkCellMicro[slot]
      }
    };
  }

  // Sample fertility at any world position.
  sampleFertilityAt(wx, wz, frame) {
    if (!frame) frame = this._frameRef;
    if (!frame) return 0.5;

    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot >= 0 && this._chunkState[slot] === 1) {
      return this._chunkFertilityIndex[slot];
    }
    return 0.5;
  }

  // Sample fertility class at any world position.
  sampleFertilityClassAt(wx, wz, frame) {
    if (!frame) frame = this._frameRef;
    if (!frame) return FERTILITY_CLASS.MODERATE;

    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot >= 0 && this._chunkState[slot] === 1) {
      return this._chunkFertilityClass[slot];
    }
    return FERTILITY_CLASS.MODERATE;
  }

  // Sample growth rate at any world position.
  sampleGrowthRateAt(wx, wz, frame) {
    if (!frame) frame = this._frameRef;
    if (!frame) return 0.01;

    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot >= 0 && this._chunkState[slot] === 1) {
      return this._chunkGrowthRate[slot];
    }
    return 0.01;
  }

  // ══════════════════════════════════════════════════════════
  // ─── material parameter dispatch ────────────────────────
  // ══════════════════════════════════════════════════════════
  getFertilityMaterialParams(preset) {
    return FERTILITY_MATERIAL[preset] || FERTILITY_MATERIAL.MODERATE_SOIL;
  }

  blendFertilityMaterial(fertilityIndex, moisture, ph, out) {
    let preset = 'MODERATE_SOIL';

    // Choose preset by fertility.
    if (fertilityIndex < 0.10) preset = 'BARREN_SOIL';
    else if (fertilityIndex < 0.30) preset = 'POOR_SOIL';
    else if (fertilityIndex < 0.55) preset = 'MODERATE_SOIL';
    else if (fertilityIndex < 0.80) preset = 'RICH_SOIL';
    else preset = 'VERY_RICH_SOIL';

    // Override for special chemical states.
    if (ph > 7.8) preset = 'CHALKY_SOIL';
    else if (ph < 5.0) preset = 'CHLOROTIC_SOIL';
    else if (fertilityIndex < 0.35 && ph > 5.0 && ph < 7.5) preset = 'PALE_DEFICIENT';

    const src = FERTILITY_MATERIAL[preset];
    const o = out || this._blendedParams;

    o.pbr.baseColor[0] = src.pbr.baseColor[0];
    o.pbr.baseColor[1] = src.pbr.baseColor[1];
    o.pbr.baseColor[2] = src.pbr.baseColor[2];
    o.pbr.metalness = src.pbr.metalness;
    o.pbr.roughness = src.pbr.roughness * (1 - moisture * 0.3);
    o.pbr.clearcoat = src.pbr.clearcoat + moisture * 0.2;
    o.pbr.transmission = src.pbr.transmission;
    o.pbr.ior = src.pbr.ior;
    o.pbr.sheen = src.pbr.sheen;
    o.pbr.anisotropy = src.pbr.anisotropy;

    o.anime.baseColor[0] = src.anime.baseColor[0];
    o.anime.baseColor[1] = src.anime.baseColor[1];
    o.anime.baseColor[2] = src.anime.baseColor[2];
    o.anime.quantizeSteps = src.anime.quantizeSteps;
    o.anime.rimPower = src.anime.rimPower;
    o.anime.rimColor[0] = src.anime.rimColor[0];
    o.anime.rimColor[1] = src.anime.rimColor[1];
    o.anime.rimColor[2] = src.anime.rimColor[2];

    o.subsurfaceRadius[0] = src.subsurfaceRadius[0];
    o.subsurfaceRadius[1] = src.subsurfaceRadius[1];
    o.subsurfaceRadius[2] = src.subsurfaceRadius[2];

    o.emissive[0] = src.emissive[0];
    o.emissive[1] = src.emissive[1];
    o.emissive[2] = src.emissive[2];

    o.organicTint = src.organicTint;

    return o;
  }

  // ══════════════════════════════════════════════════════════
  // ─── frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.fertility) {
      spatial.fertility = {
        chunkCount: 0,
        chunkCX: new Int32Array(this._chunkCap),
        chunkCZ: new Int32Array(this._chunkCap),
        chunkSlots: new Int32Array(this._chunkCap),
        fertilityIndex: this._chunkFertilityIndex,
        fertilityClass: this._chunkFertilityClass,
        nitrogenAvail: this._chunkNitrogenAvail,
        phosphorusAvail: this._chunkPhosphorusAvail,
        potassiumAvail: this._chunkPotassiumAvail,
        microAvail: this._chunkMicroAvail,
        nutrientFactor: this._chunkNutrientFactor,
        moistureFactor: this._chunkMoistureFactor,
        temperatureFactor: this._chunkTemperatureFactor,
        phFactor: this._chunkPhFactor,
        textureFactor: this._chunkTextureFactor,
        cec: this._chunkCEC,
        growthRate: this._chunkGrowthRate,
        gddBoost: this._chunkGddBoost,
        pH: this._chunkPH,
        organicPercent: this._chunkOrganicPercent,
        soilMoisture: this._chunkSoilMoisture,
        soilTemperature: this._chunkSoilTemp,
        nitrogenPool: this._chunkNitrogenPool,
        phosphorusPool: this._chunkPhosphorusPool,
        potassiumPool: this._chunkPotassiumPool,
        microPool: this._chunkMicroPool,
        cells: {
          count: this._chunkCellCount,
          x: this._chunkCellX,
          y: this._chunkCellY,
          z: this._chunkCellZ,
          fertility: this._chunkCellFertility,
          class: this._chunkCellClass,
          nitrogen: this._chunkCellN,
          phosphorus: this._chunkCellP,
          potassium: this._chunkCellK,
          micro: this._chunkCellMicro
        },
        materialParams: FERTILITY_MATERIAL,
        classNames: FERTILITY_CLASS_NAMES,
        thresholds: this.thresholds
      };
    }

    const f = spatial.fertility;
    f.chunkCount = 0;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      if (f.chunkCount >= this._chunkCap) break;
      f.chunkCX[f.chunkCount] = this._chunkCX[i];
      f.chunkCZ[f.chunkCount] = this._chunkCZ[i];
      f.chunkSlots[f.chunkCount] = i;
      f.chunkCount++;
    }
  }

  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    let sumFertility = 0, sumN = 0, sumP = 0, sumK = 0, sumM = 0;
    let sumCEC = 0, sumGrowth = 0;
    let chunksWithFertility = 0;
    let barrenChunks = 0, poorChunks = 0, moderateChunks = 0, richChunks = 0, veryRichChunks = 0;
    const classCount = new Uint16Array(FERTILITY_CLASS_NAMES.length);

    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      chunksWithFertility++;
      sumFertility += this._chunkFertilityIndex[i];
      sumN += this._chunkNitrogenAvail[i];
      sumP += this._chunkPhosphorusAvail[i];
      sumK += this._chunkPotassiumAvail[i];
      sumM += this._chunkMicroAvail[i];
      sumCEC += this._chunkCEC[i];
      sumGrowth += this._chunkGrowthRate[i];
      const c = this._chunkFertilityClass[i];
      classCount[c]++;
      switch (c) {
        case FERTILITY_CLASS.BARREN:    barrenChunks++; break;
        case FERTILITY_CLASS.POOR:      poorChunks++; break;
        case FERTILITY_CLASS.MODERATE:  moderateChunks++; break;
        case FERTILITY_CLASS.RICH:      richChunks++; break;
        case FERTILITY_CLASS.VERY_RICH: veryRichChunks++; break;
      }
    }

    const gf = this._globalFertility;
    const inv = chunksWithFertility > 0 ? 1 / chunksWithFertility : 0;
    gf.avgFertilityIndex = sumFertility * inv;
    gf.avgNitrogenAvail = sumN * inv;
    gf.avgPhosphorusAvail = sumP * inv;
    gf.avgPotassiumAvail = sumK * inv;
    gf.avgMicroAvail = sumM * inv;
    gf.avgCEC = sumCEC * inv;
    gf.avgGrowthRate = sumGrowth * inv;
    gf.barrenFraction = chunksWithFertility > 0 ? barrenChunks / chunksWithFertility : 0;
    gf.poorFraction = chunksWithFertility > 0 ? poorChunks / chunksWithFertility : 0;
    gf.moderateFraction = chunksWithFertility > 0 ? moderateChunks / chunksWithFertility : 0;
    gf.richFraction = chunksWithFertility > 0 ? richChunks / chunksWithFertility : 0;
    gf.veryRichFraction = chunksWithFertility > 0 ? veryRichChunks / chunksWithFertility : 0;

    let dominantClass = FERTILITY_CLASS.MODERATE;
    let maxCount = 0;
    for (let c = 0; c < classCount.length; c++) {
      if (classCount[c] > maxCount) { maxCount = classCount[c]; dominantClass = c; }
    }
    gf.dominantFertilityClass = dominantClass;

    if (!physical.fertilityProperties) physical.fertilityProperties = {};
    Object.assign(physical.fertilityProperties, gf);

    // Material-facing aggregates.
    physical.soilFertility = gf.avgFertilityIndex;
    physical.soilFertilityClass = dominantClass;
    physical.soilFertilityClassName = FERTILITY_CLASS_NAMES[dominantClass];
    physical.soilNitrogenAvail = gf.avgNitrogenAvail;
    physical.soilPhosphorusAvail = gf.avgPhosphorusAvail;
    physical.soilPotassiumAvail = gf.avgPotassiumAvail;
    physical.soilMicroAvail = gf.avgMicroAvail;
    physical.soilCEC = gf.avgCEC;
    physical.soilGrowthRate = gf.avgGrowthRate;
    physical.soilBarrenFraction = gf.barrenFraction;
    physical.soilRichFraction = gf.richFraction + gf.veryRichFraction;

    if (!physical.fertilityClassWeights) {
      physical.fertilityClassWeights = new Float32Array(FERTILITY_CLASS_NAMES.length);
    }
    if (chunksWithFertility > 0) {
      for (let c = 0; c < classCount.length; c++) {
        physical.fertilityClassWeights[c] = classCount[c] / chunksWithFertility;
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── main update ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  update(frame, clock) {
    if (!frame || !frame.layers) return 0;
    const now = clock ? clock.elapsedSeconds : performance.now() / 1000;
    if (now - this._lastUpdateTime < PROVIDER_INTERVAL) return 0;
    const dtSeconds = Math.min(60, now - (this._lastUpdateTime > 0 ? this._lastUpdateTime : now - PROVIDER_INTERVAL));
    this._lastUpdateTime = now;
    this._frameRef = frame;

    const tc = frame.layers.spatial?.terrainChunks;
    if (!tc || tc.count === 0) {
      this._writeToSpatialLayer(frame);
      this._writeToPhysicalLayer(frame);
      this._stats.updates++;
      return 1;
    }

    const budget = Math.min(this.defaults.maxChunksPerFrame, tc.count);
    for (let i = 0; i < budget; i++) {
      const cx = tc.cx[i];
      const cz = tc.cz[i];
      this._sampleChunk(cx, cz, frame, dtSeconds);
    }

    this._writeToSpatialLayer(frame);
    this._writeToPhysicalLayer(frame);

    this._stats.updates++;
    return 1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── interactive setters ────────────────────────────────
  // ══════════════════════════════════════════════════════════
  setWorldSeed(seed) {
    this.defaults.worldSeed = seed | 0;
    this._clearAllChunks();
    return this;
  }

  setCellSize(size) {
    if (size > 0) this.defaults.cellSize = size;
    return this;
  }

  setMaxChunksPerFrame(count) {
    if (count > 0) this.defaults.maxChunksPerFrame = count;
    return this;
  }

  setNutrientConstants(params) {
    for (const k of Object.keys(this.nutrients)) {
      if (params[k] !== undefined) this.nutrients[k] = params[k];
    }
    return this;
  }

  setGrowthConstants(params) {
    for (const k of Object.keys(this.growth)) {
      if (params[k] !== undefined) this.growth[k] = params[k];
    }
    return this;
  }

  setThresholds(thresholds) {
    for (let i = 0; i < thresholds.length && i < this.thresholds.length; i++) {
      this.thresholds[i] = thresholds[i];
    }
    return this;
  }

  _clearAllChunks() {
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] !== 0) this._evictSlot(i);
    }
    this._chunkKeys.clear();
    this._chunkUsed = 0;
    this._chunkSlot = 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── diagnostics ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getGlobalFertility() { return { ...this._globalFertility }; }

  getStats() {
    return Object.freeze({ ...this._stats });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) this._stats[k] = 0;
  }

  dispose() {
    this._terrain = null;
    this._elevation = null;
    this._slope = null;
    this._carve = null;
    this._rocks = null;
    this._forest = null;
    this._grass = null;
    this._bathymetry = null;
    this._groundwater = null;
    this._moisture = null;
    this._decomposers = null;
    this._temperature = null;
    this._precipitation = null;
    this._wind = null;
    this._soil = null;
    this._temporal = null;
    this._dispatcher = null;
    this._frameRef = null;
    this._clearAllChunks();
    for (const key of Object.keys(this._cellPool)) {
      this._cellPool[key].length = 0;
    }
    this._classArrayPool.length = 0;
  }
}

export {
  SoilFertilityProvider,
  FERTILITY_CLASS,
  FERTILITY_CLASS_NAMES,
  FERTILITY_THRESHOLDS,
  NUTRIENT_CONSTANTS,
  GROWTH_CONSTANTS,
  SOIL_PREFERENCE,
  SOIL_PREFERENCE_NAMES,
  TREE_SOIL_PREFERENCE,
  GRASS_SOIL_PREFERENCE,
  FERTILITY_MATERIAL,
  FERTILITY_DEFAULTS,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};