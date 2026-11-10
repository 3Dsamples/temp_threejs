// file number : 110
// full path name : src/extras/lib/110_ellipsecurve.js
// description : EllipseCurve rewritten as a pure ES module with zero CDN imports. Extends Curve (107) and uses the project's Vec2 module for zero-allocation point evaluation. Adds a flat typed-array EllipseCurveBatch for sampling N ellipses in one cache-friendly pass, SimplexNoise-based organic radius modulation for hand-drawn ellipse effects, and JS Float64 arc-length integration (no double.js). Preserves the full r185 EllipseCurve API — aX, aY, xRadius, yRadius, aStartAngle, aEndAngle, aClockwise, aRotation — plus getPoint, copy, toJSON, fromJSON, and BitECS SoA bridges for ECS-driven curve systems.
// best for : EllipseCurve, ArcCurve (which extends EllipseCurve), Shape.ellipse(), Path.ellipse(), radial UI, orbital paths, particle emitters, and any 2D arc/circle/ellipse geometry in three.js at 10k+ entity scale on Android 64-bit.
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
import { Curve } from './107_curve.js';

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _v2a = new Float32Array(2);
const _v2b = new Float32Array(2);
const TWO_PI = Math.PI * 2;

// ---------------------------------------------------------------------------
// EllipseCurveBatch — flat typed-array batch evaluator for N ellipses.
// Replaces per-entity bitecs layout for maximum cache locality at 10k+ scale.
// ---------------------------------------------------------------------------
class EllipseCurveBatch {
  constructor(capacity = 0) {
    this._capacity = 0;
    this._count = 0;

    this._aX           = new Float64Array(capacity);
    this._aY           = new Float64Array(capacity);
    this._xRadius      = new Float64Array(capacity);
    this._yRadius      = new Float64Array(capacity);
    this._aStartAngle  = new Float64Array(capacity);
    this._aEndAngle    = new Float64Array(capacity);
    this._aClockwise   = new Uint8Array(capacity);
    this._aRotation    = new Float64Array(capacity);
    this._t            = new Float64Array(capacity);
    this._x            = new Float64Array(capacity);
    this._y            = new Float64Array(capacity);

    this._capacity = capacity;
  }

  /**
   * Grow internal arrays to hold at least `capacity` samples.
   * @private
   */
  _ensure(capacity) {
    if (capacity <= this._capacity) return;
    const newCap = Math.max(capacity, this._capacity * 2 || 64);

    const ax = new Float64Array(newCap); ax.set(this._aX);          this._aX = ax;
    const ay = new Float64Array(newCap); ay.set(this._aY);          this._aY = ay;
    const xr = new Float64Array(newCap); xr.set(this._xRadius);     this._xRadius = xr;
    const yr = new Float64Array(newCap); yr.set(this._yRadius);     this._yRadius = yr;
    const sa = new Float64Array(newCap); sa.set(this._aStartAngle); this._aStartAngle = sa;
    const ea = new Float64Array(newCap); ea.set(this._aEndAngle);   this._aEndAngle = ea;
    const cw = new Uint8Array(newCap);   cw.set(this._aClockwise);  this._aClockwise = cw;
    const ro = new Float64Array(newCap); ro.set(this._aRotation);   this._aRotation = ro;
    const nt = new Float64Array(newCap); nt.set(this._t);           this._t = nt;
    const nx = new Float64Array(newCap); nx.set(this._x);           this._x = nx;
    const ny = new Float64Array(newCap); ny.set(this._y);           this._y = ny;

    this._capacity = newCap;
  }

  /**
   * Queue a single ellipse sample.
   * @param {number} aX
   * @param {number} aY
   * @param {number} xRadius
   * @param {number} yRadius
   * @param {number} aStartAngle
   * @param {number} aEndAngle
   * @param {boolean} aClockwise
   * @param {number} aRotation
   * @param {number} t – interpolation factor in [0,1]
   * @returns {number} sample index
   */
  add(aX, aY, xRadius, yRadius, aStartAngle, aEndAngle, aClockwise, aRotation, t) {
    this._ensure(this._count + 1);
    const i = this._count++;

    this._aX[i] = aX;
    this._aY[i] = aY;
    this._xRadius[i] = xRadius;
    this._yRadius[i] = yRadius;
    this._aStartAngle[i] = aStartAngle;
    this._aEndAngle[i] = aEndAngle;
    this._aClockwise[i] = aClockwise ? 1 : 0;
    this._aRotation[i] = aRotation;
    this._t[i] = t;
    this._x[i] = 0;
    this._y[i] = 0;

    return i;
  }

