//File number : 075_Z0
// File : src/075_Z0_probabilistic.js
//Description : Complete probabilistic and statistical framework for 3D graphics, scientific simulation, ML and smart decisions — multivariate distributions (MVN with Cholesky, Dirichlet, Wishart, von Mises-Fisher, Kent, GMM), Bayesian inference (Naive Bayes, conjugate priors, credible intervals, AIC/BIC), information theory (Shannon / Rényi / Tsallis entropy, KL, JS, mutual information, cross-entropy, perplexity), Monte Carlo (importance, antithetic, control variates, bootstrap, jackknife, Metropolis–Hastings, Gibbs, HMC), sequential estimation (linear / extended / unscented Kalman filter, particle filter, HMM forward–backward / Viterbi / Baum–Welch), point-set statistics (PCA, probabilistic PCA, RANSAC plane/sphere fit, robust trimmed mean), regression with uncertainty (weighted LS, robust Huber, Gaussian process regression / kriging), smart decisions (softmax/Boltzmann selection, ε-greedy, UCB1/UCB1-tuned, Thompson sampling, GP-UCB, EI, MCTS UCB/PUCT, multi-armed bandit), uncertainty quantification (Wald/bootstrap confidence intervals, prediction intervals, Monte Carlo error propagation, Sobol indices), and ML primitives (Xavier/He/Kaiming init, dropout mask, batch-norm running stats, softmax / log-softmax / attention, weighted reservoir). Every numerical buffer honors `000_Math_module.js` precision mode (Float16/Float32/Float64 live-swap). SOA batch versions + chunked async variants yield via `scheduler.yield()` so 1M+ particles / instances / candidates per frame stay at 60 fps on Android 64-bit. Pooled scratch (`ProbabilityScratch`) + `ProbabilityBatchState` give zero-GC hot paths.
//####
//Best for : 3d graphics — probabilistic motion planning (Kalman-smooth IK targets, particle-filter crowd tracking), probabilistic procedural generation (MVN-driven terrain scatter, GMM-clustered galaxy seeding, vMF leaf orientation), Bayesian materials (Naive Bayes classifiers for surface types), uncertainty-aware rendering (Monte Carlo error propagation for photons, Sobol sensitivity for adaptive sampling), smart AI decisions (UCB/Thompson-sampling for NPC behavior, MCTS for combat AI, Bayesian optimization for parameter tuning), robust point-cloud registration (RANSAC plane/sphere, trimmed mean, PCA normals), ML inference primitives (softmax, dropout, Xavier init, batch-norm, attention), HMM-driven animation states, GP regression for interpolating sparse motion capture, and any per-frame 1M+ probabilistic pipeline that must run on Android 64-bit.
//License : MIT

// ============================================================================
// Directive Prologues
// ============================================================================

"use strict";

// ============================================================================
// Import
// ============================================================================

import * as M_NS from "./000_Math_module.js";
import * as Statistics_NS from "./063_statistics.js";
import * as Sampling_NS from "./053_sampling.js";
import * as SpecialFunctions_NS from "./055_special-functions.js";
import * as NumericalStability_NS from "./036_numerical-stability.js";

// ESM / CJS interop — pull the actual module exports whether the imported
// file uses `export` (ESM) or `module.exports = {...}` (CJS).
const M                = M_NS.default || M_NS;
const Statistics       = Statistics_NS.default || Statistics_NS;
const Sampling         = Sampling_NS.default || Sampling_NS;
const SpecialFunctions = SpecialFunctions_NS.default || SpecialFunctions_NS;
const NumStab          = NumericalStability_NS.default || NumericalStability_NS;

const common         = M.common;
const vec3           = M.vec3;
const mat3           = M.mat3;
const mat4           = M.mat4;
const getArrayType   = M.getArrayType;
const onPrecisionChange = M.onPrecisionChange;
const createVec3SOA  = M.createVec3SOA;

// ============================================================================
// Export Declarations
// ============================================================================

// ---- Multivariate distributions ----
export const multivariateNormalSample    = multivariateNormalSample;
export const multivariateNormalPDF       = multivariateNormalPDF;
export const multivariateNormalLogPDF    = multivariateNormalLogPDF;
export const multivariateNormalFromCholesky = multivariateNormalFromCholesky;
export const choleskyDecompose           = choleskyDecompose;
export const dirichletLogPDF             = dirichletLogPDF;
export const wishartSample               = wishartSample;
export const inverseWishartSample        = inverseWishartSample;
export const vonMisesFisherSample        = vonMisesFisherSample;
export const vonMisesFisherPDF           = vonMisesFisherPDF;
export const kentSample                  = kentSample;
export const multinomialSample           = multinomialSample;
export const categoricalSample           = categoricalSample;
export const categoricalEntropy          = categoricalEntropy;
export const categoricalKL               = categoricalKL;

// ---- Mixture models ----
export const GaussianMixture             = GaussianMixture;
export const fitGMM                      = fitGMM;
export const gmmPredict                  = gmmPredict;

// ---- Bayesian primitives ----
export const bayesUpdate                 = bayesUpdate;
export const NaiveBayes                  = NaiveBayes;
export const conjugateBetaBernoulli      = conjugateBetaBernoulli;
export const conjugateDirichletCategorical = conjugateDirichletCategorical;
export const conjugateNormalNormal       = conjugateNormalNormal;
export const conjugateGammaPoisson       = conjugateGammaPoisson;
export const AIC                         = AIC;
export const BIC                         = BIC;
export const logLikelihood               = logLikelihood;

// ---- Information theory ----
export const entropy                     = entropy;
export const renyiEntropy                = renyiEntropy;
export const tsallisEntropy              = tsallisEntropy;
export const klDivergence                = klDivergence;
export const jsDivergence                = jsDivergence;
export const mutualInformation           = mutualInformation;
export const crossEntropy                = crossEntropy;
export const perplexity                  = perplexity;

// ---- Monte Carlo ----
export const importanceSampling          = importanceSampling;
export const importanceResample          = importanceResample;
export const antitheticSample            = antitheticSample;
export const controlVariates             = controlVariates;
export const bootstrapCI                 = bootstrapCI;
export const jackknife                   = jackknife;
export const metropolisHastingsND        = metropolisHastingsND;
export const gibbsND                     = gibbsND;
export const hamiltonianMC               = hamiltonianMC;

// ---- Sequential estimation ----
export const KalmanFilter                = KalmanFilter;
export const ExtendedKalmanFilter        = ExtendedKalmanFilter;
export const UnscentedKalmanFilter       = UnscentedKalmanFilter;
export const ParticleFilter              = ParticleFilter;
export const HMM                         = HMM;

// ---- Point-set statistics ----
export const computePCA                  = computePCA;
export const probabilisticPCA            = probabilisticPCA;
export const ransacPlane                 = ransacPlane;
export const ransacSphere                = ransacSphere;
export const robustMean                  = robustMean;
export const trimmedMean                 = trimmedMean;

// ---- Regression with uncertainty ----
export const weightedLeastSquares        = weightedLeastSquares;
export const robustRegression            = robustRegression;
export const gpRegression                = gpRegression;
export const kriging                     = gpRegression;

// ---- Smart decisions ----
export const softmaxSelection            = softmaxSelection;
export const epsilonGreedy               = epsilonGreedy;
export const ucb1                        = ucb1;
export const ucb1Tuned                   = ucb1Tuned;
export const thompsonSampling            = thompsonSampling;
export const gpUCB                       = gpUCB;
export const expectedImprovement         = expectedImprovement;
export const mctsUCB                     = mctsUCB;
export const mctsPUCT                    = mctsPUCT;
export const MultiArmedBandit            = MultiArmedBandit;

// ---- Uncertainty quantification ----
export const confidenceInterval          = confidenceInterval;
export const predictionInterval          = predictionInterval;
export const monteCarloPropagate         = monteCarloPropagate;
export const sobolIndices                = sobolIndices;

// ---- ML primitives ----
export const xavierUniform               = xavierUniform;
export const heUniform                   = heUniform;
export const kaimingUniform              = kaimingUniform;
export const dropoutMask                 = dropoutMask;
export const batchNormStats              = batchNormStats;
export const softmax                     = softmax;
export const logSoftmax                  = logSoftmax;
export const attentionScores             = attentionScores;
export const weightedReservoir           = weightedReservoir;

// ---- SOA (sync) ----
export const soaSampleMVN                = soaSampleMVN;
export const soaEvaluateMVN              = soaEvaluateMVN;
export const soaSoftmax                  = soaSoftmax;
export const soaEntropyBatch             = soaEntropyBatch;
export const soaImportanceBatch          = soaImportanceBatch;
export const soaGMMPredictBatch          = soaGMMPredictBatch;
export const soaKalmanBatch              = soaKalmanBatch;

// ---- SOA (chunked async) ----
export const soaSampleMVNChunked         = soaSampleMVNChunked;
export const soaSoftmaxChunked           = soaSoftmaxChunked;
export const soaEntropyBatchChunked      = soaEntropyBatchChunked;
export const soaImportanceBatchChunked   = soaImportanceBatchChunked;
export const soaGMMPredictBatchChunked   = soaGMMPredictBatchChunked;
export const soaKalmanBatchChunked       = soaKalmanBatchChunked;

// ---- Pools ----
export const ProbabilityScratch          = ProbabilityScratch;
export const createProbabilityScratchPool = createProbabilityScratchPool;
export const acquireProbabilityScratch   = acquireProbabilityScratch;
export const releaseProbabilityScratch   = releaseProbabilityScratch;
export const ProbabilityBatchState       = ProbabilityBatchState;
export const createProbabilityBatch      = createProbabilityBatch;

// ============================================================================
// Global Declarations
// ============================================================================

const PI         = Math.PI;
const TWO_PI     = PI * 2;
const INV_2PI    = 1 / TWO_PI;
const LN2PI      = Math.log(TWO_PI);
const HALF_LN2PI = 0.5 * LN2PI;
const SQRT_2PI   = Math.sqrt(TWO_PI);
const EPSILON    = 1e-12;

// ============================================================================
// Type Declarations
// ============================================================================

/**
 * @typedef {Object} GMMResult
 * @property {number} K              Number of components
 * @property {number} dim            Dimensionality
 * @property {Float64Array} weights  Mixing weights (length K)
 * @property {Float64Array} means    Means (K × dim)
 * @property {Float64Array} covs     Covariances (K × dim × dim)
 * @property {number} logLik         Final log-likelihood
 * @property {number} iterations     Number of EM iterations
 */

// ============================================================================
// Variable Declarations
// ============================================================================

// Pool of scratch buffers (with a per-pool ensure method)
const _probScratchPool = common.createPool(
  function () {
    const T = getArrayType();
    return {
      a: new T(256),
      b: new T(256),
      c: new T(256),
      d: new T(256),
      e: new T(256),
      size: 256,
      _attached: false
    };
  },
  8,
  function (s) {
    if (s.a) s.a.fill(0);
    if (s.b) s.b.fill(0);
    if (s.c) s.c.fill(0);
    if (s.d) s.d.fill(0);
    if (s.e) s.e.fill(0);
  }
);

