//File number : 053
// File : src/math/053_sampling.js
//Description : Complete sampling system (ESM) — random primitives (uniform, normal,
//              exponential, log-normal, Poisson/Knuth+PTRS, discrete/CDF, rejection),
//              2D domains (disk, concentric low-distortion disk, circle, annulus, triangle,
//              box, regular hexagon/polygon), 3D domains (sphere, hemisphere, cosine
//              hemisphere, cone, box, area-correct capsule surface, volume-correct capsule),
//              BRDF importance sampling (Phong, Blinn-Phong, GGX NDF, TRUE GGX VNDF,
//              Beckmann) with matching solid-angle PDFs and reflection PDFs, MIS
//              balance/power heuristics, mesh & polyline sampling with area/arc CDFs,
//              environment-map uniform + luminance-importance sampling, Latin hypercube
//              2D/3D, Cranley–Patterson / Wang-hash / XOR / Owen decorrelation, pre-baked
//              kernels (SSAO, TAA jitter, PCSS Poisson, Gaussian DOF), typed-array
//              reservoir sampling with ReSTIR-style merge, volumetric delta/ratio tracking,
//              Metropolis–Hastings & Gibbs MCMC, IK-reachable target sampling, Kepler
//              orbital state sampling, noise-weighted and blue-noise procedural scatter.
//              Every sampler has an `*Into` form, a typed-array SOA batch version, and a
//              chunked async variant yielding via `scheduler.yield()`. Includes a
//              double-single bridge that lifts normalized samples to megaparsec-scale
//              world positions, DataTexture LUT authoring, dirty-range GPU attribute
//              upload, deterministic fixed-step temporal sampling, zero-copy transferable
//              batch state, pooled zero-GC scratch, and live Float16/Float32/Float64
//              migration through `000_Math_module.js`.
//
//              CORRECTIONS (this revision):
//              • FATAL: `const M = require(...)` replaced with ESM named imports.
//              • FATAL: `exports.Reservoir / SamplingScratch / SamplingBatchState` read
//                classes from the TDZ at module-evaluation time; `exports.namespace` was
//                mutated after export. Converted to `export class` / `export function`.
//              • FATAL: `sampleGGXVisible` was dead placeholder code (`* 0` terms, unused
//                `Vh`/`p2s`/`t2` locals) that ended in `return sampleGGX(...)` — it ignored
//                the view direction entirely, so "visible-normal" sampling was just NDF
//                sampling. Replaced with the real Dupuy–Benyoub / Heitz spherical-cap VNDF
//                warp (hemisphere configuration → cap → unwarp), with a grazing fallback.
//              • FATAL: `ggxVisiblePDF` returned `D·cosθ` (the NDF pdf). A VNDF pdf cannot
//                be computed from `cosTheta` alone; the signature now takes V and H and
//                returns `D(H)·G1(V)·max(0,V·H)/|N·V|`. `ggxVisiblePDFAngles` is provided
//                for callers that already have the dot products.
//              • FATAL: `xorDecorrelate` parsed as `a ^ (…) >>> (0/4294967296)` because
//                `/` binds tighter than `>>>` — it returned a raw integer, not [0,1).
//                `wangHashDecorate` used `v * 2654435761` (precision loss above 2^32) and
//                contained broken `> > >` operators. Both rewritten with `Math.imul`.
//              • FATAL: `latinHypercube2D` shuffled BOTH permutations with the SAME random
//                index, making the x and y strata identical — every sample landed on the
//                diagonal. Each axis now shuffles independently (3D was already correct).
//              • `sampleBlinnPhong` sampled with `u^(1/(n+1))` while `blinnPhongPDF`
//                normalised with `(n+2)` — sampler and pdf disagreed, biasing every
//                specular estimate. Both now use the (n+2) NDF convention.
//              • `sampleOrbitalPosition` and `sampleOrbitalVelocity` each drew a NEW random
//                mean anomaly, so position and velocity described different points on the
//                orbit. Added `sampleOrbitalState` (one M for both) and an optional M
//                override on each.
//              • `generateGaussianDisk` used `|N(0,1)|·sigma` as a radius — a half-normal
//                radial law, not a 2D Gaussian. Now samples x,y ~ N(0,sigma) independently;
//                `generateRayleighDisk` provides the radial form for importance sampling.
//              • `generatePCSSKernel` hard-coded radius 0.05 and ignored `count`. Radius is
//                now derived from the requested count and the kernel is topped up with
//                best-candidate samples so exactly `count` taps are always produced.
//              • `generateTAAJitter` divided by screen size while documenting [-0.5,0.5].
//                Default is now sub-pixel jitter; `{ ndc:true }` emits clip-space offsets.
//              • `uniformCapsule` sampled a swept ball (neither area-uniform nor the
//                documented surface). Replaced with area-weighted cylinder + caps;
//                `uniformCapsuleVolume` provides the volume-correct variant.
//              • `uniformHexagon2D` used rejection against a non-regular hexagon test.
//                Replaced with exact triangle-fan sampling (no rejection, no bias);
//                `uniformPolygon2D` generalises it.
//              • `sampleMeshTriangle` allocated three vertex arrays per call;
//                `uniformCapsule` / `generateSSAOKernel` allocated `[0,0,0]` per call.
//                All inlined or moved to module scratch.
//              • `soaReservoirResample` allocated `count` `Reservoir` objects per call —
//                1M objects for 1M rows. Replaced with reusable typed-array state.
//              • `Reservoir.merge` mixed pre- and post-increment `M` in the same
//                expression, producing a biased merge. Replaced with the canonical
//                ReSTIR merge (`W·p̂(y)·M_other`, single selection, `M_total`).
//              • `deltaTracking` / `ratioTracking` could loop forever for a zero or tiny
//                majorant. Both are now guarded and bounded.
//              • `gibbsSample` allocated `[x,y]` per sample; `metropolisHastings` had no
//                burn-in. `*Into` forms and a burn-in option added.
//              • ES2022 static blocks / private static fields removed so the file parses on
//                older Android WebViews; warm-up runs in plain IIFEs. The
//                `static #listeners = new Set()` notification path is now a dense array.
//              • `SamplingScratch.acquire` used `Array.splice` (allocation per acquire);
//                now swap-removes. The monkey-patched pool is a real class-backed pool.
//
//              FEATURES ADDED from corrected_bitecs_enhancement.md:
//              • §10/§16 — Zero-GC everywhere: no array literals or per-call closures in
//                hot loops, no Map/Set, reusable typed-array reservoir state, `*Into`
//                forms for every allocating API, scratch pools rebuilt only at
//                precision-switch time.
//              • §25/§28 — `writeSamplesIntoFlat` / `flagSampleUpload` /
//                `syncSampleAttribute` / `syncSampleVectorAttribute`: upload sample sets
//                straight into an InstancedBufferAttribute backing array with
//                `clearUpdateRanges` / `addUpdateRange` dirty-prefix upload.
//              • §26     — Double-single bridge: `dsAddInto` / `dsSubInto` / `dsMulInto`
//                renormalize with a full TwoSum BEFORE any narrowing cast.
//                `sampleToWorldDS`, `soaSamplesToWorldDS` and `soaSamplesToRelative`
//                (+ chunked) turn normalized samples into exact world positions and
//                sub-millimetre-accurate camera-relative Float32 at Mpc offsets.
//              • §30     — `buildSampleLUT2D` / `buildKernelLUT` / `buildBlueNoiseLUT2D`
//                (+ chunked) author DataTexture-ready RGBA buffers with zero per-texel
//                allocation.
//              • §34     — Hexagon fan, Lanczos coefficients, and hash salts are
//                pre-allocated module constants.
//              • §45/§51 — `SampleClock` (compensated time) and `createTemporalSampler`
//                advance a deterministic frame index on a FIXED timestep, emitting an
//                Owen-scrambled + Cranley–Patterson-rotated set per tick (TAA / DOF / SSR),
//                plus a re-exported `createFixedStepScheduler`.
//              • §49     — `samplingBatchToTransferable` / `FromTransferable` pack a batch
//                into ONE ArrayBuffer for zero-copy Worker transfer.
//              • Path tracing — MIS heuristics, reflection-space PDFs, concentric disk
//                mapping, Poisson-count sampling, discrete/CDF builders, and equirect
//                luminance-importance sampling.
//####
//Best for : 3d graphics — 1M+ star/asteroid placement (uniform sphere + Kepler state),
//           foliage scatter with noise or blue-noise density, hemisphere SSAO kernels,
//           TAA jitter sequences at any resolution, PCSS rotated-Poisson soft shadows,
//           Gaussian depth-of-field bokeh, importance-sampled PBR (GGX VNDF specular,
//           cosine diffuse) with correct MIS weights, environment lighting from equirect
//           luminance CDFs, mesh-area decal sampling on 1M+ instances, IK target
//           randomization for procedural crowds, MCMC light-transport estimators,
//           volumetric path-traced clouds (delta / ratio tracking), reservoir-resampled
//           direct lighting (ReSTIR), and galaxy-cluster seeding across Mpc offsets via
//           the double-single bridge — all mobile-safe at 60 fps on Android 64-bit.
//License : MIT

// ============================================================================
// Imports — ESM named imports
// ============================================================================
import {
    common,
    vec3,
    vec4,
    double,
    createVec2SOA,
    createVec3SOA,
    createVec4SOA,
    getPrecision,
    setPrecision,
    onPrecisionChange,
    getArrayType,
    createFixedStepScheduler
} from "./000_Math_module.js";

import {
    perlin3D,
    fbm3D,
    createPerlin3D,
    curl3D
} from "./044_noise-family.js";

import {
    radicalInverse,
    hammersley2D,
    hammersley3D,
    halton2D,
    sobol2D,
    sobol2DAt,
    owenScramble,
    soaOwenScramble2D,
    cranleyPatterson2D,
    poissonDisk2DInto,
    poissonDisk3DInto,
    bestCandidate2DInto,
    bestCandidate3DInto,
    voidAndClusterInto,
    thresholdMask
} from "./046_blue-noise.js";

export const VERSION = "1.1.0-esm";

export {
    getPrecision,
    setPrecision,
    onPrecisionChange,
    getArrayType,
    createFixedStepScheduler,
    radicalInverse,
    hammersley2D,
    hammersley3D,
    halton2D,
    sobol2D,
    sobol2DAt,
    owenScramble,
    soaOwenScramble2D,
    cranleyPatterson2D
};

// ============================================================================
// Constants — pre-allocated (Blueprint §34)
// ============================================================================
const TAU = Math.PI * 2;
const PI = Math.PI;
const HALF_PI = PI * 0.5;
const QUARTER_PI = PI * 0.25;
const EPSILON = 1e-9;
const INV_TAU = 1 / TAU;
const INV_PI = 1 / PI;

// Regular hexagon vertices (unit circumradius) for exact triangle-fan sampling.
const HEX_VERTS = new Float64Array(12);
for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    HEX_VERTS[i * 2] = Math.cos(a);
    HEX_VERTS[i * 2 + 1] = Math.sin(a);
}

// Lanczos g=7 coefficients for log Γ (Poisson PTRS acceptance test).
const LANCZOS = new Float64Array([
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7
]);
const LOG_SQRT_2PI = 0.5 * Math.log(TAU);

// Hash salts.
const SALT_A = 0x9e3779b1;
const SALT_B = 0x85ebca6b;
const SALT_C = 0xc2b2ae35;

// Sampler ids (resolved ONCE outside hot loops).
export const SAMPLER_UNIFORM = 0;
export const SAMPLER_HAMMERSLEY = 1;
export const SAMPLER_HALTON = 2;
export const SAMPLER_SOBOL = 3;
export const SAMPLER_BLUE = 4;
export const SAMPLER_JITTERED = 5;

// ============================================================================
// Module scratch — allocated once, reused by every hot path (Zero-GC)
// ============================================================================
const _v3a = new Float64Array(3);
const _v3b = new Float64Array(3);
const _v2 = new Float64Array(2);
const _ds2 = new Float64Array(2);
const _ds3 = new Float64Array(2);
const _ds4 = new Float64Array(4);
const _quad4 = new Float64Array(4);

// Reusable typed-array reservoir state (grows at setup, never per frame).
let _rsSum = new Float64Array(0);
let _rsSeen = new Uint32Array(0);
let _rsSel = new Int32Array(0);

function _ensureReservoirState(n) {
    if (_rsSum.length >= n) return;
    let cap = _rsSum.length || 1024;
    while (cap < n) cap *= 2;
    _rsSum = new Float64Array(cap);
    _rsSeen = new Uint32Array(cap);
    _rsSel = new Int32Array(cap);
}

// ============================================================================
// Small helpers
// ============================================================================
function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function _isArr(t) { return t != null && t.length !== undefined; }
function _rng(r) { return r || Math.random; }

