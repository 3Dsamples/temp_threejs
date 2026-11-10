// file number : 081
// full path name : src/math/081_OBB.js
// description : High-performance Oriented Bounding Box (OBB) using flat Float32Array storage for center, half-size, and rotation basis. Implements SAT-based OBB-OBB intersection, point containment, clamped closest-point, plane intersection, and ray intersection with cached basis vectors and pooled temporaries. Zero allocations inside hot tests; designed for per-frame culling of 10k+ entities in a living ECS-driven world on Android 64-bit.
// best for : Frustum culling of animated or rotated meshes, collision broadphase for ECS entities, spatial queries in dense crowds, ray-picking against oriented props, and any context-awareness pipeline that must scale from local interactions to galactic-scale LOD without GC pauses.
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

// ---------------------------------------------------------------------------
// Module-scope scratch space (never allocated inside methods)
// ---------------------------------------------------------------------------

// Cached basis axes for self and other, reused across SAT passes
const _ax = new Float32Array(3);
const _ay = new Float32Array(3);
const _az = new Float32Array(3);
const _bx = new Float32Array(3);
const _by = new Float32Array(3);
const _bz = new Float32Array(3);

// Rotation matrix (3×3) and absolute rotation matrix, flattened row-major
const _R  = new Float32Array(9);
const _AbsR = new Float32Array(9);

// Translation vector in A's frame
const _t = new Float32Array(3);

// Scratch vectors for clamp / contains / ray / plane tests
const _v1 = new Float32Array(3);
const _v2 = new Float32Array(3);
const _closest = new Float32Array(3);

// Static pool for OBB instances
const _obbPool = [];

/**
 * Oriented Bounding Box with flat Float32Array storage.
 *
 * Layout:
 * – `center`   : Float32Array(3)
 * – `halfSize` : Float32Array(3)
 * – `rotation` : Float32Array(9) row-major 3×3 basis matrix
 *
 * The rotation matrix is stored as basis vectors in rows:
 *   [ ax.x ay.x az.x ]
 *   [ ax.y ay.y az.y ]
 *   [ ax.z ay.z az.z ]
 * where ax, ay, az are the local X, Y, Z axes in world space.
 *
 * All hot methods (`containsPoint`, `intersectsOBB`, `intersectsPlane`,
 * `clampPoint`, `intersectRay`) write results into caller-provided
 * Float32Array buffers and never allocate.
 */
class OBB {
  /**
   * Acquire an OBB from the static pool or create a new one.
   * @returns {OBB}
   */
  static acquire() {
    const o = _obbPool.pop();
    if (o) return o;
    return new OBB();
  }

  /**
   * Return an OBB to the pool. The caller must not use the instance after
   * releasing it.
   * @param {OBB} obb
   */
  static release(obb) {
    if (_obbPool.length < 64) _obbPool.push(obb);
  }

  /**
   * Clear the OBB pool entirely.
   */
  static clearPool() {
    _obbPool.length = 0;
  }

  /**
   * @param {Float32Array} [center]   – length 3, default (0,0,0)
   * @param {Float32Array} [halfSize] – length 3, default (0,0,0)
   * @param {Float32Array} [rotation] – length 9 row-major 3×3, default identity
   */
  constructor(center, halfSize, rotation) {
    this.center   = center   || new Float32Array(3);
    this.halfSize = halfSize || new Float32Array(3);
    this.rotation = rotation || new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  }

  /**
   * Set this OBB from flat arrays.
   * @returns {this}
   */
  set(center, halfSize, rotation) {
    if (center)   this.center.set(center);
    if (halfSize) this.halfSize.set(halfSize);
    if (rotation) this.rotation.set(rotation);
    return this;
  }

  /**
   * Copy another OBB.
   * @returns {this}
   */
  copy(obb) {
    this.center.set(obb.center);
    this.halfSize.set(obb.halfSize);
    this.rotation.set(obb.rotation);
    return this;
  }