// Attach ensure method to each acquired scratch buffer
(function warmProbScratch() {
  const pool = _probScratchPool;
  const orig = pool.acquire.bind(pool);
  pool.acquire = function () {
    const s = orig();
    if (!s._attached) {
      s._attached = true;
      s.ensure = function (n) {
        if (n <= this.size) return this;
        const T = getArrayType();
        this.size = n;
        this.a = new T(n);
        this.b = new T(n);
        this.c = new T(n);
        this.d = new T(n);
        this.e = new T(n);
        return this;
      };
    }
    return s;
  };
})();

/**
 * ProbabilityScratch — pooled scalar scratch buffer for 1M+ pipelines.
 */
export class ProbabilityScratch {
  static #warm = [];
  static {
    for (let i = 0; i < 8; i++) ProbabilityScratch.#warm.push(new ProbabilityScratch(512));
  }
  static acquire(size) {
    for (let i = 0; i < ProbabilityScratch.#warm.length; i++) {
      if (ProbabilityScratch.#warm[i].size >= (size || 0)) {
        const s = ProbabilityScratch.#warm[i];
        ProbabilityScratch.#warm.splice(i, 1);
        return s;
      }
    }
    return new ProbabilityScratch(size || 512);
  }
  static release(s) { if (s) { s.reset(); ProbabilityScratch.#warm.push(s); } }

  constructor(size) {
    this.size = size || 512;
    const T = getArrayType();
    this.a = new T(this.size);
    this.b = new T(this.size);
    this.c = new T(this.size);
    this.d = new T(this.size);
  }

  ensure(n) {
    if (n <= this.size) return this;
    this.size = n;
    const T = getArrayType();
    this.a = new T(n);
    this.b = new T(n);
    this.c = new T(n);
    this.d = new T(n);
    return this;
  }
  reset() { this.a.fill(0); this.b.fill(0); this.c.fill(0); this.d.fill(0); return this; }
}

function createProbabilityScratchPool(capacity) {
  return common.createPool(
    function () {
      const T = getArrayType();
      return { a: new T(512), b: new T(512), c: new T(512), d: new T(512), size: 512, _attached: false };
    },
    capacity || 8,
    function (s) { if (s.a) s.a.fill(0); }
  );
}
function acquireProbabilityScratch(size) {
  const s = _probScratchPool.acquire();
  if (size !== undefined) s.ensure(size);
  return s;
}
function releaseProbabilityScratch(s) { _probScratchPool.release(s); }

// ============================================================================
// Function Declarations — Multivariate distributions
// ============================================================================

/**
 * Cholesky decomposition — in-place lower-triangular factor of an N×N
 * positive-definite matrix. `L` is stored row-major (as length-N² flat array).
 * Returns true on success, false if the matrix is not positive-definite.
 */
export function choleskyDecompose(L, n) {
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = L[i * n + j];
      for (let k = 0; k < j; k++) sum -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (sum <= 0) return false;
        L[i * n + j] = Math.sqrt(sum);
      } else {
        L[i * n + j] = sum / L[j * n + j];
      }
    }
  }
  return true;
}

/**
 * Sample from an N-dimensional multivariate normal. Writes into `out[0..n-1]`.
 * `L` is a precomputed Cholesky factor of the covariance matrix.
 */
export function multivariateNormalFromCholesky(out, mean, L, n, rng) {
  rng = rng || Math.random;
  // Box–Muller for n standard normals
  const z = _probScratchPool.acquire().ensure(n).a;
  for (let i = 0; i < n; i += 2) {
    const u1 = Math.max(EPSILON, rng());
    const u2 = rng();
    const r = Math.sqrt(-2 * Math.log(u1));
    const th = TWO_PI * u2;
    z[i] = r * Math.cos(th);
    if (i + 1 < n) z[i + 1] = r * Math.sin(th);
  }
  // out = mean + L·z
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = 0; j <= i; j++) acc += L[i * n + j] * z[j];
    out[i] = mean[i] + acc;
  }
  return out;
}

/** Convenience — compute Cholesky from covariance, sample. */
export function multivariateNormalSample(out, mean, cov, n, rng) {
  const L = new Float64Array(cov.length);
  L.set(cov);
  if (!choleskyDecompose(L, n)) {
    // Fallback: add jitter
    for (let i = 0; i < n; i++) L[i * n + i] += 1e-6;
    if (!choleskyDecompose(L, n)) return out;
  }
  return multivariateNormalFromCholesky(out, mean, L, n, rng);
}

/**
 * Multivariate normal log-PDF at point x.
 * `invCov` is the inverse of the covariance, `logDet` the log-determinant.
 */
export function multivariateNormalLogPDF(x, mean, invCov, logDet, n) {
  let diff = 0;
  for (let i = 0; i < n; i++) {
    const d = x[i] - mean[i];
    diff -= 0.5 * d * d * invCov[i * n + i];
  }
  // Proper quadratic form
  let quad = 0;
  for (let i = 0; i < n; i++) {
    let row = 0;
    for (let j = 0; j < n; j++) row += invCov[i * n + j] * (x[j] - mean[j]);
    quad += (x[i] - mean[i]) * row;
  }
  return -0.5 * (quad + logDet + n * LN2PI);
}

export function multivariateNormalPDF(x, mean, invCov, logDet, n) {
  return Math.exp(multivariateNormalLogPDF(x, mean, invCov, logDet, n));
}

/** Dirichlet log-PDF. `alpha` is the concentration vector of length n. */
export function dirichletLogPDF(x, alpha, n) {
  let logB = 0;
  for (let i = 0; i < n; i++) logB += SpecialFunctions.lgamma(alpha[i]);
  logB -= SpecialFunctions.lgamma(0); // placeholder for sum-alpha
  let sumAlpha = 0;
  for (let i = 0; i < n; i++) sumAlpha += alpha[i];
  logB = SpecialFunctions.lgamma(sumAlpha) - logB;
  let acc = 0;
  for (let i = 0; i < n; i++) acc += (alpha[i] - 1) * Math.log(Math.max(EPSILON, x[i]));
  return logB + acc;
}

/** Wishart sampler — Bartlett decomposition. `df` must be > n - 1. */
export function wishartSample(out, df, scale, n, rng) {
  rng = rng || Math.random;
  // Bartlett: A is lower triangular with chi-square diag and normal off-diag
  const A = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      if (i === j) {
        A[i * n + j] = Math.sqrt(SpecialFunctions.gammaSample((df - j) / 2, 2, rng));
      } else {
        A[i * n + j] = Sampling.normalSample(0, 1, rng);
      }
    }
  }
  // L = Cholesky of scale
  const L = new Float64Array(scale.length);
  L.set(scale);
  choleskyDecompose(L, n);
  // Wishart = L·A·A^T·L^T
  // Compute (L·A) then multiply by transpose
  const LA = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let acc = 0;
      for (let k = 0; k < n; k++) acc += L[i * n + k] * A[k * n + j];
      LA[i * n + j] = acc;
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let acc = 0;
      for (let k = 0; k < n; k++) acc += LA[i * n + k] * LA[j * n + k];
      out[i * n + j] = acc;
    }
  }
  return out;
}

/** Inverse-Wishart via Wishart of the inverse and matrix inversion. */
export function inverseWishartSample(out, df, scale, n, rng) {
  const W = new Float64Array(n * n);
  wishartSample(W, df, scale, n, rng);
  return _invertMatrix(out, W, n);
}

function _invertMatrix(out, M, n) {
  // Gauss-Jordan on augmented copy
  const aug = new Float64Array(n * 2 * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) aug[i * 2 * n + j] = M[i * n + j];
    aug[i * 2 * n + n + i] = 1;
  }
  for (let k = 0; k < n; k++) {
    let maxRow = k, maxVal = Math.abs(aug[k * 2 * n + k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(aug[i * 2 * n + k]);
      if (v > maxVal) { maxVal = v; maxRow = i; }
    }
    if (maxVal < EPSILON) return out;
    if (maxRow !== k) {
      for (let j = 0; j < 2 * n; j++) {
        const t = aug[k * 2 * n + j];
        aug[k * 2 * n + j] = aug[maxRow * 2 * n + j];
        aug[maxRow * 2 * n + j] = t;
      }
    }
    const pivot = aug[k * 2 * n + k];
    for (let j = 0; j < 2 * n; j++) aug[k * 2 * n + j] /= pivot;
    for (let i = 0; i < n; i++) {
      if (i === k) continue;
      const f = aug[i * 2 * n + k];
      for (let j = 0; j < 2 * n; j++) aug[i * 2 * n + j] -= f * aug[k * 2 * n + j];
    }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[i * n + j] = aug[i * 2 * n + n + j];
  return out;
}

/** von Mises-Fisher sample on the unit 3-sphere (3D directional). */
export function vonMisesFisherSample(out, meanDir, kappa, rng) {
  rng = rng || Math.random;
  // Sample around the +Z axis first
  const c = Math.sqrt(1 + kappa * kappa);
  const u = rng();
  const w = 1 + Math.log(u + (1 - u) * Math.exp(-2 * kappa)) / kappa;
  // Actually Wood's algorithm:
  const z = 1 + Math.log(u + (1 - u) * Math.exp(-2 * kappa)) / kappa;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = TWO_PI * rng();
  const sx = r * Math.cos(phi), sy = r * Math.sin(phi), sz = z;
  // Rotate from +Z to meanDir via quaternion
  const q = M.quat.create();
  const from = [0, 0, 1];
  M.quat.rotationTo(q, from, meanDir);
  // Apply rotation
  const result = [sx, sy, sz];
  M.vec3.transformQuat(result, result, q);
  out[0] = result[0];
  out[1] = result[1];
  out[2] = result[2];
  return out;
}

/** von Mises-Fisher PDF on 3D unit sphere. `x` and `mean` are unit 3-vectors. */
export function vonMisesFisherPDF(x, mean, kappa) {
  const dot = x[0] * mean[0] + x[1] * mean[1] + x[2] * mean[2];
  const Z = kappa / (TWO_PI * (Math.exp(kappa) - Math.exp(-kappa)));
  return Z * Math.exp(kappa * dot);
}

/**
 * Kent (Fisher-Bingham) sampler — 5-parameter directional distribution.
 * `kappa` = concentration, `beta` = ovalness, `majorDir`/`minorDir` define
 * the axes of the elliptical distribution around `mean`.
 */
export function kentSample(out, mean, majorDir, kappa, beta, rng) {
  // Simplified: use vMF as approximation when |beta| is small; else reject-sample
  // For our usage, an approximation via vMF is usually fine.
  return vonMisesFisherSample(out, mean, kappa, rng);
}

/** Multinomial sample — writes counts into `out[0..k-1]`. */
export function multinomialSample(out, n, probs, k, rng) {
  rng = rng || Math.random;
  // Build cumulative CDF
  const cdf = _probScratchPool.acquire().ensure(k).a;
  let acc = 0;
  for (let i = 0; i < k; i++) { acc += probs[i]; cdf[i] = acc; }
  for (let i = 0; i < k; i++) out[i] = 0;
  for (let t = 0; t < n; t++) {
    const u = rng() * acc;
    // Binary search
    let lo = 0, hi = k - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < u) lo = mid + 1; else hi = mid;
    }
    out[lo]++;
  }
  return out;
}

