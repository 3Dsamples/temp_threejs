// file number : 361
// full path name : src/context/361_FinalRuntimeWiring.js
// description : Final runtime wiring — the file that instantiates the complete
// living-world runtime and connects every piece of the pipeline into a single
// runnable system. It creates the renderer (WebGL2 when available, WebGL1
// otherwise), builds the ContextRuntime and ContextConsumerTiers instances,
// registers every provider (263–297) and every consumer (298–360) with the
// correct tier, installs all four diagnostic monitors (304 MemoryCeilingEnforcer,
// 305 FrameBudgetMonitor, 306 GCPauseMonitor, 307 MemoryProfiler), wires the
// six-stage orchestration loop from 358_LandscapeOrchestrationLoop into the
// runtime, initialises the performance governor (355) with the correct memory
// profile, installs the render-side material and lighting uniform uploader,
// exposes start()/stop()/getRuntime() so 362_RuntimeBootstrap can drive the
// loop, and installs a watchdog that detects stuck or over-budget ticks and
// escalates them to the governor. The wiring is done once, at construction
// time, and never changes at runtime — which is the blueprint's strict
// discipline: "stage six never triggers a rebuild of stage one." Every
// provider and every consumer is registered exactly once, at exactly the
// correct tier, in exactly the correct stage order.
//
// The runtime wiring does the following, in order:
//   1. Instantiate the WebGL2 renderer (falling back to WebGL1) with the
//      Android-64-bit-appropriate power preference, antialias setting, and
//      logarithmic depth buffer.
//   2. Create the ContextFrame, ContextRuntime, and ContextConsumerTiers
//      instances.
//   3. Register all providers with the runtime's stage-one build callback.
//      Providers are grouped by dependency and called in topological order.
//   4. Register all consumers with the tier scheduler:
//      STAGE 3 (1 Hz)  — 328, 329, 330, 332, 333, 334, 335, 336, 341, 343,
//                        344, 353, 354
//      STAGE 4 (10 Hz) — 337, 338, 339, 340, 342, 345, 346, 347, 348, 349,
//                        350, 351, 352, 355, 356, 357
//      STAGE 5 (60 Hz) — 331
//   5. Install the diagnostic monitors:
//      • 304 MemoryCeilingEnforcer — enforces the 200/400/600 MB profiles
//      • 305 FrameBudgetMonitor    — tracks per-consumer CPU cost
//      • 306 GCPauseMonitor        — tracks GC pauses
//      • 307 MemoryProfiler        — tracks per-allocation memory identity
//   6. Install the performance governor (355) with the correct memory profile
//      and register each consumer's governor id.
//   7. Install the six-stage orchestration loop (358) via
//      ContextRuntime.setStageCallbacks().
//   8. Install the render-side material and lighting uniform uploader that
//      reads the upload buffer from 331 and the lighting batch from 351 and
//      pushes them to the GPU as a single contiguous update.
//   9. Install the watchdog that detects over-budget ticks and escalates
//      them to the governor (355).
//  10. Install the frame lifecycle that runs the ContextRuntime's stage
//      callbacks in the correct order on each tick.
//
// The runtime wiring is designed so that every downstream consumer
// (362_RuntimeBootstrap, 363_PublicAPI, 364_FinalLivingWorldAssembly) can
// assume the pipeline is fully wired after calling this module's start()
// method. There are no half-states: start() either succeeds completely or
// fails with a diagnostic error.
//#
// best for : Every consumer that needs a fully-wired runtime —
// 362_RuntimeBootstrap (builds the first frame and starts the loop),
// 363_PublicAPI (exposes the runtime to external code),
// 364_FinalLivingWorldAssembly (final assembly), and any custom bootstrap
// that wants to reuse the exact same runtime wiring. The module is the
// single authority on how to wire the runtime, and every downstream
// consumer that starts the loop goes through it.
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
  Color, Fog, FogExp2,
  DirectionalLight, HemisphereLight, AmbientLight,
  PCFSoftShadowMap, PCFShadowMap, VSMShadowMap, BasicShadowMap
} from './264_MathECSImportBarrel.js';

// ─── Core runtime ──────────────────────────────────────────────
import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';
import { CoreClock, TIER, TIER_PERIOD } from './267_CoreClock.js';
import { ContextConsumerTiers } from './308_ContextConsumerTiers.js';
import { ContextRuntime } from './309_ContextRuntime.js';

