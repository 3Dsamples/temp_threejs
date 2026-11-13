// file number : 307
// full path name : src/context/307_MemoryProfiler.js
// description : Resident memory profiler — the diagnostic counterpart to 304_MemoryCeilingEnforcer that produces a complete, continuously updated map of what the living world is actually using, where, and whether it's growing without release. Where 304 tracks category totals and rejects oversize requests, 307 tracks the identity of every allocation: which geometry, which texture, which pool, which worker, which chunk, which material, which shader program. This makes memory leaks visible as a rising trend in a specific asset family rather than just a rising total. Reads from 304's per-category usage, from the renderer's renderer.info.memory (geometries, textures, programs), from 303_HLODController's node counts, from 301_AsyncAssetPriorityQueue's queue state, from 299_PersistentWorldMemory's mutation counts, from 280_TerrainProvider's chunk cache, from 282_Z07/Z08's forest and grass placement arrays, and from 306_GCPauseMonitor's pause frequency to correlate leak detection with GC pressure. Implements per-asset-family tracking via a fixed-capacity hash map (open-addressing, linear probing, 64-bit FNV-1a keys derived from asset kind + ID) that records allocation byte sizes, allocation time, last access time, and a monotonically increasing access counter. Produces three views every profiler tick (default 1 Hz): (1) CATEGORY BREAKDOWN — bytes per AllocCategory, sorted descending; (2) TOP-N ALLOCATIONS — the N largest resident allocations with asset identity and age; (3) LEAK SUSPECTS — asset families whose bytes have grown without any corresponding release in the last N seconds, sorted by growth rate. Detects four leak patterns: monotone growth (family grew every sample for K samples), forgotten release (bytes only ever increased), double allocation (same asset key re-registered without release), and unreleased teardown (assets still tracked after a dispose() call). Emits AUDIO_LIGHT causal events on leak detection, on total usage crossing each profile warning band, and on dispose() calls that leave orphaned allocations. Writes the full profile snapshot into frame.layers.physical.memoryProfile for the developer overlay and diagnostics HUD, plus a compact summary into frame.layers.spatial.memorySummary for the streaming systems that need to throttle when memory is tight. Zero allocation after first frame: all tracking entries, ring buffers, sorting scratch arrays, and event payloads are pre-allocated and reused. All Vec2/Vec3/Vec4/Mat4/Quat scratch objects are pooled for potential future use in geometry-size estimation.
// best for : Every subsystem that wants to know where memory is going — the developer overlay, streaming throttle controllers, leak test harnesses, per-scene diagnostics, save/load telemetry, and any adaptive quality system that wants to route around leak-prone systems rather than lowering global quality. Complements 304 (which denies) and 305/306 (which measure CPU and GC) by being the identity layer that makes the whole memory picture legible.
// license : MIT

import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere, Box3, Frustum,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture,
  CompressedTexture, CompressedArrayTexture, CompressedCubeTexture,
  CubeTexture, CubeDepthTexture, DepthTexture, FramebufferTexture
} from './264_MathECSImportBarrel.js';

import { ContextFrame }                                    from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES }    from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS }                   from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD }                     from './267_CoreClock.js';
import { MemoryCeilingEnforcer, MEMORY_PROFILE, MEMORY_PROFILE_NAMES,
         ALLOC_CATEGORY, ALLOC_CATEGORY_NAMES, CATEGORY_COUNT,
         MEMORY_CEILING_BYTES, PRESSURE_LEVEL, PRESSURE_LEVEL_NAMES }
                                                            from './304_MemoryCeilingEnforcer.js';
import { FrameBudgetMonitor, BUDGET_SLICE, BUDGET_SLICE_NAMES }
                                                            from './305_FrameBudgetMonitor.js';
import { GCPauseMonitor, GC_TYPE, GC_PRESSURE, GC_PRESSURE_NAMES }
                                                            from './306_GCPauseMonitor.js';
import { HLODController }                                   from './303_HLODController.js';
import { AsyncAssetPriorityQueue }                          from './301_AsyncAssetPriorityQueue.js';
import { PersistentWorldMemory }                            from './299_PersistentWorldMemory.js';
import { TerrainProvider }                                  from './280_TerrainProvider.js';
import { ForestGradientProvider }                           from './282_Z07_ForestGradientProvider.js';
import { GrassAndFlowresGradientProvider }                  from './282_Z08_GrassAndFlowresGradientProvider.js';

// ══════════════════════════════════════════════════════════════════
// ─── ASSET FAMILY TAXONOMY ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const ASSET_FAMILY = Object.freeze({
  GEOMETRY_MESH:          0,
  GEOMETRY_TERRAIN:       1,
  GEOMETRY_HLOD:          2,
  GEOMETRY_PROCEDURAL:    3,
  TEXTURE_STANDARD:       4,
  TEXTURE_3D:             5,
  TEXTURE_ARRAY:          6,
  TEXTURE_COMPRESSED:     7,
  TEXTURE_CUBE:           8,
  MATERIAL_STANDARD:      9,
  MATERIAL_PHYSICAL:      10,
  MATERIAL_TOON:          11,
  MATERIAL_NODE:          12,
  POOL_ENTITY:            13,
  POOL_SHARD:             14,
  POOL_DECAL:             15,
  POOL_CUE:               16,
  POOL_OTHER:             17,
  WORKER_BUFFER:          18,
  RENDER_TARGET:          19,
  PERSISTENT_MEMORY:      20,
  HLOD_CACHE:             21,
  ASSET_CACHE:            22,
  TERRAIN_CHUNK_CACHE:    23,
  FOREST_PLACEMENTS:      24,
  GRASS_PLACEMENTS:       25,
  SHADER_PROGRAM:         26,
  OTHER:                  27
});

