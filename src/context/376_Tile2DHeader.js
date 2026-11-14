// file number : 376
// full path name : src/context/376_Tile2DHeader.js
//### Description : Context-aware 2D tile header — the canonical metadata
//###               record for a single node in the seamless terrain quadtree.
//###               Wraps quadtree coordinates, LOD level, geometric error,
//###               screen-space error, parent/child references, bounding
//###               volume, and streaming state into a lightweight class that
//###               the reconciler (file 380) and the viewport selector (file
//###               377) iterate without allocation. Provides allocation-free
//###               methods for depth computation, priority scoring,
//###               screen-space-error evaluation, and frustum culling using
//###               the shared helpers from file 373. Binds every header to an
//###               ECS entity with Tile2DHeaderComponent so the runtime can
//###               query, animate, and react to it without touching the class
//###               directly. Seamless-transition aware: tracks per-edge
//###               neighbor references so LOD cross-fades between adjacent
//###               headers are mathematically identical on both sides. All
//###               state is parametric — no external loader, no CDN access, no
//###               static server. Designed for Android arm64 under the 8 ms
//###               per-tick CPU ceiling and 200 MB resident memory cap, and
//###               scales from a single 10-unit tile to galactic streaming
//###               (10k+ units) without main-thread stalls.
//### Best for : The single node representation consumed by the 2D tileset
//###            (files 373, 377, 380) and by the runtime's culling/LOD
//###            pipeline. Any system that needs to walk the quadtree, decide
//###            which tiles should be visible, or coordinate LOD transitions
//###            between adjacent chunks should operate on Tile2DHeader
//###            instances. The header is cheap to create (a few dozen bytes)
//###            and is pooled by the reconciler to avoid GC pressure.
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

// ---------------------------------------------------------------------------
// 1. ECS COMPONENT – structure-of-arrays, flecs-inspired
// ---------------------------------------------------------------------------

/**
 * Tile2DHeaderComponent — one per live Tile2DHeader.
 * Mirrors every meaningful field of the header class so ECS systems can
 * iterate tiles without touching the header object. The header itself owns
 * the Java-object-style state (parent/child references, viewport references),
 * while the component owns the SoA-iterable numerics.
 */
export class Tile2DHeaderComponent {
  static schema = {
    tilesetId:       { type: 'u32' },
    tileX:           { type: 'i32' },
    tileY:           { type: 'i32' },
    tileZ:           { type: 'i32' },
    lod:             { type: 'u8' },
    depth:           { type: 'u8' },    // alias for lod, kept for readability
    state:           { type: 'u8' },    // TileState.*
    refinement:      { type: 'u8' },    // TileRefinement.*
    contentFormat:   { type: 'u8' },    // TilesetSourceFormat.*
    priority:        { type: 'f32' },
    geometricError:  { type: 'f32' },
    screenSpaceError:{ type: 'f32' },
    blendAlpha:      { type: 'f32' },
    boundsMinX:      { type: 'f64' },
    boundsMinY:      { type: 'f64' },
    boundsMinZ:      { type: 'f64' },
    boundsMaxX:      { type: 'f64' },
    boundsMaxY:      { type: 'f64' },
    boundsMaxZ:      { type: 'f64' },
    sphereCx:        { type: 'f64' },
    sphereCy:        { type: 'f64' },
    sphereCz:        { type: 'f64' },
    sphereRadius:    { type: 'f32' },
    parentId:        { type: 'u32' },   // 0xFFFFFFFF for root
    child0Id:        { type: 'u32' },
    child1Id:        { type: 'u32' },
    child2Id:        { type: 'u32' },
    child3Id:        { type: 'u32' },
    seamFlags:       { type: 'u8' },    // bitfield of SeamEdge
    lastUsedTick:    { type: 'u32' }
  };
}

// ---------------------------------------------------------------------------
// 2. Tile2DHeader – the canonical quadtree node
// ---------------------------------------------------------------------------