function _logGamma(z) {
    if (z < 0.5) return Math.log(PI / Math.sin(PI * z)) - _logGamma(1 - z);
    z -= 1;
    let x = 0.99999999999980993;
    for (let i = 0; i < 8; i++) x += LANCZOS[i] / (z + i + 1);
    const t = z + 7.5;
    return LOG_SQRT_2PI + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Orthonormal basis (t1, t2) perpendicular to a unit axis. Writes 6 scalars. */
function _basisFromAxis(out6, ax, ay, az) {
    let tx, ty, tz;
    if (Math.abs(ax) < 0.9) { tx = 0; ty = -az; tz = ay; }
    else { tx = az; ty = 0; tz = -ax; }
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    const ti = 1 / tl;
    tx *= ti; ty *= ti; tz *= ti;
    out6[0] = tx; out6[1] = ty; out6[2] = tz;
    out6[3] = ay * tz - az * ty;
    out6[4] = az * tx - ax * tz;
    out6[5] = ax * ty - ay * tx;
    return out6;
}
const _basis6 = new Float64Array(6);

// ============================================================================
// Random primitives
// ============================================================================
/** Uniform [0,1). */
export function uniform(rng) { return _rng(rng)(); }
/** Uniform [min,max). */
export function uniformRange(min, max, rng) { return min + _rng(rng)() * (max - min); }
/** Uniform integer [min,max] inclusive. */
export function uniformInt(min, max, rng) {
    return Math.floor(min + _rng(rng)() * (max - min + 1));
}
/** Exponential: −ln(1−u)/λ. */
export function exponential(lambda, rng) {
    const l = lambda > 0 ? lambda : 1;
    return -Math.log(1 - _rng(rng)()) / l;
}
/** Standard normal (Box–Muller). The second deviate is discarded — use normalPairInto. */
export function normal(rng) {
    const r = _rng(rng);
    const u1 = r(), u2 = r();
    return Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(TAU * u2);
}
/** Both Box–Muller deviates → out2. Zero allocation, no wasted sample. */
export function normalPairInto(out2, rng) {
    const r = _rng(rng);
    const u1 = r(), u2 = r();
    const m = Math.sqrt(-2 * Math.log(1 - u1));
    const a = TAU * u2;
    out2[0] = m * Math.cos(a);
    out2[1] = m * Math.sin(a);
    return out2;
}
/** Normal with mean/sigma. */
export function normalMean(mu, sigma, rng) { return mu + sigma * normal(rng); }
/** Log-normal: exp(mu + sigma·Z). */
export function logNormal(mu, sigma, rng) { return Math.exp(mu + sigma * normal(rng)); }

/**
 * Poisson-distributed count. Knuth for λ < 30, Hörmann PTRS above.
 * CORRECTION: the header advertised a Poisson primitive that did not exist.
 */
export function poisson(lambda, rng) {
    const r = _rng(rng);
    if (!(lambda > 0)) return 0;
    if (lambda < 30) {
        const L = Math.exp(-lambda);
        let k = 0, p = 1;
        do { k++; p *= r(); } while (p > L);
        return k - 1;
    }
    const b = 0.931 + 2.53 * Math.sqrt(lambda);
    const a = -0.059 + 0.02483 * b;
    const invAlpha = 1.1239 + 1.1328 / (b - 3.4);
    const vr = 0.9277 - 3.6224 / (b - 2);
    const logLambda = Math.log(lambda);
    for (let i = 0; i < 1024; i++) {
        const U = r() - 0.5;
        const V = r();
        const us = 0.5 - Math.abs(U);
        if (us <= 0) continue;
        const k = Math.floor((2 * a / us + b) * U + lambda + 0.43);
        if (us >= 0.07 && V <= vr) return k < 0 ? 0 : k;
        if (k < 0 || (us < 0.013 && V > us)) continue;
        if (Math.log(V) + Math.log(invAlpha) - Math.log(a / (us * us) + b) <=
            k * logLambda - lambda - _logGamma(k + 1)) return k;
    }
    return Math.max(0, Math.round(lambda));
}

/** Build a normalized cumulative distribution from weights. `out` is caller-owned. */
export function buildCDF(out, weights, count) {
    count = count === undefined ? weights.length : count;
    let sum = 0;
    for (let i = 0; i < count; i++) { const w = weights[i]; sum += w > 0 ? w : 0; }
    const inv = sum > 0 ? 1 / sum : 0;
    let acc = 0;
    for (let i = 0; i < count; i++) {
        const w = weights[i];
        acc += (w > 0 ? w : 0) * inv;
        out[i] = acc;
    }
    if (count > 0) out[count - 1] = 1;
    return out;
}
/** Lower-bound binary search on a cumulative array. */
export function sampleInverseCDF(cumulative, rng, count) {
    const n = count === undefined ? cumulative.length : count;
    if (n === 0) return 0;
    const u = _rng(rng)();
    let lo = 0, hi = n - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumulative[mid] < u) lo = mid + 1; else hi = mid;
    }
    return lo;
}
/** Sample an index directly from unnormalized weights (linear scan, no CDF alloc). */
export function sampleDiscrete(weights, count, rng) {
    const n = count === undefined ? weights.length : count;
    const r = _rng(rng);
    let sum = 0;
    for (let i = 0; i < n; i++) { const w = weights[i]; if (w > 0) sum += w; }
    if (sum <= 0) return 0;
    let u = r() * sum;
    for (let i = 0; i < n; i++) {
        const w = weights[i];
        if (w <= 0) continue;
        u -= w;
        if (u <= 0) return i;
    }
    return n - 1;
}
/** Rejection sampling from a bounded PDF. Bounded attempt count. */
export function sampleRejection(pdf, maxPdf, xmin, xmax, rng, maxAttempts) {
    const r = _rng(rng);
    const n = maxAttempts || 1024;
    const span = xmax - xmin;
    for (let i = 0; i < n; i++) {
        const x = xmin + r() * span;
        if (r() * maxPdf <= pdf(x)) return x;
    }
    return xmin;
}

// ============================================================================
// 2D domains
// ============================================================================
/** Uniform unit disk (polar mapping). */
export function uniformDisk(out, rng) {
    const r = _rng(rng);
    const rad = Math.sqrt(r());
    const phi = TAU * r();
    out[0] = rad * Math.cos(phi);
    out[1] = rad * Math.sin(phi);
    return out;
}
/**
 * Shirley–Chiu concentric disk mapping — far lower distortion than the polar
 * mapping, so stratified / QMC inputs stay stratified on the disk. Preferred
 * for depth-of-field and soft-shadow sampling.
 */
export function concentricDisk(out, u1, u2) {
    const a = 2 * u1 - 1, b = 2 * u2 - 1;
    if (a === 0 && b === 0) { out[0] = 0; out[1] = 0; return out; }
    let rad, phi;
    if (Math.abs(a) > Math.abs(b)) { rad = a; phi = QUARTER_PI * (b / a); }
    else { rad = b; phi = HALF_PI - QUARTER_PI * (a / b); }
    out[0] = rad * Math.cos(phi);
    out[1] = rad * Math.sin(phi);
    return out;
}
export function concentricDiskRng(out, rng) {
    const r = _rng(rng);
    return concentricDisk(out, r(), r());
}
/** Uniform point ON the unit circle. */
export function uniformCircle(out, rng) {
    const phi = TAU * _rng(rng)();
    out[0] = Math.cos(phi); out[1] = Math.sin(phi);
    return out;
}
/** Uniform annulus [innerR, outerR]. */
export function uniformAnnulus(out, innerR, outerR, rng) {
    const r = _rng(rng);
    const i2 = innerR * innerR, o2 = outerR * outerR;
    const rad = Math.sqrt(i2 + r() * (o2 - i2));
    const phi = TAU * r();
    out[0] = rad * Math.cos(phi);
    out[1] = rad * Math.sin(phi);
    return out;
}
/** Uniform point on a triangle. Barycentric fold, zero allocation. */
export function uniformTriangle(out, v0, v1, v2, rng) {
    const r = _rng(rng);
    let u = r(), v = r();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const w = 1 - u - v;
    out[0] = w * v0[0] + u * v1[0] + v * v2[0];
    out[1] = w * v0[1] + u * v1[1] + v * v2[1];
    if (out.length > 2 && v0.length > 2) {
        out[2] = w * v0[2] + u * v1[2] + v * v2[2];
    }
    return out;
}
/** Uniform axis-aligned 2D box. */
export function uniformBox2D(out, bounds, rng) {
    const r = _rng(rng);
    out[0] = bounds.minX + r() * (bounds.maxX - bounds.minX);
    out[1] = bounds.minY + r() * (bounds.maxY - bounds.minY);
    return out;
}
/**
 * CORRECTED: exact uniform sampling of a regular hexagon (circumradius 1) via
 * a 6-triangle fan — no rejection, no bias, no allocation.
 */
export function uniformHexagon2D(out, rng) {
    const r = _rng(rng);
    const k = (r() * 6) | 0;
    const k2 = k === 5 ? 0 : k + 1;
    let u = r(), v = r();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    out[0] = u * HEX_VERTS[k * 2] + v * HEX_VERTS[k2 * 2];
    out[1] = u * HEX_VERTS[k * 2 + 1] + v * HEX_VERTS[k2 * 2 + 1];
    return out;
}
/** Uniform regular n-gon (circumradius 1) — triangle-fan sampling. */
export function uniformPolygon2D(out, sides, rng) {
    const n = sides >= 3 ? sides | 0 : 6;
    const r = _rng(rng);
    const k = (r() * n) | 0;
    const a1 = (k / n) * TAU, a2 = ((k + 1) / n) * TAU;
    let u = r(), v = r();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    out[0] = u * Math.cos(a1) + v * Math.cos(a2);
    out[1] = u * Math.sin(a1) + v * Math.sin(a2);
    return out;
}

// ============================================================================
// 3D domains
// ============================================================================
/** Uniform direction on the unit sphere. */
export function uniformSphere(out, rng) {
    const r = _rng(rng);
    const z = 1 - 2 * r();
    const phi = TAU * r();
    const s = Math.sqrt(Math.max(0, 1 - z * z));
    out[0] = s * Math.cos(phi);
    out[1] = s * Math.sin(phi);
    out[2] = z;
    return out;
}
/** Uniform direction on the +Y hemisphere. */
export function uniformHemisphere(out, rng) {
    uniformSphere(out, rng);
    if (out[1] < 0) out[1] = -out[1];
    return out;
}
/** Cosine-weighted +Y hemisphere. pdf = cosθ/π. */
export function cosineHemisphere(out, rng) {
    const r = _rng(rng);
    const u1 = r(), u2 = r();
    const rad = Math.sqrt(u1);
    const phi = TAU * u2;
    out[0] = rad * Math.cos(phi);
    out[1] = Math.sqrt(Math.max(0, 1 - u1));
    out[2] = rad * Math.sin(phi);
    return out;
}
/** Cosine hemisphere from a pre-drawn pair (concentric mapping — QMC friendly). */
export function cosineHemisphereConcentric(out, u1, u2) {
    concentricDisk(_v2, u1, u2);
    out[0] = _v2[0];
    out[2] = _v2[1];
    out[1] = Math.sqrt(Math.max(0, 1 - _v2[0] * _v2[0] - _v2[1] * _v2[1]));
    return out;
}
/** Uniform direction inside a cone about +Y with half-angle acos(cosThetaMax). */
export function uniformCone(out, cosThetaMax, rng) {
    const r = _rng(rng);
    const cosTheta = 1 - r() * (1 - cosThetaMax);
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const phi = TAU * r();
    out[0] = sinTheta * Math.cos(phi);
    out[1] = cosTheta;
    out[2] = sinTheta * Math.sin(phi);
    return out;
}
/** Uniform point inside a 3D box. */
export function uniformBox3D(out, bounds, rng) {
    const r = _rng(rng);
    out[0] = bounds.minX + r() * (bounds.maxX - bounds.minX);
    out[1] = bounds.minY + r() * (bounds.maxY - bounds.minY);
    out[2] = bounds.minZ + r() * (bounds.maxZ - bounds.minZ);
    return out;
}
/** Uniform point inside the unit ball (volume-correct). */
export function uniformBall(out, rng) {
    const r = _rng(rng);
    uniformSphere(out, r);
    const rad = Math.cbrt(r());
    out[0] *= rad; out[1] *= rad; out[2] *= rad;
    return out;
}

/**
 * CORRECTED: area-uniform point ON a capsule surface (p1→p2, radius r).
 * Cylinder side and the two hemispherical caps are chosen by their exact areas.
 */
