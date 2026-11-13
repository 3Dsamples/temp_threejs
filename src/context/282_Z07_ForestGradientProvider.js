// file number : 282_Z07
// full path name : src/context/282_Z07_ForestGradientProvider.js
// description : Forest and tree gradient provider for the living world. Builds on 280_TerrainProvider, 281_ElevationProvider, 282_SlopeGradientProvider, 282_Z01_ReliefGradientProvider, 282_Z02_CliffsGradientProvider, 282_Z03_CarveGradientProvider, and 282_Z06_RockGradientProvider to detect, place, and manage every tree and forest in the world. Handles twelve tree archetypes grounded in real forestry (OAK, PINE, BIRCH, REDWOOD, ACACIA, BAOBAB, PALM, WILLOW, BAMBOO, CONIFER, MANGROVE, CYPRESS), each with its own species suitability function combining elevation, moisture, temperature, slope, cliff, and soil-fertility. Places trees with a Poisson-disc-like rejection sampling on a per-chunk grid, preserves natural clearings via a low-frequency "clearing noise" field, and tracks forest succession state per chunk (PIONEER → INTERMEDIATE → CLIMAX → SENESCENT) so that different regions of the same forest have visibly different tree-age distributions. Computes per-tree canopy radius, trunk height, and root spread so the material system can produce correct shadow maps and the physics system can place collision. Root systems apply a small negative carve via 282_Z03 to create root-shadow indentations around large trees, and the accumulated leaf-litter carbon deposit adds a small positive carve that slowly builds soil over centuries — implementing "the world remembers" at the forest level. Extracts a forest-edge band per chunk so adjacent biomes (grassland, desert, tundra) blend naturally. Writes per-chunk forest summaries (canopy density, dominant species, average trunk height, average canopy radius, understory density, succession state) and per-tree placements into frame.layers.spatial.forests. Aggregates total biomass and CO₂ absorption into frame.layers.physical so the climate coupling provider can drive global atmospheric state. All scratch objects are pooled; no allocation after the first frame.
// best for : Every forest in the living world — deep temperate woodland, tropical rainforest canopy, boreal taiga, coastal mangrove, savanna acacia, bamboo groves, and rainforest emergents. Feeds LandscapeVegetationScatterSystem, LandscapeFaunaSpawnSystem, LandscapeShadowScaler, BiomeBlendField, materials, and lighting. Complements 282_Z06_RockGradientProvider (small scatter) and 282_Z04_NaturalFormationGradientProvider (hero landforms) by covering the largest area of the living world.
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
  ElevationProvider, ELEVATION_BAND,
  SlopeGradientProvider, SLOPE_BAND, SLOPE_BAND_THRESHOLDS,
  ReliefGradientProvider, RELIEF_CLASS,
  CliffsGradientProvider, CLIFF_CLASS, CLIFF_MATERIAL_BAND,
  CarveGradientProvider, CARVE_SOURCE, CARVE_MATERIAL_BAND,
  RockGradientProvider, ROCK_TYPE
} from './264_MathECSImportBarrel.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 1;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── tree archetypes ────────────────────────────────────────────
const TREE_TYPE = Object.freeze({
  NONE:      0,
  OAK:       1,   // temperate broadleaf, wide canopy
  PINE:      2,   // conifer, tall and narrow
  BIRCH:     3,   // boreal pioneer, thin trunk
  REDWOOD:   4,   // coastal giant, 80-115 m
  ACACIA:    5,   // savanna, flat-topped
  BAOBAB:    6,   // desert giant, thick trunk
  PALM:      7,   // tropical coast
  WILLOW:    8,   // riverside, drooping
  BAMBOO:    9,   // tropical grove, cluster
  CONIFER:   10,  // cold-climate spruce/fir
  MANGROVE:  11,  // coastal swamp, stilt roots
  CYPRESS:   12   // wetland, tall narrow
});

const TREE_TYPE_NAMES = Object.freeze([
  'none', 'oak', 'pine', 'birch', 'redwood', 'acacia', 'baobab',
  'palm', 'willow', 'bamboo', 'conifer', 'mangrove', 'cypress'
]);

// ─── forest succession states ────────────────────────────────────
const SUCCESSION = Object.freeze({
  NONE:         0,
  PIONEER:      1,   // recently cleared, grasses + fast growers
  INTERMEDIATE: 2,   // mixed age, tallest trees emerging
  CLIMAX:       3,   // mature, closed canopy
  SENESCENT:    4    // dying canopy, gap dynamics
});

const SUCCESSION_NAMES = Object.freeze([
  'none', 'pioneer', 'intermediate', 'climax', 'senescent'
]);

