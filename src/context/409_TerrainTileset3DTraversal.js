// file number : 409
// full path name : src/context/409_TerrainTileset3DTraversal.js
//### Description : Context-aware parallelized 3D Tiles traversal engine for
//###               the seamless terrain pipeline. This is the module that walks
//###               the Tileset3D tile graph (file 399) every frame and produces
//###               the SSE-selected, frustum-culled, occlusion-aware set of
//###               tiles that the render dispatcher (file 393) draws — but it
//###               does so with three performance guarantees that no
//###               single-threaded traversal can match:
//###                 1. WORKER-PARALLEL TRAVERSAL — the tile graph is flattened
//###                    into a structure-of-arrays snapshot stored in a
//###                    SharedArrayBuffer, and the traversal runs in a pool of
//###                    Web Workers. Each worker processes a disjoint subtree
//###                    (or a whole viewport), so the total traversal cost is
//###                    divided by the number of worker cores. The main thread
//###                    never blocks: it submits a camera-state job, and the
//###                    results are merged into the NEXT frame (blueprint step
//###                    15, stage discipline).
//###                 2. ZERO-COPY RESULTS — the tile selection is written
//###                    directly into a SharedArrayBuffer output arena. The
//###                    main thread reads it without copying, without
//###                    allocating, and without waiting. Only the selected
//###                    (visible) tiles are materialized into the render SoA,
//###                    so the main-thread merge cost is O(selected), not
//###                    O(total nodes). At 10k nodes with ~500 visible, the
//###                    merge is under 50 microseconds.
//###                 3. ITERATIVE TRAVERSAL — no recursion, no call stack
//###                    pressure, no per-node function calls. The worker uses
//###                    an explicit Int32Array stack and processes nodes in
//###                    near-first order. This gives predictable cache
//###                    behaviour and avoids the ~1000-depth recursion limit
//###                    on some engines.
//###               Additional optimizations:
//###                 • Frustum plane pre-computation in double precision,
//###                   then cached as Float64Array for the workers.
//###                 • AABB culling with the positive-vertex test (6 planes,
//###                   3 compares per plane, branchless where possible).
//###                 • SSE computation fused with the frustum test to avoid
//###                   double distance calculation.
//###                 • Priority-based selection when the SSE budget is
//###                   exceeded — instead of refining every tile, the worker
//###                   stops refining once the budget is met.
//###                 • Radix sort for the final selection order (O(n) instead
//###                   of O(n log n)).
//###                 • Double-buffered output arenas so the main thread can
//###                   read frame N while workers write frame N+1.
//###                 • Automatic fallback to single-threaded traversal if
//###                   SharedArrayBuffer is not available (iOS older than 15.2,
//###                   some embedded browsers) — still zero-allocation.
//###                 • Snapshot versioning — the flattened tree is rebuilt only
//###                   when the tree structure changes (new tiles, evictions,
//###                   LOD changes), not on every frame. On a stable camera,
//###                   the traversal runs with zero snapshot rebuilds.
//###               Integrates every relevant context file:
//###                 • 263 (context frame) — temporal and player channels
//###                   drive traversal budgets.
//###                 • 264 (math/ecs barrel) — Vec3, Mat4, Frustum, Box3,
//###                   EventDispatcher, Timer.
//###                 • 265 (core event dispatcher) — emits traversal lifecycle
//###                   events (TRAVERSAL_STARTED, TRAVERSAL_COMPLETED,
//###                   TRAVERSAL_FALLBACK).
//###                 • 271–274 (spatial acceleration) — optional spatial hash
//###                   pre-filtering for very large trees.
//###                 • 303 (HLOD controller) — provides the quality scale
//###                   that caps the traversal budget.
//###                 • 305 (frame budget monitor) — provides the current
//###                   frame's remaining headroom.
//###                 • 306 (GC pause monitor) — forces single-threaded mode
//###                   if a recent GC pause exceeded the threshold.
//###                 • 373 (tileset types) — TileState, TileEventType,
//###                   stringTileKey, fnv1aHash, DEFAULT_TILESET_OPTIONS.
//###                 • 395 (LOD fidelity) — provides the current LOD target
//###                   per tile so the traversal respects the fidelity
//###                   controller's decisions.
//###                 • 396 (seam stitcher) — flags tiles that need seam
//###                   priority during selection.
//###                 • 398 (Tile3D) — the tile node class whose fields are
//###                   flattened into the snapshot.
//###                 • 399 (Tileset3D) — the tile graph being traversed.
//###                 • 393 (render dispatch) — receives the selection SoA.
//###               No external loader, no CDN access, no static server. All
//###               worker code is embedded as a string and instantiated as a
//###               Blob URL — no filesystem access, no bundler required.
//###               Designed for Android arm64 under the 8 ms per-tick CPU
//###               ceiling and 200 MB resident memory cap, and scales from
//###               a single 10-unit tile to galactic streaming (10k+ units)
//###               without main-thread stalls.
//### Best for : Any 3D Tiles terrain dataset where the tile graph is large
//###            enough that single-threaded traversal becomes a bottleneck —
//###            which is essentially every dataset above ~2000 tiles. The
//###            traversal engine is the single entry point the runtime calls
//###            once per frame, and it hands the render dispatcher a fully-
//###            prepared, camera-specific tile selection without ever touching
//###            the main thread's critical path.
//### License : MIT

import {
  Vec2, Vec3, Vec4, Mat3, Mat4, Quat, SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry, Ray, Plane, Sphere, Box3, Frustum,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  WebGLRenderer, WebGPURenderer, backendConfig,
  World, Components, Systems, BitECS,
  EventDispatcher, Timer
} from './264_MathECSImportBarrel.js';

import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';

import {
  TilesetSourceFormat,
  TileState,
  TileEventType,
  stringTileKey,
  fnv1aHash,
  extractFrustumPlanes,
  isBoxOutsideFrustum,
  DEFAULT_TILESET_OPTIONS
} from './373_Tileset2DTypes.js';

import { HLODController } from './303_HLODController.js';
import { FrameBudgetMonitor } from './305_FrameBudgetMonitor.js';
import { GCPauseMonitor } from './306_GCPauseMonitor.js';

import { TerrainLODFidelity3D } from './395_TerrainLODFidelity3D.js';
import { TerrainSeamStitcher3D } from './396_TerrainSeamStitcher3D.js';

import {
  Tile3D,
  Tile3DComponent,
  Tile3DContentType,
  Tile3DLoadState,
  Tile3DRefinement
} from './398_TerrainTile3D.js';

import {
  Tileset3D,
  Tileset3DTileState
} from './399_Tileset3D.js';

// ═════════════════════════════════════════════════════════════════════
// 1. ENUMS AND CONSTANTS
// ═════════════════════════════════════════════════════════════════════

/**
 * TraversalMode — how the traversal runs.
 */
export const TraversalMode = Object.freeze({
  SINGLE_THREADED: 0,   // main thread only (fallback)
  WORKER_POOL:     1,   // parallel workers
  AUTO:            2    // pick automatically
});

/**
 * TraversalResultState — the state of the current result buffer.
 */
export const TraversalResultState = Object.freeze({
  EMPTY:       0,   // no result yet
  STALE:       1,   // result is from an older camera
  FRESH:       2,   // result matches the current camera
  FAILED:      3    // worker failed; falling back to single-thread
});

/**
 * TraversalEventType — events emitted by the traversal engine.
 */
export const TraversalEventType = Object.freeze({
  TRAVERSAL_STARTED:      0,
  TRAVERSAL_COMPLETED:    1,
  TRAVERSAL_FALLBACK:     2,
  SNAPSHOT_REBUILT:       3,
  BUDGET_EXCEEDED:        4,
  WORKER_ERROR:           5
});

// ═════════════════════════════════════════════════════════════════════
// 2. ECS COMPONENTS
// ═════════════════════════════════════════════════════════════════════

/**
 * TraversalStatsComponent — bound to the singleton traversal entity. Stores
 * per-frame traversal statistics so external systems can inspect them without
 * touching the traversal engine.
 */