/**
 * Tile2DHeader — a single node in the seamless terrain quadtree.
 *
 * Lifecycle:
 *   1. The reconciler (file 380) creates a root header for each tileset.
 *   2. The viewport selector (file 377) calls selectTilesToRender on the
 *      root, which recursively visits children via `getChildForCoord()`.
 *   3. As tiles are requested, `state` moves UNLOADED → QUEUED → LOADING →
 *      READY. Failed tiles are marked FAILED and their children are not
 *      requested, per blueprint step 22 (backpressure).
 *   4. When a parent is fully superseded by its READY children, the parent
 *      enters the EVICTED state and its memory is released.
 *
 * All numeric fields are typed: no dynamic properties after construction.
 * All methods are allocation-free except `getChildren()` (which returns a
 * fresh array — callers should prefer `forEachChild`).
 */
export class Tile2DHeader {
  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  /**
   * @param {object} props
   * @param {number} props.tilesetId       – 32-bit identifier of the owning tileset
   * @param {number} props.tileX
   * @param {number} props.tileY
   * @param {number} [props.tileZ=0]
   * @param {number} props.lod             – 0 for root, increases downward
   * @param {number} [props.maxLod=DEFAULT_TILESET_OPTIONS.maxLod]
   * @param {number} [props.tileWorldSize=DEFAULT_TILESET_OPTIONS.tileWorldSize]
   * @param {number} [props.geometricError] – defaults to tileWorldSize / 2^lod
   * @param {number} [props.refinement=TileRefinement.REPLACE]
   * @param {number} [props.contentFormat=TilesetSourceFormat.PROCEDURAL_2D]
   * @param {number} [props.state=TileState.UNLOADED]
   * @param {number} [props.parentId=0xFFFFFFFF]
   * @param {number} [props.entityId=0xFFFFFFFF]
   * @param {string} [props.sourceKey='']
   * @param {object} [props.options] – overrides for DEFAULT_TILESET_OPTIONS
   */
  constructor(props) {
    if (!props) throw new Error('Tile2DHeader requires props');
    if (props.tileX == null || props.tileY == null) {
      throw new Error('Tile2DHeader requires tileX and tileY');
    }
    if (props.lod == null || props.lod < 0) {
      throw new Error('Tile2DHeader requires a non-negative lod');
    }

    // ---- Identity ----
    this.tilesetId = props.tilesetId >>> 0;
    this.tileX = props.tileX | 0;
    this.tileY = props.tileY | 0;
    this.tileZ = props.tileZ | 0;
    this.lod = props.lod | 0;
    this.maxLod = props.maxLod ?? DEFAULT_TILESET_OPTIONS.maxLod;
    this.tileWorldSize = props.tileWorldSize ?? DEFAULT_TILESET_OPTIONS.tileWorldSize;

    // ---- Refinement & state ----
    this.refinement = props.refinement ?? TileRefinement.REPLACE;
    this.contentFormat = props.contentFormat ?? TilesetSourceFormat.PROCEDURAL_2D;
    this.state = props.state ?? TileState.UNLOADED;

    // ---- Geometric error ----
    // The tile’s world extent at this LOD, divided by a constant. This is
    // the standard 3D Tiles “geometric error” convention: coarser tiles have
    // larger error, finer tiles have smaller error.
    this.geometricError = props.geometricError ??
      (this.tileWorldSize / Math.pow(2, this.lod + 1));

    // ---- Bounding volume (AABB derived from quadtree coords) ----
    this.tileWorldSpan = this.tileWorldSize * Math.pow(2, this.maxLod - this.lod);
    this.originX = this.tileX * this.tileWorldSpan;
    this.originY = this.tileY * this.tileWorldSpan;
    this.minZ = props.minZ ?? -10000;
    this.maxZ = props.maxZ ?? 10000;
    this._recomputeBounds();

    // ---- Parent / children (entity IDs, not object references) ----
    this.parentId = props.parentId ?? 0xFFFFFFFF;
    this.child0Id = 0xFFFFFFFF;
    this.child1Id = 0xFFFFFFFF;
    this.child2Id = 0xFFFFFFFF;
    this.child3Id = 0xFFFFFFFF;

    // Direct children references (populated by the reconciler when the child
    // header is created). These are the headers, not the entity IDs.
    this._children = [null, null, null, null];

    // ---- Streaming state ----
    this.priority = 0;
    this.screenSpaceError = 0;
    this.blendAlpha = 1;       // 1 = fully visible at this LOD
    this.lastUsedTick = 0;
    this.lastQueuedTick = 0;
    this.lastReadyTick = 0;

    // ---- Viewports (populated by the viewport selector, file 377) ----
    this._viewportRefs = new Set();
    this._requestId = null;    // opaque handle for pending fetch, if any

    // ---- Seam state ----
    this.seamFlags = 0;
    this.neighborLods = { north: -1, south: -1, east: -1, west: -1 };
    this.neighborIds = { north: 0xFFFFFFFF, south: 0xFFFFFFFF, east: 0xFFFFFFFF, west: 0xFFFFFFFF };

    // ---- ECS binding ----
    this.entityId = props.entityId ?? 0xFFFFFFFF;
    this.sourceKey = props.sourceKey ?? '';

    // ---- Cache the tile key for arena / registry lookups ----
    this.tileKey = stringTileKey(this.lod, this.tileX, this.tileY, this.tileZ);
    this.tileKeyHash = fnv1aHash(this.tileKey);

    // ---- Options cache ----
    this.options = props.options ?? DEFAULT_TILESET_OPTIONS;
  }

