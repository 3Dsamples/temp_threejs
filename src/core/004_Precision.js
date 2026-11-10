// file number : 004
// full path name : src/core/004_Precision.js
// description : Adaptive precision manager that switches gl-matrix ARRAY_TYPE between Float32Array and Float64Array based on distance from floating origin. Handles floating origin rebasing for seamless small-to-galactic scale rendering. Provides float32/float64 helper factories and adaptive camera near/far computation.
// best for : Preventing z-fighting and precision loss at large scales; enables seamless millimeter-to-galactic transitions in real time while keeping local rendering crisp.
// license : MIT

import { PRECISION, SCALE } from './002_Constants.js';
import { setMatrixArrayType, ARRAY_TYPE } from './003_Common.js';

const F32 = (typeof Float32Array !== 'undefined') ? Float32Array : Array;
const F64 = (typeof Float64Array !== 'undefined') ? Float64Array : Array;

let _current = PRECISION.FLOAT32;
let _auto = true;
let _originX = 0;
let _originY = 0;
let _originZ = 0;
let _rebases = 0;

export const PrecisionState = {
  current: PRECISION.FLOAT32,
  origin: [0, 0, 0],
  rebases: 0
};

export function getPrecision() {
  return _current;
}

export function isFloat32() {
  return _current === PRECISION.FLOAT32;
}

export function isFloat64() {
  return _current === PRECISION.FLOAT64 || _current === PRECISION.DUAL;
}

export function isDual() {
  return _current === PRECISION.DUAL;
}

export function isAuto() {
  return _auto;
}

export function setAuto(enabled) {
  _auto = !!enabled;
}

export function setPrecision(mode) {
  if (mode === PRECISION.FLOAT32) {
    setMatrixArrayType(F32);
    _current = PRECISION.FLOAT32;
  } else if (mode === PRECISION.FLOAT64) {
    setMatrixArrayType(F64);
    _current = PRECISION.FLOAT64;
  } else if (mode === PRECISION.DUAL) {
    setMatrixArrayType(F64);
    _current = PRECISION.DUAL;
  }
  PrecisionState.current = _current;
  return _current;
}

export function getArrayType() {
  return ARRAY_TYPE;
}

export function createFloatArray(length) {
  return new ARRAY_TYPE(length);
}

export function createFloat32Array(length) {
  return new F32(length);
}

export function createFloat64Array(length) {
  return new F64(length);
}

export function distanceSq(x, y, z) {
  const dx = x - _originX;
  const dy = y - _originY;
  const dz = z - _originZ;
  return dx * dx + dy * dy + dz * dz;
}

export function updatePrecision(x, y, z) {
  if (!_auto) return false;

  const d2 = distanceSq(x, y, z);
  const safeSq = SCALE.FLOAT32_SAFE * SCALE.FLOAT32_SAFE;
  const limitSq = SCALE.FLOAT32_LIMIT * SCALE.FLOAT32_LIMIT;

  if (_current === PRECISION.FLOAT32 && d2 > limitSq) {
    setPrecision(PRECISION.FLOAT64);
    return true;
  }

  if (
    (_current === PRECISION.FLOAT64 || _current === PRECISION.DUAL) &&
    d2 < safeSq * 0.25
  ) {
    setPrecision(PRECISION.FLOAT32);
    return true;
  }

  return false;
}

export function rebaseOrigin(x, y, z) {
  _originX += x;
  _originY += y;
  _originZ += z;
  _rebases += 1;
  PrecisionState.origin[0] = _originX;
  PrecisionState.origin[1] = _originY;
  PrecisionState.origin[2] = _originZ;
  PrecisionState.rebases = _rebases;
  return [_originX, _originY, _originZ];
}

export function setOrigin(x, y, z) {
  _originX = x;
  _originY = y;
  _originZ = z;
  PrecisionState.origin[0] = x;
  PrecisionState.origin[1] = y;
  PrecisionState.origin[2] = z;
  return PrecisionState.origin;
}

export function absolutePosition(out, lx, ly, lz) {
  out[0] = lx + _originX;
  out[1] = ly + _originY;
  out[2] = lz + _originZ;
  return out;
}

export function localPosition(out, ax, ay, az) {
  out[0] = ax - _originX;
  out[1] = ay - _originY;
  out[2] = az - _originZ;
  return out;
}

export function getOrigin() {
  return [_originX, _originY, _originZ];
}

export function getOriginX() {
  return _originX;
}

export function getOriginY() {
  return _originY;
}

export function getOriginZ() {
  return _originZ;
}

export function getRebases() {
  return _rebases;
}

export function shouldRebase(x, y, z) {
  const d2 = distanceSq(x, y, z);
  const t2 = SCALE.FLOATING_ORIGIN_THRESHOLD * SCALE.FLOATING_ORIGIN_THRESHOLD;
  return d2 > t2;
}

export function maybeRebase(x, y, z) {
  if (shouldRebase(x, y, z)) {
    return rebaseOrigin(x - _originX, y - _originY, z - _originZ);
  }
  return null;
}

export function computeNearFar(depthRange, precision = _current) {
  const minNear = SCALE.CAMERA_NEAR_MIN;
  const maxFar =
    precision === PRECISION.FLOAT32
      ? SCALE.FLOAT32_LIMIT
      : SCALE.CAMERA_FAR_MAX;

  const far = Math.min(maxFar, Math.max(depthRange * 2.0, 100.0));
  const near = Math.max(minNear, far * 1e-4);
  return [near, far];
}

export default {
  getPrecision,
  isFloat32,
  isFloat64,
  isDual,
  isAuto,
  setAuto,
  setPrecision,
  getArrayType,
  createFloatArray,
  createFloat32Array,
  createFloat64Array,
  distanceSq,
  updatePrecision,
  rebaseOrigin,
  setOrigin,
  absolutePosition,
  localPosition,
  getOrigin,
  getOriginX,
  getOriginY,
  getOriginZ,
  getRebases,
  shouldRebase,
  maybeRebase,
  computeNearFar,
  PrecisionState
};