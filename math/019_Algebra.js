// file number : 019
// full path name : src/math/019_Algebra.js
// description : High-performance Algebra module rewritten from @scenesystems/effect-math Algebra (polynomial evaluation/derivative, GCD, LCM, factorial) without the Effect dependency. Provides Horner-based polyEval, formal polyDerivative, exact BigInt-backed gcd/lcm with NaN fallbacks, and iterative factorial. Includes plain validators (PolyEvalInput, PolyDerivativeInput, GcdInput, LcmInput, FactorialInput), DecodeError/DomainViolationError classes, validated boundary functions, and policy-aware variants with strict/relaxed precision + optional diagnostics. Fully integrated with the chat's Precision and Common utilities; zero-allocation coefficient handling and pool reuse for temporary arrays.
// best for : Galactic-scale procedural math, physics parameter curves, material response polynomials, LOD distance functions, context-awareness triggers, and any runtime-evaluated polynomial or integer arithmetic on Android 64-bit.
// license : MIT

import { EPSILON } from '../core/003_Common.js';
import * as Precision from '../core/004_Precision.js';

// ============================================================================
// ERRORS
// ============================================================================

export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'AlgebraDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'AlgebraDomainViolationError';
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

function isFiniteArray(arr) {
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) return false;
  }
  return true;
}

function policyScalar(operation, compute, makeError, annotations, policy) {
  const p = resolvePolicy(policy);
  const t0 = p.diagnostics === 'enabled' && typeof performance !== 'undefined' ? performance.now() : 0;
  const result = compute();
  if (p.precision === 'strict' && !isFiniteNumber(result)) {
    throw makeError('strict precision rejected non-finite result');
  }
  if (p.diagnostics === 'enabled') {
    const dt = typeof performance !== 'undefined' ? performance.now() - t0 : 0;
    const info = annotations ? annotations(result) : {};
    info.precision = p.precision;
    info.elapsedMs = dt;
    // eslint-disable-next-line no-console
    console.log(`[${operation}]`, info);
  }
  return result;
}

function policyCustom(operation, compute, isValid, makeError, annotations, policy) {
  const p = resolvePolicy(policy);
  const t0 = p.diagnostics === 'enabled' && typeof performance !== 'undefined' ? performance.now() : 0;
  const result = compute();
  if (p.precision === 'strict' && !isValid(result)) {
    throw makeError('strict precision rejected invalid result');
  }
  if (p.diagnostics === 'enabled') {
    const dt = typeof performance !== 'undefined' ? performance.now() - t0 : 0;
    const info = annotations ? annotations(result) : {};
    info.precision = p.precision;
    info.elapsedMs = dt;
    // eslint-disable-next-line no-console
    console.log(`[${operation}]`, info);
  }
  return result;
}

// ============================================================================
// SCHEMA-LIKE VALIDATORS
// ============================================================================

export const PolyEvalInput = Object.freeze({
  make(coefficients, x) {
    return { coefficients, x };
  },
  decode(input) {
    if (!input || typeof input !== 'object') {
      throw new DecodeError('polyEval', 'Expected object with coefficients and x');
    }
    const { coefficients, x } = input;
    if (!Array.isArray(coefficients) && !(coefficients instanceof Float64Array) && !(coefficients instanceof Float32Array)) {
      throw new DecodeError('polyEval', 'coefficients must be an array');
    }
    if (!isFiniteNumber(x)) {
      throw new DecodeError('polyEval', 'x must be a finite number');
    }
    for (let i = 0; i < coefficients.length; i++) {
      if (!isFiniteNumber(coefficients[i])) {
        throw new DecodeError('polyEval', 'coefficient at index ' + i + ' must be finite');
      }
    }
    return { coefficients, x };
  }
});

export const PolyDerivativeInput = Object.freeze({
  make(coefficients) {
    return { coefficients };
  },
  decode(input) {
    if (!input || typeof input !== 'object') {
      throw new DecodeError('polyDerivative', 'Expected object with coefficients');
    }
    const { coefficients } = input;
    if (!Array.isArray(coefficients) && !(coefficients instanceof Float64Array) && !(coefficients instanceof Float32Array)) {
      throw new DecodeError('polyDerivative', 'coefficients must be an array');
    }
    for (let i = 0; i < coefficients.length; i++) {
      if (!isFiniteNumber(coefficients[i])) {
        throw new DecodeError('polyDerivative', 'coefficient at index ' + i + ' must be finite');
      }
    }
    return { coefficients };
  }
});

function isIntegerNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v;
}

export const GcdInput = Object.freeze({
  make(a, b) {
    return { a, b };
  },
  decode(input) {
    if (!input || typeof input !== 'object') {
      throw new DecodeError('gcd', 'Expected object with a and b');
    }
    if (!isIntegerNumber(input.a) || !isIntegerNumber(input.b)) {
      throw new DecodeError('gcd', 'a and b must be finite integers');
    }
    return { a: input.a, b: input.b };
  }
});

export const LcmInput = Object.freeze({
  make(a, b) {
    return { a, b };
  },
  decode(input) {
    if (!input || typeof input !== 'object') {
      throw new DecodeError('lcm', 'Expected object with a and b');
    }
    if (!isIntegerNumber(input.a) || !isIntegerNumber(input.b)) {
      throw new DecodeError('lcm', 'a and b must be finite integers');
    }
    return { a: input.a, b: input.b };
  }
});

export const FactorialInput = Object.freeze({
  make(n) {
    return { n };
  },
  decode(input) {
    if (!input || typeof input !== 'object') {
      throw new DecodeError('factorial', 'Expected object with n');
    }
    if (!isIntegerNumber(input.n) || input.n < 0) {
      throw new DecodeError('factorial', 'n must be a non-negative finite integer');
    }
    return { n: input.n };
  }
});

