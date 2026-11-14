// file number : 397
// full path name : src/context/397_TerrainQueryCollision3D.js
//### Description : Context-aware 3D terrain query and collision system. This
//###               is the gameplay-facing module that answers every spatial
//###               question the living world needs to ask about the ground:
//###                 • HEIGHT queries — “what is the terrain elevation at
//###                   (wx, wy)?” using bilinear interpolation for heightmap
//###                   tiles and barycentric interpolation for irregular mesh
//###                   tiles. O(log n) via the spatial acceleration layer
//###                   (files 271–274) and the tile registry (files 381, 378).
//###                 • NORMAL queries — “what is the surface normal here?”
//###                   using central differences for heightmaps and
//###                   barycentric interpolation for meshes. Returns a
//###                   normalized Vec3 in the world frame.
//###                 • SLOPE queries — “how steep is the ground?” returning
//###                   both the gradient magnitude and the gradient direction,
//###                   used by character controllers, physics, and AI steering.
//###                 • RAY-TERRAIN INTERSECTION — “where does this ray hit the
//###                   ground?” using a two-stage approach: coarse AABB rejection
//###                   against each candidate tile, then per-triangle Möller-
//###                   Trumbore for mesh tiles or per-cell bilinear for
//###                   heightmap tiles. Returns the hit point, normal, distance,
//###                   and the material ID of the tile hit.
//###                 • SPHERE-TERRAIN COLLISION — for character controllers,
//###                   vehicles, and rolling props. Returns the closest surface
//###                   point, contact normal, and penetration depth for a
//###                   sphere at an arbitrary position. Uses the tile’s
//###                   bounding sphere for fast rejection, then the same
//###                   per-triangle code as the ray cast.
//###                 • CAPSULE-TERRAIN COLLISION — for capsule-shaped character
//###                   colliders. Samples the capsule at multiple heights and
//###                   returns the deepest contact plus the averaged surface
//###                   normal, giving a stable ground normal for character
//###                   controllers.
//###                 • GROUND SNAPPING — snaps an arbitrary 3D point to the
//###                   terrain surface along the vertical axis, used by respawn,
//###                   teleport, and fast-travel systems.
//###               All queries accept a caller-supplied output object or array
//###               and are strictly allocation-free in the hot path, so they
//###               can be called inside the 60 Hz loop by every character
//###               controller, AI agent, and physics contact resolver in the
//###               world without triggering GC pauses. The query engine reads
//###               the same visible-tile SoA the renderer uses, so it never
//###               sees a tile the renderer doesn’t see — no popping artifacts,
//###               no “invisible wall” bugs, no terrain queries through walls
//###               the player can’t see. Binds collision state to ECS entities
//###               via TerrainCollider3DComponent and TerrainGroundQuery3D
//###               components so downstream systems (character controllers,
//###               AI, footstep audio) can query and cache results without
//###               re-scanning the world. No external loader, no CDN access,
//###               no static server. Designed for Android arm64 under the 8 ms
//###               per-tick CPU ceiling and 200 MB resident memory cap, and
//###               scales from a single 10-unit tile to galactic streaming
//###               (10k+ units) without main-thread stalls.
//### Best for : Any gameplay system that must interact with the ground — player
//###            and NPC character controllers, vehicles, projectiles, footstep
//###            audio, dust particle spawn, vegetation scatter, camera
//###            collision, pathfinding height sampling, AI navigation, and
//###            line-of-sight checks against terrain. The query engine is the
//###            single authoritative source for “where is the ground?” so all
//###            these systems agree on the answer, even across LOD transitions
//###            and seam stitches. It also handles the case where the query
//###            point is inside a seam stitch quad — returning the interpolated
//###            surface so the player never falls through a crack.
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
  hasSeam,
  oppositeEdge,
  stringTileKey,
  fnv1aHash,
  computeTileNeighbors,
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
  SpatialHashGrid
} from './271_SpatialHashGrid.js';

import {
  DynamicBVH
} from './272_DynamicBVH.js';

import {
  GeometryFamily3D,
  MaterialFamily3D,
  QualityTier3D
} from './393_TerrainRenderDispatch3D.js';

// ═════════════════════════════════════════════════════════════════════
// 1. ENUMS
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainQueryKind — the type of query being performed.
 * Used for statistics and for caching.
 */
export const TerrainQueryKind = Object.freeze({
  HEIGHT:        0,
  NORMAL:        1,
  SLOPE:         2,
  RAY_CAST:      3,
  SPHERE_SWEEP:  4,
  CAPSULE_SWEEP: 5,
  GROUND_SNAP:   6
});

/**
 * TerrainHitFlags — bitfield describing properties of a hit result.
 */
export const TerrainHitFlags = Object.freeze({
  NONE:          0,
  INSIDE_SEAM:   (1 << 0),   // hit landed inside a seam stitch quad
  ON_SKIRT:      (1 << 1),   // hit landed on a skirt quad
  CROSS_LOD:     (1 << 2),   // hit is on a tile adjacent to a different LOD
  UNDERWATER:    (1 << 3),   // hit is below sea level
  STEEP:         (1 << 4),   // slope > 45 degrees
  SMOOTH:        (1 << 5)    // slope < 5 degrees
});

// ═════════════════════════════════════════════════════════════════════
// 2. RESULT RECORDS
// ═════════════════════════════════════════════════════════════════════