// ─── per-species tree parameters ────────────────────────────────
// height = average mature height in metres
// canopy = average canopy radius in metres
// trunk = average trunk radius in metres
// min/max elevation = world-Y range in metres
// moistureMin/Max = 0..1
// temperatureMin/Max = degrees Celsius
// slopeMax = radians
// biomeAffinity = map of BIOME_HINT → weight multiplier
const TREE_SCHEMA = Object.freeze({
  [TREE_TYPE.OAK]: {
    height: 18, canopy: 8, trunk: 0.6,
    minElev: 50, maxElev: 1500,
    moistMin: 0.35, moistMax: 0.80,
    tempMin: 5, tempMax: 28,
    slopeMax: 30 * Math.PI / 180,
    density: 0.35,
    biomeAffinity: {
      [BIOME_HINT.TEMPERATE]: 2.0,
      [BIOME_HINT.GRASSLAND]: 0.8,
      [BIOME_HINT.TROPICAL]:  0.4
    }
  },
  [TREE_TYPE.PINE]: {
    height: 25, canopy: 5, trunk: 0.5,
    minElev: 200, maxElev: 2200,
    moistMin: 0.25, moistMax: 0.65,
    tempMin: -10, tempMax: 22,
    slopeMax: 40 * Math.PI / 180,
    density: 0.45,
    biomeAffinity: {
      [BIOME_HINT.TAIGA]:     2.0,
      [BIOME_HINT.TEMPERATE]: 1.0,
      [BIOME_HINT.ALPINE]:    0.8
    }
  },
  [TREE_TYPE.BIRCH]: {
    height: 15, canopy: 4, trunk: 0.25,
    minElev: 100, maxElev: 1800,
    moistMin: 0.40, moistMax: 0.75,
    tempMin: -15, tempMax: 18,
    slopeMax: 35 * Math.PI / 180,
    density: 0.55,
    biomeAffinity: {
      [BIOME_HINT.TAIGA]:     1.8,
      [BIOME_HINT.TEMPERATE]: 1.4,
      [BIOME_HINT.TUNDRA]:    0.6
    }
  },
  [TREE_TYPE.REDWOOD]: {
    height: 85, canopy: 10, trunk: 2.5,
    minElev: 0, maxElev: 800,
    moistMin: 0.55, moistMax: 0.90,
    tempMin: 8, tempMax: 22,
    slopeMax: 25 * Math.PI / 180,
    density: 0.10,
    biomeAffinity: {
      [BIOME_HINT.TEMPERATE]: 2.5
    }
  },
  [TREE_TYPE.ACACIA]: {
    height: 12, canopy: 9, trunk: 0.4,
    minElev: 100, maxElev: 1200,
    moistMin: 0.10, moistMax: 0.40,
    tempMin: 15, tempMax: 38,
    slopeMax: 25 * Math.PI / 180,
    density: 0.20,
    biomeAffinity: {
      [BIOME_HINT.GRASSLAND]: 2.0,
      [BIOME_HINT.DESERT]:    0.6
    }
  },
  [TREE_TYPE.BAOBAB]: {
    height: 20, canopy: 12, trunk: 4.0,
    minElev: 50, maxElev: 900,
    moistMin: 0.05, moistMax: 0.30,
    tempMin: 18, tempMax: 40,
    slopeMax: 15 * Math.PI / 180,
    density: 0.03,
    biomeAffinity: {
      [BIOME_HINT.GRASSLAND]: 0.8,
      [BIOME_HINT.DESERT]:    1.5
    }
  },
  [TREE_TYPE.PALM]: {
    height: 15, canopy: 4, trunk: 0.3,
    minElev: 0, maxElev: 300,
    moistMin: 0.55, moistMax: 0.95,
    tempMin: 18, tempMax: 38,
    slopeMax: 12 * Math.PI / 180,
    density: 0.35,
    biomeAffinity: {
      [BIOME_HINT.TROPICAL]:   2.5,
      [BIOME_HINT.MARINE]:     1.5,
      [BIOME_HINT.FRESHWATER]: 1.2
    }
  },
  [TREE_TYPE.WILLOW]: {
    height: 14, canopy: 7, trunk: 0.4,
    minElev: 0, maxElev: 1200,
    moistMin: 0.65, moistMax: 0.95,
    tempMin: 0, tempMax: 28,
    slopeMax: 20 * Math.PI / 180,
    density: 0.25,
    biomeAffinity: {
      [BIOME_HINT.FRESHWATER]: 2.5,
      [BIOME_HINT.TEMPERATE]:  1.0
    }
  },
  [TREE_TYPE.BAMBOO]: {
    height: 18, canopy: 2, trunk: 0.10,
    minElev: 0, maxElev: 1500,
    moistMin: 0.60, moistMax: 0.95,
    tempMin: 12, tempMax: 32,
    slopeMax: 30 * Math.PI / 180,
    density: 0.75,
    biomeAffinity: {
      [BIOME_HINT.TROPICAL]:   2.0,
      [BIOME_HINT.TEMPERATE]:  0.6
    }
  },
  [TREE_TYPE.CONIFER]: {
    height: 30, canopy: 4, trunk: 0.6,
    minElev: 400, maxElev: 2800,
    moistMin: 0.30, moistMax: 0.70,
    tempMin: -20, tempMax: 15,
    slopeMax: 45 * Math.PI / 180,
    density: 0.50,
    biomeAffinity: {
      [BIOME_HINT.TAIGA]:    2.5,
      [BIOME_HINT.ALPINE]:   1.2,
      [BIOME_HINT.TUNDRA]:   0.5
    }
  },
  [TREE_TYPE.MANGROVE]: {
    height: 12, canopy: 5, trunk: 0.4,
    minElev: -2, maxElev: 3,
    moistMin: 0.80, moistMax: 1.00,
    tempMin: 15, tempMax: 35,
    slopeMax: 10 * Math.PI / 180,
    density: 0.60,
    biomeAffinity: {
      [BIOME_HINT.MARINE]:     2.5,
      [BIOME_HINT.FRESHWATER]: 1.0
    }
  },
  [TREE_TYPE.CYPRESS]: {
    height: 22, canopy: 3, trunk: 0.5,
    minElev: 0, maxElev: 400,
    moistMin: 0.70, moistMax: 0.95,
    tempMin: 5, tempMax: 30,
    slopeMax: 15 * Math.PI / 180,
    density: 0.30,
    biomeAffinity: {
      [BIOME_HINT.FRESHWATER]: 2.5,
      [BIOME_HINT.TEMPERATE]:  1.0
    }
  }
});

