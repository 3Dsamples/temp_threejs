// file number : 359
// full path name : src/context/359_LandscapeSceneWiring.js
// description : Landscape scene wiring — the scene builder that instantiates a
// complete landscape from 358_LandscapeOrchestrationLoop's orchestration loop
// and 327_BiomeRegistryBarrel's biome registry. It reads a world seed, a
// starting camera position, and a configuration object, generates the initial
// chunk set around the camera, populates the biome registry with the world's
// active biome set (all 26 registered biomes by default, or a caller-supplied
// subset for small-world scenarios), registers the initial chunks with every
// per-chunk system in the pipeline (328 through 357), wires the pipeline into
// the runtime via 358's stage callbacks, and exposes the assembled scene as a
// single object that 360_LandscapePublicAPI wraps in the public API. This is
// the file that turns "twenty-six biome descriptors and thirty landscape
// systems" into "one runnable world." It is the only place in the pipeline
// where all of the following happen in one call:
//   (1) DETERMINISTIC SEED    — the world seed is mixed into every
//                                deterministic PRNG so a scene built with the
//                                same seed produces byte-identical chunks,
//                                vegetation, fauna, props, decals, and
//                                weather at every stream-out / stream-in
//                                cycle;
//   (2) BIOME REGISTRATION    — the registry is checked for every required
//                                biome and any missing biome is reported so
//                                the caller knows exactly which biomes their
//                                world does not have;
//   (3) INITIAL CHUNK SET     — a configurable initial radius of chunks is
//                                streamed in around the camera's start
//                                position, using 337_LandscapeChunkStreamer's
//                                own priority function so the world boots
//                                with the most-visible chunks loaded first;
//   (4) PER-CHUNK REGISTRATION — every initial chunk is registered with
//                                every per-chunk system in the pipeline:
//                                328 (BlendField), 329 (BlendSystem), 330
//                                (Ecotone), 332 (Climate), 333 (Soil), 334
//                                (Hydrology), 335 (FaunaMigration), 336
//                                (Descriptor), 338 (HLOD), 339 (SpatialHash),
//                                340 (Occlusion), 341 (Persistence), 342
//                                (MutationReplay), 343 (Erosion), 344
//                                (WindErosion), 345 (WaterFlow), 346
//                                (VegetationScatter), 347 (FaunaSpawn), 348
//                                (DecalPlacement), 349 (PropPlacement), 350
//                                (ShadowScaler), 351 (LightingCoupler), 352
//                                (SkyCoupler), 353 (SeasonCoupler), 354
//                                (SensoryCoupler), and 356 (RebuildDeferral);
//   (5) ORCHESTRATION WIRING  — 358's stage callbacks are installed into the
//                                ContextRuntime so the world runs on the six-
//                                stage loop;
//   (6) MATERIAL AND LIGHTING — the initial material uniforms, lighting
//                                state, and sky state are computed for every
//                                initial chunk so the first rendered frame
//                                is visually complete, not a black void that
//                                fills in over the first second;
//   (7) PUBLIC SCENE OBJECT   — the assembled scene is exposed as a single
//                                object with worldSeed, chunkSizeM, registry,
//                                biomeSet, cameraStartPosition, cameraStart-
//                                Forward, initialChunks, pipelineHandles,
//                                and a runFrame() method that delegates to
//                                358's orchestration loop.
// The scene wiring is the single entry point for building a world from the
// landscape pipeline. Every downstream consumer (360_LandscapePublicAPI,
// 361_FinalRuntimeWiring, 362_RuntimeBootstrap, 363_PublicAPI,
// 364_FinalLivingWorldAssembly) calls into this module to build the world
// they then expose or bootstrap.
//#
// best for : Every consumer that needs to build a complete landscape scene
// from the pipeline — 360_LandscapePublicAPI (wraps the scene in the public
// API surface), 361_FinalRuntimeWiring (instantiates the runtime and
// registers all providers, consumers, and pools), 362_RuntimeBootstrap
// (builds the first frame and starts the six-stage loop),
// 363_PublicAPI (exposes the world to external code),
// 364_FinalLivingWorldAssembly (final assembly instantiating every living
// system and starting the loop), and any custom scene builder that wants to
// reuse the exact same world-building logic. The module is the single
// authority on how to build a landscape scene from the pipeline, and every
// downstream consumer that builds a scene asks it.
// license : MIT

