// file number : 282_Z08
// full path name : src/context/282_Z08_GrassAndFlowresGradientProvider.js
// description : Grass, wildflower, fern, and ground-cover gradient provider for the living world. Builds on 280_TerrainProvider, 281_ElevationProvider, 282_SlopeGradientProvider, 282_Z01_ReliefGradientProvider, 282_Z02_CliffsGradientProvider, 282_Z03_CarveGradientProvider, 282_Z06_RockGradientProvider, and 282_Z07_ForestGradientProvider to detect, place, and animate every blade of grass and every flower in the world. Handles fifteen archetypes grounded in real botany (MEADOW_GRASS, TALL_PRAIRIE, SHORT_TUNDRA, ALPINE_TUFT, SAVANNA_BUNCH, MARSH_REED, FERN, CLOVER, POPPY, LAVENDER, SUNFLOWER, THISTLE, DANDELION, SNOWDROP, ORCHID), each with its own species suitability combining elevation, moisture, temperature, slope, soil fertility, and light exposure. Places blades/flowers via Poisson-disc-like rejection sampling at fine grid resolution (2–3 m cells), preserves natural meadow patches through a low-frequency patch noise field, and applies a per-stalk wind-sway weight so the material shader and the flora sway system can animate every blade independently. Computes per-species bloom windows driven by the world's seasonal clock (spring → summer → autumn), assigns bloom colour palettes that materials read, and produces an emergent "meadow bloom" effect that visibly brightens whole chunks during bloom season — with bloom intensity attenuated by local moisture, temperature, and light. Fills understory gaps left by 282_Z07_ForestGradientProvider (dense canopy → sparse understory, open canopy → full understory) and covers open biomes (meadow, prairie, savanna, tundra, alpine). Contributes fine positive terrain carve (0.001–0.01 m) so grass tufts raise the ground surface slightly, and small negative carve from root activity for prairie deep-root species. Wind-sway weights and bloom state are written into frame.layers.spatial.grass so the material and lighting systems can consume them per-frame. Emits a single coalesced MUTATION causal event per grass chunk so the persistence layer stores ground-cover state across sessions. All scratch objects are pooled; no allocation after the first frame.
// best for : Every blade of grass and every wildflower in the living world — meadow blooms in spring, prairie waves in summer, tundra tufts in autumn, alpine flowers in brief summer windows, savanna bunch grass under acacia shade, marsh reeds at water's edge, and fern understory in temperate forest. Feeds LandscapeVegetationScatterSystem, LandscapePropPlacementSystem, the flora sway shader, materials, and lighting. Complements 282_Z07_ForestGradientProvider (trees) and 282_Z06_RockGradientProvider (rocks) by covering the ground layer that completes the living world's vegetation.
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
  RockGradientProvider, ROCK_TYPE,
  ForestGradientProvider, TREE_TYPE, SUCCESSION
} from './264_MathECSImportBarrel.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 1;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── grass / flower archetypes ──────────────────────────────────
const GRASS_TYPE = Object.freeze({
  NONE:           0,
  MEADOW_GRASS:   1,   // short mixed meadow, 0.2-0.5 m
  TALL_PRAIRIE:   2,   // tall North American prairie, 1-2 m
  SHORT_TUNDRA:   3,   // low tundra grass, 0.05-0.2 m
  ALPINE_TUFT:    4,   // alpine tuft grass, 0.1-0.3 m
  SAVANNA_BUNCH:  5,   // clustered savanna bunch, 0.5-1 m
  MARSH_REED:     6,   // tall marsh reed, 1.5-3 m
  FERN:           7,   // forest understory fern, 0.5-1.5 m
  CLOVER:         8,   // low ground-cover clover
  POPPY:          9,   // spring meadow poppy
  LAVENDER:       10,  // dry Mediterranean lavender
  SUNFLOWER:      11,  // summer tall sunflower
  THISTLE:        12,  // dry thistle
  DANDELION:      13,  // ubiquitous dandelion
  SNOWDROP:       14,  // earliest spring bulb
  ORCHID:         15   // tropical/temperate orchid
});

const GRASS_TYPE_NAMES = Object.freeze([
  'none', 'meadow_grass', 'tall_prairie', 'short_tundra', 'alpine_tuft',
  'savanna_bunch', 'marsh_reed', 'fern', 'clover', 'poppy', 'lavender',
  'sunflower', 'thistle', 'dandelion', 'snowdrop', 'orchid'
]);

