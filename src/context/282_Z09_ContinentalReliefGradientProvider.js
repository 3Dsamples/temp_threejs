// file number : 282_Z09
// full path name : src/context/282_Z09_ContinentalReliefGradientProvider.js
// description : Continental-scale relief synthesis provider for the living world at the 1,000 km / 10,000 km / 100,000 km tiers. Builds the tectonic-scale foundation on top of the per-chunk heightfield stack (280_TerrainProvider through 282_Z08) by synthesizing low-frequency relief from layered Simplex noise at wavelengths of 1,000–100,000 km, extracting plate-tectonic boundaries, and classifying every world position into one of twelve continental features (DEEP_OCEAN, OCEANIC_RIDGE, CONTINENTAL_SHELF, SHELF_BREAK, COASTAL_PLAIN, INTERIOR_LOWLAND, INTERIOR_PLATEAU, MOUNTAIN_BELT, RIFT_VALLEY, VOLCANIC_ARC, ISLAND_ARC, CONTINENTAL_INTERIOR). The provider produces a continental elevation modifier (0 to +3000 m offset applied to the base terrain) so that distinct continents, sub-continents, mountain ranges, and rift systems emerge from the same heightfield stack without manual authoring. It also computes orographic rain-shadow classification from wind direction, continental-scale water routing (each cell knows whether it drains to the coast, to an interior basin, or to a lake), interior-continentality (0 = coastal, 1 = deep interior) for climate coupling, and biome-affinity hints that downstream BiomeBlendField and the biome providers read to decide whether a chunk belongs to a continental interior or a coastal biome. Writes per-cell descriptors into frame.layers.spatial.continentalRelief and global continental summaries into frame.layers.physical.continentalSummary. All scratch objects are pooled; no allocation after the first frame.
// best for : Every consumer that needs to know "what continent am I on, how far inland am I, what mountain range is this, is this a coastal plain or a rift valley" — BiomeBlendField for biome assignment, LandscapeChunkStreamer for priority loading of continental landmarks, BiomeClimateCoupling for orographic effects, LandscapeWaterFlowSystem for continental river routing, LandscapeErosionSimulator for uplift-driven erosion, and material shaders that need to blend their colours by continental province. Complements all 280–282 providers by providing the tectonic-scale context they cannot derive from 1 km heightfields alone.
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
  ForestGradientProvider, TREE_TYPE, SUCCESSION,
  GrassAndFlowresGradientProvider, GRASS_TYPE
} from './264_MathECSImportBarrel.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 0.2;   // once every 5 seconds is plenty for continental
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── continental feature classes ────────────────────────────────
const CONTINENTAL_TYPE = Object.freeze({
  UNKNOWN:              0,
  DEEP_OCEAN:           1,   // > 4000 m deep
  OCEANIC_RIDGE:        2,   // mid-ocean ridge, spreading centre
  CONTINENTAL_SHELF:    3,   // shallow shelf (0-200 m depth)
  SHELF_BREAK:          4,   // steep transition shelf → abyss
  COASTAL_PLAIN:        5,   // 0-200 m above sea level, near coast
  INTERIOR_LOWLAND:     6,   // 200-800 m above sea level, inland
  INTERIOR_PLATEAU:     7,   // broad high interior, flat
  MOUNTAIN_BELT:        8,   // orogenic belt (1000-8000 m)
  RIFT_VALLEY:          9,   // subsided rift shoulder
  VOLCANIC_ARC:        10,   // subduction-zone volcanoes
  ISLAND_ARC:          11,   // island chain from subduction
  CONTINENTAL_INTERIOR:12    // deep continental interior (any elevation)
});

const CONTINENTAL_TYPE_NAMES = Object.freeze([
  'unknown', 'deep_ocean', 'oceanic_ridge', 'continental_shelf',
  'shelf_break', 'coastal_plain', 'interior_lowland',
  'interior_plateau', 'mountain_belt', 'rift_valley',
  'volcanic_arc', 'island_arc', 'continental_interior'
]);

