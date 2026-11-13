// file number : 290
// full path name : src/context/290_SoilCompositionProvider.js
// description : Soil composition provider fusing bedrock geology, weathering byproducts, parent material, erosion history, and climate into a per-chunk soil composition vector across six primary fractions (SAND, SILT, CLAY, ORGANIC_MATTER, GRAVEL, ROCK_FRAGMENTS) plus trace secondary fractions (CALCIUM_CARBONATE, IRON_OXIDE, HUMUS, NUTRIENTS). The provider reads bedrock class from 282_Z06_RockGradientProvider, weathering products from 282_Z03_CarveGradientProvider's carved bands, organic input from 286_DecomposersSystem's nutrient release and 282_Z07/282_Z08 biomass, parent material from 281_ElevationProvider's elevation band, erosion history from 282_SlopeGradientProvider's stability factor, moisture from 284_GroundwaterProvider, temperature from 287_ClimateTemperatureProvider, and precipitation from 288_ClimatePrecipitationProvider. Uses a physics-motivated pedogenesis model: soil texture evolves via the Jenny equation of state S = f(cl, o, r, p, t) where cl=climate, o=organisms, r=relief, p=parent material, t=time. The provider weights these factors per cell and integrates over time to produce a stable soil texture that evolves as the world ages. Six soil texture classes (SAND, LOAMY_SAND, LOAM, CLAY_LOAM, SILT_LOAM, CLAY) map to distinct PBR + anime material parameter sets that the shader reads to blend grain size, roughness, specular response, and even grain-size-driven normal-map perturbation via an exposed normalScale. Computes per-fraction grain diameter (µm), porosity, bulk density, water-holding capacity, hydraulic conductivity, cohesion, plasticity index, and pH. Feeds SoilFertilityProvider (291) with base nutrient content, feeds LandscapeVegetationScatterSystem (346) with per-species soil suitability, and feeds LandscapeErosionSimulator (343) with the K-factor of the Universal Soil Loss Equation (USLE): K = (2.1 × 10^-4) · (12 − OM) · M^1.14 + 3.25·(s − 2) + 2.5·(p − 3), where OM is organic-matter percent, M is the silt-plus-very-fine-sand percent, s is the soil-structure class, and p is the permeability class. Emits a single coalesced MUTATION causal event per chunk when composition crosses a class boundary (e.g. sand → loamy sand) so persistence records the terrain classification change. Writes per-chunk summaries and per-cell descriptors into frame.layers.spatial.soil, plus global aggregates into frame.layers.physical.soilProperties. All scratch objects are pooled; no allocation after the first frame.
// best for : Every consumer that needs soil state — SoilFertilityProvider (291) for nutrient base, FloraPlacement for per-species soil preference, LandscapeErosionSimulator (343) for the K-factor, LandscapeWaterFlowSystem (345) for infiltration rates, LandscapeVegetationScatterSystem (346) for plant placement, landscape decal and prop placement, and material shaders for soil texture blending. Complements 282_Z06 (rock), 286 (decomposers), and 284 (groundwater) by completing the geologic-and-biologic soil formation pipeline.
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
import { CliffsGradientProvider, CLIFF_CLASS, CLIFF_MATERIAL_BAND }
                                                            from './282_Z02_CliffsGradientProvider.js';
import { CarveGradientProvider, CARVE_SOURCE, CARVE_MATERIAL_BAND, CARVE_MATERIAL_COLORS }
                                                            from './282_Z03_CarveGradientProvider.js';
import { RockGradientProvider, ROCK_TYPE, ROCK_CLASS, ROCK_CLASS_NAMES, ROCK_BASE_COLORS, ROCK_PROPERTIES }
                                                            from './282_Z06_RockGradientProvider.js';
import { ForestGradientProvider, TREE_TYPE, SUCCESSION }    from './282_Z07_ForestGradientProvider.js';
import { GrassAndFlowresGradientProvider, GRASS_TYPE }      from './282_Z08_GrassAndFlowresGradientProvider.js';
import { ContinentalReliefGradientProvider, CONTINENTAL_TYPE }
                                                            from './282_Z09_ContinentalReliefGradientProvider.js';
import { BathymetryProvider, BATHY_ZONE, SEABED_CLASS }     from './283_BathymetryProvider.js';
import { GroundwaterProvider, GROUNDWATER_TYPE, SOIL_HYDRAULICS }
                                                            from './284_GroundwaterProvider.js';
import { MoistureLevelProvider, MOISTURE_STATE }            from './285_MoistureLevelProvider.js';
import { DecomposersSystem, DECOMPOSER_TYPE }               from './286_DecomposersSystem.js';
import { ClimateTemperatureProvider, CLIMATE_ZONE }         from './287_ClimateTemperatureProvider.js';
import { ClimatePrecipitationProvider, PRECIPITATION_PHASE, PRECIPITATION_PHASE_NAMES }
                                                            from './288_ClimatePrecipitationProvider.js';
import { ClimateWindProvider, WIND_STATE }                  from './289_ClimateWindProvider.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 0.5;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── soil primary texture codes (USDA classification) ───────────
const SOIL_TEXTURE_CLASS = Object.freeze({
  SAND:         0,   // > 85% sand
  LOAMY_SAND:   1,   // 70-90% sand, < 15% clay
  SANDY_LOAM:   2,   // 43-85% sand
  LOAM:         3,   // balanced (~40% sand, 40% silt, 20% clay)
  SILT_LOAM:    4,   // 50-88% silt
  SILT:         5,   // > 80% silt
  CLAY_LOAM:    6,   // 27-40% clay
  SANDY_CLAY_LOAM: 7,// 20-35% clay, > 45% sand
  SILTY_CLAY_LOAM: 8,// 27-40% clay, > 40% silt
  CLAY:         9,   // > 40% clay
  SILTY_CLAY:  10,   // > 40% clay, > 40% silt
  SANDY_CLAY:  11    // > 35% clay, > 45% sand
});

const SOIL_TEXTURE_NAMES = Object.freeze([
  'sand', 'loamy_sand', 'sandy_loam', 'loam', 'silt_loam',
  'silt', 'clay_loam', 'sandy_clay_loam', 'silty_clay_loam',
  'clay', 'silty_clay', 'sandy_clay'
]);

// ─── base soil composition per rock class ──────────────────────
// Each rock class produces a primary soil texture when weathered.
// Values are weights for [sand, silt, clay, organic, gravel, rock].
const ROCK_TO_SOIL = Object.freeze({
  [ROCK_CLASS.GRANITE]:      [0.55, 0.20, 0.10, 0.05, 0.08, 0.02],
  [ROCK_CLASS.BASALT]:       [0.20, 0.35, 0.30, 0.05, 0.05, 0.05],
  [ROCK_CLASS.SANDSTONE]:    [0.75, 0.15, 0.05, 0.02, 0.02, 0.01],
  [ROCK_CLASS.LIMESTONE]:    [0.15, 0.30, 0.35, 0.10, 0.05, 0.05],
  [ROCK_CLASS.SLATE]:        [0.20, 0.40, 0.25, 0.05, 0.05, 0.05],
  [ROCK_CLASS.MARBLE]:       [0.10, 0.35, 0.30, 0.05, 0.10, 0.10],
  [ROCK_CLASS.OBSIDIAN]:     [0.30, 0.20, 0.15, 0.05, 0.10, 0.20],
  [ROCK_CLASS.PUMICE]:       [0.40, 0.30, 0.10, 0.05, 0.10, 0.05],
  [ROCK_CLASS.CONGLOMERATE]: [0.55, 0.20, 0.10, 0.05, 0.05, 0.05],
  [ROCK_CLASS.QUARTZITE]:    [0.50, 0.20, 0.10, 0.02, 0.10, 0.08]
});

