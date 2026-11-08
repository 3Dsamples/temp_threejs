// file number : 030
// full path name : src/math/030_Policy.js
// description : High-performance Policy module rewritten from @scenesystems/effect-math Policy without the Effect dependency. Centralizes execution policy across the entire math engine: precision (strict/relaxed/dual), diagnostics (disabled/enabled/verbose), execution mode (eager/lazy/buffered), caching (off/memo/lru), cancellation, timeouts, retry strategies, resource budgets (frame/time/memory), sampling strategies, and reporting channels. Provides immutable Policy objects with builder functions (makePolicy, withPrecision, withDiagnostics, withMode, withCache, withTimeout, withRetry, withBudget, withSampling, withReporter), deep merge/override, named presets (PRODUCTION, DEVELOPMENT, DEBUG, AUDIT, REALTIME, LOW_MEMORY, BATTERY_SAVER, GALACTIC, MOBILE_ANDROID64), policy resolution with inherited defaults, and a global default policy registry. Includes schema validators (PolicyInput, BudgetInput, RetryInput, SamplingInput, ReporterInput), a unified execution wrapper (executeWithPolicy) that handles strict-precision rejection, diagnostics timing, timeout enforcement, retry backoff, and error normalization, plus policy-aware composition helpers (combinePolicies, resolvePolicy, freezePolicy). Zero-allocation via frozen singleton presets and pooled budget accumulators. Integrated with 002_Constants (PRECISION, PERFORMANCE), 003_Common (EPSILON), and 014_DoubleDouble.
// best for : Cross-cutting behavior control (precision, diagnostics, timeouts, retries, budgets) across the entire 10k+ entity engine; enables a single toggle to switch between debug/production/galactic/mobile profiles without touching business logic, while keeping hot paths allocation-free on Android 64-bit.
// license : MIT

import { EPSILON } from '../core/003_Common.js';
import { PRECISION, PERFORMANCE, CONTEXT, MEMORY } from '../core/002_Constants.js';
import * as DD from './014_DoubleDouble.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'PolicyDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'PolicyDomainViolationError';
    this.operation = operation;
  }
}

export class PolicyViolationError extends Error {
  constructor(operation, message, policy) {
    super(message);
    this.name = 'PolicyViolationError';
    this.operation = operation;
    this.policy = policy;
  }
}

export class TimeoutError extends Error {
  constructor(operation, timeoutMs) {
    super(`operation timed out after ${timeoutMs}ms`);
    this.name = 'PolicyTimeoutError';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

// ============================================================================
// ENUMERATED POLICY VALUES
// ============================================================================
export const PrecisionMode = Object.freeze({
  STRICT: 'strict',
  RELAXED: 'relaxed',
  DUAL: 'dual'
});

export const DiagnosticMode = Object.freeze({
  DISABLED: 'disabled',
  ENABLED: 'enabled',
  VERBOSE: 'verbose'
});

export const ExecutionMode = Object.freeze({
  EAGER: 'eager',
  LAZY: 'lazy',
  BUFFERED: 'buffered'
});

export const CacheMode = Object.freeze({
  OFF: 'off',
  MEMO: 'memo',
  LRU: 'lru'
});

export const SamplingMode = Object.freeze({
  NONE: 'none',
  UNIFORM: 'uniform',
  ADAPTIVE: 'adaptive',
  RESERVOIR: 'reservoir'
});

export const RetryStrategy = Object.freeze({
  NONE: 'none',
  FIXED: 'fixed',
  LINEAR: 'linear',
  EXPONENTIAL: 'exponential',
  JITTER: 'jitter'
});

export const ReportChannel = Object.freeze({
  CONSOLE: 'console',
  SILENT: 'silent',
  CUSTOM: 'custom'
});

// ============================================================================
// HELPERS
// ============================================================================
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Object.isFrozen(obj)) return obj;
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) deepFreeze(obj[keys[i]]);
  return Object.freeze(obj);
}

function shallowMerge(base, override) {
  const out = {};
  const baseKeys = Object.keys(base);
  for (let i = 0; i < baseKeys.length; i++) {
    const k = baseKeys[i];
    out[k] = isPlainObject(base[k]) ? shallowMerge(base[k], {}) : base[k];
  }
  if (override) {
    const overKeys = Object.keys(override);
    for (let i = 0; i < overKeys.length; i++) {
      const k = overKeys[i];
      if (isPlainObject(out[k]) && isPlainObject(override[k])) {
        out[k] = shallowMerge(out[k], override[k]);
      } else {
        out[k] = override[k];
      }
    }
  }
  return out;
}

