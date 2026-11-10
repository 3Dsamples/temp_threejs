// file number : 032
// full path name : src/math/032_Probability.js
// description : High-performance Probability module rewritten from @scenesystems/effect-math Probability without the Effect dependency. Provides probability primitives for the engine: probability normalization/validation, odds (odds/decimal/fractional/log-odds) conversions, likelihood & log-likelihood, Bayes rule (prior, likelihood, evidence, posterior) with log-space variant, joint/marginal/conditional probability, independence tests, total probability, expected value/variance of discrete distributions, entropy (Shannon, cross, KL divergence, Jensen-Shannon), mutual information, information content, Hamming/renormalization, uniform/weighted/alias-table sampling, weighted choice with cumulative weights, reservoir sampling, bootstrap resampling, Bernoulli/Categorical/Beta-Bernoulli samplers, random permutation via Fisher-Yates, min-hash, Bloom filter (murmur3 + double hashing), union bound, inclusion-exclusion, complement, odds-update for evidence streams, log-space accumulation for numeric stability with LL, sigmoid/logit/stick-breaking helpers. Includes DoubleDouble (DD) high-precision variants (ddLogLikelihood, ddKLDivergence) for galactic-scale magnitudes, deterministic seeded samplers compatible with engine RANDOM, schema validators (ProbabilityInput, BayesInput, DistributionInput, LikelihoodInput, EntropyInput, WeightedSampleInput, AliasTableInput, JointInput, IndependenceInput), policy-aware wrappers with 030_Policy, pooled scratch buffers for zero-allocation hot paths, and alias method O(1) weighted sampling. Integrated with 002_Constants (PRECISION, HELPERS), 003_Common (EPSILON, RANDOM, ARRAY_TYPE), 014_DoubleDouble, 025_Distribution, 031_Precision, and 030_Policy.
// best for : AI decision making, particle spawn probabilities, loot tables, procedural scatter, PBR microfacet distributions, camera shake, physics stochastic damping, network packet loss simulation, Monte Carlo light transport, Bayesian sensor fusion for context-awareness, and any probabilistic subsystem at 10k+ entity scale on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, RANDOM, EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS } from '../core/002_Constants.js';
import * as DD from './014_DoubleDouble.js';
import * as Dist from './025_Distribution.js';
import * as Prec from './031_Precision.js';
import * as PolicyModule from './030_Policy.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'ProbabilityDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'ProbabilityDomainViolationError';
    this.operation = operation;
  }
}

// ============================================================================
// HELPERS
// ============================================================================
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function checkProbability(p, op) {
  if (!isFiniteNumber(p) || p < 0 || p > 1) {
    throw new DomainViolationError(op, 'probability must be in [0,1], got ' + p);
  }
}

