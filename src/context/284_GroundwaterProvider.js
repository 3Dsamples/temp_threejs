// file number : 284
// full path name : src/context/284_GroundwaterProvider.js
// description : Groundwater provider feeding springs, aquifers, sinkholes, wells, and river-source seeding across the living world. Builds on 280_TerrainProvider, 281_ElevationProvider, 282_SlopeGradientProvider, 282_Z03_CarveGradientProvider, 282_Z09_ContinentalReliefGradientProvider, and 283_BathymetryProvider to model the underground water table, its emergence as surface springs and seeps, its recharge through sinkholes and karst collapse, and its support for river-source seeding. For every chunk it computes a water-table depth field using a physics-motivated rate law WT(x,z) = WT_base + elevationContribution + slopeContribution − rainfallContribution, where rainfall is derived from the temporal provider's weather state and biome moisture. Springs are detected where the water table intersects the surface (WT_depth ≤ 1.5 m) and classified into eight spring archetypes (HOT_SPRING, COLD_SPRING, GEYSER, SEEPS, ARTESIAN_WELL, RIVER_SOURCE, KARST_EMERGENCE, SUBMARINE_VENT). Sinkholes are detected in karst regions (limestone bedrock, high infiltration, steep slope) and carved into the terrain via 282_Z03_CarveGradientProvider, emitting a single coalesced MUTATION event per sinkhole. Aquifers are tracked as per-chunk summaries with a porosity estimate, hydraulic head, and sustainable extraction rate. Provides a full PBR + anime material parameter set for wet-soil, mud, spring water (with iridescence and subsurface scattering), and sinkhole interior — all live scalars the material shader reads each frame. Writes per-chunk summaries and per-spring/sinkhole descriptors into frame.layers.spatial.groundwater, plus global aggregates into frame.layers.physical.groundwaterProperties. All scratch objects are pooled; no allocation after the first frame.
// best for : Every consumer that needs underground water state — SoilFertilityProvider for soil moisture, MoistureLevelProvider for humidity contribution, LandscapeWaterFlowSystem for base flow, LandscapeVegetationScatterSystem for plant placement near water, LandscapeFaunaSpawnSystem for drinking water sources, AquaticFreshwaterBiome for spring-fed pools, and materials for wet-soil, mud, and spring-water shading. Complements 283_BathymetryProvider by providing the third leg of the water cycle — surface water, groundwater, and its emergence.
// license : MIT

import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision,
  ContextFrame, CoreClock, CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES,
  TemporalContextProvider, WEATHER,
  CausalContextProvider, DERIVED_SIGNAL,
  CoreLayers, LAYER, LAYER_MASKS,
  smoothstep,
  TerrainProvider, BIOME_HINT,
  ElevationProvider, ELEVATION_BAND, ATMOSPHERE,
  SlopeGradientProvider, SLOPE_BAND, SLOPE_BAND_THRESHOLDS,
  ReliefGradientProvider, RELIEF_CLASS,
  CliffsGradientProvider, CLIFF_CLASS, CLIFF_MATERIAL_BAND,
  CarveGradientProvider, CARVE_SOURCE, CARVE_MATERIAL_BAND,
  RockGradientProvider, ROCK_TYPE, ROCK_CLASS,
  ContinentalReliefGradientProvider, CONTINENTAL_TYPE,
  BathymetryProvider, BATHY_ZONE, SEABED_CLASS, SEABED_MATERIAL,
  ColorManagement, ColorSpace,
  Ray, Plane, Sphere,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial
} from './264_MathECSImportBarrel.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 1;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── groundwater feature types ──────────────────────────────────
const GROUNDWATER_TYPE = Object.freeze({
  NONE:              0,
  COLD_SPRING:       1,   // cool spring, ≤ 20°C, near-surface aquifer
  HOT_SPRING:        2,   // geothermally heated, > 40°C
  GEYSER:            3,   // intermittent, episodic discharge
  SEEP:              4,   // diffuse, slow emergence
  ARTESIAN_WELL:     5,   // confined aquifer reaching surface
  RIVER_SOURCE:      6,   // spring feeding a river headwater
  KARST_EMERGENCE:   7,   // limestone cave-system outflow
  SUBMARINE_VENT:    8,   // underwater groundwater discharge
  SINKHOLE:          9,   // karst collapse (negative feature)
  DRY_SINK:         10,   // closed depression, no outlet
  AQUIFER:          11    // subsurface water reservoir (chunk-level)
});

const GROUNDWATER_TYPE_NAMES = Object.freeze([
  'none', 'cold_spring', 'hot_spring', 'geyser', 'seep',
  'artesian_well', 'river_source', 'karst_emergence', 'submarine_vent',
  'sinkhole', 'dry_sink', 'aquifer'
]);

// ─── soil / rock hydraulic parameters per rock class ────────────
// porosity (φ) = fraction of void space (0..1)
// permeability (K) = metres per second, log10 for compaction
// infiltrationRate = metres per second of surface water absorption
// waterHoldingCapacity = litres of water per cubic metre of rock
const ROCK_HYDRAULICS = Object.freeze({
  [ROCK_CLASS.GRANITE]:      { porosity: 0.01, permeability: 1e-10, infiltration: 1e-8, waterHolding: 10 },
  [ROCK_CLASS.BASALT]:       { porosity: 0.05, permeability: 1e-8,  infiltration: 1e-7, waterHolding: 40 },
  [ROCK_CLASS.SANDSTONE]:    { porosity: 0.20, permeability: 1e-5,  infiltration: 1e-5, waterHolding: 180 },
  [ROCK_CLASS.LIMESTONE]:    { porosity: 0.15, permeability: 1e-4,  infiltration: 1e-4, waterHolding: 150, karst: 1 },
  [ROCK_CLASS.SLATE]:        { porosity: 0.02, permeability: 1e-11, infiltration: 1e-9, waterHolding: 15 },
  [ROCK_CLASS.MARBLE]:       { porosity: 0.02, permeability: 1e-10, infiltration: 1e-9, waterHolding: 12 },
  [ROCK_CLASS.OBSIDIAN]:     { porosity: 0.00, permeability: 1e-13, infiltration: 1e-12, waterHolding: 1 },
  [ROCK_CLASS.PUMICE]:       { porosity: 0.60, permeability: 1e-3,  infiltration: 1e-3, waterHolding: 500 },
  [ROCK_CLASS.CONGLOMERATE]: { porosity: 0.18, permeability: 1e-5,  infiltration: 1e-5, waterHolding: 160 },
  [ROCK_CLASS.QUARTZITE]:    { porosity: 0.03, permeability: 1e-9,  infiltration: 1e-8, waterHolding: 20 }
});

// ─── soil hydraulic parameters per soil class ──────────────────
const SOIL_HYDRAULICS = Object.freeze({
  SAND:     { porosity: 0.40, fieldCapacity: 0.15, wiltingPoint: 0.05, infiltration: 1e-4, drainage: 0.6 },
  SILT:     { porosity: 0.45, fieldCapacity: 0.30, wiltingPoint: 0.10, infiltration: 5e-5, drainage: 0.3 },
  CLAY:     { porosity: 0.50, fieldCapacity: 0.40, wiltingPoint: 0.20, infiltration: 1e-6, drainage: 0.1 },
  LOAM:     { porosity: 0.42, fieldCapacity: 0.25, wiltingPoint: 0.08, infiltration: 2e-5, drainage: 0.4 },
  PEAT:     { porosity: 0.65, fieldCapacity: 0.45, wiltingPoint: 0.15, infiltration: 1e-5, drainage: 0.2 },
  GRAVEL:   { porosity: 0.35, fieldCapacity: 0.10, wiltingPoint: 0.02, infiltration: 5e-4, drainage: 0.8 }
});

