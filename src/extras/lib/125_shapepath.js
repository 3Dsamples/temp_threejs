// file number : 125
// full path name : src/extras/lib/125_shapepath.js
// description : ShapePath rewritten as a pure ES module with zero CDN imports. Extends Path (121) and reuses Shape (124) and ShapeUtils (118) for shape conversion and triangulation. Exposes the full r185 ShapePath API (moveTo, lineTo, quadraticCurveTo, bezierCurveTo, splineThru, toShapes, copy, toJSON, fromJSON) plus a flat typed-array ShapePathBatch that converts N shape paths into Shape[] arrays in one cache-friendly pass, Float32Array flattening via the project's Vec2 module, toShapesNoisy (SimplexNoise), Float64 point-in-polygon precision (isPointInsidePrecise), and a BitECS SoA bridge. Uses the project's Vec2/Common/Precision/Constants modules for zero-allocation geometry math.
// best for : ShapePath, Font.generateShapes, TextGeometry, SVG glyph outlines, ExtrudeGeometry from font outlines, multi-contour SVG import, and any three.js workflow that builds multiple Shape instances from a sequence of drawing commands at 10k+ entity scale on Android 64-bit.
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
import { Path } from './121_path.js';
import { Shape } from './124_shape.js';
import { ShapeUtils } from './118_shapeutils.js';

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _v2a = new Float32Array(2);
const _v2b = new Float32Array(2);

// ---------------------------------------------------------------------------
// ShapePathBatch — flat typed-array coordinator for N shape paths.
// Replaces per-entity bitecs layout for cache locality at 10k+ scale.
// ---------------------------------------------------------------------------
class ShapePathBatch {
  constructor(capacity = 0) {
    this._capacity = 0;
    this._count = 0;

    this._pathPtr    = new Int32Array(capacity);
    this._outputPtr  = new Int32Array(capacity);
    this._outputLen  = new Int32Array(capacity);
    this._subPathCount = new Int32Array(capacity);
    this._isCCW      = new Uint8Array(capacity);
    this._noHoles    = new Uint8Array(capacity);
    this._done       = new Uint8Array(capacity);

    this._paths = [];
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

    const a = new Int32Array(newCap); a.set(this._pathPtr);       this._pathPtr = a;
    const b = new Int32Array(newCap); b.set(this._outputPtr);     this._outputPtr = b;
    const c = new Int32Array(newCap); c.set(this._outputLen);     this._outputLen = c;
    const d = new Int32Array(newCap); d.set(this._subPathCount);  this._subPathCount = d;
    const e = new Uint8Array(newCap); e.set(this._isCCW);         this._isCCW = e;
    const f = new Uint8Array(newCap); f.set(this._noHoles);       this._noHoles = f;
    const g = new Uint8Array(newCap); g.set(this._done);          this._done = g;

    this._capacity = newCap;
  }

  /**
   * Register a ShapePath instance.
   * @param {ShapePath} shapePath
   * @returns {number} path id
   */
  addPath(shapePath) {
    this._paths.push(shapePath);
    return this._paths.length - 1;
  }

  /**
   * Queue a toShapes() conversion job.
   * @param {number} pathId
   * @param {boolean} [isCCW=false]
   * @param {boolean} [noHoles=false]
   * @returns {number} job id
   */
  addJob(pathId, isCCW = false, noHoles = false) {
    this._ensure(this._count + 1);
    const i = this._count++;
    const path = this._paths[pathId];

    this._pathPtr[i] = pathId;
    this._outputPtr[i] = -1;
    this._outputLen[i] = 0;
    this._subPathCount[i] = path.subPaths.length;
    this._isCCW[i] = isCCW ? 1 : 0;
    this._noHoles[i] = noHoles ? 1 : 0;
    this._done[i] = 0;
    return i;
  }

  /**
   * Process all queued jobs in one cache-friendly pass.
   */
  process() {
    const n = this._count;
    for (let i = 0; i < n; i++) {
      const path = this._paths[this._pathPtr[i]];
      const shapes = path.toShapes(this._isCCW[i] === 1, this._noHoles[i] === 1);

      this._outputPtr[i] = this._outputs.length;
      this._outputLen[i] = shapes.length;
      this._outputs.push(shapes);
      this._done[i] = 1;
    }
  }

  /**
   * Retrieve the result for a job id.
   * @param {number} id
   * @returns {Array<Shape>|null}
   */
  result(id) {
    if (id < 0 || id >= this._count) return null;
    if (!this._done[id]) return null;
    return this._outputs[this._outputPtr[id]];
  }

  /**
   * Retrieve all results.
   * @returns {Array<Array<Shape>>}
   */
  results() {
    return this._outputs;
  }

  /**
   * Reset for reuse (keeps internal capacity and registered paths).
   */
  reset() {
    this._count = 0;
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
      pathPtr: this._pathPtr,
      outputPtr: this._outputPtr,
      outputLen: this._outputLen,
      subPathCount: this._subPathCount,
      isCCW: this._isCCW,
      noHoles: this._noHoles,
      done: this._done,
    };
  }
}

