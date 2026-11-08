// file number : 031
// full path name : src/math/031_Precision.js
// description : High-performance Precision module rewritten from @scenesystems/effect-math Precision without the Effect dependency. Provides IEEE-754 precision fundamentals for the engine: precision levels (SINGLE, DOUBLE, EXTENDED=DoubleDouble, ARBITRARY), rounding modes (TO_NEAREST, TOWARD_ZERO, UP, DOWN), machine epsilon per level, ULP (unit in last place) computation via float32/float64 bit tricks, adjacent floats (nextUp/nextDown), numeric classification (zero, subnormal, normal, infinite, NaN, finite), tolerance comparison (absolute, relative, ULP-based, approx), significant-digit truncation and rounding, precision string round-trip (toPrecisionString/fromPrecisionString), precision promotion/demotion, Higham's gamma_n error factor, first-order error bounds for add/sub/mul/div/sqrt, absolute/relative error measurement, minimal-level detection for a given value, ULP estimation between two values. Includes DoubleDouble (DD) integration for EXTENDED precision, schema validators (PrecisionInput, RoundingInput, ToleranceInput, UlpInput, ClassificationInput, ConversionInput, ErrorBoundsInput, DigitsInput), policy-aware wrappers with 030_Policy integration, and pooled scratch buffers for zero-allocation hot paths. Integrated with 002_Constants (PRECISION), 003_Common (EPSILON, ARRAY_TYPE), 004_Precision (adaptive) and 014_DoubleDouble.
// best for : Cross-module numeric accuracy guarantees; deciding 32 vs 64 vs DD on a per-operation basis; ULP-safe equality for physics and floating-origin; rounding helpers for terrain and coordinate snapping; precision promotion for galactic-scale pipelines; audit-mode numeric error diagnostics on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS, SCALE } from '../core/002_Constants.js';
import * as AdaptivePrecision from '../core/004_Precision.js';
import * as DD from './014_DoubleDouble.js';
import * as PolicyModule from './030_Policy.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'PrecisionDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'PrecisionDomainViolationError';
    this.operation = operation;
  }
}

// ============================================================================
// PRECISION LEVELS
// ============================================================================
export const PrecisionLevel = Object.freeze({
  SINGLE: 'single',
  DOUBLE: 'double',
  EXTENDED: 'extended',
  ARBITRARY: 'arbitrary'
});

export const PrecisionRank = Object.freeze({
  single: 1,
  double: 2,
  extended: 3,
  arbitrary: 4
});

export const RoundingMode = Object.freeze({
  TO_NEAREST: 'toNearest',
  TOWARD_ZERO: 'towardZero',
  UP: 'up',
  DOWN: 'down'
});

export const NumericClass = Object.freeze({
  ZERO: 'zero',
  SUBNORMAL: 'subnormal',
  NORMAL: 'normal',
  INFINITE: 'infinite',
  NAN: 'nan',
  NEGATIVE_ZERO: 'negativeZero'
});

// ============================================================================
// MACHINE EPSILON AND CONSTANTS
// ============================================================================
const MACHINE_EPS = Object.freeze({
  single: Math.pow(2, -23),
  double: Math.pow(2, -52),
  extended: Math.pow(2, -104),
  arbitrary: 0
});

const MIN_NORMAL = Object.freeze({
  single: Math.pow(2, -126),
  double: Math.pow(2, -1022),
  extended: Math.pow(2, -1022),
  arbitrary: 0
});

const MIN_SUBNORMAL = Object.freeze({
  single: Math.pow(2, -149),
  double: Math.pow(2, -1074),
  extended: Math.pow(2, -1074),
  arbitrary: 0
});

const MAX_FINITE = Object.freeze({
  single: 3.4028234663852886e38,
  double: Number.MAX_VALUE,
  extended: Number.MAX_VALUE,
  arbitrary: Infinity
});

const SIGNIFICAND_BITS = Object.freeze({
  single: 23,
  double: 52,
  extended: 104,
  arbitrary: 0
});