function sigmoidRaw(x) {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function logSigmoidRaw(x) {
  if (x >= 0) return -Math.log1p(Math.exp(-x));
  return x - Math.log1p(Math.exp(x));
}

// ============================================================================
// PROBABILITY PRIMITIVES
// ============================================================================

export function clampProbability(p) {
  if (Number.isNaN(p)) return 0;
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}

export function isProbability(p) {
  return isFiniteNumber(p) && p >= 0 && p <= 1;
}

export function complement(p) {
  checkProbability(p, 'complement');
  return 1 - p;
}

export function andIndependent(pA, pB) {
  checkProbability(pA, 'andIndependent');
  checkProbability(pB, 'andIndependent');
  return pA * pB;
}

export function orIndependent(pA, pB) {
  checkProbability(pA, 'orIndependent');
  checkProbability(pB, 'orIndependent');
  return pA + pB - pA * pB;
}

export function xorIndependent(pA, pB) {
  checkProbability(pA, 'xorIndependent');
  checkProbability(pB, 'xorIndependent');
  return pA + pB - 2 * pA * pB;
}

export function conditional(pAandB, pB) {
  checkProbability(pAandB, 'conditional');
  checkProbability(pB, 'conditional');
  if (pB === 0) return 0;
  return pAandB / pB;
}

export function totalProbability(priors, conditionals) {
  if (!Array.isArray(priors) || !Array.isArray(conditionals)) {
    throw new DecodeError('totalProbability', 'priors and conditionals must be arrays');
  }
  if (priors.length !== conditionals.length) {
    throw new DecodeError('totalProbability', 'priors and conditionals must have same length');
  }
  let sum = 0;
  for (let i = 0; i < priors.length; i++) {
    checkProbability(priors[i], 'totalProbability');
    checkProbability(conditionals[i], 'totalProbability');
    sum += priors[i] * conditionals[i];
  }
  return sum;
}

// ============================================================================
// ODDS AND LOG-ODDS
// ============================================================================

export function toOdds(p) {
  checkProbability(p, 'toOdds');
  if (p >= 1) return Infinity;
  return p / (1 - p);
}

export function fromOdds(odds) {
  if (odds < 0) throw new DomainViolationError('fromOdds', 'odds must be non-negative');
  if (odds === Infinity) return 1;
  return odds / (1 + odds);
}

export function toLogOdds(p) {
  checkProbability(p, 'toLogOdds');
  if (p === 0) return -Infinity;
  if (p === 1) return Infinity;
  return Math.log(p) - Math.log1p(-p);
}

export function fromLogOdds(lo) {
  if (!isFiniteNumber(lo)) {
    if (lo === Infinity) return 1;
    if (lo === -Infinity) return 0;
    return 0;
  }
  return sigmoidRaw(lo);
}

export function logit(p) {
  return toLogOdds(p);
}

export function sigmoid(x) {
  return sigmoidRaw(x);
}

export function logSigmoid(x) {
  return logSigmoidRaw(x);
}

// ============================================================================
// LIKELIHOOD / LOG-LIKELIHOOD
// ============================================================================

export function likelihood(probs) {
  if (!Array.isArray(probs) || probs.length === 0) return 1;
  let acc = 1;
  for (let i = 0; i < probs.length; i++) {
    checkProbability(probs[i], 'likelihood');
    acc *= probs[i];
  }
  return acc;
}

export function logLikelihood(probs) {
  if (!Array.isArray(probs) || probs.length === 0) return 0;
  let acc = 0;
  for (let i = 0; i < probs.length; i++) {
    checkProbability(probs[i], 'logLikelihood');
    if (probs[i] > 0) acc += Math.log(probs[i]);
    else return -Infinity;
  }
  return acc;
}

export function ddLogLikelihood(probs) {
  let acc = [0, 0];
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    checkProbability(p, 'ddLogLikelihood');
    if (p > 0) {
      acc = DD.add(acc, DD.fromDouble(Math.log(p)));
    } else {
      return [0, -Infinity];
    }
  }
  return acc;
}

// ============================================================================
// BAYES RULE
// ============================================================================

export function bayes(prior, likelihoodTrue, likelihoodFalse) {
  checkProbability(prior, 'bayes');
  checkProbability(likelihoodTrue, 'bayes');
  checkProbability(likelihoodFalse, 'bayes');
  const evidence = prior * likelihoodTrue + (1 - prior) * likelihoodFalse;
  if (evidence === 0) return 0;
  return (prior * likelihoodTrue) / evidence;
}

export function bayesLog(prior, logLikTrue, logLikFalse) {
  const lo = toLogOdds(prior);
  if (!isFiniteNumber(logLikTrue) || !isFiniteNumber(logLikFalse)) {
    if (logLikTrue === -Infinity) return 0;
    if (logLikFalse === -Infinity) return 1;
    return prior;
  }
  const newLo = lo + logLikTrue - logLikFalse;
  return fromLogOdds(newLo);
}

