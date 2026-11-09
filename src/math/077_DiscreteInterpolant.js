// file number : 077
// full path name : src/math/077_DiscreteInterpolant.js
// description : High-performance discrete interpolant that snaps to the nearest sample without blending. Uses flat typed-array buffers, cached interval index, and the shared buffer pool from LinearInterpolant. Zero allocations per evaluate() call makes it ideal for stepped animation, sprite-sheet frames, and any parameter that must jump between discrete states on Android 64-bit.
// best for : Stepped keyframe animation, sprite-sheet frame selection, enum/state transitions, texture atlas UV jumps, and any value where blending must be suppressed for stylistic or gameplay reasons.
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
import { LinearInterpolant } from './076_LinearInterpolant.js';

/**
 * DiscreteInterpolant
 * Nearest-neighbour interpolation with a flat typed-array hot path,
 * cached interval index, and a shared static buffer pool.
 *
 * Behaviour:
 * – Returns the sample whose parameter is closest to t (ties favour the
 *   lower index for deterministic stepping).
 * – Outside the parameter range it clamps to the first or last sample.
 * – Zero allocations inside evaluate().
 * – Uses the same pool as LinearInterpolant to keep memory bounded.
 */
class DiscreteInterpolant {
  /**
   * @param {Float32Array|Float64Array} parameterPositions – sorted parameter values (e.g. times)
   * @param {Float32Array|Float64Array} sampleValues – flat array of samples (size = sampleSize × valueSize)
   * @param {number} sampleSize – number of components per sample (e.g. 3 for Vec3)
   * @param {Float32Array} [resultBuffer] – optional reusable output buffer (length ≥ sampleSize)
   */
  constructor(parameterPositions, sampleValues, sampleSize, resultBuffer = null) {
    this.parameterPositions = parameterPositions;
    this.sampleValues = sampleValues;
    this.sampleSize = sampleSize | 0;
    this.valueSize = this.sampleValues.length / this.parameterPositions.length;

    if (resultBuffer) {
      this.resultBuffer = resultBuffer;
    } else {
      this.resultBuffer = LinearInterpolant.acquireBuffer(this.sampleSize);
    }

    this._cachedIndex = 0;
  }

  /**
   * Evaluate the discrete value at parameter t.
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
    const n = pp.length;

    // --- 1. Clamp t to the valid range ---
    if (t <= pp[0]) {
      const off = 0;
      for (let j = 0; j < ss; j++) rb[j] = sv[off + j];
      this._cachedIndex = 0;
      return rb;
    }
    if (t >= pp[n - 1]) {
      const off = (n - 1) * vs;
      for (let j = 0; j < ss; j++) rb[j] = sv[off + j];
      this._cachedIndex = n - 1;
      return rb;
    }

    // --- 2. Locate the nearest sample (cached index first) ---
    let i1 = this._cachedIndex;

    if (t < pp[i1]) {
      while (i1 > 0 && t < pp[i1]) i1--;
    } else {
      while (i1 < n - 1 && t >= pp[i1 + 1]) i1++;
    }

    // i1 is now the largest index with pp[i1] <= t (or 0)
    // i0 = i1 + 1 is the next sample (always valid here because of clamping)
    const i0 = i1 + 1;

    // --- 3. Nearest-neighbour decision (ties favour lower index) ---
    const tLow = pp[i1];
    const tHigh = pp[i0];
    const distLow = t - tLow;
    const distHigh = tHigh - t;
    const nearest = distLow <= distHigh ? i1 : i0;

    this._cachedIndex = nearest;

    const off = nearest * vs;
    for (let j = 0; j < ss; j++) rb[j] = sv[off + j];
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

export { DiscreteInterpolant };