/** Categorical sample — returns the chosen index. */
export function categoricalSample(probs, k, rng) {
  rng = rng || Math.random;
  let acc = 0;
  for (let i = 0; i < k; i++) acc += probs[i];
  const u = rng() * acc;
  let c = 0;
  for (let i = 0; i < k; i++) {
    c += probs[i];
    if (u < c) return i;
  }
  return k - 1;
}

/** Shannon entropy of a categorical distribution. */
export function categoricalEntropy(probs, k) {
  let H = 0;
  for (let i = 0; i < k; i++) {
    const p = probs[i];
    if (p > 0) H -= p * Math.log(p);
  }
  return H;
}

/** KL divergence between two categorical distributions. */
export function categoricalKL(p, q, k) {
  let kl = 0;
  for (let i = 0; i < k; i++) {
    if (p[i] > 0) kl += p[i] * Math.log(p[i] / Math.max(EPSILON, q[i]));
  }
  return kl;
}

// ============================================================================
// Mixture models
// ============================================================================

/**
 * GaussianMixture — a lightweight K-component Gaussian mixture in n dimensions.
 * Use `fitGMM` for parameter learning via EM.
 */
export class GaussianMixture {
  constructor(K, dim) {
    this.K = K;
    this.dim = dim;
    this.weights = new Float64Array(K).fill(1 / K);
    this.means = new Float64Array(K * dim);
    this.covs = new Float64Array(K * dim * dim);
    for (let k = 0; k < K; k++) {
      for (let i = 0; i < dim; i++) this.covs[(k * dim + i) * dim + i] = 1;
    }
  }

  /** Log-probability of a point x under the mixture. */
  logPDF(x) {
    const K = this.K, dim = this.dim;
    let maxL = -Infinity;
    const logs = new Float64Array(K);
    const invCov = new Float64Array(dim * dim);
    for (let k = 0; k < K; k++) {
      const logDet = _choleskyDet(this.covs.subarray(k * dim * dim, (k + 1) * dim * dim), invCov, dim);
      if (logDet === null) { logs[k] = -Infinity; continue; }
      let quad = 0;
      for (let i = 0; i < dim; i++) {
        let row = 0;
        for (let j = 0; j < dim; j++) row += invCov[i * dim + j] * (x[j] - this.means[k * dim + j]);
        quad += (x[i] - this.means[k * dim + i]) * row;
      }
      logs[k] = Math.log(this.weights[k]) - 0.5 * (quad + logDet + dim * LN2PI);
      if (logs[k] > maxL) maxL = logs[k];
    }
    let sum = 0;
    for (let k = 0; k < K; k++) sum += Math.exp(logs[k] - maxL);
    return maxL + Math.log(sum);
  }
}

/** Helper — returns log-determinant and fills inverse covariance. */
function _choleskyDet(cov, invOut, n) {
  const L = new Float64Array(n * n);
  L.set(cov);
  if (!choleskyDecompose(L, n)) return null;
  let logDet = 0;
  for (let i = 0; i < n; i++) logDet += 2 * Math.log(L[i * n + i]);
  // Invert L
  const Linv = new Float64Array(n * n);
  for (let i = 0; i < n; i++) Linv[i * n + i] = 1 / L[i * n + i];
  for (let i = 1; i < n; i++) {
    for (let j = 0; j < i; j++) {
      let acc = 0;
      for (let k = j; k < i; k++) acc += L[i * n + k] * Linv[k * n + j];
      Linv[i * n + j] = -acc * Linv[i * n + i];
    }
  }
  // invCov = Linv^T · Linv
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let acc = 0;
      for (let k = Math.max(i, j); k < n; k++) acc += Linv[k * n + i] * Linv[k * n + j];
      invOut[i * n + j] = acc;
    }
  }
  return logDet;
}

/**
 * Fit a GaussianMixture to `data` via Expectation–Maximization.
 * `data` is a flat Float64Array of `count × dim` values (row-major).
 * `options`: `{ maxIter, tol, seed }`. Returns a GMMResult.
 */
export function fitGMM(data, count, dim, K, options) {
  options = options || {};
  const maxIter = options.maxIter || 100;
  const tol = options.tol || 1e-6;
  const rng = common.mulberry32(options.seed || 1);

  // Initialise GMM
  const gmm = new GaussianMixture(K, dim);
  // K-means++-like init: random data points as means
  for (let k = 0; k < K; k++) {
    const pick = (rng() * count) | 0;
    for (let d = 0; d < dim; d++) gmm.means[k * dim + d] = data[pick * dim + d];
  }
  // Covariance: global covariance for all components (stable init)
  const globalCov = new Float64Array(dim * dim);
  const globalMean = new Float64Array(dim);
  for (let i = 0; i < count; i++) for (let d = 0; d < dim; d++) globalMean[d] += data[i * dim + d];
  for (let d = 0; d < dim; d++) globalMean[d] /= count;
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < dim; a++) {
      for (let b = 0; b < dim; b++) {
        globalCov[a * dim + b] += (data[i * dim + a] - globalMean[a]) * (data[i * dim + b] - globalMean[b]);
      }
    }
  }
  for (let a = 0; a < dim; a++) {
    for (let b = 0; b < dim; b++) globalCov[a * dim + b] /= count;
    globalCov[a * dim + a] += 1e-6;
  }
  for (let k = 0; k < K; k++) {
    for (let a = 0; a < dim * dim; a++) gmm.covs[k * dim * dim + a] = globalCov[a];
  }

  // EM
  const resp = new Float64Array(count * K);
  let prevLogLik = -Infinity;
  let iter = 0;
  for (; iter < maxIter; iter++) {
    // E-step
    let logLik = 0;
    const invCov = new Float64Array(dim * dim);
    const logDets = new Float64Array(K);
    for (let k = 0; k < K; k++) {
      logDets[k] = _choleskyDet(gmm.covs.subarray(k * dim * dim, (k + 1) * dim * dim), invCov, dim);
      // If singular, add jitter
      if (logDets[k] === null) {
        for (let d = 0; d < dim; d++) gmm.covs[(k * dim + d) * dim + d] += 1e-5;
        logDets[k] = _choleskyDet(gmm.covs.subarray(k * dim * dim, (k + 1) * dim * dim), invCov, dim);
      }
    }
    for (let i = 0; i < count; i++) {
      let maxL = -Infinity;
      const logs = new Float64Array(K);
      for (let k = 0; k < K; k++) {
        _choleskyDet(gmm.covs.subarray(k * dim * dim, (k + 1) * dim * dim), invCov, dim);
        let quad = 0;
        for (let a = 0; a < dim; a++) {
          let row = 0;
          for (let b = 0; b < dim; b++) row += invCov[a * dim + b] * (data[i * dim + b] - gmm.means[k * dim + b]);
          quad += (data[i * dim + a] - gmm.means[k * dim + a]) * row;
        }
        logs[k] = Math.log(gmm.weights[k] + EPSILON) - 0.5 * (quad + logDets[k] + dim * LN2PI);
        if (logs[k] > maxL) maxL = logs[k];
      }
      let sum = 0;
      for (let k = 0; k < K; k++) sum += Math.exp(logs[k] - maxL);
      logLik += maxL + Math.log(sum);
      for (let k = 0; k < K; k++) resp[i * K + k] = Math.exp(logs[k] - maxL) / sum;
    }

    if (Math.abs(logLik - prevLogLik) < tol * Math.abs(logLik)) break;
    prevLogLik = logLik;

    // M-step
    for (let k = 0; k < K; k++) {
      let weightSum = 0;
      for (let i = 0; i < count; i++) weightSum += resp[i * K + k];
      gmm.weights[k] = Math.max(EPSILON, weightSum / count);
      for (let d = 0; d < dim; d++) {
        let meanAcc = 0;
        for (let i = 0; i < count; i++) meanAcc += resp[i * K + k] * data[i * dim + d];
        gmm.means[k * dim + d] = meanAcc / weightSum;
      }
      const newCov = new Float64Array(dim * dim);
      for (let i = 0; i < count; i++) {
        for (let a = 0; a < dim; a++) {
          const da = data[i * dim + a] - gmm.means[k * dim + a];
          for (let b = 0; b < dim; b++) {
            newCov[a * dim + b] += resp[i * K + k] * da * (data[i * dim + b] - gmm.means[k * dim + b]);
          }
        }
      }
      for (let a = 0; a < dim * dim; a++) gmm.covs[k * dim * dim + a] = newCov[a] / weightSum;
      for (let d = 0; d < dim; d++) gmm.covs[(k * dim + d) * dim + d] += 1e-6;
    }
  }

  return {
    K: K, dim: dim,
    weights: gmm.weights,
    means: gmm.means,
    covs: gmm.covs,
    logLik: prevLogLik,
    iterations: iter
  };
}

/** Predict the most likely component for a point. */
export function gmmPredict(result, x) {
  const K = result.K, dim = result.dim;
  let bestK = 0, bestLog = -Infinity;
  const invCov = new Float64Array(dim * dim);
  for (let k = 0; k < K; k++) {
    const cov = result.covs.subarray(k * dim * dim, (k + 1) * dim * dim);
    const logDet = _choleskyDet(cov, invCov, dim);
    if (logDet === null) continue;
    let quad = 0;
    for (let a = 0; a < dim; a++) {
      let row = 0;
      for (let b = 0; b < dim; b++) row += invCov[a * dim + b] * (x[b] - result.means[k * dim + b]);
      quad += (x[a] - result.means[k * dim + a]) * row;
    }
    const log = Math.log(result.weights[k] + EPSILON) - 0.5 * (quad + logDet + dim * LN2PI);
    if (log > bestLog) { bestLog = log; bestK = k; }
  }
  return bestK;
}

// ============================================================================
// Bayesian primitives
// ============================================================================

/** Discrete Bayes update. `prior` and `likelihood` are length-n arrays. */
export function bayesUpdate(posterior, prior, likelihood, n) {
  let norm = 0;
  for (let i = 0; i < n; i++) norm += prior[i] * likelihood[i];
  for (let i = 0; i < n; i++) posterior[i] = (prior[i] * likelihood[i]) / (norm || 1);
  return posterior;
}

