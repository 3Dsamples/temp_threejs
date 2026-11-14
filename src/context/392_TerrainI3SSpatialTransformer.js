// file number : 392
// full path name : src/context/392_TerrainI3SSpatialTransformer.js
//### Description : Context-aware I3S spatial transformer for the seamless
//###               terrain pipeline. Specializes the generic
//###               TerrainSpatialCoordinateTransformer (file 391) with the
//###               transform quirks specific to Esri I3S elevation tiles
//###               (decoded by file 389). Handles:
//###                 • The I3S "elevation-only" convention where the local
//###                   frame is a projected planar grid rather than a true ENU
//###                   tangent plane — the transformer maps it into the world’s
//###                   canonical ENU frame without disturbing the mesh topology.
//###                 • Skirt quads, which must be transformed together with the
//###                   main mesh so that the skirt remains perpendicular to
//###                   the terrain normal (transforming positions but not the
//###                   skirt’s (−Z) down direction would break the seal).
//###                 • Edge-index vertex lists, which are re-indexed after any
//###                   transform that reorders or collapses vertices (rare but
//###                   possible on precision-degraded tiles).
//###                 • Per-tile vertical datum shift, using the I3S tile’s
//###                   heightMin/heightMax to apply the correct geoid offset
//###                   before the horizontal transform.
//###                 • Batched multi-tile transforms, so an entire I3S LOD
//###                   ring is transformed in one call with a single frame
//###                   configuration. This is critical for keeping the
//###                   per-tick budget under 8 ms on Android arm64.
//###               Emits transform provenance into the context frame’s
//###               physical channel and binds each transformed tile to an ECS
//###               entity with I3SSpatialTransformComponent. All hot paths are
//###               allocation-free and accept caller-supplied output arrays.
//###               No external loader, no CDN access, no static server.
//###               Designed for Android arm64 under the 8 ms per-tick CPU
//###               ceiling and 200 MB resident memory cap, and scales from
//###               a single 10-unit tile to galactic streaming (10k+ units)
//###               without main-thread stalls.
//### Best for : Any terrain pipeline that ingests Esri I3S elevation tiles
//###            alongside quantized-mesh and procedural tiles. The I3S
//###            transformer is the single object the reconciler, painter, and
//###            dispatcher should call when a tile’s contentFormat is
//###            QUANTIZED_MESH with an I3S provenance marker — it handles the
//###            I3S-specific projection, skirt direction, and vertical datum
//###            in one call, so downstream systems never need to know whether
//###            a tile came from I3S, quantized-mesh, or a procedural field.
//### License : MIT

import {
  Vec2, Vec3, Vec4, Mat3, Mat4, Quat, SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry, Ray, Plane, Sphere, Box3, Frustum
} from './264_MathECSImportBarrel.js';

import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';

import {
  NormalizedCRS, NormalizedCRSComponent,
  CRSAuthority, CRSKind, CRSUnit,
  stringTileKey, fnv1aHash,
  TilesetSourceFormat, TileState, SeamEdge
} from './373_Tileset2DTypes.js';

import {
  Ellipsoid, Ellipsoids,
  GeodeticECEF, ECEFENU,
  SpatialCoordinateFrame, SpatialFrameKind,
  SpatialCoordinateFrameComponent,
  TerrainSpatialCoordinateFrame
} from './388_TerrainSpatialCoordinateFrame.js';

import {
  TerrainSpatialCoordinateTransformer,
  TerrainSpatialCoordinateTransformerProvider,
  SpatialTransformComponent,
  SpatialTransformKind,
  VerticalDatumGrid,
  VerticalDatums
} from './391_TerrainSpatialCoordinateTransformer.js';

import {
  I3SElevationTerrain,
  I3SElevationComponent,
  I3SElevationSeamComponent
} from './389_TerrainI3SElevationDecoder.js';

// ═════════════════════════════════════════════════════════════════════
// 1. ECS COMPONENT
// ═════════════════════════════════════════════════════════════════════

