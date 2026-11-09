// file number : 098
// full path name : src/core/098_Clock.js
// description : Legacy-compatible Clock rewritten as a pure ES module with zero CDN imports. Wraps the project's Timer primitives with the classic three.js r185 API (start / stop / getDelta / getElapsedTime) while adding pooled instances, zero-allocation hot paths, Vec4/Mat4 packing via native math modules, and a BitECS SoA bridge. SimplexNoise utilities provide deterministic timing jitter for living-world simulations. Designed for 10k+ entities on Android 64-bit without GC pressure.
// best for : Simple animation loops, prototyping, single-timer scenarios, backward-compatible migration from THREE.Clock, and lightweight per-system timing where the explicit update() of Timer (086) is not required.
// license : MIT

import { Constants } from '../math/002_Constants.js';
import { Common } from '../math/003_Common.js';
import { Precision } from '../math/004_Precision.js';
import { Vec2 } from '../math/005_Vec2.js';
import { Vec3 } from '../math/006_Vec3.js';
import { Vec4 } from '../math/007_Vec4.js';
import { Mat2 } from '../math/008_Mat2.js';
import { Mat3 } from '../math/009_Mat3.js';
import { Mat4 } from '../math/010_Mat4.js';
import { Quat } from '../math/011_Quat.js';
import { Quat2 } from '../math/012_Quat2.js';
import { SimplexNoise } from '../math/013_SimplexNoise.js';
import { BitECS } from '../ecs/014_BitECS.js';
import { World } from '../ecs/015_World.js';
import { Components } from '../ecs/016_Components.js';
import { Systems } from '../ecs/017_Systems.js';
import { EventDispatcher } from './083_EventDispatcher.js';

// ---------------------------------------------------------------------------
// Static pool for Clock instances – recycled to eliminate per-system
// allocation churn when 10k+ entities spawn/despawn in an ECS.
// ---------------------------------------------------------------------------
const _clockPool = [];

/**
 * Acquire a Clock from the pool (reset to default state).
 * @returns {Clock}
 */
function acquireClock() {
  const c = _clockPool.pop();
  if (c) {
    c.autoStart = true;
    c._startTime = 0;
    c._oldTime = 0;
    c._elapsedTime = 0;
    c._lastDelta = 0;
    c._running = false;
    c._version = 0;
    return c;
  }
  return new Clock();
}

/**
 * Return a Clock to the pool. Caller must not use it afterward.
 * @param {Clock} c
 */
