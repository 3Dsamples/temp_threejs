// file number : 075
// full path name : src/math/075_CubicInterpolant.js
// description : High-performance cubic Hermite spline interpolant for keyframe animation, morph targets, camera paths, and any continuous scalar/vector data. Rebuilt with flat typed-array storage, cached interval/stride logic, and zero per-frame allocations to stay fast and memory-light on Android 64-bit.
// best for : Smooth animation curves, camera easing, morph-target blending, physics interpolation, and any DCC-style keyframe system that needs C1 continuity without a server or bundler.
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
 * CubicInterpolant
 * Fast cubic Hermite spline interpolant derived from a Hermitian construction
 * where the first derivative at each sample is the linear slope between
 * neighbouring positions.
 *
 * Optimised for mobile:
 * – Flat Float32Array buffers for parameterPositions, sampleValues, resultBuffer.
 * – Cached interval index and stride so no allocation happens during evaluate().
 * – Uses only typed-array access and local variables in the hot path.
 * – No CDN, no bundler, no static server required.
 */
class CubicInterpolant {
  /**
   * @param {Float32Array|Float64Array} parameterPositions – sorted parameter values (e.g. times)
   * @param {Float32Array|Float64Array} sampleValues – flat array of samples (size = sampleSize × valueSize)
   * @param {number} sampleSize – number of components per sample (e.g. 3 for Vec3)
   * @param {Float32Array|Float64Array} [resultBuffer] – optional reusable output buffer (length ≥ sampleSize)
   */
  constructor(parameterPositions, sampleValues, sampleSize, resultBuffer = null) {
    this.parameterPositions = parameterPositions;
    this.sampleValues = sampleValues;
    this.sampleSize = sampleSize | 0;                // force integer
    this.resultBuffer = resultBuffer || new Float32Array(sampleSize);

    // Pre-compute valueSize (stride between samples in sampleValues)
    this.valueSize = this.sampleValues.length / this.parameterPositions.length;

    // Cached interval index – starts at the first interval
    this._cachedIndex = 0;

    // Pre-allocated temp arrays for Hermite basis coefficients
    this._tmp0 = new Float32Array(sampleSize);
    this._tmp1 = new Float32Array(sampleSize);
    this._tmp2 = new Float32Array(sampleSize);

    // Pre-allocated weight scalars
    this._w0 = 0;
    this._w1 = 0;
    this._w2 = 0;
    this._w3 = 0;
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

    // --- 3. Normal cubic Hermite interpolation ---
    const t0 = pp[i0];
    const t1 = pp[i1];
    const dt = t1 - t0;
    const u = (t - t0) / dt;           // normalised parameter [0,1]

    // Hermite basis weights
    const u2 = u * u;
    const u3 = u2 * u;
    const w0 =  2 * u3 - 3 * u2 + 1;   // h00
    const w1 = -2 * u3 + 3 * u2;       // h10
    const w2 =      u3 - 2 * u2 + u;   // h01
    const w3 =      u3 -     u2;       // h11

    const off0 = i0 * vs;
    const off1 = i1 * vs;

    // Pre-compute slopes (finite differences) – cached in temp arrays
    // m0 = (v1 - v0) / (t1 - t0)  when i0 > 0
    // m1 = (v1 - v0) / (t1 - t0)  when i1 < n-1
    // For boundary intervals we fall back to the linear slope.
    const hasPrev = i0 > 0;
    const hasNext = i1 < pp.length - 1;

    // slope at left sample
    if (hasPrev) {
      const dtPrev = t1 - pp[i0 - 1];
      const invDtPrev = 1 / dtPrev;
      const offPrev = (i0 - 1) * vs;
      for (let j = 0; j < ss; j++) {
        this._tmp0[j] = (sv[off1 + j] - sv[off0 + j]) * invDtPrev; // actually slope to next, but we need slope from prev to current
        // Correct slope from prev to current:
        this._tmp0[j] = (sv[off0 + j] - sv[offPrev + j]) * invDtPrev;
      }
    } else {
      // no previous sample – use slope to next
      const invDt = 1 / dt;
      for (let j = 0; j < ss; j++) {
        this._tmp0[j] = (sv[off1 + j] - sv[off0 + j]) * invDt;
      }
    }

    // slope at right sample
    if (hasNext) {
      const dtNext = pp[i1 + 1] - t0; // dt from current to next
      const invDtNext = 1 / dtNext;
      const offNext = (i1 + 1) * vs;
      for (let j = 0; j < ss; j++) {
        this._tmp1[j] = (sv[offNext + j] - sv[off1 + j]) * invDtNext;
      }
    } else {
      const invDt = 1 / dt;
      for (let j = 0; j < ss; j++) {
        this._tmp1[j] = (sv[off1 + j] - sv[off0 + j]) * invDt;
      }
    }

    // Combine Hermite basis
    for (let j = 0; j < ss; j++) {
      rb[j] = w0 * sv[off0 + j] +
              w1 * this._tmp0[j] * dt +
              w2 * sv[off1 + j] +
              w3 * this._tmp1[j] * dt;
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
}

export { CubicInterpolant };