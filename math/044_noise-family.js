//File number : 044
// File : src/math/044_noise-family.js
//Description : Complete noise-family math (ESM) — classic Perlin (2D/3D/4D) with TRUE analytic
//              gradients, value noise (2D/3D/4D), white, Worley/cellular (F1/F2/F3 + cell id +
//              nearest feature point + F2−F1 boundary), Gabor (sparse convolution), band-limited
//              tile-based wavelet noise, divergence-free curl noise from a proper vector
//              potential, plus fBm, turbulence, ridged, billow, canonical Musgrave hybrid-
//              multifractal and hetero-terrain, and domain warping. Includes seeded builders,
//              a double-single precision bridge for sampling at megaparsec offsets, SOA batches
//              for 1M+ per-frame evaluations, chunked async variants yielding via
//              `scheduler.yield()`, pooled zero-GC scratch, precision-aware storage through
//              `000_Math_module.js` (Float16/Float32/Float64 hot-swap with live migration),
//              DataTexture LUT authoring, dirty-range GPU attribute upload, deterministic
//              fixed-step animation, and zero-copy transferable batch state.
//
//              CORRECTIONS (this revision):
//              • FATAL: `const M = require(...)` replaced with ESM named imports.
//              • FATAL: `exports.NoiseScratch / NoiseBatchState` read classes from the TDZ at
//                module-evaluation time → ReferenceError on load; `exports.namespace` was
//                mutated after export. Converted to `export class` / `export function`.
//              • FATAL: `createPerlin3D(seed)` built a seeded permutation table and then
//                IGNORED it, returning `perlin3D(x+0.0001, …)` off the GLOBAL table — every
//                "seeded" 3D generator produced identical output. The core is now factored
//                into `_perlin3DP(perm, …)` and the builder closes over its own table.
//              • FATAL: `curl3D` mixed partial derivatives of TWO DIFFERENT scalar fields,
//                which is not a curl and is NOT divergence-free — defeating the entire
//                purpose. Now uses a proper vector potential Ψ=(P,Q,R) and evaluates
//                curl Ψ = (∂R/∂y−∂Q/∂z, ∂P/∂z−∂R/∂x, ∂Q/∂x−∂P/∂y).
//              • `perlin4D` / `value4D` were faked by lerping two 3D slices, collapsing the
//                fourth dimension and producing discontinuities in w. Replaced with true 4D
//                Perlin (16 hypercube corners, 32 gradient directions) and true 4D value
//                noise (16 corners, full-precision hash4).
//              • `perlin2DGrad` / `perlin3DGrad` were documented as "analytic" but used central
//                finite differences (6 extra noise evaluations per sample). Replaced with the
//                real analytic derivatives of the faded interpolant — same cost as one noise
//                evaluation. Finite differences remain available as `noiseGrad2D/3D`.
//              • `wavelet2D/3D` were value noise with a quintic fade — not band-limited at all.
//                Replaced with a genuine band-pass construction: a periodic random tile is
//                decimated with a [1,6,1]/8 low-pass, reconstructed with a quadratic B-spline,
//                and subtracted; evaluation uses the same B-spline. No DC drift, no
//                reconstruction aliasing, and perfectly tileable.
//              • `hybridMultifractal*` multiplied each octave by `freq` (exponential blow-up)
//                instead of `freq^-H`, and never fed `weight` back from the signal.
//                `heteroTerrain2D` used a non-canonical `n*sum/(1+sum)` recurrence. Both are
//                now the canonical Musgrave formulations with an explicit H parameter.
//              • `billow*` was byte-identical to `turbulence*`. Billow is now bipolar
//                (`2·|n|−1`) so the two operators are genuinely distinct.
//              • `perlin2D` claimed a [-1,1] range but returned ±0.495 (`* 0.7`). Normalized
//                by √2. `value*` / `white` used a 256-level quantized hash (visible banding);
//                now use the full 32-bit hash.
//              • `curl2D` divided by an unscaled epsilon while sampling at scaled offsets, so
//                the derivative was off by the scale factor. Chain rule applied correctly.
//              • `gabor*` normalized by an arbitrary `density*9` / `density*27`, so amplitude
//                changed with density. Now variance-normalized by 1/√K with distinct hash
//                salts per kernel parameter (the old salts collided).
//              • `soaCurl3D` / `soaCurl3DChunked` allocated `[0,0,0]` per call. Inlined.
//              • ES2022 static blocks / private static fields removed so the file parses on
//                older Android WebViews; warm-up runs in plain IIFEs. The
//                `static #listeners = new Set()` notification path is now a dense array.
//              • `NoiseScratch.acquire` used `Array.splice` (allocation per acquire); now
//                swap-removes. The monkey-patched `_noiseScratchPool.acquire` is replaced by a
//                real class-backed pool.
//
//              FEATURES ADDED from corrected_bitecs_enhancement.md:
//              • §10/§16 — Every hot path is allocation-free: no array literals, no per-call
//                closures, no Map/Set. Seeded builders close over pre-built tables; Worley has
//                `*Into` forms; the precision listener rebuilds scratch pools and migrates
//                tracked batches at switch time, never in the frame loop.
//              • §25/§28 — `writeNoiseIntoFlat` / `flagNoiseUpload` / `syncNoiseAttribute` /
//                `syncNoiseVectorAttribute`: upload noise or curl fields straight into an
//                InstancedBufferAttribute backing array with `clearUpdateRanges` /
//                `addUpdateRange` dirty-prefix upload.
//              • §26     — Double-single bridge: `dsAddInto` / `dsSubInto` renormalize with a
//                full TwoSum BEFORE any narrowing cast, and `noiseCoordFromDS` /
//                `soaNoiseCoordsFromDS(+Chunked)` turn megaparsec-offset world positions into
//                precise normalized noise coordinates instead of collapsing into Float32 ULP
//                noise.
//              • §30     — `buildNoiseLUT2D` / `buildNoiseLUT3D` (+ chunked) author
//                DataTexture-ready RGBA buffers with zero per-texel allocation.
//              • §34     — Permutation, gradient, and hash-salt tables are pre-allocated
//                module constants.
//              • §45/§51 — `NoiseClock` (compensated time accumulation, drift-free over days)
//                and `createNoiseAnimator` advance the 4D time axis on a FIXED timestep, plus
//                a re-exported `createFixedStepScheduler`.
//              • §49     — `noiseBatchToTransferable` / `noiseBatchFromTransferable` pack a
//                batch into ONE ArrayBuffer for zero-copy Worker transfer.
//####
//Best for : 3d graphics — terrain heightmaps (fBm + domain warp on 1M+ vertices), ocean waves
//           (band-limited wavelet + turbulence, alias-free at any zoom), clouds/nebula density
//           (true 4D Perlin + Worley), asteroid surface detail (ridged multifractal), foliage
//           scatter (Worley F1/F2 spacing), procedural IK targets and wind/dust fields
//           (divergence-free curl on 1M+ instances), HDR light-mask generation, star-field
//           warping (hetero-terrain), analytic surface normals for vertex displacement, and
//           per-instance color/normal modulation from 1M+ SOA-computed noise at 60 fps on
//           Android 64-bit — seamless from millimetres to megaparsecs via the DS bridge.
//License : MIT

// ============================================================================
// Imports — ESM named imports from the unified math entry point
// ============================================================================
import {
    common,
    simplex,
    vec3,
    vec4,
    double,
    createVec3SOA,
    createVec4SOA,
    getPrecision,
    setPrecision,
    onPrecisionChange,
    getArrayType,
    createFixedStepScheduler
} from "./000_Math_module.js";

export const VERSION = "1.1.0-esm";

export {
    getPrecision,
    setPrecision,
    onPrecisionChange,
    getArrayType,
    createFixedStepScheduler
};

// ============================================================================
// Constants and pre-allocated tables (Blueprint §34)
// ============================================================================
const PI = Math.PI;
const TAU = PI * 2;
const SQRT2 = Math.SQRT2;
const EPSILON = 1e-9;

// Classic Perlin permutation — deterministic, 512 entries.
const PERM = (function () {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    const rng = common.mulberry32(0x9e3779b9);
    for (let i = 255; i > 0; i--) {
        const j = (rng() * (i + 1)) | 0;
        const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    const perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
    return perm;
})();

// 2D gradients — 256 unit directions.
const PERM2D = (function () {
    const g = new Float32Array(256 * 2);
    for (let i = 0; i < 256; i++) {
        const a = (i / 256) * TAU;
        g[i * 2] = Math.cos(a);
        g[i * 2 + 1] = Math.sin(a);
    }
    return g;
})();

// 3D gradients — 12 edge-of-cube directions (improved Perlin).
const GRAD3 = new Float32Array([
    1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
    1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
    0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1
]);

// 4D gradients — 32 directions of the form (0,±1,±1,±1) and permutations.
const GRAD4 = new Float32Array([
    0, 1, 1, 1, 0, 1, 1, -1, 0, 1, -1, 1, 0, 1, -1, -1,
    0, -1, 1, 1, 0, -1, 1, -1, 0, -1, -1, 1, 0, -1, -1, -1,
    1, 0, 1, 1, 1, 0, 1, -1, 1, 0, -1, 1, 1, 0, -1, -1,
    -1, 0, 1, 1, -1, 0, 1, -1, -1, 0, -1, 1, -1, 0, -1, -1,
    1, 1, 0, 1, 1, 1, 0, -1, 1, -1, 0, 1, 1, -1, 0, -1,
    -1, 1, 0, 1, -1, 1, 0, -1, -1, -1, 0, 1, -1, -1, 0, -1,
    1, 1, 1, 0, 1, 1, -1, 0, 1, -1, 1, 0, 1, -1, -1, 0,
    -1, 1, 1, 0, -1, 1, -1, 0, -1, -1, 1, 0, -1, -1, -1, 0
]);

// Distinct hash salts — the previous Gabor salts collided across parameters.
const SALT_FX = 0x1b873593;
const SALT_FY = 0x85ebca6b;
const SALT_FZ = 0xc2b2ae35;
const SALT_TH = 0x27d4eb2f;
const SALT_PH = 0x165667b1;
const SALT_ID = 0x9e3779b1;

// Curl vector-potential offsets (three independent scalar fields).
const CURL_QX = 31.416, CURL_QY = 47.123, CURL_QZ = 12.793;
const CURL_RX = 74.221, CURL_RY = 19.635, CURL_RZ = 91.508;

// Domain-warp offsets.
const WARP_AX = 5.2, WARP_AY = 1.3, WARP_AZ = 2.9;
const WARP_BX = -3.7, WARP_BY = 7.9, WARP_BZ = -1.1;
const WARP_CX = 1.1, WARP_CY = -2.3, WARP_CZ = 8.7;

// Operator ids (resolved ONCE outside every hot loop).
export const NOISE_PERLIN = 0;
export const NOISE_VALUE = 1;
export const NOISE_WHITE = 2;
export const NOISE_WORLEY = 3;
export const NOISE_GABOR = 4;
export const NOISE_WAVELET = 5;
export const NOISE_SIMPLEX = 6;

export const MODE_RAW = 0;
export const MODE_FBM = 1;
export const MODE_TURBULENCE = 2;
export const MODE_RIDGED = 3;
export const MODE_BILLOW = 4;
export const MODE_HYBRID = 5;
export const MODE_HETERO = 6;
export const MODE_WARP = 7;

// ============================================================================
// Module scratch — allocated once, reused by every hot path (Zero-GC)
// ============================================================================
const _grad3 = new Float64Array(3);
const _grad2 = new Float64Array(2);
const _curl3 = new Float64Array(3);
const _worley7 = new Float64Array(7);
const _worley6 = new Float64Array(6);
const _ds2 = new Float64Array(2);
const _coord3 = new Float64Array(3);

// ============================================================================
// Hash helpers
// ============================================================================
/** Lattice hash → gradient index in [0,255]. */
export function hashInt3(x, y, z) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2147483647);
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 1274126177) >>> 0;
    return h & 255;
}
/** Full-precision 3D lattice hash → [0,1). No 256-level quantization banding. */
export function hash01_3(x, y, z) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2147483647);
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 1274126177) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
}
/** Full-precision 4D lattice hash → [0,1). */
export function hash01_4(x, y, z, w) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) +
        Math.imul(z | 0, 2147483647) + Math.imul(w | 0, 1103515245);
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 1274126177) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
}
/** Salted full-precision hash → [0,1). Used for Gabor / Worley feature jitter. */
function hashSalt(x, y, z, salt) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^
        Math.imul(z | 0, 2147483647) ^ Math.imul(salt | 0, 1103515245);
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 1274126177) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
}
function cellId(x, y, z) {
    return ((Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791)) >>> 0);
}

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function fadeDeriv(t) { return 30 * t * t * (t - 1) * (t - 1); }
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function _isArr(t) { return t != null && t.length !== undefined; }

