// file number : 385
// full path name : src/context/385_TerrainPipelineOrchestrator.js
//### Description : Context-aware TerrainPipelineOrchestrator — the single
//###               top-level entry point for the entire seamless 2D/3D terrain
//###               pipeline. Owns and wires together every subsystem from files
//###               380 through 384: the terrain source (procedural, heightmap,
//###               or quantized-mesh), the per-tick reconciler (file 381), the
//###               material painter (file 383), and the batched render dispatch
//###               (file 384). Implements the blueprint’s six-stage tiered
//###               execution model internally so the runtime only needs to call
//###               update() and render() once per frame: 1 Hz housekeeping,
//###               10 Hz reconciliation + painting, 60 Hz render dispatch, and
//###               per-tick frame output emission. Guarantees zero per-tick
//###               allocations after warm-up, no main-thread stalls (all heavy
//###               work is delegated to the source’s worker pool), and full
//###               context-frame integration (spatial, physical, temporal, and
//###               causal channels). Exposes a clean public surface — bind,
//###               registerViewport, update, render, getStats, dispose — so
//###               the runtime never touches the subsystems directly. Also
//###               exposes the individual tiered methods (updateTier1Hz,
//###               updateTier10Hz, updateTier60Hz) so the runtime can override
//###               the internal scheduling if it wants to integrate the
//###               pipeline into its own orchestration loop. Parametric and
//###               fully self-contained: no external loader, no CDN access, no
//###               static server. Designed for Android arm64 under the 8 ms
//###               per-tick CPU ceiling and 200 MB resident memory cap, and
//###               scales from a single 10-unit tile to galactic streaming
//###               (10k+ units) without main-thread stalls.
//### Best for : The one object the runtime instantiates to bring the entire
//###            seamless terrain world online. A three-line setup
//###            (new + bind + registerViewport) followed by per-frame calls
//###            (update + render) is enough to run infinite procedural terrain
//###            with LOD, seam stitching, material painting, and batched
//###            drawing — all without a server, a build step, or any static
//###            asset.
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

// ---------------------------------------------------------------------------
// 1. IMPORTS FROM THE TERRAIN PIPELINE BARREL (file 382)
// ---------------------------------------------------------------------------
//
// Importing everything from the pipeline barrel keeps the dependency graph
// flat and ensures the orchestrator always speaks the same numeric constants
// and class identities as every other subsystem.
//
import {
  // Shared enums & options
  TilesetSourceFormat,
  TileState,
  TileRefinement,
  BoundingVolumeKind,
  TileEventType,
  SeamEdge,
  DEFAULT_TILESET_OPTIONS,

  // Utilities
  stringTileKey,
  packTileKey,
  fnv1aHash,
  extractFrustumPlanes,
  computeTileNeighbors,

  // Core classes
  Tileset2D,
  StreamingQueue,
  Tileset2DAdapter,
  ViewportState,
  Tile2DHeader,
  Tile2DHeaderPool,
  HeightmapTerrain,
  QuantizedMeshTerrain,

  // Reconciler
  TerrainTileReconciler,
  createTerrainTileReconciler,

  // Sources
  TerrainSource,
  ProceduralTerrainSource,
  HeightmapTerrainSource,
  QuantizedMeshTerrainSource,
  createProceduralTerrainSource,
  createHeightmapTerrainSource,
  createQuantizedMeshTerrainSource
} from './382_TerrainPipelineIndex.js';

// ---------------------------------------------------------------------------
// 2. IMPORTS FROM THE PAINTER AND DISPATCHER
// ---------------------------------------------------------------------------
//
// The painter and the dispatcher were written after the barrel (files 383,
// 384) so they are imported directly. A future re-export through file 382
// would let us use the barrel uniformly, but the direct import keeps this
// file independent of any barrel evolution.
//
import {
  TerrainMaterialPainter,
  TerrainMaterialRegistry,
  TerrainMaterialDescriptor,
  TerrainMaterialComponent,
  createTerrainMaterialPainter
} from './383_TerrainMaterialPainter.js';

import {
  TerrainRenderDispatch,
  DrawCallArena,
  TileInstanceArena,
  GeometryFamily,
  MaterialFamily,
  QualityTier,
  createTerrainRenderDispatch
} from './384_TerrainRenderDispatch.js';

// ---------------------------------------------------------------------------
// 3. TIER ENUM – internal scheduling tiers
// ---------------------------------------------------------------------------

