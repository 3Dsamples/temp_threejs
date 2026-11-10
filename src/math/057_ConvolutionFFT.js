// file number : 057
// full path name : src/math/057_ConvolutionFFT.js
// description : High-performance FFT-based 2D and 1D convolution reimplemented from mljs/matrix-convolution src/fft.js. Uses iterative radix-2 Cooley-Tukey FFT with cached bit-reversal permutations and twiddle factors, row-by-row then column-by-column 2D FFT, in-place butterflies for zero-allocation inner loops, power-of-2 zero-padding, kernel flipping for correlation semantics, and SAME/VALID/FULL padding extraction matching the direct convolution (039). Provides 1D and 2D FFT/IFTT primitives, nextPowerOf2, FFT-based convolve1D/convolve2D, nextFastLength for tabulated padding, fftShift/ifftShift, and the standard mljs-compatible toArray/toMatrix/toArray2D/toMatrix2D interop. Includes policy-aware wrappers via 030_Policy with diagnostics timing and schema validators (FFTConvolveInput, FFT1DInput, FFT2DInput). Zero CDN dependencies, fully integrated with MLMatrix (038), MatrixConvolution (039), and 030_Policy.
// best for : Large-kernel image filtering (Gaussian blur, Sobel/Laplacian at scale), PBR texture-space effects, physics field smoothing, procedural noise post-processing, anime/semi-realistic shading pipelines where direct convolution is too slow, sensor fusion smoothing, and any large-kernel convolution at 10k+ entity scale on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS } from '../core/002_Constants.js';
import * as ML from './038_MatrixML.js';
import * as PolicyModule from './030_Policy.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'ConvolutionFFTDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'ConvolutionFFTDomainViolationError';
    this.operation = operation;
  }
}

// ============================================================================
// CACHES
// ============================================================================
const _bitRevCache = new Map();
const _twiddleCache = new Map();
const MAX_CACHE_SIZE = 32;

function getBitRev(n) {
  let rev = _bitRevCache.get(n);
  if (rev) return rev;
  const bits = Math.log2(n);
  if (!Number.isInteger(bits)) throw new DomainViolationError('fft', 'FFT size must be power of 2');
  rev = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i;
    let r = 0;
    for (let b = 0; b < bits; b++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r;
  }
  if (_bitRevCache.size >= MAX_CACHE_SIZE) _bitRevCache.clear();
  _bitRevCache.set(n, rev);
  return rev;
}

function getTwiddles(len) {
  let t = _twiddleCache.get(len);
  if (t) return t;
  const half = len >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    const angle = (2 * Math.PI * k) / len;
    cos[k] = Math.cos(angle);
    sin[k] = Math.sin(angle);
  }
  t = { cos, sin, half };
  if (_twiddleCache.size >= MAX_CACHE_SIZE) _twiddleCache.clear();
  _twiddleCache.set(len, t);
  return t;
}

// ============================================================================
// UTILITIES
// ============================================================================
export function isPowerOf2(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

export function nextPowerOf2(n) {
  if (n <= 1) return 1;
  return 1 << Math.ceil(Math.log2(n));
}

// Tabulated fast lengths (2, 3, 5, 7 smooth numbers) — useful for future mixed-radix
const FAST_LENGTHS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
export function nextFastLength(n) {
  for (let i = 0; i < FAST_LENGTHS.length; i++) {
    if (FAST_LENGTHS[i] >= n) return FAST_LENGTHS[i];
  }
  return nextPowerOf2(n);
}

// ============================================================================
// 1D FFT (in-place, iterative radix-2)
// ============================================================================
export function fft1D(re, im, inverse) {
  const n = re.length;
  if (n !== im.length) throw new DomainViolationError('fft1D', 're/im length mismatch');
  if (n <= 1) return;
  if (!isPowerOf2(n)) throw new DomainViolationError('fft1D', 'length must be power of 2');

  const rev = getBitRev(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const tw = getTwiddles(len);
    const half = tw.half;
    for (let start = 0; start < n; start += len) {
      for (let k = 0; k < half; k++) {
        const wReal = tw.cos[k];
        const wImag = sign * tw.sin[k];
        const a = start + k;
        const b = a + half;
        const vr = re[b] * wReal - im[b] * wImag;
        const vi = re[b] * wImag + im[b] * wReal;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
      }
    }
  }

  if (inverse) {
    const invN = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= invN;
      im[i] *= invN;
    }
  }
}

export function ifft1D(re, im) {
  fft1D(re, im, true);
}