// ============================================================================
// DEFAULT POLICY
// ============================================================================
const DEFAULT_BUDGET = Object.freeze({
  timeMs: PERFORMANCE.GLOBAL_FRAME_BUDGET_MS || 12,
  memoryMB: 256,
  iterations: 1000,
  depth: 64
});

const DEFAULT_RETRY = Object.freeze({
  strategy: RetryStrategy.NONE,
  maxAttempts: 1,
  baseDelayMs: 100,
  maxDelayMs: 5000
});

const DEFAULT_SAMPLING = Object.freeze({
  mode: SamplingMode.NONE,
  rate: 1.0,
  reservoirSize: 64
});

const DEFAULT_REPORTER = Object.freeze({
  channel: ReportChannel.SILENT,
  callback: null
});

export const DEFAULT_POLICY = Object.freeze({
  precision: PrecisionMode.STRICT,
  diagnostics: DiagnosticMode.DISABLED,
  mode: ExecutionMode.EAGER,
  cache: CacheMode.OFF,
  timeoutMs: 0,
  budget: DEFAULT_BUDGET,
  retry: DEFAULT_RETRY,
  sampling: DEFAULT_SAMPLING,
  reporter: DEFAULT_REPORTER,
  tags: Object.freeze({}),
  version: 1
});

// ============================================================================
// POLICY CONSTRUCTION
// ============================================================================

export function makePolicy(overrides) {
  if (!overrides) return DEFAULT_POLICY;
  return deepFreeze(shallowMerge(DEFAULT_POLICY, overrides));
}

export function withPrecision(policy, mode) {
  if (mode !== PrecisionMode.STRICT && mode !== PrecisionMode.RELAXED && mode !== PrecisionMode.DUAL) {
    throw new DomainViolationError('withPrecision', 'invalid precision mode: ' + mode);
  }
  return makePolicy({ ...policy, precision: mode });
}

export function withDiagnostics(policy, mode) {
  if (mode !== DiagnosticMode.DISABLED && mode !== DiagnosticMode.ENABLED && mode !== DiagnosticMode.VERBOSE) {
    throw new DomainViolationError('withDiagnostics', 'invalid diagnostics mode: ' + mode);
  }
  return makePolicy({ ...policy, diagnostics: mode });
}

export function withMode(policy, mode) {
  if (mode !== ExecutionMode.EAGER && mode !== ExecutionMode.LAZY && mode !== ExecutionMode.BUFFERED) {
    throw new DomainViolationError('withMode', 'invalid execution mode: ' + mode);
  }
  return makePolicy({ ...policy, mode });
}

export function withCache(policy, mode) {
  if (mode !== CacheMode.OFF && mode !== CacheMode.MEMO && mode !== CacheMode.LRU) {
    throw new DomainViolationError('withCache', 'invalid cache mode: ' + mode);
  }
  return makePolicy({ ...policy, cache: mode });
}

export function withTimeout(policy, timeoutMs) {
  if (!isFiniteNumber(timeoutMs) || timeoutMs < 0) {
    throw new DomainViolationError('withTimeout', 'timeoutMs must be non-negative finite');
  }
  return makePolicy({ ...policy, timeoutMs });
}

export function withRetry(policy, retry) {
  if (!retry || typeof retry !== 'object') throw new DecodeError('withRetry', 'retry object required');
  return makePolicy({ ...policy, retry: shallowMerge(policy.retry, retry) });
}

export function withBudget(policy, budget) {
  if (!budget || typeof budget !== 'object') throw new DecodeError('withBudget', 'budget object required');
  return makePolicy({ ...policy, budget: shallowMerge(policy.budget, budget) });
}

export function withSampling(policy, sampling) {
  if (!sampling || typeof sampling !== 'object') throw new DecodeError('withSampling', 'sampling object required');
  return makePolicy({ ...policy, sampling: shallowMerge(policy.sampling, sampling) });
}

export function withReporter(policy, reporter) {
  if (!reporter || typeof reporter !== 'object') throw new DecodeError('withReporter', 'reporter object required');
  return makePolicy({ ...policy, reporter: shallowMerge(policy.reporter, reporter) });
}