// ============================================================================
// HELPERS
// ============================================================================
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isValidLevel(level) {
  return (
    level === PrecisionLevel.SINGLE ||
    level === PrecisionLevel.DOUBLE ||
    level === PrecisionLevel.EXTENDED ||
    level === PrecisionLevel.ARBITRARY
  );
}

function isValidRounding(mode) {
  return (
    mode === RoundingMode.TO_NEAREST ||
    mode === RoundingMode.TOWARD_ZERO ||
    mode === RoundingMode.UP ||
    mode === RoundingMode.DOWN
  );
}

const _f32 = typeof Float32Array !== 'undefined' ? new Float32Array(1) : null;
const _i32 = typeof Int32Array !== 'undefined' ? new Int32Array(_f32 ? _f32.buffer : new ArrayBuffer(4)) : null;
const _f64 = typeof Float64Array !== 'undefined' ? new Float64Array(1) : null;
const _u64 = typeof Uint32Array !== 'undefined' && _f64 ? new Uint32Array(_f64.buffer) : null;

// ============================================================================
// MACHINE EPSILON / PRECISION CONSTANTS
// ============================================================================
export function machineEpsilon(level) {
  const lvl = level || PrecisionLevel.DOUBLE;
  return MACHINE_EPS[lvl];
}

export function minNormal(level) {
  return MIN_NORMAL[level || PrecisionLevel.DOUBLE];
}

export function minSubnormal(level) {
  return MIN_SUBNORMAL[level || PrecisionLevel.DOUBLE];
}

export function maxFinite(level) {
  return MAX_FINITE[level || PrecisionLevel.DOUBLE];
}

export function significandBits(level) {
  return SIGNIFICAND_BITS[level || PrecisionLevel.DOUBLE];
}

export function unitRoundoff(level) {
  return machineEpsilon(level) / 2;
}

// ============================================================================
// FLOATING POINT BIT MANIPULATION (32-bit)
// ============================================================================
function float32Bits(x) {
  _f32[0] = x;
  return _i32[0];
}

function float32FromBits(bits) {
  _i32[0] = bits;
  return _f32[0];
}

export function nextUpFloat32(x) {
  if (Number.isNaN(x)) return x;
  if (x === Infinity) return x;
  if (x === 0) return MIN_SUBNORMAL.single;
  if (x > 0) {
    const bits = float32Bits(x);
    return float32FromBits(bits + 1);
  }
  const bits = float32Bits(x);
  return float32FromBits(bits - 1);
}

export function nextDownFloat32(x) {
  if (Number.isNaN(x)) return x;
  if (x === -Infinity) return x;
  if (x === 0) return -MIN_SUBNORMAL.single;
  if (x > 0) {
    const bits = float32Bits(x);
    return float32FromBits(bits - 1);
  }
  const bits = float32Bits(x);
  return float32FromBits(bits + 1);
}

// ============================================================================
// FLOATING POINT BIT MANIPULATION (64-bit)
// ============================================================================
function float64Hi(x) {
  _f64[0] = x;
  return _u64[1];
}

function float64Lo(x) {
  _f64[0] = x;
  return _u64[0];
}

export function nextUpFloat64(x) {
  if (Number.isNaN(x)) return x;
  if (x === Infinity) return x;
  if (x === 0) return MIN_SUBNORMAL.double;
  if (x > 0) {
    _f64[0] = x;
    if (_u64[0] === 0xFFFFFFFF) {
      _u64[0] = 0;
      _u64[1] += 1;
    } else {
      _u64[0] += 1;
    }
    return _f64[0];
  }
  _f64[0] = x;
  if (_u64[0] === 0) {
    _u64[0] = 0xFFFFFFFF;
    _u64[1] -= 1;
  } else {
    _u64[0] -= 1;
  }
  return _f64[0];
}

