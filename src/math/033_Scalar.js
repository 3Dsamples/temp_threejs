// file number : 033
// full path name : src/math/033_Scalar.js
// description : High-performance Scalar module rewritten from @scenesystems/effect-math Scalar without the Effect dependency. Provides scalar arithmetic (add, sub, mul, div, neg, abs, sign, pow, mod, min, max, clamp, saturate), rounding (floor, ceil, round, trunc, fract, sign, copysign), modulo (euclidean, floored, truncated), interpolation (lerp, inverseLerp, remap, mix, smoothstep, smootherstep, sineIn/Out/InOut, cubic, quintic, exponential, step, pulse), trig (sin, cos, tan, asin, acos, atan, atan2 with safe domain handling), hyperbolic (sinh, cosh, tanh, asinh, acosh, atanh), exponential/log (exp, exp2, log, log2, log10, log1p, expm1), roots (sqrt, cbrt, hypot, hypotN, fast inverse sqrt), angle conversions (deg2rad, rad2deg, wrapAngle, wrapAngleSigned, shortestAngle, positiveModulo), comparison (approxEqual with abs/rel/mixed, closeTo, isZero, isPositive, isNegative, sign), safe math (safeDiv, safeLog, safeSqrt, safePow, safeAcos, safeAsin), statistical reductions over arrays (sum, product, mean, min, max, minMax, range, count, countIf, dot, variance, stddev), random helpers (randomInRange, randomInt, randomSign, randomPointOnCircle), bitwise-safe helpers (nextPowerOfTwo, isPowerOfTwo, log2Int), fract/smoothstep chains, DD high-precision variants (ddAdd, ddMul, ddDiv, ddSqrt, ddLog, ddExp, ddPow, ddLerp), and TypeScript-style validators (ScalarInput, RangeInput, InterpolationInput, TrigInput, ReduceInput, AngleInput, CompareInput, SafeMathInput, ScalarArrayInput). Includes policy-aware wrappers via 030_Policy with strict/relaxed precision + diagnostics, pooled scratch buffers for reductions, and integration with 002_Constants (HELPERS, PRECISION), 003_Common (EPSILON, ARRAY_TYPE), 014_DoubleDouble, and 031_Precision.
// best for : Ultra-hot per-entity scalar computations, PBR parameter mixing, terrain height blending, LOD distance bands, animation curve evaluation, camera parameter smoothing, physics damping, AI decision noise, sim noise thresholds, and any per-frame scalar reduction at 10k+ entity scale on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, RANDOM, EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS } from '../core/002_Constants.js';
import * as DD from './014_DoubleDouble.js';
import * as Prec from './031_Precision.js';
import * as PolicyModule from './030_Policy.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'ScalarDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'ScalarDomainViolationError';
    this.operation = operation;
  }
}

// ============================================================================
// HELPERS
// ============================================================================
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function checkFinite(x, op, name) {
  if (!isFiniteNumber(x)) throw new DecodeError(op, name + ' must be finite');
}

function checkRange(lo, hi, op) {
  if (!isFiniteNumber(lo) || !isFiniteNumber(hi)) {
    throw new DecodeError(op, 'range bounds must be finite');
  }
  if (lo > hi) throw new DecodeError(op, 'lo must be <= hi');
}

function checkArrayLike(a, op, name) {
  if (!Array.isArray(a) && !(a instanceof Float64Array) && !(a instanceof Float32Array)) {
    throw new DecodeError(op, name + ' must be array-like');
  }
  for (let i = 0; i < a.length; i++) {
    if (!isFiniteNumber(a[i])) throw new DecodeError(op, name + '[' + i + '] must be finite');
  }
  return a;
}

// ============================================================================
// BASIC ARITHMETIC
// ============================================================================

export function add(a, b) { return a + b; }
export function sub(a, b) { return a - b; }
export function mul(a, b) { return a * b; }
export function div(a, b) { return b === 0 ? (a === 0 ? NaN : a > 0 ? Infinity : -Infinity) : a / b; }
export function neg(a) { return -a; }
export function abs(a) { return Math.abs(a); }
export function sign(a) { return a > 0 ? 1 : a < 0 ? -1 : 0; }
export function signOrZero(a) { return a > 0 ? 1 : a < 0 ? -1 : 0; }
export function copysign(a, b) { return b < 0 ? -Math.abs(a) : Math.abs(a); }
export function sqr(a) { return a * a; }
export function cube(a) { return a * a * a; }

