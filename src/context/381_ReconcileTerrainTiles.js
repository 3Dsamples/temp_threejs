// file number : 381
// full path name : src/context/381_ReconcileTerrainTiles.js
//### Description : Context-aware TerrainTileReconciler — the reconciliation
//###               engine that keeps the desired tile set (from the viewport
//###               adapter, file 377) and the actual tile set (from the terrain
//###               source, file 380) in perfect sync. Runs every tick to: (1)
//###               compare selected tiles against loaded tiles, (2) enqueue new
//###               requests for missing tiles in priority order, (3) cancel
//###               stale requests for tiles that left the frustum, (4) evict
//###               tiles that have not been visible for the grace period, (5)
//###               coordinate LOD cross-fades by advancing per-tile blendAlpha
//###               from 0 to 1 over a fixed transition window, (6) stitch seams
//###               between adjacent tiles at different LODs by marking both
//###               sides as seam-aware, and (7) emit lifecycle events
//###               (TILE_REQUESTED, TILE_READY, TILE_EVICTED, TILESET_UPDATED)
//###               to the CoreEventDispatcher. Because every operation is O(1)
//###               per tile and all per-tile state lives in structure-of-arrays
//###               buffers, the reconciler never allocates in the hot path, can
//###               run inside the 60 Hz loop without GC pauses, and scales from
//###               a single 10-unit tile to galactic streaming (10k+ units)
//###               without main-thread stalls. Fully parametric: no external
//###               loader, no CDN access, no static server. Designed for Android
//###               arm64 under the 8 ms per-tick CPU ceiling and 200 MB resident
//###               memory cap.
//### Best for : The single coordinator the runtime calls per tick to make
//###            streaming, LOD, and seam transitions “just happen”. The
//###            reconciler owns the LOD cross-fade clock, the seam-stitching
//###            pass, and the eviction policy, so neither the tileset nor the
//###            source needs to know about the others. Any consumer that needs
//###            “what should be visible this frame, at what blend weight, with
//###            which seams stitched” reads the reconciler’s output.
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
  computeTileNeighbors,
  extractFrustumPlanes
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

import {
  Tileset2D,
  StreamingQueue,
  createHeightmapTileset,
  createMeshTileset
} from './378_Tileset2D.js';

import { TerrainSource } from './380_TerrainSource.js';

// ---------------------------------------------------------------------------
// 1. LOD TRANSITION RECORD – per-tile cross-fade state
// ---------------------------------------------------------------------------

/**
 * LODTransition — a single in-flight LOD cross-fade.
 *
 * When a parent tile is superseded by its READY children, the parent must
 * fade out while the children fade in, over a short window (typically
 * 100–200 ms). The reconciler keeps one LODTransition per active fade so
 * the shader can read both alpha values without the runtime having to
 * recompute them each frame.
 *
 * Stored in a structure-of-arrays container so the reconciler never allocates.
 */
class LODTransitionArena {
  constructor(capacity) {
    this.capacity = capacity;
    this.count = 0;
    this.free = new Uint32Array(capacity);
    this.freeCount = capacity;
    for (let i = 0; i < capacity; i++) this.free[i] = i;

    this.tileKeyHash = new Uint32Array(capacity);
    this.tileKeyRef = new Array(capacity);
    this.parentEntityId = new Uint32Array(capacity);
    this.childEntityIds = new Uint32Array(capacity * 4);
    this.startTick = new Uint32Array(capacity);
    this.durationTicks = new Uint16Array(capacity);
    this.alpha = new Float32Array(capacity); // 0 = parent visible, 1 = children visible
    this.active = new Uint8Array(capacity);
  }

  acquire() {
    if (this.freeCount === 0) return -1;
    return this.free[--this.freeCount];
  }

  release(slot) {
    if (slot < 0 || slot >= this.capacity) return;
    this.tileKeyRef[slot] = null;
    this.parentEntityId[slot] = 0xFFFFFFFF;
    this.childEntityIds[slot * 4 + 0] = 0xFFFFFFFF;
    this.childEntityIds[slot * 4 + 1] = 0xFFFFFFFF;
    this.childEntityIds[slot * 4 + 2] = 0xFFFFFFFF;
    this.childEntityIds[slot * 4 + 3] = 0xFFFFFFFF;
    this.alpha[slot] = 0;
    this.active[slot] = 0;
    this.free[this.freeCount++] = slot;
  }
}