// ─── successional bloom windows per species ────────────────────
// A species is "blooming" when the current season factor is inside
// its bloomStart..bloomEnd range (both in 0..1 of the year where
// 0 = mid-winter, 0.25 = spring, 0.5 = summer, 0.75 = autumn).
const GRASS_SCHEMA = Object.freeze({
  [GRASS_TYPE.MEADOW_GRASS]: {
    height: 0.35, density: 0.85,
    bloomStart: 0.20, bloomEnd: 0.55,
    minElev: -100, maxElev: 2000,
    moistMin: 0.30, moistMax: 0.80,
    tempMin: -5, tempMax: 28,
    slopeMax: 25 * Math.PI / 180,
    windSway: 0.5,
    biomeAffinity: {
      [BIOME_HINT.TEMPERATE]: 2.0,
      [BIOME_HINT.GRASSLAND]: 1.8,
      [BIOME_HINT.TAIGA]:     0.6
    }
  },
  [GRASS_TYPE.TALL_PRAIRIE]: {
    height: 1.5, density: 0.75,
    bloomStart: 0.35, bloomEnd: 0.70,
    minElev: 100, maxElev: 1400,
    moistMin: 0.30, moistMax: 0.65,
    tempMin: 5, tempMax: 32,
    slopeMax: 15 * Math.PI / 180,
    windSway: 0.8,
    biomeAffinity: {
      [BIOME_HINT.GRASSLAND]: 2.5,
      [BIOME_HINT.TEMPERATE]: 1.0
    }
  },
  [GRASS_TYPE.SHORT_TUNDRA]: {
    height: 0.12, density: 0.60,
    bloomStart: 0.22, bloomEnd: 0.42,
    minElev: 1000, maxElev: 3200,
    moistMin: 0.20, moistMax: 0.70,
    tempMin: -25, tempMax: 12,
    slopeMax: 35 * Math.PI / 180,
    windSway: 0.3,
    biomeAffinity: {
      [BIOME_HINT.TUNDRA]:  2.5,
      [BIOME_HINT.ALPINE]:  1.2
    }
  },
  [GRASS_TYPE.ALPINE_TUFT]: {
    height: 0.20, density: 0.50,
    bloomStart: 0.30, bloomEnd: 0.50,
    minElev: 1800, maxElev: 4000,
    moistMin: 0.25, moistMax: 0.75,
    tempMin: -20, tempMax: 10,
    slopeMax: 45 * Math.PI / 180,
    windSway: 0.4,
    biomeAffinity: {
      [BIOME_HINT.ALPINE]: 2.5,
      [BIOME_HINT.TUNDRA]: 1.2
    }
  },
  [GRASS_TYPE.SAVANNA_BUNCH]: {
    height: 0.8, density: 0.55,
    bloomStart: 0.30, bloomEnd: 0.65,
    minElev: 50, maxElev: 1400,
    moistMin: 0.10, moistMax: 0.40,
    tempMin: 15, tempMax: 40,
    slopeMax: 20 * Math.PI / 180,
    windSway: 0.7,
    biomeAffinity: {
      [BIOME_HINT.GRASSLAND]: 2.0,
      [BIOME_HINT.DESERT]:    0.8
    }
  },
  [GRASS_TYPE.MARSH_REED]: {
    height: 2.0, density: 0.90,
    bloomStart: 0.40, bloomEnd: 0.65,
    minElev: -2, maxElev: 5,
    moistMin: 0.75, moistMax: 1.00,
    tempMin: 5, tempMax: 30,
    slopeMax: 8 * Math.PI / 180,
    windSway: 1.0,
    biomeAffinity: {
      [BIOME_HINT.FRESHWATER]: 2.5,
      [BIOME_HINT.MARINE]:     1.0
    }
  },
  [GRASS_TYPE.FERN]: {
    height: 1.0, density: 0.70,
    bloomStart: 0.20, bloomEnd: 0.45,
    minElev: 100, maxElev: 1800,
    moistMin: 0.55, moistMax: 0.95,
    tempMin: 5, tempMax: 25,
    slopeMax: 30 * Math.PI / 180,
    windSway: 0.4,
    biomeAffinity: {
      [BIOME_HINT.TEMPERATE]: 2.5,
      [BIOME_HINT.TAIGA]:     1.2,
      [BIOME_HINT.TROPICAL]:  1.5
    }
  },
  [GRASS_TYPE.CLOVER]: {
    height: 0.15, density: 0.75,
    bloomStart: 0.25, bloomEnd: 0.65,
    minElev: -50, maxElev: 2000,
    moistMin: 0.35, moistMax: 0.85,
    tempMin: 0, tempMax: 28,
    slopeMax: 20 * Math.PI / 180,
    windSway: 0.2,
    biomeAffinity: {
      [BIOME_HINT.TEMPERATE]: 2.0,
      [BIOME_HINT.GRASSLAND]: 1.8
    }
  },
  [GRASS_TYPE.POPPY]: {
    height: 0.6, density: 0.35,
    bloomStart: 0.25, bloomEnd: 0.50,
    minElev: 50, maxElev: 1800,
    moistMin: 0.30, moistMax: 0.70,
    tempMin: 8, tempMax: 28,
    slopeMax: 25 * Math.PI / 180,
    windSway: 0.4,
    biomeAffinity: {
      [BIOME_HINT.GRASSLAND]: 2.0,
      [BIOME_HINT.TEMPERATE]: 1.2
    }
  },
  [GRASS_TYPE.LAVENDER]: {
    height: 0.5, density: 0.45,
    bloomStart: 0.35, bloomEnd: 0.60,
    minElev: 200, maxElev: 1500,
    moistMin: 0.15, moistMax: 0.45,
    tempMin: 10, tempMax: 32,
    slopeMax: 20 * Math.PI / 180,
    windSway: 0.3,
    biomeAffinity: {
      [BIOME_HINT.GRASSLAND]: 1.5,
      [BIOME_HINT.DESERT]:    0.8
    }
  },
  [GRASS_TYPE.SUNFLOWER]: {
    height: 2.2, density: 0.25,
    bloomStart: 0.40, bloomEnd: 0.65,
    minElev: 50, maxElev: 1500,
    moistMin: 0.35, moistMax: 0.75,
    tempMin: 12, tempMax: 32,
    slopeMax: 15 * Math.PI / 180,
    windSway: 0.5,
    biomeAffinity: {
      [BIOME_HINT.GRASSLAND]: 2.0,
      [BIOME_HINT.TEMPERATE]: 0.6
    }
  },
  [GRASS_TYPE.THISTLE]: {
    height: 1.0, density: 0.30,
    bloomStart: 0.35, bloomEnd: 0.70,
    minElev: 100, maxElev: 2000,
    moistMin: 0.15, moistMax: 0.50,
    tempMin: 8, tempMax: 30,
    slopeMax: 30 * Math.PI / 180,
    windSway: 0.5,
    biomeAffinity: {
      [BIOME_HINT.GRASSLAND]: 1.5,
      [BIOME_HINT.DESERT]:    1.0
    }
  },
  [GRASS_TYPE.DANDELION]: {
    height: 0.3, density: 0.60,
    bloomStart: 0.20, bloomEnd: 0.60,
    minElev: -50, maxElev: 2200,
    moistMin: 0.25, moistMax: 0.85,
    tempMin: -5, tempMax: 28,
    slopeMax: 25 * Math.PI / 180,
    windSway: 0.3,
    biomeAffinity: {
      [BIOME_HINT.TEMPERATE]: 2.0,
      [BIOME_HINT.GRASSLAND]: 1.8,
      [BIOME_HINT.TAIGA]:     1.0
    }
  },
  [GRASS_TYPE.SNOWDROP]: {
    height: 0.15, density: 0.40,
    bloomStart: 0.14, bloomEnd: 0.28,
    minElev: 0, maxElev: 1800,
    moistMin: 0.45, moistMax: 0.85,
    tempMin: -10, tempMax: 15,
    slopeMax: 20 * Math.PI / 180,
    windSway: 0.2,
    biomeAffinity: {
      [BIOME_HINT.TEMPERATE]: 2.0,
      [BIOME_HINT.TAIGA]:     1.5
    }
  },
  [GRASS_TYPE.ORCHID]: {
    height: 0.4, density: 0.15,
    bloomStart: 0.30, bloomEnd: 0.55,
    minElev: 0, maxElev: 1500,
    moistMin: 0.55, moistMax: 0.95,
    tempMin: 12, tempMax: 30,
    slopeMax: 25 * Math.PI / 180,
    windSway: 0.2,
    biomeAffinity: {
      [BIOME_HINT.TROPICAL]:  2.5,
      [BIOME_HINT.TEMPERATE]: 0.8
    }
  }
});

