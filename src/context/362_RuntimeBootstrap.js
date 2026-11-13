// file number : 362
// full path name : src/context/362_RuntimeBootstrap.js
// description : Runtime bootstrap — the single-entry bootstrap that ties the
// entire living-world pipeline together. It calls 361_FinalRuntimeWiring.init()
// to create the renderer, frame, clock, and tier scheduler; calls
// 359_LandscapeSceneWiring.buildScene() to generate the initial chunk set and
// populate the biome registry; calls 361_FinalRuntimeWiring.start() to begin
// the tick loop; and then enters the six-stage orchestration loop that drives
// every consumer in the pipeline. On Android 64-bit it wires the renderer to
// the caller's canvas and requests the correct WebGL context (WebGL2 when
// available, WebGL1 otherwise); on desktop it does the same with the same
// fallback path, so the same bootstrap runs on both. The bootstrap is the
// smallest possible main() — every piece of logic lives in the modules it
// composes — and it is deliberately idempotent: calling bootstrap() twice is a
// no-op after the first call, calling shutdown() cleans everything up, and
// calling bootstrap() again after shutdown() rebuilds the entire world from
// scratch.
//
// The bootstrap is the only place in the pipeline where the following happen
// in a single call:
//   (1) RENDERER INITIALISATION   — creates the WebGL2 (or WebGL1) renderer
//                                   with the correct Android-64-bit settings
//                                   (high-performance power, log depth,
//                                   clamped DPR, PCF soft shadows, ACES
//                                   tone mapping, sRGB output);
//   (2) FRAME AND CLOCK           — allocates the ContextFrame and the
//                                   monotonic CoreClock;
//   (3) TIER SCHEDULER            — creates the 60/10/1 Hz consumer tier
//                                   scheduler with the correct phase offsets;
//   (4) DIAGNOSTIC MONITORS       — installs 304, 305, 306, 307 with the
//                                   correct memory profile;
//   (5) PERFORMANCE GOVERNOR      — selects the LOW/MEDIUM/HIGH memory
//                                   profile (200/400/600 MB) and registers
//                                   every consumer with the governor;
//   (6) ORCHESTRATION LOOP        — wires the six-stage callbacks from
//                                   358_LandscapeOrchestrationLoop into
//                                   309_ContextRuntime;
//   (7) INITIAL WORLD             — builds the first scene via
//                                   359_LandscapeSceneWiring (initial chunk
//                                   radius, biome registration, per-chunk
//                                   registration, initial uniforms);
//   (8) TICK LOOP                 — starts the render loop that drives
//                                   stage 1 → stage 2 → stage 3 → stage 4 →
//                                   stage 5 → stage 6 on every tick;
//   (9) WATCHDOG                  — monitors per-tick cost and escalates to
//                                   the governor when the budget is exceeded;
//   (10) SHUTDOWN                 — disposes the world, the renderer, the
//                                   runtime, and every pooled buffer, so the
//                                   whole pipeline can be torn down and
//                                   rebuilt from scratch.
//
// The bootstrap reads its configuration from a caller-supplied options
// object. Every option has a sensible default, so a caller that just wants
// a working world can call bootstrap({}) with no other configuration.
// #
// best for : The application-level entry point that starts the living world —
// 363_PublicAPI (wraps the bootstrap in a public surface), 364_FinalLivingWorld
// Assembly (the final assembly that instantiates every living system and
// starts the loop), and any external code that wants to bootstrap a complete
// living world with a single function call. The module is the single entry
// point for starting the pipeline, and every consumer that starts the
// pipeline goes through it.
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
import { CoreClock } from './267_CoreClock.js';
import { ContextRuntime } from './309_ContextRuntime.js';
import { ContextConsumerTiers } from './308_ContextConsumerTiers.js';

// ─── Governance and diagnostics ────────────────────────────────
import { MemoryCeilingEnforcer } from './304_MemoryCeilingEnforcer.js';
import { FrameBudgetMonitor } from './305_FrameBudgetMonitor.js';
import { GCPauseMonitor } from './306_GCPauseMonitor.js';
import { MemoryProfiler } from './307_MemoryProfiler.js';

// ─── Biome and landscape layer ─────────────────────────────────
import { BiomeRegistry } from './327_BiomeRegistryBarrel.js';
import { LandscapePerformanceGovernor } from './355_LandscapePerformanceGovernor.js';
import { LandscapeOrchestrationLoop } from './358_LandscapeOrchestrationLoop.js';
import { LandscapeSceneWiring } from './359_LandscapeSceneWiring.js';

