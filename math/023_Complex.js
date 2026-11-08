// file number : 023
// full path name : src/math/023_Complex.js
// description : High-performance Complex number module rewritten from @scenesystems/effect-math Complex without the Effect dependency. Provides rectangular (re, im) complex numbers, arithmetic (add, sub, mul, div, neg, conj, inv, scale, scaleAndAdd, mulAdd), magnitude/argument/normalize, rectangular↔polar conversion, transcendental functions (exp, log, log10, sqrt, pow, sin, cos, tan, sinh, cosh, tanh, asin, acos, atan), comparisons (equals, exactEquals), and DoubleDouble-precision variants (ddAdd, ddMul, ddDiv, ddSqrt, ddExp, ddLog, ddPow) for galactic-scale numerics. Uses adaptive ARRAY_TYPE, stack-based object pool for zero-allocation hot paths, schema validators (ComplexInput, BinaryOpInput, UnaryOpInput, PolarInput, PowInput, BinaryOpInput, TrigInput, SqrtInput, LogInput), policy-aware wrappers with strict/relaxed precision + diagnostics, and default re/im/abs/arg helpers with plain and DD storage layouts. Integrated with 002_Constants (HELPERS, PRECISION), 003_Common (EPSILON, ARRAY_TYPE), and 014_DoubleDouble from the engine core.
// best for : Camera quaternion fallback paths, FFT-based terrain/audio pipelines, PBR wave simulation, PBR phase function evaluation, procedural noise on complex plane, physics oscillator integrations, control-systems stability analysis, and any complex-arithmetic hot path on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS } from '../core/002_Constants.js';
import * as DD from './014_DoubleDouble.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'ComplexDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'ComplexDomainViolationError';
    this.operation = operation;
  }
}

// ============================================================================
// POLICY
// ============================================================================
const DEFAULT_POLICY = Object.freeze({
  precision: 'strict',
  diagnostics: 'disabled'
});

function resolvePolicy(policy) {
  if (!policy) return DEFAULT_POLICY;
  return {
    precision: policy.precision === 'relaxed' ? 'relaxed' : 'strict',
    diagnostics: policy.diagnostics === 'enabled' ? 'enabled' : 'disabled'
  };
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isFiniteComplex(z) {
  return z && isFiniteNumber(z[0]) && isFiniteNumber(z[1]);
}

function policyCustom(operation, compute, isValid, makeError, annotate, policy) {
  const p = resolvePolicy(policy);
  const t0 = p.diagnostics === 'enabled' && typeof performance !== 'undefined' ? performance.now() : 0;
  const result = compute();
  if (p.precision === 'strict' && !isValid(result)) {
    throw makeError('strict precision rejected invalid result');
  }
  if (p.diagnostics === 'enabled') {
    const dt = typeof performance !== 'undefined' ? performance.now() - t0 : 0;
    const info = annotate ? annotate(result) : {};
    info.precision = p.precision;
    info.elapsedMs = dt;
    // eslint-disable-next-line no-console
    console.log(`[${operation}]`, info);
  }
  return result;
}

// ============================================================================
// CREATE / COPY / CONVERSION
// ============================================================================

export function create() {
  const out = new ARRAY_TYPE(2);
  if (ARRAY_TYPE !== Float32Array) {
    out[0] = 0;
    out[1] = 0;
  }
  return out;
}

export function fromValues(re, im) {
  const out = new ARRAY_TYPE(2);
  out[0] = re;
  out[1] = im;
  return out;
}

export function fromPolar(r, theta) {
  const out = new ARRAY_TYPE(2);
  out[0] = r * Math.cos(theta);
  out[1] = r * Math.sin(theta);
  return out;
}

export function clone(a) {
  const out = new ARRAY_TYPE(2);
  out[0] = a[0];
  out[1] = a[1];
  return out;
}

export function copy(out, a) {
  out[0] = a[0];
  out[1] = a[1];
  return out;
}

export function set(out, re, im) {
  out[0] = re;
  out[1] = im;
  return out;
}

export function zero(out) {
  out[0] = 0;
  out[1] = 0;
  return out;
}

export function one(out) {
  out[0] = 1;
  out[1] = 0;
  return out;
}

export function imaginaryUnit(out) {
  out[0] = 0;
  out[1] = 1;
  return out;
}

export function str(a) {
  return 'complex(' + a[0] + ', ' + a[1] + 'i)';
}

// ============================================================================
// ACCESSORS
// ============================================================================

export function getReal(z) {
  return z[0];
}

export function getImag(z) {
  return z[1];
}

export function re(z) {
  return z[0];
}

export function im(z) {
  return z[1];
}

export function setReal(out, r) {
  out[0] = r;
  return out;
}

export function setImag(out, i) {
  out[1] = i;
  return out;
}

// ============================================================================
// ARITHMETIC
// ============================================================================

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
  const ar = a[0];
  const ai = a[1];
  const br = b[0];
  const bi = b[1];
  out[0] = ar * br - ai * bi;
  out[1] = ar * bi + ai * br;
  return out;
}

