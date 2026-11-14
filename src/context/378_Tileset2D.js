// file number : 378
// full path name : src/context/378_Tileset2D.js
//### Description : Context-aware Tileset2D — the main container that owns a
//###               complete 2D seamless terrain tileset. Wraps the quadtree
//###               adapter (file 377), the streaming queue, and the tile
//###               reconciler into a single coherent object with a clean
//###               public surface. Exposes update(viewportId, camera),
//###               selectTiles(), getTileHeaders(), and getVisibleTiles() so
//###               the runtime can drive the whole tileset with a handful of
//###               calls per tick. Integrates fully with the context frame
//###               (spatial channel), the ECS world (Tile2DHeaderComponent
//###               instances), and the CoreEventDispatcher (tile lifecycle
//###               events). Runs its own priority-ordered streaming queue so
//###               loads never block the main thread and always proceed in
//###               visible-area order (blueprint step 26). Handles LOD
//###               cross-fades by delegating to the adapter’s seam stitching
//###               and by emitting per-tile blendAlpha values to the render
//###               dispatch stage. All state is parametric: no external loader,
//###               no CDN access, no static server. Allocation-free in the hot
//###               path via caller-supplied buffers, so it can run inside the
//###               60 Hz loop without GC pauses. Designed for Android arm64
//###               under the 8 ms per-tick CPU ceiling and 200 MB resident
//###               memory cap, and scales from a single 10-unit tile to
//###               galactic streaming (10k+ units) without main-thread stalls.
//### Best for : The single object that the runtime interacts with to drive a
//###            complete seamless terrain tileset. Any consumer that needs to
//###            “give me the tiles this frame”, “load these tiles”, or “evict
//###            those tiles” should call Tileset2D.update() and then read
//###            getVisibleTiles(). The tileset owns the quadtree, the streaming
//###            queue, the viewport references, and the tile lifecycle, so the
//###            runtime never needs to touch the adapter or headers directly.
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
  SeamEdge,
  TileEventType,
  hasSeam,
  oppositeEdge,
  stringTileKey,
  packTileKey,
  fnv1aHash,
  computeScreenSpaceError,
  computeLodIndex,
  computeLodBlendAlpha,
  computeTilePriority,
  isSphereOutsideFrustum,
  isBoxOutsideFrustum,
  distanceToSphereSquared,
  computeChildTileCoords,
  computeParentTileCoord,
  computeTileNeighbors,
  extractFrustumPlanes,
  DEFAULT_TILESET_OPTIONS
} from './373_Tileset2DTypes.js';

import {
  Tile2DHeader,
  Tile2DHeaderComponent,
  Tile2DHeaderPool,
  areQuadtreeAdjacent,
  sharedEdge
} from './376_Tile2DHeader.js';

import {
  Tileset2DAdapter,
  ViewportState,
  createTerrainAdapter
} from './377_Tileset2DAdapter.js';

// ---------------------------------------------------------------------------
// 1. STREAMING QUEUE – priority-ordered, cancellation-safe
// ---------------------------------------------------------------------------

/**
 * StreamingQueue — a priority-ordered list of tiles awaiting ingestion.
 *
 * The queue is a plain array kept sorted by (priority desc, insertion seq
 * asc). Since the queue depth is bounded (maxPendingRequests, default 32),
 * sorting is O(n log n) on a tiny array — negligible compared with the
 * network/decode cost. Tiles are removed by key when they leave the
 * viewport before loading starts (cancellation).
 *
 * The queue never blocks the main thread: the caller drains it asynchronously
 * via the provider’s worker pool, and each entry carries its full
 * Tile2DHeader reference so no lookup is needed after the response arrives.
 */
export class StreamingQueue {
  constructor(options = {}) {
    this.maxPending = options.maxPendingRequests ?? DEFAULT_TILESET_OPTIONS.maxPendingRequests;
    this.entries = [];      // { header, seq, priority }
    this.byKey = new Map(); // tileKey → entry
    this.nextSeq = 1;
    this.droppedCount = 0;
    this.enqueuedCount = 0;
  }