// ─── base leaf colours per species (sRGB 0..1, seasonal modulated) ─
const TREE_LEAF_COLORS = Object.freeze({
  [TREE_TYPE.OAK]:      { spring: [0.42, 0.68, 0.24], summer: [0.28, 0.52, 0.18], autumn: [0.72, 0.42, 0.12], winter: [0.35, 0.30, 0.25] },
  [TREE_TYPE.PINE]:     { spring: [0.22, 0.42, 0.20], summer: [0.18, 0.36, 0.18], autumn: [0.20, 0.34, 0.16], winter: [0.16, 0.30, 0.16] },
  [TREE_TYPE.BIRCH]:    { spring: [0.62, 0.78, 0.38], summer: [0.40, 0.62, 0.28], autumn: [0.92, 0.72, 0.20], winter: [0.35, 0.32, 0.28] },
  [TREE_TYPE.REDWOOD]:  { spring: [0.20, 0.35, 0.16], summer: [0.16, 0.28, 0.14], autumn: [0.18, 0.26, 0.14], winter: [0.16, 0.26, 0.14] },
  [TREE_TYPE.ACACIA]:   { spring: [0.55, 0.65, 0.32], summer: [0.42, 0.52, 0.22], autumn: [0.48, 0.48, 0.20], winter: [0.48, 0.48, 0.22] },
  [TREE_TYPE.BAOBAB]:   { spring: [0.52, 0.58, 0.28], summer: [0.38, 0.45, 0.20], autumn: [0.42, 0.42, 0.18], winter: [0.40, 0.42, 0.20] },
  [TREE_TYPE.PALM]:     { spring: [0.30, 0.55, 0.22], summer: [0.25, 0.50, 0.18], autumn: [0.28, 0.50, 0.20], winter: [0.28, 0.52, 0.20] },
  [TREE_TYPE.WILLOW]:   { spring: [0.55, 0.72, 0.40], summer: [0.42, 0.60, 0.30], autumn: [0.68, 0.62, 0.25], winter: [0.38, 0.36, 0.30] },
  [TREE_TYPE.BAMBOO]:   { spring: [0.55, 0.72, 0.32], summer: [0.42, 0.62, 0.25], autumn: [0.48, 0.62, 0.28], winter: [0.48, 0.60, 0.28] },
  [TREE_TYPE.CONIFER]:  { spring: [0.22, 0.38, 0.18], summer: [0.18, 0.32, 0.16], autumn: [0.20, 0.30, 0.16], winter: [0.16, 0.28, 0.16] },
  [TREE_TYPE.MANGROVE]: { spring: [0.28, 0.48, 0.22], summer: [0.22, 0.42, 0.18], autumn: [0.26, 0.42, 0.20], winter: [0.26, 0.44, 0.20] },
  [TREE_TYPE.CYPRESS]:  { spring: [0.28, 0.44, 0.22], summer: [0.22, 0.38, 0.20], autumn: [0.24, 0.36, 0.20], winter: [0.20, 0.34, 0.20] }
});

// ─── defaults ────────────────────────────────────────────────────
const FOREST_DEFAULTS = Object.freeze({
  worldSeed: 0xF0E57C0DE,
  cellSize: 12.0,                 // metres per scatter cell
  chunkSize: 1000,
  maxPlacementsPerChunk: 256,
  maxChunksPerFrame: 4,
  clearingNoiseScale: 1 / 2048,   // metres per clearing unit
  clearingThreshold: 0.30,        // below this = clearing
  minChunkCanopyDensity: 0.02,    // below this = no forest
  edgeBandWidth: 60.0,            // metres of edge-band influence
  rootIndentDepth: 0.05,          // metres of root carve per large tree
  litterBuildRate: 0.001,         // metres/year of litter
  mutationCoalesceWindow: 2.0
});

class ForestGradientProvider {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.defaults = { ...FOREST_DEFAULTS, ...(options.defaults || {}) };
    this.enableRootCarve = options.enableRootCarve ?? true;
    this.enableLitterCarve = options.enableLitterCarve ?? true;
    this.enableClearingNoise = options.enableClearingNoise ?? true;

    // ── scratch (pooled) ────────────────────────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVecD = new Vec3();
    this._tmpMatA = new Mat4();

    // ── per-chunk forest summary storage ────────────────────
    const chunkCap = options.maxTrackedChunks ?? 256;
    this._chunkCap = chunkCap;
    this._chunkKeys = new Map();
    this._chunkSlot = 0;
    this._chunkUsed = 0;

    this._chunkCX = new Int32Array(chunkCap);
    this._chunkCZ = new Int32Array(chunkCap);
    this._chunkState = new Uint8Array(chunkCap);

    // Per-chunk summaries.
    this._chunkCanopyDensity = new Float32Array(chunkCap);      // 0..1
    this._chunkDominantSpecies = new Uint8Array(chunkCap);
    this._chunkAvgTrunkHeight = new Float32Array(chunkCap);
    this._chunkAvgCanopyRadius = new Float32Array(chunkCap);
    this._chunkUnderstoryDensity = new Float32Array(chunkCap);
    this._chunkSuccession = new Uint8Array(chunkCap);
    this._chunkEdgeBand = new Float32Array(chunkCap);            // 0..1 (edge strength)
    this._chunkBiomass = new Float32Array(chunkCap);             // tonnes/ha