export function pow(a, b) {
  if (a < 0 && !Number.isInteger(b)) return NaN;
  return Math.pow(a, b);
}

export function safePow(a, b, fallback) {
  const r = Math.pow(a, b);
  if (!Number.isFinite(r) && fallback !== undefined) return fallback;
  return r;
}

// ============================================================================
// MIN/MAX/CLAMP
// ============================================================================

export function min(a, b) { return a < b ? a : b; }
export function max(a, b) { return a > b ? a : b; }
export function minMax(a, b) { return a < b ? [a, b] : [b, a]; }

export function clamp(x, lo, hi) {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

export function saturate(x) { return clamp(x, 0, 1); }

export function clamp01(x) { return saturate(x); }

// ============================================================================
// ROUNDING
// ============================================================================

export function floor(x) { return Math.floor(x); }
export function ceil(x) { return Math.ceil(x); }
export function round(x) { return Math.round(x); }
export function trunc(x) { return x < 0 ? Math.ceil(x) : Math.floor(x); }
export function fract(x) { return x - Math.floor(x); }
export function roundToNearest(x, step) {
  if (step === 0) return x;
  return Math.round(x / step) * step;
}

// ============================================================================
// MODULO
// ============================================================================

export function modTruncated(a, b) {
  if (b === 0) return NaN;
  return a - b * trunc(a / b);
}

export function modEuclidean(a, b) {
  if (b === 0) return NaN;
  const bb = Math.abs(b);
  const r = a % bb;
  return r < 0 ? r + bb : r;
}

export function modFloored(a, b) {
  if (b === 0) return NaN;
  return a - b * Math.floor(a / b);
}

export function positiveModulo(a, b) {
  return modEuclidean(a, b);
}

// ============================================================================
// INTERPOLATION
// ============================================================================

export function lerp(a, b, t) { return a + t * (b - a); }
export function inverseLerp(a, b, v) {
  if (a === b) return 0;
  return (v - a) / (b - a);
}
export function remap(v, inLo, inHi, outLo, outHi) {
  return lerp(outLo, outHi, inverseLerp(inLo, inHi, v));
}
export function mix(a, b, t) { return lerp(a, b, t); }

export function step(edge, x) { return x < edge ? 0 : 1; }

export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function smootherstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function sineIn(t) { return 1 - Math.cos((t * Math.PI) / 2); }
export function sineOut(t) { return Math.sin((t * Math.PI) / 2); }
export function sineInOut(t) { return 0.5 * (1 - Math.cos(Math.PI * t)); }

export function cubicIn(t) { return t * t * t; }
export function cubicOut(t) { const u = 1 - t; return 1 - u * u * u; }
export function cubicInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function quinticIn(t) { return t * t * t * t * t; }
export function quinticOut(t) { const u = 1 - t; return 1 - u * u * u * u * u; }
export function quinticInOut(t) {
  return t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;
}

export function expoIn(t) { return t === 0 ? 0 : Math.pow(2, 10 * t - 10); }
export function expoOut(t) { return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); }
export function expoInOut(t) {
  if (t === 0) return 0;
  if (t === 1) return 1;
  return t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2;
}

export function pulse(x, lo, hi) {
  if (x < lo || x > hi) return 0;
  return 1;
}

// ============================================================================
// TRIG
// ============================================================================

export function sin(x) { return Math.sin(x); }
export function cos(x) { return Math.cos(x); }
export function tan(x) { return Math.tan(x); }
export function asin(x) { return x < -1 || x > 1 ? NaN : Math.asin(x); }
export function acos(x) { return x < -1 || x > 1 ? NaN : Math.acos(x); }
export function atan(x) { return Math.atan(x); }
export function atan2(y, x) { return Math.atan2(y, x); }

export function safeAsin(x, fallback) {
  if (x < -1) return fallback === undefined ? -Math.PI / 2 : fallback;
  if (x > 1) return fallback === undefined ? Math.PI / 2 : fallback;
  return Math.asin(x);
}

export function safeAcos(x, fallback) {
  if (x < -1) return fallback === undefined ? Math.PI : fallback;
  if (x > 1) return fallback === undefined ? 0 : fallback;
  return Math.acos(x);
}