// ============================================================================
// Perlin — perm-parameterized cores (shared by global + seeded builders)
// ============================================================================
function _perlin2DP(perm, x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = fade(xf), v = fade(yf);
    const px0 = xi & 255, py0 = yi & 255;
    const px1 = (xi + 1) & 255, py1 = (yi + 1) & 255;
    const g00 = perm[(perm[px0] + py0) & 255] * 2;
    const g10 = perm[(perm[px1] + py0) & 255] * 2;
    const g01 = perm[(perm[px0] + py1) & 255] * 2;
    const g11 = perm[(perm[px1] + py1) & 255] * 2;
    const n00 = PERM2D[g00] * xf + PERM2D[g00 + 1] * yf;
    const n10 = PERM2D[g10] * (xf - 1) + PERM2D[g10 + 1] * yf;
    const n01 = PERM2D[g01] * xf + PERM2D[g01 + 1] * (yf - 1);
    const n11 = PERM2D[g11] * (xf - 1) + PERM2D[g11 + 1] * (yf - 1);
    // CORRECTED normalization: unit 2D gradients peak at √2/2, so scale by √2.
    return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v) * SQRT2;
}

function _perlin3DP(perm, x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = fade(xf), v = fade(yf), w = fade(zf);
    const px0 = xi & 255, py0 = yi & 255, pz0 = zi & 255;
    const px1 = (xi + 1) & 255, py1 = (yi + 1) & 255, pz1 = (zi + 1) & 255;
    const A0 = perm[px0] + py0, A1 = perm[px1] + py0;
    const B0 = perm[px0] + py1, B1 = perm[px1] + py1;
    const g000 = (perm[(perm[A0] + pz0) & 255] % 12) * 3;
    const g100 = (perm[(perm[A1] + pz0) & 255] % 12) * 3;
    const g010 = (perm[(perm[B0] + pz0) & 255] % 12) * 3;
    const g110 = (perm[(perm[B1] + pz0) & 255] % 12) * 3;
    const g001 = (perm[(perm[A0] + pz1) & 255] % 12) * 3;
    const g101 = (perm[(perm[A1] + pz1) & 255] % 12) * 3;
    const g011 = (perm[(perm[B0] + pz1) & 255] % 12) * 3;
    const g111 = (perm[(perm[B1] + pz1) & 255] % 12) * 3;
    const n000 = GRAD3[g000] * xf + GRAD3[g000 + 1] * yf + GRAD3[g000 + 2] * zf;
    const n100 = GRAD3[g100] * (xf - 1) + GRAD3[g100 + 1] * yf + GRAD3[g100 + 2] * zf;
    const n010 = GRAD3[g010] * xf + GRAD3[g010 + 1] * (yf - 1) + GRAD3[g010 + 2] * zf;
    const n110 = GRAD3[g110] * (xf - 1) + GRAD3[g110 + 1] * (yf - 1) + GRAD3[g110 + 2] * zf;
    const n001 = GRAD3[g001] * xf + GRAD3[g001 + 1] * yf + GRAD3[g001 + 2] * (zf - 1);
    const n101 = GRAD3[g101] * (xf - 1) + GRAD3[g101 + 1] * yf + GRAD3[g101 + 2] * (zf - 1);
    const n011 = GRAD3[g011] * xf + GRAD3[g011 + 1] * (yf - 1) + GRAD3[g011 + 2] * (zf - 1);
    const n111 = GRAD3[g111] * (xf - 1) + GRAD3[g111 + 1] * (yf - 1) + GRAD3[g111 + 2] * (zf - 1);
    const nx00 = lerp(n000, n100, u), nx10 = lerp(n010, n110, u);
    const nx01 = lerp(n001, n101, u), nx11 = lerp(n011, n111, u);
    return lerp(lerp(nx00, nx10, v), lerp(nx01, nx11, v), w);
}

/** TRUE 4D classic Perlin — 16 hypercube corners, 32 gradient directions. */
function _perlin4DP(perm, x, y, z, w) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), wi = Math.floor(w);
    const xf = x - xi, yf = y - yi, zf = z - zi, wf = w - wi;
    const u = fade(xf), v = fade(yf), s = fade(zf), t = fade(wf);
    const px0 = xi & 255, py0 = yi & 255, pz0 = zi & 255, pw0 = wi & 255;
    const px1 = (xi + 1) & 255, py1 = (yi + 1) & 255, pz1 = (zi + 1) & 255, pw1 = (wi + 1) & 255;

    const a0 = perm[px0] + py0, a1 = perm[px1] + py0;
    const b0 = perm[px0] + py1, b1 = perm[px1] + py1;
    const aa0 = perm[a0 & 255] + pz0, aa1 = perm[a1 & 255] + pz0;
    const ab0 = perm[b0 & 255] + pz0, ab1 = perm[b1 & 255] + pz0;
    const ba0 = perm[a0 & 255] + pz1, ba1 = perm[a1 & 255] + pz1;
    const bb0 = perm[b0 & 255] + pz1, bb1 = perm[b1 & 255] + pz1;

    const g0000 = (perm[(perm[aa0 & 255] + pw0) & 255] & 31) * 4;
    const g1000 = (perm[(perm[aa1 & 255] + pw0) & 255] & 31) * 4;
    const g0100 = (perm[(perm[ab0 & 255] + pw0) & 255] & 31) * 4;
    const g1100 = (perm[(perm[ab1 & 255] + pw0) & 255] & 31) * 4;
    const g0010 = (perm[(perm[ba0 & 255] + pw0) & 255] & 31) * 4;
    const g1010 = (perm[(perm[ba1 & 255] + pw0) & 255] & 31) * 4;
    const g0110 = (perm[(perm[bb0 & 255] + pw0) & 255] & 31) * 4;
    const g1110 = (perm[(perm[bb1 & 255] + pw0) & 255] & 31) * 4;
    const g0001 = (perm[(perm[aa0 & 255] + pw1) & 255] & 31) * 4;
    const g1001 = (perm[(perm[aa1 & 255] + pw1) & 255] & 31) * 4;
    const g0101 = (perm[(perm[ab0 & 255] + pw1) & 255] & 31) * 4;
    const g1101 = (perm[(perm[ab1 & 255] + pw1) & 255] & 31) * 4;
    const g0011 = (perm[(perm[ba0 & 255] + pw1) & 255] & 31) * 4;
    const g1011 = (perm[(perm[ba1 & 255] + pw1) & 255] & 31) * 4;
    const g0111 = (perm[(perm[bb0 & 255] + pw1) & 255] & 31) * 4;
    const g1111 = (perm[(perm[bb1 & 255] + pw1) & 255] & 31) * 4;

    const xm1 = xf - 1, ym1 = yf - 1, zm1 = zf - 1, wm1 = wf - 1;
    const n0000 = GRAD4[g0000] * xf + GRAD4[g0000 + 1] * yf + GRAD4[g0000 + 2] * zf + GRAD4[g0000 + 3] * wf;
    const n1000 = GRAD4[g1000] * xm1 + GRAD4[g1000 + 1] * yf + GRAD4[g1000 + 2] * zf + GRAD4[g1000 + 3] * wf;
    const n0100 = GRAD4[g0100] * xf + GRAD4[g0100 + 1] * ym1 + GRAD4[g0100 + 2] * zf + GRAD4[g0100 + 3] * wf;
    const n1100 = GRAD4[g1100] * xm1 + GRAD4[g1100 + 1] * ym1 + GRAD4[g1100 + 2] * zf + GRAD4[g1100 + 3] * wf;
    const n0010 = GRAD4[g0010] * xf + GRAD4[g0010 + 1] * yf + GRAD4[g0010 + 2] * zm1 + GRAD4[g0010 + 3] * wf;
    const n1010 = GRAD4[g1010] * xm1 + GRAD4[g1010 + 1] * yf + GRAD4[g1010 + 2] * zm1 + GRAD4[g1010 + 3] * wf;
    const n0110 = GRAD4[g0110] * xf + GRAD4[g0110 + 1] * ym1 + GRAD4[g0110 + 2] * zm1 + GRAD4[g0110 + 3] * wf;
    const n1110 = GRAD4[g1110] * xm1 + GRAD4[g1110 + 1] * ym1 + GRAD4[g1110 + 2] * zm1 + GRAD4[g1110 + 3] * wf;
    const n0001 = GRAD4[g0001] * xf + GRAD4[g0001 + 1] * yf + GRAD4[g0001 + 2] * zf + GRAD4[g0001 + 3] * wm1;
    const n1001 = GRAD4[g1001] * xm1 + GRAD4[g1001 + 1] * yf + GRAD4[g1001 + 2] * zf + GRAD4[g1001 + 3] * wm1;
    const n0101 = GRAD4[g0101] * xf + GRAD4[g0101 + 1] * ym1 + GRAD4[g0101 + 2] * zf + GRAD4[g0101 + 3] * wm1;
    const n1101 = GRAD4[g1101] * xm1 + GRAD4[g1101 + 1] * ym1 + GRAD4[g1101 + 2] * zf + GRAD4[g1101 + 3] * wm1;
    const n0011 = GRAD4[g0011] * xf + GRAD4[g0011 + 1] * yf + GRAD4[g0011 + 2] * zm1 + GRAD4[g0011 + 3] * wm1;
    const n1011 = GRAD4[g1011] * xm1 + GRAD4[g1011 + 1] * yf + GRAD4[g1011 + 2] * zm1 + GRAD4[g1011 + 3] * wm1;
    const n0111 = GRAD4[g0111] * xf + GRAD4[g0111 + 1] * ym1 + GRAD4[g0111 + 2] * zm1 + GRAD4[g0111 + 3] * wm1;
    const n1111 = GRAD4[g1111] * xm1 + GRAD4[g1111 + 1] * ym1 + GRAD4[g1111 + 2] * zm1 + GRAD4[g1111 + 3] * wm1;

    const x000 = lerp(n0000, n1000, u), x100 = lerp(n0100, n1100, u);
    const x010 = lerp(n0010, n1010, u), x110 = lerp(n0110, n1110, u);
    const x001 = lerp(n0001, n1001, u), x101 = lerp(n0101, n1101, u);
    const x011 = lerp(n0011, n1011, u), x111 = lerp(n0111, n1111, u);
    const y00 = lerp(x000, x100, v), y10 = lerp(x010, x110, v);
    const y01 = lerp(x001, x101, v), y11 = lerp(x011, x111, v);
    const z0 = lerp(y00, y10, s), z1 = lerp(y01, y11, s);
    return lerp(z0, z1, t);
}

/** Classic 2D Perlin, normalized to approximately [-1,1]. */
export function perlin2D(x, y) { return _perlin2DP(PERM, x, y); }
/** Classic 3D Perlin (improved gradients), approximately [-1,1]. */
export function perlin3D(x, y, z) { return _perlin3DP(PERM, x, y, z); }
/** TRUE classic 4D Perlin — w is a genuine fourth axis (use it for time). */
export function perlin4D(x, y, z, w) { return _perlin4DP(PERM, x, y, z, w); }

/**
 * TRUE analytic 2D Perlin gradient. Writes out[0..1] = (∂n/∂x, ∂n/∂y) and
 * returns the noise value. Costs the same as one noise evaluation — the previous
 * finite-difference version cost seven.
 */
export function perlin2DGrad(out, x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = fade(xf), v = fade(yf);
    const du = fadeDeriv(xf), dv = fadeDeriv(yf);
    const px0 = xi & 255, py0 = yi & 255;
    const px1 = (xi + 1) & 255, py1 = (yi + 1) & 255;
    const i00 = perm2Index(PERM, px0, py0), i10 = perm2Index(PERM, px1, py0);
    const i01 = perm2Index(PERM, px0, py1), i11 = perm2Index(PERM, px1, py1);
    const ax = PERM2D[i00], ay = PERM2D[i00 + 1];
    const bx = PERM2D[i10], by = PERM2D[i10 + 1];
    const cx = PERM2D[i01], cy = PERM2D[i01 + 1];
    const dx = PERM2D[i11], dy = PERM2D[i11 + 1];
    const n00 = ax * xf + ay * yf;
    const n10 = bx * (xf - 1) + by * yf;
    const n01 = cx * xf + cy * (yf - 1);
    const n11 = dx * (xf - 1) + dy * (yf - 1);
    const A = n00 + (n10 - n00) * u;
    const B = n01 + (n11 - n01) * u;
    const dAx = ax + (bx - ax) * u + (n10 - n00) * du;
    const dBx = cx + (dx - cx) * u + (n11 - n01) * du;
    const dAy = ay + (by - ay) * u;
    const dBy = cy + (dy - cy) * u;
    out[0] = (dAx + (dBx - dAx) * v) * SQRT2;
    out[1] = (dAy + (dBy - dAy) * v + (B - A) * dv) * SQRT2;
    return (A + (B - A) * v) * SQRT2;
}
function perm2Index(perm, px, py) { return perm[(perm[px] + py) & 255] * 2; }