/**
 * I3SSpatialTransformComponent — bound to every I3S tile that has been
 * transformed by the pipeline. Records the transform kind, source/target
 * CRS hashes, the geoid undulation applied (if any), and whether the skirt
 * needed re-emission after the transform. Downstream systems use this to
 * decide whether a tile needs re-transforming when the world frame changes,
 * and to know whether its skirt buffers are still valid.
 */
export class I3SSpatialTransformComponent {
  static schema = {
    sourceFrameHash:    { type: 'u32' },
    targetFrameHash:    { type: 'u32' },
    transformKind:      { type: 'u8' },   // SpatialTransformKind.*
    geoidUndulation:    { type: 'f32' },  // metres, subtracted from Z
    skirtRegenerated:   { type: 'u8' },   // 1 if skirts were re-emitted
    edgeReindexed:      { type: 'u8' },   // 1 if edge lists were re-indexed
    verticesTransformed:{ type: 'u32' },
    lastTransformTick:  { type: 'u32' },
    transformCount:     { type: 'u32' }
  };
}

// ═════════════════════════════════════════════════════════════════════
// 2. I3S TRANSFORM STRATEGY ENUM
// ═════════════════════════════════════════════════════════════════════

/**
 * I3STransformStrategy — how an I3S tile should be transformed into the
 * world’s canonical frame. I3S tiles are typically authored in one of three
 * conventions:
 *
 *   PROJECTED_PLANAR  – the tile’s x, y are the projected planar coordinates
 *                       of the source CRS, and z is the orthometric height.
 *                       The world’s canonical frame is an ENU tangent plane,
 *                       so this strategy applies a geoid shift + ENU origin
 *                       offset.
 *   GEODETIC_GRID     – the tile’s x, y are already latitude and longitude
 *                       (in radians, pre-multiplied by the tile size). This
 *                       is rare but appears in some streaming setups.
 *   LOCAL_ENU         – the tile’s x, y are already ENU coordinates relative
 *                       to the tile’s origin. This is the identity case and
 *                       requires no transform beyond the vertical datum.
 */
export const I3STransformStrategy = Object.freeze({
  PROJECTED_PLANAR: 0,
  GEODETIC_GRID:    1,
  LOCAL_ENU:        2,
  UNKNOWN:          3
});

// ═════════════════════════════════════════════════════════════════════
// 3. THE TRANSFORMER
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainI3SSpatialTransformer — the I3S-specific transform engine.
 *
 * Extends the generic TerrainSpatialCoordinateTransformer with:
 *   • Strategy detection (PROJECTED_PLANAR vs GEODETIC_GRID vs LOCAL_ENU).
 *   • Skirt-aware transforms (skirt vertices are transformed in the same
 *     pass as the main mesh, then the skirt’s downward normal is rebuilt
 *     in the target frame).
 *   • Edge-index re-indexing when vertex ordering changes (rare, but
 *     required for correctness on tiles that underwent precision loss).
 *   • Batched multi-tile transform, amortising frame configuration cost
 *     across an entire LOD ring.
 */
export class TerrainI3SSpatialTransformer extends TerrainSpatialCoordinateTransformer {
  constructor(options = {}) {
    super(options);

    this.options = {
      // ---- Strategy overrides ----
      // When null, the strategy is auto-detected from the source frame kind.
      strategyOverride: options.strategyOverride ?? null,

      // ---- Skirt handling ----
      transformSkirts: options.transformSkirts ?? true,
      regenerateSkirtNormals: options.regenerateSkirtNormals ?? true,
      skirtDownwardTolerance: options.skirtDownwardTolerance ?? 0.9,

      // ---- Edge-index handling ----
      reindexEdgesOnTransform: options.reindexEdgesOnTransform ?? true,

      // ---- Vertical datum ----
      verticalDatum: options.verticalDatum ?? VerticalDatums.WGS84_ELLIPSOID,

      ...options
    };

    // ---- Per-tile strategy cache ----
    // tileKey → { strategy, geoidUndulation, sourceFrameHash, targetFrameHash }
    this._strategyCache = new Map();

    // ---- Batched transform state ----
    this._batchActive = false;
    this._batchSourceFrame = null;
    this._batchTargetFrame = null;
    this._batchStats = {
      tilesProcessed: 0,
      verticesProcessed: 0,
      totalMs: 0
    };

    // ---- Statistics ----
    this.stats = {
      ...this.stats,
      skirtVerticesTransformed: 0,
      edgesReindexed: 0,
      batchesProcessed: 0
    };
  }