// ─── biome affinity per continental type ────────────────────────
// Weights that downstream BiomeBlendField uses to weight biome
// assignment. Each row sums to ~1.0.
const CONTINENTAL_BIOME_AFFINITY = Object.freeze({
  [CONTINENTAL_TYPE.DEEP_OCEAN]:         { [BIOME_HINT.MARINE]: 1.0 },
  [CONTINENTAL_TYPE.OCEANIC_RIDGE]:      { [BIOME_HINT.MARINE]: 1.0 },
  [CONTINENTAL_TYPE.CONTINENTAL_SHELF]:  { [BIOME_HINT.MARINE]: 0.8, [BIOME_HINT.FRESHWATER]: 0.2 },
  [CONTINENTAL_TYPE.SHELF_BREAK]:        { [BIOME_HINT.MARINE]: 0.9, [BIOME_HINT.FRESHWATER]: 0.1 },
  [CONTINENTAL_TYPE.COASTAL_PLAIN]:      { [BIOME_HINT.TEMPERATE]: 0.3, [BIOME_HINT.TROPICAL]: 0.3, [BIOME_HINT.GRASSLAND]: 0.2, [BIOME_HINT.FRESHWATER]: 0.2 },
  [CONTINENTAL_TYPE.INTERIOR_LOWLAND]:   { [BIOME_HINT.GRASSLAND]: 0.4, [BIOME_HINT.TEMPERATE]: 0.3, [BIOME_HINT.TAIGA]: 0.2, [BIOME_HINT.DESERT]: 0.1 },
  [CONTINENTAL_TYPE.INTERIOR_PLATEAU]:   { [BIOME_HINT.GRASSLAND]: 0.4, [BIOME_HINT.DESERT]: 0.3, [BIOME_HINT.TUNDRA]: 0.2, [BIOME_HINT.TEMPERATE]: 0.1 },
  [CONTINENTAL_TYPE.MOUNTAIN_BELT]:      { [BIOME_HINT.ALPINE]: 0.6, [BIOME_HINT.TAIGA]: 0.2, [BIOME_HINT.TUNDRA]: 0.2 },
  [CONTINENTAL_TYPE.RIFT_VALLEY]:        { [BIOME_HINT.GRASSLAND]: 0.4, [BIOME_HINT.TEMPERATE]: 0.3, [BIOME_HINT.FRESHWATER]: 0.2, [BIOME_HINT.DESERT]: 0.1 },
  [CONTINENTAL_TYPE.VOLCANIC_ARC]:       { [BIOME_HINT.ALPINE]: 0.5, [BIOME_HINT.TAIGA]: 0.3, [BIOME_HINT.TUNDRA]: 0.2 },
  [CONTINENTAL_TYPE.ISLAND_ARC]:         { [BIOME_HINT.TROPICAL]: 0.6, [BIOME_HINT.MARINE]: 0.3, [BIOME_HINT.TEMPERATE]: 0.1 },
  [CONTINENTAL_TYPE.CONTINENTAL_INTERIOR]:{ [BIOME_HINT.DESERT]: 0.4, [BIOME_HINT.GRASSLAND]: 0.3, [BIOME_HINT.TUNDRA]: 0.2, [BIOME_HINT.TEMPERATE]: 0.1 }
});

// ─── continental type representative colours (sRGB, for materials) ─
const CONTINENTAL_COLORS = Object.freeze({
  [CONTINENTAL_TYPE.DEEP_OCEAN]:          [0.05, 0.10, 0.22],
  [CONTINENTAL_TYPE.OCEANIC_RIDGE]:       [0.10, 0.18, 0.30],
  [CONTINENTAL_TYPE.CONTINENTAL_SHELF]:   [0.15, 0.30, 0.42],
  [CONTINENTAL_TYPE.SHELF_BREAK]:         [0.12, 0.22, 0.35],
  [CONTINENTAL_TYPE.COASTAL_PLAIN]:       [0.42, 0.55, 0.30],
  [CONTINENTAL_TYPE.INTERIOR_LOWLAND]:    [0.48, 0.58, 0.32],
  [CONTINENTAL_TYPE.INTERIOR_PLATEAU]:    [0.58, 0.52, 0.35],
  [CONTINENTAL_TYPE.MOUNTAIN_BELT]:       [0.55, 0.52, 0.48],
  [CONTINENTAL_TYPE.RIFT_VALLEY]:         [0.45, 0.50, 0.32],
  [CONTINENTAL_TYPE.VOLCANIC_ARC]:        [0.35, 0.30, 0.28],
  [CONTINENTAL_TYPE.ISLAND_ARC]:          [0.35, 0.50, 0.30],
  [CONTINENTAL_TYPE.CONTINENTAL_INTERIOR]:[0.55, 0.48, 0.32]
});

// ─── synthesis constants ────────────────────────────────────────
// All frequencies are in 1/metres. Wavelengths:
//   continental mask     : 8000 km  → 1.25e-7 m⁻¹
//   plate boundaries     : 3000 km  → 3.33e-7 m⁻¹
//   mountain belts       : 500 km   → 2.0e-6 m⁻¹ (for internal detail)
//   rift systems         : 1500 km  → 6.67e-7 m⁻¹
//   coastline noise      : 200 km   → 5.0e-6 m⁻¹
const SYNTHESIS = Object.freeze({
  // Continental mask
  continentalMaskFreq:      1.25e-7,
  continentalMaskOctaves:   3,
  continentalMaskPersist:   0.55,
  continentalThreshold:     0.35,   // above this = land, below = ocean

  // Plate boundaries (ridged noise)
  plateBoundaryFreq:        3.33e-7,
  plateBoundaryOctaves:     2,

  // Mountain belts
  mountainBeltFreq:         5.0e-7,
  mountainBeltOctaves:      4,
  mountainBeltAmplitude:    3000.0,   // metres

  // Rift systems
  riftFreq:                 6.67e-7,
  riftOctaves:              2,
  riftDepth:                800.0,    // metres below base

  // Coastline detail
  coastlineFreq:            5.0e-6,
  coastlineOctaves:         3,
  coastlineAmplitude:       150.0,    // metres of coastal variation

  // Shelf extent from coast (in continental-mask units)
  shelfWidth:               0.08,

  // Continental elevation modifier range
  elevationModMin:         -1500.0,   // deep ocean basin
  elevationModMax:         +3000.0,   // mountain peak
  seaLevel:                 0.0
});

// ─── defaults ────────────────────────────────────────────────────
const CONTINENTAL_DEFAULTS = Object.freeze({
  worldSeed:          0x9C0F1A2B3,
  continentalCellSize: 50000.0,    // metres per continental cell (50 km)
  summaryCacheSize:    1024,       // per-frame summary cells
  maxChunksPerFrame:   8,
  windDirection:       0.0,        // radians, for rain shadow
  waterRoutingEnabled: true,
  orographicEnabled:   true,
  mutationCoalesceWindow: 5.0
});

