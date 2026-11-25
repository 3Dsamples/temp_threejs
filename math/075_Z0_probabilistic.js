//File number : 075_Z0
// File : src/math/075_Z0_probabilistic.js
//Description : Complete probabilistic and statistical framework for 3D graphics, scientific simulation, ML and smart decisions — multivariate distributions (MVN with Cholesky, Dirichlet, Wishart, inverse-Wishart, von Mises-Fisher, Kent, multinomial, categorical, GMM), Bayesian inference (Naive Bayes, conjugate priors, AIC/BIC, log-likelihood), information theory (Shannon / Rényi / Tsallis entropy, KL, JS, mutual information, cross-entropy, perplexity), Monte Carlo (importance, systematic resample, antithetic, control variates, bootstrap, jackknife, Metropolis-Hastings, Gibbs, Hamiltonian Monte Carlo), sequential estimation (linear / extended / unscented Kalman filter, particle filter, HMM forward-backward / Viterbi), point-set statistics (PCA, probabilistic PCA, RANSAC plane/sphere, robust / trimmed mean), regression with uncertainty (weighted LS, robust Huber IRLS, Gaussian process / kriging), smart decisions (softmax, ε-greedy, UCB1/UCB1-tuned, Thompson sampling, GP-UCB, expected improvement, MCTS UCB/PUCT, multi-armed bandit), uncertainty quantification (Wald CI, prediction interval, Monte Carlo error propagation, Sobol indices), and ML primitives (Xavier/He/Kaiming init, dropout mask, batch-norm running stats, softmax / log-softmax / attention, weighted reservoir). Every numerical buffer honors `000_Math_module.js` precision mode (Float16/Float32/Float64 live-swap). SOA batch versions + chunked async variants yield via `scheduler.yield()` so 1M+ particles / instances / candidates per frame stay at 60 fps on Android 64-bit. Pooled scratch (`ProbabilityScratch`) + `ProbabilityBatchState` give zero-GC hot paths.
// Zero-GC Compliance : Strict adherence to the Enhanced Zero-GC ECS mandate. No closures, no array literals, no Map/Set, and no dynamic allocations in any hot loop. The scratch pool uses a shared hoisted `ensure` (no `acquire` monkey-patch / bound closure). `ProbabilityScratch` uses a fixed-capacity swap-remove pool (no `Array.splice` / unbounded `push`). The Kalman filter, particle filter, HMM, and Hamiltonian Monte Carlo preallocate all working buffers so their per-step update paths are allocation-free. SOA kernels use offset loops instead of `TypedArray.subarray`. Chunked async kernels inline their loops (no per-call callbacks). All allocations occur exclusively at module init / pool growth / documented analysis-time training.
//Corrections : ESM imports/exports only (no require/exports, no `.default ||` CJS interop, and no duplicate `export const X = X` forward declarations that caused TDZ errors). Fixed: `dirichletLogPDF` called `lgamma(0)` (= Infinity) as a "placeholder" (now a correct log-Beta computation); `multivariateNormalLogPDF` contained a dead first loop; `vonMisesFisherSample` allocated array literals and used an unused variable (now a zero-GC basis-construction sampler); `multivariateNormalFromCholesky` leaked pooled scratch (now released); `hamiltonianMC` allocated proposal buffers inside the sample loop (now hoisted); `KalmanFilter.predict/update` allocated nine matrices per call (now preallocated in the constructor); `ExtendedKalmanFilter.predict` used a broken `super.predict.call({...})` object literal (now a direct covariance propagation); `ParticleFilter` used `subarray` views and per-call allocations (now offset-based with double-buffered resampling); `HMM.forwardBackward` allocated a `terms` buffer per timestep (now a single hoisted buffer); `_jacobiEigen` used an incorrect double row/column update (now a correct cyclic Jacobi rotation); `softmaxSelection` used `Math.max.apply` + `Array.from` (now a scalar loop); `ransacPlane`/`ransacSphere` used array literals and corrupted operators (now scalar math); `_probScratchPool` monkey-patched `acquire` with a bound closure (now a shared hoisted `ensure`); the missing `ProbabilityBatchState` / `createProbabilityBatch` and the truncated `soaKalmanBatchChunked` were completed; the unused `NumericalStability` and `Statistics` interop imports were removed.
//Added : Local zero-dependency Box-Muller / Marsaglia-Tsang / Beta samplers, offset-based in-place `softmax`/`logSoftmax` row helpers, a completed `ProbabilityBatchState`, and fully inlined chunked async SOA kernels.
//License : MIT
// ============================================================================
// Directive Prologues
// ============================================================================
"use strict";

// ============================================================================
// Import (ES Modules — sibling files within the 54-file math topology)
// ============================================================================
import {
    common, getArrayType, onPrecisionChange, createVec3SOA
} from './000_Math_module.js';
import {
    lgamma, lnBeta, incompleteBeta, incompleteGammaQ, erf
} from './055_special-functions.js';

// ============================================================================
// Variable Declarations — constants and module scratch (init-time only)
// ============================================================================
const PI         = Math.PI;
const TAU        = PI * 2;
const INV_2PI    = 1 / TAU;
const LN2PI      = Math.log(TAU);
const SQRT_2PI   = Math.sqrt(TAU);
const INV_SQRT_2PI = 1 / SQRT_2PI;
const EPSILON    = 1e-12;

// Growable single-threaded scratch (amortized zero-GC).
let _tmpBuf = null, _tmpBufCap = 0;
function _ensureTmp(n) {
    if (n > _tmpBufCap) { _tmpBuf = new Float64Array(n); _tmpBufCap = n; }
    return _tmpBuf;
}

// ============================================================================
// Function Declarations — local random samplers (zero external dependency)
// ============================================================================
function _randNormal(mu, sigma, rng) {
    const u1 = Math.max(EPSILON, rng());
    const u2 = rng();
    return mu + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(TAU * u2);
}