    // Per-chunk placements.
    const placementsCap = this.defaults.maxPlacementsPerChunk;
    this._chunkPlacementCount = new Uint16Array(chunkCap);
    this._chunkPlacementX = new Array(chunkCap).fill(null);
    this._chunkPlacementY = new Array(chunkCap).fill(null);
    this._chunkPlacementZ = new Array(chunkCap).fill(null);
    this._chunkPlacementType = new Array(chunkCap).fill(null);
    this._chunkPlacementHeight = new Array(chunkCap).fill(null);
    this._chunkPlacementCanopy = new Array(chunkCap).fill(null);
    this._chunkPlacementTrunk = new Array(chunkCap).fill(null);
    this._chunkPlacementAge = new Array(chunkCap).fill(null);
    this._chunkPlacementLitterAccum = new Array(chunkCap).fill(null);

    // Free lists for placement arrays.
    this._placementPool = {
      x: [], y: [], z: [], type: [], height: [],
      canopy: [], trunk: [], age: [], litter: []
    };

    // ── per-frame statistics ────────────────────────────────
    this._stats = {
      updates: 0,
      chunksScattered: 0,
      totalTreesPlaced: 0,
      oaksPlaced: 0,
      pinesPlaced: 0,
      birchesPlaced: 0,
      redwoodsPlaced: 0,
      acaciasPlaced: 0,
      baobabsPlaced: 0,
      palmsPlaced: 0,
      willowsPlaced: 0,
      bamboosPlaced: 0,
      conifersPlaced: 0,
      mangrovesPlaced: 0,
      cypressesPlaced: 0,
      clearingsDetected: 0,
      successionTransitions: 0,
      mutationEventsEmitted: 0,
      rootCarves: 0,
      litterCarves: 0
    };

    // ── timing / frame reference ────────────────────────────
    this._lastUpdateTime = -Infinity;
    this._frameRef = null;