export function nextDownFloat64(x) {
  if (Number.isNaN(x)) return x;
  if (x === -Infinity) return x;
  if (x === 0) return -MIN_SUBNORMAL.double;
  if (x > 0) {
    _f64[0] = x;
    if (_u64[0] === 0) {
      _u64[0] = 0xFFFFFFFF;
      _u64[1] -= 1;
    } else {
      _u64[0] -= 1;
    }
    return _f64[0];
  }
  _f64[0] = x;
  if (_u64[0] === 0xFFFFFFFF) {
    _u64[0] = 0;
    _u64[1] += 1;
  } else {
    _u64[0] += 1;
  }
  return _f64[0];
}

export function nextUp(x, level) {
  if (level === PrecisionLevel.SINGLE) return nextUpFloat32(x);
  return nextUpFloat64(x);
}

export function nextDown(x, level) {
  if (level === PrecisionLevel.SINGLE) return nextDownFloat32(x);
  return nextDownFloat64(x);
}

// ============================================================================
// ULP (UNIT IN THE LAST PLACE)
// ============================================================================

export function ulp(x, level) {
  const lvl = level || PrecisionLevel.DOUBLE;
  if (!isFiniteNumber(x)) return NaN;
  if (x === 0) return minSubnormal(lvl);
  const ax = Math.abs(x);
  if (lvl === PrecisionLevel.SINGLE) {
    return Math.max(nextUpFloat32(ax) - ax, 0);
  }
  if (lvl === PrecisionLevel.EXTENDED) {
    // ULP for double-double roughly machine_eps_extended * |x|
    return MACHINE_EPS.extended * ax;
  }
  return Math.max(nextUpFloat64(ax) - ax, 0);
}

export function ulpDistance(a, b, level) {
  const lvl = level || PrecisionLevel.DOUBLE;
  if (a === b) return 0;
  if (!isFiniteNumber(a) || !isFiniteNumber(b)) {
    return Number.isNaN(a) || Number.isNaN(b) ? NaN : Infinity;
  }
  if (a === 0) {
    const u = ulp(b, lvl);
    return u === 0 ? Infinity : Math.abs(b) / u;
  }
  const ua = ulp(a, lvl);
  const ub = ulp(b, lvl);
  const maxU = Math.max(ua, ub);
  if (maxU === 0) return 0;
  return Math.abs(a - b) / maxU;
}

export function ulpEqual(a, b, level, maxUlps) {
  const tol = maxUlps === undefined ? 0 : maxUlps;
  return ulpDistance(a, b, level) <= tol;
}

export function ulpClose(a, b, level, maxUlps) {
  const tol = maxUlps === undefined ? 4 : maxUlps;
  return ulpDistance(a, b, level) <= tol;
}

// ============================================================================
// CLASSIFICATION
// ============================================================================

export function classify(x) {
  if (Number.isNaN(x)) return NumericClass.NAN;
  if (x === Infinity || x === -Infinity) return NumericClass.INFINITE;
  if (x === 0) {
    return Object.is(x, -0) ? NumericClass.NEGATIVE_ZERO : NumericClass.ZERO;
  }
  const ax = Math.abs(x);
  if (ax < MIN_NORMAL.double) return NumericClass.SUBNORMAL;
  return NumericClass.NORMAL;
}

export function isZero(x) {
  return x === 0;
}

export function isSubnormal(x) {
  return isFiniteNumber(x) && x !== 0 && Math.abs(x) < MIN_NORMAL.double;
}

export function isNormal(x) {
  if (!isFiniteNumber(x) || x === 0) return false;
  return Math.abs(x) >= MIN_NORMAL.double;
}

export function isInfinite(x) {
  return x === Infinity || x === -Infinity;
}

export function isNaNValue(x) {
  return Number.isNaN(x);
}

// ============================================================================
// TOLERANCE COMPARISON
// ============================================================================

export function approxEqualAbs(a, b, absTol) {
  const t = absTol === undefined ? EPSILON : absTol;
  return a === b || Math.abs(a - b) <= t;
}