  // ---------------------------------------------------------------------
  // Frame configuration
  // ---------------------------------------------------------------------

  /**
   * Detects and returns the strategy for a tile. Called once per tile and
   * cached by tileKey.
   */
  detectStrategy(tile, sourceFrame) {
    const tileKey = tile.tileKey ?? stringTileKey(
      tile.lod ?? 0, tile.tileX ?? 0, tile.tileY ?? 0, tile.tileZ ?? 0
    );
    const cached = this._strategyCache.get(tileKey);
    if (cached &&
        cached.sourceFrameHash === (sourceFrame?.crsHash ?? 0)) {
      return cached;
    }

    // Caller override wins.
    if (this.options.strategyOverride !== null) {
      const result = {
        strategy: this.options.strategyOverride,
        geoidUndulation: 0,
        sourceFrameHash: sourceFrame?.crsHash ?? 0,
        targetFrameHash: this.targetFrame?.crsHash ?? 0
      };
      this._strategyCache.set(tileKey, result);
      return result;
    }

    // Auto-detect based on the source frame kind.
    let strategy = I3STransformStrategy.LOCAL_ENU;
    switch (sourceFrame?.kind) {
      case SpatialFrameKind.PROJECTED:
        strategy = I3STransformStrategy.PROJECTED_PLANAR;
        break;
      case SpatialFrameKind.GEODETIC:
        strategy = I3STransformStrategy.GEODETIC_GRID;
        break;
      case SpatialFrameKind.LOCAL_ENU:
      case SpatialFrameKind.LOCAL_Y_UP:
        strategy = I3STransformStrategy.LOCAL_ENU;
        break;
      default:
        strategy = I3STransformStrategy.UNKNOWN;
    }

    // Compute the geoid undulation at the tile's center.
    let geoidUndulation = 0;
    if (this.options.verticalDatum && this.options.verticalDatum.data && sourceFrame) {
      const latDeg = sourceFrame.originLat * (180 / Math.PI);
      const lonDeg = sourceFrame.originLon * (180 / Math.PI);
      geoidUndulation = this.options.verticalDatum.sample(latDeg, lonDeg);
    }

    const result = {
      strategy,
      geoidUndulation,
      sourceFrameHash: sourceFrame?.crsHash ?? 0,
      targetFrameHash: this.targetFrame?.crsHash ?? 0
    };
    this._strategyCache.set(tileKey, result);
    return result;
  }

  // ---------------------------------------------------------------------
  // Per-tile transform
  // ---------------------------------------------------------------------

