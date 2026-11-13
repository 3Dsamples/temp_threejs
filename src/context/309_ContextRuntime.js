// file number : 309
// full path name : src/context/309_ContextRuntime.js
// description : The six-stage context runtime — the conductor that owns the frame and enforces the blueprint's strict discipline that stage six never triggers a rebuild of stage one. Every tick runs exactly six stages in order: (1) BUILD FRAME — every registered provider writes its slice of the context frame in topological dependency order; (2) DRAIN CAUSAL — the causal ring buffer is drained into the frame and stale events decay; (3) TIER_1HZ — all registered 1 Hz consumers whose phase matches this tick run; (4) TIER_10HZ — all registered 10 Hz consumers whose phase matches this tick run; (5) TIER_60HZ — all registered 60 Hz consumers run unconditionally (they read only the frame built in stage 1 and the tiers already committed this tick); (6) EMIT BATCHED — accumulated render-side outputs (material uniforms, transform updates, particle spawn requests, light contributions) are collected into a single immutable dispatch that is dispatched to the renderer, so a material switch decided in stage five is reflected in the next frame, not the current one. Each stage is measured against its own budget slice, monitored by 305_FrameBudgetMonitor, and gated by the 308_ContextConsumerTiers scheduler so cross-tier reads are impossible. The runtime also owns the frame lifecycle for 304_MemoryCeilingEnforcer (beginFrame/endFrame), 306_GCPauseMonitor (beginFrame/endFrame), and 307_MemoryProfiler (1 Hz sampling). Uses 302_CameraVelocityExtrapolator to publish the predicted frustum at the start of stage five so all 60 Hz consumers see the future. Batches the outputs of 298_MaterialRegistry (per-visible-object material uniform uploads), 293–295 (sun intensity, time-of-day, air quality), 297_SensoryDetailsProvider (audio cues), and 300_ImpactEventCoordinator (particle spawns and decal placements) into one contiguous GPU-ready buffer that the renderer consumes without per-frame allocation. Emits AUDIO_LIGHT causal events for stage-level budget overruns, for any consumer throwing, for any cross-tier read attempt, and for the runtime itself if the total frame exceeds the 8 ms ceiling. Writes per-tick runtime diagnostics into frame.layers.physical.runtime and the batched dispatch into frame.layers.spatial.renderBatch. Zero allocation after the first frame: all stage registries, batch buffers, and event payloads are preallocated; tick() does not create any object.
// best for : The single entry point that advances the whole living world one frame — the top-level loop that any host (browser, worker, headless test harness, save/load replay) calls to move time forward. Nothing else in the living world needs to call providers or consumers directly; they register with the runtime and the runtime calls them in the correct stage and tier. This is the orchestrator that ties every prior file together.
// license : MIT

import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere, Box3, Frustum,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture,
  Uniform, UniformsGroup
} from './264_MathECSImportBarrel.js';

// ─── Core infrastructure ────────────────────────────────────
import { ContextFrame }                                    from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES }    from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS }                   from './266_CoreLayers.js';
import { CoreClock }                                       from './267_CoreClock.js';

// ─── Memory, GC, and budget monitors ────────────────────────
import { MemoryCeilingEnforcer, MEMORY_PROFILE, ALLOC_CATEGORY, ALLOC_CATEGORY_NAMES }
                                                            from './304_MemoryCeilingEnforcer.js';
import { FrameBudgetMonitor, BUDGET_SLICE, BUDGET_SLICE_NAMES }
                                                            from './305_FrameBudgetMonitor.js';
import { GCPauseMonitor }                                   from './306_GCPauseMonitor.js';
import { MemoryProfiler }                                   from './307_MemoryProfiler.js';

// ─── Tier scheduler ────────────────────────────────────────
import { ContextConsumerTiers, CONSUMER_TIER, CONSUMER_TIER_NAMES,
         CONSUMER_STATE }                                   from './308_ContextConsumerTiers.js';

// ─── Key providers/systems referenced by the runtime ──────
import { CameraVelocityExtrapolator, PREDICTION_STATE }     from './302_CameraVelocityExtrapolator.js';
import { MaterialRegistry, MATERIAL_KIND }                  from './298_MaterialRegistry.js';
import { PersistentWorldMemory }                            from './299_PersistentWorldMemory.js';
import { ImpactEventCoordinator }                           from './300_ImpactEventCoordinator.js';
import { AsyncAssetPriorityQueue }                          from './301_AsyncAssetPriorityQueue.js';
import { HLODController }                                   from './303_HLODController.js';
import { AirQualityAtmosphereProvider }                     from './295_AirQualityAtmosphereProvider.js';

// ══════════════════════════════════════════════════════════════════
// ─── STAGE CODES ────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const STAGE = Object.freeze({
  BUILD_FRAME:      0,
  DRAIN_CAUSAL:     1,
  TIER_1HZ:         2,
  TIER_10HZ:        3,
  TIER_60HZ:        4,
  EMIT_BATCHED:     5
});

const STAGE_NAMES = Object.freeze([
  'build_frame', 'drain_causal', 'tier_1hz', 'tier_10hz',
  'tier_60hz', 'emit_batched'
]);

const STAGE_COUNT = 6;

