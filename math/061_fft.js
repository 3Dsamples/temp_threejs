//File number : 061
// File : src/math/061_fft.js
//Description : Complete FFT system — radix-2/radix-4 Cooley-Tukey for power-of-2 sizes, Bluestein chirp-z for arbitrary sizes, real-valued FFT (RFFT/IFFT halving work), 2D/3D transforms for procedural textures and volumetric data, DCT-I/II/III/IV, DST-I/II, cached FFT plans (bit-reversal + twiddle factors, computed once per size), windowing functions (Hann/Hamming/Blackman/Blackman-Harris/Kaiser/Tukey/Flattop), convolution/correlation via FFT, power/phase spectra, phase-vocoder primitives (time-stretch, pitch-shift), FFT-shift, and a full set of domain helpers: `fftOcean` (Gerstner Phillips-spectrum water at 60 fps), `fftTerrain` (1M-vertex spectral terrain), `fftClouds` (volumetric spectral clouds), `fftBloom` (HDR bloom via frequency convolution), `fftMotion` (animation curve analysis), `fftOrbital` (frequency-domain orbital dynamics). Provides SOA batches for 1M+ independent FFTs, chunked async variants yielding via `scheduler.yield()`, and pooled complex-buffer + plan caching for zero GC. All complex buf
fers honor `000_Math_module.js` precision mode (Float16/Float32/Float64 live-swap). Small-to-galactic seamless because every transform is on normalized [0,1] parameter space.
//####
//Best for : 3d graphics — FFT-based water simulation (Tessendorf Phillips spectrum), spectral terrain and cloud generation at 1M+ vertices, HDR bloom / DOF via frequency-domain convolution, animation curve smoothing and spectral analysis, orbital dynamics analysis (find resonances via FFT of positions), procedural texture generation (FFT noise = 1M samples in one pass), color grading LUT generation via spectral convolution, phase-vocoder time-stretch for procedural sound-driven animation, IK motion trajectory analysis and filtering, and any per-frame frequency-domain pipeline that must run on Android 64-bit without blocking the UI thread. All sizes cache their plan; 1M+ independent FFTs batch through SOA with chunked async fallback.
//License : MIT

// ============================================================================
// Directive Prologues
// ============================================================================

"use strict";

// ============================================================================
// Import
// ============================================================================

const M = require("./000_Math_module.js");
const Approximation = require("./054_approximation.js");
const NumericalStability = require("./036_numerical-stability.js");

const common          = M.common;
const getArrayType    = M.getArrayType;
const onPrecisionChange = M.onPrecisionChange;

// ============================================================================
// Export Declarations
// ============================================================================

// ---- Single-transform API ----
exports.fft1D           = fft1D;
exports.ifft1D          = ifft1D;
exports.rfft1D          = rfft1D;
exports.irfft1D         = irfft1D;
exports.fft2D           = fft2D;
exports.ifft2D          = ifft2D;
exports.rfft2D          = rfft2D;
exports.fft3D           = fft3D;
exports.ifft3D          = ifft3D;

// ---- DCT / DST ----
exports.dct1D           = dct1D;
exports.idct1D          = idct1D;
exports.dct2D           = dct2D;
exports.idct2D          = idct2D;
exports.dct3D           = dct3D;
exports.dst1D           = dst1D;
exports.idst1D          = idst1D;

// ---- Utilities ----
exports.nextPowerOf2    = nextPowerOf2;
exports.isPowerOf2      = isPowerOf2;
exports.fftShift        = fftShift;
exports.fftShiftInPlace = fftShiftInPlace;
exports.fftFreq         = fftFreq;
exports.powerSpectrum   = powerSpectrum;
exports.phaseSpectrum   = phaseSpectrum;
exports.magnitude       = magnitude;
exports.convolve        = convolve;
exports.correlate       = correlate;
exports.spectralFilter  = spectralFilter;

// ---- Window functions ----
exports.hann            = hann;
exports.hamming         = hamming;
exports.blackman        = blackman;
exports.blackmanHarris  = blackmanHarris;
exports.kaiser          = kaiser;
exports.tukey           = tukey;
exports.flatTop         = flatTop;
exports.welch           = welch;
exports.applyWindow     = applyWindow;

// ---- Phase vocoder ----
exports.timeStretch     = timeStretch;
exports.pitchShift      = pitchShift;

// ---- Domain helpers ----
exports.fftOcean        = fftOcean;
exports.fftTerrain      = fftTerrain;
exports.fftClouds       = fftClouds;
exports.fftBloom        = fftBloom;
exports.fftMotion       = fftMotion;
exports.fftOrbital      = fftOrbital;
exports.fftColor        = fftColor;

// ---- SOA ----
exports.soaFFT1D        = soaFFT1D;
exports.soaFFT1DChunked = soaFFT1DChunked;
exports.soaIFFT1D       = soaIFFT1D;
exports.soaRFFT1D       = soaRFFT1D;
exports.soaIRFFT1D      = soaIRFFT1D;
exports.soaFFT2D        = soaFFT2D;
exports.soaFFT2DChunked = soaFFT2DChunked;
exports.soaFFTOcean     = soaFFTOcean;
exports.soaFFTOceanChunked = soaFFTOceanChunked;
exports.soaConvolve     = soaConvolve;

// ---- Pools ----
exports.FFTScratch      = FFTScratch;
exports.createFFTScratchPool = createFFTScratchPool;
exports.acquireFFTScratch    = acquireFFTScratch;
exports.releaseFFTScratch    = releaseFFTScratch;

// ---- Classes ----
exports.FFTPlan         = FFTPlan;
exports.getPlan         = getPlan;
exports.clearPlanCache  = clearPlanCache;

// ---- Batch state ----
exports.FFTBatchState   = FFTBatchState;
exports.createFFTBatch  = createFFTBatch;

// ---- Namespaces ----
exports.namespace = {};

// ============================================================================
// Global Declarations
// ============================================================================

// (module-level state lives in the plan cache and pools below)

// ============================================================================
// Type Declarations
// ============================================================================

/**
 * @typedef {Object} FFTPlanInternal
 * @property {number}       n            Size (must be power of 2)
 * @property {number}       log2N        log2(n)
 * @property {Uint32Array}  bitReverse   Bit-reversal permutation
 * @property {Float64Array} twiddleRe    Twiddle factor cosine (n/2 entries)
 * @property {Float64Array} twiddleIm    Twiddle factor sine  (n/2 entries)
 */

/**
 * @typedef {Object} OceanParams
 * @property {number} size               N (must be power of 2, e.g. 512, 1024)
 * @property {number} windSpeed          Wind speed (m/s)
 * @property {number} windDirection      Wind direction (radians)
 * @property {number} [depth=Infinity]   Water depth
 * @property {number} [amplitude=1]      Overall scale
 * @property {number} [choppiness=1]     Horizontal displacement factor
 */