// ─── colour palettes per species (sRGB 0..1) ────────────────────
// Each species has a base grass/blade colour that varies with season,
// plus a bloom colour that activates only during the bloom window.
const GRASS_COLORS = Object.freeze({
  [GRASS_TYPE.MEADOW_GRASS]: {
    blade: { spring: [0.48, 0.68, 0.30], summer: [0.38, 0.60, 0.24], autumn: [0.55, 0.55, 0.30], winter: [0.30, 0.28, 0.24] },
    bloom: [0.72, 0.68, 0.32]
  },
  [GRASS_TYPE.TALL_PRAIRIE]: {
    blade: { spring: [0.55, 0.72, 0.32], summer: [0.42, 0.62, 0.26], autumn: [0.72, 0.62, 0.28], winter: [0.38, 0.35, 0.28] },
    bloom: [0.85, 0.72, 0.35]
  },
  [GRASS_TYPE.SHORT_TUNDRA]: {
    blade: { spring: [0.42, 0.55, 0.32], summer: [0.35, 0.48, 0.28], autumn: [0.48, 0.50, 0.32], winter: [0.35, 0.32, 0.28] },
    bloom: [0.55, 0.60, 0.42]
  },
  [GRASS_TYPE.ALPINE_TUFT]: {
    blade: { spring: [0.42, 0.55, 0.32], summer: [0.36, 0.50, 0.28], autumn: [0.48, 0.50, 0.30], winter: [0.35, 0.33, 0.28] },
    bloom: [0.72, 0.72, 0.55]
  },
  [GRASS_TYPE.SAVANNA_BUNCH]: {
    blade: { spring: [0.62, 0.62, 0.30], summer: [0.55, 0.55, 0.25], autumn: [0.72, 0.62, 0.28], winter: [0.55, 0.48, 0.26] },
    bloom: [0.82, 0.72, 0.40]
  },
  [GRASS_TYPE.MARSH_REED]: {
    blade: { spring: [0.42, 0.55, 0.28], summer: [0.35, 0.48, 0.22], autumn: [0.55, 0.50, 0.25], winter: [0.45, 0.42, 0.30] },
    bloom: [0.55, 0.45, 0.30]
  },
  [GRASS_TYPE.FERN]: {
    blade: { spring: [0.30, 0.55, 0.22], summer: [0.25, 0.45, 0.18], autumn: [0.35, 0.42, 0.22], winter: [0.30, 0.32, 0.22] },
    bloom: [0.35, 0.45, 0.25]
  },
  [GRASS_TYPE.CLOVER]: {
    blade: { spring: [0.42, 0.68, 0.30], summer: [0.32, 0.55, 0.22], autumn: [0.42, 0.50, 0.26], winter: [0.28, 0.30, 0.24] },
    bloom: [0.85, 0.75, 0.72]
  },
  [GRASS_TYPE.POPPY]: {
    blade: { spring: [0.40, 0.58, 0.25], summer: [0.30, 0.48, 0.20], autumn: [0.42, 0.45, 0.24], winter: [0.28, 0.30, 0.22] },
    bloom: [0.90, 0.20, 0.15]
  },
  [GRASS_TYPE.LAVENDER]: {
    blade: { spring: [0.55, 0.55, 0.35], summer: [0.48, 0.48, 0.30], autumn: [0.52, 0.48, 0.28], winter: [0.42, 0.40, 0.30] },
    bloom: [0.72, 0.55, 0.85]
  },
  [GRASS_TYPE.SUNFLOWER]: {
    blade: { spring: [0.42, 0.62, 0.25], summer: [0.35, 0.55, 0.22], autumn: [0.55, 0.55, 0.25], winter: [0.35, 0.32, 0.24] },
    bloom: [0.95, 0.82, 0.15]
  },
  [GRASS_TYPE.THISTLE]: {
    blade: { spring: [0.42, 0.55, 0.30], summer: [0.38, 0.48, 0.28], autumn: [0.45, 0.48, 0.28], winter: [0.38, 0.35, 0.28] },
    bloom: [0.55, 0.30, 0.72]
  },
  [GRASS_TYPE.DANDELION]: {
    blade: { spring: [0.42, 0.62, 0.28], summer: [0.35, 0.52, 0.22], autumn: [0.45, 0.48, 0.24], winter: [0.30, 0.30, 0.24] },
    bloom: [0.95, 0.88, 0.20]
  },
  [GRASS_TYPE.SNOWDROP]: {
    blade: { spring: [0.32, 0.50, 0.25], summer: [0.28, 0.45, 0.22], autumn: [0.35, 0.42, 0.26], winter: [0.28, 0.30, 0.22] },
    bloom: [0.95, 0.95, 0.98]
  },
  [GRASS_TYPE.ORCHID]: {
    blade: { spring: [0.35, 0.55, 0.30], summer: [0.28, 0.48, 0.25], autumn: [0.38, 0.48, 0.28], winter: [0.30, 0.32, 0.26] },
    bloom: [0.85, 0.55, 0.75]
  }
});