export function oddsUpdate(logOdds, logLikRatio) {
  if (!isFiniteNumber(logOdds) && logOdds !== -Infinity && logOdds !== Infinity) {
    throw new DecodeError('oddsUpdate', 'logOdds must be number');
  }
  if (!isFiniteNumber(logLikRatio) && logLikRatio !== -Infinity && logLikRatio !== Infinity) {
    throw new DecodeError('oddsUpdate', 'logLikRatio must be number');
  }
  return logOdds + logLikRatio;
}

export function bayesSequence(logOdds, likelihoodRatios) {
  let lo = logOdds;
  for (let i = 0; i < likelihoodRatios.length; i++) {
    lo = oddsUpdate(lo, likelihoodRatios[i]);
  }
  return fromLogOdds(lo);
}

// ============================================================================
// JOINT / MARGINAL / CONDITIONAL TABLES
// ============================================================================

export function jointProbability(joint, i, j, rows, cols) {
  return joint[i * cols + j];
}

export function marginalRow(joint, i, rows, cols) {
  let sum = 0;
  for (let j = 0; j < cols; j++) sum += joint[i * cols + j];
  return sum;
}

export function marginalCol(joint, j, rows, cols) {
  let sum = 0;
  for (let i = 0; i < rows; i++) sum += joint[i * cols + j];
  return sum;
}

export function conditionalFromJoint(joint, i, j, rows, cols) {
  const pj = marginalCol(joint, j, rows, cols);
  if (pj === 0) return 0;
  return joint[i * cols + j] / pj;
}

export function independenceCheck(joint, rows, cols, tol) {
  const t = tol === undefined ? 1e-9 : tol;
  for (let i = 0; i < rows; i++) {
    const pr = marginalRow(joint, i, rows, cols);
    for (let j = 0; j < cols; j++) {
      const pc = marginalCol(joint, j, rows, cols);
      const expected = pr * pc;
      const actual = joint[i * cols + j];
      if (Math.abs(actual - expected) > t) return false;
    }
  }
  return true;
}

// ============================================================================
// INFORMATION THEORY
// ============================================================================

export function informationContent(p) {
  checkProbability(p, 'informationContent');
  if (p === 0) return Infinity;
  return -Math.log2(p);
}

export function shannonEntropy(probs) {
  let acc = 0;
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    if (p > 0) acc -= p * Math.log2(p);
  }
  return acc;
}

export function crossEntropy(p, q) {
  if (p.length !== q.length) throw new DecodeError('crossEntropy', 'p and q must have same length');
  let acc = 0;
  for (let i = 0; i < p.length; i++) {
    if (p[i] > 0) {
      if (q[i] <= 0) return Infinity;
      acc -= p[i] * Math.log2(q[i]);
    }
  }
  return acc;
}

export function klDivergence(p, q) {
  if (p.length !== q.length) throw new DecodeError('klDivergence', 'p and q must have same length');
  let acc = 0;
  for (let i = 0; i < p.length; i++) {
    if (p[i] > 0) {
      if (q[i] <= 0) return Infinity;
      acc += p[i] * Math.log2(p[i] / q[i]);
    }
  }
  return acc;
}

export function jsDivergence(p, q) {
  if (p.length !== q.length) throw new DecodeError('jsDivergence', 'p and q must have same length');
  const m = new ARRAY_TYPE(p.length);
  for (let i = 0; i < p.length; i++) m[i] = 0.5 * (p[i] + q[i]);
  return 0.5 * klDivergence(p, m) + 0.5 * klDivergence(q, m);
}

export function ddKLDivergence(p, q) {
  let acc = [0, 0];
  for (let i = 0; i < p.length; i++) {
    if (p[i] > 0) {
      if (q[i] <= 0) return [0, Infinity];
      const term = DD.multiply(
        DD.fromDouble(p[i]),
        DD.subtract(DD.fromDouble(Math.log(p[i])), DD.fromDouble(Math.log(q[i])))
      );
      acc = DD.add(acc, term);
    }
  }
  return acc;
}