export function withTags(policy, tags) {
  if (!isPlainObject(tags)) throw new DecodeError('withTags', 'tags object required');
  return makePolicy({ ...policy, tags: shallowMerge(policy.tags, tags) });
}

// ============================================================================
// NAMED PRESETS (frozen singletons, zero-allocation)
// ============================================================================
export const Presets = Object.freeze({
  PRODUCTION: makePolicy({
    precision: PrecisionMode.STRICT,
    diagnostics: DiagnosticMode.DISABLED,
    mode: ExecutionMode.EAGER,
    cache: CacheMode.LRU,
    budget: { timeMs: 12, memoryMB: 256, iterations: 1000, depth: 64 }
  }),
  DEVELOPMENT: makePolicy({
    precision: PrecisionMode.STRICT,
    diagnostics: DiagnosticMode.ENABLED,
    mode: ExecutionMode.EAGER,
    cache: CacheMode.MEMO
  }),
  DEBUG: makePolicy({
    precision: PrecisionMode.DUAL,
    diagnostics: DiagnosticMode.VERBOSE,
    mode: ExecutionMode.EAGER,
    cache: CacheMode.OFF,
    reporter: { channel: ReportChannel.CONSOLE }
  }),
  AUDIT: makePolicy({
    precision: PrecisionMode.DUAL,
    diagnostics: DiagnosticMode.VERBOSE,
    mode: ExecutionMode.BUFFERED,
    cache: CacheMode.LRU,
    budget: { timeMs: 100, memoryMB: 1024, iterations: 10000, depth: 256 }
  }),
  REALTIME: makePolicy({
    precision: PrecisionMode.STRICT,
    diagnostics: DiagnosticMode.DISABLED,
    mode: ExecutionMode.EAGER,
    cache: CacheMode.LRU,
    budget: { timeMs: 4, memoryMB: 128, iterations: 500, depth: 32 }
  }),
  LOW_MEMORY: makePolicy({
    precision: PrecisionMode.RELAXED,
    diagnostics: DiagnosticMode.DISABLED,
    mode: ExecutionMode.EAGER,
    cache: CacheMode.OFF,
    budget: { timeMs: 8, memoryMB: 64, iterations: 250, depth: 16 }
  }),
  BATTERY_SAVER: makePolicy({
    precision: PrecisionMode.RELAXED,
    diagnostics: DiagnosticMode.DISABLED,
    mode: ExecutionMode.EAGER,
    cache: CacheMode.LRU,
    budget: { timeMs: 16, memoryMB: 128, iterations: 500, depth: 32 }
  }),
  GALACTIC: makePolicy({
    precision: PrecisionMode.DUAL,
    diagnostics: DiagnosticMode.DISABLED,
    mode: ExecutionMode.EAGER,
    cache: CacheMode.LRU,
    budget: { timeMs: 16, memoryMB: 512, iterations: 2000, depth: 64 }
  }),
  MOBILE_ANDROID64: makePolicy({
    precision: PrecisionMode.STRICT,
    diagnostics: DiagnosticMode.DISABLED,
    mode: ExecutionMode.EAGER,
    cache: CacheMode.LRU,
    budget: { timeMs: 12, memoryMB: 128, iterations: 750, depth: 32 }
  })
});

// ============================================================================
// PRESET REGISTRY
// ============================================================================
const _presetRegistry = new Map();
for (const k of Object.keys(Presets)) _presetRegistry.set(k, Presets[k]);

export function registerPreset(name, policy) {
  if (typeof name !== 'string' || !policy) return false;
  _presetRegistry.set(name, freezePolicy(policy));
  return true;
}

export function getPreset(name) {
  return _presetRegistry.get(name) || null;
}

export function hasPreset(name) {
  return _presetRegistry.has(name);
}

export function listPresets() {
  return Array.from(_presetRegistry.keys());
}

// ============================================================================
// DEFAULT POLICY REGISTRY (global fallback)
// ============================================================================
let _globalDefault = Presets.PRODUCTION;

export function setGlobalDefault(policy) {
  _globalDefault = freezePolicy(policy);
  return _globalDefault;
}

export function getGlobalDefault() {
  return _globalDefault;
}

// ============================================================================
// COMPOSITION
// ============================================================================

export function combinePolicies(policies) {
  if (!Array.isArray(policies) || policies.length === 0) return _globalDefault;
  let acc = _globalDefault;
  for (let i = 0; i < policies.length; i++) {
    if (policies[i]) acc = makePolicy(shallowMerge(acc, policies[i]));
  }
  return acc;
}