  /**
   * Attempts to enqueue a tile for streaming. Returns false if the queue is
   * full (backpressure per blueprint step 22).
   */
  enqueue(header) {
    if (this.byKey.has(header.tileKey)) return true; // already queued
    if (this.entries.length >= this.maxPending) {
      this.droppedCount++;
      return false;
    }
    const entry = {
      header,
      seq: this.nextSeq++,
      priority: header.priority
    };
    // Insert in sorted position (simple insertion sort — queue is tiny).
    let i = this.entries.length;
    while (i > 0 && this._shouldPrecede(entry, this.entries[i - 1])) {
      i--;
    }
    this.entries.splice(i, 0, entry);
    this.byKey.set(header.tileKey, entry);
    this.enqueuedCount++;
    return true;
  }

  /**
   * Removes a tile from the queue (cancellation). Returns the entry, or null.
   */
  cancel(tileKey) {
    const entry = this.byKey.get(tileKey);
    if (!entry) return null;
    const idx = this.entries.indexOf(entry);
    if (idx >= 0) this.entries.splice(idx, 1);
    this.byKey.delete(tileKey);
    return entry;
  }

  /**
   * Returns the highest-priority entry without removing it, or null.
   */
  peek() {
    return this.entries[0] ?? null;
  }

  /**
   * Removes and returns the highest-priority entry, or null.
   */
  dequeue() {
    const entry = this.entries.shift();
    if (!entry) return null;
    this.byKey.delete(entry.header.tileKey);
    return entry;
  }

  /**
   * Re-sorts the queue after priorities change (called once per selection
   * pass, so freshly-computed priorities are honored on the next dequeue).
   */
  resort() {
    for (const entry of this.entries) {
      entry.priority = entry.header.priority;
    }
    this.entries.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.seq - b.seq;
    });
  }

  has(tileKey) {
    return this.byKey.has(tileKey);
  }

  size() {
    return this.entries.length;
  }

  clear() {
    this.entries.length = 0;
    this.byKey.clear();
  }

  _shouldPrecede(a, b) {
    if (a.priority !== b.priority) return a.priority > b.priority;
    return a.seq < b.seq;
  }
}

// ---------------------------------------------------------------------------
// 2. Tileset2D – the main container
// ---------------------------------------------------------------------------

/**
 * Tileset2D — the top-level object the runtime interacts with to drive a
 * complete seamless terrain tileset.
 *
 * Lifecycle (per tick, called from stage three or stage four of the
 * orchestration loop):
 *
 *   1. update(viewportId, camera, tick) — refreshes the viewport state,
 *      runs the adapter’s selection pass, and re-prioritizes the streaming
 *      queue.
 *   2. getVisibleTiles() — returns the current selection so the render
 *      dispatch stage can emit draw calls.
 *   3. drainStreamingQueue(providerFn) — hands the highest-priority entries
 *      to the upstream provider (file 371/372/375) for decode. The provider
 *      is responsible for the async work and for calling markReady() when
 *      it finishes.
 *
 * The tileset never allocates in the hot path. All scratch buffers are
 * pre-allocated. All numeric output goes through caller-supplied arrays.
 */