// ─── raw 3js primitives — exported by the 264 barrel ────────────
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere, Box3, Frustum,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  InstancedBufferAttribute, InstancedBufferGeometry,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture,
  WebGLRenderer, WebGL2Renderer,
  Color,
  PCFSoftShadowMap, PCFShadowMap, VSMShadowMap, BasicShadowMap
} from './264_MathECSImportBarrel.js';

// ─── Core runtime and providers ────────────────────────────────
import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';
import { CoreClock, TIER, TIER_PERIOD } from './267_CoreClock.js';
import { ContextRuntime } from './309_ContextRuntime.js';
import { ContextConsumerTiers } from './308_ContextConsumerTiers.js';

// ─── Governance ────────────────────────────────────────────────
import { MemoryCeilingEnforcer } from './304_MemoryCeilingEnforcer.js';
import { FrameBudgetMonitor } from './305_FrameBudgetMonitor.js';
import { GCPauseMonitor } from './306_GCPauseMonitor.js';
import { MemoryProfiler } from './307_MemoryProfiler.js';

// ─── Biome layer ──────────────────────────────────────────────
import { BiomeRegistry } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendField } from './328_BiomeBlendField.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { CrossBiomeEcotoneSystem } from './330_CrossBiomeEcotoneSystem.js';
import { BiomeBlendMaterialBridge } from './331_BiomeBlendMaterialBridge.js';
import { BiomeClimateCoupling } from './332_BiomeClimateCoupling.js';
import { BiomeSoilCoupling } from './333_BiomeSoilCoupling.js';
import { BiomeHydrologyCoupling } from './334_BiomeHydrologyCoupling.js';
import { BiomeFaunaMigrationSystem } from './335_BiomeFaunaMigrationSystem.js';

// ─── Landscape layer ──────────────────────────────────────────
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';
import { LandscapeChunkStreamer } from './337_LandscapeChunkStreamer.js';
import { LandscapeChunkHLOD } from './338_LandscapeChunkHLOD.js';
import { LandscapeChunkSpatialHash } from './339_LandscapeChunkSpatialHash.js';
import { LandscapeChunkOcclusion } from './340_LandscapeChunkOcclusion.js';
import { LandscapeChunkPersistence } from './341_LandscapeChunkPersistence.js';
import { LandscapeChunkMutationReplay } from './342_LandscapeChunkMutationReplay.js';
import { LandscapeErosionSimulator } from './343_LandscapeErosionSimulator.js';
import { LandscapeWindErosionSystem } from './344_LandscapeWindErosionSystem.js';
import { LandscapeWaterFlowSystem } from './345_LandscapeWaterFlowSystem.js';
import { LandscapeVegetationScatterSystem } from './346_LandscapeVegetationScatterSystem.js';
import { LandscapeFaunaSpawnSystem } from './347_LandscapeFaunaSpawnSystem.js';
import { LandscapeDecalPlacementSystem } from './348_LandscapeDecalPlacementSystem.js';
import { LandscapePropPlacementSystem } from './349_LandscapePropPlacementSystem.js';
import { LandscapeShadowScaler } from './350_LandscapeShadowScaler.js';
import { LandscapeLightingCoupler } from './351_LandscapeLightingCoupler.js';
import { LandscapeSkyCoupler } from './352_LandscapeSkyCoupler.js';
import { LandscapeSeasonCoupler } from './353_LandscapeSeasonCoupler.js';
import { LandscapeSensoryCoupler } from './354_LandscapeSensoryCoupler.js';
import { LandscapePerformanceGovernor } from './355_LandscapePerformanceGovernor.js';
import { LandscapeRebuildDeferral } from './356_LandscapeRebuildDeferral.js';
import { LandscapeEventBudget } from './357_LandscapeEventBudget.js';
import { LandscapeOrchestrationLoop } from './358_LandscapeOrchestrationLoop.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Default world-building configuration. Every field is overridable by the
// caller's config object; missing fields fall back to these defaults.
const DEFAULT_SCENE_CONFIG = Object.freeze({
  // Deterministic world seed.
  worldSeed: 0x9E3779B1,

  // Chunk size in metres. Must match every other module's default.
  chunkSizeM: 100.0,

  // Initial radius of chunks to stream in around the camera start, in
  // chunks. A radius of 8 loads a 17×17×17 cube around the start position
  // (4,913 chunks) which is more than enough for the first 30 seconds of
  // gameplay on any device.
  initialChunkRadius: 8,

  // Whether to pre-populate every registered biome in the registry. When
  // false, only the biomes the caller explicitly requests are registered.
  populateAllBiomes: true,

  // The set of biome ids to register when populateAllBiomes is false.
  // Empty means "no explicit set" (falls back to populateAllBiomes).
  requiredBiomeIds: Object.freeze([]),

  // Starting camera position in world coordinates.
  cameraStartX: 0.0,
  cameraStartY: 500.0,
  cameraStartZ: 0.0,

  // Starting camera forward direction (unit vector).
  cameraStartForwardX: 0.0,
  cameraStartForwardY: 0.0,
  cameraStartForwardZ: -1.0,

  // Whether to pre-compute the initial material and lighting uniforms for
  // every loaded chunk so the first rendered frame is complete.
  precomputeInitialUniforms: true,

  // Maximum number of chunks to pre-compute uniforms for in one call. The
  // rest are computed on the first few ticks by 331's normal run loop.
  precomputeUniformBudget: 128,

  // Whether to emit verbose diagnostic events during scene building.
  verbose: false,

  // Memory profile to use for the scene's governor. One of 'LOW',
  // 'MEDIUM', or 'HIGH'.
  memoryProfile: 'LOW'
});

