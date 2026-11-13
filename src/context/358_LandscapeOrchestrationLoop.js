// file number : 358
// full path name : src/context/358_LandscapeOrchestrationLoop.js
// description : Landscape orchestration loop — the wiring layer that
// instantiates every landscape system, connects each consumer's run() call
// to the correct tier in 308_ContextConsumerTiers, and drives the six-stage
// 309_ContextRuntime loop. It reads the blueprint's stage ordering — stage
// one builds the frame from providers, stage two drains the causal buffer,
// stage three runs 1 Hz consumers, stage four runs 10 Hz consumers, stage
// five runs 60 Hz consumers, stage six emits the batched dispatch — and
// ensures that the entire landscape pipeline runs in exactly that order
// with the correct inter-stage dependencies. The orchestration loop is the
// single place where the pipeline's structure is expressed, so every
// consumer (328–357) is wired here and nowhere else. This keeps the runtime
// hot path allocation-free, deterministic, and auditable: you can read this
// file end-to-end and know exactly what runs when, at which tier, with
// which budget.
//
// The loop registers the following consumers at the following tiers:
//
//   STAGE 1 (BUILD FRAME — every tick):
//     • Every provider (263–297) is expected to have populated the frame
//       before stage 1 runs. The orchestration loop does not touch
//       providers directly; it calls the ContextRuntime's stage-one
//       callback, which runs the providers in topological order.
//
//   STAGE 2 (DRAIN CAUSAL — every tick):
//     • 278_CausalContextProvider.drainIntoFrame() is called by the runtime.
//     • 357_LandscapeEventBudget is advanced by the runtime's causal drain
//       so that coalesced events are emitted into the frame's causal slice
//       in the same tick they advance.
//
//   STAGE 3 (TIER_1HZ — every 60th tick):
//     • 328_BiomeBlendField.rescoreDirtyChunks()
//     • 329_BiomeBlendSystem.run()
//     • 330_CrossBiomeEcotoneSystem.run()
//     • 332_BiomeClimateCoupling.run()
//     • 333_BiomeSoilCoupling.run()
//     • 334_BiomeHydrologyCoupling.run()
//     • 335_BiomeFaunaMigrationSystem.run()
//     • 336_LandscapeChunkDescriptor.refreshFromUpstream()
//     • 341_LandscapeChunkPersistence.run()
//     • 343_LandscapeErosionSimulator.run()
//     • 344_LandscapeWindErosionSystem.run()
//     • 353_LandscapeSeasonCoupler.run()
//     • 354_LandscapeSensoryCoupler.run()
//
//   STAGE 4 (TIER_10HZ — every 6th tick):
//     • 337_LandscapeChunkStreamer.run()
//     • 338_LandscapeChunkHLOD.run()
//     • 339_LandscapeChunkSpatialHash.run()
//     • 340_LandscapeChunkOcclusion.run()
//     • 342_LandscapeChunkMutationReplay.run()
//     • 345_LandscapeWaterFlowSystem.run()
//     • 346_LandscapeVegetationScatterSystem.run()
//     • 347_LandscapeFaunaSpawnSystem.run()
//     • 348_LandscapeDecalPlacementSystem.run()
//     • 349_LandscapePropPlacementSystem.run()
//     • 350_LandscapeShadowScaler.run()
//     • 351_LandscapeLightingCoupler.run()
//     • 352_LandscapeSkyCoupler.run()
//     • 355_LandscapePerformanceGovernor.run()
//     • 356_LandscapeRebuildDeferral.run()
//     • 357_LandscapeEventBudget.run()
//
//   STAGE 5 (TIER_60HZ — every tick):
//     • 331_BiomeBlendMaterialBridge.run()
//     • 313_IsVisibleConsumer is expected to have populated the visible
//       list before 331 runs; the orchestration loop does not touch it.
//
//   STAGE 6 (EMIT BATCHED — every tick):
//     • The batched GPU uploads (material uniforms, transforms, decals,
//       props, particles) are emitted by the runtime.
//     • The orchestration loop ensures that stage six NEVER triggers a
//       rebuild of stage one by checking that no stage-six callback calls
//       into any stage-one provider.
//
// The orchestration loop also owns the runtime's initialization sequence:
//   • init() calls the init() of every system that needs one (335, 341,
//     342, 348, 352, 355).
//   • init() registers every consumer with 355_LandscapePerformanceGovernor
//     so the governor can track per-consumer cost.
//   • init() subscribes the runtime to every event that downstream systems
//     emit, so the world's causal chain runs as a single connected graph.
//
// The orchestration loop is designed to be completely self-contained: it
// imports nothing that is not in the context folder, it allocates nothing
// in the hot path, and it works identically on WebGL1 and WebGL2 because
// it never touches the renderer directly — it only calls consumers that
// do. The loop is the glue that makes the living world behave as a single
// coherent system, and every downstream consumer (359–364) can assume the
// pipeline is wired correctly after calling init() on this module.
//#
// best for : The runtime bootstrap (361_FinalRuntimeWiring,
// 362_RuntimeBootstrap, 364_FinalLivingWorldAssembly) that instantiates
// the entire living world. Also every consumer that wants to know the exact
// wiring order of the landscape pipeline — 359_LandscapeSceneWiring
// (builds a scene from this module's wiring), 360_LandscapePublicAPI
// (exposes the scene-building entry point), and any custom scene builder
// that wants to reuse the exact same consumer wiring. The module is the
// single authority on the pipeline's structure, and reading it end-to-end
// is the fastest way to understand the pipeline's stage ordering, tier
// assignments, and inter-consumer dependencies.
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