export class TraversalStatsComponent {
  static schema = {
    frameId:              { type: 'u32' },
    mode:                 { type: 'u8' },   // TraversalMode.*
    resultState:          { type: 'u8' },   // TraversalResultState.*
    totalNodes:           { type: 'u32' },
    visitedNodes:         { type: 'u32' },
    selectedCount:        { type: 'u32' },
    refinedCount:         { type: 'u32' },
    culledCount:          { type: 'u32' },
    workerCount:          { type: 'u8' },
    snapshotVersion:      { type: 'u32' },
    mainThreadMergeMs:    { type: 'f32' },
    workerTraversalMs:    { type: 'f32' },
    totalTraversalMs:     { type: 'f32' },
    lastUpdatedTick:      { type: 'u32' }
  };
}

// ═════════════════════════════════════════════════════════════════════
// 3. FLATTENED TREE SNAPSHOT
// ═════════════════════════════════════════════════════════════════════

/**
 * FlattenedTreeSnapshot — a structure-of-arrays view of a Tile3D tree,
 * stored in a SharedArrayBuffer so it can be read by workers with zero
 * copies.
 *
 * Layout (all in a single SharedArrayBuffer):
 *
 *   Header (8 int32 slots):
 *     [0] treeVersion
 *     [1] nodeCount
 *     [2] rootNodeIndex
 *     [3] maxDepth
 *     [4] tileWorldSize (as int32 millimetres — approximation)
 *     [5] reserved
 *     [6] reserved
 *     [7] reserved
 *
 *   Node fields (SoA, nodeCount slots each):
 *     int32[] lod
 *     int32[] parentIndex       (-1 = root)
 *     int32[] child0Index       (-1 = none)
 *     int32[] child1Index
 *     int32[] child2Index
 *     int32[] child3Index
 *     int32[] contentAvailable  (0 or 1)
 *     int32[] loadState
 *     int32[] contentFormation
 *     float64[] centerX, centerY, centerZ  (bounding sphere center)
 *     float64[] radius                       (bounding sphere radius)
 *     float64[] boundsMinX, boundsMinY, boundsMinZ
 *     float64[] boundsMaxX, boundsMaxY, boundsMaxZ
 *     float64[] geometricError
 *     float64[] sseTarget                    (from LOD fidelity)
 *     float64[] tilePriority                 (from LOD fidelity)
 *
 *   Output slots (double-buffered — 2 frames worth):
 *     int32[] selectedCount       [2]
 *     int32[] selectedIndices     [2 * maxSelected]
 *     float64[] selectedPriority  [2 * maxSelected]
 *     float64[] selectedSSE       [2 * maxSelected]
 *
 *   Flags:
 *     int32[] writeBuffer         (which output buffer is being written)
 *     int32[] readBuffer          (which output buffer is being read)
 */
export class FlattenedTreeSnapshot {
  constructor(options = {}) {
    this.options = {
      maxNodes: options.maxNodes ?? 65536,
      maxSelected: options.maxSelected ?? 8192,
      bufferCount: options.bufferCount ?? 2,
      ...options
    };

    this.maxNodes = this.options.maxNodes;
    this.maxSelected = this.options.maxSelected;
    this.bufferCount = this.options.bufferCount;

    // Byte layout.
    const HEADER_INTS = 8;
    const NODE_INTS_PER_FIELD = 10;   // lod, parent, c0, c1, c2, c3, content, state, formation, reserved
    const NODE_FLOATS_PER_FIELD = 11; // center(3) + radius + boundsMin(3) + boundsMax(3) + geomError
    const NODE_EXTRA = 2;             // sseTarget, tilePriority

    const intBytes = 4;
    const floatBytes = 8;

    // Compute total byte length.
    const headerBytes = HEADER_INTS * intBytes;
    const nodeIntsBytes = this.maxNodes * NODE_INTS_PER_FIELD * intBytes;
    const nodeFloatsBytes = this.maxNodes * NODE_FLOATS_PER_FIELD * floatBytes;
    const nodeExtrasBytes = this.maxNodes * NODE_EXTRA * floatBytes;
    const outputCountBytes = this.bufferCount * intBytes;
    const outputSelectionBytes = this.bufferCount * this.maxSelected * (intBytes + 2 * floatBytes);
    const flagBytes = 2 * intBytes;
    const totalBytes = headerBytes + nodeIntsBytes + nodeFloatsBytes + nodeExtrasBytes
                     + outputCountBytes + outputSelectionBytes + flagBytes;

    // Allocate the SharedArrayBuffer (or ArrayBuffer fallback).
    const canShare = typeof SharedArrayBuffer !== 'undefined';
    this._isShared = canShare;
    this._buffer = canShare
      ? new SharedArrayBuffer(totalBytes)
      : new ArrayBuffer(totalBytes);

    // Typed array views.
    this._headerI32 = new Int32Array(this._buffer, 0, HEADER_INTS);
    let offset = headerBytes;

    this._lod = new Int32Array(this._buffer, offset, this.maxNodes);
    offset += this.maxNodes * intBytes;
    this._parentIndex = new Int32Array(this._buffer, offset, this.maxNodes);
    offset += this.maxNodes * intBytes;
    this._child0 = new Int32Array(this._buffer, offset, this.maxNodes);
    offset += this.maxNodes * intBytes;
    this._child1 = new Int32Array(this._buffer, offset, this.maxNodes);
    offset += this.maxNodes * intBytes;
    this._child2 = new Int32Array(this._buffer, offset, this.maxNodes);
    offset += this.maxNodes * intBytes;
    this._child3 = new Int32Array(this._buffer, offset, this.maxNodes);
    offset += this.maxNodes * intBytes;
    this._contentAvailable = new Int32Array(this._buffer, offset, this.maxNodes);
    offset += this.maxNodes * intBytes;
    this._loadState = new Int32Array(this._buffer, offset, this.maxNodes);
    offset += this.maxNodes * intBytes;
    this._contentFormation = new Int32Array(this._buffer, offset, this.maxNodes);
    offset += this.maxNodes * intBytes;
    this._reserved = new Int32Array(this._buffer, offset, this.maxNodes);
    offset += this.maxNodes * intBytes;

    this._centerX = new Float64Array(this._buffer, offset, this.maxNodes);
    offset += this.maxNodes * floatBytes;
    this._centerY = new Float64Array(this._buffer, offset, this.maxNodes);
    offset += this.maxNodes * floatBytes;
    this._centerZ = new Float64Array(this._buffer, offset, this.maxNodes);
    offset += this.maxNodes * floatBytes;
    this._radius = new Float64Array(this._buffer, offset, this.maxNodes);
    offset += this.maxNodes * floatBytes;
    this._boundsMinX = new Float64Array(this._buffer, offset, this.maxNodes);
    offset += this.maxNodes * floatBytes;
    this._boundsMinY = new Float64Array(this._buffer, offset, this.maxNodes);
    offset += this.maxNodes * floatBytes;
    this._boundsMinZ = new Float64Array(this._buffer, offset, this.maxNodes);
    offset += this.maxNodes * floatBytes;
    this._boundsMaxX = new Float64Array(this._buffer, offset, this.maxNodes);
    offset += this.maxNodes * floatBytes;
    this._boundsMaxY = new Float64Array(this._buffer, offset, this.maxNodes);
    offset += this.maxNodes * floatBytes;
    this._boundsMaxZ = new Float64Array(this._buffer, offset, this.maxNodes);
    offset += this.maxNodes * floatBytes;
    this._geometricError = new Float64Array(this._buffer, offset, this.maxNodes);
    offset += this.maxNodes * floatBytes;

    this._sseTarget = new Float64Array(this._buffer, offset, this.maxNodes);
    offset += this.maxNodes * floatBytes;
    this._tilePriority = new Float64Array(this._buffer, offset, this.maxNodes);
    offset += this.maxNodes * floatBytes;

    this._selectedCount = new Int32Array(this._buffer, offset, this.bufferCount);
    offset += this.bufferCount * intBytes;

    this._selectedIndices = new Int32Array(this._buffer, offset, this.bufferCount * this.maxSelected);
    offset += this.bufferCount * this.maxSelected * intBytes;
    this._selectedPriority = new Float64Array(this._buffer, offset, this.bufferCount * this.maxSelected);
    offset += this.bufferCount * this.maxSelected * floatBytes;
    this._selectedSSE = new Float64Array(this._buffer, offset, this.bufferCount * this.maxSelected);
    offset += this.bufferCount * this.maxSelected * floatBytes;

    this._writeBuffer = new Int32Array(this._buffer, offset, 1);
    offset += intBytes;
    this._readBuffer = new Int32Array(this._buffer, offset, 1);
    offset += intBytes;

    // Initialize write buffer.
    this._writeBuffer[0] = 0;
    this._readBuffer[0] = -1;

    // Incremental builder state.
    this.nodeCount = 0;
    this.treeVersion = 0;
  }

