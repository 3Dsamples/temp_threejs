// file number : 410
// full path name : src/context/410_TerrainPipelineMasterOrchestrator3D.js
//### Description : The terminal master orchestrator for the seamless 3D
//###               terrain pipeline. This file is the single runtime entry
//###               point the living world drives with one update() per frame —
//###               it owns, wires, schedules, and budget-manages every 3D
//###               terrain subsystem the pipeline has built so far, so the
//###               runtime never needs to touch any of them directly:
//###                 • SOURCE          — file 380 (TerrainSource) or 400
//###                                     (archive source) produces decoded
//###                                     tile payloads.
//###                 • TILESET         — file 399 (Tileset3D) owns the 3D Tiles
//###                                     tile graph.
//###                 • TRAVERSAL       — file 409 (Tileset3DTraversal) runs
//###                                     worker-parallel SSE selection.
//###                 • RECONCILER      — file 381 (TerrainTileReconciler)
//###                                     drives 2D tileset streaming.
//###                 • MATERIAL BRIDGE — file 394 couples biome, climate,
//###                                     soil, hydrology to per-tile materials.
//###                 • SCATTER         — file 405 populates tiles with trees,
//###                                     rocks, grass, flowers procedurally.
//###                 • FAUNA           — file 406 populates tiles with birds,
//###                                     mammals, fish, insects.
//###                 • WEATHER         — file 407 generates lightning, tornadoes,
//###                                     fog, rain, snow per tile.
//###                 • HYDROLOGY       — file 404 simulates water depth, rivers,
//###                                     lakes, waterfalls.
//###                 • LOD FIDELITY    — file 395 decides per-tile LOD target.
//###                 • SEAM STITCHER   — file 396 stitches crack-free seams
//###                                     across tile LOD boundaries.
//###                 • QUERY ENGINE    — file 397 answers height/normal/slope/
//###                                     raycast/sphere/capsule queries.
//###                 • RENDER DISPATCH — file 393 produces batched draw calls.
//###               The orchestrator implements the six-stage execution loop
//###               from context-awares_full.md step 15 VERBATIM:
//###                 STAGE 1 — Build the frame from providers (1 Hz).
//###                 STAGE 2 — Drain the causal buffer and decay events (1 Hz).
//###                 STAGE 3 — Run all 1 Hz consumers (eviction, persistence).
//###                 STAGE 4 — Run all 10 Hz consumers (reconcile, paint,
//###                           scatter, fauna, hydrology, weather, LOD,
//###                           seam stitch).
//###                 STAGE 5 — Run all 60 Hz consumers (camera, LOD blend
//###                           alphas, render dispatch).
//###                 STAGE 6 — Emit the frame's accumulated render outputs
//###                           (batched draw calls, per-instance uniforms).
//###               And enforces the CRITICAL DISCIPLINE from the blueprint:
//###                 "Stage 6 never triggers a rebuild of Stage 1, so a
//###                  material switch decided in Stage 5 is reflected in the
//###                  next frame, not the current one."
//###               The orchestrator adds five cross-cutting systems that no
//###               individual subsystem owns but every subsystem depends on:
//###                 1. ADAPTIVE QUALITY GOVERNOR — an EMA over the last N
//###                    frame durations that scales every subsystem's budget
//###                    from 0.25 to 1.0. When the governor drops, the LOD
//###                    fidelity target widens, scatter density scales down,
//###                    fauna LOD radius shrinks, weather particle caps
//###                    reduce, hydrology solver iterations halve, and
//###                    traversal maxSelectedPerFrame halves. The whole
//###                    pipeline degrades together, never in isolation.
//###                 2. MEMORY CEILING ENFORCER — a soft cap (default 200 MB)
//###                    that evicts the coldest subsystems (weather effects,
//###                    scatter instances, fauna instances, hydrology states,
//###                    material records) in a deterministic order when the
//###                    total resident bytes exceed the ceiling. The pipeline
//###                    never overflows memory because each subsystem declares
//###                    its budget and the enforcer refuses overruns rather
//###                    than silently paging.
//###                 3. GC PAUSE MONITOR — reads the browser's long-task API
//###                    (or a performance.now() heuristic on engines that
//###                    lack it) and forces the governor into low-quality
//###                    mode if a GC pause exceeds the threshold (default 2 ms).
//###                    This prevents the death spiral where a GC pause causes
//###                    more work next frame, which causes a longer GC pause.
//###                 4. FRAME BUDGET MONITOR — measures each stage's wall-clock
//###                    time and emits a per-stage breakdown into the physical
//###                    channel so HUDs and devtools can see where time is
//###                    going without instrumenting every subsystem.
//###                 5. PRIORITY-AWARE FRAME BUILDER — writes only the
//###                    currently-visible, currently-ready tiles into the
//###                    frame's SoA channels, skipping any tile whose LOD is
//###                    beyond the render distance or whose content is not
//###                    yet decoded. This keeps the frame's SoA arrays tight
//###                    (typically 200–800 entries, not 10,000) so all
//###                    downstream systems (material bridge, render dispatch)
//###                    walk a cache-friendly short list instead of the full
//###                    tile set.
//###               All hot-path operations are allocation-free after warm-up:
//###                 • Every subsystem's arena lives in the orchestrator's
//###                   ownership and is reused forever.
//###                 • The orchestrator's per-frame scratch buffers are
//###                   pre-allocated to the maximum visible tile count.
//###                 • The frame is built with zero per-tile allocations.
//###               No external loader, no CDN access, no static server.
//###               Designed for Android arm64 under the 8 ms per-tick CPU
//###               ceiling and 200 MB resident memory cap, and scales from
//###               a single 10-unit tile to galactic streaming (10k+ units)
//###               without main-thread stalls.
//### Best for : The single object the runtime instantiates to bring the entire
//###            seamless 3D terrain world online. A three-line setup — create,
//###            bind, start — followed by one update() per frame is enough to
//###            run infinite procedural 3D terrain with LOD, seam stitching,
//###            material painting, scatter, fauna, weather, hydrology, and
//###            batched drawing, all without a server, a build step, or any
//###            static asset. Every subsystem can be enabled or disabled
//###            individually at construction time, so the orchestrator works
//###            on a flagship phone with everything on and on a low-end
//###            Chromebook with only terrain and material painting.
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
import { CoreClock, TIER, TIER_PERIOD } from './267_CoreClock.js';

// ---- Spatial acceleration (271–274) ----
import { SpatialHashGrid } from './271_SpatialHashGrid.js';
import { DynamicBVH } from './272_DynamicBVH.js';
import { FrustumCullingSystem } from './273_FrustumCullingSystem.js';
import { OcclusionGraph } from './274_OcclusionGraph.js';

// ---- Performance governance (303–307) ----
import { HLODController } from './303_HLODController.js';
import { MemoryCeilingEnforcer } from './304_MemoryCeilingEnforcer.js';
import { FrameBudgetMonitor } from './305_FrameBudgetMonitor.js';
import { GCPauseMonitor } from './306_GCPauseMonitor.js';
import { MemoryProfiler } from './307_MemoryProfiler.js';

