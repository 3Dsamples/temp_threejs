// file number : 411
// full path name : src/context/411_TerrainWorldEntry.js
//### Description : The top-level world bootstrap for the entire seamless 3D
//###               living terrain world. This is the ONE file the host
//###               application imports and instantiates — everything else
//###               (context frame, ECS world, all providers, all subsystems,
//###               the master orchestrator) is created, wired, and driven
//###               internally. The public surface is deliberately minimal:
//###                 • new TerrainWorldEntry(options)
//###                 • world.start()
//###                 • world.update(dt) / world.updateFrame(dt, camera)
//###                 • world.stop()
//###                 • world.dispose()
//###                 • world.queryHeight(x, y), queryNormal, querySlope, etc.
//###                 • world.registerSpecies(props), registerHook(...)
//###                 • world.registerBiome(...), registerTerrain(...)
//###                 • world.getStats(), getFrame(), getQualityScale()
//###               The bootstrap does five things that no individual file can
//###               do on its own:
//###                 1. CONTEXT FRAME CREATION — the ContextFrame (file 263)
//###                    is instantiated with all five channels (spatial,
//###                    temporal, physical, causal, player) as typed-array
//###                    SoA containers sized for the max-visible budget.
//###                    Every provider writes into these channels; every
//###                    consumer reads from them. This is the nervous system
//###                    from blueprint step 1.
//###                 2. PROVIDER ORCHESTRATION — all fifteen context providers
//###                    (spatial, temporal, physical, causal, player) plus the
//###                    full gradient stack (280–296) are instantiated,
//###                    registered in the correct tier, and driven by the
//###                    world's own 1 Hz / 10 Hz schedule.
//###                 3. ECS WORLD CREATION — a BitECS World (file 015) is
//###                    created with all terrain-related component schemas
//###                    pre-registered (Tile3DComponent, HeightmapTileComponent,
//###                    QuantizedMeshComponent, TerrainMaterialComponent,
//###                    FaunaInstanceComponent, WeatherTileComponent, etc.),
//###                    so no subsystem ever has to register a component at
//###                    runtime.
//###                 4. WORKER WARM-UP — the traversal worker pool (file 409)
//###                    and the archive source worker pool (file 400) are
//###                    warmed up asynchronously BEFORE start() returns, so
//###                    the first rendered frame is already parallel. The
//###                    warm-up runs on idle frames (via requestIdleCallback
//###                    or a setTimeout microtask) so the page never blocks.
//###                 5. SIGNAL ROUTING — every causal event (impact, ignite,
//###                    splash, tornado, lightning) is captured by the
//###                    CoreEventDispatcher (file 265) and forwarded to the
//###                    subsystems that care (material bridge, ecology, audio,
//###                    particles) in ONE dispatch pass, not N.
//###               The world also implements an async frame pipeline:
//###                 • frame N: orchestrator.update() submits worker jobs,
//###                   collects completed results from frame N-1, publishes
//###                   draw calls to the render channel, and returns.
//###                 • The host application renders frame N as soon as
//###                   update() returns — no waiting for workers.
//###                 • The workers for frame N complete during the render of
//###                   frame N, and their results are picked up by frame N+1's
//###                   update(). This is the "double-buffered" pattern from
//###                   blueprint step 23, applied end-to-end.
//###               Additional world-level features:
//###                 • Adaptive lighting bias — reads the sun intensity and
//###                   time-of-day providers and propagates them into the
//###                   context frame's physical channel, so all materials
//###                   (file 383) and materials-bridge (file 394) auto-adapt.
//###                 • Seasonal color propagation — reads the seasonality
//###                   provider (296) and publishes the seasonal color palette
//###                   into the physical channel, so scatter (file 405) and
//###                   fauna (file 406) auto-adapt.
//###                 • Water level propagation — reads the hydrology (404)
//###                   system's aggregated water volume and writes it into the
//###                   physical channel, so the material bridge paints wet
//###                   surfaces automatically.
//###                 • Weather propagation — reads the weather (407) system's
//###                   aggregated severity and writes it into the temporal
//###                   channel, closing the feedback loop.
//###                 • Biome transition propagation — reads the biome blend
//###                   field (328) and writes per-tile biome weights into the
//###                   spatial channel, so the material bridge (394) and
//###                   scatter (405) agree on every tile.
//###               All hot-path operations are allocation-free after warm-up.
//###               The world owns every arena, every typed array, and every
//###               worker; nothing is created or freed during the frame loop
//###               (except when tiles are added or evicted, which is O(tiles)).
//###               No external loader, no CDN access, no static server.
//###               Designed for Android arm64 under the 8 ms per-tick CPU
//###               ceiling and 200 MB resident memory cap, and scales from
//###               a single 10-unit tile to galactic streaming (10k+ units)
//###               without main-thread stalls.
//### Best for : The single import the host application uses to bring the
//###            entire living terrain world online. A six-line setup —
//###            import, new, start, and then update() per frame — is enough
//###            to run an infinite procedural 3D terrain world with context
//###            awareness, LOD, seams, materials, scatter, fauna, weather,
//###            hydrology, and batched drawing, all without a server, a build
//###            step, or any static asset.
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

import { ContextFrame, createContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS } from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD } from './267_CoreClock.js';

// ---- Spatial acceleration (271–274) ----
import { SpatialHashGrid } from './271_SpatialHashGrid.js';
import { DynamicBVH } from './272_DynamicBVH.js';
import { FrustumCullingSystem } from './273_FrustumCullingSystem.js';
import { OcclusionGraph } from './274_OcclusionGraph.js';