// ---------------------------------------------------------------------------
// 2. RECONCILER
// ---------------------------------------------------------------------------

/**
 * TerrainTileReconciler — the per-tick coordinator for the seamless terrain
 * pipeline.
 *
 * Wiring:
 *   - Owns a `Tileset2D` (file 378) which owns the adapter (file 377), the
 *     quadtree (file 376), and the streaming queue.
 *   - Owns a `TerrainSource` (file 380) which produces decoded tiles.
 *   - Reads the context frame’s player position for priority scoring.
 *   - Writes the visible-tile SoA into the frame’s spatial channel.
 *
 * The reconciler runs at 10 Hz (metabolism tier). It does not touch the
 * render loop directly; instead, it publishes the visible SoA which the
 * 60 Hz render dispatch stage reads.
 */
export class TerrainTileReconciler {
  constructor(options = {}) {
    this.options = {
      // Identity
      reconcilerId: options.reconcilerId ?? 1,
      tilesetId: options.tilesetId ?? 1,
      sourceId: options.sourceId ?? 1,

      // Frequency
      targetHz: options.targetHz ?? 10,

      // LOD cross-fade
      lodTransitionMs: options.lodTransitionMs ?? 150,
      lodTransitionTicks: options.lodTransitionTicks ?? 10,

      // Eviction
      evictionGraceTicks: options.evictionGraceTicks ?? 30,
      maxTiles: options.maxTiles ?? DEFAULT_TILESET_OPTIONS.maxActiveTiles,
      maxResidentBytes: options.maxResidentBytes ?? DEFAULT_TILESET_OPTIONS.maxResidentBytes,

      // Seam stitching
      enableSeamStitching: options.enableSeamStitching ?? true,

      // Quadtree & tileset parameters
      maxLod: options.maxLod ?? DEFAULT_TILESET_OPTIONS.maxLod,
      tileWorldSize: options.tileWorldSize ?? DEFAULT_TILESET_OPTIONS.tileWorldSize,
      screenSpaceErrorTarget: options.screenSpaceErrorTarget ?? DEFAULT_TILESET_OPTIONS.screenSpaceErrorTarget,
      minZ: options.minZ ?? -10000,
      maxZ: options.maxZ ?? 10000,

      // Source settings
      sourceFormat: options.sourceFormat ?? TilesetSourceFormat.PROCEDURAL_2D,
      noisePeriod: options.noisePeriod ?? 512,
      octaves: options.octaves ?? 5,
      lacunarity: options.lacunarity ?? 2.0,
      persistence: options.persistence ?? 0.5,
      seed: options.seed ?? 1337,
      zScale: options.zScale ?? 500,
      resolution: options.resolution ?? 65,

      ...options
    };

    // ---- Tileset (owns the quadtree & streaming queue) ----
    this.tileset = new Tileset2D({
      tilesetId: this.options.tilesetId,
      sourceFormat: this.options.sourceFormat,
      maxLod: this.options.maxLod,
      tileWorldSize: this.options.tileWorldSize,
      minZ: this.options.minZ,
      maxZ: this.options.maxZ,
      screenSpaceErrorTarget: this.options.screenSpaceErrorTarget,
      maxActiveTiles: this.options.maxTiles,
      evictionGraceTicks: this.options.evictionGraceTicks,
      enableSeamStitching: this.options.enableSeamStitching
    });

    // ---- Terrain source (produces decoded tiles) ----
    this.source = null; // set via setSource()

    // ---- LOD cross-fade transitions ----
    this.transitions = new LODTransitionArena(256);

    // ---- Context frame / ECS / dispatcher ----
    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;

    // ---- Last tick & accumulator ----
    this.lastTick = 0;
    this._accumulator = 0;

    // ---- Per-frame SoA output (published to the frame’s spatial channel) ----
    this._published = {
      keys: [],
      lods: [],
      entityIds: [],
      bounds: [],
      spheres: [],
      blendAlphas: [],
      priorities: [],
      seamFlags: [],
      state: [],
      transitionAlpha: [], // 0..1, per tile (1 = fully visible)
      transitionActive: [],
      count: 0
    };

    // ---- Diagnostics ----
    this.stats = {
      ticksReconciled: 0,
      transitionsStarted: 0,
      transitionsCompleted: 0,
      requestsIssued: 0,
      requestsCancelled: 0,
      tilesEvicted: 0,
      seamsStitched: 0,
      lastDurationMs: 0
    };
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  /**
   * Binds the reconciler to the live context frame, ECS world, and event
   * dispatcher. Also binds the underlying tileset and source. Called once
   * at startup.
   */
  bind(contextFrame, ecsWorld, dispatcher = null) {
    this.frame = contextFrame;
    this.ecsWorld = ecsWorld;
    this.dispatcher = dispatcher;
    this.tileset.bind(contextFrame, ecsWorld, dispatcher);
    if (this.source) this.source.bind(contextFrame, ecsWorld, dispatcher);
    return this;
  }

  /**
   * Sets the terrain source the reconciler will use to produce tiles.
   * Must be called before the first update().
   */
  setSource(source) {
    this.source = source;
    if (this.frame && this.ecsWorld) {
      this.source.bind(this.frame, this.ecsWorld, this.dispatcher);
    }
    return this;
  }

  /**
   * Registers a viewport with the tileset. Returns the ViewportState.
   */
  registerViewport(viewportId) {
    return this.tileset.registerViewport(viewportId);
  }

  /**
   * Unregisters a viewport.
   */
  unregisterViewport(viewportId) {
    this.tileset.unregisterViewport(viewportId);
  }

  // -------------------------------------------------------------------------
  // Main per-tick reconcile
  // -------------------------------------------------------------------------

  /**
   * The single entry point the runtime calls every tick from stage three or
   * stage four. Runs at the reconciler's target frequency (default 10 Hz).
   *
   * @param {ContextFrame} contextFrame – the live context frame
   * @param {number} tick – current tick counter
   * @param {number} dt – delta time in seconds
   * @param {object} camera – per-viewport camera state (see Tileset2D.update)
   * @param {number|string} viewportId – the viewport whose camera drives selection
   */
  update(contextFrame, tick, dt, camera, viewportId) {
    this.frame = contextFrame;
    this.lastTick = tick;
    this._accumulator += dt;

    const interval = 1 / this.options.targetHz;
    if (this._accumulator < interval) {
      // Even when not running the full reconcile, advance active LOD
      // transitions so their alphas stay in sync with the render clock.
      this._advanceTransitions(tick);
      return;
    }
    this._accumulator %= interval;

    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // 1. Run the tileset's selection pass for this viewport.
    const selectedHeaders = this.tileset.update(viewportId, camera, tick);

    // 2. Reconcile the desired tiles against the actual tiles: enqueue new
    //    requests, cancel stale ones.
    this._reconcileRequestState(selectedHeaders, tick);

    // 3. Tick the terrain source so it drains its worker pool and merges
    //    completed decodes into the frame.
    if (this.source) {
      this.source.update(contextFrame, tick, dt);
    }

    // 4. Stitch seams between adjacent selected tiles at different LODs.
    if (this.options.enableSeamStitching) {
      this._stitchSeams(selectedHeaders, tick);
    }

    // 5. Start LOD cross-fades where a parent is superseded by ready children.
    this._startTransitionsIfNeeded(selectedHeaders, tick);

    // 6. Advance all active transitions (their alphas are read by the shader).
    this._advanceTransitions(tick);

    // 7. Publish the visible-tile SoA into the frame’s spatial channel.
    this._publishToFrame(selectedHeaders, tick);

    // 8. Emit a TILESET_UPDATED event for downstream observers.
    this._emitEvent(TileEventType.TILESET_UPDATED, null, tick);

    // Diagnostics.
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.stats.lastDurationMs = t1 - t0;
    this.stats.ticksReconciled++;
  }

  // -------------------------------------------------------------------------
  // Reconciliation phases
  // -------------------------------------------------------------------------

  /**
   * Compares the selected tiles against the source's current tile state.
   * Issues requests for missing tiles and cancels requests for tiles that
   * left the viewport.
   */
  _reconcileRequestState(selectedHeaders, tick) {
    if (!this.source) return;

    const selectedSet = new Set();
    for (const h of selectedHeaders) selectedSet.add(h.tileKey);

    // Issue requests for selected tiles that are UNLOADED.
    for (const h of selectedHeaders) {
      if (h.state !== TileState.UNLOADED) continue;
      const requestId = this.source.requestTile(h, { payload: null });
      if (requestId >= 0) {
        h.setPendingRequest(requestId);
        this.stats.requestsIssued++;
      }
      // If requestId < 0, backpressure — leave the tile UNLOADED and retry
      // next tick.
    }

    // Cancel pending requests for tiles that are no longer selected.
    for (const [key, record] of this.source.tileMap) {
      if (!selectedSet.has(key)) {
        const h = record.header;
        if (h && h.hasPendingRequest()) {
          const reqId = h.getPendingRequest();
          this.source.cancelRequest(reqId);
          h.clearPendingRequest();
          this.stats.requestsCancelled++;
        }
      }
    }
  }

  /**
   * Marks seam flags on adjacent selected tiles at different LODs. The
   * shader uses these flags to cross-fade between LOD levels without visible
   * cracks, per blueprint step 19 (smooth LOD transitions).
   */
  _stitchSeams(selectedHeaders, tick) {
    const registry = this.tileset.adapter.headerRegistry;

    for (const h of selectedHeaders) {
      const neighbors = computeTileNeighbors(h.lod, h.tileX, h.tileY, 1 << h.lod);

      for (const edge of [SeamEdge.NORTH, SeamEdge.EAST, SeamEdge.SOUTH, SeamEdge.WEST]) {
        const n = this._neighborForEdge(edge, neighbors);
        if (!n) continue;

        const nKey = stringTileKey(n.lod, n.x, n.y, h.tileZ);
        const neighbor = registry.get(nKey);
        if (!neighbor) continue;

        // Only mark seams when both sides are READY; otherwise the
        // cross-fade would have nothing to blend.
        if (h.state !== TileState.READY || neighbor.state !== TileState.READY) {
          continue;
        }

        if (neighbor.lod === h.lod) {
          // Same LOD: simple seam (both sides agree on the edge samples).
          if (!h.hasSeamOn(edge)) {
            h.setSeam(edge, neighbor.lod, neighbor.entityId);
            neighbor.setSeam(oppositeEdge(edge), h.lod, h.entityId);
            this.stats.seamsStitched++;
          }
        } else {
          // Different LOD: blended seam. The shader reads neighborLod and
          // adjusts the cross-fade weight accordingly.
          if (!h.hasSeamOn(edge)) {
            h.setSeam(edge, neighbor.lod, neighbor.entityId);
            neighbor.setSeam(oppositeEdge(edge), h.lod, h.entityId);
            this.stats.seamsStitched++;
          }
        }
      }
    }
  }

  _neighborForEdge(edge, neighbors) {
    if (edge === SeamEdge.NORTH) return neighbors.north;
    if (edge === SeamEdge.EAST)  return neighbors.east;
    if (edge === SeamEdge.SOUTH) return neighbors.south;
    if (edge === SeamEdge.WEST)  return neighbors.west;
    return null;
  }

  /**
   * Scans the selected set for parents whose children are all READY and
   * which should therefore fade out in favor of their children. Starts a
   * LODTransition for each such parent.
   */
  _startTransitionsIfNeeded(selectedHeaders, tick) {
    const registry = this.tileset.adapter.headerRegistry;

    for (const h of selectedHeaders) {
      // Only consider tiles that have children (i.e. that were refined).
      if (h.isLeaf()) continue;

      // Skip if a transition is already active for this tile.
      if (this._findTransitionByKey(h.tileKey) >= 0) continue;

      // Check whether all four children exist and are READY.
      let allReady = true;
      const childIds = [0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF];
      for (let i = 0; i < 4; i++) {
        const c = h.getChild(i);
        if (!c || c.state !== TileState.READY) {
          allReady = false;
          break;
        }
        childIds[i] = c.entityId;
      }
      if (!allReady) continue;

      // Create a LODTransition for this parent → children cross-fade.
      const slot = this.transitions.acquire();
      if (slot < 0) continue; // transition arena full; try next tick

      this.transitions.tileKeyHash[slot] = h.tileKeyHash;
      this.transitions.tileKeyRef[slot] = h.tileKey;
      this.transitions.parentEntityId[slot] = h.entityId;
      this.transitions.childEntityIds[slot * 4 + 0] = childIds[0];
      this.transitions.childEntityIds[slot * 4 + 1] = childIds[1];
      this.transitions.childEntityIds[slot * 4 + 2] = childIds[2];
      this.transitions.childEntityIds[slot * 4 + 3] = childIds[3];
      this.transitions.startTick[slot] = tick;
      this.transitions.durationTicks[slot] = this.options.lodTransitionTicks;
      this.transitions.alpha[slot] = 0;
      this.transitions.active[slot] = 1;
      this.transitions.count++;

      this.stats.transitionsStarted++;
    }
  }

  /**
   * Advances every active LOD transition's alpha. When alpha reaches 1, the
   * parent can be safely hidden (its children fully cover it) and the
   * transition is released.
   */
  _advanceTransitions(tick) {
    const t = this.transitions;
    for (let slot = 0; slot < t.capacity; slot++) {
      if (!t.active[slot]) continue;

      const elapsed = tick - t.startTick[slot];
      const dur = t.durationTicks[slot] || 1;
      let a = elapsed / dur;
      if (a >= 1) a = 1;

      // Smoothstep for the alpha (blueprint step 19: smooth transitions).
      const smooth = a * a * (3 - 2 * a);
      t.alpha[slot] = smooth;

      if (a >= 1) {
        // Transition complete: fade out the parent and release the slot.
        const header = this.tileset.adapter.headerRegistry.get(t.tileKeyRef[slot]);
        if (header) header.blendAlpha = 0; // parent fully hidden
        t.active[slot] = 0;
        t.release(slot);
        this.stats.transitionsCompleted++;
      }
    }
  }

  _findTransitionByKey(tileKey) {
    const t = this.transitions;
    for (let slot = 0; slot < t.capacity; slot++) {
      if (t.active[slot] && t.tileKeyRef[slot] === tileKey) return slot;
    }
    return -1;
  }

  /**
   * Publishes the visible-tile SoA into the context frame’s spatial channel.
   * The render dispatch stage (stage six) reads this directly.
   */
  _publishToFrame(selectedHeaders, tick) {
    if (!this.frame?.layers.spatial) return;
    const spatial = this.frame.layers.spatial;

    // Ensure the channel arrays exist.
    if (!spatial.terrainTileKeys) {
      spatial.terrainTileKeys = [];
      spatial.terrainTileLods = [];
      spatial.terrainTileEntityIds = [];
      spatial.terrainTileBounds = [];
      spatial.terrainTileSpheres = [];
      spatial.terrainTileBlendAlphas = [];
      spatial.terrainTilePriorities = [];
      spatial.terrainTileSeamFlags = [];
      spatial.terrainTileStates = [];
      spatial.terrainTileTransitionAlpha = [];
      spatial.terrainTileTransitionActive = [];
    }

    // Clear and repopulate in place (avoid allocating a fresh array each frame).
    spatial.terrainTileKeys.length = 0;
    spatial.terrainTileLods.length = 0;
    spatial.terrainTileEntityIds.length = 0;
    spatial.terrainTileBounds.length = 0;
    spatial.terrainTileSpheres.length = 0;
    spatial.terrainTileBlendAlphas.length = 0;
    spatial.terrainTilePriorities.length = 0;
    spatial.terrainTileSeamFlags.length = 0;
    spatial.terrainTileStates.length = 0;
    spatial.terrainTileTransitionAlpha.length = 0;
    spatial.terrainTileTransitionActive.length = 0;

    const t = this.transitions;

    for (const h of selectedHeaders) {
      spatial.terrainTileKeys.push(h.tileKey);
      spatial.terrainTileLods.push(h.lod);
      spatial.terrainTileEntityIds.push(h.entityId);
      spatial.terrainTileBounds.push(
        h.minX, h.minY, h.minZ,
        h.maxX, h.maxY, h.maxZ
      );
      spatial.terrainTileSpheres.push(
        h.centerX, h.centerY, h.centerZ, h.boundingSphereRadius
      );
      spatial.terrainTileBlendAlphas.push(h.blendAlpha);
      spatial.terrainTilePriorities.push(h.priority);
      spatial.terrainTileSeamFlags.push(h.seamFlags);
      spatial.terrainTileStates.push(h.state);

      // Look up the transition for this tile (if any).
      let transAlpha = 1;
      let transActive = 0;
      const slot = this._findTransitionByKey(h.tileKey);
      if (slot >= 0) {
        transAlpha = t.alpha[slot];
        transActive = 1;
      }
      spatial.terrainTileTransitionAlpha.push(transAlpha);
      spatial.terrainTileTransitionActive.push(transActive);
    }

    this._published.count = selectedHeaders.length;
  }

  // -------------------------------------------------------------------------
  // Public queries
  // -------------------------------------------------------------------------

  /**
   * Returns the current visible-tile SoA from the frame. This is the same
   * object the render dispatch stage reads; callers should consume it
   * immediately and not hold references across frames.
   */
  getVisibleTiles() {
    return this._published;
  }

  /**
   * Returns the reconciler diagnostics snapshot.
   */
  getStats() {
    return {
      ...this.stats,
      tileset: this.tileset.getStats(),
      source: this.source ? this.source.getStats() : null,
      activeTransitions: this._countActiveTransitions()
    };
  }

  _countActiveTransitions() {
    let n = 0;
    for (let i = 0; i < this.transitions.capacity; i++) {
      if (this.transitions.active[i]) n++;
    }
    return n;
  }

  // -------------------------------------------------------------------------
  // Event emission
  // -------------------------------------------------------------------------

  _emitEvent(type, header, tick) {
    if (!this.dispatcher) return;
    try {
      const payload = header ? {
        reconcilerId: this.options.reconcilerId,
        tilesetId: this.options.tilesetId,
        tileKey: header.tileKey,
        lod: header.lod,
        x: header.tileX,
        y: header.tileY,
        z: header.tileZ,
        entityId: header.entityId,
        tick
      } : {
        reconcilerId: this.options.reconcilerId,
        tilesetId: this.options.tilesetId,
        tick
      };
      this.dispatcher.dispatch(type, payload);
    } catch (e) {
      // Dispatcher errors must never break the reconciler.
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Clears all transitions and tiles. Called when a world is torn down or
   * when the reconciler is re-targeted to a different tileset.
   */
  clear() {
    for (let i = 0; i < this.transitions.capacity; i++) {
      if (this.transitions.active[i]) {
        this.transitions.release(i);
      }
    }
    this.transitions.count = 0;
    this.tileset.clear();
    this._published.count = 0;
    this._published.keys.length = 0;
    this._published.lods.length = 0;
    this._published.entityIds.length = 0;
    this._published.bounds.length = 0;
    this._published.spheres.length = 0;
    this._published.blendAlphas.length = 0;
    this._published.priorities.length = 0;
    this._published.seamFlags.length = 0;
    this._published.state.length = 0;
    this._published.transitionAlpha.length = 0;
    this._published.transitionActive.length = 0;
  }

  /**
   * Destroys the reconciler and releases all owned resources.
   */
  dispose() {
    this.clear();
    this.tileset.dispose();
    this.tileset = null;
    if (this.source) {
      this.source.dispose();
      this.source = null;
    }
    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;
    this.transitions = null;
  }
}

// ---------------------------------------------------------------------------
// 3. FACTORY
// ---------------------------------------------------------------------------

/**
 * Creates a fully-wired TerrainTileReconciler for the seamless terrain
 * pipeline. Caller must still call .bind(contextFrame, ecsWorld, dispatcher)
 * and .setSource(terrainSource) before the first update.
 */
export function createTerrainTileReconciler(options = {}) {
  return new TerrainTileReconciler({
    reconcilerId: options.reconcilerId ?? 1,
    tilesetId: options.tilesetId ?? 1,
    sourceId: options.sourceId ?? 1,
    targetHz: options.targetHz ?? 10,
    lodTransitionMs: options.lodTransitionMs ?? 150,
    lodTransitionTicks: options.lodTransitionTicks ?? 10,
    evictionGraceTicks: options.evictionGraceTicks ?? 30,
    maxTiles: options.maxTiles ?? DEFAULT_TILESET_OPTIONS.maxActiveTiles,
    maxResidentBytes: options.maxResidentBytes ?? DEFAULT_TILESET_OPTIONS.maxResidentBytes,
    enableSeamStitching: options.enableSeamStitching ?? true,
    maxLod: options.maxLod ?? DEFAULT_TILESET_OPTIONS.maxLod,
    tileWorldSize: options.tileWorldSize ?? DEFAULT_TILESET_OPTIONS.tileWorldSize,
    screenSpaceErrorTarget: options.screenSpaceErrorTarget ?? DEFAULT_TILESET_OPTIONS.screenSpaceErrorTarget,
    minZ: options.minZ ?? -10000,
    maxZ: options.maxZ ?? 10000,
    sourceFormat: options.sourceFormat ?? TilesetSourceFormat.PROCEDURAL_2D,
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

// ---------------------------------------------------------------------------
// 4. BARREL EXPORT
// ---------------------------------------------------------------------------

export default {
  TerrainTileReconciler,
  LODTransitionArena,
  createTerrainTileReconciler
};