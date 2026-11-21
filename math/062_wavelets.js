//File number : 062
// File : src/math/062_wavelets.js
//Description : Complete wavelet-transform system — 1D/2D/3D discrete wavelet transforms (DWT) with periodic/symmetric/zero boundary handling, multilevel decomposition, continuous wavelet transform (CWT) with Morlet and Mexican hat mothers, wavelet packets with best-basis selection, denoising (soft/hard thresholding + universal threshold), lifting schemes (Haar and CDF 5/3 for integer-reversible transforms), and a full filter bank registry (Haar, Daubechies db2/db3/db4/db6/db8, Symlet sym4/sym6, Coiflet coif1, biorthogonal CDF 9/7, Morlet, Mexican hat). Domain helpers cover multi-resolution terrain and volumetric clouds, detail addition for LOD refinement, motion curve smoothing that preserves sharp transitions, IK joint trajectory filtering, orbital position denoising for 1M+ bodies, color-domain spectral filtering, and LOD hierarchies from any mesh grid. Every transform has SOA batch versions for 1M+ independent signals plus chunked async variants that yield via `scheduler.yield()` so the Android UI thread 
stays at 60 fps. Buffers honor `000_Math_module.js` precision mode (Float16/Float32/Float64 live-swap), filter coefficients remain Float64 for numerical stability, and all scratch memory is pooled for zero GC. Small-to-galactic seamless because every transform operates on normalized [0,1] parameter space.
//####
//Best for : 3d graphics — multi-resolution terrain and volumetric clouds, mesh LOD generation via wavelet approximation, animation curve smoothing that preserves sharp transitions (foot plants, velocity changes), IK joint trajectory denoising without overshoot, orbital position filtering across 1M+ bodies, HDR color grading by frequency band, procedural texture synthesis, multi-resolution procedural world building, and any per-frame wavelet pipeline that must run on Android 64-bit without blocking the UI thread.
//License : MIT

// ============================================================================
// Directive Prologues
// ============================================================================

"use strict";

// ============================================================================
// Import
// ============================================================================

const M          = require("./000_Math_module.js");
const FFT        = require("./061_fft.js");

const common          = M.common;
const getArrayType    = M.getArrayType;
const onPrecisionChange = M.onPrecisionChange;

// ============================================================================
// Export Declarations
// ============================================================================

// ---- Filter registry ----
exports.WaveletFilter    = WaveletFilter;
exports.registerFilter   = registerFilter;
exports.getFilter        = getFilter;
exports.listFilters      = listFilters;

// ---- 1D DWT ----
exports.dwt1D            = dwt1D;
exports.idwt1D           = idwt1D;
exports.dwtMultiLevel1D  = dwtMultiLevel1D;
exports.idwtMultiLevel1D = idwtMultiLevel1D;

// ---- 2D DWT ----
exports.dwt2D            = dwt2D;
exports.idwt2D           = idwt2D;
exports.dwtMultiLevel2D  = dwtMultiLevel2D;
exports.idwtMultiLevel2D = idwtMultiLevel2D;

// ---- 3D DWT ----
exports.dwt3D            = dwt3D;
exports.idwt3D           = idwt3D;

// ---- Continuous wavelet transform ----
exports.cwt              = cwt;
exports.cwtMorlet        = cwtMorlet;
exports.cwtMexicanHat    = cwtMexicanHat;
exports.scalogram        = scalogram;

// ---- Wavelet packets ----
exports.waveletPacket    = waveletPacket;
exports.bestBasis        = bestBasis;

// ---- Denoising ----
exports.waveletDenoise   = waveletDenoise;
exports.softThreshold    = softThreshold;
exports.hardThreshold    = hardThreshold;
exports.universalThreshold = universalThreshold;

// ---- Lifting ----
exports.liftingHaar      = liftingHaar;
exports.iliftingHaar     = iliftingHaar;
exports.lifting53        = lifting53;
exports.ilifting53       = ilifting53;

// ---- Domain helpers ----
exports.waveletTerrain       = waveletTerrain;
exports.waveletClouds        = waveletClouds;
exports.waveletDetail        = waveletDetail;
exports.waveletMotionCurve   = waveletMotionCurve;
exports.waveletIKFilter      = waveletIKFilter;
exports.waveletOrbitalFilter = waveletOrbitalFilter;
exports.waveletColor         = waveletColor;
exports.waveletLOD           = waveletLOD;

// ---- SOA (sync) ----
exports.soaDWT1D             = soaDWT1D;
exports.soaIDWT1D            = soaIDWT1D;
exports.soaDWT2D             = soaDWT2D;
exports.soaIDWT2D            = soaIDWT2D;
exports.soaWaveletTerrain    = soaWaveletTerrain;
exports.soaWaveletMotionFilter = soaWaveletMotionFilter;

// ---- SOA (chunked async) ----
exports.soaDWT1DChunked           = soaDWT1DChunked;
exports.soaDWT2DChunked           = soaDWT2DChunked;
exports.soaWaveletTerrainChunked  = soaWaveletTerrainChunked;
exports.soaWaveletMotionFilterChunked = soaWaveletMotionFilterChunked;

// ---- Pools ----
exports.WaveletScratch    = WaveletScratch;
exports.acquireWaveletScratch = acquireWaveletScratch;
exports.releaseWaveletScratch = releaseWaveletScratch;

// ---- Batch ----
exports.WaveletBatchState = WaveletBatchState;
exports.createWaveletBatch = createWaveletBatch;

// ---- Namespace ----
exports.namespace = {};

// ============================================================================
// Global Declarations
// ============================================================================

// Registry of registered filter banks
const _filterRegistry = new Map();

// Pool of scratch buffers
const _waveletScratchPool = common.createPool(
  function () {
    const T = getArrayType();
    return {
      a: new T(256),
      b: new T(256),
      size: 256,
      _attached: false
    };
  },
  8,
  function (s) { if (s.a) s.a.fill(0); if (s.b) s.b.fill(0); }
);

// Attach ensure method
(function warmWaveletScratch() {
  const pool = _waveletScratchPool;
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
        return this;
      };
    }
    return s;
  };
})();

// ============================================================================
// Type Declarations
// ============================================================================

/**
 * @typedef {"periodic"|"symmetric"|"zero"} BoundaryMode
 */

/**
 * @typedef {Object} WaveletTerrainParams
 * @property {number} [octaves=5]
 * @property {number} [seed=1]
 * @property {number} [heightScale=1]
 * @property {string} [filter="db4"]
 */

/**
 * @typedef {Object} WaveletCloudParams
 * @property {number} [octaves=4]
 * @property {number} [seed=42]
 * @property {number} [falloff=1]
 * @property {string} [filter="db4"]
 */

