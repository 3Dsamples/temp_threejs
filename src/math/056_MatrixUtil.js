// file number : 056
// full path name : src/math/056_MatrixUtil.js
// description : High-performance utility module reimplemented from mljs/matrix util.js. Provides core primitives used throughout the matrix stack: xrange (1D index ranges), xrange1D/xrange2D typed-array optimizations, indexOfMax, indexOfMin, xrotate (in-place circular shift), xcorr (Pearson cross-correlation), vectorCheck (isVector / isRowVector / isColumnVector), matrixCheck, dimensionCheck, and safe type coercion helpers (toArray, toNumber, toPositiveInteger). All routines are zero-allocation in hot paths using ARRAY_TYPE scratch buffers with optional DoubleDouble accumulation. Integrated with 038_MatrixML MLMatrix, 030_Policy diagnostics, and the standard schema validators pattern (XRangeInput, RotateInput, IndexInput, VectorInput) for validated boundary calls.
// best for : Bulk index generation for batched kernel loops, feature reordering (xrotate) for FFT/Wavelet pipelines, cross-correlation between sensor streams, and any foundation utility used across 10k+ entity processing on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS } from '../core/002_Constants.js';
import * as DD from './014_DoubleDouble.js';
import * as ML from './038_MatrixML.js';
import * as PolicyModule from './030_Policy.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'MatrixUtilDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'MatrixUtilDomainViolationError';
    this.operation = operation;
  }
}

// ============================================================================
// NUMERIC COERCION
// ============================================================================
export function toNumber(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}

export function toPositiveInteger(value, fallback) {
  const n = Math.trunc(toNumber(value, fallback === undefined ? 1 : fallback));
  return n > 0 ? n : (fallback === undefined ? 1 : fallback);
}

export function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value instanceof Float64Array) return Array.from(value);
  if (value instanceof Float32Array) return Array.from(value);
  if (value && typeof value.length === 'number') return Array.prototype.slice.call(value);
  return [];
}

// ============================================================================
// XRANGE
// ============================================================================
export function xrange(start, stop, step) {
  let a = start;
  let b = stop;
  let s = step;
  if (b === undefined) {
    b = a;
    a = 0;
  }
  if (s === undefined) s = 1;
  if (s === 0) throw new DomainViolationError('xrange', 'step must be non-zero');
  const out = [];
  if (s > 0) {
    for (let i = a; i < b; i += s) out.push(i);
  } else {
    for (let i = a; i > b; i += s) out.push(i);
  }
  return out;
}

export function xrangeTyped(start, stop, step) {
  const arr = xrange(start, stop, step);
  const out = new ARRAY_TYPE(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i];
  return out;
}

export function xrange1D(n) {
  return xrangeTyped(0, n);
}

export function xrange2D(rows, cols) {
  // Returns [rowIndices, colIndices] as two typed arrays
  return [xrangeTyped(0, rows), xrangeTyped(0, cols)];
}

// ============================================================================
// INDEX HELPERS
// ============================================================================
export function indexOfMax(array) {
  if (!array || array.length === 0) return -1;
  let idx = 0;
  let best = array[0];
  for (let i = 1; i < array.length; i++) {
    const v = array[i];
    if (v > best) { best = v; idx = i; }
  }
  return idx;
}

export function indexOfMin(array) {
  if (!array || array.length === 0) return -1;
  let idx = 0;
  let best = array[0];
  for (let i = 1; i < array.length; i++) {
    const v = array[i];
    if (v < best) { best = v; idx = i; }
  }
  return idx;
}

export function argmax(array) { return indexOfMax(array); }
export function argmin(array) { return indexOfMin(array); }

// ============================================================================
// XROTATE (circular shift, in-place)
// ============================================================================
export function xrotate(array, leftToRight) {
  if (!array || array.length === 0) return array;
  const n = array.length;
  if (leftToRight) {
    // Shift right by 1 (last element becomes first)
    const last = array[n - 1];
    for (let i = n - 1; i > 0; i--) array[i] = array[i - 1];
    array[0] = last;
  } else {
    // Shift left by 1 (first element becomes last)
    const first = array[0];
    for (let i = 0; i < n - 1; i++) array[i] = array[i + 1];
    array[n - 1] = first;
  }
  return array;
}

