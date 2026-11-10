// file number : 058
// full path name : src/math/058_ConvolutionUtil.js
// description : High-performance convolution utility module reimplemented from mljs/matrix-convolution src/util.js. Provides the full kernel and interop toolkit for the convolution stack: matrix2Array/array2Matrix/toMatrix/toArray for MLMatrix interop, createArray/createMatrix factory helpers, Gaussian kernel generator (1D separable and 2D isotropic), Laplacian of Gaussian (LoG) with configurable sigma and truncation, Difference of Gaussians (DoG) for band-pass filtering, box (mean) kernels, Sobel/Prewitt/Scharr gradients (X and Y), Laplacian edge kernels (4-connected and 8-connected), sharpen, emboss, unsharp-mask built from Gaussian, identity, and a unified `kernelFactory(name, options)` dispatcher. Includes `normalizeKernel(kernel, mode)` with sum-to-one (smoothing), sum-to-zero (edge), L1 (gradient), and L2 (unit Frobenius) modes, plus separability check and separable-Gaussian application helpers. All kernels produced as MLMatrix (038) for consistent API across the stack, with optional DoubleDouble precision, policy-aware wrappers via 030_Policy with diagnostics timing, and schema validators (KernelInput, LoGInput, GaussianInput, NormalizeInput, KernelFactoryInput). Designed to work seamlessly with 039_MatrixConvolution (direct) and 057_ConvolutionFFT (FFT).
// best for : PBR texture-space filters (blur, sharpen, edge, emboss), anime/semi-realistic outline extraction via LoG/DoG, physics field smoothing, procedural noise post-processing, sensor fusion smoothing, AI feature extraction, and any kernel-driven pipeline at 10k+ entity scale on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS } from '../core/002_Constants.js';
import * as DD from './014_DoubleDouble.js';
import * as ML from './038_MatrixML.js';
import * as PolicyModule from './030_Policy.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'ConvolutionUtilDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'ConvolutionUtilDomainViolationError';
    this.operation = operation;
  }
}

// ============================================================================
// HELPERS
// ============================================================================
function checkPositiveInt(n, op, name) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new DecodeError(op, name + ' must be a positive integer');
  }
}

function checkPositive(n, op, name) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
    throw new DecodeError(op, name + ' must be a positive finite number');
  }
}

function isMatrixOrMatrixLike(m) {
  return m instanceof ML.MLMatrix || (m && typeof m === 'object' && typeof m.toMatrix === 'function');
}

// ============================================================================
// MATRIX ↔ ARRAY INTEROP
// ============================================================================
export function matrix2Array(matrix) {
  if (!matrix) throw new DecodeError('matrix2Array', 'matrix required');
  if (matrix instanceof ML.MLMatrix) return matrix.to1DArray();
  if (typeof matrix.toMatrix === 'function') return matrix.toMatrix().to1DArray();
  if (Array.isArray(matrix)) {
    if (Array.isArray(matrix[0])) {
      const flat = [];
      for (let r = 0; r < matrix.length; r++) {
        for (let c = 0; c < matrix[r].length; c++) flat.push(matrix[r][c]);
      }
      return flat;
    }
    return matrix.slice();
  }
  throw new DecodeError('matrix2Array', 'unsupported matrix type');
}

export function array2Matrix(array, rows, cols, dd) {
  if (!array || typeof array.length !== 'number') {
    throw new DecodeError('array2Matrix', 'array required');
  }
  if (rows !== undefined && cols !== undefined) {
    if (rows * cols !== array.length) {
      throw new DecodeError('array2Matrix', 'rows*cols must equal array.length');
    }
    return ML.MLMatrix.from1DArray(rows, cols, array, dd);
  }
  return ML.MLMatrix.from1DArray(array.length, 1, array, dd);
}

export function toMatrix(array, rows, cols) {
  return array2Matrix(array, rows, cols);
}

export function toArray(matrix) {
  return matrix2Array(matrix);
}

export function toMatrix2D(array2D, dd) {
  if (!Array.isArray(array2D) || array2D.length === 0) {
    throw new DecodeError('toMatrix2D', 'non-empty 2D array required');
  }
  return ML.MLMatrix.from2DArray(array2D, dd);
}

export function toArray2D(matrix) {
  if (!(matrix instanceof ML.MLMatrix)) {
    if (isMatrixOrMatrixLike(matrix)) return matrix.toMatrix().to2DArray();
    throw new DecodeError('toArray2D', 'MLMatrix required');
  }
  return matrix.to2DArray();
}