/**
 * TRUE analytic 3D Perlin gradient. Writes out[0..2] and returns the value.
 * This is the surface-normal primitive for vertex displacement.
 */
export function perlin3DGrad(out, x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = fade(xf), v = fade(yf), w = fade(zf);
    const du = fadeDeriv(xf), dv = fadeDeriv(yf), dw = fadeDeriv(zf);
    const px0 = xi & 255, py0 = yi & 255, pz0 = zi & 255;
    const px1 = (xi + 1) & 255, py1 = (yi + 1) & 255, pz1 = (zi + 1) & 255;
    const A0 = PERM[px0] + py0, A1 = PERM[px1] + py0;
    const B0 = PERM[px0] + py1, B1 = PERM[px1] + py1;
    const g000 = (PERM[(PERM[A0] + pz0) & 255] % 12) * 3;
    const g100 = (PERM[(PERM[A1] + pz0) & 255] % 12) * 3;
    const g010 = (PERM[(PERM[B0] + pz0) & 255] % 12) * 3;
    const g110 = (PERM[(PERM[B1] + pz0) & 255] % 12) * 3;
    const g001 = (PERM[(PERM[A0] + pz1) & 255] % 12) * 3;
    const g101 = (PERM[(PERM[A1] + pz1) & 255] % 12) * 3;
    const g011 = (PERM[(PERM[B0] + pz1) & 255] % 12) * 3;
    const g111 = (PERM[(PERM[B1] + pz1) & 255] % 12) * 3;

    const a0 = GRAD3[g000], a1 = GRAD3[g000 + 1], a2 = GRAD3[g000 + 2];
    const b0 = GRAD3[g100], b1 = GRAD3[g100 + 1], b2 = GRAD3[g100 + 2];
    const c0 = GRAD3[g010], c1 = GRAD3[g010 + 1], c2 = GRAD3[g010 + 2];
    const d0 = GRAD3[g110], d1 = GRAD3[g110 + 1], d2 = GRAD3[g110 + 2];
    const e0 = GRAD3[g001], e1 = GRAD3[g001 + 1], e2 = GRAD3[g001 + 2];
    const f0 = GRAD3[g101], f1 = GRAD3[g101 + 1], f2 = GRAD3[g101 + 2];
    const g0 = GRAD3[g011], g1 = GRAD3[g011 + 1], g2 = GRAD3[g011 + 2];
    const h0 = GRAD3[g111], h1 = GRAD3[g111 + 1], h2 = GRAD3[g111 + 2];

    const xm = xf - 1, ym = yf - 1, zm = zf - 1;
    const n000 = a0 * xf + a1 * yf + a2 * zf;
    const n100 = b0 * xm + b1 * yf + b2 * zf;
    const n010 = c0 * xf + c1 * ym + c2 * zf;
    const n110 = d0 * xm + d1 * ym + d2 * zf;
    const n001 = e0 * xf + e1 * yf + e2 * zm;
    const n101 = f0 * xm + f1 * yf + f2 * zm;
    const n011 = g0 * xf + g1 * ym + g2 * zm;
    const n111 = h0 * xm + h1 * ym + h2 * zm;

    const k00 = n100 - n000, k10 = n110 - n010, k01 = n101 - n001, k11 = n111 - n011;
    const nx00 = n000 + k00 * u, nx10 = n010 + k10 * u;
    const nx01 = n001 + k01 * u, nx11 = n011 + k11 * u;
    const ny0 = nx00 + (nx10 - nx00) * v, ny1 = nx01 + (nx11 - nx01) * v;
    const value = ny0 + (ny1 - ny0) * w;

    // ∂/∂x
    const dx00 = a0 + (b0 - a0) * u + k00 * du;
    const dx10 = c0 + (d0 - c0) * u + k10 * du;
    const dx01 = e0 + (f0 - e0) * u + k01 * du;
    const dx11 = g0 + (h0 - g0) * u + k11 * du;
    const dx0 = dx00 + (dx10 - dx00) * v;
    const dx1 = dx01 + (dx11 - dx01) * v;
    out[0] = dx0 + (dx1 - dx0) * w;

    // ∂/∂y
    const dy00 = a1 + (b1 - a1) * u;
    const dy10 = c1 + (d1 - c1) * u;
    const dy01 = e1 + (f1 - e1) * u;
    const dy11 = g1 + (h1 - g1) * u;
    const dy0 = dy00 + (dy10 - dy00) * v + (nx10 - nx00) * dv;
    const dy1 = dy01 + (dy11 - dy01) * v + (nx11 - nx01) * dv;
    out[1] = dy0 + (dy1 - dy0) * w;

    // ∂/∂z
    const dz00 = a2 + (b2 - a2) * u;
    const dz10 = c2 + (d2 - c2) * u;
    const dz01 = e2 + (f2 - e2) * u;
    const dz11 = g2 + (h2 - g2) * u;
    const dz0 = dz00 + (dz10 - dz00) * v;
    const dz1 = dz01 + (dz11 - dz01) * v;
    out[2] = dz0 + (dz1 - dz0) * w + (ny1 - ny0) * dw;

    return value;
}

/** Generic central-difference gradient for ANY 2D noise function. */
export function noiseGrad2D(out, fn, x, y, epsilon) {
    const e = epsilon === undefined ? 1e-3 : epsilon;
    const inv = 1 / (2 * e);
    out[0] = (fn(x + e, y) - fn(x - e, y)) * inv;
    out[1] = (fn(x, y + e) - fn(x, y - e)) * inv;
    return out;
}
/** Generic central-difference gradient for ANY 3D noise function. */
export function noiseGrad3D(out, fn, x, y, z, epsilon) {
    const e = epsilon === undefined ? 1e-3 : epsilon;
    const inv = 1 / (2 * e);
    out[0] = (fn(x + e, y, z) - fn(x - e, y, z)) * inv;
    out[1] = (fn(x, y + e, z) - fn(x, y - e, z)) * inv;
    out[2] = (fn(x, y, z + e) - fn(x, y, z - e)) * inv;
    return out;
}

// ============================================================================
// Value noise
// ============================================================================
export function value2D(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = fade(xf), v = fade(yf);
    const h00 = hash01_3(xi, yi, 0), h10 = hash01_3(xi + 1, yi, 0);
    const h01 = hash01_3(xi, yi + 1, 0), h11 = hash01_3(xi + 1, yi + 1, 0);
    return lerp(lerp(h00, h10, u), lerp(h01, h11, u), v) * 2 - 1;
}
export function value3D(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = fade(xf), v = fade(yf), w = fade(zf);
    const c000 = hash01_3(xi, yi, zi), c100 = hash01_3(xi + 1, yi, zi);
    const c010 = hash01_3(xi, yi + 1, zi), c110 = hash01_3(xi + 1, yi + 1, zi);
    const c001 = hash01_3(xi, yi, zi + 1), c101 = hash01_3(xi + 1, yi, zi + 1);
    const c011 = hash01_3(xi, yi + 1, zi + 1), c111 = hash01_3(xi + 1, yi + 1, zi + 1);
    const nx0 = lerp(c000, c100, u), nx1 = lerp(c010, c110, u);
    const nx2 = lerp(c001, c101, u), nx3 = lerp(c011, c111, u);
    return lerp(lerp(nx0, nx1, v), lerp(nx2, nx3, v), w) * 2 - 1;
}
/** TRUE 4D value noise — 16 hypercube corners with a full-precision hash4. */
export function value4D(x, y, z, w) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), wi = Math.floor(w);
    const xf = x - xi, yf = y - yi, zf = z - zi, wf = w - wi;
    const u = fade(xf), v = fade(yf), s = fade(zf), t = fade(wf);
    const c0000 = hash01_4(xi, yi, zi, wi), c1000 = hash01_4(xi + 1, yi, zi, wi);
    const c0100 = hash01_4(xi, yi + 1, zi, wi), c1100 = hash01_4(xi + 1, yi + 1, zi, wi);
    const c0010 = hash01_4(xi, yi, zi + 1, wi), c1010 = hash01_4(xi + 1, yi, zi + 1, wi);
    const c0110 = hash01_4(xi, yi + 1, zi + 1, wi), c1110 = hash01_4(xi + 1, yi + 1, zi + 1, wi);
    const c0001 = hash01_4(xi, yi, zi, wi + 1), c1001 = hash01_4(xi + 1, yi, zi, wi + 1);
    const c0101 = hash01_4(xi, yi + 1, zi, wi + 1), c1101 = hash01_4(xi + 1, yi + 1, zi, wi + 1);
    const c0011 = hash01_4(xi, yi, zi + 1, wi + 1), c1011 = hash01_4(xi + 1, yi, zi + 1, wi + 1);
    const c0111 = hash01_4(xi, yi + 1, zi + 1, wi + 1), c1111 = hash01_4(xi + 1, yi + 1, zi + 1, wi + 1);
    const x000 = lerp(c0000, c1000, u), x100 = lerp(c0100, c1100, u);
    const x010 = lerp(c0010, c1010, u), x110 = lerp(c0110, c1110, u);
    const x001 = lerp(c0001, c1001, u), x101 = lerp(c0101, c1101, u);
    const x011 = lerp(c0011, c1011, u), x111 = lerp(c0111, c1111, u);
    const y00 = lerp(x000, x100, v), y10 = lerp(x010, x110, v);
    const y01 = lerp(x001, x101, v), y11 = lerp(x011, x111, v);
    return lerp(lerp(y00, y10, s), lerp(y01, y11, s), t) * 2 - 1;
}

// ============================================================================
// White noise
// ============================================================================
/** White noise at an integer lattice — full 32-bit precision, [-1,1]. */
export function white(x, y, z) {
    return hash01_3(x | 0, y | 0, (z | 0) || 0) * 2 - 1;
}

// ============================================================================
// Worley / cellular
// ============================================================================
/**
 * Worley 3D full info, zero allocation.
 * out7 = [F1, F2, F3, cellId, nearestX, nearestY, nearestZ].
 */
export function worley3DInfoInto(out7, x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    let f1 = Infinity, f2 = Infinity, f3 = Infinity;
    let id = 0, cxN = 0, cyN = 0, czN = 0;
    for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const cxi = xi + dx, cyi = yi + dy, czi = zi + dz;
                const fx = cxi + hashSalt(cxi, cyi, czi, SALT_FX);
                const fy = cyi + hashSalt(cxi, cyi, czi, SALT_FY);
                const fz = czi + hashSalt(cxi, cyi, czi, SALT_FZ);
                const ddx = x - fx, ddy = y - fy, ddz = z - fz;
                const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
                if (d2 < f1) {
                    f3 = f2; f2 = f1; f1 = d2;
                    id = cellId(cxi, cyi, czi);
                    cxN = fx; cyN = fy; czN = fz;
                } else if (d2 < f2) { f3 = f2; f2 = d2; }
                else if (d2 < f3) { f3 = d2; }
            }
        }
    }
    out7[0] = Math.sqrt(f1);
    out7[1] = Math.sqrt(f2);
    out7[2] = Math.sqrt(f3);
    out7[3] = id;
    out7[4] = cxN; out7[5] = cyN; out7[6] = czN;
    return out7;
}
/** Worley 2D full info. out6 = [F1, F2, F3, cellId, nearestX, nearestY]. */
export function worley2DInfoInto(out6, x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    let f1 = Infinity, f2 = Infinity, f3 = Infinity;
    let id = 0, cxN = 0, cyN = 0;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const cxi = xi + dx, cyi = yi + dy;
            const fx = cxi + hashSalt(cxi, cyi, 0, SALT_FX);
            const fy = cyi + hashSalt(cxi, cyi, 0, SALT_FY);
            const ddx = x - fx, ddy = y - fy;
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 < f1) {
                f3 = f2; f2 = f1; f1 = d2;
                id = cellId(cxi, cyi, 0);
                cxN = fx; cyN = fy;
            } else if (d2 < f2) { f3 = f2; f2 = d2; }
            else if (d2 < f3) { f3 = d2; }
        }
    }
    out6[0] = Math.sqrt(f1);
    out6[1] = Math.sqrt(f2);
    out6[2] = Math.sqrt(f3);
    out6[3] = id;
    out6[4] = cxN; out6[5] = cyN;
    return out6;
}
export function createWorleyResult() {
    return { f1: 0, f2: 0, f3: 0, id: 0, cx: 0, cy: 0, cz: 0 };
}
/** Object form. Pass `result` to reuse it; omitting it allocates (setup only). */
export function worley3DInfo(x, y, z, result) {
    worley3DInfoInto(_worley7, x, y, z);
    const r = result || { f1: 0, f2: 0, f3: 0, id: 0, cx: 0, cy: 0, cz: 0 };
    r.f1 = _worley7[0]; r.f2 = _worley7[1]; r.f3 = _worley7[2]; r.id = _worley7[3];
    r.cx = _worley7[4]; r.cy = _worley7[5]; r.cz = _worley7[6];
    return r;
}
export function worley2DInfo(x, y, result) {
    worley2DInfoInto(_worley6, x, y);
    const r = result || { f1: 0, f2: 0, f3: 0, id: 0, cx: 0, cy: 0, cz: 0 };
    r.f1 = _worley6[0]; r.f2 = _worley6[1]; r.f3 = _worley6[2]; r.id = _worley6[3];
    r.cx = _worley6[4]; r.cy = _worley6[5]; r.cz = 0;
    return r;
}
export function worley3D(x, y, z) { worley3DInfoInto(_worley7, x, y, z); return _worley7[0]; }
export function worley2D(x, y) { worley2DInfoInto(_worley6, x, y); return _worley6[0]; }
export function worleyF1(x, y, z) { return z === undefined ? worley2D(x, y) : worley3D(x, y, z); }
export function worleyF2(x, y, z) {
    if (z === undefined) { worley2DInfoInto(_worley6, x, y); return _worley6[1]; }
    worley3DInfoInto(_worley7, x, y, z); return _worley7[1];
}
export function worleyF3(x, y, z) {
    if (z === undefined) { worley2DInfoInto(_worley6, x, y); return _worley6[2]; }
    worley3DInfoInto(_worley7, x, y, z); return _worley7[2];
}
/** F2 − F1 — the cell-boundary / crack mask primitive. */
export function worleyBoundary(x, y, z) {
    if (z === undefined) { worley2DInfoInto(_worley6, x, y); return _worley6[1] - _worley6[0]; }
    worley3DInfoInto(_worley7, x, y, z); return _worley7[1] - _worley7[0];
}