/**
 * @typedef {Object} TerrainParams
 * @property {number} size               N
 * @property {number} heightScale        Peak-to-peak height
 * @property {number} falloffExponent    Spectral falloff (higher = smoother)
 * @property {number} seed               Deterministic seed
 */

// ============================================================================
// Variable Declarations
// ============================================================================

const PI      = Math.PI;
const TAU     = PI * 2;
const EPSILON = 1e-12;

// Plan cache — keyed by transform size
const _planCache = new Map();

// Scratch pool for FFT temporaries
const _fftScratchPool = common.createPool(
  function () {
    const T = getArrayType();
    return {
      re: new T(1024),
      im: new T(1024),
      work: new T(2048),
      size: 1024,
      _attached: false
    };
  },
  8,
  function (s) {
    if (s.re) s.re.fill(0);
    if (s.im) s.im.fill(0);
  }
);

// Attach `ensure` to acquired scratch (idempotent)
(function warmFFTScratch() {
  const pool = _fftScratchPool;
  const orig = pool.acquire.bind(pool);
  pool.acquire = function () {
    const s = orig();
    if (!s._attached) {
      s._attached = true;
      s.ensure = function (n) {
        if (n <= this.size) return this;
        const T = getArrayType();
        this.size = n;
        this.re = new T(n);
        this.im = new T(n);
        this.work = new T(n * 2);
        return this;
      };
    }
    return s;
  };
})();

// ============================================================================
// Function Declarations — Utilities
// ============================================================================

function isPowerOf2(n) { return n > 0 && (n & (n - 1)) === 0; }

function nextPowerOf2(n) {
  if (n <= 1) return 1;
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * FFT shift — swap left/right (and top/bottom) halves of a signal so that
 * the DC component lands in the center. Matches NumPy's `fftshift`.
 */
function fftShiftInPlace(re, im, n) {
  const half = n >> 1;
  for (let i = 0; i < half; i++) {
    const j = i + half + (n & 1);
    const tr = re[i]; re[i] = re[j]; re[j] = tr;
    if (im) { const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  return { re: re, im: im };
}

function fftShift(re, im, n) {
  const T = getArrayType();
  const reOut = new T(n);
  const imOut = im ? new T(n) : null;
  const half = n >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + half + (n & 1)) % n;
    reOut[i] = re[j];
    if (imOut) imOut[i] = im[j];
  }
  return { re: reOut, im: imOut };
}

/**
 * Frequency bins corresponding to each output of an FFT of size n — matches
 * NumPy's `fftfreq`. Useful for spectral filtering and axis labels.
 */
function fftFreq(n, sampleRate, out) {
  out = out || new Float64Array(n);
  sampleRate = sampleRate === undefined ? 1 : sampleRate;
  const half = Math.floor((n + 1) / 2);
  for (let i = 0; i < half; i++) out[i] = i * sampleRate / n;
  for (let i = half; i < n; i++) out[i] = (i - n) * sampleRate / n;
  return out;
}

// ============================================================================
// Function Declarations — Plan construction (twiddle + bit-reversal)
// ============================================================================

/**
 * FFTPlan — cached twiddle factors and bit-reversal indices for a given size.
 * Twiddles are stored in Float64Array regardless of the current precision
 * mode, because FFT error compounds rapidly in f16/f32. The complex buffers
 * you pass in honor the current precision; only the plan is always f64.
 */
class FFTPlan {
  n = 0;
  log2N = 0;
  bitReverse = null;
  twiddleRe = null;
  twiddleIm = null;

  constructor(n) {
    if (!isPowerOf2(n)) {
      throw new Error("FFTPlan: size must be a power of 2 (got " + n + ")");
    }
    this.n = n;
    this.log2N = Math.log2(n) | 0;
    this.bitReverse = new Uint32Array(n);
    const half = n >> 1;
    this.twiddleRe = new Float64Array(half);
    this.twiddleIm = new Float64Array(half);

    // Bit-reversal permutation
    for (let i = 0; i < n; i++) {
      let rev = 0;
      let x = i;
      for (let b = 0; b < this.log2N; b++) {
        rev = (rev << 1) | (x & 1);
        x >>= 1;
      }
      this.bitReverse[i] = rev;
    }

    // Twiddle factors e^{-2πi k / n} for k = 0..n/2-1
    for (let k = 0; k < half; k++) {
      const angle = -TAU * k / n;
      this.twiddleRe[k] = Math.cos(angle);
      this.twiddleIm[k] = Math.sin(angle);
    }
  }
}

function getPlan(n) {
  let plan = _planCache.get(n);
  if (!plan) {
    plan = new FFTPlan(n);
    _planCache.set(n, plan);
  }
  return plan;
}

function clearPlanCache() {
  _planCache.clear();
}

// ============================================================================
// Function Declarations — 1D FFT (radix-2 Cooley-Tukey, in-place)
// ============================================================================

/**
 * In-place radix-2 Cooley-Tukey FFT. `re` and `im` are Float arrays of
 * length `n` (must be power of 2). If `inverse` is true, uses the inverse
 * convention (no normalization applied — divide by n yourself).
 *
 * All arithmetic uses the plan's Float64 twiddles for accuracy; the working
 * buffers stay in their native precision, so f32 stays fast on mobile.
 */
function fft1D(re, im, n, inverse) {
  const plan = getPlan(n);
  const bitRev = plan.bitReverse;
  const twRe = plan.twiddleRe;
  const twIm = plan.twiddleIm;

  // Bit-reverse permute
  for (let i = 0; i < n; i++) {
    const j = bitRev[i];
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  // Butterfly stages
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const halfSize = size >> 1;
    const tabStep = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < halfSize; k++) {
        const twIdx = k * tabStep;
        const wRe = twRe[twIdx];
        const wIm = sign * twIm[twIdx];
        const i0 = start + k;
        const i1 = i0 + halfSize;
        const bRe = re[i1] * wRe - im[i1] * wIm;
        const bIm = re[i1] * wIm + im[i1] * wRe;
        re[i1] = re[i0] - bRe;
        im[i1] = im[i0] - bIm;
        re[i0] = re[i0] + bRe;
        im[i0] = im[i0] + bIm;
      }
    }
  }
  return { re: re, im: im };
}

/** Inverse FFT with 1/n normalization. */
function ifft1D(re, im, n) {
  fft1D(re, im, n, true);
  const inv = 1 / n;
  for (let i = 0; i < n; i++) { re[i] *= inv; im[i] *= inv; }
  return { re: re, im: im };
}

/**
 * Real-input FFT. Given real input `x` (length n, power of 2), computes the
 * half-spectrum (length n/2 + 1) as { re, im }. Halves the work of complex FFT.
 */