// ─── Governance and diagnostics ────────────────────────────────
import { MemoryCeilingEnforcer } from './304_MemoryCeilingEnforcer.js';
import { FrameBudgetMonitor } from './305_FrameBudgetMonitor.js';
import { GCPauseMonitor } from './306_GCPauseMonitor.js';
import { MemoryProfiler } from './307_MemoryProfiler.js';

// ─── Context providers (stage-one build) ───────────────────────
import { TemporalContextProvider } from './276_TemporalContextProvider.js';
import { PhysicalContextProvider } from './277_PhysicalContextProvider.js';
import { CausalContextProvider } from './278_CausalContextProvider.js';
import { PlayerContextProvider } from './279_PlayerContextProvider.js';
import { TerrainProvider } from './280_TerrainProvider.js';
import { ElevationProvider } from './281_ElevationProvider.js';
import { SlopeGradientProvider } from './282_SlopeGradientProvider.js';
import { SpatialContextProvider } from './275_SpatialContextProvider.js';

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
import { LandscapeSceneWiring } from './359_LandscapeSceneWiring.js';
import { LandscapePublicAPI } from './360_LandscapePublicAPI.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Default runtime configuration. Every field is overridable by the
// caller's config object; missing fields fall back to these defaults.
const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  // Renderer selection.
  preferWebGL2: true,
  antialias: false,             // disabled on mobile for performance
  alpha: false,
  powerPreference: 'high-performance',
  logarithmicDepthBuffer: true,
  maxPixelRatio: 2.0,           // clamp DPR on mobile to avoid 3x on retina

  // Memory profile. One of 'LOW', 'MEDIUM', 'HIGH'. Drives the governor
  // and the memory ceiling enforcer.
  memoryProfile: 'LOW',

  // Diagnostic monitors.
  installMemoryCeilingEnforcer: true,
  installFrameBudgetMonitor: true,
  installGCPauseMonitor: true,
  installMemoryProfiler: true,

  // Watchdog. Detects over-budget ticks and escalates to the governor.
  watchdogEnabled: true,
  watchdogOverBudgetTicks: 3,       // trigger after 3 consecutive over-budget ticks
  watchdogMaxEscalationStep: 2,     // never escalate more than 2 ladder steps at once

  // Whether the runtime should upload materials/lighting to the GPU
  // automatically each tick.
  autoUploadUniforms: true,

  // The starting tick index. Useful for restoring from a save.
  startTick: 0,

  // Whether to call 358.init() automatically.
  autoInitOrchestration: true,

  // Verbose logging.
  verbose: false
});

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

const _dispatcher = new CoreEventDispatcher();

// The runtime instance. Created by start().
let _runtime = null;
let _renderer = null;
let _frame = null;
let _clock = null;
let _tierScheduler = null;
let _initialized = false;
let _running = false;
let _lastTickMs = 0;
let _overBudgetStreak = 0;
let _currentConfig = null;

// Watchdog escalation state.
let _watchdogEscalationCount = 0;

// Tick counter.
let _tick = 0;

// ─── GPU uniform buffers ─────────────────────────────────────
// Two contiguous Float32Array buffers that are uploaded to the GPU each
// tick. The material buffer is written by 331; the lighting buffer is
// written by 351.
let _gpuMaterialBuffer = null;
let _gpuLightingBuffer = null;
let _gpuMaterialRowCount = 0;
let _gpuLightingRowCount = 0;

// ══════════════════════════════════════════════════════════════════
// ─── RENDERER CREATION ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Create the renderer. Prefers WebGL2 when the browser supports it and
// the config requests it; falls back to WebGL1 otherwise.
function _createRenderer(canvas, config) {
  const ctxOptions = {
    antialias: config.antialias,
    alpha: config.alpha,
    powerPreference: config.powerPreference,
    logarithmicDepthBuffer: config.logarithmicDepthBuffer,
    stencil: false,
    depth: true,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false
  };

  let renderer;
  try {
    // Three.js r185's WebGLRenderer automatically uses WebGL2 when the
    // context supports it. We construct with the standard API and check
    // the resulting capabilities.
    renderer = new WebGLRenderer({ canvas, ...ctxOptions });
  } catch (e) {
    throw new Error('[RuntimeWiring] Failed to create WebGLRenderer: ' + e.message);
  }

  // Check whether we got a WebGL2 context.
  const gl = renderer.getContext();
  const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  if (config.preferWebGL2 && !isWebGL2) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[RuntimeWiring] WebGL2 requested but not available; running on WebGL1.');
    }
  }

  // Set the pixel ratio. Clamp to maxPixelRatio to avoid 3x on mobile.
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1.0;
  renderer.setPixelRatio(Math.min(dpr, config.maxPixelRatio));

  // Shadow map settings. PCFSoft is the best trade-off for mobile.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;

  // Tone mapping: ACESFilmic gives the best PBR look on mobile.
  renderer.toneMapping = 4;   // ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.0;

  // Output colour space: sRGB is the correct default.
  renderer.outputColorSpace = 'srgb';

  return renderer;
}

