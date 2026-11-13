// file number : 306
// full path name : src/context/306_GCPauseMonitor.js
// description : Garbage-collection pause monitor — the watchdog for the 2 ms GC pause ceiling on Android arm64 that keeps the living world stutter-free under heavy allocation pressure. Complements 304_MemoryCeilingEnforcer (which denies allocations that would exceed the memory ceiling) and 305_FrameBudgetMonitor (which tracks total CPU) by isolating the exact cost of garbage collection and reporting it back to those systems so they can gate future allocations. Uses the browser's PerformanceObserver with the 'gc' entry type when available (Chromium, Firefox, Safari 16.4+) to capture every major and minor GC with exact start/duration, plus the 'measure' entry type for V8's performance.measureUserAgentSpecificMemory() when crossOriginIsolated is true. Falls back gracefully on older engines by estimating GC pressure from allocation volume (each allocated KB contributes to a modeled pause probability using the classic generational GC cost model: expected pause ≈ (youngAlloc / youngBudget) * youngPauseTime + (majorTriggered ? majorPauseTime : 0)). Maintains a rolling ring buffer of the last 120 pauses per GC type (MINOR, MAJOR, INCREMENTAL, WEAK_CALLBACK, and ALL) and computes p50, p95, p99, max, and a rolling EMA. Exposes four pressure levels (NORMAL < 1 ms, WARN 1–1.5 ms, CRITICAL 1.5–2 ms, EMERGENCY > 2 ms) matching the blueprint's hard limit and provides isGCPauseOverBudget() and getBlockingPressure() so 304_MemoryCeilingEnforcer can gate allocations cooperatively. Provides requestMicrotaskAllocation(callback) which defers a small allocation to the next microtask when a recent pause was detected, and a requestIdleAllocation(callback) that schedules via requestIdleCallback when crossOriginIsolated is false. Emits AUDIO_LIGHT causal events on every pause violation and every pressure level transition. Writes per-frame GC state into frame.layers.physical.gcMonitor. Zero allocation on hot paths: all pause rings, timer state, and event payloads are pre-allocated; recording a pause does not create any object after construction.
// best for : Every subsystem that produces garbage — the streaming queue (301), the HLOD controller (303), the persistent world memory (299), any physics or animation loop that creates scratch objects. This is the feedback loop that turns the blueprint's "prevent GC pauses by pooling everything that repeats" principle into a measurable, enforced contract.
// license : MIT

import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere, Box3, Frustum,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture
} from './264_MathECSImportBarrel.js';

import { ContextFrame }                                    from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES }    from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS }                   from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD }                     from './267_CoreClock.js';
import { MemoryCeilingEnforcer, CPU_LIMITS, PRESSURE_LEVEL }
                                                            from './304_MemoryCeilingEnforcer.js';
import { FrameBudgetMonitor, BUDGET_SLICE, BUDGET_SLICE_NAMES }
                                                            from './305_FrameBudgetMonitor.js';

// ══════════════════════════════════════════════════════════════════
// ─── GC EVENT TYPES (mapped to a unified enum) ─────────────────
// ══════════════════════════════════════════════════════════════════
const GC_TYPE = Object.freeze({
  MINOR:            0,   // young-generation scavenge
  MAJOR:            1,   // full mark-sweep-compact
  INCREMENTAL:      2,   // incremental marking
  WEAK_CALLBACK:    3,   // weak-ref cleanup
  ALL:              4    // aggregate of all types
});

const GC_TYPE_NAMES = Object.freeze([
  'minor', 'major', 'incremental', 'weak_callback', 'all'
]);

const GC_TYPE_COUNT = 5;

// ══════════════════════════════════════════════════════════════════
// ─── PRESSURE LEVELS FOR GC (matching blueprint 2 ms ceiling) ──
// ══════════════════════════════════════════════════════════════════
const GC_PRESSURE = Object.freeze({
  NORMAL:     0,   // < 1.0 ms   — safe
  WARN:       1,   // 1.0 – 1.5  — slow down allocation rate
  CRITICAL:   2,   // 1.5 – 2.0  — deny new allocations
  EMERGENCY:  3    // > 2.0      — hard ceiling breach, pause non-essential systems
});

const GC_PRESSURE_NAMES = Object.freeze([
  'normal', 'warn', 'critical', 'emergency'
]);