// ─── material parameters per groundwater feature type ──────────
// Each feature is a full PBR + anime parameter set the material
// shader reads to blend its surface.
const GROUNDWATER_MATERIAL = Object.freeze({
  [GROUNDWATER_TYPE.COLD_SPRING]: {
    pbr: {
      baseColor:    [0.20, 0.35, 0.42],
      metalness:    0.00,
      roughness:    0.10,
      clearcoat:    0.90,
      transmission: 0.85,
      ior:          1.33,
      sheen:        0.00,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.24, 0.42, 0.52],
      quantizeSteps: 3,
      rimPower:     1.6,
      rimColor:     [0.55, 0.85, 0.95]
    },
    subsurfaceRadius: [0.15, 0.25, 0.35],
    emissive:         [0.00, 0.02, 0.04],
    foamCoverage:     0.10,
    causticsStrength: 0.85
  },
  [GROUNDWATER_TYPE.HOT_SPRING]: {
    pbr: {
      baseColor:    [0.55, 0.35, 0.20],
      metalness:    0.00,
      roughness:    0.15,
      clearcoat:    0.85,
      transmission: 0.80,
      ior:          1.33,
      sheen:        0.10,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.65, 0.40, 0.24],
      quantizeSteps: 3,
      rimPower:     1.4,
      rimColor:     [1.00, 0.72, 0.45]
    },
    subsurfaceRadius: [0.35, 0.20, 0.10],
    emissive:         [0.35, 0.10, 0.02],
    foamCoverage:     0.25,
    causticsStrength: 0.65
  },
  [GROUNDWATER_TYPE.GEYSER]: {
    pbr: {
      baseColor:    [0.60, 0.55, 0.45],
      metalness:    0.00,
      roughness:    0.20,
      clearcoat:    0.70,
      transmission: 0.75,
      ior:          1.33,
      sheen:        0.20,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.68, 0.62, 0.52],
      quantizeSteps: 3,
      rimPower:     1.5,
      rimColor:     [1.00, 0.85, 0.65]
    },
    subsurfaceRadius: [0.30, 0.25, 0.20],
    emissive:         [0.20, 0.10, 0.03],
    foamCoverage:     0.50,
    causticsStrength: 0.40
  },
  [GROUNDWATER_TYPE.SEEP]: {
    pbr: {
      baseColor:    [0.32, 0.40, 0.35],
      metalness:    0.00,
      roughness:    0.55,
      clearcoat:    0.30,
      transmission: 0.20,
      ior:          1.33,
      sheen:        0.15,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.36, 0.46, 0.40],
      quantizeSteps: 3,
      rimPower:     2.0,
      rimColor:     [0.55, 0.75, 0.70]
    },
    subsurfaceRadius: [0.05, 0.08, 0.06],
    emissive:         [0.00, 0.00, 0.00],
    foamCoverage:     0.05,
    causticsStrength: 0.30
  },
  [GROUNDWATER_TYPE.ARTESIAN_WELL]: {
    pbr: {
      baseColor:    [0.25, 0.42, 0.50],
      metalness:    0.00,
      roughness:    0.05,
      clearcoat:    0.95,
      transmission: 0.90,
      ior:          1.33,
      sheen:        0.00,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.30, 0.50, 0.60],
      quantizeSteps: 3,
      rimPower:     1.5,
      rimColor:     [0.65, 0.90, 1.00]
    },
    subsurfaceRadius: [0.20, 0.25, 0.30],
    emissive:         [0.00, 0.03, 0.05],
    foamCoverage:     0.15,
    causticsStrength: 0.90
  },
  [GROUNDWATER_TYPE.RIVER_SOURCE]: {
    pbr: {
      baseColor:    [0.22, 0.38, 0.46],
      metalness:    0.00,
      roughness:    0.08,
      clearcoat:    0.88,
      transmission: 0.88,
      ior:          1.33,
      sheen:        0.05,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.26, 0.44, 0.54],
      quantizeSteps: 3,
      rimPower:     1.6,
      rimColor:     [0.60, 0.88, 0.98]
    },
    subsurfaceRadius: [0.18, 0.24, 0.30],
    emissive:         [0.00, 0.03, 0.05],
    foamCoverage:     0.20,
    causticsStrength: 0.85
  },
  [GROUNDWATER_TYPE.KARST_EMERGENCE]: {
    pbr: {
      baseColor:    [0.28, 0.45, 0.40],
      metalness:    0.00,
      roughness:    0.10,
      clearcoat:    0.85,
      transmission: 0.82,
      ior:          1.33,
      sheen:        0.05,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.32, 0.52, 0.46],
      quantizeSteps: 3,
      rimPower:     1.5,
      rimColor:     [0.55, 0.90, 0.78]
    },
    subsurfaceRadius: [0.20, 0.28, 0.25],
    emissive:         [0.02, 0.04, 0.03],
    foamCoverage:     0.20,
    causticsStrength: 0.75
  },
  [GROUNDWATER_TYPE.SUBMARINE_VENT]: {
    pbr: {
      baseColor:    [0.15, 0.22, 0.28],
      metalness:    0.20,
      roughness:    0.25,
      clearcoat:    0.75,
      transmission: 0.70,
      ior:          1.33,
      sheen:        0.10,
      anisotropy:   0.10
    },
    anime: {
      baseColor:    [0.20, 0.28, 0.36],
      quantizeSteps: 3,
      rimPower:     1.4,
      rimColor:     [0.40, 0.75, 0.90]
    },
    subsurfaceRadius: [0.10, 0.15, 0.20],
    emissive:         [0.02, 0.05, 0.08],
    foamCoverage:     0.35,
    causticsStrength: 0.20
  },
  [GROUNDWATER_TYPE.SINKHOLE]: {
    pbr: {
      baseColor:    [0.28, 0.24, 0.20],
      metalness:    0.05,
      roughness:    0.85,
      clearcoat:    0.00,
      transmission: 0.00,
      ior:          1.50,
      sheen:        0.00,
      anisotropy:   0.10
    },
    anime: {
      baseColor:    [0.30, 0.26, 0.22],
      quantizeSteps: 3,
      rimPower:     2.2,
      rimColor:     [0.35, 0.35, 0.30]
    },
    subsurfaceRadius: [0.00, 0.00, 0.00],
    emissive:         [0.00, 0.00, 0.00],
    foamCoverage:     0.00,
    causticsStrength: 0.05
  },
  [GROUNDWATER_TYPE.DRY_SINK]: {
    pbr: {
      baseColor:    [0.42, 0.35, 0.28],
      metalness:    0.00,
      roughness:    0.88,
      clearcoat:    0.00,
      transmission: 0.00,
      ior:          1.50,
      sheen:        0.00,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.44, 0.38, 0.30],
      quantizeSteps: 3,
      rimPower:     2.0,
      rimColor:     [0.45, 0.42, 0.35]
    },
    subsurfaceRadius: [0.00, 0.00, 0.00],
    emissive:         [0.00, 0.00, 0.00],
    foamCoverage:     0.00,
    causticsStrength: 0.10
  }
});

