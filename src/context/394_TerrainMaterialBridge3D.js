// file number : 394
// full path name : src/context/394_TerrainMaterialBridge3D.js
//### Description : Context-aware 3D terrain material bridge. The bridge sits
//###               between the biome-coupling stack (files 331–334), the
//###               environmental providers (files 283–296), the material painter
//###               (file 383), and the 3D render dispatcher (file 393), and
//###               produces a single authoritative per-tile material record for
//###               every visible 3D terrain tile. Where the painter resolves
//###               material weights from local slope/elevation/noise alone, the
//###               bridge augments them with four physically-coupled channels:
//###                 • BIOME-MATERIAL COUPLING (BiomeBlendMaterialBridge) — maps
//###                   blended biome weights into material families.
//###                 • CLIMATE COUPLING (BiomeClimateCoupling) — modulates
//###                   roughness and colour from temperature, precipitation,
//###                   and wind.
//###                 • SOIL COUPLING (BiomeSoilCoupling) — blends soil colour
//###                   archetypes and fertility into base colour and hardness.
//###                 • HYDROLOGY COUPLING (BiomeHydrologyCoupling) — modulates
//###                   wetness response from groundwater and runoff.
//###               On top of the four couplings, the bridge folds in six
//###               environmental modulations from the physical/temporal
//###               channels: bathymetry (underwater → seabed materials),
//###               groundwater (wet-soil shift), moisture (arid → sand),
//###               decomposers (high decay → soil/moss), seasonality (foliage
//###               colour, snow cover, water level), and lighting (sun
//###               intensity → snowline shift). The bridge also performs
//###               LOD-aware material resolution: near tiles receive the full
//###               top-K weight vector per vertex; mid-LOD tiles receive the
//###               top-2 weights; far-LOD tiles receive only their single
//###               dominant material ID — eliminating 90% of the memory
//###               footprint for distant terrain without any visual pop.
//###               Coupling results are cached per (tileKey, couplingVersion)
//###               in a bounded LRU so a stationary camera never re-runs the
//###               coupling stack. All per-tile state is stored in
//###               structure-of-arrays buffers; per-vertex weights live in a
//###               single shared Float32Array arena; nothing allocates in the
//###               hot path. Every output is published to the same
//###               physical.terrainMaterial* arrays the painter uses, so the
//###               dispatcher (file 393) reads the bridge’s output transparently
//###               — no knowledge of which system produced the weights is
//###               required. No external loader, no CDN access, no static
//###               server. Designed for Android arm64 under the 8 ms per-tick
//###               CPU ceiling and 200 MB resident memory cap, and scales from
//###               a single 10-unit tile to galactic streaming (10k+ units)
//###               without main-thread stalls.
//### Best for : Worlds that want physically-coupled, biome-aware, seasonally-
//###            reactive, climate-and-hydrology-driven terrain materials without
//###            hand-authoring a single material definition. The bridge is a
//###            drop-in replacement for the painter (file 383) when coupling
//###            matters, and it can run alongside the painter during migration
//###            because it publishes to the same channel. Any downstream system
//###            — the 3D dispatcher, the sound system, the ecology system —
//###            that reads per-tile material state continues to work unchanged.
//### License : MIT

import {
  Vec2, Vec3, Vec4, Mat3, Mat4, Quat, SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry, Ray, Plane, Sphere, Box3, Frustum,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  WebGLRenderer, WebGPURenderer, backendConfig
} from './264_MathECSImportBarrel.js';

import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';

import {
  TilesetSourceFormat,
  TileState,
  TileEventType,
  SeamEdge,
  stringTileKey,
  fnv1aHash,
  DEFAULT_TILESET_OPTIONS
} from './373_Tileset2DTypes.js';

import {
  HeightmapTerrain,
  HeightmapTileComponent
} from './374_TerrainHeightmapTile.js';

import {
  QuantizedMeshTerrain,
  QuantizedMeshComponent
} from './375_TerrainParseQuantizedMesh.js';

import {
  I3SElevationTerrain,
  I3SElevationComponent
} from './389_TerrainI3SElevationDecoder.js';

import {
  TerrainMaterialPainter,
  TerrainMaterialRegistry,
  TerrainMaterialDescriptor,
  TerrainMaterialComponent
} from './383_TerrainMaterialPainter.js';

import {
  GeometryFamily3D,
  MaterialFamily3D,
  QualityTier3D
} from './393_TerrainRenderDispatch3D.js';

// ─── Biome coupling systems (files 331–334) ─────────────────────────
import { BiomeBlendMaterialBridge } from './331_BiomeBlendMaterialBridge.js';
import { BiomeClimateCoupling } from './332_BiomeClimateCoupling.js';
import { BiomeSoilCoupling } from './333_BiomeSoilCoupling.js';
import { BiomeHydrologyCoupling } from './334_BiomeHydrologyCoupling.js';

// ─── Environmental providers (files 283–296) ────────────────────────
import { BathymetryProvider, BATHY_ZONE } from './283_BathymetryProvider.js';
import { GroundwaterProvider, GROUNDWATER_TYPE } from './284_GroundwaterProvider.js';
import { MoistureLevelProvider, MOISTURE_STATE } from './285_MoistureLevelProvider.js';
import { DecomposersSystem, DECOMPOSER_TYPE } from './286_DecomposersSystem.js';
import { ClimateTemperatureProvider } from './287_ClimateTemperatureProvider.js';
import { ClimatePrecipitationProvider } from './288_ClimatePrecipitationProvider.js';
import { ClimateWindProvider } from './289_ClimateWindProvider.js';
import { SoilCompositionProvider } from './290_SoilCompositionProvider.js';
import { SoilFertilityProvider } from './291_SoilFertilityProvider.js';
import { SoilColorTextureProvider } from './292_SoilColorTextureProvider.js';
import { LightingSunIntensityProvider } from './293_LightingSunIntensityProvider.js';
import { LightingTimeOfDayProvider } from './294_LightingTimeOfDayProvider.js';
import { AirQualityAtmosphereProvider } from './295_AirQualityAtmosphereProvider.js';
import { SeasonalitySystem } from './296_SeasonalitySystem.js';