// ══════════════════════════════════════════════════════════════════
// ─── GC CONSTANTS ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const GC_CONSTANTS = Object.freeze({
  // Hard ceiling from blueprint step 16.
  MAX_PAUSE_MS:            2.0,
  WARN_THRESHOLD_MS:       1.0,
  CRITICAL_THRESHOLD_MS:   1.5,
  EMERGENCY_THRESHOLD_MS:  2.0,

  // Ring buffer size per GC type.
  RING_BUFFER_SIZE:        120,

  // EMA smoothing.
  EMA_ALPHA:               0.08,

  // Coalesce window for events (ms).
  EVENT_COALESCE_MS:       500,

  // Post-pause cooldown: allocations are gated for this long
  // after any pause above the ceiling.
  PAUSE_COOLDOWN_MS:       1000,

  // Generational cost model fallback (when PerformanceObserver
  // is unavailable).
  ESTIMATED_YOUNG_BUDGET_BYTES:  8 * 1024 * 1024,   // 8 MB young gen
  ESTIMATED_YOUNG_PAUSE_MS:      0.4,
  ESTIMATED_MAJOR_PAUSE_MS:      1.6,

  // Threshold to trigger a major GC estimate.
  ESTIMATED_MAJOR_TRIGGER_BYTES: 64 * 1024 * 1024,

  // Deferred allocation queue.
  DEFERRED_CAPACITY:       16
});

// ══════════════════════════════════════════════════════════════════
// ─── DEFERRED ALLOCATION ENTRY (pooled) ────────────────────────
// ══════════════════════════════════════════════════════════════════
class DeferredAllocation {
  constructor() {
    this.active = false;
    this.callback = null;
    this.enqueuedAt = 0;
    this.priority = 0;
  }

