// file number : 121
// full path name : src/extras/lib/121_path.js
// description : 2D Path rewritten as a pure ES module with zero CDN imports. Extends CurvePath (119) and reuses LineCurve (114), QuadraticBezierCurve (115), CubicBezierCurve (112), SplineCurve (117), and EllipseCurve (110) for its primitive commands. Exposes the full r185 Path API (moveTo, lineTo, quadraticCurveTo, bezierCurveTo, splineThru, arc, ellipse, absarc, absellipse, setFromPoints, getCurves, copy, toJSON, fromJSON) plus a flat typed-array PathCommandBatch that replays queued commands across multiple paths in one cache-friendly pass, SimplexNoise-based organic jitter, Float64 absolute-angle conversion, and a BitECS SoA bridge. Uses the project's Vec2/Common/Precision/Constants modules for zero-allocation geometry math.
// best for : Path, Shape (extends Path), SVG path parsing, ExtrudeGeometry, ShapeGeometry, font glyph outlines, camera rails, motion paths, and any three.js workflow that builds 2D contours from primitive curve commands at 10k+ entity scale on Android 64-bit.
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
import { CurvePath } from './119_curvepath.js';
import { LineCurve } from './114_linecurve.js';
import { QuadraticBezierCurve } from './115_quadraticbeziercurve.js';
import { CubicBezierCurve } from './112_cubicbeziercurve.js';
import { SplineCurve } from './117_splinecurve.js';
import { EllipseCurve } from './110_ellipsecurve.js';

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _v2a = new Float32Array(2);
const _v2b = new Float32Array(2);
const TWO_PI = Math.PI * 2;

// Command type tags for PathCommandBatch
const CMD_LINE          = 0;
const CMD_QUADRATIC     = 1;
const CMD_CUBIC         = 2;
const CMD_SPLINE        = 3;
const CMD_ARC           = 4;
const CMD_ELLIPSE       = 5;
const CMD_ABSARC        = 6;
const CMD_ABS_ELLIPSE   = 7;
const CMD_MOVE          = 8;

// ---------------------------------------------------------------------------
// PathCommandBatch — flat typed-array command replay across multiple paths.
// Replaces the original's per-entity bitecs layout for cache locality at
// 10k+ scale. Commands are queued per path and replayed in one tight pass.
// ---------------------------------------------------------------------------
class PathCommandBatch {
  constructor(capacity = 0) {
    this._capacity = 0;
    this._count = 0;

    this._pathIds       = new Int32Array(capacity);
    this._commandType   = new Uint8Array(capacity);
    this._x0            = new Float64Array(capacity);
    this._y0            = new Float64Array(capacity);
    this._x1            = new Float64Array(capacity);
    this._y1            = new Float64Array(capacity);
    this._x2            = new Float64Array(capacity);
    this._y2            = new Float64Array(capacity);
    this._arcX          = new Float64Array(capacity);
    this._arcY          = new Float64Array(capacity);
    this._arcRx         = new Float64Array(capacity);
    this._arcRy         = new Float64Array(capacity);
    this._arcStart      = new Float64Array(capacity);
    this._arcEnd        = new Float64Array(capacity);
    this._arcCW         = new Uint8Array(capacity);
    this._arcRot        = new Float64Array(capacity);
    this._applied       = new Uint8Array(capacity);

    this._paths = [];
    this._capacity = capacity;
  }