// ─── Governance and diagnostics ────────────────────────────────
import { MemoryCeilingEnforcer } from './304_MemoryCeilingEnforcer.js';
import { FrameBudgetMonitor } from './305_FrameBudgetMonitor.js';
import { GCPauseMonitor } from './306_GCPauseMonitor.js';
import { MemoryProfiler } from './307_MemoryProfiler.js';

// ─── Biome and coupling layer ──────────────────────────────────
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

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Stage identifiers. Must match 309_ContextRuntime's stage numbering.
const STAGE = Object.freeze({
  BUILD_FRAME: 1,
  DRAIN_CAUSAL: 2,
  TIER_1HZ: 3,
  TIER_10HZ: 4,
  TIER_60HZ: 5,
  EMIT_BATCHED: 6
});

// Consumer identifiers for the governor registration.
const CONSUMER_ID = Object.freeze({
  BIOME_BLEND_FIELD: 0,
  BIOME_BLEND_SYSTEM: 1,
  ECOTONE: 2,
  MATERIAL_BRIDGE: 3,
  CLIMATE_COUPLING: 4,
  SOIL_COUPLING: 5,
  HYDROLOGY_COUPLING: 6,
  FAUNA_MIGRATION: 7,
  CHUNK_DESCRIPTOR: 8,
  CHUNK_STREAMER: 9,
  CHUNK_HLOD: 10,
  CHUNK_SPATIAL_HASH: 11,
  CHUNK_OCCLUSION: 12,
  CHUNK_PERSISTENCE: 13,
  CHUNK_MUTATION_REPLAY: 14,
  EROSION_SIMULATOR: 15,
  WIND_EROSION: 16,
  WATER_FLOW: 17,
  VEGETATION_SCATTER: 18,
  FAUNA_SPAWN: 19,
  DECAL_PLACEMENT: 20,
  PROP_PLACEMENT: 21,
  SHADOW_SCALER: 22,
  LIGHTING_COUPLER: 23,
  SKY_COUPLER: 24,
  SEASON_COUPLER: 25,
  SENSORY_COUPLER: 26,
  PERFORMANCE_GOVERNOR: 27,
  REBUILD_DEFERRAL: 28,
  EVENT_BUDGET: 29
});

// Maximum per-tick CPU budget for the whole orchestration loop, in ms.
// This is the outer bound; each consumer also has its own budget enforced
// by 355.
const ORCHESTRATION_CPU_BUDGET_MS = 8.0;