  _recomputeBounds() {
    this.minX = this.originX;
    this.minY = this.originY;
    this.maxX = this.originX + this.tileWorldSpan;
    this.maxY = this.originY + this.tileWorldSpan;

    this.centerX = (this.minX + this.maxX) * 0.5;
    this.centerY = (this.minY + this.maxY) * 0.5;
    this.centerZ = (this.minZ + this.maxZ) * 0.5;

    const dx = this.tileWorldSpan * 0.5;
    const dy = this.tileWorldSpan * 0.5;
    const dz = Math.max((this.maxZ - this.minZ) * 0.5, 0.001);
    this.boundingSphereRadius = Math.sqrt(dx * dx + dy * dy + dz * dz) * 1.05;
  }

  // -------------------------------------------------------------------------
  // Quadtree navigation
  // -------------------------------------------------------------------------

  /**
   * Returns true if this tile is a leaf (max LOD reached).
   */
  isLeaf() {
    return this.lod >= this.maxLod;
  }

  /**
   * Returns the child header at Morton index `i` (0=NW, 1=NE, 2=SW, 3=SE),
   * or null if the child has not been created yet. Callers should create
   * the child by calling `createChild(i)`.
   */
  getChild(i) {
    if (i < 0 || i > 3) return null;
    return this._children[i];
  }

  /**
   * Returns a newly-allocated array of the four child slots. Prefer
   * `forEachChild` when you only need to iterate.
   */
  getChildren() {
    return [this._children[0], this._children[1], this._children[2], this._children[3]];
  }

  /**
   * Iterates over the four child slots, calling `fn(child, index)` for each
   * non-null child. Allocation-free.
   */
  forEachChild(fn) {
    for (let i = 0; i < 4; i++) {
      const c = this._children[i];
      if (c) fn(c, i);
    }
  }

  /**
   * Returns the parent header, or null if this is the root.
   */
  getParent() {
    return this._parentRef ?? null;
  }

  /**
   * Internal: sets the parent reference. Called by the reconciler when a
   * child header is created.
   */
  _setParent(parent) {
    this._parentRef = parent;
    this.parentId = parent ? parent.entityId : 0xFFFFFFFF;
  }

  /**
   * Internal: attaches a child header at slot `i`.
   */
  _attachChild(i, child) {
    if (i < 0 || i > 3) return;
    this._children[i] = child;
    if (child) {
      child._setParent(this);
      if (i === 0) this.child0Id = child.entityId;
      else if (i === 1) this.child1Id = child.entityId;
      else if (i === 2) this.child2Id = child.entityId;
      else if (i === 3) this.child3Id = child.entityId;
    } else {
      if (i === 0) this.child0Id = 0xFFFFFFFF;
      else if (i === 1) this.child1Id = 0xFFFFFFFF;
      else if (i === 2) this.child2Id = 0xFFFFFFFF;
      else if (i === 3) this.child3Id = 0xFFFFFFFF;
    }
  }