// ============================================================================
// HYPERBOLIC
// ============================================================================

export function sinh(x) { return Math.sinh(x); }
export function cosh(x) { return Math.cosh(x); }
export function tanh(x) { return Math.tanh(x); }
export function asinh(x) { return Math.asinh ? Math.asinh(x) : Math.log(x + Math.sqrt(x * x + 1)); }
export function acosh(x) { return x < 1 ? NaN : Math.acosh ? Math.acosh(x) : Math.log(x + Math.sqrt(x * x - 1)); }
export function atanh(x) {
  if (x <= -1 || x >= 1) return NaN;
  return Math.atanh ? Math.atanh(x) : 0.5 * Math.log((1 + x) / (1 - x));
}

// ============================================================================
// EXPONENTIAL / LOGARITHM
// ============================================================================

export function exp(x) { return Math.exp(x); }
export function exp2(x) { return Math.pow(2, x); }
export function expm1(x) { return Math.expm1 ? Math.expm1(x) : (Math.abs(x) < 1e-10 ? x + 0.5 * x * x : Math.exp(x) - 1); }

export function log(x) { return x > 0 ? Math.log(x) : x === 0 ? -Infinity : NaN; }
export function log2(x) { return x > 0 ? Math.log2 ? Math.log2(x) : Math.log(x) / Math.LN2 : x === 0 ? -Infinity : NaN; }
export function log10(x) { return x > 0 ? Math.log10 ? Math.log10(x) : Math.log(x) / Math.LN10 : x === 0 ? -Infinity : NaN; }
export function log1p(x) { return Math.log1p ? Math.log1p(x) : (Math.abs(x) < 1e-10 ? x - 0.5 * x * x : Math.log(1 + x)); }

export function safeDiv(a, b, fallback) {
  if (b === 0) return fallback === undefined ? 0 : fallback;
  return a / b;
}

export function safeLog(x, fallback) {
  if (x <= 0) return fallback === undefined ? -Infinity : fallback;
  return Math.log(x);
}

export function safeSqrt(x, fallback) {
  if (x < 0) return fallback === undefined ? 0 : fallback;
  return Math.sqrt(x);
}

// ============================================================================
// ROOTS
// ============================================================================

export function sqrt(x) { return x < 0 ? NaN : Math.sqrt(x); }
export function cbrt(x) { return Math.cbrt ? Math.cbrt(x) : x >= 0 ? Math.pow(x, 1 / 3) : -Math.pow(-x, 1 / 3); }

export function hypot(a, b) {
  return Math.hypot ? Math.hypot(a, b) : Math.sqrt(a * a + b * b);
}

export function hypot3(a, b, c) {
  return Prec.hypot3(a, b, c);
}

export function hypotN(arr) {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
  return Math.sqrt(sum);
}

export function fastInverseSqrt(x) {
  if (x <= 0) return NaN;
  return 1 / Math.sqrt(x);
}

// ============================================================================
// ANGLE UTILITIES
// ============================================================================

export function deg2rad(deg) { return deg * HELPERS.DEG2RAD; }
export function rad2deg(rad) { return rad * HELPERS.RAD2DEG; }

export function wrapAngle(rad) {
  const tau = HELPERS.TAU;
  const a = rad % tau;
  return a < 0 ? a + tau : a;
}

export function wrapAngleSigned(rad) {
  const tau = HELPERS.TAU;
  let a = rad % tau;
  if (a > Math.PI) a -= tau;
  else if (a < -Math.PI) a += tau;
  return a;
}

export function shortestAngle(from, to) {
  return wrapAngleSigned(to - from);
}

export function lerpAngle(a, b, t) {
  return wrapAngle(a + shortestAngle(a, b) * t);
}

// ============================================================================
// COMPARISON
// ============================================================================

export function approxEqualAbs(a, b, absTol) {
  const t = absTol === undefined ? EPSILON : absTol;
  return a === b || Math.abs(a - b) <= t;
}

export function approxEqualRel(a, b, relTol) {
  const t = relTol === undefined ? EPSILON : relTol;
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale < Number.MIN_VALUE ? Math.abs(a - b) <= t : Math.abs(a - b) / scale <= t;
}

