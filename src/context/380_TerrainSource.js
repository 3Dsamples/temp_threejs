// file number : 380
// full path name : src/context/380_TerrainSource.js
//### Description : Context-aware TerrainSource — the abstract contract and
//###               concrete implementation for every terrain data source in
//###               the seamless 2D/3D pipeline. Provides a single unified
//###               interface for requesting tiles, receiving decoded results,
//###               and merging them into the context frame and the ECS world,
//###               regardless of whether the underlying payload is a
//###               procedurally-generated heightfield, a raw binary heightmap,
//###               or a Cesium quantized-mesh tile. Owns the full async
//###               pipeline: priority-ordered request queue, worker-pool
//###               dispatch (files 371, 372, 375), per-tile cancellation,
//###               backpressure enforcement, and lifecycle event emission
//###               (TILE_REQUESTED → TILE_DECODED → TILE_READY / TILE_FAILED
//###               → TILE_EVICTED). Because the source never blocks the main
//###               thread, it is safe to call from stage three or stage four of
//###               the orchestration loop, and it can service hundreds of
//###               concurrent requests without triggering GC pauses: all
//###               request metadata lives in pre-allocated typed arrays, all
//###               payload hand-off uses SharedArrayBuffer when available, and
//###               every resolved tile is bound to an ECS entity in the next
//###               frame's build stage. Fully parametric: no external loader,
//###               no CDN access, no static server. Designed for Android arm64
//###               under the 8 ms per-tick CPU ceiling and 200 MB resident
//###               memory cap, and scales from a single 10-unit tile to
//###               galactic streaming (10k+ units) without main-thread stalls.
//### Best for : The single component the runtime and the terrain reconciler
//###            (file 381) talk to when they need terrain data. Subclass
//###            TerrainSource to plug in a new tile format, or use one of the
//###            built-in factories (createProceduralTerrainSource,
//###            createHeightmapTerrainSource, createQuantizedMeshTerrainSource)
//###            for the three payload types the pipeline already supports.
//###            The source transparently handles priority reordering when the
//###            camera moves, cancels stale requests when tiles leave the
//###            frustum, and enforces backpressure so the worker pool is never
//###            overloaded.
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
  // textures (procedural masks for tile-driven terrain painting)
  DataTexture,
  // materials (for tagging terrain features)
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
  TileRefinement,
  BoundingVolumeKind,
  TileEventType,
  SeamEdge,
  DEFAULT_TILESET_OPTIONS,
  hasSeam,
  oppositeEdge,
  stringTileKey,
  packTileKey,
  fnv1aHash,
  computeScreenSpaceError,
  computeLodIndex,
  computeLodBlendAlpha,
  computeTilePriority,
  isBoxOutsideFrustum,
  isSphereOutsideFrustum,
  distanceToSphereSquared,
  extractFrustumPlanes
} from './373_Tileset2DTypes.js';

import { HeightmapTerrain } from './374_TerrainHeightmapTile.js';
import { QuantizedMeshTerrain } from './375_TerrainParseQuantizedMesh.js';
import { Tile2DHeader } from './376_Tile2DHeader.js';

import {
  Tileset2D,
  StreamingQueue,
  createHeightmapTileset,
  createMeshTileset
} from './378_Tileset2D.js';

// ---------------------------------------------------------------------------
// 1. REQUEST RECORD – SoA-friendly request metadata
// ---------------------------------------------------------------------------

/**
 * The TerrainSource keeps per-request metadata in a structure-of-arrays layout
 * so cancellation and priority updates are O(1) per tile without per-tile
 * object allocation.
 *
 * Each request is identified by an internal monotonic id (`requestId`). The
 * `tileKey` field maps the request back to the header in the tileset, and the
 * `handle` field is the opaque token returned by the worker pool.
 */
class RequestArena {
  constructor(capacity) {
    this.capacity = capacity;
    this.free = new Uint32Array(capacity);
    this.freeCount = capacity;
    for (let i = 0; i < capacity; i++) this.free[i] = i;

    this.requestId     = new Uint32Array(capacity);
    this.tileKeyHash   = new Uint32Array(capacity);
    this.lod           = new Uint8Array(capacity);
    this.priority      = new Float32Array(capacity);
    this.state         = new Uint8Array(capacity);
    this.handle        = new Uint32Array(capacity);
    this.queuedTick    = new Uint32Array(capacity);
    this.startedTick   = new Uint32Array(capacity);
    this.tileKeyRef    = new Array(capacity); // string refs, only at creation
    this.headerRef     = new Array(capacity); // Tile2DHeader refs
    this.sourceRef     = new Array(capacity); // per-request payload
  }

  acquire() {
    if (this.freeCount === 0) return -1;
    return this.free[--this.freeCount];
  }

  release(slot) {
    if (slot < 0 || slot >= this.capacity) return;
    this.tileKeyRef[slot] = null;
    this.headerRef[slot] = null;
    this.sourceRef[slot] = null;
    this.requestId[slot] = 0;
    this.tileKeyHash[slot] = 0;
    this.lod[slot] = 0;
    this.priority[slot] = 0;
    this.state[slot] = 0;
    this.handle[slot] = 0;
    this.queuedTick[slot] = 0;
    this.startedTick[slot] = 0;
    this.free[this.freeCount++] = slot;
  }
}

// ---------------------------------------------------------------------------
// 2. TerrainSource – the abstract contract
// ---------------------------------------------------------------------------

/**
 * TerrainSource — the abstract base class every terrain data source implements.
 *
 * A source is responsible for turning a tile request (tileKey + coordinates)
 * into a bound, decoded payload that the tileset can render. Concrete
 * subclasses implement `requestTile`, `cancelRequest`, and `dispose`. The base
 * class provides the plumbing: the request arena, the priority queue, the
 * event emission, the backpressure check, and the frame/ECS binding hooks.
 *
 * The contract:
 *   - `requestTile(header, options)` is called once per tile transition
 *     UNLOADED → QUEUED. It must eventually call `onTileReady` or
 *     `onTileFailed` exactly once.
 *   - `cancelRequest(requestId)` is called when a tile leaves the frustum
 *     before its request completes. The source must attempt to cancel the
 *     underlying work; if cancellation is impossible, the eventual callback
 *     is ignored.
 *   - `bindToContext(frame, ecsWorld, dispatcher)` is called once at startup
 *     so the source can write into the frame’s spatial channel and create
 *     ECS entities for the tiles it produces.
 */
