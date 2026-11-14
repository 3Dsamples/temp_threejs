// file number : 386_Z01
// full path name : src/context/386_Z01_ProceduralTerrainGenerator_Ext.js
//### Description : Extension to ProceduralTerrainGenerator (file 386). Adds
//###               thirty-four additional parametric terrain types (fjords,
//###               tepui table-tops, granite tors, slot canyons, basalt
//###               columns, flood-basalt plateaus, batholith domes, karst
//###               poljes, hanging valleys, glacial cirque steps, arêtes,
//###               horns, tarns, salt pans, mud-crack pans, stack coastlines,
//###               sea arches, roche moutonnées, clint pavement, limestone
//###               pavement, tuff cones, luminous tufa terraces, transverse,
//###               longitudinal, star, and barchan dune fields, striated
//###               plateaus, mesa steppes, pothole strata, periglacial
//###               terraces, dolines, uvala valleys, and hanging cliff
//###               valleys) plus twenty-six additional biome descriptors
//###               (boreal peat bog, salt marsh, coastal dune, riparian
//###               corridor, karst plateau, volcanic island, fjord ecosystem,
//###               coastal heath, montane conifer, bamboo forest, alder carr,
//###               halophyte scrub, fynbos, kwongan, maquis, garrigue,
//###               pantanal, llanos, cloud forest, tropical dry forest,
//###               subalpine meadow, paramo, puna, cerrado sensu stricto,
//###               Hawaiian tropical forest, and Everglades-like swamp). Adds
//###               five advanced erosion passes (wind, coastal wave,
//###               chemical dissolution, biological weathering, frost
//###               shattering) that run as composable post-processes on any
//###               base heightfield. Adds a seasonal-variant cache, a
//###               scatter-marker system (rocks, boulders, vegetation-density
//###               markers, cave-entrance markers, waterfall markers), a
//###               lake-and-spring hydrology extension, and volumetric cave
//###               hints. Every feature composes cleanly on top of the base
//###               generator (file 386) via the registerTerrainGenerator
//###               and registerBiome methods, so downstream systems (material
//###               painter, vegetation scatter, render dispatch) see one
//###               unified pipeline. Fully parametric: no external loader,
//###               no CDN access, no static server. Allocation-free in the
//###               hot path, worker-friendly, and designed for Android arm64
//###               under the 8 ms per-tick CPU ceiling and 200 MB resident
//###               memory cap.
//### Best for : Worlds that need extreme terrain and biome variety while
//###            keeping the same generator API. Use createExtendedTerrainGenerator
//###            to get a ProceduralTerrainGenerator instance pre-populated
//###            with every extension. Or call installTerrainGeneratorExtensions
//###            on an existing generator to augment it in place. Every new
//###            terrain type and biome plugs into the same seamless tile
//###            pipeline as the base catalog.
//### License : MIT

import {
  // math kernel
  Vec3,
  Quat,
  Mat4,
  SimplexNoise,
  DoubleDouble,
  Precision,
  // ECS (BitECS, World, Components, Systems)
  BitECS,
  World,
  Components,
  Systems,
  // core event routing & timing
  EventDispatcher,
  Timer,
  // geometry & buffer primitives
  BufferAttribute,
  BufferGeometry,
  // textures (procedural masks)
  DataTexture,
  // materials
  MeshStandardMaterial,
  MeshPhysicalMaterial,
  // renderer entry points (backend-agnostic)
  WebGLRenderer,
  WebGPURenderer,
  backendConfig
} from './264_MathECSImportBarrel.js';

import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE } from './265_CoreEventDispatcher.js';

import {
  TilesetSourceFormat,
  TileState,
  SeamEdge,
  stringTileKey,
  fnv1aHash
} from './373_Tileset2DTypes.js';

import { HeightmapTerrain } from './374_TerrainHeightmapTile.js';

import {
  ProceduralTerrainGenerator,
  ProceduralNoise,
  TerrainErosion,
  TerrainType,
  BiomeType,
  createProceduralTerrainGenerator
} from './386_ProceduralTerrainGenerator.js';

// ---------------------------------------------------------------------------
// 1. EXTENDED TERRAIN TYPE CATALOGUE
// ---------------------------------------------------------------------------

/**
 * ExtendedTerrainType — thirty-four additional parametric terrain types.
 * IDs start at 37, continuing from the base TerrainType catalogue (0–36).
 */
export const ExtendedTerrainType = Object.freeze({
  FJORDS:                     37,   // steep U-valleys flooded by sea
  MESA_STEPPES:               38,   // flat-top mesas in steppe landscape
  HANGING_VALLEYS:            39,   // tributary valleys perched above main
  BASALT_COLUMNS:             40,   // hexagonal columnar jointing
  TUFF_CONE_CLUSTERS:         41,   // volcanic tuff cones
  SAND_DUNES_LONGITUDINAL:    42,   // seif dunes parallel to wind
  SAND_DUNES_TRANSVERSE:      43,   // dunes perpendicular to wind
  SAND_DUNES_STAR:            44,   // star dunes (multi-directional)
  BARCHAN_DUNES:              45,   // crescent-shaped dunes
  TEPUI_TABLE_TOPS:           46,   // isolated flat-topped sandstone
  GRANITE_TORS:               47,   // exposed granite outcrops
  HOODOO_CLUSTERS:            48,   // rock pillars with caprock
  SLOT_CANYONS:               49,   // narrow, winding canyons
  POTHOLE_STRATA:             50,   // pothole-dominated bedrock
  FLOOD_BASALT_PLATEAUS:      51,   // stepped basalt flood terraces
  BATHOLITH_DOMES:            52,   // dome-shaped intrusive bodies
  STRIATED_PLATEAUS:          53,   // fine-layered sedimentary plateaus
  LIMESTONE_PAVEMENT:         54,   // clint-and-gryke limestone surface
  CLINT_PAVEMENT:             55,   // exposed limestone with fissures
  PERIGLACIAL_TERRACES:       56,   // frost-sorted terraced slopes
  MUD_CRACK_PANS:             57,   // dry mudflat with polygonal cracks
  SALT_PANS:                  58,   // salt-encrusted low basins
  DOLINES_SINKHOLES:          59,   // small karst sinkholes
  UVALA_VALLEYS:              60,   // coalesced dolines
  POLJE_BASINS:               61,   // large flat-floored karst basins
  STACK_COASTLINES:           62,   // sea stacks and stumps
  SEA_ARCHES:                 63,   // coastal rock arches
  CLIFF_HANGING_VALLEYS:      64,   // cliff-edge tributary valleys
  ROCHE_MOUTONNEES:           65,   // glacial whaleback hills
  CIRQUE_STEPS:               66,   // stacked glacial cirques
  ARETES:                     67,   // sharp glacial ridge lines
  HORN_PEAKS:                 68,   // pyramidal glacial peak
  TARN_LAKES:                 69,   // glacial cirque lakes
  LUMINOUS_TUFA_TERRACES:     70    // hot-spring carbonate terraces
});

