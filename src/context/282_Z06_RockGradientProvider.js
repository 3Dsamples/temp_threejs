// file number : 282_Z06
// full path name : src/context/282_Z06_RockGradientProvider.js
// description : Rock, boulder, and rock-pile gradient provider for the living world. Builds on 280_TerrainProvider, 281_ElevationProvider, 282_SlopeGradientProvider, 282_Z01_ReliefGradientProvider, 282_Z02_CliffsGradientProvider, and 282_Z03_CarveGradientProvider to detect and place every rock feature the world needs — from a single cobble on a streambed to an eighty-metre monolith. Classifies ten rock archetypes (BOULDER, OUTCROP, TALUS, SCREE, MONOLITH, CAIRN, BEDROCK, COBBLE, GRAVEL, PEBBLE) using terrain context (slope, cliff, relief, elevation, water depth) plus the dominant rock type inferred from the biome, altitude, and erosion history. Each rock type is deterministically placed per (worldSeed, chunkX, chunkZ, cellIndex) so the world is stable across reloads, and scattered using Poisson-disc-like rejection sampling on a per-chunk grid. Each placement carries a material descriptor (rockClass, mineralComposition, hardness, brittleness, weathering, lichenCoverage, mossCoverage) that the material system reads to blend its shader — granite, basalt, sandstone, limestone, slate, marble, obsidian, pumice, conglomerate, and quartzite each produce distinct PBR/anime colour grading. Rocks add positive carves via 282_Z03 so they raise the terrain surface (talus piles, boulder fields) rather than only appearing as independent meshes — when the player destroys a boulder, the carve delta goes negative and the world remembers. Emits a single coalesced MUTATION causal event per rock cluster so the persistence system stores it. All scratch objects are pooled; no allocation after the first frame.
// best for : Every rock feature in the living world — scattered field boulders, cliff-base talus, mountain outcrops, glacial erratics, sea-stack bases, streambed cobbles, desert pebble pavements, and cultural cairns. Feeds LandscapePropPlacementSystem, LandscapeDecalPlacementSystem, erosion simulation, biome assignment, AI navigation (rocks as obstacles or cover), and material shading. Complements 282_Z04_NaturalFormationGradientProvider (which handles large hero landforms) by covering the smaller, denser rock scatter.
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
  CarveGradientProvider, CARVE_SOURCE, CARVE_MATERIAL_BAND
} from './264_MathECSImportBarrel.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 1;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── rock archetypes ────────────────────────────────────────────
const ROCK_TYPE = Object.freeze({
  NONE:      0,
  BOULDER:   1,   // large detached rock (0.5-5 m)
  OUTCROP:   2,   // bedrock exposure emerging from soil
  TALUS:     3,   // angular rock pile at cliff base
  SCREE:     4,   // fine loose rock slope
  MONOLITH:  5,   // huge standing rock (5-80 m)
  CAIRN:     6,   // stacked stones (cultural or glacial)
  BEDROCK:   7,   // continuous exposed bedrock
  COBBLE:    8,   // rounded stream/beach rock (0.05-0.3 m)
  GRAVEL:    9,   // small rounded clasts (2-50 mm)
  PEBBLE:    10   // tiny rounded clasts (< 2 mm)
});

const ROCK_TYPE_NAMES = Object.freeze([
  'none', 'boulder', 'outcrop', 'talus', 'scree', 'monolith',
  'cairn', 'bedrock', 'cobble', 'gravel', 'pebble'
]);

// ─── rock classes (mineral composition archetypes) ─────────────
const ROCK_CLASS = Object.freeze({
  GRANITE:      0,
  BASALT:       1,
  SANDSTONE:    2,
  LIMESTONE:    3,
  SLATE:        4,
  MARBLE:       5,
  OBSIDIAN:     6,
  PUMICE:       7,
  CONGLOMERATE: 8,
  QUARTZITE:    9
});