export function approxEqualRel(a, b, relTol) {
  const t = relTol === undefined ? EPSILON : relTol;
  if (a === b) return true;
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale < Number.MIN_VALUE ? diff <= t : diff / scale <= t;
}

export function approxEqualMixed(a, b, absTol, relTol) {
  const at = absTol === undefined ? EPSILON : absTol;
  const rt = relTol === undefined ? EPSILON : relTol;
  if (a === b) return true;
  const diff = Math.abs(a - b);
  if (diff <= at) return true;
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return diff <= rt * scale;
}

// ============================================================================
// ROUNDING MODES
// ============================================================================

export function roundToNearestInt(x) {
  return Math.round(x);
}

export function roundTowardZero(x) {
  return x < 0 ? Math.ceil(x) : Math.floor(x);
}

export function roundUp(x) {
  return Math.ceil(x);
}

export function roundDown(x) {
  return Math.floor(x);
}

export function roundWithMode(x, mode) {
  if (mode === RoundingMode.TO_NEAREST) return roundToNearestInt(x);
  if (mode === RoundingMode.TOWARD_ZERO) return roundTowardZero(x);
  if (mode === RoundingMode.UP) return roundUp(x);
  if (mode === RoundingMode.DOWN) return roundDown(x);
  return roundToNearestInt(x);
}

// ============================================================================
// SIGNIFICANT DIGITS
// ============================================================================

export function truncDigits(x, digits) {
  if (!isFiniteNumber(x) || x === 0) return x;
  const d = Math.max(0, digits | 0);
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const exp = Math.floor(Math.log10(ax));
  const pow = Math.pow(10, d - 1 - exp);
  return sign * Math.floor(ax * pow) / pow;
}

export function roundDigits(x, digits) {
  if (!isFiniteNumber(x) || x === 0) return x;
  const d = Math.max(0, digits | 0);
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const exp = Math.floor(Math.log10(ax));
  const pow = Math.pow(10, d - 1 - exp);
  return sign * Math.round(ax * pow) / pow;
}

// ============================================================================
// PRECISION STRINGS
// ============================================================================

export function toPrecisionString(x, significantDigits) {
  const d = significantDigits === undefined ? 17 : significantDigits;
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  return x.toPrecision(d);
}

export function fromPrecisionString(s) {
  if (typeof s !== 'string') return NaN;
  if (s === 'NaN') return NaN;
  if (s === 'Infinity') return Infinity;
  if (s === '-Infinity') return -Infinity;
  if (s === '-0') return -0;
  const n = parseFloat(s);
  return n;
}

// ============================================================================
// PRECISION PROMOTION / DEMOTION
// ============================================================================

export function promotePair(levelA, levelB) {
  const a = PrecisionRank[levelA] || 0;
  const b = PrecisionRank[levelB] || 0;
  return a >= b ? levelA : levelB;
}

export function promoteLevels(levels) {
  let best = PrecisionLevel.SINGLE;
  let bestRank = 0;
  for (let i = 0; i < levels.length; i++) {
    const r = PrecisionRank[levels[i]] || 0;
    if (r > bestRank) {
      bestRank = r;
      best = levels[i];
    }
  }
  return best;
}

export function detectMinimalLevel(x) {
  if (!isFiniteNumber(x)) return PrecisionLevel.ARBITRARY;
  if (x === 0) return PrecisionLevel.SINGLE;
  const ax = Math.abs(x);
  if (ax > MAX_FINITE.single || ax < MIN_SUBNORMAL.single) return PrecisionLevel.DOUBLE;
  const f32 = Math.fround(x);
  if (f32 === x) return PrecisionLevel.SINGLE;
  const dd = DD.fromDouble(x);
  const back = DD.toDouble(dd);
  if (back === x) return PrecisionLevel.DOUBLE;
  return PrecisionLevel.EXTENDED;
}