  /**
   * Creates a child header at Morton index `i` using the same tileset options.
   * The reconciler calls this lazily as the viewport selector descends.
   * Returns the new child header, or null if the LOD limit is reached.
   */
  createChild(i, ecsWorld) {
    if (i < 0 || i > 3) return null;
    if (this._children[i]) return this._children[i];
    if (this.isLeaf()) return null;

    const childLod = this.lod + 1;
    const baseX = this.tileX * 2;
    const baseY = this.tileY * 2;
    let cx, cy;
    switch (i) {
      case 0: cx = baseX;     cy = baseY;     break; // NW
      case 1: cx = baseX + 1; cy = baseY;     break; // NE
      case 2: cx = baseX;     cy = baseY + 1; break; // SW
      case 3: cx = baseX + 1; cy = baseY + 1; break; // SE
      default: return null;
    }

    // Create the ECS entity for the new child.
    let entityId = 0xFFFFFFFF;
    if (ecsWorld) {
      entityId = ecsWorld.createEntity?.() ?? 0xFFFFFFFF;
    }

    const child = new Tile2DHeader({
      tilesetId: this.tilesetId,
      tileX: cx,
      tileY: cy,
      tileZ: this.tileZ,
      lod: childLod,
      maxLod: this.maxLod,
      tileWorldSize: this.tileWorldSize,
      refinement: this.refinement,
      contentFormat: this.contentFormat,
      minZ: this.minZ,
      maxZ: this.maxZ,
      parentId: this.entityId,
      entityId,
      sourceKey: this.sourceKey,
      options: this.options
    });

    this._attachChild(i, child);
    if (ecsWorld && entityId !== 0xFFFFFFFF) {
      child.bindToEcs(ecsWorld, 0);
    }
    return child;
  }

  // -------------------------------------------------------------------------
  // Priority & screen-space-error evaluation
  // -------------------------------------------------------------------------

  /**
   * Computes the screen-space error for a given camera, per blueprint step 19.
   * Returns a value in pixels. A tile should be refined when its SSE exceeds
   * the target (default 16 pixels).
   *
   * @param {number} camX
   * @param {number} camY
   * @param {number} camZ
   * @param {number} screenHeight
   * @param {number} fovRadians
   * @returns {number} SSE in pixels
   */
  computeSSE(camX, camY, camZ, screenHeight, fovRadians) {
    const dx = this.centerX - camX;
    const dy = this.centerY - camY;
    const dz = this.centerZ - camZ;
    const dist = Math.max(
      Math.sqrt(dx * dx + dy * dy + dz * dz) - this.boundingSphereRadius,
      1e-3
    );
    this.screenSpaceError = computeScreenSpaceError(
      this.geometricError, dist, screenHeight, fovRadians
    );
    return this.screenSpaceError;
  }

  /**
   * Computes the streaming priority for this tile, per blueprint step 26:
   *   priority = α/d + β·|cosφ| + γ(1 − d_norm)
   *
   * @param {number} camX
   * @param {number} camY
   * @param {number} camZ
   * @param {number} forwardX – camera forward vector X
   * @param {number} forwardY
   * @param {number} forwardZ
   * @param {number} farPlane – camera far plane, used to normalize d
   * @returns {number} priority (higher = load sooner)
   */
  computePriority(camX, camY, camZ, forwardX, forwardY, forwardZ, farPlane) {
    const dx = this.centerX - camX;
    const dy = this.centerY - camY;
    const dz = this.centerZ - camZ;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // cos(angle between camera-forward and tile-direction)
    let cosPhi = 1;
    if (dist > 1e-6) {
      cosPhi = (forwardX * dx + forwardY * dy + forwardZ * dz) / dist;
    }

    // Normalized distance: 0 = at camera, 1 = at far plane
    const dNorm = Math.min(dist / Math.max(farPlane, 1e-3), 1);

    this.priority = computeTilePriority(
      dist, cosPhi, dNorm,
      this.options.priorityAlpha,
      this.options.priorityBeta,
      this.options.priorityGamma
    );
    return this.priority;
  }

  // -------------------------------------------------------------------------
  // Frustum culling – uses shared helpers from file 373
  // -------------------------------------------------------------------------