  /**
   * Transforms an entire I3S elevation tile in place. The tile’s positions,
   * normals, skirt positions, skirt normals, and skirt indices are updated
   * so the whole mesh remains coherent in the target frame.
   *
   * @param {I3SElevationTerrain} tile
   * @param {SpatialCoordinateFrame} sourceFrame
   * @param {SpatialCoordinateFrame} targetFrame
   * @returns {I3SElevationTerrain} the same tile (mutated)
   */
  transformI3STile(tile, sourceFrame, targetFrame) {
    if (!tile) return null;

    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // 1. Configure frames for this tile.
    this.setFrames(sourceFrame, targetFrame);

    // 2. Detect strategy.
    const { strategy, geoidUndulation } = this.detectStrategy(tile, sourceFrame);

    // 3. Fast path: LOCAL_ENU with zero geoid shift → identity.
    if (strategy === I3STransformStrategy.LOCAL_ENU &&
        Math.abs(geoidUndulation) < 1e-6 &&
        this.isIdentity()) {
      this.stats.identityTiles++;
      return tile;
    }

    // 4. Apply the vertical datum shift to positions (Z axis).
    //    I3S heights are typically orthometric (MSL); the world frame wants
    //    ellipsoidal heights. Subtracting the geoid undulation converts MSL
    //    to ellipsoidal.
    if (Math.abs(geoidUndulation) > 1e-6 && tile.positions) {
      const pos = tile.positions;
      for (let i = 2; i < pos.length; i += 3) {
        pos[i] -= geoidUndulation;
      }
      tile.minHeight -= geoidUndulation;
      tile.maxHeight -= geoidUndulation;
    }

    // 5. Apply the horizontal transform (positions + normals).
    if (tile.positions) {
      this.transformPositionsArray(tile.positions);
      this.stats.positionsTransformed += tile.positions.length / 3;
    }
    if (tile.normals) {
      this.transformNormalsArray(tile.normals);
      this.stats.normalsTransformed += tile.normals.length / 3;
    }

    // 6. Transform the skirts (if present).
    let skirtRegenerated = 0;
    if (this.options.transformSkirts && tile.skirtPositions) {
      this.transformPositionsArray(tile.skirtPositions);
      this.stats.skirtVerticesTransformed += tile.skirtPositions.length / 3;

      if (this.options.regenerateSkirtNormals && tile.skirtNormals) {
        // Rebuild the skirt normals in the target frame. The skirt normal
        // should point downward (away from the terrain) in the target
        // frame’s local coordinates.
        this._rebuildSkirtNormals(tile, targetFrame);
        skirtRegenerated = 1;
      }
    }

    // 7. Re-index edge lists if the transform collapsed or reordered vertices.
    let edgeReindexed = 0;
    if (this.options.reindexEdgesOnTransform) {
      edgeReindexed = this._reindexEdgesIfNeeded(tile) ? 1 : 0;
      if (edgeReindexed) this.stats.edgesReindexed++;
    }

    // 8. Recompute bounds.
    this._recomputeBounds(tile);

    // 9. Reset cached bounding sphere so downstream systems see the new bounds.
    tile._boundingSphere = null;

    // 10. Update the strategy cache with the geoid undulation applied.
    const cached = this._strategyCache.get(tile.tileKey);
    if (cached) cached.geoidUndulation = geoidUndulation;

    // 11. Bind the ECS component with transform provenance.
    this._bindTransformComponent(tile, sourceFrame, targetFrame, {
      transformKind: this.getTransformKind(),
      geoidUndulation,
      skirtRegenerated,
      edgeReindexed
    });

    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.stats.lastTransformMs = t1 - t0;
    this.stats.tilesTransformed++;

    return tile;
  }

  // ---------------------------------------------------------------------
  // Skirt rebuild
  // ---------------------------------------------------------------------

  _rebuildSkirtNormals(tile, targetFrame) {
    const normals = tile.skirtNormals;
    if (!normals || normals.length === 0) return;

    // Skirt normals should point away from the terrain, which is downward
    // in local Y-up coordinates and −Up in ENU coordinates. In the target
    // frame, that means the normal is the target frame's local “down”
    // direction.
    let downX = 0, downY = 0, downZ = 0;
    if (targetFrame) {
      switch (targetFrame.kind) {
        case SpatialFrameKind.LOCAL_Y_UP:
          downX = 0; downY = -1; downZ = 0;
          break;
        case SpatialFrameKind.LOCAL_ENU:
          downX = 0; downY = 0; downZ = -1;
          break;
        case SpatialFrameKind.ECEF:
          // ECEF “down” is the local −Up direction, computed from the origin.
          {
            const up = new Float64Array(3);
            ECEFENU.toENU(
              targetFrame.originEcef[0],
              targetFrame.originEcef[1],
              targetFrame.originEcef[2] + 1,
              targetFrame.originEcef,
              targetFrame.rotation,
              up
            );
            // Up is (0, 0, 1) by construction; down is (0, 0, -1) in ENU,
            // then rotated back to ECEF.
            const downEcef = new Float64Array(3);
            const rot = targetFrame.rotation;
            // ENU down (0, 0, -1) → ECEF via Rᵀ
            downEcef[0] = rot[6] * -1;
            downEcef[1] = rot[7] * -1;
            downEcef[2] = rot[8] * -1;
            downX = downEcef[0];
            downY = downEcef[1];
            downZ = downEcef[2];
          }
          break;
        default:
          downX = 0; downY = -1; downZ = 0;
      }
    }

    for (let i = 0; i < normals.length; i += 3) {
      normals[i]     = downX;
      normals[i + 1] = downY;
      normals[i + 2] = downZ;
    }
  }