const ASSET_FAMILY_NAMES = Object.freeze([
  'geometry_mesh', 'geometry_terrain', 'geometry_hlod', 'geometry_procedural',
  'texture_standard', 'texture_3d', 'texture_array', 'texture_compressed',
  'texture_cube', 'material_standard', 'material_physical', 'material_toon',
  'material_node', 'pool_entity', 'pool_shard', 'pool_decal', 'pool_cue',
  'pool_other', 'worker_buffer', 'render_target', 'persistent_memory',
  'hlod_cache', 'asset_cache', 'terrain_chunk_cache', 'forest_placements',
  'grass_placements', 'shader_program', 'other'
]);

const ASSET_FAMILY_COUNT = 28;

// ─── Asset family → alloc category mapping ────────────────────
const FAMILY_TO_CATEGORY = Object.freeze([
  ALLOC_CATEGORY.GEOMETRY,           // GEOMETRY_MESH
  ALLOC_CATEGORY.GEOMETRY,           // GEOMETRY_TERRAIN
  ALLOC_CATEGORY.HLOD_CACHE,         // GEOMETRY_HLOD
  ALLOC_CATEGORY.PROCEDURAL,         // GEOMETRY_PROCEDURAL
  ALLOC_CATEGORY.TEXTURE,            // TEXTURE_STANDARD
  ALLOC_CATEGORY.TEXTURE,            // TEXTURE_3D
  ALLOC_CATEGORY.TEXTURE,            // TEXTURE_ARRAY
  ALLOC_CATEGORY.TEXTURE,            // TEXTURE_COMPRESSED
  ALLOC_CATEGORY.TEXTURE,            // TEXTURE_CUBE
  ALLOC_CATEGORY.GEOMETRY,           // MATERIAL_STANDARD
  ALLOC_CATEGORY.GEOMETRY,           // MATERIAL_PHYSICAL
  ALLOC_CATEGORY.GEOMETRY,           // MATERIAL_TOON
  ALLOC_CATEGORY.GEOMETRY,           // MATERIAL_NODE
  ALLOC_CATEGORY.POOL,               // POOL_ENTITY
  ALLOC_CATEGORY.POOL,               // POOL_SHARD
  ALLOC_CATEGORY.POOL,               // POOL_DECAL
  ALLOC_CATEGORY.POOL,               // POOL_CUE
  ALLOC_CATEGORY.POOL,               // POOL_OTHER
  ALLOC_CATEGORY.WORKER_BUFFER,      // WORKER_BUFFER
  ALLOC_CATEGORY.RENDER_TARGET,      // RENDER_TARGET
  ALLOC_CATEGORY.PERSISTENT_MEMORY,  // PERSISTENT_MEMORY
  ALLOC_CATEGORY.HLOD_CACHE,         // HLOD_CACHE
  ALLOC_CATEGORY.ASSET_CACHE,        // ASSET_CACHE
  ALLOC_CATEGORY.GEOMETRY,           // TERRAIN_CHUNK_CACHE
  ALLOC_CATEGORY.POOL,               // FOREST_PLACEMENTS
  ALLOC_CATEGORY.POOL,               // GRASS_PLACEMENTS
  ALLOC_CATEGORY.GEOMETRY,           // SHADER_PROGRAM
  ALLOC_CATEGORY.GEOMETRY            // OTHER
]);

// ══════════════════════════════════════════════════════════════════
// ─── LEAK DETECTION PATTERNS ──────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const LEAK_PATTERN = Object.freeze({
  NONE:                   0,
  MONOTONE_GROWTH:        1,   // Grew in every sample for K samples
  FORGOTTEN_RELEASE:      2,   // Never released since first allocation
  DOUBLE_ALLOCATION:      3,   // Same key re-registered without release
  UNRELEASED_TEARDOWN:    4    // Still tracked after dispose()
});

const LEAK_PATTERN_NAMES = Object.freeze([
  'none', 'monotone_growth', 'forgotten_release',
  'double_allocation', 'unreleased_teardown'
]);

// ══════════════════════════════════════════════════════════════════
// ─── PROFILER CONSTANTS ───────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const PROFILER_CONSTANTS = Object.freeze({
  // Tracking hash map capacity (must be power of 2).
  TRACKING_CAPACITY:      8192,
  TRACKING_MASK:          8191,

  // Number of samples to keep per family for trend analysis.
  TREND_SAMPLES:          30,

  // Sample interval (frames between profiler ticks).
  // 1 Hz at 60 fps = 60 frames.
  SAMPLE_INTERVAL_MS:     1000.0,

  // Leak thresholds.
  LEAK_MONOTONE_SAMPLES:  5,        // Must grow in 5 consecutive samples
  LEAK_GROWTH_THRESHOLD:  0.05,     // 5% growth rate per sample to trigger

  // Event coalescing.
  EVENT_COALESCE_MS:      2000,

  // Top-N output.
  TOP_N_CAPACITY:         16,

  // Category warning bands (as % of total profile ceiling).
  CATEGORY_WARN_PCT:      0.25,     // 25% of total = warn
  CATEGORY_CRITICAL_PCT:  0.40,     // 40% = critical

  // Total usage warning bands.
  USAGE_WARN_PCT:         0.70,     // 70% of ceiling = warn
  USAGE_CRITICAL_PCT:     0.90      // 90% = critical
});

