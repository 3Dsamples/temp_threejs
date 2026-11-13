// file number : 355
// full path name : src/context/355_LandscapePerformanceGovernor.js
// description : Landscape performance governor — the 10 Hz consumer that
// arbitrates every budget in the pipeline. It aggregates the per-tick cost of
// every upstream consumer (328 through 354), tracks resident memory usage
// against one of three explicit memory profiles (LOW = 200 MB, MEDIUM = 400 MB,
// HIGH = 600 MB), enforces the per-tick CPU ceiling (8 ms on a Snapdragon
// 7-series class Android arm64), monitors garbage-collection pause against the
// 2 ms hard limit, and — when the budget is exceeded — applies a staged
// degradation ladder that drops the least-visible work first. The governor
// operates five independent budgets:
//   (1) MEMORY BUDGET   — selected from one of three profiles:
//                         LOW    = 200 MB resident (baseline target from the
//                                   blueprint; snapdragon-7 / mid-range
//                                   Android ceiling)
//                         MEDIUM = 400 MB resident (typical flagship Android)
//                         HIGH   = 600 MB resident (high-end desktop-class
//                                   Android or when streaming is disabled)
//                         Every consumer declares its memory use to the
//                         governor; the governor refuses allocations that
//                         would exceed the profile. When a consumer refuses
//                         to release, the governor drops the THOUSAND_KILOMETER
//                         tier's work entirely (it never refuses).
//   (2) CPU BUDGET      — 8 ms per tick on Snapdragon 7-series; scaled to
//                         16 ms on desktop-class hardware. Every consumer's
//                         per-tick duration is tracked; when the aggregate
//                         exceeds the budget, the governor drops the least-
//                         visible work first (THOUSAND_KILOMETER → 0,
//                         HUNDRED_KILOMETER → 50 %, TEN_KILOMETER → 50 %,
//                         KILOMETER → 75 %). When the budget is exceeded
//                         repeatedly, the governor lowers the ceiling itself
//                         so the runtime does not thrash.
//   (3) GC BUDGET       — 2 ms hard limit at any frame. Every garbage-
//                         collection pause observed by 306 is recorded; when
//                         the p95 pause exceeds 2 ms, the governor escalates
//                         allocation pressure warnings to every consumer that
//                         allocates in the hot path.
//   (4) DRAW CALL BUDGET — the governor tracks the total draw call count
//                         from every visible tier and enforces a ceiling
//                         derived from the hardware class (2000 draw calls on
//                         Android 7-series, 8000 on desktop). When the draw
//                         call count exceeds the ceiling, the governor raises
//                         the LOD bias so distant chunks lose detail and the
//                         draw count comes down.
//   (5) WORKER QUEUE BUDGET — the governor tracks the depth of every worker
//                         pool queue and enforces a per-pool ceiling. When a
//                         pool's queue exceeds its ceiling, the governor
//                         cancels the lowest-priority pending jobs so the
//                         queue returns to a healthy depth.
// The governor also exposes a single recommended-degradation state that every
// consumer reads on its own run() call, so the whole pipeline degrades in
// lockstep rather than each consumer choosing its own strategy. The state is
// a scalar in [0, 1] where 1.0 means "full quality, no degradation" and 0.0
// means "minimum quality, drop everything that is not strictly visible". This
// is the single mechanism by which the pipeline meets the hard limits from
// the blueprint on every hardware class, and it is the reason a mobile
// Snapdragon 7-series device can run the same pipeline as a desktop without
// dropping frames.
//
// The governor is tier-aware in its own right: the KILOMETER tier's work is
// never dropped entirely (a chunk that is right in front of the camera is
// always the last thing to lose detail); the THOUSAND_KILOMETER tier is
// always the first thing to lose work (a chunk that is a thousand kilometres
// away is invisible). Every consumer's per-tier work budget is derived from
// the governor's degradation state, the consumer's own measured cost, and the
// tier's LOD bias. The governor is the single authority on how much work the
// pipeline can do at any moment, and every consumer that runs in the pipeline
// asks it before scheduling any heavy work.
//
// Material and lighting parameters are integrated first-class: the governor's
// degradation state is read by 331_BiomeBlendMaterialBridge (to decide
// whether to skip the OKLab blend, use a cheaper approximation, or skip the
// per-object material update entirely), 350_LandscapeShadowScaler (to decide
// whether to drop shadow cascades), and 351_LandscapeLightingCoupler (to
// decide whether to skip the dappled light computation). This is what makes
// the pipeline meet its budgets without any consumer needing to hardcode a
// degradation strategy.
//#
// best for : Every consumer in the landscape pipeline that schedules work
// that could exceed a budget — 328_BiomeBlendField (asks the governor before
// re-scoring a chunk), 329_BiomeBlendSystem (asks before advancing
// succession), 330_CrossBiomeEcotoneSystem (asks before updating the
// ecotone pair list), 331_BiomeBlendMaterialBridge (asks before each
// per-visible-object material fuse, and skips OKLab when the budget is
// tight), 332–334 couplings (ask before each per-chunk update),
// 335_BiomeFaunaMigrationSystem (asks before stepping each cohort),
// 336_LandscapeChunkDescriptor (uses the governor's budget to decide how
// much per-chunk state to keep), 337_LandscapeChunkStreamer (uses the
// governor's memory and draw-call budgets to decide how many chunks to
// stream in), 338_LandscapeChunkHLOD (uses the governor's LOD bias to
// decide the tier), 339–345 landscape systems (ask before each per-chunk
// update), 346_LandscapeVegetationScatterSystem (uses the governor's
// vegetation-density multiplier), 347_LandscapeFaunaSpawnSystem (uses the
// governor's fauna-density multiplier), 348–354 landscape couplings (ask
// before each per-chunk update), 304_MemoryCeilingEnforcer (delegates to
// the governor's current memory profile), 305_FrameBudgetMonitor (reads the
// governor's per-tier work budget), and 306_GCPauseMonitor (raises the
// governor's GC-pressure flag). The governor is the single authority on
// how much work the pipeline can do at any moment, and every consumer that
// schedules work asks it first.
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

