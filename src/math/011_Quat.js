// file number : 011
// full path name : src/math/011_Quat.js
// description : Quaternion math module (XYZW layout) built on gl-matrix v4 semantics with adaptive ARRAY_TYPE (Float32Array/Float64Array). Includes identity, setAxisAngle/getAxisAngle/getAngle, multiply, rotateX/Y/Z, calculateW, exp/ln/pow, slerp, random, invert/conjugate, fromMat3, fromEuler (intrinsic orders: xyz, xzy, yxz, yzx, zxy, zyx), rotationTo, sqlerp, setAxes, str, equality, plus vec4-borrowed clone/fromValues/copy/set/add/scale/dot/lerp/length/squaredLength/normalize, and a stack-based object pool for zero-allocation hot paths.
// best for : Skeletal animation, PBR camera orientation, physics rigid-body rotation, ECS transform state, path-following, smooth interpolation, quaternion-to-matrix conversion, and low-GC pooled quaternion work on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, EPSILON, ANGLE_ORDER } from '../core/003_Common.js';
import * as vec3 from './006_Vec3.js';
import * as vec4 from './007_Vec4.js';
import * as mat3 from './009_Mat3.js';

export function create() {
  const out = new ARRAY_TYPE(4);
  if (ARRAY_TYPE !== Float32Array) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
  }
  out[3] = 1;
  return out;
}

export function identity(out) {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  out[3] = 1;
  return out;
}

export function setAxisAngle(out, axis, rad) {
  const half = rad * 0.5;
  const s = Math.sin(half);
  out[0] = s * axis[0];
  out[1] = s * axis[1];
  out[2] = s * axis[2];
  out[3] = Math.cos(half);
  return out;
}

export function getAxisAngle(out_axis, q) {
  const rad = Math.acos(Math.min(Math.max(q[3], -1), 1)) * 2.0;
  const s = Math.sin(rad / 2.0);
  if (s > EPSILON) {
    out_axis[0] = q[0] / s;
    out_axis[1] = q[1] / s;
    out_axis[2] = q[2] / s;
  } else {
    out_axis[0] = 1;
    out_axis[1] = 0;
    out_axis[2] = 0;
  }
  return rad;
}

export function getAngle(a, b) {
  const dotproduct = vec4.dot(a, b);
  return Math.acos(Math.min(Math.max(2 * dotproduct * dotproduct - 1, -1), 1));
}

export function multiply(out, a, b) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];

  out[0] = ax * bw + aw * bx + ay * bz - az * by;
  out[1] = ay * bw + aw * by + az * bx - ax * bz;
  out[2] = az * bw + aw * bz + ax * by - ay * bx;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

export function rotateX(out, a, rad) {
  const half = rad * 0.5;
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = Math.sin(half);
  const bw = Math.cos(half);

  out[0] = ax * bw + aw * bx;
  out[1] = ay * bw + az * bx;
  out[2] = az * bw - ay * bx;
  out[3] = aw * bw - ax * bx;
  return out;
}

export function rotateY(out, a, rad) {
  const half = rad * 0.5;
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const by = Math.sin(half);
  const bw = Math.cos(half);

  out[0] = ax * bw - az * by;
  out[1] = ay * bw + aw * by;
  out[2] = az * bw + ax * by;
  out[3] = aw * bw - ay * by;
  return out;
}

export function rotateZ(out, a, rad) {
  const half = rad * 0.5;
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bz = Math.sin(half);
  const bw = Math.cos(half);

  out[0] = ax * bw + ay * bz;
  out[1] = ay * bw - ax * bz;
  out[2] = az * bw + aw * bz;
  out[3] = aw * bw - az * bz;
  return out;
}

export function calculateW(out, a) {
  const x = a[0], y = a[1], z = a[2];
  out[0] = x;
  out[1] = y;
  out[2] = z;
  out[3] = Math.sqrt(Math.abs(1.0 - x * x - y * y - z * z));
  return out;
}

export function exp(out, a) {
  const x = a[0], y = a[1], z = a[2], w = a[3];
  const r = Math.sqrt(x * x + y * y + z * z);
  const et = Math.exp(w);
  const s = r > 0 ? (et * Math.sin(r)) / r : 0;

  out[0] = x * s;
  out[1] = y * s;
  out[2] = z * s;
  out[3] = et * Math.cos(r);
  return out;
}