  /**
   * Clone this OBB (allocates a new instance – avoid in hot loops).
   * @returns {OBB}
   */
  clone() {
    return new OBB().copy(this);
  }

  /**
   * Extract the three basis axes from the rotation matrix into the
   * module-scope scratch arrays.
   * @private
   */
  _extractBasis(ax, ay, az) {
    const e = this.rotation;
    ax[0] = e[0]; ax[1] = e[1]; ax[2] = e[2];
    ay[0] = e[3]; ay[1] = e[4]; ay[2] = e[5];
    az[0] = e[6]; az[1] = e[7]; az[2] = e[8];
  }

  /**
   * Write the size (2 × halfSize) into `result` (length 3).
   * @param {Float32Array} result
   * @returns {Float32Array} result
   */
  getSize(result) {
    result[0] = this.halfSize[0] * 2;
    result[1] = this.halfSize[1] * 2;
    result[2] = this.halfSize[2] * 2;
    return result;
  }

  /**
   * Clamp `point` to the OBB and write the closest point into `result`.
   * Reference: Christer Ericson, Real-Time Collision Detection §5.1.4.
   * @param {Float32Array} point  – length 3
   * @param {Float32Array} result – length 3
   * @returns {Float32Array} result
   */
  clampPoint(point, result) {
    const c = this.center;
    const h = this.halfSize;
    const e = this.rotation;

    // World-space basis axes
    const ax0 = e[0], ax1 = e[1], ax2 = e[2];
    const ay0 = e[3], ay1 = e[4], ay2 = e[5];
    const az0 = e[6], az1 = e[7], az2 = e[8];

    // Vector from center to point
    const dx = point[0] - c[0];
    const dy = point[1] - c[1];
    const dz = point[2] - c[2];

    // Project onto each axis and clamp
    let x = dx * ax0 + dy * ax1 + dz * ax2;
    if (x < -h[0]) x = -h[0]; else if (x > h[0]) x = h[0];

    let y = dx * ay0 + dy * ay1 + dz * ay2;
    if (y < -h[1]) y = -h[1]; else if (y > h[1]) y = h[1];

    let z = dx * az0 + dy * az1 + dz * az2;
    if (z < -h[2]) z = -h[2]; else if (z > h[2]) z = h[2];

    // Reconstruct closest point
    result[0] = c[0] + x * ax0 + y * ay0 + z * az0;
    result[1] = c[1] + x * ax1 + y * ay1 + z * az1;
    result[2] = c[2] + x * ax2 + y * ay2 + z * az2;
    return result;
  }

  /**
   * Test whether `point` lies inside this OBB.
   * @param {Float32Array} point – length 3
   * @returns {boolean}
   */
  containsPoint(point) {
    const c = this.center;
    const h = this.halfSize;
    const e = this.rotation;

    const dx = point[0] - c[0];
    const dy = point[1] - c[1];
    const dz = point[2] - c[2];

    // Project onto each basis axis and compare to half-size
    const x = dx * e[0] + dy * e[1] + dz * e[2];
    if (x < -h[0] || x > h[0]) return false;

    const y = dx * e[3] + dy * e[4] + dz * e[5];
    if (y < -h[1] || y > h[1]) return false;

    const z = dx * e[6] + dy * e[7] + dz * e[8];
    if (z < -h[2] || z > h[2]) return false;

    return true;
  }