// ============================================================================
// FACTORY HELPERS
// ============================================================================
export function createArray(rows, cols) {
  checkPositiveInt(rows, 'createArray', 'rows');
  checkPositiveInt(cols, 'createArray', 'cols');
  const out = new Array(rows);
  for (let r = 0; r < rows; r++) {
    const row = new Array(cols);
    for (let c = 0; c < cols; c++) row[c] = 0;
    out[r] = row;
  }
  return out;
}

export function createMatrix(rows, cols, dd) {
  checkPositiveInt(rows, 'createMatrix', 'rows');
  checkPositiveInt(cols, 'createMatrix', 'cols');
  return new ML.MLMatrix(rows, cols, { dd: !!dd, initial: 0 });
}

// ============================================================================
// GAUSSIAN KERNELS
// ============================================================================
export function gaussianKernel1D(sigma, truncate) {
  checkPositive(sigma, 'gaussianKernel1D', 'sigma');
  const t = truncate === undefined ? 3 : truncate;
  const radius = Math.max(1, Math.ceil(t * sigma));
  const n = 2 * radius + 1;
  const out = new ARRAY_TYPE(n);
  const twoSigmaSq = 2 * sigma * sigma;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - radius;
    const v = Math.exp(-(x * x) / twoSigmaSq);
    out[i] = v;
    sum += v;
  }
  const inv = sum > 0 ? 1 / sum : 0;
  for (let i = 0; i < n; i++) out[i] *= inv;
  return out;
}

export function gaussianKernel2D(sigma, truncate, dd) {
  checkPositive(sigma, 'gaussianKernel2D', 'sigma');
  const t = truncate === undefined ? 3 : truncate;
  const radius = Math.max(1, Math.ceil(t * sigma));
  const n = 2 * radius + 1;
  const out = new ML.MLMatrix(n, n, { dd: !!dd });
  const twoSigmaSq = 2 * sigma * sigma;
  let sum = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const dx = r - radius;
      const dy = c - radius;
      const v = Math.exp(-(dx * dx + dy * dy) / twoSigmaSq);
      if (out.dd) {
        out.data[(r * n + c) * 2 + 1] = v;
      } else {
        out.data[r * n + c] = v;
      }
      sum += v;
    }
  }
  if (sum > 0) {
    const inv = 1 / sum;
    const total = out.rows * out.columns;
    if (out.dd) {
      for (let i = 0; i < total; i++) out.data[i * 2 + 1] *= inv;
    } else {
      for (let i = 0; i < total; i++) out.data[i] *= inv;
    }
  }
  return out;
}

export function gaussianKernelSeparable(sigma, truncate) {
  const k1d = gaussianKernel1D(sigma, truncate);
  const n = k1d.length;
  const outer = new ML.MLMatrix(n, n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      outer.data[r * n + c] = k1d[r] * k1d[c];
    }
  }
  return { k1d, kernel2D: outer };
}

// ============================================================================
// LAPLACIAN OF GAUSSIAN (LoG)
// ============================================================================
export function createLoG(size, sigma) {
  checkPositiveInt(size, 'createLoG', 'size');
  if (size % 2 === 0) {
    throw new DomainViolationError('createLoG', 'size must be odd');
  }
  checkPositive(sigma, 'createLoG', 'sigma');
  const half = (size - 1) >> 1;
  const out = new ML.MLMatrix(size, size);
  const sigma2 = sigma * sigma;
  const sigma4 = sigma2 * sigma2;
  let sum = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const x = r - half;
      const y = c - half;
      const r2 = x * x + y * y;
      // LoG(x,y) = -(1/(π σ^4)) * (1 - r²/(2σ²)) * exp(-r²/(2σ²))
      const v = -(1 / (Math.PI * sigma4)) * (1 - r2 / (2 * sigma2)) * Math.exp(-r2 / (2 * sigma2));
      out.data[r * size + c] = v;
      sum += v;
    }
  }
  // Sum-to-zero correction for edge detection
  if (Math.abs(sum) > EPSILON) {
    const corr = sum / (size * size);
    for (let i = 0; i < size * size; i++) out.data[i] -= corr;
  }
  return out;
}