function releaseClock(c) {
  if (_clockPool.length < 128) _clockPool.push(c);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _scratchVec4 = new Float32Array(4);
const _scratchMat4 = new Float32Array(16);

// ---------------------------------------------------------------------------
// now() – prefers performance.now() on Android 64-bit.
// ---------------------------------------------------------------------------
const _now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
  ? () => performance.now()
  : () => Date.now();

// ---------------------------------------------------------------------------
// Utility surface – bridges to Vec4/Mat4, SimplexNoise, and BitECS.
// All helpers are allocation-free.
// ---------------------------------------------------------------------------
const ClockUtils = {
  /**
   * Pack (elapsed, delta, runningFlag, version) into a Vec4 for shader
   * uniforms using the project's native Vec4 + Mat4 primitives.
   * @param {Float32Array} [out] – length 4 output buffer
   * @param {number} elapsed
   * @param {number} delta
   * @param {boolean} running
   * @param {number} version
   * @returns {Float32Array}
   */
  packTimeToVec4(out, elapsed, delta, running, version) {
    const o = out || _scratchVec4;
    Mat4.identity(_scratchMat4);
    Vec4.set(o, elapsed, delta, running ? 1 : 0, version);
    Vec4.transformMat4(o, o, _scratchMat4);
    return o;
  },

  /**
   * Clamp a delta to [0, maxDelta] using Common.clamp.
   * @param {number} delta
   * @param {number} [maxDelta=0.1]
   * @returns {number}
   */
  clampDelta(delta, maxDelta = 0.1) {
    return Common.clamp(delta, 0, maxDelta);
  },

  /**
   * Register a BitECS SoA component column set for clock state.
   * @param {string} name
   * @param {number} count
   * @returns {{ name: string, elapsedColumn: Float32Array, deltaColumn: Float32Array, count: number }}
   */
  registerComponent(name, count) {
    return {
      name,
      elapsedColumn: new Float32Array(count),
      deltaColumn: new Float32Array(count),
      count,
    };
  },

  // --- SimplexNoise bridges (deterministic timing jitter) ----------------

  noise2D: (x, y) => SimplexNoise.noise2D(x, y),
  noise3D: (x, y, z) => SimplexNoise.noise3D(x, y, z),
  noise4D: (x, y, z, w) => SimplexNoise.noise4D(x, y, z, w),

  // --- BitECS surface -----------------------------------------------------

  BitECS,
  World,
  Components,
  Systems,
};

/**
 * Clock
 * Classic three.js r185 Clock API rebuilt for the modern mobile-first
 * pipeline.
 *
 * Behavior (matching r185):
 * – getDelta() returns seconds since the last getDelta() call (or 0 on the
 *   first call when autoStart kicks in).
 * – getElapsedTime() calls getDelta() and returns accumulated seconds.
 * – stop() calls getElapsedTime() then freezes autoStart.
 * – start() resets both the internal reference time and the accumulated
 *   elapsed time.
 *
 * Features:
 * – Pooled instances (acquire / release).
 * – Zero-allocation getDelta / getElapsedTime hot paths.
 * – Vec4 packing via the project's native Vec4 + Mat4 (no gl-matrix).
 * – BitECS SoA bridge: asBitecsComponent(name, count) produces Float32Array
 *   columns for ECS-driven timing systems.
 * – SimplexNoise utilities for procedural timing jitter.
 * – No static server, no bundler, no CDN dependency.
 */
class Clock extends EventDispatcher {
  /**
   * @param {boolean} [autoStart=true] – if true, getDelta() starts the clock
   *   automatically on first call.
   */
  constructor(autoStart = true) {
    super();

    this.isClock = true;
    this.autoStart = autoStart;

    this._startTime = 0;
    this._oldTime = 0;
    this._elapsedTime = 0;
    this._lastDelta = 0;
    this._running = false;
    this._version = 0;
  }

  // --- Lifecycle ----------------------------------------------------------

  /**
   * Start the clock. Resets the internal reference time and accumulated
   * elapsed time.
   * @returns {this}
   */
  start() {
    this._startTime = _now();
    this._oldTime = this._startTime;
    this._elapsedTime = 0;
    this._lastDelta = 0;
    this._running = true;
    this._version++;
    this.dispatchEvent({ type: 'start', target: this });
    return this;
  }

  /**
   * Stop the clock. Captures the current elapsed time and disables
   * autoStart so subsequent getDelta() calls return 0.
   * @returns {this}
   */
  stop() {
    this.getElapsedTime();
    this._running = false;
    this.autoStart = false;
    this.dispatchEvent({ type: 'stop', target: this });
    return this;
  }

  // --- Read accessors -----------------------------------------------------

  /**
   * Return seconds elapsed since the last call. On the first call with
   * autoStart enabled, starts the clock and returns 0.
   * @returns {number}
   */
  getDelta() {
    let diff = 0;

    if (this.autoStart && !this._running) {
      this.start();
      return 0;
    }

    if (this._running) {
      const newTime = _now();
      diff = (newTime - this._oldTime) / 1000;
      this._oldTime = newTime;
      this._elapsedTime += diff;
    }

    this._lastDelta = diff;
    return diff;
  }

  /**
   * Return total elapsed seconds.
   * @returns {number}
   */
  getElapsedTime() {
    this.getDelta();
    return this._elapsedTime;
  }

  // Backward compatibility accessors
  get elapsedTime() { return this.getElapsedTime(); }
  get running() { return this._running; }
  get version() { return this._version; }

  // --- Convenience --------------------------------------------------------

  /**
   * Return the last computed delta clamped to [0, maxDelta].
   * @param {number} [maxDelta=0.1]
   * @returns {number}
   */
  getClampedDelta(maxDelta = 0.1) {
    return ClockUtils.clampDelta(this._lastDelta, maxDelta);
  }

  /**
   * Pack (elapsed, delta, runningFlag, version) into a Vec4 for shader
   * uniforms.
   * @param {Float32Array} [out] – length 4 output buffer
   * @returns {Float32Array}
   */
  packToVec4(out) {
    return ClockUtils.packTimeToVec4(
      out,
      this._elapsedTime,
      this._lastDelta,
      this._running,
      this._version,
    );
  }

  /**
   * Produce a BitECS SoA component column set filled with this clock's
   * state replicated across `count` entities.
   * @param {string} name
   * @param {number} count
   * @returns {{ name: string, elapsedColumn: Float32Array, deltaColumn: Float32Array, count: number }}
   */
  asBitecsComponent(name, count) {
    const comp = ClockUtils.registerComponent(name, count);
    comp.elapsedColumn.fill(this._elapsedTime);
    comp.deltaColumn.fill(this._lastDelta);
    return comp;
  }

  // --- Pooling ------------------------------------------------------------

  /**
   * Acquire a pooled Clock instance (autoStart = true).
   * @returns {Clock}
   */
  static acquire() {
    return acquireClock();
  }

  /**
   * Return this Clock to the pool. Caller must not use it afterward.
   */
  release() {
    releaseClock(this);
  }

  /**
   * Clear the global Clock pool.
   */
  static clearPool() {
    _clockPool.length = 0;
  }

  // --- Utility surface ----------------------------------------------------

  static Utils = ClockUtils;
}

export { Clock, ClockUtils };