export function toLevel(x, level) {
  if (level === PrecisionLevel.SINGLE) return Math.fround(x);
  if (level === PrecisionLevel.DOUBLE) return x;
  if (level === PrecisionLevel.EXTENDED) {
    return DD.fromDouble(x);
  }
  return x;
}

export function fromLevel(x, level) {
  if (level === PrecisionLevel.EXTENDED) {
    return Array.isArray(x) && x.length === 2 ? DD.toDouble(x) : x;
  }
  return x;
}

// ============================================================================
// ERROR ANALYSIS
// ============================================================================

export function gamma(n, level) {
  const u = unitRoundoff(level);
  const nu = n * u;
  if (nu >= 1) return Infinity;
  return nu / (1 - nu);
}

export function absError(approx, exact) {
  return Math.abs(approx - exact);
}

export function relError(approx, exact) {
  if (exact === 0) return approx === 0 ? 0 : Infinity;
  return Math.abs(approx - exact) / Math.abs(exact);
}

export function errorBoundAdd(u, level) {
  return gamma(1, level) * u;
}

export function errorBoundSub(u, level) {
  return gamma(1, level) * u;
}

export function errorBoundMul(u, level) {
  return gamma(2, level) * u;
}

export function errorBoundDiv(u, level) {
  return gamma(3, level) * u;
}

export function errorBoundSqrt(u, level) {
  return gamma(1, level) * u;
}

// ============================================================================
// POOLED SCRATCH
// ============================================================================
const _scratchPool = [];
const _MAX_SCRATCH = 16;

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

function checkLevel(level, op) {
  if (!isValidLevel(level)) {
    throw new DecodeError(op, 'invalid precision level: ' + level);
  }
}

function checkFinite(x, op, name) {
  if (!isFiniteNumber(x)) throw new DecodeError(op, name + ' must be finite');
}

export const PrecisionInput = Object.freeze({
  make(level) { return { level }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('precision', 'Expected {level}');
    checkLevel(input.level, 'precision');
    return input;
  }
});

export const RoundingInput = Object.freeze({
  make(x, mode) { return { x, mode }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('rounding', 'Expected {x, mode?}');
    checkFinite(input.x, 'rounding', 'x');
    if (input.mode !== undefined && !isValidRounding(input.mode)) {
      throw new DecodeError('rounding', 'invalid rounding mode: ' + input.mode);
    }
    return input;
  }
});

export const UlpInput = Object.freeze({
  make(a, b, level, maxUlps) { return { a, b, level, maxUlps }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('ulp', 'Expected {a, b, level?, maxUlps?}');
    checkFinite(input.a, 'ulp', 'a');
    checkFinite(input.b, 'ulp', 'b');
    if (input.level !== undefined) checkLevel(input.level, 'ulp');
    if (input.maxUlps !== undefined && (!isFiniteNumber(input.maxUlps) || input.maxUlps < 0)) {
      throw new DecodeError('ulp', 'maxUlps must be non-negative finite');
    }
    return input;
  }
});

export const ToleranceInput = Object.freeze({
  make(a, b, absTol, relTol) { return { a, b, absTol, relTol }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('tolerance', 'Expected {a, b, absTol?, relTol?}');
    checkFinite(input.a, 'tolerance', 'a');
    checkFinite(input.b, 'tolerance', 'b');
    if (input.absTol !== undefined && (!isFiniteNumber(input.absTol) || input.absTol < 0)) {
      throw new DecodeError('tolerance', 'absTol must be non-negative finite');
    }
    if (input.relTol !== undefined && (!isFiniteNumber(input.relTol) || input.relTol < 0)) {
      throw new DecodeError('tolerance', 'relTol must be non-negative finite');
    }
    return input;
  }
});

export const ClassificationInput = Object.freeze({
  make(x) { return { x }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('classification', 'Expected {x}');
    if (typeof input.x !== 'number') throw new DecodeError('classification', 'x must be number');
    return input;
  }
});

