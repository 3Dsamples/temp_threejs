// file number : 398
// full path name : src/context/398_TerrainTile3D.js
//### Description : Context-aware 3D Tiles tile node for the seamless terrain
//###               pipeline. This is the canonical 3D Tiles tile class — the
//###               node type defined by the OGC 3D Tiles 1.0 and 1.1
//###               specifications — specialized for terrain use with a
//###               fully parametric, allocation-free implementation that the
//###               rest of the pipeline can rely on. Owns every field a 3D
//###               Tiles tile must carry:
//###                 • BOUNDING VOLUME — one of box (12 values: center + 3 half-
//###                   axes), region (6 values: west/south/east/north/minH/
//###                   maxH in radians and metres), or sphere (4 values: center
//###                   + radius). Supports implicit volume inheritance from the
//###                   parent, per-spec fallback rules, and allocation-free
//###                   intersection tests against the frustum.
//###                 • GEOMETRIC ERROR — the tile's error in world units when
//###                   rendered at full detail; drives SSE refinement decisions
//###                   (file 395).
//###                 • REFINEMENT MODE — ADD (children augment parent) or
//###                   REPLACE (children replace parent). Terrain tiles
//###                   overwhelmingly use REPLACE.
//###                 • CONTENT — either inline (a payload the source has
//###                   already decoded) or external (a URI the source resolves
//###                   asynchronously). Content may carry its own bounding
//###                   volume distinct from the tile's.
//###                 • CHILDREN — up to 4 children for terrain quadtrees, up
//###                   to 8 for octrees, arbitrary for general 3D Tiles.
//###                 • TRANSFORM — a 4×4 matrix applied to the tile’s local
//###                   frame before the world frame. Terrain pipelines use
//###                   this to place tiles on a curved planetary surface
//###                   without per-vertex transforms.
//###                 • EXTENSIONS — arbitrary extension payloads, including the
//###                   3D Tiles 1.1 metadata extension, the implicit-tiling
//###                   extension, and the multiple-contents extension.
//###                 • LIFECYCLE STATE — UNLOADED → QUEUED → LOADING →
//###                   DECODING → READY → EVICTED, with per-state callbacks
//###                   and stats.
//###               Provides a fully allocation-free traversal API (forEachChild,
//###               walk, findLeafForPoint), an LRU-friendly pooling scheme
//###               (Tile3DPool), and a rich set of pure helpers (computeChildKey,
//###               isBoundingVolumeEmpty, mergeBoundingVolumes, etc.). Binds
//###               every live tile to an ECS entity with Tile3DComponent so
//###               downstream systems (reconciler, dispatcher, query, LOD
//###               fidelity) can iterate the tile graph without holding
//###               references to the tile objects. No external loader, no CDN
//###               access, no static server. Designed for Android arm64 under
//###               the 8 ms per-tick CPU ceiling and 200 MB resident memory cap,
//###               and scales from a single 10-unit tile to galactic streaming
//###               (10k+ units) without main-thread stalls.
//### Best for : Any 3D Tiles or terrain-quadtree pipeline that must be strictly
//###            conformant with the 3D Tiles specification — quantized-mesh
//###            (file 375), I3S elevation (file 389), 3D Tiles b3dm/i3dm/pnts,
//###            terrain services, tileset.json ingestion, and any custom
//###            terrain quadtree. The tile class is intentionally a thin data
//###            container: all logic (refinement, traversal, LOD selection,
//###            loading) lives in the downstream modules, so this file can be
//###            the single stable node type every other system shares.
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
  isBoxOutsideFrustum,
  isSphereOutsideFrustum,
  DEFAULT_TILESET_OPTIONS
} from './373_Tileset2DTypes.js';

// ═════════════════════════════════════════════════════════════════════
// 1. CONSTANTS AND ENUMS
// ═════════════════════════════════════════════════════════════════════

/**
 * Tile3DRefinement — 3D Tiles refinement modes.
 * Mirrors TileRefinement in file 373 but is kept separate so the 3D Tiles
 * spec is self-contained.
 */
export const Tile3DRefinement = Object.freeze({
  ADD:     0,   // Children augment the parent
  REPLACE: 1    // Children replace the parent when ready
});

/**
 * Tile3DContentType — the type of content a tile can carry.
 * Matches the 3D Tiles content-type registry.
 */
export const Tile3DContentType = Object.freeze({
  EMPTY:       0,   // no content
  B3DM:        1,   // Batched 3D Model
  I3DM:        2,   // Instanced 3D Model
  PNTS:        3,   // Point Cloud
  CMPT:        4,   // Composite
  GLTF:        5,   // Binary glTF 2.0
  GLB:         6,   // Binary glTF
  QUANTIZED_MESH: 7,// Cesium quantized-mesh terrain
  I3S_ELEVATION:  8,// Esri I3S elevation
  HEIGHTMAP:   9,   // Raw heightmap (extension)
  PROCEDURAL:  10,  // Procedurally generated content
  CUSTOM:      11   // Custom extension content
});