export function approxEqualMixed(a, b, absTol, relTol) {
  const at = absTol === undefined ? EPSILON : absTol;
  const rt = relTol === undefined ? EPSILON : relTol;
  if (a === b) return true;
  const diff = Math.abs(a - b);
  if (diff <= at) return true;
  return diff <= rt * Math.max(1, Math.abs(a), Math.abs(b));
}

export function closeTo(a, b, tol) {
  return approxEqualAbs(a, b, tol);
}

export function isZero(x) { return x === 0; }
export function isPositive(x) { return x > 0; }
export function isNegative(x) { return x < 0; }
export function isNonNegative(x) { return x >= 0; }
export function isNonPositive(x) { return x <= 0; }

// ============================================================================
// BITWISE-SAFE HELPERS
// ============================================================================

export function nextPowerOfTwo(n) {
  if (n <= 0) return 1;
  if (n <= 1) return 1;
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

export function log2Int(n) {
  if (n <= 0) return NaN;
  let shift = 0;
  while (n > 1) { n >>>= 1; shift++; }
  return shift;
}

// ============================================================================
// RANDOM HELPERS
// ============================================================================

export function randomInRange(lo, hi, rng) {
  return lo + (rng || RANDOM)() * (hi - lo);
}

export function randomInt(lo, hi, rng) {
  return Math.floor(lo + (rng || RANDOM)() * (hi - lo + 1));
}

export function randomSign(rng) {
  return (rng || RANDOM)() < 0.5 ? -1 : 1;
}

export function randomPointOnCircle(out, radius, rng) {
  const theta = (rng || RANDOM)() * HELPERS.TAU;
  out[0] = Math.cos(theta) * radius;
  out[1] = Math.sin(theta) * radius;
  return out;
}

// ============================================================================
// REDUCTIONS
// ============================================================================

export function sum(values) {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i];
  return s;
}

export function sumKahan(values) {
  let s = 0;
  let c = 0;
  for (let i = 0; i < values.length; i++) {
    const y = values[i] - c;
    const t = s + y;
    c = (t - s) - y;
    s = t;
  }
  return s;
}

export function product(values) {
  let p = 1;
  for (let i = 0; i < values.length; i++) p *= values[i];
  return p;
}

export function mean(values) {
  if (values.length === 0) return 0;
  return sum(values) / values.length;
}

export function minOf(values) {
  let m = Infinity;
  for (let i = 0; i < values.length; i++) if (values[i] < m) m = values[i];
  return m;
}

export function maxOf(values) {
  let m = -Infinity;
  for (let i = 0; i < values.length; i++) if (values[i] > m) m = values[i];
  return m;
}

export function minMaxOf(values) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { min: lo, max: hi, range: hi - lo };
}

export function range(values) {
  const mm = minMaxOf(values);
  return mm.range;
}

export function count(values) { return values.length; }

export function countIf(values, predicate) {
  let n = 0;
  for (let i = 0; i < values.length; i++) if (predicate(values[i])) n++;
  return n;
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function variance(values) {
  const n = values.length;
  if (n < 2) return 0;
  const m = mean(values);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] - m;
    s += d * d;
  }
  return s / (n - 1);
}

export function stddev(values) {
  return Math.sqrt(variance(values));
}

export function median(values) {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  if (n % 2 === 1) return sorted[(n - 1) / 2];
  return 0.5 * (sorted[n / 2 - 1] + sorted[n / 2]);
}

// ============================================================================
// DOUBLEDOUBLE HIGH-PRECISION VARIANTS
// ============================================================================

export function ddAdd(aDD, bDD) { return DD.add(aDD, bDD); }
export function ddSub(aDD, bDD) { return DD.subtract(aDD, bDD); }
export function ddMul(aDD, bDD) { return DD.multiply(aDD, bDD); }
export function ddDiv(aDD, bDD) { return DD.divide(aDD, bDD); }
export function ddSqrt(aDD) { return DD.sqrt(aDD); }
export function ddLog(aDD) { return DD.ln(aDD); }
export function ddExp(aDD) { return DD.exp(aDD); }
export function ddPow(aDD, bDD) { return DD.pow(aDD, bDD); }
export function ddLerp(aDD, bDD, t) {
  const tDD = DD.fromDouble(t);
  return DD.add(aDD, DD.multiply(DD.subtract(bDD, aDD), tDD));
}