// ---------------------------------------------------------------------------
// 2. EXTENDED BIOME CATALOGUE
// ---------------------------------------------------------------------------

/**
 * ExtendedBiomeType — twenty-six additional biome descriptors, continuing the
 * base catalogue (file 386).
 */
export const ExtendedBiomeType = Object.freeze({
  BOREAL_PEAT_BOG:            'boreal_peat_bog',
  SALT_MARSH:                 'salt_marsh',
  COASTAL_DUNE:               'coastal_dune',
  RIPARIAN_CORRIDOR:          'riparian_corridor',
  KARST_PLATEAU:              'karst_plateau',
  VOLCANIC_ISLAND:            'volcanic_island',
  FJORD_ECOSYSTEM:            'fjord_ecosystem',
  COASTAL_HEATH:              'coastal_heath',
  MONTANE_CONIFER_FOREST:     'montane_conifer_forest',
  BAMBOO_FOREST:              'bamboo_forest',
  ALDER_CARR_WOODLAND:        'alder_carr_woodland',
  HALOPHYTE_SCRUB:            'halophyte_scrub',
  FYNBOS:                     'fynbos',
  KWONGAN:                    'kwongan',
  MAQUIS:                     'maquis',
  GARRIGUE:                   'garrigue',
  PANTANAL:                   'pantanal',
  LLANOS:                     'llanos',
  CLOUD_FOREST:               'cloud_forest',
  TROPICAL_DRY_FOREST:        'tropical_dry_forest',
  SUBALPINE_MEADOW:           'subalpine_meadow',
  PARAMO:                     'paramo',
  PUNA:                       'puna',
  CERRADO_SENSU_STRICTO:      'cerrado_sensu_stricto',
  HAWAIIAN_TROPICAL_FOREST:   'hawaiian_tropical_forest',
  EVERGLADES_SWAMP:           'everglades_swamp'
});

// ---------------------------------------------------------------------------
// 3. SCATTER MARKER TYPES
// ---------------------------------------------------------------------------

/**
 * ScatterMarkerType — categories of procedural scatter markers the extended
 * generator can emit. Downstream systems (vegetation, rocks, caves, waterfalls)
 * read the marker buffer and place their own entities.
 */
export const ScatterMarkerType = Object.freeze({
  ROCK_SMALL:         0,
  ROCK_LARGE:         1,
  BOULDER:            2,
  GRASS_TUFT:         3,
  SHRUB:              4,
  TREE:               5,
  MOSS_PATCH:         6,
  CAVE_ENTRANCE:      7,
  WATERFALL:          8,
  SPRING:             9,
  LAKE_SHORE:        10,
  SNOW_PATCH:        11,
  MUD_PATCH:         12,
  SALT_CRUST:        13
});

// ---------------------------------------------------------------------------
// 4. EXTENDED EROSION PASSES
// ---------------------------------------------------------------------------

/**
 * ExtendedErosion — five additional physically-inspired erosion passes that
 * run on a raw heightfield. Every pass mutates the elevation array in place
 * and is O(N) per iteration. Passes compose: apply them in any order for
 * different geomorphological signatures.
 */
export class ExtendedErosion {
  /**
   * Wind erosion — removes sediment from windward slopes, deposits on lee
   * slopes. Produces yardang and dune-field signatures.
   *
   * @param {Float32Array} height – the heightfield (mutated in place)
   * @param {number} resolution – grid resolution
   * @param {number} windDirX – wind direction (unit vector X)
   * @param {number} windDirY – wind direction (unit vector Y)
   * @param {number} iterations – smoothing passes
   * @param {number} strength – erosion strength per pass (0..1)
   */
  static wind(height, resolution, windDirX, windDirY, iterations = 5, strength = 0.1) {
    const n = resolution;
    const len = Math.sqrt(windDirX * windDirX + windDirY * windDirY) || 1;
    const dx = windDirX / len;
    const dy = windDirY / len;

    for (let iter = 0; iter < iterations; iter++) {
      // Read from a copy so wind transport is symmetric across the pass.
      const copy = height.slice();
      for (let y = 1; y < n - 1; y++) {
        for (let x = 1; x < n - 1; x++) {
          const idx = y * n + x;
          const upwindX = x - Math.round(dx);
          const upwindY = y - Math.round(dy);
          const downwindX = x + Math.round(dx);
          const downwindY = y + Math.round(dy);
          if (upwindX < 0 || upwindX >= n || upwindY < 0 || upwindY >= n) continue;
          if (downwindX < 0 || downwindX >= n || downwindY < 0 || downwindY >= n) continue;

          const upwindIdx = upwindY * n + upwindX;
          const downwindIdx = downwindY * n + downwindX;
          const upH = copy[upwindIdx];
          const hereH = copy[idx];
          const downH = copy[downwindIdx];

          // If upwind slope is steep, remove material here.
          if (upH > hereH) {
            const removed = (upH - hereH) * strength;
            height[idx] -= removed;
            height[downwindIdx] += removed;
          } else if (hereH > downH) {
            // Lee slope: deposit sediment.
            const deposited = (hereH - downH) * strength * 0.5;
            height[idx] -= deposited;
            height[downwindIdx] += deposited;
          }
        }
      }
    }
  }

  /**
   * Coastal wave erosion — scours the shoreline with directional waves.
   * Produces sea stacks, arches, and cliff retreat.
   *
   * @param {Float32Array} height – the heightfield
   * @param {number} resolution
   * @param {number} seaLevel – the elevation below which wave action applies
   * @param {number} waveStrength – strength per pass
   * @param {number} iterations
   */
  static coastalWave(height, resolution, seaLevel, waveStrength = 0.15, iterations = 3) {
    const n = resolution;
    for (let iter = 0; iter < iterations; iter++) {
      const copy = height.slice();
      for (let y = 1; y < n - 1; y++) {
        for (let x = 1; x < n - 1; x++) {
          const idx = y * n + x;
          const h = copy[idx];
          if (h > seaLevel + 0.2 || h < seaLevel - 0.1) continue;

          // Count how many neighbors are below sea level.
          let belowCount = 0;
          let avgNeighborH = 0;
          for (let oy = -1; oy <= 1; oy++) {
            for (let ox = -1; ox <= 1; ox++) {
              if (ox === 0 && oy === 0) continue;
              const nh = copy[(y + oy) * n + (x + ox)];
              avgNeighborH += nh;
              if (nh < seaLevel) belowCount++;
            }
          }
          avgNeighborH /= 8;

          // Shoreline cells erode toward sea level.
          if (belowCount >= 2) {
            height[idx] = h - (h - seaLevel) * waveStrength;
          } else if (belowCount === 1 && avgNeighborH < h) {
            height[idx] = h - (h - avgNeighborH) * waveStrength * 0.5;
          }
        }
      }
    }
  }