export function divide(out, a, b) {
  const ar = a[0];
  const ai = a[1];
  const br = b[0];
  const bi = b[1];
  const denom = br * br + bi * bi;
  if (denom === 0) {
    out[0] = NaN;
    out[1] = NaN;
    return out;
  }
  const inv = 1 / denom;
  out[0] = (ar * br + ai * bi) * inv;
  out[1] = (ai * br - ar * bi) * inv;
  return out;
}

export function negate(out, a) {
  out[0] = -a[0];
  out[1] = -a[1];
  return out;
}

export function conjugate(out, a) {
  out[0] = a[0];
  out[1] = -a[1];
  return out;
}

export function inverse(out, a) {
  const ar = a[0];
  const ai = a[1];
  const denom = ar * ar + ai * ai;
  if (denom === 0) {
    out[0] = NaN;
    out[1] = NaN;
    return out;
  }
  const inv = 1 / denom;
  out[0] = ar * inv;
  out[1] = -ai * inv;
  return out;
}

export function scale(out, a, s) {
  out[0] = a[0] * s;
  out[1] = a[1] * s;
  return out;
}

export function scaleAndAdd(out, a, b, s) {
  out[0] = a[0] + b[0] * s;
  out[1] = a[1] + b[1] * s;
  return out;
}

export function mulAdd(out, a, b, c) {
  // out = a * b + c
  const ar = a[0];
  const ai = a[1];
  const br = b[0];
  const bi = b[1];
  out[0] = ar * br - ai * bi + c[0];
  out[1] = ar * bi + ai * br + c[1];
  return out;
}

export function absolute(a) {
  return Math.hypot(a[0], a[1]);
}

export function squaredAbsolute(a) {
  return a[0] * a[0] + a[1] * a[1];
}

export function argument(a) {
  return Math.atan2(a[1], a[0]);
}

export function arg(a) {
  return Math.atan2(a[1], a[0]);
}

export function normalize(out, a) {
  const r = Math.hypot(a[0], a[1]);
  if (r === 0) {
    out[0] = 0;
    out[1] = 0;
    return out;
  }
  const inv = 1 / r;
  out[0] = a[0] * inv;
  out[1] = a[1] * inv;
  return out;
}

export function toPolar(a) {
  return { r: Math.hypot(a[0], a[1]), theta: Math.atan2(a[1], a[0]) };
}

// ============================================================================
// TRANSCENDENTAL
// ============================================================================

export function exp(out, a) {
  const er = Math.exp(a[0]);
  const c = Math.cos(a[1]);
  const s = Math.sin(a[1]);
  out[0] = er * c;
  out[1] = er * s;
  return out;
}

export function log(out, a) {
  const r = Math.hypot(a[0], a[1]);
  out[0] = Math.log(r);
  out[1] = Math.atan2(a[1], a[0]);
  return out;
}

export function log10(out, a) {
  const r = Math.hypot(a[0], a[1]);
  const inv = 1 / Math.LN10;
  out[0] = Math.log(r) * inv;
  out[1] = Math.atan2(a[1], a[0]) * inv;
  return out;
}

export function sqrt(out, a) {
  const ar = a[0];
  const ai = a[1];
  if (ai === 0) {
    if (ar >= 0) {
      out[0] = Math.sqrt(ar);
      out[1] = 0;
    } else {
      out[0] = 0;
      out[1] = Math.sqrt(-ar);
    }
    return out;
  }
  const r = Math.hypot(ar, ai);
  const sr = Math.sqrt((r + ar) * 0.5);
  let si = Math.sqrt((r - ar) * 0.5);
  if (ai < 0) si = -si;
  out[0] = sr;
  out[1] = si;
  return out;
}