export function uniformCapsule(out, p1, p2, radius, rng) {
    const r = _rng(rng);
    let ax = p2[0] - p1[0], ay = p2[1] - p1[1], az = p2[2] - p1[2];
    const L = Math.sqrt(ax * ax + ay * ay + az * az);
    if (L < EPSILON) {
        uniformSphere(out, r);
        out[0] = p1[0] + out[0] * radius;
        out[1] = p1[1] + out[1] * radius;
        out[2] = p1[2] + out[2] * radius;
        return out;
    }
    const inv = 1 / L;
    ax *= inv; ay *= inv; az *= inv;
    const pSide = L / (L + 2 * radius);
    if (r() < pSide) {
        _basisFromAxis(_basis6, ax, ay, az);
        const t = r() * L;
        const phi = TAU * r();
        const c = Math.cos(phi) * radius, s = Math.sin(phi) * radius;
        out[0] = p1[0] + ax * t + _basis6[0] * c + _basis6[3] * s;
        out[1] = p1[1] + ay * t + _basis6[1] * c + _basis6[4] * s;
        out[2] = p1[2] + az * t + _basis6[2] * c + _basis6[5] * s;
        return out;
    }
    uniformSphere(_v3a, r);
    const d = _v3a[0] * ax + _v3a[1] * ay + _v3a[2] * az;
    const sign = d >= 0 ? 1 : -1;
    const cx = sign > 0 ? p2[0] : p1[0];
    const cy = sign > 0 ? p2[1] : p1[1];
    const cz = sign > 0 ? p2[2] : p1[2];
    out[0] = cx + _v3a[0] * sign * radius;
    out[1] = cy + _v3a[1] * sign * radius;
    out[2] = cz + _v3a[2] * sign * radius;
    return out;
}
/** Volume-uniform point INSIDE a capsule (cylinder + two half-balls by volume). */
export function uniformCapsuleVolume(out, p1, p2, radius, rng) {
    const r = _rng(rng);
    let ax = p2[0] - p1[0], ay = p2[1] - p1[1], az = p2[2] - p1[2];
    const L = Math.sqrt(ax * ax + ay * ay + az * az);
    if (L < EPSILON) {
        uniformBall(out, r);
        out[0] = p1[0] + out[0] * radius;
        out[1] = p1[1] + out[1] * radius;
        out[2] = p1[2] + out[2] * radius;
        return out;
    }
    const inv = 1 / L;
    ax *= inv; ay *= inv; az *= inv;
    // V_cyl = πr²L ; V_caps = (4/3)πr³  →  pCyl = L / (L + 4r/3)
    const pCyl = L / (L + (4 / 3) * radius);
    if (r() < pCyl) {
        _basisFromAxis(_basis6, ax, ay, az);
        const t = r() * L;
        const rad = Math.sqrt(r()) * radius;
        const phi = TAU * r();
        const c = Math.cos(phi) * rad, s = Math.sin(phi) * rad;
        out[0] = p1[0] + ax * t + _basis6[0] * c + _basis6[3] * s;
        out[1] = p1[1] + ay * t + _basis6[1] * c + _basis6[4] * s;
        out[2] = p1[2] + az * t + _basis6[2] * c + _basis6[5] * s;
        return out;
    }
    uniformBall(_v3a, r);
    const d = _v3a[0] * ax + _v3a[1] * ay + _v3a[2] * az;
    const sign = d >= 0 ? 1 : -1;
    const cx = sign > 0 ? p2[0] : p1[0];
    const cy = sign > 0 ? p2[1] : p1[1];
    const cz = sign > 0 ? p2[2] : p1[2];
    out[0] = cx + _v3a[0] * sign * radius;
    out[1] = cy + _v3a[1] * sign * radius;
    out[2] = cz + _v3a[2] * sign * radius;
    return out;
}

// ============================================================================
// Solid-angle PDFs
// ============================================================================
export function spherePDF() { return 1 / (4 * PI); }
export function hemispherePDF() { return 1 / (2 * PI); }
export function cosineHemispherePDF(cosTheta) { return cosTheta > 0 ? cosTheta * INV_PI : 0; }
export function conePDF(cosThetaMax) {
    const d = 1 - cosThetaMax;
    return d > EPSILON ? 1 / (TAU * d) : 0;
}
export function diskPDF(radius) { const r = radius || 1; return 1 / (PI * r * r); }
/** Area-uniform triangle pdf (1/area). */
export function trianglePDF(v0, v1, v2) {
    const e1x = v1[0] - v0[0], e1y = v1[1] - v0[1], e1z = (v1[2] || 0) - (v0[2] || 0);
    const e2x = v2[0] - v0[0], e2y = v2[1] - v0[1], e2z = (v2[2] || 0) - (v0[2] || 0);
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    const area = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
    return area > EPSILON ? 1 / area : 0;
}

// ============================================================================
// BRDF importance sampling (local frame: +Y = normal)
// ============================================================================
/** Phong lobe: cosθ = u^(1/(n+1)); pdf = (n+1)/(2π)·cosⁿθ. */
export function samplePhong(out, exponent, rng) {
    const r = _rng(rng);
    const cosTheta = Math.pow(r(), 1 / (exponent + 1));
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const phi = TAU * r();
    out[0] = sinTheta * Math.cos(phi);
    out[1] = cosTheta;
    out[2] = sinTheta * Math.sin(phi);
    return out;
}
export function phongPDF(cosTheta, exponent) {
    if (cosTheta <= 0) return 0;
    return (exponent + 1) * INV_TAU * Math.pow(cosTheta, exponent);
}
/**
 * Blinn-Phong half-vector.
 * CORRECTED: sampler and pdf now share the (n+2) NDF convention.
 */
export function sampleBlinnPhong(out, exponent, rng) {
    const r = _rng(rng);
    const cosTheta = Math.pow(r(), 1 / (exponent + 2));
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const phi = TAU * r();
    out[0] = sinTheta * Math.cos(phi);
    out[1] = cosTheta;
    out[2] = sinTheta * Math.sin(phi);
    return out;
}
export function blinnPhongPDF(cosTheta, exponent) {
    if (cosTheta <= 0) return 0;
    return (exponent + 2) * INV_TAU * Math.pow(cosTheta, exponent);
}
/** GGX / Trowbridge-Reitz half-vector (NDF sampling). `roughness` is linear. */
export function sampleGGX(out, roughness, rng) {
    const r = _rng(rng);
    const u1 = r(), u2 = r();
    const a = roughness * roughness;
    const a2 = a * a;
    const phi = TAU * u2;
    const cosTheta = Math.sqrt((1 - u1) / (1 + (a2 - 1) * u1));
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    out[0] = sinTheta * Math.cos(phi);
    out[1] = cosTheta;
    out[2] = sinTheta * Math.sin(phi);
    return out;
}
/** GGX NDF half-vector pdf = D(H)·cosθ. */
export function ggxPDF(cosTheta, roughness) {
    if (cosTheta <= 0) return 0;
    const a = roughness * roughness;
    const a2 = a * a;
    const c2 = cosTheta * cosTheta;
    const t = c2 * (a2 - 1) + 1;
    const D = a2 / (PI * t * t);
    return D * cosTheta;
}
/** GGX pdf with respect to the REFLECTED light direction (divide by 4·V·H). */
export function ggxPDFReflection(cosTheta, VoH, roughness) {
    const p = ggxPDF(cosTheta, roughness);
    const d = 4 * VoH;
    return d > EPSILON ? p / d : 0;
}

/**
 * TRUE GGX VNDF sampling (Heitz 2018 / Dupuy–Benyoub spherical-cap form).
 * CORRECTION: the previous implementation was placeholder arithmetic that
 * discarded V and delegated to NDF sampling.
 * Local frame: +Y = normal. V must point AWAY from the surface.
 */
export function sampleGGXVisible(out, vx, vy, vz, roughness, rng) {
    const r = _rng(rng);
    if (vy <= 0) return sampleGGX(out, roughness, r);
    const a = roughness * roughness;
    // Warp V into the hemisphere configuration.
    let hx = a * vx, hy = vy, hz = a * vz;
    const hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
    if (hl < EPSILON) return sampleGGX(out, roughness, r);
    const hi = 1 / hl;
    hx *= hi; hy *= hi; hz *= hi;
    // Orthonormal basis around Vh.
    const lensq = hx * hx + hz * hz;
    let t1x, t1y, t1z;
    if (lensq > EPSILON) {
        const ti = 1 / Math.sqrt(lensq);
        t1x = -hz * ti; t1y = 0; t1z = hx * ti;
    } else { t1x = 1; t1y = 0; t1z = 0; }
    const t2x = hy * t1z - hz * t1y;
    const t2y = hz * t1x - hx * t1z;
    const t2z = hx * t1y - hy * t1x;
    // Sample a point on the spherical cap.
    const u1 = r(), u2 = r();
    const rad = Math.sqrt(u1);
    const phi = TAU * u2;
    const c1 = rad * Math.cos(phi);
    let c2 = rad * Math.sin(phi);
    const s = 0.5 * (1 + hy);
    c2 = (1 - s) * Math.sqrt(Math.max(0, 1 - c1 * c1)) + s * c2;
    const cz = Math.sqrt(Math.max(0, 1 - c1 * c1 - c2 * c2));
    const nhx = c1 * t1x + c2 * t2x + cz * hx;
    const nhy = c1 * t1y + c2 * t2y + cz * hy;
    const nhz = c1 * t1z + c2 * t2z + cz * hz;
    // Unwarp back to the ellipsoid configuration.
    let ox = a * nhx, oy = nhy, oz = a * nhz;
    const ol = Math.sqrt(ox * ox + oy * oy + oz * oz);
    if (ol < EPSILON) return sampleGGX(out, roughness, r);
    const oi = 1 / ol;
    out[0] = ox * oi; out[1] = oy * oi; out[2] = oz * oi;
    return out;
}
/** VNDF pdf from angles: D(H)·G1(V)·max(0,V·H)/|N·V|. */
export function ggxVisiblePDFAngles(NoV, NoH, VoH, roughness) {
    if (NoH <= 0 || NoV <= 0 || VoH <= 0) return 0;
    const a = roughness * roughness;
    const a2 = a * a;
    const c2 = NoH * NoH;
    const t = c2 * (a2 - 1) + 1;
    const D = a2 / (PI * t * t);
    const denom = NoV + Math.sqrt(a2 + (1 - a2) * NoV * NoV);
    return denom > EPSILON ? D * 2 * VoH / denom : 0;
}
/**
 * CORRECTED signature: a VNDF pdf requires V and H, not just cosθ.
 * V and H are unit vectors in the +Y-up local frame.
 */
export function ggxVisiblePDF(vx, vy, vz, hx, hy, hz, roughness) {
    const VoH = vx * hx + vy * hy + vz * hz;
    return ggxVisiblePDFAngles(vy, hy, VoH, roughness);
}
/** VNDF pdf w.r.t. the reflected light direction. */
export function ggxVisiblePDFReflection(vx, vy, vz, hx, hy, hz, roughness) {
    const VoH = vx * hx + vy * hy + vz * hz;
    const p = ggxVisiblePDFAngles(vy, hy, VoH, roughness);
    const d = 4 * VoH;
    return d > EPSILON ? p / d : 0;
}

/** Beckmann half-vector sampling. */
export function sampleBeckmann(out, roughness, rng) {
    const r = _rng(rng);
    const u1 = r(), u2 = r();
    const a = roughness * roughness;
    const a2 = a * a;
    const phi = TAU * u2;
    const tanTheta2 = -a2 * Math.log(1 - u1);
    const cosTheta = 1 / Math.sqrt(1 + tanTheta2);
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    out[0] = sinTheta * Math.cos(phi);
    out[1] = cosTheta;
    out[2] = sinTheta * Math.sin(phi);
    return out;
}
export function beckmannPDF(cosTheta, roughness) {
    if (cosTheta <= 0) return 0;
    const a = roughness * roughness;
    const a2 = a * a;
    const c2 = cosTheta * cosTheta;
    const tan2 = (1 - c2) / c2;
    const D = Math.exp(-tan2 / a2) / (PI * a2 * c2 * c2);
    return D * cosTheta;
}

// ============================================================================
// Multiple-importance sampling heuristics
// ============================================================================
export function balanceHeuristic(na, pa, nb, pb) {
    const a = na * pa, b = nb * pb;
    const s = a + b;
    return s > EPSILON ? a / s : 0;
}
export function powerHeuristic(na, pa, nb, pb, beta) {
    const e = beta === undefined ? 2 : beta;
    const a = Math.pow(na * pa, e), b = Math.pow(nb * pb, e);
    const s = a + b;
    return s > EPSILON ? a / s : 0;
}

// ============================================================================
// Mesh & curve sampling
// ============================================================================
/** Uniform point on segment p0→p1. */
export function sampleSegment(out, p0, p1, rng) {
    const t = _rng(rng)();
    out[0] = p0[0] + (p1[0] - p0[0]) * t;
    out[1] = p0[1] + (p1[1] - p0[1]) * t;
    if (out.length > 2 && p0.length > 2) out[2] = p0[2] + (p1[2] - p0[2]) * t;
    return out;
}
/** Uniform point on a polyline given a precomputed cumulative arc-length table. */
export function samplePolyline(out, points, lengths, rng, stride) {
    const st = stride === undefined ? 3 : stride;
    const n = lengths.length;
    if (n === 0) return out;
    const total = lengths[n - 1];
    const target = _rng(rng)() * total;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (lengths[mid] < target) lo = mid + 1; else hi = mid;
    }
    const i1 = lo;
    const i0 = lo > 0 ? lo - 1 : 0;
    const segLen = lengths[i1] - lengths[i0];
    const t = segLen > EPSILON ? (target - lengths[i0]) / segLen : 0;
    const o0 = i0 * st, o1 = i1 * st;
    out[0] = points[o0] + (points[o1] - points[o0]) * t;
    out[1] = points[o0 + 1] + (points[o1 + 1] - points[o0 + 1]) * t;
    if (st > 2 && out.length > 2) out[2] = points[o0 + 2] + (points[o1 + 2] - points[o0 + 2]) * t;
    return out;
}
/** Build a cumulative arc-length table for a flat polyline. */
export function buildArcLengthCDF(out, points, count, stride) {
    const st = stride === undefined ? 3 : stride;
    out[0] = 0;
    let acc = 0;
    for (let i = 1; i < count; i++) {
        const o0 = (i - 1) * st, o1 = i * st;
        const dx = points[o1] - points[o0];
        const dy = points[o1 + 1] - points[o0 + 1];
        const dz = st > 2 ? points[o1 + 2] - points[o0 + 2] : 0;
        acc += Math.sqrt(dx * dx + dy * dy + dz * dz);
        out[i] = acc;
    }
    return out;
}
/**
 * Area-weighted point on a mesh.
 * CORRECTED: no per-call vertex array literals — barycentric maths is inlined
 * directly against the flat vertex buffer.
 * `verts` is flat [x,y,z]×3 per triangle; `cumulativeArea` is a CDF over triangles.
 */