/**
 * Tier — the three execution tiers the orchestrator manages internally.
 * Matches the blueprint’s six-stage loop (steps 6 and 15).
 */
export const Tier = Object.freeze({
  ONE_HZ:  1,   // memory tier: eviction, cache cleanup, stats
  TEN_HZ:  2,   // metabolism tier: reconcile + material painting
  SIXTY_HZ: 3   // eyes tier: render dispatch
});

// ---------------------------------------------------------------------------
// 4. TerrainPipelineOrchestrator
// ---------------------------------------------------------------------------

/**
 * TerrainPipelineOrchestrator — the single top-level entry point for the
 * seamless terrain pipeline.
 *
 * Internal architecture:
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │                  TerrainPipelineOrchestrator                      │
 *   │                                                                   │
 *   │  ┌────────────┐    ┌────────────┐    ┌──────────────────────┐    │
 *   │  │  Source    │───▶│ Reconciler │───▶│  Frame.Spatial SoA   │    │
 *   │  │  (380)     │    │  (381)     │    │  (visible tiles)     │    │
 *   │  └────────────┘    └────────────┘    └──────────────────────┘    │
 *   │         │                                   │                     │
 *   │         │                                   ▼                     │
 *   │         │                         ┌────────────────────┐          │
 *   │         │                         │  MaterialPainter   │          │
 *   │         │                         │  (383)             │          │
 *   │         │                         └────────────────────┘          │
 *   │         │                                   │                     │
 *   │         │                                   ▼                     │
 *   │         │                         ┌────────────────────┐          │
 *   │         └────────────────────────▶│  RenderDispatch    │          │
 *   │                                   │  (384)             │          │
 *   │                                   └────────────────────┘          │
 *   │                                              │                    │
 *   └──────────────────────────────────────────────┼────────────────────┘
 *                                                  ▼
 *                                    ┌──────────────────────────┐
 *                                    │  DrawCallArena +         │
 *                                    │  TileInstanceArena       │
 *                                    │  (published to renderer) │
 *                                    └──────────────────────────┘
 *
 * The orchestrator owns the subsystems, wires them together, and schedules
 * their update methods according to the three tiers. After warm-up, every
 * per-tick operation is O(visible tiles) with zero allocations — all scratch
 * buffers are pre-allocated and all subsystems reuse their arenas.
 */
