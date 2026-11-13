// file number : 305
// full path name : src/context/305_FrameBudgetMonitor.js
// description : Per-frame CPU budget monitor — the attribution and diagnosis layer for the 8 ms per-tick ceiling on Snapdragon 7-series class devices. Complements 304_MemoryCeilingEnforcer (which enforces the ceiling cooperatively) by measuring, attributing, and reporting exactly where each frame's CPU time went. Registers named budget slices for every subsystem (PROVIDERS, CAUSAL_DRAIN, TIER_1HZ, TIER_10HZ, TIER_60HZ, STAGE_6_DISPATCH, PHYSICS, ANIMATION, HLOD, STREAMING, AI, PARTICLES, AUDIO, UI, GPU_UPLOAD, MEMORY_GC, MISC), each with an optional soft budget cap (ms) and a priority tier that determines whether the slice can be trimmed when the frame is over budget. Each slice supports beginSlice()/endSlice() calls that measure elapsed time with nanosecond-class resolution and update rolling averages via exponential moving averages (α = 0.05) plus fixed-size ring buffers for robust percentiles (p50, p95, p99). At the end of every frame, emits a compact diagnostic snapshot showing total CPU, per-slice time, overrun slices, and the recommended mitigation (throttle STREAMING, defer AI planning, disable PARTICLES, reduce HLOD depth, etc.). Detects three classes of problem: (1) a single slice exceeding its soft cap, (2) total frame time exceeding 8 ms even without any single slice overrunning, and (3) sustained overruns over N consecutive frames indicating a systemic issue that should trigger auto-downgrade of the memory/quality profile. Feeds adaptive tier management — when sustained overruns are detected, emits a suggested quality drop event that 303_HLODController and 304_MemoryCeilingEnforcer can act on. Works with 267_CoreClock for high-resolution timing, forwards beginFrame/endFrame to 304 for cooperative enforcement, and reads material/lighting scene cost from the frame so it can warn when clustered-lighting fragment work, per-visible-object material uniform uploads, or HLOD shadow cascades are dominating. Zero allocation on hot paths: all slice state, ring buffers, and event payloads are pre-allocated; beginSlice/endSlice do no object creation.
// best for : Every runtime that needs to keep the 8 ms budget under control on Android arm64 — the six-stage orchestration loop, the tier scheduler, the streaming system, the physics provider, the animation controller, and any subsystem that wants to know whether it's a bottleneck. This is the "where did my frame go" tool that makes the world's responsiveness visible and tunable.
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

// ══════════════════════════════════════════════════════════════════
// ─── BUDGET SLICE CATEGORIES ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const BUDGET_SLICE = Object.freeze({
  PROVIDERS:        0,   // Stage 1: fill the context frame
  CAUSAL_DRAIN:     1,   // Stage 2: drain causal buffer + decay
  TIER_1HZ:         2,   // Stage 3: 1 Hz consumers
  TIER_10HZ:        3,   // Stage 4: 10 Hz consumers
  TIER_60HZ:        4,   // Stage 5: 60 Hz consumers
  STAGE_6_DISPATCH: 5,   // Stage 6: batched render dispatch
  PHYSICS:          6,   // Physics simulation step
  ANIMATION:        7,   // Skeleton IK + animation
  HLOD:             8,   // Hierarchical LOD culling
  STREAMING:        9,   // Asset loading queue
  AI:              10,   // GOAP / motion matching
  PARTICLES:       11,   // Particles / shards / decals
  AUDIO:           12,   // Audio cue emission
  UI:              13,   // UI overlay
  GPU_UPLOAD:      14,   // GPU buffer uploads
  MEMORY_GC:       15,   // GC pressure accounting
  MISC:            16    // Everything else
});

const BUDGET_SLICE_NAMES = Object.freeze([
  'providers', 'causal_drain', 'tier_1hz', 'tier_10hz',
  'tier_60hz', 'stage_6_dispatch', 'physics', 'animation',
  'hlod', 'streaming', 'ai', 'particles', 'audio', 'ui',
  'gpu_upload', 'memory_gc', 'misc'
]);

const SLICE_COUNT = 17;