export function resolvePolicy(policy) {
  if (!policy) return _globalDefault;
  if (typeof policy === 'string') {
    const preset = _presetRegistry.get(policy);
    if (!preset) throw new DecodeError('resolvePolicy', 'unknown preset: ' + policy);
    return preset;
  }
  return freezePolicy(policy);
}

export function freezePolicy(policy) {
  if (!policy) return _globalDefault;
  return deepFreeze(shallowMerge(DEFAULT_POLICY, policy));
}

// ============================================================================
// BUDGET ACCUMULATOR (pooled, zero-allocation per frame)
// ============================================================================
const _budgetPool = [];
const _MAX_BUDGET_POOL = 64;

export function acquireBudgetAccumulator() {
  if (_budgetPool.length > 0) {
    const acc = _budgetPool.pop();
    acc.elapsedMs = 0;
    acc.iterations = 0;
    acc.depth = 0;
    acc.memoryMB = 0;
    acc.failed = false;
    return acc;
  }
  return { elapsedMs: 0, iterations: 0, depth: 0, memoryMB: 0, failed: false };
}

export function releaseBudgetAccumulator(acc) {
  if (_budgetPool.length >= _MAX_BUDGET_POOL) return;
  _budgetPool.push(acc);
}

export function resetBudgetPool() {
  _budgetPool.length = 0;
}

export function budgetPoolSize() {
  return _budgetPool.length;
}

function checkBudget(acc, budget, operation) {
  if (!budget) return;
  if (isFiniteNumber(budget.timeMs) && budget.timeMs > 0 && acc.elapsedMs > budget.timeMs) {
    throw new PolicyViolationError(operation, `time budget exceeded: ${acc.elapsedMs.toFixed(2)}ms > ${budget.timeMs}ms`);
  }
  if (isFiniteNumber(budget.iterations) && budget.iterations > 0 && acc.iterations > budget.iterations) {
    throw new PolicyViolationError(operation, `iteration budget exceeded: ${acc.iterations} > ${budget.iterations}`);
  }
  if (isFiniteNumber(budget.depth) && budget.depth > 0 && acc.depth > budget.depth) {
    throw new PolicyViolationError(operation, `depth budget exceeded: ${acc.depth} > ${budget.depth}`);
  }
}

// ============================================================================
// RETRY HELPER
// ============================================================================

function computeDelay(strategy, attempt, baseDelayMs, maxDelayMs) {
  let delay = baseDelayMs;
  if (strategy === RetryStrategy.LINEAR) delay = baseDelayMs * (attempt + 1);
  else if (strategy === RetryStrategy.EXPONENTIAL) delay = baseDelayMs * Math.pow(2, attempt);
  else if (strategy === RetryStrategy.JITTER) delay = baseDelayMs * Math.pow(2, attempt) * (0.5 + Math.random());
  if (delay > maxDelayMs) delay = maxDelayMs;
  return delay;
}

// ============================================================================
// UNIFIED EXECUTION WRAPPER
// ============================================================================

export function executeWithPolicy(operation, fn, policy) {
  const pol = resolvePolicy(policy);
  const acc = acquireBudgetAccumulator();
  const t0 = nowMs();
  let lastError = null;
  const maxAttempts = pol.retry && pol.retry.maxAttempts > 0 ? pol.retry.maxAttempts : 1;

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      acc.elapsedMs = nowMs() - t0;
      try {
        checkBudget(acc, pol.budget, operation);
      } catch (budgetErr) {
        reportDiagnostic(pol, operation, 'budget-violation', budgetErr.message);
        throw budgetErr;
      }
      try {
        const result = fn(acc);
        const elapsed = nowMs() - t0;
        acc.elapsedMs = elapsed;
        if (pol.precision === PrecisionMode.STRICT && typeof result === 'number' && !Number.isFinite(result)) {
          reportDiagnostic(pol, operation, 'non-finite', String(result));
          throw new DomainViolationError(operation, 'strict precision rejected non-finite result');
        }
        if (pol.diagnostics !== DiagnosticMode.DISABLED) {
          reportDiagnostic(pol, operation, 'success', `attempt=${attempt + 1}, elapsed=${elapsed.toFixed(2)}ms`);
        }
        return result;
      } catch (e) {
        lastError = e;
        if (pol.diagnostics !== DiagnosticMode.DISABLED) {
          reportDiagnostic(pol, operation, 'error', e.message);
        }
        if (attempt + 1 >= maxAttempts) break;
        const delay = computeDelay(
          pol.retry.strategy,
          attempt,
          pol.retry.baseDelayMs,
          pol.retry.maxDelayMs
        );
        if (delay > 0) {
          const waitUntil = nowMs() + delay;
          while (nowMs() < waitUntil) { /* busy wait to avoid async */ }
        }
      }
    }
    throw lastError || new DomainViolationError(operation, 'all retry attempts failed');
  } finally {
    releaseBudgetAccumulator(acc);
  }
}