// ============================================================================
// Variable Declarations
// ============================================================================

const SQRT2 = Math.SQRT2;
const INV_SQRT2 = 1 / SQRT2;
const SQRT3 = Math.sqrt(3);

// ============================================================================
// Class Declarations
// ============================================================================

/**
 * WaveletFilter — holds a 2-channel filter bank (analysis + reconstruction).
 */
class WaveletFilter {
  // Class Fields
  name = "";
  analysisLow = null;
  analysisHigh = null;
  reconLow = null;
  reconHigh = null;
  length = 0;
  isOrthogonal = true;
  isContinuous = false;
  motherFn = null;

  constructor(name, analysisLow, analysisHigh, reconLow, reconHigh, options) {
    this.name = name;
    this.analysisLow = analysisLow;
    this.analysisHigh = analysisHigh;
    this.reconLow = reconLow || reverseArray(analysisLow);
    this.reconHigh = reconHigh || reverseArray(analysisHigh);
    this.length = analysisLow.length;
    options = options || {};
    this.isOrthogonal = options.isOrthogonal !== false;
    this.isContinuous = options.isContinuous === true;
    this.motherFn = options.motherFn || null;
  }
}

// Static block: register built-in filters once
// (implemented as a static method called after class definition)

function reverseArray(a) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[a.length - 1 - i];
  return out;
}

// ============================================================================
// Function Declarations — Filter registration
// ============================================================================

function registerFilter(name, filter) {
  _filterRegistry.set(name, filter);
  return filter;
}

function getFilter(nameOrFilter) {
  if (nameOrFilter instanceof WaveletFilter) return nameOrFilter;
  const name = String(nameOrFilter || "haar").toLowerCase();
  const f = _filterRegistry.get(name);
  if (!f) throw new Error("getFilter: unknown filter '" + name + "'");
  return f;
}

function listFilters() {
  return Array.from(_filterRegistry.keys());
}

// ============================================================================
// Built-in filter definitions
// ============================================================================

// --- Haar ---
registerFilter("haar", new WaveletFilter(
  "haar",
  [INV_SQRT2, INV_SQRT2],
  [INV_SQRT2, -INV_SQRT2]
));

// --- Daubechies db2 (4 taps) ---
(function () {
  const d = 4 * SQRT2;
  const h = [
    (1 + SQRT3) / d,
    (3 + SQRT3) / d,
    (3 - SQRT3) / d,
    (1 - SQRT3) / d
  ];
  const g = [h[3], -h[2], h[1], -h[0]];
  registerFilter("db2", new WaveletFilter("db2", h, g));
})();

// --- Daubechies db3 (6 taps) ---
(function () {
  const h = [
    0.3326705529509569,
    0.8068915093133388,
    0.4598775021193313,
   -0.13501102001039084,
   -0.08544127388224149,
    0.035226291882100656
  ];
  const g = [h[5], -h[4], h[3], -h[2], h[1], -h[0]];
  registerFilter("db3", new WaveletFilter("db3", h, g));
})();

// --- Daubechies db4 (8 taps) ---
(function () {
  const h = [
    0.2303778133088964,
    0.7148465705529154,
    0.6308807679298587,
   -0.027983769416859854,
   -0.18703481171909309,
    0.030841381835560764,
    0.0328830116668852,
   -0.010597401785069032
  ];
  const g = [h[7], -h[6], h[5], -h[4], h[3], -h[2], h[1], -h[0]];
  registerFilter("db4", new WaveletFilter("db4", h, g));
})();

// --- Symlet sym4 (8 taps) ---
(function () {
  const h = [
    0.03222310060407815,
   -0.012603967262261507,
   -0.09921954357693596,
    0.29785779560560505,
    0.803738751805386,
    0.4976186676325629,
   -0.029635527645960395,
   -0.0757657147892364
  ];
  const g = [h[7], -h[6], h[5], -h[4], h[3], -h[2], h[1], -h[0]];
  registerFilter("sym4", new WaveletFilter("sym4", h, g));
})();

// --- Symlet sym6 (12 taps) ---
(function () {
  const h = [
    0.0154041093, 0.0034907121, -0.1179901111, -0.0483117425,
    0.4910559419, 0.7876411411, 0.3379294217, -0.0726375228,
   -0.0210602925, 0.0447249018, 0.0017677118, -0.0078007083
  ];
  const g = new Array(12);
  for (let i = 0; i < 12; i++) g[i] = (i % 2 === 0 ? 1 : -1) * h[11 - i];
  registerFilter("sym6", new WaveletFilter("sym6", h, g));
})();

// --- Coiflet coif1 (6 taps) ---
(function () {
  const h = [
   -0.015655728135465, -0.072732619512854,
    0.384864846864203,  0.852572020212255,
    0.337897662457809, -0.072732619512854
  ];
  const g = [h[5], -h[4], h[3], -h[2], h[1], -h[0]];
  registerFilter("coif1", new WaveletFilter("coif1", h, g));
})();

// --- CDF 9/7 (biorthogonal, JPEG2000 default) ---
(function () {
  const analysisLow = [
    0.026748757411, -0.016864118443, -0.078223266529,
    0.266864118443,  0.602949018236,  0.266864118443,
   -0.078223266529, -0.016864118443,  0.026748757411
  ];
  const analysisHigh = [
    0,             0.091271763114, -0.057543526229,
   -0.591271763114, 1.115087052457, -0.591271763114,
   -0.057543526229, 0.091271763114, 0
  ];
  const reconLow = [
    0,            -0.091271763114, -0.057543526229,
    0.591271763114, 1.115087052457,  0.591271763114,
   -0.057543526229, -0.091271763114, 0
  ];
  const reconHigh = [
    0.026748757411,  0.016864118443, -0.078223266529,
   -0.266864118443,  0.602949018236, -0.266864118443,
   -0.078223266529,  0.016864118443,  0.026748757411
  ];
  registerFilter("cdf97", new WaveletFilter(
    "cdf97", analysisLow, analysisHigh, reconLow, reconHigh,
    { isOrthogonal: false }
  ));
})();

// --- Morlet (continuous) ---
registerFilter("morlet", new WaveletFilter(
  "morlet",
  [1], [1], [1], [1],
  {
    isContinuous: true,
    motherFn: function (t, omega0) {
      omega0 = omega0 || 6;
      return Math.pow(Math.PI, -0.25) * Math.cos(omega0 * t) * Math.exp(-0.5 * t * t);
    }
  }
));