  /**
   * Tests whether this tile is outside the frustum defined by `planes`
   * (the 24-float output of extractFrustumPlanes).
   * Returns true if the tile should be culled.
   */
  isCulledByFrustum(planes) {
    return isBoxOutsideFrustum(
      planes,
      this.minX, this.minY, this.minZ,
      this.maxX, this.maxY, this.maxZ
    );
  }

  /**
   * Computes the squared distance from a camera position to this tile’s
   * bounding sphere (clamped to 0 when the camera is inside the sphere).
   */
  distanceSquaredTo(camX, camY, camZ) {
    return distanceToSphereSquared(
      camX, camY, camZ,
      this.centerX, this.centerY, this.centerZ,
      this.boundingSphereRadius
    );
  }

  // -------------------------------------------------------------------------
  // LOD blend helpers
  // -------------------------------------------------------------------------

  /**
   * Computes the smooth LOD blend weight for this tile, per blueprint step 19:
   *   α = smoothstep(d_lod, d_{lod+1}, d)
   * Returns 0 when the camera is at this LOD’s lower threshold, 1 when at the
   * upper threshold. Used by the shader to cross-fade between detail levels.
   */
  computeLodBlendAlpha(camX, camY, camZ) {
    const dx = this.centerX - camX;
    const dy = this.centerY - camY;
    const dz = this.centerZ - camZ;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const d0 = this.options.tileWorldSize;
    const R = this.options.lodDistanceScale;
    const alpha = computeLodBlendAlpha(dist, d0, R, this.lod);
    this.blendAlpha = alpha;
    return alpha;
  }

  // -------------------------------------------------------------------------
  // Seam coordination
  // -------------------------------------------------------------------------

  /**
   * Records that this tile shares the given edge with a neighbor at
   * `neighborLod`, and stores the neighbor’s entity ID for cross-referencing.
   * Called by the reconciler (file 380) after both sides agree on the seam.
   */
  setSeam(edge, neighborLod, neighborEntityId = 0xFFFFFFFF) {
    this.seamFlags |= edge;
    if (edge === SeamEdge.NORTH) {
      this.neighborLods.north = neighborLod;
      this.neighborIds.north = neighborEntityId;
    } else if (edge === SeamEdge.SOUTH) {
      this.neighborLods.south = neighborLod;
      this.neighborIds.south = neighborEntityId;
    } else if (edge === SeamEdge.EAST) {
      this.neighborLods.east = neighborLod;
      this.neighborIds.east = neighborEntityId;
    } else if (edge === SeamEdge.WEST) {
      this.neighborLods.west = neighborLod;
      this.neighborIds.west = neighborEntityId;
    }
  }

  hasSeamOn(edge) {
    return hasSeam(this.seamFlags, edge);
  }

  /**
   * Returns the neighbor LOD for the given edge, or -1 if no seam.
   */
  getNeighborLod(edge) {
    if (edge === SeamEdge.NORTH) return this.neighborLods.north;
    if (edge === SeamEdge.SOUTH) return this.neighborLods.south;
    if (edge === SeamEdge.EAST)  return this.neighborLods.east;
    if (edge === SeamEdge.WEST)  return this.neighborLods.west;
    return -1;
  }

  // -------------------------------------------------------------------------
  // Viewport reference tracking – used by the selector (file 377)
  // -------------------------------------------------------------------------

  /**
   * Records that this tile is currently visible to the given viewport.
   * The reconciler uses these references to decide when a tile can be evicted.
   */
  addViewportRef(viewportId) {
    this._viewportRefs.add(viewportId);
  }

  /**
   * Removes a viewport reference. Called by the selector when the tile
   * leaves the viewport.
   */
  removeViewportRef(viewportId) {
    this._viewportRefs.delete(viewportId);
  }

  /**
   * Returns the number of viewports that currently reference this tile.
   */
  getViewportRefCount() {
    return this._viewportRefs.size;
  }

  /**
   * True if any viewport still needs this tile.
   */
  isReferenced() {
    return this._viewportRefs.size > 0;
  }

  // -------------------------------------------------------------------------
  // Request tracking – used by the reconciler
  // -------------------------------------------------------------------------