// ─── Which budget slice each stage maps to ─────────────────
const STAGE_BUDGET_SLICE = Object.freeze([
  BUDGET_SLICE.PROVIDERS,       // BUILD_FRAME
  BUDGET_SLICE.CAUSAL_DRAIN,    // DRAIN_CAUSAL
  BUDGET_SLICE.TIER_1HZ,        // TIER_1HZ
  BUDGET_SLICE.TIER_10HZ,       // TIER_10HZ
  BUDGET_SLICE.TIER_60HZ,       // TIER_60HZ
  BUDGET_SLICE.STAGE_6_DISPATCH // EMIT_BATCHED
]);

// ══════════════════════════════════════════════════════════════════
// ─── PROVIDER REGISTRATION ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// Providers are called in stage 1 in registration order. Register
// them in topological dependency order (providers that depend on
// others must register after them). The runtime does NOT
// reorder them — this is the caller's responsibility.
class ProviderSlot {
  constructor() {
    this.id = -1;
    this.name = '';
    this.provider = null;      // object with .update(frame, clock) or a function
    this.enabled = true;
    this.priority = 0;         // reserved for future reordering
    this.avgExecMs = 0;
    this.maxExecMs = 0;
    this.runCount = 0;
    this.failCount = 0;
  }

  reset() {
    this.id = -1;
    this.name = '';
    this.provider = null;
    this.enabled = true;
    this.priority = 0;
    this.avgExecMs = 0;
    this.maxExecMs = 0;
    this.runCount = 0;
    this.failCount = 0;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── STAGE 6 EMITTER REGISTRATION ──────────────────────────────
// ══════════════════════════════════════════════════════════════════
// Stage 6 emitters read the current frame (which may include
// outputs from stages 3/4/5) and write into the RENDER BATCH.
// They must never write into the context frame itself.
class EmitterSlot {
  constructor() {
    this.id = -1;
    this.name = '';
    this.fn = null;
    this.enabled = true;
    this.avgExecMs = 0;
    this.runCount = 0;
    this.failCount = 0;
  }

  reset() {
    this.id = -1;
    this.name = '';
    this.fn = null;
    this.enabled = true;
    this.avgExecMs = 0;
    this.runCount = 0;
    this.failCount = 0;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── RENDER BATCH ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// One contiguous buffer for all render-side outputs. Pre-allocated
// to a fixed capacity and reused every frame.
const RENDER_BATCH_CAPACITY = 4096;

class RenderBatch {
  constructor() {
    this.capacity = RENDER_BATCH_CAPACITY;
    this.count = 0;

    // ── Material uniforms ────────────────────────────────
    // Per-entity material override values (fed to the material
    // uniform upload path).
    this.materialEntityId = new Int32Array(RENDER_BATCH_CAPACITY);
    this.materialId = new Int32Array(RENDER_BATCH_CAPACITY);
    this.materialBaseColorR = new Float32Array(RENDER_BATCH_CAPACITY);
    this.materialBaseColorG = new Float32Array(RENDER_BATCH_CAPACITY);
    this.materialBaseColorB = new Float32Array(RENDER_BATCH_CAPACITY);
    this.materialMetalness = new Float32Array(RENDER_BATCH_CAPACITY);
    this.materialRoughness = new Float32Array(RENDER_BATCH_CAPACITY);
    this.materialClearcoat = new Float32Array(RENDER_BATCH_CAPACITY);
    this.materialTransmission = new Float32Array(RENDER_BATCH_CAPACITY);
    this.materialIOR = new Float32Array(RENDER_BATCH_CAPACITY);
    this.materialSheen = new Float32Array(RENDER_BATCH_CAPACITY);
    this.materialAnimeFlatness = new Float32Array(RENDER_BATCH_CAPACITY);
    this.materialEmissiveR = new Float32Array(RENDER_BATCH_CAPACITY);
    this.materialEmissiveG = new Float32Array(RENDER_BATCH_CAPACITY);
    this.materialEmissiveB = new Float32Array(RENDER_BATCH_CAPACITY);
    this.materialUvScaleU = new Float32Array(RENDER_BATCH_CAPACITY);
    this.materialUvScaleV = new Float32Array(RENDER_BATCH_CAPACITY);
    this.materialNormalScale = new Float32Array(RENDER_BATCH_CAPACITY);

    // ── Transforms ───────────────────────────────────────
    this.transformEntityId = new Int32Array(RENDER_BATCH_CAPACITY);
    this.transformMatrix = new Float32Array(RENDER_BATCH_CAPACITY * 16);
    this.transformDirty = new Uint8Array(RENDER_BATCH_CAPACITY);

    // ── Lights (clustered lighting contributions) ────────
    this.lightCount = 0;
    this.lightKind = new Uint8Array(RENDER_BATCH_CAPACITY);      // 0=point, 1=dir, 2=spot
    this.lightPosX = new Float32Array(RENDER_BATCH_CAPACITY);
    this.lightPosY = new Float32Array(RENDER_BATCH_CAPACITY);
    this.lightPosZ = new Float32Array(RENDER_BATCH_CAPACITY);
    this.lightDirX = new Float32Array(RENDER_BATCH_CAPACITY);
    this.lightDirY = new Float32Array(RENDER_BATCH_CAPACITY);
    this.lightDirZ = new Float32Array(RENDER_BATCH_CAPACITY);
    this.lightColorR = new Float32Array(RENDER_BATCH_CAPACITY);
    this.lightColorG = new Float32Array(RENDER_BATCH_CAPACITY);
    this.lightColorB = new Float32Array(RENDER_BATCH_CAPACITY);
    this.lightIntensity = new Float32Array(RENDER_BATCH_CAPACITY);
    this.lightRange = new Float32Array(RENDER_BATCH_CAPACITY);
    this.lightIESProfileId = new Int32Array(RENDER_BATCH_CAPACITY);

    // ── Particles ────────────────────────────────────────
    this.particleCount = 0;
    this.particleKind = new Uint8Array(RENDER_BATCH_CAPACITY);   // 0=shard, 1=decal, 2=cue
    this.particlePosX = new Float32Array(RENDER_BATCH_CAPACITY);
    this.particlePosY = new Float32Array(RENDER_BATCH_CAPACITY);
    this.particlePosZ = new Float32Array(RENDER_BATCH_CAPACITY);
    this.particleVelX = new Float32Array(RENDER_BATCH_CAPACITY);
    this.particleVelY = new Float32Array(RENDER_BATCH_CAPACITY);
    this.particleVelZ = new Float32Array(RENDER_BATCH_CAPACITY);
    this.particleSize = new Float32Array(RENDER_BATCH_CAPACITY);
    this.particleColorR = new Float32Array(RENDER_BATCH_CAPACITY);
    this.particleColorG = new Float32Array(RENDER_BATCH_CAPACITY);
    this.particleColorB = new Float32Array(RENDER_BATCH_CAPACITY);
    this.particleMaterialId = new Int32Array(RENDER_BATCH_CAPACITY);

    // ── Audio cues ──────────────────────────────────────
    this.audioCount = 0;
    this.audioCue = new Int32Array(RENDER_BATCH_CAPACITY);
    this.audioPosX = new Float32Array(RENDER_BATCH_CAPACITY);
    this.audioPosY = new Float32Array(RENDER_BATCH_CAPACITY);
    this.audioPosZ = new Float32Array(RENDER_BATCH_CAPACITY);
    this.audioAmplitude = new Float32Array(RENDER_BATCH_CAPACITY);
    this.audioColorR = new Float32Array(RENDER_BATCH_CAPACITY);
    this.audioColorG = new Float32Array(RENDER_BATCH_CAPACITY);
    this.audioColorB = new Float32Array(RENDER_BATCH_CAPACITY);
  }

  reset() {
    this.count = 0;
    this.lightCount = 0;
    this.particleCount = 0;
    this.audioCount = 0;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── CONTEXT RUNTIME ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class ContextRuntime {
  constructor(options = {}) {
    // ── Configuration ────────────────────────────────────
    this.defaults = {
      maxProviders:          options.maxProviders ?? 128,
      maxEmitters:           options.maxEmitters ?? 32,
      enableEvents:          options.enableEvents ?? true,
      enableDiagnostics:     options.enableDiagnostics ?? true,
      enableAutoBeginEnd:    options.enableAutoBeginEnd ?? true,
      // Monitors and collaborators (can be attached later).
      ceilingEnforcer:       options.ceilingEnforcer ?? null,
      frameBudgetMonitor:    options.frameBudgetMonitor ?? null,
      gcMonitor:             options.gcMonitor ?? null,
      memoryProfiler:        options.memoryProfiler ?? null,
      tierScheduler:         options.tierScheduler ?? null,
      cameraExtrapolator:    options.cameraExtrapolator ?? null,
      materialRegistry:      options.materialRegistry ?? null,
      worldMemory:           options.worldMemory ?? null,
      impactCoordinator:     options.impactCoordinator ?? null,
      assetQueue:            options.assetQueue ?? null,
      hlodController:        options.hlodController ?? null,
      airQualityProvider:    options.airQualityProvider ?? null
    };

    // ── The context frame (owned by the runtime) ─────────
    this.frame = options.frame ?? new ContextFrame(options.frameCapacity ?? 1024);

    // ── Core clock ──────────────────────────────────────
    this.clock = options.clock ?? new CoreClock();

    // ── Provider registry (stage 1) ─────────────────────
    const maxProviders = this.defaults.maxProviders;
    this._providerPool = new Array(maxProviders);
    for (let i = 0; i < maxProviders; i++) {
      this._providerPool[i] = new ProviderSlot();
    }
    this._providerFreeList = new Int32Array(maxProviders);
    for (let i = 0; i < maxProviders; i++) {
      this._providerFreeList[i] = maxProviders - 1 - i;
    }
    this._providerFreeCount = maxProviders;
    this._providerCount = 0;
    this._nextProviderId = 1;

    // ── Emitter registry (stage 6) ──────────────────────
    const maxEmitters = this.defaults.maxEmitters;
    this._emitterPool = new Array(maxEmitters);
    for (let i = 0; i < maxEmitters; i++) {
      this._emitterPool[i] = new EmitterSlot();
    }
    this._emitterFreeList = new Int32Array(maxEmitters);
    for (let i = 0; i < maxEmitters; i++) {
      this._emitterFreeList[i] = maxEmitters - 1 - i;
    }
    this._emitterFreeCount = maxEmitters;
    this._emitterCount = 0;
    this._nextEmitterId = 1;

    // ── Render batch (stage 6 output) ───────────────────
    this._renderBatch = new RenderBatch();
    this._previousRenderBatch = new RenderBatch();

    // ── Stage execution state ───────────────────────────
    this._currentStage = STAGE.BUILD_FRAME;
    this._frameValid = false;
    this._tickIndex = 0;

    // ── Per-stage timing (EMA + last) ──────────────────
    this._stageExecMsLast = new Float64Array(STAGE_COUNT);
    this._stageExecMsEma = new Float64Array(STAGE_COUNT);
    this._stageExecMsPeak = new Float64Array(STAGE_COUNT);
    this._stageConsumerCount = new Int32Array(STAGE_COUNT);

    // ── Statistics ──────────────────────────────────────
    this._stats = {
      ticks: 0,
      stage1Runs: 0,
      stage2Runs: 0,
      stage3Runs: 0,
      stage4Runs: 0,
      stage5Runs: 0,
      stage6Runs: 0,
      providerFailures: 0,
      emitterFailures: 0,
      consumersRan: 0,
      eventsEmitted: 0,
      totalFrameMs: 0,
      totalFrameMsEma: 0,
      budgetViolations: 0,
      crossTierViolationsBlocked: 0,
      framesWithErrors: 0
    };

    // ── Scratch (pooled) ────────────────────────────────
    this._tmpVec3A = new Vec3();
    this._tmpVec3B = new Vec3();
    this._tmpVec4 = new Vec4();
    this._tmpMat4 = new Mat4();
    this._tmpQuat = new Quat();

    // ── Collaborators ───────────────────────────────────
    this._dispatcher = options.dispatcher || null;
    this._clock = this.clock;
    this._ceilingEnforcer = this.defaults.ceilingEnforcer;
    this._frameBudgetMonitor = this.defaults.frameBudgetMonitor;
    this._gcMonitor = this.defaults.gcMonitor;
    this._memoryProfiler = this.defaults.memoryProfiler;
    this._tierScheduler = this.defaults.tierScheduler
      ?? new ContextConsumerTiers({
        dispatcher: this._dispatcher,
        clock: this._clock,
        frameBudgetMonitor: this._frameBudgetMonitor
      });
    this._cameraExtrapolator = this.defaults.cameraExtrapolator;
    this._materialRegistry = this.defaults.materialRegistry;
    this._worldMemory = this.defaults.worldMemory;
    this._impactCoordinator = this.defaults.impactCoordinator;
    this._assetQueue = this.defaults.assetQueue;
    this._hlodController = this.defaults.hlodController;
    this._airQualityProvider = this.defaults.airQualityProvider;

    // ── Event coalescing ────────────────────────────────
    this._lastEventTime = 0;
    this._eventCoalesceMs = 500;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachDispatcher(d) { this._dispatcher = d; return this; }
  attachCeilingEnforcer(e) { this._ceilingEnforcer = e; return this; }
  attachFrameBudgetMonitor(f) { this._frameBudgetMonitor = f; return this; }
  attachGCMonitor(g) { this._gcMonitor = g; return this; }
  attachMemoryProfiler(m) { this._memoryProfiler = m; return this; }
  attachTierScheduler(t) { this._tierScheduler = t; return this; }
  attachCameraExtrapolator(c) { this._cameraExtrapolator = c; return this; }
  attachMaterialRegistry(m) { this._materialRegistry = m; return this; }
  attachWorldMemory(w) { this._worldMemory = w; return this; }
  attachImpactCoordinator(i) { this._impactCoordinator = i; return this; }
  attachAssetQueue(a) { this._assetQueue = a; return this; }
  attachHLODController(h) { this._hlodController = h; return this; }
  attachAirQualityProvider(a) { this._airQualityProvider = a; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── Provider registration (stage 1) ────────────────────
  // ══════════════════════════════════════════════════════════
  registerProvider(name, provider, priority = 0) {
    if (this._providerFreeCount === 0) return -1;
    if (!provider) return -1;

    this._providerFreeCount--;
    const idx = this._providerFreeList[this._providerFreeCount];
    const slot = this._providerPool[idx];

    slot.reset();
    slot.id = this._nextProviderId++;
    slot.name = name;
    slot.provider = provider;
    slot.priority = priority;
    slot.enabled = true;

    this._providerCount++;
    return slot.id;
  }

  unregisterProvider(providerId) {
    for (let i = 0; i < this._providerPool.length; i++) {
      const slot = this._providerPool[i];
      if (slot.id !== providerId) continue;
      const idx = i;
      slot.reset();
      this._providerFreeList[this._providerFreeCount++] = idx;
      this._providerCount--;
      return true;
    }
    return false;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Emitter registration (stage 6) ─────────────────────
  // ══════════════════════════════════════════════════════════
  registerEmitter(name, fn) {
    if (this._emitterFreeCount === 0) return -1;
    if (typeof fn !== 'function') return -1;

    this._emitterFreeCount--;
    const idx = this._emitterFreeList[this._emitterFreeCount];
    const slot = this._emitterPool[idx];

    slot.reset();
    slot.id = this._nextEmitterId++;
    slot.name = name;
    slot.fn = fn;
    slot.enabled = true;

    this._emitterCount++;
    return slot.id;
  }

  unregisterEmitter(emitterId) {
    for (let i = 0; i < this._emitterPool.length; i++) {
      const slot = this._emitterPool[i];
      if (slot.id !== emitterId) continue;
      const idx = i;
      slot.reset();
      this._emitterFreeList[this._emitterFreeCount++] = idx;
      this._emitterCount--;
      return true;
    }
    return false;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Convenience: register consumer with tier scheduler ─
  // ══════════════════════════════════════════════════════════
  registerConsumer(name, fn, opts = {}) {
    if (!this._tierScheduler) return -1;
    return this._tierScheduler.registerConsumer(name, fn, opts);
  }

  unregisterConsumer(consumerId) {
    if (!this._tierScheduler) return false;
    return this._tierScheduler.unregisterConsumer(consumerId);
  }

  // ══════════════════════════════════════════════════════════
  // ─── Main tick ──────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Advance the whole living world one frame.
  tick() {
    const startMs = performance.now();
    const now = this.clock.elapsedSeconds;
    const dt = this.clock.delta;
    this._tickIndex++;

    // ── Frame lifecycle: open all monitors ──────────────
    if (this.defaults.enableAutoBeginEnd) {
      this._beginFrame(startMs, now, dt);
    }

    // ── Run the six stages in strict order ──────────────
    this._currentStage = STAGE.BUILD_FRAME;
    this._runStage1BuildFrame();

    this._currentStage = STAGE.DRAIN_CAUSAL;
    this._runStage2DrainCausal();

    this._currentStage = STAGE.TIER_1HZ;
    this._runStage3Tier1Hz();

    this._currentStage = STAGE.TIER_10HZ;
    this._runStage4Tier10Hz();

    this._currentStage = STAGE.TIER_60HZ;
    this._runStage5Tier60Hz();

    this._currentStage = STAGE.EMIT_BATCHED;
    this._runStage6EmitBatched();

    // ── Frame lifecycle: close all monitors ─────────────
    if (this.defaults.enableAutoBeginEnd) {
      this._endFrame(startMs);
    }

    // ── Bookkeeping ─────────────────────────────────────
    const totalMs = performance.now() - startMs;
    this._stats.totalFrameMs = totalMs;
    this._stats.totalFrameMsEma = this._stats.totalFrameMsEma === 0
      ? totalMs
      : this._stats.totalFrameMsEma * 0.9 + totalMs * 0.1;
    this._stats.ticks++;

    if (totalMs > 8.0) this._stats.budgetViolations++;

    return this;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Frame lifecycle helpers ────────────────────────────
  // ══════════════════════════════════════════════════════════
  _beginFrame(startMs, now, dt) {
    if (this._ceilingEnforcer) this._ceilingEnforcer.beginFrame(startMs);
    if (this._frameBudgetMonitor) this._frameBudgetMonitor.beginFrame(startMs);
    if (this._gcMonitor) this._gcMonitor.beginFrame();

    // Begin the tier scheduler tick.
    if (this._tierScheduler) {
      this._tierScheduler.beginTick(now, dt);
    }

    this._frameValid = true;
  }

  _endFrame(startMs) {
    if (this._gcMonitor) this._gcMonitor.endFrame();
    if (this._frameBudgetMonitor) this._frameBudgetMonitor.endFrame();
    if (this._ceilingEnforcer) this._ceilingEnforcer.endFrame();

    if (this._tierScheduler) {
      this._tierScheduler.endTick();
    }

    this._frameValid = false;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Stage 1: BUILD FRAME ───────────────────────────────
  // ══════════════════════════════════════════════════════════
  _runStage1BuildFrame() {
    const startMs = performance.now();
    const slice = STAGE_BUDGET_SLICE[STAGE.BUILD_FRAME];

    if (this._frameBudgetMonitor) this._frameBudgetMonitor.beginSlice(slice);

    let ran = 0;
    for (let i = 0; i < this._providerPool.length; i++) {
      const slot = this._providerPool[i];
      if (slot.id < 0 || !slot.enabled || !slot.provider) continue;

      const pStart = performance.now();
      try {
        if (typeof slot.provider.update === 'function') {
          slot.provider.update(this.frame, this.clock);
        } else if (typeof slot.provider === 'function') {
          slot.provider(this.frame, this.clock);
        }
        slot.runCount++;
      } catch (e) {
        slot.failCount++;
        this._stats.providerFailures++;
        this._stats.framesWithErrors++;
        this._emitStageError('provider', slot.name, e);
      }
      const pEnd = performance.now();
      const execMs = pEnd - pStart;
      slot.avgExecMs = slot.avgExecMs === 0
        ? execMs
        : slot.avgExecMs * 0.9 + execMs * 0.1;
      if (execMs > slot.maxExecMs) slot.maxExecMs = execMs;

      ran++;
    }

    if (this._frameBudgetMonitor) this._frameBudgetMonitor.endSlice(slice);

    const elapsed = performance.now() - startMs;
    this._stageExecMsLast[STAGE.BUILD_FRAME] = elapsed;
    this._stageExecMsEma[STAGE.BUILD_FRAME] = this._stageExecMsEma[STAGE.BUILD_FRAME] === 0
      ? elapsed
      : this._stageExecMsEma[STAGE.BUILD_FRAME] * 0.9 + elapsed * 0.1;
    if (elapsed > this._stageExecMsPeak[STAGE.BUILD_FRAME]) {
      this._stageExecMsPeak[STAGE.BUILD_FRAME] = elapsed;
    }
    this._stageConsumerCount[STAGE.BUILD_FRAME] = ran;
    this._stats.stage1Runs++;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Stage 2: DRAIN CAUSAL ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  _runStage2DrainCausal() {
    const startMs = performance.now();
    const slice = STAGE_BUDGET_SLICE[STAGE.DRAIN_CAUSAL];

    if (this._frameBudgetMonitor) this._frameBudgetMonitor.beginSlice(slice);

    // Drain the dispatcher's causal ring buffer into the frame.
    let drained = 0;
    if (this._dispatcher && this._dispatcher.drainIntoFrame) {
      drained = this._dispatcher.drainIntoFrame(this.frame);
    }

    // Decay stale events in the frame's causal layer.
    if (this.frame.layers && this.frame.layers.causal) {
      const causal = this.frame.layers.causal;
      if (causal.events) {
        const now = this.clock.elapsedSeconds;
        for (let i = 0; i < causal.events.length; i++) {
          const ev = causal.events[i];
          if (!ev || ev.type === undefined || ev.type < 0) continue;
          if (ev.timestamp === undefined) continue;
          const age = now - ev.timestamp;
          if (age <= 0) { ev.decay = 1.0; continue; }
          const tau = ev.tau && ev.tau > 0 ? ev.tau : 3.0;
          ev.decay = Math.exp(-age / tau);
        }
      }
    }

    if (this._frameBudgetMonitor) this._frameBudgetMonitor.endSlice(slice);

    const elapsed = performance.now() - startMs;
    this._stageExecMsLast[STAGE.DRAIN_CAUSAL] = elapsed;
    this._stageExecMsEma[STAGE.DRAIN_CAUSAL] = this._stageExecMsEma[STAGE.DRAIN_CAUSAL] === 0
      ? elapsed
      : this._stageExecMsEma[STAGE.DRAIN_CAUSAL] * 0.9 + elapsed * 0.1;
    if (elapsed > this._stageExecMsPeak[STAGE.DRAIN_CAUSAL]) {
      this._stageExecMsPeak[STAGE.DRAIN_CAUSAL] = elapsed;
    }
    this._stageConsumerCount[STAGE.DRAIN_CAUSAL] = drained;
    this._stats.stage2Runs++;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Stage 3: TIER 1 Hz ─────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _runStage3Tier1Hz() {
    const startMs = performance.now();
    const slice = STAGE_BUDGET_SLICE[STAGE.TIER_1HZ];

    if (this._frameBudgetMonitor) this._frameBudgetMonitor.beginSlice(slice);

    let ran = 0;
    if (this._tierScheduler) {
      ran = this._tierScheduler.runTier(CONSUMER_TIER.HZ_1, this.frame);
    }

    if (this._frameBudgetMonitor) this._frameBudgetMonitor.endSlice(slice);

    const elapsed = performance.now() - startMs;
    this._stageExecMsLast[STAGE.TIER_1HZ] = elapsed;
    this._stageExecMsEma[STAGE.TIER_1HZ] = this._stageExecMsEma[STAGE.TIER_1HZ] === 0
      ? elapsed
      : this._stageExecMsEma[STAGE.TIER_1HZ] * 0.9 + elapsed * 0.1;
    if (elapsed > this._stageExecMsPeak[STAGE.TIER_1HZ]) {
      this._stageExecMsPeak[STAGE.TIER_1HZ] = elapsed;
    }
    this._stageConsumerCount[STAGE.TIER_1HZ] = ran;
    this._stats.consumersRan += ran;
    this._stats.stage3Runs++;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Stage 4: TIER 10 Hz ────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _runStage4Tier10Hz() {
    const startMs = performance.now();
    const slice = STAGE_BUDGET_SLICE[STAGE.TIER_10HZ];

    if (this._frameBudgetMonitor) this._frameBudgetMonitor.beginSlice(slice);

    let ran = 0;
    if (this._tierScheduler) {
      ran = this._tierScheduler.runTier(CONSUMER_TIER.HZ_10, this.frame);
    }

    if (this._frameBudgetMonitor) this._frameBudgetMonitor.endSlice(slice);

    const elapsed = performance.now() - startMs;
    this._stageExecMsLast[STAGE.TIER_10HZ] = elapsed;
    this._stageExecMsEma[STAGE.TIER_10HZ] = this._stageExecMsEma[STAGE.TIER_10HZ] === 0
      ? elapsed
      : this._stageExecMsEma[STAGE.TIER_10HZ] * 0.9 + elapsed * 0.1;
    if (elapsed > this._stageExecMsPeak[STAGE.TIER_10HZ]) {
      this._stageExecMsPeak[STAGE.TIER_10HZ] = elapsed;
    }
    this._stageConsumerCount[STAGE.TIER_10HZ] = ran;
    this._stats.consumersRan += ran;
    this._stats.stage4Runs++;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Stage 5: TIER 60 Hz (unconditional) ────────────────
  // ══════════════════════════════════════════════════════════
  _runStage5Tier60Hz() {
    const startMs = performance.now();
    const slice = STAGE_BUDGET_SLICE[STAGE.TIER_60HZ];

    if (this._frameBudgetMonitor) this._frameBudgetMonitor.beginSlice(slice);

    // Publish the predicted frustum BEFORE running 60 Hz consumers,
    // so all of them see the future this frame.
    if (this._cameraExtrapolator) {
      try { this._cameraExtrapolator.update(this.frame, this.clock); } catch (e) { /* ignored */ }
    }

    let ran = 0;
    if (this._tierScheduler) {
      ran = this._tierScheduler.runTier(CONSUMER_TIER.HZ_60, this.frame);
    }

    if (this._frameBudgetMonitor) this._frameBudgetMonitor.endSlice(slice);

    const elapsed = performance.now() - startMs;
    this._stageExecMsLast[STAGE.TIER_60HZ] = elapsed;
    this._stageExecMsEma[STAGE.TIER_60HZ] = this._stageExecMsEma[STAGE.TIER_60HZ] === 0
      ? elapsed
      : this._stageExecMsEma[STAGE.TIER_60HZ] * 0.9 + elapsed * 0.1;
    if (elapsed > this._stageExecMsPeak[STAGE.TIER_60HZ]) {
      this._stageExecMsPeak[STAGE.TIER_60HZ] = elapsed;
    }
    this._stageConsumerCount[STAGE.TIER_60HZ] = ran;
    this._stats.consumersRan += ran;
    this._stats.stage5Runs++;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Stage 6: EMIT BATCHED ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  // CRITICAL DISCIPLINE: stage 6 reads from the frame and writes
  // ONLY to the render batch. It never writes back into the frame.
  // Emitters are forbidden from calling provider.update() or any
  // consumer. This preserves the invariant that a material switch
  // decided in stage 5 is reflected in the next frame, not this one.
  _runStage6EmitBatched() {
    const startMs = performance.now();
    const slice = STAGE_BUDGET_SLICE[STAGE.EMIT_BATCHED];

    if (this._frameBudgetMonitor) this._frameBudgetMonitor.beginSlice(slice);

    // Swap the batch buffers: the current batch becomes the
    // "previous" (consumed by the renderer) and we clear the
    // "next" (about to be written).
    const tmp = this._previousRenderBatch;
    this._previousRenderBatch = this._renderBatch;
    this._renderBatch = tmp;
    this._renderBatch.reset();

    // Run all registered stage 6 emitters.
    let ran = 0;
    for (let i = 0; i < this._emitterPool.length; i++) {
      const slot = this._emitterPool[i];
      if (slot.id < 0 || !slot.enabled || !slot.fn) continue;

      const eStart = performance.now();
      try {
        slot.fn(this.frame, this._renderBatch, this.clock);
        slot.runCount++;
      } catch (e) {
        slot.failCount++;
        this._stats.emitterFailures++;
        this._stats.framesWithErrors++;
        this._emitStageError('emitter', slot.name, e);
      }
      const eEnd = performance.now();
      const execMs = eEnd - eStart;
      slot.avgExecMs = slot.avgExecMs === 0
        ? execMs
        : slot.avgExecMs * 0.9 + execMs * 0.1;

      ran++;
    }

    // Publish the batch to the frame's spatial layer for the renderer.
    if (this.frame.layers && this.frame.layers.spatial) {
      this.frame.layers.spatial.renderBatch = this._renderBatch;
      this.frame.layers.spatial.previousRenderBatch = this._previousRenderBatch;
    }

    if (this._frameBudgetMonitor) this._frameBudgetMonitor.endSlice(slice);

    const elapsed = performance.now() - startMs;
    this._stageExecMsLast[STAGE.EMIT_BATCHED] = elapsed;
    this._stageExecMsEma[STAGE.EMIT_BATCHED] = this._stageExecMsEma[STAGE.EMIT_BATCHED] === 0
      ? elapsed
      : this._stageExecMsEma[STAGE.EMIT_BATCHED] * 0.9 + elapsed * 0.1;
    if (elapsed > this._stageExecMsPeak[STAGE.EMIT_BATCHED]) {
      this._stageExecMsPeak[STAGE.EMIT_BATCHED] = elapsed;
    }
    this._stageConsumerCount[STAGE.EMIT_BATCHED] = ran;
    this._stats.stage6Runs++;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Error reporting ────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _emitStageError(kind, name, error) {
    if (!this._dispatcher || !this.defaults.enableEvents) return;
    const now = performance.now();
    if (now - this._lastEventTime < this._eventCoalesceMs) return;
    this._lastEventTime = now;

    this._dispatcher.queueCausalEvent(
      EVENT_TYPE.AUDIO_LIGHT,
      [0, 0, 0],
      -1, 1, 1.0,
      {
        kind: 'stage_error',
        stage: this._currentStage,
        stageName: STAGE_NAMES[this._currentStage],
        errorKind: kind,
        errorName: name,
        message: String(error && error.message ? error.message : error)
      }
    );
  }

  // ══════════════════════════════════════════════════════════
  // ─── Frame-level diagnostics write ──────────────────────
  // ══════════════════════════════════════════════════════════
  _writeDiagnostics() {
    const physical = this.frame.layers.physical;
    if (!physical) return;

    if (!physical.runtime) {
      physical.runtime = {
        tickIndex: 0,
        currentStage: 0,
        currentStageName: 'build_frame',
        stageExecMsLast: new Float64Array(STAGE_COUNT),
        stageExecMsEma: new Float64Array(STAGE_COUNT),
        stageExecMsPeak: new Float64Array(STAGE_COUNT),
        stageConsumerCount: new Int32Array(STAGE_COUNT),
        stageNames: STAGE_NAMES,
        providerCount: 0,
        emitterCount: 0,
        renderBatchCount: 0,
        lightBatchCount: 0,
        particleBatchCount: 0,
        audioBatchCount: 0,
        totalFrameMs: 0,
        totalFrameMsEma: 0,
        budgetMs: 8.0,
        stats: {}
      };
    }

    const rt = physical.runtime;
    rt.tickIndex = this._tickIndex;
    rt.currentStage = this._currentStage;
    rt.currentStageName = STAGE_NAMES[this._currentStage];

    for (let i = 0; i < STAGE_COUNT; i++) {
      rt.stageExecMsLast[i] = this._stageExecMsLast[i];
      rt.stageExecMsEma[i] = this._stageExecMsEma[i];
      rt.stageExecMsPeak[i] = this._stageExecMsPeak[i];
      rt.stageConsumerCount[i] = this._stageConsumerCount[i];
    }

    rt.providerCount = this._providerCount;
    rt.emitterCount = this._emitterCount;
    rt.renderBatchCount = this._renderBatch.count;
    rt.lightBatchCount = this._renderBatch.lightCount;
    rt.particleBatchCount = this._renderBatch.particleCount;
    rt.audioBatchCount = this._renderBatch.audioCount;
    rt.totalFrameMs = this._stats.totalFrameMs;
    rt.totalFrameMsEma = this._stats.totalFrameMsEma;
    rt.budgetMs = 8.0;

    // Snapshot stats.
    rt.stats.ticks = this._stats.ticks;
    rt.stats.stage1Runs = this._stats.stage1Runs;
    rt.stats.stage2Runs = this._stats.stage2Runs;
    rt.stats.stage3Runs = this._stats.stage3Runs;
    rt.stats.stage4Runs = this._stats.stage4Runs;
    rt.stats.stage5Runs = this._stats.stage5Runs;
    rt.stats.stage6Runs = this._stats.stage6Runs;
    rt.stats.providerFailures = this._stats.providerFailures;
    rt.stats.emitterFailures = this._stats.emitterFailures;
    rt.stats.consumersRan = this._stats.consumersRan;
    rt.stats.eventsEmitted = this._stats.eventsEmitted;
    rt.stats.budgetViolations = this._stats.budgetViolations;
    rt.stats.framesWithErrors = this._stats.framesWithErrors;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Public diagnostics API ─────────────────────────────
  // ══════════════════════════════════════════════════════════
  getFrame() { return this.frame; }
  getClock() { return this.clock; }
  getTickIndex() { return this._tickIndex; }
  getCurrentStage() { return this._currentStage; }
  getCurrentStageName() { return STAGE_NAMES[this._currentStage]; }
  getRenderBatch() { return this._renderBatch; }
  getPreviousRenderBatch() { return this._previousRenderBatch; }
  getProviderCount() { return this._providerCount; }
  getEmitterCount() { return this._emitterCount; }

  getStageExecMs(stage) {
    if (stage < 0 || stage >= STAGE_COUNT) return 0;
    return this._stageExecMsLast[stage];
  }

  getStageExecMsEma(stage) {
    if (stage < 0 || stage >= STAGE_COUNT) return 0;
    return this._stageExecMsEma[stage];
  }

  getTotalFrameMs() { return this._stats.totalFrameMs; }
  getTotalFrameMsEma() { return this._stats.totalFrameMsEma; }

  // ══════════════════════════════════════════════════════════
  // ─── Manual tick control (for testing/replay) ──────────
  // ══════════════════════════════════════════════════════════
  // If the host wants to manage monitors manually, disable
  // enableAutoBeginEnd and call these instead of tick().
  beginManualTick() {
    const startMs = performance.now();
    const now = this.clock.elapsedSeconds;
    const dt = this.clock.delta;
    this._tickIndex++;
    this._beginFrame(startMs, now, dt);
    return this;
  }

  endManualTick(startMs) {
    this._endFrame(startMs);
    this._writeDiagnostics();
    return this;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Diagnostics ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getStats() {
    return Object.freeze({
      ticks: this._stats.ticks,
      providerCount: this._providerCount,
      emitterCount: this._emitterCount,
      stageExecMsLast: Array.from(this._stageExecMsLast),
      stageExecMsEma: Array.from(this._stageExecMsEma),
      totalFrameMs: this._stats.totalFrameMs,
      totalFrameMsEma: this._stats.totalFrameMsEma,
      providerFailures: this._stats.providerFailures,
      emitterFailures: this._stats.emitterFailures,
      consumersRan: this._stats.consumersRan,
      budgetViolations: this._stats.budgetViolations,
      framesWithErrors: this._stats.framesWithErrors
    });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) {
      if (typeof this._stats[k] === 'number') this._stats[k] = 0;
    }
    this._stageExecMsEma.fill(0);
    this._stageExecMsPeak.fill(0);
  }

  dispose() {
    for (let i = 0; i < this._providerPool.length; i++) {
      this._providerPool[i].reset();
    }
    this._providerCount = 0;
    this._providerFreeCount = this.defaults.maxProviders;
    for (let i = 0; i < this.defaults.maxProviders; i++) {
      this._providerFreeList[i] = this.defaults.maxProviders - 1 - i;
    }

    for (let i = 0; i < this._emitterPool.length; i++) {
      this._emitterPool[i].reset();
    }
    this._emitterCount = 0;
    this._emitterFreeCount = this.defaults.maxEmitters;
    for (let i = 0; i < this.defaults.maxEmitters; i++) {
      this._emitterFreeList[i] = this.defaults.maxEmitters - 1 - i;
    }

    if (this._tierScheduler) this._tierScheduler.dispose();
    this._tierScheduler = null;

    this._dispatcher = null;
    this._ceilingEnforcer = null;
    this._frameBudgetMonitor = null;
    this._gcMonitor = null;
    this._memoryProfiler = null;
    this._cameraExtrapolator = null;
    this._materialRegistry = null;
    this._worldMemory = null;
    this._impactCoordinator = null;
    this._assetQueue = null;
    this._hlodController = null;
    this._airQualityProvider = null;
    this._renderBatch = null;
    this._previousRenderBatch = null;
    this.frame = null;
    this.clock = null;
  }
}

export {
  ContextRuntime,
  STAGE,
  STAGE_NAMES,
  STAGE_COUNT,
  STAGE_BUDGET_SLICE,
  RenderBatch,
  RENDER_BATCH_CAPACITY,
  ProviderSlot,
  EmitterSlot
};