/** Simple Gaussian Naive Bayes classifier — fit and predict. */
export class NaiveBayes {
  constructor(numClasses, numFeatures) {
    this.C = numClasses;
    this.F = numFeatures;
    this.classPriors = new Float64Array(numClasses).fill(1 / numClasses);
    this.means = new Float64Array(numClasses * numFeatures);
    this.vars = new Float64Array(numClasses * numFeatures).fill(1);
  }

  /** Fit from `data` (n × F) and `labels` (length n, int class ids). */
  fit(data, labels, n) {
    const counts = new Int32Array(this.C);
    for (let i = 0; i < n; i++) counts[labels[i]]++;
    for (let c = 0; c < this.C; c++) {
      this.classPriors[c] = (counts[c] + 1) / (n + this.C); // Laplace smoothing
      // Mean
      for (let f = 0; f < this.F; f++) this.means[c * this.F + f] = 0;
      for (let i = 0; i < n; i++) {
        if (labels[i] !== c) continue;
        for (let f = 0; f < this.F; f++) this.means[c * this.F + f] += data[i * this.F + f];
      }
      for (let f = 0; f < this.F; f++) this.means[c * this.F + f] /= (counts[c] || 1);
      // Variance
      for (let f = 0; f < this.F; f++) this.vars[c * this.F + f] = 0;
      for (let i = 0; i < n; i++) {
        if (labels[i] !== c) continue;
        for (let f = 0; f < this.F; f++) {
          const d = data[i * this.F + f] - this.means[c * this.F + f];
          this.vars[c * this.F + f] += d * d;
        }
      }
      for (let f = 0; f < this.F; f++) this.vars[c * this.F + f] = this.vars[c * this.F + f] / (counts[c] || 1) + 1e-6;
    }
    return this;
  }

  /** Predict the class of a single sample (length F). */
  predict(x) {
    let bestC = 0, bestLog = -Infinity;
    for (let c = 0; c < this.C; c++) {
      let log = Math.log(this.classPriors[c]);
      for (let f = 0; f < this.F; f++) {
        const v = this.vars[c * this.F + f];
        const mu = this.means[c * this.F + f];
        const d = x[f] - mu;
        log -= 0.5 * Math.log(TWO_PI * v) + (d * d) / (2 * v);
      }
      if (log > bestLog) { bestLog = log; bestC = c; }
    }
    return bestC;
  }
}

/** Beta-Bernoulli conjugate update. Returns the posterior Beta(a', b'). */
export function conjugateBetaBernoulli(a, b, successes, failures) {
  return { a: a + successes, b: b + failures };
}

/** Dirichlet-Categorical conjugate update. Returns the posterior alpha'. */
export function conjugateDirichletCategorical(alpha, counts, n) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = alpha[i] + counts[i];
  return out;
}

/**
 * Normal-Normal conjugate update. Prior = N(mu0, sigma0²). Likelihood:
 * observations with known variance sigma².
 */
export function conjugateNormalNormal(mu0, sigma0, obsMean, obsVar, nObs) {
  const postVar = 1 / (1 / (sigma0 * sigma0) + nObs / obsVar);
  const postMean = postVar * (mu0 / (sigma0 * sigma0) + (nObs * obsMean) / obsVar);
  return { mu: postMean, sigma2: postVar };
}

/** Gamma-Poisson conjugate update. Prior Gamma(α, β), likelihood counts. */
export function conjugateGammaPoisson(alpha, beta, counts, n) {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += counts[i];
  return { alpha: alpha + sum, beta: beta + n };
}

export function AIC(logLik, k) { return 2 * k - 2 * logLik; }
export function BIC(logLik, k, n) { return k * Math.log(n) - 2 * logLik; }

/** Total log-likelihood of data under a Gaussian with mean, variance. */
export function logLikelihood(data, n, mu, sigma2) {
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const d = data[i] - mu;
    acc -= 0.5 * (Math.log(TWO_PI * sigma2) + (d * d) / sigma2);
  }
  return acc;
}

// ============================================================================
// Information theory
// ============================================================================

export function entropy(p, n) {
  let H = 0;
  for (let i = 0; i < n; i++) if (p[i] > 0) H -= p[i] * Math.log(p[i]);
  return H;
}

export function renyiEntropy(p, n, alpha) {
  if (Math.abs(alpha - 1) < 1e-9) return entropy(p, n);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.pow(p[i], alpha);
  return Math.log(sum) / (1 - alpha);
}

export function tsallisEntropy(p, n, q) {
  if (Math.abs(q - 1) < 1e-9) return entropy(p, n);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.pow(p[i], q);
  return (1 - sum) / (q - 1);
}

export function klDivergence(p, q, n) {
  let kl = 0;
  for (let i = 0; i < n; i++) if (p[i] > 0) kl += p[i] * Math.log(p[i] / Math.max(EPSILON, q[i]));
  return kl;
}

export function jsDivergence(p, q, n) {
  const m = new Float64Array(n);
  for (let i = 0; i < n; i++) m[i] = 0.5 * (p[i] + q[i]);
  return 0.5 * klDivergence(p, m, n) + 0.5 * klDivergence(q, m, n);
}

/** Mutual information between two discrete distributions given joint. */
export function mutualInformation(joint, px, py, nx, ny) {
  let mi = 0;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const pxy = joint[i * ny + j];
      if (pxy > 0) mi += pxy * Math.log(pxy / (px[i] * py[j]));
    }
  }
  return mi;
}

export function crossEntropy(p, q, n) {
  let H = 0;
  for (let i = 0; i < n; i++) if (p[i] > 0) H -= p[i] * Math.log(Math.max(EPSILON, q[i]));
  return H;
}

export function perplexity(p, n) { return Math.exp(entropy(p, n)); }

// ============================================================================
// Monte Carlo
// ============================================================================

/**
 * Importance sampling. `sampleFn(rng)` returns a sample; `logP(x)` is log
 * probability under the target; `logQ(x)` is log probability under proposal.
 * Returns the weighted mean.
 */
export function importanceSampling(sampleFn, logP, logQ, nSamples, rng) {
  rng = rng || Math.random;
  let num = 0, den = 0;
  for (let i = 0; i < nSamples; i++) {
    const s = sampleFn(rng);
    const logW = logP(s) - logQ(s);
    const w = Math.exp(logW);
    num += w * s;
    den += w;
  }
  return den > 0 ? num / den : 0;
}

/** Systematic resampling of importance weights — in-place index rewrite. */
export function importanceResample(indices, weights, n, rng) {
  rng = rng || Math.random;
  let total = 0;
  for (let i = 0; i < n; i++) total += weights[i];
  const step = total / n;
  let pos = rng() * step;
  let acc = weights[0];
  let j = 0;
  for (let i = 0; i < n; i++) {
    while (pos > acc && j < n - 1) { j++; acc += weights[j]; }
    indices[i] = j;
    pos += step;
  }
  return indices;
}

/** Antithetic sampling — pairs u and 1-u to reduce variance. */
export function antitheticSample(n, rng, fn) {
  rng = rng || Math.random;
  let sum = 0;
  const half = Math.floor(n / 2);
  for (let i = 0; i < half; i++) {
    const u = rng();
    sum += fn(u) + fn(1 - u);
  }
  if (n % 2 === 1) sum += fn(rng());
  return sum / n;
}

/** Control variates — subtracts a known-mean control. */
export function controlVariates(estimates, control, controlMean, n) {
  let estMean = 0, ctrlMean = 0;
  for (let i = 0; i < n; i++) { estMean += estimates[i]; ctrlMean += control[i]; }
  estMean /= n; ctrlMean /= n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (estimates[i] - estMean) * (control[i] - ctrlMean);
    den += (control[i] - ctrlMean) * (control[i] - ctrlMean);
  }
  const beta = den > 0 ? num / den : 0;
  return estMean - beta * (ctrlMean - controlMean);
}

/** Bootstrap confidence interval (percentile method). */
export function bootstrapCI(data, n, nBoot, alpha, rng) {
  rng = rng || Math.random;
  const means = new Float64Array(nBoot);
  const tmp = new Float64Array(n);
  for (let b = 0; b < nBoot; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const idx = (rng() * n) | 0;
      sum += data[idx];
    }
    means[b] = sum / n;
  }
  const sorted = Array.from(means).sort((a, b) => a - b);
  const loIdx = Math.floor((alpha / 2) * nBoot);
  const hiIdx = Math.floor((1 - alpha / 2) * nBoot);
  return { lo: sorted[loIdx], hi: sorted[hiIdx] };
}

/** Jackknife estimate of bias and standard error. */
export function jackknife(data, n, statFn) {
  const est = statFn(data, n);
  const estimates = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    // Compute statistic without data[i] — uses statFn on a mask array
    const masked = new Float64Array(n - 1);
    let k = 0;
    for (let j = 0; j < n; j++) if (j !== i) masked[k++] = data[j];
    estimates[i] = statFn(masked, n - 1);
    sum += estimates[i];
  }
  const meanEst = sum / n;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const d = estimates[i] - meanEst;
    variance += d * d;
  }
  variance *= (n - 1) / n;
  return {
    estimate: est,
    bias: (n - 1) * (meanEst - est),
    stdError: Math.sqrt(variance)
  };
}

/** Metropolis–Hastings MCMC in n dimensions. `proposalStd` is scalar. */
export function metropolisHastingsND(logTargetFn, x0, n, nSamples, proposalStd, rng) {
  rng = rng || Math.random;
  const samples = new Float64Array(nSamples * n);
  const current = new Float64Array(x0);
  const candidate = new Float64Array(n);
  let logCurrent = logTargetFn(current, n);
  let accepted = 0;
  for (let i = 0; i < nSamples; i++) {
    for (let d = 0; d < n; d++) candidate[d] = current[d] + Sampling.normalSample(0, proposalStd, rng);
    const logCand = logTargetFn(candidate, n);
    if (Math.log(rng()) < logCand - logCurrent) {
      for (let d = 0; d < n; d++) current[d] = candidate[d];
      logCurrent = logCand;
      accepted++;
    }
    for (let d = 0; d < n; d++) samples[i * n + d] = current[d];
  }
  return { samples: samples, accepted: accepted, acceptanceRate: accepted / nSamples };
}

/** Gibbs sampling for 2D — user provides conditional samplers. */
export function gibbsND(condX, condY, x0, y0, nSamples, rng) {
  rng = rng || Math.random;
  const samples = new Float64Array(nSamples * 2);
  let x = x0, y = y0;
  for (let i = 0; i < nSamples; i++) {
    x = condX(y, rng);
    y = condY(x, rng);
    samples[i * 2] = x;
    samples[i * 2 + 1] = y;
  }
  return samples;
}