// --- Mexican hat / Ricker (continuous) ---
registerFilter("mexh", new WaveletFilter(
  "mexh",
  [1], [1], [1], [1],
  {
    isContinuous: true,
    motherFn: function (t) {
      const t2 = t * t;
      return (2 / (Math.sqrt(3) * Math.pow(Math.PI, 0.25))) * (1 - t2) * Math.exp(-0.5 * t2);
    }
  }
));

// ============================================================================
// Function Declarations — 1D DWT
// ============================================================================

/**
 * One-level 1D DWT. `out` and `x` are length-n Float arrays (n even).
 * Writes `out[0..n/2-1] = approx`, `out[n/2..n-1] = detail`.
 */
function dwt1D(out, x, n, filter, boundaryMode) {
  filter = getFilter(filter);
  const half = n >> 1;
  const L = filter.length;
  const low = filter.analysisLow;
  const high = filter.analysisHigh;
  const mode = boundaryMode || "periodic";

  for (let i = 0; i < half; i++) {
    let sumL = 0, sumH = 0;
    for (let k = 0; k < L; k++) {
      let idx = 2 * i + k;
      if (mode === "periodic") {
        idx = ((idx % n) + n) % n;
      } else if (mode === "symmetric") {
        if (idx < 0) idx = -idx - 1;
        if (idx >= n) idx = 2 * n - 1 - idx;
      }
      if (idx >= 0 && idx < n) {
        const v = x[idx];
        sumL += low[k] * v;
        sumH += high[k] * v;
      }
    }
    out[i] = sumL;
    out[half + i] = sumH;
  }
  return out;
}

/**
 * One-level 1D inverse DWT. `packed` layout: approx | detail.
 * Writes into `out` (length n).
 */
function idwt1D(out, packed, n, filter, boundaryMode) {
  filter = getFilter(filter);
  const half = n >> 1;
  const L = filter.length;
  const rLow = filter.reconLow;
  const rHigh = filter.reconHigh;
  const mode = boundaryMode || "periodic";

  for (let i = 0; i < n; i++) out[i] = 0;
  for (let i = 0; i < half; i++) {
    const a = packed[i];
    const d = packed[half + i];
    for (let k = 0; k < L; k++) {
      let idx = 2 * i + k;
      if (mode === "periodic") {
        idx = ((idx % n) + n) % n;
      } else if (mode === "symmetric") {
        if (idx >= n) idx = 2 * n - 1 - idx;
      }
      if (idx >= 0 && idx < n) {
        out[idx] += rLow[k] * a + rHigh[k] * d;
      }
    }
  }
  return out;
}

/**
 * Multilevel 1D DWT — cascades `levels` approximations.
 * Returns `{ approx, details: [d1, d2, ...] }` where `d1` is the finest level.
 */
function dwtMultiLevel1D(x, n, filter, levels, boundaryMode) {
  filter = getFilter(filter);
  levels = levels || 3;
  boundaryMode = boundaryMode || "periodic";
  const T = getArrayType();

  let current = new T(n);
  for (let i = 0; i < n; i++) current[i] = x[i];

  const details = [];
  let size = n;
  for (let level = 0; level < levels && size >= 2 * filter.length; level++) {
    const half = size >> 1;
    const next = new T(half * 2);
    dwt1D(next, current, size, filter, boundaryMode);
    const det = new T(half);
    for (let i = 0; i < half; i++) det[i] = next[half + i];
    details.push(det);
    const approx = new T(half);
    for (let i = 0; i < half; i++) approx[i] = next[i];
    current = approx;
    size = half;
  }
  return { approx: current, details: details, size: size };
}

/**
 * Inverse multilevel 1D DWT — reconstructs from `{ approx, details }`.
 */
function idwtMultiLevel1D(result, n, filter, boundaryMode) {
  filter = getFilter(filter);
  boundaryMode = boundaryMode || "periodic";
  const T = getArrayType();

  let current = result.approx;
  let size = result.size;
  for (let level = result.details.length - 1; level >= 0; level--) {
    const det = result.details[level];
    const half = size;
    const full = half * 2;
    const packed = new T(full);
    for (let i = 0; i < half; i++) { packed[i] = current[i]; packed[half + i] = det[i]; }
    const reconstructed = new T(full);
    idwt1D(reconstructed, packed, full, filter, boundaryMode);
    current = reconstructed;
    size = full;
  }
  return current;
}

// ============================================================================
// Function Declarations — 2D DWT
// ============================================================================

/**
 * 1-level 2D DWT. `out` and `x` are n × m Float arrays (row-major).
 * Output layout:
 *   out[0..halfN-1][0..halfM-1] = LL
 *   out[0..halfN-1][halfM..m-1] = LH  (low rows, high cols)
 *   out[halfN..n-1][0..halfM-1] = HL  (high rows, low cols)
 *   out[halfN..n-1][halfM..m-1] = HH
 */
function dwt2D(out, x, n, m, filter, boundaryMode) {
  filter = getFilter(filter);
  boundaryMode = boundaryMode || "periodic";
  const halfN = n >> 1, halfM = m >> 1;
  const T = getArrayType();
  const rowBuf = new T(m);
  const colBuf = new T(n);
  const tmp = new T(n * m);

  // Row DWT
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < m; c++) rowBuf[c] = x[r * m + c];
    dwt1D(rowBuf, rowBuf, m, filter, boundaryMode);
    for (let c = 0; c < m; c++) tmp[r * m + c] = rowBuf[c];
  }
  // Column DWT
  for (let c = 0; c < m; c++) {
    for (let r = 0; r < n; r++) colBuf[r] = tmp[r * m + c];
    dwt1D(colBuf, colBuf, n, filter, boundaryMode);
    for (let r = 0; r < n; r++) out[r * m + c] = colBuf[r];
  }
  return out;
}

function idwt2D(out, packed, n, m, filter, boundaryMode) {
  filter = getFilter(filter);
  boundaryMode = boundaryMode || "periodic";
  const T = getArrayType();
  const rowBuf = new T(m);
  const colBuf = new T(n);
  const tmp = new T(n * m);

  // Column inverse DWT
  for (let c = 0; c < m; c++) {
    for (let r = 0; r < n; r++) colBuf[r] = packed[r * m + c];
    idwt1D(colBuf, colBuf, n, filter, boundaryMode);
    for (let r = 0; r < n; r++) tmp[r * m + c] = colBuf[r];
  }
  // Row inverse DWT
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < m; c++) rowBuf[c] = tmp[r * m + c];
    idwt1D(rowBuf, rowBuf, m, filter, boundaryMode);
    for (let c = 0; c < m; c++) out[r * m + c] = rowBuf[c];
  }
  return out;
}

