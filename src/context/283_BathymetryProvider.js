// file number : 283
// full path name : src/context/283_BathymetryProvider.js
// description : Bathymetry (underwater topography) provider for all water-bearing biomes. Reads the base heightfield from 280_TerrainProvider + 281_ElevationProvider, the continental shelf data from 282_Z09_ContinentalReliefGradientProvider, and the sea level from the elevation provider, then produces a full underwater descriptor for every point below the water surface. For each water cell it computes: depth below sea level, seabed gradient (horizontal, vertical, slope), seabed aspect, seabed material class (SAND, SILT, MUD, GRAVEL, CORAL, ROCK, KELP_FOREST, THERMAL_VENT), substrate hardness and porosity, underwater light attenuation per wavelength band using the Beer-Lambert law L(z) = L₀·exp(−k_d·z) with wavelength-specific absorption coefficients k_d(λ) (red absorbs fastest, blue deepest — the classic underwater colour shift), thermocline depth and temperature stratification, dissolved oxygen and salinity proxies, current strength and direction (from continental + local slope), and reef/life-suitability scores. Provides a full PBR/anime parameter set for underwater materials: base colour per seabed class, base metalness/roughness, foam coverage, caustics phase, refraction index, subsurface scattering radius, and anime flat-shade thresholds — all exposed as live scalars the material shader reads each frame. Emits a MUTATION event when a large seabed disturbance is detected (e.g. lava from a vent, ice melting, sediment slide from a big impact). Writes per-cell descriptors into frame.layers.spatial.bathymetry and aggregates into frame.layers.physical.waterProperties. All scratch objects are pooled; no allocation after the first frame.
// best for : Every water-adjacent consumer in the living world — LandscapeWaterFlowSystem for routing, AquaticFreshwaterBiome and AquaticMarineBiome for biome assignment, LandscapeFaunaSpawnSystem for fish/marine life placement, LandscapePropPlacementSystem for corals and kelp, materials for underwater PBR/anime blending, caustic lighting, fog, and thermocline effects. Complements 280–282_Z09 by adding the third dimension (depth) to the elevation stack.
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
  ForestGradientProvider, TREE_TYPE,
  GrassAndFlowresGradientProvider, GRASS_TYPE,
  ContinentalReliefGradientProvider, CONTINENTAL_TYPE,
  ColorManagement, ColorSpace,
  BufferAttribute, Data3DTexture, DataArrayTexture,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Ray, Plane, Sphere
} from './264_MathECSImportBarrel.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 2;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── bathymetry zone codes ──────────────────────────────────────
const BATHY_ZONE = Object.freeze({
  SURFACE:       0,   // 0 to −5 m
  SHALLOW:       1,   // −5 to −20 m  (photic)
  UPPER_SHELF:   2,   // −20 to −100 m (photic)
  MID_SHELF:     3,   // −100 to −200 m (photic edge)
  LOWER_SHELF:   4,   // −200 to −500 m (disphotic)
  SLOPE:         5,   // −500 to −2000 m (aphotic)
  ABYSS:         6,   // −2000 to −4000 m
  HADAL:         7,   // −4000 to −6000 m
  TRENCH:        8    // > −6000 m
});

const BATHY_ZONE_NAMES = Object.freeze([
  'surface', 'shallow', 'upper_shelf', 'mid_shelf',
  'lower_shelf', 'slope', 'abyss', 'hadal', 'trench'
]);

// ─── seabed material classes ───────────────────────────────────
const SEABED_CLASS = Object.freeze({
  SAND:           0,   // quartz, shell fragments (bright, reflective)
  SILT:           1,   // fine particles (smooth, soft)
  MUD:            2,   // organic-rich clay (dark, anoxic)
  GRAVEL:         3,   // coarse clasts (rough, high friction)
  CORAL:          4,   // coral rubble / reef (bright, high roughness)
  ROCK:           5,   // exposed bedrock (hard, smooth)
  KELP_FOREST:    6,   // kelp-covered (dark, high scattering)
  THERMAL_VENT:   7,   // black smoker (hot, mineral-rich, emissive)
  SEAGRASS:       8,   // seagrass meadow (green tint, soft)
  ICE:            9    // polar ice shelf
});

const SEABED_CLASS_NAMES = Object.freeze([
  'sand', 'silt', 'mud', 'gravel', 'coral', 'rock',
  'kelp_forest', 'thermal_vent', 'seagrass', 'ice'
]);

