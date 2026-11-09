// file number : 003
// full path name : src/core/003_Common.js
// description : Common utilities for precision handling, array type selection, random, angle order, rounding, radian/degree conversion, and tolerance-based equality. Supports both 32-bit and 64-bit precision.
// best for : Core numeric utilities used by all math, physics, and rendering modules; ensures consistent precision across the engine.
// license : MIT

import { PRECISION, HELPERS } from './002_Constants.js';

export let ARRAY_TYPE = (typeof Float32Array !== 'undefined') ? Float32Array : Array;
export let RANDOM = Math.random;
export let ANGLE_ORDER = 'zyx';

export const EPSILON = PRECISION.EPSILON_32;

export function setMatrixArrayType(type) {
  ARRAY_TYPE = type;
}

export function setRandom(fn) {
  RANDOM = fn;
}

export function setAngleOrder(order) {
  ANGLE_ORDER = order;
}

export function round(a) {
  if (a >= 0) return Math.round(a);
  return (a % 0.5 === 0) ? Math.floor(a) : Math.round(a);
}

export function toRadian(a) {
  return a * HELPERS.DEG2RAD;
}

export function toDegree(a) {
  return a * HELPERS.RAD2DEG;
}

export function equals(a, b, tolerance = EPSILON) {
  return (
    a === b ||
    Math.abs(a - b) <=
      tolerance * Math.min(Number.MAX_VALUE, Math.max(1, Math.abs(a), Math.abs(b)))
  );
}

export function equals64(a, b, tolerance = PRECISION.EPSILON_64) {
  return (
    a === b ||
    Math.abs(a - b) <=
      tolerance * Math.min(Number.MAX_VALUE, Math.max(1, Math.abs(a), Math.abs(b)))
  );
}

export function lerp(a, b, t) {
  return a + t * (b - a);
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function smootherstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function nextPowerOfTwo(n) {
  if (n <= 0) return 1;
  n--;
  n |= n >> 1;
  n |= n >> 2;
  n |= n >> 4;
  n |= n >> 8;
  n |= n >> 16;
  return n + 1;
}

export function isPowerOfTwo(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

export function degToRad(deg) {
  return deg * HELPERS.DEG2RAD;
}

export function radToDeg(rad) {
  return rad * HELPERS.RAD2DEG;
}

export function wrapAngle(angle) {
  const tau = HELPERS.TAU;
  angle = angle % tau;
  if (angle < 0) angle += tau;
  return angle;
}

export function shortestAngle(from, to) {
  let diff = to - from;
  const tau = HELPERS.TAU;
  diff = ((diff % tau) + tau) % tau;
  if (diff > Math.PI) diff -= tau;
  return diff;
}