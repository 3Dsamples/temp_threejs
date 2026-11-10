// file number : 012
// full path name : src/math/012_Quat2.js
// description : Dual quaternion math module (format: [real(4) XYZW, dual(4) XYZW]) built on gl-matrix v4 semantics with adaptive ARRAY_TYPE (Float32Array/Float64Array). Includes create/clone/fromValues, fromRotationTranslation/fromTranslation/fromRotation/fromMat4, getReal/getDual/setReal/setDual/getTranslation, copy/identity/set, translate, rotateX/Y/Z/rotateByQuatAppend/rotateByQuatPrepend/rotateAroundAxis, add/multiply/scale, dot/lerp, invert/conjugate, length/squaredLength/normalize, str, exactEquals/equals, and a stack-based object pool for zero-allocation hot paths.
// best for : Rigid-body transforms combining rotation + translation in a single 8-element structure, skeletal animation (screw motion interpolation), kinematic physics, camera rigs, path-following with orientation, seamless scale transitions in floating-origin pipelines, and low-GC pooled dual-quaternion work on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, EPSILON } from '../core/003_Common.js';
import * as quat from './011_Quat.js';
import * as mat4 from './010_Mat4.js';

export function create() {
  const dq = new ARRAY_TYPE(8);
  if (ARRAY_TYPE !== Float32Array) {
    dq[0] = 0;
    dq[1] = 0;
    dq[2] = 0;
    dq[4] = 0;
    dq[5] = 0;
    dq[6] = 0;
    dq[7] = 0;
  }
  dq[3] = 1;
  return dq;
}

export function clone(a) {
  const dq = new ARRAY_TYPE(8);
  dq[0] = a[0];
  dq[1] = a[1];
  dq[2] = a[2];
  dq[3] = a[3];
  dq[4] = a[4];
  dq[5] = a[5];
  dq[6] = a[6];
  dq[7] = a[7];
  return dq;
}

export function fromValues(x1, y1, z1, w1, x2, y2, z2, w2) {
  const dq = new ARRAY_TYPE(8);
  dq[0] = x1;
  dq[1] = y1;
  dq[2] = z1;
  dq[3] = w1;
  dq[4] = x2;
  dq[5] = y2;
  dq[6] = z2;
  dq[7] = w2;
  return dq;
}

export function fromRotationTranslationValues(x1, y1, z1, w1, x2, y2, z2) {
  const dq = new ARRAY_TYPE(8);
  dq[0] = x1;
  dq[1] = y1;
  dq[2] = z1;
  dq[3] = w1;
  const ax = x2 * 0.5;
  const ay = y2 * 0.5;
  const az = z2 * 0.5;
  dq[4] = ax * w1 + ay * z1 - az * y1;
  dq[5] = ay * w1 + az * x1 - ax * z1;
  dq[6] = az * w1 + ax * y1 - ay * x1;
  dq[7] = -ax * x1 - ay * y1 - az * z1;
  return dq;
}

export function fromRotationTranslation(out, q, t) {
  const ax = t[0] * 0.5;
  const ay = t[1] * 0.5;
  const az = t[2] * 0.5;
  const bx = q[0];
  const by = q[1];
  const bz = q[2];
  const bw = q[3];
  out[0] = bx;
  out[1] = by;
  out[2] = bz;
  out[3] = bw;
  out[4] = ax * bw + ay * bz - az * by;
  out[5] = ay * bw + az * bx - ax * bz;
  out[6] = az * bw + ax * by - ay * bx;
  out[7] = -ax * bx - ay * by - az * bz;
  return out;
}

export function fromTranslation(out, t) {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  out[3] = 1;
  out[4] = t[0] * 0.5;
  out[5] = t[1] * 0.5;
  out[6] = t[2] * 0.5;
  out[7] = 0;
  return out;
}

export function fromRotation(out, q) {
  out[0] = q[0];
  out[1] = q[1];
  out[2] = q[2];
  out[3] = q[3];
  out[4] = 0;
  out[5] = 0;
  out[6] = 0;
  out[7] = 0;
  return out;
}

export function fromMat4(out, a) {
  const outer = quat.create();
  mat4.getRotation(outer, a);
  const t = new ARRAY_TYPE(3);
  mat4.getTranslation(t, a);
  fromRotationTranslation(out, outer, t);
  return out;
}