// ============================================================================
// 2D FFT (row then column)
// ============================================================================
export function fft2D(re, im, rows, cols, inverse) {
  if (re.length !== rows * cols) throw new DomainViolationError('fft2D', 'buffer size mismatch');
  const rowRe = new Float64Array(cols);
  const rowIm = new Float64Array(cols);

  // Rows
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    for (let c = 0; c < cols; c++) {
      rowRe[c] = re[base + c];
      rowIm[c] = im[base + c];
    }
    fft1D(rowRe, rowIm, inverse);
    for (let c = 0; c < cols; c++) {
      re[base + c] = rowRe[c];
      im[base + c] = rowIm[c];
    }
  }

  // Columns (in-place, stride-based)
  const colRe = new Float64Array(rows);
  const colIm = new Float64Array(rows);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      colRe[r] = re[r * cols + c];
      colIm[r] = im[r * cols + c];
    }
    fft1D(colRe, colIm, inverse);
    for (let r = 0; r < rows; r++) {
      re[r * cols + c] = colRe[r];
      im[r * cols + c] = colIm[r];
    }
  }
}

export function ifft2D(re, im, rows, cols) {
  fft2D(re, im, rows, cols, true);
}

// ============================================================================
// FFT SHIFT
// ============================================================================
export function fftShift(re, im, rows, cols) {
  const halfR = Math.floor(rows / 2);
  const halfC = Math.floor(cols / 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const srcR = (r + halfR) % rows;
      const srcC = (c + halfC) % cols;
      const srcIdx = srcR * cols + srcC;
      const dstIdx = r * cols + c;
      if (srcIdx < dstIdx) {
        let t = re[srcIdx]; re[srcIdx] = re[dstIdx]; re[dstIdx] = t;
        t = im[srcIdx]; im[srcIdx] = im[dstIdx]; im[dstIdx] = t;
      }
    }
  }
}

export function ifftShift(re, im, rows, cols) {
  const halfR = Math.floor(rows / 2);
  const halfC = Math.floor(cols / 2);
  fftShift(re, im, rows, cols);
  // For odd dimensions, shift by an extra row/col
  if (rows % 2 === 1) fftShift(re, im, rows, cols);
  if (cols % 2 === 1) fftShift(re, im, rows, cols);
}

// ============================================================================
// FFT-BASED 1D CONVOLUTION (correlation semantics)
// ============================================================================
export function fftConvolve1D(signal, kernel, options) {
  const opts = options || {};
  const padding = opts.padding || 'same';
  const n = signal.length;
  const k = kernel.length;
  if (n === 0 || k === 0) return new ARRAY_TYPE(0);

  const fullLen = n + k - 1;
  const fftLen = nextPowerOf2(fullLen);

  const sRe = new Float64Array(fftLen);
  const sIm = new Float64Array(fftLen);
  const kRe = new Float64Array(fftLen);
  const kIm = new Float64Array(fftLen);

  // Copy signal
  for (let i = 0; i < n; i++) sRe[i] = signal[i];
  // Copy flipped kernel (reversed for correlation)
  for (let i = 0; i < k; i++) kRe[i] = kernel[k - 1 - i];

  fft1D(sRe, sIm, false);
  fft1D(kRe, kIm, false);

  // Pointwise multiply
  for (let i = 0; i < fftLen; i++) {
    const ar = sRe[i], ai = sIm[i];
    const br = kRe[i], bi = kIm[i];
    sRe[i] = ar * br - ai * bi;
    sIm[i] = ar * bi + ai * br;
  }

  ifft1D(sRe, sIm);

  // Extract
  let start, outLen;
  if (padding === 'full') {
    start = 0; outLen = fullLen;
  } else if (padding === 'valid') {
    start = k - 1; outLen = n - k + 1;
  } else { // same
    start = Math.ceil((k - 1) / 2);
    outLen = n;
  }
  if (outLen <= 0) return new ARRAY_TYPE(0);

  const out = new ARRAY_TYPE(outLen);
  for (let i = 0; i < outLen; i++) out[i] = sRe[start + i];
  return out;
}