// ─── base soil texture properties ──────────────────────────────
const SOIL_PROPERTIES = Object.freeze({
  [SOIL_TEXTURE_CLASS.SAND]:        { grainSizeUm: 800, porosity: 0.42, bulkDensity: 1.55, waterHolding: 0.10, hydraulicCond: 1e-4, cohesion: 0.05, plasticity: 0.02, ph: 7.5 },
  [SOIL_TEXTURE_CLASS.LOAMY_SAND]:  { grainSizeUm: 500, porosity: 0.40, bulkDensity: 1.50, waterHolding: 0.15, hydraulicCond: 5e-5, cohesion: 0.10, plasticity: 0.05, ph: 7.2 },
  [SOIL_TEXTURE_CLASS.SANDY_LOAM]:  { grainSizeUm: 300, porosity: 0.42, bulkDensity: 1.45, waterHolding: 0.20, hydraulicCond: 2e-5, cohesion: 0.15, plasticity: 0.08, ph: 7.0 },
  [SOIL_TEXTURE_CLASS.LOAM]:        { grainSizeUm: 150, porosity: 0.45, bulkDensity: 1.35, waterHolding: 0.25, hydraulicCond: 5e-6, cohesion: 0.25, plasticity: 0.15, ph: 6.5 },
  [SOIL_TEXTURE_CLASS.SILT_LOAM]:   { grainSizeUm: 80,  porosity: 0.47, bulkDensity: 1.30, waterHolding: 0.30, hydraulicCond: 2e-6, cohesion: 0.30, plasticity: 0.18, ph: 6.2 },
  [SOIL_TEXTURE_CLASS.SILT]:        { grainSizeUm: 40,  porosity: 0.48, bulkDensity: 1.25, waterHolding: 0.32, hydraulicCond: 8e-7, cohesion: 0.32, plasticity: 0.20, ph: 6.0 },
  [SOIL_TEXTURE_CLASS.CLAY_LOAM]:   { grainSizeUm: 30,  porosity: 0.48, bulkDensity: 1.30, waterHolding: 0.35, hydraulicCond: 5e-7, cohesion: 0.45, plasticity: 0.30, ph: 6.0 },
  [SOIL_TEXTURE_CLASS.SANDY_CLAY_LOAM]: { grainSizeUm: 60, porosity: 0.46, bulkDensity: 1.35, waterHolding: 0.30, hydraulicCond: 1e-6, cohesion: 0.40, plasticity: 0.25, ph: 6.3 },
  [SOIL_TEXTURE_CLASS.SILTY_CLAY_LOAM]: { grainSizeUm: 35, porosity: 0.49, bulkDensity: 1.28, waterHolding: 0.36, hydraulicCond: 3e-7, cohesion: 0.50, plasticity: 0.35, ph: 5.8 },
  [SOIL_TEXTURE_CLASS.CLAY]:        { grainSizeUm: 10,  porosity: 0.50, bulkDensity: 1.25, waterHolding: 0.40, hydraulicCond: 1e-7, cohesion: 0.65, plasticity: 0.50, ph: 6.5 },
  [SOIL_TEXTURE_CLASS.SILTY_CLAY]:  { grainSizeUm: 15,  porosity: 0.50, bulkDensity: 1.22, waterHolding: 0.42, hydraulicCond: 5e-8, cohesion: 0.60, plasticity: 0.45, ph: 6.0 },
  [SOIL_TEXTURE_CLASS.SANDY_CLAY]:  { grainSizeUm: 50,  porosity: 0.47, bulkDensity: 1.32, waterHolding: 0.33, hydraulicCond: 2e-7, cohesion: 0.55, plasticity: 0.38, ph: 6.8 }
});

// ─── soil texture → material parameter sets (PBR + anime) ──────
// Each texture has a full shader parameter struct.
const SOIL_MATERIAL = Object.freeze({
  [SOIL_TEXTURE_CLASS.SAND]: {
    pbr: {
      baseColor:    [0.78, 0.68, 0.50],
      metalness:    0.00,
      roughness:    0.90,
      clearcoat:    0.00,
      transmission: 0.00,
      ior:          1.55,
      sheen:        0.00,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.80, 0.70, 0.52],
      quantizeSteps: 3,
      rimPower:     2.0,
      rimColor:     [0.92, 0.85, 0.70]
    },
    subsurfaceRadius: [0.02, 0.02, 0.01],
    emissive:         [0.00, 0.00, 0.00],
    normalScale:      0.30,
    dustThreshold:    0.6
  },
  [SOIL_TEXTURE_CLASS.LOAMY_SAND]: {
    pbr: { baseColor: [0.68, 0.60, 0.45], metalness: 0.00, roughness: 0.85, clearcoat: 0.05, transmission: 0.00, ior: 1.52, sheen: 0.05, anisotropy: 0.00 },
    anime: { baseColor: [0.70, 0.62, 0.47], quantizeSteps: 3, rimPower: 1.9, rimColor: [0.85, 0.78, 0.62] },
    subsurfaceRadius: [0.03, 0.03, 0.02],
    emissive:         [0.00, 0.00, 0.00],
    normalScale:      0.40,
    dustThreshold:    0.55
  },
  [SOIL_TEXTURE_CLASS.SANDY_LOAM]: {
    pbr: { baseColor: [0.60, 0.52, 0.40], metalness: 0.00, roughness: 0.80, clearcoat: 0.10, transmission: 0.00, ior: 1.50, sheen: 0.10, anisotropy: 0.00 },
    anime: { baseColor: [0.62, 0.54, 0.42], quantizeSteps: 3, rimPower: 1.8, rimColor: [0.75, 0.68, 0.55] },
    subsurfaceRadius: [0.04, 0.04, 0.03],
    emissive:         [0.00, 0.00, 0.00],
    normalScale:      0.50,
    dustThreshold:    0.50
  },
  [SOIL_TEXTURE_CLASS.LOAM]: {
    pbr: { baseColor: [0.48, 0.38, 0.28], metalness: 0.00, roughness: 0.75, clearcoat: 0.15, transmission: 0.00, ior: 1.48, sheen: 0.15, anisotropy: 0.00 },
    anime: { baseColor: [0.50, 0.40, 0.30], quantizeSteps: 3, rimPower: 1.7, rimColor: [0.65, 0.55, 0.42] },
    subsurfaceRadius: [0.05, 0.05, 0.03],
    emissive:         [0.00, 0.00, 0.00],
    normalScale:      0.60,
    dustThreshold:    0.45
  },
  [SOIL_TEXTURE_CLASS.SILT_LOAM]: {
    pbr: { baseColor: [0.52, 0.42, 0.32], metalness: 0.00, roughness: 0.72, clearcoat: 0.20, transmission: 0.00, ior: 1.46, sheen: 0.20, anisotropy: 0.00 },
    anime: { baseColor: [0.54, 0.44, 0.34], quantizeSteps: 3, rimPower: 1.7, rimColor: [0.68, 0.58, 0.45] },
    subsurfaceRadius: [0.06, 0.06, 0.04],
    emissive:         [0.00, 0.00, 0.00],
    normalScale:      0.55,
    dustThreshold:    0.40
  },
  [SOIL_TEXTURE_CLASS.SILT]: {
    pbr: { baseColor: [0.55, 0.46, 0.36], metalness: 0.00, roughness: 0.70, clearcoat: 0.25, transmission: 0.00, ior: 1.45, sheen: 0.25, anisotropy: 0.00 },
    anime: { baseColor: [0.58, 0.48, 0.38], quantizeSteps: 3, rimPower: 1.6, rimColor: [0.70, 0.60, 0.48] },
    subsurfaceRadius: [0.06, 0.06, 0.05],
    emissive:         [0.00, 0.00, 0.00],
    normalScale:      0.45,
    dustThreshold:    0.35
  },
  [SOIL_TEXTURE_CLASS.CLAY_LOAM]: {
    pbr: { baseColor: [0.40, 0.32, 0.26], metalness: 0.00, roughness: 0.68, clearcoat: 0.30, transmission: 0.00, ior: 1.50, sheen: 0.20, anisotropy: 0.05 },
    anime: { baseColor: [0.42, 0.34, 0.28], quantizeSteps: 3, rimPower: 1.7, rimColor: [0.58, 0.48, 0.40] },
    subsurfaceRadius: [0.05, 0.04, 0.03],
    emissive:         [0.00, 0.00, 0.00],
    normalScale:      0.50,
    dustThreshold:    0.30
  },
  [SOIL_TEXTURE_CLASS.SANDY_CLAY_LOAM]: {
    pbr: { baseColor: [0.48, 0.38, 0.30], metalness: 0.00, roughness: 0.70, clearcoat: 0.25, transmission: 0.00, ior: 1.49, sheen: 0.15, anisotropy: 0.05 },
    anime: { baseColor: [0.50, 0.40, 0.32], quantizeSteps: 3, rimPower: 1.8, rimColor: [0.65, 0.55, 0.45] },
    subsurfaceRadius: [0.05, 0.04, 0.03],
    emissive:         [0.00, 0.00, 0.00],
    normalScale:      0.55,
    dustThreshold:    0.40
  },
  [SOIL_TEXTURE_CLASS.SILTY_CLAY_LOAM]: {
    pbr: { baseColor: [0.38, 0.32, 0.28], metalness: 0.00, roughness: 0.65, clearcoat: 0.35, transmission: 0.00, ior: 1.48, sheen: 0.25, anisotropy: 0.05 },
    anime: { baseColor: [0.40, 0.34, 0.30], quantizeSteps: 3, rimPower: 1.6, rimColor: [0.55, 0.48, 0.42] },
    subsurfaceRadius: [0.04, 0.04, 0.03],
    emissive:         [0.00, 0.00, 0.00],
    normalScale:      0.45,
    dustThreshold:    0.25
  },
  [SOIL_TEXTURE_CLASS.CLAY]: {
    pbr: { baseColor: [0.30, 0.24, 0.20], metalness: 0.00, roughness: 0.60, clearcoat: 0.40, transmission: 0.00, ior: 1.52, sheen: 0.20, anisotropy: 0.10 },
    anime: { baseColor: [0.32, 0.26, 0.22], quantizeSteps: 3, rimPower: 1.5, rimColor: [0.50, 0.42, 0.36] },
    subsurfaceRadius: [0.03, 0.03, 0.02],
    emissive:         [0.00, 0.00, 0.00],
    normalScale:      0.35,
    dustThreshold:    0.15
  },
  [SOIL_TEXTURE_CLASS.SILTY_CLAY]: {
    pbr: { baseColor: [0.35, 0.28, 0.23], metalness: 0.00, roughness: 0.62, clearcoat: 0.38, transmission: 0.00, ior: 1.50, sheen: 0.22, anisotropy: 0.08 },
    anime: { baseColor: [0.37, 0.30, 0.25], quantizeSteps: 3, rimPower: 1.6, rimColor: [0.52, 0.45, 0.38] },
    subsurfaceRadius: [0.03, 0.03, 0.02],
    emissive:         [0.00, 0.00, 0.00],
    normalScale:      0.40,
    dustThreshold:    0.20
  },
  [SOIL_TEXTURE_CLASS.SANDY_CLAY]: {
    pbr: { baseColor: [0.38, 0.30, 0.25], metalness: 0.00, roughness: 0.65, clearcoat: 0.30, transmission: 0.00, ior: 1.50, sheen: 0.18, anisotropy: 0.05 },
    anime: { baseColor: [0.40, 0.32, 0.27], quantizeSteps: 3, rimPower: 1.7, rimColor: [0.55, 0.45, 0.38] },
    subsurfaceRadius: [0.04, 0.03, 0.02],
    emissive:         [0.00, 0.00, 0.00],
    normalScale:      0.45,
    dustThreshold:    0.30
  }
});