export const ConversionInput = Object.freeze({
  make(x, level, targetLevel) { return { x, level, targetLevel }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('conversion', 'Expected {x, level, targetLevel}');
    checkLevel(input.level, 'conversion');
    checkLevel(input.targetLevel, 'conversion');
    return input;
  }
});

export const ErrorBoundsInput = Object.freeze({
  make(op, u, level) { return { op, u, level }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('errorBounds', 'Expected {op, u, level}');
    if (['add', 'sub', 'mul', 'div', 'sqrt'].indexOf(input.op) < 0) {
      throw new DecodeError('errorBounds', 'unknown op: ' + input.op);
    }
    checkFinite(input.u, 'errorBounds', 'u');
    checkLevel(input.level, 'errorBounds');
    return input;
  }
});

export const DigitsInput = Object.freeze({
  make(x, digits) { return { x, digits }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('digits', 'Expected {x, digits}');
    checkFinite(input.x, 'digits', 'x');
    if (!Number.isInteger(input.digits) || input.digits < 0) {
      throw new DecodeError('digits', 'digits must be non-negative integer');
    }
    return input;
  }
});

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================

export function machineEpsilonValidated(input) {
  const d = PrecisionInput.decode(input);
  return machineEpsilon(d.level);
}

export function roundValidated(input) {
  const d = RoundingInput.decode(input);
  return roundWithMode(d.x, d.mode);
}

export function ulpValidated(input) {
  const d = UlpInput.decode(input);
  return ulpDistance(d.a, d.b, d.level);
}

export function toleranceValidated(input) {
  const d = ToleranceInput.decode(input);
  return approxEqualMixed(d.a, d.b, d.absTol, d.relTol);
}

export function classificationValidated(input) {
  const d = ClassificationInput.decode(input);
  return classify(d.x);
}

export function conversionValidated(input) {
  const d = ConversionInput.decode(input);
  return toLevel(d.x, d.targetLevel);
}

export function errorBoundsValidated(input) {
  const d = ErrorBoundsInput.decode(input);
  if (d.op === 'add') return errorBoundAdd(d.u, d.level);
  if (d.op === 'sub') return errorBoundSub(d.u, d.level);
  if (d.op === 'mul') return errorBoundMul(d.u, d.level);
  if (d.op === 'div') return errorBoundDiv(d.u, d.level);
  return errorBoundSqrt(d.u, d.level);
}