export function sampleMeshTriangle(out, verts, cumulativeArea, rng, triIndexOut) {
    const r = _rng(rng);
    const total = cumulativeArea[cumulativeArea.length - 1];
    const target = r() * total;
    let lo = 0, hi = cumulativeArea.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumulativeArea[mid] < target) lo = mid + 1; else hi = mid;
    }
    const base = lo * 9;
    let u = r(), v = r();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const w = 1 - u - v;
    out[0] = w * verts[base] + u * verts[base + 3] + v * verts[base + 6];
    out[1] = w * verts[base + 1] + u * verts[base + 4] + v * verts[base + 7];
    out[2] = w * verts[base + 2] + u * verts[base + 5] + v * verts[base + 8];
    if (triIndexOut) triIndexOut[0] = lo;
    return out;
}
/** Build a cumulative triangle-area CDF from a flat vertex buffer. */
export function buildTriangleAreaCDF(out, verts, triCount) {
    let acc = 0;
    for (let t = 0; t < triCount; t++) {
        const b = t * 9;
        const e1x = verts[b + 3] - verts[b], e1y = verts[b + 4] - verts[b + 1], e1z = verts[b + 5] - verts[b + 2];
        const e2x = verts[b + 6] - verts[b], e2y = verts[b + 7] - verts[b + 1], e2z = verts[b + 8] - verts[b + 2];
        const cx = e1y * e2z - e1z * e2y;
        const cy = e1z * e2x - e1x * e2z;
        const cz = e1x * e2y - e1y * e2x;
        acc += 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
        out[t] = acc;
    }
    return out;
}

// ============================================================================
// Environment maps
// ============================================================================
/** Uniform sphere direction (equirect environment, uniform in solid angle). */
export function sampleEquirect(out, rng) { return uniformSphere(out, rng); }
/** Cosine-weighted direction for irradiance / ambient integrals. */
export function sampleEnvironmentCosine(out, rng) { return cosineHemisphere(out, rng); }
/** Direction → equirect UV. out2 = [u, v]. */
export function directionToEquirect(out2, dx, dy, dz) {
    let u = Math.atan2(dz, dx) * INV_TAU;
    if (u < 0) u += 1;
    const v = Math.acos(dy < -1 ? -1 : (dy > 1 ? 1 : dy)) * INV_PI;
    out2[0] = u; out2[1] = v;
    return out2;
}
/**
 * Build a 2D importance CDF for an equirect luminance map.
 * `rowCDF` (height) is the marginal; `colCDF` (width*height) the conditionals.
 * Rows are weighted by sin(θ) so the sampling is uniform in solid angle.
 */
export function buildEquirectCDF(rowCDF, colCDF, luminance, width, height) {
    const invH = 1 / height;
    let grand = 0;
    for (let y = 0; y < height; y++) {
        const theta = (y + 0.5) * invH * PI;
        const w = Math.sin(theta);
        let rowSum = 0;
        const rowBase = y * width;
        for (let x = 0; x < width; x++) {
            const l = luminance[rowBase + x];
            rowSum += (l > 0 ? l : 0) * w;
        }
        let acc = 0;
        const inv = rowSum > 0 ? 1 / rowSum : 0;
        for (let x = 0; x < width; x++) {
            const l = luminance[rowBase + x];
            acc += (l > 0 ? l : 0) * w * inv;
            colCDF[rowBase + x] = acc;
        }
        if (width > 0) colCDF[rowBase + width - 1] = 1;
        grand += rowSum;
        rowCDF[y] = grand;
    }
    const ginv = grand > 0 ? 1 / grand : 0;
    for (let y = 0; y < height; y++) rowCDF[y] *= ginv;
    if (height > 0) rowCDF[height - 1] = 1;
    return rowCDF;
}
/** Sample an equirect importance CDF. out = direction, outUV = [u,v]. */
export function sampleEquirectImportance(out, outUV, rowCDF, colCDF, width, height, rng) {
    const r = _rng(rng);
    const y = sampleInverseCDF(rowCDF, r, height);
    const rowBase = y * width;
    const u1 = r();
    let lo = 0, hi = width - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (colCDF[rowBase + mid] < u1) lo = mid + 1; else hi = mid;
    }
    const x = lo;
    const u = (x + 0.5) / width;
    const v = (y + 0.5) / height;
    const theta = v * PI, phi = u * TAU;
    const st = Math.sin(theta);
    out[0] = st * Math.cos(phi);
    out[1] = Math.cos(theta);
    out[2] = st * Math.sin(phi);
    if (outUV) { outUV[0] = u; outUV[1] = v; }
    return out;
}

// ============================================================================
// Latin hypercube
// ============================================================================
/**
 * CORRECTED: each axis is shuffled with an INDEPENDENT random index.
 * The previous version reused one index for both permutations, collapsing
 * every sample onto the diagonal.
 */
export function latinHypercube2DInto(outX, outY, n, rng) {
    const r = _rng(rng);
    const px = new Int32Array(n), py = new Int32Array(n);
    for (let i = 0; i < n; i++) { px[i] = i; py[i] = i; }
    for (let i = n - 1; i > 0; i--) {
        let j = (r() * (i + 1)) | 0;
        let t = px[i]; px[i] = px[j]; px[j] = t;
        j = (r() * (i + 1)) | 0;
        t = py[i]; py[i] = py[j]; py[j] = t;
    }
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
        outX[i] = (px[i] + r()) * inv;
        outY[i] = (py[i] + r()) * inv;
    }
    return n;
}
export function latinHypercube2D(outX, outY, n, rng) {
    latinHypercube2DInto(outX, outY, n, rng);
    return { x: outX, y: outY, count: n };
}
export function latinHypercube3DInto(outX, outY, outZ, n, rng) {
    const r = _rng(rng);
    const px = new Int32Array(n), py = new Int32Array(n), pz = new Int32Array(n);
    for (let i = 0; i < n; i++) { px[i] = i; py[i] = i; pz[i] = i; }
    for (let i = n - 1; i > 0; i--) {
        let j = (r() * (i + 1)) | 0;
        let t = px[i]; px[i] = px[j]; px[j] = t;
        j = (r() * (i + 1)) | 0;
        t = py[i]; py[i] = py[j]; py[j] = t;
        j = (r() * (i + 1)) | 0;
        t = pz[i]; pz[i] = pz[j]; pz[j] = t;
    }
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
        outX[i] = (px[i] + r()) * inv;
        outY[i] = (py[i] + r()) * inv;
        outZ[i] = (pz[i] + r()) * inv;
    }
    return n;
}
export function latinHypercube3D(outX, outY, outZ, n, rng) {
    latinHypercube3DInto(outX, outY, outZ, n, rng);
    return { x: outX, y: outY, z: outZ, count: n };
}

// ============================================================================
// Decorrelation
// ============================================================================
/** Cranley–Patterson rotation of a scalar sample. */
export function cranleyPatterson(sample, offset) {
    let v = sample + offset;
    v -= Math.floor(v);
    return v;
}
/**
 * Wang-hash decorrelation.
 * CORRECTED: `Math.imul` throughout (the original lost precision above 2^32)
 * and the broken `> > >` operators repaired.
 */
export function wangHashDecorate(v, seed) {
    let h = (Math.imul(v | 0, 2654435761) + (seed | 0)) | 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
}
/**
 * XOR decorrelation of two float samples.
 * CORRECTED: the original returned a raw integer because `/` binds tighter
 * than `>>>`. Both inputs are now quantized to 32-bit before mixing.
 */
export function xorDecorrelate(a, b) {
    const ia = (a * 4294967296) >>> 0;
    const ib = (b * 4294967296) >>> 0;
    let h = (ia ^ Math.imul(ib, 1000003)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x2545f491);
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
}
/** Per-index deterministic decorrelation (spatial + temporal). */
export function decorrelateIndex(index, frame, seed) {
    let h = Math.imul(index | 0, SALT_A) ^ Math.imul(frame | 0, SALT_B) ^ Math.imul(seed | 0, SALT_C);
    h = Math.imul(h ^ (h >>> 13), 0x85ebca6b);
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
}

// ============================================================================
// Pre-baked kernels
// ============================================================================
/**
 * SSAO hemisphere kernel biased toward the origin.
 * `options.up` selects +Y (default) or +Z (tangent-space convention).
 */
export function generateSSAOKernel(out, count, rng, options) {
    const r = _rng(rng);
    options = options || {};
    const zUp = options.up === "z";
    const minScale = options.minScale === undefined ? 0.1 : options.minScale;
    const ox = out.x, oy = out.y, oz = out.z;
    const inv = count > 0 ? 1 / count : 0;
    for (let i = 0; i < count; i++) {
        uniformHemisphere(_v3a, r);
        let s = i * inv;
        s = minScale + (1 - minScale) * s * s;
        if (zUp) {
            ox[i] = _v3a[0] * s;
            oy[i] = _v3a[2] * s;
            oz[i] = _v3a[1] * s;
        } else {
            ox[i] = _v3a[0] * s;
            oy[i] = _v3a[1] * s;
            oz[i] = _v3a[2] * s;
        }
    }
    return out;
}
/**
 * TAA jitter from Halton(2,3).
 * CORRECTED: default output is sub-pixel jitter in [-0.5,0.5] (as documented).
 * `{ ndc:true }` emits clip-space offsets (2·jitter/screen).
 */
export function generateTAAJitter(out, screenWidth, screenHeight, count, options) {
    options = options || {};
    const ndc = options.ndc === true;
    const start = options.start === undefined ? 1 : options.start;
    const sx = ndc ? 2 / (screenWidth || 1) : 1;
    const sy = ndc ? 2 / (screenHeight || 1) : 1;
    const ox = out.x, oy = out.y;
    for (let i = 0; i < count; i++) {
        const idx = start + i;
        ox[i] = (radicalInverse(idx, 2) - 0.5) * sx;
        oy[i] = (radicalInverse(idx, 3) - 0.5) * sy;
    }
    return out;
}
/**
 * PCSS rotated-Poisson kernel.
 * CORRECTED: radius derived from `count`; always fills exactly `count` taps
 * (Poisson first, best-candidate top-up).
 */
export function generatePCSSKernel(out, count, rng, options) {
    const r = _rng(rng);
    options = options || {};
    const bounds = { minX: -1, minY: -1, maxX: 1, maxY: 1 };
    const radius = options.radius !== undefined
        ? options.radius
        : Math.max(0.02, 1.6 / Math.sqrt(Math.max(1, count)));
    const ox = out.x, oy = out.y;
    const n = poissonDisk2DInto(ox, oy, radius, bounds, options.k || 30, r, count);
    if (n < count) {
        // Top up with best-candidate into the tail (grid-accelerated in 046).
        const tailX = ox.subarray(n);
        const tailY = oy.subarray(n);
        bestCandidate2DInto(tailX, tailY, count - n, bounds, options.candidates || 8, r);
    }
    return count;
}
/**
 * Gaussian DOF disk.
 * CORRECTED: x and y are independent N(0,sigma) — a true 2D Gaussian, not a
 * half-normal radius.
 */
export function generateGaussianDisk(out, count, sigma, rng) {
    const r = _rng(rng);
    const s = sigma === undefined ? 1 : sigma;
    const ox = out.x, oy = out.y;
    for (let i = 0; i < count; i++) {
        normalPairInto(_v2, r);
        ox[i] = _v2[0] * s;
        oy[i] = _v2[1] * s;
    }
    return out;
}
/** Rayleigh-radius disk — the radial form, for importance-sampled bokeh. */
export function generateRayleighDisk(out, count, sigma, rng) {
    const r = _rng(rng);
    const s = sigma === undefined ? 1 : sigma;
    const ox = out.x, oy = out.y;
    for (let i = 0; i < count; i++) {
        const rad = s * Math.sqrt(-2 * Math.log(1 - r()));
        const phi = TAU * r();
        ox[i] = rad * Math.cos(phi);
        oy[i] = rad * Math.sin(phi);
    }
    return out;
}
/** Blue-noise disk kernel (Poisson inside the unit disk). */
export function generateBlueNoiseDisk(out, count, rng) {
    const r = _rng(rng);
    const ox = out.x, oy = out.y;
    const radius = Math.max(0.02, 1.5 / Math.sqrt(Math.max(1, count)));
    const n = poissonDisk2DInto(ox, oy, radius,
        { minX: -1, minY: -1, maxX: 1, maxY: 1 }, 30, r, count * 2);
    let w = 0;
    for (let i = 0; i < n && w < count; i++) {
        const x = ox[i], y = oy[i];
        if (x * x + y * y <= 1) { ox[w] = x; oy[w] = y; w++; }
    }
    while (w < count) {
        concentricDisk(_v2, r(), r());
        ox[w] = _v2[0]; oy[w] = _v2[1]; w++;
    }
    return count;
}

// ============================================================================
// Reservoir sampling (WRS / ReSTIR)
// ============================================================================
/**
 * Weighted reservoir. `weight` is the last accepted candidate weight,
 * `weightSum` the running total, `M` the candidate count, and `W` the
 * resampled importance weight after `finalize(targetPdf)`.
 */