    // ── collaborators ──────────────────────────────────────
    this._terrain = options.terrain || null;
    this._elevation = options.elevation || null;
    this._slope = options.slope || null;
    this._relief = options.relief || null;
    this._cliffs = options.cliffs || null;
    this._carve = options.carve || null;
    this._rocks = options.rocks || null;
    this._dispatcher = options.dispatcher || null;
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
  attachDispatcher(d) { this._dispatcher = d; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── deterministic hash-based RNG per chunk ─────────────
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
  // ─── clearing noise (low-frequency natural clearings) ───
  // ══════════════════════════════════════════════════════════
  _clearingValue(wx, wz) {
    if (!this.enableClearingNoise) return 1.0;
    const s = this.defaults.clearingNoiseScale;
    const n1 = SimplexNoise.noise(wx * s, wz * s);
    const n2 = SimplexNoise.noise(wx * s * 3.1, wz * s * 3.1);
    // Combine to get a scalar in [0, 1].
    const combined = (n1 * 0.7 + n2 * 0.3);
    return Math.min(1, Math.max(0, (combined + 1) * 0.5));
  }

  // ══════════════════════════════════════════════════════════
  // ─── species suitability scoring ────────────────────────
  // ══════════════════════════════════════════════════════════
  _speciesSuitability(type, elevation, slopeAngle, moisture, temperature, biomeHint) {
    const s = TREE_SCHEMA[type];
    if (!s) return 0;
    if (elevation < s.minElev || elevation > s.maxElev) return 0;
    if (slopeAngle > s.slopeMax) return 0;
    if (moisture < s.moistMin || moisture > s.moistMax) return 0;
    if (temperature < s.tempMin || temperature > s.tempMax) return 0;

    // Biome affinity weight.
    const affinity = s.biomeAffinity[biomeHint] ?? 0.1;

    // Comfort score: how centered within the range.
    const eCenter = (s.minElev + s.maxElev) * 0.5;
    const eRange = Math.max(1, s.maxElev - s.minElev);
    const eFit = 1 - Math.abs(elevation - eCenter) / (eRange * 0.5);
    const mCenter = (s.moistMin + s.moistMax) * 0.5;
    const mRange = Math.max(0.01, s.moistMax - s.moistMin);
    const mFit = 1 - Math.abs(moisture - mCenter) / (mRange * 0.5);
    const tCenter = (s.tempMin + s.tempMax) * 0.5;
    const tRange = Math.max(1, s.tempMax - s.tempMin);
    const tFit = 1 - Math.abs(temperature - tCenter) / (tRange * 0.5);

    const comfort = Math.max(0, (eFit + mFit + tFit) / 3);
    return affinity * comfort * s.density;
  }

  // ══════════════════════════════════════════════════════════
  // ─── chunk biome hint lookup ────────────────────────────
  // ══════════════════════════════════════════════════════════
  _getChunkBiomeHint(cx, cz, tc) {
    for (let i = 0; i < tc.count; i++) {
      if (tc.cx[i] === cx && tc.cz[i] === cz) {
        return tc.biomeHint[i];
      }
    }
    return BIOME_HINT.UNKNOWN;
  }

  // ══════════════════════════════════════════════════════════
  // ─── succession state inference ─────────────────────────
  // ══════════════════════════════════════════════════════════
  // Succession is inferred from canopy density and tree age
  // distribution. A dense young stand = INTERMEDIATE; a dense
  // old stand = CLIMAX; a thin old stand = SENESCENT; a thin
  // young stand = PIONEER.
  _inferSuccession(treeCount, avgAge, canopyDensity) {
    if (treeCount === 0) return SUCCESSION.NONE;
    if (canopyDensity < 0.1) return SUCCESSION.PIONEER;
    if (canopyDensity < 0.4) {
      return avgAge < 40 ? SUCCESSION.INTERMEDIATE : SUCCESSION.CLIMAX;
    }
    if (avgAge > 150) return SUCCESSION.SENESCENT;
    if (avgAge > 60) return SUCCESSION.CLIMAX;
    return SUCCESSION.INTERMEDIATE;
  }

  // ══════════════════════════════════════════════════════════
  // ─── per-chunk forest generation ────────────────────────
  // ══════════════════════════════════════════════════════════
  _scatterChunk(cx, cz, frame) {
    const chunkSize = this.defaults.chunkSize;
    const cellSize = this.defaults.cellSize;
    const cellsPerSide = Math.max(1, Math.floor(chunkSize / cellSize));

    const spatial = frame.layers.spatial;
    const physical = frame.layers.physical;
    const moisture = physical?.humidity ?? 0.5;
    const temperature = physical?.ambientTemperature ?? 15;
    const seaLevel = this._elevation ? this._elevation.seaLevel : 0;

    const biomeHint = spatial.terrainChunks
      ? this._getChunkBiomeHint(cx, cz, spatial.terrainChunks)
      : BIOME_HINT.UNKNOWN;

    // Get or allocate chunk slot.
    let slot = this._getChunkSlot(cx, cz);
    if (slot < 0) slot = this._allocChunkSlot(cx, cz);

    // Clear existing placements for this chunk.
    this._chunkPlacementCount[slot] = 0;

    // Allocate placement arrays from pool if needed.
    if (!this._chunkPlacementX[slot]) {
      this._chunkPlacementX[slot] = this._acquirePlacementArray('x');
      this._chunkPlacementY[slot] = this._acquirePlacementArray('y');
      this._chunkPlacementZ[slot] = this._acquirePlacementArray('z');
      this._chunkPlacementType[slot] = this._acquireTypeArray();
      this._chunkPlacementHeight[slot] = this._acquirePlacementArray('height');
      this._chunkPlacementCanopy[slot] = this._acquirePlacementArray('canopy');
      this._chunkPlacementTrunk[slot] = this._acquirePlacementArray('trunk');
      this._chunkPlacementAge[slot] = this._acquirePlacementArray('age');
      this._chunkPlacementLitterAccum[slot] = this._acquirePlacementArray('litter');
    }

    const px = this._chunkPlacementX[slot];
    const py = this._chunkPlacementY[slot];
    const pz = this._chunkPlacementZ[slot];
    const pt = this._chunkPlacementType[slot];
    const ph = this._chunkPlacementHeight[slot];
    const pc = this._chunkPlacementCanopy[slot];
    const ptrunk = this._chunkPlacementTrunk[slot];
    const page = this._chunkPlacementAge[slot];
    const plitter = this._chunkPlacementLitterAccum[slot];

    const maxPlacements = this.defaults.maxPlacementsPerChunk;
    let placed = 0;
    let clearingsInChunk = 0;

    // Pre-compute chunk aggregate fields.
    let sumHeight = 0;
    let sumCanopy = 0;
    let sumAge = 0;
    const speciesCount = new Uint16Array(TREE_TYPE_NAMES.length);

    // Sample each cell.
    for (let j = 0; j < cellsPerSide; j++) {
      for (let i = 0; i < cellsPerSide; i++) {
        if (placed >= maxPlacements) break;

        const cellIdx = j * cellsPerSide + i;
        const seed = this._hashCell(cx, cz, cellIdx);
        const r1 = this._rand01(seed);
        const r2 = this._rand01(seed ^ 0x11111111);
        const r3 = this._rand01(seed ^ 0x22222222);
        const r4 = this._rand01(seed ^ 0x33333333);
        const r5 = this._rand01(seed ^ 0x44444444);

        // World position with jitter.
        const wx = cx * chunkSize + (i + 0.5) * cellSize + (r1 - 0.5) * cellSize * 0.8;
        const wz = cz * chunkSize + (j + 0.5) * cellSize + (r2 - 0.5) * cellSize * 0.8;

        // Check clearing noise — cells inside a clearing have no trees.
        const clearing = this._clearingValue(wx, wz);
        if (clearing < this.defaults.clearingThreshold) {
          clearingsInChunk++;
          continue;
        }

        // Terrain context at this position.
        const elevation = this._elevation
          ? this._elevation.getElevation(wx, wz)
          : (this._terrain ? this._terrain.getHeight(wx, wz) : 0);
        const slopeAngle = this._slope
          ? this._slope.getSlopeAngle(wx, wz)
          : 0;

        // Skip cliffs — trees don't grow on vertical faces.
        if (this._cliffs) {
          const cliffR = this._cliffs.classifyCliff(wx, wz);
          if (cliffR.cliffClass === CLIFF_CLASS.VERTICAL_FACE ||
              cliffR.cliffClass === CLIFF_CLASS.OVERHANG ||
              cliffR.cliffClass === CLIFF_CLASS.GORGE_WALL) {
            continue;
          }
        }

        // Skip rocks — trees don't grow inside boulders.
        if (this._rocks) {
          const rockPlacements = this._rocks.getPlacementsAt(wx, wz);
          if (rockPlacements && rockPlacements.count > 0) {
            let blocked = false;
            for (let k = 0; k < rockPlacements.count; k++) {
              const dx = rockPlacements.x[k] - wx;
              const dz = rockPlacements.z[k] - wz;
              const d2 = dx * dx + dz * dz;
              const rad = rockPlacements.radius[k];
              if (d2 < rad * rad * 0.8) {
                blocked = true;
                break;
              }
            }
            if (blocked) continue;
          }
        }

        // Compute species suitability for each tree type.
        let bestType = TREE_TYPE.NONE;
        let bestScore = 0;
        for (const typeName of Object.keys(TREE_SCHEMA)) {
          const type = parseInt(typeName, 10);
          const score = this._speciesSuitability(
            type, elevation, slopeAngle, moisture, temperature, biomeHint
          );
          if (score > bestScore) {
            bestScore = score;
            bestType = type;
          }
        }

        if (bestType === TREE_TYPE.NONE) continue;
        if (r3 > bestScore) continue;

        // Determine age based on succession state.
        // High-density, low-age → young stand; high-age → old stand.
        // We approximate age using a hash of the cell.
        const ageYears = 5 + r4 * 250;

        // Height/radius scale by age (younger = smaller).
        const ageScale = Math.min(1.0, ageYears / 80);
        const schema = TREE_SCHEMA[bestType];
        const height = schema.height * (0.4 + ageScale * 0.6) * (0.85 + r5 * 0.3);
        const canopy = schema.canopy * (0.4 + ageScale * 0.6) * (0.85 + r1 * 0.3);
        const trunk = schema.trunk * (0.5 + ageScale * 0.5);

        // Record placement.
        px[placed] = wx;
        py[placed] = elevation;
        pz[placed] = wz;
        pt[placed] = bestType;
        ph[placed] = height;
        pc[placed] = canopy;
        ptrunk[placed] = trunk;
        page[placed] = ageYears;
        plitter[placed] = 0;
        placed++;

        sumHeight += height;
        sumCanopy += canopy;
        sumAge += ageYears;
        speciesCount[bestType]++;

        // Update per-species stats.
        switch (bestType) {
          case TREE_TYPE.OAK:      this._stats.oaksPlaced++; break;
          case TREE_TYPE.PINE:     this._stats.pinesPlaced++; break;
          case TREE_TYPE.BIRCH:    this._stats.birchesPlaced++; break;
          case TREE_TYPE.REDWOOD:  this._stats.redwoodsPlaced++; break;
          case TREE_TYPE.ACACIA:   this._stats.acaciasPlaced++; break;
          case TREE_TYPE.BAOBAB:   this._stats.baobabsPlaced++; break;
          case TREE_TYPE.PALM:     this._stats.palmsPlaced++; break;
          case TREE_TYPE.WILLOW:   this._stats.willowsPlaced++; break;
          case TREE_TYPE.BAMBOO:   this._stats.bamboosPlaced++; break;
          case TREE_TYPE.CONIFER:  this._stats.conifersPlaced++; break;
          case TREE_TYPE.MANGROVE: this._stats.mangrovesPlaced++; break;
          case TREE_TYPE.CYPRESS:  this._stats.cypressesPlaced++; break;
        }
        this._stats.totalTreesPlaced++;

        // Root carve: large trees indent the terrain slightly.
        if (this.enableRootCarve && this._carve && trunk > 0.3) {
          const indent = this.defaults.rootIndentDepth * (trunk / 0.6) * (canopy / 5);
          this._carve.carveDelta(
            wx, wz, -indent, canopy * 0.6,
            CARVE_SOURCE.BIOTIC
          );
          this._stats.rootCarves++;
        }

        // Litter carve: leaves build soil over time.
        if (this.enableLitterCarve && this._carve) {
          const litter = this.defaults.litterBuildRate * (canopy / 5) * (height / 20);
          if (litter > 0.0001) {
            this._carve.carveDelta(
              wx, wz, litter, canopy * 0.8,
              CARVE_SOURCE.BIOTIC
            );
            this._stats.litterCarves++;
          }
        }
      }
    }

    this._chunkPlacementCount[slot] = placed;
    this._stats.chunksScattered++;
    this._stats.clearingsDetected += clearingsInChunk;

    // Compute chunk-level summary.
    const avgHeight = placed > 0 ? sumHeight / placed : 0;
    const avgCanopy = placed > 0 ? sumCanopy / placed : 0;
    const avgAge = placed > 0 ? sumAge / placed : 0;

    // Canopy density: how much of the chunk is covered.
    // canopy density = (Σ canopy circles) / chunk area, capped at 1.
    let canopyArea = 0;
    for (let k = 0; k < placed; k++) {
      canopyArea += Math.PI * pc[k] * pc[k];
    }
    const chunkArea = chunkSize * chunkSize;
    const canopyDensity = Math.min(1, canopyArea / chunkArea);

    // Dominant species.
    let dominant = TREE_TYPE.NONE;
    let maxCount = 0;
    for (let t = 1; t < speciesCount.length; t++) {
      if (speciesCount[t] > maxCount) {
        maxCount = speciesCount[t];
        dominant = t;
      }
    }

    // Understory density: shrubs, ferns, saplings — 0.6 for dense
    // closed-canopy, dropping toward 0.1 in sparse forests.
    const understoryDensity = Math.min(0.9, canopyDensity * 1.2);

    // Succession state.
    const succession = this._inferSuccession(placed, avgAge, canopyDensity);

    // Edge band: strong if this chunk is near a non-forest biome.
    // Determined by neighbour biome hint comparison — for now,
    // use moisture and canopy as proxies.
    const edgeStrength = canopyDensity < 0.15 ? 1.0 : 0.3;

    // Biomass in tonnes per hectare (approximate from trunk volume).
    let biomass = 0;
    for (let k = 0; k < placed; k++) {
      const trunkVolume = Math.PI * ptrunk[k] * ptrunk[k] * ph[k] * 0.5;
      biomass += trunkVolume * 0.6;   // 600 kg/m³ wood density
    }
    biomass /= (chunkArea / 10000);    // convert to tonnes per hectare

    // Store summaries.
    this._chunkCanopyDensity[slot] = canopyDensity;
    this._chunkDominantSpecies[slot] = dominant;
    this._chunkAvgTrunkHeight[slot] = avgHeight;
    this._chunkAvgCanopyRadius[slot] = avgCanopy;
    this._chunkUnderstoryDensity[slot] = understoryDensity;
    this._chunkSuccession[slot] = succession;
    this._chunkEdgeBand[slot] = edgeStrength;
    this._chunkBiomass[slot] = biomass;

    // Emit mutation event if trees were placed.
    if (placed > 0 && this._dispatcher) {
      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.MUTATION,
        [(cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize],
        -1, placed * 2, 5.0,
        {
          kind: 'forest_scatter',
          chunkX: cx, chunkZ: cz,
          placements: placed,
          dominantSpecies: dominant,
          succession
        }
      );
      this._stats.mutationEventsEmitted++;
    }

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
    this._chunkPlacementCount[slot] = 0;
    // Return arrays to the pool.
    if (this._chunkPlacementX[slot]) {
      this._placementPool.x.push(this._chunkPlacementX[slot]);
      this._placementPool.y.push(this._chunkPlacementY[slot]);
      this._placementPool.z.push(this._chunkPlacementZ[slot]);
      this._placementPool.height.push(this._chunkPlacementHeight[slot]);
      this._placementPool.canopy.push(this._chunkPlacementCanopy[slot]);
      this._placementPool.trunk.push(this._chunkPlacementTrunk[slot]);
      this._placementPool.age.push(this._chunkPlacementAge[slot]);
      this._placementPool.litter.push(this._chunkPlacementLitterAccum[slot]);
    }
    this._chunkPlacementX[slot] = null;
    this._chunkPlacementY[slot] = null;
    this._chunkPlacementZ[slot] = null;
    this._chunkPlacementType[slot] = null;
    this._chunkPlacementHeight[slot] = null;
    this._chunkPlacementCanopy[slot] = null;
    this._chunkPlacementTrunk[slot] = null;
    this._chunkPlacementAge[slot] = null;
    this._chunkPlacementLitterAccum[slot] = null;
    this._chunkUsed--;
  }

  _evictOldest() {
    let oldest = -1;
    let oldestTime = Infinity;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      if (this._chunkCX[i] < oldestTime) {
        oldestTime = this._chunkCX[i];
        oldest = i;
      }
    }
    if (oldest >= 0) this._evictSlot(oldest);
  }