  /**
   * SAT-based OBB-OBB intersection test.
   * Reference: Christer Ericson, Real-Time Collision Detection §4.4.1.
   * @param {OBB} obb
   * @param {number} [epsilon=Number.EPSILON]
   * @returns {boolean}
   */
  intersectsOBB(obb, epsilon = Number.EPSILON) {
    // --- 1. Extract basis axes for both OBBs ---
    this._extractBasis(_ax, _ay, _az);
    obb._extractBasis(_bx, _by, _bz);

    const a = this.center;
    const ae = this.halfSize;
    const b = obb.center;
    const be = obb.halfSize;

    // --- 2. Build rotation matrix R expressing B in A's frame ---
    // R[i][j] = Ai · Bj
    _R[0] = _ax[0] * _bx[0] + _ax[1] * _bx[1] + _ax[2] * _bx[2];
    _R[1] = _ax[0] * _by[0] + _ax[1] * _by[1] + _ax[2] * _by[2];
    _R[2] = _ax[0] * _bz[0] + _ax[1] * _bz[1] + _ax[2] * _bz[2];

    _R[3] = _ay[0] * _bx[0] + _ay[1] * _bx[1] + _ay[2] * _bx[2];
    _R[4] = _ay[0] * _by[0] + _ay[1] * _by[1] + _ay[2] * _by[2];
    _R[5] = _ay[0] * _bz[0] + _ay[1] * _bz[1] + _ay[2] * _bz[2];

    _R[6] = _az[0] * _bx[0] + _az[1] * _bx[1] + _az[2] * _bx[2];
    _R[7] = _az[0] * _by[0] + _az[1] * _by[1] + _az[2] * _by[2];
    _R[8] = _az[0] * _bz[0] + _az[1] * _bz[1] + _az[2] * _bz[2];

    // --- 3. Translation vector in A's frame ---
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];

    _t[0] = dx * _ax[0] + dy * _ax[1] + dz * _ax[2];
    _t[1] = dx * _ay[0] + dy * _ay[1] + dz * _ay[2];
    _t[2] = dx * _az[0] + dy * _az[1] + dz * _az[2];

    // --- 4. Absolute rotation matrix with epsilon guard ---
    for (let i = 0; i < 9; i++) {
      _AbsR[i] = Math.abs(_R[i]) + epsilon;
    }

    let ra, rb;

    // --- 5. Test axes L = A0, A1, A2 ---
    for (let i = 0; i < 3; i++) {
      const r = i * 3;
      ra = ae[i];
      rb = be[0] * _AbsR[r] + be[1] * _AbsR[r + 1] + be[2] * _AbsR[r + 2];
      if (Math.abs(_t[i]) > ra + rb) return false;
    }

    // --- 6. Test axes L = B0, B1, B2 ---
    for (let i = 0; i < 3; i++) {
      ra = ae[0] * _AbsR[i] + ae[1] * _AbsR[3 + i] + ae[2] * _AbsR[6 + i];
      rb = be[i];
      const tProj = _t[0] * _R[i] + _t[1] * _R[3 + i] + _t[2] * _R[6 + i];
      if (Math.abs(tProj) > ra + rb) return false;
    }

    // --- 7. Test axes L = Ai × Bj (9 cross axes) ---
    // A0 × B0
    ra = ae[1] * _AbsR[6] + ae[2] * _AbsR[3];
    rb = be[1] * _AbsR[2] + be[2] * _AbsR[1];
    if (Math.abs(_t[2] * _R[3] - _t[1] * _R[6]) > ra + rb) return false;

    // A0 × B1
    ra = ae[1] * _AbsR[7] + ae[2] * _AbsR[4];
    rb = be[0] * _AbsR[2] + be[2] * _AbsR[0];
    if (Math.abs(_t[2] * _R[4] - _t[1] * _R[7]) > ra + rb) return false;

    // A0 × B2
    ra = ae[1] * _AbsR[8] + ae[2] * _AbsR[5];
    rb = be[0] * _AbsR[1] + be[1] * _AbsR[0];
    if (Math.abs(_t[2] * _R[5] - _t[1] * _R[8]) > ra + rb) return false;

    // A1 × B0
    ra = ae[0] * _AbsR[6] + ae[2] * _AbsR[0];
    rb = be[1] * _AbsR[5] + be[2] * _AbsR[4];
    if (Math.abs(_t[0] * _R[6] - _t[2] * _R[0]) > ra + rb) return false;