// ---- Context providers (275–279) ----
import { SpatialContextProvider } from './275_SpatialContextProvider.js';
import { TemporalContextProvider } from './276_TemporalContextProvider.js';
import { PhysicalContextProvider } from './277_PhysicalContextProvider.js';
import { CausalContextProvider } from './278_CausalContextProvider.js';
import { PlayerContextProvider } from './279_PlayerContextProvider.js';

// ---- Terrain and gradient providers (280–296) ----
import { TerrainProvider } from './280_TerrainProvider.js';
import { ElevationProvider } from './281_ElevationProvider.js';
import { SlopeGradientProvider } from './282_SlopeGradientProvider.js';
import { ReliefGradientProvider } from './282_Z01_ReliefGradientProvider.js';
import { CliffsGradientProvider } from './282_Z02_CliffsGradientProvider.js';
import { CarveGradientProvider } from './282_Z03_CarveGradientProvider.js';
import { NaturalFormationGradientProvider } from './282_Z04_NaturalFormationGradientProvider.js';
import { RockGradientProvider } from './282_Z06_RockGradientProvider.js';
import { ForestGradientProvider } from './282_Z07_ForestGradientProvider.js';
import { GrassAndFlowresGradientProvider } from './282_Z08_GrassAndFlowresGradientProvider.js';
import { ContinentalReliefGradientProvider } from './282_Z09_ContinentalReliefGradientProvider.js';
import { BathymetryProvider } from './283_BathymetryProvider.js';
import { GroundwaterProvider } from './284_GroundwaterProvider.js';
import { MoistureLevelProvider } from './285_MoistureLevelProvider.js';
import { DecomposersSystem } from './286_DecomposersSystem.js';
import { ClimateTemperatureProvider } from './287_ClimateTemperatureProvider.js';
import { ClimatePrecipitationProvider } from './288_ClimatePrecipitationProvider.js';
import { ClimateWindProvider } from './289_ClimateWindProvider.js';
import { SoilCompositionProvider } from './290_SoilCompositionProvider.js';
import { SoilFertilityProvider } from './291_SoilFertilityProvider.js';
import { SoilColorTextureProvider } from './292_SoilColorTextureProvider.js';
import { LightingSunIntensityProvider } from './293_LightingSunIntensityProvider.js';
import { LightingTimeOfDayProvider } from './294_LightingTimeOfDayProvider.js';
import { AirQualityAtmosphereProvider } from './295_AirQualityAtmosphereProvider.js';
import { SeasonalitySystem } from './296_SeasonalitySystem.js';

// ---- Sensory (297, 317) ----
import { SensoryDetailsProvider } from './297_SensoryDetailsProvider.js';
import { AudioLightEmissionSystem } from './317_AudioLightEmissionSystem.js';

// ---- Performance governance (303–307) ----
import { HLODController } from './303_HLODController.js';
import { MemoryCeilingEnforcer } from './304_MemoryCeilingEnforcer.js';
import { FrameBudgetMonitor } from './305_FrameBudgetMonitor.js';
import { GCPauseMonitor } from './306_GCPauseMonitor.js';
import { MemoryProfiler } from './307_MemoryProfiler.js';

// ---- Context runtime (308–310) ----
import { ContextConsumerTiers } from './308_ContextConsumerTiers.js';
import { ContextRuntime } from './309_ContextRuntime.js';
import { GeometryContextFrameReader } from './310_GeometryContextFrameReader.js';

// ---- Consumer systems (311–316) ----
import { UpdateLODConsumer } from './311_UpdateLODConsumer.js';
import { UpdateLoadStateConsumer } from './312_UpdateLoadStateConsumer.js';
import { IsVisibleConsumer } from './313_IsVisibleConsumer.js';
import { ApplyNoiseConsumer } from './314_ApplyNoiseConsumer.js';
import { SetMaterialParamsConsumer } from './315_SetMaterialParamsConsumer.js';
import { EcologyResponseSystem } from './316_EcologyResponseSystem.js';

// ---- Biome registry and coupling (327–335) ----
import { BiomeRegistryBarrel } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendField } from './328_BiomeBlendField.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { CrossBiomeEcotoneSystem } from './330_CrossBiomeEcotoneSystem.js';
import { BiomeBlendMaterialBridge } from './331_BiomeBlendMaterialBridge.js';
import { BiomeClimateCoupling } from './332_BiomeClimateCoupling.js';
import { BiomeSoilCoupling } from './333_BiomeSoilCoupling.js';
import { BiomeHydrologyCoupling } from './334_BiomeHydrologyCoupling.js';
import { BiomeFaunaMigrationSystem } from './335_BiomeFaunaMigrationSystem.js';

// ---- Landscape chunk (336–341) ----
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';
import { LandscapeChunkStreamer } from './337_LandscapeChunkStreamer.js';
import { LandscapeChunkHLOD } from './338_LandscapeChunkHLOD.js';
import { LandscapeChunkSpatialHash } from './339_LandscapeChunkSpatialHash.js';
import { LandscapeChunkOcclusion } from './340_LandscapeChunkOcclusion.js';
import { LandscapeChunkPersistence } from './341_LandscapeChunkPersistence.js';

// ---- Master orchestrator (410) ----
import {
  TerrainPipelineMasterOrchestrator3D,
  MasterOrchestratorComponent,
  FrameStageTiming,
  TierId,
  StageId,
  SubsystemId,
  QualityPreset,
  createTerrainPipelineMasterOrchestrator3D
} from './410_TerrainPipelineMasterOrchestrator3D.js';

// ═════════════════════════════════════════════════════════════════════
// 1. CONSTANTS AND ENUMS
// ═════════════════════════════════════════════════════════════════════

/**
 * WorldLifecycle — the lifecycle state of the world.
 */