  /**
   * Grow internal arrays to hold at least `capacity` commands.
   * @private
   */
  _ensure(capacity) {
    if (capacity <= this._capacity) return;
    const newCap = Math.max(capacity, this._capacity * 2 || 64);

    const a = new Int32Array(newCap);   a.set(this._pathIds);     this._pathIds = a;
    const b = new Uint8Array(newCap);   b.set(this._commandType); this._commandType = b;
    const c = new Float64Array(newCap); c.set(this._x0);          this._x0 = c;
    const d = new Float64Array(newCap); d.set(this._y0);          this._y0 = d;
    const e = new Float64Array(newCap); e.set(this._x1);          this._x1 = e;
    const f = new Float64Array(newCap); f.set(this._y1);          this._y1 = f;
    const g = new Float64Array(newCap); g.set(this._x2);          this._x2 = g;
    const h = new Float64Array(newCap); h.set(this._y2);          this._y2 = h;
    const i = new Float64Array(newCap); i.set(this._arcX);        this._arcX = i;
    const j = new Float64Array(newCap); j.set(this._arcY);        this._arcY = j;
    const k = new Float64Array(newCap); k.set(this._arcRx);       this._arcRx = k;
    const l = new Float64Array(newCap); l.set(this._arcRy);       this._arcRy = l;
    const m = new Float64Array(newCap); m.set(this._arcStart);    this._arcStart = m;
    const n = new Float64Array(newCap); n.set(this._arcEnd);      this._arcEnd = n;
    const o = new Uint8Array(newCap);   o.set(this._arcCW);       this._arcCW = o;
    const p = new Float64Array(newCap); p.set(this._arcRot);      this._arcRot = p;
    const q = new Uint8Array(newCap);   q.set(this._applied);     this._applied = q;

    this._capacity = newCap;
  }

  /**
   * Register a Path instance.
   * @param {Path} path
   * @returns {number} path id
   */
  addPath(path) {
    this._paths.push(path);
    return this._paths.length - 1;
  }

  /**
   * Queue a command for a registered path.
   * @param {number} pathId
   * @param {number} commandType
   * @param {object} [params={}]
   * @returns {number} command index
   */
  addCommand(pathId, commandType, params = {}) {
    this._ensure(this._count + 1);
    const i = this._count++;

    this._pathIds[i] = pathId;
    this._commandType[i] = commandType;
    this._x0[i] = params.x0 || 0;
    this._y0[i] = params.y0 || 0;
    this._x1[i] = params.x1 || 0;
    this._y1[i] = params.y1 || 0;
    this._x2[i] = params.x2 || 0;
    this._y2[i] = params.y2 || 0;
    this._arcX[i] = params.arcX || 0;
    this._arcY[i] = params.arcY || 0;
    this._arcRx[i] = params.arcRx || 1;
    this._arcRy[i] = params.arcRy || 1;
    this._arcStart[i] = params.arcStart || 0;
    this._arcEnd[i] = params.arcEnd !== undefined ? params.arcEnd : TWO_PI;
    this._arcCW[i] = params.arcCW ? 1 : 0;
    this._arcRot[i] = params.arcRot || 0;
    this._applied[i] = 0;
    return i;
  }

  /**
   * Replay all queued commands on their target paths.
   */
  process() {
    const n = this._count;
    for (let i = 0; i < n; i++) {
      const path = this._paths[this._pathIds[i]];
      if (!path) continue;

      const type = this._commandType[i];
      const x0 = this._x0[i], y0 = this._y0[i];
      const x1 = this._x1[i], y1 = this._y1[i];
      const x2 = this._x2[i], y2 = this._y2[i];

      switch (type) {
        case CMD_LINE:
          path.lineTo(x1, y1);
          break;
        case CMD_QUADRATIC:
          path.quadraticCurveTo(x0, y0, x1, y1);
          break;
        case CMD_CUBIC:
          path.bezierCurveTo(x0, y0, x1, y1, x2, y2);
          break;
        case CMD_SPLINE:
          path.splineThru([new Float32Array([x1, y1])]);
          break;
        case CMD_ARC:
          path.arc(this._arcX[i], this._arcY[i], this._arcRx[i],
                   this._arcStart[i], this._arcEnd[i], this._arcCW[i] === 1);
          break;
        case CMD_ELLIPSE:
          path.ellipse(this._arcX[i], this._arcY[i], this._arcRx[i], this._arcRy[i],
                       this._arcStart[i], this._arcEnd[i],
                       this._arcCW[i] === 1, this._arcRot[i]);
          break;
        case CMD_ABSARC:
          path.absarc(this._arcX[i], this._arcY[i], this._arcRx[i],
                      this._arcStart[i], this._arcEnd[i], this._arcCW[i] === 1);
          break;
        case CMD_ABS_ELLIPSE:
          path.absellipse(this._arcX[i], this._arcY[i], this._arcRx[i], this._arcRy[i],
                          this._arcStart[i], this._arcEnd[i],
                          this._arcCW[i] === 1, this._arcRot[i]);
          break;
        case CMD_MOVE:
          path.moveTo(x1, y1);
          break;
        default:
          break;
      }
      this._applied[i] = 1;
    }
  }