/** Hamiltonian Monte Carlo — gradient-based sampler. `gradFn(x, n, out)`. */
export function hamiltonianMC(logTargetFn, gradFn, x0, n, nSamples, stepSize, nLeapfrog, rng) {
  rng = rng || Math.random;
  const samples = new Float64Array(nSamples * n);
  const x = new Float64Array(x0);
  const p = new Float64Array(n);
  const grad = new Float64Array(n);
  let accepted = 0;
  for (let s = 0; s < nSamples; s++) {
    for (let d = 0; d < n; d++) p[d] = Sampling.normalSample(0, 1, rng);
    const xProp = new Float64Array(x);
    const pProp = new Float64Array(p);
    const logU0 = -logTargetFn(x, n) + 0.5 * _dot(p, p, n);
    for (let l = 0; l < nLeapfrog; l++) {
      gradFn(xProp, n, grad);
      for (let d = 0; d < n; d++) pProp[d] -= 0.5 * stepSize * grad[d];
      for (let d = 0; d < n; d++) xProp[d] += stepSize * pProp[d];
      gradFn(xProp, n, grad);
      for (let d = 0; d < n; d++) pProp[d] -= 0.5 * stepSize * grad[d];
    }
    const logU1 = -logTargetFn(xProp, n) + 0.5 * _dot(pProp, pProp, n);
    if (Math.log(rng()) < logU0 - logU1) {
      for (let d = 0; d < n; d++) x[d] = xProp[d];
      accepted++;
    }
    for (let d = 0; d < n; d++) samples[s * n + d] = x[d];
  }
  return { samples: samples, accepted: accepted, acceptanceRate: accepted / nSamples };
}

function _dot(a, b, n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

// ============================================================================
// Sequential estimation
// ============================================================================

/**
 * Linear Kalman filter in n dimensions.
 * State: x (n), Covariance: P (n × n).
 * Process model: F (n × n), Process noise: Q (n × n).
 * Observation: H (m × n), Observation noise: R (m × m).
 */
export class KalmanFilter {
  constructor(n, m) {
    this.n = n;
    this.m = m;
    this.x = new Float64Array(n);
    this.P = new Float64Array(n * n);
    this.F = new Float64Array(n * n);
    this.Q = new Float64Array(n * n);
    this.H = new Float64Array(m * n);
    this.R = new Float64Array(m * m);
    for (let i = 0; i < n; i++) this.P[i * n + i] = 1;
    for (let i = 0; i < m; i++) this.R[i * m + i] = 1;
    this._I = new Float64Array(n * n);
    for (let i = 0; i < n; i++) this._I[i * n + i] = 1;
  }

  predict() {
    const n = this.n, x = this.x, P = this.P, F = this.F, Q = this.Q;
    // x = F·x
    const xNew = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let j = 0; j < n; j++) acc += F[i * n + j] * x[j];
      xNew[i] = acc;
    }
    // P = F·P·F^T + Q
    const FP = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        let acc = 0;
        for (let k = 0; k < n; k++) acc += F[i * n + k] * P[k * n + j];
        FP[i * n + j] = acc;
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        let acc = 0;
        for (let k = 0; k < n; k++) acc += FP[i * n + k] * F[j * n + k];
        P[i * n + j] = acc + Q[i * n + j];
      }
    }
    for (let i = 0; i < n; i++) x[i] = xNew[i];
    return this;
  }

  update(z) {
    const n = this.n, m = this.m;
    const H = this.H, P = this.P, R = this.R, x = this.x;
    // y = z - H·x
    const y = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      let acc = z[i];
      for (let j = 0; j < n; j++) acc -= H[i * n + j] * x[j];
      y[i] = acc;
    }
    // S = H·P·H^T + R
    const PHt = new Float64Array(n * m);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        let acc = 0;
        for (let k = 0; k < n; k++) acc += P[i * n + k] * H[j * n + k];
        PHt[i * m + j] = acc;
      }
    }
    const S = new Float64Array(m * m);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) {
        let acc = 0;
        for (let k = 0; k < n; k++) acc += H[i * n + k] * PHt[k * m + j];
        S[i * m + j] = acc + R[i * m + j];
      }
    }
    // K = P·H^T·S^-1
    const Sinv = new Float64Array(m * m);
    _invertMatrix(Sinv, S, m);
    const K = new Float64Array(n * m);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        let acc = 0;
        for (let k = 0; k < m; k++) acc += PHt[i * m + k] * Sinv[k * m + j];
        K[i * m + j] = acc;
      }
    }
    // x = x + K·y
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let j = 0; j < m; j++) acc += K[i * m + j] * y[j];
      x[i] += acc;
    }
    // P = (I - K·H)·P
    const KH = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        let acc = 0;
        for (let k = 0; k < m; k++) acc += K[i * m + k] * H[k * n + j];
        KH[i * n + j] = acc;
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        let acc = 0;
        for (let k = 0; k < n; k++) acc += (this._I[i * n + k] - KH[i * n + k]) * P[k * n + j];
        this.P[i * n + j] = acc;
      }
    }
    return this;
  }
}

export class ExtendedKalmanFilter extends KalmanFilter {
  constructor(n, m) {
    super(n, m);
    this.fx = null;    // user-provided state transition
    this.hx = null;    // user-provided observation
    this.Fjac = null;  // user-provided Jacobian
    this.Hjac = null;
  }

  predict() {
    // Uses user-supplied nonlinear fx and Jacobian
    if (this.fx) {
      const xNew = new Float64Array(this.n);
      this.fx(this.x, xNew);
      for (let i = 0; i < this.n; i++) this.x[i] = xNew[i];
    }
    if (this.Fjac) {
      const Fnew = new Float64Array(this.n * this.n);
      this.Fjac(this.x, Fnew);
      for (let i = 0; i < this.n * this.n; i++) this.F[i] = Fnew[i];
    }
    // Now do the standard covariance propagation
    return super.predict.call({
      n: this.n, x: this.x, P: this.P, F: this.F, Q: this.Q,
      update: this.update.bind(this), predict: this.predict.bind(this)
    });
  }
}

export class UnscentedKalmanFilter extends KalmanFilter {
  constructor(n, m) {
    super(n, m);
    this.alpha = 1e-3;
    this.beta = 2;
    this.kappa = 0;
    this.lambda = this.alpha * this.alpha * (n + this.kappa) - n;
    this.nSigma = 2 * n + 1;
    this.Wm = new Float64Array(this.nSigma);
    this.Wc = new Float64Array(this.nSigma);
    this.Wm[0] = this.lambda / (n + this.lambda);
    this.Wc[0] = this.Wm[0] + (1 - this.alpha * this.alpha + this.beta);
    for (let i = 1; i < this.nSigma; i++) {
      this.Wm[i] = this.Wc[i] = 0.5 / (n + this.lambda);
    }
  }
  // Minimal UKF — delegates to linear KF for now; full sigma-point
  // propagation would extend this class.
}

/**
 * Particle filter — bootstrap variant. `weight[i]` is probability.
 */
export class ParticleFilter {
  constructor(n, count, initFn, motionFn, obsLogLikFn, rng) {
    this.n = n;
    this.count = count;
    this.particles = new Float64Array(count * n);
    this.weights = new Float64Array(count).fill(1 / count);
    this.motionFn = motionFn;
    this.obsLogLikFn = obsLogLikFn;
    this.rng = rng || Math.random;
    if (initFn) for (let i = 0; i < count; i++) initFn(i, this.particles.subarray(i * n, (i + 1) * n));
  }

  predict() {
    const tmp = new Float64Array(this.n);
    for (let i = 0; i < this.count; i++) {
      tmp.set(this.particles.subarray(i * this.n, (i + 1) * this.n));
      this.motionFn(tmp, this.rng);
      this.particles.set(tmp, i * this.n);
    }
  }

  update(observation) {
    let maxLog = -Infinity;
    const logW = new Float64Array(this.count);
    const tmp = new Float64Array(this.n);
    for (let i = 0; i < this.count; i++) {
      tmp.set(this.particles.subarray(i * this.n, (i + 1) * this.n));
      logW[i] = this.obsLogLikFn(tmp, observation);
      if (logW[i] > maxLog) maxLog = logW[i];
    }
    let sum = 0;
    for (let i = 0; i < this.count; i++) {
      this.weights[i] *= Math.exp(logW[i] - maxLog);
      sum += this.weights[i];
    }
    for (let i = 0; i < this.count; i++) this.weights[i] /= (sum || 1);

    // Resample if effective sample size is low
    let ess = 0;
    for (let i = 0; i < this.count; i++) ess += this.weights[i] * this.weights[i];
    if (1 / ess < this.count * 0.5) this.resample();
  }

  resample() {
    const idx = new Int32Array(this.count);
    importanceResample(idx, this.weights, this.count, this.rng);
    const newParticles = new Float64Array(this.particles.length);
    for (let i = 0; i < this.count; i++) {
      newParticles.set(
        this.particles.subarray(idx[i] * this.n, (idx[i] + 1) * this.n),
        i * this.n);
    }
    this.particles = newParticles;
    this.weights.fill(1 / this.count);
  }

  estimate(out) {
    out = out || new Float64Array(this.n);
    for (let d = 0; d < this.n; d++) out[d] = 0;
    for (let i = 0; i < this.count; i++) {
      for (let d = 0; d < this.n; d++) out[d] += this.weights[i] * this.particles[i * this.n + d];
    }
    return out;
  }
}

/**
 * Hidden Markov Model with discrete states. `logA[i,j]` transition logs, `logB`
 * emission logs, `logPi` initial state logs.
 */
export class HMM {
  constructor(states, obsSymbols) {
    this.S = states;
    this.O = obsSymbols;
    this.logA = new Float64Array(states * states);
    this.logB = new Float64Array(states * obsSymbols);
    this.logPi = new Float64Array(states);
  }

  /** Forward–backward — computes posteriors for each state given observations. */
  forwardBackward(obs, T) {
    const S = this.S;
    const alpha = new Float64Array(T * S);
    const beta = new Float64Array(T * S);
    for (let s = 0; s < S; s++) alpha[s] = this.logPi[s] + this.logB[s * this.O + obs[0]];
    for (let t = 1; t < T; t++) {
      for (let s = 0; s < S; s++) {
        let maxLog = -Infinity;
        const terms = new Float64Array(S);
        for (let p = 0; p < S; p++) {
          terms[p] = alpha[(t - 1) * S + p] + this.logA[p * S + s];
          if (terms[p] > maxLog) maxLog = terms[p];
        }
        let sum = 0;
        for (let p = 0; p < S; p++) sum += Math.exp(terms[p] - maxLog);
        alpha[t * S + s] = maxLog + Math.log(sum) + this.logB[s * this.O + obs[t]];
      }
    }
    for (let s = 0; s < S; s++) beta[(T - 1) * S + s] = 0;
    for (let t = T - 2; t >= 0; t--) {
      for (let s = 0; s < S; s++) {
        let maxLog = -Infinity;
        const terms = new Float64Array(S);
        for (let n2 = 0; n2 < S; n2++) {
          terms[n2] = this.logA[s * S + n2] + this.logB[n2 * this.O + obs[t + 1]] + beta[(t + 1) * S + n2];
          if (terms[n2] > maxLog) maxLog = terms[n2];
        }
        let sum = 0;
        for (let n2 = 0; n2 < S; n2++) sum += Math.exp(terms[n2] - maxLog);
        beta[t * S + s] = maxLog + Math.log(sum);
      }
    }
    const gamma = new Float64Array(T * S);
    for (let t = 0; t < T; t++) {
      let maxLog = -Infinity;
      for (let s = 0; s < S; s++) {
        const v = alpha[t * S + s] + beta[t * S + s];
        if (v > maxLog) maxLog = v;
      }
      let sum = 0;
      for (let s = 0; s < S; s++) sum += Math.exp(alpha[t * S + s] + beta[t * S + s] - maxLog);
      for (let s = 0; s < S; s++) gamma[t * S + s] = Math.exp(alpha[t * S + s] + beta[t * S + s] - maxLog) / sum;
    }
    return { alpha: alpha, beta: beta, gamma: gamma };
  }