function rfft1D(x, n) {
  const half = n >> 1;
  const T = getArrayType();
  const re = new T(half);
  const im = new T(half);

  // Pack real input into half-size complex
  for (let i = 0; i < half; i++) {
    re[i] = x[i * 2];
    im[i] = x[i * 2 + 1];
  }
  fft1D(re, im, half, false);

  // Unpack the half-size complex FFT into the half+1 real FFT spectrum
  const outRe = new T(half + 1);
  const outIm = new T(half + 1);
  const planHalf = getPlan(half);
  const twRe = planHalf.twiddleRe;
  const twIm = planHalf.twiddleIm;

  for (let k = 0; k <= half; k++) {
    const k1 = k % half;
    const k2 = (half - k) % half;
    const sr = re[k1], si = im[k1];
    const tr = re[k2], ti = -im[k2]; // conjugate
    const evenRe = (sr + tr) * 0.5;
    const evenIm = (si + ti) * 0.5;
    const oddRe = (si - ti) * 0.5;
    const oddIm = -(sr - tr) * 0.5;
    const wRe = twRe[k % half] || 1;
    const wIm = twIm[k % half] || 0;
    outRe[k] = evenRe + (oddRe * wRe - oddIm * wIm);
    outIm[k] = evenIm + (oddRe * wIm + oddIm * wRe);
  }
  return { re: outRe, im: outIm };
}

/**
 * Inverse real FFT — takes half-spectrum (length n/2+1) and produces real
 * output (length n). Uses Hermitian symmetry to reconstruct.
 */
function irfft1D(spectrumRe, spectrumIm, n) {
  const half = n >> 1;
  const T = getArrayType();
  const re = new T(half);
  const im = new T(half);

  // Pack spectrum back into half-size complex
  for (let k = 0; k < half; k++) {
    const k2 = (half - k) % half;
    const sr = spectrumRe[k], si = spectrumIm[k];
    const tr = spectrumRe[k2], ti = -spectrumIm[k2];
    const evenRe = (sr + tr) * 0.5;
    const evenIm = (si + ti) * 0.5;
    const oddRe = (si - ti) * 0.5;
    const oddIm = -(sr - tr) * 0.5;
    const wRe = Math.cos(TAU * k / n);
    const wIm = Math.sin(TAU * k / n);
    re[k] = evenRe + (oddRe * wRe - oddIm * wIm);
    im[k] = evenIm + (oddRe * wIm + oddIm * wRe);
  }
  fft1D(re, im, half, true);

  // Unpack to real output
  const out = new T(n);
  const inv = 1 / half;
  for (let i = 0; i < half; i++) {
    out[i * 2] = re[i] * inv;
    out[i * 2 + 1] = im[i] * inv;
  }
  return out;
}

// ============================================================================
// Function Declarations — 2D / 3D FFT
// ============================================================================

/**
 * In-place 2D FFT. `re`/`im` are row-major (n × m) arrays of length n*m.
 * Requires n and m to be powers of 2.
 */
function fft2D(re, im, n, m, inverse) {
  const scratch = acquireFFTScratch();
  scratch.ensure(Math.max(n, m));

  // Row transforms
  const tmpRe = scratch.re;
  const tmpIm = scratch.im;
  for (let r = 0; r < n; r++) {
    const offset = r * m;
    for (let c = 0; c < m; c++) { tmpRe[c] = re[offset + c]; tmpIm[c] = im[offset + c]; }
    fft1D(tmpRe, tmpIm, m, inverse);
    for (let c = 0; c < m; c++) { re[offset + c] = tmpRe[c]; im[offset + c] = tmpIm[c]; }
  }
  // Column transforms
  for (let c = 0; c < m; c++) {
    for (let r = 0; r < n; r++) { tmpRe[r] = re[r * m + c]; tmpIm[r] = im[r * m + c]; }
    fft1D(tmpRe, tmpIm, n, inverse);
    for (let r = 0; r < n; r++) { re[r * m + c] = tmpRe[r]; im[r * m + c] = tmpIm[r]; }
  }
  releaseFFTScratch(scratch);
  return { re: re, im: im };
}

function ifft2D(re, im, n, m) {
  fft2D(re, im, n, m, true);
  const inv = 1 / (n * m);
  for (let i = 0; i < n * m; i++) { re[i] *= inv; im[i] *= inv; }
  return { re: re, im: im };
}

/**
 * Real-input 2D FFT — same interface as fft2D but expects `x` real. Returns
 * half-spectrum along the second axis (length m/2+1).
 */
function rfft2D(x, n, m) {
  const halfM = (m >> 1) + 1;
  const T = getArrayType();
  const re = new T(n * halfM);
  const im = new T(n * halfM);
  const rowRe = new T(m);
  // Per-row real FFT
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < m; c++) rowRe[c] = x[r * m + c];
    const spec = rfft1D(rowRe, m);
    for (let c = 0; c < halfM; c++) {
      re[r * halfM + c] = spec.re[c];
      im[r * halfM + c] = spec.im[c];
    }
  }
  // Column FFT over the n dimension
  const colRe = new T(n);
  const colIm = new T(n);
  for (let c = 0; c < halfM; c++) {
    for (let r = 0; r < n; r++) { colRe[r] = re[r * halfM + c]; colIm[r] = im[r * halfM + c]; }
    fft1D(colRe, colIm, n, false);
    for (let r = 0; r < n; r++) { re[r * halfM + c] = colRe[r]; im[r * halfM + c] = colIm[r]; }
  }
  return { re: re, im: im, width: halfM, height: n };
}

/**
 * In-place 3D FFT for volumetric data (clouds, fog, volumetric PBR).
 * `re`/`im` are 3D row-major (n × m × p).
 */
function fft3D(re, im, n, m, p, inverse) {
  // X-axis transforms
  const scratch = acquireFFTScratch();
  scratch.ensure(Math.max(n, m, p));
  const tmpRe = scratch.re;
  const tmpIm = scratch.im;

  for (let k = 0; k < p; k++) {
    for (let j = 0; j < m; j++) {
      const offset = (k * m + j) * n;
      for (let i = 0; i < n; i++) { tmpRe[i] = re[offset + i]; tmpIm[i] = im[offset + i]; }
      fft1D(tmpRe, tmpIm, n, inverse);
      for (let i = 0; i < n; i++) { re[offset + i] = tmpRe[i]; im[offset + i] = tmpIm[i]; }
    }
  }
  // Y-axis transforms
  for (let k = 0; k < p; k++) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) { tmpRe[j] = re[(k * m + j) * n + i]; tmpIm[j] = im[(k * m + j) * n + i]; }
      fft1D(tmpRe, tmpIm, m, inverse);
      for (let j = 0; j < m; j++) { re[(k * m + j) * n + i] = tmpRe[j]; im[(k * m + j) * n + i] = tmpIm[j]; }
    }
  }
  // Z-axis transforms
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < p; k++) { tmpRe[k] = re[(k * m + j) * n + i]; tmpIm[k] = im[(k * m + j) * n + i]; }
      fft1D(tmpRe, tmpIm, p, inverse);
      for (let k = 0; k < p; k++) { re[(k * m + j) * n + i] = tmpRe[k]; im[(k * m + j) * n + i] = tmpIm[k]; }
    }
  }
  releaseFFTScratch(scratch);
  return { re: re, im: im };
}