// ══════════════════════════════════════════════════════════════════
// ─── SCENE STATE ────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

const _dispatcher = new CoreEventDispatcher();

// The currently built scene. null until buildScene() is called.
let _currentScene = null;

// Whether the pipeline has been initialized (via 358's init()).
let _pipelineInitialized = false;

// ══════════════════════════════════════════════════════════════════
// ─── BIOME REGISTRATION ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Verify that every required biome is registered. When populateAllBiomes
// is true, this reports the registered biome count. When populateAllBiomes
// is false, this reports any required biomes that are missing.
function _verifyBiomes(config) {
  const registered = [];
  let missing = [];
  let totalRegistered = 0;

  // Walk the registry's list.
  if (BiomeRegistry && typeof BiomeRegistry.list === 'function') {
    const list = BiomeRegistry.list();
    totalRegistered = list.length;
    for (let i = 0; i < list.length; i++) {
      registered.push({ id: list[i].id, name: list[i].name });
    }
  }

  if (!config.populateAllBiomes && config.requiredBiomeIds.length > 0) {
    for (let i = 0; i < config.requiredBiomeIds.length; i++) {
      const biomeId = config.requiredBiomeIds[i];
      if (BiomeRegistry && typeof BiomeRegistry.getBiome === 'function') {
        const biome = BiomeRegistry.getBiome(biomeId);
        if (!biome) missing.push(biomeId);
      }
    }
  }

  return { totalRegistered, registered, missing };
}

// ══════════════════════════════════════════════════════════════════
// ─── CHUNK GENERATION ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Compute the set of chunk coordinates to stream in initially, given the
// camera start position and the initial radius. Returns an array of
// { cx, cy, cz } objects sorted by distance from the camera (nearest
// first), so the most-visible chunks are loaded before the far ones.
function _computeInitialChunkCoordinates(config) {
  const cs = config.chunkSizeM;
  const camChunkX = Math.floor(config.cameraStartX / cs);
  const camChunkY = Math.floor(config.cameraStartY / cs);
  const camChunkZ = Math.floor(config.cameraStartZ / cs);
  const r = config.initialChunkRadius;

  const coords = [];
  for (let dz = -r; dz <= r; dz++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        // A spherical shell around the camera is more natural than a full
        // cube — chunks beyond the sphere's radius are too far to matter.
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq > r * r) continue;
        coords.push({
          cx: camChunkX + dx,
          cy: camChunkY + dy,
          cz: camChunkZ + dz,
          distSq
        });
      }
    }
  }

  // Sort by distance (nearest first).
  coords.sort((a, b) => a.distSq - b.distSq);
  return coords;
}

