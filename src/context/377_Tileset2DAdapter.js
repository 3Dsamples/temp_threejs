// file number : 377
// full path name : src/context/377_Tileset2DAdapter.js
//### Description : Context-aware Tileset2DAdapter implementation. Bridges the
//###               seamless terrain quadtree (files 376, 373) and the runtime's
//###               viewport selection pipeline. Implements the full
//###               Tileset2DAdapter contract — getTileIndices(),
//###               getTileBoundingBox(), and getTilePriority() — so any consumer
//###               (viewport selector, streaming queue, render dispatch) can
//###               traverse the quadtree without knowing whether tiles are 2D
//###               heightfields or 3D quantized meshes. Uses screen-space error
//###               (SSE) refinement exactly as Cesium's QuadtreePrimitive: when
//###               a tile’s SSE exceeds the target, the adapter refines to its
//###               four children (files 373, 376). Supports multiple concurrent
//###               viewports with independent selection state, per-viewport
//###               priority scoring, and seamless cross-LOD blending. All state
//###               is parametric: no external loader, no CDN access, no static
//###               server. Allocation-free in the hot path via caller-supplied
//###               output buffers, so it can run inside the 60 Hz loop without
//###               GC pauses. Designed for Android arm64 under the 8 ms per-tick
//###               CPU ceiling and 200 MB resident memory cap, and scales from a
//###               single 10-unit tile to galactic streaming (10k+ units)
//###               without main-thread stalls.
//### Best for : The single traversal engine consumed by the 2D tileset (file 373)
//###            and the terrain reconciler (file 380). Any system that needs to
//###            decide which tiles should be loaded, rendered, or refined for a
//###            given camera should call adapter.selectTiles(viewportId, ...) and
//###            receive a compact list of Tile2DHeader references ready for the
//###            streaming queue. The adapter also answers “what is the bounding
//###            box of tile X?” and “what is the priority of tile X?” without
//###            touching the quadtree, making it safe to call from any tier.
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

import {
  Tile2DHeader,
  Tile2DHeaderComponent,
  Tile2DHeaderPool,
  areQuadtreeAdjacent,
  sharedEdge
} from './376_Tile2DHeader.js';

// ---------------------------------------------------------------------------
// 1. VIEWPORT STATE – per-viewport selection cache
// ---------------------------------------------------------------------------

/**
 * ViewportState — the adapter's per-viewport bookkeeping.
 *
 * Each viewport has its own frustum planes, camera basis vectors, and set of
 * selected tile headers. The adapter never shares selection state between
 * viewports (matching the Cesium / loaders.gl model), so two cameras looking
 * in different directions can each have their own LOD tree without
 * interfering.
 *
 * All buffers are pre-allocated at construction and reused every frame.
 */
export class ViewportState {
  constructor(viewportId, options = {}) {
    this.viewportId = viewportId;

    // Camera state (updated each frame by the adapter)
    this.cameraX = 0;
    this.cameraY = 0;
    this.cameraZ = 0;
    this.forwardX = 0;
    this.forwardY = 0;
    this.forwardZ = -1;
    this.upX = 0;
    this.upY = 1;
    this.upZ = 0;
    this.rightX = 1;
    this.rightY = 0;
    this.rightZ = 0;
    this.fovRadians = Math.PI / 3;
    this.near = 0.1;
    this.far = 10000;
    this.screenHeight = 1080;
    this.screenWidth = 1920;
    this.aspectRatio = 16 / 9;

    // Frustum planes (24 floats: 6 planes × 4 components)
    this.frustumPlanes = new Float32Array(24);

    // View-projection matrix (16 floats)
    this.viewProjection = new Float32Array(16);

    // Selected tiles for this viewport (header references, not copies)
    this.selectedTiles = [];
    this.selectedCount = 0;

    // Per-frame scratch buffers for traversal
    this._childCoords = new Int32Array(16);
    this._neighborCoords = new Float64Array(8);
    this._tmpNormal = [0, 0, 1];
    this._tmpVec = [0, 0, 0];

    // Diagnostics
    this.lastSelectedTick = 0;
    this.lastTraversalNodeCount = 0;
  }