export class Reservoir {
    constructor() {
        this.sample = null;
        this.weight = 0;
        this.weightSum = 0;
        this.M = 0;
        this.W = 0;
        this.targetPdf = 0;
    }
    /** Add a candidate. `weight` must be non-negative. */
    update(sample, weight, rng) {
        const r = _rng(rng);
        const w = weight > 0 ? weight : 0;
        this.weightSum += w;
        this.M++;
        if (this.weightSum > 0 && r() < w / this.weightSum) {
            this.sample = sample;
            this.weight = w;
        }
        return this;
    }
    /** Compute W = weightSum / (M · p̂(z)). Call once after all updates/merges. */
    finalize(targetPdf) {
        const p = typeof targetPdf === "function" ? targetPdf(this.sample) : targetPdf;
        this.targetPdf = p > 0 ? p : 0;
        const d = this.M * this.targetPdf;
        this.W = d > EPSILON ? this.weightSum / d : 0;
        return this.W;
    }
    /**
     * CORRECTED canonical ReSTIR merge. The previous version mixed pre- and
     * post-increment M inside one expression, biasing the result.
     * `targetPdf` is evaluated at BOTH reservoirs' samples.
     */
    merge(other, targetPdf, rng, maxM) {
        if (!other || other.M === 0 || other.sample === null) return this;
        const pOther = typeof targetPdf === "function" ? targetPdf(other.sample) : targetPdf;
        const contribution = other.W * (pOther > 0 ? pOther : 0) * other.M;
        const mOther = other.M;
        const r = _rng(rng);
        const w = contribution > 0 ? contribution : 0;
        this.weightSum += w;
        if (this.weightSum > 0 && r() < w / this.weightSum) {
            this.sample = other.sample;
            this.weight = w;
        }
        this.M += mOther;
        if (maxM !== undefined && this.M > maxM) {
            const scale = maxM / this.M;
            this.weightSum *= scale;
            this.M = maxM;
        }
        this.finalize(targetPdf);
        return this;
    }
    /** Back-compat estimate: W if finalized, otherwise weightSum/M. */
    getEstimate() {
        if (this.W > 0) return this.W;
        return this.M > 0 ? this.weightSum / this.M : 0;
    }
    reset() {
        this.sample = null;
        this.weight = 0;
        this.weightSum = 0;
        this.M = 0;
        this.W = 0;
        this.targetPdf = 0;
        return this;
    }
    clone() {
        const r = new Reservoir();
        r.sample = this.sample; r.weight = this.weight;
        r.weightSum = this.weightSum; r.M = this.M;
        r.W = this.W; r.targetPdf = this.targetPdf;
        return r;
    }
}
/** Weighted reservoir over an explicit candidate list (setup-time allocation). */
export function reservoirResample(candidates, weights, M, rng) {
    const r = new Reservoir();
    const n = M === undefined ? weights.length : M;
    for (let i = 0; i < n; i++) r.update(candidates[i], weights[i], rng);
    return r;
}
/** Merge `b` into `a` (canonical ReSTIR). */
export function mergeReservoirs(a, b, targetPdf, rng, maxM) {
    return a.merge(b, targetPdf, rng, maxM);
}
/**
 * SOA reservoir resampling — ZERO allocation.
 * CORRECTED: the previous version allocated one `Reservoir` object per row.
 * `weights` may be a flat M×count matrix, a per-candidate array of length M,
 * or a function (m, i) => weight.
 * outIdx[i] = selected candidate index; outW[i] = weightSum / M.
 */
export function soaReservoirResample(outIdx, outW, weights, M, count, rng, options) {
    const r = _rng(rng);
    options = options || {};
    _ensureReservoirState(count);
    const sum = _rsSum, seen = _rsSeen, sel = _rsSel;
    for (let i = 0; i < count; i++) { sum[i] = 0; seen[i] = 0; sel[i] = -1; }
    const isFn = typeof weights === "function";
    const flat = !isFn && weights.length >= M * count;
    for (let m = 0; m < M; m++) {
        const rowBase = m * count;
        const shared = (!isFn && !flat) ? (weights[m] || 0) : 0;
        for (let i = 0; i < count; i++) {
            const w0 = isFn ? weights(m, i) : (flat ? weights[rowBase + i] : shared);
            const w = w0 > 0 ? w0 : 0;
            sum[i] += w;
            seen[i]++;
            if (sum[i] > 0 && r() < w / sum[i]) sel[i] = m;
        }
    }
    for (let i = 0; i < count; i++) {
        outIdx[i] = sel[i] < 0 ? 0 : sel[i];
        outW[i] = seen[i] > 0 ? sum[i] / seen[i] : 0;
    }
    return count;
}

// ============================================================================
// Volumetric tracking
// ============================================================================
/**
 * Delta (Woodcock) tracking. Returns the collision distance or -1.
 * CORRECTED: guarded against a zero/negative majorant and bounded iterations.
 */
export function deltaTracking(densityFn, maxDensity, maxDist, rng, maxSteps) {
    const r = _rng(rng);
    if (!(maxDensity > 0) || !(maxDist > 0)) return -1;
    const inv = 1 / maxDensity;
    const limit = maxSteps || 4096;
    let t = 0;
    for (let i = 0; i < limit; i++) {
        t -= Math.log(1 - r()) * inv;
        if (t >= maxDist) return -1;
        const d = densityFn(t);
        if (d > 0 && r() < d * inv) return t;
    }
    return -1;
}
/**
 * Ratio tracking — unbiased transmittance over [0, maxDist].
 * CORRECTED: guarded majorant, bounded steps, optional Russian roulette.
 */
export function ratioTracking(sigmaMajor, sigmaMinorFn, maxDist, rng, options) {
    const r = _rng(rng);
    if (!(maxDist > 0)) return 1;
    if (!(sigmaMajor > 0)) return 1;
    options = options || {};
    const limit = options.maxSteps || 4096;
    const rr = options.rrThreshold;
    const inv = 1 / sigmaMajor;
    let t = 0, weight = 1;
    for (let i = 0; i < limit; i++) {
        t -= Math.log(1 - r()) * inv;
        if (t >= maxDist) break;
        const sm = sigmaMinorFn(t);
        weight *= 1 - (sm > 0 ? sm : 0) * inv;
        if (weight <= 0) return 0;
        if (rr !== undefined && weight < rr) {
            const q = r();
            if (q > weight / rr) return 0;
            weight = rr;
        }
    }
    return weight;
}

// ============================================================================
// MCMC
// ============================================================================
/** Metropolis–Hastings. `proposal(x, rng)` returns a candidate. */
export function metropolisHastings(x0, logTarget, proposal, numSamples, rng, options) {
    const r = _rng(rng);
    options = options || {};
    const burnIn = options.burnIn || 0;
    const out = new Array(numSamples);
    let x = x0;
    let logP = logTarget(x);
    for (let i = -burnIn; i < numSamples; i++) {
        const y = proposal(x, r);
        const logQ = logTarget(y);
        if (Math.log(r()) < logQ - logP) { x = y; logP = logQ; }
        if (i >= 0) out[i] = x;
    }
    return out;
}
/** Zero-allocation MH into a caller-owned scalar buffer. */
export function metropolisHastingsInto(out, x0, logTarget, proposal, numSamples, rng, options) {
    const r = _rng(rng);
    options = options || {};
    const burnIn = options.burnIn || 0;
    let x = x0;
    let logP = logTarget(x);
    for (let i = -burnIn; i < numSamples; i++) {
        const y = proposal(x, r);
        const logQ = logTarget(y);
        if (Math.log(r()) < logQ - logP) { x = y; logP = logQ; }
        if (i >= 0) out[i] = x;
    }
    return out;
}
/** Gibbs sampling on 2D. */
export function gibbsSample(x0, y0, condX, condY, numSamples, rng) {
    const r = _rng(rng);
    const out = new Array(numSamples);
    let x = x0, y = y0;
    for (let i = 0; i < numSamples; i++) {
        x = condX(y, r);
        y = condY(x, r);
        out[i] = [x, y];
    }
    return out;
}
/** Zero-allocation Gibbs into two caller-owned buffers. */
export function gibbsSampleInto(outX, outY, x0, y0, condX, condY, numSamples, rng) {
    const r = _rng(rng);
    let x = x0, y = y0;
    for (let i = 0; i < numSamples; i++) {
        x = condX(y, r);
        y = condY(x, r);
        outX[i] = x; outY[i] = y;
    }
    return outX;
}

// ============================================================================
// IK / Orbital / Procedural
// ============================================================================
/**
 * Reachable IK target.
 * `options.volume === true` gives a volume-uniform shell (cbrt radius law);
 * the default is the surface-biased linear-radius form.
 */
export function sampleReachableIKTarget(out, root, minReach, maxReach, rng, options) {
    const r = _rng(rng);
    options = options || {};
    uniformSphere(out, r);
    let rad;
    if (options.volume === true) {
        const a = minReach * minReach * minReach;
        const b = maxReach * maxReach * maxReach;
        rad = Math.cbrt(a + r() * (b - a));
    } else {
        rad = minReach + r() * (maxReach - minReach);
    }
    out[0] = root[0] + out[0] * rad;
    out[1] = root[1] + out[1] * rad;
    out[2] = root[2] + out[2] * rad;
    return out;
}
/**
 * CORRECTED: one mean anomaly for BOTH position and velocity.
 * The separate samplers previously drew independent M values.
 */
export function sampleOrbitalState(outPos, outVel, a, e, inc, Om, om, mu, rng) {
    const M = TAU * _rng(rng)();
    vec3.keplerOrbit3D(outPos, a, e, M, inc, Om, om);
    vec3.keplerOrbitVelocity3D(outVel, a, e, M, inc, Om, om, mu);
    return outPos;
}
/** Orbital position. Pass `M` to reuse a specific mean anomaly. */
export function sampleOrbitalPosition(out, a, e, inc, Om, om, rng, M) {
    const m = M === undefined ? TAU * _rng(rng)() : M;
    return vec3.keplerOrbit3D(out, a, e, m, inc, Om, om);
}
/** Orbital velocity. Pass the SAME `M` used for the position. */
export function sampleOrbitalVelocity(out, a, e, inc, Om, om, mu, rng, M) {
    const m = M === undefined ? TAU * _rng(rng)() : M;
    return vec3.keplerOrbitVelocity3D(out, a, e, m, inc, Om, om, mu);
}
/**
 * Noise-weighted procedural scatter in normalized [0,1]³.
 * Bounded attempts with a deterministic fallback so the batch always fills.
 */
export function sampleScatter(outPositions, noiseFn, scale, rng, count, options) {
    const r = _rng(rng);
    options = options || {};
    count = count === undefined ? outPositions.count : count;
    const s = scale === undefined ? 1 : scale;
    const maxAttempts = options.maxAttempts || count * 100;
    const ox = outPositions.x, oy = outPositions.y, oz = outPositions.z;
    let placed = 0, tries = 0;
    while (placed < count && tries < maxAttempts) {
        tries++;
        const x = r(), y = r(), z = r();
        const n = (noiseFn(x * s, y * s, z * s) + 1) * 0.5;
        if (r() < n) { ox[placed] = x; oy[placed] = y; oz[placed] = z; placed++; }
    }
    while (placed < count) {
        ox[placed] = r(); oy[placed] = r(); oz[placed] = r(); placed++;
    }
    return { placed: placed, tries: tries };
}
/** Blue-noise scatter in normalized [0,1]³ with a minimum separation. */
export function sampleScatterBlue(outPositions, radius, rng, count, options) {
    const r = _rng(rng);
    options = options || {};
    count = count === undefined ? outPositions.count : count;
    const bounds = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 };
    const ox = outPositions.x, oy = outPositions.y, oz = outPositions.z;
    const n = poissonDisk3DInto(ox, oy, oz, radius, bounds, options.k || 30, r, count);
    if (n < count) {
        bestCandidate3DInto(
            ox.subarray(n), oy.subarray(n), oz.subarray(n),
            count - n, bounds, options.candidates || 8, r
        );
    }
    return count;
}
/** Curl-noise flow scatter — advect normalized samples through a divergence-free field. */
export function sampleScatterCurl(outPositions, noiseFn, scale, strength, rng, count) {
    const r = _rng(rng);
    count = count === undefined ? outPositions.count : count;
    const ox = outPositions.x, oy = outPositions.y, oz = outPositions.z;
    for (let i = 0; i < count; i++) {
        const x = r(), y = r(), z = r();
        curl3D(_v3a, x, y, z, scale);
        let nx = x + _v3a[0] * strength;
        let ny = y + _v3a[1] * strength;
        let nz = z + _v3a[2] * strength;
        nx -= Math.floor(nx); ny -= Math.floor(ny); nz -= Math.floor(nz);
        ox[i] = nx; oy[i] = ny; oz[i] = nz;
    }
    return outPositions;
}