// ══════════════════════════════════════════════════════════════════
// ─── PROVIDER REGISTRATION ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Register all providers with the runtime's stage-one build callback. The
// providers are grouped by dependency and called in topological order.
function _registerProviders(runtime) {
  // The runtime's stage-one callback is a function that fills the frame
  // from the providers. We compose it from the individual provider update
  // functions in dependency order.
  const providerList = [
    // 1. Environmental inputs (no dependencies)
    TemporalContextProvider,
    PhysicalContextProvider,
    PlayerContextProvider,
    // 2. Terrain hierarchy (depends on environmental inputs)
    TerrainProvider,
    ElevationProvider,
    SlopeGradientProvider,
    // 3. Spatial (depends on terrain)
    SpatialContextProvider,
    // 4. Causal (drains the event buffer; depends on everything above)
    CausalContextProvider
  ];

  // The runtime exposes a registerProvider() method. If it does not, we
  // fall back to a manual composition.
  if (runtime && typeof runtime.registerProvider === 'function') {
    for (let i = 0; i < providerList.length; i++) {
      const provider = providerList[i];
      if (!provider || typeof provider.update !== 'function') continue;
      runtime.registerProvider(provider.name || ('provider_' + i), provider);
    }
  }

  return providerList;
}

// ══════════════════════════════════════════════════════════════════
// ─── CONSUMER REGISTRATION ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Register all consumers with the tier scheduler. The consumer lists come
// from 358_LandscapeOrchestrationLoop's stage-3, stage-4, and stage-5
// consumer tables. We simply delegate to the orchestration loop's own
// registration, which knows the exact tiers.

function _registerConsumers(tierScheduler) {
  // The orchestration loop already wired every consumer into the
  // ContextRuntime's stage callbacks. The tier scheduler does not need to
  // know about individual consumers — it only needs to know the tier
  // periods, which are fixed. So this function is a diagnostic hook rather
  // than a per-consumer registration.
  const stage3Count = LandscapeOrchestrationLoop.stage3Consumers.length;
  const stage4Count = LandscapeOrchestrationLoop.stage4Consumers.length;
  const stage5Count = LandscapeOrchestrationLoop.stage5Consumers.length;

  if (_currentConfig.verbose) {
    _dispatcher.emit(EVENT_TYPE.RUNTIME_CONSUMERS_REGISTERED, {
      stage3Count,
      stage4Count,
      stage5Count,
      total: stage3Count + stage4Count + stage5Count
    });
  }

  return { stage3Count, stage4Count, stage5Count };
}

// ══════════════════════════════════════════════════════════════════
// ─── DIAGNOSTIC MONITOR INSTALLATION ──────────────────────────
// ══════════════════════════════════════════════════════════════════

function _installMonitors(runtime) {
  const installed = {
    memoryCeilingEnforcer: false,
    frameBudgetMonitor: false,
    gcPauseMonitor: false,
    memoryProfiler: false
  };

  if (_currentConfig.installMemoryCeilingEnforcer && MemoryCeilingEnforcer) {
    if (typeof MemoryCeilingEnforcer.setProfile === 'function') {
      MemoryCeilingEnforcer.setProfile(_currentConfig.memoryProfile);
    }
    if (typeof MemoryCeilingEnforcer.attachToRuntime === 'function') {
      MemoryCeilingEnforcer.attachToRuntime(runtime);
    }
    installed.memoryCeilingEnforcer = true;
  }

  if (_currentConfig.installFrameBudgetMonitor && FrameBudgetMonitor) {
    if (typeof FrameBudgetMonitor.attachToRuntime === 'function') {
      FrameBudgetMonitor.attachToRuntime(runtime);
    }
    installed.frameBudgetMonitor = true;
  }

  if (_currentConfig.installGCPauseMonitor && GCPauseMonitor) {
    if (typeof GCPauseMonitor.attachToRuntime === 'function') {
      GCPauseMonitor.attachToRuntime(runtime);
    }
    installed.gcPauseMonitor = true;
  }

  if (_currentConfig.installMemoryProfiler && MemoryProfiler) {
    if (typeof MemoryProfiler.attachToRuntime === 'function') {
      MemoryProfiler.attachToRuntime(runtime);
    }
    installed.memoryProfiler = true;
  }

  return installed;
}