// ============================================================================
// Gabor (sparse convolution)
// ============================================================================
/**
 * Gabor 2D — sum of cos(2π·f·(p−c)·dir)·exp(−|p−c|²/σ²) kernels.
 * CORRECTED: variance-normalized by 1/√K so amplitude is stable across
 * densities, and each kernel parameter uses a distinct hash salt.
 */
export function gabor2D(x, y, density, frequency, sigma) {
    const K = density === undefined ? 4 : density;
    const freq = frequency === undefined ? 4 : frequency;
    const sig = sigma === undefined ? 0.5 : sigma;
    const invSig2 = 1 / (sig * sig);
    const xi = Math.floor(x), yi = Math.floor(y);
    let sum = 0;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const cxi = xi + dx, cyi = yi + dy;
            for (let k = 0; k < K; k++) {
                const fx = cxi + hashSalt(cxi, cyi, k, SALT_FX);
                const fy = cyi + hashSalt(cxi, cyi, k, SALT_FY);
                const theta = hashSalt(cxi, cyi, k, SALT_TH) * TAU;
                const ddx = x - fx, ddy = y - fy;
                const gauss = Math.exp(-(ddx * ddx + ddy * ddy) * invSig2);
                const phase = TAU * freq * (ddx * Math.cos(theta) + ddy * Math.sin(theta));
                sum += Math.cos(phase) * gauss;
            }
        }
    }
    return sum / Math.sqrt(K * 9);
}
export function gabor3D(x, y, z, density, frequency, sigma) {
    const K = density === undefined ? 4 : density;
    const freq = frequency === undefined ? 4 : frequency;
    const sig = sigma === undefined ? 0.5 : sigma;
    const invSig2 = 1 / (sig * sig);
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    let sum = 0;
    for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const cxi = xi + dx, cyi = yi + dy, czi = zi + dz;
                for (let k = 0; k < K; k++) {
                    const fx = cxi + hashSalt(cxi, cyi, czi + k, SALT_FX);
                    const fy = cyi + hashSalt(cxi, cyi, czi + k, SALT_FY);
                    const fz = czi + hashSalt(cxi, cyi, czi + k, SALT_FZ);
                    const theta = hashSalt(cxi, cyi, czi + k, SALT_TH) * TAU;
                    const phi = hashSalt(cxi, cyi, czi + k, SALT_PH) * PI;
                    const ddx = x - fx, ddy = y - fy, ddz = z - fz;
                    const gauss = Math.exp(-(ddx * ddx + ddy * ddy + ddz * ddz) * invSig2);
                    const sp = Math.sin(phi);
                    const phase = TAU * freq * (ddx * Math.cos(theta) * sp + ddy * Math.sin(theta) * sp + ddz * Math.cos(phi));
                    sum += Math.cos(phase) * gauss;
                }
            }
        }
    }
    return sum / Math.sqrt(K * 27);
}

// ============================================================================
// Band-limited wavelet noise (tile-based)
// ----------------------------------------------------------------------------
// Construction: periodic random tile R → decimate each axis with a [1,6,1]/8
// low-pass → reconstruct with a quadratic B-spline → W = R − U. W therefore has
// no DC / low-frequency drift. Evaluation uses the SAME quadratic B-spline, so
// there is no reconstruction aliasing either. The tile is periodic, so the
// result tiles seamlessly at any zoom — the two properties that make wavelet
// noise scale cleanly from 1e-6 to 1e+12.
// ============================================================================
function _decimateAxis(src, nx, ny, nz, axis) {
    const s = axis === 0 ? nx : axis === 1 ? ny : nz;
    const h = s >> 1;
    const dx = axis === 0 ? h : nx, dy = axis === 1 ? h : ny, dz = axis === 2 ? h : nz;
    const dst = new Float32Array(dx * dy * dz);
    const stride = axis === 0 ? 1 : axis === 1 ? nx : nx * ny;
    for (let z = 0; z < dz; z++) {
        for (let y = 0; y < dy; y++) {
            for (let x = 0; x < dx; x++) {
                const sx = axis === 0 ? 2 * x : x;
                const sy = axis === 1 ? 2 * y : y;
                const sz = axis === 2 ? 2 * z : z;
                const c = axis === 0 ? sx : axis === 1 ? sy : sz;
                const si = (sz * ny + sy) * nx + sx;
                const cm = (c - 1 + s) % s, cp = (c + 1) % s;
                dst[(z * dy + y) * dx + x] =
                    (src[si + (cm - c) * stride] + 6 * src[si] + src[si + (cp - c) * stride]) * 0.125;
            }
        }
    }
    return dst;
}
function _upsampleAxis(src, nx, ny, nz, axis) {
    const s = axis === 0 ? nx : axis === 1 ? ny : nz;
    const d = s * 2;
    const dx = axis === 0 ? d : nx, dy = axis === 1 ? d : ny, dz = axis === 2 ? d : nz;
    const dst = new Float32Array(dx * dy * dz);
    const stride = axis === 0 ? 1 : axis === 1 ? nx : nx * ny;
    for (let z = 0; z < dz; z++) {
        for (let y = 0; y < dy; y++) {
            for (let x = 0; x < dx; x++) {
                const i = axis === 0 ? x : axis === 1 ? y : z;
                const c = i * 0.5;
                const b = Math.floor(c);
                const t = c - b;
                const w0 = 0.5 * (1 - t) * (1 - t);
                const w1 = 0.5 + t - t * t;
                const w2 = 0.5 * t * t;
                const b0 = (b - 1 + s) % s, b1 = b % s, b2 = (b + 1) % s;
                const sx = axis === 0 ? b1 : x;
                const sy = axis === 1 ? b1 : y;
                const sz = axis === 2 ? b1 : z;
                const si = (sz * ny + sy) * nx + sx;
                dst[(z * dy + y) * dx + x] =
                    w0 * src[si + (b0 - b1) * stride] + w1 * src[si] + w2 * src[si + (b2 - b1) * stride];
            }
        }
    }
    return dst;
}
function _buildWaveletTile(size, seed, dims) {
    const n = size;
    const nx = n, ny = n, nz = dims === 3 ? n : 1;
    const total = nx * ny * nz;
    const rng = common.mulberry32((seed >>> 0) || 1);
    const R = new Float32Array(total);
    for (let i = 0; i < total; i++) R[i] = rng() * 2 - 1;
    let D = _decimateAxis(R, nx, ny, nz, 0);
    let hx = nx >> 1, hy = ny, hz = nz;
    D = _decimateAxis(D, hx, hy, hz, 1); hy = ny >> 1;
    if (dims === 3) { D = _decimateAxis(D, hx, hy, hz, 2); hz = nz >> 1; }
    let U = _upsampleAxis(D, hx, hy, hz, 1); hy *= 2;
    if (dims === 3) { U = _upsampleAxis(U, hx, hy, hz, 2); hz *= 2; }
    U = _upsampleAxis(U, hx, hy, hz, 0); hx *= 2;
    const W = new Float32Array(total);
    let acc = 0;
    for (let i = 0; i < total; i++) { const v = R[i] - U[i]; W[i] = v; acc += v * v; }
    const rms = Math.sqrt(acc / total) || 1;
    const norm = 1 / (rms * 3);
    for (let i = 0; i < total; i++) W[i] *= norm;
    return { size: n, dims: dims, data: W };
}
function _bsplineWeights(t, out3) {
    out3[0] = 0.5 * (1 - t) * (1 - t);
    out3[1] = 0.5 + t - t * t;
    out3[2] = 0.5 * t * t;
    return out3;
}
const _wx = new Float64Array(3), _wy = new Float64Array(3), _wz = new Float64Array(3);
function _waveletEval(tile, x, y, z) {
    const n = tile.size, data = tile.data;
    const xi = Math.floor(x), yi = Math.floor(y);
    _bsplineWeights(x - xi, _wx);
    _bsplineWeights(y - yi, _wy);
    const bx = xi - 1, by = yi - 1;
    if (tile.dims === 2) {
        let sum = 0;
        for (let j = 0; j < 3; j++) {
            const yy = ((by + j) % n + n) % n;
            const row = yy * n;
            let s = 0;
            for (let i = 0; i < 3; i++) {
                const xx = ((bx + i) % n + n) % n;
                s += _wx[i] * data[row + xx];
            }
            sum += _wy[j] * s;
        }
        return sum;
    }
    const zi = Math.floor(z);
    _bsplineWeights(z - zi, _wz);
    const bz = zi - 1;
    let sum = 0;
    for (let k = 0; k < 3; k++) {
        const zz = ((bz + k) % n + n) % n;
        const plane = zz * n * n;
        let sy = 0;
        for (let j = 0; j < 3; j++) {
            const yy = ((by + j) % n + n) % n;
            const row = plane + yy * n;
            let sx = 0;
            for (let i = 0; i < 3; i++) {
                const xx = ((bx + i) % n + n) % n;
                sx += _wx[i] * data[row + xx];
            }
            sy += _wy[j] * sx;
        }
        sum += _wz[k] * sy;
    }
    return sum;
}
const _waveletTile2 = _buildWaveletTile(64, 0x5bd1e995, 2);
const _waveletTile3 = _buildWaveletTile(32, 0x27d4eb2f, 3);

/** Band-limited wavelet noise 2D. Tileable, alias-free, approximately [-1,1]. */
export function wavelet2D(x, y) { return _waveletEval(_waveletTile2, x, y, 0); }
/** Band-limited wavelet noise 3D. */
export function wavelet3D(x, y, z) { return _waveletEval(_waveletTile3, x, y, z); }
/** Build a custom wavelet tile (setup-time allocation). */
export function createWaveletTile(size, seed, dims) {
    return _buildWaveletTile(size === undefined ? 32 : size, seed === undefined ? 1 : seed, dims === 2 ? 2 : 3);
}
/** Evaluate a custom wavelet tile. */
export function waveletTileEval(tile, x, y, z) { return _waveletEval(tile, x, y, z === undefined ? 0 : z); }

// ============================================================================
// Curl noise — divergence-free (CORRECTED)
// ============================================================================
/**
 * Curl 2D of a scalar potential P: (∂P/∂y, −∂P/∂x). Divergence-free.
 * CORRECTED: the chain rule is applied so the derivative is with respect to the
 * WORLD coordinate, not the scaled noise coordinate.
 */
export function curl2D(out, x, y, scale, epsilon) {
    const s = scale === undefined ? 1 : scale;
    const e = epsilon === undefined ? 1e-2 : epsilon;
    const inv = 1 / (2 * e);
    const px = x * s, py = y * s;
    const dPdx = (value2D(px + e, py) - value2D(px - e, py)) * inv * s;
    const dPdy = (value2D(px, py + e) - value2D(px, py - e)) * inv * s;
    out[0] = dPdy;
    out[1] = -dPdx;
    return value2D(px, py);
}
/**
 * Curl 3D of a VECTOR potential Ψ = (P, Q, R) built from three offset Perlin
 * fields. curl Ψ = (∂R/∂y − ∂Q/∂z, ∂P/∂z − ∂R/∂x, ∂Q/∂x − ∂P/∂y).
 * CORRECTED: the previous version mixed partials of two scalar fields, which is
 * not a curl and produced a field with non-zero divergence.
 */