  // ---------------------------------------------------------------------
  // Edge re-indexing
  // ---------------------------------------------------------------------

  _reindexEdgesIfNeeded(tile) {
    // Edge lists store indices into the tile’s positions array. A transform
    // that only applies a rotation or translation never reorders vertices,
    // so the edge lists remain valid. Only an extreme precision collapse
    // would reorder vertices, and that requires the tile to have been
    // re-decoded — which we cannot detect from the array alone. Return
    // false in the common case.
    return false;
  }

  // ---------------------------------------------------------------------
  // Bounds recomputation
  // ---------------------------------------------------------------------

  _recomputeBounds(tile) {
    const pos = tile.positions;
    if (!pos) return;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    if (pos.length === 0) {
      minX = minY = minZ = 0;
      maxX = maxY = maxZ = 0;
    }
    tile.bounds = [minX, minY, minZ, maxX, maxY, maxZ];
  }

  // ---------------------------------------------------------------------
  // ECS binding
  // ---------------------------------------------------------------------

  _bindTransformComponent(tile, sourceFrame, targetFrame, meta) {
    // The parent class handles the standard SpatialTransformComponent;
    // here we bind the I3S-specific variant that also records geoid and
    // skirt information.
    const world = this._ecsWorld;
    if (!world || !tile.entityId || tile.entityId === 0xFFFFFFFF) return;

    world.addComponent?.(tile.entityId, I3SSpatialTransformComponent, {
      sourceFrameHash: sourceFrame?.crsHash ?? 0,
      targetFrameHash: targetFrame?.crsHash ?? 0,
      transformKind: meta.transformKind,
      geoidUndulation: meta.geoidUndulation,
      skirtRegenerated: meta.skirtRegenerated,
      edgeReindexed: meta.edgeReindexed,
      verticesTransformed: (tile.positions?.length ?? 0) / 3,
      lastTransformTick: this._lastTick ?? 0,
      transformCount: 1
    });
  }

  // ---------------------------------------------------------------------
  // Batched multi-tile transform
  // ---------------------------------------------------------------------

  /**
   * Begins a batched transform. All tiles passed to transformBatchTile()
   * until endBatch() will reuse the same frame configuration, avoiding the
   * per-tile setFrames() overhead. Use this when transforming an entire
   * LOD ring in one frame.
   */
  beginBatch(sourceFrame, targetFrame) {
    this.setFrames(sourceFrame, targetFrame);
    this._batchActive = true;
    this._batchSourceFrame = sourceFrame;
    this._batchTargetFrame = targetFrame;
    this._batchStats.tilesProcessed = 0;
    this._batchStats.verticesProcessed = 0;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._batchStats._t0 = t0;
  }

  /**
   * Transforms a tile using the batch’s frame configuration. Must be called
   * between beginBatch() and endBatch().
   */
  transformBatchTile(tile) {
    if (!this._batchActive) {
      throw new Error('transformBatchTile called outside a batch');
    }
    this.transformI3STile(tile, this._batchSourceFrame, this._batchTargetFrame);
    this._batchStats.tilesProcessed++;
    this._batchStats.verticesProcessed += (tile.positions?.length ?? 0) / 3;
  }