// ============================================================================
// DIFFERENCE OF GAUSSIANS (DoG)
// ============================================================================
export function createDoG(size, sigma1, sigma2) {
  checkPositiveInt(size, 'createDoG', 'size');
  if (size % 2 === 0) {
    throw new DomainViolationError('createDoG', 'size must be odd');
  }
  checkPositive(sigma1, 'createDoG', 'sigma1');
  checkPositive(sigma2, 'createDoG', 'sigma2');
  const half = (size - 1) >> 1;
  const out = new ML.MLMatrix(size, size);
  const s1sq = 2 * sigma1 * sigma1;
  const s2sq = 2 * sigma2 * sigma2;
  const c1 = 1 / (Math.PI * s1sq);
  const c2 = 1 / (Math.PI * s2sq);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const x = r - half;
      const y = c - half;
      const r2 = x * x + y * y;
      const g1 = c1 * Math.exp(-r2 / s1sq);
      const g2 = c2 * Math.exp(-r2 / s2sq);
      out.data[r * size + c] = g1 - g2;
    }
  }
  return out;
}

// ============================================================================
// BOX / MEAN
// ============================================================================
export function createBoxKernel(size) {
  checkPositiveInt(size, 'createBoxKernel', 'size');
  const n = size * 2 + 1;
  const out = new ML.MLMatrix(n, n);
  const v = 1 / (n * n);
  for (let i = 0; i < n * n; i++) out.data[i] = v;
  return out;
}

export function createBoxKernelExact(rows, cols) {
  checkPositiveInt(rows, 'createBoxKernelExact', 'rows');
  checkPositiveInt(cols, 'createBoxKernelExact', 'cols');
  const out = new ML.MLMatrix(rows, cols);
  const v = 1 / (rows * cols);
  for (let i = 0; i < rows * cols; i++) out.data[i] = v;
  return out;
}

// ============================================================================
// GRADIENT / EDGE KERNELS
// ============================================================================
export function createSobelX() {
  const m = new ML.MLMatrix(3, 3);
  m.data[0] = -1; m.data[1] = 0; m.data[2] = 1;
  m.data[3] = -2; m.data[4] = 0; m.data[5] = 2;
  m.data[6] = -1; m.data[7] = 0; m.data[8] = 1;
  return m;
}

export function createSobelY() {
  const m = new ML.MLMatrix(3, 3);
  m.data[0] = -1; m.data[1] = -2; m.data[2] = -1;
  m.data[3] = 0; m.data[4] = 0; m.data[5] = 0;
  m.data[6] = 1; m.data[7] = 2; m.data[8] = 1;
  return m;
}

export function createPrewittX() {
  const m = new ML.MLMatrix(3, 3);
  m.data[0] = -1; m.data[1] = 0; m.data[2] = 1;
  m.data[3] = -1; m.data[4] = 0; m.data[5] = 1;
  m.data[6] = -1; m.data[7] = 0; m.data[8] = 1;
  return m;
}

export function createPrewittY() {
  const m = new ML.MLMatrix(3, 3);
  m.data[0] = -1; m.data[1] = -1; m.data[2] = -1;
  m.data[3] = 0; m.data[4] = 0; m.data[5] = 0;
  m.data[6] = 1; m.data[7] = 1; m.data[8] = 1;
  return m;
}

export function createScharrX() {
  const m = new ML.MLMatrix(3, 3);
  m.data[0] = -3; m.data[1] = 0; m.data[2] = 3;
  m.data[3] = -10; m.data[4] = 0; m.data[5] = 10;
  m.data[6] = -3; m.data[7] = 0; m.data[8] = 3;
  return m;
}

export function createScharrY() {
  const m = new ML.MLMatrix(3, 3);
  m.data[0] = -3; m.data[1] = -10; m.data[2] = -3;
  m.data[3] = 0; m.data[4] = 0; m.data[5] = 0;
  m.data[6] = 3; m.data[7] = 10; m.data[8] = 3;
  return m;
}

export function createLaplacian4() {
  const m = new ML.MLMatrix(3, 3);
  m.data[0] = 0; m.data[1] = 1; m.data[2] = 0;
  m.data[3] = 1; m.data[4] = -4; m.data[5] = 1;
  m.data[6] = 0; m.data[7] = 1; m.data[8] = 0;
  return m;
}

export function createLaplacian8() {
  const m = new ML.MLMatrix(3, 3);
  m.data[0] = 1; m.data[1] = 1; m.data[2] = 1;
  m.data[3] = 1; m.data[4] = -8; m.data[5] = 1;
  m.data[6] = 1; m.data[7] = 1; m.data[8] = 1;
  return m;
}