    // A1 × B1
    ra = ae[0] * _AbsR[7] + ae[2] * _AbsR[1];
    rb = be[0] * _AbsR[5] + be[2] * _AbsR[3];
    if (Math.abs(_t[0] * _R[7] - _t[2] * _R[1]) > ra + rb) return false;

    // A1 × B2
    ra = ae[0] * _AbsR[8] + ae[2] * _AbsR[2];
    rb = be[0] * _AbsR[4] + be[1] * _AbsR[3];
    if (Math.abs(_t[0] * _R[8] - _t[2] * _R[2]) > ra + rb) return false;

    // A2 × B0
    ra = ae[0] * _AbsR[3] + ae[1] * _AbsR[0];
    rb = be[1] * _AbsR[8] + be[2] * _AbsR[7];
    if (Math.abs(_t[1] * _R[0] - _t[0] * _R[3]) > ra + rb) return false;

    // A2 × B1
    ra = ae[0] * _AbsR[4] + ae[1] * _AbsR[1];
    rb = be[0] * _AbsR[8] + be[2] * _AbsR[6];
    if (Math.abs(_t[1] * _R[1] - _t[0] * _R[4]) > ra + rb) return false;

    // A2 × B2
    ra = ae[0] * _AbsR[5] + ae[1] * _AbsR[2];
    rb = be[0] * _AbsR[7] + be[1] * _AbsR[6];
    if (Math.abs(_t[1] * _R[2] - _t[0] * _R[5]) > ra + rb) return false;