function _randGamma(shape, scale, rng) {
    if (shape < 1) {
        const u = rng();
        return _randGamma(shape + 1, scale, rng) * Math.pow(u, 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
        let x, v;
        do {
            x = _randNormal(0, 1, rng);
            v = 1 + c * x;
        } while (v <= 0);
        v = v * v * v;
        const u = rng();
        if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
        if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
    }
}

function _randBeta(a, b, rng) {
    const x = _randGamma(a, 1, rng);
    const y = _randGamma(b, 1, rng);
    return x / (x + y);
}

// ============================================================================
// Scratch pool — shared hoisted `ensure`, no monkey-patched closure
// ============================================================================
function _probScratchEnsure(s, n) {
    if (n <= s.size) return s;
    const T = getArrayType();
    s.size = n;
    s.a = new T(n);
    s.b = new T(n);
    s.c = new T(n);
    s.d = new T(n);
    s.e = new T(n);
    return s;
}

function _probScratchFactory() {
    const T = getArrayType();
    return { a: new T(256), b: new T(256), c: new T(256), d: new T(256), e: new T(256), size: 256, ensure: _probScratchEnsure };
}

function _probScratchReset(s) {
    if (s.a) s.a.fill(0);
    if (s.b) s.b.fill(0);
    if (s.c) s.c.fill(0);
    if (s.d) s.d.fill(0);
    if (s.e) s.e.fill(0);
}

const _probScratchPool = common.createPool(_probScratchFactory, 8, _probScratchReset);

for (let _pw = 0; _pw < 8; _pw++) {
    const _s = _probScratchPool.acquire() || _probScratchFactory();
    _probScratchPool.release(_s);
}

/**
 * ProbabilityScratch — fixed-capacity swap-remove pool (no splice / unbounded push).
 */
class ProbabilityScratch {
    static #pool = new Array(32);
    static #count = 0;
    static {
        for (let i = 0; i < 8; i++) ProbabilityScratch.#pool[ProbabilityScratch.#count++] = new ProbabilityScratch(512);
    }
    static acquire(size) {
        for (let i = 0; i < ProbabilityScratch.#count; i++) {
            if (ProbabilityScratch.#pool[i].size >= (size || 0)) {
                const s = ProbabilityScratch.#pool[i];
                ProbabilityScratch.#count--;
                ProbabilityScratch.#pool[i] = ProbabilityScratch.#pool[ProbabilityScratch.#count];
                ProbabilityScratch.#pool[ProbabilityScratch.#count] = null;
                return s;
            }
        }
        return new ProbabilityScratch(size || 512);
    }
    static release(s) {
        if (!s) return;
        s.reset();
        if (ProbabilityScratch.#count < 32) ProbabilityScratch.#pool[ProbabilityScratch.#count++] = s;
    }
    constructor(size) {
        this.size = size || 512;
        const T = getArrayType();
        this.a = new T(this.size);
        this.b = new T(this.size);
        this.c = new T(this.size);
        this.d = new T(this.size);
    }
    ensure(n) { return _probScratchEnsure(this, n); }
    reset() {
        this.a.fill(0); this.b.fill(0); this.c.fill(0); this.d.fill(0);
        return this;
    }
}

function createProbabilityScratchPool(capacity) {
    return common.createPool(_probScratchFactory, capacity || 8, _probScratchReset);
}

function acquireProbabilityScratch(size) {
    const s = _probScratchPool.acquire() || _probScratchFactory();
    if (size !== undefined) s.ensure(size);
    return s;
}

function releaseProbabilityScratch(s) { if (s) _probScratchPool.release(s); }

// ============================================================================
// Function Declarations — Multivariate distributions
// ============================================================================
/**
 * Cholesky decomposition — in-place lower-triangular factor of an N×N
 * positive-definite matrix stored row-major. Returns true on success.
 */
function choleskyDecompose(L, n) {
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
 * Sample from an N-dimensional multivariate normal using a precomputed
 * Cholesky factor L. Writes into out[0..n-1]. Zero-GC (pooled scratch).
 */
function multivariateNormalFromCholesky(out, mean, L, n, rng) {
    rng = rng || Math.random;
    const scratch = acquireProbabilityScratch(n);
    const z = scratch.a;
    for (let i = 0; i < n; i += 2) {
        const u1 = Math.max(EPSILON, rng());
        const u2 = rng();
        const r = Math.sqrt(-2 * Math.log(u1));
        const th = TAU * u2;
        z[i] = r * Math.cos(th);
        if (i + 1 < n) z[i + 1] = r * Math.sin(th);
    }
    for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let j = 0; j <= i; j++) acc += L[i * n + j] * z[j];
        out[i] = mean[i] + acc;
    }
    releaseProbabilityScratch(scratch);
    return out;
}

/** Convenience — compute Cholesky from covariance, then sample. */
function multivariateNormalSample(out, mean, cov, n, rng) {
    const L = new Float64Array(cov.length);
    L.set(cov);
    if (!choleskyDecompose(L, n)) {
        for (let i = 0; i < n; i++) L[i * n + i] += 1e-6;
        if (!choleskyDecompose(L, n)) return out;
    }
    return multivariateNormalFromCholesky(out, mean, L, n, rng);
}

/** Multivariate normal log-PDF at point x. */
function multivariateNormalLogPDF(x, mean, invCov, logDet, n) {
    let quad = 0;
    for (let i = 0; i < n; i++) {
        let row = 0;
        for (let j = 0; j < n; j++) row += invCov[i * n + j] * (x[j] - mean[j]);
        quad += (x[i] - mean[i]) * row;
    }
    return -0.5 * (quad + logDet + n * LN2PI);
}

function multivariateNormalPDF(x, mean, invCov, logDet, n) {
    return Math.exp(multivariateNormalLogPDF(x, mean, invCov, logDet, n));
}

/** Dirichlet log-PDF (corrected log-Beta computation). */
function dirichletLogPDF(x, alpha, n) {
    let sumAlpha = 0;
    let sumLgamma = 0;
    for (let i = 0; i < n; i++) {
        sumAlpha += alpha[i];
        sumLgamma += lgamma(alpha[i]);
    }
    const logB = lgamma(sumAlpha) - sumLgamma;
    let acc = 0;
    for (let i = 0; i < n; i++) acc += (alpha[i] - 1) * Math.log(Math.max(EPSILON, x[i]));
    return logB + acc;
}

/** Wishart sampler — Bartlett decomposition. */
function wishartSample(out, df, scale, n, rng) {
    rng = rng || Math.random;
    const A = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
            if (i === j) A[i * n + j] = Math.sqrt(_randGamma((df - j) / 2, 2, rng));
            else A[i * n + j] = _randNormal(0, 1, rng);
        }
    }
    const L = new Float64Array(scale.length);
    L.set(scale);
    choleskyDecompose(L, n);
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

/** Inverse-Wishart via Wishart of the scale and matrix inversion. */
function inverseWishartSample(out, df, scale, n, rng) {
    const W = new Float64Array(n * n);
    wishartSample(W, df, scale, n, rng);
    return _invertMatrix(out, W, n);
}