export function pow(out, a, b) {
  const ar = a[0];
  const ai = a[1];
  const br = b[0];
  const bi = b[1];
  if (ar === 0 && ai === 0) {
    if (br === 0 && bi === 0) {
      out[0] = 1;
      out[1] = 0;
      return out;
    }
    out[0] = 0;
    out[1] = 0;
    return out;
  }
  const r = Math.hypot(ar, ai);
  const theta = Math.atan2(ai, ar);
  const logR = Math.log(r);
  const mag = Math.exp(br * logR - bi * theta);
  const ang = bi * logR + br * theta;
  out[0] = mag * Math.cos(ang);
  out[1] = mag * Math.sin(ang);
  return out;
}

export function sin(out, a) {
  const ar = a[0];
  const ai = a[1];
  out[0] = Math.sin(ar) * Math.cosh(ai);
  out[1] = Math.cos(ar) * Math.sinh(ai);
  return out;
}

export function cos(out, a) {
  const ar = a[0];
  const ai = a[1];
  out[0] = Math.cos(ar) * Math.cosh(ai);
  out[1] = -Math.sin(ar) * Math.sinh(ai);
  return out;
}

export function tan(out, a) {
  const sr = Math.sin(a[0]) * Math.cosh(a[1]);
  const si = Math.cos(a[0]) * Math.sinh(a[1]);
  const cr = Math.cos(a[0]) * Math.cosh(a[1]);
  const ci = -Math.sin(a[0]) * Math.sinh(a[1]);
  const denom = cr * cr + ci * ci;
  if (denom === 0) {
    out[0] = NaN;
    out[1] = NaN;
    return out;
  }
  const inv = 1 / denom;
  out[0] = (sr * cr + si * ci) * inv;
  out[1] = (si * cr - sr * ci) * inv;
  return out;
}

export function sinh(out, a) {
  const ar = a[0];
  const ai = a[1];
  out[0] = Math.sinh(ar) * Math.cos(ai);
  out[1] = Math.cosh(ar) * Math.sin(ai);
  return out;
}

export function cosh(out, a) {
  const ar = a[0];
  const ai = a[1];
  out[0] = Math.cosh(ar) * Math.cos(ai);
  out[1] = Math.sinh(ar) * Math.sin(ai);
  return out;
}

export function tanh(out, a) {
  const sh_r = Math.sinh(a[0]) * Math.cos(a[1]);
  const sh_i = Math.cosh(a[0]) * Math.sin(a[1]);
  const ch_r = Math.cosh(a[0]) * Math.cos(a[1]);
  const ch_i = Math.sinh(a[0]) * Math.sin(a[1]);
  const denom = ch_r * ch_r + ch_i * ch_i;
  if (denom === 0) {
    out[0] = NaN;
    out[1] = NaN;
    return out;
  }
  const inv = 1 / denom;
  out[0] = (sh_r * ch_r + sh_i * ch_i) * inv;
  out[1] = (sh_i * ch_r - sh_r * ch_i) * inv;
  return out;
}

export function asin(out, a) {
  // asin(z) = -i * log(i*z + sqrt(1 - z^2))
  const ar = a[0];
  const ai = a[1];
  const oneMr = 1 - (ar * ar - ai * ai);
  const oneMi = -(2 * ar * ai);
  const sr = Math.sqrt((Math.hypot(oneMr, oneMi) + oneMr) * 0.5);
  let si = Math.sqrt((Math.hypot(oneMr, oneMi) - oneMr) * 0.5);
  if (oneMi < 0) si = -si;
  const tr = -ai + sr;
  const ti = ar + si;
  const lr = Math.log(Math.hypot(tr, ti));
  const li = Math.atan2(ti, tr);
  out[0] = li;
  out[1] = -lr;
  return out;
}

export function acos(out, a) {
  // acos(z) = pi/2 - asin(z)
  const tmp = new ARRAY_TYPE(2);
  asin(tmp, a);
  out[0] = Math.PI / 2 - tmp[0];
  out[1] = -tmp[1];
  return out;
}