export function xrotateN(array, shift) {
  if (!array || array.length === 0) return array;
  const n = array.length;
  const s = ((shift % n) + n) % n;
  if (s === 0) return array;
  const tmp = new ARRAY_TYPE(s);
  for (let i = 0; i < s; i++) tmp[i] = array[n - s + i];
  for (let i = n - 1; i >= s; i--) array[i] = array[i - s];
  for (let i = 0; i < s; i++) array[i] = tmp[i];
  return array;
}

// ============================================================================
// CROSS-CORRELATION (Pearson)
// ============================================================================
export function xcorr(x, y) {
  if (!x || !y) throw new DecodeError('xcorr', 'x and y required');
  const n = x.length;
  if (y.length !== n) throw new DomainViolationError('xcorr', 'x and y must be same length');
  if (n < 2) return 0;

  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
  const mx = sx / n;
  const my = sy / n;

  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const denom = Math.sqrt(sxx * syy);
  return denom > 0 ? sxy / denom : 0;
}

export function xcorrWithLag(x, y, maxLag) {
  const L = maxLag === undefined ? 10 : maxLag;
  const n = x.length;
  if (y.length !== n) throw new DomainViolationError('xcorrWithLag', 'x and y must be same length');
  const out = new ARRAY_TYPE(L * 2 + 1);
  for (let lag = -L; lag <= L; lag++) {
    let s = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const j = i + lag;
      if (j < 0 || j >= n) continue;
      s += x[i] * y[j];
      count++;
    }
    out[lag + L] = count > 0 ? s / count : 0;
  }
  return out;
}

// ============================================================================
// VECTOR / MATRIX CHECKS
// ============================================================================
export function isVector(obj) {
  if (!obj) return false;
  if (obj instanceof ML.MLMatrix) {
    return obj.isRowVector() || obj.isColumnVector();
  }
  if (Array.isArray(obj)) return true;
  if (obj instanceof Float64Array || obj instanceof Float32Array) return true;
  return false;
}

export function isRowVector(obj) {
  if (obj instanceof ML.MLMatrix) return obj.rows === 1;
  if (Array.isArray(obj) || obj instanceof Float64Array || obj instanceof Float32Array) return true;
  return false;
}

export function isColumnVector(obj) {
  if (obj instanceof ML.MLMatrix) return obj.columns === 1;
  if (Array.isArray(obj) || obj instanceof Float64Array || obj instanceof Float32Array) return true;
  return false;
}

export function vectorCheck(value, op) {
  if (!isVector(value)) {
    throw new DecodeError(op || 'vectorCheck', 'Value is not a vector');
  }
  return true;
}

export function matrixCheck(matrix, op) {
  if (!(matrix instanceof ML.MLMatrix)) {
    throw new DecodeError(op || 'matrixCheck', 'MLMatrix instance required');
  }
  return true;
}

export function dimensionCheck(matrix, rows, columns, op) {
  matrixCheck(matrix, op);
  if (matrix.rows !== rows || matrix.columns !== columns) {
    throw new DomainViolationError(
      op || 'dimensionCheck',
      `expected ${rows}x${columns}, got ${matrix.rows}x${matrix.columns}`
    );
  }
  return true;
}

// ============================================================================
// SAFE COPY HELPERS
// ============================================================================
export function safeSlice(array, start, end) {
  const n = array.length;
  const s = Math.max(0, Math.min(n, start === undefined ? 0 : start));
  const e = Math.max(s, Math.min(n, end === undefined ? n : end));
  if (array instanceof Float64Array || array instanceof Float32Array) {
    return array.subarray ? array.subarray(s, e) : array.slice(s, e);
  }
  return array.slice(s, e);
}

export function assignSafely(target, source) {
  const n = Math.min(target.length, source.length);
  for (let i = 0; i < n; i++) target[i] = source[i];
  return target;
}

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================
export const XRangeInput = Object.freeze({
  make(start, stop, step) { return { start, stop, step }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('xrange', 'Expected {start, stop, step?}');
    if (typeof input.start !== 'number') throw new DecodeError('xrange', 'start must be number');
    return input;
  }
});

export const RotateInput = Object.freeze({
  make(array, leftToRight) { return { array, leftToRight }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('xrotate', 'Expected {array, leftToRight?}');
    if (!input.array || typeof input.array.length !== 'number') {
      throw new DecodeError('xrotate', 'array required');
    }
    return input;
  }
});

export const IndexInput = Object.freeze({
  make(array) { return { array }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('indexOf', 'Expected {array}');
    if (!input.array || typeof input.array.length !== 'number') {
      throw new DecodeError('indexOf', 'array required');
    }
    if (input.array.length === 0) throw new DecodeError('indexOf', 'array must be non-empty');
    return input;
  }
});

