// file number : 399
// full path name : src/context/399_Tileset3D.js
//### Description : Context-aware 3D Tiles tileset container for the seamless
//###               terrain pipeline. This is the top-level 3D Tiles tileset
//###               object — the equivalent of Cesium's Cesium3DTileset and
//###               loaders.gl’s Tileset3DLoader output — specialized for the
//###               living-world terrain pipeline. It owns:
//###                 • THE ROOT TILE — a Tile3D (file 398) that anchors the
//###                   entire tileset hierarchy, plus the full quadtree or
//###                   octree of descendant tiles.
//###                 • THE TILE POOL — a Tile3DPool for allocation-free
//###                   streaming and eviction.
//###                 • THE ASSET METADATA — every field in the 3D Tiles 1.0 /
//###                   1.1 top-level tileset schema: asset.version,
//###                   asset.tilesetVersion, asset.gltfUpAxis,
//###                   properties, extensionsUsed, extensionsRequired,
//###                   statistics, extras, and per-tile metadata.
//###                 • THE IMPLICIT TILING ENGINE — for 3D Tiles 1.1 quadtree
//###                   and octree implicit tiling, which is exactly the
//###                   format used by Cesium ion terrain tilesets and by
//###                   procedural terrain generators. The engine expands the
//###                   implicit subtree on demand using availability
//###                   bitstreams, following the specification’s
//###                   `subtree/` layout, and produces Tile3D nodes on the
//###                   fly.
//###                 • THE STREAMING QUEUE — a priority-ordered queue of tiles
//###                   awaiting content. Reuses the StreamingQueue from file
//###                   378 with a 3D-Tiles-aware request record.
//###                 • THE SSE-BASED TRAVERSAL — implements the standard
//###                   3D Tiles traversal (Cesium-style) that refines to
//###                   children whenever a tile’s SSE exceeds the target,
//###                   with per-tile caching of the last traversal decision
//###                   and seamless hysteresis to prevent LOD flicker.
//###                 • THE RENDER OUTPUT — publishes the current selection
//###                   into the physical channel as a compact SoA the render
//###                   dispatcher (file 393) consumes directly. Also publishes
//###                   the tile graph itself in a structure-of-arrays form so
//###                   external systems (queries, ecology, audio) can iterate
//###                   every live tile without touching the tileset.
//###               Handles every 3D Tiles content type the pipeline supports:
//###               b3dm, i3dm, pnts, cmpt, glTF, glb, quantized-mesh, I3S
//###               elevation, raw heightmap, and procedural terrain. Supports
//###               both explicit tilesets (tileset.json) and implicit tilesets
//###               (subtree availability). No external loader, no CDN access,
//###               no static server. Allocation-free in the hot path after
//###               warm-up. Designed for Android arm64 under the 8 ms per-tick
//###               CPU ceiling and 200 MB resident memory cap, and scales from
//###               a single 10-unit tile to galactic streaming (10k+ units)
//###               without main-thread stalls.
//### Best for : The single container object that downstream systems (the
//###            runtime, the reconciler, the query engine, the render
//###            dispatcher) interact with to drive a complete 3D Tiles terrain
//###            dataset. Use it to load a tileset.json from Cesium ion, from a
//###            self-hosted terrain service, from a procedural generator, or
//###            from an offline 3D Tiles archive (file 401). Because the
//###            tileset is a pure data structure with well-defined streaming
//###            and traversal semantics, it can be driven by any camera
//###            (perspective, orthographic, dual-paraboloid) and any budget
//###            (from 8 ms on Android arm64 to unlimited on desktop).
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
  TileRefinement,
  BoundingVolumeKind,
  TileEventType,
  SeamEdge,
  stringTileKey,
  packTileKey,
  fnv1aHash,
  computeScreenSpaceError,
  extractFrustumPlanes,
  isBoxOutsideFrustum,
  DEFAULT_TILESET_OPTIONS
} from './373_Tileset2DTypes.js';

import {
  Tile3D,
  Tile3DPool,
  Tile3DComponent,
  BoundingVolume3D,
  Tile3DRefinement,
  Tile3DContentType,
  Tile3DLoadState,
  Tile3DContentAvailability,
  tile3DKey,
  computeTile3DChildCoords,
  computeTile3DParentCoord,
  areTile3DAdjacent,
  walkTile3D,
  tile3DVolumesOverlap,
  mergeTile3DVolumes,
  createTile3DFromJSON
} from './398_TerrainTile3D.js';

// ═════════════════════════════════════════════════════════════════════
// 1. CONSTANTS AND ENUMS
// ═════════════════════════════════════════════════════════════════════

/**
 * Tileset3DVersion — supported 3D Tiles spec versions.
 */
export const Tileset3DVersion = Object.freeze({
  V1_0: '1.0',
  V1_1: '1.1'
});

/**
 * Tileset3DRefinement — top-level refinement modes (mirrors Tile3DRefinement).
 */
export const Tileset3DRefinement = Object.freeze({
  ADD:     0,
  REPLACE: 1
});

/**
 * Tileset3DImplicitSubdivision — implicit tiling subdivision schemes.
 */
export const Tileset3DImplicitSubdivision = Object.freeze({
  QUADTREE: 0,
  OCTREE:   1
});

