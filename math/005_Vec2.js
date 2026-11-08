// file number : 005
// full path name : src/math/005_Vec2.js
// description : 2D vector math module built on gl-matrix v4 semantics with adaptive ARRAY_TYPE (Float32Array/Float64Array), full CRUD, arithmetic, dot/cross, lerp, random, transforms (mat2/mat2d/mat3/mat4), rotation, signed angle, equality, zeroing, string output, and a stack-based object pool for zero-allocation hot paths.
// best for : 2D math in UI, physics, animation curves, simplex noise coordinate offsets, sprite/particle systems, and any pooled per-frame vec2 work avoiding GC.
// license : MIT

import { ARRAY_TYPE, RANDOM, round as roundSym, EPSILON } from '../core/003_Common.js';

export function create() {
  const out = new ARRAY_TYPE(2);
  if (ARRAY_TYPE !== Float32Array) {
    out[0] = 0;
    out[1] = 0;
  }
  return out;
}

export function clone(a) {
  const out = new ARRAY_TYPE(2);
  out[0] = a[0];
  out[1] = a[1];
  return out;
}

export function fromValues(x, y) {
  const out = new ARRAY_TYPE(2);
  out[0] = x;
  out[1] = y;
  return out;
}

export function copy(out, a) {
  out[0] = a[0];
  out[1] = a[1];
  return out;
}

export function set(out, x, y) {
  out[0] = x;
  out[1] = y;
  return out;
}

export function add(out, a, b) {
  out[0] = a[0] + b[0];
  out[1] = a[1] + b[1];
  return out;
}

export function subtract(out, a, b) {
  out[0] = a[0] - b[0];
  out[1] = a[1] - b[1];
  return out;
}

export function multiply(out, a, b) {
  out[0] = a[0] * b[0];
  out[1] = a[1] * b[1];
  return out;
}

export function divide(out, a, b) {
  out[0] = a[0] / b[0];
  out[1] = a[1] / b[1];
  return out;
}

export function ceil(out, a) {
  out[0] = Math.ceil(a[0]);
  out[1] = Math.ceil(a[1]);
  return out;
}

export function floor(out, a) {
  out[0] = Math.floor(a[0]);
  out[1] = Math.floor(a[1]);
  return out;
}

export function min(out, a, b) {
  out[0] = Math.min(a[0], b[0]);
  out[1] = Math.min(a[1], b[1]);
  return out;
}

export function max(out, a, b) {
  out[0] = Math.max(a[0], b[0]);
  out[1] = Math.max(a[1], b[1]);
  return out;
}

export function round(out, a) {
  out[0] = roundSym(a[0]);
  out[1] = roundSym(a[1]);
  return out;
}

export function scale(out, a, b) {
  out[0] = a[0] * b;
  out[1] = a[1] * b;
  return out;
}

export function scaleAndAdd(out, a, b, s) {
  out[0] = a[0] + b[0] * s;
  out[1] = a[1] + b[1] * s;
  return out;
}

export function distance(a, b) {
  const x = b[0] - a[0];
  const y = b[1] - a[1];
  return Math.sqrt(x * x + y * y);
}

export function squaredDistance(a, b) {
  const x = b[0] - a[0];
  const y = b[1] - a[1];
  return x * x + y * y;
}

export function length(a) {
  const x = a[0];
  const y = a[1];
  return Math.sqrt(x * x + y * y);
}

export function squaredLength(a) {
  const x = a[0];
  const y = a[1];
  return x * x + y * y;
}

export function negate(out, a) {
  out[0] = -a[0];
  out[1] = -a[1];
  return out;
}

export function inverse(out, a) {
  out[0] = 1.0 / a[0];
  out[1] = 1.0 / a[1];
  return out;
}

export function normalize(out, a) {
  const x = a[0];
  const y = a[1];
  let l = x * x + y * y;
  if (l > 0) {
    l = 1 / Math.sqrt(l);
  }
  out[0] = a[0] * l;
  out[1] = a[1] * l;
  return out;
}

export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1];
}

export function cross(out, a, b) {
  const z = a[0] * b[1] - a[1] * b[0];
  out[0] = 0;
  out[1] = 0;
  out[2] = z;
  return out;
}

export function lerp(out, a, b, t) {
  const ax = a[0];
  const ay = a[1];
  out[0] = ax + t * (b[0] - ax);
  out[1] = ay + t * (b[1] - ay);
  return out;
}

export function random(out, s) {
  const sc = s === undefined ? 1.0 : s;
  const r = RANDOM() * 2.0 * Math.PI;
  out[0] = Math.cos(r) * sc;
  out[1] = Math.sin(r) * sc;
  return out;
}

export function transformMat2(out, a, m) {
  const x = a[0];
  const y = a[1];
  out[0] = m[0] * x + m[2] * y;
  out[1] = m[1] * x + m[3] * y;
  return out;
}

export function transformMat2d(out, a, m) {
  const x = a[0];
  const y = a[1];
  out[0] = m[0] * x + m[2] * y + m[4];
  out[1] = m[1] * x + m[3] * y + m[5];
  return out;
}

export function transformMat3(out, a, m) {
  const x = a[0];
  const y = a[1];
  out[0] = m[0] * x + m[3] * y + m[6];
  out[1] = m[1] * x + m[4] * y + m[7];
  return out;
}

export function transformMat4(out, a, m) {
  const x = a[0];
  const y = a[1];
  out[0] = m[0] * x + m[4] * y + m[12];
  out[1] = m[1] * x + m[5] * y + m[13];
  return out;
}

export function rotate(out, a, b, rad) {
  const p0 = a[0] - b[0];
  const p1 = a[1] - b[1];
  const sinC = Math.sin(rad);
  const cosC = Math.cos(rad);
  out[0] = p0 * cosC - p1 * sinC + b[0];
  out[1] = p0 * sinC + p1 * cosC + b[1];
  return out;
}

export function angle(a, b) {
  const ax = a[0];
  const ay = a[1];
  const bx = b[0];
  const by = b[1];
  return Math.abs(Math.atan2(ay * bx - ax * by, ax * bx + ay * by));
}

export function signedAngle(a, b) {
  const ax = a[0];
  const ay = a[1];
  const bx = b[0];
  const by = b[1];
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
}

export function zero(out) {
  out[0] = 0.0;
  out[1] = 0.0;
  return out;
}

export function str(a) {
  return 'vec2(' + a[0] + ', ' + a[1] + ')';
}

export function exactEquals(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

export function equals(a, b) {
  const a0 = a[0];
  const a1 = a[1];
  const b0 = b[0];
  const b1 = b[1];
  return (
    (a0 === b0 ||
      Math.abs(a0 - b0) <=
        EPSILON *
          Math.min(Number.MAX_VALUE, Math.max(1.0, Math.abs(a0), Math.abs(b0)))) &&
    (a1 === b1 ||
      Math.abs(a1 - b1) <=
        EPSILON *
          Math.min(Number.MAX_VALUE, Math.max(1.0, Math.abs(a1), Math.abs(b1))))
  );
}

export const len = length;
export const sub = subtract;
export const mul = multiply;
export const div = divide;
export const dist = distance;
export const sqrDist = squaredDistance;
export const sqrLen = squaredLength;

export const forEach = (function () {
  const vec = create();
  return function (a, stride, offset, count, fn, arg) {
    let i, l;
    if (!stride) {
      stride = 2;
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
      fn(vec, vec, arg);
      a[i] = vec[0];
      a[i + 1] = vec[1];
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