export function createSharpen() {
  const m = new ML.MLMatrix(3, 3);
  m.data[0] = 0; m.data[1] = -1; m.data[2] = 0;
  m.data[3] = -1; m.data[4] = 5; m.data[5] = -1;
  m.data[6] = 0; m.data[7] = -1; m.data[8] = 0;
  return m;
}

export function createEmboss() {
  const m = new ML.MLMatrix(3, 3);
  m.data[0] = -2; m.data[1] = -1; m.data[2] = 0;
  m.data[3] = -1; m.data[4] = 1; m.data[5] = 1;
  m.data[6] = 0; m.data[7] = 1; m.data[8] = 2;
  return m;
}

export function createIdentity() {
  const m = new ML.MLMatrix(3, 3);
  m.data[0] = 0; m.data[1] = 0; m.data[2] = 0;
  m.data[3] = 0; m.data[4] = 1; m.data[5] = 0;
  m.data[6] = 0; m.data[7] = 0; m.data[8] = 0;
  return m;
}

export function createUnsharpMask(sigma, amount, truncate) {
  checkPositive(sigma, 'createUnsharpMask', 'sigma');
  const a = amount === undefined ? 1 : amount;
  const g = gaussianKernel2D(sigma, truncate);
  const size = g.rows;
  const center = (size - 1) >> 1;
  const out = new ML.MLMatrix(size, size);
  // out = -amount * G + (1 + amount) * δ
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      out.data[r * size + c] = -a * g.data[r * size + c];
    }
  }
  out.data[center * size + center] += 1 + a;
  return out;
}

// ============================================================================
// KERNEL NORMALIZATION
// ============================================================================
export function normalizeKernel(kernel, mode) {
  if (!(kernel instanceof ML.MLMatrix)) {
    throw new DecodeError('normalizeKernel', 'MLMatrix required');
  }
  const m = mode === undefined ? 'sumOne' : mode;
  const n = kernel.rows * kernel.columns;
  const out = kernel.clone();

  if (m === 'none') return out;

  if (m === 'sumOne') {
    let s = 0;
    for (let i = 0; i < n; i++) s += out.data[i];
    if (Math.abs(s) < EPSILON) return out;
    const inv = 1 / s;
    for (let i = 0; i < n; i++) out.data[i] *= inv;
    return out;
  }

  if (m === 'sumZero') {
    let s = 0;
    for (let i = 0; i < n; i++) s += out.data[i];
    const corr = s / n;
    for (let i = 0; i < n; i++) out.data[i] -= corr;
    return out;
  }

  if (m === 'l1') {
    let s = 0;
    for (let i = 0; i < n; i++) s += Math.abs(out.data[i]);
    if (s < EPSILON) return out;
    const inv = 1 / s;
    for (let i = 0; i < n; i++) out.data[i] *= inv;
    return out;
  }

  if (m === 'l2') {
    let s = 0;
    for (let i = 0; i < n; i++) s += out.data[i] * out.data[i];
    if (s < EPSILON) return out;
    const inv = 1 / Math.sqrt(s);
    for (let i = 0; i < n; i++) out.data[i] *= inv;
    return out;
  }

  throw new DecodeError('normalizeKernel', 'unknown mode: ' + m);
}

// ============================================================================
// KERNEL SEPARABILITY
// ============================================================================
export function isSeparable(kernel, tolerance) {
  if (!(kernel instanceof ML.MLMatrix)) {
    throw new DecodeError('isSeparable', 'MLMatrix required');
  }
  if (kernel.rows !== kernel.columns) return false;
  const n = kernel.rows;
  const t = tolerance === undefined ? 1e-6 : tolerance;

  // Use SVD to check rank 1
  // For speed and simplicity: check outer product consistency
  // Pivot on the largest absolute element
  let pivotR = 0;
  let pivotC = 0;
  let pivotV = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const v = Math.abs(kernel.data[r * n + c]);
      if (v > pivotV) { pivotV = v; pivotR = r; pivotC = c; }
    }
  }
  if (pivotV === 0) return true;

  // Compute U row and V col
  const uR = new ARRAY_TYPE(n);
  const vC = new ARRAY_TYPE(n);
  for (let r = 0; r < n; r++) uR[r] = kernel.data[r * n + pivotC];
  for (let c = 0; c < n; c++) vC[c] = kernel.data[pivotR * n + c];

  // Check outer product
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const predicted = (uR[r] * vC[c]) / pivotV;
      if (Math.abs(predicted - kernel.data[r * n + c]) > t) return false;
    }
  }
  return true;
}