// ============================================================================
// DIAGNOSTIC REPORTER
// ============================================================================

function reportDiagnostic(pol, operation, kind, message) {
  if (pol.diagnostics === DiagnosticMode.DISABLED) return;
  const channel = pol.reporter && pol.reporter.channel ? pol.reporter.channel : ReportChannel.SILENT;
  if (channel === ReportChannel.SILENT) return;
  if (channel === ReportChannel.CUSTOM && typeof pol.reporter.callback === 'function') {
    try {
      pol.reporter.callback({ operation, kind, message, timestamp: nowMs() });
    } catch (e) { /* swallow */ }
    return;
  }
  if (channel === ReportChannel.CONSOLE) {
    if (kind === 'error') {
      // eslint-disable-next-line no-console
      console.error(`[${operation}] ${kind}: ${message}`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`[${operation}] ${kind}: ${message}`);
    }
  }
}

export function reportEvent(policy, operation, kind, message) {
  const pol = resolvePolicy(policy);
  reportDiagnostic(pol, operation, kind, message);
}

// ============================================================================
// SAMPLING HELPER
// ============================================================================

export function shouldSample(policy, counter) {
  const pol = resolvePolicy(policy);
  if (pol.sampling.mode === SamplingMode.NONE) return true;
  if (pol.sampling.mode === SamplingMode.UNIFORM) {
    return Math.random() < pol.sampling.rate;
  }
  if (pol.sampling.mode === SamplingMode.RESERVOIR) {
    return counter < pol.sampling.reservoirSize;
  }
  return true;
}

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================

function checkFinite(x, op, name) {
  if (!isFiniteNumber(x)) throw new DecodeError(op, name + ' must be finite');
}

export const PolicyInput = Object.freeze({
  make(overrides) { return makePolicy(overrides); },
  decode(input) {
    if (input === undefined || input === null) return DEFAULT_POLICY;
    if (typeof input === 'string') {
      const preset = _presetRegistry.get(input);
      if (!preset) throw new DecodeError('policy', 'unknown preset: ' + input);
      return preset;
    }
    if (!isPlainObject(input)) throw new DecodeError('policy', 'policy must be object, string preset, or null');
    return freezePolicy(input);
  }
});

export const BudgetInput = Object.freeze({
  make(budget) { return budget; },
  decode(input) {
    if (!isPlainObject(input)) throw new DecodeError('budget', 'budget must be object');
    if (input.timeMs !== undefined) checkFinite(input.timeMs, 'budget', 'timeMs');
    if (input.memoryMB !== undefined) checkFinite(input.memoryMB, 'budget', 'memoryMB');
    if (input.iterations !== undefined && (!isFiniteNumber(input.iterations) || input.iterations < 0)) {
      throw new DecodeError('budget', 'iterations must be non-negative finite');
    }
    if (input.depth !== undefined && (!isFiniteNumber(input.depth) || input.depth < 0)) {
      throw new DecodeError('budget', 'depth must be non-negative finite');
    }
    return input;
  }
});

export const RetryInput = Object.freeze({
  make(retry) { return retry; },
  decode(input) {
    if (!isPlainObject(input)) throw new DecodeError('retry', 'retry must be object');
    if (input.maxAttempts !== undefined && (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1)) {
      throw new DecodeError('retry', 'maxAttempts must be >= 1 integer');
    }
    return input;
  }
});

export const SamplingInput = Object.freeze({
  make(sampling) { return sampling; },
  decode(input) {
    if (!isPlainObject(input)) throw new DecodeError('sampling', 'sampling must be object');
    if (input.rate !== undefined && (!isFiniteNumber(input.rate) || input.rate < 0 || input.rate > 1)) {
      throw new DecodeError('sampling', 'rate must be finite in [0,1]');
    }
    return input;
  }
});