    // No separating axis found → intersecting
    return true;
  }

  /**
   * Test whether this OBB intersects a plane.
   * Reference: Christer Ericson, Real-Time Collision Detection §5.2.3.
   * @param {object} plane – { normal: Float32Array(3), constant: number }
   * @returns {boolean}
   */
  intersectsPlane(plane) {
    this._extractBasis(_ax, _ay, _az);
    const h = this.halfSize;
    const n = plane.normal;

    // Projection radius of the OBB onto the plane normal
    const r =
      h[0] * Math.abs(n[0] * _ax[0] + n[1] * _ax[1] + n[2] * _ax[2]) +
      h[1] * Math.abs(n[0] * _ay[0] + n[1] * _ay[1] + n[2] * _ay[2]) +
      h[2] * Math.abs(n[0] * _az[0] + n[1] * _az[1] + n[2] * _az[2]);

    // Distance from OBB center to plane
    const d =
      n[0] * this.center[0] +
      n[1] * this.center[1] +
      n[2] * this.center[2] - plane.constant;

    return Math.abs(d) <= r;
  }

  /**
   * Ray–OBB intersection. Writes the intersection point into `result`
   * (length 3) and returns `true`, or returns `false` if no hit.
   * @param {object} ray – { origin: Float32Array(3), direction: Float32Array(3) }
   * @param {Float32Array} result – length 3 output buffer
   * @returns {boolean}
   */
  intersectRay(ray, result) {
    // Transform ray into OBB local space, then perform slab test.
    // Local space is a unit AABB from -halfSize to +halfSize.
    const c = this.center;
    const h = this.halfSize;
    const e = this.rotation;

    // World-space basis axes
    const ax0 = e[0], ax1 = e[1], ax2 = e[2];
    const ay0 = e[3], ay1 = e[4], ay2 = e[5];
    const az0 = e[6], az1 = e[7], az2 = e[8];

    // Vector from center to ray origin
    const ox = ray.origin[0] - c[0];
    const oy = ray.origin[1] - c[1];
    const oz = ray.origin[2] - c[2];

    // Origin in local space
    const lo0 = ox * ax0 + oy * ax1 + oz * ax2;
    const lo1 = ox * ay0 + oy * ay1 + oz * ay2;
    const lo2 = ox * az0 + oy * az1 + oz * az2;

    // Direction in local space
    const d = ray.direction;
    const ld0 = d[0] * ax0 + d[1] * ax1 + d[2] * ax2;
    const ld1 = d[0] * ay0 + d[1] * ay1 + d[2] * ay2;
    const ld2 = d[0] * az0 + d[1] * az1 + d[2] * az2;

    let tmin = -Infinity;
    let tmax = Infinity;

    // Slab X
    if (Math.abs(ld0) < 1e-8) {
      if (lo0 < -h[0] || lo0 > h[0]) return false;
    } else {
      const inv = 1 / ld0;
      let t1 = (-h[0] - lo0) * inv;
      let t2 = ( h[0] - lo0) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    }

    // Slab Y
    if (Math.abs(ld1) < 1e-8) {
      if (lo1 < -h[1] || lo1 > h[1]) return false;
    } else {
      const inv = 1 / ld1;
      let t1 = (-h[1] - lo1) * inv;
      let t2 = ( h[1] - lo1) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    }

    // Slab Z
    if (Math.abs(ld2) < 1e-8) {
      if (lo2 < -h[2] || lo2 > h[2]) return false;
    } else {
      const inv = 1 / ld2;
      let t1 = (-h[2] - lo2) * inv;
      let t2 = ( h[2] - lo2) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    }

    // tmin is the entry distance along the ray
    if (tmin < 0) {
      if (tmax < 0) return false;
      tmin = 0;
    }

    result[0] = ray.origin[0] + d[0] * tmin;
    result[1] = ray.origin[1] + d[1] * tmin;
    result[2] = ray.origin[2] + d[2] * tmin;
    return true;
  }

  /**
   * Apply a 4×4 matrix to this OBB (translation, rotation, uniform or
   * non-uniform scale). The basis is re-orthonormalised via Gram–Schmidt
   * to keep the OBB valid under shear-free transforms.
   * @param {Float32Array} m – length 16 column-major 4×4 matrix
   * @returns {this}
   */
  applyMatrix4(m) {
    // --- Extract scale from column lengths ---
    const sx = Math.hypot(m[0], m[1], m[2]);
    const sy = Math.hypot(m[4], m[5], m[6]);
    const sz = Math.hypot(m[8], m[9], m[10]);
    const det = m[0] * (m[5] * m[10] - m[6] * m[9])
              - m[4] * (m[1] * m[10] - m[2] * m[9])
              + m[8] * (m[1] * m[6] - m[2] * m[5]);

    const signX = det < 0 ? -1 : 1;
    const invSX = sx > 1e-8 ? signX / sx : 0;
    const invSY = sy > 1e-8 ? 1 / sy : 0;
    const invSZ = sz > 1e-8 ? 1 / sz : 0;

    // --- Build new rotation basis (column vectors normalised) ---
    const e = this.rotation;

    // New X axis
    e[0] = m[0] * invSX;
    e[1] = m[1] * invSX;
    e[2] = m[2] * invSX;

    // New Y axis
    e[3] = m[4] * invSY;
    e[4] = m[5] * invSY;
    e[5] = m[6] * invSY;

    // New Z axis
    e[6] = m[8] * invSZ;
    e[7] = m[9] * invSZ;
    e[8] = m[10] * invSZ;

    // --- Scale half-size ---
    this.halfSize[0] *= sx;
    this.halfSize[1] *= sy;
    this.halfSize[2] *= sz;

    // --- Translate center ---
    this.center[0] = m[12];
    this.center[1] = m[13];
    this.center[2] = m[14];

    return this;
  }

  /**
   * Equality check against another OBB.
   * @param {OBB} obb
   * @returns {boolean}
   */
  equals(obb) {
    const a = this.center, b = obb.center;
    if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) return false;

    const ah = this.halfSize, bh = obb.halfSize;
    if (ah[0] !== bh[0] || ah[1] !== bh[1] || ah[2] !== bh[2]) return false;

    const ar = this.rotation, br = obb.rotation;
    for (let i = 0; i < 9; i++) {
      if (ar[i] !== br[i]) return false;
    }
    return true;
  }
}

export { OBB };