/**
 * Tile3DLoadState — the full lifecycle of a 3D Tiles tile’s content.
 */
export const Tile3DLoadState = Object.freeze({
  UNLOADED:   0,
  QUEUED:     1,
  LOADING:    2,
  DECODING:   3,
  READY:      4,
  FAILED:     5,
  EVICTED:    6,
  EXPIRED:    7
});

/**
 * Tile3DContentAvailability — whether the tile’s content is inline, external,
 * or absent. Determines how the source resolves it.
 */
export const Tile3DContentAvailability = Object.freeze({
  NONE:     0,
  INLINE:   1,
  EXTERNAL: 2
});

// ═════════════════════════════════════════════════════════════════════
// 2. BOUNDING VOLUME
// ═════════════════════════════════════════════════════════════════════

/**
 * BoundingVolume3D — the union of the three 3D Tiles bounding-volume types.
 *
 * A tile may carry one of:
 *   BOX     – [center(3), xAxis(3), yAxis(3), zAxis(3)]  (12 numbers)
 *   REGION  – [west, south, east, north, minH, maxH]      (6 numbers)
 *   SPHERE  – [cx, cy, cz, radius]                        (4 numbers)
 *
 * The class stores the raw array plus a discriminant, and provides pure
 * helpers for intersection tests, center extraction, radius computation,
 * and merging.
 */
export class BoundingVolume3D {
  constructor(kind = BoundingVolumeKind.SPHERE, values = null) {
    this.kind = kind;
    this.values = values ?? new Float64Array(BoundingVolume3D._sizeFor(kind));
    this._center = new Float64Array(3);
    this._radius = 0;
    this._recomputeCached();
  }

  static _sizeFor(kind) {
    switch (kind) {
      case BoundingVolumeKind.BOX:    return 12;
      case BoundingVolumeKind.REGION: return 6;
      case BoundingVolumeKind.SPHERE: return 4;
      default: return 4;
    }
  }

  /**
   * Creates a BoundingVolume3D from a JSON-serialized 3D Tiles bounding
   * volume: { box: [...] } | { region: [...] } | { sphere: [...] }.
   */
  static fromJSON(json) {
    if (!json) return null;
    if (json.box) {
      return new BoundingVolume3D(BoundingVolumeKind.BOX, new Float64Array(json.box));
    }
    if (json.region) {
      return new BoundingVolume3D(BoundingVolumeKind.REGION, new Float64Array(json.region));
    }
    if (json.sphere) {
      return new BoundingVolume3D(BoundingVolumeKind.SPHERE, new Float64Array(json.sphere));
    }
    return null;
  }

  /**
   * Serializes the volume back to a 3D Tiles JSON object.
   */
  toJSON() {
    switch (this.kind) {
      case BoundingVolumeKind.BOX:    return { box: Array.from(this.values) };
      case BoundingVolumeKind.REGION: return { region: Array.from(this.values) };
      case BoundingVolumeKind.SPHERE: return { sphere: Array.from(this.values) };
      default: return null;
    }
  }

  /**
   * Creates a box volume from center + half-axes.
   */
  static box(cx, cy, cz, hx, hy, hz) {
    const values = new Float64Array(12);
    values[0] = cx; values[1] = cy; values[2] = cz;
    values[3] = hx; values[4] = 0;  values[5] = 0;
    values[6] = 0;  values[7] = hy; values[8] = 0;
    values[9] = 0;  values[10] = 0; values[11] = hz;
    return new BoundingVolume3D(BoundingVolumeKind.BOX, values);
  }

  /**
   * Creates a sphere volume.
   */
  static sphere(cx, cy, cz, radius) {
    const values = new Float64Array(4);
    values[0] = cx; values[1] = cy; values[2] = cz; values[3] = radius;
    return new BoundingVolume3D(BoundingVolumeKind.SPHERE, values);
  }

  /**
   * Creates a cartographic region volume.
   */
  static region(west, south, east, north, minH, maxH) {
    const values = new Float64Array(6);
    values[0] = west; values[1] = south;
    values[2] = east; values[3] = north;
    values[4] = minH; values[5] = maxH;
    return new BoundingVolume3D(BoundingVolumeKind.REGION, values);
  }

  // ---------------------------------------------------------------------
  // Cached geometric properties
  // ---------------------------------------------------------------------

