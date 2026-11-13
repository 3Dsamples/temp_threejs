// file number : 270
// full path name : src/context/270_ExtrasTimerUtils.js
// description : High-resolution timer utilities for the three-tier scheduler. Wraps THREE.Timer (086_Timer) from 264_MathECSImportBarrel into pooled, zero-allocation timer slots. Provides CPU-budget tracking against the 8 ms Snapdragon 7-series ceiling, zero-allocation periodic callback gating with per-slot interval and jitter compensation, phase-offset scheduling to spread work across frames, and a fixed-capacity timer pool that never allocates inside the frame loop.
// best for : Tier gating for the 60/10/1 Hz scheduler, per-system CPU budget enforcement, periodic diagnostic sampling, and any subsystem that needs a cheap start/stop/elapsed cycle without triggering garbage collection on Android arm64.
// license : MIT

import {
  Timer,
  Precision,
  CoreClock,
  CoreEventDispatcher,
  Vec3,
  Vec4,
  Mat4,
  Quat
} from './264_MathECSImportBarrel.js';

// ─── hard limits from the blueprint ──────────────────────────────
const CPU_BUDGET_SECONDS = 0.008;   // 8 ms per-tick CPU ceiling
const GC_BUDGET_SECONDS = 0.002;    // 2 ms GC pause ceiling
const DEFAULT_POOL_SIZE = 256;

// ─── timer slot states ───────────────────────────────────────────
const SLOT_FREE = 0;
const SLOT_ACTIVE = 1;
const SLOT_PAUSED = 2;

class TimerSlot {
  constructor() {
    this.state = SLOT_FREE;
    this.timer = new Timer();
    this.name = '';
    this.startTime = 0;
    this.elapsed = 0;
    this.delta = 0;
    this.callCount = 0;
    this.overrunCount = 0;
    this._interval = 0;
    this._lastFire = 0;
    this._phase = 0;
    this._pending = false;
  }

  reset() {
    this.state = SLOT_FREE;
    this.name = '';
    this.startTime = 0;
    this.elapsed = 0;
    this.delta = 0;
    this.callCount = 0;
    this.overrunCount = 0;
    this._interval = 0;
    this._lastFire = 0;
    this._phase = 0;
    this._pending = false;
    this.timer.reset();
  }
}

class TimerUtils {
  constructor(options = {}) {
    this._poolSize = options.poolSize ?? DEFAULT_POOL_SIZE;
    this._pool = new Array(this._poolSize);
    for (let i = 0; i < this._poolSize; i++) this._pool[i] = new TimerSlot();
    this._activeCount = 0;

    // Global CPU budget accumulator for the current tick.
    this._tickBudgetUsed = 0;
    this._tickBudgetOverrun = 0;
    this._frameStart = 0;
    this._frameTime = 0;

    // Scratch vectors (pooled).
    this._tmpVec3 = new Vec3();
    this._tmpVec4 = new Vec4();
    this._tmpMat4 = new Mat4();
    this._tmpQuat = new Quat();

    this._stats = {
      ticks: 0,
      totalOverruns: 0,
      totalGCOverruns: 0,
      peakBudgetUse: 0,
      slotAllocations: 0,
      slotReuses: 0
    };
  }

  // ── tick lifecycle ─────────────────────────────────────────────
  beginTick(now = performance.now() / 1000) {
    this._frameStart = now;
    this._tickBudgetUsed = 0;
    this._tickBudgetOverrun = 0;
    return this;
  }

  endTick(now = performance.now() / 1000) {
    this._frameTime = now - this._frameStart;
    if (this._frameTime > CPU_BUDGET_SECONDS) {
      this._tickBudgetOverrun = 1;
      this._stats.totalOverruns++;
    }
    if (this._tickBudgetUsed > this._stats.peakBudgetUse) {
      this._stats.peakBudgetUse = this._tickBudgetUsed;
    }
    this._stats.ticks++;
    return this._tickBudgetOverrun === 1;
  }

  // ── budget-checked timer acquisition ──────────────────────────
  acquire(name = 'timer') {
    for (let i = 0; i < this._poolSize; i++) {
      const slot = this._pool[i];
      if (slot.state === SLOT_FREE) {
        slot.state = SLOT_ACTIVE;
        slot.name = name;
        slot.timer.reset();
        slot.startTime = performance.now() / 1000;
        slot.elapsed = 0;
        slot.delta = 0;
        slot.callCount = 0;
        slot.overrunCount = 0;
        slot._interval = 0;
        slot._lastFire = 0;
        slot._phase = 0;
        slot._pending = false;
        this._activeCount++;
        this._stats.slotAllocations++;
        return slot;
      }
    }
    // Pool exhausted — reuse the first active slot (never allocate
    // inside the frame loop; this is a hard ceiling, not a fallback).
    const slot = this._pool[0];
    slot.state = SLOT_ACTIVE;
    slot.name = name;
    slot.timer.reset();
    slot.startTime = performance.now() / 1000;
    slot.elapsed = 0;
    slot.delta = 0;
    slot.callCount = 0;
    slot.overrunCount = 0;
    slot._interval = 0;
    slot._lastFire = 0;
    slot._phase = 0;
    slot._pending = false;
    this._stats.slotReuses++;
    return slot;
  }