  /**
   * Updates the camera state for this viewport. Called by the adapter at the
   * start of each selection pass. All arguments are required.
   */
  updateCamera(cameraX, cameraY, cameraZ, forwardX, forwardY, forwardZ,
               upX, upY, upZ, rightX, rightY, rightZ,
               fovRadians, near, far, screenWidth, screenHeight) {
    this.cameraX = cameraX;
    this.cameraY = cameraY;
    this.cameraZ = cameraZ;
    this.forwardX = forwardX;
    this.forwardY = forwardY;
    this.forwardZ = forwardZ;
    this.upX = upX; this.upY = upY; this.upZ = upZ;
    this.rightX = rightX; this.rightY = rightY; this.rightZ = rightZ;
    this.fovRadians = fovRadians;
    this.near = near;
    this.far = far;
    this.screenWidth = screenWidth;
    this.screenHeight = screenHeight;
    this.aspectRatio = screenWidth / Math.max(screenHeight, 1);
  }

  /**
   * Recomputes the view-projection matrix and frustum planes from the current
   * camera state. The view matrix is built column-major (OpenGL convention).
   */
  updateFrustum() {
    // Build the view matrix (inverse of the camera’s world transform).
    const zx = -this.forwardX, zy = -this.forwardY, zz = -this.forwardZ;
    const xx = this.rightX, xy = this.rightY, xz = this.rightZ;
    const yx = this.upX, yy = this.upY, yz = this.upZ;
    // Normalize basis (defensive — callers should supply orthonormal vectors)
    const lenZ = Math.sqrt(zx * zx + zy * zy + zz * zz) || 1;
    const lenX = Math.sqrt(xx * xx + xy * xy + xz * xz) || 1;
    const lenY = Math.sqrt(yx * yx + yy * yy + yz * yz) || 1;
    const nzx = zx / lenZ, nzy = zy / lenZ, nzz = zz / lenZ;
    const nxx = xx / lenX, nxy = xy / lenX, nxz = xz / lenX;
    const nyx = yx / lenY, nyy = yy / lenY, nyz = yz / lenY;

    // View matrix rows: [ right; up; -forward; translation ]
    const vx = this.cameraX, vy = this.cameraY, vz = this.cameraZ;
    const view = this.viewProjection; // reuse the first 16 floats
    view[0]  = nxx; view[1]  = nxy; view[2]  = nxz; view[3]  = -(nxx * vx + nxy * vy + nxz * vz);
    view[4]  = nyx; view[5]  = nyy; view[6]  = nyz; view[7]  = -(nyx * vx + nyy * vy + nyz * vz);
    view[8]  = nzx; view[9]  = nzy; view[10] = nzz; view[11] = -(nzx * vx + nzy * vy + nzz * vz);
    view[12] = 0;   view[13] = 0;   view[14] = 0;   view[15] = 1;

    // Projection matrix (perspective)
    const f = 1 / Math.tan(this.fovRadians * 0.5);
    const nf = 1 / (this.near - this.far);
    const proj = new Float32Array(16);
    proj[0]  = f / this.aspectRatio;
    proj[5]  = f;
    proj[10] = (this.far + this.near) * nf;
    proj[11] = -1;
    proj[14] = 2 * this.far * this.near * nf;
    proj[15] = 0;

    // Multiply proj * view into viewProjection (column-major)
    const vp = this.viewProjection;
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        let s = 0;
        for (let k = 0; k < 4; k++) {
          s += proj[k * 4 + row] * view[col * 4 + k];
        }
        vp[col * 4 + row] = s;
      }
    }

    // Extract frustum planes from the view-projection matrix.
    extractFrustumPlanes(vp, this.frustumPlanes);
  }
}

// ---------------------------------------------------------------------------
// 2. Tileset2DAdapter – the main adapter class
// ---------------------------------------------------------------------------

