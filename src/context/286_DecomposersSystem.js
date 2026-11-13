// file number : 286
// full path name : src/context/286_DecomposersSystem.js
// description : Decomposer and nutrient-cycling system for the living world. Tracks dead biomass — fallen leaves from 282_Z07_ForestGradientProvider, dried grass from 282_Z08_GrassAndFlowresGradientProvider, animal carcasses from 279_Z03–Z05, and the organic debris from 282_Z03_CarveGradientProvider's biotic sources — and processes it through eight decomposer archetypes: FUNGI_MUSHROOM, FUNGI_MOLD, FUNGI_MYCORRHIZAL, BACTERIA_AEROBIC, BACTERIA_ANAEROBIC, DETRITIVORE_WORM, DETRITIVORE_BEETLE, and DETRITIVORE_ISOPOD. Each archetype follows a species-specific decomposition rate law: k(T) = A·exp(−Ea/(R·T)) with activation energy Ea, scaled by a moisture-factor curve μ(m) that peaks at field capacity (from 284_GroundwaterProvider's soil moisture), and by a litter-quality factor Q that depends on the litter's C:N ratio. The system tracks per-chunk litter mass (kg/m²), decomposition progress per archetype, and cumulative nutrient release of N (nitrogen), P (phosphorus), K (potassium), plus organic carbon and humus. Every decomposer has a distinct material parameter set for the PBR/anime shader — fungal caps with subsurface scattering and bioluminescent emissive terms (with live intensity driven by decomposition rate), bacterial mats with emissive glow, worm casts with wet-soil sheen. Bioluminescent fungi (Mycena, Panellus) emit light sources that feed the clustered-lighting pipeline through frame.layers.physical.decomposerLights. Emits a single coalesced MUTATION causal event when a chunk's cumulative nutrient release crosses a threshold, so the persistence layer records the fertility improvement but not every microbe. Writes per-chunk summaries and per-fruiting-body descriptors into frame.layers.spatial.decomposers, plus global aggregates (total nutrient pool, fungal biomass, decomposition rate, CO₂ release) into frame.layers.physical.decomposerProperties. All scratch objects are pooled; no allocation after the first frame.
// best for : Every consumer that needs nutrient state — SoilFertilityProvider (291) for reading released nutrients, SoilCompositionProvider (290) for organic-matter fraction, MoistureLevelProvider (285) for moisture feedback, LandscapeVegetationScatterSystem (346) for placing plants on fertile ground, LandscapeFaunaSpawnSystem (347) for attracting detritivores and their predators, the material system for fungal bioluminescence and decay surfaces, and the lighting system for bioluminescent light sources. Complements 282_Z07 (forest) and 282_Z08 (grass) by closing the nutrient cycle — everything that grows must eventually decompose.
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
  SlopeGradientProvider, SLOPE_BAND,
  ReliefGradientProvider, RELIEF_CLASS,
  CliffsGradientProvider, CLIFF_CLASS,
  CarveGradientProvider, CARVE_SOURCE, CARVE_MATERIAL_BAND,
  RockGradientProvider, ROCK_TYPE, ROCK_CLASS,
  ForestGradientProvider, TREE_TYPE, SUCCESSION,
  GrassAndFlowresGradientProvider, GRASS_TYPE,
  ContinentalReliefGradientProvider, CONTINENTAL_TYPE,
  BathymetryProvider, BATHY_ZONE, SEABED_CLASS,
  GroundwaterProvider, GROUNDWATER_TYPE,
  MoistureLevelProvider, MOISTURE_STATE,
  ColorManagement, ColorSpace,
  Ray, Plane, Sphere,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial
} from './264_MathECSImportBarrel.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 0.5;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── decomposer archetypes ──────────────────────────────────────
const DECOMPOSER_TYPE = Object.freeze({
  NONE:                 0,
  FUNGI_MUSHROOM:       1,   // visible fruiting body, e.g. agaric
  FUNGI_MOLD:           2,   // invisible microfungi (mold)
  FUNGI_MYCORRHIZAL:    3,   // symbiotic root fungi
  BACTERIA_AEROBIC:     4,   // oxygen-using bacteria
  BACTERIA_ANAEROBIC:   5,   // methane-producing anaerobes
  DETRITIVORE_WORM:     6,   // earthworm
  DETRITIVORE_BEETLE:   7,   // carrion beetle / dung beetle
  DETRITIVORE_ISOPOD:   8,   // woodlouse / pill bug
  BIOLUMINESCENT:       9    // Mycena / Panellus (glowing fungi)
});

const DECOMPOSER_TYPE_NAMES = Object.freeze([
  'none', 'fungi_mushroom', 'fungi_mold', 'fungi_mycorrhizal',
  'bacteria_aerobic', 'bacteria_anaerobic',
  'detritivore_worm', 'detritivore_beetle', 'detritivore_isopod',
  'bioluminescent'
]);