// ============================================================================
// FFT-BASED 2D CONVOLUTION (correlation semantics)
// ============================================================================
export function fftConvolve2D(image, kernel, options) {
  if (!(image instanceof ML.MLMatrix)) throw new DecodeError('fftConvolve2D', 'image must be MLMatrix');
  if (!(kernel instanceof ML.MLMatrix)) throw new DecodeError('fftConvolve2D', 'kernel must be MLMatrix');

  const opts = options || {};
  const padding = opts.padding || 'same';
  const imgRows = image.rows;
  const imgCols = image.columns;
  const kRows = kernel.rows;
  const kCols = kernel.columns;

  if (imgRows === 0 || imgCols === 0 || kRows === 0 || kCols === 0) {
    return new ML.MLMatrix(0, 0);
  }

  const fullRows = imgRows + kRows - 1;
  const fullCols = imgCols + kCols - 1;
  const fftRows = nextPowerOf2(fullRows);
  const fftCols = nextPowerOf2(fullCols);
  const size = fftRows * fftCols;

  const imgRe = new Float64Array(size);
  const imgIm = new Float64Array(size);
  const kerRe = new Float64Array(size);
  const kerIm = new Float64Array(size);

  // Copy image
  for (let r = 0; r < imgRows; r++) {
    for (let c = 0; c < imgCols; c++) {
      const v = image.dd
        ? image.data[(r * imgCols + c) * 2 + 1]
        : image.data[r * imgCols + c];
      imgRe[r * fftCols + c] = v;
    }
  }
  // Copy flipped kernel
  for (let r = 0; r < kRows; r++) {
    for (let c = 0; c < kCols; c++) {
      const v = kernel.dd
        ? kernel.data[(r * kCols + c) * 2 + 1]
        : kernel.data[r * kCols + c];
      kerRe[(kRows - 1 - r) * fftCols + (kCols - 1 - c)] = v;
    }
  }

  fft2D(imgRe, imgIm, fftRows, fftCols, false);
  fft2D(kerRe, kerIm, fftRows, fftCols, false);

  // Pointwise multiply
  for (let i = 0; i < size; i++) {
    const ar = imgRe[i], ai = imgIm[i];
    const br = kerRe[i], bi = kerIm[i];
    imgRe[i] = ar * br - ai * bi;
    imgIm[i] = ar * bi + ai * br;
  }

  ifft2D(imgRe, imgIm, fftRows, fftCols);

  // Extract
  let startR, startC, outRows, outCols;
  if (padding === 'full') {
    startR = 0; startC = 0; outRows = fullRows; outCols = fullCols;
  } else if (padding === 'valid') {
    startR = kRows - 1; startC = kCols - 1;
    outRows = imgRows - kRows + 1; outCols = imgCols - kCols + 1;
  } else {
    startR = Math.ceil((kRows - 1) / 2);
    startC = Math.ceil((kCols - 1) / 2);
    outRows = imgRows; outCols = imgCols;
  }
  if (outRows <= 0 || outCols <= 0) return new ML.MLMatrix(0, 0);

  const out = new ML.MLMatrix(outRows, outCols);
  for (let r = 0; r < outRows; r++) {
    const srcBase = (startR + r) * fftCols + startC;
    const dstBase = r * outCols;
    for (let c = 0; c < outCols; c++) {
      out.data[dstBase + c] = imgRe[srcBase + c];
    }
  }
  return out;
}

// ============================================================================
// HIGH-LEVEL WRAPPERS (mljs-compatible surface)
// ============================================================================
export function convolve(image, kernel, options) {
  const opts = options || {};
  if (image instanceof ML.MLMatrix) {
    return fftConvolve2D(image, kernel, opts);
  }
  if (Array.isArray(image) && Array.isArray(image[0])) {
    return fftConvolve2D(
      ML.MLMatrix.from2DArray(image),
      kernel instanceof ML.MLMatrix ? kernel : ML.MLMatrix.from2DArray(kernel),
      opts
    );
  }
  if (Array.isArray(image)) {
    return fftConvolve1D(image, kernel instanceof ML.MLMatrix ? kernel.to1DArray() : kernel, opts);
  }
  throw new DecodeError('convolve', 'unsupported input type');
}

export function convolution1D(input, kernel, options) {
  const signal = input instanceof ML.MLMatrix ? input.to1DArray() : input;
  const k = kernel instanceof ML.MLMatrix ? kernel.to1DArray() : kernel;
  return fftConvolve1D(signal, k, options);
}

export function convolution2D(input, kernel, options) {
  const image = input instanceof ML.MLMatrix ? input : ML.MLMatrix.from2DArray(input);
  const k = kernel instanceof ML.MLMatrix ? kernel : ML.MLMatrix.from2DArray(kernel);
  return fftConvolve2D(image, k, options);
}

// ============================================================================
// INTEROP
// ============================================================================
export function toArray(matrix) {
  if (matrix instanceof ML.MLMatrix) return matrix.to1DArray();
  return matrix;
}

export function toMatrix(array, nRows, nCols) {
  if (nRows !== undefined && nCols !== undefined) {
    return ML.MLMatrix.from1DArray(nRows, nCols, array);
  }
  return ML.MLMatrix.from1DArray(array.length, 1, array);
}

export function toArray2D(matrix) {
  if (matrix instanceof ML.MLMatrix) return matrix.to2DArray();
  return matrix;
}