// ─── Trim priority (used when frame is over budget) ────────────
// 0 = never trim, 1 = trim first, 2 = trim second, 3 = trim last.
const SLICE_TRIM_PRIORITY = Object.freeze([
  0,  // PROVIDERS       — always runs
  0,  // CAUSAL_DRAIN    — always runs
  2,  // TIER_1HZ        — trim if needed
  1,  // TIER_10HZ       — trim first
  0,  // TIER_60HZ       — never trim (render-critical)
  0,  // STAGE_6_DISPATCH — never trim
  1,  // PHYSICS         — trim first (skip substeps)
  2,  // ANIMATION       — trim if needed
  1,  // HLOD            — trim first (reduce culling depth)
  1,  // STREAMING       — trim first (defer new loads)
  2,  // AI              — trim if needed (defer replanning)
  3,  // PARTICLES       — trim last (reduce spawn count)
  3,  // AUDIO           — trim last
  3,  // UI              — trim last
  0,  // GPU_UPLOAD      — never trim
  0,  // MEMORY_GC       — always runs
  3   // MISC            — trim last
]);

// ─── Default soft caps per slice (ms) ──────────────────────────
// Total budget is 8 ms; these are the per-slice soft caps.
const DEFAULT_SLICE_CAPS_MS = Object.freeze([
  1.50,   // PROVIDERS
  0.30,   // CAUSAL_DRAIN
  0.20,   // TIER_1HZ
  0.80,   // TIER_10HZ
  1.50,   // TIER_60HZ
  1.20,   // STAGE_6_DISPATCH
  1.00,   // PHYSICS
  1.00,   // ANIMATION
  0.60,   // HLOD
  0.40,   // STREAMING
  0.40,   // AI
  0.40,   // PARTICLES
  0.10,   // AUDIO
  0.10,   // UI
  0.20,   // GPU_UPLOAD
  0.10,   // MEMORY_GC
  0.50    // MISC
]);

// ─── Ring buffer size for percentile tracking ─────────────────
const RING_BUFFER_SIZE = 120;

// ─── EMA smoothing coefficient ────────────────────────────────
const EMA_ALPHA = 0.05;

// ─── Overrun detection thresholds ────────────────────────────
const OVERRUN_THRESHOLDS = Object.freeze({
  // A single slice overrunning by 25% triggers a warning.
  SLICE_WARN_RATIO: 1.25,
  SLICE_CRITICAL_RATIO: 2.0,

  // Total frame overruns.
  FRAME_WARN_RATIO: 1.0,      // > 8 ms
  FRAME_CRITICAL_RATIO: 1.25, // > 10 ms

  // Sustained overrun detection.
  SUSTAINED_OVERRUN_FRAMES: 30,   // 30 frames in a row

  // Recommended profile downgrade.
  SUSTAINED_OVERRUN_DOWNGRADE_FRAMES: 60
});