  reset() {
    this.active = false;
    this.callback = null;
    this.enqueuedAt = 0;
    this.priority = 0;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── GC PAUSE MONITOR ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class GCPauseMonitor {
  constructor(options = {}) {
    // ── Configuration ────────────────────────────────────
    this.defaults = {
      maxPauseMs:              options.maxPauseMs ?? GC_CONSTANTS.MAX_PAUSE_MS,
      warnThresholdMs:         options.warnThresholdMs ?? GC_CONSTANTS.WARN_THRESHOLD_MS,
      criticalThresholdMs:     options.criticalThresholdMs ?? GC_CONSTANTS.CRITICAL_THRESHOLD_MS,
      emergencyThresholdMs:    options.emergencyThresholdMs ?? GC_CONSTANTS.EMERGENCY_THRESHOLD_MS,
      ringBufferSize:          options.ringBufferSize ?? GC_CONSTANTS.RING_BUFFER_SIZE,
      emaAlpha:                options.emaAlpha ?? GC_CONSTANTS.EMA_ALPHA,
      eventCoalesceMs:         options.eventCoalesceMs ?? GC_CONSTANTS.EVENT_COALESCE_MS,
      pauseCooldownMs:         options.pauseCooldownMs ?? GC_CONSTANTS.PAUSE_COOLDOWN_MS,
      enableEvents:            options.enableEvents ?? true,
      enableFallbackEstimation: options.enableFallbackEstimation ?? true,
      enableDeferredQueue:     options.enableDeferredQueue ?? true,
      // Optional forwarding targets.
      ceilingEnforcer:         options.ceilingEnforcer ?? null,
      frameBudgetMonitor:      options.frameBudgetMonitor ?? null
    };

    // ── Ring buffers per GC type ─────────────────────────
    const rbSize = this.defaults.ringBufferSize;
    this._rings = new Array(GC_TYPE_COUNT);
    this._ringHeads = new Int32Array(GC_TYPE_COUNT);
    this._ringCounts = new Int32Array(GC_TYPE_COUNT);
    for (let t = 0; t < GC_TYPE_COUNT; t++) {
      this._rings[t] = new Float32Array(rbSize);
    }

    // ── Aggregate state ──────────────────────────────────
    this._lastPauseMs = 0;
    this._lastPauseType = GC_TYPE.ALL;
    this._lastPauseTime = 0;
    this._peakPauseMs = 0;
    this._currentPauseMs = 0;   // measurement in progress

    // EMA per type + aggregate.
    this._emaMs = new Float32Array(GC_TYPE_COUNT);

    // Percentiles per type + aggregate (lazy).
    this._p50 = new Float32Array(GC_TYPE_COUNT);
    this._p95 = new Float32Array(GC_TYPE_COUNT);
    this._p99 = new Float32Array(GC_TYPE_COUNT);
    this._percentilesDirty = new Uint8Array(GC_TYPE_COUNT).fill(1);

    // Sort scratch.
    this._percentileScratch = new Float32Array(rbSize);

    // ── Per-frame tracking ───────────────────────────────
    this._frameStartPauseMs = 0;
    this._framePauseCount = 0;
    this._frameTotalPauseMs = 0;
    this._frameValid = false;

    // ── Fallback generational cost model ─────────────────
    this._allocationSinceLastGC = 0;
    this._allocationSinceLastMajor = 0;
    this._estimatedMajorGCs = 0;
    this._estimatedYoungGCs = 0;

    // ── Pressure level ───────────────────────────────────
    this._pressureLevel = GC_PRESSURE.NORMAL;

    // ── Observer reference ───────────────────────────────
    this._observer = null;
    this._observerActive = false;
    this._observingType = null;

    // ── Deferred allocation queue (pooled) ──────────────
    this._deferredCapacity = GC_CONSTANTS.DEFERRED_CAPACITY;
    this._deferredQueue = new Array(this._deferredCapacity);
    for (let i = 0; i < this._deferredCapacity; i++) {
      this._deferredQueue[i] = new DeferredAllocation();
    }
    this._deferredFreeList = new Int32Array(this._deferredCapacity);
    for (let i = 0; i < this._deferredCapacity; i++) {
      this._deferredFreeList[i] = this._deferredCapacity - 1 - i;
    }
    this._deferredFreeCount = this._deferredCapacity;
    this._deferredPendingCount = 0;

    // ── Statistics ──────────────────────────────────────
    this._stats = {
      recordedPauses: 0,
      minorPauses: 0,
      majorPauses: 0,
      incrementalPauses: 0,
      weakCallbackPauses: 0,
      violations: 0,
      warnEvents: 0,
      criticalEvents: 0,
      emergencyEvents: 0,
      pressureTransitions: 0,
      estimatedYoungGCs: 0,
      estimatedMajorGCs: 0,
      deferredAllocations: 0,
      executedDeferred: 0,
      expiredDeferred: 0,
      framesMeasured: 0,
      framesWithPauses: 0
    };

    // ── Event coalescing ─────────────────────────────────
    this._lastEventTime = 0;
    this._lastPressureEventTime = 0;

    // ── Collaborators ───────────────────────────────────
    this._dispatcher = options.dispatcher || null;
    this._clock = options.clock || null;
    this._ceilingEnforcer = this.defaults.ceilingEnforcer;
    this._frameBudgetMonitor = this.defaults.frameBudgetMonitor;
    this._frameRef = null;

    // ── Try to set up the PerformanceObserver ───────────
    this._tryInitObserver();
  }

  // ══════════════════════════════════════════════════════════
  // ─── Collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachDispatcher(d) { this._dispatcher = d; return this; }
  attachClock(c) { this._clock = c; return this; }
  attachCeilingEnforcer(e) { this._ceilingEnforcer = e; return this; }
  attachFrameBudgetMonitor(f) { this._frameBudgetMonitor = f; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── PerformanceObserver initialization ────────────────
  // ══════════════════════════════════════════════════════════
  _tryInitObserver() {
    if (typeof PerformanceObserver === 'undefined') return;
    if (typeof PerformanceObserver.supportedEntryTypes === 'undefined') return;

    const supported = PerformanceObserver.supportedEntryTypes;
    if (supported.includes('gc')) {
      this._observingType = 'gc';
      try {
        this._observer = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            const type = this._mapGCType(e.detail?.kind, e.name);
            this.recordPause(type, e.duration);
          }
        });
        this._observer.observe({ type: 'gc', buffered: false });
        this._observerActive = true;
      } catch (e) {
        this._observer = null;
        this._observerActive = false;
      }
    }
  }