// ============================================================================
// Double-single precision bridge (Blueprint §26)
// ============================================================================
/** out2 = [hi, lo] of a + b, renormalized with a full TwoSum. */
export function dsAddInto(out2, a, b) {
    const s = a + b;
    const bb = s - a;
    out2[0] = s;
    out2[1] = (a - (s - bb)) + (b - bb);
    return out2;
}
/** out2 = (aHi,aLo) + (bHi,bLo), renormalized. */
export function dsAdd22Into(out2, aHi, aLo, bHi, bLo) {
    dsAddInto(_ds3, aHi, bHi);
    const sh = _ds3[0], sl = _ds3[1];
    dsAddInto(_ds4, aLo, bLo);
    const c = sl + _ds4[0];
    dsAddInto(out2, sh, c + _ds4[1]);
    return out2;
}
/** out2 = (aHi,aLo) − (bHi,bLo), renormalized BEFORE any narrowing cast. */
export function dsSubInto(out2, aHi, aLo, bHi, bLo) {
    return dsAdd22Into(out2, aHi, aLo, -bHi, -bLo);
}
/** out2 = a·b exactly (Dekker split). */
export function dsMulInto(out2, a, b) {
    const SPLIT = 134217729;
    const p = a * b;
    const ta = SPLIT * a, tb = SPLIT * b;
    let lo = 0;
    if (isFinite(ta) && isFinite(tb)) {
        const ah = ta + (a - ta), al = a - ah;
        const bh = tb + (b - tb), bl = b - bh;
        lo = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
    }
    out2[0] = p; out2[1] = lo;
    return out2;
}
/** Camera-relative Float32 scalar from double-single inputs. */
export function dsSubF32(aHi, aLo, bHi, bLo) {
    dsSubInto(_ds2, aHi, aLo, bHi, bLo);
    return Math.fround(_ds2[0] + _ds2[1]);
}
/** out2 = origin + (s − 0.5)·extent, exact to ~106 bits. */
export function sampleToWorldDS(out2, s, originHi, originLo, extent) {
    dsMulInto(_quad4, s - 0.5, extent);
    return dsAdd22Into(out2, originHi, originLo, _quad4[0], _quad4[1]);
}
/**
 * Lift normalized [0,1] samples into a double-single world store
 * `{ x:{hi,lo}, y:{hi,lo}, z:{hi,lo} }`.
 */
export function soaSamplesToWorldDS(world, samples, originHi, originLo, extent, eids, count) {
    count = count === undefined ? samples.count : count;
    const ex = _isArr(extent) ? extent[0] : extent;
    const ey = _isArr(extent) ? extent[1] : extent;
    const ez = _isArr(extent) ? extent[2] : extent;
    const sx = samples.x, sy = samples.y, sz = samples.z;
    const xh = world.x.hi, xl = world.x.lo;
    const yh = world.y.hi, yl = world.y.lo;
    const zh = world.z ? world.z.hi : null, zl = world.z ? world.z.lo : null;
    for (let i = 0; i < count; i++) {
        const idx = eids ? eids[i] : i;
        sampleToWorldDS(_ds2, sx[i], originHi[0], originLo ? originLo[0] : 0, ex);
        xh[idx] = _ds2[0]; xl[idx] = _ds2[1];
        sampleToWorldDS(_ds2, sy[i], originHi[1], originLo ? originLo[1] : 0, ey);
        yh[idx] = _ds2[0]; yl[idx] = _ds2[1];
        if (zh && sz) {
            sampleToWorldDS(_ds2, sz[i], originHi[2], originLo ? originLo[2] : 0, ez);
            zh[idx] = _ds2[0]; zl[idx] = _ds2[1];
        }
    }
    return world;
}
/** Full §26 pipeline: normalized samples → exact DS world → camera-relative f32. */
export function soaSamplesToRelative(outVec3, samples, originHi, originLo, extent, cameraHi, cameraLo, count) {
    count = count === undefined ? samples.count : count;
    const ex = _isArr(extent) ? extent[0] : extent;
    const ey = _isArr(extent) ? extent[1] : extent;
    const ez = _isArr(extent) ? extent[2] : extent;
    const sx = samples.x, sy = samples.y, sz = samples.z;
    const ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
    const c0 = cameraHi[0], c1 = cameraHi[1], c2 = cameraHi[2];
    const l0 = cameraLo ? cameraLo[0] : 0;
    const l1 = cameraLo ? cameraLo[1] : 0;
    const l2 = cameraLo ? cameraLo[2] : 0;
    for (let i = 0; i < count; i++) {
        sampleToWorldDS(_ds2, sx[i], originHi[0], originLo ? originLo[0] : 0, ex);
        dsSubInto(_ds3, _ds2[0], _ds2[1], c0, l0);
        ox[i] = Math.fround(_ds3[0] + _ds3[1]);
        sampleToWorldDS(_ds2, sy[i], originHi[1], originLo ? originLo[1] : 0, ey);
        dsSubInto(_ds3, _ds2[0], _ds2[1], c1, l1);
        oy[i] = Math.fround(_ds3[0] + _ds3[1]);
        if (sz) {
            sampleToWorldDS(_ds2, sz[i], originHi[2], originLo ? originLo[2] : 0, ez);
            dsSubInto(_ds3, _ds2[0], _ds2[1], c2, l2);
            oz[i] = Math.fround(_ds3[0] + _ds3[1]);
        }
    }
    return outVec3;
}

// ============================================================================
// SOA — synchronous, zero allocation
// ============================================================================
export function soaUniform(rng, out, count) {
    count = count === undefined ? out.length : count;
    const r = _rng(rng);
    for (let i = 0; i < count; i++) out[i] = r();
    return out;
}
export function soaUniformRange(out, min, max, rng, count) {
    count = count === undefined ? out.length : count;
    const r = _rng(rng);
    const span = max - min;
    for (let i = 0; i < count; i++) out[i] = min + r() * span;
    return out;
}
export function soaNormal(out, mu, sigma, rng, count) {
    count = count === undefined ? out.length : count;
    const r = _rng(rng);
    const m = mu === undefined ? 0 : mu;
    const s = sigma === undefined ? 1 : sigma;
    for (let i = 0; i < count; i += 2) {
        normalPairInto(_v2, r);
        out[i] = m + _v2[0] * s;
        if (i + 1 < count) out[i + 1] = m + _v2[1] * s;
    }
    return out;
}
export function soaExponential(out, lambda, rng, count) {
    count = count === undefined ? out.length : count;
    const r = _rng(rng);
    const inv = 1 / (lambda > 0 ? lambda : 1);
    for (let i = 0; i < count; i++) out[i] = -Math.log(1 - r()) * inv;
    return out;
}
export function soaUniformSphere(out, rng, count) {
    count = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y, oz = out.z;
    const r = _rng(rng);
    for (let i = 0; i < count; i++) {
        const z = 1 - 2 * r();
        const phi = TAU * r();
        const s = Math.sqrt(Math.max(0, 1 - z * z));
        ox[i] = s * Math.cos(phi);
        oy[i] = s * Math.sin(phi);
        oz[i] = z;
    }
    return out;
}
export function soaUniformHemisphere(out, rng, count) {
    soaUniformSphere(out, rng, count);
    const oy = out.y;
    const n = count === undefined ? out.count : count;
    for (let i = 0; i < n; i++) if (oy[i] < 0) oy[i] = -oy[i];
    return out;
}
export function soaCosineHemisphere(out, rng, count) {
    count = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y, oz = out.z;
    const r = _rng(rng);
    for (let i = 0; i < count; i++) {
        const u1 = r(), u2 = r();
        const rad = Math.sqrt(u1);
        const phi = TAU * u2;
        ox[i] = rad * Math.cos(phi);
        oy[i] = Math.sqrt(Math.max(0, 1 - u1));
        oz[i] = rad * Math.sin(phi);
    }
    return out;
}
/** Cosine hemisphere from a 2D QMC SOA (concentric mapping — preserves stratification). */
export function soaCosineHemisphereFrom2D(out, uv, count) {
    count = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y, oz = out.z;
    const ux = uv.x, uy = uv.y;
    for (let i = 0; i < count; i++) {
        concentricDisk(_v2, ux[i], uy[i]);
        ox[i] = _v2[0];
        oz[i] = _v2[1];
        oy[i] = Math.sqrt(Math.max(0, 1 - _v2[0] * _v2[0] - _v2[1] * _v2[1]));
    }
    return out;
}
export function soaUniformCone(out, cosThetaMax, rng, count) {
    count = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y, oz = out.z;
    const r = _rng(rng);
    const span = 1 - cosThetaMax;
    for (let i = 0; i < count; i++) {
        const cosTheta = 1 - r() * span;
        const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
        const phi = TAU * r();
        ox[i] = sinTheta * Math.cos(phi);
        oy[i] = cosTheta;
        oz[i] = sinTheta * Math.sin(phi);
    }
    return out;
}
export function soaUniformDisk(out, rng, count) {
    count = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y;
    const r = _rng(rng);
    for (let i = 0; i < count; i++) {
        const rad = Math.sqrt(r());
        const phi = TAU * r();
        ox[i] = rad * Math.cos(phi);
        oy[i] = rad * Math.sin(phi);
    }
    return out;
}
export function soaConcentricDisk(out, rng, count) {
    count = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y;
    const r = _rng(rng);
    for (let i = 0; i < count; i++) {
        concentricDisk(_v2, r(), r());
        ox[i] = _v2[0]; oy[i] = _v2[1];
    }
    return out;
}
export function soaUniformTriangle(out, v0Arr, v1Arr, v2Arr, rng, count) {
    count = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y, oz = out.z;
    const r = _rng(rng);
    for (let i = 0; i < count; i++) {
        let u = r(), v = r();
        if (u + v > 1) { u = 1 - u; v = 1 - v; }
        const w = 1 - u - v;
        ox[i] = w * v0Arr.x[i] + u * v1Arr.x[i] + v * v2Arr.x[i];
        oy[i] = w * v0Arr.y[i] + u * v1Arr.y[i] + v * v2Arr.y[i];
        oz[i] = w * v0Arr.z[i] + u * v1Arr.z[i] + v * v2Arr.z[i];
    }
    return out;
}
/** GGX NDF half-vectors. `roughness` may be a scalar or a per-row array. */
export function soaSampleGGX(out, roughness, rng, count) {
    count = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y, oz = out.z;
    const r = _rng(rng);
    const rArr = _isArr(roughness) ? roughness : null;
    for (let i = 0; i < count; i++) {
        const rough = rArr ? rArr[i] : roughness;
        const a = rough * rough, a2 = a * a;
        const u1 = r(), u2 = r();
        const phi = TAU * u2;
        const cosTheta = Math.sqrt((1 - u1) / (1 + (a2 - 1) * u1));
        const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
        ox[i] = sinTheta * Math.cos(phi);
        oy[i] = cosTheta;
        oz[i] = sinTheta * Math.sin(phi);
    }
    return out;
}
/**
 * TRUE GGX VNDF over an SOA of view directions.
 * CORRECTED: the previous version delegated to NDF sampling.
 */