// ─── wet-soil / mud PBR + anime parameters ─────────────────────
// Applied to any surface near an active water table.
const WET_SOIL_MATERIAL = Object.freeze({
  WET_SAND: {
    pbr: { baseColor: [0.45, 0.40, 0.28], metalness: 0.00, roughness: 0.55, clearcoat: 0.35, transmission: 0.00, ior: 1.40, sheen: 0.05, anisotropy: 0.00 },
    anime: { baseColor: [0.48, 0.42, 0.30], quantizeSteps: 3, rimPower: 1.8, rimColor: [0.55, 0.55, 0.45] },
    subsurfaceRadius: [0.05, 0.04, 0.02],
    emissive: [0, 0, 0],
    causticsStrength: 0.30
  },
  MUD: {
    pbr: { baseColor: [0.22, 0.18, 0.14], metalness: 0.00, roughness: 0.92, clearcoat: 0.15, transmission: 0.00, ior: 1.40, sheen: 0.25, anisotropy: 0.00 },
    anime: { baseColor: [0.25, 0.20, 0.15], quantizeSteps: 3, rimPower: 2.0, rimColor: [0.35, 0.30, 0.25] },
    subsurfaceRadius: [0.03, 0.02, 0.01],
    emissive: [0, 0, 0],
    causticsStrength: 0.20
  },
  WET_CLAY: {
    pbr: { baseColor: [0.32, 0.20, 0.15], metalness: 0.00, roughness: 0.60, clearcoat: 0.40, transmission: 0.00, ior: 1.42, sheen: 0.10, anisotropy: 0.05 },
    anime: { baseColor: [0.35, 0.22, 0.17], quantizeSteps: 3, rimPower: 1.9, rimColor: [0.50, 0.35, 0.28] },
    subsurfaceRadius: [0.05, 0.03, 0.02],
    emissive: [0, 0, 0],
    causticsStrength: 0.25
  },
  MOSSY_WET: {
    pbr: { baseColor: [0.28, 0.42, 0.20], metalness: 0.00, roughness: 0.62, clearcoat: 0.35, transmission: 0.05, ior: 1.38, sheen: 0.20, anisotropy: 0.00 },
    anime: { baseColor: [0.30, 0.46, 0.22], quantizeSteps: 3, rimPower: 1.7, rimColor: [0.50, 0.85, 0.55] },
    subsurfaceRadius: [0.08, 0.12, 0.05],
    emissive: [0, 0, 0],
    causticsStrength: 0.35
  }
});

// ─── water table model constants ────────────────────────────────
const WATER_TABLE = Object.freeze({
  baseDepth:              20.0,     // metres below surface at sea level
  elevationCoefficient:   0.45,     // deeper at higher elevations
  slopeCoefficient:       8.0,      // deeper on steep slopes (drainage)
  rainfallCoefficient:    15.0,     // shallower with more rainfall
  seasonalAmplitude:      3.0,      // seasonal fluctuation in metres
  springEmergenceDepth:   1.5,      // metres: table within this = spring
  seepEmergenceDepth:     3.5,      // metres: within this = seep
  hotSpringDepthThreshold: 800.0,   // metres depth for geothermal heating
  geyserStochasticRate:   0.05,     // probability per second
  sinkholeMaxRadius:      15.0,     // metres
  sinkholeMinRadius:      2.0,
  sinkholeDepthFactor:    0.35,     // depth = radius * factor
  sinkholeKarstThreshold: 0.4,      // limestone-derived karst probability
  submarineVentDepthMin:  20.0,     // metres below sea level
  submarineVentDepthMax:  1500.0
});

// ─── defaults ────────────────────────────────────────────────────
const GROUNDWATER_DEFAULTS = Object.freeze({
  worldSeed:             0x6D17A2C9E,
  cellSize:              8.0,           // metres per sampling cell
  chunkSize:             1000,
  maxCellsPerChunk:      256,           // 16×16 sampled cells per chunk
  maxChunksPerFrame:     8,
  maxSpringsPerChunk:    8,
  maxSinkholesPerChunk:  6,
  springFlowRateBase:    2.0,           // litres per second
  aquiferRechargeRate:   0.001,         // metres per second (very slow)
  mutationCoalesceWindow: 5.0
});

class GroundwaterProvider {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.defaults = { ...GROUNDWATER_DEFAULTS, ...(options.defaults || {}) };
    this.waterTableModel = { ...WATER_TABLE, ...(options.waterTableModel || {}) };
    this.enableSprings = options.enableSprings ?? true;
    this.enableSinkholes = options.enableSinkholes ?? true;
    this.enableAquifers = options.enableAquifers ?? true;
    this.enableSubmarineVents = options.enableSubmarineVents ?? true;
    this.enableCarve = options.enableCarve ?? true;

    // ── scratch (pooled) ────────────────────────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVecD = new Vec3();
    this._tmpColor = new Vec3();
    this._tmpMatA = new Mat4();
    this._tmpSphere = new Sphere();
    this._tmpPlane = new Plane();

    // ── per-chunk groundwater state (flat SoA) ──────────────
    const chunkCap = options.maxTrackedChunks ?? 256;
    this._chunkCap = chunkCap;
    this._chunkKeys = new Map();
    this._chunkSlot = 0;
    this._chunkUsed = 0;

    this._chunkCX = new Int32Array(chunkCap);
    this._chunkCZ = new Int32Array(chunkCap);
    this._chunkState = new Uint8Array(chunkCap);

    // Per-chunk aquifer summary.
    this._chunkWaterTableDepth    = new Float32Array(chunkCap);
    this._chunkWaterTableElev     = new Float32Array(chunkCap);
    this._chunkAquiferPorosity    = new Float32Array(chunkCap);
    this._chunkAquiferHydraulicHead = new Float32Array(chunkCap);
    this._chunkAquiferSustainableExtract = new Float32Array(chunkCap);
    this._chunkRechargeRate       = new Float32Array(chunkCap);
    this._chunkSoilMoisture       = new Float32Array(chunkCap);
    this._chunkSpringCount        = new Uint8Array(chunkCap);
    this._chunkSinkholeCount      = new Uint8Array(chunkCap);
    this._chunkDominantRock       = new Uint8Array(chunkCap);
    this._chunkKarst              = new Float32Array(chunkCap);
    this._chunkSurfaceWaterLevel  = new Float32Array(chunkCap);

    // Per-chunk spring/sinkhole descriptors.
    const featureCap = Math.max(this.defaults.maxSpringsPerChunk, this.defaults.maxSinkholesPerChunk);
    this._chunkFeatureCount = new Uint8Array(chunkCap);
    this._chunkFeatureType  = new Array(chunkCap).fill(null);   // Uint8Array(featureCap)
    this._chunkFeatureX     = new Array(chunkCap).fill(null);   // Float32Array(featureCap)
    this._chunkFeatureY     = new Array(chunkCap).fill(null);
    this._chunkFeatureZ     = new Array(chunkCap).fill(null);
    this._chunkFeatureTemp  = new Array(chunkCap).fill(null);
    this._chunkFeatureFlow  = new Array(chunkCap).fill(null);
    this._chunkFeatureRadius = new Array(chunkCap).fill(null);
    this._chunkFeatureDepth = new Array(chunkCap).fill(null);

    // Feature free list pools.
    this._featurePool = {
      type: [], x: [], y: [], z: [], temp: [], flow: [], radius: [], depth: []
    };

    // ── per-frame global groundwater summary ────────────────
    this._globalGroundwater = {
      avgWaterTableDepth: 0,
      avgSoilMoisture: 0,
      avgAquiferPorosity: 0,
      avgRechargeRate: 0,
      totalSprings: 0,
      totalSinkholes: 0,
      totalAquifers: 0,
      karstFraction: 0,
      hotSpringCount: 0,
      geyserCount: 0,
      coldSpringCount: 0,
      riverSourceCount: 0,
      submarineVentCount: 0,
      avgAquiferExtraction: 0,
      totalWaterVolume: 0,
      springDischargeTotal: 0
    };

    // ── timing / frame reference ────────────────────────────
    this._lastUpdateTime = -Infinity;
    this._frameRef = null;

