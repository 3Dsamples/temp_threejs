// file number : 006
// full path name : src/math/006_Vec3.js
// description : 3D vector math module built on gl-matrix v4 semantics with adaptive ARRAY_TYPE (Float32Array/Float64Array), full CRUD, arithmetic, cross/dot, lerp/slerp, hermite/bezier, random, rotations (X/Y/Z), transforms (mat3/mat4/quat), angle, equality, zeroing, string output, forEach, and a stack-based object pool for zero-allocation hot paths.
// best for : Core 3D math for transforms, physics, camera, lighting, PBR normals/tangents/bitangents, ECS component data, chunked world positions, and pooled per-frame vector work avoiding GC on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, RANDOM, round as roundSym, EPSILON } from '../core/003_Common.js';

export function create() {
  const out = new ARRAY_TYPE(3);
  if (ARRAY_TYPE !== Float32Array) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
  }
  return out;
}

export function clone(a) {
  const out = new ARRAY_TYPE(3);
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
  return out;
}

export function length(a) {
  const x = a[0];
  const y = a[1];
  const z = a[2];
  return Math.sqrt(x * x + y * y + z * z);
}

export function fromValues(x, y, z) {
  const out = new ARRAY_TYPE(3);
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export function copy(out, a) {
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
  return out;
}

export function set(out, x, y, z) {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export function add(out, a, b) {
  out[0] = a[0] + b[0];
  out[1] = a[1] + b[1];
  out[2] = a[2] + b[2];
  return out;
}

export function subtract(out, a, b) {
  out[0] = a[0] - b[0];
  out[1] = a[1] - b[1];
  out[2] = a[2] - b[2];
  return out;
}

export function multiply(out, a, b) {
  out[0] = a[0] * b[0];
  out[1] = a[1] * b[1];
  out[2] = a[2] * b[2];
  return out;
}

export function divide(out, a, b) {
  out[0] = a[0] / b[0];
  out[1] = a[1] / b[1];
  out[2] = a[2] / b[2];
  return out;
}

export function ceil(out, a) {
  out[0] = Math.ceil(a[0]);
  out[1] = Math.ceil(a[1]);
  out[2] = Math.ceil(a[2]);
  return out;
}

export function floor(out, a) {
  out[0] = Math.floor(a[0]);
  out[1] = Math.floor(a[1]);
  out[2] = Math.floor(a[2]);
  return out;
}

export function min(out, a, b) {
  out[0] = Math.min(a[0], b[0]);
  out[1] = Math.min(a[1], b[1]);
  out[2] = Math.min(a[2], b[2]);
  return out;
}

export function max(out, a, b) {
  out[0] = Math.max(a[0], b[0]);
  out[1] = Math.max(a[1], b[1]);
  out[2] = Math.max(a[2], b[2]);
  return out;
}

export function round(out, a) {
  out[0] = roundSym(a[0]);
  out[1] = roundSym(a[1]);
  out[2] = roundSym(a[2]);
  return out;
}

export function scale(out, a, b) {
  out[0] = a[0] * b;
  out[1] = a[1] * b;
  out[2] = a[2] * b;
  return out;
}

export function scaleAndAdd(out, a, b, s) {
  out[0] = a[0] + b[0] * s;
  out[1] = a[1] + b[1] * s;
  out[2] = a[2] + b[2] * s;
  return out;
}

export function distance(a, b) {
  const x = b[0] - a[0];
  const y = b[1] - a[1];
  const z = b[2] - a[2];
  return Math.sqrt(x * x + y * y + z * z);
}

export function squaredDistance(a, b) {
  const x = b[0] - a[0];
  const y = b[1] - a[1];
  const z = b[2] - a[2];
  return x * x + y * y + z * z;
}

export function squaredLength(a) {
  const x = a[0];
  const y = a[1];
  const z = a[2];
  return x * x + y * y + z * z;
}

export function negate(out, a) {
  out[0] = -a[0];
  out[1] = -a[1];
  out[2] = -a[2];
  return out;
}

export function inverse(out, a) {
  out[0] = 1.0 / a[0];
  out[1] = 1.0 / a[1];
  out[2] = 1.0 / a[2];
  return out;
}

export function normalize(out, a) {
  const x = a[0];
  const y = a[1];
  const z = a[2];
  let l = x * x + y * y + z * z;
  if (l > 0) {
    l = 1 / Math.sqrt(l);
  }
  out[0] = a[0] * l;
  out[1] = a[1] * l;
  out[2] = a[2] * l;
  return out;
}

export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(out, a, b) {
  const ax = a[0];
  const ay = a[1];
  const az = a[2];
  const bx = b[0];
  const by = b[1];
  const bz = b[2];
  out[0] = ay * bz - az * by;
  out[1] = az * bx - ax * bz;
  out[2] = ax * by - ay * bx;
  return out;
}

export function lerp(out, a, b, t) {
  const ax = a[0];
  const ay = a[1];
  const az = a[2];
  out[0] = ax + t * (b[0] - ax);
  out[1] = ay + t * (b[1] - ay);
  out[2] = az + t * (b[2] - az);
  return out;
}

export function slerp(out, a, b, t) {
  const ang = Math.acos(Math.min(Math.max(dot(a, b), -1), 1));
  const sinTotal = Math.sin(ang);
  const ratioA =
    sinTotal > EPSILON ? Math.sin((1 - t) * ang) / sinTotal : 1 - t;
  const ratioB = sinTotal > EPSILON ? Math.sin(t * ang) / sinTotal : t;
  out[0] = ratioA * a[0] + ratioB * b[0];
  out[1] = ratioA * a[1] + ratioB * b[1];
  out[2] = ratioA * a[2] + ratioB * b[2];
  return out;
}

export function hermite(out, a, b, c, d, t) {
  const t2 = t * t;
  const f1 = t2 * (2 * t - 3) + 1;
  const f2 = t2 * (t - 2) + t;
  const f3 = t2 * (t - 1);
  const f4 = t2 * (3 - 2 * t);
  out[0] = a[0] * f1 + b[0] * f2 + c[0] * f3 + d[0] * f4;
  out[1] = a[1] * f1 + b[1] * f2 + c[1] * f3 + d[1] * f4;
  out[2] = a[2] * f1 + b[2] * f2 + c[2] * f3 + d[2] * f4;
  return out;
}

export function bezier(out, a, b, c, d, t) {
  const inv = 1 - t;
  const inv2 = inv * inv;
  const t2 = t * t;
  const f1 = inv2 * inv;
  const f2 = 3 * t * inv2;
  const f3 = 3 * t2 * inv;
  const f4 = t2 * t;
  out[0] = a[0] * f1 + b[0] * f2 + c[0] * f3 + d[0] * f4;
  out[1] = a[1] * f1 + b[1] * f2 + c[1] * f3 + d[1] * f4;
  out[2] = a[2] * f1 + b[2] * f2 + c[2] * f3 + d[2] * f4;
  return out;
}

export function random(out, s) {
  const sc = s === undefined ? 1.0 : s;
  const r = RANDOM() * 2.0 * Math.PI;
  const z = RANDOM() * 2.0 - 1.0;
  const zScale = Math.sqrt(1.0 - z * z) * sc;
  out[0] = Math.cos(r) * zScale;
  out[1] = Math.sin(r) * zScale;
  out[2] = z * sc;
  return out;
}

export function transformMat4(out, a, m) {
  const x = a[0];
  const y = a[1];
  const z = a[2];
  let w = m[3] * x + m[7] * y + m[11] * z + m[15];
  w = w || 1.0;
  out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
  return out;
}

export function transformMat3(out, a, m) {
  const x = a[0];
  const y = a[1];
  const z = a[2];
  out[0] = x * m[0] + y * m[3] + z * m[6];
  out[1] = x * m[1] + y * m[4] + z * m[7];
  out[2] = x * m[2] + y * m[5] + z * m[8];
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
  return out;
}

export function rotateX(out, a, b, rad) {
  const p0 = a[0] - b[0];
  const p1 = a[1] - b[1];
  const p2 = a[2] - b[2];
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const r0 = p0;
  const r1 = p1 * c - p2 * s;
  const r2 = p1 * s + p2 * c;
  out[0] = r0 + b[0];
  out[1] = r1 + b[1];
  out[2] = r2 + b[2];
  return out;
}

export function rotateY(out, a, b, rad) {
  const p0 = a[0] - b[0];
  const p1 = a[1] - b[1];
  const p2 = a[2] - b[2];
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const r0 = p2 * s + p0 * c;
  const r1 = p1;
  const r2 = p2 * c - p0 * s;
  out[0] = r0 + b[0];
  out[1] = r1 + b[1];
  out[2] = r2 + b[2];
  return out;
}

export function rotateZ(out, a, b, rad) {
  const p0 = a[0] - b[0];
  const p1 = a[1] - b[1];
  const p2 = a[2] - b[2];
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const r0 = p0 * c - p1 * s;
  const r1 = p0 * s + p1 * c;
  const r2 = p2;
  out[0] = r0 + b[0];
  out[1] = r1 + b[1];
  out[2] = r2 + b[2];
  return out;
}

export function angle(a, b) {
  const ax = a[0];
  const ay = a[1];
  const az = a[2];
  const bx = b[0];
  const by = b[1];
  const bz = b[2];
  const mag = Math.sqrt(
    (ax * ax + ay * ay + az * az) * (bx * bx + by * by + bz * bz)
  );
  const cosine = mag && dot(a, b) / mag;
  return Math.acos(Math.min(Math.max(cosine, -1), 1));
}

export function zero(out) {
  out[0] = 0.0;
  out[1] = 0.0;
  out[2] = 0.0;
  return out;
}

export function str(a) {
  return 'vec3(' + a[0] + ', ' + a[1] + ', ' + a[2] + ')';
}

export function exactEquals(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export function equals(a, b) {
  const a0 = a[0];
  const a1 = a[1];
  const a2 = a[2];
  const b0 = b[0];
  const b1 = b[1];
  const b2 = b[2];
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
          Math.min(Number.MAX_VALUE, Math.max(1.0, Math.abs(a2), Math.abs(b2))))
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
      stride = 3;
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
      fn(vec, vec, arg);
      a[i] = vec[0];
      a[i + 1] = vec[1];
      a[i + 2] = vec[2];
    }
    return a;
  };
})();

const _pool = [];
const _MAX_POOL = 1024;

export function poolAcquire() {
  if (_pool.length > 0) {
    const v = _pool.pop();
    v[0] = 0;
    v[1] = 0;
    v[2] = 0;
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