export function ln(out, a) {
  const x = a[0], y = a[1], z = a[2], w = a[3];
  const r = Math.sqrt(x * x + y * y + z * z);
  const t = r > 0 ? Math.atan2(r, w) / r : 0;

  out[0] = x * t;
  out[1] = y * t;
  out[2] = z * t;
  out[3] = 0.5 * Math.log(x * x + y * y + z * z + w * w);
  return out;
}

export function pow(out, a, b) {
  ln(out, a);
  vec4.scale(out, out, b);
  exp(out, out);
  return out;
}

export function slerp(out, a, b, t) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];

  let omega, cosom, sinom, scale0, scale1;

  cosom = ax * bx + ay * by + az * bz + aw * bw;
  if (cosom < 0.0) {
    cosom = -cosom;
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  if (1.0 - cosom > EPSILON) {
    omega = Math.acos(cosom);
    sinom = Math.sin(omega);
    scale0 = Math.sin((1.0 - t) * omega) / sinom;
    scale1 = Math.sin(t * omega) / sinom;
  } else {
    scale0 = 1.0 - t;
    scale1 = t;
  }
  out[0] = scale0 * ax + scale1 * bx;
  out[1] = scale0 * ay + scale1 * by;
  out[2] = scale0 * az + scale1 * bz;
  out[3] = scale0 * aw + scale1 * bw;
  return out;
}

export function random(out) {
  const u1 = Math.random();
  const u2 = Math.random();
  const u3 = Math.random();

  const sqrt1MinusU1 = Math.sqrt(1 - u1);
  const sqrtU1 = Math.sqrt(u1);

  out[0] = sqrt1MinusU1 * Math.sin(2.0 * Math.PI * u2);
  out[1] = sqrt1MinusU1 * Math.cos(2.0 * Math.PI * u2);
  out[2] = sqrtU1 * Math.sin(2.0 * Math.PI * u3);
  out[3] = sqrtU1 * Math.cos(2.0 * Math.PI * u3);
  return out;
}

export function invert(out, a) {
  const a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3];
  const dotv = a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3;
  const invDot = dotv ? 1.0 / dotv : 0;

  out[0] = -a0 * invDot;
  out[1] = -a1 * invDot;
  out[2] = -a2 * invDot;
  out[3] = a3 * invDot;
  return out;
}

export function conjugate(out, a) {
  out[0] = -a[0];
  out[1] = -a[1];
  out[2] = -a[2];
  out[3] = a[3];
  return out;
}

export function fromMat3(out, m) {
  const fTrace = m[0] + m[4] + m[8];
  let fRoot;

  if (fTrace > 0.0) {
    fRoot = Math.sqrt(fTrace + 1.0);
    out[3] = 0.5 * fRoot;
    fRoot = 0.5 / fRoot;
    out[0] = (m[5] - m[7]) * fRoot;
    out[1] = (m[6] - m[2]) * fRoot;
    out[2] = (m[1] - m[3]) * fRoot;
  } else {
    let i = 0;
    if (m[4] > m[0]) i = 1;
    if (m[8] > m[i * 3 + i]) i = 2;
    const j = (i + 1) % 3;
    const k = (i + 2) % 3;

    fRoot = Math.sqrt(m[i * 3 + i] - m[j * 3 + j] - m[k * 3 + k] + 1.0);
    out[i] = 0.5 * fRoot;
    fRoot = 0.5 / fRoot;
    out[3] = (m[j * 3 + k] - m[k * 3 + j]) * fRoot;
    out[j] = (m[j * 3 + i] + m[i * 3 + j]) * fRoot;
    out[k] = (m[k * 3 + i] + m[i * 3 + k]) * fRoot;
  }

  return out;
}