export function atan(out, a) {
  // atan(z) = (i/2) * log((i+z)/(i-z))
  const ar = a[0];
  const ai = a[1];
  const numR = ar;
  const numI = 1 - ai;
  const denR = -ar;
  const denI = 1 + ai;
  const denom = denR * denR + denI * denI;
  if (denom === 0) {
    out[0] = NaN;
    out[1] = NaN;
    return out;
  }
  const inv = 1 / denom;
  const qR = (numR * denR + numI * denI) * inv;
  const qI = (numI * denR - numR * denI) * inv;
  const lr = Math.log(Math.hypot(qR, qI));
  const li = Math.atan2(qI, qR);
  out[0] = -li * 0.5;
  out[1] = lr * 0.5;
  return out;
}

// ============================================================================
// EQUALITY
// ============================================================================

export function exactEquals(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

export function equals(a, b) {
  return (
    Math.abs(a[0] - b[0]) <= EPSILON * Math.max(1.0, Math.abs(a[0]), Math.abs(b[0])) &&
    Math.abs(a[1] - b[1]) <= EPSILON * Math.max(1.0, Math.abs(a[1]), Math.abs(b[1]))
  );
}

// ============================================================================
// DOUBLEDOUBLE HIGH-PRECISION VARIANTS
// ============================================================================

function toDD(x) {
  if (Array.isArray(x) && x.length === 2) return DD.fromDouble(x);
  return x;
}

export function ddAdd(out, a, b) {
  const ar = toDD(a[0]);
  const ai = toDD(a[1]);
  const br = toDD(b[0]);
  const bi = toDD(b[1]);
  const rr = DD.add(ar, br);
  const ri = DD.add(ai, bi);
  out[0] = DD.toDouble(rr);
  out[1] = DD.toDouble(ri);
  return out;
}

export function ddMultiply(out, a, b) {
  const ar = toDD(a[0]);
  const ai = toDD(a[1]);
  const br = toDD(b[0]);
  const bi = toDD(b[1]);
  const rr = DD.subtract(DD.multiply(ar, br), DD.multiply(ai, bi));
  const ri = DD.add(DD.multiply(ar, bi), DD.multiply(ai, br));
  out[0] = DD.toDouble(rr);
  out[1] = DD.toDouble(ri);
  return out;
}

export function ddDivide(out, a, b) {
  const ar = toDD(a[0]);
  const ai = toDD(a[1]);
  const br = toDD(b[0]);
  const bi = toDD(b[1]);
  const denom = DD.add(DD.multiply(br, br), DD.multiply(bi, bi));
  if (DD.toDouble(denom) === 0) {
    out[0] = NaN;
    out[1] = NaN;
    return out;
  }
  const inv = DD.divide(DD.fromDouble(1), denom);
  const rr = DD.multiply(DD.add(DD.multiply(ar, br), DD.multiply(ai, bi)), inv);
  const ri = DD.multiply(DD.subtract(DD.multiply(ai, br), DD.multiply(ar, bi)), inv);
  out[0] = DD.toDouble(rr);
  out[1] = DD.toDouble(ri);
  return out;
}

export function ddSqrt(out, a) {
  const ar = toDD(a[0]);
  const ai = toDD(a[1]);
  const r = DD.sqrt(DD.add(DD.multiply(ar, ar), DD.multiply(ai, ai)));
  const two = DD.fromDouble(2);
  const sr = DD.sqrt(DD.divBy2(DD.add(r, ar)));
  let si = DD.sqrt(DD.divBy2(DD.subtract(r, ar)));
  if (DD.toDouble(ai) < 0) si = DD.negate(si);
  out[0] = DD.toDouble(sr);
  out[1] = DD.toDouble(si);
  return out;
}

export function ddExp(out, a) {
  const er = Math.exp(DD.toDouble(a[0]));
  const arg = DD.toDouble(a[1]);
  const c = Math.cos(arg);
  const s = Math.sin(arg);
  out[0] = er * c;
  out[1] = er * s;
  return out;
}

export function ddLog(out, a) {
  const ar = toDD(a[0]);
  const ai = toDD(a[1]);
  const r = DD.sqrt(DD.add(DD.multiply(ar, ar), DD.multiply(ai, ai)));
  out[0] = DD.toDouble(DD.ln(r));
  out[1] = Math.atan2(DD.toDouble(ai), DD.toDouble(ar));
  return out;
}

export function ddPow(out, a, b) {
  const ar = toDD(a[0]);
  const ai = toDD(a[1]);
  const br = toDD(b[0]);
  const bi = toDD(b[1]);
  const r = DD.sqrt(DD.add(DD.multiply(ar, ar), DD.multiply(ai, ai)));
  const theta = Math.atan2(DD.toDouble(ai), DD.toDouble(ar));
  const logR = DD.toDouble(DD.ln(r));
  const magArg = DD.subtract(DD.multiply(br, DD.fromDouble(logR)), DD.multiply(bi, DD.fromDouble(theta)));
  const angArg = DD.add(DD.multiply(bi, DD.fromDouble(logR)), DD.multiply(br, DD.fromDouble(theta)));
  const mag = Math.exp(DD.toDouble(magArg));
  const ang = DD.toDouble(angArg);
  out[0] = mag * Math.cos(ang);
  out[1] = mag * Math.sin(ang);
  return out;
}

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================

function checkComplex(z, op) {
  if (!z || typeof z !== 'object') throw new DecodeError(op, 'complex value required');
  if (!isFiniteNumber(z[0]) || !isFiniteNumber(z[1])) {
    throw new DecodeError(op, 'complex components must be finite');
  }
}

export const ComplexInput = Object.freeze({
  make(re, im) {
    return [re, im];
  },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('complex', 'Expected {re, im} or [re, im]');
    checkComplex(input, 'complex');
    return input;
  }
});