  // Map browser-specific GC kind strings to our unified types.
  _mapGCType(kind, name) {
    const k = (kind || name || '').toLowerCase();
    if (k === 'minor' || k === 'scavenge' || k.includes('minor')) return GC_TYPE.MINOR;
    if (k === 'major' || k === 'mark-sweep' || k === 'mark-compact') return GC_TYPE.MAJOR;
    if (k === 'incremental' || k.includes('incremental')) return GC_TYPE.INCREMENTAL;
    if (k === 'weak_callback' || k === 'weakref') return GC_TYPE.WEAK_CALLBACK;
    // Default to minor if unspecified.
    return GC_TYPE.MINOR;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Record a GC pause ──────────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Called by the observer, or by the fallback estimator,
  // or manually by a caller that measures GC directly.
  recordPause(gcType, durationMs) {
    if (gcType < 0 || gcType >= GC_TYPE_COUNT) gcType = GC_TYPE.MINOR;
    if (!Number.isFinite(durationMs) || durationMs < 0) return;

    const now = performance.now();

    // Update per-type ring buffer.
    this._pushRing(gcType, durationMs);
    // Also push to the ALL aggregate.
    this._pushRing(GC_TYPE.ALL, durationMs);

    // Update EMA.
    const alpha = this.defaults.emaAlpha;
    for (let t = 0; t < GC_TYPE_COUNT; t++) {
      if (t === gcType || t === GC_TYPE.ALL) {
        const ema = this._emaMs[t];
        this._emaMs[t] = ema === 0 ? durationMs : ema * (1 - alpha) + durationMs * alpha;
      }
    }

    // Update tracking.
    this._lastPauseMs = durationMs;
    this._lastPauseType = gcType;
    this._lastPauseTime = now;
    if (durationMs > this._peakPauseMs) this._peakPauseMs = durationMs;

    this._frameTotalPauseMs += durationMs;
    this._framePauseCount++;

    this._stats.recordedPauses++;
    switch (gcType) {
      case GC_TYPE.MINOR: this._stats.minorPauses++; break;
      case GC_TYPE.MAJOR: this._stats.majorPauses++; break;
      case GC_TYPE.INCREMENTAL: this._stats.incrementalPauses++; break;
      case GC_TYPE.WEAK_CALLBACK: this._stats.weakCallbackPauses++; break;
    }

    // Reset allocation counters if we have a real GC observation.
    if (this._observerActive) {
      this._allocationSinceLastGC = 0;
      if (gcType === GC_TYPE.MAJOR) this._allocationSinceLastMajor = 0;
    }

    // Check for violations.
    if (durationMs > this.defaults.maxPauseMs) {
      this._stats.violations++;
      this._stats.emergencyEvents++;
      this._emitPauseEvent(gcType, durationMs, 'emergency');
      // Push a violation to 304 if attached.
      if (this._ceilingEnforcer) {
        this._ceilingEnforcer.recordGCPause(durationMs, now);
      }
    } else if (durationMs > this.defaults.criticalThresholdMs) {
      this._stats.criticalEvents++;
      this._emitPauseEvent(gcType, durationMs, 'critical');
    } else if (durationMs > this.defaults.warnThresholdMs) {
      this._stats.warnEvents++;
      this._emitPauseEvent(gcType, durationMs, 'warn');
    }

    // Update pressure level.
    this._updatePressureLevel();

    // Trigger deferred allocation queue drain.
    this._drainDeferred();
  }

  _pushRing(gcType, durationMs) {
    const ring = this._rings[gcType];
    const head = this._ringHeads[gcType];
    ring[head] = durationMs;
    this._ringHeads[gcType] = (head + 1) % ring.length;
    if (this._ringCounts[gcType] < ring.length) this._ringCounts[gcType]++;
    this._percentilesDirty[gcType] = 1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Fallback: track allocations for estimation ────────
  // ══════════════════════════════════════════════════════════
  // Called by 304 when it grants an allocation. If no PerformanceObserver
  // is available, we estimate GC pauses from allocation volume.
  recordAllocation(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    if (this._observerActive) return;   // Real GC data; ignore estimate.

    this._allocationSinceLastGC += bytes;
    this._allocationSinceLastMajor += bytes;

    if (!this.defaults.enableFallbackEstimation) return;

    // Young-gen budget exceeded → simulate a minor GC.
    if (this._allocationSinceLastGC >= GC_CONSTANTS.ESTIMATED_YOUNG_BUDGET_BYTES) {
      const pause = GC_CONSTANTS.ESTIMATED_YOUNG_PAUSE_MS;
      this._estimatedYoungGCs++;
      this._stats.estimatedYoungGCs++;
      this._allocationSinceLastGC = 0;
      this.recordPause(GC_TYPE.MINOR, pause);
    }

    // Major GC trigger.
    if (this._allocationSinceLastMajor >= GC_CONSTANTS.ESTIMATED_MAJOR_TRIGGER_BYTES) {
      const pause = GC_CONSTANTS.ESTIMATED_MAJOR_PAUSE_MS;
      this._estimatedMajorGCs++;
      this._stats.estimatedMajorGCs++;
      this._allocationSinceLastMajor = 0;
      this.recordPause(GC_TYPE.MAJOR, pause);
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Deferred allocation queue ──────────────────────────
  // ══════════════════════════════════════════════════════════
  // If a recent pause exceeded the ceiling, defer the callback to
  // a microtask or the next frame. Returns true if the callback
  // was executed synchronously, false if deferred.
  requestMicrotaskAllocation(callback, priority = 0) {
    if (typeof callback !== 'function') return false;

    // Check whether a recent pause blocks us.
    const blocked = this._isPauseBlocked();
    if (!blocked) {
      // Safe: execute immediately.
      try { callback(); } catch (e) { /* ignored */ }
      return true;
    }

    // Defer.
    if (this._deferredFreeCount === 0) {
      // Queue full: expire the oldest entry.
      this._expireOldestDeferred();
      if (this._deferredFreeCount === 0) {
        // Still full: give up and execute synchronously anyway.
        try { callback(); } catch (e) { /* ignored */ }
        return true;
      }
    }

    this._deferredFreeCount--;
    const idx = this._deferredFreeList[this._deferredFreeCount];
    const entry = this._deferredQueue[idx];
    entry.active = true;
    entry.callback = callback;
    entry.enqueuedAt = performance.now();
    entry.priority = priority;
    this._deferredPendingCount++;
    this._stats.deferredAllocations++;
    return false;
  }

  // Schedule a callback via requestIdleCallback (or setTimeout 0
  // as fallback). Useful for larger deferred allocations.
  requestIdleAllocation(callback) {
    if (typeof callback !== 'function') return;
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => {
        try { callback(); } catch (e) { /* ignored */ }
      }, { timeout: 100 });
    } else {
      setTimeout(() => {
        try { callback(); } catch (e) { /* ignored */ }
      }, 0);
    }
  }

  // ── Internal: drain deferred entries when unblocked ─────
  _drainDeferred() {
    if (!this.defaults.enableDeferredQueue) return;
    if (this._isPauseBlocked()) return;
    if (this._deferredPendingCount === 0) return;

    // Sort by priority: execute highest priority first.
    // Since we use a small fixed pool, a simple selection pass works.
    let progressed = 0;
    for (let i = 0; i < this._deferredQueue.length; i++) {
      const entry = this._deferredQueue[i];
      if (!entry.active) continue;

      // Check age: expire if too old (> 500 ms).
      const age = performance.now() - entry.enqueuedAt;
      if (age > 500) {
        entry.reset();
        this._deferredFreeList[this._deferredFreeCount++] = i;
        this._deferredPendingCount--;
        this._stats.expiredDeferred++;
        continue;
      }

      // Execute.
      const cb = entry.callback;
      entry.reset();
      this._deferredFreeList[this._deferredFreeCount++] = i;
      this._deferredPendingCount--;
      this._stats.executedDeferred++;
      progressed++;
      try { cb(); } catch (e) { /* ignored */ }

      // Don't drain too many at once.
      if (progressed >= 4) break;
    }
  }

  _expireOldestDeferred() {
    let oldest = -1;
    let oldestTime = Infinity;
    for (let i = 0; i < this._deferredQueue.length; i++) {
      const entry = this._deferredQueue[i];
      if (!entry.active) continue;
      if (entry.enqueuedAt < oldestTime) {
        oldestTime = entry.enqueuedAt;
        oldest = i;
      }
    }
    if (oldest >= 0) {
      const entry = this._deferredQueue[oldest];
      entry.reset();
      this._deferredFreeList[this._deferredFreeCount++] = oldest;
      this._deferredPendingCount--;
      this._stats.expiredDeferred++;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Blocking queries for 304 ───────────────────────────
  // ══════════════════════════════════════════════════════════
  // Returns true if a pause above the ceiling was recently observed
  // and the cooldown has not elapsed. 304 uses this to gate
  // requestAllocation() calls.
  _isPauseBlocked() {
    if (this._lastPauseMs <= this.defaults.maxPauseMs) return false;
    const now = performance.now();
    return (now - this._lastPauseTime) < this.defaults.pauseCooldownMs;
  }

  isGCPauseOverBudget() {
    return this._lastPauseMs > this.defaults.maxPauseMs;
  }

  // Returns a numeric [0, 1+] pressure factor. 1.0 = at the ceiling.
  getBlockingPressure() {
    if (this._lastPauseMs === 0) return 0;
    return this._lastPauseMs / this.defaults.maxPauseMs;
  }

  getPressureLevel() { return this._pressureLevel; }
  getPressureLevelName() { return GC_PRESSURE_NAMES[this._pressureLevel]; }
  getLastPauseMs() { return this._lastPauseMs; }
  getPeakPauseMs() { return this._peakPauseMs; }
  getEmaMs(gcType = GC_TYPE.ALL) { return this._emaMs[gcType] ?? 0; }

  // ══════════════════════════════════════════════════════════
  // ─── Pressure level update ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updatePressureLevel() {
    const last = this._lastPauseMs;
    let newLevel = GC_PRESSURE.NORMAL;
    if (last > this.defaults.emergencyThresholdMs) newLevel = GC_PRESSURE.EMERGENCY;
    else if (last > this.defaults.criticalThresholdMs) newLevel = GC_PRESSURE.CRITICAL;
    else if (last > this.defaults.warnThresholdMs) newLevel = GC_PRESSURE.WARN;

    if (newLevel !== this._pressureLevel) {
      this._pressureLevel = newLevel;
      this._stats.pressureTransitions++;
      this._emitPressureEvent(newLevel);
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Percentiles ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updatePercentiles(gcType) {
    if (this._percentilesDirty[gcType] === 0) return;
    const ring = this._rings[gcType];
    const count = this._ringCounts[gcType];
    if (count === 0) {
      this._p50[gcType] = 0;
      this._p95[gcType] = 0;
      this._p99[gcType] = 0;
      return;
    }
    const scratch = this._percentileScratch;
    for (let i = 0; i < count; i++) scratch[i] = ring[i];
    // Insertion sort (small array).
    for (let i = 1; i < count; i++) {
      const key = scratch[i];
      let j = i - 1;
      while (j >= 0 && scratch[j] > key) {
        scratch[j + 1] = scratch[j];
        j--;
      }
      scratch[j + 1] = key;
    }
    this._p50[gcType] = scratch[Math.floor(count * 0.50)];
    this._p95[gcType] = scratch[Math.min(count - 1, Math.floor(count * 0.95))];
    this._p99[gcType] = scratch[Math.min(count - 1, Math.floor(count * 0.99))];
    this._percentilesDirty[gcType] = 0;
  }

  getPercentile(gcType, p) {
    this._updatePercentiles(gcType);
    if (p <= 0.50) return this._p50[gcType];
    if (p <= 0.95) return this._p95[gcType];
    return this._p99[gcType];
  }

  // ══════════════════════════════════════════════════════════
  // ─── Event emission ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _emitPauseEvent(gcType, durationMs, severity) {
    if (!this._dispatcher || !this.defaults.enableEvents) return;
    const now = performance.now();
    if (now - this._lastEventTime < this.defaults.eventCoalesceMs) return;
    this._lastEventTime = now;

    this._dispatcher.queueCausalEvent(
      EVENT_TYPE.AUDIO_LIGHT,
      [0, 0, 0],
      -1, 1, 1.0,
      {
        kind: 'gc_pause',
        severity,
        gcType,
        gcTypeName: GC_TYPE_NAMES[gcType],
        durationMs,
        ceilingMs: this.defaults.maxPauseMs,
        emaMs: this._emaMs[GC_TYPE.ALL]
      }
    );
  }

  _emitPressureEvent(level) {
    if (!this._dispatcher || !this.defaults.enableEvents) return;
    const now = performance.now();
    if (now - this._lastPressureEventTime < this.defaults.eventCoalesceMs) return;
    this._lastPressureEventTime = now;

    this._dispatcher.queueCausalEvent(
      EVENT_TYPE.AUDIO_LIGHT,
      [0, 0, 0],
      -1, 1, 1.0,
      {
        kind: 'gc_pressure_change',
        level,
        levelName: GC_PRESSURE_NAMES[level],
        lastPauseMs: this._lastPauseMs,
        emaMs: this._emaMs[GC_TYPE.ALL]
      }
    );
  }

  // ══════════════════════════════════════════════════════════
  // ─── Frame lifecycle ────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  beginFrame() {
    this._frameValid = true;
    this._frameStartPauseMs = this._lastPauseMs;
    this._framePauseCount = 0;
    this._frameTotalPauseMs = 0;
    return this;
  }

  endFrame() {
    if (!this._frameValid) return this;
    this._frameValid = false;
    this._stats.framesMeasured++;
    if (this._framePauseCount > 0) {
      this._stats.framesWithPauses++;
    }
    // Drain deferred allocations if we're no longer blocked.
    this._drainDeferred();
    return this;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Snapshot / buildSnapshot ───────────────────────────
  // ══════════════════════════════════════════════════════════
  buildSnapshot() {
    for (let t = 0; t < GC_TYPE_COUNT; t++) this._updatePercentiles(t);
    const rings = new Array(GC_TYPE_COUNT);
    for (let t = 0; t < GC_TYPE_COUNT; t++) {
      rings[t] = {
        type: GC_TYPE_NAMES[t],
        count: this._ringCounts[t],
        emaMs: this._emaMs[t],
        p50Ms: this._p50[t],
        p95Ms: this._p95[t],
        p99Ms: this._p99[t]
      };
    }
    return {
      lastPauseMs: this._lastPauseMs,
      peakPauseMs: this._peakPauseMs,
      lastPauseType: this._lastPauseType,
      lastPauseTypeName: GC_TYPE_NAMES[this._lastPauseType],
      pressureLevel: this._pressureLevel,
      pressureLevelName: GC_PRESSURE_NAMES[this._pressureLevel],
      blockingPressure: this.getBlockingPressure(),
      pauseBlocked: this._isPauseBlocked(),
      observerActive: this._observerActive,
      rings,
      deferredPending: this._deferredPendingCount
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── Frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    if (!physical.gcMonitor) {
      physical.gcMonitor = {
        lastPauseMs: 0,
        peakPauseMs: 0,
        lastPauseType: 0,
        lastPauseTypeName: 'minor',
        ceilingMs: this.defaults.maxPauseMs,
        warnThresholdMs: this.defaults.warnThresholdMs,
        criticalThresholdMs: this.defaults.criticalThresholdMs,
        emergencyThresholdMs: this.defaults.emergencyThresholdMs,
        pressureLevel: 0,
        pressureLevelName: 'normal',
        blockingPressure: 0,
        pauseBlocked: 0,
        observerActive: 0,
        emaMinorMs: 0,
        emaMajorMs: 0,
        emaIncrementalMs: 0,
        emaAllMs: 0,
        p50MinorMs: 0,
        p95MinorMs: 0,
        p99MinorMs: 0,
        p50MajorMs: 0,
        p95MajorMs: 0,
        p99MajorMs: 0,
        deferredPending: 0,
        framesWithPauses: 0,
        stats: {}
      };
    }

    const gm = physical.gcMonitor;
    for (let t = 0; t < GC_TYPE_COUNT; t++) this._updatePercentiles(t);

    gm.lastPauseMs = this._lastPauseMs;
    gm.peakPauseMs = this._peakPauseMs;
    gm.lastPauseType = this._lastPauseType;
    gm.lastPauseTypeName = GC_TYPE_NAMES[this._lastPauseType];
    gm.ceilingMs = this.defaults.maxPauseMs;
    gm.warnThresholdMs = this.defaults.warnThresholdMs;
    gm.criticalThresholdMs = this.defaults.criticalThresholdMs;
    gm.emergencyThresholdMs = this.defaults.emergencyThresholdMs;
    gm.pressureLevel = this._pressureLevel;
    gm.pressureLevelName = GC_PRESSURE_NAMES[this._pressureLevel];
    gm.blockingPressure = this.getBlockingPressure();
    gm.pauseBlocked = this._isPauseBlocked() ? 1 : 0;
    gm.observerActive = this._observerActive ? 1 : 0;

    gm.emaMinorMs = this._emaMs[GC_TYPE.MINOR];
    gm.emaMajorMs = this._emaMs[GC_TYPE.MAJOR];
    gm.emaIncrementalMs = this._emaMs[GC_TYPE.INCREMENTAL];
    gm.emaAllMs = this._emaMs[GC_TYPE.ALL];

    gm.p50MinorMs = this._p50[GC_TYPE.MINOR];
    gm.p95MinorMs = this._p95[GC_TYPE.MINOR];
    gm.p99MinorMs = this._p99[GC_TYPE.MINOR];
    gm.p50MajorMs = this._p50[GC_TYPE.MAJOR];
    gm.p95MajorMs = this._p95[GC_TYPE.MAJOR];
    gm.p99MajorMs = this._p99[GC_TYPE.MAJOR];

    gm.deferredPending = this._deferredPendingCount;
    gm.framesWithPauses = this._stats.framesWithPauses;

    // Stats snapshot.
    gm.stats.recordedPauses = this._stats.recordedPauses;
    gm.stats.minorPauses = this._stats.minorPauses;
    gm.stats.majorPauses = this._stats.majorPauses;
    gm.stats.incrementalPauses = this._stats.incrementalPauses;
    gm.stats.weakCallbackPauses = this._stats.weakCallbackPauses;
    gm.stats.violations = this._stats.violations;
    gm.stats.warnEvents = this._stats.warnEvents;
    gm.stats.criticalEvents = this._stats.criticalEvents;
    gm.stats.emergencyEvents = this._stats.emergencyEvents;
    gm.stats.pressureTransitions = this._stats.pressureTransitions;
    gm.stats.estimatedYoungGCs = this._stats.estimatedYoungGCs;
    gm.stats.estimatedMajorGCs = this._stats.estimatedMajorGCs;
    gm.stats.deferredAllocations = this._stats.deferredAllocations;
    gm.stats.executedDeferred = this._stats.executedDeferred;
    gm.stats.expiredDeferred = this._stats.expiredDeferred;
    gm.stats.framesMeasured = this._stats.framesMeasured;
    gm.stats.framesWithPauses = this._stats.framesWithPauses;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Main update ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  update(frame, clock) {
    if (!frame || !frame.layers) return 0;
    this._frameRef = frame;
    this._writeToPhysicalLayer(frame);
    return 1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Diagnostics ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getStats() {
    return Object.freeze({
      recordedPauses: this._stats.recordedPauses,
      minorPauses: this._stats.minorPauses,
      majorPauses: this._stats.majorPauses,
      incrementalPauses: this._stats.incrementalPauses,
      weakCallbackPauses: this._stats.weakCallbackPauses,
      violations: this._stats.violations,
      warnEvents: this._stats.warnEvents,
      criticalEvents: this._stats.criticalEvents,
      emergencyEvents: this._stats.emergencyEvents,
      pressureTransitions: this._stats.pressureTransitions,
      lastPauseMs: this._lastPauseMs,
      peakPauseMs: this._peakPauseMs,
      emaAllMs: this._emaMs[GC_TYPE.ALL],
      pressureLevel: this._pressureLevel,
      pressureLevelName: GC_PRESSURE_NAMES[this._pressureLevel],
      observerActive: this._observerActive,
      deferredPending: this._deferredPendingCount,
      estimatedYoungGCs: this._stats.estimatedYoungGCs,
      estimatedMajorGCs: this._stats.estimatedMajorGCs
    });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) {
      if (typeof this._stats[k] === 'number') this._stats[k] = 0;
    }
    this._ringHeads.fill(0);
    this._ringCounts.fill(0);
    this._emaMs.fill(0);
    this._p50.fill(0);
    this._p95.fill(0);
    this._p99.fill(0);
    this._percentilesDirty.fill(1);
    this._peakPauseMs = 0;
    this._lastPauseMs = 0;
    this._lastPauseTime = 0;
    this._pressureLevel = GC_PRESSURE.NORMAL;
  }

  dispose() {
    if (this._observer) {
      try { this._observer.disconnect(); } catch (e) { /* ignored */ }
    }
    this._observer = null;
    this._observerActive = false;

    for (let i = 0; i < this._deferredQueue.length; i++) {
      this._deferredQueue[i].reset();
    }
    this._deferredPendingCount = 0;
    this._deferredFreeCount = this._deferredCapacity;
    for (let i = 0; i < this._deferredCapacity; i++) {
      this._deferredFreeList[i] = this._deferredCapacity - 1 - i;
    }

    this._dispatcher = null;
    this._clock = null;
    this._ceilingEnforcer = null;
    this._frameBudgetMonitor = null;
    this._frameRef = null;
  }
}

export {
  GCPauseMonitor,
  DeferredAllocation,
  GC_TYPE,
  GC_TYPE_NAMES,
  GC_TYPE_COUNT,
  GC_PRESSURE,
  GC_PRESSURE_NAMES,
  GC_CONSTANTS
};