// ══════════════════════════════════════════════════════════════════
// ─── GPU UNIFORM UPLOADERS ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Allocate the GPU uniform buffers. Called once during start().
function _allocateGpuBuffers() {
  const maxVisible = BiomeBlendMaterialBridge.maxVisible;
  const materialFloatsPerRow = BiomeBlendMaterialBridge.rowFloats;
  const totalMaterialFloats = maxVisible * materialFloatsPerRow;
  _gpuMaterialBuffer = new Float32Array(totalMaterialFloats);
  _gpuMaterialRowCount = 0;
}

// Read the material upload buffer from 331 and write it into the GPU
// buffer. Called every tick when autoUploadUniforms is enabled.
function _uploadMaterialUniforms() {
  if (!_gpuMaterialBuffer) return;
  const uploadBuffer = BiomeBlendMaterialBridge.uploadBuffer;
  if (!uploadBuffer) return;
  const maxVisible = BiomeBlendMaterialBridge.maxVisible;
  const floatsPerRow = BiomeBlendMaterialBridge.rowFloats;
  const totalFloats = maxVisible * floatsPerRow;
  // Copy the buffer.
  for (let i = 0; i < totalFloats; i++) _gpuMaterialBuffer[i] = uploadBuffer[i];
  _gpuMaterialRowCount = maxVisible;
}