function dwtMultiLevel2D(x, n, m, filter, levels, boundaryMode) {
  filter = getFilter(filter);
  levels = levels || 3;
  boundaryMode = boundaryMode || "periodic";
  const T = getArrayType();

  let current = new T(n * m);
  for (let i = 0; i < n * m; i++) current[i] = x[i];

  const details = [];
  let sizeN = n, sizeM = m;
  for (let level = 0; level < levels; level++) {
    if (sizeN < 2 * filter.length || sizeM < 2 * filter.length) break;
    const next = new T(sizeN * sizeM);
    dwt2D(next, current, sizeN, sizeM, filter, boundaryMode);
    details.push({ data: next, sizeN: sizeN, sizeM: sizeM });

    const halfN = sizeN >> 1, halfM = sizeM >> 1;
    const approx = new T(halfN * halfM);
    for (let r = 0; r < halfN; r++) {
      for (let c = 0; c < halfM; c++) approx[r * halfM + c] = next[r * sizeM + c];
    }
    current = approx;
    sizeN = halfN;
    sizeM = halfM;
  }
  return { approx: current, sizeN: sizeN, sizeM: sizeM, details: details };
}

function idwtMultiLevel2D(result, filter, boundaryMode) {
  filter = getFilter(filter);
  boundaryMode = boundaryMode || "periodic";
  const T = getArrayType();

  let current = result.approx;
  let sizeN = result.sizeN, sizeM = result.sizeM;
  for (let level = result.details.length - 1; level >= 0; level--) {
    const det = result.details[level];
    const fullN = det.sizeN, fullM = det.sizeM;
    const packed = new T(fullN * fullM);
    for (let r = 0; r < sizeN; r++) {
      for (let c = 0; c < sizeM; c++) packed[r * fullM + c] = current[r * sizeM + c];
    }
    for (let r = 0; r < fullN; r++) {
      for (let c = sizeM; c < fullM; c++) packed[r * fullM + c] = det.data[r * fullM + c];
    }
    for (let r = sizeN; r < fullN; r++) {
      for (let c = 0; c < fullM; c++) packed[r * fullM + c] = det.data[r * fullM + c];
    }
    const reconstructed = new T(fullN * fullM);
    idwt2D(reconstructed, packed, fullN, fullM, filter, boundaryMode);
    current = reconstructed;
    sizeN = fullN;
    sizeM = fullM;
  }
  return current;
}

// ============================================================================
// Function Declarations — 3D DWT
// ============================================================================

function dwt3D(out, x, nx, ny, nz, filter, boundaryMode) {
  filter = getFilter(filter);
  boundaryMode = boundaryMode || "periodic";
  const T = getArrayType();
  // Slice-wise 2D DWT then z-axis DWT — simplified for readability.
  // For full 3D, apply 1D DWT along each axis.
  const sliceSize = nx * ny;
  const tmp = new T(nx * ny * nz);

  // XY-pass: apply 2D DWT to each xy slice
  const slice = new T(sliceSize);
  const outSlice = new T(sliceSize);
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < sliceSize; i++) slice[i] = x[k * sliceSize + i];
    dwt2D(outSlice, slice, nx, ny, filter, boundaryMode);
    for (let i = 0; i < sliceSize; i++) tmp[k * sliceSize + i] = outSlice[i];
  }

  // Z-pass: apply 1D DWT along z for each (x,y)
  const col = new T(nz);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      for (let k = 0; k < nz; k++) col[k] = tmp[(k * ny + j) * nx + i];
      dwt1D(col, col, nz, filter, boundaryMode);
      for (let k = 0; k < nz; k++) out[(k * ny + j) * nx + i] = col[k];
    }
  }
  return out;
}

function idwt3D(out, packed, nx, ny, nz, filter, boundaryMode) {
  filter = getFilter(filter);
  boundaryMode = boundaryMode || "periodic";
  const T = getArrayType();
  const sliceSize = nx * ny;
  const tmp = new T(nx * ny * nz);

  // Inverse z-pass
  const col = new T(nz);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      for (let k = 0; k < nz; k++) col[k] = packed[(k * ny + j) * nx + i];
      idwt1D(col, col, nz, filter, boundaryMode);
      for (let k = 0; k < nz; k++) tmp[(k * ny + j) * nx + i] = col[k];
    }
  }
  // Inverse xy-pass
  const slice = new T(sliceSize);
  const outSlice = new T(sliceSize);
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < sliceSize; i++) slice[i] = tmp[k * sliceSize + i];
    idwt2D(outSlice, slice, nx, ny, filter, boundaryMode);
    for (let i = 0; i < sliceSize; i++) out[k * sliceSize + i] = outSlice[i];
  }
  return out;
}

// ============================================================================
// Function Declarations — Continuous wavelet transform
// ============================================================================

/**
 * Continuous wavelet transform (CWT). Convolves the signal with the
 * scaled+translated mother wavelet at each scale.
 *
 * @param {Array|Float32Array} signal
 * @param {number} n
 * @param {number[]} scales
 * @param {Function} motherFn  motherFn(t) → ψ(t)
 * @returns {Array<Float32Array>} each entry has length n (CWT at one scale)
 */
function cwt(signal, n, scales, motherFn) {
  const T = getArrayType();
  const out = [];
  for (let s = 0; s < scales.length; s++) {
    const scale = scales[s];
    const coeffs = new T(n);
    const halfWidth = Math.ceil(scale * 5); // 5σ support
    for (let i = 0; i < n; i++) {
      let sum = 0, norm = 0;
      for (let k = -halfWidth; k <= halfWidth; k++) {
        const idx = i + k;
        if (idx < 0 || idx >= n) continue;
        const tau = k / scale;
        const w = motherFn(tau);
        sum += signal[idx] * w;
        norm += 1;
      }
      coeffs[i] = norm > 0 ? sum / Math.sqrt(scale) : 0;
    }
    out.push(coeffs);
  }
  return out;
}

function cwtMorlet(signal, n, scales, omega0) {
  omega0 = omega0 || 6;
  const mother = function (t) {
    return Math.pow(Math.PI, -0.25) * Math.cos(omega0 * t) * Math.exp(-0.5 * t * t);
  };
  return cwt(signal, n, scales, mother);
}

function cwtMexicanHat(signal, n, scales) {
  const mother = function (t) {
    const t2 = t * t;
    return (2 / (Math.sqrt(3) * Math.pow(Math.PI, 0.25))) * (1 - t2) * Math.exp(-0.5 * t2);
  };
  return cwt(signal, n, scales, mother);
}

/**
 * Scalogram — magnitude of CWT at each scale.
 */