// ─── per-archetype decomposition parameters ────────────────────
// activationEnergy in J/mol; preExponential A in 1/day;
// moistureOptimal in 0..1 (from soil moisture);
// litterType preference (0 = leaf, 1 = wood, 2 = carcass, 3 = dung, 4 = mixed);
// carbonUseEfficiency = fraction of consumed carbon retained in the decomposer's biomass.
const DECOMPOSER_SCHEMA = Object.freeze({
  [DECOMPOSER_TYPE.FUNGI_MUSHROOM]: {
    activationEnergy: 55_000,
    preExponentialA: 1.8e6,
    moistureOptimal: 0.65,
    moistureWidth: 0.30,
    litterTypes: [0, 1, 4],
    carbonUseEfficiency: 0.30,
    nitrogenRelease: 0.55,
    phosphorusRelease: 0.35,
    potassiumRelease: 0.45,
    bioluminescence: 0.0,
    visibleFruiting: 1
  },
  [DECOMPOSER_TYPE.FUNGI_MOLD]: {
    activationEnergy: 40_000,
    preExponentialA: 5.0e8,
    moistureOptimal: 0.80,
    moistureWidth: 0.35,
    litterTypes: [0, 4],
    carbonUseEfficiency: 0.15,
    nitrogenRelease: 0.40,
    phosphorusRelease: 0.25,
    potassiumRelease: 0.30,
    bioluminescence: 0.0,
    visibleFruiting: 0
  },
  [DECOMPOSER_TYPE.FUNGI_MYCORRHIZAL]: {
    activationEnergy: 45_000,
    preExponentialA: 2.0e7,
    moistureOptimal: 0.55,
    moistureWidth: 0.25,
    litterTypes: [0, 1, 4],
    carbonUseEfficiency: 0.55,   // hosts share carbon with plant
    nitrogenRelease: 0.70,
    phosphorusRelease: 0.60,
    potassiumRelease: 0.40,
    bioluminescence: 0.0,
    visibleFruiting: 0
  },
  [DECOMPOSER_TYPE.BACTERIA_AEROBIC]: {
    activationEnergy: 60_000,
    preExponentialA: 1.0e9,
    moistureOptimal: 0.50,
    moistureWidth: 0.30,
    litterTypes: [0, 2, 3, 4],
    carbonUseEfficiency: 0.10,
    nitrogenRelease: 0.60,
    phosphorusRelease: 0.45,
    potassiumRelease: 0.55,
    bioluminescence: 0.0,
    visibleFruiting: 0
  },
  [DECOMPOSER_TYPE.BACTERIA_ANAEROBIC]: {
    activationEnergy: 30_000,
    preExponentialA: 1.0e6,
    moistureOptimal: 0.95,        // prefers waterlogged
    moistureWidth: 0.20,
    litterTypes: [0, 2, 3, 4],
    carbonUseEfficiency: 0.05,    // mostly methane
    nitrogenRelease: 0.20,        // nitrogen lost as N₂ / NH₃
    phosphorusRelease: 0.15,
    potassiumRelease: 0.20,
    bioluminescence: 0.0,
    visibleFruiting: 0
  },
  [DECOMPOSER_TYPE.DETRITIVORE_WORM]: {
    activationEnergy: 50_000,
    preExponentialA: 5.0e5,
    moistureOptimal: 0.60,
    moistureWidth: 0.30,
    litterTypes: [0, 4],
    carbonUseEfficiency: 0.25,
    nitrogenRelease: 0.50,
    phosphorusRelease: 0.40,
    potassiumRelease: 0.45,
    bioluminescence: 0.0,
    visibleFruiting: 0
  },
  [DECOMPOSER_TYPE.DETRITIVORE_BEETLE]: {
    activationEnergy: 52_000,
    preExponentialA: 8.0e5,
    moistureOptimal: 0.55,
    moistureWidth: 0.30,
    litterTypes: [2, 3, 4],
    carbonUseEfficiency: 0.20,
    nitrogenRelease: 0.55,
    phosphorusRelease: 0.40,
    potassiumRelease: 0.45,
    bioluminescence: 0.0,
    visibleFruiting: 0
  },
  [DECOMPOSER_TYPE.DETRITIVORE_ISOPOD]: {
    activationEnergy: 48_000,
    preExponentialA: 3.0e5,
    moistureOptimal: 0.65,
    moistureWidth: 0.30,
    litterTypes: [0, 1, 4],
    carbonUseEfficiency: 0.22,
    nitrogenRelease: 0.45,
    phosphorusRelease: 0.35,
    potassiumRelease: 0.40,
    bioluminescence: 0.0,
    visibleFruiting: 0
  },
  [DECOMPOSER_TYPE.BIOLUMINESCENT]: {
    activationEnergy: 55_000,
    preExponentialA: 1.5e6,
    moistureOptimal: 0.75,
    moistureWidth: 0.30,
    litterTypes: [0, 1, 4],
    carbonUseEfficiency: 0.28,
    nitrogenRelease: 0.50,
    phosphorusRelease: 0.30,
    potassiumRelease: 0.40,
    bioluminescence: 1.0,          // emits light
    visibleFruiting: 1
  }
});

// ─── material parameter sets per decomposer type ──────────────
// Full PBR + anime parameter struct the material shader reads.
const DECOMPOSER_MATERIAL = Object.freeze({
  [DECOMPOSER_TYPE.FUNGI_MUSHROOM]: {
    pbr: {
      baseColor:    [0.62, 0.50, 0.40],
      metalness:    0.00,
      roughness:    0.65,
      clearcoat:    0.20,
      transmission: 0.10,
      ior:          1.40,
      sheen:        0.35,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.66, 0.54, 0.44],
      quantizeSteps: 3,
      rimPower:     1.7,
      rimColor:     [0.85, 0.75, 0.65]
    },
    subsurfaceRadius: [0.05, 0.04, 0.03],
    emissive:         [0.00, 0.00, 0.00]
  },
  [DECOMPOSER_TYPE.FUNGI_MOLD]: {
    pbr: {
      baseColor:    [0.48, 0.42, 0.35],
      metalness:    0.00,
      roughness:    0.80,
      clearcoat:    0.10,
      transmission: 0.00,
      ior:          1.40,
      sheen:        0.20,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.52, 0.46, 0.38],
      quantizeSteps: 3,
      rimPower:     1.9,
      rimColor:     [0.60, 0.55, 0.45]
    },
    subsurfaceRadius: [0.02, 0.02, 0.01],
    emissive:         [0.00, 0.00, 0.00]
  },
  [DECOMPOSER_TYPE.FUNGI_MYCORRHIZAL]: {
    pbr: {
      baseColor:    [0.45, 0.38, 0.30],
      metalness:    0.00,
      roughness:    0.70,
      clearcoat:    0.15,
      transmission: 0.05,
      ior:          1.38,
      sheen:        0.30,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.48, 0.40, 0.32],
      quantizeSteps: 3,
      rimPower:     1.8,
      rimColor:     [0.60, 0.55, 0.42]
    },
    subsurfaceRadius: [0.03, 0.03, 0.02],
    emissive:         [0.00, 0.00, 0.00]
  },
  [DECOMPOSER_TYPE.BACTERIA_AEROBIC]: {
    pbr: {
      baseColor:    [0.35, 0.40, 0.32],
      metalness:    0.00,
      roughness:    0.75,
      clearcoat:    0.25,
      transmission: 0.00,
      ior:          1.40,
      sheen:        0.15,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.38, 0.44, 0.35],
      quantizeSteps: 3,
      rimPower:     1.9,
      rimColor:     [0.55, 0.65, 0.45]
    },
    subsurfaceRadius: [0.02, 0.02, 0.01],
    emissive:         [0.00, 0.00, 0.00]
  },
  [DECOMPOSER_TYPE.BACTERIA_ANAEROBIC]: {
    pbr: {
      baseColor:    [0.28, 0.30, 0.25],
      metalness:    0.00,
      roughness:    0.85,
      clearcoat:    0.10,
      transmission: 0.00,
      ior:          1.40,
      sheen:        0.10,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.30, 0.32, 0.27],
      quantizeSteps: 3,
      rimPower:     2.1,
      rimColor:     [0.40, 0.50, 0.40]
    },
    subsurfaceRadius: [0.02, 0.02, 0.01],
    emissive:         [0.00, 0.00, 0.00]
  },
  [DECOMPOSER_TYPE.DETRITIVORE_WORM]: {
    pbr: {
      baseColor:    [0.55, 0.38, 0.32],
      metalness:    0.00,
      roughness:    0.55,
      clearcoat:    0.40,
      transmission: 0.00,
      ior:          1.42,
      sheen:        0.25,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.58, 0.40, 0.34],
      quantizeSteps: 3,
      rimPower:     1.6,
      rimColor:     [0.75, 0.55, 0.48]
    },
    subsurfaceRadius: [0.04, 0.03, 0.02],
    emissive:         [0.00, 0.00, 0.00]
  },
  [DECOMPOSER_TYPE.DETRITIVORE_BEETLE]: {
    pbr: {
      baseColor:    [0.25, 0.22, 0.20],
      metalness:    0.35,
      roughness:    0.40,
      clearcoat:    0.60,
      transmission: 0.00,
      ior:          1.50,
      sheen:        0.10,
      anisotropy:   0.10
    },
    anime: {
      baseColor:    [0.28, 0.25, 0.22],
      quantizeSteps: 3,
      rimPower:     1.5,
      rimColor:     [0.55, 0.50, 0.45]
    },
    subsurfaceRadius: [0.00, 0.00, 0.00],
    emissive:         [0.00, 0.00, 0.00]
  },
  [DECOMPOSER_TYPE.DETRITIVORE_ISOPOD]: {
    pbr: {
      baseColor:    [0.48, 0.42, 0.35],
      metalness:    0.10,
      roughness:    0.60,
      clearcoat:    0.40,
      transmission: 0.00,
      ior:          1.45,
      sheen:        0.15,
      anisotropy:   0.05
    },
    anime: {
      baseColor:    [0.52, 0.46, 0.38],
      quantizeSteps: 3,
      rimPower:     1.7,
      rimColor:     [0.70, 0.62, 0.50]
    },
    subsurfaceRadius: [0.02, 0.02, 0.01],
    emissive:         [0.00, 0.00, 0.00]
  },
  [DECOMPOSER_TYPE.BIOLUMINESCENT]: {
    pbr: {
      baseColor:    [0.30, 0.55, 0.45],
      metalness:    0.00,
      roughness:    0.45,
      clearcoat:    0.30,
      transmission: 0.25,
      ior:          1.38,
      sheen:        0.40,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.35, 0.62, 0.52],
      quantizeSteps: 3,
      rimPower:     1.4,
      rimColor:     [0.55, 1.00, 0.85]
    },
    subsurfaceRadius: [0.06, 0.05, 0.04],
    emissive:         [0.20, 0.85, 0.65]
  }
});