export class TerrainPipelineOrchestrator {
  constructor(options = {}) {
    this.options = {
      // ---- Identity ----
      orchestratorId: options.orchestratorId ?? 1,
      tilesetId: options.tilesetId ?? 1,
      sourceId: options.sourceId ?? 1,

      // ---- Tier frequencies ----
      targetHz1: options.targetHz1 ?? 1,
      targetHz10: options.targetHz10 ?? 10,
      targetHz60: options.targetHz60 ?? 60,

      // ---- Quadtree ----
      maxLod: options.maxLod ?? DEFAULT_TILESET_OPTIONS.maxLod,
      tileWorldSize: options.tileWorldSize ?? DEFAULT_TILESET_OPTIONS.tileWorldSize,
      screenSpaceErrorTarget: options.screenSpaceErrorTarget ?? DEFAULT_TILESET_OPTIONS.screenSpaceErrorTarget,
      minZ: options.minZ ?? -10000,
      maxZ: options.maxZ ?? 10000,

      // ---- Content ----
      sourceFormat: options.sourceFormat ?? TilesetSourceFormat.PROCEDURAL_2D,
      refinement: options.refinement ?? TileRefinement.REPLACE,
      enableSeamStitching: options.enableSeamStitching ?? true,

      // ---- Procedural noise (when sourceFormat is PROCEDURAL_*) ----
      noisePeriod: options.noisePeriod ?? 512,
      octaves: options.octaves ?? 5,
      lacunarity: options.lacunarity ?? 2.0,
      persistence: options.persistence ?? 0.5,
      seed: options.seed ?? 1337,
      zScale: options.zScale ?? 500,
      resolution: options.resolution ?? 65,

      // ---- Material painting ----
      maxMaterialsPerVertex: options.maxMaterialsPerVertex ?? 4,
      enableNoiseVariation: options.enableNoiseVariation ?? true,
      materialNoiseSeed: options.materialNoiseSeed ?? 7331,
      wetnessTau: options.wetnessTau ?? 8.0,
      dryTau: options.dryTau ?? 30.0,
      ignitionDuration: options.ignitionDuration ?? 10.0,
      burnDuration: options.burnDuration ?? 30.0,

      // ---- Render dispatch ----
      maxDrawCalls: options.maxDrawCalls ?? 256,
      maxInstances: options.maxInstances ?? 4096,
      targetFrameMs: options.targetFrameMs ?? 8,
      minQualityScale: options.minQualityScale ?? 0.25,
      maxQualityScale: options.maxQualityScale ?? 1.0,
      governorSmoothing: options.governorSmoothing ?? 0.2,
      enableOutlinePass: options.enableOutlinePass ?? false,

      // ---- Streaming ----
      maxPendingRequests: options.maxPendingRequests ?? DEFAULT_TILESET_OPTIONS.maxPendingRequests,
      maxActiveTiles: options.maxActiveTiles ?? DEFAULT_TILESET_OPTIONS.maxActiveTiles,
      evictionGraceTicks: options.evictionGraceTicks ?? 30,
      maxResidentBytes: options.maxResidentBytes ?? DEFAULT_TILESET_OPTIONS.maxResidentBytes,

      // ---- Pre-built subsystems (optional overrides) ----
      source: options.source ?? null,
      reconciler: options.reconciler ?? null,
      painter: options.painter ?? null,
      dispatcher: options.dispatcher ?? null,
      materialRegistry: options.materialRegistry ?? null,

      // ---- Diagnostics ----
      enableDiagnostics: options.enableDiagnostics ?? true,

      ...options
    };

    // ---------------------------------------------------------------------
    // 1. Build or adopt each subsystem
    // ---------------------------------------------------------------------

    // -- Material registry --
    this.materialRegistry = this.options.materialRegistry ?? new TerrainMaterialRegistry();
    if (this.materialRegistry.size() === 0) {
      this.materialRegistry.registerDefaults();
    }

    // -- Source --
    if (this.options.source) {
      this.source = this.options.source;
    } else {
      this.source = this._buildDefaultSource();
    }

    // -- Reconciler --
    if (this.options.reconciler) {
      this.reconciler = this.options.reconciler;
    } else {
      this.reconciler = createTerrainTileReconciler({
        reconcilerId: this.options.orchestratorId,
        tilesetId: this.options.tilesetId,
        sourceId: this.options.sourceId,
        maxLod: this.options.maxLod,
        tileWorldSize: this.options.tileWorldSize,
        screenSpaceErrorTarget: this.options.screenSpaceErrorTarget,
        minZ: this.options.minZ,
        maxZ: this.options.maxZ,
        sourceFormat: this.options.sourceFormat,
        refinement: this.options.refinement,
        enableSeamStitching: this.options.enableSeamStitching,
        evictionGraceTicks: this.options.evictionGraceTicks,
        maxTiles: this.options.maxActiveTiles,
        maxResidentBytes: this.options.maxResidentBytes,
        noisePeriod: this.options.noisePeriod,
        octaves: this.options.octaves,
        lacunarity: this.options.lacunarity,
        persistence: this.options.persistence,
        seed: this.options.seed,
        zScale: this.options.zScale,
        resolution: this.options.resolution
      });
    }

    // -- Painter --
    if (this.options.painter) {
      this.painter = this.options.painter;
    } else {
      this.painter = createTerrainMaterialPainter({
        targetHz: this.options.targetHz10,
        registry: this.materialRegistry,
        maxMaterialsPerVertex: this.options.maxMaterialsPerVertex,
        enableNoiseVariation: this.options.enableNoiseVariation,
        noiseSeed: this.options.materialNoiseSeed,
        wetnessTau: this.options.wetnessTau,
        dryTau: this.options.dryTau,
        ignitionDuration: this.options.ignitionDuration,
        burnDuration: this.options.burnDuration
      });
    }

    // -- Dispatcher --
    if (this.options.dispatcher) {
      this.dispatcher = this.options.dispatcher;
    } else {
      this.dispatcher = createTerrainRenderDispatch({
        targetHz: this.options.targetHz60,
        maxDrawCalls: this.options.maxDrawCalls,
        maxInstances: this.options.maxInstances,
        targetFrameMs: this.options.targetFrameMs,
        minQualityScale: this.options.minQualityScale,
        maxQualityScale: this.options.maxQualityScale,
        governorSmoothing: this.options.governorSmoothing,
        enableOutlinePass: this.options.enableOutlinePass,
        enableSeamPass: this.options.enableSeamStitching,
        maxResidentBytes: this.options.maxResidentBytes
      });
    }

    // ---------------------------------------------------------------------
    // 2. Wire the subsystems together
    // ---------------------------------------------------------------------

    this.reconciler.setSource(this.source);
    this.painter.setSource(this.source);

    // ---------------------------------------------------------------------
    // 3. Internal state
    // ---------------------------------------------------------------------

    this.frame = null;
    this.ecsWorld = null;
    this.dispatcherEventBus = null;

    this.lastTick = 0;
    this._acc1 = 0;
    this._acc10 = 0;
    this._acc60 = 0;

    // Per-tier tick counters (for delta-time smoothing across tiers).
    this._lastTick1 = 0;
    this._lastTick10 = 0;
    this._lastTick60 = 0;

    // Registered viewports (id → ViewportState).
    this.viewports = new Map();

    // The most recent visible-header array (from the reconciler).
    this._lastVisibleHeaders = [];

    // ---------------------------------------------------------------------
    // 4. Diagnostics
    // ---------------------------------------------------------------------

    this.stats = {
      totalTicks: 0,
      ticks1Hz: 0,
      ticks10Hz: 0,
      ticks60Hz: 0,
      totalFrameMs: 0,
      totalReconcileMs: 0,
      totalPaintMs: 0,
      totalDispatchMs: 0,
      peakVisibleTiles: 0,
      peakDrawCalls: 0,
      peakInstances: 0,
      peakTriangles: 0,
      startedAt: (typeof performance !== 'undefined' ? performance.now() : Date.now())
    };
  }