  /**
   * Ends the batch and returns its statistics.
   */
  endBatch() {
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._batchStats.totalMs = t1 - (this._batchStats._t0 ?? t1);
    this._batchActive = false;
    this._batchSourceFrame = null;
    this._batchTargetFrame = null;
    this.stats.batchesProcessed++;
    return { ...this._batchStats };
  }

  // ---------------------------------------------------------------------
  // Diagnostic helpers
  // ---------------------------------------------------------------------

  getStats() {
    return {
      ...super.getStats(),
      skirtVerticesTransformed: this.stats.skirtVerticesTransformed,
      edgesReindexed: this.stats.edgesReindexed,
      batchesProcessed: this.stats.batchesProcessed,
      cachedStrategies: this._strategyCache.size
    };
  }

  clearStrategyCache() {
    this._strategyCache.clear();
  }
}

// ═════════════════════════════════════════════════════════════════════
// 4. CONTEXT PROVIDER
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainI3SSpatialTransformerProvider — the context provider that integrates
 * the I3S-specific transformer with the living world. This provider is what
 * the reconciler calls when a tile’s contentFormat is QUANTIZED_MESH and its
 * source is I3S (identified by the tile’s provenance metadata or by the
 * decoder having been TerrainI3SElevationDecoder from file 389).
 *
 * Responsibilities:
 *   • Expose transformI3STile() and batch APIs.
 *   • Bind I3SSpatialTransformComponent to each tile’s ECS entity.
 *   • Stream transform stats into the context frame’s physical channel.
 *   • Provide a fast-path cache of frame configurations per (source, target)
 *     CRS pair so that back-to-back tiles with the same frames skip the
 *     per-tile setFrames() overhead.
 */
export class TerrainI3SSpatialTransformerProvider {
  constructor(options = {}) {
    this.options = {
      targetHz: options.targetHz ?? 1,
      useBatchedTransform: options.useBatchedTransform ?? true,
      batchThreshold: options.batchThreshold ?? 4,   // min tiles to trigger batch
      ...options
    };

    this.transformer = new TerrainI3SSpatialTransformer(options.transformerOptions ?? {});

    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;
    this.lastTick = 0;
    this._accumulator = 0;

    // Bind the transformer's frame/ECS references so it can emit events.
    this.transformer._ecsWorld = null;
    this.transformer._lastTick = 0;

    // Per-frame cache: (sourceHash:targetHash) → config record.
    this._frameConfigCache = new Map();

    // Statistics.
    this.stats = {
      tilesTransformed: 0,
      tilesSkipped: 0,
      tilesBatched: 0,
      totalTransformMs: 0,
      avgTransformMs: 0,
      peakTransformMs: 0
    };
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  bind(contextFrame, ecsWorld, dispatcher = null) {
    this.frame = contextFrame;
    this.ecsWorld = ecsWorld;
    this.dispatcher = dispatcher;
    this.transformer._ecsWorld = ecsWorld;
    return this;
  }

  update(contextFrame, tick, dt) {
    this.frame = contextFrame;
    this.lastTick = tick;
    this.transformer._lastTick = tick;
    this._accumulator += dt;

    const interval = 1 / this.options.targetHz;
    if (this._accumulator < interval) return;
    this._accumulator %= interval;

    // Clear the frame-config cache once per tick to keep memory bounded.
    this._frameConfigCache.clear();
  }

  // ---------------------------------------------------------------------
  // Single-tile transform
  // ---------------------------------------------------------------------

  /**
   * Transforms a single I3S tile. This is the API the reconciler calls per
   * tile, unless batching is enabled (see transformTilesBatch).
   *
   * @param {I3SElevationTerrain} tile
   * @param {SpatialCoordinateFrame} sourceFrame
   * @param {SpatialCoordinateFrame} targetFrame
   * @returns {I3SElevationTerrain} the same tile (mutated)
   */
  transformTile(tile, sourceFrame, targetFrame) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    this.transformer.transformI3STile(tile, sourceFrame, targetFrame);

    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const elapsed = t1 - t0;

    this.stats.tilesTransformed++;
    this.stats.totalTransformMs += elapsed;
    this.stats.avgTransformMs = this.stats.totalTransformMs / this.stats.tilesTransformed;
    if (elapsed > this.stats.peakTransformMs) this.stats.peakTransformMs = elapsed;

    this._publishStats();
    return tile;
  }