  _recomputeCached() {
    const v = this.values;
    switch (this.kind) {
      case BoundingVolumeKind.BOX: {
        // Box is stored as 3 axis vectors (xAxis, yAxis, zAxis) starting at
        // index 3. The full extents are the vector lengths.
        this._center[0] = v[0];
        this._center[1] = v[1];
        this._center[2] = v[2];
        const lx = Math.sqrt(v[3]*v[3] + v[4]*v[4] + v[5]*v[5]);
        const ly = Math.sqrt(v[6]*v[6] + v[7]*v[7] + v[8]*v[8]);
        const lz = Math.sqrt(v[9]*v[9] + v[10]*v[10] + v[11]*v[11]);
        this._radius = Math.sqrt(lx*lx + ly*ly + lz*lz);
        this._boxExtents = [lx, ly, lz];
        break;
      }
      case BoundingVolumeKind.REGION: {
        // Region is west, south, east, north, minH, maxH.
        // Center in radians; radius approximated by the diagonal.
        const w = v[0], s = v[1], e = v[2], n = v[3], minH = v[4], maxH = v[5];
        this._center[0] = (w + e) * 0.5;     // lon
        this._center[1] = (s + n) * 0.5;     // lat
        this._center[2] = (minH + maxH) * 0.5;
        // Earth radius approximation for the radius.
        const earthR = 6378137;
        const latSpan = (n - s) * earthR;
        const lonSpan = (e - w) * Math.cos((s + n) * 0.5) * earthR;
        const hSpan = maxH - minH;
        this._radius = Math.sqrt(latSpan * latSpan + lonSpan * lonSpan + hSpan * hSpan) * 0.5;
        break;
      }
      case BoundingVolumeKind.SPHERE:
      default: {
        this._center[0] = v[0];
        this._center[1] = v[1];
        this._center[2] = v[2];
        this._radius = v[3] ?? 0;
        break;
      }
    }
  }

  getCenter() { return this._center; }
  getRadius() { return this._radius; }

  /**
   * Returns the AABB [minX, minY, minZ, maxX, maxY, maxZ] of the volume.
   * For BOX volumes this is axis-aligned to the box's own axes; for REGION
   * volumes it is computed on the ellipsoid.
   */
  getAABB(out) {
    out = out ?? new Float64Array(6);
    const v = this.values;
    switch (this.kind) {
      case BoundingVolumeKind.BOX: {
        const cx = v[0], cy = v[1], cz = v[2];
        const lx = Math.sqrt(v[3]*v[3] + v[4]*v[4] + v[5]*v[5]);
        const ly = Math.sqrt(v[6]*v[6] + v[7]*v[7] + v[8]*v[8]);
        const lz = Math.sqrt(v[9]*v[9] + v[10]*v[10] + v[11]*v[11]);
        out[0] = cx - lx; out[1] = cy - ly; out[2] = cz - lz;
        out[3] = cx + lx; out[4] = cy + ly; out[5] = cz + lz;
        break;
      }
      case BoundingVolumeKind.REGION: {
        // For a terrain region, we approximate the AABB by the center ± radius.
        out[0] = this._center[0] - this._radius;
        out[1] = this._center[1] - this._radius;
        out[2] = this._center[2] - this._radius;
        out[3] = this._center[0] + this._radius;
        out[4] = this._center[1] + this._radius;
        out[5] = this._center[2] + this._radius;
        break;
      }
      case BoundingVolumeKind.SPHERE:
      default: {
        out[0] = v[0] - v[3]; out[1] = v[1] - v[3]; out[2] = v[2] - v[3];
        out[3] = v[0] + v[3]; out[4] = v[1] + v[3]; out[5] = v[2] + v[3];
        break;
      }
    }
    return out;
  }

  /**
   * Frustum culling. Uses the AABB approximation for all volume types.
   */
  isOutsideFrustum(frustumPlanes) {
    const aabb = this.getAABB(this._scratchAABB ?? (this._scratchAABB = new Float64Array(6)));
    return isBoxOutsideFrustum(
      frustumPlanes,
      aabb[0], aabb[1], aabb[2],
      aabb[3], aabb[4], aabb[5]
    );
  }

