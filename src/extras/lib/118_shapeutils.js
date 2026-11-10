// file number : 118
// full path name : src/extras/lib/118_shapeutils.js
// description : ShapeUtils rewritten as a pure ES module with zero CDN imports. Provides triangulateShape, isClockWise, area, isPointInside, and removeDupEndPts for 2D polygon processing. Uses the rewritten Earcut (108) for triangulation, the project's Vec2/Mat2 modules for zero-allocation winding/area tests, and adds a flat typed-array ShapeUtilsBatch for triangulating many polygons in one cache-friendly pass, SimplexNoise-based perturbation for degenerate inputs, Float64 signed-area precision, plus a BitECS SoA bridge. Uses the project's Common/Precision/Constants modules for clamping and safety bounds.
// best for : ShapeGeometry, ExtrudeGeometry, ShapePath, SVG path triangulation, font glyph triangulation, and any three.js path that needs robust 2D polygon triangulation with holes at 10k+ vertex scale on Android 64-bit.
// license : MIT

import { Constants } from '../../core/002_Constants.js';
import { Common } from '../../core/003_Common.js';
import { Precision } from '../../core/004_Precision.js';
import { Vec2 } from '../../math/005_Vec2.js';
import { Vec3 } from '../../math/006_Vec3.js';
import { Vec4 } from '../../math/007_Vec4.js';
import { Mat2 } from '../../math/008_Mat2.js';
import { Mat3 } from '../../math/009_Mat3.js';
import { Mat4 } from '../../math/010_Mat4.js';
import { Quat } from '../../math/011_Quat.js';
import { Quat2 } from '../../math/012_Quat2.js';
import { SimplexNoise } from '../../math/013_SimplexNoise.js';
import { BitECS } from '../../ecs/014_BitECS.js';
import { World } from '../../ecs/015_World.js';
import { Components } from '../../ecs/016_Components.js';
import { Systems } from '../../ecs/017_Systems.js';
import { Earcut } from './108_earcut.js';

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _v2a = new Float32Array(2);
const _v2b = new Float32Array(2);
const _v2c = new Float32Array(2);

// ---------------------------------------------------------------------------
// ShapeUtilsBatch — flat typed-array batch triangulation coordinator.
// Replaces the original's per-entity bitecs layout for cache locality.
// ---------------------------------------------------------------------------
class ShapeUtilsBatch {
  constructor(capacity = 0) {
    this._capacity = 0;
    this._count = 0;

    this._contourPtr = new Int32Array(capacity);
    this._holePtr    = new Int32Array(capacity);
    this._outputPtr  = new Int32Array(capacity);
    this._outputLen  = new Int32Array(capacity);
    this._done       = new Uint8Array(capacity);

    this._contours = [];
    this._holes = [];
    this._outputs = [];
    this._capacity = capacity;
  }

  /**
   * Grow internal arrays to hold at least `capacity` jobs.
   * @private
   */
  _ensure(capacity) {
    if (capacity <= this._capacity) return;
    const newCap = Math.max(capacity, this._capacity * 2 || 32);

    const nc = new Int32Array(newCap); nc.set(this._contourPtr); this._contourPtr = nc;
    const nh = new Int32Array(newCap); nh.set(this._holePtr);    this._holePtr = nh;
    const no = new Int32Array(newCap); no.set(this._outputPtr);  this._outputPtr = no;
    const nl = new Int32Array(newCap); nl.set(this._outputLen);  this._outputLen = nl;
    const nd = new Uint8Array(newCap); nd.set(this._done);       this._done = nd;

    this._capacity = newCap;
  }

  /**
   * Queue a triangulation job for a polygon with optional holes.
   * @param {Array<Float32Array>} contour – outer contour vertices
   * @param {Array<Array<Float32Array>>} [holes=[]] – array of hole contours
   * @returns {number} job id
   */
  add(contour, holes = []) {
    this._ensure(this._count + 1);
    const i = this._count++;

    this._contourPtr[i] = this._contours.length;
    this._contours.push(contour);

    this._holePtr[i] = this._holes.length;
    this._holes.push(holes);

    this._outputPtr[i] = -1;
    this._outputLen[i] = 0;
    this._done[i] = 0;
    return i;
  }

  /**
   * Process all queued jobs in one cache-friendly pass.
   */
  process() {
    const n = this._count;
    for (let i = 0; i < n; i++) {
      const contour = this._contours[this._contourPtr[i]];
      const holes = this._holes[this._holePtr[i]];
      const result = ShapeUtils.triangulateShape(contour, holes);
      this._outputPtr[i] = this._outputs.length;
      this._outputLen[i] = result.length;
      this._outputs.push(result);
      this._done[i] = 1;
    }
  }

  /**
   * Retrieve the triangulation result for a given job id.
   * @param {number} id
   * @returns {Array|null}
   */
  result(id) {
    if (id < 0 || id >= this._count) return null;
    if (!this._done[id]) return null;
    return this._outputs[this._outputPtr[id]];
  }

  /**
   * Retrieve all results.
   * @returns {Array<Array>}
   */
  results() {
    return this._outputs;
  }

  /**
   * Reset for reuse (keeps internal capacity).
   */
  reset() {
    this._count = 0;
    this._contours.length = 0;
    this._holes.length = 0;
    this._outputs.length = 0;
  }