// ─── base PBR + anime parameters per seabed class ──────────────
// Each class carries the full parameter set the material system
// reads to drive its shader. Underwater rendering combines PBR
// reflectance with a subtle anime flat term for readability.
const SEABED_MATERIAL = Object.freeze({
  [SEABED_CLASS.SAND]: {
    pbr: {
      baseColor:    [0.78, 0.72, 0.55],
      metalness:    0.00,
      roughness:    0.85,
      clearcoat:    0.00,
      transmission: 0.00,
      ior:          1.33,
      sheen:        0.00,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.82, 0.76, 0.58],
      quantizeSteps: 3,
      rimPower:     1.8,
      rimColor:     [0.60, 0.85, 1.00]
    },
    subsurfaceRadius: [0.4, 0.3, 0.15],     // RGB, in metres
    emissive:         [0.00, 0.00, 0.00],
    foamCoverage:     0.05,
    causticsStrength: 0.85,
    lightAttenuation: [0.45, 0.10, 0.05]     // R, G, B absorption coefficients (m⁻¹)
  },
  [SEABED_CLASS.SILT]: {
    pbr: {
      baseColor:    [0.55, 0.50, 0.42],
      metalness:    0.00,
      roughness:    0.90,
      clearcoat:    0.00,
      transmission: 0.00,
      ior:          1.33,
      sheen:        0.15,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.58, 0.52, 0.44],
      quantizeSteps: 3,
      rimPower:     2.0,
      rimColor:     [0.55, 0.75, 0.90]
    },
    subsurfaceRadius: [0.2, 0.15, 0.08],
    emissive:         [0.00, 0.00, 0.00],
    foamCoverage:     0.10,
    causticsStrength: 0.55,
    lightAttenuation: [0.55, 0.15, 0.08]
  },
  [SEABED_CLASS.MUD]: {
    pbr: {
      baseColor:    [0.22, 0.18, 0.14],
      metalness:    0.00,
      roughness:    0.95,
      clearcoat:    0.00,
      transmission: 0.00,
      ior:          1.33,
      sheen:        0.30,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.24, 0.20, 0.16],
      quantizeSteps: 3,
      rimPower:     2.2,
      rimColor:     [0.35, 0.55, 0.65]
    },
    subsurfaceRadius: [0.10, 0.06, 0.04],
    emissive:         [0.00, 0.00, 0.00],
    foamCoverage:     0.15,
    causticsStrength: 0.35,
    lightAttenuation: [0.65, 0.20, 0.12]
  },
  [SEABED_CLASS.GRAVEL]: {
    pbr: {
      baseColor:    [0.50, 0.48, 0.44],
      metalness:    0.00,
      roughness:    0.75,
      clearcoat:    0.05,
      transmission: 0.00,
      ior:          1.33,
      sheen:        0.05,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.52, 0.50, 0.46],
      quantizeSteps: 3,
      rimPower:     1.6,
      rimColor:     [0.55, 0.80, 0.95]
    },
    subsurfaceRadius: [0.05, 0.04, 0.02],
    emissive:         [0.00, 0.00, 0.00],
    foamCoverage:     0.20,
    causticsStrength: 0.75,
    lightAttenuation: [0.45, 0.12, 0.06]
  },
  [SEABED_CLASS.CORAL]: {
    pbr: {
      baseColor:    [0.85, 0.55, 0.42],
      metalness:    0.00,
      roughness:    0.65,
      clearcoat:    0.10,
      transmission: 0.05,
      ior:          1.40,
      sheen:        0.20,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.88, 0.58, 0.46],
      quantizeSteps: 3,
      rimPower:     1.5,
      rimColor:     [1.00, 0.70, 0.55]
    },
    subsurfaceRadius: [0.30, 0.15, 0.10],
    emissive:         [0.02, 0.01, 0.00],
    foamCoverage:     0.10,
    causticsStrength: 0.90,
    lightAttenuation: [0.40, 0.10, 0.05]
  },
  [SEABED_CLASS.ROCK]: {
    pbr: {
      baseColor:    [0.35, 0.33, 0.30],
      metalness:    0.05,
      roughness:    0.60,
      clearcoat:    0.15,
      transmission: 0.00,
      ior:          1.50,
      sheen:        0.00,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.38, 0.36, 0.32],
      quantizeSteps: 3,
      rimPower:     1.8,
      rimColor:     [0.50, 0.75, 0.95]
    },
    subsurfaceRadius: [0.00, 0.00, 0.00],
    emissive:         [0.00, 0.00, 0.00],
    foamCoverage:     0.25,
    causticsStrength: 0.60,
    lightAttenuation: [0.50, 0.14, 0.07]
  },
  [SEABED_CLASS.KELP_FOREST]: {
    pbr: {
      baseColor:    [0.20, 0.32, 0.12],
      metalness:    0.00,
      roughness:    0.80,
      clearcoat:    0.05,
      transmission: 0.20,
      ior:          1.35,
      sheen:        0.30,
      anisotropy:   0.10
    },
    anime: {
      baseColor:    [0.22, 0.36, 0.14],
      quantizeSteps: 3,
      rimPower:     1.9,
      rimColor:     [0.45, 0.85, 0.55]
    },
    subsurfaceRadius: [0.15, 0.30, 0.10],
    emissive:         [0.00, 0.00, 0.00],
    foamCoverage:     0.05,
    causticsStrength: 0.55,
    lightAttenuation: [0.55, 0.20, 0.10]
  },
  [SEABED_CLASS.THERMAL_VENT]: {
    pbr: {
      baseColor:    [0.15, 0.10, 0.08],
      metalness:    0.40,
      roughness:    0.55,
      clearcoat:    0.20,
      transmission: 0.00,
      ior:          1.50,
      sheen:        0.00,
      anisotropy:   0.20
    },
    anime: {
      baseColor:    [0.20, 0.12, 0.10],
      quantizeSteps: 3,
      rimPower:     1.4,
      rimColor:     [1.00, 0.45, 0.10]
    },
    subsurfaceRadius: [0.05, 0.02, 0.01],
    emissive:         [0.80, 0.25, 0.05],
    foamCoverage:     0.30,
    causticsStrength: 0.20,
    lightAttenuation: [0.70, 0.25, 0.15]
  },
  [SEABED_CLASS.SEAGRASS]: {
    pbr: {
      baseColor:    [0.25, 0.42, 0.18],
      metalness:    0.00,
      roughness:    0.78,
      clearcoat:    0.05,
      transmission: 0.15,
      ior:          1.35,
      sheen:        0.25,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.28, 0.45, 0.20],
      quantizeSteps: 3,
      rimPower:     1.8,
      rimColor:     [0.50, 0.85, 0.50]
    },
    subsurfaceRadius: [0.10, 0.20, 0.08],
    emissive:         [0.00, 0.00, 0.00],
    foamCoverage:     0.05,
    causticsStrength: 0.65,
    lightAttenuation: [0.50, 0.18, 0.09]
  },
  [SEABED_CLASS.ICE]: {
    pbr: {
      baseColor:    [0.85, 0.90, 0.95],
      metalness:    0.00,
      roughness:    0.20,
      clearcoat:    0.60,
      transmission: 0.85,
      ior:          1.31,
      sheen:        0.00,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.88, 0.93, 0.98],
      quantizeSteps: 2,
      rimPower:     1.2,
      rimColor:     [0.75, 0.90, 1.00]
    },
    subsurfaceRadius: [0.20, 0.25, 0.35],
    emissive:         [0.02, 0.03, 0.05],
    foamCoverage:     0.00,
    causticsStrength: 0.40,
    lightAttenuation: [0.30, 0.08, 0.04]
  }
});

// ─── wavelength-specific light attenuation constants (Beer-Lambert) ─
// k_d (λ) — absorption coefficient in m⁻¹ at wavelength λ (nm).
// Realistic coastal values; deep ocean values are ~30% lower.
const LIGHT_ATTENUATION = Object.freeze({
  kd_red:    0.40,   // λ = 660 nm
  kd_green:  0.15,   // λ = 550 nm
  kd_blue:   0.045,  // λ = 470 nm
  kd_uv:     0.80,   // λ = 380 nm (UV absorbed quickly)
  kd_nir:    1.20,   // λ = 800 nm (NIR absorbed first)

  // Deep ocean vs coastal attenuation multipliers.
  deepOceanMultiplier:   0.7,
  coastalMultiplier:     1.3
});

// ─── thermocline parameters ─────────────────────────────────────
const THERMOCLINE = Object.freeze({
  mixedLayerDepth:     50.0,    // metres
  thermoclineDepth:    200.0,   // metres
  mixedLayerTemp:      20.0,    // °C
  deepTemp:            4.0,     // °C
  gradientWidth:       150.0    // metres
});