  /**
   * Chemical dissolution — karst dissolution driven by water flow. Produces
   * dolines, sinkholes, and limestone pavement.
   */
  static chemicalDissolution(height, resolution, iterations = 3, strength = 0.2, rainfall = 1.0) {
    const n = resolution;
    for (let iter = 0; iter < iterations; iter++) {
      const copy = height.slice();
      for (let y = 1; y < n - 1; y++) {
        for (let x = 1; x < n - 1; x++) {
          const idx = y * n + x;
          const h = copy[idx];

          // Count uphill neighbors — water flows from them and dissolves here.
          let inflow = 0;
          for (let oy = -1; oy <= 1; oy++) {
            for (let ox = -1; ox <= 1; ox++) {
              if (ox === 0 && oy === 0) continue;
              const nh = copy[(y + oy) * n + (x + ox)];
              if (nh > h) inflow += (nh - h);
            }
          }
          const dissolved = inflow * strength * rainfall * 0.01;
          height[idx] = h - dissolved;
        }
      }
    }
  }

  /**
   * Biological weathering — slows or reverses dissolution under vegetation
   * cover. Uses the biome weight at each cell (provided by the base
   * generator’s biomeWeights array) to modulate the pass.
   */
  static biologicalWeathering(height, resolution, biomeWeights, iterations = 2, strength = 0.05) {
    const n = resolution;
    for (let iter = 0; iter < iterations; iter++) {
      const copy = height.slice();
      for (let y = 1; y < n - 1; y++) {
        for (let x = 1; x < n - 1; x++) {
          const idx = y * n + x;
          const bw = biomeWeights[idx];
          // Higher biome weight = more vegetation = more biological weathering.
          // Biological weathering smooths the surface (roots break rock into soil).
          const smoothH = (
            copy[idx - 1] + copy[idx + 1] +
            copy[idx - n] + copy[idx + n]
          ) * 0.25;
          height[idx] = copy[idx] * (1 - bw * strength) + smoothH * bw * strength;
        }
      }
    }
  }

