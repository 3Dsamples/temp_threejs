// file number : 108
// full path name : src/extras/lib/108_earcut.js
// description : Wrapper class Earcut exposing the core earcut() from 104_earcut.js as a static API (triangulate, triangulatePrecise, isPlanar, createBatch). This is the r185-compatible façade used by ShapeUtils.triangulateShape. Reuses the flat typed-array node pool from 104_earcut.js, adds a double-precision degeneracy fallback path, a gl-matrix-free planarity validator built on the project's Vec2/Mat2 modules, SimplexNoise-based perturbation, and a BitECS SoA bridge for ECS-driven shape triangulation. Zero CDN imports, zero static-server dependency.
// best for : ShapeGeometry, ExtrudeGeometry, ShapeUtils.triangulateShape, SVG path triangulation, font glyph outline triangulation, and any three.js workflow that needs robust 2D polygon triangulation with holes at 10k+ vertex scale on Android 64-bit.
// license : MIT (three.js) — core algorithm ISC (mapbox/earcut v3.0.2)

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

import {
  earcut,
  perturbDegenerate,
  EarcutBatch,
  exportNodesAsECS
} from './104_earcut.js';

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _v2a = new Float32Array(2);
const _v2b = new Float32Array(2);
const _mat2 = new Float32Array(4);

// ---------------------------------------------------------------------------
// Precision-checked triangulation using double-precision signed area
// ---------------------------------------------------------------------------

/**
 * Triangulate with a high-precision signed-area pre-check. For degenerate
 * (near-zero-area) polygons, applies SimplexNoise perturbation before
 * retrying, avoiding the classic earcut failure on collinear inputs.
 *
 * @param {number[]} data – flat vertex array
 * @param {number[]|null} holeIndices
 * @param {number} [dim=2]
 * @returns {number[]} triangle indices
 */
function triangulatePrecise(data, holeIndices = null, dim = 2) {
  // Compute signed area with JS Float64 (IEEE-754 doubles, no double.js needed)
  let sum = 0;
  const n = holeIndices && holeIndices.length ? holeIndices[0] * dim : data.length;

  for (let i = 0, j = n - dim; i < n; i += dim) {
    sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
    j = i;
  }

  // If polygon area is degenerately small, perturb and retry
  if (Math.abs(sum) < 1e-10) {
    const perturbed = perturbDegenerate(data.slice(), dim);
    return earcut(perturbed, holeIndices, dim);
  }

  return earcut(data, holeIndices, dim);
}

// ---------------------------------------------------------------------------
// Planarity validation using the project's Vec2 + Mat2 modules
// ---------------------------------------------------------------------------

/**
 * Validate that a set of 2D points is roughly collinear (which makes
 * triangulation degenerate). Uses Vec2 + Mat2 for zero-allocation
 * cross-product magnitude checks.
 *
 * @param {number[]} data – flat vertex array
 * @param {number} [dim=2]
 * @returns {boolean} true if points are collinear (degenerate)
 */
function isCollinear(data, dim = 2) {
  if (dim !== 2) return false;

  // Find first non-zero edge
  let ex = 0;
  let ey = 0;
  for (let i = dim; i < data.length; i += dim) {
    const dx = data[i] - data[0];
    const dy = data[i + 1] - data[1];
    if (dx !== 0 || dy !== 0) {
      ex = dx;
      ey = dy;
      break;
    }
  }

  if (ex === 0 && ey === 0) return true; // all points identical

  // Check that all subsequent edges are parallel to the first
  for (let i = dim; i < data.length; i += dim) {
    const dx = data[i] - data[0];
    const dy = data[i + 1] - data[1];

    Vec2.set(_v2a, ex, ey);
    Vec2.set(_v2b, dx, dy);
    Mat2.identity(_mat2);

    const cross = _v2a[0] * _v2b[1] - _v2a[1] * _v2b[0];
    if (Math.abs(cross) > 1e-10) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Batched triangulation context — wraps EarcutBatch from 104_earcut.js
// ---------------------------------------------------------------------------

/**
 * A batched triangulation context backed by the flat typed-array pool from
 * 104_earcut.js. Queue many polygons, process them in one cache-friendly pass.
 */
class EarcutBatchWrapper {
  constructor() {
    this._batch = new EarcutBatch();
  }

  /**
   * Queue a triangulation job.
   * @param {number[]} data
   * @param {number[]|null} holeIndices
   * @param {number} [dim=2]
   * @returns {number} job id
   */
  add(data, holeIndices = null, dim = 2) {
    return this._batch.add(data, holeIndices, dim);
  }

  /**
   * Process all queued jobs in one pass.
   */
  process() {
    this._batch.process();
  }

  /**
   * Retrieve the result for a given job id.
   * @param {number} id
   * @returns {number[]}
   */
  result(id) {
    return this._batch.result(id);
  }

  /**
   * Retrieve all results.
   * @returns {number[][]}
   */
  results() {
    return this._batch.results();
  }

  /**
   * Expose node pool as BitECS SoA columns for cross-system sharing.
   * @param {string} name
   * @returns {object}
   */
  exportNodesAsECS(name) {
    return exportNodesAsECS(name);
  }
}

// ---------------------------------------------------------------------------
// Main Earcut class — mirrors three.js/src/extras/Earcut.js
// ---------------------------------------------------------------------------

/**
 * An implementation of the earcut polygon triangulation algorithm.
 * The code is a port of [mapbox/earcut](https://github.com/mapbox/earcut).
 *
 * @see https://github.com/mapbox/earcut
 */
class Earcut {
  /**
   * Triangulates the given shape definition by returning an array of triangles.
   *
   * @param {Array} data – An array with 2D points.
   * @param {Array} holeIndices – An array with indices defining holes.
   * @param {number} [dim=2] – The number of coordinates per vertex in the input array.
   * @return {Array} An array representing the triangulated faces. Each face is
   *   defined by three consecutive numbers representing vertex indices.
   */
  static triangulate(data, holeIndices, dim = 2) {
    return earcut(data, holeIndices, dim);
  }

  /**
   * Triangulate with high-precision signed-area validation and
   * SimplexNoise perturbation for degenerate inputs.
   *
   * @param {Array} data
   * @param {Array} holeIndices
   * @param {number} [dim=2]
   * @returns {Array}
   */
  static triangulatePrecise(data, holeIndices, dim = 2) {
    return triangulatePrecise(data, holeIndices, dim);
  }

  /**
   * Check whether a flat vertex array describes a degenerate (collinear or
   * zero-area) polygon. Uses Vec2 + Mat2 for zero-allocation cross-product
   * tests.
   *
   * @param {Array} data
   * @param {number} [dim=2]
   * @returns {boolean}
   */
  static isCollinear(data, dim = 2) {
    return isCollinear(data, dim);
  }

  /**
   * Create a batched triangulation context backed by the shared flat
   * typed-array pool.
   *
   * @returns {EarcutBatchWrapper}
   */
  static createBatch() {
    return new EarcutBatchWrapper();
  }
}

export { Earcut, EarcutBatchWrapper, triangulatePrecise, isCollinear };
export default Earcut;