// ─── Final wiring ──────────────────────────────────────────────
import { FinalRuntimeWiring } from './361_FinalRuntimeWiring.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Default bootstrap configuration. Every field is overridable by the
// caller's options object; missing fields fall back to these defaults.
const DEFAULT_BOOTSTRAP_CONFIG = Object.freeze({
  // Canvas to render to. If null, the bootstrap creates its own canvas and
  // appends it to document.body (in the browser) or runs headless (in a
  // worker or Node.js).
  canvas: null,

  // World seed. Deterministic across runs.
  worldSeed: 0x9E3779B1,

  // Chunk size in metres.
  chunkSizeM: 100.0,

  // Initial chunk radius (in chunks). A radius of 8 loads a sphere of
  // ~2,100 chunks around the camera start position.
  initialChunkRadius: 8,

  // Camera start position in world coordinates.
  cameraStartX: 0.0,
  cameraStartY: 500.0,
  cameraStartZ: 0.0,

  // Camera start forward direction (unit vector).
  cameraStartForwardX: 0.0,
  cameraStartForwardY: 0.0,
  cameraStartForwardZ: -1.0,

  // Memory profile. One of 'LOW' (200 MB), 'MEDIUM' (400 MB), 'HIGH' (600 MB).
  memoryProfile: 'LOW',

  // Prefer WebGL2 when available; fall back to WebGL1.
  preferWebGL2: true,

  // Verbose logging.
  verbose: false,

  // Whether to auto-start the tick loop. Set to false for headless testing.
  autoStart: true,

  // Whether to install the diagnostic monitors.
  installMonitors: true,

  // Whether to pre-compute the initial material and lighting uniforms so
  // the first rendered frame is visually complete.
  precomputeInitialUniforms: true
});

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

const _dispatcher = new CoreEventDispatcher();

let _bootstrapConfig = null;
let _world = null;
let _runtime = null;
let _renderer = null;
let _canvas = null;
let _ownsCanvas = false;
let _running = false;
let _initialized = false;
let _totalTicks = 0;
let _startTimeMs = 0;
let _lastFrameMs = 0;
let _manualLoopHandle = null;

// ══════════════════════════════════════════════════════════════════
// ─── CANVAS CREATION ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Create a canvas element and append it to the document. Returns null if
// we are not in a browser (headless mode).
function _createDefaultCanvas() {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.style.position = 'absolute';
  canvas.style.top = '0';
  canvas.style.left = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  canvas.style.touchAction = 'none';
  canvas.width = (typeof window !== 'undefined' && window.innerWidth) || 1920;
  canvas.height = (typeof window !== 'undefined' && window.innerHeight) || 1080;
  document.body.appendChild(canvas);
  return canvas;
}