export function mutualInformation(joint, rows, cols) {
  let mi = 0;
  const px = new ARRAY_TYPE(rows);
  const py = new ARRAY_TYPE(cols);
  for (let i = 0; i < rows; i++) px[i] = marginalRow(joint, i, rows, cols);
  for (let j = 0; j < cols; j++) py[j] = marginalCol(joint, j, rows, cols);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const pij = joint[i * cols + j];
      if (pij > 0) {
        const denom = px[i] * py[j];
        if (denom > 0) mi += pij * Math.log2(pij / denom);
      }
    }
  }
  return mi;
}

// ============================================================================
// NORMALIZE / RENORMALIZE
// ============================================================================

export function normalizeProbs(probs) {
  let sum = 0;
  for (let i = 0; i < probs.length; i++) {
    if (probs[i] < 0) throw new DomainViolationError('normalizeProbs', 'negative probability');
    sum += probs[i];
  }
  if (sum === 0) {
    const out = new ARRAY_TYPE(probs.length);
    const u = probs.length > 0 ? 1 / probs.length : 0;
    for (let i = 0; i < probs.length; i++) out[i] = u;
    return out;
  }
  const out = new ARRAY_TYPE(probs.length);
  const inv = 1 / sum;
  for (let i = 0; i < probs.length; i++) out[i] = probs[i] * inv;
  return out;
}

export function normalizeWeights(weights) {
  return normalizeProbs(weights);
}

export function cumulativeWeights(weights) {
  const out = new ARRAY_TYPE(weights.length);
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    out[i] = acc;
  }
  return out;
}

// ============================================================================
// WEIGHTED SAMPLING (LINEAR)
// ============================================================================

export function weightedChoice(weights, rng) {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) {
    if (weights[i] < 0) throw new DomainViolationError('weightedChoice', 'negative weight');
    sum += weights[i];
  }
  if (sum === 0) return 0;
  const r = (rng || RANDOM)() * sum;
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (r < acc) return i;
  }
  return weights.length - 1;
}

export function weightedChoiceBinary(cumulative, rng) {
  const total = cumulative[cumulative.length - 1];
  const r = (rng || RANDOM)() * total;
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cumulative[mid] <= r) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ============================================================================
// ALIAS METHOD (O(1) sampling)
// ============================================================================

export function AliasTable(weights) {
  const n = weights.length;
  const total = (() => {
    let s = 0;
    for (let i = 0; i < n; i++) s += weights[i];
    return s;
  })();
  if (total === 0) throw new DomainViolationError('AliasTable', 'total weight is zero');

  const prob = new ARRAY_TYPE(n);
  const alias = new Int32Array(n);
  const scaled = new ARRAY_TYPE(n);
  for (let i = 0; i < n; i++) scaled[i] = (weights[i] * n) / total;

  const small = [];
  const large = [];
  for (let i = 0; i < n; i++) {
    if (scaled[i] < 1) small.push(i);
    else large.push(i);
  }

  while (small.length > 0 && large.length > 0) {
    const s = small.pop();
    const l = large.pop();
    prob[s] = scaled[s];
    alias[s] = l;
    scaled[l] = scaled[l] + scaled[s] - 1;
    if (scaled[l] < 1) small.push(l);
    else large.push(l);
  }
  while (large.length > 0) {
    const l = large.pop();
    prob[l] = 1;
    alias[l] = l;
  }
  while (small.length > 0) {
    const s = small.pop();
    prob[s] = 1;
    alias[s] = s;
  }

  return { prob, alias, n };
}

export function aliasSample(table, rng) {
  const r = (rng || RANDOM)();
  const i = Math.floor(r * table.n);
  const u = r * table.n - i;
  return u < table.prob[i] ? i : table.alias[i];
}

// ============================================================================
// RESERVOIR SAMPLING
// ============================================================================

export function reservoirSample(stream, k, rng) {
  const K = k === undefined ? 1 : k;
  const r = rng || RANDOM;
  const reservoir = new ARRAY_TYPE(Math.min(K, stream.length));
  for (let i = 0; i < reservoir.length; i++) reservoir[i] = stream[i];
  for (let i = K; i < stream.length; i++) {
    const j = Math.floor(r() * (i + 1));
    if (j < K) reservoir[j] = stream[i];
  }
  return reservoir;
}