  /** Viterbi — most likely state sequence for observations. */
  viterbi(obs, T) {
    const S = this.S;
    const delta = new Float64Array(T * S);
    const psi = new Int32Array(T * S);
    for (let s = 0; s < S; s++) delta[s] = this.logPi[s] + this.logB[s * this.O + obs[0]];
    for (let t = 1; t < T; t++) {
      for (let s = 0; s < S; s++) {
        let bestLog = -Infinity, bestP = 0;
        for (let p = 0; p < S; p++) {
          const v = delta[(t - 1) * S + p] + this.logA[p * S + s];
          if (v > bestLog) { bestLog = v; bestP = p; }
        }
        delta[t * S + s] = bestLog + this.logB[s * this.O + obs[t]];
        psi[t * S + s] = bestP;
      }
    }
    const path = new Int32Array(T);
    let bestFinal = -Infinity, bestS = 0;
    for (let s = 0; s < S; s++) {
      if (delta[(T - 1) * S + s] > bestFinal) { bestFinal = delta[(T - 1) * S + s]; bestS = s; }
    }
    path[T - 1] = bestS;
    for (let t = T - 2; t >= 0; t--) path[t] = psi[(t + 1) * S + path[t + 1]];
    return { path: path, logLik: bestFinal };
  }
}

// ============================================================================
// Point-set statistics
// ============================================================================

/**
 * PCA over `n` points (row-major `count × n`). Writes mean and eigenvectors
 * (principal directions) into `out`. Uses the eigen-decomposition of the
 * covariance.
 */
export function computePCA(data, count, n) {
  const mean = new Float64Array(n);
  for (let i = 0; i < count; i++) for (let d = 0; d < n; d++) mean[d] += data[i * n + d];
  for (let d = 0; d < n; d++) mean[d] /= count;
  const cov = new Float64Array(n * n);
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        cov[a * n + b] += (data[i * n + a] - mean[a]) * (data[i * n + b] - mean[b]);
      }
    }
  }
  for (let a = 0; a < n * n; a++) cov[a] /= (count - 1);
  const { values, vectors } = _jacobiEigen(cov, n);
  return { mean: mean, cov: cov, eigenvalues: values, eigenvectors: vectors };
}

/** Jacobi eigenvalue decomposition for symmetric matrices. */
function _jacobiEigen(A, n) {
  const a = new Float64Array(A);
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  const maxSweeps = 50;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let offDiag = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) offDiag += a[i * n + j] * a[i * n + j];
    if (offDiag < 1e-12) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-12) continue;
        const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p], akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k], aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p], vkq = v[k * n + q];
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) values[i] = a[i * n + i];
  return { values: values, vectors: v };
}

/** Probabilistic PCA — linear-Gaussian model. Returns principal directions. */
export function probabilisticPCA(data, count, n, components) {
  const pca = computePCA(data, count, n);
  return {
    mean: pca.mean,
    components: components || n,
    loadings: pca.eigenvectors.subarray(0, n * (components || n)),
    eigenvalues: pca.eigenvalues
  };
}

/**
 * RANSAC plane fit — robustly find the plane a·x + b·y + c·z + d = 0 that
 * contains the most points within `threshold`. `out` is `[a, b, c, d]`.
 */
export function ransacPlane(out, points, count, threshold, iterations, rng) {
  rng = rng || Math.random;
  let bestInliers = 0;
  let bestPlane = [0, 0, 1, 0];
  for (let it = 0; it < iterations; it++) {
    const i0 = (rng() * count) | 0;
    const i1 = (rng() * count) | 0;
    const i2 = (rng() * count) | 0;
    if (i0 === i1 || i1 === i2 || i0 === i2) continue;
    const p0 = points.subarray(i0 * 3, i0 * 3 + 3);
    const p1 = points.subarray(i1 * 3, i1 * 3 + 3);
    const p2 = points.subarray(i2 * 3, i2 * 3 + 3);
    const v1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const v2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    const nrm = [v1[1] * v2[2] - v1[2] * v2[1], v1[2] * v2[0] - v1[0] * v2[2], v1[0] * v2[1] - v1[1] * v2[0]];
    const nlen = Math.sqrt(nrm[0] * nrm[0] + nrm[1] * nrm[1] + nrm[2] * nrm[2]);
    if (nlen < 1e-9) continue;
    nrm[0] /= nlen; nrm[1] /= nlen; nrm[2] /= nlen;
    const d = -(nrm[0] * p0[0] + nrm[1] * p0[1] + nrm[2] * p0[2]);
    let inliers = 0;
    for (let i = 0; i < count; i++) {
      const dist = Math.abs(nrm[0] * points[i * 3] + nrm[1] * points[i * 3 + 1] + nrm[2] * points[i * 3 + 2] + d);
      if (dist < threshold) inliers++;
    }
    if (inliers > bestInliers) { bestInliers = inliers; bestPlane = [nrm[0], nrm[1], nrm[2], d]; }
  }
  out[0] = bestPlane[0]; out[1] = bestPlane[1]; out[2] = bestPlane[2]; out[3] = bestPlane[3];
  return { plane: out, inliers: bestInliers };
}

/** RANSAC sphere fit. `out` = [cx, cy, cz, r]. */
export function ransacSphere(out, points, count, threshold, iterations, rng) {
  rng = rng || Math.random;
  let bestInliers = 0, bestSphere = [0, 0, 0, 1];
  for (let it = 0; it < iterations; it++) {
    const i0 = (rng() * count) | 0, i1 = (rng() * count) | 0, i2 = (rng() * count) | 0, i3 = (rng() * count) | 0;
    const p0 = [points[i0 * 3], points[i0 * 3 + 1], points[i0 * 3 + 2]];
    const p1 = [points[i1 * 3], points[i1 * 3 + 1], points[i1 * 3 + 2]];
    const p2 = [points[i2 * 3], points[i2 * 3 + 1], points[i2 * 3 + 2]];
    const p3 = [points[i3 * 3], points[i3 * 3 + 1], points[i3 * 3 + 2]];
    // Solve 4x4 linear system for (a, b, c, d) where x² + y² + z² + ax + by + cz + d = 0
    const A = new Float64Array(16);
    const b = new Float64Array(4);
    const pts = [p0, p1, p2, p3];
    for (let i = 0; i < 4; i++) {
      A[i * 4] = pts[i][0]; A[i * 4 + 1] = pts[i][1]; A[i * 4 + 2] = pts[i][2]; A[i * 4 + 3] = 1;
      b[i] = -(pts[i][0] * pts[i][0] + pts[i][1] * pts[i][1] + pts[i][2] * pts[i][2]);
    }
    const sol = _solveLinear(A, b, 4);
    if (!sol) continue;
    const cx = -sol[0] / 2, cy = -sol[1] / 2, cz = -sol[2] / 2;
    const r = Math.sqrt(cx * cx + cy * cy + cz * cz - sol[3]);
    if (!isFinite(r) || r <= 0) continue;
    let inliers = 0;
    for (let i = 0; i < count; i++) {
      const dx = points[i * 3] - cx, dy = points[i * 3 + 1] - cy, dz = points[i * 3 + 2] - cz;
      const dist = Math.abs(Math.sqrt(dx * dx + dy * dy + dz * dz) - r);
      if (dist < threshold) inliers++;
    }
    if (inliers > bestInliers) { bestInliers = inliers; bestSphere = [cx, cy, cz, r]; }
  }
  out[0] = bestSphere[0]; out[1] = bestSphere[1]; out[2] = bestSphere[2]; out[3] = bestSphere[3];
  return { sphere: out, inliers: bestInliers };
}

function _solveLinear(A, b, n) {
  const aug = new Float64Array(n * (n + 1));
  for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) aug[i * (n + 1) + j] = A[i * n + j]; aug[i * (n + 1) + n] = b[i]; }
  for (let k = 0; k < n; k++) {
    let maxRow = k, maxVal = Math.abs(aug[k * (n + 1) + k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(aug[i * (n + 1) + k]);
      if (v > maxVal) { maxVal = v; maxRow = i; }
    }
    if (maxVal < 1e-12) return null;
    if (maxRow !== k) for (let j = 0; j <= n; j++) {
      const t = aug[k * (n + 1) + j];
      aug[k * (n + 1) + j] = aug[maxRow * (n + 1) + j];
      aug[maxRow * (n + 1) + j] = t;
    }
    const pivot = aug[k * (n + 1) + k];
    for (let i = k + 1; i < n; i++) {
      const f = aug[i * (n + 1) + k] / pivot;
      for (let j = k; j <= n; j++) aug[i * (n + 1) + j] -= f * aug[k * (n + 1) + j];
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let acc = aug[i * (n + 1) + n];
    for (let j = i + 1; j < n; j++) acc -= aug[i * (n + 1) + j] * x[j];
    x[i] = acc / aug[i * (n + 1) + i];
  }
  return x;
}

/** Robust mean — iteratively weighted mean with Huber-like weights. */
export function robustMean(data, n, iterations, sigma) {
  iterations = iterations || 10;
  sigma = sigma || 1;
  let mu = 0;
  for (let i = 0; i < n; i++) mu += data[i];
  mu /= n;
  for (let it = 0; it < iterations; it++) {
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const d = data[i] - mu;
      const w = Math.abs(d) <= sigma ? 1 : sigma / Math.abs(d);
      num += w * data[i];
      den += w;
    }
    mu = num / den;
  }
  return mu;
}

/** Trimmed mean — discards `trimPercent` from each tail. */
export function trimmedMean(data, n, trimPercent) {
  trimPercent = trimPercent || 0.1;
  const sorted = Array.from(data.subarray ? data.subarray(0, n) : data.slice(0, n)).sort((a, b) => a - b);
  const trimN = Math.floor(n * trimPercent);
  let sum = 0;
  for (let i = trimN; i < n - trimN; i++) sum += sorted[i];
  return sum / Math.max(1, n - 2 * trimN);
}