export function separateGaussian(kernel, tolerance) {
  if (!isSeparable(kernel, tolerance)) return null;
  const n = kernel.rows;
  // Use largest absolute element as pivot
  let pivotR = 0;
  let pivotC = 0;
  let pivotV = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const v = Math.abs(kernel.data[r * n + c]);
      if (v > pivotV) { pivotV = v; pivotR = r; pivotC = c; }
    }
  }
  if (pivotV === 0) return null;

  const uR = new ARRAY_TYPE(n);
  const vC = new ARRAY_TYPE(n);
  for (let r = 0; r < n; r++) uR[r] = kernel.data[r * n + pivotC];
  for (let c = 0; c < n; c++) vC[c] = kernel.data[pivotR * n + c];

  const sign = kernel.data[pivotR * n + pivotC] > 0 ? 1 : -1;
  // Normalize so that u * v = kernel
  const scaleU = Math.sqrt(Math.abs(pivotV));
  const scaleV = Math.sqrt(Math.abs(pivotV));
  const u = new ARRAY_TYPE(n);
  const v = new ARRAY_TYPE(n);
  for (let r = 0; r < n; r++) u[r] = (uR[r] * sign) / scaleU;
  for (let c = 0; c < n; c++) v[c] = vC[c] / scaleV;
  return { u, v };
}

// ============================================================================
// KERNEL FACTORY (unified dispatcher)
// ============================================================================
export const KernelNames = Object.freeze({
  IDENTITY: 'identity',
  BOX: 'box',
  GAUSSIAN: 'gaussian',
  LOG: 'log',
  DOG: 'dog',
  SOBEL_X: 'sobelX',
  SOBEL_Y: 'sobelY',
  PREWITT_X: 'prewittX',
  PREWITT_Y: 'prewittY',
  SCHARR_X: 'scharrX',
  SCHARR_Y: 'scharrY',
  LAPLACIAN_4: 'laplacian4',
  LAPLACIAN_8: 'laplacian8',
  SHARPEN: 'sharpen',
  EMBOSS: 'emboss',
  UNSHARP: 'unsharp'
});

export function kernelFactory(name, options) {
  const opts = options || {};
  switch (name) {
    case KernelNames.IDENTITY:
      return createIdentity();
    case KernelNames.BOX:
      return createBoxKernel(opts.size === undefined ? 1 : opts.size);
    case KernelNames.GAUSSIAN: {
      const sigma = opts.sigma === undefined ? 1 : opts.sigma;
      return gaussianKernel2D(sigma, opts.truncate);
    }
    case KernelNames.LOG:
      return createLoG(opts.size === undefined ? 5 : opts.size, opts.sigma === undefined ? 1 : opts.sigma);
    case KernelNames.DOG:
      return createDoG(
        opts.size === undefined ? 5 : opts.size,
        opts.sigma1 === undefined ? 1 : opts.sigma1,
        opts.sigma2 === undefined ? 2 : opts.sigma2
      );
    case KernelNames.SOBEL_X: return createSobelX();
    case KernelNames.SOBEL_Y: return createSobelY();
    case KernelNames.PREWITT_X: return createPrewittX();
    case KernelNames.PREWITT_Y: return createPrewittY();
    case KernelNames.SCHARR_X: return createScharrX();
    case KernelNames.SCHARR_Y: return createScharrY();
    case KernelNames.LAPLACIAN_4: return createLaplacian4();
    case KernelNames.LAPLACIAN_8: return createLaplacian8();
    case KernelNames.SHARPEN: return createSharpen();
    case KernelNames.EMBOSS: return createEmboss();
    case KernelNames.UNSHARP:
      return createUnsharpMask(
        opts.sigma === undefined ? 1 : opts.sigma,
        opts.amount === undefined ? 1 : opts.amount,
        opts.truncate
      );
    default:
      throw new DecodeError('kernelFactory', 'unknown kernel name: ' + name);
  }
}

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================
export const KernelInput = Object.freeze({
  make(kernel, mode) { return { kernel, mode }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('kernel', 'Expected {kernel, mode?}');
    if (!(input.kernel instanceof ML.MLMatrix)) {
      throw new DecodeError('kernel', 'kernel must be MLMatrix');
    }
    return input;
  }
});

export const GaussianInput = Object.freeze({
  make(sigma, truncate) { return { sigma, truncate }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('gaussian', 'Expected {sigma, truncate?}');
    checkPositive(input.sigma, 'gaussian', 'sigma');
    return input;
  }
});