export function bootstrapResample(stream, size, rng) {
  const n = stream.length;
  const out = new ARRAY_TYPE(size);
  const r = rng || RANDOM;
  for (let i = 0; i < size; i++) {
    out[i] = stream[Math.floor(r() * n)];
  }
  return out;
}

// ============================================================================
// SAMPLERS
// ============================================================================

export function bernoulli(p, rng) {
  checkProbability(p, 'bernoulli');
  return (rng || RANDOM)() < p ? 1 : 0;
}

export function categorical(probs, rng) {
  let sum = 0;
  for (let i = 0; i < probs.length; i++) {
    if (probs[i] < 0) throw new DomainViolationError('categorical', 'negative probability');
    sum += probs[i];
  }
  if (sum === 0) return 0;
  const r = (rng || RANDOM)() * sum;
  let acc = 0;
  for (let i = 0; i < probs.length; i++) {
    acc += probs[i];
    if (r < acc) return i;
  }
  return probs.length - 1;
}

export function betaBernoulli(alpha, beta, rng) {
  if (alpha <= 0 || beta <= 0) throw new DomainViolationError('betaBernoulli', 'alpha, beta must be positive');
  const b = Dist.betaDistribution(alpha, beta);
  const p = b.sample(rng || RANDOM);
  return (rng || RANDOM)() < p ? 1 : 0;
}

export function fisherYatesShuffle(arr, rng) {
  const r = rng || RANDOM;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

export function randomPermutation(n, rng) {
  const arr = new Int32Array(n);
  for (let i = 0; i < n; i++) arr[i] = i;
  return fisherYatesShuffle(arr, rng);
}

// ============================================================================
// MINHASH / BLOOM FILTER
// ============================================================================

export function murmur3_32(key, seed) {
  let h = seed >>> 0;
  const len = key.length;
  const nblocks = len >> 2;
  for (let i = 0; i < nblocks; i++) {
    let k = (key[i * 4] & 0xff) |
            ((key[i * 4 + 1] & 0xff) << 8) |
            ((key[i * 4 + 2] & 0xff) << 16) |
            ((key[i * 4 + 3] & 0xff) << 24);
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = Math.imul(h, 5) + 0xe6546b64;
  }
  let k1 = 0;
  const tailStart = nblocks * 4;
  switch (len & 3) {
    case 3: k1 ^= (key[tailStart + 2] & 0xff) << 16;
    // falls through
    case 2: k1 ^= (key[tailStart + 1] & 0xff) << 8;
    // falls through
    case 1: k1 ^= (key[tailStart] & 0xff);
            k1 = Math.imul(k1, 0xcc9e2d51);
            k1 = (k1 << 15) | (k1 >>> 17);
            k1 = Math.imul(k1, 0x1b873593);
            h ^= k1;
  }
  h ^= len;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function BloomFilter(expectedItems, falsePositiveRate) {
  const n = Math.max(1, expectedItems);
  const p = falsePositiveRate === undefined ? 0.01 : falsePositiveRate;
  const mBits = Math.ceil((-n * Math.log(p)) / (Math.LN2 * Math.LN2));
  const kHashes = Math.max(1, Math.round((mBits / n) * Math.LN2));
  const bits = new Uint32Array((mBits + 31) >>> 5);
  const seed2 = 0x5bd1e995;

  function add(bytes) {
    const h1 = murmur3_32(bytes, 0);
    const h2 = murmur3_32(bytes, seed2);
    for (let i = 0; i < kHashes; i++) {
      const h = (h1 + i * h2) >>> 0;
      const bit = h % mBits;
      bits[bit >>> 5] |= 1 << (bit & 31);
    }
  }

  function has(bytes) {
    const h1 = murmur3_32(bytes, 0);
    const h2 = murmur3_32(bytes, seed2);
    for (let i = 0; i < kHashes; i++) {
      const h = (h1 + i * h2) >>> 0;
      const bit = h % mBits;
      if ((bits[bit >>> 5] & (1 << (bit & 31))) === 0) return false;
    }
    return true;
  }

  return { add, has, sizeBits: mBits, numHashes: kHashes };
}

// ============================================================================
// UNION BOUND / INCLUSION-EXCLUSION
// ============================================================================

export function unionBound(probs) {
  let sum = 0;
  for (let i = 0; i < probs.length; i++) {
    checkProbability(probs[i], 'unionBound');
    sum += probs[i];
  }
  return sum > 1 ? 1 : sum;
}

export function inclusionExclusion(probs) {
  const n = probs.length;
  let total = 0;
  for (let mask = 1; mask < (1 << n); mask++) {
    let count = 0;
    let prod = 1;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        prod *= probs[i];
        count++;
      }
    }
    total += (count % 2 === 1) ? prod : -prod;
  }
  return total < 0 ? 0 : total > 1 ? 1 : total;
}