export function copy(out, a) {
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
  out[3] = a[3];
  out[4] = a[4];
  out[5] = a[5];
  out[6] = a[6];
  out[7] = a[7];
  return out;
}

export function identity(out) {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  out[3] = 1;
  out[4] = 0;
  out[5] = 0;
  out[6] = 0;
  out[7] = 0;
  return out;
}

export function set(out, x1, y1, z1, w1, x2, y2, z2, w2) {
  out[0] = x1;
  out[1] = y1;
  out[2] = z1;
  out[3] = w1;
  out[4] = x2;
  out[5] = y2;
  out[6] = z2;
  out[7] = w2;
  return out;
}

export const getReal = quat.copy;

export function getDual(out, a) {
  out[0] = a[4];
  out[1] = a[5];
  out[2] = a[6];
  out[3] = a[7];
  return out;
}

export const setReal = quat.copy;

export function setDual(out, q) {
  out[4] = q[0];
  out[5] = q[1];
  out[6] = q[2];
  out[7] = q[3];
  return out;
}

export function getTranslation(out, a) {
  const ax = a[4];
  const ay = a[5];
  const az = a[6];
  const aw = a[7];
  const bx = -a[0];
  const by = -a[1];
  const bz = -a[2];
  const bw = a[3];
  out[0] = (ax * bw + aw * bx + ay * bz - az * by) * 2;
  out[1] = (ay * bw + aw * by + az * bx - ax * bz) * 2;
  out[2] = (az * bw + aw * bz + ax * by - ay * bx) * 2;
  return out;
}

export function translate(out, a, v) {
  const ax1 = a[0];
  const ay1 = a[1];
  const az1 = a[2];
  const aw1 = a[3];
  const bx1 = v[0] * 0.5;
  const by1 = v[1] * 0.5;
  const bz1 = v[2] * 0.5;
  const ax2 = a[4];
  const ay2 = a[5];
  const az2 = a[6];
  const aw2 = a[7];
  out[0] = ax1;
  out[1] = ay1;
  out[2] = az1;
  out[3] = aw1;
  out[4] = aw1 * bx1 + ay1 * bz1 - az1 * by1 + ax2;
  out[5] = aw1 * by1 + az1 * bx1 - ax1 * bz1 + ay2;
  out[6] = aw1 * bz1 + ax1 * by1 - ay1 * bx1 + az2;
  out[7] = -ax1 * bx1 - ay1 * by1 - az1 * bz1 + aw2;
  return out;
}

export function rotateX(out, a, rad) {
  let bx = -a[0];
  let by = -a[1];
  let bz = -a[2];
  let bw = a[3];
  const ax = a[4];
  const ay = a[5];
  const az = a[6];
  const aw = a[7];
  const ax1 = ax * bw + aw * bx + ay * bz - az * by;
  const ay1 = ay * bw + aw * by + az * bx - ax * bz;
  const az1 = az * bw + aw * bz + ax * by - ay * bx;
  const aw1 = aw * bw - ax * bx - ay * by - az * bz;
  quat.rotateX(out, a, rad);
  bx = out[0];
  by = out[1];
  bz = out[2];
  bw = out[3];
  out[4] = ax1 * bw + aw1 * bx + ay1 * bz - az1 * by;
  out[5] = ay1 * bw + aw1 * by + az1 * bx - ax1 * bz;
  out[6] = az1 * bw + aw1 * bz + ax1 * by - ay1 * bx;
  out[7] = aw1 * bw - ax1 * bx - ay1 * by - az1 * bz;
  return out;
}

export function rotateY(out, a, rad) {
  let bx = -a[0];
  let by = -a[1];
  let bz = -a[2];
  let bw = a[3];
  const ax = a[4];
  const ay = a[5];
  const az = a[6];
  const aw = a[7];
  const ax1 = ax * bw + aw * bx + ay * bz - az * by;
  const ay1 = ay * bw + aw * by + az * bx - ax * bz;
  const az1 = az * bw + aw * bz + ax * by - ay * bx;
  const aw1 = aw * bw - ax * bx - ay * by - az * bz;
  quat.rotateY(out, a, rad);
  bx = out[0];
  by = out[1];
  bz = out[2];
  bw = out[3];
  out[4] = ax1 * bw + aw1 * bx + ay1 * bz - az1 * by;
  out[5] = ay1 * bw + aw1 * by + az1 * bx - ax1 * bz;
  out[6] = az1 * bw + aw1 * bz + ax1 * by - ay1 * bx;
  out[7] = aw1 * bw - ax1 * bx - ay1 * by - az1 * bz;
  return out;
}