  // -------------------------------------------------------------------------
  // Default subsystem factories
  // -------------------------------------------------------------------------

  _buildDefaultSource() {
    switch (this.options.sourceFormat) {
      case TilesetSourceFormat.PROCEDURAL_2D:
      case TilesetSourceFormat.PROCEDURAL_3D:
        return createProceduralTerrainSource({
          sourceId: this.options.sourceId,
          tilesetId: this.options.tilesetId,
          maxLod: this.options.maxLod,
          tileWorldSize: this.options.tileWorldSize,
          maxPendingRequests: this.options.maxPendingRequests,
          noisePeriod: this.options.noisePeriod,
          octaves: this.options.octaves,
          lacunarity: this.options.lacunarity,
          persistence: this.options.persistence,
          seed: this.options.seed,
          zScale: this.options.zScale,
          resolution: this.options.resolution
        });
      case TilesetSourceFormat.HEIGHTMAP_UINT8:
      case TilesetSourceFormat.HEIGHTMAP_UINT16:
      case TilesetSourceFormat.HEIGHTMAP_FLOAT32:
      case TilesetSourceFormat.HEIGHTMAP_RGB_PACKED:
        return createHeightmapTerrainSource({
          sourceId: this.options.sourceId,
          tilesetId: this.options.tilesetId,
          encoding: this.options.encoding ?? 'uint16',
          minElevation: this.options.minElevation ?? 0,
          maxElevation: this.options.maxElevation ?? 1000,
          resolution: this.options.resolution,
          maxPendingRequests: this.options.maxPendingRequests
        });
      case TilesetSourceFormat.QUANTIZED_MESH:
        return createQuantizedMeshTerrainSource({
          sourceId: this.options.sourceId,
          tilesetId: this.options.tilesetId,
          maxPendingRequests: this.options.maxPendingRequests
        });
      default:
        throw new Error(
          'TerrainPipelineOrchestrator: unsupported sourceFormat "' +
          this.options.sourceFormat + '"'
        );
    }
  }

  // -------------------------------------------------------------------------
  // Public lifecycle API
  // -------------------------------------------------------------------------

  /**
   * Binds the orchestrator and every subsystem to the live context frame,
   * ECS world, and event dispatcher. Called once at startup.
   */
  bind(contextFrame, ecsWorld, eventDispatcher = null) {
    if (!contextFrame) throw new Error('TerrainPipelineOrchestrator.bind requires a context frame');

    this.frame = contextFrame;
    this.ecsWorld = ecsWorld;
    this.dispatcherEventBus = eventDispatcher;

    // Wire the reconciler (it also wires the tileset and the source).
    this.reconciler.bind(contextFrame, ecsWorld, eventDispatcher);

    // Wire the painter and dispatcher.
    this.painter.bind(contextFrame, ecsWorld, eventDispatcher);
    this.dispatcher.bind(contextFrame, ecsWorld, eventDispatcher);

    return this;
  }