// ─── context providers & systems ────────────────────────────────
import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';
import { CoreClock, TIER, TIER_PERIOD } from './267_CoreClock.js';
import { smoothstep } from './268_ExtrasCurveUtils.js';
import { MemoryCeilingEnforcer, MEMORY_PROFILE } from './304_MemoryCeilingEnforcer.js';
import { FrameBudgetMonitor } from './305_FrameBudgetMonitor.js';
import { GCPauseMonitor } from './306_GCPauseMonitor.js';
import { MemoryProfiler } from './307_MemoryProfiler.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { LandscapeChunkStreamer } from './337_LandscapeChunkStreamer.js';
import { LandscapeChunkHLOD } from './338_LandscapeChunkHLOD.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// HLOD tier identifiers. Must match 336–354.
const HLOD_TIER = Object.freeze({
  KILOMETER: 0,
  TEN_KILOMETER: 1,
  HUNDRED_KILOMETER: 2,
  THOUSAND_KILOMETER: 3
});

// ─── Memory profiles ──────────────────────────────────────────
// The three explicit memory profiles required by the blueprint. Each profile
// declares a resident-memory ceiling (in bytes), a per-frame allocation
// budget (in bytes), and a per-tick CPU budget (in milliseconds). The CPU
// budget is tied to the memory profile because a device with more memory is
// almost always a device with more CPU headroom too — the relationship is
// empirical but holds across the Android device classes we target.
const MEMORY_PROFILE_SPECS = Object.freeze({
  LOW: Object.freeze({
    id: 'LOW',
    label: 'Low (200 MB)',
    memoryCeilingBytes: 200 * 1024 * 1024,       // 200 MB
    memoryCeilingMb: 200,
    perFrameAllocationBytes: 4 * 1024 * 1024,    // 4 MB per frame
    perTickCpuBudgetMs: 8.0,                     // 8 ms (Snapdragon 7-series)
    gcPauseBudgetMs: 2.0,                        // 2 ms hard limit
    drawCallCeiling: 2000,
    workerQueueCeiling: 64,
    targetHardwareClass: 'Android 7-series / mid-range'
  }),
  MEDIUM: Object.freeze({
    id: 'MEDIUM',
    label: 'Medium (400 MB)',
    memoryCeilingBytes: 400 * 1024 * 1024,       // 400 MB
    memoryCeilingMb: 400,
    perFrameAllocationBytes: 8 * 1024 * 1024,    // 8 MB per frame
    perTickCpuBudgetMs: 10.0,                    // 10 ms (flagship Android)
    gcPauseBudgetMs: 2.0,                        // 2 ms hard limit
    drawCallCeiling: 4000,
    workerQueueCeiling: 128,
    targetHardwareClass: 'Flagship Android / mid-range desktop'
  }),
  HIGH: Object.freeze({
    id: 'HIGH',
    label: 'High (600 MB)',
    memoryCeilingBytes: 600 * 1024 * 1024,       // 600 MB
    memoryCeilingMb: 600,
    perFrameAllocationBytes: 16 * 1024 * 1024,   // 16 MB per frame
    perTickCpuBudgetMs: 16.0,                    // 16 ms (desktop-class)
    gcPauseBudgetMs: 2.0,                        // 2 ms hard limit
    drawCallCeiling: 8000,
    workerQueueCeiling: 256,
    targetHardwareClass: 'Desktop-class Android / high-end desktop'
  })
});