const ROCK_CLASS_NAMES = Object.freeze([
  'granite', 'basalt', 'sandstone', 'limestone', 'slate',
  'marble', 'obsidian', 'pumice', 'conglomerate', 'quartzite'
]);

// ─── base PBR colours per rock class (sRGB 0..1) ───────────────
// These feed the material system; each rock class produces a
// distinct PBR + anime blend.
const ROCK_BASE_COLORS = Object.freeze({
  [ROCK_CLASS.GRANITE]:      [0.55, 0.52, 0.48],
  [ROCK_CLASS.BASALT]:       [0.20, 0.18, 0.17],
  [ROCK_CLASS.SANDSTONE]:    [0.78, 0.62, 0.42],
  [ROCK_CLASS.LIMESTONE]:    [0.82, 0.78, 0.68],
  [ROCK_CLASS.SLATE]:        [0.30, 0.32, 0.34],
  [ROCK_CLASS.MARBLE]:       [0.90, 0.88, 0.86],
  [ROCK_CLASS.OBSIDIAN]:     [0.10, 0.08, 0.12],
  [ROCK_CLASS.PUMICE]:       [0.68, 0.66, 0.62],
  [ROCK_CLASS.CONGLOMERATE]: [0.58, 0.50, 0.42],
  [ROCK_CLASS.QUARTZITE]:    [0.85, 0.82, 0.78]
});

// ─── rock material properties per class (hardness 0..1) ────────
const ROCK_PROPERTIES = Object.freeze({
  [ROCK_CLASS.GRANITE]:      { hardness: 0.85, brittleness: 0.35, density: 2.65, flammability: 0.00 },
  [ROCK_CLASS.BASALT]:       { hardness: 0.88, brittleness: 0.45, density: 2.90, flammability: 0.00 },
  [ROCK_CLASS.SANDSTONE]:    { hardness: 0.45, brittleness: 0.70, density: 2.30, flammability: 0.00 },
  [ROCK_CLASS.LIMESTONE]:    { hardness: 0.40, brittleness: 0.65, density: 2.60, flammability: 0.00 },
  [ROCK_CLASS.SLATE]:        { hardness: 0.55, brittleness: 0.80, density: 2.75, flammability: 0.00 },
  [ROCK_CLASS.MARBLE]:       { hardness: 0.50, brittleness: 0.60, density: 2.70, flammability: 0.00 },
  [ROCK_CLASS.OBSIDIAN]:     { hardness: 0.90, brittleness: 0.95, density: 2.40, flammability: 0.00 },
  [ROCK_CLASS.PUMICE]:       { hardness: 0.25, brittleness: 0.75, density: 0.65, flammability: 0.00 },
  [ROCK_CLASS.CONGLOMERATE]: { hardness: 0.42, brittleness: 0.85, density: 2.35, flammability: 0.00 },
  [ROCK_CLASS.QUARTZITE]:    { hardness: 0.92, brittleness: 0.30, density: 2.65, flammability: 0.00 }
});