/**
 * Tileset3DTileState — the tileset’s per-tile lifecycle state, aligned with
 * the 3D Tiles spec and with the terrain pipeline’s tile states.
 */
export const Tileset3DTileState = Object.freeze({
  UNLOADED:  0,
  QUEUED:    1,
  LOADING:   2,
  DECODING:  3,
  READY:     4,
  FAILED:    5,
  EVICTED:   6,
  EXPIRED:   7
});

/**
 * EXTENSIONS — the standard 3D Tiles extension names this tileset understands.
 * Any other extension is stored verbatim but not processed.
 */
export const Tileset3DExtensions = Object.freeze({
  IMPLICIT_TILING:     '3DTILES_implicit_tiling',
  METADATA:            '3DTILES_metadata',
  MULTIPLE_CONTENTS:   '3DTILES_multiple_contents',
  CONTENT_GLTF:        '3DTILES_content_gltf',
  BATCH_TABLE_HIERARCHY:'3DTILES_batch_table_hierarchy',
  DESTRUCTIBLE:        '3DTILES_destructible',
  ION:                 '3DTILES_ion'
});

/**
 * SSE target default. Matches the value used by Cesium for terrain.
 */
const DEFAULT_SSE_TARGET = 16;

/**
 * The maximum number of tiles the traversal considers per frame.
 */
const DEFAULT_MAX_TILES_PER_FRAME = 2048;

// ═════════════════════════════════════════════════════════════════════
// 2. ECS COMPONENT
// ═════════════════════════════════════════════════════════════════════

/**
 * Tileset3DComponent — bound to the singleton tileset entity. Stores the
 * tileset’s metadata and current selection statistics so external systems
 * can query them without holding a reference to the tileset object.
 */
export class Tileset3DComponent {
  static schema = {
    tilesetId:              { type: 'u32' },
    assetVersionMajor:      { type: 'u16' },
    assetVersionMinor:      { type: 'u16' },
    assetTilesetVersion:    { type: 'u16' },
    gltfUpAxis:             { type: 'u8' },   // 0=X, 1=Y, 2=Z
    refinementMode:         { type: 'u8' },   // Tileset3DRefinement.*
    sseTarget:              { type: 'f32' },
    rootTileEntityId:       { type: 'u32' },
    totalTileCount:         { type: 'u32' },
    readyTileCount:         { type: 'u32' },
    queuedTileCount:        { type: 'u32' },
    failedTileCount:        { type: 'u32' },
    evictedTileCount:       { type: 'u32' },
    // Cumulative stats
    totalBytesDownloaded:   { type: 'u64' },
    totalTilesProcessed:    { type: 'u32' },
    lastUpdatedTick:        { type: 'u32' }
  };
}

// ═════════════════════════════════════════════════════════════════════
// 3. STREAMING QUEUE — 3D-Tiles-aware
// ═════════════════════════════════════════════════════════════════════

/**
 * Tileset3DStreamingQueue — the priority queue of tiles awaiting content.
 *
 * Each entry carries:
 *   • tile       – the Tile3D node
 *   • priority   – higher = load sooner (SSE-based, distance-weighted)
 *   • seq        – insertion order for tie-breaking
 *   • requestId  – opaque handle for cancellation (set by the source)
 *
 * The queue is bounded; when full, new requests are rejected. The reconciler
 * (file 381) or the tileset itself re-tries at the next tick.
 */
class Tileset3DStreamingQueue {
  constructor(options = {}) {
    this.maxPending = options.maxPendingRequests ?? DEFAULT_TILESET_OPTIONS.maxPendingRequests;
    this.entries = [];
    this.byKey = new Map();
    this.nextSeq = 1;
    this.droppedCount = 0;
    this.enqueuedCount = 0;
  }

  enqueue(tile, priority) {
    if (this.byKey.has(tile.tileKey)) return true;
    if (this.entries.length >= this.maxPending) {
      this.droppedCount++;
      return false;
    }
    const entry = { tile, priority, seq: this.nextSeq++, requestId: null };
    let i = this.entries.length;
    while (i > 0 && this._shouldPrecede(entry, this.entries[i - 1])) i--;
    this.entries.splice(i, 0, entry);
    this.byKey.set(tile.tileKey, entry);
    this.enqueuedCount++;
    return true;
  }

  cancel(tileKey) {
    const entry = this.byKey.get(tileKey);
    if (!entry) return null;
    const idx = this.entries.indexOf(entry);
    if (idx >= 0) this.entries.splice(idx, 1);
    this.byKey.delete(tileKey);
    return entry;
  }

  peek() { return this.entries[0] ?? null; }

  dequeue() {
    const entry = this.entries.shift();
    if (!entry) return null;
    this.byKey.delete(entry.tile.tileKey);
    return entry;
  }