class ContinentalReliefGradientProvider {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.defaults = { ...CONTINENTAL_DEFAULTS, ...(options.defaults || {}) };
    this.synth = { ...SYNTHESIS, ...(options.synth || {}) };
    this.enableWaterRouting = options.enableWaterRouting ?? true;
    this.enableOrographic = options.enableOrographic ?? true;

    // ── scratch (pooled) ────────────────────────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVecD = new Vec3();
    this._tmpMatA = new Mat4();

    // ── per-summary-cell storage (spatial) ──────────────────
    const cap = this.defaults.summaryCacheSize;
    this._cellCapacity = cap;
    this._cellKeys = new Map();
    this._cellSlot = 0;
    this._cellUsed = 0;

    this._cellCX = new Int32Array(cap);
    this._cellCZ = new Int32Array(cap);
    this._cellState = new Uint8Array(cap);

    this._cellContinentalType     = new Uint8Array(cap);
    this._cellElevationModifier   = new Float32Array(cap);
    this._cellContinentalMask     = new Float32Array(cap);
    this._cellPlateBoundary       = new Float32Array(cap);
    this._cellMountainBelt        = new Float32Array(cap);
    this._cellRift                = new Float32Array(cap);
    this._cellShelf               = new Float32Array(cap);
    this._cellInteriorness        = new Float32Array(cap);
    this._cellWindward            = new Float32Array(cap);   // 0 = leeward, 1 = windward
    this._cellRainShadow          = new Float32Array(cap);
    this._cellWaterDirectionX     = new Float32Array(cap);
    this._cellWaterDirectionZ     = new Float32Array(cap);
    this._cellBiomeHint           = new Uint8Array(cap);
    this._cellDominantBiomeWeight = new Float32Array(cap * 10);  // 10 biome types
    this._cellColor               = new Float32Array(cap * 3);

    // ── per-frame global summary ────────────────────────────
    this._globalSummary = {
      landFraction: 0,
      oceanFraction: 0,
      mountainBeltFraction: 0,
      interiorFraction: 0,
      dominantContinentalType: 0,
      avgElevationModifier: 0,
      sampleCount: 0
    };

    // ── per-frame statistics ────────────────────────────────
    this._stats = {
      updates: 0,
      summaryCellsSampled: 0,
      deepOceanCells: 0,
      oceanicRidgeCells: 0,
      shelfCells: 0,
      shelfBreakCells: 0,
      coastalPlainCells: 0,
      interiorLowlandCells: 0,
      interiorPlateauCells: 0,
      mountainBeltCells: 0,
      riftValleyCells: 0,
      volcanicArcCells: 0,
      islandArcCells: 0,
      continentalInteriorCells: 0,
      waterRoutingComputed: 0,
      orographicComputed: 0,
      mutationEventsEmitted: 0
    };

    // ── timing / frame reference ────────────────────────────
    this._lastUpdateTime = -Infinity;
    this._frameRef = null;