// ─── decomposition constants ───────────────────────────────────
const DECOMPOSITION_CONSTANTS = Object.freeze({
  // Universal gas constant J/(mol·K).
  R: 8.314,

  // Litter quality factor by carbon-to-nitrogen ratio (C:N).
  // Lower C:N means faster decomposition. Function Q = 1 / (1 + C:N/40).
  //   leaves C:N ≈ 40 → Q ≈ 0.5
  //   wood C:N ≈ 400 → Q ≈ 0.09
  //   dung C:N ≈ 20 → Q ≈ 0.66
  //   carcass C:N ≈ 8 → Q ≈ 0.83
  litterQualityCN_leaf:     40.0,
  litterQualityCN_wood:    400.0,
  litterQualityCN_dung:     20.0,
  litterQualityCN_carcass:   8.0,
  litterQualityCN_mixed:    30.0,

  // Soil moisture scaling: Gaussian centred at archetype optimal.
  moistureFactorMin: 0.05,

  // Mass-to-nutrient yields (fraction of carbon mass).
  nitrogenPerCarbon:  0.025,
  phosphorusPerCarbon: 0.004,
  potassiumPerCarbon:  0.010,
  humusPerCarbon:      0.15,
  co2PerCarbon:        0.44,

  // Minimum litter mass to trigger a visible fruiting body (kg/m²).
  fruitingBodyThreshold: 0.02,

  // Mutation event threshold (kg/m² of nutrient release).
  mutationThreshold: 0.5,

  // Bioluminescent glow amplitude per unit decomposition rate.
  bioluminescentGlowPerRate: 8.0,
  bioluminescentRadiusMax: 3.0
});

// ─── defaults ────────────────────────────────────────────────────
const DECOMPOSER_DEFAULTS = Object.freeze({
  worldSeed:            0xC0FFEE70E,
  cellSize:             8.0,
  chunkSize:            1000,
  maxCellsPerChunk:     256,
  maxChunksPerFrame:    8,
  maxFruitingBodiesPerChunk: 16,
  baseLitterInput:      0.5,      // kg/m² per day (leaf fall etc.)
  seasonalLitterMultiplier: 3.0,  // autumn spike
  mutationCoalesceWindow: 10.0
});

class DecomposersSystem {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.defaults = { ...DECOMPOSER_DEFAULTS, ...(options.defaults || {}) };
    this.constants = { ...DECOMPOSITION_CONSTANTS, ...(options.constants || {}) };
    this.enableBioluminescence = options.enableBioluminescence ?? true;
    this.enableFruitingBodies = options.enableFruitingBodies ?? true;
    this.enableMutationEvents = options.enableMutationEvents ?? true;

    // ── scratch (pooled) ────────────────────────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVecD = new Vec3();
    this._tmpColor = new Vec3();
    this._tmpMatA = new Mat4();
    this._tmpSphere = new Sphere();
    this._tmpPlane = new Plane();

    // ── per-chunk decomposer state ─────────────────────────
    const chunkCap = options.maxTrackedChunks ?? 256;
    this._chunkCap = chunkCap;
    this._chunkKeys = new Map();
    this._chunkSlot = 0;
    this._chunkUsed = 0;

    this._chunkCX = new Int32Array(chunkCap);
    this._chunkCZ = new Int32Array(chunkCap);
    this._chunkState = new Uint8Array(chunkCap);

    // Per-chunk nutrient summary.
    this._chunkLitterMass       = new Float32Array(chunkCap);   // kg/m²
    this._chunkLitterQuality    = new Float32Array(chunkCap);   // 0..1 (higher = faster)
    this._chunkDecompRate       = new Float32Array(chunkCap);   // kg/m²/day
    this._chunkNitrogenReleased = new Float32Array(chunkCap);   // kg/m² cumulative
    this._chunkPhosReleased     = new Float32Array(chunkCap);
    this._chunkPotassiumReleased= new Float32Array(chunkCap);
    this._chunkHumusAccumulated = new Float32Array(chunkCap);
    this._chunkCO2Released      = new Float32Array(chunkCap);
    this._chunkFungalBiomass    = new Float32Array(chunkCap);
    this._chunkBacterialBiomass = new Float32Array(chunkCap);
    this._chunkDetritivoreBiomass = new Float32Array(chunkCap);
    this._chunkBioluminescenceIntensity = new Float32Array(chunkCap);
    this._chunkTemperatureFactor = new Float32Array(chunkCap);
    this._chunkMoistureFactor   = new Float32Array(chunkCap);
    this._chunkDominantType     = new Uint8Array(chunkCap);

    // Per-chunk fruiting-body placements.
    const fruitingCap = this.defaults.maxFruitingBodiesPerChunk;
    this._chunkFruitingCount = new Uint8Array(chunkCap);
    this._chunkFruitingX = new Array(chunkCap).fill(null);
    this._chunkFruitingY = new Array(chunkCap).fill(null);
    this._chunkFruitingZ = new Array(chunkCap).fill(null);
    this._chunkFruitingRadius = new Array(chunkCap).fill(null);
    this._chunkFruitingType = new Array(chunkCap).fill(null);
    this._chunkFruitingGlow = new Array(chunkCap).fill(null);