// ---- Biome registry (327) ----
import { BiomeRegistryBarrel } from './327_BiomeRegistryBarrel.js';

// ---- Tileset types (373) ----
import {
  TilesetSourceFormat,
  TileState,
  TileEventType,
  TileEventType as Tile2DEventType,
  stringTileKey,
  fnv1aHash,
  DEFAULT_TILESET_OPTIONS
} from './373_Tileset2DTypes.js';

// ---- 2D pipeline (374–385) ----
import { HeightmapTerrain } from './374_TerrainHeightmapTile.js';
import { QuantizedMeshTerrain } from './375_TerrainParseQuantizedMesh.js';
import { Tile2DHeader } from './376_Tile2DHeader.js';
import { Tileset2D } from './378_Tileset2D.js';
import { TerrainSource } from './380_TerrainSource.js';
import { TerrainTileReconciler } from './381_ReconcileTerrainTiles.js';
import { TerrainMaterialPainter } from './383_TerrainMaterialPainter.js';
import { TerrainRenderDispatch } from './384_TerrainRenderDispatch.js';
import { TerrainPipelineOrchestrator } from './385_TerrainPipelineOrchestrator.js';

// ---- I3S and CRS (387–389) ----
import { TerrainNormalizeCRSIdentifier } from './387_TerrainNormalizeCRSIdentifier.js';
import { TerrainSpatialCoordinateFrame } from './388_TerrainSpatialCoordinateFrame.js';
import { TerrainI3SElevationDecoder } from './389_TerrainI3SElevationDecoder.js';

// ---- 3D pipeline (391–409) ----
import { TerrainSpatialCoordinateTransformer } from './391_TerrainSpatialCoordinateTransformer.js';
import { TerrainI3SSpatialTransformer } from './392_TerrainI3SSpatialTransformer.js';
import { TerrainRenderDispatch3D } from './393_TerrainRenderDispatch3D.js';
import { TerrainMaterialBridge3D } from './394_TerrainMaterialBridge3D.js';
import { TerrainLODFidelity3D } from './395_TerrainLODFidelity3D.js';
import { TerrainSeamStitcher3D } from './396_TerrainSeamStitcher3D.js';
import { TerrainQueryCollision3D } from './397_TerrainQueryCollision3D.js';
import { Tile3D, Tile3DComponent } from './398_TerrainTile3D.js';
import { Tileset3D, Tileset3DComponent } from './399_Tileset3D.js';
import { TerrainTiles3DArchiveSource } from './400_TerrainTiles3DArchiveSource.js';
import { TerrainB3DMParser } from './401_TerrainB3DMParser.js';
import { TerrainI3DMParser } from './403_TerrainI3DMParser.js';
import { TerrainProceduralHydrology3D } from './404_TerrainProceduralHydrology3D.js';
import { TerrainProceduralScatter3D } from './405_TerrainProceduralScatter3D.js';
import { TerrainProceduralFauna3D } from './406_TerrainProceduralFauna3D.js';
import { TerrainProceduralWeather3D } from './407_TerrainProceduralWeather3D.js';
import { TerrainCompositeTileParser } from './408_TerrainCompositeTileParser.js';
import { TerrainTileset3DTraversal } from './409_TerrainTileset3DTraversal.js';

// ═════════════════════════════════════════════════════════════════════
// 1. ENUMS AND CONSTANTS
// ═════════════════════════════════════════════════════════════════════

/**
 * TierId — the three execution tiers the orchestrator manages.
 */
export const TierId = Object.freeze({
  SIXTY_HZ: 0,
  TEN_HZ:   1,
  ONE_HZ:   2
});

/**
 * StageId — the six-stage loop from blueprint step 15.
 */
export const StageId = Object.freeze({
  BUILD_FRAME:      0,   // stage 1
  DRAIN_CAUSAL:     1,   // stage 2
  TIER_1HZ:         2,   // stage 3
  TIER_10HZ:        3,   // stage 4
  TIER_60HZ:        4,   // stage 5
  EMIT_RENDER:      5    // stage 6
});

/**
 * SubsystemId — bit flags identifying each managed subsystem.
 */
export const SubsystemId = Object.freeze({
  SOURCE:          (1 << 0),
  TILESET:         (1 << 1),
  TRAVERSAL:       (1 << 2),
  RECONCILER:      (1 << 3),
  MATERIAL_BRIDGE: (1 << 4),
  SCATTER:         (1 << 5),
  FAUNA:           (1 << 6),
  WEATHER:         (1 << 7),
  HYDROLOGY:       (1 << 8),
  LOD_FIDELITY:    (1 << 9),
  SEAM_STITCHER:   (1 << 10),
  QUERY_ENGINE:    (1 << 11),
  RENDER_DISPATCH: (1 << 12),

  // Presets
  MINIMAL:         (1 << 0) | (1 << 1) | (1 << 11) | (1 << 12),
  STANDARD:        (1 << 0) | (1 << 1) | (1 << 2) | (1 << 9) | (1 << 10) | (1 << 11) | (1 << 12),
  FULL:            0x1FFF   // all 13 subsystems
});

/**
 * QualityPreset — the quality levels the governor toggles between.
 */
export const QualityPreset = Object.freeze({
  LOW:      0.25,
  MEDIUM:   0.5,
  HIGH:     0.75,
  ULTRA:    1.0
});

/**
 * FrameStageTiming — the per-stage timing record. Written to the physical
 * channel so HUDs can display where the frame's time went.
 */