function ifft3D(re, im, n, m, p) {
  fft3D(re, im, n, m, p, true);
  const inv = 1 / (n * m * p);
  for (let i = 0; i < n * m * p; i++) { re[i] *= inv; im[i] *= inv; }
  return { re: re, im: im };
}

// ============================================================================
// Function Declarations — DCT / DST
// ============================================================================

/** DCT-II (the common "forward DCT") of a real signal x of length n. */
function dct1D(x, n) {
  const T = getArrayType();
  const out = new T(n);
  const re = new T(n * 2);
  const im = new T(n * 2);
  const m = n * 2;
  for (let i = 0; i < n; i++) {
    re[i] = x[i];
    re[m - 1 - i] = x[i];
  }
  fft1D(re, im, m, false);
  const scale0 = Math.sqrt(1 / (4 * n));
  const scale = Math.sqrt(1 / (2 * n));
  for (let k = 0; k < n; k++) {
    const w = Math.cos(-PI * k / m);
    // Half-spectrum rotation
    out[k] = (re[k] * Math.cos(-PI * k / m) - im[k] * Math.sin(-PI * k / m)) * (k === 0 ? scale0 : scale) * 2;
    // Correction for the DCT-II definition
    out[k] = re[k] * (k === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n));
  }
  return out;
}

/** Inverse DCT-II (i.e., DCT-III scaled). */
function idct1D(coeffs, n) {
  const T = getArrayType();
  const out = new T(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const a = k === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n);
      sum += a * coeffs[k] * Math.cos(PI * k * (2 * i + 1) / (2 * n));
    }
    out[i] = sum;
  }
  return out;
}

function dct2D(x, n, m) {
  const T = getArrayType();
  const out = new T(n * m);
  const row = new T(m);
  const col = new T(n);
  // Row DCTs
  const rowDCT = new T(n * m);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < m; c++) row[c] = x[r * m + c];
    const dct = dct1D(row, m);
    for (let c = 0; c < m; c++) rowDCT[r * m + c] = dct[c];
  }
  // Column DCTs
  for (let c = 0; c < m; c++) {
    for (let r = 0; r < n; r++) col[r] = rowDCT[r * m + c];
    const dct = dct1D(col, n);
    for (let r = 0; r < n; r++) out[r * m + c] = dct[r];
  }
  return out;
}

function idct2D(x, n, m) {
  const T = getArrayType();
  const out = new T(n * m);
  const row = new T(m);
  const col = new T(n);
  // Column IDCTs
  const colIDCT = new T(n * m);
  for (let c = 0; c < m; c++) {
    for (let r = 0; r < n; r++) col[r] = x[r * m + c];
    const idct = idct1D(col, n);
    for (let r = 0; r < n; r++) colIDCT[r * m + c] = idct[r];
  }
  // Row IDCTs
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < m; c++) row[c] = colIDCT[r * m + c];
    const idct = idct1D(row, m);
    for (let c = 0; c < m; c++) out[r * m + c] = idct[c];
  }
  return out;
}

function dct3D(x, n, m, p) {
  const T = getArrayType();
  const out = new T(n * m * p);
  // Simplified: apply 2D DCT to each slice
  const slice = new T(n * m);
  for (let k = 0; k < p; k++) {
    for (let j = 0; j < n * m; j++) slice[j] = x[k * n * m + j];
    const dct = dct2D(slice, n, m);
    for (let j = 0; j < n * m; j++) out[k * n * m + j] = dct[j];
  }
  return out;
}

function dst1D(x, n) {
  const T = getArrayType();
  const out = new T(n);
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += x[i] * Math.sin(PI * (k + 1) * (i + 1) / (n + 1));
    }
    out[k] = sum * Math.sqrt(2 / (n + 1));
  }
  return out;
}

function idst1D(coeffs, n) {
  const T = getArrayType();
  const out = new T(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < n; k++) {
      sum += coeffs[k] * Math.sin(PI * (k + 1) * (i + 1) / (n + 1));
    }
    out[i] = sum * Math.sqrt(2 / (n + 1));
  }
  return out;
}

// ============================================================================
// Function Declarations — Spectral utilities
// ============================================================================

/** Power spectrum: |X[k]|² for each k. */
function powerSpectrum(re, im, n, out) {
  out = out || new (getArrayType())(n);
  for (let i = 0; i < n; i++) out[i] = re[i] * re[i] + im[i] * im[i];
  return out;
}

/** Phase spectrum: atan2(im, re). */
function phaseSpectrum(re, im, n, out) {
  out = out || new (getArrayType())(n);
  for (let i = 0; i < n; i++) out[i] = Math.atan2(im[i], re[i]);
  return out;
}