    // Free lists for fruiting body arrays.
    this._fruitingPool = {
      x: [], y: [], z: [], radius: [], type: [], glow: []
    };

    // ── per-frame global aggregate ─────────────────────────
    this._globalDecomposer = {
      totalLitterMass: 0,
      avgLitterQuality: 0,
      avgDecompRate: 0,
      totalNitrogenReleased: 0,
      totalPhosReleased: 0,
      totalPotassiumReleased: 0,
      totalHumusAccumulated: 0,
      totalCO2Released: 0,
      totalFungalBiomass: 0,
      totalBacterialBiomass: 0,
      totalDetritivoreBiomass: 0,
      bioluminescentChunkCount: 0,
      totalBioluminescenceIntensity: 0,
      avgTemperatureFactor: 1,
      avgMoistureFactor: 1,
      soilFertilityPulse: 0
    };

    // ── timing / frame reference ────────────────────────────
    this._lastUpdateTime = -Infinity;
    this._frameRef = null;

    // ── statistics ──────────────────────────────────────────
    this._stats = {
      updates: 0,
      chunksProcessed: 0,
      cellsProcessed: 0,
      totalDecompositionEvents: 0,
      fruitingBodiesPlaced: 0,
      bioluminescentFruitingPlaced: 0,
      nutrientPulses: 0,
      mutationEventsEmitted: 0
    };

    // ── collaborators ───────────────────────────────────────
    this._terrain = options.terrain || null;
    this._elevation = options.elevation || null;
    this._slope = options.slope || null;
    this._carve = options.carve || null;
    this._forest = options.forest || null;
    this._grass = options.grass || null;
    this._groundwater = options.groundwater || null;
    this._moisture = options.moisture || null;
    this._temporal = options.temporal || null;
    this._dispatcher = options.dispatcher || null;

    // ── material param reusable buffers ────────────────────
    this._blendedParams = {
      pbr: { baseColor: [0,0,0], metalness: 0, roughness: 0, clearcoat: 0, transmission: 0, ior: 1.33, sheen: 0, anisotropy: 0 },
      anime: { baseColor: [0,0,0], quantizeSteps: 3, rimPower: 2, rimColor: [0,0,0] },
      subsurfaceRadius: [0,0,0],
      emissive: [0,0,0]
    };

    // ── bioluminescent light array (fed into physical layer) ─
    this._bioluminescentLights = {
      count: 0,
      positions: [],
      colors: [],
      intensities: []
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachTerrain(t) { this._terrain = t; return this; }
  attachElevation(e) { this._elevation = e; return this; }
  attachSlope(s) { this._slope = s; return this; }
  attachCarve(c) { this._carve = c; return this; }
  attachForest(f) { this._forest = f; return this; }
  attachGrass(g) { this._grass = g; return this; }
  attachGroundwater(g) { this._groundwater = g; return this; }
  attachMoisture(m) { this._moisture = m; return this; }
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
  // ─── hash helper ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _hashCell(cx, cz, cellIdx) {
    let h = this.defaults.worldSeed | 0;
    h = (h ^ (cx * 0x9E3779B1)) | 0;
    h = (h ^ (cz * 0x85EBCA77)) | 0;
    h = (h ^ (cellIdx * 0xC2B2AE3D)) | 0;
    h = ((h << 13) | (h >>> 19)) | 0;
    h = (h * 0x5bd1e995) | 0;
    h = (h ^ (h >>> 15)) | 0;
    return h >>> 0;
  }