export function rotateZ(out, a, rad) {
  let bx = -a[0];
  let by = -a[1];
  let bz = -a[2];
  let bw = a[3];
  const ax = a[4];
  const ay = a[5];
  const az = a[6];
  const aw = a[7];
  const ax1 = ax * bw + aw * bx + ay * bz - az * by;
  const ay1 = ay * bw + aw * by + az * bx - ax * bz;
  const az1 = az * bw + aw * bz + ax * by - ay * bx;
  const aw1 = aw * bw - ax * bx - ay * by - az * bz;
  quat.rotateZ(out, a, rad);
  bx = out[0];
  by = out[1];
  bz = out[2];
  bw = out[3];
  out[4] = ax1 * bw + aw1 * bx + ay1 * bz - az1 * by;
  out[5] = ay1 * bw + aw1 * by + az1 * bx - ax1 * bz;
  out[6] = az1 * bw + aw1 * bz + ax1 * by - ay1 * bx;
  out[7] = aw1 * bw - ax1 * bx - ay1 * by - az1 * bz;
  return out;
}

export function rotateByQuatAppend(out, a, q) {
  const qx = q[0];
  const qy = q[1];
  const qz = q[2];
  const qw = q[3];
  let ax = a[0];
  let ay = a[1];
  let az = a[2];
  let aw = a[3];

  out[0] = ax * qw + aw * qx + ay * qz - az * qy;
  out[1] = ay * qw + aw * qy + az * qx - ax * qz;
  out[2] = az * qw + aw * qz + ax * qy - ay * qx;
  out[3] = aw * qw - ax * qx - ay * qy - az * qz;
  ax = a[4];
  ay = a[5];
  az = a[6];
  aw = a[7];
  out[4] = ax * qw + aw * qx + ay * qz - az * qy;
  out[5] = ay * qw + aw * qy + az * qx - ax * qz;
  out[6] = az * qw + aw * qz + ax * qy - ay * qx;
  out[7] = aw * qw - ax * qx - ay * qy - az * qz;
  return out;
}

export function rotateByQuatPrepend(out, q, a) {
  const qx = q[0];
  const qy = q[1];
  const qz = q[2];
  const qw = q[3];
  let bx = a[0];
  let by = a[1];
  let bz = a[2];
  let bw = a[3];

  out[0] = qx * bw + qw * bx + qy * bz - qz * by;
  out[1] = qy * bw + qw * by + qz * bx - qx * bz;
  out[2] = qz * bw + qw * bz + qx * by - qy * bx;
  out[3] = qw * bw - qx * bx - qy * by - qz * bz;
  bx = a[4];
  by = a[5];
  bz = a[6];
  bw = a[7];
  out[4] = qx * bw + qw * bx + qy * bz - qz * by;
  out[5] = qy * bw + qw * by + qz * bx - qx * bz;
  out[6] = qz * bw + qw * bz + qx * by - qy * bx;
  out[7] = qw * bw - qx * bx - qy * by - qz * bz;
  return out;
}

export function rotateAroundAxis(out, a, axis, rad) {
  if (Math.abs(rad) < EPSILON) {
    return copy(out, a);
  }
  const axisLength = Math.sqrt(
    axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]
  );

  rad = rad * 0.5;
  const s = Math.sin(rad);
  const bx = (s * axis[0]) / axisLength;
  const by = (s * axis[1]) / axisLength;
  const bz = (s * axis[2]) / axisLength;
  const bw = Math.cos(rad);

  const ax1 = a[0];
  const ay1 = a[1];
  const az1 = a[2];
  const aw1 = a[3];
  out[0] = ax1 * bw + aw1 * bx + ay1 * bz - az1 * by;
  out[1] = ay1 * bw + aw1 * by + az1 * bx - ax1 * bz;
  out[2] = az1 * bw + aw1 * bz + ax1 * by - ay1 * bx;
  out[3] = aw1 * bw - ax1 * bx - ay1 * by - az1 * bz;

  const ax = a[4];
  const ay = a[5];
  const az = a[6];
  const aw = a[7];
  out[4] = ax * bw + aw * bx + ay * bz - az * by;
  out[5] = ay * bw + aw * by + az * bx - ax * bz;
  out[6] = az * bw + aw * bz + ax * by - ay * bx;
  out[7] = aw * bw - ax * bx - ay * by - az * bz;

  return out;
}