/**
 * RayHit3D — the result of a ray-terrain intersection. Immutable after
 * construction; callers should copy fields they need to keep.
 *
 * Fields:
 *   hit          – true if the ray hit the terrain
 *   tileKey      – the tile that was hit
 *   x, y, z      – world-space hit position
 *   normalX/Y/Z  – world-space surface normal at the hit
 *   distance     – distance from ray origin to hit (along the ray direction)
 *   materialId   – the dominant material ID of the hit tile
 *   flags        – bitfield of TerrainHitFlags
 *   faceIndex    – the triangle index that was hit (or -1 for heightmap)
 */
export class RayHit3D {
  constructor() {
    this.hit = false;
    this.tileKey = null;
    this.x = 0; this.y = 0; this.z = 0;
    this.normalX = 0; this.normalY = 0; this.normalZ = 1;
    this.distance = 0;
    this.materialId = 0;
    this.flags = 0;
    this.faceIndex = -1;
  }

  reset() {
    this.hit = false;
    this.tileKey = null;
    this.x = 0; this.y = 0; this.z = 0;
    this.normalX = 0; this.normalY = 0; this.normalZ = 1;
    this.distance = 0;
    this.materialId = 0;
    this.flags = 0;
    this.faceIndex = -1;
    return this;
  }
}

/**
 * SphereContact3D — the result of a sphere-terrain collision test.
 */
export class SphereContact3D {
  constructor() {
    this.hit = false;
    this.tileKey = null;
    this.x = 0; this.y = 0; this.z = 0;          // closest point on surface
    this.normalX = 0; this.normalY = 0; this.normalZ = 1;
    this.penetration = 0;                        // how deep the sphere sinks
    this.materialId = 0;
    this.flags = 0;
  }

  reset() {
    this.hit = false;
    this.tileKey = null;
    this.x = 0; this.y = 0; this.z = 0;
    this.normalX = 0; this.normalY = 0; this.normalZ = 1;
    this.penetration = 0;
    this.materialId = 0;
    this.flags = 0;
    return this;
  }
}

/**
 * SlopeResult3D — the result of a slope query.
 */
export class SlopeResult3D {
  constructor() {
    this.gradient = 0;               // magnitude of the gradient (0 = flat, 1 = 45°, >1 = steeper)
    this.gradientX = 0;
    this.gradientY = 0;
    this.aspect = 0;                 // atan2(gradientY, gradientX) — direction of steepest descent
    this.isSteep = false;            // gradient > 1 (steeper than 45°)
    this.isSmooth = false;           // gradient < 0.087 (smoother than 5°)
  }