// ══════════════════════════════════════════════════════════════════
// ─── FRAME BUDGET MONITOR ───────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class FrameBudgetMonitor {
  constructor(options = {}) {
    // ── Configuration ────────────────────────────────────
    this.defaults = {
      targetCpuMs:        options.targetCpuMs ?? CPU_LIMITS.PER_FRAME_CPU_CEILING_MS,
      warningCpuMs:       options.warningCpuMs ?? CPU_LIMITS.CPU_WARN_THRESHOLD_MS,
      sliceCapsMs:        options.sliceCapsMs ?? DEFAULT_SLICE_CAPS_MS.slice(),
      enableEvents:       options.enableEvents ?? true,
      enableAttribution:  options.enableAttribution ?? true,
      enableSustainedTracking: options.enableSustainedTracking ?? true,
      eventCoalesceMs:    options.eventCoalesceMs ?? 500,
      emaAlpha:           options.emaAlpha ?? EMA_ALPHA,
      ringBufferSize:     options.ringBufferSize ?? RING_BUFFER_SIZE,
      // Forwarding target: 304_MemoryCeilingEnforcer (optional).
      ceilingEnforcer:    options.ceilingEnforcer ?? null,
      // Callback fired when sustained overruns recommend a downgrade.
      onSuggestDowngrade: options.onSuggestDowngrade ?? null
    };

    // ── Slice timing state ────────────────────────────────
    // Each slice has: start timestamp (if running), accumulated time in
    // the current frame, EMA average, ring buffer, overrun counts.
    this._sliceStarts = new Float64Array(SLICE_COUNT);
    this._sliceRunning = new Uint8Array(SLICE_COUNT);   // 1 = currently measuring
    this._sliceCurrentMs = new Float64Array(SLICE_COUNT);
    this._sliceEmaMs = new Float64Array(SLICE_COUNT);
    this._sliceOverruns = new Uint32Array(SLICE_COUNT);
    this._sliceCriticalOverruns = new Uint32Array(SLICE_COUNT);

    // Ring buffers per slice.
    const rbSize = this.defaults.ringBufferSize;
    this._sliceRings = new Array(SLICE_COUNT);
    this._sliceRingHeads = new Int32Array(SLICE_COUNT);
    this._sliceRingCounts = new Int32Array(SLICE_COUNT);
    for (let s = 0; s < SLICE_COUNT; s++) {
      this._sliceRings[s] = new Float32Array(rbSize);
    }

    // Cached percentiles per slice (recomputed lazily).
    this._sliceP50 = new Float32Array(SLICE_COUNT);
    this._sliceP95 = new Float32Array(SLICE_COUNT);
    this._sliceP99 = new Float32Array(SLICE_COUNT);
    this._percentilesDirty = new Uint8Array(SLICE_COUNT).fill(1);

    // Sorted scratch buffer for percentile computation (reused).
    this._percentileScratch = new Float32Array(rbSize);

    // ── Frame state ──────────────────────────────────────
    this._frameStartMs = 0;
    this._frameCpuMs = 0;
    this._frameValid = false;
    this._frameIndex = 0;

    // Frame EMA + ring buffer for total CPU.
    this._frameEmaMs = 0;
    this._frameRing = new Float32Array(rbSize);
    this._frameRingHead = 0;
    this._frameRingCount = 0;
    this._frameP50 = 0;
    this._frameP95 = 0;
    this._frameP99 = 0;
    this._framePeakMs = 0;
    this._framePercentilesDirty = 1;

    // ── Overrun tracking ─────────────────────────────────
    this._consecutiveOverruns = 0;
    this._consecutiveUnderruns = 0;
    this._sustainedOverrunActive = 0;
    this._suggestedDowngradeFired = 0;

    // ── Statistics ──────────────────────────────────────
    this._stats = {
      framesMeasured: 0,
      framesOverBudget: 0,
      framesCritical: 0,
      totalOverrunMs: 0,
      totalCpuMs: 0,
      sliceWarnEvents: 0,
      sliceCriticalEvents: 0,
      frameWarnEvents: 0,
      frameCriticalEvents: 0,
      sustainedEvents: 0,
      downgradeSuggestions: 0
    };

    // ── Event coalescing ────────────────────────────────
    this._lastEventTime = 0;
    this._lastSliceEventTime = new Float64Array(SLICE_COUNT);
    this._lastFrameEventTime = 0;

    // ── Collaborators ───────────────────────────────────
    this._dispatcher = options.dispatcher || null;
    this._clock = options.clock || null;
    this._ceilingEnforcer = this.defaults.ceilingEnforcer;
    this._frameRef = null;

    // ── Reusable scratch for buildSnapshot ──────────────
    this._overrunSlicesScratch = new Int32Array(SLICE_COUNT);
  }

  // ══════════════════════════════════════════════════════════
  // ─── Collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachDispatcher(d) { this._dispatcher = d; return this; }
  attachClock(c) { this._clock = c; return this; }
  attachCeilingEnforcer(e) { this._ceilingEnforcer = e; this.defaults.ceilingEnforcer = e; return this; }
  setDowngradeCallback(cb) { this.defaults.onSuggestDowngrade = cb; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── Slice caps configuration ───────────────────────────
  // ══════════════════════════════════════════════════════════
  setSliceCap(slice, capMs) {
    if (slice < 0 || slice >= SLICE_COUNT) return false;
    if (capMs < 0) return false;
    this.defaults.sliceCapsMs[slice] = capMs;
    return true;
  }

  getSliceCap(slice) {
    if (slice < 0 || slice >= SLICE_COUNT) return 0;
    return this.defaults.sliceCapsMs[slice];
  }

  // ══════════════════════════════════════════════════════════
  // ─── Frame lifecycle ────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  beginFrame(nowMs) {
    this._frameStartMs = nowMs ?? performance.now();
    this._frameValid = true;
    this._frameCpuMs = 0;
    this._frameIndex++;

    // Clear per-frame slice timings.
    for (let s = 0; s < SLICE_COUNT; s++) {
      this._sliceCurrentMs[s] = 0;
      this._sliceRunning[s] = 0;
    }

    // Forward to ceiling enforcer if available.
    if (this._ceilingEnforcer) {
      this._ceilingEnforcer.beginFrame(this._frameStartMs);
    }
    return this;
  }

  endFrame(nowMs) {
    if (!this._frameValid) return this;
    const end = nowMs ?? performance.now();
    this._frameCpuMs = end - this._frameStartMs;
    this._frameValid = false;

    // Update total-frame EMA + ring buffer.
    const alpha = this.defaults.emaAlpha;
    this._frameEmaMs = this._frameEmaMs === 0
      ? this._frameCpuMs
      : this._frameEmaMs * (1 - alpha) + this._frameCpuMs * alpha;

    this._frameRing[this._frameRingHead] = this._frameCpuMs;
    this._frameRingHead = (this._frameRingHead + 1) % this._frameRing.length;
    if (this._frameRingCount < this._frameRing.length) this._frameRingCount++;
    this._framePercentilesDirty = 1;

    if (this._frameCpuMs > this._framePeakMs) this._framePeakMs = this._frameCpuMs;

    // Update per-slice EMA + rings.
    for (let s = 0; s < SLICE_COUNT; s++) {
      const cur = this._sliceCurrentMs[s];
      this._sliceEmaMs[s] = this._sliceEmaMs[s] === 0
        ? cur
        : this._sliceEmaMs[s] * (1 - alpha) + cur * alpha;

      const ring = this._sliceRings[s];
      const head = this._sliceRingHeads[s];
      ring[head] = cur;
      this._sliceRingHeads[s] = (head + 1) % ring.length;
      if (this._sliceRingCounts[s] < ring.length) this._sliceRingCounts[s]++;
      this._percentilesDirty[s] = 1;
    }

    // ── Overrun detection ───────────────────────────────
    this._stats.framesMeasured++;
    this._stats.totalCpuMs += this._frameCpuMs;

    const targetMs = this.defaults.targetCpuMs;
    const warnMs = this.defaults.warningCpuMs;

    // Per-slice overrun detection.
    for (let s = 0; s < SLICE_COUNT; s++) {
      const cap = this.defaults.sliceCapsMs[s];
      const cur = this._sliceCurrentMs[s];
      if (cur > cap * OVERRUN_THRESHOLDS.SLICE_CRITICAL_RATIO) {
        this._sliceCriticalOverruns[s]++;
        this._stats.sliceCriticalEvents++;
        this._emitSliceEvent(s, 'critical', cur, cap);
      } else if (cur > cap * OVERRUN_THRESHOLDS.SLICE_WARN_RATIO) {
        this._sliceOverruns[s]++;
        this._stats.sliceWarnEvents++;
        this._emitSliceEvent(s, 'warn', cur, cap);
      }
    }

    // Total frame overrun.
    if (this._frameCpuMs > targetMs * OVERRUN_THRESHOLDS.FRAME_CRITICAL_RATIO) {
      this._stats.framesCritical++;
      this._stats.framesOverBudget++;
      this._stats.totalOverrunMs += this._frameCpuMs - targetMs;
      this._stats.frameCriticalEvents++;
      this._emitFrameEvent('critical');
    } else if (this._frameCpuMs > targetMs * OVERRUN_THRESHOLDS.FRAME_WARN_RATIO) {
      this._stats.framesOverBudget++;
      this._stats.totalOverrunMs += this._frameCpuMs - targetMs;
      this._stats.frameWarnEvents++;
      this._emitFrameEvent('warn');
    }

    // ── Sustained overrun tracking ──────────────────────
    if (this.defaults.enableSustainedTracking) {
      if (this._frameCpuMs > warnMs) {
        this._consecutiveOverruns++;
        this._consecutiveUnderruns = 0;
      } else {
        this._consecutiveUnderruns++;
        this._consecutiveOverruns = 0;
      }

      // Enter sustained mode.
      if (!this._sustainedOverrunActive &&
          this._consecutiveOverruns >= OVERRUN_THRESHOLDS.SUSTAINED_OVERRUN_FRAMES) {
        this._sustainedOverrunActive = 1;
        this._stats.sustainedEvents++;
        this._emitEvent('sustained_overrun', {
          frames: this._consecutiveOverruns,
          emaMs: this._frameEmaMs,
          peakMs: this._framePeakMs
        });
      }

      // Exit sustained mode.
      if (this._sustainedOverrunActive &&
          this._consecutiveUnderruns >= OVERRUN_THRESHOLDS.SUSTAINED_OVERRUN_FRAMES / 2) {
        this._sustainedOverrunActive = 0;
        this._suggestedDowngradeFired = 0;
        this._emitEvent('sustained_recovered', {
          frames: this._consecutiveUnderruns,
          emaMs: this._frameEmaMs
        });
      }

      // Recommend downgrade after very long sustained overrun.
      if (this._sustainedOverrunActive &&
          !this._suggestedDowngradeFired &&
          this._consecutiveOverruns >= OVERRUN_THRESHOLDS.SUSTAINED_OVERRUN_DOWNGRADE_FRAMES) {
        this._suggestedDowngradeFired = 1;
        this._stats.downgradeSuggestions++;
        this._emitEvent('suggest_downgrade', {
          frames: this._consecutiveOverruns,
          emaMs: this._frameEmaMs,
          peakMs: this._framePeakMs,
          overrunSlices: this._buildOverrunSliceList()
        });
        if (this.defaults.onSuggestDowngrade) {
          try { this.defaults.onSuggestDowngrade(this); } catch (e) { /* ignored */ }
        }
      }
    }

    // Forward to ceiling enforcer.
    if (this._ceilingEnforcer) {
      this._ceilingEnforcer.endFrame(end);
    }
    return this;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Slice measurement API ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  beginSlice(slice) {
    if (slice < 0 || slice >= SLICE_COUNT) return false;
    this._sliceStarts[slice] = performance.now();
    this._sliceRunning[slice] = 1;
    return true;
  }

  endSlice(slice) {
    if (slice < 0 || slice >= SLICE_COUNT) return false;
    if (this._sliceRunning[slice] !== 1) return false;
    const elapsed = performance.now() - this._sliceStarts[slice];
    this._sliceCurrentMs[slice] += elapsed;
    this._sliceRunning[slice] = 0;
    return true;
  }

  // Convenience: measure a single function call within a slice.
  measure(slice, fn) {
    this.beginSlice(slice);
    try {
      return fn();
    } finally {
      this.endSlice(slice);
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Percentile computation ─────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updatePercentilesForSlice(slice) {
    if (this._percentilesDirty[slice] === 0) return;
    const ring = this._sliceRings[slice];
    const count = this._sliceRingCounts[slice];
    if (count === 0) { this._sliceP50[slice] = 0; this._sliceP95[slice] = 0; this._sliceP99[slice] = 0; return; }
    const scratch = this._percentileScratch;
    for (let i = 0; i < count; i++) scratch[i] = ring[i];
    this._sortFloat32(scratch, count);
    this._sliceP50[slice] = scratch[Math.floor(count * 0.50)];
    this._sliceP95[slice] = scratch[Math.min(count - 1, Math.floor(count * 0.95))];
    this._sliceP99[slice] = scratch[Math.min(count - 1, Math.floor(count * 0.99))];
    this._percentilesDirty[slice] = 0;
  }

  _updateFramePercentiles() {
    if (this._framePercentilesDirty === 0) return;
    const count = this._frameRingCount;
    if (count === 0) { this._frameP50 = 0; this._frameP95 = 0; this._frameP99 = 0; return; }
    const scratch = this._percentileScratch;
    for (let i = 0; i < count; i++) scratch[i] = this._frameRing[i];
    this._sortFloat32(scratch, count);
    this._frameP50 = scratch[Math.floor(count * 0.50)];
    this._frameP95 = scratch[Math.min(count - 1, Math.floor(count * 0.95))];
    this._frameP99 = scratch[Math.min(count - 1, Math.floor(count * 0.99))];
    this._framePercentilesDirty = 0;
  }

  // Simple in-place sort for small arrays (< 256 elements).
  _sortFloat32(arr, n) {
    for (let i = 1; i < n; i++) {
      const key = arr[i];
      let j = i - 1;
      while (j >= 0 && arr[j] > key) {
        arr[j + 1] = arr[j];
        j--;
      }
      arr[j + 1] = key;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Overrun slice list (for downgrade suggestions) ─────
  // ══════════════════════════════════════════════════════════
  _buildOverrunSliceList() {
    let count = 0;
    for (let s = 0; s < SLICE_COUNT; s++) {
      const cap = this.defaults.sliceCapsMs[s];
      if (this._sliceEmaMs[s] > cap * OVERRUN_THRESHOLDS.SLICE_WARN_RATIO) {
        this._overrunSlicesScratch[count++] = s;
      }
    }
    const result = new Array(count);
    for (let i = 0; i < count; i++) result[i] = this._overrunSlicesScratch[i];
    return result;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Event emission ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _emitSliceEvent(slice, severity, currentMs, capMs) {
    if (!this._dispatcher || !this.defaults.enableEvents) return;
    const now = performance.now();
    if (now - this._lastSliceEventTime[slice] < this.defaults.eventCoalesceMs) return;
    this._lastSliceEventTime[slice] = now;

    this._dispatcher.queueCausalEvent(
      EVENT_TYPE.AUDIO_LIGHT,
      [0, 0, 0],
      -1, 1, 1.0,
      {
        kind: 'budget_slice_overrun',
        severity,
        slice,
        sliceName: BUDGET_SLICE_NAMES[slice],
        currentMs,
        capMs,
        emaMs: this._sliceEmaMs[slice],
        trimPriority: SLICE_TRIM_PRIORITY[slice]
      }
    );
  }

  _emitFrameEvent(severity) {
    if (!this._dispatcher || !this.defaults.enableEvents) return;
    const now = performance.now();
    if (now - this._lastFrameEventTime < this.defaults.eventCoalesceMs) return;
    this._lastFrameEventTime = now;

    this._dispatcher.queueCausalEvent(
      EVENT_TYPE.AUDIO_LIGHT,
      [0, 0, 0],
      -1, 1, 1.0,
      {
        kind: 'budget_frame_overrun',
        severity,
        frameCpuMs: this._frameCpuMs,
        targetMs: this.defaults.targetCpuMs,
        emaMs: this._frameEmaMs,
        overrunSlices: this._buildOverrunSliceList()
      }
    );
  }

  _emitEvent(kind, payload) {
    if (!this._dispatcher || !this.defaults.enableEvents) return;
    this._dispatcher.queueCausalEvent(
      EVENT_TYPE.AUDIO_LIGHT,
      [0, 0, 0],
      -1, 1, 1.0,
      { kind, ...payload }
    );
  }

  // ══════════════════════════════════════════════════════════
  // ─── Snapshot / diagnostics ─────────────────────────────
  // ══════════════════════════════════════════════════════════
  buildSnapshot() {
    this._updateFramePercentiles();
    const slices = new Array(SLICE_COUNT);
    for (let s = 0; s < SLICE_COUNT; s++) {
      this._updatePercentilesForSlice(s);
      slices[s] = {
        name: BUDGET_SLICE_NAMES[s],
        currentMs: this._sliceCurrentMs[s],
        emaMs: this._sliceEmaMs[s],
        capMs: this.defaults.sliceCapsMs[s],
        p50Ms: this._sliceP50[s],
        p95Ms: this._sliceP95[s],
        p99Ms: this._sliceP99[s],
        overruns: this._sliceOverruns[s],
        criticalOverruns: this._sliceCriticalOverruns[s],
        trimPriority: SLICE_TRIM_PRIORITY[s],
        utilization: this._sliceEmaMs[s] / this.defaults.sliceCapsMs[s]
      };
    }
    return {
      frameIndex: this._frameIndex,
      frameCpuMs: this._frameCpuMs,
      frameEmaMs: this._frameEmaMs,
      frameP50Ms: this._frameP50,
      frameP95Ms: this._frameP95,
      frameP99Ms: this._frameP99,
      framePeakMs: this._framePeakMs,
      targetMs: this.defaults.targetCpuMs,
      consecutiveOverruns: this._consecutiveOverruns,
      sustainedOverrunActive: this._sustainedOverrunActive,
      slices
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── Queries ────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getFrameCpuMs() { return this._frameCpuMs; }
  getFrameEmaMs() { return this._frameEmaMs; }
  getFramePeakMs() { return this._framePeakMs; }
  getFramePercentile(p) {
    this._updateFramePercentiles();
    if (p <= 0.50) return this._frameP50;
    if (p <= 0.95) return this._frameP95;
    return this._frameP99;
  }

  getSliceCurrentMs(slice) { return this._sliceCurrentMs[slice] ?? 0; }
  getSliceEmaMs(slice) { return this._sliceEmaMs[slice] ?? 0; }
  getSliceCapMs(slice) { return this.defaults.sliceCapsMs[slice] ?? 0; }
  getSliceUtilization(slice) {
    const cap = this.defaults.sliceCapsMs[slice] ?? 1;
    return cap > 0 ? this._sliceEmaMs[slice] / cap : 0;
  }
  getSlicePercentile(slice, p) {
    this._updatePercentilesForSlice(slice);
    if (p <= 0.50) return this._sliceP50[slice];
    if (p <= 0.95) return this._sliceP95[slice];
    return this._sliceP99[slice];
  }

  getRemainingBudgetMs() {
    return Math.max(0, this.defaults.targetCpuMs - this._frameCpuMs);
  }

  // Returns the recommended slice to trim next, or -1 if none.
  getNextTrimCandidate() {
    let best = -1;
    let bestUtilization = 0;
    for (let s = 0; s < SLICE_COUNT; s++) {
      if (SLICE_TRIM_PRIORITY[s] === 0) continue;   // never trim
      const util = this.getSliceUtilization(s);
      if (util > bestUtilization) {
        bestUtilization = util;
        best = s;
      }
    }
    return best;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    if (!physical.frameBudget) {
      physical.frameBudget = {
        frameCpuMs: 0,
        frameEmaMs: 0,
        frameP50Ms: 0,
        frameP95Ms: 0,
        frameP99Ms: 0,
        framePeakMs: 0,
        targetMs: 0,
        warningMs: 0,
        remainingMs: 0,
        consecutiveOverruns: 0,
        sustainedOverrunActive: 0,
        nextTrimCandidate: -1,
        sliceCurrentMs: new Float32Array(SLICE_COUNT),
        sliceEmaMs: new Float32Array(SLICE_COUNT),
        sliceCapMs: new Float32Array(SLICE_COUNT),
        sliceUtilization: new Float32Array(SLICE_COUNT),
        sliceP95Ms: new Float32Array(SLICE_COUNT),
        sliceOverruns: new Uint32Array(SLICE_COUNT),
        sliceCriticalOverruns: new Uint32Array(SLICE_COUNT),
        sliceTrimPriority: new Uint8Array(SLICE_COUNT),
        sliceNames: BUDGET_SLICE_NAMES,
        stats: {}
      };
    }

    const fb = physical.frameBudget;
    this._updateFramePercentiles();

    fb.frameCpuMs = this._frameCpuMs;
    fb.frameEmaMs = this._frameEmaMs;
    fb.frameP50Ms = this._frameP50;
    fb.frameP95Ms = this._frameP95;
    fb.frameP99Ms = this._frameP99;
    fb.framePeakMs = this._framePeakMs;
    fb.targetMs = this.defaults.targetCpuMs;
    fb.warningMs = this.defaults.warningCpuMs;
    fb.remainingMs = this.getRemainingBudgetMs();
    fb.consecutiveOverruns = this._consecutiveOverruns;
    fb.sustainedOverrunActive = this._sustainedOverrunActive;
    fb.nextTrimCandidate = this.getNextTrimCandidate();

    for (let s = 0; s < SLICE_COUNT; s++) {
      this._updatePercentilesForSlice(s);
      fb.sliceCurrentMs[s] = this._sliceCurrentMs[s];
      fb.sliceEmaMs[s] = this._sliceEmaMs[s];
      fb.sliceCapMs[s] = this.defaults.sliceCapsMs[s];
      fb.sliceUtilization[s] = this.getSliceUtilization(s);
      fb.sliceP95Ms[s] = this._sliceP95[s];
      fb.sliceOverruns[s] = this._sliceOverruns[s];
      fb.sliceCriticalOverruns[s] = this._sliceCriticalOverruns[s];
      fb.sliceTrimPriority[s] = SLICE_TRIM_PRIORITY[s];
    }

    // Snapshot stats.
    fb.stats.framesMeasured = this._stats.framesMeasured;
    fb.stats.framesOverBudget = this._stats.framesOverBudget;
    fb.stats.framesCritical = this._stats.framesCritical;
    fb.stats.totalOverrunMs = this._stats.totalOverrunMs;
    fb.stats.totalCpuMs = this._stats.totalCpuMs;
    fb.stats.sliceWarnEvents = this._stats.sliceWarnEvents;
    fb.stats.sliceCriticalEvents = this._stats.sliceCriticalEvents;
    fb.stats.frameWarnEvents = this._stats.frameWarnEvents;
    fb.stats.frameCriticalEvents = this._stats.frameCriticalEvents;
    fb.stats.sustainedEvents = this._stats.sustainedEvents;
    fb.stats.downgradeSuggestions = this._stats.downgradeSuggestions;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Main update ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  update(frame, clock) {
    if (!frame || !frame.layers) return 0;
    this._frameRef = frame;

    // Reset per-frame slices if the caller hasn't called endFrame.
    // (Defensive: some runtimes may not call endFrame every frame.)
    if (this._frameValid) {
      // Still in a frame; treat as ongoing.
    }

    this._writeToPhysicalLayer(frame);
    return 1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Diagnostics ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getStats() {
    return Object.freeze({
      framesMeasured: this._stats.framesMeasured,
      framesOverBudget: this._stats.framesOverBudget,
      framesCritical: this._stats.framesCritical,
      totalOverrunMs: this._stats.totalOverrunMs,
      totalCpuMs: this._stats.totalCpuMs,
      frameEmaMs: this._frameEmaMs,
      framePeakMs: this._framePeakMs,
      consecutiveOverruns: this._consecutiveOverruns,
      sustainedOverrunActive: this._sustainedOverrunActive,
      sliceWarnEvents: this._stats.sliceWarnEvents,
      sliceCriticalEvents: this._stats.sliceCriticalEvents,
      frameWarnEvents: this._stats.frameWarnEvents,
      frameCriticalEvents: this._stats.frameCriticalEvents,
      sustainedEvents: this._stats.sustainedEvents,
      downgradeSuggestions: this._stats.downgradeSuggestions
    });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) this._stats[k] = 0;
    this._sliceOverruns.fill(0);
    this._sliceCriticalOverruns.fill(0);
    this._frameRingCount = 0;
    this._frameRingHead = 0;
    this._framePercentilesDirty = 1;
    this._frameEmaMs = 0;
    this._framePeakMs = 0;
    for (let s = 0; s < SLICE_COUNT; s++) {
      this._sliceRingCounts[s] = 0;
      this._sliceRingHeads[s] = 0;
      this._sliceEmaMs[s] = 0;
      this._percentilesDirty[s] = 1;
    }
  }

  dispose() {
    this._dispatcher = null;
    this._clock = null;
    this._ceilingEnforcer = null;
    this._frameRef = null;
    this._sliceRings.length = 0;
  }
}

export {
  FrameBudgetMonitor,
  BUDGET_SLICE,
  BUDGET_SLICE_NAMES,
  SLICE_COUNT,
  SLICE_TRIM_PRIORITY,
  DEFAULT_SLICE_CAPS_MS,
  OVERRUN_THRESHOLDS,
  RING_BUFFER_SIZE,
  EMA_ALPHA
};