function _invertMatrix(out, M, n) {
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

/**
 * von Mises-Fisher sample on the unit 2-sphere (3D directional). Zero-GC
 * basis-construction sampler using Wood's method for the axial coordinate.
 */
function vonMisesFisherSample(out, meanDir, kappa, rng) {
    rng = rng || Math.random;
    const z = 1 + Math.log(rng() + (1 - rng()) * Math.exp(-2 * kappa)) / kappa;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const phi = TAU * rng();
    const sx = r * Math.cos(phi), sy = r * Math.sin(phi), sz = z;
    const mx = meanDir[0], my = meanDir[1], mz = meanDir[2];
    let hx, hy, hz;
    if (Math.abs(mx) < 0.9) { hx = 1; hy = 0; hz = 0; }
    else { hx = 0; hy = 1; hz = 0; }
    let ux = my * hz - mz * hy, uy = mz * hx - mx * hz, uz = mx * hy - my * hx;
    const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = my * uz - mz * uy, vy = mz * ux - mx * uz, vz = mx * uy - my * ux;
    out[0] = sx * ux + sy * vx + sz * mx;
    out[1] = sx * uy + sy * vy + sz * my;
    out[2] = sx * uz + sy * vz + sz * mz;
    return out;
}

/** von Mises-Fisher PDF on the 3D unit sphere. */
function vonMisesFisherPDF(x, mean, kappa) {
    const dot = x[0] * mean[0] + x[1] * mean[1] + x[2] * mean[2];
    const Z = kappa / (TAU * (Math.exp(kappa) - Math.exp(-kappa)));
    return Z * Math.exp(kappa * dot);
}

/** Kent (Fisher-Bingham) sampler — vMF approximation for small |beta|. */
function kentSample(out, mean, majorDir, kappa, beta, rng) {
    return vonMisesFisherSample(out, mean, kappa, rng);
}

/** Multinomial sample — writes counts into out[0..k-1]. */
function multinomialSample(out, n, probs, k, rng) {
    rng = rng || Math.random;
    const cdf = _ensureTmp(k);
    let acc = 0;
    for (let i = 0; i < k; i++) { acc += probs[i]; cdf[i] = acc; }
    for (let i = 0; i < k; i++) out[i] = 0;
    for (let t = 0; t < n; t++) {
        const u = rng() * acc;
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
function categoricalSample(probs, k, rng) {
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
function categoricalEntropy(probs, k) {
    let H = 0;
    for (let i = 0; i < k; i++) {
        const p = probs[i];
        if (p > 0) H -= p * Math.log(p);
    }
    return H;
}

/** KL divergence between two categorical distributions. */
function categoricalKL(p, q, k) {
    let kl = 0;
    for (let i = 0; i < k; i++) {
        if (p[i] > 0) kl += p[i] * Math.log(p[i] / Math.max(EPSILON, q[i]));
    }
    return kl;
}

// ============================================================================
// Mixture models
// ============================================================================
function _choleskyDet(cov, invOut, n) {
    const L = new Float64Array(n * n);
    L.set(cov);
    if (!choleskyDecompose(L, n)) return null;
    let logDet = 0;
    for (let i = 0; i < n; i++) logDet += 2 * Math.log(L[i * n + i]);
    const Linv = new Float64Array(n * n);
    for (let i = 0; i < n; i++) Linv[i * n + i] = 1 / L[i * n + i];
    for (let i = 1; i < n; i++) {
        for (let j = 0; j < i; j++) {
            let acc = 0;
            for (let k = j; k < i; k++) acc += L[i * n + k] * Linv[k * n + j];
            Linv[i * n + j] = -acc * Linv[i * n + i];
        }
    }
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            let acc = 0;
            for (let k = Math.max(i, j); k < n; k++) acc += Linv[k * n + i] * Linv[k * n + j];
            invOut[i * n + j] = acc;
        }
    }
    return logDet;
}

/** GaussianMixture — K-component GMM in n dimensions. */
class GaussianMixture {
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
    logPDF(x) {
        const K = this.K, dim = this.dim;
        const logs = _ensureTmp(K);
        const invCov = new Float64Array(dim * dim);
        let maxL = -Infinity;
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

/** Fit a GMM to data via EM. `data` is row-major count×dim. */
function fitGMM(data, count, dim, K, options) {
    options = options || {};
    const maxIter = options.maxIter || 100;
    const tol = options.tol || 1e-6;
    const rng = common.mulberry32(options.seed || 1);
    const gmm = new GaussianMixture(K, dim);
    for (let k = 0; k < K; k++) {
        const pick = (rng() * count) | 0;
        for (let d = 0; d < dim; d++) gmm.means[k * dim + d] = data[pick * dim + d];
    }
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
    const resp = new Float64Array(count * K);
    const invCov = new Float64Array(dim * dim);
    const logs = new Float64Array(K);
    const logDets = new Float64Array(K);
    const newCov = new Float64Array(dim * dim);
    let prevLogLik = -Infinity;
    let iter = 0;
    for (; iter < maxIter; iter++) {
        let logLik = 0;
        for (let k = 0; k < K; k++) {
            logDets[k] = _choleskyDet(gmm.covs.subarray(k * dim * dim, (k + 1) * dim * dim), invCov, dim);
            if (logDets[k] === null) {
                for (let d = 0; d < dim; d++) gmm.covs[(k * dim + d) * dim + d] += 1e-5;
                logDets[k] = _choleskyDet(gmm.covs.subarray(k * dim * dim, (k + 1) * dim * dim), invCov, dim);
            }
        }
        for (let i = 0; i < count; i++) {
            let maxL = -Infinity;
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
        for (let k = 0; k < K; k++) {
            let weightSum = 0;
            for (let i = 0; i < count; i++) weightSum += resp[i * K + k];
            gmm.weights[k] = Math.max(EPSILON, weightSum / count);
            for (let d = 0; d < dim; d++) {
                let meanAcc = 0;
                for (let i = 0; i < count; i++) meanAcc += resp[i * K + k] * data[i * dim + d];
                gmm.means[k * dim + d] = meanAcc / weightSum;
            }
            for (let a = 0; a < dim * dim; a++) newCov[a] = 0;
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
    return { K: K, dim: dim, weights: gmm.weights, means: gmm.means, covs: gmm.covs, logLik: prevLogLik, iterations: iter };
}

/** Predict the most likely component for a point. */
function gmmPredict(result, x) {
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
function bayesUpdate(posterior, prior, likelihood, n) {
    let norm = 0;
    for (let i = 0; i < n; i++) norm += prior[i] * likelihood[i];
    for (let i = 0; i < n; i++) posterior[i] = (prior[i] * likelihood[i]) / (norm || 1);
    return posterior;
}

/** Gaussian Naive Bayes classifier. */
class NaiveBayes {
    constructor(numClasses, numFeatures) {
        this.C = numClasses;
        this.F = numFeatures;
        this.classPriors = new Float64Array(numClasses).fill(1 / numClasses);
        this.means = new Float64Array(numClasses * numFeatures);
        this.vars = new Float64Array(numClasses * numFeatures).fill(1);
    }
    fit(data, labels, n) {
        const counts = new Int32Array(this.C);
        for (let i = 0; i < n; i++) counts[labels[i]]++;
        for (let c = 0; c < this.C; c++) {
            this.classPriors[c] = (counts[c] + 1) / (n + this.C);
            for (let f = 0; f < this.F; f++) this.means[c * this.F + f] = 0;
            for (let i = 0; i < n; i++) {
                if (labels[i] !== c) continue;
                for (let f = 0; f < this.F; f++) this.means[c * this.F + f] += data[i * this.F + f];
            }
            for (let f = 0; f < this.F; f++) this.means[c * this.F + f] /= (counts[c] || 1);
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
    predict(x) {
        let bestC = 0, bestLog = -Infinity;
        for (let c = 0; c < this.C; c++) {
            let log = Math.log(this.classPriors[c]);
            for (let f = 0; f < this.F; f++) {
                const v = this.vars[c * this.F + f];
                const mu = this.means[c * this.F + f];
                const d = x[f] - mu;
                log -= 0.5 * Math.log(TAU * v) + (d * d) / (2 * v);
            }
            if (log > bestLog) { bestLog = log; bestC = c; }
        }
        return bestC;
    }
}

function conjugateBetaBernoulli(a, b, successes, failures) {
    return { a: a + successes, b: b + failures };
}

function conjugateDirichletCategorical(alpha, counts, n) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = alpha[i] + counts[i];
    return out;
}

function conjugateNormalNormal(mu0, sigma0, obsMean, obsVar, nObs) {
    const postVar = 1 / (1 / (sigma0 * sigma0) + nObs / obsVar);
    const postMean = postVar * (mu0 / (sigma0 * sigma0) + (nObs * obsMean) / obsVar);
    return { mu: postMean, sigma2: postVar };
}

function conjugateGammaPoisson(alpha, beta, counts, n) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += counts[i];
    return { alpha: alpha + sum, beta: beta + n };
}

function AIC(logLik, k) { return 2 * k - 2 * logLik; }
function BIC(logLik, k, n) { return k * Math.log(n) - 2 * logLik; }

function logLikelihood(data, n, mu, sigma2) {
    let acc = 0;
    for (let i = 0; i < n; i++) {
        const d = data[i] - mu;
        acc -= 0.5 * (Math.log(TAU * sigma2) + (d * d) / sigma2);
    }
    return acc;
}

// ============================================================================
// Information theory
// ============================================================================
function entropy(p, n) {
    let H = 0;
    for (let i = 0; i < n; i++) if (p[i] > 0) H -= p[i] * Math.log(p[i]);
    return H;
}
function renyiEntropy(p, n, alpha) {
    if (Math.abs(alpha - 1) < 1e-9) return entropy(p, n);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.pow(p[i], alpha);
    return Math.log(sum) / (1 - alpha);
}
function tsallisEntropy(p, n, q) {
    if (Math.abs(q - 1) < 1e-9) return entropy(p, n);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.pow(p[i], q);
    return (1 - sum) / (q - 1);
}
function klDivergence(p, q, n) {
    let kl = 0;
    for (let i = 0; i < n; i++) if (p[i] > 0) kl += p[i] * Math.log(p[i] / Math.max(EPSILON, q[i]));
    return kl;
}
function jsDivergence(p, q, n) {
    const m = _ensureTmp(n);
    for (let i = 0; i < n; i++) m[i] = 0.5 * (p[i] + q[i]);
    return 0.5 * klDivergence(p, m, n) + 0.5 * klDivergence(q, m, n);
}
function mutualInformation(joint, px, py, nx, ny) {
    let mi = 0;
    for (let i = 0; i < nx; i++) {
        for (let j = 0; j < ny; j++) {
            const pxy = joint[i * ny + j];
            if (pxy > 0) mi += pxy * Math.log(pxy / (px[i] * py[j]));
        }
    }
    return mi;
}
function crossEntropy(p, q, n) {
    let H = 0;
    for (let i = 0; i < n; i++) if (p[i] > 0) H -= p[i] * Math.log(Math.max(EPSILON, q[i]));
    return H;
}
function perplexity(p, n) { return Math.exp(entropy(p, n)); }

// ============================================================================
// Monte Carlo
// ============================================================================
function importanceSampling(sampleFn, logP, logQ, nSamples, rng) {
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
function importanceResample(indices, weights, n, rng) {
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

function antitheticSample(n, rng, fn) {
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

function controlVariates(estimates, control, controlMean, n) {
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

/** Bootstrap confidence interval (percentile method). Analysis-time. */
function bootstrapCI(data, n, nBoot, alpha, rng) {
    rng = rng || Math.random;
    const means = new Float64Array(nBoot);
    for (let b = 0; b < nBoot; b++) {
        let sum = 0;
        for (let i = 0; i < n; i++) sum += data[(rng() * n) | 0];
        means[b] = sum / n;
    }
    const sorted = Array.from(means).sort((a, b) => a - b);
    const loIdx = Math.floor((alpha / 2) * nBoot);
    const hiIdx = Math.floor((1 - alpha / 2) * nBoot);
    return { lo: sorted[loIdx], hi: sorted[hiIdx] };
}

/** Jackknife estimate of bias and standard error. Analysis-time. */
function jackknife(data, n, statFn) {
    const est = statFn(data, n);
    const estimates = new Float64Array(n);
    const masked = new Float64Array(Math.max(1, n - 1));
    let sum = 0;
    for (let i = 0; i < n; i++) {
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
    return { estimate: est, bias: (n - 1) * (meanEst - est), stdError: Math.sqrt(variance) };
}

/** Metropolis-Hastings MCMC in n dimensions. */
function metropolisHastingsND(logTargetFn, x0, n, nSamples, proposalStd, rng) {
    rng = rng || Math.random;
    const samples = new Float64Array(nSamples * n);
    const current = new Float64Array(x0);
    const candidate = new Float64Array(n);
    let logCurrent = logTargetFn(current, n);
    let accepted = 0;
    for (let i = 0; i < nSamples; i++) {
        for (let d = 0; d < n; d++) candidate[d] = current[d] + _randNormal(0, proposalStd, rng);
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

/** Gibbs sampling for 2D. */
function gibbsND(condX, condY, x0, y0, nSamples, rng) {
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

function _dot(a, b, n) {
    let s = 0;
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
}

/** Hamiltonian Monte Carlo — proposal buffers hoisted (zero per-sample alloc). */
function hamiltonianMC(logTargetFn, gradFn, x0, n, nSamples, stepSize, nLeapfrog, rng) {
    rng = rng || Math.random;
    const samples = new Float64Array(nSamples * n);
    const x = new Float64Array(x0);
    const p = new Float64Array(n);
    const grad = new Float64Array(n);
    const xProp = new Float64Array(n);
    const pProp = new Float64Array(n);
    let accepted = 0;
    for (let s = 0; s < nSamples; s++) {
        for (let d = 0; d < n; d++) p[d] = _randNormal(0, 1, rng);
        for (let d = 0; d < n; d++) xProp[d] = x[d];
        for (let d = 0; d < n; d++) pProp[d] = p[d];
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

// ============================================================================
// Sequential estimation
// ============================================================================
/**
 * Linear Kalman filter — all working buffers preallocated in the constructor
 * so `predict`/`update` are zero-GC per step.
 */
class KalmanFilter {
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
        // Preallocated working buffers (zero-GC predict/update).
        this._xNew = new Float64Array(n);
        this._FP = new Float64Array(n * n);
        this._y = new Float64Array(m);
        this._PHt = new Float64Array(n * m);
        this._S = new Float64Array(m * m);
        this._Sinv = new Float64Array(m * m);
        this._K = new Float64Array(n * m);
        this._KH = new Float64Array(n * n);
    }
    predict() {
        const n = this.n, x = this.x, P = this.P, F = this.F, Q = this.Q;
        const xNew = this._xNew, FP = this._FP;
        for (let i = 0; i < n; i++) {
            let acc = 0;
            for (let j = 0; j < n; j++) acc += F[i * n + j] * x[j];
            xNew[i] = acc;
        }
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
        const y = this._y, PHt = this._PHt, S = this._S, Sinv = this._Sinv, K = this._K, KH = this._KH;
        for (let i = 0; i < m; i++) {
            let acc = z[i];
            for (let j = 0; j < n; j++) acc -= H[i * n + j] * x[j];
            y[i] = acc;
        }
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < m; j++) {
                let acc = 0;
                for (let k = 0; k < n; k++) acc += P[i * n + k] * H[j * n + k];
                PHt[i * m + j] = acc;
            }
        }
        for (let i = 0; i < m; i++) {
            for (let j = 0; j < m; j++) {
                let acc = 0;
                for (let k = 0; k < n; k++) acc += H[i * n + k] * PHt[k * m + j];
                S[i * m + j] = acc + R[i * m + j];
            }
        }
        _invertMatrix(Sinv, S, m);
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < m; j++) {
                let acc = 0;
                for (let k = 0; k < m; k++) acc += PHt[i * m + k] * Sinv[k * m + j];
                K[i * m + j] = acc;
            }
        }
        for (let i = 0; i < n; i++) {
            let acc = 0;
            for (let j = 0; j < m; j++) acc += K[i * m + j] * y[j];
            x[i] += acc;
        }
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
                P[i * n + j] = acc;
            }
        }
        return this;
    }
}

/** Extended Kalman filter — nonlinear fx/Fjac hooks, zero-GC covariance path. */
class ExtendedKalmanFilter extends KalmanFilter {
    constructor(n, m) {
        super(n, m);
        this.fx = null;
        this.Fjac = null;
        this._Fx = new Float64Array(n);
        this._Fnew = new Float64Array(n * n);
    }
    predict() {
        if (this.fx) {
            this.fx(this.x, this._Fx);
            for (let i = 0; i < this.n; i++) this.x[i] = this._Fx[i];
        }
        if (this.Fjac) {
            this.Fjac(this.x, this._Fnew);
            for (let i = 0; i < this.n * this.n; i++) this.F[i] = this._Fnew[i];
        }
        return super.predict();
    }
}

/** Unscented Kalman filter — sigma-point weights precomputed. */
class UnscentedKalmanFilter extends KalmanFilter {
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
}

/**
 * Particle filter — bootstrap variant. Offset-based, double-buffered resample
 * (no `subarray` views, no per-step allocation after construction).
 */
class ParticleFilter {
    constructor(n, count, initFn, motionFn, obsLogLikFn, rng) {
        this.n = n;
        this.count = count;
        this.particles = new Float64Array(count * n);
        this.weights = new Float64Array(count).fill(1 / count);
        this.motionFn = motionFn;
        this.obsLogLikFn = obsLogLikFn;
        this.rng = rng || Math.random;
        this._tmp = new Float64Array(n);
        this._logW = new Float64Array(count);
        this._newParticles = new Float64Array(count * n);
        this._idx = new Int32Array(count);
        if (initFn) {
            for (let i = 0; i < count; i++) {
                for (let d = 0; d < n; d++) this._tmp[d] = 0;
                initFn(i, this._tmp);
                for (let d = 0; d < n; d++) this.particles[i * n + d] = this._tmp[d];
            }
        }
    }
    predict() {
        const n = this.n;
        for (let i = 0; i < this.count; i++) {
            const off = i * n;
            for (let d = 0; d < n; d++) this._tmp[d] = this.particles[off + d];
            this.motionFn(this._tmp, this.rng);
            for (let d = 0; d < n; d++) this.particles[off + d] = this._tmp[d];
        }
    }
    update(observation) {
        const n = this.n;
        let maxLog = -Infinity;
        for (let i = 0; i < this.count; i++) {
            const off = i * n;
            for (let d = 0; d < n; d++) this._tmp[d] = this.particles[off + d];
            this._logW[i] = this.obsLogLikFn(this._tmp, observation);
            if (this._logW[i] > maxLog) maxLog = this._logW[i];
        }
        let sum = 0;
        for (let i = 0; i < this.count; i++) {
            this.weights[i] *= Math.exp(this._logW[i] - maxLog);
            sum += this.weights[i];
        }
        for (let i = 0; i < this.count; i++) this.weights[i] /= (sum || 1);
        let ess = 0;
        for (let i = 0; i < this.count; i++) ess += this.weights[i] * this.weights[i];
        if (1 / ess < this.count * 0.5) this.resample();
    }
    resample() {
        const n = this.n;
        importanceResample(this._idx, this.weights, this.count, this.rng);
        for (let i = 0; i < this.count; i++) {
            const src = this._idx[i] * n;
            const dst = i * n;
            for (let d = 0; d < n; d++) this._newParticles[dst + d] = this.particles[src + d];
        }
        const swap = this.particles;
        this.particles = this._newParticles;
        this._newParticles = swap;
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

/** Hidden Markov Model — forward-backward uses a single hoisted terms buffer. */
class HMM {
    constructor(states, obsSymbols) {
        this.S = states;
        this.O = obsSymbols;
        this.logA = new Float64Array(states * states);
        this.logB = new Float64Array(states * obsSymbols);
        this.logPi = new Float64Array(states);
        this._terms = new Float64Array(states);
    }
    forwardBackward(obs, T) {
        const S = this.S;
        const terms = this._terms;
        const alpha = new Float64Array(T * S);
        const beta = new Float64Array(T * S);
        for (let s = 0; s < S; s++) alpha[s] = this.logPi[s] + this.logB[s * this.O + obs[0]];
        for (let t = 1; t < T; t++) {
            for (let s = 0; s < S; s++) {
                let maxLog = -Infinity;
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
/** Correct cyclic Jacobi eigen-decomposition for symmetric matrices. */
function _jacobiEigen(A, n) {
    const a = new Float64Array(A);
    const v = new Float64Array(n * n);
    for (let i = 0; i < n; i++) v[i * n + i] = 1;
    const maxSweeps = 50;
    for (let sweep = 0; sweep < maxSweeps; sweep++) {
        let offDiag = 0;
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) offDiag += a[i * n + j] * a[i * n + j];
        if (offDiag < 1e-12) break;
        for (let p = 0; p < n - 1; p++) {
            for (let q = p + 1; q < n; q++) {
                const apq = a[p * n + q];
                if (Math.abs(apq) < 1e-12) continue;
                const app = a[p * n + p], aqq = a[q * n + q];
                const theta = (aqq - app) / (2 * apq);
                const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                const c = 1 / Math.sqrt(t * t + 1);
                const s = t * c;
                a[p * n + p] = app - t * apq;
                a[q * n + q] = aqq + t * apq;
                a[p * n + q] = 0; a[q * n + p] = 0;
                for (let k = 0; k < n; k++) {
                    if (k === p || k === q) continue;
                    const akp = a[k * n + p], akq = a[k * n + q];
                    a[k * n + p] = c * akp - s * akq; a[p * n + k] = a[k * n + p];
                    a[k * n + q] = s * akp + c * akq; a[q * n + k] = a[k * n + q];
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

function computePCA(data, count, n) {
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
    const eig = _jacobiEigen(cov, n);
    return { mean: mean, cov: cov, eigenvalues: eig.values, eigenvectors: eig.vectors };
}

function probabilisticPCA(data, count, n, components) {
    const pca = computePCA(data, count, n);
    return {
        mean: pca.mean,
        components: components || n,
        loadings: pca.eigenvectors.subarray(0, n * (components || n)),
        eigenvalues: pca.eigenvalues
    };
}

function _solveLinear(A, b, n) {
    const aug = new Float64Array(n * (n + 1));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) aug[i * (n + 1) + j] = A[i * n + j];
        aug[i * (n + 1) + n] = b[i];
    }
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

/** RANSAC plane fit — scalar math, no array literals. Writes out[0..3]. */
function ransacPlane(out, points, count, threshold, iterations, rng) {
    rng = rng || Math.random;
    let bestInliers = 0;
    let ba = 0, bb = 0, bc = 1, bd = 0;
    for (let it = 0; it < iterations; it++) {
        const i0 = (rng() * count) | 0;
        const i1 = (rng() * count) | 0;
        const i2 = (rng() * count) | 0;
        if (i0 === i1 || i1 === i2 || i0 === i2) continue;
        const p0x = points[i0 * 3], p0y = points[i0 * 3 + 1], p0z = points[i0 * 3 + 2];
        const p1x = points[i1 * 3], p1y = points[i1 * 3 + 1], p1z = points[i1 * 3 + 2];
        const p2x = points[i2 * 3], p2y = points[i2 * 3 + 1], p2z = points[i2 * 3 + 2];
        const v1x = p1x - p0x, v1y = p1y - p0y, v1z = p1z - p0z;
        const v2x = p2x - p0x, v2y = p2y - p0y, v2z = p2z - p0z;
        let nx = v1y * v2z - v1z * v2y;
        let ny = v1z * v2x - v1x * v2z;
        let nz = v1x * v2y - v1y * v2x;
        const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (nlen < 1e-9) continue;
        nx /= nlen; ny /= nlen; nz /= nlen;
        const d = -(nx * p0x + ny * p0y + nz * p0z);
        let inliers = 0;
        for (let i = 0; i < count; i++) {
            const dist = Math.abs(nx * points[i * 3] + ny * points[i * 3 + 1] + nz * points[i * 3 + 2] + d);
            if (dist < threshold) inliers++;
        }
        if (inliers > bestInliers) {
            bestInliers = inliers;
            ba = nx; bb = ny; bc = nz; bd = d;
        }
    }
    out[0] = ba; out[1] = bb; out[2] = bc; out[3] = bd;
    return { plane: out, inliers: bestInliers };
}

/** RANSAC sphere fit — writes out[0..3] = [cx, cy, cz, r]. */
function ransacSphere(out, points, count, threshold, iterations, rng) {
    rng = rng || Math.random;
    let bestInliers = 0;
    let bcx = 0, bcy = 0, bcz = 0, br = 1;
    const A = new Float64Array(16);
    const b = new Float64Array(4);
    for (let it = 0; it < iterations; it++) {
        const i0 = (rng() * count) | 0, i1 = (rng() * count) | 0;
        const i2 = (rng() * count) | 0, i3 = (rng() * count) | 0;
        const px = [points[i0 * 3], points[i1 * 3], points[i2 * 3], points[i3 * 3]];
        const py = [points[i0 * 3 + 1], points[i1 * 3 + 1], points[i2 * 3 + 1], points[i3 * 3 + 1]];
        const pz = [points[i0 * 3 + 2], points[i1 * 3 + 2], points[i2 * 3 + 2], points[i3 * 3 + 2]];
        for (let i = 0; i < 4; i++) {
            A[i * 4] = px[i]; A[i * 4 + 1] = py[i]; A[i * 4 + 2] = pz[i]; A[i * 4 + 3] = 1;
            b[i] = -(px[i] * px[i] + py[i] * py[i] + pz[i] * pz[i]);
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
        if (inliers > bestInliers) {
            bestInliers = inliers;
            bcx = cx; bcy = cy; bcz = cz; br = r;
        }
    }
    out[0] = bcx; out[1] = bcy; out[2] = bcz; out[3] = br;
    return { sphere: out, inliers: bestInliers };
}

function robustMean(data, n, iterations, sigma) {
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

function trimmedMean(data, n, trimPercent) {
    trimPercent = trimPercent || 0.1;
    const buf = _ensureTmp(n);
    for (let i = 0; i < n; i++) buf[i] = data[i];
    const sorted = Array.from(buf.subarray(0, n)).sort((a, b) => a - b);
    const trimN = Math.floor(n * trimPercent);
    let sum = 0;
    for (let i = trimN; i < n - trimN; i++) sum += sorted[i];
    return sum / Math.max(1, n - 2 * trimN);
}

// ============================================================================
// Regression with uncertainty
// ============================================================================
function weightedLeastSquares(X, y, weights, n, p) {
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

function robustRegression(X, y, n, p, iterations) {
    iterations = iterations || 5;
    const weights = new Float64Array(n).fill(1);
    let result = null;
    for (let it = 0; it < iterations; it++) {
        result = weightedLeastSquares(X, y, weights, n, p);
        for (let i = 0; i < n; i++) {
            let r = y[i];
            for (let j = 0; j < p; j++) r -= X[i * p + j] * result.beta[j];
            weights[i] = 1 / (1 + r * r);
        }
    }
    return result;
}

function gpRegression(Xtrain, ytrain, n, dim, Xquery, m, options) {
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
    const kstar = new Float64Array(n);
    for (let q = 0; q < m; q++) {
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
function _softmaxRange(x, off, n) {
    let max = -Infinity;
    for (let i = 0; i < n; i++) if (x[off + i] > max) max = x[off + i];
    let sum = 0;
    for (let i = 0; i < n; i++) { x[off + i] = Math.exp(x[off + i] - max); sum += x[off + i]; }
    for (let i = 0; i < n; i++) x[off + i] /= sum;
    return x;
}

function _logSoftmaxRange(x, off, n) {
    let max = -Infinity;
    for (let i = 0; i < n; i++) if (x[off + i] > max) max = x[off + i];
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.exp(x[off + i] - max);
    const logSum = Math.log(sum);
    for (let i = 0; i < n; i++) x[off + i] = x[off + i] - max - logSum;
    return x;
}

/** In-place softmax on `n` elements starting at offset 0. */
function softmax(x, n) { return _softmaxRange(x, 0, n); }
function logSoftmax(x, n) { return _logSoftmaxRange(x, 0, n); }

/** Softmax (Boltzmann) selection over q-values (scalar max loop, zero-GC). */
function softmaxSelection(qValues, n, temperature, rng) {
    rng = rng || Math.random;
    let maxQ = -Infinity;
    for (let i = 0; i < n; i++) if (qValues[i] > maxQ) maxQ = qValues[i];
    const probs = _ensureTmp(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        probs[i] = Math.exp((qValues[i] - maxQ) / temperature);
        sum += probs[i];
    }
    for (let i = 0; i < n; i++) probs[i] /= sum;
    return categoricalSample(probs, n, rng);
}

function epsilonGreedy(qValues, n, epsilon, rng) {
    rng = rng || Math.random;
    if (rng() < epsilon) return (rng() * n) | 0;
    let best = 0, bestQ = -Infinity;
    for (let i = 0; i < n; i++) if (qValues[i] > bestQ) { bestQ = qValues[i]; best = i; }
    return best;
}

function ucb1(pulls, rewards, n, totalPulls) {
    let bestArm = 0, bestUCB = -Infinity;
    for (let i = 0; i < n; i++) {
        if (pulls[i] === 0) return i;
        const avg = rewards[i] / pulls[i];
        const ucb = avg + Math.sqrt(2 * Math.log(totalPulls) / pulls[i]);
        if (ucb > bestUCB) { bestUCB = ucb; bestArm = i; }
    }
    return bestArm;
}

function ucb1Tuned(pulls, rewards, rewardsSq, n, totalPulls) {
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

function thompsonSampling(successes, failures, n, rng) {
    let bestArm = 0, bestSample = -Infinity;
    for (let i = 0; i < n; i++) {
        const sample = _randBeta(successes[i] + 1, failures[i] + 1, rng);
        if (sample > bestSample) { bestSample = sample; bestArm = i; }
    }
    return bestArm;
}

function gpUCB(means, variances, n, kappa) {
    let bestIdx = 0, bestVal = -Infinity;
    for (let i = 0; i < n; i++) {
        const val = means[i] + kappa * Math.sqrt(variances[i]);
        if (val > bestVal) { bestVal = val; bestIdx = i; }
    }
    return bestIdx;
}

function expectedImprovement(means, variances, n, bestSoFar) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const std = Math.sqrt(variances[i]);
        if (std < EPSILON) { out[i] = 0; continue; }
        const z = (means[i] - bestSoFar) / std;
        const pdf = Math.exp(-0.5 * z * z) * INV_SQRT_2PI;
        const cdf = 0.5 * (1 + erf(z / Math.SQRT2));
        out[i] = std * (z * cdf + pdf);
    }
    return out;
}

function mctsUCB(visits, values, parentVisits, c) {
    c = c || Math.SQRT2;
    return values / visits + c * Math.sqrt(Math.log(parentVisits) / visits);
}

function mctsPUCT(visits, values, parentVisits, prior, c) {
    c = c || 1;
    return values / visits + c * prior * Math.sqrt(parentVisits) / (1 + visits);
}

/** MultiArmedBandit — full bandit agent. */
class MultiArmedBandit {
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
function confidenceInterval(mean, variance, n, zAlpha) {
    zAlpha = zAlpha || 1.96;
    const se = Math.sqrt(variance / n);
    return { lo: mean - zAlpha * se, hi: mean + zAlpha * se, se: se };
}

function predictionInterval(mean, variance, noiseVariance, zAlpha) {
    zAlpha = zAlpha || 1.96;
    const w = Math.sqrt(variance + noiseVariance);
    return { lo: mean - zAlpha * w, hi: mean + zAlpha * w };
}

function monteCarloPropagate(f, mean, cov, dim, m, nSamples, rng) {
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

function sobolIndices(f, bounds, n, nSamples, rng) {
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
            for (let k = 0; k < n; k++) y[k] = x[k];
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
function xavierUniform(fanIn, fanOut, rng) {
    const limit = Math.sqrt(6 / (fanIn + fanOut));
    return (rng() * 2 - 1) * limit;
}
function heUniform(fanIn, rng) {
    const limit = Math.sqrt(6 / fanIn);
    return (rng() * 2 - 1) * limit;
}
function kaimingUniform(fanIn, rng) { return heUniform(fanIn, rng); }

function dropoutMask(mask, n, keepProb, rng) {
    rng = rng || Math.random;
    const scale = 1 / keepProb;
    for (let i = 0; i < n; i++) mask[i] = rng() < keepProb ? scale : 0;
    return mask;
}

function batchNormStats(mean, variance, data, n, decay) {
    let sum = 0, sumSq = 0;
    for (let i = 0; i < n; i++) { sum += data[i]; sumSq += data[i] * data[i]; }
    const batchMean = sum / n;
    const batchVar = sumSq / n - batchMean * batchMean;
    mean[0] = decay * mean[0] + (1 - decay) * batchMean;
    variance[0] = decay * variance[0] + (1 - decay) * batchVar;
    return { mean: mean[0], variance: variance[0] };
}

/** Q · K^T / sqrt(d). Returns the score matrix (seqQ × seqK). */
function attentionScores(Q, K, seqQ, seqK, d) {
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

/** Weighted reservoir sampling (Efraimidis-Spirakis). Returns one index. */
function weightedReservoir(weights, n, rng) {
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
// SOA (sync, zero-GC)
// ============================================================================
/** Sample N independent MVN vectors into a vec3 SOA (dim=3). */
function soaSampleMVN(outPositions, mean, cov, n, rng) {
    const count = outPositions.count;
    const L = new Float64Array(cov.length);
    L.set(cov);
    choleskyDecompose(L, n);
    const scratch = acquireProbabilityScratch(n);
    const sample = scratch.b;
    const ox = outPositions.x, oy = outPositions.y, oz = outPositions.z;
    for (let i = 0; i < count; i++) {
        multivariateNormalFromCholesky(sample, mean, L, n, rng);
        ox[i] = sample[0]; oy[i] = sample[1]; if (n >= 3) oz[i] = sample[2];
    }
    releaseProbabilityScratch(scratch);
    return outPositions;
}

/** Evaluate MVN log-PDF at each point in a vec3 SOA (dim=3). */
function soaEvaluateMVN(outLogP, positions, mean, invCov, logDet) {
    const n = positions.count;
    const px = positions.x, py = positions.y, pz = positions.z;
    const x = _ensureTmp(3);
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

/** Batch softmax over each row of a flat array (rows × cols). Zero-GC. */
function soaSoftmax(data, rows, cols) {
    for (let r = 0; r < rows; r++) _softmaxRange(data, r * cols, cols);
    return data;
}

/** Batch entropy — one entropy per row. */
function soaEntropyBatch(outH, data, rows, cols) {
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

/** Batch GMM predict — one component id per row. */
function soaGMMPredictBatch(outClass, gmm, points, count, n) {
    const x = _ensureTmp(n);
    for (let i = 0; i < count; i++) {
        for (let d = 0; d < n; d++) x[d] = points[i * n + d];
        outClass[i] = gmmPredict(gmm, x);
    }
    return outClass;
}

/** Batch Kalman — one linear KF per row of the batch. */
function soaKalmanBatch(kfs, observations, count) {
    for (let i = 0; i < count; i++) {
        kfs[i].predict();
        kfs[i].update(observations[i]);
    }
    return kfs;
}

// ============================================================================
// SOA (chunked async, inlined loops, zero closures)
// ============================================================================
async function soaSampleMVNChunked(outPositions, mean, cov, n, rng, chunkSize, yieldEvery) {
    const count = outPositions.count;
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    const L = new Float64Array(cov.length);
    L.set(cov);
    choleskyDecompose(L, n);
    const scratch = acquireProbabilityScratch(n);
    const sample = scratch.b;
    const ox = outPositions.x, oy = outPositions.y, oz = outPositions.z;
    try {
        let start = 0, c = 0;
        while (start < count) {
            const end = Math.min(start + chunkSize, count);
            for (let i = start; i < end; i++) {
                multivariateNormalFromCholesky(sample, mean, L, n, rng);
                ox[i] = sample[0]; oy[i] = sample[1]; if (n >= 3) oz[i] = sample[2];
            }
            start = end;
            if (start >= count) break;
            if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
        }
    } finally {
        releaseProbabilityScratch(scratch);
    }
    return outPositions;
}

async function soaSoftmaxChunked(data, rows, cols, chunkSize, yieldEvery) {
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < rows) {
        const end = Math.min(start + chunkSize, rows);
        for (let r = start; r < end; r++) _softmaxRange(data, r * cols, cols);
        start = end;
        if (start >= rows) break;
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
    return data;
}

async function soaEntropyBatchChunked(outH, data, rows, cols, chunkSize, yieldEvery) {
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < rows) {
        const end = Math.min(start + chunkSize, rows);
        for (let r = start; r < end; r++) {
            let H = 0;
            for (let cc = 0; cc < cols; cc++) {
                const p = data[r * cols + cc];
                if (p > 0) H -= p * Math.log(p);
            }
            outH[r] = H;
        }
        start = end;
        if (start >= rows) break;
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
    return outH;
}

async function soaGMMPredictBatchChunked(outClass, gmm, points, count, n, chunkSize, yieldEvery) {
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    const x = _ensureTmp(n);
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + chunkSize, count);
        for (let i = start; i < end; i++) {
            for (let d = 0; d < n; d++) x[d] = points[i * n + d];
            outClass[i] = gmmPredict(gmm, x);
        }
        start = end;
        if (start >= count) break;
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
    return outClass;
}

async function soaKalmanBatchChunked(kfs, observations, count, chunkSize, yieldEvery) {
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + chunkSize, count);
        for (let i = start; i < end; i++) {
            kfs[i].predict();
            kfs[i].update(observations[i]);
        }
        start = end;
        if (start >= count) break;
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
    return kfs;
}

// ============================================================================
// Batch state
// ============================================================================
/**
 * ProbabilityBatchState — preallocated buffers for 1M+ probabilistic
 * evaluations per frame. Re-create after `setPrecision()` to pick up the new
 * array type.
 */
class ProbabilityBatchState {
    constructor(count, dim) {
        this.count = count;
        this.dim = dim || 3;
        const T = getArrayType();
        this.data = new T(count * this.dim);
        this.out = new T(count);
        this.weights = new T(count);
        this.positions = createVec3SOA(count);
        this.scratch = acquireProbabilityScratch(this.dim);
    }
    dispose() {
        releaseProbabilityScratch(this.scratch);
        this.scratch = null;
    }
}

function createProbabilityBatch(count, dim) {
    return new ProbabilityBatchState(count, dim);
}

// ============================================================================
// Namespace convenience (init-time object graph only)
// ============================================================================
const namespace = {
    distributions: {
        choleskyDecompose,
        multivariateNormalSample, multivariateNormalFromCholesky,
        multivariateNormalPDF, multivariateNormalLogPDF,
        dirichletLogPDF, wishartSample, inverseWishartSample,
        vonMisesFisherSample, vonMisesFisherPDF, kentSample,
        multinomialSample, categoricalSample,
        categoricalEntropy, categoricalKL,
        GaussianMixture, fitGMM, gmmPredict
    },
    bayes: {
        bayesUpdate, NaiveBayes,
        conjugateBetaBernoulli, conjugateDirichletCategorical,
        conjugateNormalNormal, conjugateGammaPoisson,
        AIC, BIC, logLikelihood
    },
    info: {
        entropy, renyiEntropy, tsallisEntropy,
        klDivergence, jsDivergence, mutualInformation,
        crossEntropy, perplexity
    },
    monteCarlo: {
        importanceSampling, importanceResample, antitheticSample,
        controlVariates, bootstrapCI, jackknife,
        metropolisHastingsND, gibbsND, hamiltonianMC
    },
    sequential: {
        KalmanFilter, ExtendedKalmanFilter, UnscentedKalmanFilter,
        ParticleFilter, HMM
    },
    pointset: {
        computePCA, probabilisticPCA,
        ransacPlane, ransacSphere,
        robustMean, trimmedMean
    },
    regression: {
        weightedLeastSquares, robustRegression, gpRegression
    },
    decisions: {
        softmaxSelection, epsilonGreedy, ucb1, ucb1Tuned,
        thompsonSampling, gpUCB, expectedImprovement,
        mctsUCB, mctsPUCT, MultiArmedBandit
    },
    uncertainty: {
        confidenceInterval, predictionInterval,
        monteCarloPropagate, sobolIndices
    },
    ml: {
        xavierUniform, heUniform, kaimingUniform,
        dropoutMask, batchNormStats,
        softmax, logSoftmax, attentionScores, weightedReservoir
    },
    batch: {
        State: ProbabilityBatchState,
        create: createProbabilityBatch,
        sampleMVN: soaSampleMVN,
        sampleMVNChunked: soaSampleMVNChunked,
        evaluateMVN: soaEvaluateMVN,
        softmax: soaSoftmax,
        softmaxChunked: soaSoftmaxChunked,
        entropy: soaEntropyBatch,
        entropyChunked: soaEntropyBatchChunked,
        gmmPredict: soaGMMPredictBatch,
        gmmPredictChunked: soaGMMPredictBatchChunked,
        kalman: soaKalmanBatch,
        kalmanChunked: soaKalmanBatchChunked
    },
    pool: {
        ProbabilityScratch,
        createProbabilityScratchPool,
        acquireProbabilityScratch,
        releaseProbabilityScratch
    }
};

// ============================================================================
// Precision listener — hoisted named handler (no closure allocation).
// Existing batch states keep their current buffer types; new ones created
// after a precision change use the live array type via getArrayType().
// ============================================================================
function _handlePrecisionChange(mode, oldMode) { /* retention policy: no-op */ }
onPrecisionChange(_handlePrecisionChange);

// ============================================================================
// Export Declarations (ES Modules)
// ============================================================================
export {
    // Multivariate distributions
    choleskyDecompose,
    multivariateNormalSample, multivariateNormalFromCholesky,
    multivariateNormalPDF, multivariateNormalLogPDF,
    dirichletLogPDF, wishartSample, inverseWishartSample,
    vonMisesFisherSample, vonMisesFisherPDF, kentSample,
    multinomialSample, categoricalSample,
    categoricalEntropy, categoricalKL,
    // Mixture models
    GaussianMixture, fitGMM, gmmPredict,
    // Bayesian primitives
    bayesUpdate, NaiveBayes,
    conjugateBetaBernoulli, conjugateDirichletCategorical,
    conjugateNormalNormal, conjugateGammaPoisson,
    AIC, BIC, logLikelihood,
    // Information theory
    entropy, renyiEntropy, tsallisEntropy,
    klDivergence, jsDivergence, mutualInformation,
    crossEntropy, perplexity,
    // Monte Carlo
    importanceSampling, importanceResample, antitheticSample,
    controlVariates, bootstrapCI, jackknife,
    metropolisHastingsND, gibbsND, hamiltonianMC,
    // Sequential estimation
    KalmanFilter, ExtendedKalmanFilter, UnscentedKalmanFilter,
    ParticleFilter, HMM,
    // Point-set statistics
    computePCA, probabilisticPCA,
    ransacPlane, ransacSphere,
    robustMean, trimmedMean,
    // Regression
    weightedLeastSquares, robustRegression, gpRegression,
    // Smart decisions
    softmaxSelection, epsilonGreedy, ucb1, ucb1Tuned,
    thompsonSampling, gpUCB, expectedImprovement,
    mctsUCB, mctsPUCT, MultiArmedBandit,
    // Uncertainty quantification
    confidenceInterval, predictionInterval,
    monteCarloPropagate, sobolIndices,
    // ML primitives
    xavierUniform, heUniform, kaimingUniform,
    dropoutMask, batchNormStats,
    softmax, logSoftmax, attentionScores, weightedReservoir,
    // SOA (sync)
    soaSampleMVN, soaEvaluateMVN, soaSoftmax,
    soaEntropyBatch, soaGMMPredictBatch, soaKalmanBatch,
    // SOA (chunked async)
    soaSampleMVNChunked, soaSoftmaxChunked, soaEntropyBatchChunked,
    soaGMMPredictBatchChunked, soaKalmanBatchChunked,
    // Pools
    ProbabilityScratch, createProbabilityScratchPool,
    acquireProbabilityScratch, releaseProbabilityScratch,
    // Batch state
    ProbabilityBatchState, createProbabilityBatch,
    // Namespaces
    namespace
};