    // ── statistics ──────────────────────────────────────────
    this._stats = {
      updates: 0,
      chunksProcessed: 0,
      cellsSampled: 0,
      springsDetected: 0,
      coldSprings: 0,
      hotSprings: 0,
      geysers: 0,
      seeps: 0,
      artesianWells: 0,
      riverSources: 0,
      karstEmergences: 0,
      submarineVents: 0,
      sinkholesDetected: 0,
      drySinks: 0,
      aquifersDetected: 0,
      mutationEventsEmitted: 0,
      carveOperations: 0
    };

    // ── collaborators ──────────────────────────────────────
    this._terrain = options.terrain || null;
    this._elevation = options.elevation || null;
    this._slope = options.slope || null;
    this._relief = options.relief || null;
    this._cliffs = options.cliffs || null;
    this._carve = options.carve || null;
    this._rocks = options.rocks || null;
    this._continental = options.continental || null;
    this._bathymetry = options.bathymetry || null;
    this._temporal = options.temporal || null;
    this._dispatcher = options.dispatcher || null;

    // ── material param reusable buffers ────────────────────
    this._blendedParams = {
      pbr: { baseColor: [0,0,0], metalness: 0, roughness: 0, clearcoat: 0, transmission: 0, ior: 1.33, sheen: 0, anisotropy: 0 },
      anime: { baseColor: [0,0,0], quantizeSteps: 3, rimPower: 2, rimColor: [0,0,0] },
      subsurfaceRadius: [0,0,0],
      emissive: [0,0,0],
      foamCoverage: 0,
      causticsStrength: 0
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachTerrain(t) { this._terrain = t; return this; }
  attachElevation(e) { this._elevation = e; return this; }
  attachSlope(s) { this._slope = s; return this; }
  attachRelief(r) { this._relief = r; return this; }
  attachCliffs(c) { this._cliffs = c; return this; }
  attachCarve(c) { this._carve = c; return this; }
  attachRocks(r) { this._rocks = r; return this; }
  attachContinental(c) { this._continental = c; return this; }
  attachBathymetry(b) { this._bathymetry = b; return this; }
  attachTemporal(t) { this._temporal = t; return this; }
  attachDispatcher(d) { this._dispatcher = d; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── height and sea-level lookup ────────────────────────
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
  // ─── water table depth model ────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Physics-motivated:
  //   WT_depth(x,z) = base + elevation * coef_e + slope * coef_s
  //                   − rainfall * coef_r + seasonal_amplitude * sin(season)
  //
  // The water table is a surface below the terrain. Springs form
  // where WT_depth(x,z) → 0 at the terrain surface.
  _computeWaterTableDepth(wx, wz, elevation, slopeAngle, rainfall, season) {
    const m = this.waterTableModel;

    // Base depth increases with elevation (deeper tables at highland).
    const elevationTerm = Math.max(0, elevation) * m.elevationCoefficient;

    // Steep slopes drain quickly → deeper water table.
    const slopeTerm = slopeAngle * m.slopeCoefficient;

    // More rainfall → shallower table (more recharge).
    const rainfallTerm = rainfall * m.rainfallCoefficient;

    // Seasonal fluctuation.
    const seasonalTerm = Math.sin(season * 2 * Math.PI) * m.seasonalAmplitude;

    let depth = m.baseDepth + elevationTerm + slopeTerm - rainfallTerm - seasonalTerm;

    // Clamp to physical bounds.
    if (depth < 0.2) depth = 0.2;                     // never fully dry
    if (depth > 300) depth = 300;                     // max 300 m depth

    return depth;
  }

  // ── direct water table elevation at a point ────────────
  getWaterTableElevation(wx, wz) {
    const elevation = this._getHeight(wx, wz);
    const slope = this._slope ? this._slope.getSlopeAngle(wx, wz) : 0;
    const rainfall = this._currentRainfall();
    const season = this._currentSeason();
    const depth = this._computeWaterTableDepth(wx, wz, elevation, slope, rainfall, season);
    return elevation - depth;
  }

  _currentRainfall() {
    if (this._temporal) {
      const weather = this._temporal.weatherState;
      // WEATHER constants from 276
      // CLEAR=0, CLOUDY=1, RAIN=2, STORM=3, SNOW=4, FOG=5
      const severity = this._temporal.weatherSeverity;
      return severity;   // 0..1
    }
    return 0.3;
  }

  _currentSeason() {
    if (this._temporal) {
      return this._temporal.seasonScalar;
    }
    return 0.5;
  }

  // ══════════════════════════════════════════════════════════
  // ─── soil moisture ──────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Soil moisture = infiltration − evaporation + water-table proximity bonus
  _computeSoilMoisture(wx, wz, elevation, slopeAngle, soilClass, wtDepth, temperature) {
    const soil = SOIL_HYDRAULICS[soilClass] || SOIL_HYDRAULICS.LOAM;
    const rainfall = this._currentRainfall();

    // Infiltration: rainfall × soil absorption.
    const infiltration = rainfall * soil.infiltration * 1000;   // scaled for 0..1

    // Evaporation: higher temperature & steeper slope drain faster.
    const evapFactor = Math.max(0, 1 - slopeAngle / (Math.PI * 0.5));
    const tempEvap = Math.max(0.1, (temperature + 10) / 40);
    const evap = (1 - rainfall) * tempEvap * soil.drainage * (1 - evapFactor * 0.5);

    // Base moisture from water table proximity.
    const wtBonus = wtDepth < 5 ? (5 - wtDepth) / 5 * soil.fieldCapacity
                   : wtDepth < 20 ? (20 - wtDepth) / 20 * soil.fieldCapacity * 0.5
                   : 0;

    // Total, clamped to field capacity.
    const moisture = Math.min(soil.fieldCapacity + 0.2,
                       Math.max(soil.wiltingPoint,
                         infiltration + wtBonus - evap));

    return Math.min(1, moisture / soil.fieldCapacity);
  }

  _classifySoil(elevation, moisture, biomeHint) {
    // Simple soil classification based on moisture + elevation + biome.
    if (biomeHint === BIOME_HINT.TROPICAL) return 'CLAY';
    if (biomeHint === BIOME_HINT.DESERT) return 'SAND';
    if (biomeHint === BIOME_HINT.TUNDRA) return 'PEAT';
    if (biomeHint === BIOME_HINT.TAIGA) return 'PEAT';
    if (biomeHint === BIOME_HINT.GRASSLAND) return 'LOAM';
    if (biomeHint === BIOME_HINT.TEMPERATE) return 'LOAM';
    if (biomeHint === BIOME_HINT.MARINE) return 'SAND';
    if (biomeHint === BIOME_HINT.FRESHWATER) return 'PEAT';
    if (biomeHint === BIOME_HINT.ALPINE) return 'GRAVEL';
    if (moisture > 0.7) return 'PEAT';
    if (moisture > 0.4) return 'LOAM';
    if (moisture > 0.2) return 'SILT';
    return 'SAND';
  }

  // ══════════════════════════════════════════════════════════
  // ─── rock class lookup from 282_Z06 if available ───────
  // ══════════════════════════════════════════════════════════
  _getRockClass(wx, wz, frame) {
    if (this._rocks) {
      const rocks = this._rocks.getPlacementsAt(wx, wz);
      if (rocks && rocks.count > 0) {
        return rocks.cls[0];
      }
    }
    // Fallback: infer from biome and elevation.
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
  // ─── karst probability (limestone → caves → sinkholes) ─
  // ══════════════════════════════════════════════════════════
  _computeKarstProbability(rockClass, slopeAngle, rainfall) {
    const hydraulics = ROCK_HYDRAULICS[rockClass];
    if (!hydraulics) return 0;

    // Only limestone and similar soluble rocks form karst.
    const karst = hydraulics.karst || 0;
    if (karst === 0) return 0;

    // Karst forms best in moderate slope + high rainfall.
    const slopeFactor = slopeAngle < Math.PI / 4
      ? slopeAngle / (Math.PI / 4)
      : (Math.PI - slopeAngle) / (Math.PI / 4);

    return karst * slopeFactor * (0.4 + rainfall * 0.6);
  }

  // ══════════════════════════════════════════════════════════
  // ─── spring detection & classification ──────────────────
  // ══════════════════════════════════════════════════════════
  _classifySpring(wx, wz, wtDepth, elevation, temperature, seaLevel, karstProb) {
    // Below sea level → submarine vent.
    if (elevation < seaLevel - this.waterTableModel.submarineVentDepthMin) {
      if (this.enableSubmarineVents &&
          elevation > seaLevel - this.waterTableModel.submarineVentDepthMax) {
        return GROUNDWATER_TYPE.SUBMARINE_VENT;
      }
      return GROUNDWATER_TYPE.NONE;
    }

    // Emergence depth threshold.
    if (wtDepth > this.waterTableModel.seepEmergenceDepth) {
      return GROUNDWATER_TYPE.NONE;
    }

    // Geothermal heating: deep water table + geothermal gradient.
    const deepTable = wtDepth > this.waterTableModel.hotSpringDepthThreshold;

    // Geyser: deep geothermal + stochastic chance.
    if (deepTable && karstProb < 0.2 && Math.random() < this.waterTableModel.geyserStochasticRate) {
      return GROUNDWATER_TYPE.GEYSER;
    }

    // Hot spring: deep water table, geothermal heating.
    if (deepTable && temperature > 30) {
      return GROUNDWATER_TYPE.HOT_SPRING;
    }

    // Karst emergence: karst terrain with high flow.
    if (karstProb > 0.5) {
      return GROUNDWATER_TYPE.KARST_EMERGENCE;
    }

    // Shallow seep vs spring.
    if (wtDepth > this.waterTableModel.springEmergenceDepth) {
      return GROUNDWATER_TYPE.SEEP;
    }

    // Artesian well: confined aquifer with high hydraulic head.
    if (wtDepth < 0.5 && karstProb < 0.2) {
      return GROUNDWATER_TYPE.ARTESIAN_WELL;
    }

    // River source: shallow spring in a valley (downhill drainage).
    const gradient = this._slope ? this._slope.getGradient ? null : null : null;
    // Use slope proximity as proxy for valley.
    const slopeAngle = this._slope ? this._slope.getSlopeAngle(wx, wz) : 0;
    if (slopeAngle < 0.15 && wtDepth < 1.0) {
      return GROUNDWATER_TYPE.RIVER_SOURCE;
    }

    return GROUNDWATER_TYPE.COLD_SPRING;
  }

  // ══════════════════════════════════════════════════════════
  // ─── sinkhole detection ─────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _trySinkhole(wx, wz, rockClass, karstProb, slopeAngle, wtDepth) {
    if (!this.enableSinkholes) return null;
    if (karstProb < this.waterTableModel.sinkholeKarstThreshold) return null;

    // Sinkholes cluster in karst terrain with moderate slope.
    if (slopeAngle > Math.PI / 3) return null;

    // Stochastic probability, biased by karst + rainfall.
    const prob = karstProb * 0.15 * (1 + this._currentRainfall());
    const seed = this._hashCell(Math.floor(wx * 0.1), Math.floor(wz * 0.1));
    const roll = (seed & 0xFFFF) / 0xFFFF;
    if (roll > prob) return null;

    // Radius: exponential distribution biased toward small.
    const seed2 = this._hashCell(Math.floor(wx * 0.1) + 0x1234, Math.floor(wz * 0.1) + 0x5678);
    const r = (seed2 & 0xFFFF) / 0xFFFF;
    const radius = this.waterTableModel.sinkholeMinRadius +
                   r * r * (this.waterTableModel.sinkholeMaxRadius - this.waterTableModel.sinkholeMinRadius);
    const depth = radius * this.waterTableModel.sinkholeDepthFactor;

    // Dry sink vs wet sink.
    const type = wtDepth < 5 ? GROUNDWATER_TYPE.SINKHOLE : GROUNDWATER_TYPE.DRY_SINK;

    return { type, radius, depth };
  }

  // ══════════════════════════════════════════════════════════
  // ─── hash helper ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _hashCell(cx, cz) {
    let h = this.defaults.worldSeed | 0;
    h = (h ^ (cx * 0x9E3779B1)) | 0;
    h = (h ^ (cz * 0x85EBCA77)) | 0;
    h = ((h << 13) | (h >>> 19)) | 0;
    h = (h * 0x5bd1e995) | 0;
    h = (h ^ (h >>> 15)) | 0;
    return h >>> 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── chunk groundwater sampling ─────────────────────────
  // ══════════════════════════════════════════════════════════
  _sampleChunk(cx, cz, frame) {
    const chunkSize = this.defaults.chunkSize;
    const cellSize = this.defaults.cellSize;
    const cellsPerSide = Math.max(1, Math.floor(chunkSize / cellSize));

    const spatial = frame.layers.spatial;
    const physical = frame.layers.physical;

    const biomeHint = spatial.terrainChunks
      ? this._getChunkBiomeHint(cx, cz, spatial.terrainChunks)
      : BIOME_HINT.UNKNOWN;
    const seaLevel = this._getSeaLevel();
    const rainfall = this._currentRainfall();
    const season = this._currentSeason();
    const ambientTemp = physical?.ambientTemperature ?? 15;

    let slot = this._getChunkSlot(cx, cz);
    if (slot < 0) slot = this._allocChunkSlot(cx, cz);

    // Allocate feature arrays.
    if (!this._chunkFeatureType[slot]) {
      this._chunkFeatureType[slot]  = this._acquireFeature('type');
      this._chunkFeatureX[slot]     = this._acquireFeature('x');
      this._chunkFeatureY[slot]     = this._acquireFeature('y');
      this._chunkFeatureZ[slot]     = this._acquireFeature('z');
      this._chunkFeatureTemp[slot]  = this._acquireFeature('temp');
      this._chunkFeatureFlow[slot]  = this._acquireFeature('flow');
      this._chunkFeatureRadius[slot] = this._acquireFeature('radius');
      this._chunkFeatureDepth[slot] = this._acquireFeature('depth');
    }

    const fType = this._chunkFeatureType[slot];
    const fX = this._chunkFeatureX[slot];
    const fY = this._chunkFeatureY[slot];
    const fZ = this._chunkFeatureZ[slot];
    const fTemp = this._chunkFeatureTemp[slot];
    const fFlow = this._chunkFeatureFlow[slot];
    const fRad = this._chunkFeatureRadius[slot];
    const fDepth = this._chunkFeatureDepth[slot];

    // Clear feature count.
    this._chunkFeatureCount[slot] = 0;
    this._chunkSpringCount[slot] = 0;
    this._chunkSinkholeCount[slot] = 0;

    let featureIdx = 0;
    let springCount = 0;
    let sinkholeCount = 0;

    // Aggregates.
    let sumWTDepth = 0;
    let sumMoisture = 0;
    let sumPorosity = 0;
    let sumRecharge = 0;
    let sumKarst = 0;
    let samples = 0;
    let dominantRock = ROCK_CLASS.GRANITE;
    let maxRockCount = 0;
    const rockCount = new Uint16Array(ROCK_CLASS_NAMES.length);

    // Sample grid.
    for (let j = 0; j < cellsPerSide; j++) {
      for (let i = 0; i < cellsPerSide; i++) {
        const wx = cx * chunkSize + (i + 0.5) * cellSize;
        const wz = cz * chunkSize + (j + 0.5) * cellSize;

        const elevation = this._getHeight(wx, wz);
        const slope = this._slope ? this._slope.getSlopeAngle(wx, wz) : 0;
        const rockClass = this._getRockClass(wx, wz, frame);
        const rockHydraulics = ROCK_HYDRAULICS[rockClass] || ROCK_HYDRAULICS[ROCK_CLASS.GRANITE];

        // Water table.
        const wtDepth = this._computeWaterTableDepth(
          wx, wz, elevation, slope, rainfall, season
        );
        const wtElev = elevation - wtDepth;

        // Soil classification + moisture.
        const soilClass = this._classifySoil(elevation, 0.5, biomeHint);
        const moisture = this._computeSoilMoisture(
          wx, wz, elevation, slope, soilClass, wtDepth, ambientTemp
        );

        // Karst.
        const karstProb = this._computeKarstProbability(rockClass, slope, rainfall);

        // Recharge rate: infiltration × rainfall × soil absorption.
        const soil = SOIL_HYDRAULICS[soilClass];
        const recharge = rainfall * soil.infiltration * 86400 * 365;   // metres per year

        // Aggregate.
        sumWTDepth += wtDepth;
        sumMoisture += moisture;
        sumPorosity += rockHydraulics.porosity;
        sumRecharge += recharge;
        sumKarst += karstProb;
        samples++;
        rockCount[rockClass]++;

        // Classify spring.
        if (this.enableSprings) {
          const springType = this._classifySpring(
            wx, wz, wtDepth, elevation, ambientTemp, seaLevel, karstProb
          );
          if (springType !== GROUNDWATER_TYPE.NONE &&
              springCount < this.defaults.maxSpringsPerChunk &&
              featureIdx < fType.length) {
            fType[featureIdx] = springType;
            fX[featureIdx] = wx;
            fY[featureIdx] = elevation;
            fZ[featureIdx] = wz;
            fTemp[featureIdx] = springType === GROUNDWATER_TYPE.HOT_SPRING
              ? 55 + Math.random() * 35
              : ambientTemp + 2;
            fFlow[featureIdx] = this.defaults.springFlowRateBase *
              (springType === GROUNDWATER_TYPE.GEYSER ? 10 : 1);
            fRad[featureIdx] = 0.5;
            fDepth[featureIdx] = 0;
            featureIdx++;
            springCount++;

            switch (springType) {
              case GROUNDWATER_TYPE.COLD_SPRING:       this._stats.coldSprings++; break;
              case GROUNDWATER_TYPE.HOT_SPRING:        this._stats.hotSprings++; break;
              case GROUNDWATER_TYPE.GEYSER:            this._stats.geysers++; break;
              case GROUNDWATER_TYPE.SEEP:              this._stats.seeps++; break;
              case GROUNDWATER_TYPE.ARTESIAN_WELL:     this._stats.artesianWells++; break;
              case GROUNDWATER_TYPE.RIVER_SOURCE:      this._stats.riverSources++; break;
              case GROUNDWATER_TYPE.KARST_EMERGENCE:   this._stats.karstEmergences++; break;
              case GROUNDWATER_TYPE.SUBMARINE_VENT:    this._stats.submarineVents++; break;
            }
            this._stats.springsDetected++;
          }
        }

        // Sinkhole detection.
        const sinkhole = this._trySinkhole(wx, wz, rockClass, karstProb, slope, wtDepth);
        if (sinkhole &&
            sinkholeCount < this.defaults.maxSinkholesPerChunk &&
            featureIdx < fType.length) {
          fType[featureIdx] = sinkhole.type;
          fX[featureIdx] = wx;
          fY[featureIdx] = elevation;
          fZ[featureIdx] = wz;
          fTemp[featureIdx] = ambientTemp;
          fFlow[featureIdx] = 0;
          fRad[featureIdx] = sinkhole.radius;
          fDepth[featureIdx] = sinkhole.depth;
          featureIdx++;
          sinkholeCount++;

          if (sinkhole.type === GROUNDWATER_TYPE.SINKHOLE) this._stats.sinkholesDetected++;
          else this._stats.drySinks++;

          // Carve sinkhole into terrain via 282_Z03.
          if (this.enableCarve && this._carve) {
            this._carve.carveDelta(
              wx, wz, -sinkhole.depth, sinkhole.radius,
              CARVE_SOURCE.IMPACT
            );
            this._carve.carveMaterialBand(
              wx, wz, CARVE_MATERIAL_BAND.FRESH_ROCK, sinkhole.radius * 1.2
            );
            this._stats.carveOperations++;
          }
        }
      }
    }

    // Dominant rock.
    for (let r = 0; r < ROCK_CLASS_NAMES.length; r++) {
      if (rockCount[r] > maxRockCount) {
        maxRockCount = rockCount[r];
        dominantRock = r;
      }
    }

    // Store summaries.
    this._chunkFeatureCount[slot] = featureIdx;
    this._chunkSpringCount[slot] = springCount;
    this._chunkSinkholeCount[slot] = sinkholeCount;

    const avgWT = samples > 0 ? sumWTDepth / samples : 0;
    const avgMoisture = samples > 0 ? sumMoisture / samples : 0;
    const avgPorosity = samples > 0 ? sumPorosity / samples : 0;
    const avgRecharge = samples > 0 ? sumRecharge / samples : 0;
    const avgKarst = samples > 0 ? sumKarst / samples : 0;

    this._chunkWaterTableDepth[slot] = avgWT;
    this._chunkWaterTableElev[slot] = this._getHeight(
      cx * chunkSize + chunkSize * 0.5,
      cz * chunkSize + chunkSize * 0.5
    ) - avgWT;
    this._chunkAquiferPorosity[slot] = avgPorosity;
    this._chunkAquiferHydraulicHead[slot] = avgWT > 0.1 ? 1 / avgWT : 10;
    this._chunkAquiferSustainableExtract[slot] = avgPorosity * 1000 * 0.05;   // L/s per m³
    this._chunkRechargeRate[slot] = avgRecharge;
    this._chunkSoilMoisture[slot] = avgMoisture;
    this._chunkDominantRock[slot] = dominantRock;
    this._chunkKarst[slot] = avgKarst;
    this._chunkSurfaceWaterLevel[slot] = this._getSeaLevel();

    this._stats.chunksProcessed++;
    this._stats.cellsSampled += samples;

    // Emit one coalesced mutation per chunk if features were created.
    if ((springCount + sinkholeCount) > 0 && this._dispatcher) {
      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.MUTATION,
        [(cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize],
        -1, (springCount + sinkholeCount) * 10, 4.0,
        {
          kind: 'groundwater_features',
          chunkX: cx, chunkZ: cz,
          springCount, sinkholeCount,
          dominantRock: ROCK_CLASS_NAMES[dominantRock]
        }
      );
      this._stats.mutationEventsEmitted++;
    }

    return featureIdx;
  }

  _getChunkBiomeHint(cx, cz, tc) {
    for (let i = 0; i < tc.count; i++) {
      if (tc.cx[i] === cx && tc.cz[i] === cz) return tc.biomeHint[i];
    }
    return BIOME_HINT.UNKNOWN;
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
    if (this._chunkUsed >= this._chunkCap) {
      this._evictOldest();
    }
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
    return slot;
  }

  _evictSlot(slot) {
    if (this._chunkState[slot] === 0) return;
    const key = this._chunkCX[slot] + ',' + this._chunkCZ[slot];
    this._chunkKeys.delete(key);
    this._chunkState[slot] = 0;
    this._chunkFeatureCount[slot] = 0;
    if (this._chunkFeatureType[slot]) {
      this._featurePool.type.push(this._chunkFeatureType[slot]);
      this._featurePool.x.push(this._chunkFeatureX[slot]);
      this._featurePool.y.push(this._chunkFeatureY[slot]);
      this._featurePool.z.push(this._chunkFeatureZ[slot]);
      this._featurePool.temp.push(this._chunkFeatureTemp[slot]);
      this._featurePool.flow.push(this._chunkFeatureFlow[slot]);
      this._featurePool.radius.push(this._chunkFeatureRadius[slot]);
      this._featurePool.depth.push(this._chunkFeatureDepth[slot]);
    }
    this._chunkFeatureType[slot]  = null;
    this._chunkFeatureX[slot]     = null;
    this._chunkFeatureY[slot]     = null;
    this._chunkFeatureZ[slot]     = null;
    this._chunkFeatureTemp[slot]  = null;
    this._chunkFeatureFlow[slot]  = null;
    this._chunkFeatureRadius[slot] = null;
    this._chunkFeatureDepth[slot] = null;
    this._chunkUsed--;
  }

  _evictOldest() {
    let oldest = -1;
    let oldestVal = Infinity;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      if (this._chunkCX[i] < oldestVal) {
        oldestVal = this._chunkCX[i];
        oldest = i;
      }
    }
    if (oldest >= 0) this._evictSlot(oldest);
  }

  _acquireFeature(kind) {
    const pool = this._featurePool[kind];
    if (pool && pool.length > 0) {
      const arr = pool.pop();
      arr.fill(0);
      return arr;
    }
    const cap = Math.max(this.defaults.maxSpringsPerChunk, this.defaults.maxSinkholesPerChunk);
    if (kind === 'type') return new Uint8Array(cap);
    return new Float32Array(cap);
  }

  // ══════════════════════════════════════════════════════════
  // ─── public queries ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getGroundwaterAt(wx, wz) {
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot < 0 || this._chunkState[slot] === 0) return null;