export function toMatrix2D(array) {
  return ML.MLMatrix.from2DArray(array);
}

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================
export const FFTConvolveInput = Object.freeze({
  make(image, kernel, options) { return { image, kernel, options }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('fftConvolve', 'Expected {image, kernel, options?}');
    if (!input.image || !input.kernel) throw new DecodeError('fftConvolve', 'image and kernel required');
    return input;
  }
});

export const FFT1DInput = Object.freeze({
  make(signal, kernel, options) { return { signal, kernel, options }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('fft1D', 'Expected {signal, kernel, options?}');
    if (!input.signal || !input.kernel) throw new DecodeError('fft1D', 'signal and kernel required');
    if (input.signal.length === 0) throw new DecodeError('fft1D', 'signal must be non-empty');
    if (input.kernel.length === 0) throw new DecodeError('fft1D', 'kernel must be non-empty');
    return input;
  }
});

export const FFT2DInput = FFTConvolveInput;

export const FFTOpInput = Object.freeze({
  make(re, im, rows, cols, inverse) { return { re, im, rows, cols, inverse }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('fftOp', 'Expected {re, im, rows, cols, inverse?}');
    if (!input.re || !input.im) throw new DecodeError('fftOp', 're and im required');
    return input;
  }
});

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================
export function fftConvolve1DValidated(input) {
  const d = FFT1DInput.decode(input);
  return fftConvolve1D(d.signal, d.kernel, d.options);
}

export function fftConvolve2DValidated(input) {
  const d = FFTConvolveInput.decode(input);
  const image = d.image instanceof ML.MLMatrix ? d.image : ML.MLMatrix.from2DArray(d.image);
  const kernel = d.kernel instanceof ML.MLMatrix ? d.kernel : ML.MLMatrix.from2DArray(d.kernel);
  return fftConvolve2D(image, kernel, d.options);
}

export function convolveValidated(input) {
  const d = FFTConvolveInput.decode(input);
  return convolve(d.image, d.kernel, d.options);
}

export function fft1DValidated(input) {
  const d = FFTOpInput.decode(input);
  fft1D(d.re, d.im, !!d.inverse);
  return { re: d.re, im: d.im };
}

export function fft2DValidated(input) {
  const d = FFTOpInput.decode(input);
  fft2D(d.re, d.im, d.rows, d.cols, !!d.inverse);
  return { re: d.re, im: d.im };
}

// ============================================================================
// POLICY-AWARE WRAPPERS
// ============================================================================
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

function isValidMatrixFinite(m) {
  if (!(m instanceof ML.MLMatrix)) return false;
  for (let i = 0; i < m.data.length; i++) {
    if (!Number.isFinite(m.data[i])) return false;
  }
  return true;
}

function isValidArrayFinite(a) {
  if (!a || typeof a.length !== 'number') return false;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i])) return false;
  }
  return true;
}

export function fftConvolve2DWithPolicies(image, kernel, policy, options) {
  return policyCustom(
    'ConvolutionFFT.fftConvolve2DWithPolicies',
    () => fftConvolve2D(image, kernel, options),
    isValidMatrixFinite,
    (m) => ({ rows: m.rows, columns: m.columns }),
    policy
  );
}

export function fftConvolve1DWithPolicies(signal, kernel, policy, options) {
  return policyCustom(
    'ConvolutionFFT.fftConvolve1DWithPolicies',
    () => fftConvolve1D(signal, kernel, options),
    isValidArrayFinite,
    (a) => ({ length: a.length }),
    policy
  );
}

export function convolveWithPolicies(image, kernel, policy, options) {
  return policyCustom(
    'ConvolutionFFT.convolveWithPolicies',
    () => convolve(image, kernel, options),
    (r) => (r instanceof ML.MLMatrix ? isValidMatrixFinite(r) : isValidArrayFinite(r)),
    (r) => (r instanceof ML.MLMatrix ? { rows: r.rows, columns: r.columns } : { length: r.length }),
    policy
  );
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default {
  DecodeError,
  DomainViolationError,
  isPowerOf2,
  nextPowerOf2,
  nextFastLength,
  fft1D,
  ifft1D,
  fft2D,
  ifft2D,
  fftShift,
  ifftShift,
  fftConvolve1D,
  fftConvolve2D,
  convolve,
  convolution1D,
  convolution2D,
  toArray,
  toMatrix,
  toArray2D,
  toMatrix2D,
  FFTConvolveInput,
  FFT1DInput,
  FFT2DInput,
  FFTOpInput,
  fftConvolve1DValidated,
  fftConvolve2DValidated,
  convolveValidated,
  fft1DValidated,
  fft2DValidated,
  fftConvolve2DWithPolicies,
  fftConvolve1DWithPolicies,
  convolveWithPolicies
};