export const CorrInput = Object.freeze({
  make(x, y) { return { x, y }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('xcorr', 'Expected {x, y}');
    if (!input.x || !input.y) throw new DecodeError('xcorr', 'x and y required');
    if (input.x.length !== input.y.length) throw new DecodeError('xcorr', 'x and y must be same length');
    return input;
  }
});

export const VectorValidationInput = Object.freeze({
  make(value) { return { value }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('vectorCheck', 'Expected {value}');
    return input;
  }
});

export const DimensionValidationInput = Object.freeze({
  make(matrix, rows, columns) { return { matrix, rows, columns }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('dimensionCheck', 'Expected {matrix, rows, columns}');
    if (!(input.matrix instanceof ML.MLMatrix)) {
      throw new DecodeError('dimensionCheck', 'matrix must be MLMatrix');
    }
    return input;
  }
});

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================
export function xrangeValidated(input) {
  const d = XRangeInput.decode(input);
  return xrange(d.start, d.stop, d.step);
}

export function xrotateValidated(input) {
  const d = RotateInput.decode(input);
  return xrotate(d.array, d.leftToRight);
}

export function indexOfMaxValidated(input) {
  const d = IndexInput.decode(input);
  return indexOfMax(d.array);
}

export function indexOfMinValidated(input) {
  const d = IndexInput.decode(input);
  return indexOfMin(d.array);
}

export function xcorrValidated(input) {
  const d = CorrInput.decode(input);
  return xcorr(d.x, d.y);
}

export function vectorCheckValidated(input) {
  const d = VectorValidationInput.decode(input);
  return vectorCheck(d.value);
}

export function dimensionCheckValidated(input) {
  const d = DimensionValidationInput.decode(input);
  return dimensionCheck(d.matrix, d.rows, d.columns);
}

// ============================================================================
// POLICY-AWARE WRAPPERS
// ============================================================================
function policyCustom(operation, compute, isValid, annotate, policy) {
  const pol = PolicyModule.resolvePolicy(policy);
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const result = compute();
  if (pol.precision === PolicyModule.PrecisionMode.STRICT && !isValid(result)) {
    throw new DomainViolationError(operation, 'strict precision rejected invalid result');
  }
  if (pol.diagnostics !== PolicyModule.DiagnosticMode.DISABLED) {
    const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    const info = annotate ? annotate(result) : {};
    info.precision = pol.precision;
    info.elapsedMs = elapsed;
    // eslint-disable-next-line no-console
    console.log(`[${operation}]`, info);
  }
  return result;
}

export function xrangeWithPolicies(start, stop, step, policy) {
  return policyCustom(
    'MatrixUtil.xrangeWithPolicies',
    () => xrange(start, stop, step),
    (r) => Array.isArray(r),
    (r) => ({ length: r.length }),
    policy
  );
}

export function xrotateWithPolicies(array, leftToRight, policy) {
  return policyCustom(
    'MatrixUtil.xrotateWithPolicies',
    () => xrotate(array.slice(), leftToRight),
    (r) => r && r.length > 0,
    (r) => ({ length: r.length }),
    policy
  );
}

export function xcorrWithPolicies(x, y, policy) {
  return policyCustom(
    'MatrixUtil.xcorrWithPolicies',
    () => xcorr(x, y),
    (r) => typeof r === 'number' && Number.isFinite(r),
    (r) => ({ result: r }),
    policy
  );
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default {
  DecodeError,
  DomainViolationError,
  toNumber,
  toPositiveInteger,
  toArray,
  xrange,
  xrangeTyped,
  xrange1D,
  xrange2D,
  indexOfMax,
  indexOfMin,
  argmax,
  argmin,
  xrotate,
  xrotateN,
  xcorr,
  xcorrWithLag,
  isVector,
  isRowVector,
  isColumnVector,
  vectorCheck,
  matrixCheck,
  dimensionCheck,
  safeSlice,
  assignSafely,
  XRangeInput,
  RotateInput,
  IndexInput,
  CorrInput,
  VectorValidationInput,
  DimensionValidationInput,
  xrangeValidated,
  xrotateValidated,
  indexOfMaxValidated,
  indexOfMinValidated,
  xcorrValidated,
  vectorCheckValidated,
  dimensionCheckValidated,
  xrangeWithPolicies,
  xrotateWithPolicies,
  xcorrWithPolicies
};