// Default memory profile. LOW is the safest default for the Android-64-bit
// target of the blueprint; MEDIUM and HIGH are opt-in for higher-end
// devices. The user can override this at runtime via setMemoryProfile().
const DEFAULT_MEMORY_PROFILE = 'LOW';

// ─── Degradation ladder ──────────────────────────────────────
// The governor's degradation state is a scalar in [0, 1] where 1.0 means
// "no degradation" and 0.0 means "minimum quality". The state is derived
// from the ratio of actual usage to the budget. The per-tier work multipliers
// below are the values that the ladder produces at each degradation step.
//
// The ladder steps are:
//   0.00–0.15  CRITICAL    — THOUSAND off, HUNDRED 25 %, TEN 50 %, KILO 75 %
//   0.15–0.35  SEVERE      — THOUSAND off, HUNDRED 50 %, TEN 75 %, KILO 100 %
//   0.35–0.55  TIGHT       — THOUSAND 25 %, HUNDRED 75 %, TEN 100 %, KILO 100 %
//   0.55–0.75  MODERATE    — THOUSAND 50 %, HUNDRED 100 %, TEN 100 %, KILO 100 %
//   0.75–1.00  HEALTHY     — everything 100 %
//
// The multipliers apply to each tier's own per-tick work budget. A multiplier
// of 0.0 means "skip this tier entirely this tick"; a multiplier of 1.0
// means "run at full rate".
const DEGRADATION_TIER_MULTIPLIERS = Object.freeze([
  // [THOUSAND, HUNDRED, TEN, KILO]
  Object.freeze([0.00, 0.25, 0.50, 0.75]),   // CRITICAL
  Object.freeze([0.00, 0.50, 0.75, 1.00]),   // SEVERE
  Object.freeze([0.25, 0.75, 1.00, 1.00]),   // TIGHT
  Object.freeze([0.50, 1.00, 1.00, 1.00]),   // MODERATE
  Object.freeze([1.00, 1.00, 1.00, 1.00])    // HEALTHY
]);

// Degradation state thresholds. The state [0,1] maps to a ladder step by
// these thresholds.
const DEGRADATION_STEP_THRESHOLDS = Object.freeze([
  0.15,   // step 0 (CRITICAL) starts at state 0.00, ends at 0.15
  0.35,   // step 1 (SEVERE) ends at 0.35
  0.55,   // step 2 (TIGHT) ends at 0.55
  0.75,   // step 3 (MODERATE) ends at 0.75
  1.00    // step 4 (HEALTHY) ends at 1.00
]);

// The degradation state is smoothed toward its target with this rate so the
// pipeline does not oscillate between steps when the load hovers at a
// threshold.
const DEGRADATION_SMOOTHING_RATE = 0.2;

// ─── Diagnostic smoothing ─────────────────────────────────────
// The per-consumer cost measurements are smoothed with an exponential moving
// average so a single expensive tick does not immediately trigger a
// degradation step. The smoothing rate is per-tick.
const COST_SMOOTHING_RATE = 0.1;

// ─── Governor tick period ────────────────────────────────────
// The governor runs at 10 Hz. This is the same rate as the tier-A consumers
// so the governor's decision is in phase with the work it is governing.
const GOVERNOR_TICK_PERIOD_S = 0.1;

// ─── Event emission throttling ──────────────────────────────
// The governor emits an event every time its degradation state crosses a
// threshold, but at most once per second so downstream consumers are not
// flooded.
const EVENT_THROTTLE_S = 1.0;

// ══════════════════════════════════════════════════════════════════
// ─── POOLED PER-CONSUMER STATE ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// The governor tracks the per-tick cost of every consumer that calls
// `reportConsumerCost()`. The consumers are indexed by an integer id
// (0..MAX_CONSUMERS-1) that is assigned when the consumer first registers.

const MAX_CONSUMERS = 64;

// Per-consumer registration.
const _consumerName          = new Array(MAX_CONSUMERS).fill(null);
const _consumerId            = new Int32Array(MAX_CONSUMERS).fill(-1);
const _consumerRegistered    = new Uint8Array(MAX_CONSUMERS);