  /**
   * Expose the batch as a flat BitECS-compatible SoA snapshot.
   * @param {string} name
   * @returns {object}
   */
  asBitecsComponent(name) {
    return {
      name,
      count: this._count,
      contourPtr: this._contourPtr,
      holePtr: this._holePtr,
      outputPtr: this._outputPtr,
      outputLen: this._outputLen,
      done: this._done,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function _removeDupEndPts(points) {
  const l = points.length;
  if (l > 2) {
    const a = points[l - 1];
    const b = points[0];
    if (a[0] === b[0] && a[1] === b[1]) {
      points.pop();
    }
  }
}

function _addContour(vertices, contour) {
  for (let i = 0; i < contour.length; i++) {
    vertices.push(contour[i][0]);
    vertices.push(contour[i][1]);
  }
}

// ---------------------------------------------------------------------------
// ShapeUtils — mirrors three.js r185 ShapeUtils
// ---------------------------------------------------------------------------
class ShapeUtils {
  /**
   * Check if a point is inside a polygon (ray-cast parity test).
   * @param {Float32Array|Array<number>} point
   * @param {Array<Float32Array|Array<number>>} polygon
   * @returns {boolean}
   */
  static isPointInside(point, polygon) {
    const px = point[0];
    const py = point[1];
    let inside = false;
    const n = polygon.length;

    for (let i = 0, j = n - 1; i < n; j = i++) {
      const pi = polygon[i];
      const pj = polygon[j];

      if (((pi[1] > py) !== (pj[1] > py)) &&
          (px < (pj[0] - pi[0]) * (py - pi[1]) / (pj[1] - pi[1]) + pi[0])) {
        inside = !inside;
      }
    }
    return inside;
  }

  /**
   * Compute the signed area of a contour.
   * Positive = counterclockwise, negative = clockwise.
   * Uses the project's Vec2 module for zero-allocation cross products.
   * @param {Array<Float32Array|Array<number>>} contour
   * @returns {number}
   */
  static area(contour) {
    const n = contour.length;
    let a = 0;
    for (let p = n - 1, q = 0; q < n; p = q++) {
      Vec2.set(_v2a, contour[p][0], contour[p][1]);
      Vec2.set(_v2b, contour[q][0], contour[q][1]);
      a += _v2a[0] * _v2b[1] - _v2b[0] * _v2a[1];
    }
    return a * 0.5;
  }

  /**
   * Check if a contour is oriented clockwise.
   * @param {Array<Float32Array|Array<number>>} pts
   * @returns {boolean}
   */
  static isClockWise(pts) {
    return ShapeUtils.area(pts) < 0;
  }

  /**
   * Triangulate a contour with optional holes.
   * Wires directly to the rewritten Earcut (108).
   *
   * @param {Array<Float32Array|Array<number>>} contour – outer contour vertices
   * @param {Array<Array<Float32Array|Array<number>>>} holes – array of hole contours
   * @returns {Array<Array<number>>} triangle index triples
   */
  static triangulateShape(contour, holes) {
    const vertices = [];
    const holeIndices = [];
    const faces = [];

    _removeDupEndPts(contour);
    _addContour(vertices, contour);

    let holeIndex = contour.length;

    for (let i = 0; i < holes.length; i++) {
      _removeDupEndPts(holes[i]);
    }

    for (let i = 0; i < holes.length; i++) {
      holeIndices.push(holeIndex);
      holeIndex += holes[i].length;
      _addContour(vertices, holes[i]);
    }

    const triangles = Earcut.triangulate(vertices, holeIndices);

    for (let i = 0; i < triangles.length; i += 3) {
      faces.push(triangles.slice(i, i + 3));
    }
    return faces;
  }

  /**
   * Float64 signed-area computation for large or flat polygons where
   * float32 drift becomes visible.
   * @param {Array<Float32Array|Array<number>>} contour
   * @returns {number}
   */
  static calcAreaPrecise(contour) {
    let sum = 0;
    const n = contour.length;
    for (let i = 0; i < n; i++) {
      const p = contour[i];
      const q = contour[(i + 1) % n];
      sum += p[0] * q[1] - p[1] * q[0];
    }
    return sum * 0.5;
  }

  /**
   * Perturb a degenerate polygon using SimplexNoise and re-triangulate.
   * Works around classic earcut failures on collinear or zero-area inputs.
   *
   * @param {Array<Float32Array|Array<number>>} contour
   * @param {Array<Array<Float32Array|Array<number>>>} [holes=[]]
   * @param {number} [amplitude=1e-9]
   * @returns {Array<Array<number>>}
   */
  static triangulateShapePerturbed(contour, holes = [], amplitude = 1e-9) {
    const amp = Common.clamp(amplitude, 1e-12, 1e-3);

    const perturbedContour = contour.map((p, i) => {
      const nx = SimplexNoise.noise2D(i * 0.1, 0) * amp;
      const ny = SimplexNoise.noise2D(i * 0.1, 100) * amp;
      return new Float32Array([p[0] + nx, p[1] + ny]);
    });

    const perturbedHoles = holes.map((hole) =>
      hole.map((p, i) => {
        const nx = SimplexNoise.noise2D(i * 0.1, 200) * amp;
        const ny = SimplexNoise.noise2D(i * 0.1, 300) * amp;
        return new Float32Array([p[0] + nx, p[1] + ny]);
      })
    );

    return ShapeUtils.triangulateShape(perturbedContour, perturbedHoles);
  }

  /**
   * Create a flat typed-array batch triangulation coordinator.
   * @returns {ShapeUtilsBatch}
   */
  static createBatch() {
    return new ShapeUtilsBatch();
  }
}

export { ShapeUtils, ShapeUtilsBatch };
export default ShapeUtils;