// ─── defaults ────────────────────────────────────────────────────
const BATHY_DEFAULTS = Object.freeze({
  worldSeed:             0xB47F1E23,
  cellSize:              16.0,          // metres per sampling cell
  chunkSize:             1000,
  maxCellsPerChunk:      512,           // 16×16 sampled cells per chunk
  maxChunksPerFrame:     8,
  shoreFoamDistance:     8.0,           // metres from shore where foam appears
  shallowReefDepth:      15.0,          // metres
  photicZoneDepth:       200.0,         // metres
  disphoticZoneDepth:    1000.0,        // metres
  temperatureSurface:    20.0,
  temperatureDeep:       2.0,
  salinityOcean:         35.0,          // ppt
  salinityFreshwater:    0.5,
  mutationThreshold:     0.5,
  mutationCoalesceWindow: 3.0
});

class BathymetryProvider {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.defaults = { ...BATHY_DEFAULTS, ...(options.defaults || {}) };
    this.attenuation = { ...LIGHT_ATTENUATION, ...(options.attenuation || {}) };
    this.thermocline = { ...THERMOCLINE, ...(options.thermocline || {}) };
    this.enableThermocline = options.enableThermocline ?? true;
    this.enableCaustics = options.enableCaustics ?? true;
    this.enableSubsurface = options.enableSubsurface ?? true;

    // ── scratch (pooled, never reallocated) ─────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVecD = new Vec3();
    this._tmpColor = new Vec3();
    this._tmpMatA = new Mat4();
    this._tmpSphere = new Sphere();
    this._tmpRay = new Ray();
    this._tmpPlane = new Plane();

    // ── per-chunk bathymetry cache (flat SoA) ───────────────
    const chunkCap = options.maxTrackedChunks ?? 256;
    this._chunkCap = chunkCap;
    this._chunkKeys = new Map();
    this._chunkSlot = 0;
    this._chunkUsed = 0;

    this._chunkCX = new Int32Array(chunkCap);
    this._chunkCZ = new Int32Array(chunkCap);
    this._chunkState = new Uint8Array(chunkCap);

    // Per-chunk summary.
    this._chunkAvgDepth = new Float32Array(chunkCap);
    this._chunkMaxDepth = new Float32Array(chunkCap);
    this._chunkWaterCoverage = new Float32Array(chunkCap);   // 0..1
    this._chunkDominantSeabed = new Uint8Array(chunkCap);
    this._chunkDominantZone = new Uint8Array(chunkCap);
    this._chunkReefSuitability = new Float32Array(chunkCap);
    this._chunkLifeSuitability = new Float32Array(chunkCap);
    this._chunkCausticsStrength = new Float32Array(chunkCap);
    this._chunkTempSurface = new Float32Array(chunkCap);
    this._chunkTempDeep = new Float32Array(chunkCap);
    this._chunkThermoclineDepth = new Float32Array(chunkCap);

    // Per-cell placements.
    const cellCap = this.defaults.maxCellsPerChunk;
    this._chunkCellCount = new Uint16Array(chunkCap);
    this._chunkCellX = new Array(chunkCap).fill(null);
    this._chunkCellY = new Array(chunkCap).fill(null);
    this._chunkCellZ = new Array(chunkCap).fill(null);
    this._chunkCellDepth = new Array(chunkCap).fill(null);
    this._chunkCellZone = new Array(chunkCap).fill(null);
    this._chunkCellSeabed = new Array(chunkCap).fill(null);
    this._chunkCellSlope = new Array(chunkCap).fill(null);
    this._chunkCellAspect = new Array(chunkCap).fill(null);
    this._chunkCellLightAtDepth = new Array(chunkCap).fill(null);   // [r,g,b] packed × 3
    this._chunkCellTemperature = new Array(chunkCap).fill(null);
    this._chunkCellCurrentX = new Array(chunkCap).fill(null);
    this._chunkCellCurrentZ = new Array(chunkCap).fill(null);
    this._chunkCellReefScore = new Array(chunkCap).fill(null);
    this._chunkCellLifeScore = new Array(chunkCap).fill(null);

    // Free lists.
    this._cellPool = {
      x: [], y: [], z: [], depth: [], zone: [], seabed: [],
      slope: [], aspect: [], lightAtDepth: [], temperature: [],
      currentX: [], currentZ: [], reefScore: [], lifeScore: []
    };

    // ── per-frame global water properties (physical layer) ─
    this._globalWater = {
      avgDepth: 0,
      maxDepth: 0,
      avgTemperature: 0,
      avgSalinity: 0,
      avgOxygen: 0,
      avgPh: 8.1,
      avgLightAtSurface: 1.0,
      avgLightAtDepth: 0,
      thermoclineDepth: 200,
      mixedLayerTemperature: 20,
      deepTemperature: 4,
      totalWaterArea: 0,
      deepWaterFraction: 0,
      reefCoverage: 0,
      kelpCoverage: 0,
      iceCoverage: 0
    };

    // ── shared reference to current frame ──────────────────
    this._frameRef = null;
    this._lastUpdateTime = -Infinity;

    // ── statistics ──────────────────────────────────────────
    this._stats = {
      updates: 0,
      chunksProcessed: 0,
      cellsSampled: 0,
      sandCells: 0,
      siltCells: 0,
      mudCells: 0,
      gravelCells: 0,
      coralCells: 0,
      rockCells: 0,
      kelpCells: 0,
      ventCells: 0,
      seagrassCells: 0,
      iceCells: 0,
      reefSuitableCells: 0,
      lifeSuitableCells: 0,
      deepWaterCells: 0,
      shallowWaterCells: 0,
      mutationEventsEmitted: 0
    };

    // ── collaborators ──────────────────────────────────────
    this._terrain = options.terrain || null;
    this._elevation = options.elevation || null;
    this._slope = options.slope || null;
    this._relief = options.relief || null;
    this._cliffs = options.cliffs || null;
    this._carve = options.carve || null;
    this._rocks = options.rocks || null;
    this._forest = options.forest || null;
    this._grass = options.grass || null;
    this._continental = options.continental || null;
    this._temporal = options.temporal || null;
    this._dispatcher = options.dispatcher || null;

    // ── material-facing output (reusable across frames) ────
    this._seabedMaterialParams = {
      pbr: {},
      anime: {},
      subsurfaceRadius: [0, 0, 0],
      emissive: [0, 0, 0],
      foamCoverage: 0,
      causticsStrength: 0
    };