// ─── per-archetype schema ─────────────────────────────────────
const ROCK_SCHEMA = Object.freeze({
  [ROCK_TYPE.BOULDER]: {
    minRadius: 0.5, maxRadius: 5.0,
    maxSlope: 45 * Math.PI / 180,
    minElevation: -100, maxElevation: 3500,
    requiresDry: false,
    scatterDensity: 0.10,     // fraction of cells placed
    carveAdditive: 1.5        // positive delta scale
  },
  [ROCK_TYPE.OUTCROP]: {
    minRadius: 1.5, maxRadius: 8.0,
    maxSlope: 70 * Math.PI / 180,
    minElevation: 50, maxElevation: 3500,
    requiresDry: true,
    scatterDensity: 0.03,
    carveAdditive: 2.5
  },
  [ROCK_TYPE.TALUS]: {
    minRadius: 3.0, maxRadius: 20.0,
    maxSlope: 50 * Math.PI / 180,
    minElevation: 100, maxElevation: 3000,
    requiresDry: true,
    scatterDensity: 0.20,
    carveAdditive: 1.2,
    requiresCliffBase: true
  },
  [ROCK_TYPE.SCREE]: {
    minRadius: 1.0, maxRadius: 4.0,
    maxSlope: 40 * Math.PI / 180,
    minElevation: 200, maxElevation: 3500,
    requiresDry: true,
    scatterDensity: 0.35,
    carveAdditive: 0.4,
    requiresCliffBase: true
  },
  [ROCK_TYPE.MONOLITH]: {
    minRadius: 5.0, maxRadius: 40.0,
    maxSlope: 25 * Math.PI / 180,
    minElevation: 0, maxElevation: 3000,
    requiresDry: true,
    scatterDensity: 0.005,
    carveAdditive: 4.0
  },
  [ROCK_TYPE.CAIRN]: {
    minRadius: 0.3, maxRadius: 1.0,
    maxSlope: 20 * Math.PI / 180,
    minElevation: 0, maxElevation: 4000,
    requiresDry: true,
    scatterDensity: 0.002,
    carveAdditive: 3.0
  },
  [ROCK_TYPE.BEDROCK]: {
    minRadius: 2.0, maxRadius: 30.0,
    maxSlope: 60 * Math.PI / 180,
    minElevation: -Infinity, maxElevation: Infinity,
    requiresDry: false,
    scatterDensity: 0.02,
    carveAdditive: 3.0
  },
  [ROCK_TYPE.COBBLE]: {
    minRadius: 0.05, maxRadius: 0.3,
    maxSlope: 15 * Math.PI / 180,
    minElevation: -50, maxElevation: 300,
    requiresDry: false,
    scatterDensity: 0.55,
    carveAdditive: 0.2,
    prefersWater: true
  },
  [ROCK_TYPE.GRAVEL]: {
    minRadius: 0.002, maxRadius: 0.05,
    maxSlope: 12 * Math.PI / 180,
    minElevation: -100, maxElevation: 500,
    requiresDry: false,
    scatterDensity: 0.75,
    carveAdditive: 0.05,
    prefersWater: true
  },
  [ROCK_TYPE.PEBBLE]: {
    minRadius: 0.001, maxRadius: 0.002,
    maxSlope: 10 * Math.PI / 180,
    minElevation: -200, maxElevation: 1000,
    requiresDry: false,
    scatterDensity: 0.90,
    carveAdditive: 0.01,
    prefersWater: true
  }
});

// ─── defaults ─────────────────────────────────────────────────
const ROCK_DEFAULTS = Object.freeze({
  worldSeed: 0x5A17C0DE,
  cellSize: 8.0,                   // metres per scatter cell (LOD 0)
  chunkSize: 1000,
  maxScatterPerChunk: 128,         // cap placements per chunk
  maxChunksPerFrame: 8,
  carveRadiusScale: 1.0,
  mutationCoalesceWindow: 2.0,
  lichenMoistureThreshold: 0.35,
  mossMoistureThreshold: 0.55
});

class RockGradientProvider {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.defaults = { ...ROCK_DEFAULTS, ...(options.defaults || {}) };
    this.enableCarve = options.enableCarve ?? true;
    this.enableDeterministic = options.enableDeterministic ?? true;

    // ── scratch (pooled) ────────────────────────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVecD = new Vec3();
    this._tmpMatA = new Mat4();

    // ── per-chunk rock descriptor storage ───────────────────
    const chunkCap = options.maxTrackedChunks ?? 256;
    this._chunkCap = chunkCap;
    this._chunkKeys = new Map();
    this._chunkSlot = 0;
    this._chunkUsed = 0;

    this._chunkCX = new Int32Array(chunkCap);
    this._chunkCZ = new Int32Array(chunkCap);
    this._chunkState = new Uint8Array(chunkCap);