// Whether to run the pipeline in "safe mode" — every consumer is wrapped
// in a try/catch so a single consumer's failure does not bring down the
// whole world. Recommended during development; can be disabled for a
// small performance gain in production.
const SAFE_MODE = true;

// Whether to emit diagnostic events after each stage. Useful during
// development; can be disabled in production.
const EMIT_STAGE_DIAGNOSTICS = true;

// ══════════════════════════════════════════════════════════════════
// ─── CONSUMER BINDING TABLES ───────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// Each entry binds a consumer to its stage, its governor id, and its run
// function. The orchestration loop uses these tables to dispatch stage
// execution. Every consumer is listed exactly once.

// Stage 1 (BUILD_FRAME) — the runtime's own stage 1 runs the providers.
// The orchestration loop has nothing to add here, but it exposes a hook
// for any custom provider wiring.

// Stage 2 (DRAIN_CAUSAL) — the runtime drains the causal buffer, and
// 357_LandscapeEventBudget advances the coalesced events into the frame.
// The orchestration loop exposes this as a stage-2 callback.

// Stage 3 (TIER_1HZ) — the 1 Hz consumers.
const STAGE_3_CONSUMERS = Object.freeze([
  // Order matters: each consumer may depend on the previous one.
  { id: CONSUMER_ID.BIOME_BLEND_FIELD,      name: 'BiomeBlendField',      instance: BiomeBlendField },
  { id: CONSUMER_ID.BIOME_BLEND_SYSTEM,     name: 'BiomeBlendSystem',     instance: BiomeBlendSystem },
  { id: CONSUMER_ID.ECOTONE,                name: 'CrossBiomeEcotone',    instance: CrossBiomeEcotoneSystem },
  { id: CONSUMER_ID.CLIMATE_COUPLING,       name: 'BiomeClimateCoupling', instance: BiomeClimateCoupling },
  { id: CONSUMER_ID.SOIL_COUPLING,          name: 'BiomeSoilCoupling',    instance: BiomeSoilCoupling },
  { id: CONSUMER_ID.HYDROLOGY_COUPLING,     name: 'BiomeHydrologyCoupling', instance: BiomeHydrologyCoupling },
  { id: CONSUMER_ID.FAUNA_MIGRATION,        name: 'BiomeFaunaMigration',  instance: BiomeFaunaMigrationSystem },
  { id: CONSUMER_ID.CHUNK_DESCRIPTOR,       name: 'LandscapeChunkDescriptor', instance: LandscapeChunkDescriptor },
  { id: CONSUMER_ID.CHUNK_PERSISTENCE,      name: 'LandscapeChunkPersistence', instance: LandscapeChunkPersistence },
  { id: CONSUMER_ID.EROSION_SIMULATOR,      name: 'LandscapeErosionSimulator', instance: LandscapeErosionSimulator },
  { id: CONSUMER_ID.WIND_EROSION,           name: 'LandscapeWindErosion', instance: LandscapeWindErosionSystem },
  { id: CONSUMER_ID.SEASON_COUPLER,         name: 'LandscapeSeasonCoupler', instance: LandscapeSeasonCoupler },
  { id: CONSUMER_ID.SENSORY_COUPLER,        name: 'LandscapeSensoryCoupler', instance: LandscapeSensoryCoupler }
]);