// ─── soil formation constants (Jenny equation) ─────────────────
const SOIL_FORMATION = Object.freeze({
  // Jenny equation weighting: S = f(cl, o, r, p, t)
  climateWeight:    0.35,   // climate effect on weathering
  organismsWeight:  0.25,   // biological activity
  reliefWeight:     0.15,   // slope / drainage
  parentWeight:     0.15,   // bedrock composition
  timeWeight:       0.10,   // age since deposition

  // Weathering rate acceleration from temperature and moisture.
  weatheringTempOptimal: 20.0,
  weatheringMoistureOptimal: 0.6,
  weatheringRateBase: 0.0001,  // m of soil per year at optimum

  // Organic-matter accumulation.
  organicAccumRateBase: 0.0005, // m of OM per year at optimum
  organicAccumTempOptimal: 15.0,
  organicAccumMoistureOptimal: 0.55,

  // Erosion removal (via USLE K-factor proxy).
  erosionRemovalRate: 0.0002,

  // Time constant for reaching equilibrium (years).
  equilibriumTime: 1000.0,

  // Threshold for classifying texture transitions (weight change).
  classTransitionThreshold: 0.05,

  // Percent organic matter for USDA classes.
  omLow: 1.0,
  omMedium: 3.0,
  omHigh: 6.0
});

// ─── USLE K-factor constants ───────────────────────────────────
const USLE_K_CONSTANTS = Object.freeze({
  omFactorBase: 2.1e-4,
  omTerm: 12.0,
  mExponent: 1.14,
  structureFactor: 3.25,
  permeabilityFactor: 2.5
});

// ─── soil composition defaults ──────────────────────────────────
const SOIL_DEFAULTS = Object.freeze({
  worldSeed:              0x5011C0D3,
  cellSize:               32.0,
  chunkSize:              1000,
  maxCellsPerChunk:       128,
  maxChunksPerFrame:      8,
  ageBaseYears:           5000.0,      // starting soil age
  ageAcceleration:        1.0,         // in-game year multiplier
  mutationCoalesceWindow: 10.0,
  classChangeCooldown:    30.0
});

class SoilCompositionProvider {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.defaults = { ...SOIL_DEFAULTS, ...(options.defaults || {}) };
    this.formation = { ...SOIL_FORMATION, ...(options.formation || {}) };
    this.usle = { ...USLE_K_CONSTANTS, ...(options.usle || {}) };
    this.enableJennyModel = options.enableJennyModel ?? true;
    this.enableUsleKFactor = options.enableUsleKFactor ?? true;
    this.enableOrganicAccumulation = options.enableOrganicAccumulation ?? true;
    this.enableClassTransitions = options.enableClassTransitions ?? true;

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

    // ── per-chunk soil state ───────────────────────────────
    const chunkCap = options.maxTrackedChunks ?? 256;
    this._chunkCap = chunkCap;
    this._chunkKeys = new Map();
    this._chunkSlot = 0;
    this._chunkUsed = 0;

    this._chunkCX = new Int32Array(chunkCap);
    this._chunkCZ = new Int32Array(chunkCap);
    this._chunkState = new Uint8Array(chunkCap);

    // Per-chunk primary soil fractions (6 channels).
    this._chunkSand       = new Float32Array(chunkCap);
    this._chunkSilt       = new Float32Array(chunkCap);
    this._chunkClay       = new Float32Array(chunkCap);
    this._chunkOrganic    = new Float32Array(chunkCap);
    this._chunkGravel     = new Float32Array(chunkCap);
    this._chunkRock       = new Float32Array(chunkCap);

    // Secondary fractions.
    this._chunkCalciumCarbonate = new Float32Array(chunkCap);
    this._chunkIronOxide        = new Float32Array(chunkCap);
    this._chunkHumus            = new Float32Array(chunkCap);
    this._chunkNitrogen         = new Float32Array(chunkCap);
    this._chunkPhosphorus       = new Float32Array(chunkCap);
    this._chunkPotassium        = new Float32Array(chunkCap);