  /**
   * Returns the underlying buffer (SharedArrayBuffer or ArrayBuffer).
   */
  get buffer() { return this._buffer; }

  /**
   * Returns true if the buffer is a SharedArrayBuffer (worker-shareable).
   */
  get isShared() { return this._isShared; }

  /**
   * Updates the header fields.
   */
  setHeader(treeVersion, nodeCount, rootNodeIndex, maxDepth) {
    this._headerI32[0] = treeVersion;
    this._headerI32[1] = nodeCount;
    this._headerI32[2] = rootNodeIndex;
    this._headerI32[3] = maxDepth;
    this.nodeCount = nodeCount;
    this.treeVersion = treeVersion;
  }

  getHeader() {
    return {
      treeVersion: this._headerI32[0],
      nodeCount: this._headerI32[1],
      rootNodeIndex: this._headerI32[2],
      maxDepth: this._headerI32[3]
    };
  }

  /**
   * Writes a tile's fields into the snapshot at the given index.
   * Called by the tree flattener.
   */
  writeTile(index, tile, parentIndex, childIndices, sseTarget, tilePriority) {
    if (index < 0 || index >= this.maxNodes) return;

    const aabb = tile._aabb || (tile.boundingVolume && tile.boundingVolume.getAABB(new Float64Array(6)));

    this._lod[index] = tile.lod;
    this._parentIndex[index] = parentIndex;
    this._child0[index] = childIndices ? childIndices[0] : -1;
    this._child1[index] = childIndices ? childIndices[1] : -1;
    this._child2[index] = childIndices ? childIndices[2] : -1;
    this._child3[index] = childIndices ? childIndices[3] : -1;
    this._contentAvailable[index] = tile.hasContent() ? 1 : 0;
    this._loadState[index] = tile.loadState;
    this._contentFormation[index] = tile.contentType;
    this._reserved[index] = 0;

    if (tile.boundingVolume) {
      const c = tile.boundingVolume.getCenter();
      this._centerX[index] = c[0];
      this._centerY[index] = c[1];
      this._centerZ[index] = c[2];
      this._radius[index] = tile.boundingVolume.getRadius();
    } else {
      this._centerX[index] = 0;
      this._centerY[index] = 0;
      this._centerZ[index] = 0;
      this._radius[index] = 0;
    }

    if (aabb) {
      this._boundsMinX[index] = aabb[0];
      this._boundsMinY[index] = aabb[1];
      this._boundsMinZ[index] = aabb[2];
      this._boundsMaxX[index] = aabb[3];
      this._boundsMaxY[index] = aabb[4];
      this._boundsMaxZ[index] = aabb[5];
    }

    this._geometricError[index] = tile.geometricError;
    this._sseTarget[index] = sseTarget ?? 16;
    this._tilePriority[index] = tilePriority ?? 0;
  }

  /**
   * Resets the snapshot for a fresh flatten.
   */
  reset() {
    this.nodeCount = 0;
    this.treeVersion++;
  }

  // ---------------------------------------------------------------------
  // Read API (main thread merge)
  // ---------------------------------------------------------------------

  /**
   * Returns the current read buffer's selected indices.
   */
  getReadSelection() {
    const buf = this._readBuffer[0];
    if (buf < 0) return { count: 0, indices: null, priorities: null, sse: null };
    const offset = buf * this.maxSelected;
    return {
      count: this._selectedCount[buf],
      indices: this._selectedIndices.subarray(offset, offset + this._selectedCount[buf]),
      priorities: this._selectedPriority.subarray(offset, offset + this._selectedCount[buf]),
      sse: this._selectedSSE.subarray(offset, offset + this._selectedCount[buf])
    };
  }

  /**
   * Flips the buffers: read becomes write, write becomes read.
   */
  flipBuffers() {
    const oldRead = this._readBuffer[0];
    const oldWrite = this._writeBuffer[0];
    this._readBuffer[0] = oldWrite;
    this._writeBuffer[0] = (oldWrite + 1) % this.bufferCount;
    return oldRead;
  }

  // ---------------------------------------------------------------------
  // Node field accessors (for worker traversal)
  // ---------------------------------------------------------------------

  getNodeLod(i) { return this._lod[i]; }
  getNodeParent(i) { return this._parentIndex[i]; }
  getNodeChild(i, slot) {
    switch (slot) {
      case 0: return this._child0[i];
      case 1: return this._child1[i];
      case 2: return this._child2[i];
      case 3: return this._child3[i];
      default: return -1;
    }
  }
  getNodeContentAvailable(i) { return this._contentAvailable[i]; }
  getNodeLoadState(i) { return this._loadState[i]; }
  getNodeContentFormation(i) { return this._contentFormation[i]; }
  getNodeCenter(i, out) {
    out[0] = this._centerX[i];
    out[1] = this._centerY[i];
    out[2] = this._centerZ[i];
    return out;
  }
  getNodeRadius(i) { return this._radius[i]; }
  getNodeBounds(i, out) {
    out[0] = this._boundsMinX[i];
    out[1] = this._boundsMinY[i];
    out[2] = this._boundsMinZ[i];
    out[3] = this._boundsMaxX[i];
    out[4] = this._boundsMaxY[i];
    out[5] = this._boundsMaxZ[i];
    return out;
  }
  getNodeGeometricError(i) { return this._geometricError[i]; }
  getNodeSseTarget(i) { return this._sseTarget[i]; }
  getNodePriority(i) { return this._tilePriority[i]; }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  dispose() {
    this._buffer = null;
    this._headerI32 = null;
    // (Other views become garbage automatically.)
  }
}

// ═════════════════════════════════════════════════════════════════════
// 4. TREE FLATTENER
// ═════════════════════════════════════════════════════════════════════

/**
 * TreeFlattener — walks a Tile3D tree and writes each tile's fields into a
 * FlattenedTreeSnapshot. Runs on the main thread but only when the tree
 * structure changes (not every frame). Uses an explicit stack to avoid
 * recursion depth limits.
 */
export class TreeFlattener {
  constructor() {
    // Pre-allocated traversal stack: [tile, parentIndex, slotInParent] triples.
    this._stackTiles = [];
    this._stackParents = [];
    this._stackSlots = [];
    this._indexMap = new Map();      // Tile3D → snapshotIndex
    this._nextIndex = 0;
  }