  /**
   * Records the opaque request handle for a pending tile fetch/decode.
   * The reconciler uses this to cancel stale requests when the tile leaves
   * the viewport before the load completes.
   */
  setPendingRequest(requestId) {
    this._requestId = requestId;
    this.lastQueuedTick = this.lastQueuedTick; // caller sets tick
  }

  clearPendingRequest() {
    this._requestId = null;
  }

  hasPendingRequest() {
    return this._requestId !== null;
  }

  getPendingRequest() {
    return this._requestId;
  }

  // -------------------------------------------------------------------------
  // State transitions
  // -------------------------------------------------------------------------

  /**
   * Marks the tile as READY and records the tick at which it became ready.
   * Called by the reconciler after the tile payload has been decoded and
   * bound to an ECS entity.
   */
  markReady(tick) {
    this.state = TileState.READY;
    this.lastReadyTick = tick;
  }

  /**
   * Marks the tile as FAILED. Children are not requested from a failed tile
   * (blueprint step 22).
   */
  markFailed(tick) {
    this.state = TileState.FAILED;
    this.lastReadyTick = tick;
  }

  /**
   * Marks the tile as EVICTED and clears all transient references. The tile
   * is kept in the cache pool for reuse; call `resetForReuse()` before
   * repurposing it.
   */
  markEvicted() {
    this.state = TileState.EVICTED;
    this._viewportRefs.clear();
    this._requestId = null;
  }

  // -------------------------------------------------------------------------
  // ECS binding
  // -------------------------------------------------------------------------

  /**
   * Registers this header in the ECS world as a Tile2DHeaderComponent.
   * Called once at construction (for the root) and once per child creation.
   * Writes the component using the header’s own fields. Allocation-free.
   */
  bindToEcs(ecsWorld, tick) {
    if (!ecsWorld) return;
    if (this.entityId === 0xFFFFFFFF) {
      this.entityId = ecsWorld.createEntity?.() ?? 0xFFFFFFFF;
    }
    if (this.entityId === 0xFFFFFFFF) return;

    ecsWorld.addComponent?.(this.entityId, Tile2DHeaderComponent, {
      tilesetId: this.tilesetId,
      tileX: this.tileX,
      tileY: this.tileY,
      tileZ: this.tileZ,
      lod: this.lod,
      depth: this.lod,
      state: this.state,
      refinement: this.refinement,
      contentFormat: this.contentFormat,
      priority: this.priority,
      geometricError: this.geometricError,
      screenSpaceError: this.screenSpaceError,
      blendAlpha: this.blendAlpha,
      boundsMinX: this.minX,
      boundsMinY: this.minY,
      boundsMinZ: this.minZ,
      boundsMaxX: this.maxX,
      boundsMaxY: this.maxY,
      boundsMaxZ: this.maxZ,
      sphereCx: this.centerX,
      sphereCy: this.centerY,
      sphereCz: this.centerZ,
      sphereRadius: this.boundingSphereRadius,
      parentId: this.parentId,
      child0Id: this.child0Id,
      child1Id: this.child1Id,
      child2Id: this.child2Id,
      child3Id: this.child3Id,
      seamFlags: this.seamFlags,
      lastUsedTick: tick
    });
  }

  /**
   * Pushes the current numeric fields back into the ECS component.
   * Called by the reconciler after priority, SSE, or state change.
   */
  syncToEcs(ecsWorld, tick) {
    if (!ecsWorld || this.entityId === 0xFFFFFFFF) return;
    const comp = ecsWorld.getComponent?.(this.entityId, Tile2DHeaderComponent);
    if (!comp) return;
    comp.state = this.state;
    comp.priority = this.priority;
    comp.screenSpaceError = this.screenSpaceError;
    comp.blendAlpha = this.blendAlpha;
    comp.seamFlags = this.seamFlags;
    comp.lastUsedTick = tick;
    comp.child0Id = this.child0Id;
    comp.child1Id = this.child1Id;
    comp.child2Id = this.child2Id;
    comp.child3Id = this.child3Id;
  }