    // Derived properties.
    this._chunkTextureClass   = new Uint8Array(chunkCap);
    this._chunkGrainSizeUm    = new Float32Array(chunkCap);
    this._chunkPorosity       = new Float32Array(chunkCap);
    this._chunkBulkDensity    = new Float32Array(chunkCap);
    this._chunkWaterHolding   = new Float32Array(chunkCap);
    this._chunkHydraulicCond  = new Float32Array(chunkCap);
    this._chunkCohesion       = new Float32Array(chunkCap);
    this._chunkPlasticity     = new Float32Array(chunkCap);
    this._chunkPh             = new Float32Array(chunkCap);
    this._chunkUsleKFactor    = new Float32Array(chunkCap);
    this._chunkSoilAgeYears   = new Float32Array(chunkCap);
    this._chunkSoilDepthM     = new Float32Array(chunkCap);
    this._chunkOrganicPercent = new Float32Array(chunkCap);
    this._chunkParentRock     = new Uint8Array(chunkCap);
    this._chunkClassTransitionTime = new Float64Array(chunkCap);

    // Per-chunk cell data.
    const cellCap = this.defaults.maxCellsPerChunk;
    this._chunkCellCount = new Uint16Array(chunkCap);
    this._chunkCellX = new Array(chunkCap).fill(null);
    this._chunkCellY = new Array(chunkCap).fill(null);
    this._chunkCellZ = new Array(chunkCap).fill(null);
    this._chunkCellTexture = new Array(chunkCap).fill(null);
    this._chunkCellFractions = new Array(chunkCap).fill(null);
    this._chunkCellUsleK = new Array(chunkCap).fill(null);
    this._chunkCellPh = new Array(chunkCap).fill(null);
    this._chunkCellPorosity = new Array(chunkCap).fill(null);
    this._chunkCellOrganicPct = new Array(chunkCap).fill(null);

    // Free lists.
    this._cellPool = {
      x: [], y: [], z: [], texture: [], fractions: [],
      usleK: [], ph: [], porosity: [], organicPct: []
    };
    this._fractionsArrayPool = [];
    this._textureArrayPool = [];

    // ── per-frame global aggregate ─────────────────────────
    this._globalSoil = {
      avgSand: 0, avgSilt: 0, avgClay: 0,
      avgOrganic: 0, avgGravel: 0, avgRock: 0,
      avgOrganicPercent: 0,
      avgPh: 6.5,
      avgPorosity: 0.45,
      avgBulkDensity: 1.35,
      avgSoilDepth: 0.5,
      avgUsleKFactor: 0.03,
      avgSoilAge: 5000,
      dominantTexture: SOIL_TEXTURE_CLASS.LOAM,
      erodibilityClass: 2
    };

    // ── timing / frame reference ───────────────────────────
    this._lastUpdateTime = -Infinity;
    this._frameRef = null;

    // ── statistics ─────────────────────────────────────────
    this._stats = {
      updates: 0,
      chunksProcessed: 0,
      cellsSampled: 0,
      sandCells: 0, loamCells: 0, siltCells: 0, clayCells: 0,
      highOrganicCells: 0, lowOrganicCells: 0,
      phAcidicCells: 0, phNeutralCells: 0, phAlkalineCells: 0,
      classTransitions: 0,
      mutationEventsEmitted: 0
    };

    // ── collaborators ─────────────────────────────────────
    this._terrain = options.terrain || null;
    this._elevation = options.elevation || null;
    this._slope = options.slope || null;
    this._carve = options.carve || null;
    this._relief = options.relief || null;
    this._rocks = options.rocks || null;
    this._forest = options.forest || null;
    this._grass = options.grass || null;
    this._continental = options.continental || null;
    this._bathymetry = options.bathymetry || null;
    this._groundwater = options.groundwater || null;
    this._moisture = options.moisture || null;
    this._decomposers = options.decomposers || null;
    this._temperature = options.temperature || null;
    this._precipitation = options.precipitation || null;
    this._wind = options.wind || null;
    this._temporal = options.temporal || null;
    this._dispatcher = options.dispatcher || null;

    // ── reusable material output ───────────────────────────
    this._blendedParams = {
      pbr: { baseColor: [0,0,0], metalness: 0, roughness: 0, clearcoat: 0, transmission: 0, ior: 1.33, sheen: 0, anisotropy: 0 },
      anime: { baseColor: [0,0,0], quantizeSteps: 3, rimPower: 2, rimColor: [0,0,0] },
      subsurfaceRadius: [0,0,0],
      emissive: [0,0,0],
      normalScale: 0,
      dustThreshold: 0
    };