export function fromEuler(out, x, y, z, order) {
  const ord = order !== undefined ? order : ANGLE_ORDER;
  const halfToRad = Math.PI / 360;
  x *= halfToRad;
  z *= halfToRad;
  y *= halfToRad;

  const sx = Math.sin(x), cx = Math.cos(x);
  const sy = Math.sin(y), cy = Math.cos(y);
  const sz = Math.sin(z), cz = Math.cos(z);

  switch (ord) {
    case 'xyz':
      out[0] = sx * cy * cz + cx * sy * sz;
      out[1] = cx * sy * cz - sx * cy * sz;
      out[2] = cx * cy * sz + sx * sy * cz;
      out[3] = cx * cy * cz - sx * sy * sz;
      break;
    case 'xzy':
      out[0] = sx * cy * cz - cx * sy * sz;
      out[1] = cx * sy * cz - sx * cy * sz;
      out[2] = cx * cy * sz + sx * sy * cz;
      out[3] = cx * cy * cz + sx * sy * sz;
      break;
    case 'yxz':
      out[0] = sx * cy * cz + cx * sy * sz;
      out[1] = cx * sy * cz - sx * cy * sz;
      out[2] = cx * cy * sz - sx * sy * cz;
      out[3] = cx * cy * cz + sx * sy * sz;
      break;
    case 'yzx':
      out[0] = sx * cy * cz + cx * sy * sz;
      out[1] = cx * sy * cz + sx * cy * sz;
      out[2] = cx * cy * sz - sx * sy * cz;
      out[3] = cx * cy * cz - sx * sy * sz;
      break;
    case 'zxy':
      out[0] = sx * cy * cz - cx * sy * sz;
      out[1] = cx * sy * cz + sx * cy * sz;
      out[2] = cx * cy * sz + sx * sy * cz;
      out[3] = cx * cy * cz - sx * sy * sz;
      break;
    case 'zyx':
      out[0] = sx * cy * cz - cx * sy * sz;
      out[1] = cx * sy * cz + sx * cy * sz;
      out[2] = cx * cy * sz - sx * sy * cz;
      out[3] = cx * cy * cz + sx * sy * sz;
      break;
    default:
      throw new Error('Unknown angle order ' + ord);
  }

  return out;
}

export function str(a) {
  return 'quat(' + a[0] + ', ' + a[1] + ', ' + a[2] + ', ' + a[3] + ')';
}

export const clone = vec4.clone;
export const fromValues = vec4.fromValues;
export const copy = vec4.copy;
export const set = vec4.set;
export const add = vec4.add;
export const mul = multiply;
export const scale = vec4.scale;
export const dot = vec4.dot;
export const lerp = vec4.lerp;
export const length = vec4.length;
export const len = vec4.length;
export const squaredLength = vec4.squaredLength;
export const sqrLen = vec4.squaredLength;
export const normalize = vec4.normalize;
export const exactEquals = vec4.exactEquals;

export function equals(a, b) {
  return Math.abs(vec4.dot(a, b)) >= 1 - EPSILON;
}

export const rotationTo = (function () {
  const tmpvec3 = vec3.create();
  const xUnitVec3 = vec3.fromValues(1, 0, 0);
  const yUnitVec3 = vec3.fromValues(0, 1, 0);

  return function (out, a, b) {
    const d = vec3.dot(a, b);
    if (d < -0.999999) {
      vec3.cross(tmpvec3, xUnitVec3, a);
      if (vec3.len(tmpvec3) < 0.000001) vec3.cross(tmpvec3, yUnitVec3, a);
      vec3.normalize(tmpvec3, tmpvec3);
      setAxisAngle(out, tmpvec3, Math.PI);
      return out;
    } else if (d > 0.999999) {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
      out[3] = 1;
      return out;
    } else {
      vec3.cross(tmpvec3, a, b);
      out[0] = tmpvec3[0];
      out[1] = tmpvec3[1];
      out[2] = tmpvec3[2];
      out[3] = 1 + d;
      return vec4.normalize(out, out);
    }
  };
})();

export const sqlerp = (function () {
  const temp1 = create();
  const temp2 = create();

  return function (out, a, b, c, d, t) {
    slerp(temp1, a, d, t);
    slerp(temp2, b, c, t);
    slerp(out, temp1, temp2, 2 * t * (1 - t));
    return out;
  };
})();

export const setAxes = (function () {
  const matr = mat3.create();

  return function (out, view, right, up) {
    matr[0] = right[0];
    matr[3] = right[1];
    matr[6] = right[2];

    matr[1] = up[0];
    matr[4] = up[1];
    matr[7] = up[2];

    matr[2] = -view[0];
    matr[5] = -view[1];
    matr[8] = -view[2];

    return vec4.normalize(out, fromMat3(out, matr));
  };
})();

const _pool = [];
const _MAX_POOL = 256;

export function poolAcquire() {
  if (_pool.length > 0) {
    const q = _pool.pop();
    q[0] = 0;
    q[1] = 0;
    q[2] = 0;
    q[3] = 1;
    return q;
  }
  return create();
}

export function poolRelease(q) {
  if (_pool.length >= _MAX_POOL) return;
  _pool.push(q);
}

export function poolReset() {
  _pool.length = 0;
}

export function poolSize() {
  return _pool.length;
}