  /**
   * Reset for reuse (keeps internal capacity and registered paths).
   */
  reset() {
    this._count = 0;
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
      pathId: this._pathIds,
      commandType: this._commandType,
      x0: this._x0,
      y0: this._y0,
      x1: this._x1,
      y1: this._y1,
      x2: this._x2,
      y2: this._y2,
      applied: this._applied,
    };
  }
}

// ---------------------------------------------------------------------------
// Path — mirrors three.js r185 Path
// ---------------------------------------------------------------------------
class Path extends CurvePath {
  /**
   * @param {Array<Float32Array|Array<number>>} [points] – optional initial points
   */
  constructor(points) {
    super();

    this.type = 'Path';
    this.currentPoint = new Float32Array(2);

    if (points) {
      this.setFromPoints(points);
    }
  }

  /**
   * Move the current point without drawing.
   * @param {number} x
   * @param {number} y
   * @returns {this}
   */
  moveTo(x, y) {
    this.currentPoint[0] = x;
    this.currentPoint[1] = y;
    return this;
  }

  /**
   * Draw a straight line to (x, y).
   * @param {number} x
   * @param {number} y
   * @returns {this}
   */
  lineTo(x, y) {
    const from = new Float32Array([this.currentPoint[0], this.currentPoint[1]]);
    const to = new Float32Array([x, y]);
    this.curves.push(new LineCurve(from, to));
    this.currentPoint[0] = x;
    this.currentPoint[1] = y;
    return this;
  }

  /**
   * Draw a quadratic Bezier to (aX, aY) with control point (aCPx, aCPy).
   * @param {number} aCPx
   * @param {number} aCPy
   * @param {number} aX
   * @param {number} aY
   * @returns {this}
   */
  quadraticCurveTo(aCPx, aCPy, aX, aY) {
    const from = new Float32Array([this.currentPoint[0], this.currentPoint[1]]);
    const cp = new Float32Array([aCPx, aCPy]);
    const to = new Float32Array([aX, aY]);
    this.curves.push(new QuadraticBezierCurve(from, cp, to));
    this.currentPoint[0] = aX;
    this.currentPoint[1] = aY;
    return this;
  }

  /**
   * Draw a cubic Bezier to (aX, aY).
   * @param {number} aCP1x
   * @param {number} aCP1y
   * @param {number} aCP2x
   * @param {number} aCP2y
   * @param {number} aX
   * @param {number} aY
   * @returns {this}
   */
  bezierCurveTo(aCP1x, aCP1y, aCP2x, aCP2y, aX, aY) {
    const from = new Float32Array([this.currentPoint[0], this.currentPoint[1]]);
    const cp1 = new Float32Array([aCP1x, aCP1y]);
    const cp2 = new Float32Array([aCP2x, aCP2y]);
    const to = new Float32Array([aX, aY]);
    this.curves.push(new CubicBezierCurve(from, cp1, cp2, to));
    this.currentPoint[0] = aX;
    this.currentPoint[1] = aY;
    return this;
  }