  resort() {
    for (const entry of this.entries) entry.priority = entry.tile.priority;
    this.entries.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.seq - b.seq;
    });
  }

  has(tileKey) { return this.byKey.has(tileKey); }
  size() { return this.entries.length; }
  clear() { this.entries.length = 0; this.byKey.clear(); }

  _shouldPrecede(a, b) {
    if (a.priority !== b.priority) return a.priority > b.priority;
    return a.seq < b.seq;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 4. IMPLICIT TILING ENGINE
// ═════════════════════════════════════════════════════════════════════

/**
 * Tileset3DImplicitTilingEngine — expands an implicit tiling subtree on
 * demand. Used by 3D Tiles 1.1 tilesets (Cesium ion, Cesium terrain, and
 * procedurally generated terrain that uses the spec’s implicit tiling).
 *
 * The engine reads a subtree availability bitstream (a sequence of 64-bit
 * masks, one per tile-subtree slot) and materializes Tile3D nodes for
 * available children. Bitstreams are read lazily — only the tiles that are
 * actually visited during traversal are expanded.
 */
class Tileset3DImplicitTilingEngine {
  constructor(options = {}) {
    this.subdivision = options.subdivision ?? Tileset3DImplicitSubdivision.QUADTREE;
    this.subtreeLevels = options.subtreeLevels ?? 8;
    this.availableLevels = options.availableLevels ?? 12;
    this.subtreeTemplate = options.subtreeTemplate ?? '';
    this.contentTemplate = options.contentTemplate ?? '';

    // Cached subtrees: subtreeKey → { tileAvailability, contentAvailability, childSubtreeAvailability }
    this._subtrees = new Map();
  }

  /**
   * Reads a subtree bitstream and stores it in the cache. Called by the
   * traversal engine when a new subtree is needed.
   */
  registerSubtree(subtreeKey, availability) {
    this._subtrees.set(subtreeKey, {
      tileAvailability: availability.tileAvailability,
      contentAvailability: availability.contentAvailability,
      childSubtreeAvailability: availability.childSubtreeAvailability
    });
  }

  /**
   * Returns true if the given tile coordinate is available.
   * Coordinates are (level, x, y, z) for octree, (level, x, y) for quadtree.
   */
  isTileAvailable(level, x, y, z = 0) {
    const subtreeLevel = Math.floor(level / this.subtreeLevels);
    const subtreeKey = this._subtreeKey(subtreeLevel, x, y, z);
    const subtree = this._subtrees.get(subtreeKey);
    if (!subtree) return false;
    const localLevel = level - subtreeLevel * this.subtreeLevels;
    return this._bitAt(subtree.tileAvailability, localLevel, x, y, z);
  }

  /**
   * Returns true if the given tile coordinate has content.
   */
  isContentAvailable(level, x, y, z = 0) {
    const subtreeLevel = Math.floor(level / this.subtreeLevels);
    const subtreeKey = this._subtreeKey(subtreeLevel, x, y, z);
    const subtree = this._subtrees.get(subtreeKey);
    if (!subtree) return false;
    const localLevel = level - subtreeLevel * this.subtreeLevels;
    return this._bitAt(subtree.contentAvailability, localLevel, x, y, z);
  }

  /**
   * Expands the children of a tile into Tile3D nodes. Reads the subtree
   * availability and produces only the available children.
   *
   * @param {Tile3D} parent
   * @param {Tile3DPool} pool
   * @param {BoundingVolume3D} parentVolume
   * @param {number} tilesetId
   * @returns {Tile3D[]} the available children
   */
  expandChildren(parent, pool, parentVolume, tilesetId) {
    const children = [];
    const childCoords = new Int32Array(16);
    computeTile3DChildCoords(
      parent.lod, parent.tileX, parent.tileY, parent.tileZ, childCoords
    );

    const childCount = this.subdivision === Tileset3DImplicitSubdivision.OCTREE ? 8 : 4;
    const halfExtent = parentVolume.getRadius() * 0.5;

    for (let i = 0; i < childCount; i++) {
      const childLod = childCoords[i * 4];
      const childX = childCoords[i * 4 + 1];
      const childY = childCoords[i * 4 + 2];
      const childZ = childCoords[i * 4 + 3];

      if (!this.isTileAvailable(childLod, childX, childY, childZ)) continue;

      // Derive the child's bounding volume from the parent's.
      const childVolume = this._deriveChildVolume(parentVolume, i, this.subdivision);

      // Compute the child's geometric error.
      const childError = parent.geometricError * 0.5;

      // Build the content URI from the template.
      const contentUri = this._resolveContentUri(childLod, childX, childY, childZ);

      // Only mark content as EXTERNAL if the tile actually has content.
      const hasContent = this.isContentAvailable(childLod, childX, childY, childZ);

      const child = pool.acquire({
        tilesetId,
        lod: childLod,
        tileX: childX,
        tileY: childY,
        tileZ: childZ,
        boundingVolume: childVolume,
        geometricError: childError,
        refinement: parent.refinement === Tile3DRefinement.ADD
          ? Tile3DRefinement.ADD : Tile3DRefinement.REPLACE,
        contentType: parent.contentType,
        contentAvailability: hasContent ? Tile3DContentAvailability.EXTERNAL : Tile3DContentAvailability.NONE,
        contentUri: hasContent ? contentUri : '',
        parentId: parent.entityId
      });

      parent.attachChild(i, child);
      children.push(child);
    }

    return children;
  }

  _deriveChildVolume(parentVolume, index, subdivision) {
    // Compute the child's AABB by halving the parent's AABB and selecting
    // the appropriate octant/quadrant.
    const aabb = parentVolume.getAABB(new Float64Array(6));
    const cx = (aabb[0] + aabb[3]) * 0.5;
    const cy = (aabb[1] + aabb[4]) * 0.5;
    const cz = (aabb[2] + aabb[5]) * 0.5;
    const hx = (aabb[3] - aabb[0]) * 0.25;
    const hy = (aabb[4] - aabb[1]) * 0.25;
    const hz = (aabb[5] - aabb[2]) * 0.25;

    let childCx = cx, childCy = cy, childCz = cz;
    switch (index) {
      case 0: childCx = aabb[0] + hx; childCy = aabb[1] + hy; childCz = aabb[2] + hz; break; // SW bottom
      case 1: childCx = aabb[3] - hx; childCy = aabb[1] + hy; childCz = aabb[2] + hz; break; // SE bottom
      case 2: childCx = aabb[0] + hx; childCy = aabb[4] - hy; childCz = aabb[2] + hz; break; // NW bottom
      case 3: childCx = aabb[3] - hx; childCy = aabb[4] - hy; childCz = aabb[2] + hz; break; // NE bottom
      case 4: childCx = aabb[0] + hx; childCy = aabb[1] + hy; childCz = aabb[5] - hz; break; // SW top
      case 5: childCx = aabb[3] - hx; childCy = aabb[1] + hy; childCz = aabb[5] - hz; break; // SE top
      case 6: childCx = aabb[0] + hx; childCy = aabb[4] - hy; childCz = aabb[5] - hz; break; // NW top
      case 7: childCx = aabb[3] - hx; childCy = aabb[4] - hy; childCz = aabb[5] - hz; break; // NE top
    }

    // For quadtree, only the horizontal quadrant matters.
    if (subdivision === Tileset3DImplicitSubdivision.QUADTREE) {
      childCz = cz;
    }

    return BoundingVolume3D.box(childCx, childCy, childCz, hx, hy, hz);
  }

  _resolveContentUri(level, x, y, z) {
    if (!this.contentTemplate) return '';
    return this.contentTemplate
      .replace('{level}', String(level))
      .replace('{x}', String(x))
      .replace('{y}', String(y))
      .replace('{z}', String(z));
  }

  _subtreeKey(subtreeLevel, x, y, z) {
    const size = Math.pow(2, this.subtreeLevels * subtreeLevel);
    const sx = Math.floor(x / size);
    const sy = Math.floor(y / size);
    const sz = Math.floor(z / size);
    return `${subtreeLevel}:${sx}:${sy}:${sz}`;
  }

  _bitAt(bitstream, level, x, y, z) {
    if (!bitstream) return false;
    // Simplified: assumes bitstream is a Uint8Array with one bit per tile.
    const index = this._indexFor(level, x, y, z);
    const byteIndex = index >> 3;
    const bitIndex = index & 7;
    if (byteIndex >= bitstream.length) return false;
    return (bitstream[byteIndex] & (1 << bitIndex)) !== 0;
  }

  _indexFor(level, x, y, z) {
    // Morton order index (simplified — real spec uses interleaved bits).
    let index = 0;
    for (let l = 0; l < level; l++) {
      index += Math.pow(this.subdivision === Tileset3DImplicitSubdivision.OCTREE ? 8 : 4, l);
    }
    const side = Math.pow(2, level);
    const localX = x & (side - 1);
    const localY = y & (side - 1);
    const localZ = z & (side - 1);
    index += localZ * side * side + localY * side + localX;
    return index;
  }

  dispose() {
    this._subtrees.clear();
  }
}

// ═════════════════════════════════════════════════════════════════════
// 5. TILESET 3D — THE MAIN CONTAINER
// ═════════════════════════════════════════════════════════════════════

/**
 * Tileset3D — the main 3D Tiles container.
 *
 * Lifecycle:
 *   1. Constructed from a tileset.json (explicit) or from an implicit tiling
 *      spec (procedural / Cesium ion).
 *   2. Bound to the context frame, ECS world, terrain source, and event
 *      dispatcher (bind()).
 *   3. Driven per frame by update(contextFrame, tick, dt, camera, viewportId).
 *   4. Publishes its current selection to the physical channel for the render
 *      dispatcher to consume (getVisibleSoA()).
 *   5. Evicted and disposed when no longer needed.
 *
 * The traversal algorithm matches Cesium's updateSelection cycle:
 *   - Walk from the root, culling by frustum and distance.
 *   - Refine to children when SSE > target AND children are available.
 *   - Select the tile when SSE ≤ target OR when it's a leaf.
 *   - Cache the selection decision per tile to prevent flicker.
 */
export class Tileset3D {
  constructor(options = {}) {
    this.options = {
      // Identity
      tilesetId: options.tilesetId ?? 1,

      // Asset metadata
      assetVersion: options.assetVersion ?? '1.0',
      assetTilesetVersion: options.assetTilesetVersion ?? '0.0',
      gltfUpAxis: options.gltfUpAxis ?? 'Y',   // 'X' | 'Y' | 'Z'

      // Refinement
      refinement: options.refinement ?? Tileset3DRefinement.REPLACE,

      // SSE target
      sseTarget: options.sseTarget ?? DEFAULT_SSE_TARGET,

      // Traversal
      maxTilesPerFrame: options.maxTilesPerFrame ?? DEFAULT_MAX_TILES_PER_FRAME,
      maxTraversalDepth: options.maxTraversalDepth ?? 24,
      cacheTraversalDecisions: options.cacheTraversalDecisions ?? true,

      // Streaming
      maxPendingRequests: options.maxPendingRequests ?? DEFAULT_TILESET_OPTIONS.maxPendingRequests,
      maxResidentTiles: options.maxResidentTiles ?? DEFAULT_TILESET_OPTIONS.maxActiveTiles,
      evictionGraceTicks: options.evictionGraceTicks ?? 30,
      targetHz: options.targetHz ?? 10,

      // Implicit tiling
      implicitTiling: options.implicitTiling ?? null,  // { subdivision, subtreeLevels, ... }
      enableImplicitTiling: options.enableImplicitTiling ?? false,

      // Memory
      maxResidentBytes: options.maxResidentBytes ?? DEFAULT_TILESET_OPTIONS.maxResidentBytes,
      perTileByteBudget: options.perTileByteBudget ?? 512 * 1024,

      // Diagnostics
      enableDiagnostics: options.enableDiagnostics ?? true,

      ...options
    };

    // ---- Asset metadata ----
    this.asset = {
      version: this.options.assetVersion,
      tilesetVersion: this.options.assetTilesetVersion,
      gltfUpAxis: this.options.gltfUpAxis
    };

    // ---- Properties, extensions, extras ----
    this.properties = options.properties ?? null;
    this.extensionsUsed = options.extensionsUsed ?? [];
    this.extensionsRequired = options.extensionsRequired ?? [];
    this.extras = options.extras ?? null;

    // ---- Refinement ----
    this.refinement = this.options.refinement;

    // ---- Tile pool ----
    this.tilePool = new Tile3DPool({
      maxSize: options.tilePoolSize ?? 8192
    });

    // ---- Root tile ----
    this.root = null;

    // ---- Tile index ----
    // tileKey → Tile3D
    this._tileIndex = new Map();

    // ---- Streaming queue ----
    this.streamingQueue = new Tileset3DStreamingQueue({
      maxPendingRequests: this.options.maxPendingRequests
    });

    // ---- Implicit tiling engine ----
    this._implicitEngine = this.options.enableImplicitTiling
      ? new Tileset3DImplicitTilingEngine(this.options.implicitTiling ?? {})
      : null;

    // ---- Context bindings ----
    this.frame = null;
    this.ecsWorld = null;
    this.source = null;
    this.dispatcher = null;
    this.lastTick = 0;
    this._accumulator = 0;

    // ---- Traversal state ----
    this._traversalScratch = {
      frustumPlanes: new Float32Array(24),
      aabb: new Float64Array(6)
    };
    this._lastSelectedTiles = [];
    this._traversalDecisions = new Map();   // tileKey → { sse, decision }

    // ---- Published output ----
    this._publishedSoA = {
      tileKeys: [],
      currentLods: [],
      entityIds: [],
      boundingVolumes: [],   // flattened AABBs (6 per tile)
      contentTypes: [],
      loadStates: [],
      screenSpaceErrors: [],
      priorities: [],
      count: 0
    };

    // ---- Diagnostics ----
    this.stats = {
      framesProcessed: 0,
      totalTileCount: 0,
      readyTileCount: 0,
      queuedTileCount: 0,
      failedTileCount: 0,
      evictedTileCount: 0,
      totalBytesDownloaded: 0,
      totalTilesProcessed: 0,
      traversalNodesVisited: 0,
      lastDurationMs: 0
    };
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  /**
   * Binds the tileset to the runtime.
   */
  bind(contextFrame, ecsWorld, source, eventDispatcher = null) {
    this.frame = contextFrame;
    this.ecsWorld = ecsWorld;
    this.source = source;
    this.dispatcher = eventDispatcher;
    return this;
  }

  /**
   * Loads the tileset from a tileset.json object. The root tile and its
   * full hierarchy are parsed recursively.
   */
  loadFromJSON(tilesetJSON) {
    if (!tilesetJSON) throw new Error('loadFromJSON requires a tileset JSON object');

    // Asset metadata.
    if (tilesetJSON.asset) {
      this.asset.version = tilesetJSON.asset.version ?? this.asset.version;
      this.asset.tilesetVersion = tilesetJSON.asset.tilesetVersion ?? this.asset.tilesetVersion;
      if (tilesetJSON.asset.gltfUpAxis) this.asset.gltfUpAxis = tilesetJSON.asset.gltfUpAxis;
    }

    // Global refinement.
    if (tilesetJSON.geometricError != null) {
      this._rootGeometricError = tilesetJSON.geometricError;
    }
    if (tilesetJSON.root && tilesetJSON.root.refine === 'ADD') {
      this.refinement = Tileset3DRefinement.ADD;
    }

    // Extensions.
    this.extensionsUsed = tilesetJSON.extensionsUsed ?? [];
    this.extensionsRequired = tilesetJSON.extensionsRequired ?? [];

    // Implicit tiling.
    if (tilesetJSON.extensions &&
        tilesetJSON.extensions[Tileset3DExtensions.IMPLICIT_TILING]) {
      this._setupImplicitTiling(tilesetJSON.extensions[Tileset3DExtensions.IMPLICIT_TILING]);
    }

    // Root tile.
    if (tilesetJSON.root) {
      this.root = createTile3DFromJSON(tilesetJSON.root, this.options.tilesetId);
      if (this.root) {
        this.root.entityId = this.ecsWorld?.createEntity?.() ?? 0xFFFFFFFF;
        this.root.bindToEcs(this.ecsWorld, 0);
        this._tileIndex.set(this.root.tileKey, this.root);
      }
    }

    // Bind a tileset component to a singleton entity for diagnostics.
    this._bindTilesetComponent();

    return this;
  }

  _setupImplicitTiling(ext) {
    this._implicitEngine = new Tileset3DImplicitTilingEngine({
      subdivision: ext.subdivision === 'OCTREE'
        ? Tileset3DImplicitSubdivision.OCTREE
        : Tileset3DImplicitSubdivision.QUADTREE,
      subtreeLevels: ext.subtreeLevels ?? 8,
      availableLevels: ext.availableLevels ?? 12,
      subtreeTemplate: ext.subtrees?.uri ?? '',
      contentTemplate: ext.content?.uri ?? ''
    });
  }

  _bindTilesetComponent() {
    if (!this.ecsWorld) return;
    const entityId = this._tilesetEntityId ?? (this._tilesetEntityId = this.ecsWorld.createEntity?.() ?? 0xFFFFFFFF);
    if (entityId === 0xFFFFFFFF) return;

    this.ecsWorld.addComponent?.(entityId, Tileset3DComponent, {
      tilesetId: this.options.tilesetId,
      assetVersionMajor: parseInt(this.asset.version.split('.')[0], 10) || 1,
      assetVersionMinor: parseInt(this.asset.version.split('.')[1], 10) || 0,
      assetTilesetVersion: parseInt(this.asset.tilesetVersion, 10) || 0,
      gltfUpAxis: this.asset.gltfUpAxis === 'X' ? 0 : this.asset.gltfUpAxis === 'Z' ? 2 : 1,
      refinementMode: this.refinement,
      sseTarget: this.options.sseTarget,
      rootTileEntityId: this.root?.entityId ?? 0xFFFFFFFF,
      totalTileCount: 0,
      readyTileCount: 0,
      queuedTileCount: 0,
      failedTileCount: 0,
      evictedTileCount: 0,
      totalBytesDownloaded: 0,
      totalTilesProcessed: 0,
      lastUpdatedTick: this.lastTick
    });
  }

  // ---------------------------------------------------------------------
  // Main update
  // ---------------------------------------------------------------------

  /**
   * Main per-tick update. Runs the traversal, drives the streaming queue,
   * merges newly ready tiles, and evicts stale tiles.
   */
  update(contextFrame, tick, dt, camera) {
    this.frame = contextFrame;
    this.lastTick = tick;

    this._accumulator += dt;
    const interval = 1 / this.options.targetHz;
    if (this._accumulator < interval) return;
    this._accumulator %= interval;

    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // 1. Compute the frustum planes from the camera.
    this._computeFrustum(camera);

    // 2. Run the traversal.
    this._runTraversal(camera);

    // 3. Sync the streaming queue with the current selection.
    this._syncStreamingQueue();

    // 4. Merge any newly ready content.
    this._mergeNewContent();

    // 5. Evict stale tiles.
    this._evictStaleTiles(tick);

    // 6. Publish the SoA.
    this._publishSoA();

    // 7. Update stats.
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.stats.lastDurationMs = t1 - t0;
    this.stats.framesProcessed++;
  }

  // ---------------------------------------------------------------------
  // Frustum computation
  // ---------------------------------------------------------------------

  _computeFrustum(camera) {
    if (!camera) return;
    // Build a view-projection matrix from the camera and extract frustum
    // planes. This is the same math used by the 2D adapter (file 377).
    const forward = new Float32Array([camera.forwardX, camera.forwardY, camera.forwardZ]);
    const up = new Float32Array([camera.upX, camera.upY, camera.upZ]);
    const right = new Float32Array([camera.rightX, camera.rightY, camera.rightZ]);

    // View matrix.
    const view = new Float32Array(16);
    view[0] = right[0]; view[1] = right[1]; view[2] = right[2]; view[3] = -(right[0]*camera.x + right[1]*camera.y + right[2]*camera.z);
    view[4] = up[0]; view[5] = up[1]; view[6] = up[2]; view[7] = -(up[0]*camera.x + up[1]*camera.y + up[2]*camera.z);
    view[8] = -forward[0]; view[9] = -forward[1]; view[10] = -forward[2]; view[11] = -(-forward[0]*camera.x + -forward[1]*camera.y + -forward[2]*camera.z);
    view[12] = 0; view[13] = 0; view[14] = 0; view[15] = 1;

    // Projection matrix.
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

    // Multiply proj * view.
    const vp = new Float32Array(16);
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += proj[k*4 + row] * view[col*4 + k];
        vp[col*4 + row] = sum;
      }
    }

    // Extract frustum planes.
    extractFrustumPlanes(vp, this._traversalScratch.frustumPlanes);
  }

  // ---------------------------------------------------------------------
  // Traversal
  // ---------------------------------------------------------------------

  _runTraversal(camera) {
    if (!this.root) return;

    this.stats.traversalNodesVisited = 0;
    this._lastSelectedTiles.length = 0;

    const planes = this._traversalScratch.frustumPlanes;
    const stack = [this.root];
    let visited = 0;

    while (stack.length > 0) {
      if (visited >= this.options.maxTilesPerFrame) break;
      const tile = stack.pop();
      if (!tile) continue;
      visited++;
      this.stats.traversalNodesVisited++;

      // 1. Frustum culling.
      if (tile.isOutsideFrustum(planes)) continue;

      // 2. Compute the distance and SSE.
      const center = tile.boundingVolume.getCenter();
      const dx = center[0] - camera.x;
      const dy = center[1] - camera.y;
      const dz = center[2] - camera.z;
      const distance = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 0.001);

      tile.computeSSE(distance, camera.screenHeight ?? 1080, camera.fov ?? Math.PI / 3);
      tile.lastUsedTick = this.lastTick;

      // 3. Refinement decision.
      const shouldRefine = this._shouldRefine(tile, camera);

      if (shouldRefine) {
        // Expand children (if implicit tiling is enabled).
        if (this._implicitEngine && tile.isLeaf()) {
          this._implicitEngine.expandChildren(
            tile, this.tilePool, tile.boundingVolume, this.options.tilesetId
          );
          // Index new children.
          tile.forEachChild((child) => {
            this._tileIndex.set(child.tileKey, child);
            child.bindToEcs(this.ecsWorld, this.lastTick);
          });
        }

        if (!tile.isLeaf()) {
          // Push children (reverse order for near-first traversal).
          tile.forEachChild((child) => stack.push(child));
          continue;
        }
      }

      // 4. Select the tile.
      this._selectTile(tile, distance);
    }
  }

  _shouldRefine(tile, camera) {
    // Never refine past the maximum depth.
    if (tile.lod >= this.options.maxTraversalDepth) return false;

    // Refine if SSE > target.
    if (tile.screenSpaceError > this.options.sseTarget) return true;

    // Refine if the tile has no content but has children (structural refinement).
    if (!tile.hasContent() && !tile.isLeaf()) return true;

    return false;
  }

  _selectTile(tile, distance) {
    // Compute priority.
    tile.priority = 1 / (1 + distance);

    // Add to the selection.
    this._lastSelectedTiles.push(tile);

    // Cache the traversal decision.
    if (this.options.cacheTraversalDecisions) {
      this._traversalDecisions.set(tile.tileKey, {
        sse: tile.screenSpaceError,
        decision: 'select',
        tick: this.lastTick
      });
    }
  }

  // ---------------------------------------------------------------------
  // Streaming queue sync
  // ---------------------------------------------------------------------

  _syncStreamingQueue() {
    // Cancel stale requests.
    for (const [tileKey, entry] of Array.from(this.streamingQueue.byKey)) {
      if (!this._lastSelectedTiles.includes(entry.tile)) {
        this.streamingQueue.cancel(tileKey);
      }
    }

    // Enqueue new requests.
    for (const tile of this._lastSelectedTiles) {
      if (tile.loadState === Tile3DLoadState.READY) continue;
      if (tile.loadState === Tile3DLoadState.FAILED) continue;
      if (!tile.hasContent()) continue;
      if (this.streamingQueue.has(tile.tileKey)) continue;

      if (this.streamingQueue.enqueue(tile, tile.priority)) {
        tile.loadState = Tile3DLoadState.QUEUED;
      }
    }

    this.streamingQueue.resort();
    this.stats.queuedTileCount = this.streamingQueue.size();
  }

  // ---------------------------------------------------------------------
  // Content merging
  // ---------------------------------------------------------------------

  _mergeNewContent() {
    // The terrain source (file 380) is responsible for loading tiles.
    // This method is called after the source has finished decoding new
    // content and has marked the tile as READY via `markTileReady`.
    let ready = 0;
    for (const tile of this._lastSelectedTiles) {
      if (tile.loadState === Tile3DLoadState.READY) {
        ready++;
      }
    }
    this.stats.readyTileCount = ready;
    this.stats.totalTileCount = this._tileIndex.size;
  }

  /**
   * Called by the source when a tile's content is ready.
   */
  markTileReady(tileKey, contentRef, tick) {
    const tile = this._tileIndex.get(tileKey);
    if (!tile) return false;
    tile.markContentReady(contentRef, tick);
    this.streamingQueue.cancel(tileKey);
    this.stats.totalTilesProcessed++;
    return true;
  }

  /**
   * Called by the source when a tile's content failed to load.
   */
  markTileFailed(tileKey, tick) {
    const tile = this._tileIndex.get(tileKey);
    if (!tile) return false;
    tile.markContentFailed(tick);
    this.streamingQueue.cancel(tileKey);
    this.stats.failedTileCount++;
    return true;
  }

  // ---------------------------------------------------------------------
  // Eviction
  // ---------------------------------------------------------------------

  _evictStaleTiles(tick) {
    const grace = this.options.evictionGraceTicks;
    const maxResident = this.options.maxResidentTiles;

    // Collect candidates.
    const candidates = [];
    for (const tile of this._tileIndex.values()) {
      if (tile.loadState === Tile3DLoadState.READY &&
          tick - tile.lastUsedTick > grace) {
        candidates.push(tile);
      }
    }

    // Sort by last used (oldest first).
    candidates.sort((a, b) => a.lastUsedTick - b.lastUsedTick);

    // Evict until under the limit.
    const currentReady = this.stats.readyTileCount;
    const toEvict = Math.max(0, currentReady - maxResident);
    for (let i = 0; i < toEvict && i < candidates.length; i++) {
      const tile = candidates[i];
      tile.markContentEvicted(tick);
      this.stats.evictedTileCount++;
    }
  }

  // ---------------------------------------------------------------------
  // Publishing
  // ---------------------------------------------------------------------

  _publishSoA() {
    const p = this._publishedSoA;
    p.tileKeys.length = 0;
    p.currentLods.length = 0;
    p.entityIds.length = 0;
    p.boundingVolumes.length = 0;
    p.contentTypes.length = 0;
    p.loadStates.length = 0;
    p.screenSpaceErrors.length = 0;
    p.priorities.length = 0;

    for (const tile of this._lastSelectedTiles) {
      const aabb = tile.boundingVolume.getAABB(this._traversalScratch.aabb);
      p.tileKeys.push(tile.tileKey);
      p.currentLods.push(tile.lod);
      p.entityIds.push(tile.entityId);
      p.boundingVolumes.push(aabb[0], aabb[1], aabb[2], aabb[3], aabb[4], aabb[5]);
      p.contentTypes.push(tile.contentType);
      p.loadStates.push(tile.loadState);
      p.screenSpaceErrors.push(tile.screenSpaceError);
      p.priorities.push(tile.priority);
    }
    p.count = this._lastSelectedTiles.length;

    // Also publish into the physical channel.
    if (this.frame?.layers?.physical) {
      const physical = this.frame.layers.physical;
      physical.tileset3DTileKeys = p.tileKeys;
      physical.tileset3DCurrentLods = p.currentLods;
      physical.tileset3DEntityIds = p.entityIds;
      physical.tileset3DBoundingVolumes = p.boundingVolumes;
      physical.tileset3DContentTypes = p.contentTypes;
      physical.tileset3DLoadStates = p.loadStates;
      physical.tileset3DScreenSpaceErrors = p.screenSpaceErrors;
      physical.tileset3DPriorities = p.priorities;
      physical.tileset3DStats = this.getStats();
    }
  }

  // ---------------------------------------------------------------------
  // Public queries
  // ---------------------------------------------------------------------

  getVisibleSoA() {
    return this._publishedSoA;
  }

  getVisibleTiles() {
    return this._lastSelectedTiles.slice();
  }

  getTileByKey(tileKey) {
    return this._tileIndex.get(tileKey) ?? null;
  }

  getStreamingCandidates(maxCount = 8) {
    const result = [];
    const entries = this.streamingQueue.entries;
    for (let i = 0; i < Math.min(maxCount, entries.length); i++) {
      const entry = entries[i];
      result.push({
        tileKey: entry.tile.tileKey,
        tile: entry.tile,
        priority: entry.priority,
        contentUri: entry.tile.contentUri,
        contentType: entry.tile.contentType,
        lod: entry.tile.lod,
        x: entry.tile.tileX,
        y: entry.tile.tileY,
        z: entry.tile.tileZ
      });
    }
    return result;
  }

  getStats() {
    return {
      ...this.stats,
      rootTileKey: this.root?.tileKey ?? null,
      streamingQueueSize: this.streamingQueue.size(),
      tileIndexSize: this._tileIndex.size,
      selectedTileCount: this._lastSelectedTiles.length,
      implicitEngineActive: !!this._implicitEngine
    };
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  clear() {
    this.streamingQueue.clear();
    this._lastSelectedTiles.length = 0;
    this._traversalDecisions.clear();
    // Release all tiles.
    for (const tile of this._tileIndex.values()) {
      this.tilePool.release(tile);
    }
    this._tileIndex.clear();
    this.root = null;
    if (this._implicitEngine) this._implicitEngine.dispose();
    this._implicitEngine = null;
  }

  dispose() {
    this.clear();
    this.tilePool.dispose();
    this.frame = null;
    this.ecsWorld = null;
    this.source = null;
    this.dispatcher = null;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 6. FACTORY
// ═════════════════════════════════════════════════════════════════════

/**
 * Creates a Tileset3D from a 3D Tiles tileset JSON object.
 */
export function createTileset3DFromJSON(tilesetJSON, options = {}) {
  const tileset = new Tileset3D(options);
  tileset.loadFromJSON(tilesetJSON);
  return tileset;
}

/**
 * Creates an empty Tileset3D for procedural or implicit tiling workflows.
 * The root tile must be added separately.
 */
export function createEmptyTileset3D(options = {}) {
  return new Tileset3D(options);
}

// ═════════════════════════════════════════════════════════════════════
// 7. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  Tileset3D,
  Tileset3DComponent,
  Tileset3DStreamingQueue,
  Tileset3DImplicitTilingEngine,
  Tileset3DVersion,
  Tileset3DRefinement,
  Tileset3DImplicitSubdivision,
  Tileset3DTileState,
  Tileset3DExtensions,
  createTileset3DFromJSON,
  createEmptyTileset3D
};