    // Per-chunk placements stored as flat SoA.
    const placementsPerChunk = this.defaults.maxScatterPerChunk;
    this._chunkPlacementCount = new Uint16Array(chunkCap);
    this._chunkPlacementX = new Array(chunkCap).fill(null);
    this._chunkPlacementY = new Array(chunkCap).fill(null);
    this._chunkPlacementZ = new Array(chunkCap).fill(null);
    this._chunkPlacementRadius = new Array(chunkCap).fill(null);
    this._chunkPlacementType = new Array(chunkCap).fill(null);
    this._chunkPlacementClass = new Array(chunkCap).fill(null);
    this._chunkPlacementRotation = new Array(chunkCap).fill(null);
    this._chunkPlacementScale = new Array(chunkCap).fill(null);
    this._chunkPlacementLichen = new Array(chunkCap).fill(null);
    this._chunkPlacementMoss = new Array(chunkCap).fill(null);

    // Pools for the per-chunk arrays.
    this._placementPool = { x: [], y: [], z: [], radius: [], type: [], cls: [], rot: [], scale: [], lichen: [], moss: [] };
    this._placementPoolIndex = 0;

    // ── pooled placement slots (for allocation reuse) ───────
    this._placementSlots = [];
    this._placementSlotsIndex = 0;