export class FrameStageTiming {
  constructor() {
    this.stageNames = ['build_frame', 'drain_causal', 'tier_1hz', 'tier_10hz', 'tier_60hz', 'emit_render'];
    this.stageMs = new Float32Array(6);
    this.subsystemMs = new Float32Array(13);  // one per SubsystemId
    this.totalMs = 0;
    this.frameId = 0;
    this.qualityScale = 1.0;
    this.memoryBytes = 0;
    this.gcPauseMs = 0;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 2. ECS COMPONENT
// ═════════════════════════════════════════════════════════════════════

/**
 * MasterOrchestratorComponent — bound to the singleton orchestrator entity.
 * Stores the current frame's timing, quality, and memory statistics so
 * external systems can inspect them without a direct reference.
 */
export class MasterOrchestratorComponent {
  static schema = {
    frameId:              { type: 'u32' },
    activeSubsystems:     { type: 'u16' },
    qualityScale:         { type: 'f32' },
    frameBudgetMs:        { type: 'f32' },
    lastFrameMs:          { type: 'f32' },
    totalMs:              { type: 'f32' },
    visibleTileCount:     { type: 'u32' },
    readyTileCount:       { type: 'u32' },
    residentBytes:        { type: 'u64' },
    gcPauseMs:            { type: 'f32' },
    // Per-stage timings (6 stages × f32)
    stage0Ms:             { type: 'f32' },
    stage1Ms:             { type: 'f32' },
    stage2Ms:             { type: 'f32' },
    stage3Ms:             { type: 'f32' },
    stage4Ms:             { type: 'f32' },
    stage5Ms:             { type: 'f32' },
    // Lifecycle
    lastUpdatedTick:      { type: 'u32' }
  };
}

// ═════════════════════════════════════════════════════════════════════
// 3. THE MASTER ORCHESTRATOR
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainPipelineMasterOrchestrator3D — the single runtime entry point.
 */
export class TerrainPipelineMasterOrchestrator3D {
  constructor(options = {}) {
    // -----------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------
    this.options = {
      // Identity
      orchestratorId: options.orchestratorId ?? 1,
      tilesetId: options.tilesetId ?? 1,
      sourceId: options.sourceId ?? 1,

      // Subsystems to enable (bitmask from SubsystemId)
      subsystems: options.subsystems ?? SubsystemId.FULL,

      // Tier frequencies
      targetHz60: options.targetHz60 ?? 60,
      targetHz10: options.targetHz10 ?? 10,
      targetHz1: options.targetHz1 ?? 1,

      // Frame budget
      frameBudgetMs: options.frameBudgetMs ?? 8,
      governorWindow: options.governorWindow ?? 16,
      governorSmoothing: options.governorSmoothing ?? 0.15,
      governorMinQuality: options.governorMinQuality ?? 0.25,
      governorMaxQuality: options.governorMaxQuality ?? 1.0,

      // Memory
      maxResidentBytes: options.maxResidentBytes ?? 200 * 1024 * 1024,
      memoryCheckIntervalTicks: options.memoryCheckIntervalTicks ?? 10,
      gcPauseThresholdMs: options.gcPauseThresholdMs ?? 2.0,

      // Tileset configuration
      tileWorldSize: options.tileWorldSize ?? 100,
      maxLod: options.maxLod ?? 12,
      screenSpaceErrorTarget: options.screenSpaceErrorTarget ?? 16,

      // Scatter configuration
      enableScatter: options.enableScatter ?? true,
      scatterSamplingResolution: options.scatterSamplingResolution ?? 32,
      scatterMaxPerTile: options.scatterMaxPerTile ?? 2048,

      // Fauna configuration
      enableFauna: options.enableFauna ?? true,
      faunaMaxPerTile: options.faunaMaxPerTile ?? 64,
      faunaLodRadius: options.faunaLodRadius ?? 500,

      // Weather configuration
      enableWeather: options.enableWeather ?? true,
      enableLightning: options.enableLightning ?? true,
      enableTornadoes: options.enableTornadoes ?? true,

      // Hydrology configuration
      enableHydrology: options.enableHydrology ?? true,
      hydrologyMaxResolution: options.hydrologyMaxResolution ?? 129,

      // Traversal
      enableParallelTraversal: options.enableParallelTraversal ?? true,
      traversalWorkerCount: options.traversalWorkerCount ?? 2,
      traversalMaxSelectedPerFrame: options.traversalMaxSelectedPerFrame ?? 4096,

      // Diagnostics
      enableDiagnostics: options.enableDiagnostics ?? true,

      // Subsystem overrides (for testing or integration)
      source: options.source ?? null,
      tileset: options.tileset ?? null,
      materialBridge: options.materialBridge ?? null,
      scatter: options.scatter ?? null,
      fauna: options.fauna ?? null,
      weather: options.weather ?? null,
      hydrology: options.hydrology ?? null,
      lodFidelity: options.lodFidelity ?? null,
      seamStitcher: options.seamStitcher ?? null,
      queryEngine: options.queryEngine ?? null,
      renderDispatch: options.renderDispatch ?? null,
      traversal: options.traversal ?? null,

      ...options
    };

    // -----------------------------------------------------------------
    // Subsystem mask
    // -----------------------------------------------------------------
    this._subsystemMask = this.options.subsystems;

    // -----------------------------------------------------------------
    // Build subsystems (or adopt overrides)
    // -----------------------------------------------------------------
    this._buildSubsystems();

    // -----------------------------------------------------------------
    // Cross-cutting governors
    // -----------------------------------------------------------------
    this._frameBudget = new FrameBudgetMonitor({
      targetFrameMs: this.options.frameBudgetMs,
      windowSize: this.options.governorWindow
    });
    this._gcMonitor = new GCPauseMonitor({
      thresholdMs: this.options.gcPauseThresholdMs
    });
    this._memoryEnforcer = new MemoryCeilingEnforcer({
      maxBytes: this.options.maxResidentBytes
    });
    this._memoryProfiler = new MemoryProfiler();

    // ---- Adaptive quality governor ----
    this._qualityScale = this.options.governorMaxQuality;
    this._qualityHistory = new Float32Array(this.options.governorWindow);
    this._qualityHistoryIndex = 0;
    this._qualityHistorySum = 0;

    // -----------------------------------------------------------------
    // Per-frame scratch
    // -----------------------------------------------------------------
    this._frameTiming = new FrameStageTiming();
    this._scratchVisibleHeaders = [];
    this._scratchHeaderPool = [];

    // -----------------------------------------------------------------
    // Context bindings
    // -----------------------------------------------------------------
    this.frame = null;
    this.ecsWorld = null;
    this.eventDispatcher = null;
    this.lastTick = 0;

    // -----------------------------------------------------------------
    // Tier accumulators
    // -----------------------------------------------------------------
    this._acc60 = 0;
    this._acc10 = 0;
    this._acc1 = 0;

    // -----------------------------------------------------------------
    // Frame counter
    // -----------------------------------------------------------------
    this._frameId = 0;

    // -----------------------------------------------------------------
    // Published output
    // -----------------------------------------------------------------
    this._published = {
      frame: null,
      visibleTileKeys: [],
      visibleTileLods: [],
      visibleTileEntityIds: [],
      drawCalls: null,
      skirtDrawCalls: null,
      instances: null,
      drawCallCount: 0,
      instanceCount: 0,
      triangleCount: 0,
      qualityScale: this._qualityScale,
      lastFrameMs: 0,
      stageMs: this._frameTiming.stageMs,
      visibleCount: 0
    };

    // -----------------------------------------------------------------
    // Diagnostics
    // -----------------------------------------------------------------
    this.stats = {
      framesProcessed: 0,
      totalFrameMs: 0,
      avgFrameMs: 0,
      peakFrameMs: 0,
      totalVisibleTiles: 0,
      peakVisibleTiles: 0,
      memoryEvictions: 0,
      gcQualityDrops: 0,
      budgetQualityDrops: 0,
      lastUpdatedTick: 0
    };
  }

  // ---------------------------------------------------------------------
  // Subsystem construction
  // ---------------------------------------------------------------------

  _buildSubsystems() {
    const mask = this._subsystemMask;

    // ---- SOURCE ----
    if (mask & SubsystemId.SOURCE) {
      this.source = this.options.source ?? new TerrainSource({
        sourceId: this.options.sourceId,
        tilesetId: this.options.tilesetId,
        targetHz: this.options.targetHz10
      });
    }

    // ---- TILESET ----
    if (mask & SubsystemId.TILESET) {
      this.tileset = this.options.tileset ?? new Tileset3D({
        tilesetId: this.options.tilesetId,
        tileWorldSize: this.options.tileWorldSize,
        maxLod: this.options.maxLod,
        sseTarget: this.options.screenSpaceErrorTarget,
        targetHz: this.options.targetHz10
      });
    }

    // ---- LOD FIDELITY ----
    if (mask & SubsystemId.LOD_FIDELITY) {
      this.lodFidelity = this.options.lodFidelity ?? new TerrainLODFidelity3D({
        targetHz: this.options.targetHz10,
        screenSpaceErrorTarget: this.options.screenSpaceErrorTarget,
        maxLod: this.options.maxLod
      });
    }

    // ---- SEAM STITCHER ----
    if (mask & SubsystemId.SEAM_STITCHER) {
      this.seamStitcher = this.options.seamStitcher ?? new TerrainSeamStitcher3D({
        targetHz: this.options.targetHz10
      });
    }

    // ---- QUERY ENGINE ----
    if (mask & SubsystemId.QUERY_ENGINE) {
      this.queryEngine = this.options.queryEngine ?? new TerrainQueryCollision3D({
        targetHz: this.options.targetHz10
      });
    }

    // ---- MATERIAL BRIDGE ----
    if (mask & SubsystemId.MATERIAL_BRIDGE) {
      this.materialBridge = this.options.materialBridge ?? new TerrainMaterialBridge3D({
        targetHz: this.options.targetHz10
      });
    }

    // ---- HYDROLOGY ----
    if (mask & SubsystemId.HYDROLOGY && this.options.enableHydrology) {
      this.hydrology = this.options.hydrology ?? new TerrainProceduralHydrology3D({
        targetHz: this.options.targetHz10,
        maxGridResolution: this.options.hydrologyMaxResolution
      });
    }

    // ---- SCATTER ----
    if (mask & SubsystemId.SCATTER && this.options.enableScatter) {
      this.scatter = this.options.scatter ?? new TerrainProceduralScatter3D({
        targetHz: this.options.targetHz10,
        samplingResolution: this.options.scatterSamplingResolution,
        maxInstancesPerTile: this.options.scatterMaxPerTile
      });
    }

    // ---- FAUNA ----
    if (mask & SubsystemId.FAUNA && this.options.enableFauna) {
      this.fauna = this.options.fauna ?? new TerrainProceduralFauna3D({
        targetHz: this.options.targetHz10,
        maxInstancesPerTile: this.options.faunaMaxPerTile,
        lodReducedRadius: this.options.faunaLodRadius
      });
    }

    // ---- WEATHER ----
    if (mask & SubsystemId.WEATHER && this.options.enableWeather) {
      this.weather = this.options.weather ?? new TerrainProceduralWeather3D({
        targetHz: this.options.targetHz10,
        enableLightning: this.options.enableLightning,
        enableTornadoes: this.options.enableTornadoes
      });
    }

    // ---- TRAVERSAL ----
    if (mask & SubsystemId.TRAVERSAL) {
      this.traversal = this.options.traversal ?? new TerrainTileset3DTraversal({
        mode: this.options.enableParallelTraversal
          ? 'worker_pool'   // matches TraversalMode.WORKER_POOL
          : 'single_threaded',
        maxWorkers: this.options.traversalWorkerCount,
        maxSelectedPerFrame: this.options.traversalMaxSelectedPerFrame
      });
    }

    // ---- RENDER DISPATCH ----
    if (mask & SubsystemId.RENDER_DISPATCH) {
      this.renderDispatch = this.options.renderDispatch ?? new TerrainRenderDispatch3D({
        targetHz: this.options.targetHz60,
        targetFrameMs: this.options.frameBudgetMs
      });
    }

    // ---- RECONCILER (2D legacy — optional) ----
    if (mask & SubsystemId.RECONCILER) {
      this.reconciler = new TerrainTileReconciler({
        targetHz: this.options.targetHz10
      });
    }
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  /**
   * Binds the orchestrator to the runtime. Called once at startup.
   */
  bind(contextFrame, ecsWorld, eventDispatcher = null) {
    this.frame = contextFrame;
    this.ecsWorld = ecsWorld;
    this.eventDispatcher = eventDispatcher;

    // ---- Bind SOURCE ----
    if (this.source) {
      this.source.bind(contextFrame, ecsWorld, eventDispatcher);
    }

    // ---- Bind TILESET ----
    if (this.tileset) {
      // Tileset3D expects bind(frame, ecsWorld, source, dispatcher)
      this.tileset.bind(contextFrame, ecsWorld, this.source, eventDispatcher);
    }

    // ---- Bind QUERY ENGINE ----
    if (this.queryEngine && this.source) {
      this.queryEngine.bind(contextFrame, ecsWorld, this.source, eventDispatcher);
    }

    // ---- Bind MATERIAL BRIDGE ----
    if (this.materialBridge) {
      this.materialBridge.bind(contextFrame, ecsWorld, eventDispatcher);
    }

    // ---- Bind HYDROLOGY ----
    if (this.hydrology) {
      this.hydrology.bind(
        contextFrame, ecsWorld, this.source, this.queryEngine, eventDispatcher
      );
    }

    // ---- Bind SCATTER ----
    if (this.scatter) {
      this.scatter.bind(
        contextFrame, ecsWorld, this.source, this.queryEngine,
        this.hydrology, this.materialBridge, this.lodFidelity,
        null, eventDispatcher
      );
    }

    // ---- Bind FAUNA ----
    if (this.fauna) {
      this.fauna.bind(
        contextFrame, ecsWorld, this.source, this.queryEngine,
        this.hydrology, this.scatter, this.lodFidelity,
        null, null, eventDispatcher
      );
    }

    // ---- Bind WEATHER ----
    if (this.weather) {
      this.weather.bind(
        contextFrame, ecsWorld, this.source, this.queryEngine,
        this.hydrology, this.scatter, this.fauna, this.lodFidelity,
        this.materialBridge, eventDispatcher
      );
    }

    // ---- Bind LOD FIDELITY ----
    if (this.lodFidelity) {
      this.lodFidelity.bind(contextFrame, ecsWorld, eventDispatcher);
    }

    // ---- Bind SEAM STITCHER ----
    if (this.seamStitcher) {
      this.seamStitcher.bind(contextFrame, ecsWorld, eventDispatcher);
    }

    // ---- Bind TRAVERSAL ----
    if (this.traversal) {
      this.traversal.bind(
        contextFrame, ecsWorld,
        this.tileset, this.lodFidelity, this.seamStitcher,
        this.renderDispatch, eventDispatcher
      );
    }

    // ---- Bind RENDER DISPATCH ----
    if (this.renderDispatch) {
      this.renderDispatch.bind(contextFrame, ecsWorld, eventDispatcher);
    }

    // ---- Bind RECONCILER ----
    if (this.reconciler) {
      this.reconciler.bind(contextFrame, ecsWorld, eventDispatcher);
    }

    // ---- Bind governors ----
    this._frameBudget.bind?.(contextFrame, ecsWorld);
    this._gcMonitor.bind?.(contextFrame, ecsWorld);
    this._memoryEnforcer.bind?.(contextFrame, ecsWorld);
    this._memoryProfiler.bind?.(contextFrame, ecsWorld);

    // ---- Bind the singleton component ----
    this._bindSingletonComponent();

    return this;
  }

  _bindSingletonComponent() {
    if (!this.ecsWorld) return;
    if (this._orchestratorEntityId === undefined) {
      this._orchestratorEntityId = this.ecsWorld.createEntity?.() ?? 0xFFFFFFFF;
    }
    if (this._orchestratorEntityId === 0xFFFFFFFF) return;

    this.ecsWorld.addComponent?.(this._orchestratorEntityId, MasterOrchestratorComponent, {
      frameId: 0,
      activeSubsystems: this._subsystemMask,
      qualityScale: this._qualityScale,
      frameBudgetMs: this.options.frameBudgetMs,
      lastFrameMs: 0,
      totalMs: 0,
      visibleTileCount: 0,
      readyTileCount: 0,
      residentBytes: 0,
      gcPauseMs: 0,
      stage0Ms: 0, stage1Ms: 0, stage2Ms: 0,
      stage3Ms: 0, stage4Ms: 0, stage5Ms: 0,
      lastUpdatedTick: 0
    });
  }

  // ---------------------------------------------------------------------
  // Main update — the single entry point
  // ---------------------------------------------------------------------

  /**
   * Drives the entire pipeline for one frame.
   *
   * @param {ContextFrame} contextFrame
   * @param {number} tick
   * @param {number} dt
   * @param {object} camera – { x, y, z, forwardX, ..., fov, screenWidth, screenHeight }
   * @param {string|number} viewportId – optional; defaults to 'main'
   * @returns {object} the published frame record
   */
  update(contextFrame, tick, dt, camera, viewportId = 'main') {
    this.frame = contextFrame;
    this.lastTick = tick;
    this._frameId++;

    const frameStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // ---- Accumulators ----
    this._acc60 += dt;
    this._acc10 += dt;
    this._acc1 += dt;

    const interval60 = 1 / this.options.targetHz60;
    const interval10 = 1 / this.options.targetHz10;
    const interval1 = 1 / this.options.targetHz1;

    // ---- Reset per-frame published ----
    this._resetPublished();

    // ═════════════════════════════════════════════════════════════════
    // STAGE 1 — Build the frame from providers
    // ═════════════════════════════════════════════════════════════════
    const stage0Start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._buildFrame(contextFrame, tick, camera, viewportId);
    const stage0End = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._frameTiming.stageMs[StageId.BUILD_FRAME] = stage0End - stage0Start;

    // ═════════════════════════════════════════════════════════════════
    // STAGE 2 — Drain the causal buffer
    // (Handled by the context frame's own causal provider; here we only
    //  decay events that the pipeline itself emitted.)
    // ═════════════════════════════════════════════════════════════════
    const stage1Start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._drainCausal(contextFrame, tick, dt);
    const stage1End = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._frameTiming.stageMs[StageId.DRAIN_CAUSAL] = stage1End - stage1Start;

    // ═════════════════════════════════════════════════════════════════
    // STAGE 3 — 1 Hz tier
    // ═════════════════════════════════════════════════════════════════
    if (this._acc1 >= interval1) {
      const dt1 = this._acc1;
      this._acc1 %= interval1;
      const stage2Start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this._runTier1Hz(contextFrame, tick, dt1);
      const stage2End = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this._frameTiming.stageMs[StageId.TIER_1HZ] = stage2End - stage2Start;
    }

    // ═════════════════════════════════════════════════════════════════
    // STAGE 4 — 10 Hz tier
    // ═════════════════════════════════════════════════════════════════
    if (this._acc10 >= interval10) {
      const dt10 = this._acc10;
      this._acc10 %= interval10;
      const stage3Start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this._runTier10Hz(contextFrame, tick, dt10, camera, viewportId);
      const stage3End = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this._frameTiming.stageMs[StageId.TIER_10HZ] = stage3End - stage3Start;
    }

    // ═════════════════════════════════════════════════════════════════
    // STAGE 5 — 60 Hz tier
    // ═════════════════════════════════════════════════════════════════
    if (this._acc60 >= interval60) {
      const dt60 = this._acc60;
      this._acc60 %= interval60;
      const stage4Start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this._runTier60Hz(contextFrame, tick, dt60, camera, viewportId);
      const stage4End = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this._frameTiming.stageMs[StageId.TIER_60HZ] = stage4End - stage4Start;
    }

    // ═════════════════════════════════════════════════════════════════
    // STAGE 6 — Emit render outputs (NEVER triggers a stage 1 rebuild)
    // ═════════════════════════════════════════════════════════════════
    const stage5Start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._emitRender(contextFrame, tick);
    const stage5End = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._frameTiming.stageMs[StageId.EMIT_RENDER] = stage5End - stage5Start;

    // ---- Total frame time ----
    const frameEnd = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const frameMs = frameEnd - frameStart;
    this._frameTiming.totalMs = frameMs;
    this._frameTiming.frameId = this._frameId;
    this._frameTiming.qualityScale = this._qualityScale;

    // ---- Update governors ----
    this._updateGovernor(frameMs, contextFrame, tick);

    // ---- Sync the singleton component ----
    this._syncSingletonComponent(tick, frameMs);

    // ---- Return published ----
    this._published.frame = this._frameTiming;
    this._published.qualityScale = this._qualityScale;
    this._published.lastFrameMs = frameMs;

    // ---- Diagnostics ----
    this.stats.framesProcessed++;
    this.stats.totalFrameMs += frameMs;
    this.stats.avgFrameMs = this.stats.totalFrameMs / this.stats.framesProcessed;
    if (frameMs > this.stats.peakFrameMs) this.stats.peakFrameMs = frameMs;
    this.stats.lastUpdatedTick = tick;

    return this._published;
  }

  // ---------------------------------------------------------------------
  // STAGE 1 — Build the frame from providers
  // ---------------------------------------------------------------------

  _buildFrame(contextFrame, tick, camera, viewportId) {
    // 1. Traversal — tells us which tiles are visible.
    if (this.traversal) {
      this.traversal.update(contextFrame, tick, 1 / this.options.targetHz60, camera);
    }

    // 2. Collect the currently-visible tiles.
    let visibleTiles = null;
    if (this.traversal) {
      const sel = this.traversal.getSelection();
      visibleTiles = sel.count > 0 ? sel.tileKeys : null;
    }

    // 3. Build the "visible headers" list for the downstream systems.
    //    This is the list of tiles that the material bridge, scatter,
    //    fauna, weather, hydrology, and LOD fidelity will process.
    const headers = this._scratchVisibleHeaders;
    headers.length = 0;

    if (visibleTiles && this.tileset) {
      const queryEngine = this.queryEngine;
      for (let i = 0; i < visibleTiles.length; i++) {
        const key = visibleTiles[i];
        const tile = this.tileset.getTileByKey(key);
        if (!tile) continue;
        if (tile.loadState !== 4 /* READY */) continue;
        // Wrap the tile as a lightweight "header" the 2D systems can process.
        headers.push({
          tileKey: tile.tileKey,
          tileKeyHash: tile.tileKeyHash,
          entityId: tile.entityId,
          lod: tile.lod,
          state: TileState.READY,
          minX: tile._aabb?.[0] ?? 0,
          minY: tile._aabb?.[1] ?? 0,
          minZ: tile._aabb?.[2] ?? 0,
          maxX: tile._aabb?.[3] ?? 0,
          maxY: tile._aabb?.[4] ?? 0,
          maxZ: tile._aabb?.[5] ?? 0,
          centerX: tile.boundingVolume?.getCenter()[0] ?? 0,
          centerY: tile.boundingVolume?.getCenter()[1] ?? 0,
          centerZ: tile.boundingVolume?.getCenter()[2] ?? 0,
          boundingSphereRadius: tile.boundingVolume?.getRadius() ?? 0,
          tileWorldSize: this.options.tileWorldSize,
          originX: tile._aabb?.[0] ?? 0,
          originY: tile._aabb?.[1] ?? 0,
          blendAlpha: 1.0,
          priority: tile.priority,
          seamFlags: 0,
          neighborLods: { north: -1, south: -1, east: -1, west: -1 },
          _tile3D: tile
        });
      }
    }

    // 4. Publish the visible headers to the frame's spatial channel.
    if (this.frame?.layers?.spatial) {
      const spatial = this.frame.layers.spatial;
      spatial.visibleTileKeys = headers.map(h => h.tileKey);
      spatial.visibleTileLods = headers.map(h => h.lod);
      spatial.visibleTileEntityIds = headers.map(h => h.entityId);
      spatial.visibleTileCount = headers.length;
    }

    // 5. Track per-frame tile counts.
    this.stats.totalVisibleTiles += headers.length;
    if (headers.length > this.stats.peakVisibleTiles) {
      this.stats.peakVisibleTiles = headers.length;
    }
    this._published.visibleCount = headers.length;
  }

  // ---------------------------------------------------------------------
  // STAGE 2 — Drain causal events
  // ---------------------------------------------------------------------

  _drainCausal(contextFrame, tick, dt) {
    // The causal provider already handles this in the context frame itself.
    // We only need to forward pipeline-specific events (impacts, ignitions)
    // to the material bridge so it can respond to scorch/impact events.
    if (!this.materialBridge) return;
    if (!contextFrame?.layers?.causal?.events) return;

    const events = contextFrame.layers.causal.events;
    for (let i = 0; i < events.length; i++) {
      const evt = events[i];
      if (evt.type === EVENT_TYPE.IMPACT || evt.type === EVENT_TYPE.IGNITE) {
        this.materialBridge.handleCausalEvent?.(evt, tick);
      }
    }
  }

  // ---------------------------------------------------------------------
  // STAGE 3 — 1 Hz tier
  // ---------------------------------------------------------------------

  _runTier1Hz(contextFrame, tick, dt) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // Memory ceiling enforcement.
    const bytes = this._measureResidentBytes();
    this._frameTiming.memoryBytes = bytes;
    if (bytes > this.options.maxResidentBytes) {
      this._enforceMemoryCeiling(bytes);
    }

    // Flush persistence (if any subsystem has it).
    if (this.tileset?.flushPersistence) {
      this.tileset.flushPersistence().catch(() => {});
    }

    this._frameTiming.subsystemMs[0] = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  }

  // ---------------------------------------------------------------------
  // STAGE 4 — 10 Hz tier
  // ---------------------------------------------------------------------

  _runTier10Hz(contextFrame, tick, dt, camera, viewportId) {
    const headers = this._scratchVisibleHeaders;

    // ---- LOD fidelity (first — everything downstream depends on it) ----
    if (this.lodFidelity) {
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this.lodFidelity.update(contextFrame, tick, dt, headers, this.source, camera);
      this._frameTiming.subsystemMs[9] = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    }

    // ---- Seam stitcher ----
    if (this.seamStitcher) {
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this.seamStitcher.update(contextFrame, tick, dt, headers, this.source, camera);
      this._frameTiming.subsystemMs[10] = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    }

    // ---- Query engine ----
    if (this.queryEngine) {
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this.queryEngine.update(contextFrame, tick, dt, headers);
      this._frameTiming.subsystemMs[11] = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    }

    // ---- Material bridge ----
    if (this.materialBridge) {
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this.materialBridge.update(contextFrame, tick, dt, headers, this.source);
      this._frameTiming.subsystemMs[4] = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    }

    // ---- Hydrology ----
    if (this.hydrology) {
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this.hydrology.update(contextFrame, tick, dt, headers);
      this._frameTiming.subsystemMs[8] = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    }

    // ---- Scatter ----
    if (this.scatter) {
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this.scatter.update(contextFrame, tick, dt, headers);
      this._frameTiming.subsystemMs[5] = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    }

    // ---- Fauna ----
    if (this.fauna) {
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this.fauna.update(contextFrame, tick, dt, headers);
      this._frameTiming.subsystemMs[6] = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    }

    // ---- Weather ----
    if (this.weather) {
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this.weather.update(contextFrame, tick, dt, headers);
      this._frameTiming.subsystemMs[7] = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    }

    // ---- Tileset + source (last — they may add or remove tiles) ----
    if (this.tileset) {
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this.tileset.update(contextFrame, tick, dt, camera);
      this._frameTiming.subsystemMs[1] = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    }

    if (this.source) {
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this.source.update(contextFrame, tick, dt);
      this._frameTiming.subsystemMs[0] = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    }
  }

  // ---------------------------------------------------------------------
  // STAGE 5 — 60 Hz tier
  // ---------------------------------------------------------------------

  _runTier60Hz(contextFrame, tick, dt, camera, viewportId) {
    const headers = this._scratchVisibleHeaders;

    // ---- Render dispatch ----
    if (this.renderDispatch) {
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this.renderDispatch.update(
        contextFrame, tick, dt, headers,
        this.materialBridge, this.source
      );
      this._frameTiming.subsystemMs[12] = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    }
  }

  // ---------------------------------------------------------------------
  // STAGE 6 — Emit render outputs
  // ---------------------------------------------------------------------

  _emitRender(contextFrame, tick) {
    // Pull the draw-call arenas from the render dispatcher.
    if (this.renderDispatch) {
      const drawCalls = this.renderDispatch.getDrawCalls();
      const instances = this.renderDispatch.getInstances();
      this._published.drawCalls = drawCalls;
      this._published.instances = instances;
      this._published.skirtDrawCalls = this.renderDispatch.getSkirtDrawCalls?.() ?? null;
      this._published.drawCallCount = drawCalls.count;
      this._published.instanceCount = instances.count;
      this._published.triangleCount = this.renderDispatch._published?.triangleCount ?? 0;
    }

    // Publish into the frame's render channel.
    if (contextFrame?.layers?.render) {
      contextFrame.layers.render.masterOrchestratorFrame = this._published;
    } else if (contextFrame) {
      if (!contextFrame.layers.render) contextFrame.layers.render = {};
      contextFrame.layers.render.masterOrchestratorFrame = this._published;
    }
  }

  // ---------------------------------------------------------------------
  // Adaptive quality governor
  // ---------------------------------------------------------------------

  _updateGovernor(frameMs, contextFrame, tick) {
    // Rolling window average.
    const window = this._qualityHistory;
    const idx = this._qualityHistoryIndex;
    this._qualityHistorySum -= window[idx];
    window[idx] = frameMs;
    this._qualityHistorySum += frameMs;
    this._qualityHistoryIndex = (idx + 1) % window.length;

    const avgMs = this._qualityHistorySum / window.length;
    const targetMs = this.options.frameBudgetMs;

    // Compute target scale.
    let targetScale = targetMs / Math.max(avgMs, 0.001);
    targetScale = Math.max(this.options.governorMinQuality,
                  Math.min(this.options.governorMaxQuality, targetScale));

    // Apply GC penalty.
    const gcPause = this._gcMonitor.lastPauseMs ?? 0;
    this._frameTiming.gcPauseMs = gcPause;
    if (gcPause > this.options.gcPauseThresholdMs) {
      targetScale *= 0.5;
      this.stats.gcQualityDrops++;
    }

    // Smooth.
    const smoothing = this.options.governorSmoothing;
    this._qualityScale = this._qualityScale * (1 - smoothing) + targetScale * smoothing;

    // Push the quality scale into every subsystem that accepts it.
    if (this.renderDispatch?.setQualityScale) {
      this.renderDispatch.setQualityScale(this._qualityScale);
    }
    if (this.scatter) {
      // Halve density at low quality.
      this.scatter.options.maxInstancesPerTile = Math.max(
        64,
        Math.floor(this.options.scatterMaxPerTile * this._qualityScale)
      );
    }
    if (this.fauna) {
      // Shrink the LOD radius at low quality.
      this.fauna.options.lodReducedRadius = Math.max(
        100,
        this.options.faunaLodRadius * this._qualityScale
      );
    }
    if (this.hydrology) {
      // Halve solver iterations at low quality.
      this.hydrology.options.solverIterationsPerTick = Math.max(
        1,
        Math.floor(2 * this._qualityScale)
      );
    }
    if (this.weather) {
      // Reduce particle cap at low quality.
      this.weather.options.maxParticlesPerTile = Math.max(
        32,
        Math.floor(512 * this._qualityScale)
      );
    }

    // Frame budget monitor.
    this._frameBudget.sample?.(frameMs);
  }

  // ---------------------------------------------------------------------
  // Memory ceiling enforcement
  // ---------------------------------------------------------------------

  _measureResidentBytes() {
    let total = 0;
    if (this.hydrology) total += this.hydrology.getStats?.()?.arenaUsed * 4 || 0;
    if (this.scatter) total += this.scatter.getStats?.()?.arenaUsed * 4 || 0;
    if (this.fauna) total += this.fauna.getStats?.()?.arenaUsed * 4 || 0;
    if (this.weather) total += this.weather.getStats?.()?.arenaUsed * 4 || 0;
    if (this.materialBridge) total += this.materialBridge.getStats?.()?.arenaUsed * 4 || 0;
    if (this.traversal) total += this.traversal.getStats?.()?.snapshotNodes * 32 || 0;
    return total;
  }

  _enforceMemoryCeiling(bytes) {
    // Evict the coldest subsystem first.
    const overflow = bytes - this.options.maxResidentBytes;

    // 1. Weather effects (cheapest to regenerate).
    if (this.weather) {
      const evicted = this._evictSubsystem(this.weather, overflow);
      if (evicted > 0) { this.stats.memoryEvictions++; return; }
    }
    // 2. Scatter instances.
    if (this.scatter) {
      const evicted = this._evictSubsystem(this.scatter, overflow);
      if (evicted > 0) { this.stats.memoryEvictions++; return; }
    }
    // 3. Fauna.
    if (this.fauna) {
      const evicted = this._evictSubsystem(this.fauna, overflow);
      if (evicted > 0) { this.stats.memoryEvictions++; return; }
    }
    // 4. Hydrology.
    if (this.hydrology) {
      const evicted = this._evictSubsystem(this.hydrology, overflow);
      if (evicted > 0) { this.stats.memoryEvictions++; return; }
    }
  }

  _evictSubsystem(subsystem, overflowBytes) {
    if (!subsystem._tileStates) return 0;
    let freed = 0;
    const toEvict = [];
    for (const [key, state] of subsystem._tileStates) {
      const stateBytes = (state.cellCount || state.instanceCount || 1) * 32;
      if (freed >= overflowBytes) break;
      toEvict.push(key);
      freed += stateBytes;
    }
    for (const key of toEvict) {
      subsystem._tileStates.delete(key);
    }
    return toEvict.length;
  }

  // ---------------------------------------------------------------------
  // Publishing
  // ---------------------------------------------------------------------

  _resetPublished() {
    const p = this._published;
    p.visibleTileKeys.length = 0;
    p.visibleTileLods.length = 0;
    p.visibleTileEntityIds.length = 0;
    p.drawCallCount = 0;
    p.instanceCount = 0;
    p.triangleCount = 0;
    p.visibleCount = 0;
  }

  _syncSingletonComponent(tick, frameMs) {
    if (!this.ecsWorld || this._orchestratorEntityId === 0xFFFFFFFF) return;
    const comp = this.ecsWorld.getComponent?.(this._orchestratorEntityId, MasterOrchestratorComponent);
    if (!comp) return;

    comp.frameId = this._frameId;
    comp.activeSubsystems = this._subsystemMask;
    comp.qualityScale = this._qualityScale;
    comp.frameBudgetMs = this.options.frameBudgetMs;
    comp.lastFrameMs = frameMs;
    comp.totalMs = this._frameTiming.totalMs;
    comp.visibleTileCount = this._published.visibleCount;
    comp.readyTileCount = this._published.instanceCount;
    comp.residentBytes = this._frameTiming.memoryBytes;
    comp.gcPauseMs = this._frameTiming.gcPauseMs;
    comp.stage0Ms = this._frameTiming.stageMs[0];
    comp.stage1Ms = this._frameTiming.stageMs[1];
    comp.stage2Ms = this._frameTiming.stageMs[2];
    comp.stage3Ms = this._frameTiming.stageMs[3];
    comp.stage4Ms = this._frameTiming.stageMs[4];
    comp.stage5Ms = this._frameTiming.stageMs[5];
    comp.lastUpdatedTick = tick;
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  /**
   * Returns the current published frame record.
   */
  getFrame() {
    return this._published;
  }

  /**
   * Returns the current quality scale.
   */
  getQualityScale() {
    return this._qualityScale;
  }

  /**
   * Manually sets the quality scale (for explicit low-power mode).
   */
  setQualityScale(scale) {
    this._qualityScale = Math.max(
      this.options.governorMinQuality,
      Math.min(this.options.governorMaxQuality, scale)
    );
  }

  /**
   * Enables or disables a subsystem at runtime.
   */
  setSubsystemEnabled(subsystemBit, enabled) {
    if (enabled) this._subsystemMask |= subsystemBit;
    else this._subsystemMask &= ~subsystemBit;
  }

  /**
   * Returns the full per-stage timing record.
   */
  getFrameTiming() {
    return this._frameTiming;
  }

  /**
   * Returns the aggregated stats.
   */
  getStats() {
    return {
      ...this.stats,
      qualityScale: this._qualityScale,
      activeSubsystems: this._subsystemMask,
      residentBytes: this._frameTiming.memoryBytes,
      maxResidentBytes: this.options.maxResidentBytes,
      frameBudgetMs: this.options.frameBudgetMs,
      subsystemCount: this._countActiveSubsystems()
    };
  }

  _countActiveSubsystems() {
    let n = 0;
    let mask = this._subsystemMask;
    while (mask) { n += mask & 1; mask >>= 1; }
    return n;
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  /**
   * Clears all per-tile state without destroying the orchestrator.
   */
  clear() {
    if (this.source) this.source.clear?.();
    if (this.tileset) this.tileset.clear?.();
    if (this.hydrology) this.hydrology.clear?.();
    if (this.scatter) this.scatter.clear?.();
    if (this.fauna) this.fauna.clear?.();
    if (this.weather) this.weather.clear?.();
    if (this.materialBridge) this.materialBridge.dispose?.();
    if (this.lodFidelity) this.lodFidelity.dispose?.();
    if (this.seamStitcher) this.seamStitcher.dispose?.();
    if (this.traversal) this.traversal.clear?.();
    if (this.renderDispatch) this.renderDispatch.dispose?.();

    this._scratchVisibleHeaders.length = 0;
    this._resetPublished();
  }

  /**
   * Destroys the orchestrator and every subsystem it owns.
   */
  dispose() {
    this.clear();

    if (this.source) this.source.dispose?.();
    if (this.tileset) this.tileset.dispose?.();
    if (this.hydrology) this.hydrology.dispose?.();
    if (this.scatter) this.scatter.dispose?.();
    if (this.fauna) this.fauna.dispose?.();
    if (this.weather) this.weather.dispose?.();
    if (this.materialBridge) this.materialBridge.dispose?.();
    if (this.lodFidelity) this.lodFidelity.dispose?.();
    if (this.seamStitcher) this.seamStitcher.dispose?.();
    if (this.queryEngine) this.queryEngine.dispose?.();
    if (this.traversal) this.traversal.dispose?.();
    if (this.renderDispatch) this.renderDispatch.dispose?.();
    if (this.reconciler) this.reconciler.dispose?.();

    this.frame = null;
    this.ecsWorld = null;
    this.eventDispatcher = null;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 4. FACTORY
// ═════════════════════════════════════════════════════════════════════

/**
 * Creates a fully-wired master orchestrator.
 *
 * Usage:
 *   const orchestrator = createTerrainPipelineMasterOrchestrator3D({
 *     subsystems: SubsystemId.FULL,
 *     maxResidentBytes: 200 * 1024 * 1024,
 *     frameBudgetMs: 8
 *   });
 *   orchestrator.bind(contextFrame, ecsWorld, dispatcher);
 *
 *   // Per frame:
 *   const frame = orchestrator.update(contextFrame, tick, dt, camera);
 *   renderer.draw(frame.drawCalls, frame.instances);
 */
export function createTerrainPipelineMasterOrchestrator3D(options = {}) {
  return new TerrainPipelineMasterOrchestrator3D({
    orchestratorId: options.orchestratorId ?? 1,
    tilesetId: options.tilesetId ?? 1,
    sourceId: options.sourceId ?? 1,
    subsystems: options.subsystems ?? SubsystemId.FULL,
    targetHz60: options.targetHz60 ?? 60,
    targetHz10: options.targetHz10 ?? 10,
    targetHz1: options.targetHz1 ?? 1,
    frameBudgetMs: options.frameBudgetMs ?? 8,
    governorWindow: options.governorWindow ?? 16,
    governorSmoothing: options.governorSmoothing ?? 0.15,
    governorMinQuality: options.governorMinQuality ?? 0.25,
    governorMaxQuality: options.governorMaxQuality ?? 1.0,
    maxResidentBytes: options.maxResidentBytes ?? 200 * 1024 * 1024,
    memoryCheckIntervalTicks: options.memoryCheckIntervalTicks ?? 10,
    gcPauseThresholdMs: options.gcPauseThresholdMs ?? 2.0,
    tileWorldSize: options.tileWorldSize ?? 100,
    maxLod: options.maxLod ?? 12,
    screenSpaceErrorTarget: options.screenSpaceErrorTarget ?? 16,
    enableScatter: options.enableScatter ?? true,
    scatterSamplingResolution: options.scatterSamplingResolution ?? 32,
    scatterMaxPerTile: options.scatterMaxPerTile ?? 2048,
    enableFauna: options.enableFauna ?? true,
    faunaMaxPerTile: options.faunaMaxPerTile ?? 64,
    faunaLodRadius: options.faunaLodRadius ?? 500,
    enableWeather: options.enableWeather ?? true,
    enableLightning: options.enableLightning ?? true,
    enableTornadoes: options.enableTornadoes ?? true,
    enableHydrology: options.enableHydrology ?? true,
    hydrologyMaxResolution: options.hydrologyMaxResolution ?? 129,
    enableParallelTraversal: options.enableParallelTraversal ?? true,
    traversalWorkerCount: options.traversalWorkerCount ?? 2,
    traversalMaxSelectedPerFrame: options.traversalMaxSelectedPerFrame ?? 4096,
    enableDiagnostics: options.enableDiagnostics ?? true,
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 5. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  TerrainPipelineMasterOrchestrator3D,
  MasterOrchestratorComponent,
  FrameStageTiming,
  TierId,
  StageId,
  SubsystemId,
  QualityPreset,
  createTerrainPipelineMasterOrchestrator3D
};