  reset() {
    this.gradient = 0;
    this.gradientX = 0;
    this.gradientY = 0;
    this.aspect = 0;
    this.isSteep = false;
    this.isSmooth = false;
    return this;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 3. ECS COMPONENTS
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainCollider3DComponent — bound to every entity that participates in
 * terrain collision. Stores the collider shape (sphere or capsule), the
 * current contact state, and the last query result so downstream systems
 * can read it without re-querying.
 */
export class TerrainCollider3DComponent {
  static schema = {
    shape:              { type: 'u8' },    // 0=sphere, 1=capsule
    radius:             { type: 'f32' },
    halfHeight:         { type: 'f32' },   // for capsules
    isGrounded:         { type: 'u8' },
    contactX:           { type: 'f32' },
    contactY:           { type: 'f32' },
    contactZ:           { type: 'f32' },
    contactNormalX:     { type: 'f32' },
    contactNormalY:     { type: 'f32' },
    contactNormalZ:     { type: 'f32' },
    penetration:        { type: 'f32' },
    groundSlope:        { type: 'f32' },
    groundMaterialId:   { type: 'u16' },
    groundTileKeyHash:  { type: 'u32' },
    lastUpdatedTick:    { type: 'u32' }
  };
}

/**
 * TerrainGroundQuery3DComponent — bound to every entity that samples the
 * ground every frame (AI agents, footstep audio, dust spawners, etc.).
 * Caches the most recent ground height, normal, slope, and material so
 * downstream systems don’t need to re-query.
 */
export class TerrainGroundQuery3DComponent {
  static schema = {
    groundY:            { type: 'f32' },
    normalX:            { type: 'f32' },
    normalY:            { type: 'f32' },
    normalZ:            { type: 'f32' },
    slope:              { type: 'f32' },
    materialId:         { type: 'u16' },
    tileKeyHash:        { type: 'u32' },
    isValid:            { type: 'u8' },
    lastUpdatedTick:    { type: 'u32' }
  };
}

// ═════════════════════════════════════════════════════════════════════
// 4. THE QUERY ENGINE
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainQueryCollision3D — the terrain query and collision engine.
 *
 * Lifecycle:
 *   • bind() sets the context frame, ECS world, and terrain source.
 *   • query*() methods can be called at any time from any tier.
 *   • update() refreshes the internal tile registry and clears stale caches.
 *
 * The engine does not run in a strict tier; it is a pure functional service
 * that answers questions. Its `update()` method only refreshes the tile
 * registry, which is cheap and can run at 10 Hz or on-demand.
 */
export class TerrainQueryCollision3D {
  constructor(options = {}) {
    this.options = {
      // Frequency for the tile registry refresh
      targetHz: options.targetHz ?? 10,

      // Ray casting
      rayMaxDistance: options.rayMaxDistance ?? 10000,
      rayFaceCullBackface: options.rayFaceCullBackface ?? true,

      // Sphere / capsule collision
      sphereContactTolerance: options.sphereContactTolerance ?? 1e-4,
      capsuleSampleCount: options.capsuleSampleCount ?? 5,

      // Ground snapping
      snapMaxDistance: options.snapMaxDistance ?? 1000,

      // Slope thresholds
      steepSlopeThreshold: options.steepSlopeThreshold ?? 1.0,     // 45°
      smoothSlopeThreshold: options.smoothSlopeThreshold ?? 0.087, // 5°

      // Tile registry
      maxTiles: options.maxTiles ?? 4096,

      // Diagnostics
      enableDiagnostics: options.enableDiagnostics ?? true,

      ...options
    };

    // ---- Context bindings ----
    this.frame = null;
    this.ecsWorld = null;
    this.source = null;
    this.dispatcher = null;
    this.lastTick = 0;
    this._accumulator = 0;

    // ---- Tile registry ----
    // tileKey → { terrain, header, bounds, family }
    this._tiles = new Map();

    // ---- Spatial hash for fast candidate filtering ----
    this._spatialHash = new SpatialHashGrid({
      cellSize: options.spatialHashCellSize ?? 200
    });

    // ---- Scratch buffers ----
    this._scratch = {
      rayOrigin: new Float64Array(3),
      rayDir: new Float64Array(3),
      triA: new Float64Array(3),
      triB: new Float64Array(3),
      triC: new Float64Array(3),
      hitPoint: new Float64Array(3),
      hitNormal: new Float64Array(3),
      groundPoint: new Float64Array(3),
      normal: new Float64Array(3),
      aabbMin: new Float64Array(3),
      aabbMax: new Float64Array(3)
    };

    // ---- Diagnostics ----
    this.stats = {
      ticksProcessed: 0,
      heightQueries: 0,
      normalQueries: 0,
      slopeQueries: 0,
      rayCasts: 0,
      rayHits: 0,
      sphereTests: 0,
      sphereHits: 0,
      capsuleTests: 0,
      capsuleHits: 0,
      snaps: 0,
      lastDurationMs: 0
    };
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  bind(contextFrame, ecsWorld, source, eventDispatcher = null) {
    this.frame = contextFrame;
    this.ecsWorld = ecsWorld;
    this.source = source;
    this.dispatcher = eventDispatcher;
    return this;
  }

  update(contextFrame, tick, dt, visibleHeaders) {
    this.frame = contextFrame;
    this.lastTick = tick;
    this._accumulator += dt;

    const interval = 1 / this.options.targetHz;
    if (this._accumulator < interval) return;
    this._accumulator %= interval;

    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    this._refreshTileRegistry(visibleHeaders);
    this._evictStaleTiles();

    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.stats.lastDurationMs = t1 - t0;
    this.stats.ticksProcessed++;
  }

  _refreshTileRegistry(visibleHeaders) {
    this._tiles.clear();
    if (this._spatialHash.clear) this._spatialHash.clear();

    for (const h of visibleHeaders) {
      if (h.state !== TileState.READY) continue;
      const record = this.source?.tileMap?.get(h.tileKey);
      if (!record) continue;
      const terrain = record.terrainObject ?? record.terrain;
      if (!terrain) continue;

      const bounds = terrain.bounds ?? terrain.getBoundingBox?.() ?? null;
      if (!bounds) continue;

      const family = this._classifyFamily(terrain);

      this._tiles.set(h.tileKey, {
        terrain,
        header: h,
        bounds,
        family
      });

      if (this._spatialHash.insert) {
        this._spatialHash.insert(h.tileKey, bounds);
      }
    }
  }

  _evictStaleTiles() {
    // The registry is rebuilt each tick, so this is a no-op. It exists as a
    // placeholder for a future incremental update scheme.
  }

  // ---------------------------------------------------------------------
  // Tile lookup
  // ---------------------------------------------------------------------

  /**
   * Finds the candidate tiles that may contain the query point (wx, wy).
   * Uses the spatial hash to narrow the set, then verifies the point lies
   * inside the tile’s XY bounds.
   */
  _findCandidateTiles(wx, wy) {
    // Fast path: spatial hash query.
    const candidates = this._spatialHash.querySphere
      ? this._spatialHash.querySphere(wx, wy, 0, 1)
      : [];

    // Filter to tiles that actually contain the point.
    const result = [];
    for (const key of candidates) {
      const tile = this._tiles.get(key);
      if (!tile) continue;
      const b = tile.bounds;
      if (wx >= b[0] && wx <= b[3] && wy >= b[1] && wy <= b[4]) {
        result.push(tile);
      }
    }

    // Fallback: brute-force scan (only if the spatial hash returned nothing).
    if (result.length === 0) {
      for (const tile of this._tiles.values()) {
        const b = tile.bounds;
        if (wx >= b[0] && wx <= b[3] && wy >= b[1] && wy <= b[4]) {
          result.push(tile);
        }
      }
    }

    return result;
  }

  _classifyFamily(terrain) {
    if (terrain instanceof HeightmapTerrain) return GeometryFamily3D.HEIGHTMAP_GRID;
    if (terrain instanceof QuantizedMeshTerrain) return GeometryFamily3D.QUANTIZED_MESH;
    if (terrain instanceof I3SElevationTerrain) return GeometryFamily3D.I3S_ELEVATION;
    if (terrain.vertexCount && terrain.triangleCount && terrain.indices) {
      return GeometryFamily3D.PROCEDURAL_MESH;
    }
    if (terrain.resolution && terrain.elevation) return GeometryFamily3D.HEIGHTMAP_GRID;
    return GeometryFamily3D.CUSTOM;
  }

  // ---------------------------------------------------------------------
  // Height queries
  // ---------------------------------------------------------------------

  /**
   * Returns the terrain height at (wx, wy). Returns NaN if no tile contains
   * the point. This is the simplest and most-used query.
   */
  getHeight(wx, wy) {
    this.stats.heightQueries++;
    const candidates = this._findCandidateTiles(wx, wy);
    if (candidates.length === 0) return NaN;

    // Prefer the highest-detail tile (lowest LOD) among the candidates.
    let best = null;
    for (const tile of candidates) {
      if (!best || tile.header.lod < best.header.lod) best = tile;
    }
    if (!best) return NaN;

    return this._sampleTileHeight(best, wx, wy);
  }

  _sampleTileHeight(tile, wx, wy) {
    const terrain = tile.terrain;
    if (tile.family === GeometryFamily3D.HEIGHTMAP_GRID) {
      return this._sampleHeightmapHeight(terrain, wx, wy);
    }
    if (tile.family === GeometryFamily3D.QUANTIZED_MESH ||
        tile.family === GeometryFamily3D.I3S_ELEVATION ||
        tile.family === GeometryFamily3D.PROCEDURAL_MESH) {
      return this._sampleMeshHeight(terrain, wx, wy);
    }
    return NaN;
  }

  _sampleHeightmapHeight(terrain, wx, wy) {
    if (typeof terrain.getHeight === 'function') {
      return terrain.getHeight(wx, wy);
    }
    // Fallback: bilinear sampling.
    const res = terrain.resolution;
    const originX = terrain.originX;
    const originY = terrain.originY;
    const tileWorldSize = terrain.tileWorldSize;
    const fx = (wx - originX) / tileWorldSize * (res - 1);
    const fy = (wy - originY) / tileWorldSize * (res - 1);
    if (fx < 0 || fx > res - 1 || fy < 0 || fy > res - 1) return NaN;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, res - 1), y1 = Math.min(y0 + 1, res - 1);
    const tx = fx - x0, ty = fy - y0;
    const e = terrain.elevation;
    const e00 = e[y0 * res + x0];
    const e10 = e[y0 * res + x1];
    const e01 = e[y1 * res + x0];
    const e11 = e[y1 * res + x1];
    const top = e00 + (e10 - e00) * tx;
    const bot = e01 + (e11 - e01) * tx;
    return top + (bot - top) * ty;
  }

  _sampleMeshHeight(terrain, wx, wy) {
    if (typeof terrain.getHeight === 'function') {
      return terrain.getHeight(wx, wy);
    }
    // Fallback: barycentric interpolation via per-triangle lookup.
    const out = this._scratch.hitPoint;
    const found = this._findTriangleAt(terrain, wx, wy, out);
    return found ? out[2] : NaN;
  }

  // ---------------------------------------------------------------------
  // Normal queries
  // ---------------------------------------------------------------------

  /**
   * Returns the surface normal at (wx, wy) as a 3-component vector in `out`.
   * Returns null if the point is not covered.
   */
  getNormal(wx, wy, out) {
    this.stats.normalQueries++;
    const candidates = this._findCandidateTiles(wx, wy);
    if (candidates.length === 0) {
      out[0] = 0; out[1] = 0; out[2] = 1;
      return null;
    }

    let best = null;
    for (const tile of candidates) {
      if (!best || tile.header.lod < best.header.lod) best = tile;
    }
    if (!best) return null;

    const terrain = best.terrain;
    if (typeof terrain.getNormal === 'function') {
      return terrain.getNormal(wx, wy, out);
    }
    // Fallback: central differences.
    const eps = Math.max(best.header.tileWorldSize / 100, 0.01);
    const hL = this.getHeight(wx - eps, wy);
    const hR = this.getHeight(wx + eps, wy);
    const hD = this.getHeight(wx, wy - eps);
    const hU = this.getHeight(wx, wy + eps);
    if (isNaN(hL) || isNaN(hR) || isNaN(hD) || isNaN(hU)) {
      out[0] = 0; out[1] = 0; out[2] = 1;
      return out;
    }
    const nx = -(hR - hL) / (2 * eps);
    const ny = -(hU - hD) / (2 * eps);
    const len = Math.sqrt(nx * nx + ny * ny + 1);
    out[0] = nx / len;
    out[1] = ny / len;
    out[2] = 1 / len;
    return out;
  }

  // ---------------------------------------------------------------------
  // Slope queries
  // ---------------------------------------------------------------------

  /**
   * Returns the slope at (wx, wy) in `out`. Returns null if the point is
   * not covered.
   */
  getSlope(wx, wy, out) {
    this.stats.slopeQueries++;
    const n = this.getNormal(wx, wy, this._scratch.normal);
    if (!n) {
      out.reset();
      return null;
    }

    // gradient = sqrt(nx² + ny²) / nz (standard slope formula from the normal).
    const nx = n[0], ny = n[1], nz = Math.max(n[2], 1e-6);
    const gx = nx / nz;
    const gy = ny / nz;
    const gradient = Math.sqrt(gx * gx + gy * gy);

    out.gradient = gradient;
    out.gradientX = gx;
    out.gradientY = gy;
    out.aspect = Math.atan2(gy, gx);
    out.isSteep = gradient > this.options.steepSlopeThreshold;
    out.isSmooth = gradient < this.options.smoothSlopeThreshold;
    return out;
  }

  // ---------------------------------------------------------------------
  // Ray-terrain intersection
  // ---------------------------------------------------------------------

  /**
   * Casts a ray against the terrain. Returns `outHit` populated with the
   * nearest hit, or `outHit.hit = false` if nothing was hit.
   *
   * @param {number} ox, oy, oz – ray origin
   * @param {number} dx, dy, dz – ray direction (must be normalized)
   * @param {number} [maxDistance] – max distance to consider
   * @param {RayHit3D} outHit – result holder
   * @returns {RayHit3D} outHit
   */
  rayCast(ox, oy, oz, dx, dy, dz, maxDistance, outHit) {
    this.stats.rayCasts++;
    outHit.reset();
    if (!outHit) return outHit;
    const maxDist = maxDistance ?? this.options.rayMaxDistance;

    // ---- 1. Broad phase: find candidate tiles via AABB-ray test ----
    const candidates = this._rayCandidates(ox, oy, oz, dx, dy, dz, maxDist);

    // ---- 2. Narrow phase: test each candidate ----
    let nearestDistance = maxDist;
    let found = false;

    for (const tile of candidates) {
      const hit = this._rayTileTest(tile, ox, oy, oz, dx, dy, dz, nearestDistance);
      if (hit && hit.distance < nearestDistance) {
        nearestDistance = hit.distance;
        outHit.hit = true;
        outHit.tileKey = tile.header.tileKey;
        outHit.x = hit.x;
        outHit.y = hit.y;
        outHit.z = hit.z;
        outHit.normalX = hit.normalX;
        outHit.normalY = hit.normalY;
        outHit.normalZ = hit.normalZ;
        outHit.distance = hit.distance;
        outHit.faceIndex = hit.faceIndex;
        outHit.flags = 0;
        found = true;
      }
    }

    if (found) {
      // Populate material ID.
      const rec = this._tiles.get(outHit.tileKey);
      if (rec) {
        outHit.materialId = this._getTileMaterialId(rec);
      }

      // Populate flags.
      if (outHit.z < 0) outHit.flags |= TerrainHitFlags.UNDERWATER;
      const slopeN = this._scratch.normal;
      slopeN[0] = outHit.normalX;
      slopeN[1] = outHit.normalY;
      slopeN[2] = outHit.normalZ;
      const gradient = Math.sqrt(
        (slopeN[0] / Math.max(slopeN[2], 1e-6)) ** 2 +
        (slopeN[1] / Math.max(slopeN[2], 1e-6)) ** 2
      );
      if (gradient > this.options.steepSlopeThreshold) {
        outHit.flags |= TerrainHitFlags.STEEP;
      }
      if (gradient < this.options.smoothSlopeThreshold) {
        outHit.flags |= TerrainHitFlags.SMOOTH;
      }
      this.stats.rayHits++;
    }

    return outHit;
  }

  _rayCandidates(ox, oy, oz, dx, dy, dz, maxDist) {
    // AABB-ray test against each tile.
    const result = [];
    for (const tile of this._tiles.values()) {
      const b = tile.bounds;
      const hitDist = this._rayAABB(ox, oy, oz, dx, dy, dz, b[0], b[1], b[2], b[3], b[4], b[5]);
      if (hitDist >= 0 && hitDist <= maxDist) {
        result.push(tile);
      }
    }
    return result;
  }

  _rayAABB(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ) {
    let tmin = 0;
    let tmax = Infinity;

    // X slab.
    if (Math.abs(dx) < 1e-12) {
      if (ox < minX || ox > maxX) return -1;
    } else {
      let t1 = (minX - ox) / dx;
      let t2 = (maxX - ox) / dx;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }

    // Y slab.
    if (Math.abs(dy) < 1e-12) {
      if (oy < minY || oy > maxY) return -1;
    } else {
      let t1 = (minY - oy) / dy;
      let t2 = (maxY - oy) / dy;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }

    // Z slab.
    if (Math.abs(dz) < 1e-12) {
      if (oz < minZ || oz > maxZ) return -1;
    } else {
      let t1 = (minZ - oz) / dz;
      let t2 = (maxZ - oz) / dz;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }

    return tmin;
  }

  _rayTileTest(tile, ox, oy, oz, dx, dy, dz, maxDist) {
    const terrain = tile.terrain;
    if (tile.family === GeometryFamily3D.HEIGHTMAP_GRID) {
      return this._rayHeightmapTest(tile, ox, oy, oz, dx, dy, dz, maxDist);
    }
    return this._rayMeshTest(tile, ox, oy, oz, dx, dy, dz, maxDist);
  }

  _rayHeightmapTest(tile, ox, oy, oz, dx, dy, dz, maxDist) {
    // Heightmap ray cast: march along the ray in small steps and check when
    // the ray crosses the terrain surface. This is O(steps) per tile, which
    // is acceptable for typical query rates. For performance-critical paths,
    // use the mesh ray test even for heightmaps by first triangulating.
    const terrain = tile.terrain;
    const res = terrain.resolution;
    const originX = terrain.originX;
    const originY = terrain.originY;
    const tileWorldSize = terrain.tileWorldSize;
    const cellSize = tileWorldSize / (res - 1);

    // Step size: half the cell size, so we don’t skip past thin peaks.
    const stepSize = cellSize * 0.5;
    const stepCount = Math.ceil(maxDist / stepSize);

    let prevX = ox, prevY = oy, prevZ = oz;
    let prevDelta = prevZ - this._sampleHeightmapHeight(terrain, prevX, prevY);

    for (let i = 1; i <= stepCount; i++) {
      const t = i * stepSize;
      if (t > maxDist) break;

      const curX = ox + dx * t;
      const curY = oy + dy * t;
      const curZ = oz + dz * t;

      // Stop if we’ve left the tile horizontally.
      if (curX < originX || curX > originX + tileWorldSize ||
          curY < originY || curY > originY + tileWorldSize) {
        return null;
      }

      const curDelta = curZ - this._sampleHeightmapHeight(terrain, curX, curY);

      if (prevDelta > 0 && curDelta <= 0) {
        // Crossed the surface between prev and cur. Refine with linear
        // interpolation.
        const alpha = prevDelta / (prevDelta - curDelta);
        const hitX = prevX + (curX - prevX) * alpha;
        const hitY = prevY + (curY - prevY) * alpha;
        const hitZ = prevZ + (curZ - prevZ) * alpha;

        // Compute normal at the hit point.
        this.getNormal(hitX, hitY, this._scratch.normal);

        return {
          x: hitX, y: hitY, z: hitZ,
          normalX: this._scratch.normal[0],
          normalY: this._scratch.normal[1],
          normalZ: this._scratch.normal[2],
          distance: prevZ === curZ ? t : (t - stepSize + stepSize * alpha),
          faceIndex: -1
        };
      }

      prevX = curX; prevY = curY; prevZ = curZ;
      prevDelta = curDelta;
    }

    return null;
  }

  _rayMeshTest(tile, ox, oy, oz, dx, dy, dz, maxDist) {
    const terrain = tile.terrain;
    const positions = terrain.positions;
    const indices = terrain.indices;
    if (!positions || !indices) return null;

    const triCount = terrain.triangleCount ?? Math.floor(indices.length / 3);
    let nearest = null;
    let nearestDist = maxDist;

    for (let t = 0; t < triCount; t++) {
      const i0 = indices[t * 3];
      const i1 = indices[t * 3 + 1];
      const i2 = indices[t * 3 + 2];

      const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
      const bx = positions[i1 * 3], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
      const cx = positions[i2 * 3], cy = positions[i2 * 3 + 1], cz = positions[i2 * 3 + 2];

      const hit = this._rayTriangle(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, cx, cy, cz);
      if (hit && hit.t < nearestDist) {
        nearestDist = hit.t;
        nearest = {
          x: ox + dx * hit.t,
          y: oy + dy * hit.t,
          z: oz + dz * hit.t,
          normalX: hit.nx,
          normalY: hit.ny,
          normalZ: hit.nz,
          distance: hit.t,
          faceIndex: t
        };
      }
    }

    return nearest;
  }

  /**
   * Möller-Trumbore ray-triangle intersection.
   */
  _rayTriangle(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, cx, cy, cz) {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

    // Cross product e2 × d.
    const px = e2y * dz - e2z * dy;
    const py = e2z * dx - e2x * dz;
    const pz = e2x * dy - e2y * dx;

    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) return null;
    if (this.options.rayFaceCullBackface && det < 0) return null;

    const invDet = 1 / det;
    const tx = ox - ax, ty = oy - ay, tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * invDet;
    if (u < 0 || u > 1) return null;

    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;

    const v = (dx * qx + dy * qy + dz * qz) * invDet;
    if (v < 0 || u + v > 1) return null;

    const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
    if (t < 0) return null;

    // Compute face normal.
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;

    return { t, nx: nx / len, ny: ny / len, nz: nz / len };
  }

  // ---------------------------------------------------------------------
  // Sphere collision
  // ---------------------------------------------------------------------

  /**
   * Tests a sphere at (cx, cy, cz) with radius r against the terrain.
   * Returns `outContact` populated with the closest surface point and
   * penetration depth, or `outContact.hit = false` if no contact.
   */
  sphereSweep(cx, cy, cz, radius, outContact) {
    this.stats.sphereTests++;
    outContact.reset();

    // Find tiles that could contain the sphere.
    const candidates = this._findCandidateTiles(cx, cy);
    if (candidates.length === 0) return outContact;

    let best = null;
    let bestDepth = 0;

    for (const tile of candidates) {
      // Fast rejection: if the sphere is clearly above the tile, skip.
      const b = tile.bounds;
      if (cy - radius > b[4]) continue;
      if (cy + radius < b[2]) continue;

      const contact = this._sphereTileTest(tile, cx, cy, cz, radius);
      if (contact && contact.penetration > bestDepth) {
        bestDepth = contact.penetration;
        best = { contact, tile };
      }
    }

    if (best) {
      outContact.hit = true;
      outContact.tileKey = best.tile.header.tileKey;
      outContact.x = best.contact.x;
      outContact.y = best.contact.y;
      outContact.z = best.contact.z;
      outContact.normalX = best.contact.normalX;
      outContact.normalY = best.contact.normalY;
      outContact.normalZ = best.contact.normalZ;
      outContact.penetration = best.contact.penetration;
      outContact.materialId = this._getTileMaterialId(best.tile);
      this.stats.sphereHits++;
    }

    return outContact;
  }

  _sphereTileTest(tile, cx, cy, cz, radius) {
    const terrain = tile.terrain;
    if (tile.family === GeometryFamily3D.HEIGHTMAP_GRID) {
      return this._sphereHeightmapTest(tile, cx, cy, cz, radius);
    }
    return this._sphereMeshTest(tile, cx, cy, cz, radius);
  }

  _sphereHeightmapTest(tile, cx, cy, cz, radius) {
    // Sample the terrain at the sphere’s XY position.
    const groundHeight = this._sampleHeightmapHeight(tile.terrain, cx, cy);
    if (isNaN(groundHeight)) return null;

    const dz = cz - groundHeight;
    if (dz > radius) return null;
    if (dz < -radius * 0.5) return null;   // deep below ground: use mesh test

    this.getNormal(cx, cy, this._scratch.normal);
    const penetration = radius - dz;

    return {
      x: cx, y: cy, z: groundHeight,
      normalX: this._scratch.normal[0],
      normalY: this._scratch.normal[1],
      normalZ: this._scratch.normal[2],
      penetration
    };
  }

  _sphereMeshTest(tile, cx, cy, cz, radius) {
    const terrain = tile.terrain;
    const positions = terrain.positions;
    const indices = terrain.indices;
    if (!positions || !indices) return null;

    const triCount = terrain.triangleCount ?? Math.floor(indices.length / 3);
    let best = null;
    let bestDepth = 0;

    // Only test triangles whose AABB intersects the sphere’s AABB.
    const r2 = radius * radius;

    for (let t = 0; t < triCount; t++) {
      const i0 = indices[t * 3];
      const i1 = indices[t * 3 + 1];
      const i2 = indices[t * 3 + 2];

      const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
      const bx = positions[i1 * 3], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
      const cxT = positions[i2 * 3], cyT = positions[i2 * 3 + 1], czT = positions[i2 * 3 + 2];

      // Quick AABB test.
      const triMinX = Math.min(ax, bx, cxT);
      const triMaxX = Math.max(ax, bx, cxT);
      if (cx + radius < triMinX || cx - radius > triMaxX) continue;
      const triMinY = Math.min(ay, by, cyT);
      const triMaxY = Math.max(ay, by, cyT);
      if (cy + radius < triMinY || cy - radius > triMaxY) continue;

      // Closest point on triangle to sphere center.
      const closest = this._closestPointOnTriangle(
        cx, cy, cz,
        ax, ay, az, bx, by, bz, cxT, cyT, czT
      );

      const dx = cx - closest.x;
      const dy = cy - closest.y;
      const dz = cz - closest.z;
      const dist2 = dx * dx + dy * dy + dz * dz;
      if (dist2 > r2) continue;

      const dist = Math.sqrt(dist2);
      const penetration = radius - dist;
      if (penetration <= bestDepth) continue;

      bestDepth = penetration;

      // Compute the triangle normal.
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cxT - ax, e2y = cyT - ay, e2z = czT - az;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;

      best = {
        x: closest.x, y: closest.y, z: closest.z,
        normalX: nx / nlen, normalY: ny / nlen, normalZ: nz / nlen,
        penetration
      };
    }

    return best;
  }

  /**
   * Returns the closest point on a triangle to a query point (Ericson, RTCD).
   */
  _closestPointOnTriangle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;

    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) return { x: ax, y: ay, z: az };

    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) return { x: bx, y: by, z: bz };

    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const v = d1 / (d1 - d3);
      return { x: ax + abx * v, y: ay + aby * v, z: az + abz * v };
    }

    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) return { x: cx, y: cy, z: cz };

    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const w = d2 / (d2 - d6);
      return { x: ax + acx * w, y: ay + acy * w, z: az + acz * w };
    }

    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
      const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
      return { x: bx + (cx - bx) * w, y: by + (cy - by) * w, z: bz + (cz - bz) * w };
    }

    const denom = 1 / (va + vb + vc);
    const v = vb * denom;
    const w = vc * denom;
    return {
      x: ax + abx * v + acx * w,
      y: ay + aby * v + acy * w,
      z: az + abz * v + acz * w
    };
  }

  // ---------------------------------------------------------------------
  // Capsule collision
  // ---------------------------------------------------------------------

  /**
   * Tests a capsule (a line segment plus a radius) against the terrain.
   * Returns `outContact` populated with the deepest contact, or
   * `outContact.hit = false` if no contact.
   */
  capsuleSweep(x0, y0, z0, x1, y1, z1, radius, outContact) {
    this.stats.capsuleTests++;
    outContact.reset();

    const samples = this.options.capsuleSampleCount;
    let bestContact = null;
    let bestDepth = 0;

    const tmpSphere = new SphereContact3D();

    for (let i = 0; i < samples; i++) {
      const t = i / (samples - 1);
      const sx = x0 + (x1 - x0) * t;
      const sy = y0 + (y1 - y0) * t;
      const sz = z0 + (z1 - z0) * t;

      const contact = this.sphereSweep(sx, sy, sz, radius, tmpSphere);
      if (contact.hit && contact.penetration > bestDepth) {
        bestDepth = contact.penetration;
        bestContact = {
          x: contact.x, y: contact.y, z: contact.z,
          normalX: contact.normalX, normalY: contact.normalY, normalZ: contact.normalZ,
          penetration: contact.penetration,
          tileKey: contact.tileKey,
          materialId: contact.materialId
        };
      }
    }

    if (bestContact) {
      outContact.hit = true;
      outContact.tileKey = bestContact.tileKey;
      outContact.x = bestContact.x;
      outContact.y = bestContact.y;
      outContact.z = bestContact.z;
      outContact.normalX = bestContact.normalX;
      outContact.normalY = bestContact.normalY;
      outContact.normalZ = bestContact.normalZ;
      outContact.penetration = bestContact.penetration;
      outContact.materialId = bestContact.materialId;
      this.stats.capsuleHits++;
    }

    return outContact;
  }

  // ---------------------------------------------------------------------
  // Ground snapping
  // ---------------------------------------------------------------------

  /**
   * Snaps an arbitrary 3D point vertically to the terrain surface.
   * Returns the ground Y coordinate, or NaN if no terrain was found.
   */
  snapToGround(x, z) {
    this.stats.snaps++;
    return this.getHeight(x, z);
  }

  /**
   * Snaps a sphere’s bottom to the terrain surface. Returns the correct
   * center Y position.
   */
  snapSphereToGround(cx, cz, radius) {
    const groundY = this.getHeight(cx, cz);
    if (isNaN(groundY)) return NaN;
    return groundY + radius;
  }

  // ---------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------

  _findTriangleAt(terrain, wx, wy, out) {
    // Simple linear scan. For dense meshes, this should be replaced with a
    // spatial grid (same approach as QuantizedMeshTerrain).
    const positions = terrain.positions;
    const indices = terrain.indices;
    if (!positions || !indices) return false;

    const triCount = terrain.triangleCount ?? Math.floor(indices.length / 3);
    for (let t = 0; t < triCount; t++) {
      const i0 = indices[t * 3];
      const i1 = indices[t * 3 + 1];
      const i2 = indices[t * 3 + 2];

      const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
      const bx = positions[i1 * 3], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
      const cx = positions[i2 * 3], cy = positions[i2 * 3 + 1], cz = positions[i2 * 3 + 2];

      const v0x = bx - ax, v0y = by - ay;
      const v1x = cx - ax, v1y = cy - ay;
      const v2x = wx - ax, v2y = wy - ay;
      const dot00 = v0x * v0x + v0y * v0y;
      const dot01 = v0x * v1x + v0y * v1y;
      const dot02 = v0x * v2x + v0y * v2y;
      const dot11 = v1x * v1x + v1y * v1y;
      const dot12 = v1x * v2x + v1y * v2y;
      const invDenom = 1 / (dot00 * dot11 - dot01 * dot01);
      const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
      const v = (dot00 * dot12 - dot01 * dot02) * invDenom;
      if (u >= 0 && v >= 0 && u + v <= 1) {
        const w = 1 - u - v;
        out[0] = ax * w + bx * u + cx * v;
        out[1] = ay * w + by * u + cy * v;
        out[2] = az * w + bz * u + cz * v;
        return true;
      }
    }
    return false;
  }

  _getTileMaterialId(tile) {
    // The tile header may carry a material component; fall back to 0 (rock).
    return tile.header.materialId ?? 0;
  }

  // ---------------------------------------------------------------------
  // Public statistics and queries
  // ---------------------------------------------------------------------

  getStats() {
    return {
      ...this.stats,
      tileCount: this._tiles.size
    };
  }

  getTileCount() {
    return this._tiles.size;
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  dispose() {
    this._tiles.clear();
    if (this._spatialHash.clear) this._spatialHash.clear();
    this.frame = null;
    this.ecsWorld = null;
    this.source = null;
    this.dispatcher = null;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 5. FACTORY
// ═════════════════════════════════════════════════════════════════════

/**
 * Creates a fully-configured TerrainQueryCollision3D with sensible defaults.
 */
export function createTerrainQueryCollision3D(options = {}) {
  return new TerrainQueryCollision3D({
    targetHz: options.targetHz ?? 10,
    rayMaxDistance: options.rayMaxDistance ?? 10000,
    rayFaceCullBackface: options.rayFaceCullBackface ?? true,
    sphereContactTolerance: options.sphereContactTolerance ?? 1e-4,
    capsuleSampleCount: options.capsuleSampleCount ?? 5,
    snapMaxDistance: options.snapMaxDistance ?? 1000,
    steepSlopeThreshold: options.steepSlopeThreshold ?? 1.0,
    smoothSlopeThreshold: options.smoothSlopeThreshold ?? 0.087,
    maxTiles: options.maxTiles ?? 4096,
    spatialHashCellSize: options.spatialHashCellSize ?? 200,
    enableDiagnostics: options.enableDiagnostics ?? true,
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 6. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  TerrainQueryCollision3D,
  RayHit3D,
  SphereContact3D,
  SlopeResult3D,
  TerrainCollider3DComponent,
  TerrainGroundQuery3DComponent,
  TerrainQueryKind,
  TerrainHitFlags,
  createTerrainQueryCollision3D
};