// ============================================================================
// POOL
// ============================================================================
const _scratchPool = [];
const _MAX_SCRATCH = 32;

export function poolAcquireScratch(n) {
  if (_scratchPool.length > 0) {
    const s = _scratchPool.pop();
    if (s.length === n) {
      s.fill(0);
      return s;
    }
  }
  return new ARRAY_TYPE(n);
}

export function poolReleaseScratch(s) {
  if (_scratchPool.length >= _MAX_SCRATCH) return;
  _scratchPool.push(s);
}

export function poolReset() {
  _scratchPool.length = 0;
}

export function poolSize() {
  return _scratchPool.length;
}

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================

export const ScalarInput = Object.freeze({
  make(x) { return { x }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('scalar', 'Expected {x}');
    checkFinite(input.x, 'scalar', 'x');
    return input;
  }
});

export const RangeInput = Object.freeze({
  make(x, lo, hi) { return { x, lo, hi }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('range', 'Expected {x, lo, hi}');
    checkFinite(input.x, 'range', 'x');
    checkRange(input.lo, input.hi, 'range');
    return input;
  }
});

export const InterpolationInput = Object.freeze({
  make(a, b, t) { return { a, b, t }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('interpolation', 'Expected {a, b, t}');
    checkFinite(input.a, 'interpolation', 'a');
    checkFinite(input.b, 'interpolation', 'b');
    checkFinite(input.t, 'interpolation', 't');
    return input;
  }
});

export const TrigInput = Object.freeze({
  make(x) { return { x }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('trig', 'Expected {x}');
    checkFinite(input.x, 'trig', 'x');
    return input;
  }
});

export const ReduceInput = Object.freeze({
  make(values) { return { values }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('reduce', 'Expected {values}');
    checkArrayLike(input.values, 'reduce', 'values');
    return input;
  }
});

export const AngleInput = Object.freeze({
  make(x) { return { x }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('angle', 'Expected {x}');
    checkFinite(input.x, 'angle', 'x');
    return input;
  }
});

export const CompareInput = Object.freeze({
  make(a, b, absTol, relTol) { return { a, b, absTol, relTol }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('compare', 'Expected {a, b, absTol?, relTol?}');
    checkFinite(input.a, 'compare', 'a');
    checkFinite(input.b, 'compare', 'b');
    return input;
  }
});

export const SafeMathInput = Object.freeze({
  make(x, fallback) { return { x, fallback }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('safeMath', 'Expected {x, fallback?}');
    if (typeof input.x !== 'number') throw new DecodeError('safeMath', 'x must be number');
    return input;
  }
});

export const ScalarArrayInput = ReduceInput;

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================

export function clampValidated(input) {
  const d = RangeInput.decode(input);
  return clamp(d.x, d.lo, d.hi);
}

export function lerpValidated(input) {
  const d = InterpolationInput.decode(input);
  return lerp(d.a, d.b, d.t);
}

export function smoothstepValidated(input) {
  const d = RangeInput.decode(input);
  return smoothstep(d.lo, d.hi, d.x);
}

export function safeAsinValidated(input) {
  const d = SafeMathInput.decode(input);
  return safeAsin(d.x, d.fallback);
}

export function safeAcosValidated(input) {
  const d = SafeMathInput.decode(input);
  return safeAcos(d.x, d.fallback);
}

export function sumValidated(input) {
  const d = ReduceInput.decode(input);
  return sum(d.values);
}

export function meanValidated(input) {
  const d = ReduceInput.decode(input);
  return mean(d.values);
}

export function varianceValidated(input) {
  const d = ReduceInput.decode(input);
  return variance(d.values);
}

export function minMaxValidated(input) {
  const d = ReduceInput.decode(input);
  return minMaxOf(d.values);
}

export function compareValidated(input) {
  const d = CompareInput.decode(input);
  return approxEqualMixed(d.a, d.b, d.absTol, d.relTol);
}

export function angleWrapValidated(input) {
  const d = AngleInput.decode(input);
  return wrapAngle(d.x);
}

// ============================================================================
// POLICY-AWARE WRAPPERS
// ============================================================================