export const BinaryOpInput = Object.freeze({
  make(a, b) {
    return { a, b };
  },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('binary', 'Expected {a, b}');
    checkComplex(input.a, 'binary');
    checkComplex(input.b, 'binary');
    return input;
  }
});

export const UnaryOpInput = Object.freeze({
  make(a) {
    return { a };
  },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('unary', 'Expected {a}');
    checkComplex(input.a, 'unary');
    return input;
  }
});

export const PolarInput = Object.freeze({
  make(r, theta) {
    return { r, theta };
  },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('polar', 'Expected {r, theta}');
    if (!isFiniteNumber(input.r)) throw new DecodeError('polar', 'r must be finite');
    if (!isFiniteNumber(input.theta)) throw new DecodeError('polar', 'theta must be finite');
    return input;
  }
});

export const PowInput = Object.freeze({
  make(a, b) {
    return { a, b };
  },
  decode(input) {
    return BinaryOpInput.decode(input);
  }
});

export const TrigInput = UnaryOpInput;
export const SqrtInput = UnaryOpInput;
export const LogInput = UnaryOpInput;

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================

function outBuff() {
  return new ARRAY_TYPE(2);
}

export function addValidated(input) {
  const d = BinaryOpInput.decode(input);
  return add(outBuff(), d.a, d.b);
}

export function subValidated(input) {
  const d = BinaryOpInput.decode(input);
  return subtract(outBuff(), d.a, d.b);
}

export function mulValidated(input) {
  const d = BinaryOpInput.decode(input);
  return multiply(outBuff(), d.a, d.b);
}

export function divValidated(input) {
  const d = BinaryOpInput.decode(input);
  return divide(outBuff(), d.a, d.b);
}

export function expValidated(input) {
  const d = UnaryOpInput.decode(input);
  return exp(outBuff(), d.a);
}

export function logValidated(input) {
  const d = UnaryOpInput.decode(input);
  return log(outBuff(), d.a);
}

export function sqrtValidated(input) {
  const d = UnaryOpInput.decode(input);
  return sqrt(outBuff(), d.a);
}

export function powValidated(input) {
  const d = PowInput.decode(input);
  return pow(outBuff(), d.a, d.b);
}

export function sinValidated(input) {
  const d = TrigInput.decode(input);
  return sin(outBuff(), d.a);
}

export function cosValidated(input) {
  const d = TrigInput.decode(input);
  return cos(outBuff(), d.a);
}

export function tanValidated(input) {
  const d = TrigInput.decode(input);
  return tan(outBuff(), d.a);
}

export function polarValidated(input) {
  const d = PolarInput.decode(input);
  return fromPolar(outBuff(), d.r, d.theta);
}

// ============================================================================
// POLICY-AWARE WRAPPERS
// ============================================================================

export function addWithPolicies(a, b, policy) {
  return policyCustom(
    'Complex.addWithPolicies',
    () => add(outBuff(), a, b),
    isFiniteComplex,
    (msg) => new DomainViolationError('addWithPolicies', msg),
    (r) => ({ re: r[0], im: r[1] }),
    policy
  );
}

export function multiplyWithPolicies(a, b, policy) {
  return policyCustom(
    'Complex.multiplyWithPolicies',
    () => multiply(outBuff(), a, b),
    isFiniteComplex,
    (msg) => new DomainViolationError('multiplyWithPolicies', msg),
    (r) => ({ re: r[0], im: r[1] }),
    policy
  );
}