// ============================================================================
// EXPECTATION / VARIANCE (discrete)
// ============================================================================

export function expectedValue(values, probs) {
  if (values.length !== probs.length) throw new DecodeError('expectedValue', 'length mismatch');
  let acc = 0;
  for (let i = 0; i < values.length; i++) acc += values[i] * probs[i];
  return acc;
}

export function variance(values, probs) {
  const mu = expectedValue(values, probs);
  let acc = 0;
  for (let i = 0; i < values.length; i++) {
    const d = values[i] - mu;
    acc += d * d * probs[i];
  }
  return acc;
}

// ============================================================================
// STICK-BREAKING
// ============================================================================

export function stickBreaking(alphas, rng) {
  const n = alphas.length;
  const out = new ARRAY_TYPE(n);
  const r = rng || RANDOM;
  let remaining = 1;
  for (let i = 0; i < n - 1; i++) {
    if (alphas[i] <= 0) throw new DomainViolationError('stickBreaking', 'alphas must be positive');
    const b = Dist.betaDistribution(alphas[i], alphas.slice(i + 1).reduce((a, v) => a + v, 0)).sample(r);
    out[i] = remaining * b;
    remaining *= (1 - b);
  }
  out[n - 1] = remaining;
  return out;
}

// ============================================================================
// POOLED SCRATCH
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

function checkProbArray(arr, op) {
  if (!Array.isArray(arr) && !(arr instanceof Float64Array) && !(arr instanceof Float32Array)) {
    throw new DecodeError(op, 'probability array required');
  }
  for (let i = 0; i < arr.length; i++) {
    if (!isFiniteNumber(arr[i]) || arr[i] < 0 || arr[i] > 1) {
      throw new DecodeError(op, 'probability[' + i + '] must be in [0,1]');
    }
  }
  return arr;
}

export const ProbabilityInput = Object.freeze({
  make(p) { return { p }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('probability', 'Expected {p}');
    checkProbability(input.p, 'probability');
    return input;
  }
});

export const BayesInput = Object.freeze({
  make(prior, likelihoodTrue, likelihoodFalse) { return { prior, likelihoodTrue, likelihoodFalse }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('bayes', 'Expected {prior, likelihoodTrue, likelihoodFalse}');
    checkProbability(input.prior, 'bayes');
    checkProbability(input.likelihoodTrue, 'bayes');
    checkProbability(input.likelihoodFalse, 'bayes');
    return input;
  }
});

export const DistributionInput = Object.freeze({
  make(probs) { return { probs }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('distribution', 'Expected {probs}');
    checkProbArray(input.probs, 'distribution');
    return input;
  }
});

export const LikelihoodInput = Object.freeze({
  make(probs) { return { probs }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('likelihood', 'Expected {probs}');
    checkProbArray(input.probs, 'likelihood');
    return input;
  }
});