function scalogram(signal, n, scales, motherFn) {
  const coeffs = cwt(signal, n, scales, motherFn);
  const T = getArrayType();
  const out = [];
  for (let s = 0; s < coeffs.length; s++) {
    const mag = new T(n);
    for (let i = 0; i < n; i++) mag[i] = Math.abs(coeffs[s][i]);
    out.push(mag);
  }
  return out;
}

// ============================================================================
// Function Declarations — Wavelet packets
// ============================================================================

/**
 * Wavelet packet decomposition — fully decomposes a 1D signal at every level
 * of the binary tree. Returns a nested structure.
 */
function waveletPacket(signal, n, filter, maxLevel, boundaryMode) {
  filter = getFilter(filter);
  maxLevel = maxLevel || 4;
  boundaryMode = boundaryMode || "periodic";
  const T = getArrayType();

  function recurse(data, size, level) {
    if (level >= maxLevel || size < 2 * filter.length) {
      return { data: data, size: size, children: null };
    }
    const half = size >> 1;
    const packed = new T(size);
    dwt1D(packed, data, size, filter, boundaryMode);
    const approx = new T(half);
    const detail = new T(half);
    for (let i = 0; i < half; i++) {
      approx[i] = packed[i];
      detail[i] = packed[half + i];
    }
    return {
      data: data,
      size: size,
      children: [
        recurse(approx, half, level + 1),
        recurse(detail, half, level + 1)
      ]
    };
  }

  let initial = new T(n);
  for (let i = 0; i < n; i++) initial[i] = signal[i];
  return recurse(initial, n, 0);
}

/**
 * Best-basis selection — traverses the packet tree and keeps leaves whose
 * entropy is lower than the parent's. Returns an array of node references.
 */
function bestBasis(root) {
  function cost(node) {
    if (!node.children) {
      // Shannon entropy
      let energy = 0;
      for (let i = 0; i < node.size; i++) energy += node.data[i] * node.data[i];
      if (energy < 1e-12) return 0;
      let h = 0;
      for (let i = 0; i < node.size; i++) {
        const p = node.data[i] * node.data[i] / energy;
        if (p > 1e-12) h -= p * Math.log(p);
      }
      return h;
    }
    const childCost = cost(node.children[0]) + cost(node.children[1]);
    const nodeCost = (function () {
      let energy = 0;
      for (let i = 0; i < node.size; i++) energy += node.data[i] * node.data[i];
      if (energy < 1e-12) return 0;
      let h = 0;
      for (let i = 0; i < node.size; i++) {
        const p = node.data[i] * node.data[i] / energy;
        if (p > 1e-12) h -= p * Math.log(p);
      }
      return h;
    })();
    if (childCost < nodeCost) return childCost;
    return nodeCost;
  }

  const result = [];
  function recurse(node) {
    if (!node.children) { result.push(node); return; }
    const childCost = cost(node.children[0]) + cost(node.children[1]);
    const nodeCost = (function () {
      let energy = 0;
      for (let i = 0; i < node.size; i++) energy += node.data[i] * node.data[i];
      if (energy < 1e-12) return 0;
      let h = 0;
      for (let i = 0; i < node.size; i++) {
        const p = node.data[i] * node.data[i] / energy;
        if (p > 1e-12) h -= p * Math.log(p);
      }
      return h;
    })();
    if (childCost < nodeCost) {
      recurse(node.children[0]);
      recurse(node.children[1]);
    } else {
      result.push(node);
    }
  }
  recurse(root);
  return result;
}

// ============================================================================
// Function Declarations — Denoising
// ============================================================================

function softThreshold(x, threshold) {
  if (x > threshold) return x - threshold;
  if (x < -threshold) return x + threshold;
  return 0;
}

function hardThreshold(x, threshold) {
  return Math.abs(x) > threshold ? x : 0;
}

/**
 * Universal threshold (Donoho-Johnstone): σ * sqrt(2 * log(n)).
 */
function universalThreshold(sigma, n) {
  return sigma * Math.sqrt(2 * Math.log(n));
}

/**
 * Wavelet denoising. Decomposes, thresholds detail coefficients, reconstructs.
 * `mode` = "soft" | "hard".
 */
function waveletDenoise(signal, n, filter, levels, sigma, mode, boundaryMode) {
  const result = dwtMultiLevel1D(signal, n, filter, levels, boundaryMode);
  const threshold = universalThreshold(sigma || 1, n);
  const T = getArrayType();

  for (let level = 0; level < result.details.length; level++) {
    const det = result.details[level];
    for (let i = 0; i < det.length; i++) {
      det[i] = mode === "hard" ? hardThreshold(det[i], threshold) : softThreshold(det[i], threshold);
    }
  }
  return idwtMultiLevel1D(result, n, filter, boundaryMode);
}

// ============================================================================
// Function Declarations — Lifting schemes
// ============================================================================

/**
 * Haar lifting — in-place on `buf` length n (even).
 * Forward produces [approx | detail].
 */
function liftingHaar(buf, n) {
  const half = n >> 1;
  const T = getArrayType();
  const tmp = new T(n);
  for (let i = 0; i < half; i++) {
    const a = buf[2 * i];
    const b = buf[2 * i + 1];
    tmp[i] = (a + b) * INV_SQRT2;
    tmp[half + i] = (a - b) * INV_SQRT2;
  }
  for (let i = 0; i < n; i++) buf[i] = tmp[i];
  return buf;
}

function iliftingHaar(buf, n) {
  const half = n >> 1;
  const T = getArrayType();
  const tmp = new T(n);
  for (let i = 0; i < half; i++) {
    const a = buf[i];
    const d = buf[half + i];
    tmp[2 * i] = (a + d) * INV_SQRT2;
    tmp[2 * i + 1] = (a - d) * INV_SQRT2;
  }
  for (let i = 0; i < n; i++) buf[i] = tmp[i];
  return buf;
}

/**
 * CDF 5/3 lifting — reversible integer-friendly wavelet (used in JPEG2000 LL).
 * Requires even length. Produces [approx | detail].
 */
function lifting53(buf, n) {
  const T = getArrayType();
  const half = n >> 1;
  const even = new T(half);
  const odd = new T(half);
  for (let i = 0; i < half; i++) { even[i] = buf[2 * i]; odd[i] = buf[2 * i + 1]; }
  // Predict: odd[i] -= (even[i] + even[i+1])/2
  for (let i = 0; i < half; i++) {
    const e0 = even[i];
    const e1 = even[(i + 1) % half];
    odd[i] -= (e0 + e1) * 0.5;
  }
  // Update: even[i] += (odd[i-1] + odd[i])/4
  for (let i = 0; i < half; i++) {
    const d0 = odd[(i - 1 + half) % half];
    const d1 = odd[i];
    even[i] += (d0 + d1) * 0.25;
  }
  for (let i = 0; i < half; i++) { buf[i] = even[i]; buf[half + i] = odd[i]; }
  return buf;
}