export function soaSampleGGXVisible(out, vDir, roughness, rng, count) {
    count = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y, oz = out.z;
    const vx = vDir.x, vy = vDir.y, vz = vDir.z;
    const r = _rng(rng);
    const rArr = _isArr(roughness) ? roughness : null;
    for (let i = 0; i < count; i++) {
        const rough = rArr ? rArr[i] : roughness;
        const VY = vy[i];
        if (VY <= 0) {
            const a0 = rough * rough, a02 = a0 * a0;
            const u1 = r(), u2 = r();
            const ct = Math.sqrt((1 - u1) / (1 + (a02 - 1) * u1));
            const st = Math.sqrt(Math.max(0, 1 - ct * ct));
            const ph = TAU * u2;
            ox[i] = st * Math.cos(ph); oy[i] = ct; oz[i] = st * Math.sin(ph);
            continue;
        }
        const a = rough * rough;
        let hx = a * vx[i], hy = VY, hz = a * vz[i];
        const hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
        if (hl < EPSILON) { ox[i] = 0; oy[i] = 1; oz[i] = 0; continue; }
        const hi = 1 / hl;
        hx *= hi; hy *= hi; hz *= hi;
        const lensq = hx * hx + hz * hz;
        let t1x, t1z;
        if (lensq > EPSILON) {
            const ti = 1 / Math.sqrt(lensq);
            t1x = -hz * ti; t1z = hx * ti;
        } else { t1x = 1; t1z = 0; }
        const t2x = hy * t1z;
        const t2y = hz * t1x - hx * t1z;
        const t2z = -hy * t1x;
        const u1 = r(), u2 = r();
        const rad = Math.sqrt(u1);
        const phi = TAU * u2;
        const c1 = rad * Math.cos(phi);
        let c2 = rad * Math.sin(phi);
        const s = 0.5 * (1 + hy);
        c2 = (1 - s) * Math.sqrt(Math.max(0, 1 - c1 * c1)) + s * c2;
        const cz = Math.sqrt(Math.max(0, 1 - c1 * c1 - c2 * c2));
        const nhx = c1 * t1x + c2 * t2x + cz * hx;
        const nhy = c2 * t2y + cz * hy;
        const nhz = c1 * t1z + c2 * t2z + cz * hz;
        let px = a * nhx, py = nhy, pz = a * nhz;
        const pl = Math.sqrt(px * px + py * py + pz * pz);
        const pi = pl > EPSILON ? 1 / pl : 0;
        ox[i] = px * pi; oy[i] = py * pi; oz[i] = pz * pi;
    }
    return out;
}
/** Per-row PDF evaluation for a cosine hemisphere batch. */
export function soaCosinePDF(out, dirs, count) {
    count = count === undefined ? out.length : count;
    const dy = dirs.y;
    for (let i = 0; i < count; i++) out[i] = dy[i] > 0 ? dy[i] * INV_PI : 0;
    return out;
}
/** Per-row GGX NDF pdf. */
export function soaGGXPDF(out, dirs, roughness, count) {
    count = count === undefined ? out.length : count;
    const dy = dirs.y;
    const rArr = _isArr(roughness) ? roughness : null;
    for (let i = 0; i < count; i++) {
        const ct = dy[i];
        if (ct <= 0) { out[i] = 0; continue; }
        const rough = rArr ? rArr[i] : roughness;
        const a = rough * rough, a2 = a * a;
        const c2 = ct * ct;
        const t = c2 * (a2 - 1) + 1;
        out[i] = (a2 / (PI * t * t)) * ct;
    }
    return out;
}
/** Per-row GGX VNDF pdf (half-vector solid angle). */
export function soaGGXVisiblePDF(out, vDir, hDir, roughness, count) {
    count = count === undefined ? out.length : count;
    const vx = vDir.x, vy = vDir.y, vz = vDir.z;
    const hx = hDir.x, hy = hDir.y, hz = hDir.z;
    const rArr = _isArr(roughness) ? roughness : null;
    for (let i = 0; i < count; i++) {
        const NoV = vy[i], NoH = hy[i];
        const VoH = vx[i] * hx[i] + NoV * NoH + vz[i] * hz[i];
        if (NoH <= 0 || NoV <= 0 || VoH <= 0) { out[i] = 0; continue; }
        const rough = rArr ? rArr[i] : roughness;
        const a = rough * rough, a2 = a * a;
        const c2 = NoH * NoH;
        const t = c2 * (a2 - 1) + 1;
        const D = a2 / (PI * t * t);
        const denom = NoV + Math.sqrt(a2 + (1 - a2) * NoV * NoV);
        out[i] = denom > EPSILON ? D * 2 * VoH / denom : 0;
    }
    return out;
}
/** SSAO-style jittered hemisphere with origin bias. */
export function soaJitteredHemisphere(out, rng, count) {
    count = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y, oz = out.z;
    const r = _rng(rng);
    const inv = count > 0 ? 1 / count : 0;
    for (let i = 0; i < count; i++) {
        uniformHemisphere(_v3a, r);
        let s = i * inv;
        s = 0.1 + 0.9 * s * s;
        ox[i] = _v3a[0] * s;
        oy[i] = _v3a[1] * s;
        oz[i] = _v3a[2] * s;
    }
    return out;
}
/** Map normalized [0,1] samples into world bounds (zero-GC). */
export function soaRemapBounds(positions, bounds, count) {
    const n = count === undefined ? positions.count : count;
    const x = positions.x, y = positions.y, z = positions.z;
    const minX = bounds.minX === undefined ? 0 : bounds.minX;
    const minY = bounds.minY === undefined ? 0 : bounds.minY;
    const rx = (bounds.maxX === undefined ? 1 : bounds.maxX) - minX;
    const ry = (bounds.maxY === undefined ? 1 : bounds.maxY) - minY;
    if (z && bounds.minZ !== undefined) {
        const minZ = bounds.minZ;
        const rz = (bounds.maxZ === undefined ? 1 : bounds.maxZ) - minZ;
        for (let i = 0; i < n; i++) {
            x[i] = minX + x[i] * rx;
            y[i] = minY + y[i] * ry;
            z[i] = minZ + z[i] * rz;
        }
    } else {
        for (let i = 0; i < n; i++) {
            x[i] = minX + x[i] * rx;
            y[i] = minY + y[i] * ry;
        }
    }
    return positions;
}

// ============================================================================
// Chunked async — one closure per CALL (async / loading path only, §1)
// ============================================================================
async function _chunked(count, chunkSize, yieldEvery, perChunk) {
    chunkSize = chunkSize || common.CHUNK_SIZE;
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

export async function soaUniformSphereChunked(out, rng, count, cs, ye) {
    count = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y, oz = out.z;
    const r = _rng(rng);
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            const z = 1 - 2 * r();
            const phi = TAU * r();
            const sr = Math.sqrt(Math.max(0, 1 - z * z));
            ox[i] = sr * Math.cos(phi);
            oy[i] = sr * Math.sin(phi);
            oz[i] = z;
        }
    });
    return out;
}
export async function soaCosineHemisphereChunked(out, rng, count, cs, ye) {
    count = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y, oz = out.z;
    const r = _rng(rng);
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            const u1 = r(), u2 = r();
            const rad = Math.sqrt(u1);
            const phi = TAU * u2;
            ox[i] = rad * Math.cos(phi);
            oy[i] = Math.sqrt(Math.max(0, 1 - u1));
            oz[i] = rad * Math.sin(phi);
        }
    });
    return out;
}
export async function soaUniformConeChunked(out, cosThetaMax, rng, count, cs, ye) {
    count = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y, oz = out.z;
    const r = _rng(rng);
    const span = 1 - cosThetaMax;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            const ct = 1 - r() * span;
            const st = Math.sqrt(Math.max(0, 1 - ct * ct));
            const phi = TAU * r();
            ox[i] = st * Math.cos(phi); oy[i] = ct; oz[i] = st * Math.sin(phi);
        }
    });
    return out;
}
export async function soaUniformDiskChunked(out, rng, count, cs, ye) {
    count = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y;
    const r = _rng(rng);
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            concentricDisk(_v2, r(), r());
            ox[i] = _v2[0]; oy[i] = _v2[1];
        }
    });
    return out;
}
export async function soaUniformTriangleChunked(out, v0Arr, v1Arr, v2Arr, rng, count, cs, ye) {
    count = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y, oz = out.z;
    const r = _rng(rng);
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            let u = r(), v = r();
            if (u + v > 1) { u = 1 - u; v = 1 - v; }
            const w = 1 - u - v;
            ox[i] = w * v0Arr.x[i] + u * v1Arr.x[i] + v * v2Arr.x[i];
            oy[i] = w * v0Arr.y[i] + u * v1Arr.y[i] + v * v2Arr.y[i];
            oz[i] = w * v0Arr.z[i] + u * v1Arr.z[i] + v * v2Arr.z[i];
        }
    });
    return out;
}
export async function soaSampleGGXChunked(out, roughness, rng, count, cs, ye) {
    count = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y, oz = out.z;
    const r = _rng(rng);
    const rArr = _isArr(roughness) ? roughness : null;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            const rough = rArr ? rArr[i] : roughness;
            const a = rough * rough, a2 = a * a;
            const u1 = r(), u2 = r();
            const phi = TAU * u2;
            const ct = Math.sqrt((1 - u1) / (1 + (a2 - 1) * u1));
            const st = Math.sqrt(Math.max(0, 1 - ct * ct));
            ox[i] = st * Math.cos(phi); oy[i] = ct; oz[i] = st * Math.sin(phi);
        }
    });
    return out;
}
export async function soaSampleGGXVisibleChunked(out, vDir, roughness, rng, count, cs, ye) {
    count = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y, oz = out.z;
    const vx = vDir.x, vy = vDir.y, vz = vDir.z;
    const r = _rng(rng);
    const rArr = _isArr(roughness) ? roughness : null;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            const rough = rArr ? rArr[i] : roughness;
            sampleGGXVisible(_v3a, vx[i], vy[i], vz[i], rough, r);
            ox[i] = _v3a[0]; oy[i] = _v3a[1]; oz[i] = _v3a[2];
        }
    });
    return out;
}
export async function soaNormalChunked(out, mu, sigma, rng, count, cs, ye) {
    count = count === undefined ? out.length : count;
    const r = _rng(rng);
    const m = mu === undefined ? 0 : mu;
    const sg = sigma === undefined ? 1 : sigma;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i += 2) {
            normalPairInto(_v2, r);
            out[i] = m + _v2[0] * sg;
            if (i + 1 < e) out[i + 1] = m + _v2[1] * sg;
        }
    });
    return out;
}
export async function soaReservoirResampleChunked(outIdx, outW, weights, M, count, rng, cs, ye) {
    const r = _rng(rng);
    _ensureReservoirState(count);
    const sum = _rsSum, seen = _rsSeen, sel = _rsSel;
    for (let i = 0; i < count; i++) { sum[i] = 0; seen[i] = 0; sel[i] = -1; }
    const isFn = typeof weights === "function";
    const flat = !isFn && weights.length >= M * count;
    let chunks = 0;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    for (let m = 0; m < M; m++) {
        const rowBase = m * count;
        const shared = (!isFn && !flat) ? (weights[m] || 0) : 0;
        await _chunked(count, cs, ye, function (s, e) {
            for (let i = s; i < e; i++) {
                const w0 = isFn ? weights(m, i) : (flat ? weights[rowBase + i] : shared);
                const w = w0 > 0 ? w0 : 0;
                sum[i] += w;
                seen[i]++;
                if (sum[i] > 0 && r() < w / sum[i]) sel[i] = m;
            }
        });
        if (++chunks >= ye) { chunks = 0; await common.yieldToMain(); }
    }
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            outIdx[i] = sel[i] < 0 ? 0 : sel[i];
            outW[i] = seen[i] > 0 ? sum[i] / seen[i] : 0;
        }
    });
    return outIdx;
}
export async function soaSamplesToRelativeChunked(outVec3, samples, originHi, originLo, extent, cameraHi, cameraLo, count, cs, ye) {
    count = count === undefined ? samples.count : count;
    const ex = _isArr(extent) ? extent[0] : extent;
    const ey = _isArr(extent) ? extent[1] : extent;
    const ez = _isArr(extent) ? extent[2] : extent;
    const sx = samples.x, sy = samples.y, sz = samples.z;
    const ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
    const c0 = cameraHi[0], c1 = cameraHi[1], c2 = cameraHi[2];
    const l0 = cameraLo ? cameraLo[0] : 0;
    const l1 = cameraLo ? cameraLo[1] : 0;
    const l2 = cameraLo ? cameraLo[2] : 0;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            sampleToWorldDS(_ds2, sx[i], originHi[0], originLo ? originLo[0] : 0, ex);
            dsSubInto(_ds3, _ds2[0], _ds2[1], c0, l0);
            ox[i] = Math.fround(_ds3[0] + _ds3[1]);
            sampleToWorldDS(_ds2, sy[i], originHi[1], originLo ? originLo[1] : 0, ey);
            dsSubInto(_ds3, _ds2[0], _ds2[1], c1, l1);
            oy[i] = Math.fround(_ds3[0] + _ds3[1]);
            if (sz) {
                sampleToWorldDS(_ds2, sz[i], originHi[2], originLo ? originLo[2] : 0, ez);
                dsSubInto(_ds3, _ds2[0], _ds2[1], c2, l2);
                oz[i] = Math.fround(_ds3[0] + _ds3[1]);
            }
        }
    });
    return outVec3;
}
export async function sampleScatterChunked(outPositions, noiseFn, scale, rng, count, cs, ye, options) {
    const r = _rng(rng);
    options = options || {};
    count = count === undefined ? outPositions.count : count;
    const s = scale === undefined ? 1 : scale;
    const maxAttempts = options.maxAttempts || count * 100;
    const ox = outPositions.x, oy = outPositions.y, oz = outPositions.z;
    let placed = 0, tries = 0, chunks = 0;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    while (placed < count && tries < maxAttempts) {
        const target = Math.min(placed + cs, count);
        while (placed < target && tries < maxAttempts) {
            tries++;
            const x = r(), y = r(), z = r();
            const n = (noiseFn(x * s, y * s, z * s) + 1) * 0.5;
            if (r() < n) { ox[placed] = x; oy[placed] = y; oz[placed] = z; placed++; }
        }
        if (++chunks >= ye) { chunks = 0; await common.yieldToMain(); }
    }
    while (placed < count) { ox[placed] = r(); oy[placed] = r(); oz[placed] = r(); placed++; }
    await common.yieldToMain();
    return { placed: placed, tries: tries };
}

// ============================================================================
// LUT authoring (Blueprint §30)
// ============================================================================
/** Rasterize a 2D sample set into an RGBA float LUT (R = coverage). */
export function buildSampleLUT2D(out, x, y, count, size) {
    const n = size * size;
    for (let i = 0; i < n; i++) {
        const o = i * 4;
        out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 1;
    }
    for (let i = 0; i < count; i++) {
        let px = (x[i] * size) | 0;
        let py = (y[i] * size) | 0;
        if (px < 0) px = 0; else if (px >= size) px = size - 1;
        if (py < 0) py = 0; else if (py >= size) py = size - 1;
        const o = (py * size + px) * 4;
        out[o] = 1; out[o + 1] = 1; out[o + 2] = 1;
    }
    return out;
}
/** Bake a 2D kernel into an RG float LUT (offsets in [-1,1] → [0,1]). */
export function buildKernelLUT(out, kernelX, kernelY, count, size) {
    const n = size * size;
    for (let i = 0; i < n; i++) {
        const o = i * 4;
        out[o] = 0.5; out[o + 1] = 0.5; out[o + 2] = 0; out[o + 3] = 1;
    }
    for (let i = 0; i < count && i < n; i++) {
        const o = i * 4;
        out[o] = kernelX[i] * 0.5 + 0.5;
        out[o + 1] = kernelY[i] * 0.5 + 0.5;
        out[o + 2] = i / (count > 1 ? count - 1 : 1);
    }
    return out;
}
/** Void-and-cluster blue-noise threshold LUT. */
export function buildBlueNoiseLUT2D(out, size, rng, options) {
    const mask = new Int32Array(size * size);
    voidAndClusterInto(mask, size, rng, options);
    const n = size * size;
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
        const r = mask[i];
        const t = r < 0 ? 0 : (r + 0.5) * inv;
        const o = i * 4;
        out[o] = t; out[o + 1] = t; out[o + 2] = t; out[o + 3] = 1;
    }
    return out;
}
export async function buildBlueNoiseLUT2DChunked(out, size, rng, options, cs, ye) {
    const mask = new Int32Array(size * size);
    voidAndClusterInto(mask, size, rng, options);
    const n = size * size;
    const inv = 1 / n;
    await _chunked(n, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            const r = mask[i];
            const t = r < 0 ? 0 : (r + 0.5) * inv;
            const o = i * 4;
            out[o] = t; out[o + 1] = t; out[o + 2] = t; out[o + 3] = 1;
        }
    });
    return out;
}
export async function buildSampleLUT2DChunked(out, x, y, count, size, cs, ye) {
    const n = size * size;
    await _chunked(n, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            const o = i * 4;
            out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 1;
        }
    });
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            let px = (x[i] * size) | 0;
            let py = (y[i] * size) | 0;
            if (px < 0) px = 0; else if (px >= size) px = size - 1;
            if (py < 0) py = 0; else if (py >= size) py = size - 1;
            const o = (py * size + px) * 4;
            out[o] = 1; out[o + 1] = 1; out[o + 2] = 1;
        }
    });
    return out;
}