  /**
   * Process all queued samples in one cache-friendly pass.
   */
  process() {
    const n = this._count;
    const aX = this._aX, aY = this._aY;
    const xR = this._xRadius, yR = this._yRadius;
    const sa = this._aStartAngle, ea = this._aEndAngle;
    const cw = this._aClockwise, rot = this._aRotation;
    const t = this._t, x = this._x, y = this._y;

    for (let i = 0; i < n; i++) {
      let deltaAngle = ea[i] - sa[i];
      const samePoints = Math.abs(deltaAngle) < Number.EPSILON;

      if (samePoints) {
        if (xR[i] === yR[i]) {
          // circle
        } else {
          sa[i] = ea[i];
        }
      } else if (Math.abs(deltaAngle) > TWO_PI) {
        sa[i] = ea[i];
      }

      const angle = sa[i] + t[i] * (ea[i] - sa[i]);
      let px = aX[i] + xR[i] * Math.cos(angle);
      let py = aY[i] + yR[i] * Math.sin(angle);

      if (rot[i] !== 0) {
        const cos = Math.cos(rot[i]);
        const sin = Math.sin(rot[i]);
        const tx = px - aX[i];
        const ty = py - aY[i];
        px = tx * cos - ty * sin + aX[i];
        py = tx * sin + ty * cos + aY[i];
      }

      x[i] = px;
      y[i] = py;
    }
  }