    this._bandWeights = new Float32Array(SEABED_CLASS_NAMES.length);
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
  attachForest(f) { this._forest = f; return this; }
  attachGrass(g) { this._grass = g; return this; }
  attachContinental(c) { this._continental = c; return this; }
  attachTemporal(t) { this._temporal = t; return this; }
  attachDispatcher(d) { this._dispatcher = d; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── height lookup (delegation chain) ───────────────────
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
  // ─── depth, gradient, zone classification ──────────────
  // ══════════════════════════════════════════════════════════
  _getDepth(wx, wz, lod = 0) {
    const h = this._getHeight(wx, wz, lod);
    return Math.max(0, this._getSeaLevel() - h);
  }

  _getGradient(wx, wz, lod = 0) {
    const d = this.defaults.cellSize;
    const hL = this._getHeight(wx - d, wz, lod);
    const hR = this._getHeight(wx + d, wz, lod);
    const hD = this._getHeight(wx, wz - d, lod);
    const hU = this._getHeight(wx, wz + d, lod);

    const dhdx = (hR - hL) / (2 * d);
    const dhdz = (hU - hD) / (2 * d);
    const mag = Math.sqrt(dhdx * dhdx + dhdz * dhdz);
    const slope = Math.atan(mag);
    const aspect = Math.atan2(-dhdz, -dhdx);
    return { dhdx, dhdz, mag, slope, aspect };
  }

  _classifyZone(depth) {
    if (depth < 5) return BATHY_ZONE.SURFACE;
    if (depth < 20) return BATHY_ZONE.SHALLOW;
    if (depth < 100) return BATHY_ZONE.UPPER_SHELF;
    if (depth < 200) return BATHY_ZONE.MID_SHELF;
    if (depth < 500) return BATHY_ZONE.LOWER_SHELF;
    if (depth < 2000) return BATHY_ZONE.SLOPE;
    if (depth < 4000) return BATHY_ZONE.ABYSS;
    if (depth < 6000) return BATHY_ZONE.HADAL;
    return BATHY_ZONE.TRENCH;
  }

  // ══════════════════════════════════════════════════════════
  // ─── seabed material classification ─────────────────────
  // ══════════════════════════════════════════════════════════
  _classifySeabed(depth, slope, gradient, wx, wz, biomeHint) {
    // ── Base classification by depth and slope ──────────────
    // Deep water → mud / silt; shallow → sand; steep → rock.
    let base;
    if (slope > 45 * Math.PI / 180) {
      base = SEABED_CLASS.ROCK;
    } else if (depth > 2000) {
      base = SEABED_CLASS.MUD;
    } else if (depth > 500) {
      base = SEABED_CLASS.SILT;
    } else if (depth > 100) {
      base = SEABED_CLASS.SILT;
    } else if (depth > 20) {
      base = SEABED_CLASS.SAND;
    } else {
      base = SEABED_CLASS.SAND;
    }

    // ── Reef / kelp suitability overrides ───────────────────
    // Corals prefer warm shallow photic water with moderate slope.
    if (depth > 3 && depth < this.defaults.shallowReefDepth &&
        slope < 30 * Math.PI / 180) {
      // Check temperature — corals need > 18°C.
      const temp = this._estimateWaterTemp(depth);
      if (temp > 18 && biomeHint === BIOME_HINT.MARINE) {
        // Deterministic coral / non-coral from noise.
        const n = SimplexNoise.noise(wx * 1e-3, wz * 1e-3);
        if (n > 0.1) base = SEABED_CLASS.CORAL;
      }
    }

    // Kelp prefers cold temperate shallow water with rocky substrate.
    if (depth > 5 && depth < 30 && slope < 25 * Math.PI / 180) {
      const temp = this._estimateWaterTemp(depth);
      if (temp < 18 && biomeHint === BIOME_HINT.MARINE) {
        const n = SimplexNoise.noise(wx * 8e-4, wz * 8e-4);
        if (n > 0.2) base = SEABED_CLASS.KELP_FOREST;
      }
    }

    // Seagrass in protected shallow zones.
    if (depth > 1 && depth < 10 && slope < 12 * Math.PI / 180) {
      const n = SimplexNoise.noise(wx * 1.2e-3, wz * 1.2e-3);
      if (n > 0.4 && biomeHint === BIOME_HINT.FRESHWATER) {
        base = SEABED_CLASS.SEAGRASS;
      }
    }

    // Thermal vents in deep water at high-gradient spots.
    if (depth > 1000 && slope > 20 * Math.PI / 180) {
      const n = SimplexNoise.noise(wx * 2e-4, wz * 2e-4);
      if (n > 0.6) base = SEABED_CLASS.THERMAL_VENT;
    }

    // Ice where water temp is near freezing.
    if (depth > 0 && depth < 5) {
      const temp = this._estimateWaterTemp(depth);
      if (temp < 2) base = SEABED_CLASS.ICE;
    }

    return base;
  }

  // ══════════════════════════════════════════════════════════
  // ─── water temperature profile (thermocline) ────────────
  // ══════════════════════════════════════════════════════════
  _estimateWaterTemp(depth) {
    if (!this.enableThermocline) return this.defaults.temperatureSurface;

    const mixed = this.thermocline.mixedLayerDepth;
    const thermo = this.thermocline.thermoclineDepth;
    const mixedTemp = this.thermocline.mixedLayerTemp;
    const deepTemp = this.thermocline.deepTemp;

    if (depth <= mixed) return mixedTemp;
    if (depth >= thermo) return deepTemp;

    // Smooth transition through thermocline.
    const t = (depth - mixed) / (thermo - mixed);
    // S-curve through thermocline.
    return mixedTemp + (deepTemp - mixedTemp) * smoothstep(0, 1, t);
  }

  // ══════════════════════════════════════════════════════════
  // ─── light attenuation (Beer-Lambert) ──────────────────
  // ══════════════════════════════════════════════════════════
  // Returns attenuation for R, G, B at the given depth in metres.
  _computeLightAtDepth(depth, seabedClass) {
    const seabed = SEABED_MATERIAL[seabedClass] || SEABED_MATERIAL[SEABED_CLASS.SAND];
    const kd = seabed.lightAttenuation;

    // L(z) = exp(-k_d * z)
    const r = Math.exp(-kd[0] * depth);
    const g = Math.exp(-kd[1] * depth);
    const b = Math.exp(-kd[2] * depth);

    return [r, g, b];
  }

  // Approximate the light reaching depth from the surface, factoring
  // in sun altitude (clouds already attenuated by temporal provider).
  _effectiveLightAtDepth(depth, seabedClass) {
    const base = this._computeLightAtDepth(depth, seabedClass);
    const sunAlt = this._frameRef?.layers?.physical?.sunAltitude ?? 0.7;
    const sunI = Math.max(0, sunAlt);
    return [
      base[0] * sunI,
      base[1] * sunI,
      base[2] * sunI
    ];
  }

  // ══════════════════════════════════════════════════════════
  // ─── currents ───────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _computeCurrent(wx, wz, depth) {
    let dx = 0;
    let dz = 0;

    // Continental-scale current direction.
    if (this._continental) {
      const cellSize = this._continental.defaults?.continentalCellSize ?? 50000;
      const cx = Math.floor(wx / cellSize);
      const cz = Math.floor(wz / cellSize);
      // Approximate with the terrain gradient at continental scale.
      const w = this._continental.getElevationModifierAt(wx + 100000, wz)
              - this._continental.getElevationModifierAt(wx - 100000, wz);
      const h = this._continental.getElevationModifierAt(wx, wz + 100000)
              - this._continental.getElevationModifierAt(wx, wz - 100000);
      const mag = Math.sqrt(w * w + h * h);
      if (mag > 1e-6) {
        dx = -w / mag;
        dz = -h / mag;
      }
    }

    // Local slope-driven current: water flows downhill.
    const grad = this._getGradient(wx, wz);
    if (grad.mag > 1e-5) {
      dx += -grad.dhdx / grad.mag * 0.3;
      dz += -grad.dhdz / grad.mag * 0.3;
    }

    // Wind-driven surface currents (fade with depth).
    const wind = this._frameRef?.layers?.physical?.wind;
    if (wind && depth < 50) {
      const fade = 1 - depth / 50;
      dx += wind[0] * 0.05 * fade;
      dz += wind[2] * 0.05 * fade;
    }

    // Normalize.
    const mag = Math.sqrt(dx * dx + dz * dz);
    if (mag > 1e-6) {
      dx /= mag;
      dz /= mag;
    }

    // Current magnitude: strong in shallows, weak in abyss.
    const strength = depth < 100 ? 0.5 : (depth < 1000 ? 0.2 : 0.05);

    return { dx, dz, strength };
  }