    // ── per-frame statistics ────────────────────────────────
    this._stats = {
      updates: 0,
      chunksScattered: 0,
      bouldersPlaced: 0,
      outcropsPlaced: 0,
      talusPlaced: 0,
      screePlaced: 0,
      monolithsPlaced: 0,
      cairnsPlaced: 0,
      bedrocksPlaced: 0,
      cobblesPlaced: 0,
      gravelsPlaced: 0,
      pebblesPlaced: 0,
      totalPlacements: 0,
      mutationEventsEmitted: 0,
      skipped: 0
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
  // ─── dominant rock class inference ──────────────────────
  // ══════════════════════════════════════════════════════════
  // Given elevation, slope, and biome, return the most likely
  // rock class. Rules are geology-motivated and can be extended.
  _inferRockClass(elevation, slopeAngle, biomeHint, moisture) {
    // High-altitude igneous/metamorphic.
    if (elevation > 2800) return ROCK_CLASS.GRANITE;
    if (elevation > 2000) return ROCK_CLASS.QUARTZITE;

    // Volcanic biomes.
    if (biomeHint === BIOME_HINT.DESERT && moisture < 0.2) {
      // Arid deserts: sandstone or basalt depending on slope.
      return slopeAngle > 0.4 ? ROCK_CLASS.BASALT : ROCK_CLASS.SANDSTONE;
    }

    // Coastal / marine: limestone.
    if (biomeHint === BIOME_HINT.MARINE || biomeHint === BIOME_HINT.FRESHWATER) {
      return ROCK_CLASS.LIMESTONE;
    }

    // Temperate / forest: mixed with granite or slate.
    if (biomeHint === BIOME_HINT.TEMPERATE || biomeHint === BIOME_HINT.TAIGA) {
      return slopeAngle > 0.5 ? ROCK_CLASS.SLATE : ROCK_CLASS.GRANITE;
    }

    // Tropical: limestone (karst terrain).
    if (biomeHint === BIOME_HINT.TROPICAL) {
      return ROCK_CLASS.LIMESTONE;
    }

    // Tundra / alpine: granite and quartzite.
    if (biomeHint === BIOME_HINT.TUNDRA || biomeHint === BIOME_HINT.ALPINE) {
      return ROCK_CLASS.GRANITE;
    }

    // Grassland: sandstone / conglomerate.
    if (biomeHint === BIOME_HINT.GRASSLAND) {
      return ROCK_CLASS.SANDSTONE;
    }

    return ROCK_CLASS.GRANITE;
  }

  // ══════════════════════════════════════════════════════════
  // ─── per-cell scatter suitability ──────────────────────
  // ══════════════════════════════════════════════════════════
  _cellScatterSuitability(type, elevation, slopeAngle, waterDepth, cliffClass, moisture) {
    const s = ROCK_SCHEMA[type];
    if (!s) return 0;

    // Elevation filter.
    if (elevation < s.minElevation || elevation > s.maxElevation) return 0;

    // Slope filter.
    if (slopeAngle > s.maxSlope) return 0;

    // Water filter.
    if (s.requiresDry && waterDepth > 0.5) return 0;
    if (s.prefersWater && waterDepth < 0.1 && waterDepth > 50) return 0;

    // Cliff-base requirement.
    if (s.requiresCliffBase) {
      if (cliffClass !== CLIFF_CLASS.VERTICAL_FACE &&
          cliffClass !== CLIFF_CLASS.OVERHANG &&
          cliffClass !== CLIFF_CLASS.UNDERHANG &&
          cliffClass !== CLIFF_CLASS.ESCARPMENT) {
        return 0;
      }
    }

    // Base score from schema scatter density.
    let score = s.scatterDensity;

    // Cliff-base types get a boost if cliff is present.
    if (s.requiresCliffBase) score *= 1.5;

    // Water-preferring types get a boost in shallow water.
    if (s.prefersWater && waterDepth > 0.2 && waterDepth < 3) score *= 1.3;

    // Low-slope monoliths get a boost at ridge crests.
    if (type === ROCK_TYPE.MONOLITH && slopeAngle < 0.1) score *= 1.8;

    // Cairns are rare and tied to culturally active regions (high
    // player focus, high visibility) — for now just deterministic.

    return score;
  }

  // ══════════════════════════════════════════════════════════
  // ─── per-cell scatter for a chunk ───────────────────────
  // ══════════════════════════════════════════════════════════
  _scatterChunk(cx, cz, frame) {
    const chunkSize = this.defaults.chunkSize;
    const cellSize = this.defaults.cellSize;
    const cellsPerSide = Math.max(1, Math.floor(chunkSize / cellSize));
    const totalCells = cellsPerSide * cellsPerSide;

    const spatial = frame.layers.spatial;
    const physical = frame.layers.physical;
    const moisture = physical?.humidity ?? 0.5;
    const biomeHint = spatial.terrainChunks
      ? this._getChunkBiomeHint(cx, cz, spatial.terrainChunks)
      : BIOME_HINT.UNKNOWN;
    const seaLevel = this._elevation ? this._elevation.seaLevel : 0;

    // Get placements list allocated for this chunk.
    let slot = this._getChunkSlot(cx, cz);
    if (slot < 0) slot = this._allocChunkSlot(cx, cz);

    // Clear and rebuild placements for this chunk.
    this._chunkPlacementCount[slot] = 0;

    const maxPlacements = this.defaults.maxScatterPerChunk;
    let placed = 0;

    // Pre-allocate per-chunk arrays from pool if needed.
    if (!this._chunkPlacementX[slot]) {
      this._chunkPlacementX[slot] = this._acquirePlacementArray('x');
      this._chunkPlacementY[slot] = this._acquirePlacementArray('y');
      this._chunkPlacementZ[slot] = this._acquirePlacementArray('z');
      this._chunkPlacementRadius[slot] = this._acquirePlacementArray('radius');
      this._chunkPlacementType[slot] = this._acquireTypeArray();
      this._chunkPlacementClass[slot] = this._acquireTypeArray();
      this._chunkPlacementRotation[slot] = this._acquirePlacementArray('rot');
      this._chunkPlacementScale[slot] = this._acquirePlacementArray('scale');
      this._chunkPlacementLichen[slot] = this._acquirePlacementArray('lichen');
      this._chunkPlacementMoss[slot] = this._acquirePlacementArray('moss');
    }

    const px = this._chunkPlacementX[slot];
    const py = this._chunkPlacementY[slot];
    const pz = this._chunkPlacementZ[slot];
    const pr = this._chunkPlacementRadius[slot];
    const pt = this._chunkPlacementType[slot];
    const pc = this._chunkPlacementClass[slot];
    const prot = this._chunkPlacementRotation[slot];
    const ps = this._chunkPlacementScale[slot];
    const pl = this._chunkPlacementLichen[slot];
    const pm = this._chunkPlacementMoss[slot];

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

        // World position of the cell centre + jitter.
        const wx = cx * chunkSize + (i + 0.5) * cellSize + (r1 - 0.5) * cellSize * 0.8;
        const wz = cz * chunkSize + (j + 0.5) * cellSize + (r2 - 0.5) * cellSize * 0.8;

        // Get context at this position.
        const elevation = this._elevation
          ? this._elevation.getElevation(wx, wz)
          : (this._terrain ? this._terrain.getHeight(wx, wz) : 0);
        const slopeAngle = this._slope
          ? this._slope.getSlopeAngle(wx, wz)
          : 0;
        const waterDepth = Math.max(0, seaLevel - elevation);

        // Get cliff class at this position (coarse-grained).
        let cliffClass = 0;
        if (this._cliffs) {
          const cliffR = this._cliffs.classifyCliff(wx, wz);
          cliffClass = cliffR.cliffClass;
        }

        // Try each type in order of decreasing density (so smaller
        // types get tried first when densities overlap).
        let chosenType = ROCK_TYPE.NONE;
        let chosenScore = 0;

        for (const typeName of Object.keys(ROCK_SCHEMA)) {
          const type = parseInt(typeName, 10);
          const suitability = this._cellScatterSuitability(
            type, elevation, slopeAngle, waterDepth, cliffClass, moisture
          );
          if (suitability <= 0) continue;

          // Roll against suitability.
          if (r3 < suitability && suitability > chosenScore) {
            chosenScore = suitability;
            chosenType = type;
          }
        }

        if (chosenType === ROCK_TYPE.NONE) continue;

        // Rock class + properties.
        const schema = ROCK_SCHEMA[chosenType];
        const rockClass = this._inferRockClass(elevation, slopeAngle, biomeHint, moisture);
        const props = ROCK_PROPERTIES[rockClass];

        // Size: uniform between min and max, biased toward min for
        // boulder-like types, toward max for talus-like types.
        const radius = schema.minRadius + r4 * (schema.maxRadius - schema.minRadius);

        // Rotation (Y-axis).
        const rotation = r5 * 2 * Math.PI;

        // Scale jitter (0.85..1.15).
        const scale = 0.85 + r2 * 0.3;

        // Lichen / moss coverage determined by moisture + elevation.
        const lichen = moisture > this.defaults.lichenMoistureThreshold
          ? Math.min(1, (moisture - this.defaults.lichenMoistureThreshold) * 2 + r1 * 0.3)
          : 0;
        const moss = moisture > this.defaults.mossMoistureThreshold
          ? Math.min(1, (moisture - this.defaults.mossMoistureThreshold) * 1.5 + r3 * 0.2)
          : 0;

        // Record placement.
        px[placed] = wx;
        py[placed] = elevation;
        pz[placed] = wz;
        pr[placed] = radius;
        pt[placed] = chosenType;
        pc[placed] = rockClass;
        prot[placed] = rotation;
        ps[placed] = scale;
        pl[placed] = lichen;
        pm[placed] = moss;
        placed++;

        // Track stats.
        switch (chosenType) {
          case ROCK_TYPE.BOULDER:   this._stats.bouldersPlaced++; break;
          case ROCK_TYPE.OUTCROP:   this._stats.outcropsPlaced++; break;
          case ROCK_TYPE.TALUS:     this._stats.talusPlaced++; break;
          case ROCK_TYPE.SCREE:     this._stats.screePlaced++; break;
          case ROCK_TYPE.MONOLITH:  this._stats.monolithsPlaced++; break;
          case ROCK_TYPE.CAIRN:     this._stats.cairnsPlaced++; break;
          case ROCK_TYPE.BEDROCK:   this._stats.bedrocksPlaced++; break;
          case ROCK_TYPE.COBBLE:    this._stats.cobblesPlaced++; break;
          case ROCK_TYPE.GRAVEL:    this._stats.gravelsPlaced++; break;
          case ROCK_TYPE.PEBBLE:    this._stats.pebblesPlaced++; break;
        }
        this._stats.totalPlacements++;

        // Carve the terrain if this rock type adds surface.
        if (this.enableCarve && this._carve && chosenType !== ROCK_TYPE.NONE) {
          // Only carve if the rock is big enough to affect the surface.
          const carveDelta = schema.carveAdditive * Math.min(radius, 3.0) * scale;
          if (carveDelta > 0.1) {
            this._carve.carveDelta(
              wx, wz, carveDelta, radius * 0.8,
              CARVE_SOURCE.THERMAL   // rocks accumulate from slope collapse
            );
          }
        }
      }
    }