function policyScalar(operation, compute, annotate, policy) {
  const pol = PolicyModule.resolvePolicy(policy);
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const result = compute();
  if (pol.precision === PolicyModule.PrecisionMode.STRICT && typeof result === 'number' && !Number.isFinite(result)) {
    throw new DomainViolationError(operation, 'strict precision rejected non-finite result');
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

export function clampWithPolicies(x, lo, hi, policy) {
  return policyScalar(
    'Scalar.clampWithPolicies',
    () => clamp(x, lo, hi),
    (r) => ({ x, lo, hi, result: r }),
    policy
  );
}

export function lerpWithPolicies(a, b, t, policy) {
  return policyScalar(
    'Scalar.lerpWithPolicies',
    () => lerp(a, b, t),
    (r) => ({ a, b, t, result: r }),
    policy
  );
}

export function smoothstepWithPolicies(e0, e1, x, policy) {
  return policyScalar(
    'Scalar.smoothstepWithPolicies',
    () => smoothstep(e0, e1, x),
    (r) => ({ e0, e1, x, result: r }),
    policy
  );
}

export function sumWithPolicies(values, policy) {
  return policyScalar(
    'Scalar.sumWithPolicies',
    () => sumKahan(values),
    (r) => ({ n: values.length, result: r }),
    policy
  );
}

export function meanWithPolicies(values, policy) {
  return policyScalar(
    'Scalar.meanWithPolicies',
    () => mean(values),
    (r) => ({ n: values.length, result: r }),
    policy
  );
}

export function compareWithPolicies(a, b, policy, absTol, relTol) {
  return policyCustom(
    'Scalar.compareWithPolicies',
    () => approxEqualMixed(a, b, absTol, relTol),
    (r) => typeof r === 'boolean',
    (r) => ({ a, b, result: r }),
    policy
  );
}

export function wrapAngleWithPolicies(x, policy) {
  return policyScalar(
    'Scalar.wrapAngleWithPolicies',
    () => wrapAngle(x),
    (r) => ({ x, result: r }),
    policy
  );
}

// ============================================================================
// EXPORTS
// ============================================================================
export { EPSILON, PRECISION, HELPERS, DD, Prec, PolicyModule, RANDOM };

export default {
  DecodeError,
  DomainViolationError,
  add, sub, mul, div, neg, abs, sign, signOrZero, copysign, sqr, cube, pow, safePow,
  min, max, minMax, clamp, saturate, clamp01,
  floor, ceil, round, trunc, fract, roundToNearest,
  modTruncated, modEuclidean, modFloored, positiveModulo,
  lerp, inverseLerp, remap, mix, step, smoothstep, smootherstep,
  sineIn, sineOut, sineInOut, cubicIn, cubicOut, cubicInOut,
  quinticIn, quinticOut, quinticInOut, expoIn, expoOut, expoInOut, pulse,
  sin, cos, tan, asin, acos, atan, atan2, safeAsin, safeAcos,
  sinh, cosh, tanh, asinh, acosh, atanh,
  exp, exp2, expm1, log, log2, log10, log1p, safeDiv, safeLog, safeSqrt,
  sqrt, cbrt, hypot, hypot3, hypotN, fastInverseSqrt,
  deg2rad, rad2deg, wrapAngle, wrapAngleSigned, shortestAngle, lerpAngle,
  approxEqualAbs, approxEqualRel, approxEqualMixed, closeTo,
  isZero, isPositive, isNegative, isNonNegative, isNonPositive,
  nextPowerOfTwo, isPowerOfTwo, log2Int,
  randomInRange, randomInt, randomSign, randomPointOnCircle,
  sum, sumKahan, product, mean, minOf, maxOf, minMaxOf, range, count, countIf,
  dot, variance, stddev, median,
  ddAdd, ddSub, ddMul, ddDiv, ddSqrt, ddLog, ddExp, ddPow, ddLerp,
  poolAcquireScratch, poolReleaseScratch, poolReset, poolSize,
  ScalarInput, RangeInput, InterpolationInput, TrigInput, ReduceInput,
  AngleInput, CompareInput, SafeMathInput, ScalarArrayInput,
  clampValidated, lerpValidated, smoothstepValidated,
  safeAsinValidated, safeAcosValidated, sumValidated, meanValidated,
  varianceValidated, minMaxValidated, compareValidated, angleWrapValidated,
  clampWithPolicies, lerpWithPolicies, smoothstepWithPolicies,
  sumWithPolicies, meanWithPolicies, compareWithPolicies, wrapAngleWithPolicies
};