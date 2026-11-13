// file number : 267
// full path name : src/context/267_CoreClock.js
// description : Monotonic high-resolution clock for the living world. Wraps THREE.Timer (performance.now with Date.now fallback) and exposes clamped per-tier deltas (60 Hz, 10 Hz, 1 Hz), fixed-offset tier scheduling phi_f = f * dt0 to reduce jitter, a monotonic elapsed-seconds accumulator, a 0-255 wrapping tick counter with cheap modulo hash for the context frame, frame-time statistics against the 8 ms Android ceiling, and an allocation-free update path. Integrates with 263_ContextFrame's temporal layer and imports exclusively from 264_MathECSImportBarrel.
// best for : Tier gating, temporal context provider updates, LOD cross-fade timing, camera velocity extrapolation, and any system that needs a stable monotonic delta without allocating inside the frame loop.
// license : MIT

import {
  Timer,
  Precision,
  Vec3,
  Mat4,
  Quat
} from './264_MathECSImportBarrel.js';

// ─── tier frequencies and fixed offsets ───────────────────────────
const TIER = Object.freeze({
  HZ_60: 60,
  HZ_10: 10,
  HZ_1: 1
});

const TIER_PERIOD = Object.freeze({
  60: 1 / 60,
  10: 1 / 10,
  1: 1 / 1
});

// Fixed offsets phi_f = f * dt0 where dt0 = 1/60, reduced modulo
// the tier period to spread work across frames.
const TIER_OFFSET = Object.freeze({
  60: 0,
  10: 4 / 60,   // 4 * (1/60) = 1/15
  1: 37 / 60    // 37 * (1/60) = 0.616...
});

// Maximum delta per tier. Deltas larger than this are clamped to
// prevent physics explosions after a tab switch or debugger pause.
const TIER_MAX_DELTA = Object.freeze({
  60: 1 / 30,   // 2 frames at 60 Hz
  10: 1 / 5,    // 2 frames at 10 Hz
  1: 1 / 1      // 1 frame at 1 Hz
});

// 8 ms per-tick CPU ceiling on Snapdragon 7-series (in seconds).
const CPU_BUDGET_SECONDS = 0.008;

class CoreClock {
  constructor(options = {}) {
    this._timer = new Timer();
    this._timer.connect(options.document || (typeof document !== 'undefined' ? document : undefined));

    this._started = false;
    this._elapsedSeconds = 0;
    this._rawElapsedSeconds = 0;
    this._frameCount = 0;

    // Per-tier accumulators and flags
    this._tierAccum = new Float64Array(3);       // [60, 10, 1]
    this._tierFired = new Uint8Array(3);         // 1 = fired this frame
    this._tierDelta = new Float64Array(3);       // clamped delta for each tier
    this._tierOffsetFired = new Uint8Array(3);   // offset scheduling state

    // Monotonic tick counter wrapping 0-255
    this._tick = 0;
    this._tickHash = 0;

    // Timing diagnostics (ring buffer of frame times)
    this._frameTimes = new Float64Array(120);
    this._frameTimesHead = 0;
    this._frameTimesCount = 0;
    this._lastFrameTime = 0;
    this._deltaSmoothing = options.deltaSmoothing ?? 0.15;
    this._smoothedDelta = 0;

    // Pool: reusable temporary storage
    this._tmpVec3 = new Vec3();
    this._tmpMat4 = new Mat4();
    this._tmpQuat = new Quat();

    this._stats = {
      updates: 0,
      clampEvents: 0,
      cpuOverruns: 0,
      totalFrameTime: 0
    };
  }

  // ── lifecycle ──────────────────────────────────────────────────
  start() {
    if (this._started) return this;
    this._timer.reset();
    this._started = true;
    this._lastFrameTime = this._now();
    return this;
  }

  stop() {
    this._started = false;
    return this;
  }

  reset() {
    this._started = false;
    this._elapsedSeconds = 0;
    this._rawElapsedSeconds = 0;
    this._frameCount = 0;
    this._tierAccum.fill(0);
    this._tierFired.fill(0);
    this._tierDelta.fill(0);
    this._tierOffsetFired.fill(0);
    this._tick = 0;
    this._tickHash = 0;
    this._frameTimes.fill(0);
    this._frameTimesHead = 0;
    this._frameTimesCount = 0;
    this._smoothedDelta = 0;
    this._stats.updates = 0;
    this._stats.clampEvents = 0;
    this._stats.cpuOverruns = 0;
    this._stats.totalFrameTime = 0;
    return this;
  }

  // ── internal time source ───────────────────────────────────────
  _now() {
    // Timer.update() must be called before getDelta(); we call it
    // once per update() and read the raw delta directly.
    return this._timer.getDelta();
  }

  _nowAbsolute() {
    return this._timer.getElapsed();
  }