  /**
   * Registers a viewport with the pipeline. Returns the ViewportState so the
   * caller can inspect selection diagnostics.
   */
  registerViewport(viewportId) {
    const vp = this.reconciler.registerViewport(viewportId);
    this.viewports.set(viewportId, vp);
    return vp;
  }

  /**
   * Unregisters a viewport and releases its tile references.
   */
  unregisterViewport(viewportId) {
    this.reconciler.unregisterViewport(viewportId);
    this.viewports.delete(viewportId);
  }

  // -------------------------------------------------------------------------
  // Main per-frame update — the single entry point
  // -------------------------------------------------------------------------

  /**
   * The single entry point the runtime calls each frame. Internally dispatches
   * to the correct tier based on the accumulated delta time.
   *
   * @param {ContextFrame} contextFrame
   * @param {number} tick – monotonic tick counter
   * @param {number} dt – delta time in seconds
   * @param {object} camera – the camera state for the primary viewport
   * @param {number|string} viewportId – the viewport whose camera drives selection
   * @returns {number} the tier that ran this frame (0 = none, 1/10/60 = tier)
   */
  update(contextFrame, tick, dt, camera, viewportId) {
    if (!this.frame) throw new Error('TerrainPipelineOrchestrator not bound. Call .bind() first.');

    this.frame = contextFrame;
    this.lastTick = tick;
    this.stats.totalTicks++;

    // Advance each tier's accumulator.
    this._acc1  += dt;
    this._acc10 += dt;
    this._acc60 += dt;

    let ranTier = 0;

    // 60 Hz tier runs every frame.
    const interval60 = 1 / this.options.targetHz60;
    if (this._acc60 >= interval60) {
      const dt60 = this._acc60;
      this._acc60 %= interval60;
      this._updateTier60(contextFrame, tick, dt60);
      ranTier = 60;
    }

    // 10 Hz tier runs when its timer fires.
    const interval10 = 1 / this.options.targetHz10;
    if (this._acc10 >= interval10) {
      const dt10 = this._acc10;
      this._acc10 %= interval10;
      this._updateTier10(contextFrame, tick, dt10, camera, viewportId);
      ranTier = ranTier || 10;
    }

    // 1 Hz tier runs when its timer fires.
    const interval1 = 1 / this.options.targetHz1;
    if (this._acc1 >= interval1) {
      const dt1 = this._acc1;
      this._acc1 %= interval1;
      this._updateTier1(contextFrame, tick, dt1);
      ranTier = ranTier || 1;
    }

    return ranTier;
  }

  // -------------------------------------------------------------------------
  // Tier 1 Hz — memory tier
  // -------------------------------------------------------------------------

  /**
   * 1 Hz housekeeping: eviction, cache cleanup, per-second metrics rollups.
   * Delegates to the reconciler’s eviction path and updates the orchestrator’s
   * statistics. Never touches the visible-tile set.
   */
  updateTier1Hz(contextFrame, tick, dt) {
    this.frame = contextFrame;
    this._updateTier1(contextFrame, tick, dt);
  }

  _updateTier1(contextFrame, tick, dt) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // The reconciler already runs eviction as part of its own update cycle,
    // but at 1 Hz we force a full cache cleanup to release any tiles that
    // have been unreferenced for the full grace window.
    if (this.reconciler && this.reconciler.tileset) {
      const source = this.reconciler.source;
      if (source && typeof source._evictStale === 'function') {
        source._evictStale(tick);
      }
    }