  // ══════════════════════════════════════════════════════════
  // ─── reef / life suitability ────────────────────────────
  // ══════════════════════════════════════════════════════════
  _computeReefSuitability(depth, temp, light, slope) {
    // Reefs prefer warm, photic, moderately shallow water.
    if (depth < 2 || depth > 50) return 0;
    if (temp < 18 || temp > 32) return 0;
    if (slope > 40 * Math.PI / 180) return 0;

    const depthFactor = 1 - Math.abs(depth - 15) / 35;
    const tempFactor = 1 - Math.abs(temp - 26) / 10;
    const lightFactor = light[0] * 0.3 + light[1] * 0.4 + light[2] * 0.3;
    const slopeFactor = 1 - slope / (40 * Math.PI / 180);

    return Math.max(0, Math.min(1,
      depthFactor * 0.3 + tempFactor * 0.3 + lightFactor * 0.3 + slopeFactor * 0.1
    ));
  }

  _computeLifeSuitability(depth, temp, light, seabedClass) {
    // Broad life suitability — from photosynthetic to benthic.
    let score = 0;

    // Photic zone bonus.
    const lightSum = light[0] + light[1] + light[2];
    score += Math.min(1, lightSum / 3) * 0.3;

    // Temperature moderate bonus.
    if (temp > 5 && temp < 30) score += 0.3;
    else if (temp > 0 && temp < 35) score += 0.15;

    // Substrate bonus.
    if (seabedClass === SEABED_CLASS.CORAL ||
        seabedClass === SEABED_CLASS.KELP_FOREST ||
        seabedClass === SEABED_CLASS.SEAGRASS) score += 0.4;
    else if (seabedClass === SEABED_CLASS.SAND ||
             seabedClass === SEABED_CLASS.GRAVEL) score += 0.2;

    return Math.min(1, score);
  }

  // ══════════════════════════════════════════════════════════
  // ─── per-chunk sample ───────────────────────────────────
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

    let slot = this._getChunkSlot(cx, cz);
    if (slot < 0) slot = this._allocChunkSlot(cx, cz);

    // Clear chunk.
    this._chunkCellCount[slot] = 0;

    if (!this._chunkCellX[slot]) {
      this._chunkCellX[slot] = this._acquireCell('x');
      this._chunkCellY[slot] = this._acquireCell('y');
      this._chunkCellZ[slot] = this._acquireCell('z');
      this._chunkCellDepth[slot] = this._acquireCell('depth');
      this._chunkCellZone[slot] = this._acquireZoneArray();
      this._chunkCellSeabed[slot] = this._acquireZoneArray();
      this._chunkCellSlope[slot] = this._acquireCell('slope');
      this._chunkCellAspect[slot] = this._acquireCell('aspect');
      this._chunkCellLightAtDepth[slot] = this._acquireColorArray();
      this._chunkCellTemperature[slot] = this._acquireCell('temperature');
      this._chunkCellCurrentX[slot] = this._acquireCell('currentX');
      this._chunkCellCurrentZ[slot] = this._acquireCell('currentZ');
      this._chunkCellReefScore[slot] = this._acquireCell('reefScore');
      this._chunkCellLifeScore[slot] = this._acquireCell('lifeScore');
    }

    const cpx = this._chunkCellX[slot];
    const cpy = this._chunkCellY[slot];
    const cpz = this._chunkCellZ[slot];
    const cpd = this._chunkCellDepth[slot];
    const cpzone = this._chunkCellZone[slot];
    const cpseabed = this._chunkCellSeabed[slot];
    const cpslope = this._chunkCellSlope[slot];
    const cpaspect = this._chunkCellAspect[slot];
    const cplight = this._chunkCellLightAtDepth[slot];
    const cptemp = this._chunkCellTemperature[slot];
    const cpcurrentX = this._chunkCellCurrentX[slot];
    const cpcurrentZ = this._chunkCellCurrentZ[slot];
    const cpref = this._chunkCellReefScore[slot];
    const cplife = this._chunkCellLifeScore[slot];

    const maxCells = this.defaults.maxCellsPerChunk;
    let placed = 0;
    let waterCells = 0;
    let sumDepth = 0;
    let maxDepth = 0;
    let sumTemp = 0;
    let sumReef = 0;
    let sumLife = 0;
    const seabedCount = new Uint16Array(SEABED_CLASS_NAMES.length);
    const zoneCount = new Uint16Array(BATHY_ZONE_NAMES.length);