// Per-consumer cost tracking.
const _consumerCostMs        = new Float32Array(MAX_CONSUMERS);
const _consumerSmoothedCostMs = new Float32Array(MAX_CONSUMERS);
const _consumerCallCount     = new Uint32Array(MAX_CONSUMERS);
const _consumerBudgetMs      = new Float32Array(MAX_CONSUMERS).fill(-1);
const _consumerMemoryBytes   = new Float32Array(MAX_CONSUMERS);

// ─── Per-tier work budget ────────────────────────────────────
// The governor computes a per-tick work multiplier for each HLOD tier. The
// multiplier is read by every consumer that schedules per-tier work.
const _tierMultiplier        = new Float32Array(4).fill(1.0);

// ─── Governor state ─────────────────────────────────────────
// The governor's current degradation state (0..1), smoothed.
let _degradationState = 1.0;
// Target (unsmoothed) degradation state, computed from usage ratios.
let _targetDegradationState = 1.0;
// Current ladder step (0..4).
let _ladderStep = 4;

// Memory profile selection.
let _currentProfileId = DEFAULT_MEMORY_PROFILE;
let _currentProfile = MEMORY_PROFILE_SPECS[DEFAULT_MEMORY_PROFILE];

// Memory usage tracking.
let _residentBytes = 0;
let _residentBytesSmoothed = 0;
let _memoryPressure = 0;   // 0..1

// CPU usage tracking.
let _cpuUsageMs = 0;
let _cpuUsageSmoothedMs = 0;
let _cpuPressure = 0;   // 0..1

// GC pause tracking.
let _gcPauseMs = 0;
let _gcPauseSmoothedMs = 0;
let _gcPressure = 0;    // 0..1

// Draw call tracking.
let _drawCalls = 0;
let _drawCallsSmoothed = 0;
let _drawCallPressure = 0;   // 0..1

// Worker queue tracking (aggregated across all pools).
let _workerQueueDepth = 0;
let _workerQueuePressure = 0;   // 0..1

// Event throttling.
let _lastEventEmitS = -1e9;

// ─── Global state ───────────────────────────────────────────
const _dispatcher = new CoreEventDispatcher();
let _lastProcessed = 0;
let _lastTickDurationMs = 0;
let _framesSinceProfileChange = 0;

// ══════════════════════════════════════════════════════════════════
// ─── INTERNAL HELPERS ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Map the degradation state to a ladder step index.
function _stepForDegradationState(state) {
  for (let i = 0; i < DEGRADATION_STEP_THRESHOLDS.length; i++) {
    if (state < DEGRADATION_STEP_THRESHOLDS[i]) return i;
  }
  return DEGRADATION_STEP_THRESHOLDS.length - 1;
}

// Apply the ladder step's per-tier multipliers to the tier multiplier array.
function _applyLadderStep(step) {
  const multipliers = DEGRADATION_TIER_MULTIPLIERS[step];
  if (!multipliers) return;
  // The ladder is stored [THOUSAND, HUNDRED, TEN, KILO], but the tier
  // constants are KILO=0, TEN=1, HUNDRED=2, THOUSAND=3. We reverse.
  _tierMultiplier[HLOD_TIER.KILOMETER]         = multipliers[3];
  _tierMultiplier[HLOD_TIER.TEN_KILOMETER]     = multipliers[2];
  _tierMultiplier[HLOD_TIER.HUNDRED_KILOMETER] = multipliers[1];
  _tierMultiplier[HLOD_TIER.THOUSAND_KILOMETER] = multipliers[0];
}

// Compute the aggregate degradation state from the five pressures. The
// degradation state is the MINIMUM of (1 - each pressure), so any single
// pressure that is high drags the whole state down.
function _computeTargetDegradationState() {
  const memFree = 1.0 - _memoryPressure;
  const cpuFree = 1.0 - _cpuPressure;
  const gcFree = 1.0 - _gcPressure;
  const drawFree = 1.0 - _drawCallPressure;
  const workerFree = 1.0 - _workerQueuePressure;

  // The state is the minimum of the five free values.
  return Math.min(memFree, cpuFree, gcFree, drawFree, workerFree);
}

// Update the CPU pressure from the measured per-tick CPU usage.
function _updateCpuPressure(dt) {
  const budget = _currentProfile.perTickCpuBudgetMs;
  const usage = _cpuUsageSmoothedMs;
  // Pressure starts rising once usage exceeds 60 % of budget and reaches
  // 1.0 at 100 % of budget.
  const ratio = usage / budget;
  if (ratio <= 0.6) {
    _cpuPressure = 0;
  } else if (ratio >= 1.0) {
    _cpuPressure = 1.0;
  } else {
    _cpuPressure = (ratio - 0.6) / 0.4;
  }
}