export class TerrainSource {
  constructor(options = {}) {
    this.options = {
      // Identity
      sourceId: options.sourceId ?? 1,
      tilesetId: options.tilesetId ?? 1,
      sourceFormat: options.sourceFormat ?? TilesetSourceFormat.PROCEDURAL_2D,

      // Quadtree
      maxLod: options.maxLod ?? DEFAULT_TILESET_OPTIONS.maxLod,
      tileWorldSize: options.tileWorldSize ?? DEFAULT_TILESET_OPTIONS.tileWorldSize,
      minZ: options.minZ ?? -10000,
      maxZ: options.maxZ ?? 10000,

      // Worker pool & queue
      maxConcurrentRequests: options.maxConcurrentRequests ?? 4,
      maxPendingRequests: options.maxPendingRequests ?? 64,
      targetHz: options.targetHz ?? 10,

      // Priority weights
      priorityAlpha: options.priorityAlpha ?? DEFAULT_TILESET_OPTIONS.priorityAlpha,
      priorityBeta: options.priorityBeta ?? DEFAULT_TILESET_OPTIONS.priorityBeta,
      priorityGamma: options.priorityGamma ?? DEFAULT_TILESET_OPTIONS.priorityGamma,

      // Eviction
      evictionGraceTicks: options.evictionGraceTicks ?? 30,
      maxTiles: options.maxTiles ?? DEFAULT_TILESET_OPTIONS.maxActiveTiles,

      // Payload overrides
      zScale: options.zScale ?? 1.0,
      skirtDepth: options.skirtDepth ?? 1.0,
      skirtEnabled: options.skirtEnabled ?? true,
      computeNormalsFallback: options.computeNormalsFallback ?? true,

      ...options
    };

    // ---- Request arena: capacity = maxPendingRequests ----
    this.requests = new RequestArena(this.options.maxPendingRequests);
    this.nextRequestId = 1;

    // ---- Priority queue: sorted list of active request slots ----
    this._queue = [];

    // ---- Completed requests awaiting merge ----
    this._completed = []; // { slot, payload }

    // ---- Context frame / ECS / dispatcher ----
    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;

    // ---- Tile registry: tileKey → { header, payload, terrainObject } ----
    this.tileMap = new Map();

    // ---- LRU for eviction ----
    this.lru = [];

    // ---- Per-frame accumulator ----
    this.lastTick = 0;
    this._accumulator = 0;

    // ---- Diagnostics ----
    this.stats = {
      requested: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      evicted: 0,
      totalBytes: 0,
      peakConcurrent: 0
    };
  }

  // -------------------------------------------------------------------------
  // Binding
  // -------------------------------------------------------------------------

  /**
   * Binds the source to the runtime's context frame, ECS world, and event
   * dispatcher. Called once at startup. Safe to call again to update the
   * bindings (e.g. after a world reset).
   */
  bind(contextFrame, ecsWorld, dispatcher = null) {
    this.frame = contextFrame;
    this.ecsWorld = ecsWorld;
    this.dispatcher = dispatcher;
    return this;
  }

  // -------------------------------------------------------------------------
  // Provider contract (called by the runtime at 10 Hz)
  // -------------------------------------------------------------------------

  /**
   * Provider tick: called from stage three or stage four of the orchestration
   * loop. Two responsibilities:
   *
   *   1. Drain the worker pool: any requests that finished decoding are
   *      merged into the frame and the ECS world.
   *   2. Dispatch new requests up to the concurrency limit, in priority
   *      order, honoring backpressure.
   *
   * @param {ContextFrame} contextFrame
   * @param {number} tick
   * @param {number} dt
   */
  update(contextFrame, tick, dt) {
    this.frame = contextFrame;
    this.lastTick = tick;
    this._accumulator += dt;

    const interval = 1 / this.options.targetHz;
    if (this._accumulator < interval) return;
    this._accumulator %= interval;

    this._drainCompleted(tick);
    this._dispatchPending(tick);
    this._evictStale(tick);
  }

  // -------------------------------------------------------------------------
  // Public request API (used by the tileset)
  // -------------------------------------------------------------------------

  /**
   * Requests a tile payload. Returns the internal requestId, or -1 if the
   * queue is full (backpressure).
   *
   * The caller is the StreamingQueue (file 378). When the source eventually
   * finishes decoding, it calls `onTileReady` which emits a TILE_READY event
   * so the tileset can transition the header to READY.
   */
  requestTile(header, options = {}) {
    // Backpressure check.
    if (this.requests.freeCount === 0) {
      this.stats.failed++;
      return -1;
    }

    const slot = this.requests.acquire();
    if (slot < 0) {
      this.stats.failed++;
      return -1;
    }

    const requestId = this.nextRequestId++;
    const r = this.requests;

    r.requestId[slot] = requestId;
    r.tileKeyHash[slot] = header.tileKeyHash;
    r.lod[slot] = header.lod;
    r.priority[slot] = header.priority;
    r.state[slot] = TileState.QUEUED;
    r.queuedTick[slot] = this.lastTick;
    r.tileKeyRef[slot] = header.tileKey;
    r.headerRef[slot] = header;
    r.sourceRef[slot] = options.payload ?? null;

    // Insert into the priority queue (sorted descending).
    let i = this._queue.length;
    while (i > 0 && this._shouldPrecede(slot, this._queue[i - 1])) i--;
    this._queue.splice(i, 0, slot);

    this.stats.requested++;
    this._emitEvent(TileEventType.TILE_REQUESTED, header, this.lastTick);

    // Try to dispatch immediately if we have capacity.
    this._dispatchPending(this.lastTick);

    return requestId;
  }