    // ── previous texture state per chunk (for transitions) ─
    this._chunkLastTexture = new Uint8Array(chunkCap);
  }

  // ══════════════════════════════════════════════════════════
  // ─── collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachTerrain(t) { this._terrain = t; return this; }
  attachElevation(e) { this._elevation = e; return this; }
  attachSlope(s) { this._slope = s; return this; }
  attachCarve(c) { this._carve = c; return this; }
  attachRelief(r) { this._relief = r; return this; }
  attachRocks(r) { this._rocks = r; return this; }
  attachForest(f) { this._forest = f; return this; }
  attachGrass(g) { this._grass = g; return this; }
  attachContinental(c) { this._continental = c; return this; }
  attachBathymetry(b) { this._bathymetry = b; return this; }
  attachGroundwater(g) { this._groundwater = g; return this; }
  attachMoisture(m) { this._moisture = m; return this; }
  attachDecomposers(d) { this._decomposers = d; return this; }
  attachTemperature(t) { this._temperature = t; return this; }
  attachPrecipitation(p) { this._precipitation = p; return this; }
  attachWind(w) { this._wind = w; return this; }
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

  _getSeaLevel() {
    return this._elevation ? this._elevation.seaLevel : 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── parent rock lookup ─────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _getParentRock(wx, wz, frame) {
    if (this._rocks) {
      const rocks = this._rocks.getPlacementsAt(wx, wz);
      if (rocks && rocks.count > 0) {
        return rocks.cls[0];
      }
    }
    const physical = frame.layers.physical;
    const rockWeights = physical?.rockClassWeights;
    if (rockWeights) {
      let dominant = ROCK_CLASS.GRANITE;
      let maxW = 0;
      for (let i = 0; i < rockWeights.length; i++) {
        if (rockWeights[i] > maxW) { maxW = rockWeights[i]; dominant = i; }
      }
      return dominant;
    }
    return ROCK_CLASS.GRANITE;
  }

  // ══════════════════════════════════════════════════════════
  // ─── climate factors for Jenny equation ────────────────
  // ══════════════════════════════════════════════════════════
  _climateFactor(temperature, moisture) {
    const f = this.formation;
    const tOpt = f.weatheringTempOptimal;
    const mOpt = f.weatheringMoistureOptimal;

    // Bell curve peaking at (tOpt, mOpt).
    const tFactor = Math.exp(-Math.pow((temperature - tOpt) / 15, 2));
    const mFactor = Math.exp(-Math.pow((moisture - mOpt) / 0.4, 2));

    return tFactor * mFactor;
  }

  // ══════════════════════════════════════════════════════════
  // ─── organic accumulation ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  _organicAccumulationRate(temperature, moisture, decomposerActivity) {
    const f = this.formation;
    const tFactor = Math.exp(-Math.pow((temperature - f.organicAccumTempOptimal) / 15, 2));
    const mFactor = Math.exp(-Math.pow((moisture - f.organicAccumMoistureOptimal) / 0.3, 2));
    // More decomposer activity = more organic returned to soil.
    const dFactor = 0.5 + decomposerActivity * 0.5;

    return f.organicAccumRateBase * tFactor * mFactor * dFactor;
  }

  // ══════════════════════════════════════════════════════════
  // ─── erosion removal rate (from wind + water + slope) ──
  // ══════════════════════════════════════════════════════════
  _erosionRemovalRate(windErosion, waterBias, slopeAngle, textureClass) {
    const f = this.formation;
    const texProps = SOIL_PROPERTIES[textureClass] || SOIL_PROPERTIES[SOIL_TEXTURE_CLASS.LOAM];

    // Base erosion from wind.
    const windErosionRate = windErosion * 0.0001;

    // Water erosion from slope and flow bias.
    const waterErosionRate = waterBias * slopeAngle * 0.001;

    // Soil cohesion modulates how much is actually removed.
    const resistance = texProps.cohesion;

    return f.erosionRemovalRate * (windErosionRate + waterErosionRate) * (1 - resistance * 0.7);
  }

  // ══════════════════════════════════════════════════════════
  // ─── classify soil texture from fractions ──────────────
  // ══════════════════════════════════════════════════════════
  // USDA simplified classification. Fractions are 0..1 and sum to ~1.
  _classifyTexture(sand, silt, clay) {
    const total = sand + silt + clay + 0.0001;
    const sandPct = (sand / total) * 100;
    const siltPct = (silt / total) * 100;
    const clayPct = (clay / total) * 100;

    if (clayPct >= 40) {
      if (siltPct >= 40) return SOIL_TEXTURE_CLASS.SILTY_CLAY;
      if (sandPct >= 45) return SOIL_TEXTURE_CLASS.SANDY_CLAY;
      return SOIL_TEXTURE_CLASS.CLAY;
    }
    if (clayPct >= 27) {
      if (siltPct >= 40) return SOIL_TEXTURE_CLASS.SILTY_CLAY_LOAM;
      if (sandPct >= 45) return SOIL_TEXTURE_CLASS.SANDY_CLAY_LOAM;
      return SOIL_TEXTURE_CLASS.CLAY_LOAM;
    }
    if (siltPct >= 80) return SOIL_TEXTURE_CLASS.SILT;
    if (siltPct >= 50) return SOIL_TEXTURE_CLASS.SILT_LOAM;
    if (sandPct >= 85) return SOIL_TEXTURE_CLASS.SAND;
    if (sandPct >= 70) return SOIL_TEXTURE_CLASS.LOAMY_SAND;
    if (sandPct >= 43) return SOIL_TEXTURE_CLASS.SANDY_LOAM;
    return SOIL_TEXTURE_CLASS.LOAM;
  }

  // ══════════════════════════════════════════════════════════
  // ─── USLE K-factor computation ─────────────────────────
  // ══════════════════════════════════════════════════════════
  // K = (2.1e-4) · (12 − OM) · M^1.14 + 3.25·(s − 2) + 2.5·(p − 3)
  // OM = organic-matter percent, M = (silt + very-fine-sand) percent,
  // s = structure class (1=very fine granular, 4=blocky), p = permeability class (1=rapid, 6=very slow).
  _computeUsleKFactor(organicPercent, siltPlusFineSandPercent, structureClass, permeabilityClass) {
    if (!this.enableUsleKFactor) return 0;
    const c = this.usle;
    const omFactor = c.omFactorBase * Math.max(0, c.omTerm - organicPercent) *
                     Math.pow(Math.max(1, siltPlusFineSandPercent), c.mExponent);
    const structureFactor = c.structureFactor * (structureClass - 2);
    const permeabilityFactor = c.permeabilityFactor * (permeabilityClass - 3);
    return omFactor + structureFactor + permeabilityFactor;
  }

  _structureClassFromTexture(textureClass) {
    // 1 = very fine granular, 4 = blocky. Rough mapping.
    if (textureClass === SOIL_TEXTURE_CLASS.SAND) return 1;
    if (textureClass === SOIL_TEXTURE_CLASS.LOAMY_SAND) return 1;
    if (textureClass === SOIL_TEXTURE_CLASS.SANDY_LOAM) return 2;
    if (textureClass === SOIL_TEXTURE_CLASS.LOAM) return 2;
    if (textureClass === SOIL_TEXTURE_CLASS.SILT_LOAM) return 2;
    if (textureClass === SOIL_TEXTURE_CLASS.SILT) return 2;
    return 3;
  }

  _permeabilityClassFromTexture(textureClass) {
    // 1 = rapid, 6 = very slow. Rough mapping.
    if (textureClass === SOIL_TEXTURE_CLASS.SAND) return 1;
    if (textureClass === SOIL_TEXTURE_CLASS.LOAMY_SAND) return 2;
    if (textureClass === SOIL_TEXTURE_CLASS.SANDY_LOAM) return 3;
    if (textureClass === SOIL_TEXTURE_CLASS.LOAM) return 4;
    if (textureClass === SOIL_TEXTURE_CLASS.SILT_LOAM) return 4;
    if (textureClass === SOIL_TEXTURE_CLASS.SILT) return 5;
    return 6;   // clays
  }

  // ══════════════════════════════════════════════════════════
  // ─── chunk sampling ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _sampleChunk(cx, cz, frame, dtYears) {
    const chunkSize = this.defaults.chunkSize;
    const cellSize = this.defaults.cellSize;
    const cellsPerSide = Math.max(1, Math.floor(chunkSize / cellSize));

    let slot = this._getChunkSlot(cx, cz);
    if (!slot || slot < 0) slot = this._allocChunkSlot(cx, cz);

    // Allocate cell arrays.
    if (!this._chunkCellX[slot]) {
      this._chunkCellX[slot] = this._acquireCell('x');
      this._chunkCellY[slot] = this._acquireCell('y');
      this._chunkCellZ[slot] = this._acquireCell('z');
      this._chunkCellTexture[slot] = this._acquireTextureArray();
      this._chunkCellFractions[slot] = this._acquireFractionsArray();
      this._chunkCellUsleK[slot] = this._acquireCell('usleK');
      this._chunkCellPh[slot] = this._acquireCell('ph');
      this._chunkCellPorosity[slot] = this._acquireCell('porosity');
      this._chunkCellOrganicPct[slot] = this._acquireCell('organicPct');
    }

    const cpx = this._chunkCellX[slot];
    const cpy = this._chunkCellY[slot];
    const cpz = this._chunkCellZ[slot];
    const cpTex = this._chunkCellTexture[slot];
    const cpFrac = this._chunkCellFractions[slot];
    const cpK = this._chunkCellUsleK[slot];
    const cpPh = this._chunkCellPh[slot];
    const cpPor = this._chunkCellPorosity[slot];
    const cpOM = this._chunkCellOrganicPct[slot];

    let placed = 0;

    // Read global context.
    const physical = frame.layers.physical;
    const ambientTemp = physical?.ambientTemperature ?? 15;
    const humidity = physical?.relativeHumidity ?? 0.5;
    const soilMoisture = physical?.soilMoisture ?? 0.5;
    const windErosion = physical?.windErosionRate ?? 0;
    const decompRate = physical?.soilFertilityPulse ?? 0;

    // Aggregates.
    let sumSand = 0, sumSilt = 0, sumClay = 0, sumOM = 0, sumGravel = 0, sumRock = 0;
    let sumGrain = 0, sumPorosity = 0, sumBulk = 0, sumWHC = 0, sumK = 0;
    let sumCohesion = 0, sumPlasticity = 0, sumPh = 0;
    let sumUsleK = 0, sumAge = 0, sumDepth = 0;
    const classCount = new Uint16Array(SOIL_TEXTURE_NAMES.length);
    let dominantTex = SOIL_TEXTURE_CLASS.LOAM;
    let maxClassCount = 0;

    for (let j = 0; j < cellsPerSide && placed < this.defaults.maxCellsPerChunk; j++) {
      for (let i = 0; i < cellsPerSide && placed < this.defaults.maxCellsPerChunk; i++) {
        const wx = cx * chunkSize + (i + 0.5) * cellSize;
        const wz = cz * chunkSize + (j + 0.5) * cellSize;

        // ── Parent rock and initial composition ─────────
        const parentRock = this._getParentRock(wx, wz, frame);
        const rockSoil = ROCK_TO_SOIL[parentRock] || ROCK_TO_SOIL[ROCK_CLASS.GRANITE];

        // Start with the parent rock composition as the base.
        let sand = rockSoil[0];
        let silt = rockSoil[1];
        let clay = rockSoil[2];
        let organic = rockSoil[3];
        let gravel = rockSoil[4];
        let rock = rockSoil[5];

        // ── Jenny equation factors ──────────────────────
        const climate = this._climateFactor(ambientTemp, soilMoisture);
        const organisms = decompRate > 0 ? Math.min(1, decompRate * 10) : 0.3;
        const slope = this._slope ? this._slope.getSlopeAngle(wx, wz) : 0;
        const relief = 1 - slope / (Math.PI / 2);   // 1 = flat, 0 = vertical
        const parent = ROCK_PROPERTIES[parentRock]?.brittleness ?? 0.5;
        const ageFactor = 1 - Math.exp(-1);   // at equilibrium for the age model

        // ── Weathering rate: how much soil is formed per year ─
        const weatheringRate = this.formation.weatheringRateBase *
          climate * organisms * relief * parent;

        // Convert bedrock to soil (shift fractions toward weathered texture).
        const weatherShift = Math.min(0.05, weatheringRate * dtYears);

        // Sand fraction decreases as weathering proceeds (breaks into smaller grains).
        const sandToSilt = weatherShift * 0.3;
        const siltToClay = weatherShift * 0.2;

        sand = Math.max(0, sand - sandToSilt);
        silt = silt + sandToSilt - siltToClay;
        clay = clay + siltToClay;

        // ── Organic accumulation ────────────────────────
        const organicRate = this._organicAccumulationRate(ambientTemp, soilMoisture, organisms);
        const organicAdded = organicRate * dtYears;
        organic = Math.min(0.20, organic + organicAdded);

        // ── Erosion removal ────────────────────────────
        const waterBias = this._slope ? this._slope.getWaterFlowBias(wx, wz, 1.0) : 0.5;
        const erosion = this._erosionRemovalRate(windErosion, waterBias, slope, SOIL_TEXTURE_CLASS.LOAM);

        // Erosion removes the finest material first (clay and organic).
        const clayLost = Math.min(clay, erosion * 0.5);
        const organicLost = Math.min(organic, erosion * 0.3);
        clay -= clayLost;
        organic -= organicLost;

        // ── Normalize fractions to sum 1 ────────────────
        const total = sand + silt + clay + organic + gravel + rock + 0.0001;
        sand /= total; silt /= total; clay /= total;
        organic /= total; gravel /= total; rock /= total;

        // ── Texture classification ─────────────────────
        const texture = this._classifyTexture(sand, silt, clay);
        const texProps = SOIL_PROPERTIES[texture];

        // ── Organic percent and pH ─────────────────────
        const organicPercent = organic * 100;
        // pH: limestone → alkaline, granite → acidic, organic → acidic.
        let ph = texProps.ph;
        if (parentRock === ROCK_CLASS.LIMESTONE) ph += 1.0;
        if (parentRock === ROCK_CLASS.GRANITE) ph -= 0.5;
        if (organic > 0.05) ph -= 0.3;
        ph = Math.max(4.0, Math.min(9.0, ph));

        // ── USLE K-factor ──────────────────────────────
        const siltPlusFineSandPercent = (silt + sand * 0.5) * 100;
        const structureClass = this._structureClassFromTexture(texture);
        const permeabilityClass = this._permeabilityClassFromTexture(texture);
        const usleK = this._computeUsleKFactor(
          organicPercent, siltPlusFineSandPercent,
          structureClass, permeabilityClass
        );

        // ── Soil age and depth ─────────────────────────
        const soilAge = this._chunkSoilAgeYears[slot] || this.defaults.ageBaseYears;
        const soilDepth = Math.min(2.0,
          (this._chunkSoilDepthM[slot] || 0.5) + weatheringRate * dtYears - erosion * dtYears
        );

        // ── Store cell ─────────────────────────────────
        cpx[placed] = wx;
        cpy[placed] = this._getHeight(wx, wz);
        cpz[placed] = wz;
        cpTex[placed] = texture;
        const fo = placed * 6;
        cpFrac[fo]     = sand;
        cpFrac[fo + 1] = silt;
        cpFrac[fo + 2] = clay;
        cpFrac[fo + 3] = organic;
        cpFrac[fo + 4] = gravel;
        cpFrac[fo + 5] = rock;
        cpK[placed] = usleK;
        cpPh[placed] = ph;
        cpPor[placed] = texProps.porosity;
        cpOM[placed] = organicPercent;
        placed++;

        // ── Aggregate ──────────────────────────────────
        sumSand += sand;
        sumSilt += silt;
        sumClay += clay;
        sumOM += organic;
        sumGravel += gravel;
        sumRock += rock;
        sumGrain += texProps.grainSizeUm;
        sumPorosity += texProps.porosity;
        sumBulk += texProps.bulkDensity;
        sumWHC += texProps.waterHolding;
        sumK += texProps.hydraulicCond;
        sumCohesion += texProps.cohesion;
        sumPlasticity += texProps.plasticity;
        sumPh += ph;
        sumUsleK += usleK;
        sumAge += soilAge;
        sumDepth += soilDepth;
        classCount[texture]++;
        if (classCount[texture] > maxClassCount) {
          maxClassCount = classCount[texture];
          dominantTex = texture;
        }

        // Per-class stats.
        if (texture <= SOIL_TEXTURE_CLASS.SANDY_LOAM) this._stats.sandCells++;
        else if (texture <= SOIL_TEXTURE_CLASS.SILT_LOAM) this._stats.loamCells++;
        else if (texture <= SOIL_TEXTURE_CLASS.SILT) this._stats.siltCells++;
        else this._stats.clayCells++;
        if (organicPercent > 3.0) this._stats.highOrganicCells++;
        else if (organicPercent < 1.0) this._stats.lowOrganicCells++;
        if (ph < 5.5) this._stats.phAcidicCells++;
        else if (ph < 7.5) this._stats.phNeutralCells++;
        else this._stats.phAlkalineCells++;

        this._stats.cellsSampled++;
      }
    }

    this._chunkCellCount[slot] = placed;

    // ── Store per-chunk summary ──────────────────────────
    const inv = placed > 0 ? 1 / placed : 0;
    this._chunkSand[slot] = sumSand * inv;
    this._chunkSilt[slot] = sumSilt * inv;
    this._chunkClay[slot] = sumClay * inv;
    this._chunkOrganic[slot] = sumOM * inv;
    this._chunkGravel[slot] = sumGravel * inv;
    this._chunkRock[slot] = sumRock * inv;
    this._chunkTextureClass[slot] = dominantTex;
    this._chunkGrainSizeUm[slot] = sumGrain * inv;
    this._chunkPorosity[slot] = sumPorosity * inv;
    this._chunkBulkDensity[slot] = sumBulk * inv;
    this._chunkWaterHolding[slot] = sumWHC * inv;
    this._chunkHydraulicCond[slot] = sumK * inv;
    this._chunkCohesion[slot] = sumCohesion * inv;
    this._chunkPlasticity[slot] = sumPlasticity * inv;
    this._chunkPh[slot] = sumPh * inv;
    this._chunkUsleKFactor[slot] = sumUsleK * inv;
    this._chunkSoilAgeYears[slot] = sumAge * inv;
    this._chunkSoilDepthM[slot] = sumDepth * inv;
    this._chunkOrganicPercent[slot] = (sumOM * inv) * 100;
    this._chunkParentRock[slot] = this._getParentRock(
      cx * chunkSize + chunkSize * 0.5,
      cz * chunkSize + chunkSize * 0.5,
      frame
    );

    // Secondary fractions from organic + parent rock.
    this._chunkCalciumCarbonate[slot] = this._chunkParentRock[slot] === ROCK_CLASS.LIMESTONE
      ? this._chunkOrganic[slot] * 0.5 : this._chunkOrganic[slot] * 0.1;
    this._chunkIronOxide[slot] = (this._chunkParentRock[slot] === ROCK_CLASS.BASALT ||
      this._chunkParentRock[slot] === ROCK_CLASS.OBSIDIAN) ? 0.08 : 0.02;
    this._chunkHumus[slot] = this._chunkOrganic[slot] * 0.4;
    this._chunkNitrogen[slot] = this._chunkOrganicPercent[slot] * 0.05;
    this._chunkPhosphorus[slot] = this._chunkOrganicPercent[slot] * 0.005;
    this._chunkPotassium[slot] = this._chunkOrganicPercent[slot] * 0.01;

    this._stats.chunksProcessed++;

    // ── Class transition event ──────────────────────────
    const previousTex = this._chunkLastTexture[slot];
    const now = this._lastUpdateTime > 0 ? this._lastUpdateTime : 0;
    if (previousTex !== 0 && previousTex !== dominantTex &&
        now - this._chunkClassTransitionTime[slot] > this.defaults.classChangeCooldown) {
      this._chunkClassTransitionTime[slot] = now;
      this._stats.classTransitions++;

      if (this._dispatcher) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.MUTATION,
          [(cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize],
          -1, 30, 8.0,
          {
            kind: 'soil_class_transition',
            chunkX: cx, chunkZ: cz,
            fromTexture: previousTex,
            toTexture: dominantTex,
            fromTextureName: SOIL_TEXTURE_NAMES[previousTex],
            toTextureName: SOIL_TEXTURE_NAMES[dominantTex],
            organicPercent: this._chunkOrganicPercent[slot],
            pH: this._chunkPh[slot]
          }
        );
        this._stats.mutationEventsEmitted++;
      }
    }
    this._chunkLastTexture[slot] = dominantTex;

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
    this._chunkLastTexture[slot] = 0;
    this._chunkClassTransitionTime[slot] = 0;
    this._chunkSoilAgeYears[slot] = this.defaults.ageBaseYears;
    this._chunkSoilDepthM[slot] = 0.5;
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
      this._cellPool.usleK.push(this._chunkCellUsleK[slot]);
      this._cellPool.ph.push(this._chunkCellPh[slot]);
      this._cellPool.porosity.push(this._chunkCellPorosity[slot]);
      this._cellPool.organicPct.push(this._chunkCellOrganicPct[slot]);
      this._fractionsArrayPool.push(this._chunkCellFractions[slot]);
      this._textureArrayPool.push(this._chunkCellTexture[slot]);
    }
    this._chunkCellX[slot] = null;
    this._chunkCellY[slot] = null;
    this._chunkCellZ[slot] = null;
    this._chunkCellTexture[slot] = null;
    this._chunkCellFractions[slot] = null;
    this._chunkCellUsleK[slot] = null;
    this._chunkCellPh[slot] = null;
    this._chunkCellPorosity[slot] = null;
    this._chunkCellOrganicPct[slot] = null;
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

  _acquireTextureArray() {
    if (this._textureArrayPool.length > 0) {
      const arr = this._textureArrayPool.pop();
      arr.fill(0);
      return arr;
    }
    return new Uint8Array(this.defaults.maxCellsPerChunk);
  }

  _acquireFractionsArray() {
    if (this._fractionsArrayPool.length > 0) {
      const arr = this._fractionsArrayPool.pop();
      arr.fill(0);
      return arr;
    }
    return new Float32Array(this.defaults.maxCellsPerChunk * 6);
  }

  // ══════════════════════════════════════════════════════════
  // ─── public queries ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getSoilAt(wx, wz) {
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot < 0 || this._chunkState[slot] === 0) return null;

    return {
      sand: this._chunkSand[slot],
      silt: this._chunkSilt[slot],
      clay: this._chunkClay[slot],
      organic: this._chunkOrganic[slot],
      gravel: this._chunkGravel[slot],
      rock: this._chunkRock[slot],
      textureClass: this._chunkTextureClass[slot],
      textureName: SOIL_TEXTURE_NAMES[this._chunkTextureClass[slot]],
      grainSizeUm: this._chunkGrainSizeUm[slot],
      porosity: this._chunkPorosity[slot],
      bulkDensity: this._chunkBulkDensity[slot],
      waterHolding: this._chunkWaterHolding[slot],
      hydraulicCond: this._chunkHydraulicCond[slot],
      cohesion: this._chunkCohesion[slot],
      plasticity: this._chunkPlasticity[slot],
      pH: this._chunkPh[slot],
      usleKFactor: this._chunkUsleKFactor[slot],
      soilAgeYears: this._chunkSoilAgeYears[slot],
      soilDepthM: this._chunkSoilDepthM[slot],
      organicPercent: this._chunkOrganicPercent[slot],
      parentRock: this._chunkParentRock[slot],
      parentRockName: ROCK_CLASS_NAMES[this._chunkParentRock[slot]],
      calciumCarbonate: this._chunkCalciumCarbonate[slot],
      ironOxide: this._chunkIronOxide[slot],
      humus: this._chunkHumus[slot],
      nitrogen: this._chunkNitrogen[slot],
      phosphorus: this._chunkPhosphorus[slot],
      potassium: this._chunkPotassium[slot],
      cellCount: this._chunkCellCount[slot],
      cells: {
        x: this._chunkCellX[slot],
        y: this._chunkCellY[slot],
        z: this._chunkCellZ[slot],
        texture: this._chunkCellTexture[slot],
        fractions: this._chunkCellFractions[slot],
        usleK: this._chunkCellUsleK[slot],
        pH: this._chunkCellPh[slot],
        porosity: this._chunkCellPorosity[slot],
        organicPct: this._chunkCellOrganicPct[slot]
      }
    };
  }

  // Sample texture class at any world position.
  sampleSoilTextureAt(wx, wz, frame) {
    if (!frame) frame = this._frameRef;
    if (!frame) return SOIL_TEXTURE_CLASS.LOAM;

    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot >= 0 && this._chunkState[slot] === 1) {
      return this._chunkTextureClass[slot];
    }
    return SOIL_TEXTURE_CLASS.LOAM;
  }

  // Sample USLE K-factor for erosion model.
  sampleUsleKAt(wx, wz, frame) {
    if (!frame) frame = this._frameRef;
    if (!frame) return 0.03;

    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot >= 0 && this._chunkState[slot] === 1) {
      return this._chunkUsleKFactor[slot];
    }
    return 0.03;
  }

  // ══════════════════════════════════════════════════════════
  // ─── material parameter dispatch ────────────────────────
  // ══════════════════════════════════════════════════════════
  getSoilMaterialParams(textureClass) {
    return SOIL_MATERIAL[textureClass] || SOIL_MATERIAL[SOIL_TEXTURE_CLASS.LOAM];
  }

  blendSoilMaterial(textureClass, moisture, organicPercent, out) {
    const src = SOIL_MATERIAL[textureClass] || SOIL_MATERIAL[SOIL_TEXTURE_CLASS.LOAM];
    const o = out || this._blendedParams;

    o.pbr.baseColor[0] = src.pbr.baseColor[0];
    o.pbr.baseColor[1] = src.pbr.baseColor[1];
    o.pbr.baseColor[2] = src.pbr.baseColor[2];

    // Darker with organic matter.
    const omFactor = Math.min(0.4, organicPercent * 0.05);
    o.pbr.baseColor[0] *= (1 - omFactor);
    o.pbr.baseColor[1] *= (1 - omFactor);
    o.pbr.baseColor[2] *= (1 - omFactor);

    o.pbr.metalness = src.pbr.metalness;
    o.pbr.roughness = src.pbr.roughness * (1 - moisture * 0.4);
    o.pbr.clearcoat = src.pbr.clearcoat + moisture * 0.3;
    o.pbr.transmission = src.pbr.transmission;
    o.pbr.ior = src.pbr.ior;
    o.pbr.sheen = src.pbr.sheen;
    o.pbr.anisotropy = src.pbr.anisotropy;

    o.anime.baseColor[0] = src.anime.baseColor[0] * (1 - omFactor);
    o.anime.baseColor[1] = src.anime.baseColor[1] * (1 - omFactor);
    o.anime.baseColor[2] = src.anime.baseColor[2] * (1 - omFactor);
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

    o.normalScale = src.normalScale * (1 - moisture * 0.5);
    o.dustThreshold = src.dustThreshold * (1 - moisture * 0.7);

    return o;
  }

  // ══════════════════════════════════════════════════════════
  // ─── frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.soil) {
      spatial.soil = {
        chunkCount: 0,
        chunkCX: new Int32Array(this._chunkCap),
        chunkCZ: new Int32Array(this._chunkCap),
        chunkSlots: new Int32Array(this._chunkCap),
        sand: this._chunkSand,
        silt: this._chunkSilt,
        clay: this._chunkClay,
        organic: this._chunkOrganic,
        gravel: this._chunkGravel,
        rock: this._chunkRock,
        calciumCarbonate: this._chunkCalciumCarbonate,
        ironOxide: this._chunkIronOxide,
        humus: this._chunkHumus,
        nitrogen: this._chunkNitrogen,
        phosphorus: this._chunkPhosphorus,
        potassium: this._chunkPotassium,
        textureClass: this._chunkTextureClass,
        grainSizeUm: this._chunkGrainSizeUm,
        porosity: this._chunkPorosity,
        bulkDensity: this._chunkBulkDensity,
        waterHolding: this._chunkWaterHolding,
        hydraulicCond: this._chunkHydraulicCond,
        cohesion: this._chunkCohesion,
        plasticity: this._chunkPlasticity,
        pH: this._chunkPh,
        usleKFactor: this._chunkUsleKFactor,
        soilAgeYears: this._chunkSoilAgeYears,
        soilDepthM: this._chunkSoilDepthM,
        organicPercent: this._chunkOrganicPercent,
        parentRock: this._chunkParentRock,
        cells: {
          count: this._chunkCellCount,
          x: this._chunkCellX,
          y: this._chunkCellY,
          z: this._chunkCellZ,
          texture: this._chunkCellTexture,
          fractions: this._chunkCellFractions,
          usleK: this._chunkCellUsleK,
          pH: this._chunkCellPh,
          porosity: this._chunkCellPorosity,
          organicPct: this._chunkCellOrganicPct
        },
        materialParams: SOIL_MATERIAL,
        textureNames: SOIL_TEXTURE_NAMES,
        properties: SOIL_PROPERTIES
      };
    }

    const s = spatial.soil;
    s.chunkCount = 0;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      if (s.chunkCount >= this._chunkCap) break;
      s.chunkCX[s.chunkCount] = this._chunkCX[i];
      s.chunkCZ[s.chunkCount] = this._chunkCZ[i];
      s.chunkSlots[s.chunkCount] = i;
      s.chunkCount++;
    }
  }

  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    let sumSand = 0, sumSilt = 0, sumClay = 0, sumOM = 0, sumGravel = 0, sumRock = 0;
    let sumPorosity = 0, sumBulk = 0, sumPh = 0, sumUsleK = 0, sumAge = 0, sumDepth = 0;
    let sumOrgPct = 0;
    let chunksWithSoil = 0;
    const classCount = new Uint16Array(SOIL_TEXTURE_NAMES.length);

    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      chunksWithSoil++;
      sumSand += this._chunkSand[i];
      sumSilt += this._chunkSilt[i];
      sumClay += this._chunkClay[i];
      sumOM += this._chunkOrganic[i];
      sumGravel += this._chunkGravel[i];
      sumRock += this._chunkRock[i];
      sumPorosity += this._chunkPorosity[i];
      sumBulk += this._chunkBulkDensity[i];
      sumPh += this._chunkPh[i];
      sumUsleK += this._chunkUsleKFactor[i];
      sumAge += this._chunkSoilAgeYears[i];
      sumDepth += this._chunkSoilDepthM[i];
      sumOrgPct += this._chunkOrganicPercent[i];
      classCount[this._chunkTextureClass[i]]++;
    }

    const gs = this._globalSoil;
    const inv = chunksWithSoil > 0 ? 1 / chunksWithSoil : 0;
    gs.avgSand = sumSand * inv;
    gs.avgSilt = sumSilt * inv;
    gs.avgClay = sumClay * inv;
    gs.avgOrganic = sumOM * inv;
    gs.avgGravel = sumGravel * inv;
    gs.avgRock = sumRock * inv;
    gs.avgOrganicPercent = sumOrgPct * inv;
    gs.avgPh = sumPh * inv || 6.5;
    gs.avgPorosity = sumPorosity * inv || 0.45;
    gs.avgBulkDensity = sumBulk * inv || 1.35;
    gs.avgSoilDepth = sumDepth * inv || 0.5;
    gs.avgUsleKFactor = sumUsleK * inv || 0.03;
    gs.avgSoilAge = sumAge * inv || 5000;

    // Dominant texture.
    let dominantTex = SOIL_TEXTURE_CLASS.LOAM;
    let maxCount = 0;
    for (let t = 0; t < classCount.length; t++) {
      if (classCount[t] > maxCount) { maxCount = classCount[t]; dominantTex = t; }
    }
    gs.dominantTexture = dominantTex;

    // Erodibility class from K-factor.
    if (gs.avgUsleKFactor < 0.02) gs.erodibilityClass = 1;
    else if (gs.avgUsleKFactor < 0.04) gs.erodibilityClass = 2;
    else if (gs.avgUsleKFactor < 0.06) gs.erodibilityClass = 3;
    else gs.erodibilityClass = 4;

    if (!physical.soilProperties) physical.soilProperties = {};
    Object.assign(physical.soilProperties, gs);

    // Material-facing aggregates.
    physical.soilSand = gs.avgSand;
    physical.soilSilt = gs.avgSilt;
    physical.soilClay = gs.avgClay;
    physical.soilOrganic = gs.avgOrganic;
    physical.soilOrganicPercent = gs.avgOrganicPercent;
    physical.soilPh = gs.avgPh;
    physical.soilPorosity = gs.avgPorosity;
    physical.soilBulkDensity = gs.avgBulkDensity;
    physical.soilDepth = gs.avgSoilDepth;
    physical.soilUsleKFactor = gs.avgUsleKFactor;
    physical.soilAge = gs.avgSoilAge;
    physical.soilTexture = dominantTex;
    physical.soilTextureName = SOIL_TEXTURE_NAMES[dominantTex];
    physical.soilErodibilityClass = gs.erodibilityClass;

    if (!physical.soilTextureWeights) {
      physical.soilTextureWeights = new Float32Array(SOIL_TEXTURE_NAMES.length);
    }
    if (chunksWithSoil > 0) {
      for (let t = 0; t < classCount.length; t++) {
        physical.soilTextureWeights[t] = classCount[t] / chunksWithSoil;
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

    // Convert dt to "soil years" — accel by ageAcceleration.
    const dtYears = dtSeconds * this.defaults.ageAcceleration / (365 * 86400);

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
      const slot = this._getChunkSlot(cx, cz);
      if (slot >= 0 && this._chunkCellCount[slot] > 0) {
        // Re-sample with updated dt.
        this._sampleChunk(cx, cz, frame, dtYears);
      } else {
        this._sampleChunk(cx, cz, frame, dtYears);
      }
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

  setFormationConstants(params) {
    for (const k of Object.keys(this.formation)) {
      if (params[k] !== undefined) this.formation[k] = params[k];
    }
    return this;
  }

  setAgeAcceleration(accel) {
    if (accel > 0) this.defaults.ageAcceleration = accel;
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
  getGlobalSoil() { return { ...this._globalSoil }; }

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
    this._relief = null;
    this._rocks = null;
    this._forest = null;
    this._grass = null;
    this._continental = null;
    this._bathymetry = null;
    this._groundwater = null;
    this._moisture = null;
    this._decomposers = null;
    this._temperature = null;
    this._precipitation = null;
    this._wind = null;
    this._temporal = null;
    this._dispatcher = null;
    this._frameRef = null;
    this._clearAllChunks();
    for (const key of Object.keys(this._cellPool)) {
      this._cellPool[key].length = 0;
    }
    this._fractionsArrayPool.length = 0;
    this._textureArrayPool.length = 0;
  }
}

export {
  SoilCompositionProvider,
  SOIL_TEXTURE_CLASS,
  SOIL_TEXTURE_NAMES,
  SOIL_PROPERTIES,
  SOIL_MATERIAL,
  ROCK_TO_SOIL,
  SOIL_FORMATION,
  USLE_K_CONSTANTS,
  SOIL_DEFAULTS,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};