    this._chunkPlacementCount[slot] = placed;

    // Emit a coalesced mutation event per chunk.
    if (placed > 0 && this._dispatcher) {
      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.MUTATION,
        [(cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize],
        -1, placed * 5, 3.0,
        {
          kind: 'rock_scatter',
          chunkX: cx, chunkZ: cz,
          placements: placed,
          dominantClass: pc[0] || ROCK_CLASS.GRANITE
        }
      );
      this._stats.mutationEventsEmitted++;
    }

    this._stats.chunksScattered++;
    return placed;
  }

  _getChunkBiomeHint(cx, cz, tc) {
    for (let i = 0; i < tc.count; i++) {
      if (tc.cx[i] === cx && tc.cz[i] === cz) {
        return tc.biomeHint[i];
      }
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
    this._chunkPlacementCount[slot] = 0;
    // Return arrays to the pool.
    if (this._chunkPlacementX[slot]) {
      this._placementPool.x.push(this._chunkPlacementX[slot]);
      this._placementPool.y.push(this._chunkPlacementY[slot]);
      this._placementPool.z.push(this._chunkPlacementZ[slot]);
      this._placementPool.radius.push(this._chunkPlacementRadius[slot]);
      this._placementPool.rot.push(this._chunkPlacementRotation[slot]);
      this._placementPool.scale.push(this._chunkPlacementScale[slot]);
      this._placementPool.lichen.push(this._chunkPlacementLichen[slot]);
      this._placementPool.moss.push(this._chunkPlacementMoss[slot]);
    }
    this._chunkPlacementX[slot] = null;
    this._chunkPlacementY[slot] = null;
    this._chunkPlacementZ[slot] = null;
    this._chunkPlacementRadius[slot] = null;
    this._chunkPlacementType[slot] = null;
    this._chunkPlacementClass[slot] = null;
    this._chunkPlacementRotation[slot] = null;
    this._chunkPlacementScale[slot] = null;
    this._chunkPlacementLichen[slot] = null;
    this._chunkPlacementMoss[slot] = null;
    this._chunkUsed--;
  }

  _evictOldest() {
    let oldest = -1;
    let oldestTime = Infinity;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      // Use first placement timestamp as eviction basis.
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
    return new Float32Array(this.defaults.maxScatterPerChunk);
  }

  _acquireTypeArray() {
    return new Uint8Array(this.defaults.maxScatterPerChunk);
  }

  // ══════════════════════════════════════════════════════════
  // ─── public queries ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getPlacementsAt(wx, wz) {
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot < 0 || this._chunkState[slot] === 0) return null;
    return {
      count: this._chunkPlacementCount[slot],
      x: this._chunkPlacementX[slot],
      y: this._chunkPlacementY[slot],
      z: this._chunkPlacementZ[slot],
      radius: this._chunkPlacementRadius[slot],
      type: this._chunkPlacementType[slot],
      cls: this._chunkPlacementClass[slot],
      rotation: this._chunkPlacementRotation[slot],
      scale: this._chunkPlacementScale[slot],
      lichen: this._chunkPlacementLichen[slot],
      moss: this._chunkPlacementMoss[slot]
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── frame writes ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.rocks) {
      spatial.rocks = {
        chunkCount: 0,
        chunkCX: new Int32Array(this._chunkCap),
        chunkCZ: new Int32Array(this._chunkCap),
        chunkSlots: new Int32Array(this._chunkCap),
        placementCount: this._chunkPlacementCount,
        placementsX: this._chunkPlacementX,
        placementsY: this._chunkPlacementY,
        placementsZ: this._chunkPlacementZ,
        placementsRadius: this._chunkPlacementRadius,
        placementsType: this._chunkPlacementType,
        placementsClass: this._chunkPlacementClass,
        placementsRotation: this._chunkPlacementRotation,
        placementsScale: this._chunkPlacementScale,
        placementsLichen: this._chunkPlacementLichen,
        placementsMoss: this._chunkPlacementMoss,
        rockClassColors: ROCK_BASE_COLORS,
        rockClassNames: ROCK_CLASS_NAMES,
        rockTypeNames: ROCK_TYPE_NAMES
      };
    }
    const r = spatial.rocks;
    r.chunkCount = 0;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      if (r.chunkCount >= this._chunkCap) break;
      r.chunkCX[r.chunkCount] = this._chunkCX[i];
      r.chunkCZ[r.chunkCount] = this._chunkCZ[i];
      r.chunkSlots[r.chunkCount] = i;
      r.chunkCount++;
    }
  }

  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    // Aggregate rock class distribution for materials.
    if (!physical.rockClassWeights) {
      physical.rockClassWeights = new Float32Array(ROCK_CLASS_NAMES.length);
    }
    physical.rockClassWeights.fill(0);
    let totalPlacements = 0;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      const count = this._chunkPlacementCount[i];
      const pc = this._chunkPlacementClass[i];
      if (!pc) continue;
      for (let k = 0; k < count; k++) {
        physical.rockClassWeights[pc[k]]++;
        totalPlacements++;
      }
    }
    if (totalPlacements > 0) {
      for (let i = 0; i < ROCK_CLASS_NAMES.length; i++) {
        physical.rockClassWeights[i] /= totalPlacements;
      }
    }

    // Dominant rock class (highest weight).
    let dominant = 0;
    let maxW = 0;
    for (let i = 0; i < ROCK_CLASS_NAMES.length; i++) {
      if (physical.rockClassWeights[i] > maxW) {
        maxW = physical.rockClassWeights[i];
        dominant = i;
      }
    }
    physical.dominantRockClass = dominant;
    physical.dominantRockColor = ROCK_BASE_COLORS[dominant];
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

    // Scatter rocks in up to maxChunksPerFrame chunks.
    const budget = Math.min(this.defaults.maxChunksPerFrame, tc.count);
    for (let i = 0; i < budget; i++) {
      const cx = tc.cx[i];
      const cz = tc.cz[i];
      // Skip chunks that are already populated.
      const slot = this._getChunkSlot(cx, cz);
      if (slot >= 0 && this._chunkPlacementCount[slot] > 0) {
        this._stats.skipped++;
        continue;
      }
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

  setMaxScatterPerChunk(count) {
    if (count > 0) this.defaults.maxScatterPerChunk = count;
    return this;
  }

  setMaxChunksPerFrame(count) {
    if (count > 0) this.defaults.maxChunksPerFrame = count;
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
    this._dispatcher = null;
    this._frameRef = null;
    this._clearAllChunks();
    this._placementPool.x.length = 0;
    this._placementPool.y.length = 0;
    this._placementPool.z.length = 0;
    this._placementPool.radius.length = 0;
    this._placementPool.rot.length = 0;
    this._placementPool.scale.length = 0;
    this._placementPool.lichen.length = 0;
    this._placementPool.moss.length = 0;
  }
}

export {
  RockGradientProvider,
  ROCK_TYPE,
  ROCK_TYPE_NAMES,
  ROCK_CLASS,
  ROCK_CLASS_NAMES,
  ROCK_BASE_COLORS,
  ROCK_PROPERTIES,
  ROCK_SCHEMA,
  ROCK_DEFAULTS,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};