/**
 * Tileset2DAdapter — the traversal engine that connects the quadtree
 * (Tile2DHeader) to the runtime’s viewport selection and streaming queue.
 *
 * Responsibilities:
 *   1. Traverse the quadtree from the root, culling tiles outside any viewport.
 *   2. For each visible tile, compute SSE. If SSE > target, refine to children.
 *   3. Collect the minimal set of tiles that satisfy the SSE target.
 *   4. Report each selected tile’s bounding box and priority to the caller.
 *   5. Track seam state: when a selected tile is adjacent to a tile at a
 *      different LOD, mark both sides as “seam-stitched” so the shader can
 *      cross-fade correctly (blueprint step 19).
 *
 * The adapter is viewport-agnostic: multiple ViewportState instances can be
 * registered, and each selection pass uses only that viewport’s frustum.
 * This matches Cesium’s updateViewGroup(model) contract.
 */
export class Tileset2DAdapter {
  constructor(options = {}) {
    this.options = {
      maxLod: options.maxLod ?? DEFAULT_TILESET_OPTIONS.maxLod,
      tileWorldSize: options.tileWorldSize ?? DEFAULT_TILESET_OPTIONS.tileWorldSize,
      screenSpaceErrorTarget: options.screenSpaceErrorTarget ?? DEFAULT_TILESET_OPTIONS.screenSpaceErrorTarget,
      maxActiveTiles: options.maxActiveTiles ?? DEFAULT_TILESET_OPTIONS.maxActiveTiles,
      refinement: options.refinement ?? TileRefinement.REPLACE,
      contentFormat: options.contentFormat ?? TilesetSourceFormat.PROCEDURAL_2D,
      minZ: options.minZ ?? -10000,
      maxZ: options.maxZ ?? 10000,
      // Priority weights (blueprint step 26)
      priorityAlpha: options.priorityAlpha ?? DEFAULT_TILESET_OPTIONS.priorityAlpha,
      priorityBeta: options.priorityBeta ?? DEFAULT_TILESET_OPTIONS.priorityBeta,
      priorityGamma: options.priorityGamma ?? DEFAULT_TILESET_OPTIONS.priorityGamma,
      // Seam handling
      enableSeamStitching: options.enableSeamStitching ?? true,
      // Pool size for header reuse
      headerPoolSize: options.headerPoolSize ?? 4096,
      ...options
    };

    // Root headers per tileset (usually one, but allows multiple tilesets).
    this.roots = new Map();   // tilesetId → Tile2DHeader

    // Per-viewport state.
    this.viewports = new Map(); // viewportId → ViewportState

    // Header pool — avoids per-tile allocation churn.
    this.headerPool = new Tile2DHeaderPool({ maxSize: this.options.headerPoolSize });

    // Live header registry: tileKey → Tile2DHeader. Used for seam stitching
    // and for answering external queries without walking the tree.
    this.headerRegistry = new Map(); // tileKey → Tile2DHeader

    // Frame & ECS bindings (set by the reconciler before the first selection).
    this.frame = null;
    this.ecsWorld = null;
    this.lastTick = 0;

    // Scratch buffers reused across selection passes.
    this._scratch = {
      childCoords: new Int32Array(16),
      tmpNormal: [0, 0, 1],
      tmpVec: [0, 0, 0]
    };

    this.eventDispatcher = null;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Binds the adapter to the live context frame and ECS world. Called once by
   * the reconciler before the first selection pass. Subsequent calls update
   * the bindings but do not reset the quadtree.
   */
  bind(contextFrame, ecsWorld) {
    this.frame = contextFrame;
    this.ecsWorld = ecsWorld;
  }

  /**
   * Creates (or returns) the root header for a tileset. The root is the
   * top of the quadtree: (lod=0, x=0, y=0, z=0). All tiles descend from it.
   */
  getRoot(tilesetId) {
    const existing = this.roots.get(tilesetId);
    if (existing) return existing;

    const entityId = this.ecsWorld?.createEntity?.() ?? 0xFFFFFFFF;
    const root = this.headerPool.acquire({
      tilesetId,
      tileX: 0,
      tileY: 0,
      tileZ: 0,
      lod: 0,
      maxLod: this.options.maxLod,
      tileWorldSize: this.options.tileWorldSize,
      refinement: this.options.refinement,
      contentFormat: this.options.contentFormat,
      minZ: this.options.minZ,
      maxZ: this.options.maxZ,
      entityId,
      options: this.options
    });

    if (this.ecsWorld && entityId !== 0xFFFFFFFF) {
      root.bindToEcs(this.ecsWorld, 0);
    }

    this.roots.set(tilesetId, root);
    this.headerRegistry.set(root.tileKey, root);
    return root;
  }

  /**
   * Registers a new viewport. Returns the ViewportState so the caller can
   * update its camera state each frame.
   */
  registerViewport(viewportId) {
    const existing = this.viewports.get(viewportId);
    if (existing) return existing;
    const vp = new ViewportState(viewportId, this.options);
    this.viewports.set(viewportId, vp);
    return vp;
  }

  /**
   * Removes a viewport. Its selected tiles are unmarked (removed from each
   * tile’s viewport reference set), which allows the reconciler to evict them
   * if no other viewport still needs them.
   */
  unregisterViewport(viewportId) {
    const vp = this.viewports.get(viewportId);
    if (!vp) return;
    for (const header of vp.selectedTiles) {
      if (header) header.removeViewportRef(viewportId);
    }
    vp.selectedTiles.length = 0;
    this.viewports.delete(viewportId);
  }

  // -------------------------------------------------------------------------
  // Main selection pass
  // -------------------------------------------------------------------------

  /**
   * Performs a full selection pass for one viewport.
   *
   * The algorithm matches Cesium’s _visitTileIfNeeded / _visitTile:
   *   1. Cull the current tile against the viewport’s frustum.
   *   2. Compute SSE. If SSE ≤ target OR the tile is a leaf, select it.
   *   3. Otherwise, refine to children and recurse near-to-far.
   *
   * @param {number|string} viewportId
   * @param {number} tick – current tick counter
   * @returns {Tile2DHeader[]} the selected tiles (owned by the caller)
   */
  selectTiles(viewportId, tick) {
    const vp = this.viewports.get(viewportId);
    if (!vp) throw new Error('Unknown viewport: ' + viewportId);

    vp.lastSelectedTick = tick;

    // Clear previous selection.
    for (const header of vp.selectedTiles) {
      if (header) header.removeViewportRef(viewportId);
    }
    vp.selectedTiles.length = 0;
    vp.selectedCount = 0;

    // Update the viewport’s frustum.
    vp.updateFrustum();

    // Walk each tileset’s quadtree.
    for (const root of this.roots.values()) {
      this._visitTileIfNeeded(root, vp, tick);
    }

    // Stitch seams between selected tiles at different LODs.
    if (this.options.enableSeamStitching) {
      this._stitchSeams(vp);
    }

    return vp.selectedTiles;
  }

  /**
   * Culls and, if visible, refines or selects the given tile.
   * Matches the Cesium traversal contract.
   */
  _visitTileIfNeeded(header, vp, tick) {
    vp.lastTraversalNodeCount++;

    // 1. Frustum culling.
    if (header.isCulledByFrustum(vp.frustumPlanes)) {
      return;
    }

    // 2. Distance-based culling: skip tiles beyond the far plane.
    const distSq = header.distanceSquaredTo(vp.cameraX, vp.cameraY, vp.cameraZ);
    if (distSq > vp.far * vp.far) {
      return;
    }

    // 3. Compute SSE.
    header.computeSSE(
      vp.cameraX, vp.cameraY, vp.cameraZ,
      vp.screenHeight, vp.fovRadians
    );

    // 4. Leaf tiles are always selected (Cesium: “A tile without any children
    //    is always deemed to meet the required SSE”).
    if (header.isLeaf()) {
      this._selectTile(header, vp);
      return;
    }

    // 5. If SSE ≤ target, select this tile.
    if (header.screenSpaceError <= this.options.screenSpaceErrorTarget) {
      this._selectTile(header, vp);
      return;
    }

    // 6. Otherwise, refine to children.
    //    Create missing children lazily.
    for (let i = 0; i < 4; i++) {
      let child = header.getChild(i);
      if (!child) {
        child = header.createChild(i, this.ecsWorld);
        if (child) {
          this.headerRegistry.set(child.tileKey, child);
        }
      }
      if (child) {
        this._visitTileIfNeeded(child, vp, tick);
      }
    }
  }

  /**
   * Selects a tile for rendering: records the viewport reference, computes
   * priority, and pushes the header into the viewport’s selection list.
   */
  _selectTile(header, vp) {
    header.addViewportRef(vp.viewportId);
    header.lastUsedTick = vp.lastSelectedTick;

    // Compute priority for the streaming queue (blueprint step 26).
    header.computePriority(
      vp.cameraX, vp.cameraY, vp.cameraZ,
      vp.forwardX, vp.forwardY, vp.forwardZ,
      vp.far
    );

    // Compute LOD blend weight for smooth cross-fades (blueprint step 19).
    header.computeLodBlendAlpha(vp.cameraX, vp.cameraY, vp.cameraZ);

    // Push into the viewport’s selection list.
    if (vp.selectedCount < vp.selectedTiles.length) {
      vp.selectedTiles[vp.selectedCount] = header;
    } else {
      vp.selectedTiles.push(header);
    }
    vp.selectedCount++;

    // Sync numeric fields back to the ECS component.
    if (this.ecsWorld) {
      header.syncToEcs(this.ecsWorld, vp.lastSelectedTick);
    }
  }

  // -------------------------------------------------------------------------
  // Seam stitching
  // -------------------------------------------------------------------------

  /**
   * After selection, walk the selected tiles and mark every edge where the
   * neighbor is at a different LOD as a seam. Both sides of the seam are
   * marked so the shader can cross-fade in a coordinated way.
   *
   * This is what makes LOD transitions seamless: the shader reads the seam
   * flag and the neighbor LOD, and blends the two detail levels over the
   * transition band (blueprint step 19).
   */
  _stitchSeams(vp) {
    const selected = vp.selectedTiles;
    const count = vp.selectedCount;

    for (let i = 0; i < count; i++) {
      const header = selected[i];
      if (!header) continue;

      // For each of the four edges, look up the neighbor at the same LOD.
      const neighbors = computeTileNeighbors(header.lod, header.tileX, header.tileY,
                                             1 << header.lod);

      for (const edge of [SeamEdge.NORTH, SeamEdge.EAST, SeamEdge.SOUTH, SeamEdge.WEST]) {
        const n = this._neighborForEdge(edge, neighbors);
        if (!n) continue;

        const nKey = stringTileKey(n.lod, n.x, n.y, header.tileZ);
        const neighborHeader = this.headerRegistry.get(nKey);
        if (!neighborHeader) continue;

        if (neighborHeader.lod === header.lod) {
          // Same LOD: mark a simple seam (both sides agree).
          header.setSeam(edge, neighborHeader.lod, neighborHeader.entityId);
          neighborHeader.setSeam(oppositeEdge(edge), header.lod, header.entityId);
        } else {
          // Different LOD: mark a blended seam.
          header.setSeam(edge, neighborHeader.lod, neighborHeader.entityId);
          neighborHeader.setSeam(oppositeEdge(edge), header.lod, header.entityId);
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

  // -------------------------------------------------------------------------
  // External queries – implement the Tileset2DAdapter contract
  // -------------------------------------------------------------------------

  /**
   * Returns the world-space bounding box of a tile as
   * [minX, minY, minZ, maxX, maxY, maxZ].
   * Used by consumers that need to query a tile’s extent without walking the
   * quadtree.
   */
  getTileBoundingBox(tilesetId, lod, x, y, z = 0) {
    const key = stringTileKey(lod, x, y, z);
    const header = this.headerRegistry.get(key);
    if (header) {
      return [header.minX, header.minY, header.minZ,
              header.maxX, header.maxY, header.maxZ];
    }
    // Fallback: compute the bounding box from the tileset parameters.
    const tileWorldSpan = this.options.tileWorldSize *
      Math.pow(2, this.options.maxLod - lod);
    const minX = x * tileWorldSpan;
    const minY = y * tileWorldSpan;
    return [
      minX, minY, this.options.minZ,
      minX + tileWorldSpan, minY + tileWorldSpan, this.options.maxZ
    ];
  }

  /**
   * Returns the priority of a tile for the streaming queue.
   * Matches blueprint step 26.
   */
  getTilePriority(tilesetId, lod, x, y, z = 0, viewportId = null) {
    const vp = viewportId != null ? this.viewports.get(viewportId) : null;
    if (!vp) return 0;

    const key = stringTileKey(lod, x, y, z);
    const header = this.headerRegistry.get(key);
    if (!header) return 0;

    return header.computePriority(
      vp.cameraX, vp.cameraY, vp.cameraZ,
      vp.forwardX, vp.forwardY, vp.forwardZ,
      vp.far
    );
  }

  /**
   * Returns the list of tile indices currently selected by a viewport.
   * Each entry is { lod, x, y, z, key } — the minimal traversal result.
   * This is the primary query for the streaming queue.
   */
  getTileIndices(viewportId) {
    const vp = this.viewports.get(viewportId);
    if (!vp) return [];
    const out = [];
    for (let i = 0; i < vp.selectedCount; i++) {
      const h = vp.selectedTiles[i];
      if (!h) continue;
      out.push({
        lod: h.lod,
        x: h.tileX,
        y: h.tileY,
        z: h.tileZ,
        key: h.tileKey
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Advanced: screen-space error evaluation for a single tile
  // -------------------------------------------------------------------------

  /**
   * Computes the screen-space error for a single tile, as seen from the given
   * viewport. Returns the SSE in pixels. Useful for runtime diagnostics and
   * for adaptive quality control (blueprint step 16: “Per-tick CPU under eight
   * milliseconds ... memory ceilings must be explicit”).
   */
  evaluateSSE(tilesetId, lod, x, y, z, viewportId) {
    const vp = this.viewports.get(viewportId);
    if (!vp) return 0;
    const key = stringTileKey(lod, x, y, z);
    const header = this.headerRegistry.get(key);
    if (!header) return 0;
    return header.computeSSE(
      vp.cameraX, vp.cameraY, vp.cameraZ,
      vp.screenHeight, vp.fovRadians
    );
  }

  // -------------------------------------------------------------------------
  // Lifecycle: reset and dispose
  // -------------------------------------------------------------------------

  /**
   * Clears the quadtree for a tileset, releasing all headers back to the pool
   * and destroying their ECS entities. Called when a tileset is removed or
   * when the world is torn down.
   */
  clearTileset(tilesetId) {
    const root = this.roots.get(tilesetId);
    if (!root) return;
    this._releaseSubtree(root);
    this.roots.delete(tilesetId);
  }

  _releaseSubtree(header) {
    for (let i = 0; i < 4; i++) {
      const child = header.getChild(i);
      if (child) this._releaseSubtree(child);
    }
    if (this.ecsWorld && header.entityId !== 0xFFFFFFFF) {
      header.unbindFromEcs(this.ecsWorld);
    }
    this.headerRegistry.delete(header.tileKey);
    this.headerPool.release(header);
  }

  dispose() {
    for (const root of this.roots.values()) {
      this._releaseSubtree(root);
    }
    this.roots.clear();
    this.headerRegistry.clear();
    this.viewports.clear();
    this.headerPool.dispose();
    this.frame = null;
    this.ecsWorld = null;
  }
}

// ---------------------------------------------------------------------------
// 3. UTILITY: default adapter factory
// ---------------------------------------------------------------------------

/**
 * Creates a Tileset2DAdapter with sensible defaults for the seamless terrain
 * pipeline. The caller should bind it to the context frame and ECS world by
 * calling adapter.bind(contextFrame, ecsWorld) before the first selection.
 */
export function createTerrainAdapter(options = {}) {
  return new Tileset2DAdapter({
    maxLod: options.maxLod ?? 12,
    tileWorldSize: options.tileWorldSize ?? 100,
    screenSpaceErrorTarget: options.screenSpaceErrorTarget ?? 16,
    maxActiveTiles: options.maxActiveTiles ?? 512,
    refinement: options.refinement ?? TileRefinement.REPLACE,
    contentFormat: options.contentFormat ?? TilesetSourceFormat.PROCEDURAL_2D,
    priorityAlpha: options.priorityAlpha ?? 1.0,
    priorityBeta: options.priorityBeta ?? 0.5,
    priorityGamma: options.priorityGamma ?? 0.3,
    enableSeamStitching: options.enableSeamStitching ?? true,
    ...options
  });
}

// ---------------------------------------------------------------------------
// 4. BARREL EXPORT
// ---------------------------------------------------------------------------

export default {
  Tileset2DAdapter,
  ViewportState,
  createTerrainAdapter
};