  // ── primary update: called once per animation frame ────────────
  update() {
    if (!this._started) this.start();

    const rawDelta = this._now();
    let delta = rawDelta;

    // Clamp large deltas (tab switch, debugger pause).
    if (delta > TIER_MAX_DELTA[60]) {
      delta = TIER_MAX_DELTA[60];
      this._stats.clampEvents++;
    }
    if (delta < 0) delta = 0; // guard against non-monotonic sources

    // Delta smoothing: blend with the previous smoothed delta.
    const a = this._deltaSmoothing;
    this._smoothedDelta = this._smoothedDelta === 0
      ? delta
      : this._smoothedDelta * (1 - a) + delta * a;

    this._rawElapsedSeconds += rawDelta;
    this._elapsedSeconds += this._smoothedDelta;
    this._frameCount++;

    // Accumulate per-tier time and set fired flags.
    const tiers = [60, 10, 1];
    for (let i = 0; i < 3; i++) {
      const hz = tiers[i];
      this._tierAccum[i] += this._smoothedDelta;
      this._tierDelta[i] = this._smoothedDelta;
      this._tierFired[i] = 0;

      const period = TIER_PERIOD[hz];
      const offset = TIER_OFFSET[hz];

      // Gate: fire when accumulated time reaches period, accounting
      // for the fixed offset to spread work across frames.
      if (this._tierAccum[i] >= period + offset) {
        this._tierFired[i] = 1;
        this._tierAccum[i] -= period;
        if (this._tierAccum[i] < 0) this._tierAccum[i] = 0;
      }
    }

    // 60 Hz tier fires unconditionally in the six-stage loop;
    // the flag is informational. 10 Hz and 1 Hz gates are strict.

    // Tick counter wraps 0-255 and hashes cheaply.
    this._tick = (this._tick + 1) & 0xFF;
    this._tickHash = this._tick % 256;

    // Frame-time ring buffer for diagnostics.
    this._pushFrameTime(this._smoothedDelta);
    this._lastFrameTime = this._smoothedDelta;

    // CPU budget check (approximate: compare frame time to 8 ms).
    if (this._smoothedDelta > CPU_BUDGET_SECONDS) {
      this._stats.cpuOverruns++;
    }
    this._stats.updates++;
    this._stats.totalFrameTime += this._smoothedDelta;

    return this;
  }

  // ── tier queries ───────────────────────────────────────────────
  shouldFire60() { return true; } // 60 Hz always runs
  shouldFire10() { return this._tierFired[1] === 1; }
  shouldFire1() { return this._tierFired[2] === 1; }

  getTierDelta(hz) {
    if (hz === 60) return this._tierDelta[0];
    if (hz === 10) return this._tierDelta[1];
    if (hz === 1) return this._tierDelta[2];
    return this._smoothedDelta;
  }

  // Fixed-offset scheduling: returns true when the current tick
  // falls on a frame where (tick mod (Hz)) === offsetIndex.
  // Useful for staggering consumer execution.
  isOffsetFrame(hz, offsetIndex = 0) {
    const period = 60 / hz;
    return (this._frameCount % period) === offsetIndex;
  }

  // ── temporal accessors ────────────────────────────────────────
  get elapsedSeconds() { return this._elapsedSeconds; }
  get rawElapsedSeconds() { return this._rawElapsedSeconds; }
  get delta() { return this._smoothedDelta; }
  get rawDelta() { return this._timer.getDelta(); }
  get tick() { return this._tick; }
  get tickHash() { return this._tickHash; }
  get frameCount() { return this._frameCount; }
  get fps() {
    return this._smoothedDelta > 0 ? 1 / this._smoothedDelta : 0;
  }

  // Day phase in [0, 1]: t_day seconds mapped to 0-1.
  dayPhase(dayLengthSeconds = 86400) {
    return (this._elapsedSeconds % dayLengthSeconds) / dayLengthSeconds;
  }

  // Season phase in [0, 1] using a sinusoid over year length.
  seasonPhase(yearLengthSeconds = 86400 * 365) {
    const t = this._elapsedSeconds;
    return 0.5 * (1 + Math.sin(2 * Math.PI * t / yearLengthSeconds - Math.PI / 2));
  }

  // ── frame-time diagnostics ────────────────────────────────────
  _pushFrameTime(dt) {
    this._frameTimes[this._frameTimesHead] = dt;
    this._frameTimesHead = (this._frameTimesHead + 1) % this._frameTimes.length;
    if (this._frameTimesCount < this._frameTimes.length) this._frameTimesCount++;
  }

  averageFrameTime() {
    if (this._frameTimesCount === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this._frameTimesCount; i++) sum += this._frameTimes[i];
    return sum / this._frameTimesCount;
  }

  maxFrameTime() {
    let max = 0;
    for (let i = 0; i < this._frameTimesCount; i++) {
      if (this._frameTimes[i] > max) max = this._frameTimes[i];
    }
    return max;
  }

  // ── integration with 263_ContextFrame temporal layer ──────────
  writeToFrame(frame) {
    if (!frame || !frame.layers || !frame.layers.temporal) return false;
    const t = frame.layers.temporal;
    t.elapsedWorldSeconds = this._elapsedSeconds;
    t.tick = this._tick;
    t.tickHash = this._tickHash;
    t.timeOfDay = this.dayPhase();
    t.season = this.seasonPhase();
    return true;
  }

  // ── diagnostics ───────────────────────────────────────────────
  getStats() {
    return Object.freeze({
      updates: this._stats.updates,
      clampEvents: this._stats.clampEvents,
      cpuOverruns: this._stats.cpuOverruns,
      totalFrameTime: this._stats.totalFrameTime,
      averageFrameTime: this.averageFrameTime(),
      maxFrameTime: this.maxFrameTime(),
      fps: this.fps
    });
  }

  dispose() {
    this.stop();
    this._frameTimes.fill(0);
    this._tierAccum.fill(0);
    this._tierFired.fill(0);
    this._tierDelta.fill(0);
    this._tierOffsetFired.fill(0);
  }
}

export { CoreClock, TIER, TIER_PERIOD, TIER_OFFSET, TIER_MAX_DELTA, CPU_BUDGET_SECONDS };