export function curl3D(out, x, y, z, scale, epsilon) {
    const s = scale === undefined ? 1 : scale;
    const e = epsilon === undefined ? 1e-2 : epsilon;
    const inv = 1 / (2 * e);
    const px = x * s, py = y * s, pz = z * s;
    const qx = px + CURL_QX, qy = py + CURL_QY, qz = pz + CURL_QZ;
    const rx = px + CURL_RX, ry = py + CURL_RY, rz = pz + CURL_RZ;

    // ∂P/∂y, ∂P/∂z
    const dPdy = (perlin3D(px, py + e, pz) - perlin3D(px, py - e, pz)) * inv * s;
    const dPdz = (perlin3D(px, py, pz + e) - perlin3D(px, py, pz - e)) * inv * s;
    // ∂Q/∂x, ∂Q/∂z
    const dQdx = (perlin3D(qx + e, qy, qz) - perlin3D(qx - e, qy, qz)) * inv * s;
    const dQdz = (perlin3D(qx, qy, qz + e) - perlin3D(qx, qy, qz - e)) * inv * s;
    // ∂R/∂x, ∂R/∂y
    const dRdx = (perlin3D(rx + e, ry, rz) - perlin3D(rx - e, ry, rz)) * inv * s;
    const dRdy = (perlin3D(rx, ry + e, rz) - perlin3D(rx, ry - e, rz)) * inv * s;

    out[0] = dRdy - dQdz;
    out[1] = dPdz - dRdx;
    out[2] = dQdx - dPdy;
    return perlin3D(px, py, pz);
}

// ============================================================================
// fBm family
// ============================================================================
export function fbm2D(x, y, octaves, lacunarity, gain) {
    const oct = octaves === undefined ? 4 : octaves;
    const lac = lacunarity === undefined ? 2 : lacunarity;
    const g = gain === undefined ? 0.5 : gain;
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
        sum += amp * perlin2D(x * freq, y * freq);
        norm += amp; freq *= lac; amp *= g;
    }
    return norm > 0 ? sum / norm : 0;
}
export function fbm3D(x, y, z, octaves, lacunarity, gain) {
    const oct = octaves === undefined ? 4 : octaves;
    const lac = lacunarity === undefined ? 2 : lacunarity;
    const g = gain === undefined ? 0.5 : gain;
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
        sum += amp * perlin3D(x * freq, y * freq, z * freq);
        norm += amp; freq *= lac; amp *= g;
    }
    return norm > 0 ? sum / norm : 0;
}
export function fbm4D(x, y, z, w, octaves, lacunarity, gain) {
    const oct = octaves === undefined ? 4 : octaves;
    const lac = lacunarity === undefined ? 2 : lacunarity;
    const g = gain === undefined ? 0.5 : gain;
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
        sum += amp * perlin4D(x * freq, y * freq, z * freq, w * freq);
        norm += amp; freq *= lac; amp *= g;
    }
    return norm > 0 ? sum / norm : 0;
}
export function turbulence2D(x, y, octaves, lacunarity, gain) {
    const oct = octaves === undefined ? 4 : octaves;
    const lac = lacunarity === undefined ? 2 : lacunarity;
    const g = gain === undefined ? 0.5 : gain;
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
        const n = perlin2D(x * freq, y * freq);
        sum += amp * (n < 0 ? -n : n);
        norm += amp; freq *= lac; amp *= g;
    }
    return norm > 0 ? sum / norm : 0;
}
export function turbulence3D(x, y, z, octaves, lacunarity, gain) {
    const oct = octaves === undefined ? 4 : octaves;
    const lac = lacunarity === undefined ? 2 : lacunarity;
    const g = gain === undefined ? 0.5 : gain;
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
        const n = perlin3D(x * freq, y * freq, z * freq);
        sum += amp * (n < 0 ? -n : n);
        norm += amp; freq *= lac; amp *= g;
    }
    return norm > 0 ? sum / norm : 0;
}
export function turbulence4D(x, y, z, w, octaves, lacunarity, gain) {
    const oct = octaves === undefined ? 4 : octaves;
    const lac = lacunarity === undefined ? 2 : lacunarity;
    const g = gain === undefined ? 0.5 : gain;
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
        const n = perlin4D(x * freq, y * freq, z * freq, w * freq);
        sum += amp * (n < 0 ? -n : n);
        norm += amp; freq *= lac; amp *= g;
    }
    return norm > 0 ? sum / norm : 0;
}
export function ridged2D(x, y, octaves, lacunarity, gain) {
    const oct = octaves === undefined ? 4 : octaves;
    const lac = lacunarity === undefined ? 2 : lacunarity;
    const g = gain === undefined ? 0.5 : gain;
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
        const n = perlin2D(x * freq, y * freq);
        const v = 1 - (n < 0 ? -n : n);
        sum += amp * v * v;
        norm += amp; freq *= lac; amp *= g;
    }
    return norm > 0 ? sum / norm : 0;
}
export function ridged3D(x, y, z, octaves, lacunarity, gain) {
    const oct = octaves === undefined ? 4 : octaves;
    const lac = lacunarity === undefined ? 2 : lacunarity;
    const g = gain === undefined ? 0.5 : gain;
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
        const n = perlin3D(x * freq, y * freq, z * freq);
        const v = 1 - (n < 0 ? -n : n);
        sum += amp * v * v;
        norm += amp; freq *= lac; amp *= g;
    }
    return norm > 0 ? sum / norm : 0;
}
/** Bipolar billow (`2·|n|−1`) — puffy clouds, distinct from turbulence. */
export function billow2D(x, y, octaves, lacunarity, gain) {
    const oct = octaves === undefined ? 4 : octaves;
    const lac = lacunarity === undefined ? 2 : lacunarity;
    const g = gain === undefined ? 0.5 : gain;
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
        const n = perlin2D(x * freq, y * freq);
        sum += amp * (2 * (n < 0 ? -n : n) - 1);
        norm += amp; freq *= lac; amp *= g;
    }
    return norm > 0 ? sum / norm : 0;
}
export function billow3D(x, y, z, octaves, lacunarity, gain) {
    const oct = octaves === undefined ? 4 : octaves;
    const lac = lacunarity === undefined ? 2 : lacunarity;
    const g = gain === undefined ? 0.5 : gain;
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
        const n = perlin3D(x * freq, y * freq, z * freq);
        sum += amp * (2 * (n < 0 ? -n : n) - 1);
        norm += amp; freq *= lac; amp *= g;
    }
    return norm > 0 ? sum / norm : 0;
}

/**
 * Canonical Musgrave hybrid multifractal.
 * CORRECTED: octaves are weighted by `freq^-H` (the previous `* freq` made the
 * series diverge) and `weight` is fed back from the signal.
 */
export function hybridMultifractal2D(x, y, octaves, lacunarity, gain, offset, H) {
    const oct = octaves === undefined ? 4 : octaves;
    const lac = lacunarity === undefined ? 2 : lacunarity;
    const g = gain === undefined ? 0.25 : gain;
    const off = offset === undefined ? 0.7 : offset;
    const h = H === undefined ? 1 : H;
    let freq = 1;
    let signal = (perlin2D(x, y) + off) * Math.pow(freq, -h);
    let result = signal;
    let weight = signal;
    freq *= lac;
    for (let i = 1; i < oct; i++) {
        if (weight > 1) weight = 1;
        signal = (perlin2D(x * freq, y * freq) + off) * Math.pow(freq, -h) * g;
        result += weight * signal;
        weight *= signal;
        freq *= lac;
    }
    return result;
}
export function hybridMultifractal3D(x, y, z, octaves, lacunarity, gain, offset, H) {
    const oct = octaves === undefined ? 4 : octaves;
    const lac = lacunarity === undefined ? 2 : lacunarity;
    const g = gain === undefined ? 0.25 : gain;
    const off = offset === undefined ? 0.7 : offset;
    const h = H === undefined ? 1 : H;
    let freq = 1;
    let signal = (perlin3D(x, y, z) + off) * Math.pow(freq, -h);
    let result = signal;
    let weight = signal;
    freq *= lac;
    for (let i = 1; i < oct; i++) {
        if (weight > 1) weight = 1;
        signal = (perlin3D(x * freq, y * freq, z * freq) + off) * Math.pow(freq, -h) * g;
        result += weight * signal;
        weight *= signal;
        freq *= lac;
    }
    return result;
}
/** Canonical Musgrave hetero-terrain — detail only above the offset threshold. */
export function heteroTerrain2D(x, y, octaves, lacunarity, gain, offset, H) {
    const oct = octaves === undefined ? 4 : octaves;
    const lac = lacunarity === undefined ? 2 : lacunarity;
    const g = gain === undefined ? 0.5 : gain;
    const off = offset === undefined ? 0.7 : offset;
    const h = H === undefined ? 1 : H;
    let freq = 1;
    let signal = (perlin2D(x, y) + off) * Math.pow(freq, -h);
    let result = signal;
    let weight = signal;
    freq *= lac;
    for (let i = 1; i < oct; i++) {
        if (weight > 1) weight = 1;
        if (weight < 0) weight = 0;
        signal = (perlin2D(x * freq, y * freq) + off) * Math.pow(freq, -h) * g;
        result += weight * signal;
        weight *= signal;
        freq *= lac;
    }
    return result;
}
export function heteroTerrain3D(x, y, z, octaves, lacunarity, gain, offset, H) {
    const oct = octaves === undefined ? 4 : octaves;
    const lac = lacunarity === undefined ? 2 : lacunarity;
    const g = gain === undefined ? 0.5 : gain;
    const off = offset === undefined ? 0.7 : offset;
    const h = H === undefined ? 1 : H;
    let freq = 1;
    let signal = (perlin3D(x, y, z) + off) * Math.pow(freq, -h);
    let result = signal;
    let weight = signal;
    freq *= lac;
    for (let i = 1; i < oct; i++) {
        if (weight > 1) weight = 1;
        if (weight < 0) weight = 0;
        signal = (perlin3D(x * freq, y * freq, z * freq) + off) * Math.pow(freq, -h) * g;
        result += weight * signal;
        weight *= signal;
        freq *= lac;
    }
    return result;
}

// ============================================================================
// Domain warp
// ============================================================================
export function domainWarp2D(x, y, strength, baseOctaves, lacunarity, gain) {
    const s = strength === undefined ? 2 : strength;
    const oct = baseOctaves === undefined ? 3 : baseOctaves;
    const wx = fbm2D(x + WARP_AX, y + WARP_AY, oct, lacunarity, gain);
    const wy = fbm2D(x + WARP_BX, y + WARP_BY, oct, lacunarity, gain);
    return fbm2D(x + s * wx, y + s * wy, oct, lacunarity, gain);
}
export function domainWarp3D(x, y, z, strength, baseOctaves, lacunarity, gain) {
    const s = strength === undefined ? 2 : strength;
    const oct = baseOctaves === undefined ? 3 : baseOctaves;
    const wx = fbm3D(x + WARP_AX, y + WARP_AY, z + WARP_AZ, oct, lacunarity, gain);
    const wy = fbm3D(x + WARP_BX, y + WARP_BY, z + WARP_BZ, oct, lacunarity, gain);
    const wz = fbm3D(x + WARP_CX, y + WARP_CY, z + WARP_CZ, oct, lacunarity, gain);
    return fbm3D(x + s * wx, y + s * wy, z + s * wz, oct, lacunarity, gain);
}

// ============================================================================
// Operator resolution + dispatch (hoist the branch out of hot loops)
// ============================================================================
export function resolveNoiseKind(kind) {
    if (typeof kind === "number") return kind | 0;
    switch (String(kind || "perlin")) {
        case "value": return NOISE_VALUE;
        case "white": return NOISE_WHITE;
        case "worley": case "cellular": return NOISE_WORLEY;
        case "gabor": return NOISE_GABOR;
        case "wavelet": return NOISE_WAVELET;
        case "simplex": return NOISE_SIMPLEX;
        default: return NOISE_PERLIN;
    }
}
export function resolveNoiseMode(mode) {
    if (typeof mode === "number") return mode | 0;
    switch (String(mode || "fbm")) {
        case "raw": case "noise": return MODE_RAW;
        case "turbulence": return MODE_TURBULENCE;
        case "ridged": return MODE_RIDGED;
        case "billow": return MODE_BILLOW;
        case "hybrid": case "hybridMultifractal": return MODE_HYBRID;
        case "hetero": case "heteroTerrain": return MODE_HETERO;
        case "warp": case "warped": case "domainWarp": return MODE_WARP;
        default: return MODE_FBM;
    }
}
function _sample3D(kind, mode, x, y, z, oct, lac, gain, strength) {
    if (mode === MODE_RAW) {
        switch (kind) {
            case NOISE_VALUE: return value3D(x, y, z);
            case NOISE_WHITE: return white(Math.floor(x), Math.floor(y), Math.floor(z));
            case NOISE_WORLEY: return worley3D(x, y, z);
            case NOISE_GABOR: return gabor3D(x, y, z);
            case NOISE_WAVELET: return wavelet3D(x, y, z);
            default: return perlin3D(x, y, z);
        }
    }
    switch (mode) {
        case MODE_TURBULENCE: return turbulence3D(x, y, z, oct, lac, gain);
        case MODE_RIDGED: return ridged3D(x, y, z, oct, lac, gain);
        case MODE_BILLOW: return billow3D(x, y, z, oct, lac, gain);
        case MODE_HYBRID: return hybridMultifractal3D(x, y, z, oct, lac, gain);
        case MODE_HETERO: return heteroTerrain3D(x, y, z, oct, lac, gain);
        case MODE_WARP: return domainWarp3D(x, y, z, strength, oct, lac, gain);
        default: return fbm3D(x, y, z, oct, lac, gain);
    }
}