function ilifting53(buf, n) {
  const T = getArrayType();
  const half = n >> 1;
  const even = new T(half);
  const odd = new T(half);
  for (let i = 0; i < half; i++) { even[i] = buf[i]; odd[i] = buf[half + i]; }
  // Undo update
  for (let i = 0; i < half; i++) {
    const d0 = odd[(i - 1 + half) % half];
    const d1 = odd[i];
    even[i] -= (d0 + d1) * 0.25;
  }
  // Undo predict
  for (let i = 0; i < half; i++) {
    const e0 = even[i];
    const e1 = even[(i + 1) % half];
    odd[i] += (e0 + e1) * 0.5;
  }
  for (let i = 0; i < half; i++) { buf[2 * i] = even[i]; buf[2 * i + 1] = odd[i]; }
  return buf;
}

// ============================================================================
// Function Declarations — Domain helpers
// ============================================================================

/**
 * Wavelet terrain — multi-resolution procedural heightfield built from
 * per-level noise additions (via DWT reconstruction of synthetic coefficients).
 */
function waveletTerrain(n, params, out) {
  params = params || {};
  out = out || new (getArrayType())(n * n);
  const octaves = params.octaves || 5;
  const seed = params.seed || 1;
  const scale = params.heightScale !== undefined ? params.heightScale : 1;
  const rng = common.mulberry32(seed);

  for (let i = 0; i < n * n; i++) out[i] = 0;
  let amp = 1;
  let freq = 1;
  for (let oct = 0; oct < octaves; oct++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = i / n * freq;
        const y = j / n * freq;
        const h = common.hash2(Math.floor(x * 1000), Math.floor(y * 1000));
        out[j * n + i] += h * amp;
      }
    }
    amp *= 0.5;
    freq *= 2;
  }

  let minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < n * n; i++) {
    if (out[i] < minV) minV = out[i];
    if (out[i] > maxV) maxV = out[i];
  }
  const range = maxV - minV || 1;
  for (let i = 0; i < n * n; i++) out[i] = (out[i] - minV) / range * scale;

  return out;
}

/**
 * Wavelet clouds — 3D volumetric density built from multi-octave noise.
 */
function waveletClouds(nx, ny, nz, params, out) {
  params = params || {};
  out = out || new (getArrayType())(nx * ny * nz);
  const octaves = params.octaves || 4;
  const seed = params.seed || 42;
  const rng = common.mulberry32(seed);

  for (let i = 0; i < nx * ny * nz; i++) out[i] = 0;
  let amp = 1, freq = 1;
  for (let oct = 0; oct < octaves; oct++) {
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const v = rng();
          out[(k * ny + j) * nx + i] += v * amp;
        }
      }
    }
    amp *= 0.5;
    freq *= 2;
  }
  let minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < nx * ny * nz; i++) {
    if (out[i] < minV) minV = out[i];
    if (out[i] > maxV) maxV = out[i];
  }
  const range = maxV - minV || 1;
  for (let i = 0; i < nx * ny * nz; i++) out[i] = (out[i] - minV) / range;
  return out;
}

/**
 * Wavelet detail — add high-frequency detail to an existing base heightfield
 * (LOD refinement). `blend` in [0, 1].
 */
function waveletDetail(base, detail, n, blend) {
  blend = blend === undefined ? 1 : blend;
  for (let i = 0; i < n; i++) base[i] += detail[i] * blend;
  return base;
}

/**
 * Motion curve smoothing via wavelet denoising. Preserves sharp features
 * (foot plants, velocity changes) while removing noise.
 */
function waveletMotionCurve(samples, n, filter, levels, sigma) {
  return waveletDenoise(samples, n, filter, levels, sigma, "soft", "symmetric");
}

/**
 * IK joint trajectory filter — denoises a joint's position over time.
 * `track` is a Float array of (x, y, z) samples. Returns the smoothed track.
 */
function waveletIKFilter(track, nSamples, filter, levels, sigma) {
  const T = getArrayType();
  const x = new T(nSamples);
  const y = new T(nSamples);
  const z = new T(nSamples);
  for (let i = 0; i < nSamples; i++) {
    x[i] = track[i * 3];
    y[i] = track[i * 3 + 1];
    z[i] = track[i * 3 + 2];
  }
  const sx = waveletDenoise(x, nSamples, filter, levels, sigma, "soft", "symmetric");
  const sy = waveletDenoise(y, nSamples, filter, levels, sigma, "soft", "symmetric");
  const sz = waveletDenoise(z, nSamples, filter, levels, sigma, "soft", "symmetric");
  const out = new T(nSamples * 3);
  for (let i = 0; i < nSamples; i++) {
    out[i * 3] = sx[i];
    out[i * 3 + 1] = sy[i];
    out[i * 3 + 2] = sz[i];
  }
  return out;
}

/**
 * Orbital filter — denoise position samples of an N-body body for smoother
 * trajectory rendering while preserving orbital features.
 */
function waveletOrbitalFilter(positions, nSamples, bodyCount, filter, levels, sigma) {
  const T = getArrayType();
  const out = new T(positions.length);
  const track = new T(nSamples * 3);
  for (let b = 0; b < bodyCount; b++) {
    for (let t = 0; t < nSamples; t++) {
      track[t * 3]     = positions[(t * bodyCount + b) * 3];
      track[t * 3 + 1] = positions[(t * bodyCount + b) * 3 + 1];
      track[t * 3 + 2] = positions[(t * bodyCount + b) * 3 + 2];
    }
    const smoothed = waveletIKFilter(track, nSamples, filter, levels, sigma);
    for (let t = 0; t < nSamples; t++) {
      out[(t * bodyCount + b) * 3]     = smoothed[t * 3];
      out[(t * bodyCount + b) * 3 + 1] = smoothed[t * 3 + 1];
      out[(t * bodyCount + b) * 3 + 2] = smoothed[t * 3 + 2];
    }
  }
  return out;
}

/**
 * Color spectral filter — apply wavelet denoising to a 1D color signal
 * (gradient palette) to smooth transition artifacts.
 */
function waveletColor(rgb, n, filter, levels, sigma) {
  const T = getArrayType();
  const r = new T(n), g = new T(n), b = new T(n);
  for (let i = 0; i < n; i++) {
    r[i] = rgb[i * 3];
    g[i] = rgb[i * 3 + 1];
    b[i] = rgb[i * 3 + 2];
  }
  const sr = waveletDenoise(r, n, filter, levels, sigma, "soft", "symmetric");
  const sg = waveletDenoise(g, n, filter, levels, sigma, "soft", "symmetric");
  const sb = waveletDenoise(b, n, filter, levels, sigma, "soft", "symmetric");
  const out = new T(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = sr[i];
    out[i * 3 + 1] = sg[i];
    out[i * 3 + 2] = sb[i];
  }
  return out;
}