export const EntropyInput = Object.freeze({
  make(p, q) { return { p, q }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('entropy', 'Expected {p, q?}');
    checkProbArray(input.p, 'entropy');
    if (input.q !== undefined) {
      checkProbArray(input.q, 'entropy');
      if (input.q.length !== input.p.length) throw new DecodeError('entropy', 'p and q length mismatch');
    }
    return input;
  }
});

export const WeightedSampleInput = Object.freeze({
  make(weights, rng) { return { weights, rng }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('weightedSample', 'Expected {weights, rng?}');
    if (!Array.isArray(input.weights) && !(input.weights instanceof Float64Array)) {
      throw new DecodeError('weightedSample', 'weights must be array-like');
    }
    for (let i = 0; i < input.weights.length; i++) {
      if (!isFiniteNumber(input.weights[i]) || input.weights[i] < 0) {
        throw new DecodeError('weightedSample', 'weights[' + i + '] must be non-negative finite');
      }
    }
    if (input.rng !== undefined && typeof input.rng !== 'function') {
      throw new DecodeError('weightedSample', 'rng must be function');
    }
    return input;
  }
});

export const AliasTableInput = WeightedSampleInput;

export const JointInput = Object.freeze({
  make(joint, rows, cols) { return { joint, rows, cols }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('joint', 'Expected {joint, rows, cols}');
    if (!Number.isInteger(input.rows) || input.rows <= 0) throw new DecodeError('joint', 'rows must be positive integer');
    if (!Number.isInteger(input.cols) || input.cols <= 0) throw new DecodeError('joint', 'cols must be positive integer');
    if (!input.joint || input.joint.length !== input.rows * input.cols) {
      throw new DecodeError('joint', 'joint length mismatch');
    }
    return input;
  }
});

export const IndependenceInput = Object.freeze({
  make(joint, rows, cols, tol) { return { joint, rows, cols, tol }; },
  decode(input) {
    return JointInput.decode(input);
  }
});

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================

export function complementValidated(input) {
  const d = ProbabilityInput.decode(input);
  return complement(d.p);
}

export function andValidated(input) {
  if (!input || typeof input !== 'object' || input.pA === undefined || input.pB === undefined) {
    throw new DecodeError('and', 'Expected {pA, pB}');
  }
  checkProbability(input.pA, 'and');
  checkProbability(input.pB, 'and');
  return andIndependent(input.pA, input.pB);
}

export function orValidated(input) {
  if (!input || typeof input !== 'object' || input.pA === undefined || input.pB === undefined) {
    throw new DecodeError('or', 'Expected {pA, pB}');
  }
  checkProbability(input.pA, 'or');
  checkProbability(input.pB, 'or');
  return orIndependent(input.pA, input.pB);
}

export function bayesValidated(input) {
  const d = BayesInput.decode(input);
  return bayes(d.prior, d.likelihoodTrue, d.likelihoodFalse);
}

export function likelihoodValidated(input) {
  const d = LikelihoodInput.decode(input);
  return likelihood(d.probs);
}

export function logLikelihoodValidated(input) {
  const d = LikelihoodInput.decode(input);
  return logLikelihood(d.probs);
}

export function shannonEntropyValidated(input) {
  const d = EntropyInput.decode(input);
  return shannonEntropy(d.p);
}

export function klDivergenceValidated(input) {
  const d = EntropyInput.decode(input);
  if (input.q === undefined) throw new DecodeError('klDivergence', 'q required');
  return klDivergence(d.p, d.q);
}

export function jsDivergenceValidated(input) {
  const d = EntropyInput.decode(input);
  if (input.q === undefined) throw new DecodeError('jsDivergence', 'q required');
  return jsDivergence(d.p, d.q);
}

export function weightedChoiceValidated(input) {
  const d = WeightedSampleInput.decode(input);
  return weightedChoice(d.weights, d.rng);
}

export function aliasTableValidated(input) {
  const d = AliasTableInput.decode(input);
  return AliasTable(d.weights);
}