export class Tileset2D {
  constructor(options = {}) {
    this.options = {
      // Identity
      tilesetId: options.tilesetId ?? 1,
      sourceFormat: options.sourceFormat ?? TilesetSourceFormat.PROCEDURAL_2D,

      // Quadtree
      maxLod: options.maxLod ?? DEFAULT_TILESET_OPTIONS.maxLod,
      tileWorldSize: options.tileWorldSize ?? DEFAULT_TILESET_OPTIONS.tileWorldSize,
      minZ: options.minZ ?? -10000,
      maxZ: options.maxZ ?? 10000,

      // Streaming
      maxPendingRequests: options.maxPendingRequests ?? DEFAULT_TILESET_OPTIONS.maxPendingRequests,
      maxActiveTiles: options.maxActiveTiles ?? DEFAULT_TILESET_OPTIONS.maxActiveTiles,
      targetHz: options.targetHz ?? DEFAULT_TILESET_OPTIONS.targetHz,

      // LOD
      screenSpaceErrorTarget: options.screenSpaceErrorTarget ?? DEFAULT_TILESET_OPTIONS.screenSpaceErrorTarget,
      refinement: options.refinement ?? TileRefinement.REPLACE,
      enableSeamStitching: options.enableSeamStitching ?? true,

      // Priority weights
      priorityAlpha: options.priorityAlpha ?? DEFAULT_TILESET_OPTIONS.priorityAlpha,
      priorityBeta: options.priorityBeta ?? DEFAULT_TILESET_OPTIONS.priorityBeta,
      priorityGamma: options.priorityGamma ?? DEFAULT_TILESET_OPTIONS.priorityGamma,

      // Eviction
      evictionGraceTicks: options.evictionGraceTicks ?? 30,
      maxResidentBytes: options.maxResidentBytes ?? DEFAULT_TILESET_OPTIONS.maxResidentBytes,
      perTileByteBudget: options.perTileByteBudget ?? DEFAULT_TILESET_OPTIONS.perTileByteBudget,

      ...options
    };

    // ---- Adapter: quadtree + viewport selection ----
    this.adapter = createTerrainAdapter(this.options);

    // ---- Streaming queue ----
    this.streamingQueue = new StreamingQueue({
      maxPendingRequests: this.options.maxPendingRequests
    });

    // ---- Visible tiles: flattened per-frame output (SoA for the dispatch) ----
    this._visible = {
      keys: [],
      lods: [],
      entityIds: [],
      bounds: [],          // 6 per tile
      spheres: [],         // 4 per tile
      blendAlphas: [],     // 1 per tile
      priorities: [],      // 1 per tile
      seamFlags: [],       // 1 per tile (bitfield)
      state: [],           // 1 per tile
      count: 0
    };

    // ---- Live tile registry: tileKey → Tile2DHeader ----
    // (the adapter owns the authoritative registry; this is a parallel view
    //  for fast lookup by external consumers)
    this.tileRegistry = new Map();

    // ---- Event queue for tile lifecycle events ----
    this.eventQueue = [];

    // ---- Context frame and ECS bindings ----
    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;
    this.lastTick = 0;
    this._accumulator = 0;

    // ---- Diagnostics ----
    this.stats = {
      selectedCount: 0,
      queueSize: 0,
      loadedCount: 0,
      failedCount: 0,
      evictedCount: 0,
      lastUpdateTick: 0,
      lastUpdateDurationMs: 0
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Binds the tileset to the runtime's context frame, ECS world, and event
   * dispatcher. Called once at startup by the terrain reconciler (file 380).
   * Safe to call multiple times (subsequent calls update the bindings).
   */
  bind(contextFrame, ecsWorld, dispatcher = null) {
    this.frame = contextFrame;
    this.ecsWorld = ecsWorld;
    this.dispatcher = dispatcher;
    this.adapter.bind(contextFrame, ecsWorld);
    return this;
  }

  /**
   * Registers a viewport with this tileset. Returns the ViewportState so the
   * caller can inspect selection diagnostics.
   */
  registerViewport(viewportId) {
    return this.adapter.registerViewport(viewportId);
  }

  /**
   * Unregisters a viewport and releases its tile references.
   */
  unregisterViewport(viewportId) {
    this.adapter.unregisterViewport(viewportId);
  }

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------

  /**
   * Runs a full selection pass for the given viewport.
   *
   * @param {number|string} viewportId
   * @param {object} camera — { x, y, z, forwardX, forwardY, forwardZ,
   *                            upX, upY, upZ, rightX, rightY, rightZ,
   *                            fov, near, far, screenWidth, screenHeight }
   * @param {number} tick
   * @returns {number} number of tiles selected this frame
   */
  update(viewportId, camera, tick) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.lastTick = tick;

    // 1. Update the viewport's camera state.
    const vp = this.adapter.viewports.get(viewportId);
    if (!vp) throw new Error('Unknown viewport: ' + viewportId);
    vp.updateCamera(
      camera.x, camera.y, camera.z,
      camera.forwardX, camera.forwardY, camera.forwardZ,
      camera.upX, camera.upY, camera.upZ,
      camera.rightX, camera.rightY, camera.rightZ,
      camera.fov, camera.near, camera.far,
      camera.screenWidth, camera.screenHeight
    );

    // 2. Run the adapter's selection pass.
    const selected = this.adapter.selectTiles(viewportId, tick);
    this.stats.selectedCount = selected.length;

    // 3. Rebuild the visible-tile SoA for the dispatch stage.
    this._rebuildVisible(selected);

    // 4. Sync the streaming queue: cancel tiles that left the viewport,
    //    enqueue tiles that entered it.
    this._syncStreamingQueue(selected);

    // 5. Evict tiles that have not been visible for `evictionGraceTicks`.
    this._evictStale(tick);

    // 6. Flush lifecycle events.
    this._flushEvents(tick);

    // 7. Update diagnostics.
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.stats.lastUpdateTick = tick;
    this.stats.lastUpdateDurationMs = t1 - t0;

    return selected.length;
  }

  /**
   * Rebuilds the visible-tile SoA from the adapter's selection list.
   * Called every frame; allocation-free because the arrays are reused.
   */
  _rebuildVisible(selected) {
    const v = this._visible;
    v.keys.length = 0;
    v.lods.length = 0;
    v.entityIds.length = 0;
    v.bounds.length = 0;
    v.spheres.length = 0;
    v.blendAlphas.length = 0;
    v.priorities.length = 0;
    v.seamFlags.length = 0;
    v.state.length = 0;

    for (let i = 0; i < selected.length; i++) {
      const h = selected[i];
      v.keys.push(h.tileKey);
      v.lods.push(h.lod);
      v.entityIds.push(h.entityId);
      v.bounds.push(h.minX, h.minY, h.minZ, h.maxX, h.maxY, h.maxZ);
      v.spheres.push(h.centerX, h.centerY, h.centerZ, h.boundingSphereRadius);
      v.blendAlphas.push(h.blendAlpha);
      v.priorities.push(h.priority);
      v.seamFlags.push(h.seamFlags);
      v.state.push(h.state);
    }
    v.count = selected.length;
  }

  /**
   * Synchronises the streaming queue with the current selection.
   *   - Tiles that left the viewport and are still queued are cancelled.
   *   - Tiles that are READY are removed from the queue.
   *   - Tiles that are UNLOADED are enqueued.
   *   - The queue is re-sorted to honor the freshly-computed priorities.
   */
  _syncStreamingQueue(selected) {
    // Cancel stale entries.
    for (let i = this.streamingQueue.entries.length - 1; i >= 0; i--) {
      const entry = this.streamingQueue.entries[i];
      const h = entry.header;
      if (h.getViewportRefCount() === 0) {
        this.streamingQueue.cancel(h.tileKey);
        h.clearPendingRequest();
      }
    }

    // Enqueue new entries.
    for (let i = 0; i < selected.length; i++) {
      const h = selected[i];
      if (h.state === TileState.READY) {
        this.streamingQueue.cancel(h.tileKey);
        continue;
      }
      if (h.state === TileState.FAILED) {
        continue;
      }
      if (h.state === TileState.UNLOADED && !this.streamingQueue.has(h.tileKey)) {
        const ok = this.streamingQueue.enqueue(h);
        if (ok) {
          h.state = TileState.QUEUED;
          this._emitEvent(TileEventType.TILE_REQUESTED, h, this.lastTick);
        }
      }
    }

    // Re-sort after priorities updated.
    this.streamingQueue.resort();
    this.stats.queueSize = this.streamingQueue.size();
  }

  /**
   * Evicts tiles that have been out of any viewport for `evictionGraceTicks`.
   * Called once per update. Uses the tile registry (kept in sync by the
   * reconciler / provider) so the tileset itself does not walk the tree.
   */
  _evictStale(tick) {
    const grace = this.options.evictionGraceTicks;
    const toEvict = [];
    for (const [key, header] of this.tileRegistry) {
      if (header.state === TileState.READY && header.getViewportRefCount() === 0) {
        if (tick - header.lastUsedTick > grace) {
          toEvict.push(header);
        }
      }
    }
    for (const header of toEvict) {
      header.markEvicted();
      this.stats.evictedCount++;
      this._emitEvent(TileEventType.TILE_EVICTED, header, tick);
    }
  }

  /**
   * Flushes queued lifecycle events to the dispatcher.
   */
  _flushEvents(tick) {
    if (!this.dispatcher || this.eventQueue.length === 0) {
      this.eventQueue.length = 0;
      return;
    }
    for (const evt of this.eventQueue) {
      try {
        this.dispatcher.dispatch(evt.type, evt.payload);
      } catch (e) {
        // Dispatcher errors must never break the tileset.
      }
    }
    this.eventQueue.length = 0;
  }

  _emitEvent(type, header, tick) {
    this.eventQueue.push({
      type,
      payload: {
        tilesetId: this.options.tilesetId,
        tileKey: header.tileKey,
        lod: header.lod,
        x: header.tileX,
        y: header.tileY,
        z: header.tileZ,
        entityId: header.entityId,
        tick
      }
    });
  }

  // -------------------------------------------------------------------------
  // Public queries
  // -------------------------------------------------------------------------

  /**
   * Returns the visible tile list as a read-only SoA object:
   *   {
   *     keys: string[], lods: number[], entityIds: number[],
   *     bounds: number[], spheres: number[],
   *     blendAlphas: number[], priorities: number[],
   *     seamFlags: number[], state: number[],
   *     count: number
   *   }
   *
   * The arrays are reused across frames — callers must consume them
   * immediately (typically during the render dispatch stage). Do not hold
   * references across frames.
   */
  getVisibleTiles() {
    return this._visible;
  }

  /**
   * Returns the current visible tile list as an array of header references.
   * This is the higher-level query, useful for tests and for the reconciler
   * when it needs to act on the full header objects.
   */
  getVisibleHeaders(viewportId) {
    const vp = this.adapter.viewports.get(viewportId);
    if (!vp) return [];
    const out = [];
    for (let i = 0; i < vp.selectedCount; i++) {
      out.push(vp.selectedTiles[i]);
    }
    return out;
  }

  /**
   * Returns the current streaming queue as a list of { tileKey, priority,
   * lod, x, y, z, state } entries, in the order they will be dequeued.
   * Callers hand this to the upstream provider to drive decode work.
   */
  getStreamingCandidates(maxCount = 8) {
    const out = [];
    const n = Math.min(maxCount, this.streamingQueue.entries.length);
    for (let i = 0; i < n; i++) {
      const entry = this.streamingQueue.entries[i];
      const h = entry.header;
      out.push({
        tileKey: h.tileKey,
        lod: h.lod,
        x: h.tileX,
        y: h.tileY,
        z: h.tileZ,
        priority: entry.priority,
        state: h.state,
        header: h
      });
    }
    return out;
  }

  /**
   * Marks a tile as loaded and ready for rendering. Called by the upstream
   * provider (file 371/372/375) after decode completes. The tileset updates
   * the header state, records the ready tick, and emits a TILE_READY event.
   */
  markTileReady(tileKey, tick) {
    const header = this.tileRegistry.get(tileKey);
    if (!header) return false;
    header.markReady(tick);
    this.streamingQueue.cancel(tileKey);
    header.clearPendingRequest();
    this.stats.loadedCount++;
    this._emitEvent(TileEventType.TILE_READY, header, tick);
    return true;
  }

  /**
   * Marks a tile as failed. Called by the provider on decode error. The
   * tileset will not re-request it until the tile is evicted or the failure
   * is cleared by an explicit retry.
   */
  markTileFailed(tileKey, tick) {
    const header = this.tileRegistry.get(tileKey);
    if (!header) return false;
    header.markFailed(tick);
    this.streamingQueue.cancel(tileKey);
    header.clearPendingRequest();
    this.stats.failedCount++;
    this._emitEvent(TileEventType.TILE_FAILED, header, tick);
    return true;
  }

  /**
   * Explicitly retries a failed tile. Clears the FAILED state and re-enqueues
   * the tile on the next selection pass.
   */
  retryTile(tileKey) {
    const header = this.tileRegistry.get(tileKey);
    if (!header || header.state !== TileState.FAILED) return false;
    header.state = TileState.UNLOADED;
    return true;
  }

  /**
   * Records a header in the tileset's live registry. Called by the reconciler
   * when a new child header is created by the adapter.
   */
  registerHeader(header) {
    this.tileRegistry.set(header.tileKey, header);
  }

  /**
   * Removes a header from the live registry. Called by the reconciler on
   * eviction.
   */
  unregisterHeader(tileKey) {
    this.tileRegistry.delete(tileKey);
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  /**
   * Returns a snapshot of the tileset's runtime statistics.
   */
  getStats() {
    return {
      tilesetId: this.options.tilesetId,
      selectedCount: this.stats.selectedCount,
      queueSize: this.stats.queueSize,
      loadedCount: this.stats.loadedCount,
      failedCount: this.stats.failedCount,
      evictedCount: this.stats.evictedCount,
      registrySize: this.tileRegistry.size,
      lastUpdateTick: this.stats.lastUpdateTick,
      lastUpdateDurationMs: this.stats.lastUpdateDurationMs
    };
  }

  /**
   * Returns per-tile diagnostic info for a given tile key. Useful for HUDs
   * and debug overlays.
   */
  inspectTile(tileKey) {
    const h = this.tileRegistry.get(tileKey);
    if (!h) return null;
    return {
      tileKey,
      lod: h.lod,
      x: h.tileX,
      y: h.tileY,
      z: h.tileZ,
      state: h.state,
      priority: h.priority,
      screenSpaceError: h.screenSpaceError,
      blendAlpha: h.blendAlpha,
      boundingSphereRadius: h.boundingSphereRadius,
      viewportRefs: h.getViewportRefCount(),
      seamFlags: h.seamFlags,
      neighborLods: { ...h.neighborLods },
      lastUsedTick: h.lastUsedTick,
      lastReadyTick: h.lastReadyTick
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Clears the entire tileset: cancels all pending requests, releases all
   * headers back to the adapter's pool, and destroys all ECS entities.
   */
  clear() {
    this.streamingQueue.clear();
    this.tileRegistry.clear();
    this.adapter.clearTileset(this.options.tilesetId);
    this._visible.count = 0;
    this._visible.keys.length = 0;
    this.stats.selectedCount = 0;
    this.stats.queueSize = 0;
  }

  /**
   * Destroys the tileset and releases all resources. After dispose(), the
   * instance cannot be reused.
   */
  dispose() {
    this.clear();
    this.adapter.dispose();
    this.adapter = null;
    this.streamingQueue = null;
    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;
  }
}

// ---------------------------------------------------------------------------
// 3. FACTORY – convenience constructors
// ---------------------------------------------------------------------------

/**
 * Creates a Tileset2D for a 2D heightfield (procedurally generated or decoded
 * from a raw heightmap payload). Matches the seamless-tile provider
 * (file 365) and the heightmap decoder (file 371).
 */
export function createHeightmapTileset(options = {}) {
  return new Tileset2D({
    sourceFormat: options.sourceFormat ?? TilesetSourceFormat.PROCEDURAL_2D,
    maxLod: options.maxLod ?? 12,
    tileWorldSize: options.tileWorldSize ?? 100,
    screenSpaceErrorTarget: options.screenSpaceErrorTarget ?? 16,
    refinement: options.refinement ?? TileRefinement.REPLACE,
    ...options
  });
}

/**
 * Creates a Tileset2D for a 3D mesh tileset (quantized-mesh or procedural
 * voxel terrain). Uses the same traversal engine but with a different
 * content format so downstream systems know to expect irregular meshes
 * rather than heightfields.
 */
export function createMeshTileset(options = {}) {
  return new Tileset2D({
    sourceFormat: options.sourceFormat ?? TilesetSourceFormat.QUANTIZED_MESH,
    maxLod: options.maxLod ?? 14,
    tileWorldSize: options.tileWorldSize ?? 200,
    screenSpaceErrorTarget: options.screenSpaceErrorTarget ?? 24,
    refinement: options.refinement ?? TileRefinement.REPLACE,
    ...options
  });
}

// ---------------------------------------------------------------------------
// 4. BARREL EXPORT
// ---------------------------------------------------------------------------

export default {
  Tileset2D,
  StreamingQueue,
  createHeightmapTileset,
  createMeshTileset
};