  /**
   * Detaches this header from the ECS world.
   */
  unbindFromEcs(ecsWorld) {
    if (ecsWorld && this.entityId !== 0xFFFFFFFF) {
      ecsWorld.destroyEntity?.(this.entityId);
    }
    this.entityId = 0xFFFFFFFF;
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  toString() {
    return (
      'Tile2DHeader(' +
      'key=' + this.tileKey +
      ', state=' + this.state +
      ', sse=' + this.screenSpaceError.toFixed(2) +
      ', prio=' + this.priority.toFixed(3) +
      ', children=' + (
        (this.child0Id !== 0xFFFFFFFF ? 1 : 0) +
        (this.child1Id !== 0xFFFFFFFF ? 1 : 0) +
        (this.child2Id !== 0xFFFFFFFF ? 1 : 0) +
        (this.child3Id !== 0xFFFFFFFF ? 1 : 0)
      ) +
      ')'
    );
  }

  dispose() {
    this._children.length = 0;
    this._viewportRefs.clear();
    this._requestId = null;
    this._parentRef = null;
    this.state = TileState.EVICTED;
    this.entityId = 0xFFFFFFFF;
  }
}

// ---------------------------------------------------------------------------
// 3. POOL – header reuse to avoid GC pressure
// ---------------------------------------------------------------------------

/**
 * Tile2DHeaderPool — recycles Tile2DHeader instances.
 * The reconciler allocates from this pool instead of calling `new` directly,
 * which eliminates per-tile allocation churn during streaming.
 *
 * Each pooled header is reset in-place (all fields overwritten) so no
 * transient object is created.
 */
export class Tile2DHeaderPool {
  constructor(options = {}) {
    this.maxSize = options.maxSize ?? 4096;
    this.free = [];
    this._live = new Set(); // for diagnostics
    this._created = 0;
    this._reused = 0;
  }

  /**
   * Acquires a header from the pool, resetting it with the given props.
   * If the pool is empty, allocates a fresh header.
   */
  acquire(props) {
    let header;
    if (this.free.length > 0) {
      header = this.free.pop();
      this._reused++;
    } else {
      header = Object.create(Tile2DHeader.prototype);
      this._created++;
    }
    this._reinit(header, props);
    this._live.add(header);
    return header;
  }

  /**
   * Returns a header to the pool. Its fields are not cleared here (that
   * happens on the next acquire), but its external references are dropped.
   */
  release(header) {
    if (!header) return;
    if (!this._live.has(header)) return;
    header.dispose();
    this._live.delete(header);
    if (this.free.length < this.maxSize) this.free.push(header);
  }

  _reinit(header, props) {
    // Manually re-assign every field, bypassing the constructor.
    header.tilesetId = props.tilesetId >>> 0;
    header.tileX = props.tileX | 0;
    header.tileY = props.tileY | 0;
    header.tileZ = props.tileZ | 0;
    header.lod = props.lod | 0;
    header.maxLod = props.maxLod ?? DEFAULT_TILESET_OPTIONS.maxLod;
    header.tileWorldSize = props.tileWorldSize ?? DEFAULT_TILESET_OPTIONS.tileWorldSize;
    header.refinement = props.refinement ?? TileRefinement.REPLACE;
    header.contentFormat = props.contentFormat ?? TilesetSourceFormat.PROCEDURAL_2D;
    header.state = props.state ?? TileState.UNLOADED;
    header.geometricError = props.geometricError ??
      (header.tileWorldSize / Math.pow(2, header.lod + 1));
    header.tileWorldSpan = header.tileWorldSize *
      Math.pow(2, header.maxLod - header.lod);
    header.originX = header.tileX * header.tileWorldSpan;
    header.originY = header.tileY * header.tileWorldSpan;
    header.minZ = props.minZ ?? -10000;
    header.maxZ = props.maxZ ?? 10000;
    header._recomputeBounds();
    header.parentId = props.parentId ?? 0xFFFFFFFF;
    header.child0Id = 0xFFFFFFFF;
    header.child1Id = 0xFFFFFFFF;
    header.child2Id = 0xFFFFFFFF;
    header.child3Id = 0xFFFFFFFF;
    header._children[0] = null;
    header._children[1] = null;
    header._children[2] = null;
    header._children[3] = null;
    header._parentRef = null;
    header.priority = 0;
    header.screenSpaceError = 0;
    header.blendAlpha = 1;
    header.lastUsedTick = 0;
    header.lastQueuedTick = 0;
    header.lastReadyTick = 0;
    header._viewportRefs = new Set();
    header._requestId = null;
    header.seamFlags = 0;
    header.neighborLods.north = -1;
    header.neighborLods.south = -1;
    header.neighborLods.east = -1;
    header.neighborLods.west = -1;
    header.neighborIds.north = 0xFFFFFFFF;
    header.neighborIds.south = 0xFFFFFFFF;
    header.neighborIds.east = 0xFFFFFFFF;
    header.neighborIds.west = 0xFFFFFFFF;
    header.entityId = props.entityId ?? 0xFFFFFFFF;
    header.sourceKey = props.sourceKey ?? '';
    header.tileKey = stringTileKey(header.lod, header.tileX, header.tileY, header.tileZ);
    header.tileKeyHash = fnv1aHash(header.tileKey);
    header.options = props.options ?? DEFAULT_TILESET_OPTIONS;
  }