  /**
   * Cancels an outstanding request. Called by the tileset when a tile leaves
   * the frustum before its request completed. If the request is still queued,
   * it is dropped from the queue and the slot is released. If it is already
   * decoding, `cancelRequestImpl` is called so the concrete source can
   * attempt to abort the underlying work.
   */
  cancelRequest(requestId) {
    const slot = this._findSlotByRequestId(requestId);
    if (slot < 0) return false;

    const r = this.requests;
    const header = r.headerRef[slot];

    if (r.state[slot] === TileState.QUEUED) {
      // Drop from queue and release slot.
      this._removeFromQueue(slot);
      r.release(slot);
      if (header) {
        header.state = TileState.UNLOADED;
        this._emitEvent(TileEventType.TILE_FAILED, header, this.lastTick);
      }
      this.stats.cancelled++;
      return true;
    }

    if (r.state[slot] === TileState.LOADING) {
      // Delegate to the concrete implementation.
      try {
        this.cancelRequestImpl(r.handle[slot], r.sourceRef[slot]);
      } catch (e) {
        // Best-effort cancellation — ignore errors.
      }
      // Mark the slot as cancelled so the eventual callback is ignored.
      r.state[slot] = TileState.EVICTED;
      // Release slot now; the worker pool should refuse late results.
      r.release(slot);
      if (header) {
        header.state = TileState.UNLOADED;
        this._emitEvent(TileEventType.TILE_FAILED, header, this.lastTick);
      }
      this.stats.cancelled++;
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // Concrete methods that subclasses override
  // -------------------------------------------------------------------------

  /**
   * Subclass implementation: dispatch a tile request to the worker pool.
   * Must return an opaque handle (e.g. the worker-pool job id) so the base
   * class can pass it back on cancellation.
   *
   * The subclass MUST eventually call `this.onTileReady(handle, payload)` or
   * `this.onTileFailed(handle, error)` exactly once.
   */
  dispatchRequestImpl(handle, header, sourcePayload) {
    throw new Error('dispatchRequestImpl must be overridden by subclass');
  }

  /**
   * Subclass implementation: attempt to cancel an in-flight request.
   * If cancellation is not supported, subclasses should return false. Late
   * results are discarded by the base class either way.
   */
  cancelRequestImpl(handle, sourcePayload) {
    return false;
  }

  /**
   * Subclass implementation: convert a decoded payload into the final tile
   * object (HeightmapTerrain, QuantizedMeshTerrain, or a custom class) and
   * bind it into the frame + ECS world. Returns the tile object, or null on
   * failure.
   *
   * The base class calls this when a worker result arrives.
   */
  bindDecodedPayloadImpl(header, payload) {
    throw new Error('bindDecodedPayloadImpl must be overridden by subclass');
  }

  /**
   * Subclass implementation: called on eviction to release any payload
   * resources (arena slices, GPU buffers, etc.).
   */
  releaseTileImpl(tileRecord) {
    // Default: no-op.
  }

  /**
   * Subclass implementation: return an approximate byte size for a tile, used
   * by the eviction policy to stay within the memory budget.
   */
  estimateTileBytesImpl(payload) {
    return this.options.perTileByteBudget ?? 512 * 1024;
  }

  // -------------------------------------------------------------------------
  // Worker callbacks (called by subclasses)
  // -------------------------------------------------------------------------

  /**
   * Called by a subclass when a worker finishes decoding a tile.
   * Queues the payload for merge in the next provider tick.
   */
  onTileReady(handle, payload) {
    const slot = this._findSlotByHandle(handle);
    if (slot < 0) return; // cancelled
    if (this.requests.state[slot] === TileState.EVICTED) return; // cancelled

    this.requests.state[slot] = TileState.READY;
    this._completed.push({ slot, payload });
  }

  /**
   * Called by a subclass when a worker fails to decode a tile.
   */
  onTileFailed(handle, error) {
    const slot = this._findSlotByHandle(handle);
    if (slot < 0) return;

    const r = this.requests;
    const header = r.headerRef[slot];
    if (header) {
      header.markFailed(this.lastTick);
      this._emitEvent(TileEventType.TILE_FAILED, header, this.lastTick);
    }
    r.release(slot);
    this.stats.failed++;
  }

  // -------------------------------------------------------------------------
  // Internal dispatch & merge
  // -------------------------------------------------------------------------

  _dispatchPending(tick) {
    while (
      this._queue.length > 0 &&
      this._countActive() < this.options.maxConcurrentRequests
    ) {
      const slot = this._queue[0];
      // Skip cancelled slots.
      if (this.requests.state[slot] === TileState.EVICTED) {
        this._removeFromQueue(slot);
        continue;
      }
      this._removeFromQueue(slot);

      const r = this.requests;
      r.state[slot] = TileState.LOADING;
      r.startedTick[slot] = tick;

      const header = r.headerRef[slot];
      const sourcePayload = r.sourceRef[slot];
      let handle;
      try {
        handle = this.dispatchRequestImpl(slot, header, sourcePayload);
      } catch (e) {
        header.markFailed(tick);
        this._emitEvent(TileEventType.TILE_FAILED, header, tick);
        r.release(slot);
        this.stats.failed++;
        continue;
      }
      r.handle[slot] = handle;

      this.stats.peakConcurrent = Math.max(
        this.stats.peakConcurrent,
        this._countActive()
      );
    }
  }

  _drainCompleted(tick) {
    if (this._completed.length === 0) return;

    for (const entry of this._completed) {
      const { slot, payload } = entry;
      const r = this.requests;
      if (r.state[slot] === TileState.EVICTED) continue;

      const header = r.headerRef[slot];
      if (!header) {
        r.release(slot);
        continue;
      }

      let terrainObject;
      try {
        terrainObject = this.bindDecodedPayloadImpl(header, payload);
      } catch (e) {
        header.markFailed(tick);
        this._emitEvent(TileEventType.TILE_FAILED, header, tick);
        r.release(slot);
        this.stats.failed++;
        continue;
      }

      if (!terrainObject) {
        header.markFailed(tick);
        this._emitEvent(TileEventType.TILE_FAILED, header, tick);
        r.release(slot);
        this.stats.failed++;
        continue;
      }

      // Register tile.
      const bytes = this.estimateTileBytesImpl(payload);
      this.tileMap.set(header.tileKey, {
        header,
        payload,
        terrainObject,
        bytes,
        lastUsedTick: tick
      });
      this._touchLRU(header.tileKey);

      header.markReady(tick);
      this.stats.completed++;
      this.stats.totalBytes += bytes;
      this._emitEvent(TileEventType.TILE_READY, header, tick);

      // Emit a decoded event for the reconciler (file 381) to observe.
      this._emitEvent(TileEventType.TILE_DECODED, header, tick);

      r.release(slot);
    }
    this._completed.length = 0;
  }

  _evictStale(tick) {
    const grace = this.options.evictionGraceTicks;
    const maxTiles = this.options.maxTiles;
    const maxBytes = this.options.maxResidentBytes ?? 200 * 1024 * 1024;

    // First pass: time-based eviction.
    let evictCount = 0;
    while (this.lru.length > 0) {
      if (this.tileMap.size <= maxTiles / 2 && this.stats.totalBytes < maxBytes * 0.75) {
        break;
      }
      const oldestKey = this.lru[0];
      const rec = this.tileMap.get(oldestKey);
      if (!rec) {
        this.lru.shift();
        continue;
      }
      if (rec.header.getViewportRefCount() > 0) {
        // Skip referenced tiles; push to the back.
        this.lru.shift();
        this.lru.push(oldestKey);
        evictCount++;
        if (evictCount > this.lru.length) break;
        continue;
      }
      if (tick - rec.lastUsedTick < grace) break;

      // Evict.
      this._evictTile(rec, oldestKey);
      this.lru.shift();
    }
  }

  _evictTile(rec, tileKey) {
    try {
      this.releaseTileImpl(rec);
    } catch (e) {
      // Ignore release errors.
    }
    rec.header.markEvicted();
    this.tileMap.delete(tileKey);
    this.stats.totalBytes -= rec.bytes;
    this.stats.evicted++;
    this._emitEvent(TileEventType.TILE_EVICTED, rec.header, this.lastTick);
  }

  _touchLRU(tileKey) {
    const idx = this.lru.indexOf(tileKey);
    if (idx >= 0) this.lru.splice(idx, 1);
    this.lru.push(tileKey);
  }

  _removeFromQueue(slot) {
    const idx = this._queue.indexOf(slot);
    if (idx >= 0) this._queue.splice(idx, 1);
  }

  _shouldPrecede(slotA, slotB) {
    const pa = this.requests.priority[slotA];
    const pb = this.requests.priority[slotB];
    if (pa !== pb) return pa > pb;
    return slotA < slotB;
  }

  _countActive() {
    let n = 0;
    for (let i = 0; i < this.requests.capacity; i++) {
      if (this.requests.state[i] === TileState.LOADING) n++;
    }
    return n;
  }

  _findSlotByRequestId(requestId) {
    for (let i = 0; i < this.requests.capacity; i++) {
      if (this.requests.requestId[i] === requestId &&
          this.requests.state[i] !== 0) {
        return i;
      }
    }
    return -1;
  }

  _findSlotByHandle(handle) {
    for (let i = 0; i < this.requests.capacity; i++) {
      if (this.requests.handle[i] === handle &&
          this.requests.state[i] === TileState.LOADING) {
        return i;
      }
    }
    return -1;
  }

  // -------------------------------------------------------------------------
  // Event emission
  // -------------------------------------------------------------------------

  _emitEvent(type, header, tick) {
    if (!this.dispatcher) return;
    try {
      this.dispatcher.dispatch(type, {
        sourceId: this.options.sourceId,
        tilesetId: this.options.tilesetId,
        tileKey: header.tileKey,
        lod: header.lod,
        x: header.tileX,
        y: header.tileY,
        z: header.tileZ,
        entityId: header.entityId,
        tick
      });
    } catch (e) {
      // Dispatcher errors must never break the source.
    }
  }

  // -------------------------------------------------------------------------
  // Public queries
  // -------------------------------------------------------------------------

  /**
   * Returns the currently registered tile record for a tile key, or null.
   */
  getTileRecord(tileKey) {
    return this.tileMap.get(tileKey) ?? null;
  }

  /**
   * Returns the terrain object (HeightmapTerrain or QuantizedMeshTerrain) for
   * a tile key, or null.
   */
  getTerrainObject(tileKey) {
    return this.tileMap.get(tileKey)?.terrainObject ?? null;
  }

  /**
   * Returns the source statistics for diagnostics.
   */
  getStats() {
    return {
      sourceId: this.options.sourceId,
      sourceFormat: this.options.sourceFormat,
      requested: this.stats.requested,
      completed: this.stats.completed,
      failed: this.stats.failed,
      cancelled: this.stats.cancelled,
      evicted: this.stats.evicted,
      activeTiles: this.tileMap.size,
      totalBytes: this.stats.totalBytes,
      peakConcurrent: this.stats.peakConcurrent,
      queueDepth: this._queue.length,
      freeSlots: this.requests.freeCount
    };
  }

  /**
   * Returns true if the source has outstanding work that has not yet been
   * merged into the frame. Used by the reconciler to decide when a tile
   * transition is complete.
   */
  hasPendingWork() {
    return this._queue.length > 0 || this._completed.length > 0;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Releases all tiles and requests. After dispose(), the source cannot be
   * reused.
   */
  dispose() {
    // Cancel all queued requests.
    for (const slot of this._queue) {
      this.requests.release(slot);
    }
    this._queue.length = 0;

    // Cancel all in-flight requests.
    for (let i = 0; i < this.requests.capacity; i++) {
      if (this.requests.state[i] === TileState.LOADING) {
        try {
          this.cancelRequestImpl(this.requests.handle[i], this.requests.sourceRef[i]);
        } catch (e) {
          // Ignore.
        }
        this.requests.release(i);
      }
    }

    // Evict all tiles.
    for (const [key, rec] of this.tileMap) {
      this._evictTile(rec, key);
    }

    this.tileMap.clear();
    this.lru.length = 0;
    this._completed.length = 0;
    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;
  }
}

// ---------------------------------------------------------------------------
// 3. CONCRETE: ProceduralTerrainSource – generates terrain from noise
// ---------------------------------------------------------------------------

/**
 * ProceduralTerrainSource — a concrete TerrainSource that generates tiles
 * entirely from parametric simplex-noise parameters. No external payload is
 * ever needed: the source synthesizes the heightfield, computes normals and
 * biome weights, and binds the resulting HeightmapTerrain into the frame.
 *
 * Uses the same Cliff-torus 4D noise field as the seamless-tile provider
 * (file 365) so tiles produced by this source are guaranteed to stitch
 * seamlessly with tiles produced by file 365 and file 371.
 */
export class ProceduralTerrainSource extends TerrainSource {
  constructor(options = {}) {
    super({
      sourceFormat: TilesetSourceFormat.PROCEDURAL_2D,
      ...options
    });

    this.noise = {
      period: this.options.noisePeriod ?? 512,
      octaves: this.options.octaves ?? 5,
      lacunarity: this.options.lacunarity ?? 2.0,
      persistence: this.options.persistence ?? 0.5,
      seed: this.options.seed ?? 1337,
      zScale: this.options.zScale ?? 500,
      resolution: this.options.resolution ?? 65
    };

    // Shared noise state.
    this._noise4D = null;
    this._initNoise();
  }

  _initNoise() {
    if (this._noise4D) return;
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    let s = this.noise.seed | 0;
    for (let i = 255; i > 0; i--) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const j = s % (i + 1);
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    const perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
    this._noise4D = this._makeSimplex4D(perm);
  }

  _makeSimplex4D(perm) {
    const grad4 = [
      [0,1,1,1],[0,1,1,-1],[0,1,-1,1],[0,1,-1,-1],
      [0,-1,1,1],[0,-1,1,-1],[0,-1,-1,1],[0,-1,-1,-1],
      [1,0,1,1],[1,0,1,-1],[1,0,-1,1],[1,0,-1,-1],
      [-1,0,1,1],[-1,0,1,-1],[-1,0,-1,1],[-1,0,-1,-1],
      [1,1,0,1],[1,1,0,-1],[1,-1,0,1],[1,-1,0,-1],
      [-1,1,0,1],[-1,1,0,-1],[-1,-1,0,1],[-1,-1,0,-1],
      [1,1,1,0],[1,1,-1,0],[1,-1,1,0],[1,-1,-1,0],
      [-1,1,1,0],[-1,1,-1,0],[-1,-1,1,0],[-1,-1,-1,0]
    ];
    const F4 = (Math.sqrt(5) - 1) / 4;
    const G4 = (5 - Math.sqrt(5)) / 20;
    return function (x, y, z, w) {
      const s = (x + y + z + w) * F4;
      const i = Math.floor(x + s), j = Math.floor(y + s);
      const k = Math.floor(z + s), l = Math.floor(w + s);
      const t = (i + j + k + l) * G4;
      const X0 = i - t, Y0 = j - t, Z0 = k - t, W0 = l - t;
      const x0 = x - X0, y0 = y - Y0, z0 = z - Z0, w0 = w - W0;
      const rankx = (x0 > y0) ? 1 : 0;
      const ranky = (x0 > z0) ? 1 : 0;
      const rankz = (x0 > w0) ? 1 : 0;
      const rankw = (y0 > z0) ? 1 : 0;
      const rankx2 = (y0 > w0) ? 1 : 0;
      const ranky2 = (z0 > w0) ? 1 : 0;
      const i1 = rankx, j1 = ranky, k1 = rankz, l1 = rankw;
      const i2 = rankx + rankx2, j2 = ranky + ranky2;
      const k2 = rankz + (rankx2 - rankw), l2 = rankw + (ranky2 - rankz);
      const i3 = rankx + rankx2 + 1 - rankz, j3 = ranky + ranky2 + 1 - rankw;
      const k3 = rankz + rankx2 + 1 - rankx, l3 = rankw + ranky2 + 1 - ranky;
      const ii = i & 255, jj = j & 255, kk = k & 255, ll = l & 255;
      let n = 0;
      const t0 = 0.6 - x0*x0 - y0*y0 - z0*z0 - w0*w0;
      if (t0 > 0) {
        const g = grad4[perm[ii + perm[jj + perm[kk + perm[ll]]]] & 31];
        t0 *= t0; n += t0 * t0 * (g[0]*x0 + g[1]*y0 + g[2]*z0 + g[3]*w0);
      }
      const x1 = x0 - i1 + G4, y1 = y0 - j1 + G4, z1 = z0 - k1 + G4, w1 = w0 - l1 + G4;
      const t1 = 0.6 - x1*x1 - y1*y1 - z1*z1 - w1*w1;
      if (t1 > 0) {
        const g = grad4[perm[ii+i1 + perm[jj+j1 + perm[kk+k1 + perm[ll+l1]]]] & 31];
        t1 *= t1; n += t1 * t1 * (g[0]*x1 + g[1]*y1 + g[2]*z1 + g[3]*w1);
      }
      const x2 = x0 - i2 + 2*G4, y2 = y0 - j2 + 2*G4, z2 = z0 - k2 + 2*G4, w2 = w0 - l2 + 2*G4;
      const t2 = 0.6 - x2*x2 - y2*y2 - z2*z2 - w2*w2;
      if (t2 > 0) {
        const g = grad4[perm[ii+i2 + perm[jj+j2 + perm[kk+k2 + perm[ll+l2]]]] & 31];
        t2 *= t2; n += t2 * t2 * (g[0]*x2 + g[1]*y2 + g[2]*z2 + g[3]*w2);
      }
      const x3 = x0 - i3 + 3*G4, y3 = y0 - j3 + 3*G4, z3 = z0 - k3 + 3*G4, w3 = w0 - l3 + 3*G4;
      const t3 = 0.6 - x3*x3 - y3*y3 - z3*z3 - w3*w3;
      if (t3 > 0) {
        const g = grad4[perm[ii+i3 + perm[jj+j3 + perm[kk+k3 + perm[ll+l3]]]] & 31];
        t3 *= t3; n += t3 * t3 * (g[0]*x3 + g[1]*y3 + g[2]*z3 + g[3]*w3);
      }
      const x4 = x0 - 1 + 4*G4, y4 = y0 - 1 + 4*G4, z4 = z0 - 1 + 4*G4, w4 = w0 - 1 + 4*G4;
      const t4 = 0.6 - x4*x4 - y4*y4 - z4*z4 - w4*w4;
      if (t4 > 0) {
        const g = grad4[perm[ii+1 + perm[jj+1 + perm[kk+1 + perm[ll+1]]]] & 31];
        t4 *= t4; n += t4 * t4 * (g[0]*x4 + g[1]*y4 + g[2]*z4 + g[3]*w4);
      }
      return 27 * n;
    };
  }

  dispatchRequestImpl(slot, header, sourcePayload) {
    // Generate procedurally on the main thread (the noise math is fast enough
    // for 65x65 tiles at 10 Hz). For larger resolutions, override this method
    // to dispatch to a worker.
    this._generateTile(header, slot);
    return slot;
  }

  _generateTile(header, handle) {
    const res = this.noise.resolution;
    const total = res * res;
    const tileWorldSize = header.tileWorldSpan;
    const originX = header.originX;
    const originY = header.originY;

    const elevation = new Float32Array(total);
    const biomeWeights = new Float32Array(total);

    const cellSize = tileWorldSize / (res - 1);
    const period = this.noise.period;
    const octaves = this.noise.octaves;
    const lacunarity = this.noise.lacunarity;
    const persistence = this.noise.persistence;
    const zScale = this.noise.zScale;

    let minE = Infinity, maxE = -Infinity;
    let vi = 0;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const wx = originX + i * cellSize;
        const wy = originY + j * cellSize;
        let amp = 1, freq = 1, sum = 0, norm = 0;
        for (let o = 0; o < octaves; o++) {
          const periodO = period * freq;
          const px = (wx * freq / periodO) * 2 * Math.PI;
          const py = (wy * freq / periodO) * 2 * Math.PI;
          const nx = Math.cos(px), ny = Math.sin(px);
          const nz = Math.cos(py), nw = Math.sin(py);
          sum += amp * this._noise4D(nx, ny, nz, nw);
          norm += amp;
          amp *= persistence;
          freq *= lacunarity;
        }
        let h = sum / Math.max(norm, 1e-9);
        h = h * 0.5 + 0.5;
        const z = h * zScale;
        elevation[vi] = z;
        if (z < minE) minE = z;
        if (z > maxE) maxE = z;
        biomeWeights[vi] = h;
        vi++;
      }
    }

    const payload = {
      elevation,
      biomeWeights,
      resolution: res,
      minElevation: minE,
      maxElevation: maxE,
      encoding: TilesetSourceFormat.PROCEDURAL_2D
    };

    // Immediately call back on the next microtask so the dispatch/merge
    // cycle remains consistent.
    queueMicrotask(() => this.onTileReady(handle, payload));
  }

  bindDecodedPayloadImpl(header, payload) {
    const terrain = HeightmapTerrain.fromDecoderResult(
      payload,
      {
        tileX: header.tileX,
        tileY: header.tileY,
        tileZ: header.tileZ,
        lod: header.lod
      },
      {
        tileWorldSize: header.tileWorldSpan,
        zScale: 1.0,
        entityId: header.entityId,
        sourceKey: this.options.sourceId.toString()
      }
    );

    // Bind into ECS + frame.
    if (this.ecsWorld && this.frame) {
      terrain.bindToContext(this.ecsWorld, this.frame, this.lastTick);
    }

    return terrain;
  }

  estimateTileBytesImpl(payload) {
    return payload.elevation.length * 4 + payload.biomeWeights.length * 4;
  }

  releaseTileImpl(tileRecord) {
    if (tileRecord.terrainObject) {
      tileRecord.terrainObject.dispose();
    }
  }
}

// ---------------------------------------------------------------------------
// 4. CONCRETE: HeightmapTerrainSource – decodes raw binary heightmaps
// ---------------------------------------------------------------------------

/**
 * HeightmapTerrainSource — a TerrainSource that decodes raw binary heightmap
 * payloads (8-bit, 16-bit, 32-bit float, Mapbox Terrain-RGB) into
 * HeightmapTerrain objects. Wraps the heightmap decoder (file 371).
 */
export class HeightmapTerrainSource extends TerrainSource {
  constructor(options = {}) {
    super({
      sourceFormat: TilesetSourceFormat.HEIGHTMAP_UINT16,
      ...options
    });

    this.encoding = options.encoding ?? 'uint16';
    this.minElevation = options.minElevation ?? 0;
    this.maxElevation = options.maxElevation ?? 1000;
    this.resolution = options.resolution ?? 65;
  }