export function add(out, a, b) {
  out[0] = a[0] + b[0];
  out[1] = a[1] + b[1];
  out[2] = a[2] + b[2];
  out[3] = a[3] + b[3];
  out[4] = a[4] + b[4];
  out[5] = a[5] + b[5];
  out[6] = a[6] + b[6];
  out[7] = a[7] + b[7];
  return out;
}

export function multiply(out, a, b) {
  const ax0 = a[0];
  const ay0 = a[1];
  const az0 = a[2];
  const aw0 = a[3];
  const bx1 = b[4];
  const by1 = b[5];
  const bz1 = b[6];
  const bw1 = b[7];
  const ax1 = a[4];
  const ay1 = a[5];
  const az1 = a[6];
  const aw1 = a[7];
  const bx0 = b[0];
  const by0 = b[1];
  const bz0 = b[2];
  const bw0 = b[3];
  out[0] = ax0 * bw0 + aw0 * bx0 + ay0 * bz0 - az0 * by0;
  out[1] = ay0 * bw0 + aw0 * by0 + az0 * bx0 - ax0 * bz0;
  out[2] = az0 * bw0 + aw0 * bz0 + ax0 * by0 - ay0 * bx0;
  out[3] = aw0 * bw0 - ax0 * bx0 - ay0 * by0 - az0 * bz0;
  out[4] =
    ax0 * bw1 +
    aw0 * bx1 +
    ay0 * bz1 -
    az0 * by1 +
    ax1 * bw0 +
    aw1 * bx0 +
    ay1 * bz0 -
    az1 * by0;
  out[5] =
    ay0 * bw1 +
    aw0 * by1 +
    az0 * bx1 -
    ax0 * bz1 +
    ay1 * bw0 +
    aw1 * by0 +
    az1 * bx0 -
    ax1 * bz0;
  out[6] =
    az0 * bw1 +
    aw0 * bz1 +
    ax0 * by1 -
    ay0 * bx1 +
    az1 * bw0 +
    aw1 * bz0 +
    ax1 * by0 -
    ay1 * bx0;
  out[7] =
    aw0 * bw1 -
    ax0 * bx1 -
    ay0 * by1 -
    az0 * bz1 +
    aw1 * bw0 -
    ax1 * bx0 -
    ay1 * by0 -
    az1 * bz0;
  return out;
}

export const mul = multiply;

export function scale(out, a, b) {
  out[0] = a[0] * b;
  out[1] = a[1] * b;
  out[2] = a[2] * b;
  out[3] = a[3] * b;
  out[4] = a[4] * b;
  out[5] = a[5] * b;
  out[6] = a[6] * b;
  out[7] = a[7] * b;
  return out;
}

export const dot = quat.dot;

export function lerp(out, a, b, t) {
  const mt = 1 - t;
  if (dot(a, b) < 0) t = -t;

  out[0] = a[0] * mt + b[0] * t;
  out[1] = a[1] * mt + b[1] * t;
  out[2] = a[2] * mt + b[2] * t;
  out[3] = a[3] * mt + b[3] * t;
  out[4] = a[4] * mt + b[4] * t;
  out[5] = a[5] * mt + b[5] * t;
  out[6] = a[6] * mt + b[6] * t;
  out[7] = a[7] * mt + b[7] * t;
  return out;
}

export function invert(out, a) {
  const sqlen = squaredLength(a);
  out[0] = -a[0] / sqlen;
  out[1] = -a[1] / sqlen;
  out[2] = -a[2] / sqlen;
  out[3] = a[3] / sqlen;
  out[4] = -a[4] / sqlen;
  out[5] = -a[5] / sqlen;
  out[6] = -a[6] / sqlen;
  out[7] = a[7] / sqlen;
  return out;
}