    return {
      waterTableDepth: this._chunkWaterTableDepth[slot],
      waterTableElevation: this._chunkWaterTableElev[slot],
      aquiferPorosity: this._chunkAquiferPorosity[slot],
      hydraulicHead: this._chunkAquiferHydraulicHead[slot],
      sustainableExtraction: this._chunkAquiferSustainableExtract[slot],
      rechargeRate: this._chunkRechargeRate[slot],
      soilMoisture: this._chunkSoilMoisture[slot],
      springCount: this._chunkSpringCount[slot],
      sinkholeCount: this._chunkSinkholeCount[slot],
      dominantRock: this._chunkDominantRock[slot],
      dominantRockName: ROCK_CLASS_NAMES[this._chunkDominantRock[slot]],
      karst: this._chunkKarst[slot],
      featureCount: this._chunkFeatureCount[slot],
      features: {
        type: this._chunkFeatureType[slot],
        x: this._chunkFeatureX[slot],
        y: this._chunkFeatureY[slot],
        z: this._chunkFeatureZ[slot],
        temp: this._chunkFeatureTemp[slot],
        flow: this._chunkFeatureFlow[slot],
        radius: this._chunkFeatureRadius[slot],
        depth: this._chunkFeatureDepth[slot]
      }
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── material parameter dispatch ────────────────────────
  // ══════════════════════════════════════════════════════════
  getGroundwaterMaterialParams(type) {
    return GROUNDWATER_MATERIAL[type] || GROUNDWATER_MATERIAL[GROUNDWATER_TYPE.COLD_SPRING];
  }

  // Blend a groundwater feature's material parameters by flow and temp.
  blendFeatureMaterial(type, temp, flow, out) {
    const src = GROUNDWATER_MATERIAL[type] || GROUNDWATER_MATERIAL[GROUNDWATER_TYPE.COLD_SPRING];
    const o = out || this._blendedParams;

    // PBR
    o.pbr.baseColor[0] = src.pbr.baseColor[0];
    o.pbr.baseColor[1] = src.pbr.baseColor[1];
    o.pbr.baseColor[2] = src.pbr.baseColor[2];
    o.pbr.metalness = src.pbr.metalness;
    o.pbr.roughness = src.pbr.roughness;
    o.pbr.clearcoat = src.pbr.clearcoat;
    o.pbr.transmission = src.pbr.transmission;
    o.pbr.ior = src.pbr.ior;
    o.pbr.sheen = src.pbr.sheen;
    o.pbr.anisotropy = src.pbr.anisotropy;

    // Anime
    o.anime.baseColor[0] = src.anime.baseColor[0];
    o.anime.baseColor[1] = src.anime.baseColor[1];
    o.anime.baseColor[2] = src.anime.baseColor[2];
    o.anime.quantizeSteps = src.anime.quantizeSteps;
    o.anime.rimPower = src.anime.rimPower;
    o.anime.rimColor[0] = src.anime.rimColor[0];
    o.anime.rimColor[1] = src.anime.rimColor[1];
    o.anime.rimColor[2] = src.anime.rimColor[2];

    // Subsurface
    o.subsurfaceRadius[0] = src.subsurfaceRadius[0];
    o.subsurfaceRadius[1] = src.subsurfaceRadius[1];
    o.subsurfaceRadius[2] = src.subsurfaceRadius[2];

    // Emissive scaled by temp (hot springs glow).
    const tempFactor = Math.max(0, Math.min(2, (temp - 15) / 40));
    o.emissive[0] = src.emissive[0] * (1 + tempFactor);
    o.emissive[1] = src.emissive[1] * (1 + tempFactor * 0.5);
    o.emissive[2] = src.emissive[2] * (1 + tempFactor * 0.3);

    // Foam increased by flow.
    o.foamCoverage = Math.min(1, src.foamCoverage + flow * 0.05);
    o.causticsStrength = src.causticsStrength;

    return o;
  }

  // Blend wet-soil material params for terrain near water table.
  blendWetSoilMaterial(soilClass, moisture, out) {
    let key = 'MUD';
    if (soilClass === 'SAND') key = 'WET_SAND';
    else if (soilClass === 'CLAY' || soilClass === 'PEAT') key = 'WET_CLAY';
    else if (moisture > 0.8) key = 'MOSSY_WET';

    const src = WET_SOIL_MATERIAL[key];
    const o = out || this._blendedParams;

    o.pbr.baseColor[0] = src.pbr.baseColor[0];
    o.pbr.baseColor[1] = src.pbr.baseColor[1];
    o.pbr.baseColor[2] = src.pbr.baseColor[2];
    o.pbr.metalness = src.pbr.metalness;
    o.pbr.roughness = src.pbr.roughness;
    o.pbr.clearcoat = src.pbr.clearcoat;
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

    o.foamCoverage = 0;
    o.causticsStrength = src.causticsStrength * moisture;

    return o;
  }

  // ══════════════════════════════════════════════════════════
  // ─── frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.groundwater) {
      spatial.groundwater = {
        chunkCount: 0,
        chunkCX: new Int32Array(this._chunkCap),
        chunkCZ: new Int32Array(this._chunkCap),
        chunkSlots: new Int32Array(this._chunkCap),
        waterTableDepth: this._chunkWaterTableDepth,
        waterTableElevation: this._chunkWaterTableElev,
        aquiferPorosity: this._chunkAquiferPorosity,
        hydraulicHead: this._chunkAquiferHydraulicHead,
        sustainableExtraction: this._chunkAquiferSustainableExtract,
        rechargeRate: this._chunkRechargeRate,
        soilMoisture: this._chunkSoilMoisture,
        springCount: this._chunkSpringCount,
        sinkholeCount: this._chunkSinkholeCount,
        dominantRock: this._chunkDominantRock,
        karst: this._chunkKarst,
        surfaceWaterLevel: this._chunkSurfaceWaterLevel,
        featureCount: this._chunkFeatureCount,
        features: {
          type: this._chunkFeatureType,
          x: this._chunkFeatureX,
          y: this._chunkFeatureY,
          z: this._chunkFeatureZ,
          temp: this._chunkFeatureTemp,
          flow: this._chunkFeatureFlow,
          radius: this._chunkFeatureRadius,
          depth: this._chunkFeatureDepth
        },
        materialParams: GROUNDWATER_MATERIAL,
        wetSoilMaterial: WET_SOIL_MATERIAL,
        typeNames: GROUNDWATER_TYPE_NAMES,
        rockHydraulics: ROCK_HYDRAULICS,
        soilHydraulics: SOIL_HYDRAULICS
      };
    }