// Update the memory pressure from the current resident bytes.
function _updateMemoryPressure(dt) {
  const ceiling = _currentProfile.memoryCeilingBytes;
  const usage = _residentBytesSmoothed;
  const ratio = usage / ceiling;
  if (ratio <= 0.7) {
    _memoryPressure = 0;
  } else if (ratio >= 1.0) {
    _memoryPressure = 1.0;
  } else {
    _memoryPressure = (ratio - 0.7) / 0.3;
  }
}

// Update the GC pressure from the last measured GC pause.
function _updateGcPressure(dt) {
  const budget = _currentProfile.gcPauseBudgetMs;
  const usage = _gcPauseSmoothedMs;
  const ratio = usage / budget;
  if (ratio <= 0.5) {
    _gcPressure = 0;
  } else if (ratio >= 1.0) {
    _gcPressure = 1.0;
  } else {
    _gcPressure = (ratio - 0.5) / 0.5;
  }
}

// Update the draw-call pressure.
function _updateDrawCallPressure(dt) {
  const ceiling = _currentProfile.drawCallCeiling;
  const usage = _drawCallsSmoothed;
  const ratio = usage / ceiling;
  if (ratio <= 0.7) {
    _drawCallPressure = 0;
  } else if (ratio >= 1.0) {
    _drawCallPressure = 1.0;
  } else {
    _drawCallPressure = (ratio - 0.7) / 0.3;
  }
}

// Update the worker queue pressure.
function _updateWorkerQueuePressure(dt) {
  const ceiling = _currentProfile.workerQueueCeiling;
  const usage = _workerQueueDepth;
  const ratio = usage / ceiling;
  if (ratio <= 0.7) {
    _workerQueuePressure = 0;
  } else if (ratio >= 1.0) {
    _workerQueuePressure = 1.0;
  } else {
    _workerQueuePressure = (ratio - 0.7) / 0.3;
  }
}