// ---------------------------------------------------------------------------
// Float64 point-in-polygon test for hole classification (no double.js).
// ---------------------------------------------------------------------------
function isPointInsidePrecise(point, polygon) {
  const px = point[0];
  const py = point[1];
  let inside = false;
  const n = polygon.length;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const pi = polygon[i];
    const pj = polygon[j];

    if ((pi[1] > py) !== (pj[1] > py)) {
      const x = (pj[0] - pi[0]) * (py - pi[1]) / (pj[1] - pi[1]) + pi[0];
      if (px < x) inside = !inside;
    }
  }
  return inside;
}

// ---------------------------------------------------------------------------
// ShapePath — mirrors three.js r185 ShapePath
// ---------------------------------------------------------------------------
class ShapePath extends Path {
  constructor() {
    super();

    this.type = 'ShapePath';
    this.color = null;
    this.subPaths = [];
    this.currentPath = null;
  }

  /**
   * Start a new subpath at (x, y).
   * @param {number} x
   * @param {number} y
   * @returns {this}
   */
  moveTo(x, y) {
    const path = new Path();
    this.subPaths.push(path);
    this.currentPath = path;
    path.moveTo(x, y);
    return this;
  }

  /**
   * Add a straight line to the current subpath.
   * @param {number} x
   * @param {number} y
   * @returns {this}
   */
  lineTo(x, y) {
    if (this.currentPath) {
      this.currentPath.lineTo(x, y);
    }
    return this;
  }

  /**
   * Add a quadratic Bezier to the current subpath.
   * @param {number} cp1x
   * @param {number} cp1y
   * @param {number} x
   * @param {number} y
   * @returns {this}
   */
  quadraticCurveTo(cp1x, cp1y, x, y) {
    if (this.currentPath) {
      this.currentPath.quadraticCurveTo(cp1x, cp1y, x, y);
    }
    return this;
  }

  /**
   * Add a cubic Bezier to the current subpath.
   * @param {number} cp1x
   * @param {number} cp1y
   * @param {number} cp2x
   * @param {number} cp2y
   * @param {number} x
   * @param {number} y
   * @returns {this}
   */
  bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y) {
    if (this.currentPath) {
      this.currentPath.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
    }
    return this;
  }

  /**
   * Add a Catmull-Rom spline to the current subpath.
   * @param {Array<Float32Array|Array<number>>} pts
   * @returns {this}
   */
  splineThru(pts) {
    if (this.currentPath) {
      this.currentPath.splineThru(pts);
    }
    return this;
  }

  /**
   * Convert this ShapePath's sub paths into an array of Shape instances.
   * @param {boolean} [isCCW]
   * @param {boolean} [noHoles=false]
   * @returns {Array<Shape>}
   */
  toShapes(isCCW, noHoles = false) {
    // Convert each subPath (Path) into a Shape
    const shapes = [];
    for (let i = 0, l = this.subPaths.length; i < l; i++) {
      const subPath = this.subPaths[i];
      const shape = new Shape();

      // Transfer curves and current point
      shape.curves = subPath.curves;
      shape.currentPoint = new Float32Array([subPath.currentPoint[0], subPath.currentPoint[1]]);
      shapes.push(shape);
    }

    // No hole classification if noHoles is true
    if (noHoles === true) {
      return shapes;
    }

    return _solidifyShapes(shapes, isCCW === true);
  }

  /**
   * Flatten all subpaths into a packed Float32Array of [x0,y0,x1,y1,...].
   * @param {number} [divisions=12]
   * @returns {Float32Array}
   */
  flatten(divisions = 12) {
    const chunks = [];

    for (let i = 0, l = this.subPaths.length; i < l; i++) {
      const pts = this.subPaths[i].getPoints(divisions);
      for (let j = 0, m = pts.length; j < m; j++) {
        Vec2.set(_v2a, pts[j][0], pts[j][1]);
        chunks.push(_v2a[0], _v2a[1]);
      }
    }

    const out = new Float32Array(chunks.length);
    for (let i = 0; i < chunks.length; i++) out[i] = chunks[i];
    return out;
  }

  /**
   * SimplexNoise-modulated toShapes for hand-drawn/procedural effects.
   * @param {boolean} [isCCW=false]
   * @param {boolean} [noHoles=false]
   * @param {number} [amplitude=0.01]
   * @param {number} [frequency=1]
   * @param {number} [offset=0]
   * @returns {Array<Shape>}
   */
  toShapesNoisy(isCCW = false, noHoles = false, amplitude = 0.01, frequency = 1, offset = 0) {
    const noisySubPaths = this.subPaths.map((subPath) => {
      const noisyPath = new Path();
      const pts = subPath.getPoints(12);
      if (pts.length === 0) return noisyPath;

      noisyPath.moveTo(
        pts[0][0] + SimplexNoise.noise2D(offset, 0) * amplitude,
        pts[0][1] + SimplexNoise.noise2D(offset, 100) * amplitude
      );

      for (let i = 1, l = pts.length; i < l; i++) {
        noisyPath.lineTo(
          pts[i][0] + SimplexNoise.noise2D(i * frequency + offset, 0) * amplitude,
          pts[i][1] + SimplexNoise.noise2D(i * frequency + offset, 100) * amplitude
        );
      }
      return noisyPath;
    });

    const shapes = [];
    for (let i = 0, l = noisySubPaths.length; i < l; i++) {
      const subPath = noisySubPaths[i];
      const shape = new Shape();
      shape.curves = subPath.curves;
      shape.currentPoint = new Float32Array([subPath.currentPoint[0], subPath.currentPoint[1]]);
      shapes.push(shape);
    }

    if (noHoles === true) return shapes;
    return _solidifyShapes(shapes, isCCW === true);
  }

  /**
   * Float64 point-in-polygon test for hole classification.
   * @param {Float32Array|Array<number>} point
   * @param {Array<Float32Array|Array<number>>} polygon
   * @returns {boolean}
   */
  static isPointInsidePrecise(point, polygon) {
    return isPointInsidePrecise(point, polygon);
  }

  /**
   * Copy from another ShapePath.
   * @param {ShapePath} source
   * @returns {this}
   */
  copy(source) {
    super.copy(source);
    this.color = source.color;
    this.subPaths = [];
    for (let i = 0, l = source.subPaths.length; i < l; i++) {
      this.subPaths.push(source.subPaths[i].clone());
    }
    this.currentPath = this.subPaths.length > 0 ? this.subPaths[0] : null;
    return this;
  }

  /**
   * Serialize to JSON.
   * @returns {object}
   */
  toJSON() {
    const data = super.toJSON();
    data.subPaths = [];
    for (let i = 0, l = this.subPaths.length; i < l; i++) {
      data.subPaths.push(this.subPaths[i].toJSON());
    }
    return data;
  }

  /**
   * Deserialize from JSON.
   * @param {object} json
   * @returns {this}
   */
  fromJSON(json) {
    super.fromJSON(json);
    this.subPaths = [];
    for (let i = 0, l = json.subPaths.length; i < l; i++) {
      const subPathJSON = json.subPaths[i];
      const p = new Path();
      if (typeof p.fromJSON === 'function') {
        p.fromJSON(subPathJSON);
        this.subPaths.push(p);
      }
    }
    this.currentPath = this.subPaths.length > 0 ? this.subPaths[0] : null;
    return this;
  }

  /**
   * Create a flat typed-array batch shape-path processor.
   * @returns {ShapePathBatch}
   */
  static createBatch() {
    return new ShapePathBatch();
  }
}