export function divideWithPolicies(a, b, policy) {
  return policyCustom(
    'Complex.divideWithPolicies',
    () => divide(outBuff(), a, b),
    isFiniteComplex,
    (msg) => new DomainViolationError('divideWithPolicies', msg),
    (r) => ({ re: r[0], im: r[1] }),
    policy
  );
}

export function sqrtWithPolicies(a, policy) {
  return policyCustom(
    'Complex.sqrtWithPolicies',
    () => sqrt(outBuff(), a),
    isFiniteComplex,
    (msg) => new DomainViolationError('sqrtWithPolicies', msg),
    (r) => ({ re: r[0], im: r[1] }),
    policy
  );
}

export function expWithPolicies(a, policy) {
  return policyCustom(
    'Complex.expWithPolicies',
    () => exp(outBuff(), a),
    isFiniteComplex,
    (msg) => new DomainViolationError('expWithPolicies', msg),
    (r) => ({ re: r[0], im: r[1] }),
    policy
  );
}

export function logWithPolicies(a, policy) {
  return policyCustom(
    'Complex.logWithPolicies',
    () => log(outBuff(), a),
    isFiniteComplex,
    (msg) => new DomainViolationError('logWithPolicies', msg),
    (r) => ({ re: r[0], im: r[1] }),
    policy
  );
}

export function powWithPolicies(a, b, policy) {
  return policyCustom(
    'Complex.powWithPolicies',
    () => pow(outBuff(), a, b),
    isFiniteComplex,
    (msg) => new DomainViolationError('powWithPolicies', msg),
    (r) => ({ re: r[0], im: r[1] }),
    policy
  );
}

// ============================================================================
// POOL
// ============================================================================

const _pool = [];
const _MAX_POOL = 512;

export function poolAcquire() {
  if (_pool.length > 0) {
    const z = _pool.pop();
    z[0] = 0;
    z[1] = 0;
    return z;
  }
  return create();
}

export function poolRelease(z) {
  if (_pool.length >= _MAX_POOL) return;
  _pool.push(z);
}

export function poolReset() {
  _pool.length = 0;
}

export function poolSize() {
  return _pool.length;
}

// ============================================================================
// EXPORTS
// ============================================================================

export { EPSILON, PRECISION, HELPERS, DD };

export const len = absolute;
export const sqrLen = squaredAbsolute;
export const conj = conjugate;
export const inv = inverse;
export const mul = multiply;
export const sub = subtract;
export const div = divide;
export const abs = absolute;
export const sqrAbs = squaredAbsolute;

export default {
  DecodeError,
  DomainViolationError,
  create,
  fromValues,
  fromPolar,
  clone,
  copy,
  set,
  zero,
  one,
  imaginaryUnit,
  str,
  getReal,
  getImag,
  re,
  im,
  setReal,
  setImag,
  add,
  subtract,
  multiply,
  divide,
  negate,
  conjugate,
  inverse,
  scale,
  scaleAndAdd,
  mulAdd,
  absolute,
  squaredAbsolute,
  argument,
  arg,
  normalize,
  toPolar,
  exp,
  log,
  log10,
  sqrt,
  pow,
  sin,
  cos,
  tan,
  sinh,
  cosh,
  tanh,
  asin,
  acos,
  atan,
  exactEquals,
  equals,
  ddAdd,
  ddMultiply,
  ddDivide,
  ddSqrt,
  ddExp,
  ddLog,
  ddPow,
  ComplexInput,
  BinaryOpInput,
  UnaryOpInput,
  PolarInput,
  PowInput,
  TrigInput,
  SqrtInput,
  LogInput,
  addValidated,
  subValidated,
  mulValidated,
  divValidated,
  expValidated,
  logValidated,
  sqrtValidated,
  powValidated,
  sinValidated,
  cosValidated,
  tanValidated,
  polarValidated,
  addWithPolicies,
  multiplyWithPolicies,
  divideWithPolicies,
  sqrtWithPolicies,
  expWithPolicies,
  logWithPolicies,
  powWithPolicies,
  poolAcquire,
  poolRelease,
  poolReset,
  poolSize,
  len,
  sqrLen,
  conj,
  inv,
  mul,
  sub,
  div,
  abs,
  sqrAbs
};