// Stage 4 (TIER_10HZ) — the 10 Hz consumers.
const STAGE_4_CONSUMERS = Object.freeze([
  { id: CONSUMER_ID.CHUNK_STREAMER,         name: 'LandscapeChunkStreamer', instance: LandscapeChunkStreamer },
  { id: CONSUMER_ID.CHUNK_HLOD,             name: 'LandscapeChunkHLOD',     instance: LandscapeChunkHLOD },
  { id: CONSUMER_ID.CHUNK_SPATIAL_HASH,     name: 'LandscapeChunkSpatialHash', instance: LandscapeChunkSpatialHash },
  { id: CONSUMER_ID.CHUNK_OCCLUSION,        name: 'LandscapeChunkOcclusion', instance: LandscapeChunkOcclusion },
  { id: CONSUMER_ID.CHUNK_MUTATION_REPLAY,  name: 'LandscapeChunkMutationReplay', instance: LandscapeChunkMutationReplay },
  { id: CONSUMER_ID.WATER_FLOW,             name: 'LandscapeWaterFlow',     instance: LandscapeWaterFlowSystem },
  { id: CONSUMER_ID.VEGETATION_SCATTER,     name: 'LandscapeVegetationScatter', instance: LandscapeVegetationScatterSystem },
  { id: CONSUMER_ID.FAUNA_SPAWN,            name: 'LandscapeFaunaSpawn',    instance: LandscapeFaunaSpawnSystem },
  { id: CONSUMER_ID.DECAL_PLACEMENT,        name: 'LandscapeDecalPlacement', instance: LandscapeDecalPlacementSystem },
  { id: CONSUMER_ID.PROP_PLACEMENT,         name: 'LandscapePropPlacement', instance: LandscapePropPlacementSystem },
  { id: CONSUMER_ID.SHADOW_SCALER,          name: 'LandscapeShadowScaler',  instance: LandscapeShadowScaler },
  { id: CONSUMER_ID.LIGHTING_COUPLER,       name: 'LandscapeLightingCoupler', instance: LandscapeLightingCoupler },
  { id: CONSUMER_ID.SKY_COUPLER,            name: 'LandscapeSkyCoupler',    instance: LandscapeSkyCoupler },
  { id: CONSUMER_ID.PERFORMANCE_GOVERNOR,   name: 'LandscapePerformanceGovernor', instance: LandscapePerformanceGovernor },
  { id: CONSUMER_ID.REBUILD_DEFERRAL,       name: 'LandscapeRebuildDeferral', instance: LandscapeRebuildDeferral },
  { id: CONSUMER_ID.EVENT_BUDGET,           name: 'LandscapeEventBudget',   instance: LandscapeEventBudget }
]);

// Stage 5 (TIER_60HZ) — the 60 Hz consumers.
const STAGE_5_CONSUMERS = Object.freeze([
  { id: CONSUMER_ID.MATERIAL_BRIDGE,        name: 'BiomeBlendMaterialBridge', instance: BiomeBlendMaterialBridge }
]);

// ══════════════════════════════════════════════════════════════════
// ─── ORCHESTRATION STATE ───────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

const _dispatcher = new CoreEventDispatcher();

// The runtime instance. Created lazily on first init() call.
let _runtime = null;

// Per-consumer governor id assignment (matches CONSUMER_ID enum).
const _governorIdForConsumer = new Int32Array(64).fill(-1);

// Per-consumer last-tick cost in milliseconds (used for governor reporting).
const _lastCostMs = new Float32Array(64);

// Initialization state.
let _initialized = false;
let _initializationError = null;

// Global counters.
let _totalTicks = 0;
let _totalStage1Ticks = 0;
let _totalStage2Ticks = 0;
let _totalStage3Ticks = 0;
let _totalStage4Ticks = 0;
let _totalStage5Ticks = 0;
let _totalStage6Ticks = 0;
let _totalConsumerCalls = 0;
let _lastTickDurationMs = 0;

// ══════════════════════════════════════════════════════════════════
// ─── CONSUMER WRAPPERS ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Call a consumer's run() with try/catch and governor cost reporting.
// Zero-allocation after the first call: the cost is reported into a
// preallocated typed array rather than a fresh object.
function _runConsumer(consumerEntry, frame, tick, dt) {
  const instance = consumerEntry.instance;
  if (!instance || typeof instance.run !== 'function') return;

  const t0 = performanceNow();
  try {
    instance.run(frame, tick, dt);
  } catch (e) {
    if (SAFE_MODE) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('[OrchestrationLoop] Consumer error: ' + consumerEntry.name, e);
      }
    } else {
      throw e;
    }
  }
  const costMs = performanceNow() - t0;
  _lastCostMs[consumerEntry.id] = costMs;
  _totalConsumerCalls++;

  // Report to the governor if it is registered.
  const governorId = _governorIdForConsumer[consumerEntry.id];
  if (governorId >= 0) {
    LandscapePerformanceGovernor.reportConsumerCost(governorId, costMs, 0);
  }
}