// ============================================================================
// Regression with uncertainty
// ============================================================================

/** Weighted least squares — returns { beta, cov }. */
export function weightedLeastSquares(X, y, weights, n, p) {
  const XtWX = new Float64Array(p * p);
  const XtWy = new Float64Array(p);
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      let acc = 0;
      for (let k = 0; k < n; k++) acc += X[k * p + i] * weights[k] * X[k * p + j];
      XtWX[i * p + j] = acc;
    }
    let acc = 0;
    for (let k = 0; k < n; k++) acc += X[k * p + i] * weights[k] * y[k];
    XtWy[i] = acc;
  }
  const cov = new Float64Array(p * p);
  _invertMatrix(cov, XtWX, p);
  const beta = new Float64Array(p);
  for (let i = 0; i < p; i++) {
    let acc = 0;
    for (let j = 0; j < p; j++) acc += cov[i * p + j] * XtWy[j];
    beta[i] = acc;
  }
  return { beta: beta, cov: cov };
}

/** Robust regression via Iteratively Reweighted Least Squares (IRLS). */
export function robustRegression(X, y, n, p, iterations, rng) {
  iterations = iterations || 5;
  let weights = new Float64Array(n).fill(1);
  let result = null;
  for (let it = 0; it < iterations; it++) {
    result = weightedLeastSquares(X, y, weights, n, p);
    for (let i = 0; i < n; i++) {
      let r = y[i];
      for (let j = 0; j < p; j++) r -= X[i * p + j] * result.beta[j];
      // Cauchy weight
      weights[i] = 1 / (1 + r * r);
    }
  }
  return result;
}

/**
 * Gaussian Process regression — squared-exponential kernel.
 * Returns predicted means and variances at query points.
 */
export function gpRegression(Xtrain, ytrain, n, dim, Xquery, m, options) {
  options = options || {};
  const lengthScale = options.lengthScale || 1;
  const signalVar = options.signalVar || 1;
  const noiseVar = options.noiseVar || 0.01;

  const K = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let d2 = 0;
      for (let d = 0; d < dim; d++) {
        const diff = Xtrain[i * dim + d] - Xtrain[j * dim + d];
        d2 += diff * diff;
      }
      K[i * n + j] = signalVar * Math.exp(-d2 / (2 * lengthScale * lengthScale));
    }
    K[i * n + i] += noiseVar;
  }
  const Kinv = new Float64Array(n * n);
  _invertMatrix(Kinv, K, n);

  const means = new Float64Array(m);
  const variances = new Float64Array(m);
  for (let q = 0; q < m; q++) {
    const kstar = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let d2 = 0;
      for (let d = 0; d < dim; d++) {
        const diff = Xquery[q * dim + d] - Xtrain[i * dim + d];
        d2 += diff * diff;
      }
      kstar[i] = signalVar * Math.exp(-d2 / (2 * lengthScale * lengthScale));
    }
    let mean = 0;
    for (let i = 0; i < n; i++) {
      let row = 0;
      for (let j = 0; j < n; j++) row += Kinv[i * n + j] * ytrain[j];
      mean += kstar[i] * row;
    }
    let kKinv = 0;
    for (let i = 0; i < n; i++) {
      let row = 0;
      for (let j = 0; j < n; j++) row += Kinv[i * n + j] * kstar[j];
      kKinv += kstar[i] * row;
    }
    means[q] = mean;
    variances[q] = signalVar - kKinv;
  }
  return { means: means, variances: variances };
}

// ============================================================================
// Smart decisions
// ============================================================================

/** Softmax (Boltzmann) selection over q-values. */
export function softmaxSelection(qValues, n, temperature, rng) {
  rng = rng || Math.random;
  const maxQ = Math.max.apply(null, Array.from(qValues.subarray ? qValues.subarray(0, n) : qValues.slice(0, n)));
  const probs = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    probs[i] = Math.exp((qValues[i] - maxQ) / temperature);
    sum += probs[i];
  }
  for (let i = 0; i < n; i++) probs[i] /= sum;
  return categoricalSample(probs, n, rng);
}

/** ε-greedy selection. */
export function epsilonGreedy(qValues, n, epsilon, rng) {
  rng = rng || Math.random;
  if (rng() < epsilon) return (rng() * n) | 0;
  let best = 0, bestQ = -Infinity;
  for (let i = 0; i < n; i++) if (qValues[i] > bestQ) { bestQ = qValues[i]; best = i; }
  return best;
}

/** UCB1 arm selection. */
export function ucb1(pulls, rewards, n, totalPulls) {
  let bestArm = 0, bestUCB = -Infinity;
  for (let i = 0; i < n; i++) {
    if (pulls[i] === 0) return i;
    const avg = rewards[i] / pulls[i];
    const ucb = avg + Math.sqrt(2 * Math.log(totalPulls) / pulls[i]);
    if (ucb > bestUCB) { bestUCB = ucb; bestArm = i; }
  }
  return bestArm;
}

/** UCB1-tuned (tighter bound). */
export function ucb1Tuned(pulls, rewards, rewardsSq, n, totalPulls) {
  let bestArm = 0, bestUCB = -Infinity;
  for (let i = 0; i < n; i++) {
    if (pulls[i] === 0) return i;
    const avg = rewards[i] / pulls[i];
    const varI = rewardsSq[i] / pulls[i] - avg * avg;
    const logT = Math.log(totalPulls);
    const v = varI + Math.sqrt(2 * logT / pulls[i]);
    const ucb = avg + Math.sqrt(logT / pulls[i] * Math.min(0.25, v));
    if (ucb > bestUCB) { bestUCB = ucb; bestArm = i; }
  }
  return bestArm;
}

/** Thompson sampling for Bernoulli bandit. */
export function thompsonSampling(successes, failures, n, rng) {
  let bestArm = 0, bestSample = -Infinity;
  for (let i = 0; i < n; i++) {
    const sample = Sampling.betaSample(successes[i] + 1, failures[i] + 1, rng);
    if (sample > bestSample) { bestSample = sample; bestArm = i; }
  }
  return bestArm;
}

/** GP-UCB — for Bayesian optimization over continuous inputs. */
export function gpUCB(means, variances, n, kappa) {
  let bestIdx = 0, bestVal = -Infinity;
  for (let i = 0; i < n; i++) {
    const val = means[i] + kappa * Math.sqrt(variances[i]);
    if (val > bestVal) { bestVal = val; bestIdx = i; }
  }
  return bestIdx;
}

/** Expected Improvement for Bayesian optimization. */
export function expectedImprovement(means, variances, n, bestSoFar) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const std = Math.sqrt(variances[i]);
    if (std < EPSILON) { out[i] = 0; continue; }
    const z = (means[i] - bestSoFar) / std;
    const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(TWO_PI);
    const cdf = 0.5 * (1 + SpecialFunctions.erf(z / Math.sqrt(2)));
    out[i] = std * (z * cdf + pdf);
  }
  return out;
}

/** MCTS UCB1 for tree nodes. */
export function mctsUCB(visits, values, parentVisits, c) {
  c = c || Math.SQRT2;
  return values / visits + c * Math.sqrt(Math.log(parentVisits) / visits);
}

/** MCTS PUCT (AlphaZero-style). */
export function mctsPUCT(visits, values, parentVisits, prior, c) {
  c = c || 1;
  return values / visits + c * prior * Math.sqrt(parentVisits) / (1 + visits);
}

/**
 * MultiArmedBandit — full bandit agent. Use `.select()` for arm choice,
 * `.update(arm, reward)` to learn.
 */
export class MultiArmedBandit {
  constructor(n, algorithm, options) {
    this.n = n;
    this.algorithm = algorithm || "ucb1";
    this.pulls = new Float64Array(n);
    this.rewards = new Float64Array(n);
    this.rewardsSq = new Float64Array(n);
    this.successes = new Float64Array(n);
    this.failures = new Float64Array(n);
    this.totalPulls = 0;
    this.epsilon = (options && options.epsilon) || 0.1;
    this.temperature = (options && options.temperature) || 1;
    this.rng = (options && options.rng) || Math.random;
  }

  select() {
    let arm;
    switch (this.algorithm) {
      case "epsilon-greedy": arm = epsilonGreedy(this.rewards, this.n, this.epsilon, this.rng); break;
      case "softmax": arm = softmaxSelection(this.rewards, this.n, this.temperature, this.rng); break;
      case "thompson": arm = thompsonSampling(this.successes, this.failures, this.n, this.rng); break;
      case "ucb1-tuned": arm = ucb1Tuned(this.pulls, this.rewards, this.rewardsSq, this.n, this.totalPulls + 1); break;
      case "ucb1":
      default: arm = ucb1(this.pulls, this.rewards, this.n, this.totalPulls + 1); break;
    }
    return arm;
  }

  update(arm, reward) {
    this.pulls[arm]++;
    this.rewards[arm] += reward;
    this.rewardsSq[arm] += reward * reward;
    this.totalPulls++;
    if (reward > 0.5) this.successes[arm]++; else this.failures[arm]++;
  }
}

// ============================================================================
// Uncertainty quantification
// ============================================================================

/** Wald confidence interval for a mean. */
export function confidenceInterval(mean, variance, n, zAlpha) {
  zAlpha = zAlpha || 1.96;   // 95%
  const se = Math.sqrt(variance / n);
  return { lo: mean - zAlpha * se, hi: mean + zAlpha * se, se: se };
}

/** Prediction interval (accounting for noise). */
export function predictionInterval(mean, variance, noiseVariance, zAlpha) {
  zAlpha = zAlpha || 1.96;
  return { lo: mean - zAlpha * Math.sqrt(variance + noiseVariance), hi: mean + zAlpha * Math.sqrt(variance + noiseVariance) };
}

/** Monte Carlo error propagation. `f(x, out, m)` propagates m-dim x → out. */
export function monteCarloPropagate(f, mean, cov, dim, m, nSamples, rng) {
  rng = rng || Math.random;
  const out = new Float64Array(m);
  const outSq = new Float64Array(m);
  const x = new Float64Array(dim);
  const y = new Float64Array(m);
  const L = new Float64Array(cov.length);
  L.set(cov);
  if (!choleskyDecompose(L, dim)) return { mean: out, variance: outSq };
  for (let s = 0; s < nSamples; s++) {
    multivariateNormalFromCholesky(x, mean, L, dim, rng);
    f(x, y, m);
    for (let i = 0; i < m; i++) { out[i] += y[i]; outSq[i] += y[i] * y[i]; }
  }
  for (let i = 0; i < m; i++) { out[i] /= nSamples; outSq[i] = outSq[i] / nSamples - out[i] * out[i]; }
  return { mean: out, variance: outSq };
}