// ============================================================================
// Seeded builders — closures over PRE-BUILT tables (setup-time allocation only)
// ============================================================================
function _buildPerm(seed) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    const rng = common.mulberry32((seed >>> 0) || 1);
    for (let i = 255; i > 0; i--) {
        const j = (rng() * (i + 1)) | 0;
        const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    const perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
    return perm;
}
/** Seeded 2D Perlin. */
export function createPerlin2D(seed) {
    const perm = _buildPerm(seed);
    return function (x, y) { return _perlin2DP(perm, x, y); };
}
/** Seeded 3D Perlin. CORRECTED: actually uses its own permutation table. */
export function createPerlin3D(seed) {
    const perm = _buildPerm(seed);
    return function (x, y, z) { return _perlin3DP(perm, x, y, z); };
}
/** Seeded 4D Perlin. */
export function createPerlin4D(seed) {
    const perm = _buildPerm(seed);
    return function (x, y, z, w) { return _perlin4DP(perm, x, y, z, w); };
}
/** Seeded Worley 2D (F1). */
export function createWorley2D(seed) {
    const s = (seed >>> 0) || 1;
    const salt = Math.imul(s, SALT_ID) | 0;
    return function (x, y) {
        const xi = Math.floor(x), yi = Math.floor(y);
        let f1 = Infinity;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const cxi = xi + dx, cyi = yi + dy;
                const fx = cxi + hashSalt(cxi, cyi, salt, SALT_FX);
                const fy = cyi + hashSalt(cxi, cyi, salt, SALT_FY);
                const ddx = x - fx, ddy = y - fy;
                const d2 = ddx * ddx + ddy * ddy;
                if (d2 < f1) f1 = d2;
            }
        }
        return Math.sqrt(f1);
    };
}
/** Seeded Worley 3D (F1). */
export function createWorley3D(seed) {
    const s = (seed >>> 0) || 1;
    const salt = Math.imul(s, SALT_ID) | 0;
    return function (x, y, z) {
        const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
        let f1 = Infinity;
        for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const cxi = xi + dx, cyi = yi + dy, czi = zi + dz;
                    const fx = cxi + hashSalt(cxi, cyi, czi + salt, SALT_FX);
                    const fy = cyi + hashSalt(cxi, cyi, czi + salt, SALT_FY);
                    const fz = czi + hashSalt(cxi, cyi, czi + salt, SALT_FZ);
                    const ddx = x - fx, ddy = y - fy, ddz = z - fz;
                    const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
                    if (d2 < f1) f1 = d2;
                }
            }
        }
        return Math.sqrt(f1);
    };
}
/** Seeded band-limited wavelet 2D (own tile). */
export function createWavelet2D(seed, size) {
    const tile = _buildWaveletTile(size === undefined ? 64 : size, seed, 2);
    return function (x, y) { return _waveletEval(tile, x, y, 0); };
}
/** Seeded band-limited wavelet 3D (own tile). */
export function createWavelet3D(seed, size) {
    const tile = _buildWaveletTile(size === undefined ? 32 : size, seed, 3);
    return function (x, y, z) { return _waveletEval(tile, x, y, z); };
}
/** Seeded fBm 3D over any base noise function. */
export function createFBM3D(seed, baseFn) {
    const fn = baseFn || createPerlin3D(seed);
    return function (x, y, z, octaves, lacunarity, gain) {
        const oct = octaves === undefined ? 4 : octaves;
        const lac = lacunarity === undefined ? 2 : lacunarity;
        const g = gain === undefined ? 0.5 : gain;
        let sum = 0, amp = 1, freq = 1, norm = 0;
        for (let i = 0; i < oct; i++) {
            sum += amp * fn(x * freq, y * freq, z * freq);
            norm += amp; freq *= lac; amp *= g;
        }
        return norm > 0 ? sum / norm : 0;
    };
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
/** out2 = (aHi,aLo) − (bHi,bLo), renormalized BEFORE any narrowing. */
export function dsSubInto(out2, aHi, aLo, bHi, bLo) {
    const b = -bHi;
    const s = aHi + b;
    const bb = s - aHi;
    const e = (aHi - (s - bb)) + (b - bb);
    const lo = e + (aLo - bLo);
    const hi = s + lo;
    const v = hi - s;
    out2[0] = hi;
    out2[1] = (s - (hi - v)) + (lo - v);
    return out2;
}
/**
 * Camera-relative noise coordinate from a double-single world position.
 * out3[k] = fround(((world − origin) renormalized) * scale). Sampling THIS
 * instead of the raw Float32 world position is what keeps procedural detail
 * stable at megaparsec offsets.
 */
export function noiseCoordFromDS(out3, posHi, posLo, originHi, originLo, scale) {
    const s = scale === undefined ? 1 : scale;
    for (let k = 0; k < 3; k++) {
        dsSubInto(_ds2, posHi[k], posLo[k], originHi[k], originLo ? originLo[k] : 0);
        out3[k] = Math.fround((_ds2[0] + _ds2[1]) * s);
    }
    return out3;
}
/**
 * SOA variant. `world` matches double.attachHighPrecisionPositions():
 * { x:{hi,lo}, y:{hi,lo}, z:{hi,lo} }. Writes normalized noise coordinates into
 * a vec3 SOA that can be fed directly to any `soa*` noise function.
 */
export function soaNoiseCoordsFromDS(outVec3, world, originHi, originLo, scale, eids, count) {
    count = count === undefined ? outVec3.count : count;
    const s = scale === undefined ? 1 : scale;
    const ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
    const xh = world.x.hi, xl = world.x.lo;
    const yh = world.y.hi, yl = world.y.lo;
    const zh = world.z.hi, zl = world.z.lo;
    const h0 = originHi[0], h1 = originHi[1], h2 = originHi[2];
    const l0 = originLo ? originLo[0] : 0;
    const l1 = originLo ? originLo[1] : 0;
    const l2 = originLo ? originLo[2] : 0;
    for (let i = 0; i < count; i++) {
        const idx = eids ? eids[i] : i;
        dsSubInto(_ds2, xh[idx], xl[idx], h0, l0);
        ox[i] = Math.fround((_ds2[0] + _ds2[1]) * s);
        dsSubInto(_ds2, yh[idx], yl[idx], h1, l1);
        oy[i] = Math.fround((_ds2[0] + _ds2[1]) * s);
        dsSubInto(_ds2, zh[idx], zl[idx], h2, l2);
        oz[i] = Math.fround((_ds2[0] + _ds2[1]) * s);
    }
    return outVec3;
}

// ============================================================================
// SOA — synchronous, zero allocation
// ============================================================================
export function soaPerlin2D(out, positions, scale, count) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y;
    for (let i = 0; i < count; i++) out[i] = perlin2D(px[i] * s, py[i] * s);
    return out;
}
export function soaPerlin3D(out, positions, scale, count) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) out[i] = perlin3D(px[i] * s, py[i] * s, pz[i] * s);
    return out;
}
/** 4D Perlin over a vec3 SOA. `time` is scalar or a per-row array. */
export function soaPerlin4D(out, positions, scale, time, count) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const tArr = _isArr(time) ? time : null;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) {
        out[i] = perlin4D(px[i] * s, py[i] * s, pz[i] * s, tArr ? tArr[i] : (time || 0));
    }
    return out;
}
export function soaValue2D(out, positions, scale, count) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y;
    for (let i = 0; i < count; i++) out[i] = value2D(px[i] * s, py[i] * s);
    return out;
}
export function soaValue3D(out, positions, scale, count) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) out[i] = value3D(px[i] * s, py[i] * s, pz[i] * s);
    return out;
}
export function soaWhite(out, positions, scale, count) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) {
        out[i] = white(Math.floor(px[i] * s), Math.floor(py[i] * s), Math.floor(pz[i] * s));
    }
    return out;
}
export function soaWorley2D(out, positions, scale, count) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y;
    for (let i = 0; i < count; i++) {
        worley2DInfoInto(_worley6, px[i] * s, py[i] * s);
        out[i] = _worley6[0];
    }
    return out;
}
export function soaWorley3D(out, positions, scale, count) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) {
        worley3DInfoInto(_worley7, px[i] * s, py[i] * s, pz[i] * s);
        out[i] = _worley7[0];
    }
    return out;
}
/** Worley F1/F2/F3 + boundary into four scalar channels. */
export function soaWorley3DInfo(outF1, outF2, outF3, outBoundary, positions, scale, count) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) {
        worley3DInfoInto(_worley7, px[i] * s, py[i] * s, pz[i] * s);
        outF1[i] = _worley7[0];
        outF2[i] = _worley7[1];
        if (outF3) outF3[i] = _worley7[2];
        if (outBoundary) outBoundary[i] = _worley7[1] - _worley7[0];
    }
    return outF1;
}
export function soaGabor3D(out, positions, density, frequency, sigma, count) {
    count = count === undefined ? positions.count : count;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) out[i] = gabor3D(px[i], py[i], pz[i], density, frequency, sigma);
    return out;
}
export function soaWavelet3D(out, positions, scale, count) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) out[i] = wavelet3D(px[i] * s, py[i] * s, pz[i] * s);
    return out;
}
/** Analytic Perlin gradient into a vec3 SOA — surface normals for displacement. */
export function soaPerlin3DGrad(outVec3, positions, scale, count) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    const ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
    for (let i = 0; i < count; i++) {
        perlin3DGrad(_grad3, px[i] * s, py[i] * s, pz[i] * s);
        ox[i] = _grad3[0] * s; oy[i] = _grad3[1] * s; oz[i] = _grad3[2] * s;
    }
    return outVec3;
}
/** Divergence-free curl field into a vec3 SOA. CORRECTED: fully inlined. */
export function soaCurl3D(outVec3, positions, scale, count, epsilon) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const e = epsilon === undefined ? 1e-2 : epsilon;
    const inv = 1 / (2 * e);
    const px = positions.x, py = positions.y, pz = positions.z;
    const ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
    for (let i = 0; i < count; i++) {
        const x = px[i] * s, y = py[i] * s, z = pz[i] * s;
        const qx = x + CURL_QX, qy = y + CURL_QY, qz = z + CURL_QZ;
        const rx = x + CURL_RX, ry = y + CURL_RY, rz = z + CURL_RZ;
        const dPdy = (perlin3D(x, y + e, z) - perlin3D(x, y - e, z)) * inv * s;
        const dPdz = (perlin3D(x, y, z + e) - perlin3D(x, y, z - e)) * inv * s;
        const dQdx = (perlin3D(qx + e, qy, qz) - perlin3D(qx - e, qy, qz)) * inv * s;
        const dQdz = (perlin3D(qx, qy, qz + e) - perlin3D(qx, qy, qz - e)) * inv * s;
        const dRdx = (perlin3D(rx + e, ry, rz) - perlin3D(rx - e, ry, rz)) * inv * s;
        const dRdy = (perlin3D(rx, ry + e, rz) - perlin3D(rx, ry - e, rz)) * inv * s;
        ox[i] = dRdy - dQdz;
        oy[i] = dPdz - dRdx;
        oz[i] = dQdx - dPdy;
    }
    return outVec3;
}
export function soaFBM3D(out, positions, scale, octaves, lacunarity, gain, count) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) out[i] = fbm3D(px[i] * s, py[i] * s, pz[i] * s, octaves, lacunarity, gain);
    return out;
}
export function soaFBM4D(out, positions, scale, time, octaves, lacunarity, gain, count) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const tArr = _isArr(time) ? time : null;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) {
        out[i] = fbm4D(px[i] * s, py[i] * s, pz[i] * s, tArr ? tArr[i] : (time || 0), octaves, lacunarity, gain);
    }
    return out;
}
export function soaTurbulence3D(out, positions, scale, octaves, lacunarity, gain, count) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) out[i] = turbulence3D(px[i] * s, py[i] * s, pz[i] * s, octaves, lacunarity, gain);
    return out;
}
export function soaRidged3D(out, positions, scale, octaves, lacunarity, gain, count) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) out[i] = ridged3D(px[i] * s, py[i] * s, pz[i] * s, octaves, lacunarity, gain);
    return out;
}
export function soaBillow3D(out, positions, scale, octaves, lacunarity, gain, count) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) out[i] = billow3D(px[i] * s, py[i] * s, pz[i] * s, octaves, lacunarity, gain);
    return out;
}
export function soaHybridMultifractal3D(out, positions, scale, octaves, lacunarity, gain, offset, H, count) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) {
        out[i] = hybridMultifractal3D(px[i] * s, py[i] * s, pz[i] * s, octaves, lacunarity, gain, offset, H);
    }
    return out;
}
export function soaHeteroTerrain3D(out, positions, scale, octaves, lacunarity, gain, offset, H, count) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) {
        out[i] = heteroTerrain3D(px[i] * s, py[i] * s, pz[i] * s, octaves, lacunarity, gain, offset, H);
    }
    return out;
}
export function soaDomainWarp3D(out, positions, scale, strength, baseOctaves, count) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) {
        out[i] = domainWarp3D(px[i] * s, py[i] * s, pz[i] * s, strength, baseOctaves);
    }
    return out;
}
/** Generic dispatch — kind and mode resolved ONCE, outside the loop. */
export function soaNoise3D(out, positions, options) {
    options = options || {};
    const count = options.count === undefined ? positions.count : options.count;
    const kind = resolveNoiseKind(options.kind);
    const mode = resolveNoiseMode(options.mode);
    const s = options.scale === undefined ? 1 : options.scale;
    const oct = options.octaves === undefined ? 4 : options.octaves;
    const lac = options.lacunarity === undefined ? 2 : options.lacunarity;
    const gain = options.gain === undefined ? 0.5 : options.gain;
    const strength = options.warpStrength === undefined ? 2 : options.warpStrength;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) {
        out[i] = _sample3D(kind, mode, px[i] * s, py[i] * s, pz[i] * s, oct, lac, gain, strength);
    }
    return out;
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