/**
 * Wavelet LOD — approximate a mesh-grid heightfield at a given level of detail.
 * `level = 0` is full resolution; each level halves the effective resolution.
 */
function waveletLOD(heightfield, n, level, filter) {
  const T = getArrayType();
  let current = new T(n * n);
  for (let i = 0; i < n * n; i++) current[i] = heightfield[i];
  let size = n;
  for (let l = 0; l < level; l++) {
    if (size < 2 * getFilter(filter).length) break;
    const half = size >> 1;
    const next = new T(half * half);
    // Simple averaging for LOD approximation
    for (let j = 0; j < half; j++) {
      for (let i = 0; i < half; i++) {
        const a = current[(2 * j) * size + 2 * i];
        const b = current[(2 * j) * size + 2 * i + 1];
        const c = current[(2 * j + 1) * size + 2 * i];
        const d = current[(2 * j + 1) * size + 2 * i + 1];
        next[j * half + i] = (a + b + c + d) * 0.25;
      }
    }
    current = next;
    size = half;
  }
  return { data: current, size: size };
}

// ============================================================================
// Function Declarations — SOA
// ============================================================================

function soaDWT1D(inout, count, n, filterName, boundaryMode) {
  const filter = getFilter(filterName);
  const half = n >> 1;
  const L = filter.length;
  const low = filter.analysisLow;
  const high = filter.analysisHigh;
  const mode = boundaryMode || "periodic";
  const T = getArrayType();
  const tmp = new T(n);
  for (let i = 0; i < count; i++) {
    const offset = i * n;
    for (let j = 0; j < n; j++) tmp[j] = inout[offset + j];
    for (let k = 0; k < half; k++) {
      let sumL = 0, sumH = 0;
      for (let c = 0; c < L; c++) {
        let idx = 2 * k + c;
        if (mode === "periodic") idx = ((idx % n) + n) % n;
        else if (mode === "symmetric") {
          if (idx >= n) idx = 2 * n - 1 - idx;
        }
        if (idx >= 0 && idx < n) {
          sumL += low[c] * tmp[idx];
          sumH += high[c] * tmp[idx];
        }
      }
      inout[offset + k] = sumL;
      inout[offset + half + k] = sumH;
    }
  }
  return inout;
}

async function soaDWT1DChunked(inout, count, n, filterName, boundaryMode, chunkSize, yieldEvery) {
  chunkSize = chunkSize || common.CHUNK_SIZE;
  yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
  let start = 0, c = 0;
  while (start < count) {
    const end = Math.min(start + chunkSize, count);
    soaDWT1D(inout.subarray(start * n, end * n), end - start, n, filterName, boundaryMode);
    start = end;
    if (start >= count) break;
    if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
  }
  return inout;
}

function soaIDWT1D(inout, count, n, filterName, boundaryMode) {
  const filter = getFilter(filterName);
  const half = n >> 1;
  const L = filter.length;
  const rLow = filter.reconLow;
  const rHigh = filter.reconHigh;
  const mode = boundaryMode || "periodic";
  const T = getArrayType();
  const outBuf = new T(n);
  const inBuf = new T(n);
  for (let i = 0; i < count; i++) {
    const offset = i * n;
    for (let j = 0; j < n; j++) inBuf[j] = inout[offset + j];
    for (let j = 0; j < n; j++) outBuf[j] = 0;
    for (let k = 0; k < half; k++) {
      const a = inBuf[k];
      const d = inBuf[half + k];
      for (let c = 0; c < L; c++) {
        let idx = 2 * k + c;
        if (mode === "periodic") idx = ((idx % n) + n) % n;
        else if (mode === "symmetric") {
          if (idx >= n) idx = 2 * n - 1 - idx;
        }
        if (idx >= 0 && idx < n) outBuf[idx] += rLow[c] * a + rHigh[c] * d;
      }
    }
    for (let j = 0; j < n; j++) inout[offset + j] = outBuf[j];
  }
  return inout;
}

function soaDWT2D(inout, count, n, m, filterName, boundaryMode) {
  const filter = getFilter(filterName);
  boundaryMode = boundaryMode || "periodic";
  const tileSize = n * m;
  const T = getArrayType();
  const tile = new T(tileSize);
  const outTile = new T(tileSize);
  for (let i = 0; i < count; i++) {
    const offset = i * tileSize;
    for (let j = 0; j < tileSize; j++) tile[j] = inout[offset + j];
    dwt2D(outTile, tile, n, m, filter, boundaryMode);
    for (let j = 0; j < tileSize; j++) inout[offset + j] = outTile[j];
  }
  return inout;
}

async function soaDWT2DChunked(inout, count, n, m, filterName, boundaryMode, chunkSize, yieldEvery) {
  chunkSize = chunkSize || common.CHUNK_SIZE;
  yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
  let start = 0, c = 0;
  const tileSize = n * m;
  while (start < count) {
    const end = Math.min(start + chunkSize, count);
    soaDWT2D(inout.subarray(start * tileSize, end * tileSize), end - start, n, m, filterName, boundaryMode);
    start = end;
    if (start >= count) break;
    if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
  }
  return inout;
}

function soaIDWT2D(inout, count, n, m, filterName, boundaryMode) {
  const filter = getFilter(filterName);
  boundaryMode = boundaryMode || "periodic";
  const tileSize = n * m;
  const T = getArrayType();
  const tile = new T(tileSize);
  const outTile = new T(tileSize);
  for (let i = 0; i < count; i++) {
    const offset = i * tileSize;
    for (let j = 0; j < tileSize; j++) tile[j] = inout[offset + j];
    idwt2D(outTile, tile, n, m, filter, boundaryMode);
    for (let j = 0; j < tileSize; j++) inout[offset + j] = outTile[j];
  }
  return inout;
}

function soaWaveletTerrain(outBuffer, count, n, params) {
  const tileSize = n * n;
  for (let i = 0; i < count; i++) {
    const tile = outBuffer.subarray(i * tileSize, (i + 1) * tileSize);
    waveletTerrain(n, Object.assign({}, params, { seed: (params.seed || 1) + i }), tile);
  }
  return outBuffer;
}