export const LoGInput = Object.freeze({
  make(size, sigma) { return { size, sigma }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('log', 'Expected {size, sigma}');
    checkPositiveInt(input.size, 'log', 'size');
    if (input.size % 2 === 0) throw new DecodeError('log', 'size must be odd');
    checkPositive(input.sigma, 'log', 'sigma');
    return input;
  }
});

export const NormalizeInput = Object.freeze({
  make(kernel, mode) { return { kernel, mode }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('normalize', 'Expected {kernel, mode?}');
    if (!(input.kernel instanceof ML.MLMatrix)) {
      throw new DecodeError('normalize', 'kernel must be MLMatrix');
    }
    return input;
  }
});

export const KernelFactoryInput = Object.freeze({
  make(name, options) { return { name, options }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('kernelFactory', 'Expected {name, options?}');
    if (typeof input.name !== 'string') throw new DecodeError('kernelFactory', 'name must be string');
    return input;
  }
});

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================
export function gaussianValidated(input) {
  const d = GaussianInput.decode(input);
  return gaussianKernel2D(d.sigma, d.truncate);
}

export function logValidated(input) {
  const d = LoGInput.decode(input);
  return createLoG(d.size, d.sigma);
}

export function normalizeKernelValidated(input) {
  const d = NormalizeInput.decode(input);
  return normalizeKernel(d.kernel, d.mode);
}

export function kernelFactoryValidated(input) {
  const d = KernelFactoryInput.decode(input);
  return kernelFactory(d.name, d.options);
}

export function matrix2ArrayValidated(input) {
  if (!input || !input.matrix) throw new DecodeError('matrix2Array', 'matrix required');
  return matrix2Array(input.matrix);
}

export function array2MatrixValidated(input) {
  if (!input || !input.array) throw new DecodeError('array2Matrix', 'array required');
  return array2Matrix(input.array, input.rows, input.cols, input.dd);
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

export function kernelFactoryWithPolicies(name, policy, options) {
  return policyCustom(
    'ConvolutionUtil.kernelFactoryWithPolicies',
    () => kernelFactory(name, options),
    isValidMatrixFinite,
    (m) => ({ rows: m.rows, columns: m.columns, name }),
    policy
  );
}

export function gaussianWithPolicies(sigma, policy, truncate) {
  return policyCustom(
    'ConvolutionUtil.gaussianWithPolicies',
    () => gaussianKernel2D(sigma, truncate),
    isValidMatrixFinite,
    (m) => ({ rows: m.rows, columns: m.columns, sigma }),
    policy
  );
}

export function createLoGWithPolicies(size, sigma, policy) {
  return policyCustom(
    'ConvolutionUtil.createLoGWithPolicies',
    () => createLoG(size, sigma),
    isValidMatrixFinite,
    (m) => ({ rows: m.rows, columns: m.columns, sigma }),
    policy
  );
}

export function normalizeKernelWithPolicies(kernel, mode, policy) {
  return policyCustom(
    'ConvolutionUtil.normalizeKernelWithPolicies',
    () => normalizeKernel(kernel, mode),
    isValidMatrixFinite,
    (m) => ({ rows: m.rows, columns: m.columns, mode }),
    policy
  );
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default {
  DecodeError,
  DomainViolationError,
  matrix2Array,
  array2Matrix,
  toMatrix,
  toArray,
  toMatrix2D,
  toArray2D,
  createArray,
  createMatrix,
  gaussianKernel1D,
  gaussianKernel2D,
  gaussianKernelSeparable,
  createLoG,
  createDoG,
  createBoxKernel,
  createBoxKernelExact,
  createSobelX,
  createSobelY,
  createPrewittX,
  createPrewittY,
  createScharrX,
  createScharrY,
  createLaplacian4,
  createLaplacian8,
  createSharpen,
  createEmboss,
  createIdentity,
  createUnsharpMask,
  normalizeKernel,
  isSeparable,
  separateGaussian,
  KernelNames,
  kernelFactory,
  KernelInput,
  GaussianInput,
  LoGInput,
  NormalizeInput,
  KernelFactoryInput,
  gaussianValidated,
  logValidated,
  normalizeKernelValidated,
  kernelFactoryValidated,
  matrix2ArrayValidated,
  array2MatrixValidated,
  kernelFactoryWithPolicies,
  gaussianWithPolicies,
  createLoGWithPolicies,
  normalizeKernelWithPolicies
};