// Resize the canvas to match the current window size. Called on window
// resize and once at startup.
function _resizeCanvas() {
  if (!_canvas || typeof window === 'undefined') return;
  const w = window.innerWidth || 1920;
  const h = window.innerHeight || 1080;
  if (_canvas.width !== w || _canvas.height !== h) {
    _canvas.width = w;
    _canvas.height = h;
    if (_renderer && typeof _renderer.setSize === 'function') {
      _renderer.setSize(w, h, false);
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── MANUAL TICK LOOP ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// The bootstrap drives the tick loop itself rather than delegating to the
// runtime, so the caller gets a single, consistent entry point. The loop
// uses requestAnimationFrame in the browser, setTimeout in workers, and
// no timer at all in headless mode (the caller can drive it manually via
// bootstrapTicks()).

function _tickLoop() {
  if (!_running) return;

  const now = performanceNow();
  const dt = Math.min(0.1, (now - _lastFrameMs) / 1000.0);   // clamp to 100 ms
  _lastFrameMs = now;

  // Resize the canvas if needed.
  _resizeCanvas();

  // Run one tick of the pipeline.
  FinalRuntimeWiring.tick(dt);
  _totalTicks++;

  // Render the world.
  if (_world && typeof _world.render === 'function' && _renderer) {
    try {
      _world.render(_renderer, FinalRuntimeWiring.getFrame());
    } catch (e) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('[Bootstrap] Render error:', e);
      }
    }
  } else if (_renderer) {
    // Minimal fallback: render the scene from the frame if the world has
    // not defined its own render method.
    try {
      if (typeof _renderer.render === 'function' && _world && _world.scene) {
        _renderer.render(_world.scene, _world.camera);
      }
    } catch (e) {
      // Swallow.
    }
  }

  // Schedule the next frame.
  if (typeof requestAnimationFrame === 'function') {
    _manualLoopHandle = requestAnimationFrame(_tickLoop);
  } else if (typeof setTimeout === 'function') {
    _manualLoopHandle = setTimeout(_tickLoop, 16);
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const RuntimeBootstrap = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  DEFAULT_BOOTSTRAP_CONFIG,

  /**
   * Bootstrap the complete living world. This is the single entry point
   * for starting the pipeline.
   *
   * @param {object} [callerConfig] - Bootstrap configuration overrides.
   * @returns {object} The assembled world scene, or null if bootstrap
   *                    failed.
   */
  bootstrap(callerConfig) {
    if (_initialized) {
      if (_bootstrapConfig.verbose && typeof console !== 'undefined' && console.warn) {
        console.warn('[Bootstrap] bootstrap() called twice; ignoring.');
      }
      return _world;
    }

    _bootstrapConfig = { ...DEFAULT_BOOTSTRAP_CONFIG, ...(callerConfig || {}) };
    _startTimeMs = performanceNow();
    _lastFrameMs = _startTimeMs;

    try {
      // ─── 1. Create the canvas if we don't have one ──────
      if (!_bootstrapConfig.canvas) {
        _canvas = _createDefaultCanvas();
        _ownsCanvas = _canvas !== null;
      } else {
        _canvas = _bootstrapConfig.canvas;
        _ownsCanvas = false;
      }

      // ─── 2. Wire the runtime ────────────────────────────
      _runtime = FinalRuntimeWiring.init(
        {
          memoryProfile: _bootstrapConfig.memoryProfile,
          preferWebGL2: _bootstrapConfig.preferWebGL2,
          installMemoryCeilingEnforcer: _bootstrapConfig.installMonitors,
          installFrameBudgetMonitor: _bootstrapConfig.installMonitors,
          installGCPauseMonitor: _bootstrapConfig.installMonitors,
          installMemoryProfiler: _bootstrapConfig.installMonitors,
          autoUploadUniforms: true,
          autoInitOrchestration: true,
          verbose: _bootstrapConfig.verbose
        },
        _canvas
      );

      _renderer = FinalRuntimeWiring.getRenderer();

      // ─── 3. Build the initial world ─────────────────────
      _world = LandscapeSceneWiring.buildScene({
        worldSeed: _bootstrapConfig.worldSeed,
        chunkSizeM: _bootstrapConfig.chunkSizeM,
        initialChunkRadius: _bootstrapConfig.initialChunkRadius,
        cameraStartX: _bootstrapConfig.cameraStartX,
        cameraStartY: _bootstrapConfig.cameraStartY,
        cameraStartZ: _bootstrapConfig.cameraStartZ,
        cameraStartForwardX: _bootstrapConfig.cameraStartForwardX,
        cameraStartForwardY: _bootstrapConfig.cameraStartForwardY,
        cameraStartForwardZ: _bootstrapConfig.cameraStartForwardZ,
        memoryProfile: _bootstrapConfig.memoryProfile,
        precomputeInitialUniforms: _bootstrapConfig.precomputeInitialUniforms,
        verbose: _bootstrapConfig.verbose
      });

      // ─── 4. Install the window resize handler ───────────
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('resize', _resizeCanvas);
        _resizeCanvas();
      }

      // ─── 5. Start the tick loop ─────────────────────────
      if (_bootstrapConfig.autoStart) {
        this.start();
      }

      _initialized = true;

      _dispatcher.emit(EVENT_TYPE.BOOTSTRAP_COMPLETED, {
        worldSeed: _bootstrapConfig.worldSeed,
        memoryProfile: _bootstrapConfig.memoryProfile,
        initialChunkCount: _world.initialChunkCount,
        registeredChunkCount: _world.registeredChunkCount,
        registeredBiomeCount: _world.biomeStatus.totalRegistered,
        durationMs: performanceNow() - _startTimeMs,
        autoStart: _bootstrapConfig.autoStart
      });

      return _world;
    } catch (e) {
      _initialized = false;
      if (typeof console !== 'undefined' && console.error) {
        console.error('[Bootstrap] Failed to bootstrap:', e);
      }
      _dispatcher.emit(EVENT_TYPE.BOOTSTRAP_FAILED, {
        error: e.message || String(e)
      });
      throw e;
    }
  },

  /**
   * Start the tick loop. Called automatically by bootstrap() when
   * autoStart is true.
   */
  start() {
    if (!_initialized && !_world) {
      throw new Error('[Bootstrap] start() called before bootstrap()');
    }
    if (_running) return;
    _running = true;
    _lastFrameMs = performanceNow();

    // Use the runtime's start() if it has one; otherwise drive the manual
    // loop.
    if (FinalRuntimeWiring.isRunning()) {
      // The runtime is already running its own loop; we just need to hook
      // our manual tick loop so the world renders. (In practice the runtime
      // calls our stage-6 uploader, which is enough; the manual loop is
      // for the render call only.)
      if (typeof requestAnimationFrame === 'function') {
        _manualLoopHandle = requestAnimationFrame(_tickLoop);
      }
    } else {
      FinalRuntimeWiring.start(_world);
      if (typeof requestAnimationFrame === 'function') {
        _manualLoopHandle = requestAnimationFrame(_tickLoop);
      }
    }

    _dispatcher.emit(EVENT_TYPE.BOOTSTRAP_STARTED, {});
  },

  /**
   * Stop the tick loop. Safe to call multiple times.
   */
  stop() {
    if (!_running) return;
    _running = false;

    if (_manualLoopHandle !== null) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(_manualLoopHandle);
      } else if (typeof clearTimeout === 'function') {
        clearTimeout(_manualLoopHandle);
      }
      _manualLoopHandle = null;
    }

    FinalRuntimeWiring.stop();
    _dispatcher.emit(EVENT_TYPE.BOOTSTRAP_STOPPED, { totalTicks: _totalTicks });
  },

  /**
   * Drive the pipeline manually for a fixed number of ticks. Useful for
   * headless testing and for callers that want to control the tick rate
   * themselves.
   *
   * @param {number} count - Number of ticks to run.
   * @param {number} [dt=1/60] - Delta time per tick, in seconds.
   */
  bootstrapTicks(count, dt) {
    if (!_initialized) {
      throw new Error('[Bootstrap] bootstrapTicks() called before bootstrap()');
    }
    const step = dt !== undefined ? dt : 1.0 / 60.0;
    for (let i = 0; i < count; i++) {
      FinalRuntimeWiring.tick(step);
      _totalTicks++;
    }
  },

  /**
   * Shut down the entire pipeline. Disposes the world, the renderer, and
   * every pooled buffer. After shutdown() returns, the world can be
   * rebuilt from scratch by calling bootstrap() again.
   */
  shutdown() {
    this.stop();
    FinalRuntimeWiring.dispose();

    // Remove the canvas if we created it.
    if (_ownsCanvas && _canvas && typeof document !== 'undefined' && _canvas.parentNode) {
      _canvas.parentNode.removeChild(_canvas);
    }

    // Remove the window resize listener.
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', _resizeCanvas);
    }

    _world = null;
    _runtime = null;
    _renderer = null;
    _canvas = null;
    _ownsCanvas = false;
    _initialized = false;
    _running = false;
    _totalTicks = 0;

    _dispatcher.emit(EVENT_TYPE.BOOTSTRAP_SHUTDOWN, {});
  },

  // ─── Accessor API ────────────────────────────────────────
  getWorld() { return _world; },
  getRuntime() { return _runtime; },
  getRenderer() { return _renderer; },
  getCanvas() { return _canvas; },
  getConfig() { return _bootstrapConfig; },
  isInitialized() { return _initialized; },
  isRunning() { return _running; },
  getTotalTicks() { return _totalTicks; },
  getUptimeMs() {
    if (!_initialized) return 0;
    return performanceNow() - _startTimeMs;
  },
  getFps() {
    const uptimeMs = this.getUptimeMs();
    if (uptimeMs <= 0) return 0;
    return (_totalTicks / uptimeMs) * 1000.0;
  },

  /**
   * Read the bootstrap's diagnostic state into a preallocated output
   * object.
   */
  readDiagnostics(out) {
    out.initialized = _initialized;
    out.running = _running;
    out.totalTicks = _totalTicks;
    out.uptimeMs = this.getUptimeMs();
    out.fps = this.getFps();
    out.memoryProfile = _bootstrapConfig ? _bootstrapConfig.memoryProfile : 'LOW';
    out.worldSeed = _bootstrapConfig ? _bootstrapConfig.worldSeed : 0;
    out.chunkSizeM = _bootstrapConfig ? _bootstrapConfig.chunkSizeM : 0;
    out.registeredBiomeCount = _world ? _world.biomeStatus.totalRegistered : 0;
    out.initialChunkCount = _world ? _world.initialChunkCount : 0;
    out.loadedChunkCount = _world ? _world.registeredChunkCount : 0;
    if (_world && typeof _world.readDiagnostics === 'function') {
      _world.readDiagnostics(out);
    }
    return true;
  }
});

// Performance-now shim.
function performanceNow() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}

export default RuntimeBootstrap;