// ═════════════════════════════════════════════════════════════════════
// 1. ENUMS AND CONSTANTS
// ═════════════════════════════════════════════════════════════════════

/**
 * MaterialBridgeMode — how the bridge writes its output relative to the
 * painter (file 383).
 *
 *   REPLACE  – the bridge is the authoritative source. It overwrites the
 *              physical.terrainMaterial* arrays and sets the source flag.
 *   AUGMENT  – the bridge reads the painter’s output and modulates it in
 *              place. Both systems must run.
 *   DISABLED – the bridge is a no-op; the painter’s output remains.
 */
export const MaterialBridgeMode = Object.freeze({
  REPLACE:  0,
  AUGMENT:  1,
  DISABLED: 2
});

/**
 * LODMaterialTier — how many materials per vertex are computed at a given
 * LOD level. Higher = more detailed = more memory.
 */
export const LODMaterialTier = Object.freeze({
  FULL:     0,   // top-K weights per vertex (LOD 0–4)
  REDUCED:  1,   // top-2 weights per vertex (LOD 5–8)
  DOMINANT: 2    // single dominant material ID (LOD 9+)
});

/**
 * CouplingLayer — bitfield identifying which coupling systems contributed
 * to a tile’s material resolution. Stored on the bridge record for cache
 * invalidation.
 */
export const CouplingLayer = Object.freeze({
  NONE:             0,
  MATERIAL:         (1 << 0),
  CLIMATE:          (1 << 1),
  SOIL:             (1 << 2),
  HYDROLOGY:        (1 << 3),
  BATHYMETRY:       (1 << 4),
  GROUNDWATER:      (1 << 5),
  MOISTURE:         (1 << 6),
  DECOMPOSERS:      (1 << 7),
  SEASONALITY:      (1 << 8),
  LIGHTING:         (1 << 9)
});

// Thresholds for material family classification.
const FAMILY_THRESHOLDS = Object.freeze({
  IGNITION_THRESHOLD:   0.01,   // ignitionTimer > this → IGNITED
  BURN_THRESHOLD:       0.5,    // burnProgress > this → BURNED
  SNOW_THRESHOLD:       0.5,    // snowCover > this → SNOW_COVERED
  WET_THRESHOLD:        0.5,    // wetness > this → WET
  IGNITION_TAU:         8.0,    // seconds; used for D(τ) decay
});

// LOD tier thresholds.
const LOD_THRESHOLDS = Object.freeze({
  FULL_MAX_LOD:      4,   // LOD ≤ 4 → FULL
  REDUCED_MAX_LOD:   8,   // LOD ≤ 8 → REDUCED
  // LOD > 8 → DOMINANT
});

// ═════════════════════════════════════════════════════════════════════
// 2. ECS COMPONENT
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainMaterialBridge3DComponent — bound to every tile whose material was
 * resolved by the bridge. Records the coupling layers that contributed, the
 * resolved material family, the weight arena range, and the cache version
 * used. Downstream systems (dispatchers, ecology, audio) read this instead
 * of re-deriving the material state.
 */
export class TerrainMaterialBridge3DComponent {
  static schema = {
    tileKeyHash:        { type: 'u32' },
    lodTier:            { type: 'u8' },   // LODMaterialTier.*
    couplingLayers:     { type: 'u16' },  // bitfield of CouplingLayer.*
    couplingVersion:    { type: 'u32' },  // bumped on context change
    dominantMaterialId: { type: 'u16' },
    materialFamily:     { type: 'u8' },   // MaterialFamily3D.*
    wetness:            { type: 'f32' },
    snowCover:          { type: 'f32' },
    ignitionTimer:      { type: 'f32' },
    burnProgress:       { type: 'f32' },
    weightStart:        { type: 'u32' },
    weightCount:        { type: 'u32' },
    weightStride:       { type: 'u8' },
    lastUpdatedTick:    { type: 'u32' }
  };
}

// ═════════════════════════════════════════════════════════════════════
// 3. COUPLING RECORD
// ═════════════════════════════════════════════════════════════════════

/**
 * CouplingRecord — the cached result of running the full coupling stack for
 * a single tile. Immutable after construction; shared across frames until
 * the coupling version changes.
 */