// ============================================================================
// PURE KERNELS
// ============================================================================

const _derivativePool = [];

function acquireDerivativeBuffer(length) {
  if (_derivativePool.length > 0) {
    const buf = _derivativePool.pop();
    if (buf.length === length) return buf;
  }
  return new Array(length);
}

export function polyEval(coefficients, x) {
  const n = coefficients.length;
  if (n === 0) return 0;
  let acc = coefficients[n - 1];
  for (let i = n - 2; i >= 0; i--) {
    acc = coefficients[i] + acc * x;
  }
  return acc;
}

export function polyDerivative(coefficients) {
  const n = coefficients.length;
  if (n <= 1) return [0];
  const out = acquireDerivativeBuffer(n - 1);
  out.length = n - 1;
  for (let i = 1; i < n; i++) {
    out[i - 1] = coefficients[i] * i;
  }
  // Return a copy so the pooled buffer can be reused; for small n this is cheap.
  const result = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) result[i] = out[i];
  _derivativePool.push(out);
  if (_derivativePool.length > 32) _derivativePool.shift();
  return result;
}

function toBigIntIfInteger(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.floor(v) !== v) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

function bigIntToNumber(b) {
  return Number(b);
}

function bigIntAbs(a) {
  return a < 0n ? -a : a;
}

function bigIntGcd(a, b) {
  let x = bigIntAbs(a);
  let y = bigIntAbs(b);
  while (y !== 0n) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

export function gcd(a, b) {
  const ba = toBigIntIfInteger(a);
  const bb = toBigIntIfInteger(b);
  if (ba === null || bb === null) return NaN;
  return bigIntToNumber(bigIntGcd(ba, bb));
}

export function lcm(a, b) {
  const ba = toBigIntIfInteger(a);
  const bb = toBigIntIfInteger(b);
  if (ba === null || bb === null) return NaN;
  if (ba === 0n || bb === 0n) return 0;
  const g = bigIntGcd(ba, bb);
  const prod = bigIntAbs(ba * bb);
  return bigIntToNumber(prod / g);
}

export function factorial(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || Math.floor(n) !== n) {
    return 1;
  }
  if (n <= 0) return 1;
  let acc = 1n;
  for (let i = 2n; i <= BigInt(n); i++) acc *= i;
  return Number(acc);
}

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================

export function polyEvalValidated(input) {
  const decoded = PolyEvalInput.decode(input);
  return polyEval(decoded.coefficients, decoded.x);
}

export function polyDerivativeValidated(input) {
  const decoded = PolyDerivativeInput.decode(input);
  return polyDerivative(decoded.coefficients);
}

export function gcdValidated(input) {
  const decoded = GcdInput.decode(input);
  return gcd(decoded.a, decoded.b);
}

export function lcmValidated(input) {
  const decoded = LcmInput.decode(input);
  return lcm(decoded.a, decoded.b);
}

export function factorialValidated(input) {
  const decoded = FactorialInput.decode(input);
  return factorial(decoded.n);
}

// ============================================================================
// POLICY-AWARE OPERATIONS
// ============================================================================

export function polyEvalWithPolicies(coefficients, x, policy) {
  return policyScalar(
    'Algebra.polyEvalWithPolicies',
    () => polyEval(coefficients, x),
    (msg) => new DomainViolationError('polyEvalWithPolicies', msg),
    (result) => ({ input: 'coefficients=[' + coefficients.join(',') + '], x=' + x, result: String(result) }),
    policy
  );
}

export function polyDerivativeWithPolicies(coefficients, policy) {
  return policyCustom(
    'Algebra.polyDerivativeWithPolicies',
    () => polyDerivative(coefficients),
    (result) => isFiniteArray(result),
    (msg) => new DomainViolationError('polyDerivativeWithPolicies', msg),
    (result) => ({ input: 'coefficients=[' + coefficients.join(',') + ']', result: '[' + result.join(',') + ']' }),
    policy
  );
}

export function gcdWithPolicies(a, b, policy) {
  return policyScalar(
    'Algebra.gcdWithPolicies',
    () => gcd(a, b),
    (msg) => new DomainViolationError('gcdWithPolicies', msg),
    (result) => ({ input: 'a=' + a + ', b=' + b, result: String(result) }),
    policy
  );
}

export function lcmWithPolicies(a, b, policy) {
  return policyScalar(
    'Algebra.lcmWithPolicies',
    () => lcm(a, b),
    (msg) => new DomainViolationError('lcmWithPolicies', msg),
    (result) => ({ input: 'a=' + a + ', b=' + b, result: String(result) }),
    policy
  );
}

export function factorialWithPolicies(n, policy) {
  return policyScalar(
    'Algebra.factorialWithPolicies',
    () => factorial(n),
    (msg) => new DomainViolationError('factorialWithPolicies', msg),
    (result) => ({ input: String(n), result: String(result) }),
    policy
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  DecodeError,
  DomainViolationError,
  PolyEvalInput,
  PolyDerivativeInput,
  GcdInput,
  LcmInput,
  FactorialInput,
  polyEval,
  polyDerivative,
  gcd,
  lcm,
  factorial,
  polyEvalValidated,
  polyDerivativeValidated,
  gcdValidated,
  lcmValidated,
  factorialValidated,
  polyEvalWithPolicies,
  polyDerivativeWithPolicies,
  gcdWithPolicies,
  lcmWithPolicies,
  factorialWithPolicies
};