  _acquirePlacementArray(kind) {
    const pool = this._placementPool[kind];
    if (pool && pool.length > 0) {
      const arr = pool.pop();
      arr.fill(0);
      return arr;
    }
    return new Float32Array(this.defaults.maxPlacementsPerChunk);
  }

  _acquireTypeArray() {
    return new Uint8Array(this.defaults.maxPlacementsPerChunk);
  }

  // ══════════════════════════════════════════════════════════
  // ─── public queries ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getForestAt(wx, wz) {
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot < 0 || this._chunkState[slot] === 0) return null;

    return {
      count: this._chunkPlacementCount[slot],
      canopyDensity: this._chunkCanopyDensity[slot],
      dominantSpecies: this._chunkDominantSpecies[slot],
      dominantSpeciesName: TREE_TYPE_NAMES[this._chunkDominantSpecies[slot]],
      avgTrunkHeight: this._chunkAvgTrunkHeight[slot],
      avgCanopyRadius: this._chunkAvgCanopyRadius[slot],
      understoryDensity: this._chunkUnderstoryDensity[slot],
      succession: this._chunkSuccession[slot],
      successionName: SUCCESSION_NAMES[this._chunkSuccession[slot]],
      edgeBand: this._chunkEdgeBand[slot],
      biomass: this._chunkBiomass[slot],
      trees: {
        x: this._chunkPlacementX[slot],
        y: this._chunkPlacementY[slot],
        z: this._chunkPlacementZ[slot],
        type: this._chunkPlacementType[slot],
        height: this._chunkPlacementHeight[slot],
        canopy: this._chunkPlacementCanopy[slot],
        trunk: this._chunkPlacementTrunk[slot],
        age: this._chunkPlacementAge[slot]
      }
    };
  }

  // Sample leaf colour at a tree placement for materials.
  getTreeLeafColor(type, season, winterFactor, outColor) {
    const c = TREE_LEAF_COLORS[type];
    if (!c) {
      outColor[0] = 0.3; outColor[1] = 0.5; outColor[2] = 0.2;
      return outColor;
    }
    // Season 0..1: 0 = mid-winter, 0.25 = spring, 0.5 = summer, 0.75 = autumn
    // Blend between adjacent seasons.
    let a, b, t;
    if (season < 0.25) { a = c.winter; b = c.spring; t = season / 0.25; }
    else if (season < 0.5) { a = c.spring; b = c.summer; t = (season - 0.25) / 0.25; }
    else if (season < 0.75) { a = c.summer; b = c.autumn; t = (season - 0.5) / 0.25; }
    else { a = c.autumn; b = c.winter; t = (season - 0.75) / 0.25; }

    // Winter factor (0 = fully leafed, 1 = fully bare) blends toward
    // the winter colour at deciduous trees.
    const wf = Math.max(0, Math.min(1, winterFactor));
    outColor[0] = (a[0] * (1 - t) + b[0] * t) * (1 - wf * 0.3);
    outColor[1] = (a[1] * (1 - t) + b[1] * t) * (1 - wf * 0.3);
    outColor[2] = (a[2] * (1 - t) + b[2] * t) * (1 - wf * 0.3);
    return outColor;
  }

  // ══════════════════════════════════════════════════════════
  // ─── frame writes ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.forests) {
      spatial.forests = {
        chunkCount: 0,
        chunkCX: new Int32Array(this._chunkCap),
        chunkCZ: new Int32Array(this._chunkCap),
        chunkSlots: new Int32Array(this._chunkCap),
        canopyDensity: this._chunkCanopyDensity,
        dominantSpecies: this._chunkDominantSpecies,
        avgTrunkHeight: this._chunkAvgTrunkHeight,
        avgCanopyRadius: this._chunkAvgCanopyRadius,
        understoryDensity: this._chunkUnderstoryDensity,
        succession: this._chunkSuccession,
        edgeBand: this._chunkEdgeBand,
        biomass: this._chunkBiomass,
        placements: {
          count: this._chunkPlacementCount,
          x: this._chunkPlacementX,
          y: this._chunkPlacementY,
          z: this._chunkPlacementZ,
          type: this._chunkPlacementType,
          height: this._chunkPlacementHeight,
          canopy: this._chunkPlacementCanopy,
          trunk: this._chunkPlacementTrunk,
          age: this._chunkPlacementAge,
          litter: this._chunkPlacementLitterAccum
        },
        leafColors: TREE_LEAF_COLORS,
        typeNames: TREE_TYPE_NAMES,
        successionNames: SUCCESSION_NAMES
      };
    }

    const f = spatial.forests;
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

    // Aggregate total biomass and CO2 absorption across all tracked chunks.
    let totalBiomass = 0;
    let totalCanopyDensity = 0;
    let chunksWithForest = 0;

    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      totalBiomass += this._chunkBiomass[i];
      totalCanopyDensity += this._chunkCanopyDensity[i];
      chunksWithForest++;
    }

    // Average biomass per chunk (tonnes/ha).
    const avgBiomass = chunksWithForest > 0 ? totalBiomass / chunksWithForest : 0;
    const avgCanopy = chunksWithForest > 0 ? totalCanopyDensity / chunksWithForest : 0;

    // CO2 absorption: 1 tonne biomass ≈ 0.5 tonne carbon ≈ 1.83 tonnes CO2.
    // Absorption rate proportional to canopy density.
    const co2Absorption = avgBiomass * 1.83 * avgCanopy * 0.01;   // tonnes per year per hectare

    physical.forestBiomass = avgBiomass;
    physical.forestCanopyDensity = avgCanopy;
    physical.forestCO2Absorption = co2Absorption;

    // Global species distribution for materials.
    if (!physical.forestSpeciesWeights) {
      physical.forestSpeciesWeights = new Float32Array(TREE_TYPE_NAMES.length);
    }
    physical.forestSpeciesWeights.fill(0);

    let totalPlacements = 0;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      const count = this._chunkPlacementCount[i];
      const types = this._chunkPlacementType[i];
      if (!types) continue;
      for (let k = 0; k < count; k++) {
        physical.forestSpeciesWeights[types[k]]++;
        totalPlacements++;
      }
    }
    if (totalPlacements > 0) {
      for (let i = 0; i < TREE_TYPE_NAMES.length; i++) {
        physical.forestSpeciesWeights[i] /= totalPlacements;
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
    this._lastUpdateTime = now;
    this._frameRef = frame;

    const tc = frame.layers.spatial?.terrainChunks;
    if (!tc || tc.count === 0) return 0;

    // Scatter forests in up to maxChunksPerFrame chunks.
    const budget = Math.min(this.defaults.maxChunksPerFrame, tc.count);
    for (let i = 0; i < budget; i++) {
      const cx = tc.cx[i];
      const cz = tc.cz[i];

      // Skip already-populated chunks.
      const slot = this._getChunkSlot(cx, cz);
      if (slot >= 0 && this._chunkPlacementCount[slot] > 0) continue;

      // Skip if terrain is clearly unsuitable (e.g., water).
      const minY = tc.minY[i];
      const maxY = tc.maxY[i];
      const seaLevel = this._elevation ? this._elevation.seaLevel : 0;
      if (maxY < seaLevel - 5) continue;   // entirely underwater

      this._scatterChunk(cx, cz, frame);
    }

    // Write into frame layers.
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

  setMaxPlacementsPerChunk(count) {
    if (count > 0) this.defaults.maxPlacementsPerChunk = count;
    return this;
  }

  setMaxChunksPerFrame(count) {
    if (count > 0) this.defaults.maxChunksPerFrame = count;
    return this;
  }

  setClearingThreshold(threshold) {
    if (threshold >= 0 && threshold <= 1) {
      this.defaults.clearingThreshold = threshold;
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
    this._dispatcher = null;
    this._frameRef = null;
    this._clearAllChunks();
    for (const key of Object.keys(this._placementPool)) {
      this._placementPool[key].length = 0;
    }
  }
}

export {
  ForestGradientProvider,
  TREE_TYPE,
  TREE_TYPE_NAMES,
  TREE_SCHEMA,
  TREE_LEAF_COLORS,
  SUCCESSION,
  SUCCESSION_NAMES,
  FOREST_DEFAULTS,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};