  _rand01(seed) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0xFFFFFFFF;
  }

  // ══════════════════════════════════════════════════════════
  // ─── temperature factor (Arrhenius) ─────────────────────
  // ══════════════════════════════════════════════════════════
  // k(T) = A·exp(−Ea/(R·T))   with T in Kelvin.
  // Normalized to k(T_ref = 15 °C) = 1.
  temperatureFactor(activationEnergy, tempC) {
    const R = this.constants.R;
    const T = tempC + 273.15;
    const T_ref = 15 + 273.15;
    if (T <= 0 || T_ref <= 0) return 0;

    const k = Math.exp(-activationEnergy / (R * T));
    const k_ref = Math.exp(-activationEnergy / (R * T_ref));

    return k_ref > 1e-20 ? k / k_ref : 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── moisture factor (Gaussian) ─────────────────────────
  // ══════════════════════════════════════════════════════════
  // μ(m) = exp(−((m − m_opt) / w)²)
  // Peak at archetype moistureOptimal, drops off exponentially away.
  moistureFactor(optimal, width, moisture) {
    const x = (moisture - optimal) / Math.max(1e-5, width);
    const f = Math.exp(-(x * x));
    return Math.max(this.constants.moistureFactorMin, f);
  }

  // ══════════════════════════════════════════════════════════
  // ─── litter quality factor ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Q = 1 / (1 + C:N / 40) — higher Q means faster decomposition.
  litterQualityFactor(cnRatio) {
    return 1 / (1 + cnRatio / 40);
  }

  // ══════════════════════════════════════════════════════════
  // ─── determine litter type from available sources ───────
  // ══════════════════════════════════════════════════════════
  // Returns { cnRatio, mass } for the litter at a world position.
  _sampleLitter(wx, wz, frame) {
    const season = this._temporal ? this._temporal.seasonScalar : 0.5;
    const seasonalMul = 1 + Math.sin(season * 2 * Math.PI - Math.PI / 2) * (this.defaults.seasonalLitterMultiplier - 1) * 0.5;

    let leafMass = 0;
    let leafCN = this.constants.litterQualityCN_leaf;
    let woodMass = 0;
    let woodCN = this.constants.litterQualityCN_wood;
    let carcassMass = 0;
    let carcassCN = this.constants.litterQualityCN_carcass;
    let dungMass = 0;
    let dungCN = this.constants.litterQualityCN_dung;

    // ── Forest contribution (fallen leaves, dead wood) ─────
    if (this._forest) {
      const forest = this._forest.getForestAt(wx, wz);
      if (forest) {
        const canopy = forest.canopyDensity;
        const trees = forest.trees;
        // Walk nearby trees for their age (old trees = more dead wood).
        let totalAge = 0;
        for (let k = 0; k < forest.count; k++) {
          const dx = trees.x[k] - wx;
          const dz = trees.z[k] - wz;
          const d2 = dx * dx + dz * dz;
          if (d2 < 100) {
            totalAge += trees.age[k];
          }
        }
        // Leaf fall scales with canopy and season.
        leafMass += canopy * this.defaults.baseLitterInput * seasonalMul * 2.0;
        // Dead wood accumulates in old stands.
        if (totalAge > 500) {
          woodMass += canopy * 0.15;
        }
      }
    }

    // ── Grass contribution (dried / dead grass) ────────────
    if (this._grass) {
      const grass = this._grass.getGrassAt(wx, wz);
      if (grass) {
        const coverage = grass.coverage;
        // Grass litter peaks when it's not blooming (i.e., autumn).
        const notBlooming = 1 - grass.bloomFactor;
        leafMass += coverage * this.defaults.baseLitterInput * notBlooming * 0.5;
      }
    }

    // ── Carcass contribution from causal events ────────────
    const causal = frame.layers.causal;
    if (causal && causal.derivedSignals) {
      const ds = causal.derivedSignals;
      for (let i = 0; i < ds.count; i++) {
        if (ds.types[i] === DERIVED_SIGNAL.ECOLOGY && ds.forces[i] > 50) {
          const px = ds.positions[i * 3];
          const pz = ds.positions[i * 3 + 2];
          const dx = px - wx;
          const dz = pz - wz;
          const d2 = dx * dx + dz * dz;
          if (d2 < 400) {
            // Large ecology event nearby = carcass.
            carcassMass += ds.forces[i] * 0.001 * ds.decays[i];
          }
        }
      }
    }

    // Combine: dominant CN ratio weighted by mass.
    const totalMass = leafMass + woodMass + carcassMass + dungMass;
    if (totalMass < 1e-5) {
      return { mass: 0, cnRatio: this.constants.litterQualityCN_mixed, type: 4 };
    }
    const weightedCN = (
      leafCN * leafMass +
      woodCN * woodMass +
      carcassCN * carcassMass +
      dungCN * dungMass
    ) / totalMass;

    // Dominant type.
    let dominantType = 4;   // mixed
    const maxMass = Math.max(leafMass, woodMass, carcassMass, dungMass);
    if (maxMass === leafMass) dominantType = 0;
    else if (maxMass === woodMass) dominantType = 1;
    else if (maxMass === carcassMass) dominantType = 2;
    else if (maxMass === dungMass) dominantType = 3;

    return { mass: totalMass, cnRatio: weightedCN, type: dominantType };
  }

  // ══════════════════════════════════════════════════════════
  // ─── moisture sampling at a point ───────────────────────
  // ══════════════════════════════════════════════════════════
  _sampleMoisture(wx, wz, frame) {
    if (this._groundwater) {
      const gw = this._groundwater.getGroundwaterAt(wx, wz);
      if (gw) return gw.soilMoisture;
    }
    if (this._moisture) {
      return this._moisture.sampleHumidityAt(wx, wz);
    }
    const physical = frame.layers.physical;
    return physical?.soilMoisture ?? 0.5;
  }

  _sampleTemperature(frame) {
    const physical = frame.layers.physical;
    return physical?.ambientTemperature ?? 15;
  }

  // ══════════════════════════════════════════════════════════
  // ─── decomposer archetype selection ─────────────────────
  // ══════════════════════════════════════════════════════════
  // Given litter type, moisture, and temperature, return the
  // archetype(s) best suited to decompose here.
  _selectDecomposerTypes(litterType, moisture, tempC, seed) {
    const types = [];
    const r = this._rand01(seed);

    // Determine which archetypes can act on this litter.
    const candidates = [];
    for (let t = 1; t <= 9; t++) {
      const schema = DECOMPOSER_SCHEMA[t];
      if (!schema) continue;
      if (!schema.litterTypes.includes(litterType) && litterType !== 4) continue;
      // Moisture compatibility: within 2× moistureWidth.
      const moistureFit = this.moistureFactor(schema.moistureOptimal, schema.moistureWidth * 2, moisture);
      if (moistureFit < 0.15) continue;
      // Temperature: not too hot/cold.
      if (tempC < -10 || tempC > 55) continue;
      candidates.push({ type: t, moistureFit });
    }

    // If no candidates, use bacteria aerobic (most resilient).
    if (candidates.length === 0) {
      return [DECOMPOSER_TYPE.BACTERIA_AEROBIC];
    }

    // Weight by moisture fit.
    let totalWeight = 0;
    for (const c of candidates) totalWeight += c.moistureFit;

    // Pick 1-3 archetypes weighted by fit.
    const numPicks = Math.min(candidates.length, 1 + Math.floor(r * 3));
    const picked = new Set();
    for (let i = 0; i < numPicks; i++) {
      let rand = this._rand01(seed + i * 17) * totalWeight;
      for (const c of candidates) {
        rand -= c.moistureFit;
        if (rand <= 0 || i === numPicks - 1) {
          picked.add(c.type);
          break;
        }
      }
    }
    for (const t of picked) types.push(t);
    return types;
  }

  // ══════════════════════════════════════════════════════════
  // ─── decomposition computation ──────────────────────────
  // ══════════════════════════════════════════════════════════
  // For a given archetype + litter, returns the rate of mass loss.
  _computeDecompositionRate(type, mass, cnRatio, moisture, tempC) {
    const schema = DECOMPOSER_SCHEMA[type];
    if (!schema) return 0;

    const tempFactor = this.temperatureFactor(schema.activationEnergy, tempC);
    const moistFactor = this.moistureFactor(schema.moistureOptimal, schema.moistureWidth, moisture);
    const qualityFactor = this.litterQualityFactor(cnRatio);

    // Base rate: schema.preExponentialA scaled by sub-daily time step.
    // We normalize the coefficient so that at 15°C with optimum moisture
    // and moderate quality, the mass halves in ~1 month.
    const baseRate = 1.0 / 30.0;   // 1/day at reference

    return mass * baseRate * tempFactor * moistFactor * qualityFactor;
  }

  // ══════════════════════════════════════════════════════════
  // ─── chunk sampling ────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _sampleChunk(cx, cz, frame) {
    const chunkSize = this.defaults.chunkSize;
    const cellSize = this.defaults.cellSize;
    const cellsPerSide = Math.max(1, Math.floor(chunkSize / cellSize));

    let slot = this._getChunkSlot(cx, cz);
    if (slot < 0) slot = this._allocChunkSlot(cx, cz);

    // Allocate fruiting body arrays.
    if (!this._chunkFruitingX[slot]) {
      this._chunkFruitingX[slot] = this._acquireFruiting('x');
      this._chunkFruitingY[slot] = this._acquireFruiting('y');
      this._chunkFruitingZ[slot] = this._acquireFruiting('z');
      this._chunkFruitingRadius[slot] = this._acquireFruiting('radius');
      this._chunkFruitingType[slot] = this._acquireFruitingType();
      this._chunkFruitingGlow[slot] = this._acquireFruiting('glow');
    }

    const fX = this._chunkFruitingX[slot];
    const fY = this._chunkFruitingY[slot];
    const fZ = this._chunkFruitingZ[slot];
    const fRad = this._chunkFruitingRadius[slot];
    const fType = this._chunkFruitingType[slot];
    const fGlow = this._chunkFruitingGlow[slot];

    let fruitingIdx = 0;

    // Aggregates.
    let totalLitter = 0;
    let totalCN = 0;
    let totalDecomp = 0;
    let totalN = 0, totalP = 0, totalK = 0;
    let totalHumus = 0, totalCO2 = 0;
    let totalFungalBio = 0, totalBacterialBio = 0, totalDetritivoreBio = 0;
    let totalBiolum = 0;
    let sumTempFactor = 0, sumMoistFactor = 0;
    let cellsSampled = 0;

    // Archetype counters for dominant.
    const typeCount = new Uint16Array(DECOMPOSER_TYPE_NAMES.length);

    for (let j = 0; j < cellsPerSide; j++) {
      for (let i = 0; i < cellsPerSide; i++) {
        const cellIdx = j * cellsPerSide + i;
        const wx = cx * chunkSize + (i + 0.5) * cellSize;
        const wz = cz * chunkSize + (j + 0.5) * cellSize;

        const litter = this._sampleLitter(wx, wz, frame);
        if (litter.mass < 1e-4) continue;

        const moisture = this._sampleMoisture(wx, wz, frame);
        const tempC = this._sampleTemperature(frame);
        const altitude = this._getHeight(wx, wz);

        // Select archetypes active in this cell.
        const seed = this._hashCell(cx, cz, cellIdx);
        const types = this._selectDecomposerTypes(litter.type, moisture, tempC, seed);

        // Compute decomposition rate summed over active archetypes.
        let cellRate = 0;
        let cellN = 0, cellP = 0, cellK = 0;
        let cellHumus = 0, cellCO2 = 0;
        let cellFungal = 0, cellBacterial = 0, cellDetritivore = 0;
        let cellBiolum = 0;

        for (const t of types) {
          const schema = DECOMPOSER_SCHEMA[t];
          const rate = this._computeDecompositionRate(t, litter.mass, litter.cnRatio, moisture, tempC);
          cellRate += rate;

          // Carbon consumed per day.
          const carbon = rate * 0.4;   // litter is ~40% carbon
          const cUse = carbon * schema.carbonUseEfficiency;

          // Nutrient release (fraction of consumed carbon).
          cellN += carbon * this.constants.nitrogenPerCarbon * schema.nitrogenRelease;
          cellP += carbon * this.constants.phosphorusPerCarbon * schema.phosphorusRelease;
          cellK += carbon * this.constants.potassiumPerCarbon * schema.potassiumRelease;
          cellHumus += carbon * this.constants.humusPerCarbon * (1 - schema.carbonUseEfficiency);
          cellCO2 += carbon * this.constants.co2PerCarbon * (1 - schema.carbonUseEfficiency);

          // Biomass production by decomposer category.
          if (t >= 1 && t <= 3) cellFungal += cUse;
          else if (t >= 4 && t <= 5) cellBacterial += cUse;
          else if (t >= 6 && t <= 8) cellDetritivore += cUse;

          // Bioluminescence (only for bioluminescent type).
          if (schema.bioluminescence > 0 && this.enableBioluminescence) {
            cellBiolum += rate * this.constants.bioluminescentGlowPerRate;
          }

          typeCount[t]++;
        }

        totalLitter += litter.mass;
        totalCN += litter.cnRatio * litter.mass;
        totalDecomp += cellRate;
        totalN += cellN;
        totalP += cellP;
        totalK += cellK;
        totalHumus += cellHumus;
        totalCO2 += cellCO2;
        totalFungalBio += cellFungal;
        totalBacterialBio += cellBacterial;
        totalDetritivoreBio += cellDetritivore;
        totalBiolum += cellBiolum;

        const tempFactor = this.temperatureFactor(50000, tempC);
        const moistFactor = this.moistureFactor(0.6, 0.3, moisture);
        sumTempFactor += tempFactor;
        sumMoistFactor += moistFactor;
        cellsSampled++;

        // Fruiting body placement (if litter is rich enough).
        if (this.enableFruitingBodies &&
            litter.mass > this.constants.fruitingBodyThreshold &&
            fruitingIdx < this.defaults.maxFruitingBodiesPerChunk) {
          const roll = this._rand01(seed + 0xB00B);
          const prob = Math.min(0.35, litter.mass * 0.5 * moistFactor);
          if (roll < prob) {
            // Choose a fruiting archetype from those present.
            let fruitingType = DECOMPOSER_TYPE.FUNGI_MUSHROOM;
            for (const t of types) {
              if (t === DECOMPOSER_TYPE.BIOLUMINESCENT) { fruitingType = t; break; }
              if (t === DECOMPOSER_TYPE.FUNGI_MUSHROOM) fruitingType = t;
            }
            const radius = 0.10 + this._rand01(seed + 0xC0DE) * 0.20;
            const glowIntensity = fruitingType === DECOMPOSER_TYPE.BIOLUMINESCENT
              ? cellBiolum * 0.1 : 0;

            fX[fruitingIdx] = wx;
            fY[fruitingIdx] = altitude + 0.02;
            fZ[fruitingIdx] = wz;
            fRad[fruitingIdx] = radius;
            fType[fruitingIdx] = fruitingType;
            fGlow[fruitingIdx] = glowIntensity;
            fruitingIdx++;

            this._stats.fruitingBodiesPlaced++;
            if (fruitingType === DECOMPOSER_TYPE.BIOLUMINESCENT) {
              this._stats.bioluminescentFruitingPlaced++;
            }
          }
        }

        this._stats.cellsProcessed++;
      }
    }

    // Store results.
    this._chunkFruitingCount[slot] = fruitingIdx;

    const avgCN = totalLitter > 0 ? totalCN / totalLitter : 30;
    const qualityFactor = this.litterQualityFactor(avgCN);
    const avgTempFactor = cellsSampled > 0 ? sumTempFactor / cellsSampled : 1;
    const avgMoistFactor = cellsSampled > 0 ? sumMoistFactor / cellsSampled : 1;

    // Dominant type.
    let dominantType = 0;
    let maxCount = 0;
    for (let t = 1; t < typeCount.length; t++) {
      if (typeCount[t] > maxCount) { maxCount = typeCount[t]; dominantType = t; }
    }

    // Bioluminescence intensity (0..1).
    const biolumIntensity = Math.min(1, totalBiolum * 0.05);

    this._chunkLitterMass[slot] = totalLitter;
    this._chunkLitterQuality[slot] = qualityFactor;
    this._chunkDecompRate[slot] = totalDecomp;
    this._chunkNitrogenReleased[slot] += totalN;
    this._chunkPhosReleased[slot] += totalP;
    this._chunkPotassiumReleased[slot] += totalK;
    this._chunkHumusAccumulated[slot] += totalHumus;
    this._chunkCO2Released[slot] += totalCO2;
    this._chunkFungalBiomass[slot] = totalFungalBio;
    this._chunkBacterialBiomass[slot] = totalBacterialBio;
    this._chunkDetritivoreBiomass[slot] = totalDetritivoreBio;
    this._chunkBioluminescenceIntensity[slot] = biolumIntensity;
    this._chunkTemperatureFactor[slot] = avgTempFactor;
    this._chunkMoistureFactor[slot] = avgMoistFactor;
    this._chunkDominantType[slot] = dominantType;

    this._stats.chunksProcessed++;
    this._stats.totalDecompositionEvents++;

    // Emit coalesced mutation if cumulative nutrient release is high.
    if (this.enableMutationEvents &&
        (this._chunkNitrogenReleased[slot] > this.constants.mutationThreshold) &&
        this._dispatcher) {
      // Reset counter after emitting.
      const cumulative = this._chunkNitrogenReleased[slot];
      this._chunkNitrogenReleased[slot] = 0;
      this._chunkPhosReleased[slot] = 0;
      this._chunkPotassiumReleased[slot] = 0;

      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.ECOLOGY,
        [(cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize],
        -1, cumulative * 20, 10.0,
        {
          kind: 'nutrient_pulse',
          chunkX: cx, chunkZ: cz,
          nitrogen: cumulative,
          dominantType: DECOMPOSER_TYPE_NAMES[dominantType],
          humus: this._chunkHumusAccumulated[slot]
        }
      );
      this._stats.mutationEventsEmitted++;
      this._stats.nutrientPulses++;
    }

    return fruitingIdx;
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
    return slot;
  }

  _evictSlot(slot) {
    if (this._chunkState[slot] === 0) return;
    const key = this._chunkCX[slot] + ',' + this._chunkCZ[slot];
    this._chunkKeys.delete(key);
    this._chunkState[slot] = 0;
    this._chunkFruitingCount[slot] = 0;
    if (this._chunkFruitingX[slot]) {
      this._fruitingPool.x.push(this._chunkFruitingX[slot]);
      this._fruitingPool.y.push(this._chunkFruitingY[slot]);
      this._fruitingPool.z.push(this._chunkFruitingZ[slot]);
      this._fruitingPool.radius.push(this._chunkFruitingRadius[slot]);
      this._fruitingPool.type.push(this._chunkFruitingType[slot]);
      this._fruitingPool.glow.push(this._chunkFruitingGlow[slot]);
    }
    this._chunkFruitingX[slot] = null;
    this._chunkFruitingY[slot] = null;
    this._chunkFruitingZ[slot] = null;
    this._chunkFruitingRadius[slot] = null;
    this._chunkFruitingType[slot] = null;
    this._chunkFruitingGlow[slot] = null;
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

  _acquireFruiting(kind) {
    const pool = this._fruitingPool[kind];
    if (pool && pool.length > 0) {
      const arr = pool.pop();
      arr.fill(0);
      return arr;
    }
    return new Float32Array(this.defaults.maxFruitingBodiesPerChunk);
  }

  _acquireFruitingType() {
    return new Uint8Array(this.defaults.maxFruitingBodiesPerChunk);
  }

  // ══════════════════════════════════════════════════════════
  // ─── public queries ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getDecomposersAt(wx, wz) {
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot < 0 || this._chunkState[slot] === 0) return null;

    return {
      litterMass: this._chunkLitterMass[slot],
      litterQuality: this._chunkLitterQuality[slot],
      decompRate: this._chunkDecompRate[slot],
      nitrogenReleased: this._chunkNitrogenReleased[slot],
      phosReleased: this._chunkPhosReleased[slot],
      potassiumReleased: this._chunkPotassiumReleased[slot],
      humusAccumulated: this._chunkHumusAccumulated[slot],
      co2Released: this._chunkCO2Released[slot],
      fungalBiomass: this._chunkFungalBiomass[slot],
      bacterialBiomass: this._chunkBacterialBiomass[slot],
      detritivoreBiomass: this._chunkDetritivoreBiomass[slot],
      bioluminescenceIntensity: this._chunkBioluminescenceIntensity[slot],
      temperatureFactor: this._chunkTemperatureFactor[slot],
      moistureFactor: this._chunkMoistureFactor[slot],
      dominantType: this._chunkDominantType[slot],
      dominantTypeName: DECOMPOSER_TYPE_NAMES[this._chunkDominantType[slot]],
      fruitingCount: this._chunkFruitingCount[slot],
      fruitingBodies: {
        x: this._chunkFruitingX[slot],
        y: this._chunkFruitingY[slot],
        z: this._chunkFruitingZ[slot],
        radius: this._chunkFruitingRadius[slot],
        type: this._chunkFruitingType[slot],
        glow: this._chunkFruitingGlow[slot]
      }
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── material parameter dispatch ────────────────────────
  // ══════════════════════════════════════════════════════════
  getDecomposerMaterialParams(type) {
    return DECOMPOSER_MATERIAL[type] || DECOMPOSER_MATERIAL[DECOMPOSER_TYPE.FUNGI_MUSHROOM];
  }

  // Blend material params by decomposition rate and age.
  blendDecomposerMaterial(type, decompRate, out) {
    const src = DECOMPOSER_MATERIAL[type];
    if (!src) return null;
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

    // Bioluminescence glow scales with decomposition rate.
    const glowBoost = type === DECOMPOSER_TYPE.BIOLUMINESCENT
      ? Math.min(2, decompRate * 5)
      : 0;
    o.emissive[0] = src.emissive[0] * (1 + glowBoost);
    o.emissive[1] = src.emissive[1] * (1 + glowBoost);
    o.emissive[2] = src.emissive[2] * (1 + glowBoost);

    return o;
  }

  // ══════════════════════════════════════════════════════════
  // ─── frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.decomposers) {
      spatial.decomposers = {
        chunkCount: 0,
        chunkCX: new Int32Array(this._chunkCap),
        chunkCZ: new Int32Array(this._chunkCap),
        chunkSlots: new Int32Array(this._chunkCap),
        litterMass: this._chunkLitterMass,
        litterQuality: this._chunkLitterQuality,
        decompRate: this._chunkDecompRate,
        nitrogenReleased: this._chunkNitrogenReleased,
        phosReleased: this._chunkPhosReleased,
        potassiumReleased: this._chunkPotassiumReleased,
        humusAccumulated: this._chunkHumusAccumulated,
        co2Released: this._chunkCO2Released,
        fungalBiomass: this._chunkFungalBiomass,
        bacterialBiomass: this._chunkBacterialBiomass,
        detritivoreBiomass: this._chunkDetritivoreBiomass,
        bioluminescenceIntensity: this._chunkBioluminescenceIntensity,
        temperatureFactor: this._chunkTemperatureFactor,
        moistureFactor: this._chunkMoistureFactor,
        dominantType: this._chunkDominantType,
        fruitingCount: this._chunkFruitingCount,
        fruiting: {
          x: this._chunkFruitingX,
          y: this._chunkFruitingY,
          z: this._chunkFruitingZ,
          radius: this._chunkFruitingRadius,
          type: this._chunkFruitingType,
          glow: this._chunkFruitingGlow
        },
        materialParams: DECOMPOSER_MATERIAL,
        typeNames: DECOMPOSER_TYPE_NAMES,
        schema: DECOMPOSER_SCHEMA
      };
    }

    const d = spatial.decomposers;
    d.chunkCount = 0;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      if (d.chunkCount >= this._chunkCap) break;
      d.chunkCX[d.chunkCount] = this._chunkCX[i];
      d.chunkCZ[d.chunkCount] = this._chunkCZ[i];
      d.chunkSlots[d.chunkCount] = i;
      d.chunkCount++;
    }
  }

  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    let sumLitter = 0;
    let sumCN = 0;
    let sumDecomp = 0;
    let totalN = 0, totalP = 0, totalK = 0;
    let totalHumus = 0, totalCO2 = 0;
    let totalFungal = 0, totalBacterial = 0, totalDetritivore = 0;
    let totalBiolum = 0;
    let chunksWithLitter = 0;
    let biolumChunks = 0;
    let sumTempFactor = 0, sumMoistFactor = 0;

    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      if (this._chunkLitterMass[i] < 1e-4) continue;
      chunksWithLitter++;

      sumLitter += this._chunkLitterMass[i];
      sumCN += 1 / Math.max(0.01, this._chunkLitterQuality[i]);
      sumDecomp += this._chunkDecompRate[i];
      totalN += this._chunkNitrogenReleased[i];
      totalP += this._chunkPhosReleased[i];
      totalK += this._chunkPotassiumReleased[i];
      totalHumus += this._chunkHumusAccumulated[i];
      totalCO2 += this._chunkCO2Released[i];
      totalFungal += this._chunkFungalBiomass[i];
      totalBacterial += this._chunkBacterialBiomass[i];
      totalDetritivore += this._chunkDetritivoreBiomass[i];
      totalBiolum += this._chunkBioluminescenceIntensity[i];
      if (this._chunkBioluminescenceIntensity[i] > 0.05) biolumChunks++;
      sumTempFactor += this._chunkTemperatureFactor[i];
      sumMoistFactor += this._chunkMoistureFactor[i];
    }

    const gd = this._globalDecomposer;
    gd.totalLitterMass = sumLitter;
    gd.avgLitterQuality = chunksWithLitter > 0 ? sumCN / chunksWithLitter : 0;
    gd.avgDecompRate = chunksWithLitter > 0 ? sumDecomp / chunksWithLitter : 0;
    gd.totalNitrogenReleased = totalN;
    gd.totalPhosReleased = totalP;
    gd.totalPotassiumReleased = totalK;
    gd.totalHumusAccumulated = totalHumus;
    gd.totalCO2Released = totalCO2;
    gd.totalFungalBiomass = totalFungal;
    gd.totalBacterialBiomass = totalBacterial;
    gd.totalDetritivoreBiomass = totalDetritivore;
    gd.bioluminescentChunkCount = biolumChunks;
    gd.totalBioluminescenceIntensity = totalBiolum;
    gd.avgTemperatureFactor = chunksWithLitter > 0 ? sumTempFactor / chunksWithLitter : 1;
    gd.avgMoistureFactor = chunksWithLitter > 0 ? sumMoistFactor / chunksWithLitter : 1;

    // Soil fertility pulse: rate at which nutrients are being released now.
    gd.soilFertilityPulse = chunksWithLitter > 0 ? sumDecomp / chunksWithLitter : 0;

    if (!physical.decomposerProperties) {
      physical.decomposerProperties = {};
    }
    Object.assign(physical.decomposerProperties, gd);

    // Material-facing aggregates.
    physical.nutrientNitrogen = gd.totalNitrogenReleased;
    physical.nutrientPhos = gd.totalPhosReleased;
    physical.nutrientPotassium = gd.totalPotassiumReleased;
    physical.humusFraction = gd.totalHumusAccumulated;
    physical.co2Respiration = gd.totalCO2Released;
    physical.fungalBiomass = gd.totalFungalBiomass;
    physical.bacterialBiomass = gd.totalBacterialBiomass;
    physical.detritivoreBiomass = gd.totalDetritivoreBiomass;
    physical.bioluminescenceTotal = gd.totalBioluminescenceIntensity;
    physical.soilFertilityPulse = gd.soilFertilityPulse;

    // ── Bioluminescent light sources for clustered lighting ─
    this._bioluminescentLights.count = 0;
    this._bioluminescentLights.positions.length = 0;
    this._bioluminescentLights.colors.length = 0;
    this._bioluminescentLights.intensities.length = 0;

    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      if (this._chunkBioluminescenceIntensity[i] < 0.05) continue;
      const fCount = this._chunkFruitingCount[i];
      const fX = this._chunkFruitingX[i];
      const fY = this._chunkFruitingY[i];
      const fZ = this._chunkFruitingZ[i];
      const fType = this._chunkFruitingType[i];
      const fGlow = this._chunkFruitingGlow[i];
      if (!fType) continue;

      for (let k = 0; k < fCount && k < 8; k++) {
        if (fType[k] !== DECOMPOSER_TYPE.BIOLUMINESCENT) continue;
        const glowIntensity = fGlow[k] * this._chunkBioluminescenceIntensity[i];
        if (glowIntensity < 0.05) continue;

        this._bioluminescentLights.positions.push(fX[k], fY[k] + 0.1, fZ[k]);
        // Bioluminescent fungi glow green-blue.
        this._bioluminescentLights.colors.push(0.35, 1.00, 0.75);
        this._bioluminescentLights.intensities.push(Math.min(1, glowIntensity));
        this._bioluminescentLights.count++;
      }
    }

    physical.decomposerLights = this._bioluminescentLights;
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
      if (slot >= 0 && this._chunkLitterMass[slot] > 0) continue;
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

  setConstants(params) {
    for (const k of Object.keys(this.constants)) {
      if (params[k] !== undefined) this.constants[k] = params[k];
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
  getGlobalDecomposer() { return { ...this._globalDecomposer }; }

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
    this._forest = null;
    this._grass = null;
    this._groundwater = null;
    this._moisture = null;
    this._temporal = null;
    this._dispatcher = null;
    this._frameRef = null;
    this._clearAllChunks();
    for (const key of Object.keys(this._fruitingPool)) {
      this._fruitingPool[key].length = 0;
    }
    this._bioluminescentLights.count = 0;
    this._bioluminescentLights.positions.length = 0;
    this._bioluminescentLights.colors.length = 0;
    this._bioluminescentLights.intensities.length = 0;
  }
}

export {
  DecomposersSystem,
  DECOMPOSER_TYPE,
  DECOMPOSER_TYPE_NAMES,
  DECOMPOSER_SCHEMA,
  DECOMPOSER_MATERIAL,
  DECOMPOSITION_CONSTANTS,
  DECOMPOSER_DEFAULTS,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};