export function truncDigitsValidated(input) {
  const d = DigitsInput.decode(input);
  return truncDigits(d.x, d.digits);
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

export function machineEpsilonWithPolicies(level, policy) {
  return policyScalar(
    'Precision.machineEpsilonWithPolicies',
    () => machineEpsilon(level),
    (r) => ({ level: level || PrecisionLevel.DOUBLE, result: String(r) }),
    policy
  );
}

export function ulpDistanceWithPolicies(a, b, level, policy) {
  return policyScalar(
    'Precision.ulpDistanceWithPolicies',
    () => ulpDistance(a, b, level),
    (r) => ({ a, b, result: String(r) }),
    policy
  );
}

export function toleranceWithPolicies(a, b, absTol, relTol, policy) {
  return policyCustom(
    'Precision.toleranceWithPolicies',
    () => approxEqualMixed(a, b, absTol, relTol),
    (r) => typeof r === 'boolean',
    (r) => ({ a, b, result: r }),
    policy
  );
}

export function classifyWithPolicies(x, policy) {
  return policyCustom(
    'Precision.classifyWithPolicies',
    () => classify(x),
    (r) => typeof r === 'string',
    (r) => ({ x, result: r }),
    policy
  );
}

export function detectMinimalLevelWithPolicies(x, policy) {
  return policyCustom(
    'Precision.detectMinimalLevelWithPolicies',
    () => detectMinimalLevel(x),
    (r) => typeof r === 'string',
    (r) => ({ x: String(x), result: r }),
    policy
  );
}

export function roundWithModeWithPolicies(x, mode, policy) {
  return policyScalar(
    'Precision.roundWithModeWithPolicies',
    () => roundWithMode(x, mode),
    (r) => ({ x, mode: mode || 'toNearest', result: String(r) }),
    policy
  );
}

// ============================================================================
// ADAPTERS (bridge with 004_Precision and 030_Policy)
// ============================================================================

export function currentEngineLevel() {
  const p = AdaptivePrecision.getPrecision();
  if (p === PRECISION.FLOAT32) return PrecisionLevel.SINGLE;
  if (p === PRECISION.FLOAT64) return PrecisionLevel.DOUBLE;
  if (p === PRECISION.DUAL) return PrecisionLevel.EXTENDED;
  return PrecisionLevel.DOUBLE;
}

export function levelForPolicy(policy) {
  const pol = PolicyModule.resolvePolicy(policy);
  if (pol.precision === PolicyModule.PrecisionMode.RELAXED) return PrecisionLevel.SINGLE;
  if (pol.precision === PolicyModule.PrecisionMode.DUAL) return PrecisionLevel.EXTENDED;
  return PrecisionLevel.DOUBLE;
}

export function epsilonForPolicy(policy) {
  return machineEpsilon(levelForPolicy(policy));
}

export function ulpForScale(scale, level) {
  return ulp(Math.max(scale, 1), level);
}

export function safeAdd(a, b, level) {
  const r = a + b;
  if (!isFiniteNumber(r) && level !== PrecisionLevel.EXTENDED) return NaN;
  return r;
}

export function safeMul(a, b, level) {
  const r = a * b;
  if (!isFiniteNumber(r) && level !== PrecisionLevel.EXTENDED) return NaN;
  return r;
}

// ============================================================================
// EXPORTS
// ============================================================================
export {
  EPSILON,
  PRECISION,
  HELPERS,
  SCALE,
  DD,
  AdaptivePrecision,
  PolicyModule
};

export default {
  DecodeError,
  DomainViolationError,
  PrecisionLevel,
  PrecisionRank,
  RoundingMode,
  NumericClass,
  machineEpsilon,
  minNormal,
  minSubnormal,
  maxFinite,
  significandBits,
  unitRoundoff,
  nextUpFloat32,
  nextDownFloat32,
  nextUpFloat64,
  nextDownFloat64,
  nextUp,
  nextDown,
  ulp,
  ulpDistance,
  ulpEqual,
  ulpClose,
  classify,
  isZero,
  isSubnormal,
  isNormal,
  isInfinite,
  isNaNValue,
  approxEqualAbs,
  approxEqualRel,
  approxEqualMixed,
  roundToNearestInt,
  roundTowardZero,
  roundUp,
  roundDown,
  roundWithMode,
  truncDigits,
  roundDigits,
  toPrecisionString,
  fromPrecisionString,
  promotePair,
  promoteLevels,
  detectMinimalLevel,
  toLevel,
  fromLevel,
  gamma,
  absError,
  relError,
  errorBoundAdd,
  errorBoundSub,
  errorBoundMul,
  errorBoundDiv,
  errorBoundSqrt,
  poolAcquireScratch,
  poolReleaseScratch,
  poolReset,
  poolSize,
  PrecisionInput,
  RoundingInput,
  UlpInput,
  ToleranceInput,
  ClassificationInput,
  ConversionInput,
  ErrorBoundsInput,
  DigitsInput,
  machineEpsilonValidated,
  roundValidated,
  ulpValidated,
  toleranceValidated,
  classificationValidated,
  conversionValidated,
  errorBoundsValidated,
  truncDigitsValidated,
  machineEpsilonWithPolicies,
  ulpDistanceWithPolicies,
  toleranceWithPolicies,
  classifyWithPolicies,
  detectMinimalLevelWithPolicies,
  roundWithModeWithPolicies,
  currentEngineLevel,
  levelForPolicy,
  epsilonForPolicy,
  ulpForScale,
  safeAdd,
  safeMul
};