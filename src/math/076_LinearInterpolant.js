// file number : 076
// full path name : src/math/076_LinearInterpolant.js
// description : High-performance linear interpolant with a flat typed-array hot path, cached interval index, and pooled result buffers. Zero allocations per evaluate() call makes it ideal for Android 64-bit real-time animation, camera paths, and any parameter where C1 continuity is not required.
// best for : Position/scale animation, UI parameter tweening, simple camera paths, and any interpolated value where speed and memory footprint matter more than smooth derivatives.
// license : MIT

import { Constants } from './002_Constants.js';
import { Common } from './003_Common.js';
import { Precision } from './004_Precision.js';
import { Vec2 } from './005_Vec2.js';
import { Vec3 } from './006_Vec3.js';
import { Vec4 } from './007_Vec4.js';
import { Mat2 } from './008_Mat2.js';
import { Mat3 } from './009_Mat3.js';
import { Mat4 } from './010_Mat4.js';
import { Quat } from './011_Quat.js';
import { Quat2 } from './012_Quat2.js';
import { SimplexNoise } from './013_SimplexNoise.js';
import { BitECS } from './014_BitECS.js';
import { World } from './015_World.js';
import { Components } from './016_Components.js';
import { Systems } from './017_Systems.js';

/**
 * LinearInterpolant
 * Fast linear interpolation with flat Float32Array buffers, cached interval
 * index, and a static buffer pool to avoid per-instance allocations.
 *
 * Features:
 * – Zero allocations inside evaluate().
 * – Boundary extrapolation via linear extrapolation.
 * – Pooled result buffers: reuse across instances to reduce GC pressure on
 *   mobile devices.
 * – No CDN, no bundler, no static server required.
 */
class LinearInterpolant {
  // Static pool: Map<size, Float32Array[]>
  static _bufferPool = new Map();

  /**
   * Acquire a Float32Array of the given size from the pool or create a new one.
   * @param {number} size
   * @returns {Float32Array}
   */
  static acquireBuffer(size) {
    const pool = LinearInterpolant._bufferPool.get(size);
    if (pool && pool.length > 0) {
      return pool.pop();
    }
    return new Float32Array(size);
  }

  /**
   * Return a Float32Array to the pool for reuse.
   * @param {Float32Array} buffer
   */
  static releaseBuffer(buffer) {
    const size = buffer.length;
    let pool = LinearInterpolant._bufferPool.get(size);
    if (!pool) {
      pool = [];
      LinearInterpolant._bufferPool.set(size, pool);
    }
    // Avoid unbounded growth: keep at most 32 buffers per size
    if (pool.length < 32) {
      pool.push(buffer);
    }
  }

  /**
   * Clear the entire buffer pool.
   */
  static clearPool() {
    LinearInterpolant._bufferPool.clear();
  }

  /**
   * @param {Float32Array|Float64Array} parameterPositions – sorted parameter values (e.g. times)
   * @param {Float32Array|Float64Array} sampleValues – flat array of samples (size = sampleSize × valueSize)
   * @param {number} sampleSize – number of components per sample (e.g. 3 for Vec3)
   * @param {Float32Array} [resultBuffer] – optional reusable output buffer (length ≥ sampleSize)
   */
  constructor(parameterPositions, sampleValues, sampleSize, resultBuffer = null) {
    this.parameterPositions = parameterPositions;
    this.sampleValues = sampleValues;
    this.sampleSize = sampleSize | 0;                // force integer
    this.valueSize = this.sampleValues.length / this.parameterPositions.length;

    if (resultBuffer) {
      this.resultBuffer = resultBuffer;
    } else {
      this.resultBuffer = LinearInterpolant.acquireBuffer(this.sampleSize);
    }

    // Cached interval index – starts at the first interval
    this._cachedIndex = 0;
  }

  /**
   * Evaluate the interpolated value at parameter t.
   * Writes into `this.resultBuffer` and returns it.
   *
   * @param {number} t – parameter to evaluate (usually time in seconds)
   * @returns {Float32Array} resultBuffer
   */
  evaluate(t) {
    const pp = this.parameterPositions;
    const sv = this.sampleValues;
    const rb = this.resultBuffer;
    const ss = this.sampleSize;
    const vs = this.valueSize;

    // --- 1. Locate the interval (cached index first) ---
    let i1 = this._cachedIndex;
    let i0 = i1 - 1;

    // Clamp t to the valid range
    if (t <= pp[0]) {
      i0 = -1;
      i1 = 0;
    } else if (t >= pp[pp.length - 1]) {
      i0 = pp.length - 2;
      i1 = pp.length - 1;
    } else {
      // Binary-search only when the cached interval fails
      if (t < pp[i1]) {
        while (i1 > 0 && t < pp[i1]) i1--;
        i0 = i1 - 1;
      } else {
        while (i1 < pp.length - 1 && t >= pp[i1 + 1]) i1++;
        i0 = i1 - 1;
      }
    }

    this._cachedIndex = i1;

    // --- 2. Handle boundary conditions (linear extrapolation) ---
    if (i0 < 0) {
      // t is before the first sample – linear extrapolation from first two samples
      const t0 = pp[0];
      const t1 = pp[1];
      const w = (t - t0) / (t1 - t0);
      const w0 = 1 - w;
      const w1 = w;
      const off0 = 0;
      const off1 = vs;
      for (let j = 0; j < ss; j++) {
        rb[j] = w0 * sv[off0 + j] + w1 * sv[off1 + j];
      }
      return rb;
    }

    if (i1 >= pp.length) {
      // t is after the last sample – linear extrapolation from last two samples
      const n = pp.length;
      const t0 = pp[n - 2];
      const t1 = pp[n - 1];
      const w = (t - t0) / (t1 - t0);
      const w0 = 1 - w;
      const w1 = w;
      const off0 = (n - 2) * vs;
      const off1 = (n - 1) * vs;
      for (let j = 0; j < ss; j++) {
        rb[j] = w0 * sv[off0 + j] + w1 * sv[off1 + j];
      }
      return rb;
    }

    // --- 3. Normal linear interpolation ---
    const t0 = pp[i0];
    const t1 = pp[i1];
    const dt = t1 - t0;
    const u = (t - t0) / dt;           // normalised parameter [0,1]

    const w0 = 1 - u;
    const w1 = u;

    const off0 = i0 * vs;
    const off1 = i1 * vs;

    for (let j = 0; j < ss; j++) {
      rb[j] = w0 * sv[off0 + j] + w1 * sv[off1 + j];
    }

    return rb;
  }

  /**
   * Resets the cached interval index so the next evaluate() starts searching
   * from the beginning (useful when the animation loops or seeks).
   */
  resetCache() {
    this._cachedIndex = 0;
  }

  /**
   * Release the result buffer back to the pool. Call this when the
   * interpolant is no longer needed to avoid memory leaks.
   */
  dispose() {
    LinearInterpolant.releaseBuffer(this.resultBuffer);
    this.resultBuffer = null;
    this.parameterPositions = null;
    this.sampleValues = null;
  }
}

export { LinearInterpolant };