export function conjugate(out, a) {
  out[0] = -a[0];
  out[1] = -a[1];
  out[2] = -a[2];
  out[3] = a[3];
  out[4] = -a[4];
  out[5] = -a[5];
  out[6] = -a[6];
  out[7] = a[7];
  return out;
}

export function length(a) {
  return quat.length(a);
}

export const len = length;

export function squaredLength(a) {
  return quat.squaredLength(a);
}

export const sqrLen = squaredLength;

export function normalize(out, a) {
  let magnitude = squaredLength(a);
  if (magnitude > 0) {
    magnitude = Math.sqrt(magnitude);

    const a0 = a[0] / magnitude;
    const a1 = a[1] / magnitude;
    const a2 = a[2] / magnitude;
    const a3 = a[3] / magnitude;

    const b0 = a[4];
    const b1 = a[5];
    const b2 = a[6];
    const b3 = a[7];

    const a_dot_b = a0 * b0 + a1 * b1 + a2 * b2 + a3 * b3;

    out[0] = a0;
    out[1] = a1;
    out[2] = a2;
    out[3] = a3;

    out[4] = (b0 - a0 * a_dot_b) / magnitude;
    out[5] = (b1 - a1 * a_dot_b) / magnitude;
    out[6] = (b2 - a2 * a_dot_b) / magnitude;
    out[7] = (b3 - a3 * a_dot_b) / magnitude;
  } else {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = 0;
    out[6] = 0;
    out[7] = 0;
  }
  return out;
}

export function str(a) {
  return (
    'quat2(' +
    a[0] + ', ' + a[1] + ', ' + a[2] + ', ' + a[3] + ', ' +
    a[4] + ', ' + a[5] + ', ' + a[6] + ', ' + a[7] +
    ')'
  );
}

export function exactEquals(a, b) {
  return (
    a[0] === b[0] &&
    a[1] === b[1] &&
    a[2] === b[2] &&
    a[3] === b[3] &&
    a[4] === b[4] &&
    a[5] === b[5] &&
    a[6] === b[6] &&
    a[7] === b[7]
  );
}

export function equals(a, b) {
  const a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3];
  const a4 = a[4], a5 = a[5], a6 = a[6], a7 = a[7];
  const b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
  const b4 = b[4], b5 = b[5], b6 = b[6], b7 = b[7];
  return (
    Math.abs(a0 - b0) <= EPSILON * Math.max(1.0, Math.abs(a0), Math.abs(b0)) &&
    Math.abs(a1 - b1) <= EPSILON * Math.max(1.0, Math.abs(a1), Math.abs(b1)) &&
    Math.abs(a2 - b2) <= EPSILON * Math.max(1.0, Math.abs(a2), Math.abs(b2)) &&
    Math.abs(a3 - b3) <= EPSILON * Math.max(1.0, Math.abs(a3), Math.abs(b3)) &&
    Math.abs(a4 - b4) <= EPSILON * Math.max(1.0, Math.abs(a4), Math.abs(b4)) &&
    Math.abs(a5 - b5) <= EPSILON * Math.max(1.0, Math.abs(a5), Math.abs(b5)) &&
    Math.abs(a6 - b6) <= EPSILON * Math.max(1.0, Math.abs(a6), Math.abs(b6)) &&
    Math.abs(a7 - b7) <= EPSILON * Math.max(1.0, Math.abs(a7), Math.abs(b7))
  );
}

const _pool = [];
const _MAX_POOL = 128;

export function poolAcquire() {
  if (_pool.length > 0) {
    const dq = _pool.pop();
    dq[0] = 0;
    dq[1] = 0;
    dq[2] = 0;
    dq[3] = 1;
    dq[4] = 0;
    dq[5] = 0;
    dq[6] = 0;
    dq[7] = 0;
    return dq;
  }
  return create();
}

export function poolRelease(dq) {
  if (_pool.length >= _MAX_POOL) return;
  _pool.push(dq);
}

export function poolReset() {
  _pool.length = 0;
}

export function poolSize() {
  return _pool.length;
}