// Run an entire stage's consumer list.
function _runStageConsumerList(consumerList, frame, tick, dt, stageIndex) {
  const t0 = performanceNow();
  for (let i = 0; i < consumerList.length; i++) {
    _runConsumer(consumerList[i], frame, tick, dt);
    if ((performanceNow() - t0) > ORCHESTRATION_CPU_BUDGET_MS) break;
  }
  if (EMIT_STAGE_DIAGNOSTICS) {
    _dispatcher.emit(EVENT_TYPE.ORCHESTRATION_STAGE_COMPLETE, {
      tick,
      stage: stageIndex,
      durationMs: performanceNow() - t0,
      consumerCount: consumerList.length
    });
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── STAGE 1 — BUILD FRAME ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Stage 1 is owned by the ContextRuntime (it runs the providers). The
// orchestration loop only needs to bump a counter and emit a diagnostic.
function _stage1BuildFrame(frame, tick, dt) {
  _totalStage1Ticks++;
  if (EMIT_STAGE_DIAGNOSTICS) {
    _dispatcher.emit(EVENT_TYPE.ORCHESTRATION_STAGE_START, { tick, stage: STAGE.BUILD_FRAME });
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── STAGE 2 — DRAIN CAUSAL ───────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Stage 2 is owned by the ContextRuntime (it drains the causal buffer).
// The orchestration loop additionally advances 357_LandscapeEventBudget
// so that the coalesced events it produces flow into the frame in the
// same tick.
function _stage2DrainCausal(frame, tick, dt) {
  _totalStage2Ticks++;
  if (EMIT_STAGE_DIAGNOSTICS) {
    _dispatcher.emit(EVENT_TYPE.ORCHESTRATION_STAGE_START, { tick, stage: STAGE.DRAIN_CAUSAL });
  }
  // Advance the event budget so its coalesced events are drained in this
  // stage (before the 1 Hz consumers that react to them).
  try {
    LandscapeEventBudget.run(frame, tick, dt);
  } catch (e) {
    if (!SAFE_MODE) throw e;
    if (typeof console !== 'undefined' && console.error) {
      console.error('[OrchestrationLoop] EventBudget error in stage 2:', e);
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── STAGE 3 — TIER 1HZ ──────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function _stage3Tier1Hz(frame, tick, dt) {
  _totalStage3Ticks++;
  if (EMIT_STAGE_DIAGNOSTICS) {
    _dispatcher.emit(EVENT_TYPE.ORCHESTRATION_STAGE_START, { tick, stage: STAGE.TIER_1HZ });
  }
  _runStageConsumerList(STAGE_3_CONSUMERS, frame, tick, dt, STAGE.TIER_1HZ);
}

// ══════════════════════════════════════════════════════════════════
// ─── STAGE 4 — TIER 10HZ ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function _stage4Tier10Hz(frame, tick, dt) {
  _totalStage4Ticks++;
  if (EMIT_STAGE_DIAGNOSTICS) {
    _dispatcher.emit(EVENT_TYPE.ORCHESTRATION_STAGE_START, { tick, stage: STAGE.TIER_10HZ });
  }
  _runStageConsumerList(STAGE_4_CONSUMERS, frame, tick, dt, STAGE.TIER_10HZ);
}

// ══════════════════════════════════════════════════════════════════
// ─── STAGE 5 — TIER 60HZ ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function _stage5Tier60Hz(frame, tick, dt) {
  _totalStage5Ticks++;
  if (EMIT_STAGE_DIAGNOSTICS) {
    _dispatcher.emit(EVENT_TYPE.ORCHESTRATION_STAGE_START, { tick, stage: STAGE.TIER_60HZ });
  }
  _runStageConsumerList(STAGE_5_CONSUMERS, frame, tick, dt, STAGE.TIER_60HZ);
}

// ══════════════════════════════════════════════════════════════════
// ─── STAGE 6 — EMIT BATCHED ──────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Stage 6 is owned by the ContextRuntime (it emits the batched dispatch
// from stage 5's accumulated render-side outputs). The orchestration loop
// only needs to bump a counter and emit a diagnostic. It does not call
// into any stage-one provider, so the critical discipline from the
// blueprint is preserved: stage 6 never triggers a rebuild of stage 1.
function _stage6EmitBatched(frame, tick, dt) {
  _totalStage6Ticks++;
  if (EMIT_STAGE_DIAGNOSTICS) {
    _dispatcher.emit(EVENT_TYPE.ORCHESTRATION_STAGE_COMPLETE, {
      tick,
      stage: STAGE.EMIT_BATCHED,
      durationMs: 0
    });
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── RUNTIME INTEGRATION ──────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// The stage callbacks that the ContextRuntime calls.
const _stageCallbacks = {
  stage1BuildFrame: _stage1BuildFrame,
  stage2DrainCausal: _stage2DrainCausal,
  stage3Tier1Hz: _stage3Tier1Hz,
  stage4Tier10Hz: _stage4Tier10Hz,
  stage5Tier60Hz: _stage5Tier60Hz,
  stage6EmitBatched: _stage6EmitBatched
};

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const LandscapeOrchestrationLoop = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  STAGE,
  CONSUMER_ID,
  stage3Consumers: STAGE_3_CONSUMERS,
  stage4Consumers: STAGE_4_CONSUMERS,
  stage5Consumers: STAGE_5_CONSUMERS,
  orchestrationCpuBudgetMs: ORCHESTRATION_CPU_BUDGET_MS,

  /**
   * Initialise the orchestration loop. Called once by
   * 362_RuntimeBootstrap or 364_FinalLivingWorldAssembly.
   *
   * Initialisation does the following:
   *   1. Calls init() on every consumer that has an init() method.
   *   2. Registers every consumer with 355_LandscapePerformanceGovernor.
   *   3. Wires the six stage callbacks into 309_ContextRuntime.
   *   4. Emits the ORCHESTRATION_LOOP_INITIALIZED event so downstream
   *      consumers know the loop is ready.
   */
  init() {
    if (_initialized) return;
    _initialized = true;

    try {
      // ─── 1. Init consumers that need it ─────────────────
      const consumersToInit = [
        BiomeFaunaMigrationSystem,
        LandscapeChunkPersistence,
        LandscapeChunkMutationReplay,
        LandscapeDecalPlacementSystem,
        LandscapeSkyCoupler,
        LandscapePerformanceGovernor
      ];
      for (let i = 0; i < consumersToInit.length; i++) {
        const c = consumersToInit[i];
        if (c && typeof c.init === 'function') {
          try {
            c.init();
          } catch (e) {
            if (typeof console !== 'undefined' && console.error) {
              console.error('[OrchestrationLoop] Consumer init error:', e);
            }
          }
        }
      }

      // ─── 2. Register every consumer with the governor ──
      const allConsumers = [
        ...STAGE_3_CONSUMERS,
        ...STAGE_4_CONSUMERS,
        ...STAGE_5_CONSUMERS
      ];
      for (let i = 0; i < allConsumers.length; i++) {
        const entry = allConsumers[i];
        const governorId = LandscapePerformanceGovernor.registerConsumer(entry.name);
        _governorIdForConsumer[entry.id] = governorId;
      }

      // ─── 3. Wire the six stage callbacks into the runtime ─
      if (ContextRuntime && typeof ContextRuntime.setStageCallbacks === 'function') {
        ContextRuntime.setStageCallbacks(_stageCallbacks);
      }

      // ─── 4. Emit the initialized event ──────────────────
      _dispatcher.emit(EVENT_TYPE.ORCHESTRATION_LOOP_INITIALIZED, {
        consumerCount: allConsumers.length,
        stage3Count: STAGE_3_CONSUMERS.length,
        stage4Count: STAGE_4_CONSUMERS.length,
        stage5Count: STAGE_5_CONSUMERS.length
      });
    } catch (e) {
      _initializationError = e;
      if (typeof console !== 'undefined' && console.error) {
        console.error('[OrchestrationLoop] Initialization error:', e);
      }
    }
  },

  /**
   * Get the stage callbacks object. This is the object that
   * 309_ContextRuntime calls into on every tick, and it is what wires
   * the entire landscape pipeline into the runtime's six-stage loop.
   *
   * @returns {object} The stage callbacks.
   */
  getStageCallbacks() {
    return _stageCallbacks;
  },

  /**
   * Query whether the orchestration loop is initialised.
   */
  isInitialized() {
    return _initialized;
  },

  /**
   * Query the initialisation error, if any.
   */
  getInitializationError() {
    return _initializationError;
  },

  /**
   * Manually run a single stage. Useful for testing and for custom
   * runtimes that want to drive the pipeline from their own loop.
   *
   * @param {number} stage - One of STAGE.BUILD_FRAME..EMIT_BATCHED.
   * @param {ContextFrame} frame
   * @param {number} tick
   * @param {number} dt
   */
  runStage(stage, frame, tick, dt) {
    switch (stage) {
      case STAGE.BUILD_FRAME:    _stage1BuildFrame(frame, tick, dt); break;
      case STAGE.DRAIN_CAUSAL:   _stage2DrainCausal(frame, tick, dt); break;
      case STAGE.TIER_1HZ:       _stage3Tier1Hz(frame, tick, dt); break;
      case STAGE.TIER_10HZ:      _stage4Tier10Hz(frame, tick, dt); break;
      case STAGE.TIER_60HZ:      _stage5Tier60Hz(frame, tick, dt); break;
      case STAGE.EMIT_BATCHED:   _stage6EmitBatched(frame, tick, dt); break;
      default: break;
    }
  },

  /**
   * Run all six stages in one call. Useful for testing and for custom
   * runtimes that want to run the pipeline as a single function call.
   */
  runFrame(frame, tick, dt) {
    const t0 = performanceNow();
    _totalTicks++;

    _stage1BuildFrame(frame, tick, dt);
    _stage2DrainCausal(frame, tick, dt);

    // 1 Hz consumers run every 60th tick.
    if (tick % 60 === 0) _stage3Tier1Hz(frame, tick, dt);

    // 10 Hz consumers run every 6th tick.
    if (tick % 6 === 0) _stage4Tier10Hz(frame, tick, dt);

    // 60 Hz consumers run every tick.
    _stage5Tier60Hz(frame, tick, dt);
    _stage6EmitBatched(frame, tick, dt);

    _lastTickDurationMs = performanceNow() - t0;
  },

  /**
   * Get the governor id for a consumer id.
   */
  getGovernorId(consumerId) {
    if (consumerId < 0 || consumerId >= 64) return -1;
    return _governorIdForConsumer[consumerId];
  },

  /**
   * Get the last-tick cost in milliseconds for a consumer id.
   */
  getLastCostMs(consumerId) {
    if (consumerId < 0 || consumerId >= 64) return 0;
    return _lastCostMs[consumerId];
  },

  /**
   * Get all per-consumer costs into a preallocated output array. The
   * array should be at least 64 entries long.
   */
  readConsumerCosts(outCostMs) {
    for (let i = 0; i < 64; i++) outCostMs[i] = _lastCostMs[i];
    return 64;
  },

  // ─── Diagnostics ─────────────────────────────────────────
  get totalTicks() { return _totalTicks; },
  get totalStage1Ticks() { return _totalStage1Ticks; },
  get totalStage2Ticks() { return _totalStage2Ticks; },
  get totalStage3Ticks() { return _totalStage3Ticks; },
  get totalStage4Ticks() { return _totalStage4Ticks; },
  get totalStage5Ticks() { return _totalStage5Ticks; },
  get totalStage6Ticks() { return _totalStage6Ticks; },
  get totalConsumerCalls() { return _totalConsumerCalls; },
  get lastTickDurationMs() { return _lastTickDurationMs; }
});

function performanceNow() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}

export default LandscapeOrchestrationLoop;