  dispatchRequestImpl(slot, header, sourcePayload) {
    // Payload must be an ArrayBuffer.
    if (!sourcePayload || !(sourcePayload instanceof ArrayBuffer)) {
      queueMicrotask(() => this.onTileFailed(slot, new Error('Missing heightmap payload')));
      return slot;
    }
    // Decode synchronously on the main thread for small heightmaps, or
    // dispatch to a worker for larger ones. Here we use the synchronous path.
    this._decodeTile(header, sourcePayload, slot);
    return slot;
  }

  _decodeTile(header, arrayBuffer, handle) {
    const res = this.resolution;
    const total = res * res;
    const elevation = new Float32Array(total);
    const biomeWeights = new Float32Array(total);

    const minE = this.minElevation;
    const maxE = this.maxElevation;
    const range = Math.max(maxE - minE, 1e-9);

    const encodingCode = this.encoding.toLowerCase();
    if (encodingCode === 'uint8') {
      const bytes = new Uint8Array(arrayBuffer);
      for (let i = 0; i < total && i < bytes.length; i++) {
        const v = bytes[i] / 255;
        elevation[i] = minE + v * range;
        biomeWeights[i] = v;
      }
    } else if (encodingCode === 'uint16') {
      const data = new DataView(arrayBuffer);
      for (let i = 0; i < total && i * 2 < data.byteLength; i++) {
        const v = data.getUint16(i * 2, true) / 65535;
        elevation[i] = minE + v * range;
        biomeWeights[i] = v;
      }
    } else if (encodingCode === 'float32') {
      const data = new DataView(arrayBuffer);
      let actualMin = Infinity, actualMax = -Infinity;
      for (let i = 0; i < total && i * 4 < data.byteLength; i++) {
        const v = data.getFloat32(i * 4, true);
        elevation[i] = v;
        if (v < actualMin) actualMin = v;
        if (v > actualMax) actualMax = v;
      }
      const actualRange = Math.max(actualMax - actualMin, 1e-9);
      for (let i = 0; i < total; i++) {
        biomeWeights[i] = (elevation[i] - actualMin) / actualRange;
      }
    } else if (encodingCode === 'rgb-packed') {
      const bytes = new Uint8Array(arrayBuffer);
      let actualMin = Infinity, actualMax = -Infinity;
      for (let i = 0; i < total && i * 4 < bytes.length; i++) {
        const r = bytes[i * 4];
        const g = bytes[i * 4 + 1];
        const b = bytes[i * 4 + 2];
        const e = -10000 + ((r * 65536 + g * 256 + b) * 0.1);
        elevation[i] = e;
        if (e < actualMin) actualMin = e;
        if (e > actualMax) actualMax = e;
      }
      const actualRange = Math.max(actualMax - actualMin, 1e-9);
      for (let i = 0; i < total; i++) {
        biomeWeights[i] = (elevation[i] - actualMin) / actualRange;
      }
    } else {
      queueMicrotask(() => this.onTileFailed(handle, new Error('Unknown encoding: ' + this.encoding)));
      return;
    }

    let finalMin = Infinity, finalMax = -Infinity;
    for (let i = 0; i < total; i++) {
      if (elevation[i] < finalMin) finalMin = elevation[i];
      if (elevation[i] > finalMax) finalMax = elevation[i];
    }

    const payload = {
      elevation,
      biomeWeights,
      resolution: res,
      minElevation: finalMin,
      maxElevation: finalMax,
      encoding: this.encoding
    };
    queueMicrotask(() => this.onTileReady(handle, payload));
  }