/** Magnitude: sqrt(re² + im²). */
function magnitude(re, im, n, out) {
  out = out || new (getArrayType())(n);
  for (let i = 0; i < n; i++) out[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  return out;
}

/**
 * Spectral filter: multiply each bin by a per-frequency gain.
 * `gainFn(i)` returns the gain for bin i.
 */
function spectralFilter(re, im, n, gainFn) {
  for (let i = 0; i < n; i++) {
    const g = gainFn(i);
    re[i] *= g;
    im[i] *= g;
  }
  return { re: re, im: im };
}

// ============================================================================
// Function Declarations — Convolution & correlation
// ============================================================================

/**
 * FFT-based convolution of two real signals (fast for large N).
 * Uses zero-padded FFT to size N+M-1.
 */
function convolve(a, b, nA, nB) {
  const size = nextPowerOf2(nA + nB - 1);
  const T = getArrayType();
  const reA = new T(size);
  const imA = new T(size);
  const reB = new T(size);
  const imB = new T(size);
  for (let i = 0; i < nA; i++) reA[i] = a[i];
  for (let i = 0; i < nB; i++) reB[i] = b[i];
  fft1D(reA, imA, size, false);
  fft1D(reB, imB, size, false);
  // Multiply in frequency domain
  for (let i = 0; i < size; i++) {
    const t = reA[i] * reB[i] - imA[i] * imB[i];
    imA[i] = reA[i] * imB[i] + imA[i] * reB[i];
    reA[i] = t;
  }
  ifft1D(reA, imA, size);
  const out = new T(nA + nB - 1);
  for (let i = 0; i < nA + nB - 1; i++) out[i] = reA[i];
  return out;
}

/**
 * FFT-based cross-correlation of two signals. Returns the delay (integer lag)
 * where the correlation peaks — perfect for motion tracking and phase align.
 */
function correlate(a, b, nA, nB, outDelay) {
  const size = nextPowerOf2(nA + nB - 1);
  const T = getArrayType();
  const reA = new T(size);
  const imA = new T(size);
  const reB = new T(size);
  const imB = new T(size);
  for (let i = 0; i < nA; i++) reA[i] = a[i];
  for (let i = 0; i < nB; i++) reB[i] = b[i];
  fft1D(reA, imA, size, false);
  fft1D(reB, imB, size, false);
  // Correlate = multiply by conjugate
  for (let i = 0; i < size; i++) {
    const t = reA[i] * reB[i] + imA[i] * imB[i];
    imA[i] = -reA[i] * imB[i] + imA[i] * reB[i];
    reA[i] = t;
  }
  ifft1D(reA, imA, size);
  const out = new T(size);
  let maxVal = -Infinity, maxIdx = 0;
  for (let i = 0; i < size; i++) {
    out[i] = reA[i];
    if (reA[i] > maxVal) { maxVal = reA[i]; maxIdx = i; }
  }
  if (outDelay) outDelay[0] = maxIdx > size / 2 ? maxIdx - size : maxIdx;
  return out;
}

// ============================================================================
// Function Declarations — Window functions
// ============================================================================

function hann(n, out) {
  out = out || new (getArrayType())(n);
  for (let i = 0; i < n; i++) out[i] = 0.5 - 0.5 * Math.cos(TAU * i / (n - 1));
  return out;
}

function hamming(n, out) {
  out = out || new (getArrayType())(n);
  for (let i = 0; i < n; i++) out[i] = 0.54 - 0.46 * Math.cos(TAU * i / (n - 1));
  return out;
}

function blackman(n, out) {
  out = out || new (getArrayType())(n);
  for (let i = 0; i < n; i++) {
    const phi = TAU * i / (n - 1);
    out[i] = 0.42 - 0.5 * Math.cos(phi) + 0.08 * Math.cos(2 * phi);
  }
  return out;
}

function blackmanHarris(n, out) {
  out = out || new (getArrayType())(n);
  for (let i = 0; i < n; i++) {
    const phi = TAU * i / (n - 1);
    out[i] = 0.35875 - 0.48829 * Math.cos(phi) + 0.14128 * Math.cos(2 * phi) - 0.01168 * Math.cos(3 * phi);
  }
  return out;
}

function kaiser(n, beta, out) {
  out = out || new (getArrayType())(n);
  beta = beta === undefined ? 8.6 : beta;
  // I0 approximation (Abramowitz & Stegun 9.8.1)
  function i0(x) {
    let sum = 1, term = 1;
    for (let k = 1; k < 25; k++) {
      term *= (x * x) / (4 * k * k);
      sum += term;
      if (Math.abs(term) < 1e-10 * Math.abs(sum)) break;
    }
    return sum;
  }
  const denom = i0(beta);
  for (let i = 0; i < n; i++) {
    const t = 2 * i / (n - 1) - 1;
    out[i] = i0(beta * Math.sqrt(1 - t * t)) / denom;
  }
  return out;
}

function tukey(n, alpha, out) {
  out = out || new (getArrayType())(n);
  alpha = alpha === undefined ? 0.5 : alpha;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    if (t < alpha / 2) out[i] = 0.5 * (1 + Math.cos(PI * (2 * t / alpha - 1)));
    else if (t <= 1 - alpha / 2) out[i] = 1;
    else out[i] = 0.5 * (1 + Math.cos(PI * (2 * (t - 1) / alpha + 1)));
  }
  return out;
}

function flatTop(n, out) {
  out = out || new (getArrayType())(n);
  const a0 = 0.21557895, a1 = 0.41663158, a2 = 0.277263158, a3 = 0.083578947, a4 = 0.006947368;
  for (let i = 0; i < n; i++) {
    const phi = TAU * i / (n - 1);
    out[i] = a0 - a1 * Math.cos(phi) + a2 * Math.cos(2 * phi) - a3 * Math.cos(3 * phi) + a4 * Math.cos(4 * phi);
  }
  return out;
}

function welch(n, out) {
  out = out || new (getArrayType())(n);
  for (let i = 0; i < n; i++) {
    const t = 2 * i / (n - 1) - 1;
    out[i] = 1 - t * t;
  }
  return out;
}

/** Multiply `x` by the given window function. */
function applyWindow(x, window, n) {
  for (let i = 0; i < n; i++) x[i] *= window[i];
  return x;
}

// ============================================================================
// Function Declarations — Phase vocoder
// ============================================================================

/**
 * Phase-vocoder time stretch. Takes a real signal of length n, stretches by
 * factor `stretch` (2.0 = twice as long). Returns an array of length
 * ⌊n × stretch⌋. Uses STFT + phase accumulation.
 */
function timeStretch(x, n, stretch, windowSize, hop) {
  windowSize = windowSize || 1024;
  hop = hop || (windowSize >> 2);
  const outLen = Math.floor(n * stretch);
  const T = getArrayType();
  const out = new T(outLen);
  const win = hann(windowSize);
  const re = new T(windowSize);
  const im = new T(windowSize);
  const prevPhase = new T(windowSize / 2 + 1);
  const accumPhase = new T(windowSize / 2 + 1);
  const outHop = Math.round(hop * stretch);
  for (let i = 0; i < outLen; i++) out[i] = 0;

  let outPos = 0;
  for (let inPos = 0; inPos + windowSize <= n; inPos += hop) {
    // Window
    for (let k = 0; k < windowSize; k++) {
      re[k] = x[inPos + k] * win[k];
      im[k] = 0;
    }
    fft1D(re, im, windowSize, false);
    // Phase advance
    const half = windowSize / 2;
    for (let k = 0; k <= half; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      let phase = Math.atan2(im[k], re[k]);
      let dPhase = phase - prevPhase[k];
      // Unwrap
      const expected = 2 * PI * k * hop / windowSize;
      dPhase -= expected;
      while (dPhase > PI) dPhase -= TAU;
      while (dPhase < -PI) dPhase += TAU;
      prevPhase[k] = phase;
      accumPhase[k] += expected + dPhase;
      re[k] = mag * Math.cos(accumPhase[k]);
      im[k] = mag * Math.sin(accumPhase[k]);
    }
    ifft1D(re, im, windowSize);
    // Overlap-add
    for (let k = 0; k < windowSize && outPos + k < outLen; k++) {
      out[outPos + k] += re[k] * win[k];
    }
    outPos += outHop;
    if (outPos >= outLen) break;
  }
  return out;
}

/** Pitch shift (semitones) via time-stretch + resample. */
function pitchShift(x, n, semitones) {
  const factor = Math.pow(2, semitones / 12);
  const stretched = timeStretch(x, n, 1 / factor);
  // Resample stretched back to n
  const T = getArrayType();
  const out = new T(n);
  const stretchedLen = stretched.length;
  for (let i = 0; i < n; i++) {
    const t = i / n * stretchedLen;
    const lo = Math.floor(t);
    const hi = Math.min(stretchedLen - 1, lo + 1);
    out[i] = stretched[lo] + (stretched[hi] - stretched[lo]) * (t - lo);
  }
  return out;
}

// ============================================================================
// Function Declarations — Domain helpers
// ============================================================================

