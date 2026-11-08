// file number : 007
// full path name : src/math/007_Vec4.js
// description : 4D vector math module built on gl-matrix v4 semantics with adaptive ARRAY_TYPE (Float32Array/Float64Array), full CRUD, arithmetic, dot, 4D cross (trivector), lerp, random (Marsaglia uniform sphere), transforms (mat4, quat), equality, zeroing, string output, forEach, and a stack-based object pool for zero-allocation hot paths.
// best for : Homogeneous coordinates, quaternion storage, RGBA colors, tangent/bitangent W components, PBR material parameters, instancing attributes, and pooled per-frame vec4 work avoiding GC on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, RANDOM, round as roundSym, EPSILON } from '../core/003_Common.js';

export function create() {
  const out = new ARRAY_TYPE(4);
  if (ARRAY_TYPE !== Float32Array) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
  }
  return out;
}

export function clone(a) {
  const out = new ARRAY_TYPE(4);
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
  out[3] = a[3];
  return out;
}

export function fromValues(x, y, z, w) {
  const out = new ARRAY_TYPE(4);
  out[0] = x;
  out[1] = y;
  out[2] = z;
  out[3] = w;
  return out;
}

export function copy(out, a) {
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
  out[3] = a[3];
  return out;
}

export function set(out, x, y, z, w) {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  out[3] = w;
  return out;
}

export function add(out, a, b) {
  out[0] = a[0] + b[0];
  out[1] = a[1] + b[1];
  out[2] = a[2] + b[2];
  out[3] = a[3] + b[3];
  return out;
}

export function subtract(out, a, b) {
  out[0] = a[0] - b[0];
  out[1] = a[1] - b[1];
  out[2] = a[2] - b[2];
  out[3] = a[3] - b[3];
  return out;
}

export function multiply(out, a, b) {
  out[0] = a[0] * b[0];
  out[1] = a[1] * b[1];
  out[2] = a[2] * b[2];
  out[3] = a[3] * b[3];
  return out;
}

export function divide(out, a, b) {
  out[0] = a[0] / b[0];
  out[1] = a[1] / b[1];
  out[2] = a[2] / b[2];
  out[3] = a[3] / b[3];
  return out;
}

export function ceil(out, a) {
  out[0] = Math.ceil(a[0]);
  out[1] = Math.ceil(a[1]);
  out[2] = Math.ceil(a[2]);
  out[3] = Math.ceil(a[3]);
  return out;
}

export function floor(out, a) {
  out[0] = Math.floor(a[0]);
  out[1] = Math.floor(a[1]);
  out[2] = Math.floor(a[2]);
  out[3] = Math.floor(a[3]);
  return out;
}

export function min(out, a, b) {
  out[0] = Math.min(a[0], b[0]);
  out[1] = Math.min(a[1], b[1]);
  out[2] = Math.min(a[2], b[2]);
  out[3] = Math.min(a[3], b[3]);
  return out;
}

export function max(out, a, b) {
  out[0] = Math.max(a[0], b[0]);
  out[1] = Math.max(a[1], b[1]);
  out[2] = Math.max(a[2], b[2]);
  out[3] = Math.max(a[3], b[3]);
  return out;
}

export function round(out, a) {
  out[0] = roundSym(a[0]);
  out[1] = roundSym(a[1]);
  out[2] = roundSym(a[2]);
  out[3] = roundSym(a[3]);
  return out;
}

export function scale(out, a, b) {
  out[0] = a[0] * b;
  out[1] = a[1] * b;
  out[2] = a[2] * b;
  out[3] = a[3] * b;
  return out;
}

export function scaleAndAdd(out, a, b, s) {
  out[0] = a[0] + b[0] * s;
  out[1] = a[1] + b[1] * s;
  out[2] = a[2] + b[2] * s;
  out[3] = a[3] + b[3] * s;
  return out;
}

export function distance(a, b) {
  const x = b[0] - a[0];
  const y = b[1] - a[1];
  const z = b[2] - a[2];
  const w = b[3] - a[3];
  return Math.sqrt(x * x + y * y + z * z + w * w);
}

export function squaredDistance(a, b) {
  const x = b[0] - a[0];
  const y = b[1] - a[1];
  const z = b[2] - a[2];
  const w = b[3] - a[3];
  return x * x + y * y + z * z + w * w;
}

export function length(a) {
  const x = a[0];
  const y = a[1];
  const z = a[2];
  const w = a[3];
  return Math.sqrt(x * x + y * y + z * z + w * w);
}

export function squaredLength(a) {
  const x = a[0];
  const y = a[1];
  const z = a[2];
  const w = a[3];
  return x * x + y * y + z * z + w * w;
}

export function negate(out, a) {
  out[0] = -a[0];
  out[1] = -a[1];
  out[2] = -a[2];
  out[3] = -a[3];
  return out;
}

export function inverse(out, a) {
  out[0] = 1.0 / a[0];
  out[1] = 1.0 / a[1];
  out[2] = 1.0 / a[2];
  out[3] = 1.0 / a[3];
  return out;
}

export function normalize(out, a) {
  const x = a[0];
  const y = a[1];
  const z = a[2];
  const w = a[3];
  let l = x * x + y * y + z * z + w * w;
  if (l > 0) {
    l = 1 / Math.sqrt(l);
  }
  out[0] = x * l;
  out[1] = y * l;
  out[2] = z * l;
  out[3] = w * l;
  return out;
}

export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