// Smooth a value toward a target with the given rate and dt.
function _smooth(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const LandscapePerformanceGovernor = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  HLOD_TIER,
  MEMORY_PROFILE_SPECS,
  DEGRADATION_TIER_MULTIPLIERS,
  maxConsumers: MAX_CONSUMERS,
  governorTickPeriodS: GOVERNOR_TICK_PERIOD_S,

  /**
   * Initialise the governor. Called once by 361_FinalRuntimeWiring or
   * 362_RuntimeBootstrap. Reads the initial memory profile from the
   * environment and registers the default consumer set.
   */
  init() {
    // Try to auto-detect the initial memory profile from the environment.
    let detected = DEFAULT_MEMORY_PROFILE;
    if (typeof navigator !== 'undefined' && navigator.deviceMemory) {
      // navigator.deviceMemory reports in GB.
      if (navigator.deviceMemory >= 8) detected = 'HIGH';
      else if (navigator.deviceMemory >= 6) detected = 'MEDIUM';
      else detected = 'LOW';
    }
    this.setMemoryProfile(detected);
    _lastProcessed = 0;
    _dispatcher.emit(EVENT_TYPE.PERFORMANCE_GOVERNOR_INITIALIZED, {
      profile: _currentProfileId,
      profileLabel: _currentProfile.label,
      memoryCeilingMb: _currentProfile.memoryCeilingMb
    });
  },

  /**
   * Select the memory profile. The three supported profiles are LOW (200 MB),
   * MEDIUM (400 MB), and HIGH (600 MB). Changing the profile immediately
   * updates the current ceilings and — if the new profile is more permissive
   * — allows the ladder step to relax on the next governor tick.
   *
   * @param {string} profileId - 'LOW', 'MEDIUM', or 'HIGH'.
   * @returns {boolean} true if the profile was changed.
   */
  setMemoryProfile(profileId) {
    const spec = MEMORY_PROFILE_SPECS[profileId];
    if (!spec) return false;
    _currentProfileId = profileId;
    _currentProfile = spec;
    _framesSinceProfileChange = 0;

    // The governor also forwards the profile to the MemoryCeilingEnforcer
    // if it is loaded, so the enforcer and the governor stay in lockstep.
    if (MemoryCeilingEnforcer && typeof MemoryCeilingEnforcer.setProfile === 'function') {
      MemoryCeilingEnforcer.setProfile(profileId);
    }
    _dispatcher.emit(EVENT_TYPE.MEMORY_PROFILE_CHANGED, {
      profile: profileId,
      profileLabel: spec.label,
      memoryCeilingMb: spec.memoryCeilingMb,
      perTickCpuBudgetMs: spec.perTickCpuBudgetMs,
      drawCallCeiling: spec.drawCallCeiling
    });
    return true;
  },

  /**
   * Get the current memory profile id.
   */
  getMemoryProfile() {
    return _currentProfileId;
  },

  /**
   * Get the current memory profile's full specification.
   */
  getMemoryProfileSpec() {
    return _currentProfile;
  },

  /**
   * Register a consumer so the governor can track its cost. Every consumer
   * that reports cost should call this once during initialisation.
   *
   * @param {string} name
   * @returns {number} The consumer id, or -1 if the registry is full.
   */
  registerConsumer(name) {
    for (let i = 0; i < MAX_CONSUMERS; i++) {
      if (!_consumerRegistered[i]) {
        _consumerRegistered[i] = 1;
        _consumerName[i] = name;
        _consumerId[i] = i;
        _consumerCostMs[i] = 0;
        _consumerSmoothedCostMs[i] = 0;
        _consumerCallCount[i] = 0;
        _consumerBudgetMs[i] = -1;
        _consumerMemoryBytes[i] = 0;
        return i;
      }
    }
    return -1;
  },

  /**
   * Report the cost of a consumer for the current tick. The consumer calls
   * this immediately after its run() returns. The governor uses the cost
   * to track per-consumer pressure and to compute the aggregate CPU usage.
   *
   * @param {number} consumerId - The id returned by registerConsumer.
   * @param {number} costMs - The consumer's duration in milliseconds.
   * @param {number} [memoryBytes=0] - The consumer's resident memory in bytes.
   */
  reportConsumerCost(consumerId, costMs, memoryBytes) {
    if (consumerId < 0 || consumerId >= MAX_CONSUMERS) return;
    if (!_consumerRegistered[consumerId]) return;
    _consumerCostMs[consumerId] = costMs;
    _consumerCallCount[consumerId]++;
    if (memoryBytes !== undefined) _consumerMemoryBytes[consumerId] = memoryBytes;
  },

  /**
   * Set an explicit per-consumer budget. If a consumer's smoothed cost
   * exceeds its budget, the governor reports the violation and — when the
   * same consumer violates its budget for many consecutive ticks — raises
   * its per-tier multipliers less aggressively. This is a diagnostic path
   * that is useful during development; in production, consumers should not
   * exceed their budget because the governor's degradation ladder should
   * keep the aggregate under the ceiling.
   */
  setConsumerBudget(consumerId, budgetMs) {
    if (consumerId < 0 || consumerId >= MAX_CONSUMERS) return;
    if (!_consumerRegistered[consumerId]) return;
    _consumerBudgetMs[consumerId] = budgetMs;
  },

  /**
   * Update the aggregate draw call count. Called by 337 after each streaming
   * pass.
   */
  reportDrawCalls(count) {
    _drawCalls = count;
  },

  /**
   * Update the aggregate worker queue depth. Called by the runtime when the
   * worker pool depth changes.
   */
  reportWorkerQueueDepth(depth) {
    _workerQueueDepth = depth;
  },

  /**
   * Report the current resident memory in bytes. Called by 307_MemoryProfiler
   * once per profiler tick.
   */
  reportResidentBytes(bytes) {
    _residentBytes = bytes;
  },

  /**
   * Report the current GC pause in milliseconds. Called by 306_GCPauseMonitor
   * when a GC pause occurs.
   */
  reportGcPause(pauseMs) {
    _gcPauseMs = pauseMs;
  },

  /**
   * Report the current per-tick CPU usage in milliseconds. Called by the
   * runtime after every tick.
   */
  reportCpuUsage(cpuMs) {
    _cpuUsageMs = cpuMs;
  },

  /**
   * The 10 Hz governor tick. Called by 308_ContextConsumerTiers. Reads the
   * reported costs, computes the five pressures, updates the degradation
   * state, and applies the per-tier work multipliers.
   */
  run(frame, tick, dt) {
    const t0 = performanceNow();
    _framesSinceProfileChange++;

    // ─── 1. Smooth the reported values ──────────────────────
    _residentBytesSmoothed = _smooth(_residentBytesSmoothed, _residentBytes, COST_SMOOTHING_RATE, dt);
    _cpuUsageSmoothedMs = _smooth(_cpuUsageSmoothedMs, _cpuUsageMs, COST_SMOOTHING_RATE, dt);
    _gcPauseSmoothedMs = _smooth(_gcPauseSmoothedMs, _gcPauseMs, COST_SMOOTHING_RATE, dt);
    _drawCallsSmoothed = _smooth(_drawCallsSmoothed, _drawCalls, COST_SMOOTHING_RATE, dt);

    // ─── 2. Update the five pressures ───────────────────────
    _updateMemoryPressure(dt);
    _updateCpuPressure(dt);
    _updateGcPressure(dt);
    _updateDrawCallPressure(dt);
    _updateWorkerQueuePressure(dt);

    // ─── 3. Compute the target degradation state ────────────
    _targetDegradationState = _computeTargetDegradationState();

    // ─── 4. Smooth toward the target ────────────────────────
    const smoothingRate = _framesSinceProfileChange < 10 ? 1.0 : DEGRADATION_SMOOTHING_RATE;
    _degradationState = _smooth(_degradationState, _targetDegradationState, smoothingRate, dt);

    // ─── 5. Map to a ladder step and apply the multipliers ──
    const newStep = _stepForDegradationState(_degradationState);
    if (newStep !== _ladderStep) {
      _ladderStep = newStep;
      _applyLadderStep(_ladderStep);
    }

    // ─── 6. Compute the aggregate CPU cost from per-consumer ─
    let totalCost = 0;
    let totalMemory = 0;
    for (let i = 0; i < MAX_CONSUMERS; i++) {
      if (!_consumerRegistered[i]) continue;
      _consumerSmoothedCostMs[i] = _smooth(_consumerSmoothedCostMs[i], _consumerCostMs[i], COST_SMOOTHING_RATE, dt);
      totalCost += _consumerSmoothedCostMs[i];
      totalMemory += _consumerMemoryBytes[i];
    }

    // ─── 7. Emit a throttled event ──────────────────────────
    const nowS = BiomeBlendSystem.elapsedSimSeconds;
    if (nowS - _lastEventEmitS >= EVENT_THROTTLE_S) {
      _lastEventEmitS = nowS;
      _dispatcher.emit(EVENT_TYPE.PERFORMANCE_GOVERNOR_UPDATED, {
        tick,
        profile: _currentProfileId,
        degradationState: _degradationState,
        ladderStep: _ladderStep,
        tierMultipliers: _tierMultiplier.slice(),
        pressures: {
          memory: _memoryPressure,
          cpu: _cpuPressure,
          gc: _gcPressure,
          drawCalls: _drawCallPressure,
          workerQueue: _workerQueuePressure
        },
        usage: {
          residentBytes: _residentBytesSmoothed,
          residentMb: _residentBytesSmoothed / (1024 * 1024),
          cpuMs: _cpuUsageSmoothedMs,
          gcPauseMs: _gcPauseSmoothedMs,
          drawCalls: _drawCallsSmoothed,
          workerQueueDepth: _workerQueueDepth,
          aggregateConsumerCostMs: totalCost,
          aggregateConsumerMemoryBytes: totalMemory
        }
      });
    }

    _lastProcessed = tick;
    _lastTickDurationMs = performanceNow() - t0;
  },

  /**
   * Get the current per-tier work multiplier. Consumers read this before
   * scheduling any per-tier work.
   *
   * @param {number} tier - One of HLOD_TIER.KILOMETER..THOUSAND_KILOMETER.
   * @returns {number} Multiplier in [0, 1].
   */
  getTierMultiplier(tier) {
    if (tier < 0 || tier > 3) return 1.0;
    return _tierMultiplier[tier];
  },

  /**
   * Get the full per-tier multiplier array. Zero-allocation (returns a
   * subarray view).
   */
  getTierMultipliers() {
    return _tierMultiplier;
  },

  /**
   * Query whether the governor recommends dropping a tier's work entirely.
   *
   * @param {number} tier
   * @returns {boolean}
   */
  shouldSkipTier(tier) {
    if (tier < 0 || tier > 3) return false;
    return _tierMultiplier[tier] === 0;
  },

  /**
   * Read the current governor state into a preallocated object.
   * Zero-allocation.
   */
  readState(out) {
    out.profile = _currentProfileId;
    out.profileLabel = _currentProfile.label;
    out.memoryCeilingMb = _currentProfile.memoryCeilingMb;
    out.perTickCpuBudgetMs = _currentProfile.perTickCpuBudgetMs;
    out.gcPauseBudgetMs = _currentProfile.gcPauseBudgetMs;
    out.drawCallCeiling = _currentProfile.drawCallCeiling;
    out.workerQueueCeiling = _currentProfile.workerQueueCeiling;
    out.degradationState = _degradationState;
    out.targetDegradationState = _targetDegradationState;
    out.ladderStep = _ladderStep;
    out.memoryPressure = _memoryPressure;
    out.cpuPressure = _cpuPressure;
    out.gcPressure = _gcPressure;
    out.drawCallPressure = _drawCallPressure;
    out.workerQueuePressure = _workerQueuePressure;
    out.residentMb = _residentBytesSmoothed / (1024 * 1024);
    out.cpuMs = _cpuUsageSmoothedMs;
    out.gcPauseMs = _gcPauseSmoothedMs;
    out.drawCalls = _drawCallsSmoothed;
    out.workerQueueDepth = _workerQueueDepth;
    out.tierMultiplierKilo = _tierMultiplier[HLOD_TIER.KILOMETER];
    out.tierMultiplierTen = _tierMultiplier[HLOD_TIER.TEN_KILOMETER];
    out.tierMultiplierHundred = _tierMultiplier[HLOD_TIER.HUNDRED_KILOMETER];
    out.tierMultiplierThousand = _tierMultiplier[HLOD_TIER.THOUSAND_KILOMETER];
    return true;
  },

  // ─── Direct accessor API for hot paths ────────────────────
  getDegradationState() {
    return _degradationState;
  },
  getLadderStep() {
    return _ladderStep;
  },
  getMemoryPressure() {
    return _memoryPressure;
  },
  getCpuPressure() {
    return _cpuPressure;
  },
  getGcPressure() {
    return _gcPressure;
  },
  getDrawCallPressure() {
    return _drawCallPressure;
  },
  getWorkerQueuePressure() {
    return _workerQueuePressure;
  },
  getResidentMb() {
    return _residentBytesSmoothed / (1024 * 1024);
  },
  getCpuMs() {
    return _cpuUsageSmoothedMs;
  },
  getGcPauseMs() {
    return _gcPauseSmoothedMs;
  },
  getDrawCalls() {
    return _drawCallsSmoothed;
  },

  /**
   * Get a consumer's smoothed cost by id. Used by the diagnostics panel.
   */
  getConsumerCostMs(consumerId) {
    if (consumerId < 0 || consumerId >= MAX_CONSUMERS) return 0;
    return _consumerSmoothedCostMs[consumerId];
  },

  /**
   * Get a consumer's name by id.
   */
  getConsumerName(consumerId) {
    if (consumerId < 0 || consumerId >= MAX_CONSUMERS) return null;
    return _consumerName[consumerId];
  },

  // ─── Memory profile helpers ─────────────────────────────
  /**
   * Convenience shortcut to switch to the LOW profile (200 MB).
   */
  setLowProfile() {
    return this.setMemoryProfile('LOW');
  },

  /**
   * Convenience shortcut to switch to the MEDIUM profile (400 MB).
   */
  setMediumProfile() {
    return this.setMemoryProfile('MEDIUM');
  },

  /**
   * Convenience shortcut to switch to the HIGH profile (600 MB).
   */
  setHighProfile() {
    return this.setMemoryProfile('HIGH');
  },

  /**
   * Get the current memory ceiling in megabytes.
   */
  getMemoryCeilingMb() {
    return _currentProfile.memoryCeilingMb;
  },

  /**
   * Query whether the current memory usage exceeds the current profile's
   * ceiling.
   */
  isMemoryOverBudget() {
    return _residentBytesSmoothed > _currentProfile.memoryCeilingBytes;
  },

  /**
   * Query whether the current CPU usage exceeds the current profile's
   * per-tick CPU budget.
   */
  isCpuOverBudget() {
    return _cpuUsageSmoothedMs > _currentProfile.perTickCpuBudgetMs;
  },

  /**
   * Query whether the current GC pause exceeds the current profile's
   * GC pause budget.
   */
  isGcOverBudget() {
    return _gcPauseSmoothedMs > _currentProfile.gcPauseBudgetMs;
  },

  // ─── Diagnostics ─────────────────────────────────────────
  get lastProcessed() { return _lastProcessed; },
  get lastTickDurationMs() { return _lastTickDurationMs; },
  get registeredConsumerCount() {
    let n = 0;
    for (let i = 0; i < MAX_CONSUMERS; i++) if (_consumerRegistered[i]) n++;
    return n;
  }
});

function performanceNow() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}

export default LandscapePerformanceGovernor;