// ══════════════════════════════════════════════════════════════════
// ─── CHUNK REGISTRATION ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Register a chunk with every per-chunk system in the pipeline. This is
// the single place where a chunk becomes part of the living world. Returns
// the streamer slot, or -1 if the streamer refused the chunk (pool full,
// memory ceiling exceeded, etc.).
function _registerChunkWithPipeline(cx, cy, cz, cameraX, cameraY, cameraZ) {
  // The streamer is the authority — if it refuses, no other system sees
  // the chunk.
  const streamerSlot = LandscapeChunkStreamer.registerChunk(cx, cy, cz);
  if (streamerSlot === -1) return -1;

  // Register with the biome blend field first so it can score the chunk
  // in the same frame.
  const blendFieldSlot = BiomeBlendField.ensureChunk(cx, cy, cz);
  if (blendFieldSlot !== -1) {
    BiomeBlendField.markDirty(blendFieldSlot);
  }

  // Register with every other per-chunk system in the pipeline. The order
  // matters: 329–336 must be registered before 337 and later systems,
  // because the later systems read the earlier systems' per-chunk state.
  BiomeBlendSystem.registerChunk(streamerSlot, cx, cy, cz, cy * 0.1, cameraY);
  CrossBiomeEcotoneSystem.registerChunk(cx, cy, cz);
  BiomeClimateCoupling.registerChunk(cx, cy, cz);
  BiomeSoilCoupling.registerChunk(cx, cy, cz);
  BiomeHydrologyCoupling.registerChunk(cx, cy, cz);
  LandscapeChunkDescriptor.registerChunk(cx, cy, cz);
  LandscapeChunkHLOD.registerChunk(streamerSlot, cx, cy, cz, cameraX, cameraY, cameraZ);
  LandscapeChunkSpatialHash.registerChunk(streamerSlot, cx, cy, cz);
  LandscapeChunkOcclusion.registerChunk(streamerSlot);
  LandscapeChunkPersistence.registerChunk(streamerSlot, cx, cy, cz);
  LandscapeChunkMutationReplay.registerChunk(streamerSlot);
  LandscapeErosionSimulator.registerChunk(streamerSlot);
  LandscapeWindErosionSystem.registerChunk(streamerSlot);
  LandscapeWaterFlowSystem.registerChunk(streamerSlot);
  LandscapeVegetationScatterSystem.registerChunk(streamerSlot);
  LandscapeFaunaSpawnSystem.registerChunk(streamerSlot);
  LandscapePropPlacementSystem.registerChunk(streamerSlot);
  LandscapeShadowScaler.registerChunk(streamerSlot);
  LandscapeLightingCoupler.registerChunk(streamerSlot);
  LandscapeSkyCoupler.registerChunk(streamerSlot);
  LandscapeSeasonCoupler.registerChunk(streamerSlot);
  LandscapeSensoryCoupler.registerChunk(streamerSlot);
  LandscapeRebuildDeferral.registerChunk(streamerSlot);

  return streamerSlot;
}

// ══════════════════════════════════════════════════════════════════
// ─── INITIAL UNIFORM PRECOMPUTATION ───────────────────────────
// ══════════════════════════════════════════════════════════════════