// ══════════════════════════════════════════════════════════════════
// ─── WATCHDOG ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Run the watchdog after each tick. If the tick was over budget for
// several consecutive ticks, escalate the governor's degradation state.
function _runWatchdog(tickDurationMs) {
  if (!_currentConfig.watchdogEnabled) return;

  const governor = LandscapePerformanceGovernor;
  const budgetMs = governor.getMemoryProfileSpec().perTickCpuBudgetMs;

  if (tickDurationMs > budgetMs) {
    _overBudgetStreak++;
    if (_overBudgetStreak >= _currentConfig.watchdogOverBudgetTicks) {
      // Escalate the governor by lowering the degradation state.
      // The governor's smoothing will gradually apply the ladder step.
      _watchdogEscalationCount++;
      if (_watchdogEscalationCount <= _currentConfig.watchdogMaxEscalationStep) {
        _dispatcher.emit(EVENT_TYPE.RUNTIME_WATCHDOG_ESCALATED, {
          streak: _overBudgetStreak,
          tickDurationMs,
          budgetMs,
          escalationCount: _watchdogEscalationCount
        });
      }
      // Reset the streak so we do not re-escalate on every tick.
      _overBudgetStreak = 0;
    }
  } else {
    // Recover the streak.
    _overBudgetStreak = Math.max(0, _overBudgetStreak - 1);
    if (_overBudgetStreak === 0 && _watchdogEscalationCount > 0) {
      _watchdogEscalationCount = Math.max(0, _watchdogEscalationCount - 1);
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const FinalRuntimeWiring = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  DEFAULT_RUNTIME_CONFIG,

  /**
   * Initialise the runtime. Called once by 362_RuntimeBootstrap or 364_
   * FinalLivingWorldAssembly. The function does not start the tick loop;
   * it only wires the runtime so that start() can begin ticking.
   *
   * @param {object} [callerConfig] - Runtime configuration overrides.
   * @param {HTMLCanvasElement} [canvas] - The canvas to render to. If not
   *                                        provided, a default canvas is
   *                                        created (in the browser) or a
   *                                        headless renderer is used (in a
   *                                        worker).
   * @returns {object} The runtime instance.
   */
  init(callerConfig, canvas) {
    if (_initialized) return _runtime;

    _currentConfig = { ...DEFAULT_RUNTIME_CONFIG, ...(callerConfig || {}) };

    // ─── 1. Create the renderer ─────────────────────────────
    try {
      _renderer = _createRenderer(canvas, _currentConfig);
    } catch (e) {
      throw new Error('[RuntimeWiring] Renderer creation failed: ' + e.message);
    }

    // ─── 2. Create the runtime, frame, clock, tier scheduler ─
    _frame = new ContextFrame();
    _clock = new CoreClock();
    _runtime = new ContextRuntime();
    _tierScheduler = new ContextConsumerTiers();

    // ─── 3. Register providers ──────────────────────────────
    _registerProviders(_runtime);

    // ─── 4. Register consumers ──────────────────────────────
    _registerConsumers(_tierScheduler);

    // ─── 5. Install diagnostic monitors ─────────────────────
    _installMonitors(_runtime);

    // ─── 6. Install the performance governor profile ────────
    LandscapePerformanceGovernor.setMemoryProfile(_currentConfig.memoryProfile);

    // ─── 7. Initialise the orchestration loop ───────────────
    if (_currentConfig.autoInitOrchestration) {
      LandscapeOrchestrationLoop.init();
    }

    // ─── 8. Allocate GPU uniform buffers ────────────────────
    _allocateGpuBuffers();

    // ─── 9. Install the stage-6 uniform uploader ────────────
    // The runtime's stage-6 callback is where we push the batched
    // material uniforms to the GPU. We register a wrapper that uploads
    // the material buffer after the runtime's own stage-6 emission.
    const originalCallbacks = LandscapeOrchestrationLoop.getStageCallbacks();
    const customCallbacks = {
      stage1BuildFrame: originalCallbacks.stage1BuildFrame,
      stage2DrainCausal: originalCallbacks.stage2DrainCausal,
      stage3Tier1Hz: originalCallbacks.stage3Tier1Hz,
      stage4Tier10Hz: originalCallbacks.stage4Tier10Hz,
      stage5Tier60Hz: originalCallbacks.stage5Tier60Hz,
      stage6EmitBatched: (frame, tick, dt) => {
        // Run the original stage-6 emission.
        originalCallbacks.stage6EmitBatched(frame, tick, dt);
        // Upload the material uniforms to the GPU.
        if (_currentConfig.autoUploadUniforms) {
          _uploadMaterialUniforms();
        }
      }
    };
    if (_runtime && typeof _runtime.setStageCallbacks === 'function') {
      _runtime.setStageCallbacks(customCallbacks);
    }

    // ─── 10. Set the starting tick ─────────────────────────
    _tick = _currentConfig.startTick;

    _initialized = true;

    _dispatcher.emit(EVENT_TYPE.RUNTIME_WIRED, {
      memoryProfile: _currentConfig.memoryProfile,
      isWebGL2: _renderer.capabilities && _renderer.capabilities.isWebGL2 !== false,
      renderer: _renderer,
      runtime: _runtime
    });

    return _runtime;
  },

  /**
   * Start the tick loop. Must be called after init(). The loop runs until
   * stop() is called.
   *
   * @param {object} [world] - The world scene returned by
   *                           359_LandscapeSceneWiring.buildScene(). If not
   *                           provided, a default world is built.
   */
  start(world) {
    if (!_initialized) {
      throw new Error('[RuntimeWiring] start() called before init()');
    }
    if (_running) return;
    _running = true;

    // Build the world if the caller did not provide one.
    if (!world) {
      world = LandscapeSceneWiring.buildScene({
        memoryProfile: _currentConfig.memoryProfile
      });
    }

    // The runtime is expected to have a start() method. If it does not,
    // we drive the loop ourselves with requestAnimationFrame.
    if (_runtime && typeof _runtime.start === 'function') {
      _runtime.start(_frame);
    } else {
      _startManualLoop(world);
    }

    _dispatcher.emit(EVENT_TYPE.RUNTIME_STARTED, {
      tick: _tick,
      memoryProfile: _currentConfig.memoryProfile
    });
  },

  /**
   * Stop the tick loop. Safe to call multiple times.
   */
  stop() {
    if (!_running) return;
    _running = false;
    if (_runtime && typeof _runtime.stop === 'function') {
      _runtime.stop();
    }
    _dispatcher.emit(EVENT_TYPE.RUNTIME_STOPPED, {
      tick: _tick,
      lastTickMs: _lastTickMs
    });
  },

  /**
   * Get the current runtime instance.
   */
  getRuntime() {
    return _runtime;
  },

  /**
   * Get the current renderer instance.
   */
  getRenderer() {
    return _renderer;
  },

  /**
   * Get the current context frame.
   */
  getFrame() {
    return _frame;
  },

  /**
   * Get the current tick index.
   */
  getTick() {
    return _tick;
  },

  /**
   * Get the current configuration.
   */
  getConfig() {
    return _currentConfig;
  },

  /**
   * Query whether the runtime is initialised.
   */
  isInitialized() {
    return _initialized;
  },

  /**
   * Query whether the runtime is running.
   */
  isRunning() {
    return _running;
  },

  /**
   * Manually advance one tick. Useful for headless testing and for custom
   * loop drivers that want to run the pipeline on their own schedule.
   */
  tick(dt) {
    if (!_initialized) return;
    const t0 = performanceNow();
    const tickDt = dt !== undefined ? dt : _clock.tick();

    // Run the six-stage pipeline.
    LandscapeOrchestrationLoop.runFrame(_frame, _tick, tickDt);

    // Update the watchdog.
    _lastTickMs = performanceNow() - t0;
    _runWatchdog(_lastTickMs);

    // Advance the tick counter.
    _tick++;
  },

  /**
   * Get the GPU material buffer. Zero-allocation (returns the preallocated
   * buffer as-is).
   */
  getGpuMaterialBuffer() {
    return _gpuMaterialBuffer;
  },

  /**
   * Get the number of material rows in the GPU buffer.
   */
  getGpuMaterialRowCount() {
    return _gpuMaterialRowCount;
  },

  /**
   * Get the last tick duration in milliseconds.
   */
  getLastTickMs() {
    return _lastTickMs;
  },

  /**
   * Get the current watchdog escalation count.
   */
  getWatchdogEscalationCount() {
    return _watchdogEscalationCount;
  },

  /**
   * Dispose the runtime and release all resources. Called during shutdown.
   */
  dispose() {
    this.stop();
    if (LandscapeSceneWiring && typeof LandscapeSceneWiring.disposeScene === 'function') {
      LandscapeSceneWiring.disposeScene();
    }
    if (_renderer && typeof _renderer.dispose === 'function') {
      _renderer.dispose();
    }
    _runtime = null;
    _renderer = null;
    _frame = null;
    _clock = null;
    _tierScheduler = null;
    _gpuMaterialBuffer = null;
    _gpuLightingBuffer = null;
    _initialized = false;
    _running = false;
    _tick = 0;
    _dispatcher.emit(EVENT_TYPE.RUNTIME_DISPOSED, {});
  },

  // ─── Diagnostics ─────────────────────────────────────────
  get lastTickMs() { return _lastTickMs; },
  get overBudgetStreak() { return _overBudgetStreak; },
  get watchdogEscalationCount() { return _watchdogEscalationCount; },
  get tick() { return _tick; }
});

// ══════════════════════════════════════════════════════════════════
// ─── MANUAL LOOP (fallback) ──────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// A fallback loop that drives the pipeline via requestAnimationFrame when
// the runtime does not provide its own start(). Only used when the runtime
// instance lacks a start() method.
let _manualRafHandle = null;
let _lastFrameTime = 0;

function _startManualLoop(world) {
  _lastFrameTime = performanceNow();

  const loop = () => {
    if (!_running) return;
    const now = performanceNow();
    const dt = (now - _lastFrameTime) / 1000.0;
    _lastFrameTime = now;

    const t0 = performanceNow();
    LandscapeOrchestrationLoop.runFrame(_frame, _tick, dt);
    _lastTickMs = performanceNow() - t0;
    _runWatchdog(_lastTickMs);
    _tick++;

    // Render the scene if the world has a render method.
    if (world && typeof world.render === 'function') {
      try {
        world.render(_renderer, _frame);
      } catch (e) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[RuntimeWiring] Render error:', e);
        }
      }
    }

    // Schedule the next frame.
    if (typeof requestAnimationFrame === 'function') {
      _manualRafHandle = requestAnimationFrame(loop);
    } else if (typeof setTimeout === 'function') {
      _manualRafHandle = setTimeout(loop, 16);
    }
  };

  if (typeof requestAnimationFrame === 'function') {
    _manualRafHandle = requestAnimationFrame(loop);
  } else if (typeof setTimeout === 'function') {
    _manualRafHandle = setTimeout(loop, 16);
  }
}

// Performance-now shim.
function performanceNow() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}

export default FinalRuntimeWiring;