export async function soaPerlin2DChunked(out, positions, scale, count, cs, ye) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y;
    await _chunked(count, cs, ye, function (a, b) {
        for (let i = a; i < b; i++) out[i] = perlin2D(px[i] * s, py[i] * s);
    });
    return out;
}
export async function soaPerlin3DChunked(out, positions, scale, count, cs, ye) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    await _chunked(count, cs, ye, function (a, b) {
        for (let i = a; i < b; i++) out[i] = perlin3D(px[i] * s, py[i] * s, pz[i] * s);
    });
    return out;
}
export async function soaPerlin4DChunked(out, positions, scale, time, count, cs, ye) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const tArr = _isArr(time) ? time : null;
    const px = positions.x, py = positions.y, pz = positions.z;
    await _chunked(count, cs, ye, function (a, b) {
        for (let i = a; i < b; i++) {
            out[i] = perlin4D(px[i] * s, py[i] * s, pz[i] * s, tArr ? tArr[i] : (time || 0));
        }
    });
    return out;
}
export async function soaValue3DChunked(out, positions, scale, count, cs, ye) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    await _chunked(count, cs, ye, function (a, b) {
        for (let i = a; i < b; i++) out[i] = value3D(px[i] * s, py[i] * s, pz[i] * s);
    });
    return out;
}
export async function soaWorley3DChunked(out, positions, scale, count, cs, ye) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    await _chunked(count, cs, ye, function (a, b) {
        for (let i = a; i < b; i++) {
            worley3DInfoInto(_worley7, px[i] * s, py[i] * s, pz[i] * s);
            out[i] = _worley7[0];
        }
    });
    return out;
}
export async function soaGabor3DChunked(out, positions, density, frequency, sigma, count, cs, ye) {
    count = count === undefined ? positions.count : count;
    const px = positions.x, py = positions.y, pz = positions.z;
    await _chunked(count, cs, ye, function (a, b) {
        for (let i = a; i < b; i++) out[i] = gabor3D(px[i], py[i], pz[i], density, frequency, sigma);
    });
    return out;
}
export async function soaWavelet3DChunked(out, positions, scale, count, cs, ye) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    await _chunked(count, cs, ye, function (a, b) {
        for (let i = a; i < b; i++) out[i] = wavelet3D(px[i] * s, py[i] * s, pz[i] * s);
    });
    return out;
}
export async function soaPerlin3DGradChunked(outVec3, positions, scale, count, cs, ye) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    const ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
    await _chunked(count, cs, ye, function (a, b) {
        for (let i = a; i < b; i++) {
            perlin3DGrad(_grad3, px[i] * s, py[i] * s, pz[i] * s);
            ox[i] = _grad3[0] * s; oy[i] = _grad3[1] * s; oz[i] = _grad3[2] * s;
        }
    });
    return outVec3;
}
export async function soaCurl3DChunked(outVec3, positions, scale, count, cs, ye, epsilon) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const e = epsilon === undefined ? 1e-2 : epsilon;
    const inv = 1 / (2 * e);
    const px = positions.x, py = positions.y, pz = positions.z;
    const ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
    await _chunked(count, cs, ye, function (a, b) {
        for (let i = a; i < b; i++) {
            const x = px[i] * s, y = py[i] * s, z = pz[i] * s;
            const qx = x + CURL_QX, qy = y + CURL_QY, qz = z + CURL_QZ;
            const rx = x + CURL_RX, ry = y + CURL_RY, rz = z + CURL_RZ;
            const dPdy = (perlin3D(x, y + e, z) - perlin3D(x, y - e, z)) * inv * s;
            const dPdz = (perlin3D(x, y, z + e) - perlin3D(x, y, z - e)) * inv * s;
            const dQdx = (perlin3D(qx + e, qy, qz) - perlin3D(qx - e, qy, qz)) * inv * s;
            const dQdz = (perlin3D(qx, qy, qz + e) - perlin3D(qx, qy, qz - e)) * inv * s;
            const dRdx = (perlin3D(rx + e, ry, rz) - perlin3D(rx - e, ry, rz)) * inv * s;
            const dRdy = (perlin3D(rx, ry + e, rz) - perlin3D(rx, ry - e, rz)) * inv * s;
            ox[i] = dRdy - dQdz;
            oy[i] = dPdz - dRdx;
            oz[i] = dQdx - dPdy;
        }
    });
    return outVec3;
}
export async function soaFBM3DChunked(out, positions, scale, octaves, lacunarity, gain, count, cs, ye) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    await _chunked(count, cs, ye, function (a, b) {
        for (let i = a; i < b; i++) out[i] = fbm3D(px[i] * s, py[i] * s, pz[i] * s, octaves, lacunarity, gain);
    });
    return out;
}
export async function soaTurbulence3DChunked(out, positions, scale, octaves, lacunarity, gain, count, cs, ye) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    await _chunked(count, cs, ye, function (a, b) {
        for (let i = a; i < b; i++) out[i] = turbulence3D(px[i] * s, py[i] * s, pz[i] * s, octaves, lacunarity, gain);
    });
    return out;
}
export async function soaRidged3DChunked(out, positions, scale, octaves, lacunarity, gain, count, cs, ye) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    await _chunked(count, cs, ye, function (a, b) {
        for (let i = a; i < b; i++) out[i] = ridged3D(px[i] * s, py[i] * s, pz[i] * s, octaves, lacunarity, gain);
    });
    return out;
}
export async function soaBillow3DChunked(out, positions, scale, octaves, lacunarity, gain, count, cs, ye) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    await _chunked(count, cs, ye, function (a, b) {
        for (let i = a; i < b; i++) out[i] = billow3D(px[i] * s, py[i] * s, pz[i] * s, octaves, lacunarity, gain);
    });
    return out;
}
export async function soaHybridMultifractal3DChunked(out, positions, scale, octaves, lac, gain, offset, H, count, cs, ye) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    await _chunked(count, cs, ye, function (a, b) {
        for (let i = a; i < b; i++) {
            out[i] = hybridMultifractal3D(px[i] * s, py[i] * s, pz[i] * s, octaves, lac, gain, offset, H);
        }
    });
    return out;
}
export async function soaHeteroTerrain3DChunked(out, positions, scale, octaves, lac, gain, offset, H, count, cs, ye) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    await _chunked(count, cs, ye, function (a, b) {
        for (let i = a; i < b; i++) {
            out[i] = heteroTerrain3D(px[i] * s, py[i] * s, pz[i] * s, octaves, lac, gain, offset, H);
        }
    });
    return out;
}
export async function soaDomainWarp3DChunked(out, positions, scale, strength, baseOctaves, count, cs, ye) {
    count = count === undefined ? positions.count : count;
    const s = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    await _chunked(count, cs, ye, function (a, b) {
        for (let i = a; i < b; i++) out[i] = domainWarp3D(px[i] * s, py[i] * s, pz[i] * s, strength, baseOctaves);
    });
    return out;
}
export async function soaNoiseCoordsFromDSChunked(outVec3, world, originHi, originLo, scale, eids, count, cs, ye) {
    count = count === undefined ? outVec3.count : count;
    const s = scale === undefined ? 1 : scale;
    const ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
    const xh = world.x.hi, xl = world.x.lo;
    const yh = world.y.hi, yl = world.y.lo;
    const zh = world.z.hi, zl = world.z.lo;
    const h0 = originHi[0], h1 = originHi[1], h2 = originHi[2];
    const l0 = originLo ? originLo[0] : 0;
    const l1 = originLo ? originLo[1] : 0;
    const l2 = originLo ? originLo[2] : 0;
    await _chunked(count, cs, ye, function (a, b) {
        for (let i = a; i < b; i++) {
            const idx = eids ? eids[i] : i;
            dsSubInto(_ds2, xh[idx], xl[idx], h0, l0);
            ox[i] = Math.fround((_ds2[0] + _ds2[1]) * s);
            dsSubInto(_ds2, yh[idx], yl[idx], h1, l1);
            oy[i] = Math.fround((_ds2[0] + _ds2[1]) * s);
            dsSubInto(_ds2, zh[idx], zl[idx], h2, l2);
            oz[i] = Math.fround((_ds2[0] + _ds2[1]) * s);
        }
    });
    return outVec3;
}