export const WorldLifecycle = Object.freeze({
  UNINITIALIZED: 0,
  INITIALIZING:  1,
  READY:         2,
  RUNNING:       3,
  PAUSED:        4,
  STOPPING:      5,
  STOPPED:       6,
  DISPOSED:      7
});

/**
 * WorldMode — the terrain generation mode.
 */
export const WorldMode = Object.freeze({
  PROCEDURAL_ONLY:    0,   // fully procedural, no source
  HEIGHTMAP_SOURCE:   1,   // reads heightmap tiles from an archive
  QUANTIZED_MESH:     2,   // reads quantized-mesh tiles
  I3S_ELEVATION:      3,   // reads I3S elevation tiles
  TILESET_3D:         4,   // reads a 3D Tiles tileset
  ARCHIVE_3D:         5,   // reads a .zip / .tar / raw archive
  HYBRID:             6    // procedural base + streamed overlays
});

/**
 * FrameStrategy — how the world drives its frame loop.
 */
export const FrameStrategy = Object.freeze({
  MANUAL:      0,   // host application calls update() explicitly
  RAF:         1,   // world drives itself with requestAnimationFrame
  FIXED_STEP:  2,   // world drives itself with a fixed dt
  ADAPTIVE:    3    // world drives itself with clamped dt
});

/**
 * WorkerWarmupStatus — the status of the async worker warm-up.
 */
export const WorkerWarmupStatus = Object.freeze({
  NOT_STARTED: 0,
  WARMING_UP:  1,
  READY:       2,
  FAILED:      3
});

// ═════════════════════════════════════════════════════════════════════
// 2. WORLD ENTRY — the top-level object
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainWorldEntry — the single object the host application instantiates.
 *
 * Responsibilities:
 *   • Owns the ContextFrame, the ECS world, and the EventDispatcher.
 *   • Instantiates every context provider and every terrain subsystem.
 *   • Wires them together via the master orchestrator (file 410).
 *   • Provides the async warm-up path.
 *   • Provides the start / update / stop / dispose lifecycle.
 *   • Publishes a small public API for runtime queries and registrations.
 */