// ══════════════════════════════════════════════════════════════════
// ─── TRACKING ENTRY (pooled, flat) ────────────────────────────
// ══════════════════════════════════════════════════════════════════
class TrackingEntry {
  constructor() {
    this.keyLow = 0;         // 32-bit FNV-1a hash part 1
    this.keyHigh = 0;        // 32-bit FNV-1a hash part 2
    this.valid = false;
    this.family = ASSET_FAMILY.OTHER;
    this.assetId = -1;
    this.bytes = 0;
    this.allocatedAt = 0;
    this.lastAccessedAt = 0;
    this.accessCount = 0;
    this.sampleSnapshots = new Float32Array(PROFILER_CONSTANTS.TREND_SAMPLES);
    this.sampleHead = 0;
    this.sampleCount = 0;
    this.peakBytes = 0;
    this.disposed = false;
    this.disposeTime = 0;
    this.leakPattern = LEAK_PATTERN.NONE;
    this.leakDetectedAt = 0;
  }

  reset() {
    this.keyLow = 0;
    this.keyHigh = 0;
    this.valid = false;
    this.family = ASSET_FAMILY.OTHER;
    this.assetId = -1;
    this.bytes = 0;
    this.allocatedAt = 0;
    this.lastAccessedAt = 0;
    this.accessCount = 0;
    this.sampleHead = 0;
    this.sampleCount = 0;
    this.peakBytes = 0;
    this.disposed = false;
    this.disposeTime = 0;
    this.leakPattern = LEAK_PATTERN.NONE;
    this.leakDetectedAt = 0;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── MEMORY PROFILER ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class MemoryProfiler {
  constructor(options = {}) {
    // ── Configuration ────────────────────────────────────
    this.defaults = {
      sampleIntervalMs:        options.sampleIntervalMs ?? PROFILER_CONSTANTS.SAMPLE_INTERVAL_MS,
      enableLeakDetection:     options.enableLeakDetection ?? true,
      enableEvents:            options.enableEvents ?? true,
      enableTopN:              options.enableTopN ?? true,
      enableTrendAnalysis:     options.enableTrendAnalysis ?? true,
      maxTrackedAssets:        options.maxTrackedAssets ?? PROFILER_CONSTANTS.TRACKING_CAPACITY,
      eventCoalesceMs:         options.eventCoalesceMs ?? PROFILER_CONSTANTS.EVENT_COALESCE_MS,
      // Forwarding targets.
      ceilingEnforcer:         options.ceilingEnforcer ?? null,
      frameBudgetMonitor:      options.frameBudgetMonitor ?? null,
      gcMonitor:               options.gcMonitor ?? null,
      hlodController:          options.hlodController ?? null,
      assetQueue:              options.assetQueue ?? null,
      worldMemory:             options.worldMemory ?? null,
      terrainProvider:         options.terrainProvider ?? null,
      forestProvider:          options.forestProvider ?? null,
      grassProvider:           options.grassProvider ?? null
    };

    // ── Tracking table (open-addressing hash map) ─────────
    const cap = this.defaults.maxTrackedAssets;
    this._trackingTable = new Array(cap);
    for (let i = 0; i < cap; i++) this._trackingTable[i] = new TrackingEntry();
    this._trackingUsed = 0;

    // ── Per-family aggregate (bytes and count) ────────────
    this._familyBytes = new Float64Array(ASSET_FAMILY_COUNT);
    this._familyCount = new Int32Array(ASSET_FAMILY_COUNT);
    this._familyPeakBytes = new Float64Array(ASSET_FAMILY_COUNT);
    this._familySamples = new Array(ASSET_FAMILY_COUNT);
    for (let f = 0; f < ASSET_FAMILY_COUNT; f++) {
      this._familySamples[f] = {
        bytes: new Float32Array(PROFILER_CONSTANTS.TREND_SAMPLES),
        head: 0,
        count: 0,
        leakPattern: LEAK_PATTERN.NONE,
        growthRate: 0
      };
    }

    // ── Per-category aggregate (mirrors 304's per-category) ──
    this._categoryBytes = new Float64Array(CATEGORY_COUNT);
    this._categoryCount = new Int32Array(CATEGORY_COUNT);

    // ── Top-N largest allocations (sorted desc by bytes) ──
    const topN = PROFILER_CONSTANTS.TOP_N_CAPACITY;
    this._topNIndices = new Int32Array(topN);
    this._topNBytes = new Float64Array(topN);
    this._topNFamily = new Uint8Array(topN);
    this._topNAssetIds = new Int32Array(topN);
    this._topNCount = 0;

    // ── Leak suspects list ───────────────────────────────
    this._leakSuspects = new Int32Array(ASSET_FAMILY_COUNT);
    this._leakSuspectsCount = 0;

    // ── Snapshot state ───────────────────────────────────
    this._lastSampleTime = 0;
    this._nextSampleDueAt = 0;
    this._totalTrackedBytes = 0;
    this._peakTotalBytes = 0;
    this._totalAllocations = 0;
    this._totalReleases = 0;
    this._doubleAllocCount = 0;
    this._orphanCount = 0;

    // ── Pressure level based on total usage ──────────────
    this._usagePressure = PRESSURE_LEVEL.NORMAL;

    // ── Renderer info tracking (if attached) ────────────
    this._renderer = options.renderer || null;
    this._lastRendererGeometries = 0;
    this._lastRendererTextures = 0;
    this._lastRendererPrograms = 0;

    // ── Scratch (pooled) ─────────────────────────────────
    this._tmpVec3A = new Vec3();
    this._tmpVec3B = new Vec3();
    this._tmpVec4 = new Vec4();
    this._tmpMat4 = new Mat4();
    this._tmpQuat = new Quat();

    // Sorting scratch (reused).
    this._sortScratchIndices = new Int32Array(this.defaults.maxTrackedAssets);
    this._sortScratchBytes = new Float64Array(this.defaults.maxTrackedAssets);

    // ── Statistics ──────────────────────────────────────
    this._stats = {
      samples: 0,
      registrations: 0,
      releases: 0,
      doubleAllocations: 0,
      orphans: 0,
      leaksDetected: 0,
      leakEventsEmitted: 0,
      usageWarnEvents: 0,
      usageCriticalEvents: 0,
      categoryWarnEvents: 0,
      categoryCriticalEvents: 0,
      topNRefreshes: 0
    };

    // ── Event coalescing ─────────────────────────────────
    this._lastEventTime = 0;
    this._lastUsageEventTime = 0;

    // ── Collaborators ───────────────────────────────────
    this._dispatcher = options.dispatcher || null;
    this._clock = options.clock || null;
    this._ceilingEnforcer = this.defaults.ceilingEnforcer;
    this._frameBudgetMonitor = this.defaults.frameBudgetMonitor;
    this._gcMonitor = this.defaults.gcMonitor;
    this._hlodController = this.defaults.hlodController;
    this._assetQueue = this.defaults.assetQueue;
    this._worldMemory = this.defaults.worldMemory;
    this._terrainProvider = this.defaults.terrainProvider;
    this._forestProvider = this.defaults.forestProvider;
    this._grassProvider = this.defaults.grassProvider;
    this._frameRef = null;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachDispatcher(d) { this._dispatcher = d; return this; }
  attachClock(c) { this._clock = c; return this; }
  attachCeilingEnforcer(e) { this._ceilingEnforcer = e; return this; }
  attachFrameBudgetMonitor(f) { this._frameBudgetMonitor = f; return this; }
  attachGCMonitor(g) { this._gcMonitor = g; return this; }
  attachHLODController(h) { this._hlodController = h; return this; }
  attachAssetQueue(a) { this._assetQueue = a; return this; }
  attachWorldMemory(w) { this._worldMemory = w; return this; }
  attachTerrainProvider(t) { this._terrainProvider = t; return this; }
  attachForestProvider(f) { this._forestProvider = f; return this; }
  attachGrassProvider(g) { this._grassProvider = g; return this; }
  attachRenderer(r) { this._renderer = r; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── Hash key computation (64-bit FNV-1a) ──────────────
  // ══════════════════════════════════════════════════════════
  // We pack (family << 32) | assetId into a 64-bit key using two
  // 32-bit halves to avoid BigInt overhead.
  _hashKey(family, assetId) {
    const low = assetId | 0;
    const high = family | 0;
    let hLow = 0x811c9dc5 | 0;
    let hHigh = 0x811c9dc5 | 0;
    hLow = Math.imul(hLow ^ low, 0x01000193);
    hLow = Math.imul(hLow ^ (low >>> 16), 0x01000193);
    hHigh = Math.imul(hHigh ^ high, 0x01000193);
    hHigh = Math.imul(hHigh ^ (high >>> 16), 0x01000193);
    return { low: hLow >>> 0, high: hHigh >>> 0 };
  }

  // Linear probing slot lookup/insertion.
  _findSlot(keyLow, keyHigh, family, assetId) {
    const cap = this.defaults.maxTrackedAssets;
    const mask = cap - 1;
    let slot = (keyLow ^ keyHigh) & mask;

    for (let probe = 0; probe < cap; probe++) {
      const entry = this._trackingTable[slot];
      if (!entry.valid) {
        // Free slot.
        return { slot, found: false, entry: null };
      }
      if (entry.keyLow === keyLow && entry.keyHigh === keyHigh &&
          entry.family === family && entry.assetId === assetId) {
        return { slot, found: true, entry };
      }
      slot = (slot + 1) & mask;
    }

    // Table full: return a sentinel.
    return { slot: -1, found: false, entry: null };
  }

  // ══════════════════════════════════════════════════════════
  // ─── Register an allocation ─────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Callers report every allocation they make so the profiler
  // can track it. Each (family, assetId) pair must be unique.
  // If the asset is already tracked, the bytes are updated and
  // a DOUBLE_ALLOCATION leak pattern is flagged.
  registerAllocation(family, assetId, bytes) {
    if (family < 0 || family >= ASSET_FAMILY_COUNT) family = ASSET_FAMILY.OTHER;
    if (!Number.isFinite(bytes) || bytes <= 0) return;

    const now = this._now();
    const key = this._hashKey(family, assetId);
    const result = this._findSlot(key.low, key.high, family, assetId);

    if (result.found) {
      // Double allocation detected.
      const entry = result.entry;
      this._doubleAllocCount++;
      this._stats.doubleAllocations++;
      entry.leakPattern = LEAK_PATTERN.DOUBLE_ALLOCATION;
      entry.leakDetectedAt = now;

      // Adjust bytes.
      const delta = bytes - entry.bytes;
      entry.bytes = bytes;
      if (delta > 0) {
        this._totalTrackedBytes += delta;
        this._categoryBytes[FAMILY_TO_CATEGORY[family]] += delta;
        this._familyBytes[family] += delta;
      } else if (delta < 0) {
        this._totalTrackedBytes += delta;
        this._categoryBytes[FAMILY_TO_CATEGORY[family]] += delta;
        this._familyBytes[family] += delta;
      }
      entry.lastAccessedAt = now;

      if (bytes > entry.peakBytes) entry.peakBytes = bytes;

      this._emitLeakEvent(entry, 'double_allocation', LEAK_PATTERN.DOUBLE_ALLOCATION);
      return;
    }

    if (result.slot === -1) {
      // Table full: expand or evict oldest entry.
      this._evictOldestEntry();
      const retry = this._findSlot(key.low, key.high, family, assetId);
      if (retry.slot === -1) return;
      this._doInsert(retry.slot, key.low, key.high, family, assetId, bytes, now);
      return;
    }

    this._doInsert(result.slot, key.low, key.high, family, assetId, bytes, now);
  }

  _doInsert(slot, keyLow, keyHigh, family, assetId, bytes, now) {
    const entry = this._trackingTable[slot];
    entry.valid = true;
    entry.keyLow = keyLow;
    entry.keyHigh = keyHigh;
    entry.family = family;
    entry.assetId = assetId;
    entry.bytes = bytes;
    entry.peakBytes = bytes;
    entry.allocatedAt = now;
    entry.lastAccessedAt = now;
    entry.accessCount = 1;
    entry.disposed = false;

    this._trackingUsed++;
    this._totalTrackedBytes += bytes;
    this._totalAllocations++;

    const category = FAMILY_TO_CATEGORY[family];
    this._categoryBytes[category] += bytes;
    this._categoryCount[category]++;

    this._familyBytes[family] += bytes;
    this._familyCount[family]++;
    if (this._familyBytes[family] > this._familyPeakBytes[family]) {
      this._familyPeakBytes[family] = this._familyBytes[family];
    }

    if (this._totalTrackedBytes > this._peakTotalBytes) {
      this._peakTotalBytes = this._totalTrackedBytes;
    }

    this._stats.registrations++;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Release an allocation ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  releaseAllocation(family, assetId) {
    if (family < 0 || family >= ASSET_FAMILY_COUNT) return false;

    const key = this._hashKey(family, assetId);
    const result = this._findSlot(key.low, key.high, family, assetId);
    if (!result.found) return false;

    const entry = result.entry;
    const bytes = entry.bytes;

    this._totalTrackedBytes -= bytes;
    this._totalReleases++;

    const category = FAMILY_TO_CATEGORY[family];
    this._categoryBytes[category] -= bytes;
    if (this._categoryBytes[category] < 0) this._categoryBytes[category] = 0;
    if (this._categoryCount[category] > 0) this._categoryCount[category]--;

    this._familyBytes[family] -= bytes;
    if (this._familyBytes[family] < 0) this._familyBytes[family] = 0;
    if (this._familyCount[family] > 0) this._familyCount[family]--;

    if (this._totalTrackedBytes < 0) this._totalTrackedBytes = 0;

    entry.reset();
    this._trackingUsed--;
    this._stats.releases++;
    return true;
  }

  // ── Mark an asset as accessed (for LRU stats) ─────────
  touchAllocation(family, assetId) {
    if (family < 0 || family >= ASSET_FAMILY_COUNT) return false;
    const key = this._hashKey(family, assetId);
    const result = this._findSlot(key.low, key.high, family, assetId);
    if (!result.found) return false;
    result.entry.lastAccessedAt = this._now();
    result.entry.accessCount++;
    return true;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Eviction of oldest tracking entry (table full) ────
  // ══════════════════════════════════════════════════════════
  _evictOldestEntry() {
    let oldestSlot = -1;
    let oldestTime = Infinity;
    for (let i = 0; i < this._trackingTable.length; i++) {
      const entry = this._trackingTable[i];
      if (!entry.valid) continue;
      if (entry.allocatedAt < oldestTime) {
        oldestTime = entry.allocatedAt;
        oldestSlot = i;
      }
    }
    if (oldestSlot >= 0) {
      const entry = this._trackingTable[oldestSlot];
      const bytes = entry.bytes;
      const family = entry.family;
      this._totalTrackedBytes -= bytes;
      const category = FAMILY_TO_CATEGORY[family];
      this._categoryBytes[category] -= bytes;
      if (this._categoryCount[category] > 0) this._categoryCount[category]--;
      this._familyBytes[family] -= bytes;
      if (this._familyCount[family] > 0) this._familyCount[family]--;
      entry.reset();
      this._trackingUsed--;
      this._orphanCount++;
      this._stats.orphans++;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Sample snapshot (1 Hz by default) ─────────────────
  // ══════════════════════════════════════════════════════════
  _takeSample() {
    const now = this._now();
    this._stats.samples++;

    // ── Push per-family sample ──────────────────────────
    for (let f = 0; f < ASSET_FAMILY_COUNT; f++) {
      const samples = this._familySamples[f];
      const bytes = this._familyBytes[f];
      samples.bytes[samples.head] = bytes;
      samples.head = (samples.head + 1) % samples.bytes.length;
      if (samples.count < samples.bytes.length) samples.count++;

      // ── Leak detection: monotone growth ───────────────
      if (this.defaults.enableLeakDetection && samples.count >= PROFILER_CONSTANTS.LEAK_MONOTONE_SAMPLES) {
        const n = samples.count;
        const n_use = Math.min(n, PROFILER_CONSTANTS.LEAK_MONOTONE_SAMPLES);

        let monotoneGrowth = true;
        let prev = samples.bytes[(samples.head - n_use + samples.bytes.length) % samples.bytes.length];
        for (let k = 1; k < n_use; k++) {
          const idx = (samples.head - n_use + k + samples.bytes.length) % samples.bytes.length;
          const cur = samples.bytes[idx];
          if (cur < prev) { monotoneGrowth = false; break; }
          prev = cur;
        }

        const oldestIdx = (samples.head - n_use + samples.bytes.length) % samples.bytes.length;
        const oldestBytes = samples.bytes[oldestIdx];
        const growthRate = oldestBytes > 0
          ? (bytes - oldestBytes) / oldestBytes
          : (bytes > 0 ? 1.0 : 0);

        samples.growthRate = growthRate;

        if (monotoneGrowth && growthRate > PROFILER_CONSTANTS.LEAK_GROWTH_THRESHOLD) {
          if (samples.leakPattern === LEAK_PATTERN.NONE) {
            samples.leakPattern = LEAK_PATTERN.MONOTONE_GROWTH;
            this._stats.leaksDetected++;
            this._emitFamilyLeakEvent(f, 'monotone_growth', bytes, growthRate);
          }
        } else {
          if (samples.leakPattern === LEAK_PATTERN.MONOTONE_GROWTH && growthRate <= 0.01) {
            samples.leakPattern = LEAK_PATTERN.NONE;
          }
        }
      }
    }

    // ── Refresh top-N list ──────────────────────────────
    if (this.defaults.enableTopN) {
      this._refreshTopN();
    }

    // ── Refresh leak suspects list ──────────────────────
    this._refreshLeakSuspects();

    // ── Update usage pressure level ─────────────────────
    this._updateUsagePressure();

    // ── Sample renderer info if attached ────────────────
    if (this._renderer && this._renderer.info) {
      this._lastRendererGeometries = this._renderer.info.memory.geometries || 0;
      this._lastRendererTextures = this._renderer.info.memory.textures || 0;
      this._lastRendererPrograms = this._renderer.info.programs?.length || 0;
    }

    this._lastSampleTime = now;
    this._nextSampleDueAt = now + (this.defaults.sampleIntervalMs / 1000);
  }

  // ══════════════════════════════════════════════════════════
  // ─── Top-N refresh (sorted desc by bytes) ─────────────
  // ══════════════════════════════════════════════════════════
  _refreshTopN() {
    const topN = this._topNIndices.length;
    const indices = this._sortScratchIndices;
    const bytes = this._sortScratchBytes;

    // Collect all valid entries.
    let count = 0;
    for (let i = 0; i < this._trackingTable.length && count < indices.length; i++) {
      const entry = this._trackingTable[i];
      if (!entry.valid) continue;
      indices[count] = i;
      bytes[count] = entry.bytes;
      count++;
    }

    // Partial selection sort for top-N (only up to N).
    const limit = Math.min(topN, count);
    for (let i = 0; i < limit; i++) {
      let maxIdx = i;
      for (let j = i + 1; j < count; j++) {
        if (bytes[j] > bytes[maxIdx]) maxIdx = j;
      }
      if (maxIdx !== i) {
        const tmpIdx = indices[i];
        indices[i] = indices[maxIdx];
        indices[maxIdx] = tmpIdx;
        const tmpBytes = bytes[i];
        bytes[i] = bytes[maxIdx];
        bytes[maxIdx] = tmpBytes;
      }
    }

    // Write to output arrays.
    this._topNCount = limit;
    for (let i = 0; i < limit; i++) {
      const entry = this._trackingTable[indices[i]];
      this._topNIndices[i] = indices[i];
      this._topNBytes[i] = entry.bytes;
      this._topNFamily[i] = entry.family;
      this._topNAssetIds[i] = entry.assetId;
    }

    this._stats.topNRefreshes++;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Leak suspects refresh ─────────────────────────────
  // ══════════════════════════════════════════════════════════
  _refreshLeakSuspects() {
    let count = 0;
    for (let f = 0; f < ASSET_FAMILY_COUNT; f++) {
      const samples = this._familySamples[f];
      if (samples.leakPattern !== LEAK_PATTERN.NONE) {
        if (count < this._leakSuspects.length) {
          this._leakSuspects[count++] = f;
        }
      }
    }
    this._leakSuspectsCount = count;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Usage pressure level ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateUsagePressure() {
    const ceiling = this._getCeilingBytes();
    if (ceiling <= 0) return;

    const ratio = this._totalTrackedBytes / ceiling;
    let newLevel = PRESSURE_LEVEL.NORMAL;
    if (ratio >= PROFILER_CONSTANTS.USAGE_CRITICAL_PCT) newLevel = PRESSURE_LEVEL.EMERGENCY;
    else if (ratio >= PROFILER_CONSTANTS.USAGE_WARN_PCT) newLevel = PRESSURE_LEVEL.CRITICAL;

    if (newLevel !== this._usagePressure) {
      this._usagePressure = newLevel;

      switch (newLevel) {
        case PRESSURE_LEVEL.CRITICAL: this._stats.usageCriticalEvents++; break;
        case PRESSURE_LEVEL.EMERGENCY: this._stats.usageCriticalEvents++; break;
        default: this._stats.usageWarnEvents++; break;
      }

      this._emitUsageEvent(newLevel, ratio);
    }
  }

  _getCeilingBytes() {
    if (this._ceilingEnforcer) {
      return this._ceilingEnforcer.getCeilingBytes();
    }
    return MEMORY_CEILING_BYTES[MEMORY_PROFILE.LOW];
  }

  // ══════════════════════════════════════════════════════════
  // ─── Event emission ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _emitLeakEvent(entry, kind, pattern) {
    if (!this._dispatcher || !this.defaults.enableEvents) return;
    const now = performance.now();
    if (now - this._lastEventTime < this.defaults.eventCoalesceMs) return;
    this._lastEventTime = now;

    this._dispatcher.queueCausalEvent(
      EVENT_TYPE.AUDIO_LIGHT,
      [0, 0, 0],
      -1, 1, 1.0,
      {
        kind: 'memory_leak',
        subkind: kind,
        pattern,
        patternName: LEAK_PATTERN_NAMES[pattern],
        family: entry.family,
        familyName: ASSET_FAMILY_NAMES[entry.family],
        assetId: entry.assetId,
        bytes: entry.bytes,
        peakBytes: entry.peakBytes,
        allocatedAt: entry.allocatedAt
      }
    );
    this._stats.leakEventsEmitted++;
  }

  _emitFamilyLeakEvent(family, kind, bytes, growthRate) {
    if (!this._dispatcher || !this.defaults.enableEvents) return;
    const now = performance.now();
    if (now - this._lastEventTime < this.defaults.eventCoalesceMs) return;
    this._lastEventTime = now;

    this._dispatcher.queueCausalEvent(
      EVENT_TYPE.AUDIO_LIGHT,
      [0, 0, 0],
      -1, 1, 1.0,
      {
        kind: 'memory_family_leak',
        subkind: kind,
        family,
        familyName: ASSET_FAMILY_NAMES[family],
        bytes,
        growthRate
      }
    );
    this._stats.leakEventsEmitted++;
  }

  _emitUsageEvent(level, ratio) {
    if (!this._dispatcher || !this.defaults.enableEvents) return;
    const now = performance.now();
    if (now - this._lastUsageEventTime < this.defaults.eventCoalesceMs) return;
    this._lastUsageEventTime = now;

    this._dispatcher. queueCausalEvent(
      EVENT_TYPE.AUDIO_LIGHT,
      [0, 0, 0],
      -1, 1, 1.0,
      {
        kind: 'memory_usage_pressure',
        level,
        levelName: PRESSURE_LEVEL_NAMES[level],
        usageRatio: ratio,
        trackedBytes: this._totalTrackedBytes,
        ceilingBytes: this._getCeilingBytes()
      }
    );
  }

  // ══════════════════════════════════════════════════════════
  // ─── Time helper ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _now() {
    if (this._clock) return this._clock.elapsedSeconds;
    return performance.now() / 1000;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Orphan disposal tracking ──────────────────────────
  // ══════════════════════════════════════════════════════════
  // Callers who dispose a group of assets can call this to check
  // whether any of their tracked assets were left behind.
  checkForOrphans(family) {
    if (family < 0 || family >= ASSET_FAMILY_COUNT) return 0;
    let orphanCount = 0;
    for (let i = 0; i < this._trackingTable.length; i++) {
      const entry = this._trackingTable[i];
      if (!entry.valid) continue;
      if (entry.family === family && !entry.disposed) {
        orphanCount++;
      }
    }
    return orphanCount;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Public queries ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getTotalTrackedBytes() { return this._totalTrackedBytes; }
  getTotalTrackedMB() { return this._totalTrackedBytes / (1024 * 1024); }
  getPeakBytes() { return this._peakTotalBytes; }
  getPeakMB() { return this._peakTotalBytes / (1024 * 1024); }
  getFamilyBytes(family) {
    if (family < 0 || family >= ASSET_FAMILY_COUNT) return 0;
    return this._familyBytes[family];
  }
  getFamilyCount(family) {
    if (family < 0 || family >= ASSET_FAMILY_COUNT) return 0;
    return this._familyCount[family];
  }
  getCategoryBytes(category) {
    if (category < 0 || category >= CATEGORY_COUNT) return 0;
    return this._categoryBytes[category];
  }
  getUsagePressureLevel() { return this._usagePressure; }
  getUsagePressureLevelName() { return PRESSURE_LEVEL_NAMES[this._usagePressure]; }
  getTopNCount() { return this._topNCount; }
  getLeakSuspectsCount() { return this._leakSuspectsCount; }
  getLeakSuspect(i) {
    if (i < 0 || i >= this._leakSuspectsCount) return -1;
    return this._leakSuspects[i];
  }
  getTrackedAssetCount() { return this._trackingUsed; }

  // ══════════════════════════════════════════════════════════
  // ─── Frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    if (!physical.memoryProfile) {
      physical.memoryProfile = {
        totalTrackedBytes: 0,
        totalTrackedMB: 0,
        peakBytes: 0,
        peakMB: 0,
        trackedAssets: 0,
        usagePressure: 0,
        usagePressureName: 'normal',
        familyBytes: new Float64Array(ASSET_FAMILY_COUNT),
        familyCounts: new Int32Array(ASSET_FAMILY_COUNT),
        familyNames: ASSET_FAMILY_NAMES,
        categoryBytes: new Float64Array(CATEGORY_COUNT),
        categoryNames: ASSET_CATEGORY_NAMES_SAFE(),
        topNCount: 0,
        topNIndices: new Int32Array(PROFILER_CONSTANTS.TOP_N_CAPACITY),
        topNBytes: new Float64Array(PROFILER_CONSTANTS.TOP_N_CAPACITY),
        topNFamily: new Uint8Array(PROFILER_CONSTANTS.TOP_N_CAPACITY),
        topNAssetIds: new Int32Array(PROFILER_CONSTANTS.TOP_N_CAPACITY),
        leakSuspectsCount: 0,
        leakSuspects: new Int32Array(ASSET_FAMILY_COUNT),
        rendererGeometries: 0,
        rendererTextures: 0,
        rendererPrograms: 0,
        stats: {}
      };
    }

    const mp = physical.memoryProfile;

    mp.totalTrackedBytes = this._totalTrackedBytes;
    mp.totalTrackedMB = this._totalTrackedBytes / (1024 * 1024);
    mp.peakBytes = this._peakTotalBytes;
    mp.peakMB = this._peakTotalBytes / (1024 * 1024);
    mp.trackedAssets = this._trackingUsed;
    mp.usagePressure = this._usagePressure;
    mp.usagePressureName = PRESSURE_LEVEL_NAMES[this._usagePressure];

    for (let f = 0; f < ASSET_FAMILY_COUNT; f++) {
      mp.familyBytes[f] = this._familyBytes[f];
      mp.familyCounts[f] = this._familyCount[f];
    }

    for (let c = 0; c < CATEGORY_COUNT; c++) {
      mp.categoryBytes[c] = this._categoryBytes[c];
    }

    mp.topNCount = this._topNCount;
    for (let i = 0; i < this._topNCount; i++) {
      mp.topNIndices[i] = this._topNIndices[i];
      mp.topNBytes[i] = this._topNBytes[i];
      mp.topNFamily[i] = this._topNFamily[i];
      mp.topNAssetIds[i] = this._topNAssetIds[i];
    }

    mp.leakSuspectsCount = this._leakSuspectsCount;
    for (let i = 0; i < this._leakSuspectsCount; i++) {
      mp.leakSuspects[i] = this._leakSuspects[i];
    }

    mp.rendererGeometries = this._lastRendererGeometries;
    mp.rendererTextures = this._lastRendererTextures;
    mp.rendererPrograms = this._lastRendererPrograms;

    // Stats snapshot.
    mp.stats.samples = this._stats.samples;
    mp.stats.registrations = this._stats.registrations;
    mp.stats.releases = this._stats.releases;
    mp.stats.doubleAllocations = this._stats.doubleAllocations;
    mp.stats.orphans = this._stats.orphans;
    mp.stats.leaksDetected = this._stats.leaksDetected;
    mp.stats.leakEventsEmitted = this._stats.leakEventsEmitted;
    mp.stats.usageWarnEvents = this._stats.usageWarnEvents;
    mp.stats.usageCriticalEvents = this._stats.usageCriticalEvents;
    mp.stats.topNRefreshes = this._stats.topNRefreshes;
  }

  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.memorySummary) {
      spatial.memorySummary = {
        totalTrackedBytes: 0,
        usagePressure: 0,
        leakSuspectsCount: 0,
        topFamilyBytes: 0,
        topFamily: 0,
        ceilingBytes: 0
      };
    }

    const ms = spatial.memorySummary;
    ms.totalTrackedBytes = this._totalTrackedBytes;
    ms.usagePressure = this._usagePressure;
    ms.leakSuspectsCount = this._leakSuspectsCount;
    ms.ceilingBytes = this._getCeilingBytes();

    // Find the top family by bytes.
    let topFamily = 0;
    let topBytes = 0;
    for (let f = 0; f < ASSET_FAMILY_COUNT; f++) {
      if (this._familyBytes[f] > topBytes) {
        topBytes = this._familyBytes[f];
        topFamily = f;
      }
    }
    ms.topFamily = topFamily;
    ms.topFamilyBytes = topBytes;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Main update ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  update(frame, clock) {
    if (!frame || !frame.layers) return 0;
    this._frameRef = frame;

    const now = this._now();
    if (now >= this._nextSampleDueAt) {
      this._takeSample();
    }

    this._writeToPhysicalLayer(frame);
    this._writeToSpatialLayer(frame);
    return 1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Diagnostics ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getStats() {
    return Object.freeze({
      totalTrackedBytes: this._totalTrackedBytes,
      totalTrackedMB: this._totalTrackedBytes / (1024 * 1024),
      peakBytes: this._peakTotalBytes,
      peakMB: this._peakTotalBytes / (1024 * 1024),
      trackedAssets: this._trackingUsed,
      usagePressure: this._usagePressure,
      usagePressureName: PRESSURE_LEVEL_NAMES[this._usagePressure],
      leakSuspectsCount: this._leakSuspectsCount,
      topNCount: this._topNCount,
      ...this._stats
    });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) {
      if (typeof this._stats[k] === 'number') this._stats[k] = 0;
    }
  }

  dispose() {
    for (let i = 0; i < this._trackingTable.length; i++) {
      this._trackingTable[i].reset();
    }
    this._trackingUsed = 0;
    this._totalTrackedBytes = 0;
    this._familyBytes.fill(0);
    this._familyCount.fill(0);
    this._categoryBytes.fill(0);
    this._categoryCount.fill(0);
    this._topNCount = 0;
    this._leakSuspectsCount = 0;

    this._dispatcher = null;
    this._clock = null;
    this._ceilingEnforcer = null;
    this._frameBudgetMonitor = null;
    this._gcMonitor = null;
    this._hlodController = null;
    this._assetQueue = null;
    this._worldMemory = null;
    this._terrainProvider = null;
    this._forestProvider = null;
    this._grassProvider = null;
    this._renderer = null;
    this._frameRef = null;
  }
}

// Helper used inside _writeToPhysicalLayer to avoid importing
// ALLOC_CATEGORY_NAMES twice in different scopes.
function ASSET_CATEGORY_NAMES_SAFE() {
  return ALLOC_CATEGORY_NAMES;
}

export {
  MemoryProfiler,
  TrackingEntry,
  ASSET_FAMILY,
  ASSET_FAMILY_NAMES,
  ASSET_FAMILY_COUNT,
  FAMILY_TO_CATEGORY,
  LEAK_PATTERN,
  LEAK_PATTERN_NAMES,
  PROFILER_CONSTANTS
};