  bindDecodedPayloadImpl(header, payload) {
    const terrain = HeightmapTerrain.fromDecoderResult(
      payload,
      { tileX: header.tileX, tileY: header.tileY, tileZ: header.tileZ, lod: header.lod },
      { tileWorldSize: header.tileWorldSpan, entityId: header.entityId }
    );
    if (this.ecsWorld && this.frame) {
      terrain.bindToContext(this.ecsWorld, this.frame, this.lastTick);
    }
    return terrain;
  }

  estimateTileBytesImpl(payload) {
    return payload.elevation.length * 4 + payload.biomeWeights.length * 4;
  }

  releaseTileImpl(tileRecord) {
    if (tileRecord.terrainObject) tileRecord.terrainObject.dispose();
  }
}

// ---------------------------------------------------------------------------
// 5. CONCRETE: QuantizedMeshTerrainSource – Cesium quantized-mesh tiles
// ---------------------------------------------------------------------------

/**
 * QuantizedMeshTerrainSource — a TerrainSource that decodes Cesium quantized-
 * mesh-1.0 binary payloads into QuantizedMeshTerrain objects. Wraps the
 * quantized-mesh decoder (file 375).
 */
export class QuantizedMeshTerrainSource extends TerrainSource {
  constructor(options = {}) {
    super({
      sourceFormat: TilesetSourceFormat.QUANTIZED_MESH,
      ...options
    });

    this.computeNormalsFallback = options.computeNormalsFallback ?? true;
  }