export function cross(out, u, v, w) {
  const A = v[0] * w[1] - v[1] * w[0];
  const B = v[0] * w[2] - v[2] * w[0];
  const C = v[0] * w[3] - v[3] * w[0];
  const D = v[1] * w[2] - v[2] * w[1];
  const E = v[1] * w[3] - v[3] * w[1];
  const F = v[2] * w[3] - v[3] * w[2];
  const G = u[0];
  const H = u[1];
  const I = u[2];
  const J = u[3];

  out[0] = H * F - I * E + J * D;
  out[1] = -(G * F) + I * C - J * B;
  out[2] = G * E - H * C + J * A;
  out[3] = -(G * D) + H * B - I * A;

  return out;
}

export function lerp(out, a, b, t) {
  const ax = a[0];
  const ay = a[1];
  const az = a[2];
  const aw = a[3];
  out[0] = ax + t * (b[0] - ax);
  out[1] = ay + t * (b[1] - ay);
  out[2] = az + t * (b[2] - az);
  out[3] = aw + t * (b[3] - aw);
  return out;
}

export function random(out, s) {
  const sc = s === undefined ? 1.0 : s;

  let v1, v2, v3, v4;
  let s1, s2;
  let r;

  r = RANDOM();
  v1 = r * 2 - 1;
  v2 = (4 * RANDOM() - 2) * Math.sqrt(r * -r + r);
  s1 = v1 * v1 + v2 * v2;

  r = RANDOM();
  v3 = r * 2 - 1;
  v4 = (4 * RANDOM() - 2) * Math.sqrt(r * -r + r);
  s2 = v3 * v3 + v4 * v4;

  const d = Math.sqrt((1 - s1) / s2);
  out[0] = sc * v1;
  out[1] = sc * v2;
  out[2] = sc * v3 * d;
  out[3] = sc * v4 * d;
  return out;
}

export function transformMat4(out, a, m) {
  const x = a[0];
  const y = a[1];
  const z = a[2];
  const w = a[3];
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
  out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
  return out;
}

export function transformQuat(out, a, q) {
  const qx = q[0];
  const qy = q[1];
  const qz = q[2];
  const qw = q[3];

  const vx = a[0];
  const vy = a[1];
  const vz = a[2];

  let tx = qy * vz - qz * vy;
  let ty = qz * vx - qx * vz;
  let tz = qx * vy - qy * vx;

  tx = tx + tx;
  ty = ty + ty;
  tz = tz + tz;

  out[0] = vx + qw * tx + qy * tz - qz * ty;
  out[1] = vy + qw * ty + qz * tx - qx * tz;
  out[2] = vz + qw * tz + qx * ty - qy * tx;
  out[3] = a[3];
  return out;
}

export function zero(out) {
  out[0] = 0.0;
  out[1] = 0.0;
  out[2] = 0.0;
  out[3] = 0.0;
  return out;
}

export function str(a) {
  return 'vec4(' + a[0] + ', ' + a[1] + ', ' + a[2] + ', ' + a[3] + ')';
}

export function exactEquals(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

export function equals(a, b) {
  const a0 = a[0];
  const a1 = a[1];
  const a2 = a[2];
  const a3 = a[3];
  const b0 = b[0];
  const b1 = b[1];
  const b2 = b[2];
  const b3 = b[3];
  return (
    (a0 === b0 ||
      Math.abs(a0 - b0) <=
        EPSILON *
          Math.min(Number.MAX_VALUE, Math.max(1.0, Math.abs(a0), Math.abs(b0)))) &&
    (a1 === b1 ||
      Math.abs(a1 - b1) <=
        EPSILON *
          Math.min(Number.MAX_VALUE, Math.max(1.0, Math.abs(a1), Math.abs(b1)))) &&
    (a2 === b2 ||
      Math.abs(a2 - b2) <=
        EPSILON *
          Math.min(Number.MAX_VALUE, Math.max(1.0, Math.abs(a2), Math.abs(b2)))) &&
    (a3 === b3 ||
      Math.abs(a3 - b3) <=
        EPSILON *
          Math.min(Number.MAX_VALUE, Math.max(1.0, Math.abs(a3), Math.abs(b3))))
  );
}

export const sub = subtract;
export const mul = multiply;
export const div = divide;
export const dist = distance;
export const sqrDist = squaredDistance;
export const len = length;
export const sqrLen = squaredLength;

export const forEach = (function () {
  const vec = create();
  return function (a, stride, offset, count, fn, arg) {
    let i, l;
    if (!stride) {
      stride = 4;
    }
    if (!offset) {
      offset = 0;
    }
    if (count) {
      l = Math.min(count * stride + offset, a.length);
    } else {
      l = a.length;
    }
    for (i = offset; i < l; i += stride) {
      vec[0] = a[i];
      vec[1] = a[i + 1];
      vec[2] = a[i + 2];
      vec[3] = a[i + 3];
      fn(vec, vec, arg);
      a[i] = vec[0];
      a[i + 1] = vec[1];
      a[i + 2] = vec[2];
      a[i + 3] = vec[3];
    }
    return a;
  };
})();

const _pool = [];
const _MAX_POOL = 512;

export function poolAcquire() {
  if (_pool.length > 0) {
    const v = _pool.pop();
    v[0] = 0;
    v[1] = 0;
    v[2] = 0;
    v[3] = 0;
    return v;
  }
  return create();
}

export function poolRelease(v) {
  if (_pool.length >= _MAX_POOL) return;
  _pool.push(v);
}

export function poolReset() {
  _pool.length = 0;
}

export function poolSize() {
  return _pool.length;
}