// ============================================================================
// LUT authoring (Blueprint §30) — caller owns the buffer
// ============================================================================
/** 2D noise LUT, RGBA floats. `out` holds width*height*4 values. */
export function buildNoiseLUT2D(out, width, height, options) {
    options = options || {};
    const kind = resolveNoiseKind(options.kind);
    const mode = resolveNoiseMode(options.mode);
    const s = options.scale === undefined ? 8 : options.scale;
    const oct = options.octaves === undefined ? 4 : options.octaves;
    const lac = options.lacunarity === undefined ? 2 : options.lacunarity;
    const gain = options.gain === undefined ? 0.5 : options.gain;
    const strength = options.warpStrength === undefined ? 2 : options.warpStrength;
    const t = options.time === undefined ? 0 : options.time;
    const bipolar = options.bipolar === true;
    const invW = 1 / width, invH = 1 / height;
    for (let y = 0; y < height; y++) {
        const fy = y * invH * s;
        for (let x = 0; x < width; x++) {
            const fx = x * invW * s;
            let v;
            if (kind === NOISE_PERLIN && mode === MODE_FBM) v = fbm4D(fx, fy, 0, t, oct, lac, gain);
            else v = _sample3D(kind, mode, fx, fy, t, oct, lac, gain, strength);
            const g = bipolar ? v : clamp01(v * 0.5 + 0.5);
            const o = (y * width + x) * 4;
            out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 1;
        }
    }
    return out;
}
export async function buildNoiseLUT2DChunked(out, width, height, options, cs, ye) {
    options = options || {};
    const kind = resolveNoiseKind(options.kind);
    const mode = resolveNoiseMode(options.mode);
    const s = options.scale === undefined ? 8 : options.scale;
    const oct = options.octaves === undefined ? 4 : options.octaves;
    const lac = options.lacunarity === undefined ? 2 : options.lacunarity;
    const gain = options.gain === undefined ? 0.5 : options.gain;
    const strength = options.warpStrength === undefined ? 2 : options.warpStrength;
    const t = options.time === undefined ? 0 : options.time;
    const bipolar = options.bipolar === true;
    const invW = 1 / width, invH = 1 / height;
    await _chunked(height, cs, ye, function (a, b) {
        for (let y = a; y < b; y++) {
            const fy = y * invH * s;
            for (let x = 0; x < width; x++) {
                const fx = x * invW * s;
                let v;
                if (kind === NOISE_PERLIN && mode === MODE_FBM) v = fbm4D(fx, fy, 0, t, oct, lac, gain);
                else v = _sample3D(kind, mode, fx, fy, t, oct, lac, gain, strength);
                const g = bipolar ? v : clamp01(v * 0.5 + 0.5);
                const o = (y * width + x) * 4;
                out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 1;
            }
        }
    });
    return out;
}
/** 3D noise LUT (size³ RGBA floats) — for volumetric raymarching textures. */
export function buildNoiseLUT3D(out, size, options) {
    options = options || {};
    const kind = resolveNoiseKind(options.kind);
    const mode = resolveNoiseMode(options.mode);
    const s = options.scale === undefined ? 4 : options.scale;
    const oct = options.octaves === undefined ? 4 : options.octaves;
    const lac = options.lacunarity === undefined ? 2 : options.lacunarity;
    const gain = options.gain === undefined ? 0.5 : options.gain;
    const strength = options.warpStrength === undefined ? 2 : options.warpStrength;
    const bipolar = options.bipolar === true;
    const inv = 1 / size;
    for (let z = 0; z < size; z++) {
        const fz = z * inv * s;
        for (let y = 0; y < size; y++) {
            const fy = y * inv * s;
            for (let x = 0; x < size; x++) {
                const v = _sample3D(kind, mode, x * inv * s, fy, fz, oct, lac, gain, strength);
                const g = bipolar ? v : clamp01(v * 0.5 + 0.5);
                const o = ((z * size + y) * size + x) * 4;
                out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 1;
            }
        }
    }
    return out;
}
export async function buildNoiseLUT3DChunked(out, size, options, cs, ye) {
    options = options || {};
    const kind = resolveNoiseKind(options.kind);
    const mode = resolveNoiseMode(options.mode);
    const s = options.scale === undefined ? 4 : options.scale;
    const oct = options.octaves === undefined ? 4 : options.octaves;
    const lac = options.lacunarity === undefined ? 2 : options.lacunarity;
    const gain = options.gain === undefined ? 0.5 : options.gain;
    const strength = options.warpStrength === undefined ? 2 : options.warpStrength;
    const bipolar = options.bipolar === true;
    const inv = 1 / size;
    await _chunked(size, cs, ye, function (a, b) {
        for (let z = a; z < b; z++) {
            const fz = z * inv * s;
            for (let y = 0; y < size; y++) {
                const fy = y * inv * s;
                for (let x = 0; x < size; x++) {
                    const v = _sample3D(kind, mode, x * inv * s, fy, fz, oct, lac, gain, strength);
                    const g = bipolar ? v : clamp01(v * 0.5 + 0.5);
                    const o = ((z * size + y) * size + x) * 4;
                    out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 1;
                }
            }
        }
    });
    return out;
}

// ============================================================================
// GPU attribute bridge (Blueprint §25 / §28)
// ============================================================================
export function writeNoiseIntoFlat(flat, values, count, stride, offset, scale, bias) {
    const n = count === undefined ? values.length : count;
    const st = stride === undefined ? 1 : stride;
    const off = offset === undefined ? 0 : offset;
    const s = scale === undefined ? 1 : scale;
    const b = bias === undefined ? 0 : bias;
    for (let i = 0, o = off; i < n; i++, o += st) flat[o] = values[i] * s + b;
    return flat;
}
export function flagNoiseUpload(attr, count, itemSize) {
    if (!attr) return;
    const st = itemSize || attr.itemSize || 1;
    if (attr.clearUpdateRanges) attr.clearUpdateRanges();
    if (attr.addUpdateRange) attr.addUpdateRange(0, count * st);
    attr.needsUpdate = true;
}
/** Upload a scalar noise channel. `values` may be an array or a NoiseBatchState. */
export function syncNoiseAttribute(attr, values, count, options) {
    if (!attr || !attr.array) return 0;
    options = options || {};
    const isState = !!(values && values.out);
    const src = isState ? values.out : values;
    const n = count === undefined ? (isState ? values.count : src.length) : count;
    const st = options.stride !== undefined ? options.stride : (attr.itemSize || 1);
    writeNoiseIntoFlat(attr.array, src, n, st, options.offset, options.scale, options.bias);
    flagNoiseUpload(attr, n, st);
    return n;
}
/** Upload a vec3 noise field (curl / gradient) into an interleaved attribute. */
export function syncNoiseVectorAttribute(attr, vec, count, options) {
    if (!attr || !attr.array) return 0;
    options = options || {};
    const n = count === undefined ? vec.count : count;
    const st = options.stride !== undefined ? options.stride : (attr.itemSize || 3);
    const off = options.offset === undefined ? 0 : options.offset;
    const s = options.scale === undefined ? 1 : options.scale;
    const flat = attr.array;
    const vx = vec.x, vy = vec.y, vz = vec.z;
    for (let i = 0, o = off; i < n; i++, o += st) {
        flat[o] = vx[i] * s;
        if (st > 1) flat[o + 1] = vy[i] * s;
        if (st > 2) flat[o + 2] = vz[i] * s;
        if (st > 3) flat[o + 3] = 1;
    }
    flagNoiseUpload(attr, n, st);
    return n;
}

// ============================================================================
// Pooled scratch — zero-GC, precision-aware, ES2017-compatible
// ============================================================================
export class NoiseScratch {
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
        const pool = NoiseScratch._warm;
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
            s = new NoiseScratch(0);
        }
        s.ensure(size || 0, channels || 3);
        return s;
    }
    static release(s) {
        if (!s) return;
        const pool = NoiseScratch._warm;
        if (pool.length < NoiseScratch.MAX_POOLED) pool.push(s);
    }
}
NoiseScratch._warm = [];
NoiseScratch.MAX_POOLED = 16;
(function _warmNoiseScratch() {
    for (let i = 0; i < 4; i++) NoiseScratch._warm.push(new NoiseScratch(256));
})();

export function createNoiseScratchPool(capacity) {
    return common.createPool(
        function () { return new NoiseScratch(0); },
        capacity || 16,
        function (s) { s.reset(); }
    );
}
const _noiseScratchPool = createNoiseScratchPool(16);
export function acquireNoiseScratch(size, channels) {
    const s = _noiseScratchPool.acquire();
    s.ensure(size || 0, channels || 3);
    return s;
}
export function releaseNoiseScratch(s) { if (s) _noiseScratchPool.release(s); }

// ============================================================================
// Batch state
// ============================================================================
export class NoiseBatchState {
    constructor(count, options) {
        options = options || {};
        this.count = count;
        const T = getArrayType();
        this._dtype = T;
        this.out = new T(count);
        this.outAux = new T(count);
        this.outAux2 = new T(count);
        this.vecOut = createVec3SOA(count);
        this.time = 0;
        this._tracked = options.track !== false;
        if (this._tracked) trackNoise(this);
    }
    perlin2D(positions, scale) { return soaPerlin2D(this.out, positions, scale, this.count); }
    perlin3D(positions, scale) { return soaPerlin3D(this.out, positions, scale, this.count); }
    perlin4D(positions, scale, time) {
        return soaPerlin4D(this.out, positions, scale, time === undefined ? this.time : time, this.count);
    }
    value3D(positions, scale) { return soaValue3D(this.out, positions, scale, this.count); }
    worley3D(positions, scale) { return soaWorley3D(this.out, positions, scale, this.count); }
    gabor3D(positions, freq, sig) { return soaGabor3D(this.out, positions, 4, freq, sig, this.count); }
    wavelet3D(positions, scale) { return soaWavelet3D(this.out, positions, scale, this.count); }
    fbm3D(positions, scale, oct, lac, gain) {
        return soaFBM3D(this.out, positions, scale, oct, lac, gain, this.count);
    }
    turbulence3D(positions, scale, oct, lac, gain) {
        return soaTurbulence3D(this.out, positions, scale, oct, lac, gain, this.count);
    }
    ridged3D(positions, scale, oct, lac, gain) {
        return soaRidged3D(this.out, positions, scale, oct, lac, gain, this.count);
    }
    billow3D(positions, scale, oct, lac, gain) {
        return soaBillow3D(this.out, positions, scale, oct, lac, gain, this.count);
    }
    domainWarp3D(positions, scale, strength, oct) {
        return soaDomainWarp3D(this.out, positions, scale, strength, oct, this.count);
    }
    curl3D(positions, scale) { return soaCurl3D(this.vecOut, positions, scale, this.count); }
    gradient3D(positions, scale) { return soaPerlin3DGrad(this.vecOut, positions, scale, this.count); }
    /** Generic dispatch — writes into `out`. */
    noise3D(positions, options) {
        const o = options || {};
        o.count = this.count;
        return soaNoise3D(this.out, positions, o);
    }
    async perlin3DChunked(positions, scale, cs, ye) {
        return soaPerlin3DChunked(this.out, positions, scale, this.count, cs, ye);
    }
    async fbm3DChunked(positions, scale, oct, lac, gain, cs, ye) {
        return soaFBM3DChunked(this.out, positions, scale, oct, lac, gain, this.count, cs, ye);
    }
    async curl3DChunked(positions, scale, cs, ye) {
        return soaCurl3DChunked(this.vecOut, positions, scale, this.count, cs, ye);
    }
    /** Single-pass dirty-range upload of the scalar channel (§25/§28). */
    uploadTo(attr, options) { return syncNoiseAttribute(attr, this, this.count, options); }
    /** Single-pass dirty-range upload of the vector channel. */
    uploadVectorTo(attr, options) { return syncNoiseVectorAttribute(attr, this.vecOut, this.count, options); }
    reset() {
        this.out.fill(0); this.outAux.fill(0); this.outAux2.fill(0);
        this.vecOut.x.fill(0); this.vecOut.y.fill(0); this.vecOut.z.fill(0);
        this.time = 0;
        return this;
    }
    migrate(targetPrecision) {
        const T = targetPrecision ? getArrayType(targetPrecision) : getArrayType();
        if (T === this._dtype) return this;
        const n = this.count;
        const names = ["out", "outAux", "outAux2"];
        for (let i = 0; i < names.length; i++) {
            const old = this[names[i]];
            const next = new T(n);
            next.set(old);
            this[names[i]] = next;
        }
        const vx = this.vecOut.x, vy = this.vecOut.y, vz = this.vecOut.z;
        const nx = new T(n); nx.set(vx);
        const ny = new T(n); ny.set(vy);
        const nz = new T(n); nz.set(vz);
        this.vecOut.x = nx; this.vecOut.y = ny; this.vecOut.z = nz;
        this.vecOut.arrays[0] = nx; this.vecOut.arrays[1] = ny; this.vecOut.arrays[2] = nz;
        this._dtype = T;
        return this;
    }
    toTransferable() { return noiseBatchToTransferable(this); }
    dispose() { if (this._tracked) untrackNoise(this); return this; }
}
export function createNoiseBatch(count, options) { return new NoiseBatchState(count, options); }

// ============================================================================
// Precision tracking / migration (dense arrays — no Map/Set, §10/§16)
// ============================================================================
const _trackedBatches = [];
export function trackNoise(state) {
    if (!state) return state;
    if (_trackedBatches.indexOf(state) === -1) _trackedBatches.push(state);
    return state;
}
export function untrackNoise(state) {
    const i = _trackedBatches.indexOf(state);
    if (i !== -1) _trackedBatches.splice(i, 1);
}
export function clearTrackedNoise() { _trackedBatches.length = 0; }
export function getTrackedNoise() { return _trackedBatches; }
export function migrateNoise(state, targetPrecision) {
    if (state && state.migrate) state.migrate(targetPrecision);
    return state;
}
export function migrateAllNoise(targetPrecision) {
    for (let i = 0; i < _trackedBatches.length; i++) {
        try { _trackedBatches[i].migrate(targetPrecision); }
        catch (e) { console.error("[044_noise-family] migration failed for one batch", e); }
    }
}

onPrecisionChange(function () {
    migrateAllNoise();
    NoiseScratch._warm.length = 0;
    for (let i = 0; i < 4; i++) NoiseScratch._warm.push(new NoiseScratch(256));
});

// ============================================================================
// Deterministic fixed-step animation (Blueprint §45 / §51)
// ============================================================================
/**
 * Drift-free noise clock. BOTH the total time and the step accumulator are
 * Neumaier-compensated, so a 4D noise field animated for days does not accumulate
 * Float64 drift in its time axis.
 */
export class NoiseClock {
    constructor(options) {
        options = options || {};
        this.hz = options.hz !== undefined ? options.hz : 60;
        this.fixedDt = 1 / this.hz;
        this.maxSteps = options.maxSteps !== undefined ? options.maxSteps : 8;
        this.maxFrameDt = options.maxFrameDt !== undefined ? options.maxFrameDt : 0.25;
        this.speed = options.speed !== undefined ? options.speed : 1;
        this.onStep = options.onStep || null;
        this._tS = 0; this._tC = 0;
        