    for (let j = 0; j < cellsPerSide && placed < maxCells; j++) {
      for (let i = 0; i < cellsPerSide && placed < maxCells; i++) {
        const wx = cx * chunkSize + (i + 0.5) * cellSize;
        const wz = cz * chunkSize + (j + 0.5) * cellSize;

        const h = this._getHeight(wx, wz);
        const depth = Math.max(0, seaLevel - h);

        // Skip cells that are above water.
        if (depth < 0.05) continue;
        waterCells++;

        const grad = this._getGradient(wx, wz);
        const zone = this._classifyZone(depth);
        const seabed = this._classifySeabed(depth, grad.slope, grad, wx, wz, biomeHint);
        const temp = this._estimateWaterTemp(depth);
        const light = this._effectiveLightAtDepth(depth, seabed);
        const current = this._computeCurrent(wx, wz, depth);

        const reef = this._computeReefSuitability(depth, temp, light, grad.slope);
        const life = this._computeLifeSuitability(depth, temp, light, seabed);

        // Store.
        cpx[placed] = wx;
        cpy[placed] = h;
        cpz[placed] = wz;
        cpd[placed] = depth;
        cpzone[placed] = zone;
        cpseabed[placed] = seabed;
        cpslope[placed] = grad.slope;
        cpaspect[placed] = grad.aspect;
        const co = placed * 3;
        cplight[co] = light[0];
        cplight[co + 1] = light[1];
        cplight[co + 2] = light[2];
        cptemp[placed] = temp;
        cpcurrentX[placed] = current.dx;
        cpcurrentZ[placed] = current.dz;
        cpref[placed] = reef;
        cplife[placed] = life;
        placed++;

        sumDepth += depth;
        if (depth > maxDepth) maxDepth = depth;
        sumTemp += temp;
        sumReef += reef;
        sumLife += life;
        seabedCount[seabed]++;
        zoneCount[zone]++;

        // Stats.
        switch (seabed) {
          case SEABED_CLASS.SAND:         this._stats.sandCells++; break;
          case SEABED_CLASS.SILT:         this._stats.siltCells++; break;
          case SEABED_CLASS.MUD:          this._stats.mudCells++; break;
          case SEABED_CLASS.GRAVEL:       this._stats.gravelCells++; break;
          case SEABED_CLASS.CORAL:        this._stats.coralCells++; break;
          case SEABED_CLASS.ROCK:         this._stats.rockCells++; break;
          case SEABED_CLASS.KELP_FOREST:  this._stats.kelpCells++; break;
          case SEABED_CLASS.THERMAL_VENT: this._stats.ventCells++; break;
          case SEABED_CLASS.SEAGRASS:     this._stats.seagrassCells++; break;
          case SEABED_CLASS.ICE:          this._stats.iceCells++; break;
        }
        if (reef > 0.5) this._stats.reefSuitableCells++;
        if (life > 0.5) this._stats.lifeSuitableCells++;
        if (depth > 200) this._stats.deepWaterCells++;
        else this._stats.shallowWaterCells++;
        this._stats.cellsSampled++;
      }
    }

    this._chunkCellCount[slot] = placed;

    // Summary.
    const totalArea = chunkSize * chunkSize;
    const waterCoverage = placed * cellSize * cellSize / totalArea;

    let avgDepth = placed > 0 ? sumDepth / placed : 0;
    let avgTemp = placed > 0 ? sumTemp / placed : 0;
    let avgReef = placed > 0 ? sumReef / placed : 0;
    let avgLife = placed > 0 ? sumLife / placed : 0;

    // Dominant seabed and zone.
    let domSeabed = 0, maxSeabed = 0;
    for (let s = 0; s < seabedCount.length; s++) {
      if (seabedCount[s] > maxSeabed) { maxSeabed = seabedCount[s]; domSeabed = s; }
    }
    let domZone = 0, maxZone = 0;
    for (let z = 0; z < zoneCount.length; z++) {
      if (zoneCount[z] > maxZone) { maxZone = zoneCount[z]; domZone = z; }
    }

    this._chunkAvgDepth[slot] = avgDepth;
    this._chunkMaxDepth[slot] = maxDepth;
    this._chunkWaterCoverage[slot] = waterCoverage;
    this._chunkDominantSeabed[slot] = domSeabed;
    this._chunkDominantZone[slot] = domZone;
    this._chunkReefSuitability[slot] = avgReef;
    this._chunkLifeSuitability[slot] = avgLife;
    this._chunkCausticsStrength[slot] = placed > 0
      ? (SEABED_MATERIAL[domSeabed]?.causticsStrength ?? 0.5)
      : 0;
    this._chunkTempSurface[slot] = this.thermocline.mixedLayerTemp;
    this._chunkTempDeep[slot] = this.thermocline.deepTemp;
    this._chunkThermoclineDepth[slot] = this.thermocline.thermoclineDepth;

    this._stats.chunksProcessed++;
    return placed;
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
    this._chunkCellCount[slot] = 0;
    if (this._chunkCellX[slot]) {
      this._cellPool.x.push(this._chunkCellX[slot]);
      this._cellPool.y.push(this._chunkCellY[slot]);
      this._cellPool.z.push(this._chunkCellZ[slot]);
      this._cellPool.depth.push(this._chunkCellDepth[slot]);
      this._cellPool.slope.push(this._chunkCellSlope[slot]);
      this._cellPool.aspect.push(this._chunkCellAspect[slot]);
      this._cellPool.lightAtDepth.push(this._chunkCellLightAtDepth[slot]);
      this._cellPool.temperature.push(this._chunkCellTemperature[slot]);
      this._cellPool.currentX.push(this._chunkCellCurrentX[slot]);
      this._cellPool.currentZ.push(this._chunkCellCurrentZ[slot]);
      this._cellPool.reefScore.push(this._chunkCellReefScore[slot]);
      this._cellPool.lifeScore.push(this._chunkCellLifeScore[slot]);
    }
    this._chunkCellX[slot] = null;
    this._chunkCellY[slot] = null;
    this._chunkCellZ[slot] = null;
    this._chunkCellDepth[slot] = null;
    this._chunkCellZone[slot] = null;
    this._chunkCellSeabed[slot] = null;
    this._chunkCellSlope[slot] = null;
    this._chunkCellAspect[slot] = null;
    this._chunkCellLightAtDepth[slot] = null;
    this._chunkCellTemperature[slot] = null;
    this._chunkCellCurrentX[slot] = null;
    this._chunkCellCurrentZ[slot] = null;
    this._chunkCellReefScore[slot] = null;
    this._chunkCellLifeScore[slot] = null;
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