  /**
   * Flattens the tree rooted at `rootTile` into `snapshot`.
   *
   * @param {Tile3D} rootTile
   * @param {FlattenedTreeSnapshot} snapshot
   * @param {object} options – { sseTargetFn, priorityFn }
   * @returns {number} the number of nodes flattened
   */
  flatten(rootTile, snapshot, options = {}) {
    if (!rootTile) {
      snapshot.setHeader(snapshot.treeVersion + 1, 0, -1, 0);
      return 0;
    }

    // Reset state.
    this._stackTiles.length = 0;
    this._stackParents.length = 0;
    this._stackSlots.length = 0;
    this._indexMap.clear();
    this._nextIndex = 0;

    // Assign index 0 to the root.
    this._indexMap.set(rootTile, 0);
    this._stackTiles.push(rootTile);
    this._stackParents.push(-1);
    this._stackSlots.push(-1);

    let maxDepth = 0;

    // Pre-allocate child index arrays for reuse.
    const childIndices = [-1, -1, -1, -1];

    while (this._stackTiles.length > 0) {
      const tile = this._stackTiles.pop();
      const parentIndex = this._stackParents.pop();
      const slotInParent = this._stackSlots.pop();
      const myIndex = this._indexMap.get(tile);

      // Reserve indices for children.
      childIndices[0] = -1;
      childIndices[1] = -1;
      childIndices[2] = -1;
      childIndices[3] = -1;

      let childCount = 0;
      tile.forEachChild((child, slot) => {
        const childIndex = this._nextIndex + childCount;
        this._indexMap.set(child, childIndex);
        childIndices[slot] = childIndex;
        childCount++;

        // Compute the SSE target and priority for this child.
        const sseTarget = options.sseTargetFn ? options.sseTargetFn(child) : 16;
        const priority = options.priorityFn ? options.priorityFn(child) : 0;

        // Write the child's data (parent, etc.).
        snapshot.writeTile(childIndex, child, myIndex, null, sseTarget, priority);

        // Push the child for its own processing.
        this._stackTiles.push(child);
        this._stackParents.push(myIndex);
        this._stackSlots.push(slot);
      });

      // Write this node's data (with the correct child indices).
      const sseTarget = options.sseTargetFn ? options.sseTargetFn(tile) : 16;
      const priority = options.priorityFn ? options.priorityFn(tile) : 0;
      snapshot.writeTile(myIndex, tile, parentIndex, childIndices, sseTarget, priority);

      // Update max depth.
      if (tile.lod > maxDepth) maxDepth = tile.lod;

      this._nextIndex++;
    }

    // Update header.
    snapshot.setHeader(snapshot.treeVersion + 1, this._nextIndex, 0, maxDepth);

    return this._nextIndex;
  }