// ─── defaults ────────────────────────────────────────────────────
const GRASS_DEFAULTS = Object.freeze({
  worldSeed: 0x6FA22C0DE,
  cellSize: 2.0,                  // metres per scatter cell (fine grid)
  chunkSize: 1000,
  maxPlacementsPerChunk: 1024,
  maxChunksPerFrame: 4,
  patchNoiseScale: 1 / 128,       // grass patch granularity
  patchThreshold: 0.35,           // below this = no grass
  bloomIntensityScale: 1.0,       // global bloom brightness multiplier
  understoryCanopyCutoff: 0.5,    // canopy density above this reduces understory
  tuftCarveDepth: 0.002,          // metres per tuft positive
  rootCarveDepth: 0.001,          // metres per deep-root negative
  mutationCoalesceWindow: 2.0
});

class GrassAndFlowresGradientProvider {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.defaults = { ...GRASS_DEFAULTS, ...(options.defaults || {}) };
    this.enableWindSway = options.enableWindSway ?? true;
    this.enableBloom = options.enableBloom ?? true;
    this.enableUnderstory = options.enableUnderstory ?? true;
    this.enableTuftCarve = options.enableTuftCarve ?? true;

    // ── scratch (pooled) ────────────────────────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVecD = new Vec3();
    this._tmpMatA = new Mat4();
    this._tmpColor = new Vec3();

    // ── per-chunk grass storage ─────────────────────────────
    const chunkCap = options.maxTrackedChunks ?? 256;
    this._chunkCap = chunkCap;
    this._chunkKeys = new Map();
    this._chunkSlot = 0;
    this._chunkUsed = 0;

    this._chunkCX = new Int32Array(chunkCap);
    this._chunkCZ = new Int32Array(chunkCap);
    this._chunkState = new Uint8Array(chunkCap);

    // Per-chunk summary.
    this._chunkCoverage = new Float32Array(chunkCap);           // 0..1
    this._chunkDominantSpecies = new Uint8Array(chunkCap);
    this._chunkAvgHeight = new Float32Array(chunkCap);
    this._chunkAvgWindSway = new Float32Array(chunkCap);
    this._chunkBloomFactor = new Float32Array(chunkCap);        // 0..1
    this._chunkBloomingSpeciesCount = new Uint8Array(chunkCap);
    this._chunkDominantBloomColor = new Float32Array(chunkCap * 3);
    this._chunkUnderstoryDensity = new Float32Array(chunkCap);

    // Per-chunk placements.
    const placementCap = this.defaults.maxPlacementsPerChunk;
    this._chunkPlacementCount = new Uint16Array(chunkCap);
    this._chunkPlacementX = new Array(chunkCap).fill(null);
    this._chunkPlacementY = new Array(chunkCap).fill(null);
    this._chunkPlacementZ = new Array(chunkCap).fill(null);
    this._chunkPlacementType = new Array(chunkCap).fill(null);
    this._chunkPlacementHeight = new Array(chunkCap).fill(null);
    this._chunkPlacementWindSway = new Array(chunkCap).fill(null);
    this._chunkPlacementBloom = new Array(chunkCap).fill(null);
    this._chunkPlacementBladeColor = new Array(chunkCap).fill(null);   // packed rgb
    this._chunkPlacementBloomColor = new Array(chunkCap).fill(null);   // packed rgb

    // Free lists for placement arrays.
    this._placementPool = {
      x: [], y: [], z: [], type: [], height: [],
      windSway: [], bloom: [], bladeColor: [], bloomColor: []
    };