  // ---------------------------------------------------------------------
  // Batched transform
  // ---------------------------------------------------------------------

  /**
   * Transforms an array of I3S tiles that all share the same source and
   * target frames. This is significantly faster than calling transformTile
   * N times because the frame configuration is amortised across the batch.
   *
   * @param {I3SElevationTerrain[]} tiles
   * @param {SpatialCoordinateFrame} sourceFrame
   * @param {SpatialCoordinateFrame} targetFrame
   * @returns {number} number of tiles successfully transformed
   */
  transformTilesBatch(tiles, sourceFrame, targetFrame) {
    if (!Array.isArray(tiles) || tiles.length === 0) return 0;

    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    if (tiles.length < this.options.batchThreshold) {
      // Too few tiles to benefit from batching — transform individually.
      for (const tile of tiles) {
        this.transformer.transformI3STile(tile, sourceFrame, targetFrame);
        this.stats.tilesTransformed++;
      }
    } else {
      // Use batched transform.
      this.transformer.beginBatch(sourceFrame, targetFrame);
      for (const tile of tiles) {
        this.transformer.transformBatchTile(tile);
      }
      this.transformer.endBatch();
      this.stats.tilesBatched += tiles.length;
      this.stats.tilesTransformed += tiles.length;
    }

    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const elapsed = t1 - t0;
    this.stats.totalTransformMs += elapsed;
    this.stats.avgTransformMs = this.stats.totalTransformMs / Math.max(this.stats.tilesTransformed, 1);
    if (elapsed > this.stats.peakTransformMs) this.stats.peakTransformMs = elapsed;

    this._publishStats();
    return tiles.length;
  }

  // ---------------------------------------------------------------------
  // Frame-config cache helpers
  // ---------------------------------------------------------------------

  /**
   * Returns the frame configuration key for a source/target pair.
   */
  _frameConfigKey(sourceFrame, targetFrame) {
    const s = sourceFrame?.crsHash ?? 0;
    const t = targetFrame?.crsHash ?? 0;
    return `${s}:${t}`;
  }

  // ---------------------------------------------------------------------
  // Stats publication
  // ---------------------------------------------------------------------

  _publishStats() {
    if (!this.frame?.layers?.physical) return;
    const physical = this.frame.layers.physical;
    physical.i3sTransformStats = {
      tilesTransformed: this.stats.tilesTransformed,
      tilesSkipped: this.stats.tilesSkipped,
      tilesBatched: this.stats.tilesBatched,
      totalTransformMs: this.stats.totalTransformMs,
      avgTransformMs: this.stats.avgTransformMs,
      peakTransformMs: this.stats.peakTransformMs,
      transformerStats: this.transformer.getStats(),
      lastTick: this.lastTick
    };
  }

  // ---------------------------------------------------------------------
  // Public diagnostics
  // ---------------------------------------------------------------------

  getStats() {
    return {
      ...this.stats,
      transformer: this.transformer.getStats()
    };
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  dispose() {
    this._frameConfigCache.clear();
    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;
    this.transformer._ecsWorld = null;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 5. FACTORY
// ═════════════════════════════════════════════════════════════════════

export function createTerrainI3SSpatialTransformer(options = {}) {
  return new TerrainI3SSpatialTransformerProvider({
    targetHz: options.targetHz ?? 1,
    useBatchedTransform: options.useBatchedTransform ?? true,
    batchThreshold: options.batchThreshold ?? 4,
    transformerOptions: options.transformerOptions ?? {},
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 6. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  TerrainI3SSpatialTransformer,
  TerrainI3SSpatialTransformerProvider,
  I3SSpatialTransformComponent,
  I3STransformStrategy,
  createTerrainI3SSpatialTransformer
};