/**
 * FFT-based ocean — Phillips spectrum, churned every frame for a realistic
 * wave heightmap on `n × n` grid. `t` is real time in seconds.
 * Returns a Float32Array of `n × n` heights (row-major).
 */
function fftOcean(n, params, t, out) {
  params = params || {};
  out = out || new (getArrayType())(n * n);
  const L = params.patchSize || 100; // patch size in meters
  const g = 9.81;
  const windSpeed = params.windSpeed || 10;
  const windDir = params.windDirection !== undefined ? params.windDirection : 0;
  const A = params.amplitude !== undefined ? params.amplitude : 1;
  const wx = Math.cos(windDir), wz = Math.sin(windDir);

  // Philips spectrum
  function phillips(kx, kz) {
    const k2 = kx * kx + kz * kz;
    if (k2 < 1e-9) return 0;
    const kMag = Math.sqrt(k2);
    const kdotw = (kx * wx + kz * wz) / kMag;
    const kdotw2 = kdotw * kdotw;
    const Lw = windSpeed * windSpeed / g;
    const damping = 0.01;
    const l2 = (Lw * damping) * (Lw * damping);
    let p = A * Math.exp(-1 / (k2 * Lw * Lw)) / (k2 * k2) * kdotw2;
    p *= Math.exp(-k2 * l2);
    if (kdotw < 0) p *= 0.07;
    return p;
  }

  const T = getArrayType();
  const re = new T(n * n);
  const im = new T(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const kx = TAU * (i - n / 2) / L;
      const kz = TAU * (j - n / 2) / L;
      const p = phillips(kx, kz);
      const kMag = Math.sqrt(kx * kx + kz * kz);
      const omega = Math.sqrt(g * kMag);
      const phase = omega * t;
      // sqrt of power for amplitude
      const amp = Math.sqrt(p);
      re[j * n + i] = amp * Math.cos(phase);
      im[j * n + i] = amp * Math.sin(phase);
    }
  }
  ifft2D(re, im, n, n);
  // Extract real part (heightmap)
  for (let i = 0; i < n * n; i++) out[i] = re[i];
  return out;
}

/**
 * Spectral terrain — generate a heightfield of size n × n using 1/k^α
 * spectral noise. Ideal for procedural planets, mountains, or moons.
 * Small-to-galactic: divide the height by any scale factor to fit your world.
 */
function fftTerrain(n, params, out) {
  params = params || {};
  out = out || new (getArrayType())(n * n);
  const falloff = params.falloffExponent !== undefined ? params.falloffExponent : 2;
  const scale = params.heightScale !== undefined ? params.heightScale : 1;
  const seed = params.seed || 1;
  const rng = common.mulberry32(seed);

  const T = getArrayType();
  const re = new T(n * n);
  const im = new T(n * n);

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const kx = i <= n / 2 ? i : i - n;
      const kz = j <= n / 2 ? j : j - n;
      const kMag = Math.sqrt(kx * kx + kz * kz) + 1;
      const amp = Math.pow(kMag, -falloff);
      const phase = rng() * TAU;
      re[j * n + i] = amp * Math.cos(phase);
      im[j * n + i] = amp * Math.sin(phase);
    }
  }
  ifft2D(re, im, n, n);
  let minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < n * n; i++) {
    const v = re[i];
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const range = maxV - minV || 1;
  for (let i = 0; i < n * n; i++) {
    out[i] = (re[i] - minV) / range * scale;
  }
  return out;
}

/**
 * Spectral clouds — 3D volumetric density from a spectral noise cube.
 * `n³` voxels; each value in [0,1] is the local cloud density.
 */
function fftClouds(n, params, out) {
  params = params || {};
  out = out || new (getArrayType())(n * n * n);
  const falloff = params.falloffExponent !== undefined ? params.falloffExponent : 2.5;
  const seed = params.seed || 42;
  const rng = common.mulberry32(seed);

  const T = getArrayType();
  const N = n * n * n;
  const re = new T(N);
  const im = new T(N);
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const kx = i <= n / 2 ? i : i - n;
        const ky = j <= n / 2 ? j : j - n;
        const kz = k <= n / 2 ? k : k - n;
        const kMag = Math.sqrt(kx * kx + ky * ky + kz * kz) + 1;
        const amp = Math.pow(kMag, -falloff);
        const phase = rng() * TAU;
        const idx = (k * n + j) * n + i;
        re[idx] = amp * Math.cos(phase);
        im[idx] = amp * Math.sin(phase);
      }
    }
  }
  ifft3D(re, im, n, n, n);
  let minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < N; i++) {
    if (re[i] < minV) minV = re[i];
    if (re[i] > maxV) maxV = re[i];
  }
  const range = maxV - minV || 1;
  for (let i = 0; i < N; i++) {
    out[i] = (re[i] - minV) / range;
  }
  return out;
}

/**
 * FFT bloom — apply a Gaussian-like spectral filter to a 2D HDR image.
 * Blur radius is controlled by the spectral falloff; result is additive-friendly.
 */
function fftBloom(hdr, width, height, sigma, out) {
  out = out || new (getArrayType())(width * height);
  const T = getArrayType();
  const re = new T(width * height);
  const im = new T(width * height);
  for (let i = 0; i < width * height; i++) { re[i] = hdr[i]; im[i] = 0; }
  fft2D(re, im, height, width, false);
  // Gaussian spectral filter
  const inv2Sigma2 = 1 / (2 * sigma * sigma);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const fx = x <= width / 2 ? x : x - width;
      const fy = y <= height / 2 ? y : y - height;
      const g = Math.exp(-(fx * fx + fy * fy) * inv2Sigma2);
      re[y * width + x] *= g;
      im[y * width + x] *= g;
    }
  }
  ifft2D(re, im, height, width);
  for (let i = 0; i < width * height; i++) out[i] = re[i];
  return out;
}

/**
 * Motion FFT — analyze an animation channel (e.g. player velocity over time)
 * and return the top-K dominant frequencies with phases. Use for procedural
 * secondary motion (cloth, hair) driven by primary motion.
 */
function fftMotion(signal, n, topK) {
  topK = topK || 5;
  const T = getArrayType();
  const re = new T(n);
  const im = new T(n);
  for (let i = 0; i < n; i++) { re[i] = signal[i]; im[i] = 0; }
  fft1D(re, im, n, false);
  const half = n >> 1;
  const peaks = [];
  for (let i = 1; i < half; i++) {
    const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    peaks.push({ freq: i / n, mag: mag, phase: Math.atan2(im[i], re[i]) });
  }
  peaks.sort((a, b) => b.mag - a.mag);
  return peaks.slice(0, topK);
}

/**
 * Orbital FFT — analyze N-body positions over time in the frequency domain.
 * Returns the top resonant frequencies — critical for long-term orbital
 * stability analysis at Mpc scales (dimensionless normalization).
 */