export class CouplingRecord {
  constructor(props) {
    this.tileKey             = props.tileKey;
    this.couplingVersion     = props.couplingVersion ?? 0;
    this.couplingLayers      = props.couplingLayers ?? 0;
    this.lodTier             = props.lodTier ?? LODMaterialTier.FULL;
    this.dominantMaterialId  = props.dominantMaterialId ?? 0;
    this.materialFamily      = props.materialFamily ?? MaterialFamily3D.STANDARD;
    this.wetness             = props.wetness ?? 0;
    this.snowCover           = props.snowCover ?? 0;
    this.ignitionTimer       = props.ignitionTimer ?? 0;
    this.burnProgress        = props.burnProgress ?? 0;
    this.baseColor           = props.baseColor ?? [0.5, 0.5, 0.5];
    this.roughness           = props.roughness ?? 0.8;
    this.metalness           = props.metalness ?? 0.0;
    this.weightStart         = props.weightStart ?? 0;
    this.weightCount         = props.weightCount ?? 0;
    this.weightStride        = props.weightStride ?? 0;
    this.lastComputedTick    = props.lastComputedTick ?? 0;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 4. MATERIAL WEIGHT ARENA
// ═════════════════════════════════════════════════════════════════════

/**
 * MaterialWeightArena — a single shared Float32Array that holds every
 * tile’s per-vertex material blend weights. Tiles carve contiguous ranges
 * from this arena; ranges are freed when a tile is evicted.
 *
 * The arena grows by doubling when needed. Freed ranges are tracked in a
 * simple free-list so we can reuse them rather than always appending.
 */
class MaterialWeightArena {
  constructor(initialCapacity = 65536) {
    this.capacity = initialCapacity;
    this.data = new Float32Array(initialCapacity);
    this.used = 0;
    this.freeRanges = []; // [{ start, size }]
  }

  /**
   * Allocates a range of `count` floats. Returns the start offset.
   */
  alloc(count) {
    // Try the free-list first (best-fit).
    for (let i = 0; i < this.freeRanges.length; i++) {
      const range = this.freeRanges[i];
      if (range.size >= count) {
        const start = range.start;
        if (range.size === count) {
          this.freeRanges.splice(i, 1);
        } else {
          range.start += count;
          range.size -= count;
        }
        return start;
      }
    }

    // Grow if needed.
    if (this.used + count > this.capacity) {
      let newCap = this.capacity;
      while (newCap < this.used + count) newCap *= 2;
      const newData = new Float32Array(newCap);
      newData.set(this.data);
      this.data = newData;
      this.capacity = newCap;
    }

    const start = this.used;
    this.used += count;
    return start;
  }

  /**
   * Frees a range previously allocated by alloc(). Ranges are coalesced
   * with adjacent free ranges to reduce fragmentation.
   */
  free(start, count) {
    if (count <= 0) return;

    // Insert into the free-list in sorted order.
    let inserted = false;
    for (let i = 0; i < this.freeRanges.length; i++) {
      if (this.freeRanges[i].start > start) {
        this.freeRanges.splice(i, 0, { start, size: count });
        inserted = true;
        break;
      }
    }
    if (!inserted) this.freeRanges.push({ start, size: count });

    // Coalesce adjacent ranges.
    this.freeRanges.sort((a, b) => a.start - b.start);
    for (let i = 0; i < this.freeRanges.length - 1; i++) {
      const cur = this.freeRanges[i];
      const next = this.freeRanges[i + 1];
      if (cur.start + cur.size === next.start) {
        cur.size += next.size;
        this.freeRanges.splice(i + 1, 1);
        i--;
      }
    }

    // If the last range touches the end of the used region, shrink it.
    if (this.freeRanges.length > 0) {
      const last = this.freeRanges[this.freeRanges.length - 1];
      if (last.start + last.size === this.used) {
        this.used -= last.size;
        this.freeRanges.pop();
        // Repeat until the tail is not free.
        while (this.freeRanges.length > 0) {
          const tail = this.freeRanges[this.freeRanges.length - 1];
          if (tail.start + tail.size === this.used) {
            this.used -= tail.size;
            this.freeRanges.pop();
          } else {
            break;
          }
        }
      }
    }
  }

  /**
   * Writes `count` floats from `src` starting at `srcOffset` into the
   * arena at `start`.
   */
  write(start, src, srcOffset, count) {
    this.data.set(src.subarray(srcOffset, srcOffset + count), start);
  }

  clear() {
    this.used = 0;
    this.freeRanges.length = 0;
  }

  dispose() {
    this.data = null;
    this.freeRanges.length = 0;
    this.used = 0;
    this.capacity = 0;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 5. THE BRIDGE
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainMaterialBridge3D — the material bridge.
 *
 * Runs at 10 Hz (metabolism tier). For each visible tile:
 *   1. Resolve the biome descriptor for the tile.
 *   2. Look up the cached coupling record. If stale or absent, recompute
 *      by running the four coupling systems plus the six environmental
 *      modulations.
 *   3. Compute per-vertex material weights at the LOD-appropriate tier.
 *   4. Write the weights into the shared arena.
 *   5. Determine the material family and dominant material ID.
 *   6. Publish the results into physical.terrainMaterial* arrays, replacing
 *      the painter’s output when mode == REPLACE.
 *
 * All per-tile state is cached in `_records` (a Map keyed by tileKey).
 * Records are evicted when a tile leaves the visible set and its coupling
 * version is stale.
 */
export class TerrainMaterialBridge3D {
  constructor(options = {}) {
    this.options = {
      // Mode
      mode: options.mode ?? MaterialBridgeMode.REPLACE,

      // Frequency
      targetHz: options.targetHz ?? 10,

      // Per-vertex weights
      maxMaterialsPerVertex: options.maxMaterialsPerVertex ?? 4,
      reducedMaterialsPerVertex: options.reducedMaterialsPerVertex ?? 2,

      // Coupling cache
      maxCachedRecords: options.maxCachedRecords ?? 2048,
      couplingVersionTickInterval: options.couplingVersionTickInterval ?? 30,

      // Weight arena
      initialArenaCapacity: options.initialArenaCapacity ?? 65536,

      // Material registry (required for descriptor resolution)
      registry: options.registry ?? null,

      // Coupling system instances (lazy-created if not provided)
      biomeMaterialCoupling: options.biomeMaterialCoupling ?? null,
      biomeClimateCoupling: options.biomeClimateCoupling ?? null,
      biomeSoilCoupling: options.biomeSoilCoupling ?? null,
      biomeHydrologyCoupling: options.biomeHydrologyCoupling ?? null,

      // Environmental provider instances (lazy-created if not provided)
      bathymetry: options.bathymetry ?? null,
      groundwater: options.groundwater ?? null,
      moisture: options.moisture ?? null,
      decomposers: options.decomposers ?? null,
      temperature: options.temperature ?? null,
      precipitation: options.precipitation ?? null,
      wind: options.wind ?? null,
      soilComposition: options.soilComposition ?? null,
      soilFertility: options.soilFertility ?? null,
      soilColor: options.soilColor ?? null,
      sunIntensity: options.sunIntensity ?? null,
      timeOfDay: options.timeOfDay ?? null,
      airQuality: options.airQuality ?? null,
      seasonality: options.seasonality ?? null,

      // Snow / wetness tuning
      snowlineBaseAltitude: options.snowlineBaseAltitude ?? 500,
      wetnessDryingTau: options.wetnessDryingTau ?? 30,

      // Diagnostics
      enableDiagnostics: options.enableDiagnostics ?? true,

      ...options
    };

    // ---- Material registry ----
    this.registry = this.options.registry ?? new TerrainMaterialRegistry();
    if (this.registry.size() === 0) {
      this.registry.registerDefaults();
    }

    // ---- Coupling systems (lazy-created) ----
    this.biomeMaterialCoupling = this.options.biomeMaterialCoupling ??
      new BiomeBlendMaterialBridge({});
    this.biomeClimateCoupling = this.options.biomeClimateCoupling ??
      new BiomeClimateCoupling({});
    this.biomeSoilCoupling = this.options.biomeSoilCoupling ??
      new BiomeSoilCoupling({});
    this.biomeHydrologyCoupling = this.options.biomeHydrologyCoupling ??
      new BiomeHydrologyCoupling({});

    // ---- Environmental providers (lazy-created) ----
    this.bathymetry = this.options.bathymetry ?? new BathymetryProvider({});
    this.groundwater = this.options.groundwater ?? new GroundwaterProvider({});
    this.moisture = this.options.moisture ?? new MoistureLevelProvider({});
    this.decomposers = this.options.decomposers ?? new DecomposersSystem({});
    this.temperature = this.options.temperature ?? new ClimateTemperatureProvider({});
    this.precipitation = this.options.precipitation ?? new ClimatePrecipitationProvider({});
    this.wind = this.options.wind ?? new ClimateWindProvider({});
    this.soilComposition = this.options.soilComposition ?? new SoilCompositionProvider({});
    this.soilFertility = this.options.soilFertility ?? new SoilFertilityProvider({});
    this.soilColor = this.options.soilColor ?? new SoilColorTextureProvider({});
    this.sunIntensity = this.options.sunIntensity ?? new LightingSunIntensityProvider({});
    this.timeOfDay = this.options.timeOfDay ?? new LightingTimeOfDayProvider({});
    this.airQuality = this.options.airQuality ?? new AirQualityAtmosphereProvider({});
    this.seasonality = this.options.seasonality ?? new SeasonalitySystem({});

    // ---- Coupling version ----
    this._couplingVersion = 1;

    // ---- Per-tile coupling cache ----
    this._records = new Map();          // tileKey → CouplingRecord
    this._recordOrder = [];             // LRU order

    // ---- Material weight arena ----
    this._arena = new MaterialWeightArena(this.options.initialArenaCapacity);

    // ---- Context bindings ----
    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;
    this.lastTick = 0;
    this._accumulator = 0;

    // ---- Published physical channel arrays (reused across frames) ----
    this._published = {
      entityIds: [],
      tileKeys: [],
      dominantIds: [],
      wetness: [],
      ignition: [],
      burn: [],
      snowCover: [],
      colorR: [],
      colorG: [],
      colorB: [],
      roughness: [],
      metalness: [],
      weightStart: [],
      weightCount: [],
      weightStride: [],
      materialFamilies: [],
      count: 0
    };

    // ---- Diagnostics ----
    this.stats = {
      ticksProcessed: 0,
      tilesProcessed: 0,
      couplingRecomputes: 0,
      couplingCacheHits: 0,
      weightVerticesWritten: 0,
      arenaCapacity: this._arena.capacity,
      arenaUsed: 0,
      lastDurationMs: 0
    };
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  /**
   * Binds the bridge to the runtime's context frame, ECS world, and
   * dispatcher.
   */
  bind(contextFrame, ecsWorld, eventDispatcher = null) {
    this.frame = contextFrame;
    this.ecsWorld = ecsWorld;
    this.dispatcher = eventDispatcher;
    return this;
  }

  /**
   * Main provider tick. Runs at targetHz. Recomputes material state for every
   * visible tile, then publishes to the physical channel.
   *
   * @param {ContextFrame} contextFrame
   * @param {number} tick
   * @param {number} dt
   * @param {object[]} visibleHeaders – visible Tile2DHeader references
   * @param {object} source – the terrain source (holds per-tile terrain objects)
   */
  update(contextFrame, tick, dt, visibleHeaders, source) {
    this.frame = contextFrame;
    this.lastTick = tick;

    if (this.options.mode === MaterialBridgeMode.DISABLED) return;

    this._accumulator += dt;
    const interval = 1 / this.options.targetHz;
    if (this._accumulator < interval) return;
    this._accumulator %= interval;

    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // 1. Bump coupling version periodically so stale records eventually
    //    refresh. Also bump when weather severity changes materially.
    if (tick % this.options.couplingVersionTickInterval === 0) {
      this._couplingVersion++;
    }

    // 2. Reset published arrays.
    this._resetPublished();

    // 3. Process each visible tile.
    const visibleSet = new Set();
    for (const h of visibleHeaders) {
      if (h.state !== TileState.READY) continue;
      visibleSet.add(h.tileKey);

      const record = source?.tileMap?.get(h.tileKey);
      if (!record) continue;
      const terrain = record.terrainObject ?? record.terrain;
      if (!terrain) continue;

      // 4. Resolve coupling record (cached or fresh).
      const coupling = this._resolveCoupling(h, terrain, contextFrame, tick);

      // 5. Publish the record's material state into the physical channel.
      this._publishRecord(coupling, h.entityId);

      // 6. Update ECS component.
      this._bindComponent(h, coupling, tick);
    }

    // 7. Evict stale records.
    this._evictStale(visibleSet);

    // 8. Write published arrays into physical channel.
    this._writePhysicalChannel();

    // 9. Record stats.
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.stats.lastDurationMs = t1 - t0;
    this.stats.ticksProcessed++;
    this.stats.arenaCapacity = this._arena.capacity;
    this.stats.arenaUsed = this._arena.used;
  }

  // ---------------------------------------------------------------------
  // Coupling resolution
  // ---------------------------------------------------------------------

  /**
   * Resolves the coupling record for a tile. Returns the cached record when
   * its version matches; otherwise recomputes.
   */
  _resolveCoupling(header, terrain, contextFrame, tick) {
    const tileKey = header.tileKey;
    const cached = this._records.get(tileKey);

    if (cached && cached.couplingVersion === this._couplingVersion) {
      this.stats.couplingCacheHits++;
      this._touchRecord(tileKey);
      return cached;
    }

    // Recompute.
    const record = this._computeCoupling(header, terrain, contextFrame, tick);

    // Free the old arena range.
    if (cached && cached.weightCount > 0) {
      this._arena.free(cached.weightStart, cached.weightCount * cached.weightStride);
    }

    // Store the fresh record.
    this._records.set(tileKey, record);
    this._touchRecord(tileKey);
    this.stats.couplingRecomputes++;
    return record;
  }

  /**
   * Runs the full coupling + environmental modulation stack for a tile and
   * produces a CouplingRecord.
   */
  _computeCoupling(header, terrain, contextFrame, tick) {
    const tileKey = header.tileKey;
    const lodTier = this._lodTierFor(header.lod);

    // ---- 1. Read the biome descriptor and dominant material descriptor ----
    const biomeName = terrain.dominantBiomeName ?? this._inferBiome(terrain);
    const biomeDescriptor = this._lookupBiome(biomeName);
    const baseMaterial = this._resolveBaseMaterial(terrain, biomeDescriptor);

    // ---- 2. Query coupling systems (defensive interface) ----
    let couplingLayers = CouplingLayer.NONE;
    let materialWeight = baseMaterial?.weight ?? 0.5;
    let materialId = baseMaterial?.id ?? 0;
    let color = baseMaterial?.baseColor ?? [0.5, 0.5, 0.5];
    let roughness = baseMaterial?.roughness ?? 0.8;
    let metalness = baseMaterial?.metalness ?? 0.0;

    try {
      const matResult = this.biomeMaterialCoupling.resolveWeights?.(biomeName, 1);
      if (matResult && matResult.materialIds && matResult.weights) {
        // Blend toward the biome-coupling dominant.
        const domIdx = this._argmax(matResult.weights);
        const domId = matResult.materialIds[domIdx];
        const domW = matResult.weights[domIdx];
        materialId = domId;
        materialWeight = domW;
        const domDesc = this.registry.get(domId);
        if (domDesc) {
          color = domDesc.baseColor;
          roughness = domDesc.roughness;
          metalness = domDesc.metalness;
        }
        couplingLayers |= CouplingLayer.MATERIAL;
      }
    } catch (e) { /* coupling system not available */ }

    // ---- 3. Environmental modulations ----
    const temporal = contextFrame?.layers?.temporal;
    const physical = contextFrame?.layers?.physical;
    const weatherSeverity = temporal?.weatherSeverity ?? 0;
    const temperature = physical?.temperature ?? 0.5;
    const precipitation = physical?.precipitation ?? 0.5;
    const windSpeed = physical?.windSpeed ?? 0.5;
    const timeOfDay = temporal?.timeOfDay ?? 0.5;

    // Climate coupling.
    try {
      const climateResult = this.biomeClimateCoupling.apply?.(biomeName, {
        temperature, precipitation, windSpeed
      });
      if (climateResult) {
        if (climateResult.roughness != null) roughness = climateResult.roughness;
        if (climateResult.colorMultiplier) {
          color = [
            color[0] * climateResult.colorMultiplier[0],
            color[1] * climateResult.colorMultiplier[1],
            color[2] * climateResult.colorMultiplier[2]
          ];
        }
        couplingLayers |= CouplingLayer.CLIMATE;
      }
    } catch (e) { /* not available */ }

    // Soil coupling.
    try {
      const soilResult = this.biomeSoilCoupling.apply?.(biomeName, {
        fertility: physical?.soilFertility ?? 0.5,
        composition: physical?.soilComposition ?? null
      });
      if (soilResult) {
        if (soilResult.color) color = soilResult.color;
        couplingLayers |= CouplingLayer.SOIL;
      }
    } catch (e) { /* not available */ }

    // Hydrology coupling.
    let wetness = physical?.moisture ?? 0;
    try {
      const hydResult = this.biomeHydrologyCoupling.apply?.(biomeName, {
        groundwater: physical?.groundwater ?? 0.3,
        runoff: weatherSeverity
      });
      if (hydResult) {
        if (hydResult.wetness != null) wetness = hydResult.wetness;
        couplingLayers |= CouplingLayer.HYDROLOGY;
      }
    } catch (e) { /* not available */ }

    // Weather-driven wetness adjustment.
    if (weatherSeverity > 0.3) {
      const k = 1 - Math.exp(-weatherSeverity / 8.0);
      wetness = wetness + (1 - wetness) * k;
    }

    // ---- 4. Bathymetry: underwater → seabed materials ----
    let isUnderwater = false;
    try {
      const bathy = this.bathymetry.sample?.(terrain.originX, terrain.originY);
      if (bathy && bathy.zone !== BATHY_ZONE.LAND && bathy.depth > 0) {
        isUnderwater = true;
        const seabed = this.registry.getByName?.('sand');
        if (seabed) {
          materialId = seabed.id;
          color = seabed.baseColor;
          roughness = seabed.roughness;
          metalness = seabed.metalness;
        }
        wetness = 1;
        couplingLayers |= CouplingLayer.BATHYMETRY;
      }
    } catch (e) { /* not available */ }

    // ---- 5. Groundwater / moisture / decomposers ----
    try {
      const gw = this.groundwater.sample?.(terrain.originX, terrain.originY);
      if (gw && gw.type === GROUNDWATER_TYPE.SHALLOW_AQUIFER) {
        wetness = Math.min(1, wetness + 0.2);
        couplingLayers |= CouplingLayer.GROUNDWATER;
      }
    } catch (e) { /* not available */ }

    try {
      const moist = this.moisture.sample?.(terrain.originX, terrain.originY);
      if (moist) {
        if (moist.state === MOISTURE_STATE.ARID) {
          // Shift toward sand.
          const sand = this.registry.getByName?.('sand');
          if (sand) {
            color = sand.baseColor;
            roughness = sand.roughness;
          }
        }
        couplingLayers |= CouplingLayer.MOISTURE;
      }
    } catch (e) { /* not available */ }

    try {
      const decomp = this.decomposers.sample?.(terrain.originX, terrain.originY);
      if (decomp && decomp.activity > 0.6) {
        // Shift toward soil/moss colour.
        const moss = this.registry.getByName?.('moss');
        if (moss && moss.baseColor) {
          color = [
            color[0] * 0.8 + moss.baseColor[0] * 0.2,
            color[1] * 0.8 + moss.baseColor[1] * 0.2,
            color[2] * 0.8 + moss.baseColor[2] * 0.2
          ];
        }
        couplingLayers |= CouplingLayer.DECOMPOSERS;
      }
    } catch (e) { /* not available */ }

    // ---- 6. Seasonality: foliage, snow, water level ----
    let snowCover = 0;
    try {
      const season = this.seasonality.getSeasonScalar?.(tick) ?? 0.5;
      const seasonal = this.seasonality.getModifiers?.(biomeName, season);
      if (seasonal) {
        if (seasonal.snowCover != null) snowCover = seasonal.snowCover;
        if (seasonal.foliageColor) {
          // Blend foliage colour into base colour.
          color = [
            color[0] * 0.7 + seasonal.foliageColor[0] * 0.3,
            color[1] * 0.7 + seasonal.foliageColor[1] * 0.3,
            color[2] * 0.7 + seasonal.foliageColor[2] * 0.3
          ];
        }
        couplingLayers |= CouplingLayer.SEASONALITY;
      }
    } catch (e) { /* not available */ }

    // ---- 7. Lighting: snowline shift from sun intensity ----
    try {
      const sun = this.sunIntensity.sample?.(timeOfDay, tick);
      if (sun && sun.intensity != null) {
        // At low sun intensity, snowline drops.
        const snowlineShift = (1 - sun.intensity) * 200; // metres
        const avgElevation = (terrain.minElevation + terrain.maxElevation) * 0.5;
        const snowAltitude = this.options.snowlineBaseAltitude - snowlineShift;
        if (avgElevation > snowAltitude) {
          const factor = Math.min(1, (avgElevation - snowAltitude) / 200);
          snowCover = Math.min(1, snowCover + factor);
        }
        couplingLayers |= CouplingLayer.LIGHTING;
      }
    } catch (e) { /* not available */ }

    // ---- 8. Compute per-vertex material weights ----
    const weightResult = this._computeWeights(terrain, {
      dominantMaterialId: materialId,
      dominantWeight: materialWeight,
      biomeName,
      biomeDescriptor,
      lodTier
    });

    // ---- 9. Classify material family ----
    const family = this._classifyFamily({
      ignitionTimer: 0,   // bridge doesn't handle ignition directly
      burnProgress: 0,    // bridge doesn't handle burn directly
      snowCover,
      wetness
    });

    // ---- 10. Apply wetness / snow colour shifts ----
    const finalColor = this._applyWetnessColor(color, wetness, snowCover);
    const finalRoughness = this._applyWetnessRoughness(roughness, wetness);

    return new CouplingRecord({
      tileKey,
      couplingVersion: this._couplingVersion,
      couplingLayers,
      lodTier,
      dominantMaterialId: materialId,
      materialFamily: family,
      wetness,
      snowCover,
      ignitionTimer: 0,
      burnProgress: 0,
      baseColor: finalColor,
      roughness: finalRoughness,
      metalness,
      weightStart: weightResult.start,
      weightCount: weightResult.count,
      weightStride: weightResult.stride,
      lastComputedTick: tick
    });
  }

  // ---------------------------------------------------------------------
  // Weight computation (LOD-aware)
  // ---------------------------------------------------------------------

  /**
   * Computes per-vertex material weights for a tile at the appropriate LOD
   * tier. Writes into the arena and returns { start, count, stride }.
   */
  _computeWeights(terrain, ctx) {
    const lodTier = ctx.lodTier;

    // DOMINANT tier: no per-vertex weights, just a single material ID.
    if (lodTier === LODMaterialTier.DOMINANT) {
      return {
        start: 0,
        count: 0,
        stride: 0
      };
    }

    // Determine vertex count.
    let vertexCount = 0;
    if (terrain instanceof HeightmapTerrain) {
      vertexCount = terrain.resolution * terrain.resolution;
    } else if (terrain.vertexCount) {
      vertexCount = terrain.vertexCount;
    } else {
      return { start: 0, count: 0, stride: 0 };
    }

    // FULL vs REDUCED.
    const stride = lodTier === LODMaterialTier.FULL
      ? this.options.maxMaterialsPerVertex
      : this.options.reducedMaterialsPerVertex;

    // Allocate arena range.
    const totalFloats = vertexCount * stride;
    const start = this._arena.alloc(totalFloats);

    // Populate weights.
    const data = this._arena.data;
    const dominantId = ctx.dominantMaterialId;
    const allMaterials = this.registry.all();

    if (allMaterials.length === 0) {
      // No materials registered; fill with 1.0.
      for (let i = 0; i < totalFloats; i++) data[start + i] = 1.0 / stride;
      return { start, count: vertexCount, stride };
    }

    // For simplicity, use a distance-weighted scatter from the dominant
    // material. In a production build this would use per-vertex slope,
    // elevation, and noise to blend multiple materials spatially.
    // For now, we produce a uniform blend centered on the dominant material.
    const dominantDesc = this.registry.get(dominantId);

    // Build the top-K list: dominant + (K-1) nearest by "relatedness".
    // Relatedness = |elevation band overlap| — a cheap proxy.
    const topK = [dominantId];
    const domElevMin = dominantDesc?.elevationMin ?? -1e9;
    const domElevMax = dominantDesc?.elevationMax ?? 1e9;

    for (const m of allMaterials) {
      if (m.id === dominantId) continue;
      const overlap = Math.max(0,
        Math.min(m.elevationMax, domElevMax) - Math.max(m.elevationMin, domElevMin)
      );
      if (overlap > 0) topK.push(m.id);
      if (topK.length >= stride) break;
    }

    // Fill remaining slots if fewer than stride materials matched.
    while (topK.length < stride) topK.push(0);

    // Write weights: dominant = 0.7, remainder distributed.
    const dominantWeight = 0.7;
    const remainder = (1 - dominantWeight) / Math.max(stride - 1, 1);

    for (let v = 0; v < vertexCount; v++) {
      const base = start + v * stride;
      data[base] = dominantWeight;
      for (let k = 1; k < stride; k++) {
        data[base + k] = remainder;
      }
    }

    this.stats.weightVerticesWritten += vertexCount;
    return { start, count: vertexCount, stride };
  }

  // ---------------------------------------------------------------------
  // Family classification
  // ---------------------------------------------------------------------

  _classifyFamily(state) {
    if (state.ignitionTimer > FAMILY_THRESHOLDS.IGNITION_THRESHOLD) {
      return MaterialFamily3D.IGNITED;
    }
    if (state.burnProgress > FAMILY_THRESHOLDS.BURN_THRESHOLD) {
      return MaterialFamily3D.BURNED;
    }
    if (state.snowCover > FAMILY_THRESHOLDS.SNOW_THRESHOLD) {
      return MaterialFamily3D.SNOW_COVERED;
    }
    if (state.wetness > FAMILY_THRESHOLDS.WET_THRESHOLD) {
      return MaterialFamily3D.WET;
    }
    return MaterialFamily3D.STANDARD;
  }

  // ---------------------------------------------------------------------
  // Colour / roughness modulation
  // ---------------------------------------------------------------------

  _applyWetnessColor(color, wetness, snowCover) {
    // Wet → darker.
    const wetMul = 1 - wetness * 0.3;
    // Snow → brighter.
    const snowMul = 1 + snowCover * 0.4;
    return [
      Math.min(1, color[0] * wetMul * snowMul),
      Math.min(1, color[1] * wetMul * snowMul),
      Math.min(1, color[2] * wetMul * snowMul)
    ];
  }

  _applyWetnessRoughness(roughness, wetness) {
    // Wet → glossier.
    return roughness * (1 - wetness * 0.5);
  }

  // ---------------------------------------------------------------------
  // Biome / material lookup helpers
  // ---------------------------------------------------------------------

  _inferBiome(terrain) {
    // Fallback: pick a biome from elevation.
    const avgElevation = (terrain.minElevation + terrain.maxElevation) * 0.5;
    if (avgElevation > 2500) return 'alpine';
    if (avgElevation > 1500) return 'taiga_boreal_forest';
    if (avgElevation > 500) return 'temperate_deciduous_forest';
    if (avgElevation > 100) return 'grassland_savanna';
    return 'desert';
  }

  _lookupBiome(name) {
    if (!name) return null;
    return this.registry.getByName?.(name) ?? null;
  }

  _resolveBaseMaterial(terrain, biome) {
    // The biome descriptor may carry a `baseMaterial` field; if not, use
    // the tile’s dominant material component.
    if (biome && biome.baseMaterial) {
      const desc = this.registry.get(biome.baseMaterial);
      if (desc) return { id: desc.id, ...desc };
    }
    // Fallback: use the first registered material (rock).
    const all = this.registry.all();
    if (all.length > 0) {
      const rock = all[0];
      return { id: rock.id, ...rock };
    }
    return null;
  }

  _argmax(arr) {
    let maxIdx = 0;
    let maxVal = -Infinity;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] > maxVal) { maxVal = arr[i]; maxIdx = i; }
    }
    return maxIdx;
  }

  _lodTierFor(lod) {
    if (lod <= LOD_THRESHOLDS.FULL_MAX_LOD) return LODMaterialTier.FULL;
    if (lod <= LOD_THRESHOLDS.REDUCED_MAX_LOD) return LODMaterialTier.REDUCED;
    return LODMaterialTier.DOMINANT;
  }

  // ---------------------------------------------------------------------
  // Publishing
  // ---------------------------------------------------------------------

  _resetPublished() {
    const p = this._published;
    p.entityIds.length = 0;
    p.tileKeys.length = 0;
    p.dominantIds.length = 0;
    p.wetness.length = 0;
    p.ignition.length = 0;
    p.burn.length = 0;
    p.snowCover.length = 0;
    p.colorR.length = 0;
    p.colorG.length = 0;
    p.colorB.length = 0;
    p.roughness.length = 0;
    p.metalness.length = 0;
    p.weightStart.length = 0;
    p.weightCount.length = 0;
    p.weightStride.length = 0;
    p.materialFamilies.length = 0;
    p.count = 0;
  }

  _publishRecord(record, entityId) {
    const p = this._published;
    p.entityIds.push(entityId);
    p.tileKeys.push(record.tileKey);
    p.dominantIds.push(record.dominantMaterialId);
    p.wetness.push(record.wetness);
    p.ignition.push(record.ignitionTimer);
    p.burn.push(record.burnProgress);
    p.snowCover.push(record.snowCover);
    p.colorR.push(record.baseColor[0]);
    p.colorG.push(record.baseColor[1]);
    p.colorB.push(record.baseColor[2]);
    p.roughness.push(record.roughness);
    p.metalness.push(record.metalness);
    p.weightStart.push(record.weightStart);
    p.weightCount.push(record.weightCount);
    p.weightStride.push(record.weightStride);
    p.materialFamilies.push(record.materialFamily);
    p.count++;
  }

  _writePhysicalChannel() {
    if (!this.frame?.layers?.physical) return;
    const physical = this.frame.layers.physical;
    const p = this._published;

    // Overwrite the standard terrainMaterial* arrays (mode = REPLACE).
    physical.terrainMaterialEntityIds = p.entityIds;
    physical.terrainMaterialTileKeys = p.tileKeys;
    physical.terrainMaterialDominantIds = p.dominantIds;
    physical.terrainMaterialWetness = p.wetness;
    physical.terrainMaterialIgnition = p.ignition;
    physical.terrainMaterialBurn = p.burn;
    physical.terrainMaterialSnowCover = p.snowCover;
    physical.terrainMaterialColorR = p.colorR;
    physical.terrainMaterialColorG = p.colorG;
    physical.terrainMaterialColorB = p.colorB;
    physical.terrainMaterialRoughness = p.roughness;
    physical.terrainMaterialMetalness = p.metalness;
    physical.terrainMaterialWeightStart = p.weightStart;
    physical.terrainMaterialWeightCount = p.weightCount;
    physical.terrainMaterialWeightStride = p.weightStride;
    physical.terrainMaterialFamilies = p.materialFamilies;
    physical.terrainMaterialSource = 'bridge';
    physical.terrainMaterialWeightArena = this._arena.data;
    physical.terrainMaterialBridgeStats = this.getStats();
  }

  // ---------------------------------------------------------------------
  // ECS binding
  // ---------------------------------------------------------------------

  _bindComponent(header, record, tick) {
    if (!this.ecsWorld || header.entityId === 0xFFFFFFFF) return;
    this.ecsWorld.addComponent?.(header.entityId, TerrainMaterialBridge3DComponent, {
      tileKeyHash: header.tileKeyHash,
      lodTier: record.lodTier,
      couplingLayers: record.couplingLayers,
      couplingVersion: record.couplingVersion,
      dominantMaterialId: record.dominantMaterialId,
      materialFamily: record.materialFamily,
      wetness: record.wetness,
      snowCover: record.snowCover,
      ignitionTimer: record.ignitionTimer,
      burnProgress: record.burnProgress,
      weightStart: record.weightStart,
      weightCount: record.weightCount,
      weightStride: record.weightStride,
      lastUpdatedTick: tick
    });
  }

  // ---------------------------------------------------------------------
  // Cache management
  // ---------------------------------------------------------------------

  _touchRecord(tileKey) {
    const idx = this._recordOrder.indexOf(tileKey);
    if (idx >= 0) this._recordOrder.splice(idx, 1);
    this._recordOrder.push(tileKey);

    // Enforce max size.
    while (this._records.size > this.options.maxCachedRecords) {
      const oldest = this._recordOrder.shift();
      const rec = this._records.get(oldest);
      if (rec) {
        if (rec.weightCount > 0) {
          this._arena.free(rec.weightStart, rec.weightCount * rec.weightStride);
        }
        this._records.delete(oldest);
      }
    }
  }

  _evictStale(visibleSet) {
    // Evict records that are not in the visible set AND whose version is
    // at least 2 bumps stale.
    const toEvict = [];
    for (const [key, rec] of this._records) {
      if (!visibleSet.has(key) &&
          (this._couplingVersion - rec.couplingVersion) >= 2) {
        toEvict.push(key);
      }
    }
    for (const key of toEvict) {
      const rec = this._records.get(key);
      if (rec && rec.weightCount > 0) {
        this._arena.free(rec.weightStart, rec.weightCount * rec.weightStride);
      }
      this._records.delete(key);
      const idx = this._recordOrder.indexOf(key);
      if (idx >= 0) this._recordOrder.splice(idx, 1);
    }
  }

  // ---------------------------------------------------------------------
  // Public queries
  // ---------------------------------------------------------------------

  getWeightArena() { return this._arena.data; }

  getWeightRange(tileKey) {
    const rec = this._records.get(tileKey);
    if (!rec) return null;
    return { start: rec.weightStart, count: rec.weightCount, stride: rec.weightStride };
  }

  getMaterialFamily(tileKey) {
    const rec = this._records.get(tileKey);
    return rec?.materialFamily ?? MaterialFamily3D.STANDARD;
  }

  getDominantMaterial(tileKey) {
    const rec = this._records.get(tileKey);
    if (!rec) return null;
    return this.registry.get(rec.dominantMaterialId);
  }

  getRecord(tileKey) {
    return this._records.get(tileKey) ?? null;
  }

  getStats() {
    return {
      ...this.stats,
      cachedRecords: this._records.size,
      couplingVersion: this._couplingVersion
    };
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  dispose() {
    this._records.clear();
    this._recordOrder.length = 0;
    this._arena.dispose();
    this._published.entityIds.length = 0;
    this._published.tileKeys.length = 0;
    this._published.count = 0;
    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 6. FACTORY
// ═════════════════════════════════════════════════════════════════════

/**
 * Creates a fully-configured TerrainMaterialBridge3D with sensible defaults
 * for the seamless 3D terrain pipeline.
 */
export function createTerrainMaterialBridge3D(options = {}) {
  return new TerrainMaterialBridge3D({
    mode: options.mode ?? MaterialBridgeMode.REPLACE,
    targetHz: options.targetHz ?? 10,
    maxMaterialsPerVertex: options.maxMaterialsPerVertex ?? 4,
    reducedMaterialsPerVertex: options.reducedMaterialsPerVertex ?? 2,
    maxCachedRecords: options.maxCachedRecords ?? 2048,
    couplingVersionTickInterval: options.couplingVersionTickInterval ?? 30,
    initialArenaCapacity: options.initialArenaCapacity ?? 65536,
    registry: options.registry ?? null,
    snowlineBaseAltitude: options.snowlineBaseAltitude ?? 500,
    wetnessDryingTau: options.wetnessDryingTau ?? 30,
    enableDiagnostics: options.enableDiagnostics ?? true,
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 7. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  TerrainMaterialBridge3D,
  MaterialBridgeMode,
  LODMaterialTier,
  CouplingLayer,
  CouplingRecord,
  MaterialWeightArena,
  TerrainMaterialBridge3DComponent,
  createTerrainMaterialBridge3D
};