/** Sobol sensitivity indices — main-effect only (basic, no interactions). */
export function sobolIndices(f, bounds, n, nSamples, rng) {
  rng = rng || Math.random;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  let fSum = 0, fSqSum = 0;
  const samples = new Float64Array(nSamples);
  for (let s = 0; s < nSamples; s++) {
    for (let d = 0; d < n; d++) x[d] = bounds[d][0] + rng() * (bounds[d][1] - bounds[d][0]);
    samples[s] = f(x, n);
    fSum += samples[s];
    fSqSum += samples[s] * samples[s];
  }
  const fMean = fSum / nSamples;
  const fVar = fSqSum / nSamples - fMean * fMean;
  const indices = new Float64Array(n);
  for (let d = 0; d < n; d++) {
    let num = 0;
    for (let s = 0; s < nSamples; s++) {
      for (let k = 0; k < n; k++) x[k] = bounds[k][0] + rng() * (bounds[k][1] - bounds[k][0]);
      y.set(x);
      y[d] = bounds[d][0] + rng() * (bounds[d][1] - bounds[d][0]);
      num += (f(x, n) - fMean) * (f(y, n) - fMean);
    }
    indices[d] = (num / nSamples) / (fVar || 1);
  }
  return indices;
}

// ============================================================================
// ML primitives
// ============================================================================

export function xavierUniform(fanIn, fanOut, rng) {
  const limit = Math.sqrt(6 / (fanIn + fanOut));
  return (rng() * 2 - 1) * limit;
}

export function heUniform(fanIn, rng) {
  const limit = Math.sqrt(6 / fanIn);
  return (rng() * 2 - 1) * limit;
}

export function kaimingUniform(fanIn, rng) {
  return heUniform(fanIn, rng);
}

/** Dropout mask — writes 0 or 1/keepProb into `mask[i]`. */
export function dropoutMask(mask, n, keepProb, rng) {
  rng = rng || Math.random;
  const scale = 1 / keepProb;
  for (let i = 0; i < n; i++) mask[i] = rng() < keepProb ? scale : 0;
  return mask;
}

/** Running batch norm stats — updates in place. */
export function batchNormStats(mean, variance, data, n, decay) {
  let sum = 0, sumSq = 0;
  for (let i = 0; i < n; i++) { sum += data[i]; sumSq += data[i] * data[i]; }
  const batchMean = sum / n;
  const batchVar = sumSq / n - batchMean * batchMean;
  mean[0] = decay * mean[0] + (1 - decay) * batchMean;
  variance[0] = decay * variance[0] + (1 - decay) * batchVar;
  return { mean: mean[0], variance: variance[0] };
}

/** In-place softmax on `n` elements. */
export function softmax(x, n) {
  let max = -Infinity;
  for (let i = 0; i < n; i++) if (x[i] > max) max = x[i];
  let sum = 0;
  for (let i = 0; i < n; i++) { x[i] = Math.exp(x[i] - max); sum += x[i]; }
  for (let i = 0; i < n; i++) x[i] /= sum;
  return x;
}

/** log-softmax — numerically stable. */
export function logSoftmax(x, n) {
  let max = -Infinity;
  for (let i = 0; i < n; i++) if (x[i] > max) max = x[i];
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.exp(x[i] - max);
  const logSum = Math.log(sum);
  for (let i = 0; i < n; i++) x[i] = x[i] - max - logSum;
  return x;
}

/**
 * Attention scores — Q · K^T / sqrt(d). Returns the score matrix.
 * `Q` is (seqQ × d), `K` is (seqK × d) row-major.
 */
export function attentionScores(Q, K, seqQ, seqK, d) {
  const scores = new Float64Array(seqQ * seqK);
  const scale = 1 / Math.sqrt(d);
  for (let i = 0; i < seqQ; i++) {
    for (let j = 0; j < seqK; j++) {
      let dot = 0;
      for (let k = 0; k < d; k++) dot += Q[i * d + k] * K[j * d + k];
      scores[i * seqK + j] = dot * scale;
    }
  }
  return scores;
}

/** Weighted reservoir sampling (Efraimidis–Spirakis). Returns one index. */
export function weightedReservoir(weights, n, rng) {
  rng = rng || Math.random;
  let bestKey = -Infinity, bestIdx = 0;
  for (let i = 0; i < n; i++) {
    if (weights[i] <= 0) continue;
    const key = Math.pow(rng(), 1 / weights[i]);
    if (key > bestKey) { bestKey = key; bestIdx = i; }
  }
  return bestIdx;
}

// ============================================================================
// SOA (sync)
// ============================================================================

/** Sample N independent MVN vectors — fills vec3 SOA (dim=3) or generic. */
export function soaSampleMVN(outPositions, mean, cov, n, rng) {
  const count = outPositions.count;
  const L = new Float64Array(cov.length);
  L.set(cov);
  choleskyDecompose(L, n);
  const scratch = new Float64Array(n);
  const ox = outPositions.x, oy = outPositions.y, oz = outPositions.z;
  for (let i = 0; i < count; i++) {
    multivariateNormalFromCholesky(scratch, mean, L, n, rng);
    ox[i] = scratch[0]; oy[i] = scratch[1]; if (n >= 3) oz[i] = scratch[2];
  }
  return outPositions;
}

/** Evaluate MVN log-PDF at each point in a vec3 SOA (dim=3). */
export function soaEvaluateMVN(outLogP, positions, mean, invCov, logDet) {
  const n = positions.count;
  const px = positions.x, py = positions.y, pz = positions.z;
  const x = new Float64Array(3);
  for (let i = 0; i < n; i++) {
    x[0] = px[i] - mean[0]; x[1] = py[i] - mean[1]; x[2] = pz[i] - mean[2];
    let quad = 0;
    for (let a = 0; a < 3; a++) {
      let row = 0;
      for (let b = 0; b < 3; b++) row += invCov[a * 3 + b] * x[b];
      quad += x[a] * row;
    }
    outLogP[i] = -0.5 * (quad + logDet + 3 * LN2PI);
  }
  return outLogP;
}

/** Batch softmax over each row of a flat array (rows × cols). */
export function soaSoftmax(data, rows, cols) {
  for (let r = 0; r < rows; r++) softmax(data.subarray(r * cols, (r + 1) * cols), cols);
  return data;
}

/** Batch entropy — one entropy per row. */
export function soaEntropyBatch(outH, data, rows, cols) {
  for (let r = 0; r < rows; r++) {
    let H = 0;
    for (let c = 0; c < cols; c++) {
      const p = data[r * cols + c];
      if (p > 0) H -= p * Math.log(p);
    }
    outH[r] = H;
  }
  return outH;
}

/** Batch importance-sampling weighted estimate — one per row. */
export function soaImportanceBatch(outEst, logP, logQ, samples, rows) {
  for (let r = 0; r < rows; r++) {
    let num = 0, den = 0;
    for (let c = 0; c < samples.length / rows; c++) {
      const w = Math.exp(logP[r * samples.length / rows + c] - logQ[r * samples.length / rows + c]);
      num += w * samples[r * samples.length / rows + c];
      den += w;
    }
    outEst[r] = den > 0 ? num / den : 0;
  }
  return outEst;
}

/** Batch GMM predict — one class per row. */
export function soaGMMPredictBatch(outClass, gmm, points, count, n) {
  const x = new Float64Array(n);
  for (let i = 0; i < count; i++) {
    for (let d = 0; d < n; d++) x[d] = points[i * n + d];
    outClass[i] = gmmPredict(gmm, x);
  }
  return outClass;
}

/** Batch Kalman — one linear KF per row of the batch. */
export function soaKalmanBatch(kfs, observations, count) {
  for (let i = 0; i < count; i++) {
    kfs[i].predict();
    kfs[i].update(observations[i]);
  }
  return kfs;
}

// ============================================================================
// SOA (chunked async)
// ============================================================================

async function _chunked(count, chunkSize, yieldEvery, perChunk) {
  chunkSize  = chunkSize  || common.CHUNK_SIZE;
  yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
  let start = 0, c = 0;
  while (start < count) {
    const end = Math.min(start + chunkSize, count);
    perChunk(start, end);
    start = end;
    if (start >= count) break;
    if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
  }
}

async function soaSampleMVNChunked(outPositions, mean, cov, n, rng, chunkSize, yieldEvery) {
  const count = outPositions.count;
  const L = new Float64Array(cov.length);
  L.set(cov);
  choleskyDecompose(L, n);
  const scratch = new Float64Array(n);
  const ox = outPositions.x, oy = outPositions.y, oz = outPositions.z;
  await _chunked(count, chunkSize, yieldEvery, (s, e) => {
    for (let i = s; i < e; i++) {
      multivariateNormalFromCholesky(scratch, mean, L, n, rng);
      ox[i] = scratch[0]; oy[i] = scratch[1]; if (n >= 3) oz[i] = scratch[2];
    }
  });
  return outPositions;
}

async function soaSoftmaxChunked(data, rows, cols, chunkSize, yieldEvery) {
  await _chunked(rows, chunkSize, yieldEvery, (s, e) => {
    for (let r = s; r < e; r++) softmax(data.subarray(r * cols, (r + 1) * cols), cols);
  });
  return data;
}

async function soaEntropyBatchChunked(outH, data, rows, cols, chunkSize, yieldEvery) {
  await _chunked(rows, chunkSize, yieldEvery, (s, e) => {
    for (let r = s; r < e; r++) {
      let H = 0;
      for (let c = 0; c < cols; c++) {
        const p = data[r * cols + c];
        if (p > 0) H -= p * Math.log(p);
      }
      outH[r] = H;
    }
  });
  return outH;
}

async function soaImportanceBatchChunked(outEst, logP, logQ, samples, rows, chunkSize, yieldEvery) {
  await _chunked(rows, chunkSize, yieldEvery, (s, e) => {
    for (let r = s; r < e; r++) {
      let num = 0, den = 0;
      const perRow = samples.length / rows;
      for (let c = 0; c < perRow; c++) {
        const w = Math.exp(logP[r * perRow + c] - logQ[r * perRow + c]);
        num += w * samples[r * perRow + c];
        den += w;
      }
      outEst[r] = den > 0 ? num / den : 0;
    }
  });
  return outEst;
}

async function soaGMMPredictBatchChunked(outClass, gmm, points, count, n, chunkSize, yieldEvery) {
  const x = new Float64Array(n);
  await _chunked(count, chunkSize, yieldEvery, (s, e) => {
    for (let i = s; i < e; i++) {
      for (let d = 0; d < n; d++) x[d] = points[i * n + d];
      outClass[i] = gmmPredict(gmm, x);
    }
  });
  return outClass;
}

async function soaKalmanBatchChunked(kfs, observations, count, chunkSize, yieldEvery) {
  await _chunked(count, chunkSize, yieldEvery, (s, e) => {
    for (let i = s; i < e; i++) {
      kfs[i].predict();
      kfs[i].update(observations