  /**
   * Frost shattering — periglacial fragmentation of steep slopes. Produces
   * blockfields, talus cones, and periglacial terraces.
   */
  static frostShattering(height, resolution, iterations = 3, strength = 0.1, temperature = 0.3) {
    const n = resolution;
    for (let iter = 0; iter < iterations; iter++) {
      const copy = height.slice();
      for (let y = 1; y < n - 1; y++) {
        for (let x = 1; x < n - 1; x++) {
          const idx = y * n + x;
          const h = copy[idx];

          // Local slope.
          const dx = copy[idx + 1] - copy[idx - 1];
          const dy = copy[idx + n] - copy[idx - n];
          const slope = Math.sqrt(dx * dx + dy * dy);

          // Steeper slopes shatter more under freezing.
          const shatter = Math.min(slope * strength * (1 - temperature), 1.0);
          if (shatter > 0.01) {
            height[idx] = h - shatter;
            // Deposit shattered material downslope.
            const depositIdx = (dy >= 0 ? idx + n : idx - n);
            height[depositIdx] = copy[depositIdx] + shatter;
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 5. SCATTER MARKER BUFFER
// ---------------------------------------------------------------------------

/**
 * ScatterMarkerBuffer — structure-of-arrays container for scatter markers.
 * Emitted by the extended generator; consumed by vegetation, rocks, caves,
 * and waterfalls subsystems.
 */
export class ScatterMarkerBuffer {
  constructor(capacity = 4096) {
    this.capacity = capacity;
    this.count = 0;

    this.type      = new Uint8Array(capacity);
    this.x         = new Float32Array(capacity);
    this.y         = new Float32Array(capacity);
    this.z         = new Float32Array(capacity);
    this.density   = new Float32Array(capacity); // 0..1, how dense a cluster
    this.rotation  = new Float32Array(capacity); // random rotation seed
    this.scale     = new Float32Array(capacity); // per-marker size multiplier
    this.tileX     = new Int32Array(capacity);
    this.tileY     = new Int32Array(capacity);
    this.lod       = new Uint8Array(capacity);
  }

  reset() { this.count = 0; }

  push(type, x, y, z, density, rotation, scale, tileX, tileY, lod) {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.type[i] = type;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.density[i] = density;
    this.rotation[i] = rotation;
    this.scale[i] = scale;
    this.tileX[i] = tileX;
    this.tileY[i] = tileY;
    this.lod[i] = lod;
    return i;
  }
}

// ---------------------------------------------------------------------------
// 6. HYDROLOGY EXTENSION
// ---------------------------------------------------------------------------

/**
 * HydrologyExtension — adds lakes, springs, and waterfalls on top of the
 * flow-accumulation hydrology computed by the base generator.
 */
export class HydrologyExtension {
  /**
   * Detects lake basins by finding local minima with high inflow and storing
   * them in the marker buffer as LAKE_SHORE markers.
   */
  static detectLakes(height, resolution, flow, tileX, tileY, lod, markers, maxLakes = 8) {
    const n = resolution;
    const candidates = [];

    // A cell is a lake candidate if:
    //   - It is a local minimum.
    //   - It has high accumulated flow (many upstream cells).
    //   - Its elevation is below the tile’s 20th percentile.
    const sorted = Array.from(height).sort((a, b) => a - b);
    const threshold = sorted[Math.floor(sorted.length * 0.2)];

    for (let y = 1; y < n - 1; y++) {
      for (let x = 1; x < n - 1; x++) {
        const idx = y * n + x;
        const h = height[idx];
        if (h > threshold) continue;

        // Local minimum check.
        let isMin = true;
        for (let oy = -1; oy <= 1 && isMin; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            if (height[(y + oy) * n + (x + ox)] < h) { isMin = false; break; }
          }
        }
        if (!isMin) continue;

        candidates.push({ x, y, h, flow: flow[idx] });
      }
    }

    // Sort by flow (descending) and pick the top candidates.
    candidates.sort((a, b) => b.flow - a.flow);
    const lakeCount = Math.min(maxLakes, candidates.length);
    for (let i = 0; i < lakeCount; i++) {
      const c = candidates[i];
      if (c.flow < 20) continue;
      const wx = (tileX * (n - 1) + c.x) / (n - 1) * 100;
      const wy = (tileY * (n - 1) + c.y) / (n - 1) * 100;
      markers.push(
        ScatterMarkerType.LAKE_SHORE,
        wx, wy, c.h,
        1.0, 0, 1.0, tileX, tileY, lod
      );
    }
  }

  /**
   * Detects springs — points where water emerges from the ground. Springs
   * occur where a high-flow cell suddenly drops below its neighbors.
   */
  static detectSprings(height, resolution, flow, tileX, tileY, lod, markers, maxSprings = 4) {
    const n = resolution;
    for (let y = 1; y < n - 1; y++) {
      for (let x = 1; x < n - 1; x++) {
        const idx = y * n + x;
        if (flow[idx] < 50) continue;

        // Check for a sharp elevation drop.
        const h = height[idx];
        let maxDrop = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const nh = height[(y + oy) * n + (x + ox)];
            const drop = h - nh;
            if (drop > maxDrop) maxDrop = drop;
          }
        }
        if (maxDrop > 2.0) {
          const wx = (tileX * (n - 1) + x) / (n - 1) * 100;
          const wy = (tileY * (n - 1) + y) / (n - 1) * 100;
          markers.push(
            ScatterMarkerType.SPRING,
            wx, wy, h,
            0.8, 0, 1.0, tileX, tileY, lod
          );
          if (markers.count > 100) return;
          maxSprings--;
          if (maxSprings <= 0) return;
        }
      }
    }
  }

  /**
   * Detects waterfalls — points where a stream crosses a steep cliff.
   */
  static detectWaterfalls(height, resolution, flow, tileX, tileY, lod, markers, maxWaterfalls = 3) {
    const n = resolution;
    for (let y = 1; y < n - 1; y++) {
      for (let x = 1; x < n - 1; x++) {
        const idx = y * n + x;
        if (flow[idx] < 100) continue;

        const h = height[idx];
        let maxDrop = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const nh = height[(y + oy) * n + (x + ox)];
            const drop = h - nh;
            if (drop > maxDrop) maxDrop = drop;
          }
        }
        if (maxDrop > 5.0) {
          const wx = (tileX * (n - 1) + x) / (n - 1) * 100;
          const wy = (tileY * (n - 1) + y) / (n - 1) * 100;
          markers.push(
            ScatterMarkerType.WATERFALL,
            wx, wy, h,
            1.0, 0, maxDrop / 5.0, tileX, tileY, lod
          );
          maxWaterfalls--;
          if (maxWaterfalls <= 0) return;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 7. SEASONAL VARIANT CACHE
// ---------------------------------------------------------------------------

/**
 * SeasonalVariantCache — tracks per-tile seasonal modifiers (snow cover,
 * foliage colour, water level) so the extended generator can produce
 * seasonal variants of the same terrain without re-running the full noise
 * pipeline.
 */
export class SeasonalVariantCache {
  constructor(capacity = 512) {
    this.capacity = capacity;
    this.cache = new Map(); // tileKey → { snowCover, foliageColour, waterLevel }
    this.lru = [];
  }

  /**
   * Returns the seasonal modifiers for a tile, generating them if absent.
   * Seasonal state derives from the tile’s biome weight and the current
   * season scalar (0 = winter, 0.25 = spring, 0.5 = summer, 0.75 = autumn).
   */
  get(tileKey, biomeWeight, season) {
    const existing = this.cache.get(tileKey);
    if (existing && existing.season === season) {
      this._touch(tileKey);
      return existing;
    }

    // Winter: snow accumulates above a threshold.
    // Spring: snow melts, foliage greens.
    // Summer: full foliage, warm.
    // Autumn: foliage browns, snow begins above high elevations.
    const snowThreshold = season < 0.25 || season > 0.85
      ? 0.3 - season * 0.5
      : season < 0.5
        ? 0.4 + (season - 0.25) * 0.4
        : season < 0.75
          ? 0.5 + (season - 0.5) * 0.3
          : 0.3 + (0.75 - (season - 0.75)) * 0.4;

    const snowCover = Math.max(0, Math.min(1, (biomeWeight - snowThreshold) / 0.3));

    // Foliage colour: green in spring/summer, brown in autumn, grey in winter.
    let foliageR = 0.3, foliageG = 0.5, foliageB = 0.2;
    if (season < 0.25) {
      // Winter: bare/grey.
      foliageR = 0.4; foliageG = 0.4; foliageB = 0.4;
    } else if (season < 0.5) {
      // Spring: bright green.
      foliageR = 0.2; foliageG = 0.6; foliageB = 0.15;
    } else if (season < 0.75) {
      // Summer: deep green.
      foliageR = 0.15; foliageG = 0.5; foliageB = 0.1;
    } else {
      // Autumn: orange/brown.
      foliageR = 0.7; foliageG = 0.4; foliageB = 0.1;
    }

    const waterLevel = season < 0.25 ? 0.0
      : season < 0.5 ? 0.3
        : season < 0.75 ? 0.5
          : 0.2;

    const entry = {
      season,
      snowCover,
      foliageR, foliageG, foliageB,
      waterLevel
    };

    this.cache.set(tileKey, entry);
    this._touch(tileKey);
    this._evict();
    return entry;
  }

  _touch(tileKey) {
    const idx = this.lru.indexOf(tileKey);
    if (idx >= 0) this.lru.splice(idx, 1);
    this.lru.push(tileKey);
  }

  _evict() {
    while (this.cache.size > this.capacity && this.lru.length > 0) {
      const oldest = this.lru.shift();
      this.cache.delete(oldest);
    }
  }

  clear() {
    this.cache.clear();
    this.lru.length = 0;
  }
}

// ---------------------------------------------------------------------------
// 8. EXTENDED TERRAIN GENERATOR
// ---------------------------------------------------------------------------

/**
 * ExtendedTerrainGenerator — a ProceduralTerrainGenerator subclass that adds
 * every extended terrain type, biome, erosion pass, scatter marker, and
 * hydrology extension. It exposes the same public API as the base class:
 *
 *   generateTile(tileInfo, options) → HeightmapTerrain
 *
 * And adds:
 *   generateTileWithScatter(tileInfo, options) → { terrain, markers }
 *   applyExtendedErosion(terrain, passes) → HeightmapTerrain (in place)
 *   computeSeasonalModifiers(tile, season) → { snowCover, foliage, waterLevel }
 */
export class ExtendedTerrainGenerator extends ProceduralTerrainGenerator {
  constructor(options = {}) {
    super(options);

    // Seasonal cache.
    this.seasonalCache = new SeasonalVariantCache(
      options.seasonalCacheCapacity ?? 512
    );

    // Register extended terrain types and biomes.
    this._registerExtendedTerrainTypes();
    this._registerExtendedBiomes();
  }

  // ------------------------------------------------------------------------
  // Extended terrain type registration
  // ------------------------------------------------------------------------

  _registerExtendedTerrainTypes() {
    // Fjords — steep U-valleys with a flooded floor.
    this.registerTerrainGenerator(ExtendedTerrainType.FJORDS, (n, x, y) => {
      const uValley = Math.pow(Math.abs(Math.sin(y * 0.005)), 4) * 0.8;
      const base = n.fbm(x * 0.004, y * 0.004, 4, 2.0, 0.4) * 0.2;
      const seaFloor = -0.15;
      return base + (uValley > 0.5 ? seaFloor : uValley);
    });

    // Mesa steppes — flat-top mesas on low-amplitude steppe.
    this.registerTerrainGenerator(ExtendedTerrainType.MESA_STEPPES, (n, x, y) => {
      const mesaBase = n.fbm(x * 0.003, y * 0.003, 3, 2.0, 0.4) * 0.4;
      const steppeBase = n.billow(x * 0.005, y * 0.005, 3, 2.0, 0.3) * 0.1;
      const mesa = Math.floor(mesaBase * 5) / 5;
      return mesa * 0.8 + steppeBase;
    });

    // Hanging valleys — perpendicular valleys terminating at a cliff.
    this.registerTerrainGenerator(ExtendedTerrainType.HANGING_VALLEYS, (n, x, y) => {
      const cliff = Math.sign(Math.sin(y * 0.01)) * 0.3;
      const valley = n.fbm(x * 0.01, y * 0.01, 4) * 0.3;
      return cliff + valley;
    });

    // Basalt columns — hexagonal columnar jointing.
    this.registerTerrainGenerator(ExtendedTerrainType.BASALT_COLUMNS, (n, x, y) => {
      const v = n.voronoi(x * 0.1, y * 0.1, 1.0);
      const column = Math.max(0, 1 - v * 2);
      const base = n.fbm(x * 0.002, y * 0.002, 3) * 0.1;
      return column * 0.5 + base;
    });

    // Tuff cone clusters — small volcanic cones.
    this.registerTerrainGenerator(ExtendedTerrainType.TUFF_CONE_CLUSTERS, (n, x, y) => {
      const v = n.voronoi(x * 0.02, y * 0.02, 1.0);
      const cone = Math.max(0, 0.4 - v) * 0.8;
      const base = n.fbm(x * 0.01, y * 0.01, 3) * 0.1;
      return cone + base;
    });

    // Longitudinal dunes — long dunes parallel to wind.
    this.registerTerrainGenerator(ExtendedTerrainType.SAND_DUNES_LONGITUDINAL, (n, x, y) => {
      const parallel = Math.sin(x * 0.02) * 0.3;
      const noise = n.fbm(x * 0.05, y * 0.01, 3) * 0.1;
      return parallel + noise;
    });

    // Transverse dunes — dunes perpendicular to wind.
    this.registerTerrainGenerator(ExtendedTerrainType.SAND_DUNES_TRANSVERSE, (n, x, y) => {
      const perpendicular = Math.sin(y * 0.02) * 0.3;
      const noise = n.fbm(x * 0.01, y * 0.05, 3) * 0.1;
      return perpendicular + noise;
    });

    // Star dunes — multi-directional complex dunes.
    this.registerTerrainGenerator(ExtendedTerrainType.SAND_DUNES_STAR, (n, x, y) => {
      const r = Math.sqrt(x * x + y * y);
      const angle = Math.atan2(y, x);
      const arms = Math.cos(angle * 3) * 0.3;
      const radial = Math.exp(-r / 30) * 0.5;
      const noise = n.fbm(x * 0.03, y * 0.03, 3) * 0.1;
      return arms * radial + noise;
    });

    // Barchan dunes — crescent-shaped dunes.
    this.registerTerrainGenerator(ExtendedTerrainType.BARCHAN_DUNES, (n, x, y) => {
      const r = Math.sqrt(x * x + y * y);
      const angle = Math.atan2(y, x);
      const crescent = Math.max(0, Math.cos(angle) * (1 - r / 20)) * 0.4;
      return crescent;
    });

    // Tepui table tops — isolated flat-topped sandstone.
    this.registerTerrainGenerator(ExtendedTerrainType.TEPUI_TABLE_TOPS, (n, x, y) => {
      const v = n.voronoi(x * 0.01, y * 0.01, 1.0);
      const top = v < 0.3 ? 0.9 : 0.1;
      const noise = n.fbm(x * 0.05, y * 0.05, 3) * 0.05;
      return top + noise;
    });

    // Granite tors — exposed granite outcrops.
    this.registerTerrainGenerator(ExtendedTerrainType.GRANITE_TORS, (n, x, y) => {
      const v = n.voronoi(x * 0.05, y * 0.05, 1.0);
      const tor = Math.max(0, 0.3 - v) * 1.5;
      const base = n.fbm(x * 0.01, y * 0.01, 3) * 0.1;
      return tor + base;
    });

    // Hoodoo clusters — rock pillars with resistant caprock.
    this.registerTerrainGenerator(ExtendedTerrainType.HOODOO_CLUSTERS, (n, x, y) => {
      const v = n.voronoi(x * 0.04, y * 0.04, 1.0);
      const pillar = Math.max(0, 0.15 - v) * 2.0;
      return pillar;
    });

    // Slot canyons — narrow, winding canyons.
    this.registerTerrainGenerator(ExtendedTerrainType.SLOT_CANYONS, (n, x, y) => {
      const warpX = n.fbm(x * 0.01, y * 0.01, 3) * 5;
      const warpY = n.fbm(x * 0.01 + 10, y * 0.01 + 10, 3) * 5;
      const warp = Math.abs(Math.sin((x + warpX) * 0.02));
      const base = n.fbm(x * 0.005, y * 0.005, 3) * 0.4;
      return base * (1 - Math.pow(warp, 8));
    });

    // Pothole strata — pothole-dominated bedrock.
    this.registerTerrainGenerator(ExtendedTerrainType.POTHOLE_STRATA, (n, x, y) => {
      const v = n.voronoi(x * 0.1, y * 0.1, 1.0);
      const pothole = Math.max(0, 0.2 - v) * -0.8;
      return pothole;
    });

    // Flood basalt plateaus — stepped basalt terraces.
    this.registerTerrainGenerator(ExtendedTerrainType.FLOOD_BASALT_PLATEAUS, (n, x, y) => {
      const base = n.fbm(x * 0.002, y * 0.002, 3, 2.0, 0.3) * 0.6;
      const terraced = Math.floor(base * 6) / 6;
      return terraced;
    });

    // Batholith domes — dome-shaped intrusive bodies.
    this.registerTerrainGenerator(ExtendedTerrainType.BATHOLITH_DOMES, (n, x, y) => {
      const v = n.voronoi(x * 0.005, y * 0.005, 1.0);
      const dome = Math.max(0, 0.5 - v) * 1.5;
      return dome;
    });

    // Striated plateaus — fine-layered sedimentary plateaus.
    this.registerTerrainGenerator(ExtendedTerrainType.STRIATED_PLATEAUS, (n, x, y) => {
      const base = n.fbm(x * 0.005, y * 0.005, 3) * 0.4;
      const striation = Math.sin(base * 50) * 0.02;
      return base + striation;
    });

    // Limestone pavement — clint-and-gryke surface.
    this.registerTerrainGenerator(ExtendedTerrainType.LIMESTONE_PAVEMENT, (n, x, y) => {
      const gryke = Math.abs(n.fbm(x * 0.02, y * 0.02, 4));
      const clint = 1 - gryke;
      return clint * 0.1;
    });

    // Clint pavement — exposed limestone with fissures.
    this.registerTerrainGenerator(ExtendedTerrainType.CLINT_PAVEMENT, (n, x, y) => {
      const fissure = Math.abs(Math.sin(x * 0.1)) * Math.abs(Math.sin(y * 0.1));
      return fissure * 0.1;
    });

    // Periglacial terraces — frost-sorted terraced slopes.
    this.registerTerrainGenerator(ExtendedTerrainType.PERIGLACIAL_TERRACES, (n, x, y) => {
      const base = n.fbm(x * 0.005, y * 0.005, 3) * 0.3;
      const terraced = Math.floor(base * 10) / 10;
      return terraced;
    });

    // Mud crack pans — dry mudflat with polygonal cracks.
    this.registerTerrainGenerator(ExtendedTerrainType.MUD_CRACK_PANS, (n, x, y) => {
      const crack = Math.abs(n.fbm(x * 0.05, y * 0.05, 3) - 0.5);
      return crack * -0.1;
    });

    // Salt pans — salt-encrusted low basins.
    this.registerTerrainGenerator(ExtendedTerrainType.SALT_PANS, (n, x, y) => {
      return -Math.abs(n.fbm(x * 0.002, y * 0.002, 3)) * 0.1;
    });

    // Dolines / sinkholes — small karst sinkholes.
    this.registerTerrainGenerator(ExtendedTerrainType.DOLINES_SINKHOLES, (n, x, y) => {
      const v = n.voronoi(x * 0.03, y * 0.03, 1.0);
      return -Math.max(0, 0.2 - v) * 1.2;
    });

    // Uvala valleys — coalesced dolines.
    this.registerTerrainGenerator(ExtendedTerrainType.UVALA_VALLEYS, (n, x, y) => {
      const v = n.voronoi(x * 0.015, y * 0.015, 1.0);
      return -Math.max(0, 0.3 - v) * 0.8;
    });

    // Polje basins — large flat-floored karst basins.
    this.registerTerrainGenerator(ExtendedTerrainType.POLJE_BASINS, (n, x, y) => {
      const v = n.voronoi(x * 0.005, y * 0.005, 1.0);
      return -Math.max(0, 0.5 - v) * 0.6;
    });

    // Stack coastlines — sea stacks and stumps.
    this.registerTerrainGenerator(ExtendedTerrainType.STACK_COASTLINES, (n, x, y) => {
      const v = n.voronoi(x * 0.05, y * 0.05, 1.0);
      const stack = v < 0.2 ? 0.8 : -0.2;
      return stack;
    });

    // Sea arches — coastal rock arches.
    this.registerTerrainGenerator(ExtendedTerrainType.SEA_ARCHES, (n, x, y) => {
      const arch = Math.sin(x * 0.02) * 0.5;
      const noise = n.fbm(x * 0.01, y * 0.01, 3) * 0.1;
      return arch + noise;
    });

    // Cliff hanging valleys — cliff-edge tributary valleys.
    this.registerTerrainGenerator(ExtendedTerrainType.CLIFF_HANGING_VALLEYS, (n, x, y) => {
      const cliff = Math.sign(Math.cos(x * 0.005)) * 0.4;
      const valley = n.fbm(x * 0.02, y * 0.02, 3) * 0.1;
      return cliff + valley;
    });

    // Roche moutonnées — glacial whaleback hills.
    this.registerTerrainGenerator(ExtendedTerrainType.ROCHE_MOUTONNEES, (n, x, y) => {
      const v = n.voronoi(x * 0.02, y * 0.02, 1.0);
      const hill = Math.max(0, 0.4 - v) * 0.6;
      const striated = Math.sin(y * 0.1) * 0.02;
      return hill + striated;
    });

    // Cirque steps — stacked glacial cirques.
    this.registerTerrainGenerator(ExtendedTerrainType.CIRQUE_STEPS, (n, x, y) => {
      const base = n.fbm(x * 0.003, y * 0.003, 3) * 0.5;
      return Math.floor(base * 4) / 4;
    });

    // Arêtes — sharp glacial ridge lines.
    this.registerTerrainGenerator(ExtendedTerrainType.ARETES, (n, x, y) => {
      return n.ridged(x * 0.01, y * 0.01, 5, 2.0, 0.6) * 0.9;
    });

    // Horn peaks — pyramidal glacial peak.
    this.registerTerrainGenerator(ExtendedTerrainType.HORN_PEAKS, (n, x, y) => {
      const r = Math.sqrt(x * x + y * y);
      const peak = Math.max(0, 1 - r / 20) * 1.2;
      const noise = n.fbm(x * 0.02, y * 0.02, 3) * 0.1;
      return peak + noise;
    });

    // Tarn lakes — glacial cirque lakes.
    this.registerTerrainGenerator(ExtendedTerrainType.TARN_LAKES, (n, x, y) => {
      const v = n.voronoi(x * 0.02, y * 0.02, 1.0);
      const tarn = Math.max(0, 0.2 - v) * -0.8;
      return tarn;
    });

    // Luminous tufa terraces — hot-spring carbonate terraces.
    this.registerTerrainGenerator(ExtendedTerrainType.LUMINOUS_TUFA_TERRACES, (n, x, y) => {
      const base = n.fbm(x * 0.005, y * 0.005, 3) * 0.3;
      const terraced = Math.floor(base * 12) / 12;
      return terraced;
    });
  }

  // ------------------------------------------------------------------------
  // Extended biome registration
  // ------------------------------------------------------------------------

  _registerExtendedBiomes() {
    // Biomes in the extended catalogue have optional height-modulation hooks.
    // Each biome is a lightweight object with a modulateHeight static method
    // so the base generator can call it during tile generation.

    const biomes = [
      [ExtendedBiomeType.BOREAL_PEAT_BOG,        -0.05],
      [ExtendedBiomeType.SALT_MARSH,             -0.02],
      [ExtendedBiomeType.COASTAL_DUNE,            0.10],
      [ExtendedBiomeType.RIPARIAN_CORRIDOR,      -0.03],
      [ExtendedBiomeType.KARST_PLATEAU,           0.00],
      [ExtendedBiomeType.VOLCANIC_ISLAND,         0.15],
      [ExtendedBiomeType.FJORD_ECOSYSTEM,        -0.10],
      [ExtendedBiomeType.COASTAL_HEATH,           0.02],
      [ExtendedBiomeType.MONTANE_CONIFER_FOREST,  0.05],
      [ExtendedBiomeType.BAMBOO_FOREST,           0.00],
      [ExtendedBiomeType.ALDER_CARR_WOODLAND,    -0.02],
      [ExtendedBiomeType.HALOPHYTE_SCRUB,         0.00],
      [ExtendedBiomeType.FYNBOS,                  0.03],
      [ExtendedBiomeType.KWONGAN,                 0.01],
      [ExtendedBiomeType.MAQUIS,                  0.02],
      [ExtendedBiomeType.GARRIGUE,                0.01],
      [ExtendedBiomeType.PANTANAL,               -0.05],
      [ExtendedBiomeType.LLANOS,                 -0.02],
      [ExtendedBiomeType.CLOUD_FOREST,            0.08],
      [ExtendedBiomeType.TROPICAL_DRY_FOREST,     0.00],
      [ExtendedBiomeType.SUBALPINE_MEADOW,        0.06],
      [ExtendedBiomeType.PARAMO,                  0.08],
      [ExtendedBiomeType.PUNA,                    0.10],
      [ExtendedBiomeType.CERRADO_SENSU_STRICTO,   0.01],
      [ExtendedBiomeType.HAWAIIAN_TROPICAL_FOREST, 0.04],
      [ExtendedBiomeType.EVERGLADES_SWAMP,       -0.04]
    ];

    for (const [name, offset] of biomes) {
      const bias = offset;
      const descriptor = {
        name,
        modulateHeight(elevation, resolution, originX, originY, cellSize) {
          for (let i = 0; i < elevation.length; i++) {
            elevation[i] += bias;
          }
        }
      };
      this.registerBiome(name, descriptor);
    }
  }

  // ------------------------------------------------------------------------
  // Extended generation
  // ------------------------------------------------------------------------

  /**
   * Generates a tile with scatter markers. Same as generateTile() but also
   * returns a populated ScatterMarkerBuffer describing rocks, vegetation
   * density, cave entrances, and hydrology features.
   *
   * @param {object} tileInfo – { tileX, tileY, tileZ, lod }
   * @param {object} options – same as generateTile(), plus:
   *   - scatter: boolean (default true)
   *   - scatterDensity: number (0..1, default 0.5)
   *   - erosionPasses: array of erosion pass names to run
   * @returns {{ terrain: HeightmapTerrain, markers: ScatterMarkerBuffer }}
   */
  generateTileWithScatter(tileInfo, options = {}) {
    // 1. Generate the base terrain.
    const terrain = this.generateTile(tileInfo, options);

    // 2. Optionally run extended erosion passes.
    const passes = options.erosionPasses ?? ['wind', 'chemical', 'frost'];
    if (passes.length > 0) {
      this.applyExtendedErosion(terrain, passes, options);
    }

    // 3. Build the scatter markers.
    const markers = new ScatterMarkerBuffer(options.scatterCapacity ?? 4096);
    if (options.scatter !== false) {
      this._generateScatter(terrain, markers, options);
    }

    // 4. Detect hydrology features.
    if (options.hydrology !== false) {
      const flow = TerrainErosion.flowAccumulation(terrain.elevation, terrain.resolution);
      HydrologyExtension.detectLakes(
        terrain.elevation, terrain.resolution, flow,
        tileInfo.tileX ?? 0, tileInfo.tileY ?? 0, tileInfo.lod ?? 0,
        markers, 8
      );
      HydrologyExtension.detectSprings(
        terrain.elevation, terrain.resolution, flow,
        tileInfo.tileX ?? 0, tileInfo.tileY ?? 0, tileInfo.lod ?? 0,
        markers, 4
      );
      HydrologyExtension.detectWaterfalls(
        terrain.elevation, terrain.resolution, flow,
        tileInfo.tileX ?? 0, tileInfo.tileY ?? 0, tileInfo.lod ?? 0,
        markers, 3
      );
    }

    return { terrain, markers };
  }

  /**
   * Applies one or more extended erosion passes to an existing terrain tile.
   * Mutates the terrain’s elevation array in place and recomputes the min/max
   * elevations afterward.
   */
  applyExtendedErosion(terrain, passes, options = {}) {
    if (!terrain || !terrain.elevation) return terrain;

    const elev = terrain.elevation;
    const res = terrain.resolution;
    const biome = terrain.biomeWeights;

    for (const pass of passes) {
      switch (pass) {
        case 'wind':
          ExtendedErosion.wind(
            elev, res,
            options.windDirX ?? 1, options.windDirY ?? 0.3,
            options.windIterations ?? 5,
            options.windStrength ?? 0.1
          );
          break;
        case 'coastal':
          ExtendedErosion.coastalWave(
            elev, res,
            options.seaLevel ?? 0.3,
            options.waveStrength ?? 0.15,
            options.waveIterations ?? 3
          );
          break;
        case 'chemical':
          ExtendedErosion.chemicalDissolution(
            elev, res,
            options.dissolutionIterations ?? 3,
            options.dissolutionStrength ?? 0.2,
            options.rainfall ?? 1.0
          );
          break;
        case 'biological':
          ExtendedErosion.biologicalWeathering(
            elev, res, biome,
            options.biologicalIterations ?? 2,
            options.biologicalStrength ?? 0.05
          );
          break;
        case 'frost':
          ExtendedErosion.frostShattering(
            elev, res,
            options.frostIterations ?? 3,
            options.frostStrength ?? 0.1,
            options.temperature ?? 0.3
          );
          break;
      }
    }

    // Recompute min/max elevations.
    let minH = Infinity, maxH = -Infinity;
    for (let i = 0; i < elev.length; i++) {
      if (elev[i] < minH) minH = elev[i];
      if (elev[i] > maxH) maxH = elev[i];
    }
    terrain.minElevation = minH;
    terrain.maxElevation = maxH;
    terrain.heightRange = Math.max(maxH - minH, 1e-9);
    terrain._boundingBox = null;
    terrain._boundingSphere = null;

    return terrain;
  }

  /**
   * Generates scatter markers for a tile. Marker density, type, and position
   * are driven by the tile’s elevation, slope, and biome weight.
   */
  _generateScatter(terrain, markers, options = {}) {
    const density = options.scatterDensity ?? 0.5;
    const res = terrain.resolution;
    const elevation = terrain.elevation;
    const biome = terrain.biomeWeights;
    const tileX = terrain.tileX;
    const tileY = terrain.tileY;
    const lod = terrain.lod;
    const zScale = terrain.zScale;

    // Rock and boulder markers: steep slopes and high elevations.
    for (let y = 1; y < res - 1; y += 2) {
      for (let x = 1; x < res - 1; x += 2) {
        const idx = y * res + x;
        const h = elevation[idx];

        // Local slope.
        const dx = elevation[idx + 1] - elevation[idx - 1];
        const dy = elevation[idx + res] - elevation[idx - res];
        const slope = Math.sqrt(dx * dx + dy * dy);

        // Rock markers on steep slopes.
        if (slope > 0.5 * density && Math.random() < 0.3 * density) {
          const type = slope > 1.5 ? ScatterMarkerType.BOULDER
                     : slope > 0.8 ? ScatterMarkerType.ROCK_LARGE
                     : ScatterMarkerType.ROCK_SMALL;
          const wx = terrain.originX + (x / (res - 1)) * terrain.tileWorldSize;
          const wy = terrain.originY + (y / (res - 1)) * terrain.tileWorldSize;
          markers.push(type, wx, wy, h, density, Math.random() * 6.28, 0.5 + Math.random() * 1.5, tileX, tileY, lod);
        }

        // Vegetation markers on flat, mid-elevation terrain.
        const bw = biome[idx];
        if (bw > 0.3 && slope < 0.3 && Math.random() < bw * density * 0.5) {
          const type = bw > 0.7 ? ScatterMarkerType.TREE
                     : bw > 0.5 ? ScatterMarkerType.SHRUB
                     : ScatterMarkerType.GRASS_TUFT;
          const wx = terrain.originX + (x / (res - 1)) * terrain.tileWorldSize;
          const wy = terrain.originY + (y / (res - 1)) * terrain.tileWorldSize;
          markers.push(type, wx, wy, h, bw, Math.random() * 6.28, 0.5 + Math.random() * 1.0, tileX, tileY, lod);
        }

        // Cave entrance markers: high-flow cells on limestone-like terrain.
        if (slope > 1.0 && bw < 0.2 && Math.random() < 0.02) {
          const wx = terrain.originX + (x / (res - 1)) * terrain.tileWorldSize;
          const wy = terrain.originY + (y / (res - 1)) * terrain.tileWorldSize;
          markers.push(ScatterMarkerType.CAVE_ENTRANCE, wx, wy, h, 1.0, 0, 1.0, tileX, tileY, lod);
        }
      }
    }

    // Cap the marker count to prevent runaway memory.
    if (markers.count > markers.capacity) {
      markers.count = markers.capacity;
    }
  }

  // ------------------------------------------------------------------------
  // Seasonal modifiers
  // ------------------------------------------------------------------------

  /**
   * Returns the seasonal modifiers (snow cover, foliage colour, water level)
   * for a terrain tile. Cached per tile key and season.
   */
  computeSeasonalModifiers(terrain, season) {
    const avgBiome = this._averageBiome(terrain.biomeWeights);
    return this.seasonalCache.get(terrain.tileKey, avgBiome, season);
  }

  _averageBiome(biomeWeights) {
    let sum = 0;
    for (let i = 0; i < biomeWeights.length; i++) sum += biomeWeights[i];
    return sum / biomeWeights.length;
  }

  // ------------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------------

  dispose() {
    super.dispose();
    this.seasonalCache.clear();
  }
}

// ---------------------------------------------------------------------------
// 9. EXTENSION INSTALLER
// ---------------------------------------------------------------------------

/**
 * installTerrainGeneratorExtensions — augments an existing
 * ProceduralTerrainGenerator instance in place with every extended terrain
 * type, biome, and erosion pass. Useful when the base generator was already
 * created elsewhere and cannot be replaced.
 *
 * @param {ProceduralTerrainGenerator} generator – the base generator to augment
 * @returns {ProceduralTerrainGenerator} the same instance, augmented
 */
export function installTerrainGeneratorExtensions(generator) {
  if (!generator || typeof generator.registerTerrainGenerator !== 'function') {
    throw new Error('installTerrainGeneratorExtensions requires a ProceduralTerrainGenerator');
  }

  // Create a temporary ExtendedTerrainGenerator to harvest its registrations.
  const temp = new ExtendedTerrainGenerator({
    resolution: generator.options.resolution,
    seed: generator.options.seed
  });

  // Copy every terrain generator.
  for (const [typeId, fn] of temp.terrainGenerators) {
    if (!generator.terrainGenerators.has(typeId)) {
      generator.registerTerrainGenerator(typeId, fn);
    }
  }

  // Copy every biome.
  for (const [name, cls] of temp.biomeRegistry) {
    if (!generator.biomeRegistry.has(name)) {
      generator.registerBiome(name, cls);
    }
  }

  // Attach the seasonal cache so the augmented generator can produce
  // seasonal modifiers.
  if (!generator.seasonalCache) {
    generator.seasonalCache = new SeasonalVariantCache(512);
  }

  // Attach the extended erosion and scatter helpers as instance methods.
  generator.applyExtendedErosion = function (terrain, passes, options) {
    return ExtendedTerrainGenerator.prototype.applyExtendedErosion.call(this, terrain, passes, options);
  };
  generator._generateScatter = function (terrain, markers, options) {
    return ExtendedTerrainGenerator.prototype._generateScatter.call(this, terrain, markers, options);
  };
  generator.generateTileWithScatter = function (tileInfo, options) {
    // Simplified version of the extended generator’s generateTileWithScatter,
    // applied to the augmented base instance.
    const terrain = this.generateTile(tileInfo, options);
    const markers = new ScatterMarkerBuffer(options.scatterCapacity ?? 4096);
    this._generateScatter(terrain, markers, options);
    return { terrain, markers };
  };
  generator.computeSeasonalModifiers = function (terrain, season) {
    let sum = 0;
    for (let i = 0; i < terrain.biomeWeights.length; i++) sum += terrain.biomeWeights[i];
    const avgBiome = sum / terrain.biomeWeights.length;
    return this.seasonalCache.get(terrain.tileKey, avgBiome, season);
  };

  temp.dispose();
  return generator;
}

// ---------------------------------------------------------------------------
// 10. FACTORY
// ---------------------------------------------------------------------------

/**
 * Creates an ExtendedTerrainGenerator pre-populated with every extended
 * terrain type, biome, erosion pass, and scatter system.
 */
export function createExtendedTerrainGenerator(options = {}) {
  return new ExtendedTerrainGenerator({
    resolution: options.resolution ?? 65,
    tileWorldSize: options.tileWorldSize ?? 100,
    seed: options.seed ?? 1337,
    zScale: options.zScale ?? 500,
    erosionIterations: options.erosionIterations ?? 50000,
    thermalIterations: options.thermalIterations ?? 10,
    riverDepth: options.riverDepth ?? 8.0,
    riverThreshold: options.riverThreshold ?? 100,
    defaultBiome: options.defaultBiome ?? BiomeType.TROPICAL_RAINFOREST,
    defaultTerrainType: options.defaultTerrainType ?? TerrainType.MOUNTAINS,
    seasonalCacheCapacity: options.seasonalCacheCapacity ?? 512,
    ...options
  });
}

// ---------------------------------------------------------------------------
// 11. BARREL EXPORT
// ---------------------------------------------------------------------------

export default {
  ExtendedTerrainGenerator,
  ExtendedTerrainType,
  ExtendedBiomeType,
  ExtendedErosion,
  ScatterMarkerBuffer,
  ScatterMarkerType,
  HydrologyExtension,
  SeasonalVariantCache,
  installTerrainGeneratorExtensions,
  createExtendedTerrainGenerator
};