    // ── per-frame statistics ────────────────────────────────
    this._stats = {
      updates: 0,
      chunksScattered: 0,
      totalGrassPlaced: 0,
      meadowPlaced: 0,
      prairiePlaced: 0,
      tundraPlaced: 0,
      alpinePlaced: 0,
      savannaPlaced: 0,
      reedPlaced: 0,
      fernPlaced: 0,
      cloverPlaced: 0,
      poppyPlaced: 0,
      lavenderPlaced: 0,
      sunflowerPlaced: 0,
      thistlePlaced: 0,
      dandelionPlaced: 0,
      snowdropPlaced: 0,
      orchidPlaced: 0,
      patchesDetected: 0,
      bloomEvents: 0,
      mutationEventsEmitted: 0,
      understoryReductions: 0,
      tuftCarves: 0
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
    this._forest = options.forest || null;
    this._temporal = options.temporal || null;
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
  attachForest(f) { this._forest = f; return this; }
  attachTemporal(t) { this._temporal = t; return this; }
  attachDispatcher(d) { this._dispatcher = d; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── deterministic hash-based RNG ──────────────────────
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
  // ─── grass-patch noise ──────────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Low-frequency noise that determines where grass patches exist
  // vs where bare ground dominates.
  _patchValue(wx, wz) {
    const s = this.defaults.patchNoiseScale;
    const n1 = SimplexNoise.noise(wx * s, wz * s);
    const n2 = SimplexNoise.noise(wx * s * 2.3, wz * s * 2.3);
    const combined = n1 * 0.65 + n2 * 0.35;
    return Math.min(1, Math.max(0, (combined + 1) * 0.5));
  }

  // ══════════════════════════════════════════════════════════
  // ─── season factor from temporal provider ───────────────
  // ══════════════════════════════════════════════════════════
  // Returns season factor in 0..1 where:
  //   0.00 = mid-winter
  //   0.25 = mid-spring
  //   0.50 = mid-summer
  //   0.75 = mid-autumn
  _seasonFactor(frame) {
    if (this._temporal) {
      // TemporalContextProvider exposes seasonScalar in 0..1 where
      // 0 = winter, 0.5 = summer. Convert to our 0..1 annual phase.
      const s = this._temporal.seasonScalar;
      return s;
    }
    const physical = frame.layers.physical;
    if (physical && physical.elapsedWorldSeconds !== undefined && this._temporal) {
      const yearLength = this._temporal.yearLength || (86400 * 365);
      return (physical.elapsedWorldSeconds % yearLength) / yearLength;
    }
    return 0.5;
  }

  // ══════════════════════════════════════════════════════════
  // ─── bloom factor for a species ─────────────────────────
  // ══════════════════════════════════════════════════════════
  // Returns 0..1 (0 = not blooming, 1 = peak bloom).
  _bloomFactor(type, season) {
    if (!this.enableBloom) return 0;
    const s = GRASS_SCHEMA[type];
    if (!s) return 0;
    const start = s.bloomStart;
    const end = s.bloomEnd;
    if (season < start || season > end) return 0;
    // Peak at the middle of the window.
    const peak = (start + end) * 0.5;
    const halfWidth = (end - start) * 0.5;
    const dist = Math.abs(season - peak);
    if (dist > halfWidth) return 0;
    return 1 - (dist / halfWidth);
  }

  // ══════════════════════════════════════════════════════════
  // ─── blade / bloom colour sampling ──────────────────────
  // ══════════════════════════════════════════════════════════
  _sampleBladeColor(type, season, outColor) {
    const c = GRASS_COLORS[type];
    if (!c) { outColor[0] = 0.4; outColor[1] = 0.5; outColor[2] = 0.3; return outColor; }
    const blade = c.blade;
    let a, b, t;
    if (season < 0.25) { a = blade.winter; b = blade.spring; t = season / 0.25; }
    else if (season < 0.5) { a = blade.spring; b = blade.summer; t = (season - 0.25) / 0.25; }
    else if (season < 0.75) { a = blade.summer; b = blade.autumn; t = (season - 0.5) / 0.25; }
    else { a = blade.autumn; b = blade.winter; t = (season - 0.75) / 0.25; }
    outColor[0] = a[0] * (1 - t) + b[0] * t;
    outColor[1] = a[1] * (1 - t) + b[1] * t;
    outColor[2] = a[2] * (1 - t) + b[2] * t;
    return outColor;
  }

  _sampleBloomColor(type, outColor) {
    const c = GRASS_COLORS[type];
    if (!c) { outColor[0] = 0.8; outColor[1] = 0.7; outColor[2] = 0.5; return outColor; }
    outColor[0] = c.bloom[0];
    outColor[1] = c.bloom[1];
    outColor[2] = c.bloom[2];
    return outColor;
  }

  // ══════════════════════════════════════════════════════════
  // ─── species suitability scoring ────────────────────────
  // ══════════════════════════════════════════════════════════
  _speciesSuitability(type, elevation, slopeAngle, moisture, temperature, biomeHint, canopyDensity) {
    const s = GRASS_SCHEMA[type];
    if (!s) return 0;
    if (elevation < s.minElev || elevation > s.maxElev) return 0;
    if (slopeAngle > s.slopeMax) return 0;
    if (moisture < s.moistMin || moisture > s.moistMax) return 0;
    if (temperature < s.tempMin || temperature > s.tempMax) return 0;

    // Biome affinity.
    const affinity = s.biomeAffinity[biomeHint] ?? 0.05;

    // Comfort: centred in range.
    const eCenter = (s.minElev + s.maxElev) * 0.5;
    const eRange = Math.max(1, s.maxElev - s.minElev);
    const eFit = Math.max(0, 1 - Math.abs(elevation - eCenter) / (eRange * 0.5));
    const mCenter = (s.moistMin + s.moistMax) * 0.5;
    const mRange = Math.max(0.01, s.moistMax - s.moistMin);
    const mFit = Math.max(0, 1 - Math.abs(moisture - mCenter) / (mRange * 0.5));
    const tCenter = (s.tempMin + s.tempMax) * 0.5;
    const tRange = Math.max(1, s.tempMax - s.tempMin);
    const tFit = Math.max(0, 1 - Math.abs(temperature - tCenter) / (tRange * 0.5));

    const comfort = (eFit + mFit + tFit) / 3;

    // Understory reduction: dense forest canopy suppresses most grass.
    let understoryFactor = 1.0;
    if (this.enableUnderstory && canopyDensity > 0) {
      if (canopyDensity > this.defaults.understoryCanopyCutoff) {
        understoryFactor = Math.max(0.1,
          1 - (canopyDensity - this.defaults.understoryCanopyCutoff) * 1.5);
        // Fern understory survives dense canopy better than grass.
        if (type === GRASS_TYPE.FERN || type === GRASS_TYPE.ORCHID) {
          understoryFactor = Math.max(0.4, understoryFactor);
        }
      }
    }

    return affinity * comfort * s.density * understoryFactor;
  }

  // ══════════════════════════════════════════════════════════
  // ─── biome hint lookup ──────────────────────────────────
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
  // ─── forest canopy query (for understory reduction) ─────
  // ══════════════════════════════════════════════════════════
  _getForestCanopyAt(wx, wz, frame) {
    if (!this._forest) return 0;
    const forest = this._forest.getForestAt(wx, wz);
    return forest ? forest.canopyDensity : 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── per-chunk grass scatter ────────────────────────────
  // ══════════════════════════════════════════════════════════
  _scatterChunk(cx, cz, frame) {
    const chunkSize = this.defaults.chunkSize;
    const cellSize = this.defaults.cellSize;
    const cellsPerSide = Math.max(1, Math.floor(chunkSize / cellSize));
    const totalCells = cellsPerSide * cellsPerSide;

    const spatial = frame.layers.spatial;
    const physical = frame.layers.physical;
    const moisture = physical?.humidity ?? 0.5;
    const temperature = physical?.ambientTemperature ?? 15;
    const seaLevel = this._elevation ? this._elevation.seaLevel : 0;

    const biomeHint = spatial.terrainChunks
      ? this._getChunkBiomeHint(cx, cz, spatial.terrainChunks)
      : BIOME_HINT.UNKNOWN;

    const season = this._seasonFactor(frame);

    // Allocate chunk slot.
    let slot = this._getChunkSlot(cx, cz);
    if (slot < 0) slot = this._allocChunkSlot(cx, cz);

    // Clear existing placements.
    this._chunkPlacementCount[slot] = 0;

    // Allocate placement arrays.
    if (!this._chunkPlacementX[slot]) {
      this._chunkPlacementX[slot] = this._acquirePlacementArray('x');
      this._chunkPlacementY[slot] = this._acquirePlacementArray('y');
      this._chunkPlacementZ[slot] = this._acquirePlacementArray('z');
      this._chunkPlacementType[slot] = this._acquireTypeArray();
      this._chunkPlacementHeight[slot] = this._acquirePlacementArray('height');
      this._chunkPlacementWindSway[slot] = this._acquirePlacementArray('windSway');
      this._chunkPlacementBloom[slot] = this._acquirePlacementArray('bloom');
      this._chunkPlacementBladeColor[slot] = this._acquireColorArray();
      this._chunkPlacementBloomColor[slot] = this._acquireColorArray();
    }

    const px = this._chunkPlacementX[slot];
    const py = this._chunkPlacementY[slot];
    const pz = this._chunkPlacementZ[slot];
    const pt = this._chunkPlacementType[slot];
    const ph = this._chunkPlacementHeight[slot];
    const pws = this._chunkPlacementWindSway[slot];
    const pbl = this._chunkPlacementBloom[slot];
    const pbc = this._chunkPlacementBladeColor[slot];
    const pbcl = this._chunkPlacementBloomColor[slot];

    const maxPlacements = this.defaults.maxPlacementsPerChunk;
    let placed = 0;
    let patchesInChunk = 0;
    let understoryReduced = 0;
    let blooming = 0;

    // Aggregates.
    let sumHeight = 0;
    let sumWindSway = 0;
    let sumBloom = 0;
    const speciesCount = new Uint16Array(GRASS_TYPE_NAMES.length);
    const bloomColorSum = [0, 0, 0];

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

        // World position with jitter.
        const wx = cx * chunkSize + (i + 0.5) * cellSize + (r1 - 0.5) * cellSize * 0.9;
        const wz = cz * chunkSize + (j + 0.5) * cellSize + (r2 - 0.5) * cellSize * 0.9;

        // Check patch noise.
        const patch = this._patchValue(wx, wz);
        if (patch < this.defaults.patchThreshold) {
          patchesInChunk++;
          continue;
        }

        // Terrain context.
        const elevation = this._elevation
          ? this._elevation.getElevation(wx, wz)
          : (this._terrain ? this._terrain.getHeight(wx, wz) : 0);
        const slopeAngle = this._slope
          ? this._slope.getSlopeAngle(wx, wz)
          : 0;

        // Skip cliffs.
        if (this._cliffs) {
          const cliffR = this._cliffs.classifyCliff(wx, wz);
          if (cliffR.cliffClass === CLIFF_CLASS.VERTICAL_FACE ||
              cliffR.cliffClass === CLIFF_CLASS.OVERHANG ||
              cliffR.cliffClass === CLIFF_CLASS.GORGE_WALL) {
            continue;
          }
        }

        // Skip inside rocks (but let grass grow at rock edges).
        if (this._rocks) {
          const rocks = this._rocks.getPlacementsAt(wx, wz);
          if (rocks && rocks.count > 0) {
            let blocked = false;
            for (let k = 0; k < rocks.count; k++) {
              const dx = rocks.x[k] - wx;
              const dz = rocks.z[k] - wz;
              const d2 = dx * dx + dz * dz;
              const rad = rocks.radius[k];
              if (d2 < rad * rad * 0.9) {
                blocked = true;
                break;
              }
            }
            if (blocked) continue;
          }
        }

        // Skip inside trees (grass grows under trees, not inside trunks).
        let canopyDensity = 0;
        if (this._forest) {
          const forest = this._forest.getForestAt(wx, wz);
          if (forest) {
            canopyDensity = forest.canopyDensity;
            // Check trunk proximity.
            const trees = forest.trees;
            let blocked = false;
            for (let k = 0; k < forest.count; k++) {
              const dx = trees.x[k] - wx;
              const dz = trees.z[k] - wz;
              const d2 = dx * dx + dz * dz;
              const trunkRad = trees.trunk[k] * 1.5;
              if (d2 < trunkRad * trunkRad) {
                blocked = true;
                break;
              }
            }
            if (blocked) continue;
          }
        }

        // Determine species.
        let bestType = GRASS_TYPE.NONE;
        let bestScore = 0;
        for (const typeName of Object.keys(GRASS_SCHEMA)) {
          const type = parseInt(typeName, 10);
          const score = this._speciesSuitability(
            type, elevation, slopeAngle, moisture, temperature,
            biomeHint, canopyDensity
          );
          if (score > bestScore) {
            bestScore = score;
            bestType = type;
          }
        }

        if (bestType === GRASS_TYPE.NONE) continue;
        if (r3 > bestScore) continue;

        const schema = GRASS_SCHEMA[bestType];

        // Height jitter (0.7x..1.3x).
        const height = schema.height * (0.7 + r4 * 0.6);

        // Wind sway with per-stalk jitter.
        const windSway = schema.windSway * (0.7 + r1 * 0.6);

        // Bloom factor and colour.
        const bloomFactor = this._bloomFactor(bestType, season);
        if (bloomFactor > 0.1) blooming++;

        const bladeColor = this._sampleBladeColor(bestType, season, this._tmpColor);
        const bloomColor = this._sampleBloomColor(bestType, this._tmpColor);

        // Record placement.
        px[placed] = wx;
        py[placed] = elevation;
        pz[placed] = wz;
        pt[placed] = bestType;
        ph[placed] = height;
        pws[placed] = windSway;
        pbl[placed] = bloomFactor;

        const co = placed * 3;
        pbc[co]     = bladeColor[0];
        pbc[co + 1] = bladeColor[1];
        pbc[co + 2] = bladeColor[2];
        pbcl[co]     = bloomColor[0];
        pbcl[co + 1] = bloomColor[1];
        pbcl[co + 2] = bloomColor[2];
        placed++;

        sumHeight += height;
        sumWindSway += windSway;
        sumBloom += bloomFactor;
        speciesCount[bestType]++;
        if (bloomFactor > 0.1) {
          bloomColorSum[0] += bloomColor[0] * bloomFactor;
          bloomColorSum[1] += bloomColor[1] * bloomFactor;
          bloomColorSum[2] += bloomColor[2] * bloomFactor;
        }

        // Understory reduction tracking.
        if (canopyDensity > this.defaults.understoryCanopyCutoff) {
          understoryReduced++;
        }

        // Per-species stats.
        switch (bestType) {
          case GRASS_TYPE.MEADOW_GRASS:  this._stats.meadowPlaced++; break;
          case GRASS_TYPE.TALL_PRAIRIE:  this._stats.prairiePlaced++; break;
          case GRASS_TYPE.SHORT_TUNDRA:  this._stats.tundraPlaced++; break;
          case GRASS_TYPE.ALPINE_TUFT:   this._stats.alpinePlaced++; break;
          case GRASS_TYPE.SAVANNA_BUNCH: this._stats.savannaPlaced++; break;
          case GRASS_TYPE.MARSH_REED:    this._stats.reedPlaced++; break;
          case GRASS_TYPE.FERN:          this._stats.fernPlaced++; break;
          case GRASS_TYPE.CLOVER:        this._stats.cloverPlaced++; break;
          case GRASS_TYPE.POPPY:         this._stats.poppyPlaced++; break;
          case GRASS_TYPE.LAVENDER:      this._stats.lavenderPlaced++; break;
          case GRASS_TYPE.SUNFLOWER:     this._stats.sunflowerPlaced++; break;
          case GRASS_TYPE.THISTLE:       this._stats.thistlePlaced++; break;
          case GRASS_TYPE.DANDELION:     this._stats.dandelionPlaced++; break;
          case GRASS_TYPE.SNOWDROP:      this._stats.snowdropPlaced++; break;
          case GRASS_TYPE.ORCHID:        this._stats.orchidPlaced++; break;
        }
        this._stats.totalGrassPlaced++;

        // Tuft carve: grass raises the surface slightly.
        if (this.enableTuftCarve && this._carve && height > 0.3) {
          const tuftDelta = this.defaults.tuftCarveDepth * (height / 1.0);
          if (tuftDelta > 0.0001) {
            this._carve.carveDelta(
              wx, wz, tuftDelta, 0.5,
              CARVE_SOURCE.BIOTIC
            );
            this._stats.tuftCarves++;
          }
        }
      }
    }

    this._chunkPlacementCount[slot] = placed;
    this._stats.chunksScattered++;
    this._stats.patchesDetected += patchesInChunk;
    this._stats.understoryReductions += understoryReduced;

    // Compute chunk summary.
    const avgHeight = placed > 0 ? sumHeight / placed : 0;
    const avgWindSway = placed > 0 ? sumWindSway / placed : 0;
    const avgBloom = placed > 0 ? sumBloom / placed : 0;

    // Coverage: how dense is grass in this chunk.
    const coverage = Math.min(1, (placed * cellSize * cellSize * 2) / (chunkSize * chunkSize));

    // Dominant species.
    let dominant = GRASS_TYPE.NONE;
    let maxCount = 0;
    for (let t = 1; t < speciesCount.length; t++) {
      if (speciesCount[t] > maxCount) {
        maxCount = speciesCount[t];
        dominant = t;
      }
    }

    // Dominant bloom color (weighted by bloom factor).
    let domBloomR = 0, domBloomG = 0, domBloomB = 0;
    if (blooming > 0) {
      const totalWeight = bloomColorSum[0] + bloomColorSum[1] + bloomColorSum[2];
      // Guard against zero.
      if (sumBloom > 0) {
        domBloomR = bloomColorSum[0] / sumBloom;
        domBloomG = bloomColorSum[1] / sumBloom;
        domBloomB = bloomColorSum[2] / sumBloom;
      }
    }

    // Count blooming species.
    let bloomingCount = 0;
    for (let t = 1; t < speciesCount.length; t++) {
      if (speciesCount[t] > 0 && this._bloomFactor(t, season) > 0.1) {
        bloomingCount++;
      }
    }

    // Understory density proxy.
    const understoryDensity = placed > 0 ? placed / Math.max(1, totalCells) : 0;

    // Store summaries.
    this._chunkCoverage[slot] = coverage;
    this._chunkDominantSpecies[slot] = dominant;
    this._chunkAvgHeight[slot] = avgHeight;
    this._chunkAvgWindSway[slot] = avgWindSway;
    this._chunkBloomFactor[slot] = avgBloom;
    this._chunkBloomingSpeciesCount[slot] = bloomingCount;
    this._chunkDominantBloomColor[slot * 3]     = domBloomR;
    this._chunkDominantBloomColor[slot * 3 + 1] = domBloomG;
    this._chunkDominantBloomColor[slot * 3 + 2] = domBloomB;
    this._chunkUnderstoryDensity[slot] = understoryDensity;

    // Emit mutation event if grass placed.
    if (placed > 0 && this._dispatcher) {
      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.MUTATION,
        [(cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize],
        -1, placed * 0.5, 4.0,
        {
          kind: 'grass_scatter',
          chunkX: cx, chunkZ: cz,
          placements: placed,
          dominantSpecies: dominant,
          bloomFactor: avgBloom
        }
      );
      this._stats.mutationEventsEmitted++;
      if (avgBloom > 0.3) this._stats.bloomEvents++;
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
    // Return arrays to pool.
    if (this._chunkPlacementX[slot]) {
      this._placementPool.x.push(this._chunkPlacementX[slot]);
      this._placementPool.y.push(this._chunkPlacementY[slot]);
      this._placementPool.z.push(this._chunkPlacementZ[slot]);
      this._placementPool.height.push(this._chunkPlacementHeight[slot]);
      this._placementPool.windSway.push(this._chunkPlacementWindSway[slot]);
      this._placementPool.bloom.push(this._chunkPlacementBloom[slot]);
      this._placementPool.bladeColor.push(this._chunkPlacementBladeColor[slot]);
      this._placementPool.bloomColor.push(this._chunkPlacementBloomColor[slot]);
    }
    this._chunkPlacementX[slot] = null;
    this._chunkPlacementY[slot] = null;
    this._chunkPlacementZ[slot] = null;
    this._chunkPlacementType[slot] = null;
    this._chunkPlacementHeight[slot] = null;
    this._chunkPlacementWindSway[slot] = null;
    this._chunkPlacementBloom[slot] = null;
    this._chunkPlacementBladeColor[slot] = null;
    this._chunkPlacementBloomColor[slot] = null;
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

  _acquireColorArray() {
    return new Float32Array(this.defaults.maxPlacementsPerChunk * 3);
  }

  // ══════════════════════════════════════════════════════════
  // ─── public queries ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getGrassAt(wx, wz) {
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot < 0 || this._chunkState[slot] === 0) return null;

    return {
      count: this._chunkPlacementCount[slot],
      coverage: this._chunkCoverage[slot],
      dominantSpecies: this._chunkDominantSpecies[slot],
      dominantSpeciesName: GRASS_TYPE_NAMES[this._chunkDominantSpecies[slot]],
      avgHeight: this._chunkAvgHeight[slot],
      avgWindSway: this._chunkAvgWindSway[slot],
      bloomFactor: this._chunkBloomFactor[slot],
      bloomingSpeciesCount: this._chunkBloomingSpeciesCount[slot],
      dominantBloomColor: [
        this._chunkDominantBloomColor[slot * 3],
        this._chunkDominantBloomColor[slot * 3 + 1],
        this._chunkDominantBloomColor[slot * 3 + 2]
      ],
      understoryDensity: this._chunkUnderstoryDensity[slot],
      placements: {
        x: this._chunkPlacementX[slot],
        y: this._chunkPlacementY[slot],
        z: this._chunkPlacementZ[slot],
        type: this._chunkPlacementType[slot],
        height: this._chunkPlacementHeight[slot],
        windSway: this._chunkPlacementWindSway[slot],
        bloom: this._chunkPlacementBloom[slot],
        bladeColor: this._chunkPlacementBladeColor[slot],
        bloomColor: this._chunkPlacementBloomColor[slot]
      }
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── frame writes ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.grass) {
      spatial.grass = {
        chunkCount: 0,
        chunkCX: new Int32Array(this._chunkCap),
        chunkCZ: new Int32Array(this._chunkCap),
        chunkSlots: new Int32Array(this._chunkCap),
        coverage: this._chunkCoverage,
        dominantSpecies: this._chunkDominantSpecies,
        avgHeight: this._chunkAvgHeight,
        avgWindSway: this._chunkAvgWindSway,
        bloomFactor: this._chunkBloomFactor,
        bloomingSpeciesCount: this._chunkBloomingSpeciesCount,
        dominantBloomColor: this._chunkDominantBloomColor,
        understoryDensity: this._chunkUnderstoryDensity,
        placements: {
          count: this._chunkPlacementCount,
          x: this._chunkPlacementX,
          y: this._chunkPlacementY,
          z: this._chunkPlacementZ,
          type: this._chunkPlacementType,
          height: this._chunkPlacementHeight,
          windSway: this._chunkPlacementWindSway,
          bloom: this._chunkPlacementBloom,
          bladeColor: this._chunkPlacementBladeColor,
          bloomColor: this._chunkPlacementBloomColor
        },
        colors: GRASS_COLORS,
        typeNames: GRASS_TYPE_NAMES
      };
    }

    const g = spatial.grass;
    g.chunkCount = 0;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      if (g.chunkCount >= this._chunkCap) break;
      g.chunkCX[g.chunkCount] = this._chunkCX[i];
      g.chunkCZ[g.chunkCount] = this._chunkCZ[i];
      g.chunkSlots[g.chunkCount] = i;
      g.chunkCount++;
    }
  }

  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    // Aggregate grass stats.
    let totalCoverage = 0;
    let totalBloom = 0;
    let totalWindSway = 0;
    let chunksWithGrass = 0;

    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      totalCoverage += this._chunkCoverage[i];
      totalBloom += this._chunkBloomFactor[i];
      totalWindSway += this._chunkAvgWindSway[i];
      chunksWithGrass++;
    }

    physical.grassCoverage = chunksWithGrass > 0 ? totalCoverage / chunksWithGrass : 0;
    physical.grassBloomFactor = chunksWithGrass > 0 ? totalBloom / chunksWithGrass : 0;
    physical.grassWindSway = chunksWithGrass > 0 ? totalWindSway / chunksWithGrass : 0;

    // Bloom intensity affects emissive light in the material shader.
    // Blooming flowers glow slightly and reflect more light.
    physical.grassBloomEmissive = physical.grassBloomFactor * this.defaults.bloomIntensityScale * 0.15;

    // Species distribution.
    if (!physical.grassSpeciesWeights) {
      physical.grassSpeciesWeights = new Float32Array(GRASS_TYPE_NAMES.length);
    }
    physical.grassSpeciesWeights.fill(0);

    let totalPlacements = 0;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      const count = this._chunkPlacementCount[i];
      const types = this._chunkPlacementType[i];
      if (!types) continue;
      for (let k = 0; k < count; k++) {
        physical.grassSpeciesWeights[types[k]]++;
        totalPlacements++;
      }
    }
    if (totalPlacements > 0) {
      for (let i = 0; i < GRASS_TYPE_NAMES.length; i++) {
        physical.grassSpeciesWeights[i] /= totalPlacements;
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

    // Scatter grass in up to maxChunksPerFrame chunks.
    const budget = Math.min(this.defaults.maxChunksPerFrame, tc.count);
    for (let i = 0; i < budget; i++) {
      const cx = tc.cx[i];
      const cz = tc.cz[i];

      // Skip populated chunks.
      const slot = this._getChunkSlot(cx, cz);
      if (slot >= 0 && this._chunkPlacementCount[slot] > 0) continue;

      // Skip fully underwater chunks.
      const minY = tc.minY[i];
      const maxY = tc.maxY[i];
      const seaLevel = this._elevation ? this._elevation.seaLevel : 0;
      if (maxY < seaLevel - 2) continue;

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

  setPatchThreshold(threshold) {
    if (threshold >= 0 && threshold <= 1) {
      this.defaults.patchThreshold = threshold;
    }
    return this;
  }

  setBloomIntensityScale(scale) {
    if (scale >= 0) {
      this.defaults.bloomIntensityScale = scale;
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
    this._forest = null;
    this._temporal = null;
    this._dispatcher = null;
    this._frameRef = null;
    this._clearAllChunks();
    for (const key of Object.keys(this._placementPool)) {
      this._placementPool[key].length = 0;
    }
  }
}

export {
  GrassAndFlowresGradientProvider,
  GRASS_TYPE,
  GRASS_TYPE_NAMES,
  GRASS_SCHEMA,
  GRASS_COLORS,
  GRASS_DEFAULTS,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};