  _acquireCell(kind) {
    const pool = this._cellPool[kind];
    if (pool && pool.length > 0) {
      const arr = pool.pop();
      arr.fill(0);
      return arr;
    }
    return new Float32Array(this.defaults.maxCellsPerChunk);
  }

  _acquireZoneArray() {
    return new Uint8Array(this.defaults.maxCellsPerChunk);
  }

  _acquireColorArray() {
    return new Float32Array(this.defaults.maxCellsPerChunk * 3);
  }

  // ══════════════════════════════════════════════════════════
  // ─── public queries ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getWaterAt(wx, wz) {
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot < 0 || this._chunkState[slot] === 0) return null;

    return {
      cellCount: this._chunkCellCount[slot],
      avgDepth: this._chunkAvgDepth[slot],
      maxDepth: this._chunkMaxDepth[slot],
      waterCoverage: this._chunkWaterCoverage[slot],
      dominantSeabed: this._chunkDominantSeabed[slot],
      dominantSeabedName: SEABED_CLASS_NAMES[this._chunkDominantSeabed[slot]],
      dominantZone: this._chunkDominantZone[slot],
      dominantZoneName: BATHY_ZONE_NAMES[this._chunkDominantZone[slot]],
      reefSuitability: this._chunkReefSuitability[slot],
      lifeSuitability: this._chunkLifeSuitability[slot],
      causticsStrength: this._chunkCausticsStrength[slot],
      tempSurface: this._chunkTempSurface[slot],
      tempDeep: this._chunkTempDeep[slot],
      thermoclineDepth: this._chunkThermoclineDepth[slot],
      cells: {
        x: this._chunkCellX[slot],
        y: this._chunkCellY[slot],
        z: this._chunkCellZ[slot],
        depth: this._chunkCellDepth[slot],
        zone: this._chunkCellZone[slot],
        seabed: this._chunkCellSeabed[slot],
        slope: this._chunkCellSlope[slot],
        aspect: this._chunkCellAspect[slot],
        light: this._chunkCellLightAtDepth[slot],
        temperature: this._chunkCellTemperature[slot],
        currentX: this._chunkCellCurrentX[slot],
        currentZ: this._chunkCellCurrentZ[slot],
        reefScore: this._chunkCellReefScore[slot],
        lifeScore: this._chunkCellLifeScore[slot]
      }
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── material parameter dispatch for shaders ────────────
  // ══════════════════════════════════════════════════════════
  // Returns the live material parameter object for a seabed class.
  // The material system reads these and blends its PBR + anime
  // shader accordingly.
  getSeabedMaterialParams(seabedClass) {
    return SEABED_MATERIAL[seabedClass] || SEABED_MATERIAL[SEABED_CLASS.SAND];
  }

  // Computes blended material parameters based on depth, light, and
  // class. Returns a live object (mutated in-place, no allocation).
  blendSeabedMaterial(seabedClass, depth, lightScale, out) {
    const src = SEABED_MATERIAL[seabedClass] || SEABED_MATERIAL[SEABED_CLASS.SAND];
    const o = out || this._seabedMaterialParams;

    // ── PBR ───────────────────────────────────────────────
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

    // ── Anime ─────────────────────────────────────────────
    o.anime.baseColor[0] = src.anime.baseColor[0];
    o.anime.baseColor[1] = src.anime.baseColor[1];
    o.anime.baseColor[2] = src.anime.baseColor[2];
    o.anime.quantizeSteps = src.anime.quantizeSteps;
    o.anime.rimPower = src.anime.rimPower;
    o.anime.rimColor[0] = src.anime.rimColor[0];
    o.anime.rimColor[1] = src.anime.rimColor[1];
    o.anime.rimColor[2] = src.anime.rimColor[2];

    // ── Subsurface ────────────────────────────────────────
    o.subsurfaceRadius[0] = src.subsurfaceRadius[0];
    o.subsurfaceRadius[1] = src.subsurfaceRadius[1];
    o.subsurfaceRadius[2] = src.subsurfaceRadius[2];

    // ── Emissive ──────────────────────────────────────────
    o.emissive[0] = src.emissive[0] * lightScale;
    o.emissive[1] = src.emissive[1] * lightScale;
    o.emissive[2] = src.emissive[2] * lightScale;

    // ── Foam / caustics ───────────────────────────────────
    o.foamCoverage = src.foamCoverage;
    o.causticsStrength = this.enableCaustics
      ? src.causticsStrength * Math.max(0.1, 1 - depth / 100)
      : 0;

    return o;
  }

  // ══════════════════════════════════════════════════════════
  // ─── frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.bathymetry) {
      spatial.bathymetry = {
        chunkCount: 0,
        chunkCX: new Int32Array(this._chunkCap),
        chunkCZ: new Int32Array(this._chunkCap),
        chunkSlots: new Int32Array(this._chunkCap),
        avgDepth: this._chunkAvgDepth,
        maxDepth: this._chunkMaxDepth,
        waterCoverage: this._chunkWaterCoverage,
        dominantSeabed: this._chunkDominantSeabed,
        dominantZone: this._chunkDominantZone,
        reefSuitability: this._chunkReefSuitability,
        lifeSuitability: this._chunkLifeSuitability,
        causticsStrength: this._chunkCausticsStrength,
        tempSurface: this._chunkTempSurface,
        tempDeep: this._chunkTempDeep,
        thermoclineDepth: this._chunkThermoclineDepth,
        cells: {
          count: this._chunkCellCount,
          x: this._chunkCellX,
          y: this._chunkCellY,
          z: this._chunkCellZ,
          depth: this._chunkCellDepth,
          zone: this._chunkCellZone,
          seabed: this._chunkCellSeabed,
          slope: this._chunkCellSlope,
          aspect: this._chunkCellAspect,
          light: this._chunkCellLightAtDepth,
          temperature: this._chunkCellTemperature,
          currentX: this._chunkCellCurrentX,
          currentZ: this._chunkCellCurrentZ,
          reefScore: this._chunkCellReefScore,
          lifeScore: this._chunkCellLifeScore
        },
        materialParams: SEABED_MATERIAL,
        seabedClassNames: SEABED_CLASS_NAMES,
        zoneNames: BATHY_ZONE_NAMES
      };
    }

    const b = spatial.bathymetry;
    b.chunkCount = 0;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      if (b.chunkCount >= this._chunkCap) break;
      b.chunkCX[b.chunkCount] = this._chunkCX[i];
      b.chunkCZ[b.chunkCount] = this._chunkCZ[i];
      b.chunkSlots[b.chunkCount] = i;
      b.chunkCount++;
    }
  }

  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    // Aggregate global water properties across all tracked chunks.
    let sumDepth = 0;
    let maxDepth = 0;
    let sumTemp = 0;
    let sumCoverage = 0;
    let sumReef = 0;
    let sumLife = 0;
    let chunksWithWater = 0;
    let deepChunks = 0;
    let totalArea = 0;
    let reefArea = 0;
    let kelpArea = 0;
    let iceArea = 0;

    const chunkSize = this.defaults.chunkSize;
    const chunkArea = chunkSize * chunkSize;

    // Seabed class distribution.
    this._bandWeights.fill(0);

    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      if (this._chunkWaterCoverage[i] < 0.01) continue;

      sumDepth += this._chunkAvgDepth[i];
      if (this._chunkMaxDepth[i] > maxDepth) maxDepth = this._chunkMaxDepth[i];
      sumTemp += (this._chunkTempSurface[i] + this._chunkTempDeep[i]) * 0.5;
      sumCoverage += this._chunkWaterCoverage[i];
      sumReef += this._chunkReefSuitability[i];
      sumLife += this._chunkLifeSuitability[i];
      chunksWithWater++;
      if (this._chunkAvgDepth[i] > 200) deepChunks++;

      // Seabed weighting by water coverage.
      const count = this._chunkCellCount[i];
      const seabed = this._chunkCellSeabed[i];
      if (seabed) {
        for (let k = 0; k < count; k++) {
          this._bandWeights[seabed[k]]++;
        }
      }
      totalArea += chunkArea * this._chunkWaterCoverage[i];

      // Reef / kelp / ice area contribution.
      const reef = this._chunkReefSuitability[i];
      if (reef > 0.5) reefArea += chunkArea * reef;
      if (this._chunkDominantSeabed[i] === SEABED_CLASS.KELP_FOREST) {
        kelpArea += chunkArea;
      }
      if (this._chunkDominantSeabed[i] === SEABED_CLASS.ICE) {
        iceArea += chunkArea;
      }
    }

    const w = this._globalWater;
    w.avgDepth = chunksWithWater > 0 ? sumDepth / chunksWithWater : 0;
    w.maxDepth = maxDepth;
    w.avgTemperature = chunksWithWater > 0 ? sumTemp / chunksWithWater : 0;
    w.avgSalinity = this.defaults.salinityOcean;
    w.avgOxygen = Math.max(2, 8 - w.avgDepth * 0.001);   // mmol/L approx
    w.avgLightAtSurface = 1.0;
    w.avgLightAtDepth = Math.exp(-0.15 * w.avgDepth);
    w.thermoclineDepth = this.thermocline.thermoclineDepth;
    w.mixedLayerTemperature = this.thermocline.mixedLayerTemp;
    w.deepTemperature = this.thermocline.deepTemp;
    w.totalWaterArea = totalArea;
    w.deepWaterFraction = chunksWithWater > 0 ? deepChunks / chunksWithWater : 0;
    w.reefCoverage = totalArea > 0 ? reefArea / totalArea : 0;
    w.kelpCoverage = totalArea > 0 ? kelpArea / totalArea : 0;
    w.iceCoverage = totalArea > 0 ? iceArea / totalArea : 0;

    if (!physical.waterProperties) {
      physical.waterProperties = {};
    }
    Object.assign(physical.waterProperties, w);

    // Aggregate seabed class weights (normalized).
    let totalCells = 0;
    for (let k = 0; k < this._bandWeights.length; k++) totalCells += this._bandWeights[k];
    if (totalCells > 0) {
      for (let k = 0; k < this._bandWeights.length; k++) {
        this._bandWeights[k] /= totalCells;
      }
    }

    physical.seabedClassWeights = this._bandWeights;

    // Global average light reaching 20 m depth (for caustics).
    physical.underwaterLightAt20m = Math.exp(-0.15 * 20);
    physical.underwaterLightAt100m = Math.exp(-0.15 * 100);

    // Water surface temperature (for material shaders).
    physical.waterSurfaceTemperature = this.thermocline.mixedLayerTemp;
    physical.waterDeepTemperature = this.thermocline.deepTemp;
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

    // Update thermocline from temporal context if available.
    if (this._temporal) {
      const season = this._temporal.seasonScalar;
      // Thermocline deepens in summer, shoals in winter.
      this.thermocline.thermoclineDepth = 200 + season * 50;
      this.thermocline.mixedLayerTemp = 15 + season * 10;
    }

    const tc = frame.layers.spatial?.terrainChunks;
    if (!tc || tc.count === 0) {
      this._writeToSpatialLayer(frame);
      this._writeToPhysicalLayer(frame);
      this._stats.updates++;
      return 1;
    }

    const budget = Math.min(this.defaults.maxChunksPerFrame, tc.count);
    const seaLevel = this._getSeaLevel();

    for (let i = 0; i < budget; i++) {
      const cx = tc.cx[i];
      const cz = tc.cz[i];

      // Skip chunks whose maximum height is far above sea level
      // (no water present).
      if (tc.minY[i] > seaLevel + 20) continue;

      const slot = this._getChunkSlot(cx, cz);
      if (slot >= 0 && this._chunkCellCount[slot] > 0) continue;

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

  setThermocline(params) {
    for (const k of Object.keys(this.thermocline)) {
      if (params[k] !== undefined) this.thermocline[k] = params[k];
    }
    return this;
  }

  setAttenuation(params) {
    for (const k of Object.keys(this.attenuation)) {
      if (params[k] !== undefined) this.attenuation[k] = params[k];
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
  getGlobalWater() { return { ...this._globalWater }; }

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
    this._forest = null;
    this._grass = null;
    this._continental = null;
    this._temporal = null;
    this._dispatcher = null;
    this._frameRef = null;
    this._clearAllChunks();
    for (const key of Object.keys(this._cellPool)) {
      this._cellPool[key].length = 0;
    }
    this._bandWeights.fill(0);
  }
}

export {
  BathymetryProvider,
  BATHY_ZONE,
  BATHY_ZONE_NAMES,
  SEABED_CLASS,
  SEABED_CLASS_NAMES,
  SEABED_MATERIAL,
  LIGHT_ATTENUATION,
  THERMOCLINE,
  BATHY_DEFAULTS,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};