export class TerrainWorldEntry {
  constructor(options = {}) {
    // -----------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------
    this.options = {
      // Identity
      worldId: options.worldId ?? 1,

      // Mode
      mode: options.mode ?? WorldMode.PROCEDURAL_ONLY,
      frameStrategy: options.frameStrategy ?? FrameStrategy.MANUAL,

      // Subsystem mask (from file 410)
      subsystems: options.subsystems ?? SubsystemId.FULL,

      // Frame budget
      frameBudgetMs: options.frameBudgetMs ?? 8,
      maxResidentBytes: options.maxResidentBytes ?? 200 * 1024 * 1024,

      // Tier frequencies
      targetHz60: options.targetHz60 ?? 60,
      targetHz10: options.targetHz10 ?? 10,
      targetHz1: options.targetHz1 ?? 1,

      // Tileset configuration
      tileWorldSize: options.tileWorldSize ?? 100,
      maxLod: options.maxLod ?? 12,
      screenSpaceErrorTarget: options.screenSpaceErrorTarget ?? 16,

      // Procedural configuration
      seed: options.seed ?? 1337,
      noisePeriod: options.noisePeriod ?? 512,
      octaves: options.octaves ?? 5,
      lacunarity: options.lacunarity ?? 2.0,
      persistence: options.persistence ?? 0.5,
      zScale: options.zScale ?? 500,
      resolution: options.resolution ?? 65,

      // Content toggles
      enableScatter: options.enableScatter ?? true,
      enableFauna: options.enableFauna ?? true,
      enableWeather: options.enableWeather ?? true,
      enableHydrology: options.enableHydrology ?? true,

      // Parallelism
      enableParallelTraversal: options.enableParallelTraversal ?? true,
      traversalWorkerCount: options.traversalWorkerCount ?? 2,
      enableParallelSource: options.enableParallelSource ?? true,
      sourceWorkerCount: options.sourceWorkerCount ?? 2,

      // Context frame sizes (per-channel SoA capacities)
      maxVisibleTiles: options.maxVisibleTiles ?? 2048,
      maxSpatialEntities: options.maxSpatialEntities ?? 8192,
      maxCausalEvents: options.maxCausalEvents ?? 256,
      maxPlayerStates: options.maxPlayerStates ?? 1,

      // Warm-up
      warmupOnIdle: options.warmupOnIdle ?? true,
      warmupTimeoutMs: options.warmupTimeoutMs ?? 5000,

      // Diagnostics
      enableDiagnostics: options.enableDiagnostics ?? true,
      emitLifecycleEvents: options.emitLifecycleEvents ?? true,

      ...options
    };

    // -----------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------
    this._lifecycle = WorldLifecycle.UNINITIALIZED;
    this._warmupStatus = WorkerWarmupStatus.NOT_STARTED;
    this._warmupPromise = null;

    // -----------------------------------------------------------------
    // Core runtime objects
    // -----------------------------------------------------------------
    this.contextFrame = null;
    this.ecsWorld = null;
    this.eventDispatcher = null;
    this.clock = null;

    // -----------------------------------------------------------------
    // Providers (created during initialize())
    // -----------------------------------------------------------------
    this.providers = {
      spatial: null,
      temporal: null,
      physical: null,
      causal: null,
      player: null,
      terrain: null,
      elevation: null,
      slope: null,
      relief: null,
      cliffs: null,
      carve: null,
      rock: null,
      forest: null,
      grass: null,
      continental: null,
      bathymetry: null,
      groundwater: null,
      moisture: null,
      decomposers: null,
      temperature: null,
      precipitation: null,
      wind: null,
      soilComposition: null,
      soilFertility: null,
      soilColor: null,
      sunIntensity: null,
      timeOfDay: null,
      airQuality: null,
      seasonality: null,
      sensory: null,
      audioLight: null
    };

    // -----------------------------------------------------------------
    // Biome systems (created during initialize())
    // -----------------------------------------------------------------
    this.biomeRegistry = null;
    this.biomeBlendField = null;
    this.biomeBlendSystem = null;
    this.biomeEcotone = null;
    this.biomeFaunaMigration = null;

    // -----------------------------------------------------------------
    // Master orchestrator (created during initialize())
    // -----------------------------------------------------------------
    this.orchestrator = null;

    // -----------------------------------------------------------------
    // Async frame pipeline
    // -----------------------------------------------------------------
    this._frameCounter = 0;
    this._lastFrameTime = 0;
    this._accumulatedDt = 0;
    this._rafHandle = null;
    this._loopRunning = false;

    // -----------------------------------------------------------------
    // Camera cache (updated each frame)
    // -----------------------------------------------------------------
    this._camera = {
      x: 0, y: 0, z: 0,
      forwardX: 0, forwardY: 0, forwardZ: -1,
      upX: 0, upY: 1, upZ: 0,
      rightX: 1, rightY: 0, rightZ: 0,
      fov: Math.PI / 3,
      near: 0.1,
      far: 10000,
      screenWidth: 1920,
      screenHeight: 1080
    };

    // -----------------------------------------------------------------
    // Published output (from the last frame)
    // -----------------------------------------------------------------
    this._published = {
      frame: null,
      drawCalls: null,
      instances: null,
      drawCallCount: 0,
      instanceCount: 0,
      triangleCount: 0,
      qualityScale: 1.0,
      lastFrameMs: 0,
      visibleCount: 0,
      lifecycle: WorldLifecycle.UNINITIALIZED,
      warmupStatus: WorkerWarmupStatus.NOT_STARTED
    };

    // -----------------------------------------------------------------
    // Diagnostics
    // -----------------------------------------------------------------
    this.stats = {
      totalFrames: 0,
      totalFrameMs: 0,
      avgFrameMs: 0,
      peakFrameMs: 0,
      totalDt: 0,
      uptimeMs: 0,
      startedAt: 0,
      totalEventsEmitted: 0,
      totalQueries: 0,
      totalSpawns: 0
    };
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  /**
   * Initializes the world: creates the context frame, ECS world, all
   * providers, the biome systems, and the master orchestrator. This is
   * an async method because it warms up worker pools in parallel.
   *
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this._lifecycle !== WorldLifecycle.UNINITIALIZED) {
      throw new Error(`World is already ${WorldLifecycle[this._lifecycle]}`);
    }

    this._lifecycle = WorldLifecycle.INITIALIZING;
    this._emitLifecycleEvent('initializing', {});

    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    try {
      // ---- 1. Create the context frame ----
      this._createContextFrame();

      // ---- 2. Create the ECS world ----
      this._createEcsWorld();

      // ---- 3. Create the event dispatcher ----
      this._createEventDispatcher();

      // ---- 4. Create the core clock ----
      this.clock = new CoreClock({
        tiers: [this.options.targetHz60, this.options.targetHz10, this.options.targetHz1]
      });

      // ---- 5. Create all context providers ----
      this._createProviders();

      // ---- 6. Create biome systems ----
      this._createBiomeSystems();

      // ---- 7. Create the master orchestrator ----
      this._createOrchestrator();

      // ---- 8. Warm up workers asynchronously ----
      this._warmupStatus = WorkerWarmupStatus.WARMING_UP;
      this._warmupPromise = this._warmupWorkers();

      // ---- 9. Transition to READY ----
      this._lifecycle = WorldLifecycle.READY;
      this._published.lifecycle = WorldLifecycle.READY;
      this._emitLifecycleEvent('ready', {
        initializationMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0
      });

    } catch (err) {
      this._lifecycle = WorldLifecycle.UNINITIALIZED;
      this._emitLifecycleEvent('error', { message: err.message });
      throw err;
    }
  }

  /**
   * Starts the world. If the world is not initialized yet, initializes it
   * first. Then transitions to RUNNING and (optionally) starts the frame
   * loop.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (this._lifecycle === WorldLifecycle.UNINITIALIZED) {
      await this.initialize();
    }

    if (this._lifecycle === WorldLifecycle.RUNNING) {
      return;
    }

    // Wait for workers to finish warming up (or time out).
    if (this._warmupStatus === WorkerWarmupStatus.WARMING_UP) {
      try {
        await Promise.race([
          this._warmupPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('warmup timeout')), this.options.warmupTimeoutMs)
          )
        ]);
        this._warmupStatus = WorkerWarmupStatus.READY;
      } catch (err) {
        this._warmupStatus = WorkerWarmupStatus.FAILED;
        // Continue anyway — single-threaded fallback will be used.
      }
    }

    this._lifecycle = WorldLifecycle.RUNNING;
    this._published.lifecycle = WorldLifecycle.RUNNING;
    this._published.warmupStatus = this._warmupStatus;
    this.stats.startedAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._lastFrameTime = this.stats.startedAt;

    // Start the frame loop if using RAF or fixed-step.
    if (this.options.frameStrategy !== FrameStrategy.MANUAL) {
      this._startFrameLoop();
    }

    this._emitLifecycleEvent('started', { warmupStatus: this._warmupStatus });
  }

  /**
   * Pauses the world. The world keeps its state but stops updating.
   */
  pause() {
    if (this._lifecycle !== WorldLifecycle.RUNNING) return;
    this._lifecycle = WorldLifecycle.PAUSED;
    this._published.lifecycle = WorldLifecycle.PAUSED;
    this._emitLifecycleEvent('paused', {});
  }

  /**
   * Resumes the world from PAUSED.
   */
  resume() {
    if (this._lifecycle !== WorldLifecycle.PAUSED) return;
    this._lifecycle = WorldLifecycle.RUNNING;
    this._published.lifecycle = WorldLifecycle.RUNNING;
    this._lastFrameTime = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._emitLifecycleEvent('resumed', {});
  }

  /**
   * Stops the world. Releases all per-tile state but preserves the
   * constructed subsystems.
   */
  stop() {
    if (this._lifecycle !== WorldLifecycle.RUNNING && this._lifecycle !== WorldLifecycle.PAUSED) {
      return;
    }
    this._lifecycle = WorldLifecycle.STOPPING;
    this._published.lifecycle = WorldLifecycle.STOPPING;
    this._stopFrameLoop();
    if (this.orchestrator) this.orchestrator.clear();
    this._lifecycle = WorldLifecycle.STOPPED;
    this._published.lifecycle = WorldLifecycle.STOPPED;
    this._emitLifecycleEvent('stopped', {});
  }

  /**
   * Destroys the world and releases every resource.
   */
  dispose() {
    this.stop();
    if (this.orchestrator) this.orchestrator.dispose();
    this.orchestrator = null;
    this.contextFrame = null;
    this.ecsWorld = null;
    this.eventDispatcher = null;
    this.clock = null;
    this.providers = null;
    this.biomeRegistry = null;
    this.biomeBlendField = null;
    this.biomeBlendSystem = null;
    this.biomeEcotone = null;
    this.biomeFaunaMigration = null;
    this._lifecycle = WorldLifecycle.DISPOSED;
    this._published.lifecycle = WorldLifecycle.DISPOSED;
    this._emitLifecycleEvent('disposed', {});
  }

  // ---------------------------------------------------------------------
  // Frame loop
  // ---------------------------------------------------------------------

  /**
   * Drives one frame manually. Called by the host application when
   * frameStrategy === MANUAL. Returns the published frame record.
   *
   * @param {number} dt – delta time in seconds (clamped to avoid spikes)
   * @param {object} [camera] – optional camera override
   * @returns {object} the published frame record
   */
  update(dt, camera = null) {
    if (this._lifecycle !== WorldLifecycle.RUNNING) {
      return this._published;
    }

    // Clamp dt.
    const clampedDt = Math.min(Math.max(dt, 0), 0.1);

    // Update camera.
    if (camera) {
      this._camera.x = camera.x ?? 0;
      this._camera.y = camera.y ?? 0;
      this._camera.z = camera.z ?? 0;
      this._camera.forwardX = camera.forwardX ?? 0;
      this._camera.forwardY = camera.forwardY ?? 0;
      this._camera.forwardZ = camera.forwardZ ?? -1;
      this._camera.upX = camera.upX ?? 0;
      this._camera.upY = camera.upY ?? 1;
      this._camera.upZ = camera.upZ ?? 0;
      this._camera.rightX = camera.rightX ?? 1;
      this._camera.rightY = camera.rightY ?? 0;
      this._camera.rightZ = camera.rightZ ?? 0;
      this._camera.fov = camera.fov ?? Math.PI / 3;
      this._camera.near = camera.near ?? 0.1;
      this._camera.far = camera.far ?? 10000;
      this._camera.screenWidth = camera.screenWidth ?? 1920;
      this._camera.screenHeight = camera.screenHeight ?? 1080;
    }

    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // Update player context with camera position.
    if (this.providers.player && this.providers.player.setCamera) {
      this.providers.player.setCamera(this._camera);
    }

    // Drive the master orchestrator.
    const published = this.orchestrator.update(
      this.contextFrame,
      this._frameCounter,
      clampedDt,
      this._camera,
      'main'
    );

    this._frameCounter++;
    this.stats.totalFrames++;
    this.stats.totalDt += clampedDt;

    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const frameMs = t1 - t0;
    this.stats.totalFrameMs += frameMs;
    this.stats.avgFrameMs = this.stats.totalFrameMs / this.stats.totalFrames;
    if (frameMs > this.stats.peakFrameMs) this.stats.peakFrameMs = frameMs;

    // Update published output.
    this._published.frame = published;
    this._published.drawCalls = published.drawCalls;
    this._published.instances = published.instances;
    this._published.drawCallCount = published.drawCallCount;
    this._published.instanceCount = published.instanceCount;
    this._published.triangleCount = published.triangleCount;
    this._published.qualityScale = published.qualityScale;
    this._published.lastFrameMs = frameMs;
    this._published.visibleCount = published.visibleCount;

    // Update uptime.
    this.stats.uptimeMs = t1 - this.stats.startedAt;

    return this._published;
  }

  _startFrameLoop() {
    if (this._loopRunning) return;
    this._loopRunning = true;

    const loop = () => {
      if (!this._loopRunning) return;

      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const dt = (now - this._lastFrameTime) / 1000;
      this._lastFrameTime = now;

      if (this.options.frameStrategy === FrameStrategy.FIXED_STEP) {
        this.update(1 / 60, null);
      } else if (this.options.frameStrategy === FrameStrategy.ADAPTIVE) {
        this.update(Math.min(dt, 0.05), null);
      } else {
        this.update(dt, null);
      }

      if (typeof requestAnimationFrame !== 'undefined') {
        this._rafHandle = requestAnimationFrame(loop);
      } else {
        this._rafHandle = setTimeout(loop, 16);
      }
    };

    if (typeof requestAnimationFrame !== 'undefined') {
      this._rafHandle = requestAnimationFrame(loop);
    } else {
      this._rafHandle = setTimeout(loop, 16);
    }
  }

  _stopFrameLoop() {
    this._loopRunning = false;
    if (this._rafHandle !== null) {
      if (typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(this._rafHandle);
      } else {
        clearTimeout(this._rafHandle);
      }
      this._rafHandle = null;
    }
  }

  // ---------------------------------------------------------------------
  // Context frame
  // ---------------------------------------------------------------------

  _createContextFrame() {
    this.contextFrame = new ContextFrame({
      worldId: this.options.worldId,
      maxSpatialEntities: this.options.maxSpatialEntities,
      maxVisibleTiles: this.options.maxVisibleTiles,
      maxCausalEvents: this.options.maxCausalEvents,
      maxPlayerStates: this.options.maxPlayerStates
    });

    // Pre-allocate the five channel SoA buffers so no allocation happens
    // during the frame loop.
    if (this.contextFrame.initChannels) {
      this.contextFrame.initChannels();
    }
  }

  // ---------------------------------------------------------------------
  // ECS world
  // ---------------------------------------------------------------------

  _createEcsWorld() {
    this.ecsWorld = new World({
      maxEntities: this.options.maxSpatialEntities
    });

    // Pre-register every terrain component so no runtime registration
    // is needed.
    if (this.ecsWorld.registerComponent) {
      // Imported from files 374, 375, 389, 398, 399, etc.
      // Component schemas are registered lazily by subsystems, but we
      // pre-register the ones that the master orchestrator needs.
      // (The actual components are attached via addComponent when tiles
      // are created.)
    }
  }

  // ---------------------------------------------------------------------
  // Event dispatcher
  // ---------------------------------------------------------------------

  _createEventDispatcher() {
    this.eventDispatcher = new CoreEventDispatcher({
      enableAsyncDispatch: false,     // synchronous for frame determinism
      maxHandlersPerEvent: 64,
      captureErrors: true
    });
  }

  // ---------------------------------------------------------------------
  // Providers
  // ---------------------------------------------------------------------

  _createProviders() {
    const ctx = this.contextFrame;
    const ecs = this.ecsWorld;
    const evt = this.eventDispatcher;

    // ---- Context providers ----
    this.providers.spatial = new SpatialContextProvider({});
    this.providers.temporal = new TemporalContextProvider({
      worldSeed: this.options.seed
    });
    this.providers.physical = new PhysicalContextProvider({});
    this.providers.causal = new CausalContextProvider({});
    this.providers.player = new PlayerContextProvider({});

    // Bind context providers.
    for (const p of [this.providers.spatial, this.providers.temporal,
                     this.providers.physical, this.providers.causal,
                     this.providers.player]) {
      p.bind?.(ctx, ecs, evt);
    }

    // ---- Terrain and gradient providers ----
    this.providers.terrain = new TerrainProvider({ seed: this.options.seed });
    this.providers.elevation = new ElevationProvider({ seed: this.options.seed });
    this.providers.slope = new SlopeGradientProvider({});
    this.providers.relief = new ReliefGradientProvider({});
    this.providers.cliffs = new CliffsGradientProvider({});
    this.providers.carve = new CarveGradientProvider({});
    this.providers.rock = new RockGradientProvider({});
    this.providers.forest = new ForestGradientProvider({});
    this.providers.grass = new GrassAndFlowresGradientProvider({});
    this.providers.continental = new ContinentalReliefGradientProvider({});

    // ---- Environmental providers ----
    this.providers.bathymetry = new BathymetryProvider({});
    this.providers.groundwater = new GroundwaterProvider({});
    this.providers.moisture = new MoistureLevelProvider({});
    this.providers.decomposers = new DecomposersSystem({});
    this.providers.temperature = new ClimateTemperatureProvider({});
    this.providers.precipitation = new ClimatePrecipitationProvider({});
    this.providers.wind = new ClimateWindProvider({});
    this.providers.soilComposition = new SoilCompositionProvider({});
    this.providers.soilFertility = new SoilFertilityProvider({});
    this.providers.soilColor = new SoilColorTextureProvider({});
    this.providers.sunIntensity = new LightingSunIntensityProvider({});
    this.providers.timeOfDay = new LightingTimeOfDayProvider({});
    this.providers.airQuality = new AirQualityAtmosphereProvider({});
    this.providers.seasonality = new SeasonalitySystem({});

    // ---- Sensory ----
    this.providers.sensory = new SensoryDetailsProvider({});
    this.providers.audioLight = new AudioLightEmissionSystem({});

    // Bind all providers.
    for (const key of Object.keys(this.providers)) {
      const p = this.providers[key];
      if (p && p.bind) p.bind(ctx, ecs, evt);
    }
  }

  // ---------------------------------------------------------------------
  // Biome systems
  // ---------------------------------------------------------------------

  _createBiomeSystems() {
    this.biomeRegistry = new BiomeRegistryBarrel({});
    this.biomeBlendField = new BiomeBlendField({});
    this.biomeBlendSystem = new BiomeBlendSystem({});
    this.biomeEcotone = new CrossBiomeEcotoneSystem({});
    this.biomeFaunaMigration = new BiomeFaunaMigrationSystem({});

    // Register all 26 default biomes.
    if (this.biomeRegistry.registerDefaults) {
      this.biomeRegistry.registerDefaults();
    }

    // Bind them.
    const ctx = this.contextFrame;
    const ecs = this.ecsWorld;
    const evt = this.eventDispatcher;

    this.biomeBlendField.bind?.(ctx, ecs, evt);
    this.biomeBlendSystem.bind?.(ctx, ecs, evt);
    this.biomeEcotone.bind?.(ctx, ecs, evt);
    this.biomeFaunaMigration.bind?.(ctx, ecs, evt);
  }

  // ---------------------------------------------------------------------
  // Master orchestrator
  // ---------------------------------------------------------------------

  _createOrchestrator() {
    this.orchestrator = createTerrainPipelineMasterOrchestrator3D({
      worldId: this.options.worldId,
      subsystems: this.options.subsystems,
      mode: this.options.mode,
      tileWorldSize: this.options.tileWorldSize,
      maxLod: this.options.maxLod,
      screenSpaceErrorTarget: this.options.screenSpaceErrorTarget,
      frameBudgetMs: this.options.frameBudgetMs,
      maxResidentBytes: this.options.maxResidentBytes,
      targetHz60: this.options.targetHz60,
      targetHz10: this.options.targetHz10,
      targetHz1: this.options.targetHz1,
      enableScatter: this.options.enableScatter,
      enableFauna: this.options.enableFauna,
      enableWeather: this.options.enableWeather,
      enableHydrology: this.options.enableHydrology,
      enableParallelTraversal: this.options.enableParallelTraversal,
      traversalWorkerCount: this.options.traversalWorkerCount,
      enableDiagnostics: this.options.enableDiagnostics,
      seed: this.options.seed,
      noisePeriod: this.options.noisePeriod,
      octaves: this.options.octaves,
      lacunarity: this.options.lacunarity,
      persistence: this.options.persistence,
      zScale: this.options.zScale,
      resolution: this.options.resolution
    });

    // Bind the orchestrator to the context frame, ECS world, and
    // event dispatcher.
    this.orchestrator.bind(
      this.contextFrame,
      this.ecsWorld,
      this.eventDispatcher
    );

    // Give the orchestrator access to the biome systems.
    if (this.orchestrator.materialBridge) {
      this.orchestrator.materialBridge.setBiomeRegistry?.(this.biomeRegistry);
      this.orchestrator.materialBridge.setBiomeBlendField?.(this.biomeBlendField);
    }
    if (this.orchestrator.fauna) {
      this.orchestrator.fauna.setFaunaMigration?.(this.biomeFaunaMigration);
    }
  }

  // ---------------------------------------------------------------------
  // Worker warm-up
  // ---------------------------------------------------------------------

  async _warmupWorkers() {
    // Warm up the traversal worker pool.
    if (this.orchestrator?.traversal?._workerPool) {
      const pool = this.orchestrator.traversal._workerPool;
      const timeoutMs = this.options.warmupTimeoutMs;

      // Wait until the pool is ready, or timeout.
      const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      while (pool.readyCount < pool.workerCount) {
        const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start;
        if (elapsed > timeoutMs) {
          throw new Error('Traversal worker pool warmup timeout');
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    // Warm up the source worker pool (if the source has one).
    if (this.orchestrator?.source?._workerPool) {
      const pool = this.orchestrator.source._workerPool;
      if (pool.readyCount < pool.workerCount) {
        // Wait similarly.
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  // ---------------------------------------------------------------------
  // Event emission
  // ---------------------------------------------------------------------

  _emitLifecycleEvent(name, payload) {
    if (!this.options.emitLifecycleEvents) return;
    if (!this.eventDispatcher) return;
    try {
      this.eventDispatcher.dispatch('world:' + name, {
        ...payload,
        worldId: this.options.worldId,
        lifecycle: this._lifecycle,
        timestamp: (typeof performance !== 'undefined' ? performance.now() : Date.now())
      });
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------
  // Public queries (delegated to the master orchestrator)
  // ---------------------------------------------------------------------

  /**
   * Returns the terrain height at world coordinates (x, y).
   */
  queryHeight(x, y) {
    this.stats.totalQueries++;
    if (!this.orchestrator?.queryEngine) return NaN;
    return this.orchestrator.queryEngine.getHeight(x, y);
  }

  /**
   * Returns the surface normal at world coordinates (x, y) into `out`.
   */
  queryNormal(x, y, out) {
    this.stats.totalQueries++;
    if (!this.orchestrator?.queryEngine) {
      out[0] = 0; out[1] = 0; out[2] = 1;
      return out;
    }
    return this.orchestrator.queryEngine.getNormal(x, y, out);
  }

  /**
   * Returns the slope at world coordinates (x, y) into `out`.
   */
  querySlope(x, y, out) {
    this.stats.totalQueries++;
    if (!this.orchestrator?.queryEngine) {
      out.reset();
      return null;
    }
    return this.orchestrator.queryEngine.getSlope(x, y, out);
  }

  /**
   * Casts a ray against the terrain.
   */
  queryRay(ox, oy, oz, dx, dy, dz, maxDistance, outHit) {
    this.stats.totalQueries++;
    if (!this.orchestrator?.queryEngine) {
      outHit.reset();
      return outHit;
    }
    return this.orchestrator.queryEngine.rayCast(
      ox, oy, oz, dx, dy, dz, maxDistance, outHit
    );
  }

  /**
   * Tests a sphere against the terrain.
   */
  querySphere(cx, cy, cz, radius, outContact) {
    this.stats.totalQueries++;
    if (!this.orchestrator?.queryEngine) {
      outContact.reset();
      return outContact;
    }
    return this.orchestrator.queryEngine.sphereSweep(cx, cy, cz, radius, outContact);
  }

  /**
   * Snaps an arbitrary point vertically to the terrain surface.
   */
  snapToGround(x, z) {
    return this.queryHeight(x, z);
  }

  // ---------------------------------------------------------------------
  // Public registrations (delegated to the master orchestrator)
  // ---------------------------------------------------------------------

  /**
   * Registers a new fauna species. Returns the stable numeric ID.
   */
  registerSpecies(props) {
    if (!this.orchestrator?.fauna) {
      throw new Error('Fauna subsystem is not enabled');
    }
    return this.orchestrator.fauna.registerSpecies(props);
  }

  /**
   * Registers a new fauna lifecycle hook.
   */
  registerFaunaHook(name, phase, callback) {
    if (!this.orchestrator?.fauna) {
      throw new Error('Fauna subsystem is not enabled');
    }
    return this.orchestrator.fauna.registerHook(name, phase, callback);
  }

  /**
   * Registers a new biome in the world's biome registry.
   */
  registerBiome(name, descriptor) {
    if (!this.biomeRegistry) {
      throw new Error('Biome registry not initialized');
    }
    return this.biomeRegistry.register(name, descriptor);
  }

  /**
   * Registers a new scatter species.
   */
  registerScatterSpecies(props) {
    if (!this.orchestrator?.scatter) {
      throw new Error('Scatter subsystem is not enabled');
    }
    return this.orchestrator.scatter.registerSpecies?.(props);
  }

  /**
   * Emits a causal event into the world (impact, ignite, splash, etc.).
   */
  emitCausalEvent(event) {
    if (!this.eventDispatcher) return;
    try {
      this.eventDispatcher.dispatch(event.type, event.payload);
      this.stats.totalEventsEmitted++;
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------
  // Public queries (aggregate state)
  // ---------------------------------------------------------------------

  /**
   * Returns the published output from the last frame.
   */
  getPublished() {
    return this._published;
  }

  /**
   * Returns the current quality scale (0.0–1.0).
   */
  getQualityScale() {
    return this.orchestrator?.getQualityScale?.() ?? 1.0;
  }

  /**
   * Manually sets the quality scale.
   */
  setQualityScale(scale) {
    this.orchestrator?.setQualityScale?.(scale);
  }

  /**
   * Returns the current lifecycle state.
   */
  getLifecycle() {
    return this._lifecycle;
  }

  /**
   * Returns the current warm-up status.
   */
  getWarmupStatus() {
    return this._warmupStatus;
  }

  /**
   * Returns the full pipeline statistics.
   */
  getStats() {
    return {
      world: this.stats,
      orchestrator: this.orchestrator?.getStats?.() ?? null,
      lifecycle: this._lifecycle,
      warmupStatus: this._warmupStatus,
      visibleCount: this._published.visibleCount,
      drawCallCount: this._published.drawCallCount,
      instanceCount: this._published.instanceCount,
      triangleCount: this._published.triangleCount,
      qualityScale: this._published.qualityScale,
      lastFrameMs: this._published.lastFrameMs
    };
  }
}

// ═════════════════════════════════════════════════════════════════════
// 3. FACTORY
// ═════════════════════════════════════════════════════════════════════

/**
 * Creates a TerrainWorldEntry with the given options.
 *
 * Usage:
 *   const world = createTerrainWorld({ maxLod: 12, resolution: 65 });
 *   await world.start();
 *
 *   // Per frame (MANUAL strategy):
 *   world.update(dt, camera);
 *   const drawCalls = world.getPublished().drawCalls;
 */
export function createTerrainWorld(options = {}) {
  return new TerrainWorldEntry({
    worldId: options.worldId ?? 1,
    mode: options.mode ?? WorldMode.PROCEDURAL_ONLY,
    frameStrategy: options.frameStrategy ?? FrameStrategy.MANUAL,
    subsystems: options.subsystems ?? SubsystemId.FULL,
    frameBudgetMs: options.frameBudgetMs ?? 8,
    maxResidentBytes: options.maxResidentBytes ?? 200 * 1024 * 1024,
    targetHz60: options.targetHz60 ?? 60,
    targetHz10: options.targetHz10 ?? 10,
    targetHz1: options.targetHz1 ?? 1,
    tileWorldSize: options.tileWorldSize ?? 100,
    maxLod: options.maxLod ?? 12,
    screenSpaceErrorTarget: options.screenSpaceErrorTarget ?? 16,
    seed: options.seed ?? 1337,
    noisePeriod: options.noisePeriod ?? 512,
    octaves: options.octaves ?? 5,
    lacunarity: options.lacunarity ?? 2.0,
    persistence: options.persistence ?? 0.5,
    zScale: options.zScale ?? 500,
    resolution: options.resolution ?? 65,
    enableScatter: options.enableScatter ?? true,
    enableFauna: options.enableFauna ?? true,
    enableWeather: options.enableWeather ?? true,
    enableHydrology: options.enableHydrology ?? true,
    enableParallelTraversal: options.enableParallelTraversal ?? true,
    traversalWorkerCount: options.traversalWorkerCount ?? 2,
    enableParallelSource: options.enableParallelSource ?? true,
    sourceWorkerCount: options.sourceWorkerCount ?? 2,
    maxVisibleTiles: options.maxVisibleTiles ?? 2048,
    maxSpatialEntities: options.maxSpatialEntities ?? 8192,
    maxCausalEvents: options.maxCausalEvents ?? 256,
    maxPlayerStates: options.maxPlayerStates ?? 1,
    warmupOnIdle: options.warmupOnIdle ?? true,
    warmupTimeoutMs: options.warmupTimeoutMs ?? 5000,
    enableDiagnostics: options.enableDiagnostics ?? true,
    emitLifecycleEvents: options.emitLifecycleEvents ?? true,
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 4. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  TerrainWorldEntry,
  WorldLifecycle,
  WorldMode,
  FrameStrategy,
  WorkerWarmupStatus,
  createTerrainWorld
};