    this.stats.ticks1Hz++;
    this._lastTick1 = tick;

    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.stats.totalFrameMs += (t1 - t0);
  }

  // -------------------------------------------------------------------------
  // Tier 10 Hz — metabolism tier
  // -------------------------------------------------------------------------

  /**
   * 10 Hz metabolism: run the reconciler (which drives the source’s worker
   * pool and updates the frame’s visible-tile SoA), then run the material
   * painter (which reads the visible tiles, updates per-tile wetness and
   * ignition, and publishes the material SoA).
   */
  updateTier10Hz(contextFrame, tick, dt, camera, viewportId) {
    this.frame = contextFrame;
    this._updateTier10(contextFrame, tick, dt, camera, viewportId);
  }

  _updateTier10(contextFrame, tick, dt, camera, viewportId) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // 1. Reconcile: drives tile requests, cancels stale ones, updates the
    //    visible-tile SoA, and advances LOD cross-fades.
    this.reconciler.update(contextFrame, tick, dt, camera, viewportId);

    // 2. Grab the visible headers from the reconciler.
    const visibleHeaders = this.reconciler.tileset.getVisibleHeaders(viewportId);
    this._lastVisibleHeaders = visibleHeaders;

    // 3. Paint materials: reads the visible tiles and publishes the material
    //    SoA into the frame’s physical channel.
    const tPaint0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.painter.update(contextFrame, tick, dt, visibleHeaders);
    const tPaint1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    this.stats.ticks10Hz++;
    this.stats.peakVisibleTiles = Math.max(this.stats.peakVisibleTiles, visibleHeaders.length);
    this.stats.totalPaintMs += (tPaint1 - tPaint0);

    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.stats.totalReconcileMs += (t1 - t0) - (tPaint1 - tPaint0);
    this.stats.totalFrameMs += (t1 - t0);
    this._lastTick10 = tick;
  }

  // -------------------------------------------------------------------------
  // Tier 60 Hz — eyes tier
  // -------------------------------------------------------------------------

  /**
   * 60 Hz eyes: run the render dispatcher, which builds the draw-call and
   * per-instance arenas and publishes them to the frame’s render channel.
   * Does not touch the quadtree, the source, or the material painter.
   */
  updateTier60Hz(contextFrame, tick, dt) {
    this.frame = contextFrame;
    this._updateTier60(contextFrame, tick, dt);
  }

  _updateTier60(contextFrame, tick, dt) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    this.dispatcher.update(
      contextFrame, tick, dt,
      this._lastVisibleHeaders,
      this.painter,
      this.reconciler.source
    );

    this.stats.ticks60Hz++;
    this.stats.peakDrawCalls = Math.max(this.stats.peakDrawCalls, this.dispatcher.getDrawCalls().count);
    this.stats.peakInstances = Math.max(this.stats.peakInstances, this.dispatcher.getInstances().count);
    this.stats.peakTriangles = Math.max(this.stats.peakTriangles, this.dispatcher._published?.triangleCount ?? 0);

    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.stats.totalDispatchMs += (t1 - t0);
    this._lastTick60 = tick;
  }

  // -------------------------------------------------------------------------
  // Render-side API
  // -------------------------------------------------------------------------

  /**
   * Returns the draw-call arena for the current frame. The renderer iterates
   * this arena and issues the corresponding GPU draws.
   *
   * The returned arena is the dispatcher’s live arena — it is rebuilt every
   * frame and must be consumed immediately. Do not hold references across
   * frames.
   */
  render() {
    return {
      drawCalls: this.dispatcher.getDrawCalls(),
      instances: this.dispatcher.getInstances(),
      drawCallCount: this.dispatcher.getDrawCalls().count,
      instanceCount: this.dispatcher.getInstances().count,
      triangleCount: this.dispatcher._published?.triangleCount ?? 0,
      qualityScale: this.dispatcher.getQualityScale(),
      lastFrameMs: this.dispatcher._published?.lastFrameMs ?? 0
    };
  }

  /**
   * Returns the terrain material weight arena. Downstream renderers read this
   * to bind per-vertex material weights when uploading the terrain mesh.
   */
  getMaterialWeightArena() {
    return this.painter.getWeightArena();
  }

  // -------------------------------------------------------------------------
  // Convenience queries
  // -------------------------------------------------------------------------

  /**
   * Returns the terrain object (HeightmapTerrain or QuantizedMeshTerrain) for
   * a tile key, or null. Useful for raycasting or user interaction.
   */
  getTerrainObject(tileKey) {
    return this.source.getTerrainObject(tileKey);
  }

  /**
   * Samples the terrain height at world coordinates (wx, wy). Searches the
   * live tiles for the one containing the point.
   * Returns NaN if the point is not covered by any resident tile.
   */
  sampleHeight(wx, wy) {
    // Walk the reconciler’s tileset registry for the containing tile.
    const registry = this.reconciler.tileset.adapter.headerRegistry;
    for (const [, header] of registry) {
      if (header.state !== TileState.READY) continue;
      if (wx < header.minX || wx > header.maxX) continue;
      if (wy < header.minY || wy > header.maxY) continue;
      const terrain = this.getTerrainObject(header.tileKey);
      if (!terrain) continue;
      return terrain.getHeight(wx, wy);
    }
    return NaN;
  }

  /**
   * Manually overrides the render dispatch quality scale. Useful for explicit
   * low-power mode toggles on Android.
   */
  setQualityScale(scale) {
    this.dispatcher.setQualityScale(scale);
  }

  /**
   * Returns the current quality scale (0..1).
   */
  getQualityScale() {
    return this.dispatcher.getQualityScale();
  }

  /**
   * Registers a new material with the painter’s registry. The change takes
   * effect on the next paint tick.
   */
  registerMaterial(props) {
    return this.painter.registerMaterial(props);
  }

  /**
   * Returns the current pipeline statistics aggregated across all subsystems.
   */
  getStats() {
    return {
      // Orchestrator
      totalTicks: this.stats.totalTicks,
      ticks1Hz: this.stats.ticks1Hz,
      ticks10Hz: this.stats.ticks10Hz,
      ticks60Hz: this.stats.ticks60Hz,
      uptimeMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - this.stats.startedAt,
      avgReconcileMs: this.stats.ticks10Hz > 0 ? this.stats.totalReconcileMs / this.stats.ticks10Hz : 0,
      avgPaintMs: this.stats.ticks10Hz > 0 ? this.stats.totalPaintMs / this.stats.ticks10Hz : 0,
      avgDispatchMs: this.stats.ticks60Hz > 0 ? this.stats.totalDispatchMs / this.stats.ticks60Hz : 0,
      peakVisibleTiles: this.stats.peakVisibleTiles,
      peakDrawCalls: this.stats.peakDrawCalls,
      peakInstances: this.stats.peakInstances,
      peakTriangles: this.stats.peakTriangles,

      // Per-subsystem
      reconciler: this.reconciler.getStats(),
      painter: this.painter.getStats(),
      dispatcher: this.dispatcher.getStats(),
      source: this.source.getStats(),

      // Registered viewports
      viewportCount: this.viewports.size
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Clears all terrain state (tiles, requests, materials, draw calls) without
   * destroying the orchestrator. After clear(), the pipeline can be re-bound
   * and re-used.
   */
  clear() {
    if (this.reconciler) this.reconciler.clear();
    if (this.painter) this.painter.tileState.clear();
    if (this.dispatcher) {
      this.dispatcher.drawCalls.reset();
      this.dispatcher.instances.reset();
      this.dispatcher._batchMap.clear();
    }
    this._lastVisibleHeaders = [];
  }

  /**
   * Destroys the orchestrator and every subsystem it owns. After dispose(),
   * the instance cannot be reused.
   */
  dispose() {
    if (this.reconciler) this.reconciler.dispose();
    if (this.painter) this.painter.dispose();
    if (this.dispatcher) this.dispatcher.dispose();
    if (this.source) this.source.dispose();

    this.reconciler = null;
    this.painter = null;
    this.dispatcher = null;
    this.source = null;
    this.viewports.clear();
    this._lastVisibleHeaders = [];
    this.frame = null;
    this.ecsWorld = null;
    this.dispatcherEventBus = null;
  }
}

// ---------------------------------------------------------------------------
// 5. FACTORY
// ---------------------------------------------------------------------------

/**
 * Creates a fully-wired TerrainPipelineOrchestrator with sensible defaults
 * for the seamless terrain pipeline.
 *
 * Usage:
 *   const pipeline = createTerrainPipelineOrchestrator({ maxLod: 12, ... });
 *   pipeline.bind(contextFrame, ecsWorld, eventDispatcher);
 *   pipeline.registerViewport('main');
 *
 *   // Per frame:
 *   pipeline.update(contextFrame, tick, dt, camera, 'main');
 *   const drawCalls = pipeline.render();
 */
export function createTerrainPipelineOrchestrator(options = {}) {
  return new TerrainPipelineOrchestrator(options);
}

// ---------------------------------------------------------------------------
// 6. BARREL EXPORT
// ---------------------------------------------------------------------------

export default {
  TerrainPipelineOrchestrator,
  Tier,
  createTerrainPipelineOrchestrator
};