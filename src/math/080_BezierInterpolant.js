// file number : 080
// full path name : src/math/080_BezierInterpolant.js
// description : High-performance cubic Bezier interpolant for eased animation curves, camera fly-throughs, and stylised anime motion. Uses flat Float32Array control-point storage, a cached segment index, Newton-Raphson root solving with binary-search fallback, and the shared buffer pool. Zero allocations per evaluate() call keeps 10k+ entities smooth on Android 64-bit.
// best for : Eased UI transitions, camera spline paths, attack/decay envelopes, anime-style snap-and-settle motion, and any track that needs designer-authored cubic Bezier timing rather than linear or Hermite blending.
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
 * BezierInterpolant
 * Cubic Bezier interpolation over a sequence of 4-point control segments.
 *
 * Layout:
 * – `parameterPositions` stores the *time* boundaries of each segment.
 * – `controlPoints` stores, for each segment, 4 blocks of `sampleSize`
 *   floats: P0, P1, P2, P3. P0 and P3 are the on-curve endpoints;
 *   P1 and P2 are the off-curve handles.
 * – Stride per control block = sampleSize (1 for scalar, 3 for Vec3, etc.).
 *
 * Features:
 * – Cached segment index; no allocation inside evaluate().
 * – Fast Newton-Raphson x-solve (4 iterations) with binary-search fallback
 *   for pathological control points.
 * – Shared pool for result buffers (same pool as LinearInterpolant).
 * – Boundary handling: clamps to the first or last on-curve point.
 */
class BezierInterpolant {
  /**
   * @param {Float32Array|Float64Array} parameterPositions – segment time boundaries, length N+1 for N segments
   * @param {Float32Array|Float64Array} controlPoints – flat array of 4 × N × sampleSize floats
   * @param {number} sampleSize – components per point (1 for scalar, 3 for Vec3, 4 for Quat)
   * @param {Float32Array} [resultBuffer] – optional reusable output buffer
   */
  constructor(parameterPositions, controlPoints, sampleSize, resultBuffer = null) {
    this.parameterPositions = parameterPositions;
    this.controlPoints = controlPoints;
    this.sampleSize = sampleSize | 0;
    this.segmentCount = parameterPositions.length - 1;

    // Each segment consumes 4 blocks of sampleSize floats
    this.stride = this.sampleSize * 4;

    if (resultBuffer) {
      this.resultBuffer = resultBuffer;
    } else {
      this.resultBuffer = LinearInterpolant.acquireBuffer(this.sampleSize);
    }

    this._cachedIndex = 0;
  }

  /**
   * Evaluate the Bezier curve at parameter t.
   * @param {number} t – global time parameter
   * @returns {Float32Array} resultBuffer
   */
  evaluate(t) {
    const pp = this.parameterPositions;
    const cp = this.controlPoints;
    const rb = this.resultBuffer;
    const ss = this.sampleSize;
    const stride = this.stride;

    // --- Boundary clamp ---
    if (t <= pp[0]) {
      const off = 0;
      for (let j = 0; j < ss; j++) rb[j] = cp[off + j];
      return rb;
    }
    if (t >= pp[pp.length - 1]) {
      const off = (this.segmentCount - 1) * stride + 3 * ss;
      for (let j = 0; j < ss; j++) rb[j] = cp[off + j];
      return rb;
    }

    // --- Locate segment (cached first, then linear scan) ---
    let seg = this._cachedIndex;
    if (t < pp[seg]) {
      while (seg > 0 && t < pp[seg]) seg--;
    } else {
      while (seg < this.segmentCount - 1 && t >= pp[seg + 1]) seg++;
    }
    this._cachedIndex = seg;

    const t0 = pp[seg];
    const t1 = pp[seg + 1];
    const u = (t - t0) / (t1 - t0);        // normalised time within segment [0,1]

    // --- Solve for curve parameter s such that X(s) = u (for easing curves) ---
    // When sampleSize === 1 and controlPoints encode (x, y) pairs, we treat
    // the curve as timing: X(s) → u, then read Y(s). For multi-component
    // tracks the curve is uniform in s and we use u directly.
    let s = u;
    if (ss === 1 && this._isTimingCurve()) {
      s = this._solveParameter(u, seg);
    }

    // --- Cubic Bezier evaluation (de Casteljau) at parameter s ---
    const base = seg * stride;
    const p0 = base;
    const p1 = base + ss;
    const p2 = base + 2 * ss;
    const p3 = base + 3 * ss;

    const v = 1 - s;
    const v2 = v * v;
    const v3 = v2 * v;
    const s2 = s * s;
    const s3 = s2 * s;

    const b0 = v3;
    const b1 = 3 * v2 * s;
    const b2 = 3 * v * s2;
    const b3 = s3;

    for (let j = 0; j < ss; j++) {
      rb[j] = b0 * cp[p0 + j] + b1 * cp[p1 + j] + b2 * cp[p2 + j] + b3 * cp[p3 + j];
    }

    return rb;
  }

  /**
   * Detect whether control points represent a 2D timing curve (x,y pairs
   * flattened into scalar blocks). Heuristic: sampleSize === 1 and stride
   * is a multiple of 8 (4 points × 2 components).
   * @private
   */
  _isTimingCurve() {
    return this.sampleSize === 1 && (this.stride % 8) === 0;
  }

  /**
   * Newton-Raphson solve for s where BezierX(s) = u, with binary-search
   * fallback. Assumes timing curve layout: each control point occupies
   * 2 floats (x, y), so point k starts at base + k*2.
   * @private
   */
  _solveParameter(u, seg) {
    const cp = this.controlPoints;
    const base = seg * this.stride;

    // Extract x coordinates of the 4 control points
    const x0 = cp[base];
    const x1 = cp[base + 2];
    const x2 = cp[base + 4];
    const x3 = cp[base + 6];

    // Newton-Raphson: 4 iterations, then binary fallback if not converged
    let s = u;
    for (let i = 0; i < 4; i++) {
      const v = 1 - s;
      const v2 = v * v;
      const s2 = s * s;
      const bx =
        v2 * v * x0 +
        3 * v2 * s * x1 +
        3 * v * s2 * x2 +
        s2 * s * x3;
      const dbx =
        3 * v2 * (x1 - x0) +
        6 * v * s * (x2 - x1) +
        3 * s2 * (x3 - x2);
      if (Math.abs(dbx) < 1e-8) break;
      const delta = (bx - u) / dbx;
      s -= delta;
      if (s < 0) s = 0;
      else if (s > 1) s = 1;
      if (Math.abs(delta) < 1e-6) return s;
    }

    // Binary-search fallback for pathological handles
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) * 0.5;
      const v = 1 - mid;
      const v2 = v * v;
      const mid2 = mid * mid;
      const bx =
        v2 * v * x0 +
        3 * v2 * mid * x1 +
        3 * v * mid2 * x2 +
        mid2 * mid * x3;
      if (bx < u) lo = mid;
      else hi = mid;
    }
    return (lo + hi) * 0.5;
  }

  /** Resets the cached segment index. */
  resetCache() {
    this._cachedIndex = 0;
  }

  /** Returns the result buffer to the pool. */
  dispose() {
    LinearInterpolant.releaseBuffer(this.resultBuffer);
    this.resultBuffer = null;
    this.parameterPositions = null;
    this.controlPoints = null;
  }
}

export { BezierInterpolant };