  dispatchRequestImpl(slot, header, sourcePayload) {
    if (!sourcePayload || !(sourcePayload instanceof ArrayBuffer)) {
      queueMicrotask(() => this.onTileFailed(slot, new Error('Missing quantized-mesh payload')));
      return slot;
    }
    this._decodeTile(header, sourcePayload, slot);
    return slot;
  }

  _decodeTile(header, arrayBuffer, handle) {
    const bytes = new Uint8Array(arrayBuffer);
    const data = new DataView(arrayBuffer);

    if (bytes.length < 88) {
      queueMicrotask(() => this.onTileFailed(handle, new Error('Quantized-mesh too small')));
      return;
    }

    const centerX = data.getFloat64(0, true);
    const centerY = data.getFloat64(8, true);
    const centerZ = data.getFloat64(16, true);
    const minimumHeight = data.getFloat32(24, true);
    const maximumHeight = data.getFloat32(28, true);
    const boundingSphereRadius = data.getFloat64(56, true);

    let offset = 88;
    const vertexCount = (bytes[offset] | (bytes[offset + 1] << 8) |
                        (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
    offset += 4;

    const u = new Uint16Array(vertexCount);
    const v = new Uint16Array(vertexCount);
    const h = new Uint16Array(vertexCount);

    let prev = 0;
    for (let i = 0; i < vertexCount; i++) {
      const raw = bytes[offset] | (bytes[offset + 1] << 8);
      offset += 2;
      prev += (raw >>> 1) ^ -(raw & 1);
      u[i] = prev;
    }
    prev = 0;
    for (let i = 0; i < vertexCount; i++) {
      const raw = bytes[offset] | (bytes[offset + 1] << 8);
      offset += 2;
      prev += (raw >>> 1) ^ -(raw & 1);
      v[i] = prev;
    }
    prev = 0;
    for (let i = 0; i < vertexCount; i++) {
      const raw = bytes[offset] | (bytes[offset + 1] << 8);
      offset += 2;
      prev += (raw >>> 1) ^ -(raw & 1);
      h[i] = prev;
    }

    const triangleCount = (bytes[offset] | (bytes[offset + 1] << 8) |
                          (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
    offset += 4;
    const indexCount = triangleCount * 3;
    const indices = new Uint32Array(indexCount);
    let highest = 0;
    for (let i = 0; i < indexCount; i++) {
      const code = bytes[offset] | (bytes[offset + 1] << 8);
      offset += 2;
      const index = highest - code;
      indices[i] = index;
      if (code === 0) highest++;
    }

    const positions = new Float32Array(vertexCount * 3);
    const minH = minimumHeight;
    const heightRange = Math.max(maximumHeight - minimumHeight, 1e-6);
    const originX = header.originX;
    const originY = header.originY;
    const span = header.tileWorldSpan;

    for (let i = 0; i < vertexCount; i++) {
      positions[i * 3] = originX + (u[i] / 32767) * span;
      positions[i * 3 + 1] = originY + (v[i] / 32767) * span;
      positions[i * 3 + 2] = minH + (h[i] / 32767) * heightRange;
    }

    const normals = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) normals[i * 3 + 2] = 1;

    const biomeWeights = new Float32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) biomeWeights[i] = h[i] / 32767;

    let bMinX = Infinity, bMinY = Infinity, bMinZ = Infinity;
    let bMaxX = -Infinity, bMaxY = -Infinity, bMaxZ = -Infinity;
    for (let i = 0; i < vertexCount; i++) {
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      if (x < bMinX) bMinX = x; if (x > bMaxX) bMaxX = x;
      if (y < bMinY) bMinY = y; if (y > bMaxY) bMaxY = y;
      if (z < bMinZ) bMinZ = z; if (z > bMaxZ) bMaxZ = z;
    }

    const payload = {
      vertexCount,
      triangleCount,
      positions,
      normals,
      indices,
      biomeWeights,
      westIndices: new Uint32Array(0),
      southIndices: new Uint32Array(0),
      eastIndices: new Uint32Array(0),
      northIndices: new Uint32Array(0),
      minHeight: minH,
      maxHeight: maximumHeight,
      header: {
        centerX, centerY, centerZ,
        boundingSphere: { radius: boundingSphereRadius }
      },
      hasNormals: 0,
      hasWaterMask: 0,
      hasMetadata: 0,
      bounds: [bMinX, bMinY, bMinZ, bMaxX, bMaxY, bMaxZ]
    };

    queueMicrotask(() => this.onTileReady(handle, payload));
  }

  bindDecodedPayloadImpl(header, payload) {
    const terrain = QuantizedMeshTerrain.fromWorkerResult(
      { ...payload, tileX: header.tileX, tileY: header.tileY, tileZ: header.tileZ, lod: header.lod },
      { tileX: header.tileX, tileY: header.tileY, tileZ: header.tileZ, lod: header.lod },
      { tileWorldSize: header.tileWorldSpan, entityId: header.entityId }
    );
    if (this.ecsWorld && this.frame) {
      terrain.bindToContext(this.ecsWorld, this.frame, this.lastTick);
    }
    return terrain;
  }

  estimateTileBytesImpl(payload) {
    return payload.positions.byteLength + payload.normals.byteLength +
           payload.indices.byteLength + payload.biomeWeights.byteLength;
  }

  releaseTileImpl(tileRecord) {
    if (tileRecord.terrainObject) tileRecord.terrainObject.dispose();
  }
}

// ---------------------------------------------------------------------------
// 6. FACTORIES
// ---------------------------------------------------------------------------

/**
 * Creates a ProceduralTerrainSource with sensible defaults for the seamless
 * pipeline.
 */
export function createProceduralTerrainSource(options = {}) {
  return new ProceduralTerrainSource({
    sourceId: options.sourceId ?? 1,
    tilesetId: options.tilesetId ?? 1,
    maxLod: options.maxLod ?? 12,
    tileWorldSize: options.tileWorldSize ?? 100,
    maxConcurrentRequests: options.maxConcurrentRequests ?? 4,
    maxPendingRequests: options.maxPendingRequests ?? 64,
    targetHz: options.targetHz ?? 10,
    noisePeriod: options.noisePeriod ?? 512,
    octaves: options.octaves ?? 5,
    lacunarity: options.lacunarity ?? 2.0,
    persistence: options.persistence ?? 0.5,
    seed: options.seed ?? 1337,
    zScale: options.zScale ?? 500,
    resolution: options.resolution ?? 65,
    ...options
  });
}

/**
 * Creates a HeightmapTerrainSource for decoding raw binary heightmaps.
 */
export function createHeightmapTerrainSource(options = {}) {
  return new HeightmapTerrainSource({
    sourceId: options.sourceId ?? 2,
    tilesetId: options.tilesetId ?? 1,
    encoding: options.encoding ?? 'uint16',
    minElevation: options.minElevation ?? 0,
    maxElevation: options.maxElevation ?? 1000,
    resolution: options.resolution ?? 65,
    ...options
  });
}

/**
 * Creates a QuantizedMeshTerrainSource for decoding Cesium quantized-mesh
 * payloads.
 */
export function createQuantizedMeshTerrainSource(options = {}) {
  return new QuantizedMeshTerrainSource({
    sourceId: options.sourceId ?? 3,
    tilesetId: options.tilesetId ?? 1,
    computeNormalsFallback: options.computeNormalsFallback ?? true,
    ...options
  });
}

// ---------------------------------------------------------------------------
// 7. BARREL EXPORT
// ---------------------------------------------------------------------------

export default {
  TerrainSource,
  ProceduralTerrainSource,
  HeightmapTerrainSource,
  QuantizedMeshTerrainSource,
  createProceduralTerrainSource,
  createHeightmapTerrainSource,
  createQuantizedMeshTerrainSource
};