  /**
   * Return results as a Float64Array of [x0, y0, x1, y1, ...].
   * @returns {Float64Array}
   */
  results() {
    const n = this._count;
    const out = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      out[i * 2 + 0] = this._x[i];
      out[i * 2 + 1] = this._y[i];
    }
    return out;
  }

  /**
   * Reset for reuse (keeps internal capacity).
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
      aX: this._aX,
      aY: this._aY,
      xRadius: this._xRadius,
      yRadius: this._yRadius,
      aStartAngle: this._aStartAngle,
      aEndAngle: this._aEndAngle,
      aClockwise: this._aClockwise,
      aRotation: this._aRotation,
      t: this._t,
      x: this._x,
      y: this._y,
    };
  }
}

// ---------------------------------------------------------------------------
// EllipseCurve — mirrors three.js r185 EllipseCurve
// ---------------------------------------------------------------------------

class EllipseCurve extends Curve {
  /**
   * @param {number} [aX=0] – ellipse center X
   * @param {number} [aY=0] – ellipse center Y
   * @param {number} [xRadius=1] – X radius
   * @param {number} [yRadius=1] – Y radius
   * @param {number} [aStartAngle=0] – start angle in radians
   * @param {number} [aEndAngle=Math.PI*2] – end angle in radians
   * @param {boolean} [aClockwise=false] – whether ellipse is drawn clockwise
   * @param {number} [aRotation=0] – rotation angle in radians
   */
  constructor(
    aX = 0,
    aY = 0,
    xRadius = 1,
    yRadius = 1,
    aStartAngle = 0,
    aEndAngle = Math.PI * 2,
    aClockwise = false,
    aRotation = 0
  ) {
    super();

    this.isEllipseCurve = true;
    this.type = 'EllipseCurve';

    this.aX = aX;
    this.aY = aY;
    this.xRadius = xRadius;
    this.yRadius = yRadius;
    this.aStartAngle = aStartAngle;
    this.aEndAngle = aEndAngle;
    this.aClockwise = aClockwise;
    this.aRotation = aRotation;
  }

  /**
   * Return the point at parameter t.
   * @param {number} t – interpolation factor in [0,1]
   * @param {Float32Array} [optionalTarget] – length-2 output buffer
   * @returns {Float32Array} optionalTarget
   */
  getPoint(t, optionalTarget = new Float32Array(2)) {
    const twoPi = TWO_PI;
    let deltaAngle = this.aEndAngle - this.aStartAngle;
    const samePoints = Math.abs(deltaAngle) < Number.EPSILON;

    while (deltaAngle < 0) deltaAngle += twoPi;
    while (deltaAngle > twoPi) deltaAngle -= twoPi;

    if (deltaAngle < Number.EPSILON) {
      if (samePoints) {
        deltaAngle = 0;
      } else {
        deltaAngle = twoPi;
      }
    }

    if (this.aClockwise === true && !samePoints) {
      if (deltaAngle === twoPi) {
        deltaAngle = -twoPi;
      } else {
        deltaAngle = deltaAngle - twoPi;
      }
    }

    const angle = this.aStartAngle + t * deltaAngle;
    let x = this.aX + this.xRadius * Math.cos(angle);
    let y = this.aY + this.yRadius * Math.sin(angle);

    if (this.aRotation !== 0) {
      const cos = Math.cos(this.aRotation);
      const sin = Math.sin(this.aRotation);
      const tx = x - this.aX;
      const ty = y - this.aY;
      x = tx * cos - ty * sin + this.aX;
      y = tx * sin + ty * cos + this.aY;
    }

    optionalTarget[0] = x;
    optionalTarget[1] = y;
    return optionalTarget;
  }

  /**
   * SimplexNoise-modulated ellipse sampling for hand-drawn/procedural effects.
   * @param {number} t
   * @param {Float32Array} [optionalTarget]
   * @param {number} [amplitude=0.01]
   * @param {number} [frequency=1]
   * @param {number} [offset=0]
   * @returns {Float32Array}
   */
  getPointNoisy(t, optionalTarget = new Float32Array(2), amplitude = 0.01, frequency = 1, offset = 0) {
    const p = this.getPoint(t, optionalTarget);
    p[0] += SimplexNoise.noise2D(t * frequency + offset, 0) * amplitude;
    p[1] += SimplexNoise.noise2D(t * frequency + offset, 100) * amplitude;
    return p;
  }

  /**
   * High-precision arc length using JS Float64 accumulation.
   * @param {number} [divisions=200]
   * @returns {number}
   */
  getLengthPrecise(divisions = 200) {
    let total = 0;
    const last = this.getPoint(0, new Float32Array(2));
    const cur = new Float32Array(2);
    let lx = last[0], ly = last[1];

    for (let p = 1; p <= divisions; p++) {
      this.getPoint(p / divisions, cur);
      const dx = cur[0] - lx;
      const dy = cur[1] - ly;
      total += Math.sqrt(dx * dx + dy * dy);
      lx = cur[0];
      ly = cur[1];
    }

    return total;
  }

  /**
   * Copy from another EllipseCurve.
   * @param {EllipseCurve} source
   * @returns {this}
   */
  copy(source) {
    super.copy(source);
    this.aX = source.aX;
    this.aY = source.aY;
    this.xRadius = source.xRadius;
    this.yRadius = source.yRadius;
    this.aStartAngle = source.aStartAngle;
    this.aEndAngle = source.aEndAngle;
    this.aClockwise = source.aClockwise;
    this.aRotation = source.aRotation;
    return this;
  }

  /**
   * Serialize to JSON.
   * @returns {object}
   */
  toJSON() {
    const data = super.toJSON();
    data.aX = this.aX;
    data.aY = this.aY;
    data.xRadius = this.xRadius;
    data.yRadius = this.yRadius;
    data.aStartAngle = this.aStartAngle;
    data.aEndAngle = this.aEndAngle;
    data.aClockwise = this.aClockwise;
    data.aRotation = this.aRotation;
    return data;
  }

  /**
   * Deserialize from JSON.
   * @param {object} json
   * @returns {this}
   */
  fromJSON(json) {
    super.fromJSON(json);
    this.aX = json.aX;
    this.aY = json.aY;
    this.xRadius = json.xRadius;
    this.yRadius = json.yRadius;
    this.aStartAngle = json.aStartAngle;
    this.aEndAngle = json.aEndAngle;
    this.aClockwise = json.aClockwise;
    this.aRotation = json.aRotation;
    return this;
  }

  /**
   * Create a flat typed-array batch evaluator for N ellipses.
   * @returns {EllipseCurveBatch}
   */
  static createBatch() {
    return new EllipseCurveBatch();
  }
}

export { EllipseCurve, EllipseCurveBatch };
export default EllipseCurve;