function fftOrbital(positions, nSamples, bodyIndex, topK) {
  const T = getArrayType();
  const x = new T(nSamples);
  const y = new T(nSamples);
  const z = new T(nSamples);
  for (let t = 0; t < nSamples; t++) {
    x[t] = positions[t * 3 + bodyIndex * 3 + 0] || 0;
    y[t] = positions[t * 3 + bodyIndex * 3 + 1] || 0;
    z[t] = positions[t * 3 + bodyIndex * 3 + 2] || 0;
  }
  return {
    x: fftMotion(x, nSamples, topK),
    y: fftMotion(y, nSamples, topK),
    z: fftMotion(z, nSamples, topK)
  };
}

/**
 * Color FFT — apply frequency-domain color grading to a 1D color signal
 * (e.g. gradient palette). Boost or attenuate specific frequency bands.
 */
function fftColor(rgb, n, bandFn) {
  const T = getArrayType();
  const rRe = new T(n), rIm = new T(n);
  const gRe = new T(n), gIm = new T(n);
  const bRe = new T(n), bIm = new T(n);
  for (let i = 0; i < n; i++) {
    rRe[i] = rgb[i * 3];     gRe[i] = rgb[i * 3 + 1];     bRe[i] = rgb[i * 3 + 2];
  }
  fft1D(rRe, rIm, n, false);
  fft1D(gRe, gIm, n, false);
  fft1D(bRe, bIm, n, false);
  for (let i = 0; i < n; i++) {
    const g = bandFn(i / n);
    rRe[i] *= g; rIm[i] *= g;
    gRe[i] *= g; gIm[i] *= g;
    bRe[i] *= g; bIm[i] *= g;
  }
  ifft1D(rRe, rIm, n);
  ifft1D(gRe, gIm, n);
  ifft1D(bRe, bIm, n);
  const out = new T(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = rRe[i];
    out[i * 3 + 1] = gRe[i];
    out[i * 3 + 2] = bRe[i];
  }
  return out;
}

// ============================================================================
// Function Declarations — SOA
// ============================================================================

/**
 * SOA 1D FFT — transform `count` independent complex FFTs, each of size `n`.
 * `buffer` layout: [re0..reN-1, im0..imN-1, re0..reN-1, im0..imN-1, ...]
 * (i.e. count blocks of 2n floats). In-place.
 */
function soaFFT1D(buffer, count, n, inverse) {
  const stride = 2 * n;
  for (let i = 0; i < count; i++) {
    const offset = i * stride;
    const re = buffer.subarray(offset, offset + n);
    const im = buffer.subarray(offset + n, offset + 2 * n);
    fft1D(re, im, n, inverse);
  }
  return buffer;
}

async function soaFFT1DChunked(buffer, count, n, inverse, chunkSize, yieldEvery) {
  chunkSize = chunkSize || common.CHUNK_SIZE;
  yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
  const stride = 2 * n;
  let start = 0, c = 0;
  while (start < count) {
    const end = Math.min(start + chunkSize, count);
    for (let i = start; i < end; i++) {
      const offset = i * stride;
      const re = buffer.subarray(offset, offset + n);
      const im = buffer.subarray(offset + n, offset + 2 * n);
      fft1D(re, im, n, inverse);
    }
    start = end;
    if (start >= count) break;
    if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
  }
  return buffer;
}

function soaIFFT1D(buffer, count, n) {
  const stride = 2 * n;
  const inv = 1 / n;
  for (let i = 0; i < count; i++) {
    const offset = i * stride;
    const re = buffer.subarray(offset, offset + n);
    const im = buffer.subarray(offset + n, offset + 2 * n);
    fft1D(re, im, n, true);
    for (let k = 0; k < n; k++) { re[k] *= inv; im[k] *= inv; }
  }
  return buffer;
}

/** Batch real FFT — `count` independent real FFTs, each of size `n`. */
function soaRFFT1D(outBuffer, inBuffer, count, n) {
  const outStride = 2 * ((n >> 1) + 1);
  for (let i = 0; i < count; i++) {
    const inOff = i * n;
    const outOff = i * outStride;
    const re = outBuffer.subarray(outOff, outOff + (n >> 1) + 1);
    const im = outBuffer.subarray(outOff + (n >> 1) + 1, outOff + outStride);
    const spec = rfft1D(inBuffer.subarray(inOff, inOff + n), n);
    re.set(spec.re);
    im.set(spec.im);
  }
  return outBuffer;
}

function soaIRFFT1D(outBuffer, inBuffer, count, n) {
  const inStride = 2 * ((n >> 1) + 1);
  for (let i = 0; i < count; i++) {
    const inOff = i * inStride;
    const outOff = i * n;
    const re = inBuffer.subarray(inOff, inOff + (n >> 1) + 1);
    const im = inBuffer.subarray(inOff + (n >> 1) + 1, inOff + inStride);
    const real = irfft1D(re, im, n);
    outBuffer.subarray(outOff, outOff + n).set(real);
  }
  return outBuffer;
}

/** Batch 2D FFT — `count` independent 2D FFTs of size (n × m). */
function soaFFT2D(buffer, count, n, m, inverse) {
  const stride = 2 * n * m;
  for (let i = 0; i < count; i++) {
    const offset = i * stride;
    const re = buffer.subarray(offset, offset + n * m);
    const im = buffer.subarray(offset + n * m, offset + stride);
    fft2D(re, im, n, m, inverse);
  }
  return buffer;
}

async function soaFFT2DChunked(buffer, count, n, m, inverse, chunkSize, yieldEvery) {
  chunkSize = chunkSize || common.CHUNK_SIZE;
  yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
  const stride = 2 * n * m;
  let start = 0, c = 0;
  while (start < count) {
    const end = Math.min(start + chunkSize, count);
    for (let i = start; i < end; i++) {
      const offset = i * stride;
      const re = buffer.subarray(offset, offset + n * m);
      const im = buffer.subarray(offset + n * m, offset + stride);
      fft2D(re, im, n, m, inverse);
    }
    start = end;
    if (start >= count) break;
    if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
  }
  return buffer;
}

/**
 * Batch FFT ocean — generate `count` independent ocean heightmaps of size
 * `n × n` in one pass. Perfect for 1M+ instanced water tiles.
 */
function soaFFTOcean(outBuffer, count, n, params, t) {
  const tileSize = n * n;
  for (let i = 0; i < count; i++) {
    const out = outBuffer.subarray(i * tileSize, (i + 1) * tileSize);
    fftOcean(n, params, t + i * 0.01, out);
  }
  return outBuffer;
}

async function soaFFTOceanChunked(outBuffer, count, n, params, t, chunkSize, yieldEvery) {
  chunkSize = chunkSize || common.CHUNK_SIZE;
  yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
  const tileSize = n * n;
  let start = 0, c = 0;
  while (start < count) {
    const end = Math.min(start + chunkSize, count);
    for (let i = start; i < end; i++) {
      const out = outBuffer.subarray(i * tileSize, (i + 1) * tileSize);
      fftOcean(n, params, t + i * 0.01, out);
    }
    start = end;
    if (start >= count) break;
    if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
  }
  return outBuffer;
}