  release(slot) {
    if (slot && slot.state !== SLOT_FREE) {
      slot.reset();
      this._activeCount--;
    }
    return this;
  }

  // ── zero-allocation elapsed measurement ───────────────────────
  // Call start() then end(); both return the slot for chaining.
  start(slot) {
    slot.startTime = performance.now() / 1000;
    slot.state = SLOT_ACTIVE;
    return slot;
  }

  end(slot) {
    const now = performance.now() / 1000;
    slot.elapsed = now - slot.startTime;
    slot.delta = slot.elapsed;
    slot.callCount++;
    // Charge this measurement to the current tick's CPU budget.
    this._tickBudgetUsed += slot.elapsed;
    if (slot.elapsed > CPU_BUDGET_SECONDS) slot.overrunCount++;
    return slot.elapsed;
  }

  // ── periodic callback gating (zero allocation) ────────────────
  // Returns true when (now - lastFire) >= interval and the phase
  // offset has been satisfied. Updates lastFire in place.
  shouldFire(slot, interval, phaseOffset = 0) {
    const now = performance.now() / 1000;
    if (slot._lastFire === 0) {
      slot._lastFire = now;
      return true;
    }
    const since = now - slot._lastFire;
    if (since < interval) return false;
    // Phase offset gate: spread work across frames.
    const framePhase = (now * 60) % (interval * 60);
    if (phaseOffset > 0 && framePhase < phaseOffset) return false;
    slot._lastFire = now;
    return true;
  }

  // ── fixed-interval scheduling with jitter compensation ────────
  // Compensates for frame jitter by subtracting accumulated drift.
  scheduleFixed(slot, targetInterval) {
    const now = performance.now() / 1000;
    if (slot._lastFire === 0) {
      slot._lastFire = now;
      return true;
    }
    const expected = slot._lastFire + targetInterval;
    if (now >= expected) {
      // Advance lastFire by the exact interval, not the current time,
      // to prevent drift accumulation.
      slot._lastFire = expected;
      // If we fell more than one interval behind, snap to now.
      if (now - slot._lastFire > targetInterval) slot._lastFire = now;
      return true;
    }
    return false;
  }

  // ── CPU budget enforcement ────────────────────────────────────
  // Returns true if the current tick still has budget remaining.
  hasBudget() {
    return this._tickBudgetUsed < CPU_BUDGET_SECONDS;
  }

  remainingBudget() {
    return Math.max(0, CPU_BUDGET_SECONDS - this._tickBudgetUsed);
  }

  chargeBudget(seconds) {
    this._tickBudgetUsed += seconds;
    if (this._tickBudgetUsed > this._stats.peakBudgetUse) {
      this._stats.peakBudgetUse = this._tickBudgetUsed;
    }
    return this._tickBudgetUsed < CPU_BUDGET_SECONDS;
  }

  // ── GC pause tracking (2 ms hard limit) ───────────────────────
  trackGCPause(pauseSeconds) {
    if (pauseSeconds > GC_BUDGET_SECONDS) {
      this._stats.totalGCOverruns++;
      return true;
    }
    return false;
  }

  // ── integration with 267_CoreClock for tier deltas ────────────
  tierDelta(clock, hz) {
    if (!clock) return 0;
    return clock.getTierDelta(hz);
  }

  // ── diagnostic accessors ──────────────────────────────────────
  get tickBudgetUsed() { return this._tickBudgetUsed; }
  get frameTime() { return this._frameTime; }
  get activeCount() { return this._activeCount; }

  getStats() {
    return Object.freeze({
      ticks: this._stats.ticks,
      totalOverruns: this._stats.totalOverruns,
      totalGCOverruns: this._stats.totalGCOverruns,
      peakBudgetUse: this._stats.peakBudgetUse,
      slotAllocations: this._stats.slotAllocations,
      slotReuses: this._stats.slotReuses,
      activeSlots: this._activeCount
    });
  }

  resetStats() {
    this._stats.ticks = 0;
    this._stats.totalOverruns = 0;
    this._stats.totalGCOverruns = 0;
    this._stats.peakBudgetUse = 0;
    this._stats.slotAllocations = 0;
    this._stats.slotReuses = 0;
  }

  dispose() {
    for (let i = 0; i < this._poolSize; i++) {
      this._pool[i].reset();
    }
    this._activeCount = 0;
    this._tickBudgetUsed = 0;
    this._frameTime = 0;
  }
}

export {
  TimerUtils,
  TimerSlot,
  CPU_BUDGET_SECONDS,
  GC_BUDGET_SECONDS,
  SLOT_FREE,
  SLOT_ACTIVE,
  SLOT_PAUSED
};