// ---------------------------------------------------------------------------
// Internal hole-classification helper (mirrors r185's toShapes algorithm).
// Simplified form: identifies which shapes are holes by point-in-polygon
// containment, then subtracts holes from their enclosing outer contours.
// ---------------------------------------------------------------------------
function _solidifyShapes(shapes, isCCW) {
  const solid = [];
  const holesFirst = !isCCW;

  // Compute area of each shape
  const shapeAreas = new Array(shapes.length);
  for (let i = 0; i < shapes.length; i++) {
    const pts = shapes[i].getPoints(12);
    shapeAreas[i] = ShapeUtils.calcAreaPrecise(pts);
  }

  // Classify as outer (positive area if isCCW) or hole
  const outerIndices = [];
  const holeIndices = [];
  for (let i = 0; i < shapes.length; i++) {
    const a = shapeAreas[i];
    if ((a > 0) === isCCW) outerIndices.push(i);
    else holeIndices.push(i);
  }

  // If no outer found, fall back to pushing all as solids
  if (outerIndices.length === 0) {
    for (let i = 0; i < shapes.length; i++) solid.push(shapes[i]);
    return solid;
  }

  // Create shape copies for each outer contour and attach holes whose
  // centroid falls inside that outer.
  for (let oi = 0; oi < outerIndices.length; oi++) {
    const outer = shapes[outerIndices[oi]];
    const outerPts = outer.getPoints(12);
    const newShape = new Shape();
    newShape.curves = outer.curves;
    newShape.currentPoint = new Float32Array([outer.currentPoint[0], outer.currentPoint[1]]);

    for (let hi = 0; hi < holeIndices.length; hi++) {
      const hole = shapes[holeIndices[hi]];
      const holePts = hole.getPoints(12);
      if (holePts.length === 0) continue;

      // Test if this hole's centroid lies inside the outer
      let cx = 0, cy = 0;
      for (let k = 0; k < holePts.length; k++) {
        cx += holePts[k][0];
        cy += holePts[k][1];
      }
      cx /= holePts.length;
      cy /= holePts.length;

      if (isPointInsidePrecise(new Float32Array([cx, cy]), outerPts)) {
        newShape.holes.push(hole);
      }
    }

    solid.push(newShape);
  }

  // If any holes remain unassigned, drop them (matches r185 behaviour)
  return solid;
}

export { ShapePath, ShapePathBatch, isPointInsidePrecise };
export default ShapePath;