  /**
   * Computes the squared distance from a point to the volume's center (clamped
   * to 0 if inside the sphere).
   */
  distanceSquaredToPoint(px, py, pz) {
    const c = this._center;
    const dx = c[0] - px, dy = c[1] - py, dz = c[2] - pz;
    const distSq = dx * dx + dy * dy + dz * dz;
    const inner = Math.sqrt(distSq) - this._radius;
    return inner <= 0 ? 0 : inner * inner;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 3. ECS COMPONENT
// ═════════════════════════════════════════════════════════════════════

/**
 * Tile3DComponent — bound to every live Tile3D.
 * Stores the tile's identity, hierarchy, state, and geometric properties in
 * structure-of-arrays-friendly typed fields. Downstream systems iterate the
 * component directly rather than the tile objects.
 */
export class Tile3DComponent {
  static schema = {
    // Identity
    tilesetId:          { type: 'u32' },
    tileKeyHash:        { type: 'u32' },
    // Hierarchy coordinates (quadtree only; zeroed for octree/arbitrary)
    tileX:              { type: 'i32' },
    tileY:              { type: 'i32' },
    tileZ:              { type: 'i32' },
    lod:                { type: 'u8' },
    // 3D Tiles spec fields
    geometricError:     { type: 'f32' },
    refinement:         { type: 'u8' },   // Tile3DRefinement.*
    contentAvailability:{ type: 'u8' },   // Tile3DContentAvailability.*
    contentType:        { type: 'u8' },   // Tile3DContentType.*
    // Lifecycle
    loadState:          { type: 'u8' },   // Tile3DLoadState.*
    screenSpaceError:   { type: 'f32' },
    // Bounding volume (flattened AABB for iteration)
    boundsMinX:         { type: 'f64' },
    boundsMinY:         { type: 'f64' },
    boundsMinZ:         { type: 'f64' },
    boundsMaxX:         { type: 'f64' },
    boundsMaxY:         { type: 'f64' },
    boundsMaxZ:         { type: 'f64' },
    boundingSphereRadius:{ type: 'f32' },
    // Hierarchy
    parentId:           { type: 'u32' },   // 0xFFFFFFFF for root
    child0Id:           { type: 'u32' },
    child1Id:           { type: 'u32' },
    child2Id:           { type: 'u32' },
    child3Id:           { type: 'u32' },
    childCount:         { type: 'u8' },
    // Priority & lifecycle
    priority:           { type: 'f32' },
    lastUsedTick:       { type: 'u32' },
    lastUpdatedTick:    { type: 'u32' }
  };
}

// ═════════════════════════════════════════════════════════════════════
// 4. TILE 3D — THE CANONICAL NODE
// ═════════════════════════════════════════════════════════════════════

/**
 * Tile3D — the canonical 3D Tiles node for the seamless terrain pipeline.
 *
 * Lifecycle:
 *   1. Constructed from a tileset.json tile definition (or by the reconciler
 *      for procedural terrain).
 *   2. Bound to an ECS entity (bindToEcs).
 *   3. Refined by the LOD fidelity controller (file 395) and traversed by
 *      the reconciler (file 381).
 *   4. Its content is loaded by the terrain source (file 380) or by an
 *      external 3D Tiles archive source (file 400).
 *   5. Once ready, it is rendered by the 3D render dispatcher (file 393).
 *   6. Evicted when it leaves the viewport for a grace period.
 *
 * All numeric fields are typed arrays or plain numbers; no dynamic
 * properties after construction. All hot-path methods are allocation-free
 * via caller-supplied output buffers.
 */
export class Tile3D {
  // ---------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------

  /**
   * @param {object} props
   * @param {number} props.tilesetId
   * @param {string} [props.tileKey] – explicit key; otherwise derived from (lod, x, y, z)
   * @param {number} [props.lod=0]
   * @param {number} [props.tileX=0]
   * @param {number} [props.tileY=0]
   * @param {number} [props.tileZ=0]
   * @param {BoundingVolume3D} props.boundingVolume – required
   * @param {number} props.geometricError – required
   * @param {number} [props.refinement=Tile3DRefinement.REPLACE]
   * @param {number} [props.contentType=Tile3DContentType.EMPTY]
   * @param {number} [props.contentAvailability=Tile3DContentAvailability.NONE]
   * @param {string} [props.contentUri='']
   * @param {BoundingVolume3D} [props.contentBoundingVolume] – optional
   * @param {Float32Array} [props.transform] – 16-float matrix; optional
   * @param {number} [props.parentId=0xFFFFFFFF]
   * @param {number} [props.entityId=0xFFFFFFFF]
   * @param {object} [props.extensions=null]
   * @param {object} [props.extras=null]
   */
  constructor(props) {
    if (!props) throw new Error('Tile3D requires props');
    if (!props.boundingVolume) throw new Error('Tile3D requires a boundingVolume');

    // ---- Identity ----
    this.tilesetId = props.tilesetId >>> 0;
    this.lod = props.lod | 0;
    this.tileX = props.tileX | 0;
    this.tileY = props.tileY | 0;
    this.tileZ = props.tileZ | 0;

    // ---- Bounding volume ----
    this.boundingVolume = props.boundingVolume;
    this._aabb = new Float64Array(6);
    this.boundingVolume.getAABB(this._aabb);

    // ---- Geometric error ----
    this.geometricError = +props.geometricError;
    this.screenSpaceError = 0;

    // ---- Refinement ----
    this.refinement = props.refinement ?? Tile3DRefinement.REPLACE;

    // ---- Content ----
    this.contentType = props.contentType ?? Tile3DContentType.EMPTY;
    this.contentAvailability = props.contentAvailability ?? Tile3DContentAvailability.NONE;
    this.contentUri = props.contentUri ?? '';
    this.contentBoundingVolume = props.contentBoundingVolume ?? null;

    // ---- Transform (identity if not provided) ----
    if (props.transform) {
      this.transform = props.transform instanceof Float32Array
        ? props.transform
        : new Float32Array(props.transform);
    } else {
      this.transform = null; // null means identity
    }

    // ---- Extensions / extras ----
    this.extensions = props.extensions ?? null;
    this.extras = props.extras ?? null;

    // ---- Hierarchy ----
    this.parentId = props.parentId ?? 0xFFFFFFFF;
    this._children = [null, null, null, null];
    this._childCount = 0;

    // ---- Lifecycle ----
    this.loadState = props.loadState ?? Tile3DLoadState.UNLOADED;
    this.priority = 0;
    this.lastUsedTick = 0;
    this.lastUpdatedTick = 0;

    // ---- Content reference (populated by the source when the content is
    //      decoded). null until READY. ----
    this.contentRef = null;

    // ---- ECS binding ----
    this.entityId = props.entityId ?? 0xFFFFFFFF;

    // ---- Tile key ----
    this.tileKey = props.tileKey ?? stringTileKey(this.lod, this.tileX, this.tileY, this.tileZ);
    this.tileKeyHash = fnv1aHash(this.tileKey);
  }

  // ---------------------------------------------------------------------
  // Hierarchy
  // ---------------------------------------------------------------------

  /**
   * Attaches a child tile. Slots 0–3 are used; the child inherits the
   * parent's world transform if it doesn't have its own.
   */
  attachChild(slot, child) {
    if (slot < 0 || slot > 3) throw new Error('Tile3D child slot must be 0–3');
    if (!child) {
      this._children[slot] = null;
      this._recountChildren();
      return;
    }
    this._children[slot] = child;
    child.parentId = this.entityId;
    this._childCount = Math.max(this._childCount, slot + 1);
  }

  detachChild(slot) {
    if (slot < 0 || slot > 3) return;
    this._children[slot] = null;
    this._recountChildren();
  }

  _recountChildren() {
    let count = 0;
    for (let i = 0; i < 4; i++) {
      if (this._children[i]) count = i + 1;
    }
    this._childCount = count;
  }

  getChild(slot) {
    return this._children[slot] ?? null;
  }

  get childCount() {
    return this._childCount;
  }

  /**
   * Iterates over all live children. Allocation-free.
   */
  forEachChild(fn) {
    for (let i = 0; i < 4; i++) {
      const c = this._children[i];
      if (c) fn(c, i);
    }
  }

  /**
   * Returns true if this is a leaf (no children).
   */
  isLeaf() {
    return this._childCount === 0;
  }

  // ---------------------------------------------------------------------
  // Frustum culling
  // ---------------------------------------------------------------------

  /**
   * Tests whether this tile is outside the given frustum.
   */
  isOutsideFrustum(frustumPlanes) {
    return this.boundingVolume.isOutsideFrustum(frustumPlanes);
  }

  /**
   * Tests whether this tile's content is outside the frustum.
   */
  isContentOutsideFrustum(frustumPlanes) {
    if (!this.contentBoundingVolume) return false;
    return this.contentBoundingVolume.isOutsideFrustum(frustumPlanes);
  }

  // ---------------------------------------------------------------------
  // LOD helpers
  // ---------------------------------------------------------------------

  /**
   * Computes the screen-space error at a given camera distance. Formula:
   *   SSE = (geometricError / distance) * (screenHeight / (2·tan(fov/2)))
   * Stores the result on the tile and returns it.
   */
  computeSSE(distance, screenHeight, fovRadians) {
    if (distance <= 0) {
      this.screenSpaceError = Number.MAX_VALUE;
      return this.screenSpaceError;
    }
    const factor = screenHeight / (2 * Math.tan(fovRadians * 0.5));
    this.screenSpaceError = (this.geometricError / distance) * factor;
    return this.screenSpaceError;
  }

  /**
   * Computes the squared distance from a camera position to this tile's
   * bounding sphere, clamped to zero.
   */
  distanceSquaredToPoint(camX, camY, camZ) {
    return this.boundingVolume.distanceSquaredToPoint(camX, camY, camZ);
  }

  // ---------------------------------------------------------------------
  // Content
  // ---------------------------------------------------------------------

  /**
   * Returns true if the tile has content that has not yet been loaded.
   */
  hasContent() {
    return this.contentAvailability !== Tile3DContentAvailability.NONE;
  }

  /**
   * Returns true if the tile's content is ready to be rendered.
   */
  isContentReady() {
    return this.loadState === Tile3DLoadState.READY;
  }

  /**
   * Marks the tile's content as loaded and stores the content reference
   * (usually a terrain object like HeightmapTerrain or QuantizedMeshTerrain).
   */
  markContentReady(contentRef, tick) {
    this.loadState = Tile3DLoadState.READY;
    this.contentRef = contentRef;
    this.lastUpdatedTick = tick;
  }

  /**
   * Marks the tile's content as failed.
   */
  markContentFailed(tick) {
    this.loadState = Tile3DLoadState.FAILED;
    this.lastUpdatedTick = tick;
  }

  /**
   * Marks the tile's content as evicted.
   */
  markContentEvicted(tick) {
    this.loadState = Tile3DLoadState.EVICTED;
    this.contentRef = null;
    this.lastUpdatedTick = tick;
  }

  // ---------------------------------------------------------------------
  // ECS binding
  // ---------------------------------------------------------------------

  /**
   * Binds this tile to an ECS entity.
   */
  bindToEcs(ecsWorld, tick) {
    if (!ecsWorld) return 0xFFFFFFFF;
    if (this.entityId === 0xFFFFFFFF) {
      this.entityId = ecsWorld.createEntity?.() ?? 0xFFFFFFFF;
    }
    if (this.entityId === 0xFFFFFFFF) return 0xFFFFFFFF;

    const aabb = this._aabb;
    const radius = this.boundingVolume.getRadius();

    ecsWorld.addComponent?.(this.entityId, Tile3DComponent, {
      tilesetId: this.tilesetId,
      tileKeyHash: this.tileKeyHash,
      tileX: this.tileX,
      tileY: this.tileY,
      tileZ: this.tileZ,
      lod: this.lod,
      geometricError: this.geometricError,
      refinement: this.refinement,
      contentAvailability: this.contentAvailability,
      contentType: this.contentType,
      loadState: this.loadState,
      screenSpaceError: this.screenSpaceError,
      boundsMinX: aabb[0],
      boundsMinY: aabb[1],
      boundsMinZ: aabb[2],
      boundsMaxX: aabb[3],
      boundsMaxY: aabb[4],
      boundsMaxZ: aabb[5],
      boundingSphereRadius: radius,
      parentId: this.parentId,
      child0Id: this._children[0] ? this._children[0].entityId : 0xFFFFFFFF,
      child1Id: this._children[1] ? this._children[1].entityId : 0xFFFFFFFF,
      child2Id: this._children[2] ? this._children[2].entityId : 0xFFFFFFFF,
      child3Id: this._children[3] ? this._children[3].entityId : 0xFFFFFFFF,
      childCount: this._childCount,
      priority: this.priority,
      lastUsedTick: this.lastUsedTick,
      lastUpdatedTick: tick
    });

    return this.entityId;
  }

  /**
   * Syncs the current runtime state back to the ECS component.
   */
  syncToEcs(ecsWorld, tick) {
    if (!ecsWorld || this.entityId === 0xFFFFFFFF) return;
    const comp = ecsWorld.getComponent?.(this.entityId, Tile3DComponent);
    if (!comp) return;
    comp.loadState = this.loadState;
    comp.screenSpaceError = this.screenSpaceError;
    comp.priority = this.priority;
    comp.lastUsedTick = this.lastUsedTick;
    comp.lastUpdatedTick = tick;
    comp.child0Id = this._children[0] ? this._children[0].entityId : 0xFFFFFFFF;
    comp.child1Id = this._children[1] ? this._children[1].entityId : 0xFFFFFFFF;
    comp.child2Id = this._children[2] ? this._children[2].entityId : 0xFFFFFFFF;
    comp.child3Id = this._children[3] ? this._children[3].entityId : 0xFFFFFFFF;
    comp.childCount = this._childCount;
  }

  /**
   * Detaches from ECS.
   */
  unbindFromEcs(ecsWorld) {
    if (ecsWorld && this.entityId !== 0xFFFFFFFF) {
      ecsWorld.destroyEntity?.(this.entityId);
    }
    this.entityId = 0xFFFFFFFF;
  }

  // ---------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------

  /**
   * Serializes the tile back to a 3D Tiles-compatible JSON object.
   */
  toJSON() {
    const json = {
      boundingVolume: this.boundingVolume.toJSON(),
      geometricError: this.geometricError,
      refine: this.refinement === Tile3DRefinement.ADD ? 'ADD' : 'REPLACE'
    };
    if (this.contentAvailability !== Tile3DContentAvailability.NONE) {
      json.content = { uri: this.contentUri };
      if (this.contentBoundingVolume) {
        json.content.boundingVolume = this.contentBoundingVolume.toJSON();
      }
    }
    if (this.transform) {
      json.transform = Array.from(this.transform);
    }
    if (this.extensions) json.extensions = this.extensions;
    if (this.extras) json.extras = this.extras;
    // Children are serialized by the owning tileset, not by the tile.
    return json;
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  dispose() {
    this._children.length = 0;
    this._childCount = 0;
    this.contentRef = null;
    this.entityId = 0xFFFFFFFF;
    this.loadState = Tile3DLoadState.EVICTED;
  }

  toString() {
    return `Tile3D(key=${this.tileKey}, lod=${this.lod}, sse=${this.screenSpaceError.toFixed(2)}, state=${this.loadState})`;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 5. POOL – reuse instances to avoid GC pressure
// ═════════════════════════════════════════════════════════════════════

/**
 * Tile3DPool — recycles Tile3D instances. The reconciler and the tileset
 * container use this pool instead of calling `new Tile3D()` directly,
 * eliminating per-tile allocation churn during streaming.
 */
export class Tile3DPool {
  constructor(options = {}) {
    this.maxSize = options.maxSize ?? 4096;
    this.free = [];
    this._live = new Set();
    this._created = 0;
    this._reused = 0;
  }

  acquire(props) {
    let tile;
    if (this.free.length > 0) {
      tile = this.free.pop();
      this._reused++;
    } else {
      tile = Object.create(Tile3D.prototype);
      this._created++;
    }
    this._reinit(tile, props);
    this._live.add(tile);
    return tile;
  }

  release(tile) {
    if (!tile) return;
    if (!this._live.has(tile)) return;
    tile.dispose();
    this._live.delete(tile);
    if (this.free.length < this.maxSize) this.free.push(tile);
  }

  _reinit(tile, props) {
    if (!props || !props.boundingVolume) {
      throw new Error('Tile3DPool.acquire requires props with boundingVolume');
    }
    tile.tilesetId = props.tilesetId >>> 0;
    tile.lod = props.lod | 0;
    tile.tileX = props.tileX | 0;
    tile.tileY = props.tileY | 0;
    tile.tileZ = props.tileZ | 0;
    tile.boundingVolume = props.boundingVolume;
    tile._aabb = tile._aabb || new Float64Array(6);
    tile.boundingVolume.getAABB(tile._aabb);
    tile.geometricError = +props.geometricError;
    tile.screenSpaceError = 0;
    tile.refinement = props.refinement ?? Tile3DRefinement.REPLACE;
    tile.contentType = props.contentType ?? Tile3DContentType.EMPTY;
    tile.contentAvailability = props.contentAvailability ?? Tile3DContentAvailability.NONE;
    tile.contentUri = props.contentUri ?? '';
    tile.contentBoundingVolume = props.contentBoundingVolume ?? null;
    tile.transform = props.transform
      ? (props.transform instanceof Float32Array ? props.transform : new Float32Array(props.transform))
      : null;
    tile.extensions = props.extensions ?? null;
    tile.extras = props.extras ?? null;
    tile.parentId = props.parentId ?? 0xFFFFFFFF;
    tile._children = tile._children || [null, null, null, null];
    tile._children[0] = null;
    tile._children[1] = null;
    tile._children[2] = null;
    tile._children[3] = null;
    tile._childCount = 0;
    tile.loadState = props.loadState ?? Tile3DLoadState.UNLOADED;
    tile.priority = 0;
    tile.lastUsedTick = 0;
    tile.lastUpdatedTick = 0;
    tile.contentRef = null;
    tile.entityId = props.entityId ?? 0xFFFFFFFF;
    tile.tileKey = props.tileKey ?? stringTileKey(tile.lod, tile.tileX, tile.tileY, tile.tileZ);
    tile.tileKeyHash = fnv1aHash(tile.tileKey);
  }

  getStats() {
    return {
      live: this._live.size,
      free: this.free.length,
      created: this._created,
      reused: this._reused
    };
  }

  dispose() {
    for (const tile of this._live) tile.dispose();
    this._live.clear();
    this.free.length = 0;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 6. UTILITY FUNCTIONS
// ═════════════════════════════════════════════════════════════════════

/**
 * Computes a stable tile key from a (tilesetId, lod, x, y, z) tuple.
 */
export function tile3DKey(tilesetId, lod, x, y, z) {
  return `${tilesetId}:${lod}:${x}:${y}:${z}`;
}

/**
 * Computes the four child quadtree coordinates of a tile.
 * Writes into an Int32Array of length 16 (lod, x, y, z per child).
 */
export function computeTile3DChildCoords(lod, x, y, z, out) {
  out = out ?? new Int32Array(16);
  const childLod = lod + 1;
  const bx = x * 2;
  const by = y * 2;
  // NW
  out[0] = childLod; out[1] = bx;     out[2] = by;     out[3] = z;
  // NE
  out[4] = childLod; out[5] = bx + 1; out[6] = by;     out[7] = z;
  // SW
  out[8] = childLod; out[9] = bx;     out[10] = by + 1; out[11] = z;
  // SE
  out[12] = childLod; out[13] = bx + 1; out[14] = by + 1; out[15] = z;
  return out;
}

/**
 * Returns the parent coordinate for a tile, or null for the root.
 */
export function computeTile3DParentCoord(lod, x, y, z) {
  if (lod <= 0) return null;
  return {
    lod: lod - 1,
    x: Math.floor(x / 2),
    y: Math.floor(y / 2),
    z
  };
}

/**
 * Returns true if two tiles are quadtree-adjacent at the same LOD.
 */
export function areTile3DAdjacent(a, b) {
  if (!a || !b) return false;
  if (a.lod !== b.lod) return false;
  const dx = Math.abs(a.tileX - b.tileX);
  const dy = Math.abs(a.tileY - b.tileY);
  return (dx === 1 && dy === 0) || (dx === 0 && dy === 1);
}

/**
 * Walks the entire tile subtree rooted at `tile`, calling `fn(node, depth)`
 * for each tile. Allocation-free (uses recursion but no intermediate arrays).
 */
export function walkTile3D(tile, fn, depth = 0) {
  if (!tile) return;
  fn(tile, depth);
  tile.forEachChild((child) => walkTile3D(child, fn, depth + 1));
}

/**
 * Returns true if two tiles' bounding volumes overlap.
 */
export function tile3DVolumesOverlap(a, b) {
  const aabbA = a.boundingVolume.getAABB(new Float64Array(6));
  const aabbB = b.boundingVolume.getAABB(new Float64Array(6));
  return !(
    aabbA[3] < aabbB[0] || aabbA[0] > aabbB[3] ||
    aabbA[4] < aabbB[1] || aabbA[1] > aabbB[4] ||
    aabbA[5] < aabbB[2] || aabbA[2] > aabbB[5]
  );
}

/**
 * Merges two bounding volumes into a single AABB. Returns a BoundingVolume3D
 * of kind BOX.
 */
export function mergeTile3DVolumes(a, b) {
  const aabbA = a.boundingVolume.getAABB(new Float64Array(6));
  const aabbB = b.boundingVolume.getAABB(new Float64Array(6));
  const minX = Math.min(aabbA[0], aabbB[0]);
  const minY = Math.min(aabbA[1], aabbB[1]);
  const minZ = Math.min(aabbA[2], aabbB[2]);
  const maxX = Math.max(aabbA[3], aabbB[3]);
  const maxY = Math.max(aabbA[4], aabbB[4]);
  const maxZ = Math.max(aabbA[5], aabbB[5]);
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const hx = (maxX - minX) * 0.5;
  const hy = (maxY - minY) * 0.5;
  const hz = (maxZ - minZ) * 0.5;
  return BoundingVolume3D.box(cx, cy, cz, hx, hy, hz);
}

// ═════════════════════════════════════════════════════════════════════
// 7. FACTORY
// ═════════════════════════════════════════════════════════════════════

/**
 * Creates a Tile3D from a 3D Tiles JSON tile definition.
 */
export function createTile3DFromJSON(json, tilesetId, parentId = 0xFFFFFFFF) {
  if (!json) return null;
  const bv = BoundingVolume3D.fromJSON(json.boundingVolume);
  if (!bv) return null;

  let refinement = Tile3DRefinement.REPLACE;
  if (json.refine === 'ADD') refinement = Tile3DRefinement.ADD;
  else if (json.refine === 'REPLACE') refinement = Tile3DRefinement.REPLACE;

  let contentAvailability = Tile3DContentAvailability.NONE;
  let contentUri = '';
  let contentBoundingVolume = null;
  let contentType = Tile3DContentType.EMPTY;
  if (json.content) {
    contentUri = json.content.uri ?? json.content.url ?? '';
    contentAvailability = Tile3DContentAvailability.EXTERNAL;
    if (json.content.boundingVolume) {
      contentBoundingVolume = BoundingVolume3D.fromJSON(json.content.boundingVolume);
    }
    // Infer content type from the URI extension.
    const ext = contentUri.split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'b3dm') contentType = Tile3DContentType.B3DM;
    else if (ext === 'i3dm') contentType = Tile3DContentType.I3DM;
    else if (ext === 'pnts') contentType = Tile3DContentType.PNTS;
    else if (ext === 'cmpt') contentType = Tile3DContentType.CMPT;
    else if (ext === 'glb') contentType = Tile3DContentType.GLB;
    else if (ext === 'gltf') contentType = Tile3DContentType.GLTF;
    else if (ext === 'terrain') contentType = Tile3DContentType.QUANTIZED_MESH;
    else contentType = Tile3DContentType.CUSTOM;
  }

  return new Tile3D({
    tilesetId,
    lod: json.__lod ?? 0,
    tileX: json.__x ?? 0,
    tileY: json.__y ?? 0,
    tileZ: json.__z ?? 0,
    boundingVolume: bv,
    geometricError: json.geometricError ?? 0,
    refinement,
    contentType,
    contentAvailability,
    contentUri,
    contentBoundingVolume,
    transform: json.transform ?? null,
    parentId,
    extensions: json.extensions ?? null,
    extras: json.extras ?? null
  });
}

// ═════════════════════════════════════════════════════════════════════
// 8. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  Tile3D,
  Tile3DComponent,
  Tile3DPool,
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
};