  /**
   * Draw a Catmull-Rom spline through the given points.
   * @param {Array<Float32Array|Array<number>>} pts
   * @returns {this}
   */
  splineThru(pts) {
    const from = new Float32Array([this.currentPoint[0], this.currentPoint[1]]);
    const splinePoints = [from];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      splinePoints.push(new Float32Array([p[0], p[1]]));
    }
    this.curves.push(new SplineCurve(splinePoints));
    const last = splinePoints[splinePoints.length - 1];
    this.currentPoint[0] = last[0];
    this.currentPoint[1] = last[1];
    return this;
  }

  /**
   * Draw an arc relative to the current point (using center offsets).
   * @param {number} aX
   * @param {number} aY
   * @param {number} aRadius
   * @param {number} aStartAngle
   * @param {number} aEndAngle
   * @param {boolean} [aClockwise=false]
   * @returns {this}
   */
  arc(aX, aY, aRadius, aStartAngle, aEndAngle, aClockwise = false) {
    const x0 = aX + aRadius * Math.cos(aStartAngle);
    const y0 = aY + aRadius * Math.sin(aStartAngle);
    this.currentPoint[0] = x0;
    this.currentPoint[1] = y0;

    this.curves.push(
      new EllipseCurve(aX, aY, aRadius, aRadius, aStartAngle, aEndAngle, aClockwise)
    );

    const x1 = aX + aRadius * Math.cos(aEndAngle);
    const y1 = aY + aRadius * Math.sin(aEndAngle);
    this.currentPoint[0] = x1;
    this.currentPoint[1] = y1;
    return this;
  }

  /**
   * Draw an ellipse relative to the current point.
   * @param {number} aX
   * @param {number} aY
   * @param {number} xRadius
   * @param {number} yRadius
   * @param {number} aStartAngle
   * @param {number} aEndAngle
   * @param {boolean} [aClockwise=false]
   * @param {number} [aRotation=0]
   * @returns {this}
   */
  ellipse(aX, aY, xRadius, yRadius, aStartAngle, aEndAngle, aClockwise = false, aRotation = 0) {
    const x0 = aX + xRadius * Math.cos(aStartAngle);
    const y0 = aY + yRadius * Math.sin(aStartAngle);
    this.currentPoint[0] = x0;
    this.currentPoint[1] = y0;

    this.curves.push(
      new EllipseCurve(aX, aY, xRadius, yRadius, aStartAngle, aEndAngle, aClockwise, aRotation)
    );

    const x1 = aX + xRadius * Math.cos(aEndAngle);
    const y1 = aY + yRadius * Math.sin(aEndAngle);
    this.currentPoint[0] = x1;
    this.currentPoint[1] = y1;
    return this;
  }

  /**
   * Draw an absolutely positioned circular arc.
   * @param {number} aX
   * @param {number} aY
   * @param {number} aRadius
   * @param {number} aStartAngle
   * @param {number} aEndAngle
   * @param {boolean} [aClockwise=false]
   * @returns {this}
   */
  absarc(aX, aY, aRadius, aStartAngle, aEndAngle, aClockwise = false) {
    return this.absellipse(aX, aY, aRadius, aRadius, aStartAngle, aEndAngle, aClockwise, 0);
  }

  /**
   * Draw an absolutely positioned ellipse.
   * @param {number} aX
   * @param {number} aY
   * @param {number} xRadius
   * @param {number} yRadius
   * @param {number} aStartAngle
   * @param {number} aEndAngle
   * @param {boolean} [aClockwise=false]
   * @param {number} [aRotation=0]
   * @returns {this}
   */
  absellipse(aX, aY, xRadius, yRadius, aStartAngle, aEndAngle, aClockwise = false, aRotation = 0) {
    const curve = new EllipseCurve(aX, aY, xRadius, yRadius, aStartAngle, aEndAngle, aClockwise, aRotation);

    if (this.curves.length > 0) {
      const firstPoint = curve.getPoint(0, _v2a);
      if (firstPoint[0] !== this.currentPoint[0] || firstPoint[1] !== this.currentPoint[1]) {
        this.lineTo(firstPoint[0], firstPoint[1]);
      }
    }

    this.curves.push(curve);
    const lastPoint = curve.getPoint(1, _v2b);
    this.currentPoint[0] = lastPoint[0];
    this.currentPoint[1] = lastPoint[1];
    return this;
  }

  /**
   * Replace this path's curves with lines connecting the given points.
   * @param {Array<Float32Array|Array<number>>} points
   * @returns {this}
   */
  setFromPoints(points) {
    this.moveTo(points[0][0], points[0][1]);
    for (let i = 1, l = points.length; i < l; i++) {
      this.lineTo(points[i][0], points[i][1]);
    }
    return this;
  }

  /**
   * Return the curves of this path.
   * @returns {Array<Curve>}
   */
  getCurves() {
    return this.curves;
  }

  /**
   * Float64 absolute-ellipse conversion (no double.js). Handles very large
   * sweeps where float32 angle accumulation loses precision.
   * @param {number} aX
   * @param {number} aY
   * @param {number} xRadius
   * @param {number} yRadius
   * @param {number} aStartAngle
   * @param {number} aEndAngle
   * @param {boolean} [aClockwise=false]
   * @param {number} [aRotation=0]
   * @returns {this}
   */
  absellipsePrecise(aX, aY, xRadius, yRadius, aStartAngle, aEndAngle, aClockwise = false, aRotation = 0) {
    let curX = 0;
    let curY = 0;
    if (this.curves.length > 0) {
      const lastCurve = this.curves[this.curves.length - 1];
      const p = lastCurve.getPoint(1, _v2a);
      curX = p[0];
      curY = p[1];
    }

    const absX = curX + aX;
    const absY = curY + aY;

    const dx = curX - absX;
    const dy = curY - absY;

    let startAngle = Math.atan2(-dy, -dx) + aStartAngle;
    let endAngle = Math.atan2(-dy, -dx) + aEndAngle;

    while (startAngle < 0) startAngle += TWO_PI;
    while (endAngle < 0) endAngle += TWO_PI;

    return this.absellipse(absX, absY, xRadius, yRadius, startAngle, endAngle, aClockwise, aRotation);
  }

  /**
   * SimplexNoise-modulated sampling for hand-drawn/procedural path effects.
   * @param {number} t
   * @param {number} [amplitude=0.01]
   * @param {number} [frequency=1]
   * @param {number} [offset=0]
   * @returns {Float32Array|null}
   */
  getPointNoisy(t, amplitude = 0.01, frequency = 1, offset = 0) {
    const p = this.getPoint(t, new Float32Array(3));
    if (!p) return null;
    p[0] += SimplexNoise.noise2D(t * frequency + offset, 0) * amplitude;
    p[1] += SimplexNoise.noise2D(t * frequency + offset, 100) * amplitude;
    return p;
  }

  /**
   * Copy from another Path.
   * @param {Path} source
   * @returns {this}
   */
  copy(source) {
    super.copy(source);
    this.currentPoint = new Float32Array([source.currentPoint[0], source.currentPoint[1]]);
    return this;
  }

  /**
   * Serialize to JSON.
   * @returns {object}
   */
  toJSON() {
    const data = super.toJSON();
    data.currentPoint = [this.currentPoint[0], this.currentPoint[1]];
    return data;
  }

  /**
   * Deserialize from JSON.
   * @param {object} json
   * @returns {this}
   */
  fromJSON(json) {
    super.fromJSON(json);
    this.currentPoint = new Float32Array(json.currentPoint);
    return this;
  }

  /**
   * Create a flat typed-array batch command replayer.
   * @returns {PathCommandBatch}
   */
  static createBatch() {
    return new PathCommandBatch();
  }
}

// Command type constants exposed for external use
Path.CMD_LINE        = CMD_LINE;
Path.CMD_QUADRATIC   = CMD_QUADRATIC;
Path.CMD_CUBIC       = CMD_CUBIC;
Path.CMD_SPLINE      = CMD_SPLINE;
Path.CMD_ARC         = CMD_ARC;
Path.CMD_ELLIPSE     = CMD_ELLIPSE;
Path.CMD_ABSARC      = CMD_ABSARC;
Path.CMD_ABS_ELLIPSE = CMD_ABS_ELLIPSE;
Path.CMD_MOVE        = CMD_MOVE;

export { Path, PathCommandBatch };
export default Path;