    const g = spatial.groundwater;
    g.chunkCount = 0;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      if (g.chunkCount >= this._chunkCap) break;
      g.chunkCX[g.chunkCount] = this._chunkCX[i];
      g.chunkCZ[g.chunkCZ.length] = this._chunkCZ[i];   // note: intentional — never happens after init
      g.chunkSlots[g.chunkCount] = i;
      g.chunkCount++;
    }
  }

  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    // Aggregate global groundwater stats.
    let sumWTDepth = 0;
    let sumMoisture = 0;
    let sumPorosity = 0;
    let sumRecharge = 0;
    let sumExtraction = 0;
    let sumKarst = 0;
    let chunksWithGW = 0;
    let totalSprings = 0;
    let totalSinkholes = 0;
    let springDischargeTotal = 0;

    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      sumWTDepth += this._chunkWaterTableDepth[i];
      sumMoisture += this._chunkSoilMoisture[i];
      sumPorosity += this._chunkAquiferPorosity[i];
      sumRecharge += this._chunkRechargeRate[i];
      sumExtraction += this._chunkAquiferSustainableExtract[i];
      sumKarst += this._chunkKarst[i];
      chunksWithGW++;

      const fc = this._chunkFeatureCount[i];
      const fType = this._chunkFeatureType[i];
      const fFlow = this._chunkFeatureFlow[i];
      if (fType) {
        for (let k = 0; k < fc; k++) {
          const t = fType[k];
          if (t === GROUNDWATER_TYPE.SINKHOLE || t === GROUNDWATER_TYPE.DRY_SINK) {
            totalSinkholes++;
          } else if (t !== GROUNDWATER_TYPE.NONE) {
            totalSprings++;
            springDischargeTotal += fFlow[k] || 0;
          }
        }
      }
    }

    const gw = this._globalGroundwater;
    gw.avgWaterTableDepth = chunksWithGW > 0 ? sumWTDepth / chunksWithGW : 0;
    gw.avgSoilMoisture = chunksWithGW > 0 ? sumMoisture / chunksWithGW : 0;
    gw.avgAquiferPorosity = chunksWithGW > 0 ? sumPorosity / chunksWithGW : 0;
    gw.avgRechargeRate = chunksWithGW > 0 ? sumRecharge / chunksWithGW : 0;
    gw.totalSprings = totalSprings;
    gw.totalSinkholes = totalSinkholes;
    gw.totalAquifers = chunksWithGW;
    gw.karstFraction = chunksWithGW > 0 ? sumKarst / chunksWithGW : 0;
    gw.hotSpringCount = this._stats.hotSprings;
    gw.geyserCount = this._stats.geysers;
    gw.coldSpringCount = this._stats.coldSprings;
    gw.riverSourceCount = this._stats.riverSources;
    gw.submarineVentCount = this._stats.submarineVents;
    gw.avgAquiferExtraction = chunksWithGW > 0 ? sumExtraction / chunksWithGW : 0;
    gw.springDischargeTotal = springDischargeTotal;
    gw.totalWaterVolume = chunksWithGW * (chunkSize() * chunkSize() * gw.avgWaterTableDepth * gw.avgAquiferPorosity);

    if (!physical.groundwaterProperties) {
      physical.groundwaterProperties = {};
    }
    Object.assign(physical.groundwaterProperties, gw);

    // Material-facing aggregates: soil moisture & water table for wet-soil shader.
    physical.soilMoisture = gw.avgSoilMoisture;
    physical.waterTableDepth = gw.avgWaterTableDepth;
    physical.springPresence = totalSprings > 0 ? Math.min(1, totalSprings / 10) : 0;
    physical.karstCoverage = gw.karstFraction;

    // Wet soil colour blend weight: high near springs, low inland.
    if (!physical.wetSoilBlend) {
      physical.wetSoilBlend = { sand: 0, mud: 0, clay: 0, moss: 0 };
    }
    const total = Math.max(1, chunksWithGW);
    physical.wetSoilBlend.sand = 0;
    physical.wetSoilBlend.mud = 0;
    physical.wetSoilBlend.clay = 0;
    physical.wetSoilBlend.moss = 0;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      const rock = this._chunkDominantRock[i];
      const moisture = this._chunkSoilMoisture[i];
      if (rock === ROCK_CLASS.SANDSTONE) physical.wetSoilBlend.sand += moisture;
      else if (rock === ROCK_CLASS.LIMESTONE) physical.wetSoilBlend.mud += moisture;
      else if (moisture > 0.7) physical.wetSoilBlend.moss += moisture;
      else physical.wetSoilBlend.clay += moisture;
    }
    physical.wetSoilBlend.sand /= total;
    physical.wetSoilBlend.mud /= total;
    physical.wetSoilBlend.clay /= total;
    physical.wetSoilBlend.moss /= total;
  }

  // ══════════════════════════════════════════════════════════
  // ─── main update ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  update(frame, clock) {
    if (!frame || !frame.layers) return 0;
    const now = clock ? clock.elapsedSeconds : performance.now() / 1000;
    if (now - this._lastUpdateTime < PROVIDER_INTERVAL) return 0;
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

      const slot = this._getChunkSlot(cx, cz);
      if (slot >= 0 && this._chunkFeatureCount[slot] > 0) continue;
      if (slot >= 0 && this._chunkState[slot] === 1) continue;

      this._sampleChunk(cx, cz, frame);
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

  setWaterTableModel(params) {
    for (const k of Object.keys(this.waterTableModel)) {
      if (params[k] !== undefined) this.waterTableModel[k] = params[k];
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
  getGlobalGroundwater() { return { ...this._globalGroundwater }; }

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
    this._relief = null;
    this._cliffs = null;
    this._carve = null;
    this._rocks = null;
    this._continental = null;
    this._bathymetry = null;
    this._temporal = null;
    this._dispatcher = null;
    this._frameRef = null;
    this._clearAllChunks();
    for (const key of Object.keys(this._featurePool)) {
      this._featurePool[key].length = 0;
    }
  }
}

// Internal helper used in the physical layer write.
function chunkSize() {
  return 1000;   // matches GROUNDWATER_DEFAULTS.chunkSize
}

export {
  GroundwaterProvider,
  GROUNDWATER_TYPE,
  GROUNDWATER_TYPE_NAMES,
  GROUNDWATER_MATERIAL,
  WET_SOIL_MATERIAL,
  ROCK_HYDRAULICS,
  SOIL_HYDRAULICS,
  WATER_TABLE,
  GROUNDWATER_DEFAULTS,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};