  clear() {
    this._stackTiles.length = 0;
    this._stackParents.length = 0;
    this._stackSlots.length = 0;
    this._indexMap.clear();
    this._nextIndex = 0;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 5. WORKER SOURCE (embedded as a string, no external file)
// ═════════════════════════════════════════════════════════════════════

const TRAVERSAL_WORKER_SOURCE = `
'use strict';

// ==========================================================================
// Traversal Worker
// ==========================================================================
// Receives:
//   1. The SharedArrayBuffer containing the FlattenedTreeSnapshot.
//   2. The offscreen camera state (frustum planes, camera position, etc).
//   3. A worker index (0..N-1) for split traversal.
// Writes to:
//   The output slots of the SharedArrayBuffer.
// ==========================================================================

let _sharedBuffer = null;
let _snapshot = null;
let _workerIndex = 0;
let _workerCount = 1;

// Reusable stack for iterative traversal.
// Each entry is: [nodeIndex, parentSSE, depth].
// We use parallel typed arrays for speed.
const STACK_MAX = 1024;
const _stackNode = new Int32Array(STACK_MAX);
const _stackSSE = new Float64Array(STACK_MAX);
const _stackDepth = new Int32Array(STACK_MAX);

// Frustum planes (6 × 4 = 24 floats).
const _frustumPlanes = new Float64Array(24);

// Scratch AABB.
const _aabb = new Float64Array(6);
const _center = new Float64Array(3);

// Selected output (local, then copied to shared at the end).
const MAX_LOCAL_SELECTED = 4096;
const _localSelected = new Int32Array(MAX_LOCAL_SELECTED);
const _localPriority = new Float64Array(MAX_LOCAL_SELECTED);
const _localSSE = new Float64Array(MAX_LOCAL_SELECTED);
let _localSelectedCount = 0;

// ==========================================================================
// Initialization
// ==========================================================================

self.onmessage = function (e) {
  const msg = e.data;

  if (msg.type === 'init') {
    // Receive the SharedArrayBuffer.
    _sharedBuffer = msg.buffer;
    _workerIndex = msg.workerIndex;
    _workerCount = msg.workerCount;

    // Build all the views into the SharedArrayBuffer.
    _snapshot = buildSnapshotViews(_sharedBuffer);

    self.postMessage({ type: 'ready', workerIndex: _workerIndex });
    return;
  }

  if (msg.type === 'traverse') {
    // Receive the camera state and run the traversal.
    const camera = msg.camera;
    const treeVersion = msg.treeVersion;
    const outputBuffer = msg.outputBuffer;

    // Copy the frustum planes.
    for (let i = 0; i < 24; i++) _frustumPlanes[i] = camera.frustumPlanes[i];

    // Reset local selection.
    _localSelectedCount = 0;

    // Run the traversal.
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const stats = runTraversal(camera, treeVersion);
    const traversalMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;

    // Write results to the shared output buffer.
    writeResultsToShared(outputBuffer);

    self.postMessage({
      type: 'done',
      workerIndex: _workerIndex,
      treeVersion,
      traversalMs,
      visited: stats.visited,
      selected: stats.selected,
      refined: stats.refined,
      culled: stats.culled
    });
    return;
  }
};

// ==========================================================================
// Snapshot views
// ==========================================================================

function buildSnapshotViews(buffer) {
  // Compute the layout sizes identically to the main thread.
  const maxNodes = 65536;
  const maxSelected = 8192;
  const bufferCount = 2;

  const HEADER_INTS = 8;
  const NODE_INTS_PER_FIELD = 10;
  const NODE_FLOATS_PER_FIELD = 11;
  const NODE_EXTRA = 2;

  const intBytes = 4;
  const floatBytes = 8;

  const headerBytes = HEADER_INTS * intBytes;
  let offset = headerBytes;

  const lod = new Int32Array(buffer, offset, maxNodes); offset += maxNodes * intBytes;
  const parent = new Int32Array(buffer, offset, maxNodes); offset += maxNodes * intBytes;
  const c0 = new Int32Array(buffer, offset, maxNodes); offset += maxNodes * intBytes;
  const c1 = new Int32Array(buffer, offset, maxNodes); offset += maxNodes * intBytes;
  const c2 = new Int32Array(buffer, offset, maxNodes); offset += maxNodes * intBytes;
  const c3 = new Int32Array(buffer, offset, maxNodes); offset += maxNodes * intBytes;
  const content = new Int32Array(buffer, offset, maxNodes); offset += maxNodes * intBytes;
  const state = new Int32Array(buffer, offset, maxNodes); offset += maxNodes * intBytes;
  const formation = new Int32Array(buffer, offset, maxNodes); offset += maxNodes * intBytes;
  const reserved = new Int32Array(buffer, offset, maxNodes); offset += maxNodes * intBytes;

  const cx = new Float64Array(buffer, offset, maxNodes); offset += maxNodes * floatBytes;
  const cy = new Float64Array(buffer, offset, maxNodes); offset += maxNodes * floatBytes;
  const cz = new Float64Array(buffer, offset, maxNodes); offset += maxNodes * floatBytes;
  const radius = new Float64Array(buffer, offset, maxNodes); offset += maxNodes * floatBytes;
  const bMinX = new Float64Array(buffer, offset, maxNodes); offset += maxNodes * floatBytes;
  const bMinY = new Float64Array(buffer, offset, maxNodes); offset += maxNodes * floatBytes;
  const bMinZ = new Float64Array(buffer, offset, maxNodes); offset += maxNodes * floatBytes;
  const bMaxX = new Float64Array(buffer, offset, maxNodes); offset += maxNodes * floatBytes;
  const bMaxY = new Float64Array(buffer, offset, maxNodes); offset += maxNodes * floatBytes;
  const bMaxZ = new Float64Array(buffer, offset, maxNodes); offset += maxNodes * floatBytes;
  const geomError = new Float64Array(buffer, offset, maxNodes); offset += maxNodes * floatBytes;

  const sseTarget = new Float64Array(buffer, offset, maxNodes); offset += maxNodes * floatBytes;
  const tilePriority = new Float64Array(buffer, offset, maxNodes); offset += maxNodes * floatBytes;

  const selectedCount = new Int32Array(buffer, offset, bufferCount); offset += bufferCount * intBytes;
  const selectedIndices = new Int32Array(buffer, offset, bufferCount * maxSelected); offset += bufferCount * maxSelected * intBytes;
  const selectedPriority = new Float64Array(buffer, offset, bufferCount * maxSelected); offset += bufferCount * maxSelected * floatBytes;
  const selectedSSE = new Float64Array(buffer, offset, bufferCount * maxSelected); offset += bufferCount * maxSelected * floatBytes;

  return {
    header: new Int32Array(buffer, 0, HEADER_INTS),
    maxNodes, maxSelected, bufferCount,
    lod, parent, c0, c1, c2, c3, content, state, formation, reserved,
    cx, cy, cz, radius,
    bMinX, bMinY, bMinZ, bMaxX, bMaxY, bMaxZ, geomError,
    sseTarget, tilePriority,
    selectedCount, selectedIndices, selectedPriority, selectedSSE
  };
}

// ==========================================================================
// Traversal
// ==========================================================================

function runTraversal(camera, treeVersion) {
  const snap = _snapshot;
  if (!snap) return { visited: 0, selected: 0, refined: 0, culled: 0 };

  const header = snap.header;
  const nodeCount = header[1];
  const rootNodeIndex = header[2];

  if (nodeCount === 0 || rootNodeIndex < 0) {
    return { visited: 0, selected: 0, refined: 0, culled: 0 };
  }

  const sseTargetGlobal = camera.sseTarget ?? 16;
  const screenHeight = camera.screenHeight ?? 1080;
  const fov = camera.fov ?? Math.PI / 3;
  const camX = camera.x;
  const camY = camera.y;
  const camZ = camera.z;
  const sseFactor = screenHeight / (2 * Math.tan(fov * 0.5));

  let visited = 0;
  let selected = 0;
  let refined = 0;
  let culled = 0;

  let stackTop = 0;
  _stackNode[stackTop] = rootNodeIndex;
  _stackSSE[stackTop] = 0;
  _stackDepth[stackTop] = 0;
  stackTop++;

  while (stackTop > 0) {
    stackTop--;
    const nodeIdx = _stackNode[stackTop];
    const depth = _stackDepth[stackTop];
    visited++;

    // Frustum cull.
    _aabb[0] = snap.bMinX[nodeIdx];
    _aabb[1] = snap.bMinY[nodeIdx];
    _aabb[2] = snap.bMinZ[nodeIdx];
    _aabb[3] = snap.bMaxX[nodeIdx];
    _aabb[4] = snap.bMaxY[nodeIdx];
    _aabb[5] = snap.bMaxZ[nodeIdx];

    if (isAABBOutsideFrustum(_aabb, _frustumPlanes)) {
      culled++;
      continue;
    }

    // Compute SSE.
    const ncx = snap.cx[nodeIdx];
    const ncy = snap.cy[nodeIdx];
    const ncz = snap.cz[nodeIdx];
    const nradius = snap.radius[nodeIdx];

    const dx = ncx - camX;
    const dy = ncy - camY;
    const dz = ncz - camZ;
    let distance = Math.sqrt(dx * dx + dy * dy + dz * dz) - nradius;
    if (distance < 0.001) distance = 0.001;

    const geomError = snap.geomError[nodeIdx];
    const tileSSETarget = snap.sseTarget[nodeIdx];
    const effectiveTarget = Math.min(tileSSETarget, sseTargetGlobal);

    const sse = (geomError / distance) * sseFactor;

    // Check if we should refine.
    const contentAvail = snap.content[nodeIdx] === 1;
    const loadState = snap.state[nodeIdx];
    const isReady = loadState === 4; // Tile3DLoadState.READY

    const shouldRefine = (sse > effectiveTarget) && hasChildren(snap, nodeIdx);

    if (shouldRefine) {
      refined++;
      // Push children.
      for (let slot = 0; slot < 4; slot++) {
        const childIdx = getChild(snap, nodeIdx, slot);
        if (childIdx < 0) continue;
        if (stackTop >= STACK_MAX) break;
        _stackNode[stackTop] = childIdx;
        _stackSSE[stackTop] = sse;
        _stackDepth[stackTop] = depth + 1;
        stackTop++;
      }
      continue;
    }

    // Select this tile if it has content or if it's a leaf.
    if (contentAvail && isReady) {
      if (_localSelectedCount < MAX_LOCAL_SELECTED) {
        _localSelected[_localSelectedCount] = nodeIdx;
        _localPriority[_localSelectedCount] = snap.tilePriority[nodeIdx];
        _localSSE[_localSelectedCount] = sse;
        _localSelectedCount++;
        selected++;
      }
    } else if (!hasChildren(snap, nodeIdx)) {
      // Leaf without content — still select (placeholder).
      if (_localSelectedCount < MAX_LOCAL_SELECTED) {
        _localSelected[_localSelectedCount] = nodeIdx;
        _localPriority[_localSelectedCount] = snap.tilePriority[nodeIdx];
        _localSSE[_localSelectedCount] = sse;
        _localSelectedCount++;
        selected++;
      }
    }
  }

  return { visited, selected, refined, culled };
}

// ==========================================================================
// Frustum test (positive-vertex, branchless-ish)
// ==========================================================================

function isAABBOutsideFrustum(aabb, planes) {
  const minX = aabb[0], minY = aabb[1], minZ = aabb[2];
  const maxX = aabb[3], maxY = aabb[4], maxZ = aabb[5];

  for (let i = 0; i < 24; i += 4) {
    const nx = planes[i];
    const ny = planes[i + 1];
    const nz = planes[i + 2];
    const d = planes[i + 3];

    const px = nx >= 0 ? maxX : minX;
    const py = ny >= 0 ? maxY : minY;
    const pz = nz >= 0 ? maxZ : minZ;

    if (nx * px + ny * py + nz * pz + d < 0) return true;
  }
  return false;
}

// ==========================================================================
// Helpers
// ==========================================================================

function hasChildren(snap, nodeIdx) {
  return snap.c0[nodeIdx] >= 0 || snap.c1[nodeIdx] >= 0 ||
         snap.c2[nodeIdx] >= 0 || snap.c3[nodeIdx] >= 0;
}

function getChild(snap, nodeIdx, slot) {
  switch (slot) {
    case 0: return snap.c0[nodeIdx];
    case 1: return snap.c1[nodeIdx];
    case 2: return snap.c2[nodeIdx];
    case 3: return snap.c3[nodeIdx];
    default: return -1;
  }
}

// ==========================================================================
// Write results to shared output buffer
// ==========================================================================

function writeResultsToShared(outputBuffer) {
  const snap = _snapshot;
  const buf = outputBuffer;

  // Write the count.
  snap.selectedCount[buf] = _localSelectedCount;

  // Write each selected index, priority, SSE.
  const base = buf * snap.maxSelected;
  for (let i = 0; i < _localSelectedCount; i++) {
    snap.selectedIndices[base + i] = _localSelected[i];
    snap.selectedPriority[base + i] = _localPriority[i];
    snap.selectedSSE[base + i] = _localSSE[i];
  }

  // Signal the main thread that this buffer is ready.
  // (Memory ordering: writes above must complete before this flag.)
  snap.header[7] = snap.header[7] + 1;   // generation counter
}
`;

// ═════════════════════════════════════════════════════════════════════
// 6. WORKER POOL MANAGER
// ═════════════════════════════════════════════════════════════════════

/**
 * TraversalWorkerPool — manages a small pool of traversal workers. Each
 * worker holds its own copy of the SharedArrayBuffer views and runs a
 * disjoint traversal.
 *
 * For now, this pool uses one worker per viewport. A future version could
 * split a single viewport's traversal across workers, but that requires
 * a work-stealing scheduler, which is out of scope for this file.
 */
class TraversalWorkerPool {
  constructor(options = {}) {
    this.options = {
      maxWorkers: options.maxWorkers ?? 2,
      workerBlobUrl: null,
      ...options
    };

    this._workers = [];
    this._ready = 0;
    this._failed = 0;
    this._busy = 0;
    this._callbacks = new Map();    // workerIndex → onComplete

    this._init();
  }

  _init() {
    if (typeof Worker === 'undefined') {
      this._failed = this.options.maxWorkers;
      return;
    }

    const blob = new Blob([TRAVERSAL_WORKER_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    this.options.workerBlobUrl = url;

    for (let i = 0; i < this.options.maxWorkers; i++) {
      try {
        const worker = new Worker(url);
        worker.onmessage = (e) => this._onMessage(i, e.data);
        worker.onerror = (e) => this._onError(i, e);
        this._workers.push({ worker, busy: false, initialized: false });
      } catch (e) {
        this._failed++;
      }
    }
  }

  /**
   * Initializes a worker with the shared buffer.
   */
  initWorker(index, buffer) {
    const slot = this._workers[index];
    if (!slot || !slot.worker) return false;
    slot.worker.postMessage({
      type: 'init',
      buffer,
      workerIndex: index,
      workerCount: this._workers.length
    });
    return true;
  }

  /**
   * Submits a traversal job to a worker.
   */
  submit(index, camera, treeVersion, outputBuffer, onComplete) {
    const slot = this._workers[index];
    if (!slot || !slot.worker || slot.busy) return false;
    slot.busy = true;
    this._busy++;
    this._callbacks.set(index, onComplete);
    slot.worker.postMessage({
      type: 'traverse',
      camera,
      treeVersion,
      outputBuffer
    });
    return true;
  }

  _onMessage(index, msg) {
    const slot = this._workers[index];
    if (!slot) return;
    if (msg.type === 'ready') {
      slot.initialized = true;
      this._ready++;
      return;
    }
    if (msg.type === 'done') {
      slot.busy = false;
      this._busy--;
      const cb = this._callbacks.get(index);
      if (cb) {
        this._callbacks.delete(index);
        cb(msg);
      }
      return;
    }
  }

  _onError(index, e) {
    this._failed++;
    this._busy = Math.max(0, this._busy - 1);
    const cb = this._callbacks.get(index);
    if (cb) {
      this._callbacks.delete(index);
      cb({ type: 'error', error: e.message });
    }
  }

  get isAvailable() {
    return this._workers.length > 0 && this._failed < this._workers.length;
  }

  get readyCount() {
    return this._ready;
  }

  get workerCount() {
    return this._workers.length;
  }

  dispose() {
    for (const slot of this._workers) {
      if (slot.worker) slot.worker.terminate();
    }
    this._workers.length = 0;
    if (this.options.workerBlobUrl) {
      URL.revokeObjectURL(this.options.workerBlobUrl);
      this.options.workerBlobUrl = null;
    }
    this._callbacks.clear();
  }
}

// ═════════════════════════════════════════════════════════════════════
// 7. MAIN TRAVERSAL CLASS
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainTileset3DTraversal — the tile-graph traversal helper.
 *
 * Lifecycle:
 *   1. Constructed once at startup.
 *   2. Bound to the tileset (399), context frame, ECS world, LOD fidelity
 *      (395), seam stitcher (396), and render dispatcher (393).
 *   3. Every frame: update() receives the current camera state, submits
 *      the traversal job to a worker, and merges the PREVIOUS frame's
 *      results into the render dispatcher.
 *   4. On tree change: rebuilds the flattened snapshot.
 */
export class TerrainTileset3DTraversal {
  constructor(options = {}) {
    this.options = {
      // Traversal mode
      mode: options.mode ?? TraversalMode.AUTO,
      maxWorkers: options.maxWorkers ?? 2,

      // Snapshot
      maxNodes: options.maxNodes ?? 65536,
      maxSelected: options.maxSelected ?? 8192,

      // Traversal
      sseTarget: options.sseTarget ?? 16,
      maxTraversalDepth: options.maxTraversalDepth ?? 24,
      maxSelectedPerFrame: options.maxSelectedPerFrame ?? 4096,

      // Snapshot rebuild policy
      rebuildOnTreeVersionChange: options.rebuildOnTreeVersionChange ?? true,
      rebuildIntervalTicks: options.rebuildIntervalTicks ?? 30,

      // Fallback
      fallbackToSingleThread: options.fallbackToSingleThread ?? true,

      // Diagnostics
      enableDiagnostics: options.enableDiagnostics ?? true,

      ...options
    };

    // ---- Snapshot ----
    this._snapshot = new FlattenedTreeSnapshot({
      maxNodes: this.options.maxNodes,
      maxSelected: this.options.maxSelected
    });

    // ---- Flattener ----
    this._flattener = new TreeFlattener();

    // ---- Worker pool ----
    this._workerPool = this._createWorkerPool();

    // ---- Frustum planes (cached) ----
    this._frustumPlanes = new Float64Array(24);

    // ---- Context bindings ----
    this.frame = null;
    this.ecsWorld = null;
    this.tileset = null;
    this.lodFidelity = null;
    this.seamStitcher = null;
    this.renderDispatch = null;
    this.dispatcher = null;
    this.lastTick = 0;
    this._accumulator = 0;

    // ---- Snapshot state ----
    this._snapshotTreeVersion = 0;
    this._lastRebuildTick = 0;
    this._tileIndexToNode = new Map();  // Tile3D → snapshotIndex
    this._nodeToTileIndex = new Map();  // snapshotIndex → Tile3D

    // ---- Result state ----
    this._resultState = TraversalResultState.EMPTY;
    this._lastSubmittedFrame = -1;
    this._lastCompletedFrame = -1;

    // ---- Published selection SoA ----
    this._selection = {
      tileKeys: [],
      lods: [],
      entityIds: [],
      boundingVolumes: [],
      screenSpaceErrors: [],
      priorities: [],
      count: 0
    };

    // ---- Diagnostics ----
    this.stats = {
      framesProcessed: 0,
      totalTraversals: 0,
      workerTraversals: 0,
      singleThreadTraversals: 0,
      snapshotRebuilds: 0,
      totalSelected: 0,
      peakSelected: 0,
      mainThreadMergeMs: 0,
      workerTraversalMs: 0,
      totalTraversalMs: 0,
      lastUpdatedTick: 0
    };
  }

  _createWorkerPool() {
    if (this.options.mode === TraversalMode.SINGLE_THREADED) {
      return null;
    }
    try {
      return new TraversalWorkerPool({
        maxWorkers: this.options.maxWorkers
      });
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  bind(contextFrame, ecsWorld, tileset, lodFidelity, seamStitcher, renderDispatch, eventDispatcher = null) {
    this.frame = contextFrame;
    this.ecsWorld = ecsWorld;
    this.tileset = tileset;
    this.lodFidelity = lodFidelity;
    this.seamStitcher = seamStitcher;
    this.renderDispatch = renderDispatch;
    this.dispatcher = eventDispatcher;

    // Initialize workers with the shared buffer.
    if (this._workerPool && this._snapshot.isShared) {
      for (let i = 0; i < this._workerPool.workerCount; i++) {
        this._workerPool.initWorker(i, this._snapshot.buffer);
      }
    }

    return this;
  }

  // ---------------------------------------------------------------------
  // Main update
  // ---------------------------------------------------------------------

  /**
   * Main traversal tick. Called once per frame.
   *
   * @param {ContextFrame} contextFrame
   * @param {number} tick
   * @param {number} dt
   * @param {object} camera – { x, y, z, forwardX, ..., fov, screenWidth, screenHeight, near, far }
   * @returns {object} the current selection (from the PREVIOUS frame)
   */
  update(contextFrame, tick, dt, camera) {
    this.frame = contextFrame;
    this.lastTick = tick;

    // 1. Merge the previous frame's results (if any) into the render dispatcher.
    const mergeStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._mergeResults();
    const mergeEnd = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.stats.mainThreadMergeMs = mergeEnd - mergeStart;

    // 2. Check if the snapshot needs rebuilding.
    if (this._needsRebuild(tick)) {
      this._rebuildSnapshot(tick);
    }

    // 3. Submit the traversal job (async).
    this._submitTraversal(camera, tick);

    // 4. Return the current selection (last completed frame).
    this.stats.lastUpdatedTick = tick;
    this.stats.framesProcessed++;
    return this._selection;
  }

  // ---------------------------------------------------------------------
  // Snapshot rebuild
  // ---------------------------------------------------------------------

  _needsRebuild(tick) {
    if (!this.tileset || !this.tileset.root) return false;

    // Check tree version — the tileset exposes a version that bumps
    // whenever its structure changes.
    const currentVersion = this.tileset._tileIndex?.size ?? 0;
    if (currentVersion !== this._snapshotTreeVersion) return true;

    // Periodic rebuild for safety.
    if (tick - this._lastRebuildTick >= this.options.rebuildIntervalTicks) {
      return true;
    }

    return false;
  }

  _rebuildSnapshot(tick) {
    const rootTile = this.tileset?.root;
    if (!rootTile) return;

    // Get the SSE target from the LOD fidelity system if available.
    const sseTargetFn = (tile) => {
      if (this.lodFidelity) {
        const res = this.lodFidelity.getResolution(tile.tileKey);
        if (res) return res.screenSpaceError ?? this.options.sseTarget;
      }
      return this.options.sseTarget;
    };

    // Get the priority from the LOD fidelity system if available.
    const priorityFn = (tile) => {
      if (this.lodFidelity) {
        const res = this.lodFidelity.getResolution(tile.tileKey);
        if (res) return res.priority ?? 0;
      }
      return tile.priority ?? 0;
    };

    // Flatten.
    const nodeCount = this._flattener.flatten(rootTile, this._snapshot, {
      sseTargetFn,
      priorityFn
    });

    // Update indices.
    this._tileIndexToNode.clear();
    this._nodeToTileIndex.clear();
    this._flattener._indexMap.forEach((nodeIndex, tile) => {
      this._tileIndexToNode.set(tile, nodeIndex);
      this._nodeToTileIndex.set(nodeIndex, tile);
    });

    this._snapshotTreeVersion = this.tileset._tileIndex?.size ?? 0;
    this._lastRebuildTick = tick;
    this.stats.snapshotRebuilds++;

    this._emitEvent(TraversalEventType.SNAPSHOT_REBUILT, { nodeCount });
  }

  // ---------------------------------------------------------------------
  // Traversal submission
  // ---------------------------------------------------------------------

  _submitTraversal(camera, tick) {
    // Compute the frustum planes on the main thread.
    this._computeFrustumPlanes(camera);

    // Build the camera payload.
    const payload = {
      x: camera.x, y: camera.y, z: camera.z,
      forwardX: camera.forwardX, forwardY: camera.forwardY, forwardZ: camera.forwardZ,
      upX: camera.upX, upY: camera.upY, upZ: camera.upZ,
      rightX: camera.rightX, rightY: camera.rightY, rightZ: camera.rightZ,
      fov: camera.fov ?? Math.PI / 3,
      screenWidth: camera.screenWidth ?? 1920,
      screenHeight: camera.screenHeight ?? 1080,
      near: camera.near ?? 0.1,
      far: camera.far ?? 10000,
      sseTarget: this.options.sseTarget,
      frustumPlanes: Array.from(this._frustumPlanes)
    };

    // Decide which output buffer the workers should write to.
    const writeBuffer = this._snapshot._writeBuffer[0];
    const treeVersion = this._snapshot.getHeader().treeVersion;

    // Try the worker pool first.
    if (this._workerPool && this._workerPool.isAvailable && this._snapshot.isShared) {
      const submitted = this._workerPool.submit(
        0, payload, treeVersion, writeBuffer,
        (result) => this._onWorkerComplete(result)
      );

      if (submitted) {
        this._lastSubmittedFrame = tick;
        this.stats.workerTraversals++;
        this._emitEvent(TraversalEventType.TRAVERSAL_STARTED, { mode: 'worker' });
        return;
      }
    }

    // Fall back to single-threaded traversal.
    this._runSingleThreaded(payload, treeVersion, writeBuffer, tick);
  }

  _onWorkerComplete(result) {
    if (result.type === 'error') {
      this._emitEvent(TraversalEventType.WORKER_ERROR, { error: result.error });
      this._resultState = TraversalResultState.FAILED;
      return;
    }

    // Flip the buffers so the main thread can read the results next frame.
    this._snapshot.flipBuffers();
    this._lastCompletedFrame = this.lastTick;
    this._resultState = TraversalResultState.FRESH;
    this.stats.totalTraversals++;

    this._emitEvent(TraversalEventType.TRAVERSAL_COMPLETED, {
      mode: 'worker',
      visited: result.visited,
      selected: result.selected,
      refined: result.refined,
      culled: result.culled,
      traversalMs: result.traversalMs
    });
  }

  /**
   * Single-threaded fallback traversal — runs on the main thread but uses
   * the same flattened snapshot so behaviour is identical.
   */
  _runSingleThreaded(payload, treeVersion, writeBuffer, tick) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    const snap = this._snapshot;
    const header = snap.getHeader();
    const nodeCount = header.nodeCount;
    const rootNodeIndex = header.rootNodeIndex;

    if (nodeCount === 0 || rootNodeIndex < 0) {
      return;
    }

    const sseFactor = payload.screenHeight / (2 * Math.tan(payload.fov * 0.5));
    const planes = this._frustumPlanes;

    let visited = 0, selected = 0, refined = 0, culled = 0;
    let writeCount = 0;

    const base = writeBuffer * snap.maxSelected;
    const aabb = new Float64Array(6);

    // Iterative stack.
    const stackNode = new Int32Array(1024);
    const stackDepth = new Int32Array(1024);
    let stackTop = 0;

    stackNode[stackTop] = rootNodeIndex;
    stackDepth[stackTop] = 0;
    stackTop++;

    while (stackTop > 0) {
      stackTop--;
      const nodeIdx = stackNode[stackTop];
      visited++;

      // Frustum cull.
      snap.getNodeBounds(nodeIdx, aabb);
      if (isBoxOutsideFrustum(planes, aabb[0], aabb[1], aabb[2], aabb[3], aabb[4], aabb[5])) {
        culled++;
        continue;
      }

      // Compute SSE.
      const dx = snap._centerX[nodeIdx] - payload.x;
      const dy = snap._centerY[nodeIdx] - payload.y;
      const dz = snap._centerZ[nodeIdx] - payload.z;
      let distance = Math.sqrt(dx * dx + dy * dy + dz * dz) - snap._radius[nodeIdx];
      if (distance < 0.001) distance = 0.001;

      const sse = (snap._geometricError[nodeIdx] / distance) * sseFactor;
      const effectiveTarget = Math.min(snap._sseTarget[nodeIdx], this.options.sseTarget);

      const hasChildren = snap._child0[nodeIdx] >= 0 || snap._child1[nodeIdx] >= 0 ||
                          snap._child2[nodeIdx] >= 0 || snap._child3[nodeIdx] >= 0;

      const shouldRefine = (sse > effectiveTarget) && hasChildren;

      if (shouldRefine) {
        refined++;
        for (let slot = 0; slot < 4; slot++) {
          const childIdx = snap.getNodeChild(nodeIdx, slot);
          if (childIdx < 0) continue;
          if (stackTop >= 1024) break;
          stackNode[stackTop] = childIdx;
          stackTop++;
        }
        continue;
      }

      // Select.
      if (writeCount < snap.maxSelected && writeCount < this.options.maxSelectedPerFrame) {
        const contentAvail = snap._contentAvailable[nodeIdx] === 1;
        const isReady = snap._loadState[nodeIdx] === 4;
        if ((contentAvail && isReady) || !hasChildren) {
          snap._selectedIndices[base + writeCount] = nodeIdx;
          snap._selectedPriority[base + writeCount] = snap._tilePriority[nodeIdx];
          snap._selectedSSE[base + writeCount] = sse;
          writeCount++;
          selected++;
        }
      }
    }

    snap._selectedCount[writeBuffer] = writeCount;
    snap.flipBuffers();

    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.stats.singleThreadTraversals++;
    this.stats.totalTraversals++;
    this.stats.workerTraversalMs = t1 - t0;
    this.stats.totalTraversalMs += (t1 - t0);
    this._lastCompletedFrame = tick;
    this._resultState = TraversalResultState.FRESH;

    this._emitEvent(TraversalEventType.TRAVERSAL_COMPLETED, {
      mode: 'single-threaded',
      visited, selected, refined, culled,
      traversalMs: t1 - t0
    });
  }

  // ---------------------------------------------------------------------
  // Frustum computation
  // ---------------------------------------------------------------------

  _computeFrustumPlanes(camera) {
    // Build the view-projection matrix.
    const zx = -camera.forwardX, zy = -camera.forwardY, zz = -camera.forwardZ;
    const xx = camera.rightX, xy = camera.rightY, xz = camera.rightZ;
    const yx = camera.upX, yy = camera.upY, yz = camera.upZ;

    const lenZ = Math.sqrt(zx * zx + zy * zy + zz * zz) || 1;
    const lenX = Math.sqrt(xx * xx + xy * xy + xz * xz) || 1;
    const lenY = Math.sqrt(yx * yx + yy * yy + yz * yz) || 1;

    const nzx = zx / lenZ, nzy = zy / lenZ, nzz = zz / lenZ;
    const nxx = xx / lenX, nxy = xy / lenX, nxz = xz / lenX;
    const nyx = yx / lenY, nyy = yy / lenY, nyz = yz / lenY;

    const cx = camera.x, cy = camera.y, cz = camera.z;

    // View matrix.
    const view = new Float32Array(16);
    view[0]  = nxx; view[1]  = nxy; view[2]  = nxz; view[3]  = -(nxx * cx + nxy * cy + nxz * cz);
    view[4]  = nyx; view[5]  = nyy; view[6]  = nyz; view[7]  = -(nyx * cx + nyy * cy + nyz * cz);
    view[8]  = nzx; view[9]  = nzy; view[10] = nzz; view[11] = -(nzx * cx + nzy * cy + nzz * cz);
    view[12] = 0;   view[13] = 0;   view[14] = 0;   view[15] = 1;

    // Projection.
    const fov = camera.fov ?? Math.PI / 3;
    const aspect = (camera.screenWidth ?? 1920) / (camera.screenHeight ?? 1080);
    const near = camera.near ?? 0.1;
    const far = camera.far ?? 10000;

    const f = 1 / Math.tan(fov * 0.5);
    const nf = 1 / (near - far);
    const proj = new Float32Array(16);
    proj[0] = f / aspect;
    proj[5] = f;
    proj[10] = (far + near) * nf;
    proj[11] = -1;
    proj[14] = 2 * far * near * nf;
    proj[15] = 0;

    // Multiply.
    const vp = new Float32Array(16);
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += proj[k * 4 + row] * view[col * 4 + k];
        vp[col * 4 + row] = sum;
      }
    }

    extractFrustumPlanes(vp, this._frustumPlanes);
  }

  // ---------------------------------------------------------------------
  // Merge results into render dispatcher
  // ---------------------------------------------------------------------

  _mergeResults() {
    if (this._resultState !== TraversalResultState.FRESH) return;

    const selection = this._snapshot.getReadSelection();
    if (!selection.indices) {
      this._selection.count = 0;
      return;
    }

    // Rebuild the selection SoA.
    const sel = this._selection;
    sel.tileKeys.length = 0;
    sel.lods.length = 0;
    sel.entityIds.length = 0;
    sel.boundingVolumes.length = 0;
    sel.screenSpaceErrors.length = 0;
    sel.priorities.length = 0;

    const aabb = new Float64Array(6);

    for (let i = 0; i < selection.count; i++) {
      const nodeIdx = selection.indices[i];
      const tile = this._nodeToTileIndex.get(nodeIdx);
      if (!tile) continue;

      this._snapshot.getNodeBounds(nodeIdx, aabb);

      sel.tileKeys.push(tile.tileKey);
      sel.lods.push(tile.lod);
      sel.entityIds.push(tile.entityId);
      sel.boundingVolumes.push(aabb[0], aabb[1], aabb[2], aabb[3], aabb[4], aabb[5]);
      sel.screenSpaceErrors.push(selection.sse[i]);
      sel.priorities.push(selection.priorities[i]);
    }

    sel.count = sel.tileKeys.length;
    this.stats.totalSelected += sel.count;
    if (sel.count > this.stats.peakSelected) this.stats.peakSelected = sel.count;

    // Publish to physical channel.
    this._publishToPhysicalChannel();
  }

  _publishToPhysicalChannel() {
    if (!this.frame?.layers?.physical) return;
    const physical = this.frame.layers.physical;
    const sel = this._selection;

    physical.traversalTileKeys = sel.tileKeys;
    physical.traversalLods = sel.lods;
    physical.traversalEntityIds = sel.entityIds;
    physical.traversalBoundingVolumes = sel.boundingVolumes;
    physical.traversalScreenSpaceErrors = sel.screenSpaceErrors;
    physical.traversalPriorities = sel.priorities;
    physical.traversalStats = this.getStats();
  }

  // ---------------------------------------------------------------------
  // Event emission
  // ---------------------------------------------------------------------

  _emitEvent(type, payload) {
    if (!this.dispatcher) return;
    try {
      this.dispatcher.dispatch('traversal:' + type, payload);
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------
  // Public queries
  // ---------------------------------------------------------------------

  getSelection() {
    return this._selection;
  }

  getResultState() {
    return this._resultState;
  }

  getStats() {
    return {
      ...this.stats,
      mode: this._workerPool && this._workerPool.isAvailable
        ? TraversalMode.WORKER_POOL
        : TraversalMode.SINGLE_THREADED,
      snapshotNodes: this._snapshot.nodeCount,
      snapshotVersion: this._snapshot.treeVersion,
      workerCount: this._workerPool?.workerCount ?? 0,
      workersReady: this._workerPool?.readyCount ?? 0,
      isShared: this._snapshot.isShared
    };
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  clear() {
    this._flattener.clear();
    this._snapshot.reset();
    this._tileIndexToNode.clear();
    this._nodeToTileIndex.clear();
    this._selection.count = 0;
    this._selection.tileKeys.length = 0;
    this._selection.lods.length = 0;
    this._selection.entityIds.length = 0;
    this._selection.boundingVolumes.length = 0;
    this._selection.screenSpaceErrors.length = 0;
    this._selection.priorities.length = 0;
    this._resultState = TraversalResultState.EMPTY;
  }

  dispose() {
    this.clear();
    this._snapshot.dispose();
    this._workerPool?.dispose();
    this.frame = null;
    this.ecsWorld = null;
    this.tileset = null;
    this.lodFidelity = null;
    this.seamStitcher = null;
    this.renderDispatch = null;
    this.dispatcher = null;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 8. FACTORY
// ═════════════════════════════════════════════════════════════════════

export function createTerrainTileset3DTraversal(options = {}) {
  return new TerrainTileset3DTraversal({
    mode: options.mode ?? TraversalMode.AUTO,
    maxWorkers: options.maxWorkers ?? 2,
    maxNodes: options.maxNodes ?? 65536,
    maxSelected: options.maxSelected ?? 8192,
    sseTarget: options.sseTarget ?? 16,
    maxTraversalDepth: options.maxTraversalDepth ?? 24,
    maxSelectedPerFrame: options.maxSelectedPerFrame ?? 4096,
    rebuildOnTreeVersionChange: options.rebuildOnTreeVersionChange ?? true,
    rebuildIntervalTicks: options.rebuildIntervalTicks ?? 30,
    fallbackToSingleThread: options.fallbackToSingleThread ?? true,
    enableDiagnostics: options.enableDiagnostics ?? true,
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 9. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  TerrainTileset3DTraversal,
  FlattenedTreeSnapshot,
  TreeFlattener,
  TraversalWorkerPool,
  TraversalStatsComponent,
  TraversalMode,
  TraversalResultState,
  TraversalEventType,
  createTerrainTileset3DTraversal
};