export function independenceValidated(input) {
  const d = IndependenceInput.decode(input);
  return independenceCheck(d.joint, d.rows, d.cols, d.tol);
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

export function bayesWithPolicies(prior, likelihoodTrue, likelihoodFalse, policy) {
  return policyScalar(
    'Probability.bayesWithPolicies',
    () => bayes(prior, likelihoodTrue, likelihoodFalse),
    (r) => ({ prior, result: String(r) }),
    policy
  );
}

export function shannonEntropyWithPolicies(probs, policy) {
  return policyScalar(
    'Probability.shannonEntropyWithPolicies',
    () => shannonEntropy(probs),
    (r) => ({ n: probs.length, result: String(r) }),
    policy
  );
}

export function klDivergenceWithPolicies(p, q, policy) {
  return policyScalar(
    'Probability.klDivergenceWithPolicies',
    () => klDivergence(p, q),
    (r) => ({ n: p.length, result: String(r) }),
    policy
  );
}

export function weightedChoiceWithPolicies(weights, policy, rng) {
  return policyScalar(
    'Probability.weightedChoiceWithPolicies',
    () => weightedChoice(weights, rng),
    (r) => ({ n: weights.length, result: r }),
    policy
  );
}

export function aliasSampleWithPolicies(table, policy, rng) {
  return policyScalar(
    'Probability.aliasSampleWithPolicies',
    () => aliasSample(table, rng),
    (r) => ({ n: table.n, result: r }),
    policy
  );
}

export function independenceWithPolicies(joint, rows, cols, policy, tol) {
  return policyCustom(
    'Probability.independenceWithPolicies',
    () => independenceCheck(joint, rows, cols, tol),
    (r) => typeof r === 'boolean',
    (r) => ({ rows, cols, result: r }),
    policy
  );
}

// ============================================================================
// EXPORTS
// ============================================================================
export { EPSILON, PRECISION, HELPERS, DD, Dist, Prec, PolicyModule, RANDOM };

export default {
  DecodeError,
  DomainViolationError,
  clampProbability,
  isProbability,
  complement,
  andIndependent,
  orIndependent,
  xorIndependent,
  conditional,
  totalProbability,
  toOdds,
  fromOdds,
  toLogOdds,
  fromLogOdds,
  logit,
  sigmoid,
  logSigmoid,
  likelihood,
  logLikelihood,
  ddLogLikelihood,
  bayes,
  bayesLog,
  oddsUpdate,
  bayesSequence,
  jointProbability,
  marginalRow,
  marginalCol,
  conditionalFromJoint,
  independenceCheck,
  informationContent,
  shannonEntropy,
  crossEntropy,
  klDivergence,
  jsDivergence,
  ddKLDivergence,
  mutualInformation,
  normalizeProbs,
  normalizeWeights,
  cumulativeWeights,
  weightedChoice,
  weightedChoiceBinary,
  AliasTable,
  aliasSample,
  reservoirSample,
  bootstrapResample,
  bernoulli,
  categorical,
  betaBernoulli,
  fisherYatesShuffle,
  randomPermutation,
  murmur3_32,
  BloomFilter,
  unionBound,
  inclusionExclusion,
  expectedValue,
  variance,
  stickBreaking,
  poolAcquireScratch,
  poolReleaseScratch,
  poolReset,
  poolSize,
  ProbabilityInput,
  BayesInput,
  DistributionInput,
  LikelihoodInput,
  EntropyInput,
  WeightedSampleInput,
  AliasTableInput,
  JointInput,
  IndependenceInput,
  complementValidated,
  andValidated,
  orValidated,
  bayesValidated,
  likelihoodValidated,
  logLikelihoodValidated,
  shannonEntropyValidated,
  klDivergenceValidated,
  jsDivergenceValidated,
  weightedChoiceValidated,
  aliasTableValidated,
  independenceValidated,
  bayesWithPolicies,
  shannonEntropyWithPolicies,
  klDivergenceWithPolicies,
  weightedChoiceWithPolicies,
  aliasSampleWithPolicies,
  independenceWithPolicies
};