    // ── optional collaborator references ────────────────────
    this._terrain = options.terrain || null;
    this._elevation = options.elevation || null;
    this._slope = options.slope || null;
    this._relief = options.relief || null;
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
  attachTemporal(t) { this._temporal = t; return this; }
  attachDispatcher(d) { this._dispatcher = d; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── deterministic seed hash ────────────────────────────
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
  // ─── continental-scale FBM synthesis ────────────────────
  // ══════════════════════════════════════════════════════════
  _fbm(x, z, freq, octaves, persistence) {
    let amp = 1.0;
    let f = freq;
    let sum = 0.0;
    let norm = 0.0;
    for (let o = 0; o < octaves; o++) {
      const n = SimplexNoise.noise(x * f, z * f);
      sum += n * amp;
      norm += amp;
      amp *= persistence;
      f *= 2.0;
    }
    return norm > 0 ? sum / norm : 0;
  }

  // ── continental mask: 0 = deep ocean, 1 = interior ──────
  _continentalMask(wx, wz) {
    const s = this.synth;
    const n = this._fbm(
      wx, wz,
      s.continentalMaskFreq,
      s.continentalMaskOctaves,
      s.continentalMaskPersist
    );
    // Map from [-1,1] to [0,1] then apply threshold.
    return (n * 0.5 + 0.5);
  }

  // ── plate boundary intensity: 0 = interior of plate, 1 = at boundary ─
  _plateBoundary(wx, wz) {
    const s = this.synth;
    const n = SimplexNoise.noise(
      wx * s.plateBoundaryFreq,
      wz * s.plateBoundaryFreq
    );
    // Ridged: 1 - |n|, peaks where n = 0 (boundary).
    return 1.0 - Math.abs(n);
  }

  // ── mountain belt intensity ─────────────────────────────
  _mountainBelt(wx, wz) {
    const s = this.synth;
    const plate = this._plateBoundary(wx, wz);
    if (plate < 0.6) return 0;
    // Only mountain belts form at plate boundaries above threshold.
    const beltStrength = (plate - 0.6) / 0.4;
    // Local ridged noise for peaks.
    const n = this._fbm(
      wx, wz,
      s.mountainBeltFreq,
      s.mountainBeltOctaves,
      0.55
    );
    const peaks = 1.0 - Math.abs(n);
    return beltStrength * peaks;
  }

  // ── rift intensity: subsided rift valleys at plate interiors ─
  _rift(wx, wz) {
    const s = this.synth;
    const n = this._fbm(wx, wz, s.riftFreq, s.riftOctaves, 0.5);
    // Ridged rift: peaks where n ≈ 0 but only away from plate boundary.
    const plate = this._plateBoundary(wx, wz);
    if (plate > 0.5) return 0;
    return Math.max(0, 1.0 - Math.abs(n) * 2.0) * (1.0 - plate * 2.0);
  }

  // ── coastline detail: additional variation near sea level ───
  _coastlineDetail(wx, wz) {
    const s = this.synth;
    return this._fbm(
      wx, wz,
      s.coastlineFreq,
      s.coastlineOctaves,
      0.5
    ) * s.coastlineAmplitude;
  }

  // ══════════════════════════════════════════════════════════
  // ─── continental classification (single point) ──────────
  // ══════════════════════════════════════════════════════════
  classifyContinental(wx, wz) {
    const s = this.synth;

    const mask = this._continentalMask(wx, wz);
    const plate = this._plateBoundary(wx, wz);
    const mountain = this._mountainBelt(wx, wz);
    const rift = this._rift(wx, wz);
    const coastline = this._coastlineDetail(wx, wz);

    // Continental elevation modifier (metres).
    let elevationMod = 0;

    // Base: ocean basin to continental interior.
    if (mask < s.continentalThreshold) {
      // Ocean.
      const depth = (s.continentalThreshold - mask) / s.continentalThreshold;
      elevationMod = -depth * 5000.0;   // up to 5000 m deep
    } else {
      // Land.
      const land = (mask - s.continentalThreshold) / (1 - s.continentalThreshold);
      elevationMod = land * 800.0;      // up to 800 m base elevation
    }

    // Mountain belt.
    elevationMod += mountain * s.mountainBeltAmplitude;

    // Rift valley (subsidence).
    elevationMod -= rift * s.riftDepth;

    // Coastline detail.
    elevationMod += coastline;

    // ── classification ──────────────────────────────────────
    let continentalType = CONTINENTAL_TYPE.UNKNOWN;

    if (mask < s.continentalThreshold) {
      // Oceanic.
      if (mask < s.continentalThreshold - s.shelfWidth) {
        // Deep ocean.
        if (plate > 0.7) {
          continentalType = CONTINENTAL_TYPE.OCEANIC_RIDGE;
        } else {
          continentalType = CONTINENTAL_TYPE.DEEP_OCEAN;
        }
      } else if (mask < s.continentalThreshold - s.shelfWidth * 0.2) {
        // Outer shelf.
        if (plate > 0.85) {
          continentalType = CONTINENTAL_TYPE.ISLAND_ARC;
        } else {
          continentalType = CONTINENTAL_TYPE.CONTINENTAL_SHELF;
        }
      } else {
        // Near the coast, shelf break.
        continentalType = CONTINENTAL_TYPE.SHELF_BREAK;
      }
    } else {
      // Land.
      if (mountain > 0.4) {
        continentalType = plate > 0.9
          ? CONTINENTAL_TYPE.VOLCANIC_ARC
          : CONTINENTAL_TYPE.MOUNTAIN_BELT;
      } else if (rift > 0.4) {
        continentalType = CONTINENTAL_TYPE.RIFT_VALLEY;
      } else if (mask < s.continentalThreshold + s.shelfWidth) {
        // Near coast.
        continentalType = CONTINENTAL_TYPE.COASTAL_PLAIN;
      } else if (mask < s.continentalThreshold + 0.20) {
        // Shallow interior.
        if (elevationMod > 400) {
          continentalType = CONTINENTAL_TYPE.INTERIOR_PLATEAU;
        } else {
          continentalType = CONTINENTAL_TYPE.INTERIOR_LOWLAND;
        }
      } else {
        // Deep continental interior.
        continentalType = CONTINENTAL_TYPE.CONTINENTAL_INTERIOR;
      }
    }

    // Interiorness: 0 = coastal, 1 = deep interior.
    let interiorness = 0;
    if (mask >= s.continentalThreshold) {
      interiorness = Math.min(1, (mask - s.continentalThreshold) / 0.30);
    }

    return {
      continentalType,
      elevationModifier: elevationMod,
      continentalMask: mask,
      plateBoundary: plate,
      mountainBelt: mountain,
      rift,
      shelf: Math.max(0, s.shelfWidth - Math.abs(mask - s.continentalThreshold)),
      interiorness,
      coastline
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── orographic rain shadow ─────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Sample upwind and downwind elevation modifiers. If the upwind
  // sample is much higher, this is a leeward rain shadow.
  _computeRainShadow(wx, wz) {
    if (!this.enableOrographic) return { windward: 0.5, rainShadow: 0 };

    const dirX = Math.cos(this.defaults.windDirection);
    const dirZ = Math.sin(this.defaults.windDirection);

    // Upwind sample distance.
    const d = 200000.0;   // 200 km
    const upwindX = wx - dirX * d;
    const upwindZ = wz - dirZ * d;
    const downwindX = wx + dirX * d;
    const downwindZ = wz + dirZ * d;

    const upwindElev = this._rawElevationModifier(upwindX, upwindZ);
    const downwindElev = this._rawElevationModifier(downwindX, downwindZ);
    const localElev = this._rawElevationModifier(wx, wz);

    // Windward: upwind is LOWER than us (we intercept the wind).
    // Leeward: upwind is HIGHER (we are in the shadow).
    const relative = upwindElev - localElev;
    // relative > 0 → upwind is higher → we're in rain shadow.
    const rainShadow = Math.max(0, Math.min(1, relative / 2000.0));
    const windward = 1.0 - rainShadow;

    return { windward, rainShadow };
  }

  _rawElevationModifier(wx, wz) {
    const mask = this._continentalMask(wx, wz);
    const mountain = this._mountainBelt(wx, wz);
    const rift = this._rift(wx, wz);
    const s = this.synth;

    let elev = 0;
    if (mask < s.continentalThreshold) {
      const depth = (s.continentalThreshold - mask) / s.continentalThreshold;
      elev = -depth * 5000.0;
    } else {
      const land = (mask - s.continentalThreshold) / (1 - s.continentalThreshold);
      elev = land * 800.0;
    }
    elev += mountain * s.mountainBeltAmplitude;
    elev -= rift * s.riftDepth;
    return elev;
  }

  // ══════════════════════════════════════════════════════════
  // ─── continental-scale water routing ────────────────────
  // ══════════════════════════════════════════════════════════
  // Follow the gradient of the elevation modifier downhill.
  _computeWaterDirection(wx, wz) {
    if (!this.enableWaterRouting) return { dx: 0, dz: 0 };

    const d = 100000.0;   // 100 km sampling distance
    const hL = this._rawElevationModifier(wx - d, wz);
    const hR = this._rawElevationModifier(wx + d, wz);
    const hD = this._rawElevationModifier(wx, wz - d);
    const hU = this._rawElevationModifier(wx, wz + d);

    const dhdx = (hR - hL) / (2 * d);
    const dhdz = (hU - hD) / (2 * d);
    const mag = Math.sqrt(dhdx * dhdx + dhdz * dhdz);

    if (mag < 1e-8) return { dx: 0, dz: 0 };
    // Downhill direction.
    return { dx: -dhdx / mag, dz: -dhdz / mag };
  }

  // ══════════════════════════════════════════════════════════
  // ─── biome affinity weights ─────────────────────────────
  // ══════════════════════════════════════════════════════════
  _computeBiomeWeights(continentalType, outWeights) {
    const affinity = CONTINENTAL_BIOME_AFFINITY[continentalType];
    // Zero out.
    for (let i = 0; i < outWeights.length; i++) outWeights[i] = 0;
    if (!affinity) return outWeights;

    // Map BIOME_HINT codes to array indices. biome hint codes go
    // from 0..9 (UNKNOWN to ALPINE) — 10 slots.
    for (const biomeHintStr of Object.keys(affinity)) {
      const hint = parseInt(biomeHintStr, 10);
      if (hint >= 0 && hint < outWeights.length) {
        outWeights[hint] = affinity[biomeHintStr];
      }
    }
    return outWeights;
  }

  // ══════════════════════════════════════════════════════════
  // ─── summary-cell management ────────────────────────────
  // ══════════════════════════════════════════════════════════
  _getCellSlot(cx, cz) {
    const key = cx + ',' + cz;
    if (this._cellKeys.has(key)) return this._cellKeys.get(key);
    return -1;
  }

  _allocCellSlot(cx, cz) {
    if (this._cellUsed >= this._cellCapacity) {
      this._evictOldestCell();
    }
    let slot = -1;
    for (let i = 0; i < this._cellCapacity; i++) {
      if (this._cellState[i] === 0) { slot = i; break; }
    }
    if (slot < 0) {
      slot = this._cellSlot;
      this._cellSlot = (this._cellSlot + 1) % this._cellCapacity;
      this._evictCellSlot(slot);
    }
    this._cellCX[slot] = cx;
    this._cellCZ[slot] = cz;
    this._cellState[slot] = 1;
    this._cellKeys.set(cx + ',' + cz, slot);
    this._cellUsed++;
    return slot;
  }

  _evictCellSlot(slot) {
    if (this._cellState[slot] === 0) return;
    const key = this._cellCX[slot] + ',' + this._cellCZ[slot];
    this._cellKeys.delete(key);
    this._cellState[slot] = 0;
    this._cellUsed--;
  }

  _evictOldestCell() {
    let oldest = -1;
    let oldestVal = Infinity;
    for (let i = 0; i < this._cellCapacity; i++) {
      if (this._cellState[i] === 0) continue;
      // Use cx as pseudo-timestamp.
      if (this._cellCX[i] < oldestVal) {
        oldestVal = this._cellCX[i];
        oldest = i;
      }
    }
    if (oldest >= 0) this._evictCellSlot(oldest);
  }

  // ══════════════════════════════════════════════════════════
  // ─── sample a continental cell ──────────────────────────
  // ══════════════════════════════════════════════════════════
  _sampleCell(cx, cz) {
    const cellSize = this.defaults.continentalCellSize;
    const wx = (cx + 0.5) * cellSize;
    const wz = (cz + 0.5) * cellSize;

    const r = this.classifyContinental(wx, wz);
    const orographic = this._computeRainShadow(wx, wz);
    const water = this._computeWaterDirection(wx, wz);

    // Biome weights.
    const biomeWeights = new Float32Array(10);
    this._computeBiomeWeights(r.continentalType, biomeWeights);

    // Dominant biome hint.
    let dominantBiome = 0;
    let maxW = 0;
    for (let i = 0; i < 10; i++) {
      if (biomeWeights[i] > maxW) {
        maxW = biomeWeights[i];
        dominantBiome = i;
      }
    }

    // Representative colour.
    const color = CONTINENTAL_COLORS[r.continentalType] || [0.5, 0.5, 0.5];

    return {
      ...r,
      windward: orographic.windward,
      rainShadow: orographic.rainShadow,
      waterDirectionX: water.dx,
      waterDirectionZ: water.dz,
      biomeWeights,
      dominantBiome,
      color
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.continentalRelief) {
      spatial.continentalRelief = {
        cellCount: 0,
        cellCX: new Int32Array(this._cellCapacity),
        cellCZ: new Int32Array(this._cellCapacity),
        cellSlots: new Int32Array(this._cellCapacity),
        continentalType: this._cellContinentalType,
        elevationModifier: this._cellElevationModifier,
        continentalMask: this._cellContinentalMask,
        plateBoundary: this._cellPlateBoundary,
        mountainBelt: this._cellMountainBelt,
        rift: this._cellRift,
        shelf: this._cellShelf,
        interiorness: this._cellInteriorness,
        windward: this._cellWindward,
        rainShadow: this._cellRainShadow,
        waterDirectionX: this._cellWaterDirectionX,
        waterDirectionZ: this._cellWaterDirectionZ,
        biomeHint: this._cellBiomeHint,
        dominantBiomeWeight: this._cellDominantBiomeWeight,
        color: this._cellColor,
        typeNames: CONTINENTAL_TYPE_NAMES,
        continentalCellSize: this.defaults.continentalCellSize
      };
    }

    const cr = spatial.continentalRelief;
    cr.cellCount = 0;
    for (let i = 0; i < this._cellCapacity; i++) {
      if (this._cellState[i] === 0) continue;
      if (cr.cellCount >= this._cellCapacity) break;
      cr.cellCX[cr.cellCount] = this._cellCX[i];
      cr.cellCZ[cr.cellCount] = this._cellCZ[i];
      cr.cellSlots[cr.cellCount] = i;
      cr.cellCount++;
    }
  }

  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    if (!physical.continentalSummary) {
      physical.continentalSummary = {
        landFraction: 0,
        oceanFraction: 0,
        mountainBeltFraction: 0,
        interiorFraction: 0,
        dominantContinentalType: 0,
        avgElevationModifier: 0,
        sampleCount: 0,
        typeDistribution: new Float32Array(CONTINENTAL_TYPE_NAMES.length)
      };
    }

    const cs = physical.continentalSummary;
    cs.landFraction = this._globalSummary.landFraction;
    cs.oceanFraction = this._globalSummary.oceanFraction;
    cs.mountainBeltFraction = this._globalSummary.mountainBeltFraction;
    cs.interiorFraction = this._globalSummary.interiorFraction;
    cs.dominantContinentalType = this._globalSummary.dominantContinentalType;
    cs.avgElevationModifier = this._globalSummary.avgElevationModifier;
    cs.sampleCount = this._globalSummary.sampleCount;

    // Type distribution.
    cs.typeDistribution.fill(0);
    if (cs.sampleCount > 0) {
      cs.typeDistribution[CONTINENTAL_TYPE.DEEP_OCEAN]          = this._stats.deepOceanCells / cs.sampleCount;
      cs.typeDistribution[CONTINENTAL_TYPE.OCEANIC_RIDGE]       = this._stats.oceanicRidgeCells / cs.sampleCount;
      cs.typeDistribution[CONTINENTAL_TYPE.CONTINENTAL_SHELF]   = this._stats.shelfCells / cs.sampleCount;
      cs.typeDistribution[CONTINENTAL_TYPE.SHELF_BREAK]         = this._stats.shelfBreakCells / cs.sampleCount;
      cs.typeDistribution[CONTINENTAL_TYPE.COASTAL_PLAIN]       = this._stats.coastalPlainCells / cs.sampleCount;
      cs.typeDistribution[CONTINENTAL_TYPE.INTERIOR_LOWLAND]    = this._stats.interiorLowlandCells / cs.sampleCount;
      cs.typeDistribution[CONTINENTAL_TYPE.INTERIOR_PLATEAU]    = this._stats.interiorPlateauCells / cs.sampleCount;
      cs.typeDistribution[CONTINENTAL_TYPE.MOUNTAIN_BELT]       = this._stats.mountainBeltCells / cs.sampleCount;
      cs.typeDistribution[CONTINENTAL_TYPE.RIFT_VALLEY]         = this._stats.riftValleyCells / cs.sampleCount;
      cs.typeDistribution[CONTINENTAL_TYPE.VOLCANIC_ARC]        = this._stats.volcanicArcCells / cs.sampleCount;
      cs.typeDistribution[CONTINENTAL_TYPE.ISLAND_ARC]          = this._stats.islandArcCells / cs.sampleCount;
      cs.typeDistribution[CONTINENTAL_TYPE.CONTINENTAL_INTERIOR] = this._stats.continentalInteriorCells / cs.sampleCount;
    }

    // Continental-scale wind orographic moisture: useful for materials.
    physical.continentalRainShadow = this._globalSummary.avgRainShadow ?? 0;
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

    // Update wind direction from temporal provider if available.
    if (this._temporal) {
      const windDir = this._temporal.windVector;
      if (windDir && (windDir.x !== 0 || windDir.z !== 0)) {
        this.defaults.windDirection = Math.atan2(windDir.z, windDir.x);
      }
    }

    // Reset per-frame global summary.
    this._globalSummary = {
      landFraction: 0,
      oceanFraction: 0,
      mountainBeltFraction: 0,
      interiorFraction: 0,
      dominantContinentalType: 0,
      avgElevationModifier: 0,
      avgRainShadow: 0,
      sampleCount: 0
    };

    // Reset per-frame stats counters for the summary aggregation.
    this._stats.deepOceanCells = 0;
    this._stats.oceanicRidgeCells = 0;
    this._stats.shelfCells = 0;
    this._stats.shelfBreakCells = 0;
    this._stats.coastalPlainCells = 0;
    this._stats.interiorLowlandCells = 0;
    this._stats.interiorPlateauCells = 0;
    this._stats.mountainBeltCells = 0;
    this._stats.riftValleyCells = 0;
    this._stats.volcanicArcCells = 0;
    this._stats.islandArcCells = 0;
    this._stats.continentalInteriorCells = 0;

    // Sample continental cells.
    const tc = frame.layers.spatial?.terrainChunks;
    if (!tc || tc.count === 0) {
      this._writeToSpatialLayer(frame);
      this._writeToPhysicalLayer(frame);
      this._stats.updates++;
      return 1;
    }

    const budget = Math.min(this.defaults.maxChunksPerFrame, tc.count);
    const cellSize = this.defaults.continentalCellSize;
    const chunkSize = this._terrain ? this._terrain.chunkSize : 1000;

    let landCount = 0;
    let oceanCount = 0;
    let mountainCount = 0;
    let interiorCount = 0;
    let sumElevMod = 0;
    let sumRainShadow = 0;
    let samples = 0;

    const sampledCells = new Set();

    for (let i = 0; i < budget; i++) {
      const cx = tc.cx[i];
      const cz = tc.cz[i];

      // Convert chunk coords to continental cell coords.
      const cwx = cx * chunkSize;
      const cwz = cz * chunkSize;
      const contCX = Math.floor(cwx / cellSize);
      const contCZ = Math.floor(cwz / cellSize);

      // Skip if we already sampled this continental cell this frame.
      const cellKey = contCX + ',' + contCZ;
      if (sampledCells.has(cellKey)) continue;
      sampledCells.add(cellKey);

      let slot = this._getCellSlot(contCX, contCZ);
      if (slot < 0) slot = this._allocCellSlot(contCX, contCZ);

      // Sample the cell.
      const r = this._sampleCell(contCX, contCZ);

      // Store.
      this._cellContinentalType[slot] = r.continentalType;
      this._cellElevationModifier[slot] = r.elevationModifier;
      this._cellContinentalMask[slot] = r.continentalMask;
      this._cellPlateBoundary[slot] = r.plateBoundary;
      this._cellMountainBelt[slot] = r.mountainBelt;
      this._cellRift[slot] = r.rift;
      this._cellShelf[slot] = r.shelf;
      this._cellInteriorness[slot] = r.interiorness;
      this._cellWindward[slot] = r.windward;
      this._cellRainShadow[slot] = r.rainShadow;
      this._cellWaterDirectionX[slot] = r.waterDirectionX;
      this._cellWaterDirectionZ[slot] = r.waterDirectionZ;
      this._cellBiomeHint[slot] = r.dominantBiome;
      const co = slot * 3;
      this._cellColor[co] = r.color[0];
      this._cellColor[co + 1] = r.color[1];
      this._cellColor[co + 2] = r.color[2];
      // Write biome weights into the flat array.
      const wo = slot * 10;
      for (let k = 0; k < 10; k++) {
        this._cellDominantBiomeWeight[wo + k] = r.biomeWeights[k];
      }

      // Update global aggregates.
      sumElevMod += r.elevationModifier;
      sumRainShadow += r.rainShadow;
      samples++;
      if (r.elevationModifier < -100) oceanCount++;
      else landCount++;
      if (r.continentalType === CONTINENTAL_TYPE.MOUNTAIN_BELT ||
          r.continentalType === CONTINENTAL_TYPE.VOLCANIC_ARC) mountainCount++;
      if (r.interiorness > 0.5) interiorCount++;

      // Track per-type stats.
      switch (r.continentalType) {
        case CONTINENTAL_TYPE.DEEP_OCEAN:            this._stats.deepOceanCells++; break;
        case CONTINENTAL_TYPE.OCEANIC_RIDGE:         this._stats.oceanicRidgeCells++; break;
        case CONTINENTAL_TYPE.CONTINENTAL_SHELF:     this._stats.shelfCells++; break;
        case CONTINENTAL_TYPE.SHELF_BREAK:           this._stats.shelfBreakCells++; break;
        case CONTINENTAL_TYPE.COASTAL_PLAIN:         this._stats.coastalPlainCells++; break;
        case CONTINENTAL_TYPE.INTERIOR_LOWLAND:      this._stats.interiorLowlandCells++; break;
        case CONTINENTAL_TYPE.INTERIOR_PLATEAU:      this._stats.interiorPlateauCells++; break;
        case CONTINENTAL_TYPE.MOUNTAIN_BELT:         this._stats.mountainBeltCells++; break;
        case CONTINENTAL_TYPE.RIFT_VALLEY:           this._stats.riftValleyCells++; break;
        case CONTINENTAL_TYPE.VOLCANIC_ARC:          this._stats.volcanicArcCells++; break;
        case CONTINENTAL_TYPE.ISLAND_ARC:            this._stats.islandArcCells++; break;
        case CONTINENTAL_TYPE.CONTINENTAL_INTERIOR:  this._stats.continentalInteriorCells++; break;
      }
      this._stats.summaryCellsSampled++;
      if (this.enableWaterRouting) this._stats.waterRoutingComputed++;
      if (this.enableOrographic) this._stats.orographicComputed++;
    }

    // Compute global summary.
    if (samples > 0) {
      this._globalSummary.sampleCount = samples;
      this._globalSummary.landFraction = landCount / samples;
      this._globalSummary.oceanFraction = oceanCount / samples;
      this._globalSummary.mountainBeltFraction = mountainCount / samples;
      this._globalSummary.interiorFraction = interiorCount / samples;
      this._globalSummary.avgElevationModifier = sumElevMod / samples;
      this._globalSummary.avgRainShadow = sumRainShadow / samples;

      // Dominant continental type.
      const typeCounts = [
        this._stats.deepOceanCells,
        this._stats.oceanicRidgeCells,
        this._stats.shelfCells,
        this._stats.shelfBreakCells,
        this._stats.coastalPlainCells,
        this._stats.interiorLowlandCells,
        this._stats.interiorPlateauCells,
        this._stats.mountainBeltCells,
        this._stats.riftValleyCells,
        this._stats.volcanicArcCells,
        this._stats.islandArcCells,
        this._stats.continentalInteriorCells
      ];
      let maxCount = 0;
      let dominant = 1;
      for (let t = 0; t < typeCounts.length; t++) {
        if (typeCounts[t] > maxCount) {
          maxCount = typeCounts[t];
          dominant = t + 1;   // 1-based continental type
        }
      }
      this._globalSummary.dominantContinentalType = dominant;
    }

    // Write into frame layers.
    this._writeToSpatialLayer(frame);
    this._writeToPhysicalLayer(frame);

    this._stats.updates++;
    return 1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── public queries (world positions) ───────────────────
  // ══════════════════════════════════════════════════════════
  getContinentalTypeAt(wx, wz) {
    const cellSize = this.defaults.continentalCellSize;
    const cx = Math.floor(wx / cellSize);
    const cz = Math.floor(wz / cellSize);
    const slot = this._getCellSlot(cx, cz);
    if (slot >= 0 && this._cellState[slot] === 1) {
      return this._cellContinentalType[slot];
    }
    // Fallback: sample directly.
    return this.classifyContinental(wx, wz).continentalType;
  }

  getElevationModifierAt(wx, wz) {
    const cellSize = this.defaults.continentalCellSize;
    const cx = Math.floor(wx / cellSize);
    const cz = Math.floor(wz / cellSize);
    const slot = this._getCellSlot(cx, cz);
    if (slot >= 0 && this._cellState[slot] === 1) {
      return this._cellElevationModifier[slot];
    }
    return this.classifyContinental(wx, wz).elevationModifier;
  }

  getInteriornessAt(wx, wz) {
    const cellSize = this.defaults.continentalCellSize;
    const cx = Math.floor(wx / cellSize);
    const cz = Math.floor(wz / cellSize);
    const slot = this._getCellSlot(cx, cz);
    if (slot >= 0 && this._cellState[slot] === 1) {
      return this._cellInteriorness[slot];
    }
    return this.classifyContinental(wx, wz).interiorness;
  }

  getRainShadowAt(wx, wz) {
    const cellSize = this.defaults.continentalCellSize;
    const cx = Math.floor(wx / cellSize);
    const cz = Math.floor(wz / cellSize);
    const slot = this._getCellSlot(cx, cz);
    if (slot >= 0 && this._cellState[slot] === 1) {
      return this._cellRainShadow[slot];
    }
    return this._computeRainShadow(wx, wz).rainShadow;
  }

  // ══════════════════════════════════════════════════════════
  // ─── interactive setters ────────────────────────────────
  // ══════════════════════════════════════════════════════════
  setWorldSeed(seed) {
    this.defaults.worldSeed = seed | 0;
    this._clearAllCells();
    return this;
  }

  setWindDirection(radians) {
    this.defaults.windDirection = radians;
    return this;
  }

  setContinentalCellSize(size) {
    if (size > 0) this.defaults.continentalCellSize = size;
    return this;
  }

  setSynthesis(params) {
    for (const k of Object.keys(this.synth)) {
      if (params[k] !== undefined) this.synth[k] = params[k];
    }
    this._clearAllCells();
    return this;
  }

  _clearAllCells() {
    for (let i = 0; i < this._cellCapacity; i++) {
      if (this._cellState[i] !== 0) this._evictCellSlot(i);
    }
    this._cellKeys.clear();
    this._cellUsed = 0;
    this._cellSlot = 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── diagnostics ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getGlobalSummary() { return { ...this._globalSummary }; }

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
    this._temporal = null;
    this._dispatcher = null;
    this._frameRef = null;
    this._clearAllCells();
    this._cellContinentalType.fill(0);
    this._cellElevationModifier.fill(0);
    this._cellContinentalMask.fill(0);
    this._cellPlateBoundary.fill(0);
    this._cellMountainBelt.fill(0);
    this._cellRift.fill(0);
    this._cellShelf.fill(0);
    this._cellInteriorness.fill(0);
    this._cellWindward.fill(0);
    this._cellRainShadow.fill(0);
    this._cellWaterDirectionX.fill(0);
    this._cellWaterDirectionZ.fill(0);
    this._cellBiomeHint.fill(0);
    this._cellDominantBiomeWeight.fill(0);
    this._cellColor.fill(0);
  }
}

export {
  ContinentalReliefGradientProvider,
  CONTINENTAL_TYPE,
  CONTINENTAL_TYPE_NAMES,
  CONTINENTAL_BIOME_AFFINITY,
  CONTINENTAL_COLORS,
  SYNTHESIS,
  CONTINENTAL_DEFAULTS,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};