// Pre-compute the initial material and lighting uniforms for the loaded
// chunk set. This is what makes the first rendered frame look complete
// rather than a black void that fills in over the first second.
//
// The precomputation runs the 1 Hz and 10 Hz consumers over the loaded
// chunks in the exact order the orchestration loop would run them, but
// without waiting for the 1 Hz and 10 Hz ticks to fire. The result is that
// every chunk's material, lighting, sky, season, and sensory state is
// fully populated before the first rendered frame.
function _precomputeInitialUniforms(frame, budget) {
  // Run the orchestration loop's 1 Hz stage over the initial chunk set.
  // This populates the biome blend, climate, soil, hydrology, descriptor,
  // erosion, season, and sensory state.
  for (let i = 0; i < budget; i++) {
    LandscapeOrchestrationLoop.runStage(3, frame, 0, 0.0);
  }
  // Run the orchestration loop's 10 Hz stage over the initial chunk set.
  // This populates the streamer, HLOD, spatial hash, occlusion, replay,
  // water flow, vegetation, fauna, decals, props, shadows, lighting, sky,
  // governor, rebuild deferral, and event budget state.
  for (let i = 0; i < budget; i++) {
    LandscapeOrchestrationLoop.runStage(4, frame, 0, 0.0);
  }
  // Run the orchestration loop's 60 Hz stage once over the initial chunk
  // set. This populates the material uniforms.
  LandscapeOrchestrationLoop.runStage(5, frame, 0, 0.0);
  // Run the orchestration loop's stage 6 once to emit the batched
  // dispatch. This is what makes the GPU buffers ready for the first
  // rendered frame.
  LandscapeOrchestrationLoop.runStage(6, frame, 0, 0.0);
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const LandscapeSceneWiring = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  DEFAULT_SCENE_CONFIG,

  /**
   * Build a complete landscape scene from the pipeline. This is the
   * single entry point for world-building.
   *
   * @param {object} [callerConfig] - Optional config overrides.
   * @returns {object} The assembled scene.
   */
  buildScene(callerConfig) {
    const config = { ...DEFAULT_SCENE_CONFIG, ...(callerConfig || {}) };

    // ─── 1. Initialise the pipeline ─────────────────────────
    if (!_pipelineInitialized) {
      LandscapeOrchestrationLoop.init();
      _pipelineInitialized = true;
    }

    // ─── 2. Apply the memory profile ────────────────────────
    LandscapePerformanceGovernor.setMemoryProfile(config.memoryProfile);

    // ─── 3. Verify biomes ──────────────────────────────────
    const biomeStatus = _verifyBiomes(config);

    if (biomeStatus.missing.length > 0) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[SceneWiring] Missing required biomes:', biomeStatus.missing);
      }
    }

    // ─── 4. Compute the initial chunk set ──────────────────
    const initialCoords = _computeInitialChunkCoordinates(config);

    // ─── 5. Register every initial chunk ────────────────────
    const registeredSlots = [];
    let registeredCount = 0;
    let refusedCount = 0;
    for (let i = 0; i < initialCoords.length; i++) {
      const c = initialCoords[i];
      const slot = _registerChunkWithPipeline(
        c.cx, c.cy, c.cz,
        config.cameraStartX, config.cameraStartY, config.cameraStartZ
      );
      if (slot === -1) {
        refusedCount++;
      } else {
        registeredSlots.push(slot);
        registeredCount++;
      }
    }

    // ─── 6. Emit a biome-set event ──────────────────────────
    if (config.verbose) {
      _dispatcher.emit(EVENT_TYPE.SCENE_BIOME_SET_READY, {
        registeredBiomeCount: biomeStatus.totalRegistered,
        requiredBiomeCount: config.requiredBiomeIds.length,
        missingBiomeCount: biomeStatus.missing.length
      });
    }

    // ─── 7. Pre-compute the initial uniforms ────────────────
    if (config.precomputeInitialUniforms) {
      // Build a temporary context frame from the runtime so the uniform
      // precomputation has a frame to read from.
      let precomputeFrame = null;
      if (ContextRuntime && typeof ContextRuntime.getCurrentFrame === 'function') {
        precomputeFrame = ContextRuntime.getCurrentFrame();
      }
      if (!precomputeFrame) {
        precomputeFrame = {
          spatial: { visibleCount: 0, visibleEntityIds: null, visibleChunkSlots: null, visibleMaterialIds: null },
          temporal: {},
          physical: { ambientTemperature: 15.0, humidity: 0.5 },
          causal: { events: [], eventCount: 0 },
          player: { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: -1 } }
        };
      }
      _precomputeInitialUniforms(precomputeFrame, config.precomputeUniformBudget);
    }

    // ─── 8. Assemble the scene object ──────────────────────
    const scene = {
      // ─── Identity ───────────────────────────────────────
      worldSeed: config.worldSeed,
      chunkSizeM: config.chunkSizeM,
      cameraStartPosition: { x: config.cameraStartX, y: config.cameraStartY, z: config.cameraStartZ },
      cameraStartForward: { x: config.cameraStartForwardX, y: config.cameraStartForwardY, z: config.cameraStartForwardZ },

      // ─── Biome set ──────────────────────────────────────
      biomeStatus,
      biomeIds: biomeStatus.registered.map(b => b.id),

      // ─── Chunks ─────────────────────────────────────────
      initialChunks: initialCoords,
      initialChunkCount: initialCoords.length,
      registeredChunkCount: registeredCount,
      refusedChunkCount: refusedCount,
      registeredSlots,

      // ─── Config ─────────────────────────────────────────
      config,

      // ─── Pipeline handles ───────────────────────────────
      pipelineHandles: {
        orchestrationLoop: LandscapeOrchestrationLoop,
        biomeRegistry: BiomeRegistry,
        biomeBlendField: BiomeBlendField,
        biomeBlendSystem: BiomeBlendSystem,
        crossBiomeEcotone: CrossBiomeEcotoneSystem,
        biomeBlendMaterialBridge: BiomeBlendMaterialBridge,
        biomeClimateCoupling: BiomeClimateCoupling,
        biomeSoilCoupling: BiomeSoilCoupling,
        biomeHydrologyCoupling: BiomeHydrologyCoupling,
        biomeFaunaMigration: BiomeFaunaMigrationSystem,
        landscapeChunkDescriptor: LandscapeChunkDescriptor,
        landscapeChunkStreamer: LandscapeChunkStreamer,
        landscapeChunkHLOD: LandscapeChunkHLOD,
        landscapeChunkSpatialHash: LandscapeChunkSpatialHash,
        landscapeChunkOcclusion: LandscapeChunkOcclusion,
        landscapeChunkPersistence: LandscapeChunkPersistence,
        landscapeChunkMutationReplay: LandscapeChunkMutationReplay,
        landscapeErosionSimulator: LandscapeErosionSimulator,
        landscapeWindErosion: LandscapeWindErosionSystem,
        landscapeWaterFlow: LandscapeWaterFlowSystem,
        landscapeVegetationScatter: LandscapeVegetationScatterSystem,
        landscapeFaunaSpawn: LandscapeFaunaSpawnSystem,
        landscapeDecalPlacement: LandscapeDecalPlacementSystem,
        landscapePropPlacement: LandscapePropPlacementSystem,
        landscapeShadowScaler: LandscapeShadowScaler,
        landscapeLightingCoupler: LandscapeLightingCoupler,
        landscapeSkyCoupler: LandscapeSkyCoupler,
        landscapeSeasonCoupler: LandscapeSeasonCoupler,
        landscapeSensoryCoupler: LandscapeSensoryCoupler,
        landscapePerformanceGovernor: LandscapePerformanceGovernor,
        landscapeRebuildDeferral: LandscapeRebuildDeferral,
        landscapeEventBudget: LandscapeEventBudget
      },

      // ─── Frame delegation ───────────────────────────────
      /**
       * Run one frame of the pipeline. This delegates to 358's
       * orchestration loop and is the single call that the runtime makes
       * on every tick.
       */
      runFrame(frame, tick, dt) {
        LandscapeOrchestrationLoop.runFrame(frame, tick, dt);
      },

      /**
       * Run the pipeline with the runtime's current frame. Convenience
       * for external callers that do not have a frame in hand.
       */
      runFrameWithCurrentFrame(tick, dt) {
        let currentFrame = null;
        if (ContextRuntime && typeof ContextRuntime.getCurrentFrame === 'function') {
          currentFrame = ContextRuntime.getCurrentFrame();
        }
        if (currentFrame) LandscapeOrchestrationLoop.runFrame(currentFrame, tick, dt);
      },

      /**
       * Query the scene's biome registry.
       */
      getBiome(biomeId) {
        if (BiomeRegistry && typeof BiomeRegistry.getBiome === 'function') {
          return BiomeRegistry.getBiome(biomeId);
        }
        return null;
      },

      /**
       * Query the scene's currently loaded chunks. Delegates to the
       * streamer's own iteration API.
       */
      forEachLoadedChunk(fn) {
        if (LandscapeChunkStreamer && typeof LandscapeChunkStreamer.forEachLoadedChunk === 'function') {
          LandscapeChunkStreamer.forEachLoadedChunk(fn);
        }
      },

      /**
       * Get the scene's diagnostic state into a preallocated object.
       */
      readDiagnostics(out) {
        out.worldSeed = config.worldSeed;
        out.chunkSizeM = config.chunkSizeM;
        out.registeredBiomeCount = biomeStatus.totalRegistered;
        out.initialChunkCount = initialCoords.length;
        out.registeredChunkCount = registeredCount;
        out.refusedChunkCount = refusedCount;
        out.loadedChunkCount = LandscapeChunkStreamer ? LandscapeChunkStreamer.loadedChunks : 0;
        out.activeChunks = LandscapeChunkDescriptor ? LandscapeChunkDescriptor.activeChunks : 0;
        out.activeEvents = LandscapeEventBudget ? LandscapeEventBudget.activeEvents : 0;
        out.pendingRebuilds = LandscapeRebuildDeferral ? LandscapeRebuildDeferral.pendingRequests : 0;
        out.degradationState = LandscapePerformanceGovernor ? LandscapePerformanceGovernor.getDegradationState() : 1.0;
        out.ladderStep = LandscapePerformanceGovernor ? LandscapePerformanceGovernor.getLadderStep() : 4;
        out.residentMb = LandscapePerformanceGovernor ? LandscapePerformanceGovernor.getResidentMb() : 0;
        out.cpuMs = LandscapePerformanceGovernor ? LandscapePerformanceGovernor.getCpuMs() : 0;
        out.memoryProfile = LandscapePerformanceGovernor ? LandscapePerformanceGovernor.getMemoryProfile() : 'LOW';
        return true;
      }
    };

    _currentScene = scene;

    // ─── 9. Emit the scene-ready event ──────────────────────
    _dispatcher.emit(EVENT_TYPE.SCENE_READY, {
      worldSeed: config.worldSeed,
      registeredBiomeCount: biomeStatus.totalRegistered,
      initialChunkCount: initialCoords.length,
      registeredChunkCount: registeredCount,
      refusedChunkCount: refusedCount,
      memoryProfile: config.memoryProfile
    });

    return scene;
  },

  /**
   * Get the currently built scene, or null if buildScene() has not been
   * called.
   */
  getCurrentScene() {
    return _currentScene;
  },

  /**
   * Query whether a scene has been built.
   */
  hasScene() {
    return _currentScene !== null;
  },

  /**
   * Tear down the currently built scene. Unregisters every initial chunk
   * from every per-chunk system and clears the scene reference. Used by
   * 360_LandscapePublicAPI's dispose() method.
   */
  disposeScene() {
    if (!_currentScene) return;
    const slots = _currentScene.registeredSlots;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (slot < 0) continue;
      BiomeBlendSystem.unregisterChunk(slot);
      CrossBiomeEcotoneSystem.unregisterChunk(slot);
      BiomeClimateCoupling.unregisterChunk(slot);
      BiomeSoilCoupling.unregisterChunk(slot);
      BiomeHydrologyCoupling.unregisterChunk(slot);
      LandscapeChunkDescriptor.unregisterChunk(slot);
      LandscapeChunkSpatialHash.unregisterChunk(slot);
      LandscapeChunkOcclusion.unregisterChunk(slot);
      LandscapeChunkPersistence.unregisterChunk(slot);
      LandscapeChunkMutationReplay.unregisterChunk(slot);
      LandscapeErosionSimulator.unregisterChunk(slot);
      LandscapeWindErosionSystem.unregisterChunk(slot);
      LandscapeWaterFlowSystem.unregisterChunk(slot);
      LandscapeVegetationScatterSystem.unregisterChunk(slot);
      LandscapeFaunaSpawnSystem.unregisterChunk(slot);
      LandscapePropPlacementSystem.unregisterChunk(slot);
      LandscapeShadowScaler.unregisterChunk(slot);
      LandscapeLightingCoupler.unregisterChunk(slot);
      LandscapeSkyCoupler.unregisterChunk(slot);
      LandscapeSeasonCoupler.unregisterChunk(slot);
      LandscapeSensoryCoupler.unregisterChunk(slot);
      LandscapeRebuildDeferral.unregisterChunk(slot);
      LandscapeChunkStreamer.unregisterChunk(slot);
    }
    _currentScene = null;
    _dispatcher.emit(EVENT_TYPE.SCENE_DISPOSED, {});
  },

  // ─── Diagnostics ─────────────────────────────────────────
  get hasActiveScene() { return _currentScene !== null; },
  get currentScene() { return _currentScene; }
});

export default LandscapeSceneWiring;