// ============================================================================
// GPU attribute bridge (Blueprint §25 / §28)
// ============================================================================
export function writeSamplesIntoFlat(flat, values, count, stride, offset, scale, bias) {
    const n = count === undefined ? values.length : count;
    const st = stride === undefined ? 1 : stride;
    const off = offset === undefined ? 0 : offset;
    const s = scale === undefined ? 1 : scale;
    const b = bias === undefined ? 0 : bias;
    for (let i = 0, o = off; i < n; i++, o += st) flat[o] = values[i] * s + b;
    return flat;
}
export function flagSampleUpload(attr, count, itemSize) {
    if (!attr) return;
    const st = itemSize || attr.itemSize || 1;
    if (attr.clearUpdateRanges) attr.clearUpdateRanges();
    if (attr.addUpdateRange) attr.addUpdateRange(0, count * st);
    attr.needsUpdate = true;
}
/** Upload a scalar channel (array or SamplingBatchState) into an attribute. */
export function syncSampleAttribute(attr, values, count, options) {
    if (!attr || !attr.array) return 0;
    options = options || {};
    const isState = !!(values && values.samples3D);
    const src = isState ? values.weights : values;
    const n = count === undefined ? (isState ? values.count : src.length) : count;
    const st = options.stride !== undefined ? options.stride : (attr.itemSize || 1);
    writeSamplesIntoFlat(attr.array, src, n, st, options.offset, options.scale, options.bias);
    flagSampleUpload(attr, n, st);
    return n;
}
/** Upload a vec2/vec3 sample SOA into an interleaved instanced attribute. */
export function syncSampleVectorAttribute(attr, positions, count, options) {
    if (!attr || !attr.array) return 0;
    options = options || {};
    const n = count === undefined ? positions.count : count;
    const st = options.stride !== undefined ? options.stride : (attr.itemSize || 3);
    const off = options.offset === undefined ? 0 : options.offset;
    const s = options.scale === undefined ? 1 : options.scale;
    const b = options.bias === undefined ? 0 : options.bias;
    const flat = attr.array;
    const x = positions.x, y = positions.y, z = positions.z;
    for (let i = 0, o = off; i < n; i++, o += st) {
        flat[o] = x[i] * s + b;
        if (st > 1) flat[o + 1] = y[i] * s + b;
        if (st > 2) flat[o + 2] = (z ? z[i] : 0) * s + b;
        if (st > 3) flat[o + 3] = 1;
    }
    flagSampleUpload(attr, n, st);
    return n;
}

// ============================================================================
// Pooled scratch — zero-GC, precision-aware, ES2017-compatible
// ============================================================================
export class SamplingScratch {
    constructor(size) {
        this.size = 0;
        this.have = 0;
        this._dtype = null;
        this.a = null; this.b = null; this.c = null;
        if (size) this.ensure(size, 3);
    }
    ensure(n, channels) {
        const need = channels === undefined ? 3 : channels;
        const T = getArrayType();
        const size = Math.max(n | 0, this.size);
        const grow = size > this.size || this._dtype !== T;
        if (!grow && this.have >= need) return this;
        if (grow || !this.a) this.a = new T(size);
        if (need >= 2 && (grow || !this.b)) this.b = new T(size);
        if (need >= 3 && (grow || !this.c)) this.c = new T(size);
        this.size = size;
        this.have = Math.max(this.have, need);
        this._dtype = T;
        return this;
    }
    reset() {
        if (this.a) this.a.fill(0);
        if (this.b) this.b.fill(0);
        if (this.c) this.c.fill(0);
        return this;
    }
    static acquire(size, channels) {
        const pool = SamplingScratch._warm;
        let best = -1;
        for (let i = 0; i < pool.length; i++) {
            if (pool[i].size >= (size || 0)) { best = i; break; }
        }
        let s;
        if (best >= 0) {
            const last = pool.length - 1;
            s = pool[best];
            pool[best] = pool[last];
            pool[last] = undefined;
            pool.length = last;
        } else {
            s = new SamplingScratch(0);
        }
        s.ensure(size || 0, channels || 3);
        return s;
    }
    static release(s) {
        if (!s) return;
        const pool = SamplingScratch._warm;
        if (pool.length < SamplingScratch.MAX_POOLED) pool.push(s);
    }
}
SamplingScratch._warm = [];
SamplingScratch.MAX_POOLED = 12;
(function _warmSamplingScratch() {
    for (let i = 0; i < 4; i++) SamplingScratch._warm.push(new SamplingScratch(256));
})();

export function createSamplingScratchPool(capacity) {
    return common.createPool(
        function () { return new SamplingScratch(0); },
        capacity || 12,
        function (s) { s.reset(); }
    );
}
const _samplingScratchPool = createSamplingScratchPool(12);
export function acquireSamplingScratch(size, channels) {
    const s = _samplingScratchPool.acquire();
    s.ensure(size || 0, channels || 3);
    return s;
}
export function releaseSamplingScratch(s) { if (s) _samplingScratchPool.release(s); }

// ============================================================================
// Batch state
// ============================================================================
export class SamplingBatchState {
    constructor(count, options) {
        options = options || {};
        this.count = count;
        this.samples3D = createVec3SOA(count);
        this.samples2D = createVec2SOA(count);
        // PDFs and weights are always Float64 — reductions must not narrow.
        this.weights = new Float64Array(count);
        this.pdfs = new Float64Array(count);
        this.indices = new Int32Array(count);
        this.rng = options.rng || common.mulberry32(options.seed === undefined ? 1 : options.seed);
        this._tracked = options.track !== false;
        if (this._tracked) trackSampling(this);
    }
    sphere(rng) { return soaUniformSphere(this.samples3D, rng || this.rng, this.count); }
    hemisphere(rng) { return soaUniformHemisphere(this.samples3D, rng || this.rng, this.count); }
    cosineHemisphere(rng) { return soaCosineHemisphere(this.samples3D, rng || this.rng, this.count); }
    cone(cosThetaMax, rng) { return soaUniformCone(this.samples3D, cosThetaMax, rng || this.rng, this.count); }
    disk(rng) { return soaUniformDisk(this.samples2D, rng || this.rng, this.count); }
    concentricDisk(rng) { return soaConcentricDisk(this.samples2D, rng || this.rng, this.count); }
    ggx(roughness, rng) { return soaSampleGGX(this.samples3D, roughness, rng || this.rng, this.count); }
    ggxVisible(vDir, roughness, rng) {
        return soaSampleGGXVisible(this.samples3D, vDir, roughness, rng || this.rng, this.count);
    }
    hammersley(n) { return hammersley2D(this.samples2D.x, this.samples2D.y, n === undefined ? this.count : n, this.count); }
    sobol(n) { return sobol2D(this.samples2D.x, this.samples2D.y, n === undefined ? this.count : n, this.count); }
    halton(start) { return halton2D(this.samples2D.x, this.samples2D.y, start || 1, this.count); }
    latin2D() { return latinHypercube2DInto(this.samples2D.x, this.samples2D.y, this.count, this.rng); }
    normal(mu, sigma, rng) { return soaNormal(this.weights, mu, sigma, rng || this.rng, this.count); }
    /** Evaluate cosine pdfs for the current 3D batch. */
    computeCosinePDF() { return soaCosinePDF(this.pdfs, this.samples3D, this.count); }
    computeGGXPDF(roughness) { return soaGGXPDF(this.pdfs, this.samples3D, roughness, this.count); }
    computeGGXVisiblePDF(vDir, roughness) {
        return soaGGXVisiblePDF(this.pdfs, vDir, this.samples3D, roughness, this.count);
    }
    /** Reservoir-resample this batch's weights (M candidates). */
    resample(weights, M, rng) {
        return soaReservoirResample(this.indices, this.weights, weights, M, this.count, rng || this.rng);
    }
    remap(bounds) { return soaRemapBounds(this.samples3D, bounds, this.count); }
    toWorldDS(world, originHi, originLo, extent, eids) {
        return soaSamplesToWorldDS(world, this.samples3D, originHi, originLo, extent, eids, this.count);
    }
    toRelative(outVec3, originHi, originLo, extent, cameraHi, cameraLo) {
        return soaSamplesToRelative(outVec3, this.samples3D, originHi, originLo, extent, cameraHi, cameraLo, this.count);
    }
    async sphereChunked(rng, cs, ye) {
        return soaUniformSphereChunked(this.samples3D, rng || this.rng, this.count, cs, ye);
    }
    async cosineHemisphereChunked(rng, cs, ye) {
        return soaCosineHemisphereChunked(this.samples3D, rng || this.rng, this.count, cs, ye);
    }
    async ggxChunked(roughness, rng, cs, ye) {
        return soaSampleGGXChunked(this.samples3D, roughness, rng || this.rng, this.count, cs, ye);
    }
    async ggxVisibleChunked(vDir, roughness, rng, cs, ye) {
        return soaSampleGGXVisibleChunked(this.samples3D, vDir, roughness, rng || this.rng, this.count, cs, ye);
    }
    /** Single-pass dirty-range upload (§25/§28). */
    uploadTo(attr, options) {
        return syncSampleVectorAttribute(attr, this.samples3D, this.count, options);
    }
    upload2DTo(attr, options) {
        return syncSampleVectorAttribute(attr, this.samples2D, this.count, options);
    }
    uploadWeightsTo(attr, options) {
        return syncSampleAttribute(attr, this.weights, this.count, options);
    }
    reset() {
        this.samples3D.x.fill(0); this.samples3D.y.fill(0); this.samples3D.z.fill(0);
        this.samples2D.x.fill(0); this.samples2D.y.fill(0);
        this.weights.fill(0); this.pdfs.fill(0); this.indices.fill(0);
        return this;
    }
    migrate(targetPrecision) {
        const T = targetPrecision ? getArrayType(targetPrecision) : getArrayType();
        const a = this.samples3D, b = this.samples2D;
        if (a.arrays[0].constructor !== T) {
            for (let i = 0; i < a.arrays.length; i++) {
                const next = new T(this.count); next.set(a.arrays[i]); a.arrays[i] = next;
            }
            a.x = a.arrays[0]; a.y = a.arrays[1]; a.z = a.arrays[2];
        }
        if (b.arrays[0].constructor !== T) {
            for (let i = 0; i < b.arrays.length; i++) {
                const next = new T(this.count); next.set(b.arrays[i]); b.arrays[i] = next;
            }
            b.x = b.arrays[0]; b.y = b.arrays[1];
        }
        return this;
    }
    toTransferable() { return samplingBatchToTransferable(this); }
    dispose() { if (this._tracked) untrackSampling(this); return this; }
}
export function createSamplingBatch(count, options) { return new SamplingBatchState(count, options); }

// ============================================================================
// Precision tracking / migration (dense arrays — no Map/Set, §10/§16)
// ============================================================================
const _trackedBatches = [];
export function trackSampling(state) {
    if (!state) return state;
    if (_trackedBatches.indexOf(state) === -1) _trackedBatches.push(state);
    return state;
}
export function untrackSampling(state) {
    const i = _trackedBatches.indexOf(state);
    if (i !== -1) _trackedBatches.splice(i, 1);
}
export function clearTrackedSampling() { _trackedBatches.length = 0; }
export function getTrackedSampling() { return _trackedBatches; }
export function migrateSampling(state, targetPrecision) {
    if (state && state.migrate) state.migrate(targetPrecision);
    return state;
}
export function migrateAllSampling(targetPrecision) {
    for (let i = 0; i < _trackedBatches.length; i++) {
        try { _trackedBatches[i].migrate(targetPrecision); }
        catch (e) { console.error("[053_sampling] migration failed for one batch", e); }
    }
}

onPrecisionChange(function () {
    migrateAllSampling();
    SamplingScratch._warm.length = 0;
    for (let i = 0; i < 4; i++) SamplingScratch._warm.push(new SamplingScratch(256));
});

// ============================================================================
// Deterministic temporal sampling (Blueprint §45 / §