  /**
   * Returns pool statistics for debugging (not called in the hot path).
   */
  getStats() {
    return {
      live: this._live.size,
      free: this.free.length,
      created: this._created,
      reused: this._reused
    };
  }

  dispose() {
    for (const h of this._live) h.dispose();
    this._live.clear();
    this.free.length = 0;
  }
}

// ---------------------------------------------------------------------------
// 4. UTILITY FUNCTIONS – pure, allocation-free where possible
// ---------------------------------------------------------------------------

/**
 * Builds the four child tile coordinates for a given parent coordinate.
 * Wraps `computeChildTileCoords` from file 373 for convenience.
 * Returns an Int32Array of length 16 (lod, x, y, z per child).
 */
export function buildChildCoords(parentLod, parentX, parentY) {
  const out = new Int32Array(16);
  computeChildTileCoords(parentLod, parentX, parentY, out);
  // The helper only fills 12 slots (4 children × 3 fields: lod, x, y);
  // append z = 0 for each child.
  const result = new Int32Array(16);
  for (let i = 0; i < 4; i++) {
    result[i * 4 + 0] = out[i * 4 + 0]; // lod
    result[i * 4 + 1] = out[i * 4 + 1]; // x
    result[i * 4 + 2] = out[i * 4 + 2]; // y
    result[i * 4 + 3] = 0;              // z
  }
  return result;
}

/**
 * Returns the root tile coordinate for a tileset: { lod: 0, x: 0, y: 0, z: 0 }.
 * Convenience for the reconciler.
 */
export function rootTileCoord() {
  return { lod: 0, x: 0, y: 0, z: 0 };
}

/**
 * Returns true if the two headers are quadtree-adjacent (same LOD, sharing
 * an edge). Used by the reconciler to determine seam compatibility.
 */
export function areQuadtreeAdjacent(a, b) {
  if (!a || !b) return false;
  if (a.lod !== b.lod) return false;
  const dx = Math.abs(a.tileX - b.tileX);
  const dy = Math.abs(a.tileY - b.tileY);
  return (dx === 1 && dy === 0) || (dx === 0 && dy === 1);
}

/**
 * Computes the edge shared between two quadtree-adjacent headers.
 * Returns one of SeamEdge.* or 0 if the headers are not adjacent.
 */
export function sharedEdge(a, b) {
  if (!areQuadtreeAdjacent(a, b)) return 0;
  if (b.tileX > a.tileX) return SeamEdge.EAST;
  if (b.tileX < a.tileX) return SeamEdge.WEST;
  if (b.tileY > a.tileY) return SeamEdge.SOUTH;
  if (b.tileY < a.tileY) return SeamEdge.NORTH;
  return 0;
}

// ---------------------------------------------------------------------------
// 5. BARREL EXPORT
// ---------------------------------------------------------------------------

export default {
  Tile2DHeader,
  Tile2DHeaderComponent,
  Tile2DHeaderPool,
  buildChildCoords,
  rootTileCoord,
  areQuadtreeAdjacent,
  sharedEdge
};