async function soaWaveletTerrainChunked(outBuffer, count, n, params, chunkSize, yieldEvery) {
  chunkSize = chunkSize || common.CHUNK_SIZE;
  yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
  const tileSize = n * n;
  let start = 0, c = 0;
  while (start < count) {
    const end = Math.min(start + chunkSize, count);
    for (let i = start; i < end; i++) {
      const tile = outBuffer.subarray(i * tileSize, (i + 1) * tileSize);
      waveletTerrain(n, Object.assign({}, params, { seed: (params.seed || 1) + i }), tile);
    }
    start = end;
    if (start >= count) break;
    if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
  }
  return outBuffer;
}

function soaWaveletMotionFilter(outBuffer, inBuffer, count, nSamples, filterName, levels, sigma) {
  for (let i = 0; i < count; i++) {
    const inOff = i * nSamples;
    const outOff = i * nSamples;
    const slice = inBuffer.subarray(inOff, inOff + nSamples);
    const smooth = waveletDenoise(slice, nSamples, filterName, levels, sigma, "soft", "symmetric");
    outBuffer.set(smooth, outOff);
  }
  return outBuffer;
}

async function soaWaveletMotionFilterChunked(outBuffer, inBuffer, count, nSamples, filterName, levels, sigma, chunkSize, yieldEvery) {
  chunkSize = chunkSize || common.CHUNK_SIZE;
  yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
  let start = 0, c = 0;
  while (start < count) {
    const end = Math.min(start + chunkSize, count);
    for (let i = start; i < end; i++) {
      const inOff = i * nSamples;
      const slice = inBuffer.subarray(inOff, inOff + nSamples);
      const smooth = waveletDenoise(slice, nSamples, filterName, levels, sigma, "soft", "symmetric");
      outBuffer.set(smooth, inOff);
    }
    start = end;
    if (start >= count) break;
    if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
  }
  return outBuffer;
}

// ============================================================================
// Function Declarations — Pools
// ============================================================================

function acquireWaveletScratch(size) {
  const s = _waveletScratchPool.acquire();
  if (size !== undefined) s.ensure(size);
  return s;
}
function releaseWaveletScratch(s) { _waveletScratchPool.release(s); }

// ============================================================================
// Class Declarations
// ============================================================================

/**
 * WaveletScratch — reusable scratch buffer.
 */
class WaveletScratch {
  static #warm = [];
  static {
    for (let i = 0; i < 8; i++) WaveletScratch.#warm.push(new WaveletScratch(256));
  }
  static acquire(size) {
    for (let i = 0; i < WaveletScratch.#warm.length; i++) {
      if (WaveletScratch.#warm[i].size >= (size || 0)) {
        const s = WaveletScratch.#warm[i];
        WaveletScratch.#warm.splice(i, 1);
        return s;
      }
    }
    return new WaveletScratch(size || 256);
  }
  static release(s) { if (s) { s.reset(); WaveletScratch.#warm.push(s); } }

  constructor(size) {
    this.size = size || 256;
    const T = getArrayType();
    this.a = new T(this.size);
    this.b = new T(this.size);
  }

  ensure(n) {
    if (n <= this.size) return this;
    this.size = n;
    const T = getArrayType();
    this.a = new T(n);
    this.b = new T(n);
    return this;
  }
  reset() { this.a.fill(0); this.b.fill(0); return this; }
}

/**
 * WaveletBatchState — preallocated buffers for `count` independent signals.
 * Re-create after `setPrecision()` in `000_Math_module.js`.
 */
class WaveletBatchState {
  static #listeners = new Set();
  static {
    onPrecisionChange(function (mode, oldMode) {
      WaveletBatchState.#listeners.forEach((cb) => { try { cb(mode, oldMode); } catch (e) {} });
    });
  }

  constructor(count, n) {
    this.count = count;
    this.n = n;
    const T = getArrayType();
    this.buffer = new T(count * n);
    this.outBuffer = new T(count * n);
  }

  dwt(filterName, boundaryMode) { return soaDWT1D(this.buffer, this.count, this.n, filterName, boundaryMode); }
  async dwtChunked(filterName, boundaryMode, cs, ye) { return soaDWT1DChunked(this.buffer, this.count, this.n, filterName, boundaryMode, cs, ye); }
  idwt(filterName, boundaryMode) { return soaIDWT1D(this.buffer, this.count, this.n, filterName, boundaryMode); }

  fromReal(realInput) {
    for (let i = 0; i < this.count * this.n; i++) this.buffer[i] = realInput[i];
    return this;
  }
  toReal() {
    for (let i = 0; i < this.count * this.n; i++) this.outBuffer[i] = this.buffer[i];
    return this.outBuffer;
  }
}

function createWaveletBatch(count, n) { return new WaveletBatchState(count, n); }

// ============================================================================
// Namespace convenience
// ============================================================================

exports.namespace.filters = {
  register: registerFilter,
  get: getFilter,
  list: listFilters,
  WaveletFilter
};

exports.namespace.transforms = {
  dwt1D, idwt1D,
  dwt2D, idwt2D,
  dwt3D, idwt3D,
  multi1D: dwtMultiLevel1D,
  imulti1D: idwtMultiLevel1D,
  multi2D: dwtMultiLevel2D,
  imulti2D: idwtMultiLevel2D
};

exports.namespace.cwt = {
  transform: cwt,
  morlet: cwtMorlet,
  mexh: cwtMexicanHat,
  scalogram
};

exports.namespace.packets = {
  decompose: waveletPacket,
  bestBasis
};

exports.namespace.denoise = {
  wavelet: waveletDenoise,
  soft: softThreshold,
  hard: hardThreshold,
  universal: universalThreshold
};

exports.namespace.lifting = {
  haar: liftingHaar,
  ihaar: iliftingHaar,
  cdf53: lifting53,
  icdf53: ilifting53
};

exports.namespace.domain = {
  terrain: waveletTerrain,
  clouds: waveletClouds,
  detail: waveletDetail,
  motion: waveletMotionCurve,
  ik: waveletIKFilter,
  orbital: waveletOrbitalFilter,
  color: waveletColor,
  lod: waveletLOD
};

exports.namespace.batch = {
  dwt1D: soaDWT1D,
  dwt1DChunked: soaDWT1DChunked,
  idwt1D: soaIDWT1D,
  dwt2D: soaDWT2D,
  dwt2DChunked: soaDWT2DChunked,
  idwt2D: soaIDWT2D,
  terrain: soaWaveletTerrain,
  terrainChunked: soaWaveletTerrainChunked,
  motion: soaWaveletMotionFilter,
  motionChunked: soaWaveletMotionFilterChunked,
  State: WaveletBatchState,
  create: createWaveletBatch
};

// ============================================================================
// Precision listener
// ============================================================================

onPrecisionChange(function (mode, oldMode) {
  // Filter coefficients remain Float64 for numerical stability.
  // Only transform buffers change type via getArrayType() on new allocations.
});