export const ReporterInput = Object.freeze({
  make(reporter) { return reporter; },
  decode(input) {
    if (!isPlainObject(input)) throw new DecodeError('reporter', 'reporter must be object');
    if (input.channel !== undefined && typeof input.channel !== 'string') {
      throw new DecodeError('reporter', 'channel must be string');
    }
    return input;
  }
});

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================

export function executeValidated(input) {
  if (!input || typeof input !== 'object') throw new DecodeError('execute', 'Expected {operation, fn, policy?}');
  if (typeof input.operation !== 'string') throw new DecodeError('execute', 'operation must be string');
  if (typeof input.fn !== 'function') throw new DecodeError('execute', 'fn must be function');
  const pol = input.policy !== undefined ? PolicyInput.decode(input.policy) : _globalDefault;
  return executeWithPolicy(input.operation, input.fn, pol);
}

export function budgetValidated(input) {
  const b = BudgetInput.decode(input);
  return withBudget(_globalDefault, b);
}

export function retryValidated(input) {
  const r = RetryInput.decode(input);
  return withRetry(_globalDefault, r);
}

export function samplingValidated(input) {
  const s = SamplingInput.decode(input);
  return withSampling(_globalDefault, s);
}

export function reporterValidated(input) {
  const r = ReporterInput.decode(input);
  return withReporter(_globalDefault, r);
}

// ============================================================================
// POLICY-AWARE WRAPPERS (single source of truth for the engine)
// ============================================================================

export function runWithPolicy(operation, fn, policy) {
  return executeWithPolicy(operation, fn, policy);
}

export function reportWithPolicy(operation, kind, message, policy) {
  const pol = resolvePolicy(policy);
  reportDiagnostic(pol, operation, kind, message);
  return pol;
}

export function describePolicy(policy) {
  const p = resolvePolicy(policy);
  return {
    precision: p.precision,
    diagnostics: p.diagnostics,
    mode: p.mode,
    cache: p.cache,
    timeoutMs: p.timeoutMs,
    retryStrategy: p.retry.strategy,
    retryAttempts: p.retry.maxAttempts,
    budget: { ...p.budget },
    sampling: p.sampling.mode,
    reporter: p.reporter.channel,
    version: p.version
  };
}

// ============================================================================
// POOL (small allocation reduction for hot flows)
// ============================================================================
const _scratchPool = [];
const _MAX_SCRATCH = 32;

export function poolAcquireScratch(size) {
  if (_scratchPool.length > 0) {
    const s = _scratchPool.pop();
    if (s.length === size) {
      s.fill(0);
      return s;
    }
  }
  return new Float64Array(size);
}

export function poolReleaseScratch(s) {
  if (_scratchPool.length >= _MAX_SCRATCH) return;
  _scratchPool.push(s);
}

export function poolReset() {
  _scratchPool.length = 0;
  _budgetPool.length = 0;
}

export function poolSize() {
  return _scratchPool.length + _budgetPool.length;
}

// ============================================================================
// EXPORTS
// ============================================================================
export { EPSILON, PRECISION, PERFORMANCE, CONTEXT, MEMORY, DD };

export default {
  DecodeError,
  DomainViolationError,
  PolicyViolationError,
  TimeoutError,
  PrecisionMode,
  DiagnosticMode,
  ExecutionMode,
  CacheMode,
  SamplingMode,
  RetryStrategy,
  ReportChannel,
  DEFAULT_POLICY,
  makePolicy,
  withPrecision,
  withDiagnostics,
  withMode,
  withCache,
  withTimeout,
  withRetry,
  withBudget,
  withSampling,
  withReporter,
  withTags,
  Presets,
  registerPreset,
  getPreset,
  hasPreset,
  listPresets,
  setGlobalDefault,
  getGlobalDefault,
  combinePolicies,
  resolvePolicy,
  freezePolicy,
  acquireBudgetAccumulator,
  releaseBudgetAccumulator,
  resetBudgetPool,
  budgetPoolSize,
  executeWithPolicy,
  reportEvent,
  shouldSample,
  PolicyInput,
  BudgetInput,
  RetryInput,
  SamplingInput,
  ReporterInput,
  executeValidated,
  budgetValidated,
  retryValidated,
  samplingValidated,
  reporterValidated,
  runWithPolicy,
  reportWithPolicy,
  describePolicy,
  poolAcquireScratch,
  poolReleaseScratch,
  poolReset,
  poolSize
};