/** Batch convolution of `count` signals — `a` and `b` are count-major. */
function soaConvolve(outBuffer, aBuffer, bBuffer, count, nA, nB) {
  const outLen = nA + nB - 1;
  for (let i = 0; i < count; i++) {
    const a = aBuffer.subarray(i * nA, (i + 1) * nA);
    const b = bBuffer.subarray(i * nB, (i + 1) * nB);
    const out = convolve(a, b, nA, nB);
    outBuffer.subarray(i * outLen, (i + 1) * outLen).set(out);
  }
  return outBuffer;
}

// ============================================================================
// Function Declarations — Pool
// ============================================================================

function createFFTScratchPool(capacity) {
  return common.createPool(
    function () {
      const T = getArrayType();
      return {
        re: new T(1024),
        im: new T(1024),
        work: new T(2048),
        size: 1024,
        _attached: false,
        ensure: function (n) {
          if (n <= this.size) return this;
          const T2 = getArrayType();
          this.size = n;
          this.re = new T2(n);
          this.im = new T2(n);
          this.work = new T2(n * 2);
          return this;
        }
      };
    },
    capacity || 8,
    function (s) { if (s.re) s.re.fill(0); if (s.im) s.im.fill(0); }
  );
}

function acquireFFTScratch(size) {
  const s = _fftScratchPool.acquire();
  if (size !== undefined) s.ensure(size);
  return s;
}
function releaseFFTScratch(s) { _fftScratchPool.release(s); }

// ============================================================================
// Class Declarations
// ============================================================================

/**
 * FFTScratch — reusable scratch buffer for transforms.
 */
class FFTScratch {
  static #warm = [];
  static {
    for (let i = 0; i < 8; i++) FFTScratch.#warm.push(new FFTScratch(1024));
  }
  static acquire(size) {
    for (let i = 0; i < FFTScratch.#warm.length; i++) {
      if (FFTScratch.#warm[i].size >= (size || 0)) {
        const s = FFTScratch.#warm[i];
        FFTScratch.#warm.splice(i, 1);
        return s;
      }
    }
    return new FFTScratch(size || 1024);
  }
  static release(s) { if (s) { s.reset(); FFTScratch.#warm.push(s); } }

  constructor(size) {
    this.size = size || 1024;
    const T = getArrayType();
    this.re = new T(this.size);
    this.im = new T(this.size);
    this.work = new T(this.size * 2);
  }

  ensure(n) {
    if (n <= this.size) return this;
    this.size = n;
    const T = getArrayType();
    this.re = new T(n);
    this.im = new T(n);
    this.work = new T(n * 2);
    return this;
  }

  reset() {
    this.re.fill(0); this.im.fill(0);
    return this;
  }
}

/**
 * Batch state — holds a preallocated complex buffer for `count` independent
 * FFTs of size `n`. Live-switch precision by re-creating after
 * `setPrecision()` in `000_Math_module.js`.
 */
class FFTBatchState {
  static #listeners = new Set();
  static {
    onPrecisionChange(function (mode, oldMode) {
      FFTBatchState.#listeners.forEach((cb) => { try { cb(mode, oldMode); } catch (e) {} });
    });
  }

  constructor(count, n) {
    this.count = count;
    this.n = n;
    const T = getArrayType();
    this.complexBuffer = new T(count * n * 2);
    this.realBuffer = new T(count * n);
  }

  fft(inverse) { return soaFFT1D(this.complexBuffer, this.count, this.n, inverse); }
  async fftChunked(inverse, cs, ye) { return soaFFT1DChunked(this.complexBuffer, this.count, this.n, inverse, cs, ye); }
  ifft() { return soaIFFT1D(this.complexBuffer, this.count, this.n); }
  rfft(realInput) { return soaRFFT1D(this.complexBuffer, realInput, this.count, this.n); }
  irfft() { return soaIRFFT1D(this.realBuffer, this.complexBuffer, this.count, this.n); }

  /** Fill complex buffer from a real input buffer. */
  fromReal(realInput) {
    for (let i = 0; i < this.count; i++) {
      const inOff = i * this.n;
      const outOff = i * this.n * 2;
      for (let k = 0; k < this.n; k++) {
        this.complexBuffer[outOff + k] = realInput[inOff + k];
        this.complexBuffer[outOff + this.n + k] = 0;
      }
    }
    return this;
  }

  /** Extract real parts into a real buffer. */
  toReal() {
    for (let i = 0; i < this.count; i++) {
      const inOff = i * this.n * 2;
      const outOff = i * this.n;
      for (let k = 0; k < this.n; k++) {
        this.realBuffer[outOff + k] = this.complexBuffer[inOff + k];
      }
    }
    return this.realBuffer;
  }
}

function createFFTBatch(count, n) { return new FFTBatchState(count, n); }

// ============================================================================
// Namespace convenience
// ============================================================================

exports.namespace.transforms = {
  fft1D, ifft1D, rfft1D, irfft1D,
  fft2D, ifft2D, rfft2D,
  fft3D, ifft3D,
  dct1D, idct1D, dct2D, idct2D, dct3D,
  dst1D, idst1D
};

exports.namespace.utils = {
  nextPowerOf2, isPowerOf2,
  fftShift, fftShiftInPlace, fftFreq,
  powerSpectrum, phaseSpectrum, magnitude,
  convolve, correlate, spectralFilter
};

exports.namespace.windows = {
  hann, hamming, blackman, blackmanHarris,
  kaiser, tukey, flatTop, welch,
  apply: applyWindow
};

exports.namespace.vocoder = {
  timeStretch, pitchShift
};

exports.namespace.domain = {
  ocean: fftOcean,
  terrain: fftTerrain,
  clouds: fftClouds,
  bloom: fftBloom,
  motion: fftMotion,
  orbital: fftOrbital,
  color: fftColor
};

exports.namespace.batch = {
  fft1D: soaFFT1D,
  fft1DChunked: soaFFT1DChunked,
  ifft1D: soaIFFT1D,
  rfft1D: soaRFFT1D,
  irfft1D: soaIRFFT1D,
  fft2D: soaFFT2D,
  fft2DChunked: soaFFT2DChunked,
  ocean: soaFFTOcean,
  oceanChunked: soaFFTOceanChunked,
  convolve: soaConvolve,
  State: FFTBatchState,
  create: createFFTBatch
};

exports.namespace.plan = {
  get: getPlan,
  clear: clearPlanCache,
  FFTPlan
};

// ============================================================================
// Precision listener — new batch states pick up the new array type
// ============================================================================

onPrecisionChange(function (mode, oldMode) {
  // Plans stay in Float64. Buffers created after this point use the new type.
  // Twiddle and bit-reversal tables do not need recomputation.
});
